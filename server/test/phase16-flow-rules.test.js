/**
 * PHASE 16 — THE RULES, in both directions.
 *
 * §43, §44 and §45. Every rule is tested twice: once on an artifact that should
 * trip it, and once on one that should NOT. The second half is the important
 * half — §56 is explicit that a linter producing a hundred warnings of which
 * eighty are wrong is worse than one producing ten that are right, and the only
 * way to know which kind this is, is to write the cases where it must stay
 * quiet.
 *
 * The context is a fake instance, so "the dictionary says" is something the
 * test controls exactly. The shapes it returns are the ones measured on
 * dev424910 — `template_value` in encoded-query form, a trigger config with a
 * table label and a condition, an action input carrying `parameter.mandatory`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const L = await import('../src/agent/lint/index.js');
const { RULES } = L;

/* ------------------------------------------------------------------ *
 * A fake instance whose answers the test decides
 * ------------------------------------------------------------------ */

const INCIDENT_FIELDS = [
  { name: 'sys_id', type: 'GUID', readOnly: true },
  { name: 'number', type: 'string', readOnly: false },
  { name: 'short_description', type: 'string', readOnly: false },
  { name: 'state', type: 'integer', readOnly: false },
  { name: 'priority', type: 'integer', readOnly: false },
  { name: 'impact', type: 'integer', readOnly: false },
  { name: 'urgency', type: 'integer', readOnly: false },
  { name: 'assigned_to', type: 'reference', readOnly: false, reference: 'sys_user' },
  { name: 'caller_id', type: 'reference', readOnly: false, reference: 'sys_user' },
  { name: 'sys_created_on', type: 'glide_date_time', readOnly: true },
];

function fakeContext(over = {}) {
  const reads = { schema: 0, choices: 0, records: 0, executions: 0 };
  return {
    reads,
    async schemaOf(t) {
      reads.schema += 1;
      if (t === 'incident') return new Map(INCIDENT_FIELDS.map((f) => [f.name, f]));
      return null;
    },
    async resolveTable(label) { return label === 'Incident' ? 'incident' : null; },
    async choicesFor(t, field) {
      reads.choices += 1;
      if (t === 'incident' && field === 'state') return new Set(['1', '2', '3', '6', '7', '8']);
      return null;
    },
    async countMatches() { reads.records += 1; return 1; },
    async recordExists() { reads.records += 1; return true; },
    derivationOf() { return null; },
    capability() { return { available: true }; },
    async executionsOf() { reads.executions += 1; return []; },
    ...over,
  };
}

const input = (name, type, over = {}) => ({
  name, label: name, type, mandatory: false, read_only: false, reference: null,
  depends_on: null, supplied: '', display: null, is_pill: false, empty: true,
  declared: true, children: [], ...over,
});

const updateAction = (fieldMap, over = {}) => ({
  sys_id: 'a1', order: 1, type_name: 'Update Record', inputs_readable: true,
  inputs: [
    input('table_name', 'table_name', { supplied: 'incident', empty: false }),
    input('values', 'template_value', { supplied: fieldMap, empty: false }),
  ],
  ...over,
});

const artifact = (over = {}) => ({
  flow: { sys_id: 'f'.repeat(32), name: 'Test Flow', active: true, type: 'flow', status: 'published' },
  triggers: [], actions: [], logic: [], subflow_calls: [], callers: [], gaps: [],
  ...over,
});

const only = (id) => RULES.filter((r) => r.id === id);
const run = (art, id, ctx = fakeContext()) => L.lintFlow(art, ctx, { rules: only(id) });

/* ================================================================== *
 * §11 / §44 — FLOW001, nonexistent field
 * ================================================================== */

test('FLOW001 fires on a written field the dictionary does not have', async () => {
  const r = await run(artifact({ actions: [updateAction('foobar=x')] }), 'FLOW001');
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.severity, 'CRITICAL');
  assert.equal(f.status, 'CONFIRMED');
  assert.match(f.title, /incident\.foobar/);
  assert.ok(f.evidence.some((e) => e.source === 'live_schema'), 'the dictionary must be cited');
  assert.ok(f.evidence.some((e) => e.source === 'live_flow'), 'the artifact must be cited');
});

test('FLOW001 fires on a trigger condition naming a missing field', async () => {
  const art = artifact({
    triggers: [{ sys_id: 't1', type: 'record_create', name: 'Created', table_label: 'Incident', condition: 'foobar=true' }],
  });
  const r = await run(art, 'FLOW001');
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].title, /Trigger condition/);
});

