import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-overall-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'o.db'))));
const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev000000.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const {
  scoreOverall, moduleContract, healthBand, cmdbCoverage, itomCoverage, itsmCoverage, tableCoverage,
  OVERALL_MODEL, DEFAULT_WEIGHTS, SCORABLE_MODULES,
} = await import('../src/health/overall-health.js');
const { summariseScopes, overallScope, MODULE_KEYS } = await import('../src/health/scopes.js');
const { openRun, completeRun, trend, composedView } = await import('../src/health/store.js');

/*
 * OVERALL HEALTH — the Full System Scan's number (overall-health.js).
 *
 *   overall = Σ w_i × S_i ÷ Σ w_i over the scored areas, equal weights,
 *   missing areas renormalised out; assessment, coverage and Systemic posture
 *   beside it, never in it.
 */

/** A contract as moduleContract would derive it, in one line. */
const mod = (key, score, over = {}) => ({
  key, score, score_kind: key === 'platform' ? 'none' : 'records', coverage: null,
  assessment: { state: score == null ? (key === 'platform' ? 'not_scored' : 'withheld') : 'assessed', blockers: 0, reasons: [] },
  systemic: { blockers: 0, posture: 0, escalated_inside_score: 0 },
  scoring: { model: `${key}/1`, key: `k-${key}` },
  ...over,
});
const four = (cmdb, itom, itsm, platform = null) => ({ cmdb: mod('cmdb', cmdb), itom: mod('itom', itom), itsm: mod('itsm', itsm), platform: mod('platform', platform) });
const close = (a, b, eps = 0.0005) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

/* ── Basic aggregation ────────────────────────────────────────────────── */
test('the current validated scores aggregate to 64.133…, shown as 64.1, with equal effective weights', () => {
  const o = scoreOverall({ modules: four(77.2, 60, 55.2) });
  close(o.score_exact, 64.133);
  assert.equal(o.score, 64.1);
  assert.deepEqual(o.scoring.weights, { cmdb: 0.333, itom: 0.333, itsm: 0.333 });
  assert.equal(o.module_breakdown.platform.included, false);
  assert.equal(o.module_breakdown.platform.weight, 0);
  assert.equal(o.scoring.model, OVERALL_MODEL);
  assert.equal(o.score_kind, 'overall');
});

test('module scores are not rounded before aggregation', () => {
  const o = scoreOverall({ modules: four(77.25, 60.05, 55.15) });
  close(o.score_exact, (77.25 + 60.05 + 55.15) / 3);
});

/* ── Renormalisation ──────────────────────────────────────────────────── */
test('an unavailable scored area is dropped and the rest renormalised: 80 and 60 give 70, not 46.7 and not 80', () => {
  const o = scoreOverall({ modules: four(80, 60, null) });
  assert.equal(o.score, 70);
  assert.deepEqual(o.scoring.participants, ['cmdb', 'itom']);
  assert.equal(o.module_breakdown.itsm.included, false);
  assert.equal(o.module_breakdown.cmdb.effective_weight, 0.5);
  assert.equal(o.status.state, 'incomplete', 'a withheld scored area makes the assessment incomplete');
  assert.match(o.status.reason, /ITSM score withheld/);
});

test('missing is never 0 and never 100: neither imputation reproduces the renormalised result', () => {
  const o = scoreOverall({ modules: four(80, 60, null) });
  assert.notEqual(o.score, Number(((80 + 60 + 0) / 3).toFixed(1)));
  assert.notEqual(o.score, Number(((80 + 60 + 100) / 3).toFixed(1)));
  const none = scoreOverall({ modules: four(null, null, null) });
  assert.equal(none.score, null);
  assert.equal(none.status.state, 'incomplete');
});

/* ── Platform ─────────────────────────────────────────────────────────── */
test('Platform unscored is excluded: 80 / 60 / 60 give 66.666…', () => {
  const o = scoreOverall({ modules: four(80, 60, 60, null) });
  close(o.score_exact, 66.667);
  assert.equal(o.score, 66.7);
  assert.equal(o.module_breakdown.platform.assessment, 'not_scored');
  assert.equal(o.status.state, 'assessed', 'an unscored-by-design area does not make the assessment incomplete');
});

test('Platform later scored under a positive weight joins the mean (80/60/60/80 → 70) and starts a new series', () => {
  const before = scoreOverall({ modules: four(80, 60, 60, null) });
  const platform = mod('platform', 80, { score_kind: 'checks', assessment: { state: 'assessed', blockers: 0, reasons: [] } });
  const after = scoreOverall({ modules: { ...four(80, 60, 60), platform }, weights: { cmdb: 0.25, itom: 0.25, itsm: 0.25, platform: 0.25 } });
  assert.equal(after.score, 70);
  assert.deepEqual(after.scoring.participants, ['cmdb', 'itom', 'itsm', 'platform']);
  assert.notEqual(after.scoring.key, before.scoring.key, 'a fourth participant must be a new series');
  /* With the default weights Platform stays out even if it somehow carried a score. */
  const still = scoreOverall({ modules: { ...four(80, 60, 60), platform } });
  assert.equal(still.module_breakdown.platform.included, false);
});

