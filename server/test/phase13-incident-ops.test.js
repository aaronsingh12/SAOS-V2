/**
 * PHASE 13 — INCIDENT OPERATIONS, the vertical slice.
 *
 * The question this file answers is not "does the machinery work" — Phases 4-12
 * settled that. It is the narrower and harder one: can a person say
 *
 *     "assign INC0010001 to Abel Tuter"
 *
 * and have that reach the real instance without anything, anywhere, guessing
 * who Abel Tuter is.
 *
 * Two things had to be true and were not:
 *
 *   1. The planner could not SEE the tool that turns a name into an identity.
 *      `lookup_reference` existed, worked, and was claimed by no capability, so
 *      the model was never shown it. The only move left was to put the name
 *      where the sys_id belongs.
 *
 *   2. Putting the name there WORKED. Measured on the live instance: a name
 *      matching one user is silently resolved by the platform; a name matching
 *      none is stored verbatim as a dangling reference and reads back APPLIED.
 *      Every existing gate reports success on a record assigned to nobody.
 *
 * So the tests below are about the seam between those two facts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'p13.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const { CAPABILITIES } = await import('../src/agent/capability-discovery.js');
const { toolMap } = await import('../src/agent/tools.js');
const { _setTableExistsForTests } = await import('../src/servicenow/schema.js');
const { referenceFieldOf, ARTIFACTS } = await import('../src/servicenow/semantic/artifacts.js');
const P = await import('../src/agent/plan/index.js');

const ABEL = 'a'.repeat(32);
const INC = 'b'.repeat(32);

const READ_ONLY = new Set(['record_read', 'reference_resolution']);
const discover = (name) => ({
  capability: name,
  status: 'known',
  available: true,
  mechanism: 'rest',
  mutating: !READ_ONLY.has(name),
  verification: READ_ONLY.has(name) ? 'none' : 'read_back',
  requiresVerification: !READ_ONLY.has(name),
  requiresApproval: !READ_ONLY.has(name),
  requiresElevation: false,
  elevationRole: null,
  scope: null,
  reason: null,
  note: null,
});

const lookupStep = (over = {}) => ({
  id: 'step_1',
  operation: 'resolve the user named Abel Tuter',
  capability: 'reference_resolution',
  tool: 'lookup_reference',
  mechanism: 'rest',
  scope: null,
  mutating: false,
  target: { table: 'sys_user' },
  inputs: { table: 'sys_user', search: 'Abel Tuter', limit: 10 },
  depends_on: [],
  expected_effects: [],
  verification: null,
  ...over,
});

const writeStep = (data, over = {}) => ({
  id: 'step_2',
  operation: 'assign the incident to the resolved user',
  capability: 'record_update',
  tool: 'update_record',
  mechanism: 'rest',
  scope: null,
  mutating: true,
  target: { table: 'incident', sys_id: INC },
  inputs: { table: 'incident', sys_id: INC, data },
  depends_on: ['step_1'],
  expected_effects: ['assigned_to holds the resolved user'],
  verification: { strategy: 'read_back', asserts: ['assigned_to is the resolved user'] },
  ...over,
});

/** A single mutating step with no producer in front of it. */
const soloWrite = (data) => writeStep(data, { depends_on: [] });

const validate = (steps, goal = 'incident operation') => P.validatePlan({ goal, steps }, { discover });
const codes = (v) => [...(v.fatal ?? []), ...(v.warnings ?? [])].map((p) => p.code);

const EXECUTOR_SRC = fs.readFileSync(new URL('../src/agent/plan/executor.js', import.meta.url), 'utf8');

/* ================================================================== *
 * 1. THE CAPABILITY THE SLICE NEEDED
 * ================================================================== */

test('reference_resolution claims lookup_reference, so the planner can see it', () => {
  const cap = CAPABILITIES.reference_resolution;
  assert.ok(cap, 'the capability must exist');
  assert.deepEqual(cap.tools, ['lookup_reference']);
  assert.equal(cap.mutating, false, 'resolving who someone is changes nothing');
  assert.equal(cap.verification, 'none', 'a read has nothing to read back');
});

test('the planner is actually shown it, with what it takes and produces', () => {
  const prompt = P.plannerSystem({
    capabilities: ['record_read', 'reference_resolution', 'record_update']
      .map((c) => ({ capability: c, mechanism: 'rest', verification: CAPABILITIES[c].verification })),
    semantics: null,
  });
  const line = prompt.split('\n').find((l) => l.includes('reference_resolution'));
  assert.ok(line, 'the capability must reach the prompt');
  assert.match(line, /lookup_reference/, 'naming the tool is what made record_read plannable in Phase 8');
  assert.match(line, /produces:.*sys_id/, 'a producer nothing can reference is not usable in a plan');
});

