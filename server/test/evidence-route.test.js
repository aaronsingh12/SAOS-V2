/**
 * PHASE 5 — THE EVIDENCE ENDPOINT.
 *
 *   node --test server/test/
 *
 * `evidence.test.js` asserts the projection. This asserts that it is REACHABLE
 * and READ-ONLY: that a GET returns the durable object, that it changes nothing
 * it touches, that it works after the process that made the task is gone and
 * after the originating chat has been deleted, and that a missing task is a
 * deterministic 404 rather than an empty evidence object.
 *
 * The real router is mounted exactly as `src/index.js` mounts it, so this
 * exercises the wiring rather than a replica.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-evidroute-'));
const DB_FILE = path.join(scratchDir, 'test.db');
_setDbForTests(migrate(new DatabaseSync(DB_FILE)));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'hunter2' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
});

const E = await import('../src/agent/evidence/index.js');
const P = await import('../src/agent/plan/index.js');
const { createTask, startTask, completeTask } = await import('../src/memory/tasks.js');
const { getDb } = await import('../src/memory/db.js');
const { APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');

let n = 0;
const newSession = () => `evr-${++n}`;

const stepOf = (over = {}) => ({
  id: over.id ?? 'step_1',
  operation: 'update the incident',
  capability: 'record_update',
  tool: 'update_record',
  mechanism: 'rest',
  scope: null,
  mutating: true,
  target: { table: 'incident', sys_id: 'a'.repeat(32) },
  inputs: over.inputs ?? { table: 'incident', sys_id: 'a'.repeat(32), data: { short_description: 'x' } },
  depends_on: over.depends_on ?? [],
  expected_effects: over.expected_effects ?? ['short_description is updated'],
  verification: { strategy: 'read_back', asserts: ['short_description'] },
});

function approvedRun(goal, steps) {
  const sid = newSession();
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  const saved = P.savePlan(t.id, { goal, steps });
  P.setPlanState(t.id, 'ready');
  P.setPlanState(t.id, 'awaiting_approval');
  P.approvePlan(t.id, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  return { taskId: t.id, sessionId: sid, fingerprint: saved.fingerprint };
}

const APPLIED = (field, value) => ({
  status: 'applied', summary: `${field} stored`, applied: [{ field, value }],
  dropped: [], transformed: [], unverifiable: [],
});

function finish(taskId, stepId, verification, result = { sys_id: 'a'.repeat(32) }) {
  P.setStepState(taskId, stepId, 'ready');
  P.setStepState(taskId, stepId, 'executing');
  P.setStepState(taskId, stepId, 'verifying');
  P.recordStepResult(taskId, stepId, { result, verification });
  P.setStepState(taskId, stepId, 'completed');
}

let server = null;
let base = null;

test.before(async () => {
  const express = (await import('express')).default;
  const { planRouter } = await import('../src/routes/plan.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/agent/plan', planRouter);
  // The same error middleware src/index.js installs, so a 404 renders the same.
  app.use((err, req, res, _next) => {
    res.status(err.status || 500).json({ message: err.message });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/agent/plan`;
});

test.after(async () => { if (server) await new Promise((r) => server.close(r)); });

/* ------------------------------------------------------------------ */

test('ROUTE — GET returns the durable evidence projection', async () => {
  const { taskId, fingerprint } = approvedRun('update the description', [stepOf({ id: 'step_1' })]);
  finish(taskId, 'step_1', APPLIED('short_description', 'x'));
  P.setPlanState(taskId, 'completed');
  completeTask(taskId);

  const body = await fetch(`${base}/${taskId}/evidence`).then((r) => r.json());
  assert.equal(body.task.id, taskId);
  assert.equal(body.request.text, 'update the description');
  assert.equal(body.plan.fingerprint, fingerprint);
  assert.equal(body.approval.valid, true);
  assert.equal(body.steps.length, 1);
  assert.equal(body.steps[0].execution_status, 'completed');
  assert.equal(body.steps[0].verification_status, 'applied');
  assert.equal(body.final.status, E.STATUS.VERIFIED);
  // Every section the contract promises.
  for (const k of ['task', 'request', 'plan', 'approval', 'steps', 'changes', 'verification', 'final', 'uncertainties']) {
    assert.ok(k in body, `the evidence object has no "${k}" section`);
  }
});

test('ROUTE — it matches what the builder produces, exactly', async () => {
  const { taskId } = approvedRun('parity', [stepOf({ id: 'step_1' })]);
  finish(taskId, 'step_1', APPLIED('short_description', 'x'));
  const overHttp = await fetch(`${base}/${taskId}/evidence`).then((r) => r.json());
  const direct = JSON.parse(JSON.stringify(E.buildEvidence(taskId)));
  assert.deepEqual(overHttp, direct, 'the endpoint returns something other than the projection');
});

