import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate, getDb } from '../src/memory/db.js';

/*
 * HEALTH FINDING DIMENSIONS — a classification layered over findings.
 *
 * What this suite holds the feature to:
 *   - a dimension groups RULES; findings inherit it at read time and are never
 *     written, so history reclassifies itself and a deleted dimension loses
 *     nothing;
 *   - one finding may appear under several dimensions and is still one row,
 *     one fingerprint, one lifecycle state;
 *   - Unclassified catches every rule no dimension claims, including a rule
 *     the catalogue has never heard of;
 *   - dimension, severity and every existing filter compose in SQL, scoped to
 *     the bound instance's module results;
 *   - the AI helper only proposes, sees rule definitions only, and a reply
 *     naming one rule that does not exist is refused whole.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-dimensions-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'c.db'))));
const { _setSettingsForTests } = await import('../src/config/store.js');
const INSTANCE_A = { instanceUrl: 'https://dev000001.service-now.com', authType: 'basic', username: 'admin', password: 'x' };
const INSTANCE_B = { instanceUrl: 'https://dev000002.service-now.com', authType: 'basic', username: 'admin', password: 'x' };
const bind = (connection) => _setSettingsForTests({
  connection, llm: { provider: 'ollama', model: '', baseUrl: '' }, agent: { autoApprove: false },
});
bind(INSTANCE_A);

/* health/index.js registers the ITSM rules into the rule catalogue, as at boot. */
await import('../src/health/index.js');
const C = await import('../src/health/finding-dimensions.js');
const RC = await import('../src/health/rule-catalogue.js');
const A = await import('../src/health/dimension-assist.js');
const { openRun, completeRun, listModuleFindings, listFindings, moduleRuleSeverityCounts } = await import('../src/health/store.js');
const { setFindingState, stateMap } = await import('../src/health/finding-state.js');
const { default: express } = await import('express');
const { healthRouter } = await import('../src/routes/health.js');
const { healthDimensionsRouter } = await import('../src/routes/health-dimensions.js');

const SRC = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * Fixture estate — one full run per instance
 * ------------------------------------------------------------------ */

let seq = 0;
function finding(ruleId, { domain, severity, priority = 'P3', title, target = null }) {
  seq += 1;
  return {
    fingerprint: `fp-${ruleId}-${seq}`,
    rule_id: ruleId,
    agent_id: 'test_agent',
    domain,
    table: 'cmdb_ci',
    severity,
    priority,
    priority_score: 100 - seq,
    confidence: 1,
    title: title || `${ruleId} finding ${seq}`,
    description: 'fixture',
    recommendation: null,
    target_ids: [target || `${String(seq).padStart(32, '0')}`],
    evidence: [{ sys_id: target || String(seq).padStart(32, '0'), field: 'name', value: title || `record-${seq}` }],
  };
}

const ESTATE_A = [
  finding('CMDB-OWNER', { domain: 'CMDB', severity: 'HIGH', priority: 'P2', title: 'Server-Alpha-01 has no owner', target: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }),
  finding('CMDB-OWNER', { domain: 'CMDB', severity: 'LOW' }),
  finding('CSDM-OWNER', { domain: 'CSDM', severity: 'MEDIUM' }),
  finding('ITSM-INC-UNASSIGNED', { domain: 'INCIDENT', severity: 'HIGH', priority: 'P1' }),
  finding('CMDB-031', { domain: 'CMDB', severity: 'CRITICAL', priority: 'P1' }),
  finding('CMDB-093', { domain: 'ATTESTATION', severity: 'MEDIUM' }),
  finding('SEC-INACTIVE-ROLE', { domain: 'SECURITY', severity: 'CRITICAL' }),
  finding('ITSM-030', { domain: 'ITSM', severity: 'LOW' }),
  /* A rule the engine could add tomorrow: no catalogue entry, no mapping. */
  finding('NEW-RULE-123', { domain: 'SECURITY', severity: 'HIGH' }),
];
const ESTATE_B = [
  finding('CMDB-OWNER', { domain: 'CMDB', severity: 'HIGH' }),
  finding('CMDB-OWNER', { domain: 'CMDB', severity: 'HIGH' }),
];

function storeRun(findings) {
  const runId = openRun();
  completeRun(runId, {
    status: 'completed',
    findings,
    manifest: { modules: ['cmdb', 'itom', 'itsm', 'platform'], coverage: {}, scopes: {}, findings_detected: findings.length, findings_stored: findings.length, severity_counts: {} },
  });
  return runId;
}

bind(INSTANCE_B);
const RUN_B = storeRun(ESTATE_B);
bind(INSTANCE_A);
const RUN_A = storeRun(ESTATE_A);

const rowsSnapshot = () => getDb().prepare('SELECT * FROM health_findings ORDER BY id').all();
const stateSnapshot = () => getDb().prepare('SELECT * FROM health_finding_state ORDER BY fingerprint').all();
const ids = (page) => page.findings.map((f) => f.fingerprint).sort();
const fpsOf = (rule) => ESTATE_A.filter((f) => f.rule_id === rule).map((f) => f.fingerprint);

