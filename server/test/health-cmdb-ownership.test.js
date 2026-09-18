import test from 'node:test';
import assert from 'node:assert/strict';

import { CMDB_CATALOGUE } from '../src/health/cmdb-quality.js';
import { EstateRules, IMPLEMENTED_CATALOGUE_RULES } from '../src/health/rules.js';
import { OWNERSHIP_RULES, cmdbOwnershipRules } from '../src/health/cmdb-ownership.js';
import { buildSignals, intentOf } from '../src/health/cmdb-signals.js';

/*
 * Health Assist — Group 10 (Ownership, D9), Sep 2026.
 *
 * Back to a SCORED dimension after the posture group, so the active-status
 * filter returns: nobody needs to own a decommissioned server, and these tests
 * pin that retired CIs leave both the findings and the denominator.
 *
 * The other theme is that a filled-in field is not an owner. A support group
 * with no members, an owner who has left, an assignee who merely holds the
 * device — each of those reads as "owned" on a report and answers nobody.
 */

const NOW = new Date('2026-09-16T06:00:00Z');
const ok = { status: 'ok' };
const TABLES = ['cmdb_ci', 'cmdb_class_info', 'sys_user_grmember', 'cmdb_ci_service', 'svc_ci_assoc', 'cmdb_rel_ci'];
const full = (over = {}) => Object.fromEntries(TABLES.map((t) => [t,
  { table: t, status: 'complete', rows_complete: true, missing_fields: [], ...(over[t] || {}) }]));
const CLASSES = {
  cmdb: { super: null }, cmdb_ci: { super: 'cmdb' }, cmdb_ci_hardware: { super: 'cmdb_ci' },
  cmdb_ci_computer: { super: 'cmdb_ci_hardware' }, cmdb_ci_server: { super: 'cmdb_ci_computer' },
  cmdb_ci_service: { super: 'cmdb_ci' },
};

function run(estate, { coverage = full(), options = {} } = {}) {
  const r = new EstateRules({ cmdb_ci: [], ...estate }, coverage, 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok }, classes: { byName: CLASSES }, virtualIds: [], usedFor: {}, choices: [] } },
  });
  r.signals = buildSignals(r);
  cmdbOwnershipRules(r, options);
  return {
    r,
    byRule: (id) => r.findings.filter((x) => x.rule_id === id && !x.pattern),
    /* The estate-wide headline carries no records — per-record assertions skip it. */
    charged: (id) => r.findings.filter((x) => x.rule_id === id && !x.pattern && !x.unscored_reason),
    headline: (id) => r.findings.find((x) => x.rule_id === id && x.unscored_reason),
    reason: (id) => r.skipped.filter((s) => s.rule === id).map((s) => s.reason).join(' | '),
  };
}

const ci = (id, over = {}) => ({
  sys_id: id, name: id, sys_class_name: 'cmdb_ci_server', install_status: '1', operational_status: '1',
  sys_created_on: '2015-01-01 00:00:00', sys_updated_on: '2026-09-01 00:00:00', ...over,
});

/* ════════════════════════ the dimension ════════════════════════ */

test('Group 10 is built, scores in D9, and every rule is a quality rule', () => {
  for (const id of OWNERSHIP_RULES) {
    assert.ok(IMPLEMENTED_CATALOGUE_RULES.has(id), id);
    assert.equal(CMDB_CATALOGUE[id].dimension, 'D9', id);
    assert.equal(intentOf(id), 'quality', `${id} must exclude dead CIs from ownership charges`);
  }
  /* CMDB-104 is Systemic posture: it blocks remediation, it does not deduct. */
  assert.equal(CMDB_CATALOGUE['CMDB-104'].base, 'SYSTEMIC');
  assert.equal(CMDB_CATALOGUE['CMDB-104'].systemicKind, 'posture');
  assert.equal(CMDB_CATALOGUE['CMDB-104'].track, 'posture');
});

test('a retired CI is nobody\'s ownership defect — out of the findings AND the denominator', () => {
  const { charged, reason, r } = run({
    cmdb_ci: [ci('live'), ci('dead', { install_status: '7' }), ci('stolen', { install_status: '8' })],
  });
  assert.deepEqual(charged('CMDB-105').map((f) => f.target_ids[0]), ['live']);
  assert.equal(r.measures.ownership_coverage.in_scope, 1, 'dead CIs must leave the denominator too');
  assert.match(reason('CMDB-105'), /nobody needs to own a decommissioned server/);
});

/* ════════════ a filled-in field is not an owner ════════════ */

