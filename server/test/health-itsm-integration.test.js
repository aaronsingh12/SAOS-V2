import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-itsm-p5-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'i.db'))));
const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev000001.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const { runHealthCheck } = await import('../src/health/index.js');
const { runITSMRules } = await import('../src/health/itsm/runner.js');
const { ITSM_RULE_CONFIGS } = await import('../src/health/itsm/rules/index.js');
const { getAllITSMRules } = await import('../src/health/itsm/catalogue.js');
const { summariseScopes, scopeOf } = await import('../src/health/scopes.js');
const { openRun, completeRun, listFindings, getFinding } = await import('../src/health/store.js');
const { fakeInstance } = await import('./helpers/itsm-fake-instance.js');
const { SnowError } = await import('../src/servicenow/client.js');
const { ESTATE, ABSENT, NOW, estateContext } = await import('./helpers/itsm-estate.js');
const { default: express } = await import('express');
const { healthRouter } = await import('../src/routes/health.js');
const { buildParameterRegistry, validateRuntimeParameters } = await import('../src/health/index.js');
const { itsmParameterOverrides, setItsmParameterOverride, clearItsmParameterOverride } = await import('../src/health/store.js');
const { engineKeys } = await import('../src/health/incremental.js');

/*
 * ITSM PHASE 5 — the 139-rule catalogue THROUGH THE HEALTH CHECKER.
 *
 * Every other ITSM suite calls the runner or an engine directly. These call
 * `runHealthCheck` — the change check, extraction, the runner, normalisation,
 * analyze(), synthesize(), the scope summaries, the manifest — and, where it
 * matters, the store and the SQL scope filter, because the defects this phase
 * exists to prevent live in the joins between those layers.
 */

const CATALOGUE_IDS = getAllITSMRules().map((r) => r.id).sort();

async function scan(overrides = {}, { instance = {}, itsm = {}, modules = ['itsm'], wrap = (c) => c } = {}) {
  const client = wrap(fakeInstance({ ...ESTATE, ...overrides }, { absent: ABSENT, ...instance }));
  const r = await runHealthCheck({ client, explain: false, modules, reuse: false, user: 'admin', now: NOW, itsm });
  const row = (id) => r.manifest.itsm.rules.find((x) => x.rule_id === id);
  return { r, client, row };
}

let baseline = null;
const base = async () => (baseline ??= await scan());

/* ════════════ all 139 slots, both status layers, identical to the standalone runner ════════════ */

test('PIPELINE: every one of the 139 slots appears exactly once, with both status layers, and matches the standalone runner rule for rule', async () => {
  const { r } = await base();
  const m = r.manifest.itsm;
  assert.ok(m, 'an ITSM scan carries no catalogue result');
  assert.deepEqual(m.rules.map((x) => x.rule_id).sort(), CATALOGUE_IDS);
  assert.deepEqual(m.aggregation.reconciliation, { catalogue: 139, rows: 139, complete: true, duplicates: [], missing: [] });

  /* The design-time classification reproduces Phase 4's closure matrix exactly. */
  assert.deepEqual(m.aggregation.by_classification, { EXECUTABLE: 76, UNCONFIGURED: 30, UNAVAILABLE: 33, NOT_IMPLEMENTED: 0 });
  assert.equal(Object.values(m.aggregation.by_status).reduce((a, b) => a + b, 0), 139);

  /* Integration changes nothing the runner decided. */
  const standalone = await runITSMRules(estateContext());
  for (const row of m.rules) {
    const s = standalone.results.get(row.rule_id);
    assert.equal(row.status, s.status, `${row.rule_id} status`);
    assert.equal(row.verdict, s.verdict ?? null, `${row.rule_id} verdict`);
    assert.equal(row.findings, s.findings.length, `${row.rule_id} findings`);
    assert.equal(row.blocker?.kind ?? null, s.blocker?.kind ?? null, `${row.rule_id} blocker`);
    /* The ladder is explicit, and a non-evaluated rule is never given a verdict. */
    assert.equal(typeof row.executable, 'boolean');
    assert.equal(typeof row.configured, 'boolean');
    if (!row.evaluated) assert.equal(row.verdict, null, `${row.rule_id} has a verdict without evaluating`);
    if (row.classification === 'UNAVAILABLE') assert.equal(row.executable, false);
  }
});

