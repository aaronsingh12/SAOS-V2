/**
 * PHASE 1 — the durable task/step substrate.
 *
 *   node --test server/test/
 *
 * The claim this phase makes is narrow and easy to get wrong in both
 * directions: every agent turn gets a persistent task and one step, and
 * NOTHING ELSE CHANGES. So these tests assert two different kinds of thing.
 *
 * The lifecycle tests drive the REAL Express route over a real socket, with a
 * scripted provider and a scratch database. Not `beginTurn` composed with
 * `runTurn` the way the route composes them — that would test a replica of the
 * wiring and pass even if the route had been wired differently. The route is
 * the integration point, so the route is what runs.
 *
 * The architectural tests assert the shape of the dependency graph, because
 * "task persistence sits ABOVE the execution layer" is a property of what
 * imports what, and a property nobody can see is a property that erodes.
 *
 * Offline in full: scripted provider, scratch SQLite, loopback HTTP. No
 * instance, no model, no outbound network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-tasks-'));
const DB_FILE = path.join(scratchDir, 'test.db');
_setDbForTests(migrate(new DatabaseSync(DB_FILE)));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'test' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { _setChatTurnForTests } = await import('../src/agent/providers/index.js');
const { agentRouter } = await import('../src/routes/agent.js');
const { toolMap, TOOLS } = await import('../src/agent/tools.js');
const { getDb } = await import('../src/memory/db.js');
const {
  TASK_STATES, STEP_STATES, STEP_KINDS, TERMINAL_STATES, canTransition,
  createTask, createStep, startTask, startStep, completeTask, failTask, cancelTask,
  getTask, getStep, stepsForTask, tasksForSession, unfinishedTasks,
} = await import('../src/memory/tasks.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * Harness — the real route, over a real socket
 * ------------------------------------------------------------------ */

/** A provider that says exactly what it is told to, once each. */
function scriptProvider(...responses) {
  const seen = [];
  _setChatTurnForTests(async (req) => {
    seen.push(req);
    const next = responses[seen.length - 1];
    if (!next) throw new Error(`the loop asked for completion ${seen.length}; the script only has ${responses.length}`);
    const body = typeof next === 'function' ? await next(req) : next;
    if (body instanceof Error) throw body;
    return { text: '', toolCalls: [], stopReason: 'stop', ...body };
  });
  return seen;
}

const call = (name, input = {}, id = `c-${name}`) => ({ id, name, input });

let n = 0;
const newSession = () => `task-${++n}`;

let server = null;
let base = null;

