import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeInstance, platformMeta } from './helpers/itsm-fake-instance.js';

/*
 * ITSM PHASE 3 — engines 8–10: Audit & Journal History, Text Analysis
 * (infrastructure only), Composite / Rule Dependency. Synthetic configurations.
 */

const AH = await import('../src/health/itsm/engines/audit-history.js');
const TX = await import('../src/health/itsm/engines/text-analysis.js');
const CP = await import('../src/health/itsm/engines/composite.js');
const { createEvaluationContext } = await import('../src/health/itsm/context.js');
const { adaptRule } = await import('../src/health/itsm/adapter.js');
const { getAllITSMRules } = await import('../src/health/itsm/catalogue.js');
const { evaluateRule } = await import('../src/health/itsm/registry.js');
const { REDACTED } = await import('../src/health/itsm/findings.js');

const NOW = new Date('2026-09-16T12:00:00Z');
const meta = platformMeta({ tables: { problem: { fields: ['state'] }, incident: { fields: ['state', 'close_notes', 'short_description', 'description', 'resolved_at', 'sys_created_on', 'caller_id', 'problem_id'] }, cmdb_ci: { fields: ['name'] }, sys_audit: { fields: ['fieldname'] }, sys_journal_field: { fields: ['element'] } }, audited: ['problem', 'incident'] });
const ctxFor = (tables, instance = {}) => createEvaluationContext({ client: fakeInstance({ ...meta, ...tables }, instance), now: NOW });
const configured = (id, config) => ({ ...adaptRule(id), config });

/* ════════════════════════ ENGINE 8 — audit & journal ════════════════════════ */

const audit = [
  { sys_id: 'a1', tablename: 'problem', documentkey: 'p1', fieldname: 'state', oldvalue: '1', newvalue: '2', sys_created_on: '2026-08-01 00:00:00', user: 'u1' },
  { sys_id: 'a2', tablename: 'problem', documentkey: 'p1', fieldname: 'state', oldvalue: '2', newvalue: '3', sys_created_on: '2026-08-05 00:00:00', user: 'u1' },
  { sys_id: 'a3', tablename: 'problem', documentkey: 'p1', fieldname: 'state', oldvalue: '3', newvalue: '2', sys_created_on: '2026-08-09 00:00:00', user: 'u2' },
  { sys_id: 'a4', tablename: 'problem', documentkey: 'p1', fieldname: 'state', oldvalue: '2', newvalue: '1', sys_created_on: '2026-08-12 00:00:00', user: 'u2' },
  { sys_id: 'a5', tablename: 'problem', documentkey: 'p1', fieldname: 'assigned_to', oldvalue: '', newvalue: 'u1', sys_created_on: '2026-08-02 00:00:00', user: 'u1' },
  { sys_id: 'a6', tablename: 'problem', documentkey: 'p2', fieldname: 'state', oldvalue: '1', newvalue: '2', sys_created_on: '2026-09-01 00:00:00', user: 'u1' },
];

