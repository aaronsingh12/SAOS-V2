import test from 'node:test';
import assert from 'node:assert/strict';

import { CMDB_CATALOGUE, scoreCmdbQuality } from '../src/health/cmdb-quality.js';
import { EstateRules, IMPLEMENTED_CATALOGUE_RULES } from '../src/health/rules.js';
import { CONSUMPTION_RULES, CONSUMPTION_TRACKS, cmdbConsumptionRules } from '../src/health/cmdb-consumption.js';
import { trackMisroutes } from '../src/health/cmdb-csdm.js';
import { buildSignals } from '../src/health/cmdb-signals.js';

/*
 * Health Assist — Group 12 (Consumption and trust, D10), Sep 2026.
 *
 * D10 is SHARED: Group 11 already put CMDB-109/110/113/114 in it and CMDB-141
 * supplies the gating KPI. Group 12 must COMBINE with those, not replace or
 * double-count them — the first test pins that.
 *
 * The other thing guarded hard: CMDB-116 is the trust score itself, derived from
 * the composite. If it ever charged a dimension the score would be marking its
 * own homework.
 */

const NOW = new Date('2026-09-16T06:00:00Z');
const ok = { status: 'ok' };
const TABLES = ['cmdb_ci', 'cmdb_class_info', 'incident', 'change_request', 'problem'];
const full = (over = {}) => Object.fromEntries(TABLES.map((t) => [t,
  { table: t, status: 'complete', rows_complete: true, missing_fields: [], ...(over[t] || {}) }]));
const CLASSES = {
  cmdb: { super: null }, cmdb_ci: { super: 'cmdb' }, cmdb_ci_hardware: { super: 'cmdb_ci' },
  cmdb_ci_computer: { super: 'cmdb_ci_hardware' }, cmdb_ci_server: { super: 'cmdb_ci_computer' },
  cmdb_ci_appl: { super: 'cmdb_ci' }, cmdb_ci_service: { super: 'cmdb_ci' },
  u_cmdb_ci_widget: { super: 'cmdb_ci' },
  u_cmdb_qb_result_x: { super: 'sys_metadata' },
};

function run(estate, { coverage = full(), options = {}, dictionary = [], classes = CLASSES } = {}) {
  /* `dictionary` here is the custom-attribute slice the extract actually reads. */
  const fieldTables = {};
  for (const d of dictionary) (fieldTables[d.element] ||= []).push(d.name);
  const r = new EstateRules({ cmdb_ci: [], ...estate }, coverage, 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok, custom_fields: ok }, classes: { byName: classes }, customFields: dictionary, fieldTables, virtualIds: [], usedFor: {}, choices: [] } },
  });
  r.signals = buildSignals(r);
  cmdbConsumptionRules(r, options);
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
const inc = (id, over = {}) => ({ sys_id: id, number: id, active: 'true', sys_created_on: '2026-09-01 00:00:00', ...over });

/* ════════════ the shared dimension ════════════ */

test('Group 12 is built and the catalogue agrees with every declared track', () => {
  for (const id of CONSUMPTION_RULES) assert.ok(IMPLEMENTED_CATALOGUE_RULES.has(id), id);
  assert.deepEqual(trackMisroutes(CMDB_CATALOGUE, CONSUMPTION_TRACKS), []);
  /* The trust score is derived — never scored, never gating. */
  assert.equal(CMDB_CATALOGUE['CMDB-116'].systemicKind, 'derived');
  assert.equal(CONSUMPTION_TRACKS['CMDB-116'].scored, false);
  /* CMDB-141 already lived in D10 and still gates. */
  assert.equal(CMDB_CATALOGUE['CMDB-141'].dimension, 'D10');
  assert.equal(CMDB_CATALOGUE['CMDB-141'].systemicKind, 'measured_kpi');
});