test.before(async () => {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // The REAL router, mounted exactly as src/index.js mounts it.
  app.use('/api/agent', agentRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/agent`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

/**
 * POST a turn and read its SSE frames to the end.
 *
 * `onFrame` fires as each frame arrives, which is how a test observes state
 * MID-TURN — the task is already projected by the time a frame reaches the
 * wire, because the route projects before it writes.
 */
async function turn(sessionId, message, { retry = false, onFrame = () => {}, signal = null } = {}) {
  const frames = [];
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message, retry }),
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
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
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

/** The one task a turn produced, with its steps. Asserts the cardinality. */
function taskOf(sessionId) {
  const tasks = tasksForSession(sessionId);
  assert.equal(tasks.length, 1, `expected exactly 1 task for ${sessionId}, got ${tasks.length}`);
  const steps = stepsForTask(tasks[0].id);
  assert.equal(steps.length, 1, `expected exactly 1 step on ${sessionId}'s task, got ${steps.length}`);
  return { task: tasks[0], step: steps[0], steps };
}

/* ------------------------------------------------------------------ *
 * T1/T2/T3 — a task, one step, correctly related
 * ------------------------------------------------------------------ */

test('T1/T2/T3 — a normal turn creates exactly one task with exactly one step', async () => {
  scriptProvider({ text: 'It is assigned to Beth Anglin.' });
  const sid = newSession();
  await turn(sid, 'who is INC0010052 assigned to?');

  const { task, step } = taskOf(sid);

  // T1 — the task exists, belongs to this session, and remembers the ask.
  assert.equal(task.session_id, sid);
  assert.equal(task.goal, 'who is INC0010052 assigned to?', 'the task did not record the user\'s own words');
  assert.ok(task.id && task.id.length >= 32, 'the task id is not an application-generated UUID');
  assert.ok(task.created_at && task.started_at, 'creation and start are separate recorded facts');

  // T2 — exactly one step, and it is a turn.
  assert.equal(step.kind, 'turn');
  assert.equal(step.sequence, 1, 'the first step is not sequence 1');

  // T3 — the step points at THIS task, not at some other one.
  assert.equal(step.task_id, task.id);
  assert.notEqual(step.id, task.id, 'the step reused the task id');
});

/* ------------------------------------------------------------------ *
 * T4 — iterations do not multiply tasks
 * ------------------------------------------------------------------ */

test('T4 — three provider iterations still produce exactly 1 task and 1 step', async () => {
  toolMap.set('task_probe_read', { name: 'task_probe_read', mutating: false, execute: async () => ({ rows: [] }) });
  try {
    const seen = scriptProvider(
      { text: 'Looking.', toolCalls: [call('task_probe_read', {}, 'a')] },
      { text: 'Looking again.', toolCalls: [call('task_probe_read', {}, 'b')] },
      { text: 'There are none.' },
    );
    const sid = newSession();
    await turn(sid, 'check twice please');

    assert.equal(seen.length, 3, 'the loop did not actually iterate three times');
    const { task, step } = taskOf(sid);
    assert.equal(task.state, 'completed');
    assert.equal(step.state, 'completed');
  } finally { toolMap.delete('task_probe_read'); }
});

/* ------------------------------------------------------------------ *
 * T5 — provider retries do not multiply tasks
 * ------------------------------------------------------------------ */

test('T5 — a provider that retries internally still produces exactly 1 task and 1 step', async () => {
  /*
   * The REAL `withRetry`, exercised at the layer that actually owns retries.
   *
   * The scripted seam sits at `chatTurn`, above the adapters, so a plain
   * scripted throw would bypass retry entirely and prove nothing. Instead the
   * script runs the genuine retry module around a function that fails twice —
   * which is exactly the shape `openaiCompat.chat` has — and the assertion is
   * that three attempts inside one completion are still one task.
   */
  const { withRetry, retryable } = await import('../src/agent/providers/retry.js');
  let attempts = 0;
  _setChatTurnForTests(async () => withRetry('scripted provider', async () => {
    attempts += 1;
    if (attempts < 3) throw retryable(new Error('upstream wobbled'), 503);
    return { text: 'Answered on the third attempt.', toolCalls: [], stopReason: 'stop' };
  }, { attempts: 3 }));

  const sid = newSession();
  await turn(sid, 'ask something the upstream is flaky about');

  assert.equal(attempts, 3, 'the provider did not actually retry');
  const { task, step } = taskOf(sid);
  assert.equal(task.state, 'completed');
  assert.equal(step.state, 'completed');
});

test('T5b — retries live BELOW the task boundary, structurally', () => {
  // The behavioural test above proves it for one shape. This proves it for
  // every shape: nothing in the provider layer can reach the task layer, so no
  // retry anywhere in it can mint a task.
  for (const file of fs.readdirSync(path.join(SRC, 'agent', 'providers'))) {
    if (!file.endsWith('.js')) continue;
    const src = read(`agent/providers/${file}`);
    assert.doesNotMatch(src, /memory\/tasks\.js|task-tracker\.js/,
      `providers/${file} reaches the task layer — a provider retry could then mint a task`);
  }
});

/* ------------------------------------------------------------------ *
 * T6 — tool calls do not multiply tasks
 * ------------------------------------------------------------------ */

test('T6 — four tool calls across two iterations remain 1 task and 1 step', async () => {
  let ran = 0;
  toolMap.set('task_probe_multi', {
    name: 'task_probe_multi', mutating: false,
    execute: async () => { ran += 1; return { ok: true }; },
  });
  try {
    scriptProvider(
      { text: 'Three at once.', toolCalls: [call('task_probe_multi', {}, '1'), call('task_probe_multi', {}, '2'), call('task_probe_multi', {}, '3')] },
      { text: 'One more.', toolCalls: [call('task_probe_multi', {}, '4')] },
      { text: 'Done.' },
    );
    const sid = newSession();
    await turn(sid, 'run several tools');

    assert.equal(ran, 4, 'the tools did not all run');
    const { task, step } = taskOf(sid);
    assert.equal(task.state, 'completed');
    assert.equal(step.state, 'completed');
  } finally { toolMap.delete('task_probe_multi'); }
});

/* ------------------------------------------------------------------ *
 * T7 — the successful lifecycle
 * ------------------------------------------------------------------ */

test('T7 — a successful turn moves running -> completed, on both rows', async () => {
  /*
   * The mid-turn sample is taken from INSIDE a tool, on the server, while the
   * turn is genuinely in flight.
   *
   * Reading it from the client's frame handler does not work and the reason is
   * worth writing down: with a scripted provider the whole turn completes in
   * microseconds and the response is buffered, so by the time the client parses
   * the first frame the task is already `completed`. That would make the test
   * pass or fail on scheduling rather than on behaviour. A tool's `execute`
   * runs at a point where the turn provably has not finished.
   */
  let midTurn = null;
  let sid = null;
  toolMap.set('task_probe_sample', {
    name: 'task_probe_sample', mutating: false,
    execute: async () => { midTurn = taskOf(sid); return { ok: true }; },
  });
  try {
    scriptProvider(
      { text: 'Checking.', toolCalls: [call('task_probe_sample')] },
      { text: 'Finished.' },
    );
    sid = newSession();
    await turn(sid, 'say something');

    assert.ok(midTurn, 'the sampling tool never ran');
    // Created and started BEFORE the model does meaningful work — not lazily
    // after the first tool call, which is when this sample is taken.
    assert.equal(midTurn.task.state, 'running', 'the task was not running while the turn ran');
    assert.equal(midTurn.step.state, 'running', 'the step was not running while the turn ran');
    assert.ok(midTurn.task.started_at, 'the task was running with no start timestamp');
    assert.equal(midTurn.task.completed_at, null, 'the task was completed before the turn ended');
  } finally { toolMap.delete('task_probe_sample'); }

  const { task, step } = taskOf(sid);
  assert.equal(task.state, 'completed');
  assert.equal(step.state, 'completed');
  assert.ok(task.completed_at, 'the task has no completion timestamp');
  assert.ok(step.completed_at, 'the step has no completion timestamp');
  assert.equal(task.failure_reason, null);
  assert.equal(task.cancelled_at, null);
});

/* ------------------------------------------------------------------ *
 * T8 — the cancellation lifecycle (Phase 0 machinery, unchanged)
 * ------------------------------------------------------------------ */

test('T8 — a cancelled turn projects to cancelled, and Phase 0 invariants hold', async () => {
  /*
   * The real Phase 0 path end to end: the client aborts its fetch, the route
   * sees the disconnect, the request-local controller aborts, `runTurn` stops
   * at its next safe boundary and emits `cancelled`, and the task observes it.
   *
   * No second cancellation mechanism, no `/cancel` endpoint, no registry — the
   * task layer only watches.
   */
  toolMap.set('task_probe_slow', {
    name: 'task_probe_slow', mutating: false,
    execute: async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); return { ok: true }; },
  });
  try {
    scriptProvider(
      { text: 'Working on it.', toolCalls: [call('task_probe_slow')] },
      { text: 'unreachable — the turn should have stopped' },
    );
    const sid = newSession();
    const ac = new AbortController();

    await assert.rejects(
      () => turn(sid, 'start something then stop it', {
        signal: ac.signal,
        // Abort the moment the model has spoken — before the tool loop.
        onFrame: (e) => { if (e.type === 'assistant_text') ac.abort(); },
      }),
      (err) => err.name === 'AbortError' || /abort/i.test(err.message),
    );

    // The server keeps winding down after the client goes away; wait for it.
    await new Promise((r) => setTimeout(r, 250));

    const { task, step } = taskOf(sid);
    assert.equal(task.state, 'cancelled', 'a cancelled turn did not project to a cancelled task');
    assert.equal(step.state, 'cancelled');
    assert.ok(task.cancelled_at, 'the task has no cancellation timestamp');
    // A cancellation is NOT a failure, and must not borrow its fields.
    assert.equal(task.failure_reason, null, 'a cancellation was recorded as a failure');
    assert.equal(task.completed_at, null, 'a cancelled task was also marked completed');

    // Phase 0's own record is intact and unchanged.
    const guards = getDb().prepare(
      "SELECT * FROM tool_events WHERE session = ? AND kind = 'guard' AND name = 'turn_cancelled'"
    ).all(sid);
    assert.equal(guards.length, 1, 'Phase 0\'s cancellation audit row is missing or duplicated');
    assert.equal(guards[0].result_status, 'cancelled');
  } finally { toolMap.delete('task_probe_slow'); }
});

