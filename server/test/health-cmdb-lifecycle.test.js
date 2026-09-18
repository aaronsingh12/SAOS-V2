import test from 'node:test';
import assert from 'node:assert/strict';

import { CMDB_CATALOGUE } from '../src/health/cmdb-quality.js';
import { EstateRules, IMPLEMENTED_CATALOGUE_RULES } from '../src/health/rules.js';
import { LIFECYCLE_RULES, cmdbLifecycleRules, stageOfLabel } from '../src/health/cmdb-lifecycle.js';
import { buildSignals, intentOf } from '../src/health/cmdb-signals.js';

/*
 * Health Assist — Group 8 (Lifecycle and retirement, D8), Sep 2026.
 *
 * D8 runs the other way round from D1–D7. Every rule here is a CONTRADICTION
 * rule over the full estate, because the records it judges are exactly the ones
 * the quality dimensions exclude. The two things this file guards hardest:
 *
 *   1. the intent tag, because a `quality` tag on "Retired CI still holding
 *      active relationships" makes it a rule that can never match; and
 *   2. the state vocabulary, because cmdb_ci and alm_asset both call the column
 *      `install_status` and do NOT share values.
 */

const NOW = new Date('2026-09-16T06:00:00Z');
const ok = { status: 'ok' };
const TABLES = ['cmdb_ci', 'cmdb_rel_ci', 'svc_ci_assoc', 'cmdb_ci_service', 'cmdb_class_info', 'alm_asset', 'incident', 'change_request', 'problem'];
const full = (over = {}) => Object.fromEntries(TABLES.map((t) => [t,
  { table: t, status: 'complete', rows_complete: true, missing_fields: [], ...(over[t] || {}) }]));
const CLASSES = {
  cmdb: { super: null }, cmdb_ci: { super: 'cmdb' }, cmdb_ci_hardware: { super: 'cmdb_ci' },
  cmdb_ci_computer: { super: 'cmdb_ci_hardware' }, cmdb_ci_server: { super: 'cmdb_ci_computer' },
  cmdb_ci_service: { super: 'cmdb_ci' },
};

/* The two real choice lists from dev424910 — they collide, which is the point. */
const CI_CHOICES = [['1', 'Installed'], ['2', 'On Order'], ['3', 'In Maintenance'], ['4', 'Pending Install'],
  ['5', 'Pending Repair'], ['6', 'In Stock'], ['7', 'Retired'], ['8', 'Stolen'], ['100', 'Absent']]
  .map(([value, label]) => ({ name: 'cmdb_ci', element: 'install_status', value, label }));
const ASSET_CHOICES = [['1', 'In use'], ['2', 'On order'], ['3', 'In maintenance'], ['6', 'In stock'],
  ['7', 'Retired'], ['8', 'Missing'], ['9', 'In transit'], ['10', 'Consumed'], ['11', 'Build']]
  .map(([value, label]) => ({ name: 'alm_asset', element: 'install_status', value, label }));
const CHOICES = [...CI_CHOICES, ...ASSET_CHOICES];

function run(estate, { coverage = full(), options = {}, choices = CHOICES, measures = {} } = {}) {
  const r = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [], ...estate }, coverage, 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok, used_for: ok, virtual: ok }, classes: { byName: CLASSES }, virtualIds: [], usedFor: {}, choices } },
  });
  r.signals = buildSignals(r);
  r.measures = { ...measures };
  cmdbLifecycleRules(r, options);
  return {
    r,
    byRule: (id) => r.findings.filter((x) => x.rule_id === id && !x.pattern),
    reason: (id) => r.skipped.filter((s) => s.rule === id).map((s) => s.reason).join(' | '),
  };
}

const ci = (id, over = {}) => ({
  sys_id: id, name: id, sys_class_name: 'cmdb_ci_server', install_status: '1', operational_status: '1',
  sys_created_on: '2015-01-01 00:00:00', sys_updated_on: '2026-09-01 00:00:00', sys_mod_count: '4', ...over,
});
const edge = (sys_id, parent, child) => ({ sys_id, parent, child, type: 'depends', 'type.name': 'Depends on::Used by' });

/* ════════════════════════ the catalogue ════════════════════════ */

