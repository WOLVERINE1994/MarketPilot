"use client";
import { ChevronRight, LockKeyhole, TrendingDown, TrendingUp } from "lucide-react";
import type { DashboardState } from "./engine";
import type { OptionType } from "./option-types";
import { displayTime } from "./time";
const money = (value: number) => `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function OptionsPanel({ data, now, busy, send }: { data: DashboardState; now: number | null; busy: boolean; send: (command: string) => Promise<void> }) {
  const current = now ?? Date.parse(data.clock);
  const held = data.position?.contract.instrument === "OPTION" ? data.position : null;
  return <section className="mp-panel mp-options" aria-labelledby="options-title" id="options">
    <div className="mp-panel-heading"><div><h2 id="options-title">Crude Oil Mini · CE / PE</h2><p>Buy CE for a confirmed rise; buy PE for a confirmed fall. Paper trading only.</p></div><span className="mp-tag">BUY OPTIONS ONLY</span></div>
    <div className="mp-option-grid">{(["CE", "PE"] as OptionType[]).map(type => {
      const suggestion = data.optionDesk?.suggestions.find(item => item.type === type);
      const position = held?.contract.optionType === type ? held : null;
      const track = position ? data.optionDesk?.tracks[position.contract.token] : null;
      const quote = position ? track?.quote ?? position.optionEntryQuote : suggestion?.quote;
      const contract = position?.contract ?? suggestion?.contract;
      const age = quote ? (current - Date.parse(quote.time)) / 1000 : null;
      const tradeAge = quote ? (current - Date.parse(quote.tradeTime)) / 1000 : null;
      const valid = !!quote && age !== null && age >= 0 && age <= 30 && tradeAge !== null && tradeAge >= 0 && tradeAge <= 120 &&
        current - Date.parse(quote.receivedAt) >= 0 && current - Date.parse(quote.receivedAt) <= 30000 && (position ? track?.status : suggestion?.status) === "OK";
      const underlyingAge = (current - Date.parse(data.feedTime ?? "")) / 1000;
      const canEnter = valid && suggestion?.action === "BUY" && !data.position && underlyingAge >= 0 && underlyingAge <= 30 && data.feedHealth?.connection === "CONNECTED_AND_VERIFIED";
      const action = position ? !valid || underlyingAge < 0 || underlyingAge > 30 ? "EXIT" : data.decision?.action ?? "HOLD" : canEnter ? `BUY ${type}` : "WAIT";
      const reasons = position ? data.decision?.reasons ?? [] : suggestion?.reasons ?? [data.optionDesk?.setupReason ?? "Awaiting verified Mini option contracts and premiums"];
      return <article className="mp-option-card" key={type} aria-label={`${type} suggestion`}>
        <div className="mp-option-heading"><h3>{type === "CE" ? <TrendingUp size={18}/> : <TrendingDown size={18}/>} {type} <span>{type === "CE" ? "Call · upward thesis" : "Put · downward thesis"}</span></h3><strong className={canEnter || action === "HOLD" ? "mp-green" : "mp-amber"}>{action}</strong></div>
        <p className="mp-option-symbol">{contract?.symbol ?? "Mini option contract unverified"}</p>
        <div className="mp-option-meta"><span>Strike <b>{contract?.strike ?? "—"}</b></span><span>Expiry <b>{contract?.expiry ?? "—"}</b></span><span>Lot <b>{contract?.lotSize ?? "—"}</b></span></div>
        <div className="mp-option-premium"><span>Premium <strong>{quote ? money(quote.ltp) : "—"}</strong></span><span>{valid ? "Live premium" : quote ? "Last accepted premium · stale/unavailable" : "Premium unavailable"}<small>{quote ? `${displayTime(quote.time)} IST` : "No simulated prices"}</small></span></div>
        <div className="mp-option-meta"><span>Bid <b>{quote ? money(quote.bid) : "—"}</b></span><span>Ask <b>{quote ? money(quote.ask) : "—"}</b></span><span>Spread <b>{quote ? money(quote.ask - quote.bid) : "—"}</b></span></div>
        <div className="mp-plan"><div><span>Premium entry / stop</span><b>{position ? `${money(position.entry)} / ${money(position.stop)}` : suggestion?.entry && suggestion.stop ? `${money(suggestion.entry)} / ${money(suggestion.stop)}` : "—"}</b></div><div><span>Premium target · net 2R estimate</span><b>{position ? money(position.target) : suggestion?.target ? money(suggestion.target) : "—"}</b></div><div><span>Planned loss incl. costs</span><b>{money(position?.maxRisk ?? suggestion?.maxRisk ?? 0)}</b></div><div><span>Premium paid + entry charge</span><b>{money(position?.premiumAtRisk ?? suggestion?.premiumAtRisk ?? 0)}</b></div><div><span>Estimated round-trip charges</span><b>{money(position ? data.decision?.estimatedCosts ?? position.entryCosts : suggestion?.estimatedCosts ?? 0)}</b></div></div>
        <ul className="mp-option-reasons">{!valid && quote && <li>Fresh executable option data required; entries blocked.</li>}{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
        <button className="mp-primary" disabled={busy || !canEnter} onClick={() => void send(type === "CE" ? "enter-ce" : "enter-pe")}>{position ? `Paper ${type} position open` : canEnter ? `Paper BUY ${type} · 1 lot` : `WAIT · ${type}`}{canEnter ? <ChevronRight size={15}/> : <LockKeyhole size={13}/>}</button>
      </article>;
    })}</div>
    <p className="mp-option-note">Premium stops and targets use option prices. Direction alone cannot predict premiums: time decay and volatility matter. Gaps can exceed planned loss; the premium paid can be lost. One shared position and daily risk budget. No option selling or holding through expiry.</p>
  </section>;
}
