/**
 * SESSION 1 / WI-4 — POLICY AT THE TOOL AND ROUTE LAYER.
 *
 *   node --test server/test/
 *
 * THE TWO ATTEMPTS THIS CLOSES, both measured 2026-09-08 against the real
 * model:
 *
 *   1. In the chat loop the model called
 *        update_record sys_hub_flow { active: true }
 *      — a raw REST write to a Flow Designer header. Nothing but the approval
 *      card stood in its way.
 *   2. With the SDK cache cold, the planner produced a VALID plan whose second
 *      step was `create_record` on `sys_flow`, a table that does not exist.
 *      The validator consults no live schema, so the plan reached the card.
 *
 * THE RULES, and where each one lives:
 *
 *   sys_hub_* is never written over REST     write-guard.flowDesignerTablePolicy
 *     — enforced by the plan validator, by the pre-card gate check, and by the
 *       three record tools' own execute as the last line
 *   a target table must exist in live schema  schema.tableExists
 *     — enforced by the validator when the planner hands it the tables it
 *       resolved (`knownTables`), and by the three record tools' execute
 *   a refusal is a RESULT, not a mutation    `{ ok:false, refused:true, reason }`
 *     — the mutation pipeline already treats `ok:false` as not-attempted, so
 *       nothing reaches the ledger
 *
 * Also asserted here: the Business Rule fallback is gone from the prompt and
 * the routes; the raw `/:sysId/active` route is gone; `POST /flows/live` sits
 * behind the approval gate; `create_application` refuses when the workspace's
 * application already exists and otherwise establishes the ONE deterministic
 * scope rather than a per-request one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-s1pol-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const W = await import('../src/agent/write-guard.js');
const { _setTableExistsForTests } = await import('../src/servicenow/schema.js');
const { toolMap } = await import('../src/agent/tools.js');
const { validatePlan } = await import('../src/agent/plan/validator.js');
const { _setChatTurnForTests } = await import('../src/agent/providers/index.js');
const { runTurn, resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { createSession } = await import('../src/memory/sessions.js');
const { mutationsForTurn } = await import('../src/memory/ledger.js');
const { _setApplicationProbesForTests } = await import('../src/servicenow/app-create.js');

const SRC = new URL('../src/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, SRC), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Any real HTTP call in this file is a failure: refusals must happen before the wire. */
let fetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { fetches += 1; return realFetch(...a); };
test.after(() => { globalThis.fetch = realFetch; _setTableExistsForTests(null); _setApplicationProbesForTests(null); });
test.beforeEach(() => { fetches = 0; _setTableExistsForTests(async (t) => ['incident', 'problem', 'sys_user'].includes(t)); });

const discoverAvailable = (name) => ({
  capability: name, status: 'known', available: true, mechanism: 'rest', mutating: true, verification: 'read_back',
});

const step = (over = {}) => ({
  id: 'step_1', operation: 'write', capability: 'record_update', tool: 'update_record',
  mechanism: null, scope: null, mutating: true,
  target: { table: over.table ?? 'incident', sys_id: 'a'.repeat(32) },
  inputs: { table: over.table ?? 'incident', sys_id: 'a'.repeat(32), data: { active: true } },
  depends_on: [], expected_effects: ['active is set'], verification: { strategy: 'read_back', asserts: ['ok'] },
  ...over,
});

/* ------------------------------------------------------------------ *
 * The pure policy
 * ------------------------------------------------------------------ */

test('every sys_hub_* table is policy_refused; ordinary tables are allowed', () => {
  for (const t of ['sys_hub_flow', 'sys_hub_flow_snapshot', 'sys_hub_sub_flow_instance_v2', 'sys_hub_action_instance_v2', 'SYS_HUB_FLOW ']) {
    const v = W.flowDesignerTablePolicy(t);
    assert.equal(v.allowed, false, t);
    assert.equal(v.reason, 'policy_refused');
    assert.match(v.message, /authored through the SDK mechanism/);
  }
  for (const t of ['incident', 'sys_script', 'sys_hub', 'x_2002152_nwforge_asset', '', null]) {
    assert.equal(W.flowDesignerTablePolicy(t).allowed, true, String(t));
  }
});

/* ------------------------------------------------------------------ *
 * The plan validator
 * ------------------------------------------------------------------ */

test('validator: a record write to sys_hub_* is refused by name, before any card', () => {
  const v = validatePlan({ goal: 'g', steps: [step({ table: 'sys_hub_flow' })] }, { discover: discoverAvailable });
  assert.equal(v.valid, false);
  const p = v.fatal.find((x) => x.code === 'policy_refused');
  assert.ok(p, `expected policy_refused, got ${v.fatal.map((x) => x.code).join(', ')}`);
  assert.equal(p.step, 'step_1');
  assert.match(p.message, /sys_hub_flow/);
});