test('AUDIT: transitions, counts, last change, first set, backward transitions and gaps are derived correctly from audit rows', () => {
  const tr = AH.reconstructTransitions(audit, 'state');
  assert.equal(tr.get('p1').length, 4);
  assert.deepEqual(tr.get('p1').map((t) => `${t.from}>${t.to}`), ['1>2', '2>3', '3>2', '2>1'], 'ordered by time');
  assert.equal(tr.has('p3'), false);
  assert.deepEqual([...AH.countEvents(audit, { field: 'state' }).entries()], [['p1', 4], ['p2', 1]]);
  assert.equal(AH.countEvents(audit).get('p1'), 5);
  assert.equal(AH.lastChangeAt(audit, { field: 'state' }).get('p1'), '2026-08-12 00:00:00');
  assert.equal(AH.firstSetAt(audit, 'assigned_to').get('p1'), '2026-08-02 00:00:00');
  assert.equal(AH.backwardTransitions(tr.get('p1'), ['1', '2', '3']).length, 2, 'two moves against the stated order');
  assert.throws(() => AH.backwardTransitions(tr.get('p1'), []), /order/, 'no order → refused outright (DECISION 10), never "nothing is backward"');
  /* The order comes from the instance's choice list, by sequence — and only when it is usable. */
  const choices = [{ value: '1', sequence: '10', label: 'New' }, { value: '3', sequence: '30', label: 'Closed' }, { value: '2', sequence: '20', label: 'Assess' }];
  assert.deepEqual(AH.deriveStateOrder(choices, { table: 'problem', element: 'state' }).order, ['1', '2', '3']);
  assert.equal(AH.deriveStateOrder([], { table: 'problem', element: 'state' }).status, 'unavailable', 'no choices → no order');
  assert.equal(AH.deriveStateOrder([{ value: '1', sequence: '' }, { value: '2', sequence: '2' }], { table: 'problem', element: 'state' }).status, 'unavailable', 'a blank sequence is not an order');
  assert.equal(AH.deriveStateOrder([{ value: '1', sequence: '5' }, { value: '2', sequence: '5' }], { table: 'problem', element: 'state' }).status, 'unavailable', 'tied sequences do not order');
  const gap = AH.maxGap(['2026-09-01 10:00:00', '2026-09-01 10:10:00', '2026-09-01 11:00:00', '2026-09-01 11:05:00']);
  assert.equal(gap.gap_ms, 50 * 60_000);
  const w = { start: new Date('2026-08-04T00:00:00Z'), end: new Date('2026-08-10T00:00:00Z') };
  assert.deepEqual(AH.withinWindow(audit, w).map((r) => r.sys_id), ['a2', 'a3']);
});

test('AUDIT: history present → transitions come back batched by document; history absent → empty, not a pass; audit off → an explicit capability state', async () => {
  const ctx = ctxFor({ sys_audit: audit, problem: [{ sys_id: 'p1' }, { sys_id: 'p2' }, { sys_id: 'p3' }], cmdb_ci: [{ sys_id: 'c1' }] });
  const present = await AH.fetchAudit(ctx, { table: 'problem', documentKeys: ['p1', 'p2', 'p3'], fields: ['state'] });
  assert.equal(present.status, 'ok');
  assert.equal(present.rows.length, 5);
  assert.equal(present.complete, true);
  assert.equal(AH.reconstructTransitions(present.rows, 'state').has('p3'), false, 'no history for p3 is an absence of rows, not a verdict');
  const off = await AH.fetchAudit(ctx, { table: 'cmdb_ci', documentKeys: ['c1'] });
  assert.equal(off.status, 'unavailable');
  assert.equal(off.capability.state, 'UNAVAILABLE');
  assert.match(off.capability.reason, /not audited/);
  assert.equal(off.rows.length, 0);
});

test('AUDIT: journal counts go through the Aggregate API per document, without reading rows', async () => {
  const journal = [
    { sys_id: 'j1', name: 'incident', element: 'work_notes', element_id: 'i1', sys_created_on: '2026-09-01 10:00:00' },
    { sys_id: 'j2', name: 'incident', element: 'work_notes', element_id: 'i1', sys_created_on: '2026-09-01 12:00:00' },
    { sys_id: 'j3', name: 'incident', element: 'comments', element_id: 'i1', sys_created_on: '2026-09-01 12:00:00' },
  ];
  const ctx = ctxFor({ sys_journal_field: journal });
  const c = await AH.countJournal(ctx, { table: 'incident', documentKeys: ['i1', 'i2'] });
  assert.deepEqual([...c.counts.entries()], [['i1', 2], ['i2', 0]]);
  assert.equal(ctx.client.calls.aggregate, 1);
  assert.equal(ctx.client.calls.byTable.sys_journal_field, 1, 'rows were read for a count');
  const rows = await AH.fetchJournal(ctx, { table: 'incident', documentKeys: ['i1'] });
  assert.equal(rows.rows.length, 2);
});

const stateChoices = [
  { sys_id: 's1', name: 'problem', element: 'state', value: '1', label: 'New', sequence: '1', inactive: 'false', language: 'en' },
  { sys_id: 's2', name: 'problem', element: 'state', value: '2', label: 'Assess', sequence: '2', inactive: 'false', language: 'en' },
  { sys_id: 's3', name: 'problem', element: 'state', value: '3', label: 'Closed', sequence: '3', inactive: 'false', language: 'en' },
];

