/** Exponential moving average series (same length as input; seeded with an SMA). */
export function ema(values, length) {
  const out = new Array(values.length).fill(null);
  if (values.length < length) return out;
  const k = 2 / (length + 1);
  let prev = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length - 1] = prev;
  for (let i = length; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

/** Wilder RSI series. */
export function rsi(values, length = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= length) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= length; i++) { const d = values[i] - values[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  gain /= length; loss /= length;
  out[length] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = length + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (length - 1) + Math.max(d, 0)) / length;
    loss = (loss * (length - 1) + Math.max(-d, 0)) / length;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Wilder ATR series. */
export function atr(candles, length = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= length) return out;
  const tr = candles.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))));
  let prev = tr.slice(1, length + 1).reduce((a, b) => a + b, 0) / length;
  out[length] = prev;
  for (let i = length + 1; i < candles.length; i++) { prev = (prev * (length - 1) + tr[i]) / length; out[i] = prev; }
  return out;
}
