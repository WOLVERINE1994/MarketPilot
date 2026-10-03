# Local LIVE setup — 2 October 2026

Paper trading remains the only execution mode. LIVE means the requested acquisition channel, not a verified connection. No accepted live quote or trading edge has been established.

The public Angel One instrument master and [official MCX Mini specification](https://www.mcxindia.com/docs/default-source/products/contract-specification/crude-oil-mini/crude-oil-mini-january-2026-contract-onwardsdbdf4c09-a735-4396-a2f5-091dad12f14f.pdf) agree on the nearest contract: `CRUDEOILM19OCT26FUT`, token `569901`, expiry 19 October 2026, ten barrels per lot and a ₹1 quoted tick. The quotation is rupees per barrel, so one ₹1 quoted move changes one lot's gross P&L by ₹10. Local review files also cover the listed November and December 2026 contracts. Later contracts require their applicable specifications to be reviewed separately.

`marketpilot-specs.local.json` and `marketpilot-sessions.local.json` are local, Git-ignored attestations configured in `.env.local`. Review validity ends at **00:00 IST on 10 October 2026**; entries block after expiration. The calendar explicitly covers 2–9 October: the [MCX holiday calendar](https://www.mcxindia.com/market-operations/trading-surveillance/trading-holidays) closes both sessions on 2 October; weekends 3–4 October are closed. The reviewed 5–9 October windows are 09:00–23:30 IST, using MCX's contract weekday rules and MCX/TRD/068/2026 ([MCX-authored circular hosted by SMIFS](https://www.smifs.com/files/downloads/639071986796777565_Revision%20in%20Trading%20Hours%20w.e.f.%20March%2009%2C%202026.pdf)). [MCX/TRD/550/2026](https://www.mcxindia.com/docs/default-source/circulars/english/2026/september/circular-550--2026.pdf) revises non-agricultural closing time to 23:55 from 2 November; no November sessions are prefilled here. Changes or special sessions require a new review.

The formerly empty client local IP, public IP and MAC fields were populated from the current machine/network. Verify them again after changing networks or broker IP requirements. Existing populated fields and the API key were preserved. No credentials were printed or written to the diagnostic report.

The initial saved token failed the JWT structure check. The local login helper subsequently saved a well-formed session JWT without printing credentials. The 2 October post-restart check returned a matching-contract **STALE** broker quote; no price was accepted as a fresh live observation. Renew expired sessions locally with `npm.cmd run marketpilot:login`, then restart the app and worker. Do not paste credentials into chat. Local format/expiry checks do not verify the token signature or broker authorization; a fresh accepted broker response remains necessary.

WTI, Brent and oil-news providers are intentionally unconfigured at the user's request. LIVE `requireContext` was persisted as **true**. Each missing feed displays UNAVAILABLE and blocks new entries with WAIT, even if the broker connection becomes healthy. The application does not substitute replay data into LIVE.

Run a read-only setup check after editing credentials:

```powershell
npm.cmd run marketpilot:check
```

This checks the public instrument master, contract review, token format/expiry, a quote when credentials are eligible, the session and configured context providers. It writes a sanitized report to `.marketpilot-setup/status.json`. It does not place orders, create positions or change risk settings.

Restart web and worker processes after `.env.local` changes. Use the existing instructions in [MARKETPILOT.md](MARKETPILOT.md) for startup. Production additionally requires a strong `MARKETPILOT_PASSWORD`; it remains unset. A closed holiday, malformed token or unavailable provider is not a passed real-account smoke test.

## Local SmartAPI login helper

Run `npm.cmd run marketpilot:login` from the MarketPilot directory in an interactive terminal. Enter your Angel One client code, PIN/password and the current six-digit code displayed by your authenticator when prompted. All input is hidden. The helper uses the API key and client identity from `.env.local`, calls the official loginByPassword endpoint once, validates the returned JWT format/expiry, and atomically saves it as `ANGEL_ACCESS_TOKEN`. It does not print the JWT, save the PIN/password or OTP, save refresh/feed tokens, or request your authenticator seed. Rejected logins leave the saved token unchanged. Ctrl+C cancels a prompt. Restart existing web/worker processes afterward and run `npm.cmd run marketpilot:check`. Missing global context still blocks entries.