test('Group 8 is built, scores in D8, and EVERY rule is a contradiction rule', () => {
  for (const id of LIFECYCLE_RULES) {
    assert.ok(IMPLEMENTED_CATALOGUE_RULES.has(id), id);
    assert.equal(CMDB_CATALOGUE[id].dimension, 'D8', id);
    /* A `quality` tag here would filter out the very CIs the rule exists for. */
    assert.equal(intentOf(id), 'contradiction', `${id} must judge the full estate, dead statuses included`);
  }
});

test('lifecycle stages are read from labels, because the two tables do not share values', () => {
  assert.equal(stageOfLabel('Retired'), 'dead');
  assert.equal(stageOfLabel('Consumed'), 'dead');       // asset 10
  assert.equal(stageOfLabel('Absent'), 'dead');         // CI 100
  assert.equal(stageOfLabel('Missing'), 'dead');        // asset 8
  assert.equal(stageOfLabel('Installed'), 'live');
  assert.equal(stageOfLabel('In use'), 'live');
  assert.equal(stageOfLabel('In Stock'), 'transitional');
  assert.equal(stageOfLabel('In Maintenance'), 'maintenance');
  assert.equal(stageOfLabel('Something Custom'), null);
});

/* ════════════════ the rules that judge a dead CI ════════════════ */

test('CMDB-080 charges a retired CI that still holds relationships — which a quality tag would have hidden', () => {
  const { byRule } = run({
    cmdb_ci: [ci('dead', { install_status: '7' }), ci('live')],
    cmdb_rel_ci: [edge('r1', 'dead', 'live')],
  });
  const f = byRule('CMDB-080');
  assert.deepEqual(f.map((x) => x.target_ids[0]), ['dead']);
  assert.match(f[0].description, /still holds 1 relationship/);
});

test('CMDB-081 finds a retired CI still on a service map', () => {
  const { byRule } = run({
    cmdb_ci: [ci('dead', { install_status: '7' }), ci('svc', { sys_class_name: 'cmdb_ci_service' })],
    cmdb_ci_service: [{ sys_id: 'svc', name: 'Payroll' }],
    svc_ci_assoc: [{ sys_id: 'a1', service: 'svc', ci: 'dead' }],
  });
  assert.equal(byRule('CMDB-081').length, 1);
  assert.match(byRule('CMDB-081')[0].description, /Payroll/);
});

test('CMDB-087 charges a CI that is both dead and operational', () => {
  const { byRule } = run({
    cmdb_ci: [ci('stolen', { install_status: '8', operational_status: '1' }), ci('fine', { install_status: '7', operational_status: '2' })],
  });
  assert.deepEqual(byRule('CMDB-087').map((f) => f.target_ids[0]), ['stolen']);
});

test('CMDB-087 CONSUMES the D7 measure and never recomputes it', () => {
  const measures = {
    retired_still_discovered: { count: 1, within_days: 30, cis: [{ sys_id: 'stolen', last_discovered: '2026-09-10 00:00:00' }] },
  };
  const withMeasure = run({ cmdb_ci: [ci('stolen', { install_status: '8' })] }, { measures });
  assert.match(withMeasure.byRule('CMDB-087')[0].description, /discovery last found it 2026-09-10/);
  assert.match(withMeasure.byRule('CMDB-087')[0].evidence.map((e) => e.reason).join(' '), /from measures\.retired_still_discovered/);

  /* Without the producer, the consumer says so rather than doing its own sums. */
  const without = run({ cmdb_ci: [ci('stolen', { install_status: '8', last_discovered: '2026-09-10 00:00:00' })] });
  assert.match(without.reason('CMDB-087'), /deliberately NOT recomputed here/);
  assert.equal(without.byRule('CMDB-087').length, 1, 'the self-contradiction half must still fire');
  assert.equal(/discovery last found it/.test(without.byRule('CMDB-087')[0].description), false,
    'the discovery half must be absent, not re-derived');
});

test('an estate with no dead CI reports an EVALUATED result, not a skip', () => {
  const { byRule, reason } = run({ cmdb_ci: [ci('a'), ci('b')], cmdb_rel_ci: [edge('r1', 'a', 'b')] });
  for (const id of ['CMDB-080', 'CMDB-081', 'CMDB-084', 'CMDB-087']) {
    assert.equal(byRule(id).length, 0, id);
    assert.match(reason(id), /No CI on this instance is in a dead lifecycle state/, id);
  }
});

