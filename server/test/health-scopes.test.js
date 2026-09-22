import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-scopes-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 's.db'))));
const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev000000.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const {
  SCOPES, SCOPE_KEYS, RULE_SCOPE, scopeOf, inScope, normaliseScope, summariseScopes, scopeVocabulary,
} = await import('../src/health/scopes.js');
const { EstateRules, AGENTS } = await import('../src/health/rules.js');
const { TABLES } = await import('../src/health/tables.js');
const { fetchTable } = await import('../src/health/extract.js');
const { qualityScore } = await import('../src/health/index.js');
const { FIX_FIELD } = await import('../src/health/proposal.js');
const { openRun, completeRun, listFindings, scopesForRun, getRun } = await import('../src/health/store.js');

/*
 * Health Assist — the CMDB / ITOM / ITSM / Platform switch.
 *
 * The switch is only trustworthy if two things hold: every finding lands in
 * exactly one scope, the SAME one whether it is counted in memory or filtered
 * in SQL; and every score describes only what was read, with a specific reason
 * when it cannot.
 */

const NOW = new Date('2026-09-14T00:00:00Z');
const FULL = (records) => ({ status: 'complete', rows_complete: true, records, reported_total: records, missing_fields: [] });
const f = (over) => ({ severity: 'MEDIUM', target_ids: ['x'], table: 'cmdb_ci', ...over });

/* ── Every finding lands in exactly one scope ──────────────────────────── */

test('family-label skip ids route to their own module: ITSM, CSDM (CMDB service rules) and SM (ITOM service mapping) — never to Platform', async () => {
  const { scopeOfRule } = await import('../src/health/scopes.js');
  assert.equal(scopeOfRule('ITSM'), 'itsm');
  assert.equal(scopeOfRule('CSDM'), 'cmdb');
  assert.equal(scopeOfRule('SM'), 'itom');
  /* a real platform rule still routes to platform, and a look-alike is not captured */
  assert.equal(scopeOfRule('SEC-INACTIVE-ROLE'), 'platform');
  assert.equal(scopeOfRule('SMX'), 'platform');
});

test('every domain the rule pack can emit belongs to exactly one real scope', () => {
  const real = SCOPES.filter((s) => s.domains);
  for (const [, [domain]] of Object.entries(AGENTS)) {
    const owners = real.filter((s) => s.domains.includes(domain));
    assert.equal(owners.length, 1, `${domain} is claimed by ${owners.length} scopes`);
  }
});

test('a rule override outranks its domain', () => {
  // A stuck ECC queue is a MID server not collecting work — an ITOM fact.
  assert.equal(scopeOf({ rule_id: 'PERF-ECC-AGE', domain: 'PERFORMANCE' }), 'itom');
  assert.equal(scopeOf({ rule_id: 'PERF-JOB-ERROR', domain: 'PERFORMANCE' }), 'platform');
});

test('an unknown domain falls into Platform instead of vanishing from every view', () => {
  assert.equal(scopeOf({ rule_id: 'FUTURE-RULE', domain: 'SOMETHING_NEW' }), 'platform');
});

test('an unknown scope key reads as "all", never as an empty view', () => {
  assert.equal(normaliseScope('itsm'), 'itsm');
  assert.equal(normaliseScope('cmbd'), 'all');
  assert.equal(normaliseScope(undefined), 'all');
});

