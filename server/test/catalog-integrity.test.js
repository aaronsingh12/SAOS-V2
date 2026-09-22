/**
 * Catalog writes that would leave broken records are refused BEFORE anything
 * is written, and the rows that are sent are exactly what the read-back checks.
 *
 *   node --test server/test/catalog-integrity.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { _setSettingsForTests } = await import('../src/config/store.js');
/* No instance bound: any call that reached the Table API would fail with
   "No ServiceNow connection configured" — so a refusal message proves nothing
   was attempted. */
_setSettingsForTests({ connection: {} });

const { catalog, variablePayload, variableSpecProblems } = await import('../src/servicenow/catalog.js');
const { toolMap } = await import('../src/agent/tools.js');
const { diffWrite } = await import('../src/servicenow/write-verify.js');

test('a lookup variable is stored against its table, not as choices', () => {
  const p = variablePayload({ cat_item: 'c'.repeat(32) }, { name: 'country', type: 18, lookup_table: 'core_country', lookup_value: 'name' });
  assert.equal(p.lookup_table, 'core_country');
  assert.equal(p.lookup_value, 'name');
  assert.equal(p.type, '18');
  const d = variablePayload({}, { name: 'acct', type: 22, lookup_table: 'customer_account' });
  assert.equal(d.lookup_value, 'sys_id', 'the stored value defaults to sys_id');
});

test('a spec that would create a broken variable is named, field by field', () => {
  assert.deepEqual(variableSpecProblems({ name: 'ok', type: 6 }), []);
  assert.match(variableSpecProblems({ name: 'x' }).join(), /explicit ServiceNow variable type code/);
  assert.match(variableSpecProblems({ name: 'r', type: 8 }).join(), /Reference variable and needs reference_table/);
  assert.match(variableSpecProblems({ name: 'l', type: 21 }).join(), /List Collector variable and needs reference_table/);
  assert.match(variableSpecProblems({ name: 'k', type: 18 }).join(), /needs lookup_table/);
  assert.match(variableSpecProblems({ type: 6, question_text: 'Why?' }).join(), /needs an internal name/);
});

test('a composite item with one bad variable is refused before the item exists', async () => {
  await assert.rejects(
    () => catalog.createCatalogItemComposite({
      name: 'Laptop', short_description: 'x',
      variables: [{ name: 'model', type: 6 }, { name: 'owner', type: 8 }],
    }),
    (err) => {
      assert.match(err.message, /refused before anything was written/);
      assert.match(err.message, /owner/);
      assert.equal(err.status, 400);
      return true;
    },
  );
});

test('a single variable with no table is refused before it is sent', async () => {
  await assert.rejects(
    () => catalog.createVariable({ cat_item: 'c'.repeat(32) }, { name: 'who', type: 8 }),
    /refused before anything was written/,
  );
});

test('a catalog needs a title the platform will accept', () => {
  assert.throws(() => catalog.createCatalog({ title: '  ' }), /needs a title/);
  // The platform rule "Restrict charset of catalog names" aborts these; say why before sending.
  assert.throws(() => catalog.createCatalog({ title: 'IT-Services' }), /only letters, digits, spaces and underscores/);
  assert.throws(() => catalog.createCatalog({ title: 'R&D' }), /only letters, digits, spaces and underscores/);
});

test('add_catalog_variable is verified against the row that was sent, not the tool wrapper', () => {
  const tool = toolMap.get('add_catalog_variable');
  const input = { cat_item: 'c'.repeat(32), name: 'reason', question_text: 'Why?', type: 5, mandatory: true, choices: [{ text: 'A' }] };
  const record = {
    sys_id: { value: 'v'.repeat(32) }, type: { value: '5' }, name: { value: 'reason' }, question_text: { value: 'Why?' },
    order: { value: '100' }, mandatory: { value: 'true' }, help_text: { value: '' }, default_value: { value: '' },
  };
  const d = tool.describeWrite(input, { variable: record, choices: [] });
  assert.equal(d.record, record, 'the record inside { variable, choices } is named for the verifier');
  assert.ok(!('choices' in d.requested), 'choices are child rows, not a field of the variable');
  assert.ok(!('cat_item' in d.requested));
  assert.equal(diffWrite({ table: d.table, operation: 'insert', requested: d.requested, returned: d.record }).status, 'applied');
});
