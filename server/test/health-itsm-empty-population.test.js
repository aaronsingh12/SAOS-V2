import test from 'node:test';
import assert from 'node:assert/strict';
import { estateContext, ESTATE } from './helpers/itsm-estate.js';

const { runITSMRules } = await import('../src/health/itsm/runner.js');
const { getAllITSMRules } = await import('../src/health/itsm/catalogue.js');
const { normalizeITSMRun } = await import('../src/health/itsm/integration.js');
const { buildParameterRegistry } = await import('../src/health/itsm/integration.js');
const R = await import('../src/health/itsm/engines/result.js');

/*
 * ITSM PHASE 5 CLOSURE — EMPTY POPULATION.
 *
 * "No offender" is a PASS only when something was judged. Before the closure the
 * runner answered `pass` for 55 rules on an instance with no incidents, problems
 * or changes. The contract (engines/result.js): every evaluated result declares
 * its population; the runner answers `inconclusive` when nothing was judged, and
 * says why. These tests hold the contract per detection shape, hold that
 * non-empty meaning did not move, and keep empty data apart from UNAVAILABLE and
 * UNCONFIGURED.
 */

const EMPTY = { incident: [], problem: [], change_request: [], task_sla: [], kb_knowledge: [], m2m_kb_task: [], sys_user_delegate: [], sysapproval_approver: [] };

async function run(overrides = {}, opts = {}) {
  const ctx = estateContext(overrides, opts);
  const r = await runITSMRules(ctx, opts.ruleIds ? { ruleIds: opts.ruleIds } : {});
  return { r, ctx, get: (id) => r.results.get(id) };
}

const inc = ESTATE.incident;
const byId = (rows, id) => rows.find((x) => x.sys_id === id);

/* ════════════ the contract itself ════════════ */

test('CONTRACT: undeterminedOf reads a declared population — judged 0 is not a pass, an undeclared population is not a pass, a withheld judgement is not a pass, determinate_when_empty is the one declared exception', () => {
  const base = () => ({ status: R.STATUS.EVALUATED, findings: [] });
  assert.equal(R.undeterminedOf(R.notePopulation(base(), { total: 5, judged: 5 })), null);
  assert.equal(R.undeterminedOf(R.notePopulation(base(), { total: 0, judged: 0 })).kind, 'empty_population');
  assert.equal(R.undeterminedOf(R.notePopulation(base(), { total: 4, judged: 0 })).kind, 'nothing_judgeable');
  assert.equal(R.undeterminedOf(R.notePopulation(base(), { total: null, judged: null })).kind, 'population_unknown');
  assert.equal(R.undeterminedOf(base()).kind, 'population_undeclared');
  assert.equal(R.undeterminedOf(R.withhold(R.notePopulation(base(), { total: 3, judged: 3 }), R.UNDETERMINED.BELOW_MINIMUM_VOLUME, 'x')).kind, 'below_minimum_volume');
  assert.equal(R.undeterminedOf(R.notePopulation(base(), { total: 0, judged: 0, determinate_when_empty: 'the workbook says so' })), null);
  /* the exception covers an EMPTY population only — records nobody could judge are still not health */
  assert.equal(R.undeterminedOf(R.notePopulation(base(), { total: 2, judged: 0, determinate_when_empty: 'the workbook says so' })).kind, 'nothing_judgeable');
  /* not evaluated is not this contract's business: UNAVAILABLE / UNCONFIGURED keep their own status */
  assert.equal(R.undeterminedOf({ status: R.STATUS.UNAVAILABLE, findings: [] }), null);
  assert.throws(() => R.withhold(base(), 'made_up_kind', 'x'), /not one of/);
});

