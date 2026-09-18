import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-itsm-p5c-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'c.db'))));
const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev000001.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const { runHealthCheck, buildParameterRegistry } = await import('../src/health/index.js');
const { runITSMRules } = await import('../src/health/itsm/runner.js');
const { reconcileStandalone } = await import('../src/health/itsm/integration.js');
const { countMemo } = await import('../src/health/itsm/data-access.js');
const { summariseScopes } = await import('../src/health/scopes.js');
const { openRun, completeRun, recordScanOutcome } = await import('../src/health/store.js');
const { fakeInstance } = await import('./helpers/itsm-fake-instance.js');
const { ESTATE, ABSENT, NOW, estateContext } = await import('./helpers/itsm-estate.js');
const { default: express } = await import('express');
const { healthRouter } = await import('../src/routes/health.js');

/*
 * ITSM PHASE 5 CLOSURE — the joins the closure brief names: standalone vs
 * integrated for all 139 rules, the catalogue → runner → Health Checker →
 * normalisation → aggregation → store → API flow, repeat-scan reuse (and what
 * prevents it), and the count memo the performance review added.
 */

const scanOnce = (client, extra = {}) => runHealthCheck({ client, explain: false, modules: ['itsm'], reuse: false, user: 'admin', now: NOW, ...extra });
let estateScan = null;
const estate = async () => (estateScan ??= await scanOnce(fakeInstance(ESTATE, { absent: ABSENT })));

/* ════════════ standalone vs integrated ════════════ */

test('RECONCILIATION: 139 / 139 compared on status, verdict, blocker, findings, fingerprints, evidence, confidence, population, parameters and dependencies — every difference explained, none unexpected', async () => {
  const r = await estate();
  const standalone = await runITSMRules(estateContext());
  const rec = reconcileStandalone(standalone, { rules: r.manifest.itsm.rules, findings: r.findings.filter((f) => f.domain === 'ITSM') });
  assert.equal(rec.summary.compared, 139);
  assert.equal(rec.summary.unexpected, 0, JSON.stringify(rec.rows.filter((x) => x.unexpected.length), null, 1));
  assert.equal(rec.summary.matching + rec.summary.different, 139);
  assert.equal(rec.summary.explained, rec.summary.different);
  /* the only mechanism on the fixture is the fingerprint merge, and it names the merged findings */
  for (const row of rec.rows.filter((x) => !x.matching)) {
    assert.deepEqual(row.explained.map((e) => e.mechanism), ['fingerprint_merge'], row.rule_id);
    assert.ok(row.explained[0].fingerprints.every((f) => f.occurrences > 1), row.rule_id);
  }
  assert.match(rec.summary.line, /^139 \/ 139 compared, Matching \d+, Different \d+, Explained \d+, Unexpected 0$/);
});

test('RECONCILIATION catches what it must: a changed verdict, a lost dependency or a dropped evidence row is UNEXPECTED, and a live population change explains only data-derived fields', async () => {
  const r = await estate();
  const standalone = await runITSMRules(estateContext());
  const rules = JSON.parse(JSON.stringify(r.manifest.itsm.rules));
  const findings = r.findings.filter((f) => f.domain === 'ITSM').map((f) => ({ ...f, evidence: [...f.evidence] }));
  rules.find((x) => x.rule_id === 'ITSM-062').verdict = 'pass';
  rules.find((x) => x.rule_id === 'ITSM-129').dependencies = [];
  const withEvidence = findings.find((f) => f.itsm.rule_id === 'ITSM-020' && f.evidence.length > 1);
  withEvidence.evidence.pop();
  const rec = reconcileStandalone(standalone, { rules, findings });
  assert.deepEqual(rec.rows.filter((x) => x.unexpected.length).map((x) => [x.rule_id, x.unexpected.map((d) => d.field)]), [
    ['ITSM-020', ['evidence']], ['ITSM-062', ['verdict']], ['ITSM-129', ['dependencies']],
  ]);
  /* live: a moved population explains a moved verdict, never a moved status */
  const moved = JSON.parse(JSON.stringify(r.manifest.itsm.rules));
  const row = moved.find((x) => x.rule_id === 'ITSM-062');
  row.verdict = 'fail'; row.population = { ...row.population, total: row.population.total + 1 };
  const live = reconcileStandalone(standalone, { rules: moved, findings: r.findings.filter((f) => f.domain === 'ITSM'), live: true });
  assert.deepEqual(live.rows.find((x) => x.rule_id === 'ITSM-062').explained.map((e) => e.mechanism), ['population_moved']);
  row.status = 'unavailable';
  const notData = reconcileStandalone(standalone, { rules: moved, findings: r.findings.filter((f) => f.domain === 'ITSM'), live: true });
  assert.ok(notData.rows.find((x) => x.rule_id === 'ITSM-062').unexpected.length > 0);
});

