/**
 * PHASE 15 — CAUSAL REASONING, and the four ways it must refuse.
 *
 * §32 to §38. The scenarios here are the ones the specification names, built
 * from the shapes a real instance returned, and each is run in BOTH directions:
 * with the evidence that would justify a strong claim, and then with that one
 * piece removed. A rule that only ever fires in the safe direction has not been
 * tested; it has been demonstrated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p15c-')), 'p.db'))));
const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const P = await import('../src/agent/plan/index.js');
const D = await import('../src/agent/doctor/index.js');
const DX = await import('../src/agent/doctor/diagnosis.js');
const E = await import('../src/agent/doctor/evidence.js');
const { toolMap } = await import('../src/agent/tools.js');
const { CAPABILITIES } = await import('../src/agent/capability-discovery.js');

const INC = 'a'.repeat(32);
const SLA = 'b'.repeat(32);
const CTX = 'c'.repeat(32);

/* ---- the evidence a real investigation collects ---- */
const incidentStep = (over = {}) => ({
  id: 'step_1', tool: 'get_record', state: 'completed', inputs: { table: 'incident', sys_id: INC },
  result: {
    sys_id: { value: INC }, number: { value: 'INC0010086' },
    assigned_to: { value: '' }, assignment_group: { value: '' },
    state: { value: '1' }, sys_created_on: { value: '2026-09-04 08:59:40' },
  },
  ...over,
});

const auditStep = (changes) => ({
  id: 'step_6', tool: 'get_record_audit', state: 'completed', inputs: { table: 'incident', sys_id: INC },
  result: { subject: { table: 'incident', sys_id: INC }, count: changes.length, truncated: false, changes },
});

const flowStep = (executions, over = {}) => ({
  id: 'step_9', tool: 'find_flow_executions', state: 'completed',
  inputs: { table: 'task_sla', sys_id: SLA },
  result: {
    subject: { table: 'task_sla', sys_id: SLA },
    found: executions.length > 0,
    state: executions.length ? executions[0].state : 'NO_EXECUTION_FOUND',
    count: executions.length, truncated: false, executions,
  },
  ...over,
});

const ERRORED = {
  sys_id: CTX, flow: { sys_id: 'f'.repeat(32), name: 'Assign Incident' },
  state: 'EXECUTION_ERROR', raw_state: 'ERROR',
  error: 'The assignment group could not be resolved',
  started_at: '2026-09-04 08:59:55', last_updated_at: '2026-09-04 08:59:56',
};
const COMPLETED = { ...ERRORED, state: 'EXECUTION_COMPLETE', raw_state: 'COMPLETE', error: null };

/** Run the deterministic half of the pipeline over a fact set. */
function judge(steps, hypothesis, { symptomField = 'assigned_to' } = {}) {
  const facts = E.factsFrom(steps);
  const symptomFactIds = DX.symptomFactIdsOf({ field: symptomField }, facts);
  const causalFactIds = DX.causalFactIdsOf(facts);
  const [adj] = DX.adjudicate([hypothesis], {
    symptomFactIds, causalFactIds, facts, symptomField, subjectSysId: INC,
  });
  const verdict = DX.classify({
    hypotheses: [adj], completedReads: steps.length,
    symptomConfirmed: true, symptomCheckedDeterministically: true,
  });
  return { facts, adj, verdict, causalFactIds, symptomFactIds };
}

const factId = (facts, match) => facts.find((f) => match(f))?.id;

/* ================================================================== *
 * §32 — FLOW CAUSALITY, both directions
 * ================================================================== */

test('§32 symptom + a flow that ERRORED with a relevant message reaches the strongest supported state', () => {
  const steps = [incidentStep(), flowStep([ERRORED])];
  const facts = E.factsFrom(steps);
  const hypothesis = {
    id: 'hyp_1',
    statement: 'The assignment automation failed while resolving the assignment group.',
    evidence_for: [
      factId(facts, (f) => f.field === 'assigned_to'),
      factId(facts, (f) => f.field === 'flow_execution_state'),
      factId(facts, (f) => f.field === 'flow_execution_error'),
    ].filter(Boolean),
    evidence_against: [],
    missing_evidence: [],
  };
  const { adj, verdict } = judge(steps, hypothesis);
  assert.equal(adj.support_level, 'strong', JSON.stringify(adj.unsupported_blame));
  assert.equal(verdict.outcome, D.OUTCOMES.ROOT_CAUSE_ESTABLISHED);
  assert.equal(verdict.label, 'ROOT CAUSE');
});