test('AUDIT: end to end (DECISION 10) — the state order comes from sys_choice.sequence; a literal order is refused; no usable order → UNAVAILABLE; audit off → UNAVAILABLE', async () => {
  const problems = [{ sys_id: 'p1', state: '1', active: 'true' }, { sys_id: 'p2', state: '2', active: 'true' }];
  const ctx = ctxFor({ sys_audit: audit, problem: problems, sys_choice: stateChoices });
  const rule = configured('ITSM-072', { table: 'problem', scope: 'active=true', source: 'audit', field: 'state', derive: 'backward_transitions', order_source: { table: 'problem', element: 'state' }, offend: (n) => (n ?? 0) >= 2, severity: 'MEDIUM' });
  const res = await AH.engine.evaluate(rule, ctx);
  assert.equal(res.status, 'evaluated');
  assert.deepEqual(res.state_order.order, ['1', '2', '3']);
  assert.equal(res.state_order.source, 'sys_choice.sequence');
  assert.equal(res.findings[0].kind, 'historical');
  assert.deepEqual(res.findings[0].target_ids, ['p1'], 'p1 moved backwards twice (3→2, 2→1); p2 only forwards');
  assert.equal(res.findings[0].detail.transitions, 4);
  assert.equal(res.findings[0].evidence[0].field_value, '1 → 2 @ 2026-08-01 00:00:00');
  /* The same transitions under a REVERSED instance order are the opposite verdict — nothing about "1,2,3" is assumed. */
  const reversed = stateChoices.map((c) => ({ ...c, sequence: String(4 - Number(c.sequence)) }));
  const rev = await AH.engine.evaluate(rule, ctxFor({ sys_audit: audit, problem: problems, sys_choice: reversed }));
  assert.deepEqual(rev.state_order.order, ['3', '2', '1']);
  assert.deepEqual(rev.findings.map((f) => f.target_ids), [['p1']], 'p1: 1→2 and 2→3 are now the backward moves');
  /* A literal order in configuration is refused outright. */
  await assert.rejects(() => AH.engine.evaluate(configured('ITSM-072', { ...rule.config, order: ['1', '2', '3'] }), ctx), /DECISIONS.md §10/);
  /* No choice rows / invalid ordering → UNAVAILABLE, and no "no transitions" pass. */
  const noOrder = await AH.engine.evaluate(rule, ctxFor({ sys_audit: audit, problem: problems, sys_choice: [] }));
  assert.equal(noOrder.status, 'unavailable');
  assert.match(noOrder.skipped[0].reason, /state order unavailable/);
  const tied = await AH.engine.evaluate(rule, ctxFor({ sys_audit: audit, problem: problems, sys_choice: stateChoices.map((c) => ({ ...c, sequence: '1' })) }));
  assert.equal(tied.status, 'unavailable');
  /* Audit off on the table → UNAVAILABLE with the capability. */
  const off = await AH.engine.evaluate(configured('ITSM-072', { ...rule.config, table: 'cmdb_ci' }), ctxFor({ sys_audit: audit, cmdb_ci: [{ sys_id: 'c1', active: 'true' }], sys_choice: stateChoices }));
  assert.equal(off.status, 'unavailable');
  assert.match(off.skipped[0].reason, /capability UNAVAILABLE/);
  assert.equal(off.findings.length, 0);
});

/* ════════════════════════ ENGINE 9 — text analysis ════════════════════════ */

test('TEXT: normalisation folds case, punctuation, whitespace and numbers; tokenisation; frequency of normalised values', () => {
  assert.equal(TX.normalise('  INC0010037: Server  rebooted 3 times!! '), 'inc# server rebooted # times');
  assert.equal(TX.normalise('Keep 42', { keepNumbers: true }), 'keep 42');
  assert.deepEqual(TX.tokenise('The VPN is down, again.'), ['the', 'vpn', 'is', 'down', 'again']);
  const rows = [{ sys_id: 'a', d: 'Password reset for user 1' }, { sys_id: 'b', d: 'password RESET for user 2' }, { sys_id: 'c', d: 'Laptop broken' }, { sys_id: 'd', d: '' }];
  const f = TX.frequency(rows, 'd', { minVolume: 2 });
  assert.deepEqual(f.map((g) => [g.value, g.count, g.sys_ids]), [['password reset for user #', 2, ['a', 'b']]]);
});

