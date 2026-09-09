import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate, getDb } from '../src/memory/db.js';
import { createSession } from '../src/memory/sessions.js';
import { startMode, endMode } from '../src/memory/impersonation-mode.js';
import {
  AUDIT_STATUS, recordWriteIntent, confirmWriteIntent, abortWriteIntent,
  unconfirmedIntents, whoReallyDid,
} from '../src/memory/impersonation-audit.js';
import {
  buildImpersonationBody, WRITE_MODES, OP_MODES,
} from '../src/servicenow/impersonation.js';
import {
  wrapWithSentinel, mintSentinel, validateScriptSyntax,
} from '../src/servicenow/script-liveness.js';

/**
 * B7 — the impersonated write path.
 *
 * The highest-risk operation in the feature: a mutation that persists on a real
 * instance, attributed to a real person, with every measured trap live at once.
 * What is provable offline is the SHAPE — the generated script, and the
 * write-ahead state machine that has to survive a crash at any point.
 */

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-b7-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const ADMIN = '6816f79cc0a8016401c5a33be04be441';
const TARGET = { sys_id: '555a640583fe0f10b939cc65eeaad3a2', user_name: 'aagamya.tanwar', display: 'Aagamya Tanwar' };
const ORIGINAL = { sys_id: ADMIN, user_name: 'admin' };
const RECORD = '2ec9c1ab83ba4390b939cc65eeaad378';

let n = 0;
function impersonatingSession() {
  const id = `b7-${++n}`;
  createSession({ id, title: 'b7' });
  startMode({ sessionId: id, target: TARGET, original: ORIGINAL, task: 'log an incident for the user' });
  return id;
}

const bodyFor = (op) => buildImpersonationBody({ adminSysId: ADMIN, targetSysId: TARGET.sys_id, op });

/* ------------------------------------------------------------------ *
 * The generated write script
 * ------------------------------------------------------------------ */

test('migration 13 adds the write-ahead columns', () => {
  const cols = getDb().prepare('PRAGMA table_info(impersonation_audit)').all().map((c) => c.name);
  for (const c of ['status', 'intent_at', 'confirmed_at', 'abort_reason', 'attributed_user_name']) {
    assert.ok(cols.includes(c), c);
  }
});

test('every write mode generates a script that passes BOTH pre-dispatch nets', () => {
  for (const op of [
    { mode: 'create', table: 'incident', data: { short_description: 'x' } },
    { mode: 'update', table: 'incident', sys_id: RECORD, data: { state: '2' } },
    { mode: 'delete', table: 'incident', sys_id: RECORD },
  ]) {
    const wrapped = wrapWithSentinel({ body: bodyFor(op), sentinel: mintSentinel(), marker: 'NHA_IMP::' });
    const v = validateScriptSyntax(wrapped);
    assert.equal(v.ok, true, `${op.mode}: ${JSON.stringify(v.errors)}`);
  }
});

test("the operation's OWN capability flag gates dispatch, and it is asked first", () => {
  const create = bodyFor({ mode: 'create', table: 'incident', data: { short_description: 'x' } });
  assert.ok(create.includes('if (!probe.canCreate())'));
  assert.ok(create.indexOf('probe.canCreate()') < create.indexOf('w.insert()'), 'the flag must be read before the write');
  assert.ok(create.includes("reason: 'preflight_denied'"));

  assert.ok(bodyFor({ mode: 'update', table: 'incident', sys_id: RECORD, data: {} }).includes('if (!probe.canWrite())'));
  assert.ok(bodyFor({ mode: 'delete', table: 'incident', sys_id: RECORD }).includes('if (!probe.canDelete())'));
});

test('update and delete POSITION as the target, and a record they cannot see gets its own reason', () => {
  for (const mode of ['update', 'delete']) {
    const b = bodyFor({ mode, table: 'incident', sys_id: RECORD, data: { state: '2' } });
    assert.ok(b.includes(`new GlideRecordSecure("incident")`));
    assert.ok(b.includes(`if (!w.get("${RECORD}"))`), 'must position through GlideRecordSecure');
    assert.ok(b.includes("reason: 'target_cannot_see_record'"),
      'the measured silent shape needs its own name, not a generic failure');
  }
});

