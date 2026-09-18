import test from 'node:test';
import assert from 'node:assert/strict';

import { CMDB_CATALOGUE, scoreCmdbQuality } from '../src/health/cmdb-quality.js';
import { EstateRules, IMPLEMENTED_CATALOGUE_RULES } from '../src/health/rules.js';
import { CSDM_RULES, CSDM_TRACKS, cmdbCsdmRules, trackMisroutes } from '../src/health/cmdb-csdm.js';
import { buildSignals } from '../src/health/cmdb-signals.js';

/*
 * Health Assist — Group 11 (CSDM linkage), Sep 2026.
 *
 * A MIXED group: CMDB-109/110/113/114 feed the scored D10 dimension, and
 * CMDB-111/112/115 are CSDM-maturity posture that must never charge anything.
 * The first tests here guard that split in both directions, because a posture
 * rule that quietly acquires a dimension starts charging the composite and a D10
 * rule that quietly loses one stops — and neither announces itself.
 *
 * The second theme is that an ABSENT CSDM LAYER is not zero defects. "No
 * Business Service is unreachable" and "there are no Business Services" look
 * identical in a count and are opposite findings.
 */

const NOW = new Date('2026-09-16T06:00:00Z');
const ok = { status: 'ok' };
const TABLES = ['cmdb_ci', 'cmdb_ci_service', 'cmdb_rel_ci', 'svc_ci_assoc', 'cmdb_class_info'];
const full = (over = {}) => Object.fromEntries(TABLES.map((t) => [t,
  { table: t, status: 'complete', rows_complete: true, missing_fields: [], ...(over[t] || {}) }]));
const CLASSES = {
  cmdb: { super: null }, cmdb_ci: { super: 'cmdb' }, cmdb_ci_hardware: { super: 'cmdb_ci' },
  cmdb_ci_computer: { super: 'cmdb_ci_hardware' }, cmdb_ci_server: { super: 'cmdb_ci_computer' },
  cmdb_ci_appl: { super: 'cmdb_ci' },
  cmdb_ci_service: { super: 'cmdb_ci' },
  cmdb_ci_service_business: { super: 'cmdb_ci_service' },
  cmdb_ci_service_auto: { super: 'cmdb_ci_service' },
  cmdb_ci_business_capability: { super: 'cmdb_ci' },
};

function run(estate, { coverage = full(), options = {} } = {}) {
  const r = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [], ...estate }, coverage, 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok, used_for: ok, virtual: ok }, classes: { byName: CLASSES }, virtualIds: [], usedFor: {}, choices: [] } },
  });
  r.signals = buildSignals(r);
  cmdbCsdmRules(r, options);
  return {
    r,
    byRule: (id) => r.findings.filter((x) => x.rule_id === id && !x.pattern),
    charged: (id) => r.findings.filter((x) => x.rule_id === id && !x.pattern && !x.unscored_reason),
    headline: (id) => r.findings.find((x) => x.rule_id === id && x.unscored_reason),
    reason: (id) => r.skipped.filter((s) => s.rule === id).map((s) => s.reason).join(' | '),
    kpi: (id) => r.kpis.find((k) => k.rule_id === id),
  };
}

const ci = (id, cls = 'cmdb_ci_server', over = {}) => ({
  sys_id: id, name: id, sys_class_name: cls, install_status: '1', operational_status: '1',
  sys_created_on: '2015-01-01 00:00:00', sys_updated_on: '2026-09-01 00:00:00', ...over,
});
const svc = (id, cls = 'cmdb_ci_service', over = {}) => ({ sys_id: id, name: id, sys_class_name: cls, ...over });
const edge = (sys_id, parent, child) => ({ sys_id, parent, child, type: 'dep', 'type.name': 'Depends on::Used by' });

/* ════════════ the mixed track — guarded in both directions ════════════ */

