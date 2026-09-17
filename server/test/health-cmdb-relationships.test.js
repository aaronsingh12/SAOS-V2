import test from 'node:test';
import assert from 'node:assert/strict';

import { CMDB_CATALOGUE, scoreCmdbQuality } from '../src/health/cmdb-quality.js';
import { EstateRules, IMPLEMENTED_CATALOGUE_RULES } from '../src/health/rules.js';
import { RELATIONSHIP_RULES, cmdbRelationshipRules, SUBSUMED_BY_GROUP_6 } from '../src/health/cmdb-relationships.js';
import { buildSignals, intentOf } from '../src/health/cmdb-signals.js';

/*
 * Health Assist — Group 6 (Relationships, D6), 16 Sep 2026.
 *
 * Decision 5 of 16 Sep 2026 is the spine of this file: each rule takes the CI set its
 * INTENT names. A retired CI with no relationships is nobody's defect (quality);
 * an edge INTO that retired CI is exactly what CMDB-061 exists to find
 * (contradiction).
 */

const NOW = new Date('2026-09-20T06:00:00Z');
const ok = { status: 'ok' };
const TABLES = ['cmdb_ci', 'cmdb_rel_ci', 'cmdb_rel_type', 'cmdb_ci_service', 'svc_ci_assoc', 'cmdb_class_info',
  'cmdb_metadata_hosting', 'cmdb_metadata_containment', 'sys_object_source', 'cmdb_identifier', 'cmdb_identifier_entry'];
const full = () => Object.fromEntries(TABLES.map((t) => [t, { table: t, status: 'complete', rows_complete: true, missing_fields: [] }]));
const CLASSES = {
  cmdb: { super: null }, cmdb_ci: { super: 'cmdb' }, cmdb_ci_hardware: { super: 'cmdb_ci' },
  cmdb_ci_computer: { super: 'cmdb_ci_hardware' }, cmdb_ci_server: { super: 'cmdb_ci_computer' },
  cmdb_ci_appl: { super: 'cmdb_ci' }, cmdb_ci_web_server: { super: 'cmdb_ci_appl' },
  cmdb_ci_service: { super: 'cmdb_ci' }, cmdb_ci_spkg: { super: 'cmdb_ci' },
  cmdb_ci_printer: { super: 'cmdb_ci_hardware' }, cmdb_ci_db_instance: { super: 'cmdb_ci_appl' },
};

/* Five services: the floor CMDB-057 needs before reachability is a measurement. */
const svcCi = (id) => ci(id, 'cmdb_ci_service');
const SERVICES_5 = ['svc', 'svc2', 'svc3', 'svc4', 'svc5'];

function run(estate, { meta = {}, coverage = full(), options = null, history = {} } = {}) {
  const r = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [], ...estate }, coverage, 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok, used_for: ok, virtual: ok }, classes: { byName: CLASSES }, virtualIds: [], usedFor: {}, choices: [], ...meta } },
    history,
  });
  if (options) {
    r.signals = buildSignals(r);
    cmdbRelationshipRules(r, options);
  } else {
    r.analyze();
  }
  return {
    r,
    byRule: (id) => r.findings.filter((x) => x.rule_id === id && !x.pattern),
    skipped: (id) => r.skipped.filter((s) => s.rule === id),
  };
}

const ci = (id, cls = 'cmdb_ci_server', fields = {}) => ({
  sys_id: id, name: id, sys_class_name: cls, install_status: '1', operational_status: '1',
  sys_created_on: '2026-09-01 00:00:00', ...fields,
});
const edge = (sys_id, parent, child, type = 'depends', name = 'Depends on::Used by') => ({
  sys_id, parent, child, type, 'type.name': name, sys_updated_on: '2026-09-19 00:00:00', sys_created_by: 'admin',
});
const relType = (sys_id, name, parent_descriptor, child_descriptor) => ({ sys_id, name, parent_descriptor, child_descriptor });
const TYPES = [relType('depends', 'Depends on::Used by', 'Depends on', 'Used by'), relType('peer', 'Exchanges data with::Exchanges data with', 'Exchanges data with', 'Exchanges data with'), relType('runs', 'Runs on::Runs', 'Runs on', 'Runs')];

