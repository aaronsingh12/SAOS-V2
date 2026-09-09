/**
 * PHASE 8 — THE SECURITY REGRESSION, ITEM BY ITEM.
 *
 *   node --test server/test/
 *
 * Phase 8 changed three things that touch security surfaces: the audit tables
 * gained a task id, the chat stream gained a frame, and the planner prompt gained
 * a tool list. None of them should have moved a single control — this file
 * asserts each of the fifteen invariants Phase 8 named, against the code and
 * behaviour as they stand now.
 *
 * NO EXCEPTIONS WERE MADE FOR THESE TESTS. Every one drives the same gate, the
 * same guards and the same registry that a real run does. Where a test needs a
 * failure, the failure is injected at the transport, never by relaxing a check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p8sec-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'hunter2' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const P = await import('../src/agent/plan/index.js');
const R = await import('../src/agent/recovery/index.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { findSecrets } = await import('../src/agent/evidence/redact.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const { executeTool, resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

let n = 0;
function newTask(goal = 'security') {
  const sid = `p8sec-${++n}`;
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

const localTool = (name, spec) => {
  toolMap.set(name, { name, ...spec });
  return () => toolMap.delete(name);
};
const httpError = (status, message = 'the instance said no') => Object.assign(new Error(message), { status });

const writeStep = (over = {}) => ({
  id: over.id ?? 'step_1',
  operation: over.operation ?? 'update the incident',
  capability: over.capability ?? 'record_update',
  tool: over.tool ?? null,
  mechanism: null,
  scope: null,
  mutating: true,
  target: { table: 'incident', sys_id: over.sysId ?? SYS },
  inputs: over.inputs ?? { table: 'incident', sys_id: over.sysId ?? SYS, data: { short_description: 'x' } },
  depends_on: [],
  expected_effects: ['short_description is updated'],
  verification: { strategy: 'read_back', asserts: ['ok'] },
});

async function runPlan(taskId, sessionId, steps, { decide = true, signal = null, recoverStep = null, tamper = null } = {}) {
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
      if (e.type === 'approval_required' && decide !== null) {
        setImmediate(() => resolveApproval(sessionId, e.approvalId, decide, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    },
  });
  return { res, events, plan: P.loadPlan(taskId), evidence: buildEvidence(taskId) };
}

/* ================================================================== *
 * APPROVAL
 * ================================================================== */

test('S1 — an approval cannot be fabricated: executeTool refuses an unresolved one', async () => {
  const tool = { name: 's1', mutating: true, execute: async () => ({ ok: true }) };
  for (const approval of [null, undefined, 'pending', 'maybe', 'rejected', true, 1]) {
    await assert.rejects(
      () => executeTool(tool, {}, approval, { source: APPROVAL_SOURCES.USER_CLICK }),
      /Refusing to execute the mutating tool/,
      `approval=${JSON.stringify(approval)} was accepted`,
    );
  }
});

test('S2 — user_click provenance stays mandatory: an unattributable approval does not execute', async () => {
  let ran = 0;
  const tool = { name: 's2', mutating: true, execute: async () => { ran += 1; return { ok: true }; } };
  await assert.rejects(() => executeTool(tool, {}, 'approved', null));
  await assert.rejects(() => executeTool(tool, {}, 'approved', { source: 'unknown' }));
  await assert.rejects(() => executeTool(tool, {}, 'approved', { source: 'because_i_said_so' }));
  assert.equal(ran, 0, 'a mutation ran without an attributable approval');
});

