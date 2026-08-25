import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * B2 — the deterministic eligibility gate.
 *
 * Every DENY here answers a measured platform behaviour, not a hypothetical:
 * `canImpersonate()` said `true` for an inactive user and for a GUID matching
 * zero rows, and `impersonate()` on that GUID silently became `guest`. The gate
 * is the only thing that says no.
 *
 * Offline: `table.query` is stubbed with rows shaped like dev442675's, the same
 * technique lookup-rank.test.js uses, so the gate is asserted without an
 * instance and without a PDI flag.
 */

/* Query-resolved on dev442675 during Phase 0 / the B1 gate. */
const ADMIN = '6816f79cc0a8016401c5a33be04be441';
const ROLE_LESS = '555a640583fe0f10b939cc65eeaad3a2';
const INACTIVE = '443193dcd7011200f2d224837e61037d';
const OTHER_ADMIN = '353cce0653e7321040e22e1e90f7b435';
const GUEST = '5136503cc611227c0183e96598c4f706';
const NO_USERNAME = 'aaaa0000bbbb1111cccc2222dddd3333';
const GHOST = 'deadbeefcafe0000cafe0000cafe0000';
const ADMIN_ROLE = '2831a114c611228501d4ea6c309d626d';

const USERS = [
  { sys_id: ADMIN, user_name: 'admin', name: 'System Administrator', active: 'true' },
  { sys_id: ROLE_LESS, user_name: 'aagamya.tanwar', name: 'Aagamya Tanwar', active: 'true' },
  { sys_id: INACTIVE, user_name: 'aqib.mushtaq', name: 'Aqib Mushtaq', active: 'false' },
  { sys_id: OTHER_ADMIN, user_name: 'prism-service-user', name: 'Prism Service User', active: 'true' },
  { sys_id: GUEST, user_name: 'guest', name: 'Guest', active: 'true' },
  { sys_id: NO_USERNAME, user_name: '', name: 'Nameless Record', active: 'true' },
  // The WI-4 shadowing set: these must never outrank an exact user_name hit.
  { sys_id: 'dd9b3742c37030009b5efcfc5bba8fb6', user_name: 'certification_admin', name: 'Certification Admin', active: 'true' },
  { sys_id: '8ff5b254b33213005e3de13516a8dcf7', user_name: 'cmdb_admin', name: 'CMDB Admin', active: 'true' },
];
const ROLES = [{ sys_id: ADMIN_ROLE, name: 'admin' }];
const GRANTS = [
  { sys_id: 'g1', user: ADMIN, role: ADMIN_ROLE, inherited: 'false' },
  { sys_id: 'g2', user: OTHER_ADMIN, role: ADMIN_ROLE, inherited: 'true' },
];

/** The subset of encoded-query syntax these callers actually emit. */
function runQuery(rows, query) {
  const clause = String(query || '').split('^ORDERBY')[0];
  if (!clause) return rows;
  const eq = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  let out = rows;
  for (const part of clause.split('^')) {
    if (!part) continue;
    let m;
    if ((m = /^(\w+)STARTSWITH(.+)$/.exec(part))) {
      out = out.filter((r) => String(r[m[1]] ?? '').toLowerCase().startsWith(m[2].toLowerCase()));
    } else if ((m = /^(\w+)LIKE(.+)$/.exec(part))) {
      out = out.filter((r) => String(r[m[1]] ?? '').toLowerCase().includes(m[2].toLowerCase()));
    } else if ((m = /^(\w+)=(.*)$/.exec(part))) {
      out = out.filter((r) => eq(r[m[1]], m[2]));
    }
  }
  return out;
}

const clientMod = await import('../src/servicenow/client.js');
const schemaMod = await import('../src/servicenow/schema.js');

const DATA = { sys_user: USERS, sys_user_role: ROLES, sys_user_has_role: GRANTS };
let calls = [];

clientMod.table.query = async (t, { query, limit = 15 } = {}) => {
  calls.push({ table: t, query });
  if (t === 'sys_dictionary') return [{ element: 'name', name: 'sys_user' }];
  if (t === 'sys_db_object') return [];
  const rows = DATA[t];
  if (!rows) return [];
  return runQuery(rows, query).slice(0, limit);
};
schemaMod.clearSchemaCaches();

const {
  VERDICT, DENY_REASON, SOFT_DENY_REASON, DISCOVERY,
  discoverImpersonationTarget, evaluateEligibility, resolveAndEvaluate,
} = await import('../src/servicenow/impersonation-target.js');

// The integration account is injected rather than read from a gitignored
// settings file, so the gate is asserted the same way on any machine.
const gate = (sysId) => evaluateEligibility({ sysId, adminSysId: ADMIN, integrationUser: 'admin' });

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

test('an active, role-less user with a user_name is allowed', async () => {
  const r = await gate(ROLE_LESS);
  assert.equal(r.verdict, VERDICT.ALLOW);
  assert.equal(r.allowed, true);
  assert.equal(r.target.user_name, 'aagamya.tanwar');
  assert.deepEqual(r.checks.map((c) => c.pass), [true, true, true, true, true, true]);
});

test('a sys_id matching no row is denied — this is the guest-substitution guard', async () => {
  const r = await gate(GHOST);
  assert.equal(r.verdict, VERDICT.DENY);
  assert.equal(r.reason, DENY_REASON.USER_NOT_FOUND);
  // The reason must say WHY it matters, or the next reader relaxes it.
  assert.match(r.detail, /silently\s+switch the session to guest/);
  assert.equal(r.checks[0].check, 'exists');
  assert.equal(r.checks[0].pass, false);
});

