import test from 'node:test';
import assert from 'node:assert/strict';

import {
  previewName, validateCreateForm, parseChoices, toCreateSpec, describeModify, describeDropGate,
} from '../../client/src/components/tableForms.js';
import { tableSpecConstraints, normalizeTableSpec, validateTableSpec } from '../src/servicenow/dba-authoring.js';

/*
 * T2 — the forms carry the constraints, the gated tools carry the safety.
 *
 * The failures a weak runtime model produced in free-form chat were SHAPE
 * failures: a forgotten scope prefix, a name over the 30-character cap, an
 * invented column type. A form can make those unrepresentable, and that is the
 * whole point of this phase — so these tests assert that an invalid spec is
 * UNSUBMITTABLE, not submitted-then-rejected.
 *
 * The constraints are the server's own, not a copy: every test below builds
 * them with `tableSpecConstraints`, so if the SDK grows a column type the form
 * offers it without anyone editing the form — and if the form and the tool ever
 * disagreed about a rule, the round-trip test at the bottom fails.
 */

const C = tableSpecConstraints('x_2002152_nwforge');

const FORM = {
  name: 'emp_assets',
  label: 'Employee Assets',
  fields: [{ name: 'employee_name', type: 'string', label: 'Employee Name' }],
};

test('the scope prefix is applied for the user, and previewed', () => {
  assert.equal(previewName('emp_assets', C).name, 'x_2002152_nwforge_emp_assets');
  // Already prefixed stays as it is — the prefix is not applied twice.
  assert.equal(previewName('x_2002152_nwforge_emp_assets', C).name, 'x_2002152_nwforge_emp_assets');
});

test('a valid spec is submittable', () => {
  const v = validateCreateForm(FORM, C);
  assert.equal(v.ok, true, v.problems.map((p) => p.message).join(' | '));
  assert.equal(v.resolvedName, 'x_2002152_nwforge_emp_assets');
});

test('a name over the cap is UNSUBMITTABLE, with the room stated', () => {
  const v = validateCreateForm({ ...FORM, name: 'employee_assets_register_master' }, C);
  assert.equal(v.ok, false);
  const p = v.problems.find((x) => x.field === 'name');
  assert.match(p.message, /cap is 30/);
  assert.match(p.message, /leaves 12/);
});

test('an invented column type is UNSUBMITTABLE — the offered list is the supported list', () => {
  // This is the GlideDateTimeColumn class of failure, closed at the form.
  const v = validateCreateForm({ ...FORM, fields: [{ name: 'a', type: 'timestamp_thing' }] }, C);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /not a column type this layer can emit/.test(p.message)));
});

test('date IS offered, because the SDK really emits it', () => {
  assert.ok(C.columnTypes.includes('date'));
  assert.equal(validateCreateForm({ ...FORM, fields: [{ name: 'assigned_date', type: 'date' }] }, C).ok, true);
});

test('every violation is reported at once, not one at a time', () => {
  const v = validateCreateForm({
    name: '', label: '',
    fields: [{ name: 'dup', type: 'string' }, { name: 'dup', type: 'nope' }, { name: 'r', type: 'reference' }],
    display: 'not_a_column',
  }, C);
  assert.ok(v.problems.length >= 5, `got ${v.problems.length}: ${v.problems.map((p) => p.message).join(' | ')}`);
  assert.ok(v.problems.some((p) => p.field === 'name'));
  assert.ok(v.problems.some((p) => p.field === 'label'));
  assert.ok(v.problems.some((p) => /defined twice/.test(p.message)));
  assert.ok(v.problems.some((p) => /must name the table it points at/.test(p.message)));
  assert.ok(v.problems.some((p) => p.field === 'display'));
});

test('a reference column without a target is unsubmittable', () => {
  assert.equal(validateCreateForm({ ...FORM, fields: [{ name: 'owner', type: 'reference' }] }, C).ok, false);
  assert.equal(validateCreateForm({ ...FORM, fields: [{ name: 'owner', type: 'reference', reference: 'sys_user' }] }, C).ok, true);
});

test('choices parse from either commas or lines, with or without labels', () => {
  assert.deepEqual(parseChoices('0=Laptop, 1=Desktop'), { 0: 'Laptop', 1: 'Desktop' });
  assert.deepEqual(parseChoices('open\nclosed'), { open: 'open', closed: 'closed' });
});

/* ── the form and the tool must agree ─────────────────────────────────────── */

