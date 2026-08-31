import test from 'node:test';
import assert from 'node:assert/strict';

import { diagnoseFailure, assertScopeIntentHeld } from '../src/servicenow/client.js';
import {
  esc, derivedRemoteSysId, parseUpdateSetXml, verifyExportParity,
} from '../src/servicenow/transport-export.js';
import { listWorkspaces, workspaceForScope, managedScopeNames, refreshWorkspaces } from '../src/servicenow/workspaces.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _setDbForTests, migrate, getDb } from '../src/memory/db.js';
import { createSession } from '../src/memory/sessions.js';
import {
  isCaptureOn, setCapture, updateRowName, sweepMark,
  targetSysIdOf, resolveContention, openCaptureWindow, closeCaptureWindow, _openWindows, _resetWindows,
} from '../src/servicenow/transport.js';

/* ------------------------------------------------------------------ *
 * The 403 that is not an auth failure (§33)
 * ------------------------------------------------------------------ */

test('a business-rule abort is reported as a refused write, not bad credentials', () => {
  const d = diagnoseFailure({
    status: 403,
    detail: "Operation against file 'sys_update_xml' was aborted by Business Rule 'Handle updates moving between sets^0e5b9945'. Business Rule Stack:Handle updates moving between sets",
    host: 'dev442675.service-now.com', username: 'admin', method: 'PATCH', pathname: '/api/now/table/sys_update_xml/abc',
  });
  assert.equal(d.kind, 'business-rule');
  assert.equal(d.rule, 'Handle updates moving between sets');
  assert.match(d.message, /refused by the business rule "Handle updates moving between sets"/);
  // The regression this exists to prevent: sending someone to check a password
  // that was never wrong.
  assert.doesNotMatch(d.message, /password/i);
  assert.doesNotMatch(d.message, /hibernating/i);
});

test('the rule name stops at the caret — the sys_id after it is not part of the name', () => {
  const d = diagnoseFailure({
    status: 403,
    detail: "aborted by Business Rule 'Handle updates moving between sets^0e5b994583764f10b939cc65eeaad3c1'.",
  });
  assert.equal(d.rule, 'Handle updates moving between sets');
});

test('an API-level ACL names the table and says it is a permission, not a password', () => {
  const d = diagnoseFailure({
    status: 403, detail: 'Failed API level ACL Validation',
    host: 'dev442675.service-now.com', username: 'admin', pathname: '/api/now/table/sys_store_app',
  });
  assert.equal(d.kind, 'table-acl');
  assert.equal(d.table, 'sys_store_app');
  assert.match(d.message, /sys_store_app/);
  assert.match(d.message, /not a bad password/);
});

test('a 403 with no recognised detail still reads as a credentials problem', () => {
  const d = diagnoseFailure({ status: 403, detail: 'User Not Authenticated', username: 'admin', host: 'x.service-now.com' });
  assert.equal(d.kind, 'credentials');
  assert.match(d.message, /rejected the credentials/);
});

test('a 401 is always credentials, whatever the detail says', () => {
  const d = diagnoseFailure({ status: 401, detail: 'aborted by Business Rule \'Something\'', username: 'admin' });
  assert.equal(d.kind, 'credentials');
});

test('a non-auth failure keeps the instance message', () => {
  const d = diagnoseFailure({ status: 400, statusText: 'Bad Request', message: 'Invalid table name' });
  assert.equal(d.kind, 'other');
  assert.equal(d.message, 'Invalid table name');
});

/* ------------------------------------------------------------------ *
 * Export format
 * ------------------------------------------------------------------ */

test('the remote set sys_id is derived, so the same set exports identically twice', () => {
  const a = derivedRemoteSysId('238afb0a83b2c750b939cc65eeaad34b');
  const b = derivedRemoteSysId('238afb0a83b2c750b939cc65eeaad34b');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, derivedRemoteSysId('other'));
});

