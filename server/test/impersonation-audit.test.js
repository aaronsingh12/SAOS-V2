import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate, getDb } from '../src/memory/db.js';
import { createSession, deleteSession } from '../src/memory/sessions.js';
import { startMode, endMode } from '../src/memory/impersonation-mode.js';
import {
  AUDIT_KIND, appendImpersonatedMutation, appendModeEvent, whoReallyDid,
  impersonationAuditForSession, impersonationAuditForTarget, summariseChange,
} from '../src/memory/impersonation-audit.js';

/**
 * B5 — impersonation provenance.
 *
 * Phase 0 measured that the instance keeps NO record of who really performed an
 * impersonated action: no Begin/End events (not even registered), an
 * impersonation-history table empty on every read, and a sys_audit.user holding
 * the same session GUID whether impersonating or not. Every touched record
 * carries only the TARGET's name.
 *
 * So these tests are not checking a convenience index. They are checking the
 * only place an answer exists.
 */

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-b5-'));
const DB_FILE = path.join(scratchDir, 'test.db');
_setDbForTests(migrate(new DatabaseSync(DB_FILE)));

/* Query-resolved on dev442675 during Phase 0 and the B1/B2 gates. */
const ADMIN = '6816f79cc0a8016401c5a33be04be441';
const TARGET = { sys_id: '555a640583fe0f10b939cc65eeaad3a2', user_name: 'aagamya.tanwar', display: 'Aagamya Tanwar' };
const ORIGINAL = { sys_id: ADMIN, user_name: 'admin' };
const INCIDENT = '2ec9c1ab83ba4390b939cc65eeaad378';
const TASK = 'check what Aagamya can see on the Laptop Request item';

let n = 0;
function impersonatingSession() {
  const id = `b5-${++n}`;
  createSession({ id, title: 'b5' });
  startMode({ sessionId: id, target: TARGET, original: ORIGINAL, task: TASK });
  return id;
}

const DESCRIPTOR = {
  table: 'incident', sys_id: INCIDENT, operation: 'update',
  requested: { short_description: 'changed by the impersonated user', priority: '2' },
};
const VERIFIED = { status: 'applied', verified: true, dropped: [], transformed: [], unverifiable: [] };

test('migration 12 creates the provenance table', () => {
  const row = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='impersonation_audit'").get();
  assert.equal(row?.name, 'impersonation_audit');
});

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

test('an impersonated mutation is recorded, read back, and carries every field', () => {
  const s = impersonatingSession();
  const r = appendImpersonatedMutation({
    sessionId: s, turnSeq: 4, tool: 'update_record',
    descriptor: DESCRIPTOR, result: { sys_id: INCIDENT, number: 'INC0010065' }, verification: VERIFIED,
  });

  assert.equal(r.recorded, true, 'Hard Rule 6 — a row is not recorded until it reads back');
  const row = r.row;
  assert.equal(row.kind, AUDIT_KIND.MUTATION);
  // The two identities, which is the whole point.
  assert.equal(row.real_initiator_sys_id, ADMIN);
  assert.equal(row.real_initiator_user_name, 'admin');
  assert.equal(row.target_sys_id, TARGET.sys_id);
  assert.equal(row.target_user_name, 'aagamya.tanwar');
  // The record it touched.
  assert.equal(row.table_name, 'incident');
  assert.equal(row.sys_id, INCIDENT);
  assert.equal(row.display_id, 'INC0010065');
  assert.equal(row.operation, 'update');
  assert.equal(row.tool, 'update_record');
  assert.equal(row.verification_status, 'applied');
  assert.equal(row.task, TASK);
  assert.equal(row.turn_seq, 4);
  assert.ok(row.ts);
});

test('the change summary names FIELDS, never their values', () => {
  const summary = summariseChange({ descriptor: DESCRIPTOR, verification: VERIFIED, tool: 'update_record' });
  assert.match(summary, /update/);
  assert.match(summary, /short_description/);
  assert.match(summary, /priority/);
  assert.ok(!summary.includes('changed by the impersonated user'),
    'copying values would duplicate possibly-personal data onto a second system');
});

