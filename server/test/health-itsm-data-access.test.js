import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeInstance, platformMeta } from './helpers/itsm-fake-instance.js';

/*
 * ITSM PHASE 3 — data access (completeness), capability probes, the finding
 * contract, and the aggregate client wrapper.
 */

const { declareRequirement, fetchRows, fetchAggregate, fetchExists, fetchRequirement, createReadCache, isCompleteFor, isUsable, DataRequirementError } = await import('../src/health/itsm/data-access.js');
const { createProbes, canRun, CAPABILITY } = await import('../src/health/itsm/capability.js');
const F = await import('../src/health/itsm/findings.js');
const { adaptRule } = await import('../src/health/itsm/adapter.js');

const rows = (n, extra = () => ({})) => Array.from({ length: n }, (_, i) => ({ sys_id: `id${String(i).padStart(4, '0')}`, active: 'true', close_notes: i % 3 ? 'fixed it' : '', ...extra(i) }));

/* ════════════════════════ data completeness ════════════════════════ */

test('DATA: a requirement is validated and frozen; sys_id is always a field; ids strategy carries only identity plus keep', () => {
  const r = declareRequirement({ table: 'incident', fields: ['close_notes', 'close_notes', 'state'], query: 'active=true', sensitive: ['close_notes'] });
  assert.deepEqual([...r.fields], ['sys_id', 'close_notes', 'state']);
  assert.ok(Object.isFrozen(r));
  const ids = declareRequirement({ table: 'incident', fields: ['close_notes'], strategy: 'ids', keep: ['number'] });
  assert.deepEqual([...ids.fields], ['sys_id', 'number']);
  assert.throws(() => declareRequirement({ fields: [] }), DataRequirementError);
  assert.throws(() => declareRequirement({ table: 'incident', strategy: 'stream' }), DataRequirementError);
  assert.throws(() => declareRequirement({ table: 'incident', pageSize: 0 }), DataRequirementError);
});

test('DATA: a complete dataset — every row, every field, rowsFetched = totalKnown, pageCount by page size', async () => {
  const inst = fakeInstance({ incident: rows(1200) });
  const req = declareRequirement({ table: 'incident', fields: ['active', 'close_notes'], query: 'active=true', pageSize: 500 });
  const { rows: got, coverage } = await fetchRows(req, { client: inst });
  assert.equal(got.length, 1200);
  assert.equal(coverage.status, 'complete');
  assert.equal(coverage.isComplete, true);
  assert.equal(coverage.rowsComplete, true);
  assert.equal(coverage.rowsFetched, 1200);
  assert.equal(coverage.totalKnown, 1200);
  assert.equal(coverage.pageCount, 3, 'three pages of 500 (the aggregate total ends the walk on the third)');
  assert.equal(coverage.truncated, false);
  assert.equal(coverage.query, 'active=true');
  assert.deepEqual([...coverage.missingFields], []);
  assert.ok(isCompleteFor(coverage, ['close_notes']));
});

test('DATA: a partial dataset — truncated at maxRows is never complete; a missing field is limited; usable but not complete', async () => {
  const inst = fakeInstance({ incident: rows(1200) });
  const t = await fetchRows(declareRequirement({ table: 'incident', fields: ['active'], maxRows: 700, pageSize: 500 }), { client: inst });
  assert.equal(t.coverage.status, 'truncated');
  assert.equal(t.coverage.truncated, true);
  assert.equal(t.coverage.rowsFetched, 700);
  assert.equal(t.coverage.totalKnown, 1200);
  assert.equal(t.coverage.rowsComplete, false);
  assert.ok(isUsable(t.coverage) && !t.coverage.isComplete);
  /* A field the platform silently drops (ACL) — status limited, rowsComplete true, missingFields names it. */
  const l = await fetchRows(declareRequirement({ table: 'incident', fields: ['active', 'assignment_group'] }), { client: inst });
  assert.equal(l.coverage.status, 'limited');
  assert.equal(l.coverage.rowsComplete, true);
  assert.deepEqual([...l.coverage.missingFields], ['assignment_group']);
  assert.equal(isCompleteFor(l.coverage, ['active']), true);
  assert.equal(isCompleteFor(l.coverage, ['assignment_group']), false);
});

