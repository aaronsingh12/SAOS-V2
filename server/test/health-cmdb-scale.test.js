import test from 'node:test';
import assert from 'node:assert/strict';

import { CMDB_CATALOGUE, scoreCmdbQuality } from '../src/health/cmdb-quality.js';
import { EstateRules, IMPLEMENTED_CATALOGUE_RULES } from '../src/health/rules.js';
import { SCALE_RULES, SCALE_TRACKS, SCALE_DEFAULTS, cmdbScaleRules } from '../src/health/cmdb-scale.js';
import { trackMisroutes } from '../src/health/cmdb-csdm.js';
import { scopeOf, scopeOfRule } from '../src/health/scopes.js';
import { buildSignals } from '../src/health/cmdb-signals.js';

/*
 * Health Assist — Group 13 (Scale and platform impact), Sep 2026.
 *
 * A PLATFORM INDICATOR, never in the composite: this group asks whether the
 * CMDB has grown into a shape the platform struggles with, which is a different
 * question with a different owner from whether the data is right.
 *
 * Two things guarded hardest: that none of it reaches the score, and that these
 * rules — the ones most likely to be superlinear themselves — are timed.
 */

const NOW = new Date('2026-09-16T06:00:00Z');
const ok = { status: 'ok' };
const TABLES = ['cmdb_ci', 'cmdb_rel_ci', 'sys_archive', 'sys_archive_destroy', 'sys_table_rotation',
  'syslog_transaction', 'sys_db_index', 'discovery_device_history'];
const full = (over = {}) => Object.fromEntries(TABLES.map((t) => [t,
  { table: t, status: 'complete', rows_complete: true, missing_fields: [], ...(over[t] || {}) }]));
const CLASSES = {
  cmdb: { super: null }, cmdb_ci: { super: 'cmdb' }, cmdb_ci_hardware: { super: 'cmdb_ci' },
  cmdb_ci_computer: { super: 'cmdb_ci_hardware' }, cmdb_ci_server: { super: 'cmdb_ci_computer' },
  cmdb_ci_appl: { super: 'cmdb_ci' }, cmdb_ci_netgear: { super: 'cmdb_ci_hardware' },
  cmdb_ci_spkg: { super: 'cmdb_ci' },
};

function run(estate, { coverage = full(), options = {}, history = {} } = {}) {
  const r = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [], ...estate }, coverage, 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok }, classes: { byName: CLASSES }, virtualIds: [], usedFor: {}, choices: [] } },
    history,
  });
  r.signals = buildSignals(r);
  cmdbScaleRules(r, options);
  return {
    r,
    byRule: (id) => r.findings.filter((x) => x.rule_id === id && !x.pattern),
    reason: (id) => r.skipped.filter((s) => s.rule === id).map((s) => s.reason).join(' | '),
  };
}

const ci = (id, cls = 'cmdb_ci_server') => ({
  sys_id: id, name: id, sys_class_name: cls, install_status: '1', operational_status: '1',
  sys_created_on: '2015-01-01 00:00:00', sys_updated_on: '2026-09-01 00:00:00',
});
const many = (n, cls, prefix = 'c') => Array.from({ length: n }, (_, i) => ci(`${prefix}${i}`, cls));
const edge = (sys_id, parent, child) => ({ sys_id, parent, child, type: 't', 'type.name': 'Depends on::Used by' });

/* ════════════ never in the composite, and timed ════════════ */

test('Group 13 is built, sits on the platform track, and reaches no dimension', () => {
  for (const id of SCALE_RULES) {
    assert.ok(IMPLEMENTED_CATALOGUE_RULES.has(id), id);
    assert.equal(CMDB_CATALOGUE[id].track, 'platform', `${id} must be a platform indicator`);
    assert.equal(CMDB_CATALOGUE[id].dimension, null, `${id} must have no scoring dimension`);
  }
  assert.deepEqual(trackMisroutes(CMDB_CATALOGUE, SCALE_TRACKS), []);
});

