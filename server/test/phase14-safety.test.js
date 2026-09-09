/**
 * PHASE 14 — THE RELEASE BLOCKERS.
 *
 * §55 lists fifteen conditions that block the phase. The three this file exists
 * for are the ones a diagnostic capability introduces and nothing before it
 * could have caught:
 *
 *   1. The Doctor mutates in diagnose mode.
 *   2. A model-generated claim is stored or presented as FACT.
 *   3. The Doctor claims a root cause the evidence does not establish.
 *
 * Each is tested against PLATFORM CODE rather than against prompt text. A test
 * that showed the prompt says "do not mutate" would prove nothing: §32 is
 * explicit that enforcement must not depend on instructions, and a model that
 * ignores them is precisely the case being defended against.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p14s-')), 'p.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const P = await import('../src/agent/plan/index.js');
const D = await import('../src/agent/doctor/index.js');
const { toolMap } = await import('../src/agent/tools.js');
const { CAPABILITIES } = await import('../src/agent/capability-discovery.js');

const SYS = 'a'.repeat(32);

const discover = (name) => {
  const cap = CAPABILITIES[name] ?? { mutating: false, verification: 'none' };
  return {
    capability: name, status: 'known', available: true, mechanism: 'rest',
    mutating: cap.mutating, verification: cap.verification,
    requiresVerification: cap.mutating, requiresApproval: cap.mutating,
    requiresElevation: false, elevationRole: null, scope: null, reason: null, note: null,
  };
};

const readStep = (id, over = {}) => ({
  id, operation: 'read the incident', capability: 'record_read', tool: 'get_record',
  mechanism: 'rest', scope: null, mutating: false,
  target: { table: 'incident' }, inputs: { table: 'incident', sys_id: SYS },
  depends_on: [], expected_effects: [], verification: null, ...over,
});

const writeStep = (id, tool, capability, over = {}) => ({
  id, operation: 'change it', capability, tool, mechanism: 'rest', scope: null,
  mutating: true, target: { table: 'incident' },
  inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'x' } },
  depends_on: [], expected_effects: ['short_description changes'],
  verification: { strategy: 'read_back', asserts: ['short_description == x'] }, ...over,
});

const validateRO = (steps) =>
  P.validatePlan({ goal: 'investigate', steps }, { discover, readOnly: true });

/* ================================================================== *
 * §55.1 / §32 — THE DOCTOR CANNOT MUTATE IN DIAGNOSE MODE
 * ================================================================== */

test('§32 every mutating tool named in the specification is refused', () => {
  const cases = [
    ['update_record', 'record_update'],
    ['create_record', 'record_create'],
    ['delete_record', 'record_delete'],
  ];
  for (const [tool, capability] of cases) {
    const v = validateRO([readStep('step_1'), writeStep('step_2', tool, capability)]);
    assert.ok(!v.valid, `${tool} was accepted into a read-only plan`);
    assert.ok(v.fatal.some((p) => p.code === 'mutation_in_read_only_plan'),
      `${tool}: ${v.fatal.map((p) => p.code).join(', ')}`);
  }
});

test('§32 EVERY mutating tool in the registry is refused, not just the named ones', () => {
  /*
   * The specification lists seven verbs. The registry holds thirty mutating
   * tools, and a guard that covered only the listed ones would be a guard
   * against the examples rather than against mutation.
   */
  const mutating = [...toolMap.values()].filter((t) => t.mutating);
  assert.ok(mutating.length >= 20, `expected the registry to hold many mutating tools, saw ${mutating.length}`);

  const escaped = [];
  for (const tool of mutating) {
    const violations = P.mutatingSteps({ steps: [{ id: 'step_1', tool: tool.name, capability: 'record_read' }] });
    if (!violations.length) escaped.push(tool.name);
  }
  assert.deepEqual(escaped, [], `these mutating tools were not caught: ${escaped.join(', ')}`);
});

test('§32 the refusal reads the REGISTRY, not the step\'s own claim', () => {
  // The step lies: it says it does not mutate. The registry says otherwise.
  const liar = writeStep('step_1', 'update_record', 'record_update', { mutating: false });
  const v = validateRO([liar]);
  assert.ok(!v.valid, 'a step that declares mutating:false was believed');
  const p = v.fatal.find((x) => x.code === 'mutation_in_read_only_plan');
  assert.equal(p.detail.reason, 'registry_says_mutating');
});

