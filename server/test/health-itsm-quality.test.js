import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-itsmq-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'q.db'))));
const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev000000.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const {
  scoreItsmQuality, itsmScoringComparability, ITSM_SCORING_MODEL, ITSM_BLEND, DEFECT_FAMILIES, LEGACY_ITSM_RULES,
} = await import('../src/health/itsm-quality.js');
const { BAND_WEIGHT } = await import('../src/health/cmdb-quality.js');
const { summariseScopes } = await import('../src/health/scopes.js');
const { isComplete } = await import('../src/health/rules.js');
const { openRun, completeRun, trend } = await import('../src/health/store.js');

/*
 * ITSM Quality — the ITSM score as a per-record capped deduction blended with
 * the estate-level rule pass share (itsm-quality.js, 21 Sep 2026).
 *
 * The model replaced a record pass rate in which one Moderate finding failed a
 * whole record. Every case here is a property the pass rate could not have:
 * severity moves the number, a record is charged once per defect, missing data
 * is out of the denominator and said, and a Systemic finding is beside the
 * score rather than in it.
 */

const FULL = (n, extra = {}) => ({ status: 'complete', rows_complete: true, records: n, reported_total: n, missing_fields: [], filter: 'active, or updated in the last 90 days', ...extra });
const cov3 = (i = 10, c = 10, p = 10) => ({ incident: FULL(i), change_request: FULL(c), problem: FULL(p) });
const ids = (prefix, n) => Array.from({ length: n }, (_, k) => `${prefix}${k + 1}`);
const pop3 = (i = 10, c = 10, p = 10) => ({ incident: new Set(ids('i', i)), change_request: new Set(ids('c', c)), problem: new Set(ids('p', p)) });
/** A legacy finding: one record, severity asserted. */
const legacy = (rule, table, id, severity = 'MEDIUM') => ({ rule_id: rule, domain: 'INCIDENT', table, target_ids: [id], severity, title: rule });
/** A catalogue finding: base severity, a kind, any number of records. */
const cat = (rule, table, targets, severity, kind = 'record') => ({ rule_id: rule, domain: 'ITSM', table, target_ids: targets, severity, base_severity: severity, kind, title: rule });
/** A catalogue rule row as integration.js normalises it. */
const row = (rule_id, engine, status, verdict = null, over = {}) => ({ rule_id, engine, status, verdict, base_severity: 'High', population_empty: false, population: { total: 5, judged: 5 }, ...over });

const score = (coverage, findings, { rules = null, population = undefined } = {}) => scoreItsmQuality({
  coverage, findings, rules, population: population === undefined ? pop3(coverage.incident?.records ?? 0, coverage.change_request?.records ?? 0, coverage.problem?.records ?? 0) : population,
  isComplete: (t) => isComplete(coverage, t),
});

/* ── 1. Empty tables ──────────────────────────────────────────────────── */
test('empty ITSM tables and no estate-level verdict: the score is withheld, never 100', () => {
  const q = score(cov3(0, 0, 0), []);
  assert.equal(q.score, null);
  assert.match(q.withheld, /empty/);
  assert.equal(q.quality.population.records, 0);
});

test('empty tables but estate-level rules evaluated: the rule part stands alone and the basis says so', () => {
  const q = score(cov3(0, 0, 0), [], { rules: [row('ITSM-080', 'configuration', 'evaluated', 'pass'), row('ITSM-113', 'composite', 'evaluated', 'fail')] });
  assert.equal(q.score, 50);
  assert.equal(q.quality.record_part, null);
  assert.equal(q.quality.rule_part, 50);
  assert.match(q.basis, /rule part alone/);
});

/* ── 2. All clean ─────────────────────────────────────────────────────── */
test('all records clean and every estate-level rule passing scores exactly 100', () => {
  const q = score(cov3(), [], { rules: [row('ITSM-080', 'configuration', 'evaluated', 'pass'), row('ITSM-033', 'aggregate', 'evaluated', 'pass')] });
  assert.equal(q.score, 100);
  assert.equal(q.quality.records.clean, 30);
  assert.deepEqual(q.drivers, []);
});

/* ── 3. All failing ───────────────────────────────────────────────────── */
test('every record carrying 100 points and every estate-level rule failing scores exactly 0', () => {
  const findings = [];
  for (const t of ['incident', 'change_request', 'problem']) {
    for (const id of ids(t[0], 10)) {
      findings.push(cat('ITSM-A', t, [id], 'CRITICAL'), cat('ITSM-B', t, [id], 'CRITICAL'), cat('ITSM-C', t, [id], 'CRITICAL'));   // 120 > 100, floored
    }
  }
  const q = score(cov3(), findings, { rules: [row('ITSM-080', 'configuration', 'evaluated', 'fail')] });
  assert.equal(q.score, 0);
  assert.equal(q.quality.record_part, 0);
  assert.equal(q.quality.rule_part, 0);
});

