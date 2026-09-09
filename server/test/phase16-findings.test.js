/**
 * PHASE 16 — FINDING IDENTITY, DEDUPLICATION, SEVERITY AND SUMMARY.
 *
 * §23, §24, §27, §28, §29, §40, §41. These are the properties that decide
 * whether a linter is usable a second time: stable ids so a person can dismiss
 * something and have it stay dismissed, deduplication so one fault reads as one
 * fault, and a definition of "clean" strict enough to be worth trusting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const L = await import('../src/agent/lint/index.js');
const {
  SEVERITY, STATUS, KIND, CONFIDENCE, EVIDENCE_SOURCE,
  fingerprint, makeFinding, deduplicate, rank, summarise, isFinding, isEvidence,
} = L;

const base = (over = {}) => ({
  rule_id: 'FLOW001',
  flow_sys_id: 'f'.repeat(32),
  severity: SEVERITY.CRITICAL,
  status: STATUS.CONFIRMED,
  kind: KIND.DEFECT,
  confidence: CONFIDENCE.HIGH,
  title: 'a title',
  description: 'a description',
  evidence: [{ source: EVIDENCE_SOURCE.LIVE_SCHEMA, table: 'incident', field: 'foobar' }],
  affected: { step: 'Update Record', field: 'foobar' },
  ...over,
});

/* ================================================================== *
 * §25 — no evidence, no finding
 * ================================================================== */

test('§25 a finding with no evidence cannot be constructed', () => {
  assert.throws(() => makeFinding(base({ evidence: [] })), /at least one piece of evidence/);
});

test('§25 evidence must name where it came from', () => {
  assert.equal(isEvidence({ source: 'live_schema', table: 'incident' }), true);
  assert.equal(isEvidence({ table: 'incident', field: 'x' }), false, 'no source');
  assert.equal(isEvidence({ source: 'a_source_i_invented', table: 'incident' }), false);
  assert.equal(isEvidence({ source: 'live_schema' }), false, 'a source alone says nothing');
});

test('§23 a malformed finding is refused at construction, not emitted weakly', () => {
  assert.throws(() => makeFinding(base({ severity: 'CATASTROPHIC' })), /malformed finding/);
  assert.throws(() => makeFinding(base({ status: 'PROBABLY' })), /malformed finding/);
  assert.throws(() => makeFinding(base({ confidence: 0.97 })), /malformed finding/);
});

test('§23 confidence is a word, never a number', () => {
  assert.deepEqual(L.CONFIDENCE_LIST, ['low', 'medium', 'high']);
  const f = makeFinding(base());
  assert.ok(L.CONFIDENCE_LIST.includes(f.confidence));
});

/* ================================================================== *
 * §24 — severity and status are independent
 * ================================================================== */

test('§24 severity and status are separate axes', () => {
  const seriousButUnsure = makeFinding(base({ severity: SEVERITY.CRITICAL, status: STATUS.POSSIBLE }));
  const trivialButCertain = makeFinding(base({
    severity: SEVERITY.LOW, status: STATUS.CONFIRMED, affected: { step: 'Other', field: 'x' },
  }));
  assert.equal(seriousButUnsure.severity, 'CRITICAL');
  assert.equal(seriousButUnsure.status, 'POSSIBLE');
  assert.equal(trivialButCertain.severity, 'LOW');
  assert.equal(trivialButCertain.status, 'CONFIRMED');
  /* And no single field collapses them into a priority number. */
  for (const f of [seriousButUnsure, trivialButCertain]) {
    assert.ok(!('priority' in f) && !('score' in f));
  }
});

test('§24 ranking puts CERTAINTY first, so speculation never leads', () => {
  const confirmedHigh = makeFinding(base({
    severity: SEVERITY.HIGH, status: STATUS.CONFIRMED, affected: { step: 'A', field: 'a' },
  }));
  const possibleCritical = makeFinding(base({
    severity: SEVERITY.CRITICAL, status: STATUS.POSSIBLE, affected: { step: 'B', field: 'b' },
  }));
  const ordered = rank([possibleCritical, confirmedHigh]);
  assert.equal(ordered[0].status, 'CONFIRMED',
    'a confirmed problem outranks a speculative one with larger hypothetical impact');
});

/* ================================================================== *
 * §28 / §29 — stable identity
 * ================================================================== */

