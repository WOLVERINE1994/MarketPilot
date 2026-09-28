import { mkdirSync, writeFileSync } from "node:fs";
// Deterministic synthetic scenario: quiet range, trend, reversal, gaps. Not historical performance.
const candles = [];
let price = 5860;
for (let i = 0; i < 220; i++) {
  const open = price;
  const drift = i < 28 ? Math.sin(i * 1.3) * 2 : i < 63 ? 2.6 : i < 83 ? -5.1 : i < 115 ? Math.sin(i) * 4 : i < 155 ? -2.2 : i < 182 ? 4.3 : Math.sin(i * 2) * 3;
  price = Math.round(price + drift + Math.sin(i * 0.72) * 1.6);
  candles.push({ time: new Date(Date.parse("2026-09-14T15:00:00Z") + i * 60000).toISOString(), open, high: Math.max(open, price) + 3 + i % 4, low: Math.min(open, price) - 3 - i % 3, close: price, volume: 30 + i * 17 % 200 });
}
mkdirSync("data/marketpilot", { recursive: true });
writeFileSync("data/marketpilot/replay.json", JSON.stringify({ description: "Synthetic CRUDEOILM training scenario. All contract specifications and prices are DEMO only; never a current tradable contract.", contract: { symbol: "CRUDEOILM-DEMO-SEP26", token: "DEMO", expiry: "2026-09-21", lotSize: 10, multiplier: 10, tickSize: 1, source: "Synthetic fixture — DEMO specifications", verified: true }, candles }, null, 2));
