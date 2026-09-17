import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeInstance, platformMeta } from './helpers/itsm-fake-instance.js';
import { estateContext, ESTATE, ESTATE_META, ABSENT, NOW } from './helpers/itsm-estate.js';

/**
 * ITSM PHASE 4 CLOSURE — what the closure added or changed, proven:
 *
 *   - objects the DECISION 5 pipeline verified on the validation instance
 *     (priority matrix, assignment rules, notifications, CAB meetings,
 *     delegations, approval records, attached knowledge, the blackout /
 *     maintenance schedule classes) and the rules they made executable
 *   - the field gate: a detection field the instance lacks is UNAVAILABLE —
 *     the defect the real instance surfaced (a query on a missing field
 *     matches every row, which produced false FAILs)
 *   - ITSM-129: the three reference rates, the UNDEFINED problem threshold
 *   - composite confidence = min, at every level
 *   - the engine key: reuse on equal inputs, ITSM-only invalidation
 *   - schedules: instance timestamp format, month / leap / DST / window boundaries
 *   - ITSM-072 metadata caching
 *   - verdicts, blockers and explanations on every result
 */

const { runITSMRules, evaluateConfiguredRule } = await import('../src/health/itsm/runner.js');
const { ITSM_RULE_CONFIGS } = await import('../src/health/itsm/rules/index.js');
const { itsmEngineKey, explainKeyChange } = await import('../src/health/itsm/engine-key.js');
const { engineKeys } = await import('../src/health/incremental.js');
const CP = await import('../src/health/itsm/engines/composite.js');
const SCH = await import('../src/health/itsm/schedules.js');
const { createEvaluationContext } = await import('../src/health/itsm/context.js');
const { result: mkResult, STATUS } = await import('../src/health/itsm/engines/result.js');

const run = async (ids, overrides = {}, opts = {}) => {
  const ctx = estateContext(overrides, opts);
  const r = await runITSMRules(ctx, { ruleIds: ids });
  return { ctx, get: (id) => r.results.get(id), run: r };
};
const ids = (res) => (res.findings || []).flatMap((f) => f.target_ids).sort();
const withRow = (table, sys_id, patch) => ({ [table]: ESTATE[table].map((r) => (r.sys_id === sys_id ? { ...r, ...patch } : r)) });

/* ════════════════════════ verified objects → executable rules ════════════════════════ */

test('VERIFIED OBJECTS: 005 priority-matrix mismatch, 011 stale notification recipients, 029 routing fields referenced by an assignment rule, 080 standard-change usage, 082 no CAB meetings despite changes, 088 inactive delegate, 109 self-approval, 116 rubber stamp, 121 approver concentration, 139 retired attached article', async () => {
  const { get } = await run(['ITSM-005', 'ITSM-011', 'ITSM-029', 'ITSM-080', 'ITSM-082', 'ITSM-088', 'ITSM-109', 'ITSM-116', 'ITSM-121', 'ITSM-139']);
  for (const id of ['ITSM-005', 'ITSM-011', 'ITSM-029', 'ITSM-080', 'ITSM-082', 'ITSM-088', 'ITSM-109', 'ITSM-116', 'ITSM-121', 'ITSM-139']) assert.equal(get(id).status, 'evaluated', `${id}: ${get(id).skipped[0]?.reason}`);
  const m = get('ITSM-005');
  assert.match(m.findings[0].evidence[0].field_value, /impact=3, urgency=3 → priority=1 \(lookup says 5\) × 1/, 'inc-open carries P1 where the matrix says P5');
  assert.deepEqual([m.observed.records, m.observed.mismatched, m.observed.unverifiable], [4, 1, 0]);
  assert.deepEqual(ids(get('ITSM-011')), ['nt-bad']);
  assert.match(get('ITSM-011').findings[0].evidence[0].field_value, /1 inactive\/missing user\(s\), 1 empty group\(s\)/);
  assert.match(get('ITSM-029').findings[0].evidence[0].field_value, /1 incident record\(s\) with empty location; referenced by Route network by location/);
  assert.equal(get('ITSM-029').observed.department.rules_referencing, 0, 'no rule references department → nothing reported for it');
  assert.equal(get('ITSM-080').findings[0].detail.observed, 0, '0 of 3 changes are standard, under 20%');
  assert.equal(get('ITSM-082').findings[0].detail.absent, true);
  assert.equal(get('ITSM-082').findings[0].detail.observed.change_request_in_window, 3);
  assert.deepEqual(ids(get('ITSM-088')), ['dg-open'], 'the open-ended delegation to an inactive user; the expired one is not active');
  assert.deepEqual(ids(get('ITSM-109')), ['chg-bad'], 'requested and approved by u2');
  assert.deepEqual(ids(get('ITSM-116')), ['chg-bad'], 'approved 60 s after being requested');
  assert.equal(get('ITSM-121').findings[0].detail.observed, 66.7, 'u2 holds 2 of 3 approvals');
  assert.deepEqual(ids(get('ITSM-139')), ['kt-retired']);
});