test('writes go through GlideRecordSecure and setValue — never a plain GlideRecord, never concatenation', () => {
  const b = bodyFor({ mode: 'create', table: 'incident', data: { short_description: "x'); gs.info('pwned" } });
  assert.ok(!/new GlideRecord\("incident"\)\s*;\s*\n\s*w\./.test(b), 'the write object must be secure');
  assert.ok(b.includes('w.setValue(pk, payload[pk])'));
  // The hostile value survives only as JSON.
  const literal = b.match(/var payload = (\{.*?\});/)[1];
  assert.deepEqual(JSON.parse(literal), { short_description: "x'); gs.info('pwned" });
});

test('the write is read back TWICE — as the target, then as admin for attribution', () => {
  const b = bodyFor({ mode: 'create', table: 'incident', data: { short_description: 'x' } });
  // As the target, still impersonated.
  assert.ok(b.includes('out.result.readback_as_target'));
  assert.ok(b.includes('var back = new GlideRecordSecure("incident")'));
  // As admin, AFTER the revert — a target who cannot read would report "gone"
  // for a record that is sitting right there.
  assert.ok(b.includes('out.attribution'));
  assert.ok(b.includes("sys_created_by: attr.getValue('sys_created_by')"));
  assert.ok(b.indexOf('} finally {') < b.indexOf('out.attribution'), 'attribution must be read after the revert');
});

test('a read op gains no write machinery', () => {
  const b = bodyFor({ mode: 'read', table: 'incident' });
  assert.ok(!b.includes('out.attribution'));
  assert.ok(!b.includes('w.insert()'));
  assert.ok(!b.includes('deleteRecord'));
});

test('update and delete demand a live-resolved sys_id', () => {
  for (const mode of ['update', 'delete']) {
    assert.throws(() => bodyFor({ mode, table: 'incident', sys_id: 'not-a-sys-id' }), /32-character hex sys_id/);
    assert.throws(() => bodyFor({ mode, table: 'incident' }), /32-character hex sys_id/);
  }
});

test('the mode list actually carries the write modes', () => {
  for (const m of WRITE_MODES) assert.ok(OP_MODES.includes(m), m);
  assert.deepEqual(WRITE_MODES, ['create', 'update', 'delete']);
});

/* ------------------------------------------------------------------ *
 * The write-ahead state machine
 * ------------------------------------------------------------------ */

const intentFor = (s) => recordWriteIntent({
  sessionId: s, turnSeq: 1, tool: 'create_record', table: 'incident',
  operation: 'create', requested: { short_description: 'x' },
});

test('intent is recorded BEFORE anything is dispatched, and knows the real initiator already', () => {
  const s = impersonatingSession();
  const r = intentFor(s);
  assert.equal(r.recorded, true);
  assert.equal(r.row.status, AUDIT_STATUS.INTENT);
  assert.equal(r.row.real_initiator_sys_id, ADMIN, 'the initiator is known before the write, not after');
  assert.equal(r.row.target_user_name, 'aagamya.tanwar');
  assert.equal(r.row.executed_impersonated, 1);
  assert.ok(r.row.intent_at);
  assert.equal(r.row.confirmed_at, null);
});

test('confirming records what the INSTANCE said, not what we intended', () => {
  const s = impersonatingSession();
  const { id } = intentFor(s);
  const c = confirmWriteIntent(id, {
    sysId: RECORD, verificationStatus: 'applied', attributedUserName: 'aagamya.tanwar',
  });
  assert.equal(c.confirmed, true);
  assert.equal(c.row.status, AUDIT_STATUS.CONFIRMED);
  assert.equal(c.row.attributed_user_name, 'aagamya.tanwar');
  assert.equal(c.row.sys_id, RECORD);
  assert.ok(c.row.confirmed_at);
});

test('a refused write is ABORTED, and abort is not the same state as unconfirmed', () => {
  const s = impersonatingSession();
  const { id } = intentFor(s);
  const a = abortWriteIntent(id, 'preflight_denied');
  assert.equal(a.aborted, true);
  assert.equal(a.row.status, AUDIT_STATUS.ABORTED);
  assert.equal(a.row.abort_reason, 'preflight_denied');
  // And it is not reported as an unresolved unknown.
  assert.ok(!unconfirmedIntents().some((r) => r.id === id));
});

test('an aborted write can never be confirmed afterwards', () => {
  const s = impersonatingSession();
  const { id } = intentFor(s);
  abortWriteIntent(id, 'preflight_denied');
  const c = confirmWriteIntent(id, { sysId: RECORD });
  assert.equal(c.confirmed, false);
  assert.match(c.reason, /aborted and cannot be confirmed/);
});

