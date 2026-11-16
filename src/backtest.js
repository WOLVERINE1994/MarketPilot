import { aggregate } from "./candles.js";
import { Strategy } from "./strategy.js";
import { istDay } from "./time.js";

/**
 * Replay the live strategy over historical 1-minute candles.
 * Futures P&L is exact in points. Option P&L is an ESTIMATE: futures points ×
 * delta (ATM ≈ 0.5), ignoring time decay and volatility changes, so real option
 * results are usually somewhat worse than shown.
 */
export function backtest(candles1m, { strategy, risk, product, mode = "OPTIONS", delta = 0.5 }) {
  const candles = aggregate(candles1m, strategy.timeframe);
  const s = new Strategy(strategy);
  const trades = [];
  for (const c of candles) {
    for (const ev of s.onCandle(c, { intrabar: true })) {
      if (ev.type !== "EXIT") continue;
      const factor = mode === "OPTIONS" ? delta : 1;
      const pnl = ev.points * factor * product.multiplier - risk.costPerTrade;
      trades.push({ side: ev.side, entryTime: ev.entryTime, exitTime: ev.time, entry: ev.entry, exit: ev.price, points: ev.points, reason: ev.reason, pnl: Math.round(pnl * 100) / 100 });
    }
  }
  return { trades, stats: stats(trades, candles), candles: candles.length };
}

export function stats(trades, candles = []) {
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const net = trades.reduce((a, t) => a + t.pnl, 0);
  let peak = 0, equity = 0, maxDrawdown = 0, streak = 0, worstStreak = 0;
  for (const t of trades) {
    equity += t.pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity);
    streak = t.pnl <= 0 ? streak + 1 : 0; worstStreak = Math.max(worstStreak, streak);
  }
  const byDay = new Map();
  for (const t of trades) byDay.set(istDay(t.exitTime), (byDay.get(istDay(t.exitTime)) ?? 0) + t.pnl);
  const days = [...byDay.values()];
  const tradingDays = new Set(candles.map(c => istDay(c.time))).size || byDay.size;
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const r = n => Math.round(n * 100) / 100;
  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length ? r((wins.length / trades.length) * 100) : null,
    net: r(net), avgWin: wins.length ? r(grossWin / wins.length) : null, avgLoss: losses.length ? r(-grossLoss / losses.length) : null,
    profitFactor: grossLoss > 0 ? r(grossWin / grossLoss) : null, expectancy: trades.length ? r(net / trades.length) : null,
    maxDrawdown: r(maxDrawdown), worstLosingStreak: worstStreak,
    tradingDays, daysWithTrades: byDay.size, greenDays: days.filter(d => d > 0).length, redDays: days.filter(d => d <= 0).length,
    bestDay: days.length ? r(Math.max(...days)) : null, worstDay: days.length ? r(Math.min(...days)) : null,
  };
}
