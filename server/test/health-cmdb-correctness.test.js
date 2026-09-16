import test from 'node:test';
import assert from 'node:assert/strict';

import { CMDB_CATALOGUE, scoreCmdbQuality } from '../src/health/cmdb-quality.js';
import { EstateRules } from '../src/health/rules.js';
import { materialityFor, inCidr } from '../src/health/cmdb-signals.js';
import { nameShape, validFqdn, validSerial } from '../src/health/cmdb-correctness.js';

/*
 * Health Assist — Group 3 (Correctness, D2) and the decisions of 17 Sep 2026:
 *
 *   1. systemic_kind: config_absence gates only; measured_kpi gates on breach AND scores.
 *   2. CMDB-141 counts service-bound changes only; CMDB-021 fires at 80% (confirmed).
 *   3. Materiality: escalate at ≥ 20% of the class AND ≥ 10 CIs; de-escalate below
 *      max(5, 1% of the class); neither in between.
 *   4. CMDB-024, 068, 085, 087, 090, 108 score in their group's dimension.
 *   5. The production escalator never fires on the bare used_for default.
 *
 * Corrections of 18 Sep 2026:
 *   - CMDB-023 flags only RUNNING against NOT RUNNING stages: Installed + Non-Operational is valid.
 *   - CMDB-030 is a conservative subset and says on every run that it under-detects serials.
 *   - Materiality: a class-wide pattern is ONE finding; records keep their own deduction.
 */

/* ════════════════════════ decisions ════════════════════════ */

test('systemic_kind is on every Systemic rule: config absences gate only, measured KPIs gate and score', () => {
  for (const id of ['CMDB-001', 'CMDB-044', 'CMDB-045']) assert.equal(CMDB_CATALOGUE[id].systemicKind, 'config_absence', id);
  for (const id of ['CMDB-046', 'CMDB-057', 'CMDB-070', 'CMDB-141']) assert.equal(CMDB_CATALOGUE[id].systemicKind, 'measured_kpi', id);
  const unclassified = Object.values(CMDB_CATALOGUE).filter((r) => r.base === 'SYSTEMIC' && !r.systemicKind);
  assert.deepEqual(unclassified.map((r) => r.id), [], 'a Systemic rule has no systemic kind');

  const q = scoreCmdbQuality({
    findings: [{ rule_id: 'CMDB-001', severity: 'SYSTEMIC', target_ids: [], fingerprint: 'g' }, { rule_id: 'CMDB-141', severity: 'SYSTEMIC', target_ids: ['c'], fingerprint: 'k' }],
    kpis: [{ rule_id: 'CMDB-141', pass_pct: 40, numerator: 2, denominator: 5 }],
    inScope: { ids: ['a'], basis: 't' },
    implemented: new Set(['CMDB-001', 'CMDB-141']),
  });
  assert.deepEqual(q.gate.blockers.map((b) => [b.rule_id, b.systemic_kind]), [['CMDB-001', 'config_absence'], ['CMDB-141', 'measured_kpi']]);
  assert.equal(q.dimensions.find((d) => d.key === 'D10').score, 40, 'the measured KPI did not score');
});

test('the six record-level rules now score in their group\'s dimension', () => {
  assert.deepEqual(['CMDB-024', 'CMDB-068', 'CMDB-085', 'CMDB-087', 'CMDB-090', 'CMDB-108'].map((id) => [id, CMDB_CATALOGUE[id].dimension, CMDB_CATALOGUE[id].track]),
    [['CMDB-024', 'D2', 'dimension'], ['CMDB-068', 'D6', 'dimension'], ['CMDB-085', 'D8', 'dimension'], ['CMDB-087', 'D8', 'dimension'], ['CMDB-090', 'D8', 'dimension'], ['CMDB-108', 'D9', 'dimension']]);
});