test('D10 COMBINES Group 11 and Group 12 rather than either overwriting the other', () => {
  const d10Rules = Object.entries(CMDB_CATALOGUE)
    .filter(([, r]) => r.dimension === 'D10' && r.track === 'dimension')
    .map(([id]) => id).sort();
  /* Group 11's four records + Group 12's three KPIs and one record + CMDB-141. */
  for (const id of ['CMDB-109', 'CMDB-110', 'CMDB-113', 'CMDB-114']) assert.ok(d10Rules.includes(id), `${id} left D10`);
  for (const id of ['CMDB-117', 'CMDB-118', 'CMDB-121', 'CMDB-123', 'CMDB-141']) assert.ok(d10Rules.includes(id), `${id} is not in D10`);
  /* The context rules carry a dimension but must not be on the scoring track. */
  for (const id of ['CMDB-119', 'CMDB-120', 'CMDB-122']) {
    assert.equal(CMDB_CATALOGUE[id].track, 'context', `${id} would charge D10`);
  }
});

test('CMDB-116 is shown and never scored — a derived number cannot mark its own homework', () => {
  const { byRule, reason, r } = run({ cmdb_ci: [ci('a')] });
  assert.equal(byRule('CMDB-116').length, 0);
  assert.match(reason('CMDB-116'), /DERIVED from the dimension scores it would otherwise charge/);
  assert.match(reason('CMDB-116'), /mark its own homework/);
  assert.match(reason('CMDB-116'), /default-weight caveat/);
  const q = scoreCmdbQuality({ findings: r.findings, kpis: r.kpis });
  assert.equal(q.gate.blockers.some((b) => b.rule_id === 'CMDB-116'), false);
});

/* ════════════ the ITSM dependency, stated not assumed ════════════ */

test('without the ITSM tables the consumption rules say so instead of reporting clean', () => {
  const { byRule, kpi, reason } = run({ cmdb_ci: [ci('a')] }, {
    coverage: full({
      incident: { status: 'not_requested', rows_complete: false },
      change_request: { status: 'not_requested', rows_complete: false },
      problem: { status: 'not_requested', rows_complete: false },
    }),
  });
  for (const id of ['CMDB-117', 'CMDB-118', 'CMDB-121']) {
    assert.equal(byRule(id).length, 0, id);
    assert.equal(kpi(id), undefined, id);
    assert.match(reason(id), /A CMDB-only scan does not read ITSM/, id);
  }
  assert.match(reason('CMDB-121'), /worst possible answer here/);
});

test('CMDB-117 and CMDB-118 measure what the work names', () => {
  const filler = Array.from({ length: 28 }, (_, i) => inc(`F${i}`));
  const { kpi, byRule } = run({
    cmdb_ci: [ci('a')],
    incident: [
      inc('INC1', { cmdb_ci: 'a', business_service: 'svc1' }),
      inc('INC2', { cmdb_ci: 'a' }),
      ...filler,
    ],
  }, { options: { minConsumptionVolume: 4 } });
  assert.deepEqual([kpi('CMDB-117').numerator, kpi('CMDB-117').denominator], [1, 30]);
  assert.deepEqual([kpi('CMDB-118').numerator, kpi('CMDB-118').denominator], [2, 30]);
  assert.equal(byRule('CMDB-117').length, 1, '3.3% is below the 60% service threshold');
  assert.equal(byRule('CMDB-118').length, 1, '6.7% is below the 50% CI threshold');
  assert.match(byRule('CMDB-118')[0].description, /MEASURED OVER a 90-day window with a 4-incident floor/);
  assert.match(byRule('CMDB-118')[0].description, /the window is what you are reading/);
});

test('an old incident is outside the window, and an estate with no incidents is not a failure', () => {
  const stale = run({
    cmdb_ci: [ci('a')],
    incident: [inc('OLD', { cmdb_ci: 'a', sys_created_on: '2024-01-01 00:00:00' })],
  });
  assert.match(stale.reason('CMDB-117'), /No incident was raised in the last 90 days/);
  assert.match(stale.reason('CMDB-117'), /not one that fails to reference CIs/);
});

/* ════════════ consumption scoping, inherited ════════════ */

