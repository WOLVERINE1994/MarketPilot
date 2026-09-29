import { operate } from "../src/marketpilot/engine";
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
async function main() {
  console.log("MarketPilot monitor: paper trading only; 5-second polling. Keep this process running.");
  while (!stopping) {
    for (const mode of ["REPLAY", "LIVE"] as const) {
      try { await operate(mode, "worker"); } catch { console.error(`${mode}: monitor tick failed or another update is in progress`); }
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
void main();
