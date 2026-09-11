import test from 'node:test';
import assert from 'node:assert/strict';

import { EstateRules, parseDate, RULE_VERSION, AGENTS } from '../src/health/rules.js';
import { TABLES, resolveTables, REQUIRED_TABLES } from '../src/health/tables.js';
import { qualityScore, clusterByRule } from '../src/health/index.js';
import { validateReply, unfence, explainFindings } from '../src/health/explain.js';
import { classifyFailure, isFatal, fetchTable } from '../src/health/extract.js';

/*
 * Health Assist — the rule pack and its honesty properties.
 *
 * These tests are about the things that make a finding trustworthy rather than
 * merely present: that an absence rule cannot run on a partial read, that a
 * rule which did not run says so, that a score is withheld rather than guessed,
 * and that a model cannot introduce a finding. Each one is a defect this module
 * would otherwise have shipped, because SAOS had measured every one of them.
 */

const COMPLETE = (table, records) => ({ table, status: 'complete', records, missing_fields: [] });
const LIMITED = (table, records) => ({ table, status: 'limited', records, missing_fields: ['owned_by'] });

function ci(sys_id, over = {}) {
  return {
    sys_id,
    name: `ci-${sys_id}`,
    sys_updated_on: '2026-09-01 00:00:00',
    owned_by: 'someone',
    serial_number: '',
    sys_class_name: 'cmdb_ci_server',
    ...over,
  };
}

const NOW = new Date('2026-09-11T00:00:00Z');

/* ── The allow-list ────────────────────────────────────────────────────── */

test('an unknown table is refused rather than silently dropped from the run', () => {
  // A caller who asked for cmdb_ci_serverz and got a clean run back would read
  // it as "no server problems".
  assert.throws(() => resolveTables(['cmdb_ci_serverz']), /not in the Health Assist extraction allow-list/i);
});

test('the required tables are always extracted even when a caller narrows the set', () => {
  const chosen = resolveTables(['ecc_agent']);
  for (const required of REQUIRED_TABLES) assert.ok(chosen.includes(required), `${required} was dropped`);
});

test('every table spec carries sys_id and sys_updated_on — identity and staleness', () => {
  for (const [name, spec] of Object.entries(TABLES)) {
    assert.ok(spec.fields.includes('sys_id'), `${name} has no sys_id`);
    assert.ok(spec.fields.includes('sys_updated_on'), `${name} has no sys_updated_on`);
  }
});

/* ── Coverage gating: the property that stops invented findings ─────────── */

test('the unrelated-CI rule does NOT run when relationship coverage is incomplete', () => {
  /*
   * THE DEFECT THIS PREVENTS. An ACL that hides half of cmdb_rel_ci makes every
   * CI look orphaned. "We could not read the table" must never render as "your
   * CMDB is broken".
   */
  const estate = { cmdb_ci: [ci('a'), ci('b')], cmdb_rel_ci: [] };
  const coverage = { cmdb_ci: COMPLETE('cmdb_ci', 2), cmdb_rel_ci: LIMITED('cmdb_rel_ci', 0) };
  const rules = new EstateRules(estate, coverage, 90, NOW);
  const findings = rules.analyze();

  assert.equal(findings.filter((f) => f.rule_id === 'CMDB-UNRELATED').length, 0);
  const skip = rules.skipped.find((s) => s.rule === 'CMDB-UNRELATED');
  assert.ok(skip, 'the skipped rule was not recorded');
  assert.match(skip.reason, /incomplete/i);
});

test('the same estate WITH complete relationship coverage does produce the finding', () => {
  // The other half of the pair: gating must not be a permanent silence.
  const estate = { cmdb_ci: [ci('a')], cmdb_rel_ci: [] };
  const coverage = { cmdb_ci: COMPLETE('cmdb_ci', 1), cmdb_rel_ci: COMPLETE('cmdb_rel_ci', 0) };
  const findings = new EstateRules(estate, coverage, 90, NOW).analyze();
  assert.equal(findings.filter((f) => f.rule_id === 'CMDB-UNRELATED').length, 1);
});