test('§28 the same fault produces the same id every run', () => {
  const a = makeFinding(base());
  const b = makeFinding(base());
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[0-9a-f]{16}$/);
});

test('§29 wording, severity and status do not change identity', () => {
  const a = makeFinding(base());
  const b = makeFinding(base({
    title: 'completely different wording',
    description: 'rewritten by a different model on a different day',
    severity: SEVERITY.LOW,
    status: STATUS.POSSIBLE,
    confidence: CONFIDENCE.LOW,
  }));
  assert.equal(a.id, b.id, 'identity must come from what and where, not from how it is described');
});

test('§28 a different flow, rule, location or target is a different finding', () => {
  const a = fingerprint({ flow_sys_id: 'f1', rule_id: 'FLOW001', location: 'Update', target: 'foo' });
  assert.notEqual(a, fingerprint({ flow_sys_id: 'f2', rule_id: 'FLOW001', location: 'Update', target: 'foo' }));
  assert.notEqual(a, fingerprint({ flow_sys_id: 'f1', rule_id: 'FLOW002', location: 'Update', target: 'foo' }));
  assert.notEqual(a, fingerprint({ flow_sys_id: 'f1', rule_id: 'FLOW001', location: 'Create', target: 'foo' }));
  assert.notEqual(a, fingerprint({ flow_sys_id: 'f1', rule_id: 'FLOW001', location: 'Update', target: 'bar' }));
});

test('§28 the target is normalised, so case is not a second finding', () => {
  assert.equal(
    fingerprint({ flow_sys_id: 'f1', rule_id: 'FLOW001', location: 'Update', target: 'Priority' }),
    fingerprint({ flow_sys_id: 'f1', rule_id: 'FLOW001', location: 'update', target: ' priority ' }),
  );
});

/* ================================================================== *
 * §27 — deduplication
 * ================================================================== */

test('§27 two rules finding the same fault merge into one, keeping both', () => {
  const missing = makeFinding(base({ rule_id: 'FLOW001', status: STATUS.CONFIRMED }));
  const unwritable = makeFinding(base({
    rule_id: 'FLOW002', status: STATUS.LIKELY, severity: SEVERITY.HIGH,
    evidence: [{ source: EVIDENCE_SOURCE.SEMANTIC, table: 'incident', field: 'foobar' }],
  }));
  const merged = deduplicate([unwritable, missing]);
  assert.equal(merged.length, 1, 'one fault is one finding');
  assert.equal(merged[0].rule_id, 'FLOW001', 'the strongest evidence survives');
  assert.equal(merged[0].merged.length, 1);
  assert.equal(merged[0].merged[0].rule_id, 'FLOW002', 'what merged in is kept, not discarded');
  assert.equal(merged[0].evidence.length, 2, 'both pieces of evidence survive');
});

test('§27 two different fields on one step remain two findings', () => {
  const a = makeFinding(base({ affected: { step: 'Update Record', field: 'foo' } }));
  const b = makeFinding(base({ affected: { step: 'Update Record', field: 'bar' } }));
  assert.equal(deduplicate([a, b]).length, 2, 'fixing one still leaves the other');
});

test('§27 merging does not duplicate identical evidence', () => {
  const shared = { source: EVIDENCE_SOURCE.LIVE_SCHEMA, table: 'incident', field: 'foobar' };
  const a = makeFinding(base({ rule_id: 'FLOW001', evidence: [shared] }));
  const b = makeFinding(base({ rule_id: 'FLOW002', status: STATUS.LIKELY, evidence: [shared] }));
  assert.equal(deduplicate([a, b])[0].evidence.length, 1);
});

/* ================================================================== *
 * §40 / §41 — the summary, and what "clean" is allowed to mean
 * ================================================================== */

test('§40 the summary counts by status, not by severity', () => {
  const s = summarise([
    makeFinding(base({ status: STATUS.CONFIRMED, affected: { step: 'A', field: 'a' } })),
    makeFinding(base({ status: STATUS.CONFIRMED, affected: { step: 'B', field: 'b' } })),
    makeFinding(base({ status: STATUS.LIKELY, affected: { step: 'C', field: 'c' } })),
    makeFinding(base({ status: STATUS.POSSIBLE, affected: { step: 'D', field: 'd' } })),
  ], [{ rule_id: 'FLOW008', reason: 'no history' }], ['FLOW001', 'FLOW008']);
  assert.equal(s.confirmed, 2);
  assert.equal(s.likely, 1);
  assert.equal(s.possible, 1);
  assert.equal(s.unknown, 1);
  assert.equal(s.total, 4);
});