test('CONTRACT: every evaluated result on the populated and on the empty estate declares its population — no engine path falls through to the fail-safe', async () => {
  for (const overrides of [{}, EMPTY]) {
    const { r } = await run(overrides);
    for (const [id, res] of r.results) {
      if (res.status !== 'evaluated') continue;
      assert.ok(res.population, `${id} (${res.engine}) declared no population`);
      assert.notEqual(R.undeterminedOf(res)?.kind, 'population_undeclared', id);
      assert.ok(res.population.judged == null || res.population.judged <= (res.population.total ?? Infinity), `${id} judged more than its population`);
    }
  }
});

/* ════════════ empty → not pass, per detection shape ════════════ */

test('EMPTY → NOT PASS: with no incidents, problems or changes not one of the 139 rules passes, and no rule turned the emptiness into a FAIL', async () => {
  const before = await run();
  const { r, get } = await run(EMPTY);
  assert.equal(r.verdicts.pass ?? 0, 0, `passed over an empty estate: ${[...r.results].filter(([, x]) => x.verdict === 'pass').map(([id]) => id).join(', ')}`);
  for (const [id, res] of r.results) {
    if (res.verdict !== 'fail') continue;
    /* a FAIL on the empty estate is over a population that is still there (configuration, delegations …) — never over nothing */
    assert.ok(res.population?.judged > 0, `${id} FAILED over an empty population`);
    assert.equal(before.get(id).verdict, 'fail', `${id} fails only on the empty estate`);
  }
  /* the shapes the brief names, each with its own population point */
  const shapes = {
    'ITSM-016': 'aggregate ratio 0 / 0', 'ITSM-001': 'aggregate share', 'ITSM-032': 'aggregate count', 'ITSM-041': 'aggregate trend',
    'ITSM-020': 'record predicate', 'ITSM-039': 'linkage', 'ITSM-018': 'reference integrity (members)', 'ITSM-065': 'reference integrity (variants)',
    'ITSM-021': 'text similarity', 'ITSM-075': 'text cluster', 'ITSM-026': 'audit history (journal)', 'ITSM-072': 'audit history (state order)',
    'ITSM-123': 'temporal correlation', 'ITSM-112': 'temporal schedule intersection', 'ITSM-130': 'relationship graph',
    'ITSM-003': 'configuration against usage', 'ITSM-005': 'configuration lookup', 'ITSM-002': 'choice usage',
    'ITSM-124': 'composite over a correlation', 'ITSM-134': 'composite union',
  };
  for (const [id, shape] of Object.entries(shapes)) {
    assert.equal(get(id).status, 'evaluated', `${id} (${shape}) did not evaluate`);
    assert.equal(get(id).verdict, 'inconclusive', `${id} (${shape})`);
    assert.equal(get(id).findings.length, 0, `${id} (${shape}) produced a finding over nothing`);
  }
});

test('EVIDENCE: an empty rule says its population was empty, that health could not be established, and which verdict it got — machine-readable and in words', async () => {
  const { get } = await run(EMPTY, { ruleIds: ['ITSM-020', 'ITSM-016'] });
  for (const id of ['ITSM-020', 'ITSM-016']) {
    const res = get(id);
    assert.deepEqual({ total: res.population.total, judged: res.population.judged }, { total: 0, judged: 0 }, id);
    assert.equal(res.undetermined.kind, 'empty_population', id);
    assert.equal(res.explanation.population_empty, true, id);
    assert.equal(res.explanation.undetermined.kind, 'empty_population', id);
    assert.equal(res.explanation.verdict, 'inconclusive', id);
    const said = res.skipped.find((s) => s.undetermined === 'empty_population');
    assert.ok(said, `${id} did not list the empty population as a skipped check`);
    assert.match(said.reason, /no incident records in scope/, id);
    assert.match(said.reason, /health could not be established, so the verdict is inconclusive, not pass/, id);
  }
  /* the normalised row the store and the page receive carries the same */
  const { r, ctx } = await run(EMPTY);
  const norm = normalizeITSMRun(r, { readCoverage: await ctx.reads.coverage() });
  const row = norm.rules.find((x) => x.rule_id === 'ITSM-020');
  assert.equal(row.population_empty, true);
  assert.deepEqual({ kind: row.undetermined.kind, health: row.undetermined.health, verdict: row.undetermined.verdict }, { kind: 'empty_population', health: 'not established', verdict: 'inconclusive' });
  assert.ok(norm.skipped.some((s) => s.rule === 'ITSM-020' && s.undetermined === 'empty_population'));
  assert.deepEqual(norm.aggregation.passes_over_empty_population, []);
  assert.ok(norm.aggregation.population_empty.includes('ITSM-020'));
  assert.ok(norm.aggregation.undetermined_by_kind.empty_population.includes('ITSM-016'));
});