test('a table that was never extracted yields no rows and a recorded reason', () => {
  const rules = new EstateRules({}, {}, 90, NOW);
  assert.deepEqual(rules.rows('ecc_agent', [], { rule: 'MID-DOWN' }), []);
  assert.deepEqual(rules.skipped, [{ rule: 'MID-DOWN', table: 'ecc_agent', reason: 'not_requested' }]);
});

test('records missing a field the rule needs are excluded AND counted', () => {
  // sysparm_fields drops unknown names without complaint (trap #4), so a rule
  // running on 1 of 2 rows has to say so rather than report a clean result.
  const estate = { cmdb_ci: [ci('a', { serial_number: 'S1' }), { sys_id: 'b', sys_class_name: 'x' }] };
  const rules = new EstateRules(estate, { cmdb_ci: COMPLETE('cmdb_ci', 2) }, 90, NOW);
  const rows = rules.rows('cmdb_ci', ['serial_number', 'sys_class_name'], { rule: 'CMDB-DUPLICATE' });
  assert.equal(rows.length, 1);
  const skip = rules.skipped.find((s) => s.rule === 'CMDB-DUPLICATE');
  assert.equal(skip.excluded_records, 1);
});

/* ── Individual rules ──────────────────────────────────────────────────── */

test('placeholder serials are not treated as shared identities', () => {
  /*
   * "Unknown" on 400 CIs is one data-entry habit, not 400 duplicate pairs.
   * Without this exclusion the duplicate rule produces the single largest pile
   * of false findings in the pack.
   */
  const estate = {
    cmdb_ci: [
      ci('a', { serial_number: 'UNKNOWN' }),
      ci('b', { serial_number: 'unknown' }),
      ci('c', { serial_number: 'To be filled by O.E.M.' }),
      ci('d', { serial_number: 'REAL-1' }),
      ci('e', { serial_number: 'real-1' }),
    ],
  };
  const findings = new EstateRules(estate, { cmdb_ci: COMPLETE('cmdb_ci', 5) }, 90, NOW).analyze();
  const dupes = findings.filter((f) => f.rule_id === 'CMDB-DUPLICATE');
  assert.equal(dupes.length, 1, 'placeholder serials produced a duplicate finding');
  assert.deepEqual(dupes[0].target_ids.sort(), ['d', 'e']);
});

test('a self-referencing relationship is HIGH, and a duplicated edge is reported once', () => {
  const estate = {
    cmdb_ci: [ci('a'), ci('b')],
    cmdb_rel_ci: [
      { sys_id: 'r1', parent: 'a', child: 'a', type: 't' },
      { sys_id: 'r2', parent: 'a', child: 'b', type: 't' },
      { sys_id: 'r3', parent: 'a', child: 'b', type: 't' },
    ],
  };
  const coverage = { cmdb_ci: COMPLETE('cmdb_ci', 2), cmdb_rel_ci: COMPLETE('cmdb_rel_ci', 3) };
  const findings = new EstateRules(estate, coverage, 90, NOW).analyze();

  const self = findings.find((f) => f.rule_id === 'REL-SELF');
  assert.equal(self.severity, 'HIGH');
  const dup = findings.filter((f) => f.rule_id === 'REL-DUPLICATE');
  assert.equal(dup.length, 1);
  assert.deepEqual(dup[0].target_ids.sort(), ['r2', 'r3']);
});

test('an inactive user holding admin outranks one holding an ordinary role', () => {
  const estate = {
    sys_user_has_role: [
      { sys_id: 'x', user: 'u1', 'user.active': 'false', role: 'r1', 'role.name': 'admin' },
      { sys_id: 'y', user: 'u2', 'user.active': 'false', role: 'r2', 'role.name': 'itil' },
      { sys_id: 'z', user: 'u3', 'user.active': 'true', role: 'r3', 'role.name': 'admin' },
    ],
  };
  const findings = new EstateRules(estate, { sys_user_has_role: COMPLETE('sys_user_has_role', 3) }, 90, NOW).analyze();
  const sec = findings.filter((f) => f.rule_id === 'SEC-INACTIVE-ROLE');
  assert.equal(sec.length, 2, 'an active user was reported, or an inactive one was missed');
  assert.equal(sec.find((f) => f.target_ids[0] === 'x').severity, 'HIGH');
  assert.equal(sec.find((f) => f.target_ids[0] === 'y').severity, 'MEDIUM');
});

