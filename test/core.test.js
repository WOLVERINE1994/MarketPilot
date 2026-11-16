import { test } from "node:test";
import assert from "node:assert/strict";
import { totp, base32Decode } from "../src/totp.js";
import { parsePacket } from "../src/stream.js";
import { aggregate, CandleBuilder } from "../src/candles.js";
import { ema, rsi, atr } from "../src/indicators.js";
import { parseExpiry, istDay, istClock, istToMs } from "../src/time.js";
import { parseFeedTime } from "../src/smartapi.js";
import { selectContracts, pickOption, nearbyOptions } from "../src/contracts.js";
import { planTrade } from "../src/risk.js";
import { PRODUCTS, readConfig } from "../src/config.js";

test("TOTP matches the RFC 6238 SHA-1 test vectors", () => {
  const key = Buffer.from("12345678901234567890");
  assert.equal(totp(null, 59000, { key, digits: 8 }), "94287082");
  assert.equal(totp(null, 1111111109000, { key, digits: 8 }), "07081804");
  assert.equal(totp(null, 2000000000000, { key, digits: 8 }), "69279037");
  assert.deepEqual(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"), key);
  assert.equal(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59000), "287082");
  assert.throws(() => base32Decode("not-base32!"));
});

function packet({ mode = 3, token = "449534", time = 1794800000000, ltp = 9123.45, volume = 1500, bid = 9123, ask = 9124 }) {
  const buf = Buffer.alloc(mode === 3 ? 379 : mode === 2 ? 123 : 51);
  buf[0] = mode; buf[1] = 5; buf.write(token, 2, "ascii");
  buf.writeBigInt64LE(BigInt(time), 35); buf.writeBigInt64LE(BigInt(Math.round(ltp * 100)), 43);
  if (mode >= 2) { buf.writeBigInt64LE(BigInt(volume), 67); buf.writeBigInt64LE(910000n, 115); }
  if (mode === 3) {
    buf.writeUInt16LE(1, 147); buf.writeBigInt64LE(10n, 149); buf.writeBigInt64LE(BigInt(bid * 100), 157);
    buf.writeUInt16LE(0, 247); buf.writeBigInt64LE(20n, 249); buf.writeBigInt64LE(BigInt(ask * 100), 257);
  }
  return buf;
}

test("parses SmartAPI V2 LTP and Snap Quote packets (paise → rupees)", () => {
  const snap = parsePacket(packet({}));
  assert.equal(snap.token, "449534"); assert.equal(snap.ltp, 9123.45); assert.equal(snap.time, 1794800000000);
  assert.equal(snap.volume, 1500); assert.equal(snap.bid, 9123); assert.equal(snap.ask, 9124); assert.equal(snap.prevClose, 9100);
  const ltp = parsePacket(packet({ mode: 1 }).buffer.slice(0, 51));
  assert.equal(ltp.ltp, 9123.45); assert.equal(ltp.bid, undefined);
  assert.equal(parsePacket(Buffer.alloc(10)), null);
  assert.equal(parsePacket(packet({ ltp: 0 })), null);
});

test("aggregates 1-minute candles into clock-aligned 5-minute candles", () => {
  const t0 = istToMs("2026-11-16", "10:00");
  const ones = Array.from({ length: 10 }, (_, i) => ({ time: t0 + i * 60000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1 }));
  const fives = aggregate(ones, 5);
  assert.equal(fives.length, 2);
  assert.deepEqual(fives[0], { time: t0, open: 100, high: 105, low: 99, close: 104.5, volume: 5 });
  assert.equal(istClock(fives[1].time), "10:05");
});

test("candle builder closes candles on time and computes volume from cumulative volume", () => {
  const closed = [], t0 = istToMs("2026-11-16", "10:00");
  const b = new CandleBuilder(5, { onClose: c => closed.push(c) });
  b.tick(100, t0 + 1000, 1000); b.tick(103, t0 + 60000, 1010); b.tick(98, t0 + 120000, 1030);
  assert.equal(closed.length, 0);
  b.flush(t0 + 5 * 60000);
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0], { time: t0, open: 100, high: 103, low: 98, close: 98, volume: 30 });
  b.tick(99, t0 + 5 * 60000 + 500, 1040);
  assert.equal(b.all().length, 2);
});

test("indicators: EMA, RSI and ATR behave as expected", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const e = ema(up, 5);
  assert.equal(e[3], null); assert.equal(e[4], 102); assert.ok(e[29] < 129 && e[29] > 125);
  assert.equal(rsi(up, 14)[29], 100);
  const zig = Array.from({ length: 30 }, (_, i) => (i % 2 ? 101 : 100));
  assert.ok(Math.abs(rsi(zig, 14)[29] - 50) < 5);
  const candles = up.map(c => ({ open: c, high: c + 2, low: c - 2, close: c }));
  assert.ok(Math.abs(atr(candles, 14)[29] - 4) < 1e-9);
});

