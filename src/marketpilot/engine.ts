import { defaults, type Mode, type State, type Settings, type Day } from "./types";
import { loadReplay, observed, replayContext } from "./adapters/replay";
import { globalContext } from "./adapters/context";
import { currentContract, quote } from "./adapters/smartapi";
import { readState, saveState, exclusive } from "./storage";
import { decide } from "./rules";
import { closePosition, costs, liquidationNet } from "./paper";
import { fresh, istDay, istMinute } from "./time";
import { updateLock } from "./risk";
import { inApp } from "./notifications";
export function initial(mode: Mode): State {
  const replay = mode === "REPLAY" ? loadReplay() : null;
  const candles = replay ? observed(replay, 32) : [];
  const clock = candles.at(-1)?.time ?? new Date().toISOString();
  return { mode, cursor: candles.length, running: false, clock, contract: replay?.contract ?? null, candles, feed: replay ? "CONNECTED" : "DISCONNECTED", feedTime: replay ? clock : null, lastWorker: null, context: replay ? replayContext(clock) : [], settings: { ...defaults }, position: null, trades: [], days: [{ day: istDay(clock), net: 0, peak: 0, trades: 0, locked: false }], decision: null, journal: [], assessment: null, lastAlert: "", lastEntryBar: null };
}
function journal(s: State, kind: string, text: string) { s.journal.push({ id: crypto.randomUUID(), time: s.clock, kind, text }); }
export function mark(s: State) { return liquidationNet(s.position, s.candles.at(-1)?.close ?? 0, s.clock); }
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
  s.assessment = { day: istDay(s.clock), time: s.clock, text: `${manual ? "On-demand" : "Scheduled " + s.settings.assessmentTime + " IST"} assessment · ${d?.action ?? "WAIT"}. ${d?.reasons.join(". ") ?? "Awaiting data"}. Global: ${s.context.map(c => `${c.name} ${c.status}/${c.bias}`).join(", ")}. ${s.position ? `Open ${s.position.side}; stop ${s.position.stop}; planned risk ₹${s.position.maxRisk.toFixed(2)}` : "No open position"}. No outcome or positive close is guaranteed.` };
  journal(s, "ASSESSMENT", s.assessment.text);
}
export function evaluate(s: State) {
  const day = currentDay(s), equity = day.net + mark(s) - (day.openingMark ?? 0);
  updateLock(day, equity, s.settings);
  const d = decide(s, equity); s.decision = d;
  inApp.deliver(s, d);
  const bar = s.candles.at(-1);
  if (d.action === "EXIT" && s.position && bar && fresh(s.feedTime, s.clock) && ["CONNECTED", "REPLAY ENDED"].includes(s.feed)) {
    const p = s.position;
    let price = bar.close;
    if (d.reasons[0].startsWith("Protective stop")) price = s.mode === "LIVE" ? bar.close : p.side === "BUY" ? Math.min(p.stop, bar.open) : Math.max(p.stop, bar.open);
    else if (d.reasons[0].startsWith("Planned 2R")) price = p.target;
    const trade = closePosition(p, price, s.clock, d.reasons.join("; "));
    s.trades.push(trade); day.net += trade.net; s.position = null; s.lastEntryBar = bar.time;
    journal(s, "EXIT", `${p.side} ${p.contract.symbol} · fill ₹${trade.exit.toFixed(2)} · charges ₹${trade.costs.toFixed(2)} · net ₹${trade.net.toFixed(2)} · ${trade.reason}`);
    updateLock(day, day.net - (day.openingMark ?? 0), s.settings);
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
  if (s.position || !["BUY", "SELL"].includes(d.action) || !d.entry || !d.stop || !d.target || !s.contract || !(d.maxRisk > 0)) throw new Error("Entry blocked by current signal, feed, or risk rules");
  s.position = { side: d.action as "BUY" | "SELL", entry: d.entry, stop: d.stop, target: d.target, time: s.clock, contract: { ...s.contract }, entryCosts: costs(d.entry, s.contract.multiplier, s.settings), maxRisk: d.maxRisk, settings: { ...s.settings } };
  currentDay(s).trades++; s.lastEntryBar = s.candles.at(-1)!.time;
  journal(s, "ENTRY", `Paper ${d.action} · ${s.contract.symbol} · fixed 1 lot · fill ₹${d.entry.toFixed(2)} · stop ₹${d.stop.toFixed(2)} · planned loss ₹${d.maxRisk.toFixed(2)} including estimated costs`);
  return d;
}
async function live(s: State) {
  s.clock = new Date().toISOString();
  const contexts = globalContext(s.clock);
  try {
    const contract = s.position?.contract ?? await currentContract(s.clock);
    if (s.contract?.symbol !== contract.symbol) s.candles = [];
    s.contract = contract;
    const q = await quote(contract);
    if (s.feedTime && Date.parse(q.time) < Date.parse(s.feedTime)) throw new Error("Out-of-order exchange quote");
    const last = s.candles.at(-1);
    if (!last || last.time.slice(0, 16) !== q.time.slice(0, 16)) s.candles.push({ time: q.time, open: q.price, high: q.price, low: q.price, close: q.price, volume: 0 });
    else { last.high = Math.max(last.high, q.price); last.low = Math.min(last.low, q.price); last.close = q.price; last.time = q.time; }
    s.lastQuote = q;
    s.candles = s.candles.slice(-1500); s.feedTime = q.time; s.feed = "CONNECTED";
  } catch { s.feed = "DISCONNECTED"; }
  s.context = await contexts;
  s.clock = new Date().toISOString();
}
export type Command = "refresh" | "step" | "play" | "pause-replay" | "enter" | "exit" | "settings" | "assess" | "worker";
export async function operate(mode: Mode, command: Command, settings?: Partial<Settings>) {
  return exclusive(mode, async () => {
    const s = readState(mode) ?? initial(mode);
    if (command === "settings") { if (s.position && Object.keys(settings ?? {}).some(k => k !== "paused")) throw new Error("Close the paper position before changing risk/cost rules"); s.settings = { ...s.settings, ...settings }; journal(s, "CONFIG", "Risk/rule configuration updated; existing daily lockouts preserved"); }
    if (command === "play") s.running = true;
    if (command === "pause-replay") s.running = false;
    if (command === "worker") s.lastWorker = new Date().toISOString();
    if (mode === "LIVE") await live(s);
    else if (command === "step" || (command === "worker" && s.running)) {
      const replay = loadReplay();
      s.cursor = Math.min(s.cursor + 1, replay.candles.length); s.candles = observed(replay, s.cursor);
      s.clock = s.candles.at(-1)!.time; s.feedTime = s.clock; s.context = replayContext(s.clock);
      if (s.cursor === replay.candles.length) { s.running = false; s.feed = "REPLAY ENDED"; }
    }
    let d = evaluate(s);
    if (command === "enter") { try { d = enter(s); } catch (error) { saveState(s, d); throw error; } }
    if (command === "exit" && s.position) {
      if (s.feed !== "CONNECTED" || !fresh(s.feedTime, s.clock)) throw new Error("Cannot simulate a fill without a fresh quote");
      const t = closePosition(s.position, s.candles.at(-1)!.close, s.clock, "Manual paper exit");
      s.trades.push(t); currentDay(s).net += t.net; s.position = null; s.lastEntryBar = s.candles.at(-1)!.time;
      journal(s, "EXIT", `Manual paper exit · costs ₹${t.costs.toFixed(2)} · net ₹${t.net.toFixed(2)}`);
      updateLock(currentDay(s), currentDay(s).net - (currentDay(s).openingMark ?? 0), s.settings);
    }
    if (command === "assess") assess(s, true);
    s.lastMark = mark(s);
    saveState(s, d);
    return view(s);
  });
}
export function view(s: State) {
  const unrealized = mark(s), day = s.days.at(-1)!;
  let running = 0, peak = 0, drawdown = 0;
  for (const t of s.trades) { running += t.net; peak = Math.max(peak, running); drawdown = Math.max(drawdown, peak - running); }
  const daily = s.days.map(d => ({ ...d, net: d.net + (d.closingMark ?? (d === day ? unrealized : 0)) - (d.openingMark ?? 0) }));
  return { ...s, journal: s.journal.slice(-150).reverse(), unrealized, realized: day.net, equity: day.net + unrealized - (day.openingMark ?? 0), stats: { net: running + unrealized, drawdown: Math.max(drawdown, s.drawdown ?? 0), positive: daily.filter(d => d.net > 0.01).length, flat: daily.filter(d => Math.abs(d.net) <= 0.01).length, negative: daily.filter(d => d.net < -0.01).length, worst: Math.min(0, ...daily.map(d => d.net)) } };
}
export type DashboardState = ReturnType<typeof view>;
