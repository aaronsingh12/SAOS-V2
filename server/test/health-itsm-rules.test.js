import test from 'node:test';
import assert from 'node:assert/strict';
import { estateContext, ESTATE, ABSENT } from './helpers/itsm-estate.js';

/**
 * ITSM PHASE 4 — the connected rules, engine batch by engine batch.
 *
 * Every test runs catalogue rules through the RUNNER (declarative config →
 * engine), against the shared estate fixture or a deliberate variation of
 * it, and checks: the positive case fires on the offender only, the negative
 * case is silent, boundaries land where the workbook says, missing /
 * incomplete data is UNAVAILABLE (never PASS), the finding carries the
 * evidence the workbook asks for, and the slot ↔ rule identity is intact.
 */

const { runITSMRules } = await import('../src/health/itsm/runner.js');
const { getITSMRule, getITSMRuleBySlot, slotOf } = await import('../src/health/itsm/catalogue.js');
const { ITSM_RULE_CONFIGS } = await import('../src/health/itsm/rules/index.js');

const run = async (ids, overrides = {}, opts = {}) => {
  const ctx = estateContext(overrides, opts);
  const r = await runITSMRules(ctx, { ruleIds: ids });
  return { ctx, get: (id) => r.results.get(id), run: r };
};
const ids = (res) => (res.findings || []).flatMap((f) => f.target_ids).sort();
const withRow = (table, sys_id, patch) => ({ [table]: ESTATE[table].map((r) => (r.sys_id === sys_id ? { ...r, ...patch } : r)) });

/* ════════════════════════ slot identity ════════════════════════ */

test('SLOT IDENTITY: every configured rule id resolves to its catalogue slot and back; results carry the rule id, not a slot number', async () => {
  for (const id of ITSM_RULE_CONFIGS.keys()) {
    const slot = slotOf(id);
    assert.equal(getITSMRuleBySlot(slot).id, id);
    assert.equal(getITSMRule(id).slot, slot);
  }
  const { get } = await run(['ITSM-020']);
  assert.equal(get('ITSM-020').rule_id, 'ITSM-020');
  assert.equal(get('ITSM-020').findings[0].rule_id, 'ITSM-020');
  assert.equal(getITSMRule('ITSM-020').slot, 20);
});

/* ════════════════════════ record predicate ════════════════════════ */

test('RECORD PREDICATE batch: 020 length boundary, 036 seconds boundary, 042, 043 ($choice), 044 (same_as), 062, 067, 096–103, 108, 111 (tolerance), 119', async () => {
  const { get } = await run(['ITSM-020', 'ITSM-036', 'ITSM-042', 'ITSM-043', 'ITSM-044', 'ITSM-062', 'ITSM-067', 'ITSM-096', 'ITSM-097', 'ITSM-099', 'ITSM-100', 'ITSM-102', 'ITSM-103', 'ITSM-108', 'ITSM-111', 'ITSM-119']);
  assert.deepEqual(ids(get('ITSM-020')), ['inc-bad', 'inc-copy'], '"short" and "Email down" are under 20 characters');
  assert.deepEqual(get('ITSM-020').findings[0].detail.fields, ['number', 'close_code', 'assignment_group', 'resolved_at']);
  assert.deepEqual([get('ITSM-020').kpis[0].numerator, get('ITSM-020').kpis[0].denominator], [1, 3]);
  assert.deepEqual(ids(get('ITSM-036')), ['inc-bad'], 'closed 20 s after creation');
  assert.deepEqual(ids(get('ITSM-042')), ['inc-open']);
  assert.deepEqual(ids(get('ITSM-043')), ['inc-open'], 'on hold (value 3 from the instance choice list) with no hold reason');
  assert.deepEqual(ids(get('ITSM-044')), ['inc-bad'], 'caller resolved their own incident');
  assert.deepEqual(ids(get('ITSM-062')), ['prb-closed']);
  assert.deepEqual(ids(get('ITSM-067')), ['prb-closed']);
  for (const id of ['ITSM-096', 'ITSM-097', 'ITSM-099', 'ITSM-100', 'ITSM-102', 'ITSM-103', 'ITSM-119']) assert.deepEqual(ids(get(id)), ['chg-bad'], id);
  assert.deepEqual(get('ITSM-103').variants.map((v) => v.variant), ['close_code empty', 'close_notes empty'], 'the two cases are reported separately');
  assert.deepEqual(ids(get('ITSM-108')), ['chg-bad'], 'raised an hour after work started');
  assert.deepEqual(ids(get('ITSM-111')), ['chg-bad', 'chg-p1'], 'chg-bad started 2 h early; chg-p1 ended weeks late');
});

test('RECORD PREDICATE boundaries: exactly 20 characters is NOT short; exactly 60 s is NOT bulk closure; a change exactly 1 h early is inside the tolerance', async () => {
  const { get } = await run(['ITSM-020', 'ITSM-036', 'ITSM-111'], {
    ...withRow('incident', 'inc-bad', { close_notes: 'x'.repeat(20), closed_at: '2026-08-30 09:01:00' }),
    ...withRow('change_request', 'chg-bad', { work_start: '2026-08-01 09:00:00', start_date: '2026-08-01 10:00:00', work_end: '2026-08-01 13:00:00', end_date: '2026-08-01 12:00:00' }),
  });
  assert.deepEqual(ids(get('ITSM-020')), ['inc-copy']);
  assert.deepEqual(ids(get('ITSM-036')), []);
  assert.deepEqual(ids(get('ITSM-111')), ['chg-p1']);
});