/* ════════════════════════ the catalogue ════════════════════════ */

test('Group 6 is built, scores in D6, and each rule is tagged quality or contradiction', () => {
  for (const id of RELATIONSHIP_RULES) {
    assert.ok(IMPLEMENTED_CATALOGUE_RULES.has(id), id);
    assert.equal(CMDB_CATALOGUE[id].dimension, 'D6', id);
  }
  for (const id of ['CMDB-056', 'CMDB-061', 'CMDB-062', 'CMDB-063', 'CMDB-064', 'CMDB-065']) {
    assert.equal(intentOf(id), 'contradiction', id);
  }
  for (const id of ['CMDB-057', 'CMDB-058', 'CMDB-059', 'CMDB-060', 'CMDB-066', 'CMDB-067', 'CMDB-068', 'CMDB-069']) {
    assert.equal(intentOf(id), 'quality', id);
  }
  assert.deepEqual(SUBSUMED_BY_GROUP_6, { 'REL-SELF': 'CMDB-062', 'REL-DUPLICATE': 'CMDB-069', 'CMDB-UNRELATED': 'CMDB-058' });
});

/* ════════════════════════ contradictions ════════════════════════ */

test('CMDB-061 charges the LIVE end of an edge into a retired CI, and says when both ends are dead', () => {
  const { byRule, skipped } = run({
    cmdb_ci: [ci('live'), ci('dead', 'cmdb_ci_server', { install_status: '7' }), ci('gone', 'cmdb_ci_server', { install_status: '100' })],
    cmdb_rel_ci: [edge('r1', 'live', 'dead'), edge('r2', 'dead', 'gone')],
    cmdb_rel_type: TYPES,
  });
  const [x] = byRule('CMDB-061');
  assert.deepEqual(x.target_ids, ['live'], 'the charge did not land on the CI that is still in service');
  assert.match(x.description, /still depends on .*install_status 7/);
  assert.match(skipped('CMDB-061')[0].reason, /1 edge\(s\) join two retired or absent CIs/);
});

test('CMDB-062 reports a self-loop without the type table, and a longer cycle only with it', () => {
  const estate = {
    cmdb_ci: [ci('a'), ci('b'), ci('c')],
    cmdb_rel_ci: [edge('r0', 'a', 'a'), edge('r1', 'a', 'b'), edge('r2', 'b', 'c'), edge('r3', 'c', 'a')],
  };
  const noTypes = full();
  noTypes.cmdb_rel_type = { table: 'cmdb_rel_type', status: 'forbidden', rows_complete: false };
  const blind = run(estate, { coverage: noTypes });
  assert.deepEqual(blind.byRule('CMDB-062').map((f) => f.target_ids), [['a']], 'a self-loop needs no type table');
  assert.match(blind.skipped('CMDB-062')[0].reason, /self-loops are still reported, longer cycles are not/);

  const seen = run({ ...estate, cmdb_rel_type: TYPES });
  const cycle = seen.byRule('CMDB-062').find((f) => f.target_ids.length > 1);
  assert.ok(cycle, 'the three-CI cycle was not found');
  assert.deepEqual([...cycle.target_ids].sort(), ['a', 'b', 'c']);
  assert.match(cycle.description, /runs in a circle/);
});

test('CMDB-062 does not call a peer-to-peer pair a cycle', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a'), ci('b')],
    cmdb_rel_ci: [edge('r1', 'a', 'b', 'peer', 'Exchanges data with::Exchanges data with'), edge('r2', 'b', 'a', 'peer', 'Exchanges data with::Exchanges data with')],
    cmdb_rel_type: TYPES,
  });
  assert.equal(byRule('CMDB-062').length, 0, 'a symmetric relationship type was read as a cycle');
});

