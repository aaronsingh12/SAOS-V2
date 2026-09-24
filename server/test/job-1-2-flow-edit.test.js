/**
 * JOB 1.2 — edit_flow / restore_flow, the parts that decide correctness.
 *
 *   node --test server/test/job-1-2-flow-edit.test.js
 *
 * Offline. Parsing uses the ts-morph that ships with @servicenow/sdk in
 * server/fluent-workspace; when that is not installed these tests skip rather
 * than pass. The live checks are in the job report.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'a', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const E = await import('../src/servicenow/flow-edit.js');
let haveTsMorph = true;
try { E.tsMorph(); } catch { haveTsMorph = false; }
const needsTs = { skip: haveTsMorph ? false : 'ts-morph is not installed in server/fluent-workspace' };

const id = (n) => String(n).padStart(32, '0');

const SOURCE = `import { Flow, wfa, action, trigger } from '@servicenow/sdk/automation'

Flow(
    { $id: Now.ID['net_flow'], name: 'NowForge Edit Test', runAs: 'system' },
    wfa.trigger(trigger.record.created, { $id: Now.ID['net_trigger'] }, { table: 'incident', condition: '', run_flow_in: 'background' }),
    (params) => {
        const look = wfa.action(action.core.lookUpRecord, { $id: Now.ID['net_lookup'] }, { table: 'sys_user_group', conditions: 'name=Network' })
        wfa.flowLogic.if({ $id: Now.ID['net_if'], condition: \`\${wfa.dataPill(params.trigger.current.priority, 'string')}=1\` }, () => {
            wfa.action(action.core.log, { $id: Now.ID['net_log_in_if'] }, { log_message: 'p1' })
        })
        wfa.flowLogic.else({ $id: Now.ID['net_else'] }, () => {})
        wfa.action(action.core.log, { $id: Now.ID['net_log'] }, { log_level: 'info', log_message: 'done' })
    }
)
`;
const KEYS = `
                    net_flow: {
                        table: 'sys_hub_flow'
                        id: '${id(1)}'
                    }
                    net_lookup: {
                        table: 'sys_hub_action_instance_v2'
                        id: '${id(2)}'
                    }
                    net_if: {
                        table: 'sys_hub_flow_logic_instance_v2'
                        id: '${id(3)}'
                    }
                    net_log_in_if: {
                        table: 'sys_hub_action_instance_v2'
                        id: '${id(4)}'
                    }
                    net_else: {
                        table: 'sys_hub_flow_logic_instance_v2'
                        id: '${id(5)}'
                    }
                    net_log: {
                        table: 'sys_hub_action_instance_v2'
                        id: '${id(6)}'
                    }
                    net_old: {
                        table: 'sys_hub_action_instance_v2'
                        id: '${id(9)}'
                        deleted: true
                    }
`;
const step = (sys_id, kind, name, parent, index, inputs = {}) => ({ sys_id, kind, name, parent, index, order: index + 1, inputs });
const RAW = {
  flow: id(1),
  trigger: { definition: 'Created', inputs: { table: 'incident' } },
  steps: {
    [id(2)]: step(id(2), 'action', 'Look Up Record', null, 0, { table: 'sys_user_group' }),
    [id(3)]: step(id(3), 'flow_logic', 'If', null, 1, { condition: '{{T.current.priority}}=1' }),
    [id(4)]: step(id(4), 'action', 'Log', id(3), 0, { log_message: 'p1' }),
    [id(5)]: step(id(5), 'flow_logic', 'Else', null, 2),
    [id(6)]: step(id(6), 'action', 'Log', null, 3, { log_level: 'info', log_message: 'done' }),
  },
};
RAW.steps[id(6)].order = 5;
RAW.steps[id(5)].order = 4;

test('keys.ts parses to key ↔ sys_id, and deleted keys never resolve a sys_id', () => {
  const k = E.parseKeys(KEYS);
  assert.equal(k.byKey.get('net_if').id, id(3));
  assert.equal(k.byId.get(id(6)), 'net_log');
  assert.equal(k.byKey.get('net_old').deleted, true);
  assert.equal(k.byId.has(id(9)), false);
});

test('the flow body parses into keyed statements, with nesting', needsTs, () => {
  const p = E.parseFlowSource(SOURCE, 'NowForge Edit Test');
  assert.equal(p.kind, 'flow');
  assert.equal(p.paramsName, 'params');
  assert.equal(p.triggerKey, 'net_trigger');
  assert.deepEqual(p.nodes.map((n) => n.key), ['net_lookup', 'net_if', 'net_else', 'net_log']);
  assert.deepEqual(p.byKey.get('net_if').children.map((n) => n.key), ['net_log_in_if']);
  assert.equal(p.byKey.get('net_lookup').varName, 'look');
  assert.equal(E.parseFlowSource(SOURCE, 'Some Other Flow'), null);
});

test('drift: an instance that matches the source is clean; a step added in Flow Designer is caught', needsTs, () => {
  const p = E.parseFlowSource(SOURCE, 'NowForge Edit Test');
  const keys = E.parseKeys(KEYS);
  assert.deepEqual(E.driftCheck(p, RAW, keys), []);
  const extra = structuredClone(RAW);
  extra.steps[id(7)] = step(id(7), 'action', 'Send Email', null, 4);
  assert.match(E.driftCheck(p, extra, keys).join(' '), /the instance has a step "Send Email"/);
  const moved = structuredClone(RAW);
  moved.steps[id(4)].parent = id(5);
  assert.match(E.driftCheck(p, moved, keys).join(' '), /different block/);
});

test('values render to Fluent: literals, pills, template text, TemplateValue', () => {
  const ctx = {
    params: () => 'params',
    stepOutput: (n) => ({ varName: 'look', sysId: id(2) }),
  };
  assert.deepEqual(E.renderValue('table_name', 'incident', ctx), { code: "'incident'", canon: 'incident' });
  assert.deepEqual(E.renderValue('record', '{{trigger.current}}', ctx), { code: "wfa.dataPill(params.trigger.current, 'reference')", canon: '{{T.current}}' });
  assert.equal(E.renderValue('log_message', 'Hi {{trigger.current.number}}', ctx).code, "`Hi ${wfa.dataPill(params.trigger.current.number, 'string')}`");
  assert.equal(E.renderValue('record', '{{step 1.Record}}', ctx).canon, `{{S:${id(2)}.Record}}`);
  const tv = E.renderValue('values', { state: 2, assigned_to: '{{step 1.Record}}' }, ctx);
  assert.equal(tv.code, "TemplateValue({ state: 2, assigned_to: wfa.dataPill(look.Record, 'reference') })");
  assert.deepEqual(tv.canon, { templateValue: { state: '2', assigned_to: `{{S:${id(2)}.Record}}` } });
  assert.throws(() => E.renderValue('values', { work_notes: 'text {{trigger.current.number}}' }, ctx), /mixed with a data pill/);
  assert.throws(() => E.renderValue('record', '{{nonsense.x}}', ctx), /Unknown data pill/);
  assert.equal(E.renderValue('x', "it's `ok`", ctx).code, "'it\\'s `ok`'");
});

test('actions are checked against the SDK\'s own action list', () => {
  assert.equal(E.actionId('Update Record'), 'updateRecord');
  assert.equal(E.actionId('look up record'), 'lookUpRecord');
  assert.equal(E.actionId('log'), 'log');
  const known = E.coreActions();
  if (known.length) {
    assert.ok(known.includes('updateRecord'));
    const ctx = { params: () => 'params', mintKey: (b) => `k_${b}` };
    assert.throws(() => E.renderStep({ type: 'action', action: 'Teleport Record' }, ctx), /not a built-in action/);
  }
});

test('an If block renders with its nested steps and expectations', () => {
  let n = 0;
  const ctx = { params: () => 'params', mintKey: (b) => `net_${b}_${(n += 1)}`, stepOutput: () => ({ varName: 'look', sysId: id(2) }) };
  const r = E.renderStep({ type: 'if', condition: '{{trigger.current.priority}}=1', steps: [{ type: 'action', action: 'Log', inputs: { log_message: 'x' } }] }, ctx);
  assert.match(r.code, /^wfa\.flowLogic\.if\(\{ \$id: Now\.ID\['net_if_1'\], condition: `\$\{wfa\.dataPill\(params\.trigger\.current\.priority, 'string'\)\}=1` \}, \(\) => \{/);
  assert.match(r.code, /wfa\.action\(action\.core\.log, \{ \$id: Now\.ID\['net_log_2'\] \}/);
  assert.equal(r.expect.children[0].actionId, 'log');
  assert.deepEqual(r.expect.inputs, { condition: '{{T.current.priority}}=1' });
});

test('stored pills are canonical however the step numbers move', () => {
  assert.equal(E.canonPills('{{Created_1.current.number}} / {{802cfab8-0081-4e70-89b2-dac52ddc2f75.Record}}'),
    '{{T.current.number}} / {{S:802cfab800814e7089b2dac52ddc2f75.Record}}');
  assert.ok(E.matchCanon({ templateValue: { state: '2' } }, 'state=2^work_notes=x^EQ'));
  assert.ok(!E.matchCanon({ templateValue: { state: '3' } }, 'state=2^EQ'));
  assert.ok(E.matchCanon('priority=1', 'priority=1^EQ'));
  assert.ok(E.matchCanon(null, undefined));
});

test('the verdict: asked-for changes pass; anything else that changed is a FAIL', () => {
  const keysAfter = E.parseKeys(`${KEYS}
                    net_update_record: {
                        table: 'sys_hub_action_instance_v2'
                        id: '${id(8)}'
                    }`);
  const plan = { expectations: [
    { op: 'add', key: 'net_update_record', parent: null, placement: { after: id(6) },
      expect: { kind: 'action', actionId: 'updateRecord', key: 'net_update_record', inputs: { values: { templateValue: { state: '2' } } }, children: [] } },
    { op: 'update', sysId: id(6), inputs: { log_message: 'changed' } },
  ] };
  const after = structuredClone(RAW);
  after.steps[id(6)].inputs.log_message = 'changed';
  after.steps[id(8)] = { ...step(id(8), 'action', 'Update Record', null, 4, { values: 'state=2^EQ' }), order: 6 };
  const good = E.checkEdit(plan, RAW, after, keysAfter);
  assert.equal(good.ok, true, JSON.stringify(good));

  const sneaky = structuredClone(after);
  sneaky.steps[id(2)].inputs.table = 'sys_user';             // a step nobody asked to change
  const bad = E.checkEdit(plan, RAW, sneaky, keysAfter);
  assert.equal(bad.ok, false);
  assert.match(bad.unexpected.join(' '), /Look Up Record .* input table/);

  const wrongPlace = structuredClone(after);
  wrongPlace.steps[id(8)].index = 0; wrongPlace.steps[id(2)].index = 1;
  assert.equal(E.checkEdit(plan, RAW, wrongPlace, keysAfter).ok, false);

  const notLanded = structuredClone(RAW);
  const missing = E.checkEdit(plan, RAW, notLanded, keysAfter);
  assert.equal(missing.ok, false);
  assert.ok(missing.checks.some((c) => !c.ok && /exists/.test(c.what)));
});

test('diffScope names every change to another flow', () => {
  const b = { f1: { name: 'UC1', active: true, status: 'published', published: true, raw: RAW } };
  assert.deepEqual(E.diffScope(b, structuredClone(b)), []);
  const a = structuredClone(b);
  a.f1.published = false; a.f1.status = 'draft';
  const d = E.diffScope(b, a);
  assert.ok(d.some((x) => /published true → false/.test(x)));
  assert.ok(d.some((x) => /status published → draft/.test(x)));
});

test('edit_flow and restore_flow are gated, previewed, and never auto-retried', async () => {
  const { toolMap } = await import('../src/agent/tools.js');
  const { classifyIdempotency } = await import('../src/agent/recovery/idempotency.js');
  for (const name of ['edit_flow', 'restore_flow']) {
    const t = toolMap.get(name);
    assert.equal(t.mutating, true, `${name} must go through the approval gate`);
    assert.equal(typeof t.previewWrite, 'function', `${name} must preview before approval`);
    const d = t.describeWrite({}, { flow: { sys_id: id(1) }, verdict: 'FAIL' });
    assert.equal(d.mechanism, 'sdk');
    assert.deepEqual([d.requested.verdict, d.record.verdict], ['PASS', 'FAIL']);
    assert.equal(classifyIdempotency({ tool: name, descriptor: d }).idempotency, 'UNKNOWN', `${name} must never be auto-retried`);
  }
});

/* ---------------- measured live on dev366630, added after the first live runs ---------------- */

