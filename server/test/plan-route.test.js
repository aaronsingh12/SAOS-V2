/**
 * PHASE 4 — THE PLAN ROUTE, end to end over a real socket.
 *
 *   node --test server/test/
 *
 * `plan.test.js` asserts the pieces. This asserts the WIRING: that the pipeline
 * is reachable, that its SSE stream terminates exactly once, that a plan card
 * is answered at the same `POST /api/agent/approve` endpoint every other
 * approval uses, and that a client which lost the stream can rebuild the plan
 * from the database alone.
 *
 * The real routers are mounted exactly as `src/index.js` mounts them, so this
 * exercises the wiring rather than a replica of it.
 *
 * Offline: no instance is reachable, so most capabilities discover as
 * unavailable — which is itself the point of several of these tests. A plan
 * that cannot be produced is refused with its reason, never planned
 * optimistically and left to fail at execution.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-planroute-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const P = await import('../src/agent/plan/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { getDb } = await import('../src/memory/db.js');
const { createSession } = await import('../src/memory/sessions.js');

let n = 0;
const newSession = () => `route-${++n}`;

function newTask(goal) {
  const sid = newSession();
  createSession({ id: sid });
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const stepOf = (over = {}) => ({
  id: over.id ?? 'step_1',
  operation: over.operation ?? 'update the incident',
  capability: over.capability ?? 'record_update',
  tool: over.tool ?? null,
  mechanism: null,
  scope: null,
  mutating: over.mutating ?? true,
  target: { table: 'incident', sys_id: 'a'.repeat(32) },
  inputs: { table: 'incident', sys_id: 'a'.repeat(32), data: { short_description: 'x' } },
  depends_on: over.depends_on ?? [],
  expected_effects: over.expected_effects ?? ['short_description is updated'],
  verification: 'verification' in over ? over.verification : { strategy: 'read_back', asserts: ['ok'] },
});

let server = null;
let base = null;

test.before(async () => {
  const express = (await import('express')).default;
  const { planRouter } = await import('../src/routes/plan.js');
  const { agentRouter } = await import('../src/routes/agent.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/agent', agentRouter);
  app.use('/api/agent/plan', planRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/agent`;
});

test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

/** POST a plan request and read its SSE frames to the end. */
async function planRequest(sessionId, message, { onFrame = () => {}, signal = null } = {}) {
  const frames = [];
  const res = await fetch(`${base}/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
    signal,
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const evt = JSON.parse(line.slice(6));
        frames.push(evt);
        await onFrame(evt);
      }
    }
  }
  return frames;
}

const TERMINAL = new Set(['plan_completed', 'plan_failed', 'plan_cancelled']);
const terminalsOf = (frames) => frames.filter((f) => TERMINAL.has(f.type));

/* ------------------------------------------------------------------ */

test('ROUTE - a plan request cannot reuse a chat from another instance', async () => {
  const sessionId = `route-cross-instance-${++n}`;
  _setSettingsForTests({
    connection: { instanceUrl: 'https://alpha.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  });
  createSession({ id: sessionId });

  _setSettingsForTests({
    connection: { instanceUrl: 'https://beta.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  });
  try {
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM agent_tasks WHERE session_id = ?').get(sessionId).n;
    const res = await fetch(`${base}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message: 'create a record from the old chat context' }),
    });
    assert.equal(res.status, 409);
    assert.match((await res.json()).message, /another instance/i);
    const after = getDb().prepare('SELECT COUNT(*) AS n FROM agent_tasks WHERE session_id = ?').get(sessionId).n;
    assert.equal(after, before, 'a stale-instance request opened a task before refusing');
  } finally {
    _setSettingsForTests({
      connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'admin', password: 'x' },
      llm: { provider: 'ollama', model: '', baseUrl: '' },
      agent: { autoApprove: false, holdMutationsOnQuestion: true },
    });
  }
});

test('ROUTE — the stream terminates exactly once, and nothing executes without a plan', async () => {
  const frames = await planRequest(newSession(), 'create a flow that notifies the manager on a P1 incident');
  const terminals = terminalsOf(frames);
  assert.equal(terminals.length, 1,
    `expected one terminal frame, got: ${terminals.map((t) => t.type).join(', ') || 'none'}`);
  assert.ok(frames.some((f) => f.type === 'plan_started'), 'the stream never announced itself');
  // Whatever the outcome, no step ran: a plan comes before any mutation.
  assert.equal(frames.filter((f) => f.type === 'step_started').length, 0);
});

test('ROUTE — a plan that cannot be produced is REFUSED with its reason, never planned optimistically', async () => {
  /*
   * No instance is reachable here, so the SDK-backed capabilities discover as
   * unavailable. The honest outcome is a refusal that names why — not a plan
   * that looks fine and fails at the first step.
   */
  const frames = await planRequest(newSession(), 'create a flow and an SLA and an ACL');
  const terminal = terminalsOf(frames)[0];
  assert.equal(terminal.type, 'plan_failed');
  assert.ok(terminal.reason, 'the refusal carried no reason');
  assert.ok(['no_capabilities', 'planner_failed', 'unparseable', 'invalid', 'error'].includes(terminal.reason),
    `unexpected refusal reason ${terminal.reason}`);
  // A durable record exists either way — the refusal is auditable.
  const tasks = getDb().prepare("SELECT * FROM agent_tasks WHERE goal LIKE '%an SLA and an ACL%'").all();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].plan_state, 'failed');
  assert.ok(tasks[0].failure_reason, 'the task did not record why it failed');
});