test('validator: today\'s cold plan — create_record on sys_flow — is refused as unknown_table when the tables are known', () => {
  const plan = {
    goal: 'flow',
    steps: [{
      id: 'step_2', operation: 'create the flow', capability: 'record_create', tool: 'create_record',
      mechanism: null, scope: null, mutating: true, target: { table: 'sys_flow' },
      inputs: { table: 'sys_flow', data: { name: 'Incident Onboarding Flow' } }, depends_on: [],
      expected_effects: ['a flow exists'], verification: { strategy: 'read_back', asserts: ['ok'] },
    }],
  };
  const v = validatePlan(plan, { discover: discoverAvailable, knownTables: new Set(['incident']) });
  assert.equal(v.valid, false);
  const p = v.fatal.find((x) => x.code === 'unknown_table');
  assert.ok(p, `expected unknown_table, got ${v.fatal.map((x) => x.code).join(', ')}`);
  assert.match(p.message, /sys_flow/);
  // Without a resolved table set the validator stays offline and does not guess.
  assert.equal(validatePlan(plan, { discover: discoverAvailable }).fatal.some((x) => x.code === 'unknown_table'), false);
});

/* ------------------------------------------------------------------ *
 * The pre-card gate check
 * ------------------------------------------------------------------ */

test('checkBeforeGate refuses a sys_hub_* descriptor so the card is never shown', () => {
  const v = W.checkBeforeGate({
    sessionId: 's', turnSeq: 1, tool: 'update_record',
    descriptor: { table: 'sys_hub_flow', sys_id: 'b'.repeat(32), operation: 'update', requested: { active: true } },
  });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'policy_refused');
  assert.match(v.message, /create_flow_live|SDK/);
});

/* ------------------------------------------------------------------ *
 * The tools themselves — the last line, offline, no wire
 * ------------------------------------------------------------------ */

test('update_record / create_record / delete_record refuse sys_hub_* as a first-class result, without touching the instance', async () => {
  const cases = [
    ['update_record', { table: 'sys_hub_flow', sys_id: 'c'.repeat(32), data: { active: true } }],
    ['create_record', { table: 'sys_hub_flow', data: { name: 'x' } }],
    ['delete_record', { table: 'sys_hub_flow_snapshot', sys_id: 'c'.repeat(32) }],
  ];
  for (const [name, input] of cases) {
    const r = await toolMap.get(name).execute(input, {});
    assert.equal(r?.ok, false, `${name} did not refuse`);
    assert.equal(r.refused, true);
    assert.equal(r.reason, 'policy_refused');
    assert.equal(r.table, input.table);
  }
  assert.equal(fetches, 0, 'a refusal reached the wire');
});

test('the three record tools refuse a table the live schema does not have', async () => {
  for (const [name, input] of [
    ['create_record', { table: 'sys_flow', data: { name: 'x' } }],
    ['update_record', { table: 'sys_flow', sys_id: 'c'.repeat(32), data: { name: 'x' } }],
    ['delete_record', { table: 'sys_flow', sys_id: 'c'.repeat(32) }],
  ]) {
    const r = await toolMap.get(name).execute(input, {});
    assert.equal(r?.ok, false, `${name} did not refuse`);
    assert.equal(r.reason, 'unknown_table');
    assert.equal(r.refused, true);
  }
  assert.equal(fetches, 0);
});

/* ------------------------------------------------------------------ *
 * Replay: the chat-loop attempt from 2026-09-08
 * ------------------------------------------------------------------ */

test('replay: update_record sys_hub_flow {active:true} is blocked before the card and writes nothing', async () => {
  const sessionId = 's1pol-replay';
  createSession({ id: sessionId });
  /*
   * The scripted model insists twice, as the real one did: the context engine
   * may scope `update_record` out of a turn and offer to widen, and the
   * second completion is the retry after widening. The third is prose.
   */
  let n = 0;
  const call = { id: 'c1', name: 'update_record', input: { table: 'sys_hub_flow', sys_id: 'fb55d0633b9841c5a182730194ad7aa4', data: { active: true } } };
  _setChatTurnForTests(async () => (n++ < 2
    ? { text: '', toolCalls: [{ ...call, id: `c${n}` }], stopReason: 'tool_calls' }
    : { text: 'Understood.', toolCalls: [], stopReason: 'stop' }));
  const frames = [];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  await runTurn(sessionId, 'update the record sys_hub_flow fb55d0633b9841c5a182730194ad7aa4 and set active to true', (e) => {
    frames.push(e);
    if (e.type === 'approval_required') resolveApproval(sessionId, e.approvalId, false, APPROVAL_SOURCES.USER_CLICK, e.nonce);
  }, { signal: ctl.signal });
  clearTimeout(timer);
  assert.equal(frames.some((f) => f.type === 'approval_required'), false, 'a card was shown for a policy-refused write');
  const blocked = frames.find((f) => f.type === 'tool_blocked' || (f.type === 'tool_result' && /policy_refused|Flow Designer artifacts/.test(String(f.output ?? ''))));
  assert.ok(blocked, `no refusal frame: ${frames.map((f) => f.type).join(', ')}`);
  assert.equal(mutationsForTurn(sessionId, 1).length, 0, 'a refusal was counted as a mutation');
  assert.equal(fetches, 0);
});

