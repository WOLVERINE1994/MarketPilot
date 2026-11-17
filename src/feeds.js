import { SmartStream } from "./stream.js";
import { istDay, istToMs } from "./time.js";

const fromKey = key => { const [exch, token] = key.split("|"); return { exch, token }; };

/** Live Angel One data: REST for setup/history, WebSocket for ticks, REST polling if the stream goes quiet. */
export class AngelFeed {
  constructor(client) {
    this.client = client;
    this.keys = new Set();
    this.stream = new SmartStream({
      apiKey: client.cfg.apiKey, clientCode: client.cfg.clientCode,
      getFeedToken: async () => (await client.ensureSession()).feedToken,
      onTick: tick => this.desk?.onTick(tick),
      onStatus: s => { if (this.desk) this.desk.status.stream = s; },
    });
  }
  now() { return Date.now(); }
  contracts(productKeys) { return this.client.instruments(productKeys); }
  history(inst, from, to) { return this.client.candles(inst, from, to); }
  quotes(instruments) { return this.client.quotes(instruments); }
  subscribe(keys) { keys.forEach(k => this.keys.add(k)); this.stream.subscribe(keys); }

  attach(desk) {
    this.desk = desk;
    this.stream.start();
    // Fallback: if no stream packet for 10 s, poll REST quotes every 3 s.
    this.poll = setInterval(async () => {
      if (Date.now() - this.stream.lastMessage < 10000 || !this.keys.size || this.polling) return;
      this.polling = true;
      try { for (const q of (await this.client.quotes([...this.keys].map(fromKey))).values()) desk.onTick(q); desk.status.stream = "REST polling (stream quiet)"; }
      catch (e) { desk.status.message = `Quote polling failed: ${e.message}`; }
      finally { this.polling = false; }
    }, 3000);
  }
  stop() { clearInterval(this.poll); this.stream.stop(); }
}

