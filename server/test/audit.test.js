/**
 * D-5 regression proof — the audit trail.
 *
 *   node --test server/test/
 *
 * The acceptance test for this feature is a sentence: reconstruct everything a
 * past session did to the instance — with sys_ids and who approved — from the
 * Audit page alone. A page can only render what was written down, so what is
 * pinned here is the writing-down.
 *
 * Two properties are load-bearing beyond "the rows come back":
 *
 *  - `auto` must survive as `auto`. It means auto-approve was on and no human
 *    saw the gate. Collapsing it into "approved" would have this page assert a
 *    decision that never happened, on the one page whose whole job is trust.
 *  - a build that could not write part of its own event stream must SAY so.
 *    An incomplete history rendered as a complete one is the exact failure
 *    class this project keeps digging out of the instance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate, getDb } from '../src/memory/db.js';
import { _setSettingsForTests, getSettings } from '../src/config/store.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-audit-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { createSession, recordToolEvent } = await import('../src/memory/sessions.js');
const {
  startBuildRun, recordBuildEvent, finishBuildRun, auditedEmit, loadBuildEvents,
  auditRows, auditSessions, auditCsv, harvestSysIds, currentActor,
} = await import('../src/memory/audit.js');

const SESSION = 'audit-test-session';
const OTHER = 'audit-other-session';
const ITEM_SYS_ID = '8b3ae7fedc1be1004ece5c08239e522b';
const POLICY_SYS_ID = '196e6cb274ef42b4bcbd3827a0d241cc';
const BASE_CONNECTION = { ...getSettings().connection };

createSession({ id: SESSION, title: 'Make justification mandatory' });
createSession({ id: OTHER, title: 'Unrelated chat' });

/* ------------------------------------------------------------------ *
 * The migration itself
 * ------------------------------------------------------------------ */

test('migration 5 adds the columns that made the trail answerable', () => {
  const cols = getDb().prepare('PRAGMA table_info(tool_events)').all().map((c) => c.name);
  for (const c of ['result', 'actor', 'instance']) assert.ok(cols.includes(c), `tool_events.${c} is missing`);
  const tables = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  assert.ok(tables.includes('build_runs'));
  assert.ok(tables.includes('build_events'));
});

test('migrations are idempotent — a second boot against the same file is a no-op', () => {
  const before = getDb().prepare('PRAGMA user_version').get().user_version;
  migrate(getDb());
  assert.equal(getDb().prepare('PRAGMA user_version').get().user_version, before);
});

/* ------------------------------------------------------------------ *
 * Agent events
 * ------------------------------------------------------------------ */

test('a tool call records its RESULT, which is where the sys_id lives', () => {
  recordToolEvent(SESSION, {
    kind: 'tool_call',
    name: 'get_catalog_item',
    payload: { sys_id: ITEM_SYS_ID },
    result: JSON.stringify({ name: 'Corp VPN', sys_id: ITEM_SYS_ID }),
    resultStatus: 'ok',
    mutating: false,
    approval: null,
  });
  recordToolEvent(SESSION, {
    kind: 'tool_call',
    name: 'create_ui_policy',
    payload: { cat_item: ITEM_SYS_ID, short_description: 'Require justification when duration is Permanent' },
    result: JSON.stringify({ ok: true, sys_id: POLICY_SYS_ID }),
    resultStatus: 'ok',
    mutating: true,
    approval: 'approved',
  });

  const rows = auditRows({ session: SESSION });
  const created = rows.find((r) => r.name === 'create_ui_policy');
  assert.ok(created, 'the mutating call is not in the trail');
  assert.match(created.result, new RegExp(POLICY_SYS_ID));
  // The whole acceptance sentence, in one assertion: the identifier of the
  // thing that was created is recoverable from this row.
  assert.ok(created.sysIds.includes(POLICY_SYS_ID), 'the created policy sys_id is not surfaced');
  assert.ok(created.sysIds.includes(ITEM_SYS_ID), 'the item it was scoped to is not surfaced');
});

test('the instance and account are captured per event, not read off the session', () => {
  const { instance, actor } = currentActor();
  const row = auditRows({ session: SESSION })[0];
  assert.equal(row.instance, instance);
  assert.equal(row.actor, actor);
});

test('an auto-approved mutation is never rounded up to "approved"', () => {
  recordToolEvent(OTHER, {
    kind: 'tool_call', name: 'create_record', payload: { table: 'incident' },
    result: '{"sys_id":"deadbeefdeadbeefdeadbeefdeadbeef"}',
    resultStatus: 'ok', mutating: true, approval: 'auto',
  });
  const row = auditRows({ session: OTHER }).find((r) => r.name === 'create_record');
  assert.equal(row.approval, 'auto');
  assert.notEqual(row.approval, 'approved');
});

