import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  lintFlowDesign,
  checkCondition,
  parseTriggers,
  parseActions,
  parseSubflowInvocations,
  parseFlowLogic,
  tablesReferenced,
  conditionText,
  blankComments,
  ACTION_CATALOGUE,
  ACTION_OUTPUTS,
} from '../src/servicenow/flow-design.js';

/**
 * FLOW DESIGN — the checks that stand between a model's TypeScript and a flow
 * that installs cleanly and does the wrong thing.
 *
 * Every test here is offline and deterministic: the sources are fixtures and
 * the schema is injected. That is the whole point of the module being pure —
 * the gate it feeds runs before the SDK is spawned, so its behaviour must be
 * provable without an instance.
 *
 * Two properties are asserted throughout, and they matter more than any single
 * rule:
 *   1. a defect is REJECTED with the correction named, and
 *   2. a check that could not be made is SKIPPED, never reported as a pass.
 */

const FLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fluent-workspace/src/fluent/flows');
/* Generated sources that installed and ran, kept as the linter corpus after the
   deployable workspace was pruned (ad719eb). Fixtures, never installed. */
const CORPUS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/flow-corpus');

/** The incident schema as the instance really describes it, trimmed. */
const INCIDENT = {
  table: 'incident',
  fields: [
    { name: 'sys_id', type: 'GUID', choices: null },
    { name: 'number', type: 'string', choices: null },
    { name: 'priority', type: 'integer', choices: [{ value: '1', label: '1 - Critical' }, { value: '2', label: '2 - High' }, { value: '3', label: '3 - Moderate' }] },
    { name: 'state', type: 'integer', choices: [{ value: '1', label: 'New' }, { value: '3', label: 'On Hold' }, { value: '6', label: 'Resolved' }] },
    { name: 'assignment_group', type: 'reference', reference: 'sys_user_group', choices: null },
    { name: 'assigned_to', type: 'reference', reference: 'sys_user', choices: null },
    { name: 'short_description', type: 'string', choices: null },
    { name: 'work_notes', type: 'journal_input', choices: null },
    { name: 'category', type: 'string', choices: [{ value: 'network', label: 'Network' }, { value: 'hardware', label: 'Hardware' }] },
  ],
};

/**
 * A flow fixture.
 *
 * The callback is declared `(params) =>` only when the steps actually read
 * `params` — because that is the rule (§0 rule 9 / TS6133) and the linter
 * enforces it, so a fixture that declared it unconditionally would fail every
 * test for a reason that has nothing to do with what the test is about.
 */
const flow = (body, config = "$id: Now.ID['f'], name: 'F'") => {
  const steps = body.steps ?? "wfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: 'x' })";
  return `
import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'
Flow({ ${config} },
  ${body.trigger ?? "wfa.trigger(trigger.record.created, { $id: Now.ID['t'] }, { table: 'incident' })"},
  ${/\bparams\b/.test(steps) ? '(params)' : '()'} => {
    ${steps}
  }
)
`;
};

const errorsOf = (source, ctx = {}) => lintFlowDesign(source, ctx).errors.join('\n');

/* ------------------------------------------------------------------ *
 * Reading the source
 * ------------------------------------------------------------------ */

test('a call quoted in a comment is not linted as code', () => {
  const src = flow({ steps: "// wfa.action(action.core.deleteMultipleRecords, {}, {})\nwfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: 'x' })" });
  const res = lintFlowDesign(src);
  assert.equal(res.errors.filter((e) => e.includes('deleteMultipleRecords')).length, 0);
});

test("an apostrophe in prose does not run the scanner off the end (it terminates)", () => {
  const src = `// the record's owner\n/* it's fine */\n${flow({})}`;
  const res = lintFlowDesign(src);          // the real assertion is that this returns at all
  assert.equal(typeof res.ok, 'boolean');
  assert.match(blankComments("// it's here\nconst a = 1"), /^\s+\nconst a = 1$/);
});

