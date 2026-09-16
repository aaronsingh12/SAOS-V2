import test from 'node:test';
import assert from 'node:assert/strict';

import { CMDB_CATALOGUE, scoreCmdbQuality } from '../src/health/cmdb-quality.js';
import { EstateRules, IMPLEMENTED_CATALOGUE_RULES } from '../src/health/rules.js';
import { UNIQUENESS_RULES, similarity, digitsOnlyDifference, normaliseName, cmdbUniquenessRules } from '../src/health/cmdb-uniqueness.js';
import { buildSignals } from '../src/health/cmdb-signals.js';
import { cmdbInScope } from '../src/health/cmdb-gate.js';

/*
 * Health Assist — Group 4 (Uniqueness, D3), built 18 Sep 2026.
 *
 *   - Exact identity sets (serial, IP, MAC, FQDN, correlation_id) → CMDB-035/036/037.
 *   - Sets sharing a member are one identity cluster: one charge per record (dedupe_key).
 *   - CMDB-033 asymmetric sets charge 5× and replace the symmetric charge.
 *   - CMDB-039 per discovery-source pair, no deduction.
 *   - Frequency guards: serial > 10 CIs = bad default; name > 5 CIs = generic.
 *   - CMDB-038 posture trend needs 3 snapshots; CMDB-043 is a measure, not a finding.
 */

const NOW = new Date('2026-09-18T06:00:00Z');
const ok = { status: 'ok' };
const TABLES = ['cmdb_ci', 'cmdb_rel_ci', 'cmdb_ci_service', 'svc_ci_assoc', 'cmdb_class_info', 'life_cycle_mapping', 'life_cycle_control',
  'reconcile_duplicate_task', 'duplicate_audit_result', 'cmdb_health_config'];
const full = () => Object.fromEntries(TABLES.map((t) => [t, { table: t, status: 'complete', rows_complete: true, missing_fields: [] }]));
const CLASSES = {
  /* cmdb_ci extends cmdb on a real instance — the branch test must survive that root. */
  cmdb: { super: null }, cmdb_ci: { super: 'cmdb' }, cmdb_ci_hardware: { super: 'cmdb_ci' }, cmdb_ci_computer: { super: 'cmdb_ci_hardware' },
  cmdb_ci_server: { super: 'cmdb_ci_computer' }, cmdb_ci_printer: { super: 'cmdb_ci_hardware' }, cmdb_ci_spkg: { super: 'cmdb_ci' },
  cmdb_ci_cluster: { super: 'cmdb_ci' },
};

function run(estate, { meta = {}, history = {} } = {}) {
  const r = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [], ...estate }, full(), 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok, used_for: ok, virtual: ok }, classes: { byName: CLASSES }, virtualIds: [], usedFor: {}, ...meta } },
    history,
  });
  const all = r.analyze();
  return {
    r,
    byRule: (id) => all.filter((x) => x.rule_id === id && !x.pattern),
    skipped: (id) => r.skipped.filter((s) => s.rule === id),
  };
}
let seq = 0;
const ci = (id, cls, fields = {}) => ({
  sys_id: id, name: id, sys_class_name: cls, install_status: '1', operational_status: '1',
  serial_number: `SN-${1000 + (seq += 1)}`, ip_address: '', mac_address: '', fqdn: '', correlation_id: '', discovery_source: '', ...fields,
});
const ids = (list) => list.map((x) => [...x.target_ids].sort());

/* ════════════════════════ the catalogue ════════════════════════ */

test('Group 4 is built and scores in D3, except the posture trend and the context count', () => {
  for (const id of UNIQUENESS_RULES) assert.ok(IMPLEMENTED_CATALOGUE_RULES.has(id), id);
  for (const id of ['CMDB-033', 'CMDB-034', 'CMDB-035', 'CMDB-036', 'CMDB-037', 'CMDB-039', 'CMDB-040', 'CMDB-041', 'CMDB-042']) {
    assert.deepEqual([CMDB_CATALOGUE[id].dimension, CMDB_CATALOGUE[id].track], ['D3', 'dimension'], id);
  }
  assert.equal(CMDB_CATALOGUE['CMDB-038'].track, 'posture');
  assert.equal(CMDB_CATALOGUE['CMDB-043'].kind, 'context');
});

