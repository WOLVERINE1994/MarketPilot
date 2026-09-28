import type { Day, Settings } from "./types";
export function riskBlock(s: Settings, day: Day, equity: number): string[] {
  const reasons: string[] = [];
  if (s.paused) reasons.push("Manual pause is active");
  if (day.locked || equity <= -s.dailyLoss) reasons.push("Daily loss/profit-protection lockout is active until the next IST day");
  if (day.trades >= s.maxTrades) reasons.push("Maximum trades for this IST day reached");
  return reasons;
}
export function updateLock(day: Day, equity: number, s: Settings) {
  day.peak = Math.max(day.peak, equity);
  if (equity <= -s.dailyLoss || (s.profitTrigger > 0 && day.peak >= s.profitTrigger && day.peak - equity >= s.profitGiveback)) day.locked = true;
}