test('a confirmed write can never be quietly aborted afterwards', () => {
  const s = impersonatingSession();
  const { id } = intentFor(s);
  confirmWriteIntent(id, { sysId: RECORD, attributedUserName: 'aagamya.tanwar' });
  const a = abortWriteIntent(id, 'changed my mind');
  assert.equal(a.aborted, false);
  assert.match(a.reason, /already confirmed/);
});

test('a crash between intent and confirm leaves an UNCONFIRMED row — findable, not silent', () => {
  const s = impersonatingSession();
  const { id } = intentFor(s);           // ...and then the process dies.
  const open = unconfirmedIntents({ olderThanMs: 0 });
  assert.ok(open.some((r) => r.id === id), 'the unresolved write must be discoverable');

  // The lookup surfaces it rather than answering confidently.
  confirmWriteIntent(id, { sysId: 'crash000crash000crash000crash000' });
  const s2 = impersonatingSession();
  const orphan = recordWriteIntent({
    sessionId: s2, turnSeq: 1, tool: 'update_record', table: 'incident',
    sysId: 'orphan00orphan00orphan00orphan00', operation: 'update', requested: { state: '2' },
  });
  const r = whoReallyDid('orphan00orphan00orphan00orphan00');
  assert.equal(r.found, true);
  assert.equal(r.unconfirmed, true);
  assert.equal(r.status, AUDIT_STATUS.INTENT);
  assert.match(r.warning, /may or may not have landed/);
  assert.equal(r.real_initiator.user_name, 'admin', 'the initiator is known even for an unconfirmed write');
  assert.ok(orphan.recorded);
});

test('an aborted write is NOT returned as the author of a record — it never happened', () => {
  const s = impersonatingSession();
  const { id } = recordWriteIntent({
    sessionId: s, turnSeq: 1, tool: 'update_record', table: 'incident',
    sysId: 'aborted0aborted0aborted0aborted0', operation: 'update', requested: {},
  });
  abortWriteIntent(id, 'preflight_denied');
  const r = whoReallyDid('aborted0aborted0aborted0aborted0');
  assert.equal(r.found, false, 'attributing a change that was never made would be worse than saying nothing');
});

test('no intent is recorded when nothing is being impersonated', () => {
  const id = 'b7-plain';
  createSession({ id, title: 'plain' });
  const r = recordWriteIntent({ sessionId: id, tool: 'create_record', table: 'incident', operation: 'create' });
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'not-impersonating');
});

test('provenance outlives the mode that produced it', () => {
  const s = impersonatingSession();
  const { id } = recordWriteIntent({
    sessionId: s, turnSeq: 1, tool: 'create_record', table: 'incident',
    sysId: 'outlive0outlive0outlive0outlive0', operation: 'create', requested: {},
  });
  confirmWriteIntent(id, { sysId: 'outlive0outlive0outlive0outlive0', attributedUserName: 'aagamya.tanwar' });
  endMode(s);
  const r = whoReallyDid('outlive0outlive0outlive0outlive0');
  assert.equal(r.found, true);
  assert.equal(r.instance_attribution, 'aagamya.tanwar');
  assert.equal(r.real_initiator.user_name, 'admin');
});

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

const { TOOLS } = await import('../src/agent/tools.js');
const { willExecuteImpersonated } = await import('../src/agent/impersonated-write.js');

test('exactly the record-mutating tools are routable, and they are declared', () => {
  const routable = TOOLS.filter((t) => t.impersonable).map((t) => t.name).sort();
  assert.deepEqual(routable, ['create_record', 'delete_record', 'update_record']);
  for (const t of TOOLS.filter((x) => x.impersonable)) {
    assert.equal(t.mutating, true, `${t.name} must still pass the approval gate`);
  }
});

test('routing happens only when mode is active AND the tool declares it', () => {
  const s = impersonatingSession();
  const plain = 'b7-noimp';
  createSession({ id: plain, title: 'x' });

  const create = TOOLS.find((t) => t.name === 'create_record');
  const read = TOOLS.find((t) => t.name === 'get_table_schema');

  assert.equal(willExecuteImpersonated(s, create), true);
  assert.equal(willExecuteImpersonated(s, read), false, 'a non-declaring tool is never routed');
  assert.equal(willExecuteImpersonated(plain, create), false, 'mode off means the ordinary path');
  assert.equal(willExecuteImpersonated(s, null), false);
});
