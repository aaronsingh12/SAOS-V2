import test from 'node:test';
import assert from 'node:assert/strict';

import { CMDB_CATALOGUE, BLEND_BY_KIND, scoreCmdbQuality } from '../src/health/cmdb-quality.js';
import { EstateRules, IMPLEMENTED_CATALOGUE_RULES, scoringComparability } from '../src/health/rules.js';
import { DRIFT_RULES, DRIFT_TRACKS, cmdbRecurrencePass, cmdbDriftRules, cmdbScoreTrend } from '../src/health/cmdb-drift.js';
import { cmdbHistoryFromRuns, cmdbSnapshotEligibility, comparableHistory, TREND_MEASURE_KEYS, TREND_RULE_INPUTS, MEASURE_COMPARABILITY, CMDB_RULE_PREFIX } from '../src/health/cmdb-history.js';
import fs from 'node:fs';
import { trackMisroutes } from '../src/health/cmdb-csdm.js';
import { scopeOfRule } from '../src/health/scopes.js';

/*
 * Health Assist — Group 14 (Drift and regression), Sep 2026. The last CMDB group.
 *
 * Trend rules compare THIS run with earlier ones, so almost everything worth
 * testing is about which earlier runs may be compared at all. Measured on
 * dev424910's own history: two consecutive CMDB runs read 82.1 then 77.0 and held
 * 11,618 then 20,954 findings — entirely because rules changed that week. A trend
 * rule that compared them would have reported a declining estate that had not
 * moved.
 */

const NOW = new Date('2026-09-16T06:00:00Z');
const ok = { status: 'ok' };
const TABLES = ['cmdb_ci', 'cmdb_rel_ci', 'cmdb_data_management_task'];
const full = (over = {}) => Object.fromEntries(TABLES.map((t) => [t,
  { table: t, status: 'complete', rows_complete: true, missing_fields: [], ...(over[t] || {}) }]));
const KEY = () => scoringComparability().key;

function engine({ estate = {}, history = {}, coverage = full() } = {}) {
  const r = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [], ...estate }, coverage, 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok }, classes: { byName: {} }, virtualIds: [], usedFor: {}, choices: [] } },
    history,
  });
  return r;
}
const reason = (r, id) => r.skipped.filter((s) => s.rule === id).map((s) => s.reason).join(' | ');
const byRule = (r, id) => r.findings.filter((f) => f.rule_id === id);
const ci = (id) => ({ sys_id: id, name: id, sys_class_name: 'cmdb_ci_server', install_status: '1' });
/** A catalogued D1 record finding (CMDB-012, base CRITICAL) on one CI. */
const serialFinding = (r, id) => r.addCatalogued('CMDB-012', 'cmdb_ci', [ci(id)], ['serial_number'], `serial missing on ${id}`, {
  escalators: [], deEscalators: [], notEvaluated: ['recurred'],
});
const snap = (at, findings, extra = {}) => ({ run_id: at, at, comparability: { key: KEY() }, composite: null, dimensions: {}, kpis: {}, duplicate_keys: null, findings, ...extra });

/* ════════════ the track and the catalogue ════════════ */

test('Group 14 is built, on the trend track, and never scores or gates', () => {
  for (const id of DRIFT_RULES) {
    assert.ok(IMPLEMENTED_CATALOGUE_RULES.has(id), id);
    assert.equal(CMDB_CATALOGUE[id].track, 'trend', `${id} must be a trend rule`);
    assert.equal(CMDB_CATALOGUE[id].dimension, null, `${id} must not score`);
  }
  assert.deepEqual(trackMisroutes(CMDB_CATALOGUE, DRIFT_TRACKS), []);
  /* CMDB-131 is Systemic POSTURE — surfaced, never a gate blocker. */
  assert.equal(CMDB_CATALOGUE['CMDB-131'].systemicKind, 'posture');
});

/* ════════════ the history reader — the bug that hid for three groups ════════════ */

const manifest = (over = {}) => ({
  kind: 'scan', modules: ['cmdb'], comparability: { key: KEY() }, findings_truncated: false, degraded: {},
  cmdb_quality: {
    composite: { score: 70, measured_weight: 80 },
    dimensions: [{ key: 'D1', score: 70, kpis: [{ rule_id: 'CMDB-046', pass_pct: 50 }] }],
    measures: Object.fromEntries(TREND_MEASURE_KEYS.map((k) => [k, k === 'duplicate_sets' ? { at: 'x', keys: ['k1'], complete: true } : k === 'relationship_counts' ? { at: 'x', total: 5 } : { at: 'x' }])),
  },
  ...over,
});