/* ── Assessment gate ──────────────────────────────────────────────────── */
test('an open CMDB gate keeps the number (86.666…) and makes the assessment incomplete, replacing the health word', () => {
  const cmdb = mod('cmdb', 80, { assessment: { state: 'incomplete', blockers: 7, reasons: ['7 CMDB blockers'] }, systemic: { blockers: 7, posture: 3, escalated_inside_score: 139 } });
  const o = scoreOverall({ modules: { ...four(80, 90, 90), cmdb } });
  close(o.score_exact, 86.667);
  assert.equal(o.status.state, 'incomplete');
  assert.equal(o.status.word, 'Assessment incomplete');
  assert.match(o.status.reason, /7 CMDB blockers/);
  assert.equal(o.health_band.word, 'Mostly healthy', 'the band of the measured part is still exposed');
  assert.equal(o.attribution, null, 'the assessment state takes precedence over attribution');
});

/* ── No double counting ───────────────────────────────────────────────── */
test('Systemic findings already inside the module scores do not move the overall a second time', () => {
  const plain = scoreOverall({ modules: four(77.2, 60, 55.2) });
  const cmdb = mod('cmdb', 77.2, { systemic: { blockers: 0, posture: 3, escalated_inside_score: 139 } });
  const itsm = mod('itsm', 55.2, { systemic: { blockers: 0, posture: 25, escalated_inside_score: 0 } });
  const loaded = scoreOverall({ modules: { ...four(77.2, 60, 55.2), cmdb, itsm } });
  assert.equal(loaded.score, plain.score);
  assert.deepEqual({ blockers: loaded.systemic.blockers, posture: loaded.systemic.posture, escalated_inside_score: loaded.systemic.escalated_inside_score }, { blockers: 0, posture: 28, escalated_inside_score: 139 });
  assert.equal(loaded.status.state, 'assessed', 'posture never gates');
});

/* ── Worst-area attribution ───────────────────────────────────────────── */
test('95 / 95 / 49: overall 79.666… is Mostly healthy, and ITSM is attributed as needing work without changing the number', () => {
  const o = scoreOverall({ modules: four(95, 95, 49) });
  close(o.score_exact, 79.667);
  assert.equal(o.status.word, 'Mostly healthy');
  assert.deepEqual({ key: o.attribution.key, word: o.attribution.word }, { key: 'itsm', word: 'ITSM needs work' });
  assert.equal(o.score, Number(((95 + 95 + 49) / 3).toFixed(1)));
});

test('90 / 60 / 55: overall 68.3 Needs attention, no attribution when the worst area shares the band', () => {
  const o = scoreOverall({ modules: four(90, 60, 55) });
  assert.equal(o.score, 68.3);
  assert.equal(o.status.word, 'Needs attention');
  assert.equal(o.attribution, null);
});

test('the attribution names the worst band first, then the lowest score within it', () => {
  const o = scoreOverall({ modules: four(95, 70, 72) });   // 79 → Mostly healthy; both others Needs attention
  assert.equal(o.attribution.key, 'itom');
});

/* ── Volume invariance ────────────────────────────────────────────────── */
test('finding volume never reaches the overall: 20,000 CMDB / 2 ITOM / 300 ITSM findings with the same scores give the same number', () => {
  const quiet = scoreOverall({ modules: four(77.2, 60, 55.2) });
  const loud = scoreOverall({ modules: {
    cmdb: mod('cmdb', 77.2, { findings: 20000 }), itom: mod('itom', 60, { findings: 2 }), itsm: mod('itsm', 55.2, { findings: 300 }), platform: mod('platform', null, { findings: 52 }),
  } });
  assert.equal(loud.score, quiet.score);
  assert.equal(loud.scoring.key, quiet.scoring.key);
});

/* ── Precedence ───────────────────────────────────────────────────────── */
test('status precedence: Not scanned → Score unavailable → Assessment incomplete → the band', () => {
  const none = scoreOverall({ modules: { cmdb: moduleContract('cmdb', null), itom: moduleContract('itom', null), itsm: moduleContract('itsm', null), platform: moduleContract('platform', null) } });
  assert.equal(none.status.word, 'Not scanned');
  const onlyPlatform = scoreOverall({ modules: { cmdb: moduleContract('cmdb', null), itom: moduleContract('itom', null), itsm: moduleContract('itsm', null), platform: mod('platform', null) } });
  assert.equal(onlyPlatform.status.word, 'Score unavailable');
  const partial = scoreOverall({ modules: { ...four(80, 60, 60), itsm: moduleContract('itsm', null) } });
  assert.equal(partial.status.word, 'Assessment incomplete');
  assert.match(partial.status.reason, /ITSM not scanned/);
  assert.equal(partial.score, 70);
  assert.equal(scoreOverall({ modules: four(92, 91, 95) }).status.word, 'Healthy');
});