test('FINDINGS: every catalogue finding reaches the scan with its rule identity, evidence, detail, confidence and a priority', async () => {
  const { r } = await base();
  const standalone = await runITSMRules(estateContext());
  const expected = [...standalone.results.values()].flatMap((x) => x.findings);
  const byFp = new Map(r.findings.map((f) => [f.fingerprint, f]));
  assert.ok(expected.length > 20, 'the estate fixture should produce catalogue findings');
  for (const e of expected) {
    const f = byFp.get(e.fingerprint);
    assert.ok(f, `${e.rule_id} finding lost in integration`);
    assert.equal(f.rule_id, e.rule_id);
    assert.equal(f.agent_id, 'itsm_agent');
    assert.equal(f.domain, 'ITSM');
    assert.equal(scopeOf(f), 'itsm');
    assert.equal(f.itsm.rule_id, e.rule_id, 'the trace names the rule, not only the engine');
    assert.equal(f.itsm.engine, ITSM_RULE_CONFIGS.get(e.rule_id).engine);
    assert.equal(f.itsm.verdict, 'fail');
    assert.equal(f.kind, e.kind);
    /* Two variants flagging one record share a fingerprint: every detail and evidence row is kept on the one finding. */
    assert.ok([f.detail, ...(f.itsm.merged_details || [])].some((d) => JSON.stringify(d) === JSON.stringify(e.detail)), `${e.rule_id} detail lost`);
    const evidence = new Set(f.evidence.map((x) => JSON.stringify(x)));
    assert.ok(e.evidence.every((x) => evidence.has(JSON.stringify(x))), `${e.rule_id} evidence lost`);
    assert.equal(f.confidence, e.confidence);
    assert.equal(f.severity, e.severity);
    assert.ok(['P1', 'P2', 'P3'].includes(f.priority) && Number.isFinite(f.priority_score), `${e.rule_id} has no priority — storage would reject it`);
    assert.equal(Object.isFrozen(f), false, 'a frozen finding would throw when synthesize() or the explanation pass writes to it');
  }
  /* The same fact from two variants is one finding. */
  assert.equal(new Set(r.findings.map((f) => f.fingerprint)).size, r.findings.length);
});