test('Group 11 is built, and the catalogue agrees with the track each rule DECLARES', () => {
  for (const id of CSDM_RULES) assert.ok(IMPLEMENTED_CATALOGUE_RULES.has(id), id);
  assert.deepEqual(trackMisroutes(CMDB_CATALOGUE), [], 'a CSDM rule is routed to a track it does not declare');

  for (const [id, want] of Object.entries(CSDM_TRACKS)) {
    const rule = CMDB_CATALOGUE[id];
    const scored = rule.track === 'dimension' && Boolean(rule.dimension);
    assert.equal(scored, want.scored, id);
    if (want.scored) assert.equal(rule.dimension, want.dimension, id);
  }
  /* The split itself, stated once so a future edit has to argue with it. */
  assert.deepEqual(Object.entries(CSDM_TRACKS).filter(([, w]) => w.scored).map(([id]) => id),
    ['CMDB-109', 'CMDB-110', 'CMDB-113', 'CMDB-114']);
});

test('trackMisroutes catches a posture rule that acquires a dimension, and a D10 rule that loses one', () => {
  const posturedIntoScoring = { ...CMDB_CATALOGUE, 'CMDB-112': { ...CMDB_CATALOGUE['CMDB-112'], track: 'dimension', dimension: 'D10' } };
  const bad1 = trackMisroutes(posturedIntoScoring);
  assert.equal(bad1.length, 1);
  assert.match(bad1[0].why, /declared as POSTURE but the catalogue scores it in D10/);

  const scoringGoneQuiet = { ...CMDB_CATALOGUE, 'CMDB-113': { ...CMDB_CATALOGUE['CMDB-113'], track: 'csdm-maturity', dimension: null } };
  const bad2 = trackMisroutes(scoringGoneQuiet);
  assert.equal(bad2.length, 1);
  assert.match(bad2[0].why, /would stop charging the score without saying so/);
});

test('a posture rule never reaches the composite, and a D10 rule does', () => {
  const { r } = run({
    cmdb_ci: [ci('svc1', 'cmdb_ci_service'), ci('lonely'), ci('app', 'cmdb_ci_appl')],
    cmdb_ci_service: [svc('svc1')],
    cmdb_rel_ci: [],
  });
  const q = scoreCmdbQuality({ findings: r.findings, kpis: r.kpis });
  const d10 = q.dimensions.find((d) => d.key === 'D10');
  const postureIds = Object.entries(CSDM_TRACKS).filter(([, w]) => !w.scored).map(([id]) => id);
  for (const f of r.findings) {
    if (!postureIds.includes(f.rule_id)) continue;
    assert.equal(CMDB_CATALOGUE[f.rule_id].dimension, null, `${f.rule_id} charged a dimension`);
  }
  assert.ok(d10, 'D10 should still exist');
});

/* ════════════ an absent layer is not zero defects ════════════ */

test('CMDB-110 says the Application Service layer is absent rather than reporting no defects', () => {
  const { byRule, reason } = run({
    cmdb_ci: [ci('svc1', 'cmdb_ci_service')],
    cmdb_ci_service: [svc('svc1')],
  });
  assert.equal(byRule('CMDB-110').length, 0);
  assert.match(reason('CMDB-110'), /Application Service layer is not in use/);
  assert.match(reason('CMDB-110'), /reporting zero defects here would say the opposite/);
});

test('CMDB-112 scopes to the layers in use when there is no Business Capability', () => {
  const { byRule, kpi, reason } = run({
    cmdb_ci: [ci('svc1', 'cmdb_ci_service'), ci('a')],
    cmdb_ci_service: [svc('svc1')],
  });
  assert.equal(byRule('CMDB-112').length, 0);
  assert.equal(kpi('CMDB-112'), undefined, 'no percentage against a layer nobody has adopted');
  assert.match(reason('CMDB-112'), /Business Capability layer is not in use/);
  assert.match(reason('CMDB-112'), /report scoped to the layers in use/);
});

