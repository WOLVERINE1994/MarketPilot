import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { istClock, istDay } from "./time.js";

const PAGE = fileURLToPath(new URL("../public/index.html", import.meta.url));

function authorized(req, password) {
  if (!password) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const given = Buffer.from(Buffer.from(header.slice(6), "base64").toString().replace(/^[^:]*:/, ""));
  const want = Buffer.from(password);
  return given.length === want.length && timingSafeEqual(given, want);
}

function csv(trades) {
  const head = ["date", "entry_time", "exit_time", "instrument", "kind", "side", "symbol", "entry", "exit", "pnl_after_costs", "reason"];
  const esc = v => `"${String(v ?? "").replaceAll('"', '""')}"`;
  return [head.join(","), ...trades.map(t => [istDay(t.entryTime), istClock(t.entryTime), istClock(t.exitTime), t.label, t.kind, t.side, t.symbol, t.entryPrice, t.exitPrice, t.pnl, t.reason].map(esc).join(","))].join("\n");
}

/** Dashboard web server: the page, a JSON snapshot and a live Server-Sent Events stream. */
export function startServer(desk, { port, host, password }) {
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

  const server = http.createServer((req, res) => {
    if (!authorized(req, password)) { res.writeHead(401, { "WWW-Authenticate": 'Basic realm="MarketPilot"' }); return res.end("Password required"); }
    const url = new URL(req.url, "http://local");
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(readFileSync(PAGE));
    }
    if (url.pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(desk.snapshot()));
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify(desk.snapshot())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/api/trades.csv") {
      res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="marketpilot-paper-trades.csv"' });
      return res.end(csv(desk.closed));
    }
    res.writeHead(404); res.end("Not found");
  });
  server.listen(port, host);
  return server;
}
