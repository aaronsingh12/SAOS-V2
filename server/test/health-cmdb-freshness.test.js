import test from 'node:test';
import assert from 'node:assert/strict';

import { CMDB_CATALOGUE, scoreCmdbQuality } from '../src/health/cmdb-quality.js';
import { EstateRules, IMPLEMENTED_CATALOGUE_RULES } from '../src/health/rules.js';
import { FRESHNESS_RULES, cmdbFreshnessRules, ipToInt, rangeBounds, subnetOf } from '../src/health/cmdb-freshness.js';
import { buildSignals, intentOf } from '../src/health/cmdb-signals.js';

/*
 * Health Assist — Group 7 (Freshness and source coverage, D7), Sep 2026.
 *
 * The question this group answers is not "is the record right" but "is anything
 * still saying so". Most of what it wants — per-CI source attribution, per-
 * attribute last-seen, import provenance — dev424910 does not keep, so most of
 * these tests are about REFUSING to report a clean score from evidence that
 * does not exist, and saying exactly what is missing instead.
 */

const NOW = new Date('2026-09-16T06:00:00Z');
const ok = { status: 'ok' };
const TABLES = ['cmdb_ci', 'cmdb_rel_ci', 'discovery_schedule', 'discovery_device_history',
  'discovery_range_item', 'sys_object_source', 'cmdb_datasource_last_update'];
const full = (over = {}) => Object.fromEntries(TABLES.map((t) => [t,
  { table: t, status: 'complete', rows_complete: true, missing_fields: [], ...(over[t] || {}) }]));
const CLASSES = {
  cmdb: { super: null }, cmdb_ci: { super: 'cmdb' }, cmdb_ci_hardware: { super: 'cmdb_ci' },
  cmdb_ci_computer: { super: 'cmdb_ci_hardware' }, cmdb_ci_server: { super: 'cmdb_ci_computer' },
  cmdb_ci_appl: { super: 'cmdb_ci' }, cmdb_ci_service: { super: 'cmdb_ci' }, cmdb_ci_spkg: { super: 'cmdb_ci' },
};

function run(estate, { coverage = full(), options = {} } = {}) {
  const r = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [], ...estate }, coverage, 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok, used_for: ok, virtual: ok }, classes: { byName: CLASSES }, virtualIds: [], usedFor: {}, choices: [] } },
  });
  r.signals = buildSignals(r);
  cmdbFreshnessRules(r, options);
  return {
    r,
    byRule: (id) => r.findings.filter((x) => x.rule_id === id && !x.pattern),
    skipped: (id) => r.skipped.filter((s) => s.rule === id),
    reason: (id) => r.skipped.filter((s) => s.rule === id).map((s) => s.reason).join(' | '),
    kpi: (id) => r.kpis.find((k) => k.rule_id === id),
  };
}

/** A CI created long enough ago to be old, and touched once so it is not CMDB-075. */
const ci = (id, cls = 'cmdb_ci_server', fields = {}) => ({
  sys_id: id, name: id, sys_class_name: cls, install_status: '1', operational_status: '1',
  sys_created_on: '2020-01-01 00:00:00', sys_updated_on: '2026-09-01 00:00:00',
  sys_created_by: 'alice', sys_updated_by: 'alice', sys_mod_count: '4', ...fields,
});
const schedule = (sys_id, over = {}) => ({ sys_id, name: sys_id, active: 'true', run_type: 'periodically', run_period: '1970-01-08 00:00:00', ...over });

/* ════════════════════════ the catalogue ════════════════════════ */

test('Group 7 is built, scores in D7, and each rule is tagged quality or contradiction', () => {
  for (const id of FRESHNESS_RULES) {
    assert.ok(IMPLEMENTED_CATALOGUE_RULES.has(id), id);
    assert.equal(CMDB_CATALOGUE[id].dimension, 'D7', id);
  }
  for (const id of ['CMDB-073', 'CMDB-076']) assert.equal(intentOf(id), 'contradiction', id);
  for (const id of ['CMDB-070', 'CMDB-071', 'CMDB-072', 'CMDB-074', 'CMDB-075', 'CMDB-077', 'CMDB-078', 'CMDB-079']) {
    assert.equal(intentOf(id), 'quality', id);
  }
});

