/**
 * JOB 1.1 — list_flows / get_flow over the *_v2 Flow Designer tables.
 *
 *   node --test server/test/job-1-1-flow-read.test.js
 *
 * Offline: a fake client serves rows shaped like the Table API's
 * display='all' answer, with step configuration gzipped + base64 the way the
 * platform stores it. The live checks are in the job report.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { SnowError } from '../src/servicenow/client.js';
import {
  listFlows, resolveFlow, describeFlow, buildStepTree, flattenSteps, decodeValues, parseOrder, RESULT_BUDGET,
} from '../src/servicenow/flow-read.js';

const gz = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64');
const ref = (value, display_value) => ({ value, display_value });
const id = (n) => String(n).padStart(32, '0');

const UC1 = id(1);
const UC2 = id(2);
const OOTB = id(3);
const SNAP_UC2 = id(22);

function headers() {
  const h = (sys_id, name, type, scope, active, status) => ({
    sys_id, name, internal_name: name.toLowerCase().replace(/\W+/g, '_'), type,
    sys_scope: ref(scope === 'global' ? 'global' : id(99), scope === 'global' ? 'Global' : 'NowForge'),
    'sys_scope.scope': scope, active: String(active), status,
    sys_updated_on: '2026-09-20 10:00:00', sys_updated_by: 'admin',
  });
  return [
    h(UC1, 'UC1 Critical Incident Escalation', 'flow', 'x_2196302_nwforge', true, 'published'),
    h(UC2, 'UC2 Notify Duty Manager', 'subflow', 'x_2196302_nwforge', true, 'published'),
    h(OOTB, 'Change - Standard', 'flow', 'global', true, 'published'),
    h(id(4), 'Change - Normal', 'flow', 'global', false, 'draft'),
  ];
}

function uc1Parts() {
  return {
    sys_hub_trigger_instance_v2: [{
      flow: UC1, sys_id: id(10), trigger_type: ref('record_create', 'Created'), trigger_definition: ref(id(11), 'Record Created'),
      trigger_inputs: gz([
        { name: 'table', value: 'incident', displayValue: 'Incident' },
        { name: 'condition', value: 'priority=1', displayValue: 'Priority is 1 - Critical' },
      ]),
    }],
    sys_hub_flow_logic_instance_v2: [
      { flow: UC1, sys_id: id(20), order: '2', logic_definition: ref(id(21), 'If'), ui_id: 'u-if', parent_ui_id: '',
        values: gz({ inputs: [{ name: 'condition', value: '{{trigger.current.state}}=1', displayValue: 'State is New' }] }) },
      { flow: UC1, sys_id: id(23), order: '4', logic_definition: ref(id(24), 'Else'), ui_id: 'u-else', parent_ui_id: '', values: '' },
    ],
    sys_hub_action_instance_v2: [
      { flow: UC1, sys_id: id(30), order: '1', action_type: ref(id(31), 'Look Up Record'), ui_id: 'u-look', parent_ui_id: '',
        values: gz({ inputs: [{ name: 'table', value: 'sys_user_group', displayValue: 'Group' }] }) },
      { flow: UC1, sys_id: id(32), order: '5', action_type: ref(id(33), 'Update Record'), ui_id: 'u-upd', parent_ui_id: 'u-else',
        values: gz({ inputs: [{ name: 'record', value: '{{trigger.current}}', displayValue: 'Trigger ➛ Incident Record' }] }) },
    ],
    sys_hub_sub_flow_instance_v2: [
      { flow: UC1, sys_id: id(40), order: '3', subflow: ref(SNAP_UC2, 'UC2 Notify Duty Manager'), wait_for_completion: 'true',
        ui_id: 'u-call', parent_ui_id: 'u-if',
        subflow_inputs: gz([{ name: 'incident', value: '{{trigger.current}}', displayValue: 'Trigger ➛ Incident Record' }]) },
    ],
  };
}

function uc2Parts() {
  return {
    sys_hub_flow_input: [
      { model: UC2, sys_id: id(50), element: 'incident', label: 'Incident', internal_type: 'reference', reference: 'incident', mandatory: 'true', order: '1' },
    ],
    sys_hub_flow_output: [
      { model: UC2, sys_id: id(51), element: 'notified', label: 'Notified', internal_type: 'boolean', reference: '', mandatory: 'false', order: '1' },
    ],
    sys_hub_action_instance_v2: [
      { flow: UC2, sys_id: id(52), order: '1', action_type: ref(id(53), 'Send Notification'), ui_id: 'u-n', parent_ui_id: '', values: '' },
    ],
  };
}

function ootbParts() {
  return {
    sys_hub_trigger_instance_v2: [{ flow: OOTB, sys_id: id(60), trigger_type: ref('record_update', 'Updated'), trigger_definition: ref(id(61), 'Record Updated'),
      trigger_inputs: gz([{ name: 'table', value: 'change_request', displayValue: 'Change Request' }]) }],
    sys_hub_flow_logic_instance_v2: [
      { flow: OOTB, sys_id: id(62), order: '1', logic_definition: ref(id(63), 'For Each'), ui_id: 'fe', parent_ui_id: '', values: '' },
      { flow: OOTB, sys_id: id(64), order: '2', logic_definition: ref(id(65), 'If'), ui_id: 'if', parent_ui_id: 'fe', values: '' },
    ],
    sys_hub_action_instance_v2: [
      { flow: OOTB, sys_id: id(66), order: '3', action_type: ref(id(67), 'Create Task'), ui_id: 'a1', parent_ui_id: 'if', values: '' },
      { flow: OOTB, sys_id: id(68), order: '4', action_type: ref(id(69), 'Log'), ui_id: 'a2', parent_ui_id: '', values: '' },
    ],
  };
}

/** Minimal Table-API fake: `=`, `LIKE`, `^`; honours limit/offset; tracks every call. */
function fakeClient(extra = {}, { forbidden = [] } = {}) {
  const tables = { sys_hub_flow: headers() };
  for (const parts of [uc1Parts(), uc2Parts(), ootbParts(), extra]) {
    for (const [t, rows] of Object.entries(parts)) tables[t] = [...(tables[t] ?? []), ...rows];
  }
  const calls = [];
  const cell = (r, f) => { const v = r[f]; return v && typeof v === 'object' ? v.value : v; };
  const match = (r, clause) => {
    let m;
    if ((m = /^([\w.]+)LIKE(.*)$/.exec(clause))) return String(cell(r, m[1]) ?? '').toLowerCase().includes(m[2].toLowerCase());
    if ((m = /^([\w.]+)=(.*)$/.exec(clause))) return String(cell(r, m[1]) ?? '') === m[2];
    throw new Error(`fake cannot evaluate ${clause}`);
  };
  const select = (t, query) => {
    if (forbidden.includes(t)) throw new SnowError(`"admin" may not read ${t} over REST`, 403);
    if (!(t in tables)) return [];
    const clauses = String(query || '').split('^').filter(Boolean);
    return tables[t].filter((r) => clauses.every((c) => match(r, c)))
      .sort((a, b) => String(cell(a, 'name') ?? '').localeCompare(String(cell(b, 'name') ?? '')));
  };
  return {
    calls,
    async query(t, { query, limit = 25, offset = 0 } = {}) {
      calls.push({ op: 'query', t, query });
      return select(t, query).slice(offset, offset + limit);
    },
    async count(t, query) { calls.push({ op: 'count', t, query }); return select(t, query).length; },
    async get() { throw new Error('describe should not need get'); },
  };
}

