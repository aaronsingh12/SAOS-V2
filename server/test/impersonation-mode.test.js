import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate, getDb } from '../src/memory/db.js';
import { createSession, appendMessage, replaceSpanWithDigest, loadHistory } from '../src/memory/sessions.js';

/**
 * B3 — impersonation mode.
 *
 * The property that matters most here is the boring one: the four `imp.*` facts
 * are STATE, not history, and a compaction must not be able to touch them. WI-2
 * exists because a compaction ate an executed mutation out of a turn report; the
 * equivalent failure for this feature is a compaction eating the fact that the
 * agent is acting as somebody else, which is worse — the next instruction would
 * carry an authority nobody remembers granting.
 */

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-imp-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

/* Query-resolved on dev442675 during Phase 0 / the B1 and B2 gates. */
const ADMIN = '6816f79cc0a8016401c5a33be04be441';
const ROLE_LESS = '555a640583fe0f10b939cc65eeaad3a2';
const OTHER_ADMIN = '353cce0653e7321040e22e1e90f7b435';
const GUEST = '5136503cc611227c0183e96598c4f706';
const ADMIN_ROLE = '2831a114c611228501d4ea6c309d626d';

const USERS = [
  { sys_id: ADMIN, user_name: 'admin', name: 'System Administrator', active: 'true' },
  { sys_id: ROLE_LESS, user_name: 'aagamya.tanwar', name: 'Aagamya Tanwar', active: 'true' },
  { sys_id: OTHER_ADMIN, user_name: 'prism-service-user', name: 'Prism Service User', active: 'true' },
  { sys_id: GUEST, user_name: 'guest', name: 'Guest', active: 'true' },
  // The WI-4 shadowing set, so "adm" is genuinely ambiguous here as it is live.
  { sys_id: 'dd9b3742c37030009b5efcfc5bba8fb6', user_name: 'certification_admin', name: 'Certification Admin', active: 'true' },
  { sys_id: '8ff5b254b33213005e3de13516a8dcf7', user_name: 'cmdb_admin', name: 'CMDB Admin', active: 'true' },
];
const ROLES = [{ sys_id: ADMIN_ROLE, name: 'admin' }];
const GRANTS = [
  { sys_id: 'g1', user: ADMIN, role: ADMIN_ROLE, inherited: 'false' },
  { sys_id: 'g2', user: OTHER_ADMIN, role: ADMIN_ROLE, inherited: 'true' },
];

function runQuery(rows, query) {
  const clause = String(query || '').split('^ORDERBY')[0];
  if (!clause) return rows;
  const eq = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  let out = rows;
  for (const part of clause.split('^')) {
    if (!part) continue;
    let m;
    if ((m = /^(\w+)STARTSWITH(.+)$/.exec(part))) out = out.filter((r) => String(r[m[1]] ?? '').toLowerCase().startsWith(m[2].toLowerCase()));
    else if ((m = /^(\w+)LIKE(.+)$/.exec(part))) out = out.filter((r) => String(r[m[1]] ?? '').toLowerCase().includes(m[2].toLowerCase()));
    else if ((m = /^(\w+)=(.*)$/.exec(part))) out = out.filter((r) => eq(r[m[1]], m[2]));
  }
  return out;
}

const clientMod = await import('../src/servicenow/client.js');
const schemaMod = await import('../src/servicenow/schema.js');
const DATA = { sys_user: USERS, sys_user_role: ROLES, sys_user_has_role: GRANTS };
clientMod.table.query = async (t, { query, limit = 15 } = {}) => {
  if (t === 'sys_dictionary') return [{ element: 'name', name: 'sys_user' }];
  if (t === 'sys_db_object') return [];
  return runQuery(DATA[t] ?? [], query).slice(0, limit);
};
schemaMod.clearSchemaCaches();

const {
  getMode, impFacts, impersonationBoundaryLine, startMode, endMode, switchTarget,
} = await import('../src/memory/impersonation-mode.js');
const {
  startImpersonation, endImpersonation, switchImpersonation, impersonationStatus,
} = await import('../src/agent/impersonation-ops.js');

/**
 * The real actor, injected rather than probed — the live probe costs a bounded
 * execution per call and B1 already proves it reads gs.getUserID().
 */
const ACTOR = async () => ({ sys_id: ADMIN, user_name: 'admin', has_admin: true, session: 'glide.scheduler.worker.3' });

let n = 0;
const freshSession = () => {
  const id = `imp-session-${++n}`;
  createSession({ id, title: 'impersonation test' });
  return id;
};

test('migration 10 creates the mode table', () => {
  const row = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='impersonation_mode'").get();
  assert.equal(row?.name, 'impersonation_mode');
});

/* ------------------------------------------------------------------ *
 * start
 * ------------------------------------------------------------------ */

