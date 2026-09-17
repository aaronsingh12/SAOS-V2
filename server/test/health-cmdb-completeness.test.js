import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreCmdbQuality, CMDB_CATALOGUE } from '../src/health/cmdb-quality.js';
import { EstateRules } from '../src/health/rules.js';
import { buildSignals, modifiersFor } from '../src/health/cmdb-signals.js';
import { isPlaceholder } from '../src/health/cmdb-completeness.js';

/*
 * Health Assist — Group 2 (Completeness), CMDB-140 (DQ-003), CMDB-141 (DQ-077),
 * and the scoring decisions of 16 Sep 2026:
 *
 *   1. Rules are routed by track: governance, platform, trend and CSDM maturity
 *      never move the data-quality composite.
 *   2. Percentage rules score at the level they measure — a dimension KPI
 *      sub-score, blended 70/30 with the record average — never per record.
 *      Structural-context rules are shown, not scored.
 *   3. Two provisional states, never merged.
 *   4. Escalated-to-Systemic findings are listed with their chain, not as blockers.
 *   5. CMDB-139 stays Critical, escalates on Business Critical support, and puts a
 *      caveat on principal-weighted dimensions.
 */

const f = (rule_id, severity, target_ids, extra = {}) => ({ rule_id, severity, target_ids, fingerprint: `${rule_id}:${target_ids.join(',')}`, title: rule_id, ...extra });

/* ════════════════════════ scoring decisions ════════════════════════ */

test("a percentage rule is a dimension KPI, blended by the dimension TYPE", () => {
  /*
   * D1 is a RECORD-type dimension (the defect is a property of a record and
   * counting records is the measurement), so it keeps the 70/30 ratio. An
   * ESTATE-type dimension weights its KPI half heaviest — see the blend tests in
   * health-cmdb-quality.test.js for why D10 could not keep one global ratio.
   */
  const q = scoreCmdbQuality({
    findings: [f('CMDB-012', 'CRITICAL', ['a'])],                    // D1 record: a 60, b 100 → 80
    kpis: [{ rule_id: 'CMDB-021', pass_pct: 50, numerator: 1, denominator: 2, basis: 't' }],   // D1 KPI
    inScope: { ids: ['a', 'b'], basis: 't' },
    implemented: new Set(['CMDB-012', 'CMDB-021']),
  });
  const d1 = q.dimensions.find((d) => d.key === 'D1');
  assert.equal(d1.record_part, 80);
  assert.equal(d1.kpi_part, 50);
  assert.equal(d1.score, 71);
  assert.deepEqual(d1.blend, { record: 0.7, kpi: 0.3, kind: 'record' });
});

test('with only a KPI measured, the KPI IS the dimension score; the KPI never deducts per record', () => {
  const q = scoreCmdbQuality({
    findings: [f('CMDB-141', 'SYSTEMIC', ['c1', 'c2'])],
    kpis: [{ rule_id: 'CMDB-141', pass_pct: 25, numerator: 1, denominator: 4, basis: 't' }],
    inScope: { ids: ['c1', 'c2', 'x'], basis: 't' },
    implemented: new Set(['CMDB-141']),
  });
  const d10 = q.dimensions.find((d) => d.key === 'D10');
  assert.equal(d10.score, 25);
  assert.equal(d10.record_part, null);
  assert.equal(q.density.defects_per_100_records, 0, 'a percentage rule deducted from records');
});

test('a base-Systemic percentage rule both SCORES (its measurement) and GATES (its breach) — named as the headline', () => {
  const q = scoreCmdbQuality({
    findings: [f('CMDB-141', 'SYSTEMIC', ['c1'])],
    kpis: [{ rule_id: 'CMDB-141', pass_pct: 0, numerator: 0, denominator: 77, basis: 't' }],
    inScope: { ids: ['a'], basis: 't' },
    implemented: new Set(['CMDB-141']),
  });
  assert.equal(q.gate.trustworthy, false);
  assert.equal(q.gate.blockers[0].rule_id, 'CMDB-141');
  assert.equal(q.gate.blockers[0].headline, true);
  assert.equal(q.gate.headline.denominator, 77);
  assert.equal(q.dimensions.find((d) => d.key === 'D10').score, 0);
});