test('the SQL filter and the in-memory mapping put every finding in the SAME scope', async () => {
  /*
   * THE PROPERTY THE SWITCH RESTS ON. The findings list is filtered in SQL; the
   * counts and scores beside it are computed in memory. If the two disagreed
   * about one rule, the page would show a bar of 12 over a list of 11.
   */
  const findings = [];
  let i = 0;
  for (const [agent, [domain]] of Object.entries(AGENTS)) {
    findings.push({
      fingerprint: `fp${i}`, rule_id: `${domain}-X`, agent_id: agent, domain, table: 'cmdb_ci',
      severity: 'LOW', priority: 'P3', priority_score: 1, confidence: 1, title: 't', target_ids: [`id${i++}`],
    });
  }
  for (const rule of Object.keys(RULE_SCOPE)) {
    findings.push({
      fingerprint: `fp${i}`, rule_id: rule, agent_id: 'performance_agent', domain: 'PERFORMANCE', table: 'ecc_queue',
      severity: 'LOW', priority: 'P3', priority_score: 1, confidence: 1, title: 't', target_ids: [`id${i++}`],
    });
  }
  /*
   * PREFIXED RULES UNDER A FOREIGN DOMAIN — the case the first version of this
   * test never built. CMDB-124…130 report under PERFORMANCE and were missing from
   * the CMDB list while counted in its summary; the ITSM catalogue reports under
   * ITSM; the legacy ITSM family labels skips `ITSM`; an unknown domain with no
   * prefix is Platform's in memory and must be in SQL too.
   */
  const odd = [
    ['CMDB-124', 'performance_agent', 'PERFORMANCE'], ['ITSM-001', 'itsm_agent', 'ITSM'], ['ITSM-129', 'itsm_agent', 'PERFORMANCE'],
    ['ITSM', 'incident_agent', 'INCIDENT'], ['DISC-FOO', 'incident_agent', 'INCIDENT'], ['NOPREFIX-1', 'x_agent', 'MYSTERY'],
    ['CMDBX-1', 'cmdb_agent', 'CMDB'], ['cmdb-lowercase', 'performance_agent', 'PERFORMANCE'],
  ];
  for (const [rule, agent, domain] of odd) {
    findings.push({
      fingerprint: `fp${i}`, rule_id: rule, agent_id: agent, domain, table: 'cmdb_ci',
      severity: 'LOW', priority: 'P3', priority_score: 1, confidence: 1, title: 't', target_ids: [`id${i++}`],
    });
  }
  const runId = openRun();
  completeRun(runId, { status: 'completed', manifest: { cutoff: 'c', coverage: {} }, findings });

  for (const key of SCOPE_KEYS) {
    const fromSql = listFindings(runId, { scope: key, limit: 1000 }).findings.map((x) => x.fingerprint).sort();
    const inMemory = findings.filter((x) => inScope(x, key)).map((x) => x.fingerprint).sort();
    assert.deepEqual(fromSql, inMemory, `scope "${key}" disagrees between SQL and memory`);
  }
});

/* ── Scores ────────────────────────────────────────────────────────────── */

test('the CMDB score matches the long-standing definition, so the trend stays continuous', () => {
  const coverage = { cmdb_ci: FULL(4), cmdb_rel_ci: FULL(0) };
  const findings = [f({ domain: 'CMDB', target_ids: ['a'] }), f({ domain: 'CMDB', target_ids: ['a'] })];
  const estate = { cmdb_ci: [{}, {}, {}, {}] };
  assert.equal(summariseScopes(coverage, findings).cmdb.score, qualityScore(estate, coverage, findings));
  assert.equal(summariseScopes(coverage, findings).cmdb.score, 75);
});

test('a withheld CMDB score names the table that actually failed', () => {
  const partialCis = summariseScopes({
    cmdb_ci: { status: 'limited', rows_complete: false, records: 900, reported_total: 3412, missing_fields: [] },
    cmdb_rel_ci: FULL(10),
  }, []).cmdb;
  assert.equal(partialCis.score, null);
  assert.match(partialCis.score_withheld_because, /900 of 3,412 CIs/);

  const partialRels = summariseScopes({
    cmdb_ci: FULL(10),
    cmdb_rel_ci: { status: 'limited', rows_complete: false, records: 1, reported_total: 9, missing_fields: [] },
  }, []).cmdb;
  assert.match(partialRels.score_withheld_because, /relationship table/);
});

test('ITSM excludes a table it could not read completely, and says which', () => {
  const coverage = {
    incident: { ...FULL(10), filter: 'active, or updated in the last 90 days' },
    change_request: { status: 'forbidden', rows_complete: false, records: null, missing_fields: [] },
    problem: FULL(10),
  };
  const findings = [
    f({ domain: 'INCIDENT', table: 'incident', target_ids: ['i1'] }),
    f({ domain: 'CHANGE', table: 'change_request', target_ids: ['c1'] }), // from an unreadable table: not counted
  ];
  const itsm = summariseScopes(coverage, findings).itsm;
  /* ITSM Quality: one Moderate charge (5) over 20 records — 99.8, not the pass rate's 95. */
  assert.equal(itsm.score, 99.8, '1 Moderate charge over 20 scanned');
  assert.match(itsm.score_basis, /change_request excluded/);
  assert.match(itsm.score_basis, /active, or updated in the last 90 days/, 'the slice the score covers is not stated');
});