test('start sets mode and all four imp.* facts', async () => {
  const s = freshSession();
  const r = await startImpersonation({
    sessionId: s, user: 'aagamya.tanwar', task: 'check the Laptop Request item', actorResolver: ACTOR,
  });
  assert.equal(r.status, 'started');
  assert.equal(r.mode.active, true);
  assert.equal(r.mode.target.user_name, 'aagamya.tanwar');

  const f = r.facts;
  assert.equal(f['imp.active'], true);
  assert.equal(f['imp.target'].sys_id, ROLE_LESS);
  assert.equal(f['imp.original'].sys_id, ADMIN, 'the REAL actor, which the instance records nowhere');
  assert.equal(f['imp.task'], 'check the Laptop Request item');
});

test('start refuses without a task descriptor — B4 has nothing to compare against otherwise', async () => {
  const s = freshSession();
  const r = await startImpersonation({ sessionId: s, user: 'aagamya.tanwar', actorResolver: ACTOR });
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, 'no_task');
  assert.equal(getMode(s).active, false, 'a refused start must not leave mode half-set');
});

test('start refuses a denied target and leaves mode untouched', async () => {
  const s = freshSession();
  const r = await startImpersonation({
    sessionId: s, user: 'deadbeefcafe0000cafe0000cafe0000', task: 'anything', actorResolver: ACTOR,
  });
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, 'user_not_found');
  assert.equal(getMode(s).active, false);
});

test('an admin target is refused until elevated approval is explicitly present', async () => {
  const s = freshSession();
  const first = await startImpersonation({
    sessionId: s, user: 'prism-service-user', task: 'audit', actorResolver: ACTOR,
  });
  assert.equal(first.status, 'refused');
  assert.equal(first.reason, 'target_holds_admin_role');
  assert.equal(first.requiresElevatedApproval, true);
  assert.match(first.next, /only if they\s+explicitly confirm/);
  assert.equal(getMode(s).active, false);

  const second = await startImpersonation({
    sessionId: s, user: 'prism-service-user', task: 'audit', elevatedApproval: true, actorResolver: ACTOR,
  });
  assert.equal(second.status, 'started');
  assert.equal(second.elevated, true);
  assert.equal(getMode(s).target.user_name, 'prism-service-user');
});

test('an ambiguous name is returned as a list and never started', async () => {
  const s = freshSession();
  const r = await startImpersonation({ sessionId: s, user: 'adm', task: 'look around', actorResolver: ACTOR });
  assert.equal(r.status, 'needs_disambiguation');
  assert.ok(r.candidates.length > 1);
  assert.match(r.next, /Do not pick one/);
  assert.equal(getMode(s).active, false);
});

/* ------------------------------------------------------------------ *
 * switch
 * ------------------------------------------------------------------ */

test('switch re-targets and preserves the real initiator', async () => {
  const s = freshSession();
  await startImpersonation({ sessionId: s, user: 'aagamya.tanwar', task: 'first task', actorResolver: ACTOR });
  const r = await switchImpersonation({ sessionId: s, user: 'guest', actorResolver: ACTOR });

  assert.equal(r.status, 'switched');
  assert.equal(r.mode.target.user_name, 'guest');
  assert.equal(r.previousTarget.user_name, 'aagamya.tanwar');
  assert.equal(r.facts['imp.original'].sys_id, ADMIN, 'switching changes WHO IS IMPERSONATED, never who is doing it');
  assert.equal(r.facts['imp.task'], 'first task', 'the task carries over when the switch does not restate it');
});

test('switch applies the same gate as start', async () => {
  const s = freshSession();
  await startImpersonation({ sessionId: s, user: 'aagamya.tanwar', task: 't', actorResolver: ACTOR });
  const r = await switchImpersonation({ sessionId: s, user: 'prism-service-user', actorResolver: ACTOR });
  assert.equal(r.status, 'refused');
  assert.equal(r.requiresElevatedApproval, true);
  assert.equal(getMode(s).target.user_name, 'aagamya.tanwar', 'a refused switch must not disturb the current target');
});

/* ------------------------------------------------------------------ *
 * end and status
 * ------------------------------------------------------------------ */

test('end clears mode and VERIFIES with a live identity read', async () => {
  const s = freshSession();
  await startImpersonation({ sessionId: s, user: 'aagamya.tanwar', task: 't', actorResolver: ACTOR });
  const r = await endImpersonation({ sessionId: s, actorResolver: ACTOR });

  assert.equal(r.status, 'ended');
  assert.equal(r.mode.active, false);
  assert.equal(r.previous.target.user_name, 'aagamya.tanwar');
  assert.equal(r.verification.probed, true);
  assert.equal(r.verification.effective_user_sys_id, ADMIN);
  assert.match(r.verification.note, /isImpersonating\(\) is not consulted/);
  assert.deepEqual(r.facts, { 'imp.active': false, 'imp.target': null, 'imp.original': null, 'imp.task': null });
});