/* ════════════ non-empty meaning did not move ════════════ */

test('NON-EMPTY: healthy records still PASS and an offender still FAILS — predicate, aggregate ratio, linkage, reference integrity', async () => {
  const ok = byId(inc, 'inc-ok');
  const bad = byId(inc, 'inc-bad');
  /* ITSM-020 record predicate: resolved incidents with short close notes */
  assert.equal((await run({ incident: [ok] }, { ruleIds: ['ITSM-020'] })).get('ITSM-020').verdict, 'pass');
  const f20 = (await run({ incident: [ok, bad] }, { ruleIds: ['ITSM-020'] })).get('ITSM-020');
  assert.deepEqual([f20.verdict, f20.population.total > 0], ['fail', true]);
  /* ITSM-016 aggregate ratio: incidents with neither CI nor business service */
  const healthy16 = (await run({ incident: [ok] }, { ruleIds: ['ITSM-016'] })).get('ITSM-016');
  assert.deepEqual([healthy16.verdict, healthy16.population.judged], ['pass', 1]);
  const blind = { ...ok, sys_id: 'inc-blind', cmdb_ci: '', business_service: '' };
  const f16 = (await run({ incident: [blind, { ...blind, sys_id: 'inc-blind-2' }] }, { ruleIds: ['ITSM-016'] })).get('ITSM-016');
  assert.deepEqual([f16.verdict, f16.population.judged], ['fail', 2]);
  /* ITSM-039 linkage: P1 incidents with no problem — the estate's P1s */
  assert.equal((await run({}, { ruleIds: ['ITSM-039'] })).get('ITSM-039').verdict, 'fail');
  const linked = { ...bad, problem_id: 'prb-ok' };
  const p39 = (await run({ incident: [ok, linked, { ...byId(inc, 'inc-open'), priority: '3' }, byId(inc, 'inc-copy')] }, { ruleIds: ['ITSM-039'] })).get('ITSM-039');
  assert.deepEqual([p39.verdict, p39.population.judged], ['pass', 1]);
  /* ITSM-018 reference integrity (members): an open incident on a group with an active member passes; on the empty group it fails */
  const open = byId(inc, 'inc-open');
  const p18 = (await run({ incident: [{ ...open, assignment_group: 'g-live' }] }, { ruleIds: ['ITSM-018'] })).get('ITSM-018');
  assert.deepEqual([p18.verdict, p18.population.judged], ['pass', 1]);
  const f18 = (await run({ incident: [{ ...open, assignment_group: 'g-empty' }] }, { ruleIds: ['ITSM-018'] })).get('ITSM-018');
  assert.deepEqual([f18.verdict, f18.population.judged], ['fail', 1]);
});