test('the bands are the page\'s: 90 / 75 / 50', () => {
  assert.deepEqual([healthBand(90).word, healthBand(89.9).word, healthBand(75).word, healthBand(74.9).word, healthBand(50).word, healthBand(49.9).word],
    ['Healthy', 'Mostly healthy', 'Mostly healthy', 'Needs attention', 'Needs attention', 'Needs work']);
  assert.equal(healthBand(null), null);
});

/* ── Coverage: separate, one definition, never in the number ──────────── */
test('coverage is the weighted mean of the areas that can say, and never touches the score', () => {
  const m = four(80, 60, 60);
  m.cmdb.coverage = 0.8; m.itom.coverage = 1.0; m.itsm.coverage = 0.6; m.platform.coverage = 0.33;
  const o = scoreOverall({ modules: m });
  close(o.coverage, 0.8);
  assert.equal(o.score, 66.7, 'coverage did not move the number');
  const low = scoreOverall({ modules: { ...m, cmdb: { ...m.cmdb, coverage: 0.1 } } });
  assert.equal(low.score, o.score);
  const none = scoreOverall({ modules: four(80, 60, 60) });
  assert.equal(none.coverage, null, 'nothing is invented when no area can say');
});

test('per-area coverage: measured weight, checks lost to a read failure, instance-actionable ITSM gaps, tables read in full', () => {
  const cmdb = cmdbCoverage({ dimensions: [
    { key: 'D1', weight: 40, measured: true, rules_built: 5 }, { key: 'D2', weight: 40, measured: false, rules_built: 3 }, { key: 'D3', weight: 20, measured: false, rules_built: 0 },
  ] });
  assert.equal(cmdb.share, 0.5, 'D3 (no rule built) is a product gap, outside both sides');
  const itom = itomCoverage([
    { result: 'pass' }, { result: 'fail' }, { result: 'not_applicable', gap: 'empty' }, { result: 'not_applicable', gap: 'unavailable' }, { result: 'not_applicable', gap: 'read_failed' },
  ]);
  assert.equal(itom.share, Number((2 / 3).toFixed(3)));
  assert.equal(itomCoverage([{ result: 'pass' }, { result: 'not_applicable' }]), null, 'a run that did not say why cannot say');
  const itsm = itsmCoverage([
    { status: 'evaluated', verdict: 'pass' }, { status: 'evaluated', verdict: 'fail' },
    { status: 'evaluated', verdict: 'inconclusive', undetermined: { kind: 'below_minimum_volume' } },
    { status: 'evaluated', verdict: 'inconclusive', undetermined: { kind: 'empty_population' } },
    { status: 'evaluated', verdict: 'inconclusive', scope: { partial: true } },
    { status: 'unconfigured', blocker: { kind: 'unconfigured_parameter' } },
    { status: 'unavailable', blocker: { kind: 'undefined_object' } },
    { status: 'unavailable', blocker: { kind: 'capability' } },
  ]);
  assert.equal(itsm.share, 0.4, '2 assessed over 2 + 3 instance gaps (thin data, parameter, capability)');
  assert.equal(itsm.excluded, 3);
  const tables = tableCoverage(['a', 'b', 'c', 'd', 'e'], {
    a: { status: 'complete', rows_complete: true }, b: { status: 'limited', rows_complete: true }, c: { status: 'limited', rows_complete: false },
    d: { status: 'forbidden' }, e: { status: 'unavailable' },
  });
  assert.equal(tables.share, 0.5, 'a and b assessed; c and d gaps; e absent from the instance');
});

/* ── The scope summary and the composed view carry it ─────────────────── */
const FULL = (n) => ({ status: 'complete', rows_complete: true, records: n, reported_total: n, missing_fields: [], filter: 'active, or updated in the last 90 days' });

test('summariseScopes: a full scan\'s All scope carries the overall; a module-limited scan\'s does not', () => {
  const coverage = { incident: FULL(4), change_request: FULL(4), problem: FULL(4), ecc_agent: FULL(1), discovery_status: FULL(1), discovery_credentials: FULL(1), cmdb_ci: FULL(2), cmdb_rel_ci: FULL(1) };
  const full = summariseScopes(coverage, [], { overall: { modules: [...MODULE_KEYS] } });
  assert.equal(full.all.score_kind, 'overall');
  assert.ok(full.all.scoring?.key, 'no overall key');
  for (const m of MODULE_KEYS) { assert.ok(full[m].assessment, `${m} has no assessment`); assert.ok(full[m].systemic, `${m} has no systemic`); }
  assert.equal(full.platform.assessment.state, 'not_scored');
  const limited = summariseScopes(coverage, [], { overall: { modules: ['itsm'] } });
  assert.equal(limited.all.score, null);
  assert.equal(limited.all.scoring, null);
  assert.equal(full.itom.scoring.model, 'itom-checks/1');
});

