import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeInstance, platformMeta } from './helpers/itsm-fake-instance.js';

/*
 * ITSM PHASE 3 — engines 1–3: Record Predicate, Aggregate & Distribution,
 * Reference Integrity. Every rule configuration in this file is SYNTHETIC
 * test data exercising the generic mechanism; none is a workbook rule's
 * configuration, and the rule ids are borrowed only so the adapter can attach
 * a real catalogue entry.
 */

const RP = await import('../src/health/itsm/engines/record-predicate.js');
const AG = await import('../src/health/itsm/engines/aggregate.js');
const RI = await import('../src/health/itsm/engines/reference-integrity.js');
const { createEvaluationContext } = await import('../src/health/itsm/context.js');
const { adaptRule } = await import('../src/health/itsm/adapter.js');
const { ParameterRegistry } = await import('../src/health/itsm/parameters.js');

const NOW = new Date('2026-09-16T12:00:00Z');
const meta = platformMeta({
  tables: {
    task: { fields: ['priority', 'assignment_group', 'sys_created_on', 'closed_at', 'closed_by', 'active', 'cmdb_ci'] },
    incident: { fields: ['close_notes', 'reopen_count', 'problem_id', 'caller_id'], superClass: 'task' },
    change_request: { fields: ['backout_plan', 'close_code', 'risk'], superClass: 'task' },
    problem: { fields: ['assigned_to'], superClass: 'task' },
    sys_user: { fields: ['active', 'user_name'] }, sys_user_grmember: { fields: ['group', 'user'] }, cmdb_ci: { fields: ['install_status', 'name'] },
  },
});
const ctxFor = (tables, opts = {}) => createEvaluationContext({ client: fakeInstance({ ...meta, ...tables }, opts.instance), now: NOW, parameters: opts.parameters });
const configured = (id, config) => ({ ...adaptRule(id), config });

/* ════════════════════════ ENGINE 1 — record predicate ════════════════════════ */

test('RECORD PREDICATE: every supported op evaluates, with boundary cases', () => {
  const ctx = createEvaluationContext({ client: {}, now: NOW });
  const t = (spec, row) => RP.compilePredicate(spec, ctx)(row);
  assert.equal(t({ field: 'x', op: 'empty' }, { x: '' }), true);
  assert.equal(t({ field: 'x', op: 'empty' }, { x: '  ' }), true);
  assert.equal(t({ field: 'x', op: 'empty' }, { x: 'a' }), false);
  assert.equal(t({ field: 'x', op: 'empty' }, {}), null, 'a missing field is unevaluable, not empty');
  assert.equal(t({ field: 'x', op: 'not_empty' }, { x: 'a' }), true);
  assert.equal(t({ field: 'x', op: 'equals', value: '1' }, { x: 1 }), true);
  assert.equal(t({ field: 'x', op: 'not_equals', value: '1' }, { x: '2' }), true);
  assert.equal(t({ field: 'x', op: 'in', value: ['a', 'b'] }, { x: 'b' }), true);
  assert.equal(t({ field: 'x', op: 'not_in', value: ['a', 'b'] }, { x: 'c' }), true);
  assert.equal(t({ field: 'x', op: 'length_lt', value: 20 }, { x: '   short   ' }), true, 'length is measured after trimming');
  assert.equal(t({ field: 'x', op: 'length_lt', value: 5 }, { x: 'exact' }), false, 'boundary: length 5 is not < 5');
  assert.equal(t({ field: 'x', op: 'length_gt', value: 5 }, { x: 'exact' }), false);
  assert.equal(t({ field: 'x', op: 'length_gt', value: 4 }, { x: 'exact' }), true);
  const iv = { field: 'a', field2: 'b', op: 'interval_lt', value: 60, unit: 'seconds' };
  assert.equal(t(iv, { a: '2026-09-16 10:00:00', b: '2026-09-16 10:00:59' }), true);
  assert.equal(t(iv, { a: '2026-09-16 10:00:00', b: '2026-09-16 10:01:00' }), false, 'boundary: exactly 60 s is not < 60 s');
  assert.equal(t(iv, { a: '2026-09-16 10:00:00' }), null, 'missing field2 is unevaluable');
  assert.equal(t({ field: 'a', op: 'interval_gt', value: 1, unit: 'days' }, { a: '2026-09-14 12:00:00' }), true, 'no field2 → against the run anchor');
  assert.equal(t({ field: 'a', op: 'interval_gt', value: 2, unit: 'days' }, { a: '2026-09-14 12:00:00' }), false, 'boundary: exactly 2 days is not > 2 days');
  assert.equal(t({ field: 'a', op: 'date_before', window: '2 days' }, { a: '2026-09-14 11:59:59' }), true);
  assert.equal(t({ field: 'a', op: 'date_before', window: '2 days' }, { a: '2026-09-14 12:00:00' }), false, 'boundary: equal to the bound is not before it');
  assert.equal(t({ field: 'a', op: 'date_after', at: '2026-09-01 00:00:00' }, { a: '2026-09-02 00:00:00' }), true);
  assert.equal(t({ field: 'a', op: 'date_after', at: '2026-09-01 00:00:00' }, { a: 'garbage' }), null);
  assert.throws(() => RP.validatePredicate({ field: 'x', op: 'regex' }), RP.PredicateError);
  assert.throws(() => RP.validatePredicate({ field: 'x', op: 'interval_lt', value: 5 }), /unit/);
  assert.throws(() => RP.validatePredicate({ field: 'x', op: 'date_before' }), /window/);
});

