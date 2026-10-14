import { readFile } from "node:fs/promises";
import { resolveContract, type Instrument, type Specification } from "../contracts";
import type { Contract } from "../types";
import { lastValidObservation } from "../storage";
import { istDay } from "../time";
const MASTER = "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";
const MASTER_REFRESH_MS = 3600000;
const MASTER_RETRY_MS = 60000;
const MASTER_TIMEOUT_MS = 180000;
let cache: { rows: Instrument[]; time: number } | null = null;
let retryAfter = 0;
export async function instrumentMaster(): Promise<Instrument[]> {
  const now = Date.now();
  if (cache && now - cache.time <= MASTER_REFRESH_MS) return cache.rows;
  if (now < retryAfter) throw new QuoteError("UNAVAILABLE");
  try {
    const response = await fetch(MASTER, { cache: "no-store", signal: AbortSignal.timeout(MASTER_TIMEOUT_MS) });
    if (!response.ok) throw new QuoteError("UNAVAILABLE");
    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.some(row => !isRecord(row))) throw new QuoteError("UNAVAILABLE");
    cache = { rows: rows as Instrument[], time: Date.now() };
    retryAfter = 0;
    return cache.rows;
  } catch (error) {
    retryAfter = Date.now() + MASTER_RETRY_MS;
    if (error instanceof QuoteError) throw error;
    throw new QuoteError("UNAVAILABLE");
  }
}

export class QuoteError extends Error {
  constructor(public readonly status: "MALFORMED" | "CONTRACT_MISMATCH" | "UNAVAILABLE", public readonly exchangeTime: string | null = null) {
    super(status === "CONTRACT_MISMATCH" ? "SmartAPI contract identity cannot be verified" : status === "MALFORMED" ? "SmartAPI quote is malformed" : "SmartAPI market data unavailable");
    this.name = "QuoteError";
  }
}

export async function currentContract(now: string, heldSymbol?: string): Promise<Contract> {
  if (!process.env.MARKETPILOT_SPECS_FILE) throw new QuoteError("UNAVAILABLE");
  let specs: Specification[];
  try {
    // Re-read the local review for every attempt. Expired or withdrawn
    // attestations must also invalidate a previously opened paper position.
    specs = JSON.parse(await readFile(process.env.MARKETPILOT_SPECS_FILE, "utf8"));
    if (!Array.isArray(specs) || specs.some(spec => !isRecord(spec))) throw new QuoteError("UNAVAILABLE");
  } catch {
    // Filesystem paths, broker response messages and transport errors stay out
    // of the durable audit log and the dashboard.
    throw new QuoteError("UNAVAILABLE");
  }
  let rows: Instrument[];
  try { rows = await instrumentMaster(); }
  catch {
    // If today's already accepted quote proved the broker token against the
    // official master, preserve that identity across a temporary master outage.
    // The current reviewed MCX specification must still attest every monetary
    // field, and a separate fresh quote is still required before fills.
    const previous = lastValidObservation();
    const known = previous?.contract;
    const sourceTime = previous?.exchangeTime;
    const age = sourceTime ? Date.parse(now) - Date.parse(sourceTime) : Infinity;
    if (!known?.verified || !sourceTime || !Number.isFinite(age) || age < 0 || age > 12 * 60 * 60 * 1000 || istDay(sourceTime) !== istDay(now)) throw new QuoteError("UNAVAILABLE");
    const expiry = known.expiry;
    const spec = specs.find(item => item.symbol === known.symbol && item.expiry === expiry);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || !Number.isFinite(Date.parse(`${expiry}T00:00:00Z`)) ||
      (heldSymbol && known.symbol !== heldSymbol) || (!heldSymbol && expiry <= istDay(now)) ||
      !spec || !/^https:\/\/(www\.)?mcxindia\.com\//.test(spec.source) ||
      Date.parse(spec.verifiedAt) > Date.parse(now) || !(Date.parse(spec.validUntil) > Date.parse(now)) ||
      spec.lotSize !== known.lotSize || spec.multiplier !== known.multiplier || spec.tickSize !== known.tickSize || !/^\d+$/.test(known.token)) throw new QuoteError("UNAVAILABLE");
    return { ...known, source: spec.source, verified: true };
  }
  try { return resolveContract(rows, specs, now, heldSymbol); }
  catch { throw new QuoteError("UNAVAILABLE"); }
}

