import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveContract, type Instrument, type Specification } from "../src/marketpilot/contracts";
import { defaults } from "../src/marketpilot/types";
import { closePosition, costs, fillPrice } from "../src/marketpilot/paper";
import { initial, enter, evaluate, assess, currentDay, view } from "../src/marketpilot/engine";
import { decide } from "../src/marketpilot/rules";
import { updateLock, riskBlock } from "../src/marketpilot/risk";
import { fresh, istDay, istMinute } from "../src/marketpilot/time";
import { loadReplay, observed, replayContext } from "../src/marketpilot/adapters/replay";
import { exchangeTime, quote } from "../src/marketpilot/adapters/smartapi";
import { marketChatSnapshot } from "../src/marketpilot/chat-context";
import { wti, oilNews, oilNewsEventFlags } from "../src/marketpilot/adapters/context";
import { inApp } from "../src/marketpilot/notifications";
import { readState, saveState, exclusive, decisions } from "../src/marketpilot/storage";
import { proxy } from "../src/proxy";
import { NextRequest } from "next/server";
const now = "2026-09-14T16:00:00Z";
const row: Instrument = { name: "CRUDEOILM", symbol: "CRUDEOILM21SEP26FUT", token: "12345", expiry: "21SEP2026", lotsize: "10", tick_size: "100.000000", exch_seg: "MCX", instrumenttype: "FUTCOM" };
const spec: Specification = { symbol: row.symbol, expiry: "2026-09-21", lotSize: 10, multiplier: 10, tickSize: 1, source: "https://www.mcxindia.com/products/energy/crude-oil", verifiedAt: "2026-09-14T00:00:00Z", validUntil: "2026-09-21T00:00:00Z" };
function trending(cursor = 45) { const s = initial("REPLAY"), replay = loadReplay(); s.cursor = cursor; s.candles = observed(replay, cursor); s.clock = s.candles.at(-1)!.time; s.feedTime = s.clock; s.context = replayContext(s.clock); return s; }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("contract boundary", () => {
  it("resolves only exact mini futures and derives monetary specs", () => {
    expect(resolveContract([{ ...row, name: "CRUDEOIL", symbol: "CRUDEOIL21SEP26FUT" }, { ...row, instrumenttype: "OPTFUT" }, row], [spec], now)).toMatchObject({ symbol: row.symbol, multiplier: 10, lotSize: 10, tickSize: 1 });
  });
  it("fails closed for missing or mismatched specifications", () => {
    expect(() => resolveContract([row], [], now)).toThrow(/unverified/);
    expect(() => resolveContract([row], [{ ...spec, lotSize: 100 }], now)).toThrow(/disagree/);
    expect(() => resolveContract([row], [{ ...spec, source: "https://example.com" }], now)).toThrow();
    expect(() => resolveContract([row], [{ ...spec, validUntil: now }], now)).toThrow();
  });
  it("rejects regular crude, options, expired contracts, and rolls on expiry IST day", () => {
    expect(() => resolveContract([{ ...row, name: "CRUDEOIL" }], [spec], now)).toThrow();
    expect(() => resolveContract([row], [spec], "2026-09-20T18:30:00Z")).toThrow(/No tradable/);
    const next = { ...row, symbol: "CRUDEOILM19OCT26FUT", expiry: "19OCT2026" };
    expect(resolveContract([next, row], [spec], now).symbol).toBe(row.symbol);
  });
});
describe("MarketPilot chat context", () => {
  function readyState(time: string) {
    const state = initial("LIVE"), contract = { ...loadReplay().contract, verified: true };
    state.clock = time; state.contract = contract; state.feed = "CONNECTED"; state.feedTime = time;
    state.candles = Array.from({ length: 60 }, (_, index) => ({ time: new Date(Date.parse(time) - (59 - index) * 60000).toISOString(), open: 6000, high: 6002, low: 5998, close: 6001, volume: 0 }));
    state.latestObservation = { id: "obs", startedAt: time, receivedAt: time, exchangeTime: time, contract, price: 6001, status: "OK", reason: "Fresh accepted test observation", source: "worker", gapSeconds: 0 };
    state.context = ["WTI", "Brent", "Oil news"].map(name => ({ name, status: "LIVE", source: "test feed", time, bias: "NEUTRAL", block: false }));
    state.decision = { action: "BUY", reasons: ["Rules allow a paper setup"], entry: 6001, stop: 5990, target: 6023, estimatedCosts: 40, maxRisk: 150 } as NonNullable<typeof state.decision>;
    return state;
  }
  it("shares only recent observed candles and preserves a rule-approved setup", () => {
    const time = "2026-10-08T05:00:00.000Z", snapshot = marketChatSnapshot(readyState(time), Date.parse(time));
    expect(snapshot.recommendation).toBe("BUY"); expect(snapshot.entryAllowed).toBe(true);
    expect(snapshot.candles).toHaveLength(50); expect(snapshot.feed?.status).toBe("FRESH");
  });
  it("forces WAIT when stored BUY evidence has gone stale", () => {
    const time = "2026-10-08T05:00:00.000Z", snapshot = marketChatSnapshot(readyState(time), Date.parse(time) + 31_000);
    expect(snapshot.recommendation).toBe("WAIT"); expect(snapshot.entryAllowed).toBe(false);
    expect(snapshot.reasons[0]).toContain("not verified and fresh");
  });
});
describe("paper accounting", () => {
  it("accounts for both sides, multiplier, spread, slippage and charges for long and short", () => {
    for (const side of ["BUY", "SELL"] as const) {
      const sign = side === "BUY" ? 1 : -1;
      const entry = fillPrice(6000, sign, 1, defaults);
      const p = { side, entry, stop: 5980, target: 6040, time: now, contract: loadReplay().contract, entryCosts: costs(entry, 10, defaults), maxRisk: 300, settings: defaults };
      const t = closePosition(p, 6000 + sign * 10, now, "test");
      expect(t.gross).toBe(60);
      expect(t.costs).toBeCloseTo(40 + (entry + t.exit) * 10 * 2.5 / 10000);
      expect(t.net).toBeCloseTo(t.gross - t.costs);
    }
  });
  it("requires a stop and a risk budget; never adds to an open position", () => {
    const s = trending(); evaluate(s); expect(s.decision?.action).toBe("BUY"); enter(s);
    expect(s.position?.maxRisk).toBeGreaterThan(0); expect(() => enter(s)).toThrow();
    const limited = trending(); limited.settings.riskPerTrade = 1;
    expect(decide(limited, 0).action).toBe("WAIT");
  });
  it("stop fills include adverse gaps and stop wins ambiguous OHLC bars", () => {
    const s = trending(); evaluate(s); enter(s); const p = s.position!;
    const time = new Date(Date.parse(s.clock) + 60000).toISOString();
    s.candles.push({ time, open: p.stop - 12, high: p.target + 10, low: p.stop - 20, close: p.stop - 5, volume: 100 }); s.clock = time; s.feedTime = time;
    expect(evaluate(s).action).toBe("EXIT"); expect(s.position).toBeNull();
    expect(s.trades[0].exit).toBe(p.stop - 14); expect(s.trades[0].reason).toMatch(/stop/);
  });
});
describe("feed and rule transitions", () => {
  it("WAIT → BUY → EXIT on reversal; SELL is available on a downtrend", () => {
    const flat = initial("REPLAY"); flat.candles = flat.candles.map(b => ({ ...b, open: 6000, close: 6000, high: 6001, low: 5999 }));
    expect(decide(flat, 0).action).toBe("WAIT");
    const s = trending(); evaluate(s); enter(s);
    const r = trending(79); r.position = s.position; expect(decide(r, 0).action).toBe("EXIT");
    expect(decide(trending(140), 0).action).toBe("SELL");
  });
  it("blocks stale, disconnected, unverified, future timestamps and missing global context", () => {
    for (const mutate of [(s: ReturnType<typeof initial>) => { s.feed = "DISCONNECTED"; }, (s: ReturnType<typeof initial>) => { s.feedTime = "2026-01-01T00:00:00Z"; }, (s: ReturnType<typeof initial>) => { s.contract!.verified = false; }, (s: ReturnType<typeof initial>) => { s.context[0].status = "UNAVAILABLE"; }]) {
      const s = trending(); mutate(s); expect(decide(s, 0).action).toBe("WAIT");
    }
    expect(fresh("2026-09-14T16:01:00Z", now)).toBe(false);
  });
  it("emits immediate EXIT on disconnection but invents no fill", () => {
    const s = trending(); evaluate(s); enter(s); s.feed = "DISCONNECTED";
    expect(evaluate(s).action).toBe("EXIT"); expect(s.position).not.toBeNull(); expect(s.trades).toHaveLength(0);
  });
  it("deduplicates repeated alerts without dropping distinct transitions", () => {
    const s = trending(); inApp.deliver(s, decide(s, 0)); inApp.deliver(s, decide(s, 0)); expect(s.journal).toHaveLength(1);
    s.settings.paused = true; inApp.deliver(s, decide(s, 0)); expect(s.journal).toHaveLength(2);
  });
});
describe("risk protection", () => {
  it("locks on loss, stays locked despite recovery, and enforces trade cap and pause", () => {
    const day = initial("REPLAY").days[0]; updateLock(day, -1200, defaults); updateLock(day, 2000, defaults);
    expect(day.locked).toBe(true); expect(riskBlock(defaults, day, 2000).length).toBeGreaterThan(0);
    expect(riskBlock({ ...defaults, paused: true }, { ...day, locked: false, trades: 3 }, 0)).toHaveLength(2);
  });
  it("locks profit giveback and creates a fresh IST-day risk budget", () => {
    const s = initial("REPLAY"); updateLock(s.days[0], 1100, defaults); updateLock(s.days[0], 700, defaults); expect(s.days[0].locked).toBe(true);
    s.clock = "2026-09-14T18:30:00Z"; expect(currentDay(s).locked).toBe(false);
  });
});
describe("replay and IST chronology", () => {
  it("cannot see future candles and leaves the fixture immutable", () => {
    const replay = loadReplay(); const bars = observed(replay, 33); expect(bars).toHaveLength(33); expect(bars.at(-1)!.time).toBe(replay.candles[32].time); expect(bars.some(b => b.time > replay.candles[32].time)).toBe(false);
    expect(observed(replay, -1)).toHaveLength(0); expect(replay.candles).toHaveLength(220);
  });
  it("handles IST midnight and the 23:00 assessment independently of UTC", () => {
    expect(istDay("2026-09-14T18:29:59Z")).toBe("2026-09-14"); expect(istDay("2026-09-14T18:30:00Z")).toBe("2026-09-15"); expect(istMinute("2026-09-14T17:30:00Z")).toBe("23:00");
    const s = initial("REPLAY"); s.clock = "2026-09-14T17:29:00Z"; assess(s, true); expect(s.scheduledDay).toBeUndefined(); s.clock = "2026-09-14T17:30:00Z"; assess(s); assess(s); expect(s.journal.filter(j => j.kind === "ASSESSMENT")).toHaveLength(2);
  });
  it("carries open MTM across midnight without erasing overnight losses", () => {
    const s = trending(); evaluate(s); enter(s); s.lastMark = -100; s.clock = "2026-09-14T18:30:00Z";
    const day = currentDay(s); expect(day.openingMark).toBe(-100); expect(s.days[0].closingMark).toBe(-100);
    expect(view(s).equity).toBeCloseTo(view(s).unrealized + 100);
  });
});
describe("authorized adapters", () => {
  it("parses SmartAPI exchange times without using the machine timezone", () => {
    expect(exchangeTime("14-Sep-2026 23:00:00")).toBe("2026-09-14T17:30:00.000Z"); expect(() => exchangeTime("ambiguous")).toThrow();
  });
  it("calls only the quote endpoint with the resolved token; validates the response", async () => {
    for (const key of ["ANGEL_API_KEY", "ANGEL_ACCESS_TOKEN", "ANGEL_CLIENT_LOCAL_IP", "ANGEL_CLIENT_PUBLIC_IP", "ANGEL_MAC_ADDRESS"]) vi.stubEnv(key, "test-placeholder");
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: true, data: { fetched: [{ symbolToken: row.token, tradingSymbol: row.symbol, exchange: "MCX", ltp: 6000, exchFeedTime: "14-Sep-2026 23:00:00" }] } }) });
    vi.stubGlobal("fetch", fetcher); const contract = resolveContract([row], [spec], now);
    expect((await quote(contract)).price).toBe(6000); expect(fetcher.mock.calls[0][0]).toContain("market/v1/quote"); expect(fetcher.mock.calls[0][1].body).toContain(row.token);
    await expect(quote({ ...contract, token: "999" })).rejects.toThrow(/verified/);
  });
  it("never invents global live values when unconfigured or stale", async () => {
    vi.stubEnv("WTI_CONTEXT_URL", ""); expect((await wti(now)).status).toBe("UNAVAILABLE");
    vi.stubEnv("WTI_CONTEXT_URL", "https://licensed.example/quote"); vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ source: "Licensed fixture", time: "2026-01-01T00:00:00Z", value: 60, bias: "UP", block: false }) }));
    expect((await wti(now)).status).toBe("UNAVAILABLE");
  });
  it("loads timestamp-verified WTI and Brent together from OilPriceAPI", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date());
    vi.stubEnv("OILPRICEAPI_KEY", "test-only-key");
    const time = new Date().toISOString();
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "success", data: { prices: [
      { code: "WTI_USD", price: 72, unit: "USD/barrel", as_of: time, data_status: "current", changes: { "24h": { percent: 1.2, span_hours: 24 } } },
      { code: "BRENT_CRUDE_USD", price: 76, unit: "USD/barrel", as_of: time, data_status: "current", changes: { "24h": { percent: -0.8, span_hours: 24 } }
    }], metadata: { source_description: "Provider fixture" } } }) });
    vi.stubGlobal("fetch", fetcher);
    const { globalContext } = await import("../src/marketpilot/adapters/context");
    const items = await globalContext(time);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.find(call => String(call[0]).includes("api.oilpriceapi.com"))?.[0]).toContain("WTI_USD,BRENT_CRUDE_USD");
    expect(items[0]).toMatchObject({ name: "WTI", status: "LIVE", value: 72, bias: "UP" });
    expect(items[1]).toMatchObject({ name: "Brent", status: "LIVE", value: 76, bias: "DOWN" });
    expect(items[2].status).toBe("UNAVAILABLE");
  });
  it("loads timestamped WTI and Brent spot quotes from Twelve Data", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(now));
    vi.stubEnv("TWELVE_DATA_API_KEY", "test-only-key"); vi.stubEnv("OILPRICEAPI_KEY", "");
    const timestamp = Math.floor(Date.parse(now) / 1000);
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const symbol = url.searchParams.get("symbol")!;
      return { ok: true, json: async () => ({ symbol, close: symbol === "WTI/USD" ? "72.5" : "76.5", timestamp, percent_change: symbol === "WTI/USD" ? "1.2" : "-0.8" }) };
    });
    vi.stubGlobal("fetch", fetcher);
    const { wti: readWti, brent: readBrent } = await import("../src/marketpilot/adapters/context");
    const items = await Promise.all([readWti(now), readBrent(now)]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(items[0]).toMatchObject({ name: "WTI", status: "LIVE", value: 72.5, bias: "UP" });
    expect(items[1]).toMatchObject({ name: "Brent", status: "LIVE", value: 76.5, bias: "DOWN" });
    expect(fetcher.mock.calls.map(call => new URL(String(call[0])).searchParams.get("symbol"))).toContain("XBR/USD");
  });
  it("uses OilPriceAPI freshness cadence while keeping the global context limit capped at 30 minutes", async () => {
    vi.useFakeTimers();
    const checkedAt = "2026-10-05T07:00:00.000Z"; vi.setSystemTime(new Date(checkedAt));
    vi.stubEnv("OILPRICEAPI_KEY", "test-only-key"); vi.stubEnv("TWELVE_DATA_API_KEY", "");
    const recent = new Date(Date.parse(checkedAt) - 16 * 60_000).toISOString();
    const stale = new Date(Date.parse(checkedAt) - 31 * 60_000).toISOString();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { prices: [
      { code: "WTI_USD", price: 72, as_of: recent, data_status: "current", freshness: { status: "current", expected_max_age_seconds: 1800 } },
      { code: "BRENT_CRUDE_USD", price: 76, as_of: stale, data_status: "current", freshness: { status: "current", expected_max_age_seconds: 1800 } }
    ] } }) }));
    const { wti: readWti, brent: readBrent } = await import("../src/marketpilot/adapters/context");
    const item = await readWti(checkedAt), old = await readBrent(checkedAt);
    expect(item).toMatchObject({ status: "LIVE", value: 72, freshnessSeconds: 1800 });
    expect(old).toMatchObject({ status: "UNAVAILABLE", value: 76 });
    expect(old.source).toContain("31 minutes old; provider freshness limit is 30 minutes");
  });
  it("loads recent OilPrice.com RSS headlines and blocks titles with event-risk terms", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(now)); vi.stubEnv("OIL_NEWS_URL", "");
    const published = new Date(now).toUTCString();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => `<?xml version="1.0"?><rss><channel><item><title>Oil supply disruption at Strait of Hormuz</title><link>https://oilprice.com/Energy/Crude-Oil/story.html</link><pubDate>${published}</pubDate></item></channel></rss>` }));
    const item = await oilNews(now);
    expect(item).toMatchObject({ status: "LIVE", bias: "NEUTRAL", block: true, url: "https://oilprice.com/Energy/Crude-Oil/story.html" });
    expect(item.headline).toContain("Oil supply disruption at Strait of Hormuz");
  });
  it("shows the specific flagged story when another headline is newer", async () => {
    const newsNow = new Date(Date.parse(now) + 6 * 60_000).toISOString();
    vi.useFakeTimers(); vi.setSystemTime(new Date(newsNow)); vi.stubEnv("OIL_NEWS_URL", "");
    const published = new Date(newsNow).toUTCString();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => `<?xml version="1.0"?><rss><channel>
      <item><title>Oil demand outlook remains steady</title><link>https://oilprice.com/Energy/Crude-Oil/newer.html</link><pubDate>${published}</pubDate></item>
      <item><title>OPEC announces crude production cut</title><link>https://oilprice.com/Energy/Crude-Oil/flagged.html</link><pubDate>${published}</pubDate></item>
      </channel></rss>` }));
    const item = await oilNews(newsNow);
    expect(item).toMatchObject({ status: "LIVE", block: true, url: "https://oilprice.com/Energy/Crude-Oil/flagged.html" });
    expect(item.headline).toContain("FLAGGED STORY: OPEC announces crude production cut");
  });
  it("does not treat a place-name or pre-war comparison as a current crisis event", () => {
    expect(oilNewsEventFlags(["Oil Prices Fall as Reports Say Hormuz Crude Flows Top Pre-War Levels"])).toEqual([]);
    expect(oilNewsEventFlags(["Attack disrupts crude flows through the Strait of Hormuz"])).toHaveLength(1);
  });
});
describe("persistence and privacy", () => {
  it("persists decisions and positions with isolated modes and excludes concurrent writers", async () => {
    vi.stubEnv("MARKETPILOT_DATA_DIR", `.marketpilot-tests-${crypto.randomUUID()}`);
    const s = trending(); const decision = evaluate(s); enter(s); saveState(s, decision);
    expect(readState("REPLAY")?.position?.entry).toBe(s.position?.entry);
    expect(readState("LIVE")).toBeNull(); expect(decisions("REPLAY")[0].id).toBe(decision.id);
    await exclusive("REPLAY", async () => { await expect(exclusive("REPLAY", async () => true)).rejects.toThrow(/busy/); });
    expect(await exclusive("REPLAY", async () => true)).toBe(true);
  });
  it("denies production without a password and enforces configured private access", () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("MARKETPILOT_PASSWORD", "");
    expect(proxy(new NextRequest("http://localhost/" )).status).toBe(503);
    vi.stubEnv("MARKETPILOT_PASSWORD", "test-only-password");
    expect(proxy(new NextRequest("http://localhost/" )).status).toBe(401);
    const authorization = `Basic ${Buffer.from("pilot:test-only-password").toString("base64")}`;
    expect(proxy(new NextRequest("http://localhost/", { headers: { authorization } })).status).toBe(200);
  });
});