test('CMDB-121 scopes by consequence and raises one zero-point headline', () => {
  const laptops = Array.from({ length: 5 }, (_, i) => ci(`l${i}`, 'cmdb_ci_computer'));
  const { charged, headline, r } = run({
    cmdb_ci: [ci('db', 'cmdb_ci_appl'), ci('used'), ...laptops],
    incident: [inc('INC1', { cmdb_ci: 'used' })],
  });
  const band = (id) => charged('CMDB-121').find((f) => f.target_ids[0] === id);
  assert.equal(band('used'), undefined, 'a referenced CI is being consumed');
  assert.equal(band('db').deduction_band_override, undefined, 'an application carries the full charge');
  assert.equal(band('l0').deduction_band_override, 'LOW');
  const h = headline('CMDB-121');
  assert.ok(h.unscored_reason);
  assert.match(h.description, /have not been referenced by any work in 365 days/);
  assert.equal(r.measures.consumption_coverage.referenced, 1);
});

test('CMDB-121 counts references across every task table that was read', () => {
  const { charged, r } = run({
    cmdb_ci: [ci('byInc'), ci('byChg'), ci('byPrb'), ci('byNothing')],
    incident: [inc('INC1', { cmdb_ci: 'byInc' })],
    change_request: [{ sys_id: 'c1', number: 'CHG1', cmdb_ci: 'byChg', sys_created_on: '2026-09-01 00:00:00' }],
    problem: [{ sys_id: 'p1', number: 'PRB1', cmdb_ci: 'byPrb', sys_created_on: '2026-09-01 00:00:00' }],
  });
  assert.deepEqual(charged('CMDB-121').map((f) => f.target_ids[0]), ['byNothing']);
  assert.deepEqual(r.measures.consumption_coverage.tables, ['incident', 'change_request', 'problem']);
});

/* ════════════ the class model — context, never scored ════════════ */

test('CMDB-119 judges only classes that actually extend cmdb_ci', () => {
  /* The Query Builder result tables on dev424910 are `u_` but extend sys_metadata. */
  const noCustomCi = { ...CLASSES };
  delete noCustomCi.u_cmdb_ci_widget;
  const { byRule, reason } = run({ cmdb_ci: [ci('a'), ci('q', 'u_cmdb_qb_result_x')] }, { classes: noCustomCi });
  assert.equal(byRule('CMDB-119').length, 0);
  assert.match(reason('CMDB-119'), /No custom class extends cmdb_ci/);
  assert.match(reason('CMDB-119'), /are not CI classes and are out of scope/);
});

test('CMDB-119 says so when custom CI classes exist but none duplicates an OOB class', () => {
  const dictionary = [
    { name: 'u_cmdb_ci_widget', element: 'u_widget_only' },
    { name: 'cmdb_ci_server', element: 'serial_number' },
  ];
  const { byRule, reason } = run({ cmdb_ci: [ci('w', 'u_cmdb_ci_widget'), ci('s')] }, { dictionary });
  assert.equal(byRule('CMDB-119').length, 0);
  assert.match(reason('CMDB-119'), /none shares 70% or more of its attributes/);
});

test('CMDB-119 reports a custom class whose attributes duplicate an OOB one', () => {
  const dictionary = [
    ...['name', 'serial_number', 'ip_address', 'model_id'].map((element) => ({ name: 'u_cmdb_ci_widget', element })),
    ...['name', 'serial_number', 'ip_address', 'model_id'].map((element) => ({ name: 'cmdb_ci_server', element })),
  ];
  const { byRule } = run({ cmdb_ci: [ci('w', 'u_cmdb_ci_widget'), ci('s', 'cmdb_ci_server')] }, { dictionary });
  const f = byRule('CMDB-119');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /shares 100% of its attributes with the out-of-box class cmdb_ci_server/);
  assert.equal(f[0].confidence, 0.8);
});

test('CMDB-120 never marks an estate down for ServiceNow\'s own deep hierarchies', () => {
  const { byRule, reason } = run({ cmdb_ci: [ci('a')] });
  assert.equal(byRule('CMDB-120').length, 0);
  assert.match(reason('CMDB-120'), /Deep OOB hierarchies that ServiceNow itself ships are excluded by design/);
});

