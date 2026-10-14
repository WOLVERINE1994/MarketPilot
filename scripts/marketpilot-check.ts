import { mkdir, writeFile } from "node:fs/promises";
import { currentContract, quote } from "../src/marketpilot/adapters/smartapi";
import { globalContext } from "../src/marketpilot/adapters/context";
import { missingLiveSettings, temporalStatus } from "../src/marketpilot/feed";
import { marketSession } from "../src/marketpilot/session";
import type { Contract } from "../src/marketpilot/types";
import { sessionTokenStatus } from "../src/marketpilot/credentials";
import { optionContracts, optionQuotes } from "../src/marketpilot/adapters/options";
import { selectOptionPair, expiryBuffer } from "../src/marketpilot/option-contracts";

// Read-only market-data requests. No position, risk limit or trading state changes.
async function main() {
  const startedAt = new Date().toISOString();
  let contract: Contract | null = null;
  let contractStatus = "UNVERIFIED";
  try { contract = await currentContract(startedAt); contractStatus = "PUBLIC_MASTER_AND_LOCAL_REVIEW_VERIFIED"; }
  catch { /* Raw broker, filesystem and transport messages remain private. */ }
  const missing = missingLiveSettings();
  const missingBroker = missing.filter(key => key.startsWith("ANGEL_") || key === "MARKETPILOT_SPECS_FILE");
  let quoteStatus = "NOT_ATTEMPTED", exchangeTime: string | null = null;
  let price: number | null = null;
  const tokenStatus = sessionTokenStatus(process.env.ANGEL_ACCESS_TOKEN);
  if (contract && !missingBroker.length && tokenStatus === "PRESENT_UNVERIFIED") {
    try {
      const result = await quote(contract);
      exchangeTime = result.time;
      quoteStatus = temporalStatus(result.time, new Date().toISOString(), null);
      if (quoteStatus === "OK") price = result.price;
    } catch { quoteStatus = "UNAVAILABLE"; }
  }
  const context = await globalContext(new Date().toISOString());
  const session = await marketSession(new Date().toISOString());
  let options: unknown = { status: "UNAVAILABLE", explanation: "Mini option specifications and fresh underlying required; missing inputs keep CE and PE at WAIT" };
  if (contract && price !== null && process.env.MARKETPILOT_OPTION_SPECS_FILE?.trim()) {
    try {
      const checked = new Date().toISOString();
      const selected = selectOptionPair((await optionContracts(contract, checked)).filter(c => !expiryBuffer(c, checked)), price);
      const premiums = await optionQuotes(selected);
      options = { status: premiums.every(q => temporalStatus(q.time, q.receivedAt, null) === "OK") ? "FRESH_QUOTES" : "STALE_OR_INVALID",
        premiums, explanation: "Live quotes do not qualify a trade: each option still requires premium-history warmup, underlying/context confirmation, liquidity and shared risk checks" };
    } catch { /* Never expose provider errors or credential values. */ }
  }
  const report = {
    checkedAt: new Date().toISOString(), paperOnly: true,
    missingSettings: missing,
    sessionTokenStatus: tokenStatus,
    contractStatus, contract, options,
    quote: { status: quoteStatus, exchangeTime, acceptedPrice: price,
      explanation: tokenStatus === "MALFORMED" ? "Saved access token is not a valid JWT format; replace it locally with jwtToken from a successful SmartAPI login"
        : tokenStatus === "EXPIRED" ? "Session token expiry has passed; renew through the authorized broker login"
        : quoteStatus === "NOT_ATTEMPTED" ? "Missing broker credentials or verified contract; an API key alone cannot authenticate" : "Only OK is a verified fresh market observation; holidays can return stale quotes" },
    session,
    context: context.map(item => ({ name: item.name, status: item.status, source: item.source, eventRiskBlock: item.block })),
    readyForEntryEvaluation: quoteStatus === "OK" && session.entriesAllowed && context.every(item => item.status === "LIVE" && !item.block),
    explanation: "Setup checks do not generate signals or place trades. A ready setup still requires candle warmup, signal evidence and risk eligibility. No trading edge is asserted.",
  };
  await mkdir(".marketpilot-setup", { recursive: true });
  await writeFile(".marketpilot-setup/status.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(() => { console.error("Setup check could not complete; no credentials or raw errors are displayed."); process.exitCode = 1; });
