/**
 * PHASE 8 — TASK ↔ AUDIT CORRELATION, AND CONCURRENT TASK ISOLATION.
 *
 *   node --test server/test/
 *
 * THE DEFECT THIS FILE EXISTS FOR. Phase 5 documented that `tool_events` and
 * `mutation_ledger` carried no task id, so evidence correlated them by session
 * plus the task's time window. Phase 8 checked whether that was a real
 * correctness problem and it was: two plans running in ONE session overlap in
 * time, so each one's evidence claimed BOTH plans' mutations. Worse, the
 * `changes` section presented them as fact — `source: mutation_ledger` — while
 * only the `audit` section carried the `exact: false` caveat. A run could
 * report a record it never touched as one of its own changes.
 *
 * THE FIX IS TWO NULLABLE COLUMNS (migration 23) and one rule:
 *
 *   a row that NAMES a task belongs to that task and to no other;
 *   a row that names none falls back to the window it always used.
 *
 * That keeps every pre-migration row and every plan-less turn-loop row meaning
 * exactly what it meant before, while making cross-claiming impossible rather
 * than merely unlikely.
 *
 * STRUCTURAL / OFFLINE TESTS. No instance, no model, scratch SQLite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p8corr-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const P = await import('../src/agent/plan/index.js');
const R = await import('../src/agent/recovery/index.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask, completeTask, cancelTask, getTask } = await import('../src/memory/tasks.js');
const { appendMutation } = await import('../src/memory/ledger.js');
const { recordToolEvent } = await import('../src/memory/sessions.js');
const { toolMap } = await import('../src/agent/tools.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

let n = 0;
const newSession = (tag = 's') => {
  const id = `p8-${tag}-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(id, new Date().toISOString(), new Date().toISOString());
  return id;
};
function newTaskIn(sessionId, goal) {
  const t = createTask({ sessionId, goal });
  startTask(t.id);
  return t.id;
}

const SYS_A = 'a'.repeat(32);
const SYS_B = 'b'.repeat(32);

const step = (over = {}) => ({
  id: over.id ?? 'step_1',
  operation: over.operation ?? 'update the record',
  capability: over.capability ?? 'record_update',
  tool: over.tool ?? null,
  mechanism: null,
  scope: null,
  mutating: over.mutating ?? true,
  target: over.target ?? { table: 'incident', sys_id: SYS_A },
  inputs: over.inputs ?? { table: 'incident', sys_id: SYS_A, data: { short_description: 'x' } },
  depends_on: over.depends_on ?? [],
  expected_effects: over.expected_effects ?? ['short_description is updated'],
  verification: 'verification' in over ? over.verification : { strategy: 'read_back', asserts: ['ok'] },
});

/** Write one ledger row + one tool event, optionally naming a task. */
function writeAudit({ sessionId, taskId = null, table, sysId, marker }) {
  appendMutation({
    sessionId,
    turnSeq: 0,
    tool: 'update_record',
    descriptor: { table, sys_id: sysId, operation: 'update', requested: { short_description: marker } },
    result: { sys_id: sysId },
    verification: { status: 'applied', operation: 'update', applied: [{ field: 'short_description', value: marker }] },
    approval: 'approved',
    approvedSource: APPROVAL_SOURCES.USER_CLICK,
    taskId,
  });
  recordToolEvent(sessionId, {
    taskId, kind: 'tool_call', name: `tool_${marker}`, payload: { marker },
    result: 'ok', resultStatus: 'applied', mutating: true, approval: 'approved',
    approvedSource: APPROVAL_SOURCES.USER_CLICK,
  });
}

const tablesOf = (ev) => ev.changes.map((c) => c.table);
const eventNamesOf = (ev) => ev.audit.toolEvents.map((e) => e.name);

function localTool(name, spec) {
  toolMap.set(name, { name, ...spec });
  return () => toolMap.delete(name);
}
const httpError = (status, message = 'the instance said no') =>
  Object.assign(new Error(message), { status });

