import type { Decision, State } from "./types";
export interface NotificationDelivery { deliver(state: State, decision: Decision): void }
export const inApp: NotificationDelivery = { deliver(state, d) {
  const key = `${d.action}:${d.reasons.join("|") .replace(/\d+(\.\d+)?/g, "#")}`;
  if (key === state.lastAlert) return;
  state.lastAlert = key;
  state.journal.push({ id: crypto.randomUUID(), time: d.time, kind: d.action === "WAIT" && !state.position ? "SKIPPED" : "ALERT", text: `${d.action} · ${d.reasons.join(" · ")}`, decisionId: d.id });
} };
