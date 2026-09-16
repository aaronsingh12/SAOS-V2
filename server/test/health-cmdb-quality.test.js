import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BAND_WEIGHT, CMDB_CATALOGUE, CMDB_DIMENSIONS,
  effectiveBand, scoreCmdbQuality,
} from '../src/health/cmdb-quality.js';
import { EstateRules, IMPLEMENTED_CATALOGUE_RULES } from '../src/health/rules.js';
import { GATE_RULES, cmdbInScope, jobInterval } from '../src/health/cmdb-gate.js';

/*
 * Health Assist — CMDB Quality: the SAOS two-layer score and the trust gate.
 *
 * Decisions of 15 Sep 2026, each pinned here:
 *   1. D1–D10 with the data-quality-tab weights (sum 100); Group 1 outside the 100.
 *   2. Layer 1: BASE-Systemic findings gate the score and never enter it.
 *      Layer 2: record_score = max(0, 100 − Σ w); dimension = mean; composite = Σ weight × dimension.
 *   3. Modifiers stack and clamp Low..Systemic. Escalated-to-Systemic zeroes a
 *      record (w = 100) but does NOT gate.
 *   4. The section is the EFFECTIVE band.
 *
 * Corrections of 18 Sep 2026:
 *   5. Systemic ≠ gate: config_absence and measured_kpi gate; posture neither gates nor scores.
 *   6. A record is charged for its OWN context: `deduction_severity`, never the
 *      class-wide pattern's reporting severity. Patterns deduct nothing.
 *   7. One defect, one charge: findings sharing a `dedupe_key` charge a record once, at the heaviest.
 */

/* ════════════════════════ the catalogue ════════════════════════ */