test('FLOW001 FALSE POSITIVE: a field that exists produces nothing', async () => {
  const r = await run(artifact({ actions: [updateAction('short_description=hello^state=2')] }), 'FLOW001');
  assert.deepEqual(r.findings, []);
});

test('FLOW001 reports UNKNOWN rather than a finding when the dictionary is unreadable', async () => {
  const ctx = fakeContext({ async schemaOf() { return null; } });
  const r = await run(artifact({ actions: [updateAction('anything=x')] }), 'FLOW001', ctx);
  assert.deepEqual(r.findings, []);
  assert.equal(r.unknown_checks.length, 1);
  assert.match(r.unknown_checks[0].reason, /could not be read/);
});

/* ================================================================== *
 * §12 — FLOW002, non-writable
 * ================================================================== */

test('FLOW002 fires on a DERIVED field, citing the semantic fact', async () => {
  const ctx = fakeContext({
    derivationOf: (t, f) => (t === 'incident' && f === 'priority'
      ? { value: { from: ['impact', 'urgency'] }, note: 'priority is computed from impact + urgency' }
      : null),
  });
  const r = await run(artifact({ actions: [updateAction('priority=1')] }), 'FLOW002', ctx);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.severity, 'HIGH');
  assert.equal(f.status, 'LIKELY', 'a semantic fact is strong evidence, not a direct lookup');
  assert.ok(f.evidence.some((e) => e.source === 'semantic_fact'));
  assert.equal(f.autofixable, true);
  assert.match(f.recommendation.statement, /impact and urgency/);
});

test('FLOW002 fires on a dictionary read-only field, and calls that CONFIRMED', async () => {
  const r = await run(artifact({ actions: [updateAction('sys_created_on=now')] }), 'FLOW002');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].status, 'CONFIRMED');
  assert.ok(r.findings[0].evidence.some((e) => e.source === 'live_schema'));
});

test('FLOW002 FALSE POSITIVE: an ordinary writable field produces nothing', async () => {
  const r = await run(artifact({ actions: [updateAction('short_description=x^state=2')] }), 'FLOW002');
  assert.deepEqual(r.findings, []);
});

test('FLOW002 says nothing about a field that does not exist — that is FLOW001', async () => {
  const r = await run(artifact({ actions: [updateAction('foobar=x')] }), 'FLOW002');
  assert.deepEqual(r.findings, []);
});

/* ================================================================== *
 * §13 / §44 — FLOW003, ambiguous reference
 * ================================================================== */

test('FLOW003 fires when the instance shows MORE THAN ONE match', async () => {
  const ctx = fakeContext({ async countMatches() { return 3; } });
  const r = await run(artifact({ actions: [updateAction('assigned_to=John Smith')] }), 'FLOW003', ctx);
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].title, /matches 3 sys_user/);
  assert.ok(r.findings[0].evidence.some((e) => e.source === 'live_record'));
});

test('FLOW003 fires when the instance shows NO match', async () => {
  const ctx = fakeContext({ async countMatches() { return 0; } });
  const r = await run(artifact({ actions: [updateAction('assigned_to=Nobody At All')] }), 'FLOW003', ctx);
  assert.equal(r.findings[0].severity, 'HIGH');
  assert.match(r.findings[0].title, /matches no sys_user/);
});

test('FLOW003 FALSE POSITIVE: a name the instance proves unique produces nothing', async () => {
  const ctx = fakeContext({ async countMatches() { return 1; } });
  const r = await run(artifact({ actions: [updateAction('assigned_to=Abel Tuter')] }), 'FLOW003', ctx);
  assert.deepEqual(r.findings, [], 'uniqueness proven by the instance is not ambiguity');
});

test('FLOW003 FALSE POSITIVE: a sys_id and a data pill are already identities', async () => {
  const ctx = fakeContext({ async countMatches() { return 5; } });
  for (const value of ['a'.repeat(32), '{{trigger.current.caller_id}}']) {
    const r = await run(artifact({ actions: [updateAction(`assigned_to=${value}`)] }), 'FLOW003', ctx);
    assert.deepEqual(r.findings, [], `${value} must not be treated as a display value`);
  }
});

test('FLOW003 reports UNKNOWN when the lookup itself fails', async () => {
  const ctx = fakeContext({ async countMatches() { return null; } });
  const r = await run(artifact({ actions: [updateAction('assigned_to=Someone')] }), 'FLOW003', ctx);
  assert.deepEqual(r.findings, []);
  assert.equal(r.unknown_checks.length, 1);
});