/* ---------------- pure pieces ---------------- */

test('decodeValues reads gzip+base64, base64 and plain JSON, preferring display values', () => {
  const pairs = [{ name: 'table', value: 'incident', displayValue: 'Incident' }];
  assert.deepEqual(decodeValues(gz(pairs)).inputs, { table: 'Incident' });
  assert.deepEqual(decodeValues(Buffer.from(JSON.stringify(pairs)).toString('base64')).inputs, { table: 'Incident' });
  assert.deepEqual(decodeValues(JSON.stringify({ inputs: pairs, outputsToAssign: [{ name: 'x', value: '1' }] })), { inputs: { table: 'Incident' }, assigns: { x: '1' } });
  assert.equal(decodeValues('not-a-blob!!').undecodable, true);
  assert.deepEqual(decodeValues('').inputs, {});
});

test('parseOrder keeps parallel-branch composite orders sortable', () => {
  assert.deepEqual(parseOrder('13➛14'), { order: 13, sub: 14, raw: '13➛14' });
  assert.equal(parseOrder('7').order, 7);
});

test('buildStepTree merges the three step tables, nests by parent_ui_id and sorts numerically', () => {
  const p = uc1Parts();
  const tree = buildStepTree({ actions: p.sys_hub_action_instance_v2, logic: p.sys_hub_flow_logic_instance_v2, subflowCalls: p.sys_hub_sub_flow_instance_v2 });
  assert.deepEqual(tree.map((s) => [s.step, s.kind, s.name]), [
    ['1', 'action', 'Look Up Record'], ['2', 'flow_logic', 'If'], ['3', 'flow_logic', 'Else'],
  ]);
  assert.deepEqual(tree[1].children.map((s) => [s.step, s.kind, s.name, s.depth]), [['2.1', 'subflow', 'UC2 Notify Duty Manager', 1]]);
  assert.equal(tree[2].children[0].name, 'Update Record');
  // "10" sorts after "9" — the numeric order, not string order.
  const t2 = buildStepTree({ actions: [
    { sys_id: 'a', order: '10', action_type: 'Ten', ui_id: 'a' }, { sys_id: 'b', order: '9', action_type: 'Nine', ui_id: 'b' },
  ] });
  assert.deepEqual(t2.map((s) => s.name), ['Nine', 'Ten']);
});

