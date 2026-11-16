import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Instruments this desk understands. `multiplier` is rupees of P&L per one-rupee
 * price move for one lot (MCX quotes Crude Mini per barrel x 10 barrels and
 * Silver Mini per kg x 5 kg). The instrument master's lot size is cross-checked
 * against `lot` at runtime and a warning is shown if MCX ever changes it.
 */
export const PRODUCTS = {
  CRUDEOILM: {
    key: "CRUDEOILM", label: "Crude Oil Mini", unit: "barrel", lot: 10, multiplier: 10,
    futures: true, options: true,
  },
  SILVERM: {
    key: "SILVERM", label: "Silver Mini", unit: "kg", lot: 5, multiplier: 5,
    // Silver Mini futures need ~₹1.5 lakh margin, so for a small account the
    // futures chart is the direction reference and trades are CE/PE buys.
    futures: false, options: true,
  },
};

const num = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : fallback;
};
const time = (value, fallback) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(value ?? "") ? value : fallback);

export function loadEnv(file = path.join(process.cwd(), ".env")) {
  if (existsSync(file)) process.loadEnvFile(file);
}

export function readConfig(env = process.env) {
  const products = (env.PRODUCTS || "CRUDEOILM,SILVERM").split(",").map(s => s.trim().toUpperCase()).filter(k => PRODUCTS[k]);
  return {
    angel: {
      apiKey: env.ANGEL_API_KEY?.trim() || "",
      clientCode: env.ANGEL_CLIENT_CODE?.trim() || "",
      pin: env.ANGEL_PIN?.trim() || "",
      totpSecret: env.ANGEL_TOTP_SECRET?.replace(/\s+/g, "") || "",
      localIp: env.ANGEL_CLIENT_LOCAL_IP?.trim() || "",
      publicIp: env.ANGEL_CLIENT_PUBLIC_IP?.trim() || "",
      mac: env.ANGEL_MAC_ADDRESS?.trim() || "",
    },
    risk: {
      capital: num(env.CAPITAL, 31000),
      maxLossPerTrade: num(env.MAX_LOSS_PER_TRADE, 620),
      dailyLossLimit: num(env.DAILY_LOSS_LIMIT, 1500),
      maxTradesPerDay: num(env.MAX_TRADES_PER_DAY, 4),
      costPerTrade: num(env.COST_PER_TRADE, 60),
    },
    strategy: {
      timeframe: Math.max(1, Math.round(num(env.TIMEFRAME, 5))),
      emaFast: num(env.EMA_FAST, 9),
      emaSlow: num(env.EMA_SLOW, 21),
      emaTrend: num(env.EMA_TREND, 50),
      rsiLength: num(env.RSI_LENGTH, 14),
      atrLength: num(env.ATR_LENGTH, 14),
      atrStop: num(env.ATR_STOP, 1.5),
      riskReward: num(env.RISK_REWARD, 2),
      breakevenAtR: num(env.BREAKEVEN_AT_R, 1),
      entryStart: time(env.ENTRY_START, "09:15"),
      entryEnd: time(env.ENTRY_END, "22:45"),
      squareOff: time(env.SQUARE_OFF, "23:15"),
    },
    // Crude can be traded as Mini futures or as CE/PE; silver is always CE/PE.
    crudeTrade: (env.CRUDE_TRADE || "OPTIONS").toUpperCase() === "FUTURES" ? "FUTURES" : "OPTIONS",
    optionStrike: ["ATM", "ITM1", "OTM1"].includes((env.OPTION_STRIKE || "").toUpperCase()) ? env.OPTION_STRIKE.toUpperCase() : "ATM",
    products,
    telegram: { token: env.TELEGRAM_BOT_TOKEN?.trim() || "", chatId: env.TELEGRAM_CHAT_ID?.trim() || "" },
    server: { port: num(env.PORT, 3100), host: env.HOST?.trim() || "127.0.0.1", password: env.DASHBOARD_PASSWORD || "" },
    dataDir: env.MARKETPILOT_DATA_DIR || path.join(process.cwd(), "data"),
  };
}