test('the catalogue is the tracker: 141 CMDB rules, ten dimensions weighing exactly 100', () => {
  assert.equal(Object.keys(CMDB_CATALOGUE).length, 141);
  assert.deepEqual(CMDB_DIMENSIONS.map((d) => d.key), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10']);
  assert.equal(CMDB_DIMENSIONS.reduce((n, d) => n + d.weight, 0), 100);
  assert.deepEqual(Object.fromEntries(CMDB_DIMENSIONS.map((d) => [d.key, d.weight])),
    { D1: 12, D2: 12, D3: 14, D4: 12, D5: 8, D6: 16, D7: 10, D8: 6, D9: 6, D10: 4 });
});

test('Group 1 is the trust gate: outside the 100, no dimension', () => {
  for (const id of GATE_RULES) {
    const r = CMDB_CATALOGUE[id];
    assert.ok(r, `${id} is not in the catalogue`);
    assert.equal(r.group, 1, `${id} is not a Group 1 rule`);
    assert.equal(r.dimension, null, `${id} was given a scoring dimension`);
  }
  assert.equal(CMDB_CATALOGUE['CMDB-139'].title, 'No principal classes designated');
});

test('the table-name corrections are in the catalogue the engine reads', () => {
  assert.ok(!/cmdb_health_inclusion_rule(?! does not exist)/.test(CMDB_CATALOGUE['CMDB-001'].sourceTables), 'CMDB-001 still names the missing table as its source');
  assert.match(CMDB_CATALOGUE['CMDB-001'].sourceTables, /cmdb_health_config/);
  assert.match(CMDB_CATALOGUE['CMDB-047'].detectionLogic, /cmdb_identifier rows WHERE independent=false/);
  assert.match(CMDB_CATALOGUE['CMDB-046'].confidenceBasis, /^INFERRED/);
  assert.match(CMDB_CATALOGUE['CMDB-050'].confidenceBasis, /^INFERRED/);
  assert.match(CMDB_CATALOGUE['CMDB-058'].threshold, /Fallback \(v3\)/);
  /* DQ-003 and DQ-077 are articulated as their own rules (16 Sep). */
  assert.equal(CMDB_CATALOGUE['CMDB-140'].dq, 'DQ-003');
  assert.equal(CMDB_CATALOGUE['CMDB-140'].dimension, 'D1');
  assert.equal(CMDB_CATALOGUE['CMDB-141'].dq, 'DQ-077');
  assert.equal(CMDB_CATALOGUE['CMDB-141'].base, 'SYSTEMIC');
  assert.equal(CMDB_CATALOGUE['CMDB-141'].kind, 'kpi');
  assert.equal(CMDB_CATALOGUE['CMDB-141'].dimension, 'D10');
});

/* ════════════════════════ modifiers ════════════════════════ */

test('modifiers stack — the Schema tab worked examples', () => {
  /* CMDB-105 base High: a dev server nothing references → Low; a core router
     supporting three Business Critical services → Systemic. */
  assert.equal(effectiveBand('HIGH', { deEscalators: ['non_production', 'not_consumed'] }), 'LOW');
  assert.equal(effectiveBand('HIGH', { escalators: ['business_critical_service', 'shared_infrastructure'] }), 'SYSTEMIC');
  /* ITOM-017 base Critical: a lab subnet for two days → Moderate; production for 31 days with downstream damage → Systemic. */
  assert.equal(effectiveBand('CRITICAL', { deEscalators: ['non_production', 'below_materiality'] }), 'MEDIUM');
  assert.equal(effectiveBand('CRITICAL', { escalators: ['production', 'duration_over_30_days', 'cross_domain_cause'] }), 'SYSTEMIC');
});

test('modifiers clamp at Low and Systemic, net against each other, and ignore unknown keys', () => {
  assert.equal(effectiveBand('LOW', { deEscalators: ['non_production', 'retiring', 'not_consumed'] }), 'LOW');
  assert.equal(effectiveBand('SYSTEMIC', { escalators: ['production'] }), 'SYSTEMIC');
  assert.equal(effectiveBand('HIGH', { escalators: ['production'], deEscalators: ['approved_exception'] }), 'HIGH');
  assert.equal(effectiveBand('HIGH', { escalators: ['made_up_reason', 'another'] }), 'HIGH', 'an unknown modifier moved a band');
  assert.throws(() => effectiveBand('MAJOR'), /Unknown base band/);
});

/* ════════════════════════ layer 2 arithmetic ════════════════════════ */

const f = (rule_id, severity, target_ids, extra = {}) => ({ rule_id, severity, target_ids, fingerprint: `${rule_id}:${target_ids.join(',')}`, title: rule_id, ...extra });
const built = (...ids) => new Set(ids);

test('THE 0.3% FIX — one Low finding costs a record 1 point, not the whole record', () => {
  const low = Object.values(CMDB_CATALOGUE).find((r) => r.dimension && r.base === 'LOW');
  const q = scoreCmdbQuality({ findings: [f(low.id, 'LOW', ['a'])], inScope: { ids: ['a'], basis: 't' }, implemented: built(low.id) });
  const d = q.dimensions.find((x) => x.key === low.dimension);
  assert.equal(d.score, 99, 'a record with one Low finding does not score 99');
});

test('record scores floor at 0, and a dimension is the MEAN record score', () => {
  const crit = 'CMDB-012'; // D1, Critical
  const q = scoreCmdbQuality({
    findings: [f(crit, 'CRITICAL', ['a'], { fingerprint: 'x1' }), f(crit, 'CRITICAL', ['a'], { fingerprint: 'x2' }), f(crit, 'CRITICAL', ['a'], { fingerprint: 'x3' }), f(crit, 'HIGH', ['b'])],
    inScope: { ids: ['a', 'b', 'c', 'd'], basis: 't' },
    implemented: built(crit),
  });
  const d1 = q.dimensions.find((x) => x.key === 'D1');
  /* a: 100 − 120 → 0 · b: 85 · c: 100 · d: 100 → mean 71.25 */
  assert.equal(d1.score, 71.3);
  assert.equal(d1.records_affected, 2);
});

test('the composite is Σ weight × dimension over MEASURED dimensions, and says how much weight it covers', () => {
  const q = scoreCmdbQuality({
    findings: [f('CMDB-012', 'CRITICAL', ['a'])],   // D1 (12): a → 60, b → 100 → 80
    inScope: { ids: ['a', 'b'], basis: 't' },
    implemented: built('CMDB-012', 'CMDB-035'),        // D1 and D3 (14) measured; D3 clean → 100
  });
  assert.equal(q.dimensions.find((x) => x.key === 'D1').score, 80);
  assert.equal(q.dimensions.find((x) => x.key === 'D3').score, 100);
  assert.equal(q.composite.measured_weight, 26);
  assert.equal(q.composite.coverage_provisional, true);
  assert.equal(q.composite.coverage_label, 'Provisional — 26 of 100 weight measured');
  assert.equal(q.composite.gate_provisional, false, 'coverage-provisional was merged into gate-provisional');
  assert.equal(q.composite.score, Number(((12 * 80 + 14 * 100) / 26).toFixed(1)));
});

test('a dimension with no built rule is NOT MEASURED — never a clean 100 — and nothing measured means no composite', () => {
  const q = scoreCmdbQuality({ findings: [], inScope: { ids: ['a'], basis: 't' }, implemented: built(...GATE_RULES) });
  assert.ok(q.dimensions.every((d) => d.measured === false && d.score === null));
  assert.equal(q.composite.score, null);
  assert.match(q.composite.not_measured_because, /nothing to average/);
  assert.match(q.dimensions[0].not_measured_because, /No rule in this dimension is built yet/);
});

/* ════════════════════════ layer 1: the gate ════════════════════════ */

test('a BASE-Systemic finding gates the score and never enters the arithmetic', () => {
  const q = scoreCmdbQuality({
    findings: [f('CMDB-001', 'SYSTEMIC', []), f('CMDB-012', 'CRITICAL', ['a'])],
    inScope: { ids: ['a', 'b'], basis: 't' },
    implemented: built('CMDB-001', 'CMDB-012'),
  });
  assert.equal(q.gate.trustworthy, false);
  assert.equal(q.gate.label, 'Score not trustworthy');
  assert.deepEqual(q.gate.blockers.map((b) => b.rule_id), ['CMDB-001']);
  assert.equal(q.composite.gate_provisional, true);
  assert.equal(q.dimensions.find((x) => x.key === 'D1').score, 80, 'the gate finding changed a dimension score');
});

test('ESCALATED-to-Systemic zeroes its record (w = 100) but does NOT trip the gate', () => {
  const q = scoreCmdbQuality({
    findings: [f('CMDB-012', 'SYSTEMIC', ['a'])],     // base Critical, escalated by context
    inScope: { ids: ['a', 'b'], basis: 't' },
    implemented: built('CMDB-012'),
  });
  assert.equal(BAND_WEIGHT.SYSTEMIC, 100);
  assert.equal(q.dimensions.find((x) => x.key === 'D1').score, 50);
  assert.equal(q.gate.trustworthy, true, 'an escalated record finding tripped the governance gate');
  assert.deepEqual(q.escalated.map((e) => e.rule_id), ['CMDB-012']);
  assert.deepEqual(q.gate.blockers, [], 'an escalated finding was listed as a gate blocker');
});

test('SYSTEMIC ≠ GATE: a posture finding neither gates nor scores; a measured KPI gates', () => {
  for (const id of ['CMDB-038', 'CMDB-056', 'CMDB-091', 'CMDB-104', 'CMDB-112', 'CMDB-131']) assert.equal(CMDB_CATALOGUE[id].systemicKind, 'posture', id);
  assert.equal(CMDB_CATALOGUE['CMDB-002'].systemicKind, 'config_absence');
  assert.equal(CMDB_CATALOGUE['CMDB-003'].systemicKind, 'measured_kpi');
  const q = scoreCmdbQuality({
    findings: [f('CMDB-038', 'SYSTEMIC', []), f('CMDB-012', 'CRITICAL', ['a'])],
    inScope: { ids: ['a', 'b'], basis: 't' },
    implemented: built('CMDB-012', 'CMDB-038'),
  });
  assert.equal(q.gate.trustworthy, true, 'a posture finding tripped the gate');
  assert.deepEqual(q.posture.map((p) => [p.rule_id, p.systemic_kind]), [['CMDB-038', 'posture']]);
  assert.equal(q.dimensions.find((x) => x.key === 'D3').measured, false, 'a posture finding produced a D3 measurement');
  const gated = scoreCmdbQuality({ findings: [f('CMDB-003', 'SYSTEMIC', [])], inScope: { ids: ['a'], basis: 't' }, implemented: built('CMDB-003') });
  assert.deepEqual(gated.gate.blockers.map((b) => b.rule_id), ['CMDB-003']);
});

test('A PATTERN NEVER ZEROES RECORDS: the class-wide finding deducts nothing; each record keeps its base deduction', () => {
  const q = scoreCmdbQuality({
    findings: [
      f('CMDB-013', 'CRITICAL', ['a'], { deduction_severity: 'CRITICAL' }),
      f('CMDB-013', 'CRITICAL', ['b'], { deduction_severity: 'CRITICAL' }),
      f('CMDB-013', 'SYSTEMIC', ['a', 'b'], { fingerprint: 'pattern', pattern: true, deduction_severity: null, materiality: { class: 'cmdb_ci_netgear', affected: 2, class_size: 2 } }),
    ],
    inScope: { ids: ['a', 'b'], basis: 't' },
    implemented: built('CMDB-013'),
  });
  assert.equal(q.dimensions.find((x) => x.key === 'D1').score, 60, 'records were not charged exactly Critical (40)');
  assert.deepEqual(q.escalated, [], 'a class-wide pattern was listed as escalated-to-Systemic');
  assert.deepEqual(q.patterns.map((p) => [p.rule_id, p.severity, p.class]), [['CMDB-013', 'SYSTEMIC', 'cmdb_ci_netgear']]);
  assert.ok(q.unscored_findings.some((u) => u.fingerprint === 'pattern'));
});

test('a record whose OWN context is Systemic is still zeroed, even when its reported band is lower', () => {
  const q = scoreCmdbQuality({
    findings: [f('CMDB-012', 'CRITICAL', ['a'], { deduction_severity: 'SYSTEMIC', modifiers: { escalators: ['business_critical_service', 'shared_infrastructure'], de_escalators: ['below_materiality'] } })],
    inScope: { ids: ['a', 'b'], basis: 't' },
    implemented: built('CMDB-012'),
  });
  assert.equal(q.dimensions.find((x) => x.key === 'D1').score, 50);
  assert.deepEqual(q.escalated.map((e) => [e.rule_id, e.records]), [['CMDB-012', 1]]);
});

test('ONE DEFECT, ONE CHARGE: a shared dedupe_key charges a record once, at the heaviest weight; the 5x multiplier replaces, not adds', () => {
  const dup = { dedupe_key: 'dup:1' };
  const symmetric = scoreCmdbQuality({
    findings: [f('CMDB-035', 'CRITICAL', ['a', 'b'], dup), f('CMDB-036', 'CRITICAL', ['a', 'b'], dup), f('CMDB-041', 'HIGH', ['a', 'b'], dup)],
    inScope: { ids: ['a', 'b', 'c', 'd'], basis: 't' },
    implemented: built('CMDB-035', 'CMDB-036', 'CMDB-041'),
  });
  /* a: 60 · b: 60 · c, d: 100 → 80 — not a: 100 − 95 */
  assert.equal(symmetric.dimensions.find((x) => x.key === 'D3').score, 80);
  assert.equal(symmetric.density.defects_per_100_records, 50, 'one duplicate set counted as three defects per record');
  const asymmetric = scoreCmdbQuality({
    findings: [f('CMDB-035', 'CRITICAL', ['a', 'b'], dup), f('CMDB-033', 'CRITICAL', ['a', 'b'], { ...dup, deduction_multiplier: 5 })],
    inScope: { ids: ['a', 'b', 'c', 'd'], basis: 't' },
    implemented: built('CMDB-033', 'CMDB-035'),
  });
  assert.equal(asymmetric.dimensions.find((x) => x.key === 'D3').score, 50, 'the asymmetric set did not zero its records at 5x');
});

test('a finding with an unscored_reason is reported with that reason and deducts nothing; measures pass through', () => {
  const q = scoreCmdbQuality({
    findings: [f('CMDB-039', 'HIGH', ['a'], { unscored_reason: 'reported per discovery-source pair' })],
    inScope: { ids: ['a'], basis: 't' },
    implemented: built('CMDB-039'),
    measures: { open_dedup_tasks: { count: 3 } },
  });
  assert.equal(q.dimensions.find((x) => x.key === 'D3').score, 100);
  assert.deepEqual(q.unscored_findings.map((u) => u.reason), ['reported per discovery-source pair']);
  assert.equal(q.measures.open_dedup_tasks.count, 3);
});

test('a record finding that names no records is reported unscored, not smeared across every record', () => {
  const q = scoreCmdbQuality({
    findings: [f('CMDB-012', 'CRITICAL', [])],
    inScope: { ids: ['a'], basis: 't' },
    implemented: built('CMDB-012'),
  });
  assert.equal(q.dimensions.find((x) => x.key === 'D1').score, 100);
  assert.deepEqual(q.unscored_findings.map((u) => u.rule_id), ['CMDB-012']);
});

test('weighted defect density is reported, but only as a secondary metric', () => {
  const q = scoreCmdbQuality({
    findings: [f('CMDB-012', 'CRITICAL', ['a']), f('CMDB-035', 'LOW', ['a', 'b'])],
    inScope: { ids: ['a', 'b', 'c', 'd'], basis: 't' },
    implemented: built('CMDB-012', 'CMDB-035'),
  });
  assert.equal(q.density.defects_per_100_records, 75);
  assert.equal(q.density.weighted_per_100_records, 1050);
  assert.match(q.density.note, /Secondary/);
});

/* ════════════════════════ Group 1 against fixtures ════════════════════════ */

const NOW = new Date('2026-09-15T06:00:00Z');
const full = (tables) => Object.fromEntries(tables.map((t) => [t, { table: t, status: 'complete', rows_complete: true, missing_fields: [] }]));
const ALL = ['cmdb_ci', 'cmdb_rel_ci', 'cmdb_health_config', 'cmdb_health_metric', 'cmdb_health_metric_pref', 'cmdb_class_info',
  'cmdb_recommended_fields', 'cmdb_data_management_policy', 'cmdb_policy_scheduled_job', 'sysauto_script'];
const ok = { status: 'ok' };

function run(estate, meta = {}, coverage = full(ALL)) {
  const r = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [], ...estate }, coverage, 90, NOW, {
    meta: {
      cmdb: {
        reads: { health_result: ok, class_hierarchy: ok, mandatory_fields: ok, config_matches: ok, job_triggers: ok, policy_executions: ok, pref_audit: ok },
        healthResult: { count: 0, newest: null },
        classes: { byName: { cmdb_ci: { super: null }, cmdb_ci_computer: { super: 'cmdb_ci', sys_id: 'c1' }, cmdb_ci_linux_server: { super: 'cmdb_ci_computer', sys_id: 'c2' }, cmdb_ci_netgear: { super: 'cmdb_ci', sys_id: 'c3' } } },
        mandatory: {},
        configMatches: {},
        jobTriggers: [],
        policyExecutions: {},
        prefAudit: { audited: false, entries: null },
        ...meta,
      },
    },
  });
  const findings = r.analyze().filter((x) => x.rule_id.startsWith('CMDB-0') || x.rule_id === 'CMDB-139');
  const skipped = (rule) => r.skipped.filter((s) => s.rule === rule);
  return { r, findings, byRule: (id) => findings.filter((x) => x.rule_id === id), skipped };
}

