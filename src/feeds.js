import { SmartStream } from "./stream.js";
import { istDay, istToMs } from "./time.js";

/** Live Angel One data: REST for setup/history, WebSocket for ticks, REST polling if the stream goes quiet. */
export class AngelFeed {
  constructor(client) {
    this.client = client;
    this.tokens = new Set();
    this.stream = new SmartStream({
      apiKey: client.cfg.apiKey, clientCode: client.cfg.clientCode,
      getFeedToken: async () => (await client.ensureSession()).feedToken,
      onTick: tick => this.desk?.onTick(tick),
      onStatus: s => { if (this.desk) this.desk.status.stream = s; },
    });
  }
  now() { return Date.now(); }
  contracts(keys) { return this.client.instruments(keys); }
  history(token, from, to) { return this.client.candles(token, from, to); }
  quotes(tokens) { return this.client.quotes(tokens); }
  subscribe(tokens) { tokens.forEach(t => this.tokens.add(t)); this.stream.subscribe(tokens); }

  attach(desk) {
    this.desk = desk;
    this.stream.start();
    // Fallback: if no stream packet for 10 s, poll REST quotes every 3 s.
    this.poll = setInterval(async () => {
      if (Date.now() - this.stream.lastMessage < 10000 || !this.tokens.size || this.polling) return;
      this.polling = true;
      try { for (const q of (await this.client.quotes([...this.tokens])).values()) desk.onTick(q); desk.status.stream = "REST polling (stream quiet)"; }
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

const DEMO = {
  CRUDEOILM: { start: 9100, vol: 0.45, strikeStep: 50, tick: 1, lot: 10, token: 900001 },
  SILVERM: { start: 216000, vol: 0.35, strikeStep: 1000, tick: 1, lot: 5, token: 900101 },
};

export class DemoFeed {
  /** `speed` simulated seconds per real second. */
  constructor({ speed = 20, seed = 7, startMs } = {}) {
    this.demo = true; this.speed = speed; this.rand = rng(seed);
    const today = istDay(Date.now());
    this.t0 = startMs ?? istToMs(today, "10:00"); this.real0 = Date.now();
    this.state = {}; this.subscribed = new Set(); this.rows = []; this.optionMeta = new Map();
    const expiry = new Date(this.t0 + 9 * 86400000).toISOString().slice(0, 10);
    const futExpiry = new Date(this.t0 + 11 * 86400000).toISOString().slice(0, 10);
    const master = d => { const [y, m, dd] = d.split("-"); return `${dd}${["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][+m - 1]}${y}`; };
    for (const [name, d] of Object.entries(DEMO)) {
      this.state[name] = { price: d.start, drift: 0, regime: 0, volume: 0, token: String(d.token) };
      this.rows.push({ exch_seg: "MCX", name, symbol: `${name}DEMOFUT`, token: String(d.token), expiry: master(futExpiry), lotsize: String(d.lot), tick_size: String(d.tick * 100), instrumenttype: "FUTCOM", strike: "-1" });
      let token = d.token + 1;
      const center = Math.round(d.start / d.strikeStep) * d.strikeStep;
      for (let k = -15; k <= 15; k++) for (const type of ["CE", "PE"]) {
        const strike = center + k * d.strikeStep, tok = String(token++);
        this.rows.push({ exch_seg: "MCX", name, symbol: `${name}DEMO${strike}${type}`, token: tok, expiry: master(expiry), lotsize: String(d.lot), tick_size: "50", instrumenttype: "OPTFUT", strike: String(strike * 100) });
        this.optionMeta.set(tok, { name, type, strike, expiryMs: Date.parse(`${expiry}T23:30:00+05:30`), vol: d.vol });
      }
    }
  }
  now() { return this.t0 + (Date.now() - this.real0) * this.speed; }
  async contracts() { return this.rows; }
  step(name, dtSec) {
    const s = this.state[name], d = DEMO[Object.keys(DEMO).find(k => k === name)];
    if (this.rand() < dtSec / 3600) s.regime = (this.rand() - 0.5) * 2; // new trend every ~hour
    const sigma = d.vol / Math.sqrt(252 * 14.5 * 3600);
    const z = (this.rand() + this.rand() + this.rand() - 1.5) * 2;
    s.price = Math.max(1, s.price * (1 + s.regime * sigma * 0.03 * dtSec + sigma * Math.sqrt(dtSec) * z));
    s.volume += Math.round(this.rand() * 30 * dtSec);
    return s.price;
  }
  async history(token, from, to) {
    const name = Object.keys(this.state).find(n => this.state[n].token === token);
    const out = [];
    const s = this.state[name], start = s.price;
    // Walk forward from 2 days ago so history ends near the current price.
    const begin = Math.max(from, to - 2 * 86400000);
    let p = start;
    for (let t = Math.floor(begin / 60000) * 60000; t < Math.floor(to / 60000) * 60000; t += 60000) {
      const o = p; let h = p, l = p;
      for (let i = 0; i < 6; i++) { p = this.step(name, 10); h = Math.max(h, p); l = Math.min(l, p); }
      out.push({ time: t, open: o, high: h, low: l, close: p, volume: 100 });
    }
    // Shift so the series ends at the configured start level.
    const shift = start / p;
    s.price = start;
    return out.map(c => ({ ...c, open: c.open * shift, high: c.high * shift, low: c.low * shift, close: c.close * shift }));
  }
  subscribe(tokens) { tokens.forEach(t => this.subscribed.add(t)); }
  optionQuote(token, now) {
    const m = this.optionMeta.get(token); if (!m) return null;
    const S = this.state[m.name].price, years = Math.max(0, m.expiryMs - now) / (365 * 86400000);
    const fair = Math.max(0.5, blackScholes(m.type, S, m.strike, years, m.vol));
    const ltp = Math.round(fair * 2) / 2, spread = Math.max(0.5, Math.round(ltp * 0.004 * 2) / 2);
    return { token, ltp, bid: Math.max(0.5, ltp - spread / 2), ask: ltp + spread / 2, time: now, volume: 1000, oi: 5000 };
  }
  async quotes(tokens) {
    const now = this.now(), out = new Map();
    for (const t of tokens) { const q = this.optionQuote(t, now); if (q) out.set(t, q); }
    return out;
  }
  attach(desk) {
    this.desk = desk;
    let last = this.now();
    this.timer = setInterval(() => {
      const now = this.now(), dt = (now - last) / 1000; last = now;
      for (const [name, s] of Object.entries(this.state)) {
        const price = this.step(name, dt);
        desk.onTick({ token: s.token, ltp: Math.round(price), time: now, volume: s.volume, prevClose: DEMO[name].start });
      }
      for (const t of this.subscribed) { const q = this.optionQuote(t, now); if (q) desk.onTick(q); }
    }, 500);
  }
  stop() { clearInterval(this.timer); }
}