test('TEXT: checksums (Luhn, Verhoeff) and pattern matching report counts and locations — never the value', () => {
  assert.equal(TX.luhn('4111 1111 1111 1111'), true);
  assert.equal(TX.luhn('4111 1111 1111 1112'), false);
  assert.equal(TX.verhoeff('236'), true);        // a canonical Verhoeff-valid number
  assert.equal(TX.verhoeff('237'), false);
  const patterns = [{ name: 'card', regex: /\b(?:\d[ -]?){13,19}\b/, checksum: 'luhn' }, { name: 'six', regex: /\b\d{6}\b/ }];
  const m = TX.matchPatterns('card 4111 1111 1111 1111 and 4111 1111 1111 1112 and 123456', patterns);
  assert.deepEqual(m, [{ name: 'card', validated: 1, pattern_only: 1, checksum: 'luhn' }, { name: 'six', validated: 0, pattern_only: 1, checksum: null }]);
  const hits = TX.scanRows([{ sys_id: 'i1', description: 'my card 4111 1111 1111 1111', number: 'INC1' }], ['description', 'number'], patterns);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].field_value, REDACTED);
  assert.equal(JSON.stringify(hits).includes('4111'), false, 'a matched value leaked');
  assert.throws(() => TX.matchPatterns('x', [{ name: 'bad', regex: 'not a regexp' }]), TX.TextAnalysisError);
  assert.throws(() => TX.matchPatterns('x', [{ name: 'bad', regex: /x/, checksum: 'mod97' }]), TX.TextAnalysisError);
});

test('TEXT (DECISION 1): TF-IDF cosine — identical 1.0, similar high, unrelated 0, empty 0, normalised equal, threshold boundary exact; the unresolved default still refuses', () => {
  assert.equal(TX.UNRESOLVED_SIMILARITY.resolved, false);
  assert.throws(() => TX.UNRESOLVED_SIMILARITY.similarity('a', 'b'), /UNRESOLVED/);
  assert.throws(() => TX.similar('a', 'b', TX.UNRESOLVED_SIMILARITY, 0.9), /not resolved/);
  assert.throws(() => TX.clusterBy([], { text: (x) => x, provider: TX.UNRESOLVED_SIMILARITY, threshold: 0.8 }), /not resolved/);
  const corpus = ['VPN down for all users', 'VPN down for one user', 'Printer jam on floor 3', 'Email not syncing on mobile', 'vpn DOWN for all users!!'];
  const tfidf = TX.createTfidfProvider(corpus);
  assert.equal(tfidf.name, 'tfidf_cosine');
  assert.equal(tfidf.resolved, true);
  assert.equal(tfidf.corpus_size, 5);
  const r = (a, b) => Number(tfidf.similarity(a, b).toFixed(6));
  assert.equal(r('VPN down for all users', 'VPN down for all users'), 1, 'identical → 1.0');
  assert.equal(r('VPN down for all users', 'vpn DOWN for all users!!'), 1, 'case / punctuation / whitespace are normalised away');
  assert.equal(r('INC0010037 rebooted 3 times', 'INC0010052 rebooted 5 times'), 1, 'numbers are normalised (identifier noise)');
  const sim = r('VPN down for all users', 'VPN down for one user');
  assert.ok(sim > 0.3 && sim < 1, `similar texts score high but below 1 (${sim})`);
  assert.equal(r('VPN down for all users', 'Printer jam on floor 3'), 0, 'no shared token → 0');
  assert.equal(r('', 'VPN down'), 0, 'empty → 0, never NaN');
  assert.equal(r('', ''), 0);
  /* Threshold boundary: exactly at the threshold counts as similar; a hair below does not. */
  assert.equal(TX.similar('VPN down for all users', 'VPN down for all users', tfidf, 1).similar, true);
  assert.equal(TX.similar('VPN down for all users', 'VPN down for one user', tfidf, sim).similar, true, 'at the threshold');
  assert.equal(TX.similar('VPN down for all users', 'VPN down for one user', tfidf, sim + 1e-9).similar, false, 'just above it');
  assert.throws(() => TX.similar('a', 'b', tfidf), /threshold/, 'no threshold is ever invented');
  assert.throws(() => TX.clusterBy([], { text: (x) => x, provider: tfidf }), /threshold/);
  /* Clustering with blocking, on the decided metric. */
  const items = [{ c: 'net', t: 'VPN down for all users' }, { c: 'net', t: 'vpn down for all users' }, { c: 'net', t: 'printer jam' }, { c: 'hw', t: 'VPN down for all users' }];
  const clusters = TX.clusterBy(items, { text: (i) => i.t, block: (i) => i.c, provider: TX.createTfidfProvider(items.map((i) => i.t)), threshold: 0.9, minSize: 2 });
  assert.deepEqual(clusters.map((c) => [c.block, c.size, c.provider]), [['net', 2, 'tfidf_cosine']], 'blocking keeps the hw VPN item out of the net cluster');
});