test('§32 REMOVE the error and it must never be a root cause again', () => {
  const steps = [incidentStep(), flowStep([COMPLETED])];
  const facts = E.factsFrom(steps);
  const hypothesis = {
    id: 'hyp_1',
    statement: 'The assignment automation failed while resolving the assignment group.',
    evidence_for: [
      factId(facts, (f) => f.field === 'assigned_to'),
      factId(facts, (f) => f.field === 'flow_execution_state'),
    ].filter(Boolean),
    evidence_against: [],
    missing_evidence: [],
  };
  const { verdict } = judge(steps, hypothesis);
  assert.notEqual(verdict.outcome, D.OUTCOMES.ROOT_CAUSE_ESTABLISHED,
    'a completed execution must not support "the automation failed"');
  assert.ok([D.OUTCOMES.LIKELY_CAUSE_IDENTIFIED, D.OUTCOMES.POSSIBLE_CAUSE,
    D.OUTCOMES.INSUFFICIENT_EVIDENCE].includes(verdict.outcome), verdict.outcome);
});

test('§8 symptom + a flow merely EXISTING is not a cause', () => {
  const steps = [incidentStep(), flowStep([COMPLETED])];
  const facts = E.factsFrom(steps);
  // The forbidden shape: the symptom, and the bare fact that automation ran.
  const hypothesis = {
    id: 'hyp_1', statement: 'The flow caused the incident to be unassigned.',
    evidence_for: [factId(facts, (f) => f.field === 'assigned_to')].filter(Boolean),
    evidence_against: [], missing_evidence: [],
  };
  const { adj, verdict } = judge(steps, hypothesis);
  assert.equal(adj.support_level, 'weak');
  assert.ok(adj.unsupported_blame.length > 0, 'blaming a flow while citing no flow fact must be recorded');
  assert.notEqual(verdict.outcome, D.OUTCOMES.ROOT_CAUSE_ESTABLISHED);
});

/* ================================================================== *
 * §33 — NO EXECUTION IS NOT A FAILURE
 * ================================================================== */

test('§33 no execution found is reported as such, never as a failure', () => {
  const steps = [incidentStep(), flowStep([])];
  const facts = E.factsFrom(steps);
  const f = facts.find((x) => x.field === 'flow_execution');
  assert.ok(f, 'the absence must itself be an observation');
  assert.equal(f.value, 'NO_EXECUTION_FOUND');
  assert.match(f.statement, /absence of evidence, not evidence of failure/);
  assert.equal(f.causal, false, 'an absence cannot be causal evidence');
});

test('§33 a hypothesis blaming automation cannot lean on "nothing ran"', () => {
  const steps = [incidentStep(), flowStep([])];
  const facts = E.factsFrom(steps);
  const hypothesis = {
    id: 'hyp_1', statement: 'The assignment workflow failed.',
    evidence_for: [
      factId(facts, (f) => f.field === 'assigned_to'),
      factId(facts, (f) => f.field === 'flow_execution'),
    ].filter(Boolean),
    evidence_against: [], missing_evidence: [],
  };
  const { adj, verdict } = judge(steps, hypothesis);
  assert.equal(adj.support_level, 'weak');
  assert.notEqual(verdict.outcome, D.OUTCOMES.ROOT_CAUSE_ESTABLISHED);
});

/* ================================================================== *
 * §34 — TEMPORAL CORRELATION IS NOT CAUSATION
 * ================================================================== */

test('§34 ordering is available, causation is not', () => {
  const steps = [
    incidentStep(),
    auditStep([{ sys_id: 'c1', field: 'assignment_group', old_value: 'x', new_value: '', changed_by: 'admin', changed_at: '2026-09-04 08:59:51' }]),
    flowStep([ERRORED]),
  ];
  const t = D.buildTimeline(steps, E.factsFrom(steps));
  const change = t.events.find((e) => e.kind === 'field_changed');
  const failure = t.events.find((e) => e.label.includes('EXECUTION_ERROR'));
  assert.equal(D.buildTimeline && typeof D.buildTimeline, 'function');
  assert.ok(change && failure);
  assert.ok(change.epoch < failure.epoch, 'the change did precede the failure');
  // And nothing in the structure lets that become a cause.
  for (const e of t.events) assert.ok(!('caused' in e));
});