test('an ITSM score over nothing is withheld, not reported as 100', () => {
  const itsm = summariseScopes({ incident: FULL(0), change_request: FULL(0), problem: FULL(0) }, []).itsm;
  assert.equal(itsm.score, null);
  assert.match(itsm.score_withheld_because, /empty/);
});

test('an ITOM check whose table was unreadable is not applicable — never a pass', () => {
  /*
   * "We could not see the MID server table" must not score as "the MID servers
   * are fine". A check that cannot be evaluated is left out of the score
   * entirely rather than counted either way.
   */
  const coverage = {
    ecc_agent: { status: 'forbidden', rows_complete: false, records: null, missing_fields: [] },
    discovery_status: FULL(0),
    discovery_credentials: FULL(4),
    em_alert: { status: 'unavailable', rows_complete: false, records: null, missing_fields: [] },
  };
  const itom = summariseScopes(coverage, [{ rule_id: 'DISC-NEVER-RAN', domain: 'DISCOVERY', target_ids: [] }]).itom;
  const byKey = Object.fromEntries(itom.checks.map((c) => [c.key, c]));
  assert.equal(byKey.mid_present.result, 'not_applicable');
  assert.equal(byKey.events_bound.result, 'not_applicable');
  assert.match(byKey.events_bound.reason, /not on this instance/);
  assert.equal(byKey.discovery_ran.result, 'fail');
  assert.equal(byKey.credentials.result, 'pass');
  // 1 pass (credentials) of 2 applicable (discovery_ran, credentials).
  assert.equal(itom.score, 50);
  assert.match(itom.score_basis, /1 of 2 applicable checks pass/);
});

test('an EMPTY table makes a check not applicable — a vacuous truth is not a pass', () => {
  /*
   * Measured live: with zero alerts, "open alerts are bound to CIs" scored as a
   * pass and raised the ITOM score. Every member of an empty set satisfies any
   * condition; that is not evidence of health.
   */
  const itom = summariseScopes({ em_alert: FULL(0), ecc_queue: FULL(0), cmdb_ci_outage: FULL(0) }, []).itom;
  const byKey = Object.fromEntries(itom.checks.map((c) => [c.key, c]));
  for (const k of ['events_bound', 'ecc_flowing', 'outages_closed']) {
    assert.equal(byKey[k].result, 'not_applicable', `${k} passed on an empty table`);
  }
  assert.equal(itom.score, null, 'vacuous checks still produced a score');
});

test('with no MIDs, MID health is not applicable rather than a second failure', () => {
  const itom = summariseScopes({ ecc_agent: FULL(0) }, [{ rule_id: 'MID-NONE', domain: 'MID_SERVER', target_ids: [] }]).itom;
  const byKey = Object.fromEntries(itom.checks.map((c) => [c.key, c]));
  assert.equal(byKey.mid_present.result, 'fail');
  assert.equal(byKey.mid_healthy.result, 'not_applicable');
});

test('an ITOM score with no evaluable checks is withheld', () => {
  const itom = summariseScopes({}, []).itom;
  assert.equal(itom.score, null);
  assert.match(itom.score_withheld_because, /None of the ITOM checks could be evaluated/);
});

test('Platform gives no score, and explains why instead of printing one', () => {
  const p = summariseScopes({ sys_user_has_role: FULL(42000) }, []).platform;
  assert.equal(p.score, null);
  assert.equal(p.score_kind, 'none');
  assert.match(p.score_withheld_because, /no single meaningful denominator/);
});

test('a truncated set of findings withholds every score instead of computing from a fraction', () => {
  const coverage = { cmdb_ci: FULL(4), cmdb_rel_ci: FULL(0) };
  const s = summariseScopes(coverage, [], { truncated: true });
  assert.equal(s.cmdb.score, null);
  assert.match(s.cmdb.score_withheld_because, /stored only part of its findings/);
});

test('counts come from the findings passed in, per scope', () => {
  /*
   * REGRESSION. Counting the stored 1,000 of 12,194 put "989 Moderate, 0 Low"
   * on the page. The summary is handed the full detected set and counts it.
   */
  const findings = [
    f({ domain: 'CMDB', severity: 'LOW' }), f({ domain: 'CMDB', severity: 'MEDIUM' }),
    f({ domain: 'INCIDENT', severity: 'HIGH', table: 'incident' }),
  ];
  const s = summariseScopes({}, findings);
  assert.equal(s.all.findings, 3);
  assert.deepEqual(s.cmdb.severity_counts, { LOW: 1, MEDIUM: 1 });
  assert.deepEqual(s.itsm.severity_counts, { HIGH: 1 });
  assert.equal(s.itom.findings, 0);
});

