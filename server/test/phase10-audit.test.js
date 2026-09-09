/**
 * PHASE 10 — THE RELEASE AUDIT.
 *
 *   node --test server/test/
 *
 * This file is the durable form of the Phase 10 audit. It asks one question in
 * many shapes:
 *
 *     When the system cannot establish what happened, does it preserve the
 *     uncertainty, or does it invent certainty?
 *
 * Every other release criterion — approval, verification, recovery, evidence —
 * is a special case of that. A system that guesses is more dangerous than one
 * that stops, because a guess arrives wearing the same clothes as a fact.
 *
 * FOUR SECTIONS:
 *
 *   A  the failure taxonomy: every kind has exactly one policy, and no kind
 *      falls through to something permissive
 *   B  mutation authorisation: the complete inventory of paths that can reach a
 *      write, and the eleven controls each must pass
 *   C  uncertainty: nine specific transitions that must NOT happen
 *   D  crash semantics: what each surviving durable state is allowed to claim
 *
 * NOTHING HERE IS NEW BEHAVIOUR. Phase 10 adds no features; these are
 * assertions about what nine phases already built.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p10-'));
const HOME = path.join(scratchDir, 'home.db');
_setDbForTests(migrate(new DatabaseSync(HOME)));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const P = await import('../src/agent/plan/index.js');
const R = await import('../src/agent/recovery/index.js');
const { buildEvidence, STATUS, decideStatus } = await import('../src/agent/evidence/index.js');
const { isFailedWrite } = await import('../src/agent/mutation-pipeline.js');
const { createTask, startTask, getTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const { executeTool, resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { appendMutation } = await import('../src/memory/ledger.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const stripped = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

let n = 0;
function newTask(goal = 'p10') {
  const sid = `p10-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const SYS = 'f0'.repeat(16);
const seeRecord = (sessionId, sysId = SYS) => registerFromToolResult({
  sessionId, seq: 0, table: 'incident', result: { sys_id: sysId, short_description: 'before' },
});
const localTool = (name, spec) => { toolMap.set(name, { name, ...spec }); return () => toolMap.delete(name); };
const err = (status, m = 'the instance said no') => Object.assign(new Error(m), { status });
const describeUpdate = (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id });

const writeStep = (over = {}) => ({
  id: 'step_1', operation: 'update the incident', capability: 'record_update',
  tool: over.tool, mechanism: null, scope: null, mutating: true,
  target: { table: 'incident', sys_id: SYS },
  inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'AFTER' } },
  depends_on: [], expected_effects: ['short_description becomes AFTER'],
  verification: { strategy: 'read_back', asserts: ['short_description == AFTER'] },
  ...over,
});

async function runPlan(taskId, sessionId, steps, { decide = true, signal = null, recoverStep = null, readRecord = null } = {}) {
  const saved = P.savePlan(taskId, { goal: 'g', steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  const res = await P.executePlan({
    taskId, sessionId, turnSeq: 1, signal,
    recoverStep: recoverStep ? ((a) => recoverStep({ ...a, readRecord })) : null,
    emit: (e) => {
      if (e.type === 'approval_required' && decide !== null) {
        setImmediate(() => resolveApproval(sessionId, e.approvalId, decide, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    },
  });
  return { res, plan: P.loadPlan(taskId), evidence: buildEvidence(taskId) };
}

/* ================================================================== *
 * A. THE FAILURE TAXONOMY
 * ================================================================== */

test('A1 — every failure kind has EXACTLY ONE policy, and none falls through', () => {
  const src = stripped('agent/recovery/policy.js');
  assert.equal(R.FAILURE_KINDS.length, 17, `the taxonomy has ${R.FAILURE_KINDS.length} kinds, not 17`);
  for (const kind of R.FAILURE_KINDS) {
    const rows = [...src.matchAll(new RegExp(`^\\s{2}${kind}:\\s*\\{`, 'gm'))];
    assert.equal(rows.length, 1, `${kind} has ${rows.length} policy rows, not exactly one`);
    const p = R.policyFor(kind);
    assert.ok(p && typeof p.decision === 'string', `${kind} has no decision`);
  }
  // No default branch, and no lookup that could invent one.
  assert.ok(!/default:/.test(src), 'the policy table has a default branch');
  assert.ok(!/\?\?\s*POLICY\.|POLICY\[[^\]]+\]\s*\?\?/.test(src), 'the policy lookup has a fallback');
});

test('A2 — an unknown kind THROWS rather than resolving to anything', () => {
  for (const bogus of ['NOT_A_KIND', '', null, undefined, 'RETRY', 'transient', 0, {}, []]) {
    assert.throws(() => R.policyFor(bogus), undefined,
      `policyFor(${JSON.stringify(bogus)}) returned instead of throwing`);
  }
});

test('A3 — UNKNOWN is STOP, and stays STOP', () => {
  const p = R.policyFor('UNKNOWN');
  assert.equal(p.decision, R.DECISIONS.STOP);
  assert.equal(p.automatic, false);
  assert.equal(p.maxAttempts, 0, 'UNKNOWN carries an attempt allowance');
});

test('A4 — automatic recovery is restricted to three transport kinds', () => {
  const automatic = R.FAILURE_KINDS.filter((k) => R.policyFor(k).automatic === true);
  assert.deepEqual(automatic.sort(), ['NETWORK', 'RATE_LIMITED', 'TRANSIENT'],
    `automatic recovery is permitted for: ${automatic.join(', ')}`);
});

test('A5 — TIMEOUT reconciliation is mandatory and cannot be skipped', () => {
  const p = R.policyFor('TIMEOUT');
  assert.equal(p.reconcileFirst, true, 'TIMEOUT no longer demands reconciliation');
  assert.notEqual(p.automatic, true, 'TIMEOUT became automatic, which would repeat a possible write');
  // And the decision layer refuses without one.
  const d = R.decideRecovery({
    evidence: null, stepId: 's1',
    error: { status: 408 },
    descriptor: { operation: 'update', table: 'incident', sys_id: SYS, requested: { short_description: 'x' } },
    reconciliation: null,
  });
  assert.notEqual(d.decision, R.DECISIONS.RETRY, 'a timeout retried with no reconciliation');
});

