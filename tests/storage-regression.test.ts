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
  it("serves a saved dashboard under a SQLite write lock while refusing paper commands", () => {
    const result = run(workspace(), `
      import path from 'node:path';
      import { initial,evaluate,refreshDashboard,operate } from './src/marketpilot/engine.ts';
      import { db,saveState,MonitorBusyError } from './src/marketpilot/storage.ts';
      const s=initial('REPLAY');saveState(s,evaluate(s));
      const {DatabaseSync}=process.getBuiltinModule('node:sqlite');
      const writer=new DatabaseSync(path.join(process.env.MARKETPILOT_DATA_DIR,'marketpilot.sqlite'));
      writer.exec('BEGIN IMMEDIATE');
      const start=Date.now();let refused=false,snapshot;
      try {
        snapshot=await refreshDashboard('REPLAY');
        try {await operate('REPLAY','enter');} catch(e) {refused=e instanceof MonitorBusyError;}
      } finally {writer.exec('ROLLBACK');writer.close();}
      const elapsed=Date.now()-start;
      const recovered=await operate('REPLAY','refresh');
      console.log(JSON.stringify({refused,elapsed,sameDecision:snapshot.decision.id===s.decision.id,
        position:snapshot.position,recovered:!!recovered.decision,
        timeout:db().prepare('PRAGMA busy_timeout').get().timeout,leases:db().prepare('SELECT * FROM leases').all()}));
    `);
    expect(result).toMatchObject({ refused: true, sameDecision: true, position: null, recovered: true, timeout: 5000, leases: [] });
    expect(result.elapsed).toBeLessThan(1500);
  });

  it("rejects a lease held by another process and acquires it after release", () => {
    const dir = workspace();
    run(dir, `
      import { db } from './src/marketpilot/storage.ts';
      db().prepare('INSERT INTO leases VALUES (?,?,?)').run('LIVE','other-worker',Date.now()+120000);
      console.log('{}');
    `);
    const blocked = run(dir, `
      import { exclusive, MonitorBusyError } from './src/marketpilot/storage.ts';
      let entered=false, busy=false;
      try { await exclusive('LIVE',async()=>{entered=true;}); } catch(e) { busy=e instanceof MonitorBusyError; }
      console.log(JSON.stringify({entered,busy}));
    `);
    expect(blocked).toEqual({ entered: false, busy: true });
    const released = run(dir, `
      import { db, exclusive } from './src/marketpilot/storage.ts';
      db().prepare('DELETE FROM leases WHERE name=? AND owner=?').run('LIVE','other-worker');
      const entered=await exclusive('LIVE',async()=>true);
      console.log(JSON.stringify({entered,leases:db().prepare('SELECT * FROM leases').all()}));
    `);
    expect(released).toEqual({ entered: true, leases: [] });
  });

  it("recovers the LIVE observation watermark and complete forward report in a new Node process", () => {
    const dir = workspace();
    const written = run(dir, `
      import { initial, evaluate } from './src/marketpilot/engine.ts';
      import { saveState, writeObservation } from './src/marketpilot/storage.ts';
      import { applyObservation } from './src/marketpilot/feed.ts';
      const s = initial('LIVE');
      const o = {id:'persisted-observation',startedAt:'2026-09-14T17:30:00.000Z',receivedAt:'2026-09-14T17:30:00.000Z',exchangeTime:'2026-09-14T17:30:00.000Z',
        contract:{symbol:'CRUDEOILM21SEP26FUT',token:'12345',expiry:'2026-09-21',lotSize:10,multiplier:10,tickSize:1,source:'https://www.mcxindia.com/test',verified:true},
        price:6000,status:'OK',reason:'restart test fixture',source:'worker',gapSeconds:5};
      writeObservation(o); applyObservation(s,o); const d=evaluate(s); saveState(s,d);
      console.log(JSON.stringify({observation:o,decision:d.id}));
    `);
    const recovered = run(dir, `
      import { readState,lastValidObservation } from './src/marketpilot/storage.ts';
      import { forwardSessionReport } from './src/marketpilot/report.ts';
      import { temporalStatus } from './src/marketpilot/feed.ts';
      const o=lastValidObservation('CRUDEOILM21SEP26FUT','12345');
      console.log(JSON.stringify({state:readState('LIVE'),observation:o,
        report:forwardSessionReport('2026-09-14','2026-09-14T17:30:05.000Z'),
        oldQuote:temporalStatus('2026-09-14T17:29:59.000Z','2026-09-14T17:30:05.000Z',o.exchangeTime)}));
    `);
    expect(recovered.observation).toEqual(written.observation);
    expect(recovered.oldQuote).toBe("OUT_OF_ORDER");
    expect(recovered.report.decisions[0].id).toBe(written.decision);
    expect(recovered.report.observations).toEqual([written.observation]);
    expect(recovered.state.latestObservation.id).toBe("persisted-observation");
    expect(recovered.report.assessments).toHaveLength(1);
  });

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
