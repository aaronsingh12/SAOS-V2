/**
 * PHASE 9 — THE CLIENT CONTRACT.
 *
 *   node --test server/test/
 *
 * The Evidence Panel is checked against REAL server responses for every
 * lifecycle state, without a DOM. What is verified is the contract between the
 * two halves, which is where this kind of UI actually breaks:
 *
 *   every field the panel reads exists on the server's object;
 *   every VALUE the server can emit is one the panel's vocabulary recognises;
 *   nothing the panel renders implies success when verification did not succeed.
 *
 * WHY NOT RENDER IT. Rendering would need a DOM harness this project does not
 * have, and would test React rather than the contract. The failure Phase 8
 * actually hit was a field-name mismatch — `state` versus `execution_status` —
 * which no amount of rendering would have caught if the fixture were written
 * from the same wrong assumption. Driving the real server and reading the real
 * component source catches exactly that class.
 *
 * THE ONE RULE THE UI MUST NEVER BREAK: it must not say "successful" when the
 * call ran and the verification did not. The panel is asserted to have no
 * success-shaped vocabulary at all — no tick, no "done", no "success" — only
 * the server's own status words.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p9cli-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const P = await import('../src/agent/plan/index.js');
const R = await import('../src/agent/recovery/index.js');
const { buildEvidence, STATUS } = await import('../src/agent/evidence/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');
const { STEP_STATES } = await import('../src/agent/plan/states.js');

const CLIENT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');
const PANEL = fs.readFileSync(path.join(CLIENT, 'components', 'EvidencePanel.jsx'), 'utf8');
const CHAT = fs.readFileSync(path.join(CLIENT, 'pages', 'AgentChat.jsx'), 'utf8');

/** Pull an object-literal map out of the panel source, as a key set. */
function mapKeys(name) {
  const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(PANEL);
  assert.ok(m, `${name} is no longer a literal map in the panel`);
  return new Set([...m[1].matchAll(/^\s*'?([A-Za-z_][\w-]*)'?\s*:/gm)].map((x) => x[1]));
}