test('arguments are bracket-matched, not split on every comma', () => {
  const [a] = parseActions("wfa.action(action.core.createRecord, { $id: Now.ID['x'] }, { table_name: 'incident', values: TemplateValue({ a: 1, b: 2 }) })");
  assert.equal(a.name, 'createRecord');
  assert.deepEqual(a.inputs.map((i) => i.key), ['table_name', 'values']);
});

test('a condition template literal is read with its pills marked, not discarded', () => {
  const read = conditionText('`priority=1^assigned_to=${wfa.dataPill(params.trigger.current.caller_id, \'string\')}`');
  assert.equal(read.readable, true);
  assert.equal(read.interpolated, true);
  assert.match(read.text, /^priority=1\^assigned_to=zz_pill_zz$/);
});

test('the tables a source names are reported, so the caller knows which schemas to fetch', () => {
  const src = flow({ steps: "wfa.action(action.core.lookUpRecords, { $id: Now.ID['x'] }, { table: 'sys_user_group' })" });
  assert.deepEqual(tablesReferenced(src).sort(), ['incident', 'sys_user_group']);
});

/* ------------------------------------------------------------------ *
 * Triggers
 * ------------------------------------------------------------------ */

test('a record trigger without a table is rejected', () => {
  const src = flow({ trigger: "wfa.trigger(trigger.record.created, { $id: Now.ID['t'] }, { condition: 'priority=1' })" });
  assert.match(errorsOf(src), /record trigger needs `table`/);
});

