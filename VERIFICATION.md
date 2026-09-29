# Auditable LIVE feed milestone (after 5387daa)

Verified locally on 2026-09-29, Node v24.14.0 / npm 11.9.0. **Real-account SmartAPI smoke test: NOT VERIFIED.** This checkout has no `.env.local` or reviewed live specification. Broker/provider inputs in automated positive-path tests are mocks; no actual authenticated broker quote was obtained. The existing storage-fix evidence follows below as historical context.

## Final exact commands and results

```powershell
npm.cmd run verify
```

Exit **0**. This command runs `npm run lint && npm test && npm run build`: ESLint passed; Vitest **75 tests passed in 5 files**, 2.09 seconds; the default Next.js 16.3.3 **Turbopack** production build passed compilation, TypeScript, page collection and prerendering, including `/api/marketpilot/session`. Native `process.getBuiltinModule("node:sqlite")`, WAL persistence and private proxy access remain intact.

Final production browser-test server, terminal 1:

```powershell
$env:MARKETPILOT_PASSWORD='marketpilot-local-browser-test'
$env:MARKETPILOT_DATA_DIR='.marketpilot-e2e/live-audit-final'
$env:ANGEL_API_KEY=''
$env:ANGEL_ACCESS_TOKEN=''
$env:ANGEL_CLIENT_LOCAL_IP=''
$env:ANGEL_CLIENT_PUBLIC_IP=''
$env:ANGEL_MAC_ADDRESS=''
$env:MARKETPILOT_SPECS_FILE=''
$env:WTI_CONTEXT_URL=''
$env:BRENT_CONTEXT_URL=''
$env:OIL_NEWS_URL=''
npm.cmd run start -- --hostname 127.0.0.1 --port 3115
```

The password is a loopback-only test fixture, never an application default. Use a fresh isolated test data directory for another browser run.

Browser tests, terminal 2:

```powershell
$env:MARKETPILOT_E2E_PRODUCTION='1'
$env:MARKETPILOT_E2E_EXTERNAL='1'
$env:MARKETPILOT_E2E_PORT='3115'
npm.cmd run test:e2e
```

Exit **0**; **3 passed (4.2 seconds)** in Chromium. Verified synthetic replay chart/decision/entry/exit/cost/journal/assessment flow, LIVE disconnected health, zero valid LIVE quotes/fills, data-unavailable assessment wording, date-specific authenticated JSON download, invalid-date rejection, mobile layout/settings and private page/API/report access. Credential-free requests returned **401**. No desktop page errors were captured. Desktop and mobile screenshots were inspected; files are in ignored `.marketpilot-e2e/` (`desktop.png`, `mobile.png`, `live-health.png`, `live-mobile.png`). Production-only checks ran; none were skipped. External server mode avoids the known Windows Playwright managed-server teardown problem; authentication is still tested. The test server was stopped afterward.

The separate actual worker smoke command was:

```powershell
$env:MARKETPILOT_DATA_DIR='.marketpilot-e2e/live-audit-milestone'
$env:ANGEL_API_KEY=''
$env:ANGEL_ACCESS_TOKEN=''
$env:MARKETPILOT_SPECS_FILE=''
$env:WTI_CONTEXT_URL=''
$env:BRENT_CONTEXT_URL=''
$env:OIL_NEWS_URL=''
npm.cmd run marketpilot:worker
```

Against the isolated production server using that same directory, authenticated health/report reads showed **16 UNAVAILABLE attempts, 11 from the separate worker, 0 valid samples, 0 entries, 0 exits, WAIT, worker RUNNING, configured false, connection NOT_VERIFIED**. The measured largest ongoing gap was **67.353 seconds**. The worker was then deliberately stopped with Ctrl+C. This verifies disconnected monitoring/persistence, not a broker connection.

During implementation, one report fixture incorrectly dated an overnight position's entry after its checkpoint; fixing the fixture resolved that assertion. The first expanded production type check caught an array-versus-fixed-tuple error in mocked global context; the mock now explicitly returns the required three-item tuple. Neither fix changed strategy thresholds. Final review corrected an empty-feed false “already used this candle” reason and replaced an unavailable price change's `0.00` display with “Change unavailable”; all checks were rerun afterward. Node's SQLite experimental warning and Playwright's color-environment warning remain non-failing runtime warnings.