test('structural-context rules are shown, never scored', () => {
  assert.equal(CMDB_CATALOGUE['CMDB-122'].track, 'context');
  const q = scoreCmdbQuality({
    findings: [f('CMDB-122', 'MEDIUM', ['a'])],
    inScope: { ids: ['a'], basis: 't' },
    implemented: new Set(['CMDB-122', 'CMDB-121']),
  });
  assert.equal(q.dimensions.find((d) => d.key === 'D10').score, 100);
  assert.equal(q.tracks.context, 1);
});

test('governance, platform, trend and CSDM-maturity findings never move the composite', () => {
  for (const [rule, track] of [['CMDB-095', 'governance'], ['CMDB-126', 'platform'], ['CMDB-134', 'trend'], ['CMDB-115', 'csdm-maturity']]) {
    assert.equal(CMDB_CATALOGUE[rule].track, track, `${rule} is not routed to ${track}`);
    const q = scoreCmdbQuality({
      findings: [f('CMDB-012', 'LOW', ['a']), f(rule, 'CRITICAL', ['a'])],
      inScope: { ids: ['a'], basis: 't' },
      implemented: new Set(['CMDB-012', rule]),
    });
    assert.equal(q.composite.score, 99, `${track} finding moved the data-quality composite`);
    assert.equal(q.tracks[track], 1);
  }
});

test('Group 11 consumption-blocking rules feed D10; the rest wait for a CSDM maturity score', () => {
  for (const id of ['CMDB-109', 'CMDB-110', 'CMDB-113', 'CMDB-114']) assert.equal(CMDB_CATALOGUE[id].dimension, 'D10', id);
  for (const id of ['CMDB-111', 'CMDB-112', 'CMDB-115']) assert.equal(CMDB_CATALOGUE[id].track, 'csdm-maturity', id);
});

test('two provisional states are separate: gate says "not trustworthy", coverage says how much weight is measured', () => {
  const gateOnly = scoreCmdbQuality({
    findings: [f('CMDB-001', 'SYSTEMIC', [])], inScope: { ids: ['a'], basis: 't' },
    implemented: new Set(Object.values(CMDB_CATALOGUE).map((r) => r.id)),
  });
  assert.equal(gateOnly.gate.label, 'Score not trustworthy');
  const coverageOnly = scoreCmdbQuality({ findings: [], inScope: { ids: ['a'], basis: 't' }, implemented: new Set(['CMDB-012']) });
  assert.equal(coverageOnly.gate.trustworthy, true);
  assert.equal(coverageOnly.composite.coverage_label, 'Provisional — 12 of 100 weight measured');
});

test('an escalated finding carries its chain: base band → Systemic, with the modifier reasons in words', () => {
  const q = scoreCmdbQuality({
    findings: [f('CMDB-013', 'SYSTEMIC', ['a'], { modifiers: { escalators: ['shared_infrastructure'], de_escalators: [] } })],
    inScope: { ids: ['a'], basis: 't' },
    implemented: new Set(['CMDB-013']),
  });
  assert.deepEqual(q.escalated[0].chain.base, 'CRITICAL');
  assert.equal(q.escalated[0].chain.escalators[0].label, 'Shared infrastructure (network core, auth, shared DB)');
});

test('while CMDB-139 fires, a dimension with built principal-scoped rules carries a coverage caveat', () => {
  const q = scoreCmdbQuality({
    findings: [f('CMDB-139', 'CRITICAL', [])], inScope: { ids: ['a'], basis: 't' },
    implemented: new Set(['CMDB-014', 'CMDB-012', 'CMDB-035']),
  });
  assert.match(q.dimensions.find((d) => d.key === 'D1').caveats[0], /CMDB-139/);
  assert.deepEqual(q.dimensions.find((d) => d.key === 'D3').caveats, [], 'a dimension with no principal-scoped rule got the caveat');
});