test('§34 a claim resting only on chronology is not strengthened by it', () => {
  const steps = [
    incidentStep(),
    auditStep([{ sys_id: 'c1', field: 'assignment_group', old_value: 'x', new_value: '', changed_by: 'admin', changed_at: '2026-09-04 08:59:51' }]),
  ];
  const facts = E.factsFrom(steps);
  const hypothesis = {
    id: 'hyp_1',
    statement: 'The assignment_group change caused the flow failure.',
    /* Cites the change, which is real — but no flow fact exists at all. */
    evidence_for: [factId(facts, (f) => f.field === 'changed_assignment_group')].filter(Boolean),
    evidence_against: [], missing_evidence: [],
  };
  const { adj } = judge(steps, hypothesis);
  assert.ok(adj.unsupported_blame.some((b) => b.blames === 'automation'),
    'blaming a flow failure with no flow evidence must be caught');
  assert.equal(adj.support_level, 'weak');
});

/* ================================================================== *
 * §35 — NEGATIVE EVIDENCE
 * ================================================================== */

test('§35 a later successful assignment contradicts the flow-failure story', () => {
  const steps = [
    incidentStep({ result: { ...incidentStep().result, assigned_to: { value: 'd'.repeat(32) } } }),
    auditStep([{ sys_id: 'c9', field: 'assigned_to', old_value: '', new_value: 'd'.repeat(32), changed_by: 'admin', changed_at: '2026-09-04 09:10:00' }]),
    flowStep([ERRORED]),
  ];
  const facts = E.factsFrom(steps);
  const hypothesis = {
    id: 'hyp_1', statement: 'The assignment automation failed, so the incident is unassigned.',
    evidence_for: [
      factId(facts, (f) => f.field === 'flow_execution_state'),
      factId(facts, (f) => f.field === 'flow_execution_error'),
    ].filter(Boolean),
    evidence_against: [factId(facts, (f) => f.field === 'changed_assigned_to')].filter(Boolean),
    missing_evidence: [],
  };
  const { adj, verdict } = judge(steps, hypothesis);
  assert.equal(adj.evidence_against.length, 1, 'the contradiction must survive into the judgement');
  assert.equal(adj.support_level, 'weak', 'contested evidence can never be strong');
  assert.notEqual(verdict.outcome, D.OUTCOMES.ROOT_CAUSE_ESTABLISHED);
});

test('§35 evidence against with no support at all REJECTS the hypothesis', () => {
  const steps = [incidentStep(), flowStep([ERRORED])];
  const facts = E.factsFrom(steps);
  const [adj] = DX.adjudicate([{
    id: 'hyp_1', statement: 'The automation failed.',
    evidence_for: [],
    evidence_against: [factId(facts, (f) => f.field === 'flow_execution_state')].filter(Boolean),
    missing_evidence: [],
  }], { facts, causalFactIds: DX.causalFactIdsOf(facts) });
  assert.equal(adj.status, 'rejected');
});

/* ================================================================== *
 * §27 — MULTIPLE CAUSES
 * ================================================================== */