async function routed(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/health/dimensions', healthDimensionsRouter);
  app.use('/api/health', healthRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => res.status(err.status || 500).json({ message: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { return await fn(`http://127.0.0.1:${server.address().port}/api/health`); } finally { server.close(); }
}
const json = async (res) => ({ status: res.status, body: await res.json() });
const post = (url, body, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/* ------------------------------------------------------------------ *
 * 1 · the built-in taxonomy
 * ------------------------------------------------------------------ */

test('the fifteen built-in dimensions exist, typed built_in, plus the Unclassified system dimension', () => {
  const list = C.listDimensions();
  const builtIn = list.filter((c) => c.type === 'built_in').map((c) => c.name);
  assert.deepEqual(builtIn, [
    'Ownership & Accountability', 'Missing / Incomplete Data', 'Wrong / Invalid Data', 'Duplicates & Identity',
    'Relationships & Impact Analysis', 'Stale / Not Refreshed', 'Lifecycle & Retirement', 'Service Model (CSDM)',
    'Work Not Linked to CI', 'Work Stuck / SLA & Backlog', 'Change Control & Compliance', 'Governance & Attestation',
    'Discovery & ITOM Machinery', 'Security & Access', 'Customization & Platform Risk',
  ]);
  const unc = list.find((c) => c.id === C.UNCLASSIFIED_ID);
  assert.equal(unc.type, 'system');
  assert.equal(unc.editable, false);
  for (const c of list.filter((x) => x.type === 'built_in')) {
    assert.ok(c.description.length > 20, `${c.name} has no description`);
    assert.equal(c.editable, false);
  }
});

test('stable identifiers: built-ins are keyed by slug, not by display name', () => {
  for (const c of C.BUILTIN_DIMENSIONS) assert.match(c.id, /^[a-z0-9-]+$/);
  assert.equal(C.getDimension('ownership-accountability').name, 'Ownership & Accountability');
});

test('every built-in mapping names a real catalogue rule, and every catalogue rule is either mapped or Unclassified', () => {
  const all = new Set(RC.ruleCatalogue().map((r) => r.ruleId));
  assert.equal(all.size, 325, 'the unified catalogue is 143 CMDB + 139 ITSM + 43 core rules');
  for (const [cat, rules] of Object.entries(C.BUILTIN_RULES)) {
    for (const r of rules) assert.ok(all.has(r), `${cat} maps ${r}, which is not in the catalogue`);
  }
  const mapped = new Set(Object.values(C.BUILTIN_RULES).flat());
  const unmapped = C.unmappedCatalogueRules();
  for (const r of all) assert.ok(mapped.has(r) !== unmapped.includes(r), `${r} is neither mapped nor Unclassified (or both)`);
});

test('the example rules from the brief land where a reader would expect', () => {
  const own = C.BUILTIN_RULES['ownership-accountability'];
  for (const r of ['CMDB-OWNER', 'CSDM-OWNER', 'ITSM-INC-UNASSIGNED', 'ITSM-PRB-UNASSIGNED']) assert.ok(own.includes(r), r);
  assert.ok(C.BUILTIN_RULES['wrong-invalid-data'].includes('CMDB-031'));
  assert.ok(!own.includes('CMDB-031'), 'two different rules must stay two different classifications');
});

test('the core-rule origins mirror the add() calls in rules.js exactly', () => {
  const src = read('health/rules.js');
  const calls = [...src.matchAll(/add\('([a-z_]+)', '([A-Z][A-Z0-9-]+)', '([a-z_0-9]+)'/g)]
    .map((m) => [m[2], [m[1], m[3]]]);
  const fromSource = Object.fromEntries(calls);
  assert.deepEqual(Object.keys(fromSource).sort(), Object.keys(RC.LEGACY_RULE_ORIGIN).sort(),
    'a core rule was added to or removed from rules.js without updating LEGACY_RULE_ORIGIN');
  for (const [id, origin] of Object.entries(fromSource)) assert.deepEqual([...RC.LEGACY_RULE_ORIGIN[id]], origin, id);
});

/* ------------------------------------------------------------------ *
 * 2 · resolution, Unclassified and multi-label
 * ------------------------------------------------------------------ */

test('one rule may belong to several dimensions, and a rule no dimension claims resolves to Unclassified', () => {
  const multi = C.dimensionsForRule('CMDB-093');
  assert.deepEqual([...multi].sort(), ['governance-attestation', 'ownership-accountability']);
  assert.deepEqual(C.dimensionsForRule('NEW-RULE-123'), [C.UNCLASSIFIED_ID]);
  assert.deepEqual(C.dimensionsForRule('ITSM-030'), [C.UNCLASSIFIED_ID]);
});

test('findings carry their dimensions in the list, with AREA/domain unchanged beside them', async () => {
  await routed(async (base) => {
    const { body } = await json(await fetch(`${base}/modules/findings?limit=100`));
    const byRule = Object.fromEntries(body.findings.map((f) => [f.rule_id, f]));
    assert.equal(byRule['CMDB-093'].domain, 'ATTESTATION', 'the area is untouched');
    assert.deepEqual([...byRule['CMDB-093'].dimensions].sort(), ['governance-attestation', 'ownership-accountability']);
    assert.deepEqual(byRule['NEW-RULE-123'].dimensions, [C.UNCLASSIFIED_ID]);
  });
});

/* ------------------------------------------------------------------ *
 * 3 · filtering — dimension alone, with severity, and with every other filter
 * ------------------------------------------------------------------ */

test('dimension filter returns exactly the findings whose rule is mapped, across areas', () => {
  const page = listModuleFindings({ dimension: 'ownership-accountability', limit: 100 });
  assert.deepEqual(ids(page), [...fpsOf('CMDB-OWNER'), ...fpsOf('CSDM-OWNER'), ...fpsOf('ITSM-INC-UNASSIGNED'), ...fpsOf('CMDB-093')].sort());
  assert.equal(page.total, 5);
});

test('severity + dimension applies both constraints', () => {
  assert.deepEqual(ids(listModuleFindings({ dimension: 'ownership-accountability', severity: 'HIGH' })),
    [fpsOf('CMDB-OWNER')[0], ...fpsOf('ITSM-INC-UNASSIGNED')].sort());
  assert.deepEqual(ids(listModuleFindings({ dimension: 'ownership-accountability', severity: 'LOW' })), [fpsOf('CMDB-OWNER')[1]]);
  assert.deepEqual(ids(listModuleFindings({ dimension: 'security-access', severity: 'CRITICAL' })), fpsOf('SEC-INACTIVE-ROLE'));
  assert.equal(listModuleFindings({ severity: 'HIGH' }).total, 3, 'severity alone is unchanged');
});

test('dimension composes with domain, priority, rule, search and scope', () => {
  assert.deepEqual(ids(listModuleFindings({ dimension: 'ownership-accountability', domain: 'CMDB' })), fpsOf('CMDB-OWNER').sort());
  assert.deepEqual(ids(listModuleFindings({ dimension: 'ownership-accountability', priority: 'P1' })), fpsOf('ITSM-INC-UNASSIGNED'));
  assert.deepEqual(ids(listModuleFindings({ dimension: 'ownership-accountability', rule: 'CSDM-OWNER' })), fpsOf('CSDM-OWNER'));
  assert.deepEqual(ids(listModuleFindings({ dimension: 'ownership-accountability', q: 'Server-Alpha-01' })), [fpsOf('CMDB-OWNER')[0]]);
  assert.deepEqual(ids(listModuleFindings({ dimension: 'ownership-accountability', scope: 'itsm' })), fpsOf('ITSM-INC-UNASSIGNED'));
  assert.equal(listModuleFindings({ dimension: 'wrong-invalid-data', rule: 'CMDB-OWNER' }).total, 0);
});

test('the per-run findings list and the CSV export honour the dimension too', async () => {
  assert.deepEqual(ids(listFindings(RUN_A, { dimension: 'security-access' })), fpsOf('SEC-INACTIVE-ROLE'));
  await routed(async (base) => {
    const csv = await (await fetch(`${base}/modules/export.csv?dimension=security-access`)).text();
    const lines = csv.split('\n').filter(Boolean);
    assert.equal(lines.length, 2, 'header plus one row');
    assert.match(lines[1], /SEC-INACTIVE-ROLE/);
  });
});

test('Unclassified lists findings of unmapped rules — including rules the catalogue does not know', () => {
  assert.deepEqual(ids(listModuleFindings({ dimension: C.UNCLASSIFIED_ID })), [...fpsOf('ITSM-030'), ...fpsOf('NEW-RULE-123')].sort());
});

test('an unknown dimension is a 404, never an empty list that reads as "nothing wrong"', async () => {
  assert.throws(() => listModuleFindings({ dimension: 'no-such-dimension' }), (e) => e.status === 404);
  await routed(async (base) => {
    const r = await fetch(`${base}/modules/findings?dimension=no-such-dimension`);
    assert.equal(r.status, 404);
  });
});

test('a hostile dimension value is a bound parameter, not SQL', () => {
  assert.throws(() => listModuleFindings({ dimension: "x') OR 1=1 --" }), (e) => e.status === 404);
  assert.equal(rowsSnapshot().length, ESTATE_A.length + ESTATE_B.length);
});

/* ------------------------------------------------------------------ *
 * 4 · counts — one GROUP BY, multi-label, scoped
 * ------------------------------------------------------------------ */

test('dimension counts: totals and severity breakdowns come from real findings, and may sum past the total', async () => {
  await routed(async (base) => {
    const { body } = await json(await fetch(`${base}/dimensions`));
    const by = Object.fromEntries(body.dimensions.map((c) => [c.id, c]));
    assert.equal(body.findings_total, ESTATE_A.length);
    assert.equal(by['ownership-accountability'].findings, 5);
    assert.deepEqual(by['ownership-accountability'].severity, { HIGH: 2, LOW: 1, MEDIUM: 2 });
    assert.equal(by['governance-attestation'].findings, 1, 'CMDB-093 counts here too');
    assert.equal(by[C.UNCLASSIFIED_ID].findings, 2);
    assert.ok(body.dimension_sum > body.findings_total);
    assert.equal(body.multi_label, true);
    assert.deepEqual(body.unclassified.observed_rules, ['ITSM-030', 'NEW-RULE-123']);
  });
});

test('counts respect the existing filters (domain, scope)', async () => {
  await routed(async (base) => {
    const cmdb = (await json(await fetch(`${base}/dimensions?domain=CMDB`))).body;
    assert.equal(cmdb.findings_total, 3);
    assert.equal(cmdb.dimensions.find((c) => c.id === 'ownership-accountability').findings, 2);
    const itsm = (await json(await fetch(`${base}/dimensions?scope=itsm`))).body;
    assert.equal(itsm.dimensions.find((c) => c.id === 'ownership-accountability').findings, 1);
  });
});

test('instance scoping: instance B\'s findings never count or list under instance A, and vice versa', () => {
  const rowsA = moduleRuleSeverityCounts({});
  assert.equal(rowsA.reduce((s, r) => s + r.n, 0), ESTATE_A.length);
  bind(INSTANCE_B);
  try {
    const own = listModuleFindings({ dimension: 'ownership-accountability' });
    assert.deepEqual(ids(own), ESTATE_B.map((f) => f.fingerprint).sort());
    assert.ok(own.findings.every((f) => f.run_id === RUN_B));
  } finally { bind(INSTANCE_A); }
});

/* ------------------------------------------------------------------ *
 * 5 · custom dimensions — create, edit, delete, validation
 * ------------------------------------------------------------------ */

test('custom dimension CRUD: rules are validated, pairs are unique, names are unique case-insensitively', async () => {
  await routed(async (base) => {
    const created = await json(await post(`${base}/dimensions`, {
      name: 'Executive Ownership Gaps',
      description: 'Ownership or accountability missing on important records.',
      rules: ['CMDB-OWNER', { ruleId: 'CSDM-OWNER', source: 'ai' }, 'CMDB-OWNER'],
    }));
    assert.equal(created.status, 201);
    const cat = created.body.dimension;
    assert.equal(cat.type, 'custom');
    assert.equal(cat.editable, true);
    assert.equal(cat.created_by, 'admin');
    assert.deepEqual(cat.rules.map((r) => r.ruleId).sort(), ['CMDB-OWNER', 'CSDM-OWNER'], 'a repeated rule is stored once');
    assert.equal(cat.rules.find((r) => r.ruleId === 'CSDM-OWNER').mapping_source, 'ai');
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM health_dimension_rules WHERE dimension_id = ?').get(cat.id).n, 2);

    assert.deepEqual(ids(listModuleFindings({ dimension: cat.id })), [...fpsOf('CMDB-OWNER'), ...fpsOf('CSDM-OWNER')].sort(),
      'existing findings appear under a new dimension immediately — no finding was rewritten');

    const dup = await post(`${base}/dimensions`, { name: '  executive   ownership gaps ', rules: [] });
    assert.equal(dup.status, 409);
    const dupBuiltIn = await post(`${base}/dimensions`, { name: 'ownership & accountability', rules: [] });
    assert.equal(dupBuiltIn.status, 409);

    const fake = await json(await post(`${base}/dimensions`, { name: 'Has a fake rule', rules: ['CMDB-OWNER', 'FAKE-RULE-999'] }));
    assert.equal(fake.status, 422);
    assert.deepEqual(fake.body.detail.unknown_rules, ['FAKE-RULE-999']);
    assert.equal(C.listDimensions().some((c) => c.name === 'Has a fake rule'), false, 'nothing was saved');

    const noName = await post(`${base}/dimensions`, { name: '   ', rules: [] });
    assert.equal(noName.status, 422);

    /* Edit: rules replaced, name changed; the view follows at once. */
    const patched = await json(await post(`${base}/dimensions/${cat.id}`, { name: 'Exec Ownership', rules: ['ITSM-INC-UNASSIGNED'] }, 'PATCH'));
    assert.equal(patched.status, 200);
    assert.equal(patched.body.dimension.name, 'Exec Ownership');
    assert.deepEqual(ids(listModuleFindings({ dimension: cat.id })), fpsOf('ITSM-INC-UNASSIGNED'));
    assert.equal(listModuleFindings({ rule: 'CMDB-OWNER' }).total, 2, 'removing a rule from a dimension leaves its findings exactly as they were');

    const del = await json(await fetch(`${base}/dimensions/${cat.id}`, { method: 'DELETE' }));
    assert.equal(del.status, 200);
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM health_dimension_rules WHERE dimension_id = ?').get(cat.id).n, 0, 'mappings cascade');
    assert.equal((await fetch(`${base}/dimensions/${cat.id}`)).status, 404);
  });
});

test('built-in and system dimensions are read-only through every route', async () => {
  await routed(async (base) => {
    assert.equal((await post(`${base}/dimensions/ownership-accountability`, { name: 'Mine now' }, 'PATCH')).status, 403);
    assert.equal((await fetch(`${base}/dimensions/ownership-accountability`, { method: 'DELETE' })).status, 403);
    assert.equal((await fetch(`${base}/dimensions/${C.UNCLASSIFIED_ID}`, { method: 'DELETE' })).status, 403);
    assert.equal((await post(`${base}/dimensions/${C.UNCLASSIFIED_ID}`, { rules: ['CMDB-OWNER'] }, 'PATCH')).status, 403);
  });
  assert.equal(C.getDimension('ownership-accountability').name, 'Ownership & Accountability');
});

test('a rule whose only dimension is deleted falls back to Unclassified — the finding is untouched', () => {
  const before = rowsSnapshot();
  const cat = C.createDimension({ name: 'Reopen watch', rules: ['ITSM-030'] });
  assert.deepEqual(ids(listModuleFindings({ dimension: cat.id })), fpsOf('ITSM-030'));
  assert.ok(!ids(listModuleFindings({ dimension: C.UNCLASSIFIED_ID })).includes(fpsOf('ITSM-030')[0]));
  C.deleteDimension(cat.id);
  assert.ok(ids(listModuleFindings({ dimension: C.UNCLASSIFIED_ID })).includes(fpsOf('ITSM-030')[0]));
  assert.deepEqual(rowsSnapshot(), before);
});

test('the built-in sync is idempotent and never touches a custom dimension', () => {
  const cat = C.createDimension({ name: 'Survives sync', rules: ['CMDB-OWNER'] });
  const before = getDb().prepare('SELECT * FROM health_dimension_rules ORDER BY dimension_id, rule_id').all();
  /* A fresh handle is a first sync for that handle; running it on the same file twice changes nothing. */
  const again = new DatabaseSync(path.join(scratch, 'c.db'));
  C.syncBuiltinDimensions(again);
  C.syncBuiltinDimensions(again);
  again.close();
  const after = getDb().prepare('SELECT * FROM health_dimension_rules ORDER BY dimension_id, rule_id').all();
  assert.deepEqual(after.map((r) => [r.dimension_id, r.rule_id, r.source]), before.map((r) => [r.dimension_id, r.rule_id, r.source]));
  C.deleteDimension(cat.id);
});

/* ------------------------------------------------------------------ *
 * 6 · matchers and preview
 * ------------------------------------------------------------------ */

test('smart matchers run over the rule catalogue, deterministically', async () => {
  const d9 = C.matchRules({ module: 'cmdb', qualityDimension: 'D9' }).map((r) => r.ruleId);
  assert.deepEqual(C.matchRules({ module: 'cmdb', dimension: 'D9' }).map((r) => r.ruleId), d9, 'the pre-rename field name is still accepted');
  assert.deepEqual(C.matchRules({ qualityDimension: 'Ownership' }).map((r) => r.ruleId), d9, 'the D1–D10 label matches too');
  assert.deepEqual(d9, ['CMDB-102', 'CMDB-103', 'CMDB-104', 'CMDB-105', 'CMDB-106', 'CMDB-107', 'CMDB-108']);
  assert.deepEqual(C.matchRules({ prefix: 'MID-' }).map((r) => r.ruleId).sort(),
    ['MID-DOWN', 'MID-ISSUE', 'MID-NO-CAPABILITY', 'MID-NONE', 'MID-NOT-VALIDATED']);
  assert.ok(C.matchRules({ group: 'ownership' }).some((r) => r.ruleId === 'CMDB-105'));
  assert.deepEqual(C.matchRules({ ruleIds: ['CMDB-OWNER'] }).map((r) => r.ruleId), ['CMDB-OWNER']);
  assert.throws(() => C.matchRules({ title: 'owner' }), (e) => e.status === 422, 'an unknown matcher field is refused');
  assert.throws(() => C.matchRules({ ruleIds: ['FAKE-RULE-999'] }), (e) => e.status === 422);
  await routed(async (base) => {
    const { status, body } = await json(await post(`${base}/dimensions/match`, { matcher: { domain: 'MID_SERVER' } }));
    assert.equal(status, 200);
    assert.equal(body.count, 5);
  });
});

test('preview counts findings for an unsaved rule set, and refuses unknown rules', async () => {
  await routed(async (base) => {
    const ok = await json(await post(`${base}/dimensions/preview`, { rules: ['CMDB-OWNER', 'ITSM-INC-UNASSIGNED', 'CMDB-012'] }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.findings, 3);
    assert.deepEqual(ok.body.severity, { HIGH: 2, LOW: 1 });
    assert.equal(ok.body.rules.find((r) => r.ruleId === 'CMDB-012').findings, 0);
    const bad = await post(`${base}/dimensions/preview`, { rules: ['FAKE-RULE-999'] });
    assert.equal(bad.status, 422);
  });
  assert.equal(C.listDimensions().filter((c) => c.type === 'custom').length, 0, 'preview saved nothing');
});

/* ------------------------------------------------------------------ *
 * 7 · nothing else moves — rows, lifecycle, scoring, fix flow
 * ------------------------------------------------------------------ */

test('lifecycle state is per fingerprint, shared by every dimension view, and dimension writes never touch it', () => {
  const fp = fpsOf('CMDB-093')[0];
  setFindingState(fp, { state: 'muted', reason: 'known — tracked elsewhere', ruleId: 'CMDB-093' });
  const states = stateSnapshot();
  const inGov = listModuleFindings({ dimension: 'governance-attestation' }).findings.find((f) => f.fingerprint === fp);
  const inOwn = listModuleFindings({ dimension: 'ownership-accountability' }).findings.find((f) => f.fingerprint === fp);
  assert.equal(inGov.lifecycle.state, 'muted');
  assert.deepEqual(inGov.lifecycle, inOwn.lifecycle);
  assert.equal(stateMap().get(fp).state, 'muted');

  const cat = C.createDimension({ name: 'Lifecycle probe', rules: ['CMDB-093'] });
  C.updateDimension(cat.id, { rules: [] });
  C.deleteDimension(cat.id);
  assert.deepEqual(stateSnapshot(), states);
});

test('finding rows are never written by the dimension layer', () => {
  const before = rowsSnapshot();
  const cat = C.createDimension({ name: 'Row probe', rules: ['CMDB-OWNER', 'CMDB-031'] });
  listModuleFindings({ dimension: cat.id });
  moduleRuleSeverityCounts({});
  C.updateDimension(cat.id, { name: 'Row probe 2', rules: ['CMDB-031'] });
  C.deleteDimension(cat.id);
  assert.deepEqual(rowsSnapshot(), before);
  const cols = getDb().prepare('PRAGMA table_info(health_findings)').all().map((c) => c.name);
  assert.ok(!cols.some((c) => /categor|dimension/i.test(c)), 'health_findings gained a dimension column');
});

test('scoring, generation, lifecycle and the fix / bulk-fix path do not know dimensions exist', () => {
  const untouched = [
    'health/rules.js', 'health/scopes.js', 'health/cmdb-quality.js', 'health/itsm-quality.js', 'health/overall-health.js',
    'health/proposal.js', 'health/remediate.js', 'health/bulk.js', 'health/finding-state.js', 'health/extract.js',
    'health/incremental.js', 'health/explain.js',
  ];
  for (const f of untouched) {
    /* "dimension" alone is legitimate in these files — it is the CMDB Quality
       D1–D10 concept. What must not appear is the finding-dimension layer. */
    assert.ok(!/finding-dimensions|dimension-assist|dimensionClause|dimensionsForRule/.test(read(f)), `${f} references the finding-dimension layer`);
  }
  /* The approval-binding sequence in routes/health.js is untouched: one approvePlan call, in applyProposal. */
  const routes = read('routes/health.js');
  assert.equal((routes.match(/approvePlan\(/g) || []).length, 1);
  const imports = read('routes/health-dimensions.js').match(/import[^;]+;/g).join('\n');
  assert.ok(!/remediate|proposal|approvePlan|finding-state|servicenow\//.test(imports), 'the dimensions router can reach the fix path');
});

test('the dimension layer cannot reach the instance or a model except the one assist seam', () => {
  for (const f of ['health/finding-dimensions.js', 'health/rule-catalogue.js', 'routes/health-dimensions.js']) {
    const src = read(f);
    assert.ok(!/servicenow\/client|instance-read|table\.(create|update|remove)/.test(src), `${f} reaches the instance`);
  }
  assert.ok(!/providers/.test(read('health/finding-dimensions.js')), 'dimensions.js calls a model');
  assert.ok(!/providers/.test(read('health/rule-catalogue.js')), 'rule-catalogue.js calls a model');
});

/* ------------------------------------------------------------------ *
 * 8 · AI assistance — proposes only, sees definitions only, validated whole
 * ------------------------------------------------------------------ */

const reply = (o) => async () => JSON.stringify(o);
const GOOD = {
  suggestedName: 'Executive Ownership Gaps',
  suggestedDescription: 'Records whose owner or accountable group is missing or wrong.',
  rules: [
    { ruleId: 'CMDB-OWNER', reason: 'Detects CIs with no owner.' },
    { ruleId: 'ITSM-INC-UNASSIGNED', reason: 'Incidents with no assignment.' },
  ],
};

test('AI: a valid reply is returned with catalogue metadata attached, and nothing is saved', async () => {
  const before = C.listDimensions().length;
  const out = await A.suggestDimension({ name: 'exec owner gaps', description: 'ownership missing' }, { generate: reply(GOOD) });
  assert.equal(out.suggestedName, 'Executive Ownership Gaps');
  assert.deepEqual(out.rules.map((r) => r.ruleId), ['CMDB-OWNER', 'ITSM-INC-UNASSIGNED']);
  assert.equal(out.rules[0].module, 'cmdb');
  assert.match(out.label, /Review every rule/);
  assert.equal(C.listDimensions().length, before);
});

test('AI: one invented rule id rejects the whole reply', async () => {
  const bad = { ...GOOD, rules: [...GOOD.rules, { ruleId: 'FAKE-RULE-999', reason: 'made up' }] };
  await assert.rejects(A.suggestDimension({ name: 'x' }, { generate: reply(bad) }),
    (e) => e.status === 502 && /FAKE-RULE-999/.test(e.message) && e.detail.unknown_rules[0] === 'FAKE-RULE-999');
});

test('AI: malformed JSON, missing fields, duplicates and unexpected keys are all refused', async () => {
  const cases = [
    ['not json', async () => 'I think CMDB-OWNER fits.'],
    ['missing rules', reply({ suggestedName: 'x', suggestedDescription: 'y' })],
    ['rules not a list', reply({ ...GOOD, rules: 'CMDB-OWNER' })],
    ['duplicate', reply({ ...GOOD, rules: [GOOD.rules[0], GOOD.rules[0]] })],
    ['extra top-level key', reply({ ...GOOD, confidence: 0.9 })],
    ['extra rule key', reply({ ...GOOD, rules: [{ ...GOOD.rules[0], severity: 'HIGH' }] })],
    ['no reason', reply({ ...GOOD, rules: [{ ruleId: 'CMDB-OWNER' }] })],
    ['no name', reply({ ...GOOD, suggestedName: '' })],
  ];
  for (const [label, generate] of cases) {
    await assert.rejects(A.suggestDimension({ name: 'x' }, { generate }), (e) => e.status === 502, label);
  }
});

test('AI: an empty suggestion list is a valid answer, and a fenced reply is accepted', async () => {
  const empty = await A.suggestDimension({ name: 'x' }, { generate: reply({ ...GOOD, rules: [] }) });
  assert.deepEqual(empty.rules, []);
  const fenced = await A.suggestDimension({ name: 'x' }, { generate: async () => `\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\`` });
  assert.equal(fenced.rules.length, 2);
});

test('AI: provider failure, an empty reply and a timeout are reported, never thrown past the route', async () => {
  await assert.rejects(A.suggestDimension({ name: 'x' }, { generate: async () => { throw new Error('ollama unreachable at http://127.0.0.1:9/chat/completions: ECONNREFUSED (after 3 attempts)'); } }),
    (e) => e.status === 502 && /choose rules yourself/.test(e.message)
      && !/127\.0\.0\.1|ECONNREFUSED|attempts/.test(e.message), 'a provider failure is reported without its internals');
  /* A configuration gap the person can fix is said as is. */
  await assert.rejects(A.suggestDimension({ name: 'x' }, { generate: async () => { throw new Error('OpenAI API key not set. Add it in Settings.'); } }),
    (e) => /API key not set\. Add it in Settings\. You can still/.test(e.message));
  await assert.rejects(A.suggestDimension({ name: 'x' }, { generate: async () => '' }), (e) => e.status === 502);
  const hang = ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  await assert.rejects(A.suggestDimension({ name: 'x' }, { generate: hang, timeoutMs: 20 }), (e) => e.status === 504);
  await assert.rejects(A.suggestDimension({}, { generate: reply(GOOD) }), (e) => e.status === 422);

  /* The route with no provider configured: an error response, and Health still answers. */
  await routed(async (base) => {
    const r = await post(`${base}/dimensions/suggest`, { name: 'x', description: 'y' });
    assert.ok(r.status >= 400 && r.status < 600);
    assert.ok((await r.json()).message);
    assert.equal((await fetch(`${base}/dimensions`)).status, 200);
    assert.equal((await fetch(`${base}/modules/findings`)).status, 200);
  });
});

test('AI privacy: the prompt carries rule definitions only — no finding, record, sys_id or evidence', async () => {
  let seen = null;
  await A.suggestDimension({ name: 'Ownership', description: 'missing owners' }, {
    generate: async (req) => { seen = req; return JSON.stringify(GOOD); },
  });
  const prompt = `${seen.system}\n${seen.user}`;
  for (const leak of ['Server-Alpha-01', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', 'fp-CMDB-OWNER', 'dev000001', 'admin']) {
    assert.ok(!prompt.includes(leak), `the prompt carries "${leak}"`);
  }
  assert.ok(prompt.includes('CMDB-OWNER') && prompt.includes('ITSM-139'), 'the catalogue is in the prompt');
  const src = read('health/dimension-assist.js');
  assert.ok(!/from '\.\/store\.js'|memory\/db|servicenow\/|instance-read/.test(src), 'the assist module can reach instance data');
  assert.deepEqual([...RC.PUBLIC_RULE_FIELDS], ['ruleId', 'title', 'whatItMeans', 'source', 'module', 'domain', 'domainLabel',
    'sourceTables', 'qualityDimension', 'qualityDimensionLabel', 'group', 'groupName', 'baseSeverity']);
});

/* ------------------------------------------------------------------ *
 * 9 · the page's helpers and its contract with the API
 * ------------------------------------------------------------------ */

const H = await import('../../client/src/components/healthDimensions.js');

test('client: dimension rows put Unclassified last and name the empty ones; the matrix is real counts', async () => {
  await routed(async (base) => {
    const { body } = await json(await fetch(`${base}/dimensions`));
    const { rows, hidden } = H.dimensionRows(body.dimensions);
    assert.equal(rows.at(-1).id, H.UNCLASSIFIED_ID);
    assert.ok(rows.every((r) => r.findings > 0));
    assert.equal(rows.length + hidden, body.dimensions.length);
    const { rows: m } = H.dimensionMatrix(body.dimensions, ['SYSTEMIC', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
    const own = m.find((r) => r.id === 'ownership-accountability');
    assert.deepEqual(own.cells.map((c) => c.n), [0, 0, 2, 2, 1]);
    assert.equal(own.cells.reduce((s, c) => s + c.n, 0), own.total);
  });
});

test('client: chips compact to a count, and skip a dimension that no longer exists', () => {
  const byId = { a: { id: 'a', name: 'Alpha' }, b: { id: 'b', name: 'Beta' }, c: { id: 'c', name: 'Gamma' } };
  const r = H.chipsFor(['a', 'b', 'c', 'gone'], byId, 1);
  assert.deepEqual(r.shown.map((x) => x.name), ['Alpha']);
  assert.equal(r.more, 2);
  assert.equal(H.chipsFor([], byId).all.length, 0);
});

test('client: severity, dimension and group round-trip through the URL; other params are kept', () => {
  const qs = H.withFilterParams(new URLSearchParams('scope=cmdb&view=findings'), { severity: 'HIGH', dimension: 'security-access' }, 'both');
  assert.equal(qs.toString(), 'scope=cmdb&view=findings&severity=HIGH&dimension=security-access&group=both');
  const cleared = H.withFilterParams(qs, { severity: '', dimension: '' }, 'severity');
  assert.equal(cleared.toString(), 'scope=cmdb&view=findings');
  assert.equal(H.groupModeOf('nonsense'), 'severity');
});

test('contract: every dimension field the new views read is one the API sends', async () => {
  const CLIENT = path.join(SRC, '../../client/src');
  const page = fs.readFileSync(path.join(CLIENT, 'pages/HealthAssist.jsx'), 'utf8');
  const views = fs.readFileSync(path.join(CLIENT, 'components/DimensionViews.jsx'), 'utf8');
  const manager = fs.readFileSync(path.join(CLIENT, 'components/DimensionManager.jsx'), 'utf8');
  const modal = fs.readFileSync(path.join(CLIENT, 'components/DimensionModal.jsx'), 'utf8');
  await routed(async (base) => {
    const list = (await json(await fetch(`${base}/dimensions`))).body;
    for (const k of ['dimensions', 'findings_total', 'severity_totals', 'multi_label', 'unclassified']) assert.ok(k in list, k);
    for (const k of ['observed_rules', 'catalogue_rules', 'findings']) assert.ok(k in list.unclassified, `unclassified.${k}`);
    for (const k of ['id', 'name', 'description', 'type', 'editable', 'rule_count', 'findings', 'severity', 'rule_counts', 'domains']) {
      assert.ok(k in list.dimensions[0], k);
    }
    const one = (await json(await fetch(`${base}/dimensions/ownership-accountability`))).body.dimension;
    for (const k of ['rules', 'editable', 'type', 'description']) assert.ok(k in one, k);
    for (const k of ['ruleId', 'title', 'module', 'groupName', 'mapping_source']) assert.ok(k in one.rules[0], k);
    const rules = (await json(await fetch(`${base}/dimensions/rules`))).body.rules;
    for (const k of ['ruleId', 'title', 'module', 'groupName', 'qualityDimension', 'qualityDimensionLabel', 'domain']) assert.ok(k in rules[0], k);
    const prev = (await json(await post(`${base}/dimensions/preview`, { rules: ['CMDB-OWNER'] }))).body;
    for (const k of ['rule_count', 'findings', 'severity']) assert.ok(k in prev, k);
    const f = (await json(await fetch(`${base}/modules/findings?limit=1`))).body.findings[0];
    assert.ok(Array.isArray(f.dimensions), 'findings carry dimensions');
  });
  /* And the views read exactly those names — a renamed field fails here, not on screen. */
  for (const k of ['severity_totals', 'findings_total', 'multi_label', 'rule_counts', 'domains', 'observed_rules', 'catalogue_rules']) {
    assert.ok(views.includes(k), `DimensionViews no longer reads ${k}`);
  }
  assert.ok(page.includes('f.dimensions') && page.includes('/health/dimensions'), 'the page reads finding dimensions from the dimensions API');
  assert.ok(manager.includes('/health/dimensions') && manager.includes('rule_count'));
  for (const p of ['/health/dimensions/rules', '/health/dimensions/preview', '/health/dimensions/suggest', '/health/dimensions/match']) {
    assert.ok(modal.includes(p), `the dialog no longer calls ${p}`);
  }
  /* The feature speaks Dimension: no Category wording is left on its surfaces. */
  for (const [name, src] of [['DimensionViews', views], ['DimensionManager', manager], ['DimensionModal', modal]]) {
    assert.ok(!/categor/i.test(src), `${name} still says "category"`);
  }
});

test('an unknown dimension is a 404 even when no module has a result yet', () => {
  bind({ ...INSTANCE_A, instanceUrl: 'https://dev000009.service-now.com' });
  try {
    assert.equal(listModuleFindings({}).total, 0, 'no scan on this instance');
    assert.throws(() => listModuleFindings({ dimension: 'no-such-dimension' }), (e) => e.status === 404);
    assert.equal(listModuleFindings({ dimension: 'ownership-accountability' }).total, 0, 'a real dimension with nothing to show is an empty page');
  } finally { bind(INSTANCE_A); }
});

/* ------------------------------------------------------------------ *
 * 10 · the rename — Category → Dimension — lost nothing and broke nothing
 * ------------------------------------------------------------------ */

test('each dimension carries its top rules, its related modules and the severity totals — all summing to its count', async () => {
  await routed(async (base) => {
    const { body } = await json(await fetch(`${base}/dimensions`));
    const own = body.dimensions.find((d) => d.id === 'ownership-accountability');
    assert.deepEqual(own.rule_counts, [
      { rule_id: 'CMDB-OWNER', n: 2 }, { rule_id: 'CMDB-093', n: 1 }, { rule_id: 'CSDM-OWNER', n: 1 }, { rule_id: 'ITSM-INC-UNASSIGNED', n: 1 },
    ]);
    assert.deepEqual(own.domains, [
      { domain: 'CMDB', n: 2 }, { domain: 'ATTESTATION', n: 1 }, { domain: 'CSDM', n: 1 }, { domain: 'INCIDENT', n: 1 },
    ]);
    for (const d of body.dimensions) {
      assert.equal(d.rule_counts.reduce((s, r) => s + r.n, 0), d.findings, `${d.id} rule counts`);
      assert.equal(d.domains.reduce((s, r) => s + r.n, 0), d.findings, `${d.id} domain counts`);
    }
    assert.deepEqual(body.severity_totals, { HIGH: 3, LOW: 2, MEDIUM: 2, CRITICAL: 2 });
    assert.equal(Object.values(body.severity_totals).reduce((s, n) => s + n, 0), body.findings_total,
      'severity totals count each finding once, however many dimensions it is in');
  });
});

test('the pre-rename API still answers: /categories and ?category= are aliases of the dimension ones', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/health/dimensions', healthDimensionsRouter);
  app.use('/api/health/categories', healthDimensionsRouter);
  app.use('/api/health', healthRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/health`;
    const a = (await json(await fetch(`${base}/categories`))).body;
    const b = (await json(await fetch(`${base}/dimensions`))).body;
    assert.deepEqual(a.dimensions.map((d) => [d.id, d.findings]), b.dimensions.map((d) => [d.id, d.findings]));
    const viaOld = (await json(await fetch(`${base}/modules/findings?category=security-access`))).body;
    const viaNew = (await json(await fetch(`${base}/modules/findings?dimension=security-access`))).body;
    assert.deepEqual(viaOld.findings.map((f) => f.fingerprint), viaNew.findings.map((f) => f.fingerprint));
    assert.equal(viaNew.total, 1);
  } finally { server.close(); }
});

test('migration 31 renames the category tables to dimensions, keeping every row, id and mapping', () => {
  const file = path.join(scratch, 'm31.db');
  const db = new DatabaseSync(file);
  /* A database exactly as migration 30 left it, with a custom category and the old fallback. */
  migrate(db);
  db.exec(`
    PRAGMA user_version = 30;
    DROP TABLE health_dimension_rules; DROP TABLE health_dimensions;
    CREATE TABLE health_categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, description TEXT,
      type TEXT NOT NULL CHECK (type IN ('built_in', 'custom', 'system')), created_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE health_category_rules (
      category_id TEXT NOT NULL REFERENCES health_categories(id) ON DELETE CASCADE, rule_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('builtin', 'manual', 'matcher', 'ai')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (category_id, rule_id));
    INSERT INTO health_categories VALUES ('uncategorised','Uncategorised','uncategorised','',  'system','x','t','t');
    INSERT INTO health_categories VALUES ('ownership-accountability','Ownership & Accountability','ownership & accountability','', 'built_in',NULL,'t','t');
    INSERT INTO health_categories VALUES ('c-1','Exec gaps','exec gaps','mine','custom','admin','t','t');
    INSERT INTO health_category_rules VALUES ('ownership-accountability','CMDB-OWNER','builtin','t','t');
    INSERT INTO health_category_rules VALUES ('c-1','CMDB-OWNER','ai','t','t');
    INSERT INTO health_category_rules VALUES ('c-1','CSDM-OWNER','manual','t','t');
  `);
  migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 31);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'health_%'").all().map((r) => r.name);
  assert.ok(tables.includes('health_dimensions') && tables.includes('health_dimension_rules'));
  assert.ok(!tables.some((t) => /categor/.test(t)), 'an old table survived');
  assert.deepEqual(db.prepare('SELECT id, name, type, created_by FROM health_dimensions ORDER BY id').all().map((r) => ({ ...r })), [
    { id: 'c-1', name: 'Exec gaps', type: 'custom', created_by: 'admin' },
    { id: 'ownership-accountability', name: 'Ownership & Accountability', type: 'built_in', created_by: null },
    { id: 'unclassified', name: 'Unclassified', type: 'system', created_by: 'x' },
  ]);
  assert.deepEqual(db.prepare('SELECT dimension_id, rule_id, source FROM health_dimension_rules ORDER BY 1, 2').all().map((r) => ({ ...r })), [
    { dimension_id: 'c-1', rule_id: 'CMDB-OWNER', source: 'ai' },
    { dimension_id: 'c-1', rule_id: 'CSDM-OWNER', source: 'manual' },
    { dimension_id: 'ownership-accountability', rule_id: 'CMDB-OWNER', source: 'builtin' },
  ]);
  assert.equal(db.prepare('PRAGMA foreign_key_list(health_dimension_rules)').all()[0].table, 'health_dimensions');
  db.exec("DELETE FROM health_dimensions WHERE id = 'c-1'");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM health_dimension_rules WHERE dimension_id = 'c-1'").get().n, 0, 'the cascade still works');
  /* Replay from 29 changes nothing: migration 30 sees the renamed table and
     stands down, and 31 renames nothing twice. */
  db.exec('PRAGMA user_version = 29');
  migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 31);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM health_dimension_rules').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM health_dimensions').get().n, 2);
  assert.ok(!db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().some((r) => /categor/.test(r.name)), 'a replay re-created the old tables');
  db.close();
});

test('client: ordering keeps Unclassified apart, the matrix sorts by any band, and the CSV is formula-safe', () => {
  const dims = [
    { id: 'a', name: 'Alpha', findings: 5, severity: { HIGH: 5 } },
    { id: 'b', name: 'Beta', findings: 9, severity: { HIGH: 1, LOW: 8 } },
    { id: H.UNCLASSIFIED_ID, name: 'Unclassified', findings: 50, severity: { HIGH: 50 } },
    { id: 'c', name: '=Evil()', findings: 1, severity: { LOW: 1 } },
  ];
  const o = H.orderDimensions(dims, 'findings-desc');
  assert.deepEqual(o.themed.map((d) => d.id), ['b', 'a', 'c']);
  assert.equal(o.unclassified.id, H.UNCLASSIFIED_ID, 'the fallback never tops the list');
  assert.deepEqual(H.orderDimensions(dims, 'name').themed.map((d) => d.id), ['c', 'a', 'b']);
  const byHigh = H.dimensionMatrix(dims, ['HIGH', 'LOW'], { sortKey: 'HIGH', dir: 'desc' }).rows.map((r) => r.id);
  assert.deepEqual(byHigh, ['a', 'b', 'c', H.UNCLASSIFIED_ID]);
  const csv = H.matrixCsv(H.dimensionMatrix(dims, ['HIGH']).rows, [{ label: 'High' }]);
  assert.match(csv, /^Dimension,High,Total/);
  assert.ok(csv.includes("'=Evil()"), 'a name starting with = is neutralised');
  assert.equal(H.searchDimensions(dims, 'bet').length, 1);
  assert.equal(H.dimensionFromParams(new URLSearchParams('category=security-access')), 'security-access', 'the pre-rename URL still works');
  assert.equal(H.withFilterParams(new URLSearchParams('category=x'), { dimension: 'y' }, 'dimension').toString(), 'dimension=y&group=dimension');
  assert.equal(H.fmtPct(0.04), '<0.1%');
  assert.equal(H.visualOf({ id: 'ownership-accountability' }).icon, 'users');
  assert.equal(H.visualOf({ id: 'custom-x', type: 'custom' }).icon, 'tag');
});
