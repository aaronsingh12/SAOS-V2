import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-replay-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'r.db'))));
const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev000001.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const { runHealthCheck } = await import('../src/health/index.js');
const { cmdbHistoryFromRuns } = await import('../src/health/cmdb-history.js');
const { DRIFT_RULES } = await import('../src/health/cmdb-drift.js');
const { TREND_RULE_INPUTS } = await import('../src/health/cmdb-history.js');
const { TABLES } = await import('../src/health/tables.js');

/*
 * THE STABLE-ESTATE REPLAY — a permanent regression test (confirmed 17 Sep 2026).
 *
 * The trend layer's first duty is to invent nothing. On dev424910 the Group 14
 * replay fed one run's 20,951 real findings back as two earlier snapshots and got
 * net position 0/0/0, no recurrence, no new duplicate set and 77 → 77 → 77. This
 * is the same claim held permanently, through the PRODUCTION path end to end:
 * three real `runHealthCheck` scans of one unchanged in-memory estate, a day
 * apart, each handed the history `cmdbHistoryFromRuns` builds from the runs before
 * it — exactly what `store.cmdbMeasureHistory` does with stored runs. Only the
 * database write is skipped.
 *
 * If any rule's fingerprint, measure or score depends on something other than the
 * estate (the clock, iteration order, a random id), this fails.
 */

const T0 = new Date('2026-09-10T06:00:00Z');
const DAY = 86_400_000;

function fakeInstance(tables) {
  return {
    async changeStamp(t) {
      const rows = tables[t] || [];
      return { count: rows.length, maxUpdated: rows.map((r) => r.sys_updated_on).sort().pop() || null };
    },
    async count(t) { return (tables[t] || []).length; },
    async countBy() { return {}; },
    async query(t, { query, limit }) {
      const rows = [...(tables[t] || [])].sort((a, b) => a.sys_id.localeCompare(b.sys_id));
      const after = /\^sys_id>([^^]+)/.exec(String(query))?.[1] ?? null;
      const start = after == null ? 0 : rows.findIndex((r) => r.sys_id > after);
      return start < 0 ? [] : rows.slice(start, start + limit);
    },
  };
}

const ci = (id, cls, extra = {}) => ({
  sys_id: id, name: id, sys_class_name: cls, install_status: '1', operational_status: '1',
  sys_created_on: '2024-03-01 00:00:00', sys_updated_on: '2026-08-20 00:00:00', sys_updated_by: 'admin',
  serial_number: `SN-${id}`, ip_address: '', owned_by: '', managed_by: '', support_group: '', ...extra,
});

/* An estate with real defects of several kinds, so "nothing changed" is tested
   against findings that exist, not against an empty list. */
function estate() {
  const servers = Array.from({ length: 12 }, (_, i) => ci(`s${String(i).padStart(2, '0')}`, 'cmdb_ci_server'));
  servers[1].serial_number = servers[0].serial_number;          // a duplicate set
  servers[2].serial_number = '';                                  // a completeness gap
  servers[3].owned_by = 'u1';                                     // one owned CI
  const computers = Array.from({ length: 30 }, (_, i) => ci(`pc${String(i).padStart(2, '0')}`, 'cmdb_ci_computer'));
  computers[4].install_status = '7';                              // retired
  const edges = [['s00', 's04'], ['s04', 's05'], ['s06', 'pc01']].map(([parent, child], i) => ({
    sys_id: `r${i}`, parent, child, type: 't1', 'type.name': 'Depends on::Used by', sys_updated_on: '2026-08-20 00:00:00',
  }));
  const classes = ['cmdb_ci', 'cmdb_ci_hardware', 'cmdb_ci_computer', 'cmdb_ci_server'];
  return {
    cmdb_ci: [...servers, ...computers],
    cmdb_rel_ci: edges,
    sys_db_object: classes.map((name) => ({
      sys_id: name, name,
      'super_class.name': { cmdb_ci: 'cmdb', cmdb_ci_hardware: 'cmdb_ci', cmdb_ci_computer: 'cmdb_ci_hardware', cmdb_ci_server: 'cmdb_ci_computer' }[name],
    })),
  };
}