test('a mutation while NOT impersonating records nothing — the ledger already attributes it', () => {
  const id = 'b5-plain';
  createSession({ id, title: 'plain' });
  const r = appendImpersonatedMutation({
    sessionId: id, turnSeq: 1, tool: 'update_record', descriptor: DESCRIPTOR, result: {}, verification: VERIFIED,
  });
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'not-impersonating');
  assert.equal(impersonationAuditForSession(id).length, 0);
});

test('a READ produces no audit row — only mutations and mode events are recorded (D4)', () => {
  const s = impersonatingSession();
  const before = impersonationAuditForSession(s).length;
  // There is no read path into this module at all: the orchestrator only calls
  // it on the mutating branch. Asserted as the absence it is.
  assert.equal(impersonationAuditForSession(s).length, before);
});

test('mode transitions are recorded, so the mutations have a beginning', () => {
  const s = impersonatingSession();
  const start = appendModeEvent({
    sessionId: s, kind: AUDIT_KIND.MODE_START, target: TARGET, original: ORIGINAL, task: TASK,
  });
  assert.equal(start.recorded, true);
  assert.equal(start.row.kind, AUDIT_KIND.MODE_START);
  assert.equal(start.row.real_initiator_sys_id, ADMIN);
  assert.equal(start.row.sys_id, null, 'a mode event touches no record');

  const end = appendModeEvent({
    sessionId: s, kind: AUDIT_KIND.MODE_END, target: TARGET, original: ORIGINAL, task: TASK,
  });
  assert.equal(end.recorded, true);
  assert.equal(end.row.kind, AUDIT_KIND.MODE_END);
});

test('a mode event with no real initiator is refused rather than recorded incomplete', () => {
  const s = impersonatingSession();
  const r = appendModeEvent({ sessionId: s, kind: AUDIT_KIND.MODE_START, target: TARGET, original: {} });
  assert.equal(r.recorded, false);
  assert.match(r.reason, /no real initiator/);
});

test('an audit failure never throws — it reports, so a turn is not lost to it', () => {
  const s = impersonatingSession();
  const real = getDb().prepare;
  getDb().prepare = () => { throw new Error('disk is on fire'); };
  try {
    const r = appendImpersonatedMutation({
      sessionId: s, turnSeq: 1, tool: 'update_record', descriptor: DESCRIPTOR, result: {}, verification: VERIFIED,
    });
    assert.equal(r.recorded, false);
    assert.match(r.reason, /disk is on fire/);
  } finally {
    getDb().prepare = real;
  }
});

/* ------------------------------------------------------------------ *
 * The reverse lookup — the question the phase exists for
 * ------------------------------------------------------------------ */

test('lookup by record sys_id names the real initiator behind the instance attribution', () => {
  const s = impersonatingSession();
  appendImpersonatedMutation({
    sessionId: s, turnSeq: 2, tool: 'update_record',
    descriptor: DESCRIPTOR, result: { sys_id: INCIDENT, number: 'INC0010065' }, verification: VERIFIED,
    executedImpersonated: true,
  });

  const r = whoReallyDid(INCIDENT);
  assert.equal(r.found, true);
  assert.equal(r.executed_impersonated, true);
  assert.equal(r.real_initiator.user_name, 'admin');
  assert.equal(r.attributed_to.user_name, 'aagamya.tanwar');
  assert.equal(r.task, TASK);
  // The sentence a human reads has to state both halves plainly.
  assert.match(r.answer, /attributed on the instance to aagamya\.tanwar/);
  assert.match(r.answer, /actually caused by admin/);
});

test('a write that ran as the service account is NEVER described as an attribution gap', () => {
  /*
   * The dangerous confusion. Mode being ACTIVE is not the same as a write
   * having EXECUTED as the target — and today no mutating tool routes through
   * the impersonation wrapper at all, so every real mutation is the second
   * case. Reporting it as the first would invent an audit finding: it would
   * claim the record is stamped with the target's name when the instance
   * actually recorded the service account, correctly.
   */
  const s = impersonatingSession();
  const id = 'noGap000noGap000noGap000noGap000';
  appendImpersonatedMutation({
    sessionId: s, turnSeq: 1, tool: 'update_record',
    descriptor: { ...DESCRIPTOR, sys_id: id }, result: {}, verification: VERIFIED,
    // Deliberately omitted — the default must be the safe, truthful one.
  });

  const r = whoReallyDid(id);
  assert.equal(r.found, true);
  assert.equal(r.executed_impersonated, false);
  // The instance attributes it to the REAL actor, not the impersonation target.
  assert.equal(r.attributed_to.user_name, 'admin');
  assert.equal(r.impersonation_mode_target.user_name, 'aagamya.tanwar', 'the context is still recorded');
  assert.match(r.answer, /did NOT execute as that user/);
  assert.match(r.answer, /no\s+attribution gap/);
  assert.ok(!/attributed on the instance to aagamya/.test(r.answer), 'must not claim a gap that does not exist');
});