test('only an ACTIVE before-rule calling current.update() is flagged', () => {
  const estate = {
    sys_script: [
      { sys_id: 'a', name: 'A', active: 'true', when: 'before', script: 'current.update();' },
      { sys_id: 'b', name: 'B', active: 'false', when: 'before', script: 'current.update();' },
      { sys_id: 'c', name: 'C', active: 'true', when: 'after', script: 'current.update();' },
    ],
  };
  const findings = new EstateRules(estate, { sys_script: COMPLETE('sys_script', 3) }, 90, NOW).analyze();
  const hits = findings.filter((f) => f.rule_id === 'CUSTOM-BEFORE-UPDATE');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].target_ids, ['a']);
});

/* ── Timestamps ────────────────────────────────────────────────────────── */

test('a ServiceNow timestamp is read as UTC, not as local time', () => {
  /*
   * trap #21 — the platform stores UTC and renders session-local. Parsing with
   * the host zone shifts every staleness calculation by the offset, which on
   * this machine is 5.5 hours.
   */
  assert.equal(parseDate('2026-09-01 06:30:00').toISOString(), '2026-09-01T06:30:00.000Z');
  assert.equal(parseDate('2026-09-01T06:30:00Z').toISOString(), '2026-09-01T06:30:00.000Z');
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('not a date'), null);
});

test('staleness is measured against the cutoff, and the day count is in the title', () => {
  const estate = { cmdb_ci: [ci('a', { sys_updated_on: '2026-01-01 00:00:00' })] };
  const findings = new EstateRules(estate, { cmdb_ci: COMPLETE('cmdb_ci', 1) }, 90, NOW).analyze();
  const stale = findings.find((f) => f.rule_id === 'CMDB-STALE');
  assert.match(stale.title, /unchanged for 253 days/);
  assert.equal(stale.confidence, 0.8, 'a staleness signal was reported as certain');
});

/* ── Identity, evidence and impact ─────────────────────────────────────── */

test('a fingerprint is stable across runs and independent of record order', () => {
  // Findings are addressed by fingerprint across runs, so an unstable one would
  // make the same problem look new every time.
  const estate = (order) => ({ cmdb_ci: order.map((id) => ci(id, { serial_number: 'S1' })) });
  const cov = { cmdb_ci: COMPLETE('cmdb_ci', 2) };
  const a = new EstateRules(estate(['a', 'b']), cov, 90, NOW).analyze().find((f) => f.rule_id === 'CMDB-DUPLICATE');
  const b = new EstateRules(estate(['b', 'a']), cov, 90, NOW).analyze().find((f) => f.rule_id === 'CMDB-DUPLICATE');
  assert.equal(a.fingerprint, b.fingerprint);
});

test('every evidence row names the table, the sys_id and the field it was read from', () => {
  const estate = { cmdb_ci: [ci('a', { owned_by: '' })] };
  const findings = new EstateRules(estate, { cmdb_ci: COMPLETE('cmdb_ci', 1) }, 90, NOW).analyze();
  const owner = findings.find((f) => f.rule_id === 'CMDB-OWNER');
  assert.ok(owner.evidence.length > 0);
  for (const e of owner.evidence) {
    assert.equal(e.sn_table, 'cmdb_ci');
    assert.equal(e.sn_sys_id, 'a');
    assert.ok(e.field_name);
    assert.equal(e.source, 'ServiceNow Table REST API');
  }
});

test('reachability is labelled as topology, never as proven impact', () => {
  /*
   * The number is a graph statistic. Without this sentence travelling beside
   * it, "affects 14 CIs" reads as an outage prediction nobody verified.
   */
  const estate = {
    cmdb_ci: [ci('a', { owned_by: '' }), ci('b'), ci('c')],
    cmdb_rel_ci: [
      { sys_id: 'r1', parent: 'a', child: 'b', type: 't' },
      { sys_id: 'r2', parent: 'b', child: 'c', type: 't' },
    ],
  };
  const coverage = { cmdb_ci: COMPLETE('cmdb_ci', 3), cmdb_rel_ci: COMPLETE('cmdb_rel_ci', 2) };
  const owner = new EstateRules(estate, coverage, 90, NOW).analyze().find((f) => f.rule_id === 'CMDB-OWNER');
  assert.match(owner.impact.interpretation, /not proven outage propagation/);
  assert.equal(owner.impact.direction, 'undirected');
  assert.deepEqual(owner.affected_ci_ids, ['a', 'b', 'c']);
});