test('RECONCILIATION on a live instance: an evidence value moved by a record update between the runs (dev424910: ITSM-037 sys_updated_on, incident updated 09:55:37) is explained ONLY with a change stamp on a table the rule read, dated after the standalone run started and not in the future', async () => {
  const r = await estate();
  const standalone = await runITSMRules(estateContext());
  /* the integrated side saw one incident re-touched: same rows, same count, one field value moved */
  const findings = r.findings.filter((f) => f.domain === 'ITSM').map((f) => (f.rule_id !== 'ITSM-037' ? f : {
    ...f, evidence: f.evidence.map((e, k) => (k === f.evidence.findIndex((x) => x.field_name === 'sys_updated_on') ? { ...e, field_value: '2026-09-16 11:59:00' } : e)),
  }));
  assert.ok(findings.find((f) => f.rule_id === 'ITSM-037').evidence.some((e) => e.field_value === '2026-09-16 11:59:00'), 'the fixture changed nothing');
  const rules = r.manifest.itsm.rules;
  const started = '2026-09-16T11:00:00.000Z';
  const noEvidence = reconcileStandalone(standalone, { rules, findings, live: true, standaloneStartedAt: started });
  const row = (rec) => rec.rows.find((x) => x.rule_id === 'ITSM-037');
  assert.deepEqual(row(noEvidence).unexpected.map((d) => [d.field, d.fields_changed, d.rows_added_or_removed]), [['evidence', ['sys_updated_on'], 0]]);
  const stamp = (table, max) => ({ table, count: 4, max_updated: max, taken_at: '2026-09-16T12:30:00.000Z' });
  const incidentMoved = reconcileStandalone(standalone, { rules, findings, live: true, standaloneStartedAt: started, changes: [stamp('incident', '2026-09-16 11:59:00')] });
  assert.deepEqual(row(incidentMoved).explained.map((e) => [e.mechanism, e.tables]), [['records_updated', ['incident']]]);
  assert.equal(incidentMoved.summary.unexpected, 0);
  /* an update on a table the rule never read, one before the run started, or a future-dated value explains nothing */
  for (const changes of [[stamp('problem', '2026-09-16 11:59:00')], [stamp('incident', '2026-09-16 10:59:00')], [stamp('incident', '2027-01-01 00:00:00')]]) {
    assert.equal(row(reconcileStandalone(standalone, { rules, findings, live: true, standaloneStartedAt: started, changes })).unexpected.length, 1, JSON.stringify(changes));
  }
  /* offline (live: false) nothing is explained by data movement at all */
  assert.equal(row(reconcileStandalone(standalone, { rules, findings, standaloneStartedAt: started, changes: [stamp('incident', '2026-09-16 11:59:00')] })).unexpected.length, 1);
});

/* ════════════ catalogue → runner → Health Checker → store → API ════════════ */