test('scale findings are counted on the platform track and move no dimension score', () => {
  const { r } = run({ cmdb_ci: many(60, 'cmdb_ci_server'), cmdb_rel_ci: [] });
  const q = scoreCmdbQuality({ findings: r.findings, kpis: r.kpis });
  assert.ok(r.findings.length, 'the fixture should have produced platform findings');
  assert.ok(q.tracks.platform > 0, 'platform findings must be counted on their track');
  for (const f of r.findings) assert.equal(CMDB_CATALOGUE[f.rule_id].dimension, null, `${f.rule_id} charged a dimension`);
  assert.equal(q.gate.blockers.some((b) => SCALE_RULES.includes(b.rule_id)), false);
});

test('every rule reports its own wall time — a scale rule must not become the scale problem', () => {
  const { r } = run({ cmdb_ci: many(60, 'cmdb_ci_server'), cmdb_rel_ci: [] });
  const t = r.measures.scale_timings;
  assert.ok(t, 'no timings were published');
  for (const id of ['CMDB-124', 'CMDB-125', 'CMDB-126', 'CMDB-127', 'CMDB-128', 'CMDB-129', 'CMDB-130']) {
    assert.equal(typeof t[id], 'number', `${id} was not timed`);
  }
  assert.equal(typeof t.total_ms, 'number');
});

/* ════════════ the derived band ════════════ */

test('CMDB-124 judges each tier against its own expectation and names the tier the verdict rests on', () => {
  /* 60 servers expect 3 edges each; one edge is far below. */
  const { byRule, r } = run({ cmdb_ci: many(60, 'cmdb_ci_server'), cmdb_rel_ci: [edge('r1', 'c0', 'c1')] });
  const f = byRule('CMDB-124');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /FAR BELOW/);
  assert.match(f[0].description, /THE VERDICT RESTS MOSTLY ON THE HOST TIER/);
  assert.match(f[0].description, /edgesPerCiByTier\.host = 3\) is a per-estate setting/);
  assert.equal(f[0].false_positive_guard.evaluated, true);
  assert.equal(r.measures.scale_ratio.dominant_tier, 'host');
  const host = r.measures.scale_ratio.tiers.find((t) => t.tier === 'host');
  assert.deepEqual([host.cis, host.expected_edges, host.actual_edges], [60, 180, 1]);
});

test('CMDB-124 — a large ZERO-expectation tier cannot drag the estate\'s bar (the dev424910 distortion)', () => {
  /*
   * Measured on dev424910: 1,767 software packages at the old `other` default
   * of one edge each set 0.92 edges/CI almost single-handed, so the finding was
   * measuring the parameter. Here 1,767 packages sit beside 20 well-modelled
   * servers carrying 60 edges (3 each, exactly as expected).
   */
  const servers = many(20, 'cmdb_ci_server', 's');
  const edges = Array.from({ length: 60 }, (_, i) => edge(`e${i}`, `s${i % 20}`, `s${(i + 1) % 20}`));
  const { byRule, reason, r } = run({ cmdb_ci: [...servers, ...many(1767, 'cmdb_ci_spkg', 'p')], cmdb_rel_ci: edges });
  assert.equal(byRule('CMDB-124').length, 0,
    'software packages that expect no edges must not turn a well-modelled estate into a sparse one');
  assert.match(reason('CMDB-124'), /NOT JUDGED: 1,767 software CI\(s\) — edgesPerCiByTier\.software set to 0 expected edges/);
  assert.equal(r.measures.scale_ratio.estate_ratio, 1);
});

test('CMDB-124 weights tiers by expected edge MASS, not by CI count', () => {
  /*
   * An estate that DOES model endpoints raises the setting (default 0). 200
   * printers (0.5 each → 100 expected) carry nothing; 10 hubs (6 each → 60
   * expected) are fully modelled. Weighted by count the printers would be 95% of
   * the verdict; weighted by expected mass they are 62.5%, and the hubs count.
   */
  const hubs = many(10, 'cmdb_ci_netgear', 'h');
  const hubEdges = Array.from({ length: 60 }, (_, i) => edge(`e${i}`, `h${i % 10}`, `h${(i + 3) % 10}`));
  const { r } = run({ cmdb_ci: [...hubs, ...many(200, 'cmdb_ci_computer', 'pc')], cmdb_rel_ci: hubEdges },
    { options: { edgesPerCiByTier: { ...SCALE_DEFAULTS.edgesPerCiByTier, endpoint: 0.5 } } });
  const ratio = r.measures.scale_ratio.estate_ratio;
  assert.equal(ratio, 0.375, '(100 × 0 + 60 × 1) / 160');
  assert.equal(r.measures.scale_ratio.dominant_tier, 'endpoint', 'the printers are the shortfall, and are named as such');
});