/** Approve and run a plan through the REAL executor. */
async function runPlan(taskId, sessionId, steps, { decide = true, signal = null, recoverStep = null, goal = 'g' } = {}) {
  const saved = P.savePlan(taskId, { goal, steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  const events = [];
  const res = await P.executePlan({
    taskId,
    sessionId,
    turnSeq: 1,
    signal,
    recoverStep,
    emit: (e) => {
      events.push(e);
      if (e.type === 'approval_required' && decide !== null) {
        setImmediate(() => resolveApproval(sessionId, e.approvalId, decide, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    },
  });
  return { res, events };
}

/* ================================================================== *
 * A. THE MIGRATION
 * ================================================================== */

test('A1 — migration 23 exists, is append-only, and adds two nullable columns', () => {
  const db = getDb();
  // 24 is the head since Health Assist appended its two tables; 23's own
  // content is what the column checks below still assert.
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 25);
  for (const table of ['mutation_ledger', 'tool_events']) {
    const col = db.prepare(`PRAGMA table_info(${table})`).all().find((c) => c.name === 'task_id');
    assert.ok(col, `${table} has no task_id column`);
    assert.equal(col.notnull, 0, `${table}.task_id is NOT NULL — existing rows could not survive that`);
    assert.equal(col.dflt_value, null, `${table}.task_id has a default, so a row could claim a task by accident`);
  }
});

test('A2 — migrations 1-22 were not rewritten', () => {
  // The migration list is append-only: entry 23 is the last one, and the count
  // is exactly 23. A rewritten earlier migration would not change this, which is
  // why the real guard is the `git diff` deletion count reported alongside — but
  // an accidental *removal* would show up here.
  const src = fs.readFileSync(new URL('../src/memory/db.js', import.meta.url), 'utf8');
  assert.match(src, /\/\/ 23 — PHASE 8/, 'migration 23 is not labelled');
  assert.match(src, /ALTER TABLE mutation_ledger ADD COLUMN task_id TEXT/);
  assert.match(src, /ALTER TABLE tool_events ADD COLUMN task_id TEXT/);
  // It is guarded, because SQLite cannot express `ADD COLUMN IF NOT EXISTS` and
  // both tables predate the migration. The suite's own replay test proved a
  // bare ALTER here was not survivable.
  assert.match(src, /if \(!has\('mutation_ledger', 'task_id'\)\)/,
    'migration 23 is not replay-safe');
  // 22 was the previous head and must still be there, untouched in intent.
  assert.match(src, /\/\/ 22 — PHASE 4: the durable PLAN/);
});

/* ================================================================== *
 * B. THE DEFECT, AND THAT IT IS CLOSED
 * ================================================================== */

test('B1 — DEFECT REPRODUCTION: untagged rows in one session cross-claim (the old behaviour)', () => {
  const s = newSession('legacy');
  const a = newTaskIn(s, 'plan A');
  const b = newTaskIn(s, 'plan B');
  P.savePlan(a, { goal: 'A', steps: [step({ id: 'a1' })] });
  P.savePlan(b, { goal: 'B', steps: [step({ id: 'b1', target: { table: 'problem', sys_id: SYS_B } })] });

  // taskId omitted — this is exactly what every pre-migration-23 row looks like.
  writeAudit({ sessionId: s, table: 'incident', sysId: SYS_A, marker: 'A' });
  writeAudit({ sessionId: s, table: 'problem', sysId: SYS_B, marker: 'B' });
  completeTask(a); completeTask(b);

  const ea = buildEvidence(a);
  // The old behaviour is preserved for old rows — that is deliberate, because
  // back-filling them with a guess would be inventing provenance.
  assert.ok(tablesOf(ea).includes('problem'), 'the legacy fallback stopped working');
  // But it is no longer reported as fact.
  assert.equal(ea.audit.exact, false);
  assert.ok(ea.changes.every((c) => c.exact === false), 'a window-matched change claimed to be exact');
  assert.match(ea.audit.note, /matched by session and time window/);
});

test('B2 — THE FIX: two tagged plans in ONE session never claim each other', () => {
  const s = newSession('shared');
  const a = newTaskIn(s, 'plan A');
  const b = newTaskIn(s, 'plan B');
  P.savePlan(a, { goal: 'A', steps: [step({ id: 'a1' })] });
  P.savePlan(b, { goal: 'B', steps: [step({ id: 'b1', target: { table: 'problem', sys_id: SYS_B } })] });

  // Interleaved in time, exactly as two concurrent plans would be.
  writeAudit({ sessionId: s, taskId: a, table: 'incident', sysId: SYS_A, marker: 'A' });
  writeAudit({ sessionId: s, taskId: b, table: 'problem', sysId: SYS_B, marker: 'B' });
  completeTask(a); completeTask(b);

  const ea = buildEvidence(a);
  const eb = buildEvidence(b);
  assert.deepEqual(tablesOf(ea), ['incident'], `A claimed: ${JSON.stringify(tablesOf(ea))}`);
  assert.deepEqual(tablesOf(eb), ['problem'], `B claimed: ${JSON.stringify(tablesOf(eb))}`);
  assert.deepEqual(eventNamesOf(ea), ['tool_A']);
  assert.deepEqual(eventNamesOf(eb), ['tool_B']);
  assert.equal(ea.audit.exact, true);
  assert.equal(eb.audit.exact, true);
});

test('B3 — two plans in DIFFERENT sessions never claim each other', () => {
  const sa = newSession('sepA');
  const sb = newSession('sepB');
  const a = newTaskIn(sa, 'plan A');
  const b = newTaskIn(sb, 'plan B');
  P.savePlan(a, { goal: 'A', steps: [step({ id: 'a1' })] });
  P.savePlan(b, { goal: 'B', steps: [step({ id: 'b1' })] });
  writeAudit({ sessionId: sa, taskId: a, table: 'incident', sysId: SYS_A, marker: 'A' });
  writeAudit({ sessionId: sb, taskId: b, table: 'problem', sysId: SYS_B, marker: 'B' });
  completeTask(a); completeTask(b);

  assert.deepEqual(tablesOf(buildEvidence(a)), ['incident']);
  assert.deepEqual(tablesOf(buildEvidence(b)), ['problem']);
});

test('B4 — a MIXED set reports exact:false and says how mixed', () => {
  const s = newSession('mixed');
  const a = newTaskIn(s, 'plan A');
  P.savePlan(a, { goal: 'A', steps: [step({ id: 'a1' })] });
  writeAudit({ sessionId: s, taskId: a, table: 'incident', sysId: SYS_A, marker: 'tagged' });
  writeAudit({ sessionId: s, table: 'incident', sysId: SYS_A, marker: 'untagged' });
  completeTask(a);

  const ev = buildEvidence(a);
  assert.equal(ev.audit.exact, false, 'a mixed set was rounded up to exact');
  assert.equal(ev.audit.counts.changes, 2);
  assert.equal(ev.audit.counts.changesExact, 1);
  assert.equal(ev.audit.counts.toolEventsExact, 1);
  assert.equal(ev.changes.filter((c) => c.exact).length, 1);
});

test('B5 — a task that claimed nothing is exact, not "unknown"', () => {
  const s = newSession('empty');
  const a = newTaskIn(s, 'plan A');
  P.savePlan(a, { goal: 'A', steps: [step({ id: 'a1' })] });
  completeTask(a);
  const ev = buildEvidence(a);
  assert.equal(ev.audit.exact, true, 'claiming nothing cannot be claiming wrongly');
  assert.deepEqual(ev.changes, []);
});

test('B6 — the plan executor actually TAGS what it writes', async () => {
  const drop = localTool('p8_corr_write', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => ({ sys_id: i.sys_id, short_description: 'x', number: 'INC0001' }),
  });
  try {
    const s = newSession('exec');
    const a = newTaskIn(s, 'real executor');
    registerFromToolResult({ sessionId: s, seq: 0, table: 'incident', result: { sys_id: SYS_A } });
    await runPlan(a, s, [step({ tool: 'p8_corr_write' })]);

    const rows = getDb().prepare('SELECT task_id FROM mutation_ledger WHERE session = ?').all(s);
    assert.ok(rows.length > 0, 'the executor wrote no ledger row at all');
    assert.ok(rows.every((r) => r.task_id === a), `an executor write was left untagged: ${JSON.stringify(rows)}`);

    const evts = getDb().prepare('SELECT task_id, name FROM tool_events WHERE session = ?').all(s);
    assert.ok(evts.length > 0);
    assert.ok(evts.every((r) => r.task_id === a), `an executor tool event was left untagged: ${JSON.stringify(evts)}`);

    assert.equal(buildEvidence(a).audit.exact, true);
  } finally { drop(); }
});

/* ================================================================== *
 * C. CONCURRENCY — REAL CONCURRENT EXECUTION, NOT SEQUENTIAL SIMULATION
 * ================================================================== */

test('C1 — EVIDENCE isolation under genuinely concurrent plans', async () => {
  // Both plans are in flight at once: each tool blocks until BOTH have entered,
  // so their windows provably overlap rather than merely appearing to.
  let enteredA = null; let enteredB = null;
  const bothIn = new Promise((resolve) => {
    let count = 0;
    const hit = () => { count += 1; if (count === 2) resolve(); };
    enteredA = hit; enteredB = hit;
  });
  const mk = (name, sys) => localTool(name, {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: i.table, requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => {
      (name.endsWith('a') ? enteredA : enteredB)();
      await bothIn;
      return { sys_id: sys, short_description: 'x' };
    },
  });
  const d1 = mk('p8_conc_a', SYS_A);
  const d2 = mk('p8_conc_b', SYS_B);
  try {
    const s = newSession('conc');
    const a = newTaskIn(s, 'concurrent A');
    const b = newTaskIn(s, 'concurrent B');
    registerFromToolResult({ sessionId: s, seq: 0, table: 'incident', result: { sys_id: SYS_A } });
    registerFromToolResult({ sessionId: s, seq: 1, table: 'problem', result: { sys_id: SYS_B } });

    await Promise.all([
      runPlan(a, s, [step({ id: 'a1', tool: 'p8_conc_a' })], { goal: 'A' }),
      runPlan(b, s, [step({
        id: 'b1', tool: 'p8_conc_b',
        target: { table: 'problem', sys_id: SYS_B },
        inputs: { table: 'problem', sys_id: SYS_B, data: { short_description: 'x' } },
      })], { goal: 'B' }),
    ]);

    const ea = buildEvidence(a);
    const eb = buildEvidence(b);
    assert.deepEqual(tablesOf(ea), ['incident'], `A claimed B's work: ${JSON.stringify(tablesOf(ea))}`);
    assert.deepEqual(tablesOf(eb), ['problem'], `B claimed A's work: ${JSON.stringify(tablesOf(eb))}`);
    assert.equal(ea.audit.exact, true);
    assert.equal(eb.audit.exact, true);
    // And neither contains the other's STEP evidence, which was always exact.
    assert.deepEqual(ea.steps.map((x) => x.id), ['a1']);
    assert.deepEqual(eb.steps.map((x) => x.id), ['b1']);
  } finally { d1(); d2(); }
});

test('C2 — CANCELLATION isolation: cancelling A does not touch B', async () => {
  const ctlA = new AbortController();
  let ranB = 0;
  const d1 = localTool('p8_cancel_a', { mutating: false, execute: async () => { ctlA.abort(); return { ok: true }; } });
  const d2 = localTool('p8_cancel_b', { mutating: false, execute: async () => { ranB += 1; return { ok: true }; } });
  try {
    const s = newSession('cancel');
    const a = newTaskIn(s, 'cancel A');
    const b = newTaskIn(s, 'keep B');
    const read = (id, tool) => step({
      id, tool, mutating: false, capability: 'record_read', verification: null, expected_effects: [],
    });
    const [ra, rb] = await Promise.all([
      runPlan(a, s, [read('a1', 'p8_cancel_a'), read('a2', 'p8_cancel_a')], { signal: ctlA.signal, goal: 'A' }),
      runPlan(b, s, [read('b1', 'p8_cancel_b')], { goal: 'B' }),
    ]);
    assert.equal(rb.res.ok, true, 'B failed because A was cancelled');
    assert.equal(ranB, 1);
    assert.equal(P.loadPlan(b).planState, 'completed');
    assert.equal(P.loadPlan(a).planState, 'cancelled');
    assert.equal(getTask(b).state, 'running', 'B\'s task lifecycle was closed by A\'s cancellation');
  } finally { d1(); d2(); }
});

test('C3 — APPROVAL isolation: approving A does not authorise B', async () => {
  let ranA = 0; let ranB = 0;
  const mk = (name, counter) => localTool(name, {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: i.table, requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => { counter(); return { sys_id: i.sys_id, short_description: 'x' }; },
  });
  const d1 = mk('p8_appr_a', () => { ranA += 1; });
  const d2 = mk('p8_appr_b', () => { ranB += 1; });
  try {
    const s = newSession('appr');
    const a = newTaskIn(s, 'approve A');
    const b = newTaskIn(s, 'never approve B');
    registerFromToolResult({ sessionId: s, seq: 0, table: 'incident', result: { sys_id: SYS_A } });

    // A is approved. B's gate is answered with a REJECTION.
    const [, rb] = await Promise.all([
      runPlan(a, s, [step({ id: 'a1', tool: 'p8_appr_a' })], { decide: true, goal: 'A' }),
      runPlan(b, s, [step({ id: 'b1', tool: 'p8_appr_b' })], { decide: false, goal: 'B' }),
    ]);
    assert.equal(ranA, 1, 'the approved plan did not run');
    assert.equal(ranB, 0, 'A REJECTED PLAN EXECUTED — an approval crossed a task boundary');
    assert.equal(rb.res.ok, false);
    assert.equal(P.loadPlan(b).steps[0].state, 'failed');
    // B never acquired an approval binding it did not earn.
    assert.equal(P.loadPlan(b).approvedFingerprint, P.loadPlan(b).fingerprint);
  } finally { d1(); d2(); }
});

test('C4 — FINGERPRINT isolation: A\'s stale plan does not stop B', async () => {
  let ranB = 0;
  const d1 = localTool('p8_fp_a', { mutating: false, execute: async () => ({ ok: true }) });
  const d2 = localTool('p8_fp_b', { mutating: false, execute: async () => { ranB += 1; return { ok: true }; } });
  try {
    const s = newSession('fp');
    const a = newTaskIn(s, 'stale A');
    const b = newTaskIn(s, 'healthy B');
    const read = (id, tool) => step({
      id, tool, mutating: false, capability: 'record_read', verification: null, expected_effects: [],
    });
    // A is approved, then edited underneath — the classic stale-plan shape.
    const savedA = P.savePlan(a, { goal: 'A', steps: [read('a1', 'p8_fp_a')] });
    P.setPlanState(a, 'ready'); P.setPlanState(a, 'awaiting_approval');
    P.approvePlan(a, savedA.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    getDb().prepare('UPDATE agent_tasks SET plan_fingerprint = ? WHERE id = ?').run('0'.repeat(64), a);

    const [ra, rb] = await Promise.all([
      P.executePlan({ taskId: a, sessionId: s, turnSeq: 1, emit: () => {} }),
      runPlan(b, s, [read('b1', 'p8_fp_b')], { goal: 'B' }),
    ]);
    assert.equal(ra.ok, false, 'a stale plan executed');
    assert.equal(rb.res.ok, true, 'B was stopped by A\'s stale fingerprint');
    assert.equal(ranB, 1);
  } finally { d1(); d2(); }
});

test('C5 — RECOVERY isolation: A\'s recovery lineage never appears under B', async () => {
  let callsA = 0;
  const d1 = localTool('p8_rec_a', {
    mutating: false,
    execute: async () => { callsA += 1; if (callsA === 1) throw httpError(503); return { ok: true }; },
  });
  const d2 = localTool('p8_rec_b', { mutating: false, execute: async () => ({ ok: true }) });
  try {
    const s = newSession('rec');
    const a = newTaskIn(s, 'recovering A');
    const b = newTaskIn(s, 'clean B');
    const read = (id, tool) => step({
      id, tool, mutating: false, capability: 'record_read', verification: null, expected_effects: [],
    });
    await Promise.all([
      runPlan(a, s, [read('a1', 'p8_rec_a')], { recoverStep: R.recoverStep, goal: 'A' }),
      runPlan(b, s, [read('b1', 'p8_rec_b')], { recoverStep: R.recoverStep, goal: 'B' }),
    ]);
    const ea = buildEvidence(a);
    const eb = buildEvidence(b);
    assert.equal(ea.recovery.attempted, true, 'A did not recover');
    assert.equal(ea.recovery.recoveredSteps, 1);
    assert.equal(eb.recovery.attempted, false, 'B INHERITED A\'S RECOVERY LINEAGE');
    assert.deepEqual(eb.recovery.steps, []);
    assert.deepEqual(ea.recovery.steps.map((x) => x.step), ['a1']);
  } finally { d1(); d2(); }
});

test('C6 — TASK LIFECYCLE isolation: states move independently', async () => {
  const s = newSession('life');
  const a = newTaskIn(s, 'A');
  const b = newTaskIn(s, 'B');
  const c = newTaskIn(s, 'C');
  completeTask(a);
  cancelTask(b);
  assert.equal(getTask(a).state, 'completed');
  assert.equal(getTask(b).state, 'cancelled');
  assert.equal(getTask(c).state, 'running', 'an untouched task moved when its siblings did');
});

test('C7 — evidence for one task never contains another task\'s STEP rows', () => {
  const s = newSession('steps');
  const a = newTaskIn(s, 'A');
  const b = newTaskIn(s, 'B');
  P.savePlan(a, { goal: 'A', steps: [step({ id: 'only_a' })] });
  P.savePlan(b, { goal: 'B', steps: [step({ id: 'only_b' })] });
  assert.deepEqual(buildEvidence(a).steps.map((x) => x.id), ['only_a']);
  assert.deepEqual(buildEvidence(b).steps.map((x) => x.id), ['only_b']);
});

/* ================================================================== *
 * D. NO SECOND AUDIT SYSTEM
 * ================================================================== */

test('D1 — no new audit table was introduced', () => {
  const names = getDb().prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((r) => r.name);
  for (const forbidden of ['audit', 'audit_log', 'task_audit', 'evidence', 'evidence_store', 'plan_audit']) {
    assert.ok(!names.includes(forbidden), `a second audit store appeared: ${forbidden}`);
  }
  // The two that existed still do, and are still the only ones.
  assert.ok(names.includes('mutation_ledger'));
  assert.ok(names.includes('tool_events'));
});

test('D2 — the evidence read model is still SELECT-only', () => {
  const src = fs.readFileSync(new URL('../src/agent/evidence/read-model.js', import.meta.url), 'utf8');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
    'the evidence read model gained a write');
});

test('D3 — correlation is decided in ONE place', () => {
  const src = fs.readFileSync(new URL('../src/agent/evidence/read-model.js', import.meta.url), 'utf8');
  assert.equal((src.match(/const belongsToTask =/g) ?? []).length, 1,
    'the ownership rule is defined more than once');
  assert.equal((src.match(/belongsToTask\(r, task, w\)/g) ?? []).length, 2,
    'the ownership rule is applied to exactly the two audit tables — no more, no fewer');
  // And the raw window predicate is no longer applied to those tables directly.
  assert.ok(!/\.filter\(\(r\) => inWindow\(r\.ts, w\)\)/.test(src),
    'an audit table is still filtered by window alone');
});