test('helpers: Levenshtein ratio, digit-only sequences, name normalisation', () => {
  assert.equal(similarity('payroll-db', 'payroll-db'), 1);
  assert.ok(similarity('payroll-db-prod', 'payroll-db-prd') >= 0.85);
  assert.equal(digitsOnlyDifference('srv01', 'srv02'), true);
  assert.equal(digitsOnlyDifference('srv01', 'srv01a'), false);
  assert.equal(normaliseName('  SRV01.Bank.Internal '), 'srv01');
  assert.equal(normaliseName('MacBook  Pro 15"'), 'macbook pro 15"');
});

/* ════════════════════════ exact identity sets ════════════════════════ */

test('CMDB-035 fires on a shared valid serial; excludes placeholders, retired CIs and a bad default on more than 10 CIs', () => {
  const estate = { cmdb_ci: [
    ci('a', 'cmdb_ci_computer', { serial_number: 'X123' }), ci('b', 'cmdb_ci_computer', { serial_number: ' x123 ' }),
    ci('p1', 'cmdb_ci_computer', { serial_number: 'Unknown' }), ci('p2', 'cmdb_ci_computer', { serial_number: 'Unknown' }),
    ci('live', 'cmdb_ci_computer', { serial_number: 'OLD1' }), ci('retired', 'cmdb_ci_computer', { serial_number: 'OLD1', install_status: '7' }),
    ...Array.from({ length: 11 }, (_, i) => ci(`d${i}`, 'cmdb_ci_computer', { serial_number: 'L3BB911' })),
  ] };
  const { byRule, skipped } = run(estate);
  assert.deepEqual(ids(byRule('CMDB-035')), [['a', 'b']]);
  assert.equal(byRule('CMDB-035')[0].confidence, 0.97);
  assert.match(skipped('CMDB-035').map((s) => s.reason).join(' | '), /1 serial value\(s\) on more than 10 active CIs \(11 CIs\) treated as a bad default/);
});

test('CMDB-036 fires per address set; excludes loopback, link-local, 0.0.0.0, VIP classes and all-zero MACs', () => {
  const estate = { cmdb_ci: [
    ci('ip1', 'cmdb_ci_server', { ip_address: '10.1.1.5' }), ci('ip2', 'cmdb_ci_server', { ip_address: '10.1.1.5' }),
    ci('lo1', 'cmdb_ci_server', { ip_address: '127.0.0.1' }), ci('lo2', 'cmdb_ci_server', { ip_address: '127.0.0.1' }),
    ci('ll1', 'cmdb_ci_server', { ip_address: '169.254.3.3' }), ci('ll2', 'cmdb_ci_server', { ip_address: '169.254.3.3' }),
    ci('vip', 'cmdb_ci_cluster', { ip_address: '10.9.9.9' }), ci('node', 'cmdb_ci_server', { ip_address: '10.9.9.9' }),
    ci('m1', 'cmdb_ci_server', { mac_address: '00:1A:2B:3C:4D:5E' }), ci('m2', 'cmdb_ci_computer', { mac_address: '001a.2b3c.4d5e' }),
    ci('z1', 'cmdb_ci_server', { mac_address: '00:00:00:00:00:01' }), ci('z2', 'cmdb_ci_server', { mac_address: '00:00:00:00:00:00' }),
    ci('f1', 'cmdb_ci_server', { fqdn: 'pay.bank.internal.' }), ci('f2', 'cmdb_ci_server', { fqdn: 'PAY.bank.internal' }),
  ] };
  const { byRule, skipped } = run(estate);
  assert.deepEqual(ids(byRule('CMDB-036')).sort(), [['f1', 'f2'], ['ip1', 'ip2'], ['m1', 'm2']]);
  assert.match(skipped('CMDB-036').map((s) => s.reason).join(' | '), /cluster, load-balancer, NAT or VM-object/);
});