test('RECORD PREDICATE: pushdown puts every expressible predicate in the query and leaves arithmetic in memory; ids strategy when nothing is residual', () => {
  const ctx = createEvaluationContext({ client: {}, now: NOW });
  const plan = RP.pushdownPlan({
    scope: 'active=true',
    predicates: [
      { field: 'close_notes', op: 'empty' },
      { field: 'priority', op: 'in', value: ['1', '2'] },
      { field: 'sys_created_on', op: 'date_before', window: '2 days' },
      { field: 'sys_created_on', field2: 'closed_at', op: 'interval_lt', value: 60, unit: 'seconds' },
    ],
    evidenceFields: ['number'],
  }, ctx);
  assert.equal(plan.query, 'active=true^close_notesISEMPTY^priorityIN1,2^sys_created_on<2026-09-14 12:00:00');
  assert.equal(plan.pushed.length, 3);
  assert.equal(plan.residual.length, 1);
  assert.deepEqual([...plan.fields].sort(), ['closed_at', 'number', 'sys_created_on']);
  assert.equal(plan.strategy, 'rows');
  const onlyPushed = RP.pushdownPlan({ predicates: [{ field: 'backout_plan', op: 'empty' }] }, ctx);
  assert.equal(onlyPushed.strategy, 'ids', 'a fully pushed predicate must not retrieve the text');
  assert.equal(onlyPushed.query, 'backout_planISEMPTY');
});

