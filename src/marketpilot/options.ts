import { optionContracts, optionQuotes } from "./adapters/options";
import { QuoteError } from "./adapters/smartapi";
import { selectOptionPair, expiryBuffer } from "./option-contracts";
import { temporalStatus, validLiveFill, sameContract } from "./feed";
import { smartMarketStream } from "./adapters/smart-stream";
import { decide } from "./rules";
import { costs, optionFill } from "./paper";
import { fresh, istDay } from "./time";
import { db } from "./storage";
import type { State, Decision } from "./types";
import type { OptionContract, OptionDesk, OptionQuote, OptionSuggestion, OptionType } from "./option-types";

export const emptyOptions = (now: string): OptionDesk => ({ checkedAt: now, setupReason: "Mini option contract review and live premiums required", tracks: {}, selected: {}, suggestions: [] });
function auditOption(id: string, time: string, value: unknown) {
  try { db().prepare("INSERT INTO option_observations VALUES (?,?,?)").run(id, time, JSON.stringify(value)); }
  catch (error) { if (error instanceof Error) Object.assign(error, { optionAuditFailed: true }); throw error; }
}
export function heldOptionQuote(s: State) { return s.position?.contract.instrument === "OPTION" ? s.optionDesk?.tracks[s.position.contract.token]?.quote ?? s.position.optionEntryQuote : undefined; }
export function optionQuoteFresh(q: OptionQuote | null | undefined, now: string) {
  return !!q && Date.parse(q.time) <= Date.parse(now) && fresh(q.time, now) && fresh(q.receivedAt, now) && Date.parse(q.tradeTime) <= Date.parse(now) && fresh(q.tradeTime, now, 120);
}
export function hasNewOptionStreamQuote(s: State) {
  const now = new Date().toISOString();
  const tracks = Object.values(s.optionDesk?.tracks ?? {});
  return tracks.length > 0 && tracks.every(track => {
    const quote = smartMarketStream.latestOption(track.contract.token);
    return !!quote && quote.time.slice(0, 19) !== track.quote?.time.slice(0, 19) &&
      Date.parse(quote.time) <= Date.parse(now) && fresh(quote.time, now);
  });
}
export function optionFillReady(s: State) {
  const p = s.position, track = p ? s.optionDesk?.tracks[p.contract.token] : null, q = track?.quote;
  return !!p && p.contract.instrument === "OPTION" && p.side === "BUY" && validLiveFill(s) && track?.status === "OK" && optionQuoteFresh(q, s.clock) &&
    sameContract(q!.contract, p.contract) && q!.contract.optionType === p.contract.optionType && q!.contract.strike === p.contract.strike && q!.contract.underlyingSymbol === s.contract?.symbol && q!.bidQuantity >= p.contract.lotSize;
}
export async function pollOptions(s: State) {
  const desk = s.optionDesk ??= emptyOptions(s.clock);
  desk.checkedAt = new Date().toISOString();
  for (const track of Object.values(desk.tracks)) { track.status = "UNAVAILABLE"; track.reason = "No current accepted option observation"; }
  desk.setupReason = "";
  const held = s.position?.contract.instrument === "OPTION" ? s.position.contract : null;
  try {
    if (!process.env.MARKETPILOT_OPTION_SPECS_FILE?.trim()) throw new Error("Missing review");
    if (!s.contract || !validLiveFill(s)) throw new Error("Underlying unavailable");
    const all = await optionContracts(s.contract, desk.checkedAt);
    const previous = ["CE", "PE"].map(type => all.find(c => c.token === desk.selected[type as OptionType]));
    // Keep a selected strike within a 1% band to build an honest premium history.
    const keep = previous.every(c => c && !expiryBuffer(c, desk.checkedAt) && Math.abs(c.strike - s.lastQuote!.price) / s.lastQuote!.price <= 0.01);
    const pair = keep ? previous as OptionContract[] : selectOptionPair(all.filter(c => !expiryBuffer(c, desk.checkedAt)), s.lastQuote!.price);
    desk.selected = Object.fromEntries(pair.map(c => [c.optionType, c.token]));
    const contracts = [...pair];
    if (held && !contracts.some(c => c.token === held.token)) {
      const exact = all.find(c => c.token === held.token && c.symbol === held.symbol);
      if (!exact) throw new Error("Held identity unavailable");
      contracts.push(exact);
    }
    if (!contracts.length) throw new Error("No safe contract");
    for (const c of contracts) {
      smartMarketStream.subscribeSnapQuote(c.token);
      desk.tracks[c.token] ??= { contract: c, quote: null, candles: [], status: "UNAVAILABLE", reason: "Awaiting premium" };
    }
    for (const key of Object.keys(desk.tracks)) if (!contracts.some(c => c.token === key)) delete desk.tracks[key];
    const quotes = await optionQuotes(contracts);
    // Validate and persist every attempted selected quote before allowing fills.
    for (const q of quotes) {
      const track = desk.tracks[q.contract.token], status = temporalStatus(q.time, q.receivedAt, track.quote?.time ?? null);
      const reason = status === "OK" ? "Verified Mini option premium and market depth" : `Option quote ${status}; no fill accepted`;
      auditOption(q.id, q.receivedAt, { id: q.id, receivedAt: q.receivedAt, contract: q.contract, status, reason, quote: status === "OK" ? q : null });
      track.status = status; track.reason = reason; track.contract = q.contract;
      if (status !== "OK") continue;
      const bar = track.candles.at(-1);
      if (!bar || bar.time.slice(0, 16) !== q.time.slice(0, 16)) track.candles.push({ time: q.time, open: q.ltp, high: q.ltp, low: q.ltp, close: q.ltp, volume: 0 });
      else { bar.high = Math.max(bar.high, q.ltp); bar.low = Math.min(bar.low, q.ltp); bar.close = q.ltp; bar.time = q.time; }
      track.candles = track.candles.slice(-1500); track.quote = q;
    }
  } catch (error) {
    if ((error as { optionAuditFailed?: boolean } | null)?.optionAuditFailed) throw error;
    desk.setupReason = !process.env.MARKETPILOT_OPTION_SPECS_FILE?.trim() ? "Mini option specifications unverified; configure MARKETPILOT_OPTION_SPECS_FILE locally"
      : !validLiveFill(s) ? "Fresh verified underlying data required for Mini options"
      : "Mini option contract review, live premiums or market depth unavailable; entries blocked";
    for (const track of Object.values(desk.tracks)) {
      track.status = error instanceof QuoteError ? error.status : "UNAVAILABLE"; track.reason = desk.setupReason;
      const id = crypto.randomUUID();
      auditOption(id, desk.checkedAt, { id, receivedAt: desk.checkedAt, contract: track.contract, status: track.status, reason: desk.setupReason, quote: null });
    }
  }
}

