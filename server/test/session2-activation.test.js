/**
 * SESSION 2 / W1a — THE SANCTIONED ACTIVATION STEP.
 *
 *   node --test server/test/
 *
 * ═══ WHAT WAS MISSING ═══
 *
 * There was no way to publish a flow from this build, and no way to find out
 * that none had been. Measured on dev424910: 33 flows installed, 0 published.
 * The SDK publishes as a post-install task that runs only after its fixed
 * 300-second deployment wait succeeds — which failed on six of our installs,
 * so the task was never reached — and which swallows its own errors at DEBUG
 * when it does run, so a clean `install` is compatible with nothing published.
 *
 * The agent's only reachable route to "make this live" was
 * `update_record sys_hub_flow {active:true}`. The policy refuses it, correctly.
 * Measured 2026-09-09: it tried three times in one turn, because the refusal
 * said what it could not do and there was nothing it could do instead.
 *
 * ═══ WHAT IS ASSERTED HERE ═══
 *
 *   the verdict is the READ-BACK, never what the activation call reported
 *   one attempt, no retry, no fallback to a header write
 *   the refusal now names `activate_flow`, and a repeat says repeating is the problem
 *   the payload is SCOPED to what was asked, never the whole application
 *   the two capabilities stop being two names for one tool
 *
 * Offline: the instance layer is injected. The one thing not asserted here is
 * whether the platform's processor works — that is a live question and it has
 * a live answer in the session report.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-s2act-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const W = await import('../src/agent/write-guard.js');
const { toolMap } = await import('../src/agent/tools.js');
const { CAPABILITIES } = await import('../src/agent/capability-discovery.js');
const { TOOL_CAPABILITIES } = await import('../src/agent/context-capabilities.js');
const { ACTIVATE_FLOWS_PATH } = await import('../src/servicenow/flows.js');
const { validatePlan } = await import('../src/agent/plan/validator.js');
const { verifyMutation, isFailedWrite } = await import('../src/agent/mutation-pipeline.js');

const SRC = new URL('../src/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, SRC), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const FLOW = 'ed79cd5762644e6da2c258a7701b7244';

/* ------------------------------------------------------------------ *
 * The tool exists, is gated, and is classified
 * ------------------------------------------------------------------ */

test('activate_flow is a registered, mutating, classified tool', () => {
  const t = toolMap.get('activate_flow');
  assert.ok(t, 'activate_flow is not in the registry');
  assert.equal(t.mutating, true, 'a publish changes the instance and must pass the gate');
  assert.deepEqual(Object.keys(t.inputSchema.properties), ['name']);
  assert.deepEqual(t.inputSchema.required, ['name']);
  // An unclassified tool is a test failure elsewhere in this suite; assert the
  // classification directly so the reason is readable here.
  assert.ok(TOOL_CAPABILITIES.activate_flow?.includes('flow_authoring'));
});

test('flow_publish and flow_authoring stop being two names for one tool', () => {
  assert.deepEqual(CAPABILITIES.flow_publish.tools, ['activate_flow']);
  assert.deepEqual(CAPABILITIES.flow_authoring.tools, ['create_flow_live']);
  assert.equal(CAPABILITIES.flow_publish.mutating, true);
  assert.equal(CAPABILITIES.flow_publish.verification, 'read_back');
});

test('a plan may author with one capability and publish with the other, carrying the name across', () => {
  const discover = (name) => ({
    capability: name, status: 'known', available: true,
    mechanism: name.startsWith('flow_') && name !== 'flow_read' ? 'sdk' : 'rest',
    mutating: name !== 'flow_read', verification: 'read_back', scope: 'x_2002152_nwforge',
  });
  const plan = {
    goal: 'build and publish',
    steps: [
      {
        id: 'step_1', operation: 'build the subflow', capability: 'flow_authoring', tool: 'create_flow_live',
        mechanism: null, scope: null, mutating: true, target: {},
        inputs: { description: 'a subflow that adds a work note', artifact_type: 'subflow' }, depends_on: [],
        expected_effects: ['a subflow exists on the instance'],
        verification: { strategy: 'read_back', asserts: ['it exists'] },
      },
      {
        id: 'step_2', operation: 'publish it', capability: 'flow_publish', tool: 'activate_flow',
        mechanism: null, scope: null, mutating: true, target: {},
        inputs: { name: { $ref: 'step_1.result.name' } }, depends_on: ['step_1'],
        expected_effects: ['the subflow is published and active'],
        verification: { strategy: 'read_back', asserts: ['published is true'] },
      },
    ],
  };
  const v = validatePlan(plan, { discover });
  assert.equal(v.valid, true, JSON.stringify(v.fatal.map((p) => `${p.code}: ${p.message}`)));
});

/* ------------------------------------------------------------------ *
 * The descriptor, and the verdict
 * ------------------------------------------------------------------ */

