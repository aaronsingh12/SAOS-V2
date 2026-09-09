/**
 * PHASE 14 — REMEDIATION, WHICH IS JUST PHASES 11-13 AGAIN.
 *
 * §19, §20, §21, §22 and §34. The claim under test is a negative one: the
 * Doctor adds NOTHING to the mutation path. A remediation is a sentence handed
 * to the existing planner, and from that point every guarantee is one that was
 * already built and already proved — canonical arguments, a fingerprint over
 * them, an approval bound to that fingerprint, one `executeTool`, a read-back.
 *
 * So most of this file asserts that the existing machinery still behaves
 * exactly as it did, on a plan that happens to have come from a diagnosis, plus
 * the one genuinely new rule: a diagnosis that established nothing may not
 * propose a change to a real record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p14r-')), 'p.db'))));
const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const P = await import('../src/agent/plan/index.js');
const D = await import('../src/agent/doctor/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { getDb } = await import('../src/memory/db.js');
const { APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');

const INC = 'a'.repeat(32);
const ABEL = 'b'.repeat(32);

let n = 0;
function newTask(goal = 'remediate') {
  const sid = `p14r-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const remediation = (assignedTo = ABEL) => ({
  goal: 'assign the incident',
  steps: [{
    id: 'step_1', operation: 'assign the incident to the resolved user',
    capability: 'record_update', tool: 'update_record', mechanism: 'rest', scope: null,
    mutating: true, target: { table: 'incident', sys_id: INC },
    inputs: { table: 'incident', sys_id: INC, data: { assigned_to: assignedTo } },
    depends_on: [], expected_effects: ['assigned_to holds the resolved user'],
    verification: { strategy: 'read_back', asserts: [{ field: 'assigned_to', equals: assignedTo }] },
  }],
});

const CONCLUSION = {
  type: 'CONCLUSION',
  statement: 'The incident is unassigned and sits in the Network group queue.',
  supporting_evidence: ['fact_step_1_assigned_to', 'fact_step_1_assignment_group'],
  status: 'qualified', root_cause: false, support_level: 'moderate', label: 'LIKELY CAUSE',
};

/* ================================================================== *
 * §19 — A RECOMMENDATION IS NOT AN ACTION
 * ================================================================== */

test('§19 a mutating recommendation ALWAYS requires approval', () => {
  const recs = D.recommendFrom({
    outcome: D.OUTCOMES.ROOT_CAUSE_ESTABLISHED,
    conclusion: CONCLUSION,
    proposed: [{ statement: 'Assign the incident to Abel Tuter.', mutation: true, reason: 'nobody is assigned' }],
  });
  assert.equal(recs[0].mutation, true);
  assert.equal(recs[0].requires_approval, true);
});

test('§19 a recommendation that mutates without approval is structurally impossible', () => {
  assert.equal(D.isRecommendation({
    statement: 'do it', mutation: true, requires_approval: false, reason: ['x'],
  }), false, 'the shape must not admit an unapproved mutation');
});

test('§19 an unsupported diagnosis cannot propose a change to a real record', () => {
  for (const outcome of [D.OUTCOMES.INSUFFICIENT_EVIDENCE, D.OUTCOMES.INVESTIGATION_BLOCKED,
    D.OUTCOMES.MULTIPLE_PLAUSIBLE_CAUSES, D.OUTCOMES.POSSIBLE_CAUSE]) {
    const recs = D.recommendFrom({
      outcome, conclusion: CONCLUSION,
      proposed: [{ statement: 'Assign the incident to Abel Tuter.', mutation: true }],
    });
    assert.equal(recs[0].mutation, false, `${outcome} allowed a mutation`);
    assert.equal(recs[0].requires_approval, false);
    assert.ok(recs[0].withheld, 'the withheld proposal must stay visible to the reader');
    assert.equal(recs[0].withheld.because, outcome);
  }
});

test('§19 a run that proposes nothing still gives the reader a next step', () => {
  const recs = D.recommendFrom({ outcome: D.OUTCOMES.INSUFFICIENT_EVIDENCE, conclusion: CONCLUSION, unknowns: [] });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].mutation, false);
  assert.ok(recs[0].statement.length > 0);
});

