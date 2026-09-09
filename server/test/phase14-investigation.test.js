/**
 * PHASE 14 — INVESTIGATION PLANNING AND DATAFLOW.
 *
 * §12, §15, §26 and §33. Two things are being established here:
 *
 *   1. An investigation is expressed in the EXISTING plan representation and
 *      built by the EXISTING planner. There is no second planner, and the
 *      Doctor's contribution is a goal string and a validation flag.
 *
 *   2. Reference traversal — incident to caller, to assignment group — runs on
 *      the Phase 12 resolver unchanged.
 *
 * ON THE SPECIFICATION'S REFERENCE SYNTAX. §15 and §33 write the traversal as
 * `step_1.result.caller.sys_id`. Phase 12's grammar admits exactly one segment
 * after `.result.` and `test/phase12-dataflow.test.js` pins the nested form as
 * REJECTED, so honouring that syntax literally would mean widening a grammar
 * whose docblock says "no nesting, no traversal" and breaking a Phase 12 test.
 *
 * The traversal is delivered instead through DECLARED OUTPUTS, which the
 * producer side already supported: `get_record` declares `caller_id`, and
 * `step_1.result.caller_id` resolves to the caller's sys_id because the
 * extractor unwraps the Table API cell. Same resolver, same refusals, same
 * grammar — and the producer still declares what may be read from it, which is
 * the invariant the nested form would have given away. Both forms are asserted
 * below: the working one resolves, the literal one is refused as malformed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p14i-')), 'p.db'))));
const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const P = await import('../src/agent/plan/index.js');
const D = await import('../src/agent/doctor/index.js');
const { toolMap } = await import('../src/agent/tools.js');
const { investigationGoal } = await import('../src/agent/doctor/investigation.js');

const INC = 'a'.repeat(32);
const CALLER = 'b'.repeat(32);
const GROUP = 'c'.repeat(32);

/* ================================================================== *
 * §33 — DATAFLOW
 * ================================================================== */

const incidentRow = (over = {}) => ({
  sys_id: { display_value: INC, value: INC },
  number: { display_value: 'INC0000039', value: 'INC0000039' },
  caller_id: { display_value: 'Bud Richman', value: CALLER },
  assignment_group: { display_value: 'Network', value: GROUP },
  assigned_to: { display_value: '', value: '' },
  ...over,
});

const consumer = (ref, over = {}) => ({
  id: 'step_2', tool: 'get_record',
  inputs: { table: 'sys_user', sys_id: { $ref: ref } },
  depends_on: ['step_1'], ...over,
});

test('§33 step_1.result.sys_id resolves', () => {
  const outs = P.extractOutputs('get_record', incidentRow());
  const r = P.resolveReferences(consumer('step_1.result.sys_id'), { step_1: outs });
  assert.ok(r.ok, JSON.stringify(r.problems));
  assert.equal(r.args.sys_id, INC);
});

test('§33 incident -> caller traverses a reference field', () => {
  const outs = P.extractOutputs('get_record', incidentRow());
  const r = P.resolveReferences(consumer('step_1.result.caller_id'), { step_1: outs });
  assert.ok(r.ok, JSON.stringify(r.problems));
  assert.equal(r.args.sys_id, CALLER, 'the caller sys_id, not the display name');
});

test('§33 incident -> assignment group traverses a reference field', () => {
  const outs = P.extractOutputs('get_record', incidentRow());
  const r = P.resolveReferences(consumer('step_1.result.assignment_group'), { step_1: outs });
  assert.ok(r.ok);
  assert.equal(r.args.sys_id, GROUP);
});

test('§33 an EMPTY reference cannot be traversed — it is not an identity', () => {
  const outs = P.extractOutputs('get_record', incidentRow());
  const r = P.resolveReferences(consumer('step_1.result.assigned_to'), { step_1: outs });
  assert.ok(!r.ok, 'an unassigned incident produced a usable assignee');
  assert.equal(r.problems[0].code, P.RESOLUTION_CODES.NULL_REQUIRED);
});

test('§33 the nested syntax from the specification is REFUSED as malformed', () => {
  assert.equal(P.parseReference('step_1.result.caller.sys_id').ok, false);
  assert.equal(P.parseReference('step_1.result.caller.sys_id').code, P.DATAFLOW_CODES.MALFORMED);
  // And it is refused at RESOLUTION too, not merely at parse.
  const r = P.resolveReferences(consumer('step_1.result.caller.sys_id'), { step_1: { caller_id: CALLER } });
  assert.ok(!r.ok);
  assert.equal(r.problems[0].code, P.DATAFLOW_CODES.MALFORMED);
});

test('§33 an invalid reference is refused BEFORE execution, at validation', () => {
  const steps = [
    {
      id: 'step_1', operation: 'read', capability: 'record_read', tool: 'get_record',
      mechanism: 'rest', scope: null, mutating: false, target: { table: 'incident' },
      inputs: { table: 'incident', sys_id: INC }, depends_on: [], expected_effects: [], verification: null,
    },
    {
      id: 'step_2', operation: 'read the caller', capability: 'record_read', tool: 'get_record',
      mechanism: 'rest', scope: null, mutating: false, target: { table: 'sys_user' },
      inputs: { table: 'sys_user', sys_id: { $ref: 'step_1.result.not_a_declared_output' } },
      depends_on: ['step_1'], expected_effects: [], verification: null,
    },
  ];
  const v = P.validatePlan({ goal: 'investigate', steps }, {
    discover: () => ({
      capability: 'record_read', status: 'known', available: true, mechanism: 'rest', mutating: false,
      verification: 'none', requiresVerification: false, requiresApproval: false,
      requiresElevation: false, elevationRole: null, scope: null, reason: null, note: null,
    }),
    readOnly: true,
  });
  assert.ok(!v.valid);
  assert.ok(v.fatal.some((p) => p.code === P.DATAFLOW_CODES.UNKNOWN_OUTPUT), v.fatal.map((p) => p.code).join(', '));
});

