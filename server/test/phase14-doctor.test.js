/**
 * PHASE 14 — THE DOCTOR END TO END, over the real durable store.
 *
 * §17 and §35. The model and the instance are faked; NOTHING ELSE IS. The plan
 * is saved, canonicalised and fingerprinted by the real `savePlan`, the steps
 * and their results live in real `agent_task_steps` rows, the diagnosis is
 * written to real `agent_tasks.metadata_json`, and the evidence comes out of
 * the real `buildEvidence`.
 *
 * That matters because the claim being tested is about DURABILITY: §35 requires
 * evidence to come from durable execution data, and a test that passed
 * in-memory objects between functions would prove the pipeline works while
 * saying nothing about whether the record survives the process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p14d-')), 'p.db'))));
const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const P = await import('../src/agent/plan/index.js');
const D = await import('../src/agent/doctor/index.js');
const { recordDiagnosis, loadDiagnosis } = await import('../src/agent/plan/store.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { getDb } = await import('../src/memory/db.js');
const { recordStepResult } = await import('../src/agent/plan/store.js');

const INC = 'a'.repeat(32);
const CALLER = 'b'.repeat(32);
const GROUP = 'c'.repeat(32);

let n = 0;
function newTask(goal = 'diagnose') {
  const sid = `p14d-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

/* ---- the investigation the fake planner returns ---- */
const INVESTIGATION = [
  {
    id: 'step_1', operation: 'read the incident', capability: 'record_read', tool: 'get_record',
    mechanism: 'rest', scope: null, mutating: false, target: { table: 'incident' },
    inputs: { table: 'incident', sys_id: INC }, depends_on: [], expected_effects: [], verification: null,
  },
  {
    id: 'step_2', operation: 'read the caller', capability: 'record_read', tool: 'get_record',
    mechanism: 'rest', scope: null, mutating: false, target: { table: 'sys_user' },
    inputs: { table: 'sys_user', sys_id: { $ref: 'step_1.result.caller_id' } },
    depends_on: ['step_1'], expected_effects: [], verification: null,
  },
];

const INCIDENT_ROW = {
  sys_id: { display_value: INC, value: INC },
  number: { display_value: 'INC0010038', value: 'INC0010038' },
  short_description: { display_value: 'Printer offline', value: 'Printer offline' },
  state: { display_value: 'New', value: '1' },
  assignment_group: { display_value: 'Network', value: GROUP },
  assigned_to: { display_value: '', value: '' },
  caller_id: { display_value: 'Bud Richman', value: CALLER },
};
const CALLER_ROW = {
  sys_id: { display_value: CALLER, value: CALLER },
  name: { display_value: 'Bud Richman', value: 'Bud Richman' },
  active: { display_value: 'true', value: 'true' },
};

const ANALYSIS = {
  hypotheses: [{
    statement: 'The incident sits in the Network group queue with nobody having claimed it.',
    evidence_for: ['fact_step_1_assigned_to', 'fact_step_1_assignment_group', 'fact_step_1_state'],
    evidence_against: [],
    missing_evidence: [],
  }],
  unknowns: [{
    statement: 'No automation execution record was read for this incident.',
    reason: 'No available capability exposes flow or workflow execution evidence.',
  }],
  symptom_field: 'assigned_to',
  symptom_expect: 'empty',
};

/** The plan API the Doctor is given: the REAL store functions. */
const planApi = {
  save: P.savePlan,
  load: P.loadPlan,
  setState: P.setPlanState,
  review: P.buildReview,
  violations: P.mutatingSteps,
};

/** A fake executor that completes the reads exactly as the real one records them. */
const fakeRun = (rows) => async ({ taskId }) => {
  const plan = P.loadPlan(taskId);
  for (const step of plan.steps) {
    P.setStepState(taskId, step.id, 'ready');
    P.setStepState(taskId, step.id, 'executing');
    recordStepResult(taskId, step.id, { result: rows[step.id] });
    P.setStepState(taskId, step.id, 'completed');
    const produced = P.extractOutputs(step.tool, rows[step.id]);
    if (produced) P.recordStepOutputs(taskId, step.id, produced);
  }
  P.setPlanState(taskId, 'completed');
  return { ok: true };
};

