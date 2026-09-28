import { z } from "zod";
import { fresh } from "../time";
import type { ContextItem } from "../types";
const payload = z.object({ source: z.string().min(1), time: z.string().datetime({ offset: true }), value: z.number().positive().optional(), headline: z.string().max(500).optional(), bias: z.enum(["UP", "DOWN", "NEUTRAL"]), block: z.boolean() });
// Configure only an endpoint you are licensed/authorized to access. No scraping or inferred quotes.
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
export const wti = (now: string) => read("WTI", "WTI_CONTEXT_URL", now);
export const brent = (now: string) => read("Brent", "BRENT_CONTEXT_URL", now);
export const oilNews = (now: string) => read("Oil news", "OIL_NEWS_URL", now);
export const globalContext = (now: string) => Promise.all([wti(now), brent(now), oilNews(now)]);
