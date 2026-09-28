import { readFile } from "node:fs/promises";
import { resolveContract, type Instrument, type Specification } from "../contracts";
import type { Contract } from "../types";
const MASTER = "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json";
let cache: { rows: Instrument[]; time: number } | null = null;
export async function currentContract(now: string): Promise<Contract> {
  if (!process.env.MARKETPILOT_SPECS_FILE) throw new Error("Verified MCX specifications not configured");
  if (!cache || Date.now() - cache.time > 3600000) {
    const response = await fetch(MASTER, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Instrument master unavailable");
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Invalid instrument master");
    cache = { rows, time: Date.now() };
  }
  const specs: Specification[] = JSON.parse(await readFile(process.env.MARKETPILOT_SPECS_FILE, "utf8"));
  return resolveContract(cache.rows, specs, now);
}
export function exchangeTime(value: string): string {
  // SmartAPI FULL time is DD-Mon-YYYY HH:mm:ss in exchange local time.
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error("Unrecognized exchange timestamp");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].findIndex(m => m.toLowerCase() === match[2].toLowerCase()) + 1;
  if (!month) throw new Error("Invalid exchange month");
  return new Date(`${match[3]}-${String(month).padStart(2, "0")}-${match[1]}T${match[4]}+05:30`).toISOString();
}
export async function quote(contract: Contract): Promise<{ price: number; time: string }> {
  const e = process.env;
  if (![e.ANGEL_API_KEY, e.ANGEL_ACCESS_TOKEN, e.ANGEL_CLIENT_LOCAL_IP, e.ANGEL_CLIENT_PUBLIC_IP, e.ANGEL_MAC_ADDRESS].every(Boolean)) throw new Error("SmartAPI credentials/session not configured");
  const response = await fetch("https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/", {
    method: "POST", signal: AbortSignal.timeout(10000), cache: "no-store",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${e.ANGEL_ACCESS_TOKEN}`, "X-PrivateKey": e.ANGEL_API_KEY!, "X-UserType": "USER", "X-SourceID": "WEB", "X-ClientLocalIP": e.ANGEL_CLIENT_LOCAL_IP!, "X-ClientPublicIP": e.ANGEL_CLIENT_PUBLIC_IP!, "X-MACAddress": e.ANGEL_MAC_ADDRESS! },
    body: JSON.stringify({ mode: "FULL", exchangeTokens: { MCX: [contract.token] } }),
  });
  if (!response.ok) throw new Error("SmartAPI quote request failed");
  const body = await response.json(), row = body.data?.fetched?.[0];
  if (!body.status || !row || String(row.symbolToken) !== contract.token || row.exchange !== "MCX" || row.tradingSymbol !== contract.symbol || !Number.isFinite(row.ltp) || row.ltp <= 0) throw new Error("SmartAPI quote cannot be verified");
  return { price: row.ltp, time: exchangeTime(row.exchFeedTime) };
}
