import { db } from "./storage";
import { istDay } from "./time";
import type { ContextItem, Contract, Day, Decision, Journal, Position, Settings, Trade } from "./types";

export type ForwardCheckpoint = {
  time: string; day: Day; position: Position | null; unrealized: number;
  feed: string; feedTime: string | null; observationId: string | null;
  context: ContextItem[]; settings: Settings;
};
type Observation = {
  id: string; startedAt: string; receivedAt: string | null; exchangeTime: string | null;
  contract: Contract | null; price: number | null; status: string; reason: string;
  source: "worker" | "dashboard"; gapSeconds: number | null;
};

/** Calendar validation must precede SQL: JavaScript otherwise normalizes impossible dates. */
export function istWindow(day: string, now = new Date().toISOString()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Use a valid IST date in YYYY-MM-DD format");
  const startMs = Date.parse(`${day}T00:00:00+05:30`);
  if (!Number.isFinite(startMs) || istDay(new Date(startMs).toISOString()) !== day)
    throw new Error("Use a valid IST date in YYYY-MM-DD format");
  if (day > istDay(now)) throw new Error("A forward-session report cannot use a future IST date");
  const start = new Date(startMs).toISOString();
  const end = new Date(startMs + 86400000).toISOString();
  const asOf = new Date(Math.min(Date.parse(now), Date.parse(end) - 1)).toISOString();
  return { start, end, asOf };
}

function parsed<T>(rows: unknown[]): T[] { return rows.map(row => JSON.parse((row as { json: string }).json) as T); }