test('RECORD PREDICATE: end to end — offenders, unevaluable rows reported, ratio kpi from a server-side count, nothing read when unconfigured', async () => {
  const incident = [
    { sys_id: 'i1', active: 'true', close_notes: '', priority: '1', sys_created_on: '2026-09-10 00:00:00', closed_at: '2026-09-10 00:00:30', closed_by: 'u' },
    { sys_id: 'i2', active: 'true', close_notes: 'short', priority: '1', sys_created_on: '2026-09-10 00:00:00', closed_at: '2026-09-10 00:00:30', closed_by: 'u' },
    { sys_id: 'i3', active: 'true', close_notes: '', priority: '1', sys_created_on: '2026-09-10 00:00:00', closed_at: '2026-09-10 00:05:00', closed_by: 'u' },
    { sys_id: 'i4', active: 'true', close_notes: '', priority: '1', sys_created_on: '2026-09-10 00:00:00' },
    { sys_id: 'i5', active: 'false', close_notes: '', priority: '1', sys_created_on: '2026-09-10 00:00:00', closed_at: '2026-09-10 00:00:01' },
  ];
  const ctx = ctxFor({ incident });
  const rule = configured('ITSM-036', {
    table: 'incident', scope: 'active=true',
    predicates: [{ field: 'close_notes', op: 'empty' }, { field: 'sys_created_on', field2: 'closed_at', op: 'interval_lt', value: 60, unit: 'seconds' }],
    evidence_fields: ['closed_by'], report_ratio: true, severity: 'CRITICAL',
  });
  const res = await RP.engine.evaluate(rule, ctx);
  assert.equal(res.status, 'evaluated');
  assert.equal(res.findings.length, 1);
  assert.deepEqual(res.findings[0].target_ids, ['i1']);
  assert.equal(res.findings[0].kind, 'record');
  assert.equal(res.findings[0].severity, 'CRITICAL');
  assert.deepEqual(res.skipped, [{ rule: 'ITSM-036', table: 'incident', reason: 'Fields omitted by API/ACL', excluded_records: 1 }], 'i4 has no closed_at and must be counted, not judged');
  assert.equal(res.coverage[0].query, 'active=true^close_notesISEMPTY');
  assert.equal(res.coverage[0].rowsFetched, 3, 'only rows the pushed query admits were read');
  assert.equal(res.kpis[0].denominator, 4, 'the ratio denominator is the population count from the instance');
  assert.equal(res.kpis[0].numerator, 3);
  const unconfigured = await RP.engine.evaluate(adaptRule('ITSM-036'), ctx);
  assert.equal(unconfigured.status, 'not_configured');
});

test('RECORD PREDICATE: a missing field on the instance makes the rule UNAVAILABLE (capability), an UNCONFIGURED parameter makes it UNCONFIGURED — never a healthy pass', async () => {
  const ctx = ctxFor({ incident: [{ sys_id: 'i1', active: 'true' }] });
  const missingField = await RP.engine.evaluate(configured('ITSM-020', { table: 'incident', predicates: [{ field: 'u_custom_notes', op: 'empty' }] }), ctx);
  assert.equal(missingField.status, 'unavailable');
  assert.match(missingField.skipped[0].reason, /capability UNAVAILABLE/);
  const reg = new ParameterRegistry();
  reg.define({ rule: 'ITSM-020', key: 'min_length', type: 'number', default: null });
  const ctx2 = ctxFor({ incident: [{ sys_id: 'i1', active: 'true', close_notes: '' }] }, { parameters: reg });
  const undef = await RP.engine.evaluate(configured('ITSM-020', { table: 'incident', predicates: [{ field: 'close_notes', op: 'empty' }], required_parameters: ['min_length'] }), ctx2);
  assert.equal(undef.status, 'unconfigured');
  assert.match(undef.skipped[0].reason, /min_length is UNCONFIGURED/);
  assert.equal(undef.findings.length, 0);
  /* Undeclared (no declaration at all) is the same external answer. */
  const undeclared = await RP.engine.evaluate(configured('ITSM-036', { table: 'incident', predicates: [{ field: 'close_notes', op: 'empty' }], required_parameters: ['threshold'] }), ctxFor({ incident: [] }, { parameters: new ParameterRegistry() }));
  assert.equal(undeclared.status, 'unconfigured');
  assert.match(undeclared.skipped[0].reason, /no declaration transcribed/);
});

/* ════════════════════════ ENGINE 2 — aggregate ════════════════════════ */

const groups = [
  { group: { priority: '1' }, count: 5, avg: { d: 10 }, sum: { d: 50 } },
  { group: { priority: '2' }, count: 15, avg: { d: 20 }, sum: { d: 300 } },
  { group: { priority: '3' }, count: 80, avg: { d: 5 }, sum: { d: 400 } },
];

