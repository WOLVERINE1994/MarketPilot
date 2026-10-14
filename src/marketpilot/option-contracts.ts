import { z } from "zod";
import { expiryDate, type Instrument } from "./contracts";
import type { Contract } from "./types";
import type { OptionContract, OptionSpecification } from "./option-types";
const iso = z.string().datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const schema = z.array(z.object({ underlyingSymbol: z.string().regex(/^CRUDEOILM\d{2}[A-Z]{3}\d{2}FUT$/), underlyingExpiry: date, optionExpiry: date,
  lotSize: z.number().positive(), multiplier: z.number().positive(), tickSize: z.number().positive(), strikeStep: z.number().positive(),
  source: z.string().regex(/^https:\/\/(www\.)?mcxindia\.com\//), verifiedAt: iso, validUntil: iso }).strict());
export function resolveOptions(rows: Instrument[], input: unknown, underlying: Contract, now: string): OptionContract[] {
  if (!underlying.verified || underlying.instrument === "OPTION") throw new Error("Option underlying is unverified");
  const specs: OptionSpecification[] = schema.parse(input);
  const active = specs.filter(s => s.underlyingSymbol === underlying.symbol && s.underlyingExpiry === underlying.expiry &&
    s.optionExpiry < underlying.expiry && s.optionExpiry.slice(0, 7) === underlying.expiry.slice(0, 7) &&
    Date.parse(s.verifiedAt) <= Date.parse(now) && Date.parse(s.validUntil) > Date.parse(now));
  if (active.length !== 1) throw new Error("Option specification review is missing, ambiguous or expired");
  const spec = active[0];
  if (spec.lotSize !== underlying.lotSize || spec.multiplier !== underlying.multiplier) throw new Error("Mini option monetary specification does not match its underlying");
  const result: OptionContract[] = [];
  for (const r of rows.filter(r => r.exch_seg === "MCX" && r.name === "CRUDEOILM" && r.instrumenttype === "OPTFUT")) {
    const m = /^CRUDEOILM(\d{2}[A-Z]{3}\d{2})(\d+(?:\.\d+)?)(CE|PE)$/.exec(r.symbol);
    if (!m || expiryDate(r.expiry) !== spec.optionExpiry) continue;
    const symbolExpiry = expiryDate(`${m[1].slice(0, 5)}20${m[1].slice(5)}`);
    const strike = Number(r.strike) / 100;
    if (symbolExpiry !== spec.optionExpiry || !/^\d+$/.test(r.token) || !Number.isFinite(strike) || strike <= 0 || Number(m[2]) !== strike ||
      Math.abs(strike / spec.strikeStep - Math.round(strike / spec.strikeStep)) > 1e-8 || Number(r.lotsize) !== spec.lotSize ||
      Math.abs(Number(r.tick_size) / 100 - spec.tickSize) > 1e-8) throw new Error("Option master identity or specifications disagree");
    if (result.some(c => c.symbol === r.symbol || c.token === r.token)) throw new Error("Ambiguous option identity in master");
    result.push({ symbol: r.symbol, token: r.token, expiry: spec.optionExpiry, lotSize: spec.lotSize, multiplier: spec.multiplier, tickSize: spec.tickSize,
      source: spec.source, verified: true, instrument: "OPTION", optionType: m[3] as "CE" | "PE", strike, underlyingSymbol: underlying.symbol });
  }
  if (!result.length) throw new Error("No verified Mini options found for this underlying");
  return result;
}
export function selectOptionPair(contracts: OptionContract[], price: number): OptionContract[] {
  if (!Number.isFinite(price) || price <= 0) return [];
  const strikes = [...new Set(contracts.map(c => c.strike))].filter(strike => ["CE", "PE"].every(type => contracts.some(c => c.strike === strike && c.optionType === type)));
  strikes.sort((a, b) => Math.abs(a - price) - Math.abs(b - price) || a - b);
  if (!strikes.length || Math.abs(strikes[0] - price) / price > 0.02) return [];
  return contracts.filter(c => c.strike === strikes[0]).sort((a, b) => a.optionType.localeCompare(b.optionType));
}
export const expiryBuffer = (contract: Contract, now: string) => Date.parse(`${contract.expiry}T00:00:00+05:30`) - Date.parse(now) <= 72 * 3600000;