test('CMDB-065 reads the direction from the instance\'s own hosting metadata; CMDB-064 reports the pair it does not permit', () => {
  const estate = {
    cmdb_ci: [ci('host', 'cmdb_ci_server'), ci('app', 'cmdb_ci_web_server'), ci('pkg', 'cmdb_ci_spkg')],
    cmdb_rel_type: TYPES,
    cmdb_metadata_hosting: [{ sys_id: 'h1', parent_type: 'cmdb_ci_appl', child_type: 'cmdb_ci_server', rel_type: 'runs' }],
    cmdb_metadata_containment: [],
  };
  const reversed = run({ ...estate, cmdb_rel_ci: [edge('r1', 'host', 'app', 'runs', 'Runs on::Runs')] });
  const [rev] = reversed.byRule('CMDB-065');
  assert.ok(rev, 'the reversed hosting edge was not reported');
  assert.match(rev.description, /runs the other way for these classes/);
  assert.equal(rev.confidence, 0.88);

  const invalid = run({ ...estate, cmdb_rel_ci: [edge('r2', 'pkg', 'app', 'runs', 'Runs on::Runs')] });
  const [bad] = invalid.byRule('CMDB-064');
  assert.ok(bad, 'the impermissible class pair was not reported');
  assert.match(bad.description, /hosting metadata does not permit for that type/);

  const unscoped = run({ ...estate, cmdb_rel_ci: [edge('r3', 'app', 'host')] });
  assert.equal(unscoped.byRule('CMDB-064').length, 0);
  assert.match(unscoped.skipped('CMDB-064')[0].reason, /no configured class scope/);
});

test('CMDB-063 and CMDB-066 refuse to guess what this version does not record', () => {
  const { byRule, skipped } = run({
    cmdb_ci: [ci('a'), ci('b')],
    cmdb_rel_ci: [edge('r1', 'a', 'b')],
    cmdb_rel_type: TYPES,
    sys_object_source: [],
  });
  assert.equal(byRule('CMDB-063').length + byRule('CMDB-066').length, 0);
  assert.match(skipped('CMDB-063')[0].reason, /No source is attributed to any relationship/);
  assert.match(skipped('CMDB-066')[0].reason, /no last-confirmed timestamp and no source attribution/);
});

/* ════════════════════════ completeness ════════════════════════ */

test('CMDB-058 charges orphans in a MODELLED class and reports an unmodelled class once', () => {
  const estate = {
    cmdb_ci: [ci('s1'), ci('s2'), ci('s3'), ...Array.from({ length: 4 }, (_, i) => ci(`pkg${i}`, 'cmdb_ci_spkg'))],
    cmdb_rel_ci: [edge('r1', 's1', 's2')],
    cmdb_rel_type: TYPES,
  };
  const { byRule, r } = run(estate);
  const charged = byRule('CMDB-058').filter((f) => f.target_ids.length === 1);
  assert.deepEqual(charged.map((f) => f.target_ids[0]), ['s3'], 'the orphan in a modelled class was not charged');
  const grouped = byRule('CMDB-058').find((f) => f.grouped_classes);
  assert.ok(grouped, 'the unmodelled class was not reported');
  assert.deepEqual(grouped.grouped_classes.map((x) => x.cls), ['cmdb_ci_spkg']);
  assert.match(grouped.unscored_reason, /charging every CI of an unmodelled class/);
  const q = scoreCmdbQuality({
    findings: r.findings, kpis: r.kpis, inScope: { ids: estate.cmdb_ci.map((c) => c.sys_id), basis: 't' },
    implemented: IMPLEMENTED_CATALOGUE_RULES, skippedRules: r.skipped,
  });
  assert.ok(q.unscored_findings.some((u) => u.rule_id === 'CMDB-058'), 'the class-level finding was charged');
});