test('AGGREGATE: count, share, ratio, percentage, average, sum and distribution compute the right numbers over groups', () => {
  assert.deepEqual(AG.computeMeasure(groups, { measure: 'count' }), { observed: 100, population: 100, count: 100 });
  assert.equal(AG.computeMeasure(groups, { measure: 'count', numerator: (g) => g.priority === '1' }).observed, 5);
  const share = AG.computeMeasure(groups, { measure: 'share' });
  assert.deepEqual([share.observed, share.group], [80, { priority: '3' }]);
  assert.equal(AG.computeMeasure(groups, { measure: 'share', of: (g) => g.priority === '2' }).observed, 15);
  assert.equal(AG.computeMeasure(groups, { measure: 'ratio', numerator: (g) => g.priority === '1', denominator: (g) => g.priority !== '3' }).observed, 0.25);
  assert.equal(AG.computeMeasure(groups, { measure: 'percentage', numerator: (g) => g.priority === '1' }).observed, 5);
  assert.equal(AG.computeMeasure(groups, { measure: 'average', field: 'd' }).observed, 7.5, 'count-weighted: (5·10 + 15·20 + 80·5) / 100');
  assert.equal(AG.computeMeasure(groups, { measure: 'sum', field: 'd' }).observed, 750);
  const dist = AG.computeMeasure(groups, { measure: 'distribution' });
  assert.deepEqual(dist.distribution.map((d) => [d.group.priority, d.count, d.share]), [['3', 80, 80], ['2', 15, 15], ['1', 5, 5]]);
  assert.equal(AG.computeMeasure([], { measure: 'share' }).observed, null, 'a share of nothing is not 0, it is nothing');
  assert.throws(() => AG.computeMeasure(groups, { measure: 'median' }), AG.AggregateError);
  assert.deepEqual(AG.aggregateRows([{ p: '1', d: '10' }, { p: '1', d: '30' }, { p: '2', d: '5' }], { groupBy: ['p'], avg: ['d'], sum: ['d'] }).map((g) => [g.group.p, g.count, g.avg.d, g.sum.d]), [['1', 2, 20, 40], ['2', 1, 5, 5]]);
});

test('AGGREGATE: thresholds judge with boundaries; two-tier escalation; minimum population withholds the verdict', () => {
  assert.deepEqual(AG.judge(70, { op: 'gt', value: 70 }), { breached: false, escalated: false });
  assert.deepEqual(AG.judge(70.1, { op: 'gt', value: 70 }), { breached: true, escalated: false });
  assert.deepEqual(AG.judge(70, { op: 'gte', value: 70 }), { breached: true, escalated: false });
  assert.deepEqual(AG.judge(9, { op: 'gt', value: 8, escalate_at: 15 }), { breached: true, escalated: false });
  assert.deepEqual(AG.judge(16, { op: 'gt', value: 8, escalate_at: 15 }), { breached: true, escalated: true });
  assert.deepEqual(AG.judge(0.3, { op: 'lt', value: 0.5 }), { breached: true, escalated: false });
  assert.deepEqual(AG.judge(null, { op: 'gt', value: 1 }), { breached: false, escalated: false });
  assert.throws(() => AG.judge(1, { op: 'between', value: 1 }), AG.AggregateError);
  const m = AG.evaluateMeasure(groups, { measure: 'share', threshold: { op: 'gt', value: 70 }, minimum_volume: 500 });
  assert.equal(m.status, 'insufficient_volume');
  assert.equal(m.breached, false);
  const ok = AG.evaluateMeasure(groups, { measure: 'share', threshold: { op: 'gt', value: 70 }, minimum_volume: 50 });
  assert.deepEqual([ok.status, ok.breached, ok.observed], ['ok', true, 80]);
});

test('AGGREGATE: trend needs at least the stated windows; the expected distribution is the EMPIRICAL one (DECISION 2), never a model', () => {
  assert.equal(AG.trend([{ at: '1', value: 50 }, { at: '2', value: 45 }]).status, 'insufficient_windows');
  const t = AG.trend([{ at: '1', value: 50 }, { at: '2', value: 45 }, { at: '3', value: 40 }]);
  assert.deepEqual([t.status, t.direction, t.windows], ['ok', 'falling', 3]);
  assert.equal(AG.trend([{ at: '1', value: 1 }, { at: '2', value: 2 }, { at: '3', value: 3 }]).direction, 'rising');
  assert.deepEqual(AG.EXPECTED_DISTRIBUTION, { method: 'empirical', reference: 'DECISIONS.md §2' });
  assert.equal(AG.expectedDistribution, undefined, 'no function that could return a reference model');
});