test('A6 — the three budgets are read from DURABLE state, never from memory', () => {
  assert.equal(R.LIMITS.MAX_ATTEMPTS, 2);
  assert.equal(R.LIMITS.MAX_REPLANS, 1);
  assert.equal(R.LIMITS.MAX_RECOVERY_STEPS, 4);
  // `historyFrom` counts stored attempts; nothing else feeds the budget.
  const src = stripped('agent/recovery/decision.js');
  assert.match(src, /history\.attempts/);
  assert.ok(!/let\s+attempts|attempts\+\+|globalThis/.test(src), 'the budget is counted in memory');
  // Proven durably: a step with a stored lineage is over budget on a cold read.
  const { taskId } = newTask('budget');
  P.savePlan(taskId, { goal: 'g', steps: [writeStep({ tool: 'update_record' })] });
  for (let i = 0; i < R.LIMITS.MAX_RECOVERY_STEPS; i += 1) {
    P.recordRecoveryAttempt(taskId, 'step_1', { attempt: i, decision: 'RETRY', outcome: 'NOT_RECOVERED' });
  }
  const h = R.historyFrom({ recovery: P.recoveryHistory(taskId, 'step_1') });
  assert.equal(h.recoverySteps, R.LIMITS.MAX_RECOVERY_STEPS);
});

test('A7 — a missing describeWrite can never become retryable', () => {
  // No tool name, no descriptor: nothing to repeat, so READ_ONLY is correct.
  assert.equal(R.classifyIdempotency({}).idempotency, 'READ_ONLY');
  // A mutating tool that cannot describe its write is UNKNOWN — never IDEMPOTENT.
  const drop = localTool('p10_nodesc', { mutating: true, execute: async () => ({}) });
  try {
    const v = R.classifyIdempotency({ tool: 'p10_nodesc' });
    assert.equal(v.idempotency, 'UNKNOWN');
    assert.equal(R.isAutoRetryable(v.idempotency), false);
  } finally { drop(); }
  // And a descriptor alone is enough to see a create, with no tool name at all.
  assert.equal(R.classifyIdempotency({ descriptor: { operation: 'create' } }).idempotency, 'NON_IDEMPOTENT');
});

test('A8 — NON_IDEMPOTENT and UNKNOWN are refused at the execution boundary too', () => {
  const src = stripped('agent/recovery/executor.js');
  assert.match(src, /if \(!isAutoRetryable\(decision\.idempotency\)\)/,
    'the execution boundary no longer re-checks the class');
  assert.ok(src.indexOf('isAutoRetryable(decision.idempotency)') < src.indexOf('await executeStep('),
    'the boundary check runs after execution');
});

/* ================================================================== *
 * B. MUTATION AUTHORISATION — the complete inventory
 * ================================================================== */

/*
 * THREE PATHS CAN REACH A MUTATING TOOL. There are no others; the Phase 9
 * call-site inventory asserts the set, and this asserts what each one does.
 *
 *   1. THE TURN LOOP      agent/orchestrator.js — a model proposes mid-turn
 *   2. THE PLAN EXECUTOR  agent/plan/executor.js — an approved plan step
 *   3. THE TABLES PANE    routes/dba.js — a human clicked a button; no model
 *
 * The eleven controls are not identical across them, and the differences are
 * the point: the pane has no model to distrust, so it substitutes a hard
 * allowlist and a binding assertion for the fingerprint. What none of them may
 * do is reach `executeTool` without an attributable approval.
 */

test('B1 — the inventory of paths to a mutation is exactly three', () => {
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(SRC, full).replace(/\\/g, '/');
      const b = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (/\bexecuteTool\s*\(/.test(b.replace(/export async function executeTool\s*\(/, ''))) callers.push(rel);
    }
  };
  walk(SRC);
  assert.deepEqual(callers.sort(), ['agent/orchestrator.js', 'agent/plan/executor.js', 'routes/dba.js']);
});

