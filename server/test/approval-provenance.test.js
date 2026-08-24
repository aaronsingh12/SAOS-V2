/**
 * WI-4 — where an approval came from, recorded rather than assumed.
 *
 *   node --test server/test/
 *
 * THE DEFECT. Investigating 2026-08-24 stopped at a question the database could
 * not answer. An `update_record` executed with `approval = 'approved'` while the
 * Auto-approve checkbox was off, and nothing anywhere said who resolved it or
 * when: approval state lived as an unresolved Promise in a process-local Map and
 * collapsed into one terminal string at execution time. "A user clicked it" was
 * the likeliest explanation and stayed unprovable.
 *
 * Two halves here. `approved_source` / `approved_at` are persisted on both
 * durable records, and the executor REFUSES a mutation whose approval cannot be
 * attributed — so an unattributable approval is a loud failure rather than a row
 * nobody can interpret a month later.
 *
 * The executor half is asserted in renderer-status.test.js beside the rest of
 * the gate audit. This file covers persistence, the migration, and the rendered
 * line. Fully offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-prov-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { _setChatTurnForTests } = await import('../src/agent/providers/index.js');
const { runTurn, resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { appendMutation, mutationsForTurn, approvalLine } = await import('../src/memory/ledger.js');
const { createSession, recordToolEvent, loadToolEvents } = await import('../src/memory/sessions.js');

/**
 * One scripted completion, then a plain sign-off.
 *
 * Without the sign-off the loop keeps re-offering the same tool call until it
 * hits the iteration cap — correct behaviour (the rejection registry blocks
 * each resubmission) but thirty rounds of noise around the one assertion.
 */
function scriptOnce(first) {
  let n = 0;
  _setChatTurnForTests(async () => (n++ === 0 ? first : { text: 'Nothing was changed.', toolCalls: [], stopReason: 'stop' }));
}

/* ------------------------------------------------------------------ *
 * Persistence — both durable records carry it
 * ------------------------------------------------------------------ */

test('the mutation ledger stores the source and the moment of the decision', () => {
  const session = 'prov-ledger';
  createSession({ id: session });
  appendMutation({
    sessionId: session, turnSeq: 1, tool: 'update_record',
    descriptor: { table: 'incident', sys_id: 'abc', requested: { priority: '4' } },
    result: { number: 'INC0010053' },
    verification: { status: 'applied' },
    approval: 'approved',
    approvedSource: APPROVAL_SOURCES.USER_CLICK,
    approvedAt: '2026-08-24T09:48:40.123Z',
  });
  const [row] = mutationsForTurn(session, 1);
  assert.equal(row.approval, 'approved');
  assert.equal(row.approvedSource, 'user_click');
  assert.equal(row.approvedAt, '2026-08-24T09:48:40.123Z');
});

test('an approval with no stated source is stored as unknown, never guessed', () => {
  // The write succeeding is not evidence that a person approved it. That
  // inference is the whole failure class, so the absent case is named.
  const session = 'prov-unknown';
  createSession({ id: session });
  appendMutation({
    sessionId: session, turnSeq: 1, tool: 'create_record',
    descriptor: { table: 'incident', requested: {} },
    result: { number: 'INC0010060' },
    verification: { status: 'applied' },
    approval: 'approved',
  });
  assert.equal(mutationsForTurn(session, 1)[0].approvedSource, 'unknown');
});

test('a row with no approval at all keeps a null source — reads are not approvals', () => {
  const session = 'prov-null';
  createSession({ id: session });
  recordToolEvent(session, { kind: 'tool_call', name: 'query_records', mutating: false, approval: null });
  assert.equal(loadToolEvents(session)[0].approved_source, null);
});

test('the audit trail carries it too — that is the table WI-1 had to read', () => {
  const session = 'prov-events';
  createSession({ id: session });
  recordToolEvent(session, {
    kind: 'tool_call', name: 'update_record', mutating: true, approval: 'approved',
    approvedSource: APPROVAL_SOURCES.USER_CLICK, approvedAt: '2026-08-24T09:48:40.123Z',
  });
  const [row] = loadToolEvents(session);
  assert.equal(row.approved_source, 'user_click');
  assert.equal(row.approved_at, '2026-08-24T09:48:40.123Z');
});

/* ------------------------------------------------------------------ *
 * The migration
 * ------------------------------------------------------------------ */