/* ================================================================== *
 * §14 / §15 — FLOW004 and FLOW005
 * ================================================================== */

test('FLOW004 fires on a mandatory input the flow leaves empty', async () => {
  const action = updateAction('state=2');
  action.inputs.push(input('record', 'document_id', { mandatory: true }));
  const r = await run(artifact({ actions: [action] }), 'FLOW004');
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].title, /Required input `record` is empty/);
});

test('FLOW004 FALSE POSITIVE: a mandatory input that IS supplied produces nothing', async () => {
  const action = updateAction('state=2');
  action.inputs.push(input('record', 'document_id', { mandatory: true, supplied: '{{trigger.current}}', empty: false, is_pill: true }));
  const r = await run(artifact({ actions: [action] }), 'FLOW004');
  assert.deepEqual(r.findings, []);
});

test('FLOW004 FALSE POSITIVE: an OPTIONAL input left empty is not a defect', async () => {
  const action = updateAction('state=2');
  action.inputs.push(input('comment', 'string', { mandatory: false }));
  const r = await run(artifact({ actions: [action] }), 'FLOW004');
  assert.deepEqual(r.findings, []);
});

test('FLOW004 reports UNKNOWN when the inputs could not be decoded', async () => {
  const r = await run(artifact({ actions: [{ ...updateAction('x=1'), inputs_readable: false }] }), 'FLOW004');
  assert.deepEqual(r.findings, []);
  assert.equal(r.unknown_checks.length, 1);
  assert.match(r.unknown_checks[0].reason, /could not be decoded/);
});

test('FLOW005 fires on a supplied input the action does not declare', async () => {
  const action = updateAction('state=2');
  action.inputs.push(input('mystery', null, { supplied: 'x', empty: false, declared: false }));
  const r = await run(artifact({ actions: [action] }), 'FLOW005');
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].description, /does not declare/);
});

test('FLOW005 FALSE POSITIVE: every declared input, however unusual, is fine', async () => {
  const action = updateAction('state=2');
  action.inputs.push(input('exotic_but_declared', 'string', { supplied: 'x', empty: false, declared: true }));
  const r = await run(artifact({ actions: [action] }), 'FLOW005');
  assert.deepEqual(r.findings, []);
});

/* ================================================================== *
 * §16 / §17 — FLOW006 and FLOW007
 * ================================================================== */

test('FLOW006 fires on a choice value the instance does not have', async () => {
  const art = artifact({
    triggers: [{ sys_id: 't1', type: 'record_update', name: 'Updated', table_label: 'Incident', condition: 'state=999' }],
  });
  const r = await run(art, 'FLOW006');
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].title, /can never match/);
  assert.ok(r.findings[0].evidence.some((e) => e.source === 'live_choices'));
});

test('FLOW006 FALSE POSITIVE: a valid choice value produces nothing', async () => {
  const art = artifact({
    triggers: [{ sys_id: 't1', type: 'record_update', name: 'Updated', table_label: 'Incident', condition: 'state=2' }],
  });
  assert.deepEqual((await run(art, 'FLOW006')).findings, []);
});

test('FLOW006 FALSE POSITIVE: a field with no declared choices is not checkable', async () => {
  const art = artifact({
    triggers: [{ sys_id: 't1', type: 'record_update', name: 'U', table_label: 'Incident', condition: 'short_description=anything' }],
  });
  assert.deepEqual((await run(art, 'FLOW006')).findings, [],
    'a free-text field has no choice list and must not be judged against one');
});

test('FLOW007 fires on a field required to be two different values', async () => {
  const art = artifact({
    triggers: [{ sys_id: 't1', type: 'record_update', name: 'U', table_label: 'Incident', condition: 'priority=1^priority=5' }],
  });
  const r = await run(art, 'FLOW007');
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].title, /two different values/);
});

test('FLOW007 FALSE POSITIVE: different fields, and repeats of the same value, are fine', async () => {
  for (const condition of ['priority=1^state=2', 'priority=1^priority=1']) {
    const art = artifact({
      triggers: [{ sys_id: 't1', type: 'record_update', name: 'U', table_label: 'Incident', condition }],
    });
    assert.deepEqual((await run(art, 'FLOW007')).findings, [], condition);
  }
});

