import os from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { totp } from "./totp.js";
import { istDay, smartApiDate } from "./time.js";

const BASE = "https://apiconnect.angelone.in";
const MASTER_URL = "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";

export class SmartApiError extends Error {
  constructor(message, code = "") { super(message); this.name = "SmartApiError"; this.code = code; }
}

function detectIdentity() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family === "IPv4" && !nic.internal) return { ip: nic.address, mac: nic.mac };
    }
  }
  return { ip: "127.0.0.1", mac: "00:00:00:00:00:00" };
}

/**
 * Minimal Angel One SmartAPI client: login, instrument master, quotes and
 * historical candles. Market data only — there is deliberately no order API.
 */
export class SmartApiClient {
  constructor(angel, { dataDir, fetchImpl = globalThis.fetch, askTotp } = {}) {
    this.cfg = angel;
    this.dataDir = dataDir;
    this.fetch = fetchImpl;
    this.askTotp = askTotp; // async () => "123456" when no TOTP secret is configured
    this.session = null;    // { jwt, feedToken, refreshToken, day }
    const id = detectIdentity();
    this.localIp = angel.localIp || id.ip;
    this.publicIp = angel.publicIp || id.ip;
    this.mac = angel.mac || id.mac;
  }

  get configured() { return !!(this.cfg.apiKey && this.cfg.clientCode && this.cfg.pin); }

  headers(auth = true) {
    const h = {
      "Content-Type": "application/json", Accept: "application/json",
      "X-UserType": "USER", "X-SourceID": "WEB", "X-PrivateKey": this.cfg.apiKey,
      "X-ClientLocalIP": this.localIp, "X-ClientPublicIP": this.publicIp, "X-MACAddress": this.mac,
    };
    if (auth && this.session) h.Authorization = `Bearer ${this.session.jwt}`;
    return h;
  }

  async login() {
    if (!this.configured) throw new SmartApiError("Angel One credentials missing: set ANGEL_API_KEY, ANGEL_CLIENT_CODE and ANGEL_PIN in .env");
    const code = this.cfg.totpSecret ? totp(this.cfg.totpSecret) : await this.askTotp?.();
    if (!/^\d{6}$/.test(code ?? "")) throw new SmartApiError("A 6-digit TOTP code is required to log in");
    const res = await this.fetch(`${BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
      method: "POST", headers: this.headers(false), signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ clientcode: this.cfg.clientCode, password: this.cfg.pin, totp: code }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.status || !body.data?.jwtToken) throw new SmartApiError(`Angel One login failed: ${body?.message || res.status}`, body?.errorcode);
    this.session = { jwt: body.data.jwtToken, feedToken: body.data.feedToken, refreshToken: body.data.refreshToken, day: istDay(Date.now()) };
    return this.session;
  }

  /** Sessions end daily; log in again on a new IST day. */
  async ensureSession() {
    if (!this.session || this.session.day !== istDay(Date.now())) await this.login();
    return this.session;
  }

  async post(urlPath, payload, { retry = true, timeout = 15000 } = {}) {
    await this.ensureSession();
    const res = await this.fetch(`${BASE}${urlPath}`, { method: "POST", headers: this.headers(), body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout) });
    const body = await res.json().catch(() => null);
    const expired = res.status === 401 || ["AG8001", "AG8002", "AG8003"].includes(body?.errorcode);
    if (expired && retry) { this.session = null; return this.post(urlPath, payload, { retry: false, timeout }); }
    if (!res.ok || !body || body.status === false) throw new SmartApiError(`SmartAPI ${urlPath} failed: ${body?.message || res.status}`, body?.errorcode);
    return body.data;
  }

  /** Instrument rows (futures, options, index rows) for the configured products, cached on disk once per IST day. */
  async instruments(productKeys) {
    const file = path.join(this.dataDir, "instruments.json");
    try {
      const cached = JSON.parse(await readFile(file, "utf8"));
      if (cached.day === istDay(Date.now()) && productKeys.every(k => cached.products.includes(k))) return cached.rows;
    } catch { /* no cache yet */ }
    const res = await this.fetch(MASTER_URL, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new SmartApiError(`Instrument master download failed: ${res.status}`);
    const all = await res.json();
    const rows = all.filter(r => productKeys.includes(r.name) && (["MCX", "NFO", "BFO"].includes(r.exch_seg) || r.instrumenttype === "AMXIDX"));
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(file, JSON.stringify({ day: istDay(Date.now()), products: productKeys, rows }));
    return rows;
  }

  /** FULL quotes (LTP, depth, volume). `instruments` = [{ exch, token }]; result keyed by "EXCH|token". */
  async quotes(instruments) {
    const out = new Map();
    for (let i = 0; i < instruments.length; i += 50) {
      const exchangeTokens = {};
      for (const inst of instruments.slice(i, i + 50)) (exchangeTokens[inst.exch] ??= []).push(inst.token);
      const data = await this.post("/rest/secure/angelbroking/market/v1/quote/", { mode: "FULL", exchangeTokens }, { timeout: 8000 });
      for (const row of data?.fetched ?? []) {
        const bid = row.depth?.buy?.find(l => l.price > 0)?.price ?? null;
        const ask = row.depth?.sell?.find(l => l.price > 0)?.price ?? null;
        const exch = row.exchange, token = String(row.symbolToken);
        out.set(`${exch}|${token}`, { key: `${exch}|${token}`, exch, token, ltp: Number(row.ltp), bid, ask, volume: Number(row.tradeVolume ?? 0), oi: Number(row.opnInterest ?? 0), prevClose: Number(row.close) || null, time: parseFeedTime(row.exchFeedTime) ?? Date.now() });
      }
    }
    return out;
  }

  /**
   * Historical 1-minute candles. SmartAPI allows about 30 days of ONE_MINUTE
   * data per request, so longer ranges are fetched in chunks.
   */
  async candles(inst, fromMs, toMs, interval = "ONE_MINUTE") {
    const chunk = 25 * 86400000, result = [];
    for (let start = fromMs; start < toMs; start += chunk) {
      const end = Math.min(toMs, start + chunk);
      const data = await this.post("/rest/secure/angelbroking/historical/v1/getCandleData", {
        exchange: inst.exch, symboltoken: inst.token, interval, fromdate: smartApiDate(start), todate: smartApiDate(end),
      }, { timeout: 30000 });
      for (const [t, o, h, l, c, v] of data ?? []) result.push({ time: Date.parse(t), open: +o, high: +h, low: +l, close: +c, volume: +v || 0 });
      if (toMs - fromMs > chunk) await new Promise(r => setTimeout(r, 400)); // stay under rate limits
    }
    const seen = new Set();
    return result.filter(c => Number.isFinite(c.time) && !seen.has(c.time) && seen.add(c.time)).sort((a, b) => a.time - b.time);
  }
}

/** "16-Nov-2026 14:05:31" (IST) -> epoch ms. */
export function parseFeedTime(value) {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(String(value ?? ""));
  if (!m) return null;
  const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2].toLowerCase()) + 1;
  if (!month) return null;
  const ms = Date.parse(`${m[3]}-${String(month).padStart(2, "0")}-${m[1]}T${m[4]}+05:30`);
  return Number.isFinite(ms) ? ms : null;
}