test('VERIFIED OBJECTS negative and unavailable: a CAB meeting in the window silences 082; no delegation → 088 passes; an absent matrix / notification table is UNAVAILABLE at table_discovery, an approval table lacking a field at schema_verification', async () => {
  const cab = await run(['ITSM-082'], { cab_meeting: [{ sys_id: 'cab1', start: '2026-09-01 10:00:00', end: '2026-09-01 11:00:00', state: 'complete' }] });
  assert.equal(cab.get('ITSM-082').findings.length, 0);
  assert.equal(cab.get('ITSM-082').verdict, 'inconclusive', 'the CAB-configuration half is a declared detection gap, so no finding is not a pass');
  const noDelegation = await run(['ITSM-088'], { sys_user_delegate: [] });
  assert.deepEqual([noDelegation.get('ITSM-088').status, noDelegation.get('ITSM-088').verdict], ['evaluated', 'pass']);
  const gone = ['dl_u_priority', 'sysevent_email_action', 'sysapproval_approver'];
  const absent = await run(['ITSM-005', 'ITSM-011', 'ITSM-121'], { sys_db_object: ESTATE.sys_db_object.filter((o) => !gone.includes(o.name)) }, { instance: { absent: [...ABSENT, ...gone] } });
  for (const id of ['ITSM-005', 'ITSM-011', 'ITSM-121']) {
    assert.equal(absent.get(id).status, 'unavailable', id);
    assert.equal(absent.get(id).findings.length, 0);
    assert.match(absent.get(id).skipped[0].reason, /table_discovery/, id);
  }
  const short = await run(['ITSM-109'], { sys_dictionary: ESTATE.sys_dictionary.filter((d) => !(d.name === 'sysapproval_approver' && d.element === 'approver')) });
  assert.equal(short.get('ITSM-109').status, 'unavailable');
  assert.equal(short.get('ITSM-109').blocker.kind, 'undefined_table');
  assert.equal(short.get('ITSM-109').blocker.step, 'schema_verification');
});

/* ════════════════════════ the field gate (the defect the instance surfaced) ════════════════════════ */

test('FIELD GATE: a detection field the instance lacks makes the rule UNAVAILABLE (capability) with the field named — never a run over a query that matches everything', async () => {
  const noProblemId = { sys_dictionary: ESTATE.sys_dictionary.filter((d) => !(d.name === 'incident' && d.element === 'problem_id')) };
  const { get } = await run(['ITSM-039', 'ITSM-057', 'ITSM-060', 'ITSM-063', 'ITSM-069'], noProblemId);
  for (const id of ['ITSM-039', 'ITSM-057', 'ITSM-060', 'ITSM-063', 'ITSM-069']) {
    assert.equal(get(id).status, 'unavailable', id);
    assert.equal(get(id).findings.length, 0, `${id} produced findings over a missing link field`);
    assert.equal(get(id).blocker.kind, 'capability');
    assert.deepEqual(get(id).blocker.fields, ['problem_id'], id);
  }
  /* a scope clause on a missing field is caught the same way (the query would silently match every row) */
  const noResolvedAt = { sys_dictionary: ESTATE.sys_dictionary.filter((d) => !(d.name === 'incident' && d.element === 'resolved_at')) };
  const scoped = await run(['ITSM-020'], noResolvedAt);
  assert.equal(scoped.get('ITSM-020').status, 'unavailable');
  assert.deepEqual(scoped.get('ITSM-020').blocker.fields, ['resolved_at']);
  /* a missing EVIDENCE field does not block; it is recorded */
  const noNumber = { sys_dictionary: ESTATE.sys_dictionary.filter((d) => !(d.name === 'incident' && d.element === 'number')) };
  const ev = await run(['ITSM-020'], noNumber);
  assert.equal(ev.get('ITSM-020').status, 'evaluated');
  assert.deepEqual(ev.get('ITSM-020').evidence_missing, ['incident.number']);
});

