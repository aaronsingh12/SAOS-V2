/**
 * SESSION 1 / WI-6 — `create_flow_live` JOINS THE VERIFICATION AND DATAFLOW CONTRACTS.
 *
 *   node --test server/test/
 *
 * THREE GAPS, all measured 2026-09-08:
 *
 *   no describeWrite     every audit row for create_flow_live read
 *                        self-verified or unverified; the harness never
 *                        compared what was asked for with what the instance
 *                        holds
 *   no outputs           a plan could not `$ref` the flow a step created, so
 *                        "create the subflow, then the flow that calls it"
 *                        was refused at validation
 *   `active` as proof    the read-back reported `active` and nothing else,
 *                        while every one of the 33 flows on dev424910 was a
 *                        draft with an empty `latest_snapshot` — and one of
 *                        them had a PUBLISHED snapshot row under a DRAFT
 *                        header
 *
 * PUBLISHED IS A THREE-WAY AGREEMENT: the header's `latest_snapshot` names a
 * row, that row exists with status `published`, and the header is `active`.
 * Any disagreement is `published: false` with the mismatch named. Pure and
 * offline here; the live read is one function over the same shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-s1flow-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { publishedVerdict, PUBLISH_MISMATCH } = await import('../src/servicenow/flows.js');
const { toolMap } = await import('../src/agent/tools.js');
const { validatePlan } = await import('../src/agent/plan/validator.js');
const { extractOutputs, declaredOutputsOf } = await import('../src/agent/plan/dataflow.js');
const { checkBeforeGate, flowDesignerTablePolicy } = await import('../src/agent/write-guard.js');
const { verifyMutation } = await import('../src/agent/mutation-pipeline.js');

const SNAP = '7d25d58c2f1303503bcc48aa6fa4e38b';
const FLOW = '1d3cd04a40f344e8afdeb4f4e829f3ee';

/* ------------------------------------------------------------------ *
 * Published proof — the three-way agreement
 * ------------------------------------------------------------------ */

test('an OOTB published flow: header names a published snapshot row and is active', () => {
  const v = publishedVerdict({
    header: { sys_id: 'f1', active: 'true', status: 'published', latest_snapshot: 's1' },
    snapshots: [{ sys_id: 's1', parent_flow: 'f1', status: 'published', active: 'true' }],
  });
  assert.equal(v.published, true);
  assert.equal(v.mismatch, null);
  assert.equal(v.snapshot, 's1');
});

test('today\'s Demo Critical Incident Auto-Assign: a published snapshot row under a DRAFT header is NOT published', () => {
  const v = publishedVerdict({
    header: { sys_id: FLOW, active: 'false', status: 'draft', latest_snapshot: '' },
    snapshots: [{ sys_id: SNAP, parent_flow: FLOW, status: 'published', active: 'true' }],
  });
  assert.equal(v.published, false);
  assert.equal(v.mismatch, 'header_draft_with_published_snapshot');
  assert.equal(v.mismatch, PUBLISH_MISMATCH.HEADER_DRAFT_WITH_PUBLISHED_SNAPSHOT);
  assert.match(v.note, /draft/);
});

test('a draft with no snapshot at all is not published, and says so', () => {
  const v = publishedVerdict({ header: { sys_id: 'f', active: 'false', status: 'draft', latest_snapshot: '' }, snapshots: [] });
  assert.equal(v.published, false);
  assert.equal(v.mismatch, 'no_snapshot');
});

test('active alone is never sufficient: active with no snapshot is a mismatch', () => {
  const v = publishedVerdict({ header: { sys_id: 'f', active: 'true', status: 'draft', latest_snapshot: '' }, snapshots: [] });
  assert.equal(v.published, false);
  assert.equal(v.mismatch, 'active_without_snapshot');
});

test('the named row is read by sys_id; a parent-linked list that lacks it is not a mismatch', () => {
  // MEASURED 2026-09-09: "Change - Conflict Detection" names a latest_snapshot
  // that the parent_flow query does not return (an older row is), and that
  // this connection cannot read. The named row decides when it can be read.
  const v = publishedVerdict({
    header: { sys_id: 'f', active: 'true', status: 'published', latest_snapshot: 'new' },
    snapshots: [{ sys_id: 'old', parent_flow: 'f', status: 'published', active: 'true' }],
    named: { sys_id: 'new', parent_flow: 'f', status: 'published', active: 'true' },
  });
  assert.equal(v.published, true);
  assert.equal(v.snapshot, 'new');
});

