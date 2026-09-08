/**
 * PHASE 13 — RESOLVING AN IDENTITY, and the two ways it was silently wrong.
 *
 * Both defects were found by pointing the real code at a real PDI while
 * building the incident slice, and both are invisible offline unless the fake
 * instance behaves the way the platform actually behaves. That is the point of
 * this file, so it is worth being precise about:
 *
 *   `test/lookup-rank.test.js` stubs a query on an unknown field by THROWING
 *   (`no such field`). ServiceNow does not throw. It drops the unknown
 *   condition from the encoded query and answers with EVERY ROW.
 *
 * That difference is the whole bug. The fake below models the platform.
 *
 * DEFECT 1 — a key field that does not exist matches everything.
 *   `incident` has no KEY_FIELDS entry, so the fallback searched `name`, which
 *   `incident` does not have. Measured live: referenceLookup('incident',
 *   'INC0010001') returned SIX records — five unrelated incidents ranked
 *   `exact` above the one true `exact-display` hit — and resolved to
 *   INC0000009.
 *
 * DEFECT 2 — a browse reported itself as unambiguous.
 *   `ambiguous` is `Boolean(term) && …`, so with no search term the verdict was
 *   `false` and `resolved` held the first row of an alphabetical listing. Fine
 *   for a picker a human clicks; not fine for a declared OUTPUT a later step
 *   can reference into a mutation. Measured: the model planned
 *   `{ table: 'incident', display: 'INC0010001' }` — `display` is not a
 *   declared input, so `search` arrived undefined.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * A fake instance that drops unknown conditions, as the platform does
 * ------------------------------------------------------------------ */

const INCIDENTS = [
  { sys_id: 'aa'.repeat(16), number: 'INC0000009', short_description: 'nine' },
  { sys_id: 'bb'.repeat(16), number: 'INC0000010', short_description: 'ten' },
  { sys_id: 'cc'.repeat(16), number: 'INC0000011', short_description: 'eleven' },
  { sys_id: 'dd'.repeat(16), number: 'INC0010001', short_description: 'the one actually wanted' },
];
const USERS = [
  { sys_id: 'ee'.repeat(16), name: 'Abel Tuter', user_name: 'abel.tuter', email: 'abel@example.com' },
  { sys_id: 'ff'.repeat(16), name: 'Abel Tutor', user_name: 'abel.tutor', email: 'abelt@example.com' },
];

/** Which columns each table really has — the dictionary's answer. */
const COLUMNS = {
  incident: ['sys_id', 'number', 'short_description'],
  sys_user: ['sys_id', 'name', 'user_name', 'email'],
};
const DATA = { incident: INCIDENTS, sys_user: USERS };

const eq = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/**
 * THE MEASURED PLATFORM BEHAVIOUR, and the reason this file exists: a
 * condition naming a column the table does not have is DROPPED, not rejected.
 * The query then has no conditions left and matches everything.
 */
function runQuery(tableName, query) {
  const rows = DATA[tableName];
  const clause = String(query || '').split('^ORDERBY')[0];
  if (!clause) return rows;
  let m;
  if ((m = /^sys_id=(.+)$/.exec(clause))) return rows.filter((r) => eq(r.sys_id, m[1]));
  if ((m = /^(\w+)STARTSWITH(.+)$/.exec(clause))) {
    if (!COLUMNS[tableName].includes(m[1])) return rows;
    return rows.filter((r) => String(r[m[1]] ?? '').toLowerCase().startsWith(m[2].toLowerCase()));
  }
  if ((m = /^(\w+)LIKE(.+)$/.exec(clause))) {
    if (!COLUMNS[tableName].includes(m[1])) return rows;
    return rows.filter((r) => String(r[m[1]] ?? '').toLowerCase().includes(m[2].toLowerCase()));
  }
  if ((m = /^(\w+)=(.+)$/.exec(clause))) {
    if (!COLUMNS[tableName].includes(m[1])) return rows;   // <-- the platform's silence
    return rows.filter((r) => eq(r[m[1]], m[2]));
  }
  return rows;
}

const clientMod = await import('../src/servicenow/client.js');
const schemaMod = await import('../src/servicenow/schema.js');
const { referenceLookup, clearSchemaCaches } = schemaMod;

const realQuery = clientMod.table.query;
clientMod.table.query = async (t, { query, limit = 15 } = {}) => {
  if (t === 'sys_dictionary') {
    /*
     * Both getDisplayField and getSchema read this table, with different
     * queries. getDisplayField asks for `display=true` and must get exactly
     * the display column back — answering it with every column is how the
     * display field silently becomes `sys_id`.
     */
    const wantTables = (/nameIN([^^]+)/.exec(String(query))?.[1] ?? '').split(',').filter(Boolean);
    const rows = Object.entries(COLUMNS)
      .filter(([tbl]) => !wantTables.length || wantTables.includes(tbl))
      .flatMap(([tbl, cols]) => cols.map((c) => ({ element: c, name: tbl, internal_type: 'string' })));
    if (/display=true/.test(String(query))) {
      return rows.filter((r) => (r.name === 'incident' && r.element === 'number')
        || (r.name === 'sys_user' && r.element === 'name'));
    }
    return rows;
  }
  if (t === 'sys_db_object') return [];
  if (t === 'sys_choice') return [];
  if (!DATA[t]) return realQuery(t, { query, limit });
  return runQuery(t, query).slice(0, limit);
};
clearSchemaCaches();