const cis = (n, cls = 'cmdb_ci_computer') => Array.from({ length: n }, (_, i) => ({ sys_id: `${cls}-${i}`, name: `ci${i}`, sys_class_name: cls, sys_updated_on: '2026-09-01 00:00:00' }));

test('CMDB-001 fires on a complete, empty cmdb_health_config — as a gate finding — and says what could not be checked', () => {
  const { byRule } = run({ cmdb_ci: cis(3) });
  const [x] = byRule('CMDB-001');
  assert.ok(x, 'CMDB-001 did not fire');
  assert.equal(x.severity, 'SYSTEMIC');
  assert.equal(x.base_severity, 'SYSTEMIC');
  assert.equal(x.gate, true);
  assert.equal(x.false_positive_guard.evaluated, false);
  assert.match(x.false_positive_guard.note, /third-party/);
});

test('CMDB-001 SKIPS — never fires — when the configuration could not be read completely', () => {
  const cov = full(ALL);
  cov.cmdb_health_config = { table: 'cmdb_health_config', status: 'forbidden', rows_complete: false };
  const { byRule, skipped } = run({ cmdb_ci: cis(3) }, {}, cov);
  assert.equal(byRule('CMDB-001').length, 0, '"could not read" became "does not exist"');
  assert.match(skipped('CMDB-001')[0].reason, /not read completely/);
});

