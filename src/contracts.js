import { parseExpiry } from "./time.js";

/** Tokens are only unique within an exchange, so every instrument is identified by exchange + token. */
export const instKey = inst => `${inst.exch}|${inst.token}`;

/**
 * Normalize instrument-master rows for one product:
 *  - futures (MCX commodities)
 *  - spot index row (NSE/BSE indices)
 *  - options (MCX OPTFUT or NFO/BFO OPTIDX)
 */
export function parseInstruments(rows, product) {
  const futures = [], options = [];
  let spot = null;
  for (const r of rows) {
    if (r.name !== product.key || !/^\d+$/.test(String(r.token))) continue;
    if (product.kind === "INDEX" && r.exch_seg === product.exch && r.instrumenttype === "AMXIDX") {
      spot = { exch: r.exch_seg, symbol: r.symbol, token: String(r.token), expiry: null, lotSize: 1, tickSize: 0.05 };
      continue;
    }
    const expiry = parseExpiry(r.expiry);
    if (!expiry) continue;
    const base = { exch: r.exch_seg, symbol: r.symbol, token: String(r.token), expiry, lotSize: Number(r.lotsize), tickSize: Number(r.tick_size) / 100 || (product.kind === "INDEX" ? 0.05 : 1) };
    if (product.kind === "COMMODITY" && r.exch_seg === product.exch && /^FUT/.test(r.instrumenttype) && /FUT$/.test(r.symbol)) futures.push(base);
    else if (r.exch_seg === product.optionExch && /^OPT(FUT|IDX)$/.test(r.instrumenttype) && /(CE|PE)$/.test(r.symbol)) {
      const strike = Number(r.strike) / 100;
      if (Number.isFinite(strike) && strike > 0) options.push({ ...base, strike, type: r.symbol.slice(-2) });
    }
  }
  futures.sort((a, b) => a.expiry.localeCompare(b.expiry));
  if (product.kind === "INDEX" && !spot && product.spotToken) {
    spot = { exch: product.exch, symbol: product.label, token: product.spotToken, expiry: null, lotSize: 1, tickSize: 0.05 };
  }
  return { futures, options, spot };
}

/**
 * Pick what to watch and trade today (IST date `today`, "YYYY-MM-DD").
 * `underlying` is the chart the strategy reads: the spot index for indices,
 * or for MCX the futures contract the selected options settle into.
 * By default contracts expiring today are skipped (expiry-day premiums decay
 * very fast, and in-the-money MCX options devolve into futures).
 */
export function selectContracts(rows, product, today, { skipExpiryDay = true } = {}) {
  const { futures, options, spot } = parseInstruments(rows, product);
  const usable = e => (skipExpiryDay ? e > today : e >= today);
  let optionExpiry = null, chain = [];
  if (product.options) {
    optionExpiry = [...new Set(options.map(o => o.expiry))].filter(usable).sort()[0] ?? null;
    chain = options.filter(o => o.expiry === optionExpiry).sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));
  }
  let underlying;
  if (product.kind === "INDEX") underlying = spot;
  else underlying = futures.find(f => (optionExpiry ? f.expiry >= optionExpiry : f.expiry > today)) ?? futures.find(f => f.expiry > today) ?? null;
  // P&L per point for one lot: index options carry it in their lot size.
  const multiplier = product.kind === "INDEX" ? chain[0]?.lotSize || null : product.multiplier;
  return { underlying, optionExpiry, chain, multiplier };
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
