import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { istClock, istDay } from "./time.js";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const SESSION_DAYS = 30;
// Files anyone may load (needed for the sign-in page and phone-app install).
const OPEN_FILES = {
  "/login.html": "text/html; charset=utf-8", "/offline.html": "text/html; charset=utf-8",
  "/manifest.webmanifest": "application/manifest+json", "/sw.js": "text/javascript; charset=utf-8",
  "/icon.svg": "image/svg+xml", "/icon-192.png": "image/png", "/icon-512.png": "image/png", "/apple-touch-icon.png": "image/png",
};

const sha = s => createHash("sha256").update(s).digest("hex");
function same(a, b) {
  const x = Buffer.from(sha(String(a))), y = Buffer.from(sha(String(b)));
  return timingSafeEqual(x, y);
}
const cookies = req => Object.fromEntries((req.headers.cookie ?? "").split(";").map(p => p.trim().split("=")).filter(p => p.length === 2));

/** Long-lived sign-in sessions (only hashes are stored on disk). */
class Sessions {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, "sessions.json") : null;
    this.map = new Map();
    try { for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.file, "utf8")))) if (v > Date.now()) this.map.set(k, v); } catch { /* none yet */ }
  }
  save() {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(Object.fromEntries(this.map)));
    renameSync(this.file + ".tmp", this.file);
  }
  create() { const token = randomBytes(32).toString("hex"); this.map.set(sha(token), Date.now() + SESSION_DAYS * 86400000); this.save(); return token; }
  valid(token) { const exp = token && this.map.get(sha(token)); return !!exp && exp > Date.now(); }
  drop(token) { if (token && this.map.delete(sha(token))) this.save(); }
}

function csv(trades) {
  const head = ["date", "entry_time", "exit_time", "instrument", "kind", "side", "symbol", "entry", "exit", "pnl_after_costs", "reason"];
  const esc = v => `"${String(v ?? "").replaceAll('"', '""')}"`;
  return [head.join(","), ...trades.map(t => [istDay(t.entryTime), istClock(t.entryTime), istClock(t.exitTime), t.label, t.kind, t.side, t.symbol, t.entryPrice, t.exitPrice, t.pnl, t.reason].map(esc).join(","))].join("\n");
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => { data += chunk; if (data.length > limit) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(data)); req.on("error", reject);
  });
}

/**
 * Dashboard web server: sign-in page, the dashboard, a JSON snapshot, a live
 * Server-Sent Events stream and a CSV export. With a password set, everything
 * except the sign-in/install files needs a session cookie.
 */
export function startServer(desk, { port, host, password, dataDir }) {
  const sessions = new Sessions(dataDir);
  const failures = []; // timestamps of wrong passwords (single-user app → global limit)
  const clients = new Set();
  let pending = false;
  const push = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      const data = `data: ${JSON.stringify(desk.snapshot())}\n\n`;
      for (const res of clients) res.write(data);
    }, 250);
  };
  desk.on("tick", push); desk.on("update", push);

  const secureHeaders = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
  const send = (res, status, type, body, extra = {}) => { res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...secureHeaders, ...extra }); res.end(body); };
  const loginPage = (res, status = 200, error = "") => send(res, status, "text/html; charset=utf-8",
    readFileSync(path.join(PUBLIC, "login.html"), "utf8").replace("<!--ERROR-->", error));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    const https = req.headers["x-forwarded-proto"] === "https";
    if (OPEN_FILES[url.pathname]) return send(res, 200, OPEN_FILES[url.pathname], readFileSync(path.join(PUBLIC, url.pathname.slice(1))), url.pathname === "/sw.js" ? { "Service-Worker-Allowed": "/" } : {});

    if (password && url.pathname === "/login" && req.method === "POST") {
      const now = Date.now();
      while (failures.length && failures[0] < now - 15 * 60000) failures.shift();
      if (failures.length >= 10) return loginPage(res, 429, "Too many wrong attempts. Wait 15 minutes.");
      let given = "";
      try { given = new URLSearchParams(await readBody(req)).get("password") ?? ""; } catch { return loginPage(res, 400, "Invalid request"); }
      if (!same(given, password)) { failures.push(now); return loginPage(res, 401, "Wrong password"); }
      const token = sessions.create();
      res.writeHead(303, { Location: "/", "Set-Cookie": `mp_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${https ? "; Secure" : ""}`, ...secureHeaders });
      return res.end();
    }
    if (url.pathname === "/logout") {
      sessions.drop(cookies(req).mp_session);
      res.writeHead(303, { Location: "/login", "Set-Cookie": "mp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0", ...secureHeaders });
      return res.end();
    }
    if (password && !sessions.valid(cookies(req).mp_session)) {
      if (url.pathname.startsWith("/api/")) return send(res, 401, "application/json", JSON.stringify({ error: "Sign in required" }));
      if (url.pathname === "/login") return loginPage(res);
      res.writeHead(303, { Location: "/login", ...secureHeaders }); return res.end();
    }
    if (url.pathname === "/login") { res.writeHead(303, { Location: "/" }); return res.end(); }

    if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", readFileSync(path.join(PUBLIC, "index.html")));
    if (url.pathname === "/api/state") return send(res, 200, "application/json", JSON.stringify(desk.snapshot()));
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no", ...secureHeaders });
      res.write(`data: ${JSON.stringify(desk.snapshot())}\n\n`);
      clients.add(res);
      const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20000);
      req.on("close", () => { clients.delete(res); clearInterval(keepAlive); });
      return;
    }
    if (url.pathname === "/api/trades.csv") return send(res, 200, "text/csv", csv(desk.closed), { "Content-Disposition": 'attachment; filename="marketpilot-paper-trades.csv"' });
    send(res, 404, "text/plain", "Not found");
  });
  server.listen(port, host);
  return server;
}
