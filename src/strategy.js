import { ema, rsi, atr } from "./indicators.js";
import { hhmmToMinutes, istDay, istMinutes } from "./time.js";

/**
 * EMA-crossover trend strategy with RSI filter and ATR stop.
 *
 *  BUY  when the fast EMA crosses above the slow EMA (within the last 3 candles),
 *       the trend EMA is rising, price is at least 0.25 ATR above it (chop filter)
 *       and RSI is between 50 and 75.
 *  SELL mirror image (RSI between 25 and 50).
 *  Stop = entry ∓ ATR_STOP × ATR, target = entry ± RISK_REWARD × stop distance.
 *  Stop moves to entry once price has gone BREAKEVEN_AT_R × risk in favour.
 *  Exit on stop, target, opposite crossover, or the square-off time.
 *
 * The same class drives live signals and the backtester, so backtest numbers
 * describe exactly what the live desk would have said.
 */
export class Strategy {
  constructor(cfg) {
    this.cfg = cfg;
    this.size = cfg.timeframe * 60000;
    this.candles = [];
    this.position = null;
    this.tradedCross = null; // index of the crossover already used for an entry
    this.ind = null;
  }

  get warmupNeeded() { return Math.max(this.cfg.emaTrend, this.cfg.emaSlow, this.cfg.rsiLength, this.cfg.atrLength) + 2; }
  get ready() { return this.candles.length >= this.warmupNeeded; }

  /** Load history without generating trades. */
  warm(candles) {
    this.candles = candles.slice(-1000).map(c => ({ ...c }));
    this.compute();
  }

  compute() {
    const closes = this.candles.map(c => c.close), c = this.cfg;
    this.ind = { fast: ema(closes, c.emaFast), slow: ema(closes, c.emaSlow), trend: ema(closes, c.emaTrend), rsi: rsi(closes, c.rsiLength), atr: atr(this.candles, c.atrLength) };
  }

  /** Most recent crossover: { dir: "UP"|"DOWN", index } or null. */
  lastCross() {
    const { fast, slow } = this.ind, n = this.candles.length;
    for (let i = n - 1; i > 0 && i >= n - 30; i--) {
      if (fast[i] == null || slow[i] == null || fast[i - 1] == null || slow[i - 1] == null) break;
      if (fast[i] > slow[i] && fast[i - 1] <= slow[i - 1]) return { dir: "UP", index: i };
      if (fast[i] < slow[i] && fast[i - 1] >= slow[i - 1]) return { dir: "DOWN", index: i };
    }
    return null;
  }

  inWindow(closeTime) {
    const m = istMinutes(closeTime);
    return m >= hhmmToMinutes(this.cfg.entryStart) && m <= hhmmToMinutes(this.cfg.entryEnd);
  }
  pastSquareOff(time) { return istMinutes(time) >= hhmmToMinutes(this.cfg.squareOff); }

  exit(price, time, reason) {
    const p = this.position;
    this.position = null;
    const points = (price - p.entry) * (p.side === "BUY" ? 1 : -1);
    return { type: "EXIT", side: p.side, entry: p.entry, entryTime: p.time, price, time, reason, points, initialRisk: p.risk };
  }

  /** Check stop/target/breakeven against a price range. Used for live ticks and backtest candles. */
  checkLevels(low, high, open, time) {
    const p = this.position;
    if (!p) return [];
    const long = p.side === "BUY";
    // Stop first (conservative when both are touched in the same candle).
    if (long ? low <= p.stop : high >= p.stop) {
      const fill = open !== undefined && (long ? open < p.stop : open > p.stop) ? open : p.stop; // gap through stop
      return [this.exit(fill, time, p.stop === p.entry ? "Breakeven stop hit" : "Stop-loss hit")];
    }
    if (long ? high >= p.target : low <= p.target) {
      const fill = open !== undefined && (long ? open > p.target : open < p.target) ? open : p.target;
      return [this.exit(fill, time, "Target hit")];
    }
    if (this.cfg.breakevenAtR > 0 && p.stop !== p.entry) {
      const trigger = p.entry + (long ? 1 : -1) * p.risk * this.cfg.breakevenAtR;
      if (long ? high >= trigger : low <= trigger) { p.stop = p.entry; return [{ type: "TRAIL", side: p.side, stop: p.stop, time, reason: "Stop moved to entry (breakeven)" }]; }
    }
    return [];
  }