test('an UNREADABLE named row is published: null — unknown, never false', () => {
  const v = publishedVerdict({
    header: { sys_id: 'f', active: 'true', status: 'published', latest_snapshot: 'hidden' },
    snapshots: [{ sys_id: 'old', parent_flow: 'f', status: 'published', active: 'true' }],
    named: null, namedUnreadable: true,
  });
  assert.equal(v.published, null);
  assert.equal(v.mismatch, 'latest_snapshot_unreadable');
  assert.match(v.note, /UNKNOWN/);
});

test('a header that names a snapshot row which does not exist, or is not published, or is inactive: each named', () => {
  assert.equal(publishedVerdict({
    header: { sys_id: 'f', active: 'true', status: 'published', latest_snapshot: 'gone' }, snapshots: [],
  }).mismatch, 'latest_snapshot_missing_row');
  assert.equal(publishedVerdict({
    header: { sys_id: 'f', active: 'true', status: 'published', latest_snapshot: 's' },
    snapshots: [{ sys_id: 's', parent_flow: 'f', status: 'draft', active: 'false' }],
  }).mismatch, 'snapshot_not_published');
  assert.equal(publishedVerdict({
    header: { sys_id: 'f', active: 'false', status: 'published', latest_snapshot: 's' },
    snapshots: [{ sys_id: 's', parent_flow: 'f', status: 'published', active: 'true' }],
  }).mismatch, 'inactive_with_snapshot');
});

test('display-value cells are read as values, never as labels', () => {
  const v = publishedVerdict({
    header: { sys_id: { value: 'f' }, active: { value: 'true', display_value: 'true' }, status: { value: 'published', display_value: 'Published' }, latest_snapshot: { value: 's', display_value: 'My Flow' } },
    snapshots: [{ sys_id: 's', parent_flow: 'f', status: 'published', active: 'true' }],
  });
  assert.equal(v.published, true);
});

/* ------------------------------------------------------------------ *
 * The tool's contracts
 * ------------------------------------------------------------------ */

const RESULT = {
  ok: true,
  name: 'Onboarding Priority Check Flow',
  artifactType: 'flow',
  verified: {
    sys_id: 'ed79cd5762644e6da2c258a7701b7244', table: 'sys_hub_flow', name: 'Onboarding Priority Check Flow', type: 'flow',
    scope: 'x_2002152_nwforge', scopeId: '524f2eacef5a42c3a601bd8821725978', expectedScopeId: '524f2eacef5a42c3a601bd8821725978',
    active: false, published: false, proof: { published: false, mismatch: 'no_snapshot', snapshot: null },
    header: { sys_id: 'ed79cd5762644e6da2c258a7701b7244', name: 'Onboarding Priority Check Flow', active: 'false', status: 'draft', latest_snapshot: '', sys_scope: '524f2eacef5a42c3a601bd8821725978' },
    subflow_calls: [{ subflow: 'sn1', subflow_name: 'Add Priority Check Work Note' }],
  },
};

test('create_flow_live declares outputs a later step can $ref: sys_id, table, name, scope', () => {
  const declared = declaredOutputsOf('create_flow_live');
  assert.ok(declared, 'no outputs declared');
  assert.equal(declared.sys_id.type, 'sys_id');
  assert.equal(declared.table.type, 'table_name');
  assert.deepEqual(Object.keys(declared).sort(), ['name', 'scope', 'sys_id', 'table']);
  const out = extractOutputs('create_flow_live', RESULT);
  assert.equal(out.sys_id, 'ed79cd5762644e6da2c258a7701b7244');
  assert.equal(out.table, 'sys_hub_flow');
  assert.equal(out.name, 'Onboarding Priority Check Flow');
  assert.equal(out.scope, 'x_2002152_nwforge');
});