test('AGGREGATE: end to end — the engine reads no rows, records the measure, emits a kpi, and a finding only when breached', async () => {
  const incident = Array.from({ length: 100 }, (_, i) => ({ sys_id: `i${i}`, active: 'true', priority: i < 80 ? '3' : i < 95 ? '2' : '1' }));
  const ctx = ctxFor({ incident });
  const rule = configured('ITSM-001', { table: 'incident', query: 'active=true', group_by: ['priority'], measure: 'share', threshold: { op: 'gt', value: 70 }, severity: 'SYSTEMIC', basis: 'share of the dominant priority band' });
  const res = await AG.engine.evaluate(rule, ctx);
  assert.equal(res.status, 'evaluated');
  assert.equal(ctx.client.calls.aggregate, 1, 'the measure went to the Aggregate API');
  assert.ok((ctx.client.calls.byTable.incident || 0) <= 2, 'rows were read for an aggregate rule (only the readability probe may touch incident)');
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].kind, 'aggregate');
  assert.deepEqual([res.findings[0].detail.observed, res.findings[0].detail.group], [80, { priority: '3' }]);
  assert.equal(res.findings[0].severity, 'SYSTEMIC');
  assert.equal(res.kpis.length, 1);
  assert.ok(Object.keys(res.measures).length === 1);
  const fine = await AG.engine.evaluate(configured('ITSM-001', { table: 'incident', group_by: ['priority'], measure: 'share', threshold: { op: 'gt', value: 90 } }), ctx);
  assert.equal(fine.findings.length, 0, 'not breached → no finding');
  assert.equal(fine.kpis.length, 1, 'but the measure is still recorded');
  const tooSmall = await AG.engine.evaluate(configured('ITSM-001', { table: 'incident', group_by: ['priority'], measure: 'share', threshold: { op: 'gt', value: 70 }, minimum_volume: 1000 }), ctx);
  assert.equal(tooSmall.findings.length, 0);
  assert.match(tooSmall.skipped[0].reason, /below the minimum volume/);
});

/* ════════════════════════ ENGINE 3 — reference integrity ════════════════════════ */

const users = [{ sys_id: 'u1', active: 'true', user_name: 'abel' }, { sys_id: 'u2', active: 'false', user_name: 'gone' }];
const members = [{ sys_id: 'm1', group: 'g_ok', user: 'u1' }, { sys_id: 'm2', group: 'g_inactive', user: 'u2' }];

test('REFERENCE: existing, missing, inactive and invalid-state targets are told apart; batches are cached per run', async () => {
  const cis = [{ sys_id: 'c_live', install_status: '1', name: 'srv' }, { sys_id: 'c_retired', install_status: '7', name: 'old' }];
  const incident = [
    { sys_id: 'i1', cmdb_ci: 'c_live' }, { sys_id: 'i2', cmdb_ci: 'c_retired' }, { sys_id: 'i3', cmdb_ci: 'c_gone' }, { sys_id: 'i4', cmdb_ci: '' }, { sys_id: 'i5' },
  ];
  const ctx = ctxFor({ incident, cmdb_ci: cis, sys_user: users, sys_user_grmember: members });
  const resolver = RI.createResolver(ctx);
  const exists = await RI.checkReferences(incident, { field: 'cmdb_ci', target: 'cmdb_ci', check: 'exists', resolver });
  assert.deepEqual(exists.valid.map((r) => r.sys_id), ['i1', 'i2']);
  assert.deepEqual(exists.missing.map((r) => r.sys_id), ['i3']);
  assert.deepEqual(exists.empty.map((r) => r.sys_id), ['i4']);
  assert.deepEqual(exists.unverifiable.map((r) => r.sys_id), ['i5'], 'a hidden field is unverifiable, not missing');
  const state = await RI.checkReferences(incident, { field: 'cmdb_ci', target: 'cmdb_ci', check: 'state', stateField: 'install_status', invalidStates: ['7'], resolver });
  assert.deepEqual(state.invalid_state.map((r) => r.sys_id), ['i2']);
  const before = ctx.client.calls.byTable.cmdb_ci;
  await RI.checkReferences(incident, { field: 'cmdb_ci', target: 'cmdb_ci', check: 'exists', resolver });
  assert.equal(ctx.client.calls.byTable.cmdb_ci, before, 'the second check re-read the targets');
  assert.equal(resolver.cached('cmdb_ci'), 3);
});