test("time helpers and SmartAPI timestamps use IST", () => {
  assert.equal(parseExpiry("19NOV2026"), "2026-11-19");
  assert.equal(parseExpiry("bad"), null);
  const ms = parseFeedTime("16-Nov-2026 14:05:31");
  assert.equal(istDay(ms), "2026-11-16"); assert.equal(istClock(ms), "14:05");
  assert.equal(parseFeedTime("garbage"), null);
});

const masterRows = [
  { exch_seg: "MCX", name: "SILVERM", symbol: "SILVERM27NOV26FUT", token: "100", expiry: "27NOV2026", lotsize: "5", tick_size: "100.000000", instrumenttype: "FUTCOM", strike: "-1.000000" },
  { exch_seg: "MCX", name: "SILVERM", symbol: "SILVERM26FEB27FUT", token: "101", expiry: "26FEB2027", lotsize: "5", tick_size: "100.000000", instrumenttype: "FUTCOM", strike: "-1.000000" },
  ...[214000, 215000, 216000, 217000, 218000].flatMap((k, i) => ["CE", "PE"].map((t, j) => ({ exch_seg: "MCX", name: "SILVERM", symbol: `SILVERM24NOV26${k}${t}`, token: String(200 + i * 2 + j), expiry: "24NOV2026", lotsize: "5", tick_size: "50.000000", instrumenttype: "OPTFUT", strike: `${k * 100}.000000` }))),
  { exch_seg: "MCX", name: "SILVERM", symbol: "SILVERM16NOV26216000CE", token: "300", expiry: "16NOV2026", lotsize: "5", tick_size: "50.000000", instrumenttype: "OPTFUT", strike: "21600000.000000" },
  { exch_seg: "MCX", name: "SILVER", symbol: "SILVER04DEC26FUT", token: "400", expiry: "04DEC2026", lotsize: "30", tick_size: "100", instrumenttype: "FUTCOM", strike: "-1" },
];

test("selects the nearest non-expiring option chain and the future it settles into", () => {
  const sel = selectContracts(masterRows, PRODUCTS.SILVERM, "2026-11-16");
  assert.equal(sel.optionExpiry, "2026-11-24"); // expiry-day chain (16 Nov) skipped
  assert.equal(sel.future.symbol, "SILVERM27NOV26FUT");
  assert.equal(sel.chain.length, 10);
  assert.equal(sel.chain[0].strike, 214000); assert.equal(sel.chain[0].tickSize, 0.5); assert.equal(sel.future.tickSize, 1);
  assert.equal(pickOption(sel.chain, 216300, "BUY").symbol, "SILVERM24NOV26216000CE");
  assert.equal(pickOption(sel.chain, 216300, "SELL").symbol, "SILVERM24NOV26216000PE");
  assert.equal(pickOption(sel.chain, 216300, "BUY", "ITM1").strike, 215000);
  assert.equal(pickOption(sel.chain, 216300, "SELL", "ITM1").strike, 217000);
  assert.equal(pickOption(sel.chain, 216300, "BUY", "OTM1").strike, 217000);
  assert.equal(nearbyOptions(sel.chain, 216300, 1).length, 6);
  assert.equal(selectContracts(masterRows, PRODUCTS.CRUDEOILM, "2026-11-16").future, null);
});

test("trade plan estimates option stop/target from futures levels and warns without blocking", () => {
  const cfg = { ...readConfig({}).risk, riskReward: 2 };
  const entry = { side: "BUY", price: 216000, stop: 215000, target: 218000 };
  const option = { symbol: "SILVERM24NOV26216000CE", token: "204", strike: 216000, type: "CE", tickSize: 0.5 };
  const plan = planTrade({ product: PRODUCTS.SILVERM, entry, risk: cfg, option, premium: 4800 });
  assert.equal(plan.action, "BUY CE"); assert.equal(plan.premiumStop, 4300); assert.equal(plan.premiumTarget, 5800);
  assert.equal(plan.outlay, 24000); assert.equal(plan.estLoss, 2500 + cfg.costPerTrade);
  assert.ok(plan.warnings.some(w => w.includes("per-trade limit")));
  const fut = planTrade({ product: PRODUCTS.CRUDEOILM, entry: { side: "SELL", price: 9200, stop: 9240, target: 9120 }, risk: cfg, day: { pnl: -1600, trades: 1 } });
  assert.equal(fut.action, "SELL FUT"); assert.equal(fut.estLoss, 400 + cfg.costPerTrade); assert.equal(fut.estProfit, 800 - cfg.costPerTrade);
  assert.ok(fut.warnings.some(w => w.includes("Daily loss limit")));
  const noPremium = planTrade({ product: PRODUCTS.SILVERM, entry, risk: cfg, option });
  assert.ok(noPremium.warnings[0].includes("premium not received"));
});