test('a rejected mutation is recorded as having happened and been refused', () => {
  recordToolEvent(OTHER, {
    kind: 'tool_call', name: 'delete_live_flow', payload: { name: 'Vendor hold' },
    result: 'The user rejected this operation.', resultStatus: 'rejected',
    mutating: true, approval: 'rejected',
  });
  const row = auditRows({ session: OTHER }).find((r) => r.name === 'delete_live_flow');
  assert.equal(row.approval, 'rejected');
  assert.equal(row.status, 'rejected');
});

test('the mutations-only filter keeps every write and drops every read', () => {
  const all = auditRows({ session: SESSION });
  const writes = auditRows({ session: SESSION, mutatingOnly: true });
  assert.ok(all.length > writes.length, 'the fixture has no reads to filter out');
  assert.ok(writes.every((r) => r.mutating));
  assert.ok(writes.some((r) => r.name === 'create_ui_policy'));
});

test('the session filter does not leak another conversation', () => {
  const rows = auditRows({ session: SESSION });
  assert.ok(rows.every((r) => r.session === SESSION));
  assert.ok(!rows.some((r) => r.name === 'create_record'));
});

/* ------------------------------------------------------------------ *
 * UI-driven builds
 * ------------------------------------------------------------------ */

test('a build driven from a module page is recorded, session or no session', () => {
  const run = startBuildRun({
    kind: 'ui_policy_create',
    label: 'Require justification when duration is Permanent',
    request: { cat_item: ITEM_SYS_ID },
  });
  const streamed = [];
  const emit = auditedEmit(run, (e) => streamed.push(e));
  emit({ type: 'generating' });
  emit({ type: 'build', ok: true });
  emit({ type: 'install', activation: '10/10' });
  finishBuildRun(run, { status: 'ok', summary: { ok: true, sys_id: POLICY_SYS_ID } });

  // The wrapper must not change what the browser sees.
  assert.equal(streamed.length, 3);
  assert.equal(streamed[2].activation, '10/10');

  assert.equal(loadBuildEvents(run).length, 3);
  const row = auditRows({}).find((r) => r.id === run);
  assert.equal(row.source, 'build');
  assert.equal(row.approval, 'ui', 'a hand-driven build must be distinguishable from an agent one');
  assert.equal(row.status, 'ok');
  assert.ok(row.sysIds.includes(POLICY_SYS_ID));
});

test('the "driven by hand" bucket is a real filter, not a UI-side guess', () => {
  const rows = auditRows({ session: 'ui' });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.source === 'build' && !r.session));
});

test('a run whose events could not be written says so instead of looking complete', () => {
  const run = startBuildRun({ kind: 'flow_build', label: 'Vendor hold' });
  recordBuildEvent(run, { type: 'generating' });

  // Simulate the audit write failing mid-build: the deploy is already touching
  // the instance and must not be killed, but the gap must be visible.
  const db = getDb();
  const realPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes('INSERT INTO build_events')) throw new Error('disk full');
    return realPrepare(sql);
  };
  recordBuildEvent(run, { type: 'install' });
  recordBuildEvent(run, { type: 'readback' });
  db.prepare = realPrepare;

  finishBuildRun(run, { status: 'ok', summary: { ok: true } });
  const row = auditRows({}).find((r) => r.id === run);
  assert.equal(row.dropped, 2, 'dropped events must be counted, not swallowed');
  assert.equal(loadBuildEvents(run).length, 1);
});

/* ------------------------------------------------------------------ *
 * The timeline, the picker, and the export
 * ------------------------------------------------------------------ */

test('both sources interleave in one timeline, newest first', () => {
  const rows = auditRows({});
  assert.ok(rows.some((r) => r.source === 'agent'));
  assert.ok(rows.some((r) => r.source === 'build'));
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].ts >= rows[i].ts, 'the timeline is out of order');
  }
});

test('the session picker offers only sessions that actually did something', () => {
  createSession({ id: 'never-used', title: 'Empty chat' });
  const { sessions, uiBuilds } = auditSessions();
  assert.ok(!sessions.some((s) => s.id === 'never-used'), 'a session with no events is noise in the picker');
  assert.ok(sessions.some((s) => s.id === SESSION));
  assert.ok(uiBuilds > 0);
});

