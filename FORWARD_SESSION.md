# Auditable LIVE forward paper session

**Real-account SmartAPI smoke test: NOT VERIFIED.** No authorized broker credentials or current reviewed MCX specification were supplied for this milestone. Automated tests use mocks and synthetic data. They test the software, not the strategy's trading edge.

MarketPilot remains private, single-user, CRUDEOILM futures only, and paper trading only. No order endpoint or broker order client is present. WTI, Brent and news have no bundled live provider. Trader positioning is unavailable; no positioning adapter is configured or simulated as LIVE.

## Run one session locally

Use Node 22.13+ on a persistent machine with a writable durable disk. The following commands are PowerShell; `npm` can replace `npm.cmd` on other shells.

1. From the standalone MarketPilot repository, install dependencies and create local configuration **only if it does not exist**:

   ```powershell
   npm.cmd ci
   if (-not (Test-Path -LiteralPath .env.local)) { Copy-Item -LiteralPath .env.example -Destination .env.local }
   ```

2. Edit `.env.local` locally, never in chat or Git. Set a strong unique `MARKETPILOT_PASSWORD` and a persistent `MARKETPILOT_DATA_DIR` (the default `.marketpilot` works). Keep the same directory for the web process and worker. Do not delete or change it to reset an active risk lockout. Configure the five `ANGEL_*` fields using your authorized SmartAPI session and actual client identity. The browser does not collect account PINs/TOTP. Run `npm.cmd run marketpilot:login` in an interactive terminal to obtain a session using hidden local prompts; only the JWT is saved. No authenticator seed or automatic renewal is used.

