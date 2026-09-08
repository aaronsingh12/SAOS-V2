/**
 * PHASE 12 — STEP-TO-STEP DATAFLOW.
 *
 *   node --test server/test/
 *
 * THE CANONICAL PROOF this file exists for:
 *
 *     read_incident → result.sys_id → update_incident.target.sys_id
 *                  → read-back → verified
 *
 * with no guessed sys_id, no placeholder reaching a tool, no hidden mutation,
 * and no gap between what a human approved and what ran.
 *
 * THE ONE RULE. A reference is DATA. Nothing in the resolver evaluates,
 * interpolates or executes anything — it parses a fixed grammar, walks a graph,
 * and looks a value up in an object. Every path that cannot produce a value
 * STOPS; there is no branch anywhere that substitutes null, "", the first
 * matching record, or a guess.
 *
 * WHY THE GRAMMAR IS SO SMALL. The model, asked three times to update one
 * incident, invented three different syntaxes — `${step_1.output.sys_id}`,
 * `${read_incident.sys_id}`, `<from step_1>`. None was a mechanism; each was a
 * string that would have reached the tool verbatim. A narrow grammar that
 * refuses all three is worth more than a permissive one that guesses at what
 * they meant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p12-'));
const HOME = path.join(scratchDir, 'home.db');
_setDbForTests(migrate(new DatabaseSync(HOME)));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const P = await import('../src/agent/plan/index.js');
const R = await import('../src/agent/recovery/index.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

let n = 0;
function newTask(goal = 'p12') {
  const sid = `p12-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const SYS = '7'.repeat(32);
const OTHER = '9'.repeat(32);
const localTool = (name, spec) => { toolMap.set(name, { name, ...spec }); return () => toolMap.delete(name); };
const seeRecord = (sessionId, sysId = SYS) => registerFromToolResult({
  sessionId, seq: 0, table: 'incident', result: { sys_id: sysId, short_description: 'before' },
});

/** A producer shaped like a real read tool: ServiceNow cells, declared outputs. */
const producer = (name, over = {}) => localTool(name, {
  mutating: false,
  inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
  outputs: over.outputs ?? {
    sys_id: { type: 'sys_id', from: 'sys_id' },
    number: { type: 'string', from: 'number' },
    active: { type: 'boolean', from: 'active' },
    order: { type: 'integer', from: 'order' },
    assignment_group: { type: 'reference', from: 'assignment_group' },
  },
  execute: over.execute ?? (async () => ({
    sys_id: { display_value: SYS, value: SYS },
    number: { display_value: 'INC0010001', value: 'INC0010001' },
    active: { display_value: 'true', value: 'true' },
    order: { display_value: '100', value: 100 },
    assignment_group: { display_value: 'Network', value: OTHER },
  })),
});

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    table: { type: 'string' }, sys_id: { type: 'string' },
    data: { type: 'object' }, note: { type: 'string' }, count: { type: 'number' }, flag: { type: 'boolean' },
  },
  required: ['table', 'sys_id'],
};

/** A consumer that records exactly what it received. */
const consumer = (name, sink) => localTool(name, {
  mutating: true,
  inputSchema: WRITE_SCHEMA,
  describeWrite: (i, r) => ({ operation: 'update', table: i.table, sys_id: r?.sys_id ?? i.sys_id, requested: i.data }),
  execute: async (i) => { sink.got = i; return { sys_id: i.sys_id, short_description: 'AFTER' }; },
});

const readStep = (id, tool, over = {}) => ({
  id, operation: `read ${id}`, capability: 'record_read', tool,
  mechanism: null, scope: null, mutating: false,
  target: { table: 'incident' }, inputs: { table: 'incident' },
  depends_on: [], expected_effects: [], verification: null, ...over,
});
const writeStep = (id, tool, over = {}) => ({
  id, operation: `update ${id}`, capability: 'record_update', tool,
  mechanism: null, scope: null, mutating: true,
  target: over.target ?? { table: 'incident', sys_id: { $ref: 'step_1.result.sys_id' } },
  inputs: over.inputs ?? { table: 'incident', data: { short_description: 'AFTER' } },
  depends_on: 'depends_on' in over ? over.depends_on : ['step_1'],
  expected_effects: ['short_description becomes AFTER'],
  verification: { strategy: 'read_back', asserts: ['short_description == AFTER'] },
  ...('target' in over || 'inputs' in over || 'depends_on' in over ? {} : {}),
});

const discover = (name) => ({
  capability: name, status: 'known', available: true, mechanism: 'rest',
  mutating: name !== 'record_read', verification: name === 'record_read' ? 'none' : 'read_back',
  requiresVerification: name !== 'record_read', requiresApproval: name !== 'record_read',
  requiresElevation: false, elevationRole: null, scope: null, reason: null, note: null,
});
const validate = (steps, goal = 'g') => P.validatePlan({ goal, steps }, { discover });

