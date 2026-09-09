/**
 * PHASE 7 — RECOVERY, WIRED INTO THE REAL PLAN EXECUTOR.
 *
 *   node --test server/test/
 *
 * Phase 6 built the Recovery Engine and deliberately left it disconnected. This
 * file is about the join: what happens when a real approved plan, running
 * through the real executor, hits a real step failure.
 *
 * THE QUESTION THIS PHASE ANSWERS IS NOT "how do we retry". It is "when is it
 * safe to retry, and what does the durable record say afterwards". So most of
 * these tests are about the cases where recovery correctly does NOTHING —
 * creates, permission failures, timeouts, cancellations, exhausted budgets —
 * and about whether the evidence tells the truth about a run that needed a
 * second attempt.
 *
 * THE SEAM IS EXERCISED, NOT SIMULATED. Every behavioural test below calls the
 * actual `executePlan` with the actual `recoverStep`, through the actual
 * approval gate, write guards and read-back verifier. The only injected things
 * are the tools themselves, which is how Phase 4's own suite works.
 *
 * Offline in full: scratch SQLite, local tool probes, no instance, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-rec-int-'));
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
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

let n = 0;
function newTask(goal = 'recover the thing') {
  const sid = `rec-int-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const SYS = 'a'.repeat(32);

/** A read step — READ_ONLY, the only class recovery may retry unattended. */
const readStep = (over = {}) => ({
  id: over.id ?? 'step_1',
  operation: over.operation ?? 'read the incident',
  capability: 'record_read',
  tool: over.tool ?? null,
  mechanism: null,
  scope: null,
  mutating: false,
  target: { table: 'incident', sys_id: SYS },
  inputs: over.inputs ?? { table: 'incident', sys_id: SYS },
  depends_on: over.depends_on ?? [],
  expected_effects: [],
  verification: null,
});

/** An update against a known sys_id — IDEMPOTENT. */
const updateStep = (over = {}) => ({
  id: over.id ?? 'step_1',
  operation: over.operation ?? 'update the incident',
  capability: 'record_update',
  tool: over.tool ?? null,
  mechanism: null,
  scope: null,
  mutating: true,
  target: { table: 'incident', sys_id: SYS },
  inputs: over.inputs ?? { table: 'incident', sys_id: SYS, data: { short_description: 'x' } },
  depends_on: over.depends_on ?? [],
  expected_effects: over.expected_effects ?? ['short_description is updated'],
  verification: { strategy: 'read_back', asserts: ['short_description == x'] },
});

/** A create — NON_IDEMPOTENT, the class that must never auto-repeat. */
const createStep = (over = {}) => ({
  id: over.id ?? 'step_1',
  operation: 'create an incident',
  capability: 'record_create',
  tool: over.tool ?? null,
  mechanism: null,
  scope: null,
  mutating: true,
  target: { table: 'incident', sys_id: null },
  inputs: { table: 'incident', data: { short_description: 'new' } },
  depends_on: [],
  expected_effects: ['an incident exists'],
  verification: { strategy: 'read_back', asserts: ['short_description == new'] },
});

function localTool(name, spec) {
  toolMap.set(name, { name, ...spec });
  return () => toolMap.delete(name);
}