test('a retired CI with no relationships is nobody\'s defect, but an edge into it still is', () => {
  const { byRule, skipped } = run({
    cmdb_ci: [ci('live'), ci('friend'), ci('retired', 'cmdb_ci_server', { install_status: '7' })],
    cmdb_rel_ci: [edge('r1', 'live', 'friend'), edge('r2', 'friend', 'retired')],
    cmdb_rel_type: TYPES,
  });
  assert.equal(byRule('CMDB-058').filter((f) => f.target_ids.includes('retired')).length, 0,
    'a quality rule judged a retired CI');
  assert.deepEqual(byRule('CMDB-061')[0].target_ids, ['friend'], 'the contradiction rule did not judge the same CI');
  assert.match(skipped('CMDB-058').map((x) => x.reason).join(' '), /retired, stolen or absent CI\(s\) are outside this dimension's QUALITY rules/);
});

test('CMDB-059 and CMDB-060: a host with nothing on it, an application with nowhere to run', () => {
  const { byRule } = run({
    cmdb_ci: [ci('host1', 'cmdb_ci_server'), ci('host2', 'cmdb_ci_server'), ci('app1', 'cmdb_ci_web_server'), ci('app2', 'cmdb_ci_web_server')],
    cmdb_rel_ci: [edge('r1', 'app1', 'host1', 'runs', 'Runs on::Runs')],
    cmdb_rel_type: TYPES,
  });
  assert.deepEqual(byRule('CMDB-059').map((f) => f.target_ids[0]), ['host2'], 'the host running something was reported, or the empty one was not');
  assert.deepEqual(byRule('CMDB-060').map((f) => f.target_ids[0]), ['app2']);
  assert.match(byRule('CMDB-060')[0].false_positive_guard.note, /SaaS and externally hosted/);
});

test('CMDB-069 reports a duplicated edge once, naming both ends', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a'), ci('b')],
    cmdb_rel_ci: [edge('r1', 'a', 'b'), edge('r2', 'a', 'b'), edge('r3', 'a', 'b')],
    cmdb_rel_type: TYPES,
  });
  assert.equal(byRule('CMDB-069').length, 1);
  assert.match(byRule('CMDB-069')[0].description, /^3 identical "Depends on::Used by" edges/);
});

/* ════════════════════════ reach, depth, distribution, trend ════════════════════════ */

test('CMDB-057 measures reach from services and gates below the threshold', () => {
  /* Two of nine CIs are reachable from the services: 22%, under the 60% default. */
  const { r, byRule } = run({
    cmdb_ci: [...SERVICES_5.map(svcCi), ci('a'), ci('b'), ci('c'), ci('d')],
    cmdb_ci_service: SERVICES_5.map((id) => ({ sys_id: id, name: id, busines_criticality: '' })),
    cmdb_rel_ci: [edge('r1', 'svc', 'a'), edge('r2', 'a', 'b')],
    cmdb_rel_type: TYPES,
  });
  const kpi = r.kpis.find((k) => k.rule_id === 'CMDB-057');
  assert.deepEqual([kpi.numerator, kpi.denominator], [2, 9]);
  assert.match(kpi.basis, /within 8 hops/);
  const fired = byRule('CMDB-057');
  assert.ok(fired.length, 'a 22% reach did not fire against the 60% threshold');
  assert.equal(fired[0].systemic_kind_override, undefined, 'a real service map must still let CMDB-057 gate');
});

