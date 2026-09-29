# MarketPilot

A private, single-user CRUDEOILM futures decision desk. **Paper trading only.** There is no broker order client, order endpoint, options support, regular Crude Oil support, or autonomous LLM trading. Rules are untested trading hypotheses, not predictions or promises of profit.

## Run locally

Requires Node **22.13+** (tested on Node 24.14), npm, and a writable persistent local disk. MarketPilot uses Next.js 16.3, React 19, TypeScript, Vitest, Playwright and Node's built-in SQLite. No external database or migration is required.

```powershell
npm.cmd install
# Only if you do not already have .env.local:
Copy-Item .env.example .env.local
npm.cmd run dev -- --port 3100
```

Open http://127.0.0.1:3100. In a second terminal:

```powershell
npm.cmd run marketpilot:worker
```

On shells without PowerShell execution-policy restrictions, `npm` also works. Do not overwrite existing `.env.local` credentials. 

The worker polls every five seconds, advances a playing replay by one candle per tick, evaluates live data when credentials are configured, handles immediate stop/reversal exits, and generates the scheduled assessment even when the browser is closed. Keep both processes running. Closing the worker stops unattended monitoring; the dashboard shows its heartbeat. This is a persistent Node deployment, **not an ephemeral/serverless deployment**. Run under a process supervisor for continuous use. Missing scheduled checks are caught up once monitoring resumes on the same IST day and are stamped with their actual generation time; there is no invented backdated assessment.

## First usable flow

For the auditable LIVE milestone, follow [FORWARD_SESSION.md](FORWARD_SESSION.md). The worker now records attempted LIVE monitoring even without credentials. Each quote passes strict ingestion checks before touching candles or simulated fills, and the LIVE health panel separates configuration from verified connectivity. Date-specific LIVE reports include the complete observation and forward paper ledger. The real-account smoke test remains **NOT VERIFIED**.

1. Start in **REPLAY**. The contract, prices, volume, WTI, Brent and news are explicitly synthetic fixtures, not historical or live observations.
2. Use **Next candle**, or start the worker and choose **Play**. Only observed candles are returned to the browser. The server advances sequentially; there is no seek-ahead API.
3. Read the decision evidence. If BUY or SELL is eligible, choose **Paper BUY/SELL · 1 lot**. WAIT is expected during weak evidence, paused entries, missing context, or risk lockout.
4. The paper entry includes spread/slippage and a nonzero stop-loss budget. Monitor its stop, target and estimated net liquidation P&L. The worker exits automatically on a stop, target, failed thesis or risk lockout; manual paper exit is available too.
5. Inspect the journal, paper trades, separate replay results, or downloaded decision snapshots. Run an assessment immediately, or advance the replay through 23:00 IST for its scheduled assessment. Replay end liquidates any remaining paper position using the final observed price.

SQLite state, trade history, journal, day locks and full decisions survive restarts under `.marketpilot/marketpilot.sqlite`. LIVE and REPLAY have separate state, balances, positions, limits and decisions. Back up this directory with the processes stopped. Set `MARKETPILOT_DATA_DIR` for an alternative durable directory or a fresh independent replay workspace. The UI shows recent events; all events remain persisted. The decision download contains the latest 500 full snapshots for the selected mode.

## Private access

Development binds to **127.0.0.1**. For production, set a strong `MARKETPILOT_PASSWORD` in `.env.local`; browser Basic authentication uses username `pilot`. Production refuses access without a password. Use HTTPS and a private network/reverse proxy for remote access. Never publish the database or expose a development server. Authentication protects both the dashboard and APIs. Same-origin checks protect browser mutations. API secrets are used only on the server and are never written to the journal or sent to the browser.

## Authorized Angel One market data