/* ════════════════════════ fixtures ════════════════════════ */

const NOW = new Date('2026-09-16T06:00:00Z');
const ok = { status: 'ok' };
const TABLES = ['cmdb_ci', 'cmdb_rel_ci', 'cmdb_ci_service', 'svc_ci_assoc', 'cmdb_class_info', 'cmdb_recommended_fields', 'cmn_location',
  'core_company', 'cmdb_identifier', 'cmdb_identifier_entry', 'life_cycle_stage_status', 'change_request', 'cmdb_health_config'];
const full = () => Object.fromEntries(TABLES.map((t) => [t, { table: t, status: 'complete', rows_complete: true, missing_fields: [] }]));
const CLASSES = {
  cmdb_ci: { super: null }, cmdb_ci_hardware: { super: 'cmdb_ci' }, cmdb_ci_computer: { super: 'cmdb_ci_hardware' },
  cmdb_ci_server: { super: 'cmdb_ci_computer' }, cmdb_ci_netgear: { super: 'cmdb_ci_hardware' }, cmdb_ci_spkg: { super: 'cmdb_ci' },
  cmdb_ci_service: { super: 'cmdb_ci' },
};

function run(estate, meta = {}, { coverage = full(), accepted = [] } = {}) {
  const r = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [], ...estate }, coverage, 90, NOW, {
    acceptedFingerprints: accepted,
    meta: {
      cmdb: {
        reads: Object.fromEntries(['health_result', 'class_hierarchy', 'mandatory_fields', 'config_matches', 'job_triggers', 'policy_executions',
          'pref_audit', 'virtual', 'used_for', 'field_tables', 'class_attrs', 'identity_lookups', 'choice_audit', 'change_impact'].map((k) => [k, ok])),
        classes: { byName: CLASSES }, mandatory: {}, virtualIds: [], usedFor: {}, usedForClasses: [], fieldTables: {}, classAttrs: {}, lookups: {},
        choiceAudit: { audited: false, defaults: {}, changed: {} }, changeImpact: { withImpact: [] }, healthResult: { count: 0 },
        ...meta,
      },
    },
  });
  const all = r.analyze();
  return { r, byRule: (id) => all.filter((x) => x.rule_id === id), skipped: (id) => r.skipped.filter((s) => s.rule === id) };
}
const ci = (id, cls, fields = {}) => ({ sys_id: id, name: id, sys_class_name: cls, serial_number: 'SN1', fqdn: '', ip_address: '10.0.0.1', mac_address: '', company: '', location: '', cost_center: '', ...fields });

/* ════════════════════════ signals ════════════════════════ */

test('Business Critical support follows relationships DOWNWARD from a "1 - most critical" service', () => {
  const r = new EstateRules({
    cmdb_ci_service: [{ sys_id: 'svc', name: 'SAP', busines_criticality: '1 - most critical' }],
    cmdb_rel_ci: [{ sys_id: 'r1', parent: 'svc', child: 'app' }, { sys_id: 'r2', parent: 'app', child: 'srv' }, { sys_id: 'r3', parent: 'other', child: 'svc' }],
  }, full(), 90, NOW, { meta: { cmdb: { reads: { class_hierarchy: ok }, classes: { byName: CLASSES } } } });
  const s = buildSignals(r);
  assert.ok(s.bcSupported.has('app') && s.bcSupported.has('srv'));
  assert.ok(!s.bcSupported.has('other'), 'support was traced upward to the thing that uses the service');
});

