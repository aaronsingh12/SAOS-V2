import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeInstance, platformMeta } from './helpers/itsm-fake-instance.js';

/*
 * ITSM PHASE 3 — engines 4–7: Cross-Record Linkage, Configuration Inspection,
 * Relationship Graph, Temporal Correlation. Synthetic configurations only.
 */

const LK = await import('../src/health/itsm/engines/linkage.js');
const CF = await import('../src/health/itsm/engines/configuration.js');
const RG = await import('../src/health/itsm/engines/relationship-graph.js');
const TC = await import('../src/health/itsm/engines/temporal-correlation.js');
const { createEvaluationContext } = await import('../src/health/itsm/context.js');
const { adaptRule } = await import('../src/health/itsm/adapter.js');
const { CAPABILITY } = await import('../src/health/itsm/capability.js');

const NOW = new Date('2026-09-16T12:00:00Z');
const meta = platformMeta({ tables: {
  incident: { fields: ['problem_id', 'cmdb_ci', 'sys_created_on', 'priority', 'active'] }, problem: { fields: ['state', 'active'] },
  change_request: { fields: ['cmdb_ci', 'work_start', 'work_end', 'close_code'] }, task_ci: { fields: ['task', 'ci_item'] },
  cmdb_rel_ci: { fields: ['parent', 'child', 'type'] }, cmdb_ci_service: { fields: ['name'] }, cmdb_ci: { fields: ['name'] },
  sys_choice: { fields: ['element'] }, contract_sla: { fields: ['name'] }, cmn_schedule: { fields: ['type'] }, cmn_schedule_span: { fields: ['schedule'] }, sys_properties: { fields: ['name'] },
} });
const ctxFor = (tables, instance = {}) => createEvaluationContext({ client: fakeInstance({ ...meta, ...tables }, instance), now: NOW });
const configured = (id, config) => ({ ...adaptRule(id), config });

/* ════════════════════════ ENGINE 4 — linkage ════════════════════════ */

const incidents = [
  { sys_id: 'i1', problem_id: 'p1', active: 'true' }, { sys_id: 'i2', problem_id: 'p1', active: 'false' },
  { sys_id: 'i3', problem_id: '', active: 'true' }, { sys_id: 'i4', problem_id: 'p_gone', active: 'true' },
];
const problems = [{ sys_id: 'p1', state: '3', active: 'false' }, { sys_id: 'p2', state: '1', active: 'true' }];

test('LINKAGE: join, anti-join, existence and state joins over a reference field, in both directions', () => {
  const j = LK.join(incidents, problems, { kind: 'reference', field: 'problem_id' });
  assert.deepEqual([j.get('i1').length, j.get('i3').length, j.get('i4').length], [1, 0, 0], 'a dangling reference has no match');
  assert.deepEqual(LK.antiJoin(incidents, problems, { kind: 'reference', field: 'problem_id' }).map((r) => r.sys_id), ['i3', 'i4']);
  assert.deepEqual(LK.existenceJoin(incidents, problems, { kind: 'reference', field: 'problem_id' }).map((r) => r.sys_id), ['i1', 'i2']);
  /* inbound: problems → incidents pointing at them */
  const inbound = { kind: 'reference', field: 'problem_id', direction: 'inbound' };
  assert.deepEqual(LK.antiJoin(problems, incidents, inbound).map((r) => r.sys_id), ['p2'], 'p2 has no linked incident');
  assert.deepEqual([...LK.countLinks(problems, incidents, inbound).entries()], [['p1', 2], ['p2', 0]]);
  assert.deepEqual(LK.stateJoin(problems, incidents, inbound, (i) => i.active === 'true', { mode: 'any' }).map((r) => r.sys_id), ['p1'], 'closed problem with an open linked incident');
  assert.deepEqual(LK.stateJoin(problems, incidents, inbound, (i) => i.active === 'true', { mode: 'all' }), []);
  assert.deepEqual(LK.stateJoin(problems, incidents, inbound, (i) => i.active === 'true', { mode: 'none' }), []);
});