test('CMDB-124 does not charge an estate for endpoint relationships it was never expected to model', () => {
  /*
   * Decided 17 Sep 2026 from dev424910, where the endpoint tier at 0.5/laptop was
   * 421.5 of 795.5 expected edges and flipped the verdict on its own. Here 300
   * laptops carry 4 edges between them beside 20 fully modelled servers: by
   * default the laptops are not judged, and the result SAYS so, with the edges
   * they carry anyway — the same estate at 0.5 fires, on the endpoint tier.
   */
  const servers = many(20, 'cmdb_ci_server', 's');
  const edges = [
    ...Array.from({ length: 60 }, (_, i) => edge(`e${i}`, `s${i % 20}`, `s${(i + 1) % 20}`)),
    ...Array.from({ length: 4 }, (_, i) => edge(`l${i}`, `pc${i}`, `pc${i + 1}`)),
  ];
  const estate = { cmdb_ci: [...servers, ...many(300, 'cmdb_ci_computer', 'pc')], cmdb_rel_ci: edges };
  assert.equal(SCALE_DEFAULTS.edgesPerCiByTier.endpoint, 0);

  const byDefault = run(estate);
  assert.equal(byDefault.byRule('CMDB-124').length, 0);
  assert.match(byDefault.reason('CMDB-124'), /NOT JUDGED: 300 endpoint CI\(s\) \(carrying 4\.0 edge\(s\) anyway\) — edgesPerCiByTier\.endpoint set to 0 expected edges/);
  assert.match(byDefault.reason('CMDB-124'), /Raise the setting and re-run if you model them/);
  assert.equal(byDefault.r.measures.scale_ratio.tiers.find((t) => t.tier === 'endpoint').in_band, null);

  const modelled = run(estate, { options: { edgesPerCiByTier: { ...SCALE_DEFAULTS.edgesPerCiByTier, endpoint: 0.5 } } });
  assert.equal(modelled.byRule('CMDB-124').length, 1, 'an estate that says it models endpoints is judged on them');
  assert.equal(modelled.r.measures.scale_ratio.dominant_tier, 'endpoint');
});

test('CMDB-124 does not judge a ratio on an estate too small to have one', () => {
  const { byRule, reason } = run({ cmdb_ci: many(10, 'cmdb_ci_server'), cmdb_rel_ci: [] });
  assert.equal(byRule('CMDB-124').length, 0);
  assert.match(reason('CMDB-124'), /too few for a ratio to mean anything/);
});

test('CMDB-124 accepts a network-weighted estate running denser', () => {
  /* 60 hubs expect ~6 edges each: 360 edges is inside the band, not an anomaly. */
  const edges = Array.from({ length: 360 }, (_, i) => edge(`e${i}`, `n${i % 60}`, `n${(i + 1) % 60}`));
  const { byRule, reason } = run({ cmdb_ci: many(60, 'cmdb_ci_netgear', 'n'), cmdb_rel_ci: edges });
  assert.equal(byRule('CMDB-124').length, 0);
  assert.match(reason('CMDB-124'), /carries 100% of the relationships its tiers predict/);
});

/* ════════════ trends abstain until they have a baseline ════════════ */

test('CMDB-125 and CMDB-128 abstain rather than reporting a stable estate from one reading', () => {
  const { byRule, reason, r } = run({ cmdb_ci: many(60, 'cmdb_ci_server'), cmdb_rel_ci: [] });
  assert.equal(byRule('CMDB-125').length, 0);
  assert.equal(byRule('CMDB-128').length, 0);
  assert.match(reason('CMDB-125'), /NOT MEASURED — growth needs 2 snapshots/);
  assert.match(reason('CMDB-125'), /"no growth observed" and "no growth" are different findings/);
  assert.match(reason('CMDB-128'), /needs 3 snapshots to be a trend rather than a difference/);
  /* The snapshot IS recorded, so the next run has a baseline. */
  assert.equal(r.measures.scale_snapshot.cis, 60);
});

