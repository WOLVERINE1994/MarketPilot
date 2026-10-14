import { z } from "zod";
import { fresh } from "../time";
import type { ContextItem } from "../types";

const payload = z.object({ source: z.string().min(1), time: z.string().datetime({ offset: true }), value: z.number().positive().optional(), headline: z.string().max(500).optional(), bias: z.enum(["UP", "DOWN", "NEUTRAL"]), block: z.boolean() });
const oilPriceResponse = z.object({ status: z.string().optional(), data: z.object({ prices: z.array(z.object({
  code: z.string(), price: z.number().positive(), currency: z.string().optional(), unit: z.string().optional(),
  source: z.string().optional(), as_of: z.string().optional(), observed_at: z.string().optional(), created_at: z.string().optional(),
  data_status: z.string().optional(), stale: z.boolean().optional(), synthetic: z.boolean().optional(),
  freshness: z.object({ status: z.string().optional(), age_seconds: z.number().nonnegative().optional(), expected_max_age_seconds: z.number().positive().optional() }).optional(),
  changes: z.object({ "24h": z.object({ percent: z.number(), measured_at: z.string().optional(), span_hours: z.number().optional() }).optional() }).optional()
})), metadata: z.object({ source: z.string().optional(), source_description: z.string().optional() }).optional() }) });
const twelveDataQuote = z.object({
  symbol: z.string(), close: z.union([z.string(), z.number()]), timestamp: z.number(),
  percent_change: z.union([z.string(), z.number()]).optional(), status: z.string().optional()
});

// The active Core Commodity trial allows frequent polling. One batched request
// every five minutes stays within the shown 10,000/month allowance, even 24/7.
// Check the account before the trial ends; the free-tier allowance is smaller.
const OILPRICE_CACHE_MS = 5 * 60 * 1000;
let oilPriceCache: { fetchedAt: number; items: ContextItem[] } | undefined;
let oilPricePending: Promise<ContextItem[]> | undefined;

// Configure only endpoints you are licensed/authorized to access. No scraping or inferred quotes.
async function read(name: string, env: string, now: string): Promise<ContextItem> {
  const url = process.env[env];
  if (url && url.startsWith("https://")) try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), cache: "no-store", headers: process.env.CONTEXT_API_KEY ? { Authorization: `Bearer ${process.env.CONTEXT_API_KEY}` } : {} });
    if (!response.ok) throw new Error("Context unavailable");
    const data = payload.parse(await response.json());
    if (!fresh(data.time, now, 900) || (name !== "Oil news" && data.value === undefined) || (name === "Oil news" && !data.headline)) throw new Error("Stale/incomplete context");
    return { name, ...data, status: "LIVE" };
  } catch { /* Fail closed; credentials and provider errors never reach the client. */ }
  return { name, status: "UNAVAILABLE", source: url ? "Configured adapter — unavailable or stale" : "No authorized source configured", bias: "NEUTRAL", block: false };
}

