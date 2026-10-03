import type { Contract } from "./types";
import type { SessionTokenStatus } from "./credentials";

export type ObservationStatus = "PENDING" | "OK" | "STALE" | "FUTURE_DATED" | "OUT_OF_ORDER" | "DUPLICATE" | "CONTRACT_MISMATCH" | "MALFORMED" | "UNAVAILABLE" | "INTERRUPTED";
export type LiveObservation = {
  id: string;
  startedAt: string;
  receivedAt: string | null;
  exchangeTime: string | null;
  contract: Contract | null;
  price: number | null;
  status: ObservationStatus;
  reason: string;
  source: "worker" | "dashboard";
  gapSeconds: number | null;
};
export type FeedHealth = {
  configured: boolean;
  missingSettings: string[];
  sessionTokenStatus: SessionTokenStatus;
  connection: "CONNECTED_AND_VERIFIED" | "NOT_VERIFIED" | "DISCONNECTED";
  lastValidExchangeTime: string | null;
  lastReceiptTime: string | null;
  ageSeconds: number | null;
  workerStatus: "RUNNING" | "STOPPED_OR_NOT_STARTED";
  lastWorker: string | null;
  validSamples: number;
  failedSamples: number;
  pendingSamples: number;
  largestGapSeconds: number;
  latestStatus: string;
  day: string;
};
