import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate, getDb } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-incremental-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'i.db'))));
const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev000001.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const { MODULE_KEYS, normaliseModules, moduleTables, scopeOf, scopeOfRule, RULE_SCOPE } = await import('../src/health/scopes.js');
const { AGENTS, EstateRules } = await import('../src/health/rules.js');
const { TABLES, specHash, sliceWhere } = await import('../src/health/tables.js');
const { fetchTable, extractEstate, extractCmdbMeta, cmdbMetaSources } = await import('../src/health/extract.js');
const { planScan, engineKeys } = await import('../src/health/incremental.js');
const { runHealthCheck } = await import('../src/health/index.js');
const store = await import('../src/health/store.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-09-15T10:00:00Z');

/*
 * Health Assist — module scans and the incremental change check (15 Sep 2026).
 *
 * Decisions this file pins:
 *   - A scan names its modules (CMDB, ITOM, ITSM, Platform; Full = all four),
 *     and each module keeps its own latest result and time.
 *   - Configuration lives in the NowForge database, not in ServiceNow.
 *   - No local copy of records: a module whose inputs are unchanged keeps its
 *     result; a changed module is re-read in full.
 *   - Deletions: the instance's deletion log where it keeps one, the count
 *     everywhere.
 *   - A timestamp moves only after a scan completes; a failed scan keeps the old one.
 */

/* ════════════════════════ modules ════════════════════════ */

test('modules: nothing or "all" means all four; an unknown module is refused, not ignored', () => {
  assert.deepEqual(normaliseModules(undefined), ['cmdb', 'itom', 'itsm', 'platform']);
  assert.deepEqual(normaliseModules('all'), MODULE_KEYS);
  assert.deepEqual(normaliseModules(['itsm', 'CMDB']), ['cmdb', 'itsm']);
  assert.throws(() => normaliseModules(['itsm', 'hr']), (e) => e.status === 422 && /hr/.test(e.message));
  assert.ok(moduleTables(['itsm']).includes('incident'));
  assert.ok(!moduleTables(['itsm']).includes('cmdb_ci'), 'ITSM declares the CMDB tables it does not own');
});

