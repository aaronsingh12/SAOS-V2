import test from 'node:test';
import assert from 'node:assert/strict';

import { DatabaseSync } from 'node:sqlite';

import { getDb, _setDbForTests, migrate } from '../src/memory/db.js';
import { createSession, deleteSession, deleteAllSessions, appendMessage, recordToolEvent, loadToolEvents } from '../src/memory/sessions.js';
import { appendMutation, mutationsForSession } from '../src/memory/ledger.js';
import { _setSettingsForTests } from '../src/config/store.js';

/*
 * THE BOUNDARY: deleting chats removes conversation history and NOTHING ELSE.
 *
 * `tool_events` and `sysid_provenance` used to carry `ON DELETE CASCADE` on
 * `sessions`, with foreign keys ON — so deleting a chat destroyed the record of
 * what that chat DID to a live ServiceNow instance. `tool_events`' own schema
 * comment said it "must never be rewritten"; the constraint said otherwise, and
 * the constraint won.
 *
 * Nothing had exercised it, because sessions were only ever deleted one at a
 * time. A "delete all chats" button would have turned that into a one-click
 * audit wipe. Migration 14 split them; these tests are what stops the split
 * being quietly undone.
 */

test.beforeEach(() => {
  // A scratch database built through the REAL migrations, exactly as the other
  // storage tests do — asserting against a hand-built replica would prove
  // nothing about migration 14.
  _setDbForTests(migrate(new DatabaseSync(':memory:')));
  // The ledger stamps rows with the bound instance; pin one so the reads match.
  _setSettingsForTests({ connection: { instanceUrl: 'https://dev000000.service-now.com', username: 'admin', password: 'x' } });
});
test.afterEach(() => { _setDbForTests(null); _setSettingsForTests(null); });

function seed(sessionId) {
  createSession({ id: sessionId, title: 'a chat' });
  appendMessage(sessionId, { role: 'user', text: 'change the caller' });
  recordToolEvent(sessionId, { seq: 1, kind: 'tool', name: 'dba_set_field_value', mutating: 1, approval: 'approved', resultStatus: 'applied', ts: new Date().toISOString() });
  appendMutation({
    sessionId, turnSeq: 1, tool: 'dba:set_field_value',
    descriptor: { table: 'incident', sys_id: 'abc', requested: { why: 'test' } },
    result: { sys_id: 'abc' },
    verification: { status: 'applied' },
    approval: 'approved',
  });
}

const count = (t) => getDb().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

/* ── the schema itself ────────────────────────────────────────────────────── */

test('the audit tables do NOT cascade from sessions', () => {
  const fks = (t) => getDb().prepare(`PRAGMA foreign_key_list(${t})`).all();
  for (const t of ['tool_events', 'sysid_provenance']) {
    const toSessions = fks(t).filter((f) => f.table === 'sessions');
    assert.deepEqual(toSessions, [], `${t} must not have a foreign key to sessions — a chat delete would take it`);
  }
  // mutation_ledger never had one; assert it stays that way.
  assert.deepEqual(getDb().prepare('PRAGMA foreign_key_list(mutation_ledger)').all(), []);
});

test('conversation tables DO cascade — the transcript is meant to go', () => {
  const fks = (t) => getDb().prepare(`PRAGMA foreign_key_list(${t})`).all().filter((f) => f.table === 'sessions');
  for (const t of ['messages', 'digests']) {
    assert.equal(fks(t).length, 1, `${t} should cascade from sessions`);
    assert.equal(fks(t)[0].on_delete, 'CASCADE');
  }
});

/* ── the behaviour ────────────────────────────────────────────────────────── */

test('deleting ONE chat keeps its audit trail', () => {
  seed('s1');
  assert.equal(count('mutation_ledger'), 1);
  assert.equal(count('tool_events'), 1);

  deleteSession('s1');

  assert.equal(count('sessions'), 0, 'the chat should be gone');
  assert.equal(count('messages'), 0, 'the transcript should be gone');
  assert.equal(count('mutation_ledger'), 1, 'THE AUDIT LEDGER MUST SURVIVE');
  assert.equal(count('tool_events'), 1, 'tool events must survive');
});

test('deleting ALL chats keeps every audit row — the acceptance', () => {
  seed('s1');
  seed('s2');
  assert.equal(count('sessions'), 2);
  assert.equal(count('mutation_ledger'), 2);

  const res = deleteAllSessions();

  assert.equal(res.deleted, 2);
  assert.equal(count('sessions'), 0);
  assert.equal(count('messages'), 0);
  assert.equal(count('chunks'), 0, 'the message search index goes with the chats');
  assert.equal(count('mutation_ledger'), 2, 'THE AUDIT LEDGER MUST SURVIVE A FULL WIPE');
  assert.equal(count('tool_events'), 2);
  assert.equal(res.auditPreserved, true);
});

test('a recorded mutation is still readable after every chat is deleted', () => {
  // The acceptance as a person would check it: the record of what was changed
  // on the instance is still there, and still says what it said.
  seed('s1');
  deleteAllSessions();
  const rows = mutationsForSession('s1', { limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, 'dba:set_field_value');
  assert.equal(rows[0].table, 'incident');
  assert.equal(rows[0].status, 'applied');
  // And the tool event that produced it.
  assert.equal(loadToolEvents('s1').length, 1);
});

test('the result reports counts rather than asserting success', () => {
  seed('s1');
  const res = deleteAllSessions();
  assert.equal(res.before.mutationLedger, 1);
  assert.equal(res.after.mutationLedger, 1);
  assert.equal(res.before.sessions, 1);
  assert.equal(res.after.sessions, 0);
});

test('deleting chats when there are none is harmless', () => {
  const res = deleteAllSessions();
  assert.equal(res.deleted, 0);
  assert.equal(res.auditPreserved, true);
});

test('the knowledge ledger and instance facts are not chat history', () => {
  seed('s1');
  const before = count('facts');
  deleteAllSessions();
  assert.equal(count('facts'), before, 'facts are instance knowledge, not conversation');
});
