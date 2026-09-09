import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLUMN_VERBS,
  MODIFIABLE_OPTIONS,
  columnRouteDecision,
  classifyColumnChange,
  emitColumnOptions,
} from '../src/servicenow/dba-authoring.js';
import { modifyColumn, columnsInSchema } from '../src/servicenow/dba-source.js';
import { classifyOperation } from '../src/servicenow/dba-impact.js';

/*
 * H-2 — "routing wired per verb, not per target", found for the third time.
 *
 * Add was wired (§46), then remove was wired separately (§47), and modify
 * dead-ended into "that process isn't supported". Each time the cause was the
 * same: the ROUTE was decided inside the verb. It is a property of the TARGET.
 *
 * These tests pin that down where it cannot drift: the decision table is
 * exhaustive over verbs × routes, and a fourth verb has nowhere to silently
 * diverge into.
 */

const ROUTES = ['in_scope_source', 'augment', 'create_table', 'unmanaged_in_scope'];

test('every verb has an explicit decision on every route — no defaults', () => {
  for (const route of ROUTES) {
    for (const verb of COLUMN_VERBS) {
      const d = columnRouteDecision(route, verb);
      assert.equal(typeof d?.proceed, 'boolean', `${verb} on ${route} must state proceed explicitly`);
    }
  }
});

test('a FOURTH verb cannot silently inherit a default — it throws', () => {
  // This is the guard against the bug class itself. Adding a verb must be a
  // deliberate act that names what it does on all four routes.
  for (const route of ROUTES) {
    assert.throws(() => columnRouteDecision(route, 'rename'), /not one of the column verbs/);
  }
  assert.throws(() => columnRouteDecision('some_new_route', 'add'), /not a known column route/);
});

test('all three verbs take the SAME in-scope source path', () => {
  // The acceptance for H-2: add, modify and remove all edit the source and
  // reinstall on a table this application defines.
  for (const verb of COLUMN_VERBS) {
    assert.equal(columnRouteDecision('in_scope_source', verb).proceed, true, `${verb} must proceed on in_scope_source`);
  }
});

test('all three verbs refuse identically where the table is unadopted', () => {
  for (const verb of COLUMN_VERBS) {
    const d = columnRouteDecision('unmanaged_in_scope', verb);
    assert.equal(d.proceed, false);
    assert.equal(d.offer, 'adopt-into-source', `${verb} must offer adoption, not a different remedy`);
  }
});

test('add and modify redirect the same way off the in-scope path', () => {
  // Both are authoring an in-scope column; where that is not the target, both
  // send the caller to the same other tool. Divergence here IS the bug.
  assert.deepEqual(columnRouteDecision('augment', 'add'), columnRouteDecision('augment', 'modify'));
  assert.deepEqual(columnRouteDecision('create_table', 'add'), columnRouteDecision('create_table', 'modify'));
});

test('remove proceeds on an augment because the column is ours — the GATE governs it, not the route', () => {
  // The one deliberate asymmetry, asserted so it stays deliberate: dropping an
  // augment column is dropping OUR column off someone else's table. Routing
  // says where; destructiveGate still says whether.
  assert.equal(columnRouteDecision('augment', 'remove').proceed, true);
  assert.equal(columnRouteDecision('augment', 'add').proceed, false);
});

/* ── the safe / unsafe split inside "modify" ──────────────────────────────── */

const CURRENT = {
  element: 'u_name',
  internal_type: 'string',
  column_label: 'Name',
  max_length: '40',
  default_value: '',
  hint: '',
};

test('label, hint, help, default and WIDENING are the safe half', () => {
  const s = classifyColumnChange(CURRENT, {
    name: 'u_name', label: 'Full name', hint: 'Their full name', help: 'Longer help', default: 'unknown', maxLength: 120,
  });
  assert.deepEqual(s.refused, []);
  assert.deepEqual(s.unknown, []);
  assert.deepEqual(s.safe.map((c) => c.option).sort(), ['default', 'help', 'hint', 'label', 'maxLength']);
  assert.deepEqual(s.safe.find((c) => c.option === 'maxLength'), { option: 'maxLength', from: 40, to: 120 });
  assert.deepEqual(MODIFIABLE_OPTIONS.slice().sort(), ['default', 'help', 'hint', 'label', 'maxLength']);
});