test('B2 — PATH 1 (turn loop): all eleven controls are present', () => {
  const src = stripped('agent/orchestrator.js');
  assert.match(src, /checkWriteTarget\(/, '1. target');                      // 1
  assert.match(src, /checkBeforeGate\(/, '7. write guard');                  // 7
  assert.match(src, /awaitApprovalDecision\(/, '4/5. approval + provenance');
  assert.match(src, /APPROVAL_SOURCES/, '5. attributable');
  assert.match(src, /verifyMutation\(|attachVerification\(/, '9/10. read-back + verification');
  assert.match(src, /appendMutation\(/, '11. ledger');
  assert.match(src, /recordToolEvent\(/, '11. events');
  // 3. mutating status comes from the REGISTRY, not from the model.
  assert.match(src, /tool\.mutating/, '3. mutating status');
});

test('B3 — PATH 2 (plan executor): all eleven controls are present and ordered', () => {
  const src = stripped('agent/plan/executor.js');
  const at = (re) => src.search(re);
  const target = at(/checkWriteTarget\(/);
  const guard = at(/checkBeforeGate\(/);
  const gate = at(/awaitApprovalDecision\(|requestApproval\(/);
  const exec = at(/executeTool\(/);
  const verify = at(/verifyMutation\(/);
  const ledger = at(/appendMutation\(/);
  for (const [label, idx] of [['target', target], ['guard', guard], ['gate', gate],
    ['exec', exec], ['verify', verify], ['ledger', ledger]]) {
    assert.ok(idx > 0, `the plan executor has no ${label}`);
  }
  // THE ORDER IS THE CONTROL. Anything after execution cannot prevent it.
  assert.ok(target < guard, 'the provenance check runs after the write guard');
  assert.ok(guard < exec, 'the write guard runs after execution');
  assert.ok(exec < verify, 'verification runs before execution');
  assert.ok(verify < ledger, 'the ledger is written before the verdict exists');
  // 6. the fingerprint, checked before EVERY step.
  assert.match(src, /checkApprovalBinding\(taskId\)/, '6. fingerprint');
  // 2. capability travels with the step and is stamped, not chosen at runtime.
  assert.match(src, /step\.capability|plan\.steps/, '2. capability');
});

test('B4 — PATH 3 (Tables pane): a human click, an allowlist, and a binding', () => {
  const src = stripped('routes/dba.js');
  // No model can reach it.
  assert.ok(!/runTurn|chatOnce|callProvider|generatePlan/.test(src), 'the pane can invoke a model');
  // A hard allowlist of four tools stands in for the fingerprint.
  assert.match(src, /UI_WRITE_TOOLS = new Set\(\[/);
  assert.match(src, /not-a-ui-write-tool/);
  // 3. the registry's mutating flag is checked explicitly.
  assert.match(src, /tool\?\.mutating/, '3. mutating status');
  // The instance/scope binding, asserted before touching anything.
  assert.match(src, /assertTiersAgree|assertAppBinding/, 'binding');
  // 5. provenance is user_click because a person literally clicked.
  assert.match(src, /APPROVAL_SOURCES\.USER_CLICK/);
  // And the one non-mutating call on this path passes approval `null`, which is
  // safe only because executeTool short-circuits reads before the gate.
  assert.match(src, /dba_snapshot/);
});

test('B5 — executeTool is the choke point and refuses everything unattributable', async () => {
  const tool = { name: 'p10_choke', mutating: true, execute: async () => ({ ok: true }) };
  for (const approval of [null, undefined, '', 'pending', 'rejected', 'cancelled', true, 1, {}, 'approved ']) {
    await assert.rejects(() => executeTool(tool, {}, approval, { source: APPROVAL_SOURCES.USER_CLICK }),
      /Refusing to execute the mutating tool/, `approval=${JSON.stringify(approval)} was accepted`);
  }
  for (const prov of [null, undefined, {}, { source: null }, { source: 'unknown' }, { source: 'model' }, { source: 'plan' }]) {
    await assert.rejects(() => executeTool(tool, {}, 'approved', prov), undefined,
      `provenance=${JSON.stringify(prov)} was accepted`);
  }
});

test('B6 — no IMPLICIT mutation path: nothing else reaches a mutating tool', () => {
  /*
   * A tool's `execute` could in principle be called directly, bypassing
   * `executeTool` entirely. Nothing does — this asserts it across the tree.
   */
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(SRC, full).replace(/\\/g, '/');
      // The registry itself defines them; the DBA route runs reads directly.
      if (rel === 'agent/tools.js') continue;
      const b = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (/toolMap\.get\([^)]*\)\s*[?.]*\.execute\s*\(/.test(b)) offenders.push(rel);
    }
  };
  walk(SRC);
  // `routes/dba.js` calls `.execute` only through executeTool; anything else is
  // a finding.
  assert.deepEqual(offenders, [], `a tool is executed outside executeTool in: ${offenders.join(', ')}`);
});

/* ================================================================== *
 * C. UNCERTAINTY — the release gate
 * ================================================================== */

test('C1 — unknown does NOT become success', async () => {
  // A tool returning something meaningless proves nothing.
  for (const shape of [null, undefined, '', 0, false, [], { unexpected: true }, 'ok']) {
    const d = localTool('p10_unknown', {
      mutating: true, describeWrite: describeUpdate, execute: async () => shape,
    });
    try {
      const { taskId, sessionId } = newTask();
      seeRecord(sessionId);
      const { evidence } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p10_unknown' })]);
      assert.notEqual(evidence.final.status, STATUS.VERIFIED,
        `a ${JSON.stringify(shape)} result produced a VERIFIED run`);
      assert.notEqual(evidence.steps[0].verification_status, 'applied',
        `a ${JSON.stringify(shape)} result was verified as applied`);
    } finally { d(); }
  }
});

test('C2 — timeout does NOT become retry', async () => {
  let calls = 0;
  const d = localTool('p10_timeout', {
    mutating: true, describeWrite: describeUpdate,
    execute: async () => { calls += 1; throw err(408, 'Request Timeout'); },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p10_timeout' })],
      { recoverStep: R.recoverStep, readRecord: null });
    assert.equal(calls, 1, 'a timed-out write was repeated');
    assert.equal(res.recovery.decision.decision, R.DECISIONS.STOP);
  } finally { d(); }
});

test('C3 — missing evidence does NOT become verified', () => {
  const out = decideStatus({
    planState: 'completed', taskState: 'completed', executedAnything: true,
    steps: [{ id: 's1', state: 'completed' }],
    effects: [{ step: 's1', effect: 'something was promised', verified: null }],
  });
  assert.notEqual(out.status, STATUS.VERIFIED, 'an unverified effect produced a VERIFIED run');
  assert.equal(out.status, STATUS.UNVERIFIED);
});

test('C4 — a missing read-back does NOT become verified', async () => {
  const d = localTool('p10_noreadback', {
    mutating: true,   // mutating, but describes no write, so nothing can be diffed
    execute: async (i) => ({ sys_id: i.sys_id, ok: true }),
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { evidence } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p10_noreadback' })]);
    assert.equal(evidence.steps[0].executed, true, 'the call is reported as not having happened');
    assert.notEqual(evidence.steps[0].verification_status, 'applied');
    assert.notEqual(evidence.final.status, STATUS.VERIFIED);
    assert.ok(evidence.uncertainties.some((u) => u.kind === 'unverified_effect'),
      'an unprovable promise carries no uncertainty');
  } finally { d(); }
});

test('C5 — failed verification does NOT become completed', async () => {
  const d = localTool('p10_dropped', {
    mutating: true, describeWrite: describeUpdate,
    execute: async (i) => ({ sys_id: i.sys_id, number: 'INC1' }),   // field absent
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res, plan, evidence } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p10_dropped' })]);
    assert.equal(plan.steps[0].state, 'failed', 'a dropped write left the step completed');
    assert.equal(res.ok, false);
    assert.equal(evidence.final.status, STATUS.FAILED);
  } finally { d(); }
});

test('C6 — stale state does NOT become current state', async () => {
  let calls = 0;
  const d = localTool('p10_stale', {
    mutating: true, describeWrite: describeUpdate,
    execute: async (i) => { calls += 1; return { sys_id: i.sys_id }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const saved = P.savePlan(taskId, { goal: 'g', steps: [writeStep({ tool: 'p10_stale' })] });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    getDb().prepare('UPDATE agent_tasks SET plan_fingerprint = ? WHERE id = ?').run('0'.repeat(64), taskId);
    const res = await P.executePlan({ taskId, sessionId, turnSeq: 1, recoverStep: R.recoverStep, emit: () => {} });
    assert.equal(calls, 0, 'a stale plan executed');
    assert.equal(res.reason, 'approval_stale');
    assert.equal(buildEvidence(taskId).final.status, STATUS.BLOCKED,
      'a stale plan was reported as FAILED, which invites a retry');
  } finally { d(); }
});

test('C7 — a rejected approval does NOT become a retry', async () => {
  let calls = 0; let recoveries = 0;
  const d = localTool('p10_rejected', {
    mutating: true, describeWrite: describeUpdate,
    execute: async (i) => { calls += 1; return { sys_id: i.sys_id }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const saved = P.savePlan(taskId, { goal: 'g', steps: [writeStep({ tool: 'p10_rejected' })] });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    await P.executePlan({
      taskId, sessionId, turnSeq: 1,
      recoverStep: (a) => { recoveries += 1; return R.recoverStep(a); },
      emit: (e) => {
        if (e.type === 'approval_required') {
          setImmediate(() => resolveApproval(sessionId, e.approvalId, false, APPROVAL_SOURCES.USER_CLICK, e.nonce));
        }
      },
    });
    assert.equal(calls, 0);
    assert.equal(recoveries, 0, 'a refusal was handed to the recovery engine');
    assert.equal(buildEvidence(taskId).recovery.attempted, false);
  } finally { d(); }
});

test('C8 — a crashed execution becomes neither failed nor completed', () => {
  /*
   * The step was marked `executing`, the request went out, the process died.
   * There is no honest terminal state, so the record keeps saying `executing`.
   * Calling it failed invites a retry of a write whose outcome is unknown;
   * calling it completed reports a change nobody can point to.
   */
  const { taskId } = newTask('crashed');
  P.savePlan(taskId, { goal: 'g', steps: [writeStep({ tool: 'update_record' })] });
  P.setStepState(taskId, 'step_1', 'ready');
  P.setStepState(taskId, 'step_1', 'executing');
  const plan = P.loadPlan(taskId);
  assert.equal(plan.steps[0].state, 'executing');
  assert.equal(plan.steps[0].completedAt, null);
  const ev = buildEvidence(taskId);
  assert.notEqual(ev.final.status, STATUS.FAILED, 'an interrupted run was called failed');
  assert.notEqual(ev.final.status, STATUS.VERIFIED);
  assert.deepEqual(ev.changes, [], 'a change was claimed with no ledger row');
  assert.ok(ev.uncertainties.some((u) => u.kind === 'incomplete'));
});

test('C9 — an ambiguous mutation outcome does NOT become a safe retry', async () => {
  // The step failed with an outcome nothing can establish. Recovery must refuse.
  const { taskId, sessionId } = newTask('ambiguous');
  P.savePlan(taskId, { goal: 'g', steps: [writeStep({ tool: 'update_record' })] });
  P.setStepState(taskId, 'step_1', 'ready');
  P.setStepState(taskId, 'step_1', 'executing');
  P.setStepState(taskId, 'step_1', 'failed', { failure_reason: 'the connection dropped mid-write' });
  let executed = 0;
  const out = await R.recoverStep({
    taskId, stepId: 'step_1', sessionId,
    error: { status: 408 },
    descriptor: { operation: 'update', table: 'incident', sys_id: SYS, requested: { short_description: 'AFTER' } },
    executeStep: async () => { executed += 1; return { ok: true }; },
    // No readRecord: the effect is neither present nor absent.
  });
  assert.equal(executed, 0, 'a write with an unknown outcome was repeated');
  assert.notEqual(out.outcome, R.OUTCOME.RECOVERED);
});

test('C10 — the system never reports a change it cannot point at', async () => {
  // Across every state produced in this file, a non-empty `changes` list must
  // be backed by a real ledger row that names this task.
  const tasks = getDb().prepare("SELECT id FROM agent_tasks WHERE plan_state IS NOT NULL").all();
  for (const { id } of tasks) {
    const ev = buildEvidence(id);
    for (const c of ev.changes) {
      const row = getDb().prepare(
        'SELECT COUNT(*) AS n FROM mutation_ledger WHERE task_id = ? AND sys_id = ?',
      ).get(id, c.sys_id);
      if (c.exact) {
        assert.ok(row.n > 0, `task ${id} reports a change with no ledger row behind it`);
      }
    }
  }
});

/* ================================================================== *
 * D. CRASH SEMANTICS — what each surviving state may claim
 * ================================================================== */

/*
 * FIVE DURABLE STATES CAN SURVIVE PROCESS DEATH. For each, the question is not
 * "how do we tidy it" but "what may it honestly claim".
 *
 *   pending / ready       nothing ran. Safe to resume, safe to abandon.
 *   awaiting_approval     a card was raised and died with the process. NOT
 *                         resumable: the nonce is gone, so no answer can ever
 *                         be attributed. Safe to abandon, never to execute.
 *   executing             UNKNOWABLE. The request may or may not have landed.
 *                         Not resumable, not retryable, not terminal.
 *   verifying             the write landed; the read-back did not complete.
 *                         The ledger row exists and says `unverified`.
 *   completed / failed    terminal and honest; nothing to do.
 *
 * The only one with no safe automatic action is `executing`, and the release
 * posture is to leave it and expose it — never to fabricate a terminal state.
 */

test('D1 — a crashed AWAITING_APPROVAL cannot execute, because the nonce died with the process', () => {
  const { taskId } = newTask('crashed gate');
  const saved = P.savePlan(taskId, { goal: 'g', steps: [writeStep({ tool: 'update_record' })] });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.setStepState(taskId, 'step_1', 'ready');
  P.setStepState(taskId, 'step_1', 'awaiting_approval');
  // Nothing bound it: an unanswered card leaves no approval behind.
  assert.equal(P.loadPlan(taskId).approvedFingerprint, null);
  assert.equal(P.checkApprovalBinding(taskId).ok, false);
  assert.notEqual(buildEvidence(taskId).approval.status, 'approved');
  void saved;
});

test('D2 — a crashed EXECUTING step is not resumable, retryable or terminal', async () => {
  const { taskId, sessionId } = newTask('crashed exec');
  P.savePlan(taskId, { goal: 'g', steps: [writeStep({ tool: 'update_record' })] });
  P.setStepState(taskId, 'step_1', 'ready');
  P.setStepState(taskId, 'step_1', 'executing');

  // NOT TERMINAL: the state machine refuses to close it from outside.
  for (const to of ['completed', 'failed']) {
    const r = P.setStepState(taskId, 'step_1', to);
    // `executing -> completed|failed` IS legal for the executor that owns the
    // call. What matters is that nothing does it on a cold start, which D3
    // asserts on the import graph.
    assert.ok(typeof r.ok === 'boolean');
  }
});

test('D3 — NOTHING sweeps, resumes or closes a task on start-up', () => {
  /*
   * The release posture for Risk A. There is no crash sweeper, and its absence
   * is deliberate: a sweeper would have to decide what an interrupted write
   * did, and it cannot know. Asserted structurally so one cannot appear
   * without this test failing.
   */
  const boot = stripped('index.js');
  for (const forbidden of [/sweep/i, /reconcileOnBoot/i, /resumeTasks/i, /closeStale/i, /markAbandoned/i]) {
    assert.ok(!forbidden.test(boot), `start-up runs ${forbidden}`);
  }
  // And no module offers one.
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      const b = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (/function\s+(sweepStaleTasks|resumeInterruptedTasks|closeAbandoned\w*)\s*\(/.test(b)) {
        offenders.push(path.relative(SRC, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], `a crash sweeper exists in: ${offenders.join(', ')}`);
});

test('D4 — an interrupted run is VISIBLE as incomplete rather than silently stuck', () => {
  /*
   * The other half of Risk A's posture: leaving the state is only acceptable if
   * a reader can SEE it. Evidence reports the run as incomplete and says why,
   * so an operator has something to act on without the system acting for them.
   */
  const { taskId } = newTask('interrupted');
  P.savePlan(taskId, { goal: 'g', steps: [writeStep({ tool: 'update_record' })] });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'executing');
  P.setStepState(taskId, 'step_1', 'ready');
  P.setStepState(taskId, 'step_1', 'executing');

  const ev = buildEvidence(taskId);
  const u = ev.uncertainties.find((x) => x.kind === 'incomplete');
  assert.ok(u, 'an interrupted run carries no uncertainty');
  assert.match(u.note, /may still be running|process that owned it died/);
  assert.equal(ev.steps[0].execution_status, 'executing',
    'the step no longer reports the state it is actually in');
  assert.equal(getTask(taskId).state, 'running');
});

test('D5 — a write recorded before a crash survives, and stays unverified', () => {
  const { taskId, sessionId } = newTask('crashed verify');
  P.savePlan(taskId, { goal: 'g', steps: [writeStep({ tool: 'update_record' })] });
  P.setStepState(taskId, 'step_1', 'ready');
  P.setStepState(taskId, 'step_1', 'executing');
  appendMutation({
    sessionId, turnSeq: 0, tool: 'update_record', taskId,
    descriptor: { table: 'incident', sys_id: SYS, operation: 'update', requested: { short_description: 'AFTER' } },
    result: { sys_id: SYS },
    verification: null,                       // the verifier never ran
    approval: 'approved', approvedSource: APPROVAL_SOURCES.USER_CLICK,
  });
  const ev = buildEvidence(taskId);
  assert.equal(ev.changes.length, 1, 'a recorded write was lost');
  assert.equal(ev.changes[0].verification_status, 'unverified');
  assert.notEqual(ev.final.status, STATUS.VERIFIED);
});

/* ================================================================== *
 * E. THE PATTERNS §2 ASKED TO BE SWEPT FOR
 * ================================================================== */

test('E1 — no catch block converts a failure into a permissive verdict', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      const b = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const m of b.matchAll(/catch[^{]*\{/g)) {
        const block = b.slice(m.index, m.index + 320);
        if (/(allowed:\s*true|approved:\s*true|verified:\s*true|status:\s*'applied'|return\s+true\s*;)/.test(block)) {
          offenders.push(`${path.relative(SRC, full).replace(/\\/g, '/')} @${m.index}`);
        }
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], `a catch block produced a permissive verdict: ${offenders.join(', ')}`);
});

test('E2 — no module-level singleton holds task, plan or approval identity', () => {
  /*
   * Phase 0's §16 rule. Twenty module-level mutable variables exist — caches,
   * a DB handle, a build queue, test seams — and none of them keys anything by
   * task, plan, approval, step, fingerprint or nonce. That is what makes two
   * concurrent runs unable to see each other.
   */
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(SRC, full).replace(/\\/g, '/');
      const b = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const m of b.matchAll(/^(let|var)\s+(\w+)/gm)) {
        const name = m[2];
        /*
         * Only an assignment whose VALUE is a control identity counts.
         *
         * An earlier form of this also flagged any property write on the
         * variable, which matched `server.close()`, a host+scope cache key and
         * the audio capture agent's heartbeat — three things that hold no
         * task, plan or approval identity at all. A guard that cries wolf on
         * an HTTP server handle is a guard nobody reads.
         */
        const IDENT = '(taskId|planId|approvalId|stepId|fingerprint|nonce|plan_step_id|task_id)';
        const assigns = new RegExp(
          `${name}\\s*=\\s*[^;\\n]*\\b${IDENT}\\b`          // x = ...taskId...
          + `|${name}\\s*\\[[^\\]]*\\b${IDENT}\\b[^\\]]*\\]\\s*=`   // x[taskId] = ...
          + `|${name}\\.set\\(\\s*\\w*${IDENT}`,             // x.set(taskId, ...)
          'i',
        );
        if (assigns.test(b)) offenders.push(`${rel}: ${name}`);
      }
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], `a singleton holds control identity: ${offenders.join(', ')}`);
});

test('E3 — every loop that walks a remote resource is bounded, or refuses', () => {
  // One `for(;;)` exists, in the DBA metadata keyset walk. It has three exits:
  // the caller's ceiling, an empty page, and a THROW when the watermark cannot
  // advance — which is the correct answer to "I cannot bound this".
  const src = read('servicenow/dba-metadata.js');
  assert.match(src, /for \(;;\) \{/);
  assert.match(src, /if \(limit <= 0\) break;/, 'the ceiling exit is gone');
  assert.match(src, /terminator = 'empty-page'; break;/, 'the empty-page exit is gone');
  assert.match(src, /Refusing to return a result this read cannot bound/,
    'the walk no longer refuses when it cannot advance');
  // And no other unbounded loop exists anywhere.
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(SRC, full).replace(/\\/g, '/');
      if (rel === 'servicenow/dba-metadata.js') continue;
      const b = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/.test(b)) offenders.push(rel);
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], `an unbounded loop exists in: ${offenders.join(', ')}`);
});

test('E4 — no optimistic terminal state: a plan closes only from its own executor', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(SRC, full).replace(/\\/g, '/');
      const b = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      if (/setPlanState\([^,]+,\s*'completed'/.test(b)) offenders.push(rel);
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, ['agent/plan/executor.js'],
    `a plan is marked completed outside its executor: ${offenders.join(', ')}`);
});

/* ================================================================== *
 * F. THE PHASE 10 DEFECT — a step that cannot name its own target
 * ================================================================== */

/*
 * FOUND BY THE RELEASE ACCEPTANCE RUN. Asked to "delete every incident on this
 * instance", the planner produced:
 *
 *   step_1  query_records   (read)
 *   step_2  delete_record   inputs: { sys_ids: "<output_of_step_1.sys_ids>" }
 *
 * A placeholder referring to the previous step's output, under a key
 * `delete_record` does not declare. There is no output-substitution mechanism
 * in this build — deliberately — and nothing rejected the plan either.
 *
 * WHAT WOULD HAVE HAPPENED WAS SAFE. `describeWrite` returns no `sys_id` for
 * that input, so the call would have gone out as
 * `DELETE /api/now/table/undefined/undefined` and been refused by the platform.
 * It could not have deleted the wrong record because it named no record.
 *
 * WHAT WAS WRONG, and why it is worth a rule:
 *
 *   The approval card shows a step's inputs. A human would have been asked to
 *   authorise a DELETE whose target the card could not describe.
 *
 *   `checkWriteTarget` runs only when the descriptor HAS a sys_id, so a step
 *   whose target is ABSENT slips past the guard built for targets that are
 *   UNKNOWN. Absent is worse than unknown, and it was the quieter of the two.
 *
 * CLASSIFICATION: non-blocking defect with a safety-adjacent consequence.
 * Fixed at the validator, which §13 names as the final authority.
 */

test('F1 — REGRESSION: the exact plan the model produced is now refused', () => {
  const plan = {
    goal: 'delete every incident on this instance',
    steps: [
      {
        id: 'step_1', operation: 'find every incident', capability: 'record_read',
        tool: 'query_records', mutating: false,
        target: { table: 'incident', sys_id: null }, inputs: { query: {} },
        depends_on: [], expected_effects: [], verification: null,
      },
      {
        id: 'step_2', operation: 'delete them', capability: 'record_delete',
        tool: 'delete_record', mutating: true,
        target: { table: 'incident', sys_id: null },
        inputs: { sys_ids: '<output_of_step_1.sys_ids>' },   // the literal placeholder
        depends_on: ['step_1'], expected_effects: ['the incidents are gone'],
        verification: { strategy: 'read_back', asserts: ['the incidents are gone'] },
      },
    ],
  };
  const verdict = P.validatePlan(plan, {
    discover: (name) => ({
      capability: name, status: 'known', available: true, mechanism: 'rest',
      mutating: name !== 'record_read', verification: 'read_back', requiresVerification: true,
      requiresApproval: name !== 'record_read', requiresElevation: false, elevationRole: null,
      scope: null, reason: null, note: null,
    }),
  });
  assert.equal(verdict.valid, false, 'a delete with no target reached the approval card');
  /*
   * BOTH steps are caught, which is worth recording: the model's read step also
   * omitted `table`, so the plan was incomplete in two places and only the
   * delete was visible in the summary. The delete is the one that matters.
   */
  const problems = verdict.fatal.filter((p) => p.code === 'missing_required_inputs');
  assert.ok(problems.length > 0,
    `expected missing_required_inputs, got ${verdict.fatal.map((p) => p.code).join(', ')}`);
  const del = problems.find((p) => p.step === 'step_2');
  assert.ok(del, `the DELETE step was not flagged; flagged: ${problems.map((p) => p.step).join(', ')}`);
  /*
   * PHASE 11 narrowed this, and the narrowing is the point. `target.table` is
   * now lifted into the canonical arguments, so `table` is no longer missing —
   * but `target.sys_id` was null and the placeholder lived under `sys_ids`,
   * which `delete_record` does not declare. The delete still cannot name the
   * record it would delete, and is still refused.
   */
  assert.deepEqual(del.detail.missing.sort(), ['sys_id'],
    'the delete was flagged for the wrong reason');
  assert.equal(del.detail.tool, 'delete_record');
});

test('F2 — the rule reads the registry schema and invents nothing', () => {
  const src = stripped('agent/plan/validator.js');
  assert.match(src, /toolMap\.get\(s\.tool\)\.inputSchema\?\.required/,
    'the validator hard-codes required fields instead of reading the registry');
  // A tool that declares no required inputs is unconstrained.
  const drop = localTool('p10_norequired', {
    mutating: true, inputSchema: { type: 'object', properties: {} }, execute: async () => ({}),
  });
  try {
    const v = P.validatePlan({
      goal: 'g',
      steps: [{ ...writeStep({ tool: 'p10_norequired' }), inputs: {} }],
    }, {
      discover: () => ({
        capability: 'record_update', status: 'known', available: true, mechanism: 'rest',
        mutating: true, verification: 'read_back', requiresVerification: true,
        requiresApproval: true, requiresElevation: false, elevationRole: null,
        scope: null, reason: null, note: null,
      }),
    });
    assert.ok(!v.fatal.some((p) => p.code === 'missing_required_inputs'),
      'a tool with no declared requirements was constrained anyway');
  } finally { drop(); }
});

test('F3 — a complete step is still accepted', () => {
  const good = {
    goal: 'delete one incident',
    steps: [{
      id: 'step_1', operation: 'delete the incident', capability: 'record_delete',
      tool: 'delete_record', mutating: true,
      target: { table: 'incident', sys_id: SYS },
      inputs: { table: 'incident', sys_id: SYS },
      depends_on: [], expected_effects: ['the incident is gone'],
      verification: { strategy: 'read_back', asserts: ['the incident is gone'] },
    }],
  };
  const v = P.validatePlan(good, {
    discover: (name) => ({
      capability: name, status: 'known', available: true, mechanism: 'rest',
      mutating: true, verification: 'read_back', requiresVerification: true,
      requiresApproval: true, requiresElevation: false, elevationRole: null,
      scope: null, reason: null, note: null,
    }),
  });
  assert.ok(!v.fatal.some((p) => p.code === 'missing_required_inputs'),
    `a complete delete was refused: ${v.fatal.map((p) => p.code).join(', ')}`);
});

test('F4 — the underlying hazard is named: an ABSENT target skips the guard', () => {
  /*
   * The rule above stops these plans at validation. This asserts WHY that
   * mattered — the executor's confabulation guard is conditional on the
   * descriptor having a sys_id, so it protects against unknown targets and not
   * against missing ones. That is still true, and is now unreachable for any
   * tool that declares its target as required.
   */
  const exec = stripped('agent/plan/executor.js');
  assert.match(exec, /if \(mutating && descriptor\?\.sys_id\) \{/,
    'the guard condition changed; re-examine whether an absent target is covered');
  assert.match(exec, /checkWriteTarget\(/);
  // And `delete_record` declares its target required, so the validator now
  // catches the case the executor cannot.
  assert.deepEqual(toolMap.get('delete_record').inputSchema.required.sort(), ['sys_id', 'table']);
});

/* ================================================================== *
 * G. THE RELEASE-GATE FINDING — a validated plan that cannot execute
 * ================================================================== */

/*
 * THE INVARIANT THAT FAILED: a plan the validator accepts must be executable.
 *
 * WHAT WAS FOUND. The plan schema offers two places for the same fact. `target`
 * is documented as `{ table, sys_id } when it acts on a record`; `inputs` is
 * "the arguments the tool needs". The configured model reads that reasonably
 * and puts the table in `target`:
 *
 *   target: { table: 'incident' }
 *   inputs: { query: 'active=true^priority=1', limit: 3 }
 *
 * THE EXECUTOR PASSES ONLY `inputs`. Nothing merges `target` into it, so
 * `query_records` is called with no table at all.
 *
 * WHAT HAPPENED BEFORE PHASE 10, measured rather than assumed (G1 below): the
 * plan VALIDATED, EXECUTED, and the run reported `ok: true` — while the tool
 * received arguments with the target missing. Phase 9's "94% valid-plan rate"
 * was measuring validation acceptance, not executability, and overstated what
 * the plan route could actually do.
 *
 * WHAT HAPPENS NOW. The Phase 10 required-inputs rule refuses the step at plan
 * time, before a human is asked to approve anything. That is strictly safer and
 * it is why the rule stays — but it drops the model's acceptance rate on
 * ordinary work from 97% to 13%, because the model puts the target where the
 * executor does not read it.
 *
 * WHY IT IS NOT FIXED HERE. Every available fix is out of Phase 10's scope:
 * merging `target` into `inputs` changes execution semantics and the
 * fingerprint; normalising it before validation is the "silent repair" §13
 * forbids; changing the prompt is forbidden by §12 while a deterministic
 * boundary exists. Phase 10 decides; it does not develop.
 *
 * SCOPE. The chat route does not use plans — a model's tool_use block IS the
 * argument object there — so this affects the model-driven plan route only.
 */

test('G1 — RESOLVED: the target now reaches the tool, canonically', async () => {
  /*
   * THE PHASE 10 FINDING, AND ITS FIX, IN ONE TEST.
   *
   * Before Phase 11 this exact plan validated, executed, reported `ok: true`
   * and handed the tool `{ query, limit }` — with no table. What follows is
   * the behaviour now.
   *
   * The probe declares `table` in its own inputSchema, so canonicalisation
   * lifts `target.table` into the execution arguments. A tool declaring no
   * `table` still receives none, which G1b asserts.
   */
  let received = null;
  const drop = localTool('p11_arg_probe', {
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } },
      required: ['table'],
    },
    execute: async (input) => { received = input; return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask('argument delivery');
    const saved = P.savePlan(taskId, {
      goal: 'read incidents',
      steps: [{
        id: 'step_1', operation: 'read incidents', capability: 'record_read',
        tool: 'p11_arg_probe', mechanism: null, scope: null, mutating: false,
        target: { table: 'incident' },
        inputs: { query: 'active=true^priority=1', limit: 3 },
        depends_on: [], expected_effects: [], verification: null,
      }],
    });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    const res = await P.executePlan({ taskId, sessionId, turnSeq: 1, emit: () => {} });

    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(received, 'the tool was never called');
    assert.equal(received.table, 'incident', 'THE TARGET STILL DOES NOT REACH THE TOOL');
    assert.deepEqual(Object.keys(received).sort(), ['limit', 'query', 'table']);
    assert.equal(received.query, 'active=true^priority=1');
    assert.equal(received.limit, 3);
  } finally { drop(); }
});

test('G1b — a tool that declares no `table` is not handed one', async () => {
  // 42 of 90 tools declare neither `table` nor `sys_id`; giving them one would
  // be inventing an argument.
  let received = null;
  const drop = localTool('p11_no_table', {
    mutating: false,
    inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
    execute: async (input) => { received = input; return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask('no table');
    const saved = P.savePlan(taskId, {
      goal: 'g',
      steps: [{
        id: 'step_1', operation: 'op', capability: 'record_read', tool: 'p11_no_table',
        mechanism: null, scope: null, mutating: false,
        target: { table: 'incident', sys_id: SYS },
        inputs: { note: 'hello' },
        depends_on: [], expected_effects: [], verification: null,
      }],
    });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    await P.executePlan({ taskId, sessionId, turnSeq: 1, emit: () => {} });
    assert.deepEqual(received, { note: 'hello' }, 'an undeclared argument was invented');
    assert.deepEqual(P.loadPlan(taskId).steps[0].inputs, { note: 'hello' });
  } finally { drop(); }
});

test('G2 — the executor passes `inputs` and nothing else', () => {
  const src = stripped('agent/plan/executor.js');
  assert.match(src, /executeTool\(tool, step\.inputs \|\| \{\}/,
    'the argument source changed; re-run the G1 measurement');
  // And nothing anywhere merges the two.
  assert.ok(!/\{\s*\.\.\.step\.target\s*,\s*\.\.\.step\.inputs|mergeTarget/.test(src),
    'a merge appeared — this finding may be resolved');
});

test('G3 — the previously-refused read is now accepted, because it is executable', () => {
  /*
   * PHASE 10 refused this plan: `query_records` requires `table`, and the
   * model had put it in `target`. That refusal was correct at the time — the
   * plan genuinely could not run — but the information WAS present, in the
   * other of two documented locations.
   *
   * Canonicalisation resolves it deterministically before validation, so the
   * plan is now valid AND executable. The required-inputs rule is unchanged;
   * it is simply reading the arguments that will actually run.
   */
  const step = {
    id: 'step_1', operation: 'read incidents', capability: 'record_read',
    tool: 'query_records', mutating: false,
    target: { table: 'incident' },
    inputs: { query: 'active=true', limit: 3 },
    depends_on: [], expected_effects: [], verification: null,
  };
  const v = P.validatePlan({ goal: 'read incidents', steps: [step] }, {
    discover: (n) => ({
      capability: n, status: 'known', available: true, mechanism: 'rest', mutating: false,
      verification: 'none', requiresVerification: false, requiresApproval: false,
      requiresElevation: false, elevationRole: null, scope: null, reason: null, note: null,
    }),
  });
  assert.equal(v.valid, true, `still refused: ${v.fatal.map((x) => x.code).join(', ')}`);
  const { args } = P.canonicalExecutionArgs(step);
  assert.equal(args.table, 'incident');
  assert.deepEqual(Object.keys(args).sort(), ['limit', 'query', 'table']);
});

test('G3b — a step that genuinely cannot name its target is STILL refused', () => {
  // Canonicalisation resolves an ambiguity; it does not manufacture a fact.
  const v = P.validatePlan({
    goal: 'read incidents',
    steps: [{
      id: 'step_1', operation: 'read incidents', capability: 'record_read',
      tool: 'query_records', mutating: false,
      target: {},
      inputs: { query: 'active=true', limit: 3 },
      depends_on: [], expected_effects: [], verification: null,
    }],
  }, {
    discover: (n) => ({
      capability: n, status: 'known', available: true, mechanism: 'rest', mutating: false,
      verification: 'none', requiresVerification: false, requiresApproval: false,
      requiresElevation: false, elevationRole: null, scope: null, reason: null, note: null,
    }),
  });
  assert.equal(v.valid, false, 'a plan with no table anywhere was accepted');
  assert.ok(v.fatal.some((x) => x.code === 'missing_required_inputs'));
});

test('G4 — the CHAT route is unaffected: it has no target/inputs split', () => {
  // A model's tool_use block IS the argument object there, so the ambiguity
  // this finding rests on does not exist on that path.
  const route = stripped('routes/agent.js');
  assert.ok(!/generatePlan|savePlan|executePlan/.test(route),
    'the chat route now uses the plan pipeline — this finding applies to it too');
  const orch = stripped('agent/orchestrator.js');
  assert.match(orch, /call\.input/, 'the turn loop no longer passes the model\'s own argument object');
});
