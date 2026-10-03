import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Decision, Mode, State } from "./types";
import type { LiveObservation } from "./feed-types";
import { liquidationNet } from "./paper";
// Node 22.13+ built-in SQLite; no external database or native dependency needed.
interface Statement { run(...params: unknown[]): { changes: number | bigint }; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] }
interface DB { exec(sql: string): void; prepare(sql: string): Statement }
type SQLite = { DatabaseSync: new (filename: string) => DB };
let connection: DB;
export function db() {
  if (!connection) {
    // Load the actual Node builtin at runtime. createRequire(import.meta.url)
    // becomes an unsupported URL/CommonJS reference in Turbopack's server bundle.
    // Never substitute an in-memory store when the required runtime is missing.
    const sqlite = process.getBuiltinModule("node:sqlite") as SQLite | undefined;
    if (!sqlite) throw new Error("MarketPilot requires Node.js 22.13+ with native node:sqlite support");
    const dir = process.env.MARKETPILOT_DATA_DIR || path.join(process.cwd(), ".marketpilot");
    mkdirSync(dir, { recursive: true });
    connection = new sqlite.DatabaseSync(path.join(dir, "marketpilot.sqlite"));
    connection.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS states (mode TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, mode TEXT NOT NULL, time TEXT NOT NULL, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, owner TEXT, expires INTEGER); CREATE INDEX IF NOT EXISTS decision_time ON decisions(mode,time);");
    connection.exec(`
      CREATE TABLE IF NOT EXISTS live_observations (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, received_at TEXT, exchange_time TEXT,
        status TEXT NOT NULL, symbol TEXT, token TEXT, price REAL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS live_receipt ON live_observations(received_at);
      CREATE INDEX IF NOT EXISTS live_contract_status ON live_observations(symbol,token,status,exchange_time);
      CREATE TABLE IF NOT EXISTS forward_events (id TEXT PRIMARY KEY,time TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS forward_entries (id TEXT PRIMARY KEY,time TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS forward_trades (id TEXT PRIMARY KEY,entry_time TEXT NOT NULL,exit_time TEXT NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS forward_checkpoints (id TEXT PRIMARY KEY,time TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS forward_event_time ON forward_events(time);
      CREATE INDEX IF NOT EXISTS forward_entry_time ON forward_entries(time);
      CREATE INDEX IF NOT EXISTS forward_exit_time ON forward_trades(exit_time);
      CREATE INDEX IF NOT EXISTS forward_checkpoint_time ON forward_checkpoints(time);
    `);
  }
  return connection;
}
export function readState(mode: Mode): State | null { const row = db().prepare("SELECT json FROM states WHERE mode=?").get(mode) as { json: string } | undefined; return row ? JSON.parse(row.json) : null; }
export function saveState(s: State, decision?: Decision) {
  const store = db(); store.exec("BEGIN IMMEDIATE");
  try {
    store.prepare("INSERT INTO states VALUES (?,?) ON CONFLICT(mode) DO UPDATE SET json=excluded.json").run(s.mode, JSON.stringify(s));
    if (decision) store.prepare("INSERT INTO decisions VALUES (?,?,?,?)").run(decision.id, s.mode, decision.time, JSON.stringify(decision));
    if (s.mode === "LIVE") {
      // Materialize the complete audit stream independently of the UI's recent-event limit.
      const lastEvent = store.prepare("SELECT time FROM forward_events ORDER BY rowid DESC LIMIT 1").get() as {time: string} | undefined;
      const addEvent = store.prepare("INSERT OR IGNORE INTO forward_events VALUES (?,?,?)");
      for (const event of s.journal) if (!lastEvent || event.time >= lastEvent.time) addEvent.run(event.id, event.time, JSON.stringify(event));
      const addEntry = store.prepare("INSERT OR IGNORE INTO forward_entries VALUES (?,?,?)");
      if (s.position) addEntry.run(`${s.position.time}/${s.position.contract.token}`, s.position.time, JSON.stringify(s.position));
      const lastTrade = store.prepare("SELECT exit_time FROM forward_trades ORDER BY rowid DESC LIMIT 1").get() as {exit_time: string} | undefined;
      const addTrade = store.prepare("INSERT OR IGNORE INTO forward_trades VALUES (?,?,?,?)");
      for (const trade of s.trades) if (!lastTrade || trade.exitTime >= lastTrade.exit_time) {
        const id = `${trade.time}/${trade.contract.token}`;
        const entry = { side: trade.side, entry: trade.entry, stop: trade.stop, target: trade.target,
          time: trade.time, contract: trade.contract, entryCosts: trade.entryCosts, maxRisk: trade.maxRisk, settings: trade.settings };
        addEntry.run(id, trade.time, JSON.stringify(entry));
        addTrade.run(id, trade.time, trade.exitTime, JSON.stringify(trade));
      }
      const checkpoint = { time: s.clock, day: s.days.at(-1)!, position: s.position,
        unrealized: liquidationNet(s.position, s.candles.at(-1)?.close ?? 0, s.clock),
        feed: s.feed, feedTime: s.feedTime, observationId: s.latestObservation?.id ?? null,
        context: s.context, settings: s.settings };
      store.prepare("INSERT INTO forward_checkpoints VALUES (?,?,?)").run(decision?.id ?? crypto.randomUUID(), s.clock, JSON.stringify(checkpoint));
    }
    store.exec("COMMIT");
  } catch (error) { store.exec("ROLLBACK"); throw error; }
}
export class MonitorBusyError extends Error {
  constructor() { super("Monitor is busy; retry shortly"); this.name = "MonitorBusyError"; }
}
export function sqliteBusy(error: unknown) {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && (code & 255) === 5;
}
export async function exclusive<T>(mode: Mode, fn: () => Promise<T>): Promise<T> {
  const owner = crypto.randomUUID(), store = db();
  // Reading an active lease needs no write lock, even while its holder commits.
  const current = store.prepare("SELECT expires FROM leases WHERE name=?").get(mode) as { expires: number } | undefined;
  if (current && current.expires >= Date.now()) throw new MonitorBusyError();
  // A synchronous five-second acquisition wait blocks the entire web process.
  // Contention before acquiring a lease is safe to retry on the next monitor tick.
  store.exec("PRAGMA busy_timeout=100");
  try {
    const acquired = store.prepare("INSERT INTO leases VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE leases.expires < ?").run(mode, owner, Date.now() + 120000, Date.now());
    // The atomic write remains authoritative if another process won the race.
    if (!acquired.changes) throw new MonitorBusyError();
  } catch (error) {
    if (sqliteBusy(error)) throw new MonitorBusyError();
    throw error;
  } finally { store.exec("PRAGMA busy_timeout=5000"); }
  try { return await fn(); } finally {
    try { store.prepare("DELETE FROM leases WHERE name=? AND owner=?").run(mode, owner); }
    catch (error) {
      if (error instanceof Error) Object.assign(error, { marketpilotOperation: "lease.release" });
      throw error;
    }
  }
}
export function decisions(mode: Mode) { return db().prepare("SELECT json FROM decisions WHERE mode=? ORDER BY rowid DESC LIMIT 500").all(mode).map(r => JSON.parse((r as {json:string}).json)); }

export function writeObservation(o: LiveObservation) {
  db().prepare(`INSERT INTO live_observations VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET received_at=excluded.received_at,exchange_time=excluded.exchange_time,
      status=excluded.status,symbol=excluded.symbol,token=excluded.token,price=excluded.price,json=excluded.json`)
    .run(o.id, o.startedAt, o.receivedAt, o.exchangeTime, o.status, o.contract?.symbol ?? null, o.contract?.token ?? null, o.status === "OK" ? o.price : null, JSON.stringify({ ...o, price: o.status === "OK" ? o.price : null }));
}
export function observationRows(sql: string, ...params: unknown[]): LiveObservation[] {
  return db().prepare(sql).all(...params).map(r => JSON.parse((r as {json:string}).json) as LiveObservation);
}
export function lastValidObservation(symbol?: string, token?: string): LiveObservation | null {
  const filter = symbol && token ? " AND symbol=? AND token=?" : "";
  return observationRows(`SELECT json FROM live_observations WHERE status='OK'${filter} ORDER BY exchange_time DESC, rowid DESC LIMIT 1`, ...(filter ? [symbol, token] : []))[0] ?? null;
}
