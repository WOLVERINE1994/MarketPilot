import { createHmac } from "node:crypto";

/** RFC 4648 base32 decode (the format authenticator apps show). */
export function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input).toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error("TOTP secret is not valid base32");
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — what Angel One SmartAPI uses. */
export function totp(secret, now = Date.now(), { step = 30, digits = 6, key } = {}) {
  const k = key ?? base32Decode(secret);
  const counter = Math.floor(now / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", k).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}