test('CMDB-102 resolves the group live: a group that exists with no active members owns nothing', () => {
  const { byRule } = run({
    cmdb_ci: [
      ci('a', { support_group: 'g_empty', 'support_group.name': 'Ghost Team' }),
      ci('b', { support_group: 'g_empty', 'support_group.name': 'Ghost Team' }),
      ci('c', { support_group: 'g_real', 'support_group.name': 'Real Team' }),
    ],
    sys_user_grmember: [
      { sys_id: 'm1', group: 'g_empty', user: 'u1', 'user.active': 'false' },
      { sys_id: 'm2', group: 'g_real', user: 'u2', 'user.active': 'true' },
    ],
  });
  const f = byRule('CMDB-102');
  assert.equal(f.length, 1, 'one finding per empty group, naming its CIs');
  assert.deepEqual(f[0].target_ids.sort(), ['a', 'b']);
  assert.match(f[0].description, /"Ghost Team" carries 2 CI\(s\) and has 1 member\(s\), none of them active/);
  assert.match(f[0].evidence.map((e) => e.reason).join(' '), /resolved at evaluation time, not from the group record/);
});

test('CMDB-103 catches an owner who has left, on every ownership field in use', () => {
  const { byRule, reason } = run({
    cmdb_ci: [
      ci('gone', { owned_by: 'u1', 'owned_by.active': 'false', 'owned_by.name': 'Jo Bloggs' }),
      ci('half', { owned_by: 'u2', 'owned_by.active': 'true', managed_by: 'u3', 'managed_by.active': 'false', 'managed_by.name': 'Sam Reed' }),
      ci('fine', { owned_by: 'u2', 'owned_by.active': 'true' }),
      ci('unknown', { owned_by: 'u9' }),
    ],
  });
  const ids = byRule('CMDB-103').map((f) => f.target_ids[0]).sort();
  assert.deepEqual(ids, ['gone', 'half'], 'a CI whose manager left is still half-unowned');
  assert.match(byRule('CMDB-103').find((f) => f.target_ids[0] === 'half').description, /Sam Reed on managed_by/);
  assert.match(reason('CMDB-103'), /unresolvable reference is not an inactive one/);
});

test('CMDB-105 counts an assignee as a RECOVERABLE SIGNAL, never as an owner', () => {
  const { charged, r } = run({
    cmdb_ci: [
      ci('bare'),
      ci('assigned', { assigned_to: 'u1', 'assigned_to.active': 'true' }),
      ci('owned', { owned_by: 'u2' }),
    ],
  });
  const ids = charged('CMDB-105').map((f) => f.target_ids[0]).sort();
  assert.deepEqual(ids, ['assigned', 'bare'], 'an assignee holds the device, not the record');
  const f = charged('CMDB-105').find((x) => x.target_ids[0] === 'assigned');
  assert.match(f.description, /a place to start rather than an owner/);
  assert.equal(r.measures.ownership_coverage.inferable_only, 1);
});

/* ════════════ class-level accountability ════════════ */

test('CMDB-104 ranks ownerless classes by the findings that have nobody to receive them', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a'), ci('b'), ci('c', { sys_class_name: 'cmdb_ci_computer' })],
    cmdb_class_info: [
      { sys_id: 'k1', class: 'cmdb_ci_server', principal_class: 'false' },
      { sys_id: 'k2', class: 'cmdb_ci_computer', principal_class: 'false', managed_by_group: 'g1', 'managed_by_group.name': 'Owners' },
    ],
  });
  const f = byRule('CMDB-104');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /1 of 2 class\(es\) have no data owner/);
  assert.match(f[0].description, /it makes the data unfixable/);
  assert.deepEqual(f[0].grouped_classes.map((x) => x.cls), ['cmdb_ci_server']);
});

/* ════════════ divergence and concentration ════════════ */

test('CMDB-106 reports the per-service ratio, and ignores CIs that have no owner at all', () => {
  const { byRule } = run({
    cmdb_ci: [
      ci('svc', { sys_class_name: 'cmdb_ci_service' }),
      ci('same', { owned_by: 'svcowner' }),
      ci('diff', { owned_by: 'someoneelse' }),
      ci('none'),
    ],
    cmdb_ci_service: [{ sys_id: 'svc', name: 'Payroll', owned_by: 'svcowner', 'owned_by.name': 'Service Owner' }],
    svc_ci_assoc: [
      { sys_id: 'a1', service: 'svc', ci: 'same' },
      { sys_id: 'a2', service: 'svc', ci: 'diff' },
      { sys_id: 'a3', service: 'svc', ci: 'none' },
    ],
  });
  const f = byRule('CMDB-106');
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].target_ids, ['diff'], 'an unowned CI is CMDB-105, not a divergence');
  assert.match(f[0].description, /1 of 3 CI\(s\) supporting "Payroll"/);
  assert.equal(f[0].confidence, 0.8, 'divergence is a signal, not proof');
});

