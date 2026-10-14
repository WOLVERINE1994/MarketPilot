# MarketPilot

A private, single-user CRUDEOILM futures and long CE/PE options decision desk. **Paper trading only.** There is no broker order client, order endpoint, option selling, regular Crude Oil support, or autonomous LLM trading. Rules are untested trading hypotheses, not predictions or promises of profit.

Capital protection takes precedence over activity or income. WAIT is appropriate for weak evidence; HOLD means an existing paper position retains its original thesis and stop. BUY/LONG and SELL/SHORT are eligible one-lot paper setups; EXIT protects an existing position. The hypothetical â‚¹2â€“3 lakh monthly aspiration is not an input to sizing, rules, targets or risk limits. Losses remain visible and persisted; averaging down and recovery sizing are not supported.

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

The worker listens to the SmartAPI WebSocket and coalesces tick bursts into decision updates at up to 10 per second. The dashboard receives committed changes through a Server-Sent Events stream; a five-second refresh remains as recovery if the stream or worker stops. The worker also handles protective exits and the scheduled assessment when the browser is closed. Keep both processes running. Dashboard reads do not duplicate ingestion while the worker heartbeat is current. Paper commands always require the exclusive lease and their existing fresh-data/risk checks. Closing the worker stops unattended monitoring; the dashboard shows its heartbeat. This is a persistent Node deployment, **not an ephemeral/serverless deployment**. Run under a process supervisor for continuous use. Missing scheduled checks are caught up once monitoring resumes on the same IST day and are stamped with their actual generation time; there is no invented backdated assessment.

## First usable flow

For the auditable LIVE milestone, follow [FORWARD_SESSION.md](FORWARD_SESSION.md). The worker now records attempted LIVE monitoring even without credentials. Each quote passes strict ingestion checks before touching candles or simulated fills, and the LIVE health panel separates configuration from verified connectivity. Date-specific LIVE reports include the complete observation and forward paper ledger. The real-account smoke test remains **NOT VERIFIED**.

1. Open the app. The dashboard always uses **LIVE DATA** for CRUDEOILM; there is no mode switch.
2. Check connection health, contract/expiry and missing global feeds. Missing or stale required data keeps entries blocked and the recommendation at WAIT.
3. Read the decision evidence. Eligible BUY/LONG or SELL/SHORT setups can be recorded as one-lot paper trades; no broker orders are placed.
4. Monitor the stop, target, estimated costs and paper P&L. The worker handles protective paper exits when valid fresh data permits.
5. Inspect the LIVE journal, paper history, performance and forward-session report. The 23:00 IST assessment does not force a trade.

Synthetic replay remains an internal API/test fixture for validation. Its records cannot appear in the dashboard or LIVE reports; the worker polls only LIVE.

SQLite state, trade history, journal, day locks and decision snapshots survive restarts under `.marketpilot/marketpilot.sqlite`. LIVE decisions with an unchanged action and reasons are sampled at most once per minute; action/reason changes are recorded immediately. Every observation, paper-accounting event and journal event remains persisted. The latest valuation checkpoint is retained per IST day. LIVE and REPLAY have separate state, balances, positions, limits and decisions. Back up this directory with the processes stopped. Set `MARKETPILOT_DATA_DIR` for an alternative durable directory or a fresh independent replay workspace. The UI shows recent events; all events remain persisted. The dashboard decision download contains the latest 500 LIVE snapshots.

## Private access

Development binds to **127.0.0.1**. For production, set a strong `MARKETPILOT_PASSWORD` in `.env.local`; browser Basic authentication uses username `pilot`. Production refuses access without a password. Use HTTPS and a private network/reverse proxy for remote access. Never publish the database or expose a development server. Authentication protects both the dashboard and APIs. Same-origin checks protect browser mutations. API secrets are used only on the server and are never written to the journal or sent to the browser.

## MarketPilot chat

The dashboard assistant uses the OpenAI Responses API to explain the latest server-side LIVE snapshot, including up to 50 observed one-minute candles, current decision reasons, CE/PE suggestions, context freshness, and risk gates. It has no trading tools and cannot place orders. Its instructions require it to preserve WAIT/HOLD/EXIT and use only supplied prices and plans. Questions and this sanitized market snapshot are sent to OpenAI; broker credentials are never included. Chat is unavailable until `OPENAI_API_KEY` is configured in local `.env.local`. Optionally set `MARKETPILOT_AI_MODEL`; the default is `gpt-6-astra`.

## Authorized Angel One market data

