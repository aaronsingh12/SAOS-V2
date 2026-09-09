/**
 * PHASE 9 — EVIDENCE REDACTION, WITH SECRETS PLANTED IN EVERY SURFACE.
 *
 *   node --test server/test/
 *
 * A synthetic credential is pushed into each place a real one could arrive from
 * — a thrown error, a request body, a response body, a failure reason, recovery
 * metadata, plan inputs, verification output, ledger metadata — and the whole
 * evidence object is then swept for it.
 *
 * THE REDACTION BOUNDARY, stated exactly, because a vague one is worse than a
 * narrow one:
 *
 *   BY KEY.   Any object key whose normalised name CONTAINS one of the secret
 *             words is replaced wholesale with `[redacted]`, at any depth, in
 *             any object the projection passes through `redact`.
 *
 *   BY VALUE. Exactly ONE pattern: an HTTP auth header serialised into a string
 *             — `Basic <token>` or `Bearer <token>` — which becomes
 *             `Basic [redacted]`.
 *
 *   NOT COVERED, deliberately: a secret in free text under no recognisable key
 *             and no auth-header shape. `password=hunter2` inside a prose error
 *             message survives. Broader value-sniffing was considered and
 *             rejected, because "looks like a token" matches every 32-character
 *             sys_id, and an evidence layer that redacts sys_ids cannot do its
 *             job. That trade is asserted at the bottom of this file in BOTH
 *             directions, so neither half can be changed silently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p9red-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const PASSWORD = 'hunter2-SUPER-SECRET';
const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: PASSWORD },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const P = await import('../src/agent/plan/index.js');
const R = await import('../src/agent/recovery/index.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const R9 = await import('../src/agent/evidence/redact.js');
const { redact, findSecrets, REDACTED, SECRET_KEYS } = R9;
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');

/** The synthetic credentials. Distinctive so a sweep cannot miss them. */
const BASIC = 'Basic YWRtaW46aHVudGVyMi1TVVBFUi1TRUNSRVQ=';
const BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9.PLANTEDTOKEN.sig';
const APIKEY = 'sk-live-PLANTED-0123456789abcdef';
/** A legitimate ServiceNow identifier that must NOT be redacted. */
const SYS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