test('LINKAGE: an m2m link de-duplicates repeated pairs and ignores half-empty rows', () => {
  const changes = [{ sys_id: 'c1' }, { sys_id: 'c2' }];
  const cis = [{ sys_id: 'ci_a' }, { sys_id: 'ci_b' }];
  const rows = [{ task: 'c1', ci_item: 'ci_a' }, { task: 'c1', ci_item: 'ci_a' }, { task: 'c1', ci_item: 'ci_b' }, { task: 'c2', ci_item: '' }, { task: '', ci_item: 'ci_b' }];
  const j = LK.join(changes, cis, { kind: 'm2m', rows, from_field: 'task', to_field: 'ci_item' });
  assert.equal(j.get('c1').length, 2, 'the duplicated pair counts once');
  assert.equal(j.get('c2').length, 0);
  assert.throws(() => LK.join(changes, cis, { kind: 'graph' }), LK.LinkageError);
});

test('LINKAGE: end to end — absent link findings, ratio kpi; an unreadable target or an incomplete target read is UNAVAILABLE (no "no links" claim)', async () => {
  const ctx = ctxFor({ incident: incidents, problem: problems });
  const rule = configured('ITSM-039', { from: { table: 'incident', query: 'active=true' }, to: { table: 'problem' }, link: { kind: 'reference', field: 'problem_id' }, expect: 'absent', report_ratio: true, severity: 'HIGH' });
  const res = await LK.engine.evaluate(rule, ctx);
  assert.equal(res.status, 'evaluated');
  assert.deepEqual(res.findings[0].target_ids, ['i3', 'i4']);
  assert.deepEqual([res.kpis[0].numerator, res.kpis[0].denominator], [1, 3]);
  const forbidden = await LK.engine.evaluate(rule, ctxFor({ incident: incidents, problem: problems }, { forbidden: ['problem'] }));
  assert.equal(forbidden.status, 'unavailable');
  /* Target read truncated → absence cannot be claimed. */
  const many = Array.from({ length: 30 }, (_, i) => ({ sys_id: `p${i}`, state: '1' }));
  const truncated = await LK.engine.evaluate({ ...rule, config: { ...rule.config, to: { table: 'problem' } } }, (() => {
    const c = ctxFor({ incident: incidents, problem: many });
    const origRead = c.reads.read;
    return { ...c, reads: { ...c.reads, read: async (req) => origRead(req.table === 'problem' ? { ...req, maxRows: 10 } : req) } };
  })());
  assert.equal(truncated.status, 'unavailable');
  assert.match(truncated.skipped[0].reason, /not read completely/);
});

/* ════════════════════════ ENGINE 5 — configuration ════════════════════════ */

