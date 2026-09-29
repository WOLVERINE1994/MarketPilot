import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as broker from "../src/marketpilot/adapters/smartapi";
import * as context from "../src/marketpilot/adapters/context";
import { initial, operate } from "../src/marketpilot/engine";
import { db, readState, saveState, observationRows, writeObservation } from "../src/marketpilot/storage";
import { temporalStatus, feedHealth } from "../src/marketpilot/feed";
import { forwardSessionReport } from "../src/marketpilot/report";
import type { Contract, ContextItem } from "../src/marketpilot/types";
import type { LiveObservation } from "../src/marketpilot/feed-types";

const now = "2026-09-14T17:30:00.000Z";
const contract: Contract = { symbol: "CRUDEOILM21SEP26FUT", token: "12345", expiry: "2026-09-21", lotSize: 10, multiplier: 10, tickSize: 1, source: "https://www.mcxindia.com/test-fixture", verified: true };
const credentials = ["ANGEL_API_KEY", "ANGEL_ACCESS_TOKEN", "ANGEL_CLIENT_LOCAL_IP", "ANGEL_CLIENT_PUBLIC_IP", "ANGEL_MAC_ADDRESS", "MARKETPILOT_SPECS_FILE"];
function contextFixtures(time: string, status: ContextItem["status"]): [ContextItem, ContextItem, ContextItem] {
  const item = (name: string): ContextItem => ({ name, status, source: "MOCK TEST ONLY", time, bias: "NEUTRAL", block: false });
  return [item("WTI"), item("Brent"), item("Oil news")];
}
beforeAll(() => { process.env.MARKETPILOT_DATA_DIR = `.marketpilot-tests-live-${crypto.randomUUID()}`; db(); });
beforeEach(() => {
  for (const table of ["states", "decisions", "leases", "live_observations", "forward_events", "forward_entries", "forward_trades", "forward_checkpoints"]) db().exec(`DELETE FROM ${table}`);
  vi.useFakeTimers(); vi.setSystemTime(now);
  for (const key of credentials) vi.stubEnv(key, "local-test-placeholder");
  vi.spyOn(broker, "currentContract").mockResolvedValue(contract);
  vi.spyOn(broker, "quote").mockImplementation(async () => ({ price: 6064, time: new Date().toISOString() }));
  vi.spyOn(context, "globalContext").mockImplementation(async time => contextFixtures(time, "LIVE"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const samples = () => observationRows("SELECT json FROM live_observations ORDER BY rowid");
function seedTrend() {
  const s = initial("LIVE"); s.contract = contract;
  s.candles = Array.from({ length: 32 }, (_, i) => ({ time: new Date(Date.parse(now) - (32 - i) * 60000).toISOString(), open: 6000 + i * 2, high: 6001 + i * 2, low: 5999 + i * 2, close: 6000 + i * 2, volume: 0 }));
  saveState(s);
}

describe("durable LIVE ingestion and paper fills", () => {
  it("records disconnected unconfigured worker sessions and an honest 23:00 assessment", async () => {
    vi.stubEnv("ANGEL_API_KEY", "");
    vi.mocked(context.globalContext).mockResolvedValue(contextFixtures(now, "UNAVAILABLE"));
    const s = await operate("LIVE", "worker");
    expect(s.decision?.action).toBe("WAIT"); expect(s.candles).toHaveLength(0);
    expect(s.decision?.reasons.join(" ")).not.toContain("already used this candle");
    expect(s.feedHealth).toMatchObject({ configured: false, connection: "NOT_VERIFIED", failedSamples: 1, validSamples: 0, workerStatus: "RUNNING" });
    expect(samples()[0]).toMatchObject({ status: "UNAVAILABLE", startedAt: now, receivedAt: now, exchangeTime: null, contract: null, price: null, source: "worker" });
    expect(broker.quote).not.toHaveBeenCalled();
    expect(s.assessment?.text).toContain("Market conclusion unavailable");
    expect(s.assessment?.text).not.toContain("UNAVAILABLE/NEUTRAL");
    const report = forwardSessionReport("2026-09-14", now);
    expect(report.assessments).toHaveLength(1); expect(report.entries).toHaveLength(0); expect(report.decisions).toHaveLength(1);
  });

  it.each([
    ["STALE", -31000], ["FUTURE_DATED", 1], ["OUT_OF_ORDER", -1], ["DUPLICATE", 0],
  ] as const)("rejects %s before candle mutation and never fills a requested entry", async (status, offset) => {
    seedTrend(); const valid = await operate("LIVE", "refresh"); expect(valid.decision?.action).toBe("BUY");
    const before = structuredClone(valid.candles);
    vi.setSystemTime(Date.parse(now) + 40000);
    // STALE remains later than the accepted quote; ordering and freshness are independent.
    const time = new Date(status === "STALE" || status === "FUTURE_DATED" ? Date.now() + offset : Date.parse(now) + offset).toISOString();
    vi.mocked(broker.quote).mockResolvedValue({ price: 9999, time });
    await expect(operate("LIVE", "enter")).rejects.toThrow(/blocked/);
    const s = readState("LIVE")!;
    expect(s.candles).toEqual(before); expect(s.position).toBeNull(); expect(s.trades).toHaveLength(0);
    // An old duplicate is STALE, which also prevents fills.
    expect(samples().at(-1)?.status).toBe(status === "DUPLICATE" ? "STALE" : status);
    expect(samples().at(-1)?.price).toBeNull(); expect(s.decision?.snapshot.observationId).toBe(samples().at(-1)?.id);
  });

  it("rejects a fresh duplicate and survives broker transport/mismatch/malformed responses without storing secrets", async () => {
    await operate("LIVE", "refresh");
    expect((await operate("LIVE", "refresh")).latestObservation?.status).toBe("DUPLICATE");
    for (const status of ["CONTRACT_MISMATCH", "MALFORMED", "UNAVAILABLE"] as const) {
      vi.mocked(broker.quote).mockRejectedValue(new broker.QuoteError(status, now));
      const s = await operate("LIVE", "refresh");
      expect(s.latestObservation).toMatchObject({ status, price: null, contract, exchangeTime: now });
    }
    vi.mocked(broker.quote).mockRejectedValue(new Error("secret-token raw sensitive broker payload"));
    await operate("LIVE", "refresh");
    expect(JSON.stringify(samples())).not.toMatch(/secret-token|local-test-placeholder|sensitive broker/);
    expect(samples()).toHaveLength(6);
  });

  it("defers both automatic and manual exits during disconnection, then exits using a new valid quote", async () => {
    seedTrend(); const entered = await operate("LIVE", "enter"); expect(entered.position).not.toBeNull();
    vi.setSystemTime(Date.parse(now) + 10000);
    vi.mocked(broker.quote).mockRejectedValue(new broker.QuoteError("UNAVAILABLE"));
    const disconnected = await operate("LIVE", "worker");
    expect(disconnected.decision?.action).toBe("EXIT"); expect(disconnected.trades).toHaveLength(0); expect(disconnected.position).not.toBeNull();
    await expect(operate("LIVE", "exit")).rejects.toThrow(/fresh quote/);
    expect(readState("LIVE")?.trades).toHaveLength(0);
    vi.setSystemTime(Date.parse(now) + 45000);
    vi.mocked(broker.quote).mockResolvedValue({ price: 6064, time: new Date().toISOString() });
    const recovered = await operate("LIVE", "worker");
    expect(recovered.trades).toHaveLength(1); expect(recovered.position).toBeNull();
    expect(recovered.trades[0].exit).toBe(6062); // observed quote minus original spread/slippage, no retrospective fill
    expect(recovered.feedHealth?.largestGapSeconds).toBe(45);
    expect(recovered.journal.some(event => event.kind === "FEED_GAP")).toBe(true);
    const report = forwardSessionReport("2026-09-14", new Date().toISOString());
    expect(report.entries).toHaveLength(1); expect(report.exits).toHaveLength(1);
    expect(report.costs.closedTradeCharges).toBeCloseTo(recovered.trades[0].costs);
    expect(report.outcome.realizedNet).toBeCloseTo(recovered.trades[0].net);
  });

  it("refuses fills if held contract monetary identity changes during reverification", async () => {
    seedTrend(); await operate("LIVE", "enter"); vi.setSystemTime(Date.parse(now) + 5000);
    vi.mocked(broker.currentContract).mockResolvedValue({ ...contract, multiplier: 100 });
    const s = await operate("LIVE", "worker");
    expect(s.latestObservation?.status).toBe("CONTRACT_MISMATCH"); expect(s.position?.contract.multiplier).toBe(10); expect(s.trades).toHaveLength(0);
  });

  it.each(["STALE", "FUTURE_DATED", "OUT_OF_ORDER", "DUPLICATE", "CONTRACT_MISMATCH", "MALFORMED"] as const)("never fills an open position exit from %s data", async status => {
    seedTrend(); await operate("LIVE", "enter"); vi.setSystemTime(Date.parse(now) + 5000);
    if (status === "CONTRACT_MISMATCH" || status === "MALFORMED") vi.mocked(broker.quote).mockRejectedValue(new broker.QuoteError(status, now));
    else {
      const time = status === "STALE" ? new Date(Date.parse(now) + 1000).toISOString() : status === "FUTURE_DATED" ? new Date(Date.now() + 1000).toISOString() : status === "OUT_OF_ORDER" ? new Date(Date.parse(now) - 1000).toISOString() : now;
      if (status === "STALE") vi.setSystemTime(Date.parse(now) + 40000);
      vi.mocked(broker.quote).mockResolvedValue({ price: 1, time });
    }
    await expect(operate("LIVE", "exit")).rejects.toThrow(/fresh quote/);
    const s = readState("LIVE")!;
    expect(s.latestObservation?.status).toBe(status); expect(s.position).not.toBeNull(); expect(s.trades).toHaveLength(0);
    expect(s.decision?.action).toBe("EXIT"); expect(s.pendingExitReason).toBeTruthy();
  });

  it("starts with a durable PENDING record and classifies interrupted attempts on restart", async () => {
    const pending: LiveObservation = { id: "interrupted-test", startedAt: new Date(Date.parse(now) - 180000).toISOString(), receivedAt: null, exchangeTime: null, contract, price: null, status: "PENDING", reason: "started", source: "worker", gapSeconds: null };
    writeObservation(pending);
    vi.mocked(broker.quote).mockImplementation(async () => {
      const row = samples().at(-1)!;
      expect(row.status).toBe("PENDING"); expect(row.contract?.token).toBe(contract.token);
      return { price: 6000, time: now };
    });
    const s = await operate("LIVE", "worker");
    expect(samples()[0].status).toBe("INTERRUPTED"); expect(s.feedHealth?.failedSamples).toBe(1);
    vi.setSystemTime(Date.parse(now) + 60000);
    expect(feedHealth(readState("LIVE")!)).toMatchObject({ connection: "DISCONNECTED", workerStatus: "STOPPED_OR_NOT_STARTED", ageSeconds: 60 });
  });

  it("records a daily risk lockout with its evidence and keeps default thresholds", async () => {
    seedTrend(); const s = readState("LIVE")!; s.days[0].net = -1200; saveState(s);
    const result = await operate("LIVE", "worker");
    expect(result.days[0].locked).toBe(true); expect(result.decision?.action).toBe("WAIT");
    expect(forwardSessionReport("2026-09-14", now).riskLockouts).toHaveLength(1);
    expect(result.settings).toMatchObject({ fast: 5, slow: 20, momentum: 0.035, maxVolatility: 1.2, riskPerTrade: 600, dailyLoss: 1200 });
  });
});

it("uses strict receipt chronology including the exact freshness boundary", () => {
  expect(temporalStatus("2026-09-14T17:29:30.000Z", now, null)).toBe("OK");
  expect(temporalStatus("2026-09-14T17:29:29.999Z", now, null)).toBe("STALE");
  expect(temporalStatus("2026-09-14T17:30:00.001Z", now, null)).toBe("FUTURE_DATED");
  expect(temporalStatus("invalid", now, null)).toBe("MALFORMED");
});
