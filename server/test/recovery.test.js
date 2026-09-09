/**
 * PHASE 6 — THE RECOVERY ENGINE.
 *
 *   node --test server/test/
 *
 * Recovery is the phase where an agent most easily becomes reckless, so almost
 * every test here is a REFUSAL.
 *
 * THE INVARIANT THAT MATTERS MOST: a failure is not a licence to try something.
 * Four independent deterministic gates must all say yes before an operation is
 * repeated — what failed (classification), whether repeating it is safe
 * (idempotency), whether policy permits it, and whether budget remains. Any one
 * saying no stops it, and the tests below drive each of them to no.
 *
 * THE SECOND: execution success is never verification success. A retry that ran
 * cleanly and did not verify is NOT_RECOVERED, and nothing in this layer can
 * overrule the existing verifier.
 *
 * Offline in full: durable rows written directly, injected executors, no
 * instance, no model, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-recov-'));
const DB_FILE = path.join(scratchDir, 'test.db');
_setDbForTests(migrate(new DatabaseSync(DB_FILE)));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'hunter2' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
});

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const R = await import('../src/agent/recovery/index.js');
const P = await import('../src/agent/plan/index.js');
const E = await import('../src/agent/evidence/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { getDb } = await import('../src/memory/db.js');
const { toolMap } = await import('../src/agent/tools.js');
const { APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

let n = 0;
const newSession = () => `recov-${++n}`;

const stepOf = (over = {}) => ({
  id: over.id ?? 'step_1',
  operation: over.operation ?? 'update the incident',
  capability: over.capability ?? 'record_update',
  tool: 'tool' in over ? over.tool : 'update_record',
  mechanism: 'rest',
  scope: null,
  mutating: 'mutating' in over ? over.mutating : true,
  target: { table: 'incident', sys_id: 'a'.repeat(32) },
  inputs: over.inputs ?? { table: 'incident', sys_id: 'a'.repeat(32), data: { short_description: 'x' } },
  depends_on: [],
  expected_effects: over.expected_effects ?? ['short_description is updated'],
  verification: { strategy: 'read_back', asserts: ['short_description'] },
});

function approvedRun(goal, steps) {
  const sid = newSession();
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  const saved = P.savePlan(t.id, { goal, steps });
  P.setPlanState(t.id, 'ready');
  P.setPlanState(t.id, 'awaiting_approval');
  P.approvePlan(t.id, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  return { taskId: t.id, sessionId: sid, fingerprint: saved.fingerprint };
}

function failStep(taskId, stepId, { verification = null, reason = 'it failed' } = {}) {
  P.setStepState(taskId, stepId, 'ready');
  P.setStepState(taskId, stepId, 'executing');
  P.recordStepResult(taskId, stepId, { verification, failureReason: reason });
  P.setStepState(taskId, stepId, 'failed', { failure_reason: reason });
}

const DROPPED = (field, requested) => ({
  status: 'no-op', summary: `no-op: the platform discarded this write — ${field} unchanged`,
  applied: [], dropped: [{ field, requested, actual: null, reason: 'unchanged after the write' }],
  transformed: [], unverifiable: [],
});

const UPDATE_DESC = { table: 'incident', operation: 'update', requested: { short_description: 'x' }, sys_id: 'a'.repeat(32) };
const CREATE_DESC = { table: 'incident', operation: 'create', requested: { short_description: 'x' }, sys_id: null };

/* ------------------------------------------------------------------ *
 * CLASSIFICATION — taxonomy and precedence
 * ------------------------------------------------------------------ */

test('the taxonomy is closed, and the policy table covers it exactly', () => {
  assert.deepEqual([...R.FAILURE_KINDS], [
    'TRANSIENT', 'TIMEOUT', 'RATE_LIMITED', 'NETWORK', 'AUTHENTICATION', 'AUTHORIZATION',
    'VALIDATION', 'REFERENCE', 'SCOPE', 'BUILD', 'INSTALL', 'VERIFICATION',
    'APPROVAL_STALE', 'CANCELLED', 'BLOCKED', 'UNSUPPORTED', 'UNKNOWN',
  ]);
  // No kind without a policy row, and no policy row without a kind. A missing
  // row would otherwise fall through to whatever the lookup defaulted to.
  assert.deepEqual([...R.POLICY_KINDS].sort(), [...R.FAILURE_KINDS].sort());
  assert.throws(() => R.policyFor('INVENTED'), /no recovery policy/);
});

test('CLASSIFICATION — verification OUTRANKS the error text', () => {
  /*
   * The precedence that matters most. A silently dropped write returns cleanly,
   * so its error text says nothing useful; the verification verdict says
   * everything. Classifying from the text would call this TRANSIENT and retry
   * an identical write that would be discarded identically.
   */
  const c = R.classifyFailure({
    verification: DROPPED('short_description', 'x'),
    error: { status: 503, message: 'Service Unavailable' },   // a louder, wrong signal
    failureReason: 'connection reset',
  });
  assert.equal(c.kind, 'VERIFICATION');
  assert.equal(c.source, 'verification');
  assert.equal(c.confidence, 1);
  assert.match(c.reason, /accepted the call and discarded the write/);
});

test('CLASSIFICATION — read-back outranks the error text, one rung below verification', () => {
  const c = R.classifyFailure({
    readback: { after: {}, dropped: ['assignment_group'], transformed: [] },
    error: { status: 500 },
  });
  assert.equal(c.kind, 'VERIFICATION');
  assert.equal(c.source, 'readback');
  assert.ok(c.confidence < 1, 'a read-back inference should not claim a verdict\'s confidence');
});