/** A full, private LIVE ledger export. Replay state and replay decisions are never queried. */
export function forwardSessionReport(day: string, now = new Date().toISOString()) {
  const window = istWindow(day, now), store = db();
  // One SQLite read transaction prevents a worker commit from splitting the report across states.
  store.exec("BEGIN");
  try {
    const observations = parsed<Observation>(store.prepare("SELECT json FROM live_observations WHERE COALESCE(received_at,started_at)>=? AND COALESCE(received_at,started_at)<? AND COALESCE(received_at,started_at)<=? ORDER BY COALESCE(received_at,started_at),rowid").all(window.start, window.end, window.asOf));
    const pendingAtStart = parsed<Observation>(store.prepare("SELECT json FROM live_observations WHERE started_at<? AND received_at IS NULL AND status='PENDING' ORDER BY started_at,rowid").all(window.start));
    const decisions = parsed<Decision>(store.prepare("SELECT json FROM decisions WHERE mode='LIVE' AND time>=? AND time<? AND time<=? ORDER BY time,rowid").all(window.start, window.end, window.asOf));
    const journal = parsed<Journal>(store.prepare("SELECT json FROM forward_events WHERE time>=? AND time<? AND time<=? ORDER BY time,rowid").all(window.start, window.end, window.asOf));
    const entries = parsed<Position>(store.prepare("SELECT json FROM forward_entries WHERE time>=? AND time<? AND time<=? ORDER BY time,rowid").all(window.start, window.end, window.asOf));
    const exits = parsed<Trade>(store.prepare("SELECT json FROM forward_trades WHERE exit_time>=? AND exit_time<? AND exit_time<=? ORDER BY exit_time,rowid").all(window.start, window.end, window.asOf));
    const checkpointRow = store.prepare("SELECT json FROM forward_checkpoints WHERE time<? AND time<=? ORDER BY time DESC,rowid DESC LIMIT 1").get(window.end, window.asOf) as { json: string } | undefined;
    const checkpoint = checkpointRow ? JSON.parse(checkpointRow.json) as ForwardCheckpoint : null;
    const linkedRow = checkpoint?.observationId ? store.prepare("SELECT json FROM live_observations WHERE id=? AND COALESCE(received_at,started_at)<=?").get(checkpoint.observationId, window.asOf) as { json: string } | undefined : undefined;
    const linked = linkedRow ? JSON.parse(linkedRow.json) as Observation : null;
    const currentCheckpoint = checkpoint?.day.day === day ? checkpoint : null;
    const position = checkpoint?.position ?? null;
    const ageSeconds = checkpoint?.feedTime ? (Date.parse(window.asOf) - Date.parse(checkpoint.feedTime)) / 1000 : null;
    const verifiedMark = !!currentCheckpoint && checkpoint?.feed === "CONNECTED" && linked?.status === "OK" && linked.price !== null && linked.exchangeTime === checkpoint.feedTime && ageSeconds !== null && ageSeconds >= 0 && ageSeconds <= 30 && (!position || (linked.contract?.symbol === position.contract.symbol && linked.contract?.token === position.contract.token && linked.contract?.verified === true));
    const realizedNet = exits.reduce((sum, trade) => sum + trade.net, 0);
    const openingMark = currentCheckpoint?.day.openingMark ?? 0;
    const markedDailyEstimate = currentCheckpoint && Number.isFinite(currentCheckpoint.unrealized)
      ? realizedNet + currentCheckpoint.unrealized - openingMark : null;
    const canValue = !!currentCheckpoint && (!position || verifiedMark);
    const statusCounts: Record<string, number> = {};
    for (const observation of observations) statusCounts[observation.status] = (statusCounts[observation.status] ?? 0) + 1;
    const valid = observations.filter(observation => observation.status === "OK");
    const firstReceipt = observations[0]?.receivedAt ?? observations[0]?.startedAt ?? null;
    const lastObservation = observations.at(-1);
    const lastReceipt = lastObservation?.receivedAt ?? lastObservation?.startedAt ?? null;
    const lastValidReceipt = valid.at(-1)?.receivedAt ?? valid.at(-1)?.startedAt ?? null;
    const observedGaps = observations.map(observation => observation.gapSeconds ?? 0);
    const ongoingGap = firstReceipt ? Math.max(0, (Date.parse(window.asOf) - Date.parse(lastValidReceipt ?? firstReceipt)) / 1000) : 0;
    const largestGapSeconds = observations.length ? Math.max(ongoingGap, ...observedGaps) : null;
    const result = {
      schemaVersion: "forward-session-1.0", mode: "LIVE" as const, day, timezone: "Asia/Kolkata",
      generatedAt: now, window, asOfCheckpoint: checkpoint,
      observations, pendingAtStart, decisions, entries, exits, journal,
      assessments: journal.filter(event => event.kind === "ASSESSMENT"),
      riskLockouts: journal.filter(event => event.kind === "RISK_LOCKOUT"),
      coverage: { firstReceipt, lastReceipt, validSamples: valid.length, failedSamples: observations.length - valid.length, statusCounts, largestGapSeconds,
        completeMarketCoverage: false, note: "Polling is sampled coverage. Gaps, missing ticks and periods with no worker cannot be reconstructed." },
      outcome: {
        status: !currentCheckpoint ? "NO_SESSION_CHECKPOINT" : position && !verifiedMark ? "OPEN_POSITION_UNPRICED" : position ? "OPEN_POSITION_ESTIMATE" : "FLAT",
        realizedNet, openingMarkEstimate: currentCheckpoint ? openingMark : null,
        unrealizedEstimate: currentCheckpoint?.unrealized ?? null,
        markedDailyEstimate, netDaily: canValue ? markedDailyEstimate : null,
        position, markExchangeTime: checkpoint?.feedTime ?? null, markAgeSeconds: ageSeconds,
        valuationCurrent: !position ? !!currentCheckpoint : verifiedMark,
        provisional: !!position || !currentCheckpoint || day === istDay(now),
        explanation: !currentCheckpoint ? "No saved LIVE valuation for this IST date. A carried position is shown when known; absence of records is not a flat trading day."
          : position && !verifiedMark ? "An open position lacks a fresh, accepted quote at the report cutoff. Net daily outcome is unavailable; retained marks are historical estimates."
          : "Paper outcome uses simulated fills and estimated charges. Daily marked change subtracts the saved opening mark. An open or ongoing day is provisional.",
      },
      costs: {
        classification: "ESTIMATE", currency: "INR", closedTradeCharges: exits.reduce((sum, trade) => sum + trade.costs, 0),
        entryChargesOnDate: entries.reduce((sum, entry) => sum + entry.entryCosts, 0),
        exitChargesOnDate: exits.reduce((sum, trade) => sum + trade.costs - trade.entryCosts, 0),
        explanation: "Brokerage and statutory charges use each position's captured settings. Spread, slippage and tick rounding are embedded in simulated fill prices. These are not broker ledger charges.",
      },
      globalContextAtCheckpoint: checkpoint?.context ?? [],
      limitations: [
        "LIVE describes the acquisition channel. Only OK observations contain validated broker prices; configuration alone does not establish a live connection.",
        "The report contains forward paper trading only. It never includes synthetic replay results or executes real orders.",
        "Unauthorized or unconfigured WTI, Brent, news and trader-positioning sources are unavailable; no values are invented.",
        "Report timestamps are ISO UTC instants; the report date and inclusive start/exclusive end boundaries are Asia/Kolkata.",
        "Paper fills, friction and charges are estimates. Neither a replay nor a single forward session demonstrates a trading edge or guarantees profit.",
      ],
    };
    store.exec("COMMIT");
    return result;
  } catch (error) { store.exec("ROLLBACK"); throw error; }
}