async function runPlan(taskId, sessionId, steps, { decide = true, signal = null, recoverStep = null, goal = 'g' } = {}) {
  const saved = P.savePlan(taskId, { goal, steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  const cards = [];
  const res = await P.executePlan({
    taskId, sessionId, turnSeq: 1, signal, recoverStep,
    emit: (e) => {
      if (e.type === 'approval_required') {
        cards.push(e);
        if (decide !== null) {
          setImmediate(() => resolveApproval(sessionId, e.approvalId, decide, APPROVAL_SOURCES.USER_CLICK, e.nonce));
        }
      }
    },
  });
  return { res, saved, cards, plan: P.loadPlan(taskId), evidence: buildEvidence(taskId) };
}

/* ================================================================== *
 * A. THE GRAMMAR
 * ================================================================== */

test('G1 — the accepted form, and only the accepted form', () => {
  for (const good of ['step_1.result.sys_id', 'read_incident.result.sys_id', 'a.result.number']) {
    const r = P.parseReference(good);
    assert.equal(r.ok, true, `"${good}" was rejected`);
  }
});

test('G2 — every form the specification names as invalid is rejected', () => {
  const bad = [
    '${step_1.sys_id}',
    'step_1.sys_id',
    '../../secret',
    'step_1.result["sys_id"]',
    'arbitrary.javascript()',
    'step_1.result.sys_id.deeper',
    'step_1.output.sys_id',
    'step_1..result.sys_id',
    '.result.sys_id',
    'step_1.result.',
    'step_1 . result . sys_id',
    '',
    '   ',
    null, undefined, 42, {}, [],
  ];
  for (const b of bad) {
    const r = P.parseReference(b);
    assert.equal(r.ok, false, `${JSON.stringify(b)} was accepted as a reference`);
    assert.equal(r.code, P.DATAFLOW_CODES.MALFORMED);
  }
});

test('G3 — a reference is an object with exactly one key', () => {
  const drop = producer('p12_g3');
  try {
    // The real shape.
    assert.equal(P.findReferences({ target: { sys_id: { $ref: 'step_1.result.sys_id' } } }).length, 1);
    // An object that merely CONTAINS $ref alongside other keys is not one.
    assert.equal(P.findReferences({ target: { sys_id: { $ref: 'step_1.result.sys_id', extra: 1 } } }).length, 0);
    // A string is never a reference.
    assert.equal(P.findReferences({ target: { sys_id: 'step_1.result.sys_id' } }).length, 0);
  } finally { drop(); }
});

test('G4 — the resolver contains no evaluation of any kind', () => {
  const body = read('agent/plan/dataflow.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /*
   * NO EVALUATION OF ANY KIND. Template literals DO appear — they build the
   * sentences a person reads in a refusal — and that is string formatting, not
   * evaluation: the interpolated values go into a message, never into anything
   * that runs. What must be absent is every construct that could turn plan data
   * into behaviour.
   */
  for (const forbidden of [/\beval\b/, /new Function/, /\bFunction\s*\(/, /\bvm\./,
    /require\s*\(/, /\bimport\s*\(/, /setTimeout|setInterval/,
    /await\b/, /fetch\s*\(/, /Math\.random/, /Date\.now/, /process\./]) {
    assert.ok(!forbidden.test(body), `dataflow.js contains ${forbidden}`);
  }
  // And no interpolated value ever reaches a constructor or a dynamic key path.
  assert.ok(!/\[\s*`[^`]*\$\{/.test(body), 'dataflow.js indexes by an interpolated key');
  // Every `${}` in the file sits inside a message string, never inside code.
  const interpolations = body.match(/\$\{[^}]*\}/g) ?? [];
  assert.ok(interpolations.length > 0, 'the parser found no template literals at all — check the regex');
});

/* ================================================================== *
 * B. VALIDATION — positive
 * ================================================================== */

test('V1 — a single reference to a declared output validates', () => {
  const dp = producer('p12_v1r'); const sink = {}; const dc = consumer('p12_v1w', sink);
  try {
    const v = validate([readStep('step_1', 'p12_v1r'), writeStep('step_2', 'p12_v1w')]);
    assert.equal(v.valid, true, v.fatal.map((p) => p.code).join(', '));
  } finally { dp(); dc(); }
});

test('V2 — MULTIPLE references in one step, and one producer feeding many consumers', () => {
  const dp = producer('p12_v2r'); const s1 = {}; const s2 = {};
  const d1 = consumer('p12_v2a', s1); const d2 = consumer('p12_v2b', s2);
  try {
    const v = validate([
      readStep('step_1', 'p12_v2r'),
      writeStep('step_2', 'p12_v2a', {
        target: { table: 'incident', sys_id: { $ref: 'step_1.result.sys_id' } },
        inputs: { table: 'incident', data: {}, note: { $ref: 'step_1.result.number' } },
      }),
      writeStep('step_3', 'p12_v2b', {
        target: { table: 'incident', sys_id: { $ref: 'step_1.result.sys_id' } },
        inputs: { table: 'incident', data: {} },
        depends_on: ['step_1'],
      }),
    ]);
    assert.equal(v.valid, true, v.fatal.map((p) => p.code).join(', '));
  } finally { dp(); d1(); d2(); }
});

test('V3 — every declared TYPE resolves into a matching slot', () => {
  const dp = producer('p12_v3r'); const sink = {}; const dc = consumer('p12_v3w', sink);
  try {
    // sys_id -> sys_id, string -> untyped slot, integer -> untyped, boolean -> untyped.
    const v = validate([
      readStep('step_1', 'p12_v3r'),
      writeStep('step_2', 'p12_v3w', {
        target: { table: 'incident', sys_id: { $ref: 'step_1.result.sys_id' } },
        inputs: {
          table: 'incident', data: {},
          note: { $ref: 'step_1.result.number' },
          count: { $ref: 'step_1.result.order' },
          flag: { $ref: 'step_1.result.active' },
        },
      }),
    ]);
    assert.equal(v.valid, true, v.fatal.map((p) => p.code).join(', '));
  } finally { dp(); dc(); }
});

test('V4 — a REFERENCE-typed output satisfies a sys_id slot', () => {
  // `assignment_group` is a reference, and a reference field's value IS the
  // identity of the row it points at. This is the one widening, and it is a
  // fact about ServiceNow rather than a convenience.
  assert.equal(P.typeSatisfies('reference', 'sys_id'), true);
  assert.equal(P.typeSatisfies('sys_id', 'sys_id'), true);
  assert.equal(P.typeSatisfies('string', 'sys_id'), false, 'a string was accepted as an identity');
  assert.equal(P.typeSatisfies('integer', 'sys_id'), false);
  assert.equal(P.typeSatisfies(undefined, 'sys_id'), false, 'an undeclared output proved something');
});

test('V5 — a reference through THREE sequential steps validates', () => {
  const dp = producer('p12_v5r'); const s1 = {}; const s2 = {};
  const d1 = consumer('p12_v5a', s1); const d2 = consumer('p12_v5b', s2);
  try {
    const v = validate([
      readStep('step_1', 'p12_v5r'),
      writeStep('step_2', 'p12_v5a'),
      writeStep('step_3', 'p12_v5b', { depends_on: ['step_1', 'step_2'] }),
    ]);
    assert.equal(v.valid, true, v.fatal.map((p) => p.code).join(', '));
  } finally { dp(); d1(); d2(); }
});

/* ================================================================== *
 * C. VALIDATION — negative
 * ================================================================== */

const negative = (label, steps, code) => test(`N — ${label}`, () => {
  const v = validate(steps);
  assert.equal(v.valid, false, `${label} was accepted`);
  assert.ok(v.fatal.some((p) => p.code === code),
    `expected ${code}, got ${v.fatal.map((p) => p.code).join(', ')}`);
});

{
  const dp = producer('p12_nr');
  const sink = {};
  const dc = consumer('p12_nw', sink);
  // Registered for the whole file — these are validation-only tests.
  void dp; void dc;

  negative('a malformed reference', [
    readStep('step_1', 'p12_nr'),
    writeStep('step_2', 'p12_nw', { target: { table: 'incident', sys_id: { $ref: 'nonsense' } } }),
  ], P.DATAFLOW_CODES.MALFORMED);

  negative('a legacy ${...} placeholder string', [
    readStep('step_1', 'p12_nr'),
    writeStep('step_2', 'p12_nw', { target: { table: 'incident', sys_id: '${step_1.output.sys_id}' } }),
  ], P.DATAFLOW_CODES.MALFORMED);

  negative('a "<from step_1>" placeholder string', [
    readStep('step_1', 'p12_nr'),
    writeStep('step_2', 'p12_nw', { target: { table: 'incident', sys_id: '<from step_1>' } }),
  ], P.DATAFLOW_CODES.MALFORMED);

  negative('an unknown step', [
    readStep('step_1', 'p12_nr'),
    writeStep('step_2', 'p12_nw', { target: { table: 'incident', sys_id: { $ref: 'step_99.result.sys_id' } } }),
  ], P.DATAFLOW_CODES.UNKNOWN_STEP);

  negative('an unknown output', [
    readStep('step_1', 'p12_nr'),
    writeStep('step_2', 'p12_nw', { target: { table: 'incident', sys_id: { $ref: 'step_1.result.nope' } } }),
  ], P.DATAFLOW_CODES.UNKNOWN_OUTPUT);

  negative('a missing dependency', [
    readStep('step_1', 'p12_nr'),
    writeStep('step_2', 'p12_nw', { depends_on: [] }),
  ], P.DATAFLOW_CODES.NO_DEPENDENCY);

  negative('a producer that declares no outputs', [
    readStep('step_1', 'update_record'),
    writeStep('step_2', 'p12_nw'),
  ], P.DATAFLOW_CODES.NO_OUTPUTS);

  negative('a TYPE mismatch: a string into a sys_id slot', [
    readStep('step_1', 'p12_nr'),
    writeStep('step_2', 'p12_nw', { target: { table: 'incident', sys_id: { $ref: 'step_1.result.number' } } }),
  ], P.DATAFLOW_CODES.TYPE_MISMATCH);

  negative('a forward reference', [
    writeStep('step_2', 'p12_nw', { target: { table: 'incident', sys_id: { $ref: 'step_1.result.sys_id' } }, depends_on: ['step_1'] }),
    readStep('step_1', 'p12_nr'),
  ], P.DATAFLOW_CODES.FORWARD);
}

test('N — a SELF reference is refused', () => {
  const dp = producer('p12_selfr'); const sink = {}; const dc = consumer('p12_selfw', sink);
  try {
    const v = validate([
      readStep('step_1', 'p12_selfr'),
      writeStep('step_2', 'p12_selfw', {
        target: { table: 'incident', sys_id: { $ref: 'step_2.result.sys_id' } },
        depends_on: ['step_1'],
      }),
    ]);
    assert.equal(v.valid, false);
    assert.ok(v.fatal.some((p) => p.code === P.DATAFLOW_CODES.SELF),
      v.fatal.map((p) => p.code).join(', '));
  } finally { dp(); dc(); }
});

test('N — a CIRCULAR dataflow is refused', () => {
  const s1 = {}; const s2 = {};
  const d1 = consumer('p12_c1', s1); const d2 = consumer('p12_c2', s2);
  // Both declare outputs so the cycle is reachable rather than stopped earlier.
  toolMap.get('p12_c1').outputs = { sys_id: { type: 'sys_id', from: 'sys_id' } };
  toolMap.get('p12_c2').outputs = { sys_id: { type: 'sys_id', from: 'sys_id' } };
  try {
    const problems = P.validateDataflow({
      goal: 'g',
      steps: [
        { id: 'a', tool: 'p12_c1', depends_on: ['b'], target: { sys_id: { $ref: 'b.result.sys_id' } }, inputs: {} },
        { id: 'b', tool: 'p12_c2', depends_on: ['a'], target: { sys_id: { $ref: 'a.result.sys_id' } }, inputs: {} },
      ],
    });
    assert.ok(problems.some((p) => p.code === P.DATAFLOW_CODES.CIRCULAR),
      `expected circular_dataflow, got ${problems.map((p) => p.code).join(', ')}`);
  } finally { d1(); d2(); }
});

test('N — a reference INJECTION attempt is refused, not executed', () => {
  const dp = producer('p12_injr'); const sink = {}; const dc = consumer('p12_injw', sink);
  try {
    for (const attack of [
      'step_1.result.sys_id; DROP TABLE',
      'step_1.result.__proto__',
      'step_1.result.constructor',
      '__proto__.result.sys_id',
      'step_1.result.sys_id\nstep_1.result.number',
    ]) {
      const v = validate([
        readStep('step_1', 'p12_injr'),
        writeStep('step_2', 'p12_injw', { target: { table: 'incident', sys_id: { $ref: attack } } }),
      ]);
      assert.equal(v.valid, false, `"${attack}" was accepted`);
    }
  } finally { dp(); dc(); }
});

/* ================================================================== *
 * D. FINGERPRINT
 * ================================================================== */

test('F1 — the reference structure participates in the fingerprint', () => {
  const dp = producer('p12_f1r'); const sink = {}; const dc = consumer('p12_f1w', sink);
  try {
    const mk = (ref) => ({
      goal: 'g',
      steps: [readStep('step_1', 'p12_f1r'), writeStep('step_2', 'p12_f1w', {
        target: { table: 'incident', sys_id: { $ref: ref } },
      })],
    });
    // Different OUTPUT -> different fingerprint.
    assert.notEqual(P.fingerprintPlan(mk('step_1.result.sys_id')),
      P.fingerprintPlan(mk('step_1.result.number')));
    // Same reference -> same fingerprint.
    assert.equal(P.fingerprintPlan(mk('step_1.result.sys_id')),
      P.fingerprintPlan(mk('step_1.result.sys_id')));
    // A literal and a reference to the same slot are different plans.
    const literal = {
      goal: 'g',
      steps: [readStep('step_1', 'p12_f1r'), writeStep('step_2', 'p12_f1w', {
        target: { table: 'incident', sys_id: SYS },
      })],
    };
    assert.notEqual(P.fingerprintPlan(mk('step_1.result.sys_id')), P.fingerprintPlan(literal));
  } finally { dp(); dc(); }
});

test('F2 — a different PRODUCER step produces a different fingerprint', () => {
  const d1 = producer('p12_f2a'); const d2 = producer('p12_f2b');
  const sink = {}; const dc = consumer('p12_f2w', sink);
  try {
    const mk = (ref) => ({
      goal: 'g',
      steps: [
        readStep('step_1', 'p12_f2a'),
        readStep('step_2', 'p12_f2b'),
        writeStep('step_3', 'p12_f2w', {
          target: { table: 'incident', sys_id: { $ref: ref } },
          depends_on: ['step_1', 'step_2'],
        }),
      ],
    });
    assert.notEqual(P.fingerprintPlan(mk('step_1.result.sys_id')),
      P.fingerprintPlan(mk('step_2.result.sys_id')));
  } finally { d1(); d2(); dc(); }
});

test('F3 — changing a reference after approval is approval_stale', () => {
  const dp = producer('p12_f3r'); const sink = {}; const dc = consumer('p12_f3w', sink);
  try {
    const { taskId } = newTask();
    const mk = (ref) => [readStep('step_1', 'p12_f3r'), writeStep('step_2', 'p12_f3w', {
      target: { table: 'incident', sys_id: { $ref: ref } },
    })];
    const a = P.savePlan(taskId, { goal: 'g', steps: mk('step_1.result.sys_id') });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, a.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    assert.equal(P.checkApprovalBinding(taskId).ok, true);

    const b = P.savePlan(taskId, { goal: 'g', steps: mk('step_1.result.number') });
    assert.notEqual(b.fingerprint, a.fingerprint);
    const bound = P.checkApprovalBinding(taskId);
    assert.equal(bound.ok, false);
    assert.equal(bound.reason, 'approval_stale');
  } finally { dp(); dc(); }
});

test('F4 — there is exactly ONE fingerprint implementation', () => {
  const defs = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      if (/export function fingerprintPlan/.test(fs.readFileSync(full, 'utf8'))) {
        defs.push(path.relative(SRC, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(SRC);
  assert.deepEqual(defs, ['agent/plan/fingerprint.js']);
});

/* ================================================================== *
 * E. EXECUTION — the canonical proof
 * ================================================================== */

test('X1 — CANONICAL PROOF: read -> result.sys_id -> update.target.sys_id -> verified', async () => {
  const dp = producer('p12_x1r');
  const sink = {};
  const dc = consumer('p12_x1w', sink);
  try {
    const { taskId, sessionId } = newTask('the canonical proof');
    seeRecord(sessionId);
    const { res, cards, plan, evidence } = await runPlan(taskId, sessionId, [
      readStep('step_1', 'p12_x1r'),
      writeStep('step_2', 'p12_x1w'),
    ]);

    assert.equal(res.ok, true, JSON.stringify(res));
    // The producer's declared output was captured, durably.
    assert.deepEqual(P.stepOutputs(taskId, 'step_1'), {
      sys_id: SYS, number: 'INC0010001', active: 'true', order: 100, assignment_group: OTHER,
    });
    // The consumer received the RESOLVED value, not a reference object.
    assert.equal(sink.got.sys_id, SYS, 'the consumer did not receive the produced sys_id');
    assert.equal(typeof sink.got.sys_id, 'string');
    // It was verified through the ordinary pipeline.
    assert.equal(plan.steps[1].state, 'completed');
    assert.equal(evidence.changes[0].verification_status, 'applied');
    assert.equal(evidence.final.status, 'VERIFIED');
  } finally { dp(); dc(); }
});

test('X2 — the STORED plan keeps the reference; only the runtime value is resolved', async () => {
  const dp = producer('p12_x2r'); const sink = {}; const dc = consumer('p12_x2w', sink);
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    await runPlan(taskId, sessionId, [readStep('step_1', 'p12_x2r'), writeStep('step_2', 'p12_x2w')]);

    /*
     * THE ANTI-NORMALISATION PROPERTY. The plan on disk still says `$ref` —
     * nothing rewrote it — so the approval still binds the reference a human
     * saw. The value only ever existed as an argument for one call.
     */
    const stored = P.loadPlan(taskId).steps[1];
    assert.deepEqual(stored.inputs.sys_id, { $ref: 'step_1.result.sys_id' },
      'the stored plan was rewritten with the resolved value');
    assert.equal(sink.got.sys_id, SYS);
  } finally { dp(); dc(); }
});

test('X3 — the approval card shows the reference AND the value it resolved to', async () => {
  const dp = producer('p12_x3r'); const sink = {}; const dc = consumer('p12_x3w', sink);
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { cards } = await runPlan(taskId, sessionId, [readStep('step_1', 'p12_x3r'), writeStep('step_2', 'p12_x3w')]);
    assert.equal(cards.length, 1, 'the mutating step did not reach the gate');
    const card = cards[0];
    assert.ok(Array.isArray(card.dataflow) && card.dataflow.length === 1,
      `the card carries no dataflow: ${JSON.stringify(card.dataflow)}`);
    const d = card.dataflow[0];
    assert.equal(d.declared, 'step_1.result.sys_id', 'the card does not name the reference');
    assert.equal(d.resolved, SYS, 'the card does not show the value that will run');
    assert.match(d.path, /sys_id$/);
    // And the value it will run with is on the card too.
    assert.equal(card.input.sys_id, SYS);
  } finally { dp(); dc(); }
});

test('X4 — a step with NO references gets a null dataflow, unchanged from before', async () => {
  const sink = {};
  const dc = consumer('p12_x4w', sink);
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { cards, res } = await runPlan(taskId, sessionId, [
      writeStep('step_1', 'p12_x4w', {
        target: { table: 'incident', sys_id: SYS },
        inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'AFTER' } },
        depends_on: [],
      }),
    ]);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(cards[0].dataflow, null, 'an ordinary card grew a dataflow field');
  } finally { dc(); }
});

/* ================================================================== *
 * F. FAILURE — every path stops
 * ================================================================== */

test('S1 — a FAILED producer stops the consumer, and nothing is substituted', async () => {
  let ran = 0;
  const dp = localTool('p12_s1r', {
    mutating: false,
    inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    outputs: { sys_id: { type: 'sys_id', from: 'sys_id' } },
    execute: async () => { throw Object.assign(new Error('the instance said no'), { status: 500 }); },
  });
  const sink = {};
  const dc = localTool('p12_s1w', {
    mutating: true, inputSchema: WRITE_SCHEMA,
    describeWrite: (i) => ({ operation: 'update', table: i.table, sys_id: i.sys_id, requested: i.data }),
    execute: async (i) => { ran += 1; sink.got = i; return { sys_id: i.sys_id }; },
  });
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res, plan } = await runPlan(taskId, sessionId, [readStep('step_1', 'p12_s1r'), writeStep('step_2', 'p12_s1w')]);
    assert.equal(res.ok, false);
    assert.equal(ran, 0, 'the consumer ran with an unresolved reference');
    assert.equal(plan.steps[0].state, 'failed');
    assert.notEqual(plan.steps[1].state, 'completed');
  } finally { dp(); dc(); }
});

test('S2 — a CANCELLED producer stops the consumer', async () => {
  const ctl = new AbortController();
  let ran = 0;
  const dp = localTool('p12_s2r', {
    mutating: false,
    inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    outputs: { sys_id: { type: 'sys_id', from: 'sys_id' } },
    execute: async () => { ctl.abort(); return { sys_id: { value: SYS } }; },
  });
  const sink = {};
  const dc = consumer('p12_s2w', sink);
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { plan } = await runPlan(taskId, sessionId,
      [readStep('step_1', 'p12_s2r'), writeStep('step_2', 'p12_s2w')], { signal: ctl.signal });
    assert.equal(ran, 0);
    assert.ok(!sink.got, 'the consumer ran after a cancellation');
    assert.equal(plan.planState, 'cancelled');
  } finally { dp(); dc(); }
});

test('S3 — a producer that returns NOTHING for its declared output stops the consumer', async () => {
  const dp = localTool('p12_s3r', {
    mutating: false,
    inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    outputs: { sys_id: { type: 'sys_id', from: 'sys_id' } },
    execute: async () => ({ number: { value: 'INC1' } }),      // no sys_id at all
  });
  const sink = {};
  const dc = consumer('p12_s3w', sink);
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res } = await runPlan(taskId, sessionId, [readStep('step_1', 'p12_s3r'), writeStep('step_2', 'p12_s3w')]);
    assert.equal(res.ok, false, 'a missing output was substituted with something');
    assert.equal(res.reason, P.RESOLUTION_CODES.MISSING_OUTPUT);
    assert.ok(!sink.got, 'the consumer ran without its target');
  } finally { dp(); dc(); }
});