test('exposure is deliberate: create_incident stays unclaimed because record_create covers it', () => {
  const claimed = new Set(Object.values(CAPABILITIES).flatMap((c) => c.tools ?? []));
  assert.ok(toolMap.has('create_incident'), 'the tool exists in the registry');
  assert.ok(!claimed.has('create_incident'),
    'tool existence is not capability availability — a second way to create an incident '
    + 'would be a second path to maintain, and create_record already covers it');
  assert.ok(claimed.has('create_record'), 'the generic path is the exposed one');
});

/* ================================================================== *
 * 2. AMBIGUITY STOPS THE PLAN — the core Phase 13 rule
 * ================================================================== */

const lookupResult = (over = {}) => ({
  table: 'sys_user',
  search: 'Abel Tuter',
  ambiguous: false,
  resolved: { sys_id: ABEL, display: 'Abel Tuter', matchType: 'exact' },
  results: [],
  ...over,
});

test('an UNAMBIGUOUS lookup produces the identity a later step can reference', () => {
  const out = P.extractOutputs('lookup_reference', lookupResult());
  assert.equal(out.sys_id, ABEL);
  assert.equal(out.display, 'Abel Tuter');
});

test('an AMBIGUOUS lookup produces NOTHING — the top guess is not offered', () => {
  const out = P.extractOutputs('lookup_reference', lookupResult({ ambiguous: true }));
  assert.deepEqual(out, {},
    'the resolved field still holds a candidate; withholding it is the point — '
    + 'a plan must not be able to reach the first of several people');
});

test('and a step referencing that withheld output cannot run', () => {
  // `resolveReferences(step, outputsByStep)` takes the map DIRECTLY. Passing it
  // wrapped as { stepOutputs } made this assertion vacuous: the step id was
  // never found, so it reported missing_step_output whether or not the
  // ambiguity guard did anything. The control below proves it is the guard.
  const withheld = P.extractOutputs('lookup_reference', lookupResult({ ambiguous: true }));
  const resolved = P.resolveReferences(
    writeStep({ assigned_to: { $ref: 'step_1.result.sys_id' } }), { step_1: withheld },
  );
  assert.ok(!resolved.ok, 'an ambiguous identity must not become a mutation');
  assert.equal(resolved.problems[0].code, P.RESOLUTION_CODES.MISSING_OUTPUT);

  // THE CONTROL. Same call, same shape, unambiguous lookup: it must resolve.
  // Without this the test above passes for any reason at all.
  const ok = P.resolveReferences(
    writeStep({ assigned_to: { $ref: 'step_1.result.sys_id' } }),
    { step_1: P.extractOutputs('lookup_reference', lookupResult()) },
  );
  assert.ok(ok.ok, 'the same plan with an unambiguous lookup must resolve');
  assert.equal(ok.args.data.assigned_to, ABEL);
});

test('withholding is driven by the producer own verdict, not by inspecting the value', () => {
  const spec = toolMap.get('lookup_reference').outputs.sys_id;
  assert.deepEqual(spec.withheldWhen, { ambiguous: true },
    'a declarative field/value pair — no predicate, no expression, nothing model-supplied');
  assert.deepEqual(spec.path, ['resolved', 'sys_id'],
    'reads the resolved match only; a plan cannot index into the candidate list');
});

/* ================================================================== *
 * 3. A NAME IN A REFERENCE FIELD IS REFUSED
 *
 * The regression test for the defect this phase measured on a live instance.
 * ================================================================== */

test('REGRESSION: a display name written into assigned_to is refused', () => {
  const v = validate([soloWrite({ assigned_to: 'Abel Tuter' })]);
  assert.ok(!v.valid);
  assert.ok(codes(v).includes('reference_field_not_an_identity'), codes(v).join(', '));
});

test('REGRESSION: the same holds for caller_id and assignment_group', () => {
  for (const [field, value] of [['caller_id', 'Fred Luddy'], ['assignment_group', 'Network Support']]) {
    assert.ok(codes(validate([soloWrite({ [field]: value })])).includes('reference_field_not_an_identity'),
      `${field} is a declared reference and must be refused`);
  }
});

test('the refusal names the table the identity must come from', () => {
  const v = validate([soloWrite({ assigned_to: 'Abel Tuter' })]);
  const p = v.fatal.find((x) => x.code === 'reference_field_not_an_identity');
  assert.match(p.message, /sys_user/, 'a person cannot act on "that is wrong" alone');
  assert.match(p.message, /lookup_reference/, 'and it must say what to do instead');
  assert.equal(p.detail.references, 'sys_user');
});

test('a real sys_id is an identity and passes', () => {
  assert.ok(!codes(validate([soloWrite({ assigned_to: ABEL })])).includes('reference_field_not_an_identity'));
});