test('materiality: ≥ 20% AND ≥ 10 escalates, below max(5, 1%) de-escalates, neither in between', () => {
  const cis = new Map();
  for (let i = 0; i < 100; i++) cis.set(`c${i}`, { sys_id: `c${i}`, sys_class_name: 'cmdb_ci_computer' });
  for (let i = 0; i < 3000; i++) cis.set(`s${i}`, { sys_id: `s${i}`, sys_class_name: 'cmdb_ci_spkg' });
  const findings = (rule, prefix, n) => Array.from({ length: n }, (_, i) => ({ rule_id: rule, fingerprint: `${rule}-${prefix}${i}`, target_ids: [`${prefix}${i}`] }));
  const v = (list) => materialityFor(list, cis).get(list[0].fingerprint);
  assert.equal(v(findings('R1', 'c', 25)).escalate, true, '25 of 100 (25%, ≥10) did not escalate');
  assert.equal(v(findings('R2', 'c', 9)).escalate, false, '9 CIs escalated despite the absolute floor of 10');
  assert.equal(v(findings('R3', 'c', 4)).deEscalate, true, '4 of 100 is below max(5, 1)');
  const between = v(findings('R4', 'c', 12));
  assert.deepEqual([between.escalate, between.deEscalate], [false, false], '12 of 100 should apply neither');
  assert.equal(v(findings('R5', 's', 20)).deEscalate, true, '20 of 3,000 is below 1% (30)');
});

test('CIDR matching for independent production evidence', () => {
  assert.equal(inCidr('10.88.4.2', '10.88.0.0/16'), true);
  assert.equal(inCidr('10.89.4.2', '10.88.0.0/16'), false);
  assert.equal(inCidr('not-an-ip', '10.0.0.0/8'), false);
});

/* ════════════════════════ fixtures ════════════════════════ */

const NOW = new Date('2026-09-17T06:00:00Z');
const ok = { status: 'ok' };
const TABLES = ['cmdb_ci', 'cmdb_rel_ci', 'cmdb_ci_service', 'svc_ci_assoc', 'cmdb_class_info', 'change_request', 'life_cycle_mapping',
  'life_cycle_control', 'cmdb_reconciliation_definition', 'cmdb_datasource_attribute_value', 'cmdb_health_config'];
const full = () => Object.fromEntries(TABLES.map((t) => [t, { table: t, status: 'complete', rows_complete: true, missing_fields: [] }]));
const CLASSES = {
  cmdb_ci: { super: null }, cmdb_ci_hardware: { super: 'cmdb_ci' }, cmdb_ci_computer: { super: 'cmdb_ci_hardware' },
  cmdb_ci_server: { super: 'cmdb_ci_computer' }, cmdb_ci_appl: { super: 'cmdb_ci' }, cmdb_ci_service: { super: 'cmdb_ci' },
};
const CONTROLS = [
  { sys_id: 'op', life_cycle_stage: 'Operational' }, { sys_id: 'inv', life_cycle_stage: 'Inventory' },
  { sys_id: 'eol', life_cycle_stage: 'End of Life' }, { sys_id: 'design', life_cycle_stage: 'Design' },
];
/*
 * The instance's OOB cmdb_ci mapping, as measured on dev424910. It matters that
 * BOTH fields reach Inventory and End of Life, and that only operational_status
 * reaches Design: CMDB-023's permitted set is derived from exactly that shape.
 */
const MAPPINGS = [
  ['install_status', '1', 'op'], ['install_status', '3', 'op'], ['install_status', '5', 'inv'],
  ['install_status', '6', 'inv'], ['install_status', '7', 'eol'],
  ['operational_status', '1', 'op'], ['operational_status', '3', 'op'], ['operational_status', '5', 'inv'],
  ['operational_status', '6', 'eol'], ['operational_status', '2', 'design'],
].map(([f, v, c], i) => ({ sys_id: `m${i}`, table: 'cmdb_ci', legacy_field_name: f, legacy_field_value: v, legacy_subfield_name: '', life_cycle_control: c, active: 'true' }));