test('CONFIGURATION: established readers read; placeholders run the DECISION 5 pipeline and stop at the first unmet step; an unknown reader throws', async () => {
  const ctx = ctxFor({
    sys_choice: [{ sys_id: 'ch1', name: 'incident', element: 'category', label: 'Network', value: 'network', inactive: 'false', language: 'en', dependent_value: '' }, { sys_id: 'ch2', name: 'incident', element: 'category', label: 'Old', value: 'old', inactive: 'true', language: 'en' }],
    contract_sla: [{ sys_id: 's1', name: 'P1 resolve', collection: 'incident', start_condition: 'priority=1', active: 'true' }],
    cmn_schedule: [{ sys_id: 'sc1', name: 'Blackout', type: 'blackout' }, { sys_id: 'sc2', name: '8-5', type: '' }],
    cmn_schedule_span: [{ sys_id: 'sp1', schedule: 'sc1', start_date_time: '2026-12-24 00:00:00', end_date_time: '2026-12-26 00:00:00', repeat_type: '' }, { sys_id: 'sp2', schedule: 'sc1', start_date_time: '2026-01-01 00:00:00', end_date_time: '2026-01-01 23:59:59', repeat_type: 'yearly' }],
    sys_properties: [{ sys_id: 'pr1', name: 'glide.ui.autoclose.time', value: '7' }],
  });
  const choices = await CF.readConfiguration(ctx, 'sys_choice', { table: 'incident', element: 'category' });
  assert.equal(choices.status, 'ok');
  assert.deepEqual(choices.rows.map((r) => r.value), ['network'], 'inactive choices excluded by default');
  assert.equal((await CF.readConfiguration(ctx, 'sys_choice', { table: 'incident', element: 'category', includeInactive: true })).rows.length, 2);
  const slas = await CF.readConfiguration(ctx, 'sla_definition', { collection: 'incident' });
  assert.equal(slas.rows[0].start_condition, 'priority=1');
  const sched = await CF.readConfiguration(ctx, 'schedule', { type: 'blackout' });
  assert.equal(sched.rows.length, 1);
  assert.deepEqual(sched.rows[0].spans.map((s) => s.expanded), [true, false], 'a repeating span is not expanded into dates');
  const props = await CF.readConfiguration(ctx, 'sys_properties', { names: ['glide.ui.autoclose.time'] });
  assert.equal(props.rows[0].value, '7');
  const ph = await CF.readConfiguration(ctx, 'assignment_rule');
  assert.equal(ph.status, 'unavailable');
  assert.equal(ph.candidate_table, 'sysrule_assignment');
  assert.equal(ph.candidate_state, CAPABILITY.UNAVAILABLE, 'the candidate table is not on this fake instance');
  assert.equal(ph.resolution_step, 'table_discovery');
  assert.deepEqual(ph.rules, ['ITSM-004', 'ITSM-029']);
  const undef = await CF.readConfiguration(ctx, 'major_incident');
  assert.equal(undef.candidate_table, null);
  assert.equal(undef.resolution_step, 'candidate');
  assert.match(undef.reason, /UNDEFINED/);
  /* A candidate that exists but has no expected fields is NOT confidently identified. */
  const noFields = await CF.readConfiguration(ctx, 'priority_matrix');
  assert.equal(noFields.candidate_table, 'dl_u_priority');
  assert.equal(noFields.resolution_step, 'table_discovery');
  await assert.rejects(() => CF.readConfiguration(ctx, 'cab_workbench'), CF.ConfigurationError);
  assert.equal(CF.isEstablished('sys_choice'), true);
  assert.equal(CF.isEstablished('cab'), false);
});

test('CONFIGURATION: end to end — a configuration finding, an unresolved object is UNAVAILABLE (never "absent"), an absent table is UNAVAILABLE', async () => {
  const ctx = ctxFor({ sys_choice: [{ sys_id: 'ch1', name: 'incident', element: 'category', value: 'network', inactive: 'false', language: 'en' }] });
  const rule = configured('ITSM-002', {
    reader: 'sys_choice', args: { table: 'incident', element: 'category' },
    compare: (rows) => ({ offenders: rows.filter((r) => r.value === 'network').map((r) => ({ sys_id: r.sys_id, field: 'value', value: r.value })), observed: 'network unused', expected: 'every configured category used' }),
    severity: 'SYSTEMIC',
  });
  const res = await CF.engine.evaluate(rule, ctx);
  assert.equal(res.status, 'evaluated');
  assert.equal(res.findings[0].kind, 'configuration');
  assert.deepEqual(res.findings[0].target_ids, ['ch1']);
  const unsupported = await CF.engine.evaluate(configured('ITSM-004', { reader: 'assignment_rule', compare: () => ({ absent: true }) }), ctx);
  assert.equal(unsupported.status, 'unavailable');
  assert.equal(unsupported.findings.length, 0, 'an unsupported object must not become an "absent" finding');
  const absent = await CF.engine.evaluate(configured('ITSM-085', { reader: 'schedule', args: { type: 'blackout' }, compare: () => ({ absent: true }) }), ctxFor({}, { absent: ['cmn_schedule'] }));
  assert.equal(absent.status, 'unavailable');
  assert.match(absent.skipped[0].reason, /unavailable/);
});

/* ════════════════════════ ENGINE 6 — relationship graph ════════════════════════ */

