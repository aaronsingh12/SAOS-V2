/**
 * PHASE 14 — INFERENCE AND CLASSIFICATION.
 *
 * §30 and §31. The subject here is the arithmetic that decides what a run is
 * allowed to say, tested directly rather than through a model — the whole
 * point of making it deterministic is that it can be.
 *
 * The ladder under test:
 *
 *   strong evidence      -> ROOT_CAUSE_ESTABLISHED
 *   moderate evidence    -> LIKELY_CAUSE_IDENTIFIED
 *   weak evidence        -> POSSIBLE_CAUSE
 *   conflicting evidence -> MULTIPLE_PLAUSIBLE_CAUSES
 *   missing evidence     -> INSUFFICIENT_EVIDENCE
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const D = await import('../src/agent/doctor/diagnosis.js');
const H = await import('../src/agent/doctor/hypotheses.js');
const E = await import('../src/agent/doctor/evidence.js');
const S = await import('../src/agent/doctor/schemas.js');

/** A hypothesis with the given evidence counts and nothing else of interest. */
const hyp = (evidence_for, evidence_against = [], missing_evidence = [], over = {}) => ({
  id: 'hyp_1', statement: 'an explanation', evidence_for, evidence_against, missing_evidence, ...over,
});

const verdict = (hypotheses, extra = {}) =>
  D.classify({ hypotheses: D.adjudicate(hypotheses, extra), completedReads: 3, ...extra });

/* ================================================================== *
 * §31 — THE LADDER
 * ================================================================== */

test('§31 strong evidence establishes a root cause', () => {
  assert.equal(verdict([hyp(['f1', 'f2'])]).outcome, S.OUTCOMES.ROOT_CAUSE_ESTABLISHED);
});

test('§31 moderate evidence identifies a likely cause', () => {
  assert.equal(verdict([hyp(['f1'], [], ['one open question'])]).outcome,
    S.OUTCOMES.LIKELY_CAUSE_IDENTIFIED);
});

test('§31 weak evidence yields a possible cause only', () => {
  assert.equal(verdict([hyp(['f1'], ['f2'])]).outcome, S.OUTCOMES.POSSIBLE_CAUSE);
});

test('§31 conflicting explanations yield MULTIPLE_PLAUSIBLE_CAUSES', () => {
  const two = [hyp(['f1', 'f2']), { ...hyp(['f3', 'f4']), id: 'hyp_2' }];
  assert.equal(verdict(two).outcome, S.OUTCOMES.MULTIPLE_PLAUSIBLE_CAUSES);
});

test('§31 missing evidence yields INSUFFICIENT_EVIDENCE', () => {
  assert.equal(verdict([hyp([])]).outcome, S.OUTCOMES.INSUFFICIENT_EVIDENCE);
  assert.equal(verdict([]).outcome, S.OUTCOMES.INSUFFICIENT_EVIDENCE);
});

test('§25 every outcome is distinct and has its own label', () => {
  assert.equal(new Set(S.OUTCOME_LIST).size, S.OUTCOME_LIST.length);
  const labels = S.OUTCOME_LIST.map((o) => S.CAUSE_LABELS[o]);
  assert.ok(labels.every(Boolean), 'an outcome has no label');
  assert.equal(S.CAUSE_LABELS[S.OUTCOMES.NO_PROBLEM_FOUND], 'NO PROBLEM FOUND');
});

test('NO_PROBLEM_FOUND requires the symptom to have been CHECKED and absent', () => {
  const supported = [hyp(['f1', 'f2'])];
  const checked = { symptomCheckedDeterministically: true };
  assert.equal(verdict(supported, { ...checked, symptomConfirmed: false }).outcome,
    S.OUTCOMES.NO_PROBLEM_FOUND);
  // null means nobody could check. It must NOT collapse into "no problem".
  assert.notEqual(verdict(supported, { ...checked, symptomConfirmed: null }).outcome,
    S.OUTCOMES.NO_PROBLEM_FOUND);
});

test('INVESTIGATION_BLOCKED when nothing was read, whatever was hypothesised', () => {
  assert.equal(D.classify({ hypotheses: D.adjudicate([hyp(['f1', 'f2'])]), completedReads: 0 }).outcome,
    S.OUTCOMES.INVESTIGATION_BLOCKED);
  assert.equal(D.classify({
    hypotheses: [], completedReads: 3, stopReason: S.STOP_REASONS.MISSING_CAPABILITY,
  }).outcome, S.OUTCOMES.INVESTIGATION_BLOCKED);
});

/* ================================================================== *
 * §30 — INFERENCE
 * ================================================================== */

test('§30 a fact supports an inference, and the inference cites it', () => {
  const [adj] = D.adjudicate([hyp(['fact_step_1_assigned_to', 'fact_step_1_state'])]);
  assert.equal(adj.status, S.HYPOTHESIS_STATUS.SUPPORTED);
  assert.deepEqual(adj.evidence_for, ['fact_step_1_assigned_to', 'fact_step_1_state']);
});