test('a spec the FORM accepts is one the TOOL accepts — no round-trip rejection', () => {
  // The acceptance for this phase in one assertion: if these two ever disagree,
  // the pane would let a user submit something the server then refuses.
  const spec = toCreateSpec({
    name: 'emp_assets',
    label: 'Employee Assets',
    display: 'employee_name',
    fields: [
      { name: 'employee_name', type: 'string', label: 'Employee Name', maxLength: 100 },
      { name: 'assigned_date', type: 'date', label: 'Assigned Date' },
      { name: 'asset_type', type: 'choice', label: 'Asset Type', choices: '0=Laptop, 1=Desktop' },
      { name: 'owner', type: 'reference', label: 'Owner', reference: 'sys_user' },
    ],
  }, C);

  assert.equal(validateCreateForm({
    name: 'emp_assets', label: 'Employee Assets', display: 'employee_name',
    fields: [
      { name: 'employee_name', type: 'string' }, { name: 'assigned_date', type: 'date' },
      { name: 'asset_type', type: 'choice', choices: '0=Laptop' }, { name: 'owner', type: 'reference', reference: 'sys_user' },
    ],
  }, C).ok, true);

  const { spec: normalized } = normalizeTableSpec(spec, { scope: 'x_2002152_nwforge' });
  const checked = validateTableSpec(normalized, { scope: 'x_2002152_nwforge' });
  assert.deepEqual(checked.errors, [], 'the tool must accept what the form accepted');
  assert.equal(checked.normalized.extends, null, 'standalone unless asked');
});

test('extends is opt-in and survives to the spec when asked for', () => {
  assert.equal(toCreateSpec(FORM, C).extends, undefined);
  assert.equal(toCreateSpec({ ...FORM, extendsTable: 'task' }, C).extends, 'task');
});

/* ── modify: the safe half only ───────────────────────────────────────────── */

const CURRENT = { element: 'u_name', type: 'string', label: 'Name', hint: '', help: '', defaultValue: '', maxLength: 40 };

test('label / hint / help / widen are submittable as ordinary edits', () => {
  const m = describeModify(CURRENT, { label: 'Full Name', hint: 'Their name', maxLength: 200 });
  assert.equal(m.submittable, true);
  assert.deepEqual(m.safe.map((s) => s.option).sort(), ['hint', 'label', 'maxLength']);
  assert.deepEqual(m.gated, []);
});

test('NARROWING is named as gated and is NOT submittable here', () => {
  const m = describeModify(CURRENT, { maxLength: 10 });
  assert.equal(m.submittable, false);
  assert.equal(m.gated[0].operation, 'decrease_column_width');
  assert.match(m.reason, /irreversible and gated/);
});

test('RETYPING is named as gated and is NOT submittable here', () => {
  const m = describeModify(CURRENT, { type: 'integer' });
  assert.equal(m.submittable, false);
  assert.equal(m.gated[0].operation, 'change_column_type');
});

test('a MIXED request is refused whole — the safe half does not sneak through', () => {
  const m = describeModify(CURRENT, { label: 'Fine', maxLength: 5 });
  assert.equal(m.submittable, false);
  assert.equal(m.safe.length, 1, 'the safe part is still described…');
  assert.match(m.reason, /not applied on their own/, '…but explicitly not applied');
});

test('a no-op change is not submittable', () => {
  const m = describeModify(CURRENT, { label: 'Name', maxLength: 40 });
  assert.equal(m.submittable, false);
  assert.match(m.reason, /Nothing would change/);
});

/* ── drop: the gate, shown as it is ───────────────────────────────────────── */

const GATE = {
  requiredPhrase: 'DROP COLUMN x_demo.u_name PERMANENTLY',
  statement: 'drop_column on x_demo.u_name CANNOT be undone.',
  requirements: [
    { key: 'escalation', how: 'A human must enable irreversible schema operations in Settings.' },
    { key: 'snapshot', how: 'Run dba_snapshot first.' },
    { key: 'typedConfirmation', how: 'Type exactly: DROP COLUMN x_demo.u_name PERMANENTLY' },
    { key: 'impactAcknowledged', how: 'Read the impact report and acknowledge it.' },
  ],
  unmet: [{ requirement: 'escalation' }, { requirement: 'snapshot' }, { requirement: 'typedConfirmation' }, { requirement: 'impactAcknowledged' }],
};

test('the drop gate is shown with all four requirements, none of them met', () => {
  const g = describeDropGate(GATE);
  assert.equal(g.ready, false);
  assert.equal(g.requirements.length, 4);
  assert.ok(g.requirements.every((r) => !r.met));
  assert.equal(g.phrase, 'DROP COLUMN x_demo.u_name PERMANENTLY');
});

test('the escalation is marked as the one the PANE cannot grant', () => {
  // No tool and no UI may open it. Marking it keeps the form from ever growing
  // a checkbox for it.
  const g = describeDropGate(GATE);
  assert.equal(g.requirements.find((r) => r.key === 'escalation').operatorOnly, true);
  assert.equal(g.escalationOpen, false);
});

test('a satisfied gate reports ready, and only then', () => {
  const g = describeDropGate({ ...GATE, unmet: [] });
  assert.equal(g.ready, true);
  assert.equal(g.escalationOpen, true);
});

test('no gate at all is not "ready"', () => {
  assert.equal(describeDropGate(null).ready, false);
});