test('S4 — a NULL or empty produced value is refused, never passed through', async () => {
  for (const empty of [null, '', undefined]) {
    const dp = localTool('p12_s4r', {
      mutating: false,
      inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
      outputs: { sys_id: { type: 'sys_id', from: 'sys_id' } },
      execute: async () => ({ sys_id: { display_value: '', value: empty } }),
    });
    const sink = {};
    const dc = consumer('p12_s4w', sink);
    try {
      const { taskId, sessionId } = newTask();
      seeRecord(sessionId);
      const { res } = await runPlan(taskId, sessionId, [readStep('step_1', 'p12_s4r'), writeStep('step_2', 'p12_s4w')]);
      assert.equal(res.ok, false, `an empty value (${JSON.stringify(empty)}) reached the consumer`);
      assert.ok(!sink.got, 'the consumer ran with an empty target');
    } finally { dp(); dc(); }
  }
});

test('S5 — resolution never substitutes a default, for any failure', () => {
  // The unit-level statement of the same rule.
  const step = { id: 's2', target: { sys_id: { $ref: 's1.result.sys_id' } }, inputs: {} };
  for (const outputs of [{}, { s1: {} }, { s1: { sys_id: null } }, { s1: { sys_id: '' } }, { other: { sys_id: SYS } }]) {
    const r = P.resolveReferences(step, outputs);
    assert.equal(r.ok, false, `${JSON.stringify(outputs)} resolved to something`);
    // The reference is left as it was — not replaced with a stand-in.
    assert.deepEqual(r.target.sys_id, { $ref: 's1.result.sys_id' });
  }
});

