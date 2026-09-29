import { currentContract, quote, QuoteError } from "./adapters/smartapi";
import type { Contract, State } from "./types";
import type { FeedHealth, LiveObservation, ObservationStatus } from "./feed-types";
import { db, lastValidObservation, observationRows, writeObservation } from "./storage";
import { istDay } from "./time";

export function liveConfigured() {
  return ["ANGEL_API_KEY", "ANGEL_ACCESS_TOKEN", "ANGEL_CLIENT_LOCAL_IP", "ANGEL_CLIENT_PUBLIC_IP", "ANGEL_MAC_ADDRESS", "MARKETPILOT_SPECS_FILE"].every(key => !!process.env[key]?.trim());
}
export function sameContract(a: Contract | null, b: Contract | null) {
  return !!a && !!b && a.symbol === b.symbol && a.token === b.token && a.expiry === b.expiry && a.lotSize === b.lotSize && a.multiplier === b.multiplier && a.tickSize === b.tickSize && a.verified && b.verified;
}
export function temporalStatus(time: string, receivedAt: string, previous: string | null): ObservationStatus {
  const exchange = Date.parse(time), receipt = Date.parse(receivedAt), prior = Date.parse(previous ?? "");
  if (!Number.isFinite(exchange) || !Number.isFinite(receipt)) return "MALFORMED";
  if (exchange > receipt) return "FUTURE_DATED";
  if (Number.isFinite(prior) && exchange < prior) return "OUT_OF_ORDER";
  if (receipt - exchange > 30000) return "STALE";
  if (exchange === prior) return "DUPLICATE";
  return "OK";
}
const reasons: Record<ObservationStatus, string> = {
  PENDING: "Polling attempt started; no response accepted yet",
  OK: "Verified contract and fresh, strictly advancing exchange quote",
  STALE: "Exchange quote is more than 30 seconds old",
  FUTURE_DATED: "Exchange timestamp is later than local receipt time",
  OUT_OF_ORDER: "Exchange timestamp precedes the last accepted quote for this contract",
  DUPLICATE: "Exchange timestamp has not advanced; no new observation or fill",
  CONTRACT_MISMATCH: "Quote or reviewed specifications do not match the requested contract",
  MALFORMED: "Quote identity, timestamp or price is malformed",
  UNAVAILABLE: "Broker session, verified contract, or quote endpoint unavailable",
  INTERRUPTED: "Previous attempt did not complete; process stopped before an accepted response",
};

// Called under the durable LIVE lease. Persist the attempt before any network I/O.
export async function pollLive(s: State, source: LiveObservation["source"]): Promise<LiveObservation> {
  const startedAt = new Date().toISOString();
  for (const pending of observationRows("SELECT json FROM live_observations WHERE status='PENDING'")) {
    writeObservation({ ...pending, status: "INTERRUPTED", reason: reasons.INTERRUPTED });
  }
  const o: LiveObservation = { id: crypto.randomUUID(), startedAt, receivedAt: null, exchangeTime: null,
    contract: null, price: null, status: "PENDING", reason: reasons.PENDING, source, gapSeconds: null };
  writeObservation(o);
  try {
    if (!liveConfigured()) throw new QuoteError("UNAVAILABLE");
    const contract = await currentContract(startedAt, s.position?.contract.symbol);
    o.contract = contract;
    // Record the exact resolved request identity before submitting the quote request.
    writeObservation(o);
    if (s.position && !sameContract(contract, s.position.contract)) throw new QuoteError("CONTRACT_MISMATCH");
    const q = await quote(contract);
    o.receivedAt = new Date().toISOString();
    o.exchangeTime = q.time;
    if (!Number.isFinite(q.price) || q.price <= 0) o.status = "MALFORMED";
    else o.status = temporalStatus(q.time, o.receivedAt, lastValidObservation(contract.symbol, contract.token)?.exchangeTime ?? null);
    if (o.status === "OK") o.price = q.price;
  } catch (error) {
    o.receivedAt = new Date().toISOString();
    o.status = error instanceof QuoteError ? error.status : "UNAVAILABLE";
    o.exchangeTime = error instanceof QuoteError ? error.exchangeTime : null;
  }
  const previous = lastValidObservation();
  const first = observationRows("SELECT json FROM live_observations ORDER BY started_at, rowid LIMIT 1")[0];
  const baseline = previous?.exchangeTime ?? first?.startedAt ?? startedAt;
  o.gapSeconds = Math.max(0, (Date.parse(o.status === "OK" ? o.exchangeTime! : o.receivedAt!) - Date.parse(baseline)) / 1000);
  o.reason = reasons[o.status];
  // If this durable write fails, no state mutation, decision or fill follows it.
  writeObservation(o);
  return o;
}