test('CMDB-112 measures reach when the capability layer DOES exist', () => {
  const { kpi, byRule } = run({
    cmdb_ci: [ci('cap', 'cmdb_ci_business_capability'), ci('svc1', 'cmdb_ci_service'), ci('a'), ci('b'), ci('c'), ci('d'), ci('e')],
    cmdb_ci_service: [svc('svc1')],
    cmdb_rel_ci: [edge('r1', 'cap', 'svc1'), edge('r2', 'svc1', 'a')],
  });
  const k = kpi('CMDB-112');
  assert.ok(k, 'the KPI must be published where the layer exists');
  assert.match(k.alerts, /never inside it/);
  assert.deepEqual([k.numerator, k.denominator], [2, 7], 'a capability does not reach itself');
  assert.ok(byRule('CMDB-112').length, 'reach below 40% should fire as posture');
});

test('CMDB-109 DEFERS to the layer-absent verdict instead of contradicting the group', () => {
  /*
   * It used to evaluate the base class and report reachability defects inside a
   * service model that CMDB-110/112/113/114 had just said does not exist.
   */
  const { byRule, charged, headline, reason } = run({
    cmdb_ci: [ci('lonely_svc', 'cmdb_ci_service'), ci('linked_svc', 'cmdb_ci_service'), ci('a')],
    cmdb_ci_service: [svc('lonely_svc'), svc('linked_svc')],
    cmdb_rel_ci: [edge('r1', 'linked_svc', 'a')],
  });
  assert.equal(charged('CMDB-109').length, 0, 'no reachability defect may be charged inside an absent layer');
  const f = headline('CMDB-109');
  assert.ok(f, 'the structural fact must still be reported');
  assert.match(f.description, /modelled on the base cmdb_ci_service class rather than on a CSDM service class/);
  assert.match(f.description, /Reachability was NOT evaluated/);
  assert.match(f.description, /would contradict what the rest of this group found/);
  assert.match(f.unscored_reason, /structural/);
  assert.match(reason('CMDB-109'), /below the 1-CI floor for the layer to count as in use/);
  assert.equal(byRule('CMDB-109').length, 1, 'exactly one structural finding, not one per service');
});

test('CMDB-109 measures reachability once the CSDM layer IS in use', () => {
  const { charged } = run({
    cmdb_ci: [ci('lonely_svc', 'cmdb_ci_service_business'), ci('linked_svc', 'cmdb_ci_service_business'), ci('a')],
    cmdb_ci_service: [svc('lonely_svc', 'cmdb_ci_service_business'), svc('linked_svc', 'cmdb_ci_service_business')],
    cmdb_rel_ci: [edge('r1', 'linked_svc', 'a')],
  });
  assert.deepEqual(charged('CMDB-109').map((x) => x.target_ids[0]), ['lonely_svc']);
});

test('every layer-absent verdict self-discloses the class list it measured against', () => {
  const { reason, headline } = run({
    cmdb_ci: [ci('svc1', 'cmdb_ci_service'), ci('a')],
    cmdb_ci_service: [svc('svc1')],
  });
  for (const id of ['CMDB-110', 'CMDB-112']) {
    assert.match(reason(id), /Measured against cmdb_ci_/, id);
    assert.match(reason(id), /name them and re-run before acting/, id);
  }
  assert.match(headline('CMDB-109').description, /likeliest thing to be wrong/);
});

/* ════════════ one mechanism is a choice, not a disagreement ════════════ */

test('CMDB-113 and CMDB-114 refuse when svc_ci_assoc is empty — every edge would read as a disagreement', () => {
  const { byRule, reason } = run({
    cmdb_ci: [ci('svc1', 'cmdb_ci_service'), ci('a'), ci('b')],
    cmdb_ci_service: [svc('svc1')],
    cmdb_rel_ci: [edge('r1', 'svc1', 'a'), edge('r2', 'svc1', 'b')],
    svc_ci_assoc: [],
  });
  assert.equal(byRule('CMDB-113').length, 0);
  assert.equal(byRule('CMDB-114').length, 0);
  assert.match(reason('CMDB-114'), /links CIs to services through cmdb_rel_ci ALONE/);
  assert.match(reason('CMDB-114'), /Using one mechanism consistently is a choice, not a defect/);
});