test('modifiers: EXPLICIT production and shared infrastructure escalate; non-production de-escalates; unknowns are listed, not assumed', () => {
  const r = new EstateRules({}, full(), 90, NOW, { meta: { cmdb: {
    reads: { class_hierarchy: ok, used_for: ok }, classes: { byName: CLASSES },
    usedFor: { p: 'Production', d: 'Development', audited: 'Production' },
    usedForDefaults: { cmdb_ci_server: 'Production' }, usedForSetIds: ['audited'],
  } } });
  const s = buildSignals(r);
  /* Decision 5 of 17 Sep: the OOB default is not evidence of production. */
  assert.deepEqual(modifiersFor([{ sys_id: 'p', sys_class_name: 'cmdb_ci_server' }], s).escalators, [], 'the bare default escalated');
  assert.deepEqual(modifiersFor([{ sys_id: 'audited', sys_class_name: 'cmdb_ci_server' }], s).escalators, ['production'], 'an audited explicit set did not escalate');
  assert.deepEqual(modifiersFor([{ sys_id: 'd', sys_class_name: 'cmdb_ci_server' }], s).deEscalators, ['non_production']);
  const net = modifiersFor([{ sys_id: 'n', sys_class_name: 'cmdb_ci_netgear' }], s);
  assert.ok(net.escalators.includes('shared_infrastructure'));
  assert.ok(net.notEvaluated.includes('production'), 'a class without used_for was treated as production or non-production');
  assert.ok(net.notEvaluated.includes('class_defect_rate'), 'materiality was applied with no threshold configured');
});

test('an accepted-risk finding is de-escalated on the SAME fingerprint', () => {
  const first = run({ cmdb_ci: [ci('h1', 'cmdb_ci_computer', { serial_number: '' })] });
  const [x] = first.byRule('CMDB-012');
  const again = run({ cmdb_ci: [ci('h1', 'cmdb_ci_computer', { serial_number: '' })] }, {}, { accepted: [x.fingerprint] });
  const [y] = again.byRule('CMDB-012');
  assert.equal(y.fingerprint, x.fingerprint);
  assert.ok(y.modifiers.de_escalators.includes('approved_exception'));
  /* One CI in its class is also below the materiality floor: Critical − 2 = Moderate. */
  assert.deepEqual(y.modifiers.de_escalators.sort(), ['approved_exception', 'below_materiality']);
  assert.equal(y.severity, 'MEDIUM');
  assert.equal(x.severity, 'HIGH', 'without the exception, only the materiality floor applies');
});

/* ════════════════════════ Group 2 rules ════════════════════════ */

test('isPlaceholder recognises the catalogue set, trimmed and case-insensitive, and nothing else', () => {
  for (const v of ['Unknown', ' n/a ', 'TBD', '-', '0.0.0.0', '00:00:00:00:00:00', 'To be filled by O.E.M.']) assert.ok(isPlaceholder(v), v);
  for (const v of ['', 'SN-123', 'unknownhost01']) assert.equal(isPlaceholder(v), false, v);
});

test('CMDB-012 fires on empty and placeholder serials on physical hardware; excludes virtual machines and non-hardware', () => {
  const { byRule } = run({ cmdb_ci: [
    ci('empty', 'cmdb_ci_computer', { serial_number: '' }),
    ci('placeholder', 'cmdb_ci_server', { serial_number: 'Unknown' }),
    ci('vm', 'cmdb_ci_computer', { serial_number: '' }),
    ci('pkg', 'cmdb_ci_spkg', { serial_number: '' }),
    ci('good', 'cmdb_ci_computer'),
  ] }, { virtualIds: ['vm'] });
  const ids = byRule('CMDB-012').map((x) => x.target_ids[0]).sort();
  assert.deepEqual(ids, ['empty', 'placeholder']);
  assert.equal(byRule('CMDB-012').find((x) => x.target_ids[0] === 'placeholder').confidence, 0.95);
  assert.equal(byRule('CMDB-012')[0].dimension, 'D1');
});