test('§33 get_record declares only reference fields beyond sys_id', () => {
  const outputs = toolMap.get('get_record').outputs;
  assert.deepEqual(Object.keys(outputs).sort(),
    ['assigned_to', 'assignment_group', 'caller_id', 'cmdb_ci', 'sys_id']);
  for (const [name, spec] of Object.entries(outputs)) {
    assert.equal(spec.type, 'sys_id', `${name} must be declared as an identity`);
  }
  // Nothing table-specific that is not a reference — the cost of a declared
  // output is paid at run time on tables that lack it, and is only worth
  // paying for traversal.
  for (const forbidden of ['number', 'state', 'short_description', 'priority']) {
    assert.ok(!(forbidden in outputs), `${forbidden} must not be a declared output of a generic reader`);
  }
});

/* ================================================================== *
 * THE INVESTIGATION GOAL AND MODE
 * ================================================================== */

test('§12 the investigation goal states the work as READS and says so', () => {
  const g = investigationGoal({
    subject: { type: 'incident', identifier: 'INC0010038' },
    symptom: { statement: 'not assigned' },
  });
  assert.match(g, /INC0010038/);
  assert.match(g, /READ/);
  assert.match(g, /not assigned/);
  assert.match(g, /\$ref/, 'the goal must name the reference mechanism it expects');
  assert.match(g, /refused/, 'stating the rule it will be judged by was the Phase 13 lesson');
});

test('§12 planInvestigation asks the EXISTING planner, with readOnly set', async () => {
  const seen = [];
  const generate = async (opts) => { seen.push(opts); return { ok: false, reason: 'planner_failed' }; };
  await D.planInvestigation({
    subject: { type: 'incident', identifier: 'INC0010038' }, symptom: { statement: 's' }, generate,
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].validateOpts, { readOnly: true },
    'the read-only flag must reach the validator through the existing planner');
  assert.ok(typeof seen[0].goal === 'string' && seen[0].goal.length > 0);
});

test('§12 planInvestigation refuses to run without an injected planner', async () => {
  await assert.rejects(() => D.planInvestigation({ subject: {}, symptom: {} }),
    /requires an injected generate/);
});

/* ================================================================== *
 * §26 — STOP CONDITIONS AT THE FRONT DOOR
 * ================================================================== */

test('§26 a request naming no record is refused rather than guessed at', () => {
  const r = D.readIntent('Why is everything broken?');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_subject');
  assert.match(r.note, /INC/, 'the refusal must say what would be usable');
});

test('§26 an incident number is read from the request, never invented', () => {
  const r = D.readIntent('Why is INC0010038 not assigned?');
  assert.equal(r.subject.type, 'incident');
  assert.equal(r.subject.identifier, 'INC0010038');
  assert.equal(r.subject.by, 'number');
  assert.equal(r.symptom.field, 'assigned_to');
  assert.equal(r.symptom.expect, 'empty');
});

test('§26 other task prefixes map to their own tables', () => {
  assert.equal(D.readIntent('look at PRB0000050').subject.type, 'problem');
  assert.equal(D.readIntent('look at CHG0000001').subject.type, 'change_request');
  assert.equal(D.readIntent('look at RITM0000002').subject.type, 'sc_req_item');
});

test('§26 a sys_id is accepted but the table is marked as ASSUMED', () => {
  const r = D.readIntent(`investigate ${INC}`);
  assert.equal(r.subject.by, 'sys_id');
  assert.equal(r.subject.assumedTable, true,
    'a sys_id identifies a row but not a table, and that gap must be visible');
});

test('a complaint that matches no known field still yields a symptom, with no field', () => {
  const r = D.readIntent('Why is INC0010038 behaving oddly?');
  assert.ok(r.ok);
  assert.equal(r.symptom.field, undefined,
    'an unrecognised complaint must not be forced onto a field it may not be about');
  assert.equal(r.symptom.statement, 'Why is INC0010038 behaving oddly?');
});

/* ================================================================== *
 * §41 — THE IMPORT BOUNDARY
 * ================================================================== */

test('§41 the doctor domain imports nothing but its own siblings', () => {
  const dir = new URL('../src/agent/doctor/', import.meta.url);
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/^import[^;]*from\s+'([^']+)'/gm)) {
      const spec = m[1];
      // The shared secret vocabulary is the one deliberate exception, and it is
      // an import of DATA rather than of behaviour.
      if (spec.startsWith('./')) continue;
      if (spec === '../evidence/redact.js') continue;
      offenders.push(`${f} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `the Doctor reaches outside its domain: ${offenders.join(', ')}`);
});

test('§41 the Doctor performs no HTTP, no SQL and no tool execution of its own', () => {
  const dir = new URL('../src/agent/doctor/', import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [/\bfetch\s*\(/, /getDb\s*\(/, /\bprepare\s*\(/, /toolMap/, /executeTool/]) {
      assert.ok(!forbidden.test(code), `${f} contains ${forbidden}`);
    }
  }
});

test('§42 the Doctor adds no second executor, verifier or approval mechanism', () => {
  const dir = new URL('../src/agent/doctor/', import.meta.url);
  const names = [];
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.push(m[1]);
  }
  for (const n of names) {
    assert.ok(!/^doctor(Executor|Verify|Approval|Mutation)/i.test(n), `a parallel system appeared: ${n}`);
    assert.ok(!/^buildEvidence$/.test(n), 'there must remain exactly one evidence projection');
  }
});
