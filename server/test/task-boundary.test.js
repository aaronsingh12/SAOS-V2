import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  BOUNDARY, classifyTaskBoundary, boundaryQuestion, isAffirmative, isNegative, significantTokens,
} from '../src/agent/task-boundary.js';
import { _setDbForTests, migrate, getDb } from '../src/memory/db.js';
import { createSession } from '../src/memory/sessions.js';

/**
 * B4 / D3 — task-boundary continuity.
 *
 * The asymmetry is the design, so it is also the test plan: only
 * `clearly_continuing` proceeds silently, so only `clearly_continuing` needs to
 * be hard to reach. Confusing `clearly_new` with `ambiguous` changes the wording
 * of a question and nothing else, and these tests deliberately do not pin that
 * distinction tightly.
 */

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-b4-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const TARGET = { sys_id: '555a640583fe0f10b939cc65eeaad3a2', user_name: 'aagamya.tanwar', display: 'Aagamya Tanwar' };
const TASK = 'check what Aagamya can see on the Laptop Request catalog item';

const verdictOf = (userText, task = TASK) => classifyTaskBoundary({ task, userText, target: TARGET }).verdict;

/* ------------------------------------------------------------------ *
 * The dangerous verdict — reaching it requires evidence
 * ------------------------------------------------------------------ */

test('a follow-up that introduces nothing new continues', () => {
  for (const t of ['and the catalog item?', 'can she see it?', 'what about the laptop request?']) {
    assert.equal(verdictOf(t), BOUNDARY.CONTINUING, t);
  }
});

test('a follow-up that names something NEW asks once, then converges', () => {
  // "variables" is not in the descriptor and the classifier has no domain
  // knowledge saying a catalog item HAS variables. It asks rather than assumes,
  // which is the design working: one confirmation extends the task and the
  // question does not come back. Noisier than a model call, and it still holds
  // on the day the weekly model cap runs out.
  const r = classifyTaskBoundary({ task: TASK, userText: 'what about the other variables?', target: TARGET });
  assert.equal(r.verdict, BOUNDARY.AMBIGUOUS);
  assert.deepEqual(r.evidence.novel, ['variables']);
});

test('sharing two points of contact with the task continues', () => {
  assert.equal(verdictOf('does the laptop request item show the shipping variable for her?'), BOUNDARY.CONTINUING);
  assert.equal(verdictOf('check the catalog item variables Aagamya sees'), BOUNDARY.CONTINUING);
});

test('naming the impersonated user is ONE point of contact, never enough alone', () => {
  // Everything about this is Aagamya, and none of it is the task.
  const r = classifyTaskBoundary({ task: TASK, userText: 'what is aagamya home phone number', target: TARGET });
  assert.notEqual(r.verdict, BOUNDARY.CONTINUING, 'a name match must not carry a request on its own');
  assert.equal(r.evidence.mentionsTarget, true);
  // The name is in the descriptor too, so it must be discounted from the
  // overlap — otherwise it scores twice and this reads as a continuation.
  assert.deepEqual(r.evidence.independentOverlap, []);
});

test('an unrelated request does not continue', () => {
  for (const t of [
    'create a change request for the mail server upgrade',
    'how many open problems are assigned to the network group',
    'deploy the vendor hold flow',
  ]) {
    assert.notEqual(verdictOf(t), BOUNDARY.CONTINUING, t);
  }
});

test('an announced topic change never continues, however much vocabulary it shares', () => {
  const r = classifyTaskBoundary({
    task: TASK,
    userText: 'unrelated — can you check the laptop request catalog item variables for me',
    target: TARGET,
  });
  assert.equal(r.verdict, BOUNDARY.NEW);
  assert.equal(r.reason, 'explicit-topic-change');
});

