import { defaults, type Mode, type State, type Settings, type Day } from "./types";
import { loadReplay, observed, replayContext } from "./adapters/replay";
import { globalContext } from "./adapters/context";
import { applyObservation, feedHealth, pollLive, validLiveFill } from "./feed";
import { readState, saveState, exclusive, MonitorBusyError } from "./storage";
import { decide } from "./rules";
import { closePosition, costs, liquidationNet } from "./paper";
import { fresh, istDay, istMinute } from "./time";
import { updateLock } from "./risk";
import { marketSession } from "./session";
import { paperPerformance } from "./performance";
import { inApp } from "./notifications";
import { decideHeldOption, hasNewOptionStreamQuote, heldOptionQuote, optionFillReady, pollOptions, suggestOptions } from "./options";
export function initial(mode: Mode): State {
  const replay = mode === "REPLAY" ? loadReplay() : null;
  const candles = replay ? observed(replay, 32) : [];
  const clock = candles.at(-1)?.time ?? new Date().toISOString();
  return { mode, cursor: candles.length, running: false, clock, contract: replay?.contract ?? null, candles, feed: replay ? "CONNECTED" : "DISCONNECTED", feedTime: replay ? clock : null, lastWorker: null, context: replay ? replayContext(clock) : [], settings: { ...defaults }, position: null, trades: [], days: [{ day: istDay(clock), net: 0, peak: 0, trades: 0, locked: false }], decision: null, journal: [], assessment: null, lastAlert: "", lastEntryBar: null, session: { day: istDay(clock), status: "UNVERIFIED", entriesAllowed: false, reason: "MCX session unverified; new entries blocked", source: null, opensAt: null, closesAt: null } };
}
function journal(s: State, kind: string, text: string) { s.journal.push({ id: crypto.randomUUID(), time: s.clock, kind, text }); }
function lock(s: State, equity: number) {
  const day = currentDay(s), wasLocked = day.locked;
  updateLock(day, equity, s.settings);
  if (!wasLocked && day.locked) journal(s, "RISK_LOCKOUT", `Daily loss/profit-protection lockout latched at estimated equity INR ${equity.toFixed(2)}; peak INR ${day.peak.toFixed(2)}. No new entries until next IST day.`);
}
function canFill(s: State) { return s.position?.contract.instrument === "OPTION" ? optionFillReady(s) : s.mode === "LIVE" ? validLiveFill(s) : fresh(s.feedTime, s.clock) && ["CONNECTED", "REPLAY ENDED"].includes(s.feed); }
export function mark(s: State) { return liquidationNet(s.position, s.candles.at(-1)?.close ?? 0, s.clock, heldOptionQuote(s)); }
export function currentDay(s: State): Day {
  let day = s.days.at(-1)!;
  if (day.day !== istDay(s.clock)) {
    // Carry overnight MTM into the new day's baseline, so midnight cannot reset open risk.
    day.closingMark = s.lastMark ?? 0;
    day = { day: istDay(s.clock), net: 0, openingMark: s.lastMark ?? 0, peak: 0, trades: 0, locked: false };
    s.days.push(day);
  }
  return day;
}
export function assess(s: State, manual = false) {
  if (!manual && (istMinute(s.clock) < s.settings.assessmentTime || s.scheduledDay === istDay(s.clock))) return;
  if (!manual) s.scheduledDay = istDay(s.clock);
  const d = s.decision;
  const feedReady = canFill(s);
  const contextReady = ["WTI", "Brent", "Oil news"].every(name => {
    const c = s.context.find(item => item.name === name);
    return c && c.status !== "UNAVAILABLE" && (s.mode === "REPLAY" || c.status === "LIVE") && fresh(c.time, s.clock, c.freshnessSeconds ?? 900);
  });
  const conclusion = feedReady && contextReady ? (d?.reasons.join(". ") ?? "Awaiting decision") : "Market conclusion unavailable: feed or global context is missing, stale or unverified. Current state is a safety/risk status, not a market forecast.";
  s.assessment = { day: istDay(s.clock), time: s.clock, text: `${manual ? "On-demand" : "Scheduled " + s.settings.assessmentTime + " IST"} assessment · ${d?.action ?? "WAIT"}. Data: ${s.feed}; observation ${s.latestObservation?.status ?? (s.mode === "REPLAY" ? "SYNTHETIC" : "NONE")}; last valid exchange ${s.feedTime ?? "UNAVAILABLE"}; ${feedReady ? "fresh" : "UNAVAILABLE for fills"}. ${conclusion}. Global: ${s.context.map(c => `${c.name} ${c.status}${c.status === "UNAVAILABLE" ? "" : "/" + c.bias}`).join(", ") || "UNAVAILABLE"}. ${s.position ? `Open ${s.position.side}; stop ${s.position.stop}; planned risk ₹${s.position.maxRisk.toFixed(2)}. ${feedReady ? "Marked P&L remains an estimate" : "Current liquidation value unknown; exit must await valid data"}` : "No open position"}. No outcome or positive close is guaranteed.` };
  journal(s, "ASSESSMENT", s.assessment.text);
}
export function evaluate(s: State) {
  const day = currentDay(s), equity = day.net + mark(s) - (day.openingMark ?? 0);
  lock(s, equity);
  if (s.mode === "LIVE" && !validLiveFill(s) && s.feed === "CONNECTED") s.feed = "UNVERIFIED";
  const d = s.position?.contract.instrument === "OPTION" ? decideHeldOption(s, equity) : decide(s, equity); s.decision = d;
  if (s.mode === "LIVE" && s.optionDesk) { s.optionDesk.suggestions = suggestOptions(s, equity); d.snapshot.options = structuredClone(s.optionDesk.suggestions); }
  if (s.mode === "LIVE") {
    d.snapshot.observationId = s.latestObservation?.id ?? null;
    d.snapshot.dataStatus = s.latestObservation?.status ?? "NO_SAMPLES";
    if (s.position && s.pendingExitReason) { d.action = "EXIT"; d.reasons.unshift(s.pendingExitReason); }
    if (s.position && d.action === "EXIT" && !canFill(s)) s.pendingExitReason ??= "Previously required EXIT after data/risk failure; execute only on a new valid quote";
  }
  inApp.deliver(s, d);
  const bar = s.candles.at(-1);
  if (d.action === "EXIT" && s.position && bar && canFill(s)) {
    const p = s.position;
    let price = bar.close;
    if (d.reasons[0].startsWith("Protective stop")) price = s.mode === "LIVE" ? bar.close : p.side === "BUY" ? Math.min(p.stop, bar.open) : Math.max(p.stop, bar.open);
    else if (s.mode === "REPLAY" && d.reasons[0].startsWith("Planned 2R")) price = p.target;
    const trade = closePosition(p, price, s.clock, d.reasons.join("; "), heldOptionQuote(s));
    s.trades.push(trade); day.net += trade.net; s.position = null; s.pendingExitReason = undefined; s.lastEntryBar = bar.time;
    journal(s, "EXIT", `${p.side} ${p.contract.symbol} · fill ₹${trade.exit.toFixed(2)} · charges ₹${trade.costs.toFixed(2)} · net ₹${trade.net.toFixed(2)} · ${trade.reason}`);
    lock(s, day.net - (day.openingMark ?? 0));
  }
  s.lastMark = mark(s);
  const totalEquity = s.trades.reduce((sum, t) => sum + t.net, 0) + s.lastMark;
  s.equityPeak = Math.max(s.equityPeak ?? 0, totalEquity);
  s.drawdown = Math.max(s.drawdown ?? 0, s.equityPeak - totalEquity);
  assess(s);
  return d;
}
export function enter(s: State) {
  const d = s.decision ?? evaluate(s);
  if (!canFill(s) || s.position || !["BUY", "SELL"].includes(d.action) || !d.entry || !d.stop || !d.target || !s.contract || !(d.maxRisk > 0)) {
    const blockers = [...d.reasons];
    if (!canFill(s)) blockers.unshift("A fresh verified quote and contract are required");
    if (s.position) blockers.unshift("A paper position is already open");
    if (!["BUY", "SELL"].includes(d.action)) blockers.unshift(`Current recommendation is ${d.action}, not BUY or SELL`);
    if (!d.entry || !d.stop || !d.target || !(d.maxRisk > 0)) blockers.push("A complete entry, stop, target, and positive risk estimate are unavailable");
    if (!s.contract) blockers.push("The active contract is unverified");
    throw new Error(`Paper entry blocked: ${[...new Set(blockers)].join("; ")}`);
  }
  s.position = { side: d.action as "BUY" | "SELL", entry: d.entry, stop: d.stop, target: d.target, time: s.clock, contract: { ...s.contract }, entryCosts: costs(d.entry, s.contract.multiplier, s.settings), maxRisk: d.maxRisk, settings: { ...s.settings } };
  currentDay(s).trades++; s.lastEntryBar = s.candles.at(-1)!.time;
  journal(s, "ENTRY", `Paper ${d.action} · ${s.contract.symbol} · fixed 1 lot · fill ₹${d.entry.toFixed(2)} · stop ₹${d.stop.toFixed(2)} · planned loss ₹${d.maxRisk.toFixed(2)} including estimated costs`);
  return d;
}
export function enterOption(s: State, type: "CE" | "PE") {
  const suggestion = suggestOptions(s, currentDay(s).net + mark(s) - (currentDay(s).openingMark ?? 0)).find(item => item.type === type);
  const track = suggestion?.contract ? s.optionDesk?.tracks[suggestion.contract.token] : null;
  if (s.mode !== "LIVE" || s.position || suggestion?.action !== "BUY" || !suggestion.contract || !suggestion.quote || !suggestion.entry || !suggestion.stop || !suggestion.target || track?.status !== "OK") {
    const blockers: string[] = [];
    if (s.mode !== "LIVE") blockers.push("Live market data is required");
    if (s.position) blockers.push("A paper position is already open; the shared position limit is one");
    if (suggestion?.action !== "BUY") blockers.push(`${type} recommendation is ${suggestion?.action ?? "unavailable"}`, ...(suggestion?.reasons ?? []));
    if (!suggestion?.contract || !suggestion.quote || !suggestion.entry || !suggestion.stop || !suggestion.target || track?.status !== "OK") blockers.push("A fresh, liquid option quote and complete risk plan are unavailable");
    throw new Error(`Paper ${type} entry blocked: ${[...new Set(blockers)].join("; ")}`);
  }
  s.position = { side: "BUY", entry: suggestion.entry, stop: suggestion.stop, target: suggestion.target, time: s.clock,
    contract: { ...suggestion.contract }, entryCosts: costs(suggestion.entry, suggestion.contract.multiplier, s.settings), maxRisk: suggestion.maxRisk,
    settings: { ...s.settings }, optionEntryQuote: structuredClone(suggestion.quote), premiumAtRisk: suggestion.premiumAtRisk };
  currentDay(s).trades++; s.lastEntryBar = s.candles.at(-1)!.time;
  journal(s, "ENTRY", `Paper BUY ${type} · ${s.position.contract.symbol} · fixed 1 lot · premium fill INR ${suggestion.entry.toFixed(2)} · premium stop INR ${suggestion.stop.toFixed(2)} · planned loss INR ${suggestion.maxRisk.toFixed(2)} · full premium and entry charge INR ${suggestion.premiumAtRisk.toFixed(2)}; losses can exceed the stop plan`);
}
async function live(s: State, worker: boolean) {
  s.clock = new Date().toISOString();
  const contexts = globalContext(s.clock);
  const previous = s.latestObservation;
  const observation = await pollLive(s, worker ? "worker" : "dashboard");
  applyObservation(s, observation);
  if (observation.status !== previous?.status) journal(s, "FEED", `${observation.status}: ${observation.reason}; observation ${observation.id}`);
  if ((observation.gapSeconds ?? 0) > 30 && observation.status === "OK") journal(s, "FEED_GAP", `Accepted quote after ${observation.gapSeconds!.toFixed(1)} seconds without a valid sample. No missing candles were reconstructed.`);
  s.context = await contexts;
  s.clock = new Date().toISOString();
  s.session = await marketSession(s.clock);
  if (!worker || Date.now() - lastWorkerOptionPoll >= 5000 || hasNewOptionStreamQuote(s)) {
    await pollOptions(s);
    lastWorkerOptionPoll = Date.now();
  }
  s.clock = new Date().toISOString();
}
let lastWorkerOptionPoll = 0;
export type Command = "refresh" | "step" | "play" | "pause-replay" | "enter" | "enter-ce" | "enter-pe" | "exit" | "settings" | "assess" | "worker" | "heartbeat";
const dashboardRefreshes = new Map<Mode, Promise<DashboardState>>();
function savedView(s: State) {
  if (s.mode === "LIVE") s.feedHealth = feedHealth(s);
  return view(s);
}
export async function refreshDashboard(mode: Mode): Promise<DashboardState> {
  const saved = readState(mode);
  const workerAge = Date.now() - Date.parse(saved?.lastWorker ?? "");
  // The worker owns continuous ingestion. Browser polls only read its committed
  // state while its heartbeat is current, including during an in-flight tick.
  if (saved && workerAge >= 0 && workerAge <= 30000) return savedView(saved);
  const pending = dashboardRefreshes.get(mode);
  if (pending) return pending;
  // Preserve dashboard-only monitoring if no worker is running; coalesce tabs.
  const refresh = operate(mode, "refresh").catch(error => {
    if (!(error instanceof MonitorBusyError)) throw error;
    const latest = readState(mode);
    if (!latest) throw error;
    return savedView(latest);
  }).finally(() => dashboardRefreshes.delete(mode));
  dashboardRefreshes.set(mode, refresh);
  return refresh;
}
export async function operate(mode: Mode, command: Command, settings?: Partial<Settings>) {
  return exclusive(mode, async () => {
    const s = readState(mode) ?? initial(mode);
    if (mode === "LIVE") s.clock = new Date().toISOString();
    if (mode === "LIVE" && command === "heartbeat") {
      s.lastWorker = s.clock;
      s.feedHealth = feedHealth(s);
      saveState(s);
      return view(s);
    }
    if (command === "settings") { if (s.position && Object.keys(settings ?? {}).some(k => k !== "paused")) throw new Error("Close the paper position before changing risk/cost rules"); s.settings = { ...s.settings, ...settings }; journal(s, "CONFIG", "Risk/rule configuration updated; existing daily lockouts preserved"); }
    if (command === "play") s.running = true;
    if (command === "pause-replay") s.running = false;
    if (command === "worker") s.lastWorker = new Date().toISOString();
    if (mode === "LIVE") await live(s, command === "worker");
    else if (command === "step" || (command === "worker" && s.running)) {
      const replay = loadReplay();
      s.cursor = Math.min(s.cursor + 1, replay.candles.length); s.candles = observed(replay, s.cursor);
      s.clock = s.candles.at(-1)!.time; s.feedTime = s.clock; s.context = replayContext(s.clock);
      if (s.cursor === replay.candles.length) { s.running = false; s.feed = "REPLAY ENDED"; }
    }
    if (command === "worker") s.lastWorker = new Date().toISOString();
    let d = evaluate(s);
    if (command === "enter") { try { d = enter(s); } catch (error) { journal(s, "SKIPPED", error instanceof Error ? error.message : "Paper entry blocked; see current decision reasons"); saveState(s, d); throw error; } }
    if (command === "enter-ce" || command === "enter-pe") {
      try { enterOption(s, command === "enter-ce" ? "CE" : "PE"); d = evaluate(s); }
      catch (error) { journal(s, "SKIPPED", error instanceof Error ? error.message : "Option paper entry blocked; see current option reasons"); saveState(s, d); throw error; }
    }
    if (command === "exit" && s.position) {
      if (!canFill(s)) { journal(s, "SKIPPED", "Requested paper exit deferred: no fresh verified quote"); saveState(s, d); throw new Error("Cannot simulate a fill without a fresh quote"); }
      const t = closePosition(s.position, s.candles.at(-1)!.close, s.clock, "Manual paper exit", heldOptionQuote(s));
      s.trades.push(t); currentDay(s).net += t.net; s.position = null; s.pendingExitReason = undefined; s.lastEntryBar = s.candles.at(-1)!.time;
      journal(s, "EXIT", `Manual paper exit · costs ₹${t.costs.toFixed(2)} · net ₹${t.net.toFixed(2)}`);
      lock(s, currentDay(s).net - (currentDay(s).openingMark ?? 0));
    }
    if (command === "assess") assess(s, true);
    s.lastMark = mark(s);
    if (mode === "LIVE") s.feedHealth = feedHealth(s);
    saveState(s, d);
    return view(s);
  });
}
export function view(s: State) {
  const unrealized = mark(s), day = s.days.at(-1)!;
  let running = 0, peak = 0, drawdown = 0;
  for (const t of s.trades) { running += t.net; peak = Math.max(peak, running); drawdown = Math.max(drawdown, peak - running); }
  const daily = s.days.map(d => ({ ...d, net: d.net + (d.closingMark ?? (d === day ? unrealized : 0)) - (d.openingMark ?? 0) }));
  return { ...s, journal: s.journal.slice(-150).reverse(), unrealized, realized: day.net, equity: day.net + unrealized - (day.openingMark ?? 0), stats: { performance: paperPerformance(s.trades), net: running + unrealized, drawdown: Math.max(drawdown, s.drawdown ?? 0), positive: daily.filter(d => d.net > 0.01).length, flat: daily.filter(d => Math.abs(d.net) <= 0.01).length, negative: daily.filter(d => d.net < -0.01).length, worst: Math.min(0, ...daily.map(d => d.net)) } };
}
export type DashboardState = ReturnType<typeof view>;