test('§27 two supported explanations are reported as such, not forced into one', () => {
  const steps = [incidentStep(), auditStep([
    { sys_id: 'c1', field: 'assigned_to', old_value: 'd'.repeat(32), new_value: '', changed_by: 'admin', changed_at: '2026-09-04 09:00:00' },
    { sys_id: 'c2', field: 'assignment_group', old_value: 'g', new_value: '', changed_by: 'admin', changed_at: '2026-09-04 09:00:01' },
  ]), flowStep([ERRORED])];
  const facts = E.factsFrom(steps);
  const causalFactIds = DX.causalFactIdsOf(facts);
  const hyps = DX.adjudicate([
    {
      id: 'hyp_1', statement: 'The automation errored before it could assign anyone.',
      evidence_for: [
        factId(facts, (f) => f.field === 'flow_execution_state'),
        factId(facts, (f) => f.field === 'flow_execution_error'),
      ].filter(Boolean),
      evidence_against: [], missing_evidence: [],
    },
    {
      id: 'hyp_2', statement: 'Somebody cleared the assignee afterwards.',
      evidence_for: [
        factId(facts, (f) => f.field === 'changed_assigned_to'),
        factId(facts, (f) => f.field === 'changed_assignment_group'),
      ].filter(Boolean),
      evidence_against: [], missing_evidence: [],
    },
  ], { facts, causalFactIds, symptomField: 'assigned_to', subjectSysId: INC });
  const verdict = DX.classify({ hypotheses: hyps, completedReads: 3, symptomConfirmed: true, symptomCheckedDeterministically: true });
  assert.equal(verdict.outcome, D.OUTCOMES.MULTIPLE_PLAUSIBLE_CAUSES);
  assert.equal(verdict.label, 'ROOT CAUSE NOT ESTABLISHED');
});

/* ================================================================== *
 * §25 — CIRCULARITY SURVIVES THE NEW EVIDENCE
 * ================================================================== */

test('§25 a symptom still cannot prove its own cause', () => {
  const steps = [incidentStep(), flowStep([ERRORED])];
  const facts = E.factsFrom(steps);
  const hypothesis = {
    id: 'hyp_1', statement: 'The assignment process did not complete.',
    evidence_for: [factId(facts, (f) => f.field === 'assigned_to')].filter(Boolean),
    evidence_against: [], missing_evidence: [],
  };
  const { adj } = judge(steps, hypothesis);
  assert.equal(adj.support_level, 'weak');
});

test('§25 an SLA breach cannot prove that processing was slow', () => {
  const slaStep = {
    id: 'step_8', tool: 'get_record_slas', state: 'completed', inputs: { table: 'incident', sys_id: INC },
    result: {
      task_sys_id: INC, attached: true, state: 'SLA_BREACHED', count: 1, truncated: false,
      slas: [{ sys_id: SLA, definition: { name: 'P3 resolution' }, stage: 'SLA_BREACHED', has_breached: true, start_time: '2026-09-04 08:00:00', end_time: null }],
    },
  };
  const steps = [incidentStep(), slaStep];
  const facts = E.factsFrom(steps);
  const hypothesis = {
    id: 'hyp_1', statement: 'The SLA breached because processing was slow.',
    evidence_for: [factId(facts, (f) => f.field === 'sla_breached')].filter(Boolean),
    evidence_against: [], missing_evidence: [],
  };
  const { adj } = judge(steps, hypothesis, { symptomField: 'sla_breached' });
  assert.equal(adj.support_level, 'weak', 'the breach is the symptom, not its own explanation');
});

/* ================================================================== *
 * §36 — UNKNOWN WHEN A SUBSYSTEM IS UNAVAILABLE
 * ================================================================== */

test('§36 an unreadable subsystem yields UNKNOWN, never model knowledge', () => {
  const steps = [incidentStep(), { id: 'step_9', tool: 'find_flow_executions', state: 'failed', inputs: { table: 'task_sla' }, failureReason: 'the read was refused' }];
  const facts = E.factsFrom(steps);
  assert.ok(!facts.some((f) => f.source.step === 'step_9'), 'a failed read observes nothing');
  const gaps = E.gapsFrom(steps);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].step, 'step_9');
  assert.match(gaps[0].reason, /refused/);
});

/* ================================================================== *
 * §38 — READ-ONLY, INCLUDING THE NEW TOOLS
 * ================================================================== */

test('§38 all six diagnostic tools are read-only in the registry', () => {
  for (const name of CAPABILITIES.diagnostic_read.tools) {
    const t = toolMap.get(name);
    assert.ok(t, `${name} is not in the registry`);
    assert.equal(t.mutating, false, `${name} must be read-only`);
    assert.ok(!t.describeWrite, `${name} must not describe a write`);
  }
});