test('composedView: the All scope is the overall over each area\'s latest result, Platform out, stored numbers untouched', async () => {
  const store = (modules, scopes) => {
    const id = openRun({ tables: [], modules });
    completeRun(id, { status: 'completed', manifest: { modules, coverage: {}, scopes, findings_detected: 0, severity_counts: {}, metrics: {} }, findings: [] });
    return id;
  };
  const sum = (key, score, over = {}) => ({ key, score, score_kind: key === 'platform' ? 'none' : 'records', score_drivers: [], severity_counts: {}, domains: [], findings: 0, gate: null, ...over });
  store(['cmdb'], { cmdb: sum('cmdb', 77.2, { gate: { trustworthy: false, blockers: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ rule_id: `CMDB-00${n}` })) }, cmdb_quality: { posture: [1, 2, 3], escalated: new Array(139).fill({}), dimensions: [] } }) });
  store(['itom'], { itom: sum('itom', 60, { checks: [{ result: 'pass', gap: undefined }, { result: 'fail' }] }) });
  store(['itsm'], { itsm: sum('itsm', 55.2, { itsm_quality: { systemic: { findings: 25, rules: [] }, coverage: { share: 0.587 } }, scoring: { model: 'itsm-quality/1', key: 'abc' } }) });
  store(['platform'], { platform: sum('platform', null, { score_withheld_because: 'no denominator', tables: ['sys_script'] }) });
  const v = composedView();
  const a = v.manifest.scopes.all;
  assert.equal(a.score, 64.1);
  assert.equal(a.status.word, 'Assessment incomplete');
  assert.match(a.status.reason, /7 CMDB blockers/);
  assert.equal(a.health_band.word, 'Needs attention');
  assert.deepEqual([a.systemic.blockers, a.systemic.posture, a.systemic.escalated_inside_score], [7, 28, 139]);
  assert.equal(a.module_breakdown.platform.included, false);
  assert.equal(v.manifest.scopes.cmdb.score, 77.2, 'a module score was changed by the overall');
  assert.equal(v.manifest.scopes.platform.score, null);
  assert.equal(a.scoring.module_keys.itsm, 'abc');
});

/* ── Trend: the overall breaks its line on any model change ───────────── */
test('trend: the All scope breaks when a module key, the weights, the overall model or the participants change', async () => {
  const base = () => four(80, 60, 60);
  const point = (o) => {
    const id = openRun({ tables: [], modules: [...MODULE_KEYS] });
    completeRun(id, { status: 'completed', manifest: { modules: [...MODULE_KEYS], coverage: {}, scopes: { all: { score: o.score, score_drivers: [], scoring: o.scoring } }, findings_detected: 0, severity_counts: {}, metrics: {} }, findings: [] });
  };
  const k1 = scoreOverall({ modules: base() });
  const m2 = base(); m2.itsm.scoring = { model: 'itsm-quality/2', key: 'other' };
  const k2 = scoreOverall({ modules: m2 });
  const k3 = scoreOverall({ modules: base(), weights: { cmdb: 0.5, itom: 0.25, itsm: 0.25, platform: 0 } });
  const k4 = scoreOverall({ modules: four(80, 60, null) });
  const k5 = { ...k1, scoring: { ...k1.scoring, model: 'overall-health/2', key: 'v2key' } };
  const keys = new Set([k1, k2, k3, k4, k5].map((x) => x.scoring.key));
  assert.equal(keys.size, 5, 'every change must produce a distinct key');
  point(k1); point(k2); point(k3); point(k4); point(k5); point(k1);
  const pts = trend({ limit: 10 }).filter((p) => p.modules.includes('cmdb')).slice(-6);
  assert.deepEqual(pts.map((p) => p.scopes.all), [k1.score, null, null, null, null, k1.score]);
  assert.ok(pts[1].model_breaks.includes('all'));
});

test('the scorable set and default weights are what the definition says', () => {
  assert.deepEqual([...SCORABLE_MODULES], ['cmdb', 'itom', 'itsm']);
  close(DEFAULT_WEIGHTS.cmdb, 1 / 3); close(DEFAULT_WEIGHTS.itom, 1 / 3); close(DEFAULT_WEIGHTS.itsm, 1 / 3);
  assert.equal(DEFAULT_WEIGHTS.platform, 0);
});