test('CLASSIFICATION — the existing diagnoseFailure verdict is consumed, not recomputed', () => {
  /*
   * `servicenow/client.js` already separates four causes that all arrive as
   * HTTP 403. Re-deriving them here would be a second classifier that could
   * disagree with the one the execution path uses.
   */
  const cases = [
    ['business-rule', 'VALIDATION'],
    ['table-acl', 'AUTHORIZATION'],
    ['row-acl', 'AUTHORIZATION'],
    ['credentials', 'AUTHENTICATION'],
    ['missing-or-hidden', 'REFERENCE'],
  ];
  for (const [diagnosisKind, expected] of cases) {
    const c = R.classifyFailure({ error: { status: 403, detail: { diagnosis: { kind: diagnosisKind, message: 'm' } } } });
    assert.equal(c.kind, expected, `${diagnosisKind} should classify as ${expected}`);
    assert.equal(c.source, 'tool_error');
  }
  // And it is a MAP, not a reimplementation.
  assert.match(read('agent/recovery/classification.js'), /DIAGNOSIS_MAP/);
  assert.doesNotMatch(read('agent/recovery/classification.js'), /aborted by Business Rule/,
    'the 403 parsing was duplicated instead of consumed');
});

test('CLASSIFICATION — HTTP statuses map deterministically', () => {
  const byStatus = {
    401: 'AUTHENTICATION', 403: 'AUTHORIZATION', 408: 'TIMEOUT', 429: 'RATE_LIMITED',
    400: 'VALIDATION', 422: 'VALIDATION', 404: 'REFERENCE', 500: 'TRANSIENT', 503: 'TRANSIENT',
  };
  for (const [status, kind] of Object.entries(byStatus)) {
    assert.equal(R.classifyFailure({ error: { status: Number(status) } }).kind, kind, `HTTP ${status}`);
  }
});

test('CLASSIFICATION — cancellation, stale approval and unsupported are recognised before anything else', () => {
  assert.equal(R.classifyFailure({ cancelled: true, error: { status: 500 } }).kind, 'CANCELLED');
  assert.equal(R.classifyFailure({ planState: 'cancelled' }).kind, 'CANCELLED');
  assert.equal(R.classifyFailure({ approvalValid: false, approvalReason: 'approval_stale' }).kind, 'APPROVAL_STALE');
  assert.equal(R.classifyFailure({
    capability: { name: 'script_execution', available: false, status: 'unsupported', reason: 'unsupported' },
  }).kind, 'UNSUPPORTED');
});

test('CLASSIFICATION — build and install are distinguished', () => {
  assert.equal(R.classifyFailure({ build: { id: 'r1', status: 'error', kind: 'flow', summary: 'compile failed' } }).kind, 'BUILD');
  assert.equal(R.classifyFailure({ build: { id: 'r1', status: 'error', kind: 'install', summary: 'install failed' } }).kind, 'INSTALL');
});

test('CLASSIFICATION — a LEDGER TRAP can explain a failure but never authorises one', () => {
  const c = R.classifyFailure({ failureReason: 'the field was silently dropped by the platform' });
  assert.equal(c.source, 'ledger');
  assert.equal(c.kind, 'VERIFICATION');
  assert.ok(c.detail.factKey, 'the trap match is not traceable to a ledger fact');
  // A trap raises confidence. It does NOT make anything automatic.
  assert.equal(c.automatic, false, 'a ledger fact made a recovery automatic');
  assert.equal(c.requiresApproval, true);
  assert.ok(c.confidence < 1, 'a ledger match claimed a measurement\'s confidence');
});

test('CLASSIFICATION — an unrecognised failure is UNKNOWN, and UNKNOWN stops', () => {
  const c = R.classifyFailure({ failureReason: 'something inexplicable happened' });
  assert.equal(c.kind, 'UNKNOWN');
  assert.equal(c.confidence, 0);
  assert.equal(c.recoverable, false);
  assert.equal(c.automatic, false);
  assert.match(c.reason, /no recovery can be shown to be safe/);
  // Empty signals are also UNKNOWN — never a hopeful default.
  assert.equal(R.classifyFailure({}).kind, 'UNKNOWN');
});

test('CLASSIFICATION — confidence is metadata and nothing branches on it', () => {
  /*
   * `confidence` explains how firmly a kind was established. Using it as a
   * threshold would be an authorisation mechanism nobody designed, so no
   * comparison against it may exist anywhere in the layer.
   */
  for (const f of fs.readdirSync(path.join(SRC, 'agent', 'recovery')).filter((x) => x.endsWith('.js'))) {
    const src = read(`agent/recovery/${f}`);
    assert.doesNotMatch(src, /confidence\s*[<>]=?\s*[\d.]/, `recovery/${f} branches on confidence`);
    assert.doesNotMatch(src, /[\d.]\s*[<>]=?\s*\w*[Cc]onfidence/, `recovery/${f} branches on confidence`);
  }
});

/* ------------------------------------------------------------------ *
 * IDEMPOTENCY
 * ------------------------------------------------------------------ */

test('IDEMPOTENCY — only READ_ONLY and IDEMPOTENT may be repeated automatically', () => {
  assert.deepEqual([...R.AUTO_RETRYABLE], ['READ_ONLY', 'IDEMPOTENT']);
  assert.equal(R.isAutoRetryable('NON_IDEMPOTENT'), false);
  assert.equal(R.isAutoRetryable('UNKNOWN'), false);
});