test('CMDB-003 and CMDB-005 are subsumed by CMDB-001 rather than repeating it', () => {
  const { byRule, skipped } = run({ cmdb_ci: cis(3) });
  assert.equal(byRule('CMDB-003').length + byRule('CMDB-005').length, 0);
  assert.match(skipped('CMDB-003')[0].reason, /Subsumed by CMDB-001/);
  assert.match(skipped('CMDB-005')[0].reason, /Subsumed by CMDB-001/);
});

test('CMDB-139 fires when no class is principal, and principal-scoped rules name the fallback', () => {
  const { byRule, skipped } = run({ cmdb_ci: cis(3), cmdb_class_info: [{ sys_id: 'i1', class: 'cmdb_ci_computer', principal_class: 'false' }] });
  assert.equal(byRule('CMDB-139').length, 1);
  assert.equal(byRule('CMDB-139')[0].severity, 'CRITICAL');
  assert.equal(byRule('CMDB-139')[0].gate, false);
  assert.match(byRule('CMDB-006')[0].description, /fallback: all 1 populated classes/);
  assert.equal(skipped('CMDB-139').length, 0);
});

test('CMDB-006 fires only for classes with no configured or mandatory attribute anywhere in their lineage', () => {
  const estate = { cmdb_ci: [...cis(2, 'cmdb_ci_computer'), ...cis(2, 'cmdb_ci_linux_server')] };
  const mandatoryOnParent = run(estate, { mandatory: { cmdb_ci_computer: ['serial_number'] } });
  assert.equal(mandatoryOnParent.byRule('CMDB-006').length, 0, 'an inherited mandatory field was ignored');
  const bare = run(estate);
  assert.equal(bare.byRule('CMDB-006').length, 1);
  assert.match(bare.byRule('CMDB-006')[0].description, /2 of 2 classes/);
  const recommended = run({ ...estate, cmdb_recommended_fields: [{ sys_id: 'r', table: 'cmdb_ci', recommended: 'name', active: 'true' }] });
  assert.equal(recommended.byRule('CMDB-006').length, 0, 'an active recommended field on the base class was ignored');
});

