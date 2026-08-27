import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  normalizeAclSpec, assertSpecNotEmpty, isTriviallyTrueScript, composeAclName,
  composeAclPayload, mergeAclSpec, specConditionSources, resolveAclSpec,
  prepareAclUnit, buildRoleResolveSource, AclSpecError, GLOBAL_SCOPE, PROVEN_ACL_TYPE,
} from '../src/servicenow/acl-spec.js';
import {
  buildAclUnitBody, assessAclUnitTier, aclUnitDeleteOutcome, ACL_ROLE_TABLE, ACL_TABLE,
} from '../src/servicenow/elevation-shim.js';
import { runGatedWrite, isGatedDescriptor } from '../src/servicenow/elevation-shim-client.js';
import { classifyRequiredRole } from '../src/servicenow/required-role-classifier.js';
import { TOOLS } from '../src/agent/tools.js';
import { elevationOutcome } from '../../client/src/components/elevationOutcome.js';

/**
 * WI-ACL-1 — ACL authoring v1 (global scope): create / update / delete.
 *
 * Every test here is named for the invariant it enforces. The through-line: an
 * ACL is TWO records, and the one that decides who gets in is not the one that
 * reads back. Almost every test below is a consequence of that.
 */

const ROLE = 'security_admin';
const RUNNER = 'a'.repeat(32);
const ITIL = 'b'.repeat(32);
const ACL_SYS_ID = 'c'.repeat(32);

const eligiblePreDecision = async ({ table, operation }) => ({
  gated: true, decision: 'elevate', op: { table, operation }, required_role: ROLE,
  precheck: { eligible: true, branch: 'assigned', runner_assigned: true, role_is_elevated_privilege: true },
  reason: 'eligible',
});

const aclDescriptor = (operation, spec, sysId = null) => ({
  table: ACL_TABLE, operation, requested: {}, sys_id: sysId, acl_spec: spec,
});

/* ------------------------------------------------------------------ *
 * INVARIANT — an EMPTY ACL is never authored, and the refusal is pre-approval
 * ------------------------------------------------------------------ */

test('INVARIANT — a spec with no role, attribute, condition or script is refused as EMPTY', () => {
  assert.throws(
    () => normalizeAclSpec({ table: 'incident', operation: 'read' }),
    (err) => err instanceof AclSpecError && err.reason === 'empty_acl' && /deny everyone it matches/i.test(err.message),
    'an ACL with no conditions at all must be refused, not authored',
  );
  // Any ONE of the four is enough — the check is about emptiness, not about roles.
  for (const cond of [{ roles: ['itil'] }, { security_attributes: ['x'] }, { data_condition: 'state=1' }, { script: 'answer = current.caller_id == gs.getUserID();' }]) {
    const spec = normalizeAclSpec({ table: 'incident', operation: 'read', ...cond });
    assert.equal(specConditionSources(spec).length, 1, `${Object.keys(cond)[0]} alone must satisfy the empty check`);
  }
});

test('INVARIANT — a trivially-true script does NOT satisfy the empty check; it is refused', () => {
  // The trap: a script makes the ACL LOOK conditioned while constraining nothing.
  for (const s of ['answer = true;', 'answer=true', 'true;', '  answer  =  true  ;  ', '// just a comment', '/* nothing */']) {
    assert.equal(isTriviallyTrueScript(s), true, `${JSON.stringify(s)} must be recognised as trivially true`);
  }
  for (const s of ['answer = current.active == true;', 'answer = gs.hasRole("itil");']) {
    assert.equal(isTriviallyTrueScript(s), false, `${JSON.stringify(s)} is a real condition`);
  }
  assert.throws(
    () => normalizeAclSpec({ table: 'incident', operation: 'read', script: 'answer = true;' }),
    (err) => err.reason === 'trivially_true_script',
  );
});

test('INVARIANT — the empty/invalid refusal happens BEFORE any approval is requested', async () => {
  let approvalRequested = false;
  let dispatched = false;
  const r = await runGatedWrite({
    descriptor: aclDescriptor('insert', { table: 'incident', operation: 'read' }),
    runnerUserSysId: RUNNER,
    requestApproval: async () => { approvalRequested = true; return { approved: true, source: 'user' }; },
    _preDecision: eligiblePreDecision,
    _dispatchAclUnit: async () => { dispatched = true; return {}; },
    // The real preparer, so this exercises the real refusal — only the instance
    // reads are stubbed out of the way.
    _prepareAclUnit: (args) => prepareAclUnit({
      ...args,
      _resolve: (spec) => resolveAclSpec(spec, {
        _readScope: async () => ({ found: true, table: 'incident', sys_scope: 'global' }),
        _query: async () => [{ sys_id: 'read', name: 'read' }],
        _resolveRoles: async () => ({ resolved: [], transport: 'stub' }),
        _schemaFor: async () => ({ fields: [] }),
      }),
    }),
  });

  assert.equal(approvalRequested, false, 'NO approval card may be shown for a spec that fails validation');
  assert.equal(dispatched, false, 'and nothing may be dispatched');
  assert.equal(r.decision, 'refused_spec');
  assert.equal(r.refused, true);
  assert.equal(r.specRefusal.reason, 'empty_acl');
  assert.equal(r.outcome.tier, 'FAILED');
  assert.equal(r.elevated, false);
});

