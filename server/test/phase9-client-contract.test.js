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
/*
 * THE PANEL IS NOW THE SOURCES PANEL, in two files: the component and the
 * normaliser that decides what reaches JSX. Both are read, because the rule
 * C8 enforces has to hold across whichever of them prints a word.
 *
 * `mapKeys` is gone with the tone maps it read. Those maps belonged to the
 * status display the Sources redesign removed; what they were really
 * protecting — that the server's status vocabulary is closed, and that every
 * state this suite can drive produces a value inside it — is asserted directly
 * against the server in C5-C7 now, where it does not depend on a UI at all.
 */
const PANEL = fs.readFileSync(path.join(CLIENT, 'components', 'SourcesPanel.jsx'), 'utf8')
  + fs.readFileSync(path.join(CLIENT, 'components', 'sourceModel.js'), 'utf8');
const CHAT = fs.readFileSync(path.join(CLIENT, 'pages', 'AgentChat.jsx'), 'utf8');

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

test('C5 — every FINAL status the server produces is one of its own declared statuses', () => {
  /*
   * WAS: "the panel has a tone for every final status". The tone map went with
   * the status header the Sources redesign removed, so the client half no
   * longer exists to assert. The half that mattered does: a status escaping the
   * declared vocabulary is how a consumer — this UI or the next one — ends up
   * with an unhandled value, and that is caught here without a UI in the loop.
   */
  const declared = new Set(Object.values(STATUS));
  for (const [name, ev] of Object.entries(STATES)) {
    assert.ok(declared.has(ev.final.status),
      `${name}: produced the undeclared final status "${ev.final.status}"`);
  }
  // Every state this suite can drive is covered, so the set is exercised and
  // not merely declared.
  const produced = new Set(Object.values(STATES).map((ev) => ev.final.status));
  assert.ok(produced.size >= 4, `only ${produced.size} distinct final statuses were exercised`);
});

test('C6 — every STEP execution status the machine reaches is a declared step state', () => {
  /*
   * WAS: "the panel has a tone for every step state". Same reasoning as C5 —
   * the per-step exec/verify display is gone; the vocabulary guarantee is not.
   */
  const declared = new Set(STEP_STATES);
  for (const [name, ev] of Object.entries(STATES)) {
    for (const st of ev.steps) {
      assert.ok(declared.has(st.execution_status),
        `${name}: step ${st.id} reported the undeclared execution status "${st.execution_status}"`);
    }
  }
});

test('C7 — every VERIFICATION status the pipeline produces is one the contract declares', () => {
  /*
   * WAS: "the panel has a tone for every verification status". The list below
   * is the contract itself rather than a copy of a UI map, so a new status
   * reaching evidence still fails here — which is the property that mattered.
   */
  const declared = new Set(['applied', 'partial', 'no-op', 'transformed', 'unverified', 'self-verified', 'pending', 'none']);
  for (const [name, ev] of Object.entries(STATES)) {
    for (const st of ev.steps) {
      assert.ok(declared.has(st.verification_status ?? 'none'),
        `${name}: undeclared verification status "${st.verification_status}"`);
    }
  }
});

/* ================================================================== *
 * C. THE RULE: NEVER IMPLY SUCCESS
 * ================================================================== */

