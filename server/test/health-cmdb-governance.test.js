import test from 'node:test';
import assert from 'node:assert/strict';

import { CMDB_CATALOGUE, scoreCmdbQuality } from '../src/health/cmdb-quality.js';
import { EstateRules, IMPLEMENTED_CATALOGUE_RULES } from '../src/health/rules.js';
import { GOVERNANCE_RULES, cmdbGovernanceRules } from '../src/health/cmdb-governance.js';
import { buildSignals, intentMisTags } from '../src/health/cmdb-signals.js';

/*
 * Health Assist — Group 9 (Data Manager and attestation), Sep 2026.
 *
 * A POSTURE track, not a scored dimension. The thing these tests guard hardest
 * is that none of it reaches the composite: attestation measures whether anybody
 * ANSWERS for the data, which is a different question from whether the data is
 * right, and folding the two together would let good governance disguise bad
 * records.
 *
 * The second theme is that "not configured" and "not installed" are different
 * findings — an estate without the product has not neglected anything.
 */

const NOW = new Date('2026-09-16T06:00:00Z');
const ok = { status: 'ok' };
const TABLES = ['cmdb_ci', 'cmdb_class_info', 'cert_audit', 'cert_audit_result', 'cert_filter',
  'cert_follow_on_task', 'cmdb_data_management_policy', 'sys_archive', 'sys_archive_destroy',
  'sys_user_grmember', 'reconcile_duplicate_task'];
const full = (over = {}) => Object.fromEntries(TABLES.map((t) => [t,
  { table: t, status: 'complete', rows_complete: true, missing_fields: [], ...(over[t] || {}) }]));
const CLASSES = {
  cmdb: { super: null }, cmdb_ci: { super: 'cmdb' }, cmdb_ci_hardware: { super: 'cmdb_ci' },
  cmdb_ci_computer: { super: 'cmdb_ci_hardware' }, cmdb_ci_server: { super: 'cmdb_ci_computer' },
};

function run(estate, { coverage = full(), options = {}, policyExecutions = {} } = {}) {
  const r = new EstateRules({ cmdb_ci: [], ...estate }, coverage, 90, NOW, {
    meta: { cmdb: { reads: { class_hierarchy: ok }, classes: { byName: CLASSES }, virtualIds: [], usedFor: {}, choices: [], policyExecutions } },
  });
  r.signals = buildSignals(r);
  cmdbGovernanceRules(r, options);
  return {
    r,
    byRule: (id) => r.findings.filter((x) => x.rule_id === id && !x.pattern),
    reason: (id) => r.skipped.filter((s) => s.rule === id).map((s) => s.reason).join(' | '),
    kpi: (id) => r.kpis.find((k) => k.rule_id === id),
  };
}

const ci = (id, cls = 'cmdb_ci_server', over = {}) => ({
  sys_id: id, name: id, sys_class_name: cls, install_status: '1', operational_status: '1',
  sys_created_on: '2015-01-01 00:00:00', sys_updated_on: '2026-09-01 00:00:00', ...over,
});
const audit = (id, over = {}) => ({
  sys_id: id, name: id, active: 'true', table: 'cmdb_ci_server', audit_type: 'desired_state',
  last_run_date: '2026-09-01 00:00:00', sys_created_on: '2024-01-01 00:00:00', ...over,
});

/* ════════════════ the track, which is the whole point ════════════════ */

test('Group 9 is built, sits on the governance track, and NEVER reaches the composite', () => {
  for (const id of GOVERNANCE_RULES) {
    assert.ok(IMPLEMENTED_CATALOGUE_RULES.has(id), id);
    const rule = CMDB_CATALOGUE[id];
    assert.equal(rule.track, 'governance', `${id} must be governance-tracked`);
    assert.equal(rule.dimension, null, `${id} must have no scoring dimension`);
  }
  /* CMDB-091 is Systemic — and posture, so it surfaces without gating. */
  assert.equal(CMDB_CATALOGUE['CMDB-091'].base, 'SYSTEMIC');
  assert.equal(CMDB_CATALOGUE['CMDB-091'].systemicKind, 'posture');
});