test('CMDB-037: a cross-source collision is REPORTED at reduced confidence, and skipped only for registered key spaces', () => {
  /* Decision 5 of 19 Sep: a correlation_id shared across two sources is usually
     the IRE merge this group hunts, so it is surfaced for review — silenced only
     where the estate has registered those sources as their own key spaces. */
  const estate = { cmdb_ci: [
    ci('c1', 'cmdb_ci_server', { correlation_id: 'EXT-1' }), ci('c2', 'cmdb_ci_server', { correlation_id: 'EXT-1' }),
    ci('k1', 'cmdb_ci_server', { correlation_id: 'EXT-2', discovery_source: 'SCCM' }), ci('k2', 'cmdb_ci_server', { correlation_id: 'EXT-2', discovery_source: 'Tanium' }),
  ] };
  const { byRule } = run(estate);
  assert.deepEqual(ids(byRule('CMDB-037')).sort(), [['c1', 'c2'], ['k1', 'k2']]);
  const cross = byRule('CMDB-037').find((f) => f.target_ids.includes('k1'));
  assert.equal(cross.confidence, 0.7, 'a cross-source collision was reported at full confidence');
  assert.match(cross.description, /come from different sources \(SCCM, Tanium\).*IRE merge that did not happen/);
  assert.equal(byRule('CMDB-037').find((f) => f.target_ids.includes('c1')).confidence, 0.98);

  /* Registered as independent key spaces → skipped, and said so. */
  const r = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [], ...estate }, full(), 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok }, classes: { byName: CLASSES } } },
  });
  r.signals = buildSignals(r);
  cmdbUniquenessRules(r, { independentKeySpaces: ['SCCM', 'Tanium'] });
  assert.deepEqual(ids(r.findings.filter((f) => f.rule_id === 'CMDB-037')), [['c1', 'c2']]);
  assert.match(r.skipped.find((x) => x.rule === 'CMDB-037' && /key spaces/.test(x.reason)).reason, /registered as independent key spaces/);
});

test('a field the API did not return skips only the rule that needs it', () => {
  const cov = full();
  cov.cmdb_ci = { ...cov.cmdb_ci, missing_fields: ['correlation_id'] };
  const r = new EstateRules({ cmdb_ci: [ci('a', 'cmdb_ci_server', { serial_number: 'SER-S1' }), ci('b', 'cmdb_ci_server', { serial_number: 'SER-S1' })], cmdb_rel_ci: [] }, cov, 90, NOW,
    { meta: { cmdb: { reads: { class_hierarchy: ok }, classes: { byName: CLASSES } } } });
  const all = r.analyze();
  assert.equal(all.filter((f) => f.rule_id === 'CMDB-035').length, 1);
  assert.match(r.skipped.find((s) => s.rule === 'CMDB-037').reason, /did not return correlation_id/);
  assert.match(r.skipped.find((s) => s.rule === 'CMDB-038').reason, /Not every identity attribute was read/);
});

/* ════════════════════════ clusters and charges ════════════════════════ */

test('ONE CLUSTER, ONE CHARGE: serial and IP findings on the same pair share a dedupe_key and cost the record 40, not 80', () => {
  const estate = { cmdb_ci: [
    ci('a', 'cmdb_ci_server', { serial_number: 'SER-S1', ip_address: '10.0.0.8' }), ci('b', 'cmdb_ci_server', { serial_number: 'SER-S1', ip_address: '10.0.0.8' }),
    ci('c', 'cmdb_ci_server'), ci('d', 'cmdb_ci_server'),
  ] };
  const { r, byRule } = run(estate);
  assert.equal(byRule('CMDB-035')[0].dedupe_key, byRule('CMDB-036')[0].dedupe_key);
  const q = scoreCmdbQuality({ findings: r.findings, inScope: cmdbInScope(r), implemented: IMPLEMENTED_CATALOGUE_RULES });
  const d3 = q.dimensions.find((d) => d.key === 'D3');
  assert.equal(d3.record_part, 80, 'a: 60 · b: 60 · c: 100 · d: 100');
});

test('CMDB-033 fires when one member is related and the other is not, at 5x — replacing the symmetric charge', () => {
  const estate = {
    cmdb_ci: [ci('rel', 'cmdb_ci_server', { serial_number: 'SER-S9' }), ci('bare', 'cmdb_ci_server', { serial_number: 'SER-S9' }),
      ci('app', 'cmdb_ci_spkg'), ci('x', 'cmdb_ci_server')],
    cmdb_rel_ci: [{ sys_id: 'r1', parent: 'app', child: 'rel' }],
  };
  const { r, byRule } = run(estate);
  const [x] = byRule('CMDB-033');
  assert.deepEqual([...x.target_ids].sort(), ['bare', 'rel']);
  /* Confirmed 19 Sep: the 5x is the DEFECT's charge and lands on the empty twin;
     the populated twin is the victim and pays an ordinary duplicate charge. */
  assert.deepEqual(x.deduction_multiplier_by_record, { bare: 5 });
  assert.equal(x.deduction_multiplier, undefined, 'the 5x was applied to every member of the set');
  assert.match(x.description, /\(1 relationship\(s\)\).*\(none\)/);
  assert.match(x.description, /bare record is charged 5x as the defect/);
  const q = scoreCmdbQuality({ findings: r.findings, inScope: cmdbInScope(r), implemented: IMPLEMENTED_CATALOGUE_RULES });
  /* bare: 40x5 → 0 · rel: Critical 40 → 60 · app, x: 100 → 65 */
  assert.equal(q.dimensions.find((d) => d.key === 'D3').record_part, 65, 'the 5x did not land on the bare twin alone');
});

