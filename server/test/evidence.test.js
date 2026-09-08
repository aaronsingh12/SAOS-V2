/**
 * PHASE 5 — THE EVIDENCE READ MODEL.
 *
 *   node --test server/test/
 *
 * The claim: every agent operation is explainable and provable from durable
 * records alone. Most of these tests exist for the two ways that claim can be
 * quietly false.
 *
 * THE FIRST is treating execution as proof. A tool call that returned HTTP 200
 * is not a verified effect — this project exists because the Table API answers
 * 2xx for writes it silently discarded — so `execution_status` and
 * `verification_status` are separate fields and a promised effect with no
 * verification evidence is UNVERIFIED, never success.
 *
 * THE SECOND is letting the plan stand in for reality. A plan says what was
 * intended; a read-back says what is true. Where they disagree the read-back
 * wins and the disagreement is reported, because rewriting the plan to match
 * the outcome erases the only record that something went differently.
 *
 * Offline in full: durable rows are written directly, so the projection is
 * exercised against controlled state. No instance, no model, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-evid-'));
const DB_FILE = path.join(scratchDir, 'test.db');
_setDbForTests(migrate(new DatabaseSync(DB_FILE)));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'hunter2' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
});

const E = await import('../src/agent/evidence/index.js');
const P = await import('../src/agent/plan/index.js');
const { createTask, startTask, completeTask, failTask, cancelTask } = await import('../src/memory/tasks.js');
const { getDb } = await import('../src/memory/db.js');
const { recordToolEvent } = await import('../src/memory/sessions.js');
const { appendMutation } = await import('../src/memory/ledger.js');
const { APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

let n = 0;
const newSession = () => `evid-${++n}`;

function newTask(goal = 'do the thing') {
  const sid = newSession();
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const stepOf = (over = {}) => ({
  id: over.id ?? 'step_1',
  operation: over.operation ?? 'update the incident',
  capability: over.capability ?? 'record_update',
  tool: over.tool ?? 'update_record',
  mechanism: over.mechanism ?? 'rest',
  scope: over.scope ?? null,
  mutating: 'mutating' in over ? over.mutating : true,
  target: over.target ?? { table: 'incident', sys_id: 'a'.repeat(32) },
  inputs: over.inputs ?? { table: 'incident', sys_id: 'a'.repeat(32), data: { short_description: 'x' } },
  depends_on: over.depends_on ?? [],
  expected_effects: over.expected_effects ?? ['short_description is updated'],
  verification: 'verification' in over ? over.verification : { strategy: 'read_back', asserts: ['short_description'] },
});

/** A saved, approved plan, ready to have step outcomes written onto it. */
function approvedPlan(goal, steps) {
  const { taskId, sessionId } = newTask(goal);
  const saved = P.savePlan(taskId, { goal, steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  return { taskId, sessionId, fingerprint: saved.fingerprint };
}

/** Drive a step to a terminal state with a recorded outcome. */
function finishStep(taskId, stepId, { state = 'completed', result = null, verification = null, failureReason = null } = {}) {
  P.setStepState(taskId, stepId, 'ready');
  P.setStepState(taskId, stepId, 'executing');
  if (state === 'completed') P.setStepState(taskId, stepId, 'verifying');
  P.recordStepResult(taskId, stepId, { result, verification, failureReason });
  P.setStepState(taskId, stepId, state, failureReason ? { failure_reason: failureReason } : {});
}

const APPLIED = (field, value) => ({
  status: 'applied', summary: `${field} stored`, applied: [{ field, value }],
  dropped: [], transformed: [], unverifiable: [],
});
const DROPPED = (field, requested) => ({
  status: 'no-op', summary: `no-op: the platform discarded this write — ${field} unchanged`,
  applied: [], dropped: [{ field, requested, actual: null, reason: 'unchanged after the write' }],
  transformed: [], unverifiable: [],
});

/* ------------------------------------------------------------------ *
 * TASK AND REQUEST EVIDENCE
 * ------------------------------------------------------------------ */

test('a task that does not exist is a deterministic null, not an empty shell', () => {
  assert.equal(E.buildEvidence('no-such-task'), null);
  assert.equal(E.buildEvidence(''), null);
});

test('TASK — lifecycle timestamps and failure information are exposed', () => {
  const { taskId } = newTask('audit me');
  const running = E.buildEvidence(taskId);
  assert.equal(running.task.id, taskId);
  assert.equal(running.task.state.value, 'running');
  assert.equal(running.task.state.source, 'task');
  assert.ok(running.task.createdAt && running.task.startedAt);
  assert.equal(running.task.completedAt, null);

  completeTask(taskId);
  const done = E.buildEvidence(taskId);
  assert.equal(done.task.state.value, 'completed');
  assert.ok(done.task.completedAt);

  const { taskId: failed } = newTask('fail me');
  failTask(failed, 'the instance refused');
  const f = E.buildEvidence(failed);
  assert.equal(f.task.failureReason, 'the instance refused');
});

test('REQUEST — the user\'s own words are authoritative, never a model paraphrase', () => {
  const { taskId } = newTask('Create a P1 incident flow for the network team');
  const e = E.buildEvidence(taskId);
  assert.equal(e.request.text, 'Create a P1 incident flow for the network team');
  assert.equal(e.request.source, 'task');
  // The goal column cannot be compacted away; the transcript can.
  assert.equal(e.request.compactable, false);
});

/* ------------------------------------------------------------------ *
 * PLAN EVIDENCE
 * ------------------------------------------------------------------ */

test('PLAN — the plan, its fingerprint and its ordered steps are reconstructed', () => {
  const { taskId, fingerprint } = approvedPlan('build it', [
    stepOf({ id: 'step_1', operation: 'read the schema', capability: 'record_read', tool: 'get_table_schema', mutating: false, verification: null, expected_effects: [] }),
    stepOf({ id: 'step_2', depends_on: ['step_1'], scope: 'x_2002152_nwforge' }),
  ]);
  const e = E.buildEvidence(taskId);

  assert.equal(e.plan.goal, 'build it');
  assert.equal(e.plan.fingerprint, fingerprint);
  assert.equal(e.plan.stepCount, 2);
  assert.deepEqual(e.plan.order, ['step_1', 'step_2']);
  assert.ok(e.plan.capabilities.includes('record_read'));
  assert.ok(e.plan.mechanisms.includes('rest'));
  assert.ok(e.plan.scopes.includes('x_2002152_nwforge'));
  assert.equal(e.plan.source, 'plan');

  assert.equal(e.steps.length, 2);
  assert.equal(e.steps[0].id, 'step_1');
  assert.deepEqual(e.steps[1].dependsOn, ['step_1']);
  assert.equal(e.steps[1].capability, 'record_update');
  assert.equal(e.steps[1].mutating, true);
});

test('PLAN — steps are ordered by the durable SEQUENCE, not by timestamp', () => {
  /*
   * A fast plan writes several steps inside one millisecond, so `created_at`
   * cannot order them. `sequence` is allocated from MAX+1 inside the insert and
   * is UNIQUE per task, which is why the projection uses it.
   */
  const { taskId } = approvedPlan('order me', [
    stepOf({ id: 'a' }), stepOf({ id: 'b' }), stepOf({ id: 'c' }),
  ]);
  const e = E.buildEvidence(taskId);
  assert.deepEqual(e.steps.map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(e.steps.map((s) => s.sequence), [1, 2, 3]);
  // Same timestamps, same answer, every time.
  assert.deepEqual(E.buildEvidence(taskId).steps.map((s) => s.id), ['a', 'b', 'c']);
  assert.match(read('agent/evidence/read-model.js'), /ORDER BY sequence ASC/);
});

/* ------------------------------------------------------------------ *
 * APPROVAL EVIDENCE
 * ------------------------------------------------------------------ */

test('APPROVAL — an approved plan reports the fingerprint that was approved, and that it is valid', () => {
  const { taskId, fingerprint } = approvedPlan('approve me', [stepOf()]);
  const a = E.buildEvidence(taskId).approval;
  assert.equal(a.required, true);
  assert.equal(a.status, 'approved');
  assert.equal(a.approved_fingerprint, fingerprint);
  assert.equal(a.current_fingerprint, fingerprint);
  assert.equal(a.valid, true);
  assert.equal(a.approved_source, APPROVAL_SOURCES.USER_CLICK);
  assert.equal(a.source, 'approval');
});

test('APPROVAL — A CHANGED PLAN SHOWS AS STALE, and is never reinterpreted as valid', () => {
  /*
   * The Phase 4 invariant, made visible in the evidence. A run whose plan moved
   * after approval must not read as authorised — the thing authorised was
   * something else.
   */
  const { taskId, fingerprint } = approvedPlan('change me', [stepOf({ operation: 'update the description' })]);
  const changed = P.savePlan(taskId, { goal: 'change me', steps: [stepOf({ operation: 'DELETE the incident' })] });
  assert.notEqual(changed.fingerprint, fingerprint);

  const a = E.buildEvidence(taskId).approval;
  assert.equal(a.status, 'approved', 'an approval WAS granted, and that stays true');
  assert.equal(a.approved_fingerprint, fingerprint);
  assert.equal(a.current_fingerprint, changed.fingerprint);
  assert.equal(a.valid, false, 'a stale approval was reported as valid');
  assert.equal(a.reason, 'approval_stale');
  assert.match(a.note, /does not describe what would run now/);

  // And it surfaces as an uncertainty rather than only as a field.
  assert.ok(E.buildEvidence(taskId).uncertainties.some((u) => u.kind === 'approval_stale'));
});

test('APPROVAL — never approved, and rejected, are distinct states', () => {
  const { taskId } = newTask('never approved');
  P.savePlan(taskId, { goal: 'never approved', steps: [stepOf()] });
  const never = E.buildEvidence(taskId).approval;
  assert.equal(never.status, 'not_approved');
  assert.equal(never.valid, false);
  assert.equal(never.approved_fingerprint, null);

  const { taskId: rej } = newTask('rejected');
  P.savePlan(rej, { goal: 'rejected', steps: [stepOf()] });
  P.setPlanState(rej, 'ready');
  P.setPlanState(rej, 'awaiting_approval');
  P.setPlanState(rej, 'failed', { failure_reason: 'The plan was rejected. Nothing ran, and it will not be retried.' });
  const r = E.buildEvidence(rej).approval;
  assert.equal(r.status, 'rejected');
  assert.equal(r.valid, false);
});

test('APPROVAL — the staleness check reuses Phase 4 logic rather than reimplementing it', () => {
  assert.match(read('agent/evidence/builder.js'), /import \{ fingerprintMatches \} from '\.\.\/plan\/fingerprint\.js'/);
  // And no second comparison of its own.
  assert.doesNotMatch(read('agent/evidence/builder.js'), /approved_fingerprint\s*===\s*/);
});

/* ------------------------------------------------------------------ *
 * STEP AND EXECUTION EVIDENCE
 * ------------------------------------------------------------------ */

test('STEP — execution status and verification status are SEPARATE, and HTTP 200 is not verification', () => {
  /*
   * The central distinction. A step can be executed and unverified, and
   * collapsing the two is how "it returned 200" becomes "it worked".
   */
  const { taskId } = approvedPlan('two statuses', [stepOf({ id: 'step_1' })]);
  finishStep(taskId, 'step_1', {
    state: 'completed',
    result: { sys_id: 'a'.repeat(32) },
    // The tool succeeded; the verifier could not confirm the effect.
    verification: { status: 'unverified', summary: 'the write could not be verified', applied: [], dropped: [], transformed: [], unverifiable: [{ field: '(all)', reason: 'unreachable' }] },
  });
  const s = E.buildEvidence(taskId).steps[0];
  assert.equal(s.execution_status, 'completed');
  assert.equal(s.verification_status, 'unverified');
  assert.notEqual(s.execution_status, s.verification_status);
  assert.equal(s.executed, true);
  assert.equal(s.verification.passed, null, 'an unverified write was scored as passed or failed');
});

test('STEP — a verified write reports its applied fields as passing assertions', () => {
  const { taskId } = approvedPlan('verified', [stepOf({ id: 'step_1' })]);
  finishStep(taskId, 'step_1', {
    result: { sys_id: 'a'.repeat(32), short_description: 'x' },
    verification: APPLIED('short_description', 'x'),
  });
  const s = E.buildEvidence(taskId).steps[0];
  assert.equal(s.verification_status, 'applied');
  assert.equal(s.verification.passed, true);
  assert.equal(s.verification.assertions.length, 1);
  assert.equal(s.verification.assertions[0].name, 'short_description');
  assert.equal(s.verification.assertions[0].passed, true);
  assert.equal(s.verification.assertions[0].source, 'service_now_readback');
});

test('STEP — FAILED ASSERTIONS ARE NOT HIDDEN because the call succeeded', () => {
  const { taskId } = approvedPlan('dropped', [stepOf({ id: 'step_1' })]);
  finishStep(taskId, 'step_1', {
    // The tool returned normally. The platform discarded the write.
    result: { sys_id: 'a'.repeat(32) },
    verification: DROPPED('short_description', 'NEW VALUE'),
  });
  const e = E.buildEvidence(taskId);
  const s = e.steps[0];
  assert.equal(s.execution_status, 'completed', 'the call did complete');
  assert.equal(s.verification.passed, false);
  assert.equal(s.verification.failed_assertions.length, 1);
  assert.equal(s.verification.failed_assertions[0].name, 'short_description');
  assert.equal(s.verification.failed_assertions[0].expected, 'NEW VALUE');
  assert.equal(s.verification.failed_assertions[0].passed, false);
  // And the run is FAILED, not "completed with a note".
  assert.equal(e.final.status, E.STATUS.FAILED);
});

test('STEP — a self-reported read-back is flagged as such, not treated as independent proof', () => {
  const { taskId } = approvedPlan('self', [stepOf({ id: 'step_1' })]);
  finishStep(taskId, 'step_1', {
    result: { ok: true },
    verification: { status: 'self-verified', summary: 'the tool reports its own read-back', applied: [], dropped: [], transformed: [], unverifiable: [] },
  });
  const e = E.buildEvidence(taskId);
  assert.equal(e.steps[0].verification.passed, null);
  assert.match(e.steps[0].verification.note, /no independent diff/);
  assert.ok(e.uncertainties.some((u) => u.kind === 'self_reported_verification'));
});

test('STEP — a failed step carries its reason', () => {
  const { taskId } = approvedPlan('boom', [stepOf({ id: 'step_1' })]);
  finishStep(taskId, 'step_1', { state: 'failed', failureReason: 'ServiceNow said no' });
  const s = E.buildEvidence(taskId).steps[0];
  assert.equal(s.execution_status, 'failed');
  assert.equal(s.failureReason, 'ServiceNow said no');
});

/* ------------------------------------------------------------------ *
 * SERVICENOW CHANGE EVIDENCE
 * ------------------------------------------------------------------ */

test('CHANGES — table, sys_id, number, operation and changed fields come from the ledger', () => {
  const { taskId, sessionId } = approvedPlan('change it', [stepOf({ id: 'step_1' })]);
  appendMutation({
    sessionId, turnSeq: 0, tool: 'update_record',
    descriptor: { table: 'incident', operation: 'update', requested: { short_description: 'x' }, sys_id: 'a'.repeat(32) },
    result: { sys_id: 'a'.repeat(32), number: 'INC0010042' },
    verification: APPLIED('short_description', 'x'),
    approval: 'approved', approvedSource: APPROVAL_SOURCES.USER_CLICK, approvedAt: new Date().toISOString(),
  });
  const c = E.buildEvidence(taskId).changes;
  assert.equal(c.length, 1);
  assert.equal(c[0].table, 'incident');
  assert.equal(c[0].sys_id, 'a'.repeat(32));
  assert.equal(c[0].number, 'INC0010042');
  assert.deepEqual(c[0].changed_fields, ['short_description']);
  assert.equal(c[0].verification_status, 'applied');
  assert.equal(c[0].approval.approval, 'approved');
  assert.equal(c[0].source, 'mutation_ledger');
});

test('CHANGES — before_state is reported UNAVAILABLE, never reconstructed from a guess', () => {
  /*
   * The pre-write snapshot is consumed by the verifier to compute the diff and
   * is not persisted. Inventing one from the requested values would be a guess
   * presented as a record — so the evidence says it is unavailable and why.
   */
  const { taskId, sessionId } = approvedPlan('before', [stepOf({ id: 'step_1' })]);
  appendMutation({
    sessionId, turnSeq: 0, tool: 'update_record',
    descriptor: { table: 'incident', operation: 'update', requested: { short_description: 'x' }, sys_id: 'b'.repeat(32) },
    result: { sys_id: 'b'.repeat(32) },
    verification: APPLIED('short_description', 'x'),
    approval: 'approved',
  });
  const c = E.buildEvidence(taskId).changes[0];
  assert.equal(c.before_state, 'unavailable');
  assert.match(c.before_state_note, /not persisted/);
  assert.match(c.before_state_note, /rather than reconstructed/);
  // The AFTER state is real, because the read-back produced it.
  assert.deepEqual(c.after_state, { short_description: 'x' });
});

test('CHANGES — dropped and transformed fields are itemised apart from applied ones', () => {
  const { taskId, sessionId } = approvedPlan('mixed', [stepOf({ id: 'step_1' })]);
  appendMutation({
    sessionId, turnSeq: 0, tool: 'update_record',
    descriptor: { table: 'incident', operation: 'update', requested: { a: '1', b: '2', priority: '1' }, sys_id: 'c'.repeat(32) },
    result: { sys_id: 'c'.repeat(32) },
    verification: {
      status: 'partial', summary: 'partial',
      applied: [{ field: 'a', value: '1' }],
      dropped: [{ field: 'b', requested: '2', actual: null, reason: 'unchanged' }],
      transformed: [{ field: 'priority', requested: '1', actual: '4' }],
      unverifiable: [],
    },
    approval: 'approved',
  });
  const e = E.buildEvidence(taskId);
  const c = e.changes[0];
  assert.deepEqual(c.changed_fields, ['a']);
  assert.deepEqual(c.dropped_fields, ['b']);
  assert.deepEqual(c.transformed_fields, ['priority']);
  // A transformed write is an uncertainty a reader must see.
  assert.ok(e.uncertainties.some((u) => u.kind === 'transformed_write'));
});

/* ------------------------------------------------------------------ *
 * BUILD EVIDENCE
 * ------------------------------------------------------------------ */

test('BUILD — a failed build is never reported as deployed', () => {
  const { taskId, sessionId } = approvedPlan('build it', [stepOf({ id: 'step_1', capability: 'flow_authoring', mechanism: 'sdk' })]);
  const runId = 'run-' + taskId.slice(0, 8);
  const ts = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO build_runs (id, kind, label, instance, actor, session, status, request, summary, dropped, started, finished)
     VALUES (?, 'flow', 'Handle P1', 'https://dev424910.service-now.com', 'admin', ?, 'error', '{}', 'the build failed', 0, ?, ?)`,
  ).run(runId, sessionId, ts, ts);
  getDb().prepare(
    "INSERT INTO build_events (run, seq, type, payload, ts) VALUES (?, 1, 'diagnostic', ?, ?)",
  ).run(runId, JSON.stringify({ message: 'TS2304: cannot find name' }), ts);

  const b = E.buildEvidence(taskId).builds;
  assert.equal(b.length, 1);
  assert.equal(b[0].status, 'error');
  assert.equal(b[0].deployed, false, 'a failed build was reported as deployed');
  assert.equal(b[0].diagnostics.length, 1);
  assert.match(JSON.stringify(b[0].diagnostics), /TS2304/);
  assert.equal(b[0].source, 'build_event');
});

/* ------------------------------------------------------------------ *
 * PROMISED-EFFECT COVERAGE
 * ------------------------------------------------------------------ */

test('EFFECTS — a promised effect with NO verification evidence is unverified, not success', () => {
  /*
   * The existing invariant, applied to a finished run: every promised effect
   * must have evidence, and its absence is reported as an absence.
   */
  const { taskId } = approvedPlan('promise', [stepOf({
    id: 'step_1',
    expected_effects: ['short_description is updated', 'the caller is notified'],
  })]);
  finishStep(taskId, 'step_1', {
    result: { sys_id: 'a'.repeat(32) },
    verification: { status: 'unverified', summary: 'could not check', applied: [], dropped: [], transformed: [], unverifiable: [] },
  });
  const e = E.buildEvidence(taskId);
  assert.equal(e.verification.promised, 2);
  assert.equal(e.verification.verified, 0);
  assert.equal(e.verification.unverified, 2);
  for (const eff of e.verification.effects) {
    assert.equal(eff.verified, null, 'an unproven effect was scored');
    assert.match(eff.note, /no verification evidence/);
  }
  assert.equal(e.final.status, E.STATUS.UNVERIFIED);
  assert.equal(e.verification.coverage, 0);
});

test('EFFECTS — every promised effect appears, and each names its step', () => {
  const { taskId } = approvedPlan('many', [
    stepOf({ id: 'step_1', expected_effects: ['a', 'b'] }),
    stepOf({ id: 'step_2', expected_effects: ['c'] }),
  ]);
  const e = E.buildEvidence(taskId);
  assert.deepEqual(e.verification.effects.map((x) => x.effect), ['a', 'b', 'c']);
  assert.deepEqual(e.verification.effects.map((x) => x.step), ['step_1', 'step_1', 'step_2']);
});

/* ------------------------------------------------------------------ *
 * FINAL STATUS — all six
 * ------------------------------------------------------------------ */

test('FINAL — VERIFIED when every promised effect passed', () => {
  const { taskId } = approvedPlan('all good', [stepOf({ id: 'step_1', expected_effects: ['short_description is updated'] })]);
  finishStep(taskId, 'step_1', { result: { sys_id: 'a'.repeat(32) }, verification: APPLIED('short_description', 'x') });
  P.setPlanState(taskId, 'completed');
  completeTask(taskId);
  const e = E.buildEvidence(taskId);
  assert.equal(e.final.status, E.STATUS.VERIFIED);
  assert.match(e.final.reason, /all 1 promised effect/);
});

test('FINAL — PARTIALLY_VERIFIED when some passed and others have no evidence', () => {
  const { taskId } = approvedPlan('half', [
    stepOf({ id: 'step_1', expected_effects: ['short_description is updated'] }),
    stepOf({ id: 'step_2', expected_effects: ['the caller is notified'] }),
  ]);
  finishStep(taskId, 'step_1', { result: { ok: true }, verification: APPLIED('short_description', 'x') });
  finishStep(taskId, 'step_2', {
    result: { ok: true },
    verification: { status: 'unverified', summary: 'not checked', applied: [], dropped: [], transformed: [], unverifiable: [] },
  });
  const e = E.buildEvidence(taskId);
  assert.equal(e.final.status, E.STATUS.PARTIALLY_VERIFIED);
  assert.equal(e.verification.verified, 1);
  assert.equal(e.verification.unverified, 1);
});

test('FINAL — UNVERIFIED when execution happened and nothing was proven', () => {
  const { taskId } = approvedPlan('unproven', [stepOf({ id: 'step_1', expected_effects: ['something happens'] })]);
  finishStep(taskId, 'step_1', {
    result: { ok: true },
    verification: { status: 'unverified', summary: 'x', applied: [], dropped: [], transformed: [], unverifiable: [] },
  });
  assert.equal(E.buildEvidence(taskId).final.status, E.STATUS.UNVERIFIED);
});

test('FINAL — FAILED when a step failed, or when a checked effect did not hold', () => {
  const { taskId } = approvedPlan('step failed', [stepOf({ id: 'step_1' })]);
  finishStep(taskId, 'step_1', { state: 'failed', failureReason: 'boom' });
  const a = E.buildEvidence(taskId);
  assert.equal(a.final.status, E.STATUS.FAILED);
  assert.match(a.final.reason, /step_1/);

  const { taskId: b } = approvedPlan('effect failed', [stepOf({ id: 'step_1', expected_effects: ['short_description is updated'] })]);
  finishStep(b, 'step_1', { result: { ok: true }, verification: DROPPED('short_description', 'x') });
  assert.equal(E.buildEvidence(b).final.status, E.STATUS.FAILED);
});

test('FINAL — CANCELLED when the run was stopped', () => {
  const { taskId } = approvedPlan('stop', [stepOf({ id: 'step_1' })]);
  P.setStepState(taskId, 'step_1', 'cancelled');
  P.setPlanState(taskId, 'cancelled');
  cancelTask(taskId);
  const e = E.buildEvidence(taskId);
  assert.equal(e.final.status, E.STATUS.CANCELLED);
  assert.match(e.final.reason, /cancelled/);
});

test('FINAL — BLOCKED when a control refused, and it is not called a failure', () => {
  /*
   * BLOCKED is not a defect: the platform correctly refused to proceed. The two
   * need different responses — a failure wants diagnosis, a block wants a
   * decision from a person.
   */
  const { taskId } = newTask('blocked');
  P.savePlan(taskId, { goal: 'blocked', steps: [stepOf({ id: 'step_1' })] });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.setPlanState(taskId, 'failed', { failure_reason: 'not_approved' });
  failTask(taskId, 'not_approved');
  const e = E.buildEvidence(taskId);
  assert.equal(e.final.status, E.STATUS.BLOCKED);
  assert.notEqual(e.final.status, E.STATUS.FAILED);

  // A stale approval is also a block, not a failure.
  const { taskId: stale } = approvedPlan('stale', [stepOf({ id: 'step_1' })]);
  P.savePlan(stale, { goal: 'stale', steps: [stepOf({ id: 'step_1', operation: 'something else' })] });
  P.setPlanState(stale, 'failed', { failure_reason: 'approval_stale' });
  assert.equal(E.buildEvidence(stale).final.status, E.STATUS.BLOCKED);
});

test('FINAL — the status is decided by rule, not by a model, and covers all six', () => {
  assert.deepEqual([...E.STATUSES].sort(), [
    'BLOCKED', 'CANCELLED', 'FAILED', 'PARTIALLY_VERIFIED', 'UNVERIFIED', 'VERIFIED',
  ]);
  // Pure: same facts, same word.
  const facts = { planState: 'completed', taskState: 'completed', steps: [], effects: [{ verified: true }], executedAnything: true };
  assert.equal(E.decideStatus(facts).status, E.decideStatus(facts).status);
  for (const f of ['agent/evidence/status.js', 'agent/evidence/builder.js', 'agent/evidence/read-model.js']) {
    assert.doesNotMatch(read(f), /chatTurn|chatOnce|providers\//, `${f} consults a model`);
  }
});

/* ------------------------------------------------------------------ *
 * TRUTH HIERARCHY
 * ------------------------------------------------------------------ */

test('TRUTH — the read-back beats the plan, and the plan is never rewritten to match', () => {
  /*
   * The plan intended Network Support; the instance stored Service Desk. The
   * evidence must report expected/actual/failed — and the plan must still say
   * what it said, because rewriting it erases the only record that something
   * went differently than intended.
   */
  const { taskId } = approvedPlan('assign it', [stepOf({
    id: 'step_1',
    inputs: { table: 'incident', sys_id: 'a'.repeat(32), data: { assignment_group: 'Network Support' } },
    expected_effects: ['assignment_group is Network Support'],
  })]);
  finishStep(taskId, 'step_1', {
    result: { sys_id: 'a'.repeat(32), assignment_group: 'Service Desk' },
    verification: {
      status: 'partial', summary: 'assignment_group was not stored as requested',
      applied: [], transformed: [], unverifiable: [],
      dropped: [{ field: 'assignment_group', requested: 'Network Support', actual: 'Service Desk', reason: 'the platform stored a different value' }],
    },
  });

  const e = E.buildEvidence(taskId);
  const failed = e.steps[0].verification.failed_assertions[0];
  assert.equal(failed.name, 'assignment_group');
  assert.equal(failed.expected, 'Network Support');
  assert.equal(failed.actual, 'Service Desk');
  assert.equal(failed.passed, false);
  assert.equal(failed.source, 'service_now_readback');

  // The PLAN still says what it planned.
  assert.equal(e.steps[0].inputs.data.assignment_group, 'Network Support',
    'the plan was rewritten to match the result');
  assert.equal(e.final.status, E.STATUS.FAILED);
});

test('TRUTH — an approved plan does not become reality merely by being approved', () => {
  const { taskId } = approvedPlan('approved only', [stepOf({ id: 'step_1', expected_effects: ['it happened'] })]);
  const e = E.buildEvidence(taskId);
  assert.equal(e.approval.valid, true, 'the approval is genuinely valid');
  // ...and nothing ran, so nothing is verified.
  assert.equal(e.verification.verified, 0);
  assert.notEqual(e.final.status, E.STATUS.VERIFIED);
  assert.equal(e.steps[0].executed, false);
});

/* ------------------------------------------------------------------ *
 * SECRETS
 * ------------------------------------------------------------------ */

test('SECRETS — credentials never appear in evidence, whatever shape they arrive in', () => {
  const { taskId } = approvedPlan('secrets', [stepOf({
    id: 'step_1',
    inputs: {
      table: 'incident',
      password: 'hunter2',
      apiKey: 'sk-live-abcdefghijklmnop',
      client_secret: 'shhh',
      nested: { Authorization: 'Basic YWRtaW46aHVudGVyMg==', token: 'tok_123456789' },
      innocent: 'this should survive',
    },
  })]);
  finishStep(taskId, 'step_1', {
    result: { headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' }, ok: true },
    verification: APPLIED('x', 'y'),
  });

  const e = E.buildEvidence(taskId);
  const json = JSON.stringify(e);
  for (const secret of ['hunter2', 'sk-live-abcdefghijklmnop', 'shhh', 'YWRtaW46aHVudGVyMg==', 'tok_123456789', 'eyJhbGciOiJIUzI1NiJ9']) {
    assert.ok(!json.includes(secret), `the secret ${secret} reached the evidence object`);
  }
  // Redaction leaves a marker, so a reader can tell absent from hidden.
  assert.equal(e.steps[0].inputs.password, E.REDACTED);
  assert.equal(e.steps[0].inputs.nested.token, E.REDACTED);
  assert.equal(e.steps[0].inputs.innocent, 'this should survive');
  // The assertion side of the same rule.
  assert.deepEqual(E.findSecrets(e), []);
});

test('SECRETS — redaction is server-side, and the checker agrees with the redactor', () => {
  const dirty = { password: 'p', a: { api_key: 'k' }, list: [{ Authorization: 'Bearer abcdefghij' }] };
  assert.ok(E.findSecrets(dirty).length >= 3, 'the checker missed a planted secret');
  assert.deepEqual(E.findSecrets(E.redact(dirty)), [], 'the redactor left something the checker finds');
  /*
   * Redaction happens in the PROJECTION, not in a renderer. A UI that hides a
   * secret is a UI that has already received it, so the builder must call the
   * redactor on every field that carries arbitrary JSON.
   */
  const builder = read('agent/evidence/builder.js');
  assert.match(builder, /redact\(step\.inputs\)/, 'step inputs are not redacted');
  assert.match(builder, /redact\(step\.result\)/, 'step results are not redacted');
  assert.match(builder, /redact\(m\.requested\)/, 'ledger payloads are not redacted');
});

/* ------------------------------------------------------------------ *
 * PERSISTENCE, DETERMINISM, SESSION INDEPENDENCE
 * ------------------------------------------------------------------ */

test('DETERMINISM — the same database yields the same evidence, twice', () => {
  const { taskId } = approvedPlan('deterministic', [
    stepOf({ id: 'step_1' }), stepOf({ id: 'step_2', depends_on: ['step_1'] }),
  ]);
  finishStep(taskId, 'step_1', { result: { ok: true }, verification: APPLIED('short_description', 'x') });
  const a = E.buildEvidence(taskId);
  const b = E.buildEvidence(taskId);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test('PERSISTENCE — evidence survives a process restart, byte for byte', () => {
  const { taskId } = approvedPlan('restart me', [stepOf({ id: 'step_1', expected_effects: ['it worked'] })]);
  finishStep(taskId, 'step_1', { result: { sys_id: 'a'.repeat(32) }, verification: APPLIED('short_description', 'x') });
  P.setPlanState(taskId, 'completed');
  completeTask(taskId);
  const before = JSON.parse(JSON.stringify(E.buildEvidence(taskId)));

  // A genuine restart: the file is reopened through the real migration path and
  // the read model is pointed at the new handle.
  getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const reopened = migrate(new DatabaseSync(DB_FILE));
  _setDbForTests(reopened);
  try {
    const after = JSON.parse(JSON.stringify(E.buildEvidence(taskId)));
    assert.deepEqual(after, before, 'evidence changed across a restart');
    assert.equal(after.final.status, E.STATUS.VERIFIED);
  } finally {
    // Put the original handle back for the rest of the file.
    _setDbForTests(migrate(new DatabaseSync(DB_FILE)));
    reopened.close();
  }
});

test('SESSION INDEPENDENCE — evidence survives the conversation being deleted', () => {
  /*
   * Phase 1 deliberately gave tasks no foreign key to sessions so the record of
   * what the agent did outlives the chat. Compaction rewrites `messages` and
   * touches nothing else, and deleting a chat must not take the evidence.
   */
  const { taskId, sessionId } = approvedPlan('outlive the chat', [stepOf({ id: 'step_1', expected_effects: ['it worked'] })]);
  finishStep(taskId, 'step_1', { result: { sys_id: 'a'.repeat(32) }, verification: APPLIED('short_description', 'x') });
  const before = E.buildEvidence(taskId);
  assert.equal(before.task.session.exists, true);

  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

  const after = E.buildEvidence(taskId);
  assert.ok(after, 'deleting the chat destroyed the evidence');
  assert.equal(after.task.session.exists, false, 'the evidence did not notice the chat was gone');
  // The important half: everything durable is still there.
  assert.equal(after.request.text, 'outlive the chat', 'the original request was lost with the chat');
  assert.equal(after.plan.fingerprint, before.plan.fingerprint);
  assert.equal(after.steps.length, 1);
  assert.equal(after.final.status, before.final.status);
});

test('SESSION INDEPENDENCE — compaction cannot remove evidence', () => {
  const { taskId, sessionId } = approvedPlan('compact me', [stepOf({ id: 'step_1' })]);
  finishStep(taskId, 'step_1', { result: { ok: true }, verification: APPLIED('a', 'b') });
  // Compaction rewrites `messages` and `chunks`. Simulate the worst case.
  getDb().prepare('DELETE FROM messages WHERE session = ?').run(sessionId);
  const e = E.buildEvidence(taskId);
  assert.equal(e.request.text, 'compact me', 'the request was lost to compaction');
  assert.equal(e.steps.length, 1);
  assert.ok(e.plan.fingerprint);
});

/* ------------------------------------------------------------------ *
 * ARCHITECTURE BOUNDARIES
 * ------------------------------------------------------------------ */

test('ARCHITECTURE — the evidence layer is a READ MODEL and cannot execute or mutate', () => {
  const IMPORT = /^[ \t]*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm;
  const FORBIDDEN = [
    /servicenow\//,                       // the whole execution layer
    /agent\/plan\/executor\.js/,
    /agent\/orchestrator\.js/, /agent\/write-guard\.js/, /agent\/mutation-pipeline\.js/,
    /agent\/providers\//, /memory\/compaction\.js/,
  ];
  const files = fs.readdirSync(path.join(SRC, 'agent', 'evidence')).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 5, 'the evidence layer files were not found');
  for (const f of files) {
    const src = read(`agent/evidence/${f}`);
    for (const m of src.matchAll(IMPORT)) {
      for (const bad of FORBIDDEN) {
        assert.ok(!bad.test(m[1]), `evidence/${f} imports ${m[1]} — it is a read model`);
      }
    }
    // Nor may it CALL a writer.
    for (const bad of [
      /\btable\.(create|update|remove|del)\s*\(/, /\bexecuteTool\s*\(/, /\bresolveApproval\s*\(/,
      /\brunGatedWrite\s*\(/, /\bappendMutation\s*\(/, /\brecordToolEvent\s*\(/,
      /\bsetPlanState\s*\(/, /\bsetStepState\s*\(/, /\bsavePlan\s*\(/,
      /\bcompleteTask\s*\(/, /\bfailTask\s*\(/, /\bcancelTask\s*\(/, /\bcreateTask\s*\(/,
    ]) {
      assert.doesNotMatch(src, bad, `evidence/${f} calls ${bad} — it must only read`);
    }
  }
});

test('ARCHITECTURE — the evidence layer issues no statement but SELECT', () => {
  for (const f of fs.readdirSync(path.join(SRC, 'agent', 'evidence')).filter((x) => x.endsWith('.js'))) {
    const src = read(`agent/evidence/${f}`);
    for (const sql of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bDROP\s+TABLE\b/i, /\bALTER\s+TABLE\b/i]) {
      assert.doesNotMatch(src, sql, `evidence/${f} contains a write statement`);
    }
  }
});

test('ARCHITECTURE — nothing below the evidence layer imports it', () => {
  const IMPORT = /^[ \t]*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm;
  for (const dir of ['servicenow', 'memory', 'knowledge']) {
    for (const file of fs.readdirSync(path.join(SRC, dir))) {
      if (!file.endsWith('.js')) continue;
      for (const m of fs.readFileSync(path.join(SRC, dir, file), 'utf8').matchAll(IMPORT)) {
        assert.doesNotMatch(m[1], /agent\/evidence\//, `${dir}/${file} imports the evidence layer`);
      }
    }
  }
  // And the plan layer does not depend on evidence either — evidence reads it.
  for (const file of fs.readdirSync(path.join(SRC, 'agent', 'plan'))) {
    if (!file.endsWith('.js')) continue;
    assert.doesNotMatch(read(`agent/plan/${file}`), /agent\/evidence\//,
      `plan/${file} imports the evidence layer — the arrow points the other way`);
  }
});

test('ARCHITECTURE — the audit trail is READ, not replaced', () => {
  // The evidence layer answers "what happened in THIS task"; the audit answers
  // "what events occurred". It consumes the audit's own reader rather than
  // reimplementing its queries.
  assert.match(read('agent/evidence/read-model.js'), /from '\.\.\/\.\.\/memory\/audit\.js'/);
  assert.ok(fs.existsSync(path.join(SRC, 'routes', 'audit.js')), 'the audit route was removed');
});

test('the correlated sources are labelled by HOW they were matched, never presented as keyed', () => {
  /*
   * PHASE 8 changed what this section can claim, and made the claim narrower
   * rather than broader.
   *
   * Migration 23 gave `tool_events` and `mutation_ledger` a nullable task id,
   * and rows the plan executor writes now carry it — those are exact. Rows from
   * the ordinary turn loop, and every row written before that migration, still
   * carry none and are still matched by session and the task's recorded window.
   * That is deterministic but it is not a key, and the evidence still says so.
   *
   * The plan below runs no tool, so it owns no audit rows at all. Claiming
   * nothing is reported as exact — there is nothing that could belong to
   * someone else — and the window is still published so a reader can judge it.
   */
  const { taskId } = approvedPlan('correlate', [stepOf({ id: 'step_1' })]);
  const e = E.buildEvidence(taskId);
  assert.equal(e.audit.exact, true, 'a task that claimed no audit rows cannot have claimed one wrongly');
  assert.deepEqual(e.audit.counts, { toolEvents: 0, toolEventsExact: 0, changes: 0, changesExact: 0 });
  assert.ok(e.audit.window.from, 'the correlation window is not reported');
  assert.match(e.audit.note, /can belong to another plan/);
});

test('an audit row that names NO task is still reported as correlated, never as exact', () => {
  // The honesty that Phase 5 established, preserved for every legacy row.
  const { taskId } = approvedPlan('legacy-correlate', [stepOf({ id: 'step_1' })]);
  const task = E.readTask(taskId);
  recordToolEvent(task.session_id, {
    kind: 'tool_call', name: 'legacy_untagged', payload: {}, result: 'ok',
    resultStatus: 'ok', mutating: false, approval: null,
  });
  const e = E.buildEvidence(taskId);
  assert.equal(e.audit.exact, false, 'an untagged row was rounded up to exact');
  assert.equal(e.audit.correlation, 'task id where present, otherwise session + task time window');
  assert.match(e.audit.note, /matched by session and time window/);
  assert.ok(e.audit.toolEvents.some((x) => x.name === 'legacy_untagged' && x.exact === false));
});