test('CMDB-007 fires on inactive health jobs, and not on a job that is scheduled and producing results', () => {
  const inactive = run({ sysauto_script: [{ sys_id: 'j1', name: 'CMDB Health Dashboard - Completeness Score Calculation', active: 'false', run_type: 'daily' }] });
  assert.equal(inactive.byRule('CMDB-007').length, 1);
  assert.match(inactive.byRule('CMDB-007')[0].description, /1 inactive/);

  const healthy = run(
    { sysauto_script: [{ sys_id: 'j1', name: 'CMDB Health Dashboard - Completeness Score Calculation', active: 'true', run_type: 'daily' }] },
    { jobTriggers: [{ document_key: 'j1', state: '0', next_action: '2026-09-15 11:00:00' }], healthResult: { count: 40, newest: '2026-09-14 11:00:00' } },
  );
  assert.equal(healthy.byRule('CMDB-007').length, 0, 'a healthy job was reported');

  const unscheduled = run(
    { sysauto_script: [{ sys_id: 'j1', name: 'CMDB Health Dashboard - Completeness Score Calculation', active: 'true', run_type: 'daily' }] },
    { jobTriggers: [], healthResult: { count: 40, newest: '2026-09-14 11:00:00' } },
  );
  assert.equal(unscheduled.byRule('CMDB-007').length, 1, 'an active job with no trigger was not reported');
});

