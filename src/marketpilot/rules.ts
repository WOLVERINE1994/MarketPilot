import type { Decision, State } from "./types";
import { fresh, istDay } from "./time";
import { costs, fillPrice } from "./paper";
import { riskBlock } from "./risk";
export function decide(state: State, equity: number): Decision {
  const { candles: bars, settings: s, contract, position: p, clock: now } = state;
  const last = bars.at(-1), price = last?.close ?? 0;
  const avg = (n: number) => bars.slice(-n).reduce((a, b) => a + b.close, 0) / Math.max(1, Math.min(n, bars.length));
  const fast = avg(s.fast), slow = avg(s.slow), prev = bars.at(-4)?.close ?? price;
  const momentum = prev ? (price - prev) / prev * 100 : 0;
  const recent = bars.slice(-14);
  const atr = recent.reduce((a, b, i) => a + Math.max(b.high - b.low, Math.abs(b.high - (recent[i - 1]?.close ?? b.open)), Math.abs(b.low - (recent[i - 1]?.close ?? b.open))), 0) / Math.max(1, recent.length);
  const d: Decision = { id: crypto.randomUUID(), time: now, action: "WAIT", reasons: [], ruleVersion: "transparent-1.1.0", entry: null, stop: null, target: null, estimatedCosts: 0, maxRisk: 0, exitCondition: "Stop, 2R target, trend/momentum reversal, data failure, or risk lockout; adverse gaps can exceed planned loss.", snapshot: { session: structuredClone(state.session), candles: structuredClone(bars.slice(-Math.max(s.slow + 3, 15))), position: structuredClone(p), day: { ...state.days.at(-1)! }, equity, price: last ? price : null, fast, slow, momentum, atr, feed: state.feed, contract, context: structuredClone(state.context), settings: { ...s } } };
  const session = state.session, sessionTime = Date.parse(now);
  const sessionOpen = !!session && session.status === "OPEN" && session.entriesAllowed && session.day === istDay(now) &&
    Number.isFinite(Date.parse(session.opensAt ?? "")) && Number.isFinite(Date.parse(session.closesAt ?? "")) &&
    sessionTime >= Date.parse(session.opensAt!) && sessionTime < Date.parse(session.closesAt!) - 5 * 60000;
  const sessionReason = session?.status === "OPEN" ? "MCX session is no longer verified open at the current IST time; new entries blocked" : session?.reason ?? "MCX session unverified; new entries blocked";
  const badFeed = state.feed !== "CONNECTED" || !fresh(state.feedTime, now) || !contract?.verified;
  if (p) {
    d.entry = p.entry; d.stop = p.stop; d.target = p.target; d.maxRisk = p.maxRisk;
    d.estimatedCosts = p.entryCosts + costs(price, p.contract.multiplier, p.settings);
    const sign = p.side === "BUY" ? 1 : -1;
    // A bar overlapping entry cannot retrospectively trigger a stop/target.
    const afterEntry = !!last && Date.parse(last.time) > Date.parse(p.time);
    const low = state.mode === "LIVE" ? price : last?.low ?? price, high = state.mode === "LIVE" ? price : last?.high ?? price;
    const stop = afterEntry && (p.side === "BUY" ? low <= p.stop : high >= p.stop);
    const target = afterEntry && (p.side === "BUY" ? high >= p.target : low <= p.target);
    if (stop) d.reasons.push("Protective stop touched; stop takes precedence if both levels trade");
    else if (target) d.reasons.push("Planned 2R target reached");
    if ((fast - slow) * sign < 0 || momentum * sign < -s.momentum) d.reasons.push("Entry thesis failed: trend or momentum reversed");
    if (state.days.at(-1)?.locked) d.reasons.push("Daily risk or profit-protection lockout triggered");
    if (state.mode === "LIVE" && istDay(now) >= p.contract.expiry) d.reasons.push("Contract expiry reached; close the paper position");
    if (state.feed === "REPLAY ENDED") d.reasons.push("Replay complete: liquidate at the final observed price");
    else if (badFeed) d.reasons.push("Data unavailable or stale: EXIT required; fill deferred until a fresh quote");
    if (state.mode === "LIVE" && !sessionOpen) d.reasons.push(`${sessionReason}; protective exit required when fresh data permits`);
    if (d.reasons.length) d.action = "EXIT"; else { d.action = "HOLD"; d.reasons.push("Open thesis intact; keep the original stop and fixed one-lot size"); }
    return d;
  }
  if (state.mode === "LIVE" && !sessionOpen) d.reasons.push(sessionReason);
  if (badFeed) d.reasons.push("New entries blocked: stale/disconnected feed or unverified contract");
  if (bars.length < s.slow + 3) d.reasons.push("Waiting for sufficient observed candles");
  d.reasons.push(...riskBlock(s, state.days.at(-1)!, equity));
  if (state.lastEntryBar && last && state.lastEntryBar.slice(0, 16) === last.time.slice(0, 16)) d.reasons.push("Entry or exit already used this candle; no immediate re-entry");
  const history = bars.slice(-(s.slow + 3));
  if (history.some((b, i) => i > 0 && Date.parse(b.time) - Date.parse(history[i - 1].time) > 120000)) d.reasons.push("Recent candle history contains a feed gap; rebuild continuous evidence");
  if (state.context.some(c => c.block)) d.reasons.push("Global context risk blocker is active");
  if (s.requireContext && ["WTI", "Brent", "Oil news"].some(name => { const c = state.context.find(item => item.name === name); return !c || c.status === "UNAVAILABLE" || (state.mode === "LIVE" && c.status !== "LIVE") || !fresh(c.time, now, 900); })) d.reasons.push("Global confirmation is unavailable or stale");
  if (atr / Math.max(price, 1) * 100 > s.maxVolatility) d.reasons.push("Volatility exceeds the configured ceiling");
  if (d.reasons.length) return d;
  const side = fast > slow && momentum > s.momentum ? "BUY" : fast < slow && momentum < -s.momentum ? "SELL" : null;
  if (!side || Math.abs(fast - slow) < atr * 0.3) { d.reasons.push("Trend and momentum are weak or conflicting; preserve capital"); return d; }
  if (state.context.some(c => fresh(c.time, now, 900) && ((side === "BUY" && c.bias === "DOWN") || (side === "SELL" && c.bias === "UP")))) { d.reasons.push("Global direction conflicts with the proposed entry"); return d; }
  const sign = side === "BUY" ? 1 : -1, tick = contract!.tickSize;
  const distance = Math.ceil(Math.max(atr * 1.6, tick * 4) / tick) * tick;
  d.entry = fillPrice(price, sign, tick, s);
  d.stop = Math.round((price - sign * distance) / tick) * tick;
  d.target = Math.round((price + sign * distance * 2) / tick) * tick;
  const stopFill = fillPrice(d.stop, -sign, tick, s);
  d.estimatedCosts = costs(d.entry, contract!.multiplier, s) + costs(stopFill, contract!.multiplier, s);
  d.maxRisk = Math.abs(d.entry - stopFill) * contract!.multiplier + d.estimatedCosts;
  if (d.maxRisk > s.riskPerTrade || equity - d.maxRisk < -s.dailyLoss) d.reasons.push("One-lot planned loss exceeds per-trade or remaining daily risk budget");
  else { d.action = side; d.reasons.push(`${s.fast}/${s.slow} candle trend ${side === "BUY" ? "up" : "down"}; 3-candle momentum ${momentum.toFixed(3)}%; ATR ${atr.toFixed(2)}`, s.requireContext ? "Fresh global context has no opposing direction or event blocker" : "Global confirmation requirement manually disabled; any fresh opposing context still blocks", "Fixed one lot; stop and estimated round-trip charges fit the risk budget"); }
  return d;
}
