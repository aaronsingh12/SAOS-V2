import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-itsm-mh-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'm.db'))));
const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev000001.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const { runHealthCheck, itsmMeasureHistoryFrom, buildParameterRegistry } = await import('../src/health/index.js');
const MH = await import('../src/health/itsm/measure-history.js');
const { openRun, completeRun, itsmHistoryRuns } = await import('../src/health/store.js');
const { fakeInstance } = await import('./helpers/itsm-fake-instance.js');
const { ESTATE, ABSENT, NOW } = await import('./helpers/itsm-estate.js');

/*
 * ITSM MEASURE HISTORY — ITSM-041 ("First-call resolution rate declining —
 * Requires at least 3 windows") is judged only from real, comparable readings of
 * earlier scans of THIS instance. Never back-filled, never across a changed
 * configuration, never from a verification.
 */

const KEY = 'ITSM-041:first_call_resolution_pct';
const DAY = 86_400_000;

/* Resolved incidents with `firstCall` of them resolved with zero reassignments. */
function estateWithFcr(firstCall) {
  const resolved = ESTATE.incident.filter((i) => i.resolved_at);
  return { ...ESTATE, incident: ESTATE.incident.map((i) => (i.resolved_at ? { ...i, reassignment_count: resolved.indexOf(i) < firstCall ? '0' : '3' } : i)) };
}

async function storedScan(tables, at, itsm = {}) {
  const r = await runHealthCheck({
    client: fakeInstance(tables, { absent: ABSENT }), explain: false, modules: ['itsm'], reuse: false, user: 'admin', now: at,
    itsm: { ...itsm, measureHistory: itsmMeasureHistoryFrom(itsmHistoryRuns()) },
  });
  const runId = openRun();
  completeRun(runId, r);
  const row = r.manifest.itsm.rules.find((x) => x.rule_id === 'ITSM-041');
  return { r, row, runId };
}

test('COMPARABILITY: the same configuration and parameters give the same key; a changed parameter value gives another', () => {
  const a = MH.measureComparability('ITSM-041');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(MH.measureComparability('ITSM-041'), a);
  assert.notEqual(MH.measureComparability('ITSM-041', { runtime: { 'ITSM-041': { min_windows: 4 } } }), a, 'a changed parameter kept the key');
  assert.notEqual(MH.measureComparability('ITSM-030'), a, 'two rules share a key');
  assert.equal(MH.measureComparability('ITSM-999'), null);
});

test('ELIGIBILITY and FILTER: verifications, degraded and pre-history runs contribute nothing; readings under another key, without a value, or not earlier than the scan are set aside and counted', () => {
  const m = (value, at, comparability) => ({ itsm: { measures: { [KEY]: { value, at, comparability } } } });
  const key = MH.measureComparability('ITSM-041');
  const runs = [
    { id: 'r5', status: 'completed', manifest: { ...m(40, '2026-09-20T00:00:00.000Z', key) } },
    { id: 'r4', status: 'completed', manifest: { kind: 'verification', ...m(50, '2026-09-14T00:00:00.000Z', key) } },
    { id: 'r3', status: 'partial', manifest: { degraded: { itsm: ['incident: forbidden'] }, ...m(60, '2026-09-13T00:00:00.000Z', key) } },
    { id: 'r2', status: 'completed', manifest: { itsm: { rules: [] } } },
    { id: 'r1', status: 'completed', manifest: { ...m(70, '2026-09-12T00:00:00.000Z', 'another-model') } },
    { id: 'r0', status: 'completed', manifest: { ...m(null, '2026-09-11T00:00:00.000Z', key) } },
    { id: 'rA', status: 'completed', manifest: { ...m(80, '2026-09-10T00:00:00.000Z', key) } },
  ];
  const h = MH.historyFromRuns(runs);
  assert.deepEqual(h.excluded.map((x) => x.run_id).sort(), ['r2', 'r3', 'r4']);
  assert.deepEqual(h.readings[KEY].map((x) => x.run_id), ['rA', 'r0', 'r1', 'r5'], 'readings not oldest first');
  const scan = MH.historyForScan(h, { now: new Date('2026-09-15T00:00:00.000Z') });
  assert.deepEqual(scan.measureHistory[KEY], [{ value: 80, at: '2026-09-10T00:00:00.000Z' }]);
  assert.deepEqual(scan.used, { [KEY]: 1 });
  assert.deepEqual(scan.set_aside[KEY], { count: 3, other_model: 1, no_value: 1, not_earlier: 1 });
});

test('ITSM-041 over stored scans: 1 and 2 readings stay INCONCLUSIVE (insufficient_history); the 3rd comparable scan judges the trend — a steady rate passes, a falling one fails', async () => {
  /* steady: 2 of 3 resolved incidents first-call each time */
  const s1 = await storedScan(estateWithFcr(2), new Date(NOW.getTime()));
  assert.deepEqual([s1.row.status, s1.row.verdict, s1.row.undetermined?.kind], ['evaluated', 'inconclusive', 'insufficient_history']);
  assert.ok(s1.r.manifest.itsm.measures[KEY], 'the scan did not store its reading');
  assert.equal(s1.r.manifest.itsm.measures[KEY].timezone, 'UTC');
  assert.equal(s1.r.manifest.itsm.measures[KEY].at, new Date(NOW.getTime()).toISOString());
  const s2 = await storedScan(estateWithFcr(2), new Date(NOW.getTime() + DAY));
  assert.deepEqual([s2.row.verdict, s2.row.undetermined?.kind], ['inconclusive', 'insufficient_history']);
  assert.equal(s2.r.manifest.itsm.measure_history.used[KEY], 1);
  const s3 = await storedScan(estateWithFcr(2), new Date(NOW.getTime() + 2 * DAY));
  assert.equal(s3.r.manifest.itsm.measure_history.used[KEY], 2);
  assert.deepEqual([s3.row.status, s3.row.verdict, s3.row.findings], ['evaluated', 'pass', 0], 'a steady first-call rate over 3 windows was not judged');

  /* a changed parameter starts a new series: the earlier readings are set aside, not compared */
  const { registry } = buildParameterRegistry([{ rule_id: 'ITSM-041', key: 'min_windows', value: 3 }]);
  const changed = await storedScan(estateWithFcr(2), new Date(NOW.getTime() + 3 * DAY), { runtime: { 'ITSM-041': { min_windows: 4 } }, parameters: registry });
  assert.deepEqual([changed.row.verdict, changed.row.undetermined?.kind], ['inconclusive', 'insufficient_history']);
  assert.ok(changed.r.manifest.itsm.measure_history.set_aside[KEY].other_model >= 3);
});

test('ITSM-041 falling: 3 comparable scans with a declining first-call rate FAIL, with the trend as evidence', async () => {
  /* a fresh store for this series — earlier tests' readings would sit under the same key */
  _setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'm2.db'))));
  await storedScan(estateWithFcr(3), new Date(NOW.getTime() + 10 * DAY));
  await storedScan(estateWithFcr(2), new Date(NOW.getTime() + 11 * DAY));
  const s = await storedScan(estateWithFcr(1), new Date(NOW.getTime() + 12 * DAY));
  assert.deepEqual([s.row.status, s.row.verdict, s.row.findings], ['evaluated', 'fail', 1]);
  const f = s.r.findings.find((x) => x.rule_id === 'ITSM-041');
  assert.match(f.detail.basis, /falling over 3 windows/);
});
