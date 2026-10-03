import type { Trade } from "./types";

/** Descriptive closed-paper results only; no inferred profitability or edge. */
export function paperPerformance(trades: Trade[]) {
  const wins = trades.filter(trade => trade.net > 0), losses = trades.filter(trade => trade.net < 0);
  const positiveNet = wins.reduce((sum, trade) => sum + trade.net, 0);
  const negativeNet = losses.reduce((sum, trade) => sum + trade.net, 0);
  const net = trades.reduce((sum, trade) => sum + trade.net, 0);
  return {
    closedTrades: trades.length, winningTrades: wins.length, losingTrades: losses.length,
    flatTrades: trades.length - wins.length - losses.length,
    net, totalCharges: trades.reduce((sum, trade) => sum + trade.costs, 0),
    winRate: trades.length ? wins.length / trades.length : null,
    expectancy: trades.length ? net / trades.length : null,
    averageWin: wins.length ? positiveNet / wins.length : null,
    averageLoss: losses.length ? negativeNet / losses.length : null,
    profitFactor: losses.length ? positiveNet / Math.abs(negativeNet) : null,
    worstTrade: trades.length ? Math.min(...trades.map(trade => trade.net)) : null,
    evidence: "Descriptive paper results after estimated charges and fill friction; no validated trading edge. No-loss samples have an undefined profit factor.",
  };
}
