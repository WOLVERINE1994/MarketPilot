import { operate } from "../src/marketpilot/engine";
import { currentContract } from "../src/marketpilot/adapters/smartapi";
import { smartMarketStream } from "../src/marketpilot/adapters/smart-stream";
import { MonitorBusyError } from "../src/marketpilot/storage";
let stopping = false;
const MIN_STREAM_PROCESS_INTERVAL_MS = 100;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
const lastFailureLog = new Map<string, number>();
function reportFailure(stage: string, error: unknown) {
  // A busy lease means another valid monitor request currently owns the update.
  // It is expected under multi-tab or worker contention, so don't report it as a failure.
  if (error instanceof MonitorBusyError) return;
  const now = Date.now();
  if (now - (lastFailureLog.get(stage) ?? 0) < 30000) return;
  lastFailureLog.set(stage, now);
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name) ? error.name : "UnknownError";
  const code = (error as { errcode?: unknown } | null)?.errcode;
  console.error(`LIVE: ${stage} failed`, { type: name, sqliteCode: typeof code === "number" ? code : null });
}
async function main() {
  smartMarketStream.start();
  console.log("MarketPilot monitor: paper trading only; SmartAPI WebSocket primary, bounded REST fallback. Keep this process running.");
  let token = "", lastContractCheck = 0, lastStreamTime = "", lastQuoteWork = 0, lastFallback = 0, lastHeartbeat = 0;
  while (!stopping) {
    const now = Date.now();
    if (!token || now - lastContractCheck >= 60000) {
      try { const contract = await currentContract(new Date().toISOString()); if (token !== contract.token) { token = contract.token; smartMarketStream.subscribe(token); lastStreamTime = ""; } lastContractCheck = now; }
      catch { lastContractCheck = now - 55000; }
    }
    const tick = token ? smartMarketStream.latest(token) : null;
    const tickAge = tick ? now - Date.parse(tick.time) : Infinity;
    // Coalesce a burst to the most recent tick, but keep the decision path near
    // real time. The loop also yields every 100 ms, capping decision evaluations
    // and committed state updates at 10/second while removing the old one-second wait.
    if (tick && tick.time !== lastStreamTime && now - lastQuoteWork >= MIN_STREAM_PROCESS_INTERVAL_MS) {
      try { await operate("LIVE", "worker"); lastStreamTime = tick.time; lastQuoteWork = Date.now(); }
      catch (error) { reportFailure("stream monitor tick", error); }
      finally { lastQuoteWork = Date.now(); }
    } else if ((!smartMarketStream.connected || tickAge > 5000) && now - lastFallback >= 5000) {
      try { await operate("LIVE", "worker"); lastFallback = Date.now(); lastQuoteWork = lastFallback; }
      catch (error) { reportFailure("REST fallback monitor tick", error); }
      finally { lastFallback = Date.now(); }
    } else if (now - lastHeartbeat >= 5000) {
      try { await operate("LIVE", "heartbeat"); lastHeartbeat = Date.now(); }
      catch (error) { reportFailure("monitor heartbeat", error); }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  smartMarketStream.close();
}
void main();