test('CMDB-013 fires only when FQDN, IP and MAC are ALL missing, and only on network-addressable classes', () => {
  const { byRule } = run({ cmdb_ci: [
    ci('none', 'cmdb_ci_netgear', { fqdn: '', ip_address: '0.0.0.0', mac_address: '' }),
    ci('ip', 'cmdb_ci_netgear', { fqdn: '', ip_address: '10.1.1.1', mac_address: '' }),
    ci('svc', 'cmdb_ci_service', { fqdn: '', ip_address: '', mac_address: '' }),
  ] });
  assert.deepEqual(byRule('CMDB-013').map((x) => x.target_ids[0]), ['none']);
  assert.ok(byRule('CMDB-013')[0].modifiers.escalators.includes('shared_infrastructure'), 'a network device was not escalated as shared infrastructure');
  /* +1 shared infrastructure, −1 below the materiality floor (1 of 2 netgear) → Critical. */
  assert.ok(byRule('CMDB-013')[0].modifiers.de_escalators.includes('below_materiality'));
  assert.equal(byRule('CMDB-013')[0].severity, 'CRITICAL');
});

test('CMDB-014/017/019 skip when no class defines required attributes, and fire when one does', () => {
  const none = run({ cmdb_ci: [ci('a', 'cmdb_ci_computer')] });
  for (const id of ['CMDB-014', 'CMDB-017', 'CMDB-019']) assert.match(none.skipped(id)[0].reason, /CMDB-006/, id);

  const estate = { cmdb_ci: [ci('a', 'cmdb_ci_computer'), ci('b', 'cmdb_ci_computer')], cmdb_recommended_fields: [{ sys_id: 'r', table: 'cmdb_ci_hardware', recommended: 'asset_tag', active: 'true' }] };
  const meta = {
    mandatory: { cmdb_ci_computer: ['os'] },
    classAttrs: { cmdb_ci_computer: { applicable: ['os', 'asset_tag'], returned: ['os', 'asset_tag'], values: { a: { os: '', asset_tag: 'TBD' }, b: { os: 'Linux', asset_tag: 'A1' } } } },
  };
  const some = run(estate, meta);
  assert.deepEqual(some.byRule('CMDB-014').map((x) => x.target_ids[0]), ['a']);
  assert.deepEqual(some.byRule('CMDB-019').map((x) => x.target_ids[0]), ['a']);
  assert.deepEqual(some.byRule('CMDB-017').map((x) => x.target_ids[0]), ['a']);
  assert.match(some.byRule('CMDB-014')[0].description, /no principal classes are designated/);
});

test('CMDB-015 fires on a service in the dependency map with no business criticality', () => {
  const { byRule } = run({
    cmdb_ci_service: [{ sys_id: 's1', name: 'Payroll', busines_criticality: '' }, { sys_id: 's2', name: 'Orphan', busines_criticality: '' }],
    cmdb_rel_ci: [{ sys_id: 'r', parent: 's1', child: 'x' }],
  });
  assert.deepEqual(byRule('CMDB-015').map((x) => x.target_ids[0]), ['s1']);
});

test('CMDB-016 fires only where the class defines used_for and it is empty', () => {
  const { byRule } = run({ cmdb_ci: [ci('s1', 'cmdb_ci_server'), ci('s2', 'cmdb_ci_server')] }, { usedFor: { s1: '', s2: 'Production' }, usedForClasses: ['cmdb_ci_server'] });
  assert.deepEqual(byRule('CMDB-016').map((x) => x.target_ids[0]), ['s1']);
});

test('CMDB-018 needs two companies IN USE, not two company records', () => {
  const records = [{ sys_id: 'c1', name: 'A' }, { sys_id: 'c2', name: 'B' }, { sys_id: 'c3', name: 'Legacy' }];
  const single = run({ core_company: records, cmdb_ci: [ci('a', 'cmdb_ci_computer', { company: 'c1' }), ci('b', 'cmdb_ci_computer')] });
  assert.equal(single.byRule('CMDB-018').length, 0);
  assert.match(single.skipped('CMDB-018')[0].reason, /not a multi-company estate/);
  const multi = run({ core_company: records, cmdb_ci: [ci('a', 'cmdb_ci_computer', { company: 'c1' }), ci('b', 'cmdb_ci_computer', { company: 'c2' }), ci('c', 'cmdb_ci_computer')] });
  assert.deepEqual(multi.byRule('CMDB-018').map((x) => x.target_ids[0]), ['c']);
});