/* ── the documentation form ───────────────────────────────────────────────── */

/*
 * A flat `hint: "…"` on a column is accepted by `now-sdk build` and DISCARDED:
 * the generated sys_documentation record carries <hint/> empty, before the
 * instance is ever contacted. Measured identically on sdk 4.10.1 and 4.11.2 —
 * their sdk-core/dist/db is byte-identical, so it is not a version bug. The
 * `label: Documentation[]` form is what actually writes it.
 */

test('a hint is emitted through the documentation list, never as a flat option', () => {
  const set = emitColumnOptions([{ option: 'hint', to: 'Their full name' }], { label: 'Name', hint: '', help: '' });
  assert.equal(set.hint, undefined, 'a flat hint: option is silently dropped by the build — it must never be emitted');
  assert.equal(set.label, '[{ label: "Name", hint: "Their full name" }]');
});

test('setting a hint carries the CURRENT label — it cannot blank it', () => {
  const set = emitColumnOptions([{ option: 'hint', to: 'H' }], { label: 'Existing Label', hint: '', help: '' });
  assert.match(set.label, /label: "Existing Label"/);
});

test('setting a label carries the CURRENT hint and help', () => {
  const set = emitColumnOptions([{ option: 'label', to: 'New' }], { label: 'Old', hint: 'keep me', help: 'and me' });
  assert.equal(set.label, '[{ label: "New", hint: "keep me", help: "and me" }]');
});

test('a label with no hint and no help stays a plain string', () => {
  // The simplest form that works, and the one every generated column uses.
  const set = emitColumnOptions([{ option: 'label', to: 'New' }], { label: 'Old', hint: '', help: '' });
  assert.equal(set.label, '"New"');
});

test('non-documentation options are emitted as their own scalars', () => {
  const set = emitColumnOptions(
    [{ option: 'maxLength', to: 200 }, { option: 'default', to: 'x' }, { option: 'hint', to: 'H' }],
    { label: 'Name', hint: '', help: '' },
  );
  assert.equal(set.maxLength, '200');
  assert.equal(set.default, '"x"');
  assert.match(set.label, /hint: "H"/);
});

test('an integer default is emitted as a number, not a string', () => {
  const set = emitColumnOptions([{ option: 'default', to: '7' }], {}, 'integer');
  assert.equal(set.default, '7');
});

test('NARROWING is decrease_column_width and stays refused', () => {
  const s = classifyColumnChange(CURRENT, { name: 'u_name', maxLength: 10 });
  assert.equal(s.safe.length, 0);
  assert.equal(s.refused.length, 1);
  assert.equal(s.refused[0].operation, 'decrease_column_width');
});

test('RETYPING is change_column_type and stays refused', () => {
  const s = classifyColumnChange(CURRENT, { name: 'u_name', type: 'integer' });
  assert.equal(s.refused[0].operation, 'change_column_type');
});

test('RENAMING is rename_column and stays refused', () => {
  const s = classifyColumnChange(CURRENT, { name: 'u_something_else' });
  assert.equal(s.refused[0].operation, 'rename_column');
});

test('a mixed request keeps its refused half — the safe half does not sneak through', () => {
  // modifyField refuses the whole request when anything is refused; this
  // asserts the classifier reports both halves so the refusal can say what it
  // would have done rather than pretending the request was entirely bad.
  const s = classifyColumnChange(CURRENT, { name: 'u_name', label: 'Fine', maxLength: 5 });
  assert.equal(s.safe.length, 1);
  assert.equal(s.refused.length, 1);
  assert.equal(s.refused[0].operation, 'decrease_column_width');
});

test('setting a value it already holds is a no-op, not a change', () => {
  const s = classifyColumnChange(CURRENT, { name: 'u_name', label: 'Name', maxLength: 40 });
  assert.equal(s.safe.length, 0);
  assert.deepEqual(s.noop.map((n) => n.option).sort(), ['label', 'maxLength']);
});

test('an attribute this layer does not change is named, not silently ignored', () => {
  const s = classifyColumnChange(CURRENT, { name: 'u_name', mandatory: true });
  assert.equal(s.unknown.length, 1);
  assert.match(s.unknown[0].reason, /not an attribute this layer changes/);
});

