import test from 'node:test';
import assert from 'node:assert/strict';

import { EstateRules, AGENTS } from '../src/health/rules.js';
import { TABLES } from '../src/health/tables.js';
import { FIX_FIELD, buildProposal, CHANGE_STATUS } from '../src/health/proposal.js';
import { REMEDIATION } from '../src/health/remediation.js';

/*
 * Health Assist — the ITOM rule pack.
 *
 * ITOM leans on ABSENCE far harder than the CMDB rules do. "Discovery has never
 * run" and "there is no MID server" are the two most important things this
 * module can say about an ITOM estate, and both are claims about what was NOT
 * found — so both are only sound on complete coverage, and both are worthless
 * if they cannot be told apart from "we could not read the table".
 *
 * That distinction is what most of these tests are about.
 */

const NOW = new Date('2026-09-11T00:00:00Z');
const COMPLETE = (records = 0) => ({ status: 'complete', records, missing_fields: [] });
const LIMITED = () => ({ status: 'limited', records: 1, missing_fields: ['x'] });
const FORBIDDEN = () => ({ status: 'forbidden', records: null, error: 'no permission' });

const run = (estate, coverage) => {
  const r = new EstateRules(estate, coverage, 90, NOW);
  return { findings: r.analyze(), skipped: r.skipped };
};
const ruleIds = (findings) => findings.map((f) => f.rule_id);

/* ── The absence rules, and the line they must not cross ───────────────── */

test('an EMPTY discovery_status that was read completely means Discovery never ran', () => {
  const { findings } = run({ discovery_status: [] }, { discovery_status: COMPLETE(0) });
  const f = findings.find((x) => x.rule_id === 'DISC-NEVER-RAN');
  assert.ok(f, 'an empty Discovery table produced no finding');
  assert.equal(f.severity, 'HIGH');
  assert.equal(f.estate_wide, true);
});

test('a discovery_status we could NOT read produces a skip, never that finding', () => {
  /*
   * THE LINE. "We could not see Discovery" and "Discovery has never run" are
   * opposite conclusions that look identical in an empty table. Getting this
   * wrong would tell someone their Discovery is dead because their account
   * lacks a role.
   */
  for (const cov of [FORBIDDEN(), LIMITED(), undefined]) {
    const { findings, skipped } = run({ discovery_status: [] }, { discovery_status: cov });
    assert.equal(findings.filter((x) => x.rule_id === 'DISC-NEVER-RAN').length, 0,
      `coverage ${cov?.status} produced a never-ran finding`);
    assert.ok(skipped.some((s) => s.rule === 'DISC-NEVER-RAN'), 'the skip was not recorded');
  }
});

test('the same holds for MID servers and for credentials', () => {
  const empty = run(
    { ecc_agent: [], discovery_credentials: [] },
    { ecc_agent: COMPLETE(0), discovery_credentials: COMPLETE(0) },
  );
  assert.ok(ruleIds(empty.findings).includes('MID-NONE'));
  assert.ok(ruleIds(empty.findings).includes('CRED-NONE'));

  const unreadable = run(
    { ecc_agent: [], discovery_credentials: [] },
    { ecc_agent: FORBIDDEN(), discovery_credentials: FORBIDDEN() },
  );
  assert.equal(ruleIds(unreadable.findings).includes('MID-NONE'), false);
  assert.equal(ruleIds(unreadable.findings).includes('CRED-NONE'), false);
});

test('an estate-wide finding outranks a single-record one', () => {
  /*
   * REGRESSION. The priority formula multiplies severity by a business proxy
   * derived from affected services. An estate-wide finding names no records,
   * so it scored 4 — beneath a single CI with a blank owner. "There is no MID
   * server" is upstream of every other ITOM finding, not smaller than all of
   * them.
   */
  const { findings } = run({ ecc_agent: [] }, { ecc_agent: COMPLETE(0) });
  const mid = findings.find((f) => f.rule_id === 'MID-NONE');
  assert.equal(mid.priority, 'P1');
  assert.ok(mid.priority_score >= 20, `estate-wide scored ${mid.priority_score}`);
  assert.equal(mid.impact.direction, 'estate');
  assert.match(mid.impact.interpretation, /records are what is missing/);
});

test('when Discovery has never run, the downstream Discovery rules do not also fire', () => {
  // Six skip lines all saying "there are no runs" is noise, not detail.
  const { findings } = run({ discovery_status: [] }, { discovery_status: COMPLETE(0) });
  const disc = ruleIds(findings).filter((r) => r.startsWith('DISC-'));
  assert.deepEqual(disc, ['DISC-NEVER-RAN']);
});