test('NON-EMPTY: on the populated estate the only verdicts that moved are passes over nothing judged — no FAIL, status or finding changed', async () => {
  const { r } = await run();
  /* Recorded before the closure fix (phase5-status-matrix.json, estate column): these five passed. */
  const moved = { 'ITSM-017': 'empty_population', 'ITSM-018': 'nothing_judgeable', 'ITSM-041': 'insufficient_history', 'ITSM-101': 'empty_population', 'ITSM-134': 'input_inconclusive' };
  for (const [id, kind] of Object.entries(moved)) {
    assert.equal(r.results.get(id).verdict, 'inconclusive', id);
    assert.equal(r.results.get(id).undetermined.kind, kind, id);
  }
  assert.deepEqual({ pass: r.verdicts.pass, fail: r.verdicts.fail, inconclusive: r.verdicts.inconclusive }, { pass: 8, fail: 59, inconclusive: 7 });
  assert.deepEqual(r.summary, { evaluated: 74, unavailable: 38, unconfigured: 26, skipped: 1 });
});

/* ════════════ aggregate 0/0, predicate over zero, withheld judgements ════════════ */

test('AGGREGATE 0/0 and PREDICATE OVER ZERO RECORDS: a ratio with a zero denominator and a predicate whose scope matches nothing are inconclusive, on a populated table', async () => {
  /* incidents exist; none is resolved — ITSM-020's scope (resolved_atISNOTEMPTY) is empty */
  const unresolved = byId(inc, 'inc-open');
  const p = await run({ incident: [unresolved] }, { ruleIds: ['ITSM-020', 'ITSM-017'] });
  assert.equal(p.get('ITSM-020').verdict, 'inconclusive');
  assert.equal(p.get('ITSM-020').undetermined.kind, 'empty_population');
  /* ITSM-017: incidents referencing a bare CI / incidents referencing either — none references either */
  assert.equal(p.get('ITSM-017').kpis[0].denominator, 0);
  assert.equal(p.get('ITSM-017').verdict, 'inconclusive');
});

test('WITHHELD: too little trend history is not a pass', async () => {
  const { get } = await run({}, { ruleIds: ['ITSM-041'] });
  assert.equal(get('ITSM-041').verdict, 'inconclusive');
  assert.equal(get('ITSM-041').undetermined.kind, 'insufficient_history');
  assert.ok(get('ITSM-041').population.judged > 0, 'the population was there; the history was not');
});

/* ════════════ composites ════════════ */

test('COMPOSITE: an input that established nothing cannot produce a composite PASS; real input findings still produce a composite FAIL', async () => {
  /* ITSM-134 (union of 018 / 065 / 101) over an empty estate */
  const empty = await run(EMPTY, { ruleIds: ['ITSM-134'] });
  assert.equal(empty.get('ITSM-134').status, 'evaluated');
  assert.equal(empty.get('ITSM-134').verdict, 'inconclusive');
  assert.equal(empty.get('ITSM-134').undetermined.kind, 'input_inconclusive');
  assert.match(empty.get('ITSM-134').undetermined.reason, /ITSM-018/);
  /* ITSM-129 (all three processes blind) with its threshold supplied, over empty inputs */
  const { registry } = buildParameterRegistry([{ rule_id: 'ITSM-129', key: 'problem_reference_threshold', value: 30 }]);
  const blind = await run(EMPTY, { ruleIds: ['ITSM-129'], parameters: registry });
  assert.equal(blind.get('ITSM-129').status, 'evaluated', blind.get('ITSM-129').skipped.map((s) => s.reason).join('; '));
  assert.equal(blind.get('ITSM-129').verdict, 'inconclusive');
  assert.equal(blind.get('ITSM-129').undetermined.kind, 'input_inconclusive');
  assert.equal(blind.get('ITSM-129').findings.length, 0);
  /* populated: two processes share the empty group g-empty → a real composite finding */
  const shared = await run({}, { ruleIds: ['ITSM-134'] });
  const inputs = ['ITSM-018', 'ITSM-065', 'ITSM-101'].map((id) => shared.get(id).findings.length);
  if (shared.get('ITSM-134').findings.length) assert.equal(shared.get('ITSM-134').verdict, 'fail');
  else assert.equal(shared.get('ITSM-134').verdict, 'inconclusive', `inputs ${inputs.join('/')} — 018 and 101 establish nothing on the estate`);
});