test('IDEMPOTENCY — derived from the existing registry metadata', () => {
  // A read-only registry tool.
  assert.equal(R.classifyIdempotency({ tool: 'get_record' }).idempotency, 'READ_ONLY');
  // A step with no tool executes nothing.
  assert.equal(R.classifyIdempotency({ tool: null }).idempotency, 'READ_ONLY');
  // An update against a known sys_id.
  assert.equal(R.classifyIdempotency({ tool: 'update_record', descriptor: UPDATE_DESC }).idempotency, 'IDEMPOTENT');
  // A delete against a known sys_id — gone stays gone.
  assert.equal(R.classifyIdempotency({
    tool: 'delete_record', descriptor: { ...UPDATE_DESC, operation: 'delete' },
  }).idempotency, 'IDEMPOTENT');
});

test('IDEMPOTENCY — a CREATE is never automatically repeatable', () => {
  const v = R.classifyIdempotency({ tool: 'create_record', descriptor: CREATE_DESC });
  assert.equal(v.idempotency, 'NON_IDEMPOTENT');
  assert.match(v.reason, /would create a second record/);
  assert.equal(R.isAutoRetryable(v.idempotency), false);
});

test('IDEMPOTENCY — an update with no sys_id, and a tool that cannot describe itself, are UNKNOWN', async () => {
  assert.equal(R.classifyIdempotency({
    tool: 'update_record', descriptor: { table: 'incident', operation: 'update', requested: {}, sys_id: null },
  }).idempotency, 'UNKNOWN');

  // delete_live_flow mutates and has no describeWrite — a genuine unknown, not
  // an excuse to assume.
  const sdk = R.classifyIdempotency({ tool: 'delete_live_flow' });
  assert.equal(sdk.idempotency, 'UNKNOWN');
  assert.match(sdk.reason, /does not describe its write/);

  /*
   * SESSION 1 / WI-6 — create_flow_live now DOES describe its write (an insert
   * into sys_hub_flow through the SDK). Without a descriptor it is still
   * UNKNOWN, for a different reason (no stated operation); with one it is a
   * CREATE, which is NON_IDEMPOTENT — an install that timed out may have
   * landed (trap #116), and repeating it blind is how a second artifact appears.
   */
  const { toolMap } = await import('../src/agent/tools.js');
  const flowTool = toolMap.get('create_flow_live');
  assert.equal(R.classifyIdempotency({ tool: 'create_flow_live' }).idempotency, 'UNKNOWN');
  const insert = R.classifyIdempotency({ tool: 'create_flow_live', descriptor: flowTool.describeWrite({ description: 'x' }, null) });
  assert.equal(insert.idempotency, 'NON_IDEMPOTENT');

  assert.equal(R.classifyIdempotency({ tool: 'no_such_tool' }).idempotency, 'UNKNOWN');
});

/* ------------------------------------------------------------------ *
 * RECONCILIATION — verification-first
 * ------------------------------------------------------------------ */

test('RECONCILE — an update whose effect is already present must NOT be repeated', () => {
  const r = R.reconcileIntent({
    descriptor: UPDATE_DESC,
    current: { sys_id: 'a'.repeat(32), short_description: 'x' },
  });
  assert.equal(r.status, R.RECONCILIATION.ALREADY_SATISFIED);
  assert.equal(R.mayRepeatAfter(r), false, 'a satisfied effect was cleared for a repeat');
});

test('RECONCILE — an update whose effect is absent may be repeated', () => {
  const r = R.reconcileIntent({
    descriptor: UPDATE_DESC,
    current: { sys_id: 'a'.repeat(32), number: 'INC001' },   // the field is simply not there
  });
  assert.equal(r.status, R.RECONCILIATION.NOT_APPLIED);
  assert.equal(R.mayRepeatAfter(r), true);
});

test('RECONCILE — a CREATE cannot be reconciled, and says why', () => {
  /*
   * There is no deterministic way here to tell the record this attempt made
   * from a similar one that already existed. A heuristic — matching on
   * short_description, on a time window — would be the guess this project
   * forbids.
   */
  const r = R.reconcileIntent({ descriptor: CREATE_DESC, current: { sys_id: 'z'.repeat(32) } });
  assert.equal(r.status, R.RECONCILIATION.UNKNOWN);
  assert.match(r.reason, /no deterministic way/);
  assert.equal(R.mayRepeatAfter(r), false);
});

test('RECONCILE — a partial or transformed effect is DIVERGED, not repeatable', () => {
  const partial = R.reconcileIntent({
    descriptor: { table: 'incident', operation: 'update', requested: { a: '1', b: '2' }, sys_id: 'a'.repeat(32) },
    current: { sys_id: 'a'.repeat(32), a: '1' },
  });
  assert.equal(partial.status, R.RECONCILIATION.DIVERGED);
  assert.equal(R.mayRepeatAfter(partial), false);
});

test('RECONCILE — an unreadable record leaves the effect UNESTABLISHED', () => {
  const r = R.reconcileIntent({ descriptor: UPDATE_DESC, current: null });
  assert.equal(r.status, R.RECONCILIATION.UNKNOWN);
  assert.equal(R.mayRepeatAfter(r), false);
  // A delete against an absent record IS satisfied — gone is what it wanted.
  const del = R.reconcileIntent({ descriptor: { ...UPDATE_DESC, operation: 'delete' }, current: null });
  assert.equal(del.status, R.RECONCILIATION.ALREADY_SATISFIED);
});

test('RECONCILE — it reuses the existing verifier\'s comparator', () => {
  assert.match(read('agent/recovery/reconcile.js'), /import \{ diffWrite \}/,
    'reconciliation wrote its own comparison instead of reusing the verifier');
});

/* ------------------------------------------------------------------ *
 * DECISION — the four gates
 * ------------------------------------------------------------------ */

const decide = (over = {}) => R.decideRecovery({
  evidence: null, descriptor: UPDATE_DESC,
  history: { attempts: 1, replans: 0, recoverySteps: 0 },
  ...over,
});

