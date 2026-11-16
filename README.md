# MarketPilot — MCX intraday signal desk

MarketPilot watches **Crude Oil Mini** and **Silver Mini** on MCX through your Angel One SmartAPI account. It tells you when to **BUY CE**, **BUY PE** or **EXIT**, with the strike, premium, stop-loss and target. Alerts go to your phone on Telegram, and the dashboard opens in any browser, including your phone.

- **Signals only.** You place the orders yourself in the Angel One app. MarketPilot never places orders.
- **Paper tracking.** Every signal is recorded with its paper result after estimated costs, so you can see if it is working before you trust it with money.
- **Backtester.** It runs the exact same strategy on past Angel One data and shows the win rate, profit, drawdown and worst losing streak.
- **Zero dependencies.** It needs only Node.js 22 or newer. No `npm install` is required.

> No software can guarantee profit or "no loss". MarketPilot keeps losses small and planned (every trade has a stop-loss) and tells you honestly how the strategy has performed. Results in the past or on paper do not guarantee future results.

---

## 1. Try it right now (no account needed)

```bash
npm run demo
```

Open http://127.0.0.1:3100. Demo mode uses **simulated prices at 20× speed**, so you can see how signals, alerts and paper results look. Set `DEMO_SPEED=300` for even faster signals.

## 2. One-time setup for live data

1. **Install Node.js 22 LTS** from https://nodejs.org (Windows installer). Check it with `node -v`.
2. **Get the code:** download this repository (green *Code* button → *Download ZIP*) or `git clone` it.
3. **Create a SmartAPI app:** log in at https://smartapi.angelone.in → *My Apps* → create an app (type *Market Feeds* is enough). Copy the **API key**.
4. **Enable TOTP:** on https://smartapi.angelone.in/enable-totp, enable TOTP for your client code. You can save the **TOTP secret** that is shown. With it, MarketPilot logs in by itself every day. Without it, MarketPilot asks you for the 6-digit code each time it starts.
5. **Create your settings file:** copy `.env.example` to `.env` and fill in `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_PIN` and optionally `ANGEL_TOTP_SECRET`. Keep `.env` private. It is already excluded from Git.
6. **Phone alerts (recommended):** in Telegram, message **@BotFather** → `/newbot`. Copy the bot token into `TELEGRAM_BOT_TOKEN`. Send any message to your new bot, then get your chat id from **@userinfobot** and put it in `TELEGRAM_CHAT_ID`.
7. **Check the connection:** run `npm run login-test`. It logs in and prints the contracts it will watch and their last prices.

## 3. Daily use

```bash
npm start
```

Leave the window open during market hours. At startup MarketPilot loads the last few days of candles from Angel One, so signals work right away with no warm-up wait.

- Dashboard: http://127.0.0.1:3100. To open it on your phone over the same Wi-Fi, set `HOST=0.0.0.0` and a `DASHBOARD_PASSWORD` in `.env`, then open `http://<your-computer-IP>:3100`. The username can be anything.
- Click **🔕 Off** on the dashboard to turn on sound and pop-up alerts in that browser.
- Paper results are saved in `data/journal.jsonl`. Download them from the dashboard as CSV.

## 4. Backtest before you trust it

```bash
npm run backtest -- --product CRUDEOILM --days 60
npm run backtest -- --product SILVERM --days 60
npm run backtest -- --product SILVERM --csv my-1min-candles.csv   # your own data: time,open,high,low,close[,volume]
```

The backtest prints the number of trades, win rate, net result after costs, average win and loss, profit factor, maximum drawdown, worst losing streak and best and worst day. The full trade list is saved to `data/backtest-<product>.csv`.

Things to know:

- Angel One only provides history for contracts that still exist (the current and next month), so `--days` is limited by that. For longer tests, use `--csv` with your own data.
- Option results are **estimated** as futures points × 0.5 (delta) and ignore time decay. Expect real option results to be somewhat worse.

Change the strategy settings in `.env`, backtest again, and only keep changes that hold up across both products and different months.

## 5. How the signals work

The signals use **5-minute candles** of the futures contract that the options are based on:

| Step | Rule |
|---|---|
| Trend | The 9-EMA crosses the 21-EMA (within the last 3 candles). Price is on the same side of the 50-EMA, by at least 0.25 × ATR, and the 50-EMA slopes that way. This chop filter avoids sideways whipsaws. |
| Momentum | RSI 50–75 for a buy (not overbought), 25–50 for a sell (not oversold). |
| Instrument | An up signal means **BUY CE**, a down signal means **BUY PE**, at the ATM strike (set `OPTION_STRIKE=ITM1/OTM1` to change). Crude can trade Mini futures instead with `CRUDE_TRADE=FUTURES`. |
| Stop-loss | 1.5 × ATR from the futures entry. The option stop is estimated from it. |
| Target | 2 × the stop distance (2R). |
| Breakeven | After a 1R move in your favour, the stop moves to the entry price. |
| Exit | Stop, target, an EMA crossover against the trade, or square-off at **23:15 IST**. |
| Time window | New entries only between 09:15 and 22:45 IST. |

Every number above is a setting in `.env`.

## 6. Your money rules (₹31,000 account)

The defaults are a ₹620 maximum loss per trade (2%), a ₹1,500 daily loss limit and 4 trades a day. MarketPilot **never hides a signal**. When a trade breaks one of your rules, the alert and dashboard show a ⚠️ warning, and you decide.

Realistic expectations for a ₹31k account:

- **Crude Oil Mini CE/PE:** about ₹2–4k premium per lot, so these usually fit your limits.
- **Silver Mini CE/PE:** often ₹20–30k premium per lot, and the estimated loss at stop is often above ₹620, so expect ⚠️ warnings. MCX has **no options on Silver Micro or Silver 100**, so Silver Mini is the smallest silver option.
- Take one trade at a time and stop for the day when the daily limit warning appears. That is the "minimum loss" part, and it is up to you.

## 7. Files

```
src/main.js          start-up (live, --demo, --check)
src/smartapi.js      Angel One login (TOTP), instrument master, quotes, historical candles
src/stream.js        SmartAPI WebSocket V2 live ticks (binary packet parser)
src/contracts.js     picks the futures contract, option expiry and CE/PE strike
src/strategy.js      the strategy (shared by live desk and backtester)
src/risk.js          one-lot plan: premium, option stop/target, rupee risk, warnings
src/desk.js          ties it together: candles → signals → alerts → paper trades
src/backtest*.js     backtester
src/feeds.js         live Angel One feed and the demo simulator
src/server.js        dashboard server (page, JSON, live updates, CSV)
public/index.html    dashboard
test/                automated tests:  npm test
```
