import { parseExpiry } from "./time.js";

/** Normalize instrument-master rows for one product into futures and options. */
export function parseInstruments(rows, productKey) {
  const futures = [], options = [];
  for (const r of rows) {
    if (r.exch_seg !== "MCX" || r.name !== productKey) continue;
    const expiry = parseExpiry(r.expiry);
    if (!expiry || !/^\d+$/.test(String(r.token))) continue;
    const base = { symbol: r.symbol, token: String(r.token), expiry, lotSize: Number(r.lotsize), tickSize: Number(r.tick_size) / 100 || 1 };
    if (/^FUT/.test(r.instrumenttype) && /FUT$/.test(r.symbol)) futures.push(base);
    else if (r.instrumenttype === "OPTFUT" && /(CE|PE)$/.test(r.symbol)) {
      const strike = Number(r.strike) / 100;
      if (Number.isFinite(strike) && strike > 0) options.push({ ...base, strike, type: r.symbol.slice(-2) });
    }
  }
  futures.sort((a, b) => a.expiry.localeCompare(b.expiry));
  return { futures, options };
}

/**
 * Pick the contracts to trade today (IST date `today`, "YYYY-MM-DD").
 * Expiry-day contracts are skipped: MCX options that expire in the money
 * devolve into futures, and liquidity has already moved to the next month.
 */
export function selectContracts(rows, product, today) {
  const { futures, options } = parseInstruments(rows, product.key);
  let optionExpiry = null, chain = [];
  if (product.options) {
    optionExpiry = [...new Set(options.map(o => o.expiry))].filter(e => e > today).sort()[0] ?? null;
    chain = options.filter(o => o.expiry === optionExpiry).sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));
  }
  // MCX options are options on a futures contract: follow the future that the
  // selected options settle into (the nearest one expiring on/after them).
  const future = futures.find(f => (optionExpiry ? f.expiry >= optionExpiry : f.expiry > today)) ?? futures.find(f => f.expiry > today) ?? null;
  return { future, optionExpiry, chain };
}

export const strikesOf = chain => [...new Set(chain.map(o => o.strike))].sort((a, b) => a - b);

/** Option to buy for a direction: CE for long, PE for short. */
export function pickOption(chain, price, side, moneyness = "ATM") {
  const type = side === "BUY" ? "CE" : "PE";
  const strikes = strikesOf(chain.filter(o => o.type === type));
  if (!strikes.length || !(price > 0)) return null;
  let i = strikes.reduce((best, s, idx) => (Math.abs(s - price) < Math.abs(strikes[best] - price) ? idx : best), 0);
  // ITM for a call is a lower strike, for a put a higher strike; OTM the opposite.
  const step = moneyness === "ITM1" ? (type === "CE" ? -1 : 1) : moneyness === "OTM1" ? (type === "CE" ? 1 : -1) : 0;
  i = Math.min(strikes.length - 1, Math.max(0, i + step));
  return chain.find(o => o.type === type && o.strike === strikes[i]) ?? null;
}

/** Strikes around the money to keep subscribed so premiums are ready instantly. */
export function nearbyOptions(chain, price, width = 3) {
  const strikes = strikesOf(chain);
  if (!strikes.length || !(price > 0)) return [];
  const atm = strikes.reduce((best, s, idx) => (Math.abs(s - price) < Math.abs(strikes[best] - price) ? idx : best), 0);
  const keep = new Set(strikes.slice(Math.max(0, atm - width), atm + width + 1));
  return chain.filter(o => keep.has(o.strike));
}
