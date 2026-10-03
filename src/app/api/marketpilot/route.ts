import { z } from "zod";
import { operate, refreshDashboard } from "@/marketpilot/engine";
import { decisions } from "@/marketpilot/storage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const settings = z.object({
  riskPerTrade: z.number().min(1).max(100000), dailyLoss: z.number().min(1).max(1000000), maxTrades: z.number().int().min(1).max(20), paused: z.boolean(), profitTrigger: z.number().min(0).max(1000000), profitGiveback: z.number().positive().max(100000), brokerage: z.number().min(0).max(1000), statutoryBps: z.number().min(0).max(100), spread: z.number().min(0).max(100), slippage: z.number().min(0).max(100), fast: z.number().int().min(2).max(15), slow: z.number().int().min(16).max(100), momentum: z.number().min(0.001).max(5), maxVolatility: z.number().min(0.01).max(10), assessmentTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), requireContext: z.boolean(),
}).partial().strict();
const input = z.object({ mode: z.enum(["LIVE", "REPLAY"]), command: z.enum(["refresh", "step", "play", "pause-replay", "enter", "exit", "settings", "assess", "worker"]), settings: settings.optional() }).strict();
export async function POST(request: Request) {
  let command: string | undefined;
  const origin = request.headers.get("origin");
  // Next's internal URL may use localhost while the browser uses 127.0.0.1.
  // Compare the browser origin to the actual request Host, never to a forwarded arbitrary origin.
  if (origin) {
    let sameOrigin = false;
    try { const parsed = new URL(origin); sameOrigin = ["http:", "https:"].includes(parsed.protocol) && parsed.host === request.headers.get("host"); } catch { /* Invalid/opaque origin fails closed. */ }
    if (!sameOrigin) return Response.json({ error: "Cross-origin request rejected" }, { status: 403 });
  }
  try {
    const body = input.parse(await request.json());
    command = body.command;
    const result = body.command === "refresh" ? await refreshDashboard(body.mode) : await operate(body.mode, body.command, body.settings);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Log only fixed diagnostic fields. Raw errors may contain private paths or broker data.
    const diagnostic = error as { code?: unknown; errcode?: unknown; marketpilotOperation?: unknown } | null;
    const calls = error instanceof Error ? (error.stack ?? "").split("\n").slice(1, 5).map(line => line.match(/\bat ([A-Za-z0-9_.$]+)/)?.[1] ?? "anonymous") : [];
    console.error("MarketPilot monitor request failed", { command, type: error instanceof Error ? error.name : "Unknown", calls,
      operation: diagnostic?.marketpilotOperation === "lease.release" ? "lease.release" : "request",
      code: typeof diagnostic?.code === "string" && /^ERR_SQLITE_[A-Z_]+$/.test(diagnostic.code) ? diagnostic.code : "UNCLASSIFIED",
      sqliteCode: typeof diagnostic?.errcode === "number" ? diagnostic.errcode : null });
    return Response.json({ error: error instanceof z.ZodError ? "Invalid configuration" : error instanceof Error && /blocked|busy|Close the|fresh quote/.test(error.message) ? error.message : "Monitor request failed; check local setup" }, { status: 400 });
  }
}
export async function GET(request: Request) {
  const mode = new URL(request.url).searchParams.get("mode") === "LIVE" ? "LIVE" : "REPLAY";
  return Response.json(decisions(mode), { headers: { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="marketpilot-${mode.toLowerCase()}-decisions.json"` } });
}
