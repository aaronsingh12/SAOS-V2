/**
 * PHASE 17 — NowTest.
 *
 *   node --test server/test/phase17-nowtest.test.js
 *
 * Offline in full: a captured artifact, a captured dictionary, a stubbed
 * executor. No instance, no model, no network. The real instance is exercised
 * by `scripts/phase17-pdi.mjs`, and the two are deliberately different jobs —
 * this file proves the ARITHMETIC is right, that one proves the arithmetic is
 * about something real.
 *
 * THE FIXTURES ARE MEASURED, NOT IMAGINED. `REFRESH` below is the shape
 * `readFlowArtifact` returns for "Change - Refresh Impacted Services" on
 * dev424910, down to the pill spelling (`{{Created_1.current}}`), the encoded
 * field map (`state=2`, then `state=3`), and the fact that all three actions
 * carry `parent_ui_id: null`. A test written against an imagined artifact
 * proves the code agrees with the imagination.
 *
 * WHAT THIS FILE IS MOSTLY ABOUT is the difference between four answers that
 * are easy to confuse and expensive to confuse: the flow did it, the flow did
 * not do it, nobody could tell, and it never got the chance. Most of the tests
 * below take a run that would report one of those and check it does not report
 * a neighbouring one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowforge-p17-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const T = await import('../src/agent/test/index.js');
const P = await import('../src/agent/plan/index.js');
const { derivationOf } = await import('../src/servicenow/semantic/tables.js');
const { toolMap } = await import('../src/agent/tools.js');
const { waitForFlowExecution, WAIT_LIMITS, isTerminalExecution } = await import('../src/servicenow/diagnostics.js');

/* ================================================================== *
 * FIXTURES — captured from dev424910
 * ================================================================== */

const FLOW_ID = 'f'.repeat(32);
const TASK = 'task-0000-1111-2222';
const MARKER = `[NOWTEST:${TASK}]`;

/** One action input, in `readFlowArtifact`'s normalised shape. */
const input = (name, supplied, over = {}) => ({
  name, label: null, type: over.type ?? 'string', mandatory: over.mandatory ?? false,
  read_only: false, reference: over.reference ?? null, depends_on: null,
  supplied, display: null, is_pill: /^\{\{.*\}\}$/.test(String(supplied).trim()),
  empty: String(supplied).trim() === '', declared: true, children: [],
});

const action = (over) => ({
  sys_id: over.sys_id, order: over.order, type_sys_id: 'a'.repeat(32),
  type_name: over.type_name, comment: null,
  ui_id: over.ui_id ?? `ui-${over.order}`, parent_ui_id: over.parent_ui_id ?? null,
  inputs: over.inputs ?? [], inputs_readable: over.inputs_readable ?? true,
});

/** "Change - Refresh Impacted Services", as the instance returns it. */
const REFRESH = () => ({
  flow: {
    sys_id: FLOW_ID, name: 'Change - Refresh Impacted Services', description: null,
    active: true, type: 'flow', status: 'published', scope: 'Global', updated_on: '2024-01-01 00:00:00',
  },
  triggers: [{
    sys_id: 't'.repeat(32), type: 'record_create', name: 'Created',
    config: { table: 'Change Management Worker', condition: 'type=refresh_services^source_table=change_request' },
    table_label: 'Change Management Worker',
    table: 'chg_mgt_worker',
    condition: 'type=refresh_services^source_table=change_request',
    condition_query: 'type=refresh_services^source_table=change_request',
    strategy: null,
  }],
  actions: [
    action({
      sys_id: '1'.repeat(32), order: 1, type_name: 'Update Record',
      inputs: [
        input('record', '{{Created_1.current}}', { type: 'document_id', mandatory: true }),
        input('table_name', 'chg_mgt_worker', { type: 'table_name', mandatory: true }),
        input('values', 'state=2', { type: 'template_value', mandatory: true }),
      ],
    }),
    action({
      sys_id: '2'.repeat(32), order: 2, type_name: 'Change Request - Refresh Impacted Services',
      inputs: [input('task_sysid', '{{Created_1.current.source_record}}', { type: 'document_id', mandatory: true })],
    }),
    action({
      sys_id: '3'.repeat(32), order: 3, type_name: 'Update Record',
      inputs: [
        input('record', '{{Created_1.current}}', { type: 'document_id', mandatory: true }),
        input('table_name', 'chg_mgt_worker', { type: 'table_name', mandatory: true }),
        input('values', 'state=3', { type: 'template_value', mandatory: true }),
      ],
    }),
  ],
  logic: [], subflow_calls: [], callers: [], source_tables: null, gaps: [],
});

/** The `chg_mgt_worker` dictionary, as `getSchema` returns it. */
const WORKER_FIELDS = () => new Map([
  ['message', { name: 'message', type: 'string', maxLength: 4000, readOnly: false, reference: null }],
  ['operation', { name: 'operation', type: 'string', maxLength: 40, readOnly: false, reference: null }],
  ['source_record', { name: 'source_record', type: 'document_id', maxLength: 32, readOnly: false, reference: null }],
  ['source_table', { name: 'source_table', type: 'table_name', maxLength: 80, readOnly: false, reference: null }],
  ['state', { name: 'state', type: 'integer', maxLength: 40, readOnly: false, reference: null }],
  ['type', { name: 'type', type: 'string', maxLength: 40, readOnly: false, reference: null }],
  ['sys_id', { name: 'sys_id', type: 'GUID', maxLength: 32, readOnly: false, reference: null }],
]);

/** A subset of the `incident` dictionary, enough for the derived-field tests. */
const INCIDENT_FIELDS = () => new Map([
  ['short_description', { name: 'short_description', type: 'string', maxLength: 160, readOnly: false, reference: null }],
  ['description', { name: 'description', type: 'string', maxLength: 4000, readOnly: false, reference: null }],
  ['impact', { name: 'impact', type: 'integer', maxLength: 40, readOnly: false, reference: null }],
  ['urgency', { name: 'urgency', type: 'integer', maxLength: 40, readOnly: false, reference: null }],
  ['priority', { name: 'priority', type: 'integer', maxLength: 40, readOnly: false, reference: null }],
  ['state', { name: 'state', type: 'integer', maxLength: 40, readOnly: false, reference: null }],
  ['assigned_to', { name: 'assigned_to', type: 'reference', maxLength: 32, readOnly: false, reference: 'sys_user' }],
  ['work_notes', { name: 'work_notes', type: 'journal_input', maxLength: 4000, readOnly: false, reference: null }],
  ['sys_id', { name: 'sys_id', type: 'GUID', maxLength: 32, readOnly: false, reference: null }],
]);

/** A ServiceNow cell under display=all. */
const cell = (value, display = null) => ({ value, display_value: display ?? value });

/** Everything from the artifact up to (not including) the plan. */
function derive(artifact = REFRESH(), fields = WORKER_FIELDS(), over = {}) {
  const trigger = T.triggerOf(artifact);
  assert.equal(trigger.ok, true, `trigger not derivable: ${trigger.note}`);
  const satisfaction = T.satisfyCondition(trigger, { fields, derivation: over.derivation ?? derivationOf });
  const effects = T.requiredEffects(T.effectsOf(artifact, trigger));
  const fixture = T.buildFixture({
    trigger, satisfaction, effects, fields, taskId: TASK,
    extra: over.extra ?? {}, derivation: over.derivation ?? derivationOf,
  });
  return { artifact, trigger, satisfaction, effects, fixture, fields };
}

function contractOf(d = derive()) {
  const { assertions, refused, uncovered } = T.assertionsFor({
    effects: d.effects, fixture: d.fixture, fields: d.fields,
  });
  const contract = T.buildContract({
    artifact: d.artifact, trigger: d.trigger, satisfaction: d.satisfaction,
    effects: d.effects, fixture: d.fixture, assertions, refused, uncovered,
  });
  return { ...d, assertions, refused, uncovered, contract, check: T.validateContract(contract) };
}

/* ================================================================== *
 * §10 / §14 — TRIGGER SATISFIABILITY
 * ================================================================== */

test('T1 — a record-created trigger with equality terms is satisfiable, and the fixture is those terms', () => {
  const { trigger, satisfaction, fixture } = derive();
  assert.equal(trigger.kind, 'record_create');
  assert.equal(trigger.table, 'chg_mgt_worker', 'the RAW table name must be used, not the label');
  assert.equal(satisfaction.ok, true);
  assert.deepEqual(satisfaction.data, { type: 'refresh_services', source_table: 'change_request' });
  assert.equal(fixture.ok, true);
  assert.equal(fixture.data.type, 'refresh_services');
});

test('T2 — an UPDATE trigger is refused: an insert can never fire a transition', () => {
  const a = REFRESH();
  a.triggers[0].type = 'record_update';
  const trigger = T.triggerOf(a);
  assert.equal(trigger.ok, false);
  assert.equal(trigger.reason, 'trigger_kind_unsupported');
  assert.match(trigger.note, /fires on a transition/);
});

test('T3 — a flow with two triggers is refused rather than having one picked', () => {
  const a = REFRESH();
  a.triggers.push({ ...a.triggers[0], sys_id: 'u'.repeat(32) });
  const trigger = T.triggerOf(a);
  assert.equal(trigger.ok, false);
  assert.equal(trigger.reason, 'multiple_triggers');
});

test('T4 — a trigger whose table could not be read is refused, label or no label', () => {
  const a = REFRESH();
  a.triggers[0].table = null;
  const trigger = T.triggerOf(a);
  assert.equal(trigger.ok, false);
  assert.equal(trigger.reason, 'trigger_table_unreadable');
  assert.match(trigger.note, /Change Management Worker/, 'the label the user would recognise is still shown');
});