test('§20 remediation becomes a GOAL for the existing planner, never a tool call', () => {
  const goal = D.remediationGoal(
    { statement: 'Assign the incident to Abel Tuter.', mutation: true },
    { subject: { type: 'incident', identifier: 'INC0010038' }, conclusion: CONCLUSION },
  );
  assert.match(goal, /Assign the incident to Abel Tuter/);
  assert.match(goal, /incident INC0010038/);
  assert.match(goal, /Diagnosis:/, 'the approval card needs the diagnosis as context');
  assert.throws(() => D.remediationGoal({ statement: 'look at it', mutation: false }),
    /only for a recommendation that mutates/);
});

test('§20/§42 the doctor domain contains no mutation call of any kind', () => {
  const dir = new URL('../src/agent/doctor/', import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const forbidden of [/update_record\s*\(/, /executeTool/, /table\.(update|create|remove)/]) {
      assert.ok(!forbidden.test(src), `${f} reaches the mutation path directly`);
    }
  }
});

/* ================================================================== *
 * §21 — THE APPROVAL CARD CARRIES THE DIAGNOSIS
 * ================================================================== */

test('§21 the approval context carries problem, diagnosis, evidence and unknowns', () => {
  const facts = [
    { id: 'fact_step_1_assigned_to', statement: 'incident INC0010038 has no assigned_to.', source: { step: 'step_1', tool: 'get_record' } },
    { id: 'fact_step_1_assignment_group', statement: 'incident INC0010038 has assignment_group = Network.', source: { step: 'step_1', tool: 'get_record' } },
    { id: 'fact_unrelated', statement: 'noise', source: { step: 'step_1', tool: 'get_record' } },
  ];
  const ctx = D.approvalContext({
    subject: { type: 'incident', identifier: 'INC0010038' },
    symptom: { statement: 'Why is INC0010038 not assigned?' },
    conclusion: CONCLUSION,
    outcome: D.OUTCOMES.LIKELY_CAUSE_IDENTIFIED,
    label: 'LIKELY CAUSE',
    facts,
    unknowns: [{ statement: 'No automation evidence was read.' }],
  });
  assert.match(ctx.problem, /not assigned/);
  assert.equal(ctx.subject, 'incident INC0010038');
  assert.match(ctx.diagnosis, /unassigned/);
  assert.equal(ctx.label, 'LIKELY CAUSE');
  assert.equal(ctx.evidence.length, 2, 'only the cited facts, and every cited fact');
  assert.ok(ctx.evidence.every((e) => e.source.step === 'step_1'), 'evidence keeps its provenance');
  assert.deepEqual(ctx.unknowns, ['No automation evidence was read.']);
});

test('§21/§24 the card cannot upgrade the cause label', () => {
  const ctx = D.approvalContext({
    conclusion: { ...CONCLUSION, root_cause: false },
    outcome: D.OUTCOMES.POSSIBLE_CAUSE,
    label: D.CAUSE_LABELS[D.OUTCOMES.POSSIBLE_CAUSE],
  });
  assert.equal(ctx.label, 'POSSIBLE CAUSE');
  assert.equal(ctx.outcome, D.OUTCOMES.POSSIBLE_CAUSE);
});

/* ================================================================== *
 * §34 — THE EXISTING APPROVAL GUARANTEES, ON A DIAGNOSIS-DERIVED PLAN
 * ================================================================== */

test('§34 approval binds the exact canonical arguments', () => {
  const { taskId } = newTask();
  const saved = P.savePlan(taskId, remediation());
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });

  const bound = P.checkApprovalBinding(taskId);
  assert.ok(bound.ok, bound.note);

  const stored = P.loadPlan(taskId);
  assert.ok(P.isCanonical(stored), 'the approved plan must already be canonical');
  assert.equal(stored.steps[0].inputs.data.assigned_to, ABEL,
    'the arguments that will execute are the ones that were approved');
});

test('§34 changing the remediation invalidates the approval', () => {
  const { taskId } = newTask();
  const saved = P.savePlan(taskId, remediation(ABEL));
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  assert.ok(P.checkApprovalBinding(taskId).ok);

  // A different assignee is a different change, however small the edit looks.
  const changed = P.savePlan(taskId, remediation('c'.repeat(32)));
  assert.notEqual(changed.fingerprint, saved.fingerprint);
  const after = P.checkApprovalBinding(taskId);
  assert.ok(!after.ok, 'the old approval survived a changed plan');
  assert.equal(after.reason, 'approval_stale');
});