test('a rule id names the SAME module as its finding, for every rule the pack can emit', () => {
  /* Findings are placed by domain, skipped checks by rule id. If the two ever
     disagreed, a module-limited scan would drop a module's own skips. */
  const src = ['rules.js', 'cmdb-gate.js', 'cmdb-completeness.js', 'cmdb-correctness.js', 'cmdb-uniqueness.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '../src/health', f), 'utf8')).join('\n');
  const pairs = [...src.matchAll(/this\.add\('(\w+)', '([A-Z][A-Z0-9-]+)'/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length > 40, `found only ${pairs.length} rules — the pattern is wrong, not the pack`);
  for (const [agent, rule] of pairs) {
    const domain = AGENTS[agent][0];
    assert.equal(scopeOfRule(rule), scopeOf({ rule_id: rule, domain }), `${rule} (${domain})`);
  }
  for (const rule of Object.keys(RULE_SCOPE)) assert.equal(scopeOfRule(rule), RULE_SCOPE[rule]);
  assert.equal(scopeOfRule('CMDB-141'), 'cmdb');
});

const full = () => Object.fromEntries(Object.keys(TABLES).map((t) => [t, { table: t, status: 'complete', rows_complete: true, records: 0, missing_fields: [] }]));

test('a module-limited analysis reports only that module, and records what each module read', () => {
  const r = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [], incident: [], change_request: [], problem: [] }, full(), 90, NOW);
  r.analyze({ modules: ['itsm'] });
  assert.ok(r.findings.every((f) => scopeOf(f) === 'itsm'), 'a non-ITSM finding survived an ITSM-only analysis');
  assert.ok(r.skipped.every((s) => scopeOfRule(s.rule) === 'itsm'), 'a non-ITSM skip survived an ITSM-only analysis');
  assert.deepEqual(Object.keys(r.dependencies), ['itsm']);
  assert.ok(r.dependencies.itsm.includes('incident'));
  assert.ok(!r.dependencies.itsm.includes('cmdb_rel_ci'), 'impact synthesis was charged to ITSM');

  const all = new EstateRules({ cmdb_ci: [], cmdb_rel_ci: [] }, full(), 90, NOW);
  all.analyze();
  assert.deepEqual(Object.keys(all.dependencies).sort(), ['cmdb', 'itom', 'itsm', 'platform']);
  assert.ok(all.dependencies.cmdb.includes('cmdb_ci'));
  assert.ok(all.dependencies.itom.includes('ecc_agent'), 'the platform family\'s ITOM rules were not charged to ITOM');
  assert.ok(!all.dependencies.itom.includes('sys_script'), 'a Platform table was charged to ITOM');
  assert.ok(all.dependencies.platform.includes('sys_script'));
  assert.equal(all.estate.cmdb_ci !== undefined, true, 'the watched estate was not restored');
});

/* ════════════════════════ stamps at read time ════════════════════════ */

test('the stamp is the count call: one request gives the total and the newest update, taken before the walk', async () => {
  const calls = [];
  const client = {
    changeStamp: async (t, where) => { calls.push(['stamp', where]); return { count: 1, maxUpdated: '2026-09-10 00:00:00' }; },
    count: async () => { calls.push(['count']); return 1; },
    query: async (t, { query }) => { calls.push(['page']); return query.includes('^sys_id>') ? [] : [{ sys_id: 'a', sys_updated_on: '2026-09-10 00:00:00' }]; },
  };
  const { stamp, coverage } = await fetchTable('problem', { cutoff: '2026-09-15 00:00:00', client, stamp: true });
  assert.equal(calls[0][0], 'stamp', 'the stamp was not taken before the walk');
  assert.ok(!calls.some((c) => c[0] === 'count'), 'a second count was made beside the stamp');
  assert.equal(coverage.reported_total, 1);
  assert.deepEqual([stamp.count, stamp.max_updated], [1, '2026-09-10 00:00:00']);
  assert.match(calls[0][1], /^sys_updated_on<=2026-09-15 00:00:00\^active=true\^ORsys_updated_on>=/, 'the stamp and the read used different slices');
});

test('a read that walked to its end is stamped even when ACLs hide rows; a read cut off by the limit is not', async () => {
  /* Measured on dev424910: sys_script shows 5,729 of 5,796 rows on every read.
     Refusing a stamp there made Platform unreusable for ever. */
  const hidden = {
    changeStamp: async () => ({ count: 900, maxUpdated: '2026-09-10 00:00:00' }),
    query: async (t, { query }) => (query.includes('^sys_id>') ? [] : [{ sys_id: 'a', sys_updated_on: '2026-09-10 00:00:00' }]),
  };
  const seen = await fetchTable('cmdb_rel_ci', { cutoff: '2026-09-15 00:00:00', client: hidden, stamp: true });
  assert.equal(seen.coverage.rows_complete, false);
  assert.equal(seen.stamp.count, 900, 'an ACL-limited read that finished its walk got no stamp');

  const endless = {
    changeStamp: async () => ({ count: 5000, maxUpdated: '2026-09-10 00:00:00' }),
    query: async (t, { query, limit }) => {
      const after = Number(/\^sys_id>r(\d+)/.exec(query)?.[1] ?? -1);
      return Array.from({ length: limit }, (_, i) => ({ sys_id: `r${String(after + 1 + i).padStart(6, '0')}`, sys_updated_on: '2026-09-10 00:00:00' }));
    },
  };
  const cut = await fetchTable('cmdb_rel_ci', { cutoff: '2026-09-15 00:00:00', client: endless, stamp: true, limit: 1000 });
  assert.equal(cut.coverage.status, 'truncated');
  assert.equal(cut.stamp, null, 'a read cut off by the row limit was stamped');
});

test('a table that cannot be read is stamped with how it failed', async () => {
  const client = {
    changeStamp: async (t) => { if (t === 'em_alert') throw Object.assign(new Error('Invalid table em_alert'), { status: 400 }); return { count: 0, maxUpdated: null }; },
    query: async (t) => { if (t === 'em_alert') throw Object.assign(new Error('Invalid table em_alert'), { status: 400 }); return []; },
  };
  const { stamps, coverage } = await extractEstate(['cmdb_ci', 'cmdb_rel_ci', 'em_alert'], { client, stamps: true });
  assert.equal(coverage.em_alert.status, 'unavailable');
  assert.equal(stamps.em_alert.status, 400);
  assert.ok(Number.isFinite(coverage.cmdb_ci.ms), 'a table read carries no duration');
});

/* ════════════════════════ the plan ════════════════════════ */

const KEYS = engineKeys({ staleDays: 90 });
const stamp = (count, max) => ({ count, max_updated: max, taken_at: '2026-09-15T09:00:00.000Z' });

function baseline(over = {}) {
  const stamps = { incident: stamp(58, '2026-09-15 08:00:00'), change_request: stamp(93, '2026-09-10 00:00:00'), problem: stamp(15, '2026-09-01 00:00:00') };
  return {
    itsm: {
      runId: 'run-1', status: 'completed', checkedAt: '2026-09-15T09:00:00.000Z', engineKey: KEYS.itsm, user: 'admin',
      dependencies: ['incident', 'change_request', 'problem'], stamps,
      specHashes: Object.fromEntries(Object.keys(stamps).map((t) => [t, specHash(t)])),
      ...over,
    },
  };
}

function stampClient(now = {}, { deletions = {}, logged = [] } = {}) {
  const asked = [];
  return {
    asked,
    changeStamp: async (t, q) => {
      asked.push([t, q]);
      const s = now[t];
      if (s instanceof Error) throw s;
      return s ? { count: s.count, maxUpdated: s.max_updated } : { count: 0, maxUpdated: null };
    },
    countBy: async () => deletions,
    query: async (t) => (t === 'sys_dictionary' ? logged.map((name) => ({ name })) : []),
  };
}

const same = { incident: stamp(58, '2026-09-15 08:00:00'), change_request: stamp(93, '2026-09-10 00:00:00'), problem: stamp(15, '2026-09-01 00:00:00') };

test('PLAN: unchanged inputs keep the result — verified now, nothing read', async () => {
  const client = stampClient(same);
  const plan = await planScan({ modules: ['itsm'], client, baselines: baseline(), engineKeys: KEYS, user: 'admin', now: NOW });
  assert.deepEqual([plan.reuse, plan.read], [['itsm'], []]);
  assert.equal(plan.modules.itsm.source_run_id, 'run-1');
  assert.equal(plan.modules.itsm.verified_at, NOW.toISOString());
  assert.equal(client.asked.find(([t]) => t === 'incident')[1], sliceWhere('incident', '2026-09-15 10:00:00'),
    'the check and the read ask different questions — a record dated in the future would look like a change for ever');
});

test('PLAN: an insert or update moves the newest timestamp; a delete moves the count — either re-reads', async () => {
  const updated = await planScan({ modules: ['itsm'], client: stampClient({ ...same, incident: stamp(58, '2026-09-15 09:30:00') }), baselines: baseline(), engineKeys: KEYS, user: 'admin', now: NOW });
  assert.deepEqual(updated.read, ['itsm']);
  assert.match(updated.modules.itsm.reasons.join(' '), /incident: records updated since the last read \(newest change 2026-09-15 09:30:00\)/);

  const deleted = await planScan({
    modules: ['itsm'], client: stampClient({ ...same, problem: stamp(14, '2026-09-01 00:00:00') }, { logged: ['problem'], deletions: { problem: 1 } }),
    baselines: baseline(), engineKeys: KEYS, user: 'admin', now: NOW,
  });
  assert.deepEqual(deleted.read, ['itsm']);
  assert.match(deleted.modules.itsm.reasons.join(' '), /problem: row count moved from 15 to 14; 1 deletion\(s\) logged in sys_audit_delete/);
  assert.equal(deleted.tables.problem.deletion_log, true);
  assert.equal(deleted.tables.incident.deletion_log, false, 'a table without a deletion log was reported as logged');
});

test('PLAN: a logged deletion re-reads even if the count and newest update did not move', async () => {
  const plan = await planScan({ modules: ['itsm'], client: stampClient(same, { logged: ['incident'], deletions: { incident: 2 } }), baselines: baseline(), engineKeys: KEYS, user: 'admin', now: NOW });
  assert.deepEqual(plan.read, ['itsm']);
  assert.match(plan.modules.itsm.reasons.join(' '), /incident: 2 deletion\(s\) logged/);
});

test('PLAN: what rules out reuse before any stamp — rules changed, another account, too old, full re-read asked for, never scanned', async () => {
  const client = stampClient(same);
  const run = (b, over = {}) => planScan({ modules: ['itsm'], client, baselines: b, engineKeys: KEYS, user: 'admin', now: NOW, ...over });
  assert.match((await run(baseline({ engineKey: 'older' }))).modules.itsm.reasons[0], /rules, settings or accepted risks changed/);
  assert.match((await run(baseline({ user: 'someone.else' }))).modules.itsm.reasons[0], /different ServiceNow account/);
  assert.match((await run(baseline({ checkedAt: '2026-09-14T08:00:00.000Z' }))).modules.itsm.reasons[0], /read 26 h ago/);
  assert.match((await run(baseline(), { reuse: false })).modules.itsm.reasons[0], /full re-read was requested/);
  assert.match((await run({})).modules.itsm.reasons[0], /no earlier result/);
  assert.match((await run(baseline({ stamps: null }))).modules.itsm.reasons.join(' '), /before change stamps existed/);
});

test('PLAN: a result produced with reads that failed is never kept', async () => {
  const plan = await planScan({
    modules: ['itsm'], client: stampClient(same),
    baselines: baseline({ degraded: ['incident: rate_limited'] }), engineKeys: KEYS, user: 'admin', now: NOW,
  });
  assert.deepEqual(plan.read, ['itsm']);
  assert.match(plan.modules.itsm.reasons[0], /reads that failed \(incident: rate_limited\)/);
});

test('PLAN: a table switched off, a changed field list, or an input with no stamp is always re-read', async () => {
  const client = stampClient(same);
  const off = await planScan({ modules: ['itsm'], client, baselines: baseline(), tableSettings: { problem: { enabled: false } }, engineKeys: KEYS, user: 'admin', now: NOW });
  assert.match(off.modules.itsm.reasons.join(' '), /problem: incremental checking is switched off/);
  const b = baseline();
  b.itsm.specHashes.incident = 'fields-before';
  assert.match((await planScan({ modules: ['itsm'], client, baselines: b, engineKeys: KEYS, user: 'admin', now: NOW })).modules.itsm.reasons.join(' '), /incident: the fields read from it changed/);
  const missing = baseline();
  delete missing.itsm.stamps.change_request;
  assert.match((await planScan({ modules: ['itsm'], client, baselines: missing, engineKeys: KEYS, user: 'admin', now: NOW })).modules.itsm.reasons.join(' '), /change_request: was not read to the end/);
});

test('PLAN: a table that fails the same way as at the last read is unchanged; failing differently is a change', async () => {
  const b = baseline();
  b.itsm.dependencies.push('em_alert');
  b.itsm.stamps.em_alert = { error: 'Invalid table em_alert', status: 400, taken_at: '2026-09-15T09:00:00.000Z' };
  const gone = Object.assign(new Error('Invalid table em_alert'), { status: 400 });
  assert.deepEqual((await planScan({ modules: ['itsm'], client: stampClient({ ...same, em_alert: gone }), baselines: b, engineKeys: KEYS, user: 'admin', now: NOW })).reuse, ['itsm']);
  const forbidden = Object.assign(new Error('forbidden'), { status: 403 });
  assert.deepEqual((await planScan({ modules: ['itsm'], client: stampClient({ ...same, em_alert: forbidden }), baselines: b, engineKeys: KEYS, user: 'admin', now: NOW })).read, ['itsm']);
});

test('PLAN: a record dated in the future does not make its table look changed for ever', async () => {
  /* Measured on dev424910: one change_request carries sys_updated_on 2035-08-22.
     A check without the read's own cutoff counted it and the read never did. */
  const rows = [
    { sys_id: 'a', sys_updated_on: '2026-09-10 00:00:00', active: 'true' },
    { sys_id: 'future', sys_updated_on: '2035-08-22 12:30:56', active: 'false' },
  ];
  const instance = {
    changeStamp: async (t, where) => {
      const bound = /sys_updated_on<=([^^]+)/.exec(where)?.[1] ?? null;
      const visible = rows.filter((r) => !bound || r.sys_updated_on <= bound);
      return { count: visible.length, maxUpdated: visible.map((r) => r.sys_updated_on).sort().pop() || null };
    },
    query: async (t, { query }) => (query.includes('^sys_id>') ? [] : rows.filter((r) => r.sys_updated_on <= /sys_updated_on<=([^^]+)/.exec(query)[1])),
  };
  const { stamp } = await fetchTable('change_request', { cutoff: '2026-09-15 09:00:00', client: instance, stamp: true });
  assert.equal(stamp.count, 1, 'the read counted a record it did not read');
  /* The other ITSM tables are unchanged; only change_request carries the future row. */
  const base = baseline().itsm;
  const b = { itsm: { ...base, stamps: { ...base.stamps, change_request: { ...stamp, taken_at: '2026-09-15T09:00:00.000Z' } } } };
  const client = { ...stampClient(same), changeStamp: async (t, where) => (t === 'change_request' ? instance.changeStamp(t, where) : (same[t] ? { count: same[t].count, maxUpdated: same[t].max_updated } : { count: 0, maxUpdated: null })) };
  const plan = await planScan({ modules: ['itsm'], client, baselines: b, engineKeys: KEYS, user: 'admin', now: NOW });
  assert.deepEqual(plan.reuse, ['itsm'], `a future-dated record was read as a change: ${plan.modules.itsm.reasons.join('; ')}`);
});

test('PLAN: a log table is stamped by sys_created_on, and a new log row is a change', async () => {
  const b = baseline();
  b.itsm.dependencies.push('discovery_log');
  b.itsm.stamps.discovery_log = { count: 3, max_updated: '2026-09-14 00:00:00', basis: 'sys_created_on', taken_at: '2026-09-15T09:00:00.000Z' };
  const logs = (count, max) => ({ ...same, discovery_log: { count, max_updated: max, basis: 'sys_created_on' } });
  const client = (now) => ({ ...stampClient(now), changeStamp: async (t) => {
    const x = now[t];
    return x ? { count: x.count, maxUpdated: x.max_updated, basis: x.basis } : { count: 0, maxUpdated: null };
  } });
  assert.deepEqual((await planScan({ modules: ['itsm'], client: client(logs(3, '2026-09-14 00:00:00')), baselines: b, engineKeys: KEYS, user: 'admin', now: NOW })).reuse, ['itsm']);
  const added = await planScan({ modules: ['itsm'], client: client(logs(4, '2026-09-15 09:59:00')), baselines: b, engineKeys: KEYS, user: 'admin', now: NOW });
  assert.match(added.modules.itsm.reasons.join(' '), /discovery_log: row count moved from 3 to 4/);
});

test('PLAN: CMDB also compares its governance reads, each against its own stamp', async () => {
  const cmdbStamps = { cmdb_ci: stamp(10, '2026-09-11 00:00:00') };
  const b = {
    cmdb: {
      runId: 'r', checkedAt: '2026-09-15T09:00:00.000Z', engineKey: KEYS.cmdb, user: 'admin', dependencies: ['cmdb_ci'],
      stamps: Object.fromEntries(moduleTables(['cmdb']).map((t) => [t, cmdbStamps[t] || stamp(0, null)])),
      specHashes: {},
      metaStamps: { dictionary: { table: 'sys_dictionary', query: 'nameSTARTSWITHcmdb', count: 500, max_updated: '2026-09-01 00:00:00' } },
    },
  };
  const now = { ...cmdbStamps, sys_dictionary: stamp(500, '2026-09-01 00:00:00') };
  assert.deepEqual((await planScan({ modules: ['cmdb'], client: stampClient(now), baselines: b, engineKeys: KEYS, user: 'admin', now: NOW })).reuse, ['cmdb']);
  const changed = await planScan({ modules: ['cmdb'], client: stampClient({ ...now, sys_dictionary: stamp(501, '2026-09-15 09:59:00') }), baselines: b, engineKeys: KEYS, user: 'admin', now: NOW });
  assert.deepEqual(changed.read, ['cmdb']);
  assert.match(changed.modules.cmdb.reasons.join(' '), /sys_dictionary \(dictionary\): row count moved from 500 to 501/);
  delete b.cmdb.metaStamps;
  assert.match((await planScan({ modules: ['cmdb'], client: stampClient(now), baselines: b, engineKeys: KEYS, user: 'admin', now: NOW })).modules.cmdb.reasons.join(' '), /governance reads were recorded before/);
});

test('PLAN: accepting a risk invalidates only its own module', () => {
  const before = engineKeys({ staleDays: 90 });
  const after = engineKeys({ staleDays: 90, acceptedRules: [{ fingerprint: 'fp', ruleId: 'ITSM-INC-STALE' }] });
  assert.notEqual(after.itsm, before.itsm);
  assert.equal(after.cmdb, before.cmdb);
  assert.notEqual(engineKeys({ staleDays: 30 }).cmdb, before.cmdb, 'a settings change did not invalidate');
});

test('PLAN: Stop is honoured during the change check', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    planScan({ modules: ['itsm'], client: stampClient(same), baselines: baseline(), engineKeys: KEYS, user: 'admin', now: NOW, signal: controller.signal }),
    (e) => e.name === 'AbortError',
  );
});

