import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
export function proxy(request: NextRequest) {
  const password = process.env.MARKETPILOT_PASSWORD;
  if (password) {
    const expected = Buffer.from(`Basic ${Buffer.from(`pilot:${password}`).toString("base64")}`);
    const received = Buffer.from(request.headers.get("authorization") ?? "");
    if (received.length === expected.length && timingSafeEqual(received, expected)) return NextResponse.next();
    return new NextResponse("Private MarketPilot instance", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="MarketPilot", charset="UTF-8"' } });
  }
  const host = request.headers.get("host")?.split(":")[0];
  if (process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(host ?? "")) return NextResponse.next();
  return new NextResponse("Set MARKETPILOT_PASSWORD before exposing this private app.", { status: 503 });
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