test('DATA: a failed query — 403 is forbidden, an absent table is unavailable, and neither yields rows or a claim', async () => {
  const inst = fakeInstance({ incident: rows(5) }, { forbidden: ['task_sla'], absent: ['em_alert'] });
  const f = await fetchRows(declareRequirement({ table: 'task_sla', fields: ['stage'] }), { client: inst });
  assert.equal(f.coverage.status, 'forbidden');
  assert.equal(f.rows.length, 0);
  assert.equal(f.coverage.isComplete, false);
  assert.match(f.coverage.error, /may not read task_sla/);
  const a = await fetchAggregate(declareRequirement({ table: 'em_alert', strategy: 'aggregate', groupBy: ['state'] }), { client: inst });
  assert.equal(a.coverage.status, 'unavailable');
  const e = await fetchExists(declareRequirement({ table: 'em_alert', strategy: 'exists' }), { client: inst });
  assert.equal(e.exists, null, 'a failed existence check is null, not false');
});

test('DATA: ids strategy pushes the predicate into the query and never retrieves the text field', async () => {
  const inst = fakeInstance({ change_request: rows(40, (i) => ({ backout_plan: i % 4 ? 'roll back' : '' })) });
  const req = declareRequirement({ table: 'change_request', strategy: 'ids', query: 'backout_planISEMPTY' });
  const { rows: got, coverage } = await fetchRows(req, { client: inst });
  assert.equal(got.length, 10);
  assert.ok(got.every((r) => Object.keys(r).join() === 'sys_id'), 'a text field was retrieved');
  assert.equal(coverage.status, 'complete');
  assert.equal(coverage.totalKnown, 10);
});

test('DATA: the aggregate strategy reads no rows and reports groups; exists reads one count', async () => {
  const inst = fakeInstance({ incident: rows(30, (i) => ({ priority: String(1 + (i % 3)), duration: i })) });
  const { groups, coverage } = await fetchAggregate(declareRequirement({ table: 'incident', strategy: 'aggregate', groupBy: ['priority'], avg: ['duration'] }), { client: inst });
  assert.equal(groups.length, 3);
  assert.equal(coverage.status, 'complete');
  assert.equal(inst.calls.query, 0, 'an aggregate read rows');
  const ex = await fetchRequirement(declareRequirement({ table: 'incident', strategy: 'exists', query: 'priority=1' }), { client: inst });
  assert.deepEqual([ex.exists, ex.count], [true, 10]);
});

test('DATA: the read cache serves the same requirement once, however many engines declare it', async () => {
  const inst = fakeInstance({ incident: rows(10) });
  const cache = createReadCache({ client: inst });
  const req = declareRequirement({ table: 'incident', fields: ['active'] });
  await Promise.all([cache.read(req), cache.read(req), cache.read(declareRequirement({ table: 'incident', fields: ['active'] }))]);
  assert.equal(inst.calls.byTable.incident, 2, 'one count + one page — not three reads');
  assert.equal(cache.size(), 1);
  const cov = await cache.coverage();
  assert.equal(cov.length, 1);
});

/* ════════════════════════ capability probes ════════════════════════ */

test('PROBES: table exists / absent / probe failure are AVAILABLE / UNAVAILABLE / UNKNOWN, and UNKNOWN never runs', async () => {
  const meta = platformMeta({ tables: { incident: { fields: ['priority', 'close_notes'] } }, audited: ['incident'] });
  const inst = fakeInstance({ ...meta, incident: rows(3) });
  const p = createProbes({ client: inst });
  assert.equal((await p.tableExists('incident')).state, CAPABILITY.AVAILABLE);
  assert.equal((await p.tableExists('cab_meeting')).state, CAPABILITY.UNAVAILABLE);
  const broken = createProbes({ client: { async query() { throw new Error('socket hang up'); }, async count() { throw new Error('x'); } } });
  const u = await broken.tableExists('incident');
  assert.equal(u.state, CAPABILITY.UNKNOWN);
  assert.match(u.reason, /probe failed/);
  assert.equal(canRun(u), false);
  assert.equal(canRun({ state: CAPABILITY.UNAVAILABLE }), false);
  assert.equal(canRun({ state: CAPABILITY.PARTIAL }), false);
  assert.equal(canRun({ state: CAPABILITY.PARTIAL }, { allowPartial: true }), true);
  assert.equal(canRun({ state: CAPABILITY.AVAILABLE }), true);
});

