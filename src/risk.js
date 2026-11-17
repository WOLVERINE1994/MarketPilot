const DELTA = { ATM: 0.5, ITM1: 0.6, OTM1: 0.4 };
const round2 = n => Math.round(n * 100) / 100;
const inr = n => `₹${Math.round(n).toLocaleString("en-IN")}`;
const roundTick = (n, tick) => Math.max(tick, Math.round(Math.round(n / tick) * tick * 100) / 100);

/**
 * Turn a strategy entry into a concrete one-lot plan with rupee risk.
 * Option levels are estimated from the futures stop/target using an assumed
 * delta (ATM ≈ 0.5); real premiums also move with time decay and volatility.
 * Warnings never hide the signal — they tell you what the rules think.
 */
export function planTrade({ product, multiplier = product.multiplier, entry, risk: cfg, moneyness = "ATM", option = null, premium = null, day = { pnl: 0, trades: 0 } }) {
  const stopDist = Math.abs(entry.price - entry.stop);
  const warnings = [];
  let plan;
  if (option) {
    const delta = DELTA[moneyness] ?? 0.5, tick = option.tickSize || 0.05, mult = multiplier;
    if (!(premium > 0)) {
      plan = { kind: "OPTION", action: `BUY ${option.type}`, symbol: option.symbol, token: option.token, exch: option.exch, strike: option.strike, type: option.type, premium: null, lotSize: mult };
      warnings.push("Option premium not received yet — check it in the Angel One app before buying");
    } else {
      const move = delta * stopDist;
      const premiumStop = roundTick(Math.max(tick, premium - move), tick);
      const premiumTarget = roundTick(premium + move * cfg.riskReward, tick);
      const estLoss = round2((premium - premiumStop) * mult + cfg.costPerTrade);
      const estProfit = round2((premiumTarget - premium) * mult - cfg.costPerTrade);
      const outlay = round2(premium * mult);
      plan = { kind: "OPTION", action: `BUY ${option.type}`, symbol: option.symbol, token: option.token, exch: option.exch, strike: option.strike, type: option.type, lotSize: mult,
        premium, premiumStop, premiumTarget, estLoss, estProfit, outlay, delta };
      if (outlay > cfg.capital) warnings.push(`1 lot costs ${inr(outlay)} in premium — more than your capital of ${inr(cfg.capital)}`);
      if (estLoss > cfg.maxLossPerTrade) warnings.push(`Estimated loss at stop ${inr(estLoss)} is above your ${inr(cfg.maxLossPerTrade)} per-trade limit`);
    }
  } else {
    const mult = multiplier;
    const estLoss = round2(stopDist * mult + cfg.costPerTrade);
    const estProfit = round2(stopDist * cfg.riskReward * mult - cfg.costPerTrade);
    plan = { kind: "FUTURES", action: entry.side === "BUY" ? "BUY FUT" : "SELL FUT", estLoss, estProfit };
    if (estLoss > cfg.maxLossPerTrade) warnings.push(`Estimated loss at stop ${inr(estLoss)} is above your ${inr(cfg.maxLossPerTrade)} per-trade limit`);
  }
  if (day.pnl <= -cfg.dailyLossLimit) warnings.push(`Daily loss limit reached (${inr(Math.abs(day.pnl))} lost today) — the rules say stop for today`);
  if (day.trades >= cfg.maxTradesPerDay) warnings.push(`Already ${day.trades} trades today (limit ${cfg.maxTradesPerDay})`);
  return { ...plan, lots: 1, warnings };
}