/* ════════════════ the asset register's second opinion ════════════════ */

test('CMDB-082 maps the two state vocabularies by LABEL — a Consumed asset against an Installed CI', () => {
  const { byRule } = run({
    cmdb_ci: [ci('laptop', { install_status: '1' })],
    /* Asset 10 is Consumed. CI 10 means nothing at all: matching by number would miss this. */
    alm_asset: [{ sys_id: 'a1', ci: 'laptop', install_status: '10', display_name: 'P1000479' }],
  });
  const f = byRule('CMDB-082');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /asset register says .* is "Consumed" and the CMDB says it is "Installed"/);
  assert.match(f[0].evidence.map((e) => e.field_value).join(' '), /label/);
});

test('CMDB-086 reports a mismatch that is not an opposite — different stage, not dead against live', () => {
  const { byRule } = run({
    cmdb_ci: [ci('srv', { install_status: '3' })],                       // In Maintenance
    alm_asset: [{ sys_id: 'a1', ci: 'srv', install_status: '6', display_name: 'SRV' }],  // In stock
  });
  assert.equal(byRule('CMDB-082').length, 0, 'neither side is dead, so this is not the decommission contradiction');
  assert.equal(byRule('CMDB-086').length, 1);
  assert.match(byRule('CMDB-086')[0].description, /maintenance against transitional/);
});

test('matching states agree, and an unmappable state is not a contradiction', () => {
  const { byRule, reason, r } = run({
    cmdb_ci: [ci('a', { install_status: '1' }), ci('b', { install_status: '99' })],
    alm_asset: [{ sys_id: 'a1', ci: 'a', install_status: '1' }, { sys_id: 'a2', ci: 'b', install_status: '1' }],
  });
  assert.equal(byRule('CMDB-082').length, 0);
  assert.equal(byRule('CMDB-086').length, 0);
  assert.match(reason('CMDB-082'), /maps to no lifecycle stage/);
  assert.equal(r.measures.asset_agreement.agree, 1);
  assert.equal(r.measures.asset_agreement.unmapped, 1);
});

test('without the choice labels the two vocabularies are not mapped by number', () => {
  const { byRule, reason } = run({
    cmdb_ci: [ci('laptop', { install_status: '1' })],
    alm_asset: [{ sys_id: 'a1', ci: 'laptop', install_status: '10' }],
  }, { choices: [] });
  assert.equal(byRule('CMDB-082').length, 0, 'mapping by number would have invented a contradiction here');
  assert.match(reason('CMDB-082'), /do NOT share values, so mapping by number would invent contradictions/);
});

/* ════════════════ the structural and governance rules ════════════════ */

test('CMDB-083 charges the surviving end of an edge into a deleted CI', () => {
  const { byRule, reason } = run({
    cmdb_ci: [ci('alive')],
    cmdb_rel_ci: [edge('r1', 'alive', 'ghost'), edge('r2', 'gone1', 'gone2')],
  });
  const f = byRule('CMDB-083');
  assert.deepEqual(f.map((x) => x.target_ids[0]), ['alive']);
  assert.match(f[0].description, /pointing at a CI that no longer exists/);
  assert.match(reason('CMDB-083'), /BOTH endpoints missing/);
});

test('CMDB-084 needs the task tables, and says so when the scan did not read them', () => {
  const { reason } = run({ cmdb_ci: [ci('dead', { install_status: '7' })] }, {
    coverage: full({ incident: { status: 'not_requested', rows_complete: false }, change_request: { status: 'not_requested', rows_complete: false }, problem: { status: 'not_requested', rows_complete: false } }),
  });
  assert.match(reason('CMDB-084'), /A CMDB-only scan does not read ITSM/);
});

test('CMDB-084 charges a retired CI carrying open work', () => {
  const { byRule } = run({
    cmdb_ci: [ci('dead', { install_status: '7' })],
    incident: [{ sys_id: 'i1', number: 'INC0001', cmdb_ci: 'dead', active: 'true' }],
    change_request: [{ sys_id: 'c1', number: 'CHG0001', cmdb_ci: 'dead', active: 'false' }],
  });
  const f = byRule('CMDB-084');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /INC0001/);
  assert.equal(/CHG0001/.test(f[0].description), false, 'a closed task is not open work');
});