test('REGRESSION: every trend measure reaches the rules, not just the two the old reader returned', () => {
  /*
   * The old `cmdbMeasureHistory` returned duplicate_sets and relationship_counts
   * only, so CMDB-096 (class_growth) and CMDB-125/128/129 (scale_snapshot) could
   * never leave abstention in production. Their fixtures injected history
   * directly and never touched the reader.
   */
  const h = cmdbHistoryFromRuns([{ id: 'r1', started_at: '2026-09-10T00:00:00Z', status: 'completed', manifest: manifest() }]);
  for (const key of TREND_MEASURE_KEYS) {
    assert.equal(h[key].length, 1, `${key} was not threaded through history`);
  }
  assert.ok(TREND_MEASURE_KEYS.includes('class_growth'));
  assert.ok(TREND_MEASURE_KEYS.includes('scale_snapshot'));
});

test('an ITSM-only run, a verification, a degraded read and a truncated store are NOT CMDB snapshots', () => {
  const runs = [
    { id: 'itsm', started_at: '1', status: 'partial', modules: ['itsm'], manifest: manifest({ modules: ['itsm'] }) },
    { id: 'verify', started_at: '2', status: 'completed', manifest: manifest({ kind: 'verification' }) },
    { id: 'degraded', started_at: '3', status: 'partial', manifest: manifest({ degraded: { cmdb: ['cmdb_rel_ci: forbidden'] } }) },
    { id: 'cancelled', started_at: '4', status: 'cancelled', manifest: manifest() },
    { id: 'good', started_at: '5', status: 'completed', manifest: manifest(), findings: [{ fingerprint: 'f1', rule_id: 'CMDB-012', domain: 'CMDB' }] },
    { id: 'truncated', started_at: '6', status: 'completed', manifest: manifest({ findings_truncated: true }), findings: [{ fingerprint: 'f1', rule_id: 'CMDB-012', domain: 'CMDB' }] },
  ];
  const h = cmdbHistoryFromRuns(runs);
  assert.deepEqual(h.snapshots.map((s) => s.run_id), ['good', 'truncated']);
  assert.deepEqual(h.excluded.map((e) => e.run_id).sort(), ['cancelled', 'degraded', 'itsm', 'verify']);
  assert.match(h.excluded.find((e) => e.run_id === 'itsm').why, /would read as everything resolved/);
  /* A truncated store is still a snapshot of the score, but not of its findings. */
  const t = h.snapshots.find((s) => s.run_id === 'truncated');
  assert.equal(t.findings, null);
  assert.match(t.findings_unavailable_because, /only part of what it found/);
});

test('the history keeps only CMDB-module findings, and its prefix agrees with the scope table', () => {
  for (const id of ['CMDB-012', 'REL-SELF', 'CSDM-001', 'ITSM-001', 'MID-001', 'PERF-ECC-AGE']) {
    assert.equal(CMDB_RULE_PREFIX.test(id), scopeOfRule(id) === 'cmdb', `${id}: prefix and scope disagree`);
  }
  const h = cmdbHistoryFromRuns([{ id: 'full', started_at: '1', status: 'completed', manifest: manifest({ modules: null }),
    findings: [{ fingerprint: 'a', rule_id: 'CMDB-012', domain: 'CMDB' }, { fingerprint: 'b', rule_id: 'ITSM-001', domain: 'INCIDENT' }] }]);
  assert.deepEqual(h.snapshots[0].findings.map((f) => f[0]), ['a']);
  assert.equal(cmdbSnapshotEligibility({ status: 'completed', manifest: manifest({ modules: null }) }).ok, true,
    'a legacy full scan with no module list did cover the CMDB');
});

/* ════════════ comparability ════════════ */