/* ════════════════════════ ITSM-129 ════════════════════════ */

test('ITSM-129: the three reference rates are 016, 094 and 067; UNCONFIGURED until the UNDEFINED problem threshold is set; then fires only when ALL three breach; a blocked input blocks it', async () => {
  const base = await run(['ITSM-129']);
  assert.equal(base.get('ITSM-129').status, 'unconfigured');
  assert.deepEqual(base.get('ITSM-129').blocker.parameters, ['problem_reference_threshold']);
  assert.ok(base.run.order.includes('ITSM-067') && base.run.order.includes('ITSM-016') && base.run.order.includes('ITSM-094'));
  /* incidents 1 of 4 unreferenced (25% < 40) → 016 does not breach; problems 1 of 3 (33.3%) → breaches a 30% threshold; changes 1 of 3 (33.3% > 30) → 094 breaches */
  const changes = withRow('change_request', 'chg-bad', { cmdb_ci: '', business_service: '' });
  const one = await run(['ITSM-129'], changes, { runtimeParameters: { 'ITSM-129': { problem_reference_threshold: 30 } } });
  assert.equal(one.get('ITSM-129').status, 'evaluated');
  assert.equal(one.get('ITSM-129').findings.length, 0, '016 does not breach → not all three');
  assert.equal(one.get('ITSM-129').measures['ITSM-129:breaching_inputs'].value, 2);
  const incidents = ESTATE.incident.map((i) => (i.sys_id === 'inc-ok' ? { ...i, cmdb_ci: '', business_service: '' } : i));   // now 2 of 4 = 50% > 40
  const all = await run(['ITSM-129'], { incident: incidents, ...changes }, { runtimeParameters: { 'ITSM-129': { problem_reference_threshold: 30 } } });
  assert.equal(all.get('ITSM-129').findings.length, 1);
  assert.match(all.get('ITSM-129').findings[0].detail.basis, /ITSM-016 \(50%\), ITSM-094 \(33.3%\), ITSM-067 \(33.3% gt 30\)/);
  assert.equal(all.get('ITSM-129').findings[0].severity, 'SYSTEMIC');
  const atThreshold = await run(['ITSM-129'], { incident: incidents, ...changes }, { runtimeParameters: { 'ITSM-129': { problem_reference_threshold: 33.3 } } });
  assert.equal(atThreshold.get('ITSM-129').findings.length, 0, '33.3 is not > 33.3');
  const blocked = await run(['ITSM-129'], { incident: incidents, ...changes }, { runtimeParameters: { 'ITSM-129': { problem_reference_threshold: 30 } }, instance: { forbidden: ['problem'] } });
  assert.equal(blocked.get('ITSM-129').status, 'skipped');
  assert.equal(blocked.get('ITSM-129').blocker.kind, 'input');
  assert.match(blocked.get('ITSM-129').skipped[0].reason, /ITSM-067 was unavailable/);
});

/* ════════════════════════ DECISION 7 — composite confidence ════════════════════════ */