test('governance findings are counted on their own track and deduct from no dimension', () => {
  const { r } = run({
    cmdb_ci: [ci('a'), ci('b')],
    cert_audit: [audit('x', { active: 'true', last_run_date: '', assign_to: '' })],
  });
  const q = scoreCmdbQuality({ findings: r.findings, kpis: r.kpis });
  assert.ok(r.findings.length, 'the fixture should have produced governance findings');
  assert.ok(q.tracks.governance > 0, 'governance findings must be counted on their track');
  for (const d of q.dimensions) {
    assert.equal(d.rules_built === 0 || (d.kpis || []).every((k) => !GOVERNANCE_RULES.includes(k.rule_id)), true,
      `${d.key} took a governance rule into its score`);
  }
  assert.equal(q.gate.blockers.some((b) => GOVERNANCE_RULES.includes(b.rule_id)), false,
    'a posture rule reached the trust gate');
});

/* ════════════ not configured is not the same as not installed ════════════ */

test('with no attestation product installed, the rules say so and blame nobody', () => {
  const { reason, byRule } = run({ cmdb_ci: [ci('a')] }, {
    coverage: full({
      cert_audit: { status: 'unavailable', rows_complete: false },
      cmdb_data_management_policy: { status: 'unavailable', rows_complete: false },
    }),
  });
  assert.equal(byRule('CMDB-092').length, 0);
  assert.match(reason('CMDB-092'), /not installed/);
  assert.match(reason('CMDB-092'), /product decision rather than a governance failure/);
});

test('with the product installed and nothing configured, CMDB-091 reports the coverage gap', () => {
  const { byRule, kpi, reason } = run({ cmdb_ci: [ci('a'), ci('b', 'cmdb_ci_computer')] });
  const k = kpi('CMDB-091');
  assert.deepEqual([k.numerator, k.denominator], [0, 2]);
  assert.match(k.alerts, /never inside it/);
  assert.equal(byRule('CMDB-091').length, 1);
  assert.match(reason('CMDB-092'), /capability EXISTS and nothing has been configured/);
});

/* ════════════════ the cycles themselves ════════════════ */

test('CMDB-092 catches a cycle that is scheduled and has never run — both mechanisms', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a')],
    cert_audit: [audit('never', { last_run_date: '' }), audit('ran')],
    cmdb_data_management_policy: [{ sys_id: 'p1', name: 'Archive stale CIs', table: 'cmdb_ci', policy_execution_job: 'job1', sys_created_on: '2024-01-01 00:00:00' }],
  });
  const names = byRule('CMDB-092').map((f) => f.description);
  assert.equal(names.length, 2, 'a certification audit and a Data Manager policy must both be judged');
  assert.ok(names.some((d) => /certification audit "never"/.test(d)));
  assert.ok(names.some((d) => /Data Manager policy "Archive stale CIs"/.test(d)));
});

test('CMDB-092 counts a policy execution from the meta read rather than re-deriving it', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a')],
    cmdb_data_management_policy: [{ sys_id: 'p1', name: 'Ran once', table: 'cmdb_ci', policy_execution_job: 'job1' }],
  }, { policyExecutions: { p1: 3 } });
  assert.equal(byRule('CMDB-092').length, 0, 'a policy with executions has run');
});

test('CMDB-092 does not chase a cycle configured last week', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a')],
    cert_audit: [audit('fresh', { last_run_date: '', sys_created_on: '2026-09-10 00:00:00' })],
  });
  const f = byRule('CMDB-092');
  assert.equal(f.length, 1, 'it is still reported');
  assert.equal(f[0].false_positive_guard.evaluated, false);
  assert.match(f[0].false_positive_guard.note, /may simply not be due yet/);
});

/* ════════════════ who is supposed to answer ════════════════ */