test('CMDB-085 groups retired CIs inside the scored population by class', () => {
  const { byRule } = run({
    cmdb_ci: [ci('d1', { install_status: '7' }), ci('d2', { install_status: '7' }), ci('live')],
  });
  const f = byRule('CMDB-085');
  assert.equal(f.length, 1, 'one grouped finding, not one per retired CI');
  assert.deepEqual(f[0].grouped_classes, [{ cls: 'cmdb_ci_server', cis: 2 }]);
});

test('CMDB-088 refuses to measure staleness on a bulk-touched estate', () => {
  const measures = { record_freshness: { bulk_touch_pct: 95.5 } };
  const { byRule, reason } = run({
    cmdb_ci: [ci('old', { sys_updated_on: '2020-01-01 00:00:00' })],
  }, { measures });
  assert.equal(byRule('CMDB-088').length, 0);
  assert.match(reason('CMDB-088'), /reports a job's schedule rather than whether anybody has looked/);
});

test('CMDB-088 charges a genuinely stale live CI when freshness can be believed', () => {
  const { byRule } = run({
    cmdb_ci: [ci('old', { sys_updated_on: '2020-01-01 00:00:00' }), ci('fresh'), ci('dead', { install_status: '7', sys_updated_on: '2020-01-01 00:00:00' })],
  }, { measures: { record_freshness: { bulk_touch_pct: 0 } } });
  assert.deepEqual(byRule('CMDB-088').map((f) => f.target_ids[0]), ['old'],
    'a fresh CI is not stale, and a CI already retired is not a backlog');
});

test('CMDB-089 is the SINGLE home for a CI whose lifecycle was never set', () => {
  const { byRule, reason } = run({
    cmdb_ci: [ci('nostate', { install_status: '' }), ci('young', { install_status: '', sys_created_on: '2026-09-01 00:00:00' }), ci('fine')],
  });
  const f = byRule('CMDB-089');
  assert.deepEqual(f.map((x) => x.target_ids[0]), ['nostate'], 'a CI created last week is not yet a lifecycle failure');
  assert.match(f[0].description, /no install_status at all/);
  assert.match(f[0].false_positive_guard.note, /the completeness dimension deliberately leaves them to D8/);
  assert.match(reason('CMDB-089'), /The half that needs no audit DID run/);
});

test('CMDB-089 reports a never-moved lifecycle as a class pattern when the audit log is read', () => {
  const { byRule } = run({
    cmdb_ci: [ci('stuck'), ci('moved')],
    sys_audit: [{ sys_id: 'a1', documentkey: 'moved', fieldname: 'install_status', sys_created_on: '2024-01-01 00:00:00' }],
  });
  const f = byRule('CMDB-089');
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].grouped_classes, [{ cls: 'cmdb_ci_server', cis: 1 }]);
  assert.match(f[0].description, /never had a lifecycle field change once/);
});

test('CMDB-090 never assumes a retention period', () => {
  const { byRule, reason } = run({ cmdb_ci: [ci('dead', { install_status: '7', sys_updated_on: '2015-01-01 00:00:00' })] });
  assert.equal(byRule('CMDB-090').length, 0);
  assert.match(reason('CMDB-090'), /one is never assumed/);
  assert.match(reason('CMDB-090'), /CMDB-101/);

  const configured = run({ cmdb_ci: [ci('dead', { install_status: '7', sys_updated_on: '2015-01-01 00:00:00' })] }, { options: { retentionDays: 365 } });
  assert.equal(configured.byRule('CMDB-090').length, 1);
});

test('every Group 8 rule refuses to run when the CIs were not read completely', () => {
  const { r } = run({ cmdb_ci: [ci('a')] }, { coverage: full({ cmdb_ci: { status: 'truncated', rows_complete: false } }) });
  assert.equal(r.findings.length, 0);
  for (const id of LIFECYCLE_RULES) assert.ok(r.skipped.some((s) => s.rule === id), `${id} ran anyway`);
});