test('an older run without stored scopes is re-read, and its scores withhold when it was truncated', () => {
  const runId = openRun();
  completeRun(runId, {
    status: 'partial',
    manifest: {
      cutoff: 'c', coverage: { cmdb_ci: FULL(3), cmdb_rel_ci: FULL(0) },
      findings_detected: 50, findings_stored: 1, findings_truncated: true,
    },
    findings: [{
      fingerprint: 'old1', rule_id: 'CMDB-OWNER', agent_id: 'cmdb_agent', domain: 'CMDB', table: 'cmdb_ci',
      severity: 'MEDIUM', priority: 'P3', priority_score: 1, confidence: 1, title: 't', target_ids: ['a'],
    }],
  });
  const scopes = scopesForRun(getRun(runId));
  assert.ok(scopes.cmdb, 'an older run could not be viewed under the switch');
  assert.equal(scopes.cmdb.score, null);
  assert.match(scopes.cmdb.score_withheld_because, /Run a new check/);
});

test('the vocabulary is served with every scope the switch can show', () => {
  const v = scopeVocabulary();
  assert.deepEqual(v.map((s) => s.key), ['all', 'cmdb', 'itom', 'itsm', 'platform']);
  for (const s of v) { assert.ok(s.label); assert.ok(s.description); }
});

test('every scope names only tables that exist in the allow-list', () => {
  for (const s of SCOPES.filter((x) => x.tables)) {
    for (const t of s.tables) assert.ok(TABLES[t], `${s.key} names ${t}, which is not in the allow-list`);
  }
});

/* ── ITSM rules ────────────────────────────────────────────────────────── */

const itsm = (estate) => new EstateRules(estate, Object.fromEntries(Object.keys(estate).map((t) => [t, FULL(estate[t].length)])), 90, NOW).analyze();
const ids = (findings, rule) => findings.filter((x) => x.rule_id === rule).map((x) => x.target_ids[0]).sort();

test('an unassigned OPEN incident is reported, HIGH for P1/P2; a closed one is not', () => {
  const found = itsm({
    incident: [
      { sys_id: 'i1', number: 'INC1', active: 'true', priority: '1', assignment_group: '', cmdb_ci: 'c', sys_created_on: '2026-09-13 23:00:00', sys_updated_on: '2026-09-13 23:00:00', reopen_count: '0' },
      { sys_id: 'i2', number: 'INC2', active: 'true', priority: '4', assignment_group: '', cmdb_ci: 'c', sys_created_on: '2026-09-13 23:00:00', sys_updated_on: '2026-09-13 23:00:00', reopen_count: '0' },
      { sys_id: 'i3', number: 'INC3', active: 'false', priority: '1', assignment_group: '', cmdb_ci: 'c', sys_created_on: '2026-09-13 23:00:00', sys_updated_on: '2026-09-13 23:00:00', reopen_count: '0' },
    ],
  });
  assert.deepEqual(ids(found, 'ITSM-INC-UNASSIGNED'), ['i1', 'i2']);
  assert.equal(found.find((x) => x.target_ids[0] === 'i1' && x.rule_id === 'ITSM-INC-UNASSIGNED').severity, 'HIGH');
  assert.equal(found.find((x) => x.target_ids[0] === 'i2' && x.rule_id === 'ITSM-INC-UNASSIGNED').severity, 'MEDIUM');
});

test('a HIDDEN assignment group is a coverage gap, not an unassigned incident', () => {
  // The field is absent from the row entirely — an ACL dropped it.
  const found = itsm({
    incident: [{ sys_id: 'i1', number: 'INC1', active: 'true', priority: '1', cmdb_ci: 'c', sys_created_on: '2026-09-13 23:00:00', sys_updated_on: '2026-09-13 23:00:00' }],
  });
  assert.equal(ids(found, 'ITSM-INC-UNASSIGNED').length, 0);
});

test('a P1 open more than a day is aged; one opened an hour ago is not', () => {
  const found = itsm({
    incident: [
      { sys_id: 'old', active: 'true', priority: '1', assignment_group: 'g', cmdb_ci: 'c', sys_created_on: '2026-09-10 00:00:00', sys_updated_on: '2026-09-13 23:00:00' },
      { sys_id: 'new', active: 'true', priority: '1', assignment_group: 'g', cmdb_ci: 'c', sys_created_on: '2026-09-13 23:00:00', sys_updated_on: '2026-09-13 23:00:00' },
    ],
  });
  assert.deepEqual(ids(found, 'ITSM-INC-P1-AGED'), ['old']);
});