test('PROBES: fields exist / partially / not at all; audit on and off; readable vs forbidden; probes are cached per run', async () => {
  const meta = platformMeta({ tables: { task: { fields: ['priority'] }, incident: { fields: ['close_notes'], superClass: 'task' }, cmdb_ci: { fields: ['name'] } }, audited: ['incident'] });
  const inst = fakeInstance({ ...meta, incident: rows(2), cmdb_ci: [], task_sla: [] }, { forbidden: ['task_sla'] });
  const p = createProbes({ client: inst });
  assert.equal((await p.fieldsExist('incident', ['priority', 'close_notes'])).state, CAPABILITY.AVAILABLE, 'inherited field via super_class');
  const part = await p.fieldsExist('incident', ['close_notes', 'business_criticality']);
  assert.equal(part.state, CAPABILITY.PARTIAL);
  assert.deepEqual(part.missing, ['business_criticality']);
  assert.equal((await p.fieldsExist('incident', ['nope'])).state, CAPABILITY.UNAVAILABLE);
  assert.equal((await p.auditEnabled('incident')).state, CAPABILITY.AVAILABLE);
  assert.equal((await p.auditEnabled('cmdb_ci')).state, CAPABILITY.UNAVAILABLE);
  assert.match((await p.auditEnabled('cmdb_ci')).reason, /not audited/);
  assert.equal((await p.readable('incident')).state, CAPABILITY.AVAILABLE);
  const n = inst.calls.query;
  await p.readable('incident'); await p.auditEnabled('incident'); await p.tableExists('incident');
  assert.equal(inst.calls.query, n, 'a cached probe hit the instance again');
  const obj = await p.configurationObject('major_incident_config');
  assert.equal(obj.state, CAPABILITY.UNKNOWN);
  assert.match(obj.reason, /UNDEFINED/);
  const combined = p.combine([{ state: CAPABILITY.AVAILABLE, reason: 'a' }, { state: CAPABILITY.UNKNOWN, reason: 'b' }, { state: CAPABILITY.UNAVAILABLE, reason: 'c' }]);
  assert.equal(combined.state, CAPABILITY.UNAVAILABLE);
});

/* ════════════════════════ finding contract ════════════════════════ */