export function suggestOptions(s: State, equity: number): OptionSuggestion[] {
  const desk = s.optionDesk ?? emptyOptions(s.clock);
  const direction = decide({ ...s, position: null }, equity, "DIRECTION");
  return (["CE", "PE"] as OptionType[]).map(type => {
    const track = desk.tracks[desk.selected[type] ?? ""], q = track?.quote ?? null, c = track?.contract ?? null;
    const result: OptionSuggestion = { type, action: "WAIT", reasons: [], contract: c, quote: q, entry: null, stop: null, target: null,
      estimatedCosts: 0, maxRisk: 0, premiumAtRisk: 0, observedCandles: track?.candles.length ?? 0, status: track?.status ?? "UNAVAILABLE" };
    if (s.position) { result.reasons.push("One paper position is already open; shared futures/options risk limit"); return result; }
    if (desk.setupReason) result.reasons.push(desk.setupReason);
    if (!c || !q || track?.status !== "OK" || !optionQuoteFresh(q, s.clock)) result.reasons.push("Fresh verified option premium, trade time and depth required");
    if (c && expiryBuffer(c, s.clock)) result.reasons.push("Option is within the 72-hour expiry buffer; devolvement protection");
    if (direction.action === "WAIT") result.reasons.push(...direction.reasons);
    else if (direction.action !== (type === "CE" ? "BUY" : "SELL")) result.reasons.push(`Underlying direction does not support buying ${type}`);
    if (q && c && (q.bidQuantity < c.lotSize || q.askQuantity < c.lotSize || q.volume < c.lotSize * 20 || q.openInterest < c.lotSize * 20)) result.reasons.push("Option depth, traded volume or open interest is too low for one lot");
    if (q && (q.ask - q.bid) / q.ask > 0.02) result.reasons.push("Option bid/ask spread exceeds 2%; entry blocked");
    const bars = track?.candles ?? [], history = bars.slice(-(s.settings.slow + 3));
    if (bars.length < s.settings.slow + 3) result.reasons.push(`Option premium history warming up: ${bars.length}/${s.settings.slow + 3} observed one-minute candles`);
    if (history.some((bar, i) => i > 0 && Date.parse(bar.time) - Date.parse(history[i - 1].time) > 120000)) result.reasons.push("Option premium history contains a feed gap");
    if (result.reasons.length || !q || !c) return result;
    const premiumMomentum = q.ltp - (bars.at(-4)?.close ?? q.ltp);
    if (premiumMomentum <= 0) { result.reasons.push("Option premium is not confirming the underlying move"); return result; }
    const recent = bars.slice(-14);
    const atr = recent.reduce((sum, bar, i) => sum + Math.max(bar.high - bar.low, Math.abs(bar.high - (recent[i - 1]?.close ?? bar.open)), Math.abs(bar.low - (recent[i - 1]?.close ?? bar.open))), 0) / recent.length;
    const tick = c.tickSize, distance = Math.ceil(Math.max(atr * 1.6, q.ltp * 0.1, tick * 4) / tick) * tick;
    result.entry = optionFill(q.ask, 1, tick, s.settings.slippage);
    result.stop = Number((Math.floor((q.bid - distance) / tick) * tick).toFixed(8));
    if (result.stop <= 0) { result.reasons.push("No positive protective premium stop is available"); result.entry = null; result.stop = null; return result; }
    const stopExit = optionFill(result.stop, -1, tick, s.settings.slippage);
    result.estimatedCosts = costs(result.entry, c.multiplier, s.settings) + costs(stopExit, c.multiplier, s.settings);
    result.maxRisk = (result.entry - stopExit) * c.multiplier + result.estimatedCosts;
    // Target must cover the actual spread, slippage and charges for a net 2R estimate.
    const targetExit = (2 * result.maxRisk + result.entry * c.multiplier + costs(result.entry, c.multiplier, s.settings) + s.settings.brokerage) / (c.multiplier * (1 - s.settings.statutoryBps / 10000));
    result.target = Number((Math.ceil((targetExit + s.settings.slippage) / tick) * tick).toFixed(8));
    result.premiumAtRisk = result.entry * c.multiplier + costs(result.entry, c.multiplier, s.settings);
    if (result.maxRisk > s.settings.riskPerTrade || equity - result.maxRisk < -s.settings.dailyLoss) result.reasons.push("One-lot option planned loss exceeds the shared per-trade or daily risk budget");
    else { result.action = "BUY"; result.reasons.push(`Underlying direction supports ${type}; observed premium momentum confirms`, "Verified near-money strike; one lot; observed spread and estimated costs included"); }
    return result;
  });
}