const generateOk = async ({ goal }) => ({
  ok: true, goal, plan: { goal, steps: INVESTIGATION }, discovered: {},
});
const chatWith = (analysis) => async () => JSON.stringify(analysis);

async function runDoctor({
  request = 'Why is INC0010038 not assigned?',
  generate = generateOk,
  chat = chatWith(ANALYSIS),
  rows = { step_1: INCIDENT_ROW, step_2: CALLER_ROW },
} = {}) {
  const { taskId, sessionId } = newTask(request);
  const diagnosis = await D.diagnose({
    request, taskId, sessionId, generate, chat, run: fakeRun(rows),
    plan: planApi, record: recordDiagnosis,
  });
  return { diagnosis, taskId, sessionId };
}

/* ================================================================== *
 * §17 — COLLECT, NORMALIZE, ANALYZE, DIAGNOSE, RECOMMEND
 * ================================================================== */

test('a diagnosis runs end to end and produces the §6 shape', async () => {
  const { diagnosis } = await runDoctor();
  for (const key of ['subject', 'symptom', 'investigation', 'facts', 'hypotheses',
    'conclusion', 'recommendations', 'unknowns', 'outcome']) {
    assert.ok(key in diagnosis, `the result is missing ${key}`);
  }
  assert.equal(diagnosis.mode, D.MODES.DIAGNOSE);
  assert.equal(diagnosis.subject.identifier, 'INC0010038');
});

test('facts come from the durable step rows, with provenance to the step', async () => {
  const { diagnosis, taskId } = await runDoctor();
  const stored = P.loadPlan(taskId);
  assert.ok(stored.steps.every((s) => s.state === 'completed'));

  const assigned = diagnosis.facts.find((f) => f.id === 'fact_step_1_assigned_to');
  assert.ok(assigned, diagnosis.facts.map((f) => f.id).join(', '));
  assert.equal(assigned.statement, 'incident INC0010038 has no assigned_to.');
  assert.equal(assigned.source.step, 'step_1');
  assert.equal(assigned.source.tool, 'get_record');
  assert.equal(assigned.source.table, 'incident');

  // The second step's facts are about the CALLER, and are attributed to it.
  const callerName = diagnosis.facts.find((f) => f.source.step === 'step_2' && f.field === 'name');
  assert.ok(callerName);
  assert.equal(callerName.source.table, 'sys_user');
});

test('the reference between the two reads resolved from the first record', async () => {
  const { taskId } = await runDoctor();
  const outs = P.stepOutputs(taskId, 'step_1');
  assert.equal(outs.caller_id, CALLER, 'step_1 must publish the caller identity it read');
});

test('the diagnosis distinguishes FACT from INFERENCE', async () => {
  const { diagnosis } = await runDoctor();
  assert.ok(diagnosis.facts.every((f) => f.type === D.CLAIM_TYPES.FACT));
  assert.ok(diagnosis.inferences.every((i) => i.type === D.CLAIM_TYPES.INFERENCE));
  for (const inf of diagnosis.inferences) {
    for (const id of inf.supporting_facts) {
      assert.ok(diagnosis.facts.some((f) => f.id === id), `an inference cites a fact that does not exist: ${id}`);
    }
  }
});

test('§47 an admitted unknown keeps the run honest about the cause', async () => {
  const { diagnosis } = await runDoctor();
  assert.equal(diagnosis.outcome, D.OUTCOMES.LIKELY_CAUSE_IDENTIFIED,
    'a well-supported explanation alongside an admitted gap is LIKELY, not established');
  assert.equal(diagnosis.cause_label, 'LIKELY CAUSE');
  assert.ok(diagnosis.unknowns.some((u) => /automation execution/.test(u.statement)));
});

