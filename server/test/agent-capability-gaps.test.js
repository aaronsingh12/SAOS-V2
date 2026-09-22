/**
 * The capabilities the agent used to say it did not have — catalogs, custom
 * applications, business rules, notifications, server scripts — exist, are
 * reachable from the requests that ask for them, and refuse a broken spec
 * before anything is written.
 *
 *   node --test server/test/agent-capability-gaps.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({ connection: {} });   // nothing may reach an instance from here

const { TOOLS, toolMap } = await import('../src/agent/tools.js');
const { classifyRequest } = await import('../src/agent/context-selection.js');
const { buildContextProfile } = await import('../src/agent/context-engine.js');
const { businessRuleProblems, ruleScript, WHEN, createBusinessRule } = await import('../src/servicenow/business-rules.js');
const { notificationProblems, createNotification } = await import('../src/servicenow/notifications.js');

const exposed = (goal, prior = []) => buildContextProfile({ goal, tools: TOOLS, priorCapabilities: prior }).tools.map((t) => t.name);

test('every request from the conversation reaches the tool it needed', () => {
  assert.ok(exposed('can you create a catalog in my PDI ?').includes('create_catalog'));
  assert.ok(exposed('can you cretae  a custom app ?').includes('create_custom_application'));
  assert.ok(exposed('create a business rule on incident before insert').includes('create_business_rule'));
  assert.ok(exposed('create an email notification when an incident is assigned').includes('create_notification'));
  assert.ok(exposed('run a background script to count active users').includes('run_server_script'));
});

test('"what can you do" gets the WHOLE registry, even after a narrow turn', () => {
  for (const q of ['ok list all the thing that yiu can perform in this proiject', 'what can you do?', 'what are your capabilities']) {
    assert.equal(classifyRequest(q).reason, 'capability_inventory', q);
    assert.equal(exposed(q, ['catalog']).length, TOOLS.length, `${q} was narrowed by the prior turn`);
  }
});

test('the capability inventory is in every profile and lists the tools the agent once denied', async () => {
  for (const goal of ['create a catalog item', 'show me incident INC0010001', 'add a field to a table']) {
    assert.ok(exposed(goal).includes('list_agent_capabilities'), goal);
  }
  const inv = await toolMap.get('list_agent_capabilities').execute({});
  const names = Object.values(inv.areas).flat().map((t) => t.name);
  for (const n of ['create_catalog', 'create_custom_application', 'create_business_rule', 'create_notification',
    'run_server_script', 'create_sla', 'create_acl', 'dba_create_table', 'dba_add_field', 'delete_record']) {
    assert.ok(names.includes(n), `${n} missing from the inventory`);
  }
  assert.equal(inv.total, TOOLS.length);
});

test('a broken business rule is named field by field and never sent', async () => {
  assert.deepEqual(businessRuleProblems({ name: 'x', table: 'incident', when: 'before', insert: true, script: 'current.x = 1;' }), []);
  assert.match(businessRuleProblems({ name: 'x', table: 'incident', when: 'sometimes', insert: true, script: 'a' }).join(), /"when" must be one of/);
  assert.match(businessRuleProblems({ name: 'x', table: 'incident', when: 'after', script: 'a' }).join(), /at least one operation/);
  assert.match(businessRuleProblems({ name: 'x', table: 'incident', when: 'before', insert: true }).join(), /needs a script/);
  assert.equal(WHEN.async, 'async_always');
  assert.equal(WHEN.display, 'before_display');
  await assert.rejects(() => createBusinessRule({ name: 'x', table: 'incident', when: 'never' }), /refused before anything was written/);
});

test('a bare script body is wrapped in the platform template exactly once', () => {
  const w = ruleScript('current.urgency = 1;');
  assert.match(w, /^\(function executeRule\(current, previous/);
  assert.equal(ruleScript(w), w, 'an already-wrapped script is left alone');
  assert.equal(ruleScript(''), '');
});

test('a notification with no recipient or no trigger is refused before it is sent', async () => {
  const ok = { name: 'n', table: 'incident', on_update: true, recipient_fields: ['assigned_to'], subject: 's' };
  assert.deepEqual(notificationProblems(ok), []);
  assert.match(notificationProblems({ ...ok, recipient_fields: [] }).join(), /at least one recipient/);
  assert.match(notificationProblems({ ...ok, on_update: false }).join(), /choose when it sends/);
  assert.match(notificationProblems({ ...ok, trigger: 'event' }).join(), /needs event_name/);
  assert.match(notificationProblems({ ...ok, recipient_users: ['Beth Anglin'] }).join(), /not a sys_id/);
  await assert.rejects(() => createNotification({ ...ok, subject: '' }), /refused before anything was written/);
});

test('an empty server script is refused without creating a job', async () => {
  const r = await toolMap.get('run_server_script').execute({ script: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
});
