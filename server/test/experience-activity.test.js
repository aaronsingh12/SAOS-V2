/**
 * NOWFORGE EXPERIENCE — THE ACTIVITY READ MODEL.
 *
 *   node --test server/test/
 *
 * §60 asks for tests over event normalization, ordering, deduplication, SSE
 * reconnect, task reconstruction and status calculation. §61 adds the harder
 * half: that the events are REAL — no fabricated running state, no fake
 * completion, and nothing executed by rendering.
 *
 * The second half is what most of this file is about. A read model is easy to
 * test for what it produces and easy to get wrong in what it INVENTS, so almost
 * every assertion below is of the form "given a task that did X, the projection
 * says X and does not say Y".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowforge-xact-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'hunter2' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const A = await import('../src/agent/activity/index.js');
const { createTask, createStep, startTask, startStep, completeTask, completeStep, failTask, cancelTask, markTaskAwaitingApproval } =
  await import('../src/memory/tasks.js');
const { createSession } = await import('../src/memory/sessions.js');
const { recordToolEvent } = await import('../src/memory/sessions.js');
const { getDb } = await import('../src/memory/db.js');

const {
  ACTIVITY_STATUS, ACTIVITY_TYPE, AGENT_STATUS, STATUS_PRECEDENCE,
  fromFrame, dedupe, agentStatus, planProgress, activityForTask, taskHistory, statusForTask,
  isWorking, isWaiting, FRAME_MAP, ACTIVITY_FRAMES,
} = A;

let n = 0;
const newSession = () => {
  const id = `sess-${(n += 1)}`;
  createSession({ id });
  return id;
};

/* ================================================================== *
 * §6 — normalization
 * ================================================================== */

test('X1 — a tool frame becomes one row with the tool\'s own name', () => {
  const e = fromFrame({ type: 'tool_use', id: 'c1', name: 'query_records' }, { taskId: 't', seq: 4 });
  assert.equal(e.type, ACTIVITY_TYPE.TOOL);
  assert.equal(e.status, ACTIVITY_STATUS.RUNNING);
  assert.equal(e.title, 'query_records');
  assert.equal(e.seq, 4);
  assert.equal(e.task_id, 't');
});

test('X2 — an unknown frame produces NOTHING, never a generic row', () => {
  /*
   * The safe direction. A frame this map has not seen must not become a row
   * titled after its own type, because that would put a line in the timeline
   * asserting the agent did something the workspace cannot name (§8).
   */
  assert.equal(fromFrame({ type: 'something_new_and_unmapped' }, { taskId: 't' }), null);
  assert.equal(fromFrame({}, { taskId: 't' }), null);
  assert.equal(fromFrame(null, { taskId: 't' }), null);
});

test('X3 — a declared non-activity frame is null, and that is a decision not an omission', () => {
  for (const t of ['meta', 'budget', 'compacted', 'context_profile', 'assistant_text', 'skills_active']) {
    assert.ok(Object.prototype.hasOwnProperty.call(FRAME_MAP, t), `${t} has no entry at all`);
    assert.equal(FRAME_MAP[t], null, `${t} should be declared non-activity`);
    assert.equal(fromFrame({ type: t }, { taskId: 't' }), null);
  }
});

test('X4 — a tool ERROR is failed only because the frame said isError', () => {
  const ok = fromFrame({ type: 'tool_result', id: 'c1', name: 'get_record', output: 'update failed somewhere' }, { taskId: 't' });
  assert.equal(ok.status, ACTIVITY_STATUS.COMPLETED,
    'the word "failed" inside a successful result must not make the row fail');
  const bad = fromFrame({ type: 'tool_result', id: 'c1', name: 'get_record', isError: true, output: 'no such record' }, { taskId: 't' });
  assert.equal(bad.status, ACTIVITY_STATUS.FAILED);
  assert.equal(bad.summary, 'no such record');
});

test('X5 — a verification row copies the backend\'s verdict and never decides one', () => {
  const v = fromFrame({ type: 'step_verified', stepId: 's1', verdict: 'unverified', detail: 'the read-back did not match' }, { taskId: 't' });
  assert.equal(v.title, 'Verification: unverified');
  assert.equal(v.status, ACTIVITY_STATUS.FAILED);
  const good = fromFrame({ type: 'step_verified', stepId: 's1', verdict: 'verified' }, { taskId: 't' });
  assert.equal(good.status, ACTIVITY_STATUS.COMPLETED);
  /* No verdict at all is not "verified". */
  const none = fromFrame({ type: 'step_verified', stepId: 's1' }, { taskId: 't' });
  assert.equal(none.status, ACTIVITY_STATUS.FAILED);
  assert.match(none.title, /unknown/);
});