test('decision 2 — too few services and CMDB-057 becomes posture: no KPI, no gate, still reported', () => {
  const services = ['s1', 's2', 's3'];
  const { r, byRule, skipped } = run({
    cmdb_ci: [...services.map(svcCi), ci('a'), ci('b'), ci('c'), ci('d')],
    cmdb_ci_service: services.map((id) => ({ sys_id: id, name: id })),
    cmdb_rel_ci: [edge('r1', 's1', 'a')],
    cmdb_rel_type: TYPES,
  });
  const f = byRule('CMDB-057');
  assert.equal(f.length, 1, 'the absence of a service model must still be reported');
  assert.equal(f[0].systemic_kind_override, 'posture');
  assert.match(f[0].systemic_kind_override_reason, /must not gate/);
  assert.equal(r.kpis.find((k) => k.rule_id === 'CMDB-057'), undefined,
    'a reachability ratio was published against a denominator that cannot carry it');
  assert.match(skipped('CMDB-057').map((x) => x.reason).join(' '), /below the 5-service floor/);

  /* And the score engine must honour it: posture, never a blocker. */
  const q = scoreCmdbQuality({ findings: r.findings, kpis: r.kpis });
  assert.equal(q.gate.blockers.some((b) => b.rule_id === 'CMDB-057'), false, 'posture reached the trust gate');
  const p = q.posture.find((x) => x.rule_id === 'CMDB-057');
  assert.ok(p, 'the downgraded finding vanished instead of being surfaced as posture');
  assert.equal(p.downgraded_from, 'measured_kpi');
});

test('a rule can only ever DOWNGRADE itself out of the gate, never promote itself into it', () => {
  const { r } = run({
    cmdb_ci: [...SERVICES_5.map(svcCi), ci('a'), ci('b'), ci('c'), ci('d')],
    cmdb_ci_service: SERVICES_5.map((id) => ({ sys_id: id, name: id })),
    cmdb_rel_ci: [edge('r1', 'svc', 'a')],
    cmdb_rel_type: TYPES,
  });
  const f = r.findings.find((x) => x.rule_id === 'CMDB-057' && !x.pattern);
  f.systemic_kind_override = 'measured_kpi';          // a rule trying to gate itself
  const q = scoreCmdbQuality({ findings: r.findings, kpis: r.kpis });
  assert.ok(q.gate.blockers.some((b) => b.rule_id === 'CMDB-057'),
    'CMDB-057 gates from the catalogue; an override must not be what puts it there');
  assert.equal(q.gate.blockers.find((b) => b.rule_id === 'CMDB-057').systemic_kind, 'measured_kpi');
});

test('CMDB-067 benchmarks depth against the estate\'s own best-modelled services', () => {
  /* Depths 3, 2, 1, 1, 1 — a spread the 75th percentile can say something about. */
  const { r } = run({
    cmdb_ci: [...['sA', 'sB', 'sC', 'sD', 'sE'].map(svcCi),
      ci('a1'), ci('a2'), ci('a3'), ci('b1'), ci('b2'), ci('c1'), ci('d1'), ci('e1')],
    cmdb_ci_service: ['sA', 'sB', 'sC', 'sD', 'sE'].map((id) => ({ sys_id: id, name: id })),
    cmdb_rel_ci: [
      edge('r1', 'sA', 'a1'), edge('r2', 'a1', 'a2'), edge('r3', 'a2', 'a3'),
      edge('r4', 'sB', 'b1'), edge('r5', 'b1', 'b2'),
      edge('r6', 'sC', 'c1'), edge('r7', 'sD', 'd1'), edge('r8', 'sE', 'e1'),
    ],
    cmdb_rel_type: TYPES,
  });
  const kpi = r.kpis.find((k) => k.rule_id === 'CMDB-067');
  assert.ok(kpi, 'no depth measurement was published');
  assert.match(kpi.basis, /REACH THE EXPECTED DEPTH — 2 tier\(s\)/);
  assert.match(kpi.basis, /span 2 tier\(s\)/);
  assert.deepEqual([kpi.numerator, kpi.denominator], [2, 5]);
  assert.match(kpi.alerts, /CONFIGURABLE DEFAULT/,
    'the pass bar must be flagged as this build\'s default, not a catalogue threshold');
});