test('a step whose parent is unknown stays visible at the top level', () => {
  const tree = buildStepTree({ actions: [{ sys_id: 'a', order: '1', action_type: 'Orphan', ui_id: 'a', parent_ui_id: 'gone' }] });
  assert.equal(flattenSteps(tree).length, 1);
});

/* ---------------- flows.list (T1, T2) ---------------- */

test('T1 (offline) list returns flows AND subflows with type and active status', async () => {
  const r = await listFlows(fakeClient(), {});
  assert.equal(r.ok, true);
  const uc1 = r.items.find((f) => f.name.startsWith('UC1'));
  const uc2 = r.items.find((f) => f.name.startsWith('UC2'));
  assert.deepEqual([uc1.type, uc1.active, uc1.status], ['flow', true, 'published']);
  assert.deepEqual([uc2.type, uc2.active], ['subflow', true]);
  assert.equal(uc1.scope, 'x_2196302_nwforge');
  assert.equal(uc1.updated_by, 'admin');
  assert.equal(r.total, 4);
});

test('T2 (offline) scope filter returns only that app\'s flows', async () => {
  const c = fakeClient();
  const r = await listFlows(c, { scope: 'x_2196302_nwforge' });
  assert.deepEqual(r.items.map((f) => f.scope), ['x_2196302_nwforge', 'x_2196302_nwforge']);
  assert.match(c.calls[0].query, /sys_scope\.scope=x_2196302_nwforge/);
});

test('list filters: type, active, name_contains; and paging', async () => {
  const c = fakeClient();
  assert.deepEqual((await listFlows(c, { type: 'subflow' })).items.map((f) => f.name), ['UC2 Notify Duty Manager']);
  assert.deepEqual((await listFlows(c, { active: false })).items.map((f) => f.name), ['Change - Normal']);
  assert.equal((await listFlows(c, { name_contains: 'change' })).items.length, 2);
  const p1 = await listFlows(c, { limit: 3 });
  assert.equal(p1.has_more, true);
  assert.equal(p1.next_offset, 3);
  const p2 = await listFlows(c, { limit: 3, offset: p1.next_offset });
  assert.equal(p2.items.length, 1);
  assert.equal(p2.has_more, false);
});