test('CMDB-125 fires on growth with no discovery behind it, once there is a baseline', () => {
  const history = { scale_snapshot: [{ at: '2026-08-16T06:00:00.000Z', cis: 50, edges: 0, classes: [{ cls: 'cmdb_ci_server', cis: 50 }] }] };
  const { byRule } = run({ cmdb_ci: many(60, 'cmdb_ci_server'), cmdb_rel_ci: [] }, { history });
  const f = byRule('CMDB-125');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /cmdb_ci_server \+10/);
  assert.match(f[0].description, /NO discovery activity is recorded/);
});

test('CMDB-125 is satisfied when discovery IS behind the growth', () => {
  const history = { scale_snapshot: [{ at: '2026-08-16T06:00:00.000Z', cis: 50, edges: 0, classes: [{ cls: 'cmdb_ci_server', cis: 50 }] }] };
  const { byRule, reason } = run({
    cmdb_ci: many(60, 'cmdb_ci_server'), cmdb_rel_ci: [],
    discovery_device_history: [{ sys_id: 'h1', cmdb_ci: 'c0' }],
  }, { history });
  assert.equal(byRule('CMDB-125').length, 0);
  assert.match(reason('CMDB-125'), /the growth has discovery behind it/);
});

test('CMDB-128 reports a rate only once three snapshots exist, and shows CI growth beside it', () => {
  const history = {
    scale_snapshot: [
      { at: '2026-07-17T06:00:00.000Z', cis: 40, edges: 10, classes: [] },
      { at: '2026-08-16T06:00:00.000Z', cis: 50, edges: 40, classes: [] },
    ],
  };
  const { byRule, r } = run({ cmdb_ci: many(60, 'cmdb_ci_server'), cmdb_rel_ci: [edge('r1', 'c0', 'c1')] }, { history });
  const f = byRule('CMDB-128');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /rows\/day over 61 days and 3 snapshots/);
  assert.equal(r.measures.growth_rates.snapshots, 3);
});

/* ════════════ our own access is never an estate defect ════════════ */

test('CMDB-127 refuses to call a table unindexed when indexes cannot be read at all', () => {
  const { byRule, reason } = run({ cmdb_ci: many(60, 'cmdb_ci_server') }, {
    coverage: full({ sys_db_index: { status: 'unavailable', rows_complete: false } }),
  });
  assert.equal(byRule('CMDB-127').length, 0);
  assert.match(reason('CMDB-127'), /sys_index is refused to the connected account/);
  assert.match(reason('CMDB-127'), /reporting our own access as a defect/);
});

test('CMDB-126 does not read a 292,530-row transaction log by default', () => {
  const { byRule, reason } = run({ cmdb_ci: many(60, 'cmdb_ci_server') }, {
    coverage: full({ syslog_transaction: { status: 'not_requested', rows_complete: false } }),
  });
  assert.equal(byRule('CMDB-126').length, 0);
  assert.match(reason('CMDB-126'), /a rule about scale must not become the scale problem/);
});

test('CMDB-126 ranks slow CMDB transactions by total time when the log IS read', () => {
  const { byRule } = run({
    cmdb_ci: many(60, 'cmdb_ci_server'),
    syslog_transaction: [
      { sys_id: 't1', table: 'cmdb_ci', url: '/cmdb_ci_list.do', response_time: '5000' },
      { sys_id: 't2', table: 'cmdb_ci', url: '/cmdb_ci_list.do', response_time: '4000' },
      { sys_id: 't3', table: 'cmdb_rel_ci', url: '/rel.do', response_time: '3000' },
      { sys_id: 't4', table: 'incident', url: '/inc.do', response_time: '9000' },
      { sys_id: 't5', table: 'cmdb_ci', url: '/fast.do', response_time: '20' },
    ],
  });
  const f = byRule('CMDB-126');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /3 of 4 transactions against CMDB tables/);
  assert.match(f[0].description, /cmdb_ci \(2, worst 5000ms\)/);
  assert.equal(/incident/.test(f[0].description), false, 'a non-CMDB table is not this rule\'s business');
});