/* ════════════ empty ≠ UNAVAILABLE ≠ UNCONFIGURED ════════════ */

test('THREE STATES: an empty table is evaluated / inconclusive; a table the instance lacks is UNAVAILABLE; a parameter with no value is UNCONFIGURED — none is a pass and none becomes another', async () => {
  const empty = await run({ problem: [] }, { ruleIds: ['ITSM-062'] });
  assert.deepEqual([empty.get('ITSM-062').status, empty.get('ITSM-062').verdict, empty.get('ITSM-062').undetermined.kind], ['evaluated', 'inconclusive', 'empty_population']);
  const missing = await run({}, { ruleIds: ['ITSM-112'], instance: { absent: ['cmn_schedule_blackout', 'cmn_schedule', 'cmn_schedule_span'] } });
  assert.equal(missing.get('ITSM-112').status, 'unavailable');
  assert.equal(missing.get('ITSM-112').verdict, null);
  assert.equal(missing.get('ITSM-112').undetermined, undefined);
  const unconfigured = await run(EMPTY, { ruleIds: ['ITSM-129'] });
  assert.equal(unconfigured.get('ITSM-129').status, 'unconfigured');
  assert.equal(unconfigured.get('ITSM-129').verdict, null);
  assert.equal(unconfigured.get('ITSM-129').undetermined, undefined);
});

/* ════════════ where empty legitimately answers ════════════ */

test('DETERMINATE WHEN EMPTY (ITSM-029, the workbook\'s own gate "fires only where routing rules reference the fields"): no rule references the fields → pass; a rule references one but no record is in scope → inconclusive; an empty routing field → fail', async () => {
  const noRouting = await run({ incident: [], sysrule_assignment: [{ sys_id: 'ar-2', name: 'Route by category', table: 'incident', condition: 'category=network', group: 'g-live', user: '', active: 'true' }] }, { ruleIds: ['ITSM-029'] });
  assert.equal(noRouting.get('ITSM-029').verdict, 'pass');
  assert.match(noRouting.get('ITSM-029').population.determinate_when_empty, /Fires only where routing rules reference the fields/);
  /* no assignment rule at all (dev424910): the same reading — and the aggregation lists it apart from the cross-check, which stays empty */
  const none = await run({ sysrule_assignment: [] }, { ruleIds: ['ITSM-029'] });
  assert.equal(none.get('ITSM-029').verdict, 'pass');
  const norm = normalizeITSMRun(none.r, { readCoverage: await none.ctx.reads.coverage() });
  assert.deepEqual(norm.aggregation.passes_over_empty_population, []);
  assert.deepEqual(norm.aggregation.passes_determinate_when_empty.map((x) => x.rule_id), ['ITSM-029']);
  const nothingInScope = await run({ incident: [] }, { ruleIds: ['ITSM-029'] });
  assert.equal(nothingInScope.get('ITSM-029').verdict, 'inconclusive');
  assert.equal(nothingInScope.get('ITSM-029').undetermined.kind, 'empty_population');
  const routedOnEmpty = await run({}, { ruleIds: ['ITSM-029'] });
  assert.equal(routedOnEmpty.get('ITSM-029').verdict, 'fail');
});

test('AUDIT: the catalogue is covered — every rule that can evaluate on the estate was run over the empty estate, and the per-rule reading is recorded', async () => {
  const { r } = await run(EMPTY);
  assert.equal(r.results.size, getAllITSMRules().length);
  const evaluated = [...r.results.values()].filter((x) => x.status === 'evaluated');
  assert.ok(evaluated.length >= 70, `only ${evaluated.length} rules evaluated on the empty estate`);
  for (const x of evaluated) if (!x.findings.length) assert.ok(R.undeterminedOf(x) || x.scope?.partial, `${x.rule_id} passed over the empty estate`);
});
