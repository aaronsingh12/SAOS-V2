/**
 * PHASE 9 — VERIFICATION INTEGRITY, and the tool/capability defect.
 *
 *   node --test server/test/
 *
 * THE ONE SENTENCE THIS FILE DEFENDS:
 *
 *     EXECUTION SUCCESS IS NOT VERIFICATION SUCCESS.
 *
 * Every collapse of those two is a way for the system to report a change that
 * did not happen. The cases below are the ones where the collapse is tempting:
 * a 200 with a dropped field, a read-back that agrees with a call that threw, a
 * verifier that could not run at all. In each, execution and verification must
 * come out of the evidence as SEPARATE facts, and the final status must be
 * driven by the second one.
 *
 * IT ALSO PINS THE PHASE 9 VALIDATOR DEFECT. The real-model evaluation found a
 * plan naming an elevation-requiring tool under a capability that needs none.
 * The write stayed gated and verified, but the approval card lost its elevation
 * warning — the human was asked to authorise a privileged write without being
 * told it was one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p9ver-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const P = await import('../src/agent/plan/index.js');
const R = await import('../src/agent/recovery/index.js');
const { buildEvidence, decideStatus, STATUS } = await import('../src/agent/evidence/index.js');
const { isFailedWrite } = await import('../src/agent/mutation-pipeline.js');
const { CAPABILITIES } = await import('../src/agent/capability-discovery.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

let n = 0;
function newTask(goal = 'verify') {
  const sid = `p9ver-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const SYS = 'd'.repeat(32);
const seeRecord = (sessionId, sysId = SYS) => registerFromToolResult({
  sessionId, seq: 0, table: 'incident', result: { sys_id: sysId, short_description: 'before' },
});
const localTool = (name, spec) => { toolMap.set(name, { name, ...spec }); return () => toolMap.delete(name); };

/** A write step whose read-back is expected to prove `short_description`. */
const writeStep = (over = {}) => ({
  id: 'step_1',
  operation: 'update the incident',
  capability: 'record_update',
  tool: over.tool,
  mechanism: null,
  scope: null,
  mutating: true,
  target: { table: 'incident', sys_id: SYS },
  inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'AFTER' } },
  depends_on: [],
  expected_effects: ['short_description becomes AFTER'],
  verification: { strategy: 'read_back', asserts: ['short_description == AFTER'] },
  ...over,
});

/** The real describeWrite shape: `requested` is what the verifier diffs. */
const describeWrite = (i, r) => ({
  operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id,
});