/* ── 4 & 5. One finding, by severity ─────────────────────────────────── */
test('one Critical finding on one of 30 records costs 40/30 points; one Moderate costs 5/30 — severity moves the number, a record is never simply failed', () => {
  const critical = score(cov3(), [legacy('ITSM-INC-P1-AGED', 'incident', 'i1', 'CRITICAL')]);
  const moderate = score(cov3(), [legacy('ITSM-INC-STALE', 'incident', 'i1', 'MEDIUM')]);
  const low = score(cov3(), [legacy('ITSM-INC-NO-CI', 'incident', 'i1', 'LOW')]);
  assert.equal(critical.score, Number((100 - 40 / 30).toFixed(1)));
  assert.equal(moderate.score, Number((100 - 5 / 30).toFixed(1)));
  assert.equal(low.score, Number((100 - 1 / 30).toFixed(1)));
  assert.ok(critical.score < moderate.score && moderate.score < low.score);
  /* The pass rate would have read 96.7 for all three. */
});

/* ── 6. Several findings on one record ───────────────────────────────── */
test('several findings on one record add up, and the record cannot lose more than 100', () => {
  const two = score(cov3(), [legacy('ITSM-CHG-STALE', 'change_request', 'c1', 'MEDIUM'), legacy('ITSM-CHG-OVERDUE', 'change_request', 'c1', 'MEDIUM')]);
  assert.equal(two.score, Number((100 - 10 / 30).toFixed(1)), 'two distinct Moderate charges are 10 points');
  const many = score(cov3(), ['A', 'B', 'C', 'D', 'E'].map((r) => cat(`ITSM-${r}`, 'change_request', ['c1'], 'CRITICAL')));
  assert.equal(many.score, Number((100 - 100 / 30).toFixed(1)), 'five Criticals (200) are floored at 100 on the one record');
  assert.equal(many.quality.records.charged, 1);
});

/* ── 7. Duplicates: one defect, two rules ──────────────────────────────── */
test('a legacy rule and its catalogue twin charge a record once, at the heavier weight — the findings themselves both remain', () => {
  assert.equal(DEFECT_FAMILIES['ITSM-INC-P1-AGED'], DEFECT_FAMILIES['ITSM-037']);
  const findings = [legacy('ITSM-INC-P1-AGED', 'incident', 'i1', 'HIGH'), cat('ITSM-037', 'incident', ['i1'], 'CRITICAL')];
  const q = score(cov3(), findings);
  assert.equal(q.score, Number((100 - 40 / 30).toFixed(1)), 'max(15, 40), not 55');
  assert.equal(q.quality.records.merged_by_family, 1);
  assert.equal(q.drivers.length, 2, 'both rules still appear as drivers');
  /* Two catalogue findings of ONE rule on one record are one charge too. */
  const same = score(cov3(), [cat('ITSM-026', 'incident', ['i1'], 'HIGH'), cat('ITSM-026', 'incident', ['i1', 'i2'], 'HIGH')]);
  assert.equal(same.quality.records.charges, 2, 'i1 once, i2 once');
});

/* ── 8. Many findings, one record ────────────────────────────────────── */
test('a thousand findings on one record cannot move the score by more than that record\'s share', () => {
  const findings = Array.from({ length: 1000 }, (_, k) => cat(`ITSM-R${k}`, 'incident', ['i1'], 'CRITICAL'));
  const q = score(cov3(), findings);
  assert.equal(q.score, Number((100 - 100 / 30).toFixed(1)));
});

/* ── 9. Unreadable table ─────────────────────────────────────────────── */
test('a table that could not be read is out of the denominator and named — never unhealthy, never clean', () => {
  const coverage = { incident: FULL(10), change_request: { status: 'forbidden', rows_complete: false, records: null, missing_fields: [] }, problem: FULL(10) };
  const q = scoreItsmQuality({
    coverage, isComplete: (t) => isComplete(coverage, t), population: { incident: new Set(ids('i', 10)), problem: new Set(ids('p', 10)) },
    findings: [legacy('ITSM-INC-STALE', 'incident', 'i1'), legacy('ITSM-CHG-STALE', 'change_request', 'c1')],   // the change finding cannot be scored
  });
  assert.equal(q.quality.population.records, 20);
  assert.deepEqual(q.quality.population.tables.excluded, ['change_request']);
  assert.match(q.basis, /change_request excluded/);
  assert.equal(q.score, Number((100 - 5 / 20).toFixed(1)));
  const none = scoreItsmQuality({ coverage: { incident: { status: 'forbidden', records: null }, change_request: { status: 'unavailable', records: null } }, findings: [], isComplete: () => false });
  assert.equal(none.score, null);
  assert.match(none.withheld, /None of incident, change_request, problem were read completely/);
});

