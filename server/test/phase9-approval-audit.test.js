/**
 * PHASE 9 — THE APPROVAL SECURITY AUDIT, AND THE CLOSED CALL-SITE INVENTORY.
 *
 *   node --test server/test/
 *
 * WHAT A CLOSED INVENTORY MEANS HERE. Every function that can cause, authorise
 * or gate a mutation is enumerated below with its exact call sites. The test
 * fails if a call site appears, moves or disappears. That is the point: a new
 * caller of `executeTool` is a new way to reach a write, and it must be a
 * deliberate, reviewed act rather than something that shows up in a diff nobody
 * read closely.
 *
 * THE TWO PATHS TO A MUTATION, and they are different on purpose:
 *
 *   THE AGENT PATH   orchestrator (turn loop) and plan/executor (plans). A model
 *                    proposes; a human answers a nonce-bound card; `executeTool`
 *                    refuses anything not both resolved AND attributable.
 *
 *   THE DBA PANE     routes/dba.js. NO MODEL IS INVOLVED. The HTTP request IS
 *                    the human action — a person clicked a button in the Tables
 *                    pane. Its controls are a hard allowlist of four tools, the
 *                    instance/scope binding assertions, and the tools' own
 *                    read-back. It asserts `user_click` because a click is
 *                    literally what happened.
 *
 * The distinction matters and is asserted: the agent must never be able to reach
 * the pane's endpoint, because that would be a model borrowing a human's click.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p9app-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const P = await import('../src/agent/plan/index.js');
const R = await import('../src/agent/recovery/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const O = await import('../src/agent/orchestrator.js');
const { executeTool, resolveApproval, APPROVAL_SOURCES } = O;
const { getDb } = await import('../src/memory/db.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Every .js under src/, relative and slash-normalised. */
function allSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) out.push(path.relative(SRC, full).replace(/\\/g, '/'));
    }
  };
  walk(SRC);
  return out.sort();
}

/**
 * Call sites of one identifier, excluding its own definition and comments.
 * Returns `file` only — line numbers would make the inventory churn on every
 * unrelated edit, which is how a guard stops being read.
 */