test('§38 a diagnostic investigation containing any mutation is refused', () => {
  const discover = (n) => {
    const cap = CAPABILITIES[n] ?? { mutating: false, verification: 'none' };
    return {
      capability: n, status: 'known', available: true, mechanism: 'rest', mutating: cap.mutating,
      verification: cap.verification, requiresVerification: cap.mutating, requiresApproval: cap.mutating,
      requiresElevation: false, elevationRole: null, scope: null, reason: null, note: null,
    };
  };
  const read = {
    id: 'step_1', operation: 'read audit', capability: 'diagnostic_read', tool: 'get_record_audit',
    mechanism: 'rest', scope: null, mutating: false, target: { table: 'incident' },
    inputs: { table: 'incident', sys_id: INC }, depends_on: [], expected_effects: [], verification: null,
  };
  for (const [tool, capability] of [['update_record', 'record_update'], ['create_record', 'record_create'],
    ['delete_record', 'record_delete']]) {
    const bad = {
      id: 'step_2', operation: 'x', capability, tool, mechanism: 'rest', scope: null, mutating: true,
      target: { table: 'incident' }, inputs: { table: 'incident', sys_id: INC, data: { state: '2' } },
      depends_on: [], expected_effects: ['state changes'],
      verification: { strategy: 'read_back', asserts: ['state == 2'] },
    };
    const v = P.validatePlan({ goal: 'investigate', steps: [read, bad] }, { discover, readOnly: true });
    assert.ok(!v.valid, `${tool} was accepted into an investigation`);
    assert.ok(v.fatal.some((p) => p.code === 'mutation_in_read_only_plan'));
  }
});

test('§38 the executor refuses to continue past failures on a plan that can write', async () => {
  const { createTask, startTask } = await import('../src/memory/tasks.js');
  const { getDb } = await import('../src/memory/db.js');
  const sid = 'p15c-guard';
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal: 'g' });
  startTask(t.id);
  const saved = P.savePlan(t.id, {
    goal: 'g',
    steps: [{
      id: 'step_1', operation: 'write', capability: 'record_update', tool: 'update_record',
      mechanism: 'rest', scope: null, mutating: true, target: { table: 'incident', sys_id: INC },
      inputs: { table: 'incident', sys_id: INC, data: { state: '2' } },
      depends_on: [], expected_effects: ['state changes'],
      verification: { strategy: 'read_back', asserts: ['state == 2'] },
    }],
  });
  P.setPlanState(t.id, 'ready');
  P.setPlanState(t.id, 'executing', {
    approved_fingerprint: saved.fingerprint, approved_at: new Date().toISOString(), approved_source: 'read_only_plan',
  });
  const res = await P.executePlan({
    taskId: t.id, sessionId: sid, turnSeq: 1, emit: () => {}, continueOnStepFailure: true,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'continue_on_failure_requires_read_only',
    'the flag must be refused, not silently ignored, on a plan that can write');
});

/* ================================================================== *
 * §21/§22 — DATAFLOW THROUGH THE NEW TOOLS
 * ================================================================== */

test('§21 the measured chain resolves: record -> SLA -> execution -> detail', () => {
  const slas = {
    task_sys_id: INC, attached: true, state: 'SLA_RUNNING', count: 1, truncated: false,
    slas: [{ sys_id: SLA, definition: { name: 'P3' }, stage: 'SLA_RUNNING' }],
  };
  const slaOut = P.extractOutputs('get_record_slas', slas);
  assert.equal(slaOut.sla_sys_id, SLA);

  const flows = {
    subject: { table: 'task_sla', sys_id: SLA }, found: true, state: 'EXECUTION_ERROR',
    count: 1, truncated: false, executions: [ERRORED],
  };
  const flowOut = P.extractOutputs('find_flow_executions', flows);
  assert.equal(flowOut.execution_sys_id, CTX);
  assert.equal(flowOut.state, 'EXECUTION_ERROR');

  const step = {
    id: 'step_10', tool: 'get_flow_execution',
    inputs: { sys_id: { $ref: 'step_9.result.execution_sys_id' } }, depends_on: ['step_9'],
  };
  const resolved = P.resolveReferences(step, { step_9: flowOut });
  assert.ok(resolved.ok, JSON.stringify(resolved.problems));
  assert.equal(resolved.args.sys_id, CTX);
});

