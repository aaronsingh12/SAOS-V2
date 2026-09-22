/**
 * A new custom application is refused before anything is written whenever its
 * shape is wrong — and the existing "establish the workspace's own scope" path
 * is untouched by it.
 *
 *   node --test server/test/custom-application.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { _setSettingsForTests } = await import('../src/config/store.js');
/* No instance bound: anything that reached the Table API would fail with
   "No ServiceNow connection configured", so these refusals prove nothing was sent. */
_setSettingsForTests({ connection: {} });

const { createCustomApplication, planCustomApplication, validateScopeName, suggestScopeName } = await import('../src/servicenow/app-create.js');

test('an unknown application kind is refused before anything is read or written', async () => {
  await assert.rejects(() => createCustomApplication({ name: 'X', kind: 'store' }), /Unknown application kind/);
});

test('a global application needs a name, and needs no vendor prefix', async () => {
  const plan = await planCustomApplication({ name: '', kind: 'global' });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(), /name is required/);
  const named = await planCustomApplication({ name: 'Contract Requests', kind: 'global' });
  assert.equal(named.ok, true);
  assert.equal(named.scope, 'global');
});

test('a nameless global application is refused before the insert', async () => {
  await assert.rejects(() => createCustomApplication({ name: ' ', kind: 'global' }), /refused before anything was written/);
});

test('scope rules hold for lettered and numeric vendor prefixes alike', () => {
  assert.equal(validateScopeName('x_tepv_fleet', 'x_tepv_').ok, true);
  assert.equal(validateScopeName('x_2225382_fleet', 'x_tepv_').ok, false, 'another instance\'s prefix');
  assert.equal(validateScopeName('x_tepv_much_too_long', 'x_tepv_').ok, false, 'over 18 characters');
  assert.ok(suggestScopeName('Fleet Management', 'x_tepv_').length <= 18);
});