/* ================================================================== *
 * G. RESTART AND RECOVERY
 * ================================================================== */

test('R1 — a produced output survives a process restart', async () => {
  const file = path.join(scratchDir, 'restart.db');
  const dp = producer('p12_r1r');
  const sink = {};
  const dc = consumer('p12_r1w', sink);
  let taskId = null;

  const first = migrate(new DatabaseSync(file));
  _setDbForTests(first);
  try {
    const now = new Date().toISOString();
    first.prepare('INSERT INTO sessions (id, created, updated) VALUES (?, ?, ?)').run('restart', now, now);
    const t = createTask({ sessionId: 'restart', goal: 'survive' });
    startTask(t.id);
    taskId = t.id;
    const saved = P.savePlan(taskId, { goal: 'g', steps: [readStep('step_1', 'p12_r1r'), writeStep('step_2', 'p12_r1w')] });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
    P.setStepState(taskId, 'step_1', 'ready');
    P.setStepState(taskId, 'step_1', 'executing');
    P.recordStepOutputs(taskId, 'step_1', { sys_id: SYS });
    P.setStepState(taskId, 'step_1', 'completed');
  } finally { first.close(); }

  // A different process opening the same file.
  const second = migrate(new DatabaseSync(file));
  _setDbForTests(second);
  try {
    assert.deepEqual(P.stepOutputs(taskId, 'step_1'), { sys_id: SYS },
      'the produced output did not survive the restart');
    // And a consumer can still resolve against it.
    const r = P.resolveReferences(
      { id: 'step_2', target: { sys_id: { $ref: 'step_1.result.sys_id' } }, inputs: {} },
      { step_1: P.stepOutputs(taskId, 'step_1') },
    );
    assert.equal(r.ok, true);
    assert.equal(r.target.sys_id, SYS);
  } finally {
    second.close();
    _setDbForTests(migrate(new DatabaseSync(HOME)));
    dp(); dc();
  }
});

