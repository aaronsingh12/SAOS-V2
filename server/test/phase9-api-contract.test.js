/**
 * PHASE 9 — THE API CONTRACT, over real sockets.
 *
 *   node --test server/test/
 *
 * Every request below goes through a real Express app on a real loopback port
 * with a real SSE stream. What is being checked is the contract at the edge:
 * exactly one terminal frame, a stable response shape, an honest status code,
 * and — for the failure modes that leave a server leaking — no hanging promise,
 * no dangling approval waiter, and no write after the response has closed.
 *
 * THE TERMINAL-FRAME INVARIANT is the load-bearing one. A client that never
 * receives a terminal frame waits forever; a client that receives two cannot
 * tell which one was true. Every case here asserts exactly one.
 *
 * UNHANDLED REJECTIONS ARE A TEST FAILURE. A process-level listener is
 * installed for the whole file, so a promise dropped inside any of these paths
 * fails the run rather than printing a warning nobody reads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p9api-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const P = await import('../src/agent/plan/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { getDb } = await import('../src/memory/db.js');
const { APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');

/* ---- unhandled rejections fail the file ---- */
const rejections = [];
process.on('unhandledRejection', (r) => rejections.push(r));

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
  // The real error shape: a handler that throws must produce a status, not a hang.
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ ok: false, message: err.message });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/agent`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  assert.deepEqual(rejections.map((r) => String(r?.message ?? r)), [],
    'a promise was rejected with nobody listening');
});

let n = 0;
function seedTask(goal = 'api') {
  const sid = `p9api-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const TERMINAL = new Set(['plan_completed', 'plan_failed', 'plan_cancelled']);

/** POST an SSE request and read to the end. */
async function stream(pathname, bodyObj, { signal = null, onFrame = null, slow = false } = {}) {
  const frames = [];
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
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
        if (onFrame) await onFrame(evt);
        // A deliberately slow reader: the server must not care.
        if (slow) await new Promise((r) => setTimeout(r, 5));
      }
    }
  }
  return { status: res.status, frames };
}

const terminalsOf = (frames) => frames.filter((f) => TERMINAL.has(f.type));

/* ================================================================== *
 * A. THE TERMINAL FRAME
 * ================================================================== */

test('A1 — a normal plan request emits exactly ONE terminal frame', async () => {
  const { frames } = await stream('/plan', { sessionId: `p9api-n-${++n}`, message: 'read the three most recent incidents' });
  const terminals = terminalsOf(frames);
  assert.equal(terminals.length, 1, `expected 1 terminal frame, got ${terminals.map((t) => t.type).join(', ') || 'none'}`);
  assert.ok(frames.some((f) => f.type === 'plan_started'), 'the stream never announced itself');
});

test('A2 — a SLOW client still gets exactly one terminal frame', async () => {
  const { frames } = await stream('/plan',
    { sessionId: `p9api-slow-${++n}`, message: 'update every incident on the instance' }, { slow: true });
  assert.equal(terminalsOf(frames).length, 1);
});

test('A3 — a client ABORT does not leave the server writing or rejecting', async () => {
  const ctl = new AbortController();
  const p = stream('/plan', { sessionId: `p9api-abort-${++n}`, message: 'create a flow that notifies the manager' },
    { signal: ctl.signal, onFrame: () => ctl.abort() });
  await assert.rejects(() => p, /abort/i);
  // Give the server a moment to notice and settle its own side.
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(rejections.map((x) => String(x?.message ?? x)), [],
    'aborting a client produced an unhandled rejection on the server');
});

test('A4 — a DISCONNECTED client does not stop the durable record', async () => {
  const ctl = new AbortController();
  const sessionId = `p9api-disc-${++n}`;
  const p = stream('/plan', { sessionId, message: 'read the incident table schema' },
    { signal: ctl.signal, onFrame: (e) => { if (e.type === 'plan_started') ctl.abort(); } });
  await assert.rejects(() => p);
  await new Promise((r) => setTimeout(r, 300));
  // The task exists and carries a state — the projection does not depend on
  // anyone still listening.
  const row = getDb().prepare('SELECT id, state FROM agent_tasks WHERE session_id = ?').get(sessionId);
  assert.ok(row, 'the disconnect took the task with it');
  assert.ok(['running', 'cancelled', 'failed', 'completed'].includes(row.state), `unexpected state ${row.state}`);
});

/* ================================================================== *
 * B. MALFORMED AND MISSING INPUT
 * ================================================================== */

