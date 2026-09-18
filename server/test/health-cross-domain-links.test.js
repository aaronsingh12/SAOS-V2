import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-links-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'l.db'))));
const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev000001.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const L = await import('../src/health/cross-domain/links.js');
const { runHealthCheck } = await import('../src/health/index.js');
const { undeterminedOf } = await import('../src/health/itsm/engines/result.js');
const { openRun, completeRun } = await import('../src/health/store.js');
const { fakeInstance } = await import('./helpers/itsm-fake-instance.js');
const { ESTATE, ABSENT, NOW } = await import('./helpers/itsm-estate.js');
const { default: express } = await import('express');
const { healthRouter } = await import('../src/routes/health.js');

/*
 * PHASE 6 — the first cross-domain link, ITSM-130 ⋈ CMDB-058: relationship-less
 * CIs that incidents reference, ranked by incident volume. The catalogue states
 * the link; nothing here infers one. Report-only, one scan, states kept.
 */

const LINK = 'LINK-ITSM-130-CMDB-058';

/* An evaluated ITSM-130 result as the relationship-graph engine returns it. */
const itsm130 = (answers, over = {}) => ({
  rule_id: 'ITSM-130', status: 'evaluated', verdict: 'fail', findings: [], kpis: [],
  population: { total: answers.reduce((n, a) => n + a.records, 0), judged: answers.reduce((n, a) => n + a.records, 0), unit: 'incident records referencing a CI' },
  answers_by_ci: answers, ...over,
});
const answer = (ci, records, offending, degree = offending ? 0 : 2) => ({ ci, records, record_ids: Array.from({ length: records }, (_, i) => `${ci}-inc-${i}`), offending, degree });
const cmdb058 = (ci, over = {}) => ({ rule_id: 'CMDB-058', fingerprint: `fp-${ci}`, target_ids: [ci], severity: 'CRITICAL', title: `CI ${ci} has no relationships`, confidence: 1, ...over });
const results = (res) => new Map([['ITSM-130', res]]);
const evaluate = (over = {}) => L.evaluateLinks({ readModules: ['cmdb', 'itsm'], undeterminedOf, ...over }).links.find((x) => x.id === LINK);

/* ════════════ the registry ════════════ */

test('REGISTRY: the link on disk validates, quotes its specification, and a malformed entry is refused — no unknown adapter, no verdict effect without a threshold, no duplicate, no unquoted link', () => {
  const reg = L.loadLinks();
  const link = reg.links.find((x) => x.id === LINK);
  assert.ok(link, 'the first link is not registered');
  assert.deepEqual([link.source.rule, link.target.rule, link.join.entity, link.effect], ['ITSM-130', 'CMDB-058', 'cmdb_ci', 'report']);
  assert.ok(link.specification.some((s) => /Joins CMDB-058; prioritises relationship remediation by incident volume/.test(s.text)));
  const good = JSON.parse(JSON.stringify(reg));
  const bad = (mutate) => { const r = JSON.parse(JSON.stringify(good)); mutate(r.links[0]); return r; };
  assert.throws(() => L.validateLinks(bad((l) => { l.effect = 'verdict'; })), /needs a specified threshold/);
  assert.throws(() => L.validateLinks(bad((l) => { l.source.answers = 'guess'; })), /source adapter "guess" does not exist/);
  assert.throws(() => L.validateLinks(bad((l) => { l.specification = []; })), /must quote the specification/);
  assert.throws(() => L.validateLinks(bad((l) => { delete l.join; })), /join is required/);
  assert.throws(() => L.validateLinks({ links: [good.links[0], good.links[0]] }), /duplicate link id/);
  assert.throws(() => L.evaluateLinks({ readModules: ['cmdb', 'itsm'] }), /needs undeterminedOf/);
});

/* ════════════ evaluated ════════════ */

