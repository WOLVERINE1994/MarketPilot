import { readFile } from "node:fs/promises";
import { z } from "zod";
import { istDay } from "./time";

export type MarketSession = {
  day: string;
  status: "OPEN" | "CLOSING" | "CLOSED" | "UNVERIFIED";
  entriesAllowed: boolean;
  reason: string;
  source: string | null;
  opensAt: string | null;
  closesAt: string | null;
};
const timestamp = z.iso.datetime({ offset: true });
const calendarSchema = z.object({
  source: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "mcxindia.com" || url.hostname.endsWith(".mcxindia.com"));
  }),
  verifiedAt: timestamp,
  validUntil: timestamp,
  days: z.array(z.object({
    date: z.iso.date(),
    windows: z.array(z.object({ opensAt: timestamp, closesAt: timestamp })),
  })),
});

// Exact reviewed dates cover holidays, special sessions and seasonal closes.
// Missing dates never fall back to assumed weekday hours.
export function reviewSession(input: unknown, now: string): MarketSession {
  const base: MarketSession = { day: istDay(now), status: "UNVERIFIED", entriesAllowed: false,
    reason: "MCX session calendar is missing, expired or unverified; new entries blocked",
    source: null, opensAt: null, closesAt: null };
  const parsed = calendarSchema.safeParse(input);
  if (!parsed.success) return base;
  const calendar = parsed.data, instant = Date.parse(now);
  if (Date.parse(calendar.verifiedAt) > instant || Date.parse(calendar.validUntil) <= instant ||
    new Set(calendar.days.map(day => day.date)).size !== calendar.days.length) return base;
  for (const day of calendar.days) {
    let previousClose = -Infinity;
    for (const window of day.windows) {
      const open = Date.parse(window.opensAt), close = Date.parse(window.closesAt);
      if (open >= close || open < previousClose || istDay(window.opensAt) !== day.date ||
        istDay(window.closesAt) !== day.date || close > Date.parse(calendar.validUntil)) return base;
      previousClose = close;
    }
  }
  const day = calendar.days.find(day => day.date === base.day);
  if (!day) return base;
  const result = { ...base, source: calendar.source, status: "CLOSED" as MarketSession["status"],
    reason: day.windows.length ? "Outside the reviewed MCX session; new entries blocked" : "Reviewed MCX holiday / closed day; new entries blocked" };
  const window = day.windows.find(window => instant >= Date.parse(window.opensAt) && instant < Date.parse(window.closesAt));
  if (!window) return result;
  const closing = Date.parse(window.closesAt) - instant <= 5 * 60000;
  return { ...result, ...window, status: closing ? "CLOSING" : "OPEN", entriesAllowed: !closing,
    reason: closing ? "Final five minutes of the reviewed MCX session; exit paper positions and block new entries" : "Within the reviewed MCX session; 23:00 does not require a trade" };
}

export async function marketSession(now: string): Promise<MarketSession> {
  try {
    const path = process.env.MARKETPILOT_SESSION_FILE;
    return reviewSession(path ? JSON.parse(await readFile(path, "utf8")) : null, now);
  } catch {
    // Never expose local paths, file contents or parser errors.
    return reviewSession(null, now);
  }
}