test('SCORE: catalogue findings join the ITSM scope and move the ITSM Quality score by exactly the records they charge — never by a Systemic finding, never by a record outside the slice', async () => {
  const recent = { sys_updated_on: '2026-09-15 08:00:00' };
  /*
   * The shared fake cannot evaluate `^OR` (its group split is anchored, so an
   * `a^b^ORc` query matches nothing); the extraction slice is exactly that shape.
   * These rows are all ACTIVE, so they are in the slice whichever half decides —
   * the wrapper drops the OR half for the three sliced tables only.
   */
  const sliced = new Set(['incident', 'change_request', 'problem']);
  const unOr = (q) => String(q || '').replace(/\^ORsys_updated_on>=[^^]*/, '');
  const wrap = (c) => ({ ...c, query: (t, o = {}) => c.query(t, sliced.has(t) ? { ...o, query: unOr(o.query) } : o), count: (t, q) => c.count(t, sliced.has(t) ? unOr(q) : q) });
  const { r } = await scan({
    incident: ESTATE.incident.map((i) => ({ ...i, ...recent, active: 'true' })),
    change_request: ESTATE.change_request.map((c) => ({ ...c, ...recent, active: 'true' })),
    problem: ESTATE.problem.map((p) => ({ ...p, ...recent, active: 'true' })),
  }, { wrap });
  const itsm = r.manifest.scopes.itsm;
  const catalogue = r.findings.filter((f) => f.domain === 'ITSM');
  const legacy = r.findings.filter((f) => f.domain !== 'ITSM');
  assert.ok(catalogue.length > 0 && legacy.some((f) => /^ITSM-(INC|CHG|PRB)-/.test(f.rule_id)), 'both rule sets must be producing findings for this to prove anything');
  assert.notEqual(itsm.score, null);
  assert.ok(itsm.score >= 0 && itsm.score <= 100, `ITSM score ${itsm.score} is not 0–100`);
  const q = itsm.itsm_quality;
  assert.equal(q.model, 'itsm-quality/1');
  assert.equal(itsm.scoring.key, q.scoring.key);
  /* The stored summary was scored against the extracted slice; recomputing the
     same findings WITHOUT the slice charges the legacy rules only (they read
     the slice by construction) and says the catalogue findings were not placed
     — so it can only score the same or higher, never lower. */
  const unbounded = summariseScopes(r.manifest.coverage, r.findings.filter((f) => scopeOf(f) === 'itsm'), { itsm: { rules: r.manifest.itsm.rules, population: null } }).itsm;
  assert.ok(unbounded.score >= itsm.score, 'charging fewer findings lowered the score');
  assert.equal(
    unbounded.itsm_quality.records.unbounded_catalogue,
    catalogue.filter((f) => ['record', 'historical', 'relationship'].includes(f.kind) && f.base_severity !== 'SYSTEMIC' && (f.target_ids || []).length && ['incident', 'change_request', 'problem'].includes(f.table)).length,
  );
  /* A base-Systemic catalogue finding is posture: counted beside the score, charging nothing. */
  assert.equal(q.systemic.findings, catalogue.filter((f) => f.base_severity === 'SYSTEMIC').length);
  assert.ok(q.records.clean >= 0 && q.records.charged <= q.population.records, 'a record outside the slice was charged');
  /* The drivers are the same records-per-rule breakdown, now over both rule sets. */
  assert.ok(itsm.score_drivers.some((d) => /^ITSM-(INC|CHG|PRB)-/.test(d.rule_id)), 'no legacy driver');
  /* …while the scope's findings and severities do count them. */
  assert.equal(itsm.findings, r.findings.filter((f) => scopeOf(f) === 'itsm').length);
  assert.ok(itsm.domains.some((d) => d.domain === 'ITSM' && d.findings === catalogue.length), 'no ITSM catalogue domain row');
});

test('STORE: kind, detail and the rule trace survive the round trip, and the ITSM list (SQL filter) shows catalogue findings', async () => {
  const { r } = await base();
  const runId = openRun();
  completeRun(runId, r);
  const itsmList = listFindings(runId, { scope: 'itsm', limit: 25_000 }).findings;
  const catalogue = r.findings.filter((f) => f.domain === 'ITSM');
  const listed = new Set(itsmList.map((f) => f.fingerprint));
  for (const f of catalogue) assert.ok(listed.has(f.fingerprint), `${f.rule_id} missing from the ITSM list`);
  assert.equal(listFindings(runId, { scope: 'platform', limit: 25_000 }).findings.filter((f) => f.rule_id.startsWith('ITSM-')).length, 0);
  const one = catalogue.find((f) => f.kind === 'aggregate') || catalogue[0];
  const stored = getFinding(runId, one.fingerprint);
  assert.equal(stored.kind, one.kind);
  assert.deepEqual(stored.detail, JSON.parse(JSON.stringify(one.detail)));
  assert.equal(stored.itsm.rule_id, one.rule_id);
  assert.equal(stored.itsm.engine, one.itsm.engine);
  assert.deepEqual(stored.evidence, JSON.parse(JSON.stringify(one.evidence)));
});

