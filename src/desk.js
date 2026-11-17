import { EventEmitter } from "node:events";
import { PRODUCTS } from "./config.js";
import { aggregate, CandleBuilder } from "./candles.js";
import { Strategy } from "./strategy.js";
import { selectContracts, pickOption, nearbyOptions, instKey } from "./contracts.js";
import { planTrade } from "./risk.js";
import { istDay, istClock } from "./time.js";

const fmt = n => (n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const rupees = n => `${n < 0 ? "-" : ""}₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

/**
 * The trading desk: turns live ticks into candles, runs the strategy for each
 * product, prices the CE/PE (or futures) plan, sends alerts and keeps a paper
 * record of every signal's outcome. It never places orders.
 *
 * Instruments are identified by "EXCH|token" keys (tokens repeat across exchanges).
 * `feed` provides: now(), contracts(productKeys) -> rows, history(inst, from, to),
 * subscribe(keys), quotes(instruments) -> Map(key -> quote), and calls desk.onTick(tick).
 */
export class Desk extends EventEmitter {
  constructor(config, feed, { journal, notifier } = {}) {
    super();
    this.config = config; this.feed = feed; this.journal = journal; this.notifier = notifier;
    this.products = new Map(); // product key -> desk state
    this.quotes = new Map();   // "EXCH|token" -> latest tick
    this.open = journal?.loadOpen() ?? []; // open paper trades
    this.closed = journal?.closedTrades() ?? [];
    this.signals = [];         // recent signals (newest last)
    this.status = { feed: "starting", lastTick: null, message: "" };
  }

  now() { return this.feed.now ? this.feed.now() : Date.now(); }

  async start() {
    const keys = this.config.products;
    const rows = await this.feed.contracts(keys);
    const today = istDay(this.now());
    for (const key of keys) {
      const product = PRODUCTS[key];
      const { underlying, optionExpiry, chain, multiplier } = selectContracts(rows, product, today, { skipExpiryDay: this.config.skipExpiryDay });
      if (!underlying) { this.status.message = `No ${product.label} ${product.kind === "INDEX" ? "index" : "futures"} found in the instrument list`; continue; }
      const trade = key === "CRUDEOILM" ? this.config.crudeTrade : "OPTIONS";
      const session = product.kind === "INDEX" ? this.config.indexSession : {};
      const p = { key, product, underlying, uKey: instKey(underlying), optionExpiry, chain, multiplier, trade, notes: [],
        strategy: new Strategy({ ...this.config.strategy, ...session, tick: underlying.tickSize }), builder: null };
      if (product.kind === "COMMODITY" && underlying.lotSize && underlying.lotSize !== product.lot) p.notes.push(`Instrument list lot size is ${underlying.lotSize}, app assumes ${product.lot}; check MCX specs`);
      if (!chain.length) p.notes.push("No option contracts found — showing direction only");
      p.builder = new CandleBuilder(this.config.strategy.timeframe, { onClose: c => this.onCandleClose(p, c) });
      const to = this.now(), from = to - 7 * 86400000;
      let history = [];
      try { history = await this.feed.history(underlying, from, to); } catch (e) { p.notes.push(`Could not load past candles (${e.message}); building from live ticks`); }
      p.builder.seed(aggregate(history, this.config.strategy.timeframe), to);
      p.strategy.warm(p.builder.closed);
      // Restore an open paper trade after a restart so its stop/target keep being watched.
      const restored = this.open.find(t => t.product === key);
      if (restored) p.strategy.position = { side: restored.side, entry: restored.futuresEntry, stop: restored.stop, target: restored.target,
        risk: Math.abs(restored.target - restored.futuresEntry) / this.config.strategy.riskReward, time: restored.entryTime };
      this.products.set(key, p);
      this.feed.subscribe([p.uKey]);
      this.resubscribeOptions(p, history.at(-1)?.close);
    }
    this.status.feed = "running";
    this.timer = setInterval(() => this.housekeeping(), 1000);
    this.emit("update");
  }

  stop() { clearInterval(this.timer); }

  resubscribeOptions(p, price) {
    if (!p.chain.length || !(price > 0)) return;
    const keys = nearbyOptions(p.chain, price, 3).map(instKey);
    for (const t of this.open.filter(o => o.product === p.key && o.optionKey)) keys.push(t.optionKey);
    this.feed.subscribe(keys);
  }

  housekeeping() {
    const now = this.now();
    for (const p of this.products.values()) p.builder.flush(now);
    if (!this.lastOptionRefresh || now - this.lastOptionRefresh > 60000) {
      this.lastOptionRefresh = now;
      for (const p of this.products.values()) this.resubscribeOptions(p, this.price(p));
    }
    this.emit("tick");
  }

  price(p) { return this.quotes.get(p.uKey)?.ltp ?? p.builder.all().at(-1)?.close ?? null; }

  onTick(tick) {
    const key = tick.key ?? `${tick.exch}|${tick.token}`;
    this.quotes.set(key, tick);
    this.status.lastTick = Math.max(this.status.lastTick ?? 0, tick.time);
    for (const p of this.products.values()) {
      if (key !== p.uKey) continue;
      p.builder.tick(tick.ltp, tick.time, tick.volume);
      this.handle(p, p.strategy.onPrice(tick.ltp, tick.time));
    }
    this.emit("tick");
  }

  onCandleClose(p, candle) { this.handle(p, p.strategy.onCandle(candle)); }

  dayStats(day = istDay(this.now())) {
    const today = this.closed.filter(t => istDay(t.exitTime) === day);
    return { pnl: today.reduce((s, t) => s + t.pnl, 0), trades: today.length + this.open.filter(t => istDay(t.entryTime) === day).length };
  }

  /** Events for one product are processed strictly in order (entry pricing awaits a quote). */
  handle(p, events) {
    if (!events.length) return p.queue;
    p.queue = (p.queue ?? Promise.resolve()).then(() => this.process(p, events));
    return p.queue;
  }

  async process(p, events) {
    for (const ev of events) {
      try {
        if (ev.type === "ENTRY") await this.enter(p, ev);
        else if (ev.type === "EXIT") await this.exit(p, ev);
        else if (ev.type === "TRAIL") await this.trail(p, ev);
      } catch (error) { this.status.message = `Signal handling error: ${error.message}`; }
    }
    if (events.length) this.emit("update");
  }

  async optionPremium(inst) {
    const key = instKey(inst);
    let q = this.quotes.get(key);
    if (!q || this.now() - q.time > 60000) {
      try { const got = await this.feed.quotes([inst]); q = got.get(key) ?? q; if (q) this.quotes.set(key, q); } catch { /* use what we have */ }
    }
    return q ? { buy: q.ask ?? q.ltp, sell: q.bid ?? q.ltp, ltp: q.ltp } : null;
  }

  async enter(p, ev) {
    const cfg = this.config, day = this.dayStats();
    const risk = { ...cfg.risk, riskReward: cfg.strategy.riskReward };
    const futuresPlan = p.product.futures ? planTrade({ product: p.product, multiplier: p.multiplier, entry: ev, risk, day }) : null;
    let optionPlan = null;
    if (p.product.options && p.chain.length) {
      const option = pickOption(p.chain, ev.price, ev.side, cfg.optionStrike);
      if (option) {
        this.feed.subscribe([instKey(option)]);
        const prem = await this.optionPremium(option);
        optionPlan = planTrade({ product: p.product, multiplier: p.multiplier ?? option.lotSize, entry: ev, risk, moneyness: cfg.optionStrike, option, premium: prem?.buy ?? null, day });
      }
    }
    const primary = (p.trade === "OPTIONS" && optionPlan) || futuresPlan || optionPlan
      || { kind: "DIRECTION", action: ev.side === "BUY" ? "BULLISH" : "BEARISH", warnings: ["No option contract available — direction only"] };
    const signal = {
      id: `${p.key}-${ev.time}`, product: p.key, label: p.product.label, side: ev.side, time: ev.time,
      futures: { symbol: p.underlying.symbol, price: ev.price, stop: ev.stop, target: ev.target },
      reason: ev.reason, plan: primary, alternative: primary === optionPlan ? futuresPlan : optionPlan, status: "OPEN",
    };
    this.signals.push(signal); this.signals = this.signals.slice(-50);
    const isOption = primary.kind === "OPTION";
    const trade = { id: signal.id, product: p.key, label: p.product.label, side: ev.side, kind: primary.kind, entryTime: ev.time,
      futuresEntry: ev.price, stop: ev.stop, target: ev.target, multiplier: isOption ? primary.lotSize : p.multiplier, cost: cfg.risk.costPerTrade,
      symbol: isOption ? primary.symbol : p.underlying.symbol, optionKey: isOption ? `${primary.exch}|${primary.token}` : null,
      entryPrice: isOption ? primary.premium : primary.kind === "FUTURES" ? ev.price : null, warnings: primary.warnings };
    this.open.push(trade);
    this.journal?.saveOpen(this.open);
    this.journal?.append({ record: "SIGNAL", ...signal });
    const head = ev.side === "BUY" ? "🟢" : "🔴";
    const lines = [`${head} ${p.product.label}: ${primary.action}${isOption ? ` ${fmt(primary.strike)}` : ""} — 1 lot${isOption ? ` (${primary.lotSize} qty)` : ""}`, `Time ${istClock(ev.time)} IST`];
    if (isOption) {
      lines.push(`Option: ${primary.symbol}`, `Premium ≈ ₹${fmt(primary.premium)} (1 lot ≈ ${primary.outlay ? rupees(primary.outlay) : "—"})`,
        `Exit if premium ≈ ₹${fmt(primary.premiumStop)} (stop) or ₹${fmt(primary.premiumTarget)} (target)`);
    }
    lines.push(`${p.underlying.symbol} ${fmt(ev.price)} | SL ${fmt(ev.stop)} | Target ${fmt(ev.target)}`);
    if (primary.estLoss != null) lines.push(`Est. loss at SL ${rupees(primary.estLoss)} · est. profit at target ${rupees(primary.estProfit)}`);
    lines.push(`Why: ${ev.reason}`);
    for (const w of primary.warnings) lines.push(`⚠️ ${w}`);
    await this.notifier?.send(lines.join("\n"));
  }

  async exit(p, ev) {
    const idx = this.open.findIndex(t => t.product === p.key);
    if (idx < 0) return;
    const t = this.open[idx];
    let exitPrice = t.kind === "FUTURES" ? ev.price : null;
    if (t.kind === "OPTION" && t.optionKey) {
      const [exch, token] = t.optionKey.split("|");
      exitPrice = (await this.optionPremium({ exch, token }))?.sell ?? null;
    }
    const priced = t.entryPrice != null && exitPrice != null;
    const pnl = priced ? (t.kind === "OPTION" ? exitPrice - t.entryPrice : (exitPrice - t.entryPrice) * (t.side === "BUY" ? 1 : -1)) * t.multiplier - t.cost : 0;
    const closed = { ...t, record: "CLOSED", exitTime: ev.time, exitPrice, futuresExit: ev.price, reason: ev.reason, pnl: Math.round(pnl * 100) / 100, priced };
    this.open.splice(idx, 1);
    this.closed.push(closed);
    this.journal?.saveOpen(this.open);
    this.journal?.append(closed);
    const s = this.signals.find(x => x.id === t.id); if (s) { s.status = "CLOSED"; s.result = closed; }
    const day = this.dayStats();
    await this.notifier?.send([`⏹ EXIT ${t.label} (${t.kind === "OPTION" ? t.symbol : t.kind === "FUTURES" ? `${t.side} FUT` : "direction"}) — ${ev.reason}`,
      `Time ${istClock(ev.time)} IST · ${p.underlying.symbol} ${fmt(ev.price)}`,
      t.kind === "OPTION" ? `Premium ₹${fmt(t.entryPrice)} → ₹${fmt(exitPrice)}` : `Price ${fmt(t.futuresEntry)} → ${fmt(ev.price)}`,
      priced ? `Paper result ${rupees(closed.pnl)} after est. costs · Today ${rupees(day.pnl)}` : "Paper result unknown (no premium quote)"].join("\n"));
  }

  async trail(p, ev) {
    const t = this.open.find(x => x.product === p.key);
    if (t) { t.stop = ev.stop; this.journal?.saveOpen(this.open); }
    await this.notifier?.send(`↔️ ${p.product.label}: ${ev.reason}. New ${p.product.kind === "INDEX" ? "index" : "futures"} stop ${fmt(ev.stop)}. Move your option stop to your entry premium.`);
  }

  /** Everything the dashboard shows. */
  snapshot() {
    const now = this.now();
    const products = [...this.products.values()].map(p => {
      const price = this.price(p), candles = p.builder.all().slice(-80);
      const st = p.strategy.status();
      const open = this.open.find(t => t.product === p.key) ?? null;
      let live = null;
      if (open) {
        const q = open.optionKey ? this.quotes.get(open.optionKey) : null;
        const mark = open.kind === "OPTION" ? q?.bid ?? q?.ltp ?? null : price;
        const pnl = mark != null && open.entryPrice != null ? (open.kind === "OPTION" ? mark - open.entryPrice : (mark - open.entryPrice) * (open.side === "BUY" ? 1 : -1)) * open.multiplier - open.cost : null;
        live = { ...open, stop: p.strategy.position?.stop ?? open.stop, mark, pnl };
      }
      const atm = price && p.chain.length ? ["BUY", "SELL"].map(side => {
        const o = pickOption(p.chain, price, side, this.config.optionStrike);
        const q = o ? this.quotes.get(instKey(o)) : null;
        return o ? { type: o.type, symbol: o.symbol, strike: o.strike, lotSize: o.lotSize, ltp: q?.ltp ?? null, bid: q?.bid ?? null, ask: q?.ask ?? null, lotCost: q?.ltp ? q.ltp * (p.multiplier ?? o.lotSize) : null } : null;
      }).filter(Boolean) : [];
      const last = this.signals.filter(s => s.product === p.key).at(-1) ?? null;
      const tick = this.quotes.get(p.uKey);
      return { key: p.key, label: p.product.label, kind: p.product.kind, exch: p.underlying.exch, unit: p.product.unit, trade: p.trade, underlying: p.underlying,
        optionExpiry: p.optionExpiry, lotSize: p.multiplier, session: p.product.kind === "INDEX" ? this.config.indexSession : { entryStart: this.config.strategy.entryStart, entryEnd: this.config.strategy.entryEnd, squareOff: this.config.strategy.squareOff },
        price, prevClose: tick?.prevClose ?? null, tickTime: tick?.time ?? null, candles, status: st, open: live, lastSignal: last, options: atm, notes: p.notes,
        action: live ? "IN TRADE" : st.ready ? "WAIT" : "WARMING UP" };
    });
    const day = this.dayStats();
    return { now, feed: { ...this.status, ageSeconds: this.status.lastTick ? Math.round((now - this.status.lastTick) / 1000 / (this.feed.speed || 1)) : null },
      config: { risk: this.config.risk, strategy: this.config.strategy, optionStrike: this.config.optionStrike, telegram: !!this.notifier?.telegram },
      day, products, signals: this.signals.slice(-20).reverse(), closed: this.closed.slice(-50).reverse(), demo: !!this.feed.demo, demoSpeed: this.feed.speed ?? null };
  }
}