test('a trigger form that does not exist is rejected, and the nearest real one is named', () => {
  const src = flow({ trigger: "wfa.trigger(trigger.record.create, { $id: Now.ID['t'] }, { table: 'incident' })" });
  assert.match(errorsOf(src), /trigger\.record\.create` is not a documented record trigger — did you mean `trigger\.record\.created`/);
});

test('run_flow_in and trigger_strategy are checked against their real value sets', () => {
  const src = flow({ trigger: "wfa.trigger(trigger.record.updated, { $id: Now.ID['t'] }, { table: 'incident', run_flow_in: 'sync', trigger_strategy: 'each' })" });
  const errors = errorsOf(src);
  assert.match(errors, /`run_flow_in: 'sync'` is not a value/);
  assert.match(errors, /`trigger_strategy: 'each'` is not a value/);
  assert.match(errors, /`'once'` fires once EVER per record/);
});

test('every scheduled form states what it needs, and the schedule numbers are bounded', () => {
  const daily = flow({ trigger: "wfa.trigger(trigger.scheduled.daily, { $id: Now.ID['t'] }, {})" });
  assert.match(errorsOf(daily), /`trigger\.scheduled\.daily` needs `time`/);

  const weekly = flow({ trigger: "wfa.trigger(trigger.scheduled.weekly, { $id: Now.ID['t'] }, { day_of_week: 9, time: Time({ hours: 1 }, 'UTC') })" });
  assert.match(errorsOf(weekly), /day_of_week: 9` is outside 1…7/);

  const monthly = flow({ trigger: "wfa.trigger(trigger.scheduled.monthly, { $id: Now.ID['t'] }, { day_of_month: 0, time: Time({ hours: 1 }, 'UTC') })" });
  assert.match(errorsOf(monthly), /day_of_month: 0` is outside 1…31/);

  const stringTime = flow({ trigger: "wfa.trigger(trigger.scheduled.daily, { $id: Now.ID['t'] }, { time: '07:00:00' })" });
  assert.match(errorsOf(stringTime), /`time` takes the global `Time\(\.\.\.\)`/);
});

test('a scheduled flow that reads params.trigger.current is rejected — there is no current record', () => {
  const src = flow({
    trigger: "wfa.trigger(trigger.scheduled.daily, { $id: Now.ID['t'] }, { time: Time({ hours: 7 }, 'UTC') })",
    steps: "wfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: `${wfa.dataPill(params.trigger.current.number, 'string')}` })",
  });
  assert.match(errorsOf(src), /scheduled trigger exposes no `params\.trigger\.current`/);
});

/* ------------------------------------------------------------------ *
 * Trigger conditions against the real schema
 * ------------------------------------------------------------------ */

test('a condition on a field the table does not have is rejected, with the nearest real field named', () => {
  const src = flow({ trigger: "wfa.trigger(trigger.record.created, { $id: Now.ID['t'] }, { table: 'incident', condition: 'assigment_group=Network' })" });
  assert.match(errorsOf(src, { schemas: { incident: INCIDENT } }), /filters on `assigment_group`, which is not a field on `incident` — did you mean `assignment_group`\?/);
});

test('a choice compared by LABEL is rejected with the stored value to use instead', () => {
  const src = flow({ trigger: "wfa.trigger(trigger.record.created, { $id: Now.ID['t'] }, { table: 'incident', condition: 'state=On Hold' })" });
  const errors = errorsOf(src, { schemas: { incident: INCIDENT } });
  assert.match(errors, /which is the LABEL\. The stored value is `3` — write `state=3`/);
});

test('a choice value that is neither value nor label is rejected with the real choices listed', () => {
  const src = flow({ trigger: "wfa.trigger(trigger.record.created, { $id: Now.ID['t'] }, { table: 'incident', condition: 'priority=P1' })" });
  assert.match(errorsOf(src, { schemas: { incident: INCIDENT } }), /not one of the choices for `priority` on `incident`: 1=1 - Critical/);
});

test('a dot-walk is checked at its root only, and a real one passes', () => {
  const src = flow({ trigger: "wfa.trigger(trigger.record.created, { $id: Now.ID['t'] }, { table: 'incident', condition: 'assignment_group.name=Network^priority=1' })" });
  assert.equal(lintFlowDesign(src, { schemas: { incident: INCIDENT } }).ok, true);
});

test('an interpolated pill is not mistaken for a field or a value', () => {
  const src = flow({ trigger: "wfa.trigger(trigger.record.created, { $id: Now.ID['t'] }, { table: 'incident', condition: `priority=1^assigned_to=${wfa.dataPill(params.trigger.current.caller_id, 'string')}` })" });
  assert.equal(lintFlowDesign(src, { schemas: { incident: INCIDENT } }).ok, true);
});

test('the change operators parse — `stateCHANGES` is a condition, not a fault', () => {
  const res = checkCondition('stateCHANGES^priority=1', INCIDENT, { table: 'incident' });
  assert.deepEqual(res.errors, []);
  assert.equal(res.checked, true);
});

test('JavaScript in a condition is rejected', () => {
  const res = checkCondition('priority == 1 && active == true', INCIDENT, { table: 'incident' });
  assert.match(res.errors.join('\n'), /contains JavaScript/);
});

test('WITHOUT a schema the fields are not checked and the gate says so — never a silent pass', () => {
  const src = flow({ trigger: "wfa.trigger(trigger.record.created, { $id: Now.ID['t'] }, { table: 'incident', condition: 'nonexistent_field=1' })" });
  const res = lintFlowDesign(src);
  assert.equal(res.ok, true);
  assert.match(res.skipped.join('\n'), /no schema for `incident` was supplied, so the trigger condition's fields were not checked/);

  const checked = checkCondition('nonexistent_field=1', null);
  assert.equal(checked.checked, false, 'a missing schema is "we could not look", not "everything exists"');
});

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

test("`table` where the action wants `table_name` is rejected — the wrong name is accepted and ignored", () => {
  const src = flow({ steps: "wfa.action(action.core.createRecord, { $id: Now.ID['c'] }, { table: 'incident', values: TemplateValue({ short_description: 'x' }) })" });
  assert.match(errorsOf(src), /`action\.core\.createRecord` takes `table_name`, not `table`/);
});

test('each action is held to its OWN values parameter', () => {
  const cases = [
    ['createRecord', "{ table_name: 'incident', field_values: TemplateValue({ a: 1 }) }", /takes `values`, not `field_values`/],
    ['createTask', "{ task_table: 'incident', values: TemplateValue({ a: 1 }) }", /takes `field_values`, not `values`/],
    ['createOrUpdateRecord', "{ table_name: 'incident', values: TemplateValue({ a: 1 }) }", /takes `fields`, not `values`/],
    ['lookUpRecord', "{ table_name: 'incident' }", /takes `table`, not `table_name`/],
  ];
  for (const [name, inputs, expected] of cases) {
    const src = flow({ steps: `wfa.action(action.core.${name}, { $id: Now.ID['a'] }, ${inputs})` });
    assert.match(errorsOf(src), expected, name);
  }
});

test('a missing required parameter is named, with what the call did pass', () => {
  const src = flow({ steps: "wfa.action(action.core.updateRecord, { $id: Now.ID['u'] }, { table_name: 'incident' })" });
  assert.match(errorsOf(src), /`action\.core\.updateRecord` needs `record`, `values`; this call passes `table_name`/);
});

test('deleteMultipleRecords is rejected with the three steps that replace it', () => {
  const src = flow({ steps: "wfa.action(action.core.deleteMultipleRecords, { $id: Now.ID['d'] }, { table_name: 'incident' })" });
  assert.match(errorsOf(src), /does not exist — there is no `deleteMultipleRecords` — use `lookUpRecords` \+ `wfa\.flowLogic\.forEach` \+ `action\.core\.deleteRecord`/);
});

test('a near-miss action name is rejected; an unlisted one is reported unchecked, not condemned', () => {
  const typo = flow({ steps: "wfa.action(action.core.updateRecrd, { $id: Now.ID['a'] }, {})" });
  assert.match(errorsOf(typo), /is not an action — did you mean `action\.core\.updateRecord`\?/);

  const attachment = flow({ steps: "wfa.action(action.core.attachDocument, { $id: Now.ID['a'] }, { source: 'x' })" });
  const res = lintFlowDesign(attachment);
  assert.equal(res.ok, true, 'the catalogue ends with "attachment actions" unnamed, so an unlisted name is not proof of a mistake');
  assert.match(res.skipped.join('\n'), /attachDocument` is not in the documented catalogue/);
});