test('a caret in a filter cannot inject another query clause', async () => {
  const c = fakeClient();
  await listFlows(c, { name_contains: 'x^active=false' });
  assert.equal(c.calls[0].query, 'nameLIKExactive=false');
});

test('list output is compact enough to survive the 8,000-character result cap', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ ...headers()[0], sys_id: id(1000 + i), name: `Flow number ${i} with a fairly long descriptive name` }));
  const c = fakeClient();
  const client = { ...c, query: async (t, o) => (t === 'sys_hub_flow' ? many.slice(o.offset, o.offset + o.limit) : c.query(t, o)) };
  const r = await listFlows(client, {});
  assert.equal(r.items.length, 20);
  assert.ok(JSON.stringify(r, null, 1).length < 8000, `list page is ${JSON.stringify(r, null, 1).length} chars`);
});

/* ---------------- flows.detail (T3, T4, T5, T6) ---------------- */

test('T3 (offline) UC1 detail: trigger decoded and steps in run order', async () => {
  const r = await describeFlow(fakeClient(), { name: 'UC1 Critical Incident Escalation' });
  assert.equal(r.ok, true);
  assert.deepEqual([r.trigger.definition, r.trigger.table, r.trigger.condition], ['Record Created', 'Incident', 'Priority is 1 - Critical']);
  assert.deepEqual(flattenSteps(r.steps).map((s) => `${s.step} ${s.name}`), [
    '1 Look Up Record', '2 If', '2.1 UC2 Notify Duty Manager', '3 Else', '3.1 Update Record',
  ]);
  assert.equal(r.steps[0].inputs.table, 'Group');
  assert.equal(r.steps[1].inputs.condition, 'State is New');
  assert.match(r.summary, /Trigger: Record Created on Incident when Priority is 1 - Critical/);
  assert.match(r.summary, /  2\.1\. Call subflow: UC2 Notify Duty Manager/);
});

test('T4 (offline) UC2 shows inputs/outputs; UC1 shows the call to UC2', async () => {
  const uc2 = await describeFlow(fakeClient(), { name: 'UC2' });
  assert.deepEqual(uc2.inputs, [{ name: 'incident', label: 'Incident', type: 'reference', reference: 'incident', mandatory: true }]);
  assert.deepEqual(uc2.outputs.map((o) => [o.name, o.type, o.mandatory]), [['notified', 'boolean', false]]);
  assert.ok(uc2.notes.some((n) => /Subflows have no trigger/.test(n)));
  const uc1 = await describeFlow(fakeClient(), { sys_id: UC1 });
  const call = flattenSteps(uc1.steps).find((s) => s.kind === 'subflow');
  assert.equal(call.name, 'UC2 Notify Duty Manager');
  assert.equal(call.wait_for_completion, true);
  assert.equal(call.inputs.incident, 'Trigger ➛ Incident Record');
});

test('T5 (offline) nesting: For Each > If > action, then a top-level action', async () => {
  const r = await describeFlow(fakeClient(), { sys_id: OOTB });
  assert.deepEqual(flattenSteps(r.steps).map((s) => [s.step, s.depth, s.name]), [
    ['1', 0, 'For Each'], ['1.1', 1, 'If'], ['1.1.1', 2, 'Create Task'], ['2', 0, 'Log'],
  ]);
});

test('T6 (offline) unknown flow → friendly not_found; several matches → choices', async () => {
  const miss = await describeFlow(fakeClient(), { name: 'No Such Flow' });
  assert.deepEqual([miss.ok, miss.reason], [false, 'not_found']);
  assert.match(miss.message, /no flow or subflow called "No Such Flow"/);
  const missId = await describeFlow(fakeClient(), { sys_id: id(777) });
  assert.equal(missId.reason, 'not_found');
  const many = await describeFlow(fakeClient(), { name: 'Change' });
  assert.equal(many.reason, 'ambiguous');
  assert.deepEqual(many.choices.map((c) => c.name).sort(), ['Change - Normal', 'Change - Standard']);
});