test('CMDB-107 measures concentration against the WHOLE estate, not the owned subset', () => {
  /* One holder with 2 of 20 in-scope CIs: 30% of the owned set, 10% of the estate. */
  const owned = [ci('o1', { owned_by: 'boss', 'owned_by.name': 'The Boss' }), ci('o2', { owned_by: 'boss', 'owned_by.name': 'The Boss' })];
  const rest = Array.from({ length: 18 }, (_, i) => ci(`x${i}`));
  const { byRule, reason, r } = run({ cmdb_ci: [...owned, ...rest] });
  assert.equal(byRule('CMDB-107').length, 0, '10% of the estate is not concentration');
  assert.match(reason('CMDB-107'), /Measured against the WHOLE estate rather than the owned subset/);
  assert.match(reason('CMDB-107'), /the finding is absence, not concentration/);
  assert.equal(r.measures.ownership_distribution.top[0].estate_pct, 10);
});

test('CMDB-107 fires when one holder really does hold the estate', () => {
  const many = Array.from({ length: 10 }, (_, i) => ci(`o${i}`, { owned_by: 'boss', 'owned_by.name': 'The Boss' }));
  const { byRule } = run({ cmdb_ci: [...many, ci('other')] });
  const f = byRule('CMDB-107');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /The Boss holds 10 CI\(s\) on owned_by — 90.9% of the in-scope estate/);
  assert.match(f[0].evidence.map((e) => e.reason).join(' '), /the share of CIs that have any owner at all/);
});

/* ════════════ what it refuses to guess ════════════ */

test('CMDB-108 abstains without the audit log rather than inferring stable ownership', () => {
  const { byRule, reason } = run({ cmdb_ci: [ci('old', { owned_by: 'u1' })] });
  assert.equal(byRule('CMDB-108').length, 0);
  assert.match(reason('CMDB-108'), /NOT MEASURED/);
  assert.match(reason('CMDB-108'), /cannot be told from "we did not look at the history"/);
  assert.match(reason('CMDB-108'), /a guess with a percentage attached/);
});

test('CMDB-108 reports unchanged ownership as an unscored class pattern when the audit IS read', () => {
  const { byRule } = run({
    cmdb_ci: [ci('stuck', { owned_by: 'u1' }), ci('moved', { owned_by: 'u2' })],
    sys_audit: [{ sys_id: 'a1', documentkey: 'moved', fieldname: 'owned_by', sys_created_on: '2024-01-01 00:00:00' }],
  });
  const f = byRule('CMDB-108');
  assert.equal(f.length, 1);
  assert.ok(f[0].unscored_reason, 'the catalogue asks for a ratio per class, not a per-record charge');
  assert.deepEqual(f[0].grouped_classes, [{ cls: 'cmdb_ci_server', cis: 1 }]);
});

test('empty populations are reported as evaluated results, never as skips of convenience', () => {
  const { byRule, reason } = run({
    cmdb_ci: [ci('a', { owned_by: 'u1', 'owned_by.active': 'true', support_group: 'g1', 'support_group.name': 'Team' })],
    sys_user_grmember: [{ sys_id: 'm1', group: 'g1', user: 'u1', 'user.active': 'true' }],
    cmdb_class_info: [{ sys_id: 'k1', class: 'cmdb_ci_server', managed_by_group: 'g1' }],
  });
  for (const id of ['CMDB-102', 'CMDB-103', 'CMDB-104', 'CMDB-105']) assert.equal(byRule(id).length, 0, id);
  assert.match(reason('CMDB-102'), /at least one active member — evaluated, with nothing to report/);
  assert.match(reason('CMDB-103'), /evaluated over every in-scope CI, with nothing to report/);
  assert.match(reason('CMDB-104'), /has a class-level data owner — evaluated/);
  assert.match(reason('CMDB-105'), /evaluated, with nothing to report/);
});

test('every Group 10 rule refuses to run when the CIs were not read completely', () => {
  const { r } = run({ cmdb_ci: [ci('a')] }, { coverage: full({ cmdb_ci: { status: 'truncated', rows_complete: false } }) });
  assert.equal(r.findings.length, 0);
  for (const id of OWNERSHIP_RULES) assert.ok(r.skipped.some((s) => s.rule === id), `${id} ran anyway`);
});

/* ════════════ CONSEQUENCE SCOPING — both halves, or it is wrong ════════════ */