test('a field written to a table that does not have it is rejected', () => {
  const src = flow({ steps: "wfa.action(action.core.updateRecord, { $id: Now.ID['u'] }, { table_name: 'incident', record: wfa.dataPill(params.trigger.current, 'reference'), values: TemplateValue({ work_note: 'x' }) })" });
  assert.match(errorsOf(src, { schemas: { incident: INCIDENT } }), /writes `work_note`, which is not a field on `incident` — did you mean `work_notes`\?/);
});

test('a values object without TemplateValue is rejected', () => {
  const src = flow({ steps: "wfa.action(action.core.createRecord, { $id: Now.ID['c'] }, { table_name: 'incident', values: { short_description: 'x' } })" });
  assert.match(errorsOf(src), /sets `values` without `TemplateValue\(\{\.\.\.\}\)`/);
});

test('interpolation inside TemplateValue, in ah_body and in an SMS message is rejected', () => {
  const tv = flow({ steps: "wfa.action(action.core.createRecord, { $id: Now.ID['c'] }, { table_name: 'incident', values: TemplateValue({ short_description: `P1 ${wfa.dataPill(params.trigger.current.number, 'string')}` }) })" });
  assert.match(errorsOf(tv), /`short_description` inside `TemplateValue\(\{\.\.\.\}\)` uses a template literal/);

  const body = flow({ steps: "wfa.action(action.core.sendEmail, { $id: Now.ID['m'] }, { ah_to: 'a@b.c', ah_subject: 'x', ah_body: `see ${wfa.dataPill(params.trigger.current.number, 'string')}` })" });
  assert.match(errorsOf(body), /`ah_body` contains interpolation/);

  const sms = flow({ steps: "wfa.action(action.core.sendSms, { $id: Now.ID['s'] }, { message: `hi ${wfa.dataPill(params.trigger.current.number, 'string')}` })" });
  assert.match(errorsOf(sms), /the SMS `message` contains interpolation/);
});

