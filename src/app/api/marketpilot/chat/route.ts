import { z } from "zod";
import { readState } from "@/marketpilot/storage";
import { marketChatSnapshot, MARKETPILOT_CHAT_INSTRUCTIONS } from "@/marketpilot/chat-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(1600) }).strict()).min(1).max(12),
}).strict();
const requestsByAddress = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const REQUESTS_PER_MINUTE = 12;

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.host === request.headers.get("host");
  } catch { return false; }
}

function outputText(payload: unknown) {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { output?: unknown }).output)) return "";
  return (payload as { output: unknown[] }).output.flatMap(item => {
    if (!item || typeof item !== "object" || !Array.isArray((item as { content?: unknown }).content)) return [];
    return (item as { content: unknown[] }).content.flatMap(content => {
      if (!content || typeof content !== "object") return [];
      const block = content as { type?: unknown; text?: unknown };
      return block.type === "output_text" && typeof block.text === "string" ? [block.text] : [];
    });
  }).join("\n").trim();
}

async function providerErrorCode(response: Response) {
  try {
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") return "";
    const error = (payload as { error?: unknown }).error;
    if (!error || typeof error !== "object") return "";
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  } catch { return ""; }
}

export async function GET() {
  return Response.json({ configured: !!process.env.OPENAI_API_KEY?.trim(), model: process.env.MARKETPILOT_AI_MODEL?.trim() || "gpt-6-astra" }, {
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin request rejected" }, { status: 403 });
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return Response.json({ error: "OpenAI API key is not configured in the app's local .env.local file." }, { status: 503 });

  const address = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const attempts = (requestsByAddress.get(address) ?? []).filter(time => now - time < WINDOW_MS);
  if (attempts.length >= REQUESTS_PER_MINUTE) return Response.json({ error: "Chat is at its local request limit. Wait a minute and try again." }, { status: 429 });
  attempts.push(now);
  requestsByAddress.set(address, attempts);

  let messages: z.infer<typeof requestSchema>["messages"];
  try {
    const parsed = requestSchema.parse(await request.json());
    if (parsed.messages.reduce((total, message) => total + message.content.length, 0) > 7000) return Response.json({ error: "Please shorten this conversation and try again." }, { status: 413 });
    messages = parsed.messages;
  } catch {
    return Response.json({ error: "Send up to 12 short chat messages." }, { status: 400 });
  }

  try {
    const snapshot = marketChatSnapshot(readState("LIVE"), now);
    const model = process.env.MARKETPILOT_AI_MODEL?.trim() || "gpt-6-astra";
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        instructions: `${MARKETPILOT_CHAT_INSTRUCTIONS}\n\nCurrent server-side MarketPilot snapshot (JSON):\n${JSON.stringify(snapshot)}`,
        input: messages,
        max_output_tokens: 700,
        store: false,
      }),
      signal: AbortSignal.timeout(25_000),
      cache: "no-store",
    });
    if (response.status === 401 || response.status === 403) return Response.json({ error: "OpenAI rejected the configured API key. Check it locally in .env.local." }, { status: 503 });
    if (response.status === 429) {
      const code = await providerErrorCode(response);
      const billingCodes = new Set([
        "insufficient_quota", "billing_hard_limit_reached", "organization_spend_limit_exceeded",
        "project_spend_limit_exceeded", "organization_usage_limit_exceeded", "usage_limit_exceeded", "credit_balance_exhausted",
      ]);
      const rateCodes = new Set(["rate_limit_exceeded", "slow_down"]);
      const error = billingCodes.has(code)
        ? "The OpenAI API billing, credit, or usage limit has been reached. Check Platform billing and usage limits."
        : rateCodes.has(code)
          ? "OpenAI is temporarily rate-limiting this account. Wait briefly and try again."
          : "OpenAI returned HTTP 429. Check Platform usage and billing limits, then try again.";
      return Response.json({ error }, { status: 503 });
    }
    if (!response.ok) return Response.json({ error: `OpenAI chat is temporarily unavailable (HTTP ${response.status}).` }, { status: 503 });
    const text = outputText(await response.json());
    if (!text) return Response.json({ error: "OpenAI returned no text. Please try again." }, { status: 502 });
    return Response.json({ text }, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError" ? "OpenAI did not respond in time. Please try again." : "Chat could not reach OpenAI. Check the app's internet connection and try again.";
    return Response.json({ error: message }, { status: 503 });
  }
}