3. Review the current official MCX specification/circular and Angel One instrument master. Create the local file referenced by `MARKETPILOT_SPECS_FILE`, using the exact attestation schema in [MARKETPILOT.md](MARKETPILOT.md#contract-monetary-verification). Verify exact futures symbol, expiry, units per lot, rupee multiplier, tick size, source URL and review validity. No live monetary values are prefilled. Held contracts are reverified too; they are never silently rolled. Expiry-day quotes can support an existing position's exit, while new entries roll before expiry day.

4. Configure authorized HTTPS WTI, Brent and oil-news JSON adapters if available; see the [provider schema](MARKETPILOT.md#global-context-adapters). With the default `requireContext: true`, unavailable/stale global sources block entries. A session consisting entirely of WAIT decisions is a valid forward observation session. Do not disable safeguards or adjust thresholds to obtain trades or profits.

5. Verify and start the production web process in terminal 1:

   ```powershell
   npm.cmd run verify
   npm.cmd run start -- --hostname 127.0.0.1 --port 3100
   ```

6. In terminal 2, from the same repository and configuration:

   ```powershell
   npm.cmd run marketpilot:worker
   ```

   Open `http://127.0.0.1:3100`, authenticate with username `pilot` and your local password, and choose **LIVE**. For remote access use HTTPS and a private network/reverse proxy. The production app refuses access if its password is absent; all API downloads are protected.

7. Check **LIVE feed health**. **Configured** means local settings are present; it does not prove connectivity, credentials, data rights or a valid contract. **CONNECTED AND VERIFIED** requires a fresh accepted quote for the resolved contract. Verify exact token/symbol in the downloaded observations, last exchange time, age, increasing valid samples and a running worker. Compare a sample with your authorized broker terminal and the reviewed MCX specification. Only after that actual test can you record the real-account smoke test as verified for that contract/session.

8. Let observed one-minute candles accumulate: the unchanged default rules need at least 23 candles (roughly 23 minutes), with continuous recent evidence and required global context. Chart timeframes aggregate observed samples only. If an eligible BUY or SELL appears, review its evidence, stop, original one-lot size, planned loss and costs before choosing the paper-entry button. Entries require a new valid quote and are re-evaluated on click. The worker reassesses open positions and performs simulated exits. A stale/invalid quote never fills an entry or exit. Data-loss EXIT intent persists until a fresh valid quote permits a simulated exit.

9. Keep both processes running through the configured **23:00 Asia/Kolkata** assessment. **Run assessment now** is also available. The worker records unavailable data even without credentials. Assessment text with missing feed or global context explicitly withholds a market conclusion. A missed schedule can be caught up on the same IST day at the actual execution time; no assessment is backdated.

10. Choose the IST date in **Forward-session report** and click **Download LIVE report**. Review accepted/rejected observations, gaps, every decision/evidence snapshot, entries/exits, estimated costs, lockouts, assessments and net paper outcome. Before stopping a session, close any open paper position using valid data, or explicitly retain it as open/unpriced. Stop your worker/web processes with Ctrl+C. Back up the SQLite directory with both stopped. Restarting the same directory preserves positions, pending exits, history and lockouts.

## Audit and data semantics

Every LIVE monitoring attempt begins with a durable SQLite `PENDING` row before contract resolution or quote network I/O. Once known, the exact resolved contract/token is saved before requesting the quote. Completion saves a sanitized status, receipt timestamp, parsed exchange timestamp when available, contract specification snapshot and source (`worker` or `dashboard`). Only an `OK` row contains a price. No access tokens, client identity headers or raw broker responses/errors are logged. If contract resolution fails, the contract is null because a verified request identity was not established. A process interruption leaves a durable pending row; the next monitor attempt marks it `INTERRUPTED`.

| Status | Meaning and fill behavior |
|---|---|
| `OK` | Exact verified CRUDEOILM identity, positive finite price, exchange time no later than receipt, age at most 30 seconds, strictly newer than the last accepted quote for this token. Eligible for evaluation; not a promise of a trade. |
| `STALE` | More than 30 seconds old. No candle mutation or fill. |
| `FUTURE_DATED` | Later than receipt time, with no future tolerance. No fill. Keep the host clock synchronized. |
| `OUT_OF_ORDER` | Older than the persisted accepted exchange-time watermark for the exact contract. No fill. |
| `DUPLICATE` | A fresh repeated exchange timestamp supplies no new sample. Conservatively blocks fills and, for an open position, triggers a deferred safety exit. |
| `CONTRACT_MISMATCH` | Wrong token, symbol, exchange or changed held monetary specification. No fill. |
| `MALFORMED` | Invalid payload, timestamp or price, including impossible calendar dates. No fill. |
| `UNAVAILABLE` | Configuration, verified specification, transport or broker session unavailable. No fill. |
| `PENDING` / `INTERRUPTED` | No completed accepted response. Never used for fills. |

The worker waits five seconds between cycles; API refreshes/actions also produce observations. Actual sampling intervals can exceed five seconds due to network time or contention. Health counts cover the current IST day. Last-valid age survives restarts; largest gap includes elapsed outages and closed-market time because no exchange-session calendar is used. The worker label is a recent completed heartbeat, not proof of uninterrupted process health. Missing intervals remain gaps; neither bars nor prices are reconstructed. Sampled candles are incomplete and live volume is unavailable. Disconnect alerts appear on the next poll; this is not a tick-level feed.

SQLite remains native, disk-backed, WAL-enabled and transactional. A polling result must be persisted before it can affect state/fills. State, paper entries/exits, journal events and report checkpoints commit together. Existing SQLite databases migrate additively on startup. Historical records predating this audit milestone cannot be turned into observed broker data. Reports make no claim to complete market coverage. Disk/database failure stops processing; a down database cannot audit its own outage.

## Reports and outcomes

`GET /api/marketpilot/session?date=YYYY-MM-DD` downloads an authenticated JSON report for **LIVE only**. It exports every matching record, without the older decision download's 500-record limit. The date window is inclusive midnight to exclusive next midnight in Asia/Kolkata; machine-readable timestamps remain ISO UTC instants with the timezone/window explicitly recorded. Invalid/future dates are rejected. Replay has separate state, paper money, decisions and results.

The report includes polling status counts/gaps, evidence and rule versions, paper entries/exits, costs, journal/assessments, explicit daily-loss/profit-protection lockouts and a checkpoint of the last saved valuation. Trade-cap and manual-pause blockers also appear in decision evidence and the journal. Brokerage/statutory costs are estimated from the settings captured on each position. Spread, slippage and adverse tick rounding are embedded in simulated fills, not actual execution. LIVE targets/stops exit from the accepted quote plus friction; no favorable historical target fill is invented.

Daily outcome equals closed paper net plus estimated open liquidation value minus the carried opening mark. With an open position and no fresh accepted valuation at the report cutoff, `netDaily` is null, status is `OPEN_POSITION_UNPRICED`, and the retained `markedDailyEstimate` is explicitly historical. No saved session checkpoint means no asserted flat/zero day. Today's outcomes are provisional; overnight positions remain visible even if monitoring stopped. These are forward **paper** outcomes, never broker-account profits.

## Evidence still needed for an edge

First establish an authorized live-account market-data smoke test with exact contract/specification verification, reliable timestamps and measured gap/rejection rates. Then collect a sufficiently large, representative, time-ordered forward sample across different volatility/trend regimes, including all skipped setups, failed data periods and losing days. Freeze rules before evaluation; retain genuine out-of-sample/walk-forward periods. Compare net returns, drawdown, worst days and loss frequency against realistic costs, slippage and simpler benchmarks; quantify uncertainty and account for parameter/data-selection bias. Reconcile simulated costs against actual applicable contract notes and assess missed ticks/latency. Neither passing software tests, a synthetic replay nor one profitable forward session establishes an edge or guarantees a profitable trade/day.

## Session-calendar gate added in rules v1.1

Before a LIVE entry, configure MARKETPILOT_SESSION_FILE using the schema in MARKETPILOT.md. Review exact dates, holidays, special sessions and applicable closing times against official MCX circulars. Missing dates block entries even with verified fresh quotes. The dashboard shows session status and missing setting names. HOLD now explicitly identifies an intact open paper thesis. Rules remain unvalidated hypotheses; these software changes do not establish an edge.