/* ════════════════════ absent is not the same as broken ════════════════════ */

test('CMDB-070 — no Discovery product means posture, not a gate on a product nobody bought', () => {
  const { byRule, kpi, reason, r } = run(
    { cmdb_ci: [ci('a'), ci('b', 'cmdb_ci_computer')] },
    { coverage: full({ discovery_schedule: { status: 'unavailable', rows_complete: false } }) },
  );
  const f = byRule('CMDB-070');
  assert.equal(f.length, 1, 'the absence of any discovery must still be reported');
  assert.equal(f[0].systemic_kind_override, 'posture');
  assert.match(f[0].systemic_kind_override_reason, /not operating/);
  assert.match(f[0].description, /does not exist on this instance/);
  assert.equal(kpi('CMDB-070'), undefined, 'a coverage ratio was published with no discovery to measure');
  assert.match(reason('CMDB-070'), /needs a discovery process to have run/);

  const q = scoreCmdbQuality({ findings: r.findings, kpis: r.kpis });
  assert.equal(q.gate.blockers.some((b) => b.rule_id === 'CMDB-070'), false, 'an absent product gated the composite');
  assert.equal(q.posture.find((x) => x.rule_id === 'CMDB-070')?.downgraded_from, 'measured_kpi');
});

test('CMDB-070 — with Discovery running it is an ordinary gating KPI, and shows its denominator', () => {
  const cis = [ci('d1', 'cmdb_ci_server', { last_discovered: '2026-09-10 00:00:00' }), ci('d2'), ci('d3'), ci('svc', 'cmdb_ci_service')];
  const { kpi, byRule } = run({ cmdb_ci: cis, discovery_schedule: [schedule('s1')] });
  const k = kpi('CMDB-070');
  assert.ok(k, 'no coverage ratio was published while discovery was running');
  /* The service is not a discoverable class, so the denominator is the three devices. */
  assert.deepEqual([k.numerator, k.denominator], [1, 3]);
  assert.match(k.basis, /EXPECTED COUNT derived as/, 'the derivation must be shown, not asserted');
  const f = byRule('CMDB-070');
  assert.equal(f.length, 1);
  assert.equal(f[0].systemic_kind_override, undefined, 'a real measurement must still be able to gate');
});

/* ════════════════════════ the one rule this estate can answer ═══════════ */

test('CMDB-073 — a CI claiming a source that never saw it, over the FULL estate', () => {
  const { byRule } = run({
    cmdb_ci: [
      ci('claims', 'cmdb_ci_computer', { discovery_source: 'Other Automated' }),
      ci('dead', 'cmdb_ci_computer', { discovery_source: 'SCCM', install_status: '7' }),
      ci('honest', 'cmdb_ci_computer', { discovery_source: 'Manual' }),
      ci('real', 'cmdb_ci_computer', { discovery_source: 'ServiceNow', first_discovered: '2026-01-01 00:00:00' }),
      ci('quiet'),
    ],
  });
  const ids = byRule('CMDB-073').map((f) => f.target_ids[0]).sort();
  assert.deepEqual(ids, ['claims', 'dead'],
    'a contradiction rule must judge retired CIs too, and must not judge an honest "Manual" or a genuinely discovered CI');
  assert.match(byRule('CMDB-073')[0].false_positive_guard.note, /never existed/,
    'with no device history at all, the guard must say it corroborates nothing rather than implying a purge');
});

test('CMDB-073 — a CI that IS in the device history lost its timestamps, which is a different defect', () => {
  const { byRule, reason } = run({
    cmdb_ci: [ci('x', 'cmdb_ci_computer', { discovery_source: 'ServiceNow' })],
    discovery_device_history: [{ sys_id: 'h1', cmdb_ci: 'x', source: 'Discovery' }],
  });
  assert.equal(byRule('CMDB-073').length, 0);
  assert.match(reason('CMDB-073'), /timestamps were lost, not the discovery/);
});

/* ════════════════════ refusing to score what is not there ════════════════ */