test('CMDB-122 shows sparse classes for context and charges nothing', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a'), ci('b', 'cmdb_ci_appl'), ...Array.from({ length: 9 }, (_, i) => ci(`s${i}`, 'cmdb_ci_computer'))],
  });
  const f = byRule('CMDB-122');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /hold between 1 and 5 CIs/);
  assert.match(f[0].description, /Shown for context/);
  assert.equal(CMDB_CATALOGUE['CMDB-122'].track, 'context');
});

test('CMDB-123 says so when the custom-attribute slice was not read', () => {
  const r = new EstateRules({ cmdb_ci: [] }, full(), 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok }, classes: { byName: CLASSES }, virtualIds: [], usedFor: {}, choices: [] } },
  });
  r.signals = buildSignals(r);
  cmdbConsumptionRules(r);
  const why = r.skipped.filter((x) => x.rule === 'CMDB-123').map((x) => x.reason).join(' ');
  assert.match(why, /reporting none would say there are none/);
});

test('CMDB-123 measures population of custom attributes on OOB classes', () => {
  const dictionary = [
    { name: 'cmdb_ci_server', element: 'u_cost_centre' },
    { name: 'cmdb_ci_server', element: 'u_filled' },
  ];
  const { kpi, byRule } = run({
    cmdb_ci: [ci('a', 'cmdb_ci_server', { u_filled: 'yes' }), ci('b', 'cmdb_ci_server', { u_filled: 'yes' })],
  }, { dictionary });
  const k = kpi('CMDB-123');
  assert.deepEqual([k.numerator, k.denominator], [1, 2]);
  assert.match(byRule('CMDB-123')[0].description, /u_cost_centre \(0%\)/);
});

test('every Group 12 rule refuses to run when the CIs were not read completely', () => {
  const { r } = run({ cmdb_ci: [ci('a')] }, { coverage: full({ cmdb_ci: { status: 'truncated', rows_complete: false } }) });
  assert.equal(r.findings.length, 0);
  for (const id of CONSUMPTION_RULES) assert.ok(r.skipped.some((s) => s.rule === id), `${id} ran anyway`);
});

test('CMDB-117 and CMDB-118 ABSTAIN below the volume floor rather than publishing a thin ratio', () => {
  /* dev424910: 19 incidents in 90 days, where one incident moves the ratio 5 points. */
  const { kpi, byRule, reason } = run({
    cmdb_ci: [ci('a')],
    incident: [...Array.from({ length: 19 }, (_, i) => inc(`I${i}`)),
      inc('OLD', { cmdb_ci: 'a', sys_created_on: '2024-01-01 00:00:00' })],
  });
  for (const id of ['CMDB-117', 'CMDB-118']) {
    assert.equal(kpi(id), undefined, `${id} published an unreliable ratio into a scored dimension`);
    assert.equal(byRule(id).length, 0, id);
    assert.match(reason(id), /NOT MEASURED — insufficient volume in the window/, id);
    assert.match(reason(id), /one incident moves the ratio by 5.3 points/, id);
    assert.match(reason(id), /Both parameters are per-estate/, id);
  }
  /* The all-time context is offered, so a reader can see the window is the cause. */
  assert.match(reason('CMDB-118'), /1 incident\(s\) reference a CI across ALL time/);
});

test('the window is a per-estate parameter and changes the answer', () => {
  const old = Array.from({ length: 30 }, (_, i) => inc(`O${i}`, { cmdb_ci: 'a', sys_created_on: '2026-01-01 00:00:00' }));
  const narrow = run({ cmdb_ci: [ci('a')], incident: old });
  assert.match(narrow.reason('CMDB-117'), /No incident was raised in the last 90 days/);

  const wide = run({ cmdb_ci: [ci('a')], incident: old }, { options: { consumptionWindowDays: 365 } });
  assert.equal(wide.kpi('CMDB-118').denominator, 30, 'a wider window sees the same estate differently');
  assert.equal(wide.kpi('CMDB-118').pass_pct, 100);
});