let n = 0;
function newTask(goal) {
  const sid = `p9cli-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const SYS = 'b'.repeat(32);
const seeRecord = (sessionId) => registerFromToolResult({
  sessionId, seq: 0, table: 'incident', result: { sys_id: SYS, short_description: 'before' },
});
const localTool = (name, spec) => { toolMap.set(name, { name, ...spec }); return () => toolMap.delete(name); };
const describeWrite = (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id });
const err = (status, m = 'boom') => Object.assign(new Error(m), { status });

const writeStep = (over = {}) => ({
  id: 'step_1', operation: 'update the incident', capability: 'record_update',
  tool: over.tool, mechanism: null, scope: null, mutating: true,
  target: { table: 'incident', sys_id: SYS },
  inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'AFTER' } },
  depends_on: [], expected_effects: ['short_description becomes AFTER'],
  verification: { strategy: 'read_back', asserts: ['short_description == AFTER'] },
  ...over,
});

async function runPlan(taskId, sessionId, steps, { decide = true, signal = null, recoverStep = null, tamper = null } = {}) {
  const saved = P.savePlan(taskId, { goal: 'g', steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  if (tamper) tamper(taskId);
  await P.executePlan({
    taskId, sessionId, turnSeq: 1, signal, recoverStep,
    emit: (e) => {
      if (e.type === 'approval_required' && decide !== null) {
        setImmediate(() => resolveApproval(sessionId, e.approvalId, decide, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    },
  });
  return buildEvidence(taskId);
}

/* ------------------------------------------------------------------ *
 * Build one real evidence object per state Phase 9 names.
 * ------------------------------------------------------------------ */

const STATES = {};

test('C0 — produce a real evidence object for every lifecycle state', async () => {
  // running
  {
    const { taskId } = newTask('running');
    P.savePlan(taskId, { goal: 'running', steps: [writeStep({ tool: 'update_record' })] });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'executing');
    STATES.running = buildEvidence(taskId);
  }
  // completed + verified
  {
    const d = localTool('p9cli_ok', {
      mutating: true, describeWrite,
      execute: async (i) => ({ sys_id: i.sys_id, short_description: 'AFTER' }),
    });
    try {
      const { taskId, sessionId } = newTask('completed');
      seeRecord(sessionId);
      STATES.completed = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9cli_ok' })]);
    } finally { d(); }
  }
  // failed
  {
    const d = localTool('p9cli_fail', {
      mutating: true, describeWrite,
      execute: async () => { throw err(500, 'the instance said no'); },
    });
    try {
      const { taskId, sessionId } = newTask('failed');
      seeRecord(sessionId);
      STATES.failed = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9cli_fail' })]);
    } finally { d(); }
  }
  // unverified (a write that landed differently)
  {
    const d = localTool('p9cli_transformed', {
      mutating: true, describeWrite,
      execute: async (i) => ({ sys_id: i.sys_id, short_description: 'SOMETHING ELSE' }),
    });
    try {
      const { taskId, sessionId } = newTask('unverified');
      seeRecord(sessionId);
      STATES.unverified = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9cli_transformed' })]);
    } finally { d(); }
  }
  // blocked (stale approval)
  {
    const d = localTool('p9cli_stale', { mutating: true, describeWrite, execute: async (i) => ({ sys_id: i.sys_id }) });
    try {
      const { taskId, sessionId } = newTask('blocked');
      seeRecord(sessionId);
      STATES.blocked = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9cli_stale' })], {
        tamper: (id) => getDb().prepare('UPDATE agent_tasks SET plan_fingerprint = ? WHERE id = ?').run('0'.repeat(64), id),
      });
    } finally { d(); }
  }
  // cancelled
  {
    const ctl = new AbortController();
    ctl.abort();
    const d = localTool('p9cli_cancel', { mutating: true, describeWrite, execute: async (i) => ({ sys_id: i.sys_id }) });
    try {
      const { taskId, sessionId } = newTask('cancelled');
      seeRecord(sessionId);
      STATES.cancelled = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9cli_cancel' })], { signal: ctl.signal });
    } finally { d(); }
  }
  // approval cancelled (the gate itself was interrupted)
  {
    const ctl = new AbortController();
    const d = localTool('p9cli_gate', { mutating: true, describeWrite, execute: async (i) => ({ sys_id: i.sys_id }) });
    try {
      const { taskId, sessionId } = newTask('approval cancelled');
      seeRecord(sessionId);
      setTimeout(() => ctl.abort(), 120);
      STATES.approvalCancelled = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9cli_gate' })],
        { signal: ctl.signal, decide: null });
    } finally { d(); }
  }
  // recovered + repeated mutation
  {
    let calls = 0;
    const d = localTool('p9cli_recover', {
      mutating: false,
      execute: async () => { calls += 1; if (calls === 1) throw err(503); return { ok: true }; },
    });
    try {
      const { taskId, sessionId } = newTask('recovered');
      STATES.recovered = await runPlan(taskId, sessionId, [writeStep({
        tool: 'p9cli_recover', mutating: false, capability: 'record_read',
        expected_effects: [], verification: null,
      })], { recoverStep: R.recoverStep });
    } finally { d(); }
  }
  // unrecovered failure
  {
    const d = localTool('p9cli_unrecovered', {
      mutating: false, execute: async () => { throw err(503); },
    });
    try {
      const { taskId, sessionId } = newTask('unrecovered');
      STATES.unrecovered = await runPlan(taskId, sessionId, [writeStep({
        tool: 'p9cli_unrecovered', mutating: false, capability: 'record_read',
        expected_effects: [], verification: null,
      })], { recoverStep: R.recoverStep });
    } finally { d(); }
  }
  // rejected
  {
    const d = localTool('p9cli_rejected', { mutating: true, describeWrite, execute: async (i) => ({ sys_id: i.sys_id }) });
    try {
      const { taskId, sessionId } = newTask('rejected');
      seeRecord(sessionId);
      STATES.rejected = await runPlan(taskId, sessionId, [writeStep({ tool: 'p9cli_rejected' })], { decide: false });
    } finally { d(); }
  }

  assert.equal(Object.keys(STATES).length, 10, 'not every state was produced');
  for (const [name, ev] of Object.entries(STATES)) assert.ok(ev, `${name} produced no evidence`);
});

/* ================================================================== *
 * A. EVERY FIELD THE PANEL READS EXISTS
 * ================================================================== */

test('C1 — every top-level field the panel reads is present in every state', () => {
  const required = ['final', 'plan', 'request', 'approval', 'steps', 'changes',
    'recovery', 'uncertainties', 'audit', 'verification', 'task'];
  for (const [name, ev] of Object.entries(STATES)) {
    for (const key of required) {
      assert.ok(key in ev, `${name}: evidence has no "${key}", which the panel reads`);
    }
    assert.equal(typeof ev.final.status, 'string', `${name}: final.status is not a string`);
    assert.ok(Array.isArray(ev.steps) && Array.isArray(ev.changes) && Array.isArray(ev.uncertainties));
    assert.ok(typeof ev.audit.exact === 'boolean');
    assert.ok(typeof ev.recovery.attempted === 'boolean');
    assert.ok(Array.isArray(ev.recovery.steps));
  }
});

test('C2 — every STEP field the panel reads is present in every state', () => {
  const required = ['id', 'operation', 'capability', 'mechanism', 'tool', 'executed',
    'execution_status', 'verification_status', 'expectedEffects', 'failureReason', 'result', 'verification'];
  for (const [name, ev] of Object.entries(STATES)) {
    for (const s of ev.steps) {
      for (const key of required) {
        assert.ok(key in s, `${name}: step "${s.id}" has no "${key}", which the panel reads`);
      }
    }
  }
});

test('C3 — every CHANGE field the panel reads is present', () => {
  const required = ['table', 'sys_id', 'number', 'changed_fields', 'dropped_fields',
    'transformed_fields', 'verification_status', 'exact'];
  for (const [name, ev] of Object.entries(STATES)) {
    for (const c of ev.changes) {
      for (const key of required) assert.ok(key in c, `${name}: change has no "${key}"`);
    }
  }
});

test('C4 — every RECOVERY ATTEMPT field the panel reads is present', () => {
  const required = ['attempt', 'failure', 'decision', 'reason', 'idempotency', 'outcome', 'result'];
  for (const [name, ev] of Object.entries(STATES)) {
    for (const r of ev.recovery.steps) {
      for (const key of ['step', 'operation', 'finalState', 'attempts', 'recovered', 'retried']) {
        assert.ok(key in r, `${name}: recovery step has no "${key}"`);
      }
      for (const a of r.attempts) {
        for (const key of required) assert.ok(key in a, `${name}: recovery attempt has no "${key}"`);
      }
    }
  }
});

/* ================================================================== *
 * B. EVERY VALUE THE SERVER EMITS IS ONE THE PANEL KNOWS
 * ================================================================== */

test('C5 — the panel recognises every FINAL status the server can produce', () => {
  const known = mapKeys('FINAL_TONE');
  for (const s of Object.values(STATUS)) {
    assert.ok(known.has(s), `the panel has no tone for the status "${s}"`);
  }
  // And each state actually produced falls inside it.
  for (const [name, ev] of Object.entries(STATES)) {
    assert.ok(known.has(ev.final.status), `${name}: the panel has no tone for "${ev.final.status}"`);
  }
});

test('C6 — the panel recognises every STEP state the machine can reach', () => {
  const known = mapKeys('STEP_TONE');
  for (const s of STEP_STATES) {
    assert.ok(known.has(s), `the panel has no tone for the step state "${s}"`);
  }
});

test('C7 — the panel recognises every VERIFICATION status the pipeline can produce', () => {
  const known = mapKeys('VERIFY_TONE');
  for (const s of ['applied', 'partial', 'no-op', 'transformed', 'unverified', 'self-verified', 'none']) {
    assert.ok(known.has(s), `the panel has no tone for the verification status "${s}"`);
  }
  for (const [name, ev] of Object.entries(STATES)) {
    for (const s of ev.steps) {
      assert.ok(known.has(s.verification_status ?? 'none'),
        `${name}: unmapped verification status "${s.verification_status}"`);
    }
  }
});

/* ================================================================== *
 * C. THE RULE: NEVER IMPLY SUCCESS
 * ================================================================== */

test('C8 — the panel has NO success-shaped vocabulary of its own', () => {
  /*
   * The whole point. A tick, a "done", a "success" would be the client's own
   * verdict competing with the server's — and the case that matters is a run
   * that executed and did not verify, where a tick would be a lie.
   */
  const rendered = PANEL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const banned of [/['">\s]success['"<\s]/i, /\bdone\b/i, /✓|✔|✅/, /\ball good\b/i, /\bcompleted successfully\b/i]) {
    assert.ok(!banned.test(rendered), `the panel renders a success-shaped token matching ${banned}`);
  }
  // The words it DOES render are the server's own.
  assert.match(rendered, /ev\.final\?\.status/);
});

test('C9 — an UNVERIFIED run reaches the panel as UNVERIFIED, never as a completed plan', () => {
  const ev = STATES.unverified;
  assert.equal(ev.final.status, STATUS.UNVERIFIED, `got ${ev.final.status}`);
  // The step executed and the plan state says completed — which is exactly the
  // pair a naive UI would collapse into "success".
  assert.equal(ev.steps[0].execution_status, 'completed');
  assert.equal(ev.steps[0].verification_status, 'transformed');
  assert.notEqual(ev.steps[0].execution_status, ev.steps[0].verification_status);
  // The panel labels them separately and says which is which.
  assert.match(PANEL, /exec: \{s\.execution_status\}/);
  assert.match(PANEL, /verify: \{s\.verification_status/);
  assert.match(PANEL, /Whether the call happened and returned/);
  assert.match(PANEL, /Whether the effect was proven/);
});

test('C10 — the header shows the server status and the recovery labels, not a verdict', () => {
  assert.match(PANEL, /\{ev\.final\?\.status \?\? 'unknown'\}/,
    'the panel substitutes its own word when the server has none');
  for (const label of ['RECOVERED', 'UNRECOVERED', 'REPEATED_MUTATION', 'REPLAN_REQUIRED', 'BLOCKED', 'CANCELLED']) {
    assert.ok(PANEL.includes(label), `the panel cannot show ${label}`);
  }
});

test('C11 — each Phase 9 state produces the labels the panel would show', () => {
  // Reproduces the panel's own derivation from the same fields, so a change to
  // either side breaks this rather than silently disagreeing.
  const labels = (ev) => {
    const out = [];
    if (ev.recovery.recoveredSteps > 0) out.push('RECOVERED');
    if (ev.recovery.unrecoveredSteps > 0) out.push('UNRECOVERED');
    if (ev.uncertainties.some((u) => u.kind === 'repeated_mutation')) out.push('REPEATED_MUTATION');
    if (ev.recovery.replanRequired) out.push('REPLAN_REQUIRED');
    if (ev.final.status === 'BLOCKED') out.push('BLOCKED');
    if (ev.final.status === 'CANCELLED') out.push('CANCELLED');
    return out;
  };
  assert.ok(labels(STATES.recovered).includes('RECOVERED'), 'a recovered run shows no RECOVERED label');
  assert.ok(labels(STATES.recovered).includes('REPEATED_MUTATION'),
    'a run that reached the instance twice does not say so');
  assert.ok(labels(STATES.unrecovered).includes('UNRECOVERED'));
  assert.ok(labels(STATES.blocked).includes('BLOCKED'));
  assert.ok(labels(STATES.cancelled).includes('CANCELLED'));
  assert.deepEqual(labels(STATES.completed), [], 'a clean run carries a warning label');
});

test('C12 — a REJECTED approval is not shown as a failure of the system', () => {
  const ev = STATES.rejected;
  assert.equal(ev.changes.length, 0, 'a refusal produced a change');
  assert.equal(ev.recovery.attempted, false, 'a refusal was handed to recovery');
  // The step's failure reason says a person refused, in words a user can read.
  assert.match(ev.steps[0].failureReason ?? '', /rejected/i);
  // And the panel surfaces the reason rather than inventing one.
  assert.match(PANEL, /s\.failureReason/);
});

test('C13 — a cancelled STEP gate does not become a claim that the step ran', () => {
  /*
   * TWO DIFFERENT APPROVALS, and the distinction matters.
   *
   * The PLAN approval is real and was given: a human bound this fingerprint
   * before execution began, and `approval.status: 'approved'` reports that
   * truthfully. The STEP gate is a separate question the user never answered,
   * because the run was cancelled while the card was up.
   *
   * So the honest combination — and the one a reader needs — is: the plan WAS
   * approved, the run was CANCELLED, the step is cancelled, and nothing was
   * written. Asserting `approval.status !== 'approved'` would have been
   * asserting that a real approval be reported as not having happened.
   */
  const ev = STATES.approvalCancelled;
  assert.equal(ev.final.status, STATUS.CANCELLED, `got ${ev.final.status}`);
  assert.equal(ev.changes.length, 0, 'a cancelled gate produced a change');
  assert.equal(ev.steps[0].execution_status, 'cancelled',
    'a step whose gate was cancelled is not reported as cancelled');
  assert.equal(ev.steps[0].executed, false, 'a step that never ran is reported as executed');
  // The step-level approval record must NOT claim the user said yes.
  assert.notEqual(ev.steps[0].approval?.approval, 'approved',
    'the step records an approval nobody gave');
  // And the panel leads with the final status, so CANCELLED is what is read
  // first regardless of the plan-level approval line below it.
  assert.match(PANEL, /\{ev\.final\?\.status \?\? 'unknown'\}/);
});

test('C14 — a stale approval is shown as invalid, with the reason', () => {
  const ev = STATES.blocked;
  assert.equal(ev.approval.valid, false);
  assert.equal(ev.final.status, STATUS.BLOCKED);
  // The panel renders that specific case in words rather than a colour alone.
  assert.match(PANEL, /the plan changed after it was approved/);
});

/* ================================================================== *
 * D. THE WIRING
 * ================================================================== */

test('C15 — AgentChat learns the task id from the stream and reads the authoritative endpoint', () => {
  assert.match(CHAT, /case 'task_started': setTaskId\(evt\.taskId\); break;/,
    'AgentChat no longer captures the task id');
  assert.match(CHAT, /<EvidencePanel taskId=\{taskId\}/, 'the panel is not mounted');
  assert.match(PANEL, /\/agent\/plan\/\$\{encodeURIComponent\(taskId\)\}\/evidence/,
    'the panel does not read the authoritative endpoint');
  // Off by default: evidence is for checking, not a second permanent transcript.
  assert.match(CHAT, /useState\(false\);\s*$/m);
  assert.match(CHAT, /showEvidence \? 'Hide evidence' : 'Evidence'/);
});

test('C16 — a task that does not exist is shown as an error, not an empty panel', () => {
  assert.match(PANEL, /setErr\(/, 'the panel swallows a failed fetch');
  assert.match(PANEL, /\{err && <div className="ev-error">/, 'the panel never renders the error');
  assert.match(PANEL, /setEv\(null\)/, 'a failed fetch leaves stale evidence on screen');
});
