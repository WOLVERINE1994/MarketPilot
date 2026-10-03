import { afterEach, describe, expect, it, vi } from "vitest";
import { marketSession, reviewSession } from "../src/marketpilot/session";
import { initial, enter, evaluate } from "../src/marketpilot/engine";
import { loadReplay, observed, replayContext } from "../src/marketpilot/adapters/replay";
import { decide } from "../src/marketpilot/rules";
import { missingLiveSettings } from "../src/marketpilot/feed";

const calendar = {
  source: "https://www.mcxindia.com/test-fixture", verifiedAt: "2026-09-13T00:00:00Z", validUntil: "2026-09-15T18:00:00Z",
  days: [{ date: "2026-09-14", windows: [{ opensAt: "2026-09-14T09:00:00+05:30", closesAt: "2026-09-14T23:30:00+05:30" }] },
    { date: "2026-09-15", windows: [] }],
};
afterEach(() => vi.unstubAllEnvs());
function trend() {
  const s = initial("REPLAY"); s.candles = observed(loadReplay(), 45);
  s.clock = s.candles.at(-1)!.time; s.feedTime = s.clock; s.context = replayContext(s.clock);
  return s;
}
describe("reviewed MCX sessions", () => {
  it("allows 23:00 only inside a reviewed session and blocks the final five minutes", () => {
    expect(reviewSession(calendar, "2026-09-14T23:00:00+05:30")).toMatchObject({ status: "OPEN", entriesAllowed: true });
    expect(reviewSession(calendar, "2026-09-14T23:25:00+05:30")).toMatchObject({ status: "CLOSING", entriesAllowed: false });
    for (const time of ["08:59:59", "23:30:00"]) expect(reviewSession(calendar, `2026-09-14T${time}+05:30`).status).toBe("CLOSED");
    expect(reviewSession(calendar, "2026-09-14T09:00:00+05:30").entriesAllowed).toBe(true);
  });
  it("honors holidays, missing dates and reviewed special evening sessions", () => {
    expect(reviewSession(calendar, "2026-09-15T11:00:00+05:30").status).toBe("CLOSED");
    expect(reviewSession({ ...calendar, days: [] }, "2026-09-14T23:00:00+05:30").status).toBe("UNVERIFIED");
    const special = { ...calendar, days: [{ date: "2026-09-14", windows: [{ opensAt: "2026-09-14T17:00:00+05:30", closesAt: "2026-09-14T23:55:00+05:30" }] }] };
    expect(reviewSession(special, "2026-09-14T12:00:00+05:30").entriesAllowed).toBe(false);
    expect(reviewSession(special, "2026-09-14T23:40:00+05:30").entriesAllowed).toBe(true);
  });
  it("fails closed for invalid, expired, future-reviewed or overlapping calendars", async () => {
    for (const input of [null, { ...calendar, source: "https://mcxindia.com.evil.test" },
      { ...calendar, validUntil: "2026-09-14T12:00:00Z" }, { ...calendar, verifiedAt: "2026-09-15T00:00:00Z" },
      { ...calendar, days: [calendar.days[0], calendar.days[0]] },
      { ...calendar, days: [{ ...calendar.days[0], windows: [calendar.days[0].windows[0], calendar.days[0].windows[0]] }] }]) {
      expect(reviewSession(input, "2026-09-14T23:00:00+05:30")).toMatchObject({ status: "UNVERIFIED", entriesAllowed: false });
    }
    vi.stubEnv("MARKETPILOT_SESSION_FILE", "missing-secret-local-path");
    expect(JSON.stringify(await marketSession("2026-09-14T23:00:00+05:30"))).not.toContain("missing-secret-local-path");
  });
});
describe("decision states and setup privacy", () => {
  it("uses HOLD for an intact open thesis and EXIT when data fails", () => {
    const s = trend(); evaluate(s); enter(s);
    expect(decide(s, 0).action).toBe("HOLD");
    s.feed = "DISCONNECTED"; expect(decide(s, 0).action).toBe("EXIT");
  });
  it("blocks LIVE entries without a calendar even with trend, price and context", () => {
    const s = trend(); s.mode = "LIVE"; s.context.forEach(c => c.status = "LIVE");
    expect(decide(s, 0).action).toBe("WAIT");
    expect(decide(s, 0).reasons.join(" ")).toContain("session unverified");
  });
  it("requires a protective EXIT during session closure while retaining the stop", () => {
    const s = trend(); evaluate(s); enter(s); const stop = s.position!.stop;
    s.mode = "LIVE"; s.session = reviewSession(calendar, "2026-09-14T23:25:00+05:30");
    expect(decide(s, 0)).toMatchObject({ action: "EXIT", stop });
  });
  it("returns setting names only, never configured credential values", () => {
    vi.stubEnv("ANGEL_API_KEY", "secret-sentinel"); vi.stubEnv("ANGEL_ACCESS_TOKEN", "");
    const missing = missingLiveSettings(); expect(missing).toContain("ANGEL_ACCESS_TOKEN");
    expect(missing).not.toContain("ANGEL_API_KEY"); expect(JSON.stringify(missing)).not.toContain("secret-sentinel");
  });
});