/* ── the operations matrix ────────────────────────────────────────────────── */

test('modify_column is classified, reversible, and does not inherit the additive permanence warning', async () => {
  const op = await classifyOperation('modify_column', { withContext: false });
  assert.equal(op.known, true, 'H-2: modify_column was unclassified and therefore refused as irreversible');
  assert.equal(op.reversible, true);
  assert.equal(op.undoReversible, true);
  assert.match(op.permanence, /genuinely reversible/);
  assert.equal(op.additive, undefined, 'it is not additive — nothing is being added');
});

test('the irreversible halves of modify are still classified irreversible', async () => {
  for (const op of ['decrease_column_width', 'change_column_type', 'rename_column']) {
    const c = await classifyOperation(op, { withContext: false });
    assert.equal(c.reversible, false, `${op} must stay irreversible`);
    assert.ok(c.requiredConfirmations?.length, `${op} must still demand its confirmations`);
    assert.match(c.statement, /CANNOT be undone/);
  }
});

/* ── the source edit ──────────────────────────────────────────────────────── */

const SOURCE = `import { Table, StringColumn, IntegerColumn } from '@servicenow/sdk/core'

export const x_demo = Table({
    $id: Now.ID['x_demo_table'],
    name: "x_demo",
    label: "Demo",
    schema: {
        u_name: StringColumn({ label: "Name", maxLength: 40 }),
        u_priority: IntegerColumn({ label: "Priority" }),
        u_status: StringColumn({
            label: "Status",
            maxLength: 40,
            dropdown: 'none',
            choices: {
                "0": { label: "New" },
                "1": { label: "In Progress" },
            },
        }),
    },
})
`;

test('an existing option is replaced in place and the rest of the call is untouched', () => {
  const { text, changed, applied } = modifyColumn(SOURCE, { column: 'u_name', set: { maxLength: '120' } });
  assert.equal(changed, true);
  assert.deepEqual(applied, [{ option: 'maxLength', action: 'replaced' }]);
  assert.match(text, /u_name: StringColumn\(\{ label: "Name", maxLength: 120 \}\)/);
  assert.deepEqual(columnsInSchema(text), ['u_name', 'u_priority', 'u_status']);
});

test('an absent option is added rather than the call being rewritten', () => {
  const { text, applied } = modifyColumn(SOURCE, { column: 'u_priority', set: { hint: '"How urgent"' } });
  assert.deepEqual(applied, [{ option: 'hint', action: 'added' }]);
  assert.match(text, /u_priority: IntegerColumn\(\{ label: "Priority", hint: "How urgent" \}\)/);
});

test('a nested choice map is not mistaken for the column\'s own options', () => {
  // The trap: `choices: { "0": { label: "New" } }` contains a `label:` that a
  // naive search would rewrite instead of the column's own.
  const { text } = modifyColumn(SOURCE, { column: 'u_status', set: { label: '"Lifecycle state"' } });
  assert.match(text, /label: "Lifecycle state"/);
  assert.ok(text.includes('"0": { label: "New" }'), 'the choice labels must survive untouched');
  assert.ok(text.includes('"1": { label: "In Progress" }'));
  assert.equal((text.match(/label: "New"/g) || []).length, 1);
});

test('a column the source does not declare is refused, not invented', () => {
  const r = modifyColumn(SOURCE, { column: 'u_absent', set: { label: '"x"' } });
  assert.equal(r.changed, false);
  assert.match(r.reason, /does not declare a column/);
});

test('a source with no schema block is refused rather than rewritten', () => {
  assert.throws(
    () => modifyColumn('export const x = 1\n', { column: 'u_name', set: { label: '"x"' } }),
    /no `schema: \{ … \}` block/,
  );
});

test('repeated edits stay stable — the same set applied twice is idempotent', () => {
  const once = modifyColumn(SOURCE, { column: 'u_name', set: { label: '"Full name"', maxLength: '200' } });
  const twice = modifyColumn(once.text, { column: 'u_name', set: { label: '"Full name"', maxLength: '200' } });
  assert.equal(twice.text, once.text);
});