/* ------------------------------------------------------------------ *
 * T9 — the failure lifecycle
 * ------------------------------------------------------------------ */

test('T9 — a failed turn projects to failed, keeping the original error and audit', async () => {
  scriptProvider(() => new Error('the upstream fell over'));
  const sid = newSession();
  const frames = await turn(sid, 'ask something that fails');

  const errors = frames.filter((f) => f.type === 'error');
  assert.equal(errors.length, 1, 'the turn did not report exactly one error frame');

  const { task, step } = taskOf(sid);
  assert.equal(task.state, 'failed');
  assert.equal(step.state, 'failed');
  // The reason is the turn's OWN message, copied rather than reclassified.
  assert.equal(task.failure_reason, errors[0].message,
    'the task invented its own failure description instead of recording the turn\'s');
  assert.match(task.failure_reason, /the upstream fell over/);
  assert.equal(task.completed_at, null);
  assert.equal(task.cancelled_at, null);

  // The pre-existing audit path is untouched: the transcript still has the
  // user's message, and the task is an ADDITIONAL projection, not a substitute.
  const msgs = getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE session = ?').get(sid);
  assert.ok(msgs.n >= 1, 'the failing turn lost its transcript');
});

/* ------------------------------------------------------------------ *
 * T10 — the approval lifecycle
 * ------------------------------------------------------------------ */