test('ah_subject and log_message DO interpolate — the rule is not applied to them', () => {
  const src = flow({ steps: "wfa.action(action.core.sendEmail, { $id: Now.ID['m'] }, { ah_to: 'a@b.c', ah_subject: `P1 ${wfa.dataPill(params.trigger.current.number, 'string')}`, ah_body: 'plain' })" });
  assert.equal(lintFlowDesign(src).ok, true);
});

test("an action's encoded query is checked against ITS table, not the trigger's", () => {
  const src = flow({ steps: "wfa.action(action.core.lookUpRecords, { $id: Now.ID['x'] }, { table: 'incident', conditions: 'state=Resolved' })" });
  assert.match(errorsOf(src, { schemas: { incident: INCIDENT } }), /`lookUpRecords` conditions compares `state` with `Resolved`, which is the LABEL/);
});

/* ------------------------------------------------------------------ *
 * Output casing — §5 "the most common mistake"
 * ------------------------------------------------------------------ */

test('reading `.record` off lookUpRecord is rejected as the wrong casing', () => {
  const src = flow({ steps: "const g = wfa.action(action.core.lookUpRecord, { $id: Now.ID['x'] }, { table: 'incident' })\nwfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: `${wfa.dataPill(g.record.number, 'string')}` })" });
  assert.match(errorsOf(src), /`g\.record` is the wrong casing: `action\.core\.lookUpRecord` outputs `Record`/);
});

test("reading another action's output is rejected by name", () => {
  const src = flow({ steps: "const g = wfa.action(action.core.lookUpRecord, { $id: Now.ID['x'] }, { table: 'incident' })\nwfa.flowLogic.forEach(wfa.dataPill(g.Records, 'records'), { $id: Now.ID['e'] }, (item) => {})" });
  assert.match(errorsOf(src), /`g\.Records` reads an output of `lookUpRecords`, but `g` is `action\.core\.lookUpRecord`/);
});

test('the documented casing passes, and an undocumented property is left alone', () => {
  const src = flow({ steps: "const g = wfa.action(action.core.lookUpRecord, { $id: Now.ID['x'] }, { table: 'incident' })\nwfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: `${wfa.dataPill(g.Record.number, 'string')} ${wfa.dataPill(g.some_other, 'string')}` })" });
  assert.equal(lintFlowDesign(src).ok, true);
  assert.ok(ACTION_OUTPUTS.lookUpRecord.own.includes('Record'));
});

/* ------------------------------------------------------------------ *
 * Subflow attachment
 * ------------------------------------------------------------------ */

const SUBFLOW_SOURCE = `
export const notifyManager = Subflow({
  $id: Now.ID['nm'], name: 'Notify Manager',
  inputs: {
    taskTable: StringColumn({ label: 'Task Table', mandatory: true }),
    message: StringColumn({ label: 'Message', mandatory: true }),
  },
  outputs: { notified: BooleanColumn({ label: 'Notified' }) },
}, (params) => { wfa.dataPill(params.inputs.taskTable, 'string') })
`;
const CONTRACTS = { notifyManager: { name: 'Notify Manager', inputs: [{ name: 'taskTable', mandatory: true }, { name: 'message', mandatory: true }], outputs: [{ name: 'notified' }] } };

test('an input the subflow does not declare is rejected — it is dropped, so the subflow runs without it', () => {
  const src = flow({ steps: "wfa.subflow(notifyManager, { $id: Now.ID['c'] }, { taskTable: 'incident', message: 'x', taskSysId: '123' })" });
  assert.match(errorsOf(src, { contracts: CONTRACTS }), /`Notify Manager` has no input `taskSysId`/);
});

test('a mandatory input left out is rejected', () => {
  const src = flow({ steps: "wfa.subflow(notifyManager, { $id: Now.ID['c'] }, { taskTable: 'incident' })" });
  assert.match(errorsOf(src, { contracts: CONTRACTS }), /leaves out `message`, which its contract declares mandatory/);
});

test('waitForCompletion in the instance config is rejected — there it does not wait', () => {
  const src = flow({ steps: "wfa.subflow(notifyManager, { $id: Now.ID['c'], waitForCompletion: true }, { taskTable: 'incident', message: 'x' })" });
  assert.match(errorsOf(src, { contracts: CONTRACTS }), /puts `waitForCompletion` in the instance config \(2nd argument\)\. It belongs in the INPUTS object/);
});