test('§21 when nothing was found the chain fails closed instead of inventing a target', () => {
  const none = {
    subject: { table: 'task_sla', sys_id: SLA }, found: false, state: 'NO_EXECUTION_FOUND',
    count: 0, truncated: false, executions: [],
  };
  const out = P.extractOutputs('find_flow_executions', none);
  assert.ok(!('execution_sys_id' in out), 'there is no execution to name');
  const step = {
    id: 'step_10', tool: 'get_flow_execution',
    inputs: { sys_id: { $ref: 'step_9.result.execution_sys_id' } }, depends_on: ['step_9'],
  };
  const resolved = P.resolveReferences(step, { step_9: out });
  assert.ok(!resolved.ok);
  assert.equal(resolved.problems[0].code, P.RESOLUTION_CODES.MISSING_OUTPUT);
});

test('§22 every diagnostic tool declares its outputs, and nothing traverses freely', () => {
  for (const name of CAPABILITIES.diagnostic_read.tools) {
    const t = toolMap.get(name);
    assert.ok(t.outputs && Object.keys(t.outputs).length > 0, `${name} declares no outputs`);
    for (const [out, spec] of Object.entries(t.outputs)) {
      assert.ok(spec.from || spec.path, `${name}.${out} names no source`);
    }
  }
  // A reference to something undeclared is refused at plan time.
  const problems = P.validateDataflow({
    steps: [
      { id: 'step_9', tool: 'find_flow_executions', inputs: {}, depends_on: [] },
      {
        id: 'step_10', tool: 'get_flow_execution',
        inputs: { sys_id: { $ref: 'step_9.result.whatever_i_like' } }, depends_on: ['step_9'],
      },
    ],
  });
  assert.ok(problems.some((p) => p.code === P.DATAFLOW_CODES.UNKNOWN_OUTPUT));
});

/* ================================================================== *
 * §4 / §57 — STILL ONE OF EVERYTHING
 * ================================================================== */

test('§57 the Doctor still reaches no client, database or HTTP of its own', () => {
  const dir = new URL('../src/agent/doctor/', import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/^import[^;]*from\s+'([^']+)'/gm)) {
      const spec = m[1];
      if (spec.startsWith('./')) continue;
      assert.equal(spec, '../evidence/redact.js', `${f} imports ${spec}`);
    }
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [/\bfetch\s*\(/, /getDb\s*\(/, /toolMap/, /executeTool/, /servicenow\/client/]) {
      assert.ok(!forbidden.test(code), `${f} contains ${forbidden}`);
    }
  }
});

test('§4/§60.10 no second executor, verifier, approval or evidence projection appeared', () => {
  const root = new URL('../src/', import.meta.url);
  const found = { buildEvidence: [], executePlan: [] };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) { walk(child); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(child, 'utf8');
      if (/export\s+function\s+buildEvidence\s*\(/.test(src)) found.buildEvidence.push(entry.name);
      if (/export\s+async\s+function\s+executePlan\s*\(/.test(src)) found.executePlan.push(entry.name);
    }
  };
  walk(root);
  assert.deepEqual(found.buildEvidence, ['builder.js']);
  assert.deepEqual(found.executePlan, ['executor.js']);
});

test('§58 no new database table, and the schema version is unchanged', async () => {
  const { getDb } = await import('../src/memory/db.js');
  assert.equal(Object.values(getDb().prepare('PRAGMA user_version').get())[0], 23);
  const db = fs.readFileSync(new URL('../src/memory/db.js', import.meta.url), 'utf8');
  assert.ok(!/CREATE TABLE[^;]*(flow_context|diagnos|timeline|audit_cache)/i.test(db),
    'Phase 15 added a table');
});

/* ================================================================== *
 * §8 RELEVANCE — found on the real instance
 * ================================================================== */

