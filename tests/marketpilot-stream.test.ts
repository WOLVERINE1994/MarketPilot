import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../src/app/api/marketpilot/stream/route";
import { db, readState, saveState } from "../src/marketpilot/storage";
import { initial } from "../src/marketpilot/engine";

beforeAll(() => {
  process.env.MARKETPILOT_DATA_DIR = `.marketpilot-tests-stream-${crypto.randomUUID()}`;
  db();
});
beforeEach(() => {
  db().exec("DELETE FROM states; DELETE FROM decisions;");
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-14T17:30:00.000Z");
  saveState(initial("LIVE"));
});
afterEach(() => { vi.useRealTimers(); });

describe("LIVE dashboard event stream", () => {
  it("sends the current state immediately and publishes committed worker updates", async () => {
    const response = await GET(new Request("http://127.0.0.1/api/marketpilot/stream", { headers: { host: "127.0.0.1" } }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"mode":"LIVE"');

    const nextFrame = reader.read();
    const state = readState("LIVE")!;
    state.lastWorker = new Date(Date.now() + 1000).toISOString();
    saveState(state);
    await vi.advanceTimersByTimeAsync(250);
    expect(decoder.decode((await nextFrame).value)).toContain(state.lastWorker);
    await reader.cancel();
  });

  it("rejects cross-origin event stream requests", async () => {
    const response = await GET(new Request("http://127.0.0.1/api/marketpilot/stream", {
      headers: { host: "127.0.0.1", origin: "https://attacker.example" },
    }));
    expect(response.status).toBe(403);
  });
});