test('migration 8 adds the columns and backfills existing rows to "unknown"', () => {
  /*
   * Built at version 7 and migrated forward, so this exercises the real
   * MIGRATIONS[7] rather than a replica of it. Every existing row predates the
   * column, so any value other than 'unknown' would be a guess presented as a
   * record.
   */
  const db = new DatabaseSync(path.join(scratchDir, 'v7.db'));
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, instance TEXT);
    CREATE TABLE tool_events (
      session TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT, payload TEXT,
      result_status TEXT, mutating INTEGER NOT NULL DEFAULT 0, approval TEXT, ts TEXT NOT NULL,
      result TEXT, actor TEXT, instance TEXT, PRIMARY KEY (session, seq));
    CREATE TABLE mutation_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, turn_seq INTEGER NOT NULL, ts TEXT NOT NULL,
      tool TEXT NOT NULL, table_name TEXT, sys_id TEXT, display_id TEXT, requested TEXT, verification TEXT,
      status TEXT NOT NULL, approval TEXT, capture TEXT, instance TEXT, actor TEXT);
    PRAGMA user_version = 7;
  `);
  // The incident's own row, as it exists today.
  db.prepare(`INSERT INTO mutation_ledger (session, turn_seq, ts, tool, table_name, sys_id, status, approval)
              VALUES ('092d3c66', 50, '2026-08-24T09:48:47.067Z', 'update_record', 'incident', '49b1d053', 'transformed', 'approved')`).run();
  db.prepare(`INSERT INTO tool_events (session, seq, kind, name, mutating, approval, ts)
              VALUES ('092d3c66', 19, 'tool_call', 'update_record', 1, 'approved', '2026-08-24T09:48:47.066Z')`).run();
  // And a read, which was never approved and must not acquire a source.
  db.prepare(`INSERT INTO tool_events (session, seq, kind, name, mutating, approval, ts)
              VALUES ('092d3c66', 18, 'guard', 'a6_stalled_turn', 0, NULL, '2026-08-24T09:48:36.932Z')`).run();

  migrate(db);

  const ledger = db.prepare('SELECT approval, approved_source, approved_at FROM mutation_ledger').get();
  assert.equal(ledger.approval, 'approved');
  assert.equal(ledger.approved_source, 'unknown', 'an existing approval was backfilled with a guess');
  assert.equal(ledger.approved_at, null, 'a timestamp was invented for a decision nobody recorded');

  const approved = db.prepare("SELECT approved_source FROM tool_events WHERE seq = 19").get();
  assert.equal(approved.approved_source, 'unknown');
  const guard = db.prepare("SELECT approved_source FROM tool_events WHERE seq = 18").get();
  assert.equal(guard.approved_source, null, 'a row with no approval was given a source');

  db.close();
});

/* ------------------------------------------------------------------ *
 * The rendered line
 * ------------------------------------------------------------------ */

test('the turn report states who authorised every mutation, ordinary ones included', () => {
  // It used to speak up only for auto-approve, which made "a human approved
  // this" an inference drawn from silence.
  assert.match(
    approvalLine({ approval: 'approved', approvedSource: 'user_click', approvedAt: '2026-08-24T09:48:40.000Z' }),
    /^approved by you at the gate · 09:48 UTC$/,
  );
  assert.match(approvalLine({ approval: 'auto', approvedSource: 'auto_approve' }), /^ran under auto-approve/);
  assert.match(approvalLine({ approval: 'approved', approvedSource: 'unknown' }), /source was never recorded \(unknown\)/);
  assert.equal(approvalLine({ approval: null }), '');
});

test('the clock is stamped UTC, because the session renders local time', () => {
  // An unlabelled HH:MM between a UTC store and a Los Angeles session is a trap
  // this project has already paid for once.
  assert.match(approvalLine({ approval: 'approved', approvedSource: 'user_click', approvedAt: '2026-08-24T09:48:40.000Z' }), /UTC/);
});

/* ------------------------------------------------------------------ *
 * End to end through the real gate
 * ------------------------------------------------------------------ */

test('a decision made at the gate reaches the audit trail with its source', async () => {
  /*
   * Driven through `runTurn` and the real approval promise. REJECTED rather
   * than approved: the rejection path records the same provenance and never
   * reaches the instance, so this stays offline while still proving the wiring
   * from POST-equivalent call to stored row.
   */
  scriptOnce({
    text: 'Setting the priority.',
    toolCalls: [{ id: 'c1', name: 'update_record', input: { table: 'incident', sys_id: 'abc', data: { priority: '4' } } }],
    stopReason: 'stop',
  });
  const session = 'prov-gate';
  const events = [];
  await runTurn(session, 'set the priority', (e) => {
    events.push(e);
    if (e.type === 'approval_required') {
      setImmediate(() => resolveApproval(session, e.approvalId, false, APPROVAL_SOURCES.USER_CLICK));
    }
  });

  const resolved = events.find((e) => e.type === 'approval_resolved');
  assert.equal(resolved.approved, false);
  assert.equal(resolved.source, 'user_click', 'the stream did not carry provenance to the card');
  assert.ok(resolved.at, 'the decision has no timestamp');

  const row = loadToolEvents(session).find((e) => e.name === 'update_record');
  assert.equal(row.approval, 'rejected');
  assert.equal(row.approved_source, 'user_click');
  assert.equal(row.approved_at, resolved.at, 'the stored moment is not the moment that was shown');
  _setChatTurnForTests(null);
});

test('a resolver that cannot identify itself is recorded as unknown, and cannot execute', async () => {
  /*
   * The shape a future caller will have: something resolves an approval without
   * saying what it is. It is stored as `unknown` rather than inheriting
   * `user_click` by default — and `unknown` is exactly the value the executor
   * refuses (renderer-status.test.js), so this cannot become a quiet bypass.
   */
  scriptOnce({
    text: 'Setting the priority.',
    toolCalls: [{ id: 'c1', name: 'update_record', input: { table: 'incident', sys_id: 'abc', data: { priority: '4' } } }],
    stopReason: 'stop',
  });
  const session = 'prov-anon';
  const events = [];
  await runTurn(session, 'set the priority', (e) => {
    events.push(e);
    // No source at all, and then a source outside the vocabulary.
    if (e.type === 'approval_required') setImmediate(() => resolveApproval(session, e.approvalId, false, 'a_cron_job'));
  });

  assert.equal(events.find((x) => x.type === 'approval_resolved').source, 'unknown');
  assert.equal(loadToolEvents(session).find((e) => e.name === 'update_record').approved_source, 'unknown');

  // And a timeout stays outside the vocabulary entirely: it is a refusal nobody
  // made, and must never be filed as one somebody did.
  assert.ok(!Object.values(APPROVAL_SOURCES).includes('timeout'));
  _setChatTurnForTests(null);
});

test.after(() => {
  _setChatTurnForTests(null);
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* windows may hold the file */ }
});
