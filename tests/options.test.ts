import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { resolveOptions, selectOptionPair, expiryBuffer } from "../src/marketpilot/option-contracts";
import { parseOptionQuotes } from "../src/marketpilot/adapters/options";
import * as optionAdapter from "../src/marketpilot/adapters/options";
import * as broker from "../src/marketpilot/adapters/smartapi";
import * as context from "../src/marketpilot/adapters/context";
import * as session from "../src/marketpilot/session";
import { initial, enterOption, evaluate, mark, operate } from "../src/marketpilot/engine";
import { suggestOptions, emptyOptions, hasNewOptionStreamQuote, optionFillReady, pollOptions } from "../src/marketpilot/options";
import { closePosition } from "../src/marketpilot/paper";
import { db, readState, saveState } from "../src/marketpilot/storage";
import { smartMarketStream } from "../src/marketpilot/adapters/smart-stream";
import { forwardSessionReport } from "../src/marketpilot/report";
import type { Instrument } from "../src/marketpilot/contracts";
import type { Contract, State, ContextItem } from "../src/marketpilot/types";
import type { OptionContract, OptionQuote, OptionSpecification } from "../src/marketpilot/option-types";
const now = "2026-10-05T17:00:00.000Z";
const underlying: Contract = { symbol: "CRUDEOILM19OCT26FUT", token: "569901", expiry: "2026-10-19", lotSize: 10, multiplier: 10, tickSize: 1, source: "https://www.mcxindia.com/test-fixture", verified: true };
const spec: OptionSpecification = { underlyingSymbol: underlying.symbol, underlyingExpiry: underlying.expiry, optionExpiry: "2026-10-15", lotSize: 10, multiplier: 10, tickSize: 0.05, strikeStep: 50, source: "https://www.mcxindia.com/test-fixture", verifiedAt: "2026-10-01T00:00:00Z", validUntil: "2026-10-09T18:30:00Z" };
const rows: Instrument[] = ["CE", "PE"].flatMap((type, index) => [8500, 8550, 8600].map((strike, n) => ({ name: "CRUDEOILM", symbol: `CRUDEOILM15OCT26${strike}${type}`, token: String(580000 + index * 10 + n), expiry: "15OCT2026", lotsize: "10", tick_size: "5", instrumenttype: "OPTFUT", exch_seg: "MCX", strike: String(strike * 100) })));
const contracts = () => selectOptionPair(resolveOptions(rows, [spec], underlying, now), 8555);
function quote(contract: OptionContract, time = now): OptionQuote { return { id: crypto.randomUUID(), contract, time, tradeTime: time, receivedAt: time, ltp: 209.5, bid: 209.25, ask: 209.75, bidQuantity: 100, askQuantity: 100, volume: 1000, openInterest: 1000 }; }
function seed(down = false): State {
  const s = initial("LIVE"); s.clock = now; s.contract = underlying; s.feed = "CONNECTED"; s.feedTime = now;
  s.candles = Array.from({length:32}, (_, i) => { const price = down ? 8600 - i * 2 : 8500 + i * 2; return {time:new Date(Date.parse(now)-(31-i)*60000).toISOString(),open:price,high:price+1,low:price-1,close:price,volume:0}; });
  s.lastQuote = {price:s.candles.at(-1)!.close,time:now}; s.latestObservation = { id:crypto.randomUUID(),startedAt:now,receivedAt:now,exchangeTime:now,contract:underlying,price:s.lastQuote.price,status:"OK",reason:"TEST ONLY",source:"worker",gapSeconds:0 };
  s.session = {day:"2026-10-05",status:"OPEN",entriesAllowed:true,reason:"TEST ONLY",opensAt:"2026-10-05T09:00:00+05:30",closesAt:"2026-10-05T23:30:00+05:30",source:"https://www.mcxindia.com/test-fixture"};
  s.context = ["WTI","Brent","Oil news"].map(name=>({name,status:"LIVE",time:now,source:"TEST ONLY",bias:"NEUTRAL",block:false}));
  s.days = [{day:"2026-10-05",net:0,peak:0,trades:0,locked:false}]; s.optionDesk = emptyOptions(now); s.optionDesk.setupReason = "";
  for (const c of contracts()) { s.optionDesk.selected[c.optionType] = c.token; s.optionDesk.tracks[c.token] = {contract:c,quote:quote(c),status:"OK",reason:"TEST ONLY",candles:Array.from({length:32},(_,i)=>({time:new Date(Date.parse(now)-(31-i)*60000).toISOString(),open:200+i*0.3,high:200.5+i*0.3,low:199.5+i*0.3,close:200+i*0.3,volume:0}))}; }
  return s;
}
function tick(s: State, bid: number) { s.clock = new Date(Date.parse(s.clock)+5000).toISOString();s.feedTime=s.clock;s.latestObservation={...s.latestObservation!,id:crypto.randomUUID(),receivedAt:s.clock,exchangeTime:s.clock};s.candles.at(-1)!.time=s.clock;
  const c=s.position!.contract;const q=quote(c as OptionContract,s.clock);q.bid=bid;q.ask=bid+0.5;q.ltp=bid+0.25;s.optionDesk!.tracks[c.token].quote=q; }