test('waitForCompletion inside the inputs object is correct and is not counted as an unknown input', () => {
  const src = flow({ steps: "wfa.subflow(notifyManager, { $id: Now.ID['c'] }, { taskTable: 'incident', message: 'x', waitForCompletion: true })" });
  assert.equal(lintFlowDesign(src, { contracts: CONTRACTS }).ok, true);
});

test('an output the subflow does not declare is rejected', () => {
  const src = flow({ steps: "const r = wfa.subflow(notifyManager, { $id: Now.ID['c'] }, { taskTable: 'incident', message: 'x' })\nwfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: `${wfa.dataPill(r.notifed, 'boolean')}` })" });
  assert.match(errorsOf(src, { contracts: CONTRACTS }), /`r\.notifed` is not an output of `Notify Manager` — did you mean `notified`\?/);
});

test('a subflow declared in the same source is its own contract — no catalogue needed', () => {
  const src = `${SUBFLOW_SOURCE}\n${flow({ steps: "wfa.subflow(notifyManager, { $id: Now.ID['c'] }, { taskTable: 'incident', msg: 'x' })" })}`;
  const errors = errorsOf(src);
  assert.match(errors, /has no input `msg`/);
  assert.match(errors, /leaves out `message`/);
});

test('a call by sys_id is reported unchecked rather than guessed at', () => {
  const src = flow({ steps: "wfa.subflow('7c9d2f1e4b8a4c1d9e0f1a2b3c4d5e6f', { $id: Now.ID['c'] }, { anything: 1 })" });
  const res = lintFlowDesign(src);
  assert.equal(res.ok, true);
  assert.match(res.skipped.join('\n'), /names a sys_id rather than an imported subflow, so its inputs were not checked/);
});

/* ------------------------------------------------------------------ *
 * Flow logic
 * ------------------------------------------------------------------ */

test('else must follow an if in the SAME block', () => {
  const orphan = flow({ steps: "wfa.flowLogic.else({ $id: Now.ID['e'] }, () => {})" });
  assert.match(errorsOf(orphan), /`wfa\.flowLogic\.else` must be a SIBLING call following an `if`/);
});

test('a nested if/else inside an if body is correct and is NOT rejected', () => {
  const src = flow({
    steps: `wfa.flowLogic.if({ $id: Now.ID['a'], condition: 'x=1' }, () => {
      wfa.flowLogic.if({ $id: Now.ID['b'], condition: 'y=1' }, () => {})
      wfa.flowLogic.else({ $id: Now.ID['c'] }, () => {})
    })
    wfa.flowLogic.else({ $id: Now.ID['d'] }, () => {})`,
  });
  assert.equal(lintFlowDesign(src).ok, true, 'the outer else chains to the outer if, not to the inner else');
});

test('doInParallel cannot nest', () => {
  const src = flow({ steps: "wfa.flowLogic.doInParallel({ $id: Now.ID['p'] }, () => { wfa.flowLogic.doInParallel({ $id: Now.ID['q'] }, () => {}) })" });
  assert.match(errorsOf(src), /`wfa\.flowLogic\.doInParallel` cannot be nested/);
});

test('a value captured inside tryCatch and read outside it is rejected', () => {
  const src = flow({
    steps: `wfa.flowLogic.tryCatch({ $id: Now.ID['g'] }, {
      try: () => { const r = wfa.action(action.core.lookUpRecord, { $id: Now.ID['x'] }, { table: 'incident' }) },
      catch: () => {},
    })
    wfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: \`\${wfa.dataPill(r.Record.number, 'string')}\` })`,
  });
  assert.match(errorsOf(src), /`r` is captured inside `tryCatch` and read outside it/);
});