test('escaping is unconditional, so a payload carrying CDATA cannot break the file', () => {
  // The measured hazard: the platform wraps a payload in CDATA unless the
  // payload itself contains one, because CDATA cannot nest. A business rule's
  // payload carries <script><![CDATA[...]]></script>. Always-escape removes the
  // conditional — assert that the sequence that would end a CDATA block is gone.
  const payload = '<script><![CDATA[if (a < b && c > d) {}]]></script>';
  const out = esc(payload);
  assert.ok(!out.includes(']]>'), 'the CDATA terminator survived escaping');
  assert.ok(!out.includes('<script>'), 'a raw tag survived escaping');
  assert.match(out, /&lt;script&gt;/);
});

/** A minimal export in exactly the shape the builder emits. */
function fakeExport(rows, { remoteSysId = 'r'.repeat(32), setSysId = 's'.repeat(32) } = {}) {
  const el = (n, v) => (v === '' || v == null ? `<${n}/>` : `<${n}>${esc(v)}</${n}>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<unload unload_date="2026-01-01 00:00:00">',
    '<sys_remote_update_set action="INSERT_OR_UPDATE">',
    el('name', 'A set'), el('remote_sys_id', setSysId), el('sys_id', remoteSysId),
    el('application', 'global'), el('application_scope', 'global'), el('summary', String(rows.length)),
    '</sys_remote_update_set>',
    ...rows.map((r) => [
      '<sys_update_xml action="INSERT_OR_UPDATE">',
      el('action', 'INSERT_OR_UPDATE'), el('name', r.name), el('payload', r.payload),
      el('payload_hash', r.payloadHash), el('target_name', r.target), el('type', r.type),
      el('remote_update_set', remoteSysId), el('update_set', ''),
      '</sys_update_xml>',
    ].join('\n')),
    '</unload>', '',
  ].join('\n');
}

const ROWS = [
  { name: 'sc_cat_item_aaa', payload: '<?xml version="1.0"?><record_update table="sc_cat_item"><a>1</a></record_update>', payloadHash: '111', target: 'An item', type: 'Catalog Item' },
  { name: 'sys_script_bbb', payload: '<record_update table="sys_script"><script><![CDATA[x < 1 && y > 2;]]></script></record_update>', payloadHash: '222', target: 'A rule', type: 'Business Rule' },
];
const MANIFEST = {
  setSysId: 's'.repeat(32), remoteSysId: 'r'.repeat(32), count: 2,
  rows: ROWS.map((r) => ({ name: r.name, payloadHash: r.payloadHash, target: r.target, type: r.type })),
};

test('a payload survives the round trip byte for byte, CDATA and angle brackets included', () => {
  const parsed = parseUpdateSetXml(fakeExport(ROWS));
  assert.equal(parsed.updates.length, 2);
  for (const src of ROWS) {
    const got = parsed.updates.find((u) => u.name === src.name);
    assert.equal(got.payload, src.payload, `payload differs for ${src.name}`);
  }
});

test('parity passes when the export matches the set it was built from', () => {
  const r = verifyExportParity(fakeExport(ROWS), MANIFEST);
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.reparsed, 2);
  assert.deepEqual(r.problems, []);
});

test('parity FAILS when a row is missing — a name list that is short is caught', () => {
  const r = verifyExportParity(fakeExport([ROWS[0]]), MANIFEST);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /missing from the export: sys_script_bbb/.test(p)), r.problems.join('; '));
});

test('parity FAILS when a payload changed but its name did not', () => {
  // The failure a name-only check would wave through: right count, right names,
  // wrong content.
  const tampered = [{ ...ROWS[0], payloadHash: '999' }, ROWS[1]];
  const r = verifyExportParity(fakeExport(tampered), MANIFEST);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /payload hash differs for sc_cat_item_aaa/.test(p)), r.problems.join('; '));
});

test('parity FAILS when the export carries a row the set does not', () => {
  const extra = [...ROWS, { name: 'sys_ui_policy_ccc', payload: '<x/>', payloadHash: '333', target: 'Stowaway', type: 'UI Policy' }];
  const r = verifyExportParity(fakeExport(extra), MANIFEST);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /sys_ui_policy_ccc, which is not in the set/.test(p)), r.problems.join('; '));
});

test('parity FAILS when the rows are not attached to the exported set', () => {
  const detached = fakeExport(ROWS).replace(/<remote_update_set>r+<\/remote_update_set>/g, '<remote_update_set>deadbeef</remote_update_set>');
  const r = verifyExportParity(detached, MANIFEST);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /not attached to the exported set/.test(p)), r.problems.join('; '));
});

test('parity FAILS when the header points at a different local set', () => {
  const wrong = fakeExport(ROWS, { setSysId: 'f'.repeat(32) });
  const r = verifyExportParity(wrong, MANIFEST);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /header remote_sys_id/.test(p)), r.problems.join('; '));
});

test('an empty element parses as empty, not as null', () => {
  const parsed = parseUpdateSetXml(fakeExport([{ ...ROWS[0], payload: '' }]));
  assert.equal(parsed.updates[0].payload, '');
});

/* ------------------------------------------------------------------ *
 * The workspace registry — filesystem only, no instance
 * ------------------------------------------------------------------ */

test('the registry discovers the fluent workspace and reads its claimed scope', async () => {
  refreshWorkspaces();
  const ws = await listWorkspaces();
  assert.ok(ws.length >= 1, 'no workspace discovered');
  const fluent = ws.find((w) => w.id === 'fluent-workspace');
  assert.ok(fluent, 'fluent-workspace was not discovered');
  assert.equal(fluent.scope, 'x_2002152_nwforge');
  assert.equal(fluent.error, null);
  assert.ok(fluent.sourceCount > 0, 'no managed sources counted');
});

test('a scope resolves by NAME, and a sys_id is no longer an address', async () => {
  /*
   * This asserted that a workspace resolved by scope name OR by scope sys_id.
   * The sys_id half only worked because `now.config.json` pinned one — and that
   * pin is exactly what left the workspace addressed to a retired instance. A
   * sys_id is instance-local, so "which workspace owns this sys_id" is
   * unanswerable without naming an instance, and answering it anyway is how the
   * wrong host gets a confident reply.
   */
  const byName = await workspaceForScope('x_2002152_nwforge');
  assert.ok(byName, 'scope name did not resolve');
  assert.equal(byName.scopeId, null, 'the registry must not carry an instance-local sys_id');
  assert.equal(await workspaceForScope('c44f3c6c37c24793be9f8b759c7818e4'), null);
});

test('an unmanaged scope resolves to nothing rather than to the only workspace we have', async () => {
  assert.equal(await workspaceForScope('x_tepv_ts_dms'), null);
  assert.equal(await workspaceForScope('global'), null);
  assert.equal(await workspaceForScope(''), null);
});

test('the managed scope list is what the Applications page flags against', async () => {
  const names = await managedScopeNames();
  assert.ok(names.includes('x_2002152_nwforge'));
  assert.ok(!names.includes('global'));
});

/* ------------------------------------------------------------------ *
 * Capture state — the ON-by-default contract the chat toggle depends on
 * ------------------------------------------------------------------ */

// A scratch database through the REAL migrations, same pattern as memory.test.js.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-transport-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

test('migration 6 creates the capture tables', () => {
  const names = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('capture_state','capture_sets')")
    .all().map((r) => r.name).sort();
  assert.deepEqual(names, ['capture_sets', 'capture_state']);
});

test('capture is ON for a session nobody has touched — absence means the default', () => {
  assert.equal(isCaptureOn('never-seen-session'), true);
});

test('capture off, then on, survives as an explicit row', () => {
  const id = 'sess-toggle';
  createSession({ id, title: 'toggle' });
  setCapture(id, false);
  assert.equal(isCaptureOn(id), false, 'turning it off did not take');
  setCapture(id, true);
  assert.equal(isCaptureOn(id), true, 'turning it back on did not take');
  // One row per session, not one per toggle — the UPSERT is load-bearing.
  const n = getDb().prepare('SELECT COUNT(*) c FROM capture_state WHERE session = ?').get(id).c;
  assert.equal(n, 1, `expected one capture_state row, found ${n}`);
});

test('no session id is not "capture on" — a sweep with nowhere to put rows must not run', () => {
  assert.equal(isCaptureOn(null), false);
  assert.equal(isCaptureOn(''), false);
});

test('the update row locator is <table>_<sys_id>, exactly as the platform writes it', () => {
  assert.equal(
    updateRowName('sc_cat_item', 'de8ab70a83b2c750b939cc65eeaad30a'),
    'sc_cat_item_de8ab70a83b2c750b939cc65eeaad30a'
  );
});

test('the sweep mark is a UTC glide_date_time, backdated past one-second granularity', () => {
  const at = Date.parse('2026-08-21T05:27:24.000Z');
  const mark = sweepMark(at);
  assert.match(mark, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `not a glide_date_time: ${mark}`);
  // Backdated, because a row written in the same second the clock ticked over
  // would otherwise fall outside the window.
  assert.ok(Date.parse(mark.replace(' ', 'T') + 'Z') < at, 'the mark is not backdated');
  // UTC, not local — trap #UTC. 05:27:24 UTC must not render as a local hour.
  assert.ok(mark.startsWith('2026-08-21 05:2'), `not UTC: ${mark}`);
});

/* ------------------------------------------------------------------ *
 * AD-1 — the row-level ACL 403, the shape the sweep's delete actually hits
 * ------------------------------------------------------------------ */

test('a record-level ACL 403 names the operation, table and row — not the password', () => {
  const d = diagnoseFailure({
    status: 403,
    detail: 'ACL Exception Delete Failed due to security constraints',
    host: 'dev442675.service-now.com', username: 'admin',
    method: 'DELETE', pathname: '/api/now/table/sys_update_xml/a24153138322031059c0cc65eeaad364',
  });
  assert.equal(d.kind, 'row-acl');
  assert.equal(d.operation, 'delete');
  assert.equal(d.table, 'sys_update_xml');
  assert.equal(d.sys_id, 'a24153138322031059c0cc65eeaad364');
  assert.match(d.message, /record-level ACL/);
  assert.match(d.message, /sys_update_xml a24153138322031059c0cc65eeaad364/);
  assert.doesNotMatch(d.message, /password/i);
  assert.doesNotMatch(d.message, /hibernating/i);
});

test('a row-level ACL is not confused with a table-level one — different remedies', () => {
  const row = diagnoseFailure({ status: 403, detail: 'ACL Exception Insert Failed due to security constraints', pathname: '/api/now/table/sys_script' });
  const tbl = diagnoseFailure({ status: 403, detail: 'Failed API level ACL Validation', pathname: '/api/now/table/sys_script' });
  assert.equal(row.kind, 'row-acl');
  assert.equal(tbl.kind, 'table-acl');
  assert.notEqual(row.message, tbl.message);
});

test('every ACL operation the platform names is carried through', () => {
  for (const op of ['Read', 'Insert', 'Update', 'Delete']) {
    const d = diagnoseFailure({ status: 403, detail: `ACL Exception ${op} Failed due to security constraints`, pathname: '/api/now/table/x/y' });
    assert.equal(d.kind, 'row-acl', op);
    assert.equal(d.operation, op.toLowerCase());
  }
});

test('a 404 that admits it might be an ACL says so, and rules nothing out', () => {
  const d = diagnoseFailure({
    status: 404, detail: "Record doesn't exist or ACL restricts the record retrieval",
    host: 'x.service-now.com', pathname: '/api/now/table/sys_user_preference/dead',
  });
  assert.equal(d.kind, 'missing-or-hidden');
  assert.equal(d.table, 'sys_user_preference');
  assert.match(d.message, /either does not exist or an ACL hides it/);
});

test('a business-rule abort still wins over an ACL phrase in the same detail', () => {
  // Ordering matters: the rule name is the more specific, more actionable fact.
  const d = diagnoseFailure({
    status: 403,
    detail: "Operation against file 'sys_update_xml' was aborted by Business Rule 'Handle updates moving between sets^abc'. ACL Exception Update Failed due to security constraints",
  });
  assert.equal(d.kind, 'business-rule');
});

/* ------------------------------------------------------------------ *
 * AD-2 — REST is a global-tier writer, enforced rather than remembered
 * ------------------------------------------------------------------ */

test('a create that asked for a scope and got global fails loudly', () => {
  assert.throws(
    () => assertScopeIntentHeld('sys_script', { sys_scope: 'c44f3c6c37c24793be9f8b759c7818e4' }, { sys_scope: 'global', sys_id: 'abc' }),
    (err) => {
      assert.match(err.message, /sys_scope="c44f3c6c37c24793be9f8b759c7818e4" but the instance stored "global"/);
      assert.match(err.message, /global-tier writer/);
      assert.match(err.message, /SDK tier/);
      return true;
    }
  );
});

test('the error says the record EXISTS and names it — the guard reports, it cannot un-write', () => {
  // REST created the row and returned 201 before this ran. Auto-deleting would
  // be a destructive default; naming the sys_id leaves the decision with the
  // caller, and hiding it would strand an artifact nobody can find.
  assert.throws(
    () => assertScopeIntentHeld('sys_script', { sys_scope: 'x_2002152_nwforge' }, { sys_scope: 'global', sys_id: '55b9401e8336c750b939cc65eeaad393' }),
    (err) => {
      assert.match(err.message, /The record was still created, as 55b9401e8336c750b939cc65eeaad393 in "global"/);
      assert.match(err.message, /delete it if a global one is not wanted/);
      assert.equal(JSON.parse(err.detail).sys_id, '55b9401e8336c750b939cc65eeaad393');
      return true;
    }
  );
});

test('the same rule covers sys_update_set.application, where the field is named differently', () => {
  assert.throws(
    () => assertScopeIntentHeld('sys_update_set', { application: 'c44f3c6c37c24793be9f8b759c7818e4' }, { application: 'global' }),
    /application="c44f3c6c37c24793be9f8b759c7818e4" but the instance stored "global"/
  );
});

test('asking for global and getting global is not a demotion', () => {
  const created = { application: 'global', sys_id: 'x' };
  assert.equal(assertScopeIntentHeld('sys_update_set', { application: 'global' }, created), created);
});

test('a create that expressed no scope intent is not second-guessed', () => {
  const created = { sys_scope: 'global', sys_id: 'x' };
  assert.equal(assertScopeIntentHeld('sys_script', { name: 'a rule' }, created), created);
  assert.equal(assertScopeIntentHeld('sys_script', { sys_scope: '' }, created), created);
});

test('the check reads display="all" cells too, not just raw values', () => {
  assert.throws(
    () => assertScopeIntentHeld('sys_script', { sys_scope: 'x_2002152_nwforge' }, { sys_scope: { value: 'global', display_value: 'Global' } }),
    /but the instance stored "global"/
  );
});

test('"application" on a table where it means something else is left alone', () => {
  // Only the update-set tables use `application` for scope. Elsewhere the
  // default intent field is sys_scope, so an unrelated `application` value
  // must not trip the guard.
  const created = { application: 'something else', sys_id: 'x' };
  assert.equal(assertScopeIntentHeld('some_other_table', { application: 'whatever' }, created), created);
});

/* ------------------------------------------------------------------ *
 * AD-4 — two concurrent captured sessions must never claim each other's rows
 * ------------------------------------------------------------------ */

const ROW_A = 'sc_cat_item_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ROW_B = 'sys_script_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** Two sessions whose windows overlap, with a stubbed audit trail. */
function twoSessions(provenance) {
  const windows = new Map([
    ['S1', { since: '2026-08-21 06:00:00', sinceIso: '2026-08-21T06:00:00Z' }],
    ['S2', { since: '2026-08-21 06:00:05', sinceIso: '2026-08-21T06:00:05Z' }],
  ]);
  const touched = (session) => new Set(provenance[session] || []);
  return { windows, touched };
}

test('the target sys_id is recovered from the row name', () => {
  assert.equal(targetSysIdOf(ROW_A), ID_A);
  assert.equal(targetSysIdOf('item_option_new_' + ID_B), ID_B);
  assert.equal(targetSysIdOf('not-a-row-name'), null);
});

test('with only one window open, a row is simply mine', () => {
  const windows = new Map([['S1', { since: '2026-08-21 06:00:00', sinceIso: '2026-08-21T06:00:00Z' }]]);
  const r = resolveContention({ rowName: ROW_A, sessionId: 'S1', rowCreatedOn: '2026-08-21 06:00:10', windows, touched: () => new Set() });
  assert.equal(r.verdict, 'mine');
  assert.deepEqual(r.contestedWith, []);
});

test('a contested row goes to the session whose audit trail reports touching it', () => {
  const { windows, touched } = twoSessions({ S1: [ID_A], S2: [ID_B] });
  const a = resolveContention({ rowName: ROW_A, sessionId: 'S1', rowCreatedOn: '2026-08-21 06:00:10', windows, touched });
  const b = resolveContention({ rowName: ROW_B, sessionId: 'S2', rowCreatedOn: '2026-08-21 06:00:10', windows, touched });
  assert.equal(a.verdict, 'mine', 'S1 did not get the row it created');
  assert.equal(b.verdict, 'mine', 'S2 did not get the row it created');
  assert.deepEqual(a.contestedWith, ['S2']);
});

test('a contested row the OTHER session created is theirs, and is never taken', () => {
  const { windows, touched } = twoSessions({ S1: [ID_A], S2: [ID_B] });
  const r = resolveContention({ rowName: ROW_B, sessionId: 'S1', rowCreatedOn: '2026-08-21 06:00:10', windows, touched });
  assert.equal(r.verdict, 'theirs');
  assert.equal(r.owner, 'S2');
});

test('a contested row nobody claims is UNASSIGNED, never split on timing', () => {
  // The exact failure the guard exists to prevent: both windows cover the row,
  // neither audit trail mentions it, and whoever sweeps first would take it.
  const { windows, touched } = twoSessions({ S1: [], S2: [] });
  const r1 = resolveContention({ rowName: ROW_A, sessionId: 'S1', rowCreatedOn: '2026-08-21 06:00:10', windows, touched });
  const r2 = resolveContention({ rowName: ROW_A, sessionId: 'S2', rowCreatedOn: '2026-08-21 06:00:10', windows, touched });
  assert.equal(r1.verdict, 'unassigned');
  assert.equal(r2.verdict, 'unassigned');
  assert.match(r1.reason, /no open session reports touching this record/);
});

test('a row BOTH sessions report touching is unassigned rather than duplicated', () => {
  const { windows, touched } = twoSessions({ S1: [ID_A], S2: [ID_A] });
  const r = resolveContention({ rowName: ROW_A, sessionId: 'S1', rowCreatedOn: '2026-08-21 06:00:10', windows, touched });
  assert.equal(r.verdict, 'unassigned');
  assert.match(r.reason, /more than one open session reports touching/);
});

test('a row created BEFORE the rival window opened is not contested', () => {
  const { windows, touched } = twoSessions({ S1: [], S2: [] });
  // 06:00:02 is inside S1's window but before S2's opened at 06:00:05.
  const r = resolveContention({ rowName: ROW_A, sessionId: 'S1', rowCreatedOn: '2026-08-21 06:00:02', windows, touched });
  assert.equal(r.verdict, 'mine');
  assert.deepEqual(r.contestedWith, []);
});

test('a closed window stops contesting — a finished session must not block a live one', () => {
  _resetWindows();
  openCaptureWindow('S1', '2026-08-21 06:00:00');
  openCaptureWindow('S2', '2026-08-21 06:00:00');
  assert.equal(_openWindows().size, 2);
  closeCaptureWindow('S2');
  assert.equal(_openWindows().size, 1);
  const r = resolveContention({ rowName: ROW_A, sessionId: 'S1', rowCreatedOn: '2026-08-21 06:00:10', touched: () => new Set() });
  assert.equal(r.verdict, 'mine', 'a closed window still contested');
  _resetWindows();
});