test('the CMDB governance reads touch no table the change check does not cover', async () => {
  const estate = {
    cmdb_ci: [{ sys_id: 'c1', sys_class_name: 'cmdb_ci_computer' }, { sys_id: 'c2', sys_class_name: 'u_custom_device' }],
    sysauto_script: [{ sys_id: 'j1', name: 'CMDB Health Dashboard' }],
    cmdb_identifier_entry: [{ sys_id: 'e1', identifier: 'i1', table: 'cmdb_serial_number', attributes: 'serial_number' }],
    cmdb_data_management_policy: [{ sys_id: 'p1', policy_execution_job: 'x' }],
    change_request: [{ sys_id: 'ch1', cmdb_ci: 'c1' }],
    cmdb_health_config: [{ sys_id: 'h1', applies_to: 'cmdb_ci_computer', active_record_condition: '' }],
  };
  const touched = new Set();
  const client = {
    count: async (t) => { touched.add(t); return 1; },
    query: async (t, { query }) => {
      touched.add(t);
      if (t === 'sys_db_object') return String(query).split('IN')[1]?.split(',').map((name) => ({ sys_id: name, name, 'super_class.name': name === 'cmdb_ci' ? '' : 'cmdb_ci' })) || [];
      return [];
    },
  };
  await extractCmdbMeta(estate, { client });
  const covered = new Set(cmdbMetaSources(estate).map((s) => s.table));
  const classes = new Set(['cmdb_ci', ...estate.cmdb_ci.map((c) => c.sys_class_name)]);
  const escaped = [...touched].filter((t) => !TABLES[t] && !covered.has(t) && !classes.has(t) && !t.startsWith('cmdb_ci'));
  assert.deepEqual(escaped, [], `governance reads the change check cannot see: ${escaped.join(', ')}`);
});