test('§30 an UNSUPPORTED inference becomes unknown, never a fact', () => {
  const [adj] = D.adjudicate([hyp([])]);
  assert.equal(adj.status, S.HYPOTHESIS_STATUS.UNKNOWN);
  assert.equal(adj.support_level, S.SUPPORT_LEVEL.INSUFFICIENT);
  assert.ok(!S.isFact(adj), 'an unsupported inference must not satisfy the fact predicate');
});

test('§30 evidence AGAINST with no support rejects the hypothesis outright', () => {
  const [adj] = D.adjudicate([hyp([], ['fact_flow_completed'])]);
  assert.equal(adj.status, S.HYPOTHESIS_STATUS.REJECTED);
});

test('§30 a rejected hypothesis is excluded from the outcome', () => {
  const hyps = [
    { ...hyp([], ['f_against']), id: 'hyp_1' },
    { ...hyp(['f1', 'f2']), id: 'hyp_2' },
  ];
  const v = verdict(hyps);
  assert.equal(v.outcome, S.OUTCOMES.ROOT_CAUSE_ESTABLISHED,
    'a rejected rival must not make the field look crowded');
});

test('§30 conflicting facts leave a hypothesis plausible, never supported', () => {
  const [adj] = D.adjudicate([hyp(['f1', 'f2', 'f3'], ['f4'])]);
  assert.equal(adj.status, S.HYPOTHESIS_STATUS.PLAUSIBLE);
  assert.equal(adj.confidence, S.CONFIDENCE.LOW);
});

test('§30 missing evidence is recorded on the hypothesis and lowers it', () => {
  const strong = D.adjudicate([hyp(['f1', 'f2'])])[0];
  const gapped = D.adjudicate([hyp(['f1', 'f2'], [], ['what the automation did'])])[0];
  assert.equal(strong.support_level, S.SUPPORT_LEVEL.STRONG);
  assert.equal(gapped.support_level, S.SUPPORT_LEVEL.MODERATE,
    'an admitted gap must cost the hypothesis a rung');
  assert.deepEqual(gapped.missing_evidence, ['what the automation did']);
});

/* ================================================================== *
 * CONFIDENCE DESCRIBES EVIDENCE, NOT FEELING
 * ================================================================== */

test('§8 confidence is one of three words, never a number', () => {
  assert.deepEqual(S.CONFIDENCE_LIST, ['low', 'medium', 'high']);
  for (const h of [hyp(['a', 'b']), hyp(['a'], [], ['g']), hyp(['a'], ['b'])]) {
    assert.ok(S.CONFIDENCE_LIST.includes(D.confidenceOf(h)));
  }
});

test('§8 a numeric confidence from the analyst is discarded, not rounded', () => {
  const byId = new Map([['f1', {}]]);
  const { hypotheses } = H.sanitiseAnalysis({
    hypotheses: [{ statement: 's', evidence_for: ['f1'], evidence_against: [], missing_evidence: [], confidence: 0.97 }],
  }, byId);
  assert.equal(hypotheses[0].claimed_confidence, null, '0.97 must not survive as a confidence');
  assert.ok(S.CONFIDENCE_LIST.includes(hypotheses[0].confidence));
});

/* ================================================================== *
 * SYMPTOM CHECKING IS ARITHMETIC ON FACTS
 * ================================================================== */

const factsFor = (fields) => E.factsFrom([{
  id: 'step_1', tool: 'get_record', state: 'completed', inputs: { table: 'incident' },
  result: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v }])),
}]);

test('the symptom is evaluated against facts, not asserted by the analyst', () => {
  const unassigned = factsFor({ sys_id: 'a'.repeat(32), assigned_to: '' });
  const assigned = factsFor({ sys_id: 'a'.repeat(32), assigned_to: 'b'.repeat(32) });
  assert.equal(D.checkSymptom({ field: 'assigned_to', expect: 'empty' }, unassigned), true);
  assert.equal(D.checkSymptom({ field: 'assigned_to', expect: 'empty' }, assigned), false);
});

test('a symptom about a field nobody read is UNKNOWN, not false', () => {
  const facts = factsFor({ sys_id: 'a'.repeat(32) });
  assert.equal(D.checkSymptom({ field: 'assigned_to', expect: 'empty' }, facts), null,
    'no fact addresses the field, so the answer is "nobody knows"');
});

test('symptomFactIdsOf finds the facts that ARE the symptom', () => {
  const facts = factsFor({ sys_id: 'a'.repeat(32), assigned_to: '', state: '1' });
  assert.deepEqual(D.symptomFactIdsOf({ field: 'assigned_to' }, facts), ['fact_step_1_assigned_to']);
  assert.deepEqual(D.symptomFactIdsOf({ field: null }, facts), []);
});

/* ================================================================== *
 * THE CONCLUSION OBJECT
 * ================================================================== */