/* ── Discovery ─────────────────────────────────────────────────────────── */

test('a failed Discovery run is reported; a completed one is not', () => {
  const estate = {
    discovery_status: [
      { sys_id: 'a', state: 'Error', scan_type: 'Networks', completed: '2026-09-10 00:00:00' },
      { sys_id: 'b', state: 'Completed', scan_type: 'Networks', completed: '2026-09-10 00:00:00' },
      { sys_id: 'c', state: 'Cancelled', scan_type: 'IPs', completed: '2026-09-10 00:00:00' },
    ],
  };
  const { findings } = run(estate, { discovery_status: COMPLETE(3) });
  const failed = findings.filter((f) => f.rule_id === 'DISC-FAILED');
  assert.equal(failed.length, 2);
  assert.equal(failed[0].severity, 'HIGH');
  assert.deepEqual(failed.map((f) => f.target_ids[0]).sort(), ['a', 'c']);
});

test('a stale schedule is measured against the same window the CMDB rules use', () => {
  const estate = {
    discovery_status: [
      { sys_id: 'old', state: 'Completed', completed: '2026-01-01 00:00:00', scan_type: 'Networks' },
      { sys_id: 'new', state: 'Completed', completed: '2026-09-10 00:00:00', scan_type: 'Networks' },
    ],
  };
  const { findings } = run(estate, { discovery_status: COMPLETE(2) });
  const stale = findings.filter((f) => f.rule_id === 'DISC-STALE');
  assert.equal(stale.length, 1);
  assert.deepEqual(stale[0].target_ids, ['old']);
  assert.ok(stale[0].confidence < 1, 'a staleness signal was reported as certain');
});

test('device issues use the platform’s own count, and zero is not a finding', () => {
  const estate = {
    discovery_device_history: [
      { sys_id: 'd1', issues: '3', source: '10.0.0.1', state: 'Complete' },
      { sys_id: 'd2', issues: '0', source: '10.0.0.2', state: 'Complete' },
      { sys_id: 'd3', issues: '', source: '10.0.0.3', state: 'Complete' },
    ],
  };
  const { findings } = run(estate, { discovery_device_history: COMPLETE(3) });
  const hits = findings.filter((f) => f.rule_id === 'DISC-DEVICE-ISSUE');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].target_ids, ['d1']);
  assert.match(hits[0].title, /3 issue/);
});

/* ── Credentials ───────────────────────────────────────────────────────── */

test('an inactive credential is reported, and ALL inactive is a separate, worse finding', () => {
  const allOff = {
    discovery_credentials: [
      { sys_id: 'c1', name: 'win', active: 'false', type: 'windows' },
      { sys_id: 'c2', name: 'ssh', active: 'false', type: 'ssh' },
    ],
  };
  const { findings } = run(allOff, { discovery_credentials: COMPLETE(2) });
  assert.equal(findings.filter((f) => f.rule_id === 'CRED-INACTIVE').length, 2);
  const all = findings.find((f) => f.rule_id === 'CRED-ALL-INACTIVE');
  assert.ok(all, 'every-credential-off was not called out separately');
  assert.equal(all.severity, 'HIGH');

  // One active credential means the estate-level finding must NOT fire.
  const some = run({
    discovery_credentials: [
      { sys_id: 'c1', name: 'win', active: 'true', type: 'windows' },
      { sys_id: 'c2', name: 'ssh', active: 'false', type: 'ssh' },
    ],
  }, { discovery_credentials: COMPLETE(2) });
  assert.equal(ruleIds(some.findings).includes('CRED-ALL-INACTIVE'), false);
  assert.equal(some.findings.filter((f) => f.rule_id === 'CRED-INACTIVE').length, 1);
});

test('CRED-ALL-INACTIVE needs complete coverage — a partial read cannot prove "all"', () => {
  const { findings } = run({
    discovery_credentials: [{ sys_id: 'c1', name: 'win', active: 'false' }],
  }, { discovery_credentials: LIMITED() });
  assert.equal(ruleIds(findings).includes('CRED-ALL-INACTIVE'), false,
    '"every credential is off" was claimed from a partial read');
});

/* ── MID servers ───────────────────────────────────────────────────────── */

