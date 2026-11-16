import { test } from "node:test";
import assert from "node:assert/strict";
import { Strategy } from "../src/strategy.js";
import { backtest, stats } from "../src/backtest.js";
import { readConfig, PRODUCTS } from "../src/config.js";
import { istToMs } from "../src/time.js";

const cfg = readConfig({}).strategy; // defaults: 5m, EMA 9/21/50, RSI 14, ATR 14, 1.5 ATR stop, 2R
const T0 = istToMs("2026-11-16", "09:15");
const step = 5 * 60000;

/** Flat chop (no trades), a dip (one SELL), then a choppy rise (SELL reversed, then BUY). */
function series() {
  const closes = [];
  let p = 100;
  for (let i = 0; i < 60; i++) closes.push(p += (i % 2 ? 0.2 : -0.2));
  for (let i = 0; i < 10; i++) closes.push(p -= 0.35);
  for (let i = 0; i < 25; i++) closes.push(p += (i % 3 === 2 ? -0.5 : 0.9));
  return closes.map((c, i) => ({ time: T0 + i * step, open: c - 0.1, high: c + 0.3, low: c - 0.3, close: c, volume: 10 }));
}

test("strategy buys on a fresh EMA crossover in the trend direction with an ATR stop and 2R target", () => {
  const s = new Strategy(cfg);
  const entries = [];
  for (const c of series()) entries.push(...s.onCandle(c).filter(e => e.type === "ENTRY"));
  assert.deepEqual(entries.map(x => x.side), ["SELL", "BUY"]); // the flat chop part produced no trades
  const e = entries[1];
  assert.equal(e.side, "BUY");
  assert.ok(e.stop < e.price && e.target > e.price);
  assert.ok(Math.abs((e.target - e.price) - 2 * (e.price - e.stop)) < 1e-9);
  assert.match(e.reason, /EMA 9 crossed above EMA 21/);
  assert.equal(s.status().note, "In long trade — watching stop and target");
  // A live tick through the stop closes the trade at the stop.
  const [exit] = s.onPrice(e.stop - 1, e.time + 60000);
  assert.equal(exit.type, "EXIT"); assert.equal(exit.reason, "Stop-loss hit");
  assert.ok(Math.abs(exit.points + (e.price - e.stop) + 1) < 1e-9);
  assert.equal(s.position, null);
});

test("breakeven trail, target exit and square-off", () => {
  const s = new Strategy(cfg);
  for (const c of series()) s.onCandle(c);
  const p = s.position;
  assert.ok(p, "expected an open position");
  const [trail] = s.onPrice(p.entry + p.risk * 1.01, p.time + 60000);
  assert.equal(trail.type, "TRAIL"); assert.equal(s.position.stop, p.entry);
  const [be] = s.onPrice(p.entry, p.time + 120000);
  assert.equal(be.reason, "Breakeven stop hit"); assert.equal(be.points, 0);

  const s2 = new Strategy(cfg);
  for (const c of series()) s2.onCandle(c);
  const [hit] = s2.onPrice(s2.position.target + 0.5, s2.position.time + 60000);
  assert.equal(hit.reason, "Target hit");

  const s3 = new Strategy(cfg);
  for (const c of series()) s3.onCandle(c);
  const [sq] = s3.onPrice(s3.position.entry, istToMs("2026-11-16", "23:16"));
  assert.equal(sq.reason, "Intraday square-off time");
});

test("no entries outside the entry window", () => {
  const late = { ...cfg, entryStart: "09:00", entryEnd: "09:30" };
  const s = new Strategy(late);
  for (const c of series()) assert.equal(s.onCandle(c).filter(e => e.type === "ENTRY").length, 0);
});

test("backtest replays the same strategy with intrabar stop-first fills and reports honest stats", () => {
  const ones = [];
  for (const c of series()) for (let m = 0; m < 5; m++) ones.push({ ...c, time: c.time + m * 60000 });
  const product = PRODUCTS.CRUDEOILM, risk = { costPerTrade: 60 };
  const fut = backtest(ones, { strategy: cfg, risk, product, mode: "FUTURES" });
  const opt = backtest(ones, { strategy: cfg, risk, product, mode: "OPTIONS" });
  assert.ok(fut.trades.length >= 1);
  const t = fut.trades[0];
  assert.equal(t.pnl, Math.round((t.points * 10 - 60) * 100) / 100);
  assert.equal(opt.trades[0].pnl, Math.round((t.points * 0.5 * 10 - 60) * 100) / 100);
  const st = stats([{ pnl: 100, exitTime: T0 }, { pnl: -50, exitTime: T0 }, { pnl: -50, exitTime: T0 + 86400000 }, { pnl: 200, exitTime: T0 + 86400000 }]);
  assert.deepEqual([st.trades, st.winRate, st.net, st.profitFactor, st.maxDrawdown, st.worstLosingStreak, st.greenDays, st.redDays], [4, 50, 200, 3, 100, 2, 2, 0]);
});