test('the comparability key changes when the scoring model does — the blend change of this week included', () => {
  const now = scoringComparability();
  assert.equal(now.key, scoringComparability().key, 'the key is stable for an unchanged model');
  assert.equal(now.rule_version, '3.0.2');
  /* The single global 70/30 blend in force before per-type blends: a different model. */
  const globalBlend = { record: { record: 0.7, kpi: 0.3 }, mixed: { record: 0.7, kpi: 0.3 }, estate: { record: 0.7, kpi: 0.3 } };
  assert.notEqual(scoringComparability({ blends: globalBlend }).key, now.key,
    'the D10 67.2 → 28.8 blend change must break comparability, or CMDB-137 would call it a decline');
  assert.notEqual(scoringComparability({ ruleVersion: '2.0.0' }).key, now.key, 'a rule-pack version bump breaks comparability');
  const fewer = new Set([...IMPLEMENTED_CATALOGUE_RULES].filter((id) => !DRIFT_RULES.includes(id)));
  assert.notEqual(scoringComparability({ implemented: fewer }).key, now.key,
    'adding a rule group changes what the finding count means, and breaks comparability');
});

/* ════════════ CMDB-132 — recurrence, and the escalator it feeds ════════════ */

test('CMDB-132 escalates a finding that was seen, verifiably closed, and came back', () => {
  const r = engine();
  const f = serialFinding(r, 'srv1');
  const other = serialFinding(r, 'srv2');
  /* srv1: present, then absent while CMDB-012 was still finding other things, then back. */
  r.history = { snapshots: [
    snap('2026-08-01T00:00:00Z', [[f.fingerprint, 'CMDB-012', 'CMDB'], [other.fingerprint, 'CMDB-012', 'CMDB']]),
    snap('2026-09-01T00:00:00Z', [[other.fingerprint, 'CMDB-012', 'CMDB']]),
  ] };
  const state = cmdbRecurrencePass(r);
  assert.equal(state.evaluable, true);
  assert.deepEqual(state.recurring.map((x) => x.fingerprint), [f.fingerprint]);
  assert.ok(f.modifiers.escalators.includes('recurred'));
  assert.equal(f.deduction_severity, 'SYSTEMIC', 'CRITICAL + recurred escalates one band');
  assert.equal(f.modifiers.not_evaluated.includes('recurred'), false, 'it was evaluated');
  /* The one that never left is evaluated too, and NOT escalated. */
  assert.equal(other.modifiers.escalators.includes('recurred'), false);
  assert.equal(other.modifiers.not_evaluated.includes('recurred'), false);

  cmdbDriftRules(r);
  const found = byRule(r, 'CMDB-132');
  assert.equal(found.length, 1);
  assert.match(found[0].description, /fixed and came back/);
});

test('CMDB-132 does NOT count a closure its rule could not have seen', () => {
  const r = engine();
  const f = serialFinding(r, 'srv1');
  /* In the middle snapshot CMDB-012 produced NOTHING — it may not have run. */
  r.history = { snapshots: [
    snap('2026-08-01T00:00:00Z', [[f.fingerprint, 'CMDB-012', 'CMDB']]),
    snap('2026-09-01T00:00:00Z', [['zzz', 'CMDB-058', 'RELATIONSHIP']]),
  ] };
  const state = cmdbRecurrencePass(r);
  assert.equal(state.recurring.length, 0, 'an unverified absence is not a remediation');
  assert.equal(f.modifiers.escalators.includes('recurred'), false);
});

test('without two comparable snapshots, `recurred` stays not-evaluated and CMDB-132 says why', () => {
  const r = engine();
  const f = serialFinding(r, 'srv1');
  r.history = { snapshots: [
    snap('2026-08-01T00:00:00Z', [[f.fingerprint, 'CMDB-012', 'CMDB']]),
    { ...snap('2026-09-01T00:00:00Z', []), comparability: null },
  ] };
  cmdbRecurrencePass(r);
  assert.ok(f.modifiers.not_evaluated.includes('recurred'));
  cmdbDriftRules(r);
  assert.match(reason(r, 'CMDB-132'), /NOT MEASURED — a recurrence needs a finding to be seen, then verifiably gone, then back/);
  assert.match(reason(r, 'CMDB-132'), /1 predate the comparability key/);
});

/* ════════════ CMDB-131 — net position ════════════ */

test('CMDB-131 counts a disappearance as resolved only when its rule still ran', () => {
  const r = engine();
  serialFinding(r, 'new1');
  serialFinding(r, 'new2');
  serialFinding(r, 'new3');
  r.history = { snapshots: [snap('2026-09-01T00:00:00Z', [
    ['gone-verified', 'CMDB-012', 'CMDB'],
    ['gone-unverified', 'CMDB-058', 'RELATIONSHIP'],
  ])] };
  cmdbDriftRules(r);
  const np = r.measures.net_position;
  assert.deepEqual([np.created, np.resolved, np.unverified, np.net], [3, 1, 1, -2]);
  const f = byRule(r, 'CMDB-131');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /1 earlier finding\(s\) are gone but NOT counted as resolved/);
  const q = scoreCmdbQuality({ findings: r.findings, kpis: r.kpis });
  assert.equal(q.gate.blockers.some((b) => b.rule_id === 'CMDB-131'), false, 'net position is posture, never a gate');
});

