import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

/** Append-only JSONL log of every signal and paper result, plus a small state file for open trades. */
export class Journal {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.logFile = path.join(dir, "journal.jsonl");
    this.stateFile = path.join(dir, "open-trades.json");
  }

  append(entry) { appendFileSync(this.logFile, JSON.stringify(entry) + "\n"); }

  /** All closed paper trades (newest last). */
  closedTrades() {
    if (!existsSync(this.logFile)) return [];
    return readFileSync(this.logFile, "utf8").split("\n").filter(Boolean).flatMap(line => {
      try { const e = JSON.parse(line); return e.record === "CLOSED" ? [e] : []; } catch { return []; }
    });
  }

  saveOpen(trades) {
    const tmp = this.stateFile + ".tmp";
    writeFileSync(tmp, JSON.stringify(trades, null, 1));
    renameSync(tmp, this.stateFile);
  }

  loadOpen() {
    try { return JSON.parse(readFileSync(this.stateFile, "utf8")); } catch { return []; }
  }
}