export function exchangeTime(value: string): string {
  // SmartAPI FULL time is DD-Mon-YYYY HH:mm:ss in exchange local time.
  if (typeof value !== "string") throw new QuoteError("MALFORMED");
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  if (!match) throw new QuoteError("MALFORMED");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].findIndex(m => m.toLowerCase() === match[2].toLowerCase()) + 1;
  const local = `${match[3]}-${String(month).padStart(2, "0")}-${match[1]}T${match[4]}`;
  const parsed = Date.parse(`${local}+05:30`);
  // Date.parse normalizes impossible dates such as 31 February and 24:00.
  // Round-trip the exact local components to reject all such rollovers.
  if (!month || !Number.isFinite(parsed) || new Date(parsed + 330 * 60000).toISOString().slice(0, 19) !== local) throw new QuoteError("MALFORMED");
  return new Date(parsed).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function verifyContract(contract: Contract) {
  if (contract.verified !== true || !/^CRUDEOILM\d{2}[A-Z]{3}\d{2}FUT$/.test(contract.symbol) || !/^\d+$/.test(contract.token) || ![contract.lotSize, contract.multiplier, contract.tickSize].every(value => Number.isFinite(value) && value > 0)) throw new QuoteError("CONTRACT_MISMATCH");
}

export function parseQuote(body: unknown, contract: Contract): { price: number; time: string } {
  verifyContract(contract);
  if (!isRecord(body)) throw new QuoteError("MALFORMED");
  if (body.status === false) throw new QuoteError("UNAVAILABLE");
  if (body.status !== true || !isRecord(body.data) || !Array.isArray(body.data.fetched)) throw new QuoteError("MALFORMED");
  const rows = body.data.fetched;
  if (!rows.length) throw new QuoteError("UNAVAILABLE");
  if (rows.length !== 1) throw new QuoteError("CONTRACT_MISMATCH");
  const row: unknown = rows[0];
  if (!isRecord(row)) throw new QuoteError("MALFORMED");
  let time: string | null = null;
  try { time = exchangeTime(row.exchFeedTime as string); } catch { /* Identity failures still retain their correct status. */ }
  if (String(row.symbolToken) !== contract.token || row.exchange !== "MCX" || row.tradingSymbol !== contract.symbol) throw new QuoteError("CONTRACT_MISMATCH", time);
  if (!time || typeof row.ltp !== "number" || !Number.isFinite(row.ltp) || row.ltp <= 0) throw new QuoteError("MALFORMED", time);
  if (Array.isArray(body.data.unfetched) && body.data.unfetched.length) throw new QuoteError("UNAVAILABLE", time);
  return { price: row.ltp, time };
}

export async function quote(contract: Contract): Promise<{ price: number; time: string }> {
  verifyContract(contract);
  return parseQuote(await marketQuotes([contract.token]), contract);
}

// Quotes only. There is deliberately no broker order API in this application.
export async function marketQuotes(tokens: string[], timeoutMs = 10000): Promise<unknown> {
  if (!tokens.length || tokens.length > 3 || tokens.some(token => !/^\d+$/.test(token)) || new Set(tokens).size !== tokens.length) throw new QuoteError("CONTRACT_MISMATCH");
  const e = process.env;
  if (![e.ANGEL_API_KEY, e.ANGEL_ACCESS_TOKEN, e.ANGEL_CLIENT_LOCAL_IP, e.ANGEL_CLIENT_PUBLIC_IP, e.ANGEL_MAC_ADDRESS].every(Boolean)) throw new QuoteError("UNAVAILABLE");
  try {
    const response = await fetch("https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/", {
      method: "POST", signal: AbortSignal.timeout(timeoutMs), cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${e.ANGEL_ACCESS_TOKEN!.trim().replace(/^Bearer\s+/i, "")}`, "X-PrivateKey": e.ANGEL_API_KEY!, "X-UserType": "USER", "X-SourceID": "WEB", "X-ClientLocalIP": e.ANGEL_CLIENT_LOCAL_IP!, "X-ClientPublicIP": e.ANGEL_CLIENT_PUBLIC_IP!, "X-MACAddress": e.ANGEL_MAC_ADDRESS! },
      body: JSON.stringify({ mode: "FULL", exchangeTokens: { MCX: tokens } }),
    });
    if (!response.ok) throw new QuoteError("UNAVAILABLE");
    let body: unknown;
    try { body = await response.json(); } catch { throw new QuoteError("MALFORMED"); }
    return body;
  } catch (error) {
    if (error instanceof QuoteError) throw error;
    throw new QuoteError("UNAVAILABLE");
  }
}