test('DECISION — a transient fault on an idempotent update retries', () => {
  const d = decide({ error: { status: 503 } });
  assert.equal(d.decision, R.DECISIONS.RETRY);
  assert.equal(d.failure.kind, 'TRANSIENT');
  assert.equal(d.idempotency, 'IDEMPOTENT');
  assert.equal(d.recovery_action.type, 'retry_identical');
  assert.equal(d.approval_required, false);
  assert.equal(d.max_attempts, R.LIMITS.MAX_ATTEMPTS);
});

test('DECISION — THE SAME TRANSIENT FAULT ON A CREATE DOES NOT RETRY', () => {
  /*
   * The conjunction, demonstrated. The failure is identically benign; the
   * operation is not safely repeatable, so the answer changes completely.
   */
  const d = decide({ error: { status: 503 }, descriptor: CREATE_DESC });
  assert.equal(d.failure.kind, 'TRANSIENT');
  assert.equal(d.decision, R.DECISIONS.MANUAL_INTERVENTION);
  assert.equal(d.idempotency, 'NON_IDEMPOTENT');
  assert.match(d.reason, /NON_IDEMPOTENT/);
});

test('DECISION — a verification failure REPLANS; it never repeats the identical write', () => {
  const d = decide({ evidence: null, error: null, descriptor: UPDATE_DESC, cancelled: false });
  // Drive it explicitly through the verification signal.
  const v = R.decideRecovery({
    evidence: null, descriptor: UPDATE_DESC,
    history: { attempts: 1, replans: 0, recoverySteps: 0 },
    error: null,
  });
  void d; void v;
  const withVerification = R.decideRecovery({
    evidence: {
      task: { id: 't', state: { value: 'running' }, planState: { value: 'executing' }, failureReason: null },
      steps: [{ id: 'step_1', tool: 'update_record', capability: 'record_update', inputs: {}, verification: DROPPED('short_description', 'x'), verification_status: 'no-op', execution_status: 'failed', failureReason: null }],
      changes: [], builds: [], approval: { valid: true }, final: { status: 'FAILED' },
    },
    stepId: 'step_1',
    descriptor: UPDATE_DESC,
    history: { attempts: 1, replans: 0, recoverySteps: 0 },
  });
  assert.equal(withVerification.failure.kind, 'VERIFICATION');
  assert.equal(withVerification.decision, R.DECISIONS.REPLAN);
  assert.equal(withVerification.approval_required, true);
  assert.match(withVerification.reason, /cannot inherit the previous approval/);
});

test('DECISION — authorization and authentication STOP for a person, with no retry', () => {
  for (const status of [401, 403]) {
    const d = decide({ error: { status } });
    assert.equal(d.decision, R.DECISIONS.MANUAL_INTERVENTION);
    assert.equal(d.max_attempts, 0, 'a permission failure was given a retry budget');
  }
});

test('DECISION — a stale approval waits for a new one and never proceeds', () => {
  const d = decide({
    evidence: {
      task: { id: 't', state: { value: 'running' }, planState: { value: 'executing' }, failureReason: null },
      steps: [], changes: [], builds: [],
      approval: { valid: false, reason: 'approval_stale' }, final: { status: 'BLOCKED' },
    },
  });
  assert.equal(d.failure.kind, 'APPROVAL_STALE');
  assert.equal(d.decision, R.DECISIONS.WAIT_FOR_APPROVAL);
  assert.equal(d.approval_required, true);
  assert.equal(d.recovery_action.type, 'await_new_approval');
});

test('DECISION — cancellation stops, and is never recovered from', () => {
  const d = decide({ cancelled: true, error: { status: 503 } });
  assert.equal(d.failure.kind, 'CANCELLED');
  assert.equal(d.decision, R.DECISIONS.STOP);
  assert.match(d.reason, /no recovery attempt is started after a cancellation/);
});

test('DECISION — UNKNOWN and UNSUPPORTED stop', () => {
  assert.equal(decide({ failureReason: 'inexplicable' }).decision, R.DECISIONS.STOP);
  assert.equal(decide({
    capability: { name: 'script_execution', available: false, status: 'unsupported', reason: 'unsupported' },
  }).decision, R.DECISIONS.STOP);
});

/* ------------------------------------------------------------------ *
 * TIMEOUT — the duplicate-prevention path
 * ------------------------------------------------------------------ */

test('CASE A — timeout after a CREATE never retries, and never creates a duplicate', () => {
  const d = decide({ error: { status: 408 }, descriptor: CREATE_DESC });
  assert.equal(d.failure.kind, 'TIMEOUT');
  assert.notEqual(d.decision, R.DECISIONS.RETRY);
  assert.equal(d.decision, R.DECISIONS.MANUAL_INTERVENTION);
  assert.equal(d.idempotency, 'NON_IDEMPOTENT');
});

test('CASE B — timeout after an idempotent update whose effect is present does NOT mutate again', () => {
  const reconciliation = R.reconcileIntent({
    descriptor: UPDATE_DESC, current: { sys_id: 'a'.repeat(32), short_description: 'x' },
  });
  assert.equal(reconciliation.status, R.RECONCILIATION.ALREADY_SATISFIED);
  const d = decide({ error: { status: 408 }, reconciliation });
  assert.equal(d.decision, R.DECISIONS.STOP);
  assert.match(d.reason, /already_satisfied/);
});

test('TIMEOUT — a retry is REFUSED until reconciliation has been performed', () => {
  /*
   * The policy demands reconciliation first, and the decision layer enforces it
   * rather than trusting the caller to remember. Without a reconciliation there
   * is no evidence the effect is absent, and repeating on no evidence is the
   * duplicate-making move.
   */
  const d = decide({ error: { status: 408 }, reconciliation: null });
  assert.equal(d.decision, R.DECISIONS.STOP);
  assert.match(d.reason, /must be established before anything is repeated/);
  assert.equal(d.recovery_action.type, 'reconcile');
});