test('TEXT: the read budget admits rows until spent and says sampled; end to end — similarity, cluster, frequency and pattern_scan over instance rows; a sampled read marks its kpi incomplete', async () => {
  const budget = TX.createTextBudget({ maxChars: 20 });
  const r = budget.take([{ sys_id: 'a', d: 'x'.repeat(8) }, { sys_id: 'b', d: 'y'.repeat(8) }, { sys_id: 'c', d: 'z'.repeat(8) }], ['d']);
  assert.deepEqual([r.rows.length, r.sampled, r.admitted, r.refused], [2, true, 2, 1]);
  const incidents = [
    { sys_id: 'i1', short_description: 'VPN down for all users', close_notes: 'VPN down for all users', resolved_at: '2026-09-01 00:00:00', sys_created_on: '2026-08-31 00:00:00', description: 'call 4111 1111 1111 1111 now', caller_id: 'u1', problem_id: '' },
    { sys_id: 'i2', short_description: 'VPN down for all users', close_notes: 'Restarted the VPN concentrator and confirmed with the user', resolved_at: '2026-09-02 00:00:00', sys_created_on: '2026-09-01 00:00:00', description: 'nothing here', caller_id: 'u1', problem_id: '' },
    { sys_id: 'i3', short_description: 'Printer jam on floor 3', close_notes: 'Cleared the jam', resolved_at: '2026-09-03 00:00:00', sys_created_on: '2026-09-02 00:00:00', description: 'PAN ABCDE1234F', caller_id: 'u2', problem_id: '' },
  ];
  const ctx = ctxFor({ incident: incidents });
  const sim = await TX.engine.evaluate(configured('ITSM-021', { operation: 'similarity', table: 'incident', scope: 'resolved_atISNOTEMPTY', fields: ['short_description', 'close_notes'], threshold: 0.9, evidence_fields: [] }), ctx);
  assert.equal(sim.status, 'evaluated');
  assert.deepEqual(sim.findings[0].target_ids, ['i1'], 'only the copy-paste resolution offends');
  assert.equal(sim.text.provider, 'tfidf_cosine');
  assert.deepEqual([sim.kpis[0].numerator, sim.kpis[0].denominator, sim.kpis[0].complete], [2, 3, true]);
  const cl = await TX.engine.evaluate(configured('ITSM-054', { operation: 'cluster', table: 'incident', scope: '', text_field: 'short_description', threshold: 0.9, min_size: 2, require_no_link: 'problem_id', evidence_fields: [] }), ctx);
  assert.equal(cl.status, 'evaluated');
  assert.deepEqual(cl.clusters.map((c) => c.size), [2]);
  assert.deepEqual(cl.findings[0].target_ids, ['i1', 'i2']);
  const linked = await TX.engine.evaluate(configured('ITSM-054', { operation: 'cluster', table: 'incident', scope: '', text_field: 'short_description', threshold: 0.9, min_size: 2, require_no_link: 'problem_id', evidence_fields: [] }), ctxFor({ incident: incidents.map((i) => (i.sys_id === 'i2' ? { ...i, problem_id: 'p1' } : i)) }));
  assert.equal(linked.findings.length, 0, 'a cluster with a linked problem is not an offender');
  const fr = await TX.engine.evaluate(configured('ITSM-023', { operation: 'frequency', table: 'incident', scope: '', field: 'short_description', volume_share: 50, evidence_fields: [] }), ctx);
  assert.equal(fr.status, 'evaluated');
  assert.deepEqual(fr.frequency, [{ value: 'vpn down for all users', count: 2, share: 66.7 }]);
  const scan = await TX.engine.evaluate(configured('ITSM-028', { operation: 'pattern_scan', table: 'incident', scope: '', fields: ['description'], patterns: [{ name: 'card', regex: '\\b(?:[0-9][ -]?){13,19}\\b', checksum: 'luhn' }, { name: 'pan', regex: '\\b[A-Z]{5}[0-9]{4}[A-Z]\\b' }], evidence_fields: [] }), ctx);
  assert.equal(scan.status, 'evaluated');
  assert.deepEqual(scan.pattern_hits.by_pattern, { card: 1, pan: 1 });
  assert.deepEqual(scan.findings[0].target_ids, ['i1', 'i3']);
  assert.equal(JSON.stringify(scan.findings).includes('4111'), false, 'a matched value leaked into the finding');
  /* A sampled read (budget spent) says so on the kpi. */
  const tight = ctxFor({ incident: incidents });
  const sampled = await TX.engine.evaluate(configured('ITSM-021', { operation: 'similarity', table: 'incident', scope: 'resolved_atISNOTEMPTY', fields: ['short_description', 'close_notes'], threshold: 0.9, max_chars: 60, evidence_fields: [] }), tight);
  assert.equal(sampled.text.sampled, true);
  assert.equal(sampled.kpis[0].complete, false);
  /* A hidden text field → UNAVAILABLE at the capability gate, nothing read. */
  const hidden = ctxFor({ incident: incidents });
  const un = await TX.engine.evaluate(configured('ITSM-021', { operation: 'similarity', table: 'incident', fields: ['short_description', 'u_hidden'], threshold: 0.9 }), hidden);
  assert.equal(un.status, 'unavailable');
  assert.equal(hidden.client.calls.byTable.incident ?? 0, 0);
});