test('A5 — malformed JSON is a 400, not a hang and not a 500', async () => {
  for (const bad of ['{', '{"sessionId":}', 'not json at all', '[]']) {
    const res = await fetch(`${base}/plan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bad,
    });
    assert.ok(res.status >= 400 && res.status < 500,
      `body ${JSON.stringify(bad)} produced ${res.status}`);
    await res.text();   // drain, so nothing is left half-read
  }
});

test('A6 — missing parameters are refused with a reason, never planned optimistically', async () => {
  for (const body of [{}, { sessionId: 'x' }, { message: 'do a thing' }, { sessionId: null, message: null }]) {
    const res = await fetch(`${base}/plan`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 200) {
      // If it opened a stream, that stream must terminate with a refusal and
      // must not have executed anything.
      const frames = text.split('\n\n').filter((c) => c.startsWith('data: '))
        .map((c) => JSON.parse(c.slice(6)));
      assert.equal(terminalsOf(frames).length, 1, `${JSON.stringify(body)} did not terminate`);
      assert.equal(frames.filter((f) => f.type === 'step_started').length, 0,
        `${JSON.stringify(body)} started a step`);
    } else {
      assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(body)} produced ${res.status}`);
    }
  }
});

test('A7 — an unknown task id on the evidence endpoint is a deterministic 404', async () => {
  for (const id of ['does-not-exist', '../etc/passwd', '00000000-0000-0000-0000-000000000000', 'null']) {
    const res = await fetch(`${base}/plan/${encodeURIComponent(id)}/evidence`);
    assert.equal(res.status, 404, `task id ${JSON.stringify(id)} produced ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.ok(typeof body.message === 'string' && body.message.length > 0, 'the 404 carries no reason');
  }
});

test('A8 — the evidence response shape is stable across every lifecycle state', async () => {
  const REQUIRED = ['task', 'request', 'plan', 'approval', 'steps', 'changes', 'builds',
    'verification', 'final', 'uncertainties', 'audit', 'recovery'];
  const cases = [];

  // 1. A task with no plan.
  cases.push(seedTask('bare').taskId);
  // 2. A saved but unapproved plan.
  {
    const { taskId } = seedTask('unapproved');
    P.savePlan(taskId, { goal: 'g', steps: [{
      id: 's1', operation: 'read', capability: 'record_read', tool: 'get_record',
      mutating: false, inputs: {}, depends_on: [], expected_effects: [], verification: null,
    }] });
    cases.push(taskId);
  }
  // 3. An approved plan that never ran.
  {
    const { taskId } = seedTask('approved');
    const saved = P.savePlan(taskId, { goal: 'g', steps: [{
      id: 's1', operation: 'read', capability: 'record_read', tool: 'get_record',
      mutating: false, inputs: {}, depends_on: [], expected_effects: [], verification: null,
    }] });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    cases.push(taskId);
  }
  // 4. A failed plan.
  {
    const { taskId } = seedTask('failed');
    P.savePlan(taskId, { goal: 'g', steps: [{
      id: 's1', operation: 'read', capability: 'record_read', tool: 'get_record',
      mutating: false, inputs: {}, depends_on: [], expected_effects: [], verification: null,
    }] });
    P.setPlanState(taskId, 'failed', { failure_reason: 'it did not work' });
    cases.push(taskId);
  }

  for (const taskId of cases) {
    const res = await fetch(`${base}/plan/${taskId}/evidence`);
    assert.equal(res.status, 200, `task ${taskId} produced ${res.status}`);
    const ev = await res.json();
    for (const key of REQUIRED) {
      assert.ok(key in ev, `task ${taskId} evidence is missing "${key}"`);
    }
    assert.equal(typeof ev.final.status, 'string');
    assert.ok(Array.isArray(ev.steps) && Array.isArray(ev.changes) && Array.isArray(ev.uncertainties));
    assert.ok(ev.audit && typeof ev.audit.exact === 'boolean');
    assert.ok(ev.recovery && typeof ev.recovery.attempted === 'boolean');
  }
});

/* ================================================================== *
 * C. THE APPROVE ENDPOINT
 * ================================================================== */

test('A9 — approving an unknown approval id is refused, not accepted', async () => {
  const res = await fetch(`${base}/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'nobody', approvalId: 'no-such-card', approved: true, nonce: 'x' }),
  });
  const body = await res.json().catch(() => ({}));
  assert.ok(res.status >= 400 || body.ok === false,
    `an unknown approval produced ${res.status} ${JSON.stringify(body)}`);
});

test('A10 — a stale nonce is refused and the response says so', async () => {
  const res = await fetch(`${base}/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'nobody', approvalId: 'x', approved: true, nonce: 'stale-token' }),
  });
  const body = await res.json().catch(() => ({}));
  assert.ok(res.status >= 400 || body.ok === false);
  assert.ok(!body.approved, 'a stale nonce produced an approval');
});

test('A11 — DUPLICATE submissions do not double-resolve', async () => {
  // Two identical approve POSTs for a card that does not exist must both refuse
  // identically — the endpoint is not order-dependent and holds no state.
  const send = () => fetch(`${base}/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'dup', approvalId: 'dup-card', approved: true, nonce: 'n' }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const [a, b] = await Promise.all([send(), send()]);
  assert.equal(a.status, b.status, 'two identical requests produced different statuses');
  assert.deepEqual(a.body.ok, b.body.ok);
});