test('RECORD PREDICATE missing data: a hidden field is UNAVAILABLE at the capability gate; a forbidden table is UNAVAILABLE; a rule with no offender is evaluated with a kpi and no finding', async () => {
  const hidden = await run(['ITSM-020'], { sys_dictionary: ESTATE.sys_dictionary.filter((d) => !(d.name === 'incident' && d.element === 'close_notes')) });
  assert.equal(hidden.get('ITSM-020').status, 'unavailable');
  assert.match(hidden.get('ITSM-020').skipped[0].reason, /capability (UNAVAILABLE|PARTIAL)/);
  assert.deepEqual(hidden.get('ITSM-020').blocker.fields, ['close_notes']);
  const forbidden = await run(['ITSM-062'], {}, { instance: { forbidden: ['problem'] } });
  assert.equal(forbidden.get('ITSM-062').status, 'unavailable');
  const clean = await run(['ITSM-062'], withRow('problem', 'prb-closed', { cause_notes: 'root cause' }));
  assert.equal(clean.get('ITSM-062').status, 'evaluated');
  assert.equal(clean.get('ITSM-062').findings.length, 0);
  assert.equal(clean.get('ITSM-062').kpis[0].pass_pct, 100);
});

/* ════════════════════════ aggregate ════════════════════════ */

test('AGGREGATE batch: 001 dominance, 016/094 no-reference share, 017 bare-CI share, 030 two-tier by group, 032 tail, 033 breach rate, 053 low ratio, 079 ($choice), 083, 107 escalation, 113 by dimension', async () => {
  const { get } = await run(['ITSM-001', 'ITSM-016', 'ITSM-017', 'ITSM-030', 'ITSM-032', 'ITSM-033', 'ITSM-053', 'ITSM-079', 'ITSM-083', 'ITSM-094', 'ITSM-107', 'ITSM-113']);
  assert.equal(get('ITSM-001').status, 'evaluated');
  assert.equal(get('ITSM-001').findings.length, 0, '2 of 4 in one band is 50%, under 70%');
  assert.equal(get('ITSM-016').findings.length, 0, '1 of 4 (25%) under 40%');
  assert.equal(get('ITSM-016').kpis[0].denominator, 4);
  assert.equal(get('ITSM-017').findings.length, 0, '2 bare-CI of 4 with either is 50%, not > 50%');
  const r30 = get('ITSM-030');
  assert.equal(r30.variants.length, 3);
  const estate30 = r30.findings.find((f) => Object.keys(f.detail.group).length === 0);
  assert.equal(estate30.detail.observed, 33.3, '1 reopened of 3 resolved');
  assert.equal(estate30.severity, 'CRITICAL', '33% is above the 15% escalation tier');
  assert.ok(r30.findings.some((f) => f.detail.group.assignment_group === 'g-empty'));
  assert.equal(get('ITSM-032').findings[0].detail.observed, 1, 'one resolved incident at or above 4 reassignments');
  assert.equal(get('ITSM-033').findings.find((f) => !Object.keys(f.detail.group).length).detail.observed, 50);
  assert.equal(get('ITSM-053').findings.length, 0, '3 problems / 4 incidents is not below 0.5%');
  assert.equal(get('ITSM-079').findings.find((f) => !Object.keys(f.detail.group).length).detail.observed, 50, '1 of 2 closed problems as cannot_reproduce (value from the instance)');
  assert.equal(get('ITSM-083').findings.length, 0);
  assert.equal(get('ITSM-094').findings.length, 0);
  const r107 = get('ITSM-107');
  assert.equal(r107.findings.find((f) => !Object.keys(f.detail.group).length).detail.observed, 33.3);
  assert.equal(r107.findings.find((f) => !Object.keys(f.detail.group).length).severity, 'CRITICAL', 'above the 25% escalation');
  assert.equal(get('ITSM-113').variants.length, 4);
  assert.equal(get('ITSM-113').findings.find((f) => !Object.keys(f.detail.group).length).detail.observed, 66.7, '2 of 3 closed successful');
});

test('AGGREGATE boundaries and guards: exactly at the threshold does not breach (gt); ITSM-024 is a declared SPECIFICATION GAP — UNCONFIGURED with or without thresholds, never a pass, nothing read; the joint_share measure it will use is empirical; a failed count is UNAVAILABLE', async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ ...ESTATE.incident[0], sys_id: `x${i}`, number: `X${i}`, priority: i < 7 ? '3' : '2', category: 'software', close_code: i < 8 ? 'Solved' : 'Other' }));
  const { ctx, get } = await run(['ITSM-001', 'ITSM-024'], { incident: many });
  assert.equal(get('ITSM-001').findings.length, 0, '70% in one band is not > 70%');
  const gap = get('ITSM-024');
  assert.equal(gap.status, 'unconfigured');
  assert.equal(gap.verdict, null);
  assert.equal(gap.blocker.kind, 'specification_gap');
  assert.match(gap.blocker.missing, /statistic behind "pairs occurring far outside the expected joint distribution"/);
  assert.match(gap.blocker.decision, /DECISIONS.md §2/);
  assert.equal(gap.findings.length, 0);
  assert.equal(ctx.reads.entries().filter((e) => e.req.table === 'incident' && /category/.test(JSON.stringify(e.req))).length, 0, 'the gap stops the rule before any category read');
  /* Supplying thresholds does NOT unblock it: the statistic itself is undecided, so no override can choose one. */
  const withValues = await run(['ITSM-024'], { incident: many }, { runtimeParameters: { 'ITSM-024': { minimum_volume_per_category: 5, anomaly_share: 25 } } });
  assert.equal(withValues.get('ITSM-024').status, 'unconfigured');
  assert.equal(withValues.get('ITSM-024').blocker.kind, 'specification_gap');
  /* The measure prepared for it (DECISION 2): observed shares within each category, small categories withheld, no reference model. */
  const AG = await import('../src/health/itsm/engines/aggregate.js');
  const groups = [{ group: { category: 'software', close_code: 'Solved' }, count: 8 }, { group: { category: 'software', close_code: 'Other' }, count: 2 }, { group: { category: 'tiny', close_code: 'Other' }, count: 1 }];
  const m = AG.computeMeasure(groups, { measure: 'joint_share', primary: 'category', secondary: 'close_code', minimum_group_volume: 5 });
  assert.deepEqual(m.pairs.map((x) => [x.category, x.close_code, x.share_within_primary]), [['software', 'Other', 20], ['software', 'Solved', 80]]);
  assert.equal(m.primaries_withheld, 1);
  assert.deepEqual(AG.EXPECTED_DISTRIBUTION, { method: 'empirical', reference: 'DECISIONS.md §2' });
  const failed = await run(['ITSM-016'], {}, { instance: { forbidden: ['incident'] } });
  assert.equal(failed.get('ITSM-016').status, 'unavailable');
});

