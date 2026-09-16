import test from 'node:test';
import assert from 'node:assert/strict';

import { CMDB_CATALOGUE, scoreCmdbQuality } from '../src/health/cmdb-quality.js';
import { EstateRules, IMPLEMENTED_CATALOGUE_RULES } from '../src/health/rules.js';
import { IDENTIFICATION_RULES, cmdbIdentificationRules } from '../src/health/cmdb-identification.js';
import { buildSignals } from '../src/health/cmdb-signals.js';

/*
 * Health Assist — Group 5 (Identification and reconciliation, D4/D5), 19 Sep 2026.
 *
 * Built on the catalogue defaults: IRE bypass 20% (escalate 40%), dead source 30
 * days, attribute strength classified in configuration.
 *
 * The property this file protects hardest: on an instance that records no source
 * attribution at all, "every CI bypassed IRE" and "this instance does not write
 * sys_object_source" are indistinguishable — and reporting the first would be a
 * Systemic finding about nothing. The rules skip instead, loudly.
 */

const NOW = new Date('2026-09-19T06:00:00Z');
const ok = { status: 'ok' };
const TABLES = ['cmdb_ci', 'cmdb_rel_ci', 'cmdb_ci_service', 'cmdb_class_info', 'cmdb_identifier', 'cmdb_identifier_entry',
  'cmdb_metadata_hosting', 'cmdb_metadata_containment', 'sys_object_source', 'cmdb_reconciliation_definition',
  'cmdb_datasource_precedence', 'cmdb_datasource_last_update', 'cmdb_datasource_staleness', 'cmdb_ire_output_aggregate_stats',
  'cmdb_datasource_attribute_value', 'change_request', 'life_cycle_mapping', 'life_cycle_control'];
const full = () => Object.fromEntries(TABLES.map((t) => [t, { table: t, status: 'complete', rows_complete: true, missing_fields: [] }]));
const CLASSES = {
  cmdb: { super: null }, cmdb_ci: { super: 'cmdb' }, cmdb_ci_hardware: { super: 'cmdb_ci' },
  cmdb_ci_computer: { super: 'cmdb_ci_hardware' }, cmdb_ci_server: { super: 'cmdb_ci_computer' },
  cmdb_ci_disk: { super: 'cmdb_ci_hardware' }, cmdb_ci_appl: { super: 'cmdb_ci' },
};

function run(estate, { meta = {}, coverage = full(), options = null } = {}) {
  const r = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [], ...estate }, coverage, 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok, used_for: ok, virtual: ok }, classes: { byName: CLASSES }, virtualIds: [], usedFor: {}, choices: [], ...meta } },
  });
  if (options) {
    r.signals = buildSignals(r);
    cmdbIdentificationRules(r, options);
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
  sys_created_on: '2026-09-18 00:00:00', discovery_source: '', ...fields,
});
const identifier = (sys_id, name, applies_to, over = {}) => ({ sys_id, name, applies_to, active: 'true', independent: 'true', ...over });
const entry = (sys_id, id, attributes, order = '100', over = {}) => ({ sys_id, identifier: id, attributes, order, active: 'true', ...over });

/* ════════════════════════ the catalogue ════════════════════════ */

test('Group 5 is built: identification scores in D4, reconciliation in D5', () => {
  for (const id of IDENTIFICATION_RULES) assert.ok(IMPLEMENTED_CATALOGUE_RULES.has(id), id);
  for (const id of ['CMDB-044', 'CMDB-045', 'CMDB-046', 'CMDB-047', 'CMDB-050', 'CMDB-053', 'CMDB-054']) {
    assert.equal(CMDB_CATALOGUE[id].dimension, 'D4', id);
  }
  for (const id of ['CMDB-048', 'CMDB-049', 'CMDB-051', 'CMDB-052', 'CMDB-055']) {
    assert.equal(CMDB_CATALOGUE[id].dimension, 'D5', id);
  }
  assert.equal(CMDB_CATALOGUE['CMDB-044'].systemicKind, 'config_absence');
  assert.equal(CMDB_CATALOGUE['CMDB-045'].systemicKind, 'config_absence');
  assert.equal(CMDB_CATALOGUE['CMDB-046'].systemicKind, 'measured_kpi');
});

/* ════════════════════════ D4 — identification ════════════════════════ */