test('CMDB-131 counts an appearance as created only when its rule looked on the earlier run', () => {
  /*
   * The mirror of the resolved guard. CMDB-012 had findings before, so its new
   * one is a creation; CMDB-013 produced nothing before, so its two findings may
   * be a rule that was not measuring then, and are not charged as new defects.
   */
  const r = engine();
  serialFinding(r, 'kept');
  serialFinding(r, 'new1');
  r.addCatalogued('CMDB-013', 'cmdb_ci', [ci('m1'), ci('m2')], ['name'], 'newly measured', { escalators: [], deEscalators: [], notEvaluated: ['recurred'] });
  const kept = r.findings.find((f) => f.rule_id === 'CMDB-012' && /kept/.test(f.description)).fingerprint;
  r.history = { snapshots: [snap('2026-09-01T00:00:00Z', [[kept, 'CMDB-012', 'CMDB']])] };
  cmdbDriftRules(r);
  const np = r.measures.net_position;
  const newM13 = r.findings.filter((f) => f.rule_id === 'CMDB-013').length;
  assert.ok(newM13 >= 1);
  assert.deepEqual([np.created, np.resolved, np.newly_measured], [1, 0, newM13]);
  assert.equal(np.net, -1, 'only the verified creation moves the net position');
  assert.match(byRule(r, 'CMDB-131')[0].description, /NOT counted as created, because their rule produced nothing on the earlier run/);
});

test('CMDB-131 abstains against a run measured under a different scoring model', () => {
  const r = engine();
  serialFinding(r, 'a');
  r.history = { snapshots: [{ ...snap('2026-09-01T00:00:00Z', [['x', 'CMDB-012', 'CMDB']]), comparability: { key: 'some-older-model' } }] };
  cmdbDriftRules(r);
  assert.equal(byRule(r, 'CMDB-131').length, 0);
  assert.match(reason(r, 'CMDB-131'), /measured with a different rule set, catalogue or blend/);
  assert.match(reason(r, 'CMDB-131'), /would report rule changes as changes in the estate/);
});

/* ════════════ CMDB-137 — the score trend, and the naive comparison it refuses ════════════ */

test('CMDB-137 names the naive comparison it refuses — the 82.1 → 77.0 case on dev424910', () => {
  const r = engine();
  r.history = { snapshots: [{ ...snap('2026-09-16T05:20:26Z', null), composite: 82.1, comparability: null }] };
  const quality = { composite: { score: 77, measured_weight: 80 }, dimensions: [], measures: {} };
  const out = cmdbScoreTrend(r, quality);
  assert.equal(out, null);
  const why = reason(r, 'CMDB-137');
  assert.match(why, /NOT MEASURED — a score trend needs 3 comparable readings and there are 1/);
  assert.match(why, /read 82.1 \(2026-09-16\) against 77 now, before the comparability key existed/);
  assert.match(why, /cannot be read as the estate moving/);
});

test('CMDB-137 does not announce a difference of zero — the unkeyed 77 → 77 case on dev424910', () => {
  const r = engine();
  r.history = { snapshots: [{ ...snap('2026-09-16T11:32:11Z', null), composite: 77, comparability: null }] };
  cmdbScoreTrend(r, { composite: { score: 77, measured_weight: 80 }, dimensions: [], measures: {} });
  const why = reason(r, 'CMDB-137');
  assert.match(why, /also read 77/);
  assert.match(why, /matching numbers across models are a coincidence, not evidence that nothing changed/);
  assert.equal(/that difference is a change/.test(why), false);
});

