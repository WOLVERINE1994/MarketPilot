import { expect, it } from "vitest";
import { sessionTokenStatus } from "../src/marketpilot/credentials";
const now = Date.parse("2026-10-02T07:00:00Z");
function jwt(exp: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode({ exp })}.TEST_SIGNATURE`;
}
it("distinguishes missing, malformed and expired sessions without treating local decoding as authentication", () => {
  expect(sessionTokenStatus("", now)).toBe("MISSING");
  expect(sessionTokenStatus("api-key-is-not-a-jwt", now)).toBe("MALFORMED");
  expect(sessionTokenStatus("xxx.yyy.zzz", now)).toBe("MALFORMED");
  expect(sessionTokenStatus(jwt(now / 1000), now)).toBe("EXPIRED");
  expect(sessionTokenStatus(jwt(now / 1000 + 600), now)).toBe("PRESENT_UNVERIFIED");
  expect(sessionTokenStatus(`Bearer ${jwt(now / 1000 + 600)}`, now)).toBe("PRESENT_UNVERIFIED");
});