test('CMDB-020: empty or catch-all location on PHYSICAL classes only — software never fires', () => {
  const { byRule } = run({
    cmn_location: [{ sys_id: 'country', name: 'India', parent: '' }, { sys_id: 'city', name: 'Mumbai', parent: 'country' }, { sys_id: 'site', name: 'DC1', parent: 'city' }],
    cmdb_ci: [
      ci('empty', 'cmdb_ci_computer'),
      ci('catchall', 'cmdb_ci_computer', { location: 'country' }),
      ci('specific', 'cmdb_ci_computer', { location: 'site' }),
      ci('software', 'cmdb_ci_spkg'),
    ],
  });
  const got = byRule('CMDB-020').map((x) => x.target_ids[0]).sort();
  assert.deepEqual(got, ['catchall', 'empty']);
  assert.equal(byRule('CMDB-020').find((x) => x.target_ids[0] === 'catchall').confidence, 0.85);
});

test('CMDB-021 skips when the CMDB is not audited, and otherwise measures a KPI instead of raising per record', () => {
  const unaudited = run({ cmdb_ci: [ci('a', 'cmdb_ci_computer', { install_status: '1', operational_status: '1' })] });
  assert.match(unaudited.skipped('CMDB-021')[0].reason, /not audited/);

  const cis = Array.from({ length: 5 }, (_, i) => ci(`c${i}`, 'cmdb_ci_computer', { install_status: '1', operational_status: '1' }));
  const audited = run({ cmdb_ci: cis }, { choiceAudit: { audited: true, defaults: { install_status: '1', operational_status: '1' }, changed: { install_status: ['c0'], operational_status: [] } } });
  const kpi = audited.r.kpis.find((k) => k.rule_id === 'CMDB-021');
  assert.equal(kpi.denominator, 10);
  assert.equal(kpi.numerator, 1);
  assert.equal(audited.byRule('CMDB-021').length, 1);
  assert.deepEqual(audited.byRule('CMDB-021')[0].target_ids, [], 'CMDB-021 raised per record');
});

test('CMDB-022 skips when no CI in scope carries a cost centre, and fires on the gaps when some do', () => {
  const none = run({ cmdb_ci: [ci('a', 'cmdb_ci_computer'), ci('b', 'cmdb_ci_computer')] });
  assert.match(none.skipped('CMDB-022')[0].reason, /may not allocate cost/);
  const some = run({ cmdb_ci: [ci('a', 'cmdb_ci_computer', { cost_center: 'cc1' }), ci('b', 'cmdb_ci_computer')] });
  assert.deepEqual(some.byRule('CMDB-022').map((x) => x.target_ids[0]), ['b']);
});