test('NORMAL: relationship-less CIs both rules judged are joined and ranked by incident volume, with both sides\' evidence; CIs only one side flags are counted, not joined', () => {
  const answers = [answer('ci-a', 2, true), answer('ci-b', 5, true), answer('ci-c', 1, true), answer('ci-ok', 9, false)];
  const findings = [cmdb058('ci-a'), cmdb058('ci-b'), cmdb058('ci-z'), cmdb058('ci-pattern', { pattern: true, target_ids: ['ci-a', 'ci-b'] }), { rule_id: 'CMDB-001', target_ids: ['ci-c'] }];
  const l = evaluate({ itsmResults: results(itsm130(answers)), findings });
  assert.equal(l.status, 'evaluated');
  assert.equal(l.verdict, null, 'a report link produced a verdict');
  assert.equal(l.blocker, null);
  assert.deepEqual(l.rows.map((r) => [r.entity, r.records, r.target_finding]), [['ci-b', 5, 'fp-ci-b'], ['ci-a', 2, 'fp-ci-a']], 'not ranked by incident volume');
  assert.deepEqual(l.rows[0].record_ids, ['ci-b-inc-0', 'ci-b-inc-1', 'ci-b-inc-2', 'ci-b-inc-3', 'ci-b-inc-4']);
  assert.equal(l.rows[0].degree, 0);
  assert.deepEqual(l.summary, { joined: 2, source_only: 1, target_only: 1, records_on_joined: 7, target_patterns: 1, target_estate_wide: 0 });
  assert.deepEqual({ total: l.population.total, judged: l.population.judged }, { total: 3, judged: 3 });
  assert.equal(l.undetermined, null);
  assert.deepEqual(l.source_only_sample.map((s) => s.entity), ['ci-c']);
  assert.match(l.fingerprint, /^[0-9a-f]{64}$/);
  /* identity: the joined entity set, order-independent */
  const again = evaluate({ itsmResults: results(itsm130([...answers].reverse())), findings: [...findings].reverse() });
  assert.equal(again.fingerprint, l.fingerprint);
});

test('REPORT ONLY: evaluating a link changes no finding, no verdict and no severity on either side', () => {
  const findings = [cmdb058('ci-a')];
  const res = itsm130([answer('ci-a', 3, true)], { findings: [{ rule_id: 'ITSM-130', confidence: 1, severity: 'SYSTEMIC' }] });
  const before = JSON.stringify({ findings, res });
  evaluate({ itsmResults: results(res), findings });
  assert.equal(JSON.stringify({ findings, res }), before);
});

test('CONFIDENCE: the link is as certain as its least certain input — min, never an average', () => {
  const res = itsm130([answer('ci-a', 3, true), answer('ci-b', 1, true)], { findings: [{ rule_id: 'ITSM-130', confidence: 0.8 }] });
  const l = evaluate({ itsmResults: results(res), findings: [cmdb058('ci-a', { confidence: 0.9 }), cmdb058('ci-b', { confidence: 0.95 })] });
  assert.equal(l.confidence, 0.8);
  const l2 = evaluate({ itsmResults: results(itsm130([answer('ci-a', 3, true)])), findings: [cmdb058('ci-a', { confidence: 0.7 })] });
  assert.equal(l2.confidence, 0.7);
});

test('HEALTHY and EMPTY: no relationship-less CI → evaluated, nothing established, no rows; an ITSM-130 that judged nothing → input_inconclusive — never a quiet clean report', () => {
  const healthy = evaluate({ itsmResults: results(itsm130([answer('ci-ok', 4, false)])), findings: [cmdb058('ci-z')] });
  assert.equal(healthy.status, 'evaluated');
  assert.equal(healthy.rows.length, 0);
  assert.equal(healthy.undetermined.kind, 'empty_population');
  assert.equal(healthy.fingerprint, null);
  const empty = itsm130([], { verdict: 'inconclusive', population: { total: 0, judged: 0, unit: 'incident records referencing a CI' }, undetermined: { kind: 'empty_population', reason: 'no incident records referencing a CI in scope' } });
  const l = evaluate({ itsmResults: results(empty), findings: [cmdb058('ci-z')] });
  assert.equal(l.status, 'evaluated');
  assert.equal(l.undetermined.kind, 'input_inconclusive');
  assert.match(l.undetermined.reason, /ITSM-130/);
});

test('MALFORMED references: an answer without a CI, and a CMDB-058 finding naming no record, are never joined', () => {
  const answers = [answer('ci-a', 2, true), { ci: null, records: 4, record_ids: [], offending: true }, { ci: 42, records: 1, record_ids: [], offending: true }];
  const l = evaluate({ itsmResults: results(itsm130(answers)), findings: [cmdb058('ci-a'), cmdb058('x', { target_ids: [] }), cmdb058('y', { target_ids: [null, ''] })] });
  assert.deepEqual(l.rows.map((r) => r.entity), ['ci-a']);
  assert.equal(l.population.total, 1, 'a malformed answer counted into the population');
  assert.equal(l.summary.target_estate_wide, 1);
});

/* ════════════ not evaluated: states kept ════════════ */