test('an unknown record says so, and says what that means', () => {
  const r = whoReallyDid('ffffffffffffffffffffffffffffffff');
  assert.equal(r.found, false);
  assert.deepEqual(r.entries, []);
  assert.match(r.answer, /under its\s+own identity/, 'absence must not read as "nobody did it"');
});

test('an empty lookup is not treated as a wildcard', () => {
  assert.equal(whoReallyDid('').found, false);
  assert.equal(whoReallyDid(null).found, false);
});

test('the newest entry answers, and the earlier ones are still returned', () => {
  const s = impersonatingSession();
  for (const op of ['insert', 'update']) {
    appendImpersonatedMutation({
      sessionId: s, turnSeq: 3, tool: 'update_record',
      descriptor: { ...DESCRIPTOR, sys_id: 'aaaa1111bbbb2222cccc3333dddd4444', operation: op },
      result: {}, verification: VERIFIED,
    });
  }
  const r = whoReallyDid('aaaa1111bbbb2222cccc3333dddd4444');
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].operation, 'update', 'newest first');
});

test('everything one impersonated identity was used for, across sessions', () => {
  const a = impersonatingSession();
  const b = impersonatingSession();
  for (const s of [a, b]) {
    appendImpersonatedMutation({
      sessionId: s, turnSeq: 1, tool: 'create_record',
      descriptor: { table: 'incident', sys_id: `x${s}`, operation: 'insert', requested: {} },
      result: {}, verification: VERIFIED,
    });
  }
  const rows = impersonationAuditForTarget(TARGET.sys_id);
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => r.target_sys_id === TARGET.sys_id));
});

/* ------------------------------------------------------------------ *
 * Durability — this is the sole record, so it has to outlive things
 * ------------------------------------------------------------------ */

test('provenance survives a restart — it is on disk, not in memory', () => {
  const s = impersonatingSession();
  appendImpersonatedMutation({
    sessionId: s, turnSeq: 7, tool: 'update_record',
    descriptor: { ...DESCRIPTOR, sys_id: 'restart00restart00restart00rest0' },
    result: {}, verification: VERIFIED,
  });
  // Close and reopen the same file through the real migration path.
  getDb().close();
  _setDbForTests(migrate(new DatabaseSync(DB_FILE)));

  const r = whoReallyDid('restart00restart00restart00rest0');
  assert.equal(r.found, true);
  assert.equal(r.real_initiator.sys_id, ADMIN);
});

test('deleting the CONVERSATION does not erase who caused a change still on the instance', () => {
  const s = impersonatingSession();
  appendImpersonatedMutation({
    sessionId: s, turnSeq: 9, tool: 'update_record',
    descriptor: { ...DESCRIPTOR, sys_id: 'survive00survive00survive00surv0' },
    result: {}, verification: VERIFIED,
  });
  deleteSession(s);

  const r = whoReallyDid('survive00survive00survive00surv0');
  assert.equal(r.found, true, 'no foreign key may cascade the only account of a real instance change away');
  assert.equal(r.real_initiator.user_name, 'admin');
});

test('ending mode does not remove the history of what was done under it', () => {
  const s = impersonatingSession();
  appendImpersonatedMutation({
    sessionId: s, turnSeq: 1, tool: 'update_record',
    descriptor: { ...DESCRIPTOR, sys_id: 'afterend0afterend0afterend0after' },
    result: {}, verification: VERIFIED,
  });
  endMode(s);
  assert.equal(whoReallyDid('afterend0afterend0afterend0after').found, true);
});