test('the graph walk stops at depth 3', () => {
  const chain = ['a', 'b', 'c', 'd', 'e', 'f'];
  const estate = {
    cmdb_ci: chain.map((id) => ci(id, id === 'a' ? { owned_by: '' } : {})),
    cmdb_rel_ci: chain.slice(0, -1).map((p, i) => ({ sys_id: `r${i}`, parent: p, child: chain[i + 1], type: 't' })),
  };
  const coverage = { cmdb_ci: COMPLETE('cmdb_ci', 6), cmdb_rel_ci: COMPLETE('cmdb_rel_ci', 5) };
  const owner = new EstateRules(estate, coverage, 90, NOW).analyze().find((f) => f.rule_id === 'CMDB-OWNER');
  assert.deepEqual(owner.affected_ci_ids, ['a', 'b', 'c', 'd'], 'the walk went past depth 3');
});

test('findings come back ordered by priority score, highest first', () => {
  const estate = {
    cmdb_ci: [ci('a', { owned_by: '', serial_number: 'S1' }), ci('b', { serial_number: 'S1' })],
  };
  const findings = new EstateRules(estate, { cmdb_ci: COMPLETE('cmdb_ci', 2) }, 90, NOW).analyze();
  for (let i = 1; i < findings.length; i++) {
    assert.ok(findings[i - 1].priority_score >= findings[i].priority_score, 'findings are not priority-ordered');
  }
});

test('every rule names a domain in the closed vocabulary', () => {
  const estate = {
    cmdb_ci: [ci('a', { owned_by: '' })],
    ecc_agent: [{ sys_id: 'm', name: 'MID', status: 'Down' }],
    em_alert: [{ sys_id: 'e', number: 'A1', cmdb_ci: '', state: 'Open' }],
  };
  const coverage = {
    cmdb_ci: COMPLETE('cmdb_ci', 1), ecc_agent: COMPLETE('ecc_agent', 1), em_alert: COMPLETE('em_alert', 1),
  };
  const domains = new Set(Object.values(AGENTS).map(([d]) => d));
  for (const f of new EstateRules(estate, coverage, 90, NOW).analyze()) {
    assert.ok(domains.has(f.domain), `${f.rule_id} produced an unknown domain ${f.domain}`);
    assert.ok(AGENTS[f.agent_id], `${f.rule_id} produced an unknown agent ${f.agent_id}`);
  }
});

/* ── The score ─────────────────────────────────────────────────────────── */

test('the quality score is WITHHELD unless both CMDB tables were read completely', () => {
  /*
   * A partial relationship read inflates CMDB-UNRELATED and drives the score
   * down for a reason about our access, not their data. A number that is
   * sometimes about the estate and sometimes about the reader is worse than no
   * number.
   */
  const estate = { cmdb_ci: [ci('a')], cmdb_rel_ci: [] };
  assert.equal(qualityScore(estate, { cmdb_ci: COMPLETE('cmdb_ci', 1), cmdb_rel_ci: LIMITED('cmdb_rel_ci', 0) }, []), null);
  assert.equal(qualityScore(estate, { cmdb_ci: LIMITED('cmdb_ci', 1), cmdb_rel_ci: COMPLETE('cmdb_rel_ci', 0) }, []), null);
  assert.equal(qualityScore({ cmdb_ci: [] }, { cmdb_ci: COMPLETE('cmdb_ci', 0), cmdb_rel_ci: COMPLETE('cmdb_rel_ci', 0) }, []), null);
});

test('the score counts distinct CIs with a CMDB finding, not findings', () => {
  const estate = { cmdb_ci: [ci('a'), ci('b'), ci('c'), ci('d')], cmdb_rel_ci: [] };
  const coverage = { cmdb_ci: COMPLETE('cmdb_ci', 4), cmdb_rel_ci: COMPLETE('cmdb_rel_ci', 0) };
  // Two findings, same CI: one quarter of the estate is affected, not one half.
  const findings = [
    { domain: 'CMDB', target_ids: ['a'] },
    { domain: 'CMDB', target_ids: ['a'] },
    { domain: 'SECURITY', target_ids: ['b'] },
  ];
  assert.equal(qualityScore(estate, coverage, findings), 75);
});