test('FINDINGS: each kind carries the base shape every consumer reads plus its own detail; fingerprints are stable per kind', () => {
  const rule = adaptRule('ITSM-020');
  const at = '2026-09-16T12:00:00.000Z';
  const rec = F.recordFinding({ rule, table: 'incident', records: [{ sys_id: 'b', close_notes: '' }, { sys_id: 'a', close_notes: 'x' }], fields: ['close_notes'], title: 't', description: 'd', severity: 'CRITICAL', collected_at: at });
  for (const k of ['fingerprint', 'rule_id', 'agent_id', 'domain', 'table', 'target_ids', 'title', 'description', 'severity', 'confidence', 'estate_wide', 'evidence', 'kind', 'detail']) assert.ok(k in rec, k);
  assert.equal(rec.kind, 'record');
  assert.equal(rec.evidence.length, 2);
  assert.equal(rec.fingerprint, F.fingerprintFor('record', { rule_id: 'ITSM-020', table: 'incident', target_ids: ['a', 'b'] }), 'record fingerprint must match rules.js (rule|table|sorted ids)');
  assert.equal(rec.estate_wide, false);

  const agg = F.aggregateFinding({ rule: adaptRule('ITSM-001'), table: 'incident', metric: { measure: 'share', observed: 82.5, threshold: { op: 'gt', value: 70 }, breached: true, population: 400, percentage: 82.5 }, group: { priority: '3' }, title: 't', description: 'd', severity: 'SYSTEMIC', collected_at: at });
  assert.equal(agg.kind, 'aggregate');
  assert.equal(agg.estate_wide, true);
  assert.deepEqual([agg.detail.observed, agg.detail.expected.value, agg.detail.population, agg.detail.breached], [82.5, 70, 400, true]);
  assert.equal(agg.fingerprint, F.aggregateFinding({ rule: adaptRule('ITSM-001'), table: 'incident', metric: { measure: 'share', observed: 1 }, group: { priority: '3' }, title: 't', description: 'd', severity: 'LOW', collected_at: at }).fingerprint, 'the same metric over the same group is the same fact');

  const cfg = F.configurationFinding({ rule: adaptRule('ITSM-003'), object: 'sla_definition', table: 'contract_sla', records: [], observed: 'no definition covers priority 4', expected: 'a start condition per band with volume', title: 't', description: 'd', severity: 'SYSTEMIC', collected_at: at });
  assert.equal(cfg.kind, 'configuration');
  assert.equal(cfg.detail.absent, true);

  const hist = F.historicalFinding({ rule: adaptRule('ITSM-072'), table: 'problem', records: [{ sys_id: 'p1' }], field: 'state', window: { start_snow: 'a', end_snow: 'b' }, events: { p1: 3 }, transitions: [{ sys_id: 'p1', field: 'state', from: '3', to: '1', at: 'x' }], title: 't', description: 'd', severity: 'MEDIUM', collected_at: at });
  assert.equal(hist.kind, 'historical');
  assert.deepEqual(hist.detail.window, { start: 'a', end: 'b' });
  assert.equal(hist.detail.transitions, 1);

  const rel = F.relationshipFinding({ rule: adaptRule('ITSM-126'), source: { table: 'change_request', sys_id: 'c1' }, target: { table: 'cmdb_ci_service', sys_id: 's1' }, relationship: 'path_to_service', path: [{ table: 'cmdb_ci', sys_id: 'x' }, { table: 'cmdb_ci', sys_id: 'y' }], depth: 2, title: 't', description: 'd', severity: 'CRITICAL', collected_at: at });
  assert.equal(rel.kind, 'relationship');
  assert.deepEqual(rel.affected_ci_ids, ['x', 'y']);
  assert.equal(rel.detail.depth, 2);

  const xd = F.crossDomainFinding({ rule: adaptRule('ITSM-123'), table: 'incident', records: [{ sys_id: 'i1' }], related_domain: 'CMDB', provenance: { window: '72 hours', depends_on: 'cmdb_rel_ci complete' }, title: 't', description: 'd', severity: 'SYSTEMIC', collected_at: at });
  assert.equal(xd.kind, 'cross_domain');
  assert.equal(xd.detail.related_domain, 'CMDB');
  assert.equal(xd.detail.provenance.window, '72 hours');
});

test('FINDINGS: sensitive fields never carry a value in evidence; a bad severity or confidence is refused', () => {
  const rule = adaptRule('ITSM-028');
  const f = F.recordFinding({ rule, table: 'incident', records: [{ sys_id: 'i1', description: '4111 1111 1111 1111', number: 'INC1' }], fields: ['description', 'number'], sensitive: ['description'], title: 't', description: 'd', severity: 'CRITICAL', collected_at: 'x' });
  const desc = f.evidence.find((e) => e.field_name === 'description');
  assert.equal(desc.field_value, F.REDACTED);
  assert.equal(desc.redacted, true);
  assert.equal(f.evidence.find((e) => e.field_name === 'number').field_value, 'INC1');
  assert.throws(() => F.recordFinding({ rule, table: 'incident', records: [], fields: [], title: 't', description: 'd', severity: 'Critical', collected_at: 'x' }), F.FindingError);
  assert.throws(() => F.recordFinding({ rule, table: 'incident', records: [], fields: [], title: 't', description: 'd', severity: 'HIGH', confidence: 1.5, collected_at: 'x' }), F.FindingError);
  assert.equal(F.skip(rule, { reason: 'why', capability: 'UNKNOWN' }).rule, 'ITSM-028');
});