test('CMDB-074 — one discovery_source column is not a source count, and the rule says so', () => {
  const { byRule, kpi, reason } = run({ cmdb_ci: [ci('a'), ci('b')] });
  assert.equal(byRule('CMDB-074').length, 0);
  assert.equal(kpi('CMDB-074'), undefined);
  assert.match(reason('CMDB-074'), /a fact about the column, not about the data/);
});

test('CMDB-074 — with real attribution it counts distinct feeds per CI', () => {
  const { kpi, byRule } = run({
    cmdb_ci: [ci('a'), ci('b'), ci('c')],
    sys_object_source: [
      { sys_id: 'o1', target_table: 'cmdb_ci', target_sys_id: 'a', source_feed: 'Discovery' },
      { sys_id: 'o2', target_table: 'cmdb_ci', target_sys_id: 'a', source_feed: 'SCCM' },
      { sys_id: 'o3', target_table: 'cmdb_ci', target_sys_id: 'b', source_feed: 'Discovery' },
      { sys_id: 'o4', target_table: 'cmdb_ci', target_sys_id: 'c', source_feed: 'Discovery' },
    ],
  });
  const k = kpi('CMDB-074');
  assert.deepEqual([k.numerator, k.denominator], [1, 3], 'only "a" is corroborated by a second source');
  assert.match(k.basis, /passing half/, 'a ratio where high is bad must be published as its passing half');
  assert.equal(byRule('CMDB-074').length, 1, '67% single-sourced should fire against the 60% ceiling');
});

test('CMDB-076 — attribute freshness is reported as a GAP, and names what record dates hide', () => {
  /* 8 of 10 CIs share one sys_updated_on: the bulk touch that fakes freshness. */
  const bulk = Array.from({ length: 8 }, (_, i) => ci(`b${i}`, 'cmdb_ci_computer', { sys_updated_on: '2026-04-30 09:00:00', sys_updated_by: 'system' }));
  const { byRule, reason } = run({ cmdb_ci: [...bulk, ci('x'), ci('y')] }, { options: { bulkTouchMinCis: 5 } });
  assert.equal(byRule('CMDB-076').length, 0);
  assert.match(reason('CMDB-076'), /not maintained on this instance/);
  assert.match(reason('CMDB-076'), /8 of 10 CIs \(80%\) were last written by a mass touch, the largest on 2026-04-30/);
  assert.match(reason('CMDB-076'), /8 CI\(s\) were last written by a script account/);
});

/* ════════════════════════ what it can measure ════════════════════════ */

test('CMDB-075 — never touched since creation, and never a CI a bulk write hid', () => {
  const { byRule, r } = run({
    cmdb_ci: [
      ci('untouched', 'cmdb_ci_server', { sys_mod_count: '0', sys_updated_on: '2020-01-01 00:00:00' }),
      ci('recent', 'cmdb_ci_server', { sys_mod_count: '0', sys_created_on: '2026-09-10 00:00:00', sys_updated_on: '2026-09-10 00:00:00' }),
      ci('edited'),
      ci('dead', 'cmdb_ci_server', { sys_mod_count: '0', sys_updated_on: '2020-01-01 00:00:00', install_status: '7' }),
    ],
  });
  assert.deepEqual(byRule('CMDB-075').map((f) => f.target_ids[0]), ['untouched'],
    'a young CI, an edited CI and a retired CI are all outside this quality rule');
  assert.equal(r.measures.record_freshness.untouched_since_creation, 1);
});

test('CMDB-075 — a CI a mass write touched is handed to CMDB-142, not counted twice', () => {
  const bulk = Array.from({ length: 9 }, (_, i) => ci(`b${i}`, 'cmdb_ci_computer', { sys_updated_on: '2026-04-30 09:00:00', sys_updated_by: 'system' }));
  const { reason, r } = run({ cmdb_ci: [...bulk, ci('x')] }, { options: { bulkTouchMinCis: 5 } });
  assert.match(reason('CMDB-075'), /CMDB-142 charges them instead/);
  assert.equal(r.measures.record_freshness.busiest_update_day.share_pct, 90);
});