export function applyObservation(s: State, o: LiveObservation) {
  s.latestObservation = o;
  s.clock = o.receivedAt ?? o.startedAt;
  if (o.status !== "OK" || !o.contract || o.price === null || !o.exchangeTime) {
    s.feed = o.status === "UNAVAILABLE" || o.status === "INTERRUPTED" ? "DISCONNECTED" : o.status;
    return;
  }
  if (!sameContract(s.contract, o.contract)) { s.candles = []; s.feedTime = null; }
  s.contract = o.contract;
  const q = { price: o.price, time: o.exchangeTime }, last = s.candles.at(-1);
  if (!last || last.time.slice(0, 16) !== q.time.slice(0, 16)) s.candles.push({ time: q.time, open: q.price, high: q.price, low: q.price, close: q.price, volume: 0 });
  else { last.high = Math.max(last.high, q.price); last.low = Math.min(last.low, q.price); last.close = q.price; last.time = q.time; }
  s.lastQuote = q;
  s.candles = s.candles.slice(-1500);
  s.feedTime = q.time; s.feed = "CONNECTED";
}

export function validLiveFill(s: State) {
  const o = s.latestObservation;
  const age = Date.parse(s.clock) - Date.parse(o?.exchangeTime ?? "");
  return !!o && o.status === "OK" && o.price !== null && Number.isFinite(o.price) && o.price > 0 &&
    age >= 0 && age <= 30000 && s.feed === "CONNECTED" && s.feedTime === o.exchangeTime &&
    s.candles.at(-1)?.close === o.price && sameContract(o.contract, s.position?.contract ?? s.contract);
}

export function feedHealth(s: State, now = new Date().toISOString()): FeedHealth {
  const day = istDay(now), start = new Date(`${day}T00:00:00+05:30`).toISOString(), end = new Date(Date.parse(start) + 86400000).toISOString();
  const counts = db().prepare(`SELECT
    COALESCE(SUM(status='OK'),0) AS valid, COALESCE(SUM(status NOT IN ('OK','PENDING')),0) AS failed,
    COALESCE(SUM(status='PENDING'),0) AS pending, COALESCE(MAX(json_extract(json,'$.gapSeconds')),0) AS gap,
    MIN(started_at) AS first FROM live_observations WHERE COALESCE(received_at,started_at)>=? AND COALESCE(received_at,started_at)<?`).get(start, end) as {valid:number;failed:number;pending:number;gap:number;first:string|null};
  const lastValid = lastValidObservation();
  const latest = observationRows("SELECT json FROM live_observations ORDER BY rowid DESC LIMIT 1")[0];
  const age = lastValid?.exchangeTime ? Math.max(0, (Date.parse(now) - Date.parse(lastValid.exchangeTime)) / 1000) : null;
  const ongoing = Math.max(0, (Date.parse(now) - Date.parse(lastValid?.exchangeTime ?? counts.first ?? now)) / 1000);
  const workerAge = Date.parse(now) - Date.parse(s.lastWorker ?? "");
  const connected = latest?.status === "OK" && age !== null && age <= 30 && sameContract(latest.contract, s.contract);
  return { configured: liveConfigured(), connection: connected ? "CONNECTED_AND_VERIFIED" : lastValid ? "DISCONNECTED" : "NOT_VERIFIED",
    lastValidExchangeTime: lastValid?.exchangeTime ?? null, lastReceiptTime: latest?.receivedAt ?? null,
    ageSeconds: age, workerStatus: workerAge >= 0 && workerAge <= 30000 ? "RUNNING" : "STOPPED_OR_NOT_STARTED", lastWorker: s.lastWorker,
    validSamples: counts.valid, failedSamples: counts.failed, pendingSamples: counts.pending,
    largestGapSeconds: Math.max(counts.gap, ongoing), latestStatus: latest?.status ?? "NO_SAMPLES", day };
}