// ---------------------------------------------------------------------------
// Demo feed: realistic-looking simulated prices so the dashboard can be tried
// without an Angel One account. Clearly marked DEMO everywhere.
// ---------------------------------------------------------------------------
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const N = x => 0.5 * (1 + erf(x / Math.SQRT2));
export function blackScholes(type, S, K, years, vol) {
  const t = Math.max(years, 1 / 365 / 24), d1 = (Math.log(S / K) + 0.5 * vol * vol * t) / (vol * Math.sqrt(t)), d2 = d1 - vol * Math.sqrt(t);
  return type === "CE" ? S * N(d1) - K * N(d2) : K * N(-d2) - S * N(-d1);
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

// Simulated instruments. Index lot sizes mirror current exchange specs; prices are illustrative.
const DEMO = {
  CRUDEOILM: { kind: "COMMODITY", exch: "MCX", optExch: "MCX", start: 9100, vol: 0.45, strikeStep: 50, lot: 10, token: 900001, tick: 1, optTick: 0.5, expiryDays: 9 },
  SILVERM: { kind: "COMMODITY", exch: "MCX", optExch: "MCX", start: 216000, vol: 0.35, strikeStep: 1000, lot: 5, token: 900101, tick: 1, optTick: 0.5, expiryDays: 9 },
  NIFTY: { kind: "INDEX", exch: "NSE", optExch: "NFO", start: 25400, vol: 0.13, strikeStep: 50, lot: 65, token: 99926000, optToken: 910001, expiryDays: 7 },
  BANKNIFTY: { kind: "INDEX", exch: "NSE", optExch: "NFO", start: 56800, vol: 0.15, strikeStep: 100, lot: 30, token: 99926009, optToken: 910201, expiryDays: 14 },
  FINNIFTY: { kind: "INDEX", exch: "NSE", optExch: "NFO", start: 26900, vol: 0.14, strikeStep: 50, lot: 60, token: 99926037, optToken: 910401, expiryDays: 14 },
  MIDCPNIFTY: { kind: "INDEX", exch: "NSE", optExch: "NFO", start: 13300, vol: 0.17, strikeStep: 25, lot: 120, token: 99926074, optToken: 910601, expiryDays: 14 },
  SENSEX: { kind: "INDEX", exch: "BSE", optExch: "BFO", start: 82300, vol: 0.13, strikeStep: 100, lot: 20, token: 99919000, optToken: 920001, expiryDays: 2 },
  BANKEX: { kind: "INDEX", exch: "BSE", optExch: "BFO", start: 63500, vol: 0.15, strikeStep: 100, lot: 30, token: 99919012, optToken: 920201, expiryDays: 14 },
};
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const master = d => { const [y, m, dd] = d.split("-"); return `${dd}${MONTHS[+m - 1]}${y}`; };

export class DemoFeed {
  /** `speed` simulated seconds per real second. */
  constructor({ speed = 20, seed = 7, startMs } = {}) {
    this.demo = true; this.speed = speed; this.rand = rng(seed);
    this.t0 = startMs ?? istToMs(istDay(Date.now()), "10:00"); this.real0 = Date.now();
    this.state = {}; this.subscribed = new Set(); this.rows = []; this.optionMeta = new Map();
    for (const [name, d] of Object.entries(DEMO)) {
      const key = `${d.exch}|${d.token}`;
      this.state[name] = { price: d.start, regime: 0, volume: 0, key, exch: d.exch, token: String(d.token) };
      const expiry = new Date(this.t0 + d.expiryDays * 86400000).toISOString().slice(0, 10);
      if (d.kind === "INDEX") this.rows.push({ exch_seg: d.exch, name, symbol: `${name} INDEX`, token: String(d.token), expiry: "", lotsize: "1", tick_size: "0", instrumenttype: "AMXIDX", strike: "0" });
      else this.rows.push({ exch_seg: "MCX", name, symbol: `${name}DEMOFUT`, token: String(d.token), expiry: master(new Date(this.t0 + 11 * 86400000).toISOString().slice(0, 10)), lotsize: String(d.lot), tick_size: "100", instrumenttype: "FUTCOM", strike: "-1" });
      let token = d.optToken ?? d.token + 1;
      const center = Math.round(d.start / d.strikeStep) * d.strikeStep;
      for (let k = -20; k <= 20; k++) for (const type of ["CE", "PE"]) {
        const strike = center + k * d.strikeStep, tok = String(token++);
        this.rows.push({ exch_seg: d.optExch, name, symbol: `${name}DEMO${strike}${type}`, token: tok, expiry: master(expiry), lotsize: String(d.lot), tick_size: String((d.optTick ?? 0.05) * 100), instrumenttype: d.kind === "INDEX" ? "OPTIDX" : "OPTFUT", strike: String(strike * 100) });
        this.optionMeta.set(`${d.optExch}|${tok}`, { name, type, strike, expiryMs: Date.parse(`${expiry}T15:30:00+05:30`), vol: d.vol, tick: d.optTick ?? 0.05 });
      }
    }
  }
  now() { return this.t0 + (Date.now() - this.real0) * this.speed; }
  async contracts() { return this.rows; }
  step(name, dtSec) {
    const s = this.state[name], d = DEMO[name];
    if (this.rand() < dtSec / 3600) s.regime = (this.rand() - 0.5) * 2; // new trend roughly every hour
    const sigma = d.vol / Math.sqrt(252 * (d.kind === "INDEX" ? 6.25 : 14.5) * 3600);
    const z = (this.rand() + this.rand() + this.rand() - 1.5) * 2;
    s.price = Math.max(1, s.price * (1 + s.regime * sigma * 0.03 * dtSec + sigma * Math.sqrt(dtSec) * z));
    s.volume += Math.round(this.rand() * 30 * dtSec);
    return s.price;
  }
  async history(inst, from, to) {
    const name = Object.keys(this.state).find(n => this.state[n].key === `${inst.exch}|${inst.token}`);
    if (!name) return [];
    const s = this.state[name], start = s.price, out = [];
    const begin = Math.max(from, to - 2 * 86400000);
    let p = start;
    for (let t = Math.floor(begin / 60000) * 60000; t < Math.floor(to / 60000) * 60000; t += 60000) {
      const o = p; let h = p, l = p;
      for (let i = 0; i < 6; i++) { p = this.step(name, 10); h = Math.max(h, p); l = Math.min(l, p); }
      out.push({ time: t, open: o, high: h, low: l, close: p, volume: 100 });
    }
    const shift = start / p; // end the series at the configured level
    s.price = start;
    return out.map(c => ({ ...c, open: c.open * shift, high: c.high * shift, low: c.low * shift, close: c.close * shift }));
  }
  subscribe(keys) { keys.forEach(k => this.subscribed.add(k)); }
  optionQuote(key, now) {
    const m = this.optionMeta.get(key); if (!m) return null;
    const S = this.state[m.name].price, years = Math.max(0, m.expiryMs - now) / (365 * 86400000);
    const r = v => Math.max(m.tick, Math.round(v / m.tick) * m.tick);
    const ltp = r(Math.max(m.tick, blackScholes(m.type, S, m.strike, years, m.vol))), spread = r(Math.max(m.tick, ltp * 0.004));
    const [exch, token] = key.split("|");
    return { key, exch, token, ltp, bid: r(Math.max(m.tick, ltp - spread / 2)), ask: r(ltp + spread / 2), time: now, volume: 1000, oi: 5000 };
  }
  async quotes(instruments) {
    const now = this.now(), out = new Map();
    for (const inst of instruments) { const q = this.optionQuote(`${inst.exch}|${inst.token}`, now); if (q) out.set(q.key, q); }
    return out;
  }
  attach(desk) {
    this.desk = desk;
    let last = this.now();
    this.timer = setInterval(() => {
      const now = this.now(), dt = (now - last) / 1000; last = now;
      for (const [name, s] of Object.entries(this.state)) {
        const price = this.step(name, dt);
        desk.onTick({ key: s.key, exch: s.exch, token: s.token, ltp: DEMO[name].kind === "INDEX" ? Math.round(price * 20) / 20 : Math.round(price), time: now, volume: s.volume, prevClose: DEMO[name].start });
      }
      for (const k of this.subscribed) { const q = this.optionQuote(k, now); if (q) desk.onTick(q); }
    }, 500);
  }
  stop() { clearInterval(this.timer); }
}
