import test from 'node:test';
import assert from 'node:assert/strict';

import { validateScriptSyntax, wrapWithSentinel, mintSentinel } from '../src/servicenow/script-liveness.js';
import {
  ELEVATION_MARKER,
  assertRoleName,
  rolesExactSource,
  buildElevationBody,
  assessElevation,
} from '../src/servicenow/role-elevation.js';
import {
  precedenceTiers,
  resolveRequiredRoles,
  assessEligibility,
  buildElevatableRolesSource,
  buildEffectiveRolesSource,
  buildRequiredRoleSource,
} from '../src/servicenow/role-model.js';
import {
  CONDITION_OPERATORS,
  composeAclCondition,
  buildAclPayload,
  buildAclAuthorSource,
  buildUpdateSetScopedSource,
  buildUpdateSetTeardownSource,
  validateAclCondition,
  verifyAclLive,
  describeEffect,
} from '../src/servicenow/acl-authoring.js';

/**
 * Phases 1, 2 and 4 — everything provable without an instance.
 *
 * The live EXECUTED proofs (the 0.3 transition, the 4.2 control failing, the
 * 4.3 elevated author persisting) are reported in the ledger. What this file
 * guards is that the generated scripts can never silently regress into the
 * shapes Phase 0 measured as dangerous — above all the substring role check,
 * which produced a false "elevation survived" reading during Phase 0 itself.
 */

/* Query-resolved during Phase 0; used here only as well-formed fixtures. */
const USER = '6816f79cc0a8016401c5a33be04be441';
const ACL_ID = '4bcb3dbb83320790b939cc65eeaad360';
const ROLE_ID = 'b2d8f7130a0a0baa5bf52498ecaadeb4';

const OP = "  out.probe = { ran: true };";

/** Every generated body must survive the pre-dispatch nets it will be sent through. */
function assertDispatchable(body, label) {
  const wrapped = wrapWithSentinel({ body, sentinel: mintSentinel(), marker: ELEVATION_MARKER });
  const v = validateScriptSyntax(wrapped);
  assert.equal(v.ok, true, `${label} must validate: ${JSON.stringify(v.errors)}`);
}

/* ------------------------------------------------------------------ *
 * Phase 2 — the elevation lifecycle
 * ------------------------------------------------------------------ */