test('UNAVAILABLE DEPENDENCY: a module not read in this scan, a rule that did not evaluate, a skipped target, missing answers — each UNAVAILABLE with an input blocker naming why, never a report', () => {
  const findings = [cmdb058('ci-a')];
  const r = results(itsm130([answer('ci-a', 1, true)]));
  const cases = [
    [{ readModules: ['itsm'], itsmResults: r, findings }, 'CMDB-058', 'not_read', /CMDB was not read in this scan/],
    [{ readModules: ['cmdb'], itsmResults: null, findings }, 'ITSM-130', 'not_read', /ITSM was not read in this scan/],
    [{ itsmResults: new Map(), findings }, 'ITSM-130', 'not_run', /produced no result/],
    [{ itsmResults: results({ rule_id: 'ITSM-130', status: 'unavailable', blocker: { kind: 'capability', reason: 'cmdb_rel_ci is not readable' }, findings: [] }), findings }, 'ITSM-130', 'unavailable', /cmdb_rel_ci is not readable/],
    [{ itsmResults: results({ rule_id: 'ITSM-130', status: 'unconfigured', blocker: { kind: 'unconfigured_parameter', reason: 'parameter threshold is UNCONFIGURED' }, findings: [] }), findings }, 'ITSM-130', 'unconfigured', /UNCONFIGURED/],
    [{ itsmResults: results({ ...itsm130([]), answers_by_ci: undefined }), findings }, 'ITSM-130', 'no_answers', /no per-entity answers/],
    [{ itsmResults: r, findings: [], skipped: [{ rule: 'CMDB-058', table: 'cmdb_rel_ci', reason: 'Relationships were not read completely' }] }, 'CMDB-058', 'skipped', /not read completely/],
  ];
  for (const [over, rule, state, reason] of cases) {
    const l = evaluate(over);
    assert.equal(l.status, 'unavailable', `${rule} ${state}`);
    assert.equal(l.verdict, null);
    assert.deepEqual([l.blocker.kind, l.blocker.rule, l.blocker.state], ['input', rule, state]);
    assert.match(l.blocker.reason, reason);
    assert.equal(l.rows.length, 0);
    assert.equal(l.population, null);
  }
});

/* ════════════ through the scan, the store and the API ════════════ */

test('INTEGRATION: every scan records its links in the manifest — on the fixture CMDB-058 is skipped (partial relationships), so the link says so; an ITSM-only scan cannot join CMDB and says that; the link reaches the store and GET /runs/:id unchanged', async () => {
  const both = await runHealthCheck({ client: fakeInstance(ESTATE, { absent: ABSENT }), explain: false, modules: ['cmdb', 'itsm'], reuse: false, user: 'admin', now: NOW });
  const l = both.manifest.links.links.find((x) => x.id === LINK);
  assert.equal(both.manifest.links.version, L.LINKS_VERSION);
  assert.equal(l.status, 'unavailable');
  assert.deepEqual([l.blocker.rule, l.blocker.state], ['CMDB-058', 'skipped']);
  assert.ok(both.manifest.skipped_checks.some((s) => s.rule === 'CMDB-058'), 'the link claims a skip the scan did not record');
  /* the ITSM side was evaluated and answered per CI — the link had something to join */
  assert.equal(l.source.status, 'evaluated');

  const itsmOnly = await runHealthCheck({ client: fakeInstance(ESTATE, { absent: ABSENT }), explain: false, modules: ['itsm'], reuse: false, user: 'admin', now: NOW });
  const l2 = itsmOnly.manifest.links.links.find((x) => x.id === LINK);
  assert.deepEqual([l2.status, l2.blocker.rule, l2.blocker.state], ['unavailable', 'CMDB-058', 'not_read']);

  /* the link adds no finding: every finding the scan detected belongs to a rule, none to the link */
  assert.equal(both.findings.filter((f) => String(f.rule_id).startsWith('LINK-')).length, 0);

  const runId = openRun();
  completeRun(runId, both);
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthRouter);
  const server = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health/runs/${runId}`);
    const { run } = await res.json();
    assert.deepEqual(run.manifest.links, JSON.parse(JSON.stringify(both.manifest.links)));
    /* skipped checks name their scope for the module tabs */
    for (const s of run.manifest.skipped_checks) assert.ok(['cmdb', 'itom', 'itsm', 'platform'].includes(s.scope), JSON.stringify(s));
  } finally {
    server.close();
  }
});