test('field values: stored values pass, a label becomes its value, anything else is refused', () => {
  const schema = { table: 'incident', fields: [
    { name: 'state', type: 'integer', choices: [{ value: '1', label: 'New' }, { value: '2', label: 'In Progress' }, { value: '6', label: 'Resolved' }] },
    { name: 'work_notes', choices: null },
  ] };
  assert.deepEqual(E.normalizeFieldValues({ state: 2 }, schema), { values: { state: 2 }, notes: [] });
  const byLabel = E.normalizeFieldValues({ state: 'in progress', work_notes: 'x' }, schema);
  assert.deepEqual(byLabel.values, { state: 2, work_notes: 'x' });
  assert.match(byLabel.notes[0], /"in progress" is a label; its stored value 2 is used/);
  assert.throws(() => E.normalizeFieldValues({ state: 'Sort of done' }, schema), /not a valid incident\.state\. Valid: 1 = New, 2 = In Progress/);
  assert.throws(() => E.normalizeFieldValues({ no_such_field: 1 }, schema), /incident has no field "no_such_field"/);
  assert.deepEqual(E.normalizeFieldValues({ state: '{{trigger.current.state}}' }, schema).values, { state: '{{trigger.current.state}}' });
});

test('removing the only reader of a step output unwraps its const (the build enforces TS6133)', needsTs, () => {
  const before = SOURCE.replace("wfa.action(action.core.log, { $id: Now.ID['net_log'] }, { log_level: 'info', log_message: 'done' })",
    "wfa.action(action.core.log, { $id: Now.ID['net_log'] }, { log_level: 'info', log_message: `${wfa.dataPill(look.Record, 'reference')}` })");
  assert.match(before, /look\.Record/);
  const p = E.parseFlowSource(before, 'NowForge Edit Test');
  p.byKey.get('net_log').stmt.remove();
  const after = E.unwrapUnreadConsts(p.sf.getFullText(), before, 'NowForge Edit Test');
  assert.doesNotMatch(after, /const look =/);
  assert.match(after, /\n\s*wfa\.action\(action\.core\.lookUpRecord, \{ \$id: Now\.ID\['net_lookup'\] \}/);
  /* a const that was never read stays exactly as it was */
  assert.equal(E.unwrapUnreadConsts(SOURCE, SOURCE, 'NowForge Edit Test'), SOURCE);
});

test('"add a step to <flow name>" reaches the flow tools even when it never says "flow"', async () => {
  const { classifyRequest } = await import('../src/agent/context-selection.js');
  const caps = (t) => classifyRequest(t).capabilities ?? [];
  // T11, measured live: this exact sentence matched only `incident`, and the agent said it could not edit flows.
  assert.ok(caps('add a step to NowForge Edit Test that sets the incident state to In Progress').includes('flow_authoring'));
  assert.ok(caps('remove step 3 from NowForge Edit Test').includes('flow_authoring'));
  // ordinary English about steps does not drag the flow tools in
  assert.ok(!caps('what are the next steps for this incident?').includes('flow_authoring'));
});

test('the shapes a model actually sent in T11 are read as what they mean', () => {
  const measured = [{ add_step: { position: { after: '1' }, step: { inputs: { record: '{{Trigger.current}}', table_name: 'incident', values: 'state=2' }, kind: 'action', name: 'Update Record' } } }];
  const [op] = E.normalizeOperations(measured);
  assert.equal(op.op, 'add_step');
  assert.deepEqual(op.position, { after: '1' });
  assert.equal(op.step.type, 'action');
  assert.equal(op.step.action, 'Update Record');
  assert.deepEqual(op.step.inputs.values, { state: '2' });
  assert.equal(E.normalizeOperations([{ operation: 'remove_step', step: '2' }])[0].op, 'remove_step');
  assert.equal(E.normalizeOperations([{ op: 'add_step', step: { kind: 'flow_logic', name: 'If', condition: 'x' } }])[0].step.type, 'if');
  /* a pill value is not mistaken for an encoded query */
  assert.equal(E.normalizeOperations([{ op: 'update_step', step: '1', inputs: { values: '{{step 1.Record}}' } }])[0].inputs.values, '{{step 1.Record}}');
  /* and a string choice value becomes a number on an integer field */
  const schema = { table: 'incident', fields: [{ name: 'state', type: 'integer', choices: [{ value: '2', label: 'In Progress' }] }] };
  assert.deepEqual(E.normalizeFieldValues({ state: '2' }, schema).values, { state: 2 });
});

test('a flow whose snapshot proof is unreadable but whose header is live counts as live (trap #131)', () => {
  assert.equal(E.isLive(true, true, 'published'), true);
  // measured in T11: after an execution the proof read null while the header said active + published
  assert.equal(E.isLive(null, true, 'published'), true);
  assert.equal(E.isLive(null, false, 'draft'), false);
  // a READABLE "not published" is a draft, whatever the header claims
  assert.equal(E.isLive(false, true, 'published'), false);
});