test('REFERENCE: group membership resolves active members through sys_user_grmember + sys_user.active, once per group', async () => {
  const incident = [{ sys_id: 'i1', assignment_group: 'g_ok' }, { sys_id: 'i2', assignment_group: 'g_inactive' }, { sys_id: 'i3', assignment_group: 'g_empty' }];
  const ctx = ctxFor({ incident, sys_user: users, sys_user_grmember: members });
  const resolver = RI.createResolver(ctx);
  const r = await RI.checkReferences(incident, { field: 'assignment_group', target: 'sys_user_group', check: 'members_active', resolver });
  assert.deepEqual(r.valid.map((x) => x.sys_id), ['i1']);
  assert.deepEqual(r.inactive.map((x) => x.sys_id).sort(), ['i2', 'i3'], 'a group whose only member is inactive, and a group with no members, are both empty');
  const active = await RI.checkReferences([{ sys_id: 'p1', assigned_to: 'u2' }, { sys_id: 'p2', assigned_to: 'u1' }], { field: 'assigned_to', target: 'sys_user', check: 'active', resolver });
  assert.deepEqual(active.inactive.map((x) => x.sys_id), ['p1']);
});

test('REFERENCE: an incomplete target lookup cannot claim a missing reference — it reports unverifiable and the kpi says incomplete', async () => {
  const incident = [{ sys_id: 'i1', cmdb_ci: 'c_gone' }];
  const ctx = ctxFor({ incident, cmdb_ci: [] }, { instance: { forbidden: ['cmdb_ci'] } });
  const resolver = RI.createResolver(ctx);
  const r = await RI.checkReferences(incident, { field: 'cmdb_ci', target: 'cmdb_ci', check: 'exists', resolver });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.unverifiable.map((x) => x.sys_id), ['i1']);
  assert.equal(r.complete, false);
});

test('REFERENCE: end to end — findings per case, evidence names the reference, an unreadable target skips', async () => {
  const cis = [{ sys_id: 'c_live', install_status: '1' }, { sys_id: 'c_retired', install_status: '7' }];
  const incident = [{ sys_id: 'i1', active: 'true', cmdb_ci: 'c_live' }, { sys_id: 'i2', active: 'true', cmdb_ci: 'c_retired' }, { sys_id: 'i3', active: 'true', cmdb_ci: 'c_gone' }];
  const ctx = ctxFor({ incident, cmdb_ci: cis });
  const rule = configured('ITSM-019', { table: 'incident', scope: 'active=true', field: 'cmdb_ci', target: 'cmdb_ci', check: 'state', state_field: 'install_status', invalid_states: ['7'], report: ['missing', 'invalid_state'], severity: 'CRITICAL' });
  const res = await RI.engine.evaluate(rule, ctx);
  assert.equal(res.status, 'evaluated');
  assert.deepEqual(res.findings.map((f) => [f.title.endsWith('(missing)') ? 'missing' : f.title.endsWith('(invalid_state)') ? 'invalid_state' : f.title, f.target_ids]), [['missing', ['i3']], ['invalid_state', ['i2']]]);
  assert.equal(res.kpis[0].numerator, 1);
  const forbidden = await RI.engine.evaluate(rule, ctxFor({ incident, cmdb_ci: cis }, { instance: { forbidden: ['cmdb_ci'] } }));
  assert.equal(forbidden.status, 'unavailable');
  assert.match(forbidden.skipped[0].reason, /capability UNAVAILABLE/);
});