test('T10 — a turn waiting at the gate is awaiting_approval, then completed', async () => {
  let executed = 0;
  toolMap.set('task_probe_write', {
    name: 'task_probe_write', mutating: true,
    execute: async () => { executed += 1; return { sys_id: 'a'.repeat(32), ok: true }; },
  });
  try {
    scriptProvider(
      { text: 'Updating the record now.', toolCalls: [call('task_probe_write', { sys_id: 'a'.repeat(32) })] },
      { text: 'Done — the record is updated.' },
    );
    const sid = newSession();
    let atGate = null;

    await turn(sid, 'update the record', {
      onFrame: async (e) => {
        if (e.type !== 'approval_required') return;
        // Sampled the instant the card reaches the wire. The route projects
        // BEFORE it writes, so the database is already in the waiting state.
        atGate = taskOf(sid);
        // A real approval, through the real endpoint, with the card's own
        // nonce. Nothing is fabricated and the decision object is untouched.
        const r = await fetch(`${base}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, approvalId: e.approvalId, approved: true, nonce: e.nonce }),
        }).then((x) => x.json());
        assert.equal(r.ok, true, `the gate refused the approval: ${r.reason}`);
      },
    });

    assert.ok(atGate, 'no approval card was raised');
    assert.equal(atGate.task.state, 'awaiting_approval', 'a task waiting at the gate was not awaiting_approval');
    assert.equal(atGate.step.state, 'awaiting_approval');

    assert.equal(executed, 1, 'the approved mutation did not run');
    const { task, step } = taskOf(sid);
    assert.equal(task.state, 'completed', 'the task did not return to completed after approval');
    assert.equal(step.state, 'completed');
    // `started_at` survives the round trip through the gate — a turn that
    // paused still started once.
    assert.ok(task.started_at && task.started_at <= task.completed_at);
  } finally { toolMap.delete('task_probe_write'); }
});

test('T10b — a REJECTED gate still completes the turn, and the task says so', async () => {
  // A rejection is a normal, successful turn outcome: the agent asked, a human
  // said no, the turn reported it and ended. It must not become a failed task.
  let executed = 0;
  toolMap.set('task_probe_rej', {
    name: 'task_probe_rej', mutating: true,
    execute: async () => { executed += 1; return { ok: true }; },
  });
  try {
    scriptProvider(
      { text: 'Updating the record now.', toolCalls: [call('task_probe_rej', { sys_id: 'b'.repeat(32) })] },
      { text: 'Understood — I changed nothing.' },
    );
    const sid = newSession();
    await turn(sid, 'update the record', {
      onFrame: async (e) => {
        if (e.type !== 'approval_required') return;
        await fetch(`${base}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, approvalId: e.approvalId, approved: false, nonce: e.nonce }),
        });
      },
    });

    assert.equal(executed, 0, 'a rejected mutation ran');
    const { task, step } = taskOf(sid);
    assert.equal(task.state, 'completed', 'a rejected write turned the whole task into a failure');
    assert.equal(step.state, 'completed');
  } finally { toolMap.delete('task_probe_rej'); }
});

/* ------------------------------------------------------------------ *
 * Retry requests
 * ------------------------------------------------------------------ */