test('STABLE-ESTATE REPLAY: three scans of an unchanged estate invent no drift, no recurrence and no score movement', async () => {
  const instance = fakeInstance(estate());
  const stored = [];
  const results = [];
  for (let i = 0; i < 3; i += 1) {
    const at = new Date(T0.getTime() + i * DAY);
    const measureHistory = cmdbHistoryFromRuns(stored);
    const r = await runHealthCheck({
      client: instance, explain: false, modules: ['cmdb'], reuse: false, user: 'admin', now: at, measureHistory,
    });
    results.push(r);
    stored.push({
      id: `run-${i + 1}`, started_at: at.toISOString(), status: r.status, modules: ['cmdb'], manifest: r.manifest,
      findings: r.findings.map((f) => ({ fingerprint: f.fingerprint, rule_id: f.rule_id, domain: f.domain })),
    });
  }
  const [first, second, third] = stored;
  const cmdbOf = (run) => run.findings.filter((f) => /^(CMDB|REL|CSDM)-/.test(f.rule_id) && !DRIFT_RULES.includes(f.rule_id));

  /* The estate has real findings — otherwise "nothing changed" proves nothing. */
  assert.ok(cmdbOf(first).length >= 10, `only ${cmdbOf(first).length} CMDB findings — the fixture is too thin to prove stability`);
  assert.ok(first.manifest.cmdb_quality.composite.score != null, 'no composite to trend');

  /*
   * Identical fingerprints on every scan — the precondition of every trend rule.
   * ONE KIND OF ADDITION IS LEGITIMATE: a history-reading measure reaching its
   * snapshot floor (CMDB-128 reports a growth rate from the third snapshot). It is
   * a rule starting to measure, not the estate changing, and CMDB-131 must count
   * it as newly measured rather than created. Nothing may ever disappear.
   */
  const byFp = (run) => new Map(cmdbOf(run).map((f) => [f.fingerprint, f]));
  const [a, b, c] = [first, second, third].map(byFp);
  for (const [earlier, later, label] of [[a, b, 'scan 2'], [b, c, 'scan 3']]) {
    const gone = [...earlier.keys()].filter((fp) => !later.has(fp)).map((fp) => earlier.get(fp).rule_id);
    assert.deepEqual(gone, [], `${label}: findings disappeared from an unchanged estate`);
    const earlierRules = new Set([...earlier.values()].map((f) => f.rule_id));
    for (const fp of [...later.keys()].filter((x) => !earlier.has(x))) {
      const rule = later.get(fp).rule_id;
      assert.ok(TREND_RULE_INPUTS[rule] && !earlierRules.has(rule),
        `${label}: ${rule} produced a new finding on an unchanged estate, and it is not a trend measure reaching its snapshot floor`);
    }
  }
  const debuts = [...c.keys()].filter((fp) => !b.has(fp)).length;

  const q = third.manifest.cmdb_quality;
  const skipped = (id) => third.manifest.skipped_checks.filter((s) => s.rule === id).map((s) => s.reason).join(' | ');

  /* The layer is live — two comparable earlier readings under this rule version. */
  assert.equal(q.measures.trend_readiness.state, 'live');
  assert.equal(q.measures.trend_readiness.comparable_earlier_scans, 2);

  /* Nothing invented. */
  assert.deepEqual(
    third.findings.filter((f) => DRIFT_RULES.includes(f.rule_id)).map((f) => f.rule_id), [],
    'the trend layer reported drift on an unchanged estate',
  );
  const np = q.measures.net_position;
  assert.deepEqual([np.created, np.resolved, np.unverified, np.net], [0, 0, 0, 0]);
  assert.equal(np.newly_measured, debuts, 'a measure reaching its snapshot floor was counted as a created defect');
  assert.match(skipped('CMDB-132'), /No current finding recurred after a verified closure across 2 comparable snapshot/);
  assert.equal(
    third.findings.filter((f) => (f.modifiers?.escalators || []).includes('recurred')).length, 0,
    'a finding was escalated as recurred on an unchanged estate',
  );
  if (q.measures.duplicate_sets?.complete) {
    assert.deepEqual([q.measures.duplicate_inflow.new_sets, q.measures.duplicate_inflow.resolved_sets], [0, 0]);
  }
  const scores = q.measures.score_trend.points.map((p) => p.score);
  assert.equal(scores.length, 3);
  assert.equal(new Set(scores).size, 1, `the composite moved on an unchanged estate: ${scores.join(' → ')}`);
  assert.match(skipped('CMDB-137'), /not declining across the last 3 comparable readings/);
  assert.deepEqual(
    third.manifest.cmdb_quality.dimensions.map((d) => [d.key, d.score]),
    first.manifest.cmdb_quality.dimensions.map((d) => [d.key, d.score]),
    'a dimension score moved on an unchanged estate',
  );
  assert.ok(TABLES.cmdb_ci, 'the table registry was not loaded');
  /* Every scan says where its analysis time went, pack by pack, with the tables each read. */
  const stages = results[2].manifest.phases.analyse_stages;
  assert.ok(stages.length >= 20, `only ${stages.length} analysis stages were timed`);
  assert.ok(stages.every((st) => Number.isFinite(st.ms) && Array.isArray(st.tables)));
  assert.ok(stages.find((st) => st.stage === 'cmdb: relationships D6 (Group 6)').tables.includes('cmdb_rel_ci'));
  assert.ok(Number.isFinite(results[2].manifest.phases.score_ms));
  const rate = results[2].findings.find((f) => f.rule_id === 'CMDB-128');
  assert.ok(rate, 'CMDB-128 did not reach its snapshot floor on the third scan');
  assert.match(rate.description, /are flat across 3 snapshots/, 'a flat estate was described as growing');
});