test('S3 — the plan executor never writes an approval it did not receive', () => {
  const src = read('agent/plan/executor.js');
  /*
   * `approval = 'approved'` DOES appear, and must: it translates the gate's
   * verdict into the ledger's vocabulary. What matters is that it cannot happen
   * without a real decision, so the assertion is about its neighbours — the
   * source and timestamp come from `decision`, never from this module.
   */
  const idx = src.indexOf("approval = 'approved';");
  assert.ok(idx > 0, 'the executor no longer records an approval at all');
  const after = src.slice(idx, idx + 200);
  assert.match(after, /approvedSource = decision\.source;/,
    'the executor records an approval whose source it invented');
  assert.match(after, /approvedAt = decision\.at;/);
  // And it is inside the branch that waited for the gate.
  const gate = src.indexOf('await requestApproval(');
  assert.ok(gate > 0 && gate < idx, 'an approval is recorded before the gate is reached');
  assert.match(src, /awaitApprovalDecision\(/, 'the executor no longer waits on the real gate');
  // auto-approve is the ONE ungated path and it is labelled as such.
  assert.match(src, /APPROVAL_SOURCES\.AUTO_APPROVE/);
  assert.match(src, /ran UNGATED/, 'the ungated path is no longer loud about being ungated');
});

test('S4 — approving one plan does not authorise another', async () => {
  let ranB = 0;
  const d = localTool('p8sec_b', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => { ranB += 1; return { sys_id: i.sys_id, short_description: 'x' }; },
  });
  try {
    const a = newTask('A'); const b = newTask('B');
    seeRecord(a.sessionId); seeRecord(b.sessionId);
    await runPlan(a.taskId, a.sessionId, [writeStep({ tool: 'p8sec_b' })], { decide: true });
    const rb = await runPlan(b.taskId, b.sessionId, [writeStep({ tool: 'p8sec_b' })], { decide: false });
    assert.equal(rb.res.ok, false);
    assert.equal(ranB, 1, 'B executed on A\'s approval');
  } finally { d(); }
});

/* ================================================================== *
 * ELEVATION AND IMPERSONATION
 * ================================================================== */

test('S5 — elevation cannot be self-authorised', () => {
  // The capability taxonomy, not the plan, decides that elevation is needed;
  // and the executor surfaces it on the card rather than granting it.
  const src = read('agent/plan/executor.js');
  assert.match(src, /step\.approval\?\.requiresElevation/,
    'the executor no longer surfaces an elevation requirement to the human');
  assert.ok(!/requiresElevation\s*=\s*false/.test(src), 'the executor clears an elevation requirement');
  const stamp = read('agent/plan/planner.js');
  assert.match(stamp, /stampPlatformFacts/);
  assert.ok(!/requiresElevation:\s*(step|plan|candidate)\./.test(stamp),
    'the elevation flag is taken from the model\'s own plan');
});

test('S6 — impersonation semantics are unchanged by Phase 8', () => {
  // Phase 8 touched the ledger, sessions, capture, the planner prompt, the plan
  // executor and the evidence layer. None of them may have altered the
  // impersonation surface.
  for (const f of ['agent/impersonated-write.js', 'agent/impersonation-ops.js']) {
    const src = read(f);
    assert.ok(!/PHASE 8/.test(src), `${f} was modified by Phase 8`);
  }
});

/* ================================================================== *
 * CANCELLATION
 * ================================================================== */

test('S7 — cancellation cannot bypass the mutation safety span', () => {
  // Phase 0's invariant, asserted structurally: nothing aborts a tool mid-call.
  const exec = read('agent/plan/executor.js');
  const between = exec.slice(exec.indexOf('const raw = await executeTool'), exec.indexOf('appendMutation('));
  assert.ok(!/signal\?\.aborted|signal\.aborted|throwIfAborted/.test(between),
    'a cancellation check sits inside the mutation span, between execution and the ledger');
  const rec = read('agent/recovery/executor.js');
  assert.equal((rec.match(/signal\?\.aborted/g) ?? []).length, 1,
    'recovery checks cancellation somewhere other than its own entry boundary');
});

test('S8 — cancellation cannot bypass cleanup: the ledger and state still get written', async () => {
  const ctl = new AbortController();
  const d = localTool('p8sec_cancel', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => { ctl.abort(); return { sys_id: i.sys_id, short_description: 'x' }; },
  });
  try {
    const { taskId, sessionId } = newTask('cancel mid-tool');
    seeRecord(sessionId);
    const { plan } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p8sec_cancel' })], { signal: ctl.signal });
    // The tool finished, so its result must be recorded — cancellation stops the
    // NEXT thing, never the accounting for what already happened.
    const rows = getDb().prepare('SELECT * FROM mutation_ledger WHERE session = ?').all(sessionId);
    assert.equal(rows.length, 1, 'a completed mutation went unrecorded because of a cancellation');
    assert.equal(rows[0].task_id, taskId);
    assert.ok(['completed', 'failed'].includes(plan.steps[0].state),
      `the step was left in ${plan.steps[0].state} after its tool completed`);
  } finally { d(); }
});