/* ════════════════════════ end to end, through the real run ════════════════════════ */

/**
 * An in-memory instance: rows per table, a keyset Table API, and Aggregate
 * counts with the newest sys_updated_on. Every request is counted, so a test
 * can say "nothing was read".
 */
function fakeInstance(tables) {
  const calls = { pages: 0, stamps: 0 };
  return {
    calls,
    tables,
    async changeStamp(t) {
      calls.stamps += 1;
      if (!(t in TABLES) && !tables[t]) return { count: 0, maxUpdated: null };
      const rows = tables[t] || [];
      return { count: rows.length, maxUpdated: rows.map((r) => r.sys_updated_on).sort().pop() || null };
    },
    async count(t) { return (tables[t] || []).length; },
    async countBy() { return {}; },
    async query(t, { query, limit }) {
      if (TABLES[t]) calls.pages += 1;
      const rows = [...(tables[t] || [])].sort((a, b) => a.sys_id.localeCompare(b.sys_id));
      const after = /\^sys_id>([^^]+)/.exec(String(query))?.[1] ?? null;
      const start = after == null ? 0 : rows.findIndex((r) => r.sys_id > after);
      return start < 0 ? [] : rows.slice(start, start + limit);
    },
  };
}

/** The baselines the route would read, built from runs held in memory. */
function baselinesFrom(results) {
  const out = {};
  for (const m of MODULE_KEYS) {
    const r = [...results].reverse().find((x) => (x.manifest.modules || []).includes(m));
    if (!r) continue;
    out[m] = {
      runId: r.id, status: r.status, checkedAt: r.at, engineKey: r.manifest.engine_keys[m], user: r.manifest.connection_user,
      dependencies: r.manifest.dependencies[m], stamps: r.manifest.stamps, specHashes: r.manifest.spec_hashes,
      metaStamps: m === 'cmdb' ? r.manifest.meta_stamps : undefined,
    };
  }
  return out;
}