test('CMDB-033 skips — never guesses — when relationships were not read completely', () => {
  const cov = full();
  cov.cmdb_rel_ci = { table: 'cmdb_rel_ci', status: 'truncated', rows_complete: false };
  const r = new EstateRules({ cmdb_ci: [ci('a', 'cmdb_ci_server', { serial_number: 'SER-S1' }), ci('b', 'cmdb_ci_server', { serial_number: 'SER-S1' })], cmdb_rel_ci: [] }, cov, 90, NOW,
    { meta: { cmdb: { reads: { class_hierarchy: ok }, classes: { byName: CLASSES } } } });
  r.analyze();
  assert.equal(r.findings.filter((f) => f.rule_id === 'CMDB-033').length, 0);
  assert.match(r.skipped.find((s) => s.rule === 'CMDB-033').reason, /cannot be told from "not read"/);
});

test('CMDB-039 reports per discovery-source pair, ranked, and deducts nothing', () => {
  const estate = { cmdb_ci: [
    ci('a1', 'cmdb_ci_server', { serial_number: 'SER-P1', discovery_source: 'ServiceNow' }), ci('a2', 'cmdb_ci_server', { serial_number: 'SER-P1', discovery_source: 'SCCM' }),
    ci('b1', 'cmdb_ci_server', { serial_number: 'SER-P2', discovery_source: 'ServiceNow' }), ci('b2', 'cmdb_ci_server', { serial_number: 'SER-P2', discovery_source: 'SCCM' }),
    ci('c1', 'cmdb_ci_server', { serial_number: 'SER-P3', discovery_source: 'ServiceNow' }), ci('c2', 'cmdb_ci_server', { serial_number: 'SER-P3', discovery_source: 'Tanium' }),
  ] };
  const { byRule } = run(estate);
  const list = byRule('CMDB-039');
  assert.equal(list.length, 2);
  assert.match(list[0].description, /^Rank 1 of 2: 2 duplicate set\(s\) where SCCM ⇄ ServiceNow/);
  assert.ok(list.every((f) => f.unscored_reason));
});

test('CMDB-041 needs a similar name AND an exact identity match, and never fires on a digit-only sequence', () => {
  const estate = { cmdb_ci: [
    ci('payroll-db-prod', 'cmdb_ci_server', { serial_number: 'SER-Q1' }), ci('payroll-db-prd', 'cmdb_ci_server', { serial_number: 'SER-Q1' }),
    ci('srv01', 'cmdb_ci_server', { serial_number: 'SER-Q2' }), ci('srv02', 'cmdb_ci_server', { serial_number: 'SER-Q2' }),
    ci('billing-app-01', 'cmdb_ci_server'), ci('billing-app-1', 'cmdb_ci_server'),
  ] };
  const { byRule } = run(estate);
  const list = byRule('CMDB-041');
  assert.deepEqual(ids(list), [['payroll-db-prd', 'payroll-db-prod']]);
  assert.ok(list[0].confidence < 0.97 && list[0].confidence > 0.8, 'confidence is not identity × similarity');
  assert.ok(list[0].evidence.some((e) => e.field_name === 'name_similarity'));
});

/* ════════════════════════ names ════════════════════════ */

test('CMDB-040 fires on a within-class name duplicate and treats a name on more than 5 CIs as generic', () => {
  const estate = { cmdb_ci: [
    ci('x1', 'cmdb_ci_computer', { name: 'FIN-LAPTOP-7' }), ci('x2', 'cmdb_ci_computer', { name: 'fin-laptop-7 ' }),
    ...Array.from({ length: 6 }, (_, i) => ci(`m${i}`, 'cmdb_ci_computer', { name: 'MacBook Pro 15"' })),
    ci('l1', 'cmdb_ci_computer', { name: 'localhost' }), ci('l2', 'cmdb_ci_computer', { name: 'localhost' }),
  ] };
  const { byRule, skipped } = run(estate);
  assert.deepEqual(ids(byRule('CMDB-040')), [['x1', 'x2']]);
  assert.match(skipped('CMDB-040')[0].reason, /1 name\(s\) on more than 5 active CIs of one class \(6 CIs\) treated as generic/);
});

