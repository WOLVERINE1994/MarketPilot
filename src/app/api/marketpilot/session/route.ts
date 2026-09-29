import { forwardSessionReport } from "@/marketpilot/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const day = new URL(request.url).searchParams.get("date") ?? "";
  try {
    const report = forwardSessionReport(day);
    return Response.json(report, { headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="marketpilot-live-forward-${report.day}-IST.json"`,
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    const invalidDate = error instanceof Error && /valid IST date|future IST date/.test(error.message);
    return Response.json({ error: invalidDate ? error.message : "Forward-session report unavailable; check local persistent storage" },
      { status: invalidDate ? 400 : 503, headers: { "Cache-Control": "private, no-store" } });
  }
}