test('T5 — every operator that cannot be inverted stops the test instead of guessing a value', () => {
  const cases = [
    ['state!=1', '!='],
    ['stateIN1,2,3', 'IN'],
    ['due_dateISNOTEMPTY', 'ISNOTEMPTY'],
    ['short_descriptionSTARTSWITHDelegate roles to', 'STARTSWITH'],
    ['stateCHANGESTO3', 'CHANGESTO'],
    ['priority>2', '>'],
  ];
  for (const [condition, op] of cases) {
    const trigger = { table: 'incident', condition };
    const s = T.satisfyCondition(trigger, { fields: INCIDENT_FIELDS() });
    assert.equal(s.ok, false, `${condition} was treated as satisfiable`);
    assert.equal(Object.keys(s.data).length, 0, `${condition} produced a fixture value anyway`);
    assert.match(s.unsupported[0].reason, new RegExp(op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('T6 — a DISJUNCTION stops the whole condition; one half is not silently chosen', () => {
  const parsed = T.parseEncodedQuery('state=1^ORstate=2');
  assert.equal(parsed.disjunction, true);
  assert.equal(parsed.terms.length, 0);
  const s = T.satisfyCondition({ table: 'incident', condition: 'state=1^ORstate=2' }, { fields: INCIDENT_FIELDS() });
  assert.equal(s.ok, false);
  assert.equal(Object.keys(s.data).length, 0);
});

test('T7 — a DOT-WALKED term stops: satisfying it would mean creating a record the test does not own', () => {
  const s = T.satisfyCondition({ table: 'incident', condition: 'caller_id.email=a@b.c' }, { fields: INCIDENT_FIELDS() });
  assert.equal(s.ok, false);
  assert.match(s.unsupported[0].reason, /dot-walks/);
});

test('T8 — a term naming a field the dictionary does not have stops, because the write would be dropped', () => {
  const s = T.satisfyCondition({ table: 'incident', condition: 'not_a_field=1' }, { fields: INCIDENT_FIELDS() });
  assert.equal(s.ok, false);
  assert.match(s.unsupported[0].reason, /not a field on incident/);
  assert.match(s.unsupported[0].reason, /silently dropped/);
});

test('T9 — ISEMPTY is satisfied by leaving the field out, never by writing an empty string', () => {
  const s = T.satisfyCondition({ table: 'incident', condition: 'sys_idISEMPTY' }, { fields: INCIDENT_FIELDS() });
  assert.equal(s.ok, true);
  assert.deepEqual(s.data, {});
  assert.equal(s.omitted[0].field, 'sys_id');
});

test('T10 — an empty condition and ^EQ both mean "any record of this table"', () => {
  for (const condition of ['', null, '^EQ']) {
    const s = T.satisfyCondition({ table: 'incident', condition }, { fields: INCIDENT_FIELDS() });
    assert.equal(s.ok, true, `${condition} was refused`);
    assert.deepEqual(s.data, {});
  }
});

/* ================================================================== *
 * §15 / §56 — DERIVED FIELDS
 * ================================================================== */

test('T11 — a trigger on a DERIVED field is driven from upstream, never written directly', () => {
  const s = T.satisfyCondition(
    { table: 'incident', condition: 'priority=1' },
    { fields: INCIDENT_FIELDS(), derivation: derivationOf },
  );
  assert.equal(s.ok, true);
  assert.equal(s.data.priority, undefined, 'priority was written directly — the platform overwrites it');
  assert.deepEqual(s.data, { impact: '1', urgency: '1' });
  assert.equal(s.derived[0].field, 'priority');
  assert.deepEqual(s.derived[0].from, ['impact', 'urgency']);
});

test('T12 — a plan that wrote a derived field would be refused by the EXISTING validator', () => {
  /* Not a NowTest rule. Proving the two agree is the point: the fixture builder
   * avoids the write, and the plan validator would refuse it if it did not. */
  const v = P.validatePlan({
    goal: 'x',
    steps: [{
      id: 'step_1', operation: 'create', capability: 'record_create', tool: 'create_record',
      mutating: true, target: { table: 'incident' },
      inputs: { table: 'incident', data: { priority: '1' } },
      depends_on: [], expected_effects: ['a record exists'],
      verification: { strategy: 'read_back', asserts: ['it exists'] },
    }],
  }, {
    discover: () => ({
      capability: 'record_create', status: 'known', available: true, mechanism: 'rest',
      mutating: true, verification: 'read_back', requiresVerification: true,
    }),
  });
  assert.equal(v.valid, false);
  assert.ok(v.fatal.some((p) => p.code === 'writes_derived_field'));
});

test('T13 — the derived CANDIDATE is checked against read-back, and a mismatch stops the run', () => {
  const trigger = { table: 'incident', condition: 'priority=1' };
  const satisfaction = T.satisfyCondition(trigger, { fields: INCIDENT_FIELDS(), derivation: derivationOf });

  const produced = T.verifyTriggerSatisfied({
    trigger, satisfaction, record: { impact: cell('1'), urgency: cell('1'), priority: cell('1') },
    readField: (r, f) => T.cellValue(r?.[f]),
  });
  assert.equal(produced.satisfied, true);

  const didNot = T.verifyTriggerSatisfied({
    trigger, satisfaction, record: { impact: cell('1'), urgency: cell('1'), priority: cell('3') },
    readField: (r, f) => T.cellValue(r?.[f]),
  });
  assert.equal(didNot.satisfied, false);
  assert.equal(didNot.failed[0].field, 'priority');
  assert.match(didNot.note, /never going to run/);
});

/* ================================================================== *
 * §10 / §11 — EXPECTED EFFECTS
 * ================================================================== */

test('T14 — only UNCONDITIONAL actions promise anything; a branch is carried, not required', () => {
  const a = REFRESH();
  a.actions[2].parent_ui_id = 'some-if-block';
  const effects = T.requiredEffects(T.effectsOf(a, T.triggerOf(a)));
  assert.equal(effects.required.some((e) => e.field === 'state' && e.expected === '3'), false,
    'a branch write became a promise');
  assert.equal(effects.conditional.some((e) => e.expected === '3'), true, 'the branch write was lost entirely');
});

test('T15 — the LAST unconditional write to a field wins; the earlier one is superseded, not asserted', () => {
  const { effects } = derive();
  const stateEffects = effects.required.filter((e) => e.field === 'state');
  assert.equal(stateEffects.length, 1, 'both writes to state became promises');
  assert.equal(stateEffects[0].expected, '3');
  assert.equal(effects.superseded.length, 1);
  assert.equal(effects.superseded[0].expected, '2');
});

test('T16 — an Update Record aimed at a record other than the fixture is UNOBSERVABLE, not promised', () => {
  const a = REFRESH();
  a.actions[0].inputs[0] = input('record', '{{Created_1.current.source_record}}', { type: 'document_id' });
  const effects = T.requiredEffects(T.effectsOf(a, T.triggerOf(a)));
  const unobservable = effects.unobservable.concat(effects.all.filter((e) => e.reason === 'target_not_the_fixture'));
  assert.ok(unobservable.some((e) => e.reason === 'target_not_the_fixture'),
    'a write to a different record was promised as if it were on the fixture');
});

test('T17 — an action whose inputs could not be decoded is reported, never treated as doing nothing', () => {
  const a = REFRESH();
  a.actions[0].inputs_readable = false;
  const all = T.effectsOf(a, T.triggerOf(a));
  assert.ok(all.some((e) => e.reason === 'inputs_unreadable'));
});

test('T18 — a journal write becomes a JOURNAL effect, not a field equality', () => {
  const a = REFRESH();
  a.triggers[0].table = 'incident';
  a.triggers[0].condition = 'impact=1';
  a.triggers[0].condition_query = 'impact=1';
  a.actions = [action({
    sys_id: 'j'.repeat(32), order: 1, type_name: 'Update Record',
    inputs: [
      input('record', '{{Created_1.current}}', { type: 'document_id' }),
      input('table_name', 'incident', { type: 'table_name' }),
      input('values', 'work_notes=Assigned by automation', { type: 'template_value' }),
    ],
  })];
  const effects = T.requiredEffects(T.effectsOf(a, T.triggerOf(a)));
  assert.equal(effects.required.length, 1);
  assert.equal(effects.required[0].kind, 'journal');
  assert.equal(effects.required[0].field, 'work_notes');
  assert.equal(effects.required[0].expected, 'Assigned by automation');
});

test('T19 — a pill value yields an EXISTS promise, never an equality against a guessed value', () => {
  const a = REFRESH();
  a.actions[2].inputs[2] = input('values', 'state={{step_2.output}}', { type: 'template_value' });
  const effects = T.requiredEffects(T.effectsOf(a, T.triggerOf(a)));
  const e = effects.required.find((x) => x.field === 'state');
  assert.equal(e.literal, false);
  assert.equal(e.expected, null);
  const { assertions } = T.assertionsFor({ effects, fixture: { data: {} }, fields: WORKER_FIELDS() });
  assert.ok(assertions.some((x) => x.type === 'exists'));
  assert.equal(assertions.some((x) => x.type === 'equals'), false);
});

test('T20 — a Create Record with no link back to the fixture is unobservable, not counted', () => {
  const a = REFRESH();
  a.actions = [action({
    sys_id: 'c'.repeat(32), order: 1, type_name: 'Create Record',
    inputs: [
      input('table_name', 'problem', { type: 'table_name' }),
      input('values', 'short_description=raised by automation', { type: 'template_value' }),
    ],
  })];
  const all = T.effectsOf(a, T.triggerOf(a));
  assert.equal(all[0].kind, 'unobservable');
  assert.equal(all[0].reason, 'created_record_not_linked');
});

test('T21 — a Create Record that DOES link back becomes a record_count promise', () => {
  const a = REFRESH();
  a.actions = [action({
    sys_id: 'c'.repeat(32), order: 1, type_name: 'Create Record',
    inputs: [
      input('table_name', 'problem', { type: 'table_name' }),
      input('values', 'parent={{Created_1.current}}^short_description=raised', { type: 'template_value' }),
    ],
  })];
  const all = T.effectsOf(a, T.triggerOf(a));
  assert.equal(all[0].kind, 'created_record');
  assert.equal(all[0].table, 'problem');
  assert.equal(all[0].link_field, 'parent');
});

/* ================================================================== *
 * §16 / §47 — THE FIXTURE
 * ================================================================== */

test('T22 — only two tables are disposable, and the list is frozen', () => {
  assert.deepEqual(T.DISPOSABLE_LIST, ['incident', 'chg_mgt_worker']);
  assert.equal(Object.isFrozen(T.DISPOSABLE_TABLES), true);
  assert.equal(T.isDisposable('change_request'), false);
  assert.equal(T.isDisposable('sys_user'), false);
  assert.equal(T.isDisposable('incident'), true);
});

test('T23 — a flow triggered on a table that is not disposable is BLOCKED, and nothing is written', () => {
  const a = REFRESH();
  a.triggers[0].table = 'ast_contract';
  const trigger = T.triggerOf(a);
  const f = T.buildFixture({
    trigger, satisfaction: T.satisfyCondition(trigger, { fields: null }),
    effects: { required: [] }, fields: null, taskId: TASK,
  });
  assert.equal(f.ok, false);
  assert.equal(f.block, 'FIXTURE_TABLE_NOT_DISPOSABLE');
  assert.match(f.note, /ast_contract/);
});

test('T24 — the marker carries the task id, so a leftover record names the run that left it', () => {
  const { fixture } = derive();
  assert.equal(fixture.marker, MARKER);
  assert.equal(T.readMarker(fixture.data[fixture.marker_field]), TASK);
  assert.notEqual(T.markerFor('a'), T.markerFor('b'), 'two runs would be indistinguishable');
});

test('T25 — the marker never lands in a field the flow writes or the trigger tests', () => {
  const { fixture, effects, satisfaction } = derive();
  const written = new Set([
    ...effects.required.map((e) => e.field),
    ...effects.conditional.map((e) => e.field),
    ...satisfaction.terms.map((t) => t.field),
  ]);
  assert.equal(written.has(fixture.marker_field), false,
    `the marker went into ${fixture.marker_field}, which is not left alone`);
});

test('T26 — when every candidate marker field is written by the flow, the run is BLOCKED', () => {
  const a = REFRESH();
  /* Give the flow a write to `message` — the only marker candidate this table has. */
  a.actions[0].inputs[2] = input('values', 'message=working', { type: 'template_value' });
  const trigger = T.triggerOf(a);
  const effects = T.requiredEffects(T.effectsOf(a, trigger));
  const f = T.buildFixture({
    trigger, satisfaction: T.satisfyCondition(trigger, { fields: WORKER_FIELDS() }),
    effects, fields: WORKER_FIELDS(), taskId: TASK,
  });
  assert.equal(f.ok, false);
  assert.equal(f.block, 'NO_MARKER_FIELD');
});

test('T27 — with no dictionary there is no marker field, so no fixture is built', () => {
  const { trigger, satisfaction, effects } = derive();
  const f = T.buildFixture({ trigger, satisfaction, effects, fields: null, taskId: TASK });
  assert.equal(f.ok, false);
  assert.equal(f.block, 'NO_MARKER_FIELD');
});

test('T28 — caller-supplied fixture fields are checked against the dictionary, the ledger and the flow', () => {
  const { trigger, effects } = derive();
  const base = { fields: WORKER_FIELDS(), effects, derivation: derivationOf, table: 'chg_mgt_worker' };

  const ok = T.validateExtraFields({ ...base, extra: { source_record: 'a'.repeat(32) } });
  assert.deepEqual(Object.keys(ok.accepted), ['source_record']);
  assert.deepEqual(ok.rejected, []);

  const ghost = T.validateExtraFields({ ...base, extra: { not_a_field: 'x' } });
  assert.deepEqual(Object.keys(ghost.accepted), []);
  assert.match(ghost.rejected[0].reason, /not a field/);

  const flowWrites = T.validateExtraFields({ ...base, extra: { state: '3' } });
  assert.deepEqual(Object.keys(flowWrites.accepted), []);
  assert.match(flowWrites.rejected[0].reason, /the flow itself writes state/);

  const derived = T.validateExtraFields({
    fields: INCIDENT_FIELDS(), effects: { required: [], conditional: [] },
    derivation: derivationOf, table: 'incident', extra: { priority: '1' },
  });
  assert.deepEqual(Object.keys(derived.accepted), []);
  assert.match(derived.rejected[0].reason, /computed by the platform/);

  assert.equal(trigger.table, 'chg_mgt_worker');
});

test('T29 — a rejected extra field blocks the fixture rather than being dropped quietly', () => {
  const { trigger, satisfaction, effects, fields } = derive();
  const f = T.buildFixture({
    trigger, satisfaction, effects, fields, taskId: TASK,
    extra: { state: '3' }, derivation: derivationOf,
  });
  assert.equal(f.ok, false);
  assert.equal(f.block, 'FIXTURE_UNSATISFIABLE');
  assert.match(f.note, /the flow itself writes state/);
});

/* ================================================================== *
 * §18 — CLEANUP OWNERSHIP
 * ================================================================== */

test('T30 — the ownership ledger records only real sys_ids, and only once each', () => {
  const owned = T.ownership();
  assert.equal(owned.claim({ table: 'incident', sys_id: 'a'.repeat(32) }), true);
  assert.equal(owned.claim({ table: 'incident', sys_id: 'a'.repeat(32) }), false, 'a duplicate was recorded twice');
  assert.equal(owned.claim({ table: 'incident', sys_id: 'INC0010038' }), false, 'a record number was accepted as an identity');
  assert.equal(owned.claim({ table: 'incident', sys_id: null }), false);
  assert.equal(owned.claim({ table: 'incident', sys_id: '' }), false);
  assert.equal(owned.size, 1);
});

test('T31 — a record the run did not create can never enter the ledger, so it can never be deleted', () => {
  const owned = T.ownership();
  owned.claim({ table: 'incident', sys_id: 'a'.repeat(32) });
  /* There is no API for adding by marker, by query or by name. Ownership is
   * claim-only, and claim takes a sys_id this run watched come back. */
  assert.deepEqual(Object.keys(owned).sort(), ['all', 'claim', 'outstanding', 'settle', 'size'].sort());
  assert.equal(owned.outstanding().length, 1);
  owned.settle({ sys_id: 'a'.repeat(32), deleted: true });
  assert.equal(owned.outstanding().length, 0);
});

test('T32 — settling a sys_id the ledger does not hold changes nothing', () => {
  const owned = T.ownership();
  owned.claim({ table: 'incident', sys_id: 'a'.repeat(32) });
  assert.equal(owned.settle({ sys_id: 'b'.repeat(32), deleted: true }), false);
  assert.equal(owned.outstanding().length, 1);
});

/* ================================================================== *
 * §12 / §23 — THE ASSERTION ENGINE
 * ================================================================== */

test('T33 — the promised effect becomes two assertions: it changed, and it is the value promised', () => {
  const { assertions } = contractOf();
  assert.deepEqual(assertions.map((a) => a.type), ['changed', 'equals']);
  assert.equal(assertions[1].expected, '3');
  assert.equal(assertions[1].field, 'state');
});

test('T34 — §12: an assertion on a field the FIXTURE wrote is refused, not marked and kept', () => {
  /* Make the flow write `type`, which the trigger condition also puts in the
   * fixture. The equality would be true however the flow behaved. */
  const a = REFRESH();
  a.actions[2].inputs[2] = input('values', 'type=refresh_services', { type: 'template_value' });
  const trigger = T.triggerOf(a);
  const effects = T.requiredEffects(T.effectsOf(a, trigger));
  const satisfaction = T.satisfyCondition(trigger, { fields: WORKER_FIELDS() });
  const fixture = T.buildFixture({ trigger, satisfaction, effects, fields: WORKER_FIELDS(), taskId: TASK });
  assert.equal(fixture.ok, true);

  const { assertions, refused } = T.assertionsFor({ effects, fixture, fields: WORKER_FIELDS() });
  assert.equal(assertions.some((x) => x.type === 'equals' && x.field === 'type'), false,
    'a trivially-true equality survived');
  assert.ok(refused.some((r) => r.field === 'type'));
  /* `changed` survives: "it is no longer what we set it to" IS evidence. */
  assert.ok(assertions.some((x) => x.type === 'changed' && x.field === 'type'));
});

test('T35 — equals, not_equals, exists, not_exists and contains each compare read-back only', () => {
  const after = { value: { state: cell('3'), message: cell('hello world'), other: cell('') }, source: { step: 's', tool: 'get_record' } };
  const run = (type, field, expected) => T.evaluate(
    [{ id: 'a1', type, field, expected, description: 'x', table: 't' }], { after },
  )[0];

  assert.equal(run('equals', 'state', '3').status, 'PASS');
  assert.equal(run('equals', 'state', '2').status, 'FAIL');
  assert.equal(run('not_equals', 'state', '2').status, 'PASS');
  assert.equal(run('exists', 'state').status, 'PASS');
  assert.equal(run('exists', 'other').status, 'FAIL');
  assert.equal(run('not_exists', 'other').status, 'PASS');
  assert.equal(run('contains', 'message', 'world').status, 'PASS');
  assert.equal(run('contains', 'message', 'planet').status, 'FAIL');
  /* Every one names the read that decided it (§43). */
  assert.equal(run('equals', 'state', '3').source.tool, 'get_record');
});

test('T36 — `changed` compares the read-back to the record AS CREATED, not to what was requested', () => {
  const assertions = [{ id: 'a1', type: 'changed', field: 'state', description: 'state changed', table: 'w' }];
  const created = { value: { state: cell('1') }, source: { step: 'create', tool: 'create_record' } };
  const after = { value: { state: cell('3') }, source: { step: 'read', tool: 'get_record' } };

  const moved = T.evaluate(assertions, { created, after })[0];
  assert.equal(moved.status, 'PASS');
  assert.match(moved.note, /"1" → "3"/);

  const still = T.evaluate(assertions, { created, after: { value: { state: cell('1') }, source: after.source } })[0];
  assert.equal(still.status, 'FAIL');
  assert.match(still.note, /unchanged since the record was created/);

  /* No before-state means UNAVAILABLE, never a pass and never a failure. */
  const blind = T.evaluate(assertions, { after })[0];
  assert.equal(blind.status, 'UNAVAILABLE');
});

test('T37 — §25: a reference is compared by sys_id, and the display value is shown, never compared', () => {
  const abel = 'a'.repeat(32);
  const other = 'b'.repeat(32);
  const a = [{ id: 'a1', type: 'reference_identity', field: 'assigned_to', expected: abel, description: 'assigned', table: 'incident' }];

  const right = T.evaluate(a, { after: { value: { assigned_to: cell(abel, 'Abel Tuter') }, source: {} } })[0];
  assert.equal(right.status, 'PASS');
  assert.match(right.note, new RegExp(abel));

  /* The same DISPLAY name on a different record must fail. This is the Phase 13
   * defect: a display name is not an identity. */
  const impostor = T.evaluate(a, { after: { value: { assigned_to: cell(other, 'Abel Tuter') }, source: {} } })[0];
  assert.equal(impostor.status, 'FAIL');
  assert.match(impostor.note, /expected sys_id/);
});

test('T38 — a reference the flow fills with a NAME cannot be checked, and says so', () => {
  const a = [{ id: 'a1', type: 'reference_identity', field: 'assigned_to', expected: 'Abel Tuter', description: 'assigned', table: 'incident' }];
  const r = T.evaluate(a, { after: { value: { assigned_to: cell('a'.repeat(32), 'Abel Tuter') }, source: {} } })[0];
  assert.equal(r.status, 'UNAVAILABLE', 'a display-name comparison was allowed to pass');
  assert.match(r.note, /not a sys_id/);
});

test('T39 — §26: a journal assertion reads journal ROWS and compares by containment', () => {
  const a = [{ id: 'a1', type: 'journal_added', field: 'work_notes', expected: 'Assigned by automation', description: 'note added', table: 'incident' }];
  const entries = (list) => ({ journal: { value: { entries: list }, source: { step: 'j', tool: 'get_record_journal' } } });

  const hit = T.evaluate(a, entries([
    { element: 'work_notes', value: 'Assigned by automation at 10:04', author: 'system' },
  ]))[0];
  assert.equal(hit.status, 'PASS');

  const wrongField = T.evaluate(a, entries([{ element: 'comments', value: 'Assigned by automation', author: 'system' }]))[0];
  assert.equal(wrongField.status, 'FAIL', 'a comment was accepted as a work note');

  const none = T.evaluate(a, entries([]))[0];
  assert.equal(none.status, 'FAIL');

  /* Not read at all is UNAVAILABLE — a different answer from "not written". */
  const unread = T.evaluate(a, {})[0];
  assert.equal(unread.status, 'UNAVAILABLE');
});

test('T40 — §27: record_count compares an actual count, and 0 is a failure not an absence of evidence', () => {
  const a = [{ id: 'a1', type: 'record_count', table: 'problem', field: 'parent', expected: 1, description: 'one problem' }];
  const counts = (rows) => ({ counts: new Map([['a1', { value: rows, source: { step: 'c', tool: 'query_records' } }]]) });

  assert.equal(T.evaluate(a, counts([{ sys_id: 'x' }]))[0].status, 'PASS');
  assert.equal(T.evaluate(a, counts([]))[0].status, 'FAIL');
  assert.equal(T.evaluate(a, counts([{}, {}]))[0].status, 'FAIL');
  assert.equal(T.evaluate(a, {})[0].status, 'UNAVAILABLE');
});

test('T41 — an unknown assertion type is UNAVAILABLE, never quietly true', () => {
  const r = T.evaluate([{ id: 'a1', type: 'vibes', field: 'state', description: 'x' }], {
    after: { value: { state: cell('3') }, source: {} },
  })[0];
  assert.equal(r.status, 'UNAVAILABLE');
});

/* ================================================================== *
 * §29 / §45 / §46 — THE CONTRACT
 * ================================================================== */

test('T42 — a well-formed contract validates and reports what it covers', () => {
  const { contract, check } = contractOf();
  assert.equal(check.ok, true, JSON.stringify(check.problems));
  assert.equal(check.coverage.any, true);
  assert.equal(check.coverage.required, 1);
  assert.equal(check.coverage.covered, 1);
  /*
   * Every promised effect is checked, so coverage IS complete and the run may
   * reach PASS. One action still does something no record read can see; that is
   * carried separately and is reported on every run, including a passing one —
   * see T93. Conflating the two made PASS unreachable for any real flow.
   */
  assert.equal(check.coverage.complete, true);
  assert.equal(check.coverage.unobservable.length, 1);
  assert.deepEqual(check.coverage.uncovered, []);
  assert.equal(contract.cleanup.strategy, 'delete_created_records');
  assert.equal(contract.artifact.sys_id, FLOW_ID);
});

test('T43 — a contract whose marker is missing from the fixture data is refused', () => {
  const { contract } = contractOf();
  const broken = { ...contract, fixture: { ...contract.fixture, data: { type: 'refresh_services' } } };
  const v = T.validateContract(broken);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.code === 'marker_not_written'));
});

test('T44 — a contract with nothing assertable is refused before anything is created', () => {
  const { contract } = contractOf();
  const empty = { ...contract, expected_effects: [], assertions: [] };
  const v = T.validateContract(empty);
  assert.equal(v.ok, false);
  assert.equal(v.block, 'NO_OBSERVABLE_EFFECT');
});

test('T45 — §46: a conditional or unobservable effect can never reach the REQUIRED list', () => {
  const { contract } = contractOf();
  for (const bad of [
    { ...contract, expected_effects: [{ ...contract.expected_effects[0], conditional: true }] },
    { ...contract, expected_effects: [{ ...contract.expected_effects[0], kind: 'unobservable' }] },
  ]) {
    const v = T.validateContract(bad);
    assert.equal(v.ok, false);
    assert.equal(v.block, 'CONTRACT_INVALID');
  }
});

/* ================================================================== *
 * §5 / §30 — THE PLAN
 * ================================================================== */

const PLAN_CAPS = {
  record_read: { capability: 'record_read', status: 'known', available: true, mechanism: 'rest', mutating: false, verification: 'none', requiresVerification: false },
  diagnostic_read: { capability: 'diagnostic_read', status: 'known', available: true, mechanism: 'rest', mutating: false, verification: 'none', requiresVerification: false },
  record_create: { capability: 'record_create', status: 'known', available: true, mechanism: 'rest', mutating: true, verification: 'read_back', requiresVerification: true },
  record_delete: { capability: 'record_delete', status: 'known', available: true, mechanism: 'rest', mutating: true, verification: 'read_back', requiresVerification: true },
};
const discoverStub = (name) => PLAN_CAPS[name] ?? {
  capability: name, status: 'unavailable', available: false, reason: 'mechanism_unavailable', mutating: true,
};

test('T46 — the plan a test runs passes the EXISTING validator, unmodified', () => {
  const { contract } = contractOf();
  const built = T.buildTestPlan({ contract, flow: { sys_id: FLOW_ID, name: 'Change - Refresh Impacted Services' } });
  const v = P.validatePlan(built.plan, { discover: discoverStub });
  assert.equal(v.valid, true, JSON.stringify(v.fatal, null, 1));
});

test('T47 — the plan is create → wait → read → delete, and every tool is in the registry', () => {
  const { contract } = contractOf();
  const built = T.buildTestPlan({ contract, flow: { sys_id: FLOW_ID, name: 'F' } });
  assert.deepEqual(built.plan.steps.map((s) => s.id),
    ['create_fixture', 'await_flow', 'read_back', 'delete_fixture']);
  for (const s of built.plan.steps) {
    assert.ok(toolMap.has(s.tool), `${s.tool} is not a registry tool`);
    assert.equal(Boolean(toolMap.get(s.tool).mutating), Boolean(s.mutating),
      `${s.id} disagrees with the registry about whether ${s.tool} writes`);
  }
});

test('T48 — the fixture identity reaches every later step as a declared REFERENCE, never a guess', () => {
  const { contract } = contractOf();
  const built = T.buildTestPlan({ contract, flow: { sys_id: FLOW_ID, name: 'F' } });
  for (const id of ['await_flow', 'read_back', 'delete_fixture']) {
    const s = built.plan.steps.find((x) => x.id === id);
    assert.deepEqual(s.inputs.sys_id, { $ref: 'create_fixture.result.sys_id' }, `${id} does not reference the create`);
  }
  /* And the reference is legal only because create_record declares the output. */
  assert.deepEqual(P.declaredOutputsOf('create_record'), { sys_id: { type: 'sys_id', from: 'sys_id' } });
  /* `validateDataflow` returns the list of PROBLEMS; empty is the pass. */
  assert.deepEqual(P.validateDataflow(built.plan), []);
});

test('T49 — §30: changing the fixture changes the fingerprint, so an old approval cannot cover it', () => {
  const { contract } = contractOf();
  const a = T.buildTestPlan({ contract, flow: { sys_id: FLOW_ID, name: 'F' } });
  const b = T.buildTestPlan({
    contract: { ...contract, fixture: { ...contract.fixture, data: { ...contract.fixture.data, operation: 'refresh' } } },
    flow: { sys_id: FLOW_ID, name: 'F' },
  });
  assert.notEqual(P.fingerprintPlan(a.plan), P.fingerprintPlan(b.plan));
  /* And the same contract always fingerprints the same, or nothing could be approved at all. */
  assert.equal(
    P.fingerprintPlan(T.buildTestPlan({ contract, flow: { sys_id: FLOW_ID, name: 'F' } }).plan),
    P.fingerprintPlan(a.plan),
  );
});

test('T50 — §31: the test plan REQUIRES approval, because it creates and deletes a record', () => {
  const { contract } = contractOf();
  const built = T.buildTestPlan({ contract, flow: { sys_id: FLOW_ID, name: 'F' } });
  const review = P.buildReview(built.plan, { fingerprint: 'x' });
  assert.equal(review.approvalRequired, true);
  assert.equal(P.mutatingSteps(built.plan).length, 2);
});

test('T51 — the cleanup plan deletes exactly one named record and nothing else', () => {
  const sysId = 'd'.repeat(32);
  const p = T.cleanupPlan({ table: 'incident', sysId, marker: MARKER });
  assert.equal(p.steps.length, 1);
  assert.equal(p.steps[0].tool, 'delete_record');
  assert.equal(p.steps[0].inputs.sys_id, sysId);
  const v = P.validatePlan(p, { discover: discoverStub });
  assert.equal(v.valid, true, JSON.stringify(v.fatal));
});

test('T52 — a record_count locator is only written for a table whose link field is real', () => {
  const assertions = [
    { id: 'a1', type: 'record_count', table: 'problem', field: 'parent', expected: 1 },
    { id: 'a2', type: 'record_count', table: 'ghost_table', field: 'parent', expected: 1 },
  ];
  const known = { problem: new Set(['parent']) };
  const countable = T.countableAssertions({
    assertions, markerField: 'short_description',
    hasField: async (t, f) => Boolean(known[t]?.has(f)),
  });
  return countable.then((map) => {
    assert.deepEqual([...map.keys()], ['a1']);
    const { contract } = contractOf();
    const built = T.buildTestPlan({ contract, flow: { sys_id: FLOW_ID, name: 'F' }, countable: map });
    const step = built.plan.steps.find((s) => s.id === 'count_created_1');
    assert.equal(step.inputs.query, `parent.short_descriptionSTARTSWITH${MARKER}`,
      'the locator must reach the marker through the link field, never a bare sys_id');
    assert.deepEqual(built.countOrder, ['a1']);
  });
});

/* ================================================================== *
 * §4 / §21 / §22 — THE RESULT ARITHMETIC
 * ================================================================== */

const passing = (over = {}) => {
  const c = contractOf();
  return {
    contract: c.contract,
    coverage: { ...c.check.coverage, complete: true },
    fixture: { created: true, sys_id: 'a'.repeat(32), table: 'chg_mgt_worker' },
    triggerCheck: { satisfied: true, checks: [], failed: [] },
    execution: { found: true, settled: true, state: 'EXECUTION_COMPLETE', waited_ms: 12000, timed_out: false },
    assertions: [
      { id: 'a1', type: 'changed', status: 'PASS' },
      { id: 'a2', type: 'equals', status: 'PASS', actual: '3' },
    ],
    cleanup: { status: 'PASS', records_created: 1, records_deleted: 1 },
    ...over,
  };
};

test('T53 — PASS requires every assertion to pass, complete coverage and a settled execution', () => {
  const r = T.decideResult(passing());
  assert.equal(r.status, 'PASS');
  assert.deepEqual(r.failures, []);
  assert.match(r.statement, /verified from ServiceNow read-back/);
});

test('T54 — §70.1: an EMPTY assertion list can never be PASS', () => {
  const r = T.decideResult(passing({ assertions: [] }));
  assert.equal(r.status, 'INCONCLUSIVE');
  assert.ok(r.failures.includes('ASSERTION_UNAVAILABLE'));
});

test('T55 — a failed assertion is FAIL, and the passing ones are preserved', () => {
  const r = T.decideResult(passing({
    assertions: [
      { id: 'a1', type: 'changed', status: 'PASS' },
      { id: 'a2', type: 'equals', status: 'FAIL', actual: '2' },
    ],
  }));
  assert.equal(r.status, 'FAIL');
  assert.equal(r.counts.passed, 1);
  assert.equal(r.counts.failed, 1);
  assert.ok(r.failures.includes('EXPECTED_EFFECT_WRONG'));
});

test('T56 — an effect that is MISSING and one that is WRONG are classified differently', () => {
  const missing = T.decideResult(passing({
    assertions: [{ id: 'a1', type: 'equals', status: 'FAIL', actual: '' }],
  }));
  assert.ok(missing.failures.includes('EXPECTED_EFFECT_MISSING'));

  const wrong = T.decideResult(passing({
    assertions: [{ id: 'a1', type: 'equals', status: 'FAIL', actual: '2' }],
  }));
  assert.ok(wrong.failures.includes('EXPECTED_EFFECT_WRONG'));
});

test('T57 — §22/§70.8: still running at the deadline is INCONCLUSIVE, never FAIL', () => {
  for (const state of ['EXECUTION_WAITING', 'EXECUTION_RUNNING', 'EXECUTION_PAUSED']) {
    const r = T.decideResult(passing({
      execution: { found: true, settled: false, timed_out: true, state, waited_ms: 90000, timeout_ms: 90000 },
      assertions: [{ id: 'a1', type: 'equals', status: 'FAIL', actual: '2' }],
    }));
    assert.equal(r.status, 'INCONCLUSIVE', `${state} produced ${r.status}`);
    assert.ok(r.failures.includes('TIMEOUT'));
    assert.match(r.statement, /No claim is made/);
  }
});

test('T58 — §70.7: a timeout is never presented as success either', () => {
  const r = T.decideResult(passing({
    execution: { found: true, settled: false, timed_out: true, state: 'EXECUTION_RUNNING', waited_ms: 90000, timeout_ms: 90000 },
  }));
  assert.notEqual(r.status, 'PASS');
  assert.equal(r.status, 'INCONCLUSIVE');
});

test('T59 — no execution recorded is INCONCLUSIVE: an absence within a window is not a proof', () => {
  const r = T.decideResult(passing({
    execution: { found: false, settled: false, timed_out: true, state: 'NO_EXECUTION_FOUND', waited_ms: 90000 },
    assertions: [{ id: 'a1', type: 'changed', status: 'FAIL' }],
  }));
  assert.equal(r.status, 'INCONCLUSIVE');
  assert.ok(r.failures.includes('FLOW_NOT_EXECUTED'));
});

test('T60 — §21: an execution that ERRORED is a FAIL, even when every assertion passed', () => {
  const r = T.decideResult(passing({
    execution: { found: true, settled: true, timed_out: false, state: 'EXECUTION_ERROR', waited_ms: 11000 },
  }));
  assert.equal(r.status, 'FAIL');
  assert.ok(r.failures.includes('FLOW_EXECUTION_ERROR'));
  assert.match(r.statement, /ended in ERROR/);
});

test('T61 — a fixture that was never created is BLOCKED, and nothing about the flow is claimed', () => {
  const r = T.decideResult(passing({
    fixture: { created: false, error: 'the instance refused the insert' },
    execution: null,
    assertions: [],
  }));
  assert.equal(r.status, 'BLOCKED');
  assert.ok(r.failures.includes('FIXTURE_SETUP_FAILED'));
  assert.match(r.statement, /never triggered/);
});

test('T62 — a record that did not satisfy the trigger is INCONCLUSIVE, not a verdict on the flow', () => {
  const r = T.decideResult(passing({
    triggerCheck: {
      satisfied: false, checks: [], failed: [{ field: 'priority', actual: '3', expected: '1' }],
      note: 'The record was created, but priority is "3" where the trigger needs "1".',
    },
    assertions: [{ id: 'a1', type: 'changed', status: 'FAIL' }],
  }));
  assert.equal(r.status, 'INCONCLUSIVE');
  assert.ok(r.failures.includes('TRIGGER_NOT_SATISFIED'));
  assert.match(r.statement, /never asked to do it/);
});

test('T63 — §13: an unavailable assertion prevents PASS and produces INCONCLUSIVE', () => {
  const r = T.decideResult(passing({
    assertions: [
      { id: 'a1', type: 'changed', status: 'PASS' },
      { id: 'a2', type: 'journal_added', status: 'UNAVAILABLE' },
    ],
  }));
  assert.equal(r.status, 'INCONCLUSIVE');
  assert.ok(r.failures.includes('ASSERTION_UNAVAILABLE'));
});

test('T64 — §13: incomplete COVERAGE prevents PASS even when everything checked passed', () => {
  const r = T.decideResult(passing({ coverage: { complete: false, required: 2, covered: 1, uncovered: ['a thing'], unobservable: [] } }));
  assert.equal(r.status, 'INCONCLUSIVE');
  assert.match(r.statement, /does not establish that the whole flow behaved correctly/);
});

test('T65 — §36/§70.3: a cleanup failure can never leave a PASS standing', () => {
  for (const status of ['FAILED', 'REFUSED', 'UNKNOWN']) {
    const r = T.decideResult(passing({ cleanup: { status, records_created: 1, records_deleted: 0 } }));
    assert.notEqual(r.status, 'PASS', `cleanup ${status} still reported PASS`);
    assert.equal(r.status, 'BLOCKED');
    assert.ok(r.failures.includes('CLEANUP_FAILED'));
    /* The finding about the FLOW is preserved rather than lost to the headline. */
    assert.equal(r.assertion_verdict, 'PASS');
  }
});

test('T66 — a FAIL with a failed cleanup stays a FAIL and gains the cleanup failure', () => {
  const r = T.decideResult(passing({
    assertions: [{ id: 'a1', type: 'equals', status: 'FAIL', actual: '2' }],
    cleanup: { status: 'FAILED', records_created: 1, records_deleted: 0 },
  }));
  assert.equal(r.status, 'FAIL');
  assert.ok(r.failures.includes('CLEANUP_FAILED'));
});

test('T67 — cancellation outranks every other answer', () => {
  const r = T.decideResult(passing({
    cancelled: true,
    assertions: [{ id: 'a1', type: 'equals', status: 'FAIL', actual: '2' }],
  }));
  assert.equal(r.status, 'CANCELLED');
});

test('T68 — decideResult is pure: the same input always gives the same answer', () => {
  const input = passing();
  assert.deepEqual(T.decideResult(input), T.decideResult(input));
});

/* ================================================================== *
 * §19 / §20 — EXECUTION POLLING
 * ================================================================== */

test('T69 — the poller stops the moment an execution settles, and reports how long it looked', async () => {
  const seen = [];
  const script = ['EXECUTION_WAITING', 'EXECUTION_WAITING', 'EXECUTION_COMPLETE'];
  let clock = 0;
  const r = await waitForFlowExecution({
    table: 'chg_mgt_worker', sys_id: 'a'.repeat(32), flow_sys_id: FLOW_ID,
    timeout_ms: 60_000, poll_ms: 3000,
    sleepFor: async (ms) => { clock += ms; },
    now: () => clock,
    readExecutions: async () => {
      const state = script[Math.min(seen.length, script.length - 1)];
      seen.push(state);
      return {
        subject: {}, found: true, state, count: 1, truncated: false, limit: 10,
        executions: [{ sys_id: 'e'.repeat(32), state, flow: { sys_id: FLOW_ID } }],
      };
    },
  });
  assert.equal(r.settled, true);
  assert.equal(r.timed_out, false);
  assert.equal(r.state, 'EXECUTION_COMPLETE');
  assert.equal(r.polls, 3, 'the poller did not stop at the first settled read');
  assert.equal(r.waited_ms, 6000);
});

test('T70a — a flow that never settles TIMES OUT within its bound, and says so', async () => {
  let clock = 0;
  let reads = 0;
  const r = await waitForFlowExecution({
    table: 'chg_mgt_worker', sys_id: 'a'.repeat(32), flow_sys_id: FLOW_ID,
    timeout_ms: 30_000, poll_ms: 3000,
    sleepFor: async (ms) => { clock += ms; },
    now: () => clock,
    readExecutions: async () => {
      reads += 1;
      return {
        subject: {}, found: true, state: 'EXECUTION_WAITING', count: 1, truncated: false, limit: 10,
        executions: [{ sys_id: 'e'.repeat(32), state: 'EXECUTION_WAITING', flow: { sys_id: FLOW_ID } }],
      };
    },
  });
  assert.equal(r.timed_out, true);
  assert.equal(r.settled, false);
  assert.equal(r.state, 'EXECUTION_WAITING');
  assert.equal(r.timeout_ms, 30_000);
  assert.ok(reads <= Math.ceil(30_000 / 3000) + 1, `the bound was exceeded: ${reads} reads`);
  assert.ok(r.waited_ms <= 30_000);
});

test('T70b — an execution belonging to a DIFFERENT flow is not evidence about this one', async () => {
  let clock = 0;
  const r = await waitForFlowExecution({
    table: 'chg_mgt_worker', sys_id: 'a'.repeat(32), flow_sys_id: FLOW_ID,
    timeout_ms: 3000, poll_ms: 1000,
    sleepFor: async (ms) => { clock += ms; },
    now: () => clock,
    readExecutions: async () => ({
      subject: {}, found: true, state: 'EXECUTION_COMPLETE', count: 1, truncated: false, limit: 10,
      executions: [{ sys_id: 'x'.repeat(32), state: 'EXECUTION_COMPLETE', flow: { sys_id: 'z'.repeat(32) } }],
    }),
  });
  assert.equal(r.found, false, "another flow's execution was counted as this flow's");
  assert.equal(r.state, 'NO_EXECUTION_FOUND');
  assert.equal(r.other_executions, 1, 'the other execution was hidden rather than reported separately');
});

test('T70c — a zero budget still performs exactly one read: "I did not look" is a different answer', async () => {
  let reads = 0;
  const r = await waitForFlowExecution({
    table: 'chg_mgt_worker', sys_id: 'a'.repeat(32),
    timeout_ms: 0, poll_ms: 1000,
    sleepFor: async () => {}, now: () => 0,
    readExecutions: async () => { reads += 1; return { subject: {}, found: false, state: 'NO_EXECUTION_FOUND', count: 0, executions: [], truncated: false, limit: 10 }; },
  });
  assert.equal(reads, 1);
  assert.equal(r.timed_out, true);
  assert.equal(r.found, false);
});

test('T70 — the poll ceiling and floor are clamped, never taken from the caller unchecked', () => {
  assert.equal(WAIT_LIMITS.MAX_TIMEOUT_MS >= WAIT_LIMITS.DEFAULT_TIMEOUT_MS, true);
  assert.equal(WAIT_LIMITS.MIN_POLL_MS >= 1000, true);
  assert.equal(T.DEFAULT_TEST_TIMEOUT_MS <= WAIT_LIMITS.MAX_TIMEOUT_MS, true);
});

test('T71 — only finished states are terminal; an unrecognised state keeps the poller looking', () => {
  assert.equal(isTerminalExecution('EXECUTION_COMPLETE'), true);
  assert.equal(isTerminalExecution('EXECUTION_ERROR'), true);
  assert.equal(isTerminalExecution('EXECUTION_CANCELLED'), true);
  assert.equal(isTerminalExecution('EXECUTION_INTERRUPTED'), true);
  assert.equal(isTerminalExecution('EXECUTION_WAITING'), false);
  assert.equal(isTerminalExecution('EXECUTION_RUNNING'), false);
  assert.equal(isTerminalExecution('EXECUTION_UNKNOWN'), false,
    'a state this build does not understand was treated as finished');
});

/* ================================================================== *
 * §3 / §8 — INTENT
 * ================================================================== */

test('T72 — §3: naming an existing record is refused, with the reason and the alternative', () => {
  for (const request of [
    'Test this flow against incident INC0010038.',
    'Run the flow test on CHG0000014.',
    `Test the flow against the existing record ${'a'.repeat(32)}.`,
  ]) {
    const d = T.detectUserFixture(request);
    assert.equal(d.mode, 'user_fixture', `${request} was not detected as a user fixture`);
    const refusal = T.userFixtureRefusal(d);
    assert.equal(refusal.block, 'USER_FIXTURE_MODE');
    assert.match(refusal.note, /disposable/);
  }
});

test('T73 — an ordinary test request is NOT mistaken for a user fixture', () => {
  for (const request of [
    'Test my Assign Incident flow.',
    'Does the Change - Refresh Impacted Services flow work?',
    'Run the flow test.',
  ]) {
    assert.equal(T.detectUserFixture(request).mode, 'disposable_fixture', `${request} was refused`);
  }
});

test('T74 — §8: an ambiguous flow name BLOCKS and never asks a model to choose', async () => {
  const intent = await T.readTestIntent({
    request: 'Test the Change flow.',
    find: async () => ({ ok: false, reason: 'ambiguous', candidates: [{ sys_id: 'a', name: 'A' }, { sys_id: 'b', name: 'B' }], note: 'two matched' }),
    chat: () => { throw new Error('the model must never be asked to break a tie'); },
  });
  assert.equal(intent.ok, false);
  assert.equal(intent.block, 'FLOW_AMBIGUOUS');
});

test('T75 — a flow that does not exist BLOCKS rather than testing something else', async () => {
  const intent = await T.readTestIntent({
    request: 'Test the Zzz Nonexistent flow.',
    find: async () => ({ ok: false, reason: 'not_found', candidates: [], note: 'nothing matched' }),
    chat: null,
  });
  assert.equal(intent.ok, false);
  assert.equal(intent.block, 'FLOW_NOT_IDENTIFIED');
});

/* ================================================================== *
 * §38 / §39 / §40 — THE REPORT
 * ================================================================== */

const rendered = (over) => T.renderTest({
  status: 'PASS',
  statement: 'All 2 expected effect(s) were verified from ServiceNow read-back.',
  flow: { sys_id: FLOW_ID, name: 'Change - Refresh Impacted Services' },
  fixture: { created: true, sys_id: 'a'.repeat(32), table: 'chg_mgt_worker', marker: MARKER, marker_field: 'message', data: { type: 'refresh_services', message: `${MARKER} x` } },
  execution: { found: true, settled: true, state: 'EXECUTION_COMPLETE', waited_ms: 37000, executions: [{ sys_id: 'e'.repeat(32), state: 'EXECUTION_COMPLETE' }] },
  assertions: [
    { id: 'a1', type: 'changed', description: 'state changed', status: 'PASS', note: '"1" → "3"', source: { step: 'read_back', tool: 'get_record' } },
    { id: 'a2', type: 'equals', description: 'state is "3"', expected: '3', actual: '3', status: 'PASS', source: { step: 'read_back', tool: 'get_record' } },
  ],
  cleanup: { status: 'PASS', records_created: 1, records_deleted: 1 },
  failures: [], limitations: [], contract: { trigger: { derived: [] } },
  ...over,
});

test('T76 — a PASS report shows setup, execution, every assertion, cleanup, then the verdict', () => {
  const md = rendered({});
  for (const section of ['### Test setup', '### Execution', '### Assertions', '### Cleanup', '## PASS']) {
    assert.ok(md.includes(section), `the report is missing ${section}`);
  }
  assert.ok(md.indexOf('### Cleanup') < md.indexOf('## PASS'), 'the verdict came before the cleanup line');
  assert.match(md, /read by read_back \(get_record\)/, 'an assertion does not name the read that decided it');
});

test('T77 — §39: an INCONCLUSIVE report says explicitly that nothing is claimed', () => {
  const md = rendered({
    status: 'INCONCLUSIVE',
    statement: 'The flow was triggered, but its execution was still waiting when the timeout expired.',
    execution: { found: true, settled: false, timed_out: true, state: 'EXECUTION_WAITING', waited_ms: 90000, executions: [{ sys_id: 'e'.repeat(32), state: 'EXECUTION_WAITING' }] },
    failures: ['TIMEOUT'],
  });
  assert.match(md, /## INCONCLUSIVE/);
  assert.match(md, /No claim is made about whether the expected effect would eventually occur\./);
  assert.equal(/## PASS|## FAIL/.test(md), false);
});

test('T78 — §62: a FAIL report states what was observed and refuses to explain it', () => {
  const md = rendered({
    status: 'FAIL',
    statement: 'The flow executed, and 1 of 2 expected effect(s) did not occur as promised.',
    assertions: [
      { id: 'a1', type: 'changed', description: 'state changed', status: 'PASS', source: { step: 'read_back', tool: 'get_record' } },
      { id: 'a2', type: 'equals', description: 'state is "3"', expected: '3', actual: '2', status: 'FAIL', source: { step: 'read_back', tool: 'get_record' } },
    ],
    failures: ['EXPECTED_EFFECT_WRONG'],
    doctor: { available: true, request: 'Why did the flow not produce its expected effect?' },
  });
  assert.match(md, /## FAIL/);
  assert.match(md, /It does not establish why\./);
  assert.match(md, /Investigate with Doctor/);
  assert.match(md, /expected `3`/);
  assert.match(md, /observed `2`/);
});

test('T79 — §36: a failed cleanup is never a footnote; it names the record left behind', () => {
  const md = rendered({
    status: 'BLOCKED',
    cleanup: { status: 'FAILED', records_created: 1, records_deleted: 0, note: 'chg_mgt_worker aaaa is still on the instance' },
    failures: ['CLEANUP_FAILED'],
  });
  assert.match(md, /Cleanup failed/);
  assert.match(md, /still on the instance/);
});

test('T80 — a BLOCKED run explains itself and reports that nothing was created', () => {
  const md = T.renderTest({
    status: 'BLOCKED',
    statement: 'blocked',
    stopped: { reason: 'FIXTURE_TABLE_NOT_DISPOSABLE', note: 'This flow is triggered by records on "ast_contract".' },
    cleanup: { status: 'NOT_NEEDED', records_created: 0, records_deleted: 0 },
    flow: { name: 'Contract Approval Flow' },
  });
  assert.match(md, /### Not run/);
  assert.match(md, /ast_contract/);
  assert.match(md, /Nothing was created/);
});

test('T81 — §40/§62: Doctor is offered, never launched, and is offered only on a FAIL', () => {
  const src = fs.readFileSync(new URL('../src/agent/test/runner.js', import.meta.url), 'utf8');
  assert.equal(/\bdiagnose\s*\(/.test(src), false, 'the runner starts an investigation by itself');
  assert.equal(/from '\.\.\/doctor/.test(src), false, 'the test domain imports the Doctor');
  const md = rendered({ doctor: { available: true, request: 'why?' } });
  assert.equal(md.includes('Investigate with Doctor'), false,
    'the Doctor continuation was offered on a PASS');
  /* And the builder refuses to produce one for anything but a FAIL, so the two
   * checks are independent rather than one guarding the other. */
  assert.match(fs.readFileSync(new URL('../src/agent/test/runner.js', import.meta.url), 'utf8'),
    /if \(verdict\.status !== RESULTS\.FAIL\) return null;/);
});

/* ================================================================== *
 * §17 / §32 — THE CLEANUP GUARANTEE
 * ================================================================== */

/** A cleanup harness with a scripted executor. */
function cleanupHarness({ deleteWorks = true, approved = true, planOk = true } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      run: async ({ taskId }) => { calls.push(`run:${taskId}`); return { ok: deleteWorks, reason: deleteWorks ? 'ok' : 'error', note: 'the instance refused' }; },
      generate: async ({ propose }) => (planOk
        ? { ok: true, plan: propose(), discovered: {} }
        : { ok: false, reason: 'refused' }),
      planApi: {
        save: () => ({ ok: true, fingerprint: 'fp' }),
        setState: () => ({ ok: true }),
        approve: () => ({ ok: true }),
        review: () => ({ goal: 'g', steps: [1], plannedChanges: [1] }),
        load: () => null,
      },
      newTaskId: () => `cleanup-${calls.length}`,
      approve: async () => ({ approved, source: 'user_click' }),
      autoApprove: false,
    },
  };
}

test('T82 — nothing created means nothing to clean up, and that is not a failure', async () => {
  const h = cleanupHarness();
  const owned = T.ownership();
  const r = await T.ensureCleanup({ owned, ...h.deps, plan: h.deps.planApi, planApi: h.deps.planApi });
  assert.equal(r.status, 'NOT_NEEDED');
  assert.equal(r.records_created, 0);
  assert.deepEqual(h.calls, []);
});

test('T83 — a fixture the plan already deleted needs no second plan', async () => {
  const h = cleanupHarness();
  const owned = T.ownership();
  owned.claim({ table: 'incident', sys_id: 'a'.repeat(32) });
  owned.settle({ sys_id: 'a'.repeat(32), deleted: true });
  const r = await T.ensureCleanup({ owned, ...h.deps, planApi: h.deps.planApi, alreadyDone: true });
  assert.equal(r.status, 'PASS');
  assert.equal(r.records_deleted, 1);
  assert.deepEqual(h.calls, [], 'a second cleanup plan ran for a record already gone');
});

test('T84 — a fixture the plan did NOT delete gets a second plan, through the same executor', async () => {
  const h = cleanupHarness();
  const owned = T.ownership();
  owned.claim({ table: 'incident', sys_id: 'a'.repeat(32), marker: MARKER });
  const r = await T.ensureCleanup({ owned, ...h.deps, planApi: h.deps.planApi });
  assert.equal(r.status, 'PASS');
  assert.equal(h.calls.length, 1, 'the leftover was not cleaned up');
});

test('T85 — §36/§70.3: a cleanup that fails is REPORTED, with the record named', async () => {
  const h = cleanupHarness({ deleteWorks: false });
  const owned = T.ownership();
  owned.claim({ table: 'incident', sys_id: 'a'.repeat(32) });
  const r = await T.ensureCleanup({ owned, ...h.deps, planApi: h.deps.planApi });
  assert.equal(r.status, 'FAILED');
  assert.equal(r.records_deleted, 0);
  assert.match(r.note, /still on the instance/);
  assert.match(r.note, new RegExp('a'.repeat(32)));
});

test('T86 — a cleanup nobody approved is REFUSED, and is never reported as done', async () => {
  const h = cleanupHarness({ approved: false });
  const owned = T.ownership();
  owned.claim({ table: 'incident', sys_id: 'a'.repeat(32) });
  const r = await T.ensureCleanup({ owned, ...h.deps, planApi: h.deps.planApi });
  assert.equal(r.status, 'REFUSED');
  assert.equal(r.records_deleted, 0);
});

test('T87 — a cleanup plan the validator refuses is reported, not swallowed', async () => {
  const h = cleanupHarness({ planOk: false });
  const owned = T.ownership();
  owned.claim({ table: 'incident', sys_id: 'a'.repeat(32) });
  const r = await T.ensureCleanup({ owned, ...h.deps, planApi: h.deps.planApi });
  assert.equal(r.status, 'FAILED');
  assert.match(r.note, /cleanup plan refused/);
});

test('T88 — with no way to raise a second plan, the leftover is still reported', async () => {
  const owned = T.ownership();
  owned.claim({ table: 'incident', sys_id: 'a'.repeat(32) });
  const r = await T.ensureCleanup({ owned, newTaskId: null });
  assert.equal(r.status, 'FAILED');
  assert.match(r.note, /remain/);
});

/* ================================================================== *
 * §66 / §67 — DURABLE STATE
 * ================================================================== */

test('T89 — §66: a test result is stored on the existing task row, with no new table', async () => {
  const { getDb } = await import('../src/memory/db.js');
  const { createTask, startTask } = await import('../src/memory/tasks.js');
  const { recordTest, loadTest } = await import('../src/agent/plan/store.js');

  const sid = 'p17-store';
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const task = createTask({ sessionId: sid, goal: 'test a flow' });
  startTask(task.id);

  const stored = recordTest(task.id, { status: 'PASS', assertions: [{ id: 'a1', status: 'PASS' }] });
  assert.equal(stored.ok, true);
  const back = loadTest(task.id);
  assert.equal(back.status, 'PASS');
  assert.equal(back.assertions.length, 1);
  assert.ok(back.at, 'the stored result carries no timestamp');

  /* And the schema is unchanged. */
  const version = getDb().prepare('PRAGMA user_version').get();
  assert.equal(Object.values(version)[0], 23, 'the database version moved');
  const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.equal(tables.some((t) => /nowtest|test_run|flow_test/i.test(t)), false, 'a NowTest table was created');
});

test('T90 — a lint result and a test result can live on the same task without colliding', async () => {
  const { getDb } = await import('../src/memory/db.js');
  const { createTask, startTask } = await import('../src/memory/tasks.js');
  const { recordTest, loadTest, recordLint, loadLint } = await import('../src/agent/plan/store.js');

  const sid = 'p17-store-2';
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const task = createTask({ sessionId: sid, goal: 'both' });
  startTask(task.id);

  recordLint(task.id, { findings: [{ rule_id: 'FLOW001' }] });
  recordTest(task.id, { status: 'FAIL' });
  assert.equal(loadLint(task.id).findings.length, 1);
  assert.equal(loadTest(task.id).status, 'FAIL');
});

/* ================================================================== *
 * REGRESSIONS — each of these is a defect that reached the code
 * ================================================================== */

test('T91 — the record_count locator uses STARTSWITH, because the marker is only a PREFIX', () => {
  /*
   * FOUND BY REVIEW. The locator was `<link>.<marker_field>=<marker>`, and the
   * fixture never stores the bare marker — it stores the marker followed by a
   * human-readable label. `=` is the platform's `is`, so the query matched
   * nothing, every count read zero, and a flow that created its record exactly
   * as promised would have been reported as having failed to.
   *
   * The expectation is DERIVED from the fixture rather than restated, so the
   * two halves cannot drift apart again.
   */
  const { contract } = contractOf();
  const stored = String(contract.fixture.data[contract.fixture.marker_field]);
  assert.ok(stored.startsWith(contract.fixture.marker), 'the marker is no longer a prefix of what is stored');
  assert.notEqual(stored, contract.fixture.marker, 'the fixture now stores the bare marker; re-check the operator');

  const countable = new Map([['a1', { table: 'problem', link_field: 'parent', marker_field: contract.fixture.marker_field }]]);
  const built = T.buildTestPlan({ contract, flow: { sys_id: FLOW_ID, name: 'F' }, countable });
  const step = built.plan.steps.find((s) => s.id === 'count_created_1');
  assert.equal(step.inputs.query, `parent.${contract.fixture.marker_field}STARTSWITH${contract.fixture.marker}`);
  assert.equal(step.inputs.query.includes(`${contract.fixture.marker_field}=`), false,
    'an equality locator can never match a marker that is only a prefix of the stored value');
});

test('T92 — a SETTLED execution that did not COMPLETE is INCONCLUSIVE, never a verdict', () => {
  /*
   * FOUND BY REVIEW, and it reported PASS. CANCELLED and PRESUMED_INTERRUPTED
   * are terminal for the POLLER — there is nothing left to wait for — and the
   * result arithmetic read "terminal" as "finished", so a flow somebody had
   * stopped half way came back with a clean bill of health.
   */
  const base = passing();
  for (const state of ['EXECUTION_CANCELLED', 'EXECUTION_INTERRUPTED']) {
    const clean = T.decideResult({ ...base, execution: { found: true, settled: true, timed_out: false, state } });
    assert.equal(clean.status, 'INCONCLUSIVE', `${state} with all assertions passing reported ${clean.status}`);
    assert.ok(clean.failures.includes('FLOW_NOT_EXECUTED'));
    assert.match(clean.statement, /never ran to the end/);

    /* And it is not silently converted into a failure either. */
    const failing = T.decideResult({
      ...base,
      execution: { found: true, settled: true, timed_out: false, state },
      assertions: [{ id: 'a1', type: 'equals', status: 'FAIL', actual: '2' }],
    });
    assert.equal(failing.status, 'INCONCLUSIVE', `${state} with a failing assertion reported ${failing.status}`);
    assert.equal(failing.failures.includes('FLOW_EXECUTION_ERROR'), false,
      'a cancelled execution was blamed on the flow');
  }
  /* ERROR keeps its own answer: that one IS the flow failing. */
  const errored = T.decideResult({ ...base, execution: { found: true, settled: true, timed_out: false, state: 'EXECUTION_ERROR' } });
  assert.equal(errored.status, 'FAIL');
  assert.ok(errored.failures.includes('FLOW_EXECUTION_ERROR'));
});

/* ------------------------------------------------------------------ *
 * An end-to-end runner harness: the real domain, a scripted executor
 * ------------------------------------------------------------------ */

/**
 * Drive `testFlow` with a scripted executor.
 *
 * `script` says what each step's tool returned; `cancelAfter` aborts the plan
 * at a step boundary the way the real executor does. Everything between the
 * request and the verdict is the shipped code — the intent reader, the trigger
 * derivation, the effects, the fixture, the assertions, the contract, the plan,
 * the evidence collection, the arithmetic and the cleanup guarantee.
 */
function harness({ script = {}, cancelAfter = null, cleanupWorks = true } = {}) {
  const stored = { plan: null, steps: [] };
  const cleanupTasks = new Set();

  const planApi = {
    save: (taskId, plan) => {
      stored.plan = plan;
      stored.steps = plan.steps.map((s) => ({
        id: s.id, tool: s.tool, inputs: s.inputs, state: 'pending',
        result: null, failureReason: null, completedAt: null,
      }));
      return { ok: true, fingerprint: P.fingerprintPlan(plan), steps: plan.steps.length };
    },
    load: () => (stored.plan ? { taskId: TASK, steps: stored.steps } : null),
    setState: () => ({ ok: true }),
    approve: () => ({ ok: true, fingerprint: 'fp' }),
    review: (plan) => ({
      goal: plan.goal, steps: plan.steps, plannedChanges: P.mutatingSteps(plan),
      approvalRequired: P.mutatingSteps(plan).length > 0, destructive: [],
    }),
    violations: P.mutatingSteps,
  };

  const run = async ({ taskId }) => {
    if (cleanupTasks.has(taskId)) {
      return { ok: cleanupWorks, reason: cleanupWorks ? 'ok' : 'error', note: 'the delete was refused' };
    }
    for (const s of stored.steps) {
      if (script[s.id] === 'fail') {
        s.state = 'failed';
        s.failureReason = 'the instance refused it';
        return { ok: false, reason: 'error' };
      }
      s.state = 'completed';
      s.completedAt = '2026-01-01 00:00:00';
      s.result = script[s.id] ?? null;
      if (cancelAfter === s.id) {
        for (const rest of stored.steps.filter((x) => x.state === 'pending')) rest.state = 'cancelled';
        return { ok: false, reason: 'cancelled' };
      }
    }
    return { ok: true };
  };

  return {
    stored,
    deps: {
      taskId: TASK,
      sessionId: 'harness',
      find: async () => ({ ok: true, sys_id: FLOW_ID, name: 'Change - Refresh Impacted Services' }),
      readArtifact: async () => REFRESH(),
      chat: null,
      schemaFor: async (t) => (t === 'chg_mgt_worker' ? { fields: [...WORKER_FIELDS().values()] } : { fields: [] }),
      derivation: derivationOf,
      generate: async ({ goal, propose }) => ({ ok: true, plan: { ...propose(), goal }, discovered: {} }),
      run,
      plan: planApi,
      approve: async () => ({ approved: true, source: 'user_click', at: 'now' }),
      newTaskId: () => { const id = `cleanup-${cleanupTasks.size}`; cleanupTasks.add(id); return id; },
      record: null,
    },
  };
}

/* The record as the platform stored it. It carries BOTH trigger terms, because
 * `verifyTriggerSatisfied` reads the created record back and stops the run when
 * the fixture did not actually match — which it should. */
const FIXTURE_ROW = {
  sys_id: cell('c'.repeat(32)), state: cell('1'),
  type: cell('refresh_services'), source_table: cell('change_request'),
  /* The insert response carries the WHOLE record under display=all, so a field
   * the fixture never wrote is present and empty rather than absent. That
   * matters: `unexpectedEffects` compares two read-backs and skips any field
   * missing from the before-state, because "it appeared" and "it changed" are
   * not the same observation and only one of them is evidence. */
  operation: cell(''), message: cell(''),
};
const COMPLETED = {
  found: true, settled: true, timed_out: false, state: 'EXECUTION_COMPLETE', waited_ms: 5000, count: 1,
  executions: [{ sys_id: 'e'.repeat(32), state: 'EXECUTION_COMPLETE' }],
};

test('T93 — end to end: the flow does what it promised → PASS, and the fixture is deleted', async () => {
  const h = harness({
    script: {
      create_fixture: FIXTURE_ROW,
      await_flow: COMPLETED,
      read_back: { ...FIXTURE_ROW, state: cell('3') },
      delete_fixture: { ok: true },
    },
  });
  const r = await T.testFlow({ ...h.deps, request: 'Test the Change - Refresh Impacted Services flow.' });
  assert.equal(r.status, 'PASS', `${r.status}: ${r.statement}`);
  assert.equal(r.counts.passed, 2);
  assert.equal(r.counts.failed, 0);
  assert.equal(r.cleanup.status, 'PASS');
  assert.equal(r.cleanup.records_deleted, 1);
  /* §13 — the PASS names what it does not cover, rather than omitting it. */
  assert.match(r.statement, /no record read can observe/);
  assert.ok(r.limitations.length > 0, 'the unobservable action was omitted silently');
  assert.match(T.renderTest(r), /### Not covered by this test/);
});

test('T94 — end to end: cancelled after the fixture exists → CANCELLED, and cleanup still runs', async () => {
  const h = harness({ cancelAfter: 'create_fixture', script: { create_fixture: FIXTURE_ROW } });
  const r = await T.testFlow({ ...h.deps, request: 'Test the Change - Refresh Impacted Services flow.' });
  assert.equal(r.status, 'CANCELLED');
  assert.match(r.statement, /cancelled after 1 step/);
  assert.equal(r.cleanup.records_created, 1);
  assert.equal(r.cleanup.status, 'PASS', 'the fixture was not cleaned up after a cancellation');
  assert.equal(r.cleanup.records_deleted, 1);
});

test('T95 — end to end: cancelled AND the cleanup fails → CANCELLED, CLEANUP_FAILED, real counts', async () => {
  /*
   * FOUND BY REVIEW. The cancelled verdict used to be hand-built, so it
   * reported `failures: []` for a run that had left a record on the instance,
   * and `passed: 0` beside assertion rows that had passed. Both come from
   * `decideResult` now — the code that was already tested for exactly this.
   */
  const h = harness({
    cancelAfter: 'read_back',
    cleanupWorks: false,
    script: {
      create_fixture: FIXTURE_ROW,
      await_flow: COMPLETED,
      read_back: { ...FIXTURE_ROW, state: cell('3') },
    },
  });
  const r = await T.testFlow({ ...h.deps, request: 'Test the Change - Refresh Impacted Services flow.' });
  assert.equal(r.status, 'CANCELLED');
  assert.ok(r.failures.includes('CLEANUP_FAILED'), 'a run that left a record behind reported no failure');
  assert.equal(r.cleanup.status, 'FAILED');
  assert.equal(r.counts.total, r.counts.passed + r.counts.failed + r.counts.unavailable, 'the tally does not add up');
  assert.equal(r.counts.passed, 2, 'assertions that really passed were counted as zero');
  assert.match(T.renderTest(r), /Cleanup failed/);
});

test('T96 — end to end: a create that fails is BLOCKED, and nothing is claimed about the flow', async () => {
  const h = harness({ script: { create_fixture: 'fail' } });
  const r = await T.testFlow({ ...h.deps, request: 'Test the Change - Refresh Impacted Services flow.' });
  assert.equal(r.status, 'BLOCKED');
  assert.ok(r.failures.includes('FIXTURE_SETUP_FAILED'));
  assert.equal(r.cleanup.records_created, 0, 'a fixture was claimed for a create that failed');
  assert.match(r.statement, /never triggered/);
});

test('T97 — end to end: the flow runs and does NOT keep its promise → FAIL, one assertion still passing', async () => {
  const h = harness({
    script: {
      create_fixture: FIXTURE_ROW,
      await_flow: {
        found: true, settled: true, timed_out: false, state: 'EXECUTION_ERROR', waited_ms: 11000, count: 1,
        executions: [{ sys_id: 'e'.repeat(32), state: 'EXECUTION_ERROR', error: 'Cannot convert null to an object.' }],
      },
      read_back: { ...FIXTURE_ROW, state: cell('2') },
      delete_fixture: { ok: true },
    },
  });
  const r = await T.testFlow({ ...h.deps, request: 'Test the Change - Refresh Impacted Services flow.' });
  assert.equal(r.status, 'FAIL');
  assert.ok(r.failures.includes('FLOW_EXECUTION_ERROR'));
  assert.equal(r.counts.passed, 1, 'the passing assertion was lost');
  assert.equal(r.counts.failed, 1);
  assert.equal(r.cleanup.status, 'PASS');
  assert.equal(r.doctor?.available, true);
  assert.match(T.renderTest(r), /It does not establish why\./);
});

test('T98 — end to end: a flow on a table that is not disposable never reaches the executor', async () => {
  const artifact = REFRESH();
  artifact.triggers[0].table = 'change_request';
  let ran = false;
  const h = harness();
  const r = await T.testFlow({
    ...h.deps,
    readArtifact: async () => artifact,
    run: async () => { ran = true; return { ok: true }; },
    request: 'Test the Delegate Roles in Group flow.',
  });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.stopped.reason, 'FIXTURE_TABLE_NOT_DISPOSABLE');
  assert.equal(ran, false, 'a plan executed for a table that is not disposable');
  assert.equal(r.cleanup.records_created, 0);
});

test('T99 — end to end: a fixture that did not actually match the trigger stops the run', async () => {
  /*
   * FOUND WHILE WRITING T93, by getting the scripted record wrong. The fixture
   * asked for `source_table=change_request`; the record came back without it.
   * The flow was therefore never going to run, and blaming it for not having
   * run would be exactly the unsupported claim §45 and §56 exist to prevent.
   */
  const h = harness({
    script: {
      create_fixture: { sys_id: cell('c'.repeat(32)), state: cell('1'), type: cell('refresh_services') },
      await_flow: COMPLETED,
      read_back: { sys_id: cell('c'.repeat(32)), state: cell('1'), type: cell('refresh_services') },
      delete_fixture: { ok: true },
    },
  });
  const r = await T.testFlow({ ...h.deps, request: 'Test the Change - Refresh Impacted Services flow.' });
  assert.equal(r.status, 'INCONCLUSIVE');
  assert.ok(r.failures.includes('TRIGGER_NOT_SATISFIED'));
  assert.match(r.statement, /never asked to do it/);
  assert.equal(r.trigger_check.satisfied, false);
  assert.equal(r.trigger_check.failed[0].field, 'source_table');
  /* And it is still cleaned up. */
  assert.equal(r.cleanup.status, 'PASS');
});

test('T100 — exactly one terminal frame leaves a test stream', async () => {
  /*
   * FOUND ON REVIEW OF THE WIRING. The domain and the route both emitted
   * `test_complete`, so two terminal frames reached one stream — the route's
   * carrying the result, the runner's carrying only a status. The client
   * happened to cope by keying on the payload rather than the type, which is
   * exactly the kind of coping that stops working the day somebody writes a
   * second client.
   *
   * The invariant this build holds everywhere: a stream ends on ONE frame. The
   * domain now says `test_decided` — the verdict is known — and the route says
   * `test_complete` — the stream is over.
   */
  const frames = [];
  const h = harness({
    script: {
      create_fixture: FIXTURE_ROW,
      await_flow: COMPLETED,
      read_back: { ...FIXTURE_ROW, state: cell('3') },
      delete_fixture: { ok: true },
    },
  });
  await T.testFlow({
    ...h.deps,
    request: 'Test the Change - Refresh Impacted Services flow.',
    emit: (e) => frames.push(e.type),
  });
  assert.equal(frames.filter((f) => f === 'test_complete').length, 0,
    'the domain emitted a terminal frame that belongs to the route');
  assert.equal(frames.filter((f) => f === 'test_decided').length, 1);

  const runnerSrc = fs.readFileSync(new URL('../src/agent/test/runner.js', import.meta.url), 'utf8');
  const routeSrc = fs.readFileSync(new URL('../src/routes/plan.js', import.meta.url), 'utf8');
  assert.equal(/emit\(\{\s*type:\s*'test_complete'/.test(runnerSrc), false,
    'the runner emits the terminal frame again');
  assert.equal((routeSrc.match(/emit\(\{\s*type:\s*'test_complete'/g) ?? []).length, 1,
    'the route no longer emits exactly one terminal frame');
});

/* ================================================================== *
 * §28 — EFFECTS NOBODY ASKED ABOUT
 * ================================================================== */

test('T101 — a field the flow changed outside the contract is reported as a RISK', () => {
  const created = {
    value: {
      state: cell('1'), work_start: cell(''), assigned_to: cell(''),
      sys_mod_count: cell('0'), priority: cell('3'), type: cell('refresh_services'),
    },
    source: {},
  };
  const after = {
    value: {
      state: cell('3'), work_start: cell('2026-01-01 09:00:00'), assigned_to: cell(''),
      sys_mod_count: cell('2'), priority: cell('1'), type: cell('refresh_services'),
    },
    source: { step: 'read_back', tool: 'get_record' },
  };
  const found = T.unexpectedEffects({ created, after, promised: ['state'], derived: ['priority'] });

  assert.equal(found.length, 1, JSON.stringify(found.map((f) => f.field)));
  assert.equal(found[0].field, 'work_start');
  assert.equal(found[0].severity, 'RISK');
  assert.equal(found[0].source.tool, 'get_record', 'the read that saw it is not named');

  /* Each exclusion is deliberate and is asserted separately. */
  const fields = found.map((f) => f.field);
  assert.equal(fields.includes('state'), false, 'a promised effect was reported as unexpected');
  assert.equal(fields.includes('priority'), false, 'a platform-derived field was blamed on the flow');
  assert.equal(fields.includes('sys_mod_count'), false, 'housekeeping was reported as an effect');
  assert.equal(fields.includes('assigned_to'), false, 'an unchanged field was reported as changed');
});

test('T102 — §28: an unexpected effect never decides the result', () => {
  const withRisk = T.decideResult(passing({ unexpected: [{ field: 'work_start', severity: 'RISK' }] }));
  assert.equal(withRisk.status, 'PASS', 'an unexpected effect turned a passing test into something else');
  assert.ok(withRisk.failures.includes('UNEXPECTED_EFFECT'), 'the risk was not recorded at all');

  /* And with nothing unexpected, the classification is absent rather than empty. */
  const clean = T.decideResult(passing());
  assert.equal(clean.failures.includes('UNEXPECTED_EFFECT'), false);
});

test('T103 — with no before-state or no after-state, nothing is claimed to be unexpected', () => {
  const after = { value: { state: cell('3') }, source: {} };
  assert.deepEqual(T.unexpectedEffects({ created: null, after }), []);
  assert.deepEqual(T.unexpectedEffects({ created: after, after: null }), []);
  assert.deepEqual(T.unexpectedEffects({}), []);
});

test('T104 — end to end: an unexpected change is surfaced in the report, and the test still passes', async () => {
  const h = harness({
    script: {
      create_fixture: FIXTURE_ROW,
      await_flow: COMPLETED,
      read_back: { ...FIXTURE_ROW, state: cell('3'), operation: cell('refresh') },
      delete_fixture: { ok: true },
    },
  });
  const r = await T.testFlow({ ...h.deps, request: 'Test the Change - Refresh Impacted Services flow.' });
  assert.equal(r.status, 'PASS');
  assert.equal(r.unexpected_effects.length, 1);
  assert.equal(r.unexpected_effects[0].field, 'operation');
  const md = T.renderTest(r);
  assert.match(md, /### Also changed \(not part of what was tested\)/);
  assert.match(md, /They did not decide the result\./);

  /* The other half of the rule: a field the before-state never carried cannot
   * be reported as having changed, because nothing observed it changing. */
  const partial = T.unexpectedEffects({
    created: { value: { state: cell('1') }, source: {} },
    after: { value: { state: cell('1'), appeared_from_nowhere: cell('x') }, source: {} },
    promised: [], derived: [],
  });
  assert.deepEqual(partial, []);
});