async function oilPricePair(now: string): Promise<ContextItem[]> {
  const key = process.env.OILPRICEAPI_KEY?.trim();
  if (!key) return ["WTI", "Brent"].map(name => ({ name, status: "UNAVAILABLE", source: "OILPRICEAPI_KEY is not configured", bias: "NEUTRAL", block: false }));
  const nowMs = Date.parse(now);
  if (oilPriceCache && nowMs >= oilPriceCache.fetchedAt && nowMs - oilPriceCache.fetchedAt < OILPRICE_CACHE_MS) {
    return oilPriceCache.items.map(item => fresh(item.time, now, item.freshnessSeconds ?? 900) ? item : { ...item, status: "UNAVAILABLE" });
  }
  if (!oilPricePending) oilPricePending = (async () => {
    const response = await fetch("https://api.oilpriceapi.com/v1/prices/latest?by_code=WTI_USD,BRENT_CRUDE_USD", {
      signal: AbortSignal.timeout(8000), cache: "no-store", headers: { Authorization: `Token ${key}`, Accept: "application/json" }
    });
    if (!response.ok) throw new Error("Price context unavailable");
    const parsed = oilPriceResponse.parse(await response.json());
    const receivedAt = new Date().toISOString();
    const items = ([
      { name: "WTI", code: "WTI_USD" }, { name: "Brent", code: "BRENT_CRUDE_USD" }
    ] as const).map(({ name, code }): ContextItem => {
      const quote = parsed.data.prices.find(item => item.code === code);
      const time = quote?.as_of ?? quote?.observed_at ?? quote?.created_at;
      const change = quote?.changes?.["24h"];
      const bias = change && (change.span_hours === undefined || change.span_hours <= 30)
        ? change.percent > 0.05 ? "UP" as const : change.percent < -0.05 ? "DOWN" as const : "NEUTRAL" as const
        : "NEUTRAL" as const;
      if (!quote) return { name, status: "UNAVAILABLE", source: `OilPriceAPI did not return ${code}`, bias: "NEUTRAL", block: false };
      if (!time) return { name, status: "UNAVAILABLE", source: `OilPriceAPI ${code} quote has no source timestamp`, bias: "NEUTRAL", block: false };
      const freshnessSeconds = Math.min(1800, Math.max(60, quote.freshness?.expected_max_age_seconds ?? 1800));
      if (quote.data_status === "stale" || quote.freshness?.status === "stale" || quote.stale === true || quote.synthetic === true)
        return { name, status: "UNAVAILABLE", source: `OilPriceAPI ${code} quote is marked stale or synthetic`, time, value: quote.price, bias: "NEUTRAL", block: false };
      if (!fresh(time, receivedAt, freshnessSeconds)) {
        const ageMinutes = Math.max(0, Math.floor((Date.parse(receivedAt) - Date.parse(time)) / 60000));
        return { name, status: "UNAVAILABLE", source: `OilPriceAPI ${code} source timestamp is ${ageMinutes} minutes old; provider freshness limit is ${Math.floor(freshnessSeconds / 60)} minutes`, time, freshnessSeconds, value: quote.price, bias: "NEUTRAL", block: false };
      }
      return {
        name, source: `${parsed.data.metadata?.source_description ?? quote.source ?? "OilPriceAPI"} · spot ${quote.unit ?? "USD/barrel"}`,
        time, freshnessSeconds, value: quote.price, bias, block: false, status: "LIVE"
      };
    });
    oilPriceCache = { fetchedAt: nowMs, items };
    return items;
  })().finally(() => { oilPricePending = undefined; });
  try {
    const items = await oilPricePending;
    return items.map(item => fresh(item.time, now, item.freshnessSeconds ?? 900) ? item : { ...item, status: "UNAVAILABLE" });
  } catch {
    const items = ["WTI", "Brent"].map(name => ({ name, status: "UNAVAILABLE" as const, source: "OilPriceAPI request failed or returned an invalid/stale quote", bias: "NEUTRAL" as const, block: false }));
    oilPriceCache = { fetchedAt: nowMs, items };
    return items;
  }
}

