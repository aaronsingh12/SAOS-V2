import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyFromRow } from '../src/servicenow/dba-schema.js';
import {
  classificationBadge, describeIndexes, filterTables,
} from '../../client/src/components/tableClassification.js';

/*
 * T1 — the Tables pane, read only.
 *
 * The rules worth pinning are the honesty ones, not the layout:
 *
 *   1. The LIST classifies from the sys_db_object row alone, because the full
 *      check costs two extra queries per table. That is enough to be certain a
 *      table is CUSTOM, and not enough to certify a platform table as pristine
 *      — so the list says `ootb`, never `core-ootb`.
 *   2. Indexes are never drawn as zero. sys_index is 403 over REST here, and
 *      every table has at least a primary key, so a rendered 0 would be a lie.
 */

test('a custom-prefixed table in a scope is fully decided by the row', () => {
  const c = classifyFromRow({ name: 'x_2002152_nwforge_emp_assets', sys_scope: '8e72' });
  assert.equal(c.category, 'custom-in-scope');
  assert.equal(c.customPrefix, true);
});

test('a custom-prefixed table in global is custom-global', () => {
  assert.equal(classifyFromRow({ name: 'u_legacy_thing', sys_scope: 'global' }).category, 'custom-global');
});

test('a platform table is `ootb`, NOT `core-ootb`, in the list', () => {
  // core-ootb is a claim that the customization check ran and found nothing.
  // The list never runs it, so the list may never make that claim.
  const c = classifyFromRow({ name: 'incident', sys_scope: 'global' });
  assert.equal(c.category, 'ootb');
  assert.notEqual(c.category, 'core-ootb');
  assert.equal(c.customized, null);
  assert.equal(c.customizationChecked, false);
  assert.match(c.note, /was not checked here/i);
});

test('the badge shows an unchecked classification as unchecked', () => {
  const listBadge = classificationBadge(classifyFromRow({ name: 'incident', sys_scope: 'global' }));
  assert.equal(listBadge.label, 'OOTB');
  assert.equal(listBadge.checked, false);
  assert.match(listBadge.title, /NOT checked/);

  // The detail view ran the real classify, so its badge is a stronger claim.
  const detailBadge = classificationBadge({ category: 'core-ootb', customizationChecked: true });
  assert.equal(detailBadge.label, 'core OOTB');
  assert.equal(detailBadge.checked, true);
});

test('a customized platform table is visibly different from a pristine one', () => {
  const pristine = classificationBadge({ category: 'core-ootb', customizationChecked: true });
  const touched = classificationBadge({ category: 'ootb-customized', customizationChecked: true });
  assert.notEqual(pristine.label, touched.label);
  assert.equal(touched.tone, 'amber');
});

test('an absent classification is flagged, not rendered blank', () => {
  const b = classificationBadge(null);
  assert.equal(b.label, 'unclassified');
  assert.equal(b.tone, 'amber');
});

/* ── indexes: the honest unavailable ─────────────────────────────────────── */

test('an unavailable index read renders as UNAVAILABLE, never as zero', () => {
  const v = describeIndexes({
    available: false, complete: false, failure: 'harness-unavailable',
    reason: 'The index read did not report back before the timeout.',
    zeroMeans: 'Nothing was read, so there is no count to interpret.',
    definitionRecordCount: null, indexes: null,
  });
  assert.equal(v.kind, 'unavailable');
  assert.equal(v.tone, 'amber');
  assert.equal(v.isHarness, true);
  assert.match(v.reason, /did not report back/);
});

test('a genuine zero is still not "no indexes"', () => {
  // Read successfully AND zero definition records — which is a real state, and
  // still not the same as the table having no indexes.
  const v = describeIndexes({
    available: true, complete: false, definitionRecordCount: 0, indexes: [],
    zeroMeans: 'No index DEFINITION RECORD exists for incident. That is NOT the same as "incident has no indexes".',
  });
  assert.equal(v.kind, 'zero');
  assert.equal(v.tone, 'amber');
  assert.match(v.reason, /NOT the same as/);
});

test('real index records render as a list', () => {
  const v = describeIndexes({
    available: true, complete: false, definitionRecordCount: 2,
    indexes: [{ column: 'number', unique: true }, { column: 'state', unique: false }],
  });
  assert.equal(v.kind, 'list');
  assert.equal(v.count, 2);
});

test('a script error and a harness outage are distinguishable', () => {
  const scriptErr = describeIndexes({ available: false, failure: 'script-error', reason: 'sys_index is not valid' });
  assert.equal(scriptErr.isHarness, false);
  assert.equal(scriptErr.kind, 'unavailable');
});

/* ── filtering ────────────────────────────────────────────────────────────── */

const TABLES = [
  { name: 'incident', label: 'Incident', scope: 'global', classification: { customPrefix: false, category: 'ootb' } },
  { name: 'x_2002152_nwforge_asset', label: 'DBA Demo Asset', scope: '8e72', classification: { customPrefix: true, category: 'custom-in-scope' } },
  { name: 'task', label: 'Task', scope: 'global', classification: { customPrefix: false, category: 'ootb' } },
];

test('filtering matches name OR label, case-insensitively', () => {
  assert.deepEqual(filterTables(TABLES, { q: 'INC' }).map((t) => t.name), ['incident']);
  assert.deepEqual(filterTables(TABLES, { q: 'demo asset' }).map((t) => t.name), ['x_2002152_nwforge_asset']);
});

test('custom / OOTB filters split on the prefix, the same rule classify uses', () => {
  assert.deepEqual(filterTables(TABLES, { kind: 'custom' }).map((t) => t.name), ['x_2002152_nwforge_asset']);
  assert.deepEqual(filterTables(TABLES, { kind: 'ootb' }).map((t) => t.name), ['incident', 'task']);
});

test('the scope filter is exact — a scope is an identity, not a search', () => {
  assert.deepEqual(filterTables(TABLES, { scope: '8e72' }).map((t) => t.name), ['x_2002152_nwforge_asset']);
  assert.deepEqual(filterTables(TABLES, { scope: 'nope' }), []);
});

test('filters combine', () => {
  assert.deepEqual(filterTables(TABLES, { q: 'a', kind: 'ootb', scope: 'global' }).map((t) => t.name), ['task']);
});

test('an empty input list filters to empty without throwing', () => {
  assert.deepEqual(filterTables(null, { q: 'x' }), []);
});