test('CMDB-040 counts the generic guard within the class, and an empty install_status is active, not retired', () => {
  const estate = { cmdb_ci: [
    ...Array.from({ length: 3 }, (_, i) => ci(`pc${i}`, 'cmdb_ci_computer', { name: 'SoundMAX', install_status: i ? '1' : '' })),
    ...Array.from({ length: 3 }, (_, i) => ci(`sw${i}`, 'cmdb_ci_spkg', { name: 'SoundMAX' })),
  ] };
  const { byRule } = run(estate);
  assert.deepEqual(ids(byRule('CMDB-040')).sort(), [['pc0', 'pc1', 'pc2'], ['sw0', 'sw1', 'sw2']]);
  assert.equal(byRule('CMDB-034').length, 0, 'unrelated branches, and six across classes is generic');
});

test('CMDB-034 reports every cross-class name pair except an allowlisted one or directly related CIs; a cross-branch pair is reported at lower confidence', () => {
  const estate = {
    cmdb_ci: [
      ci('dup-a', 'cmdb_ci_computer', { name: 'HR-SRV-9' }), ci('dup-b', 'cmdb_ci_server', { name: 'hr-srv-9.bank.internal' }),
      ci('printer', 'cmdb_ci_printer', { name: 'Canon i960' }), ci('driver', 'cmdb_ci_spkg', { name: 'Canon i960' }),
      ci('p', 'cmdb_ci_computer', { name: 'EDGE-1' }), ci('q', 'cmdb_ci_server', { name: 'EDGE-1' }),
    ],
    cmdb_rel_ci: [{ sys_id: 'r', parent: 'p', child: 'q' }],
  };
  const { byRule, skipped } = run(estate);
  /* Decision 6 of 19 Sep: the printer/software-package pair is REPORTED — an
     event resolving that name by text can bind to either — just at lower
     confidence, with the branches named. */
  assert.deepEqual(ids(byRule('CMDB-034')).sort(), [['driver', 'printer'], ['dup-a', 'dup-b']]);
  const sameBranch = byRule('CMDB-034').find((f) => f.target_ids.includes('dup-a'));
  const crossBranch = byRule('CMDB-034').find((f) => f.target_ids.includes('printer'));
  assert.equal(sameBranch.confidence, 0.9);
  assert.equal(crossBranch.confidence, 0.75);
  assert.match(crossBranch.description, /unrelated branches \(cmdb_ci_spkg, cmdb_ci_hardware|cmdb_ci_hardware, cmdb_ci_spkg\)/);
  assert.match(skipped('CMDB-034').map((s) => s.reason).join(' | '), /1 same-name class pair\(s\) excluded as a permitted pair or as directly related CIs/);
  assert.match(skipped('CMDB-034').map((s) => s.reason).join(' | '), /reported at 0.75 confidence rather than suppressed/);

  /* An allowlisted pair is silent. */
  const r = new EstateRules({ cmdb_rel_ci: [], ...estate }, full(), 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok }, classes: { byName: CLASSES } } },
  });
  r.signals = buildSignals(r);
  cmdbUniquenessRules(r, { permittedClassPairs: ['cmdb_ci_printer|cmdb_ci_spkg'] });
  assert.deepEqual(ids(r.findings.filter((f) => f.rule_id === 'CMDB-034')), [['dup-a', 'dup-b']]);
});

test('the data-quality dimensions skip Retired, Stolen and Absent CIs, and keep the ones with no status at all', () => {
  /* Decision 7 of 19 Sep. The lifecycle dimension (CMDB-085/087) is what judges
     those statuses; uniqueness charging a retired CI for a shared serial is noise. */
  const estate = { cmdb_ci: [
    ci('live', 'cmdb_ci_server', { serial_number: 'DUP-1' }),
    ci('retired', 'cmdb_ci_server', { serial_number: 'DUP-1', install_status: '7' }),
    ci('stolen', 'cmdb_ci_server', { serial_number: 'DUP-2', install_status: '8' }),
    ci('absent', 'cmdb_ci_server', { serial_number: 'DUP-2', install_status: '100' }),
    ci('nostatus-a', 'cmdb_ci_server', { serial_number: 'DUP-3', install_status: '' }),
    ci('nostatus-b', 'cmdb_ci_server', { serial_number: 'DUP-3', install_status: '' }),
  ] };
  const { r, byRule, skipped } = run(estate);
  assert.deepEqual(ids(byRule('CMDB-035')), [['nostatus-a', 'nostatus-b']],
    'a retired/stolen/absent CI was judged for uniqueness, or a CI with no status was dropped');
  assert.match(skipped('CMDB-035').map((x) => x.reason).join(' | '), /3 retired, stolen or absent CI\(s\) are outside the data-quality dimensions/);
  assert.equal(r.measures.cis_without_install_status.count, 2, 'CIs with no install_status are not counted anywhere');
});