/* ── 10. Partially available: a finding outside the slice ────────────── */
test('a catalogue finding that names a record outside the extracted slice is counted, disclosed and not charged', () => {
  const q = score(cov3(), [cat('ITSM-057', 'incident', ['i1', 'i2', 'old-closed-1', 'old-closed-2'], 'CRITICAL')]);
  assert.equal(q.quality.records.outside_population, 2);
  assert.equal(q.quality.records.charged, 2);
  assert.equal(q.score, Number((100 - 80 / 30).toFixed(1)));
});

test('a stored run that kept no record slice charges only the legacy rules, which read the slice by construction, and says so', () => {
  const q = score(cov3(), [legacy('ITSM-INC-STALE', 'incident', 'i1'), cat('ITSM-057', 'incident', ['i1', 'i2'], 'CRITICAL')], { population: null });
  assert.equal(q.quality.records.unbounded_catalogue, 1);
  assert.equal(q.score, Number((100 - 5 / 30).toFixed(1)));
  assert.match(q.basis, /did not keep its record slice/);
});

/* ── 11 & 12. Inconclusive, unconfigured, unavailable, vacuous ────────── */
test('inconclusive, unconfigured, unavailable, skipped and vacuous-pass rules are out of the rule part and counted', () => {
  const rules = [
    row('ITSM-001', 'aggregate', 'evaluated', 'fail'),
    row('ITSM-002', 'configuration', 'evaluated', 'pass'),
    row('ITSM-003', 'aggregate', 'evaluated', 'inconclusive'),
    row('ITSM-004', 'composite', 'unconfigured'),
    row('ITSM-005', 'configuration', 'unavailable'),
    row('ITSM-006', 'aggregate', 'skipped'),
    row('ITSM-007', 'aggregate', 'evaluated', 'pass', { population_empty: true, population: { total: 0, judged: 0 } }),           // vacuous
    row('ITSM-008', 'aggregate', 'evaluated', 'pass', { population_empty: true, population: { total: 0, judged: 0, determinate_when_empty: 'no SLA definitions means none can breach' } }),
  ];
  const q = score(cov3(), [], { rules });
  assert.equal(q.quality.rule_part, Number(((100 * 2) / 3).toFixed(1)), 'ITSM-002 and ITSM-008 pass, ITSM-001 fails; nothing else counts');
  assert.deepEqual(
    [q.quality.rules.inconclusive, q.quality.rules.unconfigured, q.quality.rules.unavailable, q.quality.rules.skipped, q.quality.rules.vacuous_pass],
    [1, 1, 1, 1, 1],
  );
  assert.equal(q.quality.rules.determinate, 4);
});

test('a record-engine rule reaches the score only through the records it charged: its pass lifts nothing, its fail is its findings', () => {
  const rules = [row('ITSM-119', 'linkage', 'evaluated', 'pass'), row('ITSM-020', 'text_analysis', 'evaluated', 'fail'), row('ITSM-080', 'configuration', 'evaluated', 'fail')];
  const q = score(cov3(), [cat('ITSM-020', 'incident', ['i1'], 'CRITICAL')], { rules });
  assert.equal(q.quality.rules.record_rules, 2);
  assert.equal(q.quality.rule_part, 0, 'only ITSM-080 is in the rule part');
  assert.equal(q.quality.record_part, Number((100 - 40 / 30).toFixed(1)));
});

/* ── Systemic: posture, never a charge, never a gate ─────────────────── */
test('a base-Systemic finding is surfaced as posture and charges no record; a Systemic estate rule is out of the rule part', () => {
  const findings = [cat('ITSM-130', 'incident', ['i1', 'i2'], 'SYSTEMIC', 'relationship'), cat('ITSM-017', 'incident', [], 'SYSTEMIC', 'aggregate')];
  const rules = [row('ITSM-017', 'aggregate', 'evaluated', 'fail', { base_severity: 'Systemic' }), row('ITSM-080', 'configuration', 'evaluated', 'pass')];
  const q = score(cov3(), findings, { rules });
  assert.equal(q.quality.record_part, 100);
  assert.equal(q.quality.rule_part, 100);
  assert.equal(q.score, 100);
  assert.equal(q.quality.systemic.findings, 2);
  assert.deepEqual(q.quality.systemic.rules.map((r) => r.rule_id).sort(), ['ITSM-017', 'ITSM-130']);
  assert.equal(q.quality.rules.systemic_excluded, 1);
});

