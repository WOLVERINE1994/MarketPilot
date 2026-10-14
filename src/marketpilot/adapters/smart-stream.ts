import { Buffer } from "node:buffer";

export type StreamQuote = { token: string; price: number; time: string; receivedAt: string };
export type StreamOptionQuote = {
  token: string; price: number; time: string; tradeTime: string; receivedAt: string;
  bid: number; ask: number; bidQuantity: number; askQuantity: number; volume: number; openInterest: number;
};
const STREAM_URL = "wss://smartapisocket.angelone.in/smart-stream";

/** SmartAPI V2 LTP packets: 51-byte little-endian MCX packets with LTP in paise. */
export function parseSmartStreamLtp(input: unknown): StreamQuote | null {
  let bytes: Uint8Array;
  if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else return null;
  if (bytes.byteLength !== 51 || bytes[0] !== 1 || bytes[1] !== 5) return null;
  const packet = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const token = packet.subarray(2, 27).toString("ascii").replace(/\0.*$/, "");
  const timestamp = Number(packet.readBigInt64LE(35));
  const price = Number(packet.readBigInt64LE(43)) / 100;
  if (!/^\d+$/.test(token) || !Number.isSafeInteger(timestamp) || timestamp <= 0 || !Number.isFinite(price) || price <= 0) return null;
  return { token, price, time: new Date(timestamp).toISOString(), receivedAt: new Date().toISOString() };
}

/** SmartAPI V2 MCX Snap Quote packets contain 5-level depth and are 379 bytes. */
export function parseSmartStreamSnapQuote(input: unknown): StreamOptionQuote | null {
  let bytes: Uint8Array;
  if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else return null;
  if (bytes.byteLength !== 379 || bytes[0] !== 3 || bytes[1] !== 5) return null;
  const packet = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const token = packet.subarray(2, 27).toString("ascii").replace(/\0.*$/, "");
  const feedTime = Number(packet.readBigInt64LE(35));
  const price = Number(packet.readBigInt64LE(43)) / 100;
  const rawTradeTime = Number(packet.readBigInt64LE(123));
  const tradeTimeMs = rawTradeTime >= 1e12 ? rawTradeTime : rawTradeTime * 1000;
  const openInterest = Number(packet.readBigInt64LE(131));
  const volume = Number(packet.readBigInt64LE(67));
  if (!/^\d+$/.test(token) || !Number.isSafeInteger(feedTime) || feedTime <= 0 ||
    !Number.isSafeInteger(tradeTimeMs) || tradeTimeMs <= 0 || !Number.isFinite(price) || price <= 0 ||
    !Number.isSafeInteger(volume) || volume < 0 || !Number.isSafeInteger(openInterest) || openInterest < 0) return null;

  const buys: { price: number; quantity: number }[] = [];
  const sells: { price: number; quantity: number }[] = [];
  for (let offset = 147; offset < 347; offset += 20) {
    const flag = packet.readUInt16LE(offset);
    const quantity = Number(packet.readBigInt64LE(offset + 2));
    const levelPrice = Number(packet.readBigInt64LE(offset + 10)) / 100;
    if (flag > 1) return null;
    if (!Number.isSafeInteger(quantity) || quantity < 0 || !Number.isFinite(levelPrice) || levelPrice < 0) return null;
    if (quantity === 0 || levelPrice === 0) continue;
    // SmartAPI's V2 reference parser maps flag 1 to buy and flag 0 to sell.
    (flag === 1 ? buys : sells).push({ price: levelPrice, quantity });
  }
  buys.sort((a, b) => b.price - a.price);
  sells.sort((a, b) => a.price - b.price);
  if (!buys.length || !sells.length || buys[0].price > sells[0].price) return null;
  return {
    token, price, time: new Date(feedTime).toISOString(), tradeTime: new Date(tradeTimeMs).toISOString(),
    receivedAt: new Date().toISOString(), bid: buys[0].price, ask: sells[0].price,
    bidQuantity: buys[0].quantity, askQuantity: sells[0].quantity, volume, openInterest,
  };
}

/** One process-local stream for the local paper-trading worker. No credentials are logged. */
export class SmartMarketStream {
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private retry = 0;
  private stopped = true;
  private readonly tokens = new Set<string>();
  private readonly quotes = new Map<string, StreamQuote>();
  private readonly snapQuoteTokens = new Set<string>();
  private readonly optionQuotes = new Map<string, StreamOptionQuote>();

  get connected() { return this.socket?.readyState === WebSocket.OPEN; }
  get running() { return !this.stopped; }
  latest(token: string) { return this.quotes.get(token) ?? null; }
  latestOption(token: string) { return this.optionQuotes.get(token) ?? null; }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.open();
  }

  subscribe(token: string) {
    if (!/^\d+$/.test(token)) return;
    if (this.tokens.has(token)) return;
    this.tokens.add(token);
    if (this.connected) this.sendSubscription([token]);
  }

  subscribeSnapQuote(token: string) {
    if (!/^\d+$/.test(token) || this.snapQuoteTokens.has(token)) return;
    this.snapQuoteTokens.add(token);
    if (this.connected) this.sendSubscription([token], 3);
  }

  close() {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.heartbeat = null; this.reconnect = null;
    const socket = this.socket; this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "worker stopped");
  }

  private open() {
    if (this.stopped || this.socket) return;
    const apiKey = process.env.ANGEL_API_KEY?.trim(), clientCode = process.env.ANGEL_CLIENT_CODE?.trim(), feedToken = process.env.ANGEL_FEED_TOKEN?.trim();
    if (!apiKey || !clientCode || !feedToken) { this.retryLater(); return; }
    try {
      // SmartAPI documents query authentication for browser WebSocket clients. This URL stays
      // server-side; it is never returned to the browser or written to logs.
      const url = new URL(STREAM_URL);
      url.searchParams.set("clientCode", clientCode);
      url.searchParams.set("feedToken", feedToken);
      url.searchParams.set("apiKey", apiKey);
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.retry = 0;
        this.sendSubscription([...this.tokens]);
        this.sendSubscription([...this.snapQuoteTokens], 3);
        this.heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send("ping"); }, 30000);
      };
      socket.onmessage = event => {
        if (event.data === "pong" || event.data === "ping") return;
        void this.accept(event.data);
      };
      socket.onerror = () => { /* onclose performs a sanitized reconnect */ };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        this.retryLater();
      };
    } catch { this.socket = null; this.retryLater(); }
  }

  private async accept(data: unknown) {
    let packet = data;
    if (typeof Blob !== "undefined" && data instanceof Blob) packet = await data.arrayBuffer();
    const quote = parseSmartStreamLtp(packet);
    if (quote && this.tokens.has(quote.token)) {
      this.quotes.set(quote.token, quote);
      return;
    }
    const optionQuote = parseSmartStreamSnapQuote(packet);
    if (optionQuote && this.snapQuoteTokens.has(optionQuote.token)) this.optionQuotes.set(optionQuote.token, optionQuote);
  }

  private sendSubscription(tokens: string[], mode = 1) {
    if (!tokens.length || !this.connected) return;
    this.socket!.send(JSON.stringify({ action: 1, params: { mode, tokenList: [{ exchangeType: 5, tokens }] } }));
  }

  private retryLater() {
    if (this.stopped || this.reconnect) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retry++, 5));
    this.reconnect = setTimeout(() => { this.reconnect = null; this.open(); }, delay);
  }
}

export const smartMarketStream = new SmartMarketStream();