test('THE FENCE — a destructive verb the task never mentioned can never continue silently', () => {
  // Shares every content word with the task, and is nothing like it.
  const r = classifyTaskBoundary({
    task: TASK,
    userText: 'delete the Laptop Request catalog item that Aagamya can see',
    target: TARGET,
  });
  assert.equal(r.verdict, BOUNDARY.AMBIGUOUS);
  assert.equal(r.reason, 'destructive-verb-outside-task');
  assert.equal(r.evidence.destructive, true);
});

test('a destructive verb the task DID mention is not fenced by this rule', () => {
  const r = classifyTaskBoundary({
    task: 'delete the obsolete Laptop Request catalog items',
    userText: 'delete the laptop request item now',
    target: TARGET,
  });
  assert.equal(r.verdict, BOUNDARY.CONTINUING, 'the fence must not block the task it was started for');
});

test('an empty or missing task descriptor asks rather than guesses', () => {
  assert.equal(classifyTaskBoundary({ task: '', userText: 'check the item', target: TARGET }).verdict, BOUNDARY.AMBIGUOUS);
  assert.equal(classifyTaskBoundary({ task: TASK, userText: '  ', target: TARGET }).verdict, BOUNDARY.AMBIGUOUS);
});

test('talking about impersonation itself is an identity command, not a boundary question', () => {
  for (const t of ['stop impersonating', 'end the impersonation please', 'go back to admin', 'impersonate someone else']) {
    assert.equal(verdictOf(t), BOUNDARY.IDENTITY_COMMAND, t);
  }
});

test('stopwords alone are never evidence of continuation', () => {
  const tokens = significantTokens('can you please show me the thing that is there');
  for (const w of ['can', 'you', 'please', 'show', 'the', 'that', 'is', 'there']) {
    assert.ok(!tokens.has(w), `"${w}" must not count as topic`);
  }
});

/* ------------------------------------------------------------------ *
 * Answers to a pending question
 * ------------------------------------------------------------------ */

test('affirmative and negative are told apart, including the tricky ones', () => {
  for (const y of ['yes', 'Yes, continue', 'go ahead', 'sure', 'continue as her', 'keep going', 'ok']) {
    assert.ok(isAffirmative(y), y);
    assert.ok(!isNegative(y), y);
  }
  for (const n of ['no', 'No — end impersonation first', 'stop', "don't", 'end the impersonation']) {
    assert.ok(isNegative(n), n);
    assert.ok(!isAffirmative(n), n);
  }
  // A fresh instruction is neither.
  assert.ok(!isAffirmative('create a change request'));
  assert.ok(!isNegative('create a change request'));
});

test('the question names the target, the task and the request, and offers both ways out', () => {
  const q = boundaryQuestion({
    target: TARGET, task: TASK, userText: 'create a change request for the mail server', verdict: BOUNDARY.NEW,
  });
  assert.match(q, /aagamya\.tanwar/);
  assert.match(q, /Laptop Request/);
  assert.match(q, /change request for the mail server/);
  assert.match(q, /continue as/i);
  assert.match(q, /end impersonation/i);
  // It must say why it is worth answering.
  assert.match(q, /instance keeps no\s+record of who really asked/);
});

/* ------------------------------------------------------------------ *
 * The turn-start contract
 * ------------------------------------------------------------------ */

const clientMod = await import('../src/servicenow/client.js');
clientMod.table.query = async () => [];

const { checkTaskBoundary } = await import('../src/agent/impersonation-ops.js');
const {
  startMode, getMode, getPendingBoundary,
} = await import('../src/memory/impersonation-mode.js');

let n = 0;
function impersonatingSession(task = TASK) {
  const id = `b4-${++n}`;
  createSession({ id, title: 'b4' });
  startMode({
    sessionId: id,
    target: TARGET,
    original: { sys_id: '6816f79cc0a8016401c5a33be04be441', user_name: 'admin' },
    task,
  });
  return id;
}

test('migration 11 adds the pending-question columns', () => {
  const cols = getDb().prepare('PRAGMA table_info(impersonation_mode)').all().map((c) => c.name);
  assert.ok(cols.includes('pending_request'));
  assert.ok(cols.includes('pending_asked_at'));
});

