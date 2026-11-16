import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { loadEnv, readConfig, PRODUCTS } from "./config.js";
import { SmartApiClient } from "./smartapi.js";
import { selectContracts, parseInstruments } from "./contracts.js";
import { backtest } from "./backtest.js";
import { istDay, istClock } from "./time.js";

// Usage:
//   npm run backtest -- --product CRUDEOILM --days 60
//   npm run backtest -- --product SILVERM --csv my-1min-data.csv
// CSV columns: time,open,high,low,close[,volume]  (time as ISO or "YYYY-MM-DD HH:MM" IST)
const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
loadEnv();
const config = readConfig();
const productKey = (opt("product") || "CRUDEOILM").toUpperCase();
const product = PRODUCTS[productKey];
if (!product) { console.error(`Unknown product ${productKey}. Use CRUDEOILM or SILVERM.`); process.exit(1); }
const mode = (opt("mode") || (productKey === "CRUDEOILM" ? config.crudeTrade : "OPTIONS")).toUpperCase();

function readCsv(file) {
  return readFileSync(file, "utf8").split(/\r?\n/).slice(1).filter(Boolean).map(line => {
    const [t, o, h, l, c, v] = line.split(",").map(s => s.trim().replace(/^"|"$/g, ""));
    const time = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t) ? Date.parse(`${t.replace(" ", "T").slice(0, 16)}:00+05:30`) : Date.parse(t);
    return { time, open: +o, high: +h, low: +l, close: +c, volume: +v || 0 };
  }).filter(c => Number.isFinite(c.time) && c.close > 0).sort((a, b) => a.time - b.time);
}

async function fromAngel(days) {
  const client = new SmartApiClient(config.angel, { dataDir: config.dataDir, askTotp: async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question("Angel One TOTP code: ")).trim(); } finally { rl.close(); }
  } });
  await client.login();
  const rows = await client.instruments([productKey]);
  const { futures } = parseInstruments(rows, productKey);
  const { future } = selectContracts(rows, product, istDay(Date.now()));
  // Use the two nearest futures contracts and keep, for each minute, the nearer one's data.
  const contracts = futures.filter(f => f.expiry >= istDay(Date.now())).slice(0, 2);
  if (!contracts.length && future) contracts.push(future);
  const to = Date.now(), from = to - days * 86400000;
  const seen = new Map();
  for (const f of contracts.reverse()) {
    console.log(`Downloading ${f.symbol} 1-minute candles…`);
    for (const c of await client.candles(f.token, from, to)) seen.set(c.time, c);
  }
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

const days = Number(opt("days") || 60);
const candles = opt("csv") ? readCsv(opt("csv")) : await fromAngel(days);
if (!candles.length) { console.error("No candles to test."); process.exit(1); }
const { trades, stats } = backtest(candles, { strategy: config.strategy, risk: config.risk, product, mode });
const money = n => (n == null ? "—" : `${n < 0 ? "-" : ""}₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`);
console.log(`\n=== Backtest: ${product.label} · ${mode} · ${config.strategy.timeframe}m candles · ${istDay(candles[0].time)} → ${istDay(candles.at(-1).time)} ===`);
console.log(`Trades ${stats.trades} | Win rate ${stats.winRate ?? "—"}% | Net ${money(stats.net)} after ₹${config.risk.costPerTrade}/trade costs`);
console.log(`Avg win ${money(stats.avgWin)} | Avg loss ${money(stats.avgLoss)} | Profit factor ${stats.profitFactor ?? "—"} | Per trade ${money(stats.expectancy)}`);
console.log(`Max drawdown ${money(stats.maxDrawdown)} | Worst losing streak ${stats.worstLosingStreak} | Green days ${stats.greenDays}/${stats.daysWithTrades} | Best day ${money(stats.bestDay)} | Worst day ${money(stats.worstDay)}`);
if (mode === "OPTIONS") console.log("Note: option results are estimated from futures moves × delta 0.5 and ignore time decay — expect real results to be somewhat worse.");
console.log("Past results do not guarantee future results.\n");
mkdirSync(config.dataDir, { recursive: true });
const out = path.join(config.dataDir, `backtest-${productKey}.csv`);
writeFileSync(out, ["date,entry,exit,side,entry_price,exit_price,points,pnl,reason", ...trades.map(t => [istDay(t.entryTime), istClock(t.entryTime), istClock(t.exitTime), t.side, t.entry, t.exit.toFixed(2), t.points.toFixed(2), t.pnl, `"${t.reason}"`].join(","))].join("\n"));
console.log(`Trade list saved to ${out}`);