test('§47 with no supportable explanation the run says so, and that is a success', async () => {
  const { diagnosis } = await runDoctor({
    chat: chatWith({ hypotheses: [], unknowns: ANALYSIS.unknowns, symptom_field: 'assigned_to', symptom_expect: 'empty' }),
  });
  assert.equal(diagnosis.outcome, D.OUTCOMES.INSUFFICIENT_EVIDENCE);
  assert.equal(diagnosis.cause_label, 'ROOT CAUSE NOT ESTABLISHED');
  assert.match(diagnosis.conclusion.statement, /not established|could be supported/i);
  assert.equal(diagnosis.conclusion.root_cause, false);
});

test('NO_PROBLEM_FOUND when the reported condition is checked and absent', async () => {
  const assignedRow = { ...INCIDENT_ROW, assigned_to: { display_value: 'Abel Tuter', value: 'd'.repeat(32) } };
  const { diagnosis } = await runDoctor({ rows: { step_1: assignedRow, step_2: CALLER_ROW } });
  assert.equal(diagnosis.symptom_confirmed, false);
  assert.equal(diagnosis.outcome, D.OUTCOMES.NO_PROBLEM_FOUND);
  assert.match(diagnosis.conclusion.statement, /not present/);
});

test('a fabricated citation is stripped, counted, and weakens its own hypothesis', async () => {
  const { diagnosis } = await runDoctor({
    chat: chatWith({
      ...ANALYSIS,
      hypotheses: [{
        statement: 'The assignment workflow failed.',
        evidence_for: ['fact_step_1_assigned_to', 'fact_step_1_workflow_failed'],
        evidence_against: [], missing_evidence: [],
      }],
    }),
  });
  assert.deepEqual(diagnosis.invented_citations.map((c) => c.id), ['fact_step_1_workflow_failed']);
  const hyp = diagnosis.hypotheses[0];
  assert.deepEqual(hyp.evidence_for, ['fact_step_1_assigned_to'], 'the invented citation must not survive');
  assert.equal(hyp.support_level, 'weak',
    'citing only the symptom, after the invention was stripped, is not support');
  assert.equal(diagnosis.outcome, D.OUTCOMES.POSSIBLE_CAUSE);
});

/* ================================================================== *
 * §35 / §23 — EVIDENCE
 * ================================================================== */

test('§23 the diagnosis reaches the EXISTING evidence projection', async () => {
  const { taskId, diagnosis } = await runDoctor();
  const evidence = buildEvidence(taskId);
  assert.ok(evidence, 'no evidence was produced');
  assert.ok(evidence.diagnosis, 'the evidence carries no diagnosis section');

  const d = evidence.diagnosis;
  assert.equal(d.source, 'diagnostic_analysis');
  assert.equal(d.outcome, diagnosis.outcome);
  assert.equal(d.cause_label, diagnosis.cause_label);
  for (const key of ['facts', 'hypotheses', 'conclusion', 'recommendations', 'unknowns']) {
    assert.ok(key in d, `§35 requires ${key} in the evidence`);
  }
});

test('§23 the existing evidence sections are untouched', async () => {
  const { taskId } = await runDoctor();
  const evidence = buildEvidence(taskId);
  for (const key of ['task', 'request', 'plan', 'approval', 'steps', 'changes',
    'verification', 'recovery', 'dataflow', 'final', 'uncertainties', 'audit']) {
    assert.ok(key in evidence, `Phase 14 removed the ${key} section`);
  }
});

test('§23 a task that was not a diagnosis carries diagnosis: null, not a missing key', async () => {
  const { taskId } = newTask('an ordinary plan');
  P.savePlan(taskId, { goal: 'g', steps: INVESTIGATION });
  const evidence = buildEvidence(taskId);
  assert.ok('diagnosis' in evidence);
  assert.equal(evidence.diagnosis, null);
});

