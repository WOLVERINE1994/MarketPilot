# MarketPilot

A private, single-user CRUDEOILM futures decision desk. **Paper trading only.** There is no broker order client, order endpoint, options support, regular Crude Oil support, or autonomous LLM trading. Rules are untested trading hypotheses, not predictions or promises of profit.

Capital protection takes precedence over activity or income. WAIT is appropriate for weak evidence; HOLD means an existing paper position retains its original thesis and stop. BUY/LONG and SELL/SHORT are eligible one-lot paper setups; EXIT protects an existing position. The hypothetical ₹2–3 lakh monthly aspiration is not an input to sizing, rules, targets or risk limits. Losses remain visible and persisted; averaging down and recovery sizing are not supported.

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

The worker polls LIVE every five seconds, evaluates live data when credentials are configured, handles immediate stop/reversal exits, and generates the scheduled assessment even when the browser is closed. Keep both processes running. Dashboard refreshes read committed worker state while its heartbeat is at most 30 seconds old, so tabs do not duplicate ingestion or compete with worker updates. Without a current heartbeat, dashboard refreshes resume ingestion and coalesce simultaneous requests; if another update holds the lease, they display the last saved state with current feed health. Paper commands always require the exclusive lease and their existing fresh-data/risk checks. Closing the worker stops unattended monitoring; the dashboard shows its heartbeat. This is a persistent Node deployment, **not an ephemeral/serverless deployment**. Run under a process supervisor for continuous use. Missing scheduled checks are caught up once monitoring resumes on the same IST day and are stamped with their actual generation time; there is no invented backdated assessment.

## First usable flow

For the auditable LIVE milestone, follow [FORWARD_SESSION.md](FORWARD_SESSION.md). The worker now records attempted LIVE monitoring even without credentials. Each quote passes strict ingestion checks before touching candles or simulated fills, and the LIVE health panel separates configuration from verified connectivity. Date-specific LIVE reports include the complete observation and forward paper ledger. The real-account smoke test remains **NOT VERIFIED**.

1. Open the app. The dashboard always uses **LIVE DATA** for CRUDEOILM; there is no mode switch.
2. Check connection health, contract/expiry and missing global feeds. Missing or stale required data keeps entries blocked and the recommendation at WAIT.
3. Read the decision evidence. Eligible BUY/LONG or SELL/SHORT setups can be recorded as one-lot paper trades; no broker orders are placed.
4. Monitor the stop, target, estimated costs and paper P&L. The worker handles protective paper exits when valid fresh data permits.
5. Inspect the LIVE journal, paper history, performance and forward-session report. The 23:00 IST assessment does not force a trade.

Synthetic replay remains an internal API/test fixture for validation. Its records cannot appear in the dashboard or LIVE reports; the worker polls only LIVE.

SQLite state, trade history, journal, day locks and full decisions survive restarts under `.marketpilot/marketpilot.sqlite`. LIVE and REPLAY have separate state, balances, positions, limits and decisions. Back up this directory with the processes stopped. Set `MARKETPILOT_DATA_DIR` for an alternative durable directory or a fresh independent replay workspace. The UI shows recent events; all events remain persisted. The dashboard decision download contains the latest 500 LIVE snapshots.

## Private access

Development binds to **127.0.0.1**. For production, set a strong `MARKETPILOT_PASSWORD` in `.env.local`; browser Basic authentication uses username `pilot`. Production refuses access without a password. Use HTTPS and a private network/reverse proxy for remote access. Never publish the database or expose a development server. Authentication protects both the dashboard and APIs. Same-origin checks protect browser mutations. API secrets are used only on the server and are never written to the journal or sent to the browser.

## Authorized Angel One market data

The LIVE setup checklist lists missing environment-variable **names only**. An API key alone is insufficient: SmartAPI also requires an authorized session JWT and client identity headers. Settings being present does not prove authentication or connectivity. Restart both web and worker processes after editing `.env.local`.

Follow the official [SmartAPI documentation](https://smartapi.angelone.in/docs). Configure only credentials and data rights that you are authorized to use:

- `ANGEL_API_KEY`, `ANGEL_ACCESS_TOKEN`: API key and valid authorized SmartAPI session JWT. Obtain/renew the session through your authorized broker workflow or run `npm.cmd run marketpilot:login`. The browser does not collect login credentials. The local terminal helper prompts for client code, PIN/password and the current authenticator code with hidden input; only the returned JWT is saved. TOTP seeds are never requested.
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

## Reviewed IST exchange sessions

Set MARKETPILOT_SESSION_FILE to a local JSON file reviewed against the applicable official MCX trading-hours and holiday circulars. This is a separate gate from quote connectivity and monetary-contract verification. No trading calendar is bundled or guessed from weekdays or US daylight-saving dates. Missing, expired, malformed or undated calendars block LIVE entries. A holiday has an explicit date with an empty windows array. Special evening sessions and seasonal 23:30/23:55 closes use the reviewed timestamps for that exact date.

File structure (placeholders must be replaced; this is not a verified live calendar):

```json
{
  "source": "https://www.mcxindia.com/circulars/all-circulars",
  "verifiedAt": "<actual review timestamp with timezone>",
  "validUntil": "<review validity timestamp with timezone>",
  "days": [
    {
      "date": "<YYYY-MM-DD>",
      "windows": [
        { "opensAt": "<YYYY-MM-DDTHH:mm:ss+05:30>", "closesAt": "<YYYY-MM-DDTHH:mm:ss+05:30>" }
      ]
    },
    { "date": "<reviewed holiday YYYY-MM-DD>", "windows": [] }
  ]
}
```

Windows must be ordered, nonoverlapping, within their stated IST day and within review validity. Date-specific review is a local attestation, not automatic validation of a circular's contents. The final five minutes block new entries and request EXIT for an open paper position; fills still require accepted fresh quotes. A closed or unverified session also requests a protective EXIT. If data is unavailable, the position and exit intent persist until a valid observation permits a simulated exit. The 23:00 IST assessment never forces an entry. Session status/source/window are captured in rule v1.1 decision snapshots and exported in forward reports. Replay continues to use explicitly synthetic chronology.

Results now report closed paper trade count, net win rate, losing trades, mean net P&L per trade (empirical expectancy), profit factor and estimated charges. The LIVE daily report exports the same measures for trades closed on that IST date. Open P&L is excluded from these closed-trade measures. Empty samples do not invent expectancy or win rates; profit factor is undefined without losses. All figures describe paper records and do not validate an edge.

## Current local setup

See [LIVE_SETUP.md](LIVE_SETUP.md) for the 2 October 2026 local contract/session review and remaining authentication blocker. Run `npm.cmd run marketpilot:check` after credential changes. This is a read-only setup diagnostic, not trading execution. WTI, Brent and oil-news sources are intentionally absent; LIVE global-context protection remains enabled and entry recommendations remain WAIT while required context is missing.