test('up-but-not-validated is reported; a Down MID is left to the MID-DOWN rule', () => {
  const estate = {
    ecc_agent: [
      { sys_id: 'm1', name: 'mid-a', status: 'Up', validated: 'false' },
      { sys_id: 'm2', name: 'mid-b', status: 'Up', validated: 'true' },
      { sys_id: 'm3', name: 'mid-c', status: 'Down', validated: 'false' },
    ],
  };
  const { findings } = run(estate, { ecc_agent: COMPLETE(3) });
  const nv = findings.filter((f) => f.rule_id === 'MID-NOT-VALIDATED');
  assert.deepEqual(nv.map((f) => f.target_ids[0]), ['m1'], 'a Down MID was double-reported');
  assert.ok(ruleIds(findings).includes('MID-DOWN'));
});

test('a MID with no capabilities is found, and only on complete capability coverage', () => {
  const estate = {
    ecc_agent: [
      { sys_id: 'm1', name: 'mid-a', status: 'Up', validated: 'true' },
      { sys_id: 'm2', name: 'mid-b', status: 'Up', validated: 'true' },
    ],
    ecc_agent_capability: [{ sys_id: 'k1', agent: 'm1', capability: 'ALL' }],
  };
  const complete = run(estate, { ecc_agent: COMPLETE(2), ecc_agent_capability: COMPLETE(1) });
  const gap = complete.findings.filter((f) => f.rule_id === 'MID-NO-CAPABILITY');
  assert.deepEqual(gap.map((f) => f.target_ids[0]), ['m2']);

  const partial = run(estate, { ecc_agent: COMPLETE(2), ecc_agent_capability: LIMITED() });
  assert.equal(ruleIds(partial.findings).includes('MID-NO-CAPABILITY'), false);
  assert.ok(partial.skipped.some((s) => s.rule === 'MID-NO-CAPABILITY'));
});

test('an open MID issue is reported and a resolved one is not', () => {
  const estate = {
    ecc_agent_issue: [
      { sys_id: 'i1', agent: 'm1', issue: 'Out of memory', state: 'Open', severity: '1' },
      { sys_id: 'i2', agent: 'm1', issue: 'Old', state: 'Resolved', severity: '2' },
    ],
  };
  const { findings } = run(estate, { ecc_agent_issue: COMPLETE(2) });
  const open = findings.filter((f) => f.rule_id === 'MID-ISSUE');
  assert.deepEqual(open.map((f) => f.target_ids[0]), ['i1']);
});

/* ── Service mapping ───────────────────────────────────────────────────── */

test('unmapped services are found only when some mapping exists; none at all is its own finding', () => {
  const services = [
    { sys_id: 's1', name: 'Payments' },
    { sys_id: 's2', name: 'Email' },
  ];
  const partialMap = run(
    { cmdb_ci_service_discovered: services, svc_ci_assoc: [{ sys_id: 'l1', service: 's1', ci: 'c1' }] },
    { cmdb_ci_service_discovered: COMPLETE(2), svc_ci_assoc: COMPLETE(1) },
  );
  const unmapped = partialMap.findings.filter((f) => f.rule_id === 'SM-UNMAPPED');
  assert.deepEqual(unmapped.map((f) => f.target_ids[0]), ['s2']);
  assert.equal(ruleIds(partialMap.findings).includes('SM-NOT-IN-USE'), false);

  const noMap = run(
    { cmdb_ci_service_discovered: services, svc_ci_assoc: [] },
    { cmdb_ci_service_discovered: COMPLETE(2), svc_ci_assoc: COMPLETE(0) },
  );
  assert.ok(ruleIds(noMap.findings).includes('SM-NOT-IN-USE'));
  assert.equal(noMap.findings.filter((f) => f.rule_id === 'SM-UNMAPPED').length, 0,
    'every service was also reported individually, duplicating the estate finding');
});

test('no discovered services means no service-mapping claim at all', () => {
  // An instance that does not use discovered services is not badly mapped.
  const { findings, skipped } = run(
    { cmdb_ci_service_discovered: [], svc_ci_assoc: [] },
    { cmdb_ci_service_discovered: COMPLETE(0), svc_ci_assoc: COMPLETE(0) },
  );
  assert.equal(ruleIds(findings).some((r) => r.startsWith('SM-')), false);
  assert.ok(skipped.some((s) => s.rule === 'SM-UNMAPPED'));
});

/* ── Availability ──────────────────────────────────────────────────────── */