function run(estate, meta = {}) {
  const r = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [], life_cycle_mapping: MAPPINGS, life_cycle_control: CONTROLS, ...estate }, full(), 90, NOW, {
    meta: {
      cmdb: {
        reads: Object.fromEntries(['class_hierarchy', 'virtual', 'used_for', 'class_attrs', 'choices', 'class_audit', 'field_tables', 'identity_lookups', 'choice_audit', 'change_impact', 'mandatory_fields'].map((k) => [k, ok])),
        classes: { byName: CLASSES }, virtualIds: [], usedFor: {}, classAttrs: {}, choices: [], classAudit: { audited: false, rows: [] },
        choiceAudit: { audited: false, defaults: {}, changed: {} }, changeImpact: { withImpact: [] }, lookups: {}, fieldTables: {}, mandatory: {},
        ...meta,
      },
    },
  });
  const all = r.analyze();
  return { r, byRule: (id) => all.filter((x) => x.rule_id === id), skipped: (id) => r.skipped.filter((s) => s.rule === id) };
}
const ci = (id, cls, fields = {}) => ({ sys_id: id, name: id, sys_class_name: cls, install_status: '1', operational_status: '1', serial_number: 'SN-1001', ip_address: '10.0.0.1', mac_address: '', fqdn: '', discovery_source: 'ServiceNow', ...fields });

/* ════════════════════════ Group 3 rules ════════════════════════ */

test('CMDB-023 reads the permitted set from the instance lifecycle mapping: In Stock + Operational contradicts, Installed + Operational does not', () => {
  const { byRule, skipped } = run({ cmdb_ci: [
    ci('ok', 'cmdb_ci_computer'),
    ci('stock', 'cmdb_ci_computer', { install_status: '6', operational_status: '1' }),
    ci('unmapped', 'cmdb_ci_computer', { install_status: '42', operational_status: '1' }),
  ] });
  assert.deepEqual(byRule('CMDB-023').map((x) => x.target_ids[0]), ['stock']);
  assert.match(byRule('CMDB-023')[0].description, /"Inventory".*"Operational"/);
  /* The permitted set is derived, not listed: both fields reach Operational,
     Inventory and End of Life on this mapping. */
  assert.match(byRule('CMDB-023')[0].false_positive_guard.note, /stages BOTH status fields can reach for cmdb_ci_computer are Operational, Inventory, End of Life/);
  assert.match(skipped('CMDB-023')[0].reason, /1 CI\(s\) hold a status value the lifecycle mapping does not cover/);
});

test('CMDB-023 exempts Installed + Non-Operational (Operational + Design) without hardcoding the pair — 18 Sep', () => {
  const { byRule, skipped } = run({ cmdb_ci: [
    ci('down', 'cmdb_ci_computer', { install_status: '1', operational_status: '2' }),
    ci('stock', 'cmdb_ci_computer', { install_status: '6', operational_status: '1' }),
    ci('retired-running', 'cmdb_ci_computer', { install_status: '7', operational_status: '1' }),
    ci('stock-down', 'cmdb_ci_computer', { install_status: '6', operational_status: '2' }),
  ] });
  /* 'retired-running' is install_status 7 — outside the data-quality slice as of
     19 Sep, so correctness no longer judges it; the lifecycle dimension does. */
  assert.deepEqual(byRule('CMDB-023').map((x) => x.target_ids[0]).sort(), ['stock']);
  assert.match(skipped('CMDB-023').map((x) => x.reason).join(' | '), /only one status field can reach/);
  assert.match(skipped('CMDB-023').map((x) => x.reason).join(' | '), /retired, stolen or absent CI\(s\) are outside the data-quality dimensions/);
});