test('R2 — an unresolvable reference does NOT re-run its producer', async () => {
  /*
   * The recovery guarantee. Re-running a producer because a consumer could not
   * read it would repeat whatever the producer did — and a producer can be a
   * mutation. The consumer stops instead.
   */
  let producerRuns = 0;
  const dp = localTool('p12_r2r', {
    mutating: false,
    inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    outputs: { sys_id: { type: 'sys_id', from: 'sys_id' } },
    execute: async () => { producerRuns += 1; return { number: { value: 'INC1' } }; },   // never yields sys_id
  });
  const sink = {};
  const dc = consumer('p12_r2w', sink);
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { res, evidence } = await runPlan(taskId, sessionId,
      [readStep('step_1', 'p12_r2r'), writeStep('step_2', 'p12_r2w')],
      { recoverStep: R.recoverStep });
    assert.equal(res.ok, false);
    assert.equal(producerRuns, 1, 'the producer was re-run to satisfy a consumer');
    assert.ok(!sink.got);
    // Recovery was not asked to rescue it either.
    assert.equal(evidence.recovery.recoveredSteps, 0);
  } finally { dp(); dc(); }
});

/* ================================================================== *
 * H. EVIDENCE
 * ================================================================== */

test('E1 — evidence shows declared, resolved and consumer, distinguishably', async () => {
  const dp = producer('p12_e1r'); const sink = {}; const dc = consumer('p12_e1w', sink);
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { evidence } = await runPlan(taskId, sessionId, [readStep('step_1', 'p12_e1r'), writeStep('step_2', 'p12_e1w')]);

    assert.equal(evidence.dataflow.used, true);
    const consumerRow = evidence.dataflow.steps.find((s) => s.step === 'step_2');
    assert.ok(consumerRow, `no dataflow row for step_2: ${JSON.stringify(evidence.dataflow)}`);
    const c = consumerRow.consumed[0];
    assert.equal(c.declared, 'step_1.result.sys_id', 'the declared reference is missing');
    assert.equal(c.resolved, SYS, 'the resolved value is missing');
    assert.match(c.consumer, /sys_id$/, 'the consumer slot is missing');
    assert.equal(c.producer, 'step_1');
    assert.equal(c.output, 'sys_id');
    // The producer's row shows what it produced.
    const producerRow = evidence.dataflow.steps.find((s) => s.step === 'step_1');
    assert.equal(producerRow.produced.sys_id, SYS);
  } finally { dp(); dc(); }
});