test('END TO END: full scan, then nothing changed (nothing read), then one incident changes (only ITSM read)', async () => {
  const instance = fakeInstance({
    cmdb_ci: [{ sys_id: 'c1', name: 'srv', sys_class_name: 'cmdb_ci_server', sys_updated_on: '2026-09-11 00:00:00' }],
    incident: [{ sys_id: 'i1', number: 'INC1', active: 'true', sys_updated_on: '2026-09-15 08:00:00' }],
  });
  const history = [];
  const scan = async (opts = {}) => {
    const at = new Date(NOW.getTime() + history.length * 60_000);
    const r = await runHealthCheck({ client: instance, explain: false, user: 'admin', now: at, baselines: baselinesFrom(history), ...opts });
    history.push({ id: `run-${history.length + 1}`, at: at.toISOString(), ...r });
    return r;
  };

  const first = await scan();
  assert.deepEqual(first.manifest.modules, ['cmdb', 'itom', 'itsm', 'platform']);
  assert.deepEqual(first.manifest.degraded, {}, 'a clean scan was recorded as degraded');
  assert.ok(first.manifest.stamps.incident && first.manifest.stamps.cmdb_ci, 'the full scan recorded no stamps');
  assert.ok(first.manifest.meta_stamps, 'the CMDB governance reads were not stamped');
  assert.ok(first.manifest.phases.extract_ms >= 0);

  const pagesBefore = instance.calls.pages;
  const second = await scan();
  assert.equal(second.manifest.kind, 'verification');
  assert.deepEqual(second.manifest.verified_modules, ['cmdb', 'itom', 'itsm', 'platform']);
  assert.equal(instance.calls.pages, pagesBefore, 'an unchanged instance was read again');
  assert.equal(second.findings.length, 0);

  instance.tables.incident[0] = { ...instance.tables.incident[0], sys_updated_on: '2026-09-15 10:30:00' };
  const third = await scan();
  assert.deepEqual(third.manifest.modules, ['itsm']);
  assert.deepEqual(third.manifest.verified_modules, ['cmdb', 'itom', 'platform']);
  assert.match(third.manifest.plan.modules.itsm.reasons.join(' '), /incident: records updated since the last read/);
  assert.ok(Object.keys(third.manifest.scopes).every((k) => ['all', 'itsm'].includes(k)), 'an ITSM re-read carried other modules\' summaries');
  assert.equal(third.manifest.metrics.cmdb_quality_score, null, 'an ITSM-only scan produced a CMDB number');
});