test('COMPOSITE CONFIDENCE (DECISION 7): min over own and every input finding — all high → high, one low → that low, two levels deep; an unavailable or missing dependency blocks the consumer', async () => {
  assert.equal(CP.propagateConfidence(1, [{ confidence: 1 }, { confidence: 0.95 }]), 0.95);
  assert.equal(CP.propagateConfidence(0.9, [{ confidence: 1 }, { confidence: 1 }]), 0.9, 'own confidence caps it');
  assert.equal(CP.propagateConfidence(1, [{ confidence: 1 }, { confidence: 0.4 }, { confidence: 0.99 }]), 0.4, 'the single low input wins — never an average');
  assert.equal(CP.propagateConfidence(1, []), 1);
  /* through the engine, two levels: A → B → C, findings carry confidence */
  const ctx = createEvaluationContext({ client: fakeInstance({}), now: NOW });
  const rule = (id, deps, conf) => ({ id, dependsOn: deps, conf });
  const rules = [rule('A', [], 0.6), rule('B', ['A'], 1), rule('C', ['B'], 1)];
  const evaluateOne = async (r, inputs) => {
    const out = mkResult({ id: r.id }, 'composite');
    const inputConf = CP.propagateConfidence(r.conf, Object.values(inputs).flatMap((x) => x.findings));
    out.findings = [{ rule_id: r.id, confidence: inputConf }];
    return out;
  };
  const { results } = await CP.runOrdered(rules, ctx, evaluateOne);
  assert.deepEqual([results.get('A').findings[0].confidence, results.get('B').findings[0].confidence, results.get('C').findings[0].confidence], [0.6, 0.6, 0.6], 'the 0.6 at the root reaches the leaf unchanged');
  /* an unavailable input → the consumer is skipped with an input blocker; a missing (unconfigured) input → not_configured */
  const ctx2 = createEvaluationContext({ client: fakeInstance({}), now: NOW });
  const failing = async (r, inputs) => { if (r.id === 'A') { const o = mkResult({ id: 'A' }, 'composite'); o.status = STATUS.UNAVAILABLE; o.skipped.push({ rule: 'A', reason: 'x' }); return o; } return evaluateOne(r, inputs); };
  const r2 = await CP.runOrdered(rules, ctx2, failing);
  assert.equal(r2.results.get('B').status, 'skipped');
  assert.match(r2.results.get('B').skipped[0].reason, /input A was unavailable/);
  assert.equal(r2.results.get('C').status, 'skipped', 'the block propagates a level down');
  const estate = await run(['ITSM-134']);
  assert.equal(estate.get('ITSM-134').status, 'evaluated');
  const missing = estateContext();
  const configs = new Map(ITSM_RULE_CONFIGS); configs.delete('ITSM-018');
  const r3 = await runITSMRules(missing, { ruleIds: ['ITSM-134'], configs });
  assert.equal(r3.results.get('ITSM-134').status, 'not_configured');
  assert.deepEqual(r3.results.get('ITSM-134').blocker, { kind: 'input', missing: ['ITSM-018'], reason: 'input ITSM-018 has no rule configuration' });
});

/* ════════════════════════ DECISION 8 — engine key ════════════════════════ */

test('ENGINE KEY (DECISION 8): equal inputs → the same key (reuse); a dependency change invalidates; accepting a CMDB finding or changing nothing ITSM-relevant leaves the ITSM key alone', () => {
  const a = itsmEngineKey(); const b = itsmEngineKey();
  assert.equal(a.key, b.key);
  assert.deepEqual(explainKeyChange(a, b), []);
  const configs = new Map(ITSM_RULE_CONFIGS);
  const c129 = configs.get('ITSM-129');
  configs.set('ITSM-129', { ...c129, config: { ...c129.config, inputs: ['ITSM-016', 'ITSM-094'] } });
  const dep = itsmEngineKey({ configs });
  assert.deepEqual(explainKeyChange(a, dep).sort(), ['configuration changed', 'dependencies changed']);
  const plain = engineKeys({ staleDays: 90 });
  const cmdbAccepted = engineKeys({ staleDays: 90, acceptedRules: [{ ruleId: 'CMDB-015', fingerprint: 'fp1' }] });
  assert.equal(cmdbAccepted.itsm, plain.itsm, 'accepting a CMDB finding must not invalidate the ITSM result');
  assert.notEqual(cmdbAccepted.cmdb, plain.cmdb);
  const itsmAccepted = engineKeys({ staleDays: 90, acceptedRules: [{ ruleId: 'ITSM-INC-STALE', fingerprint: 'fp2' }] });
  assert.notEqual(itsmAccepted.itsm, plain.itsm);
  assert.equal(itsmAccepted.cmdb, plain.cmdb, 'accepting an ITSM finding must not invalidate CMDB');
});