test('ROUTE — the reconnect path rebuilds the plan from the database alone', async () => {
  /*
   * SSE is transport; the plan is state. A client that lost the stream must be
   * able to redraw exactly what it was showing, which is only possible because
   * the process that made the plan holds nothing the database does not.
   */
  const { taskId } = newTask('reconnect me');
  const saved = P.savePlan(taskId, {
    goal: 'reconnect me',
    steps: [
      stepOf({ id: 'step_1', operation: 'read the schema', capability: 'record_read', tool: 'get_table_schema', mutating: false, verification: null, expected_effects: [] }),
      stepOf({ id: 'step_2', depends_on: ['step_1'] }),
    ],
  });
  P.setPlanState(taskId, 'ready');
  P.setStepState(taskId, 'step_1', 'ready');
  P.setStepState(taskId, 'step_1', 'executing');

  const body = await fetch(`${base}/plan/${taskId}`).then((r) => r.json());
  assert.equal(body.taskId, taskId);
  assert.equal(body.goal, 'reconnect me');
  assert.equal(body.fingerprint, saved.fingerprint);
  assert.equal(body.planState, 'ready');
  assert.equal(body.steps.length, 2);
  assert.ok(body.review, 'the reviewed plan could not be rebuilt after a reconnect');
  assert.equal(body.review.stepCount, 2);
  assert.equal(body.progress.total, 2);
  assert.equal(body.progress.current, 'step_1', 'the in-flight step was not identifiable');
  assert.deepEqual(body.steps[1].depends_on, ['step_1']);

  assert.equal((await fetch(`${base}/plan/does-not-exist`)).status, 404);
});

test('ROUTE — /validate judges a plan without creating or executing anything', async () => {
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM agent_tasks').get().n;
  const bad = await fetch(`${base}/plan/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: { goal: 'x', steps: [{ id: 'a', operation: 'do it', capability: 'made_up_capability' }] } }),
  }).then((r) => r.json());

  assert.equal(bad.valid, false);
  assert.ok(bad.fatal.some((p) => p.code === 'unknown_capability'),
    'an invented capability was not refused');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_tasks').get().n, before,
    'validating a plan created a task');
});

test('ROUTE — a plan card is answered at the EXISTING approve endpoint, and carries its binding', async () => {
  /*
   * Not a second approval system. The plan-level card carries the same
   * approvalId and 32-byte nonce every other card does, and it is resolved at
   * POST /api/agent/approve — same route, same resolver, same constant-time
   * nonce check. It additionally carries the fingerprint, so a client can prove
   * which plan it approved.
   */
  const sid = newSession();
  let card = null;
  const frames = await planRequest(sid, 'update the short description on the incident', {
    onFrame: async (e) => {
      if (e.type !== 'approval_required' || card) return;
      card = e;
      const r = await fetch(`${base}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, approvalId: e.approvalId, approved: false, nonce: e.nonce }),
      }).then((x) => x.json());
      assert.equal(r.ok, true, `the shared approve endpoint refused a plan card: ${r.reason}`);
    },
  });

  assert.equal(terminalsOf(frames).length, 1);
  if (card) {
    assert.ok(card.nonce && card.nonce.length > 20, 'the plan card carried no usable nonce');
    assert.ok(card.plan?.fingerprint, 'the plan card carried no fingerprint to bind to');
    const terminal = terminalsOf(frames)[0];
    assert.equal(terminal.type, 'plan_failed');
    assert.equal(terminal.reason, 'rejected');
    assert.match(terminal.note, /will not be retried/);
  }
});

test('ROUTE — the chat route is untouched and still runs the ordinary turn loop', async () => {
  /*
   * Phase 4 is ADDITIVE. Replacing the chat path would have meant redesigning
   * the agent, which this phase is explicitly not for — so the old entry point
   * must still behave exactly as it did.
   */
  const { _setChatTurnForTests } = await import('../src/agent/providers/index.js');
  _setChatTurnForTests(async () => ({ text: 'A plain answer.', toolCalls: [], stopReason: 'stop' }));
  try {
    const sid = newSession();
    const res = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, message: 'who is INC0010052 assigned to?' }),
    });
    const text = await res.text();
    assert.match(text, /"type":"done"/, 'the chat route stopped emitting its own terminal frame');
    assert.doesNotMatch(text, /plan_started/, 'the chat route started planning');
  } finally { _setChatTurnForTests(null); }
});

test('ROUTE — bad input is refused before anything is created', async () => {
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM agent_tasks').get().n;
  for (const body of [{}, { sessionId: 'x' }, { message: 'y' }]) {
    const r = await fetch(`${base}/plan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(r.status, 400);
  }
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_tasks').get().n, before);
});