/* ------------------------------------------------------------------ *
 * INVARIANT — an UPDATE is validated on the MERGED result, not the patch
 * ------------------------------------------------------------------ */

test('INVARIANT — clearing the roles of a role-only ACL is refused: the RESULT would be empty', () => {
  const current = {
    decision_type: 'allow', type: 'record', table: 'incident', field: null, operation: 'read',
    applies_to: null, roles: ['itil'], security_attributes: [], data_condition: null, script: null,
    active: true, admin_overrides: false, description: null,
  };
  // The patch, on its own, looks harmless. The RESULT is a deny-everyone ACL.
  assert.throws(
    () => mergeAclSpec({ current, patch: { roles: [] } }),
    (err) => err.reason === 'empty_acl',
    'an update is only safe to judge once merged onto what is actually on the instance',
  );
  // The same patch on an ACL that keeps another condition is fine.
  const merged = mergeAclSpec({ current: { ...current, data_condition: 'state=1' }, patch: { roles: [] } });
  assert.deepEqual(merged.roles, []);
  assert.deepEqual(specConditionSources(merged), ['data_condition']);
});

test('INVARIANT — an update that changes nothing is refused, so the "did it run?" signal stays conclusive', async () => {
  const current = {
    found: true, sys_id: ACL_SYS_ID, sys_mod_count: 3, roleSysIds: [ITIL],
    current: {
      decision_type: 'allow', type: 'record', table: 'incident', field: null, operation: 'read',
      applies_to: null, roles: ['itil'], security_attributes: [], data_condition: null, script: null,
      active: true, admin_overrides: false, description: null,
    },
  };
  const prep = await prepareAclUnit({
    operation: 'update', sysId: ACL_SYS_ID, spec: { active: true },
    _readCurrent: async () => current,
    _resolve: async () => ({ ok: true, resolved: { spec: { name: 'incident' }, payload: {}, roleSysIds: [ITIL], roleNames: ['itil'], scope: { sys_scope: 'global' }, conditionSources: ['roles'] } }),
  });
  assert.equal(prep.ok, false);
  assert.equal(prep.refusal.reason, 'no_change');
  assert.match(prep.refusal.message, /could not be told apart from a job that never ran/);
});

/* ------------------------------------------------------------------ *
 * INVARIANT — a scoped target is REFUSED, never silently globalised
 * ------------------------------------------------------------------ */

test('INVARIANT (WI-ACL-2) — a scoped target is now HONOURED, not refused, and not globalised', async () => {
  /*
   * BEHAVIOUR CHANGE, deliberate and measured. WI-ACL-1 refused every non-global
   * target here (`scoped_target`) because Gate A had measured the writer silently
   * rewriting a requested scope to global — refusing was the only honest option
   * when the scope could not be held.
   *
   * Gate S found the lever (`gs.setCurrentApplicationId`, applied at insert), so
   * the refusal no longer describes a real limit. The honest behaviour is to
   * author IN the target's scope. What must never come back is the third option:
   * accepting a scoped target and quietly landing it in global.
   */
  const SCOPED = '5595c78a34514f1ab3927067bf6e0c12';
  const r = await resolveAclSpec(
    { table: 'x_tepv_ts_dms_dealer', operation: 'read', roles: ['itil'] },
    {
      _readScope: async () => ({ found: true, table: 'x_tepv_ts_dms_dealer', sys_scope: SCOPED }),
      _query: async () => [{ sys_id: 'read', name: 'read' }],
      _resolveRoles: async () => ({ resolved: [{ name: 'itil', sys_id: ITIL, found: true }], transport: 'server-side' }),
      _schemaFor: async () => ({ fields: [] }),
    },
  );
  assert.equal(r.ok, true, 'a scoped target is authorable now');
  assert.equal(r.resolved.aclScope, SCOPED, "the ACL is authored in the TARGET's own scope");
  assert.equal(r.resolved.payload.sys_scope, SCOPED, 'and that scope is the asserted field');
  assert.notEqual(r.resolved.payload.sys_scope, GLOBAL_SCOPE, 'never silently globalised');
});