/* ================================================================== *
 * §11 — deduplication
 * ================================================================== */

test('X6 — the two halves of one tool call are ONE row, and the later one wins', () => {
  const use = fromFrame({ type: 'tool_use', id: 'c1', name: 'update_record' }, { taskId: 't', seq: 1 });
  const res = fromFrame({ type: 'tool_result', id: 'c1', name: 'update_record' }, { taskId: 't', seq: 2 });
  assert.equal(use.id, res.id, 'the two frames of one call produced different identities');
  const rows = dedupe([use, res]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, ACTIVITY_STATUS.COMPLETED);
});

test('X7 — replaying the SAME events three times still yields one timeline', () => {
  /*
   * §11's literal requirement: never show one tool execution three times
   * because of an SSE reconnect.
   */
  const one = fromFrame({ type: 'tool_use', id: 'c1', name: 'query_records' }, { taskId: 't', seq: 1 });
  const two = fromFrame({ type: 'tool_use', id: 'c2', name: 'get_record' }, { taskId: 't', seq: 2 });
  assert.equal(dedupe([one, two, one, two, one, two]).length, 2);
});

test('X8 — dedupe keeps FIRST-APPEARANCE order, so a finishing tool does not jump', () => {
  const a = fromFrame({ type: 'tool_use', id: 'a', name: 'first' }, { taskId: 't', seq: 1 });
  const b = fromFrame({ type: 'tool_use', id: 'b', name: 'second' }, { taskId: 't', seq: 2 });
  const aDone = fromFrame({ type: 'tool_result', id: 'a', name: 'first' }, { taskId: 't', seq: 3 });
  const rows = dedupe([a, b, aDone]);
  assert.deepEqual(rows.map((r) => r.title), ['first', 'second']);
  assert.equal(rows[0].status, ACTIVITY_STATUS.COMPLETED);
});

/* ================================================================== *
 * §12/§13 — status
 * ================================================================== */

test('X9 — no task at all is IDLE, never THINKING', () => {
  assert.equal(agentStatus(null), AGENT_STATUS.IDLE);
  assert.equal(agentStatus(undefined, []), AGENT_STATUS.IDLE);
});

test('X10 — a running turn with nothing more specific is THINKING', () => {
  assert.equal(agentStatus({ state: 'running' }, []), AGENT_STATUS.THINKING);
});

test('X11 — §13: WAITING_FOR_APPROVAL outranks EXECUTING', () => {
  /*
   * A turn executing a tool while a card is on screen is WAITING: what a person
   * needs to know is that the agent is waiting on THEM. The reverse ordering
   * would hide the card behind whichever frame arrived last.
   */
  const s = agentStatus(
    { state: 'awaiting_approval', plan_state: 'executing' },
    [{ state: 'executing' }],
  );
  assert.equal(s, AGENT_STATUS.WAITING_FOR_APPROVAL);
  assert.ok(
    STATUS_PRECEDENCE.indexOf(AGENT_STATUS.WAITING_FOR_APPROVAL) < STATUS_PRECEDENCE.indexOf(AGENT_STATUS.EXECUTING),
    'the declared precedence disagrees with the derivation',
  );
});

test('X12 — a TERMINAL task ignores a stale step row left by a dead process', () => {
  /*
   * A crashed process leaves `executing` behind. The task row is the authority
   * on whether the task ended.
   */
  assert.equal(agentStatus({ state: 'completed' }, [{ state: 'executing' }]), AGENT_STATUS.COMPLETED);
  assert.equal(agentStatus({ state: 'failed' }, [{ state: 'verifying' }]), AGENT_STATUS.FAILED);
  assert.equal(agentStatus({ state: 'cancelled' }, [{ state: 'executing' }]), AGENT_STATUS.CANCELLED);
});

test('X13 — a terminal task ignores live HINTS too', () => {
  assert.equal(
    agentStatus({ state: 'completed' }, [], { awaitingUser: true, recovering: true }),
    AGENT_STATUS.COMPLETED,
  );
});

