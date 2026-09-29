import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { exchangeTime, parseQuote, quote, QuoteError } from "../src/marketpilot/adapters/smartapi";
import { resolveContract, type Instrument, type Specification } from "../src/marketpilot/contracts";

const now = "2026-09-14T16:00:00.000Z";
const instrument: Instrument = { name: "CRUDEOILM", symbol: "CRUDEOILM21SEP26FUT", token: "12345", expiry: "21SEP2026", lotsize: "10", tick_size: "100.000000", exch_seg: "MCX", instrumenttype: "FUTCOM" };
const specification: Specification = { symbol: instrument.symbol, expiry: "2026-09-21", lotSize: 10, multiplier: 10, tickSize: 1, source: "https://www.mcxindia.com/products/energy/crude-oil", verifiedAt: "2026-09-14T00:00:00Z", validUntil: "2026-09-22T00:00:00Z" };
const contract = resolveContract([instrument], [specification], now);
const row = { symbolToken: instrument.token, tradingSymbol: instrument.symbol, exchange: "MCX", ltp: 6000, exchFeedTime: "14-Sep-2026 21:30:00" };
const payload = (changes: Record<string, unknown> = {}) => ({ status: true, data: { fetched: [{ ...row, ...changes }], unfetched: [] } });
const configure = () => {
  for (const key of ["ANGEL_API_KEY", "ANGEL_ACCESS_TOKEN", "ANGEL_CLIENT_LOCAL_IP", "ANGEL_CLIENT_PUBLIC_IP", "ANGEL_MAC_ADDRESS"]) vi.stubEnv(key, "sensitive-test-placeholder");
};

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("strict SmartAPI exchange timestamps", () => {
  it("uses IST and accepts an actual leap day", () => {
    expect(exchangeTime("29-Feb-2024 00:00:00")).toBe("2024-02-28T18:30:00.000Z");
    expect(exchangeTime("14-sEp-2026 21:30:00")).toBe(now);
  });

  it.each(["31-Feb-2026 21:30:00", "29-Feb-2026 21:30:00", "31-Apr-2026 21:30:00", "00-Sep-2026 21:30:00", "14-Sep-2026 24:00:00", "14-Sep-2026 23:60:00", "14-Sep-2026 23:00:60", "14-Xxx-2026 21:30:00", "2026-09-14T16:00:00Z", "14-Sep-2026 21:30:00 broker-secret"])("rejects non-canonical timestamp %s", value => {
    expect(() => exchangeTime(value)).toThrow(QuoteError);
  });
});

