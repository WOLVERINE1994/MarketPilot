const MIN = 60000;

/** Group 1-minute candles into N-minute candles aligned to the clock (09:00, 09:05 …). */
export function aggregate(candles, minutes) {
  if (minutes <= 1) return candles.map(c => ({ ...c }));
  const size = minutes * MIN, out = [];
  for (const c of candles) {
    const bucket = Math.floor(c.time / size) * size;
    const last = out.at(-1);
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low);
      last.close = c.close; last.volume += c.volume || 0;
    } else out.push({ time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
  }
  return out;
}

/**
 * Builds candles of `minutes` size from live ticks. `onClose(candle)` fires once
 * per completed candle, when the first tick of the next candle arrives or when
 * `flush(now)` sees that the candle's time is over.
 */
export class CandleBuilder {
  constructor(minutes, { onClose = () => {}, max = 600 } = {}) {
    this.size = minutes * MIN; this.onClose = onClose; this.max = max;
    this.closed = []; this.current = null; this.lastVolume = null;
  }

  /** Seed with historical candles (already aggregated to this size). The last, possibly unfinished one stays open. */
  seed(candles, now = Date.now()) {
    const list = candles.slice(-this.max);
    const last = list.at(-1);
    if (last && last.time + this.size > now) { this.current = { ...last }; list.pop(); }
    this.closed = list.map(c => ({ ...c }));
  }

  tick(price, time, cumulativeVolume) {
    if (!(price > 0) || !Number.isFinite(time)) return;
    this.flush(time);
    const bucket = Math.floor(time / this.size) * this.size;
    let vol = 0;
    if (Number.isFinite(cumulativeVolume)) {
      if (this.lastVolume !== null && cumulativeVolume >= this.lastVolume) vol = cumulativeVolume - this.lastVolume;
      this.lastVolume = cumulativeVolume;
    }
    if (!this.current || this.current.time !== bucket) {
      if (this.current && bucket < this.current.time) return; // late tick for an old candle
      this.current = { time: bucket, open: price, high: price, low: price, close: price, volume: vol };
    } else {
      const c = this.current;
      c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; c.volume += vol;
    }
  }

  /** Close the current candle if its time window is over. */
  flush(now) {
    if (this.current && now >= this.current.time + this.size) {
      const done = this.current;
      this.current = null;
      this.closed.push(done);
      if (this.closed.length > this.max) this.closed.shift();
      this.onClose(done);
    }
  }

  all() { return this.current ? [...this.closed, this.current] : [...this.closed]; }
}