test('a $ref passes, because it resolves to a sys_id or the step does not run', () => {
  const v = validate([lookupStep(), writeStep({ assigned_to: { $ref: 'step_1.result.sys_id' } })]);
  assert.ok(v.valid, (v.fatal ?? []).map((p) => `${p.code}@${p.step}`).join(', '));
});

test('clearing a reference field is an intention, not a guess', () => {
  assert.ok(!codes(validate([soloWrite({ assigned_to: '' })])).includes('reference_field_not_an_identity'));
});

test('the rule fires only on fields the semantic layer DECLARES as references', () => {
  assert.ok(!codes(validate([soloWrite({ short_description: 'Printer is on fire' })]))
    .includes('reference_field_not_an_identity'),
  'free text is free text; this rule must not become value-sniffing');
});

test('and only where a relationship is declared — it invents nothing', () => {
  assert.equal(referenceFieldOf('incident', 'assigned_to').value.references, 'sys_user');
  assert.equal(referenceFieldOf('incident', 'short_description'), null);
  assert.equal(referenceFieldOf('sys_user', 'manager'), null,
    'sys_user is not a modelled artifact, so nothing is claimed about its fields');
});

test('the answer is sourced from the artifact model, with its evidence', () => {
  const f = referenceFieldOf('incident', 'assignment_group');
  assert.equal(f.source, 'managed_source');
  assert.deepEqual(f.evidence.declared,
    ARTIFACTS.incident.relationships.find((r) => r.field === 'assignment_group'));
});

/* ================================================================== *
 * 4. INCIDENT SEMANTICS — the ledger traps still bite
 * ================================================================== */

test('priority is still refused as a computed field', () => {
  const v = validate([soloWrite({ priority: '1' })]);
  assert.ok(!v.valid);
  assert.ok(codes(v).includes('writes_derived_field'), codes(v).join(', '));
});

test('impact and urgency — the fields that actually drive priority — are writable', () => {
  assert.ok(validate([soloWrite({ impact: '1', urgency: '1' })]).valid);
});

test('state and work_notes are ordinary writes', () => {
  assert.ok(validate([soloWrite({ state: '2', work_notes: 'Investigating.' })]).valid);
});

/* ================================================================== *
 * 5. THE APPROVAL CARD DESCRIBES THE OPERATION, not just the arguments
 * ================================================================== */

test('the card carries operation, target and the verification that will follow', () => {
  const at = EXECUTOR_SRC.indexOf('name: step.tool ?? step.operation');
  assert.ok(at > 0, 'the approval card payload must still be here');
  const card = EXECUTOR_SRC.slice(at, at + 1600);
  for (const field of ['operation:', 'target:', 'verification:', 'expectedEffects:']) {
    assert.ok(card.includes(field), `the approval card must carry ${field}`);
  }
});

test('every card field is read from the step, never recomputed after fingerprinting', () => {
  const at = EXECUTOR_SRC.indexOf('operation: step.operation');
  assert.ok(at > 0);
  const card = EXECUTOR_SRC.slice(at, at + 500);
  assert.ok(!/canonicalExecutionArgs|generatePlan|await /.test(card),
    'the card must describe the approved step, not derive a new one');
});

/* ================================================================== *
 * 6. ARCHITECTURE — composition, not a second system
 * ================================================================== */

test('Phase 13 added no second planner, executor or validator', () => {
  const files = fs.readdirSync(new URL('../src/agent/plan/', import.meta.url));
  assert.deepEqual(files.filter((f) => /planner|executor|validator/.test(f)).sort(),
    ['executor.js', 'planner.js', 'validator.js']);
});

test('the new rule lives in the existing semantic pass, not a new gate', () => {
  const src = fs.readFileSync(new URL('../src/agent/plan/validator.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function validateSemantics'));
  assert.ok(fn.slice(0, fn.indexOf('\n}')).includes('reference_field_not_an_identity'),
    'it must be part of validateSemantics, which validatePlan already runs');
});

test('the semantic accessor introduces no import cycle', () => {
  const artifacts = fs.readFileSync(new URL('../src/servicenow/semantic/artifacts.js', import.meta.url), 'utf8');
  const tables = fs.readFileSync(new URL('../src/servicenow/semantic/tables.js', import.meta.url), 'utf8');
  assert.ok(artifacts.includes("from './tables.js'"));
  assert.ok(!tables.includes("from './artifacts.js'"),
    'artifacts already depends on tables; the reverse edge would close a cycle');
});

/* ================================================================== *
 * 7. AN ARGUMENT THE TOOL DOES NOT TAKE
 *
 * Both shapes below came from the real model against the real instance.
 * ================================================================== */