test('decision 5 — a benchmark with no spread is circular, and is refused rather than passed', () => {
  /* Five services, every one exactly one tier deep: the percentile IS that depth. */
  const ids = ['s1', 's2', 's3', 's4', 's5'];
  const { r, byRule, skipped } = run({
    cmdb_ci: [...ids.map(svcCi), ...ids.map((id) => ci(`${id}x`))],
    cmdb_ci_service: ids.map((id) => ({ sys_id: id, name: id })),
    cmdb_rel_ci: ids.map((id, i) => edge(`r${i}`, id, `${id}x`)),
    cmdb_rel_type: TYPES,
  });
  assert.equal(r.kpis.find((k) => k.rule_id === 'CMDB-067'), undefined,
    'every service passed a standard derived from those same services');
  assert.equal(byRule('CMDB-067').length, 0);
  assert.match(skipped('CMDB-067').map((x) => x.reason).join(' '), /circular/);
});

test('CMDB-068 needs a real distribution before it calls anything an outlier', () => {
  const small = run({ cmdb_ci: [ci('a'), ci('b')], cmdb_rel_ci: [edge('r1', 'a', 'b')], cmdb_rel_type: TYPES });
  assert.equal(small.byRule('CMDB-068').length, 0);
  assert.match(small.skipped('CMDB-068')[0].reason, /fewer than 30 CIs/);

  const many = Array.from({ length: 40 }, (_, i) => ci(`c${i}`));
  const edges = [];
  /* Everything is related — a real distribution — and c0 is a hub nobody declared. */
  for (let i = 0; i < 39; i += 1) edges.push(edge(`e${i}`, 'c0', `c${i + 1}`));
  const big = run({ cmdb_ci: many, cmdb_rel_ci: edges, cmdb_rel_type: TYPES });
  const [outlier] = big.byRule('CMDB-068');
  assert.ok(outlier, 'a CI with 39 edges against a class mean near 2 was not an outlier');
  assert.deepEqual(outlier.target_ids, ['c0']);
  assert.match(outlier.description, /more than 3 deviations out/);
});

test('the guards the live run added: a laptop is not a host, an unlisted class pair is not forbidden, and an unmodelled class has no outliers', () => {
  /* All three measured on dev424910, 16 Sep 2026. */
  const workstations = run({
    cmdb_ci: [ci('laptop', 'cmdb_ci_computer'), ci('srv', 'cmdb_ci_server')],
    cmdb_rel_ci: [],
    cmdb_rel_type: TYPES,
  });
  assert.deepEqual(workstations.byRule('CMDB-059').map((f) => f.target_ids[0]), ['srv'],
    'an end-user computer was judged as a host with nothing on it');

  const noOpinion = run({
    cmdb_ci: [ci('s1', 'cmdb_ci_service'), ci('s2', 'cmdb_ci_service')],
    cmdb_rel_ci: [edge('r1', 's1', 's2', 'runs', 'Runs on::Runs')],
    cmdb_rel_type: TYPES,
    cmdb_metadata_hosting: [{ sys_id: 'h1', parent_type: 'cmdb_ci_appl', child_type: 'cmdb_ci_server', rel_type: 'runs' }],
    cmdb_metadata_containment: [],
  });
  assert.equal(noOpinion.byRule('CMDB-064').length, 0, 'a class pair the metadata never mentions was called impermissible');
  assert.match(noOpinion.skipped('CMDB-064').map((x) => x.reason).join(' '), /says anything about for their type/);

  /* 40 CIs, one of them related: the modelled one must not be the anomaly. */
  const many = Array.from({ length: 40 }, (_, i) => ci(`c${i}`, 'cmdb_ci_computer'));
  const unmodelled = run({ cmdb_ci: [...many, ci('other')], cmdb_rel_ci: [edge('r1', 'c0', 'other')], cmdb_rel_type: TYPES });
  assert.equal(unmodelled.byRule('CMDB-068').length, 0, 'the one modelled CI in an unmodelled class was reported as an outlier');
  assert.match(unmodelled.skipped('CMDB-068').map((x) => x.reason).join(' '), /fewer than 10% of their CIs related/);
});

