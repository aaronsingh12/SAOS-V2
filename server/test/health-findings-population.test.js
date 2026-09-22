import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-findings-pop-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'p.db'))));
const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev000001.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const { runHealthCheck } = await import('../src/health/index.js');
const { summariseScopes, scopeOf } = await import('../src/health/scopes.js');
const { openRun, completeRun, listModuleFindings, moduleResults } = await import('../src/health/store.js');
const { getDb } = await import('../src/memory/db.js');
const { fakeInstance } = await import('./helpers/itsm-fake-instance.js');
const { ESTATE, ABSENT, NOW } = await import('./helpers/itsm-estate.js');
const { default: express } = await import('express');
const { healthRouter } = await import('../src/routes/health.js');

/*
 * THE FINDINGS A VIEW COUNTS ARE THE FINDINGS IT LISTS.
 *
 * Measured on an instance with 29,177 findings: the ITSM view's chips said
 * Systemic 35 · Critical 78 · High 40 · Moderate 280 · Low 56 (All 489) —
 * counted at scan time from the full detected set — while the table, served
 * from the stored rows, listed 35 · 78 · 40 · 33 · 0 (All 186). The run had
 * stored only the 25,000 highest-priority_score findings ACROSS ALL MODULES;
 * the cut fell at 3.0, every ITSM Low finding scores 1.6–1.8, and 247 of the
 * 280 Moderate scored 2.4–2.99. Selecting Low listed nothing.
 *
 * The first suite runs a scan whose findings exceed that former cap, through
 * runHealthCheck — the path that sliced — and holds the page's own read path
 * (listModuleFindings, the export route) to the scan's own counts. The second
 * reproduces the reported population exactly, so the reported numbers are
 * the assertion.
 */