const rels = [
  { sys_id: 'r1', parent: 'svc', child: 'app', 'type.name': 'Depends on::Used by' },
  { sys_id: 'r2', parent: 'app', child: 'db', 'type.name': 'Depends on::Used by' },
  { sys_id: 'r3', parent: 'db', child: 'disk', 'type.name': 'Hosted on::Hosts' },
  { sys_id: 'r4', parent: 'db', child: 'disk', 'type.name': 'Duplicate' },
];

test('GRAPH: degree, dependents to a depth, path to a service, relationship lookup — built once from cmdb_rel_ci', () => {
  const g = RG.buildGraph(rels, { coverage: { rowsComplete: true }, serviceIds: ['svc'] });
  assert.equal(g.edges, 4);
  assert.equal(g.degree('db'), 3, 'undirected degree counts every edge row');
  assert.equal(g.degree('db', { direction: 'out' }), 2);
  assert.equal(g.degree('db', { direction: 'in' }), 1);
  assert.equal(g.degree('orphan'), 0);
  assert.deepEqual([...g.dependents('svc', 1).keys()], ['app']);
  assert.deepEqual([...g.dependents('svc', 3).entries()], [['app', 1], ['db', 2], ['disk', 3]]);
  assert.deepEqual(g.pathToService('disk'), { found: true, service: 'svc', path: ['disk', 'db', 'app', 'svc'], depth: 3 });
  assert.equal(g.pathToService('disk', { depth: 2 }).found, false, 'beyond the depth budget is not found on a complete graph');
  assert.equal(g.pathToService('svc').depth, 0);
  assert.equal(g.relationship('db', 'disk').length, 2);
  assert.equal(g.relationship('disk', 'svc').length, 0);
  const partial = RG.buildGraph(rels, { coverage: { rowsComplete: false }, serviceIds: ['svc'] });
  assert.equal(partial.pathToService('orphan').found, null, 'on an incomplete graph absence is unknown, not false');
  assert.equal(partial.complete, false);
});

test('GRAPH: end to end (DECISION 11) — only the referenced CIs\' relationships are read, the edge store is shared across rules, and an incomplete per-node read is UNAVAILABLE, never "no edges"', async () => {
  const ctx = ctxFor({ cmdb_rel_ci: rels, cmdb_ci_service: [{ sys_id: 'svc', name: 'Email' }], change_request: [{ sys_id: 'c1', cmdb_ci: 'disk' }, { sys_id: 'c2', cmdb_ci: 'orphan' }] });
  const rule = configured('ITSM-126', { table: 'change_request', ci_field: 'cmdb_ci', question: 'path_to_service', depth: 3, offend: (a) => a.found === false, severity: 'CRITICAL' });
  const res = await RG.engine.evaluate(rule, ctx);
  assert.equal(res.status, 'evaluated');
  assert.deepEqual(res.findings.map((f) => [f.kind, f.detail.source.sys_id]), [['relationship', 'c2']]);
  assert.deepEqual(res.graph_scope.seeds, ['disk', 'orphan']);
  /* No whole-table read: every cmdb_rel_ci read was bounded by a parentIN / childIN clause. */
  const relReads = ctx.reads.entries().filter((e) => e.req.table === 'cmdb_rel_ci');
  assert.ok(relReads.length > 0);
  assert.ok(relReads.every((e) => /^(parent|child)IN/.test(e.req.query)), `unbounded read: ${relReads.map((e) => e.req.query).join(' | ')}`);
  assert.equal(ctx.shared.has('graph_store'), true);
  /* A second rule over the same CIs reads no relationship row again. */
  const relsBefore = ctx.client.calls.byTable.cmdb_rel_ci;
  const second = await RG.engine.evaluate(configured('ITSM-130', { table: 'change_request', ci_field: 'cmdb_ci', question: 'degree', offend: (a) => a.degree === 0 }), ctx);
  assert.equal(ctx.client.calls.byTable.cmdb_rel_ci, relsBefore, 'the second rule re-read relationships already in the store');
  assert.deepEqual(second.findings.map((f) => f.detail.source.sys_id), ['c2']);
  /* A rule whose records name no CI reads no relationship at all. */
  const none = ctxFor({ cmdb_rel_ci: rels, cmdb_ci_service: [], change_request: [{ sys_id: 'c9', cmdb_ci: '' }] });
  await RG.engine.evaluate(configured('ITSM-130', { table: 'change_request', ci_field: 'cmdb_ci', question: 'degree', offend: (a) => a.degree === 0 }), none);
  assert.equal(none.client.calls.byTable.cmdb_rel_ci ?? 0, 0, 'a rule with no CI must trigger no CMDB read');
  /* A truncated per-node read → that CI is unverifiable; with every CI unverifiable the rule is UNAVAILABLE. */
  const big = Array.from({ length: 40 }, (_, i) => ({ sys_id: `r${i}`, parent: 'a1', child: `b${i}` }));
  const c2 = ctxFor({ cmdb_rel_ci: big, cmdb_ci_service: [], change_request: [{ sys_id: 'c1', cmdb_ci: 'a1' }] });
  const origRead = c2.reads.read;
  const patched = { ...c2, reads: { ...c2.reads, read: (req) => origRead(req.table === 'cmdb_rel_ci' ? { ...req, maxRows: 10 } : req) } };
  const unavailable = await RG.engine.evaluate(configured('ITSM-130', { table: 'change_request', ci_field: 'cmdb_ci', question: 'degree', offend: (a) => a.degree === 0 }), patched);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.findings.length, 0);
  assert.match(unavailable.skipped[0].reason, /could not be read completely/);
  assert.equal(unavailable.skipped[0].excluded_records, 1);
});