test('§35 the evidence survives a fresh read of the database', async () => {
  const { taskId } = await runDoctor();
  // Nothing cached: this reads the row back through the store.
  const stored = loadDiagnosis(taskId);
  assert.ok(stored, 'the diagnosis was not persisted to agent_tasks.metadata_json');
  assert.equal(stored.outcome, D.OUTCOMES.LIKELY_CAUSE_IDENTIFIED);
  assert.ok(stored.at, 'the stored diagnosis must be timestamped');
  assert.ok(stored.facts.length > 0);
});

test('§44 persisting a diagnosis added no migration', async () => {
  const version = getDb().prepare('PRAGMA user_version').get();
  assert.equal(Object.values(version)[0], 28, 'the schema version changed');
});

test('§49 the audit chain is reconstructible from durable rows alone', async () => {
  const { taskId, diagnosis } = await runDoctor();
  const evidence = buildEvidence(taskId);
  // request -> investigation -> steps -> results -> facts -> conclusion
  assert.ok(evidence.diagnosis.investigation.goal.length > 0);
  assert.equal(evidence.diagnosis.investigation.steps.length, INVESTIGATION.length);
  assert.ok(evidence.steps.length > 0, 'the step rows must be there independently');
  const factStep = evidence.diagnosis.facts[0].source.step;
  assert.ok(evidence.steps.some((s) => s.id === factStep || s.plan_step_id === factStep),
    'every fact must be traceable to a step in the evidence');
  assert.ok(evidence.diagnosis.conclusion.statement.length > 0);
  assert.equal(evidence.diagnosis.integrity.invented_citations.length, diagnosis.invented_citations.length);
});

/* ================================================================== *
 * STOPPING
 * ================================================================== */

test('§26 an unidentifiable subject stops before any plan is made', async () => {
  let planned = false;
  const { taskId, sessionId } = newTask('vague');
  const diagnosis = await D.diagnose({
    request: 'why is it broken', taskId, sessionId,
    generate: async () => { planned = true; return { ok: false }; },
    chat: chatWith(ANALYSIS), run: fakeRun({}), plan: planApi, record: recordDiagnosis,
  });
  assert.equal(planned, false, 'a plan was made for a request naming no record');
  assert.equal(diagnosis.stopped.reason, D.STOP_REASONS.INSUFFICIENT_EVIDENCE);
  assert.equal(diagnosis.facts.length, 0);
});

test('§55.1 a planner that returns a MUTATING plan is stopped before execution', async () => {
  let executed = false;
  const { taskId, sessionId } = newTask('diagnose');
  const diagnosis = await D.diagnose({
    request: 'Why is INC0010038 not assigned?', taskId, sessionId,
    generate: async ({ goal }) => ({
      ok: true,
      goal,
      plan: {
        goal,
        steps: [{
          id: 'step_1', operation: 'just fix it', capability: 'record_update', tool: 'update_record',
          mechanism: 'rest', scope: null, mutating: true, target: { table: 'incident' },
          inputs: { table: 'incident', sys_id: INC, data: { assigned_to: 'x' } },
          depends_on: [], expected_effects: ['assigned'],
          verification: { strategy: 'read_back', asserts: ['assigned'] },
        }],
      },
      discovered: {},
    }),
    chat: chatWith(ANALYSIS),
    run: async () => { executed = true; return { ok: true }; },
    plan: planApi, record: recordDiagnosis,
  });
  assert.equal(executed, false, 'a mutating investigation reached the executor');
  assert.equal(diagnosis.stopped.reason, D.STOP_REASONS.MUTATION_IN_DIAGNOSE);
  assert.equal(diagnosis.outcome, D.OUTCOMES.INVESTIGATION_BLOCKED);
});

