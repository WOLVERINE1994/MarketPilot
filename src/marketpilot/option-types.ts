import type { Candle, Contract } from "./types";
export type OptionType = "CE" | "PE";
export type OptionContract = Contract & { instrument: "OPTION"; optionType: OptionType; strike: number; underlyingSymbol: string };
export type OptionSpecification = { underlyingSymbol: string; underlyingExpiry: string; optionExpiry: string; lotSize: number; multiplier: number; tickSize: number; strikeStep: number; source: string; verifiedAt: string; validUntil: string };
export type OptionQuote = { id: string; contract: OptionContract; time: string; tradeTime: string; receivedAt: string; ltp: number; bid: number; ask: number; bidQuantity: number; askQuantity: number; volume: number; openInterest: number };
export type OptionObservation = { id: string; receivedAt: string; contract: OptionContract; status: string; reason: string; quote: OptionQuote | null };
export type OptionTrack = { contract: OptionContract; quote: OptionQuote | null; status: string; reason: string; candles: Candle[] };
export type OptionSuggestion = { type: OptionType; action: "WAIT" | "BUY" | "HOLD" | "EXIT"; reasons: string[]; contract: OptionContract | null; quote: OptionQuote | null; entry: number | null; stop: number | null; target: number | null; estimatedCosts: number; maxRisk: number; premiumAtRisk: number; observedCandles: number; status: string };
export type OptionDesk = { checkedAt: string; setupReason: string; tracks: Record<string, OptionTrack>; selected: Partial<Record<OptionType, string>>; suggestions: OptionSuggestion[] };