/* ════════════════════════ DECISION 9 — schedule boundaries ════════════════════════ */

test('SCHEDULES (DECISION 9): the instance timestamp format (local and Z), month boundary, leap day, DST fall-back, window edges; monthly / yearly stay UNAVAILABLE — never zero occurrences', () => {
  const win = (a, b) => ({ start: new Date(a), end: new Date(b) });
  /* month boundary: a daily span across Feb → Mar in a non-leap year */
  const feb = SCH.expandSpan({ start_date_time: '20260227T230000', end_date_time: '20260228T010000', repeat_type: 'daily' }, { window: win('2026-02-27T00:00:00Z', '2026-03-02T00:00:00Z'), timeZone: 'UTC' });
  assert.deepEqual(feb.intervals.map((i) => i.start_snow), ['2026-02-27 23:00:00', '2026-02-28 23:00:00', '2026-03-01 23:00:00'], '28 Feb is followed by 1 Mar');
  /* leap day: 2028 has a 29 February */
  const leap = SCH.expandSpan({ start_date_time: '20280228T100000', end_date_time: '20280228T110000', repeat_type: 'daily' }, { window: win('2028-02-28T00:00:00Z', '2028-03-01T23:59:59Z'), timeZone: 'UTC' });
  assert.deepEqual(leap.intervals.map((i) => i.start_snow), ['2028-02-28 10:00:00', '2028-02-29 10:00:00', '2028-03-01 10:00:00']);
  /* DST fall-back: London leaves BST on 25 Oct 2026; a 01:30 local daily span is 00:30Z before and 01:30Z after */
  const fall = SCH.expandSpan({ start_date_time: '20261024T013000', end_date_time: '20261024T020000', repeat_type: 'daily' }, { window: win('2026-10-24T00:00:00Z', '2026-10-26T23:59:59Z'), timeZone: 'Europe/London' });
  assert.deepEqual(fall.intervals.map((i) => i.start_snow), ['2026-10-24 00:30:00', '2026-10-25 01:30:00', '2026-10-26 01:30:00']);
  /* Z timestamps are UTC instants: the same wall-clock day in the schedule zone drives the recurrence */
  const z = SCH.expandSpan({ start_date_time: '20260301T070000Z', end_date_time: '20260301T080000Z', repeat_type: '' }, { window: win('2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z'), timeZone: 'America/Los_Angeles' });
  assert.deepEqual([z.intervals[0].start_snow, z.intervals[0].end_snow], ['2026-03-01 07:00:00', '2026-03-01 08:00:00']);
  /* window edges: an occurrence ending exactly at the window start is in; one starting one second after the window end is out */
  const edge = SCH.expandSpan({ start_date_time: '20260301T230000', end_date_time: '20260302T000000', repeat_type: 'daily' }, { window: win('2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z'), timeZone: 'UTC' });
  assert.deepEqual(edge.intervals.map((i) => i.start_snow), ['2026-03-01 23:00:00', '2026-03-02 23:00:00']);
  const after = SCH.expandSpan({ start_date_time: '20260303T000001', end_date_time: '20260303T010000', repeat_type: '' }, { window: win('2026-03-02T00:00:00Z', '2026-03-03T00:00:00Z'), timeZone: 'UTC' });
  assert.equal(after.intervals.length, 0);
  /* unexpandable is never zero occurrences */
  for (const repeat of ['monthly', 'yearly', 'fortnightly']) {
    const r = SCH.expandSpan({ start_date_time: '20260301T000000', end_date_time: '20260301T010000', repeat_type: repeat }, { window: win('2026-03-01T00:00:00Z', '2026-12-31T00:00:00Z'), timeZone: 'UTC' });
    assert.equal(r.status, 'unsupported', repeat);
    assert.equal(r.intervals, undefined);
  }
  const sched = SCH.expandSchedule({ sys_id: 's', name: 'mixed', time_zone: 'UTC', spans: [{ start_date_time: '20260301T000000', end_date_time: '20260301T010000', repeat_type: 'yearly' }] }, { window: win('2026-03-01T00:00:00Z', '2026-12-31T00:00:00Z') });
  assert.deepEqual([sched.status, sched.intervals], ['unavailable', []]);
  assert.match(sched.reason, /yearly/);
});