test('CMDB-044 fires on an identifier that matches by name alone, and not on one with an identity attribute', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a'), ci('b')],
    cmdb_identifier: [identifier('i-name', 'Server by name', 'cmdb_ci_server'), identifier('i-serial', 'Server by serial', 'cmdb_ci_server')],
    cmdb_identifier_entry: [
      entry('e1', 'i-name', 'name'), entry('e2', 'i-name', 'location'),
      entry('e3', 'i-serial', 'serial_number'), entry('e4', 'i-serial', 'name', '200'),
    ],
  });
  assert.deepEqual(byRule('CMDB-044').map((f) => f.target_ids[0]), ['i-name']);
  assert.match(byRule('CMDB-044')[0].description, /matches cmdb_ci_server on name, location alone/);
  assert.match(byRule('CMDB-044')[0].description, /2 CI\(s\) are governed by it/);
  assert.equal(byRule('CMDB-044')[0].false_positive_guard.evaluated, false);
});

test('a rule for a class holding no CI is counted, not reported — and structural criteria count as identity', () => {
  /* Measured on dev424910: 96 of 409 active identifiers match by name alone, but
     only two govern any CI. Reporting the other 94 would bury the two. */
  const { byRule, skipped, r } = run({
    cmdb_ci: [ci('a', 'cmdb_ci_server')],
    cmdb_identifier: [
      identifier('i-dormant', 'App by name', 'cmdb_ci_appl'),             // name-only, but no CI in that class
      identifier('i-live', 'Server by name', 'cmdb_ci_server'),
      identifier('i-structural', 'WAR by path', 'cmdb_ci_server'),
    ],
    cmdb_identifier_entry: [
      entry('e1', 'i-dormant', 'name,location'),
      entry('e2', 'i-live', 'name'),
      entry('e3', 'i-structural', 'name,host,install_directory'),
    ],
  });
  assert.deepEqual(byRule('CMDB-044').map((f) => f.target_ids[0]), ['i-live'],
    'a dormant rule was reported, or a structural criterion was read as a label');
  assert.match(skipped('CMDB-044')[0].reason, /govern a class holding no CI on this instance/);
  assert.equal(r.measures.identification_rules.in_force, 2);
  assert.equal(r.measures.identification_rules.dormant_with_defects, 1);
});

test('CMDB-045 fires on a class nothing identifies, and an inherited rule counts as coverage', () => {
  const estate = {
    cmdb_ci: [ci('s1', 'cmdb_ci_server'), ci('app1', 'cmdb_ci_appl')],
    cmdb_identifier: [identifier('i-hw', 'Hardware', 'cmdb_ci_hardware')],
    cmdb_identifier_entry: [entry('e1', 'i-hw', 'serial_number')],
  };
  const { byRule } = run(estate);
  /* cmdb_ci_server inherits the hardware rule; cmdb_ci_appl has nothing. */
  assert.deepEqual(byRule('CMDB-045').map((f) => f.description.match(/^(\S+)/)[1]), ['cmdb_ci_appl']);
  assert.match(byRule('CMDB-045')[0].description, /no principal classes are designated/);
  assert.equal(byRule('CMDB-045')[0].false_positive_guard.evaluated, true);

  const covered = run({ ...estate, cmdb_identifier: [...estate.cmdb_identifier, identifier('i-app', 'App', 'cmdb_ci_appl')], cmdb_identifier_entry: [...estate.cmdb_identifier_entry, entry('e2', 'i-app', 'name')] });
  assert.equal(covered.byRule('CMDB-045').length, 0);
  assert.match(covered.skipped('CMDB-045')[0].reason, /Every one of the 2 class\(es\) in scope resolves to an identification rule/);
});

test('CMDB-045 refuses to run without the class hierarchy rather than reporting every class as uncovered', () => {
  const { byRule, skipped } = run(
    { cmdb_ci: [ci('s1')], cmdb_identifier: [identifier('i', 'x', 'cmdb_ci_hardware')], cmdb_identifier_entry: [entry('e', 'i', 'serial_number')] },
    { meta: { reads: { class_hierarchy: { status: 'forbidden' } } } },
  );
  assert.equal(byRule('CMDB-045').length, 0);
  assert.match(skipped('CMDB-045')[0].reason, /inherited from a parent class cannot be resolved/);
});