test('FLOW007 does not attempt theorem proving on data pills', async () => {
  const art = artifact({
    triggers: [{ sys_id: 't1', type: 'record_update', name: 'U', table_label: 'Incident', condition: 'priority={{a.b}}^priority={{c.d}}' }],
  });
  assert.deepEqual((await run(art, 'FLOW007')).findings, []);
});

/* ================================================================== *
 * §18 / §19 / §20 — FLOW008, FLOW009, FLOW010
 * ================================================================== */

test('FLOW008 fires only on REAL failures, and calls it a RISK not a defect', async () => {
  const ctx = fakeContext({
    async executionsOf() {
      return [
        { sys_id: 'x1', state: 'EXECUTION_ERROR', error: 'boom', flow: { name: 'Test Flow' } },
        { sys_id: 'x2', state: 'EXECUTION_COMPLETE', error: null, flow: { name: 'Test Flow' } },
      ];
    },
  });
  const r = await run(artifact(), 'FLOW008', ctx);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, 'RISK');
  assert.ok(r.findings[0].evidence.every((e) => e.source === 'execution'));
});

test('FLOW008 FALSE POSITIVE: a flow that has never failed gets no opinion about error branches', async () => {
  const ctx = fakeContext({
    async executionsOf() { return [{ sys_id: 'x1', state: 'EXECUTION_COMPLETE', error: null }]; },
  });
  assert.deepEqual((await run(artifact(), 'FLOW008', ctx)).findings, [],
    '"every action should have an error branch" is an opinion, not a defect');
});

test('FLOW008 reports UNKNOWN when execution history cannot be read', async () => {
  const ctx = fakeContext({ async executionsOf() { return null; } });
  const r = await run(artifact(), 'FLOW008', ctx);
  assert.deepEqual(r.findings, []);
  assert.equal(r.unknown_checks.length, 1);
});

test('FLOW009 reports a destructive step as a RISK, not an error', async () => {
  const art = artifact({ actions: [{ sys_id: 'a1', order: 1, type_name: 'Delete Record', inputs_readable: true, inputs: [] }] });
  const r = await run(art, 'FLOW009');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, 'RISK');
  assert.notEqual(r.findings[0].severity, 'CRITICAL');
  assert.match(r.findings[0].why_it_matters, /not necessarily wrong/);
});

test('FLOW009 FALSE POSITIVE: an ordinary action is not destructive', async () => {
  const art = artifact({ actions: [{ sys_id: 'a1', order: 1, type_name: 'Look Up Record', inputs_readable: true, inputs: [] }] });
  assert.deepEqual((await run(art, 'FLOW009')).findings, []);
});

test('§20 FLOW010 separates a platform limitation from a flow defect', async () => {
  const ctx = fakeContext({ capability: () => ({ available: false, reason: 'mechanism_unknown' }) });
  const r = await run(artifact(), 'FLOW010', ctx);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.kind, 'PLATFORM_LIMITATION');
  assert.equal(f.severity, 'INFO');
  assert.match(f.why_it_matters, /says nothing about the flow/);
});

test('FLOW010 is silent when authoring IS available', async () => {
  assert.deepEqual((await run(artifact(), 'FLOW010')).findings, []);
});

/* ================================================================== *
 * §21 / §22 — FLOW011 and FLOW012
 * ================================================================== */

test('FLOW011 fires only when the instance PROVES the record is absent', async () => {
  const ctx = fakeContext({ async recordExists() { return false; } });
  const r = await run(artifact({ actions: [updateAction(`caller_id=${'a'.repeat(32)}`)] }), 'FLOW011', ctx);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].status, 'CONFIRMED');
});

test('FLOW011 FALSE POSITIVE: a record that exists produces nothing', async () => {
  const r = await run(artifact({ actions: [updateAction(`caller_id=${'a'.repeat(32)}`)] }), 'FLOW011');
  assert.deepEqual(r.findings, []);
});

test('FLOW011 reports UNKNOWN when the existence check fails', async () => {
  const ctx = fakeContext({ async recordExists() { return null; } });
  const r = await run(artifact({ actions: [updateAction(`caller_id=${'a'.repeat(32)}`)] }), 'FLOW011', ctx);
  assert.deepEqual(r.findings, []);
  assert.equal(r.unknown_checks.length, 1);
});

test('FLOW012 fires on a trigger with no actions at all', async () => {
  const art = artifact({
    triggers: [{ sys_id: 't1', type: 'record_create', name: 'Created', table_label: 'Incident', condition: null }],
  });
  const r = await run(art, 'FLOW012');
  assert.equal(r.findings.length, 1);
  assert.match(r.findings[0].title, /no actions/);
});