test('flow-logic conditions are encoded queries — JavaScript and arithmetic are rejected', () => {
  const js = flow({ steps: "wfa.flowLogic.if({ $id: Now.ID['a'], condition: 'javascript:gs.daysAgoStart(30)' }, () => {})" });
  assert.match(errorsOf(js), /uses `javascript:` in its condition/);

  const arith = flow({ steps: "wfa.flowLogic.if({ $id: Now.ID['a'], condition: `${wfa.dataPill(params.trigger.current.price, 'currency')}*2<=10` }, () => {})" });
  assert.match(errorsOf(arith), /is not an encoded-query condition/);
});

test('forEach loops over a record set, and a pill typed otherwise is rejected', () => {
  const src = flow({ steps: "const l = wfa.action(action.core.lookUpRecords, { $id: Now.ID['x'] }, { table: 'incident' })\nwfa.flowLogic.forEach(wfa.dataPill(l.Records, 'reference'), { $id: Now.ID['e'] }, (item) => {})" });
  assert.match(errorsOf(src), /its data pill is typed `'records'`, not `'reference'`/);
});

/* ------------------------------------------------------------------ *
 * The non-negotiable rules
 * ------------------------------------------------------------------ */

test('capturing a data pill in a const is rejected; capturing an action result is not', () => {
  const bad = flow({ steps: "const p = wfa.dataPill(params.trigger.current, 'reference')" });
  assert.match(errorsOf(bad), /`const p = wfa\.dataPill\(\.\.\.\)` is not allowed/);

  const good = flow({ steps: "const g = wfa.action(action.core.lookUpRecord, { $id: Now.ID['x'] }, { table: 'incident' })" });
  assert.equal(lintFlowDesign(good).ok, true);
});

test('importing a runtime global is rejected', () => {
  const src = `import { TemplateValue, Time } from '@servicenow/sdk/core'\n${flow({})}`;
  const errors = errorsOf(src);
  assert.match(errors, /`TemplateValue` is a global provided by the SDK runtime/);
  assert.match(errors, /`Time` is a global/);
});

test('an unknown config property and a bad enum value are rejected', () => {
  const src = flow({}, "$id: Now.ID['f'], name: 'F', active: true, runAs: 'admin', flowPriority: 'URGENT'");
  const errors = errorsOf(src);
  assert.match(errors, /`active` is not a flow config property/);
  assert.match(errors, /`runAs: 'admin'` is not a value/);
  assert.match(errors, /`flowPriority: 'URGENT'` is not a value/);
});

test('a body that declares params and never reads it is rejected before the build (TS6133)', () => {
  const src = `
Flow({ $id: Now.ID['f'], name: 'F' },
  wfa.trigger(trigger.scheduled.daily, { $id: Now.ID['t'] }, { time: Time({ hours: 7 }, 'UTC') }),
  (params) => {
    wfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: 'tick' })
  }
)`;
  assert.match(errorsOf(src), /declares `\(params\) =>` and never reads it/);
});

/* ------------------------------------------------------------------ *
 * Against the artifacts this project actually deploys
 * ------------------------------------------------------------------ */

test('the reference flow — a real generated source — passes every check', () => {
  const src = fs.readFileSync(path.join(CORPUS_DIR, 'escalate-network-p1-incident.now.ts'), 'utf8');
  const res = lintFlowDesign(src, { kind: 'flow', schemas: { incident: INCIDENT } });
  assert.deepEqual(res.errors, [], 'a flow that installed, activated and ran must not be rejected by its own linter');
});