test('CMDB-047 fires on a dependent-only identifier, unless the class is dependent BY DESIGN', () => {
  const estate = {
    cmdb_ci: [ci('s1', 'cmdb_ci_server'), ci('d1', 'cmdb_ci_disk')],
    cmdb_identifier: [identifier('i-srv', 'Server', 'cmdb_ci_server', { independent: 'false' }), identifier('i-disk', 'Disk', 'cmdb_ci_disk', { independent: 'false' })],
    cmdb_identifier_entry: [entry('e1', 'i-srv', 'name'), entry('e2', 'i-disk', 'name')],
    cmdb_metadata_hosting: [{ sys_id: 'h1', parent_type: 'cmdb_ci_server', child_type: 'cmdb_ci_disk', rel_type: 'r' }],
    cmdb_metadata_containment: [],
  };
  const { byRule } = run(estate);
  assert.deepEqual(byRule('CMDB-047').map((f) => f.target_ids[0]), ['i-srv'], 'a disk, dependent by design, was reported');
  assert.equal(byRule('CMDB-047')[0].false_positive_guard.evaluated, true);

  const cov = full();
  cov.cmdb_metadata_hosting = { table: 'cmdb_metadata_hosting', status: 'forbidden', rows_complete: false };
  const blind = run(estate, { coverage: cov });
  assert.equal(blind.byRule('CMDB-047').length, 2, 'without the metadata every dependent rule must be reported, with the caveat');
  assert.match(blind.byRule('CMDB-047')[0].false_positive_guard.note, /could not be read, so genuinely dependent classes/);
});

test('CMDB-054 fires when a descriptive entry is evaluated before an identity entry', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a')],
    cmdb_identifier: [identifier('i-bad', 'Weak first', 'cmdb_ci_server'), identifier('i-good', 'Strong first', 'cmdb_ci_computer')],
    cmdb_identifier_entry: [
      entry('e1', 'i-bad', 'name', '100'), entry('e2', 'i-bad', 'serial_number', '200'),
      entry('e3', 'i-good', 'serial_number', '100'), entry('e4', 'i-good', 'name', '200'),
    ],
  });
  assert.deepEqual(byRule('CMDB-054').map((f) => f.target_ids[0]), ['i-bad']);
  assert.match(byRule('CMDB-054')[0].description, /evaluates name \(order 100\) before serial_number \(order 200\)/);
  assert.equal(byRule('CMDB-054')[0].confidence, 0.9);
});

test('CMDB-046/050: with source attribution, the bypass rate is measured, gates above 20% and escalates above 40%', () => {
  const cis = Array.from({ length: 10 }, (_, i) => ci(`c${i}`));
  const { r, byRule } = run({
    cmdb_ci: cis,
    sys_object_source: [{ sys_id: 's1', name: 'ServiceNow', target_table: 'cmdb_ci', target_sys_id: 'c0' }, { sys_id: 's2', name: 'ServiceNow', target_table: 'cmdb_ci', target_sys_id: 'c1' }],
  });
  const kpi = r.kpis.find((k) => k.rule_id === 'CMDB-046');
  assert.deepEqual([kpi.numerator, kpi.denominator], [2, 10]);
  assert.equal(kpi.pass_pct, 20, 'the KPI is the share that DID go through IRE');
  assert.match(kpi.alerts, /inferred from the ABSENCE of source attribution/);
  const [gate] = byRule('CMDB-046');
  assert.ok(gate, 'an 80% bypass rate did not fire');
  assert.match(gate.description, /8 of 10 CI creates .* \(80.0%\)/);
  assert.ok(gate.modifiers.escalators.includes('rule_threshold'), '80% is above the 40% escalation point');
  assert.equal(byRule('CMDB-050').length, 8, 'the individual bypassed CIs were not listed');
});

test('CMDB-046/050 SKIP — never report a 100% bypass — when the instance records no source attribution at all', () => {
  const { byRule, skipped, r } = run({ cmdb_ci: [ci('a'), ci('b')], sys_object_source: [] });
  assert.equal(byRule('CMDB-046').length + byRule('CMDB-050').length, 0);
  assert.equal(r.kpis.filter((k) => k.rule_id === 'CMDB-046').length, 0, 'a KPI was published from a table with no rows');
  for (const rule of ['CMDB-046', 'CMDB-050']) {
    assert.match(skipped(rule)[0].reason, /holds no rows at all on this instance/);
    assert.match(skipped(rule)[0].reason, /left unjudged rather than reported as a 100% bypass rate/);
  }
});

test('CMDB-046 counts only the creation window, and says so when nothing was created in it', () => {
  const { skipped } = run({
    cmdb_ci: [ci('old', 'cmdb_ci_server', { sys_created_on: '2020-01-01 00:00:00' })],
    sys_object_source: [{ sys_id: 's1', name: 'x', target_table: 'cmdb_ci', target_sys_id: 'other' }],
  });
  assert.match(skipped('CMDB-046')[0].reason, /No CI was created in the last 90 days/);
});