test('CMDB-094 finds a config with no attester at all; CMDB-093 one who cannot answer', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a')],
    cert_audit: [
      audit('nobody', { assign_to: '', assign_to_group: '' }),
      audit('inactive', { assign_to: 'u1', 'assign_to.active': 'false', 'assign_to.name': 'Jo Bloggs' }),
      audit('emptygroup', { assign_to: '', assign_to_group: 'g1', 'assign_to_group.name': 'CMDB Owners' }),
      audit('fine', { assign_to: 'u2', 'assign_to.active': 'true' }),
    ],
    sys_user_grmember: [{ sys_id: 'm1', group: 'g1', user: 'u3', 'user.active': 'false' }],
  });
  assert.equal(byRule('CMDB-094').length, 1);
  assert.match(byRule('CMDB-094')[0].description, /"nobody"/);
  const blocked = byRule('CMDB-093').map((f) => f.description);
  assert.equal(blocked.length, 2);
  assert.ok(blocked.some((d) => /Jo Bloggs\) is inactive/.test(d)));
  assert.ok(blocked.some((d) => /CMDB Owners\) has 1 member\(s\), none of them active/.test(d)));
});

/* ════════════════ what the cycles came back with ════════════════ */

test('CMDB-095 reports failed attestations as confirmed findings, not suspicions', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a'), ci('b')],
    cert_audit: [audit('Server Minimum Statistics')],
    cert_audit_result: [
      { sys_id: 'r1', audit: 'Server Minimum Statistics', state: 'Failed', configuration_item: 'a', column_name: 'RAM (MB)', sys_created_on: '2026-09-01 00:00:00' },
      { sys_id: 'r2', audit: 'Server Minimum Statistics', state: 'Failed', configuration_item: 'b', column_name: 'CPU count', sys_created_on: '2026-09-01 00:00:00' },
      { sys_id: 'r3', audit: 'Server Minimum Statistics', state: 'Certified', configuration_item: 'a', sys_created_on: '2026-09-01 00:00:00' },
    ],
  });
  const f = byRule('CMDB-095');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /2 attestation\(s\) came back FAILED against 1 certified/);
  assert.match(f[0].description, /RAM \(MB\), CPU count/);
  assert.equal(f[0].false_positive_guard.evaluated, true);
  assert.match(f[0].false_positive_guard.note, /attester's judgement IS the evidence/);
  assert.deepEqual(f[0].target_ids.sort(), ['a', 'b']);
});

test('CMDB-097 does not call an undated task overdue, and CMDB-099 ages it instead', () => {
  const task = (id, over = {}) => ({ sys_id: id, number: id, active: 'true', state: '1', cmdb_ci: 'a', sys_created_on: '2026-01-01 00:00:00', ...over });
  const { byRule, reason, r } = run({
    cmdb_ci: [ci('a')],
    cert_audit: [audit('x')],
    cert_follow_on_task: [task('t1'), task('t2'), task('t3', { sys_created_on: '2026-09-14 00:00:00' })],
  });
  assert.equal(byRule('CMDB-097').length, 0);
  assert.match(reason('CMDB-097'), /undated task is not an overdue one/);
  const ageing = byRule('CMDB-099');
  assert.equal(ageing.length, 1);
  assert.match(ageing[0].description, /2 data certification task\(s\) have been open for more than 60 days/);
  assert.match(ageing[0].description, /assigned to nobody at all/);
  assert.equal(r.measures.attestation_tasks.open, 3);
});

test('CMDB-097 fires on a task that IS dated and past due', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a')],
    cert_audit: [audit('x')],
    cert_follow_on_task: [{ sys_id: 't1', number: 't1', active: 'true', cmdb_ci: 'a', due_date: '2026-06-01 00:00:00', sys_created_on: '2026-05-01 00:00:00' }],
  });
  assert.equal(byRule('CMDB-097').length, 1);
  assert.match(byRule('CMDB-097')[0].description, /past their due date/);
});