/* ════════════════════════ ENGINE 10 — composite ════════════════════════ */

test('COMPOSITE: a valid DAG orders dependencies first, deterministically; a cycle and an unknown dependency are refused', () => {
  const dag = CP.buildDag([{ id: 'ITSM-124', dependsOn: ['ITSM-123'] }, { id: 'ITSM-123' }, { id: 'ITSM-129', dependsOn: ['ITSM-016', 'ITSM-094'] }, { id: 'ITSM-016' }, { id: 'ITSM-094' }, { id: 'ITSM-125', dependsOn: ['ITSM-123'] }]);
  assert.equal(dag.edges, 4);
  assert.equal(CP.validateDag(dag), true);
  const order = CP.topologicalOrder(dag);
  assert.ok(order.indexOf('ITSM-123') < order.indexOf('ITSM-124') && order.indexOf('ITSM-123') < order.indexOf('ITSM-125'));
  assert.ok(order.indexOf('ITSM-016') < order.indexOf('ITSM-129') && order.indexOf('ITSM-094') < order.indexOf('ITSM-129'));
  assert.deepEqual(order, CP.topologicalOrder(dag), 'not deterministic');
  assert.deepEqual(CP.dependencyLookup(dag, 'ITSM-123'), { depends_on: [], depended_on_by: ['ITSM-124', 'ITSM-125'] });
  const cyclic = CP.buildDag([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['c'] }, { id: 'c', dependsOn: ['a'] }]);
  assert.deepEqual(CP.findCycle(cyclic), ['a', 'b', 'c', 'a']);
  assert.throws(() => CP.validateDag(cyclic), /cycle: a → b → c → a/);
  assert.throws(() => CP.buildDag([{ id: 'a', dependsOn: ['ghost'] }]), CP.DependencyError);
  assert.throws(() => CP.buildDag([{ id: 'a', dependsOn: ['a'] }]), /itself/);
});