test('END TO END: a module-limited scan reads only its own tables and reports only its own module', async () => {
  const instance = fakeInstance({ cmdb_ci: [], incident: [] });
  const r = await runHealthCheck({ client: instance, explain: false, modules: ['platform'], user: 'admin', now: NOW });
  assert.deepEqual(r.manifest.modules, ['platform']);
  const requested = Object.values(r.manifest.coverage).filter((c) => c.status !== 'not_requested').map((c) => c.table).sort();
  assert.deepEqual(requested, [...new Set([...moduleTables(['platform']), 'cmdb_ci', 'cmdb_rel_ci'])].sort());
  assert.ok(r.findings.every((f) => scopeOf(f) === 'platform'));
  assert.equal(r.manifest.meta_reads, null, 'the CMDB governance reads ran for a Platform scan');
});

/* ════════════════════════ storage: each module keeps its own result ════════════════════════ */

const manifestFor = (modules, extra = {}) => ({
  modules, verified_modules: [], coverage: {}, stamps: {}, spec_hashes: {}, engine_keys: {}, dependencies: {},
  plan: { modules: {}, tables: {} }, scopes: {}, ...extra,
});
const finding = (fingerprint, rule_id, domain, over = {}) => ({
  fingerprint, rule_id, agent_id: 'x', domain, table: 't', severity: 'LOW', priority: 'P3', priority_score: 1, confidence: 1,
  title: rule_id, target_ids: ['a'], ...over,
});