test('resolve prefers an exact name over a partial match', async () => {
  const extra = { sys_hub_flow: [{ ...headers()[0], sys_id: id(5), name: 'UC1 Critical Incident Escalation v2' }] };
  const r = await resolveFlow(fakeClient(extra), { name: 'UC1 Critical Incident Escalation' });
  assert.equal(r.ok, true);
  assert.equal(r.header.sys_id, UC1);
});

test('permission errors are reported, not thrown', async () => {
  const header = await describeFlow(fakeClient({}, { forbidden: ['sys_hub_flow'] }), { name: 'UC1' });
  assert.deepEqual([header.ok, header.reason], [false, 'permission']);
  const part = await describeFlow(fakeClient({}, { forbidden: ['sys_hub_action_instance_v2'] }), { sys_id: UC1 });
  assert.equal(part.ok, true);
  assert.ok(part.notes.some((n) => /Not allowed to read sys_hub_action_instance_v2/.test(n)));
  const list = await listFlows(fakeClient({}, { forbidden: ['sys_hub_flow'] }), {});
  assert.equal(list.reason, 'permission');
});

test('a very large flow is shrunk to fit the result budget and paged, never cut mid-JSON', async () => {
  const BIG = id(8);
  const long = 'x'.repeat(400);
  const extra = {
    sys_hub_flow: [{ ...headers()[0], sys_id: BIG, name: 'Huge Flow' }],
    sys_hub_action_instance_v2: Array.from({ length: 250 }, (_, i) => ({
      flow: BIG, sys_id: id(10000 + i), order: String(i + 1), action_type: ref(id(9), `Action ${i + 1}`), ui_id: `a${i}`, parent_ui_id: '',
      values: gz({ inputs: [{ name: 'a', value: long }, { name: 'b', value: long }] }),
    })),
  };
  const r = await describeFlow(fakeClient(extra), { name: 'Huge Flow' });
  assert.equal(r.ok, true);
  assert.equal(r.step_count, 250);
  assert.ok(JSON.stringify(r, null, 1).length <= RESULT_BUDGET);
  assert.ok(r.next_steps_from > 1);
  const next = await describeFlow(fakeClient(extra), { name: 'Huge Flow' }, { stepsFrom: r.next_steps_from });
  assert.equal(next.steps[0].name, `Action ${r.next_steps_from}`);
  assert.ok(JSON.stringify(next, null, 1).length <= RESULT_BUDGET);
});

/* ---------------- T8 (offline): read-only by construction ---------------- */

test('T8 (offline) list and detail only ever issue reads', async () => {
  const c = fakeClient();
  await listFlows(c, { scope: 'x_2196302_nwforge' });
  await describeFlow(c, { name: 'UC1' });
  await describeFlow(c, { name: 'nope' });
  assert.ok(c.calls.length > 0);
  assert.ok(c.calls.every((x) => x.op === 'query' || x.op === 'count'));
});

/* ---------------- tool registration ---------------- */

test('list_flows and get_flow are registered, read-only, with the new schemas', async () => {
  const { _setSettingsForTests } = await import('../src/config/store.js');
  _setSettingsForTests({ connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'a', password: 'x' }, llm: { provider: 'ollama' } });
  const { toolMap } = await import('../src/agent/tools.js');
  const list = toolMap.get('list_flows');
  const get = toolMap.get('get_flow');
  assert.equal(list.mutating, false);
  assert.equal(get.mutating, false);
  assert.deepEqual(Object.keys(list.inputSchema.properties).sort(), ['active', 'limit', 'name_contains', 'offset', 'scope', 'type']);
  assert.deepEqual(Object.keys(get.inputSchema.properties).sort(), ['name', 'steps_from', 'sys_id']);
  assert.deepEqual(get.inputSchema.required, []);
});