test('CMDB-114 reports BOTH directions of the difference when both mechanisms are in use', () => {
  const { byRule } = run({
    cmdb_ci: [ci('svc1', 'cmdb_ci_service'), ci('a'), ci('b')],
    cmdb_ci_service: [svc('svc1')],
    cmdb_rel_ci: [edge('r1', 'svc1', 'a')],
    svc_ci_assoc: [{ sys_id: 'x1', service: 'svc1', ci: 'b' }],
  });
  const f = byRule('CMDB-114');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /1 link\(s\) exist as an association with no matching relationship/);
  assert.match(f[0].description, /1 exist as a relationship with no matching association/);
  assert.equal(f[0].false_positive_guard.evaluated, true);
});

test('CMDB-113 charges an association the graph cannot corroborate', () => {
  const { byRule } = run({
    cmdb_ci: [ci('svc1', 'cmdb_ci_service'), ci('linked'), ci('floating')],
    cmdb_ci_service: [svc('svc1')],
    cmdb_rel_ci: [edge('r1', 'svc1', 'linked')],
    svc_ci_assoc: [
      { sys_id: 'x1', service: 'svc1', ci: 'linked' },
      { sys_id: 'x2', service: 'svc1', ci: 'floating' },
    ],
  });
  assert.deepEqual(byRule('CMDB-113').map((f) => f.target_ids[0]), ['floating']);
});

/* ════════════ consequence scoping, inherited not re-decided ════════════ */

test('CMDB-115 inherits consequence scoping: scoped per record, one zero-point headline', () => {
  const laptops = Array.from({ length: 6 }, (_, i) => ci(`l${i}`, 'cmdb_ci_computer'));
  const { charged, headline, r } = run({
    cmdb_ci: [ci('svc1', 'cmdb_ci_service'), ci('app', 'cmdb_ci_appl'), ...laptops],
    cmdb_ci_service: [svc('svc1')],
    cmdb_rel_ci: [],
  });
  const band = (id) => charged('CMDB-115').find((f) => f.target_ids[0] === id);
  assert.ok(band('app'), 'an unlinked application must be reported');
  assert.equal(band('app').deduction_band_override, undefined, 'an application carries the full consequence');
  assert.equal(band('l0').deduction_band_override, 'LOW');
  const h = headline('CMDB-115');
  assert.ok(h, 'the estate-wide share must be raised once');
  assert.ok(h.unscored_reason, 'posture: it deducts nothing');
  assert.match(h.description, /sit outside the service model entirely/);
  assert.equal(r.measures.csdm_coverage.reduced_consequence, 6);
});

test('CMDB-111 treats an unset environment as silence, not as a claim', () => {
  const { byRule, reason } = run({
    cmdb_ci: [ci('svc1', 'cmdb_ci_service'), ci('a')],
    cmdb_ci_service: [svc('svc1')],
    cmdb_rel_ci: [edge('r1', 'svc1', 'a')],
  });
  assert.equal(byRule('CMDB-111').length, 0);
  assert.match(reason('CMDB-111'), /silence is not a claim of non-production/);
});

test('every Group 11 rule refuses to run when the services were not read completely', () => {
  const { r } = run({ cmdb_ci: [ci('a')] }, { coverage: full({ cmdb_ci_service: { status: 'truncated', rows_complete: false } }) });
  assert.equal(r.findings.length, 0);
  for (const id of CSDM_RULES) assert.ok(r.skipped.some((s) => s.rule === id), `${id} ran anyway`);
});
