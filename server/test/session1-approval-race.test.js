/**
 * SESSION 1 / WI-2 — THE APPROVAL RACE.
 *
 *   node --test server/test/
 *
 * THE DEFECT, measured 2026-09-08. The gate emitted `approval_required` and
 * only THEN registered the pending entry inside `awaitApproval`. A caller that
 * answered the card synchronously from inside the emit callback — which is
 * exactly what `scripts/experience-model-eval.mjs` and the Session 0 profile
 * harness do — found no pending entry, got `no-such-approval` back, and the
 * turn sat for the full five-minute `APPROVAL_TIMEOUT_MS` before continuing
 * with `source: 'timeout'`. Two cards, two exact five-minute gaps, and the
 * evaluation's "rejected" counter counted timeouts.
 *
 * Nothing about the UI contract changes: the frame is the same, the nonce is
 * the same, `POST /api/agent/approve` is still the only caller of
 * `resolveApproval` in `src/`. What changes is the ORDER — the pending entry
 * exists before the card is visible, on all three gates: the chat loop, the
 * elevation gate, and the plan executor.
 *
 * Both tests answer the card from inside the emit callback, synchronously,
 * and fail fast: a turn that is still waiting after three seconds is the
 * defect, and the abort in the failure path is what stops the five-minute
 * timer from holding the test process open.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-s1race-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { _setChatTurnForTests } = await import('../src/agent/providers/index.js');
const { runTurn, resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { createSession } = await import('../src/memory/sessions.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const { getDb } = await import('../src/memory/db.js');
const P = await import('../src/agent/plan/index.js');

/** Fail fast instead of waiting out the gate's five-minute timer. */
async function within(ms, promise, onTimeout) {
  let timer;
  const bomb = new Promise((_, reject) => {
    timer = setTimeout(() => { onTimeout?.(); reject(new Error(`still waiting after ${ms}ms — the gate never saw the answer`)); }, ms);
  });
  try { return await Promise.race([promise, bomb]); } finally { clearTimeout(timer); }
}

const localTool = (name, spec) => { toolMap.set(name, { name, ...spec }); return () => toolMap.delete(name); };

/* ------------------------------------------------------------------ *
 * The chat loop
 * ------------------------------------------------------------------ */

test('chat loop: an answer given inside the emit callback resolves the gate at once', async () => {
  const sessionId = 's1race-chat';
  createSession({ id: sessionId });
  let n = 0;
  _setChatTurnForTests(async () => (n++ === 0
    ? { text: '', toolCalls: [{ id: 'c1', name: 'create_record', input: { table: 'incident', data: { short_description: 'race probe' } } }], stopReason: 'tool_calls' }
    : { text: 'Nothing was changed.', toolCalls: [], stopReason: 'stop' }));

  const ctl = new AbortController();
  const frames = [];
  let answer = null;
  const emit = (evt) => {
    frames.push(evt);
    if (evt.type === 'approval_required') {
      // Synchronous, inside the callback — the shape the eval scripts use.
      answer = resolveApproval(sessionId, evt.approvalId, false, APPROVAL_SOURCES.USER_CLICK, evt.nonce);
    }
  };

  const started = Date.now();
  await within(3000, runTurn(sessionId, 'create an incident', emit, { signal: ctl.signal }), () => ctl.abort());
  const elapsed = Date.now() - started;

  assert.ok(answer, 'the card was never emitted');
  assert.equal(answer.ok, true, `resolveApproval answered ${JSON.stringify(answer)} — the pending entry did not exist yet`);
  const resolved = frames.find((f) => f.type === 'approval_resolved');
  assert.ok(resolved, 'no approval_resolved frame');
  assert.equal(resolved.source, 'user_click', `the decision was attributed to ${resolved.source}, not the click`);
  assert.equal(resolved.approved, false);
  assert.ok(elapsed < 3000, `took ${elapsed}ms`);
});

/* ------------------------------------------------------------------ *
 * The plan executor
 * ------------------------------------------------------------------ */

test('plan executor: an answer given inside the emit callback resolves the gate at once', async () => {
  const sessionId = 's1race-plan';
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sessionId, new Date().toISOString(), new Date().toISOString());
  const task = createTask({ sessionId, goal: 'race' });
  startTask(task.id);

  let ran = 0;
  const drop = localTool('s1_race_probe', {
    mutating: true,
    describeWrite: (i) => ({ operation: 'insert', table: 'incident', requested: i.data ?? {} }),
    execute: async () => { ran += 1; return { sys_id: 'b'.repeat(32) }; },
  });
  try {
    const saved = P.savePlan(task.id, {
      goal: 'race',
      steps: [{
        id: 'step_1', operation: 'insert a probe', capability: 'record_create', tool: 's1_race_probe',
        mechanism: null, scope: null, mutating: true, target: { table: 'incident' },
        inputs: { table: 'incident', data: { short_description: 'race' } }, depends_on: [],
        expected_effects: ['a record exists'], verification: { strategy: 'read_back', asserts: ['ok'] },
      }],
    });
    P.setPlanState(task.id, 'ready');
    P.setPlanState(task.id, 'awaiting_approval');
    P.approvePlan(task.id, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });

    const ctl = new AbortController();
    const frames = [];
    let answer = null;
    const started = Date.now();
    const res = await within(3000, P.executePlan({
      taskId: task.id, sessionId, turnSeq: 1, signal: ctl.signal,
      emit: (e) => {
        frames.push(e);
        if (e.type === 'approval_required') {
          answer = resolveApproval(sessionId, e.approvalId, false, APPROVAL_SOURCES.USER_CLICK, e.nonce);
        }
      },
    }), () => ctl.abort());
    const elapsed = Date.now() - started;

    assert.ok(answer, 'the card was never emitted');
    assert.equal(answer.ok, true, `resolveApproval answered ${JSON.stringify(answer)} — the pending entry did not exist yet`);
    assert.equal(ran, 0, 'a rejected step executed');
    assert.equal(res.ok, false);
    const resolved = frames.find((f) => f.type === 'approval_resolved');
    assert.equal(resolved?.source, 'user_click', `attributed to ${resolved?.source}`);
    assert.ok(elapsed < 3000, `took ${elapsed}ms`);
  } finally { drop(); }
});

/* ------------------------------------------------------------------ *
 * The shape of the fix, so it cannot regress by a reorder
 * ------------------------------------------------------------------ */

test('every gate registers the pending entry BEFORE it emits the card', () => {
  const read = (rel) => fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const orch = strip(read('agent/orchestrator.js'));
  const exec = strip(read('agent/plan/executor.js'));
  // In the orchestrator the promise is created (and the entry registered) on a
  // line that precedes the `approval_required` emit at BOTH gates.
  const sites = [...orch.matchAll(/type: 'approval_required'/g)].map((m) => m.index);
  assert.equal(sites.length, 2, 'the orchestrator has two approval cards');
  for (const at of sites) {
    const before = orch.slice(Math.max(0, at - 900), at);
    assert.match(before, /const decisionPending = awaitApproval\(/,
      'the pending entry must be registered before the card is emitted');
  }
  const at = exec.indexOf("type: 'approval_required'");
  assert.ok(at > 0);
  assert.match(exec.slice(Math.max(0, at - 600), at), /const decisionPending = awaitApprovalDecision\(/,
    'the plan executor must register before it emits');
});