test('FLOW: rule id, status, verdict, blocker, confidence, finding count, population and evidence survive the store and the HTTP API the page reads', async () => {
  const r = await estate();
  const runId = openRun();
  completeRun(runId, r);
  recordScanOutcome(runId, r);
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthRouter);
  const server = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  const base = `http://127.0.0.1:${server.address().port}/api/health`;
  const get = async (url) => { const res = await fetch(`${base}${url}`); assert.equal(res.status, 200, url); return res.json(); };
  try {
    /* the run the ITSM tab loads (GET /runs/:id): every catalogue row, field for field */
    const { run } = await get(`/runs/${runId}`);
    const apiRows = new Map(run.manifest.itsm.rules.map((x) => [x.rule_id, x]));
    assert.equal(apiRows.size, 139);
    for (const row of r.manifest.itsm.rules) {
      const a = apiRows.get(row.rule_id);
      assert.ok(a, `${row.rule_id} lost between the scan and the API`);
      for (const k of ['status', 'verdict', 'classification', 'confidence', 'findings', 'evaluated', 'population_empty']) assert.deepEqual(a[k], row[k], `${row.rule_id}.${k}`);
      assert.deepEqual(a.blocker, JSON.parse(JSON.stringify(row.blocker)), `${row.rule_id}.blocker`);
      assert.deepEqual(a.population, row.population, `${row.rule_id}.population`);
      assert.deepEqual(a.undetermined, row.undetermined, `${row.rule_id}.undetermined`);
    }
    assert.deepEqual(run.manifest.itsm.aggregation.reconciliation, r.manifest.itsm.aggregation.reconciliation);
    /* skipped checks the page renders: every non-evaluated rule, and every evaluated rule that established nothing */
    const skips = run.manifest.skipped_checks.filter((x) => x.source === 'itsm_catalogue');
    for (const row of r.manifest.itsm.rules.filter((x) => !x.evaluated)) assert.ok(skips.some((s) => s.rule === row.rule_id && s.status === row.status), row.rule_id);
    for (const row of r.manifest.itsm.rules.filter((x) => x.undetermined)) assert.ok(skips.some((s) => s.rule === row.rule_id && s.undetermined === row.undetermined.kind), row.rule_id);

    /* the findings list (GET /modules/findings?scope=itsm, the page's list) holds every stored catalogue finding, per rule */
    const catalogue = r.findings.filter((f) => f.domain === 'ITSM');
    const listed = await get('/modules/findings?scope=itsm&limit=500');
    const listedCatalogue = listed.findings.filter((f) => f.rule_id.startsWith('ITSM-'));
    assert.equal(listedCatalogue.length, catalogue.length);
    const perRule = (xs) => xs.reduce((a, f) => ((a[f.rule_id] = (a[f.rule_id] || 0) + 1), a), {});
    assert.deepEqual(perRule(listedCatalogue), perRule(catalogue));
    /* one rule's filter, as the page issues it */
    const one = await get(`/runs/${runId}/findings?scope=itsm&rule=ITSM-020&limit=50`);
    assert.equal(one.findings.length, catalogue.filter((f) => f.rule_id === 'ITSM-020').length);

    /* the finding detail (GET /runs/:id/findings/:fp): evidence, the rule trace, the verdict */
    for (const f of catalogue) {
      const d = await get(`/runs/${runId}/findings/${f.fingerprint}`);
      const got = d.finding ?? d;
      assert.equal(got.rule_id, f.rule_id);
      assert.equal(got.itsm.rule_id, f.itsm.rule_id);
      assert.equal(got.itsm.verdict, f.itsm.verdict);
      assert.equal(got.confidence, f.confidence);
      assert.deepEqual(got.evidence, JSON.parse(JSON.stringify(f.evidence)), `${f.rule_id} evidence changed on the way to the page`);
    }
  } finally {
    server.close();
  }
});

test('SCORE: the 11-rule ITSM score is computed from the legacy findings alone — the catalogue verdicts, populations and findings do not move it', async () => {
  const r = await estate();
  const legacyOnly = r.findings.filter((f) => f.domain !== 'ITSM');
  const recomputed = summariseScopes(r.manifest.coverage, legacyOnly).itsm;
  assert.equal(r.manifest.scopes.itsm.score, recomputed.score);
  assert.equal(r.manifest.scopes.itsm.score_basis, recomputed.score_basis);
  assert.deepEqual(r.manifest.scopes.itsm.score_drivers, recomputed.score_drivers);
});

/* ════════════ repeat scan ════════════ */