test('§22 FLOW012 does NOT judge a flow by its name', async () => {
  const art = artifact({
    flow: { sys_id: 'f'.repeat(32), name: 'Assign Incident', active: true, type: 'flow', status: 'published' },
    triggers: [{ sys_id: 't1', type: 'record_create', name: 'Created', table_label: 'Incident', condition: null }],
    actions: [updateAction('short_description=x')],
  });
  assert.deepEqual((await run(art, 'FLOW012')).findings, [],
    'a flow called "Assign Incident" that does not assign is not a finding — intent is not evidence');
});

/* ================================================================== *
 * The field-map parser, against the measured format
 * ================================================================== */

test('the field map parses the format the instance actually uses', () => {
  const measured = 'message=Flow error, see context {{185cbee1.__status__.code}}^state=4';
  assert.deepEqual(L.parseFieldMap(measured), [
    { field: 'message', value: 'Flow error, see context {{185cbee1.__status__.code}}' },
    { field: 'state', value: '4' },
  ]);
});

test('the parser ignores anything that is not a field assignment', () => {
  assert.deepEqual(L.parseFieldMap(''), []);
  assert.deepEqual(L.parseFieldMap('no_equals_here'), []);
  assert.deepEqual(L.parseFieldMap('=leading'), []);
  assert.deepEqual(L.parseFieldMap('9bad=x'), []);
});

/* ================================================================== *
 * Every rule, on an empty flow, stays quiet or says why
 * ================================================================== */

test('no rule invents a finding from an empty artifact', async () => {
  const r = await L.lintFlow(artifact(), fakeContext());
  for (const f of r.findings) {
    assert.ok(f.evidence.length > 0, `${f.rule_id} produced a finding with no evidence`);
  }
  assert.equal(r.rules_run.length, RULES.length, 'every rule must run');
});

test('a rule that throws becomes an UNKNOWN check rather than losing the run', async () => {
  const exploding = [{ id: 'BOOM', analyze() { throw new Error('kaboom'); } }];
  const r = await L.lintFlow(artifact(), fakeContext(), { rules: exploding });
  assert.deepEqual(r.findings, []);
  assert.equal(r.unknown_checks[0].rule_id, 'BOOM');
  assert.match(r.unknown_checks[0].reason, /kaboom/);
});

/* ================================================================== *
 * REGRESSION — found by the real PDI
 * ================================================================== */

test('REGRESSION: an empty dictionary is UNKNOWN, not "every field is missing"', async () => {
  /*
   * MEASURED. `getSchema` on a table that does not exist does not throw: the
   * dictionary query matches nothing and it returns zero fields. Every field
   * then looked absent, and FLOW001 reported a CONFIRMED "field does not exist"
   * — citing live_schema — about a table nothing was known about.
   */
  const ctx = fakeContext({
    async schemaOf() { return null; },              // what an empty dictionary must become
  });
  const art = artifact({
    actions: [{
      ...updateAction('anything=x'),
      inputs: [
        input('table_name', 'table_name', { supplied: 'no_such_table', empty: false }),
        input('values', 'template_value', { supplied: 'anything=x', empty: false }),
      ],
    }],
  });
  const r = await run(art, 'FLOW001', ctx);
  assert.deepEqual(r.findings, [], 'nothing may be confirmed about a table nothing is known about');
  assert.equal(r.unknown_checks.length, 1);
  assert.match(r.unknown_checks[0].reason, /could not be read/);
});

test('REGRESSION: the context itself turns a zero-field schema into null', async () => {
  const L2 = await import('../src/agent/lint/index.js');
  const ctx = L2.makeContext({
    getSchema: async () => ({ table: 'ghost', fields: [] }),
    table: { query: async () => [] },
    derivationOf: () => null,
    discovered: { capabilities: {} },
  });
  assert.equal(await ctx.schemaOf('ghost'), null,
    'a table with no columns is a table the dictionary did not describe');

  const real = L2.makeContext({
    getSchema: async () => ({ table: 'incident', fields: [{ name: 'sys_id', type: 'GUID' }] }),
    table: { query: async () => [] },
    derivationOf: () => null,
    discovered: { capabilities: {} },
  });
  const schema = await real.schemaOf('incident');
  assert.ok(schema instanceof Map && schema.has('sys_id'));
});