test('no-CI is reported only when neither a CI nor a service is set', () => {
  const found = itsm({
    incident: [
      { sys_id: 'none', active: 'true', priority: '3', assignment_group: 'g', cmdb_ci: '', business_service: '', sys_created_on: '2026-09-13 23:00:00', sys_updated_on: '2026-09-13 23:00:00' },
      { sys_id: 'svc', active: 'true', priority: '3', assignment_group: 'g', cmdb_ci: '', business_service: 's1', sys_created_on: '2026-09-13 23:00:00', sys_updated_on: '2026-09-13 23:00:00' },
    ],
  });
  assert.deepEqual(ids(found, 'ITSM-INC-NO-CI'), ['none']);
});

test('stale is measured on open tasks only, across incident, change and problem', () => {
  const found = itsm({
    incident: [
      { sys_id: 'si', active: 'true', priority: '3', assignment_group: 'g', cmdb_ci: 'c', sys_created_on: '2026-06-01 00:00:00', sys_updated_on: '2026-07-01 00:00:00' },
      { sys_id: 'ci', active: 'false', priority: '3', assignment_group: 'g', cmdb_ci: 'c', sys_created_on: '2026-06-01 00:00:00', sys_updated_on: '2026-07-01 00:00:00' },
    ],
    change_request: [{ sys_id: 'sc', active: 'true', cmdb_ci: 'c', sys_updated_on: '2026-07-01 00:00:00' }],
    problem: [{ sys_id: 'sp', active: 'true', assignment_group: 'g', sys_updated_on: '2026-07-01 00:00:00' }],
  });
  assert.deepEqual(ids(found, 'ITSM-INC-STALE'), ['si']);
  assert.deepEqual(ids(found, 'ITSM-CHG-STALE'), ['sc']);
  assert.deepEqual(ids(found, 'ITSM-PRB-STALE'), ['sp']);
});

test('an open change past its planned end is overdue; failed changes are reported by close code', () => {
  const found = itsm({
    change_request: [
      { sys_id: 'late', active: 'true', cmdb_ci: 'c', end_date: '2026-09-10 00:00:00', sys_updated_on: '2026-09-13 00:00:00' },
      { sys_id: 'fine', active: 'true', cmdb_ci: 'c', end_date: '2026-09-20 00:00:00', sys_updated_on: '2026-09-13 00:00:00' },
      { sys_id: 'bad', active: 'false', cmdb_ci: 'c', close_code: 'unsuccessful', sys_updated_on: '2026-09-13 00:00:00' },
      { sys_id: 'good', active: 'false', cmdb_ci: 'c', close_code: 'successful', sys_updated_on: '2026-09-13 00:00:00' },
    ],
  });
  assert.deepEqual(ids(found, 'ITSM-CHG-OVERDUE'), ['late']);
  assert.deepEqual(ids(found, 'ITSM-CHG-FAILED'), ['bad']);
});

test('ITSM findings land in the ITSM scope', () => {
  const found = itsm({
    incident: [{ sys_id: 'i1', active: 'true', priority: '4', assignment_group: '', cmdb_ci: 'c', sys_created_on: '2026-09-13 23:00:00', sys_updated_on: '2026-09-13 23:00:00' }],
  });
  assert.ok(found.length > 0);
  for (const x of found) assert.equal(scopeOf(x), 'itsm');
});

test('ITSM tables are read as a stated slice, and the count uses the same condition', async () => {
  /*
   * If the count ignored the slice, `records < reported_total` would be true on
   * every run and ITSM could never be complete — so the score would never show.
   */
  const seen = {};
  const client = {
    count: async (t, where) => { seen.count = where; return 1; },
    query: async (t, { query }) => {
      seen.query ??= query;   // the FIRST page's query; later pages add a `sys_id >` watermark
      return query.includes('^sys_id>') ? [] : [{ sys_id: 'i1', sys_updated_on: '2026-09-01 00:00:00' }];
    },
  };
  const { coverage } = await fetchTable('incident', { cutoff: '2026-09-14 00:00:00', client });
  assert.match(seen.count, /\^active=true\^ORsys_updated_on>=2026-06-16 00:00:00$/);
  assert.equal(seen.query, `${seen.count}^ORDERBYsys_id`, 'the query and the count read different slices');
  assert.match(coverage.filter, /active, or updated in the last 90 days/);
});