test('a client Retry is a new execution and gets its own task, never a reopened one', async () => {
  /*
   * The alternative — appending a step to the previous, already-terminal task —
   * would be task-level retry, which this phase explicitly does not introduce.
   * A terminated task stays terminated; the second attempt is its own record,
   * marked in metadata so the two can be told apart later.
   */
  scriptProvider(
    () => new Error('the upstream fell over'),
    { text: 'Second time lucky.' },
  );
  const sid = newSession();
  await turn(sid, 'try something flaky');
  await turn(sid, 'try something flaky', { retry: true });

  const tasks = tasksForSession(sid);
  assert.equal(tasks.length, 2, 'a retry did not get its own task');
  const [second, first] = tasks;   // newest first
  assert.equal(first.state, 'failed', 'the first attempt was rewritten by the retry');
  assert.equal(second.state, 'completed');
  assert.equal(second.metadata?.retry, true, 'the retry is not marked as one');
  assert.ok(!first.metadata?.retry, 'the first attempt was marked as a retry');
  /*
   * EXPERIENCE §44 — and both tasks record the skill set they ran under.
   *
   * This assertion replaces a `deepEqual` against `{ retry: true }` that
   * predated the Skills layer. The two things it was protecting are both still
   * asserted above, and unchanged: the retry is marked, the first attempt is
   * not. What is added is the reason the exact shape moved — a task now carries
   * a snapshot of the enabled skills, so that disabling one later cannot
   * rewrite what a finished run was executed under (§45).
   */
  assert.ok(Array.isArray(second.metadata?.skills), 'the retry recorded no skill set');
  assert.ok(Array.isArray(first.metadata?.skills), 'the first attempt recorded no skill set');
  assert.deepEqual(
    second.metadata.skills, first.metadata.skills,
    'two turns of one session under one registry recorded different skill sets',
  );
  for (const sk of second.metadata.skills) {
    assert.ok(sk.identity && sk.id && sk.version, 'a recorded skill has no identity');
  }
  for (const t of tasks) assert.equal(stepsForTask(t.id).length, 1, 'a task grew a second step');
});

/* ------------------------------------------------------------------ *
 * T11 — restart persistence
 * ------------------------------------------------------------------ */

test('T11 — tasks and steps survive a process restart', async () => {
  scriptProvider({ text: 'Recorded.' });
  const sid = newSession();
  await turn(sid, 'something worth remembering across a restart');
  const before = taskOf(sid);

  // A genuine restart: the handle is closed and the file reopened through the
  // real migration path, exactly as `getDb()` does on boot.
  const live = getDb();
  live.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const reopened = migrate(new DatabaseSync(DB_FILE));
  try {
    const task = reopened.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(before.task.id);
    assert.ok(task, 'the task did not survive the restart');
    assert.equal(task.state, 'completed');
    assert.equal(task.goal, 'something worth remembering across a restart');
    assert.equal(task.session_id, sid);

    const steps = reopened.prepare('SELECT * FROM agent_task_steps WHERE task_id = ? ORDER BY sequence').all(before.task.id);
    assert.equal(steps.length, 1, 'the step did not survive the restart');
    assert.equal(steps[0].id, before.step.id);
    assert.equal(steps[0].state, 'completed');
    assert.equal(steps[0].kind, 'turn');
  } finally { reopened.close(); }
});

test('a task left running by a dead process stays running, and is findable', () => {
  /*
   * §17 — Phase 1 does not recover, resume, retry or fail a stale task. The
   * requirement is that the state is DURABLE and OBSERVABLE, so that a future
   * recovery phase has something to decide from. `unfinishedTasks` is that
   * observability and nothing more: a read.
   */
  const sid = newSession();
  const t = createTask({ sessionId: sid, goal: 'interrupted by a power cut' });
  createStep({ taskId: t.id, kind: 'turn' });
  startTask(t.id);

  const stale = unfinishedTasks().find((x) => x.id === t.id);
  assert.ok(stale, 'a task left running is not findable');
  assert.equal(stale.state, 'running', 'a stale task was automatically resolved — Phase 1 must not do that');
  assert.equal(stale.completed_at, null);
  assert.equal(stale.failure_reason, null);
});

/* ------------------------------------------------------------------ *
 * T12 — the model cannot touch the control plane
 * ------------------------------------------------------------------ */

