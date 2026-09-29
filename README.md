# MarketPilot

Private CRUDEOILM futures decision desk: explainable BUY / SELL / WAIT / EXIT alerts, risk controls, paper trading, net P&L, a persistent journal and scheduled IST assessments. **No live order execution.**

## Start

Requires Node 22.13 or newer.

```sh
npm ci
cp .env.example .env.local
npm run dev
# In another terminal:
npm run marketpilot:worker
```

Replay works without broker credentials. Its prices and global context are explicitly synthetic DEMO data. Live market data requires authorized SmartAPI credentials and reviewed MCX contract specifications; missing or stale data blocks entries.

Read [the setup and risk guide](MARKETPILOT.md) for configuration, private access, data-source limitations, and verification.

The [forward-session guide](FORWARD_SESSION.md) covers the LIVE observation audit, rejected quotes, feed health, date-specific IST reports and exact production session steps. **Real-account smoke test: NOT VERIFIED.** Synthetic replay results do not establish a strategy edge.

```sh
npm test
npm run test:e2e
npm run lint
npm run build
```

Strategies are transparent rules, not predictions. Stops, risk limits and profit protection cannot guarantee a profitable trade or day.