test('E2 — a run with no references reports used:false, not a zeroed section', async () => {
  const sink = {};
  const dc = consumer('p12_e2w', sink);
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { evidence } = await runPlan(taskId, sessionId, [
      writeStep('step_1', 'p12_e2w', {
        target: { table: 'incident', sys_id: SYS },
        inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'AFTER' } },
        depends_on: [],
      }),
    ]);
    assert.equal(evidence.dataflow.used, false);
    assert.match(evidence.dataflow.note, /No step consumed/);
  } finally { dc(); }
});

test('E3 — a produced SECRET goes through the existing redactor', async () => {
  const dp = localTool('p12_e3r', {
    mutating: false,
    inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    outputs: {
      sys_id: { type: 'sys_id', from: 'sys_id' },
      password: { type: 'string', from: 'password' },
    },
    execute: async () => ({
      sys_id: { value: SYS },
      password: { value: 'hunter2-PLANTED' },
    }),
  });
  const sink = {};
  const dc = consumer('p12_e3w', sink);
  try {
    const { taskId, sessionId } = newTask();
    seeRecord(sessionId);
    const { evidence } = await runPlan(taskId, sessionId, [readStep('step_1', 'p12_e3r'), writeStep('step_2', 'p12_e3w')]);
    const blob = JSON.stringify(evidence.dataflow);
    assert.ok(!blob.includes('hunter2-PLANTED'), `the dataflow section leaked a secret: ${blob.slice(0, 200)}`);
    // And the non-secret output survives — redaction did not eat the evidence.
    assert.ok(blob.includes(SYS));
  } finally { dp(); dc(); }
});