function finish(runId, manifest, findings = [], startedAt) {
  store.completeRun(runId, { status: 'completed', manifest, findings });
  if (startedAt) getDb().prepare('UPDATE health_runs SET started_at = ? WHERE id = ?').run(startedAt, runId);
  store.recordScanOutcome(runId, { manifest });
}

test('STORE: an ITSM-only scan becomes ITSM\'s result and leaves CMDB\'s where it was; All combines both', () => {
  const full1 = store.openRun();
  finish(full1, manifestFor(['cmdb', 'itom', 'itsm', 'platform']), [
    finding('fp-c', 'CMDB-OWNER', 'CMDB'), finding('fp-i-old', 'ITSM-INC-STALE', 'INCIDENT'),
  ], '2026-09-15T08:00:00.000Z');
  const itsm = store.openRun();
  finish(itsm, manifestFor(['itsm']), [finding('fp-i-new', 'ITSM-INC-UNASSIGNED', 'INCIDENT')], '2026-09-15T09:00:00.000Z');

  const results = store.moduleResults();
  assert.equal(results.cmdb.runId, full1);
  assert.equal(results.itsm.runId, itsm);

  const { findings } = store.listModuleFindings({ scope: 'all', limit: 50 });
  assert.deepEqual(findings.map((f) => [f.fingerprint, f.run_id]).sort(), [['fp-c', full1], ['fp-i-new', itsm]].sort(),
    'All mixed an old ITSM finding in, or lost the CMDB one');
});