test('AGGREGATE trend (041): fewer than the required windows claims nothing; a falling series over three runs fires', async () => {
  const one = await run(['ITSM-041']);
  assert.equal(one.get('ITSM-041').findings.length, 0);
  assert.match(one.get('ITSM-041').skipped[0].reason, /trend needs 3 windows, 1 recorded/);
  const key = 'ITSM-041:first_call_resolution_pct';
  const three = await run(['ITSM-041'], {}, { measureHistory: { [key]: [{ value: 90, at: '2026-07-01' }, { value: 80, at: '2026-08-01' }] } });
  assert.equal(three.get('ITSM-041').trend.direction, 'falling');
  assert.equal(three.get('ITSM-041').findings.length, 1);
  const flat = await run(['ITSM-041'], {}, { measureHistory: { [key]: [{ value: 0, at: '2026-07-01' }, { value: 0, at: '2026-08-01' }] } });
  assert.equal(flat.get('ITSM-041').trend.direction, 'flat', 'the estate resolves nothing at first call (0%), so a 0,0,0 series is flat');
  assert.equal(flat.get('ITSM-041').findings.length, 0);
});

/* ════════════════════════ reference integrity ════════════════════════ */

test('REFERENCE INTEGRITY batch: 018/101 empty groups on OPEN records, 019/095 retired or missing CI (value from the instance), 065 owner empty / inactive + empty group, 136 unknown service', async () => {
  const incident = ESTATE.incident.map((r) => (r.sys_id === 'inc-bad' ? { ...r, active: 'true', closed_at: '', resolved_at: '' } : r.sys_id === 'inc-copy' ? { ...r, business_service: 'svc-ghost', active: 'true' } : r));
  const { get } = await run(['ITSM-018', 'ITSM-019', 'ITSM-065', 'ITSM-095', 'ITSM-101', 'ITSM-136'], { incident, ...withRow('change_request', 'chg-bad', { active: 'true' }) });
  assert.deepEqual(ids(get('ITSM-018')), ['inc-bad'], 'the group whose only member is inactive');
  assert.deepEqual(ids(get('ITSM-101')), ['chg-bad']);
  assert.deepEqual(get('ITSM-019').findings.map((f) => [f.title.slice(-15), f.target_ids]), [['(invalid_state)', ['inc-bad']]]);
  assert.deepEqual(ids(get('ITSM-095')), ['chg-bad']);
  assert.deepEqual(get('ITSM-065').findings.map((f) => [f.title.replace(/.*\((\w+)\)$/, '$1'), f.target_ids]), [['inactive', ['prb-open']], ['inactive', ['prb-open']]], 'owner inactive, group empty');
  assert.deepEqual(ids(get('ITSM-136')), ['inc-copy']);
});

test('REFERENCE INTEGRITY missing data: a dangling CI is reported only from a COMPLETE target read; an unreadable target is UNAVAILABLE', async () => {
  const dangling = await run(['ITSM-019'], withRow('incident', 'inc-ok', { cmdb_ci: 'ci-ghost' }));
  assert.ok(dangling.get('ITSM-019').findings.some((f) => f.title.endsWith('(missing)') && f.target_ids.includes('inc-ok')));
  const forbidden = await run(['ITSM-019'], {}, { instance: { forbidden: ['cmdb_ci'] } });
  assert.equal(forbidden.get('ITSM-019').status, 'unavailable');
});

/* ════════════════════════ linkage ════════════════════════ */

test('LINKAGE batch: 039 P1 without problem (threshold), 057 ratio, 060 no incidents, 063 open incidents + no workaround, 064 no change, 069 closed with open incidents', async () => {
  const { get } = await run(['ITSM-039', 'ITSM-057', 'ITSM-060', 'ITSM-063', 'ITSM-064', 'ITSM-069'], withRow('incident', 'inc-copy', { active: 'true' }));
  assert.deepEqual(ids(get('ITSM-039')), ['inc-bad'], 'inc-open links to prb-open; inc-bad has no problem');
  assert.equal(get('ITSM-039').measures['ITSM-039:offending_share'].value, 50, 'inc-open links to a problem; inc-bad does not → 1 of 2');
  assert.equal(get('ITSM-057').kpis[0].denominator, 4);
  assert.deepEqual(ids(get('ITSM-060')), ['prb-ok']);
  assert.deepEqual(ids(get('ITSM-063')), ['prb-closed', 'prb-open'], 'both lack a workaround and have an open linked incident (inc-copy reopened for this test)');
  assert.deepEqual(ids(get('ITSM-064')), ['prb-closed'], 'closed, not a known error, no linked change');
  assert.deepEqual(ids(get('ITSM-069')), ['prb-closed'], 'closed problem with inc-copy still open');
});