test('CMDB-098 is a measure, never a threshold', () => {
  const { byRule, kpi, reason } = run({
    cmdb_ci: [ci('a')],
    cert_audit: [audit('x')],
    cert_follow_on_task: [{ sys_id: 't1', number: 't1', active: 'true', cmdb_ci: 'a', sys_created_on: '2026-09-14 00:00:00' }],
  });
  assert.equal(byRule('CMDB-098').length, 0, 'a measure must not raise a finding');
  assert.equal(kpi('CMDB-098').pass_pct, null);
  assert.match(reason('CMDB-098'), /recorded and not charged/);
});

/* ════════════════ retention and growth ════════════════ */

test('CMDB-101 reports an INACTIVE cmdb_ci archive rule as no policy at all', () => {
  const { byRule } = run({
    cmdb_ci: [ci('a')],
    sys_archive: [{ sys_id: 'ar1', name: 'Archive Configuration Items', table: 'cmdb_ci', active: 'false' }],
  });
  const f = byRule('CMDB-101');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /every one of them is switched off/);
  assert.match(f[0].description, /why CMDB-090 declines/);
  assert.match(f[0].evidence.map((e) => e.field_value).join(' '), /INACTIVE/);
});

test('CMDB-101 is satisfied by an active rule, and hands adherence to D8', () => {
  const { byRule, reason } = run({
    cmdb_ci: [ci('a')],
    sys_archive: [{ sys_id: 'ar1', name: 'Archive CIs', table: 'cmdb_ci', active: 'true' }],
  });
  assert.equal(byRule('CMDB-101').length, 0);
  assert.match(reason('CMDB-101'), /adherence is measured by CMDB-090 in D8/);
});

test('CMDB-096 ABSTAINS when no growth is observed — it never reports "no gap"', () => {
  const { byRule, reason, r } = run({ cmdb_ci: [ci('a'), ci('b')] });
  assert.equal(byRule('CMDB-096').length, 0);
  assert.match(reason('CMDB-096'), /NOT MEASURED/);
  assert.match(reason('CMDB-096'), /no growth was OBSERVED, which is not the same as no archival gap/);
  assert.match(reason('CMDB-096'), /it has not found that these classes are safe, only that it cannot yet tell/);
  /* The snapshot is still recorded, so a later run has a baseline to compare. */
  assert.ok(r.measures.class_growth.classes.length, 'no growth snapshot was recorded for the next run');
});

test('CMDB-096 fires on a genuinely growing class with no active rule', () => {
  const grown = Array.from({ length: 30 }, (_, i) => ci(`n${i}`, 'cmdb_ci_computer', { sys_created_on: '2026-06-01 00:00:00' }));
  const { byRule } = run({ cmdb_ci: [...grown, ci('old')] });
  const f = byRule('CMDB-096');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /cmdb_ci_computer grew by 30 CI\(s\) in the last year/);
  assert.match(f[0].description, /no active archival or deletion rule/);
});

test('CMDB-100 reports the backlog with its arrival and closure rates together', () => {
  const { byRule, r } = run({
    cmdb_ci: [ci('a')],
    reconcile_duplicate_task: [
      { sys_id: 'd1', number: 'DEDUP1', active: 'true', sys_created_on: '2026-09-01 00:00:00' },
      { sys_id: 'd2', number: 'DEDUP2', active: 'false', sys_created_on: '2024-01-01 00:00:00' },
    ],
  });
  const f = byRule('CMDB-100');
  assert.equal(f.length, 1);
  assert.match(f[0].description, /1 de-duplication task\(s\) are open, 1 of them raised in the last 90 days out of 2/);
  assert.equal(r.measures.dedup_backlog.open, 1);
});

/* ════════════════ the invariant that caught CMDB-101 ════════════════ */

test('the catalogue carries no rule whose dead-status subject is tagged quality', () => {
  const bad = intentMisTags(CMDB_CATALOGUE);
  assert.deepEqual(bad, [], `mis-tagged: ${bad.map((b) => `${b.rule_id} (${b.matched})`).join(', ')}`);
});