test('CMDB-137 reports a real decline across comparable runs, attributed to dimensions', () => {
  const r = engine();
  r.history = { snapshots: [
    { ...snap('2026-07-01T00:00:00Z', null), composite: 80, dimensions: { D1: 80, D6: 80 } },
    { ...snap('2026-08-01T00:00:00Z', null), composite: 77, dimensions: { D1: 80, D6: 70 } },
  ] };
  const quality = { composite: { score: 74, measured_weight: 28 }, dimensions: [{ key: 'D1', weight: 12, score: 80 }, { key: 'D6', weight: 16, score: 60 }], measures: {} };
  const f = cmdbScoreTrend(r, quality);
  assert.ok(f, 'a sustained comparable decline must be reported');
  assert.match(f.description, /80 → 77 → 74/);
  assert.match(f.description, /D6 \(80 → 60/);
  assert.equal(CMDB_CATALOGUE['CMDB-137'].dimension, null, 'and it never scores');
});

/* ════════════ the rest of the group ════════════ */

test('CMDB-133 abstains when CMDB-046 has never produced a ratio to trend', () => {
  const r = engine();
  cmdbDriftRules(r);
  assert.match(reason(r, 'CMDB-133'), /a trend of a measurement that does not exist is not a trend/);
});

test('CMDB-134 reports duplicate sets that are new since a comparable snapshot', () => {
  const r = engine();
  r.measures.duplicate_sets = { at: NOW.toISOString(), keys: ['a', 'b', 'c'], complete: true };
  r.history = { snapshots: [{ ...snap('2026-09-01T00:00:00Z', null), duplicate_keys: ['a', 'z'] }] };
  cmdbDriftRules(r);
  assert.deepEqual([r.measures.duplicate_inflow.new_sets, r.measures.duplicate_inflow.resolved_sets], [2, 1]);
  assert.match(byRule(r, 'CMDB-134')[0].description, /2 duplicate set\(s\) exist now/);
});

test('CMDB-135 abstains while Discovery is not operating — a clock nobody is winding', () => {
  const r = engine({ estate: { cmdb_ci: [ci('a')] } });
  r.measures.discovery_capability = { installed: false, operating: false, ever_discovered: 10 };
  cmdbDriftRules(r);
  assert.match(reason(r, 'CMDB-135'), /A CI cannot newly go stale on a clock nobody is winding/);
  assert.ok(r.measures.staleness_snapshot, 'the baseline is still recorded for when Discovery runs');
});

test('CMDB-135 counts CIs newly crossing the threshold, per week', () => {
  const r = engine({ estate: { cmdb_ci: [
    { ...ci('old'), last_discovered: '2026-01-01 00:00:00' },
    { ...ci('newlyStale'), last_discovered: '2026-05-01 00:00:00' },
    { ...ci('fresh'), last_discovered: '2026-09-10 00:00:00' },
  ] } });
  r.measures.discovery_capability = { installed: true, operating: true, ever_discovered: 3 };
  r.history = { staleness_snapshot: [{ at: '2026-09-02T06:00:00.000Z', threshold_days: 90, stale_ids: ['old'], truncated: false, comparability_key: KEY() }] };
  cmdbDriftRules(r);
  const f = byRule(r, 'CMDB-135');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /1 CI\(s\) crossed the 90-day staleness threshold since 2026-09-02 — about 0.5 a week/);
});

test('CMDB-136 needs three per-class snapshots, and older ones without per-class counts do not contribute', () => {
  const r = engine();
  r.measures.relationship_counts = { at: NOW.toISOString(), total: 50, by_class: { cmdb_ci_server: 50 } };
  r.history = { relationship_counts: [{ at: '2026-07-01T00:00:00Z', total: 90 }, { at: '2026-08-01T00:00:00Z', total: 70, by_class: { cmdb_ci_server: 70 } }] };
  cmdbDriftRules(r);
  assert.match(reason(r, 'CMDB-136'), /needs 3 snapshots with per-class counts and there are 2/);

  const r2 = engine();
  r2.measures.relationship_counts = { at: NOW.toISOString(), total: 50, by_class: { cmdb_ci_server: 50, cmdb_ci_appl: 10 } };
  r2.history = { relationship_counts: [
    { at: '2026-07-01T00:00:00Z', total: 100, by_class: { cmdb_ci_server: 90, cmdb_ci_appl: 10 } },
    { at: '2026-08-01T00:00:00Z', total: 80, by_class: { cmdb_ci_server: 70, cmdb_ci_appl: 10 } },
  ] };
  cmdbDriftRules(r2);
  const f = byRule(r2, 'CMDB-136');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /cmdb_ci_server 90 → 70 → 50/);
  assert.equal(/cmdb_ci_appl/.test(f[0].description), false, 'a flat class is not declining');
});