/* ════════════ CMDB-142 / CMDB-143 — a mass write is not freshness ════════ */

test('CMDB-142 charges every CI of a mass write, and says the migration test could not be run', () => {
  const bulk = Array.from({ length: 9 }, (_, i) => ci(`b${i}`, 'cmdb_ci_computer', { sys_updated_on: '2026-04-30 09:00:00', sys_updated_by: 'system' }));
  const { byRule, r } = run({ cmdb_ci: [...bulk, ci('x')] }, { options: { bulkTouchMinCis: 5 } });
  const fired = byRule('CMDB-142');
  assert.equal(fired.length, 9, 'a mass write must charge every record it hid, not report one summary');
  assert.equal(fired[0].confidence, 0.8, 'without sys_audit the no-op half is unverified and confidence must drop');
  assert.equal(fired[0].false_positive_guard.evaluated, false);
  assert.match(fired[0].false_positive_guard.note, /could NOT be run here/);
  assert.equal(byRule('CMDB-142').some((f) => f.target_ids[0] === 'x'), false, 'a CI outside the write was charged');
  assert.equal(r.measures.record_freshness.attribute_deltas_checkable, false);
});

test('CMDB-142 exempts a real migration — one that actually changed attributes', () => {
  const bulk = Array.from({ length: 9 }, (_, i) => ci(`b${i}`, 'cmdb_ci_computer', { sys_updated_on: '2026-04-30 09:00:00', sys_updated_by: 'system' }));
  const audit = bulk.map((c, i) => ({ sys_id: `a${i}`, documentkey: c.sys_id, user: 'system', fieldname: 'location', tablename: 'cmdb_ci_computer', sys_created_on: '2026-04-30 09:00:00' }));
  const { byRule, reason, r } = run({ cmdb_ci: [...bulk, ci('x')], sys_audit: audit }, { options: { bulkTouchMinCis: 5 } });
  assert.equal(byRule('CMDB-142').length, 0, 'a migration that changed attributes is not a no-op touch');
  assert.match(reason('CMDB-142'), /DID change attributes/);
  assert.equal(r.measures.record_freshness.migrations_exempted.length, 1);
  assert.equal(r.measures.record_freshness.attribute_deltas_checkable, true);
});

test('CMDB-143 publishes the passing half and gates when freshness cannot be believed', () => {
  const bulk = Array.from({ length: 9 }, (_, i) => ci(`b${i}`, 'cmdb_ci_computer', { sys_updated_on: '2026-04-30 09:00:00', sys_updated_by: 'system' }));
  const { kpi, byRule, r } = run({ cmdb_ci: [...bulk, ci('x')] }, { options: { bulkTouchMinCis: 5 } });
  const k = kpi('CMDB-143');
  assert.deepEqual([k.numerator, k.denominator], [1, 10]);
  assert.equal(k.pass_pct, 10);
  assert.match(k.basis, /passing half/);
  assert.match(k.alerts, /sys_audit is opt-in and was not read/);
  const f = byRule('CMDB-143');
  assert.equal(f.length, 1);
  const q = scoreCmdbQuality({ findings: r.findings, kpis: r.kpis });
  assert.ok(q.gate.blockers.some((b) => b.rule_id === 'CMDB-143'),
    'a bulk-touched estate must gate: every age-based measure over it is reporting a job');
});

test('an ordinary busy day is not a mass write', () => {
  /* Two CIs saved on the same day by the same person, on an estate of ten. */
  const { byRule, kpi } = run({
    cmdb_ci: [ci('a', 'cmdb_ci_server', { sys_updated_on: '2026-05-01 09:00:00', sys_updated_by: 'alice' }),
      ci('b', 'cmdb_ci_server', { sys_updated_on: '2026-05-01 10:00:00', sys_updated_by: 'alice' }),
      ...Array.from({ length: 8 }, (_, i) => ci(`c${i}`, 'cmdb_ci_server', { sys_updated_on: `2026-0${(i % 8) + 1}-0${(i % 8) + 1} 09:00:00`, sys_updated_by: 'bob' }))],
  });
  assert.equal(byRule('CMDB-142').length, 0, '20% of a ten-CI estate is two saves, not a job');
  assert.equal(kpi('CMDB-143').pass_pct, 100);
});