test('§51 cancellation keeps partial evidence and claims no diagnosis', async () => {
  const { taskId, sessionId } = newTask('diagnose');
  const diagnosis = await D.diagnose({
    request: 'Why is INC0010038 not assigned?', taskId, sessionId,
    generate: generateOk,
    chat: chatWith(ANALYSIS),
    run: async ({ taskId: id }) => {
      // One read completes, then the turn is cancelled.
      P.setStepState(id, 'step_1', 'ready');
      P.setStepState(id, 'step_1', 'executing');
      recordStepResult(id, 'step_1', { result: INCIDENT_ROW });
      P.setStepState(id, 'step_1', 'completed');
      return { ok: false, reason: 'cancelled' };
    },
    plan: planApi, record: recordDiagnosis,
  });
  assert.equal(diagnosis.stopped.reason, D.STOP_REASONS.CANCELLED);
  assert.ok(diagnosis.facts.length > 0, 'partial evidence must be retained');
  assert.equal(diagnosis.conclusion.root_cause, false);
  assert.ok(!diagnosis.hypotheses.length, 'a cancelled run must not conclude');
});

test('§50 an analyst failure is reported, and does not manufacture evidence', async () => {
  const { diagnosis } = await runDoctor({
    chat: async () => { throw new Error('the model is unreachable'); },
  });
  assert.equal(diagnosis.stopped.reason, D.STOP_REASONS.INSUFFICIENT_EVIDENCE);
  assert.match(diagnosis.stopped.note, /unreachable/);
  assert.ok(diagnosis.facts.length > 0, 'the reads that succeeded are still evidence');
  assert.equal(diagnosis.hypotheses.length, 0);
});

/* ================================================================== *
 * REGRESSIONS FOUND ON THE REAL INSTANCE
 * ================================================================== */

test('REGRESSION: the analyst cannot invert a symptom the user stated plainly', async () => {
  /*
   * Measured on the PDI: asked "why is INC0010058 not assigned?" about a
   * genuinely unassigned incident, the analyst answered `symptom_expect:
   * "present"`. That reading was preferred over the one derived from the
   * sentence, so the run asked "is it assigned?", found it was not, and
   * reported NO_PROBLEM_FOUND about the very condition it was asked to explain.
   */
  const { diagnosis } = await runDoctor({
    request: 'Why is INC0010038 not assigned?',
    chat: chatWith({ ...ANALYSIS, symptom_field: 'assigned_to', symptom_expect: 'present' }),
  });
  assert.equal(diagnosis.symptom_confirmed, true,
    'the incident IS unassigned; the analyst must not be able to invert that');
  assert.notEqual(diagnosis.outcome, D.OUTCOMES.NO_PROBLEM_FOUND);
});

test('the analyst\'s reading is still used when the request names no known field', async () => {
  const { diagnosis } = await runDoctor({
    request: 'Investigate INC0010038.',
    chat: chatWith({ ...ANALYSIS, symptom_field: 'assigned_to', symptom_expect: 'empty' }),
  });
  assert.equal(diagnosis.symptom_confirmed, true,
    'with no field derivable from the sentence, the analyst may say which field it is about');
});

test('REGRESSION: a symptom with no field at all does not crash the run', async () => {
  const { diagnosis } = await runDoctor({
    request: 'Investigate INC0010038.',
    chat: chatWith({ hypotheses: [], unknowns: [], symptom_field: null, symptom_expect: null }),
  });
  assert.equal(diagnosis.symptom_confirmed, null, 'nobody checked, so nobody knows');
  assert.ok(diagnosis.outcome);
});

test('a stopped run carries the same integrity fields as a completed one', async () => {
  const { diagnosis } = await runDoctor({ request: 'why is it broken' });
  assert.ok(Array.isArray(diagnosis.invented_citations));
  assert.ok(Array.isArray(diagnosis.overstated));
});