test('SKIPPED CHECKS: every rule that did not evaluate is listed with its ITSM state, and rule / table / reason stay strings the page can render', async () => {
  const { r } = await base();
  const skips = r.manifest.skipped_checks.filter((x) => x.source === 'itsm_catalogue');
  for (const row of r.manifest.itsm.rules.filter((x) => !x.evaluated)) {
    const s = skips.find((x) => x.rule === row.rule_id && x.status === row.status);
    assert.ok(s, `${row.rule_id} (${row.status}) is not in skipped_checks`);
    assert.equal(s.blocker_kind, row.blocker?.kind ?? null);
    assert.equal(typeof s.reason, 'string');
    assert.ok(s.table === null || typeof s.table === 'string');
  }
  for (const s of skips) assert.equal(typeof s.rule, 'string');
});

/* ════════════ the false-PASS guards, through the real pipeline ════════════ */

test('GUARD missing field → UNAVAILABLE, never FAIL or PASS: a link field the release lacks blocks the linkage rules with the field named', async () => {
  const { row, r } = await scan({ sys_dictionary: ESTATE.sys_dictionary.filter((d) => !(d.name === 'incident' && d.element === 'problem_id')) });
  for (const id of ['ITSM-039', 'ITSM-057', 'ITSM-060']) {
    assert.equal(row(id).status, 'unavailable', id);
    assert.equal(row(id).verdict, null, id);
    assert.equal(row(id).blocker.kind, 'capability', id);
    assert.deepEqual(row(id).blocker.fields, ['problem_id'], id);
    assert.equal(r.findings.filter((f) => f.rule_id === id).length, 0, `${id} produced a finding over a missing field`);
  }
});

test('GUARD incomplete CMDB → never PASS: when the catalogue bounded relationship read fails, the graph rule is UNAVAILABLE and the ITSM result is marked degraded (not reusable)', async () => {
  /*
   * Only the runner's BOUNDED reads (DECISION 11: parentIN / childIN for the
   * referenced CIs) are refused. Refusing cmdb_rel_ci outright would stop the
   * whole scan at extraction, where it is a required table — by design.
   */
  const bounded = /(^|\^)(parent|child)IN/;
  const refuse = () => { throw new SnowError('"admin" may not read cmdb_rel_ci over REST', 403, 'Failed API level ACL Validation'); };
  const wrap = (c) => ({
    ...c,
    query: async (t, o = {}) => { if (t === 'cmdb_rel_ci' && bounded.test(o.query || '')) refuse(); return c.query(t, o); },
    count: async (t, q) => { if (t === 'cmdb_rel_ci' && bounded.test(q || '')) refuse(); return c.count(t, q); },
  });
  const { row, r } = await scan({}, { wrap });
  assert.equal(row('ITSM-130').status, 'unavailable');
  assert.equal(row('ITSM-130').verdict, null);
  assert.ok((r.manifest.degraded.itsm || []).some((d) => /cmdb_rel_ci/.test(d)), 'a failed read did not stop the result being reused');
  /* A table the INSTANCE lacks is a stable fact, not a failed read: the fixture's absent tables degrade nothing. */
  const clean = await base();
  assert.equal(clean.r.manifest.degraded.itsm, undefined);
});

test('GUARD missing threshold → UNCONFIGURED; supplied at runtime the composite runs over its three inputs and carries their states', async () => {
  const { row } = await base();
  assert.equal(row('ITSM-129').status, 'unconfigured');
  assert.equal(row('ITSM-129').blocker.kind, 'unconfigured_parameter');
  assert.deepEqual(row('ITSM-129').blocker.parameters, ['problem_reference_threshold']);
  assert.deepEqual(row('ITSM-129').unresolved_parameters, ['problem_reference_threshold']);
  assert.equal(row('ITSM-129').classification, 'UNCONFIGURED');

  const configured = await scan({}, { itsm: { runtime: { 'ITSM-129': { problem_reference_threshold: 30 } } } });
  const c = configured.row('ITSM-129');
  assert.equal(c.status, 'evaluated');
  assert.equal(c.classification, 'EXECUTABLE', 'a runtime override makes the rule configured for this scan');
  assert.deepEqual(c.dependencies.map((d) => d.rule_id).sort(), ['ITSM-016', 'ITSM-067', 'ITSM-094']);
  assert.ok(c.dependencies.every((d) => d.status === 'evaluated'));
  assert.equal(c.parameters.problem_reference_threshold.source, 'runtime');
  assert.deepEqual(configured.r.manifest.itsm.parameters.runtime, { 'ITSM-129': { problem_reference_threshold: 30 } });

  const blocked = await scan({}, { itsm: { runtime: { 'ITSM-129': { problem_reference_threshold: 30 } } }, instance: { forbidden: ['problem'] } });
  assert.equal(blocked.row('ITSM-129').status, 'skipped');
  assert.equal(blocked.row('ITSM-129').blocker.kind, 'input');
  assert.equal(blocked.row('ITSM-129').verdict, null);
});