test('§41 CLEAN requires rules to have run AND nothing unknown', () => {
  assert.equal(summarise([], [], ['FLOW001', 'FLOW002']).clean, true);
  assert.equal(summarise([], [{ rule_id: 'FLOW008', reason: 'could not read history' }], ['FLOW008']).clean, false,
    'a run with an unanswered check is unfinished, not clean');
  assert.equal(summarise([makeFinding(base())], [], ['FLOW001']).clean, false);
  assert.equal(summarise([], [], []).clean, false,
    'a run where no rule executed has not established anything');
});

/* ================================================================== *
 * §46 — a finding is analysis, not a fact
 * ================================================================== */

test('§46 a finding is not shaped like a fact and cannot be mistaken for one', () => {
  const f = makeFinding(base());
  /* Phase 14's fact predicate requires provenance with a step and a tool; a
   * finding carries evidence instead, so it cannot pass as an observation. */
  assert.ok(!('source' in f) || typeof f.source !== 'object' || !f.source?.tool);
  assert.ok(Array.isArray(f.evidence));
  assert.ok(isFinding(f));
});

/* ================================================================== *
 * §6 — IDENTIFICATION, and the regression the evaluation found
 * ================================================================== */

const I = await import('../src/agent/lint/intent.js');

test('REGRESSION: a plausible-but-wrong stripped name falls back to the model', async () => {
  /*
   * MEASURED. "Why might the X flow fail?" strips to "X fail" — long, plausible,
   * and matching nothing. The fallback was gated on the stripped name being at
   * least three characters, so the model was never asked and twelve of twenty
   * evaluation requests failed to find a flow that was sitting right there.
   * The INSTANCE now decides whether the cheap read worked.
   */
  const asked = [];
  const find = async ({ name }) => {
    asked.push(name);
    return name === 'Assign Incident'
      ? { ok: true, sys_id: 'f'.repeat(32), name, by: 'exact_name' }
      : { ok: false, reason: 'not_found', candidates: [], note: 'no match' };
  };
  const chat = async () => JSON.stringify({ flow: 'Assign Incident' });

  const r = await I.resolveFlowForRequest({ request: 'Why might the Assign Incident flow fail?', find, chat });
  assert.equal(r.found.ok, true, `the flow was not found; tried: ${asked.join(' | ')}`);
  assert.equal(r.by, 'model', 'the model is consulted only after the cheap read fails against the instance');
  assert.ok(asked.length >= 2, 'the deterministic name is tried first');
});

test('§6 an AMBIGUOUS result is never retried through the model', async () => {
  let chatCalls = 0;
  const find = async () => ({
    ok: false, reason: 'ambiguous', candidates: [{ sys_id: 'a', name: 'A' }, { sys_id: 'b', name: 'B' }],
    note: 'two flows match',
  });
  const chat = async () => { chatCalls += 1; return '{"flow":"A"}'; };
  const r = await I.resolveFlowForRequest({ request: 'Lint the Change flow.', find, chat });
  assert.equal(r.found.reason, 'ambiguous');
  assert.equal(chatCalls, 0, 'asking a model to break the tie is exactly the choice §6 forbids');
});

test('§6 the cheap path is used when it works, and costs no model call', async () => {
  let chatCalls = 0;
  const find = async ({ name }) => ({ ok: true, sys_id: 'f', name, by: 'exact_name' });
  const chat = async () => { chatCalls += 1; return '{}'; };
  const r = await I.resolveFlowForRequest({ request: 'Lint the Assign Incident flow.', find, chat });
  assert.equal(r.by, 'deterministic');
  assert.equal(chatCalls, 0);
});

test('§34 "fix it" is recognised, and becomes a plan GOAL rather than a change', () => {
  const finding = L.makeFinding(base({
    rule_id: 'FLOW002',
    recommendation: { statement: 'Set impact and urgency instead of priority.' },
  }));
  const goal = I.fixGoal(finding, { flow: { name: 'Assign Incident' } });
  assert.match(goal, /Assign Incident/);
  assert.match(goal, /Set impact and urgency/);
  assert.match(goal, /FLOW002/);
  /* And a finding with no recommendation cannot become one. */
  assert.throws(() => I.fixGoal(L.makeFinding(base()), { flow: {} }), /carries a recommendation/);
});
