import { open, readFile, rename, rm } from "node:fs/promises";
import { parseEnv } from "node:util";
import { sessionTokenStatus } from "./credentials";

const LOGIN_URL = "https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword";
const identityKeys = ["ANGEL_API_KEY", "ANGEL_CLIENT_LOCAL_IP", "ANGEL_CLIENT_PUBLIC_IP", "ANGEL_MAC_ADDRESS"] as const;
export class LoginError extends Error {}

export function replaceAccessToken(content: string, token: string): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  // Replace every duplicate assignment, including a quoted multiline value.
  const assignment = /^[ \t]*(?:export[ \t]+)?ANGEL_ACCESS_TOKEN[ \t]*=[ \t]*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\r\n]*)(?:[ \t]*(?:#[^\r\n]*)?)$/gm;
  const line = `ANGEL_ACCESS_TOKEN=${JSON.stringify(token)}`;
  if (assignment.test(content)) return content.replace(assignment, () => line);
  return content + (content && !content.endsWith("\n") ? newline : "") + line + newline;
}

export async function checkLoginConfig(file: string) {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch { throw new LoginError("Create .env.local and configure your API key and client identity fields first."); }
  const env = parseEnv(text);
  const missing = identityKeys.filter(key => !env[key]?.trim());
  if (missing.length) throw new LoginError(`Missing local settings: ${missing.join(", ")}.`);
  return { text, env };
}

/** Credentials exist only in memory; only the broker-returned JWT is persisted. */
export async function loginAndSave(file: string, credentials: { clientcode: string; password: string; totp: string }) {
  if (!credentials.clientcode.trim() || !credentials.password || !/^\d{6}$/.test(credentials.totp.trim()))
    throw new LoginError("Enter your client code, PIN/password and the current six-digit authenticator code.");
  const { env } = await checkLoginConfig(file);
  let token: string;
  try {
    const response = await fetch(LOGIN_URL, {
      method: "POST", signal: AbortSignal.timeout(20000), cache: "no-store", redirect: "error",
      headers: {
        "Content-Type": "application/json", Accept: "application/json",
        "X-UserType": "USER", "X-SourceID": "WEB", "X-PrivateKey": env.ANGEL_API_KEY!.trim(),
        "X-ClientLocalIP": env.ANGEL_CLIENT_LOCAL_IP!.trim(), "X-ClientPublicIP": env.ANGEL_CLIENT_PUBLIC_IP!.trim(),
        "X-MACAddress": env.ANGEL_MAC_ADDRESS!.trim(),
      },
      body: JSON.stringify({ clientcode: credentials.clientcode.trim(), password: credentials.password, totp: credentials.totp.trim() }),
    });
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (result?.status !== true || typeof result?.data?.jwtToken !== "string") throw new Error();
    token = result.data.jwtToken.trim().replace(/^Bearer\s+/i, "");
    if (sessionTokenStatus(token) !== "PRESENT_UNVERIFIED") throw new Error();
  } catch {
    throw new LoginError("SmartAPI login failed or returned an invalid/expired session. Check your credentials, current authenticator code and connection, then retry. The saved token was not changed.");
  }
  const temporary = `${file}.login-${crypto.randomUUID()}.tmp`;
  try {
    const latest = await readFile(file, "utf8"), latestEnv = parseEnv(latest);
    if ([...identityKeys, "ANGEL_ACCESS_TOKEN"].some(key => latestEnv[key] !== env[key]))
      throw new LoginError("Broker configuration changed during login. Token was not saved; run the helper again.");
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(replaceAccessToken(latest, token), "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } catch (error) {
    if (error instanceof LoginError) throw error;
    throw new LoginError("Login succeeded, but the JWT could not be saved to .env.local. Check file access and run the helper again.");
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