test('T12 — no tool can create, move or read task state', () => {
  /*
   * Task id, step id, sequence and state are CONTROL-PLANE fields. A tool that
   * could set one could rewrite the record of what it had done, which is the
   * same class of hole the settings-writer absence closes. Asserted three ways,
   * because each alone is escapable.
   */
  // 1. The registry offers no such verb.
  for (const t of TOOLS) {
    assert.doesNotMatch(t.name, /task|step/i, `tool ${t.name} names a task concept`);
  }
  // 2. No tool's implementation calls a transition function.
  const MOVERS = /\b(createTask|createStep|startTask|startStep|completeTask|completeStep|failTask|failStep|cancelTask|cancelStep|markTaskAwaitingApproval|markStepAwaitingApproval|resumeTask|resumeStep)\s*\(/;
  for (const t of TOOLS) {
    assert.doesNotMatch(String(t.execute), MOVERS, `tool ${t.name} moves task state`);
  }
  // 3. The tool module cannot even reach the store.
  const tools = read('agent/tools.js');
  assert.doesNotMatch(tools, /from\s+['"][^'"]*memory\/tasks\.js['"]/,
    'agent/tools.js imports the task store — a tool could then write the control plane');
  assert.doesNotMatch(tools, /from\s+['"][^'"]*task-tracker\.js['"]/,
    'agent/tools.js imports the task tracker');
});

test('T12b — the task tables are written by exactly one module', () => {
  // Scattered UPDATEs are how a state column stops meaning anything. Every
  // writer lives in memory/tasks.js, so a future reader has one file to audit.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (e.name.endsWith('.js') ? [p] : []);
  });
  /*
   * The writers are a CLOSED, NAMED set — that is the property, not the number.
   * Phase 1 had one; Phase 4 added plan/store.js, which writes the executable
   * columns migration 22 introduced. Both own their own transitions and refuse
   * an illegal one, so a reader auditing "what can move task state" still has a
   * short list of files rather than a search.
   */
  const WRITERS = [
    path.join('memory', 'tasks.js'),
    path.join('memory', 'db.js'),
    path.join('agent', 'plan', 'store.js'),
  ];
  const offenders = walk(SRC)
    .filter((p) => !WRITERS.some((w) => p.endsWith(w)))
    /*
     * WRITE statements only. The original pattern also matched a bare
     * `agent_task_steps`, which caught every SELECT — including the Phase 5
     * evidence read model, whose whole point is that it only reads. Matching
     * reads made the assertion say something other than its own name.
     */
    .filter((p) => /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(agent_tasks|agent_task_steps)\b/i.test(fs.readFileSync(p, 'utf8')));
  assert.deepEqual(offenders.map((p) => path.relative(SRC, p)), [],
    'a module outside the named writers writes the task tables directly');

  /*
   * The complement, so tightening the pattern above cannot hide a real
   * writer: every module that TOUCHES these tables is either a named writer
   * or reads only. A file that queries them and also mutates them fails here.
   */
  const readers = walk(SRC)
    .filter((p) => /\bFROM\s+(agent_tasks|agent_task_steps)\b/i.test(fs.readFileSync(p, 'utf8')))
    .filter((p) => !WRITERS.some((w) => p.endsWith(w)));
  for (const r of readers) {
    assert.doesNotMatch(fs.readFileSync(r, 'utf8'),
      /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE)\b/i,
      `${path.relative(SRC, r)} reads the task tables and also contains a write statement`);
  }
});

/* ------------------------------------------------------------------ *
 * T13 — the migration
 * ------------------------------------------------------------------ */

test('T13 — migration 23 is the latest, and re-running migrations is a no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-mig-'));
  const file = path.join(dir, 'm.db');
  const db = migrate(new DatabaseSync(file));
  try {
    // PHASE 8 appended migration 23 (task correlation on the two audit tables).
    // The guard itself is unchanged: the shipped migrations must be untouched
    // and only the newest phase may append.
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 28,
      'the schema is not at exactly 28 migrations — the shipped ones must be untouched and only the '
      + 'newest phase may append');

    // Idempotent: migrating an already-current database changes nothing.
    migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 28);

    // And migration 21 is self-contained: a database at 20 gains exactly the
    // two new tables and nothing else has to be re-run.
    db.exec('DROP TABLE agent_task_steps; DROP TABLE agent_tasks; PRAGMA user_version = 20;');
    migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 28);
    for (const t of ['agent_tasks', 'agent_task_steps']) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t);
      assert.ok(row, `migration 21 did not recreate ${t}`);
    }
  } finally { db.close(); }
});