describe("sanitized broker quote validation", () => {
  it("accepts exactly the verified mini futures identity", () => {
    expect(parseQuote(payload(), contract)).toEqual({ price: 6000, time: now });
    expect(parseQuote(payload({ symbolToken: 12345 }), contract)).toEqual({ price: 6000, time: now });
  });

  it.each([{ symbolToken: "99999" }, { tradingSymbol: "CRUDEOIL21SEP26FUT" }, { exchange: "NSE" }])("rejects a mismatched quote and retains only parsed exchange time", changes => {
    try { parseQuote(payload(changes), contract); throw new Error("unexpected acceptance"); }
    catch (error) { expect(error).toMatchObject({ status: "CONTRACT_MISMATCH", exchangeTime: now }); expect(error).not.toHaveProperty("price"); }
  });

  it.each([NaN, Infinity, -1, 0, "6000", null])("rejects malformed price %s", ltp => {
    expect(() => parseQuote(payload({ ltp }), contract)).toThrow(QuoteError);
    try { parseQuote(payload({ ltp }), contract); } catch (error) { expect(error).toMatchObject({ status: "MALFORMED", exchangeTime: now }); expect(error).not.toHaveProperty("price"); }
  });

  it("rejects ambiguous, missing and malformed broker rows", () => {
    expect(() => parseQuote({ status: true, data: { fetched: [row, row] } }, contract)).toThrow(/identity/);
    expect(() => parseQuote({ status: true, data: { fetched: [] } }, contract)).toThrow(/unavailable/);
    expect(() => parseQuote({ status: "true", data: { fetched: [row] } }, contract)).toThrow(/malformed/);
    expect(() => parseQuote(payload({ exchFeedTime: null }), contract)).toThrow(/malformed/);
    expect(() => parseQuote(null, contract)).toThrow(/malformed/);
    expect(() => parseQuote({ status: true, data: { fetched: [row], unfetched: [{ message: "sensitive-broker-message" }] } }, contract)).toThrow(/unavailable/);
  });

  it("does not accept an unverified or wrong-instrument contract", () => {
    expect(() => parseQuote(payload(), { ...contract, verified: false })).toThrow(/verified/);
    expect(() => parseQuote(payload(), { ...contract, symbol: "CRUDEOIL21SEP26FUT" })).toThrow(/verified/);
    expect(() => parseQuote(payload(), { ...contract, multiplier: NaN })).toThrow(/verified/);
  });

  it("never sends a request when credentials or contract verification are missing", async () => {
    vi.stubEnv("ANGEL_API_KEY", "");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(quote(contract)).rejects.toMatchObject({ status: "UNAVAILABLE" });
    configure();
    await expect(quote({ ...contract, verified: false })).rejects.toMatchObject({ status: "CONTRACT_MISMATCH" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("contains transport and HTTP failures without leaking broker secrets", async () => {
    configure();
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("secret-jwt and private-IP"))
      .mockResolvedValueOnce({ ok: false, status: 401, json: vi.fn().mockResolvedValue({ message: "secret-jwt" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: false, message: "secret-jwt" }) });
    vi.stubGlobal("fetch", fetcher);
    for (let i = 0; i < 3; i++) {
      await expect(quote(contract)).rejects.toMatchObject({ status: "UNAVAILABLE", message: "SmartAPI market data unavailable", exchangeTime: null });
    }
    expect(fetcher.mock.calls.every(call => String(call[0]).endsWith("/market/v1/quote/"))).toBe(true);
  });

  it("classifies malformed JSON separately from a disconnection", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error("secret malformed response text"); } }));
    await expect(quote(contract)).rejects.toMatchObject({ status: "MALFORMED", message: "SmartAPI quote is malformed" });
  });
});

describe("held contract reverification", () => {
  it("reverifies the exact held symbol, permits expiry-day exits and never silently rolls", () => {
    const next = { ...instrument, token: "23456", symbol: "CRUDEOILM19OCT26FUT", expiry: "19OCT2026" };
    const nextSpec = { ...specification, symbol: next.symbol, expiry: "2026-10-19" };
    const rows = [instrument, next], specs = [specification, nextSpec];
    expect(resolveContract(rows, specs, now, next.symbol).token).toBe(next.token);
    expect(resolveContract(rows, specs, "2026-09-20T18:30:00Z").symbol).toBe(next.symbol);
    expect(resolveContract(rows, specs, "2026-09-20T18:30:00Z", instrument.symbol).symbol).toBe(instrument.symbol);
    expect(() => resolveContract(rows, specs, "2026-09-21T18:30:00Z", instrument.symbol)).toThrow(/No tradable/);
    expect(() => resolveContract(rows, specs, now, "CRUDEOILM20NOV26FUT")).toThrow(/No tradable/);
    expect(() => resolveContract([instrument, { ...instrument, token: "99999" }], specs, now)).toThrow(/ambiguous/);
  });

  it("reads the current attestation again instead of trusting a stored position", async () => {
    vi.resetModules();
    const adapter = await import("../src/marketpilot/adapters/smartapi");
    const directory = mkdtempSync(path.join(os.tmpdir(), "marketpilot-specs-test-"));
    const file = path.join(directory, "specifications.json");
    writeFileSync(file, JSON.stringify([specification]));
    vi.stubEnv("MARKETPILOT_SPECS_FILE", file);
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => [instrument] });
    vi.stubGlobal("fetch", fetcher);
    expect((await adapter.currentContract(now, instrument.symbol)).token).toBe(instrument.token);
    writeFileSync(file, JSON.stringify([{ ...specification, validUntil: now }]));
    await expect(adapter.currentContract(now, instrument.symbol)).rejects.toMatchObject({ status: "UNAVAILABLE", message: "SmartAPI market data unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