/* ════════════════════════ ENGINE 7 — temporal correlation ════════════════════════ */

const changes = [
  { sys_id: 'c1', cmdb_ci: 'db', work_end: '2026-09-10 08:00:00' },
  { sys_id: 'c2', cmdb_ci: 'db', work_end: '2026-09-01 08:00:00' },
  { sys_id: 'c3', cmdb_ci: 'app', work_end: '2026-09-10 09:00:00' },
  { sys_id: 'c4', cmdb_ci: '', work_end: '2026-09-10 09:00:00' },
];
const p1s = [
  { sys_id: 'i1', cmdb_ci: 'db', sys_created_on: '2026-09-11 08:00:00', priority: '1' },     // 24 h after c1 → inside 72 h
  { sys_id: 'i2', cmdb_ci: 'db', sys_created_on: '2026-09-13 08:00:00', priority: '1' },     // exactly 72 h after c1 → boundary, inside
  { sys_id: 'i3', cmdb_ci: 'db', sys_created_on: '2026-09-13 08:00:01', priority: '1' },     // 72 h + 1 s → outside
  { sys_id: 'i4', cmdb_ci: 'disk', sys_created_on: '2026-09-10 10:00:00', priority: '1' },   // no change on disk; db is its dependency
  { sys_id: 'i5', cmdb_ci: '', sys_created_on: '2026-09-10 10:00:00', priority: '1' },
];

test('TEMPORAL: the time index answers between() by key; window join respects inside / outside / boundary and dependent-key expansion', () => {
  const idx = TC.createTimeIndex(changes, { keyField: 'cmdb_ci', timeField: 'work_end' });
  assert.equal(idx.size, 3);
  assert.equal(idx.skipped, 1);
  assert.deepEqual(idx.between('db', Date.parse('2026-09-09T00:00:00Z'), Date.parse('2026-09-11T00:00:00Z')).map((r) => r.sys_id), ['c1']);
  const j = TC.windowJoin(p1s, idx, { keyField: 'cmdb_ci', timeField: 'sys_created_on', window: '72 hours', direction: 'before' });
  assert.deepEqual(j.pairs.map((p) => [p.left.sys_id, p.right.sys_id]), [['i1', 'c1'], ['i2', 'c1']]);
  assert.deepEqual([j.matched, j.unmatched, j.unevaluable], [2, 2, 1]);
  const expanded = TC.windowJoin(p1s, idx, { keyField: 'cmdb_ci', timeField: 'sys_created_on', window: '72 hours', expandKeys: (k) => (k === 'disk' ? ['db'] : []) });
  assert.ok(expanded.pairs.some((p) => p.left.sys_id === 'i4' && p.right.sys_id === 'c1' && p.via_dependent), 'a change on the dependency correlates with the dependent CI’s incident');
});

