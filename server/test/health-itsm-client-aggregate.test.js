import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * ITSM PHASE 3 — `table.aggregate`, the one addition to servicenow/client.js.
 * The Aggregate API is stubbed at fetch so the wire shape the wrapper parses
 * is the platform's, not the fake instance's.
 */

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev000000.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
});
const { table } = await import('../src/servicenow/client.js');

const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  requests.push(u);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (!u.pathname.startsWith('/api/now/stats/')) return json(404, { error: { message: 'No Record found' } });
  if (u.pathname.endsWith('/forbidden_table')) return json(403, { error: { message: 'Insufficient rights', detail: 'Failed API level ACL Validation' } });
  const groupBy = (u.searchParams.get('sysparm_group_by') || '').split(',').filter(Boolean);
  if (!groupBy.length) return json(200, { result: { stats: { count: '42', avg: { duration: '12.5' }, sum: { duration: '525' } } } });
  return json(200, {
    result: [
      { groupby_fields: groupBy.map((f) => ({ field: f, value: '1' })), stats: { count: '5', avg: { duration: '10' } } },
      { groupby_fields: groupBy.map((f) => ({ field: f, value: '' })), stats: { count: '3', avg: { duration: '' } } },
    ],
  });
};
test.after(() => { globalThis.fetch = realFetch; _setSettingsForTests(null); });

test('table.aggregate: no group-by returns one row with count/avg/sum as numbers', async () => {
  const rows = await table.aggregate('incident', { query: 'active=true', avg: ['duration'], sum: ['duration'] });
  assert.deepEqual(rows, [{ group: {}, count: 42, avg: { duration: 12.5 }, sum: { duration: 525 }, min: {}, max: {} }]);
  const u = requests.at(-1);
  assert.equal(u.searchParams.get('sysparm_count'), 'true');
  assert.equal(u.searchParams.get('sysparm_avg_fields'), 'duration');
  assert.equal(u.searchParams.get('sysparm_sum_fields'), 'duration');
  assert.equal(u.searchParams.get('sysparm_group_by'), null);
});

test('table.aggregate: multi-field group-by is one comma-joined parameter; empty stats become null; an empty group value is kept', async () => {
  const rows = await table.aggregate('incident', { groupBy: ['impact', 'urgency'], avg: 'duration' });
  assert.equal(requests.at(-1).searchParams.get('sysparm_group_by'), 'impact,urgency');
  assert.deepEqual(rows.map((r) => [r.group, r.count, r.avg.duration]), [[{ impact: '1', urgency: '1' }, 5, 10], [{ impact: '', urgency: '' }, 3, null]]);
});

test('table.aggregate: a 403 is diagnosed as a table-level ACL, not bad credentials, and countBy is unchanged', async () => {
  await assert.rejects(() => table.aggregate('forbidden_table', { groupBy: ['x'] }), /may not read forbidden_table over REST/);
  const by = await table.countBy('incident', 'active=true', 'priority');
  assert.deepEqual(by, { 1: 5, '': 3 }, 'countBy still returns its {value: count} shape, unchanged');
});