/* ── 13. Catalogue expansion ─────────────────────────────────────────── */
test('a newly evaluated rule changes coverage, not the model: the comparability key is stable and the number moves only by what it finds', () => {
  const before = score(cov3(), [cat('ITSM-026', 'incident', ['i1'], 'HIGH')], { rules: [row('ITSM-080', 'configuration', 'evaluated', 'pass')] });
  const after = score(cov3(), [cat('ITSM-026', 'incident', ['i1'], 'HIGH')], { rules: [row('ITSM-080', 'configuration', 'evaluated', 'pass'), row('ITSM-033', 'aggregate', 'evaluated', 'pass'), row('ITSM-NEW', 'record_predicate', 'evaluated', 'pass')] });
  assert.equal(before.quality.scoring.key, after.quality.scoring.key);
  assert.equal(before.score, after.score, 'two passing rules added: one estate-level (100 → 100), one record-level (lifts nothing)');
  const expanded = [row('ITSM-080', 'configuration', 'evaluated', 'pass'), row('ITSM-033', 'aggregate', 'evaluated', 'pass'), row('ITSM-NEW', 'record_predicate', 'evaluated', 'fail')];
  const found = score(cov3(), [cat('ITSM-026', 'incident', ['i1'], 'HIGH'), cat('ITSM-NEW', 'incident', ['i2'], 'MEDIUM')], { rules: expanded });
  assert.ok(found.score < before.score, 'a new rule that finds something lowers it by exactly its charge');
});

test('the blend and the weights are the CMDB model\'s own, and the key changes when they would', () => {
  assert.deepEqual({ record: ITSM_BLEND.record, kpi: ITSM_BLEND.kpi }, { record: 0.6, kpi: 0.4 });
  assert.equal(BAND_WEIGHT.CRITICAL, 40);
  const a = itsmScoringComparability();
  assert.equal(a.model, ITSM_SCORING_MODEL);
  assert.match(a.key, /^[0-9a-f]{16}$/);
  assert.equal(a.key, itsmScoringComparability().key, 'deterministic');
  assert.equal(LEGACY_ITSM_RULES.length, 11);
});

/* ── The scope summary carries the contract, the parts and the key ────── */
test('summariseScopes: the ITSM summary keeps its contract and adds the parts, the population and the comparability key', () => {
  const coverage = cov3(2, 2, 2);
  const findings = [legacy('ITSM-INC-STALE', 'incident', 'i1'), cat('ITSM-017', 'incident', [], 'SYSTEMIC', 'aggregate')];
  const s = summariseScopes(coverage, findings, { itsm: { rules: [row('ITSM-080', 'configuration', 'evaluated', 'pass')], population: pop3(2, 2, 2) } }).itsm;
  for (const k of ['score', 'score_basis', 'score_definition', 'score_withheld_because', 'score_drivers', 'findings', 'severity_counts', 'score_kind']) assert.ok(k in s, `missing ${k}`);
  assert.equal(s.score, Number((0.6 * (100 - 5 / 6) + 0.4 * 100).toFixed(1)));
  assert.equal(s.itsm_quality.model, ITSM_SCORING_MODEL);
  assert.equal(s.scoring.key, itsmScoringComparability().key);
  assert.equal(s.gate, null, 'ITSM has no trust gate: Systemic is posture');
  assert.equal(s.itsm_quality.systemic.findings, 1);
  assert.equal(s.severity_counts.SYSTEMIC, 1, 'the posture finding is still counted in the severities');
  assert.equal(summariseScopes(coverage, findings, { itsm: null }).cmdb.itsm_quality, null);
});

/* ── The trend refuses to join two models ────────────────────────────── */
test('trend: an ITSM point from the pass-rate era is a gap beside points under itsm-quality/1, never a line through it', async () => {
  const mk = async (scopesItsm) => {
    const id = openRun({ tables: [], modules: ['itsm'] });
    completeRun(id, {
      status: 'completed',
      manifest: { modules: ['itsm'], coverage: {}, scopes: { itsm: scopesItsm }, findings_detected: 0, severity_counts: {}, metrics: {} },
      findings: [],
    });
    return id;
  };
  await mk({ score: 0.7, score_drivers: [] });                                                        // the old pass rate: no scoring key
  await mk({ score: 61.2, score_drivers: [], scoring: { model: 'itsm-quality/0', key: 'deadbeefdeadbeef' } });
  await mk({ score: 63.9, score_drivers: [], scoring: itsmScoringComparability() });
  await mk({ score: 65.1, score_drivers: [], scoring: itsmScoringComparability() });
  const points = trend({ limit: 10 }).filter((p) => p.modules.includes('itsm'));
  assert.deepEqual(points.map((p) => p.scopes.itsm), [null, null, 63.9, 65.1]);
  assert.deepEqual(points.slice(0, 2).map((p) => p.model_breaks), [['itsm'], ['itsm']]);
  assert.equal(points[2].model_breaks, undefined);
});