const TWELVE_DATA_CACHE_MS = 60 * 1000;
let twelveDataCache: { fetchedAt: number; items: ContextItem[] } | undefined;
let twelveDataPending: Promise<ContextItem[]> | undefined;
async function twelveDataPair(now: string): Promise<ContextItem[]> {
  const key = process.env.TWELVE_DATA_API_KEY?.trim();
  if (!key) return ["WTI", "Brent"].map(name => ({ name, status: "UNAVAILABLE", source: "TWELVE_DATA_API_KEY is not configured", bias: "NEUTRAL", block: false }));
  const nowMs = Date.parse(now);
  if (twelveDataCache && nowMs >= twelveDataCache.fetchedAt && nowMs - twelveDataCache.fetchedAt < TWELVE_DATA_CACHE_MS)
    return twelveDataCache.items.map(item => fresh(item.time, now, 900) ? item : { ...item, status: "UNAVAILABLE" });
  if (!twelveDataPending) twelveDataPending = Promise.all([
    { name: "WTI", symbol: "WTI/USD" }, { name: "Brent", symbol: "XBR/USD" }
  ].map(async ({ name, symbol }): Promise<ContextItem> => {
    try {
      const url = new URL("https://api.twelvedata.com/quote");
      url.searchParams.set("symbol", symbol); url.searchParams.set("apikey", key); url.searchParams.set("timezone", "UTC");
      const response = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Quote unavailable");
      const quote = twelveDataQuote.parse(await response.json());
      const time = new Date(quote.timestamp * 1000).toISOString();
      if (quote.symbol.toUpperCase() !== symbol || !fresh(time, now, 900)) throw new Error("Quote is stale or symbol mismatched");
      const change = quote.percent_change === undefined ? undefined : Number(quote.percent_change);
      const bias = change !== undefined && Number.isFinite(change)
        ? change > 0.05 ? "UP" as const : change < -0.05 ? "DOWN" as const : "NEUTRAL" as const
        : "NEUTRAL" as const;
      return { name, status: "LIVE", source: `Twelve Data · ${symbol} spot · previous close change`, time, value: Number(quote.close), bias, block: false };
    } catch {
      return { name, status: "UNAVAILABLE", source: `Twelve Data ${symbol} quote missing, stale, unauthorized, or not on the current plan`, bias: "NEUTRAL", block: false };
    }
  })).then(items => {
    twelveDataCache = { fetchedAt: nowMs, items };
    return items;
  }).finally(() => { twelveDataPending = undefined; });
  return (await twelveDataPending).map(item => fresh(item.time, now, 900) ? item : { ...item, status: "UNAVAILABLE" });
}
export const wti = async (now: string) => process.env.TWELVE_DATA_API_KEY?.trim() ? (await twelveDataPair(now))[0] : process.env.OILPRICEAPI_KEY?.trim() ? (await oilPricePair(now))[0] : read("WTI", "WTI_CONTEXT_URL", now);
export const brent = async (now: string) => process.env.TWELVE_DATA_API_KEY?.trim() ? (await twelveDataPair(now))[1] : process.env.OILPRICEAPI_KEY?.trim() ? (await oilPricePair(now))[1] : read("Brent", "BRENT_CONTEXT_URL", now);