test('CMDB-072 — no schedule means no expectation, and a tolerance is never invented', () => {
  const { byRule, reason } = run({
    cmdb_ci: [ci('old', 'cmdb_ci_server', { last_discovered: '2007-04-12 00:00:00' })],
  }, { coverage: full({ discovery_schedule: { status: 'unavailable', rows_complete: false } }) });
  assert.equal(byRule('CMDB-072').length, 0, 'a CI was charged against an interval nobody configured');
  assert.match(reason('CMDB-072'), /an invented tolerance would be this build's opinion/);
});

test('CMDB-072 — with a schedule, the interval is read as a duration and the tolerance is arithmetic', () => {
  const { byRule } = run({
    cmdb_ci: [
      ci('stale', 'cmdb_ci_server', { last_discovered: '2026-07-01 00:00:00' }),
      ci('fresh', 'cmdb_ci_server', { last_discovered: '2026-09-14 00:00:00' }),
      ci('never'),
    ],
    discovery_schedule: [schedule('s1', { run_period: '1970-01-08 00:00:00' })],   // 7 days
  });
  const fired = byRule('CMDB-072');
  assert.deepEqual(fired.map((f) => f.target_ids[0]), ['stale'],
    'a fresh CI or one discovery has never seen must not be charged here');
  assert.match(fired[0].description, /14-day tolerance \(2x the shortest active schedule interval of 7 days\)/);
});

test('a retired CI that discovery is STILL finding is measured here and charged in D8', () => {
  const { r, byRule } = run({
    cmdb_ci: [ci('zombie', 'cmdb_ci_server', { install_status: '7', last_discovered: '2026-09-12 00:00:00' })],
    discovery_schedule: [schedule('s1')],
  });
  const m = r.measures.retired_still_discovered;
  assert.equal(m.count, 1);
  assert.match(m.charged_by, /CMDB-087/);
  assert.equal(byRule('CMDB-072').length, 0, 'D7 must not charge what D8 owns');
});

/* ════════════════════════ provenance of the record itself ════════════════ */

test('CMDB-078 — the manual share is published as an UPPER BOUND, because purged imports look manual', () => {
  const { kpi, byRule } = run({
    cmdb_ci: [
      ci('typed', 'cmdb_ci_server', { sys_created_by: 'alice' }),
      ci('typed2', 'cmdb_ci_server', { sys_created_by: 'bob' }),
      ci('scripted', 'cmdb_ci_server', { sys_created_by: 'glide.maint' }),
      ci('discovered', 'cmdb_ci_server', { sys_created_by: 'alice', first_discovered: '2026-01-01 00:00:00' }),
    ],
  });
  const k = kpi('CMDB-078');
  assert.deepEqual([k.numerator, k.denominator], [2, 4]);
  assert.match(k.alerts, /UPPER BOUND/);
  assert.equal(byRule('CMDB-078').length, 1, '50% manual should fire against the 25% ceiling');
  assert.match(byRule('CMDB-078')[0].description, /upper bound/);
});

test('CMDB-079 — an unmeasurable import share is refused, not reported as zero', () => {
  const { byRule, kpi, reason } = run({ cmdb_ci: [ci('a'), ci('b')] });
  assert.equal(byRule('CMDB-079').length, 0);
  assert.equal(kpi('CMDB-079'), undefined, '0% import-sourced would state a retention policy as a measurement');
  assert.match(reason('CMDB-079'), /retention policy/);
  assert.match(reason('CMDB-079'), /upper bound/, 'the two rules must cross-reference the same missing evidence');
});

test('CMDB-077 — the update history is not approximated from the last updater', () => {
  const { byRule, reason, r } = run({
    cmdb_ci: [ci('a', 'cmdb_ci_server', { sys_updated_by: 'system' }), ci('b', 'cmdb_ci_server', { sys_updated_by: 'alice' })],
  });
  assert.equal(byRule('CMDB-077').length, 0);
  assert.match(reason('CMDB-077'), /cannot be told from "the last one was"/);
  assert.match(reason('CMDB-077'), /would stop the CMDB module ever reusing a scan/);
  assert.equal(r.measures.record_freshness.script_last_writer, 1, 'the observation is still recorded');
});

test('CMDB-077 — with the audit history it judges EVERY write in the window, not the last one', () => {
  const audit = (sys_id, documentkey, user) => ({ sys_id, documentkey, user, tablename: 'cmdb_ci_server', sys_created_on: '2026-08-01 00:00:00' });
  const { byRule } = run({
    cmdb_ci: [ci('scripted'), ci('mixed'), ci('confirmed', 'cmdb_ci_server', { last_discovered: '2026-09-01 00:00:00' })],
    sys_audit: [
      audit('a1', 'scripted', 'system'), audit('a2', 'scripted', 'svc.integration'),
      audit('a3', 'mixed', 'system'), audit('a4', 'mixed', 'alice'),
      audit('a5', 'confirmed', 'system'),
    ],
  });
  assert.deepEqual(byRule('CMDB-077').map((f) => f.target_ids[0]), ['scripted'],
    'a CI a human also edited, or one discovery has confirmed, is not script-only');
});

/* ════════════════════════ IP arithmetic, not string matching ═════════════ */

test('CMDB-071 — ranges are arithmetic: CIDR, explicit bounds, and what is not IPv4', () => {
  assert.equal(ipToInt('10.0.0.1'), 167772161);
  assert.equal(ipToInt('10.0.0.256'), null);
  assert.equal(ipToInt('::1'), null);
  assert.deepEqual(rangeBounds({ network_ip: '10.0.0.0', netmask: '8' }), [167772160, 184549375]);
  assert.deepEqual(rangeBounds({ start_ip_address: '192.168.1.10', end_ip_address: '192.168.1.20' }), [3232235786, 3232235796]);
  assert.equal(rangeBounds({ network_ip: 'nonsense' }), null);
  assert.equal(subnetOf('192.168.5.77').key, '192.168.5.0/24');
});

test('CMDB-071 — a subnet no active range covers is a gap; one inside a range is not', () => {
  const { byRule } = run({
    cmdb_ci: [
      ci('inside', 'cmdb_ci_server', { ip_address: '10.1.2.3' }),
      ci('outside', 'cmdb_ci_server', { ip_address: '172.20.5.9' }),
      ci('outside2', 'cmdb_ci_server', { ip_address: '172.20.5.10' }),
    ],
    discovery_schedule: [schedule('s1')],
    discovery_range_item: [{ sys_id: 'r1', active: 'true', type: 'IP Network', network_ip: '10.0.0.0', netmask: '8', summary: '10.0.0.0/8' }],
  });
  const fired = byRule('CMDB-071');
  assert.equal(fired.length, 1, 'exactly one uncovered subnet should be reported, once');
  assert.match(fired[0].description, /172\.20\.5\.0\/24/);
  assert.deepEqual(fired[0].target_ids.sort(), ['outside', 'outside2']);
});

test('CMDB-071 — with no Discovery installed, an uncovered subnet is not a gap', () => {
  const { byRule, reason } = run({
    cmdb_ci: [ci('a', 'cmdb_ci_server', { ip_address: '172.20.5.9' })],
    discovery_range_item: [{ sys_id: 'r1', active: 'true', network_ip: '10.0.0.0', netmask: '8' }],
  }, { coverage: full({ discovery_schedule: { status: 'unavailable', rows_complete: false } }) });
  assert.equal(byRule('CMDB-071').length, 0);
  assert.match(reason('CMDB-071'), /nothing was ever going to scan it/);
});

/* ════════════════════════ coverage discipline ════════════════════════ */

test('every Group 7 rule refuses to run when the CIs were not read completely', () => {
  const { r } = run({ cmdb_ci: [ci('a')] }, {
    coverage: full({ cmdb_ci: { status: 'truncated', rows_complete: false } }),
  });
  assert.equal(r.findings.length, 0, 'a freshness rule reported on a partial estate');
  for (const id of FRESHNESS_RULES) {
    assert.ok(r.skipped.some((s) => s.rule === id), `${id} ran anyway`);
  }
});