/* ── Clustering ────────────────────────────────────────────────────────── */

test('a cluster states that a shared rule is not a proven shared cause', () => {
  const clusters = clusterByRule([
    { rule_id: 'CMDB-OWNER', fingerprint: 'f1' },
    { rule_id: 'CMDB-OWNER', fingerprint: 'f2' },
    { rule_id: 'MID-DOWN', fingerprint: 'f3' },
  ]);
  assert.equal(clusters.length, 1, 'a single finding was clustered with itself');
  assert.equal(clusters[0].rule_id, 'CMDB-OWNER');
  assert.match(clusters[0].note, /has not been proven/);
});

/* ── The model may not introduce a finding ─────────────────────────────── */

test('a summary naming an id that was never sent is rejected WHOLE', () => {
  /*
   * A model that fabricated one id has shown it is not keying off the input, so
   * its other entries are not trustworthy either. Dropping only the bad entry
   * would render the rest beside real findings.
   */
  const known = new Map([['aaa', {}]]);
  const bad = JSON.stringify({ explanations: [{ id: 'aaa', explanation: 'fine' }, { id: 'zzz', explanation: 'invented' }] });
  const result = validateReply(bad, known);
  assert.equal(result.ok, false);
  assert.match(result.reason, /never sent/);
});

test('a valid summary is keyed back onto the findings that were sent', () => {
  const known = new Map([['aaa', {}], ['bbb', {}]]);
  const ok = validateReply(JSON.stringify({ explanations: [{ id: 'aaa', explanation: 'because' }] }), known);
  assert.equal(ok.ok, true);
  assert.equal(ok.explanations.get('aaa'), 'because');
});

test('a fenced reply is still read', () => {
  assert.equal(unfence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(unfence('{"a":1}'), '{"a":1}');
});

test('a model failure never removes a deterministic finding', () => {
  // The findings were read off the instance. The sentences were not. Losing the
  // second must not lose the first.
  return (async () => {
    const findings = [{ fingerprint: 'f1', rule_id: 'R', domain: 'CMDB', severity: 'HIGH', target_ids: ['a'] }];
    const llm = await explainFindings(findings, { generate: async () => { throw new Error('ollama is not running'); } });
    assert.equal(llm.status, 'unavailable');
    assert.match(llm.error, /retained/);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ai_summary, undefined);
  })();
});

test('an empty model reply is reported, not rendered as a summary', async () => {
  const llm = await explainFindings(
    [{ fingerprint: 'f1', rule_id: 'R', domain: 'CMDB', severity: 'HIGH', target_ids: ['a'] }],
    { generate: async () => '' },
  );
  assert.equal(llm.status, 'unavailable');
  assert.match(llm.error, /returned nothing/);
});

test('a good summary is attached and counted against what was considered', async () => {
  const findings = [{ fingerprint: 'f1', rule_id: 'R', domain: 'CMDB', severity: 'HIGH', target_ids: ['a'] }];
  const llm = await explainFindings(findings, {
    generate: async () => JSON.stringify({ explanations: [{ id: 'f1', explanation: 'The owner field is empty.' }] }),
  });
  assert.equal(llm.status, 'complete');
  assert.equal(llm.explained_findings, 1);
  assert.equal(findings[0].ai_summary, 'The owner field is empty.');
  assert.match(llm.label, /deterministic; these sentences are not/);
});

/* ── Extraction ────────────────────────────────────────────────────────── */

test('a transport failure is classified into a word the UI can act on', () => {
  // "You may not read this" and "this does not exist here" send a reader to
  // two different places. A PDI without ITOM has no ecc_agent at all.
  assert.equal(classifyFailure({ status: 403 }), 'forbidden');
  assert.equal(classifyFailure({ status: 404 }), 'unavailable');
  assert.equal(classifyFailure({ status: 401 }), 'unauthorized');
  assert.equal(classifyFailure({ status: 500 }), 'upstream_error');
  assert.equal(classifyFailure({ status: 429 }), 'rate_limited');
});