test('time-based ITSM findings are never offered as a field write', () => {
  /*
   * A write that only moved sys_updated_on would make "untouched for 40 days"
   * disappear without anybody having done the work it pointed at.
   */
  for (const rule of ['ITSM-INC-STALE', 'ITSM-INC-P1-AGED', 'ITSM-CHG-STALE', 'ITSM-CHG-OVERDUE', 'ITSM-PRB-STALE', 'ITSM-CHG-FAILED', 'ITSM-INC-REOPENED']) {
    assert.equal(FIX_FIELD[rule], undefined, `${rule} is offered as a field fix`);
  }
  assert.equal(FIX_FIELD['ITSM-INC-UNASSIGNED'].references, 'sys_user_group');
  assert.equal(FIX_FIELD['ITSM-CHG-NO-CI'].references, 'cmdb_ci');
});

/* ── Score drivers ─────────────────────────────────────────────────────── */

test('a score explains itself: drivers count DISTINCT records per rule, largest first', () => {
  /*
   * Added after a live CMDB score of 0.3% — correct, and useless without
   * knowing that 3,233 of 3,412 CIs had no owner. The breakdown is what makes a
   * score actionable, so it is part of the summary rather than a UI extra.
   */
  const coverage = { cmdb_ci: FULL(10), cmdb_rel_ci: FULL(0) };
  const s = summariseScopes(coverage, [
    f({ rule_id: 'CMDB-OWNER', domain: 'CMDB', target_ids: ['a'] }),
    f({ rule_id: 'CMDB-OWNER', domain: 'CMDB', target_ids: ['a'] }),   // same CI twice: one record
    f({ rule_id: 'CMDB-OWNER', domain: 'CMDB', target_ids: ['b'] }),
    f({ rule_id: 'CMDB-STALE', domain: 'CMDB', target_ids: ['c', 'd', 'e'] }),
    f({ rule_id: 'CSDM-OWNER', domain: 'CSDM', table: 'cmdb_ci_service', target_ids: ['s'] }),  // not a CI
  ]).cmdb;
  assert.deepEqual(s.score_drivers.map((d) => [d.rule_id, d.records, d.share]), [
    ['CMDB-STALE', 3, 30],
    ['CMDB-OWNER', 2, 20],
  ]);
  assert.match(s.score_drivers[1].label, /nobody accountable/, 'a driver shows a rule id instead of words');
});

test('ITSM drivers come only from tables the score actually covered', () => {
  const coverage = {
    incident: FULL(4),
    change_request: { status: 'forbidden', rows_complete: false, records: null, missing_fields: [] },
    problem: FULL(0),
  };
  const s = summariseScopes(coverage, [
    f({ rule_id: 'ITSM-INC-STALE', domain: 'INCIDENT', table: 'incident', target_ids: ['i1'] }),
    f({ rule_id: 'ITSM-CHG-STALE', domain: 'CHANGE', table: 'change_request', target_ids: ['c1'] }),
  ]).itsm;
  assert.deepEqual(s.score_drivers.map((d) => d.rule_id), ['ITSM-INC-STALE'],
    'a driver was drawn from a table excluded from the score');
});

test('a stored summary that predates drivers is recomputed, not shown without them', () => {
  const runId = openRun();
  const coverage = { cmdb_ci: FULL(2), cmdb_rel_ci: FULL(0) };
  completeRun(runId, {
    status: 'completed',
    manifest: {
      cutoff: 'c', coverage, findings_detected: 1, findings_stored: 1,
      // Shaped like a run recorded before drivers existed.
      scopes: { cmdb: { key: 'cmdb', score: 50, findings: 1 } },
    },
    findings: [{
      fingerprint: 'pre1', rule_id: 'CMDB-OWNER', agent_id: 'cmdb_agent', domain: 'CMDB', table: 'cmdb_ci',
      severity: 'MEDIUM', priority: 'P3', priority_score: 1, confidence: 1, title: 't', target_ids: ['a'],
    }],
  });
  const scopes = scopesForRun(getRun(runId));
  assert.ok(Array.isArray(scopes.cmdb.score_drivers), 'the old summary was served without drivers');
  assert.equal(scopes.cmdb.score_drivers[0].rule_id, 'CMDB-OWNER');
  assert.ok(scopes.itsm, 'the recomputed summary is missing scopes the old one never had');
});
