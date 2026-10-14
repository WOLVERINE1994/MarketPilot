import type { Position, Settings, Trade } from "./types";
import type { OptionQuote } from "./option-types";
export const costs = (price: number, multiplier: number, s: Settings) => s.brokerage + price * multiplier * s.statutoryBps / 10000;
export const friction = (s: Settings) => s.spread / 2 + s.slippage;
export function fillPrice(price: number, direction: number, tick: number, s: Settings) {
  const ticks = (price + direction * friction(s)) / tick;
  return Number(((direction > 0 ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9)) * tick).toFixed(8));
}
export function optionFill(price: number, direction: number, tick: number, slippage: number) {
  // Spread is already in the observed ask/bid. Never subtract it a second time.
  return Math.max(0, Number(((direction > 0 ? Math.ceil((price + slippage) / tick - 1e-9) : Math.floor((price - slippage) / tick + 1e-9)) * tick).toFixed(8)));
}
export function closePosition(p: Position, marketPrice: number, time: string, reason: string, quote?: OptionQuote): Trade {
  const sign = p.side === "BUY" ? 1 : -1;
  if (p.contract.instrument === "OPTION" && (!quote || quote.contract.symbol !== p.contract.symbol || quote.contract.token !== p.contract.token || p.side !== "BUY")) throw new Error("Cannot value an option without its exact premium quote");
  const exit = p.contract.instrument === "OPTION" ? optionFill(quote!.bid, -1, p.contract.tickSize, p.settings.slippage) : fillPrice(marketPrice, -sign, p.contract.tickSize, p.settings);
  const gross = (exit - p.entry) * sign * p.contract.multiplier;
  const totalCosts = p.entryCosts + costs(exit, p.contract.multiplier, p.settings);
  return { ...p, exit, exitTime: time, gross, costs: totalCosts, net: gross - totalCosts, reason };
}
export const liquidationNet = (p: Position | null, price: number, time: string, quote?: OptionQuote) => p ? closePosition(p, price, time, "mark", quote).net : 0;
