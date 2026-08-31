import test from 'node:test';
import assert from 'node:assert/strict';

import { recoveryVerdict, DESTRUCTIVE_POLICY } from '../src/servicenow/dba-context.js';
import { assertFieldsHonoured, assertRestReachable, REACH, DbaMetadataError } from '../src/servicenow/dba-metadata.js';

/*
 * DBA Phase 0 — the offline half.
 *
 * What is worth testing here is not "does it call the instance", which only a
 * live run can answer, but WHICH VERDICT it reaches from a given set of
 * measurements. That is a pure function, and it is the one place where a wrong
 * answer becomes a promise to a user that their deleted record can be brought
 * back.
 *
 * Every fixture below is a real measurement from dev428633 (2026-08-31) or a
 * deliberate variation on one.
 */

const PLUGINS_MEASURED = {
  deleteRecovery: { id: 'com.glide.delete_recovery', active: true },
  restoreDeletedRecords: { id: 'com.snc.undelete', active: false },
};
const PLUGINS_BOTH = {
  deleteRecovery: { id: 'com.glide.delete_recovery', active: true },
  restoreDeletedRecords: { id: 'com.snc.undelete', active: true },
};
const PLUGINS_NEITHER = {
  deleteRecovery: { id: 'com.glide.delete_recovery', active: false },
  restoreDeletedRecords: { id: 'com.snc.undelete', active: false },
};

test('the measured dev428633 state is PARTIAL, and never rounds to recoverable', () => {
  const v = recoveryVerdict({ engine: { value: 'mysql' }, plugins: PLUGINS_MEASURED });
  assert.equal(v.state, 'partial');
  assert.equal(v.recordDelete, 'captured-but-not-restorable');
  // The whole point: no window is promised in the partial state.
  assert.equal(v.windowDays, undefined);
  assert.match(v.headline, /INACTIVE/);
  assert.match(v.headline, /Do not promise a 7-day recovery window/);
});

test('both plugins active on MySQL is the only state that offers a window, and it is labelled as documented not measured', () => {
  const v = recoveryVerdict({ engine: { value: 'mysql' }, plugins: PLUGINS_BOTH });
  assert.equal(v.state, 'full');
  assert.equal(v.recordDelete, 'recoverable');
  assert.equal(v.windowDays, 7);
  assert.match(v.windowSource, /documented, not measured/);
});

test('SQL Server is irreversible regardless of plugin state', () => {
  const v = recoveryVerdict({ engine: { value: 'sqlserver' }, plugins: PLUGINS_BOTH });
  assert.equal(v.state, 'none');
  assert.equal(v.recordDelete, 'irreversible');
  assert.equal(v.rollbackContexts, false);
});

test('Oracle keeps rollback contexts but loses delete recovery', () => {
  const v = recoveryVerdict({ engine: { value: 'oracle' }, plugins: PLUGINS_BOTH });
  assert.equal(v.state, 'none');
  assert.equal(v.recordDelete, 'irreversible');
  assert.equal(v.rollbackContexts, true);
});

test('Delete Recovery inactive on MySQL is none, not partial', () => {
  const v = recoveryVerdict({ engine: { value: 'mysql' }, plugins: PLUGINS_NEITHER });
  assert.equal(v.state, 'none');
  assert.equal(v.recordDelete, 'irreversible');
});

test('an undetermined engine degrades to unknown and NEVER defaults to mysql', () => {
  const v = recoveryVerdict({ engine: { value: null, error: 'the detection job did not report back' }, plugins: PLUGINS_BOTH });
  assert.equal(v.state, 'unknown');
  assert.equal(v.recordDelete, 'unknown');
  assert.equal(v.windowDays, undefined);
  assert.match(v.headline, /Treat every delete as irreversible/);
  assert.deepEqual(v.reasons, ['the detection job did not report back']);
});

test('an engine outside the rollback matrix is unknown, not silently permissive', () => {
  const v = recoveryVerdict({ engine: { value: 'postgres' }, plugins: PLUGINS_BOTH });
  assert.equal(v.state, 'unknown');
  assert.match(v.headline, /"postgres"/);
});

test('every irreversible DDL operation in the runbook matrix is listed, and each needs all three confirmations', () => {
  for (const op of ['drop_table', 'drop_column', 'truncate_table', 'rename_table', 'rename_column', 'change_column_type', 'decrease_column_width', 'reparent_column']) {
    assert.ok(DESTRUCTIVE_POLICY.irreversibleDdl.operations.includes(op), `${op} must be gated`);
  }
  assert.equal(DESTRUCTIVE_POLICY.irreversibleDdl.requires.length, 3);
});

/* ── the metadata client's two guards ─────────────────────────────────────── */

test('trap #4: a requested column that comes back on NO row is an error, not an empty value', () => {
  // Measured shape: the Table API returns 200 and simply omits the key.
  const rows = [{ element: 'number', internal_type: 'string' }, { element: 'state', internal_type: 'integer' }];
  assert.throws(
    () => assertFieldsHonoured('sys_dictionary', 'element,internal_type,reference_qual_typo', rows),
    (err) => {
      assert.ok(err instanceof DbaMetadataError);
      assert.match(err.message, /reference_qual_typo/);
      assert.match(err.message, /trap #4/);
      assert.deepEqual(err.detail.missing, ['reference_qual_typo']);
      return true;
    },
  );
});

test('a column present on only SOME rows is fine — the Table API omits empty values', () => {
  const rows = [{ element: 'number', reference: '' }, { element: 'caller_id' }];
  assert.doesNotThrow(() => assertFieldsHonoured('sys_dictionary', 'element,reference', rows));
});

test('an empty result set cannot prove a column absent, so it does not try', () => {
  assert.doesNotThrow(() => assertFieldsHonoured('sys_dictionary', 'element,nonexistent', []));
});

test('the REST-unreachable tables refuse by name and point at the path that works', () => {
  assert.throws(() => assertRestReachable('sys_index'), (err) => {
    assert.match(err.message, /server-side script/);
    assert.equal(err.detail.via, 'server-script');
    return true;
  });
  assert.throws(() => assertRestReachable('sys_plugins'), /v_plugin/);
  assert.throws(() => assertRestReachable('sys_index_ii'), /does not exist on this instance/);
  // Readable but useless is its own state, and it is recorded rather than hidden.
  assert.doesNotThrow(() => assertRestReachable('v_db_index'));
  assert.equal(REACH.v_db_index.via, 'inert');
});

test('an ordinary metadata table is not gated', () => {
  for (const t of ['sys_db_object', 'sys_dictionary', 'sys_glide_object', 'sys_choice', 'sys_relationship']) {
    assert.doesNotThrow(() => assertRestReachable(t));
  }
});