test('CMDB-007 skips when no job matches the configured name rather than asserting the jobs are fine', () => {
  const { byRule, skipped } = run({ sysauto_script: [] });
  assert.equal(byRule('CMDB-007').length, 0);
  assert.match(skipped('CMDB-007')[0].reason, /No scheduled job named like/);
});

test('CMDB-010: an unscheduled policy template is not "never executed"; a scheduled one with no run is', () => {
  const policy = (job, created = '2025-01-01 00:00:00') => ({ sys_id: 'p1', name: 'Dependent CI - Retire', policy_execution_job: job, sys_created_on: created });
  assert.equal(run({ cmdb_data_management_policy: [policy('')] }).byRule('CMDB-010').length, 0, 'dev424910 had exactly this, and it is not a defect');
  const jobs = [{ sys_id: 'job', active: 'true', run_type: 'daily' }];
  assert.equal(run({ cmdb_data_management_policy: [policy('job')], cmdb_policy_scheduled_job: jobs }, { policyExecutions: { p1: 0 } }).byRule('CMDB-010').length, 1);
  assert.equal(run({ cmdb_data_management_policy: [policy('job', '2026-09-15 01:00:00')], cmdb_policy_scheduled_job: jobs }, { policyExecutions: { p1: 0 } }).byRule('CMDB-010').length, 0,
    'a policy created within its current cycle was reported');
});