test('GUARD failed schedule expansion → UNAVAILABLE: a monthly blackout recurrence is never read as "no blackout"', async () => {
  const sched = { cmn_schedule_blackout: [{ sys_id: 'bo', name: 'Aug freeze', type: 'blackout', time_zone: 'UTC' }], cmn_schedule_span: [{ sys_id: 'sp', schedule: 'bo', start_date_time: '20260801T090000', end_date_time: '20260801T103000', repeat_type: 'monthly', all_day: 'false' }] };
  const { row } = await scan(sched);
  assert.equal(row('ITSM-112').status, 'unavailable');
  assert.equal(row('ITSM-112').verdict, null);
});

test('GUARD engine error → ERROR, never PASS: a broken configuration is caught, reported, listed and counted', async () => {
  const configs = new Map(ITSM_RULE_CONFIGS);
  const entry = configs.get('ITSM-020');
  configs.set('ITSM-020', { ...entry, config: { ...entry.config, predicates: 'not a list' } });
  const { row, r } = await scan({}, { itsm: { configs } });
  assert.equal(row('ITSM-020').status, 'error');
  assert.equal(row('ITSM-020').verdict, null);
  assert.equal(row('ITSM-020').blocker.kind, 'error');
  assert.deepEqual(r.manifest.itsm.aggregation.errors.map((e) => e.rule_id), ['ITSM-020']);
  assert.ok(r.manifest.skipped_checks.some((s) => s.rule === 'ITSM-020' && s.status === 'error'));
  assert.equal(r.findings.filter((f) => f.rule_id === 'ITSM-020').length, 0);
  /* One broken rule never takes the others down. */
  assert.equal(r.manifest.itsm.aggregation.reconciliation.complete, true);
});

test('EMPTY DATA through the scan (Phase 5 closure): with no incidents, problems or changes no catalogue rule passes; each empty rule reaches the manifest, the skipped checks and the store saying its population was empty, that health was not established, and its verdict', async () => {
  const { row, r } = await scan({ incident: [], problem: [], change_request: [], task_sla: [] });
  const m = r.manifest.itsm;
  assert.deepEqual(m.aggregation.passes_over_empty_population, [], 'a pass over an empty population reached the manifest');
  for (const id of ['ITSM-016', 'ITSM-020', 'ITSM-039', 'ITSM-018', 'ITSM-123', 'ITSM-134']) {
    assert.equal(row(id).status, 'evaluated', id);
    assert.equal(row(id).verdict, 'inconclusive', id);
    assert.equal(row(id).findings, 0, id);
  }
  for (const id of ['ITSM-016', 'ITSM-020', 'ITSM-039']) {
    assert.equal(row(id).population_empty, true, id);
    assert.deepEqual([row(id).undetermined.kind, row(id).undetermined.health, row(id).undetermined.verdict], ['empty_population', 'not established', 'inconclusive'], id);
    assert.equal(row(id).population.judged, 0, id);
    const skip = r.manifest.skipped_checks.find((x) => x.source === 'itsm_catalogue' && x.rule === id && x.undetermined === 'empty_population');
    assert.ok(skip, `${id}: the empty population is not a skipped check`);
    assert.match(skip.reason, /health could not be established, so the verdict is inconclusive, not pass/);
  }
  assert.ok(m.aggregation.population_empty.includes('ITSM-020'));
  /* the manifest survives the store round trip with the same reading */
  const runId = openRun();
  completeRun(runId, r);
  const { getRun } = await import('../src/health/store.js');
  const stored = getRun(runId);
  const storedRow = stored.manifest.itsm.rules.find((x) => x.rule_id === 'ITSM-020');
  assert.deepEqual(storedRow.undetermined, row('ITSM-020').undetermined);
  /* and the ITSM score is not touched by it: catalogue verdicts are not scored */
  assert.equal(r.findings.filter((f) => f.domain === 'ITSM').length, m.aggregation.findings);
});