test('the write is described as an SDK-mechanism publish, so the REST policy lets it through', () => {
  const t = toolMap.get('activate_flow');
  const pre = t.describeWrite({ name: 'Onboarding Priority Check Flow' }, null);
  assert.equal(pre.table, 'sys_hub_flow');
  assert.equal(pre.mechanism, 'sdk');
  assert.equal(pre.sys_id, undefined, 'nothing is invented before the call runs');
  assert.equal(W.checkBeforeGate({ sessionId: 's-act', turnSeq: 9, tool: 'activate_flow', descriptor: pre }).allowed, true);
});

test('a published result reads back as an applied write', async () => {
  const t = toolMap.get('activate_flow');
  const published = {
    ok: true, name: 'Onboarding Priority Check Flow', sys_id: FLOW, table: 'sys_hub_flow', published: true,
    header: { sys_id: FLOW, name: 'Onboarding Priority Check Flow', active: 'true', status: 'published', latest_snapshot: 's1' },
  };
  const good = await verifyMutation({ descriptor: t.describeWrite({ name: 'x' }, published), result: published, before: null, toolName: 'activate_flow' });
  assert.equal(good.status, 'applied', JSON.stringify(good));
  assert.equal(good.verified, true);
});

test('an activation that left the flow a draft is a FAILED write, not a transform', async () => {
  /*
   * The descriptor's operation is `update`, so the executor takes a
   * `snapshotBefore` — the header as it stood before the publish. This mirrors
   * that exactly. With the before-image, both requested outcomes read back
   * unchanged, which is the E1 signature: the platform accepted the call and
   * the record did not move.
   */
  const t = toolMap.get('activate_flow');
  const draft = {
    ok: false, name: 'Onboarding Priority Check Flow', sys_id: FLOW, table: 'sys_hub_flow', published: false,
    header: { sys_id: FLOW, name: 'Onboarding Priority Check Flow', active: 'false', status: 'draft', latest_snapshot: '' },
  };
  const before = { sys_id: FLOW, name: 'Onboarding Priority Check Flow', active: 'false', status: 'draft', latest_snapshot: '', published: 'false' };
  const bad = await verifyMutation({ descriptor: t.describeWrite({ name: 'x' }, draft), result: draft, before, toolName: 'activate_flow' });
  assert.equal(bad.verified, false);
  assert.equal(isFailedWrite(bad), true, `a draft after activation must be a failed write, got ${bad.status}`);
  assert.deepEqual(bad.dropped.map((d) => d.field).sort(), ['active', 'published'], JSON.stringify(bad));
});

test('without a before-image the verdict is still not a success — it just cannot say no-op', async () => {
  /*
   * `snapshotBefore` swallows a failed read and returns null. That must not
   * turn a failed activation into a clean one. It cannot produce `no-op`
   * (which needs the previous value to compare against), but nothing on this
   * path may claim the write landed: `verified` stays false, both outcomes are
   * reported as differing, and the tool's own result still says ok:false.
   */
  const t = toolMap.get('activate_flow');
  const draft = {
    ok: false, sys_id: FLOW, table: 'sys_hub_flow', published: false,
    header: { sys_id: FLOW, active: 'false', status: 'draft', latest_snapshot: '' },
  };
  const v = await verifyMutation({ descriptor: t.describeWrite({ name: 'x' }, draft), result: draft, before: null, toolName: 'activate_flow' });
  assert.equal(v.verified, false);
  assert.notEqual(v.status, 'applied');
  assert.notEqual(v.status, 'self-verified');
  const named = [...v.dropped, ...v.transformed].map((d) => d.field).sort();
  assert.deepEqual(named, ['active', 'published'], 'both requested outcomes must be reported as not holding');
});

test('an unreadable proof is UNKNOWN: published is not asked of the differ', () => {
  const t = toolMap.get('activate_flow');
  const unknown = { ok: false, sys_id: FLOW, published: null, header: { sys_id: FLOW, active: 'false' } };
  const d = t.describeWrite({ name: 'x' }, unknown);
  assert.equal('published' in d.requested, false);
  assert.equal('published' in d.record, false);
});

/* ------------------------------------------------------------------ *
 * Refusal steering, and no retry
 * ------------------------------------------------------------------ */

test('the sys_hub_* refusal names activate_flow as the step that does work', () => {
  const v = W.flowDesignerTablePolicy('sys_hub_flow');
  assert.equal(v.allowed, false);
  assert.equal(v.next_action, 'activate_flow');
  assert.match(v.message, /activate_flow/);
  assert.match(v.message, /create_flow_live/);
  // And it says why the write would not have worked anyway.
  assert.match(v.message, /nothing to run/);
});

test('a SECOND identical refusal in the same turn says that repeating it is the problem', () => {
  W._reset();
  const descriptor = { table: 'sys_hub_flow', sys_id: 'a'.repeat(32), operation: 'update', requested: { active: 'true' } };
  const args = { sessionId: 's-repeat', turnSeq: 3, tool: 'update_record', descriptor };

  const first = W.checkBeforeGate(args);
  assert.equal(first.allowed, false);
  assert.equal(first.repeat, false);
  assert.doesNotMatch(first.message, /already refused/);

  const second = W.checkBeforeGate(args);
  assert.equal(second.allowed, false);
  assert.equal(second.repeat, true);
  assert.match(second.message, /already refused in this turn/);
  assert.match(second.message, /Do not send this write again/);
  assert.match(second.message, /activate_flow/);
});