const { toolMap } = await import('../src/agent/tools.js');
const P = await import('../src/agent/plan/index.js');
const lookup = (args) => toolMap.get('lookup_reference').execute(args, { sessionId: 'p13', turnSeq: 0 });

/* ================================================================== *
 * DEFECT 1 — the nonexistent key field
 * ================================================================== */

test('REGRESSION: an incident number resolves to that incident, and only that one', async () => {
  const r = await referenceLookup('incident', 'INC0010001', 10);
  assert.equal(r.length, 1, `searching a table with no "name" column returned ${r.length} rows`);
  assert.equal(r[0].number ?? r[0].display, 'INC0010001');
  assert.equal(r[0].sys_id, 'dd'.repeat(16));
  assert.equal(r.ambiguous, false, 'one exact match on the display field is not ambiguous');
  assert.equal(r.resolved.sys_id, 'dd'.repeat(16), 'it must not resolve to the first row of the table');
});

test('REGRESSION: a key field the table does not have is never queried', async () => {
  const asked = [];
  const stub = clientMod.table.query;
  clientMod.table.query = async (t, opts) => { asked.push(`${t}:${opts?.query ?? ''}`); return stub(t, opts); };
  clearSchemaCaches();
  try {
    await referenceLookup('incident', 'INC0010001', 10);
  } finally {
    clientMod.table.query = stub;
    clearSchemaCaches();
  }
  assert.ok(!asked.some((q) => /^incident:name=/.test(q)),
    `incident has no "name" column, so it must not be searched: ${asked.join(' | ')}`);
});

test('a configured key field is still searched — the fix filters, it does not disable', async () => {
  const r = await referenceLookup('sys_user', 'abel.tuter', 10);
  assert.equal(r.resolved.sys_id, 'ee'.repeat(16), 'user_name is a real column and must still win');
  assert.equal(r.resolved.matchType, 'exact');
  assert.equal(r.ambiguous, false);
});

/* ================================================================== *
 * DEFECT 2 — a browse is not a resolution
 * ================================================================== */

test('REGRESSION: a lookup with no search term is ambiguous and yields no output', async () => {
  const r = await lookup({ table: 'incident' });
  assert.equal(r.ambiguous, true, 'nothing was searched for, so nothing was resolved');
  assert.deepEqual(P.extractOutputs('lookup_reference', r), {},
    'the first row of an alphabetical listing must never reach a mutation');
  assert.match(r.confirmBefore, /No search term/);
});

test('a partial match is ambiguous and yields no output', async () => {
  const r = await lookup({ table: 'sys_user', search: 'Abel' });
  assert.equal(r.ambiguous, true, 'Abel Tuter and Abel Tutor both start with it');
  assert.deepEqual(P.extractOutputs('lookup_reference', r), {});
});

test('a name matching nobody yields no output', async () => {
  const r = await lookup({ table: 'sys_user', search: 'Zzz Nonexistent Person' });
  assert.equal(r.ambiguous, true);
  assert.deepEqual(P.extractOutputs('lookup_reference', r), {});
});

test('an exact match resolves and DOES yield the identity', async () => {
  const r = await lookup({ table: 'sys_user', search: 'Abel Tuter' });
  assert.equal(r.ambiguous, false);
  assert.deepEqual(P.extractOutputs('lookup_reference', r),
    { sys_id: 'ee'.repeat(16), display: 'Abel Tuter' });
});

test('an exact incident number resolves end to end, through the tool', async () => {
  const r = await lookup({ table: 'incident', search: 'INC0010001' });
  assert.equal(r.ambiguous, false);
  assert.equal(P.extractOutputs('lookup_reference', r).sys_id, 'dd'.repeat(16),
    'this is the ordinary case the whole incident slice depends on');
});

/* ================================================================== *
 * The two defects meet: the plan the model actually wrote
 * ================================================================== */

test('the model plan that omitted `search` fails CLOSED rather than hitting a random incident', async () => {
  // `display` is not a declared input of lookup_reference, so `search` arrives
  // undefined. This is the plan the real model produced.
  const r = await lookup({ table: 'incident', display: 'INC0010001' });
  const produced = P.extractOutputs('lookup_reference', r);
  assert.deepEqual(produced, {}, 'an unresolved lookup must produce nothing');

  const consumer = {
    id: 'step_2',
    tool: 'update_record',
    inputs: { table: 'incident', sys_id: { $ref: 'step_1.result.sys_id' }, data: { urgency: '1' } },
    depends_on: ['step_1'],
  };
  const resolved = P.resolveReferences(consumer, { step_1: produced });
  assert.ok(!resolved.ok, 'the update must not run');
  assert.equal(resolved.problems[0].code, P.RESOLUTION_CODES.MISSING_OUTPUT);
});