/** An error shaped the way the ServiceNow client shapes one. */
function httpError(status, message = 'the instance said no') {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * Run a plan the whole way: save, approve against its own fingerprint, execute
 * through the REAL executor with the REAL recovery engine injected.
 *
 * `decide` may be a boolean or a function of the gate's ordinal, so a test can
 * approve the first attempt and reject the retry.
 */
async function runWithRecovery(taskId, sessionId, steps, {
  goal = 'recover the thing', autoApprove = false, decide = true,
  signal = null, readRecord = null, recoverStep = R.recoverStep, onEvent = () => {},
} = {}) {
  const saved = P.savePlan(taskId, { goal, steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  const events = [];
  let gate = 0;
  const res = await P.executePlan({
    taskId,
    sessionId,
    turnSeq: 1,
    autoApprove,
    signal,
    emit: (e) => {
      events.push(e);
      onEvent(e, events);
      if (e.type === 'approval_required' && decide !== null) {
        const answer = typeof decide === 'function' ? decide(gate += 1) : decide;
        setImmediate(() => resolveApproval(sessionId, e.approvalId, answer, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    },
    recoverStep: recoverStep ? ((args) => recoverStep({ ...args, readRecord })) : null,
  });
  return { res, events, fingerprint: saved.fingerprint, plan: P.loadPlan(taskId) };
}

const stepOf = (plan, id) => plan.steps.find((s) => s.id === id);

/**
 * Make the session have SEEN the record, so a write to it is not a
 * confabulation. This is the real provenance path, not a fixture: the guard
 * only trusts sys_ids that came back from a tool result.
 */
const seeRecord = (sessionId, sysId = SYS) => registerFromToolResult({
  sessionId, seq: 0, table: 'incident', result: { sys_id: sysId, short_description: 'x' },
});

/* ================================================================== *
 * A. THE SEAM ITSELF
 * ================================================================== */

test('A1 — a transient READ failure is retried through the real executor and the plan completes', async () => {
  let calls = 0;
  const drop = localTool('rec_read_flaky', {
    mutating: false,
    execute: async () => {
      calls += 1;
      if (calls === 1) throw httpError(503, 'Service Unavailable');
      return { ok: true, number: 'INC001' };
    },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res, plan } = await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_flaky' })]);
    assert.equal(calls, 2, 'the step was not re-executed');
    assert.equal(res.ok, true, `the plan did not recover: ${JSON.stringify(res)}`);
    assert.equal(plan.planState, 'completed');
    assert.equal(stepOf(plan, 'step_1').state, 'completed');
  } finally { drop(); }
});

test('A2 — the recovered step reports RECOVERED, and says what failed', async () => {
  let calls = 0;
  const drop = localTool('rec_read_flaky2', {
    mutating: false,
    execute: async () => { calls += 1; if (calls === 1) throw httpError(503); return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res } = await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_flaky2' })]);
    const r = res.results.find((x) => x.step === 'step_1');
    assert.equal(r.recovered, true);
    assert.equal(r.recovery.outcome, 'RECOVERED');
    assert.equal(r.recovery.decision.decision, 'RETRY');
    assert.equal(r.recovery.decision.failure.kind, 'TRANSIENT');
  } finally { drop(); }
});

test('A3 — WITHOUT an injected recoverer the behaviour is Phase 4, unchanged', async () => {
  let calls = 0;
  const drop = localTool('rec_read_flaky3', {
    mutating: false,
    execute: async () => { calls += 1; throw httpError(503); },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res, plan } = await runWithRecovery(taskId, sessionId,
      [readStep({ tool: 'rec_read_flaky3' })], { recoverStep: null });
    assert.equal(calls, 1, 'a step was retried with no recovery engine injected');
    assert.equal(res.ok, false);
    assert.equal(plan.planState, 'failed');
    assert.equal(res.recovery, null);
    assert.equal(res.replanRequired, false);
  } finally { drop(); }
});

test('A4 — the plan executor imports NOTHING from the recovery engine, and vice versa', () => {
  const src = read('agent/plan/executor.js');
  assert.ok(!/from\s+['"][^'"]*recovery/.test(src),
    'the plan executor reaches into recovery directly instead of taking it as a parameter');
  const rec = read('agent/recovery/executor.js');
  assert.ok(!/from\s+['"][^'"]*plan\/executor/.test(rec),
    'recovery imports the plan executor, so it can execute without being given a surface');
  assert.ok(!/executePlan/.test(rec), 'recovery names executePlan');
});

test('A5 — the two halves are joined in the ROUTE, the only place that knows both', () => {
  const route = read('routes/plan.js');
  assert.match(route, /from\s+'\.\.\/agent\/recovery\/index\.js'/);
  assert.match(route, /recoverStep:/, 'the route does not actually inject recovery');
});

test('A6 — the failed step hands its descriptor and structured error to the seam', () => {
  const src = read('agent/plan/executor.js');
  assert.match(src, /return \{ ok: false, state: 'failed', note, verification, descriptor \}/);
  assert.match(src, /error: \{ status: err\.status \?\? null/,
    'the error is flattened to prose, so the HTTP status recovery classifies on is lost');
});

/* ================================================================== *
 * B. THE RETRY GOES THROUGH THE SAME GATES
 * ================================================================== */

test('B1 — a retried MUTATION reaches the approval gate a SECOND time', async () => {
  let calls = 0;
  const drop = localTool('rec_write_flaky', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => {
      calls += 1;
      if (calls === 1) throw httpError(503);
      return { ok: true, sys_id: i.sys_id, short_description: 'x' };
    },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { events } = await runWithRecovery(taskId, sessionId, [updateStep({ tool: 'rec_write_flaky' })]);
    const gates = events.filter((e) => e.type === 'approval_required');
    assert.equal(gates.length, 2, 'the retry did not go back through the approval gate');
    // Two DIFFERENT nonces — the retry did not replay the first approval.
    assert.notEqual(gates[0].nonce, gates[1].nonce);
    assert.notEqual(gates[0].approvalId, gates[1].approvalId);
  } finally { drop(); }
});

test('B2 — a retry REJECTED at the gate does not execute again', async () => {
  let calls = 0;
  const drop = localTool('rec_write_reject', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => {
      calls += 1;
      if (calls === 1) throw httpError(503);
      return { ok: true, sys_id: i.sys_id, short_description: 'x' };
    },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    // Approve the first attempt; REFUSE the recovery retry.
    const { res, plan } = await runWithRecovery(taskId, sessionId,
      [updateStep({ tool: 'rec_write_reject' })], { decide: (nth) => nth === 1 });
    assert.equal(calls, 1, 'a rejected retry executed anyway');
    assert.equal(res.ok, false);
    assert.equal(stepOf(plan, 'step_1').state, 'failed');
  } finally { drop(); }
});

test('B3 — a retry still passes the confabulated-sys_id guard', async () => {
  let calls = 0;
  const drop = localTool('rec_write_unknown_target', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async () => { calls += 1; throw httpError(503); },
  });
  try {
    // A sys_id this session has NEVER seen.
    const { taskId, sessionId } = newTask();
    const { res } = await runWithRecovery(taskId, sessionId, [
      updateStep({
        tool: 'rec_write_unknown_target',
        inputs: { table: 'incident', sys_id: 'f'.repeat(32), data: { short_description: 'x' } },
      }),
    ]);
    assert.equal(calls, 0, 'a write ran against a sys_id the session never saw');
    assert.equal(res.ok, false);
    assert.match(res.note, /never appeared in this session/);
  } finally { drop(); }
});

test('B4 — the retry re-enters runStep, and the whole lifecycle is emitted', async () => {
  let calls = 0;
  const drop = localTool('rec_read_started', {
    mutating: false,
    execute: async () => { calls += 1; if (calls === 1) throw httpError(503); return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { events } = await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_started' })]);
    assert.equal(events.filter((e) => e.type === 'step_failed').length, 1);
    assert.equal(events.filter((e) => e.type === 'recovery_decision').length, 1);
    assert.equal(events.filter((e) => e.type === 'recovery_retry_started').length, 1);
    assert.equal(events.filter((e) => e.type === 'recovery_succeeded').length, 1);
    assert.equal(events.filter((e) => e.type === 'plan_completed').length, 1);
  } finally { drop(); }
});

test('B5 — exactly one terminal plan frame is emitted, recovered or not', async () => {
  const terminal = (evts) => evts.filter((e) => ['plan_completed', 'plan_failed', 'plan_cancelled'].includes(e.type));
  let calls = 0;
  const d1 = localTool('rec_term_ok', {
    mutating: false,
    execute: async () => { calls += 1; if (calls === 1) throw httpError(503); return { ok: true }; },
  });
  const d2 = localTool('rec_term_bad', { mutating: false, execute: async () => { throw httpError(403); } });
  try {
    const a = newTask();
    const ra = await runWithRecovery(a.taskId, a.sessionId, [readStep({ tool: 'rec_term_ok' })]);
    assert.equal(terminal(ra.events).length, 1, 'a recovered run emitted more than one terminal frame');

    const b = newTask();
    const rb = await runWithRecovery(b.taskId, b.sessionId, [readStep({ tool: 'rec_term_bad' })]);
    assert.equal(terminal(rb.events).length, 1, 'an unrecovered run emitted more than one terminal frame');
    assert.equal(terminal(rb.events)[0].type, 'plan_failed');
  } finally { d1(); d2(); }
});

/* ================================================================== *
 * C. THE CASES WHERE RECOVERY CORRECTLY DOES NOTHING
 * ================================================================== */

test('C1 — a CREATE is never automatically repeated, however transient the failure', async () => {
  let calls = 0;
  const drop = localTool('rec_create_flaky', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'create', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? null }),
    execute: async () => { calls += 1; throw httpError(503, 'Service Unavailable'); },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res, plan } = await runWithRecovery(taskId, sessionId, [createStep({ tool: 'rec_create_flaky' })]);
    assert.equal(calls, 1, 'A CREATE WAS REPEATED — this is how duplicate records are made');
    assert.equal(res.ok, false);
    assert.equal(plan.planState, 'failed');
    assert.equal(res.recovery.decision.decision, 'MANUAL_INTERVENTION');
    assert.equal(res.recovery.decision.idempotency, 'NON_IDEMPOTENT');
    assert.match(res.note, /NON_IDEMPOTENT/);
  } finally { drop(); }
});

test('C2 — an AUTHORIZATION failure is never retried', async () => {
  let calls = 0;
  const drop = localTool('rec_read_403', {
    mutating: false,
    execute: async () => { calls += 1; throw httpError(403, 'Forbidden'); },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res } = await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_403' })]);
    assert.equal(calls, 1, 'a permission failure was retried; it cannot succeed and it looks like an attack');
    assert.equal(res.recovery.decision.failure.kind, 'AUTHORIZATION');
    assert.notEqual(res.recovery.decision.decision, 'RETRY');
  } finally { drop(); }
});

test('C3 — an AUTHENTICATION failure is never retried either', async () => {
  let calls = 0;
  const drop = localTool('rec_read_401', {
    mutating: false,
    execute: async () => { calls += 1; throw httpError(401, 'Unauthorized'); },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res } = await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_401' })]);
    assert.equal(calls, 1, 'bad credentials were replayed');
    assert.equal(res.recovery.decision.failure.kind, 'AUTHENTICATION');
    assert.notEqual(res.recovery.decision.decision, 'RETRY');
  } finally { drop(); }
});

test('C4 — a VALIDATION failure is a re-plan, and a re-plan does not execute', async () => {
  let calls = 0;
  const drop = localTool('rec_read_400', {
    mutating: false,
    execute: async () => { calls += 1; throw httpError(400, 'Bad Request'); },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res, plan } = await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_400' })]);
    assert.equal(calls, 1, 'a re-plan silently executed something');
    assert.equal(res.recovery.decision.decision, 'REPLAN');
    assert.equal(res.replanRequired, true, 'the caller was not told a re-plan is needed');
    assert.equal(plan.planState, 'failed');
  } finally { drop(); }
});

test('C5 — replan_required is on the SSE frame as well as the return value', async () => {
  const drop = localTool('rec_read_400b', { mutating: false, execute: async () => { throw httpError(422); } });
  try {
    const { taskId, sessionId } = newTask();
    const { events } = await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_400b' })]);
    const failed = events.find((e) => e.type === 'plan_failed');
    assert.equal(failed.replanRequired, true);
    assert.equal(failed.recovery.decision, 'REPLAN');
    assert.equal(failed.recovery.failure, 'VALIDATION');
  } finally { drop(); }
});

test('C6 — a re-plan NEVER produces a new plan by itself', async () => {
  const drop = localTool('rec_read_400c', { mutating: false, execute: async () => { throw httpError(400); } });
  try {
    const { taskId, sessionId } = newTask();
    const { plan } = await runWithRecovery(taskId, sessionId, [
      readStep({ id: 'step_1', tool: 'rec_read_400c' }),
    ]);
    assert.equal(plan.steps.length, 1, 'recovery changed the plan shape on its own');
    assert.equal(plan.fingerprint, plan.approvedFingerprint,
      'the plan was rewritten under an approval that described the old one');
  } finally { drop(); }
});

test('C7 — a TIMEOUT on an update refuses to repeat until the effect is reconciled', async () => {
  let calls = 0;
  const drop = localTool('rec_write_timeout', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async () => { calls += 1; throw httpError(408, 'Request Timeout'); },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    // No readRecord supplied → no reconciliation is possible.
    const { res } = await runWithRecovery(taskId, sessionId,
      [updateStep({ tool: 'rec_write_timeout' })], { readRecord: null });
    assert.equal(calls, 1, 'a timed-out write was repeated without establishing whether it landed');
    assert.equal(res.recovery.decision.decision, 'STOP');
    assert.match(res.recovery.decision.reason, /may already have taken effect/);
  } finally { drop(); }
});

test('C8 — a TIMEOUT whose effect is ALREADY present is not repeated at all', async () => {
  let calls = 0;
  const drop = localTool('rec_write_timeout2', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async () => { calls += 1; throw httpError(408); },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res } = await runWithRecovery(taskId, sessionId, [updateStep({ tool: 'rec_write_timeout2' })], {
      // The write DID land; only the response was lost.
      readRecord: async () => ({ sys_id: SYS, short_description: 'x' }),
    });
    assert.equal(calls, 1, 'an already-applied write was applied a second time');
    assert.equal(res.recovery.outcome, 'ALREADY_SATISFIED');
    assert.match(res.recovery.decision.reason, /already_satisfied/);
  } finally { drop(); }
});

test('C9 — an UNKNOWN failure stops rather than guessing', async () => {
  let calls = 0;
  const drop = localTool('rec_read_weird', {
    mutating: false,
    execute: async () => { calls += 1; throw new Error('something with no taxonomy entry'); },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res } = await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_weird' })]);
    assert.equal(calls, 1);
    assert.equal(res.recovery.decision.decision, 'STOP');
    assert.equal(res.recovery.decision.failure.kind, 'UNKNOWN');
  } finally { drop(); }
});

test('C10 — a guard-blocked step is not "recovered" past the guard', async () => {
  let calls = 0;
  const drop = localTool('rec_blocked', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async () => { calls += 1; return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res } = await runWithRecovery(taskId, sessionId, [
      updateStep({ tool: 'rec_blocked', inputs: { table: 'incident', sys_id: 'e'.repeat(32), data: { short_description: 'x' } } }),
    ]);
    assert.equal(calls, 0, 'recovery talked a blocked write past the guard that blocked it');
    assert.equal(res.ok, false);
  } finally { drop(); }
});

/* ================================================================== *
 * D. BUDGET
 * ================================================================== */

test('D1 — a permanently failing read is retried ONCE and then stops', async () => {
  let calls = 0;
  const drop = localTool('rec_read_always503', {
    mutating: false,
    execute: async () => { calls += 1; throw httpError(503); },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res } = await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_always503' })]);
    assert.equal(calls, 2, `MAX_ATTEMPTS is ${R.LIMITS.MAX_ATTEMPTS}; the tool ran ${calls} times`);
    assert.equal(res.ok, false);
  } finally { drop(); }
});

test('D2 — the attempt limit is the one Phase 6 declared, not a number this layer invented', () => {
  assert.equal(R.LIMITS.MAX_ATTEMPTS, 2);
  const src = read('agent/plan/executor.js');
  assert.ok(!/MAX_ATTEMPTS|maxAttempts/.test(src), 'the plan executor has its own idea of the attempt limit');
});

test('D3 — the durable lineage records the recovery decision, with a timestamp', async () => {
  let calls = 0;
  const drop = localTool('rec_read_lineage', {
    mutating: false,
    execute: async () => { calls += 1; if (calls === 1) throw httpError(503); return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_lineage' })]);
    const history = P.recoveryHistory(taskId, 'step_1');
    assert.equal(history.attempts.length, 1);
    assert.equal(history.attempts[0].decision, 'RETRY');
    assert.equal(history.attempts[0].outcome, 'RECOVERED');
    assert.ok(history.attempts[0].at, 'the attempt has no timestamp');
  } finally { drop(); }
});

test('D4 — recovery is consulted ONCE per step failure, never recursively', async () => {
  // The retry's own failure does NOT re-enter recovery. That is what bounds the
  // whole mechanism: one decision per failed step, and the outcome of the retry
  // is the end of it. A recursive seam would turn MAX_ATTEMPTS into a
  // suggestion, because each failure would open a fresh budget.
  const drop = localTool('rec_read_two_fail', { mutating: false, execute: async () => { throw httpError(503); } });
  try {
    const { taskId, sessionId } = newTask();
    const { res } = await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_two_fail' })]);
    const history = P.recoveryHistory(taskId, 'step_1');
    assert.equal(history.attempts.length, 1,
      `recovery ran more than once for one failure: ${JSON.stringify(history.attempts)}`);
    assert.equal(history.attempts[0].decision, 'RETRY');
    assert.equal(history.attempts[0].outcome, 'NOT_RECOVERED');
    assert.equal(res.ok, false);
    assert.equal(res.recovery.outcome, 'NOT_RECOVERED');
  } finally { drop(); }
});

test('D4b — an attempt is APPENDED to the lineage, never overwritten', () => {
  const { taskId } = newTask();
  P.savePlan(taskId, { goal: 'g', steps: [readStep()] });
  P.recordRecoveryAttempt(taskId, 'step_1', { attempt: 1, decision: 'RETRY', outcome: 'NOT_RECOVERED' });
  P.recordRecoveryAttempt(taskId, 'step_1', { attempt: 2, decision: 'STOP', outcome: 'STOPPED' });
  const history = P.recoveryHistory(taskId, 'step_1');
  assert.equal(history.attempts.length, 2, 'a later attempt overwrote an earlier one');
  assert.deepEqual(history.attempts.map((a) => a.decision), ['RETRY', 'STOP']);
});

test('D5 — the lineage survives a reload: it is on the row, not in memory', async () => {
  let calls = 0;
  const drop = localTool('rec_read_durable', {
    mutating: false,
    execute: async () => { calls += 1; if (calls === 1) throw httpError(503); return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_durable' })]);
    const raw = getDb().prepare('SELECT metadata_json FROM agent_task_steps WHERE task_id = ? AND plan_step_id = ?')
      .get(taskId, 'step_1');
    const parsed = JSON.parse(raw.metadata_json);
    assert.equal(parsed.recovery.attempts.length, 1);
    assert.equal(parsed.recovery.attempts[0].decision, 'RETRY');
  } finally { drop(); }
});

/* ================================================================== *
 * E. CANCELLATION — PHASE 0, HONOURED
 * ================================================================== */

test('E1 — a cancelled run starts NO recovery attempt', async () => {
  const controller = new AbortController();
  let calls = 0;
  const drop = localTool('rec_read_cancel', {
    mutating: false,
    execute: async () => { calls += 1; controller.abort(); throw httpError(503); },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res } = await runWithRecovery(taskId, sessionId,
      [readStep({ tool: 'rec_read_cancel' })], { signal: controller.signal });
    assert.equal(calls, 1, 'recovery retried after the run was cancelled');
    assert.equal(res.ok, false);
    assert.equal(res.recovery.outcome, 'STOPPED');
    assert.equal(res.recovery.reason, 'cancelled');
  } finally { drop(); }
});

test('E2 — the cancellation is recorded as a cancellation, not as a failure of the step', async () => {
  const controller = new AbortController();
  const drop = localTool('rec_read_cancel2', {
    mutating: false,
    execute: async () => { controller.abort(); throw httpError(503); },
  });
  try {
    const { taskId, sessionId } = newTask();
    await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_cancel2' })], { signal: controller.signal });
    const history = P.recoveryHistory(taskId, 'step_1');
    assert.equal(history.attempts[0].decision, 'STOP');
    assert.match(history.attempts[0].reason, /cancelled/);
  } finally { drop(); }
});

test('E3 — a mid-flight tool is never interrupted by recovery', () => {
  // Phase 0's rule restated on this seam: recovery checks the signal exactly
  // once, at its own entry, before it decides anything.
  const src = read('agent/recovery/executor.js');
  assert.equal((src.match(/signal\?\.aborted/g) ?? []).length, 1,
    'recovery checks the abort signal in more than one place');
  assert.ok(!/\.abort\(\)/.test(src), 'recovery aborts something');
});

/* ================================================================== *
 * F. APPROVAL BINDING
 * ================================================================== */

test('F1 — a retry is refused when the plan changed after approval', async () => {
  let calls = 0;
  let target = null;
  const drop = localTool('rec_read_stale', {
    mutating: false,
    execute: async () => {
      calls += 1;
      if (calls === 1) {
        // The plan is edited underneath, exactly as a re-plan would edit it.
        getDb().prepare('UPDATE agent_tasks SET plan_fingerprint = ? WHERE id = ?').run('0'.repeat(64), target);
        throw httpError(503);
      }
      return { ok: true };
    },
  });
  try {
    const { taskId, sessionId } = newTask();
    target = taskId;
    const { res } = await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_stale' })]);
    assert.equal(calls, 1, 'a step was re-executed under an approval that no longer describes the plan');
    assert.equal(res.ok, false);
  } finally { drop(); }
});

test('F2 — the binding is re-checked INSIDE recovery, not only by the plan loop', () => {
  const src = read('agent/recovery/executor.js');
  assert.match(src, /checkApprovalBinding\(taskId\)/,
    'recovery does not re-check the approval binding before handing a step back for execution');
});

test('F3 — the plan loop still re-checks the binding before every step', () => {
  const src = read('agent/plan/executor.js');
  assert.match(src, /checkApprovalBinding\(taskId\)/);
});

/* ================================================================== *
 * G. VERIFICATION IS AUTHORITATIVE
 * ================================================================== */

test('G1 — a retry that executes but does NOT verify is not a recovery', async () => {
  let calls = 0;
  const drop = localTool('rec_write_noverify', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => {
      calls += 1;
      if (calls === 1) throw httpError(503);
      // The silent-drop shape: 200, a record back, and `short_description`
      // simply not in it. The read-back calls that a no-op.
      return { sys_id: i.sys_id, number: 'INC0010001' };
    },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res, plan } = await runWithRecovery(taskId, sessionId, [updateStep({ tool: 'rec_write_noverify' })]);
    assert.equal(calls, 2, 'the retry did not run');
    assert.equal(res.ok, false, 'an unverified retry was reported as a success');
    assert.equal(stepOf(plan, 'step_1').state, 'failed');
  } finally { drop(); }
});

test('G2 — recovery reads the executor\'s verdict rather than forming its own', () => {
  const src = read('agent/recovery/executor.js');
  assert.match(src, /const recovered = result\?\.ok === true;/);
});

test('G3 — a failed step only becomes completed through the real execution path', async () => {
  let calls = 0;
  const drop = localTool('rec_read_becomes_ok', {
    mutating: false,
    execute: async () => { calls += 1; if (calls === 1) throw httpError(503); return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { plan } = await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_read_becomes_ok' })]);
    const s = stepOf(plan, 'step_1');
    assert.equal(s.state, 'completed');
    assert.ok(s.startedAt && s.completedAt, 'the retried step has no execution timestamps');
  } finally { drop(); }
});

/* ================================================================== *
 * H. THE REOPEN — THE ONE HOLE IN A CLOSED TABLE
 * ================================================================== */

test('H1 — setStepState still refuses failed -> anything', () => {
  const { taskId } = newTask();
  P.savePlan(taskId, { goal: 'g', steps: [readStep()] });
  P.setStepState(taskId, 'step_1', 'failed', { failure_reason: 'x' });
  for (const to of ['pending', 'ready', 'executing', 'completed', 'verifying']) {
    const r = P.setStepState(taskId, 'step_1', to);
    assert.equal(r.ok, false, `setStepState allowed failed -> ${to}`);
    assert.equal(r.reason, 'illegal_transition');
  }
});

test('H2 — reopenStepForRecovery is the only exit, and only from failed', () => {
  const { taskId } = newTask();
  P.savePlan(taskId, { goal: 'g', steps: [readStep()] });
  const early = P.reopenStepForRecovery(taskId, 'step_1');
  assert.equal(early.ok, false);
  assert.equal(early.reason, 'not_failed');

  P.setStepState(taskId, 'step_1', 'failed', { failure_reason: 'x' });
  const ok = P.reopenStepForRecovery(taskId, 'step_1', { reason: 'TRANSIENT' });
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.from, ok.to], ['failed', 'pending']);
});

test('H3 — reopening keeps the failed attempt on the record', () => {
  const { taskId } = newTask();
  P.savePlan(taskId, { goal: 'g', steps: [readStep()] });
  P.setStepState(taskId, 'step_1', 'failed', { failure_reason: 'the instance said no' });
  P.reopenStepForRecovery(taskId, 'step_1');
  const row = getDb().prepare(
    'SELECT failure_reason, state FROM agent_task_steps WHERE task_id = ? AND plan_step_id = ?',
  ).get(taskId, 'step_1');
  assert.equal(row.state, 'pending');
  assert.equal(row.failure_reason, 'the instance said no', 'reopening erased why it failed');
});

test('H4 — reopening a step that does not exist is refused, not created', () => {
  const { taskId } = newTask();
  const r = P.reopenStepForRecovery(taskId, 'nope');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_such_step');
});

test('H5 — exactly one module CALLS the reopen, and it is not the plan executor', () => {
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(SRC, full).replace(/\\/g, '/');
      const body = fs.readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')        // block comments
        .replace(/\/\/[^\n]*/g, '')              // line comments
        .replace(/export function reopenStepForRecovery\s*\(/, '')   // the definition
        .replace(/^\s*reopenStepForRecovery,\s*$/gm, '');            // the re-export
      if (/reopenStepForRecovery\s*\(/.test(body)) callers.push(rel);
    }
  };
  walk(SRC);
  assert.deepEqual(callers.sort(), ['agent/recovery/executor.js'],
    `the audited reopen is called from somewhere unexpected: ${callers.join(', ')}`);
  // Specifically: the plan executor must not be able to reopen its own failures.
  assert.ok(!/reopenStepForRecovery/.test(read('agent/plan/executor.js')));
});

test('H6 — the step transition table itself is unchanged', () => {
  const src = read('agent/plan/states.js');
  assert.match(src, /failed: \[\],/, 'a failed step was given legal transitions in the table');
});

/* ================================================================== *
 * I. DEFENCE IN DEPTH
 * ================================================================== */

test('I1 — the execution boundary refuses anything not auto-retryable', () => {
  const src = read('agent/recovery/executor.js');
  assert.match(src, /if \(!isAutoRetryable\(decision\.idempotency\)\)/,
    'nothing re-checks the idempotency class at the point of execution');
  // And it sits BEFORE the executeStep call, not after.
  assert.ok(src.indexOf('isAutoRetryable(decision.idempotency)') < src.indexOf('await executeStep('),
    'the boundary check runs after the retry has already executed');
});

test('I2 — the boundary reads the decision, it does not re-derive the class', () => {
  const src = read('agent/recovery/executor.js');
  assert.ok(!/classifyIdempotency/.test(src),
    'the executor re-implements the idempotency question instead of reading the decision');
});

test('I3 — no NON_IDEMPOTENT operation ever reaches the execution surface', async () => {
  let executed = 0;
  const { taskId, sessionId } = newTask();
  P.savePlan(taskId, { goal: 'g', steps: [createStep()] });
  P.setStepState(taskId, 'step_1', 'failed', { failure_reason: 'boom' });
  const res = await R.recoverStep({
    taskId,
    stepId: 'step_1',
    sessionId,
    error: { status: 503 },
    descriptor: { operation: 'create', table: 'incident', fields: { short_description: 'new' } },
    executeStep: async () => { executed += 1; return { ok: true }; },
  });
  assert.equal(executed, 0, 'a create reached the execution surface');
  assert.notEqual(res.outcome, 'RECOVERED');
  assert.equal(res.decision.idempotency, 'NON_IDEMPOTENT');
});

test('I4 — recovery refuses when no execution surface was supplied', async () => {
  const { taskId, sessionId } = newTask();
  P.savePlan(taskId, { goal: 'g', steps: [readStep()] });
  P.setStepState(taskId, 'step_1', 'failed', { failure_reason: 'boom' });
  const res = await R.recoverStep({ taskId, stepId: 'step_1', sessionId, error: { status: 503 }, executeStep: null });
  assert.notEqual(res.outcome, 'RECOVERED');
  assert.equal(res.reason, 'no_executor');
});

/* ================================================================== *
 * J. EVIDENCE
 * ================================================================== */

test('J1 — a recovered run carries a recovery section that names the attempt', async () => {
  let calls = 0;
  const drop = localTool('rec_ev_ok', {
    mutating: false,
    execute: async () => { calls += 1; if (calls === 1) throw httpError(503); return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_ev_ok' })]);
    const ev = buildEvidence(taskId);
    assert.equal(ev.recovery.attempted, true);
    assert.equal(ev.recovery.recoveredSteps, 1);
    assert.equal(ev.recovery.unrecoveredSteps, 0);
    const s = ev.recovery.steps[0];
    assert.equal(s.step, 'step_1');
    assert.equal(s.recovered, true);
    assert.equal(s.retried, true);
    assert.equal(s.finalState, 'completed');
    assert.equal(s.attempts[0].failure, 'TRANSIENT');
    assert.equal(s.attempts[0].source, 'recovery_attempt');
  } finally { drop(); }
});

test('J2 — a run with no failures has an EMPTY recovery section, not a zeroed one', async () => {
  const drop = localTool('rec_ev_clean', { mutating: false, execute: async () => ({ ok: true }) });
  try {
    const { taskId, sessionId } = newTask();
    await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_ev_clean' })]);
    const ev = buildEvidence(taskId);
    assert.equal(ev.recovery.attempted, false);
    assert.deepEqual(ev.recovery.steps, []);
    assert.match(ev.recovery.note, /No recovery was attempted/);
  } finally { drop(); }
});

test('J3 — an UNRECOVERED failure appears as an uncertainty', async () => {
  const drop = localTool('rec_ev_bad', { mutating: false, execute: async () => { throw httpError(503); } });
  try {
    const { taskId, sessionId } = newTask();
    await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_ev_bad' })]);
    const ev = buildEvidence(taskId);
    const u = ev.uncertainties.find((x) => x.kind === 'unrecovered_failure');
    assert.ok(u, `no unrecovered_failure uncertainty: ${JSON.stringify(ev.uncertainties)}`);
    assert.equal(u.step, 'step_1');
    assert.match(u.note, /TRANSIENT/);
    assert.equal(ev.recovery.recoveredSteps, 0);
    assert.equal(ev.recovery.unrecoveredSteps, 1);
  } finally { drop(); }
});

test('J4 — a SUCCESSFUL retry still records that the operation ran more than once', async () => {
  let calls = 0;
  const drop = localTool('rec_ev_twice', {
    mutating: false,
    execute: async () => { calls += 1; if (calls === 1) throw httpError(503); return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_ev_twice' })]);
    const ev = buildEvidence(taskId);
    const u = ev.uncertainties.find((x) => x.kind === 'repeated_mutation');
    assert.ok(u, 'a run that reached the instance twice reads as though it happened once');
    assert.match(u.note, /more than once/);
  } finally { drop(); }
});

test('J5 — PHASE 5 remains the authority on the final status', async () => {
  const drop = localTool('rec_ev_final', { mutating: false, execute: async () => { throw httpError(503); } });
  try {
    const { taskId, sessionId } = newTask();
    await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_ev_final' })]);
    const ev = buildEvidence(taskId);
    assert.equal(ev.final.status, 'FAILED', 'a run whose recovery failed was not reported as FAILED');
    const src = read('agent/evidence/status.js');
    assert.ok(!/recover/i.test(src), 'the status decider knows about recovery');
  } finally { drop(); }
});

test('J6 — a recovered run reaches its ordinary final status, with no upgrade path', async () => {
  let calls = 0;
  const drop = localTool('rec_ev_final_ok', {
    mutating: false,
    execute: async () => { calls += 1; if (calls === 1) throw httpError(503); return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_ev_final_ok' })]);
    const ev = buildEvidence(taskId);
    assert.notEqual(ev.final.status, 'FAILED');
    const builder = read('agent/evidence/builder.js');
    assert.ok(!/recovery[^\n]*\?\s*STATUS\./.test(builder), 'the builder upgrades a status because of recovery');
  } finally { drop(); }
});

test('J7 — recovery evidence carries no credentials', async () => {
  const drop = localTool('rec_ev_secret', {
    mutating: false,
    execute: async () => {
      throw httpError(503, 'failed with Authorization: Basic YWRtaW46aHVudGVyMg== and password=hunter2');
    },
  });
  try {
    const { taskId, sessionId } = newTask();
    await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_ev_secret' })]);
    const ev = buildEvidence(taskId);
    const { findSecrets } = await import('../src/agent/evidence/redact.js');
    assert.deepEqual(findSecrets(ev.recovery), [],
      `the recovery section carries a credential: ${JSON.stringify(findSecrets(ev.recovery))}`);
    const blob = JSON.stringify(ev.recovery);
    assert.ok(!blob.includes('YWRtaW46aHVudGVyMg=='), 'a serialised Basic credential survived');
    assert.match(blob, /Basic \[redacted\]/, 'the auth header was not redacted at all');
    /*
     * NOTE, deliberately not asserted as absent: a bare `password=hunter2`
     * inside a free-text error message is NOT removed. That is Phase 5's stated
     * boundary — value-sniffing was considered and rejected there because a
     * "looks like a token" regex redacts every sys_id — and it applies to step
     * results and tool events exactly as it applies here. Phase 7 holds the new
     * section to the existing contract rather than quietly widening it.
     */
  } finally { drop(); }
});

test('J8 — the evidence endpoint carries recovery; no second API was added', () => {
  const routes = fs.readdirSync(path.join(SRC, 'routes'));
  assert.ok(!routes.some((f) => /recovery/i.test(f)), `a recovery route appeared: ${routes.join(', ')}`);
  // The section rides the existing evidence object, which the existing route returns.
  const builder = read('agent/evidence/builder.js');
  assert.match(builder, /recovery,/);
});

/* ================================================================== *
 * K. THE REST OF THE PLAN
 * ================================================================== */

test('K1 — steps after a RECOVERED step still run', async () => {
  let calls = 0;
  const ran = [];
  const d1 = localTool('rec_k_flaky', {
    mutating: false,
    execute: async () => { calls += 1; ran.push('one'); if (calls === 1) throw httpError(503); return { ok: true }; },
  });
  const d2 = localTool('rec_k_after', {
    mutating: false,
    execute: async () => { ran.push('two'); return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res, plan } = await runWithRecovery(taskId, sessionId, [
      readStep({ id: 'step_1', tool: 'rec_k_flaky' }),
      readStep({ id: 'step_2', tool: 'rec_k_after', depends_on: ['step_1'] }),
    ]);
    assert.deepEqual(ran, ['one', 'one', 'two']);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(plan.steps.every((s) => s.state === 'completed'));
  } finally { d1(); d2(); }
});

test('K2 — steps after an UNRECOVERED step are skipped, not attempted', async () => {
  const ran = [];
  const d1 = localTool('rec_k_dead', {
    mutating: false,
    execute: async () => { ran.push('one'); throw httpError(403); },
  });
  const d2 = localTool('rec_k_never', {
    mutating: false,
    execute: async () => { ran.push('two'); return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res, plan } = await runWithRecovery(taskId, sessionId, [
      readStep({ id: 'step_1', tool: 'rec_k_dead' }),
      readStep({ id: 'step_2', tool: 'rec_k_never', depends_on: ['step_1'] }),
    ]);
    assert.deepEqual(ran, ['one']);
    assert.equal(res.ok, false);
    assert.equal(stepOf(plan, 'step_2').state, 'skipped');
  } finally { d1(); d2(); }
});

test('K3 — a recovered step does not re-run the steps before it', async () => {
  const ran = [];
  let calls = 0;
  const d1 = localTool('rec_k_first', {
    mutating: false,
    execute: async () => { ran.push('first'); return { ok: true }; },
  });
  const d2 = localTool('rec_k_second', {
    mutating: false,
    execute: async () => { calls += 1; ran.push('second'); if (calls === 1) throw httpError(503); return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    await runWithRecovery(taskId, sessionId, [
      readStep({ id: 'step_1', tool: 'rec_k_first' }),
      readStep({ id: 'step_2', tool: 'rec_k_second', depends_on: ['step_1'] }),
    ]);
    assert.deepEqual(ran, ['first', 'second', 'second'], 'recovery re-ran an already-completed step');
  } finally { d1(); d2(); }
});

/* ================================================================== *
 * L. NO NEW SURFACE
 * ================================================================== */

test('L1 — PHASE 7 added no migration of its own', () => {
  /*
   * Phase 7 needed none: recovery lineage rides `agent_task_steps.metadata_json`,
   * which already existed. Phase 8 later appended migration 23 for a defect this
   * phase did not cause (audit rows carrying no task id), so the head version
   * moved. What this guard still asserts is the thing it was written for —
   * recovery lineage costs no schema.
   */
  const row = getDb().prepare('PRAGMA user_version').get();
  assert.ok(Object.values(row)[0] >= 22);
  const src = read('agent/recovery/executor.js') + read('agent/plan/store.js');
  assert.ok(!/ALTER TABLE|CREATE TABLE/i.test(src),
    'the recovery layer grew a schema change');
  assert.match(read('agent/plan/store.js'), /metadata_json/,
    'recovery lineage no longer rides the existing metadata column');
});

test('L2 — recovery reuses the existing SSE stream and adds no transport', () => {
  const src = read('agent/recovery/executor.js');
  assert.ok(!/res\.write|EventSource|text\/event-stream/.test(src), 'recovery writes to a transport directly');
  assert.match(src, /emit\(\{/, 'recovery does not use the existing emit surface');
});

test('L3 — recovery builds no second mutation path', () => {
  const dir = path.join(SRC, 'agent', 'recovery');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    /*
     * The line is between REUSING a pure function and OWNING a connection.
     * `write-verify.js` is the read-back differ — a comparison over two plain
     * objects, and reconciliation is supposed to reuse it rather than grow a
     * second idea of what "already applied" means. `client.js` is the thing
     * that can talk to an instance, and nothing here may import it.
     */
    const imports = (src.match(/^import .*$/gm) ?? []).join(' ');
    assert.ok(!/servicenow\/client|snowFetch/.test(imports), `${f} imports a ServiceNow client`);
    assert.ok(!/await fetch\(|fetch\(/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
      `${f} performs its own HTTP`);
    assert.ok(!/recoveryRetryTool|recoveryMutation|recoveryHttp/.test(src), `${f} defines a parallel execution verb`);
  }
});

test('L4 — the plan executor gained exactly one new parameter, with a safe default', () => {
  const src = read('agent/plan/executor.js');
  const from = src.indexOf('export async function executePlan');
  const head = src.slice(from, src.indexOf('} = {}) {', from));
  assert.match(head, /recoverStep = null/, 'recovery is not injected with a safe default');
  assert.equal((head.match(/=\s*null\b/g) ?? []).length, 2,
    'more executor parameters were added than this phase intended');
});

test('L5 — the recovery engine still exports exactly what Phase 6 declared, plus nothing new', () => {
  for (const name of ['recoverStep', 'decideRecovery', 'classifyFailure', 'policyFor', 'DECISIONS', 'LIMITS', 'OUTCOME']) {
    assert.ok(name in R, `${name} disappeared from the recovery engine`);
  }
});

/* ================================================================== *
 * M. SAFETY INVARIANTS, STATED AS TESTS
 * ================================================================== */

test('M1 — recovery never changes the payload it retries', async () => {
  const seen = [];
  let calls = 0;
  const drop = localTool('rec_m_payload', {
    mutating: false,
    execute: async (i) => {
      calls += 1;
      seen.push(JSON.stringify(i));
      if (calls === 1) throw httpError(503);
      return { ok: true };
    },
  });
  try {
    const { taskId, sessionId } = newTask();
    await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_m_payload' })]);
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1], 'the retry sent a DIFFERENT payload — that is a re-plan, not a retry');
  } finally { drop(); }
});

test('M2 — recovery never invents a tool that is not in the registry', async () => {
  const { taskId, sessionId } = newTask();
  const { res } = await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_does_not_exist' })]);
  assert.equal(res.ok, false);
  assert.match(res.note, /not in the registry/);
});

test('M3 — confidence is never used as authorisation anywhere on this seam', () => {
  for (const f of ['agent/plan/executor.js', 'agent/recovery/executor.js', 'agent/recovery/decision.js']) {
    assert.ok(!/confidence\s*[><]=?/.test(read(f)), `${f} branches on a confidence score`);
  }
});

test('M4 — no model is consulted anywhere on the recovery path', () => {
  const dir = path.join(SRC, 'agent', 'recovery');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/callProvider|runTurn|providers\//.test(src), `${f} calls a model`);
  }
});

test('M5 — the recovery decision is deterministic: no clock, no randomness', () => {
  const dir = path.join(SRC, 'agent', 'recovery');
  for (const f of ['classification.js', 'decision.js', 'policy.js', 'idempotency.js', 'reconcile.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/Math\.random|Date\.now\(\)|new Date\(\)/.test(src), `${f} is not deterministic`);
  }
});

test('M6 — the same failure decided twice gives the same answer', async () => {
  const drop = localTool('rec_m_det', { mutating: false, execute: async () => { throw httpError(503); } });
  try {
    const { taskId, sessionId } = newTask();
    await runWithRecovery(taskId, sessionId, [readStep({ tool: 'rec_m_det' })]);
    const ev = buildEvidence(taskId);
    const a = R.decideRecovery({ evidence: ev, stepId: 'step_1', error: { status: 503 } });
    const b = R.decideRecovery({ evidence: ev, stepId: 'step_1', error: { status: 503 } });
    assert.deepEqual(a, b);
  } finally { drop(); }
});

test('M7 — the executor never fabricates an approval on the retry path', () => {
  const src = read('agent/plan/executor.js');
  assert.ok(!/approved:\s*true/.test(src), 'the executor fabricates an approval');
  assert.match(src, /executeTool\(/, 'the executor no longer goes through the gated tool runner');
});

test('M8 — RECOVERED is the only outcome that continues the plan', () => {
  const src = read('agent/plan/executor.js');
  assert.match(src, /recovery\.outcome === 'RECOVERED'/);
  // Exactly one `continue` in the recovery branch; everything else falls
  // through to the single failure path below it.
  const branch = src.slice(src.indexOf('if (!outcome.ok && recoverStep'), src.indexOf('if (!outcome.ok) {\n      // No automatic'));
  assert.equal((branch.match(/\bcontinue;/g) ?? []).length, 1,
    'more than one recovery outcome lets the plan carry on');
});

test('M9 — a recovery that needs a human ends the run rather than parking it', () => {
  const src = read('agent/plan/executor.js');
  // The plan must reach a terminal state; `awaiting_approval` is non-terminal
  // and nothing in this phase resumes it.
  assert.ok(!/setPlanState\(taskId, 'awaiting_approval'\)/.test(src.slice(src.indexOf('recoverStep &&'))),
    'a plan is parked in a non-terminal state with nothing to resume it');
  assert.match(src, /const terminal = outcome\.state === 'cancelled' \? 'cancelled' : 'failed';/);
});

test('M10 — every one of the five decisions is representable at the seam', () => {
  assert.deepEqual(Object.keys(R.DECISIONS).sort(),
    ['MANUAL_INTERVENTION', 'REPLAN', 'RETRY', 'STOP', 'WAIT_FOR_APPROVAL']);
  for (const d of Object.values(R.DECISIONS)) assert.equal(typeof d, 'string');
});

test('M11 — a REJECTED step is never handed to recovery', async () => {
  /*
   * A person looked at the card and said no. That is not a failure, and putting
   * the same card back in front of them is a refusal being re-asked until it
   * changes. `runStep` reports a rejection as `failed` with `rejected: true`,
   * so the seam has to exclude it by name.
   */
  let calls = 0;
  let decisions = 0;
  const drop = localTool('rec_m_rejected', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => { calls += 1; return { sys_id: i.sys_id, short_description: 'x' }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res, events } = await runWithRecovery(taskId, sessionId,
      [updateStep({ tool: 'rec_m_rejected' })], {
        decide: false,
        onEvent: (e) => { if (e.type === 'recovery_decision') decisions += 1; },
      });
    assert.equal(calls, 0, 'a rejected write executed');
    assert.equal(decisions, 0, 'recovery was consulted about a refusal');
    assert.equal(events.filter((e) => e.type === 'approval_required').length, 1,
      'the user was asked a second time after saying no');
    assert.equal(res.ok, false);
    assert.equal(res.recovery, null, 'a rejection was dressed up as a recovery outcome');
    assert.equal(P.recoveryHistory(taskId, 'step_1').attempts.length, 0);
  } finally { drop(); }
});

test('M12 — a CANCELLED step is never handed to recovery either', () => {
  // Phase 0 gives cancellation its own state, so the seam excludes it by state
  // rather than by name. Both exclusions are visible in one condition.
  const src = read('agent/plan/executor.js');
  assert.match(src, /outcome\.state === 'failed' && !outcome\.rejected/,
    'the seam does not exclude rejections and cancellations from recovery');
});