test('§9 root_cause is true only for ROOT_CAUSE_ESTABLISHED', () => {
  for (const outcome of S.OUTCOME_LIST) {
    const c = D.conclusionFrom({ outcome, label: S.CAUSE_LABELS[outcome], reason: 'r' });
    assert.equal(c.root_cause, outcome === S.OUTCOMES.ROOT_CAUSE_ESTABLISHED, outcome);
    assert.ok(S.isConclusion(c), `${outcome} produced a malformed conclusion`);
  }
});

test('§9 the conclusion cannot be flagged root_cause while labelled something weaker', () => {
  const c = D.conclusionFrom({
    outcome: S.OUTCOMES.LIKELY_CAUSE_IDENTIFIED,
    label: S.CAUSE_LABELS[S.OUTCOMES.LIKELY_CAUSE_IDENTIFIED],
    reason: 'r',
  });
  assert.equal(c.root_cause, false);
  assert.equal(c.label, 'LIKELY CAUSE');
  assert.equal(c.support_level, S.SUPPORT_LEVEL.MODERATE);
});

test('§9 "insufficient evidence" is a supported OUTCOME, not an error', () => {
  const v = verdict([]);
  const c = D.conclusionFrom(v);
  assert.equal(v.outcome, S.OUTCOMES.INSUFFICIENT_EVIDENCE);
  assert.equal(c.support_level, S.SUPPORT_LEVEL.INSUFFICIENT);
  assert.ok(c.statement.length > 0, 'it must still say something to the reader');
});

/* ================================================================== *
 * THE ANALYST'S OUTPUT IS SANITISED BEFORE IT COUNTS
 * ================================================================== */

test('a hypothesis with no statement is dropped entirely', () => {
  const byId = new Map([['f1', {}]]);
  const { hypotheses } = H.sanitiseAnalysis({
    hypotheses: [{ statement: '   ', evidence_for: ['f1'] }, { statement: 'real', evidence_for: ['f1'] }],
  }, byId);
  assert.equal(hypotheses.length, 1);
  assert.equal(hypotheses[0].statement, 'real');
});

test('unknowns must say WHY, or they are dropped', () => {
  const byId = new Map();
  const { unknowns } = H.sanitiseAnalysis({
    unknowns: [{ statement: 'no workflow evidence' }, { statement: 'no SLA read', reason: 'no tool exposes it' }],
  }, byId);
  assert.equal(unknowns.length, 1);
  assert.equal(unknowns[0].reason, 'no tool exposes it');
  assert.ok(S.isUnknown(unknowns[0]));
});

test('the analyst cannot flood the report with hypotheses', () => {
  const byId = new Map([['f1', {}]]);
  const many = Array.from({ length: 50 }, (_, i) => ({
    statement: `guess ${i}`, evidence_for: ['f1'], evidence_against: [], missing_evidence: [],
  }));
  const { hypotheses } = H.sanitiseAnalysis({ hypotheses: many }, byId);
  assert.equal(hypotheses.length, H.MAX_HYPOTHESES);
});

test('a non-JSON analyst response is a reported failure, not a silent empty diagnosis', () => {
  assert.equal(H.extractAnalysisJson('I think the workflow broke.').ok, false);
  assert.equal(H.extractAnalysisJson('```json\n{"hypotheses":[]}\n```').ok, true);
  assert.equal(H.extractAnalysisJson('{"hypotheses":[]}').ok, true);
});

test('REGRESSION: only a deterministic symptom check may conclude NO_PROBLEM_FOUND', () => {
  const supported = D.adjudicate([hyp(['f1', 'f2'])]);
  const base = { hypotheses: supported, completedReads: 3, symptomConfirmed: false };
  assert.equal(D.classify({ ...base, symptomCheckedDeterministically: true }).outcome,
    S.OUTCOMES.NO_PROBLEM_FOUND);
  assert.notEqual(D.classify({ ...base, symptomCheckedDeterministically: false }).outcome,
    S.OUTCOMES.NO_PROBLEM_FOUND,
    'the analyst must not be able to close a case by choosing the question');
});

test('REGRESSION: a cause for a condition nobody read cannot exceed POSSIBLE', () => {
  const supported = D.adjudicate([hyp(['f1', 'f2'])]);
  const named = { symptomCheckedDeterministically: true, completedReads: 3, hypotheses: supported };
  assert.equal(D.classify({ ...named, symptomConfirmed: true }).outcome,
    S.OUTCOMES.ROOT_CAUSE_ESTABLISHED, 'a confirmed symptom still allows a full conclusion');
  assert.equal(D.classify({ ...named, symptomConfirmed: null }).outcome,
    S.OUTCOMES.POSSIBLE_CAUSE,
    'the field that would confirm the symptom was never read');
  // With no field named at all, the rule does not apply: an open investigation
  // is not explaining a specific unverified claim.
  assert.equal(D.classify({
    ...named, symptomCheckedDeterministically: false, symptomConfirmed: null,
  }).outcome, S.OUTCOMES.ROOT_CAUSE_ESTABLISHED);
});
