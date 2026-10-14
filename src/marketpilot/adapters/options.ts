import { readFile } from "node:fs/promises";
import { instrumentMaster, marketQuotes, exchangeTime, QuoteError } from "./smartapi";
import { smartMarketStream } from "./smart-stream";
import { resolveOptions } from "../option-contracts";
import type { Contract } from "../types";
import type { OptionContract, OptionQuote } from "../option-types";
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export async function optionContracts(underlying: Contract, now: string) {
  const file = process.env.MARKETPILOT_OPTION_SPECS_FILE;
  if (!file?.trim()) throw new Error("MARKETPILOT_OPTION_SPECS_FILE missing; Mini option specifications unverified");
  return resolveOptions(await instrumentMaster(), JSON.parse(await readFile(file, "utf8")), underlying, now);
}
export function parseOptionQuotes(body: unknown, contracts: OptionContract[], receivedAt: string): OptionQuote[] {
  if (!record(body) || body.status !== true || !record(body.data) || !Array.isArray(body.data.fetched) ||
    !Array.isArray(body.data.unfetched) || body.data.unfetched.length || body.data.fetched.length !== contracts.length) throw new QuoteError("UNAVAILABLE");
  const used = new Set<string>();
  return body.data.fetched.map((row: unknown) => {
    if (!record(row)) throw new QuoteError("MALFORMED");
    const contract = contracts.find(c => c.token === String(row.symbolToken));
    if (!contract || used.has(contract.token) || row.exchange !== "MCX" || row.tradingSymbol !== contract.symbol || !contract.verified || contract.instrument !== "OPTION") throw new QuoteError("CONTRACT_MISMATCH");
    used.add(contract.token);
    const time = exchangeTime(row.exchFeedTime as string), tradeTime = exchangeTime(row.exchTradeTime as string);
    if (Date.parse(tradeTime) > Date.parse(time)) throw new QuoteError("MALFORMED");
    if (typeof row.ltp !== "number" || !Number.isFinite(row.ltp) || row.ltp <= 0 || !record(row.depth) || !Array.isArray(row.depth.buy) || !Array.isArray(row.depth.sell)) throw new QuoteError("MALFORMED");
    const levels = (input: unknown[], buy: boolean) => {
      const valid = input.filter(record).filter(level => typeof level.price === "number" && Number.isFinite(level.price) && level.price > 0 && typeof level.quantity === "number" && Number.isFinite(level.quantity) && level.quantity > 0)
        .sort((a, b) => buy ? Number(b.price) - Number(a.price) : Number(a.price) - Number(b.price));
      if (!valid.length) throw new QuoteError("UNAVAILABLE");
      return { price: Number(valid[0].price), quantity: Number(valid[0].quantity) };
    };
    const bid = levels(row.depth.buy, true), ask = levels(row.depth.sell, false);
    if (bid.price > ask.price || [bid.price, ask.price, row.ltp].some(price => Math.abs(price / contract.tickSize - Math.round(price / contract.tickSize)) > 1e-5)) throw new QuoteError("MALFORMED");
    if (typeof row.tradeVolume !== "number" || !Number.isFinite(row.tradeVolume) || row.tradeVolume < 0 || typeof row.opnInterest !== "number" || !Number.isFinite(row.opnInterest) || row.opnInterest < 0) throw new QuoteError("MALFORMED");
    return { id: crypto.randomUUID(), contract, time, tradeTime, receivedAt, ltp: row.ltp, bid: bid.price, ask: ask.price,
      bidQuantity: bid.quantity, askQuantity: ask.quantity, volume: row.tradeVolume, openInterest: row.opnInterest };
  });
}
function smartApiTime(value: string) {
  const local = new Date(Date.parse(value) + 330 * 60000).toISOString();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${local.slice(8, 10)}-${months[Number(local.slice(5, 7)) - 1]}-${local.slice(0, 4)} ${local.slice(11, 19)}`;
}
export async function optionQuotes(contracts: OptionContract[]): Promise<OptionQuote[]> {
  const receivedAt = new Date().toISOString();
  const streamed = contracts.map(contract => smartMarketStream.latestOption(contract.token));
  if (streamed.every((quote, index) => quote && quote.token === contracts[index].token &&
    Date.parse(quote.time) <= Date.parse(receivedAt) && Date.parse(receivedAt) - Date.parse(quote.time) <= 30000)) {
    const rows = streamed.map((quote, index) => ({
      exchange: "MCX", symbolToken: quote!.token, tradingSymbol: contracts[index].symbol,
      ltp: quote!.price, exchFeedTime: smartApiTime(quote!.time), exchTradeTime: smartApiTime(quote!.tradeTime),
      tradeVolume: quote!.volume, opnInterest: quote!.openInterest,
      depth: {
        buy: [{ price: quote!.bid, quantity: quote!.bidQuantity }],
        sell: [{ price: quote!.ask, quantity: quote!.askQuantity }],
      },
    }));
    return parseOptionQuotes({ status: true, data: { fetched: rows, unfetched: [] } }, contracts, receivedAt);
  }
  const body = await marketQuotes(contracts.map(c => c.token), 2500);
  return parseOptionQuotes(body, contracts, receivedAt);
}