test('every managed source parses without the linter throwing or hanging', () => {
  const files = [FLOWS_DIR, CORPUS_DIR].flatMap((dir) => fs.readdirSync(dir)
    .filter((f) => f.endsWith('.now.ts')).map((f) => path.join(dir, f)));
  assert.ok(files.length >= 10, 'the managed sources are the corpus this linter has to survive');
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const res = lintFlowDesign(src, { kind: 'flow' });
    assert.equal(typeof res.ok, 'boolean', f);
    assert.ok(Array.isArray(res.errors), f);
    /* the parsers must agree with the source: a source with a trigger has one */
    if (/wfa\.trigger\s*\(/.test(src)) assert.ok(parseTriggers(src).length >= 1, f);
    if (/wfa\.subflow\s*\(/.test(src)) assert.ok(parseSubflowInvocations(src).length >= 1, f);
    assert.ok(parseFlowLogic(src).every((n) => n.end >= n.index), f);
  }
});

test('the catalogue and the output table agree on which actions exist', () => {
  for (const name of Object.keys(ACTION_OUTPUTS)) {
    assert.ok(ACTION_CATALOGUE[name], `${name} has outputs documented but is not in the catalogue`);
  }
});

test('a subflow that reads params.trigger is rejected — it has no trigger data', () => {
  const src = `
export const helper = Subflow({ $id: Now.ID['h'], name: 'Helper', inputs: { task: StringColumn({ label: 'T' }) } },
  (params) => {
    wfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: \`\${wfa.dataPill(params.trigger.current.number, 'string')}\` })
  }
)`;
  assert.match(errorsOf(src, { kind: 'subflow' }), /A subflow reads `params\.trigger`/);
});

test('a subflow reading params.inputs is correct', () => {
  const src = `
export const helper = Subflow({ $id: Now.ID['h'], name: 'Helper', inputs: { task: StringColumn({ label: 'T' }) } },
  (params) => {
    wfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: \`\${wfa.dataPill(params.inputs.task, 'string')}\` })
  }
)`;
  assert.equal(lintFlowDesign(src, { kind: 'subflow' }).ok, true);
});

/* ------------------------------------------------------------------ *
 * Compiler-certain findings — TypeScript's verdict, not ours
 * ------------------------------------------------------------------ */

test('a body that reads params with a () => callback is compiler-certain (TS2304)', () => {
  const src = `
Flow({ $id: Now.ID['f'], name: 'F' },
  wfa.trigger(trigger.record.created, { $id: Now.ID['t'] }, { table: 'incident' }),
  () => {
    wfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: 'x' + params.trigger.current.number })
  }
)`;
  const res = lintFlowDesign(src);
  assert.equal(res.ok, false);
  assert.equal(res.certain.length, 1);
  assert.match(res.certain[0], /TS2304/);
  assert.ok(res.errors.includes(res.certain[0]), 'a certain finding is also an ordinary error');
});

test('a body that declares params and never reads it is compiler-certain (TS6133)', () => {
  const src = `
Flow({ $id: Now.ID['f'], name: 'F' },
  wfa.trigger(trigger.scheduled.daily, { $id: Now.ID['t'] }, { time: Time({ hours: 7 }, 'UTC') }),
  (params) => {
    wfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: 'tick' })
  }
)`;
  const res = lintFlowDesign(src);
  assert.equal(res.certain.length, 1);
  assert.match(res.certain[0], /TS6133/);
});

test('a correct callback produces no certain findings, in either direction', () => {
  const reads = `
Flow({ $id: Now.ID['f'], name: 'F' },
  wfa.trigger(trigger.record.created, { $id: Now.ID['t'] }, { table: 'incident' }),
  (params) => {
    wfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: 'x' + params.trigger.current.number })
  }
)`;
  const ignores = `
Flow({ $id: Now.ID['f'], name: 'F' },
  wfa.trigger(trigger.record.created, { $id: Now.ID['t'] }, { table: 'incident' }),
  () => {
    wfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: 'x' })
  }
)`;
  assert.deepEqual(lintFlowDesign(reads).certain, []);
  assert.deepEqual(lintFlowDesign(ignores).certain, []);
});

test('our own findings are NOT marked certain — only the compiler\'s are', () => {
  const src = `
Flow({ $id: Now.ID['f'], name: 'F' },
  wfa.trigger(trigger.record.created, { $id: Now.ID['t'] }, { table: 'incident', run_flow_in: 'sync' }),
  () => { wfa.action(action.core.log, { $id: Now.ID['l'] }, { log_message: 'x' }) }
)`;
  const res = lintFlowDesign(src);
  assert.ok(res.errors.some((e) => /run_flow_in/.test(e)), 'the value check still fires');
  assert.deepEqual(res.certain, [], 'a style/semantic finding is ours, and stays advisory-able');
});