test('T13b — the schema follows the repo\'s audit conventions', () => {
  const fks = (t) => getDb().prepare(`PRAGMA foreign_key_list(${t})`).all();

  // A task is a durable projection, not part of the transcript. Migration 19
  // made the same call for tool_events and sysid_provenance: deleting a chat
  // must not take the record of what the agent did.
  assert.deepEqual(fks('agent_tasks').filter((f) => f.table === 'sessions'), [],
    'agent_tasks cascades from sessions — deleting a chat would erase its task history');

  // The step->task link IS a real parent/child and does cascade.
  const stepFk = fks('agent_task_steps').filter((f) => f.table === 'agent_tasks');
  assert.equal(stepFk.length, 1, 'a step is not bound to its task');
  assert.equal(stepFk[0].on_delete, 'CASCADE');

  // Sequence is unique within a task, so ordering is a property of the data.
  const idx = getDb().prepare('PRAGMA index_list(agent_task_steps)').all();
  const uniques = idx.filter((i) => i.unique).map((i) =>
    getDb().prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map((c) => c.name).join(','));
  assert.ok(uniques.includes('task_id,sequence'),
    'sequence is not unique within a task — ordering would depend on read order');
});

test('deleting a chat keeps its task history, exactly as it keeps the audit trail', () => {
  const sid = newSession();
  const t = createTask({ sessionId: sid, goal: 'survives the chat' });
  createStep({ taskId: t.id, kind: 'turn' });
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sid);

  assert.ok(getTask(t.id), 'a chat delete took the task with it');
  assert.equal(stepsForTask(t.id).length, 1, 'a chat delete took the step with it');
});

/* ------------------------------------------------------------------ *
 * The store's own discipline
 * ------------------------------------------------------------------ */

test('the state vocabularies are exactly what this phase declared', () => {
  assert.deepEqual([...TASK_STATES],
    ['planned', 'running', 'awaiting_approval', 'blocked', 'completed', 'failed', 'cancelled']);
  assert.deepEqual([...STEP_STATES], [...TASK_STATES]);
  /*
   * The kind list stays CLOSED, and that is what this asserts. Phase 1 pinned
   * it to ['turn'] with the note that adding more "before a planner exists
   * would be guessing at it". Phase 4 built the planner, so `plan_step` joined
   * it — a kind that plan/store.js actually writes, rather than one reserved
   * for a phase that does not exist. Everything still absent stays absent.
   */
  assert.deepEqual([...STEP_KINDS], ['turn', 'plan_step']);
  for (const speculative of ['analysis', 'verification', 'checkpoint', 'recovery', 'tool', 'approval']) {
    assert.ok(!STEP_KINDS.includes(speculative),
      `${speculative} was added before anything creates it`);
  }
  assert.deepEqual([...TERMINAL_STATES], ['completed', 'failed', 'cancelled']);
});

test('a terminal task never moves again', () => {
  const sid = newSession();
  const t = createTask({ sessionId: sid, goal: 'terminal' });
  startTask(t.id);
  completeTask(t.id);
  assert.equal(getTask(t.id).state, 'completed');

  // Every one of these is refused, and refused quietly enough not to throw into
  // a turn — a second terminal frame must not be able to rewrite the first.
  failTask(t.id, 'no');
  cancelTask(t.id);
  startTask(t.id);
  assert.equal(getTask(t.id).state, 'completed', 'a terminal task was moved');
  assert.equal(getTask(t.id).failure_reason, null, 'a completed task acquired a failure reason');

  for (const s of TERMINAL_STATES) assert.equal(canTransition(s, 'running'), false);
  assert.equal(canTransition('running', 'awaiting_approval'), true);
  assert.equal(canTransition('awaiting_approval', 'running'), true);
  assert.equal(canTransition('planned', 'completed'), false, 'a task may not complete without running');
});

test('step sequence is allocated by the table, not by the caller', () => {
  const sid = newSession();
  const t = createTask({ sessionId: sid, goal: 'sequencing' });
  // Phase 1 only ever creates one step per task; this asserts the ALLOCATOR is
  // sound for the phase that will create more.
  const a = createStep({ taskId: t.id, kind: 'turn' });
  const b = createStep({ taskId: t.id, kind: 'turn' });
  const c = createStep({ taskId: t.id, kind: 'turn' });
  assert.deepEqual([a.sequence, b.sequence, c.sequence], [1, 2, 3]);
  assert.deepEqual(stepsForTask(t.id).map((s) => s.sequence), [1, 2, 3]);
  // And it is enforced, not merely conventional.
  assert.throws(() => getDb().prepare(
    `INSERT INTO agent_task_steps (id, task_id, sequence, state, kind, created_at, updated_at)
     VALUES ('dup', ?, 1, 'planned', 'turn', '', '')`
  ).run(t.id), /UNIQUE|constraint/i);
});