test('instance switch: audit rows and picker stay on the current instance', () => {
  try {
    _setSettingsForTests({ connection: { instanceUrl: 'https://audit-alpha.service-now.com', username: 'admin' } });
    createSession({ id: 'audit-alpha-chat', title: 'Alpha audit' });
    recordToolEvent('audit-alpha-chat', {
      kind: 'tool_call', name: 'alpha_write', resultStatus: 'ok', mutating: true, approval: 'approved',
    });
    const alphaRun = startBuildRun({ kind: 'flow_build', label: 'Alpha build' });
    finishBuildRun(alphaRun, { status: 'ok', summary: { ok: true } });

    _setSettingsForTests({ connection: { instanceUrl: 'https://audit-beta.service-now.com', username: 'admin' } });
    createSession({ id: 'audit-beta-chat', title: 'Beta audit' });
    recordToolEvent('audit-beta-chat', {
      kind: 'tool_call', name: 'beta_write', resultStatus: 'ok', mutating: true, approval: 'approved',
    });

    const rows = auditRows({});
    assert.ok(rows.some((r) => r.name === 'beta_write'), 'current instance audit row is visible');
    assert.ok(!rows.some((r) => r.name === 'alpha_write'), 'previous instance audit row leaked');
    assert.ok(!rows.some((r) => r.id === alphaRun), 'previous instance build run leaked');

    const { sessions } = auditSessions();
    assert.ok(sessions.some((s) => s.id === 'audit-beta-chat'), 'current instance audit session is visible');
    assert.ok(!sessions.some((s) => s.id === 'audit-alpha-chat'), 'previous instance audit session leaked');
  } finally {
    _setSettingsForTests({ connection: BASE_CONNECTION });
  }
});

test('sys_id harvesting finds identifiers wherever they sit', () => {
  const ids = harvestSysIds(
    JSON.stringify({ cat_item: ITEM_SYS_ID }),
    `installed, see /nav_to.do?uri=catalog_ui_policy.do%3Fsys_id%3D${POLICY_SYS_ID}`
  );
  assert.deepEqual(ids.sort(), [ITEM_SYS_ID, POLICY_SYS_ID].sort());
  // 32 hex, and only 32 hex — a 31- or 33-character run is not a sys_id.
  assert.deepEqual(harvestSysIds('abc', 'a'.repeat(31), 'b'.repeat(33)), []);
});

test('the CSV carries the columns an auditor needs, and escapes what it must', () => {
  const csv = auditCsv(auditRows({ session: SESSION }));
  const [header] = csv.replace(/^﻿/, '').split('\r\n');
  for (const col of ['timestamp', 'approval', 'sys_ids', 'payload', 'result', 'actor', 'instance']) {
    assert.ok(header.includes(col), `the export drops ${col}`);
  }
  assert.ok(csv.includes(POLICY_SYS_ID), 'the export loses the sys_id the page shows');
  assert.match(csv, /^﻿/, 'without a BOM Excel mangles every non-ASCII character');
  assert.ok(csv.includes('\r\n'));
});

test('a spreadsheet cannot be made to execute what the model wrote', () => {
  recordToolEvent(SESSION, {
    kind: 'tool_call', name: 'note',
    payload: { text: '=HYPERLINK("http://evil","click")' },
    result: '+1+1', resultStatus: 'ok', mutating: false, approval: null,
  });
  const csv = auditCsv(auditRows({ session: SESSION }));
  // Excel and Sheets treat a leading =, +, - or @ as a formula. These cells
  // carry text a language model produced.
  assert.ok(!/,"=/.test(csv), 'a cell still starts with = and will be evaluated');
  assert.ok(csv.includes(`'+1+1`) || csv.includes(`"'+1+1"`), 'the result cell was not neutralised');
});

/**
 * A minimal RFC-4180 reader, so the assertion below is about the FILE rather
 * than about a substring I expected to see in it. The first draft asserted
 * `""hello""` and failed — correctly: the payload is stored as JSON, so the
 * quotes arrive already backslash-escaped and the doubled form is `\\""hello\\""`.
 * Reading the columns back is the property that actually matters.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && src[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

test('a quote in a payload does not shift every later column', () => {
  recordToolEvent(SESSION, {
    kind: 'tool_call', name: 'quoted',
    payload: { text: 'he said "hello", then left' },
    result: 'ok', resultStatus: 'ok', mutating: false, approval: null,
  });
  const parsed = parseCsv(auditCsv(auditRows({ session: SESSION })));
  const width = parsed[0].length;
  for (const r of parsed) assert.equal(r.length, width, 'a row has a different number of columns to the header');

  const name = parsed[0].indexOf('name');
  const payload = parsed[0].indexOf('payload');
  const quotedRow = parsed.find((r) => r[name] === 'quoted');
  assert.ok(quotedRow, 'the row with the quotes did not survive parsing');
  // The cell holds the payload as JSON, so the text survives one CSV unquoting
  // and one JSON parse — both, or the comma inside it would have split a column.
  assert.equal(JSON.parse(quotedRow[payload]).text, 'he said "hello", then left');
});