test('CMDB-138 has no denominator when no attestation task was ever issued', () => {
  const r = engine();
  cmdbDriftRules(r);
  assert.match(reason(r, 'CMDB-138'), /adherence has no denominator/);
  assert.match(reason(r, 'CMDB-138'), /automated desired-state checks with no human completion step/);
});

test('CMDB-138 trends adherence once three cycles exist', () => {
  const task = (i, month, onTime) => ({ sys_id: `t${i}`, opened_at: `2026-${month}-02 00:00:00`, due_date: `2026-${month}-20 00:00:00`, closed_at: onTime ? `2026-${month}-10 00:00:00` : `2026-${month}-28 00:00:00` });
  const r = engine({ estate: { cmdb_data_management_task: [
    task(1, '06', true), task(2, '06', true),
    task(3, '07', true), task(4, '07', false),
    task(5, '08', false), task(6, '08', false),
  ] } });
  cmdbDriftRules(r);
  const f = byRule(r, 'CMDB-138');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /2026-06 100% → 2026-07 50% → 2026-08 0%/);
});

test('on a fresh estate every trend rule abstains, and none of them reports "stable"', () => {
  const r = engine({ estate: { cmdb_ci: [ci('a')] } });
  serialFinding(r, 'a');
  r.measures.discovery_capability = { installed: false, operating: false, ever_discovered: 0 };
  r.measures.relationship_counts = { at: NOW.toISOString(), total: 0, by_class: {} };
  cmdbRecurrencePass(r);
  cmdbDriftRules(r);
  cmdbScoreTrend(r, { composite: { score: 77, measured_weight: 80 }, dimensions: [], measures: {} });
  assert.equal(r.findings.filter((f) => DRIFT_RULES.includes(f.rule_id)).length, 0);
  for (const id of DRIFT_RULES) {
    assert.ok(r.skipped.some((s) => s.rule === id), `${id} said nothing`);
  }
});

/* ════════════ comparability is a property of the MEASURE ════════════ */

test('every trend measure is tagged raw or derived, and every trend rule names a tagged measure', () => {
  for (const [measure, kind] of Object.entries(MEASURE_COMPARABILITY)) {
    assert.ok(['raw', 'derived'].includes(kind), `${measure} is tagged ${kind}`);
  }
  for (const key of TREND_MEASURE_KEYS) assert.ok(MEASURE_COMPARABILITY[key], `${key} has no tag`);
  for (const [rule, measure] of Object.entries(TREND_RULE_INPUTS)) {
    assert.ok(CMDB_CATALOGUE[rule], `${rule} is not a catalogue rule`);
    assert.ok(MEASURE_COMPARABILITY[measure], `${rule} reads ${measure}, which has no tag`);
  }
  /* The rules and measures that must never cross a rule change, by construction. */
  assert.equal(MEASURE_COMPARABILITY.duplicate_sets, 'derived');
  assert.equal(MEASURE_COMPARABILITY.snapshots, 'derived');
});

test('no rule in the pack reads a history field the comparison layer does not govern', () => {
  /*
   * Structural: a rule that read `ctx.history.<something untagged>` would bypass
   * the tags. The layer drops untagged fields, and this test fails at the read.
   */
  const dir = new URL('../src/health/', import.meta.url);
  const allowed = new Set([...Object.keys(MEASURE_COMPARABILITY), 'set_aside', 'excluded']);
  const reads = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'cmdb-history.js')) {
    const src = fs.readFileSync(new URL(file, dir), 'utf8');
    for (const m of src.matchAll(/(?:ctx|this)\.history\??\.(\w+)/g)) reads.push([file, m[1]]);
  }
  assert.ok(reads.length >= 8, `found only ${reads.length} history reads — the scan is not seeing the pack`);
  for (const [file, field] of reads) assert.ok(allowed.has(field), `${file} reads history.${field}, which no tag governs`);
});