/* ------------------------------------------------------------------ *
 * The Business Rule fallback is gone
 * ------------------------------------------------------------------ */

test('no prompt text, tool description or route offers a Business Rule as a substitute for a flow', () => {
  const prompts = read('agent/prompts.js');
  assert.doesNotMatch(prompts, /Business Rule fallback/);
  assert.doesNotMatch(prompts, /create_record on sys_script/);
  const tools = strip(read('agent/tools.js'));
  assert.doesNotMatch(tools, /Business Rule fallback/);
  const flowsRoute = strip(read('routes/flows.js'));
  assert.doesNotMatch(flowsRoute, /blueprint-to-rule/);
  assert.doesNotMatch(flowsRoute, /blueprintToBusinessRule/);
  const flowsMod = strip(read('servicenow/flows.js'));
  assert.doesNotMatch(flowsMod, /export async function blueprintToBusinessRule/);
});

test('capability messaging replaces the fallback: unknown / unavailable say what to do next, not what to substitute', () => {
  const prompts = read('agent/prompts.js');
  assert.match(prompts, /flow_authoring_capability/);
  assert.match(prompts, /REQUIRES_MANUAL_ACTION|exact next action|fixes\[\]/);
});

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

test('the raw sys_hub_flow.active route is gone and POST /flows/live sits behind the approval gate', () => {
  const src = strip(read('routes/flows.js'));
  assert.doesNotMatch(src, /'\/:sysId\/active'/);
  assert.doesNotMatch(src, /flows\.setActive/);
  const live = src.indexOf("flowsRouter.post('/live'");
  assert.ok(live > 0);
  const body = src.slice(live, src.indexOf('flowsRouter.', live + 10));
  assert.match(body, /awaitApprovalDecision\(/, '/live must wait at the ONE gate');
  assert.match(body, /type: 'approval_required'/);
  assert.ok(body.indexOf('awaitApprovalDecision(') < body.indexOf("type: 'approval_required'"), 'register before emitting (WI-2)');
  assert.ok(body.indexOf("type: 'approval_required'") < body.indexOf('createLiveFlow('), 'the build must come after the decision');
});

/* ------------------------------------------------------------------ *
 * create_application
 * ------------------------------------------------------------------ */

test('create_application refuses with app_exists when the workspace application is already on the bound instance', async () => {
  let established = 0;
  _setApplicationProbesForTests({
    identity: async () => ({ scope: 'x_2002152_nwforge', name: 'NowForge Flows' }),
    exists: async () => ({ sys_id: '524f2eacef5a42c3a601bd8821725978', name: 'NowForge Flows', scope: 'x_2002152_nwforge' }),
    establish: async () => { established += 1; return { ok: true }; },
  });
  const r = await toolMap.get('create_application').execute({ name: 'Enterprise Laptop Replacement', scope_name: 'x_2002152_lrapp' }, {});
  assert.equal(r?.ok, false);
  assert.equal(r.refused, true);
  assert.equal(r.reason, 'app_exists');
  assert.equal(r.scope, 'x_2002152_nwforge');
  assert.equal(established, 0);
  assert.equal(fetches, 0);
});

test('create_application never mints a per-request scope: absent the app, it establishes the one deterministic scope', async () => {
  let establishedWith = null;
  _setApplicationProbesForTests({
    identity: async () => ({ scope: 'x_2002152_nwforge', name: 'NowForge Flows' }),
    exists: async () => null,
    establish: async (args) => { establishedWith = args; return { ok: true, established: true, scope: 'x_2002152_nwforge', name: 'NowForge Flows' }; },
  });
  const r = await toolMap.get('create_application').execute({ name: 'Fleet Management', scope_name: 'x_2002152_fleet' }, {});
  assert.equal(r.ok, true);
  assert.equal(r.scope, 'x_2002152_nwforge', 'the requested scope must be ignored');
  assert.ok(establishedWith !== null, 'establishApplication was not called');
  assert.equal(fetches, 0);
  // The registered tool no longer advertises a per-request scope.
  const props = Object.keys(toolMap.get('create_application').inputSchema.properties);
  assert.ok(!props.includes('scope_name'), 'a per-request scope_name is still declared');
});