test('REGRESSION: a table that is not on the instance answers 400, not 404', () => {
  /*
   * Measured on dev424910: a PDI without Event Management returns
   * `400 Invalid table em_alert`. That was reported as `invalid_query` — which
   * reads as "Health Assist sent something malformed" and sends a reader to
   * debug a query that is fine.
   */
  assert.equal(
    classifyFailure({ status: 400, message: 'Invalid table em_alert' }),
    'unavailable',
    'a missing table is being reported as a bad query',
  );
  // A genuinely malformed query is still a malformed query.
  assert.equal(
    classifyFailure({ status: 400, message: 'Invalid sysparm_query' }),
    'invalid_query',
  );
});

test('a required table failing is fatal; an optional one is not', () => {
  assert.equal(isFatal('forbidden', TABLES.cmdb_ci), true);
  assert.equal(isFatal('forbidden', TABLES.ecc_agent), false);
  assert.equal(isFatal('unauthorized', TABLES.ecc_agent), true, 'bad credentials degraded instead of stopping');
});

test('a field the API silently dropped downgrades coverage to limited', async () => {
  // The row comes back without owned_by. sysparm_fields does that without an
  // error (trap #4), so the difference is what coverage reports.
  const client = {
    count: async () => 1,
    query: async () => [{ sys_id: 'a', sys_updated_on: '2026-09-01 00:00:00', name: 'x' }],
  };
  const { coverage } = await fetchTable('cmdb_ci', { cutoff: '2026-09-11 00:00:00', client });
  assert.equal(coverage.status, 'limited');
  assert.ok(coverage.missing_fields.includes('owned_by'));
});

test('reading fewer rows than the platform counts is limited, not complete', async () => {
  const rows = [{ sys_id: 'a', sys_updated_on: '2026-09-01 00:00:00' }];
  const client = {
    count: async () => 900,           // the platform says there are 900
    query: async () => rows,          // we could read one
  };
  const { coverage } = await fetchTable('cmdb_rel_ci', { cutoff: '2026-09-11 00:00:00', client });
  assert.equal(coverage.status, 'limited');
  assert.equal(coverage.reported_total, 900);
  assert.equal(coverage.records, 1);
});

test('an unknown total falls back to the short-page test rather than blocking', async () => {
  // Some tables answer 403 to the Aggregate API while serving the Table API.
  const client = {
    count: async () => { throw Object.assign(new Error('no'), { status: 403 }); },
    query: async (t, { offset }) => (offset === 0
      ? Array.from({ length: 500 }, (_, i) => ({ sys_id: `a${i}`, sys_updated_on: '2026-09-01 00:00:00', parent: 'p', child: 'c', type: 't', 'type.name': 'n' }))
      : []),
  };
  const { records, coverage } = await fetchTable('cmdb_rel_ci', { cutoff: '2026-09-11 00:00:00', client });
  assert.equal(records.length, 500);
  assert.equal(coverage.reported_total, null);
  assert.equal(coverage.status, 'complete');
});

test('a sys_id repeated across pages fails loudly instead of double-counting', async () => {
  const row = { sys_id: 'same', sys_updated_on: '2026-09-01 00:00:00', parent: 'p', child: 'c', type: 't', 'type.name': 'n' };
  const client = {
    count: async () => 1000,
    query: async () => Array.from({ length: 500 }, () => ({ ...row })),
  };
  await assert.rejects(
    fetchTable('cmdb_rel_ci', { cutoff: '2026-09-11 00:00:00', client }),
    /same sys_id appeared on two pages/,
  );
});

test('a row with no sys_id stops the table rather than becoming an unaddressable finding', async () => {
  const client = { count: async () => 1, query: async () => [{ name: 'nameless' }] };
  await assert.rejects(
    fetchTable('cmdb_ci', { cutoff: '2026-09-11 00:00:00', client }),
    /no sys_id/,
  );
});

test('the rule pack version is stated, so a finding can be traced to the rules that made it', () => {
  assert.match(RULE_VERSION, /^\d+\.\d+\.\d+$/);
});