  /** Live tick. */
  onPrice(price, time) {
    if (!this.position) return [];
    if (this.pastSquareOff(time) || istDay(time) !== istDay(this.position.time)) return [this.exit(price, time, "Intraday square-off time")];
    return this.checkLevels(price, price, price, time); // live fills at the actual tick price
  }

  /**
   * A candle has closed. In backtests pass { intrabar: true } so the candle's
   * high/low are checked against stop/target before the close is evaluated.
   */
  onCandle(candle, { intrabar = false } = {}) {
    const events = [];
    const closeTime = candle.time + this.size;
    if (this.position && istDay(candle.time) !== istDay(this.position.time)) events.push(this.exit(candle.open, candle.time, "New day: position closed at open"));
    if (intrabar && this.position) events.push(...this.checkLevels(candle.low, candle.high, candle.open, closeTime));
    this.candles.push({ ...candle });
    if (this.candles.length > 1000) {
      this.candles.shift();
      if (this.tradedCross !== null) this.tradedCross--; // keep the used-crossover index aligned
    }
    this.compute();
    if (!this.ready) return events;
    const i = this.candles.length - 1, { fast, slow, trend, rsi: r, atr: a } = this.ind, price = candle.close;

    if (this.position) {
      const p = this.position;
      const against = p.side === "BUY" ? fast[i] < slow[i] : fast[i] > slow[i];
      if (this.pastSquareOff(closeTime)) events.push(this.exit(price, closeTime, "Intraday square-off time"));
      else if (against) events.push(this.exit(price, closeTime, "Trend reversed (EMA crossover against the trade)"));
      return events;
    }

    const cross = this.lastCross();
    if (!cross || i - cross.index > 2 || this.tradedCross === cross.index) return events;
    if (!this.inWindow(closeTime) || !(a[i] > 0)) return events;
    // Chop filter: the trend EMA must slope the same way and price must be clearly beyond it.
    const slope = trend[i] - trend[i - 5], clear = 0.25 * a[i];
    const long = cross.dir === "UP" && price > trend[i] + clear && slope > 0 && r[i] > 50 && r[i] < 75;
    const short = cross.dir === "DOWN" && price < trend[i] - clear && slope < 0 && r[i] < 50 && r[i] > 25;
    if (!long && !short) return events;
    const side = long ? "BUY" : "SELL", sign = long ? 1 : -1;
    const tick = this.cfg.tick || 0;
    const roundTick = v => (tick > 0 ? Math.round(v / tick) * tick : v);
    const stop = roundTick(price - sign * this.cfg.atrStop * a[i]), risk = Math.abs(price - stop);
    if (!(risk > 0)) return events;
    this.position = { side, entry: price, stop, target: roundTick(price + sign * risk * this.cfg.riskReward), risk, time: closeTime };
    this.tradedCross = cross.index;
    events.push({ type: "ENTRY", side, price, stop: this.position.stop, target: this.position.target, risk, time: closeTime,
      reason: `EMA ${this.cfg.emaFast} crossed ${long ? "above" : "below"} EMA ${this.cfg.emaSlow}; price ${long ? "above" : "below"} EMA ${this.cfg.emaTrend}; RSI ${r[i].toFixed(1)}; ATR ${a[i].toFixed(2)}` });
    return events;
  }

  /** Human-readable view of the current setup for the dashboard. */
  status() {
    if (!this.ind || !this.ready) return { ready: false, trend: "WARMING UP", note: `Loading history: ${this.candles.length}/${this.warmupNeeded} candles` };
    const i = this.candles.length - 1, { fast, slow, trend, rsi: r, atr: a } = this.ind, price = this.candles[i].close;
    const up = fast[i] > slow[i] && price > trend[i], down = fast[i] < slow[i] && price < trend[i];
    const t = up ? "UPTREND" : down ? "DOWNTREND" : "SIDEWAYS";
    let note;
    if (this.position) note = `In ${this.position.side === "BUY" ? "long" : "short"} trade — watching stop and target`;
    else if (up) note = r[i] >= 75 ? "Uptrend but overbought (RSI ≥ 75) — no fresh buy" : "Uptrend — waiting for a fresh EMA crossover to buy";
    else if (down) note = r[i] <= 25 ? "Downtrend but oversold (RSI ≤ 25) — no fresh sell" : "Downtrend — waiting for a fresh EMA crossover to sell";
    else note = "No clear trend — waiting";
    return { ready: true, trend: t, note, emaFast: fast[i], emaSlow: slow[i], emaTrend: trend[i], rsi: r[i], atr: a[i], price };
  }
}