test('CMDB-023 refuses to run without the mapping — it never falls back to a hardcoded list', () => {
  const r = new EstateRules({ cmdb_ci: [ci('stock', 'cmdb_ci_computer', { install_status: '6' })] },
    { ...full(), life_cycle_mapping: { status: 'forbidden', rows_complete: false } }, 90, NOW,
    { meta: { cmdb: { reads: { class_hierarchy: ok }, classes: { byName: CLASSES } } } });
  r.analyze();
  assert.equal(r.findings.filter((x) => x.rule_id === 'CMDB-023').length, 0);
  assert.match(r.skipped.find((s) => s.rule === 'CMDB-023').reason, /none is hardcoded/);
});

test('CMDB-024: a live CI depending on a retired one fires — unless either has an open change', () => {
  const estate = {
    cmdb_ci: [ci('app', 'cmdb_ci_appl'), ci('srv', 'cmdb_ci_server', { install_status: '7' })],
    cmdb_rel_ci: [{ sys_id: 'r', parent: 'app', child: 'srv', 'type.name': 'Runs on::Runs' }],
  };
  const fired = run(estate);
  assert.equal(fired.byRule('CMDB-024').length, 1);
  assert.deepEqual(fired.byRule('CMDB-024')[0].target_ids.sort(), ['app', 'srv']);
  const migrating = run({ ...estate, change_request: [{ sys_id: 'ch', cmdb_ci: 'srv', active: 'true' }] });
  assert.equal(migrating.byRule('CMDB-024').length, 0, 'a planned migration was reported');
  const unrelatedType = run({ ...estate, cmdb_rel_ci: [{ sys_id: 'r', parent: 'app', child: 'srv', 'type.name': 'Cools::Cooled By' }] });
  assert.equal(unrelatedType.byRule('CMDB-024').length, 0, 'a non-dependency relationship was treated as one');
});

test('CMDB-025 skips on an estate with no authoritative sources, and fires when a precedence source disagrees', () => {
  const none = run({ cmdb_ci: [ci('a', 'cmdb_ci_computer')] });
  assert.match(none.skipped('CMDB-025')[0].reason, /No reconciliation definitions or source attribute values/);
  const fired = run({
    cmdb_ci: [ci('a', 'cmdb_ci_computer', { serial_number: 'WRONG1' })],
    cmdb_reconciliation_definition: [{ sys_id: 'd', applies_to: 'cmdb_ci_hardware', attributes: 'serial_number', discovery_source: 'ServiceNow', priority: '100', active: 'true' }],
    cmdb_datasource_attribute_value: [{ sys_id: 'v', ci: 'a', attribute: 'serial_number', value: 'RIGHT1', discovery_source: 'ServiceNow', updated_on: '2026-09-10 00:00:00' }],
  });
  assert.equal(fired.byRule('CMDB-025').length, 1);
  const lagging = run({
    cmdb_ci: [ci('a', 'cmdb_ci_computer', { serial_number: 'WRONG1' })],
    cmdb_reconciliation_definition: [{ sys_id: 'd', applies_to: 'cmdb_ci_hardware', attributes: 'serial_number', discovery_source: 'ServiceNow', priority: '100', active: 'true' }],
    cmdb_datasource_attribute_value: [{ sys_id: 'v', ci: 'a', attribute: 'serial_number', value: 'RIGHT1', discovery_source: 'ServiceNow', updated_on: '2026-09-17 01:00:00' }],
  });
  assert.equal(lagging.byRule('CMDB-025').length, 0, 'a source report inside the 24h lag window was treated as a contradiction');
});

test('CMDB-026 skips when the CMDB is not audited, fires on churn, and ignores a one-day project', () => {
  const unaudited = run({ cmdb_ci: [ci('a', 'cmdb_ci_computer')] });
  assert.match(unaudited.skipped('CMDB-026')[0].reason, /not audited/);
  const rows = (id, days) => days.map((d, i) => ({ documentkey: id, sys_created_on: `2026-09-${String(d).padStart(2, '0')} 0${i}:00:00`, oldvalue: 'a', newvalue: 'b' }));
  const churn = run({ cmdb_ci: [ci('a', 'cmdb_ci_computer'), ci('b', 'cmdb_ci_computer')] },
    { classAudit: { audited: true, rows: [...rows('a', [1, 5, 9, 13]), ...rows('b', [3, 3, 3, 3])] } });
  assert.deepEqual(churn.byRule('CMDB-026').map((x) => x.target_ids[0]), ['a']);
});

