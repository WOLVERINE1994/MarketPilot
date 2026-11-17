import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Desk } from "../src/desk.js";
import { Journal } from "../src/journal.js";
import { Notifier } from "../src/notify.js";
import { readConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import { SmartApiClient } from "../src/smartapi.js";
import { DemoFeed } from "../src/feeds.js";
import { istToMs } from "../src/time.js";

const T0 = istToMs("2026-11-16", "09:15"), FIVE = 300000;
function closes() {
  const out = []; let p = 100;
  for (let i = 0; i < 60; i++) out.push(p += (i % 2 ? 0.2 : -0.2));
  for (let i = 0; i < 10; i++) out.push(p -= 0.35);
  for (let i = 0; i < 25; i++) out.push(p += (i % 3 === 2 ? -0.5 : 0.9));
  return out;
}
const rows = [
  { exch_seg: "MCX", name: "CRUDEOILM", symbol: "CRUDEOILM18DEC26FUT", token: "1", expiry: "18DEC2026", lotsize: "10", tick_size: "100", instrumenttype: "FUTCOM", strike: "-1" },
  ...[99, 100, 101, 102].flatMap((k, i) => ["CE", "PE"].map((t, j) => ({ exch_seg: "MCX", name: "CRUDEOILM", symbol: `CRUDEOILM16DEC26${k}${t}`, token: String(10 + i * 2 + j), expiry: "16DEC2026", lotsize: "10", tick_size: "10", instrumenttype: "OPTFUT", strike: String(k * 100) }))),
];

class FakeFeed {
  constructor(history) { this.t = 0; this.history1m = history; this.premiums = new Map(); this.subs = new Set(); }
  now() { return this.t; }
  async contracts() { return rows; }
  async history() { return this.history1m; }
  subscribe(tokens) { tokens.forEach(t => this.subs.add(t)); }
  async quotes(tokens) { return new Map(tokens.filter(t => this.premiums.has(t)).map(t => [t, { token: t, ...this.premiums.get(t), time: this.t }])); }
}

function setup(extraEnv = {}) {
  const c = closes(), entryIndex = 77; // the candle that produces the BUY (see strategy tests)
  const history = [];
  for (let i = 0; i < entryIndex; i++) for (let m = 0; m < 5; m++) history.push({ time: T0 + i * FIVE + m * 60000, open: c[i] - 0.1, high: c[i] + 0.3, low: c[i] - 0.3, close: c[i], volume: 1 });
  const feed = new FakeFeed(history);
  feed.t = T0 + entryIndex * FIVE + 1000;
  const config = readConfig({ PRODUCTS: "CRUDEOILM", MARKETPILOT_DATA_DIR: mkdtempSync(path.join(tmpdir(), "mp-")), ...extraEnv });
  const sent = [];
  const notifier = new Notifier({}, { log: () => {} });
  notifier.send = async text => { sent.push(text); return true; };
  const desk = new Desk(config, feed, { journal: new Journal(config.dataDir), notifier });
  return { desk, feed, sent, config, price: c[entryIndex], entryIndex };
}

test("desk turns a candle-close signal into a CE plan, alert, paper trade and priced exit", async () => {
  const { desk, feed, sent, price, entryIndex } = setup();
  await desk.start(); desk.stop();
  assert.ok(feed.subs.has("1"), "futures token subscribed");
  feed.premiums.set("14", { ltp: 0.8, bid: 0.75, ask: 0.85 }); // 101 CE (nearest strike to 100.9)
  desk.onTick({ token: "1", ltp: price, time: feed.t, volume: 100 });
  feed.t = T0 + (entryIndex + 1) * FIVE + 10;
  desk.housekeeping();
  await desk.products.get("CRUDEOILM").queue;
  assert.equal(desk.signals.length, 1);
  const sig = desk.signals[0];
  assert.equal(sig.side, "BUY"); assert.equal(sig.plan.kind, "OPTION"); assert.equal(sig.plan.action, "BUY CE");
  assert.equal(sig.plan.symbol, "CRUDEOILM16DEC26101CE"); assert.equal(sig.plan.premium, 0.85);
  assert.match(sent[0], /Crude Oil Mini: BUY CE 101 CE — 1 lot/);
  assert.match(sent[0], /SL .* Target/);
  assert.equal(desk.open.length, 1);
  // Price falls through the stop → exit, priced at the option bid.
  feed.t += 30000;
  desk.onTick({ token: "14", ltp: 0.5, bid: 0.45, ask: 0.55, time: feed.t }); // streamed option quote
  desk.onTick({ token: "1", ltp: sig.futures.stop - 0.5, time: feed.t, volume: 120 });
  await desk.products.get("CRUDEOILM").queue;
  assert.equal(desk.open.length, 0);
  const closed = desk.closed.at(-1);
  assert.equal(closed.reason, "Stop-loss hit");
  assert.equal(closed.pnl, Math.round(((0.45 - 0.85) * 10 - 60) * 100) / 100);
  assert.match(sent.at(-1), /EXIT Crude Oil Mini/);
  // Results survive a restart through the journal.
  const again = new Journal(desk.config.dataDir);
  assert.equal(again.closedTrades().length, 1);
  assert.deepEqual(again.loadOpen(), []);
  const snap = desk.snapshot();
  assert.equal(snap.day.trades, 1); assert.equal(snap.products[0].action, "WAIT");
});

test("futures mode for crude produces a futures plan and futures P&L", async () => {
  const { desk, feed, price, entryIndex } = setup({ CRUDE_TRADE: "FUTURES" });
  await desk.start(); desk.stop();
  desk.onTick({ token: "1", ltp: price, time: feed.t });
  feed.t = T0 + (entryIndex + 1) * FIVE + 10;
  desk.housekeeping();
  await desk.products.get("CRUDEOILM").queue;
  const sig = desk.signals[0];
  assert.equal(sig.plan.action, "BUY FUT");
  assert.equal(sig.alternative.action, "BUY CE");
  feed.t += 60000;
  desk.onTick({ token: "1", ltp: sig.futures.target + 1, time: feed.t });
  await desk.products.get("CRUDEOILM").queue;
  const closed = desk.closed.at(-1);
  assert.equal(closed.reason, "Target hit");
  assert.ok(Math.abs(closed.pnl - ((sig.futures.target + 1 - price) * 10 - 60)) < 0.01);
});

test("dashboard: sign-in page, cookie session, phone-app files, JSON, SSE, CSV and wrong-password limit", async () => {
  const { desk, config } = setup();
  await desk.start(); desk.stop();
  const server = startServer(desk, { port: 0, host: "127.0.0.1", password: "s3cret-pass", dataDir: config.dataDir });
  await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = pw => fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `password=${encodeURIComponent(pw)}` });
  try {
    const home = await fetch(base + "/", { redirect: "manual" });
    assert.equal(home.status, 303); assert.equal(home.headers.get("location"), "/login");
    assert.equal((await fetch(base + "/api/state")).status, 401);
    assert.match(await (await fetch(base + "/login")).text(), /Sign in/);
    for (const f of ["/manifest.webmanifest", "/sw.js", "/icon-192.png", "/icon-512.png", "/offline.html"]) assert.equal((await fetch(base + f)).status, 200, f);
    const manifest = await (await fetch(base + "/manifest.webmanifest")).json();
    assert.equal(manifest.display, "standalone"); assert.equal(manifest.icons.length, 2);

    const bad = await login("nope");
    assert.equal(bad.status, 401); assert.match(await bad.text(), /Wrong password/);
    const ok = await login("s3cret-pass");
    assert.equal(ok.status, 303);
    const cookie = ok.headers.get("set-cookie").split(";")[0];
    assert.match(ok.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    const headers = { Cookie: cookie };
    const page = await fetch(base + "/", { headers });
    assert.equal(page.status, 200); assert.match(await page.text(), /manifest\.webmanifest/);
    const state = await (await fetch(base + "/api/state", { headers })).json();
    assert.equal(state.products[0].key, "CRUDEOILM");
    assert.match(await (await fetch(base + "/api/trades.csv", { headers })).text(), /^date,entry_time/);
    const ctrl = new AbortController();
    const sse = await fetch(base + "/api/events", { headers, signal: ctrl.signal });
    const first = new TextDecoder().decode((await sse.body.getReader().read()).value);
    assert.match(first, /^data: \{/);
    ctrl.abort();
    // Sessions survive a restart (stored hashed on disk), and sign-out ends them.
    assert.ok(!readFileSync(path.join(config.dataDir, "sessions.json"), "utf8").includes(cookie.split("=")[1]));
    await fetch(base + "/logout", { headers, redirect: "manual" });
    assert.equal((await fetch(base + "/api/state", { headers })).status, 401);
    // Brute force: after 10 wrong passwords, even the right one is refused for 15 minutes.
    for (let i = 0; i < 10; i++) await login("wrong" + i);
    assert.equal((await login("s3cret-pass")).status, 429);
  } finally { server.close(); server.closeAllConnections?.(); }
});

test("SmartAPI client logs in with TOTP, re-logs in on an expired token and parses candles", async () => {
  const calls = [];
  let logins = 0, expireOnce = true;
  const fetchImpl = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body, headers: opts?.headers });
    const json = data => ({ ok: true, status: 200, json: async () => data });
    if (url.includes("loginByPassword")) { logins++; return json({ status: true, data: { jwtToken: `jwt${logins}`, feedToken: "feed", refreshToken: "r" } }); }
    if (url.includes("getCandleData")) {
      if (expireOnce) { expireOnce = false; return json({ status: false, errorcode: "AG8001", message: "Invalid Token" }); }
      return json({ status: true, data: [["2026-11-16T09:15:00+05:30", 9100, 9110, 9095, 9105, 50], ["2026-11-16T09:16:00+05:30", 9105, 9120, 9100, 9118, 40]] });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const client = new SmartApiClient({ apiKey: "k", clientCode: "C1", pin: "1234", totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" }, { fetchImpl, dataDir: tmpdir() });
  const candles = await client.candles("1", istToMs("2026-11-16", "09:00"), istToMs("2026-11-16", "10:00"));
  assert.equal(logins, 2); // first login, then again after AG8001
  assert.equal(candles.length, 2); assert.equal(candles[1].close, 9118);
  const login = calls.find(c => c.url.includes("loginByPassword"));
  assert.equal(login.body.clientcode, "C1"); assert.match(login.body.totp, /^\d{6}$/);
  const hist = calls.filter(c => c.url.includes("getCandleData")).at(-1);
  assert.equal(hist.headers.Authorization, "Bearer jwt2");
  assert.deepEqual([hist.body.fromdate, hist.body.todate, hist.body.exchange], ["2026-11-16 09:00", "2026-11-16 10:00", "MCX"]);
  const noCreds = new SmartApiClient({ apiKey: "", clientCode: "", pin: "" }, { fetchImpl, dataDir: tmpdir() });
  await assert.rejects(noCreds.login(), /credentials missing/);
});

test("demo feed produces a working desk with option premiums for both products", async () => {
  const feed = new DemoFeed({ speed: 1 });
  const config = readConfig({ MARKETPILOT_DATA_DIR: mkdtempSync(path.join(tmpdir(), "mp-")) });
  const desk = new Desk(config, feed, { journal: new Journal(config.dataDir), notifier: new Notifier({}, { log: () => {} }) });
  await desk.start(); desk.stop();
  const snap = desk.snapshot();
  assert.deepEqual(snap.products.map(p => p.key), ["CRUDEOILM", "SILVERM"]);
  for (const p of snap.products) { assert.ok(p.status.ready); assert.ok(p.price > 0); }
  const q = await feed.quotes([[...feed.optionMeta.keys()][15]]);
  assert.ok([...q.values()][0].ltp > 0);
});