test('X14 — §49: waiting is never working', () => {
  for (const s of [AGENT_STATUS.WAITING_FOR_APPROVAL, AGENT_STATUS.WAITING_FOR_USER, AGENT_STATUS.WAITING_FOR_SYSTEM, AGENT_STATUS.BLOCKED]) {
    assert.equal(isWaiting(s), true, `${s} is not marked as waiting`);
    assert.equal(isWorking(s), false, `${s} would animate a spinner`);
  }
  for (const s of [AGENT_STATUS.THINKING, AGENT_STATUS.PLANNING, AGENT_STATUS.EXECUTING, AGENT_STATUS.VERIFYING, AGENT_STATUS.RECOVERING]) {
    assert.equal(isWorking(s), true, `${s} should be working`);
  }
  /* And a terminal state is neither. */
  for (const s of [AGENT_STATUS.COMPLETED, AGENT_STATUS.FAILED, AGENT_STATUS.CANCELLED, AGENT_STATUS.IDLE]) {
    assert.equal(isWorking(s), false);
    assert.equal(isWaiting(s), false);
  }
});

test('X15 — every status the derivation can return is in the precedence list', () => {
  for (const s of Object.values(AGENT_STATUS)) {
    assert.ok(STATUS_PRECEDENCE.includes(s), `${s} has no declared precedence and could never win a comparison`);
  }
});

/* ================================================================== *
 * §58 — reconstruction from the database alone
 * ================================================================== */

function taskWithWork(sessionId, { tools = [], state = 'completed' } = {}) {
  const task = createTask({ sessionId, goal: 'assign INC0010038' });
  startTask(task.id);
  const step = createStep({ taskId: task.id, kind: 'turn', description: 'One agent turn' });
  startStep(step.id);
  for (const t of tools) {
    recordToolEvent(sessionId, { ...t, taskId: task.id });
  }
  if (state === 'completed') { completeStep(step.id); completeTask(task.id); }
  if (state === 'failed') failTask(task.id, 'the provider fell over');
  if (state === 'cancelled') cancelTask(task.id);
  if (state === 'awaiting_approval') markTaskAwaitingApproval(task.id);
  return task;
}

test('X16 — a task rebuilds from the tables with no stream and no process', () => {
  const sid = newSession();
  const task = taskWithWork(sid, {
    tools: [
      { kind: 'tool_call', name: 'query_records', payload: { table: 'incident' }, resultStatus: 'ok', mutating: false },
      { kind: 'tool_call', name: 'update_record', payload: { table: 'incident', sys_id: 'abc' }, resultStatus: 'ok', mutating: true, approval: 'approved', approvedSource: 'user_click' },
    ],
  });

  const a = activityForTask(task.id);
  assert.ok(a, 'the task did not project');
  assert.equal(a.task_id, task.id);
  assert.equal(a.status, AGENT_STATUS.COMPLETED);
  const titles = a.events.map((e) => e.title);
  assert.ok(titles.includes('query_records'), 'a tool this task ran is missing from its timeline');
  assert.ok(titles.includes('update_record'));
  assert.ok(titles.includes('Task started'));
  assert.ok(titles.includes('Task completed'));
});

test('X17 — a task that does not exist is NULL, not an empty timeline', () => {
  /* "This task did nothing" and "there is no such task" must not render alike. */
  assert.equal(activityForTask('no-such-task'), null);
  assert.equal(activityForTask(''), null);
});

test('X18 — the projection is IDEMPOTENT: two reads produce identical timelines', () => {
  const sid = newSession();
  const task = taskWithWork(sid, {
    tools: [{ kind: 'tool_call', name: 'get_record', payload: { table: 'incident' }, resultStatus: 'ok', mutating: false }],
  });
  const one = activityForTask(task.id);
  const two = activityForTask(task.id);
  assert.deepEqual(one.events.map((e) => e.id), two.events.map((e) => e.id));
  assert.deepEqual(one.events.map((e) => e.seq), two.events.map((e) => e.seq));
  assert.equal(one.cursor, two.cursor);
  /* And a re-dedupe of the same list changes nothing (§11). */
  assert.equal(dedupe([...one.events, ...two.events]).length, one.events.length);
});