test('COMPOSITE: the real catalogue’s consumes_output_of graph is acyclic and orders the six composite rules after their inputs', () => {
  const rules = getAllITSMRules().map((r) => ({ id: r.id, dependsOn: [...r.architecture.dependencies.consumes_output_of] }));
  const dag = CP.buildDag(rules);
  assert.equal(CP.findCycle(dag), null);
  const order = CP.topologicalOrder(dag);
  assert.equal(order.length, 139);
  for (const r of rules) for (const d of r.dependsOn) assert.ok(order.indexOf(d) < order.indexOf(r.id), `${d} must run before ${r.id}`);
});

test('COMPOSITE: runOrdered evaluates in order, caches results, hands inputs down, skips a dependant whose input did not evaluate, and propagates confidence', async () => {
  const ctx = ctxFor({});
  const calls = [];
  const rules = [
    { id: 'ITSM-123', dependsOn: [] }, { id: 'ITSM-124', dependsOn: ['ITSM-123'] }, { id: 'ITSM-016', dependsOn: [] }, { id: 'ITSM-094', dependsOn: [] }, { id: 'ITSM-129', dependsOn: ['ITSM-016', 'ITSM-094'] },
  ];
  const evaluateOne = async (rule, inputs) => {
    calls.push(rule.id);
    if (rule.id === 'ITSM-094') return { rule_id: rule.id, status: 'skipped', findings: [], skipped: [{ rule: rule.id, reason: 'x' }] };
    return { rule_id: rule.id, status: 'evaluated', findings: [{ confidence: rule.id === 'ITSM-123' ? 0.9 : 1 }], inputs: Object.keys(inputs) };
  };
  const first = await CP.runOrdered(rules, ctx, evaluateOne);
  assert.deepEqual(first.results.get('ITSM-124').inputs, ['ITSM-123']);
  assert.equal(first.results.get('ITSM-129').status, 'skipped');
  assert.match(first.results.get('ITSM-129').skipped[0].reason, /input ITSM-094 was skipped/);
  assert.equal(calls.length, 4, 'ITSM-129 was evaluated although its input was skipped');
  const again = await CP.runOrdered(rules, ctx, evaluateOne);
  assert.equal(calls.length, 4, 'a cached result was recomputed');
  assert.equal(again.cache.hits, 5);
  assert.equal(CP.propagateConfidence(1, [{ confidence: 0.9 }, { confidence: 0.85 }]), 0.85);
  assert.equal(CP.propagateConfidence(0.5, [{ confidence: 0.9 }]), 0.5);
  /* The engine contract: a composite over an evaluated input combines and inherits its confidence. */
  ctx.results.set('ITSM-123', first.results.get('ITSM-123'));
  const res = await CP.engine.evaluate(configured('ITSM-124', { inputs: ['ITSM-123'], combine: (inputs) => ({ findings: [{ ...inputs['ITSM-123'].findings[0], confidence: 1, kind: 'aggregate' }], kpis: [] }) }), ctx);
  assert.equal(res.status, 'evaluated');
  assert.equal(res.findings[0].confidence, 0.9, 'inherits ITSM-123 correlation confidence');
  ctx.results.delete('ITSM-123');
  const blocked = await CP.engine.evaluate(configured('ITSM-124', { inputs: ['ITSM-123'], combine: () => ({}) }), ctx);
  assert.equal(blocked.status, 'skipped');
});

test('REGISTRY: evaluateRule with a synthetic config runs the right engine; without one every rule is not_configured', async () => {
  const ctx = ctxFor({ incident: [{ sys_id: 'i1', active: 'true', close_notes: '' }] });
  const res = await evaluateRule('ITSM-020', ctx, { config: { table: 'incident', scope: 'active=true', predicates: [{ field: 'close_notes', op: 'empty' }] } });
  assert.equal(res.engine, 'record_predicate');
  assert.equal(res.status, 'evaluated');
  assert.equal(res.findings.length, 1);
  assert.equal((await evaluateRule('ITSM-020', ctx)).status, 'not_configured');
});
