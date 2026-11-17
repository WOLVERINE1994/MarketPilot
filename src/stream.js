const STREAM_URL = "wss://smartapisocket.angelone.in/smart-stream";
const MCX = 5;

/**
 * Parse one SmartAPI WebSocket V2 binary packet (little-endian).
 * Mode 1 = LTP (51 bytes), 2 = Quote (123), 3 = Snap Quote (379, with best-5 depth).
 * Prices arrive in paise.
 */
export function parsePacket(data) {
  const buf = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
  if (!buf || buf.length < 51) return null;
  const mode = buf[0];
  const token = buf.subarray(2, 27).toString("ascii").replace(/\0.*$/s, "");
  const time = Number(buf.readBigInt64LE(35));
  const ltp = Number(buf.readBigInt64LE(43)) / 100;
  if (!/^\d+$/.test(token) || !(ltp > 0) || !(time > 0)) return null;
  const tick = { token, exchange: buf[1], mode, time, ltp };
  if (mode >= 2 && buf.length >= 123) {
    tick.volume = Number(buf.readBigInt64LE(67));
    tick.open = Number(buf.readBigInt64LE(91)) / 100;
    tick.high = Number(buf.readBigInt64LE(99)) / 100;
    tick.low = Number(buf.readBigInt64LE(107)) / 100;
    tick.prevClose = Number(buf.readBigInt64LE(115)) / 100;
  }
  if (mode === 3 && buf.length >= 379) {
    tick.oi = Number(buf.readBigInt64LE(131));
    let bid = null, ask = null;
    for (let off = 147; off < 347; off += 20) {
      const flag = buf.readUInt16LE(off), qty = Number(buf.readBigInt64LE(off + 2)), price = Number(buf.readBigInt64LE(off + 10)) / 100;
      if (!(qty > 0) || !(price > 0)) continue;
      if (flag === 1) { if (bid === null || price > bid) bid = price; } else if (ask === null || price < ask) ask = price;
    }
    tick.bid = bid; tick.ask = ask;
  }
  return tick;
}

/** Reconnecting SmartAPI market-data stream. Calls onTick(tick) for every packet. */
export class SmartStream {
  constructor({ apiKey, clientCode, getFeedToken, onTick, onStatus = () => {}, WebSocketImpl = globalThis.WebSocket }) {
    Object.assign(this, { apiKey, clientCode, getFeedToken, onTick, onStatus, WebSocketImpl });
    this.tokens = new Set(); this.socket = null; this.retry = 0; this.stopped = true; this.lastMessage = 0;
  }

  get connected() { return this.socket?.readyState === 1; }

  start() { this.stopped = false; this.open(); }
  stop() { this.stopped = true; clearInterval(this.ping); clearTimeout(this.reconnect); this.socket?.close(); this.socket = null; }

  subscribe(tokens) {
    const fresh = tokens.filter(t => /^\d+$/.test(t) && !this.tokens.has(t));
    fresh.forEach(t => this.tokens.add(t));
    if (fresh.length && this.connected) this.send(fresh);
  }

  send(tokens) {
    for (let i = 0; i < tokens.length; i += 100) {
      this.socket.send(JSON.stringify({ correlationID: "mpilot", action: 1, params: { mode: 3, tokenList: [{ exchangeType: MCX, tokens: tokens.slice(i, i + 100) }] } }));
    }
  }

  async open() {
    if (this.stopped || this.socket) return;
    if (!this.WebSocketImpl) { this.onStatus("WebSocket not available in this Node.js version (use Node 22+)"); return; }
    let feedToken;
    try { feedToken = await this.getFeedToken(); } catch { return this.later(); }
    const url = new URL(STREAM_URL);
    url.searchParams.set("clientCode", this.clientCode); url.searchParams.set("feedToken", feedToken); url.searchParams.set("apiKey", this.apiKey);
    const ws = new this.WebSocketImpl(url.toString());
    ws.binaryType = "arraybuffer";
    this.socket = ws;
    ws.onopen = () => {
      this.retry = 0; this.onStatus("connected");
      if (this.tokens.size) this.send([...this.tokens]);
      clearInterval(this.ping);
      this.ping = setInterval(() => { if (ws.readyState === 1) ws.send("ping"); }, 25000);
    };
    ws.onmessage = ev => {
      this.lastMessage = Date.now();
      if (typeof ev.data === "string") return; // "pong" or JSON errors
      const tick = parsePacket(ev.data);
      if (tick) this.onTick(tick);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null; clearInterval(this.ping); this.onStatus("disconnected"); this.later();
    };
  }

  later() {
    if (this.stopped) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retry++, 5));
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => this.open(), delay);
  }
}