test('CMDB-027 fires on the base class and says what it can infer', () => {
  const { byRule } = run({ cmdb_ci: [ci('base', 'cmdb_ci', { serial_number: '', ip_address: '' })] });
  assert.equal(byRule('CMDB-027').length, 1);
  assert.match(byRule('CMDB-027')[0].description, /no better class can be inferred/);
});

test('CMDB-028 flags a hardware signature in a class where it is rare — only with a clear margin', () => {
  const servers = Array.from({ length: 20 }, (_, i) => ci(`srv${i}`, 'cmdb_ci_server', { mac_address: '00:11:22:33:44:55' }));
  const apps = Array.from({ length: 20 }, (_, i) => ci(`app${i}`, 'cmdb_ci_appl', { serial_number: '', ip_address: '', mac_address: '' }));
  apps[0] = ci('app0', 'cmdb_ci_appl', { mac_address: '00:11:22:33:44:66' });
  const { byRule } = run({ cmdb_ci: [...servers, ...apps] });
  assert.deepEqual(byRule('CMDB-028').map((x) => x.target_ids[0]), ['app0']);
  assert.match(byRule('CMDB-028')[0].description, /margin of \d/);
});

test('CMDB-029: a value outside the inherited active choice list fires; an inactive (retired) choice does not', () => {
  const choices = [
    ...['1', '6', '7'].map((v) => ({ name: 'cmdb_ci', element: 'install_status', value: v, inactive: 'false' })),
    { name: 'cmdb_ci', element: 'install_status', value: '9', inactive: 'true' },
    { name: 'cmdb_ci', element: 'operational_status', value: '1', inactive: 'false' },
    { name: 'cmdb_ci', element: 'discovery_source', value: 'ServiceNow', inactive: 'false' },
  ];
  const { byRule } = run({ cmdb_ci: [
    ci('good', 'cmdb_ci_server'),
    ci('bad', 'cmdb_ci_server', { install_status: '42' }),
    ci('retired', 'cmdb_ci_server', { install_status: '9' }),
  ] }, { choices });
  assert.deepEqual(byRule('CMDB-029').map((x) => x.target_ids[0]), ['bad']);
});

test('CMDB-030 validates IP, MAC, FQDN and serial format — placeholders are left to completeness', () => {
  assert.equal(validFqdn('srv01.bank.internal'), true);
  assert.equal(validFqdn('srv01'), false);
  assert.equal(validSerial('SN-1001/A'), true);
  assert.equal(validSerial('??'), false);
  const { byRule } = run({ cmdb_ci: [
    ci('ok', 'cmdb_ci_server', { mac_address: '00:1A:2B:3C:4D:5E', fqdn: 'ok.bank.internal' }),
    ci('badip', 'cmdb_ci_server', { ip_address: '10.0.0.300' }),
    ci('badmac', 'cmdb_ci_server', { mac_address: 'zz:zz' }),
    ci('placeholder', 'cmdb_ci_server', { ip_address: '0.0.0.0' }),
  ] });
  assert.deepEqual(byRule('CMDB-030').map((x) => x.target_ids[0]).sort(), ['badip', 'badmac']);
});

test('CMDB-030 logs, on every run, that serial validation under-detects without a manufacturer pattern library', () => {
  const { skipped } = run({ cmdb_ci: [ci('ok', 'cmdb_ci_server')] });
  assert.match(skipped('CMDB-030')[0].reason, /under-detects malformed serials — no manufacturer pattern library/);
});