test('the check is inert when nothing is being impersonated', () => {
  const id = 'b4-plain';
  createSession({ id, title: 'plain' });
  const r = checkTaskBoundary({ sessionId: id, userText: 'delete every incident' });
  assert.equal(r.stop, false);
  assert.equal(r.verdict, 'not_impersonating');
});

test('a continuing turn proceeds and records no pending question', () => {
  const s = impersonatingSession();
  const r = checkTaskBoundary({ sessionId: s, userText: 'and the catalog item?' });
  assert.equal(r.stop, false);
  assert.equal(r.verdict, BOUNDARY.CONTINUING);
  assert.equal(getPendingBoundary(s), null);
});

test('an unrelated turn STOPS, asks, and remembers what it asked about', () => {
  const s = impersonatingSession();
  const r = checkTaskBoundary({ sessionId: s, userText: 'create a change request for the mail server upgrade' });
  assert.equal(r.stop, true);
  assert.ok(r.question.includes('aagamya.tanwar'));
  assert.equal(getPendingBoundary(s).request, 'create a change request for the mail server upgrade');
  // Stopping must not silently alter identity.
  assert.equal(getMode(s).target.user_name, 'aagamya.tanwar');
  assert.equal(getMode(s).active, true);
});

test('an ambiguous turn stops too — anything short of clearly_continuing asks', () => {
  const s = impersonatingSession();
  const r = checkTaskBoundary({ sessionId: s, userText: 'delete the laptop request item Aagamya sees' });
  assert.equal(r.stop, true);
  assert.equal(r.verdict, BOUNDARY.AMBIGUOUS);
});

test('saying yes consents, EXTENDS the task, and is not asked again', () => {
  const s = impersonatingSession();
  const request = 'create a change request for the mail server upgrade';
  assert.equal(checkTaskBoundary({ sessionId: s, userText: request }).stop, true);

  const yes = checkTaskBoundary({ sessionId: s, userText: 'yes, continue as her' });
  assert.equal(yes.stop, false);
  assert.equal(yes.verdict, 'consented');
  assert.equal(getPendingBoundary(s), null);

  // The descriptor now COVERS the request, and still shows the original intent.
  const task = getMode(s).task;
  assert.match(task, /Laptop Request/, 'the original task must stay visible');
  assert.match(task, /mail server upgrade/, 'the consented request must now be in scope');

  // And the same request no longer stops the turn.
  assert.equal(checkTaskBoundary({ sessionId: s, userText: request }).stop, false);
});

test('saying no clears the question and tells the caller to end impersonation', () => {
  const s = impersonatingSession();
  checkTaskBoundary({ sessionId: s, userText: 'create a change request for the mail server upgrade' });
  const no = checkTaskBoundary({ sessionId: s, userText: 'no, end impersonation first' });
  assert.equal(no.stop, false);
  assert.equal(no.verdict, 'declined');
  assert.equal(getPendingBoundary(s), null);
  assert.match(no.note, /impersonation_end/);
  // Declining does not itself change identity — the tool does that.
  assert.equal(getMode(s).active, true);
});

test('a third, different request while a question is pending re-asks about the NEW one', () => {
  const s = impersonatingSession();
  checkTaskBoundary({ sessionId: s, userText: 'create a change request for the mail server upgrade' });
  const r = checkTaskBoundary({ sessionId: s, userText: 'how many problems does the network group own' });
  assert.equal(r.stop, true);
  assert.equal(getPendingBoundary(s).request, 'how many problems does the network group own',
    'the stale question must not outlive the request that caused it');
});

test('consent extends the task without ever changing the target', () => {
  const s = impersonatingSession();
  const before = getMode(s).target;
  checkTaskBoundary({ sessionId: s, userText: 'create a change request for the mail server upgrade' });
  checkTaskBoundary({ sessionId: s, userText: 'yes' });
  assert.deepEqual(getMode(s).target, before, 'nothing in the boundary path may re-target impersonation');
});