const SEVERITIES = ['SYSTEMIC', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/* The shared fake cannot evaluate `^OR`; the extraction slice is exactly that
   shape (active OR recently updated). Every row here is active, so dropping
   the OR half reads the same rows — see health-itsm-integration.test.js. */
const sliced = new Set(['incident', 'change_request', 'problem']);
const unOr = (q) => String(q || '').replace(/\^ORsys_updated_on>=[^^]*/, '');
const wrap = (c) => ({
  ...c,
  query: (t, o = {}) => c.query(t, sliced.has(t) ? { ...o, query: unOr(o.query) } : o),
  count: (t, q) => c.count(t, sliced.has(t) ? unOr(q) : q),
  changeStamp: (t, q) => c.changeStamp(t, sliced.has(t) ? unOr(q) : q),
});

/** N open incidents with no CI and no assignment group: one Low and one Moderate legacy finding each. */
function openIncidents(n) {
  const base = ESTATE.incident[0];
  return Array.from({ length: n }, (_, i) => ({
    ...base, sys_id: `inc-x${String(i).padStart(6, '0')}`, number: `INCX${String(i).padStart(6, '0')}`,
    state: '2', active: 'true', resolved_at: '', closed_at: '', closed_by: '', close_code: '', close_notes: '',
    assignment_group: '', assigned_to: '', cmdb_ci: '', business_service: '',
    sys_created_on: '2026-09-10 09:00:00', sys_updated_on: '2026-09-10 09:00:00',
  }));
}

async function routed(fn) {
  const app = express();
  app.use('/api/health', healthRouter);
  const server = await new Promise((resolve) => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
  try { return await fn(`http://127.0.0.1:${server.address().port}/api/health`); } finally { server.close(); }
}
const csvLines = (text) => text.split(/\r?\n/).filter(Boolean);

/* Per severity, what the chips show (the scan's counts) and what the table lists (the store's rows). */
function chipsAndRows(counts, scope = 'itsm') {
  return SEVERITIES.map((severity) => ({
    severity,
    chip: counts[severity] || 0,
    rows: listModuleFindings({ scope, severity, limit: 200 }).total,
  }));
}

/* ════════════════════════════════════════════════════════════════════════
   1. Through the scan: more findings than the former cap
   ════════════════════════════════════════════════════════════════════════ */

let big = null;
async function bigScan() {
  if (big) return big;
  /* 13,000 open incidents → 26,000 legacy findings (Low 1.8, Moderate 3.0) on
     top of the fixture's own — above the former 25,000 cut, with every Low
     finding at the bottom of the priority order, as on the measured instance. */
  const client = wrap(fakeInstance({ ...ESTATE, incident: [...ESTATE.incident, ...openIncidents(13_000)] }, { absent: ABSENT }));
  const r = await runHealthCheck({ client, explain: false, modules: ['itsm'], reuse: false, user: 'admin', now: NOW });
  const runId = openRun();
  completeRun(runId, r);
  big = { r, runId };
  return big;
}

test('a run stores every finding it detected — findings_stored equals findings_detected above 25,000, and nothing is marked truncated', async () => {
  const { r, runId } = await bigScan();
  assert.ok(r.manifest.findings_detected > 25_000, `the fixture must exceed the former cap to prove anything (detected ${r.manifest.findings_detected})`);
  assert.equal(r.manifest.findings_stored, r.manifest.findings_detected);
  assert.equal(r.manifest.findings_truncated, false);
  assert.equal(r.findings.length, r.manifest.findings_detected);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM health_findings WHERE run_id = ?').get(runId).n, r.manifest.findings_detected, 'rows written differ from findings detected');
  assert.equal(moduleResults().itsm.runId, runId, 'the run is the ITSM module\'s current result');
});

test('every severity chip equals the rows its filter lists — Low included — and the chips sum to All', async () => {
  const { r } = await bigScan();
  const itsm = r.manifest.scopes.itsm;
  const table = chipsAndRows(itsm.severity_counts);
  for (const row of table) assert.equal(row.rows, row.chip, `${row.severity}: chip ${row.chip}, filter lists ${row.rows}`);
  const low = table.find((x) => x.severity === 'LOW');
  assert.ok(low.chip > 1_000 && low.rows === low.chip, `Low: chip ${low.chip}, rows ${low.rows}`);
  assert.equal(table.reduce((a, x) => a + x.chip, 0), itsm.findings, 'the severity counts do not sum to the scope\'s findings');
  assert.equal(listModuleFindings({ scope: 'itsm', limit: 200 }).total, itsm.findings, 'All lists fewer than it counts');
});

test('the Low filter lists the actual Low findings: the same fingerprints, rules and severity the scan produced', async () => {
  const { r } = await bigScan();
  const expected = new Map(r.findings.filter((f) => f.severity === 'LOW' && scopeOf(f) === 'itsm').map((f) => [f.fingerprint, f]));
  const listed = [];
  for (let offset = 0; ; offset += 500) {
    const page = listModuleFindings({ scope: 'itsm', severity: 'LOW', limit: 500, offset });
    listed.push(...page.findings);
    if (!page.findings.length || listed.length >= page.total) break;
  }
  assert.equal(listed.length, expected.size);
  assert.equal(listed.length, r.manifest.scopes.itsm.severity_counts.LOW, 'the Low list is not the Low count');
  for (const f of listed) {
    const e = expected.get(f.fingerprint);
    assert.ok(e, `${f.rule_id} ${f.title} was listed but never detected`);
    assert.equal(f.severity, 'LOW');
    assert.equal(f.rule_id, e.rule_id);
  }
  assert.ok(listed.some((f) => f.rule_id === 'ITSM-INC-NO-CI'), 'the fixture\'s Low rule is missing from the list');
  /* The lowest-priority finding of the whole run is a stored, listable row. */
  const floor = Math.min(...r.findings.map((f) => f.priority_score));
  assert.ok(listed.some((f) => f.priority_score === floor), `no listed Low finding sits at the run's priority floor ${floor}`);
});

test('searching while Low is selected searches the Low population; clearing Low returns everything', async () => {
  const { r } = await bigScan();
  const one = r.findings.find((f) => f.severity === 'LOW' && f.title.includes('INCX012999'));
  assert.ok(one, 'the fixture should have a Low finding for the last incident');
  const hit = listModuleFindings({ scope: 'itsm', severity: 'LOW', q: 'INCX012999', limit: 200 });
  assert.equal(hit.total, 1);
  assert.equal(hit.findings[0].fingerprint, one.fingerprint);
  /* A Moderate finding on the same incident is outside the Low filter. */
  assert.equal(listModuleFindings({ scope: 'itsm', severity: 'MEDIUM', q: 'INCX012999', limit: 200 }).total, 1);
  /* The severity filters partition the search: without one, the search sees every finding that names the incident. */
  const unfiltered = listModuleFindings({ scope: 'itsm', q: 'INCX012999', limit: 200 }).total;
  const bySeverity = SEVERITIES.reduce((a, severity) => a + listModuleFindings({ scope: 'itsm', severity, q: 'INCX012999', limit: 200 }).total, 0);
  assert.ok(unfiltered >= 2, 'the search without a severity should see both findings on the incident');
  assert.equal(unfiltered, bySeverity);
  assert.equal(listModuleFindings({ scope: 'itsm', limit: 200 }).total, r.manifest.scopes.itsm.findings);
});

test('the CSV export carries every stored row, and the Low export carries every Low row', async () => {
  const { r } = await bigScan();
  await routed(async (base) => {
    const all = csvLines(await (await fetch(`${base}/modules/export.csv?scope=itsm`)).text());
    assert.equal(all.length - 1, r.manifest.scopes.itsm.findings, 'the export stopped short of the findings the view counts');
    const low = csvLines(await (await fetch(`${base}/modules/export.csv?scope=itsm&severity=LOW`)).text());
    assert.equal(low.length - 1, r.manifest.scopes.itsm.severity_counts.LOW);
    const perRun = csvLines(await (await fetch(`${base}/runs/${big.runId}/export.csv?scope=itsm&severity=LOW`)).text());
    assert.equal(perRun.length, low.length);
    /* The page reads the same endpoint the export does: the same total, paged. */
    const api = await (await fetch(`${base}/modules/findings?scope=itsm&severity=LOW&limit=200`)).json();
    assert.equal(api.total, r.manifest.scopes.itsm.severity_counts.LOW);
    assert.equal(api.findings.length, 200);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   2. The reported population, exactly: 489 ITSM findings under 28,688 others
   ════════════════════════════════════════════════════════════════════════ */

const REPORTED = { SYSTEMIC: 35, CRITICAL: 78, HIGH: 40, MEDIUM: 280, LOW: 56 };
/* Priority scores as the measured instance carried them, per severity. */
const SCORE = { SYSTEMIC: [6, 60], CRITICAL: [5, 50], HIGH: [3.6, 4], MEDIUM: [2.4, 3], LOW: [1.6, 1.8] };
const LOW_RULES = ['ITSM-INC-NO-CI', 'ITSM-PRB-STALE'];

function reportedPopulation() {
  const findings = [];
  let n = 0;
  const one = (o) => {
    n += 1;
    findings.push({
      fingerprint: `fp-${n}`, agent_id: 'incident_agent', domain: 'INCIDENT', table: 'incident', priority: 'P3', confidence: 0.9,
      title: `finding ${n}`, description: '', recommendation: '', target_ids: [`sys-${n}`], evidence: [], ...o,
    });
  };
  for (const severity of SEVERITIES) {
    const [lo, hi] = SCORE[severity];
    for (let i = 0; i < REPORTED[severity]; i++) {
      one({
        severity, priority_score: Number((lo + (hi - lo) * (i / Math.max(1, REPORTED[severity] - 1))).toFixed(2)),
        rule_id: severity === 'LOW' ? LOW_RULES[i % 2] : `ITSM-INC-${severity}`,
        table: severity === 'LOW' && i % 2 ? 'problem' : 'incident', domain: severity === 'LOW' && i % 2 ? 'PROBLEM' : 'INCIDENT',
        agent_id: severity === 'LOW' && i % 2 ? 'problem_agent' : 'incident_agent',
      });
    }
  }
  /* 28,688 CMDB findings at or above the score where the measured cut fell: exactly the 29,177 the instance had. */
  for (let i = 0; i < 29_177 - 489; i++) one({ severity: 'MEDIUM', priority_score: 3, rule_id: 'CMDB-001', agent_id: 'cmdb_agent', domain: 'CMDB', table: 'cmdb_ci' });
  return findings;
}

test('the reported ITSM population — 489 findings: 35 · 78 · 40 · 280 · 56 — lists exactly what it counts under 28,688 other findings', async () => {
  const findings = reportedPopulation();
  assert.equal(findings.length, 29_177);
  const coverage = { incident: { status: 'complete', records: 489 }, problem: { status: 'complete', records: 28 }, cmdb_ci: { status: 'complete', records: 28_688 } };
  /* What the chips read: the scan's own summary of the same findings. */
  const scopes = summariseScopes(coverage, findings);
  assert.deepEqual(scopes.itsm.severity_counts, REPORTED);
  assert.equal(scopes.itsm.findings, 489);
  assert.equal(35 + 78 + 40 + 280 + 56, 489);

  /* Stored as a full scan, newer than the ITSM-only scan above, so it is every module's current result. */
  const runId = openRun();
  completeRun(runId, {
    status: 'completed', findings,
    manifest: { modules: ['cmdb', 'itom', 'itsm', 'platform'], coverage, scopes, findings_detected: findings.length, findings_stored: findings.length, findings_truncated: false, severity_counts: {} },
  });
  assert.equal(moduleResults().itsm.runId, runId);

  const table = chipsAndRows(scopes.itsm.severity_counts);
  assert.deepEqual(table, [
    { severity: 'SYSTEMIC', chip: 35, rows: 35 },
    { severity: 'CRITICAL', chip: 78, rows: 78 },
    { severity: 'HIGH', chip: 40, rows: 40 },
    { severity: 'MEDIUM', chip: 280, rows: 280 },
    { severity: 'LOW', chip: 56, rows: 56 },
  ]);
  assert.equal(listModuleFindings({ scope: 'itsm', limit: 200 }).total, 489);

  const low = listModuleFindings({ scope: 'itsm', severity: 'LOW', limit: 200 });
  assert.equal(low.findings.length, 56);
  assert.ok(low.findings.every((f) => f.severity === 'LOW' && LOW_RULES.includes(f.rule_id)));
  assert.equal(listModuleFindings({ scope: 'itsm', severity: 'LOW', q: 'ITSM-PRB-STALE', limit: 200 }).total, 28, 'search within Low');
  assert.equal(listModuleFindings({ scope: 'itsm', severity: 'LOW', q: 'no such thing', limit: 200 }).total, 0);
  /* The other modules' rows are not in the ITSM view, and the All view holds every row. */
  assert.equal(listModuleFindings({ scope: 'cmdb', limit: 200 }).total, 28_688);
  assert.equal(listModuleFindings({ scope: 'all', limit: 200 }).total, 29_177);

  await routed(async (base) => {
    const low = csvLines(await (await fetch(`${base}/modules/export.csv?scope=itsm&severity=LOW`)).text());
    assert.equal(low.length - 1, 56);
    const all = csvLines(await (await fetch(`${base}/modules/export.csv`)).text());
    assert.equal(all.length - 1, 29_177, 'the All export stopped short of the stored population');
  });
});