test('X19 — §10: `since` returns only what came after, and the cursor advances', () => {
  const sid = newSession();
  const task = taskWithWork(sid, {
    tools: [
      { kind: 'tool_call', name: 'a', resultStatus: 'ok', mutating: false },
      { kind: 'tool_call', name: 'b', resultStatus: 'ok', mutating: false },
      { kind: 'tool_call', name: 'c', resultStatus: 'ok', mutating: false },
    ],
  });
  const all = activityForTask(task.id);
  assert.ok(all.total >= 4);

  const mid = Math.floor(all.cursor / 2);
  const tail = activityForTask(task.id, { since: mid });
  assert.ok(tail.events.length < all.events.length, 'since returned everything');
  assert.ok(tail.events.every((e) => e.seq > mid), 'since returned an event at or before the cursor');
  /* Asking from the very end returns nothing, and that is not an error. */
  assert.equal(activityForTask(task.id, { since: all.cursor }).events.length, 0);
});

test('X20 — a FAILED task carries its own reason, copied not classified', () => {
  const sid = newSession();
  const task = taskWithWork(sid, { state: 'failed' });
  const a = activityForTask(task.id);
  assert.equal(a.status, AGENT_STATUS.FAILED);
  assert.equal(a.failure_reason, 'the provider fell over');
  const end = a.events.find((e) => e.id.endsWith(':end'));
  assert.equal(end.status, ACTIVITY_STATUS.FAILED);
  assert.equal(end.summary, 'the provider fell over');
});

test('X21 — a task still RUNNING has no terminal event at all', () => {
  const sid = newSession();
  const task = createTask({ sessionId: sid, goal: 'still going' });
  startTask(task.id);
  const a = activityForTask(task.id);
  assert.ok(!a.events.some((e) => e.id.endsWith(':end')), 'a running task was given an ending');
  assert.equal(a.completed_at, null);
  assert.equal(a.status, AGENT_STATUS.THINKING);
});

/* ================================================================== *
 * §8/§59 — honesty and secrets
 * ================================================================== */

test('X22 — a tool row correlated by TIME WINDOW is marked, never presented as exact', () => {
  const sid = newSession();
  const task = createTask({ sessionId: sid, goal: 'g' });
  startTask(task.id);
  /* No taskId on the row: this is the ordinary-turn case migration 23 left NULL. */
  recordToolEvent(sid, { kind: 'tool_call', name: 'query_records', resultStatus: 'ok', mutating: false });
  completeTask(task.id);

  const a = activityForTask(task.id);
  const row = a.events.find((e) => e.title === 'query_records');
  assert.ok(row, 'a windowed row was dropped entirely');
  assert.equal(row.metadata.exact, false, 'a correlated row claimed to be exact');
});

test('X23 — §59: a credential in a tool payload never reaches the timeline', () => {
  const sid = newSession();
  const task = createTask({ sessionId: sid, goal: 'g' });
  startTask(task.id);
  recordToolEvent(sid, {
    kind: 'tool_call',
    name: 'create_record',
    payload: { table: 'sys_user', fields: { user_name: 'abel', user_password: 'hunter2', api_key: 'sk-live-xyz' } },
    resultStatus: 'ok',
    mutating: true,
    taskId: task.id,
  });
  completeTask(task.id);

  const a = activityForTask(task.id);
  const blob = JSON.stringify(a);
  assert.ok(!blob.includes('hunter2'), 'a password reached the activity timeline');
  assert.ok(!blob.includes('sk-live-xyz'), 'an API key reached the activity timeline');
  assert.match(blob, /redacted/, 'the payload was dropped rather than redacted');
  /* The non-secret half survives, or the panel would be useless. */
  assert.ok(blob.includes('abel'));
});

test('X24 — a step with NO recorded verification produces no verification event', () => {
  /*
   * §79.3 as an absence. There is no code path that can emit "verified" for a
   * step nothing verified, because the event is built from the stored verdict.
   */
  const sid = newSession();
  const task = taskWithWork(sid, {});
  const a = activityForTask(task.id);
  assert.equal(a.events.filter((e) => e.type === ACTIVITY_TYPE.VERIFICATION).length, 0);
});

