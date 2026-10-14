import { readState } from "@/marketpilot/storage";
import { feedHealth } from "@/marketpilot/feed";
import { view } from "@/marketpilot/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.host === request.headers.get("host");
  } catch { return false; }
}

export async function GET(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "Cross-origin request rejected" }, { status: 403 });

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let lastVersion = "";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const publish = () => {
        if (closed) return;
        try {
          const state = readState("LIVE");
          if (!state) return;
          const version = `${state.latestObservation?.id ?? ""}:${state.decision?.id ?? ""}:${state.lastWorker ?? ""}:${Math.floor(Date.now() / 1000)}`;
          if (version === lastVersion) return;
          // Persisted health can outlive the token or quote it described. Recompute
          // it before streaming so a renewed local session is not shown as expired.
          state.feedHealth = feedHealth(state);
          lastVersion = version;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(view(state))}\n\n`));
        } catch {
          // A temporary storage error must not expose local paths or secrets.
          controller.enqueue(encoder.encode(`event: unavailable\ndata: {}\n\n`));
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        try { controller.close(); } catch { /* The consumer may already have closed. */ }
      };

      publish();
      timer = setInterval(publish, 250);
      request.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