test('TEMPORAL: interval intersection with schedule spans (touching counts; an unexpanded span makes the answer UNAVAILABLE — DECISION 9); before/after with the elapsed-window guard', () => {
  const concrete = [{ id: 'blackout', start: '2026-12-24 00:00:00', end: '2026-12-26 00:00:00' }];
  const intervals = [
    { id: 'in', start: '2026-12-25 10:00:00', end: '2026-12-25 12:00:00' },
    { id: 'touch', start: '2026-12-26 00:00:00', end: '2026-12-26 02:00:00' },
    { id: 'out', start: '2026-12-27 00:00:00', end: '2026-12-27 02:00:00' },
    { id: 'jan', start: '2026-01-01 10:00:00', end: '2026-01-01 11:00:00' },
    { id: 'bad', start: '', end: '' },
  ];
  const r = TC.intervalIntersections(intervals, concrete);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.hits.map((h) => h.interval.id), ['in', 'touch']);
  assert.equal(r.unexpanded_spans, 0);
  assert.equal(r.unevaluable, 1);
  const withUnexpanded = TC.intervalIntersections(intervals, [...concrete, { id: 'yearly', start: '2026-01-01 00:00:00', end: '2026-01-01 23:59:59', expanded: false }]);
  assert.equal(withUnexpanded.status, 'unavailable');
  assert.deepEqual(withUnexpanded.hits, [], 'an unexpanded recurrence must never be read as "no blackout"');
  assert.equal(withUnexpanded.unexpanded_spans, 1);
  assert.equal(TC.intervalsIntersect(0, 10, 10, 20), true);
  assert.equal(TC.intervalsIntersect(0, 10, 11, 20), false);
  const events = [{ t: '2026-05-01 00:00:00' }, { t: '2026-05-20 00:00:00' }, { t: '2026-06-10 00:00:00' }, { t: '2026-07-01 00:00:00' }];
  const ba = TC.beforeAfter(events, { timeField: 't', anchor: '2026-06-01 00:00:00', window: '30 days', now: NOW });
  assert.deepEqual([ba.before, ba.after, ba.change, ba.complete], [1, 2, 1, true], 'May 1 is 31 days before the anchor — outside a 30-day window');
  const early = TC.beforeAfter(events, { timeField: 't', anchor: '2026-09-01 00:00:00', window: '30 days', now: NOW });
  assert.equal(early.complete, false, 'the after-window has not elapsed at the run anchor');
});

test('TEMPORAL: end to end — the right-hand index is shared, findings are cross-domain with the window in provenance, unevaluable rows are reported', async () => {
  const ctx = ctxFor({ change_request: changes, incident: p1s });
  const rule = configured('ITSM-123', {
    left: { table: 'incident', query: 'priority=1', key_field: 'cmdb_ci', time_field: 'sys_created_on' },
    right: { table: 'change_request', key_field: 'cmdb_ci', time_field: 'work_end' },
    window: '72 hours', direction: 'before', offend: 'matched', related_domain: 'CMDB', severity: 'SYSTEMIC',
  });
  const res = await TC.engine.evaluate(rule, ctx);
  assert.equal(res.status, 'evaluated');
  assert.equal(res.findings[0].kind, 'cross_domain');
  assert.deepEqual(res.findings[0].target_ids, ['i1', 'i2']);
  assert.deepEqual(res.findings[0].detail.provenance.window, { amount: 72, unit: 'hours' });
  assert.equal(res.skipped[0].excluded_records, 1);
  const n = ctx.client.calls.byTable.change_request;
  await TC.engine.evaluate(configured('ITSM-128', { ...rule.config, offend: 'unmatched' }), ctx);
  assert.equal(ctx.client.calls.byTable.change_request, n, 'the change index was rebuilt for the second rule');
});
