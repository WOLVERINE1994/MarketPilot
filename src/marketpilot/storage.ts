import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Decision, Mode, State } from "./types";
// Node 22.13+ built-in SQLite; no external database or native dependency needed.
interface Statement { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] }
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
  }
  return connection;
}
export function readState(mode: Mode): State | null { const row = db().prepare("SELECT json FROM states WHERE mode=?").get(mode) as { json: string } | undefined; return row ? JSON.parse(row.json) : null; }
export function saveState(s: State, decision?: Decision) {
  const store = db(); store.exec("BEGIN IMMEDIATE");
  try {
    store.prepare("INSERT INTO states VALUES (?,?) ON CONFLICT(mode) DO UPDATE SET json=excluded.json").run(s.mode, JSON.stringify(s));
    if (decision) store.prepare("INSERT INTO decisions VALUES (?,?,?,?)").run(decision.id, s.mode, decision.time, JSON.stringify(decision));
    store.exec("COMMIT");
  } catch (error) { store.exec("ROLLBACK"); throw error; }
}
export async function exclusive<T>(mode: Mode, fn: () => Promise<T>): Promise<T> {
  const owner = crypto.randomUUID(), store = db();
  store.prepare("INSERT INTO leases VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires=excluded.expires WHERE leases.expires < ?").run(mode, owner, Date.now() + 120000, Date.now());
  const lock = store.prepare("SELECT owner FROM leases WHERE name=?").get(mode) as { owner: string };
  if (lock.owner !== owner) throw new Error("Monitor is busy; retry shortly");
  try { return await fn(); } finally { store.prepare("DELETE FROM leases WHERE name=? AND owner=?").run(mode, owner); }
}
export function decisions(mode: Mode) { return db().prepare("SELECT json FROM decisions WHERE mode=? ORDER BY rowid DESC LIMIT 500").all(mode).map(r => JSON.parse((r as {json:string}).json)); }