test('C8 — the panel has NO success-shaped vocabulary of its own', () => {
  /*
   * The whole point, and it survives the redesign unchanged: a tick, a "done",
   * a "success" would be the client's own verdict competing with the server's.
   * Retargeted at the Sources panel and its normaliser, which are what print
   * words now.
   *
   * The closing assertion changed with the UI. The old panel proved it used the
   * server's vocabulary by rendering `ev.final?.status`; the Sources panel does
   * not show a status at all, so what it must prove instead is that every value
   * it prints came from the response and was not composed here — which is what
   * routing everything through asText()/unwrap() means.
   */
  const rendered = PANEL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const banned of [/['">\s]success['"<\s]/i, /\bdone\b/i, /✓|✔|✅/, /\ball good\b/i, /\bcompleted successfully\b/i]) {
    assert.ok(!banned.test(rendered), `the panel renders a success-shaped token matching ${banned}`);
  }
  assert.match(rendered, /asText\(/, 'the panel prints values without passing them through asText');
  assert.match(rendered, /function unwrap\(/, 'the {value, source} unwrapper is gone');
});

test('C9 — an UNVERIFIED run reaches the panel as UNVERIFIED, never as a completed plan', () => {
  const ev = STATES.unverified;
  assert.equal(ev.final.status, STATUS.UNVERIFIED, `got ${ev.final.status}`);
  // The step executed and the plan state says completed — which is exactly the
  // pair a naive UI would collapse into "success".
  assert.equal(ev.steps[0].execution_status, 'completed');
  assert.equal(ev.steps[0].verification_status, 'transformed');
  assert.notEqual(ev.steps[0].execution_status, ev.steps[0].verification_status);
  /*
   * The four assertions that followed checked the panel's own exec:/verify:
   * labelling. That display was removed with the redesign — the Sources panel
   * reports what a turn READ, not what it did — so there is no longer a client
   * side to this. The server-side guarantee above is the one that stops an
   * unverified run being recorded as a completed one, and it is untouched.
   */
});

/*
 * C10 REMOVED — it had no server half.
 *
 * It asserted that the evidence header printed `ev.final?.status` and could
 * show each recovery label. Both belonged to the status header the Sources
 * redesign removed, so there is nothing left for it to check: keeping it would
 * mean asserting that a deleted component still renders.
 *
 * What it was really protecting is not lost. C11 below derives the same six
 * labels from the same fields on real evidence objects, server-side, and fails
 * if the derivation or the fields change — which is the half that could ever
 * have caught a genuine regression.
 */

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
  /*
   * The panel-side assertion (that it rendered `s.failureReason` rather than
   * inventing a reason) went with the per-step display. The server-side facts
   * above — no change, no recovery, and a reason naming the refusal — are what
   * make the distinction available to any UI.
   */
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
  /*
   * The panel-side assertion (that the header led with the final status) went
   * with that header. Every server-side fact above is unchanged, including the
   * one that matters most: the step records no approval nobody gave.
   */
});

test('C14 — a stale approval is shown as invalid, with the reason', () => {
  const ev = STATES.blocked;
  assert.equal(ev.approval.valid, false);
  assert.equal(ev.final.status, STATUS.BLOCKED);
  /*
   * The panel-side assertion checked that the stale-approval case was spelled
   * out in words rather than shown as a colour. That sentence lived in the
   * approval block the redesign removed. The server still reports
   * `approval.valid: false` with a reason, which is what any UI needs to say it.
   */
});

/* ================================================================== *
 * D. THE WIRING
 * ================================================================== */

test('C15 — AgentChat learns the task id from the stream and reads the authoritative endpoint', () => {
  assert.match(CHAT, /case 'task_started': setTaskId\(evt\.taskId\); break;/,
    'AgentChat no longer captures the task id');
  // The panel became a drawer; it is still mounted from AgentChat with the id.
  assert.match(CHAT, /<SourcesDrawer[\s\S]{0,120}taskId=\{taskId\}/, 'the sources drawer is not mounted');
  assert.match(PANEL, /\/agent\/plan\/\$\{encodeURIComponent\(taskId\)\}\/evidence/,
    'the panel does not read the authoritative endpoint');
  // Off by default: sources are for checking, not a second permanent transcript.
  assert.match(CHAT, /useState\(false\);\s*$/m);
  /*
   * The final assertion checked a 'Hide evidence' toggle label. That control
   * was replaced by the composer chip BEFORE this redesign — this assertion was
   * already failing at HEAD, which is why this file was 16/1 rather than 17/0 —
   * so it is replaced with one against the control that actually exists.
   */
  assert.match(CHAT, /sourcesOpen=\{showEvidence\}/, 'the composer is not told whether sources are open');
});

test('C16 — a task that does not exist is shown as an error, not an empty panel', () => {
  assert.match(PANEL, /setErr\(/, 'the panel swallows a failed fetch');
  // Same guarantee, the redesign's class name.
  assert.match(PANEL, /\{err && <div className="src-error">/, 'the panel never renders the error');
  assert.match(PANEL, /setEv\(null\)/, 'a failed fetch leaves stale evidence on screen');
});

/* ==================================================================
 * E. THE SOURCES CONTRACT
 *
 * Added with the Sources redesign. The panel's three headings are built from
 * the evidence projection, and the one that can lie is Online Docs: a search
 * that RAN is not a document that was READ. The corpus can be empty — the
 * search tool answers `indexed: 0, hits: []` and says so itself — and a reader
 * shown "ServiceNow docs" for that would be told a document informed the answer
 * when none did. Same family of failure as C8, one level up.
 * ================================================================== */

/** A tool event on a task, written the way the orchestrator writes one. */
function docSearchTask(name, result) {
  const { taskId, sessionId } = newTask(`sources-${name}`);
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO tool_events
       (session, seq, kind, name, payload, result, result_status, mutating, approval,
        approved_source, approved_at, instance, actor, ts, task_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(sessionId, 0, 'tool_call', name, JSON.stringify({ query: 'q' }),
    JSON.stringify(result), 'ok', 0, null, null, null, null, null, now, taskId);
  return buildEvidence(taskId);
}

const HIT = {
  chunk: 1, document: 'd1', seq: 0, text: 'chunk body',
  source: 'servicenow-docs', product: 'Now Platform', topic: 'acl',
  version: 'Washington DC', version_rank: 3, document_type: 'documentation',
  url: 'https://www.servicenow.com/docs/bundle/x/page/y.html',
  updated_at: '2026-02-11', title: 'Create an ACL rule', score: 8.2,
};

test('C17 — a documentation search that found NOTHING carries no retrieval', () => {
  const ev = docSearchTask('search_servicenow_docs', {
    query: 'q', indexed: 0, mode: 'none', hits: [],
    note: 'No ServiceNow documentation is indexed.',
  });
  const e = ev.audit.toolEvents.find((x) => x.name === 'search_servicenow_docs');
  assert.ok(e, 'the search is missing from the audit');
  assert.equal(e.retrieval, undefined,
    'an empty corpus produced a retrieval block, which the panel would show as a source');
});

test('C18 — a documentation search that found documents carries them, verbatim', () => {
  const ev = docSearchTask('search_servicenow_docs', {
    query: 'write ACL incident', indexed: 2, mode: 'keyword', degraded: false, hits: [HIT],
  });
  const e = ev.audit.toolEvents.find((x) => x.name === 'search_servicenow_docs');
  assert.ok(e.retrieval, 'a search with hits carries no retrieval block');
  assert.equal(e.retrieval.hitCount, 1);
  const [h] = e.retrieval.hits;
  // Copied from the store's hit, never composed from the query or the host.
  assert.equal(h.title, HIT.title);
  assert.equal(h.url, HIT.url);
  assert.equal(h.source, HIT.source);
  assert.equal(h.version, HIT.version);
  assert.equal(h.documentType, HIT.document_type);
  assert.equal(h.updatedAt, HIT.updated_at);
  assert.equal(h.snippet, HIT.text);
});

test('C19 — the automatic RAG path is projected by the same parser as the tool', () => {
  /*
   * retrieveForTurn() used to be streamed and never stored, so a reopened chat
   * could not show what it had read. It now records a `knowledge_retrieval`
   * event in the store's own result shape — which means one parser, and no
   * second definition of what counts as a retrieved document.
   */
  const ev = docSearchTask('knowledge_retrieval', {
    query: 'q', indexed: 1, mode: 'semantic', degraded: false, hits: [HIT],
  });
  const e = ev.audit.toolEvents.find((x) => x.name === 'knowledge_retrieval');
  assert.ok(e.retrieval, 'the automatic retrieval is not projected');
  assert.equal(e.retrieval.hits[0].url, HIT.url);
});

test('C20 — the panel builds Online Docs from retrieved documents, not from tool names', () => {
  /*
   * The defect this closes: keying the category off the tool NAME meant a
   * search against an empty corpus produced a "ServiceNow docs" source. The
   * normaliser must read hits and nothing else.
   */
  assert.match(PANEL, /e\.retrieval\?\.hits/,
    'the normaliser no longer reads the retrieval hits');
  assert.doesNotMatch(PANEL, /DOC_TOOLS/,
    'the tool-name mapping for Online Docs is back');
  assert.doesNotMatch(PANEL, /search_servicenow_docs/,
    'the panel names a documentation tool, which is a search and not a document');
});

test('C21 — a turn that retrieved nothing yields no Online Docs source at all', () => {
  const ev = docSearchTask('search_servicenow_docs', { query: 'q', indexed: 0, mode: 'none', hits: [] });
  // What the normaliser iterates, reproduced from the same fields.
  const docs = ev.audit.toolEvents.flatMap((e) => (Array.isArray(e.retrieval?.hits) ? e.retrieval.hits : []));
  assert.deepEqual(docs, [], 'an empty retrieval reached the Online Docs list');
});
