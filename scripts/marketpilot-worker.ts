import { operate } from "../src/marketpilot/engine";
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
async function main() {
  console.log("MarketPilot monitor: paper trading only; 5-second polling. Keep this process running.");
  while (!stopping) {
    try { await operate("LIVE", "worker"); } catch { console.error("LIVE: monitor tick failed or another update is in progress"); }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
void main();