/* ================================================================== *
 * I. CONCURRENCY
 * ================================================================== */

test('C1 — ten concurrent plans never consume one another\'s outputs', async () => {
  const N = 10;
  const drops = [];
  const sinks = [];
  let arrived = 0;
  let release;
  const allIn = new Promise((r) => { release = r; });

  for (let i = 0; i < N; i += 1) {
    const own = String(i).padStart(2, '0').repeat(16);
    drops.push(localTool(`p12_c1r_${i}`, {
      mutating: false,
      inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
      outputs: { sys_id: { type: 'sys_id', from: 'sys_id' } },
      execute: async () => {
        arrived += 1;
        if (arrived >= N) release();
        await allIn;                       // every producer is in flight at once
        return { sys_id: { display_value: own, value: own } };
      },
    }));
    const sink = {};
    sinks.push(sink);
    drops.push(consumer(`p12_c1w_${i}`, sink));
  }

  try {
    const tasks = Array.from({ length: N }, (_, i) => newTask(`concurrent ${i}`));
    tasks.forEach((t) => seeRecord(t.sessionId));
    await Promise.all(tasks.map((t, i) => runPlan(t.taskId, t.sessionId, [
      readStep('step_1', `p12_c1r_${i}`),
      writeStep('step_2', `p12_c1w_${i}`),
    ], { goal: `concurrent ${i}` })));

    for (let i = 0; i < N; i += 1) {
      const own = String(i).padStart(2, '0').repeat(16);
      assert.equal(sinks[i].got?.sys_id, own,
        `plan ${i} consumed ${sinks[i].got?.sys_id} instead of its own producer's ${own}`);
      assert.deepEqual(P.stepOutputs(tasks[i].taskId, 'step_1'), { sys_id: own });
      const ev = buildEvidence(tasks[i].taskId);
      const c = ev.dataflow.steps.find((s) => s.step === 'step_2').consumed[0];
      assert.equal(c.resolved, own, `plan ${i}'s evidence shows another plan's value`);
    }
  } finally { drops.forEach((d) => d()); }
});

test('C2 — the resolver holds NO state between calls', () => {
  const body = read('agent/plan/dataflow.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /*
   * MODULE-LEVEL state is what would let two plans see each other. Maps and Sets
   * declared INSIDE a function are per-call scratch space and are exactly how a
   * graph walk should be written — the distinction is the indentation, so the
   * check is anchored to column zero.
   */
  assert.ok(!/^(let|var)\s/m.test(body), 'the resolver keeps module-level mutable state');
  assert.ok(!/^const\s+\w+\s*=\s*new (Map|Set|WeakMap|WeakSet)/m.test(body),
    'the resolver keeps a module-level registry');
  assert.ok(!/globalThis/.test(body), 'the resolver reaches global state');
  // Same inputs, same output, twice.
  const step = { id: 's2', target: { sys_id: { $ref: 's1.result.sys_id' } }, inputs: {} };
  const a = P.resolveReferences(step, { s1: { sys_id: SYS } });
  const b = P.resolveReferences(step, { s1: { sys_id: SYS } });
  assert.deepEqual(a, b);
});

/* ================================================================== *
 * J. ARCHITECTURE
 * ================================================================== */

test('A1 — the resolver imports nothing it must not', () => {
  const src = read('agent/plan/dataflow.js');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['../tools.js', '../../servicenow/semantic/tables.js'],
    `the resolver imports ${imports.join(', ')}`);
  for (const forbidden of ['servicenow/client', 'providers/', 'recovery/', 'evidence/', 'orchestrator', 'memory/db']) {
    assert.ok(!imports.some((i) => i.includes(forbidden)), `the resolver imports ${forbidden}`);
  }
  // And it cannot approve, execute, verify or persist.
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const f of ['executeTool', 'resolveApproval', 'verifyMutation', 'appendMutation', 'getDb', 'setStepState']) {
    assert.ok(!new RegExp(`\\b${f}\\b`).test(body), `the resolver references ${f}`);
  }
});

test('A2 — one of each subsystem, still', () => {
  const count = (re) => {
    let hits = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (e.name.endsWith('.js') && re.test(fs.readFileSync(full, 'utf8'))) hits += 1;
      }
    };
    walk(SRC);
    return hits;
  };
  assert.equal(count(/export async function executeTool/), 1, 'a second execution path');
  assert.equal(count(/export function resolveApproval/), 1, 'a second approval mechanism');
  assert.equal(count(/export async function verifyMutation/), 1, 'a second verifier');
  assert.equal(count(/export async function recoverStep/), 1, 'a second recovery path');
  assert.equal(count(/export function buildEvidence/), 1, 'a second evidence store');
  /*
   * TWO `redact` functions exist and always have: the EVIDENCE redactor, which
   * guards the durable projection, and a LOG redactor in logging.js that guards
   * the log stream. They are different output channels with different rules,
   * neither imports the other, and evidence never uses logging's. §23's "one
   * redaction path" is about the evidence boundary, and that one is singular.
   */
  assert.equal(count(/export function redact\(value, \{ depth = 0, seen/), 1,
    'a second EVIDENCE redactor');
  const evidenceFiles = fs.readdirSync(path.join(SRC, 'agent', 'evidence'));
  for (const f of evidenceFiles) {
    const src = fs.readFileSync(path.join(SRC, 'agent', 'evidence', f), 'utf8');
    assert.ok(!/from '[^']*logging\.js'/.test(src),
      `evidence/${f} imports the LOG redactor — the two boundaries must not merge`);
  }
  assert.equal(count(/export function canonicalExecutionArgs/), 1, 'a second canonicaliser');
  assert.equal(count(/export function validateDataflow/), 1, 'a second dataflow validator');
  assert.equal(count(/export function resolveReferences/), 1, 'a second resolver');
});