test('the repeat memory is TURN-scoped: a new turn starts fresh', () => {
  W._reset();
  const descriptor = { table: 'sys_hub_flow', sys_id: 'b'.repeat(32), operation: 'update', requested: { active: 'true' } };
  W.checkBeforeGate({ sessionId: 's-turn', turnSeq: 1, tool: 'update_record', descriptor });
  assert.equal(W.checkBeforeGate({ sessionId: 's-turn', turnSeq: 1, tool: 'update_record', descriptor }).repeat, true);
  assert.equal(W.checkBeforeGate({ sessionId: 's-turn', turnSeq: 2, tool: 'update_record', descriptor }).repeat, false);
});

test('a different table in the same turn is not a repeat', () => {
  W._reset();
  const base = { sys_id: 'c'.repeat(32), operation: 'update', requested: { active: 'true' } };
  W.checkBeforeGate({ sessionId: 's-diff', turnSeq: 1, tool: 'update_record', descriptor: { ...base, table: 'sys_hub_flow' } });
  const other = W.checkBeforeGate({ sessionId: 's-diff', turnSeq: 1, tool: 'update_record', descriptor: { ...base, table: 'sys_hub_action_instance_v2' } });
  assert.equal(other.repeat, false);
});

/* ------------------------------------------------------------------ *
 * The activation call itself: scoped, bounded, and honest about 422
 * ------------------------------------------------------------------ */

test('the activation payload is SCOPED to what was asked, never the whole application', () => {
  const src = strip(read('servicenow/flows.js'));
  const at = src.indexOf('export async function activateFlows(');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('\nconst BLUEPRINT_SYSTEM', at));
  // It sends the ids it was handed. The SDK's own task sends every key in the
  // project, which is the whole application — that is the hazard this avoids.
  assert.match(body, /flows_\.map\(\(sys_id\) => \(\{ sys_id, active: '', state: '' \}\)\)/);
  assert.doesNotMatch(body, /getRecordIdsByTable|keys\.ts/);
  assert.match(body, /sysparm_transaction_scope/);
  assert.equal(ACTIVATE_FLOWS_PATH, '/api/now/wfa_fluent/activate_flows');
});

test('422 is read as a response, and a missing endpoint is loud rather than silent', () => {
  const src = strip(read('servicenow/flows.js'));
  const at = src.indexOf('export async function activateFlows(');
  const body = src.slice(at, src.indexOf('\nconst BLUEPRINT_SYSTEM', at));
  assert.match(body, /res\.status !== 422/, '422 means every flow failed and carries the reasons; it must not throw');
  assert.match(body, /does not represent any resource/, 'an absent endpoint must be detected');
  assert.match(body, /501/, 'an absent endpoint must FAIL, where the SDK returns silently at debug');
});

test('activation is one attempt: no retry, no second install, no header write', () => {
  const src = strip(read('servicenow/fluent.js'));
  const at = src.indexOf('export async function activateManagedFlow(');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('\nexport async function listManaged', at));
  assert.doesNotMatch(body, /for \(|while \(|retry|attempt\+\+/i, 'the step must not loop');
  assert.doesNotMatch(body, /table\.update|setActive/, 'the step must never fall back to a header write');
  // It must not RUN an install (the word appears in prose and in a query, so
  // the assertion is on the calls, not the string).
  assert.doesNotMatch(body, /runSdk\(|deploy\(|installWorkspace\(|buildWorkspace\(/,
    'the step must not reinstall the application to publish one artifact');
  // The verdict is the read-back.
  assert.match(body, /publishedProof/);
  assert.match(body, /ok: proof\.published === true/);
});

test('terminality is corroborated by the query that proves it, not by sys_upgrade_history', () => {
  const src = strip(read('servicenow/fluent.js'));
  const at = src.indexOf('export async function activateManagedFlow(');
  const body = src.slice(at, src.indexOf('\nexport async function listManaged', at));
  // Measured: every sys_upgrade_history row for this app reads complete,
  // including ones still writing minutes later. It cannot decide anything.
  assert.match(body, /state=current\^source_table=sys_upgrade_history/);
  assert.doesNotMatch(body, /table\.query\('sys_upgrade_history'/);
});

/* ------------------------------------------------------------------ *
 * The install-side hazard this step exists beside
 * ------------------------------------------------------------------ */

test('deploy can skip the SDK\'s app-wide activation, and says it did', () => {
  const src = strip(read('servicenow/fluent.js'));
  assert.match(src, /export async function deploy\(name, emit = \(\) => \{\}, \{ skipFlowActivation = false \} = \{\}\)/,
    'the option must default to false so every existing caller is unchanged');
  assert.match(src, /skipFlowActivation \? \['install', '-d', '--skip-flow-activation'\] : \['install', '-d'\]/);
  assert.match(src, /activationReason = 'skipped_by_request'/, 'a skipped activation must not read as an unexplained absence');
});