test('CMDB-056 needs two snapshots, and fires on a collapse rather than on attrition', () => {
  const estate = { cmdb_ci: [ci('a'), ci('b')], cmdb_rel_ci: [edge('r1', 'a', 'b')], cmdb_rel_type: TYPES };
  const first = run(estate);
  assert.match(first.skipped('CMDB-056')[0].reason, /Needs 2 snapshots of the relationship count; 1 exist/);
  assert.equal(first.r.measures.relationship_counts.total, 1);

  const steady = run(estate, { history: { relationship_counts: [{ at: '2026-09-10T06:00:00Z', total: 1 }] } });
  assert.equal(steady.byRule('CMDB-056').length, 0, 'an unchanged count read as a collapse');

  const collapsed = run(estate, { history: { relationship_counts: [{ at: '2026-09-10T06:00:00Z', total: 10 }] } });
  const [x] = collapsed.byRule('CMDB-056');
  assert.ok(x, 'a 90% drop did not fire');
  assert.match(x.description, /fell from 10 to 1 \(90%\)/);
  assert.match(x.false_positive_guard.note, /planned decommission/);
});

test('every Group 6 rule refuses to run when the relationships were not read completely', () => {
  const cov = full();
  cov.cmdb_rel_ci = { table: 'cmdb_rel_ci', status: 'limited', rows_complete: false, missing_fields: [] };
  const { r } = run({ cmdb_ci: [ci('a')], cmdb_rel_ci: [] }, { coverage: cov });
  assert.equal(r.findings.filter((f) => RELATIONSHIP_RULES.includes(f.rule_id)).length, 0);
  for (const rule of RELATIONSHIP_RULES) {
    assert.ok(r.skipped.some((s) => s.rule === rule && /not read completely/.test(s.reason)), `${rule} ran on a partial edge set`);
  }
});

/* ════════════ the decisions of Sep 2026, measured on dev424910 ════════════ */

test('decision 1 — host and endpoint lists are subtree roots, so an estate\'s own subclasses are covered', () => {
  const { byRule } = run({
    cmdb_ci: [ci('srv', 'cmdb_ci_server'), ci('laptop', 'cmdb_ci_computer'), ci('prn', 'cmdb_ci_printer')],
    cmdb_rel_ci: [],
    cmdb_rel_type: TYPES,
  });
  /* `cmdb_ci_server` is the ROOT: every server subclass is a host without listing it. */
  assert.deepEqual(byRule('CMDB-059').map((f) => f.target_ids[0]), ['srv']);
});