beforeAll(()=>{process.env.MARKETPILOT_DATA_DIR=`.marketpilot-tests-options-${crypto.randomUUID()}`;db();});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(now);for(const table of ["states","decisions","leases","live_observations","option_observations","forward_events","forward_entries","forward_trades","forward_checkpoints"])db().exec(`DELETE FROM ${table}`);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();});

describe("Mini option identity and live premiums",()=>{
  it("resolves exact CE/PE with scaled strike/tick and a reviewed underlying mapping",()=>{const pair=contracts();expect(pair.map(c=>c.optionType)).toEqual(["CE","PE"]);expect(pair.every(c=>c.strike===8550&&c.tickSize===0.05&&c.multiplier===10&&c.underlyingSymbol===underlying.symbol)).toBe(true);});
  it.each([{...spec,validUntil:now},{...spec,multiplier:100},{...spec,source:"https://example.com/spec"},{...spec,underlyingSymbol:"CRUDEOIL19OCT26FUT"}])("rejects unsafe review %#",review=>{expect(()=>resolveOptions(rows,[review],underlying,now)).toThrow();});
  it("rejects ambiguous identities and strike disagreement",()=>{expect(()=>resolveOptions([...rows,{...rows[0],token:"999999"}],[spec],underlying,now)).toThrow();expect(()=>resolveOptions([{...rows[0],strike:"860000"}],[spec],underlying,now)).toThrow();});
  it("excludes regular Crude Oil and equities and requires both sides near the underlying",()=>{expect(()=>resolveOptions(rows.map(r=>({...r,name:"CRUDEOIL"})),[spec],underlying,now)).toThrow();expect(selectOptionPair(contracts().filter(c=>c.optionType==="CE"),8550)).toEqual([]);expect(selectOptionPair(contracts(),10000)).toEqual([]);});
  it("applies the 72-hour expiry buffer",()=>{expect(expiryBuffer(contracts()[0],"2026-10-12T00:00:00+05:30")).toBe(true);expect(expiryBuffer(contracts()[0],now)).toBe(false);});
  const body=()=>({status:true,data:{unfetched:[],fetched:contracts().map(c=>({exchange:"MCX",symbolToken:c.token,tradingSymbol:c.symbol,ltp:209.5,exchFeedTime:"05-Oct-2026 22:30:00",exchTradeTime:"05-Oct-2026 22:29:59",tradeVolume:1000,opnInterest:1000,depth:{buy:[{price:209.25,quantity:100}],sell:[{price:209.75,quantity:100}]}}))}});
  it("parses exact live premiums, trade time, depth, volume and OI",()=>{expect(parseOptionQuotes(body(),contracts(),now)).toHaveLength(2);});
  it("uses fresh Snap Quote stream packets instead of making an option REST request",async()=>{
    const pair=contracts();
    vi.spyOn(smartMarketStream,"latestOption").mockImplementation(token=>({
      token,price:209.5,time:now,tradeTime:now,receivedAt:now,bid:209.25,ask:209.75,
      bidQuantity:100,askQuantity:100,volume:1000,openInterest:1000,
    }));
    const rest=vi.spyOn(broker,"marketQuotes");
    const quotes=await optionAdapter.optionQuotes(pair);
    expect(rest).not.toHaveBeenCalled();
    expect(quotes).toHaveLength(2);
    expect(quotes[0]).toMatchObject({time:now,tradeTime:now,ltp:209.5,bid:209.25,ask:209.75,volume:1000,openInterest:1000});
  });
  it("keeps REST as recovery when the Snap Quote stream is incomplete",async()=>{
    const pair=contracts();
    vi.spyOn(smartMarketStream,"latestOption").mockReturnValue(null);
    const rest=vi.spyOn(broker,"marketQuotes").mockResolvedValue(body());
    await expect(optionAdapter.optionQuotes(pair)).resolves.toHaveLength(2);
    expect(rest).toHaveBeenCalledWith(pair.map(c=>c.token),2500);
  });
  it("rejects mismatched contracts, duplicates, missing depth, crossed books and partial batches",()=>{
    const mismatch=body();mismatch.data.fetched[0].tradingSymbol="CRUDEOIL15OCT268550CE";expect(()=>parseOptionQuotes(mismatch,contracts(),now)).toThrow();
    const duplicate=body();duplicate.data.fetched[1]=duplicate.data.fetched[0];expect(()=>parseOptionQuotes(duplicate,contracts(),now)).toThrow();
    const noBid=body();noBid.data.fetched[0].depth.buy=[];expect(()=>parseOptionQuotes(noBid,contracts(),now)).toThrow();
    const crossed=body();crossed.data.fetched[0].depth.buy[0].price=220;expect(()=>parseOptionQuotes(crossed,contracts(),now)).toThrow();
    const partial=body();partial.data.fetched.pop();expect(()=>parseOptionQuotes(partial,contracts(),now)).toThrow();
  });
});
describe("CE/PE suggestions and shared paper protection",()=>{
  it.each([false,true])("qualifies only the direction-confirmed option (down=%s)",down=>{const s=seed(down),items=suggestOptions(s,0);expect(items.find(x=>x.type===(down?"PE":"CE"))?.action).toBe("BUY");expect(items.find(x=>x.type===(down?"CE":"PE"))?.action).toBe("WAIT");const plan=items.find(x=>x.action==="BUY")!;expect(plan.entry).toBe(210.75);expect(plan.stop!<plan.entry!).toBe(true);expect(plan.premiumAtRisk>plan.maxRisk).toBe(true);});
  it.each(["context","stale","future","depth","spread","risk","expiry","history","premium","duplicate","lockout"])("blocks %s",reason=>{
    const s=seed(),track=s.optionDesk!.tracks[s.optionDesk!.selected.CE!];
    if(reason==="context")s.context[0].status="UNAVAILABLE";
    if(reason==="stale")track.quote!.tradeTime="2026-10-05T16:00:00Z";
    if(reason==="future")track.quote!.time="2026-10-05T17:00:01Z";
    if(reason==="depth")track.quote!.askQuantity=1;
    if(reason==="spread")track.quote!.ask=230;
    if(reason==="risk")s.settings.riskPerTrade=1;
    if(reason==="expiry")track.contract.expiry="2026-10-07";
    if(reason==="history")track.candles=[];
    if(reason==="premium")track.candles.at(-4)!.close=300;
    if(reason==="duplicate")track.status="DUPLICATE";
    if(reason==="lockout")s.days[0].locked=true;
    expect(suggestOptions(s,0).every(x=>x.action==="WAIT")).toBe(true);expect(()=>enterOption(s,"CE")).toThrow();
  });
  it("shares a single position, daily trade count and stop plan with futures",()=>{const s=seed();enterOption(s,"CE");expect(s.position?.contract.optionType).toBe("CE");expect(s.days[0].trades).toBe(1);expect(suggestOptions(s,0).every(x=>x.action==="WAIT")).toBe(true);expect(()=>enterOption(s,"PE")).toThrow();expect(evaluate(s).action).toBe("HOLD");expect(s.position?.side).toBe("BUY");});
  it("uses the actual option bid for stop exits and charges, and counts losses honestly",()=>{const s=seed();enterOption(s,"CE");const p={...s.position!};tick(s,p.stop-5);const d=evaluate(s);expect(d.action).toBe("EXIT");expect(s.position).toBeNull();expect(s.trades[0].exit).toBeCloseTo(p.stop-6);expect(s.trades[0].net).toBeLessThan(-p.maxRisk);expect(s.days[0].net).toBe(s.trades[0].net);expect(s.trades[0].gross-s.trades[0].costs).toBeCloseTo(s.trades[0].net);});
  it("sets a target with estimated net reward of at least 2R",()=>{const s=seed();enterOption(s,"CE");const p=s.position!;const q={...quote(p.contract as OptionContract),bid:p.target};expect(closePosition(p,0,now,"target",q).net).toBeGreaterThanOrEqual(p.maxRisk*2-1e-6);});
  it("never prices an option position from futures prices",()=>{const s=seed();enterOption(s,"CE");expect(mark(s)).toBeLessThan(0);expect(()=>closePosition(s.position!,8562,now,"wrong mark")).toThrow();});
  it("latches an exit through failed data and closes only after a new exact bid",()=>{const s=seed();enterOption(s,"CE");s.optionDesk!.tracks[s.position!.contract.token].status="UNAVAILABLE";expect(evaluate(s).action).toBe("EXIT");expect(s.position).not.toBeNull();expect(s.pendingExitReason).toBeTruthy();tick(s,210);s.optionDesk!.tracks[s.position!.contract.token].status="OK";evaluate(s);expect(s.position).toBeNull();expect(s.trades).toHaveLength(1);});
  it("requires the held exact contract and sufficient executable bid size",()=>{const s=seed();enterOption(s,"CE");const track=s.optionDesk!.tracks[s.position!.contract.token];track.quote!.contract={...track.quote!.contract,token:"999999"};expect(optionFillReady(s)).toBe(false);track.quote=quote(track.contract);track.quote.bidQuantity=1;expect(optionFillReady(s)).toBe(false);});
  it("refuses fills when the held monetary specification changes",()=>{const s=seed();enterOption(s,"CE");const track=s.optionDesk!.tracks[s.position!.contract.token];track.quote!.contract={...track.quote!.contract,multiplier:100};expect(optionFillReady(s)).toBe(false);expect(evaluate(s).action).toBe("EXIT");expect(s.position).not.toBeNull();});
  it("does not accept option entries in replay",()=>{const s=seed();s.mode="REPLAY";expect(()=>enterOption(s,"CE")).toThrow();});
});
describe("option observations, persistence and reports",()=>{
  function mockLive(s:State){
    for(const key of ["ANGEL_API_KEY","ANGEL_CLIENT_CODE","ANGEL_ACCESS_TOKEN","ANGEL_FEED_TOKEN","ANGEL_CLIENT_LOCAL_IP","ANGEL_CLIENT_PUBLIC_IP","ANGEL_MAC_ADDRESS","MARKETPILOT_SPECS_FILE","MARKETPILOT_OPTION_SPECS_FILE"])vi.stubEnv(key,"TEST ONLY");
    vi.spyOn(broker,"currentContract").mockResolvedValue(underlying);vi.spyOn(broker,"quote").mockResolvedValue({price:s.lastQuote!.price,time:now});vi.spyOn(context,"globalContext").mockResolvedValue(s.context as [ContextItem,ContextItem,ContextItem]);vi.spyOn(session,"marketSession").mockResolvedValue(s.session!);
    vi.spyOn(optionAdapter,"optionContracts").mockResolvedValue(contracts());vi.spyOn(optionAdapter,"optionQuotes").mockImplementation(async cs=>cs.map(c=>quote(c,now)));
    for(const track of Object.values(s.optionDesk!.tracks)){track.quote!.time=new Date(Date.parse(now)-5000).toISOString();}
  }
  it.each([false,true])("persists the correct paper option and linked premium mark (down=%s)",async down=>{const s=seed(down);mockLive(s);saveState(s);const entered=await operate("LIVE",down?"enter-pe":"enter-ce");expect(entered.position?.contract.optionType).toBe(down?"PE":"CE");expect(readState("LIVE")?.position?.optionEntryQuote?.ask).toBe(209.75);const report=forwardSessionReport("2026-10-05",now);expect(report.optionObservations).toHaveLength(2);expect(report.entries[0].contract.instrument).toBe("OPTION");expect(report.outcome.valuationCurrent).toBe(true);expect(report.outcome.unrealizedEstimate).toBeCloseTo(entered.unrealized);});
  it("records failed quotes without fabricating premium candles or fills",async()=>{const s=seed();mockLive(s);vi.mocked(optionAdapter.optionQuotes).mockRejectedValue(new Error("private transport error"));const count=s.optionDesk!.tracks[s.optionDesk!.selected.CE!].candles.length;await pollOptions(s);expect(s.optionDesk!.tracks[s.optionDesk!.selected.CE!].candles).toHaveLength(count);expect(suggestOptions(s,0).every(x=>x.action==="WAIT")).toBe(true);expect(JSON.stringify(db().prepare("SELECT json FROM option_observations").all())).not.toContain("private transport error");});
  it("subscribes selected option tokens to SmartAPI Snap Quote mode",async()=>{
    const s=seed();mockLive(s);
    const subscribe=vi.spyOn(smartMarketStream,"subscribeSnapQuote");
    await pollOptions(s);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledWith(s.optionDesk!.selected.CE);
    expect(subscribe).toHaveBeenCalledWith(s.optionDesk!.selected.PE);
  });
  it("triggers worker option refresh only when every tracked stream quote advances",()=>{
    const s=seed();
    vi.setSystemTime(Date.parse(now)+1000);
    const next=new Date().toISOString();
    vi.spyOn(smartMarketStream,"latestOption").mockImplementation(token=>({
      token,price:209.5,time:next,tradeTime:now,receivedAt:next,bid:209.25,ask:209.75,
      bidQuantity:100,askQuantity:100,volume:1000,openInterest:1000,
    }));
    expect(hasNewOptionStreamQuote(s)).toBe(true);
    vi.mocked(smartMarketStream.latestOption).mockReturnValue(null);
    expect(hasNewOptionStreamQuote(s)).toBe(false);
  });
  it("propagates audit-storage failure so no paper command can commit unaudited fills",async()=>{const s=seed();mockLive(s);const real=db().prepare.bind(db());vi.spyOn(db(),"prepare").mockImplementation(sql=>{if(sql.startsWith("INSERT INTO option_observations"))throw new Error("TEST write failure");return real(sql);});await expect(pollOptions(s)).rejects.toThrow("TEST write failure");expect(s.position).toBeNull();});
});