test('INVARIANT — a target table that does not exist is refused (fail-closed), never assumed global', async () => {
  const r = await resolveAclSpec(
    { table: 'u_does_not_exist', operation: 'read', roles: ['itil'] },
    {
      _readScope: async () => ({ found: false, table: 'u_does_not_exist', sys_scope: null }),
      _query: async () => [{ sys_id: 'read', name: 'read' }],
      _resolveRoles: async () => ({ resolved: [], transport: 'server-side' }),
      _schemaFor: async () => ({ fields: [] }),
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.refusal.reason, 'unknown_target_table');
});

test('INVARIANT — a wildcard-table ACL is refused outright', () => {
  assert.throws(() => composeAclName({ table: '*' }), (err) => err.reason === 'wildcard_table');
  assert.equal(composeAclName({ table: 'incident' }), 'incident');
  assert.equal(composeAclName({ table: 'incident', field: 'state' }), 'incident.state');
  assert.equal(composeAclName({ table: 'incident', field: '*' }), 'incident.*');
});

/* ------------------------------------------------------------------ *
 * INVARIANT — sys_scope is ASSERTED on every write (Gate A B)
 * ------------------------------------------------------------------ */

test('INVARIANT — every ACL payload asserts sys_scope, so a silent rewrite renders COERCED not green', () => {
  const spec = normalizeAclSpec({ table: 'incident', operation: 'read', roles: ['itil'] });
  const create = composeAclPayload(spec, { operationSysId: 'read', typeSysId: 'record', scopeSysId: GLOBAL_SCOPE });
  const update = composeAclPayload(spec, { operationSysId: 'read', typeSysId: 'record', forUpdate: true, scopeSysId: GLOBAL_SCOPE });
  assert.equal(create.sys_scope, GLOBAL_SCOPE, 'create asserts scope');
  assert.equal(update.sys_scope, GLOBAL_SCOPE, 'update asserts scope too');
  // WI-ACL-2: and the asserted value follows the DERIVED scope, not a constant.
  const scoped = composeAclPayload(spec, { operationSysId: 'read', typeSysId: 'record', scopeSysId: 'c44f3c6c37c24793be9f8b759c7818e4' });
  assert.equal(scoped.sys_scope, 'c44f3c6c37c24793be9f8b759c7818e4');

  /*
   * Gate A B measured this exactly: B1 omitted sys_scope and rendered a clean
   * EXECUTED while landing in a scope nobody chose; B2 asserted it and the
   * projection guard caught the rewrite. Asserting it is what makes the tier honest.
   */
  const coerced = assessAclUnitTier({
    requested: create,
    actual: { ...create, sys_id: ACL_SYS_ID, sys_scope: 'someScopedApp' },
    comparedFields: [...Object.keys(create), 'sys_id'],
    expectedRoleSysIds: [ITIL], actualRoleSysIds: [ITIL], conditionSources: ['roles'],
  });
  assert.equal(coerced.tier, 'COERCED');
  assert.ok(coerced.mismatches.some((m) => m.field === 'sys_scope'), 'the scope rewrite is itemised');
  assert.equal(elevationOutcome({ tier: coerced.tier, mismatches: coerced.mismatches, acl: { roles: coerced.roles } }).green, false);
});

test('INVARIANT — identity fields (name, operation, type) are create-only; an update cannot repoint an ACL', () => {
  const spec = normalizeAclSpec({ table: 'incident', operation: 'read', roles: ['itil'] });
  const update = composeAclPayload(spec, { operationSysId: 'read', typeSysId: 'record', forUpdate: true, scopeSysId: GLOBAL_SCOPE });
  for (const f of ['name', 'operation', 'type']) {
    assert.ok(!(f in update), `${f} must never be in an update payload — repointing an ACL is a delete plus a create`);
  }
});

/* ------------------------------------------------------------------ *
 * INVARIANT — ACL + role links are ONE atomic unit, and a partial rolls back
 * ------------------------------------------------------------------ */

test('INVARIANT — a create whose role links do not all land ROLLS BACK the ACL in the same execution', () => {
  const body = buildAclUnitBody({
    role: ROLE, runnerUserSysId: RUNNER, operation: 'create', sysId: ACL_SYS_ID,
    payload: { name: 'incident', operation: 'read', sys_scope: 'global', description: 'x' },
    roleSysIds: [ITIL],
  });
  // The rollback is INSIDE the elevated block: after the links, before de-elevation.
  const linkCheck = body.indexOf('linksComplete(newId, ROLE_IDS)');
  const rollback = body.indexOf('rb.deleteRecord()');
  const deelevate = body.indexOf('disableElevatedRole');
  assert.ok(linkCheck > 0 && rollback > linkCheck, 'the ACL is deleted when the links are incomplete');
  assert.ok(rollback < deelevate, 'and the rollback runs while the role is still held — after de-elevation it could not delete anything');
  assert.match(body, /dropLinks\(newId\)/, 'partial links are cleaned up too, not left orphaned');
});

test('INVARIANT — a create is correlated by PRE-ASSIGNED SYS_ID, never by a nonce in description', () => {
  /*
   * MEASURED LIVE, and it cost a false FAILED on a perfect write.
   *
   * The business rule "Update ACL Description on Role Change"
   * (sys_security_acl_role, after insert) regenerates the PARENT ACL's
   * description from its roles. Writing the role link is the step that COMPLETES
   * the atomic unit — so the correlation marker is destroyed by the write
   * SUCCEEDING. Probe: description held the nonce after the ACL insert and read
   * "Allow read for records in u_nha_aclproof, for users with role itil." after
   * the role link. nonce_survived: false.
   *
   * A sys_id is not a field a business rule can rewrite. `setNewGuidValue` was
   * measured as honoured, so the caller assigns the sys_id and reads back by it.
   */
  const body = buildAclUnitBody({
    role: ROLE, runnerUserSysId: RUNNER, operation: 'create', sysId: ACL_SYS_ID,
    payload: { name: 'incident', description: 'mine' }, roleSysIds: [ITIL],
  });
  assert.match(body, /w\.setNewGuidValue\(ACL_ID\)/, 'the create assigns the sys_id the caller chose');
  assert.ok(!/addQuery\('description', 'CONTAINS', NONCE\)/.test(body), 'the create must not look itself up by a description marker');
  assert.match(body, /Update ACL Description on Role Change/, 'the source records the measurement that forced this');

  // A create without a pre-assigned sys_id is a caller bug, not a silent fallback.
  assert.throws(
    () => buildAclUnitBody({ role: ROLE, runnerUserSysId: RUNNER, operation: 'create', payload: { name: 'incident' }, roleSysIds: [] }),
    /pre-assigned ACL sys_id/,
  );
});

test('INVARIANT — a requested description on a roled/active ACL is WARNED about before approval', async () => {
  // The platform will overwrite it. A human should learn that from the card, not
  // from an amber badge after they approved.
  const prep = await prepareAclUnit({
    operation: 'create', nonce: ACL_SYS_ID,
    spec: { table: 'incident', operation: 'read', roles: ['itil'], description: 'mine', active: true },
    _resolve: async () => ({
      ok: true,
      resolved: {
        spec: { name: 'incident', operation: 'read', roles: ['itil'], active: true, decision_type: 'allow' },
        payload: { name: 'incident', description: 'mine' },
        roleSysIds: [ITIL], roleNames: ['itil'], scope: { sys_scope: 'global' }, conditionSources: ['roles'],
      },
    }),
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.unit.sysId, ACL_SYS_ID, 'the correlation token is spent as the sys_id');
  assert.equal(prep.unit.warnings.length, 1);
  assert.match(prep.unit.warnings[0], /GENERATES the description/);
  assert.match(prep.unit.warnings[0], /COERCED/, 'and it says what the tier will be, so amber is expected rather than alarming');
});

test('INVARIANT — an update whose role links fail restores BOTH the fields and the previous roles', () => {
  const body = buildAclUnitBody({
    role: ROLE, runnerUserSysId: RUNNER, operation: 'update', sysId: ACL_SYS_ID,
    payload: { active: 'false', sys_scope: 'global' }, roleSysIds: [ITIL], nonce: 'd'.repeat(32),
  });
  assert.match(body, /beforeFields/, 'the previous field values are captured before the write');
  assert.match(body, /beforeRoleIds/, 'and so is the previous role set');
  const guard = body.indexOf('!linksComplete(ACL_ID, ROLE_IDS)');
  const restoreRoles = body.indexOf('addLinks(ACL_ID, beforeRoleIds)');
  const restoreFields = body.indexOf('rv.update()');
  assert.ok(guard > 0 && restoreRoles > guard && restoreFields > guard, 'a failed link half restores the ACL to how it was');
});

test('INVARIANT — a delete removes the role links FIRST, then the ACL', () => {
  const body = buildAclUnitBody({ role: ROLE, runnerUserSysId: RUNNER, operation: 'delete', sysId: ACL_SYS_ID, payload: {} });
  const links = body.indexOf('dropLinks(ACL_ID)');
  const acl = body.indexOf('dr.deleteRecord()');
  assert.ok(links > 0 && acl > links, 'links go first — an ACL surviving its links is a deny-everyone rule');
  assert.match(body, /linkIdsFor\(ACL_ID\)\.length === 0/, 'the ACL is only removed once the links are confirmed gone');
});

test('INVARIANT — every write in the ACL unit uses GlideRecordSecure, on BOTH tables', () => {
  for (const [operation, extra] of [
    ['create', { sysId: ACL_SYS_ID, payload: { name: 'incident' } }],
    ['update', { sysId: ACL_SYS_ID, payload: { active: 'true' } }],
    ['delete', { sysId: ACL_SYS_ID, payload: {} }],
  ]) {
    const body = buildAclUnitBody({ role: ROLE, runnerUserSysId: RUNNER, operation, roleSysIds: [ITIL], ...extra });
    // A plain GlideRecord insert on a gated table PERSISTS un-elevated (WI-1 B1a),
    // which would make the elevation decorative. Reads may be plain; writes may not.
    const writeVerbs = body.match(/(\w+)\.(insert|update|deleteRecord)\(\)/g) || [];
    assert.ok(writeVerbs.length > 0, `${operation} performs at least one write`);
    for (const verb of writeVerbs) {
      const varName = verb.split('.')[0];
      const decl = new RegExp(`var ${varName} = new GlideRecordSecure\\(`);
      assert.match(body, decl, `${operation}: ${verb} must be on a GlideRecordSecure, not a plain GlideRecord`);
    }
    assert.match(body, /gs\.hasRole\(ROLE\) === true/, `${operation} asserts the role before writing`);
    assert.match(body, /finally \{[\s\S]*disableElevatedRole/, `${operation} de-elevates in a finally`);
  }
});

/* ------------------------------------------------------------------ *
 * INVARIANT — the tier requires BOTH halves; role_less is its own loud state
 * ------------------------------------------------------------------ */

test('INVARIANT — an ACL whose fields match but whose roles do not is never EXECUTED', () => {
  const requested = { name: 'incident', active: 'true', sys_scope: 'global' };
  const actual = { ...requested, sys_id: ACL_SYS_ID };
  const comparedFields = [...Object.keys(requested), 'sys_id'];

  const ok = assessAclUnitTier({ requested, actual, comparedFields, expectedRoleSysIds: [ITIL], actualRoleSysIds: [ITIL], conditionSources: ['roles'] });
  assert.equal(ok.tier, 'EXECUTED');
  assert.equal(ok.roles.ok, true);

  // Wrong role present instead of the requested one — fields are perfect.
  const wrong = assessAclUnitTier({ requested, actual, comparedFields, expectedRoleSysIds: [ITIL], actualRoleSysIds: ['e'.repeat(32)], conditionSources: ['roles'] });
  assert.equal(wrong.tier, 'COERCED');
  assert.equal(wrong.roles.missing.length, 1);
  assert.equal(wrong.roles.extra.length, 1);

  // Links never read back — "not read" must not pass as "correct".
  const unread = assessAclUnitTier({ requested, actual, comparedFields, expectedRoleSysIds: [ITIL], actualRoleSysIds: null, conditionSources: ['roles'] });
  assert.equal(unread.tier, 'COERCED');
  assert.equal(unread.roles.read, false);
});

test('INVARIANT — a landed ACL with NO roles and no other condition is role_less and FAILED, not amber', () => {
  const requested = { name: 'incident', active: 'true', sys_scope: 'global' };
  const actual = { ...requested, sys_id: ACL_SYS_ID };
  const out = assessAclUnitTier({
    requested, actual, comparedFields: [...Object.keys(requested), 'sys_id'],
    expectedRoleSysIds: [ITIL], actualRoleSysIds: [], conditionSources: ['roles'],
  });
  assert.equal(out.role_less, true);
  assert.equal(out.tier, 'FAILED', 'an empty ACL is not a partial success');
  assert.match(out.detail, /denies everyone/i);
  assert.match(out.detail, /rollback/i, 'and it says the rollback failed, which is the actual defect');

  // But an ACL that keeps another condition is merely coerced — it is not empty.
  const stillConditioned = assessAclUnitTier({
    requested, actual, comparedFields: [...Object.keys(requested), 'sys_id'],
    expectedRoleSysIds: [ITIL], actualRoleSysIds: [], conditionSources: ['roles', 'data_condition'],
  });
  assert.equal(stillConditioned.tier, 'COERCED');
});

test('INVARIANT — the renderer refuses green unless BOTH halves were read and matched', () => {
  const green = elevationOutcome({
    tier: 'EXECUTED', required_role: ROLE, elevation_occurred: true,
    compared_detail: [{ field: 'active', requested: 'true', actual: 'true' }],
    acl: { operation: 'create', roles_expected: ['itil'], roles: { ok: true, read: true, detail: 'all 1 role link(s) present and no extras' } },
  });
  assert.equal(green.green, true);

  // Same EXECUTED tier, role half unread → NOT green.
  const unread = elevationOutcome({
    tier: 'EXECUTED', required_role: ROLE, elevation_occurred: true,
    compared_detail: [{ field: 'active', requested: 'true', actual: 'true' }],
    acl: { operation: 'create', roles_expected: ['itil'], roles: { ok: false, read: false, detail: 'the role links were not read back' } },
  });
  assert.equal(unread.green, false);
  assert.equal(unread.tone, 'warn');
  assert.equal(unread.showDiff, true);
  assert.match(unread.headline, /ROLE requirement was not confirmed/);
});

test('INVARIANT — role_less renders as the loudest state, distinct from ordinary coercion', () => {
  const o = elevationOutcome({
    tier: 'FAILED', required_role: ROLE, elevation_occurred: true, detail: 'empty ACL',
    acl: { operation: 'create', role_less: true, roles_expected: ['itil'], roles: { ok: false, read: true, detail: 'none present' } },
  });
  assert.equal(o.green, false);
  assert.equal(o.tone, 'bad');
  assert.equal(o.badgeClass, 'red');
  assert.equal(o.lockout, true);
  assert.match(o.headline, /denies everyone/i);
  assert.match(o.headline, /Delete it now/);
  // It must NOT be reachable from the amber path — a lockout and a rewritten
  // choice value cannot carry the same visual weight (the M3 class).
  assert.notEqual(o.badgeClass, 'amber');
});

test('INVARIANT — REFUSED_SPEC is distinct from REFUSED: an unsafe rule is not a permissions problem', () => {
  const spec = elevationOutcome({ state: 'REFUSED_SPEC', required_role: ROLE, reason: 'would be empty', spec_refusal: { reason: 'empty_acl' } });
  const perms = elevationOutcome({ state: 'REFUSED', required_role: ROLE, reason: 'not assigned' });
  assert.equal(spec.green, false);
  assert.equal(perms.green, false);
  assert.notEqual(spec.label, perms.label);
  assert.equal(spec.specRefusal, 'empty_acl');
  assert.match(spec.headline, /would not do what it looks like it does/);
  assert.match(spec.headline, /Nothing was elevated or written/);
});

test('INVARIANT — a failed DELETE says the rule is still enforcing, not just "did not land"', () => {
  const stillThere = aclUnitDeleteOutcome({ sysId: ACL_SYS_ID, aclGone: false, actualRoleSysIds: [ITIL] });
  assert.equal(stillThere.tier, 'FAILED');
  const rendered = elevationOutcome({ tier: 'FAILED', detail: stillThere.detail, acl: { operation: 'delete', roles: stillThere.roles } });
  assert.match(rendered.headline, /still on the instance and still enforcing/);

  const orphaned = aclUnitDeleteOutcome({ sysId: ACL_SYS_ID, aclGone: true, actualRoleSysIds: [ITIL] });
  assert.equal(orphaned.tier, 'COERCED', 'links outliving the ACL is its own reportable state');
  assert.match(orphaned.detail, /point at nothing/);

  const clean = aclUnitDeleteOutcome({ sysId: ACL_SYS_ID, aclGone: true, actualRoleSysIds: [] });
  assert.equal(clean.tier, 'EXECUTED');
  assert.equal(clean.roles.ok, true);
});

/* ------------------------------------------------------------------ *
 * INVARIANT — roles resolved SERVER-SIDE (the D-2 / H6 blind spot)
 * ------------------------------------------------------------------ */

test('INVARIANT — role names are resolved server-side, never over REST', async () => {
  const src = buildRoleResolveSource(['security_admin']);
  assert.match(src, /new GlideRecord\('sys_user_role'\)/, 'a server-side GlideRecord, not a REST query');
  assert.match(src, /D-2|H6/, 'the source names the blind spot it exists to avoid');

  const specSrc = await readFile(new URL('../src/servicenow/acl-spec.js', import.meta.url), 'utf8');
  /*
   * The failure this prevents: REST returns 0 rows for `security_admin` on
   * sys_user_role (Gate 0 D-2). A REST-side resolve would report the single most
   * important role on the instance as nonexistent and refuse a correct ACL.
   */
  assert.ok(
    !/_query\(['"]sys_user_role['"]/.test(specSrc),
    'sys_user_role must never be read over REST here — it hides security_admin',
  );
});

test('INVARIANT — an unresolvable role is refused: an invalid ACL denies by default', async () => {
  const r = await resolveAclSpec(
    { table: 'incident', operation: 'read', roles: ['no_such_role'] },
    {
      _readScope: async () => ({ found: true, table: 'incident', sys_scope: 'global' }),
      _query: async () => [{ sys_id: 'read', name: 'read' }],
      _resolveRoles: async () => ({ resolved: [{ name: 'no_such_role', sys_id: null, found: false }], transport: 'server-side' }),
      _schemaFor: async () => ({ fields: [] }),
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.refusal.reason, 'unknown_role');
  assert.match(r.refusal.message, /denies by default/);
  assert.match(r.refusal.message, /not the REST blind spot/, 'and it says the read was server-side, so the user does not chase a phantom');
});

test('INVARIANT — a role read that FAILS is fail-closed, never treated as "no roles"', async () => {
  const r = await resolveAclSpec(
    { table: 'incident', operation: 'read', roles: ['itil'] },
    {
      _readScope: async () => ({ found: true, table: 'incident', sys_scope: 'global' }),
      _query: async () => [{ sys_id: 'read', name: 'read' }],
      _resolveRoles: async () => { throw new AclSpecError('the read did not execute', 'role_read_failed'); },
      _schemaFor: async () => ({ fields: [] }),
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.refusal.reason, 'role_read_failed');
});

/* ------------------------------------------------------------------ *
 * INVARIANT — a condition naming an unknown field is REFUSED (silent-drop)
 * ------------------------------------------------------------------ */

test('INVARIANT — a data condition on a nonexistent field is refused: the platform drops it and widens the rule', async () => {
  const r = await resolveAclSpec(
    { table: 'incident', operation: 'read', roles: ['itil'], data_condition: 'u_not_a_field=1' },
    {
      _readScope: async () => ({ found: true, table: 'incident', sys_scope: 'global' }),
      _query: async () => [{ sys_id: 'read', name: 'read' }],
      _resolveRoles: async () => ({ resolved: [{ name: 'itil', sys_id: ITIL, found: true }], transport: 'server-side' }),
      _schemaFor: async () => ({ fields: [{ name: 'state' }, { name: 'active' }] }),
    },
  );
  assert.equal(r.ok, false);
  assert.equal(r.refusal.reason, 'condition_unknown_field');
  assert.match(r.refusal.message, /WIDER than it reads/);
});

/* ------------------------------------------------------------------ *
 * INVARIANT — the tools are reachable ONLY through the gate
 * ------------------------------------------------------------------ */

test('INVARIANT — create_acl / update_acl / delete_acl produce a GATED descriptor', () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  for (const name of ['create_acl', 'update_acl', 'delete_acl']) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} is registered`);
    assert.equal(tool.mutating, true, `${name} must be mutating so it reaches the approval path at all`);
    assert.equal(typeof tool.describeWrite, 'function', `${name} must describe its write, or the gate cannot classify it`);
    const d = tool.describeWrite({ table: 'incident', operation: 'read', roles: ['itil'], sys_id: ACL_SYS_ID }, null);
    assert.equal(d.table, ACL_TABLE);
    assert.equal(isGatedDescriptor(d), true, `${name} must classify as gated`);
    assert.ok(d.acl_spec, `${name} must carry the spec for pre-approval validation`);
  }
});

test('INVARIANT — the ACL tools\' execute is unreachable, and throws LOUDLY rather than writing un-elevated', () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  for (const name of ['create_acl', 'update_acl', 'delete_acl']) {
    assert.throws(
      () => byName.get(name).execute({ table: 'incident', operation: 'read' }, {}),
      (err) => /must never happen/.test(err.message) && /DENIED SILENTLY/.test(err.message),
      `${name} must not fall back to an un-elevated write — that would report success and change nothing`,
    );
  }
});

test('INVARIANT — the ACL tools never touch the instance themselves', async () => {
  const src = await readFile(new URL('../src/agent/tools.js', import.meta.url), 'utf8');
  const start = src.indexOf("name: 'create_acl'");
  const end = src.indexOf("name: 'recall_memory'");
  assert.ok(start > 0 && end > start, 'the ACL authoring block is where this test expects it');
  const block = src.slice(start, end);
  assert.ok(!/table\.(create|update|remove)\(/.test(block), 'no direct REST write may appear in the ACL tools');
});

test('INVARIANT — the model is TOLD to use these tools and not the generic ones', async () => {
  const prompts = await readFile(new URL('../src/agent/prompts.js', import.meta.url), 'utf8');
  assert.match(prompts, /create_acl, update_acl and delete_acl/, 'the tools are named');
  assert.match(prompts, /denied SILENTLY/i, 'and the reason the generic tools are wrong is stated');
  assert.ok(
    !/there is no ACL authoring tool/.test(prompts),
    'the old READ-ONLY prohibition must be gone — a prompt that contradicts the tool list is worse than no prompt',
  );
  assert.match(prompts, /role_less/, 'the model is told what the lockout state means');
});

/* ------------------------------------------------------------------ *
 * INVARIANT — the gate order, end to end, on a spec that PASSES
 * ------------------------------------------------------------------ */

test('INVARIANT — a valid spec runs gate -> validate -> approve -> dispatch, in that order, once', async () => {
  const order = [];
  const unit = {
    operation: 'create', sysId: null, payload: { name: 'incident', sys_scope: 'global' },
    roleSysIds: [ITIL], conditionSources: ['roles'], beforeModCount: -1, beforeRoleSysIds: [],
    summary: { name: 'incident', operation: 'read', roles: ['itil'], active: true },
  };
  const r = await runGatedWrite({
    descriptor: aclDescriptor('insert', { table: 'incident', operation: 'read', roles: ['itil'] }),
    runnerUserSysId: RUNNER,
    _preDecision: async (a) => { order.push('plan'); return eligiblePreDecision(a); },
    _prepareAclUnit: async () => { order.push('validate'); return { ok: true, unit }; },
    requestApproval: async (payload) => {
      order.push('approve');
      // The card must name the RULE, not the row: roles by name, and the atomicity.
      assert.equal(payload.acl.unit, 'acl_and_role_links');
      assert.equal(payload.acl.atomic, true);
      assert.deepEqual(payload.acl.roles, ['itil']);
      assert.match(payload.note, /atomic unit/);
      assert.match(payload.note, /empty ACL denies everyone/);
      return { approved: true, source: 'user', at: 'now' };
    },
    _dispatchAclUnit: async (args) => {
      order.push('dispatch');
      assert.equal(args.operation, 'create');
      assert.deepEqual(args.roleSysIds, [ITIL]);
      return {
        dispatched: true, job: 'j', operation: 'create',
        outcome: {
          tier: 'EXECUTED', landed: true, sys_id: ACL_SYS_ID, mismatches: [], coerced: [], unverified: [],
          compared_fields: ['name'], compared_detail: [], role_less: false,
          roles: { expected: [ITIL], actual: [ITIL], missing: [], extra: [], ok: true, read: true, detail: 'ok' },
        },
        actual: { sys_id: ACL_SYS_ID },
      };
    },
  });

  assert.deepEqual(order, ['plan', 'validate', 'approve', 'dispatch'],
    'validation must sit between the eligibility plan and the approval card');
  assert.equal(r.decision, 'elevate');
  assert.equal(r.outcome.tier, 'EXECUTED');
  assert.equal(r.aclUnit.operation, 'create');
});

test('INVARIANT — denying the approval dispatches nothing', async () => {
  let dispatched = false;
  const r = await runGatedWrite({
    descriptor: aclDescriptor('insert', { table: 'incident', operation: 'read', roles: ['itil'] }),
    runnerUserSysId: RUNNER,
    _preDecision: eligiblePreDecision,
    _prepareAclUnit: async () => ({ ok: true, unit: { operation: 'create', payload: {}, roleSysIds: [ITIL], conditionSources: ['roles'], summary: { roles: ['itil'] } } }),
    requestApproval: async () => ({ approved: false, source: 'user' }),
    _dispatchAclUnit: async () => { dispatched = true; return {}; },
  });
  assert.equal(dispatched, false);
  assert.equal(r.decision, 'denied');
  assert.equal(r.elevated, false);
});

/* ------------------------------------------------------------------ *
 * INVARIANT — the role-link table is gated (Gate A A1)
 * ------------------------------------------------------------------ */

test('INVARIANT — the role-link table the unit writes to is itself gated', () => {
  // If this ever regresses, the link half of the unit would route un-elevated,
  // be denied silently, and leave exactly the role-less ACL this WI prevents.
  for (const op of ['create', 'update', 'delete']) {
    assert.equal(classifyRequiredRole({ table: ACL_ROLE_TABLE, operation: op }).gated, true);
  }
  assert.equal(PROVEN_ACL_TYPE, 'record');
});

test('INVARIANT — a non-record ACL type is refused as unproven, not authored on a guess', async () => {
  const r = await resolveAclSpec(
    { table: 'incident', operation: 'read', type: 'rest_endpoint', roles: ['itil'] },
    { _readScope: async () => ({ found: true, table: 'incident', sys_scope: 'global' }) },
  );
  assert.equal(r.ok, false);
  assert.equal(r.refusal.reason, 'unproven_acl_type');
});

/* ------------------------------------------------------------------ *
 * INVARIANT — no silent condition drops when merging an update
 * ------------------------------------------------------------------ */

test('INVARIANT — an update preserves conditions the patch did not mention', () => {
  const current = {
    decision_type: 'allow', type: 'record', table: 'incident', field: null, operation: 'read',
    applies_to: 'state=1', roles: ['itil'], security_attributes: ['ACL_x'],
    data_condition: 'active=true', script: 'answer = current.active;',
    active: true, admin_overrides: false, description: 'why',
  };
  const merged = mergeAclSpec({ current, patch: { active: false } });
  assert.equal(merged.active, false, 'the patch applies');
  // Everything else survives. A dropped condition makes an ACL WIDER, which is
  // the failure direction that does not look like a failure.
  assert.deepEqual(merged.roles, ['itil']);
  assert.deepEqual(merged.security_attributes, ['ACL_x']);
  assert.equal(merged.data_condition, 'active=true');
  assert.equal(merged.script, 'answer = current.active;');
  assert.equal(merged.applies_to, 'state=1');
});

test('INVARIANT — more than one security attribute is refused, never truncated to one', () => {
  assert.throws(
    () => normalizeAclSpec({ table: 'incident', operation: 'read', security_attributes: ['a', 'b'] }),
    (err) => err.reason === 'too_many_security_attributes' && /wider than you asked for/.test(err.message),
  );
});

test('INVARIANT — clearing an optional field on update writes "", so the clear lands and is compared', () => {
  const spec = normalizeAclSpec({ table: 'incident', operation: 'read', roles: ['itil'] });
  const update = composeAclPayload(spec, { operationSysId: 'read', typeSysId: 'record', forUpdate: true, scopeSysId: GLOBAL_SCOPE });
  // Not merely absent — present and empty, so the projection covers it and the
  // read-back proves the old value is gone.
  assert.equal(update.condition, '');
  assert.equal(update.script, '');
  const create = composeAclPayload(spec, { operationSysId: 'read', typeSysId: 'record', scopeSysId: GLOBAL_SCOPE });
  assert.ok(!('condition' in create), 'on create, an unset field is left to the platform default');
});

test('INVARIANT — a delete against an ACL that does not exist is refused before approval', async () => {
  const prep = await prepareAclUnit({
    operation: 'delete', sysId: ACL_SYS_ID,
    _readCurrent: async () => ({ found: false, sys_id: ACL_SYS_ID }),
  });
  assert.equal(prep.ok, false);
  assert.equal(prep.refusal.reason, 'acl_not_found');
  assert.match(prep.refusal.message, /acl_report/, 'and it says where a real sys_id comes from');
});
