/**
 * PHASE 11 — CANONICAL EXECUTION ARGUMENTS.
 *
 *   node --test server/test/
 *
 * THE INVARIANT THIS FILE DEFENDS:
 *
 *     validated plan → canonical arguments → fingerprint → approval → executor
 *                                         ↑
 *                          the SAME object at both ends
 *
 * A human approves an operation by looking at its arguments. If anything
 * reshapes those arguments after the fingerprint, the person authorised one
 * thing and another thing ran. So there is exactly one place that decides what
 * the arguments are, it runs before the fingerprint, and nothing downstream
 * touches them.
 *
 * WHAT WAS WRONG. `target` and `inputs` both described the record a step acts
 * on. The executor read only `inputs`, so a plan that put the table in `target`
 * validated, executed, and called the tool with no table. Three separate places
 * had each invented their own private reconciliation; none of them was the one
 * the executor used.
 *
 * WHY IT IS NOT A FLATTEN. 42 of the 90 registered tools declare no top-level
 * `table` or `sys_id`, and `create_sla` has a property literally named `target`
 * meaning the SLA's completion target. Merging blindly would hand tools
 * arguments they never declared. The rule is schema-driven: a key is lifted
 * only when the tool's own `inputSchema` declares it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p11-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const P = await import('../src/agent/plan/index.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

let n = 0;
function newTask(goal = 'p11') {
  const sid = `p11-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const SYS = 'a1'.repeat(16);
const OTHER = 'b2'.repeat(16);
const seeRecord = (sessionId, sysId = SYS) => registerFromToolResult({
  sessionId, seq: 0, table: 'incident', result: { sys_id: sysId, short_description: 'before' },
});
const localTool = (name, spec) => { toolMap.set(name, { name, ...spec }); return () => toolMap.delete(name); };

/** A probe that declares table + sys_id, like the record tools do. */
const RECORD_SCHEMA = {
  type: 'object',
  properties: {
    table: { type: 'string' }, sys_id: { type: 'string' },
    data: { type: 'object' }, query: { type: 'string' }, limit: { type: 'number' },
  },
  required: ['table'],
};

const step = (over = {}) => ({
  id: over.id ?? 'step_1',
  operation: over.operation ?? 'act on the record',
  capability: over.capability ?? 'record_read',
  tool: over.tool ?? null,
  mechanism: null,
  scope: null,
  mutating: over.mutating ?? false,
  target: 'target' in over ? over.target : { table: 'incident' },
  inputs: 'inputs' in over ? over.inputs : { query: 'active=true', limit: 3 },
  depends_on: [],
  expected_effects: over.expected_effects ?? [],
  verification: 'verification' in over ? over.verification : null,
});

const discover = (name) => ({
  capability: name, status: 'known', available: true, mechanism: 'rest',
  mutating: name !== 'record_read', verification: name === 'record_read' ? 'none' : 'read_back',
  requiresVerification: name !== 'record_read', requiresApproval: name !== 'record_read',
  requiresElevation: false, elevationRole: null, scope: null, reason: null, note: null,
});
const validate = (steps, goal = 'g') => P.validatePlan({ goal, steps }, { discover });