test('MATERIALITY SPLIT: a class-wide defect rate surfaces ONE pattern finding; every record keeps its base deduction', () => {
  /* 12 of 12 computers with an invalid serial: ≥ 20% and ≥ 10 → pattern. */
  const estate = { cmdb_ci: Array.from({ length: 12 }, (_, i) => ci(`pc${i}`, 'cmdb_ci_computer', { serial_number: '??', name: `pc-${i}` })) };
  const { r, byRule } = run(estate);
  const all = byRule('CMDB-030');
  const pattern = all.filter((x) => x.pattern);
  const records = all.filter((x) => !x.pattern);
  assert.equal(pattern.length, 1, 'not exactly one pattern finding for the class');
  assert.equal(records.length, 12);
  const base = CMDB_CATALOGUE['CMDB-030'].base;
  assert.equal(pattern[0].target_ids.length, 12);
  assert.deepEqual(pattern[0].modifiers.escalators, ['class_defect_rate']);
  assert.notEqual(pattern[0].severity, base, 'the pattern was not raised above the base band');
  for (const x of records) {
    assert.equal(x.deduction_severity, base, 'a record was charged for its class');
    assert.ok(!x.modifiers.escalators.includes('class_defect_rate'), 'a record carries the population escalator');
    assert.equal(x.pattern_fingerprint, pattern[0].fingerprint);
  }
  const q = scoreCmdbQuality({ findings: r.findings, kpis: r.kpis, inScope: { ids: estate.cmdb_ci.map((c) => c.sys_id), basis: 't' }, implemented: new Set(['CMDB-030']) });
  const d2 = q.dimensions.find((d) => d.key === 'D2');
  assert.ok(d2.record_part > 0, 'the class-wide pattern zeroed its records');
  assert.equal(q.escalated.filter((e) => e.rule_id === 'CMDB-030').length, 0);
  assert.deepEqual(q.patterns.filter((p) => p.rule_id === 'CMDB-030').map((p) => p.affected), [12]);
});

test('CMDB-031 flags impossible numbers on physical computers, never an empty value or a virtual machine', () => {
  const values = { a: { ram: '0', cpu_count: '4' }, b: { ram: '16384', cpu_count: '' }, vm: { ram: '0' } };
  const { byRule } = run({ cmdb_ci: [ci('a', 'cmdb_ci_computer'), ci('b', 'cmdb_ci_computer'), ci('vm', 'cmdb_ci_computer')] },
    { virtualIds: ['vm'], classAttrs: { cmdb_ci_computer: { applicable: ['ram', 'cpu_count'], returned: ['ram', 'cpu_count'], values } } });
  assert.deepEqual(byRule('CMDB-031').map((x) => x.target_ids[0]), ['a']);
});

test('CMDB-032 flags names off a dominant (≥ 60%) convention and suppresses classes with none', () => {
  assert.equal(nameShape('RTR-MUM-DC1-02'), 'A-A-A9-9');
  const dominant = Array.from({ length: 9 }, (_, i) => ci(`RTR-MUM-DC1-0${i}`, 'cmdb_ci_server'));
  const { byRule } = run({ cmdb_ci: [...dominant, ci('router1', 'cmdb_ci_server')] });
  assert.deepEqual(byRule('CMDB-032').map((x) => x.target_ids[0]), ['router1']);
  const mixed = run({ cmdb_ci: Array.from({ length: 10 }, (_, i) => ci(i % 2 ? `srv${i}` : `SRV-${i}-X`, 'cmdb_ci_server')) });
  assert.equal(mixed.byRule('CMDB-032').length, 0);
  assert.match(mixed.skipped('CMDB-032')[0].reason, /no single naming convention/);
});

test('every Group 3 rule scores in D2', () => {
  for (const id of ['CMDB-023', 'CMDB-024', 'CMDB-025', 'CMDB-026', 'CMDB-027', 'CMDB-028', 'CMDB-029', 'CMDB-030', 'CMDB-031', 'CMDB-032']) {
    assert.equal(CMDB_CATALOGUE[id].dimension, 'D2', id);
    assert.equal(CMDB_CATALOGUE[id].track, 'dimension', id);
  }
});