test('REGRESSION: query_records with "filter" instead of "query" is refused', () => {
  const step = {
    id: 'step_1', operation: 'find the incident', capability: 'record_read', tool: 'query_records',
    mechanism: 'rest', scope: null, mutating: false, target: { table: 'incident' },
    inputs: { table: 'incident', filter: 'number=INC0010031' },
    depends_on: [], expected_effects: [], verification: null,
  };
  const v = validate([step]);
  assert.ok(!v.valid);
  const p = v.fatal.find((x) => x.code === 'undeclared_inputs');
  assert.ok(p, codes(v).join(', '));
  assert.deepEqual(p.detail.undeclared, ['filter']);
  assert.match(p.message, /"query"/, 'the refusal must name what the tool does take');
});

test('REGRESSION: query_records treats absent optional tables as empty reads', async () => {
  _setTableExistsForTests(async (table) => table !== 'contract_sla_milestone');
  try {
    const rows = await toolMap.get('query_records').execute({ table: 'contract_sla_milestone', limit: 1 });
    assert.deepEqual(rows, []);
    assert.equal(rows._meta.status, 'TABLE_UNAVAILABLE');
    assert.equal(rows._meta.table, 'contract_sla_milestone');
  } finally {
    _setTableExistsForTests(null);
  }
});

test('REGRESSION: lookup_reference with "display" instead of "search" is refused', () => {
  const v = validate([lookupStep({ inputs: { table: 'sys_user', display: 'Abel Tuter' } })]);
  assert.ok(!v.valid);
  assert.deepEqual(v.fatal.find((x) => x.code === 'undeclared_inputs').detail.undeclared, ['display']);
});

test('why it matters: the dropped argument turns one record into all of them', () => {
  // `query_records` destructures `query`; `filter` never reaches it, so the
  // read runs unfiltered — and its declared sys_id output is taken from the
  // first row, which a later step would then mutate.
  const schema = toolMap.get('query_records').inputSchema;
  assert.ok(!('filter' in schema.properties), 'fixture drifted: filter is now declared');
  assert.ok('query' in schema.properties);
  assert.equal(toolMap.get('query_records').outputs.sys_id.fromFirstRow, true,
    'this is what makes a silently unfiltered read dangerous rather than merely wrong');
});

test('declared arguments pass, and object contents are not policed', () => {
  const v = validate([soloWrite({ short_description: 'x', anything_at_all: 'y' })]);
  assert.ok(!codes(v).includes('undeclared_inputs'),
    'data carries a record payload; this layer has no basis for judging its fields');
});

test('the planner is shown every argument, with the required ones starred', () => {
  const prompt = P.plannerSystem({
    capabilities: [{ capability: 'reference_resolution', mechanism: 'rest', verification: 'none' }],
    semantics: null,
  });
  const line = prompt.split('\n').find((l) => l.includes('reference_resolution'));
  assert.match(line, /takes: table\*, search, limit/,
    'the optional arguments are exactly the ones it was guessing');
});

test('a capability with two tools shows them separately, never merged', () => {
  const prompt = P.plannerSystem({
    capabilities: [{ capability: 'record_read', mechanism: 'rest', verification: 'none' }],
    semantics: null,
  });
  const line = prompt.split('\n').find((l) => l.includes('record_read'));
  assert.match(line, /query_records\(/);
  assert.match(line, /get_record\(/);
  assert.ok(!/takes: table\*, query, fields, limit, order_by_desc, sys_id\*/.test(line),
    'a union would claim every read requires a sys_id and may take a query — false for both tools');
});

/* ================================================================== *
 * 8. A STEP THAT PROMISES NOTHING CANNOT BE VERIFIED
 * ================================================================== */

test('REGRESSION: a mutating step with no expected_effects is refused', () => {
  const v = validate([soloWrite({ short_description: 'x' })].map((s) => ({ ...s, expected_effects: [] })));
  assert.ok(!v.valid);
  assert.ok(codes(v).includes('no_expected_effects'), codes(v).join(', '));
});

test('a READ step promises nothing and that is fine', () => {
  assert.ok(!codes(validate([lookupStep()])).includes('no_expected_effects'),
    'a read changes nothing, so there is nothing to promise');
});

test('the existing coverage rule still holds on top of it', () => {
  const twoEffects = soloWrite({ short_description: 'x' });
  twoEffects.expected_effects = ['a', 'b'];
  twoEffects.verification = { strategy: 'read_back', asserts: ['a'] };
  assert.ok(codes(validate([twoEffects])).includes('effects_partially_asserted'));
});

test('the planner is told effects are required, and why', () => {
  const prompt = P.plannerSystem({ capabilities: [], semantics: null });
  assert.match(prompt, /REQUIRED and non-empty on every mutating step/);
  assert.match(prompt, /promises none/, 'the rule block must state it too, since that is what is checked');
});