/* ════════════ history tables nobody clears ════════════ */

test('CMDB-130 finds history tables with no rotation or archival', () => {
  const { byRule } = run({
    cmdb_ci: many(60, 'cmdb_ci_server'),
    sys_archive: [{ sys_id: 'a1', table: 'sys_audit', active: 'true' }],
    sys_table_rotation: [{ sys_id: 'r1', name: 'sys_history_line' }],
  });
  const f = byRule('CMDB-130');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /sys_history_set, sys_audit_delete/);
  assert.equal(/sys_audit,/.test(f[0].description), false, 'an archived table is covered');
});

test('CMDB-130 is satisfied when every history table is covered', () => {
  const { byRule, reason } = run({
    cmdb_ci: many(60, 'cmdb_ci_server'),
    sys_table_rotation: ['sys_audit', 'sys_history_line', 'sys_history_set', 'sys_audit_delete']
      .map((name, i) => ({ sys_id: `r${i}`, name })),
  });
  assert.equal(byRule('CMDB-130').length, 0);
  assert.match(reason('CMDB-130'), /is covered by a rotation or archival rule/);
});

test('CMDB-129 is a measure: it reports the shape of the estate and charges nothing', () => {
  const { byRule, r } = run({ cmdb_ci: [...many(60, 'cmdb_ci_server'), ...many(5, 'cmdb_ci_appl', 'a')] });
  const f = byRule('CMDB-129');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /65 CIs across 2 class\(es\)/);
  assert.match(f[0].description, /first snapshot/);
  assert.equal(CMDB_CATALOGUE['CMDB-129'].track, 'platform');
  assert.equal(r.measures.class_sizes.length, 2);
});

test('every Group 13 rule refuses to run when the CIs were not read completely', () => {
  const { r } = run({ cmdb_ci: [ci('a')] }, { coverage: full({ cmdb_ci: { status: 'truncated', rows_complete: false } }) });
  assert.equal(r.findings.length, 0);
  for (const id of SCALE_RULES) assert.ok(r.skipped.some((s) => s.rule === id), `${id} ran anyway`);
});

test('REGRESSION: on a CMDB-only scan the scale findings SURVIVE the module filter', () => {
  /*
   * Measured on dev424910: CMDB-124 was out of band on a CMDB-only scan and
   * reported neither a finding nor a skip. The pack reports through
   * performance_agent, whose domain is Platform, and analyze() filtered its
   * findings out while keeping its skips. Every other test here calls the pack
   * directly and never passes through that filter — this one does.
   */
  const r = new EstateRules({ cmdb_ci: many(60, 'cmdb_ci_server'), cmdb_rel_ci: [edge('r1', 'c0', 'c1')] }, full(), 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok }, classes: { byName: CLASSES }, virtualIds: [], usedFor: {}, choices: [] } },
  });
  const findings = r.analyze({ modules: ['cmdb'] });
  assert.ok(findings.some((f) => f.rule_id === 'CMDB-124'), 'CMDB-124 was dropped from a CMDB-only scan');
  assert.ok(findings.some((f) => f.rule_id === 'CMDB-129'), 'CMDB-129 was dropped from a CMDB-only scan');
  for (const f of findings.filter((x) => SCALE_RULES.includes(x.rule_id))) {
    assert.equal(f.domain, 'PERFORMANCE', 'the domain label is unchanged');
    assert.equal(scopeOf(f), 'cmdb', `${f.rule_id} routed away from the module that ran it`);
  }
});

test('a rule\'s findings and its skips always resolve to the same module', () => {
  for (const id of Object.keys(CMDB_CATALOGUE)) {
    for (const domain of ['PERFORMANCE', 'SECURITY', 'INCIDENT', 'DISCOVERY', 'CMDB']) {
      assert.equal(scopeOf({ rule_id: id, domain }), scopeOfRule(id), `${id} with domain ${domain}`);
    }
  }
});