export function decideHeldOption(s: State, equity: number): Decision {
  const p = s.position!;
  const d = decide({ ...s, position: null }, equity, "DIRECTION");
  d.ruleVersion = "mini-options-1.0.0"; d.snapshot.position = structuredClone(p);
  d.entry = p.entry; d.stop = p.stop; d.target = p.target; d.maxRisk = p.maxRisk;
  const q = heldOptionQuote(s); d.estimatedCosts = p.entryCosts + costs(q?.bid ?? 0, p.contract.multiplier, p.settings);
  const underlyingUp = d.snapshot.fast > d.snapshot.slow && d.snapshot.momentum >= -s.settings.momentum;
  const underlyingDown = d.snapshot.fast < d.snapshot.slow && d.snapshot.momentum <= s.settings.momentum;
  d.action = "HOLD"; d.reasons = [];
  if (!optionFillReady(s)) d.reasons.push("Option or underlying data failed: EXIT required; no fill until a fresh executable bid returns");
  if (q && Date.parse(q.time) > Date.parse(p.time)) {
    if (q.bid <= p.stop) d.reasons.push("Protective option premium stop touched");
    else if (q.bid >= p.target) d.reasons.push("Planned net 2R option premium target reached");
  }
  if (p.contract.optionType === "CE" ? !underlyingUp : !underlyingDown) d.reasons.push("Underlying trend or momentum reversed against the option thesis");
  if (s.days.at(-1)?.locked) d.reasons.push("Shared daily risk/profit-protection lockout triggered");
  const time = Date.parse(s.clock), session = s.session;
  if (!session?.entriesAllowed || session.status !== "OPEN" || session.day !== istDay(s.clock) || !Number.isFinite(Date.parse(session.opensAt ?? "")) || !Number.isFinite(Date.parse(session.closesAt ?? "")) || time < Date.parse(session.opensAt!) || time >= Date.parse(session.closesAt!) - 5 * 60000) d.reasons.push("MCX session closing, closed or unverified; protective option exit required");
  if (expiryBuffer(p.contract, s.clock)) d.reasons.push("72-hour option expiry buffer reached; exit before devolvement risk");
  if (s.pendingExitReason) d.reasons.unshift(s.pendingExitReason);
  if (d.reasons.length) d.action = "EXIT"; else d.reasons.push("Option thesis intact; hold one lot with the original premium stop");
  d.exitCondition = "Premium stop/target, underlying reversal, data failure, session closing or expiry buffer. Exit fills require the exact live bid; gaps can exceed planned loss.";
  return d;
}