async function runPlan(taskId, sessionId, steps, { decide = true, goal = 'g' } = {}) {
  const saved = P.savePlan(taskId, { goal, steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  const res = await P.executePlan({
    taskId, sessionId, turnSeq: 1,
    emit: (e) => {
      if (e.type === 'approval_required' && decide !== null) {
        setImmediate(() => resolveApproval(sessionId, e.approvalId, decide, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    },
  });
  return { res, saved, plan: P.loadPlan(taskId), evidence: buildEvidence(taskId) };
}

/* ================================================================== *
 * A. CANONICALISATION
 * ================================================================== */

test('C1 — target-only information is lifted into the arguments', () => {
  const drop = localTool('p11_c1', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const { args, lifted, conflicts } = P.canonicalExecutionArgs(step({ tool: 'p11_c1' }));
    assert.deepEqual(args, { query: 'active=true', limit: 3, table: 'incident' });
    assert.deepEqual(lifted, ['table']);
    assert.deepEqual(conflicts, []);
  } finally { drop(); }
});

test('C2 — inputs-only information is left exactly as it is', () => {
  const drop = localTool('p11_c2', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const { args, lifted } = P.canonicalExecutionArgs(step({
      tool: 'p11_c2', target: {}, inputs: { table: 'problem', query: 'x' },
    }));
    assert.deepEqual(args, { table: 'problem', query: 'x' });
    assert.deepEqual(lifted, [], 'something was lifted from an empty target');
  } finally { drop(); }
});

test('C3 — target AND inputs together: each contributes what the other lacks', () => {
  const drop = localTool('p11_c3', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const { args, lifted } = P.canonicalExecutionArgs(step({
      tool: 'p11_c3',
      target: { table: 'incident', sys_id: SYS },
      inputs: { query: 'active=true' },
    }));
    assert.deepEqual(args, { query: 'active=true', table: 'incident', sys_id: SYS });
    assert.deepEqual(lifted.sort(), ['sys_id', 'table']);
  } finally { drop(); }
});

test('C4 — identical duplicates are canonicalised deterministically, not flagged', () => {
  const drop = localTool('p11_c4', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const s = step({
      tool: 'p11_c4',
      target: { table: 'incident', sys_id: SYS },
      inputs: { table: 'incident', sys_id: SYS, query: 'x' },
    });
    const { args, conflicts, lifted } = P.canonicalExecutionArgs(s);
    assert.deepEqual(conflicts, [], 'an identical duplicate was treated as a conflict');
    assert.deepEqual(lifted, [], 'nothing needed lifting');
    assert.deepEqual(args, { table: 'incident', sys_id: SYS, query: 'x' });
    // Deterministic: the same step twice gives the same object.
    assert.deepEqual(P.canonicalExecutionArgs(s).args, args);
  } finally { drop(); }
});

test('C5 — CONFLICTING duplicates are reported and never silently resolved', () => {
  const drop = localTool('p11_c5', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const { args, conflicts } = P.canonicalExecutionArgs(step({
      tool: 'p11_c5',
      target: { table: 'incident', sys_id: SYS },
      inputs: { table: 'problem', sys_id: OTHER },
    }));
    assert.equal(conflicts.length, 2, `expected 2 conflicts, got ${JSON.stringify(conflicts)}`);
    assert.deepEqual(conflicts.map((c) => c.key).sort(), ['sys_id', 'table']);
    // NEITHER value won: the input's value is simply left untouched, and the
    // plan is refused by the validator rather than resolved here.
    assert.equal(args.table, 'problem');
    assert.equal(args.sys_id, OTHER);
  } finally { drop(); }
});

test('C6 — a conflicting plan is REJECTED by the validator', () => {
  const drop = localTool('p11_c6', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const v = validate([step({
      tool: 'p11_c6',
      target: { table: 'incident' },
      inputs: { table: 'problem', query: 'x' },
    })]);
    assert.equal(v.valid, false, 'a plan naming two different tables was accepted');
    const p = v.fatal.find((x) => x.code === 'target_input_conflict');
    assert.ok(p, `expected target_input_conflict, got ${v.fatal.map((x) => x.code).join(', ')}`);
    assert.equal(p.detail.key, 'table');
    assert.equal(p.detail.target, 'incident');
    assert.equal(p.detail.input, 'problem');
    assert.match(p.message, /nothing here can decide which was meant/);
  } finally { drop(); }
});

test('C7 — missing required target information is REJECTED', () => {
  const drop = localTool('p11_c7', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const v = validate([step({ tool: 'p11_c7', target: {}, inputs: { query: 'x' } })]);
    assert.equal(v.valid, false, 'a step with no table anywhere was accepted');
    assert.ok(v.fatal.some((x) => x.code === 'missing_required_inputs'));
  } finally { drop(); }
});

test('C8 — an UNEXPECTED target field is not lifted, and is not an error', () => {
  /*
   * `target` is documented as `{ table, sys_id }`. Anything else in it is
   * descriptive — it belongs to the review card, not to the tool. Lifting it
   * would be inventing an argument; rejecting it would be refusing a plan for
   * carrying extra description.
   */
  const drop = localTool('p11_c8', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const s = step({
      tool: 'p11_c8',
      target: { table: 'incident', number: 'INC0010001', display: 'printer jam', nested: { a: 1 } },
      inputs: { query: 'x' },
    });
    const { args, lifted } = P.canonicalExecutionArgs(s);
    assert.deepEqual(args, { query: 'x', table: 'incident' });
    assert.deepEqual(lifted, ['table']);
    assert.equal(validate([s]).valid, true, 'extra description made the plan invalid');
  } finally { drop(); }
});

test('C9 — a tool that declares NEITHER key receives neither', () => {
  // 42 of 90 tools are in this position, and `create_sla` even has a property
  // called `target` meaning something else entirely.
  const drop = localTool('p11_c9', {
    mutating: false,
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, target: { type: 'string' } } },
    execute: async () => ({}),
  });
  try {
    const { args, lifted } = P.canonicalExecutionArgs(step({
      tool: 'p11_c9',
      target: { table: 'incident', sys_id: SYS },
      inputs: { name: 'four hours', target: 'resolution' },
    }));
    assert.deepEqual(args, { name: 'four hours', target: 'resolution' },
      'an argument the tool never declared was invented');
    assert.deepEqual(lifted, []);
  } finally { drop(); }
});

test('C10 — a step with NO tool is carried through untouched', () => {
  const { args, lifted, conflicts } = P.canonicalExecutionArgs(step({
    tool: null, target: { table: 'incident' }, inputs: { note: 'a decision' },
  }));
  assert.deepEqual(args, { note: 'a decision' });
  assert.deepEqual(lifted, []);
  assert.deepEqual(conflicts, []);
});

test('C11 — canonicalisation is IDEMPOTENT and side-effect free', () => {
  const drop = localTool('p11_c11', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const original = step({ tool: 'p11_c11', target: { table: 'incident', sys_id: SYS }, inputs: { query: 'x' } });
    const snapshot = JSON.stringify(original);
    const once = P.canonicalisePlan({ goal: 'g', steps: [original] });
    const twice = P.canonicalisePlan(once.plan);
    assert.deepEqual(twice.plan, once.plan, 'canonicalising twice changed the plan');
    assert.equal(JSON.stringify(original), snapshot, 'the input step was mutated in place');
    assert.equal(P.isCanonical(once.plan), true);
    assert.equal(P.isCanonical({ goal: 'g', steps: [original] }), false, 'a raw plan reported as canonical');
  } finally { drop(); }
});

test('C12 — canonicalisation reads no live state and calls no model', () => {
  const src = read('agent/plan/canonical.js');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const forbidden of [/fetch\s*\(/, /chatOnce/, /callProvider/, /getDb\s*\(/, /await\s/, /Date\.now/, /Math\.random/]) {
    assert.ok(!forbidden.test(body), `canonical.js contains ${forbidden}`);
  }
  // It reads exactly one thing: the tool registry.
  assert.deepEqual([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]), ['../tools.js']);
});

/* ================================================================== *
 * B. FINGERPRINT BINDING
 * ================================================================== */

test('F1 — canonically equivalent plans have IDENTICAL fingerprints', () => {
  const drop = localTool('p11_f1', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    // The same execution, written the two different ways a model might write it.
    const viaTarget = { goal: 'g', steps: [step({ tool: 'p11_f1', target: { table: 'incident' }, inputs: { query: 'x' } })] };
    const viaInputs = { goal: 'g', steps: [step({ tool: 'p11_f1', target: { table: 'incident' }, inputs: { table: 'incident', query: 'x' } })] };
    const a = P.canonicalisePlan(viaTarget).plan;
    const b = P.canonicalisePlan(viaInputs).plan;
    assert.deepEqual(a.steps[0].inputs, b.steps[0].inputs);
    assert.equal(P.fingerprintPlan(a), P.fingerprintPlan(b),
      'two spellings of the same execution produced different fingerprints');
  } finally { drop(); }
});

test('F2 — a different TABLE produces a different fingerprint', () => {
  const drop = localTool('p11_f2', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const mk = (table) => P.canonicalisePlan({
      goal: 'g', steps: [step({ tool: 'p11_f2', target: { table }, inputs: { query: 'x' } })],
    }).plan;
    assert.notEqual(P.fingerprintPlan(mk('incident')), P.fingerprintPlan(mk('problem')));
  } finally { drop(); }
});

test('F3 — a different QUERY produces a different fingerprint', () => {
  const drop = localTool('p11_f3', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const mk = (query) => P.canonicalisePlan({
      goal: 'g', steps: [step({ tool: 'p11_f3', inputs: { query } })],
    }).plan;
    assert.notEqual(P.fingerprintPlan(mk('active=true')), P.fingerprintPlan(mk('active=false')));
  } finally { drop(); }
});

test('F4 — a different TARGET RECORD produces a different fingerprint', () => {
  const drop = localTool('p11_f4', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const mk = (sysId) => P.canonicalisePlan({
      goal: 'g', steps: [step({ tool: 'p11_f4', target: { table: 'incident', sys_id: sysId }, inputs: {} })],
    }).plan;
    assert.notEqual(P.fingerprintPlan(mk(SYS)), P.fingerprintPlan(mk(OTHER)));
  } finally { drop(); }
});

test('F5 — the fingerprint from generatePlan equals the fingerprint from savePlan', () => {
  /*
   * The two places a fingerprint is computed. If they disagreed, a plan would
   * look stale the instant it was stored — so canonicalisation happens before
   * both, and this proves they agree.
   */
  const drop = localTool('p11_f5', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const raw = { goal: 'g', steps: [step({ tool: 'p11_f5', target: { table: 'incident' }, inputs: { query: 'x' } })] };
    // What the planner would return, post-stamp.
    const stamped = P.stampPlatformFacts(raw, { discovered: { capabilities: {} } });
    const plannerPrint = P.fingerprintPlan(stamped);
    const { taskId } = newTask();
    const saved = P.savePlan(taskId, stamped);
    assert.equal(saved.fingerprint, plannerPrint,
      'the stored fingerprint differs from the one the planner reported');
    // And the stored plan is canonical.
    assert.equal(P.isCanonical(P.loadPlan(taskId)), true);
  } finally { drop(); }
});

test('F6 — changing the canonical arguments AFTER approval is approval_stale', async () => {
  const drop = localTool('p11_f6', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({ ok: true }) });
  try {
    const { taskId } = newTask();
    const saved = P.savePlan(taskId, { goal: 'g', steps: [step({ tool: 'p11_f6', target: { table: 'incident' } })] });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    assert.equal(P.checkApprovalBinding(taskId).ok, true);

    // The same plan, re-saved with a different table. Canonicalisation makes it
    // a different execution, so the fingerprint moves and the approval dies.
    const again = P.savePlan(taskId, { goal: 'g', steps: [step({ tool: 'p11_f6', target: { table: 'problem' } })] });
    assert.notEqual(again.fingerprint, saved.fingerprint);
    const bound = P.checkApprovalBinding(taskId);
    assert.equal(bound.ok, false);
    assert.equal(bound.reason, 'approval_stale');
  } finally { drop(); }
});

test('F7 — moving a value from `target` to `inputs` does NOT invalidate an approval', () => {
  /*
   * The other half of F6, and the reason canonicalisation belongs before the
   * fingerprint. Two spellings of the SAME execution must not read as a change
   * — otherwise a person would be asked to re-approve identical work.
   */
  const drop = localTool('p11_f7', { mutating: false, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const { taskId } = newTask();
    const a = P.savePlan(taskId, {
      goal: 'g', steps: [step({ tool: 'p11_f7', target: { table: 'incident' }, inputs: { query: 'x' } })],
    });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, a.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });

    const b = P.savePlan(taskId, {
      goal: 'g', steps: [step({ tool: 'p11_f7', target: { table: 'incident' }, inputs: { table: 'incident', query: 'x' } })],
    });
    assert.equal(b.fingerprint, a.fingerprint, 're-spelling the same execution invalidated the approval');
    assert.equal(P.checkApprovalBinding(taskId).ok, true);
  } finally { drop(); }
});

/* ================================================================== *
 * C. EXECUTION — the same object at both ends
 * ================================================================== */

test('X1 — the executor receives EXACTLY the canonical arguments that were fingerprinted', async () => {
  let received = null;
  const drop = localTool('p11_x1', {
    mutating: false, inputSchema: RECORD_SCHEMA,
    execute: async (input) => { received = input; return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    const proposed = step({ tool: 'p11_x1', target: { table: 'incident', sys_id: SYS }, inputs: { query: 'active=true' } });
    const expected = P.canonicalExecutionArgs(proposed).args;

    const { res, plan } = await runPlan(taskId, sessionId, [proposed]);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(received, expected, 'the executor received something other than the canonical arguments');
    // The STORED step carries the same object — so what was fingerprinted, what
    // was approved, what was persisted and what ran are one thing.
    assert.deepEqual(plan.steps[0].inputs, expected);
  } finally { drop(); }
});

test('X2 — no target information disappears, and nothing is invented', async () => {
  let received = null;
  const drop = localTool('p11_x2', {
    mutating: false, inputSchema: RECORD_SCHEMA,
    execute: async (input) => { received = input; return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    await runPlan(taskId, sessionId, [step({
      tool: 'p11_x2',
      target: { table: 'incident', sys_id: SYS, number: 'INC0010001' },   // `number` is description
      inputs: { query: 'active=true', limit: 7 },
    })]);
    assert.equal(received.table, 'incident');
    assert.equal(received.sys_id, SYS);
    assert.equal(received.query, 'active=true');
    assert.equal(received.limit, 7);
    assert.ok(!('number' in received), 'a descriptive target field was passed as an argument');
    assert.deepEqual(Object.keys(received).sort(), ['limit', 'query', 'sys_id', 'table']);
  } finally { drop(); }
});

test('X3 — a malformed plan never reaches executeTool', async () => {
  let called = 0;
  const drop = localTool('p11_x3', {
    mutating: false, inputSchema: RECORD_SCHEMA,
    execute: async () => { called += 1; return { ok: true }; },
  });
  try {
    // Conflicting target/inputs: the validator refuses it outright.
    const conflicting = [step({ tool: 'p11_x3', target: { table: 'incident' }, inputs: { table: 'problem' } })];
    assert.equal(validate(conflicting).valid, false);
    // Missing everything: also refused.
    assert.equal(validate([step({ tool: 'p11_x3', target: {}, inputs: {} })]).valid, false);
    assert.equal(called, 0, 'validation executed a tool');
  } finally { drop(); }
});

test('X4 — the executor performs NO post-approval normalisation', () => {
  const src = read('agent/plan/executor.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // One argument source, and it is the stored canonical object.
  assert.match(src, /executeTool\(tool, step\.inputs \|\| \{\}/);
  // Nothing merges, spreads or reshapes arguments in the executor.
  assert.ok(!/canonicalExecutionArgs|canonicalisePlan/.test(src),
    'the executor canonicalises after approval, which is a second normalisation');
  assert.ok(!/\{\s*\.\.\.step\.target/.test(src), 'the executor merges the target');
  // And there is exactly ONE place arguments are handed to a tool.
  assert.equal((src.match(/executeTool\(/g) ?? []).length, 1);
});

test('X5 — canonicalisation happens BEFORE the fingerprint, in both computing paths', () => {
  const store = read('agent/plan/store.js');
  const planner = read('agent/plan/planner.js');
  // store.js: canonicalise, then fingerprint.
  assert.ok(store.indexOf('canonicalisePlan(plan)') < store.indexOf('fingerprintPlan(canonical)'),
    'savePlan fingerprints before canonicalising');
  // planner.js: stampPlatformFacts canonicalises, and generatePlan fingerprints
  // its output.
  assert.match(planner, /const \{ plan: canonical \} = canonicalisePlan\(plan\);/);
  assert.ok(planner.indexOf('canonicalisePlan(plan)') < planner.indexOf('fingerprint: fingerprintPlan(plan)'),
    'the planner fingerprints before canonicalising');
});

/* ================================================================== *
 * D. SECURITY — canonicalisation is not a way past anything
 * ================================================================== */

test('S1 — canonicalisation cannot approve a mutation', async () => {
  let ran = 0;
  const drop = localTool('p11_s1', {
    mutating: true, inputSchema: RECORD_SCHEMA,
    describeWrite: (i) => ({ operation: 'update', table: i.table, sys_id: i.sys_id, requested: i.data }),
    execute: async () => { ran += 1; return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 250);
    const saved = P.savePlan(taskId, {
      goal: 'g',
      steps: [step({
        tool: 'p11_s1', mutating: true, capability: 'record_update',
        target: { table: 'incident', sys_id: SYS }, inputs: { data: { short_description: 'x' } },
        expected_effects: ['x'], verification: { strategy: 'read_back', asserts: ['ok'] },
      })],
    });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    // Nobody answers the gate.
    await P.executePlan({ taskId, sessionId, turnSeq: 1, signal: ctl.signal, emit: () => {} });
    assert.equal(ran, 0, 'a canonicalised plan executed without an approval');
  } finally { drop(); }
});

test('S2 — canonicalisation cannot bypass checkWriteTarget', async () => {
  /*
   * The opposite of a bypass: because the target now REACHES the tool, the
   * descriptor has a sys_id and the confabulation guard fires on steps where it
   * previously could not. This asserts it fires.
   */
  let ran = 0;
  const drop = localTool('p11_s2', {
    mutating: true, inputSchema: RECORD_SCHEMA,
    describeWrite: (i) => ({ operation: 'update', table: i.table, sys_id: i.sys_id, requested: i.data }),
    execute: async () => { ran += 1; return { ok: true }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    // The sys_id is NEVER registered in this session.
    const { res } = await runPlan(taskId, sessionId, [step({
      tool: 'p11_s2', mutating: true, capability: 'record_update',
      target: { table: 'incident', sys_id: 'f'.repeat(32) },
      inputs: { data: { short_description: 'x' } },
      expected_effects: ['x'], verification: { strategy: 'read_back', asserts: ['ok'] },
    })]);
    assert.equal(ran, 0, 'a write ran against a sys_id the session never saw');
    assert.match(res.note, /never appeared in this session/);
  } finally { drop(); }
});

test('S3 — canonicalisation cannot bypass checkBeforeGate or verification', async () => {
  const exec = read('agent/plan/executor.js');
  // The order is unchanged: guards, then gate, then execute, then verify.
  const at = (re) => exec.search(re);
  assert.ok(at(/checkWriteTarget\(/) < at(/checkBeforeGate\(/));
  assert.ok(at(/checkBeforeGate\(/) < at(/executeTool\(/));
  assert.ok(at(/executeTool\(/) < at(/verifyMutation\(/));
  // And a dropped write still fails the step.
  let calls = 0;
  const drop = localTool('p11_s3', {
    mutating: true, inputSchema: RECORD_SCHEMA,
    describeWrite: (i, r) => ({ operation: 'update', table: i.table, sys_id: r?.sys_id ?? i.sys_id, requested: i.data }),
    execute: async (i) => { calls += 1; return { sys_id: i.sys_id, number: 'INC1' }; },   // field absent
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res, plan } = await runPlan(taskId, sessionId, [step({
      tool: 'p11_s3', mutating: true, capability: 'record_update',
      target: { table: 'incident', sys_id: SYS },
      inputs: { data: { short_description: 'AFTER' } },
      expected_effects: ['short_description becomes AFTER'],
      verification: { strategy: 'read_back', asserts: ['short_description == AFTER'] },
    })]);
    assert.equal(calls, 1);
    assert.equal(res.ok, false, 'a dropped write survived canonicalisation');
    assert.equal(plan.steps[0].state, 'failed');
  } finally { drop(); }
});

test('S4 — canonicalisation mutates no persistence and writes nothing', () => {
  const src = read('agent/plan/canonical.js');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const forbidden of [/getDb/, /prepare\(/, /INSERT|UPDATE|DELETE/i, /appendMutation/, /recordToolEvent/, /setStepState/]) {
    assert.ok(!forbidden.test(body), `canonical.js contains ${forbidden}`);
  }
  // And calling it leaves the database untouched.
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM agent_task_steps').get().n;
  P.canonicalisePlan({ goal: 'g', steps: [step({ tool: null })] });
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_task_steps').get().n, before);
});

test('S5 — there is exactly ONE canonicalisation implementation', () => {
  const defs = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      const b = fs.readFileSync(full, 'utf8');
      if (/export function canonicalExecutionArgs/.test(b)) defs.push(path.relative(SRC, full).replace(/\\/g, '/'));
    }
  };
  walk(SRC);
  assert.deepEqual(defs, ['agent/plan/canonical.js']);
  // And the ad-hoc reconciliations that predated it are the only other readers
  // of both locations — neither of them decides what executes.
  assert.match(read('agent/plan/review.js'), /s\.target\?\.sys_id \?\? s\.inputs\?\.sys_id/);
});

/* ================================================================== *
 * E. CONCURRENCY
 * ================================================================== */

test('N1 — two concurrent plans with different targets never cross-contaminate', async () => {
  const seen = new Map();
  let release;
  const bothIn = new Promise((r) => { release = r; });
  let arrived = 0;
  const mk = (name) => localTool(name, {
    mutating: false, inputSchema: RECORD_SCHEMA,
    execute: async (input) => {
      seen.set(name, input);
      arrived += 1;
      if (arrived >= 2) release();
      await bothIn;                       // both are inside at once
      return { ok: true };
    },
  });
  const d1 = mk('p11_n1_a');
  const d2 = mk('p11_n1_b');
  try {
    const a = newTask('A');
    const b = newTask('B');
    await Promise.all([
      runPlan(a.taskId, a.sessionId, [step({
        id: 'a1', tool: 'p11_n1_a', target: { table: 'incident', sys_id: SYS }, inputs: { query: 'A' },
      })], { goal: 'A' }),
      runPlan(b.taskId, b.sessionId, [step({
        id: 'b1', tool: 'p11_n1_b', target: { table: 'problem', sys_id: OTHER }, inputs: { query: 'B' },
      })], { goal: 'B' }),
    ]);

    assert.deepEqual(seen.get('p11_n1_a'), { query: 'A', table: 'incident', sys_id: SYS });
    assert.deepEqual(seen.get('p11_n1_b'), { query: 'B', table: 'problem', sys_id: OTHER });
    // And the stored plans agree with what ran.
    assert.deepEqual(P.loadPlan(a.taskId).steps[0].inputs, seen.get('p11_n1_a'));
    assert.deepEqual(P.loadPlan(b.taskId).steps[0].inputs, seen.get('p11_n1_b'));
    // Fingerprints differ, because the executions differ.
    assert.notEqual(P.loadPlan(a.taskId).fingerprint, P.loadPlan(b.taskId).fingerprint);
  } finally { d1(); d2(); }
});

test('N2 — evidence reflects the arguments that were approved and ran', async () => {
  const drop = localTool('p11_n2', {
    mutating: true, inputSchema: RECORD_SCHEMA,
    describeWrite: (i, r) => ({ operation: 'update', table: i.table, sys_id: r?.sys_id ?? i.sys_id, requested: i.data }),
    execute: async (i) => ({ sys_id: i.sys_id, short_description: 'AFTER' }),
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const proposed = step({
      tool: 'p11_n2', mutating: true, capability: 'record_update',
      target: { table: 'incident', sys_id: SYS },
      inputs: { data: { short_description: 'AFTER' } },
      expected_effects: ['short_description becomes AFTER'],
      verification: { strategy: 'read_back', asserts: ['short_description == AFTER'] },
    });
    const expected = P.canonicalExecutionArgs(proposed).args;
    const { evidence } = await runPlan(taskId, sessionId, [proposed]);

    // The evidence shows the canonical arguments — the ones a human approved.
    assert.deepEqual(evidence.steps[0].inputs, expected);
    assert.equal(evidence.changes[0].table, 'incident');
    assert.equal(evidence.changes[0].sys_id, SYS);
    assert.equal(evidence.changes[0].verification_status, 'applied');
  } finally { drop(); }
});

/* ================================================================== *
 * F. WHAT CANONICALISATION DOES NOT FIX
 * ================================================================== */

/*
 * THE REMAINING GAP, measured by the post-fix model evaluation and recorded
 * here so it is not mistaken for this phase's problem.
 *
 * Asked to update INC0010001, the model produces a correct two-step plan:
 *
 *   read_incident    query_records   { query: 'number=INC0010001' }
 *   update_incident  update_record   target.sys_id: '${read_incident.sys_id}'
 *
 * The read canonicalises perfectly — that is Phase 11 working. The UPDATE needs
 * a sys_id that does not exist until the read has run, and the plan model has
 * no way to say so: `depends_on` expresses ORDER, not DATA. So the model
 * invents a placeholder syntax, because there is nowhere else to put the idea.
 *
 * THIS IS NOT THE TARGET/INPUTS DEFECT and canonicalisation cannot resolve it:
 * the value genuinely does not exist at plan time. Building a reference
 * resolver would be a new dataflow abstraction, which this phase is explicitly
 * scoped out of. It is reported as a model/plan-contract limitation.
 *
 * WHAT MATTERS FOR SAFETY is that it fails closed, and that is asserted below:
 * a placeholder is not a sys_id the session has seen, so the confabulation
 * guard blocks it BEFORE the approval card is raised. Nobody is asked to
 * authorise a write against a target that does not exist.
 */

test('L1 — a placeholder sys_id reaches the CARD, and cannot address a record', async () => {
  /*
   * MEASURED, after a first version of this test asserted the comfortable
   * answer and was wrong.
   *
   * The expectation was that the confabulation guard would block a placeholder
   * before the approval card. It does not, and the reason is sound:
   * `checkWriteTarget` returns `not-a-sys-id` for anything that is not 32 hex
   * characters. It exists to catch sys_ids a model INVENTED — plausible-looking
   * identifiers pointing at real records nobody mentioned — and a string like
   * `${read.sys_id}` addresses nothing at all.
   *
   * So the honest account of what happens is:
   *
   *   the card IS raised, showing the placeholder verbatim;
   *   the guard steps aside because there is no sys_id claim to check;
   *   if a person approves it, the tool receives the literal string and the
   *   platform refuses the call.
   *
   * It fails closed, but at the instance rather than before the card — which
   * is weaker than a plan-time refusal and is why the underlying gap is
   * reported rather than papered over.
   */
  const { checkWriteTarget } = await import('../src/memory/provenance.js');
  const PLACEHOLDER = '${read_incident.sys_id}';

  let received = null;
  let cardsRaised = 0;
  let cardInput = null;
  const drop = localTool('p11_l1', {
    mutating: true, inputSchema: RECORD_SCHEMA,
    describeWrite: (i) => ({ operation: 'update', table: i.table, sys_id: i.sys_id, requested: i.data }),
    execute: async (input) => { received = input; return { sys_id: input.sys_id, short_description: 'x' }; },
  });
  try {
    const { taskId, sessionId } = newTask('placeholder');
    seeRecord(sessionId);   // a REAL sys_id is known, so this is about the placeholder

    // The guard's own verdict, stated directly.
    assert.deepEqual(
      checkWriteTarget({ sessionId, sysId: PLACEHOLDER, userText: '' }),
      { verdict: 'ok', reason: 'not-a-sys-id' },
      'the confabulation guard changed its treatment of a malformed identifier',
    );

    const saved = P.savePlan(taskId, {
      goal: 'update the incident',
      steps: [step({
        tool: 'p11_l1', mutating: true, capability: 'record_update',
        target: { table: 'incident', sys_id: PLACEHOLDER },
        inputs: { data: { short_description: 'x' } },
        expected_effects: ['x'], verification: { strategy: 'read_back', asserts: ['ok'] },
      })],
    });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    await P.executePlan({
      taskId, sessionId, turnSeq: 1,
      emit: (e) => {
        if (e.type === 'approval_required') {
          cardsRaised += 1;
          cardInput = e.input;
          setImmediate(() => resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce));
        }
      },
    });

    // A human IS asked, and what they are shown is the truth — the placeholder,
    // verbatim, not a tidied version of it.
    assert.equal(cardsRaised, 1, 'the placeholder never reached a card');
    assert.equal(cardInput.sys_id, PLACEHOLDER,
      'the card showed something other than what would run');
    // And the tool received exactly that, so nothing was silently repaired.
    assert.equal(received.sys_id, PLACEHOLDER);
    // It cannot address a real record: it is not a sys_id.
    assert.ok(!/^[0-9a-f]{32}$/i.test(PLACEHOLDER));
  } finally { drop(); }
});

test('L2 — canonicalisation lifts a placeholder without endorsing it', () => {
  /*
   * Canonicalisation is a pure move, not a judgement. It carries the value from
   * `target` to the arguments because the tool declares that key; whether the
   * value is MEANINGFUL is the guard's question, and L1 shows the guard
   * answering it. A canonicaliser that started rejecting values by their shape
   * would be a second validator.
   */
  const drop = localTool('p11_l2', { mutating: true, inputSchema: RECORD_SCHEMA, execute: async () => ({}) });
  try {
    const { args, lifted } = P.canonicalExecutionArgs(step({
      tool: 'p11_l2', target: { table: 'incident', sys_id: '${read.sys_id}' }, inputs: { data: {} },
    }));
    assert.equal(args.sys_id, '${read.sys_id}', 'canonicalisation altered the value it moved');
    assert.deepEqual(lifted.sort(), ['sys_id', 'table']);
  } finally { drop(); }
});

test('L3 — there is no output-substitution mechanism, and none was added', () => {
  // Phase 7 established this and Phase 11 does not change it: nothing resolves
  // one step's output into another step's arguments.
  for (const f of ['agent/plan/executor.js', 'agent/plan/canonical.js', 'agent/plan/store.js']) {
    const b = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    /*
     * Look for RESOLUTION MACHINERY, not for the characters. An earlier form of
     * this matched `${descriptor.sys_id}` inside a log message — an ordinary
     * template literal — and reported the executor as a placeholder resolver.
     */
    assert.ok(!/resolvePlaceholder|substituteOutput|interpolateStep|resolveStepRef|outputOf\(/.test(b),
      `${f} resolves step-output references`);
    assert.ok(!/steps\[[^\]]+\]\.result[^;]*\binputs\b/.test(b),
      `${f} feeds one step's result into another step's arguments`);
  }
});