test('existence is checked FIRST, before anything else can mask it', async () => {
  const r = await gate(GHOST);
  assert.equal(r.checks.length, 1, 'no further check may run once existence fails');
});

test('an inactive user is denied — canImpersonate() said true for this exact user', async () => {
  const r = await gate(INACTIVE);
  assert.equal(r.verdict, VERDICT.DENY);
  assert.equal(r.reason, DENY_REASON.USER_INACTIVE);
  assert.equal(r.target.user_name, 'aqib.mushtaq');
});

test('a user with no user_name is denied', async () => {
  const r = await gate(NO_USERNAME);
  assert.equal(r.verdict, VERDICT.DENY);
  assert.equal(r.reason, DENY_REASON.USER_HAS_NO_USER_NAME);
});

test('the executor cannot impersonate itself', async () => {
  const r = await evaluateEligibility({ sysId: ADMIN, adminSysId: ADMIN, integrationUser: 'admin' });
  // admin is also the integration account and holds admin; self must win, being the harder rule.
  assert.equal(r.verdict, VERDICT.DENY);
  assert.equal(r.reason, DENY_REASON.CANNOT_IMPERSONATE_EXECUTOR);
});

test('the integration account is denied even when it is not the executor', async () => {
  // Executor is some other admin; the configured API user is still off limits.
  const r = await evaluateEligibility({ sysId: ADMIN, adminSysId: OTHER_ADMIN, integrationUser: 'admin' });
  assert.equal(r.verdict, VERDICT.DENY);
  assert.equal(r.reason, DENY_REASON.CANNOT_IMPERSONATE_INTEGRATION_ACCOUNT);
});

test('an admin target is a SOFT deny that elevated approval can lift, not a block', async () => {
  const r = await gate(OTHER_ADMIN);
  assert.equal(r.verdict, VERDICT.SOFT_DENY);
  assert.equal(r.allowed, false);
  assert.equal(r.requiresElevatedApproval, true);
  assert.equal(r.reason, SOFT_DENY_REASON.TARGET_HOLDS_ADMIN);
  assert.equal(r.admin_role_sys_id, ADMIN_ROLE);
});

test('an INHERITED admin grant counts — a group can confer it', async () => {
  const r = await gate(OTHER_ADMIN);
  assert.match(r.detail, /inherited/);
});

test('guest is a legitimate deliberate target and is allowed', async () => {
  // The existence check stops a BAD sys_id becoming guest silently; asking for
  // guest on purpose is a real use case (minimal-access views) and stays open.
  const r = await gate(GUEST);
  assert.equal(r.verdict, VERDICT.ALLOW);
  assert.equal(r.target.user_name, 'guest');
});

test('canImpersonate is never called, and the role check names the role it resolved', async () => {
  calls = [];
  await gate(ROLE_LESS);
  const tables = calls.map((c) => c.table);
  assert.ok(tables.includes('sys_user'), 'must verify existence live');
  assert.ok(tables.includes('sys_user_role'), 'must resolve the admin role by name, not by a literal sys_id');
  assert.ok(tables.includes('sys_user_has_role'));
});

test('a malformed sys_id is refused before any query is issued', async () => {
  calls = [];
  await assert.rejects(() => gate('admin'), /32-character hex sys_id/);
  assert.equal(calls.length, 0, 'nothing may be queried for a value that is not a sys_id');
});

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

test('discovery resolves an exact user_name over a display-name contains match (WI-4)', async () => {
  const r = await discoverImpersonationTarget('admin');
  assert.equal(r.status, DISCOVERY.RESOLVED);
  assert.equal(r.resolved.sys_id, ADMIN, 'Certification Admin must not win a search for "admin"');
  assert.equal(r.resolved.matchType, 'exact');
});

test('a multi-match returns a list and never auto-picks', async () => {
  // "adm" contains-matches several display names and exactly matches no
  // user_name — the shape where a lookup could silently pick a stranger.
  const r = await discoverImpersonationTarget('adm');
  assert.equal(r.status, DISCOVERY.AMBIGUOUS);
  assert.equal(r.resolved, null, 'impersonation must never resolve a name to a record by guessing');
  assert.ok(r.candidates.length > 1);
  assert.match(r.message, /produces no error/);
});

test('an unmatched term is not_found, not an empty resolution', async () => {
  const r = await discoverImpersonationTarget('nobody-by-this-name');
  assert.equal(r.status, DISCOVERY.NOT_FOUND);
  assert.equal(r.resolved, null);
});

test('an empty term resolves nothing rather than browsing to a first row', async () => {
  const r = await discoverImpersonationTarget('   ');
  assert.equal(r.status, DISCOVERY.NOT_FOUND);
  assert.equal(r.candidates.length, 0);
});

test('resolveAndEvaluate stops at an ambiguous discovery and never gates a guess', async () => {
  const r = await resolveAndEvaluate({ term: 'adm', adminSysId: ADMIN, integrationUser: 'admin' });
  assert.equal(r.discovery.status, DISCOVERY.AMBIGUOUS);
  assert.equal(r.eligibility, null, 'no gate verdict may be produced for an unresolved target');
});

test('resolveAndEvaluate runs the gate on a clean resolution', async () => {
  const r = await resolveAndEvaluate({ term: 'aagamya.tanwar', adminSysId: ADMIN, integrationUser: 'admin' });
  assert.equal(r.discovery.status, DISCOVERY.RESOLVED);
  assert.equal(r.eligibility.verdict, VERDICT.ALLOW);
});
