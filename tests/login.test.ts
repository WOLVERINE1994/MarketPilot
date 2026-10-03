import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkLoginConfig, loginAndSave, replaceAccessToken } from "../src/marketpilot/login";

let directory: string, file: string;
const content = '# Keep this comment\r\nANGEL_API_KEY="TEST_API"\r\nANGEL_CLIENT_LOCAL_IP="192.0.2.1"\r\nANGEL_CLIENT_PUBLIC_IP="192.0.2.2"\r\nANGEL_MAC_ADDRESS="00:11:22:33:44:55"\r\nANGEL_ACCESS_TOKEN="old-session"\r\nMARKETPILOT_DATA_DIR="unchanged-directory"\r\n';
const credentials = { clientcode: "TESTCLIENT", password: "TEST_PIN_ONLY", totp: "123456" };
function jwt(exp = Date.now() / 1000 + 3600) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode({ exp })}.TEST_SIGNATURE`;
}
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "marketpilot-login-")); file = join(directory, ".env.local"); await writeFile(file, content); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

it("saves the returned JWT only, preserves existing settings and never logs credentials", async () => {
  const token = jwt(), logger = vi.spyOn(console, "log");
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: true, data: { jwtToken: `Bearer ${token}`, refreshToken: "DO_NOT_SAVE_REFRESH", feedToken: "DO_NOT_SAVE_FEED" } }) });
  vi.stubGlobal("fetch", fetcher);
  await loginAndSave(file, credentials);
  const saved = await readFile(file, "utf8"), env = parseEnv(saved);
  expect(env.ANGEL_ACCESS_TOKEN).toBe(token);
  expect(saved.replace(`ANGEL_ACCESS_TOKEN="${token}"`, 'ANGEL_ACCESS_TOKEN="old-session"')).toBe(content);
  expect(saved).not.toMatch(/TEST_PIN_ONLY|TESTCLIENT|123456|DO_NOT_SAVE/);
  expect(logger).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([".env.local"]);
  expect(fetcher.mock.calls[0][0]).toBe("https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword");
  expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual(credentials);
});

it.each(["rejected", "network", "malformed", "expired"])("leaves the existing token untouched on %s failure and sanitizes errors", async failure => {
  const fetcher = failure === "network" ? vi.fn().mockRejectedValue(new Error("SECRET_RAW_RESPONSE")) :
    vi.fn().mockResolvedValue({ ok: true, json: async () => failure === "rejected" ? { status: false, message: "SECRET_RAW_RESPONSE" } : { status: true, data: { jwtToken: failure === "expired" ? jwt(1) : "SECRET_RAW_RESPONSE" } } });
  vi.stubGlobal("fetch", fetcher);
  await expect(loginAndSave(file, credentials)).rejects.toThrow("The saved token was not changed");
  expect(await readFile(file, "utf8")).toBe(content);
  expect(await readdir(directory)).toEqual([".env.local"]);
});

it("refuses invalid local inputs or incomplete configuration without sending a login request", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(loginAndSave(file, { ...credentials, totp: "not-an-otp" })).rejects.toThrow("six-digit");
  await writeFile(file, 'ANGEL_API_KEY="TEST_API"\n');
  await expect(checkLoginConfig(file)).rejects.toThrow("Missing local settings");
  await expect(loginAndSave(file, credentials)).rejects.toThrow("Missing local settings");
  expect(fetcher).not.toHaveBeenCalled();
});

it("preserves unrelated edits made while login is in flight", async () => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
    await writeFile(file, content + 'UNRELATED="new-value"\r\n');
    return { ok: true, json: async () => ({ status: true, data: { jwtToken: jwt() } }) };
  }));
  await loginAndSave(file, credentials);
  expect(parseEnv(await readFile(file, "utf8")).UNRELATED).toBe("new-value");
});

it("does not overwrite a token changed locally during the request", async () => {
  const changed = content.replace("old-session", "other-session");
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
    await writeFile(file, changed);
    return { ok: true, json: async () => ({ status: true, data: { jwtToken: jwt() } }) };
  }));
  await expect(loginAndSave(file, credentials)).rejects.toThrow("configuration changed");
  expect(await readFile(file, "utf8")).toBe(changed);
});

it("replaces duplicate and multiline token assignments and handles a missing field", () => {
  const input = 'KEEP="untouched"\nANGEL_ACCESS_TOKEN="old\nmultiline"\nexport ANGEL_ACCESS_TOKEN=second\n';
  const output = replaceAccessToken(input, "NEW_TEST_TOKEN");
  expect(parseEnv(output)).toEqual({ KEEP: "untouched", ANGEL_ACCESS_TOKEN: "NEW_TEST_TOKEN" });
  expect(output).not.toContain("multiline");
  expect(replaceAccessToken("KEEP=value", "NEW_TEST_TOKEN")).toBe('KEEP=value\nANGEL_ACCESS_TOKEN="NEW_TEST_TOKEN"\n');
});
