import type { Position, Settings, Trade } from "./types";
export const costs = (price: number, multiplier: number, s: Settings) => s.brokerage + price * multiplier * s.statutoryBps / 10000;
export const friction = (s: Settings) => s.spread / 2 + s.slippage;
export function fillPrice(price: number, direction: number, tick: number, s: Settings) {
  const ticks = (price + direction * friction(s)) / tick;
  return Number(((direction > 0 ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9)) * tick).toFixed(8));
}
export function closePosition(p: Position, marketPrice: number, time: string, reason: string): Trade {
  const sign = p.side === "BUY" ? 1 : -1;
  const exit = fillPrice(marketPrice, -sign, p.contract.tickSize, p.settings);
  const gross = (exit - p.entry) * sign * p.contract.multiplier;
  const totalCosts = p.entryCosts + costs(exit, p.contract.multiplier, p.settings);
  return { ...p, exit, exitTime: time, gross, costs: totalCosts, net: gross - totalCosts, reason };
}
export const liquidationNet = (p: Position | null, price: number, time: string) => p ? closePosition(p, price, time, "mark").net : 0;