test('§32 a tool that is not in the registry cannot be shown to be read-only, so it is refused', () => {
  const v = validateRO([readStep('step_1', { tool: 'doctor_quietly_writes' })]);
  assert.ok(!v.valid);
  assert.ok(v.fatal.some((p) => p.code === 'mutation_in_read_only_plan'
    && p.detail.reason === 'unknown_tool'));
});

test('§32 a mutating CAPABILITY is refused even when its tool is not mutating', () => {
  const v = validateRO([readStep('step_1', { capability: 'record_update' })]);
  assert.ok(!v.valid, 'a read tool under a mutating capability slipped through');
});

test('a genuine read-only investigation is accepted', () => {
  const v = validateRO([
    readStep('step_1'),
    readStep('step_2', {
      capability: 'reference_resolution', tool: 'lookup_reference',
      inputs: { table: 'sys_user', search: 'Abel Tuter' }, target: { table: 'sys_user' },
    }),
  ]);
  assert.ok(v.valid, (v.fatal ?? []).map((p) => `${p.code}@${p.step}`).join(', '));
});

test('the gate is OFF by default — every existing caller is unaffected', () => {
  const v = P.validatePlan({ goal: 'remediate', steps: [writeStep('step_1', 'update_record', 'record_update')] },
    { discover });
  assert.ok(!v.problems.some((p) => p.code === 'mutation_in_read_only_plan'),
    'the read-only rule fired where nobody asked for it');
});

test('assertReadOnly THROWS rather than returning a flag a caller could ignore', () => {
  const plan = { steps: [writeStep('step_1', 'update_record', 'record_update')] };
  assert.throws(
    () => D.assertReadOnly(plan, { violations: P.mutatingSteps }),
    (err) => err.code === D.STOP_REASONS.MUTATION_IN_DIAGNOSE && err.violations.length === 1,
  );
  assert.equal(D.assertReadOnly({ steps: [readStep('step_1')] }, { violations: P.mutatingSteps }), true);
});

/* ================================================================== *
 * §55.2 / §29 — A MODEL CLAIM CANNOT BECOME A FACT
 * ================================================================== */

test('§29 tool output creates facts, and they carry provenance', () => {
  const facts = D.factsFrom([{
    id: 'step_1', tool: 'get_record', state: 'completed', inputs: { table: 'incident' },
    result: { sys_id: { value: SYS }, number: { value: 'INC0000039' }, assigned_to: { value: '' } },
  }]);
  assert.ok(facts.length >= 3);
  for (const f of facts) {
    assert.equal(f.type, D.CLAIM_TYPES.FACT);
    assert.equal(f.source.step, 'step_1');
    assert.equal(f.source.tool, 'get_record');
    assert.ok(D.isFact(f));
  }
});

test('§29 model prose CANNOT become a fact — indexing it throws', () => {
  const prose = {
    type: D.CLAIM_TYPES.FACT,
    id: 'fact_made_up',
    statement: 'The assignment workflow failed at 10:14.',
    field: 'workflow', value: 'failed',
    /* no source: there is no step and no tool, because nothing read this */
  };
  assert.ok(!D.isFact(prose), 'a statement without provenance passed isFact');
  assert.throws(() => D.indexFacts([prose]), /refusing to index a non-fact/);
});

test('§29 provenance naming only a tool is not provenance', () => {
  const halfway = {
    type: D.CLAIM_TYPES.FACT, id: 'f', statement: 's', field: 'x', value: 1,
    source: { tool: 'get_record' },      // which read? of what? unanswerable
  };
  assert.ok(!D.isFact(halfway));
});

test('§29 an INFERENCE can never be stored as a FACT', () => {
  const inference = {
    id: 'hyp_1', type: D.CLAIM_TYPES.INFERENCE, statement: 'It may be stuck.',
    confidence: 'medium', supporting_facts: ['fact_step_1_assigned_to'],
  };
  assert.ok(D.isInference(inference));
  assert.ok(!D.isFact(inference), 'an inference satisfied the fact predicate');
  assert.throws(() => D.indexFacts([inference]));
});