test('REUSE: an unchanged repeat is verified, not re-read; a parameter change, an incident change and a change_request change each force a re-read that names why', async () => {
  const tables = JSON.parse(JSON.stringify(ESTATE));
  const client = fakeInstance(tables, { absent: ABSENT });
  const first = await scanOnce(client);
  const m = first.manifest;
  const baselines = { itsm: {
    runId: 'run-1', status: first.status, checkedAt: NOW.toISOString(), engineKey: m.engine_keys.itsm, user: 'admin',
    dependencies: m.dependencies.itsm, degraded: m.degraded.itsm ?? null, stamps: m.stamps, specHashes: m.spec_hashes, metaStamps: m.itsm_stamps,
  } };
  const again = (extra = {}) => runHealthCheck({ client, explain: false, modules: ['itsm'], reuse: true, baselines, user: 'admin', now: NOW, ...extra });

  const unchanged = await again();
  assert.equal(unchanged.manifest.kind, 'verification');
  assert.deepEqual(unchanged.manifest.verified_modules, ['itsm']);
  assert.equal(unchanged.manifest.itsm ?? null, null, 'a verified module re-ran the catalogue');

  /* an ITSM parameter is result-affecting input (DECISION 4 / 8) */
  const { registry } = buildParameterRegistry([{ rule_id: 'ITSM-129', key: 'problem_reference_threshold', value: 30 }]);
  const param = await again({ itsm: { parameters: registry } });
  assert.deepEqual(param.manifest.modules, ['itsm']);
  assert.match(param.manifest.plan.modules.itsm.reasons.join(' '), /rules, settings or accepted risks changed/);

  /* a record change on a table both the legacy rules and the catalogue read */
  tables.incident = tables.incident.map((x) => (x.sys_id === 'inc-open' ? { ...x, sys_updated_on: '2026-09-16 11:30:00', priority: '2' } : x));
  const incident = await again();
  assert.deepEqual(incident.manifest.modules, ['itsm']);
  assert.match(incident.manifest.plan.modules.itsm.reasons.join(' '), /incident/);

  /* a change_request added */
  const tables2 = JSON.parse(JSON.stringify(ESTATE));
  const client2 = fakeInstance(tables2, { absent: ABSENT });
  const base2 = await scanOnce(client2);
  const b2 = { itsm: { ...baselines.itsm, engineKey: base2.manifest.engine_keys.itsm, dependencies: base2.manifest.dependencies.itsm, stamps: base2.manifest.stamps, specHashes: base2.manifest.spec_hashes, metaStamps: base2.manifest.itsm_stamps } };
  tables2.change_request = [...tables2.change_request, { ...tables2.change_request[0], sys_id: 'chg-new', sys_updated_on: '2026-09-16 11:45:00' }];
  const change = await runHealthCheck({ client: client2, explain: false, modules: ['itsm'], reuse: true, baselines: b2, user: 'admin', now: NOW });
  assert.deepEqual(change.manifest.modules, ['itsm']);
  assert.match(change.manifest.plan.modules.itsm.reasons.join(' '), /change_request/);
});

/* ════════════ the count memo ════════════ */

test('COUNT MEMO: one count per (table, query) per run — a repeat is served without a request, a failed count is asked again, other calls pass through', async () => {
  let calls = 0; let fail = true;
  const client = {
    count: async (t, q) => { calls += 1; if (t === 'flaky' && fail) { fail = false; throw new Error('boom'); } return `${t}:${q}`.length; },
    query: async () => [{ sys_id: 'x' }],
  };
  const { client: memo, stats } = countMemo(client);
  assert.equal(await memo.count('incident', 'active=true'), await memo.count('incident', 'active=true'));
  assert.equal(calls, 1);
  await memo.count('incident', '');
  assert.equal(calls, 2);
  await assert.rejects(() => memo.count('flaky', ''));
  assert.equal(await memo.count('flaky', ''), 'flaky:'.length);
  assert.equal(calls, 4, 'a failed count was served from the memo');
  assert.deepEqual(await memo.query('incident', {}), [{ sys_id: 'x' }]);
  assert.deepEqual(stats(), { hits: 1, misses: 4, distinct: 3 });

  /* on the estate: the scan records what the caches saved, and no identical count reaches the instance twice */
  const seen = new Map();
  const inner = fakeInstance(ESTATE, { absent: ABSENT });
  const spy = { ...inner, count: (t, q) => { const k = `${t}|${q}`; seen.set(k, (seen.get(k) || 0) + 1); return inner.count(t, q); } };
  const r = await scanOnce(spy);
  const itsmCounts = [...seen.entries()].filter(([, n]) => n > 1);
  const cache = r.manifest.itsm.performance.cache;
  assert.ok(cache.counts.hits > 0 && cache.reads.hits > 0 && cache.probes.hits > 0, JSON.stringify(cache));
  /* the legacy extract counts on its own client; the catalogue's repeats are gone */
  for (const [k] of itsmCounts) assert.ok(['incident', 'change_request', 'problem'].includes(k.split('|')[0]), `catalogue count repeated: ${k}`);
});