test('ROUTE — a missing task is a deterministic 404, not an empty evidence object', async () => {
  const res = await fetch(`${base}/no-such-task/evidence`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.message, /No such task/);
  // Twice, identically.
  assert.equal((await fetch(`${base}/no-such-task/evidence`)).status, 404);
});

test('ROUTE — reading evidence MUTATES NOTHING', async () => {
  /*
   * A read model that writes is not a read model. This checks the whole
   * database, not just the task: a projection that touched a counter, a
   * timestamp or an audit row would show up here.
   */
  const { taskId } = approvedRun('do not touch me', [stepOf({ id: 'step_1' })]);
  finish(taskId, 'step_1', APPLIED('short_description', 'x'));

  const snapshot = () => {
    const tables = getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'",
    ).all().map((r) => r.name);
    const out = {};
    for (const t of tables) out[t] = getDb().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return out;
  };
  const before = snapshot();
  const beforeTask = getDb().prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId);

  await fetch(`${base}/${taskId}/evidence`);
  await fetch(`${base}/${taskId}/evidence`);

  assert.deepEqual(snapshot(), before, 'reading evidence changed a row count');
  assert.deepEqual(getDb().prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId), beforeTask,
    'reading evidence modified the task row');
});

test('ROUTE — evidence survives a process restart', async () => {
  const { taskId } = approvedRun('restart me', [stepOf({ id: 'step_1' })]);
  finish(taskId, 'step_1', APPLIED('short_description', 'x'));
  P.setPlanState(taskId, 'completed');
  completeTask(taskId);
  const before = await fetch(`${base}/${taskId}/evidence`).then((r) => r.json());

  getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const reopened = migrate(new DatabaseSync(DB_FILE));
  _setDbForTests(reopened);
  try {
    const after = await fetch(`${base}/${taskId}/evidence`).then((r) => r.json());
    assert.deepEqual(after, before, 'evidence changed across a restart');
  } finally {
    _setDbForTests(migrate(new DatabaseSync(DB_FILE)));
    reopened.close();
  }
});

test('ROUTE — evidence is still served after the originating chat is deleted', async () => {
  /*
   * Phase 1 deliberately gave tasks no foreign key to sessions. This is the
   * property that decision bought: the record of what the agent did outlives
   * the conversation that asked for it.
   */
  const { taskId, sessionId } = approvedRun('outlive the chat', [stepOf({ id: 'step_1' })]);
  finish(taskId, 'step_1', APPLIED('short_description', 'x'));

  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

  const res = await fetch(`${base}/${taskId}/evidence`);
  assert.equal(res.status, 200, 'deleting the chat made the evidence unreachable');
  const body = await res.json();
  assert.equal(body.task.session.exists, false);
  assert.equal(body.request.text, 'outlive the chat', 'the original request was lost with the chat');
  assert.equal(body.steps.length, 1);
});

test('ROUTE — no credential ever leaves the server', async () => {
  const { taskId } = approvedRun('secrets over http', [stepOf({
    id: 'step_1',
    inputs: {
      table: 'incident',
      password: 'hunter2',
      api_key: 'sk-live-DEADBEEF',
      headers: { Authorization: 'Basic YWRtaW46aHVudGVyMg==' },
    },
  })]);
  finish(taskId, 'step_1', APPLIED('short_description', 'x'), { token: 'tok_supersecret', ok: true });

  const raw = await fetch(`${base}/${taskId}/evidence`).then((r) => r.text());
  for (const secret of ['hunter2', 'sk-live-DEADBEEF', 'YWRtaW46aHVudGVyMg==', 'tok_supersecret']) {
    assert.ok(!raw.includes(secret), `the secret ${secret} was served over HTTP`);
  }
  assert.deepEqual(E.findSecrets(JSON.parse(raw)), []);
});

test('ROUTE — the endpoint lives beside the plan route rather than duplicating it', async () => {
  // One address for one concept: evidence is about a task, and the plan route
  // is what creates tasks. A second endpoint elsewhere would be a duplicate.
  const { taskId } = approvedRun('one address', [stepOf({ id: 'step_1' })]);
  assert.equal((await fetch(`${base}/${taskId}`)).status, 200, 'the plan endpoint stopped working');
  assert.equal((await fetch(`${base}/${taskId}/evidence`)).status, 200);
  // And the plan endpoint still returns the PLAN, not the evidence.
  const planBody = await fetch(`${base}/${taskId}`).then((r) => r.json());
  assert.ok(planBody.review, 'the plan endpoint stopped returning the review');
  assert.ok(!('final' in planBody), 'the plan endpoint started returning evidence');
});