test('§8 REGRESSION: the nearest real error does not get to explain the symptom', () => {
  /*
   * MEASURED ON dev424910 and it reached ROOT CAUSE ESTABLISHED before the
   * relevance rule existed. Every incident on that instance gets an SLA, whose
   * flow reliably ERRORs with "Failed to initialize flow context" — a genuine,
   * provenanced, causal-class failure one hop from every record on the box.
   * Offered as evidence for "the assignment automation failed", it satisfied
   * every earlier rule. The system had found the nearest error and blamed it.
   */
  const slaFlowError = {
    sys_id: CTX, flow: { sys_id: 'f'.repeat(32), name: 'SLA notification and escalation flow' },
    state: 'EXECUTION_ERROR', raw_state: 'ERROR',
    error: 'Failed to initialize flow context',
    started_at: '2026-09-04 09:11:07', last_updated_at: '2026-09-04 09:11:08',
  };
  const steps = [incidentStep(), flowStep([slaFlowError])];
  const facts = E.factsFrom(steps);
  const hypothesis = {
    id: 'hyp_1',
    statement: 'The assignment automation failed, which is why nobody is assigned.',
    evidence_for: [
      factId(facts, (f) => f.field === 'assigned_to'),
      factId(facts, (f) => f.field === 'flow_execution_error'),
    ].filter(Boolean),
    evidence_against: [], missing_evidence: [],
  };
  const [adj] = DX.adjudicate([hypothesis], {
    facts,
    symptomFactIds: DX.symptomFactIdsOf({ field: 'assigned_to' }, facts),
    causalFactIds: DX.causalFactIdsOf(facts),
    symptomField: 'assigned_to',
    subjectSysId: INC,
  });
  const verdict = DX.classify({
    hypotheses: [adj], completedReads: 2, symptomConfirmed: true, symptomCheckedDeterministically: true,
  });
  assert.notEqual(verdict.outcome, D.OUTCOMES.ROOT_CAUSE_ESTABLISHED,
    'an SLA-notification failure must not establish an assignment cause');
  assert.ok(adj.unsupported_blame.some((b) => /not about this symptom/.test(b.blames)),
    `the irrelevance must be recorded: ${JSON.stringify(adj.unsupported_blame)}`);
});

test('§8 a failure that IS about the symptom still reaches a root cause', () => {
  const steps = [incidentStep(), flowStep([ERRORED])];
  const facts = E.factsFrom(steps);
  const hypothesis = {
    id: 'hyp_1',
    statement: 'The assignment automation failed while resolving the assignment group.',
    evidence_for: [
      factId(facts, (f) => f.field === 'assigned_to'),
      factId(facts, (f) => f.field === 'flow_execution_state'),
      factId(facts, (f) => f.field === 'flow_execution_error'),
    ].filter(Boolean),
    evidence_against: [], missing_evidence: [],
  };
  const [adj] = DX.adjudicate([hypothesis], {
    facts,
    symptomFactIds: DX.symptomFactIdsOf({ field: 'assigned_to' }, facts),
    causalFactIds: DX.causalFactIdsOf(facts),
    symptomField: 'assigned_to',
    subjectSysId: INC,
  });
  assert.deepEqual(adj.unsupported_blame, [], 'a relevant failure must not be flagged');
  assert.equal(adj.support_level, 'strong');
});

test('§8 a failure ON the record itself is relevant whatever it is called', () => {
  const onTheIncident = { ...ERRORED, flow: { sys_id: 'f'.repeat(32), name: 'Nightly housekeeping' }, error: 'boom' };
  const steps = [incidentStep(), {
    id: 'step_9', tool: 'find_flow_executions', state: 'completed',
    inputs: { table: 'incident', sys_id: INC },
    result: {
      subject: { table: 'incident', sys_id: INC }, found: true, state: 'EXECUTION_ERROR',
      count: 1, truncated: false, executions: [onTheIncident],
    },
  }];
  const facts = E.factsFrom(steps);
  const cited = facts.filter((f) => String(f.field).startsWith('flow_execution'));
  assert.equal(DX.failureIsRelevant(cited, { symptomField: 'assigned_to', subjectSysId: INC }), true,
    'an execution acting on this very record is about this record');
});

test('§8 the stems come from the symptom field, not from anything a model wrote', () => {
  assert.deepEqual(DX.symptomStems('assigned_to'), ['assign']);
  assert.deepEqual(DX.symptomStems('assignment_group'), ['assign']);
  assert.deepEqual(DX.symptomStems('caller_id'), ['caller']);
  assert.deepEqual(DX.symptomStems(null), []);
  assert.deepEqual(DX.symptomStems('state'), ['state']);
});