test('CMDB-140: a CI with no satisfiable strong entry fires; a lookup row, a populated serial or an unreadable field prevents it', () => {
  const identifiers = [{ sys_id: 'hw', name: 'Hardware Rule', applies_to: 'cmdb_ci_hardware', active: 'true' }];
  const entries = [
    { sys_id: 'e1', identifier: 'hw', table: 'cmdb_ci_hardware', attributes: 'serial_number', active: 'true', allow_null_attribute: 'false' },
    { sys_id: 'e2', identifier: 'hw', table: 'cmdb_serial_number', attributes: 'serial_number', active: 'true', allow_null_attribute: 'false' },
    { sys_id: 'e3', identifier: 'hw', table: 'cmdb_ci_hardware', attributes: 'product_instance_id', active: 'true', allow_null_attribute: 'false' },
    { sys_id: 'e4', identifier: 'hw', table: 'cmdb_ci_hardware', attributes: 'name', active: 'true', allow_null_attribute: 'false' },
  ];
  const estate = {
    cmdb_identifier: identifiers, cmdb_identifier_entry: entries,
    cmdb_ci: [ci('bare', 'cmdb_ci_computer', { serial_number: '' }), ci('viaLookup', 'cmdb_ci_computer', { serial_number: '' }), ci('serial', 'cmdb_ci_computer')],
  };
  const meta = {
    fieldTables: { serial_number: ['cmdb_ci'], name: ['cmdb_ci'] },       // product_instance_id is not a field of these classes
    lookups: { cmdb_serial_number: { status: 'ok', byCi: { viaLookup: [{ cmdb_ci: 'viaLookup', serial_number: 'X9' }] } } },
  };
  const { byRule } = run(estate, meta);
  assert.deepEqual(byRule('CMDB-140').map((x) => x.target_ids[0]), ['bare']);
  assert.match(byRule('CMDB-140')[0].description, /only by name/);

  const unreadable = run(estate, { ...meta, lookups: { cmdb_serial_number: { status: 'too_large' } } });
  assert.equal(unreadable.byRule('CMDB-140').length, 0, 'a CI was flagged although a lookup it might satisfy could not be read');
});

test('CMDB-141: the KPI counts only SERVICE-BOUND changes, and gates below threshold', () => {
  const changes = [{ sys_id: 'ch1', number: 'CHG1', cmdb_ci: 'x' }, { sys_id: 'ch2', number: 'CHG2', cmdb_ci: 'y' },
    { sys_id: 'ch3', number: 'CHG3', cmdb_ci: '' }, { sys_id: 'ch4', number: 'CHG4', cmdb_ci: 'standalone' }];
  const serviceMap = {
    cmdb_ci_service: [{ sys_id: 'svc', name: 'Payroll', busines_criticality: '' }],
    cmdb_rel_ci: [{ sys_id: 'r1', parent: 'svc', child: 'x' }, { sys_id: 'r2', parent: 'svc', child: 'y' }],
  };
  const low = run({ ...serviceMap, change_request: changes }, { changeImpact: { withImpact: ['ch1'] } });
  const kpi = low.r.kpis.find((k) => k.rule_id === 'CMDB-141');
  assert.deepEqual([kpi.numerator, kpi.denominator], [1, 2]);
  assert.equal(low.byRule('CMDB-141').length, 1);
  assert.equal(low.byRule('CMDB-141')[0].gate, true);
  assert.match(low.byRule('CMDB-141')[0].description, /Event Management is not active/);
  assert.match(low.r.kpis.find((k) => k.rule_id === 'CMDB-141').basis, /1 change\(s\) naming a standalone CI not counted/);
  const high = run({ ...serviceMap, change_request: changes }, { changeImpact: { withImpact: ['ch1', 'ch2'] } });
  assert.equal(high.byRule('CMDB-141').length, 0);
  assert.equal(high.r.kpis.find((k) => k.rule_id === 'CMDB-141').pass_pct, 100);
});

test('CMDB-139 stays Critical without Business Critical support, and escalates to Systemic — without gating — with it', () => {
  const base = { cmdb_class_info: [{ sys_id: 'i', class: 'cmdb_ci_computer', principal_class: 'false' }], cmdb_ci: [ci('srv', 'cmdb_ci_computer')] };
  const plain = run({ ...base, cmdb_ci_service: [] });
  assert.equal(plain.byRule('CMDB-139')[0].severity, 'CRITICAL');
  const bc = run({ ...base, cmdb_ci_service: [{ sys_id: 'svc', busines_criticality: '1 - most critical' }], cmdb_rel_ci: [{ sys_id: 'r', parent: 'svc', child: 'srv' }] });
  const [x] = bc.byRule('CMDB-139');
  assert.equal(x.severity, 'SYSTEMIC');
  assert.equal(x.base_severity, 'CRITICAL');
  assert.equal(x.gate, false);
  assert.equal(x.escalated_to_systemic, true);
});