## Coverage and boundaries

- Strict SmartAPI identity, finite-positive prices, impossible timestamp/calendar rejection and sanitized errors; held-contract review revalidation and expiry-day exit identity.
- Durable PENDING/completed/interrupted attempts; stale, future, out-of-order, duplicate, mismatched, malformed and disconnected samples; no invalid-data entry/manual-exit/automatic-exit fills; deferred exits after recovery; measured gaps and worker heartbeat.
- Separate Node-process recovery of the accepted LIVE watermark and full report, plus the earlier open-position/lockout persistence, WAL, rollback and fail-closed SQLite tests.
- Exact IST midnight and 23:00 handling; exports beyond 500 decisions; replay/future exclusion; entries/exits/costs/lockouts; historical and overnight open positions reported as unpriced when appropriate.
- No strategy threshold, default risk limit, brokerage formula, spread or slippage setting was altered. LIVE exit fills now consistently use the accepted observed quote (including target exits), while synthetic replay retains its existing OHLC model.

Five-second polling is sampled, not a complete tick feed. Actual intervals increase with network latency/contention, and gaps include market closures because no exchange-session calendar is configured. The machine clock must be correct. No actual broker session, current MCX monetary specification, live WTI/Brent/news provider, real-world tariff, long-running production uptime or real market execution quality has been verified. No strategy edge is established.

## Changed files

- Feed/contract boundary: `src/marketpilot/adapters/smartapi.ts`, `contracts.ts`, `feed.ts`, `feed-types.ts`.
- Persistent forward flow: `src/marketpilot/storage.ts`, `engine.ts`, `types.ts`, `rules.ts`, `report.ts`, `scripts/marketpilot-worker.ts`, `src/app/api/marketpilot/session/route.ts`.
- Dashboard: `src/marketpilot/dashboard.tsx`, `marketpilot.css`.
- Tests: `tests/live-feed.test.ts`, `session-report.test.ts`, `smartapi-validation.test.ts`, `storage-regression.test.ts`, `marketpilot-browser/flow.spec.ts`.
- Setup/evidence: `.env.example`, `README.md`, `MARKETPILOT.md`, `FORWARD_SESSION.md`, `VERIFICATION.md`.

Full setup, report semantics, source classifications and evidence required before an edge claim are documented in [FORWARD_SESSION.md](FORWARD_SESSION.md).

---

# Historical storage build fix and data-source audit

Verified on 2026-09-29 with Node v24.14.0 and npm 11.9.0 in the standalone MarketPilot checkout.

## Fix

The default `npm.cmd run build` reproduced this production failure during route collection:

```text
Cannot find module 'node:sqlite': Unsupported external type Url for commonjs reference
src/marketpilot/storage.ts:9
```

`storage.ts` now loads the real native SQLite implementation inside `db()` using `process.getBuiltinModule("node:sqlite")`. It no longer asks Turbopack to transform `createRequire(import.meta.url)`. Missing SQLite raises an error; there is no in-memory fallback. Database location, schema, WAL, transactions, busy timeout and writer leases are unchanged. Authentication and all signal/risk/cost rules are unchanged.

## Exact successful commands

All commands run from this repository's root. `npm.cmd` is the Windows executable equivalent of `npm`; it avoids PowerShell's script execution-policy restriction.

Locked local dependency installation:

```powershell
npm.cmd ci --ignore-scripts --cache .npm-cache --no-audit --no-fund
```

Result: exit 0; 400 packages installed. The checkout previously relied on parent-directory dependencies, which Turbopack correctly would not resolve outside its configured project root.

```powershell
npm.cmd run verify
```

Result: exit 0. ESLint passed; Vitest passed **23 tests in 2 files**; default `next build` passed with **Turbopack**, including TypeScript, page-data collection and prerendering. No Webpack override was used.

Production browser-test server, terminal 1:

```powershell
$env:MARKETPILOT_PASSWORD = 'marketpilot-local-browser-test'
$env:MARKETPILOT_DATA_DIR = '.marketpilot-e2e/production-storage-fix'
npm.cmd run start -- --hostname 127.0.0.1 --port 3114
```

The password above is an isolated loopback test fixture, not a deployment credential. The application does not use it as a default.

Browser tests, terminal 2:

```powershell
$env:MARKETPILOT_E2E_PRODUCTION = '1'
$env:MARKETPILOT_E2E_EXTERNAL = '1'
$env:MARKETPILOT_E2E_PORT = '3114'
npm.cmd run test:e2e
```

Result: exit 0; **3 passed (3.8 seconds)**. Verified desktop paper entry/exit and net-cost accounting, journal and assessment, mode isolation, mobile settings/layout, and production page/API authentication. External-server mode avoids a Windows Playwright server-teardown stall; it does not bypass application authentication. Use a fresh test data directory for another run.

The first production access-test attempt accidentally inherited Playwright's test credentials. The corrected test uses native credential-free `fetch` and proves rejection with HTTP 401. Authenticated API test requests send their credentials preemptively to avoid aborted challenge/retry requests. No application access control was relaxed.

Additional checks:

- Stopped the production server and restarted it with the same command/data directory. Authenticated `GET /api/marketpilot?mode=REPLAY` returned HTTP 200 and all **24 decision snapshots**, byte-for-byte identical after JSON serialization to the pre-restart response.
- Restarted production on port 3115 with an empty password using `$env:MARKETPILOT_PASSWORD = ''; npm.cmd run start -- --hostname 127.0.0.1 --port 3115`. Credential-free requests to `/` and `/api/marketpilot?mode=REPLAY` both returned **503**.
- Added subprocess regression tests for recovery of an open position, daily lockout, journal and decisions; WAL retention; transaction rollback on a failed decision insert; and fail-closed behavior when native SQLite is unavailable.
- `git diff --exit-code HEAD -- src/proxy.ts src/marketpilot/rules.ts src/marketpilot/risk.ts src/marketpilot/types.ts src/marketpilot/paper.ts` returned exit 0 before committing: no authentication, signal thresholds, risk limits or P&L/cost formulas changed.

Node emitted its native SQLite experimental-feature warning. Playwright emitted a `NO_COLOR`/`FORCE_COLOR` warning. These did not fail the successful checks.

## Dashboard data audit

This audit covers the inspected checkout and local verification run, not an independently inspected deployed account. Configuration presence was checked without printing any credential values. All five SmartAPI credential/client-identity variables, `MARKETPILOT_SPECS_FILE`, and the three global-provider URLs were unset; no verified specification file existed.

| Dashboard information | Actual backing in this setup |
|---|---|
| CRUDEOILM price, candles, volume, trend and contract in REPLAY | Deterministic synthetic fixture; the demo expiry, lot and multiplier are not a current verified tradable contract. |
| Exchange timestamp and “0s old” in REPLAY | Simulated fixture timestamp, measured against the replay clock. Not evidence of a currently fresh exchange feed. |
| LIVE contract, quote and feed status | Real SmartAPI adapter exists, but no authenticated broker data was exercised. Contract remains unverified, feed disconnected and entries blocked. Selecting LIVE is not proof of a live feed. |
| WTI, Brent and oil news | Synthetic DEMO values/news in REPLAY. UNAVAILABLE in LIVE until authorized, fresh provider responses are configured. |
| BUY/SELL/WAIT/EXIT and evidence | Deterministic implemented rules. Directional examples use synthetic replay input; the LIVE WAIT result reflects missing inputs. No validated trading edge or live predictive accuracy is demonstrated. |
| Paper position, net P&L, day counts, worst day and drawdown | Actual calculations over simulated fills and persisted paper records. Not broker executions, account balances or demonstrated live profits. |
| Charges, spread, slippage and planned loss | Configurable estimates; not verified broker charges or guaranteed worst-case execution losses. |
| Risk limits, journal, private access and persistence | Working application controls and durable SQLite state, covered by tests. These do not establish strategy profitability. |
| 23:00 IST assessment and immediate in-app alerts | Implemented scheduler/rule evaluation; content depends on the selected data mode and a running monitor. Replay assessments are synthetic; continuous live-market operation was not verified. |
| IST wall clock / worker heartbeat | System time / process-health information, not financial market data. |

**No displayed market claim in this verified setup is backed by a confirmed real live market feed.** Live operation still requires authorized SmartAPI credentials, a reviewed MCX specification attestation matching the broker master, configured global providers, and the monitoring worker. Live candles remain sampled quote bars rather than a complete exchange tick stream. Paper trading remains the only execution mode.