function callSites(ident) {
  const hits = [];
  for (const rel of allSources()) {
    const body = fs.readFileSync(path.join(SRC, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(new RegExp(`export\\s+(async\\s+)?function\\s+${ident}\\s*\\(`, 'g'), '')
      .replace(new RegExp(`(async\\s+)?function\\s+${ident}\\s*\\(`, 'g'), '');
    const n = (body.match(new RegExp(`\\b${ident}\\s*\\(`, 'g')) ?? []).length;
    if (n > 0) hits.push(`${rel} x${n}`);
  }
  return hits;
}

let n = 0;
function newTask(goal = 'audit') {
  const sid = `p9app-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const SYS = 'a'.repeat(32);
const seeRecord = (sessionId, sysId = SYS) => registerFromToolResult({
  sessionId, seq: 0, table: 'incident', result: { sys_id: sysId, short_description: 'x' },
});
const localTool = (name, spec) => { toolMap.set(name, { name, ...spec }); return () => toolMap.delete(name); };

const writeStep = (over = {}) => ({
  id: over.id ?? 'step_1',
  operation: over.operation ?? 'update the incident',
  capability: over.capability ?? 'record_update',
  tool: over.tool ?? null,
  mechanism: null,
  scope: null,
  mutating: true,
  target: { table: 'incident', sys_id: over.sysId ?? SYS },
  inputs: { table: 'incident', sys_id: over.sysId ?? SYS, data: { short_description: 'x' } },
  depends_on: [],
  expected_effects: ['short_description is updated'],
  verification: { strategy: 'read_back', asserts: ['ok'] },
});

async function runPlan(taskId, sessionId, steps, { onGate = null, signal = null, recoverStep = null, tamper = null } = {}) {
  const saved = P.savePlan(taskId, { goal: 'g', steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  if (tamper) tamper(taskId);
  const events = [];
  const res = await P.executePlan({
    taskId,
    sessionId,
    turnSeq: 1,
    signal,
    recoverStep,
    emit: (e) => {
      events.push(e);
      if (e.type === 'approval_required' && onGate) setImmediate(() => onGate(e));
    },
  });
  return { res, events, plan: P.loadPlan(taskId) };
}

/* ================================================================== *
 * A. THE CLOSED INVENTORY
 * ================================================================== */

/*
 * Each entry is the COMPLETE set of files that call the identifier, with the
 * number of calls. Changing one of these lists is the point at which someone
 * has to justify a new route to a mutation.
 */
const INVENTORY = {
  // The only function that can run a mutating tool. Four callers.
  executeTool: [
    'agent/orchestrator.js x1',   // the turn loop
    'agent/plan/executor.js x1',  // the plan executor
    'routes/dba.js x2',           // the Tables pane: one write, one read (snapshot)
  ],
  // Resolving a human's answer. Exactly one caller: the approve endpoint.
  resolveApproval: ['routes/agent.js x1'],
  /*
   * Waiting on one. Three: the plan step gate, the plan-level gate, and — added
   * deliberately in Phase 17 — the NowTest gate.
   *
   * THE NEW ONE IS A ROUTE TO A MUTATION AND IS MEANT TO BE. A flow test proves
   * behaviour by creating a real record on the instance, so it must be
   * authorised, and this list exists so that adding such a route is a decision
   * somebody wrote down. What was deliberately NOT done is the alternative:
   * `agent/test/` contains no approval logic at all and cannot name this
   * function — it receives an `approve` callback from `routes/plan.js` and
   * therefore cannot be given one by anything that is not a route.
   */
  awaitApprovalDecision: ['agent/plan/executor.js x1', 'routes/plan.js x3'],
  /*
   * Binding an approval to a fingerprint. One caller, still.
   *
   * NowTest binds too, and does it WITHOUT naming this function: the route
   * hands it `plan.approve = approvePlan` and the domain calls it through that
   * reference. That is the point of the injection — a module that cannot name
   * the binder cannot acquire one, so `routes/` stays the only place an
   * approval is bound.
   */
  /*
   * PHASE 20 adds the second binding, and for the same reason NowTest's exists:
   * building an application is a mutation, so it goes through the same card and
   * the same fingerprint binding as everything else. `agent/appbuild/` contains
   * no approval logic and cannot NAME either function — it receives an
   * `approve` callback from `routes/plan.js`, so `routes/` remains the only
   * place an approval is raised or bound.
   */
  approvePlan: ['routes/plan.js x2'],
  // The pre-gate write guard. Two callers, one per agent path.
  checkBeforeGate: ['agent/orchestrator.js x1', 'agent/plan/executor.js x1'],
  // The provenance guard. Three: two in the turn loop, one in the plan executor.
  checkWriteTarget: ['agent/orchestrator.js x2', 'agent/plan/executor.js x1'],
  // The single-step execution path. Two: the plan loop, and the recovery retry
  // closure — which is the same function, deliberately.
  runStep: ['agent/plan/executor.js x2'],
};

for (const [ident, expected] of Object.entries(INVENTORY)) {
  test(`I1 — the call-site inventory for ${ident} is closed`, () => {
    assert.deepEqual(callSites(ident), expected,
      `the set of callers of ${ident} changed. Every entry here is a route to a mutation; `
      + 'adding one is a deliberate security decision, not a refactor.');
  });
}

test('I2 — no module outside the two agent paths and the pane can reach executeTool', () => {
  const callers = callSites('executeTool').map((s) => s.split(' ')[0]);
  const allowed = new Set(['agent/orchestrator.js', 'agent/plan/executor.js', 'routes/dba.js']);
  for (const c of callers) assert.ok(allowed.has(c), `${c} can execute a tool`);
});

test('I3 — the recovery layer cannot reach any execution or approval primitive', () => {
  for (const f of fs.readdirSync(path.join(SRC, 'agent', 'recovery'))) {
    const src = fs.readFileSync(path.join(SRC, 'agent', 'recovery', f), 'utf8');
    for (const forbidden of ['executeTool', 'resolveApproval', 'awaitApprovalDecision', 'approvePlan']) {
      assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(src), `recovery/${f} names ${forbidden}`);
    }
  }
});

test('I4 — the evidence layer cannot reach any execution or approval primitive', () => {
  for (const f of fs.readdirSync(path.join(SRC, 'agent', 'evidence'))) {
    const src = fs.readFileSync(path.join(SRC, 'agent', 'evidence', f), 'utf8');
    for (const forbidden of ['executeTool', 'resolveApproval', 'approvePlan', 'setStepState', 'appendMutation']) {
      assert.ok(!new RegExp(`\\b${forbidden}\\s*\\(`).test(src), `evidence/${f} calls ${forbidden}`);
    }
  }
});

test('I5 — the DBA pane is a HUMAN path: no model, and the agent cannot reach it', () => {
  const dba = read('routes/dba.js');
  // A hard allowlist, not "any registered tool".
  assert.match(dba, /UI_WRITE_TOOLS = new Set\(\[/);
  assert.match(dba, /not-a-ui-write-tool/);
  // No model anywhere on this path.
  assert.ok(!/runTurn|chatOnce|callProvider|generatePlan/.test(dba), 'the pane route can invoke a model');
  // And nothing the agent runs can call this route: no tool performs HTTP to it.
  const tools = read('agent/tools.js');
  assert.ok(!/\/api\/dba|dbaRouter/.test(tools), 'a registry tool can reach the pane endpoint');
});

/* ================================================================== *
 * B. THE TEN PROOFS
 * ================================================================== */

test('A1 — no planner output can approve itself', () => {
  // The planner produces JSON. `approval` is not a field it can set that
  // anything reads as authorisation: the executor asks the gate regardless.
  const { normalizeCandidate } = P;
  const candidate = normalizeCandidate({
    goal: 'sneak',
    steps: [{
      id: 's1', operation: 'update', capability: 'record_update', tool: 'update_record',
      mutating: true, inputs: {}, expected_effects: [], verification: { strategy: 'read_back', asserts: ['x'] },
      // The model tries to authorise itself, three different ways.
      approval: { approved: true, source: 'user_click', at: new Date().toISOString() },
      approved: true,
      autoApprove: true,
    }],
  });
  // `approved` and `autoApprove` are not carried at all.
  assert.equal(candidate.steps[0].approved, undefined);
  assert.equal(candidate.steps[0].autoApprove, undefined);
  // And the executor reaches the gate for every mutating step regardless of
  // what the `approval` object says.
  const exec = read('agent/plan/executor.js');
  assert.match(exec, /if \(mutating\) \{/);
  assert.ok(!/step\.approval\?\.approved/.test(exec), 'the executor reads an approval off the plan');
});

test('A2 — a planner-supplied approval object does not execute anything', async () => {
  let ran = 0;
  const d = localTool('p9_selfapprove', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => { ran += 1; return { sys_id: i.sys_id, short_description: 'x' }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const step = { ...writeStep({ tool: 'p9_selfapprove' }), approval: { approved: true, source: 'user_click' } };
    // Nobody answers the gate; the run must hang on it, so it is cancelled.
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    const { plan } = await runPlan(taskId, sessionId, [step], { signal: ctl.signal });
    assert.equal(ran, 0, 'a plan authorised its own mutation');
    assert.equal(plan.planState, 'cancelled');
  } finally { d(); }
});

test('A3 — no recovery path can approve itself, and a retry re-asks', async () => {
  let calls = 0; let gates = 0;
  const d = localTool('p9_rec_gate', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('boom'), { status: 503 });
      return { sys_id: i.sys_id, short_description: 'x' };
    },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    await runPlan(taskId, sessionId, [writeStep({ tool: 'p9_rec_gate' })], {
      recoverStep: R.recoverStep,
      onGate: (e) => { gates += 1; resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce); },
    });
    assert.equal(calls, 2, 'the retry did not run');
    assert.equal(gates, 2, 'THE RETRY DID NOT GO BACK TO THE GATE');
  } finally { d(); }
});

test('A4 — a retry cannot bypass approval: refusing the second card stops it', async () => {
  let calls = 0; let gates = 0;
  const d = localTool('p9_rec_refuse', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('boom'), { status: 503 });
      return { sys_id: i.sys_id, short_description: 'x' };
    },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9_rec_refuse' })], {
      recoverStep: R.recoverStep,
      onGate: (e) => {
        gates += 1;
        resolveApproval(sessionId, e.approvalId, gates === 1, APPROVAL_SOURCES.USER_CLICK, e.nonce);
      },
    });
    assert.equal(calls, 1, 'a refused retry executed');
    assert.equal(res.ok, false);
  } finally { d(); }
});

test('A5 — a stale fingerprint cannot execute, with or without recovery', async () => {
  for (const recoverStep of [null, R.recoverStep]) {
    let calls = 0;
    const d = localTool('p9_stale', {
      mutating: true,
      describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
      execute: async (i) => { calls += 1; return { sys_id: i.sys_id }; },
    });
    try {
      const { taskId, sessionId } = newTask();
      seeRecord(sessionId);
      const { res } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9_stale' })], {
        recoverStep,
        onGate: (e) => resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce),
        tamper: (id) => getDb().prepare('UPDATE agent_tasks SET plan_fingerprint = ? WHERE id = ?').run('0'.repeat(64), id),
      });
      assert.equal(calls, 0, `a stale plan executed (recovery ${recoverStep ? 'on' : 'off'})`);
      assert.equal(res.reason, 'approval_stale');
    } finally { d(); }
  }
});

test('A6 — a plan EDIT invalidates the approval that described the old plan', () => {
  const { taskId } = newTask();
  const a = P.savePlan(taskId, { goal: 'A', steps: [writeStep({ id: 's1' })] });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  assert.equal(P.approvePlan(taskId, a.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK }).ok, true);
  const b = P.savePlan(taskId, { goal: 'A', steps: [writeStep({ id: 's1', operation: 'DELETE the incident' })] });
  assert.notEqual(a.fingerprint, b.fingerprint, 'an edited plan kept its fingerprint');
  assert.equal(P.checkApprovalBinding(taskId).ok, false, 'the old approval still binds the new plan');
  // And presenting the OLD fingerprint against the NEW plan is refused.
  assert.equal(P.approvePlan(taskId, a.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK }).ok, false);
});

test('A6b — EVERY field that changes what happens is inside the binding', () => {
  /*
   * The list is the security boundary: a field absent from it can be edited
   * after approval without invalidating it. So rather than trusting the list,
   * this mutates each field in turn and proves the fingerprint moves.
   */
  const base = {
    goal: 'g',
    steps: [{
      id: 's1', operation: 'update the incident', capability: 'record_update',
      mechanism: 'rest', scope: null, tool: 'update_record', mutating: true,
      target: { table: 'incident', sys_id: SYS },
      inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'x' } },
      depends_on: [], expected_effects: ['short_description is updated'],
      verification: { strategy: 'read_back', asserts: ['ok'] },
    }],
  };
  const fp = (p) => P.fingerprintPlan(p);
  const edited = (patch) => ({ ...base, steps: [{ ...base.steps[0], ...patch }] });

  const edits = {
    operation: { operation: 'DELETE the incident' },
    capability: { capability: 'record_delete' },
    mechanism: { mechanism: 'sdk' },
    scope: { scope: 'x_2002152_nwforge' },
    tool: { tool: 'delete_record' },
    target: { target: { table: 'incident', sys_id: 'b'.repeat(32) } },
    inputs: { inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'DIFFERENT' } } },
    mutating: { mutating: false },
    verification: { verification: { strategy: 'none', asserts: [] } },
    expected_effects: { expected_effects: ['something else entirely'] },
  };
  for (const [field, patch] of Object.entries(edits)) {
    assert.notEqual(fp(edited(patch)), fp(base),
      `editing "${field}" did NOT change the fingerprint — it is outside the approval binding`);
  }
  // The goal itself, and the step ORDER.
  assert.notEqual(fp({ ...base, goal: 'a different goal' }), fp(base));
  const two = { goal: 'g', steps: [base.steps[0], { ...base.steps[0], id: 's2', tool: 'delete_record' }] };
  const swapped = { goal: 'g', steps: [two.steps[1], two.steps[0]] };
  assert.notEqual(fp(swapped), fp(two), 'reordering the steps did not change the fingerprint');

  // And the declared list matches what was just proven, so the two cannot drift.
  assert.deepEqual([...P.FINGERPRINTED_STEP_FIELDS].sort(), Object.keys(edits).sort());
});

test('A6c — a step id is NOT in the binding, and dependencies survive renaming', () => {
  /*
   * Deliberate: ids are plan-local labels, and `depends_on` is canonicalised to
   * POSITIONS. Renaming `step_1` to `step_a` is not a change to what happens,
   * and invalidating an approval over it would train people to re-approve
   * reflexively. Reordering IS a change, and A6b proves that still moves it.
   */
  const mk = (id1, id2) => ({
    goal: 'g',
    steps: [
      { id: id1, operation: 'read', capability: 'record_read', tool: 'get_record', mutating: false, inputs: {}, depends_on: [], expected_effects: [], verification: null },
      { id: id2, operation: 'write', capability: 'record_update', tool: 'update_record', mutating: true, inputs: {}, depends_on: [id1], expected_effects: ['x'], verification: { strategy: 'read_back', asserts: ['ok'] } },
    ],
  });
  assert.equal(P.fingerprintPlan(mk('step_1', 'step_2')), P.fingerprintPlan(mk('alpha', 'beta')),
    'renaming a step id invalidated an approval it should not have');
});

test('A7 — an approval nonce cannot be reused, and a wrong one leaves it pending', async () => {
  const { sessionId } = newTask();
  let card = null;
  const d = localTool('p9_nonce', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => ({ sys_id: i.sys_id, short_description: 'x' }),
  });
  try {
    const { taskId } = newTask();
    seeRecord(sessionId);
    const p = runPlan(taskId, sessionId, [writeStep({ tool: 'p9_nonce' })], {
      onGate: (e) => {
        card = e;
        // 1. A wrong token is refused and the approval STAYS pending.
        const bad = resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, 'not-the-nonce');
        assert.equal(bad.ok, false);
        assert.equal(bad.reason, 'token-mismatch');
        // 2. No token at all is refused too.
        assert.equal(resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, null).ok, false);
        // 3. The correct one works, once.
        assert.equal(resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce).ok, true);
      },
    });
    await p;
    // 4. Replaying the same nonce afterwards finds nothing to consume.
    const replay = resolveApproval(sessionId, card.approvalId, true, APPROVAL_SOURCES.USER_CLICK, card.nonce);
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'no-such-approval', 'a spent approval could be replayed');
  } finally { d(); }
});

test('A8 — a REJECTED approval cannot be replayed as an acceptance', async () => {
  let ran = 0; let card = null;
  const d = localTool('p9_reject_replay', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => { ran += 1; return { sys_id: i.sys_id }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    await runPlan(taskId, sessionId, [writeStep({ tool: 'p9_reject_replay' })], {
      onGate: (e) => { card = e; resolveApproval(sessionId, e.approvalId, false, APPROVAL_SOURCES.USER_CLICK, e.nonce); },
    });
    assert.equal(ran, 0);
    // The card is gone; a second POST saying "yes" resolves nothing.
    const again = resolveApproval(sessionId, card.approvalId, true, APPROVAL_SOURCES.USER_CLICK, card.nonce);
    assert.equal(again.ok, false);
    assert.equal(ran, 0, 'a rejection was replayed into an execution');
  } finally { d(); }
});

test('A9 — an approval card belongs to its own task and plan', async () => {
  const cards = [];
  const d = localTool('p9_belongs', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => ({ sys_id: i.sys_id, short_description: 'x' }),
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const saved = P.loadPlan(taskId);
    await runPlan(taskId, sessionId, [writeStep({ tool: 'p9_belongs' })], {
      onGate: (e) => { cards.push(e); resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce); },
    });
    const card = cards[0];
    assert.equal(card.plan.taskId, taskId, 'the card does not name its task');
    assert.equal(card.plan.stepId, 'step_1');
    assert.equal(card.plan.fingerprint, P.loadPlan(taskId).fingerprint,
      'the card does not carry the fingerprint it is authorising');
    assert.ok(saved || true);
  } finally { d(); }
});

test('A10 — concurrent approval cards cannot consume each other', async () => {
  const ran = [];
  const mk = (name) => localTool(name, {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => { ran.push(name); return { sys_id: i.sys_id, short_description: 'x' }; },
  });
  const d1 = mk('p9_cardA'); const d2 = mk('p9_cardB');
  try {
    const a = newTask('A'); const b = newTask('B');
    seeRecord(a.sessionId); seeRecord(b.sessionId);
    const cards = { A: null, B: null };
    const pa = runPlan(a.taskId, a.sessionId, [writeStep({ tool: 'p9_cardA' })], { onGate: (e) => { cards.A = e; } });
    const pb = runPlan(b.taskId, b.sessionId, [writeStep({ tool: 'p9_cardB' })], { onGate: (e) => { cards.B = e; } });
    // Wait for both cards to exist.
    for (let i = 0; i < 200 && (!cards.A || !cards.B); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cards.A && cards.B, 'both cards were not raised');
    assert.notEqual(cards.A.approvalId, cards.B.approvalId);
    assert.notEqual(cards.A.nonce, cards.B.nonce);

    // A's nonce presented against B's card must be refused, and must NOT
    // consume B's pending approval.
    const cross = resolveApproval(b.sessionId, cards.B.approvalId, true, APPROVAL_SOURCES.USER_CLICK, cards.A.nonce);
    assert.equal(cross.ok, false, 'one card\'s token answered another card');
    assert.equal(cross.reason, 'token-mismatch');
    // A's approvalId in B's session resolves nothing at all.
    assert.equal(resolveApproval(b.sessionId, cards.A.approvalId, true, APPROVAL_SOURCES.USER_CLICK, cards.A.nonce).ok, false);

    // Both then resolve correctly, each with its own token.
    resolveApproval(a.sessionId, cards.A.approvalId, true, APPROVAL_SOURCES.USER_CLICK, cards.A.nonce);
    resolveApproval(b.sessionId, cards.B.approvalId, true, APPROVAL_SOURCES.USER_CLICK, cards.B.nonce);
    await Promise.all([pa, pb]);
    assert.deepEqual(ran.sort(), ['p9_cardA', 'p9_cardB']);
  } finally { d1(); d2(); }
});

test('A11 — cancellation cannot fabricate an approval', async () => {
  let ran = 0;
  const d = localTool('p9_cancel_appr', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => { ran += 1; return { sys_id: i.sys_id }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const { plan, events } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9_cancel_appr' })], { signal: ctl.signal });
    assert.equal(ran, 0, 'a cancellation authorised a mutation');
    assert.equal(plan.planState, 'cancelled');
    // The resolution frame, if any, must say cancelled — never approved.
    const resolved = events.find((e) => e.type === 'approval_resolved');
    if (resolved) {
      assert.equal(resolved.approved, false);
      assert.equal(resolved.source, 'cancelled');
    }
    // And the step is cancelled, not rejected: a cancellation is not a refusal.
    assert.equal(plan.steps[0].state, 'cancelled');
  } finally { d(); }
});

test('A12 — auto-approve is the one ungated path, is off by default, and is loud', async () => {
  const { agent } = (await import('../src/config/store.js')).getSettings();
  assert.equal(agent.autoApprove, false, 'auto-approve is on in the test configuration');
  const exec = read('agent/plan/executor.js');
  assert.match(exec, /ran UNGATED/);
  assert.match(exec, /APPROVAL_SOURCES\.AUTO_APPROVE/);
  // It is a parameter, never inferred.
  assert.match(exec, /autoApprove = false/);
  assert.ok(!/autoApprove\s*=\s*true/.test(exec), 'the executor can turn auto-approve on by itself');
});

test('A13 — executeTool is the choke point: every unresolved or unattributable approval is refused', async () => {
  const tool = { name: 'p9_choke', mutating: true, execute: async () => ({ ok: true }) };
  const good = { source: APPROVAL_SOURCES.USER_CLICK };
  for (const approval of [null, undefined, '', 'pending', 'rejected', 'cancelled', 'approved ', true, 0, 1, {}]) {
    await assert.rejects(() => executeTool(tool, {}, approval, good),
      /Refusing to execute the mutating tool/, `approval=${JSON.stringify(approval)} was accepted`);
  }
  for (const prov of [null, undefined, {}, { source: null }, { source: 'unknown' }, { source: 'model' }]) {
    await assert.rejects(() => executeTool(tool, {}, 'approved', prov),
      undefined, `provenance=${JSON.stringify(prov)} was accepted`);
  }
});