Follow the official [SmartAPI documentation](https://smartapi.angelone.in/docs). Configure only credentials and data rights that you are authorized to use:

- `ANGEL_API_KEY`, `ANGEL_ACCESS_TOKEN`: API key and valid authorized SmartAPI session JWT. Obtain/renew the session through your authorized broker workflow; this app does not collect PINs or TOTP seeds.
- `ANGEL_CLIENT_LOCAL_IP`, `ANGEL_CLIENT_PUBLIC_IP`, `ANGEL_MAC_ADDRESS`: your actual SmartAPI client identity headers.
- `MARKETPILOT_SPECS_FILE`: path to a locally reviewed monetary-specification file described below.

The adapter reads Angel One's [instrument master](https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json), filters exactly `MCX / CRUDEOILM / FUTCOM`, and selects the earliest future expiry strictly after the current IST day. It conservatively rolls before expiry-day entries. It requests only the resolved token from SmartAPI's **FULL market quote endpoint**, validates exchange/token/symbol/price/time, and treats missing, stale (>30 seconds), future-dated or out-of-order data as unsafe. Session expiry and network failure block entries. Open positions get EXIT alerts on data loss, but no fill is invented until a fresh observation arrives.

Live candles are **one-minute sampled quote candles**, built from five-second observations after the worker starts. They are not exchange-complete tick bars; live volume is unavailable and shown as zero. The rules warm up on at least `slow + 3` observed candles, and gaps in recent history block entries. Stops can gap or be missed between samples: actual losses can exceed the planned loss. The live integration is covered with mocked broker response tests; it requires your credentials and reviewed specifications for a real account smoke test.

### Contract monetary verification

The master includes expiry, lot size and scaled tick size, but does **not** independently prove the rupee P&L multiplier. MarketPilot will not infer it from the symbol or hard-code it. Review the applicable official [MCX contract specifications/circular](https://www.mcxindia.com/products/energy/crude-oil), and create a local JSON array (ignored example filename: `marketpilot-specs.local.json`) with these fields:

| Field | Meaning |
|---|---|
| `symbol` | Exact currently tradable futures symbol from the broker master |
| `expiry` | Verified expiry as `YYYY-MM-DD` |
| `lotSize` | Verified exchange units per lot, matching the broker master |
| `multiplier` | Rupee P&L for a one-rupee quoted move, for one lot |
| `tickSize` | Rupees per quoted tick, matching broker `tick_size / 100` |
| `source` | Exact HTTPS MCX specification/circular URL reviewed |
| `verifiedAt` | ISO timestamp with timezone of your review |
| `validUntil` | ISO timestamp with timezone, after which review must be renewed |

No live specification values are prefilled. This file is a **manual verification attestation**, not a cryptographic check of MCX documents. The resolver cross-checks it with fresh broker instrument data and blocks on missing, mismatched or expired attestation. Fixture specifications are accepted only inside REPLAY.

## Global context adapters

WTI, Brent and oil news have separate adapter functions. Configure authorized HTTPS endpoints using `WTI_CONTEXT_URL`, `BRENT_CONTEXT_URL`, `OIL_NEWS_URL`, and optionally `CONTEXT_API_KEY` (Bearer authentication). They must return:

```json
{
  "source": "Your licensed provider name",
  "time": "2026-09-14T17:30:00Z",
  "value": 68.24,
  "bias": "NEUTRAL",
  "block": false
}
```

This is an illustrative schema, not a live quote. News requires `headline` instead of `value`. `bias` is `UP`, `DOWN`, or `NEUTRAL`, supplied by your transparent upstream data adapter, not an LLM. Sources must be no more than 15 minutes old. Unconfigured, invalid, failed, or stale adapters display **UNAVAILABLE**, never fabricated LIVE values. Replay panels display **DEMO**. By default, all three sources must be fresh; any event blocker or fresh opposing direction prevents an entry. The global-confirmation requirement can be disabled explicitly in settings; an event blocker still blocks. Review your provider's redistribution/access permissions before configuring it.

## Rule and risk semantics

- Version `transparent-1.0.0`: simple fast/slow averages, three-candle percent momentum, 14-candle true-range volatility, minimum trend separation, and configurable volatility ceiling. Chart timeframes are display aggregation only; rule inputs remain one-minute candles.
- Original stop distance is `max(1.6 × ATR, 4 × tick size)`, rounded to ticks. Target is twice this price distance. Stop/target do not trail or widen. Entry thesis fails on opposing trend or meaningful opposing momentum.
- Size is always **one lot**; only one position per mode. No averaging down, recovery sizing, pyramiding or reversing in the same minute. A position's original cost/risk settings are retained.
- Planned loss includes stop distance, both execution frictions, and estimated round-trip charges. Both per-trade and remaining daily loss budgets must permit it. Planned loss is not a guaranteed maximum realized loss.
- Net accounting uses actual simulated entry/exit fills with half-spread plus slippage on each side, rounded adversely to the verified price tick. Charges per side are fixed brokerage plus `notional × statutoryBps / 10000`. The statutory rate is a **configurable blended estimate**, not a maintained legal tariff; verify it against your contract note. Brokerage and statutory estimates are separate from execution friction and are not double-counted.
- Daily equity includes realized P&L and estimated net liquidation P&L. IST midnight carries forward prior marked P&L as the new day's opening baseline; an overnight gap counts against the new day. A hit daily-loss limit latches until the next IST day, including after settings changes. Profit protection also latches when a configured peak is reached and then gives back the allowed amount. Neither ensures a positive close.
- Replay stops take precedence over targets if both are touched in the same subsequent OHLC candle; adverse opening gaps are filled at the worse opening price plus friction. No pre-entry candle extrema can trigger a retrospective exit. Live checks use the current observed quote.
- All evaluations are stored with timestamp, input indicators, rule version, configuration, context, contract and reasons. Notifications are deduplicated across repeated equivalent evidence; decision storage continues. Notification delivery has an interface for future push delivery; V1 uses the persistent in-app journal and five-second dashboard refresh.
- Results show positive/flat/negative days, net outcomes, worst day and observed equity drawdown, including open MTM. Today's classification is provisional. Replay results provide no evidence of future profitability.

## Verification

```powershell
npm.cmd run test:marketpilot
npm.cmd run test:marketpilot:e2e
npm.cmd run lint
npm.cmd run build
```

`tests/marketpilot.test.ts` checks contract identity/rollover/spec mismatches, long/short costs, gap stops, stale data, WAIT/BUY/SELL/EXIT, locks, replay visibility, IST midnight/23:00, broker/context adapters, persistence, writer exclusion and private access. The Playwright suite covers the dashboard → API → SQLite → paper entry/exit → net result → journal → assessment flow, mode isolation, and mobile layout. It starts a separate `.marketpilot-e2e/run-*` database (stop an existing dev server on port 3100 first).

If Windows process teardown stalls after the browser tests, start an isolated test server manually with `MARKETPILOT_DATA_DIR=.marketpilot-e2e/your-new-run`, empty broker credentials and an empty `MARKETPILOT_PASSWORD`, then set `MARKETPILOT_E2E_EXTERNAL=1` in the test terminal. This bypasses Playwright's server lifecycle; stop that server yourself afterward. Screenshots are saved to `.marketpilot-e2e/desktop.png` and `mobile.png`.

Source modules: `src/marketpilot/adapters/`, `contracts.ts`, `rules.ts`, `risk.ts`, `paper.ts`, `engine.ts`, `storage.ts`, `notifications.ts`. UI: `dashboard.tsx`, `chart.tsx`. API: `src/app/api/marketpilot/route.ts`. Worker: `scripts/marketpilot-worker.ts`. Synthetic fixture: `data/marketpilot/replay.json`; its deterministic generator is `npm run marketpilot:replay`.