test('TIMEOUT — a reconciliation proving the effect ABSENT permits exactly one repeat', () => {
  const reconciliation = R.reconcileIntent({
    descriptor: UPDATE_DESC, current: { sys_id: 'a'.repeat(32), number: 'INC001' },
  });
  assert.equal(reconciliation.status, R.RECONCILIATION.NOT_APPLIED);
  const d = decide({ error: { status: 408 }, reconciliation });
  assert.equal(d.decision, R.DECISIONS.RETRY);
  assert.equal(d.recovery_action.type, 'retry_identical');
});

test('TIMEOUT — a DIVERGED reconciliation goes to a person, not to a retry', () => {
  const reconciliation = R.reconcileIntent({
    descriptor: { table: 'incident', operation: 'update', requested: { a: '1', b: '2' }, sys_id: 'a'.repeat(32) },
    current: { sys_id: 'a'.repeat(32), a: '1' },
  });
  const d = decide({ error: { status: 408 }, reconciliation });
  assert.equal(d.decision, R.DECISIONS.MANUAL_INTERVENTION);
});

/* ------------------------------------------------------------------ *
 * BOUNDED RETRY
 * ------------------------------------------------------------------ */

test('RETRY — the attempt limit is small, fixed, and enforced on stored state', () => {
  assert.equal(R.LIMITS.MAX_ATTEMPTS, 2);
  const first = decide({ error: { status: 503 }, history: { attempts: 1, replans: 0, recoverySteps: 0 } });
  assert.equal(first.decision, R.DECISIONS.RETRY);
  // At the limit, it stops — and says the budget is the reason.
  const atLimit = decide({ error: { status: 503 }, history: { attempts: 2, replans: 0, recoverySteps: 0 } });
  assert.equal(atLimit.decision, R.DECISIONS.STOP);
  assert.match(atLimit.reason, /recovery_budget_exhausted/);
  const past = decide({ error: { status: 503 }, history: { attempts: 99, replans: 0, recoverySteps: 0 } });
  assert.equal(past.decision, R.DECISIONS.STOP);
});

test('RETRY — an infinite loop is impossible by construction', () => {
  /*
   * The limit is compared against a count read from DURABLE state, not against
   * a flag a process could reset. Driving the decision repeatedly with a
   * growing history converges on STOP and stays there.
   */
  let attempts = 1;
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const d = decide({ error: { status: 503 }, history: { attempts, replans: 0, recoverySteps: attempts - 1 } });
    seen.push(d.decision);
    if (d.decision !== R.DECISIONS.RETRY) break;
    attempts += 1;
  }
  assert.ok(seen.filter((x) => x === R.DECISIONS.RETRY).length <= R.LIMITS.MAX_ATTEMPTS - 1,
    `retried ${seen.filter((x) => x === R.DECISIONS.RETRY).length} times`);
  assert.equal(seen[seen.length - 1], R.DECISIONS.STOP);
  // And no loop construct exists in the layer.
  for (const f of fs.readdirSync(path.join(SRC, 'agent', 'recovery')).filter((x) => x.endsWith('.js'))) {
    assert.doesNotMatch(read(`agent/recovery/${f}`), /while\s*\(\s*(!|true)/, `recovery/${f} contains an unbounded loop`);
  }
});

test('BUDGET — the re-plan and total-step budgets stop too, and say so', () => {
  const replanned = R.decideRecovery({
    evidence: {
      task: { id: 't', state: { value: 'running' }, planState: { value: 'executing' }, failureReason: null },
      steps: [{ id: 'step_1', tool: 'update_record', inputs: {}, verification: DROPPED('a', 'b'), verification_status: 'no-op', execution_status: 'failed' }],
      changes: [], builds: [], approval: { valid: true }, final: { status: 'FAILED' },
    },
    stepId: 'step_1', descriptor: UPDATE_DESC,
    history: { attempts: 1, replans: R.LIMITS.MAX_REPLANS, recoverySteps: 1 },
  });
  assert.equal(replanned.decision, R.DECISIONS.STOP);
  assert.match(replanned.reason, /recovery_budget_exhausted/);

  const exhausted = decide({ error: { status: 503 }, history: { attempts: 1, replans: 0, recoverySteps: R.LIMITS.MAX_RECOVERY_STEPS } });
  assert.equal(exhausted.decision, R.DECISIONS.STOP);
  assert.equal(exhausted.reason, 'recovery_budget_exhausted');
});

/* ------------------------------------------------------------------ *
 * DETERMINISM
 * ------------------------------------------------------------------ */

test('DETERMINISM — identical inputs produce an identical decision, every time', () => {
  const args = {
    error: { status: 503 }, descriptor: UPDATE_DESC,
    history: { attempts: 1, replans: 0, recoverySteps: 0 },
  };
  const a = R.decideRecovery(args);
  const b = R.decideRecovery(args);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.equal(a.decision, b.decision);
  assert.equal(a.failure.kind, b.failure.kind);
  assert.equal(a.max_attempts, b.max_attempts);
  assert.equal(a.approval_required, b.approval_required);
});

