import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Angel One instrument master refresh", () => {
  it("backs off after an unavailable refresh instead of retrying on every quote", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValue(new Error("network unavailable"));
    vi.stubGlobal("fetch", fetch);
    vi.resetModules();
    const { instrumentMaster, QuoteError } = await import("../src/marketpilot/adapters/smartapi");

    await expect(instrumentMaster()).rejects.toBeInstanceOf(QuoteError);
    await expect(instrumentMaster()).rejects.toBeInstanceOf(QuoteError);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60001);
    await expect(instrumentMaster()).rejects.toBeInstanceOf(QuoteError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
