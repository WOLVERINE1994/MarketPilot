import type { Contract } from "./types";
import { istDay } from "./time";
export type Instrument = { name: string; symbol: string; token: string; expiry: string; lotsize: string; tick_size: string; instrumenttype: string; exch_seg: string };
export type Specification = { symbol: string; expiry: string; lotSize: number; multiplier: number; tickSize: number; source: string; verifiedAt: string; validUntil: string };
export function expiryDate(value: string) {
  const match = /^(\d{2})([A-Z]{3})(\d{4})$/i.exec(value);
  if (!match) throw new Error("Unrecognized instrument expiry date");
  const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].indexOf(match[2].toUpperCase()) + 1;
  const date = `${match[3]}-${String(month).padStart(2, "0")}-${match[1]}`;
  if (!month || new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date) throw new Error("Invalid instrument expiry date");
  return date;
}
export function resolveContract(rows: Instrument[], specs: Specification[], now: string, heldSymbol?: string): Contract {
  const eligible = rows.filter(r => r.exch_seg === "MCX" && r.name === "CRUDEOILM" && r.instrumenttype === "FUTCOM" && /^CRUDEOILM\d{2}[A-Z]{3}\d{2}FUT$/.test(r.symbol))
    .map(r => ({ r, expiry: expiryDate(r.expiry) }))
    // New entries roll before expiry day. A held exact contract may still need an
    // exit quote on expiry day, but must never silently roll to a different token.
    .filter(r => heldSymbol ? r.r.symbol === heldSymbol && r.expiry >= istDay(now) : r.expiry > istDay(now)).sort((a, b) => a.expiry.localeCompare(b.expiry));
  if (!eligible.length) throw new Error("No tradable CRUDEOILM futures in instrument master");
  const { r, expiry } = eligible[0];
  if (eligible.some(candidate => candidate.r.symbol === r.symbol && candidate.r.token !== r.token)) throw new Error("Instrument master contract identity is ambiguous");
  const spec = specs.find(s => s.symbol === r.symbol && s.expiry === expiry);
  if (!spec || !/^https:\/\/(www\.)?mcxindia\.com\//.test(spec.source) || Date.parse(spec.verifiedAt) > Date.parse(now) || !(Date.parse(spec.validUntil) > Date.parse(now)) || !(Date.parse(spec.verifiedAt) > 0)) throw new Error("Current contract monetary specifications are unverified or expired");
  if (![spec.lotSize, spec.multiplier, spec.tickSize].every(n => Number.isFinite(n) && n > 0) || spec.lotSize !== Number(r.lotsize) || Math.abs(spec.tickSize - Number(r.tick_size) / 100) > 0.00001 || !/^\d+$/.test(r.token)) throw new Error("Instrument master and verified specifications disagree");
  return { symbol: r.symbol, token: r.token, expiry, lotSize: spec.lotSize, multiplier: spec.multiplier, tickSize: spec.tickSize, source: spec.source, verified: true };
}
