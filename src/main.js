import { createInterface } from "node:readline/promises";
import { loadEnv, readConfig, PRODUCTS } from "./config.js";
import { SmartApiClient } from "./smartapi.js";
import { AngelFeed, DemoFeed } from "./feeds.js";
import { Desk } from "./desk.js";
import { Journal } from "./journal.js";
import { Notifier } from "./notify.js";
import { startServer } from "./server.js";
import { selectContracts } from "./contracts.js";
import { istDay } from "./time.js";
import path from "node:path";

const args = new Set(process.argv.slice(2));
loadEnv();
const config = readConfig();

async function askTotp() {
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
  startServer(desk, config.server);
  const where = config.server.host === "0.0.0.0" ? `http://<this-computer's-IP>:${config.server.port}` : `http://${config.server.host}:${config.server.port}`;
  console.log(`\nMarketPilot ${demo ? "DEMO (simulated prices, ${feed.speed}x speed)" : "LIVE"} — dashboard: ${where}`);
  console.log(`Watching: ${config.products.map(k => PRODUCTS[k].label).join(", ")} · ${config.strategy.timeframe}-minute candles · alerts ${config.telegram.token ? "to Telegram + console" : "to console (set TELEGRAM_* in .env for phone alerts)"}`);
  console.log("Signals only — place orders yourself in the Angel One app. Press Ctrl+C to stop.\n");
  const shutdown = () => { desk.stop(); feed.stop(); process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}

main().catch(error => { console.error(`❌ ${error.message}`); process.exit(1); });