test('S9 — cancellation starts no recovery', async () => {
  const ctl = new AbortController();
  const d = localTool('p8sec_cancel_rec', {
    mutating: false,
    execute: async () => { ctl.abort(); throw httpError(503); },
  });
  try {
    const { taskId, sessionId } = newTask('cancel then fail');
    const { evidence } = await runPlan(taskId, sessionId, [{
      ...writeStep({ tool: 'p8sec_cancel_rec' }), mutating: false,
      capability: 'record_read', verification: null, expected_effects: [],
    }], { signal: ctl.signal, recoverStep: R.recoverStep });
    assert.equal(evidence.recovery.recoveredSteps, 0);
  } finally { d(); }
});

/* ================================================================== *
 * RECOVERY
 * ================================================================== */

test('S10 — recovery cannot approve itself', () => {
  const rec = read('agent/recovery/executor.js');
  assert.ok(!/resolveApproval|APPROVAL_SOURCES|approval\s*[:=]\s*['"]approved['"]/.test(rec),
    'the recovery executor can produce an approval');
  for (const f of fs.readdirSync(path.join(SRC, 'agent', 'recovery'))) {
    const src = fs.readFileSync(path.join(SRC, 'agent', 'recovery', f), 'utf8');
    assert.ok(!/resolveApproval/.test(src), `${f} can resolve an approval`);
  }
});

test('S11 — recovery cannot bypass the fingerprint binding', async () => {
  let calls = 0;
  const d = localTool('p8sec_stale_rec', {
    mutating: false,
    execute: async () => { calls += 1; throw httpError(503); },
  });
  try {
    const { taskId, sessionId } = newTask('stale under recovery');
    const { res } = await runPlan(taskId, sessionId, [{
      ...writeStep({ tool: 'p8sec_stale_rec' }), mutating: false,
      capability: 'record_read', verification: null, expected_effects: [],
    }], {
      recoverStep: R.recoverStep,
      tamper: (id) => getDb().prepare('UPDATE agent_tasks SET plan_fingerprint = ? WHERE id = ?').run('0'.repeat(64), id),
    });
    assert.equal(calls, 0, 'a stale plan executed at all');
    assert.equal(res.ok, false);
  } finally { d(); }
});

test('S12 — recovery cannot bypass the write guards', async () => {
  let calls = 0;
  const d = localTool('p8sec_guard_rec', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async () => { calls += 1; throw httpError(503); },
  });
  try {
    // A sys_id this session has never seen: the provenance guard must hold on
    // the first attempt AND on any retry.
    const { taskId, sessionId } = newTask('guarded under recovery');
    const { res } = await runPlan(taskId, sessionId,
      [writeStep({ tool: 'p8sec_guard_rec', sysId: 'f'.repeat(32) })], { recoverStep: R.recoverStep });
    assert.equal(calls, 0, 'recovery talked a write past the confabulation guard');
    assert.match(res.note, /never appeared in this session/);
  } finally { d(); }
});

test('S13 — a non-idempotent operation is never automatically retried', async () => {
  let calls = 0;
  const d = localTool('p8sec_create', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'create', table: 'incident', requested: i, sys_id: r?.sys_id ?? null }),
    execute: async () => { calls += 1; throw httpError(503); },
  });
  try {
    const { taskId, sessionId } = newTask('create under recovery');
    const { res } = await runPlan(taskId, sessionId, [{
      ...writeStep({ tool: 'p8sec_create' }),
      capability: 'record_create', target: { table: 'incident', sys_id: null },
      inputs: { table: 'incident', data: { short_description: 'new' } },
    }], { recoverStep: R.recoverStep });
    assert.equal(calls, 1, 'A CREATE WAS REPEATED');
    assert.equal(res.recovery.decision.idempotency, 'NON_IDEMPOTENT');
  } finally { d(); }
});