test('CMDB-053 needs runs before it calls anything a trend', () => {
  const stats = (id, errors, at) => ({ sys_id: id, run_id: id, run_table: 'cmdb_ci', errors: String(errors), warnings: '0', distinct_error_codes: 'IDENTIFICATION_ERROR', sys_created_on: at });
  const few = run({ cmdb_ci: [ci('a')], cmdb_ire_output_aggregate_stats: [stats('r1', 50, '2026-09-18 00:00:00')] });
  assert.match(few.skipped('CMDB-053')[0].reason, /Only 1 IRE run\(s\) in the last 90 days; a trend needs at least 3/);

  const many = run({
    cmdb_ci: Array.from({ length: 10 }, (_, i) => ci(`c${i}`)),
    sys_object_source: [{ sys_id: 's', name: 'x', target_table: 'cmdb_ci', target_sys_id: 'c0' }],
    cmdb_ire_output_aggregate_stats: ['r1', 'r2', 'r3'].map((id, i) => stats(id, 5, `2026-09-1${i + 5} 00:00:00`)),
  });
  const [x] = many.byRule('CMDB-053');
  assert.ok(x, '15 errors against 10 creates did not fire');
  assert.match(x.description, /15 error\(s\) across 3 run\(s\)/);
  assert.match(x.description, /Error codes: IDENTIFICATION_ERROR/);
});

/* ════════════════════════ D5 — reconciliation ════════════════════════ */

const definition = (sys_id, over = {}) => ({
  sys_id, name: sys_id, applies_to: 'cmdb_ci_server', attributes: 'serial_number', discovery_source: 'ServiceNow',
  priority: '100', active: 'true', ...over,
});

test('CMDB-048 fires when two sources claim one attribute at the same priority, and not at different priorities', () => {
  const same = run({
    cmdb_ci: [ci('a')],
    cmdb_reconciliation_definition: [definition('d1'), definition('d2', { discovery_source: 'SCCM' })],
  });
  const [x] = same.byRule('CMDB-048');
  assert.ok(x, 'an equal-precedence collision did not fire');
  assert.match(x.description, /both claim serial_number on cmdb_ci_server at priority 100/);
  assert.deepEqual([...x.target_ids].sort(), ['d1', 'd2']);

  const ordered = run({
    cmdb_ci: [ci('a')],
    cmdb_reconciliation_definition: [definition('d1'), definition('d2', { discovery_source: 'SCCM', priority: '200' })],
  });
  assert.equal(ordered.byRule('CMDB-048').length, 0, 'different precedence levels are correct behaviour');
});

test('CMDB-052 fires on a reconciliation rule for a source the instance does not know', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a', 'cmdb_ci_server', { discovery_source: 'ServiceNow' })],
    cmdb_reconciliation_definition: [definition('d1', { discovery_source: 'Tanuim' })],
  }, { meta: { choices: [{ name: 'cmdb_ci', element: 'discovery_source', value: 'ServiceNow', inactive: 'false' }] } });
  const [x] = byRule('CMDB-052');
  assert.ok(x, 'a rule naming an unregistered source did not fire');
  assert.match(x.description, /give precedence to "Tanuim", which is not a registered discovery source/);
  assert.equal(x.false_positive_guard.evaluated, true);
});

test('CMDB-049 fires on a source that stopped reporting, honours its own staleness window, and says when it never reported', () => {
  const base = {
    cmdb_ci: [ci('a')],
    cmdb_reconciliation_definition: [definition('d1', { discovery_source: 'SCCM' })],
    cmdb_datasource_precedence: [{ sys_id: 'p1', name: 'SCCM', applies_to: 'cmdb_ci_server', discovery_source: 'SCCM', order: '100', active: 'true' }],
    cmdb_datasource_last_update: [{ sys_id: 'u1', discovery_source: 'SCCM', class: 'cmdb_ci_server', attribute: 'serial_number', updated_on: '2026-07-01 00:00:00' }],
  };
  const [x] = run(base).byRule('CMDB-049');
  assert.ok(x, 'a source silent for 80 days did not fire');
  assert.match(x.description, /last wrote data 80 days ago \(threshold 30\)/);
  assert.match(x.description, /still holds precedence for serial_number/);

  const lenient = run({ ...base, cmdb_datasource_staleness: [{ sys_id: 's1', name: 'annual', discovery_source: 'SCCM', duration: '365', active: 'true' }] });
  assert.equal(lenient.byRule('CMDB-049').length, 0, 'a per-source window was ignored');

  const never = run({ ...base, cmdb_datasource_last_update: [] });
  assert.equal(never.byRule('CMDB-049').length, 0);
  assert.match(never.skipped('CMDB-049')[0].reason, /has never written an attribute value this instance recorded/);
});

