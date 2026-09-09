/**
 * PHASE 9 — RECOVERY, ATTACKED WITH AMBIGUITY.
 *
 *   node --test server/test/
 *
 * Every case below is one where the WRONG answer is tempting and the right one
 * is to stop. A 503 on a create looks retryable and is not. A timeout looks like
 * a failure and may be a success whose response was lost. A malformed result
 * looks like nothing happened and proves nothing at all.
 *
 * THE PROPERTY UNDER TEST is that the decision is always drawn from the closed
 * set — RETRY, REPLAN, STOP, WAIT_FOR_APPROVAL, MANUAL_INTERVENTION — and that
 * ambiguity resolves toward STOP rather than toward a new permissive path. A
 * decision this file cannot name is a decision somebody invented.
 *
 * UNKNOWN IS NEVER RETRYABLE. Neither an unknown failure kind nor an unknown
 * idempotency class may reach the execution surface, and both are asserted here
 * from several directions because it is the single rule that keeps a confused
 * system from making duplicates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p9rec-'));
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

/** The complete decision vocabulary. Anything outside it is an invented path. */
const DECISIONS = new Set(Object.values(R.DECISIONS));
const OUTCOMES = new Set(Object.values(R.OUTCOME));

let n = 0;
function newTask(goal = 'adversarial') {
  const sid = `p9rec-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const SYS = 'e'.repeat(32);
const seeRecord = (sessionId, sysId = SYS) => registerFromToolResult({
  sessionId, seq: 0, table: 'incident', result: { sys_id: sysId, short_description: 'before' },
});
const localTool = (name, spec) => { toolMap.set(name, { name, ...spec }); return () => toolMap.delete(name); };
const err = (status, message = 'the instance said no') => Object.assign(new Error(message), { status });
const describeUpdate = (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id });
const describeCreate = (i, r) => ({ operation: 'create', table: 'incident', requested: i, sys_id: r?.sys_id ?? null });

const step = (over = {}) => ({
  id: 'step_1',
  operation: over.operation ?? 'update the incident',
  capability: over.capability ?? 'record_update',
  tool: over.tool,
  mechanism: null,
  scope: null,
  mutating: over.mutating ?? true,
  target: over.target ?? { table: 'incident', sys_id: SYS },
  inputs: over.inputs ?? { table: 'incident', sys_id: SYS, data: { short_description: 'AFTER' } },
  depends_on: [],
  expected_effects: over.expected_effects ?? ['short_description becomes AFTER'],
  verification: 'verification' in over ? over.verification : { strategy: 'read_back', asserts: ['short_description == AFTER'] },
});

const readStep = (tool) => step({
  tool, mutating: false, capability: 'record_read',
  inputs: { table: 'incident', sys_id: SYS },
  expected_effects: [], verification: null,
});

async function runPlan(taskId, sessionId, steps, { readRecord = null, decide = true } = {}) {
  const saved = P.savePlan(taskId, { goal: 'g', steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  const res = await P.executePlan({
    taskId,
    sessionId,
    turnSeq: 1,
    recoverStep: (args) => R.recoverStep({ ...args, readRecord }),
    emit: (e) => {
      if (e.type === 'approval_required' && decide !== null) {
        setImmediate(() => resolveApproval(sessionId, e.approvalId, decide, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    },
  });
  return { res, plan: P.loadPlan(taskId), evidence: buildEvidence(taskId) };
}

/** Assert the decision is inside the closed vocabulary and never invented. */
function assertClosed(res, label) {
  const d = res.recovery?.decision?.decision;
  const o = res.recovery?.outcome;
  if (d !== undefined) assert.ok(DECISIONS.has(d), `${label}: invented decision "${d}"`);
  if (o !== undefined) assert.ok(OUTCOMES.has(o), `${label}: invented outcome "${o}"`);
}

/* ================================================================== *
 * A. AMBIGUOUS SERVER-SIDE OUTCOMES
 * ================================================================== */

test('X1 — 503 on a CREATE: the outcome is unknown, so it is never repeated', async () => {
  let calls = 0;
  const d = localTool('p9r_create503', {
    mutating: true, describeWrite: describeCreate,
    execute: async () => { calls += 1; throw err(503, 'Service Unavailable'); },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res } = await runPlan(taskId, sessionId, [step({
      tool: 'p9r_create503', capability: 'record_create',
      target: { table: 'incident', sys_id: null },
      inputs: { table: 'incident', data: { short_description: 'NEW' } },
      expected_effects: ['an incident exists'],
      verification: { strategy: 'read_back', asserts: ['short_description == NEW'] },
    })]);
    assert.equal(calls, 1, 'A CREATE WAS REPEATED after an ambiguous server failure');
    assert.equal(res.recovery.decision.idempotency, 'NON_IDEMPOTENT');
    assert.equal(res.recovery.decision.decision, R.DECISIONS.MANUAL_INTERVENTION);
    assertClosed(res, 'X1');
  } finally { d(); }
});

test('X2 — 503 on a READ: transient and safe, so it retries exactly once', async () => {
  let calls = 0;
  const d = localTool('p9r_read503', {
    mutating: false,
    execute: async () => { calls += 1; if (calls === 1) throw err(503); return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res } = await runPlan(taskId, sessionId, [readStep('p9r_read503')]);
    assert.equal(calls, 2);
    assert.equal(res.ok, true);
    assert.equal(res.results[0].recovery.decision.decision, R.DECISIONS.RETRY);
  } finally { d(); }
});

test('X3 — TIMEOUT after a possible mutation: refuses to repeat until reconciled', async () => {
  let calls = 0;
  const d = localTool('p9r_timeout', {
    mutating: true, describeWrite: describeUpdate,
    execute: async () => { calls += 1; throw err(408, 'Request Timeout'); },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    // No readRecord supplied: reconciliation is impossible.
    const { res } = await runPlan(taskId, sessionId, [step({ tool: 'p9r_timeout' })], { readRecord: null });
    assert.equal(calls, 1, 'a timed-out write was repeated without establishing whether it landed');
    assert.equal(res.recovery.decision.decision, R.DECISIONS.STOP);
    assert.match(res.recovery.decision.reason, /may already have taken effect/);
    assertClosed(res, 'X3');
  } finally { d(); }
});

test('X4 — TIMEOUT whose effect IS already present: not repeated, and said so', async () => {
  let calls = 0;
  const d = localTool('p9r_timeout_ok', {
    mutating: true, describeWrite: describeUpdate,
    execute: async () => { calls += 1; throw err(408); },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res } = await runPlan(taskId, sessionId, [step({ tool: 'p9r_timeout_ok' })], {
      readRecord: async () => ({ sys_id: SYS, short_description: 'AFTER' }),
    });
    assert.equal(calls, 1, 'an already-applied write was applied a second time');
    assert.equal(res.recovery.outcome, R.OUTCOME.ALREADY_SATISFIED);
    assertClosed(res, 'X4');
  } finally { d(); }
});

test('X5 — TIMEOUT whose reconciliation is UNKNOWN stops rather than guessing', async () => {
  let calls = 0;
  const d = localTool('p9r_timeout_unknown', {
    mutating: true, describeWrite: describeUpdate,
    execute: async () => { calls += 1; throw err(408); },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res } = await runPlan(taskId, sessionId, [step({ tool: 'p9r_timeout_unknown' })], {
      // The read itself fails: the effect is neither present nor absent.
      readRecord: async () => { throw new Error('the record could not be read'); },
    });
    assert.equal(calls, 1, 'a write was repeated while its effect was unestablished');
    assert.notEqual(res.recovery.decision.decision, R.DECISIONS.RETRY);
    assertClosed(res, 'X5');
  } finally { d(); }
});

test('X6 — a PARTIAL update is not silently completed by a retry', async () => {
  let calls = 0;
  const d = localTool('p9r_partial', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    // One of the two requested fields comes back; the other is dropped.
    execute: async (i) => { calls += 1; return { sys_id: i.sys_id, short_description: 'AFTER' }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res, evidence } = await runPlan(taskId, sessionId, [step({
      tool: 'p9r_partial',
      inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'AFTER', urgency: '1' } },
      expected_effects: ['short_description becomes AFTER', 'urgency becomes 1'],
      verification: { strategy: 'read_back', asserts: ['short_description == AFTER', 'urgency == 1'] },
    })]);
    assert.equal(evidence.changes[0].verification_status, 'partial');
    assert.equal(res.ok, false, 'a partial write was reported as a success');
    // A partial update is a VERIFICATION failure, which never auto-retries.
    const attempts = evidence.recovery.steps[0]?.attempts ?? [];
    assert.ok(attempts.every((a) => a.decision !== R.DECISIONS.RETRY),
      `a partial write was retried: ${JSON.stringify(attempts.map((a) => a.decision))}`);
    assert.equal(calls, 1);
  } finally { d(); }
});

/* ================================================================== *
 * B. MALFORMED AND MISSING EVIDENCE
 * ================================================================== */

test('X7 — a MALFORMED tool result proves nothing and is not treated as success', async () => {
  const shapes = [null, undefined, '', 'not json at all', 0, false, [], { unexpected: true }];
  for (const shape of shapes) {
    const d = localTool('p9r_malformed', {
      mutating: true, describeWrite: describeUpdate,
      execute: async () => shape,
    });
    try {
      const { taskId, sessionId } = newTask();
      seeRecord(sessionId);
      const { evidence } = await runPlan(taskId, sessionId, [step({ tool: 'p9r_malformed' })]);
      assert.notEqual(evidence.steps[0].verification_status, 'applied',
        `a ${JSON.stringify(shape)} result was verified as applied`);
      assert.notEqual(evidence.final.status, 'VERIFIED',
        `a ${JSON.stringify(shape)} result produced a VERIFIED run`);
    } finally { d(); }
  }
});

test('X8 — a MISSING descriptor makes idempotency UNKNOWN, and UNKNOWN never retries', async () => {
  let calls = 0;
  const d = localTool('p9r_nodesc', {
    mutating: true,   // mutating, but cannot describe its own write
    execute: async () => { calls += 1; throw err(503); },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res } = await runPlan(taskId, sessionId, [step({ tool: 'p9r_nodesc' })]);
    assert.equal(res.recovery.decision.idempotency, 'UNKNOWN');
    assert.notEqual(res.recovery.decision.decision, R.DECISIONS.RETRY);
    assert.equal(calls, 1, 'an operation with unknown repeat semantics was repeated');
    assertClosed(res, 'X8');
  } finally { d(); }
});

test('X9 — MISSING verification evidence does not become permission to retry', async () => {
  // Recovery is asked about a step with no evidence at all behind it.
  const { taskId, sessionId } = newTask();
  P.savePlan(taskId, { goal: 'g', steps: [step({ tool: null })] });
  P.setStepState(taskId, 'step_1', 'failed', { failure_reason: 'nothing is known about this' });
  let executed = 0;
  const out = await R.recoverStep({
    taskId, stepId: 'step_1', sessionId,
    error: null, descriptor: null,
    executeStep: async () => { executed += 1; return { ok: true }; },
  });
  assert.equal(executed, 0, 'recovery executed with no evidence to justify it');
  assert.ok(OUTCOMES.has(out.outcome), `invented outcome ${out.outcome}`);
  assert.notEqual(out.outcome, R.OUTCOME.RECOVERED);
});

test('X10 — an SDK / harness failure is not retried as though it were transport', async () => {
  for (const [name, message] of [
    ['p9r_sdk', 'the Fluent build failed: TS2304 cannot find name'],
    ['p9r_harness', 'the harness could not execute the script include'],
  ]) {
    let calls = 0;
    const d = localTool(name, {
      mutating: true, describeWrite: describeUpdate,
      execute: async () => { calls += 1; throw new Error(message); },
    });
    try {
      const { taskId, sessionId } = newTask();
      seeRecord(sessionId);
      const { res } = await runPlan(taskId, sessionId, [step({ tool: name })]);
      assert.equal(calls, 1, `${name} was retried`);
      assert.notEqual(res.recovery.decision.decision, R.DECISIONS.RETRY);
      assertClosed(res, name);
    } finally { d(); }
  }
});

/* ================================================================== *
 * C. THINGS THAT MUST NEVER START A RECOVERY AT ALL
 * ================================================================== */

test('X11 — a REJECTED approval never enters recovery', async () => {
  let calls = 0; let recoveries = 0;
  const d = localTool('p9r_rejected', {
    mutating: true, describeWrite: describeUpdate,
    execute: async (i) => { calls += 1; return { sys_id: i.sys_id }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const saved = P.savePlan(taskId, { goal: 'g', steps: [step({ tool: 'p9r_rejected' })] });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    const res = await P.executePlan({
      taskId, sessionId, turnSeq: 1,
      recoverStep: (args) => { recoveries += 1; return R.recoverStep(args); },
      emit: (e) => {
        if (e.type === 'approval_required') {
          setImmediate(() => resolveApproval(sessionId, e.approvalId, false, APPROVAL_SOURCES.USER_CLICK, e.nonce));
        }
      },
    });
    assert.equal(calls, 0);
    assert.equal(recoveries, 0, 'a refusal was handed to the recovery engine');
    assert.equal(res.recovery, null);
    assert.equal(buildEvidence(taskId).recovery.attempted, false);
  } finally { d(); }
});

test('X12 — a CANCELLED turn never starts a recovery attempt', async () => {
  const ctl = new AbortController();
  let calls = 0;
  const d = localTool('p9r_cancelled', {
    mutating: false,
    execute: async () => { calls += 1; ctl.abort(); throw err(503); },
  });
  try {
    const { taskId, sessionId } = newTask();
    const saved = P.savePlan(taskId, { goal: 'g', steps: [readStep('p9r_cancelled')] });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    const res = await P.executePlan({
      taskId, sessionId, turnSeq: 1, signal: ctl.signal,
      recoverStep: R.recoverStep, emit: () => {},
    });
    assert.equal(calls, 1, 'recovery retried after a cancellation');
    assert.equal(res.recovery.outcome, R.OUTCOME.STOPPED);
    assert.equal(res.recovery.reason, 'cancelled');
  } finally { d(); }
});

test('X13 — a STALE plan stops recovery before anything is re-attempted', async () => {
  let calls = 0;
  const d = localTool('p9r_stale', {
    mutating: false,
    execute: async () => { calls += 1; throw err(503); },
  });
  try {
    const { taskId, sessionId } = newTask();
    const saved = P.savePlan(taskId, { goal: 'g', steps: [readStep('p9r_stale')] });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    getDb().prepare('UPDATE agent_tasks SET plan_fingerprint = ? WHERE id = ?').run('0'.repeat(64), taskId);
    const res = await P.executePlan({
      taskId, sessionId, turnSeq: 1, recoverStep: R.recoverStep, emit: () => {},
    });
    assert.equal(calls, 0, 'a stale plan reached execution at all');
    assert.equal(res.reason, 'approval_stale');
  } finally { d(); }
});

/* ================================================================== *
 * D. BUDGETS
 * ================================================================== */

test('X14 — repeated failure exhausts the ATTEMPT budget and stops', async () => {
  let calls = 0;
  const d = localTool('p9r_always', {
    mutating: false,
    execute: async () => { calls += 1; throw err(503); },
  });
  try {
    const { taskId, sessionId } = newTask();
    const { res } = await runPlan(taskId, sessionId, [readStep('p9r_always')]);
    assert.equal(calls, R.LIMITS.MAX_ATTEMPTS,
      `MAX_ATTEMPTS is ${R.LIMITS.MAX_ATTEMPTS}; the tool ran ${calls} times`);
    assert.equal(res.ok, false);
    assert.equal(res.recovery.outcome, R.OUTCOME.NOT_RECOVERED);
  } finally { d(); }
});

test('X15 — the RECOVERY-STEP budget stops a step with a long lineage', async () => {
  const { taskId, sessionId } = newTask();
  P.savePlan(taskId, { goal: 'g', steps: [readStep(null)] });
  P.setStepState(taskId, 'step_1', 'failed', { failure_reason: 'boom' });
  // Fill the lineage to the limit, as many prior attempts would.
  for (let i = 0; i < R.LIMITS.MAX_RECOVERY_STEPS; i += 1) {
    P.recordRecoveryAttempt(taskId, 'step_1', { attempt: i, decision: 'RETRY', outcome: 'NOT_RECOVERED' });
  }
  let executed = 0;
  const out = await R.recoverStep({
    taskId, stepId: 'step_1', sessionId, error: { status: 503 },
    executeStep: async () => { executed += 1; return { ok: true }; },
  });
  assert.equal(executed, 0, 'the recovery budget was exceeded');
  assert.match(out.decision.reason, /budget_exhausted/);
  assert.equal(out.decision.decision, R.DECISIONS.STOP);
});

test('X16 — the REPLAN budget is bounded, and a re-plan never executes', async () => {
  const { taskId, sessionId } = newTask();
  P.savePlan(taskId, { goal: 'g', steps: [readStep(null)] });
  P.setStepState(taskId, 'step_1', 'failed', { failure_reason: 'boom' });
  for (let i = 0; i < R.LIMITS.MAX_REPLANS; i += 1) {
    P.recordRecoveryAttempt(taskId, 'step_1', { attempt: i, decision: 'REPLAN', outcome: 'STOPPED' });
  }
  let executed = 0;
  const out = await R.recoverStep({
    taskId, stepId: 'step_1', sessionId,
    error: { status: 400 },   // VALIDATION -> REPLAN
    executeStep: async () => { executed += 1; return { ok: true }; },
  });
  assert.equal(executed, 0, 'a re-plan executed something');
  assert.ok(DECISIONS.has(out.decision.decision));
  assert.notEqual(out.decision.decision, R.DECISIONS.RETRY);
});

/* ================================================================== *
 * E. THE CLOSED SET
 * ================================================================== */

test('X17 — every failure kind maps to a decision inside the closed set', () => {
  for (const kind of R.FAILURE_KINDS) {
    const policy = R.policyFor(kind);
    assert.ok(DECISIONS.has(policy.decision), `${kind} maps to the invented decision "${policy.decision}"`);
    // Only three kinds may act without a person, and all three are transport.
    if (policy.automatic === true) {
      assert.ok(['TRANSIENT', 'NETWORK', 'RATE_LIMITED'].includes(kind),
        `${kind} is automatic, which puts a non-transport failure on the unattended path`);
    }
  }
});

test('X18 — an unknown failure kind throws rather than falling through to a default', () => {
  for (const bogus of ['NOT_A_KIND', '', null, undefined, 'retry', 'RETRY']) {
    assert.throws(() => R.policyFor(bogus), undefined, `policyFor(${JSON.stringify(bogus)}) returned something`);
  }
});

test('X19 — UNKNOWN idempotency is never auto-retryable, from any direction', () => {
  assert.equal(R.isAutoRetryable('UNKNOWN'), false);
  assert.equal(R.isAutoRetryable('NON_IDEMPOTENT'), false);
  assert.equal(R.isAutoRetryable('READ_ONLY'), true);
  assert.equal(R.isAutoRetryable('IDEMPOTENT'), true);
  // And nothing outside the vocabulary sneaks through.
  for (const bogus of ['unknown', 'idempotent', '', null, undefined, true]) {
    assert.equal(R.isAutoRetryable(bogus), false, `${JSON.stringify(bogus)} was treated as retryable`);
  }
});

test('X20 — a create is NON_IDEMPOTENT however it is described', () => {
  for (const op of ['create', 'insert', 'CREATE', 'Insert']) {
    const v = R.classifyIdempotency({ tool: null, descriptor: { operation: op, table: 'incident' } });
    assert.equal(v.idempotency, 'NON_IDEMPOTENT', `operation "${op}" was not treated as a create`);
  }
  // Including when no tool name is supplied at all — the descriptor is enough.
  const v = R.classifyIdempotency({ descriptor: { operation: 'create', table: 'incident' } });
  assert.equal(v.idempotency, 'NON_IDEMPOTENT');
});

test('X21 — an update WITHOUT a sys_id is UNKNOWN, not idempotent', () => {
  const v = R.classifyIdempotency({ tool: 'update_record', descriptor: { operation: 'update', table: 'incident' } });
  assert.equal(v.idempotency, 'UNKNOWN', 'a query-shaped write was treated as safe to repeat');
});

test('X22 — every decision the engine can produce is representable, and none is permissive by default', () => {
  assert.deepEqual([...DECISIONS].sort(),
    ['MANUAL_INTERVENTION', 'REPLAN', 'RETRY', 'STOP', 'WAIT_FOR_APPROVAL']);
  // The policy table has one row per kind and no default branch.
  const src = fs.readFileSync(new URL('../src/agent/recovery/policy.js', import.meta.url), 'utf8');
  for (const kind of R.FAILURE_KINDS) {
    assert.ok(new RegExp(`^\\s{2}${kind}:`, 'm').test(src), `policy has no explicit row for ${kind}`);
  }
  assert.ok(!/default:/.test(src), 'the policy table has a default branch');
});
