import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initial, evaluate, enter } from "../src/marketpilot/engine";
import { db, saveState, writeObservation } from "../src/marketpilot/storage";
import { forwardSessionReport, istWindow } from "../src/marketpilot/report";
import { closePosition } from "../src/marketpilot/paper";
import type { LiveObservation } from "../src/marketpilot/feed-types";
const day = "2026-09-14", start = "2026-09-13T18:30:00.000Z", end = "2026-09-14T18:30:00.000Z";
beforeAll(() => { process.env.MARKETPILOT_DATA_DIR = `.marketpilot-tests-report-${crypto.randomUUID()}`; db(); });
beforeEach(() => { for (const table of ["states", "decisions", "live_observations", "forward_events", "forward_entries", "forward_trades", "forward_checkpoints"]) db().exec(`DELETE FROM ${table}`); });
function observation(time: string, status: LiveObservation["status"] = "UNAVAILABLE"): LiveObservation {
  return { id: crypto.randomUUID(), startedAt: time, receivedAt: time, exchangeTime: status === "OK" ? time : null,
    contract: null, price: null, status, reason: "TEST FIXTURE", source: "worker", gapSeconds: 5 };
}
describe("IST forward report ledger completeness", () => {
  it("validates dates and maps inclusive/exclusive boundaries to IST midnight", () => {
    expect(istWindow(day, end)).toMatchObject({ start, end });
    for (const value of ["2026-02-31", "2026-2-14", "invalid", "2026-09-16"]) expect(() => istWindow(value, end)).toThrow();
  });

  it("exports every decision and observation beyond 500, excludes replay and future data", () => {
    const s = initial("LIVE"); s.clock = start; s.days = [{ day, net: 0, peak: 0, trades: 0, locked: false }];
    const insert = db().prepare("INSERT INTO decisions VALUES (?,?,?,?)");
    db().exec("BEGIN");
    for (let i = 0; i < 510; i++) {
      const time = new Date(Date.parse(start) + i * 1000).toISOString(); s.clock = time;
      const d = evaluate(s); insert.run(d.id, "LIVE", time, JSON.stringify(d));
      writeObservation(observation(time));
    }
    db().exec("COMMIT");
    for (const [mode, time] of [["LIVE", "2026-09-13T18:29:59.999Z"], ["LIVE", end], ["REPLAY", start]] as const) {
      const d = evaluate(initial(mode)); d.time = time; insert.run(d.id, mode, time, JSON.stringify(d));
      if (mode === "LIVE") writeObservation(observation(time));
    }
    const report = forwardSessionReport(day, end);
    expect(report.decisions).toHaveLength(510); expect(report.observations).toHaveLength(510);
    expect(report.decisions[0].time).toBe(start); expect(report.decisions.at(-1)?.time).toBe("2026-09-13T18:38:29.000Z");
    expect(report.decisions.every(d => d.reasons.length && d.snapshot.settings && d.ruleVersion)).toBe(true);
    expect(report.outcome.netDaily).toBeNull(); expect(report.coverage.completeMarketCoverage).toBe(false);
    expect(forwardSessionReport(day, "2026-09-13T18:31:00.000Z").decisions).toHaveLength(61);
  });

  it("persists entries, exits, costs, journal, evidence and risk lockouts in separate LIVE records", () => {
    // Controlled synthetic inputs exercise accounting; no market performance inference.
    const s = initial("REPLAY"); evaluate(s); enter(s);
    s.mode = "LIVE"; s.clock = "2026-09-14T17:00:00.000Z"; s.position!.time = s.clock; s.days[0].day = day;
    saveState(s);
    const p = s.position!; const time = "2026-09-14T17:01:00.000Z";
    const trade = closePosition(p, p.entry - 150, time, "Risk test loss");
    s.trades.push(trade); s.position = null; s.clock = time; s.days[0].net = trade.net;
    const d = evaluate(s); saveState(s, d);
    const report = forwardSessionReport(day, time);
    expect(report.entries).toHaveLength(1); expect(report.exits).toHaveLength(1);
    expect(report.outcome.realizedNet).toBe(trade.net); expect(report.outcome.netDaily).toBe(trade.net);
    expect(report.costs.entryChargesOnDate + report.costs.exitChargesOnDate).toBeCloseTo(trade.costs);
    expect(report.riskLockouts).toHaveLength(1);
    expect(report.entries[0]).not.toHaveProperty("exitTime");
    expect(report.decisions[0].reasons.length).toBeGreaterThan(0);
  });

  it("keeps an overnight open position unpriced when no current-day data exists", () => {
    const s = initial("REPLAY"); evaluate(s); enter(s); s.mode = "LIVE";
    s.clock = "2026-09-13T18:29:59.000Z"; s.position!.time = s.clock; s.days[0].day = "2026-09-13"; saveState(s);
    const report = forwardSessionReport(day, end);
    expect(report.outcome.status).toBe("NO_SESSION_CHECKPOINT"); expect(report.outcome.position).not.toBeNull();
    expect(report.outcome.netDaily).toBeNull(); expect(report.entries).toHaveLength(0); expect(report.exits).toHaveLength(0);
  });

  it("does not mark an open position from a stale quote or reconstruct it from later quotes", () => {
    const s = initial("REPLAY"); evaluate(s); enter(s); s.mode = "LIVE";
    s.clock = "2026-09-14T17:00:00.000Z"; s.feedTime = s.clock; s.days[0].day = day;
    const o = { ...observation(s.clock, "OK"), contract: s.contract, price: s.candles.at(-1)!.close };
    s.latestObservation = o; writeObservation(o); saveState(s);
    expect(forwardSessionReport(day, s.clock).outcome.status).toBe("OPEN_POSITION_ESTIMATE");
    const later = "2026-09-14T17:10:00.000Z";
    const stale = forwardSessionReport(day, later);
    expect(stale.outcome.status).toBe("OPEN_POSITION_UNPRICED"); expect(stale.outcome.netDaily).toBeNull();
    expect(stale.outcome.markedDailyEstimate).not.toBeNull();
    writeObservation({ ...o, id: crypto.randomUUID(), startedAt: end, receivedAt: end, exchangeTime: end, price: 9999 });
    expect(forwardSessionReport(day, end).outcome.netDaily).toBeNull();
    expect(forwardSessionReport(day, end).observations).toHaveLength(1);
  });

  it("cannot expose a future exit in an earlier date's backfilled entry", () => {
    const s = initial("REPLAY"); evaluate(s); enter(s); s.mode = "LIVE";
    const p = s.position!; p.time = "2026-09-14T17:00:00.000Z";
    const trade = closePosition(p, p.entry + 50, "2026-09-15T17:00:00.000Z", "fixture");
    s.trades = [trade]; s.position = null; s.clock = trade.exitTime; s.days[0].day = "2026-09-15";
    saveState(s);
    const report = forwardSessionReport(day, "2026-09-16T00:00:00.000Z");
    expect(report.entries).toHaveLength(1); expect(report.exits).toHaveLength(0);
    expect(report.entries[0]).not.toHaveProperty("exit"); expect(report.entries[0]).not.toHaveProperty("net");
  });
});