test('DETERMINISM — nothing in the layer reads the clock, randomness or a model', () => {
  for (const f of fs.readdirSync(path.join(SRC, 'agent', 'recovery')).filter((x) => x.endsWith('.js'))) {
    const src = read(`agent/recovery/${f}`);
    assert.doesNotMatch(src, /Math\.random/, `recovery/${f} uses randomness`);
    assert.doesNotMatch(src, /\bchatTurn\s*\(|\bchatOnce\s*\(|providers\//, `recovery/${f} reaches a model`);
  }
  // The decision layer specifically must not read the clock at all.
  for (const f of ['classification.js', 'policy.js', 'decision.js', 'idempotency.js', 'reconcile.js']) {
    assert.doesNotMatch(read(`agent/recovery/${f}`), /Date\.now\(\)|new Date\(\)/,
      `recovery/${f} reads the clock — a decision must not depend on when it was made`);
  }
});

/* ------------------------------------------------------------------ *
 * THE EXECUTOR — lineage, approval, cancellation, no false success
 * ------------------------------------------------------------------ */

test('EXECUTOR — a permitted retry runs through the EXISTING executor and records its lineage', async () => {
  const { taskId, sessionId } = approvedRun('retry me', [stepOf({ id: 'step_1' })]);
  failStep(taskId, 'step_1', { reason: 'ServiceNow returned 503' });

  let ran = 0;
  const res = await R.recoverStep({
    taskId, stepId: 'step_1', sessionId,
    error: { status: 503 },
    descriptor: UPDATE_DESC,
    executeStep: async () => { ran += 1; return { ok: true }; },
  });

  assert.equal(ran, 1, 'the existing executor was not invoked');
  assert.equal(res.outcome, R.OUTCOME.RECOVERED);
  // The lineage is durable, and shows BOTH the failure and the recovery.
  const history = P.recoveryHistory(taskId, 'step_1');
  assert.equal(history.attempts.length, 1);
  assert.equal(history.attempts[0].failureKind, 'TRANSIENT');
  assert.equal(history.attempts[0].decision, R.DECISIONS.RETRY);
  assert.equal(history.attempts[0].outcome, R.OUTCOME.RECOVERED);
  assert.ok(history.attempts[0].at, 'the attempt has no timestamp');
});

test('EXECUTOR — NO FALSE SUCCESS: a retry that executes without verifying is NOT_RECOVERED', () => {
  /*
   * The invariant restated for recovery: execution success is not verification
   * success. `executeStep` reports `ok` only when the read-back verified, and
   * recovery adds nothing to that judgement.
   */
  return (async () => {
    const { taskId, sessionId } = approvedRun('unverified retry', [stepOf({ id: 'step_1' })]);
    failStep(taskId, 'step_1', { reason: 'ServiceNow returned 503' });
    const res = await R.recoverStep({
      taskId, stepId: 'step_1', sessionId,
      error: { status: 503 }, descriptor: UPDATE_DESC,
      // The call completed; the effect did not verify.
      executeStep: async () => ({ ok: false, note: 'the write did not land as requested' }),
    });
    assert.equal(res.outcome, R.OUTCOME.NOT_RECOVERED);
    assert.notEqual(res.outcome, R.OUTCOME.RECOVERED);
    const h = P.recoveryHistory(taskId, 'step_1');
    assert.equal(h.attempts[0].outcome, R.OUTCOME.NOT_RECOVERED);
  })();
});

test('EXECUTOR — a re-plan is REPORTED, never silently executed', async () => {
  const { taskId, sessionId } = approvedRun('replan me', [stepOf({ id: 'step_1' })]);
  failStep(taskId, 'step_1', { verification: DROPPED('short_description', 'x'), reason: 'no-op' });

  let ran = 0;
  const res = await R.recoverStep({
    taskId, stepId: 'step_1', sessionId, descriptor: UPDATE_DESC,
    executeStep: async () => { ran += 1; return { ok: true }; },
  });

  assert.equal(ran, 0, 'a re-plan executed something');
  assert.equal(res.decision.decision, R.DECISIONS.REPLAN);
  assert.equal(res.decision.approval_required, true);
  assert.equal(res.outcome, R.OUTCOME.STOPPED);
});

test('EXECUTOR — CANCELLATION starts no new recovery attempt', async () => {
  const { taskId, sessionId } = approvedRun('cancel me', [stepOf({ id: 'step_1' })]);
  failStep(taskId, 'step_1', { reason: 'ServiceNow returned 503' });
  const controller = new AbortController();
  controller.abort();

  let ran = 0;
  const res = await R.recoverStep({
    taskId, stepId: 'step_1', sessionId,
    error: { status: 503 }, descriptor: UPDATE_DESC, signal: controller.signal,
    executeStep: async () => { ran += 1; return { ok: true }; },
  });

  assert.equal(ran, 0, 'a recovery attempt started after cancellation');
  assert.equal(res.outcome, R.OUTCOME.STOPPED);
  assert.equal(res.reason, 'cancelled');
  const h = P.recoveryHistory(taskId, 'step_1');
  assert.equal(h.attempts[0].outcome, R.OUTCOME.STOPPED);
});

test('EXECUTOR — a STALE APPROVAL stops a retry, even one policy would allow', async () => {
  const { taskId, sessionId } = approvedRun('stale', [stepOf({ id: 'step_1' })]);
  failStep(taskId, 'step_1', { reason: 'ServiceNow returned 503' });
  // The plan moves while the step is failing.
  P.savePlan(taskId, { goal: 'stale', steps: [stepOf({ id: 'step_1', operation: 'something else' })] });

  let ran = 0;
  const res = await R.recoverStep({
    taskId, stepId: 'step_1', sessionId,
    error: { status: 503 }, descriptor: UPDATE_DESC,
    executeStep: async () => { ran += 1; return { ok: true }; },
  });
  assert.equal(ran, 0, 'a retry executed under an approval that no longer described the plan');
  assert.equal(res.outcome, R.OUTCOME.AWAITING_APPROVAL);
});

test('EXECUTOR — recovery cannot approve itself', () => {
  /*
   * No exception. Recovery may produce WAIT_FOR_APPROVAL; it has no verb that
   * grants one, and no path to the resolver.
   */
  for (const f of fs.readdirSync(path.join(SRC, 'agent', 'recovery')).filter((x) => x.endsWith('.js'))) {
    const src = read(`agent/recovery/${f}`);
    assert.doesNotMatch(src, /\bresolveApproval\s*\(/, `recovery/${f} resolves an approval`);
    assert.doesNotMatch(src, /\bapprovePlan\s*\(/, `recovery/${f} approves a plan`);
    assert.doesNotMatch(src, /AUTO_APPROVE|autoApprove/, `recovery/${f} reaches auto-approve`);
  }
  assert.ok(!Object.values(R.DECISIONS).includes('AUTO_APPROVE'));
});

test('EXECUTOR — recovery survives a restart, and the lineage is reconstructable', async () => {
  const { taskId, sessionId } = approvedRun('restart', [stepOf({ id: 'step_1' })]);
  failStep(taskId, 'step_1', { reason: 'ServiceNow returned 503' });
  await R.recoverStep({
    taskId, stepId: 'step_1', sessionId,
    error: { status: 503 }, descriptor: UPDATE_DESC,
    executeStep: async () => ({ ok: true }),
  });
  const before = P.recoveryHistory(taskId, 'step_1');

  getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const reopened = migrate(new DatabaseSync(DB_FILE));
  _setDbForTests(reopened);
  try {
    assert.deepEqual(P.recoveryHistory(taskId, 'step_1'), before, 'the lineage changed across a restart');
  } finally {
    _setDbForTests(migrate(new DatabaseSync(DB_FILE)));
    reopened.close();
  }
});

test('EXECUTOR — recovery lineage lives on the step, so it survives chat deletion', async () => {
  const { taskId, sessionId } = approvedRun('outlive', [stepOf({ id: 'step_1' })]);
  failStep(taskId, 'step_1', { reason: 'ServiceNow returned 503' });
  await R.recoverStep({
    taskId, stepId: 'step_1', sessionId,
    error: { status: 503 }, descriptor: UPDATE_DESC, executeStep: async () => ({ ok: true }),
  });
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  const h = P.recoveryHistory(taskId, 'step_1');
  assert.equal(h.attempts.length, 1, 'deleting the chat destroyed the recovery lineage');
});

/* ------------------------------------------------------------------ *
 * ARCHITECTURE BOUNDARIES
 * ------------------------------------------------------------------ */

test('ARCHITECTURE — recovery is not a second mutation engine', () => {
  const IMPORT = /^[ \t]*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm;
  /*
   * The named forbidden modules. `servicenow/write-verify.js` is deliberately
   * NOT among them: it is the pure comparator, and reusing it is what stops
   * reconciliation from becoming a second verifier.
   */
  const FORBIDDEN = [
    /servicenow\/client\.js/, /execution-harness/, /servicenow\/fluent\.js/,
    /servicenow\/transport\.js/, /elevation-shim/, /role-elevation/,
    /agent\/write-guard\.js/, /agent\/mutation-pipeline\.js/, /memory\/ledger\.js/,
    /agent\/providers\//,
  ];
  for (const f of fs.readdirSync(path.join(SRC, 'agent', 'recovery')).filter((x) => x.endsWith('.js'))) {
    const src = read(`agent/recovery/${f}`);
    for (const m of src.matchAll(IMPORT)) {
      for (const bad of FORBIDDEN) {
        assert.ok(!bad.test(m[1]), `recovery/${f} imports ${m[1]}`);
      }
    }
    for (const bad of [
      /\btable\.(create|update|remove|del)\s*\(/, /\bexecuteTool\s*\(/, /\brunServerScript\s*\(/,
      /\brunGatedWrite\s*\(/, /\bappendMutation\s*\(/, /\binstallWorkspace\s*\(/,
      /\bINSERT\s+INTO\b/i, /\bDELETE\s+FROM\b/i,
    ]) {
      assert.doesNotMatch(src, bad, `recovery/${f} performs its own execution or write`);
    }
  }
});

test('ARCHITECTURE — recovery REUSES the existing verifier, evidence and plan store', () => {
  assert.match(read('agent/recovery/reconcile.js'), /write-verify\.js/, 'it does not reuse the verifier');
  assert.match(read('agent/recovery/executor.js'), /evidence\/index\.js/, 'it does not read Phase 5 evidence');
  assert.match(read('agent/recovery/executor.js'), /checkApprovalBinding/, 'it does not re-check the Phase 4 binding');
  assert.match(read('agent/recovery/executor.js'), /executeStep\(/, 'it does not delegate execution');
  // No second fingerprint algorithm, no second budget manager, no second provenance.
  for (const f of fs.readdirSync(path.join(SRC, 'agent', 'recovery')).filter((x) => x.endsWith('.js'))) {
    const src = read(`agent/recovery/${f}`);
    assert.doesNotMatch(src, /createHash|sha256/, `recovery/${f} computes its own fingerprint`);
    assert.doesNotMatch(src, /computeBudget\s*=|function computeBudget/, `recovery/${f} defines a budget manager`);
  }
});

test('ARCHITECTURE — nothing below the recovery layer imports it', () => {
  const IMPORT = /^[ \t]*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm;
  for (const dir of ['servicenow', 'memory', 'knowledge']) {
    for (const file of fs.readdirSync(path.join(SRC, dir))) {
      if (!file.endsWith('.js')) continue;
      for (const m of fs.readFileSync(path.join(SRC, dir, file), 'utf8').matchAll(IMPORT)) {
        assert.doesNotMatch(m[1], /agent\/recovery\//, `${dir}/${file} imports the recovery layer`);
      }
    }
  }
  // Phase 5 evidence must not depend on Phase 6 either — recovery reads it.
  for (const file of fs.readdirSync(path.join(SRC, 'agent', 'evidence'))) {
    assert.doesNotMatch(read(`agent/evidence/${file}`), /agent\/recovery\//,
      `evidence/${file} imports recovery — the arrow points the other way`);
  }
});

test('SECURITY — recovery evidence carries no credentials', async () => {
  const { taskId, sessionId } = approvedRun('secrets', [stepOf({
    id: 'step_1',
    inputs: { table: 'incident', sys_id: 'a'.repeat(32), password: 'hunter2', api_key: 'sk-live-DEAD' },
  })]);
  failStep(taskId, 'step_1', { reason: 'ServiceNow returned 503' });
  await R.recoverStep({
    taskId, stepId: 'step_1', sessionId,
    error: { status: 503, detail: { Authorization: 'Basic YWRtaW46aHVudGVyMg==' } },
    descriptor: UPDATE_DESC,
    executeStep: async () => ({ ok: true }),
  });

  // The lineage itself, and the Phase 5 projection that renders it.
  const lineage = JSON.stringify(P.recoveryHistory(taskId, 'step_1'));
  const evidence = JSON.stringify(E.buildEvidence(taskId));
  for (const secret of ['hunter2', 'sk-live-DEAD', 'YWRtaW46aHVudGVyMg==']) {
    assert.ok(!lineage.includes(secret), `${secret} reached the recovery lineage`);
    assert.ok(!evidence.includes(secret), `${secret} reached the evidence`);
  }
  assert.deepEqual(E.findSecrets(E.buildEvidence(taskId)), []);
});

/* ------------------------------------------------------------------ *
 * STEP 18 — the remaining ServiceNow safety cases
 * ------------------------------------------------------------------ */

test('CASE C — a transient READ failure retries', () => {
  const d = decide({ error: { status: 503 }, descriptor: null, evidence: null });
  // With no descriptor and a read-only step, the operation is trivially safe.
  const readStep = R.decideRecovery({
    evidence: {
      task: { id: 't', state: { value: 'running' }, planState: { value: 'executing' }, failureReason: null },
      steps: [{ id: 'step_1', tool: 'get_record', capability: 'record_read', inputs: {}, verification: null, execution_status: 'failed', failureReason: null }],
      changes: [], builds: [], approval: { valid: true }, final: { status: 'FAILED' },
    },
    stepId: 'step_1', error: { status: 503 },
    history: { attempts: 1, replans: 0, recoverySteps: 0 },
  });
  assert.equal(readStep.idempotency, 'READ_ONLY');
  assert.equal(readStep.decision, R.DECISIONS.RETRY);
  void d;
});

test('CASE G — a verification mismatch never guesses at a new mutation', () => {
  const d = R.decideRecovery({
    evidence: {
      task: { id: 't', state: { value: 'running' }, planState: { value: 'executing' }, failureReason: null },
      steps: [{
        id: 'step_1', tool: 'update_record', capability: 'record_update', inputs: {},
        verification: {
          status: 'partial', passed: false, summary: 'assignment_group was not stored',
          failed_assertions: [{ name: 'assignment_group', expected: 'Network Support', actual: 'Service Desk', passed: false }],
          applied: [], dropped: [{ field: 'assignment_group', requested: 'Network Support', actual: 'Service Desk' }], transformed: [],
        },
        verification_status: 'partial', execution_status: 'failed', failureReason: null,
      }],
      changes: [], builds: [], approval: { valid: true }, final: { status: 'FAILED' },
    },
    stepId: 'step_1', descriptor: UPDATE_DESC,
    history: { attempts: 1, replans: 0, recoverySteps: 0 },
  });
  assert.equal(d.failure.kind, 'VERIFICATION');
  assert.ok([R.DECISIONS.REPLAN, R.DECISIONS.STOP].includes(d.decision));
  assert.notEqual(d.decision, R.DECISIONS.RETRY, 'a verification mismatch was retried identically');
  assert.equal(d.approval_required, true);
});

test('CASE J — a build failure uses the existing build path only, and needs approval', () => {
  const d = R.decideRecovery({
    evidence: {
      task: { id: 't', state: { value: 'running' }, planState: { value: 'executing' }, failureReason: null },
      steps: [{ id: 'step_1', tool: 'create_flow_live', capability: 'flow_authoring', inputs: {}, verification: null, execution_status: 'failed', failureReason: null }],
      changes: [],
      builds: [{ id: 'r1', status: 'error', kind: 'flow', summary: 'compile failed', diagnostics: [{}] }],
      approval: { valid: true }, final: { status: 'FAILED' },
    },
    stepId: 'step_1',
    history: { attempts: 1, replans: 0, recoverySteps: 0 },
  });
  assert.equal(d.failure.kind, 'BUILD');
  assert.equal(d.decision, R.DECISIONS.REPLAN);
  assert.equal(d.approval_required, true);
});

test('an INSTALL failure stops rather than repeating a whole-application deploy', () => {
  const d = R.decideRecovery({
    evidence: {
      task: { id: 't', state: { value: 'running' }, planState: { value: 'executing' }, failureReason: null },
      steps: [{ id: 'step_1', tool: 'create_flow_live', capability: 'flow_authoring', inputs: {}, verification: null, execution_status: 'failed', failureReason: null }],
      changes: [],
      builds: [{ id: 'r1', status: 'error', kind: 'install', summary: 'install failed', diagnostics: [] }],
      approval: { valid: true }, final: { status: 'FAILED' },
    },
    stepId: 'step_1',
    history: { attempts: 1, replans: 0, recoverySteps: 0 },
  });
  assert.equal(d.failure.kind, 'INSTALL');
  assert.equal(d.decision, R.DECISIONS.STOP);
  assert.match(d.policy_rationale, /whole application/);
});
