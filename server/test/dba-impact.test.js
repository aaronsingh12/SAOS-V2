import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyOperation, KNOWN_OPERATIONS, OPERATION_MATRIX } from '../src/servicenow/dba-impact.js';

/*
 * DBA Layer 2 — the offline half.
 *
 * `classifyOperation` is tested with `withContext: false`, which is the pure
 * path: no instance read, just the §1.5 matrix. The engine-dependent half is
 * covered live, because what it asserts is the INSTANCE's answer and a fixture
 * of that would only assert that the fixture was copied correctly.
 *
 * What matters here is that no irreversible operation can ever be described as
 * reversible. That is the one bug in this module that becomes a user
 * authorising the destruction of data they were told could be restored.
 */

const IRREVERSIBLE = [
  'drop_table', 'drop_column', 'truncate_table', 'rename_table',
  'rename_column', 'change_column_type', 'decrease_column_width', 'reparent_column',
];

for (const op of IRREVERSIBLE) {
  test(`${op} is irreversible, says so in words, and demands all three confirmations`, async () => {
    const r = await classifyOperation(op, { withContext: false });
    assert.equal(r.known, true);
    assert.equal(r.reversible, false);
    assert.equal(r.actsOn, 'schema');
    assert.match(r.statement, /CANNOT be undone/);
    assert.match(r.statement, /Do not describe it as reversible/);
    assert.equal(r.requiredConfirmations.length, 3);
    assert.ok(r.reason && r.reason.length > 10, 'an irreversible op must carry a reason');
    // No engine gets to make these reversible.
    assert.match(r.statement, /on any database engine/);
  });
}

test('drop_index is the one DDL-shaped operation that IS recoverable', async () => {
  const r = await classifyOperation('drop_index', { withContext: false });
  assert.equal(r.reversible, true);
  assert.equal(r.actsOn, 'schema');
  assert.match(r.mechanism, /recreate/);
});

test('an unknown operation is treated as irreversible rather than allowed', async () => {
  const r = await classifyOperation('vacuum_the_database', { withContext: false });
  assert.equal(r.known, false);
  assert.equal(r.verdict, 'unknown');
  assert.match(r.guidance, /IRREVERSIBLE until it is classified/);
  // It must not accidentally look permissive.
  assert.notEqual(r.reversible, true);
  assert.ok(Array.isArray(r.knownOperations) && r.knownOperations.length > 5);
});

test('every operation in the matrix declares what it acts on', () => {
  for (const [op, spec] of Object.entries(OPERATION_MATRIX)) {
    assert.ok(['schema', 'data', 'platform'].includes(spec.acts_on), `${op} must declare acts_on`);
  }
});

test('record_delete acts on data, not schema — so schema rules must not gate it', () => {
  assert.equal(OPERATION_MATRIX.record_delete.acts_on, 'data');
});

test('every irreversible entry is a schema operation, and every schema drop is irreversible', () => {
  for (const [op, spec] of Object.entries(OPERATION_MATRIX)) {
    if (spec.reversible === false) assert.equal(spec.acts_on, 'schema', `${op} is irreversible but not tagged schema`);
  }
  for (const op of IRREVERSIBLE) {
    assert.equal(OPERATION_MATRIX[op].reversible, false, `${op} must stay irreversible`);
  }
});

test('the runbook §1.5 matrix is represented in full', () => {
  for (const op of [...IRREVERSIBLE, 'record_delete', 'background_script', 'plugin_activation', 'patch_upgrade', 'drop_index']) {
    assert.ok(KNOWN_OPERATIONS.includes(op), `${op} is missing from the operation matrix`);
  }
});

test('background_script carries the "only if Record for Rollback was set" caveat', async () => {
  const r = await classifyOperation('background_script', { withContext: false });
  assert.match(r.note, /Record for Rollback/);
});

test('record_delete without instance context does not invent a recovery window', async () => {
  const r = await classifyOperation('record_delete', { withContext: false });
  // The static matrix says recoverable, but with no instance read there is no
  // window and no verdict to quote.
  assert.equal(r.retentionDays, undefined);
  assert.equal(r.liveRecoveryVerdict, undefined);
  assert.match(r.note, /SUBJECT TO the engine/);
});