/* ════════════════════════ tasks, trend, measures ════════════════════════ */

test('CMDB-042 fires on an open de-dup task older than 90 days, charged to its CIs; CMDB-043 is a measure, not a finding', () => {
  const estate = {
    cmdb_ci: [ci('a', 'cmdb_ci_server'), ci('b', 'cmdb_ci_server')],
    reconcile_duplicate_task: [
      { sys_id: 't-old', number: 'DUP0001', active: 'true', opened_at: '2026-05-01 00:00:00', sys_created_on: '2026-05-01 00:00:00', duplicate_count: '2' },
      { sys_id: 't-new', number: 'DUP0002', active: 'true', opened_at: '2026-09-01 00:00:00', sys_created_on: '2026-09-01 00:00:00' },
      { sys_id: 't-closed', number: 'DUP0003', active: 'false', opened_at: '2025-01-01 00:00:00', sys_created_on: '2025-01-01 00:00:00' },
      { sys_id: 't-orphan', number: 'DUP0004', active: 'true', opened_at: '2026-01-01 00:00:00', sys_created_on: '2026-01-01 00:00:00' },
    ],
    duplicate_audit_result: [{ sys_id: 'd1', follow_on_task: 't-old', duplicate_ci: 'a' }, { sys_id: 'd2', follow_on_task: 't-old', duplicate_ci: 'b' }],
  };
  const { r, byRule } = run(estate);
  const list = byRule('CMDB-042');
  assert.equal(list.length, 2);
  const charged = list.find((f) => f.table === 'cmdb_ci');
  assert.deepEqual([...charged.target_ids].sort(), ['a', 'b']);
  assert.match(charged.description, /DUP0001 has been open 140 days/);
  const orphan = list.find((f) => f.table === 'reconcile_duplicate_task');
  assert.match(orphan.unscored_reason, /names no in-scope CI/);
  assert.equal(r.findings.filter((f) => f.rule_id === 'CMDB-043').length, 0);
  assert.equal(r.measures.open_dedup_tasks.count, 3);
});

test('CMDB-038 needs three snapshots; it fires on a sustained rise and not on a one-time burst', () => {
  const pair = (s) => [ci(`${s}-a`, 'cmdb_ci_server', { serial_number: s }), ci(`${s}-b`, 'cmdb_ci_server', { serial_number: s })];
  const estate = { cmdb_ci: [...pair('TR-01'), ...pair('TR-02'), ...pair('TR-03'), ...pair('TR-04')] };
  const first = run(estate);
  assert.match(first.skipped('CMDB-038')[0].reason, /Needs 3 snapshots of duplicate-set membership; 1 exist/);
  const now = first.r.measures.duplicate_sets;
  assert.equal(now.count, 4);

  const snap = (at, keys) => ({ at, count: keys.length, keys, complete: true });
  const rising = run(estate, { history: { duplicate_sets: [snap('2026-09-04T06:00:00Z', [now.keys[0]]), snap('2026-09-11T06:00:00Z', now.keys.slice(0, 2))] } });
  const [x] = rising.r.findings.filter((f) => f.rule_id === 'CMDB-038');
  assert.ok(x, 'a sustained rise did not fire');
  assert.equal(x.severity, 'SYSTEMIC');
  assert.equal(x.gate, false, 'a posture finding gates');
  assert.equal(x.posture, true);
  assert.match(x.description, /rose from 1 to 4 over 2\.0 week\(s\) across 3 snapshots/);

  const burst = run(estate, { history: { duplicate_sets: [snap('2026-09-04T06:00:00Z', [now.keys[0]]), snap('2026-09-11T06:00:00Z', now.keys)] } });
  assert.equal(burst.r.findings.filter((f) => f.rule_id === 'CMDB-038').length, 0, 'a one-time burst fired as a trend');
});