test('CMDB-011 cannot be evaluated when the weights table is not audited — it skips with that reason', () => {
  const { byRule, skipped } = run({ cmdb_health_metric_pref: [{ sys_id: 'w', metric: 'm', weighted_average_contribution: '40' }] });
  assert.equal(byRule('CMDB-011').length, 0);
  assert.match(skipped('CMDB-011')[0].reason, /not audited/);
});

test('with inclusion rules present: CMDB-002 zero-match, CMDB-003 coverage, CMDB-004 principal predicate, CMDB-008 overlap', () => {
  const configs = [
    { sys_id: 'h1', applies_to: 'cmdb_ci_computer', active_record_condition: 'install_status=1', metric: 'm1', sys_created_on: '2025-01-01 00:00:00' },
    { sys_id: 'h2', applies_to: 'cmdb_ci', active_record_condition: 'install_status!=7', metric: 'm1', sys_created_on: '2025-01-01 00:00:00' },
  ];
  const estate = {
    /* netgear sits outside the computer branch; linux_server extends computer, so a computer rule reaches it. */
    cmdb_ci: [...cis(2, 'cmdb_ci_computer'), ...cis(8, 'cmdb_ci_netgear')],
    cmdb_health_config: configs,
    cmdb_class_info: [{ sys_id: 'i', class: 'cmdb_ci_computer', principal_class: 'true' }],
  };
  const { byRule } = run(estate, { configMatches: { h1: 0, h2: 10 } });
  assert.equal(byRule('CMDB-002').length, 1, 'a rule matching zero CIs was not reported');
  assert.equal(byRule('CMDB-003').length, 0, 'coverage is 100% here');
  assert.equal(byRule('CMDB-004').length, 1, 'a rule spanning principal and non-principal classes with no predicate was not reported');
  assert.equal(byRule('CMDB-008').length, 1, 'overlapping rules for one metric with different conditions were not reported');

  const narrow = run({ ...estate, cmdb_health_config: [configs[0]] }, { configMatches: { h1: 2 } });
  const [cov] = narrow.byRule('CMDB-003');
  assert.ok(cov, 'coverage of 20% was not reported');
  assert.equal(cov.severity, 'SYSTEMIC');
  assert.equal(narrow.byRule('CMDB-005').length, 1);
});

test('the in-scope population is what the inclusion rules reach — or every CI, with that stated', () => {
  const none = new EstateRules({ cmdb_ci: cis(3) }, full(ALL), 90, NOW, { meta: { cmdb: { reads: { class_hierarchy: ok } } } });
  const s = cmdbInScope(none);
  assert.equal(s.ids.length, 3);
  assert.match(s.basis, /no inclusion rule exists/);

  const some = new EstateRules({
    cmdb_ci: [...cis(2, 'cmdb_ci_computer'), { sys_id: 'x', sys_class_name: 'cmdb_ci' }],
    cmdb_health_config: [{ sys_id: 'h', applies_to: 'cmdb_ci_computer' }],
  }, full(ALL), 90, NOW, { meta: { cmdb: { reads: { class_hierarchy: ok }, classes: { byName: { cmdb_ci: { super: null }, cmdb_ci_computer: { super: 'cmdb_ci' } } } } } });
  assert.equal(cmdbInScope(some).ids.length, 2);
});

test('job intervals come from the job itself', () => {
  assert.equal(jobInterval({ run_type: 'daily' }), 86_400);
  assert.equal(jobInterval({ run_type: 'periodically', run_period: '1970-01-01 00:05:00' }), 300);
  assert.equal(jobInterval({ run_type: 'once' }), null);
});

test('every implemented catalogue rule is in the catalogue, and the gate rules are all implemented', () => {
  for (const id of IMPLEMENTED_CATALOGUE_RULES) assert.ok(CMDB_CATALOGUE[id], `${id} is implemented but not catalogued`);
  for (const id of GATE_RULES) assert.ok(IMPLEMENTED_CATALOGUE_RULES.has(id));
});