/* ════════════════════════ DECISION 10 — 072 metadata caching ════════════════════════ */

test('ITSM-072 (DECISION 10): the state order is read from sys_choice once per run and reused; two rules over problem.state share the read', async () => {
  const { ctx, get } = await run(['ITSM-072', 'ITSM-056']);
  assert.equal(get('ITSM-072').status, 'evaluated');
  assert.deepEqual(get('ITSM-072').state_order.order, ['101', '102', '103', '107']);
  const choiceReads = ctx.reads.entries().filter((e) => e.req.table === 'sys_choice' && /element=state/.test(e.req.query) && /name=problem/.test(e.req.query));
  assert.equal(choiceReads.length, 1, 'one declared read of the problem state choice list');
  const second = await evaluateConfiguredRule(ITSM_RULE_CONFIGS.get('ITSM-072'), ctx);
  assert.equal(ctx.reads.entries().filter((e) => e.req.table === 'sys_choice' && /name=problem\^element=state/.test(e.req.query)).length, 1, 're-evaluation reused the cached read');
  assert.deepEqual(second.state_order.order, ['101', '102', '103', '107']);
});

/* ════════════════════════ evidence, verdicts, blockers ════════════════════════ */

test('EVIDENCE: every result explains itself — parameters used with their source, kpis whose pass_pct is the share NOT offending, verdicts, blockers; partial scope with no finding is inconclusive', async () => {
  const { get } = await run(['ITSM-020', 'ITSM-018', 'ITSM-123', 'ITSM-042', 'ITSM-024', 'ITSM-045']);
  const e20 = get('ITSM-020').explanation;
  assert.deepEqual([e20.rule_id, e20.slot, e20.status, e20.verdict, e20.findings], ['ITSM-020', 20, 'evaluated', 'fail', 1]);
  assert.deepEqual(e20.parameters_used.min_length, { value: 20, unit: null, source: 'workbook', status: 'RESOLVED' });
  assert.equal(e20.confidence, 1);
  /* reference-integrity kpi: pass_pct agrees with what was reported */
  const k18 = get('ITSM-018').kpis[0];
  assert.equal(k18.numerator, k18.denominator - get('ITSM-018').findings.reduce((n, f) => n + f.target_ids.length, 0));
  assert.match(k18.basis, /members_active: inactive/);
  /* temporal kpi: the share NOT correlated */
  const k123 = get('ITSM-123').kpis[0];
  assert.equal(k123.pass_pct, k123.denominator ? Number((100 * k123.numerator / k123.denominator).toFixed(1)) : null);
  assert.match(k123.basis, /matched/);
  /* verdicts */
  assert.equal(get('ITSM-042').verdict, 'fail');
  assert.equal(get('ITSM-042').scope.kind, 'detection_gap');
  const quiet = await run(['ITSM-042'], withRow('incident', 'inc-open', { assignment_group: 'g-live' }));
  assert.equal(quiet.get('ITSM-042').verdict, 'inconclusive', 'the concentration half is undefined, so "no finding" is not a pass');
  assert.equal(get('ITSM-024').blocker.kind, 'specification_gap');
  assert.deepEqual([get('ITSM-045').blocker.kind, get('ITSM-045').blocker.object, get('ITSM-045').blocker.step], ['undefined_object', 'major_incident', 'candidate']);
  assert.equal(get('ITSM-045').explanation.reasons.length, 1);
});