test('SCOPE: a module-limited scan runs the catalogue only when ITSM is read; a CMDB-only scan carries no ITSM result', async () => {
  const { r } = await scan({}, { modules: ['cmdb'] });
  assert.equal(r.manifest.itsm, null);
  assert.equal(r.findings.filter((f) => f.domain === 'ITSM').length, 0);
});

/* ════════════ Stage 5F — configuration and caching ════════════ */

test('CONFIGURATION: an instance override fills an UNDEFINED parameter for the scan and moves only the ITSM engine key; an override the declaration refuses is reported, not applied', async () => {
  setItsmParameterOverride({ ruleId: 'ITSM-129', key: 'problem_reference_threshold', value: 30, by: 'test' });
  setItsmParameterOverride({ ruleId: 'ITSM-129', key: 'not_a_parameter', value: 1, by: 'test' });
  try {
    const built = buildParameterRegistry(itsmParameterOverrides());
    assert.deepEqual(built.applied.map((a) => a.key), ['problem_reference_threshold']);
    assert.deepEqual(built.rejected.map((r) => r.key), ['not_a_parameter']);

    /* staleDays as the scan uses it (its default, 90) — the key covers it too. */
    const before = engineKeys({ staleDays: 90 });
    const after = engineKeys({ staleDays: 90, itsmParameters: built.registry });
    assert.notEqual(after.itsm, before.itsm, 'an instance override did not invalidate the ITSM result');
    for (const m of ['cmdb', 'itom', 'platform']) assert.equal(after[m], before[m], `an ITSM override moved the ${m} key`);

    const { row, r } = await scan({}, { itsm: { parameters: built.registry, rejected: built.rejected } });
    assert.equal(row('ITSM-129').classification, 'EXECUTABLE');
    assert.equal(row('ITSM-129').status, 'evaluated');
    assert.equal(row('ITSM-129').parameters.problem_reference_threshold.source, 'instance');
    assert.deepEqual(r.manifest.itsm.parameters.overrides, { 'ITSM-129.problem_reference_threshold': 30 });
    assert.deepEqual(r.manifest.itsm.parameters.rejected_overrides.map((x) => x.key), ['not_a_parameter']);
    assert.equal(r.manifest.engine_keys.itsm, after.itsm, 'the scan keyed its result with a different registry than it ran');
  } finally {
    clearItsmParameterOverride({ ruleId: 'ITSM-129', key: 'problem_reference_threshold' });
    clearItsmParameterOverride({ ruleId: 'ITSM-129', key: 'not_a_parameter' });
  }
});