test('REGRESSION: with several explanations alive, the headline names none of them', async () => {
  /*
   * From the DoD output: the verdict was MULTIPLE_PLAUSIBLE_CAUSES and the
   * first line still read "…because it lacks a caller_id", which is the one
   * thing the run had declined to conclude.
   */
  const { diagnosis } = await runDoctor({
    chat: chatWith({
      ...ANALYSIS,
      hypotheses: [
        { statement: 'It has no assignment group.', evidence_for: ['fact_step_1_assignment_group', 'fact_step_1_state'], evidence_against: [], missing_evidence: [] },
        { statement: 'It has no caller.', evidence_for: ['fact_step_1_caller_id', 'fact_step_1_number'], evidence_against: [], missing_evidence: [] },
      ],
      unknowns: [],
    }),
  });
  assert.equal(diagnosis.outcome, D.OUTCOMES.MULTIPLE_PLAUSIBLE_CAUSES);
  assert.match(diagnosis.conclusion.statement, /more than one explanation/i);
  assert.ok(!/caller|assignment group/i.test(diagnosis.conclusion.statement),
    `the headline named one of the competing explanations: "${diagnosis.conclusion.statement}"`);
  // The explanations are still reported, just not as the finding.
  assert.equal(diagnosis.hypotheses.length, 2);
});

/* ================================================================== *
 * §45 — THE CLIENT CONTRACT
 * ================================================================== */

const readClient = (rel) => fs.readFileSync(new URL(`../../client/src/${rel}`, import.meta.url), 'utf8');

test('§45 REGRESSION: the sources panel calls api.get, not api()', () => {
  /*
   * `api` is an object of verbs. Calling it directly threw TypeError on every
   * load, so the panel could never display evidence at all — and the catch
   * around it reported "the evidence could not be loaded", which is
   * indistinguishable from a task that has none. Found while wiring the Doctor
   * into the existing experience, since this panel is where a diagnosis is read.
   */
  // Renamed with the Sources redesign; the defect it guards against is the
  // same one, in the same fetch.
  const src = readClient('components/SourcesPanel.jsx');
  assert.match(src, /api\.get\(/, 'the panel must call a verb on the api object');
  assert.ok(!/[^.\w]api\(/.test(src), 'api is not callable');
  const api = readClient('api.js');
  assert.match(api, /export const api = \{/, 'fixture drifted: api is no longer an object');
});

test('§45 the Doctor presentation distinguishes the five kinds §45 names', () => {
  const src = readClient('components/DiagnosisPanel.jsx');
  for (const word of ['Observed', 'Possible', 'Likely', 'Unknown', 'Recommendation']) {
    assert.ok(src.includes(word), `the panel must distinguish "${word}"`);
  }
  for (const heading of ['What I found', 'Assessment', 'What I cannot establish']) {
    assert.ok(src.includes(heading), `§46 expects a "${heading}" section`);
  }
});

test('§45 the panel renders the server\'s label and never recomputes one', () => {
  const src = readClient('components/DiagnosisPanel.jsx');
  assert.match(src, /diagnosis\.cause_label/, 'the label must come from the server');
  // No local evidence arithmetic: a client that disagreed with the evidence
  // rule would be the version a person actually reads.
  assert.ok(!/evidence_for\.length\s*>=?\s*\d/.test(src), 'the client must not re-derive support');
  assert.ok(!/ROOT_CAUSE_ESTABLISHED\s*[:=]\s*['"]ROOT CAUSE/.test(src), 'the client must not mint labels');
});

test('§45 a mutating recommendation is shown as needing approval, never as a button', () => {
  const src = readClient('components/DiagnosisPanel.jsx');
  assert.match(src, /Needs your approval/);
  assert.ok(!/onClick=\{[^}]*approve/i.test(src),
    'the diagnosis panel must not carry its own approve action');
});

test('§45 the diagnose command is explicit, not sniffed from the message', () => {
  const src = readClient('pages/AgentChat.jsx');
  assert.ok(src.includes('/diagnose'), 'an explicit /diagnose command must gate the Doctor route');
  assert.ok(src.includes('const diagnostic ='), 'the routing decision must be an explicit test');
  assert.match(src, /agent\/plan\/diagnose/);
  assert.match(src, /kind: 'diagnosis'/);
});