test('a plan may reference the flow a create_flow_live step produced', () => {
  const discover = (name) => ({
    capability: name, status: 'known', available: true, mechanism: name === 'flow_authoring' ? 'sdk' : 'rest',
    mutating: name !== 'flow_read', verification: name === 'flow_authoring' ? 'semantic' : 'none', scope: 'x_2002152_nwforge',
  });
  const plan = {
    goal: 'flow then read it',
    steps: [
      {
        id: 'step_1', operation: 'build the subflow', capability: 'flow_authoring', tool: 'create_flow_live',
        mechanism: null, scope: null, mutating: true, target: {},
        inputs: { description: 'a subflow that adds the work note X', artifact_type: 'subflow' }, depends_on: [],
        expected_effects: ['a subflow exists'], verification: { strategy: 'semantic', asserts: ['it exists'] },
      },
      {
        id: 'step_2', operation: 'read it back', capability: 'flow_read', tool: 'get_flow',
        mechanism: null, scope: null, mutating: false, target: { table: { $ref: 'step_1.result.table' }, sys_id: { $ref: 'step_1.result.sys_id' } },
        inputs: { sys_id: { $ref: 'step_1.result.sys_id' } }, depends_on: ['step_1'],
        expected_effects: [], verification: null,
      },
    ],
  };
  const v = validatePlan(plan, { discover });
  assert.equal(v.valid, true, JSON.stringify(v.fatal.map((p) => `${p.code}: ${p.message}`)));
});

test('create_flow_live has a describeWrite aimed at sys_hub_flow through the SDK, and the policy lets the SDK through', () => {
  const tool = toolMap.get('create_flow_live');
  assert.equal(typeof tool.describeWrite, 'function', 'no describeWrite');

  // Before execution (no result yet): enough for the gate, nothing invented.
  const pre = tool.describeWrite({ description: 'x' }, null);
  assert.equal(pre.table, 'sys_hub_flow');
  assert.equal(pre.mechanism, 'sdk');
  assert.equal(pre.operation, 'insert');
  assert.equal(pre.sys_id, undefined);
  assert.equal(checkBeforeGate({ sessionId: 's', turnSeq: 1, tool: 'create_flow_live', descriptor: pre }).allowed, true,
    'the SDK path must not be refused by the REST policy');
  assert.equal(flowDesignerTablePolicy('sys_hub_flow', { mechanism: 'sdk' }).allowed, true);
  assert.equal(flowDesignerTablePolicy('sys_hub_flow', { mechanism: 'rest' }).allowed, false);
  assert.equal(tool.describeWrite({ description: 'x', updates: 'Existing Flow' }, null).operation, 'update');

  // After execution: keyed by the read-back sys_id, asking for scope, active AND published.
  const post = tool.describeWrite({ description: 'x' }, RESULT);
  assert.equal(post.sys_id, 'ed79cd5762644e6da2c258a7701b7244');
  assert.equal(post.requested.sys_scope, '524f2eacef5a42c3a601bd8821725978');
  assert.equal(post.requested.active, 'true');
  assert.equal(post.requested.published, 'true');
  assert.equal(post.requested.name, 'Onboarding Priority Check Flow');
  assert.ok(post.record, 'the read-back header must be handed to the verifier');
  assert.equal(post.record.published, 'false');
});

test('the harness verdict for a draft install is a FAILED write naming published and active, never self-verified', async () => {
  const tool = toolMap.get('create_flow_live');
  const d = tool.describeWrite({ description: 'x' }, RESULT);
  const v = await verifyMutation({ descriptor: d, result: RESULT, before: null, toolName: 'create_flow_live' });
  assert.notEqual(v.status, 'self-verified');
  assert.equal(v.verified, false);
  const dropped = v.dropped.map((x) => x.field).sort();
  assert.deepEqual(dropped, ['active', 'published'], JSON.stringify(v));
  assert.ok(v.applied.some((a) => a.field === 'sys_scope'), 'the scope should read back as applied');
});

test('an unknown proof is not asked of the differ: describeWrite omits published and the result says null', () => {
  const tool = toolMap.get('create_flow_live');
  const unknown = { ...RESULT, verified: { ...RESULT.verified, published: null, proof: { published: null, mismatch: 'latest_snapshot_unreadable', snapshot: null } } };
  const d = tool.describeWrite({ description: 'x' }, unknown);
  assert.equal('published' in d.requested, false);
  assert.equal('published' in d.record, false);
  assert.equal(d.requested.active, 'true');
});

test('the harness verdict for a published install is applied', async () => {
  const tool = toolMap.get('create_flow_live');
  const good = {
    ...RESULT,
    verified: {
      ...RESULT.verified, active: true, published: true,
      proof: { published: true, mismatch: null, snapshot: 's1' },
      header: { ...RESULT.verified.header, active: 'true', status: 'published', latest_snapshot: 's1' },
    },
  };
  const v = await verifyMutation({ descriptor: tool.describeWrite({ description: 'x' }, good), result: good, before: null, toolName: 'create_flow_live' });
  assert.equal(v.status, 'applied', JSON.stringify(v));
  assert.equal(v.verified, true);
});