test('CMDB-051 and CMDB-055 separate "wrote without precedence" from "nobody holds precedence"', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a')],
    cmdb_reconciliation_definition: [definition('d1', { discovery_source: 'ServiceNow', attributes: 'serial_number' })],
    cmdb_datasource_attribute_value: [
      { sys_id: 'v1', ci: 'a', class: 'cmdb_ci_server', attribute: 'serial_number', discovery_source: 'SCCM', value: 'X' },
      { sys_id: 'v2', ci: 'a', class: 'cmdb_ci_server', attribute: 'name', discovery_source: 'SCCM', value: 'Y' },
    ],
  });
  const [without] = byRule('CMDB-051');
  assert.match(without.description, /"SCCM" has written serial_number on cmdb_ci_server 1 time\(s\) without holding precedence for it — ServiceNow does/);
  const [unclaimed] = byRule('CMDB-055');
  assert.match(unclaimed.description, /name on cmdb_ci_server is written by SCCM .* and no reconciliation rule claims precedence/);
});

test('an instance with none of the reconciliation tables populated says so, rule by rule, and invents nothing', () => {
  const { r, skipped } = run({ cmdb_ci: [ci('a')] });
  assert.equal(r.findings.filter((f) => ['CMDB-048', 'CMDB-049', 'CMDB-051', 'CMDB-052', 'CMDB-055'].includes(f.rule_id)).length, 0);
  assert.match(skipped('CMDB-048')[0].reason, /No active reconciliation definition exists/);
  assert.match(skipped('CMDB-051')[0].reason, /records no per-source attribute values/);
  assert.match(skipped('CMDB-052')[0].reason, /No active reconciliation definition exists/);
});

/* ════════════════════════ scoring ════════════════════════ */

test('a configuration finding charges no CI: D4 is scored by what the misconfiguration DID, not by the row itself', () => {
  const { r } = run({
    cmdb_ci: [ci('a'), ci('b')],
    cmdb_identifier: [identifier('i-name', 'By name', 'cmdb_ci_server'), identifier('i-dep', 'Dependent', 'cmdb_ci_server', { independent: 'false' })],
    cmdb_identifier_entry: [entry('e1', 'i-name', 'name'), entry('e2', 'i-dep', 'name')],
    cmdb_metadata_hosting: [], cmdb_metadata_containment: [],
  });
  for (const rule of ['CMDB-044', 'CMDB-047']) {
    assert.match(r.findings.find((f) => f.rule_id === rule).unscored_reason, /names cmdb_identifier records, not CIs/);
  }
  const q = scoreCmdbQuality({
    findings: r.findings, kpis: r.kpis, inScope: { ids: ['a', 'b'], basis: 't' }, implemented: IMPLEMENTED_CATALOGUE_RULES,
  });
  /* CMDB-044 is base Systemic and config_absence: it GATES rather than scoring.
     CMDB-047 is Critical and would otherwise charge — it is reported unscored. */
  assert.ok(q.gate.blockers.some((b) => b.rule_id === 'CMDB-044'), 'a name-only identifier did not gate the score');
  assert.ok(q.unscored_findings.some((u) => u.rule_id === 'CMDB-047'));
  const d4 = q.dimensions.find((d) => d.key === 'D4');
  assert.equal(d4.record_part, 100, 'a configuration row was charged to the CIs it governs');
});

test('the data-quality dimensions score only the records they judge — retired CIs are the lifecycle dimension\'s', () => {
  const ids = ['live', 'retired'];
  const q = scoreCmdbQuality({
    findings: [{ rule_id: 'CMDB-012', severity: 'CRITICAL', deduction_severity: 'CRITICAL', target_ids: ['live'], fingerprint: 'f1' }],
    inScope: { ids, basis: 't' },
    implemented: IMPLEMENTED_CATALOGUE_RULES,
    dimensionScope: { D1: ['live'] },
  });
  const d1 = q.dimensions.find((d) => d.key === 'D1');
  assert.equal(d1.records_scored, 1);
  assert.equal(d1.score, 60, 'the retired CI diluted the completeness score');
  assert.match(d1.scope_note, /1 record\(s\) out of this dimension's scope/);
});