The LIVE setup checklist lists missing environment-variable **names only**. An API key alone is insufficient: SmartAPI also requires an authorized session JWT, feed token and client identity. Settings being present does not prove authentication or connectivity. Restart both web and worker processes after editing `.env.local`.

Follow the official [SmartAPI documentation](https://smartapi.angelone.in/docs). Configure only credentials and data rights that you are authorized to use:

- `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_ACCESS_TOKEN`, `ANGEL_FEED_TOKEN`: API key and authorized SmartAPI session identity/tokens. Obtain/renew the session by running `npm.cmd run marketpilot:login`. The browser does not collect login credentials. The local terminal helper prompts for client code, PIN/password and the current authenticator code with hidden input; it saves the client code and broker-returned JWT/feed token locally without printing them. TOTP seeds are never requested.

The dashboard opens on a candle-focused view with the decision and any open-position exit control alongside it. Market health, context, options, chat, reports, journal and performance remain available in the secondary views; switching screens does not disable their underlying risk checks. The worker uses SmartAPI WebSocket V2 LTP mode for the underlying Mini futures and Snap Quote mode for the selected CE/PE contracts, including their best bid/ask, trade time, volume and open interest. Fresh option ticks are consumed as they arrive; REST remains the recovery path when the stream is unavailable or incomplete, with a 2.5-second timeout so unavailable option data does not stall underlying monitoring. Missing or stale option premiums remain blocked. The dashboard refreshes once per second. Streaming reduces avoidable polling delay; it does not predict price changes or guarantee earlier fills.
- `ANGEL_CLIENT_LOCAL_IP`, `ANGEL_CLIENT_PUBLIC_IP`, `ANGEL_MAC_ADDRESS`: your actual SmartAPI client identity headers.
- `MARKETPILOT_SPECS_FILE`: path to a locally reviewed monetary-specification file described below.

The adapter reads Angel One's [instrument master](https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json), filters exactly `MCX / CRUDEOILM / FUTCOM`, and selects the earliest future expiry strictly after the current IST day. It conservatively rolls before expiry-day entries. Instrument-master refreshes time out after three seconds and failed refreshes back off for one minute; when that source is unavailable, current option contracts remain unavailable and the underlying can only use its existing same-day verified-contract recovery path. It requests only the resolved token from SmartAPI's **FULL market quote endpoint**, validates exchange/token/symbol/price/time, and treats missing, stale (>30 seconds), future-dated or out-of-order data as unsafe. Session expiry and network failure block entries. Open positions get EXIT alerts on data loss, but no fill is invented until a fresh observation arrives.

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

## Mini CE / PE paper suggestions

The futures chart remains the direction reference. Separate **CE** and **PE** cards evaluate buying a call for a confirmed rise or buying a put for a confirmed fall. An option's own premium must confirm the move. These are unvalidated rule hypotheses; direction alone does not determine premium because time decay and volatility also affect options. Option selling is not implemented. All three required global feeds and existing session/data/risk guards remain enabled.

Set `MARKETPILOT_OPTION_SPECS_FILE` to a reviewed local JSON array, such as the ignored `marketpilot-option-specs.local.json`. Each review contains `underlyingSymbol`, `underlyingExpiry`, `optionExpiry`, `lotSize`, `multiplier`, `tickSize`, `strikeStep`, `source`, `verifiedAt`, and `validUntil`. Dates are `YYYY-MM-DD`; review times are ISO timestamps with timezone; `source` must be the exact applicable HTTPS MCX specification/circular. Review the [MCX Mini option specification](https://www.mcxindia.com/docs/default-source/products/contract-specification/crudeoil-mini-options/crude-oil-mini-(10-barrels)-options-march-2026-contract-onwards.pdf) and the applicable expiry calendar. Its expiry is two business days before the underlying futures expiry; holidays must be considered during review. The broker master must match the exact Mini `MCX / CRUDEOILM / OPTFUT` identity, option type, expiry, scaled strike (`strike / 100`), lot and tick (`tick_size / 100`). No specification values are silently inferred in the resolver. Review withdrawal, expiry, ambiguity or disagreement blocks entries and requests a protective exit of an existing paper option.

Selection uses the nearest verified strike with both CE and PE quotes, within 2% of the underlying. A selected pair is retained within a 1% band to collect a continuous premium history; changing strike resets that contract's warmup. Each option needs `slow + 3` observed one-minute premium candles, increasing premium momentum, no recent history gap, a fresh advancing exchange quote (30 seconds), a recent trade (120 seconds), executable bid and ask quantities of at least one lot, volume and open interest of at least twenty lots, and a spread no wider than 2% of ask. These thresholds are conservative implementation choices, not an established edge. A held exact contract remains monitored independently of a changed candidate strike.

Only one paper position may be open across futures, CE and PE. Trade count, daily loss limits, profit protection and per-trade planned risk are shared; switching instruments cannot reset them. Entry is observed **ask plus slippage**, exit/mark is observed **bid minus slippage**, adversely tick-rounded and floored at zero. The observed spread is not charged twice. A fixed premium stop uses the greater of 1.6 premium ATR, 10% premium, and four ticks; the target covers spread, slippage and estimated charges for a net 2R estimate. The UI separately shows the entire premium paid plus entry charge, which can exceed the planned stop loss. Premiums can be lost and stops can gap. Charges retain the existing configurable blended estimate and must be checked against actual option contract notes; they are not an exchange tariff or affordability check.

New entries are blocked and held options request EXIT within 72 hours of the option expiry date, and as the reviewed trading session closes. No exercise/devolvement or expiry settlement is fabricated. A data-failure EXIT remains latched until a new valid quote with a sufficient exact-contract bid permits a paper exit. Failed or duplicate quotes do not create candles or fills. The durable option observation stream, premium entry evidence, positions, costs and trades survive restarts and are included in the LIVE forward-session report. Existing futures records remain intact; the new SQLite table is created automatically.

Restart both the web process and worker after configuring the local review. `npm.cmd run marketpilot:check` includes a read-only CE/PE quote check; fresh quotes alone do not qualify entry.

## Global context adapters

WTI and Brent global spot context can use Twelve Data by setting `TWELVE_DATA_API_KEY` in `.env.local`. MarketPilot requests the timestamped WTI/USD and XBR/USD quotes, caches them for one minute, and rejects quotes older than 15 minutes. Twelve Data lists commodity market data on its Grow plan; verify your dashboard grants both symbols before relying on it. Alternatively, `OILPRICEAPI_KEY` requests both benchmarks together and caches the result for five minutes while using the provider's Core Commodity trial. The shown 10,000-request monthly allowance supports this interval, but check the account before the 7-day trial ends; the free-plan limit may be lower. These are global spot prices, not MCX or NYMEX futures quotes.

Oil news uses the public OilPrice.com RSS feed by default, checks up to 20 oil-related headlines published within 24 hours, and links the newest article in the dashboard. A transparent title keyword screen flags possible high-impact events and blocks entries when matched; headlines never set trade direction. This is a limited heuristic, not a full semantic or human event-risk review, so do not treat an unflagged feed as proof that no risk exists. If the public feed fails, returns no recent relevant headlines, or is stale, news is UNAVAILABLE and entries remain blocked. You can override it with a licensed `OIL_NEWS_URL` returning the schema below (and optionally `CONTEXT_API_KEY` for Bearer authentication):

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
- Original stop distance is `max(1.6 Ã— ATR, 4 Ã— tick size)`, rounded to ticks. Target is twice this price distance. Stop/target do not trail or widen. Entry thesis fails on opposing trend or meaningful opposing momentum.
- Size is always **one lot**; only one position per mode. No averaging down, recovery sizing, pyramiding or reversing in the same minute. A position's original cost/risk settings are retained.
- Planned loss includes stop distance, both execution frictions, and estimated round-trip charges. Both per-trade and remaining daily loss budgets must permit it. Planned loss is not a guaranteed maximum realized loss.
- Net accounting uses actual simulated entry/exit fills with half-spread plus slippage on each side, rounded adversely to the verified price tick. Charges per side are fixed brokerage plus `notional Ã— statutoryBps / 10000`. The statutory rate is a **configurable blended estimate**, not a maintained legal tariff; verify it against your contract note. Brokerage and statutory estimates are separate from execution friction and are not double-counted.
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

`tests/marketpilot.test.ts` checks contract identity/rollover/spec mismatches, long/short costs, gap stops, stale data, WAIT/BUY/SELL/EXIT, locks, replay visibility, IST midnight/23:00, broker/context adapters, persistence, writer exclusion and private access. The Playwright suite covers the dashboard â†’ API â†’ SQLite â†’ paper entry/exit â†’ net result â†’ journal â†’ assessment flow, mode isolation, and mobile layout. It starts a separate `.marketpilot-e2e/run-*` database (stop an existing dev server on port 3100 first).

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