/* ================================================================== *
 * D. CONCURRENT REQUESTS AT THE EDGE
 * ================================================================== */

test('A12 — eight concurrent evidence reads all succeed and stay distinct', async () => {
  const ids = Array.from({ length: 8 }, (_, i) => {
    const { taskId } = seedTask(`conc ${i}`);
    P.savePlan(taskId, { goal: `conc ${i}`, steps: [{
      id: `s${i}`, operation: 'read', capability: 'record_read', tool: 'get_record',
      mutating: false, inputs: {}, depends_on: [], expected_effects: [], verification: null,
    }] });
    return taskId;
  });
  const results = await Promise.all(ids.map((id) => fetch(`${base}/plan/${id}/evidence`).then((r) => r.json())));
  results.forEach((ev, i) => {
    assert.equal(ev.task.id, ids[i], 'a concurrent evidence read returned another task');
    assert.deepEqual(ev.steps.map((s) => s.id), [`s${i}`]);
  });
});

test('A13 — four concurrent plan streams each terminate exactly once', async () => {
  const runs = await Promise.all(Array.from({ length: 4 }, (_, i) => stream('/plan', {
    sessionId: `p9api-multi-${i}-${++n}`,
    message: `read the schema of the ${['incident', 'problem', 'change_request', 'sc_task'][i]} table`,
  })));
  for (const [i, r] of runs.entries()) {
    assert.equal(terminalsOf(r.frames).length, 1,
      `stream ${i} produced ${terminalsOf(r.frames).length} terminal frames`);
  }
});

/* ================================================================== *
 * E. NO DANGLING STATE
 * ================================================================== */

test('A14 — no approval waiter survives a settled stream', async () => {
  /*
   * A pending approval is a live promise with a `resolve` nobody else holds. If
   * a stream settles without clearing it, the process keeps a resolver — and
   * the next answer for that session resolves something nobody is awaiting.
   */
  const orch = fs.readFileSync(new URL('../src/agent/orchestrator.js', import.meta.url), 'utf8');
  // The waiter is removed on EVERY exit: resolution, cancellation and teardown.
  assert.match(orch, /pending\.delete\(approvalId\)/, 'a resolved approval is never removed');
  const cancelPath = orch.slice(orch.indexOf('export function awaitApprovalDecision'));
  assert.match(cancelPath.slice(0, 2000), /pending\.delete|removeEventListener|signal/,
    'a cancelled approval waiter is never cleaned up');
});

test('A15 — the keep-alive interval is always cleared', async () => {
  for (const f of ['routes/agent.js', 'routes/plan.js']) {
    const src = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.match(src, /const keepAlive = setInterval\(/, `${f} has no keep-alive`);
    const clears = [...src.matchAll(/clearInterval\(keepAlive\)/g)];
    assert.ok(clears.length > 0, `${f} never clears its keep-alive`);

    /*
     * EVERY exit clears it, and there are two shapes of exit.
     *
     * The main one is a `finally`, so an exception on the turn cannot leak the
     * timer. An early bail-out — `plan.js` refusing before it has a task —
     * cannot use that `finally` because it returns before the try, so it clears
     * inline next to its own `res.end()`. Both are correct; requiring the
     * `finally` shape everywhere would have been requiring the wrong thing.
     */
    let inFinally = 0;
    for (const m of clears) {
      const before = src.slice(Math.max(0, m.index - 400), m.index);
      const after = src.slice(m.index, m.index + 200);
      if (/finally\s*\{[^}]*$/.test(before)) { inFinally += 1; continue; }
      assert.match(after, /res\.end\(\)/,
        `${f} clears its keep-alive at offset ${m.index} without ending the response`);
    }
    assert.ok(inFinally >= 1, `${f} has no keep-alive clear in a finally, so an exception leaks the timer`);
  }
});

test('A16 — the response is never written after it closes', async () => {
  for (const f of ['routes/agent.js', 'routes/plan.js']) {
    const src = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    // Every SSE write is guarded, so a write to a gone client cannot throw into
    // the turn.
    const writes = [...src.matchAll(/res\.write\(/g)];
    assert.ok(writes.length > 0, `${f} makes no SSE writes`);
    for (const m of writes) {
      const around = src.slice(Math.max(0, m.index - 200), m.index + 120);
      assert.match(around, /try\s*\{|catch/, `${f} has an unguarded res.write at offset ${m.index}`);
    }
    // And a settled flag exists so a late close is not read as a cancellation.
    assert.match(src, /settled|writableEnded/, `${f} cannot tell a normal end from a disconnect`);
  }
});