test('CONFIGURATION API: every declared parameter is listed with what blocks its rule; a value is validated against its declaration before it is stored; runtime overrides are checked before a run starts', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthRouter);
  const server = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  const base = `http://127.0.0.1:${server.address().port}/api/health`;
  const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const listed = await call('GET', '/itsm/parameters');
    assert.equal(listed.status, 200);
    const gap = listed.body.parameters.find((x) => x.rule_id === 'ITSM-129' && x.key === 'problem_reference_threshold');
    assert.deepEqual([gap.declaration, gap.status, gap.blocks_rule, gap.workbook_default, gap.value], ['UNDEFINED', 'UNCONFIGURED', true, null, null], 'no value may be suggested for an UNDEFINED parameter');
    assert.ok(listed.body.parameters.some((x) => x.declaration === 'DEFINED' && x.source === 'workbook'));

    assert.equal((await call('PUT', '/itsm/parameters/ITSM-129/problem_reference_threshold', { value: 'thirty' })).status, 422);
    assert.equal((await call('PUT', '/itsm/parameters/ITSM-129/invented_key', { value: 30 })).status, 422);
    assert.equal((await call('PUT', '/itsm/parameters/ITSM-999/problem_reference_threshold', { value: 30 })).status, 422);
    const set = await call('PUT', '/itsm/parameters/ITSM-129/problem_reference_threshold', { value: 30 });
    assert.equal(set.status, 200);
    assert.deepEqual([set.body.parameter.status, set.body.parameter.source, set.body.parameter.value, set.body.parameter.blocks_rule], ['RESOLVED', 'instance', 30, false]);

    assert.equal((await call('DELETE', '/itsm/parameters/ITSM-129/problem_reference_threshold')).body.removed, true);
    const again = await call('GET', '/itsm/parameters');
    assert.equal(again.body.parameters.find((x) => x.rule_id === 'ITSM-129' && x.key === 'problem_reference_threshold').status, 'UNCONFIGURED');

    assert.ok(validateRuntimeParameters({ 'ITSM-129': { problem_reference_threshold: 'x' } }).length > 0);
    assert.ok(validateRuntimeParameters({ 'ITSM-129': { invented: 1 } }).length > 0);
    assert.deepEqual(validateRuntimeParameters({ 'ITSM-129': { problem_reference_threshold: 30 } }), []);
    const refused = await call('POST', '/runs', { modules: ['itsm'], itsmParameters: { 'ITSM-129': { problem_reference_threshold: 'x' } } });
    assert.equal(refused.status, 422, 'a run started with an invalid runtime override');
  } finally {
    server.close();
  }
});

test('CACHING: an ITSM result is reused while nothing it read changed, and re-read — naming the table — when a table only the catalogue reads changes', async () => {
  const tables = { ...ESTATE };
  const client = fakeInstance(tables, { absent: ABSENT });
  const first = await runHealthCheck({ client, explain: false, modules: ['itsm'], reuse: false, user: 'admin', now: NOW });
  const stamped = Object.keys(first.manifest.itsm_stamps || {});
  for (const t of ['task_sla', 'sysapproval_approver', 'sys_dictionary', 'sys_db_object']) assert.ok(stamped.includes(t), `${t} was read by the catalogue but not stamped`);
  const m = first.manifest;
  const baselines = { itsm: {
    runId: 'run-1', status: first.status, checkedAt: NOW.toISOString(), engineKey: m.engine_keys.itsm, user: 'admin',
    dependencies: m.dependencies.itsm, degraded: m.degraded.itsm ?? null, stamps: m.stamps, specHashes: m.spec_hashes, metaStamps: m.itsm_stamps,
  } };

  const second = await runHealthCheck({ client, explain: false, modules: ['itsm'], reuse: true, baselines, user: 'admin', now: NOW });
  assert.equal(second.manifest.kind, 'verification', 'an unchanged instance re-read ITSM');
  assert.deepEqual(second.manifest.verified_modules, ['itsm']);

  /* task_sla is read by the catalogue alone — the legacy ITSM rules never touch it. */
  tables.task_sla = [...tables.task_sla, { sys_id: 'sla-new', has_breached: 'false', sla: 'sla-p1', task: 'inc-ok', sys_updated_on: '2026-09-16 11:00:00' }];
  const third = await runHealthCheck({ client, explain: false, modules: ['itsm'], reuse: true, baselines, user: 'admin', now: NOW });
  assert.deepEqual(third.manifest.modules, ['itsm']);
  assert.match(third.manifest.plan.modules.itsm.reasons.join(' '), /task_sla \(read by the ITSM catalogue\): row count moved from 2 to 3/);
});
