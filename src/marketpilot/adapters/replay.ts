import { readFileSync } from "node:fs";
import path from "node:path";
import type { Candle, Contract, ContextItem } from "../types";
export type Replay = { description: string; contract: Contract; candles: Candle[] };
export function loadReplay(): Replay {
  const data: Replay = JSON.parse(readFileSync(path.join(process.cwd(), "data/marketpilot/replay.json"), "utf8"));
  if (!data.candles.length || !data.contract.symbol.startsWith("CRUDEOILM") || ![data.contract.multiplier, data.contract.lotSize, data.contract.tickSize].every(n => n > 0)) throw new Error("Invalid replay contract");
  data.candles.forEach((b, i) => {
    if (!Number.isFinite(Date.parse(b.time)) || (i > 0 && b.time <= data.candles[i - 1].time) || ![b.open, b.high, b.low, b.close].every(n => Number.isFinite(n) && n > 0) || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)) throw new Error("Replay chronology/OHLC validation failed");
  });
  return data;
}
export function observed(data: Replay, cursor: number) { return data.candles.slice(0, Math.max(0, Math.min(cursor, data.candles.length))); }
export function replayContext(time: string): ContextItem[] {
  return ["WTI", "Brent", "Oil news"].map(name => ({ name, status: "DEMO", source: "Synthetic replay fixture — not historical market data", time, bias: "NEUTRAL", block: false, ...(name === "Oil news" ? { headline: "Demo: no simulated event blocker in this scenario" } : { value: name === "WTI" ? 68.24 : 72.16 }) }));
}