test('X25 — a recorded verdict of "unverified" renders as failed, never as done', () => {
  const sid = newSession();
  const task = createTask({ sessionId: sid, goal: 'g' });
  startTask(task.id);
  const step = createStep({ taskId: task.id, kind: 'turn', description: 'wrote something' });
  getDb().prepare('UPDATE agent_task_steps SET verification_json = ? WHERE id = ?')
    .run(JSON.stringify({ status: 'unverified', strategy: 'read_back' }), step.id);
  completeStep(step.id);
  completeTask(task.id);

  const a = activityForTask(task.id);
  const v = a.events.find((e) => e.type === ACTIVITY_TYPE.VERIFICATION);
  assert.ok(v, 'a recorded verdict produced no event');
  assert.equal(v.status, ACTIVITY_STATUS.FAILED);
  assert.match(v.title, /unverified/);
});

/* ================================================================== *
 * §51/§52 — history
 * ================================================================== */

test('X26 — history lists a session\'s tasks newest first, with derived status', () => {
  const sid = newSession();
  taskWithWork(sid, { state: 'failed' });
  const second = taskWithWork(sid, { state: 'completed' });

  const rows = taskHistory(sid);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].task_id, second.id, 'history is not newest-first');
  assert.equal(rows[0].status, AGENT_STATUS.COMPLETED);
  assert.equal(rows[1].status, AGENT_STATUS.FAILED);
  /* No events: a list of a dozen lines must not read a thousand rows. */
  assert.ok(!('events' in rows[0]));
});

test('X27 — history for a session with no tasks is empty, not an error', () => {
  assert.deepEqual(taskHistory(newSession()), []);
  assert.deepEqual(taskHistory('never-existed'), []);
});

test('X28 — statusForTask answers cheaply, and IDLE for a task that is not there', () => {
  const sid = newSession();
  const task = taskWithWork(sid, {});
  assert.equal(statusForTask(task.id).status, AGENT_STATUS.COMPLETED);
  assert.equal(statusForTask('nope').status, AGENT_STATUS.IDLE);
  assert.equal(statusForTask(null).status, AGENT_STATUS.IDLE);
});

test('X29 — planProgress counts, and counts nothing it was not given', () => {
  const p = planProgress([
    { state: 'completed' }, { state: 'completed' }, { state: 'executing' },
    { state: 'pending' }, { state: 'failed' }, { state: 'awaiting_approval' },
  ]);
  assert.deepEqual(p, {
    total: 6, completed: 2, running: 1, queued: 1, failed: 1, skipped: 0, awaiting_approval: 1,
  });
  assert.deepEqual(planProgress([]), {
    total: 0, completed: 0, running: 0, queued: 0, failed: 0, skipped: 0, awaiting_approval: 0,
  });
});

/* ================================================================== *
 * §44 — the skill snapshot travels with the task
 * ================================================================== */

test('X30 — a task reports the skills IT recorded, not the registry\'s current answer', () => {
  const sid = newSession();
  const task = createTask({
    sessionId: sid,
    goal: 'g',
    metadata: { skills: [{ identity: 'doctor@1.0.0', id: 'doctor', version: '1.0.0', name: 'Doctor' }] },
  });
  startTask(task.id);
  completeTask(task.id);

  const a = activityForTask(task.id);
  assert.equal(a.skills.length, 1);
  assert.equal(a.skills[0].identity, 'doctor@1.0.0');
  assert.equal(taskHistory(sid)[0].skills[0].id, 'doctor');
});

test('X31 — a task that recorded no skills reports none, rather than inventing the default', () => {
  const sid = newSession();
  const task = createTask({ sessionId: sid, goal: 'g' });
  startTask(task.id);
  assert.deepEqual(activityForTask(task.id).skills, []);
});

/* ================================================================== *
 * Frame coverage — the guard that keeps this map from going stale
 * ================================================================== */

test('X32 — every ACTIVITY frame produces a well-formed row for a bare frame', () => {
  /*
   * Called with nothing but its own type. A descriptor that needed a field the
   * frame might not carry would throw or produce `undefined` in a title, and
   * either would reach the browser.
   */
  for (const type of ACTIVITY_FRAMES) {
    const row = fromFrame({ type }, { taskId: 't', seq: 1 });
    assert.ok(row, `${type} produced no row from a bare frame`);
    assert.ok(row.title && !row.title.includes('undefined'), `${type} produced the title "${row.title}"`);
    assert.ok(Object.values(ACTIVITY_STATUS).includes(row.status), `${type} produced status "${row.status}"`);
    assert.ok(Object.values(ACTIVITY_TYPE).includes(row.type), `${type} produced type "${row.type}"`);
  }
});