test('STORE: a verification marks the module "no changes as of", against the run that produced its result', () => {
  const v = store.openRun();
  const source = store.moduleResults().cmdb.runId;
  finish(v, manifestFor([], {
    kind: 'verification', verified_modules: ['cmdb'],
    plan: { modules: { cmdb: { action: 'reuse', source_run_id: source, verified_at: '2026-09-15T09:30:00.000Z' } }, tables: { cmdb_ci: { changed: false, reason: null, deletion_log: false } } },
  }));
  const results = store.moduleResults();
  assert.equal(results.cmdb.runId, source, 'a verification became the CMDB result');
  assert.equal(results.cmdb.verifiedAt, '2026-09-15T09:30:00.000Z');
  assert.equal(store.latestRun().id !== v, true, 'a verification-only run became "latest"');
  assert.ok(store.trend().every((p) => p.runId !== v), 'a verification-only run became a trend point');
  const row = store.scanStateTable().find((t) => t.table === 'cmdb_ci');
  assert.equal(row.last_check_changed, false);
  assert.equal(row.deletion_log, false);
});

test('STORE: a module\'s current result is never pruned, however many scans of other modules follow', () => {
  const cmdbRun = store.moduleResults().cmdb.runId;
  for (let i = 0; i < store.KEEP_FINDINGS_FOR_RUNS + 3; i++) {
    finish(store.openRun(), manifestFor(['itsm']), [finding(`fp-i-${i}`, 'ITSM-INC-STALE', 'INCIDENT')]);
  }
  assert.ok(store.listFindings(cmdbRun, { limit: 5 }).total > 0, 'the CMDB result\'s findings were pruned');
});

test('STORE: table settings are per table, validated, and honoured by the plan', () => {
  store.setTableIncremental('sys_trigger', false);
  assert.deepEqual(store.tableSettings().sys_trigger, { enabled: false });
  assert.throws(() => store.setTableIncremental('sys_user', true), /not in the Health Assist allow-list/);
  const row = store.scanStateTable().find((t) => t.table === 'sys_trigger');
  assert.equal(row.enabled, false);
  assert.deepEqual(row.modules, ['platform']);
  assert.equal(store.scanStateTable().length, Object.keys(TABLES).length, 'the configuration table does not list every allow-listed table');
});

test('STORE: stamps are recorded only through a finished run — a failed run records none', () => {
  const failed = store.openRun();
  store.failRun(failed, new Error('boom'));
  const before = store.scanStateTable().find((t) => t.table === 'problem');
  const ok = store.openRun();
  finish(ok, manifestFor(['itsm'], { stamps: { problem: { count: 15, max_updated: '2026-09-01 00:00:00', taken_at: NOW.toISOString() } }, spec_hashes: { problem: specHash('problem') } }));
  const after = store.scanStateTable().find((t) => t.table === 'problem');
  assert.equal(before.rows, null);
  assert.deepEqual([after.rows, after.newest_change, after.last_read_run_id], [15, '2026-09-01 00:00:00', ok]);
  const baselines = store.moduleBaselines();
  assert.equal(baselines.itsm.runId, ok);
  assert.equal(baselines.itsm.stamps.problem.count, 15, 'the baseline is not the producing run\'s own stamps');
});