test('an outage open over a day is reported; a young one and a closed one are not', () => {
  const estate = {
    cmdb_ci_outage: [
      { sys_id: 'o1', cmdb_ci: 'c1', begin: '2026-09-01 00:00:00', end: '', type: 'outage' },
      { sys_id: 'o2', cmdb_ci: 'c2', begin: '2026-09-10 20:00:00', end: '', type: 'outage' },
      { sys_id: 'o3', cmdb_ci: 'c3', begin: '2026-09-01 00:00:00', end: '2026-09-02 00:00:00', type: 'outage' },
    ],
  };
  const { findings } = run(estate, { cmdb_ci_outage: COMPLETE(3) });
  const open = findings.filter((f) => f.rule_id === 'OUTAGE-OPEN');
  assert.deepEqual(open.map((f) => f.target_ids[0]), ['o1']);
  assert.match(open[0].description, /cannot tell which/);
});

/* ── The pack stays coherent ───────────────────────────────────────────── */

test('every ITOM table in the allow-list carries sys_id and sys_updated_on', () => {
  for (const t of ['discovery_status', 'discovery_device_history', 'discovery_log',
    'discovery_credentials', 'ecc_agent_capability', 'ecc_agent_issue',
    'svc_ci_assoc', 'cmdb_ci_service_discovered', 'cmdb_ci_outage', 'sysauto']) {
    assert.ok(TABLES[t], `${t} is not in the allow-list`);
    assert.ok(TABLES[t].fields.includes('sys_id'));
    assert.ok(TABLES[t].fields.includes('sys_updated_on'));
  }
});

test('every ITOM domain is in the closed vocabulary and has a label', () => {
  for (const agent of ['discovery_agent', 'credential_agent', 'service_mapping_agent', 'availability_agent']) {
    assert.ok(AGENTS[agent], `${agent} is not a known domain`);
    assert.equal(AGENTS[agent].length, 2);
  }
});

test('only ITOM rules with a REAL single-field fix appear in FIX_FIELD', () => {
  /*
   * Most ITOM remediation is operational — restarting a MID service, opening a
   * port, running a schedule — and a REST write cannot do any of it. Offering a
   * Fix button there would be offering something that cannot work.
   */
  for (const manualOnly of ['MID-NONE', 'MID-NOT-VALIDATED', 'MID-ISSUE', 'MID-NO-CAPABILITY',
    'DISC-NEVER-RAN', 'DISC-FAILED', 'DISC-STALE', 'DISC-DEVICE-ISSUE', 'DISC-LOG-ERROR',
    'CRED-NONE', 'SM-NOT-IN-USE', 'SM-UNMAPPED']) {
    assert.equal(FIX_FIELD[manualOnly], undefined,
      `${manualOnly} offers a field fix for something a REST write cannot do`);
    assert.ok(REMEDIATION[manualOnly], `${manualOnly} has no manual steps either`);
  }
  // And the ones that genuinely are a field write do appear.
  assert.equal(FIX_FIELD['CRED-INACTIVE'].field, 'active');
  assert.equal(FIX_FIELD['OUTAGE-OPEN'].field, 'end');
});

test('a preset fills the value without consulting a model at all', async () => {
  /*
   * "This credential is switched off" has exactly one sensible fix. A language
   * round-trip to discover it would add a failure mode and no information.
   */
  let asked = false;
  const p = await buildProposal({
    fingerprint: 'f', rule_id: 'CRED-INACTIVE', table: 'discovery_credentials',
    severity: 'MEDIUM', title: 'Credential is inactive: win', description: 'off',
    target_ids: ['c1'], evidence: [],
  }, {
    readRecord: async () => ({ sys_id: { value: 'c1' }, name: { value: 'win' }, active: { value: 'false' } }),
    generate: async () => { asked = true; return '{}'; },
  });
  assert.equal(asked, false, 'the model was consulted for a value the rule already states');
  assert.equal(p.llm.status, 'preset');
  assert.equal(p.changes[0].proposedValue, 'true');
  assert.equal(p.changes[0].status, CHANGE_STATUS.READY);
  assert.equal(p.changes[0].confidence, 1);
});

test('a rule with no field fix proposes nothing to apply and says why', async () => {
  const p = await buildProposal({
    fingerprint: 'f', rule_id: 'MID-NONE', table: 'ecc_agent',
    severity: 'HIGH', title: 'No MID server is configured', description: 'none',
    target_ids: [], evidence: [],
  }, { readRecord: async () => null, generate: async () => '{}' });
  assert.equal(p.llm.status, 'no_field_fix');
  assert.equal(p.changes.length, 0);
  assert.match(p.summary, /no single-field fix/i);
  assert.ok(p.manualSteps.length >= 3, 'there are no manual steps to fall back on');
});