test('decision 3 — a class-wide pattern never silences the records under it; leaf devices are charged LOW', () => {
  /* 40 laptops, one related, so the class IS modelled and the other 39 are orphans. */
  const laptops = Array.from({ length: 40 }, (_, i) => ci(`l${i}`, 'cmdb_ci_computer'));
  const { byRule, r } = run({
    cmdb_ci: [...laptops, ci('db1', 'cmdb_ci_db_instance'), ci('db2', 'cmdb_ci_db_instance'), ci('hub')],
    cmdb_rel_ci: [edge('r1', 'l0', 'hub'), edge('r2', 'db1', 'hub')],
    cmdb_rel_type: TYPES,
  });
  const orphans = byRule('CMDB-058');
  const laptopFindings = orphans.filter((f) => f.target_ids[0].startsWith('l'));
  assert.equal(laptopFindings.length, 39, 'a pattern swallowed the records under it');
  for (const f of laptopFindings) {
    assert.equal(f.deduction_severity, 'LOW', 'an orphaned leaf device was charged the full orphan band');
    assert.equal(f.base_severity, 'CRITICAL', 'the REPORTED band must not move — only the charge');
    assert.match(f.deduction_note, /Reported in full either way/);
  }
  const db = orphans.find((f) => f.target_ids[0] === 'db2');
  assert.ok(db, 'an unrelated database is not a leaf device and must still be found');
  assert.equal(db.deduction_band_override, undefined, 'a database with no relationships was discounted as a leaf');
  assert.equal(db.deduction_note, undefined);
  assert.ok(['CRITICAL', 'SYSTEMIC'].includes(db.deduction_severity),
    `an unrelated database must carry the full charge, not ${db.deduction_severity}`);

  /* And the cap is DOWNGRADE-ONLY: a leaf its own context escalates still zeroes. */
  const escalated = run({
    cmdb_ci: [...Array.from({ length: 40 }, (_, i) => ci(`p${i}`, 'cmdb_ci_printer')), ci('hub')],
    cmdb_rel_ci: [edge('r1', 'p0', 'hub')],
    cmdb_rel_type: TYPES,
  }).byRule('CMDB-058').filter((f) => f.modifiers.escalators.length && f.deduction_severity === 'SYSTEMIC');
  for (const f of escalated) {
    assert.equal(f.deduction_band_override, 'LOW', 'the cap should still be declared');
    assert.equal(f.deduction_severity, 'SYSTEMIC', 'an escalation was overridden by the leaf-device cap');
  }
  /* The pattern is still raised — it just deducts nothing. */
  assert.ok(r.findings.some((f) => f.pattern && f.rule_id === 'CMDB-058'), 'no class-wide pattern was raised');
});

test('decision 4 — containment declares pairs too, and is_reverse decides which end is which', () => {
  /* Containment is a TREE: the child row points at the parent row by sys_id. */
  const contained = run({
    cmdb_ci: [ci('web', 'cmdb_ci_web_server'), ci('srv', 'cmdb_ci_server')],
    cmdb_rel_ci: [edge('r1', 'web', 'srv', 'runs', 'Runs on::Runs')],
    cmdb_rel_type: TYPES,
    cmdb_metadata_hosting: [],
    cmdb_metadata_containment: [
      { sys_id: 'p1', ci_type: 'cmdb_ci_server', parent_id: '', rel_type: '' },
      { sys_id: 'c1', ci_type: 'cmdb_ci_web_server', parent_id: 'p1', rel_type: 'runs', is_reverse: 'false' },
    ],
  });
  assert.equal(contained.byRule('CMDB-065').length, 1,
    'containment metadata was not read as a declared scope, so a reversed edge went unjudged');

  /* is_reverse swaps the pair. Ignoring it inverts the permitted direction. */
  const reversed = run({
    cmdb_ci: [ci('web', 'cmdb_ci_web_server'), ci('srv', 'cmdb_ci_server')],
    cmdb_rel_ci: [edge('r1', 'srv', 'web', 'runs', 'Runs on::Runs')],
    cmdb_rel_type: TYPES,
    cmdb_metadata_hosting: [{ sys_id: 'h1', parent_type: 'cmdb_ci_web_server', child_type: 'cmdb_ci_server', rel_type: 'runs', is_reverse: 'true' }],
    cmdb_metadata_containment: [],
  });
  assert.equal(reversed.byRule('CMDB-065').length, 0,
    'is_reverse was ignored, so a correct edge was reported as running the wrong way');
  assert.equal(reversed.byRule('CMDB-064').length, 0);
});

test('decision 6 — edge provenance is never approximated from sys_created_by', () => {
  const { skipped } = run({
    cmdb_ci: [ci('a'), ci('b')],
    cmdb_rel_ci: [edge('r1', 'a', 'b')],
    cmdb_rel_type: TYPES,
  });
  assert.match(skipped('CMDB-063').map((x) => x.reason).join(' '), /not approximated from sys_created_by/i);
  assert.match(skipped('CMDB-066').map((x) => x.reason).join(' '), /attributes and re-confirms its own edges/);
});