async function runPlan(taskId, sessionId, steps, { recoverStep = null } = {}) {
  const saved = P.savePlan(taskId, { goal: 'g', steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  const res = await P.executePlan({
    taskId,
    sessionId,
    turnSeq: 1,
    recoverStep,
    emit: (e) => {
      if (e.type === 'approval_required') {
        setImmediate(() => resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    },
  });
  return { res, plan: P.loadPlan(taskId), evidence: buildEvidence(taskId) };
}

/* ================================================================== *
 * A. THE SEPARATION, case by case
 * ================================================================== */

test('V1 — verification SUCCESS: the field comes back as requested', async () => {
  const d = localTool('p9v_ok', {
    mutating: true, describeWrite,
    execute: async (i) => ({ sys_id: i.sys_id, short_description: 'AFTER', number: 'INC1' }),
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res, evidence } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9v_ok' })]);
    assert.equal(res.ok, true);
    assert.equal(evidence.steps[0].execution_status, 'completed');
    assert.equal(evidence.steps[0].verification_status, 'applied');
    assert.equal(evidence.final.status, STATUS.VERIFIED);
  } finally { d(); }
});

test('V2 — a DROPPED field: executed, and NOT verified', async () => {
  // HTTP 200, a record back, the requested field simply absent. The Table API's
  // real silent-drop shape.
  const d = localTool('p9v_drop', {
    mutating: true, describeWrite,
    execute: async (i) => ({ sys_id: i.sys_id, number: 'INC1' }),
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res, evidence } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9v_drop' })]);
    // Executed — the call happened and returned a record.
    assert.equal(evidence.steps[0].executed, true, 'the call is reported as not having happened');
    // But not verified, and therefore not a success.
    assert.equal(evidence.steps[0].verification_status, 'no-op');
    assert.equal(res.ok, false, 'a dropped write was reported as a successful run');
    assert.equal(evidence.final.status, STATUS.FAILED);
  } finally { d(); }
});

test('V3 — a TRANSFORMED field: executed, landed, and still not what was asked for', async () => {
  const d = localTool('p9v_transform', {
    mutating: true, describeWrite,
    // The platform stored something else — the `priority` trap's shape.
    execute: async (i) => ({ sys_id: i.sys_id, short_description: 'SOMETHING ELSE', number: 'INC1' }),
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res, evidence } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9v_transform' })]);
    assert.equal(evidence.steps[0].executed, true);
    assert.equal(evidence.steps[0].verification_status, 'transformed');
    assert.deepEqual(evidence.changes[0].transformed_fields, ['short_description']);
    /*
     * THE ASYMMETRY THAT MATTERS. `transformed` is not a failed write — the call
     * reached the instance and something landed, so `res.ok` is true. It is also
     * not a success: the final status is not VERIFIED, and the changed value is
     * named. A caller reading the boolean alone would be misled, which is
     * precisely why `final.status` is the authority.
     */
    assert.equal(res.ok, true);
    assert.notEqual(evidence.final.status, STATUS.VERIFIED,
      'a write the platform rewrote was reported as VERIFIED');
  } finally { d(); }
});

test('V4 — MISSING read-back: no descriptor, so nothing can be proven', async () => {
  // A mutating tool with no `describeWrite` cannot be diffed. The honest answer
  // is "unverified", never "fine".
  const d = localTool('p9v_nodesc', {
    mutating: true,
    execute: async (i) => ({ sys_id: i.sys_id, ok: true }),
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { evidence } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9v_nodesc' })]);
    assert.equal(evidence.steps[0].executed, true);
    assert.notEqual(evidence.steps[0].verification_status, 'applied',
      'a write with no read-back claimed to be applied');
    assert.notEqual(evidence.final.status, STATUS.VERIFIED);
    // And the promised effect is reported as unverified rather than dropped.
    assert.ok(evidence.uncertainties.some((u) => u.kind === 'unverified_effect'),
      `no unverified_effect uncertainty: ${JSON.stringify(evidence.uncertainties.map((u) => u.kind))}`);
  } finally { d(); }
});

test('V5 — a CONTRADICTORY read-back: the tool threw, so nothing is claimed', async () => {
  /*
   * The nastiest shape: the call fails, but a read of the record would agree
   * with what was asked for — because someone else set it, or because a partial
   * write landed. The step must NOT be talked into success by that.
   */
  const d = localTool('p9v_throw', {
    mutating: true, describeWrite,
    execute: async () => { throw Object.assign(new Error('the instance said no'), { status: 500 }); },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res, evidence } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9v_throw' })]);
    assert.equal(res.ok, false);
    assert.equal(evidence.steps[0].execution_status, 'failed');
    assert.notEqual(evidence.steps[0].verification_status, 'applied',
      'a failed call was verified as applied');
    assert.equal(evidence.final.status, STATUS.FAILED);
    // Nothing was recorded as a change.
    assert.equal(evidence.changes.length, 0, 'a failed call produced a change record');
  } finally { d(); }
});

test('V6 — a verification TIMEOUT leaves the effect unproven, not assumed', async () => {
  // The tool succeeds; the read-back cannot complete. The promise stays open.
  const d = localTool('p9v_slowverify', {
    mutating: true,
    describeWrite: (i, r) => {
      // Throwing from describeWrite is how a descriptor becomes unavailable
      // mid-flight; the pipeline treats the write as unverifiable.
      void i; void r;
      throw new Error('the schema lookup timed out');
    },
    execute: async (i) => ({ sys_id: i.sys_id, short_description: 'AFTER' }),
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { evidence } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9v_slowverify' })]);
    assert.equal(evidence.steps[0].executed, true);
    assert.notEqual(evidence.steps[0].verification_status, 'applied');
    assert.notEqual(evidence.final.status, STATUS.VERIFIED,
      'an unverifiable write was reported as VERIFIED');
  } finally { d(); }
});

test('V7 — tool SUCCESS + verification FAILURE fails the step', async () => {
  const d = localTool('p9v_okbutbad', {
    mutating: true, describeWrite,
    execute: async (i) => ({ sys_id: i.sys_id, number: 'INC1' }),   // field absent
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res, plan } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9v_okbutbad' })]);
    assert.equal(res.ok, false, 'a verification failure was absorbed by a successful call');
    assert.equal(plan.steps[0].state, 'failed');
    assert.match(plan.steps[0].failureReason ?? '', /did not land as requested/);
  } finally { d(); }
});

test('V8 — isFailedWrite covers exactly the statuses that mean "did not land"', () => {
  assert.equal(isFailedWrite({ status: 'no-op' }), true);
  assert.equal(isFailedWrite({ status: 'partial' }), true);
  assert.equal(isFailedWrite({ status: 'applied' }), false);
  assert.equal(isFailedWrite({ status: 'transformed' }), false);
  assert.equal(isFailedWrite({ status: 'self-verified' }), false);
  assert.equal(isFailedWrite({ status: 'unverified' }), false);
  assert.equal(isFailedWrite(null), false);
});

/* ================================================================== *
 * B. THE EVIDENCE LAYER PRESERVES THE DISTINCTION EVERYWHERE
 * ================================================================== */

test('V9 — every step section carries BOTH statuses, under distinct names', () => {
  const src = read('agent/evidence/builder.js');
  assert.match(src, /execution_status: step\.state/);
  assert.match(src, /verification_status: verification\.status/);
  // They are never merged into one field.
  assert.ok(!/status:\s*\(?\s*executed\s*&&/.test(src), 'the two statuses are combined into one');
});

test('V10 — the final status is computed from EFFECTS, never from execution', () => {
  const src = read('agent/evidence/status.js');
  assert.ok(!/\bres\.ok\b|\bresult\.ok\b/.test(src), 'the status decider reads an executor boolean');
  // Executed-but-unverified is a first-class outcome.
  const out = decideStatus({
    planState: 'completed', taskState: 'completed', executedAnything: true,
    steps: [{ id: 's1', state: 'completed' }],
    effects: [{ step: 's1', effect: 'x', verified: null }],
  });
  assert.notEqual(out.status, STATUS.VERIFIED);
});

test('V11 — a plan that executed everything and verified nothing is not VERIFIED', () => {
  const out = decideStatus({
    planState: 'completed', taskState: 'completed', executedAnything: true,
    steps: [{ id: 's1', state: 'completed' }, { id: 's2', state: 'completed' }],
    effects: [
      { step: 's1', effect: 'a', verified: null },
      { step: 's2', effect: 'b', verified: null },
    ],
  });
  assert.equal(out.status, STATUS.UNVERIFIED, `got ${out.status}`);
});

test('V12 — coverage is about EVIDENCE, not about execution', async () => {
  const d = localTool('p9v_cov', {
    mutating: true, describeWrite,
    execute: async (i) => ({ sys_id: i.sys_id, short_description: 'AFTER' }),
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { evidence } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9v_cov' })]);
    assert.equal(evidence.verification.promised, 1);
    assert.equal(typeof evidence.verification.coverage, 'number');
    assert.ok(evidence.verification.coverage >= 0 && evidence.verification.coverage <= 1);
  } finally { d(); }
});

/* ================================================================== *
 * C. THE PHASE 9 DEFECT — tool under the wrong capability
 * ================================================================== */

/*
 * FOUND BY THE REAL-MODEL EVALUATION. A plan named `create_acl` — elevation to
 * `security_admin` — under `capability: record_update`, which needs none. It was
 * accepted, and `stampPlatformFacts` then stamped `requiresElevation: false`
 * from the DECLARED capability. The approval card takes its elevation warning
 * from that stamp, so the card said nothing about elevation.
 *
 * The write was never ungated: `runStep` reads the REGISTRY's `mutating` flag,
 * so the gate fired, the guards ran and the read-back happened. What broke is
 * narrower and still serious — the card understated what it was asking a human
 * to authorise, and Phase 4 rests on the human having approved the plan they
 * were shown.
 */

const discoverReal = (name) => {
  const c = CAPABILITIES[name] ?? {};
  return {
    capability: name, status: 'known', available: true,
    mechanism: c.mechanism ?? 'rest', mutating: c.mutating ?? true,
    verification: c.verification ?? 'read_back', requiresVerification: true,
    requiresApproval: c.mutating ?? true,
    requiresElevation: Boolean(c.requiresElevation), elevationRole: c.elevationRole ?? null,
    scope: c.scope ?? null, reason: null, note: null,
  };
};
/*
 * PHASE 10 added `missing_required_inputs`: a step must supply what its tool
 * declares as required. These fixtures therefore carry REAL inputs per tool
 * rather than one update-shaped set for everything — otherwise they would be
 * testing the capability rule through a plan that is invalid for a different
 * reason, which proves nothing.
 */
const INPUTS_FOR = {
  update_record: { table: 'incident', sys_id: SYS, data: { short_description: 'x' } },
  // `role` (singular) is not a property create_acl declares — it takes `roles`.
  // Phase 13's undeclared_inputs rule caught that here: passed as written, the
  // argument is dropped and the ACL is created with no role restriction at all.
  create_acl: { table: 'incident', operation: 'write', roles: ['itil'] },
  create_incident: { short_description: 'a new incident' },
  list_slas: {},
  create_flow_live: { name: 'notify the manager' },
};

const capStep = (capability, tool, over = {}) => ({
  id: 'step_1', operation: 'op', capability, tool, mutating: true,
  target: { table: 'incident', sys_id: SYS },
  inputs: INPUTS_FOR[tool] ?? { table: 'incident', sys_id: SYS, data: { short_description: 'x' } },
  depends_on: [], expected_effects: ['short_description is updated'],
  verification: { strategy: 'read_back', asserts: ['short_description == x'] },
  ...over,
});
const validate = (step) => P.validatePlan({ goal: 'g', steps: [step] }, { discover: discoverReal });

test('V13 — DEFECT: an elevation-requiring tool under a non-elevation capability is REFUSED', () => {
  const v = validate(capStep('record_update', 'create_acl'));
  assert.equal(v.valid, false, 'the approval card would have omitted the elevation warning');
  assert.ok(v.fatal.some((p) => p.code === 'tool_capability_mismatch'),
    `expected tool_capability_mismatch, got ${v.fatal.map((p) => p.code).join(', ')}`);
});

test('V14 — the same tool under its OWN capability is accepted', () => {
  assert.equal(validate(capStep('acl_authoring', 'create_acl')).valid, true);
  assert.equal(validate(capStep('record_update', 'update_record')).valid, true);
});

test('V15 — the exact mismatch the model produced is now refused', () => {
  // `list_slas` under `record_read`. Both are reads, so nothing unsafe would
  // have run — but the evidence would have reported a read of SLAs as a
  // generic record read, and the rule is about the declaration being true.
  const step = capStep('record_read', 'list_slas', { mutating: false, expected_effects: [], verification: null });
  const v = validate(step);
  assert.equal(v.valid, false);
  assert.ok(v.fatal.some((p) => p.code === 'tool_capability_mismatch'));
  // Under its own capability it is fine.
  assert.equal(validate(capStep('sla_read', 'list_slas', { mutating: false, expected_effects: [], verification: null })).valid, true);
});

test('V16 — a tool the taxonomy does not claim is NOT constrained', () => {
  /*
   * Eleven mutating tools are unmapped today. Inventing a capability for them in
   * the validator would be this layer asserting a taxonomy fact it has no
   * evidence for. They keep the protection they already have — the registry
   * flag, the gate, and the read-back — and the rule stays silent.
   */
  const owners = (tool) => Object.entries(CAPABILITIES)
    .filter(([, spec]) => (spec.tools ?? []).includes(tool)).map(([k]) => k);
  assert.deepEqual(owners('create_incident'), [], 'create_incident is now claimed — update this test');
  assert.equal(validate(capStep('record_create', 'create_incident')).valid, true);
});

test('V17 — a tool claimed by SEVERAL capabilities is valid under any of them', () => {
  // `create_flow_live` is legitimately part of authoring, publishing and install.
  const owners = Object.entries(CAPABILITIES)
    .filter(([, spec]) => (spec.tools ?? []).includes('create_flow_live')).map(([k]) => k);
  assert.ok(owners.length > 1, 'create_flow_live is no longer multi-owner — update this test');
  for (const cap of owners) {
    const v = validate(capStep(cap, 'create_flow_live', {
      verification: { strategy: 'semantic', asserts: ['the flow exists'] },
      expected_effects: ['the flow exists'],
    }));
    assert.ok(!v.fatal.some((p) => p.code === 'tool_capability_mismatch'),
      `create_flow_live was refused under its own capability ${cap}`);
  }
});

test('V18 — the rule reuses the taxonomy and introduces no second mapping', () => {
  const src = read('agent/plan/validator.js');
  assert.match(src, /\(spec\.tools \?\? \[\]\)\.includes\(s\.tool\)/,
    'the validator hard-codes a tool list instead of reading the capability taxonomy');
  assert.ok(!/const\s+(TOOL_OWNERS|CAPABILITY_TOOLS|TOOLS_BY_CAP)\s*=/.test(src),
    'a second capability-to-tool mapping was introduced');
});

test('V19 — the fix is in the VALIDATOR, not the prompt', () => {
  // Hard constraint: a prompt can be ignored by the next model; a validator
  // cannot. The planner prompt is unchanged by this phase.
  const planner = read('agent/plan/planner.js');
  assert.ok(!/PHASE 9/.test(planner), 'Phase 9 changed the planner prompt');
  assert.match(read('agent/plan/validator.js'), /PHASE 9 — THE TOOL MUST BELONG/);
});
