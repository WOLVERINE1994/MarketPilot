export type SessionTokenStatus = "MISSING" | "MALFORMED" | "EXPIRED" | "PRESENT_UNVERIFIED";

/** Local format/expiry diagnostics only. Broker authentication verifies the JWT. */
export function sessionTokenStatus(value: string | undefined, now = Date.now()): SessionTokenStatus {
  if (!value?.trim()) return "MISSING";
  const token = value.trim().replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return "MALFORMED";
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!header || typeof header.alg !== "string" || header.alg === "none" ||
      !payload || typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return "MALFORMED";
    return payload.exp * 1000 <= now ? "EXPIRED" : "PRESENT_UNVERIFIED";
  } catch { return "MALFORMED"; }
}