test('LINKAGE threshold boundary and absence guard: 039 at exactly 30% does not fire; an incomplete target read is UNAVAILABLE (no "no links" claim)', async () => {
  const p1s = Array.from({ length: 10 }, (_, i) => ({ ...ESTATE.incident[0], sys_id: `p${i}`, priority: '1', problem_id: i < 7 ? 'prb-ok' : '' }));
  const at = await run(['ITSM-039'], { incident: p1s });
  assert.equal(at.get('ITSM-039').findings.length, 0, '30% is not > 30%');
  assert.equal(at.get('ITSM-039').measures['ITSM-039:offending_share'].value, 30);
  const forbidden = await run(['ITSM-060'], {}, { instance: { forbidden: ['incident'] } });
  assert.equal(forbidden.get('ITSM-060').status, 'unavailable');
});

/* ════════════════════════ configuration ════════════════════════ */

test('CONFIGURATION batch: 002 unused + dominant category, 003 band without SLA, 006 invalid pair, 009 unreachable state, 012 SLA without schedule, 014 unpopulated custom field, 085 absent schedules, 090 risk fields', async () => {
  const { get } = await run(['ITSM-002', 'ITSM-003', 'ITSM-006', 'ITSM-009', 'ITSM-012', 'ITSM-014', 'ITSM-085', 'ITSM-090']);
  const c2 = get('ITSM-002').findings[0];
  assert.deepEqual(c2.evidence.map((e) => [e.field_name, e.field_value]), [['unused_choice', 'facilities'], ['dominant_choice', 'software (75%)']]);
  assert.match(get('ITSM-003').findings[0].evidence[0].field_value, /^3 \(/, 'priority 3 has volume and no SLA start condition; priority 1 has one');
  assert.match(get('ITSM-006').findings[0].evidence[0].field_value, /software \/ bogus/);
  assert.deepEqual(get('ITSM-009').findings[0].evidence.map((e) => e.field_value), ['1', '9'], 'New and Custom Parked have zero records');
  assert.deepEqual(ids(get('ITSM-012')), ['sla-p1']);
  assert.deepEqual(get('ITSM-014').findings[0].evidence.map((e) => [e.field_name, e.field_value]), [['u_custom', '0% populated']]);
  assert.equal(get('ITSM-085').findings.length, 2, 'no blackout and no maintenance schedule');
  assert.ok(get('ITSM-085').findings.every((f) => f.detail.absent));
  assert.deepEqual(get('ITSM-090').findings[0].evidence.map((e) => e.field_name), ['impact'], 'impact is not mandatory and 66.7% populated (< 80%); risk is 100% populated');
});

test('CONFIGURATION guards: a defined blackout schedule silences 085; an empty choice list is UNAVAILABLE (not "nothing unused"); an unreadable usage side is UNAVAILABLE; 013 is UNCONFIGURED until the custom state set is given', async () => {
  const defined = await run(['ITSM-085'], { cmn_schedule_blackout: [{ sys_id: 'bo', name: 'Xmas', type: 'blackout', time_zone: 'UTC' }] });
  assert.equal(defined.get('ITSM-085').findings.length, 1, 'only maintenance is still absent');
  assert.equal(defined.get('ITSM-085').findings[0].detail.object, 'schedule');
  /* the blackout CLASS missing from the instance is UNAVAILABLE for that variant — never "no blackout windows" */
  const noClass = await run(['ITSM-085'], {}, { instance: { absent: [...ABSENT, 'cmn_schedule_blackout'] } });
  assert.deepEqual(noClass.get('ITSM-085').variants.map((v) => [v.variant, v.status]), [['blackout', 'unavailable'], ['maintenance', 'evaluated']]);
  assert.equal(noClass.get('ITSM-085').findings.length, 1);
  const empty = await run(['ITSM-002'], { sys_choice: ESTATE.sys_choice.filter((c) => c.element !== 'category') });
  assert.equal(empty.get('ITSM-002').status, 'unavailable');
  const noUsage = await run(['ITSM-002'], {}, { instance: { forbidden: ['incident'] } });
  assert.equal(noUsage.get('ITSM-002').status, 'unavailable');
  const r13 = await run(['ITSM-013']);
  assert.equal(r13.get('ITSM-013').status, 'unconfigured');
  const set13 = await run(['ITSM-013'], withRow('incident', 'inc-open', { state: '9' }), { runtimeParameters: { 'ITSM-013': { custom_state_values: ['9'] } } });
  assert.match(set13.get('ITSM-013').findings[0].evidence[0].field_value, /Custom Parked/);
});

/* ════════════════════════ audit history ════════════════════════ */

test('AUDIT batch: 026 no work notes, 056 never progressed, 061 no state change in the window, 072 backward transitions from the instance order, 120 rescheduled', async () => {
  const { get } = await run(['ITSM-026', 'ITSM-056', 'ITSM-061', 'ITSM-072', 'ITSM-120']);
  assert.deepEqual(ids(get('ITSM-026')), ['inc-bad', 'inc-copy']);
  assert.deepEqual(ids(get('ITSM-056')), ['prb-open']);
  assert.deepEqual(ids(get('ITSM-061')), ['prb-open']);
  assert.deepEqual(ids(get('ITSM-072')), ['prb-ok'], '103→102 and 102→101 are two backward moves');
  assert.deepEqual(get('ITSM-072').state_order.order, ['101', '102', '103', '107']);
  assert.deepEqual(ids(get('ITSM-120')), ['chg-bad'], 'start_date changed three times');
});

test('AUDIT boundaries and guards (DECISION 10): one backward move is under the default of 2; no state order → UNAVAILABLE; audit off → UNAVAILABLE; an incomplete journal count is UNAVAILABLE', async () => {
  const one = await run(['ITSM-072'], { sys_audit: ESTATE.sys_audit.filter((a) => a.sys_id !== 'au4') });
  assert.equal(one.get('ITSM-072').findings.length, 0);
  const noOrder = await run(['ITSM-072'], { sys_choice: ESTATE.sys_choice.filter((c) => !(c.name === 'problem' && c.element === 'state')) });
  assert.equal(noOrder.get('ITSM-072').status, 'unavailable');
  const off = await run(['ITSM-072'], { sys_dictionary: ESTATE.sys_dictionary.map((d) => (d.name === 'problem' && d.element === '' ? { ...d, audit: 'false' } : d)) });
  assert.equal(off.get('ITSM-072').status, 'unavailable');
  assert.match(off.get('ITSM-072').skipped[0].reason, /capability/);
  const noJournal = await run(['ITSM-026'], {}, { instance: { forbidden: ['sys_journal_field'] } });
  assert.equal(noJournal.get('ITSM-026').status, 'unavailable');
  assert.match(noJournal.get('ITSM-026').skipped[0].reason, /cannot be claimed/);
});

/* ════════════════════════ text analysis ════════════════════════ */

test('TEXT batch (DECISION 1): 021 copied resolution, 028 PAN with location-only evidence, 070 short / restated root cause, 075 root-cause clusters at 0.8; 023/040/054/058/104 stay UNCONFIGURED', async () => {
  const { get } = await run(['ITSM-021', 'ITSM-023', 'ITSM-028', 'ITSM-040', 'ITSM-054', 'ITSM-058', 'ITSM-070', 'ITSM-075', 'ITSM-104']);
  assert.deepEqual(ids(get('ITSM-021')), ['inc-copy']);
  assert.equal(get('ITSM-021').text.provider, 'tfidf_cosine');
  assert.deepEqual(ids(get('ITSM-028')), ['inc-bad']);
  assert.equal(JSON.stringify(get('ITSM-028').findings).includes('ABCDE1234F'), false, 'the matched identifier leaked');
  assert.deepEqual(get('ITSM-028').pattern_hits.by_pattern, { 'PAN (Indian permanent account number)': 1 });
  assert.deepEqual(ids(get('ITSM-070')), ['prb-closed'], 'empty root cause is under 40 characters');
  assert.deepEqual(ids(get('ITSM-075')), ['prb-ok', 'prb-open'], 'identical root-cause text clusters');
  for (const id of ['ITSM-023', 'ITSM-040', 'ITSM-054', 'ITSM-058', 'ITSM-104']) assert.equal(get(id).status, 'unconfigured', id);
});

test('TEXT with runtime thresholds: 054 clusters without a problem link, 058 ranks by resolution effort and caps at N, 023 frequency share; 077 consumes 054', async () => {
  const dup = Array.from({ length: 6 }, (_, i) => ({ ...ESTATE.incident[0], sys_id: `d${i}`, number: `D${i}`, short_description: i < 4 ? 'Printer offline on floor 2' : 'Laptop will not boot', problem_id: '', category: 'hardware', sys_created_on: `2026-08-0${i + 1} 00:00:00`, resolved_at: `2026-08-0${i + 1} 0${i + 1}:00:00` }));
  const { get } = await run(['ITSM-054', 'ITSM-058', 'ITSM-023', 'ITSM-077'], { incident: [...ESTATE.incident, ...dup] }, { runtimeParameters: { 'ITSM-054': { similarity: 0.9, cluster_volume: 3 }, 'ITSM-058': { similarity: 0.9 }, 'ITSM-023': { volume_share: 30 } } });
  assert.deepEqual(get('ITSM-054').clusters.map((c) => c.size), [4]);
  assert.deepEqual(ids(get('ITSM-054')), ['d0', 'd1', 'd2', 'd3']);
  assert.deepEqual(get('ITSM-058').clusters.map((c) => [c.size, c.effort_ms > 0]), [[2, true], [4, true]], 'ranked by summed resolution time (11 h before 10 h); the linked Email cluster is excluded');
  assert.equal(get('ITSM-023').frequency[0].count, 4);
  assert.equal(get('ITSM-077').status, 'evaluated', 'the composite runs once its input is configured');
  assert.equal(get('ITSM-077').kpis[0].denominator, 1);
});

/* ════════════════════════ relationship graph ════════════════════════ */

test('GRAPH batch (DECISION 11): 130 counts incidents on CIs with no edges against the 25% threshold reading only the referenced CIs; 105/126/131 stay UNCONFIGURED', async () => {
  const { ctx, get } = await run(['ITSM-130', 'ITSM-105', 'ITSM-126', 'ITSM-131']);
  assert.deepEqual(ids(get('ITSM-130')), ['inc-bad', 'inc-copy']);
  assert.equal(get('ITSM-130').measures['ITSM-130:offending_share'].value, 66.7);
  const relReads = ctx.reads.entries().filter((e) => e.req.table === 'cmdb_rel_ci');
  assert.ok(relReads.every((e) => /^(parent|child)IN/.test(e.req.query)), 'an unbounded cmdb_rel_ci read');
  assert.ok(relReads.every((e) => e.req.query.includes('ci-app') || e.req.query.includes('ci-retired') || e.req.query.includes('ci-lonely')));
  for (const id of ['ITSM-105', 'ITSM-126', 'ITSM-131']) assert.equal(get(id).status, 'unconfigured', id);
  const under = await run(['ITSM-130'], { incident: ESTATE.incident.map((i) => ({ ...i, cmdb_ci: i.sys_id === 'inc-bad' ? 'ci-retired' : 'ci-app' })) });
  assert.equal(under.get('ITSM-130').findings.length, 0, '1 of 4 = 25% is not > 25%');
  assert.equal(under.get('ITSM-130').measures['ITSM-130:offending_share'].value, 25);
  const noCi = await run(['ITSM-130'], { incident: ESTATE.incident.map((i) => ({ ...i, cmdb_ci: '' })) });
  assert.equal(noCi.ctx.client.calls.byTable.cmdb_rel_ci ?? 0, 0, 'no CI referenced → no CMDB read at all');
  const noRels = await run(['ITSM-130'], {}, { instance: { forbidden: ['cmdb_rel_ci'] } });
  assert.equal(noRels.get('ITSM-130').status, 'unavailable');
});

test('GRAPH with runtime parameters: 126 reaches a Business Critical service through the bounded graph and flags the change with no service reference', async () => {
  const { get } = await run(['ITSM-126'], withRow('change_request', 'chg-ok', { business_service: '', cmdb_ci: 'ci-db' }), { runtimeParameters: { 'ITSM-126': { depth: 3, critical_values: ['1 - most critical'] } } });
  assert.equal(get('ITSM-126').status, 'evaluated');
  assert.deepEqual(get('ITSM-126').findings.map((f) => [f.detail.source.sys_id, f.detail.target.sys_id, f.detail.depth]), [['chg-ok', 'svc-email', 2]]);
  assert.deepEqual(get('ITSM-126').findings[0].detail.path.map((p) => p.sys_id), ['ci-db', 'ci-app', 'svc-email']);
});

/* ════════════════════════ temporal correlation ════════════════════════ */

test('TEMPORAL batch: 123 change-before-P1 within 72 h on the same or dependent CI (depth 2, bounded graph) with 124/125 over its pairs; 112 blackout intersection from expanded schedules; 074 before/after with the elapsed guard', async () => {
  const p1 = withRow('incident', 'inc-bad', { cmdb_ci: 'ci-app', sys_created_on: '2026-08-30 09:00:00' });     // chg-p1 ended 08-29 12:00 on ci-db, which ci-app depends on → 21 h before
  const { get } = await run(['ITSM-123', 'ITSM-124', 'ITSM-125'], p1, { runtimeParameters: { 'ITSM-125': { occurrences: 1 } } });
  assert.deepEqual(ids(get('ITSM-123')), ['inc-bad']);
  assert.equal(get('ITSM-123').pairs[0].via_dependent, true);
  assert.equal(get('ITSM-123').findings[0].kind, 'cross_domain');
  assert.equal(get('ITSM-124').status, 'evaluated');
  assert.equal(get('ITSM-124').measures['ITSM-124:pairs_by_type'].distribution[0].value, 'normal');
  assert.deepEqual(ids(get('ITSM-125')), ['ci-db']);
  /* boundary: exactly 72 h is inside; 72 h + 1 s is outside */
  const at = await run(['ITSM-123'], withRow('incident', 'inc-bad', { cmdb_ci: 'ci-db', sys_created_on: '2026-09-01 12:00:00' }));
  assert.deepEqual(ids(at.get('ITSM-123')), ['inc-bad']);
  const past = await run(['ITSM-123'], withRow('incident', 'inc-bad', { cmdb_ci: 'ci-db', sys_created_on: '2026-09-01 12:00:01' }));
  assert.deepEqual(ids(past.get('ITSM-123')), []);
  /* 112: a blackout on the change's implementation day */
  const sched = { cmn_schedule_blackout: [{ sys_id: 'bo', name: 'Aug freeze', type: 'blackout', time_zone: 'UTC' }], cmn_schedule_span: [{ sys_id: 'sp', schedule: 'bo', start_date_time: '20260801T090000', end_date_time: '20260801T103000', repeat_type: '', all_day: 'false' }] };
  const bo = await run(['ITSM-112'], sched);
  assert.deepEqual(ids(bo.get('ITSM-112')), ['chg-bad', 'chg-ok', 'chg-p1'], 'all three implementation intervals cover 09:00–10:30 on 1 August');
  const clear = await run(['ITSM-112'], { ...sched, cmn_schedule_span: [{ ...sched.cmn_schedule_span[0], start_date_time: '20260801T140001Z', end_date_time: '20260801T150000Z' }] });
  assert.deepEqual(ids(clear.get('ITSM-112')), ['chg-p1'], 'a blackout one second after chg-bad ends touches only the long-running chg-p1');
  const monthly = await run(['ITSM-112'], { ...sched, cmn_schedule_span: [{ ...sched.cmn_schedule_span[0], repeat_type: 'monthly' }] });
  assert.equal(monthly.get('ITSM-112').status, 'unavailable', 'an unexpandable recurrence is never "no blackout"');
  const none = await run(['ITSM-112']);
  assert.equal(none.get('ITSM-112').status, 'unavailable');
  assert.match(none.get('ITSM-112').skipped[0].reason, /ITSM-085/);
  const noClass = await run(['ITSM-112'], sched, { instance: { absent: [...ABSENT, 'cmn_schedule_blackout'] } });
  assert.equal(noClass.get('ITSM-112').blocker.kind, 'undefined_table');
  /* 074: with a runtime decline threshold, a problem whose incidents did not decline after closure fires; a recent closure is not judged */
  const incs = [...ESTATE.incident, { ...ESTATE.incident[0], sys_id: 'b1', problem_id: 'prb-ok', sys_created_on: '2026-05-01 00:00:00' }, { ...ESTATE.incident[0], sys_id: 'a1', problem_id: 'prb-ok', sys_created_on: '2026-07-01 00:00:00' }];
  const ba = await run(['ITSM-074'], { incident: incs }, { runtimeParameters: { 'ITSM-074': { decline_threshold: 50 } } });
  assert.deepEqual(ids(ba.get('ITSM-074')), ['prb-ok'], '1 before, 1 after → no decline');
  const recent = await run(['ITSM-074'], { incident: incs, ...withRow('problem', 'prb-ok', { closed_at: '2026-09-01 00:00:00' }) }, { runtimeParameters: { 'ITSM-074': { decline_threshold: 50 } } });
  assert.equal(recent.get('ITSM-074').findings.length, 0);
  assert.match(recent.get('ITSM-074').skipped[0].reason, /not fully elapsed/);
});

/* ════════════════════════ composite ════════════════════════ */

test('COMPOSITE batch (DECISION 7): 134 fires for a group empty in two processes with confidence = min of inputs; 129 is UNCONFIGURED until the problem threshold exists; a blocked input blocks the consumer', async () => {
  const open = { ...withRow('incident', 'inc-bad', { active: 'true' }), ...withRow('change_request', 'chg-bad', { active: 'true' }) };
  const { get } = await run(['ITSM-134', 'ITSM-129'], open);
  assert.equal(get('ITSM-134').status, 'evaluated');
  assert.deepEqual(ids(get('ITSM-134')), ['g-empty']);
  assert.match(get('ITSM-134').findings[0].evidence.find((e) => e.field_name === 'processes').field_value, /ITSM-018, ITSM-065, ITSM-101/);
  assert.equal(get('ITSM-134').findings[0].confidence, 1);
  assert.equal(get('ITSM-129').status, 'unconfigured');
  const blocked = await run(['ITSM-134'], open, { instance: { forbidden: ['change_request'] } });
  assert.equal(blocked.get('ITSM-134').status, 'skipped');
  assert.match(blocked.get('ITSM-134').skipped[0].reason, /ITSM-101 was unavailable/);
});

test('UNAVAILABLE by declaration: every rule whose object is UNDEFINED answers UNAVAILABLE with the object and pipeline step named, reads nothing from task tables, and never produces a finding', async () => {
  const blocked = ['ITSM-004', 'ITSM-007', 'ITSM-010', 'ITSM-015', 'ITSM-045', 'ITSM-046', 'ITSM-047', 'ITSM-048', 'ITSM-049', 'ITSM-050', 'ITSM-051', 'ITSM-052', 'ITSM-055', 'ITSM-066', 'ITSM-076', 'ITSM-078', 'ITSM-081', 'ITSM-084', 'ITSM-086', 'ITSM-087', 'ITSM-089', 'ITSM-091', 'ITSM-092', 'ITSM-093', 'ITSM-110', 'ITSM-117', 'ITSM-118', 'ITSM-122', 'ITSM-138', 'ITSM-034', 'ITSM-035', 'ITSM-132', 'ITSM-137'];
  const { ctx, get } = await run(blocked);
  for (const id of blocked) {
    assert.equal(get(id).status, 'unavailable', id);
    assert.equal(get(id).findings.length, 0);
    assert.match(get(id).skipped[0].reason, /UNDEFINED|not usable on this instance/, id);
    assert.ok(['undefined_object', 'undefined_dependency'].includes(get(id).blocker.kind), `${id}: ${get(id).blocker.kind}`);
    assert.equal(get(id).verdict, null);
  }
  for (const t of ['incident', 'problem', 'change_request']) assert.equal(ctx.client.calls.byTable[t] ?? 0, 0, `${t} was read by a blocked rule`);
});

/* ════════════════════════ the remaining executable rules, with what they need supplied ════════════════════════ */

test('SUPPLIED GAPS: rules that are UNCONFIGURED or table-gated by default run once the instance supplies the value or the table — 008, 031, 038, 068, 071, 098, 106, 114, 115, 127, 128', async () => {
  const { platformMeta } = await import('./helpers/itsm-fake-instance.js');
  const extra = platformMeta({ tables: {
    problem_task: { fields: ['number', 'state', 'sys_created_on', 'assigned_to', 'problem', 'active'] },
    change_task: { fields: ['change_request', 'change_task_type', 'state'] },
    em_alert: { fields: ['cmdb_ci', 'sys_created_on', 'incident'] },
    u_freeze_schedule: { fields: ['name', 'type', 'time_zone'], superClass: 'cmn_schedule' },
  } });
  const tables = {
    sys_db_object: [...ESTATE.sys_db_object, ...extra.sys_db_object],
    sys_dictionary: [...ESTATE.sys_dictionary, ...extra.sys_dictionary],
    problem_task: [{ sys_id: 'pt-old', number: 'PTASK1', state: '1', active: 'true', sys_created_on: '2026-01-01 00:00:00', assigned_to: 'u1', problem: 'prb-open' }, { sys_id: 'pt-new', number: 'PTASK2', state: '1', active: 'true', sys_created_on: '2026-09-10 00:00:00', assigned_to: 'u1', problem: 'prb-open' }],
    change_task: [{ sys_id: 'ct1', change_request: 'chg-ok', change_task_type: 'backout', state: '3' }],
    em_alert: [{ sys_id: 'al1', cmdb_ci: 'ci-app', sys_created_on: '2026-09-10 08:50:00', incident: '' }],
    incident: ESTATE.incident.map((i) => (i.sys_id === 'inc-open' ? { ...i, cmdb_ci: 'ci-app' } : i)),
    problem: ESTATE.problem.map((p) => (p.sys_id === 'prb-closed' ? { ...p, cause_notes: 'A memory leak in the connection pool' } : p)),
    sys_audit: [...ESTATE.sys_audit, { sys_id: 'au-ci', tablename: 'cmdb_ci', documentkey: 'ci-lonely', 'documentkey.sys_class_name': 'cmdb_ci_server', fieldname: 'ip_address', oldvalue: 'a', newvalue: 'b', sys_created_on: '2026-08-15 10:00:00' }],
    u_freeze_schedule: [{ sys_id: 'fz', name: 'Freeze', type: 'freeze', time_zone: 'UTC' }],
    cmn_schedule_span: [{ sys_id: 'fzs', schedule: 'fz', start_date_time: '20260801T090000', end_date_time: '20260801T093000', repeat_type: '' }],
  };
  const runtimeParameters = {
    'ITSM-008': { generic_values: ['Other'] },
    'ITSM-031': { autoclose_closed_by: 'u1' },
    'ITSM-038': { manual_creation_query: 'contact_type=phone' },
    'ITSM-071': { root_cause_classification: [{ name: 'code fix', regex: 'leak' }] },
    'ITSM-098': { risk_bands: ['high'] },
    'ITSM-106': { object_classes: ['cmdb_ci_server'], correlation_window: 24 },
    'ITSM-114': { backout_task_type: 'backout' },
    'ITSM-115': { dependency_depth: 2 },
    'ITSM-127': { freeze_schedule_type: 'u_freeze_schedule' },
    'ITSM-128': { close_codes: ['Other'] },
  };
  const { get } = await run(['ITSM-008', 'ITSM-031', 'ITSM-038', 'ITSM-068', 'ITSM-071', 'ITSM-098', 'ITSM-106', 'ITSM-114', 'ITSM-115', 'ITSM-127', 'ITSM-128'], tables, { runtimeParameters, instance: { absent: ABSENT.filter((t) => !['problem_task', 'change_task', 'em_alert'].includes(t)) } });
  for (const id of ['ITSM-008', 'ITSM-031', 'ITSM-038', 'ITSM-068', 'ITSM-071', 'ITSM-098', 'ITSM-106', 'ITSM-114', 'ITSM-115', 'ITSM-127', 'ITSM-128']) assert.equal(get(id).status, 'evaluated', `${id}: ${get(id).skipped[0]?.reason}`);
  assert.equal(get('ITSM-008').findings[0].detail.observed, 33.3, '1 of 3 closures on the generic code (> 30%)');
  assert.equal(get('ITSM-031').findings[0].detail.observed, 100, 'every closure by the supplied auto-close user');
  assert.deepEqual(ids(get('ITSM-038')), ['inc-open'], 'a manual P1 ten minutes after an un-actioned alert on the same CI');
  assert.deepEqual(ids(get('ITSM-068')), ['pt-old'], 'the problem task older than 60 days');
  assert.deepEqual(ids(get('ITSM-071')), ['prb-closed'], 'closed, no linked change, root cause matches the supplied fix pattern');
  assert.deepEqual(ids(get('ITSM-098')), ['chg-bad'], 'high risk with an empty test plan');
  assert.deepEqual(get('ITSM-106').findings[0].target_ids, ['au-ci'], 'a CI modification with no approved change on that CI in the 24 h before');
  assert.deepEqual(ids(get('ITSM-114')), ['chg-bad'], 'unsuccessful with no backout task; chg-ok has one');
  assert.deepEqual(ids(get('ITSM-115')), ['chg-p1'], 'inc-ok on ci-app, which ci-db (chg-p1) relates to, 21 h after work_end');
  assert.equal(get('ITSM-115').pairs[0].via_dependent, true);
  assert.deepEqual(ids(get('ITSM-127')), ['chg-bad'], 'the only implementation covering 09:00–09:30 on 1 August');
  assert.deepEqual(ids(get('ITSM-128')), ['inc-bad'], 'close code in the supplied set, no linked change');
  /* Without the supplied values the same rules are UNCONFIGURED / UNAVAILABLE — nothing was invented to run them. */
  const bare = await run(['ITSM-008', 'ITSM-038', 'ITSM-068', 'ITSM-114', 'ITSM-127']);
  assert.equal(bare.get('ITSM-008').status, 'unconfigured');
  assert.equal(bare.get('ITSM-038').status, 'unavailable');
  assert.equal(bare.get('ITSM-068').status, 'unavailable');
  assert.equal(bare.get('ITSM-114').status, 'unavailable');
  assert.equal(bare.get('ITSM-127').status, 'unconfigured');
});