type NewsArticle = { title: string; url: string; publishedAt: number };
let oilNewsCache: { fetchedAt: number; item: ContextItem } | undefined;
let oilNewsPending: Promise<ContextItem> | undefined;
const OIL_NEWS_CACHE_MS = 5 * 60 * 1000;
const OIL_RELEVANCE = /\b(?:crude|oil|opec|wti|brent|petroleum|tanker|refiner|gasoline|diesel|fuel price|barrel|pipeline|iran|saudi|russia|hormuz|inventor(?:y|ies)|drilling|shale|sanctions?|embargo|oilfield)\b/i;
// Require an event/action term. Place names and historical comparisons such as
// "Hormuz flows top pre-war levels" describe market context, not a current crisis.
const OIL_EVENT_RISK = /\b(?:attack(?:s|ed)?|missile|drone|strike|sanctions?|embargo|blockade|explosion|fire|outage|shutdown|disruption|supply shock|production cut|output cut|emergency|hurricane|cyclone|hijack(?:ing)?|seizure|inventory surprise|crude stock draw|crude stock build)\b|(?<!pre-)\bwar\b/i;
function xmlText(block: string, tag: string) {
  const value = block.match(new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)</" + tag + ">", "i"))?.[1];
  if (!value) return "";
  return value.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").replace(/<[^>]*>/g, " ")
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_entity, name: string) => {
      if (name.toLowerCase() === "amp") return "&"; if (name.toLowerCase() === "lt") return "<";
      if (name.toLowerCase() === "gt") return ">"; if (name.toLowerCase() === "quot") return "\"";
      if (name.toLowerCase() === "apos") return "'";
      const code = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }).replace(/\s+/g, " ").trim();
}
function parseOilRss(xml: string, now: number): NewsArticle[] {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(match => {
    const item = match[1], title = xmlText(item, "title").slice(0, 300), url = xmlText(item, "link"), publishedAt = Date.parse(xmlText(item, "pubDate"));
    let host = ""; try { host = new URL(url).hostname.toLowerCase(); } catch { /* invalid link */ }
    return { title, url, publishedAt, host };
  }).filter((item): item is NewsArticle & { host: string } => !!item.title && OIL_RELEVANCE.test(item.title)
    && ["oilprice.com", "www.oilprice.com"].includes(item.host) && Number.isFinite(item.publishedAt)
    && item.publishedAt <= now + 5 * 60 * 1000 && item.publishedAt >= now - 24 * 60 * 60 * 1000)
    .slice(0, 20).map(({ title, url, publishedAt }) => ({ title, url, publishedAt }));
}
export function oilNewsEventFlags(titles: string[]) { return titles.filter(title => OIL_EVENT_RISK.test(title)); }async function publicOilNews(now: string): Promise<ContextItem> {
  const nowMs = Date.parse(now);
  if (oilNewsCache && nowMs >= oilNewsCache.fetchedAt && nowMs - oilNewsCache.fetchedAt < OIL_NEWS_CACHE_MS)
    return fresh(oilNewsCache.item.time, now, 900) ? oilNewsCache.item : { ...oilNewsCache.item, status: "UNAVAILABLE" };
  if (!oilNewsPending) oilNewsPending = (async () => {
    const response = await fetch("https://oilprice.com/rss/main", { signal: AbortSignal.timeout(8000), cache: "no-store", headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
    if (!response.ok) throw new Error("Oil news unavailable");
    const articles = parseOilRss(await response.text(), nowMs);
    if (!articles.length) throw new Error("No current oil headlines");
    const flags = oilNewsEventFlags(articles.map(article => article.title));
    const flaggedArticle = articles.find(article => OIL_EVENT_RISK.test(article.title));
    const displayedArticle = flaggedArticle ?? articles[0];
    const item: ContextItem = {
      name: "Oil news", status: "LIVE", source: `OilPrice.com RSS · ${articles.length} recent headlines checked · ${flags.length} event-risk keyword flag${flags.length === 1 ? "" : "s"}${flags.length ? "; entries blocked" : ""}`,
      time: new Date(nowMs).toISOString(), headline: flaggedArticle
        ? `FLAGGED STORY: ${flaggedArticle.title} · matched event-risk keyword; entries blocked · published ${new Date(flaggedArticle.publishedAt).toISOString()}`
        : `${displayedArticle.title} · published ${new Date(displayedArticle.publishedAt).toISOString()}`,
      url: displayedArticle.url, bias: "NEUTRAL", block: flags.length > 0
    };
    oilNewsCache = { fetchedAt: nowMs, item };
    return item;
  })().finally(() => { oilNewsPending = undefined; });
  try {
    const item = await oilNewsPending;
    return fresh(item.time, now, 900) ? item : { ...item, status: "UNAVAILABLE" };
  } catch {
    const item: ContextItem = { name: "Oil news", status: "UNAVAILABLE", source: "OilPrice.com RSS did not return valid headlines from the last 24 hours", bias: "NEUTRAL", block: false };
    oilNewsCache = { fetchedAt: nowMs, item };
    return item;
  }
}
export const oilNews = (now: string) => process.env.OIL_NEWS_URL?.trim() ? read("Oil news", "OIL_NEWS_URL", now) : publicOilNews(now);
export const globalContext = (now: string) => Promise.all([wti(now), brent(now), oilNews(now)]);