test('CMDB-105 scopes the CHARGE by consequence and suppresses nothing', () => {
  const { charged } = run({
    cmdb_ci: [
      ci('db', { sys_class_name: 'cmdb_ci_appl' }),
      ci('srv'),
      ci('laptop', { sys_class_name: 'cmdb_ci_computer' }),
      ci('printer', { sys_class_name: 'cmdb_ci_printer' }),
    ],
  });
  const band = (id) => charged('CMDB-105').find((f) => f.target_ids[0] === id);
  assert.equal(charged('CMDB-105').length, 4, 'every ownerless CI must still be reported');
  assert.equal(band('db').deduction_band_override, undefined, 'an application carries the full charge');
  assert.equal(band('srv').deduction_band_override, undefined, 'a host carries the full charge');
  assert.equal(band('laptop').deduction_band_override, 'LOW');
  assert.equal(band('printer').deduction_band_override, 'LOW');
  assert.match(band('laptop').deduction_note, /never suppressed/);
  assert.match(band('laptop').evidence.map((e) => e.reason).join(' '), /leaf device/);
});

test('CMDB-105 raises ONE zero-point headline so the scale is not hidden by the scoping', () => {
  const laptops = Array.from({ length: 9 }, (_, i) => ci(`l${i}`, { sys_class_name: 'cmdb_ci_computer' }));
  const { headline, charged, r } = run({ cmdb_ci: [...laptops, ci('owned', { owned_by: 'u1' })] });
  const h = headline('CMDB-105');
  assert.ok(h, 'the estate-wide fact must be raised as its own finding');
  assert.equal(h.target_ids.length, 0);
  assert.ok(h.unscored_reason, 'the headline must deduct nothing — its records are charged individually');
  assert.match(h.description, /9 of 10 in-scope CIs \(90%\) have no accountability reference/);
  assert.match(h.description, /charged at LOW/);
  assert.equal(charged('CMDB-105').length, 9, 'the headline must not replace the per-record findings');
  assert.equal(r.measures.ownership_coverage.consequence.reduced, 9);
});

test('above the self-disclosure share the headline names the fields it measured', () => {
  const many = Array.from({ length: 9 }, (_, i) => ci(`x${i}`));
  const { headline } = run({ cmdb_ci: [...many, ci('owned', { owned_by: 'u1' })] });
  const h = headline('CMDB-105');
  assert.match(h.description, /THE PARAMETER IS THE THING MOST LIKELY TO BE WRONG/);
  assert.match(h.description, /measured on owned_by, managed_by, support_group/);
  assert.match(h.description, /name that field and re-run/);
  assert.match(h.evidence.map((e) => e.reason).join(' '), /override it if accountability lives elsewhere/);
});

test('below the self-disclosure share the headline stays short', () => {
  const some = Array.from({ length: 4 }, (_, i) => ci(`x${i}`));
  const ownedMany = Array.from({ length: 6 }, (_, i) => ci(`o${i}`, { owned_by: 'u1' }));
  const { headline } = run({ cmdb_ci: [...some, ...ownedMany] });
  const h = headline('CMDB-105');
  assert.match(h.description, /4 of 10 in-scope CIs \(40%\)/);
  assert.equal(/THE PARAMETER IS THE THING MOST LIKELY TO BE WRONG/.test(h.description), false);
});

test('a CI supporting a Business Critical service carries the full charge whatever its class', () => {
  const { charged } = run({
    cmdb_ci: [ci('svc', { sys_class_name: 'cmdb_ci_service', busines_criticality: '1 - most critical' }), ci('laptop', { sys_class_name: 'cmdb_ci_computer' })],
    cmdb_ci_service: [{ sys_id: 'svc', name: 'Payroll', busines_criticality: '1 - most critical' }],
    cmdb_rel_ci: [{ sys_id: 'r1', parent: 'svc', child: 'laptop', type: 't', 'type.name': 'Depends on::Used by' }],
  });
  const laptop = charged('CMDB-105').find((f) => f.target_ids[0] === 'laptop');
  assert.ok(laptop, 'the laptop is still ownerless and still reported');
  assert.equal(laptop.deduction_band_override, undefined,
    'a leaf device that carries a Business Critical service is not a leaf for scoring purposes');
  assert.match(laptop.evidence.map((e) => e.reason).join(' '), /Business Critical service/);
});

test('CMDB-106 names the CAUSE of being unmeasurable, not the threshold', () => {
  const { reason } = run({ cmdb_ci: [ci('a'), ci('b'), ci('c')] });
  assert.match(reason('CMDB-106'), /CONSEQUENCE of ownership being absent rather than a threshold being strict/);
  assert.match(reason('CMDB-106'), /0% of in-scope CIs have any owner at all \(CMDB-105\)/);
  assert.match(reason('CMDB-106'), /Fix the absence first/);
});