test('§29 a citation naming a fact that does not exist is stripped AND counted', () => {
  const facts = D.factsFrom([{
    id: 'step_1', tool: 'get_record', state: 'completed', inputs: { table: 'incident' },
    result: { assigned_to: { value: '' } },
  }]);
  const byId = D.indexFacts(facts);
  const { kept, invented } = D.checkCitations(['fact_step_1_assigned_to', 'fact_workflow_failed'], byId);
  assert.deepEqual(kept, ['fact_step_1_assigned_to']);
  assert.deepEqual(invented, ['fact_workflow_failed'],
    'a fabricated citation must be countable, not silently dropped');
});

test('§29 facts are generated mechanically, so the analyst cannot choose what counts', () => {
  const src = fs.readFileSync(new URL('../src/agent/doctor/evidence.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
  // Asserted on the IMPORT GRAPH, not on word frequency: prose about models is
  // fine, a path to one is not.
  assert.deepEqual(imports.filter((i) => /provider|chat|llm|openai|ollama/i.test(i)), [],
    `the fact producer reaches a model: ${imports.join(', ')}`);
  assert.ok(!/chat\s*\(|chatOnce|chatTurn/.test(src), 'the fact producer must not call a model');
});

/* ================================================================== *
 * §55.3 / §24 — NO UNSUPPORTED ROOT CAUSE
 * ================================================================== */

test('§24 the model cannot set the cause label — it is looked up from the outcome', () => {
  for (const outcome of D.OUTCOME_LIST) {
    assert.ok(D.CAUSE_LABELS[outcome], `${outcome} has no label`);
  }
  assert.equal(D.CAUSE_LABELS[D.OUTCOMES.ROOT_CAUSE_ESTABLISHED], 'ROOT CAUSE');
  assert.equal(D.CAUSE_LABELS[D.OUTCOMES.INSUFFICIENT_EVIDENCE], 'ROOT CAUSE NOT ESTABLISHED');
  assert.equal(D.CAUSE_LABELS[D.OUTCOMES.MULTIPLE_PLAUSIBLE_CAUSES], 'ROOT CAUSE NOT ESTABLISHED');
});

test('§24 a hypothesis claiming high confidence with no evidence is demoted', () => {
  const [adj] = D.adjudicate([{
    id: 'hyp_1', statement: 'The workflow failed.',
    evidence_for: [], evidence_against: [], missing_evidence: [],
    claimed_confidence: 'high', claimed_status: 'supported',
  }]);
  assert.equal(adj.confidence, 'low');
  assert.equal(adj.status, 'unknown');
  assert.equal(adj.overstated, true, 'the gap between claim and evidence must be recorded');
});

test('§24 an explanation whose only evidence is the symptom cannot exceed POSSIBLE CAUSE', () => {
  const symptomFactIds = ['fact_step_1_assigned_to'];
  const [adj] = D.adjudicate([{
    id: 'hyp_1', statement: 'The assignment workflow failed.',
    evidence_for: symptomFactIds, evidence_against: [], missing_evidence: [],
  }], { symptomFactIds });
  const verdict = D.classify({ hypotheses: [adj], completedReads: 1, symptomConfirmed: true });
  assert.equal(verdict.outcome, D.OUTCOMES.POSSIBLE_CAUSE);
  assert.equal(verdict.label, 'POSSIBLE CAUSE');
});

test('§24 an admitted UNKNOWN prevents an established root cause', () => {
  const hyps = D.adjudicate([{
    id: 'hyp_1', statement: 'Unclaimed in the group queue.',
    evidence_for: ['f1', 'f2', 'f3'], evidence_against: [], missing_evidence: [],
  }]);
  assert.equal(D.classify({ hypotheses: hyps, completedReads: 3, unknownCount: 0 }).outcome,
    D.OUTCOMES.ROOT_CAUSE_ESTABLISHED);
  assert.equal(D.classify({ hypotheses: hyps, completedReads: 3, unknownCount: 1 }).outcome,
    D.OUTCOMES.LIKELY_CAUSE_IDENTIFIED,
    'a run that admits it could not read something must not claim the cause is established');
});

test('§24 contradiction outranks support, however much support there is', () => {
  const [adj] = D.adjudicate([{
    id: 'hyp_1', statement: 'The workflow failed.',
    evidence_for: ['f1', 'f2', 'f3', 'f4', 'f5'],
    evidence_against: ['f6'], missing_evidence: [],
  }]);
  assert.equal(adj.support_level, 'weak');
  assert.equal(adj.status, 'plausible', 'contested evidence must not read as supported');
});

/* ================================================================== *
 * §52 — SECRETS NEVER REACH DIAGNOSTIC EVIDENCE
 * ================================================================== */

test('§52 the diagnosis section uses the EXISTING redactor, not one of its own', () => {
  const builder = fs.readFileSync(new URL('../src/agent/evidence/builder.js', import.meta.url), 'utf8');
  const section = builder.slice(builder.indexOf('function diagnosisSection'));
  const body = section.slice(0, section.indexOf('\n}\n'));
  assert.ok(body.includes('redact('), 'the diagnosis section must redact');
  const doctorFiles = fs.readdirSync(new URL('../src/agent/doctor/', import.meta.url));
  for (const f of doctorFiles) {
    const src = fs.readFileSync(new URL(`../src/agent/doctor/${f}`, import.meta.url), 'utf8');
    assert.ok(!/function\s+redact|const\s+REDACTED/.test(src), `${f} defines a second redactor`);
    // Using the shared vocabulary is required; RESTATING it is the defect.
    assert.ok(!/SECRET_KEYS\s*=/.test(src), `${f} restates the secret list instead of importing it`);
  }
  const ev = fs.readFileSync(new URL('../src/agent/doctor/evidence.js', import.meta.url), 'utf8');
  assert.match(ev, /import \{ SECRET_KEYS \} from '\.\.\/evidence\/redact\.js'/,
    'the Doctor must share the redactor secret vocabulary rather than keep its own');
});

test('§52 REGRESSION: a secret field never becomes a fact, so it cannot leak in prose', () => {
  /*
   * The key-based redactor cannot save us here. A fact's statement is a SENTENCE
   * containing the value — "sys_user X has password = hunter2." — and `redact`
   * scanning that object sees the key `statement`, which is not a secret name,
   * and passes it through whole. Verified below. The defence is therefore to
   * never compose the sentence.
   */
  const step = {
    id: 'step_1', tool: 'get_record', state: 'completed', inputs: { table: 'sys_user' },
    result: {
      sys_id: { value: SYS },
      user_name: { value: 'abel.tuter' },
      password: { value: 'hunter2' },
      user_password: { value: 'hunter3' },
      api_token: { value: 'tok_live_xyz' },
    },
  };
  const facts = D.factsFrom(step ? [step] : []);
  const dump = JSON.stringify(facts);
  for (const secret of ['hunter2', 'hunter3', 'tok_live_xyz']) {
    assert.ok(!dump.includes(secret), `a secret reached the fact set: ${secret}`);
  }
  assert.ok(facts.some((f) => f.field === 'user_name'), 'ordinary fields must still be observed');
  assert.deepEqual(D.observationsFrom([step])[0].records[0].fields.password, undefined,
    'the normalised observations must drop it too');
});

test('§52 the two defences are independent, and BOTH now hold', async () => {
  /*
   * This canary was written in Phase 14 asserting the opposite: that the
   * redactor could NOT reach a secret inside prose, which is why facts are
   * never composed from a secret field in the first place.
   *
   * Phase 15 made it fire. Putting flow errors and journal text into evidence
   * meant free text could name a credential directly (`password=hunter2` in an
   * error message), so `redactString` gained a key-based rule for exactly that
   * shape. The Phase 14 defence is NOT now redundant — it stops the value being
   * written down at all, which is stronger than masking it afterwards — so both
   * are asserted here and either failing is a regression.
   */
  const { redact } = await import('../src/agent/evidence/redact.js');

  // Defence 1 (Phase 15): a secret NAMED in free text is masked.
  assert.ok(!JSON.stringify(redact({ statement: 'sys_user X has password = hunter2.' })).includes('hunter2'),
    'the free-text rule stopped working');

  // Defence 2 (Phase 14): a secret field never becomes a fact, so there is
  // nothing to mask. This still covers the case the rule above cannot see —
  // a bare value with no key naming it anywhere in the sentence.
  const facts = D.factsFrom([{
    id: 'step_1', tool: 'get_record', state: 'completed', inputs: { table: 'sys_user' },
    result: { sys_id: { value: SYS }, password: { value: 'nokeyinsight' } },
  }]);
  assert.ok(!JSON.stringify(facts).includes('nokeyinsight'),
    'a secret field must still never become a fact');
});