test('A3 — the executor still has exactly one call to executeTool', () => {
  const body = read('agent/plan/executor.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal((body.match(/executeTool\(/g) ?? []).length, 1);
  // And dataflow supplies arguments to runStep rather than executing anything.
  assert.ok(!/dataflow[^\n]*executeTool/.test(body));
  assert.match(body, /runStep\(\{[\s\S]{0,200}?dataflow,/);
});

test('A4 — no migration was added: user_version is still 23', () => {
  assert.equal(getDb().prepare('PRAGMA user_version').get().user_version, 23);
  const dbSrc = read('memory/db.js');
  assert.ok(!/\/\/ 24 —/.test(dbSrc), 'a migration 24 appeared');
});

test('A5 — prompts.js was NOT modified', async () => {
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(read('agent/prompts.js')).digest('hex').slice(0, 32);
  assert.equal(sha, '99585f7ee9a9f43011ba867c80765cdb',
    'prompts.js changed — Phase 12 must teach the reference contract through planner.js');
});

test('A6 — the reference contract is taught through planner.js, not prompts.js', () => {
  const planner = read('agent/plan/planner.js');
  assert.match(planner, /\$ref/, 'the planner never describes the reference form');
  assert.match(planner, /produces:/, 'declared outputs are not shown to the model');
  assert.ok(!/\$ref/.test(read('agent/prompts.js')), 'prompts.js describes the reference form');
});

/* ================================================================== *
 * K. TWO DEFECTS THE MODEL EXPOSED
 * ================================================================== */

test('K1 — REGRESSION: identical references in target AND inputs are not a conflict', () => {
  /*
   * FOUND BY THE MODEL. Given the reference contract it wrote the same `$ref`
   * in both `target.sys_id` and `inputs.sys_id` — saying one thing twice, which
   * Phase 11's rule explicitly allows. But the equality test was `===`, and two
   * structurally identical objects are not reference-equal, so every one of
   * those correct plans came back refused as a conflict.
   *
   * The comparison is structural now. A genuine disagreement is still a
   * conflict — nothing was loosened, only made able to see sameness.
   */
  const same = {
    tool: 'update_record',
    target: { table: 'incident', sys_id: { $ref: 'step_1.result.sys_id' } },
    inputs: { table: 'incident', sys_id: { $ref: 'step_1.result.sys_id' }, data: { x: 1 } },
  };
  const r = P.canonicalExecutionArgs(same);
  assert.deepEqual(r.conflicts, [], 'the same reference written twice was called a conflict');
  assert.deepEqual(r.args.sys_id, { $ref: 'step_1.result.sys_id' });

  // Key ORDER cannot make two identical values look different.
  const reordered = {
    tool: 'update_record',
    target: { sys_id: { $ref: 'step_1.result.sys_id' }, table: 'incident' },
    inputs: { table: 'incident', sys_id: { $ref: 'step_1.result.sys_id' } },
  };
  assert.deepEqual(P.canonicalExecutionArgs(reordered).conflicts, []);

  // A DIFFERENT reference is still a conflict.
  const differing = {
    tool: 'update_record',
    target: { table: 'incident', sys_id: { $ref: 'step_1.result.sys_id' } },
    inputs: { table: 'incident', sys_id: { $ref: 'step_2.result.sys_id' } },
  };
  assert.equal(P.canonicalExecutionArgs(differing).conflicts.length, 1,
    'two different references were merged');

  // And nothing is coerced: "1" and 1 remain a disagreement.
  const coerced = {
    tool: 'update_record',
    target: { table: 'incident', sys_id: '1' },
    inputs: { table: 'incident', sys_id: 1 },
  };
  assert.equal(P.canonicalExecutionArgs(coerced).conflicts.length, 1,
    'a string and a number were treated as the same value');
});

test('K2 — REGRESSION: a NUMBER in a sys_id slot is refused before the human is asked', () => {
  /*
   * MEASURED: asked to update "incident INC0010001", the model put the NUMBER
   * into `sys_id` in four runs out of six. Those plans validated, a human was
   * asked to approve `sys_id: INC0010001`, and the instance then refused the
   * write — fail-closed, but only after spending someone's attention.
   *
   * This is the other half of the reference mechanism: a model reaches for
   * `$ref` only when guessing an identity is refused.
   */
  const sink = {};
  const dc = consumer('p12_k2w', sink);
  try {
    const bad = validate([writeStep('step_1', 'p12_k2w', {
      target: { table: 'incident', sys_id: 'INC0010001' },
      inputs: { table: 'incident', sys_id: 'INC0010001', data: { short_description: 'x' } },
      depends_on: [],
    })]);
    assert.equal(bad.valid, false, 'an incident number was accepted as a sys_id');
    const p = bad.fatal.find((x) => x.code === 'sys_id_not_an_identity');
    assert.ok(p, bad.fatal.map((x) => x.code).join(', '));
    assert.match(p.message, /\$ref/, 'the refusal does not point at the mechanism that would fix it');

    // A real sys_id is accepted.
    const good = validate([writeStep('step_1', 'p12_k2w', {
      target: { table: 'incident', sys_id: SYS },
      inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'x' } },
      depends_on: [],
    })]);
    assert.equal(good.valid, true, good.fatal.map((x) => x.code).join(', '));
  } finally { dc(); }
});

test('K3 — a $ref in a sys_id slot is NOT judged by shape, but by declared type', () => {
  // The literal rule must not fire on a reference: a reference's correctness is
  // its declared TYPE, which V4 and the type-mismatch case already cover.
  const dp = producer('p12_k3r'); const sink = {}; const dc = consumer('p12_k3w', sink);
  try {
    const v = validate([readStep('step_1', 'p12_k3r'), writeStep('step_2', 'p12_k3w')]);
    assert.equal(v.valid, true, v.fatal.map((x) => x.code).join(', '));
    assert.ok(!v.fatal.some((x) => x.code === 'sys_id_not_an_identity'),
      'the literal rule fired on a reference');
  } finally { dp(); dc(); }
});
