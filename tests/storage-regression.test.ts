import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function workspace() {
  const base = path.resolve(".marketpilot-tests-storage");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, "run-"));
}
function run(dir: string, source: string) {
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(), env: { ...process.env, MARKETPILOT_DATA_DIR: dir }, encoding: "utf8", timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

describe("native SQLite persistence regressions", () => {
  it("recovers position, lockout, journal and decisions in a new process", () => {
    const dir = workspace();
    const written = run(dir, `
      import { initial, evaluate, enter } from './src/marketpilot/engine.ts';
      import { saveState } from './src/marketpilot/storage.ts';
      const s = initial('REPLAY');
      const decision = evaluate(s); enter(s);
      s.days[0].locked = true;
      saveState(s, decision);
      console.log(JSON.stringify({ state: s, decision }));
    `);
    const recovered = run(dir, `
      import { readState, decisions, db } from './src/marketpilot/storage.ts';
      console.log(JSON.stringify({ state: readState('REPLAY'), live: readState('LIVE'),
        decision: decisions('REPLAY')[0], journalMode: db().prepare('PRAGMA journal_mode').get() }));
    `);
    expect(recovered.state).toEqual(written.state);
    expect(recovered.state.position).not.toBeNull();
    expect(recovered.state.days[0].locked).toBe(true);
    expect(recovered.state.journal.length).toBeGreaterThan(0);
    expect(recovered.decision).toEqual(written.decision);
    expect(recovered.live).toBeNull();
    expect(recovered.journalMode.journal_mode).toBe("wal");
  });

  it("rolls back the state write if the decision insert fails", () => {
    const result = run(workspace(), `
      import { initial, evaluate } from './src/marketpilot/engine.ts';
      import { saveState, readState, decisions } from './src/marketpilot/storage.ts';
      const s = initial('REPLAY'); const d = evaluate(s); saveState(s, d);
      s.settings.paused = true; let rejected = false;
      try { saveState(s, d); } catch { rejected = true; }
      console.log(JSON.stringify({ rejected, paused: readState('REPLAY').settings.paused, count: decisions('REPLAY').length }));
    `);
    expect(result).toEqual({ rejected: true, paused: false, count: 1 });
  });

  it("fails closed if native SQLite is unavailable", () => {
    const result = run(workspace(), `
      import { db } from './src/marketpilot/storage.ts';
      const original = process.getBuiltinModule;
      process.getBuiltinModule = name => name === 'node:sqlite' ? undefined : original(name);
      let error = '';
      try { db(); } catch (e) { error = e.message; }
      console.log(JSON.stringify({ error }));
    `);
    expect(result.error).toContain("native node:sqlite support");
  });
});
