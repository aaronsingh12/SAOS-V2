import test from 'node:test';
import assert from 'node:assert/strict';

import { shapeField, shapeOverride } from '../src/servicenow/dba-schema.js';

/*
 * DBA Layer 1 — the offline half.
 *
 * Both functions under test turn one measured row into a verdict, and both
 * exist because the naive reading of that row is wrong in a way that produces
 * confident nonsense rather than an error. Fixtures are real column shapes from
 * dev428633 (2026-08-31).
 */

const CHAIN = ['incident', 'task'];

test('a reference qualifier is reported only when one actually exists', () => {
  // MEASURED: use_reference_qualifier reads "simple" on a great many fields
  // that carry no qualifier at all. Echoing it would invent configuration.
  const noQual = shapeField({
    element: 'caller_id', internal_type: 'reference', reference: 'sys_user',
    use_reference_qualifier: 'simple', reference_qual: '', dynamic_ref_qual: '', reference_qual_condition: '',
    name: 'incident',
  }, CHAIN);
  assert.equal(noQual.qualifier, null);

  const withQual = shapeField({
    element: 'assignment_group', internal_type: 'reference', reference: 'sys_user_group',
    use_reference_qualifier: 'simple', reference_qual: 'type=itil', dynamic_ref_qual: '', reference_qual_condition: '',
    name: 'task',
  }, CHAIN);
  assert.equal(withQual.qualifier.kind, 'simple');
  assert.equal(withQual.qualifier.simple, 'type=itil');
});

test('a dynamic qualifier keeps its kind', () => {
  const f = shapeField({
    element: 'x', internal_type: 'reference', reference: 'sys_user',
    use_reference_qualifier: 'dynamic', dynamic_ref_qual: 'abc123', reference_qual: '', reference_qual_condition: '',
    name: 'incident',
  }, CHAIN);
  assert.equal(f.qualifier.kind, 'dynamic');
  assert.equal(f.qualifier.dynamic, 'abc123');
});

test('inherited is decided against the chain head, not guessed from the name', () => {
  assert.equal(shapeField({ element: 'number', name: 'task', internal_type: 'string' }, CHAIN).inherited, true);
  assert.equal(shapeField({ element: 'category', name: 'incident', internal_type: 'string' }, CHAIN).inherited, false);
  assert.equal(shapeField({ element: 'number', name: 'task', internal_type: 'string' }, CHAIN).definedOn, 'task');
});

test('the string "false" is false and a missing active flag is active', () => {
  const f = shapeField({ element: 'x', name: 'incident', internal_type: 'string', mandatory: 'false', read_only: 'true', unique: 'false' }, CHAIN);
  assert.equal(f.mandatory, false);
  assert.equal(f.readOnly, true);
  assert.equal(f.unique, false);
  // `active` absent from the row must not read as inactive.
  assert.equal(f.active, true);
  assert.equal(shapeField({ element: 'x', name: 'incident', active: 'false' }, CHAIN).active, false);
});

/* ── overrides: the value is inert without its flag ───────────────────────── */

test('an override row with no _override flag set overrides NOTHING', () => {
  // MEASURED shape: real rows carry mandatory:"false"/read_only:"false" with
  // every _override flag false. Reading the values alone reports overrides that
  // are not in effect.
  const o = shapeOverride({
    name: 'vtb_task', base_table: 'task', element: 'assigned_to',
    mandatory: 'false', mandatory_override: 'false',
    read_only: 'false', read_only_override: 'false',
    default_value: '', default_value_override: 'false',
    attributes: '', attributes_override: 'false',
  });
  assert.deepEqual(o.overriddenAttributes, []);
  assert.deepEqual(o.values, {});
});

test('only the flagged attributes are reported, with their values', () => {
  const o = shapeOverride({
    name: 'sn_child', base_table: 'task', element: 'short_description',
    mandatory: 'true', mandatory_override: 'true',
    read_only: 'true', read_only_override: 'false',
    default_value: 'hello', default_value_override: 'true',
    reference_qual: 'active=true', reference_qual_override: 'false',
  });
  assert.deepEqual(o.overriddenAttributes.sort(), ['default_value', 'mandatory']);
  assert.deepEqual(o.values, { mandatory: 'true', default_value: 'hello' });
  // read_only is set on the row but not flagged — it must not appear.
  assert.equal('read_only' in o.values, false);
  assert.equal('reference_qual' in o.values, false);
});

test('a display override is carried separately, since it has no value half', () => {
  const o = shapeOverride({ name: 'c', base_table: 'task', element: 'e', display_override: 'true' });
  assert.equal(o.displayOverridden, true);
});

test('the child and base tables are both kept — an override is a pair, not a table', () => {
  const o = shapeOverride({ name: 'vtb_task', base_table: 'task', element: 'assigned_to', mandatory_override: 'true', mandatory: 'true' });
  assert.equal(o.childTable, 'vtb_task');
  assert.equal(o.baseTable, 'task');
  assert.equal(o.element, 'assigned_to');
});
