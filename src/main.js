import { createInterface } from "node:readline/promises";
import { loadEnv, readConfig, PRODUCTS } from "./config.js";
import { SmartApiClient } from "./smartapi.js";
import { AngelFeed, DemoFeed } from "./feeds.js";
import { Desk } from "./desk.js";
import { Journal } from "./journal.js";
import { Notifier } from "./notify.js";
import { startServer } from "./server.js";
import { selectContracts } from "./contracts.js";
import { istDay, istClock } from "./time.js";
import path from "node:path";

const args = new Set(process.argv.slice(2));
loadEnv();
const config = readConfig();

async function askTotp() {
  if (!process.stdin.isTTY) throw new Error("No terminal to type the TOTP code. On a server, set ANGEL_TOTP_SECRET in .env so MarketPilot can log in by itself.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question("Enter the 6-digit Angel One TOTP code from your authenticator app: ")).trim(); }
  finally { rl.close(); }
}

async function check(client) {
  await client.login();
  console.log("✅ Angel One login OK");
  const rows = await client.instruments(config.products);
  for (const key of config.products) {
    const { future, optionExpiry, chain } = selectContracts(rows, PRODUCTS[key], istDay(Date.now()));
    console.log(`\n${PRODUCTS[key].label}: future ${future?.symbol ?? "NOT FOUND"} (expiry ${future?.expiry ?? "-"}, lot ${future?.lotSize ?? "-"})`);
    console.log(`  options: ${chain.length} contracts, expiry ${optionExpiry ?? "none"}`);
    if (future) {
      const q = (await client.quotes([future.token])).get(future.token);
      console.log(`  last price: ${q?.ltp ?? "no quote"}`);
    }
  }
}

async function main() {
  const demo = args.has("--demo");
  const dataDir = demo ? path.join(config.dataDir, "demo") : config.dataDir;
  let feed;
  if (demo) feed = new DemoFeed({ speed: Number(process.env.DEMO_SPEED) || 20 });
  else {
    const client = new SmartApiClient(config.angel, { dataDir, askTotp });
    if (!client.configured) {
      console.error("Angel One details are missing. Copy .env.example to .env and fill ANGEL_API_KEY, ANGEL_CLIENT_CODE and ANGEL_PIN.\nTo preview the app without an account run:  npm run demo");
      process.exit(1);
    }
    if (args.has("--check")) { await check(client); return; }
    await client.login();
    console.log("✅ Logged in to Angel One");
    feed = new AngelFeed(client);
  }
  const desk = new Desk(config, feed, { journal: new Journal(dataDir), notifier: new Notifier(config.telegram) });
  await desk.start();
  feed.attach(desk);
  const local = ["127.0.0.1", "localhost", "::1"].includes(config.server.host);
  if (!local && config.server.password.length < 8) {
    console.error("HOST is open to the network, so DASHBOARD_PASSWORD (at least 8 characters) is required in .env.");
    process.exit(1);
  }
  startServer(desk, { ...config.server, dataDir });
  scheduleDailyRestart(desk);
  const where = config.server.host === "0.0.0.0" ? `http://<this-computer's-IP>:${config.server.port}` : `http://${config.server.host}:${config.server.port}`;
  console.log(`\nMarketPilot ${demo ? "DEMO (simulated prices, ${feed.speed}x speed)" : "LIVE"} — dashboard: ${where}`);
  console.log(`Watching: ${config.products.map(k => PRODUCTS[k].label).join(", ")} · ${config.strategy.timeframe}-minute candles · alerts ${config.telegram.token ? "to Telegram + console" : "to console (set TELEGRAM_* in .env for phone alerts)"}`);
  console.log("Signals only — place orders yourself in the Angel One app. Press Ctrl+C to stop.\n");
  const shutdown = () => { desk.stop(); feed.stop(); process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}

/**
 * On a server MarketPilot runs for weeks. Once a day (DAILY_RESTART, IST, default 08:45)
 * it exits cleanly so the service manager restarts it with a fresh login and the
 * current month's contracts. Skipped when an open paper trade exists.
 */
function scheduleDailyRestart(desk) {
  const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(process.env.DAILY_RESTART ?? "") ? process.env.DAILY_RESTART : null;
  if (!at || args.has("--demo")) return;
  const started = istDay(Date.now());
  setInterval(() => {
    const now = Date.now();
    if (istDay(now) !== started && istClock(now) >= at && !desk.open.length) {
      console.log(`Daily restart (${at} IST) for a fresh login and contracts.`);
      process.exit(0);
    }
  }, 60000);
}

main().catch(error => { console.error(`❌ ${error.message}`); process.exit(1); });