test('role names are validated, including scoped ones, and refused otherwise', () => {
  assert.equal(assertRoleName('security_admin'), 'security_admin');
  assert.equal(assertRoleName('sn_sow.sow_user'), 'sn_sow.sow_user');
  for (const bad of ['', null, 'two words', 'a.b.c', "x'; drop", 'role-with-dash']) {
    assert.throws(() => assertRoleName(bad), /must be a role name/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('THE trap: no generated elevation body may substring-search getRoles()', () => {
  /*
   * Phase 0 D-3. `agent_security_admin` and `ais_high_security_admin` both
   * contain `security_admin`, so indexOf reports the role present before any
   * elevation. This is the single check most worth having in this file.
   */
  const body = buildElevationBody({ role: 'security_admin', opSource: OP });
  assert.ok(!body.includes('.indexOf('), 'the elevation body must not use indexOf on the role list');
  assert.match(body, /parts\[ri\] === roleName/, 'membership must be an exact comparison');
});

test('the exact-match helper compares whole entries, and the real role set proves why', () => {
  const src = rolesExactSource('__t');
  assert.ok(!src.includes('indexOf'));

  // The comparison, extracted and run against the ACTUAL admin role set shape
  // measured on dev442675 — the two decoys are real entries from that list.
  const listed = '[attachment_admin, agent_security_admin, ais_high_security_admin, cmdb_read]';
  const exact = (roleName) => listed.replace(/^\[/, '').replace(/\]$/, '').split(', ').some((p) => p === roleName);
  assert.equal(exact('security_admin'), false, 'exact match must not be fooled by the decoys');
  assert.equal(listed.indexOf('security_admin') >= 0, true, 'and substring search IS fooled — the reason for all this');
  assert.equal(exact('agent_security_admin'), true);
});

test('the elevated body asserts hasRole rather than trusting either return value', () => {
  const body = buildElevationBody({ role: 'security_admin', opSource: OP });
  assert.match(body, /out\.elevation\.during\.has_role !== true.*throw/s, 'a failed elevation must not run the op');
  // The returns are discarded on purpose: undefined and "true" respectively.
  assert.ok(!/=\s*GlideSecurityManager\.get\(\)\.enableElevatedRole/.test(body));
  assert.ok(!/=\s*GlideSecurityManager\.get\(\)\.disableElevatedRole/.test(body));
});

test('de-elevation is in a finally, so an op that throws cannot leave the role standing', () => {
  const body = buildElevationBody({ role: 'security_admin', opSource: OP });
  const disableAt = body.indexOf('disableElevatedRole');
  const finallyAt = body.indexOf('} finally {');
  assert.ok(finallyAt > 0 && disableAt > finallyAt, 'the disable must sit inside the finally block');
  assert.match(body, /deelevated_ok = \(out\.elevation\.after\.has_role === false\)/);
});

test('the control path runs the same op with no elevation calls at all', () => {
  const body = buildElevationBody({ role: 'security_admin', opSource: OP, requireElevation: false });
  assert.ok(!body.includes('enableElevatedRole'), 'the control must not elevate');
  assert.ok(!body.includes('disableElevatedRole'), 'the control must not de-elevate');
  assert.ok(body.includes(OP), 'and must run the identical op source');
  assert.match(body, /requested: false/);
});

test('an elevation body without an op is refused — it would prove nothing', () => {
  assert.throws(() => buildElevationBody({ role: 'security_admin', opSource: '' }), /performs no operation/);
  assert.throws(() => buildElevationBody({ role: 'security_admin' }), /performs no operation/);
});

test('every generated elevation body is dispatchable through both pre-dispatch nets', () => {
  assertDispatchable(buildElevationBody({ role: 'security_admin', opSource: OP }), 'elevated body');
  assertDispatchable(buildElevationBody({ role: 'security_admin', opSource: OP, requireElevation: false }), 'control body');
});

test('assessElevation names which transition failed rather than returning a bare false', () => {
  const ok = { elevation: { role: 'security_admin', requested: true, before: { has_role: false }, during: { has_role: true }, deelevated_ok: true } };
  assert.deepEqual(assessElevation(ok), { held: true, reason: null });

  const dirty = { elevation: { role: 'r', requested: true, before: { has_role: true }, during: { has_role: true }, deelevated_ok: true } };
  assert.match(assessElevation(dirty).reason, /baseline was not clean/);

  const notTaken = { elevation: { role: 'r', requested: true, before: { has_role: false }, during: { has_role: false }, deelevated_ok: true } };
  assert.match(assessElevation(notTaken).reason, /did not take/);

  const stuck = { elevation: { role: 'r', requested: true, before: { has_role: false }, during: { has_role: true }, deelevated_ok: false, after: { has_role: true } } };
  assert.match(assessElevation(stuck).reason, /de-elevation did not take/);

  const control = { elevation: { requested: false } };
  assert.equal(assessElevation(control).control, true);
  assert.equal(assessElevation(null).held, false);
});

/* ------------------------------------------------------------------ *
 * Phase 1 — the role model
 * ------------------------------------------------------------------ */

test('no module in the role path names a role literally', async () => {
  // The Phase 5 baseline is clean; this is the test that keeps it that way.
  const { readFile } = await import('node:fs/promises');
  for (const f of ['role-model.js', 'role-elevation.js', 'acl-authoring.js']) {
    const src = await readFile(new URL(`../src/servicenow/${f}`, import.meta.url), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join('\n');
    assert.ok(!/['"]security_admin['"]/.test(code), `${f} must not hardcode a role name in code`);
  }
});

test('precedence walks field, then wildcard, then record — with table.None beside table.*', () => {
  assert.deepEqual(precedenceTiers('incident', 'state'), [
    { tier: 'field', names: ['incident.state'] },
    { tier: 'wildcard', names: ['incident.*', 'incident.None'] },
    { tier: 'record', names: ['incident'] },
  ]);
  assert.deepEqual(precedenceTiers('incident').map((t) => t.tier), ['wildcard', 'record']);
  assert.throws(() => precedenceTiers('not a table'), /must match/);
});

test('required-role derivation is fail-closed and never guesses a role', () => {
  const none = resolveRequiredRoles({ operation: 'create', tiers: [{ tier: 'record', names: ['x'], matched: 0, acls: [] }] });
  assert.equal(none.resolved, false);
  assert.equal(none.reason, 'no_acl_matched');
  assert.deepEqual(none.roles, []);
  // The temptation Phase 0 D-1 makes concrete:
  assert.ok(!JSON.stringify(none).includes('security_admin'), 'an unresolved derivation must not fall back to a guess');
});

test('an ACL that requires no role is distinguished from one nobody could read', () => {
  const roleless = resolveRequiredRoles({
    operation: 'read',
    tiers: [{ tier: 'record', names: ['x'], matched: 1, acls: [{ sys_id: ACL_ID, name: 'x', roles: [] }] }],
  });
  assert.equal(roleless.resolved, false);
  assert.equal(roleless.reason, 'acl_matched_but_no_role');
  assert.match(roleless.detail, /none of them requires a role/);
});

test('a single required role resolves; more than one is ambiguous and all are reported', () => {
  const one = resolveRequiredRoles({
    operation: 'create',
    tiers: [{ tier: 'record', names: ['x'], matched: 1, acls: [{ sys_id: ACL_ID, name: 'x', roles: [{ sys_id: ROLE_ID, name: 'some_admin' }] }] }],
  });
  assert.equal(one.resolved, true);
  assert.equal(one.roles.length, 1);
  assert.match(one.detail, /some_admin is required/);

  const many = resolveRequiredRoles({
    operation: 'create',
    tiers: [{
      tier: 'record', names: ['x'], matched: 2,
      acls: [
        { sys_id: ACL_ID, name: 'x', roles: [{ sys_id: ROLE_ID, name: 'role_a' }] },
        { sys_id: ROLE_ID, name: 'x', roles: [{ sys_id: ACL_ID, name: 'role_b' }] },
      ],
    }],
  });
  assert.equal(many.resolved, false);
  assert.equal(many.reason, 'ambiguous');
  assert.equal(many.roles.length, 2);
});

test('the first non-empty tier wins, and less specific tiers do not contribute', () => {
  const r = resolveRequiredRoles({
    operation: 'read',
    tiers: [
      { tier: 'field', names: ['t.f'], matched: 0, acls: [] },
      { tier: 'wildcard', names: ['t.*'], matched: 1, acls: [{ sys_id: ACL_ID, name: 't.*', roles: [{ sys_id: ROLE_ID, name: 'winner' }] }] },
      { tier: 'record', names: ['t'], matched: 1, acls: [{ sys_id: ROLE_ID, name: 't', roles: [{ sys_id: ACL_ID, name: 'loser' }] }] },
    ],
  });
  assert.equal(r.tier, 'wildcard');
  assert.deepEqual(r.roles.map((x) => x.name), ['winner']);
});

test('eligibility is advisory and says so in the payload, not only in a comment', () => {
  const e = assessEligibility({
    role: 'some_role',
    elevatable: { roles: [{ name: 'some_role', sys_id: ROLE_ID }] },
    effective: { direct: [], via_group: [], via_containment: [] },
  });
  assert.equal(e.advisory, true);
  assert.equal(e.enforced, false);
  assert.equal(e.platformMarksElevatable, true);
  assert.equal(e.userHoldsRole, false);
  assert.match(e.notes.join(' '), /signal to report rather than a prediction/);
});

test('every Phase 1 source is dispatchable, including the containment walk', () => {
  assertDispatchable(buildElevatableRolesSource(), '1.1');
  assertDispatchable(buildEffectiveRolesSource(USER), '1.2');
  assertDispatchable(buildRequiredRoleSource({ table: 'sys_security_acl', operation: 'create' }), '1.4');
  assertDispatchable(buildRequiredRoleSource({ table: 'incident', operation: 'read', field: 'state' }), '1.4 field');
});

test('the containment walk is bounded and reports whether it hit the bound', () => {
  const src = buildEffectiveRolesSource(USER);
  assert.match(src, /depth < 10/);
  assert.match(src, /containment_exhausted/);
});

/* ------------------------------------------------------------------ *
 * Phase 4 — composition, payload, verification, claim
 * ------------------------------------------------------------------ */

test('a condition is composed from request context, and every clause traces back to its input', () => {
  const c = composeAclCondition({
    clauses: [
      { field: 'state', operator: 'is_one_of', value: [1, 2], because: 'the request named the open states' },
      { field: 'short_description', operator: 'contains', value: 'vpn', because: 'the request named the topic' },
    ],
  });
  assert.equal(c.condition, 'stateIN1,2^short_descriptionLIKEvpn^EQ');
  assert.equal(c.provenance.length, 2);
  assert.equal(c.provenance[0].because, 'the request named the open states');
  // A template would produce clauses with no corresponding input.
  for (const p of c.provenance) assert.ok(c.condition.includes(p.clause));
});

test('an empty clause list is refused — that is the static ACL this phase avoids', () => {
  assert.throws(() => composeAclCondition({ clauses: [] }), /at least one clause/);
  assert.throws(() => composeAclCondition({}), /at least one clause/);
});

test('valueless operators refuse a value, and value operators refuse its absence', () => {
  assert.equal(composeAclCondition({ clauses: [{ field: 'assigned_to', operator: 'is_empty' }] }).condition, 'assigned_toISEMPTY^EQ');
  assert.throws(() => composeAclCondition({ clauses: [{ field: 'a', operator: 'is_empty', value: 'x' }] }), /takes no value/);
  assert.throws(() => composeAclCondition({ clauses: [{ field: 'a', operator: 'is' }] }), /requires a value/);
});

test('an unrecognised operator is refused rather than saved as a never-matching condition', () => {
  assert.throws(() => composeAclCondition({ clauses: [{ field: 'a', operator: 'sorta_like', value: 'x' }] }), /is not one of/);
  assert.ok(Object.keys(CONDITION_OPERATORS).length >= 10);
});

test('the condition validator has a live schema reader by default, and an injectable one', async () => {
  // It reached the live path only because the default was missing; a defaulted
  // seam nobody exercises is how it goes missing again.
  const injected = await validateAclCondition('incident', 'state=1^EQ', {
    schemaFor: async () => ({ fields: [{ name: 'state' }] }),
  });
  assert.equal(injected.ok, true);
  assert.equal(injected.checked, true);

  const unknown = await validateAclCondition('incident', 'nope=1^EQ', {
    schemaFor: async () => ({ fields: [{ name: 'state' }] }),
  });
  assert.equal(unknown.ok, false);
  assert.deepEqual(unknown.unknown, ['nope']);

  assert.equal(typeof validateAclCondition, 'function');
  // The default is a function reference, not undefined — the actual regression.
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../src/servicenow/acl-authoring.js', import.meta.url), 'utf8');
  assert.match(src, /schemaFor = getSchema/);
});

test('the ACL payload refuses to be static, and defaults to inactive', () => {
  assert.throws(() => buildAclPayload({ target: 'incident', operation: 'read', description: 'd' }), /condition and\/or script/);
  const p = buildAclPayload({ target: 'incident', operation: 'read', condition: 'state=1^EQ', description: 'd' });
  assert.equal(p.name, 'incident');
  assert.equal(p.active, 'false', 'active must default false: 4.5 keeps the artifact, and an inactive row is safe to keep');
  assert.equal(p.admin_overrides, 'false');
  assert.equal(buildAclPayload({ target: 'incident', operation: 'read', field: 'state', condition: 'x=1', description: 'd' }).name, 'incident.state');
  assert.throws(() => buildAclPayload({ target: 'incident', operation: 'read', condition: 'x=1' }), /description is required/);
});

test('the author source attempts the insert regardless of the predicate, and checks for residue', () => {
  const payload = buildAclPayload({ target: 'incident', operation: 'read', condition: 'state=1^EQ', description: 'marker RUN1' });
  const src = buildAclAuthorSource({ payload, roleName: 'itil', marker: 'RUN1' });
  // The experiment's question is whether predicate and outcome agree, so the
  // insert must not be short-circuited on canCreate.
  const preflightAt = src.indexOf('canCreate');
  const insertAt = src.indexOf('w.insert()');
  assert.ok(preflightAt > 0 && insertAt > preflightAt);
  assert.ok(!/if\s*\(\s*!?\s*authored\.preflight\.canCreate\s*\)/.test(src), 'the insert must not be gated on the predicate');
  assert.match(src, /authored\.residue/);
  assert.match(src, /'CONTAINS', MARKER/);
  assertDispatchable(src, 'acl author source');
});

test('the role sys_id is resolved server-side, never handed in', () => {
  const payload = buildAclPayload({ target: 'incident', operation: 'read', condition: 'state=1^EQ', description: 'm' });
  const src = buildAclAuthorSource({ payload, roleName: 'itil', marker: 'M' });
  assert.match(src, /new GlideRecord\('sys_user_role'\)/, 'the role must be looked up in the script');
  assert.ok(!/role_sys_id: '[0-9a-f]{32}'/.test(src));
});

test('a marker is required so the residue check cannot match an unrelated ACL', () => {
  const payload = buildAclPayload({ target: 'incident', operation: 'read', condition: 'state=1^EQ', description: 'm' });
  assert.throws(() => buildAclAuthorSource({ payload, marker: '' }), /run marker is required/);
});

/* ---- update-set scoping ---- */

test('the previous update set is captured before anything else can fail', () => {
  const src = buildUpdateSetScopedSource({ inner: OP, setName: 'disposable', marker: 'M' });
  const capture = src.indexOf('US.previous = String(new GlideUpdateSet().get())');
  const create = src.indexOf("new GlideRecord('sys_update_set')");
  assert.ok(capture > 0 && capture < create, 'the previous set must be read before the disposable one is created');
});

test('the restore is in a finally and is PROVEN by a read-back, not by set() not throwing', () => {
  const src = buildUpdateSetScopedSource({ inner: OP, setName: 'disposable', marker: 'M' });
  const finallyAt = src.indexOf('} finally {');
  const restoreAt = src.indexOf('US.previous) { new GlideUpdateSet().set(US.previous)');
  assert.ok(finallyAt > 0 && restoreAt > finallyAt, 'the restore must sit inside the finally');
  // Verification point 1: the worker must be read back, not assumed.
  assert.match(src, /US\.current_after_restore = String\(new GlideUpdateSet\(\)\.get\(\)\)/);
  assert.match(src, /US\.restore_ok = \(US\.current_after_restore === US\.previous\)/);
});

test('setting the disposable set is also proven by read-back', () => {
  const src = buildUpdateSetScopedSource({ inner: OP, setName: 'disposable', marker: 'M' });
  assert.match(src, /US\.set_ok = \(US\.current_after_set === usId\)/);
});

test('the update-set wrapper refuses to build without a name or marker', () => {
  assert.throws(() => buildUpdateSetScopedSource({ inner: OP, setName: '', marker: 'M' }), /set name is required/);
  assert.throws(() => buildUpdateSetScopedSource({ inner: OP, setName: 'x', marker: '' }), /run marker is required/);
  assert.throws(() => buildUpdateSetScopedSource({ inner: '', setName: 'x', marker: 'M' }), /inner source is required/);
});

test('teardown measures the cascade and deletes nothing but the set itself', () => {
  const src = buildUpdateSetTeardownSource(ACL_ID);
  assert.match(src, /teardown\.children_before/);
  assert.match(src, /teardown\.orphan_count/);
  assert.match(src, /cascade_clears_children/);
  // Verification point 2: orphans are recorded, never swept. Exactly one
  // deleteRecord in the whole source, and it is the update set's own.
  const deletes = src.match(/deleteRecord\(\)/g) ?? [];
  assert.equal(deletes.length, 1, 'teardown must delete only the update set');
  assert.match(src, /usr\.deleteRecord\(\)/);
  assert.throws(() => buildUpdateSetTeardownSource('nope'), /32-character hex/);
});

test('the scoped and teardown sources are dispatchable', () => {
  assertDispatchable(buildUpdateSetScopedSource({ inner: OP, setName: 'disposable', marker: 'M' }), 'update-set scoped');
  assertDispatchable(buildUpdateSetTeardownSource(ACL_ID), 'teardown');
});

/* ---- 4.4, the confabulation guard ---- */

const EXPECTED = { name: 'incident', operation: 'read', active: 'false', condition: 'state=1^EQ', description: 'd' };

test('a fabricated sys_id fails verification instead of reading as written', async () => {
  const r = await verifyAclLive({ sysId: 'not-a-sys-id', expected: EXPECTED });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'malformed_sys_id');

  const gone = await verifyAclLive({ sysId: ACL_ID, expected: EXPECTED, readRecord: async () => null });
  assert.equal(gone.verified, false);
  assert.equal(gone.reason, 'not_found');

  const refused = await verifyAclLive({
    sysId: ACL_ID, expected: EXPECTED,
    readRecord: async () => { throw new Error('ACL restricts the record retrieval'); },
  });
  assert.equal(refused.verified, false);
  assert.equal(refused.reason, 'not_readable');
  assert.match(refused.detail, /second transport/);
});

test('a record that exists but differs is a field mismatch, itemised', async () => {
  const r = await verifyAclLive({
    sysId: ACL_ID, expected: EXPECTED,
    readRecord: async () => ({ ...EXPECTED, condition: 'state=2^EQ' }),
  });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'field_mismatch');
  assert.deepEqual(r.mismatches, [{ field: 'condition', requested: 'state=1^EQ', live: 'state=2^EQ' }]);
});

test('a matching record with a matching role association verifies', async () => {
  const r = await verifyAclLive({
    sysId: ACL_ID,
    expected: EXPECTED,
    roleLink: { sys_id: ROLE_ID, role_sys_id: USER },
    readRecord: async () => ({ ...EXPECTED }),
    readRoleLink: async () => [{ sys_id: ROLE_ID, sys_security_acl: ACL_ID, sys_user_role: USER }],
  });
  assert.equal(r.verified, true);
  assert.equal(r.roleLink.verified, true);
});

test('an ACL whose role association did not land does NOT verify', async () => {
  const r = await verifyAclLive({
    sysId: ACL_ID,
    expected: EXPECTED,
    roleLink: { sys_id: ROLE_ID, role_sys_id: USER },
    readRecord: async () => ({ ...EXPECTED }),
    readRoleLink: async () => [],
  });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'role_link_mismatch');
});

test('a platform-rewritten description is a TRANSFORM, not a dropped write', async () => {
  /*
   * Measured at 4.3 and corroborated: the ACTIVE business rule "Generate ACL
   * Description on First Save" (after/insert, order 1000) rewrites description,
   * and sys_mod_count is 1 immediately after creation. The guard caught this on
   * the first live author; collapsing it into "mismatch" would report a
   * perfectly good write as unverified.
   */
  const live = {
    ...EXPECTED,
    description: 'Allow read for records in incident, for users with role itil, and if the ACL condition (…) evaluates to true.',
  };
  const r = await verifyAclLive({ sysId: ACL_ID, expected: EXPECTED, readRecord: async () => live });
  assert.equal(r.verified, true, 'the write landed; only a platform-owned field differs');
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.transformed.length, 1);
  assert.equal(r.transformed[0].field, 'description');
  assert.match(r.transformed[0].reason, /Generate ACL Description on First Save/);
  assert.match(r.detail, /transformed, not applied/);
});

test('but an EMPTY platform-owned field is still a real drop', async () => {
  // The distinction that keeps the reclassification honest: "the platform
  // computed this" and "our value vanished" must not share a branch.
  const r = await verifyAclLive({
    sysId: ACL_ID, expected: EXPECTED, readRecord: async () => ({ ...EXPECTED, description: '' }),
  });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'field_mismatch');
  assert.deepEqual(r.transformed, []);
  assert.equal(r.mismatches[0].field, 'description');
});

test('a rewritten CONDITION is never excused — only measured platform fields are', async () => {
  const r = await verifyAclLive({
    sysId: ACL_ID, expected: EXPECTED, readRecord: async () => ({ ...EXPECTED, condition: 'state=7^EQ' }),
  });
  assert.equal(r.verified, false);
  assert.equal(r.mismatches[0].field, 'condition');
});

test('reference cells shaped { value, display_value } compare on value', async () => {
  const r = await verifyAclLive({
    sysId: ACL_ID, expected: EXPECTED,
    readRecord: async () => ({ ...EXPECTED, operation: { value: 'read', display_value: 'Read' } }),
  });
  assert.equal(r.verified, true);
});

/* ---- 4.6, the honest claim ---- */

test('the load-bearing claim is made only when the control failed AND the elevated run landed', () => {
  const control = { authored: { dispatched: false, preflight: { canCreate: false }, insert_return: '', residue: { counted: 0 } } };
  const elevated = { authored: { dispatched: true } };
  const e = describeEffect({ control, elevated });
  assert.equal(e.loadBearing, true);
  assert.match(e.supported.join(' '), /THROUGH GlideRecordSecure/);
});

test('the broader claim is explicitly refused, every time, even on a clean run', () => {
  const e = describeEffect({
    control: { authored: { dispatched: false, residue: { counted: 0 } } },
    elevated: { authored: { dispatched: true } },
  });
  // Phase 0 0.5 contradicts it, so it is named and rejected rather than omitted.
  assert.match(e.refuted.join(' '), /NOT CLAIMED: "elevation enabled the write."/);
  assert.match(e.refuted.join(' '), /plain GlideRecord insert/);
});

test('a control that SUCCEEDS refutes the demo claim rather than being reported as a pass', () => {
  const e = describeEffect({
    control: { authored: { dispatched: true, residue: { counted: 1 } } },
    elevated: { authored: { dispatched: true } },
  });
  assert.equal(e.loadBearing, false);
  assert.match(e.refuted.join(' '), /unelevated control SUCCEEDED/);
  assert.equal(e.supported.length, 0);
});

test('an elevated run that also fails establishes nothing, and says so', () => {
  const e = describeEffect({
    control: { authored: { dispatched: false, residue: { counted: 0 } } },
    elevated: { authored: { dispatched: false, preflight: { canCreate: false } } },
  });
  assert.equal(e.loadBearing, false);
  assert.equal(e.predicateOutcomeSplit, false);
  assert.match(e.notEstablished.join(' '), /establishes nothing/);
});

test('THE STOP CONDITION: canCreate true but insert null is a failure, not an inconclusive run', () => {
  const e = describeEffect({
    control: { authored: { dispatched: false, residue: { counted: 0 } } },
    elevated: { authored: { dispatched: false, preflight: { canCreate: true }, insert_return: 'null' } },
  });
  assert.equal(e.predicateOutcomeSplit, true);
  assert.equal(e.loadBearing, false);
  const said = e.notEstablished.join(' ');
  assert.match(said, /STOP CONDITION MET/);
  assert.match(said, /real failure and a finding/);
  // The specific wrong move, named so it cannot be reached for absent-mindedly.
  assert.match(said, /Do NOT retry through a plain GlideRecord/);
  // And it must not ALSO emit the generic "establishes nothing" line.
  assert.equal(e.notEstablished.length, 1);
});

test('no module in the ACL path ever falls back to a plain GlideRecord insert', async () => {
  // 0.5 proved the plain API writes here unelevated, so a fallback would
  // manufacture a green demo for a broken mechanism.
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../src/servicenow/acl-authoring.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join('\n');
  assert.ok(!/new GlideRecord\('sys_security_acl'\)[\s\S]{0,400}\.insert\(\)/.test(code),
    'sys_security_acl must only ever be inserted through GlideRecordSecure');
  assert.match(code, /new GlideRecordSecure\('sys_security_acl'\)/);
});
