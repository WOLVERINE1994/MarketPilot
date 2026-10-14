import { expect, it } from "vitest";
import { parseSmartStreamLtp, parseSmartStreamSnapQuote } from "../src/marketpilot/adapters/smart-stream";

function packet(overrides: { mode?: number; exchange?: number; token?: string; timestamp?: number; price?: number } = {}) {
  const data = Buffer.alloc(51);
  data[0] = overrides.mode ?? 1;
  data[1] = overrides.exchange ?? 5;
  data.write((overrides.token ?? "569901").padEnd(25, "\0"), 2, "ascii");
  data.writeBigInt64LE(BigInt(1), 27);
  data.writeBigInt64LE(BigInt(overrides.timestamp ?? Date.parse("2026-10-07T06:00:00Z")), 35);
  data.writeBigInt64LE(BigInt(overrides.price ?? 870000), 43);
  return data;
}

it("decodes a verified-shape SmartAPI MCX LTP packet from paise and exchange milliseconds", () => {
  const quote = parseSmartStreamLtp(packet());
  expect(quote).toMatchObject({ token: "569901", price: 8700, time: "2026-10-07T06:00:00.000Z" });
});

it.each([
  ["wrong packet length", Buffer.alloc(50)],
  ["wrong mode", packet({ mode: 2 })],
  ["wrong exchange", packet({ exchange: 2 })],
  ["bad token", packet({ token: "bad" })],
  ["bad price", packet({ price: 0 })],
  ["bad timestamp", packet({ timestamp: 0 })],
])("rejects %s", (_label, data) => expect(parseSmartStreamLtp(data)).toBeNull());

function snapQuotePacket() {
  const data = Buffer.alloc(379);
  data[0] = 3;
  data[1] = 5;
  data.write("580001".padEnd(25, "\0"), 2, "ascii");
  data.writeBigInt64LE(BigInt(Date.parse("2026-10-07T06:00:00Z")), 35);
  data.writeBigInt64LE(BigInt(20950), 43);
  data.writeBigInt64LE(BigInt(1000), 67);
  data.writeBigInt64LE(BigInt(Date.parse("2026-10-07T05:59:59Z")), 123);
  data.writeBigInt64LE(BigInt(5000), 131);
  data.writeUInt16LE(1, 147);
  data.writeBigInt64LE(BigInt(100), 149);
  data.writeBigInt64LE(BigInt(20925), 157);
  data.writeUInt16LE(0, 167);
  data.writeBigInt64LE(BigInt(120), 169);
  data.writeBigInt64LE(BigInt(20975), 177);
  return data;
}

it("decodes SmartAPI MCX Snap Quote premium, trade timestamp, depth, volume and open interest", () => {
  expect(parseSmartStreamSnapQuote(snapQuotePacket())).toMatchObject({
    token: "580001", price: 209.5, time: "2026-10-07T06:00:00.000Z",
    tradeTime: "2026-10-07T05:59:59.000Z", bid: 209.25, ask: 209.75,
    bidQuantity: 100, askQuantity: 120, volume: 1000, openInterest: 5000,
  });
});

it.each([
  ["wrong packet length", Buffer.alloc(378)],
  ["wrong mode", Buffer.from(snapQuotePacket()).fill(1, 0, 1)],
  ["crossed depth", (() => {
    const data = snapQuotePacket();
    data.writeBigInt64LE(BigInt(21000), 157);
    return data;
  })()],
])("rejects %s in a Snap Quote packet", (_label, data) => expect(parseSmartStreamSnapQuote(data)).toBeNull());