test('a derived reading from another model never reaches a rule; a raw count does; an untagged field does not', () => {
  const r = engine({ history: {
    duplicate_sets: [{ at: '2026-09-01T00:00:00Z', keys: ['k'], complete: true, comparability_key: 'older-model' }],
    staleness_snapshot: [{ at: '2026-09-01T00:00:00Z', threshold_days: 90, stale_ids: [], comparability_key: null }],
    scale_snapshot: [{ at: '2026-09-01T00:00:00Z', cis: 10, comparability_key: 'older-model' }],
    snapshots: [snap('2026-09-02T00:00:00Z', []), { ...snap('2026-09-03T00:00:00Z', []), comparability: { key: 'older-model' }, composite: 61 }],
    mystery_measure: [{ at: 'x' }],
  } });
  assert.equal(r.history.duplicate_sets.length, 0, 'a derived measure crossed a model boundary');
  assert.equal(r.history.staleness_snapshot.length, 0, 'an unkeyed derived measure was trusted');
  assert.equal(r.history.scale_snapshot.length, 1, 'a raw platform count was withheld across a rule change');
  assert.equal(r.history.snapshots.length, 1);
  assert.equal(r.history.mystery_measure, undefined, 'an untagged field reached the rules');
  assert.deepEqual(r.history.untagged, ['mystery_measure']);
  assert.deepEqual([r.history.set_aside.duplicate_sets.other_model, r.history.set_aside.staleness_snapshot.unkeyed], [1, 1]);
  assert.deepEqual(r.history.set_aside.snapshots.newest_scored, { at: '2026-09-03T00:00:00Z', keyed: true, composite: 61 });

  /* No way round it: assigning history later goes through the same layer. */
  r.history = { duplicate_sets: [{ at: '2026-09-01T00:00:00Z', keys: ['k'], complete: true, comparability_key: 'older-model' }] };
  assert.equal(r.history.duplicate_sets.length, 0, 'a later assignment bypassed the comparison layer');
  r.history = { duplicate_sets: [{ at: '2026-09-01T00:00:00Z', keys: ['k'], complete: true, comparability_key: KEY() }] };
  assert.equal(r.history.duplicate_sets.length, 1);
  /* And the layer is idempotent under the same key. */
  assert.equal(comparableHistory(r.history, KEY()), r.history);
});

test('the history reader stamps every reading with the model it was measured under', () => {
  const h = cmdbHistoryFromRuns([
    { id: 'old', started_at: '2026-09-09T00:00:00Z', status: 'completed', manifest: manifest({ comparability: null }) },
    { id: 'new', started_at: '2026-09-10T00:00:00Z', status: 'completed', manifest: manifest() },
  ]);
  for (const key of TREND_MEASURE_KEYS) assert.deepEqual(h[key].map((v) => v.comparability_key), [null, KEY()], key);
  const r = engine({ history: h });
  for (const [key, kind] of Object.entries(MEASURE_COMPARABILITY)) {
    if (key === 'snapshots') continue;
    assert.equal(r.history[key].length, kind === 'raw' ? 2 : 1, `${key} (${kind})`);
  }
});

test('the trend layer says out loud that it is a returning-customer capability', () => {
  const dark = engine();
  cmdbDriftRules(dark);
  const t = dark.measures.trend_readiness;
  assert.deepEqual([t.state, t.comparable_earlier_scans, t.earlier_scans_needed], ['dark', 0, 2]);
  assert.match(t.statement, /RETURNING-CUSTOMER capability, not a first-scan one/);
  assert.match(t.statement, /need 2 earlier scans that READ the CMDB after the last rule change — the 3rd such scan under one version is the first where all of them can evaluate/);
  assert.match(t.statement, /A scan that finds the CMDB unchanged reuses its last result and adds no reading/);
  assert.match(t.statement, /Do not expect drift detection in a first engagement; freeze the rule version/);
  for (const id of ['CMDB-038', 'CMDB-131', 'CMDB-132', 'CMDB-133', 'CMDB-134', 'CMDB-135', 'CMDB-137', 'recurred escalator']) {
    assert.ok(t.resets_on_rule_change.includes(id), `${id} should reset on a rule change`);
  }
  /* CMDB-136 trends a RAW count, so a rule change does not reset it. */
  for (const id of ['CMDB-056', 'CMDB-096', 'CMDB-125', 'CMDB-128', 'CMDB-136']) {
    assert.ok(t.survives_rule_change.includes(id), `${id} should keep its baseline`);
  }
  assert.match(reason(dark, 'CMDB-131'), /returning-customer capability, not a first-scan one/);
  assert.match(reason(dark, 'CMDB-132'), /returning-customer capability/);

  const live = engine();
  live.history = { snapshots: [snap('2026-09-01T00:00:00Z', []), snap('2026-09-08T00:00:00Z', [])] };
  cmdbDriftRules(live);
  assert.equal(live.measures.trend_readiness.state, 'live');
});