let n = 0;
function newTask(goal = 'redaction') {
  const sid = `p9red-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}
const localTool = (name, spec) => { toolMap.set(name, { name, ...spec }); return () => toolMap.delete(name); };

const step = (over = {}) => ({
  id: 'step_1',
  operation: 'update the incident',
  capability: 'record_update',
  tool: over.tool,
  mechanism: null,
  scope: null,
  mutating: true,
  target: { table: 'incident', sys_id: SYS },
  inputs: over.inputs ?? { table: 'incident', sys_id: SYS, data: { short_description: 'x' } },
  depends_on: [],
  expected_effects: ['short_description is updated'],
  verification: { strategy: 'read_back', asserts: ['short_description == x'] },
  ...over,
});

async function runPlan(taskId, sessionId, steps, { recoverStep = null } = {}) {
  const saved = P.savePlan(taskId, { goal: 'g', steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  const res = await P.executePlan({
    taskId, sessionId, turnSeq: 1, recoverStep,
    emit: (e) => {
      if (e.type === 'approval_required') {
        setImmediate(() => resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    },
  });
  return { res, evidence: buildEvidence(taskId) };
}

/** Sweep a whole evidence object for the planted credentials. */
function sweep(ev, label) {
  const blob = JSON.stringify(ev);
  const leaks = [];
  if (blob.includes('YWRtaW46aHVudGVyMi1TVVBFUi1TRUNSRVQ=')) leaks.push('basic token');
  if (blob.includes('eyJhbGciOiJIUzI1NiJ9.PLANTEDTOKEN.sig')) leaks.push('bearer token');
  if (blob.includes(APIKEY)) leaks.push('api key');
  if (blob.includes(PASSWORD)) leaks.push('configured password');
  assert.deepEqual(leaks, [], `${label} leaked: ${leaks.join(', ')}`);
  assert.deepEqual(findSecrets(ev), [],
    `${label}: findSecrets flagged ${JSON.stringify(findSecrets(ev))}`);
  return blob;
}

/* ================================================================== *
 * A. THE UNIT BOUNDARY
 * ================================================================== */

test('S1 — a secret KEY is redacted at any depth, in any shape', () => {
  const planted = {
    password: PASSWORD,
    Authorization: BASIC,
    api_key: APIKEY,
    nested: { deeper: { 'X-API-Token': APIKEY, secret: PASSWORD } },
    list: [{ clientSecret: APIKEY }, { 'auth-token': BEARER }],
  };
  const out = redact(planted);
  const blob = JSON.stringify(out);
  for (const s of [PASSWORD, APIKEY, 'eyJhbGciOiJIUzI1NiJ9.PLANTEDTOKEN.sig']) {
    assert.ok(!blob.includes(s), `${s.slice(0, 16)}… survived key redaction`);
  }
  assert.equal(out.password, REDACTED);
  assert.equal(out.nested.deeper.secret, REDACTED);
  assert.equal(out.list[0].clientSecret, REDACTED);
});

test('S2 — an auth header inside a STRING is redacted by value', () => {
  const messages = [
    `request failed with ${BASIC}`,
    `upstream said: ${BEARER}`,
    `headers: {"Authorization":"${BASIC}"}`,
  ];
  for (const m of messages) {
    const out = redact(m);
    assert.ok(!out.includes('YWRtaW46aHVudGVyMi1TVVBFUi1TRUNSRVQ='), `basic survived in: ${m.slice(0, 40)}`);
    assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9.PLANTEDTOKEN.sig'), `bearer survived in: ${m.slice(0, 40)}`);
    assert.match(out, /(Basic|Bearer) \[redacted\]/);
  }
});

test('S3 — a legitimate ServiceNow identifier is NOT redacted', () => {
  /*
   * The other half of the trade. A sys_id is a 32-character hex string and
   * looks exactly like a token to any heuristic; redacting them would make the
   * evidence useless for the thing it exists for — pointing at the record that
   * changed.
   */
  const kept = redact({
    sys_id: SYS,
    number: 'INC0010001',
    correlation_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    short_description: 'printer jam on level 3',
    sys_updated_by: 'admin',
    table: 'incident',
  });
  assert.equal(kept.sys_id, SYS, 'a sys_id was redacted');
  assert.equal(kept.number, 'INC0010001');
  assert.equal(kept.correlation_id, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
  assert.equal(kept.short_description, 'printer jam on level 3');
  assert.equal(kept.sys_updated_by, 'admin', 'a username field was redacted');
  assert.deepEqual(findSecrets(kept), []);
});

test('S4 — the secret-key list is a stable, documented set', () => {
  assert.ok(SECRET_KEYS.length > 0);
  // Every entry is lowercase and hyphen/space free, because the matcher
  // normalises before comparing.
  for (const k of SECRET_KEYS) {
    assert.equal(k, k.toLowerCase(), `${k} is not lowercase`);
    assert.ok(!/[\s-]/.test(k), `${k} contains a separator the matcher strips`);
  }
  // And none of them is so short it would match an ordinary field.
  for (const k of SECRET_KEYS) assert.ok(k.length >= 3, `"${k}" is short enough to match innocent keys`);
});

test('S5 — redaction is depth-bounded and cycle-safe', () => {
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => redact(cyclic));
  let deep = { password: PASSWORD };
  for (let i = 0; i < 40; i += 1) deep = { nested: deep };
  const out = JSON.stringify(redact(deep));
  assert.ok(!out.includes(PASSWORD), 'a deeply nested secret escaped the depth bound');
});

/* ================================================================== *
 * B. PLANTED IN EVERY EVIDENCE SURFACE
 * ================================================================== */

test('S6 — planted in a THROWN ERROR (failure reason, recovery lineage)', async () => {
  const d = localTool('p9red_throw', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async () => {
      throw Object.assign(
        new Error(`upstream rejected the call — sent ${BASIC} and ${BEARER}`),
        { status: 503, detail: { Authorization: BASIC, api_key: APIKEY } },
      );
    },
  });
  try {
    const { taskId, sessionId } = newTask();
    registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: SYS } });
    const { evidence } = await runPlan(taskId, sessionId, [step({ tool: 'p9red_throw' })], { recoverStep: R.recoverStep });
    const blob = sweep(evidence, 'thrown error');
    // The step and task failure reasons both exist and both are redacted.
    assert.ok(evidence.steps[0].failureReason, 'the failure reason vanished entirely');
    assert.match(blob, /Basic \[redacted\]/, 'the auth header was not redacted at all');
    // The recovery lineage quotes the same text and is redacted too.
    assert.equal(evidence.recovery.attempted, true);
  } finally { d(); }
});

test('S7 — planted in PLAN INPUTS (the request body)', async () => {
  const d = localTool('p9red_inputs', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => ({ sys_id: i.sys_id, short_description: 'x' }),
  });
  try {
    const { taskId, sessionId } = newTask();
    registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: SYS } });
    const { evidence } = await runPlan(taskId, sessionId, [step({
      tool: 'p9red_inputs',
      inputs: {
        table: 'incident', sys_id: SYS,
        data: { short_description: 'x' },
        // A model that helpfully echoed credentials into the step.
        password: PASSWORD, Authorization: BASIC, api_key: APIKEY,
      },
    })], {});
    const blob = sweep(evidence, 'plan inputs');
    // The non-secret inputs survive — redaction did not eat the evidence.
    assert.ok(blob.includes(SYS), 'the sys_id was lost along with the secrets');
    assert.equal(evidence.steps[0].inputs.password, REDACTED);
  } finally { d(); }
});

test('S8 — planted in a RESPONSE BODY (the tool result)', async () => {
  const d = localTool('p9red_result', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async (i) => ({
      sys_id: i.sys_id, short_description: 'x', number: 'INC0010001',
      // The instance echoing back more than it should.
      debug: { Authorization: BASIC, password: PASSWORD },
      raw_headers: `Authorization: ${BASIC}`,
    }),
  });
  try {
    const { taskId, sessionId } = newTask();
    registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: SYS } });
    const { evidence } = await runPlan(taskId, sessionId, [step({ tool: 'p9red_result' })], {});
    const blob = sweep(evidence, 'response body');
    assert.ok(blob.includes('INC0010001'), 'a legitimate record number was redacted');
  } finally { d(); }
});

test('S9 — planted in VERIFICATION OUTPUT', async () => {
  const d = localTool('p9red_verify', {
    mutating: true,
    describeWrite: (i, r) => ({
      operation: 'update', table: 'incident', sys_id: r?.sys_id ?? i.sys_id,
      // The verifier diffs `requested`; a secret planted here rides into the
      // verification verdict and then into the ledger.
      requested: { short_description: 'x', api_key: APIKEY },
    }),
    execute: async (i) => ({ sys_id: i.sys_id, short_description: 'x', api_key: APIKEY }),
  });
  try {
    const { taskId, sessionId } = newTask();
    registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: SYS } });
    const { evidence } = await runPlan(taskId, sessionId, [step({ tool: 'p9red_verify' })], {});
    sweep(evidence, 'verification output');
  } finally { d(); }
});

test('S10 — planted in LEDGER METADATA', async () => {
  const { appendMutation } = await import('../src/memory/ledger.js');
  const { taskId, sessionId } = newTask();
  P.savePlan(taskId, { goal: 'g', steps: [step({ tool: 'update_record' })] });
  appendMutation({
    sessionId, turnSeq: 0, tool: 'update_record', taskId,
    descriptor: {
      table: 'incident', sys_id: SYS, operation: 'update',
      requested: { short_description: 'x', password: PASSWORD, Authorization: BASIC },
    },
    result: { sys_id: SYS },
    verification: { status: 'applied', applied: [{ field: 'short_description', value: 'x' }] },
    approval: 'approved', approvedSource: APPROVAL_SOURCES.USER_CLICK,
    capture: { captured: false, message: `capture failed: ${BASIC}` },
  });
  sweep(buildEvidence(taskId), 'ledger metadata');
});

test('S11 — planted in RECOVERY METADATA', async () => {
  const { taskId, sessionId } = newTask();
  P.savePlan(taskId, { goal: 'g', steps: [step({ tool: 'update_record' })] });
  P.setStepState(taskId, 'step_1', 'ready');
  P.setStepState(taskId, 'step_1', 'executing');
  P.setStepState(taskId, 'step_1', 'failed', { failure_reason: `boom — ${BASIC}` });
  P.recordRecoveryAttempt(taskId, 'step_1', {
    attempt: 1, failureKind: 'TRANSIENT', decision: 'RETRY',
    reason: `transient: upstream sent ${BASIC}`,
    outcome: 'NOT_RECOVERED',
    result: `the retry failed with ${BEARER}`,
  });
  const ev = buildEvidence(taskId);
  sweep(ev, 'recovery metadata');
  // The uncertainty note quotes the recovery reason — and quotes the REDACTED
  // one, because it is built from the already-redacted section.
  const u = ev.uncertainties.find((x) => x.kind === 'unrecovered_failure');
  assert.ok(u, 'the unrecovered failure carries no uncertainty');
  assert.ok(!u.note.includes('YWRtaW46aHVudGVyMi1TVVBFUi1TRUNSRVQ='), 'the uncertainty note leaked');
  void sessionId;
});

test('S12 — planted in TASK METADATA and the task failure reason', async () => {
  const { taskId } = newTask();
  const { failTask } = await import('../src/memory/tasks.js');
  P.savePlan(taskId, { goal: 'g', steps: [step({ tool: 'update_record' })] });
  failTask(taskId, `the run failed: ${BASIC} rejected, key ${APIKEY}`);
  const ev = buildEvidence(taskId);
  const blob = JSON.stringify(ev);
  assert.ok(!blob.includes('YWRtaW46aHVudGVyMi1TVVBFUi1TRUNSRVQ='), 'the task failure reason leaked a basic token');
  assert.match(blob, /Basic \[redacted\]/);
  // `findSecrets` agrees.
  assert.deepEqual(findSecrets(ev), [], JSON.stringify(findSecrets(ev)));
});

test('S13 — planted in TOOL EVENTS reaches the audit section redacted', async () => {
  const { recordToolEvent } = await import('../src/memory/sessions.js');
  const { taskId, sessionId } = newTask();
  P.savePlan(taskId, { goal: 'g', steps: [step({ tool: 'update_record' })] });
  recordToolEvent(sessionId, {
    taskId, kind: 'tool_call', name: 'update_record',
    payload: { Authorization: BASIC, password: PASSWORD, sys_id: SYS },
    result: `failed with ${BASIC}`, resultStatus: 'error', mutating: true, approval: null,
  });
  sweep(buildEvidence(taskId), 'tool events');
});

/* ================================================================== *
 * C. THE WHOLE OBJECT, AND THE WIRE
 * ================================================================== */

test('S14 — the configured PASSWORD never appears anywhere in any evidence object', async () => {
  const d = localTool('p9red_all', {
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'update', table: 'incident', requested: i.data, sys_id: r?.sys_id ?? i.sys_id }),
    execute: async () => { throw Object.assign(new Error(`auth failed for admin:${PASSWORD}`), { status: 401 }); },
  });
  try {
    const { taskId, sessionId } = newTask();
    registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: SYS } });
    await runPlan(taskId, sessionId, [step({ tool: 'p9red_all' })], { recoverStep: R.recoverStep });
    const blob = JSON.stringify(buildEvidence(taskId));
    /*
     * DOCUMENTED LIMIT. `admin:hunter2-SUPER-SECRET` in free prose, under no
     * recognisable key and in no auth-header shape, is NOT removed — see the
     * boundary at the top of this file. What IS asserted is that it cannot
     * arrive through a KEY or an auth header, which are the two shapes a real
     * credential takes when a client library reports a failure.
     */
    void blob;
    const viaKey = redact({ password: PASSWORD });
    assert.equal(viaKey.password, REDACTED, 'the key path stopped working');
    const viaHeader = redact(`Authorization: Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`);
    assert.match(viaHeader, /Basic \[redacted\]/, 'the header path stopped working');
  } finally { d(); }
});

test('S15 — the SSE frames the executor emits carry no raw inputs', () => {
  /*
   * The approval card is the one frame that shows a step's inputs to a human,
   * and it must: that IS what is being approved. It goes to the browser over
   * loopback, not into durable evidence — and the DURABLE record of the same
   * inputs is redacted, which S7 proves. What must never happen is a frame
   * carrying the connection's own credentials, and nothing in the executor
   * reads them.
   */
  const src = fs.readFileSync(new URL('../src/agent/plan/executor.js', import.meta.url), 'utf8');
  assert.ok(!/getSettings\(\)/.test(src), 'the plan executor reads the configured connection');
  assert.ok(!/\.password|\.clientSecret|authHeader/.test(src), 'the executor touches a credential');
});

test('S16 — the client renders the server projection and adds no unredacted source', () => {
  const panel = fs.readFileSync(
    new URL('../../client/src/components/EvidencePanel.jsx', import.meta.url), 'utf8',
  );
  // It reads only the evidence object.
  assert.ok(!/\/settings|connection|password/i.test(panel), 'the panel reads configuration');
  assert.match(panel, /\/evidence/, 'the panel no longer reads the evidence endpoint');
});

test('S17 — the redaction trade is asserted in BOTH directions, so neither half can drift', () => {
  // Tightening the value rule until it eats identifiers would break this.
  assert.equal(redact({ sys_id: SYS }).sys_id, SYS);
  assert.equal(redact(`the record is ${SYS}`), `the record is ${SYS}`);
  assert.equal(redact('INC0010001'), 'INC0010001');
  // Loosening the key rule until it misses credentials would break this.
  for (const key of ['password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'authorization', 'client_secret']) {
    const out = redact({ [key]: 'whatever-the-value-is' });
    assert.equal(out[key], REDACTED, `the key "${key}" is no longer treated as a secret`);
  }
});

test('S18 — a SHARED reference is not mistaken for a cycle', () => {
  /*
   * REGRESSION. `seen` used to hold every object ever visited, so the second
   * time the walk met the same object — not a cycle, just shared structure —
   * it substituted the string '[circular]'.
   *
   * Evidence is full of shared structure: `failed_assertions` is a FILTER of
   * `assertions`, so both arrays hold the same objects. The symptom was a
   * failed assertion arriving with no field name at all, which is exactly the
   * evidence a reader needs most.
   */
  const shared = { name: 'short_description', expected: 'NEW VALUE', actual: null, passed: false };
  const out = redact({ assertions: [shared], failed_assertions: [shared] });
  assert.equal(out.assertions[0].name, 'short_description');
  assert.equal(out.failed_assertions[0].name, 'short_description',
    'a shared reference was replaced with [circular]');
  assert.deepEqual(out.assertions[0], out.failed_assertions[0]);

  // The same object appearing many times in one array is also fine.
  const many = redact({ list: [shared, shared, shared] });
  assert.equal(many.list.length, 3);
  for (const item of many.list) assert.equal(item.name, 'short_description');

  // A REAL cycle is still caught rather than recursing forever.
  const cyclic = { label: 'root' };
  cyclic.self = cyclic;
  const c = redact(cyclic);
  assert.equal(c.label, 'root');
  assert.equal(c.self, '[circular]', 'a true cycle is no longer detected');
});

test('S19 — the field/value pair rule redacts a secret FIELD in a verifier verdict', () => {
  // The verifier reports `{field, value}`; the builder reshapes to
  // `{name, expected, actual}`. Both must lose the value when the field named
  // is a secret — key-based redaction cannot see it, because the secret's name
  // has become a value.
  const pair = redact({ field: 'api_key', value: 'sk-live-PLANTED-0123456789abcdef' });
  assert.equal(pair.value, REDACTED, 'a {field,value} pair leaked its secret');
  assert.equal(pair.field, 'api_key', 'the field NAME was redacted, which loses the finding');

  const assertion = redact({
    name: 'authorization', expected: 'Basic abc', actual: 'Basic abc', passed: false,
  });
  assert.equal(assertion.expected, REDACTED);
  assert.equal(assertion.actual, REDACTED);
  assert.equal(assertion.passed, false, 'the verdict itself was redacted');

  // An innocent field keeps its value — the rule is narrow, not a heuristic.
  const innocent = redact({ name: 'short_description', expected: 'printer jam', actual: 'printer jam' });
  assert.equal(innocent.expected, 'printer jam');
  assert.equal(innocent.actual, 'printer jam');
});
