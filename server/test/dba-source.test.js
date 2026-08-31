import test from 'node:test';
import assert from 'node:assert/strict';

import { findSchemaSpan, columnsInSchema, insertColumn, removeColumn, ensureImport } from '../src/servicenow/dba-source.js';
import { TOOLS } from '../src/agent/tools.js';

/*
 * Editing the Fluent source that DEFINES an in-scope table.
 *
 * This is the mechanism that closes the third authoring case: a table this
 * application already owns. It exists as source editing rather than a
 * `sys_dictionary` insert because a column on the instance that the source does
 * not declare is removed again by the next install — the additive mirror of the
 * E2 finding, where a column dropped on the instance would have been re-created
 * by the source that still declared it.
 *
 * The fixture is the real generated shape, choice column and all, because that
 * nesting is what a naive regex gets wrong.
 */

const SRC = `// nowhelpassist-dba: x_2002152_nwforge_test_demo
import { Table, IntegerColumn, ReferenceColumn, StringColumn } from '@servicenow/sdk/core'

export const x_2002152_nwforge_test_demo = Table({
    $id: Now.ID["x_2002152_nwforge_test_demo_table"],
    name: "x_2002152_nwforge_test_demo",
    label: "Test Demo",
    extends: "task",
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
                "2": { label: "Closed" },
            },
        }),
        u_assigned_to: ReferenceColumn({ label: "Assigned To", referenceTable: "sys_user" }),
    },
})
`;

/* ── reading the schema block ─────────────────────────────────────────────── */

test('the schema span is found by brace matching, not by a regex', () => {
  // A choice column nests its own `choices: { … }`; a lazy match would stop at
  // the first `}` and truncate the file on the next edit.
  const span = findSchemaSpan(SRC);
  assert.ok(span);
  assert.ok(span.inner.includes('u_assigned_to'), 'the span must reach the LAST column, past the nested choices');
  assert.equal(SRC[span.open], '{');
  assert.equal(SRC[span.close], '}');
});

test('only top-level columns are listed — nested choice keys are not columns', () => {
  assert.deepEqual(columnsInSchema(SRC), ['u_name', 'u_priority', 'u_status', 'u_assigned_to']);
});

test('a file with no schema block yields nothing rather than guessing', () => {
  assert.equal(findSchemaSpan('const x = 1'), null);
  assert.deepEqual(columnsInSchema('const x = 1'), []);
});

/* ── inserting ────────────────────────────────────────────────────────────── */

test('a column is inserted after the last one, inside the block', () => {
  const next = insertColumn(SRC, { column: 'user_age', emitted: 'IntegerColumn({ label: "User Age" })', importName: 'IntegerColumn' });
  assert.deepEqual(columnsInSchema(next), ['u_name', 'u_priority', 'u_status', 'u_assigned_to', 'user_age']);
  assert.match(next, /user_age: IntegerColumn\(\{ label: "User Age" \}\),/);
  // and it is INSIDE the Table call, not appended after it
  assert.ok(next.indexOf('user_age') < next.lastIndexOf('})'));
});

test('the factory is added to the import when it is not already there', () => {
  const next = insertColumn(SRC, { column: 'u_flag', emitted: 'BooleanColumn({ label: "Flag" })', importName: 'BooleanColumn' });
  assert.match(next, /import \{ Table, BooleanColumn, IntegerColumn, ReferenceColumn, StringColumn \}/);
});

test('an already-imported factory is not duplicated', () => {
  const next = insertColumn(SRC, { column: 'u_more', emitted: 'IntegerColumn({ label: "More" })', importName: 'IntegerColumn' });
  assert.equal((next.match(/IntegerColumn/g) || []).length, 3, 'import + the existing column + the new one');
});

test('adding a column that already exists is refused', () => {
  assert.throws(
    () => insertColumn(SRC, { column: 'u_name', emitted: 'StringColumn({})', importName: 'StringColumn' }),
    /already declares a column named "u_name"/,
  );
});

test('a source this module does not understand is REFUSED, not improvised on', () => {
  // A corrupted source is worse than an unsupported request: it fails later, at
  // build time, with a diagnostic pointing at generated code nobody wrote.
  assert.throws(
    () => insertColumn('export const x = 1\n', { column: 'a', emitted: 'StringColumn({})', importName: 'StringColumn' }),
    /no `schema: \{ … \}` block/,
  );
  assert.throws(
    () => ensureImport('const a = 1', 'StringColumn'),
    /no `import \{ … \} from '@servicenow\/sdk\/core'` line/,
  );
});

/* ── removing, for the drop-reconciliation path ───────────────────────────── */

test('removing a column round-trips EXACTLY back to the original', () => {
  // Byte-for-byte. Reconciliation runs after an irreversible drop, so a
  // near-enough edit would corrupt the source at the worst possible moment.
  const added = insertColumn(SRC, { column: 'user_age', emitted: 'IntegerColumn({ label: "User Age" })', importName: 'IntegerColumn' });
  const { text, changed } = removeColumn(added, 'user_age');
  assert.equal(changed, true);
  assert.equal(text, SRC);
});

test('a multi-line choice column is removed whole, not half', () => {
  const { text, changed } = removeColumn(SRC, 'u_status');
  assert.equal(changed, true);
  assert.deepEqual(columnsInSchema(text), ['u_name', 'u_priority', 'u_assigned_to']);
  assert.doesNotMatch(text, /In Progress/, 'the nested choices must go with it');
  assert.match(text, /u_assigned_to/, 'the column after it must survive');
});

test('removing a column that is not there reports so, and changes nothing', () => {
  const { text, changed, reason } = removeColumn(SRC, 'service');
  assert.equal(changed, false);
  assert.equal(text, SRC);
  assert.match(reason, /does not declare a column named "service"/);
});

/* ── the routing tools ────────────────────────────────────────────────────── */

test('the routing and add-field tools are registered with the right mutability', () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  assert.ok(byName.has('dba_column_route'));
  assert.ok(byName.has('dba_add_field'));
  // Asking WHICH path applies must never itself be a mutation.
  assert.equal(byName.get('dba_column_route').mutating, false);
  assert.equal(byName.get('dba_add_field').mutating, true);
});

test('dba_add_field says plainly that it never writes to sys_dictionary', () => {
  const d = TOOLS.find((t) => t.name === 'dba_add_field').description;
  assert.match(d, /never by writing to sys_dictionary/);
  assert.match(d, /source and instance now agree/);
});