test('S14 — an UNKNOWN failure kind stops, and UNKNOWN idempotency stops', async () => {
  // Unknown failure: no HTTP status, no taxonomy match.
  const d1 = localTool('p8sec_unknown_fail', {
    mutating: false, execute: async () => { throw new Error('nothing classifies this'); },
  });
  // Unknown idempotency: a mutating tool that cannot describe its own write.
  const d2 = localTool('p8sec_unknown_idem', {
    mutating: true, execute: async () => { throw httpError(503); },
  });
  try {
    const a = newTask('unknown failure');
    const ra = await runPlan(a.taskId, a.sessionId, [{
      ...writeStep({ tool: 'p8sec_unknown_fail' }), mutating: false,
      capability: 'record_read', verification: null, expected_effects: [],
    }], { recoverStep: R.recoverStep });
    assert.equal(ra.res.recovery.decision.decision, 'STOP');
    assert.equal(ra.res.recovery.decision.failure.kind, 'UNKNOWN');

    const b = newTask('unknown idempotency');
    seeRecord(b.sessionId);
    const rb = await runPlan(b.taskId, b.sessionId, [writeStep({ tool: 'p8sec_unknown_idem' })],
      { recoverStep: R.recoverStep });
    assert.equal(rb.res.recovery.decision.idempotency, 'UNKNOWN');
    assert.notEqual(rb.res.recovery.decision.decision, 'RETRY');
  } finally { d1(); d2(); }
});

/* ================================================================== *
 * EVIDENCE
 * ================================================================== */

test('S15 — evidence carries no credentials, including the new sections', async () => {
  const d = localTool('p8sec_leak', {
    mutating: false,
    execute: async () => {
      throw httpError(503, 'auth failed: Authorization: Basic YWRtaW46aHVudGVyMg== for admin');
    },
  });
  try {
    const { taskId, sessionId } = newTask('leak');
    await runPlan(taskId, sessionId, [{
      ...writeStep({ tool: 'p8sec_leak' }), mutating: false,
      capability: 'record_read', verification: null, expected_effects: [],
    }], { recoverStep: R.recoverStep });
    const ev = buildEvidence(taskId);
    assert.deepEqual(findSecrets(ev), [], `evidence carries a credential: ${JSON.stringify(findSecrets(ev))}`);
    const blob = JSON.stringify(ev);
    assert.ok(!blob.includes('YWRtaW46aHVudGVyMg=='), 'a serialised Basic credential survived');
    // The configured password must never appear, from any section.
    assert.ok(!blob.includes('hunter2'), 'the configured password reached the evidence object');
  } finally { d(); }
});

test('S16 — evidence cannot cross a task or session boundary', () => {
  const a = newTask('A'); const b = newTask('B');
  P.savePlan(a.taskId, { goal: 'A', steps: [writeStep({ id: 'only_a' })] });
  P.savePlan(b.taskId, { goal: 'B', steps: [writeStep({ id: 'only_b' })] });
  const ea = buildEvidence(a.taskId);
  assert.deepEqual(ea.steps.map((s) => s.id), ['only_a']);
  assert.equal(ea.task.id, a.taskId);
  // And the read model is scoped by session in SQL, before any window applies.
  const rm = read('agent/evidence/read-model.js');
  assert.match(rm, /FROM tool_events WHERE session = \?/);
  assert.match(rm, /FROM mutation_ledger WHERE session = \?/);
});

test('S17 — a stale plan cannot execute, with or without recovery', async () => {
  for (const recoverStep of [null, R.recoverStep]) {
    let calls = 0;
    const d = localTool('p8sec_stale', {
      mutating: true,
      describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
      execute: async (i) => { calls += 1; return { sys_id: i.sys_id }; },
    });
    try {
      const { taskId, sessionId } = newTask('stale');
      seeRecord(sessionId);
      const { res, evidence } = await runPlan(taskId, sessionId, [writeStep({ tool: 'p8sec_stale' })], {
        recoverStep,
        tamper: (id) => getDb().prepare('UPDATE agent_tasks SET plan_fingerprint = ? WHERE id = ?').run('0'.repeat(64), id),
      });
      assert.equal(calls, 0, `a stale plan executed (recovery=${recoverStep ? 'on' : 'off'})`);
      assert.equal(res.ok, false);
      assert.equal(evidence.final.status, 'BLOCKED');
    } finally { d(); }
  }
});

test('S18 — PHASE 8 made no exception for its own tests', () => {
  // No test-only escape hatch was added to any control this phase touched.
  for (const f of ['agent/plan/executor.js', 'agent/recovery/executor.js', 'agent/orchestrator.js',
    'memory/ledger.js', 'memory/sessions.js', 'agent/evidence/builder.js']) {
    const src = read(f);
    assert.ok(!/PHASE_8_TEST|skipGuard|bypassApproval|__test(Only)?Approve/i.test(src),
      `${f} contains a test-only bypass`);
  }
});