test('§34 the DIAGNOSIS text is not part of the execution fingerprint', () => {
  /*
   * The fingerprint covers what will RUN. A diagnosis is context for the human
   * reading the card, so rewording it must not invalidate an approval — and,
   * more importantly, changing it must not be a way to alter what executes.
   */
  const a = P.fingerprintPlan(remediation());
  const b = P.fingerprintPlan({
    ...remediation(),
    diagnosis: { statement: 'a completely different explanation', outcome: 'ROOT_CAUSE_ESTABLISHED' },
  });
  assert.equal(a, b, 'diagnostic narrative leaked into the execution fingerprint');
});

test('§34 execution cannot proceed without an approval binding', () => {
  const { taskId } = newTask();
  P.savePlan(taskId, remediation());
  P.setPlanState(taskId, 'ready');
  const bound = P.checkApprovalBinding(taskId);
  assert.ok(!bound.ok);
  assert.equal(bound.reason, 'not_approved');
});

test('§34 the review shows the canonical arguments that will execute', () => {
  const { taskId } = newTask();
  const saved = P.savePlan(taskId, remediation());
  const review = P.buildReview(P.loadPlan(taskId), { fingerprint: saved.fingerprint, discovered: {} });
  assert.equal(review.approvalRequired, true, 'a remediation must require approval');
  assert.ok(review.plannedChanges.length >= 1, 'the change must be shown, not summarised away');
});

test('§34 a read-only investigation requires no approval — and that is recorded', () => {
  const { taskId } = newTask('investigate');
  const investigation = {
    goal: 'investigate',
    steps: [{
      id: 'step_1', operation: 'read', capability: 'record_read', tool: 'get_record',
      mechanism: 'rest', scope: null, mutating: false, target: { table: 'incident' },
      inputs: { table: 'incident', sys_id: INC }, depends_on: [], expected_effects: [], verification: null,
    }],
  };
  const saved = P.savePlan(taskId, investigation);
  const review = P.buildReview(P.loadPlan(taskId), { fingerprint: saved.fingerprint, discovered: {} });
  assert.equal(review.approvalRequired, false);

  // The Doctor uses the existing convention rather than a bespoke approval.
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'executing', {
    approved_fingerprint: saved.fingerprint,
    approved_at: new Date().toISOString(),
    approved_source: 'read_only_plan',
  });
  assert.ok(P.checkApprovalBinding(taskId).ok, 'a read-only plan must still be bound to its fingerprint');
  assert.equal(P.loadPlan(taskId).approvedSource ?? P.loadPlan(taskId).approved_source, 'read_only_plan');
});

/* ================================================================== *
 * §22 — VERIFICATION IS THE EXISTING ONE
 * ================================================================== */

test('§22 a remediation step must promise an effect and assert it', () => {
  const discover = () => ({
    capability: 'record_update', status: 'known', available: true, mechanism: 'rest', mutating: true,
    verification: 'read_back', requiresVerification: true, requiresApproval: true,
    requiresElevation: false, elevationRole: null, scope: null, reason: null, note: null,
  });
  const naked = remediation();
  naked.steps[0].expected_effects = [];
  naked.steps[0].verification = { strategy: 'read_back', asserts: [] };
  const v = P.validatePlan(naked, { discover });
  assert.ok(!v.valid);
  assert.ok(v.fatal.some((p) => p.code === 'no_expected_effects'),
    v.fatal.map((p) => p.code).join(', '));
});

test('§22 there is exactly one evidence projection, and Phase 14 did not add another', () => {
  const roots = [new URL('../src/agent/', import.meta.url)];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.js')) {
        const src = fs.readFileSync(child, 'utf8');
        if (/export\s+function\s+buildEvidence\s*\(/.test(src)) found.push(entry.name);
      }
    }
  };
  for (const r of roots) walk(r);
  assert.deepEqual(found, ['builder.js'], `more than one evidence projection: ${found.join(', ')}`);
});