test('an unknown step kind is refused rather than stored', () => {
  const sid = newSession();
  const t = createTask({ sessionId: sid, goal: 'kinds' });
  assert.equal(createStep({ taskId: t.id, kind: 'checkpoint' }), null,
    'a future step kind was accepted before anything creates one');
  assert.equal(stepsForTask(t.id).length, 0);
});

/* ------------------------------------------------------------------ *
 * §19 — the architectural invariant
 * ------------------------------------------------------------------ */

test('ARCHITECTURE — task persistence sits ABOVE the execution layer', () => {
  /*
   * The required direction:
   *
   *     task layer  ->  orchestrator  ->  execution machinery  ->  ServiceNow
   *
   * and never the reverse. Three separate things have to hold, and each fails
   * differently, so each is asserted on its own.
   */
  const IMPORT = /^[ \t]*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm;
  const importsOf = (rel) => [...read(rel).matchAll(IMPORT)].map((m) => m[1]);

  // 1. The task layer reaches nothing below it. If it imported the ServiceNow
  //    client, the SDK, the harness or the transport sweep, "task orchestration
  //    does not touch execution internals" would be false however carefully the
  //    rest were written.
  for (const rel of ['memory/tasks.js', 'agent/task-tracker.js']) {
    for (const spec of importsOf(rel)) {
      assert.doesNotMatch(spec, /servicenow\//,
        `${rel} imports ${spec} — the task layer must not reach the execution machinery`);
    }
  }

  // 2. The task tracker does not reach INTO the orchestrator either. It watches
  //    the turn's emitted frames; it does not drive the loop. That is what
  //    keeps `runTurn` unmodified and unaware.
  for (const spec of importsOf('agent/task-tracker.js')) {
    assert.doesNotMatch(spec, /agent\/orchestrator\.js/,
      'the task tracker imports the orchestrator — it must observe, not drive');
  }

  // 3. NOTHING BELOW imports the task layer. This is the one that matters: an
  //    upward import would invert the arrow and make the execution layer depend
  //    on orchestration.
  const belowDirs = ['servicenow', 'memory', 'knowledge'];
  for (const dir of belowDirs) {
    for (const file of fs.readdirSync(path.join(SRC, dir))) {
      if (!file.endsWith('.js') || `${dir}/${file}` === 'memory/tasks.js') continue;
      for (const spec of importsOf(`${dir}/${file}`)) {
        assert.doesNotMatch(spec, /memory\/tasks\.js|task-tracker\.js/,
          `${dir}/${file} imports the task layer — the dependency arrow must point down`);
      }
    }
  }
  // The orchestrator itself is the sharpest case: it is the layer the task
  // tracker observes, and it must stay ignorant of tasks entirely.
  for (const spec of importsOf('agent/orchestrator.js')) {
    assert.doesNotMatch(spec, /memory\/tasks\.js|task-tracker\.js/,
      'the orchestrator imports the task layer — runTurn must remain unaware that tasks exist');
  }
});

test('ARCHITECTURE — Phase 1 introduced no planner, queue or scheduler', () => {
  // The negative space, asserted. Every one of these belongs to a later phase,
  // and each is the kind of thing that arrives "just a small version of it".
  const tracker = read('agent/task-tracker.js');
  const store = read('memory/tasks.js');
  for (const src of [tracker, store]) {
    assert.doesNotMatch(src, /setInterval|setTimeout|new Worker|Queue\b/,
      'the task layer schedules something — Phase 1 has no queue, worker or timer');
  }
  // §16 — the database is the source of truth; no process-global task state.
  for (const src of [tracker, store]) {
    assert.doesNotMatch(src, /^\s*(const|let|var)\s+\w*\s*=\s*new Map\(/m,
      'the task layer keeps a module-level Map — the database is the source of truth');
  }
});

test('ARCHITECTURE — the task layer adds nothing to the model\'s prompt', () => {
  /*
   * §11/§18. The model is told nothing about tasks: no id, no state, no
   * history. The prompt builder does not know the task layer exists, so the
   * overhead is not "small", it is zero — and that is checkable rather than
   * estimated.
   */
  const prompts = read('agent/prompts.js');
  assert.doesNotMatch(prompts, /memory\/tasks\.js|task-tracker\.js/,
    'the system prompt builder imports the task layer');
  assert.doesNotMatch(prompts, /\btask_id\b|\bstep_id\b|agent_tasks/,
    'the system prompt mentions task identity — Phase 1 adds no prompt overhead');
});