test('ending when nothing is active is a no-op, not an error', async () => {
  const s = freshSession();
  const r = await endImpersonation({ sessionId: s, actorResolver: ACTOR });
  assert.equal(r.status, 'already_inactive');
  assert.equal(r.mode.active, false);
});

test('status reports NHA state, and never reports isImpersonating()', async () => {
  const s = freshSession();
  await startImpersonation({ sessionId: s, user: 'aagamya.tanwar', task: 'audit access', actorResolver: ACTOR });

  const quiet = await impersonationStatus({ sessionId: s });
  assert.equal(quiet.mode.active, true);
  assert.equal(quiet.live, null, 'the live probe costs an execution, so it is opt-in');

  const probed = await impersonationStatus({ sessionId: s, probe: true, actorResolver: ACTOR });
  assert.equal(probed.live.effective_user_sys_id, ADMIN);
  assert.ok(!JSON.stringify(probed).includes('isImpersonating'), 'a constant must never be reported as a measurement');
  // The probe reads the executor even while mode is active — that is the M1
  // mechanism, and status must explain it rather than look like a lost mode.
  assert.match(probed.live.note, /impersonation lives inside a\s+single execution/);
});

/* ------------------------------------------------------------------ *
 * The property this whole design rests on
 * ------------------------------------------------------------------ */

test('all four imp.* facts survive a compaction cycle intact', async () => {
  const s = freshSession();
  await startImpersonation({ sessionId: s, user: 'aagamya.tanwar', task: 'the original task', actorResolver: ACTOR });
  const before = impFacts(s);

  // A real compaction: messages are written, then a span is replaced by a digest.
  for (let i = 0; i < 6; i++) {
    appendMessage(s, { role: i % 2 ? 'assistant' : 'user', content: `turn ${i} of chatter that will be folded away` });
  }
  const history = loadHistory(s);
  assert.ok(history.length >= 6);
  replaceSpanWithDigest(s, 1, 5, 'digest: the earlier conversation, summarised');
  assert.ok(loadHistory(s).length < history.length, 'compaction did not actually fold anything');

  const after = impFacts(s);
  assert.deepEqual(after, before, 'the impersonation facts are STATE and compaction must not reach them');
  assert.equal(after['imp.active'], true);
  assert.equal(after['imp.target'].user_name, 'aagamya.tanwar');
  assert.equal(after['imp.original'].sys_id, ADMIN);
  assert.equal(after['imp.task'], 'the original task');
});

test('the end-of-turn boundary line names the target, the real actor and the task', async () => {
  const s = freshSession();
  await startImpersonation({ sessionId: s, user: 'aagamya.tanwar', task: 'check catalog visibility', actorResolver: ACTOR });
  const line = impersonationBoundaryLine(s);

  assert.match(line, /aagamya\.tanwar/);
  assert.match(line, /really admin/);
  assert.match(line, /check catalog visibility/);
  // It must say where provenance actually lives, because the instance has none.
  assert.match(line, /instance keeps no record/);

  await endImpersonation({ sessionId: s, actorResolver: ACTOR });
  assert.equal(impersonationBoundaryLine(s), null, 'silence is the right rendering of "you are yourself"');
});

test('mode is per session — one session impersonating does not leak into another', async () => {
  const a = freshSession();
  const b = freshSession();
  await startImpersonation({ sessionId: a, user: 'aagamya.tanwar', task: 't', actorResolver: ACTOR });
  assert.equal(getMode(a).active, true);
  assert.equal(getMode(b).active, false);
  assert.equal(impersonationBoundaryLine(b), null);
});

/* ------------------------------------------------------------------ *
 * The state module's own contract
 * ------------------------------------------------------------------ */

test('startMode refuses an incomplete identity rather than storing a half-target', () => {
  const s = freshSession();
  assert.throws(() => startMode({ sessionId: s, target: { sys_id: ROLE_LESS }, original: { sys_id: ADMIN } }), /sys_id and user_name/);
  assert.throws(() => startMode({ sessionId: s, target: { sys_id: ROLE_LESS, user_name: 'x' } }), /original/);
});

test('switchTarget with no stored original and none supplied refuses', () => {
  const s = freshSession();
  assert.throws(
    () => switchTarget({ sessionId: s, target: { sys_id: ROLE_LESS, user_name: 'aagamya.tanwar' } }),
    /needs an original actor/,
  );
});

test('endMode reports whether it actually ended something', () => {
  const s = freshSession();
  startMode({
    sessionId: s, target: { sys_id: GUEST, user_name: 'guest' }, original: { sys_id: ADMIN, user_name: 'admin' }, task: 't',
  });
  assert.equal(endMode(s).ended, true);
  assert.equal(endMode(s).ended, false);
});
