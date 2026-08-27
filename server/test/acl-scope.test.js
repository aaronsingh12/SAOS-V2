import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  resolveAclSpec, checkScopeRules, resolveScopeRef, tableHasFieldInScope,
  composeAclPayload, normalizeAclSpec, prepareAclUnit, GLOBAL_SCOPE,
} from '../src/servicenow/acl-spec.js';
import { buildAclUnitBody, assessAclUnitTier } from '../src/servicenow/elevation-shim.js';
import { runGatedWrite } from '../src/servicenow/elevation-shim-client.js';
import { elevationOutcome } from '../../client/src/components/elevationOutcome.js';

/**
 * WI-ACL-2 — scope-aware ACL authoring.
 *
 * The premise every test here rests on, measured in Gate S B2: the platform
 * enforces NONE of ServiceNow's five scope restrictions on the scripted path.
 * All five forbidden operations were attempted live and all five were simply
 * ALLOWED — no error, not even a coercion. So these are not belt-and-braces
 * checks over a platform that would have caught it anyway. They are the only
 * thing standing between a request and a rule the docs forbid.
 */

const ROLE = 'security_admin';
const RUNNER = 'a'.repeat(32);
const ITIL = 'b'.repeat(32);
const APP = 'c44f3c6c37c24793be9f8b759c7818e4';   // a scope sys_id, as test DATA
const OTHER_APP = '5595c78a34514f1ab3927067bf6e0c12';

const stubs = ({ objectScope, found = true, fieldsInScope = [], tableExists = true }) => ({
  _readScope: async () => ({ found, table: 'tbl', sys_scope: objectScope }),
  _query: async (t) => {
    if (t === 'sys_dictionary') return fieldsInScope.map((e) => ({ name: 'tbl', element: e, sys_scope: APP }));
    if (t === 'sys_db_object') return tableExists ? [{ name: 'tbl' }] : [];
    if (t === 'sys_scope') return [{ sys_id: APP, scope: 'x_2196302_nwforge', name: 'NowForge Flows' }];
    return [{ sys_id: 'read', name: 'read' }];
  },
  _resolveRoles: async () => ({ resolved: [{ name: 'itil', sys_id: ITIL, found: true }], transport: 'server-side' }),
  _schemaFor: async () => ({ fields: [{ name: 'state' }] }),
});

/* ------------------------------------------------------------------ *
 * INVARIANT — the scope is DERIVED, never hardcoded
 * ------------------------------------------------------------------ */

test('INVARIANT — no application scope is hardcoded anywhere in the authoring path', async () => {
  /*
   * The stop rule. `global` is the platform's own name for the global scope and
   * is unavoidable (sys_scope literally holds that string), but WHICH
   * APPLICATION a rule lands in must always come from the target.
   */
  const files = ['servicenow/acl-spec.js', 'servicenow/elevation-shim.js', 'servicenow/elevation-shim-client.js', 'agent/tools.js'];
  for (const f of files) {
    const src = await readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    // A 32-hex literal in this path could only be a sys_id, and the only sys_ids
    // that belong here are ones read off the instance.
    const sysIds = code.match(/['"`][0-9a-f]{32}['"`]/g) || [];
    assert.deepEqual(sysIds, [], `${f} carries a 32-hex literal: ${sysIds.join(', ')}`);

    /*
     * The precise check, rather than hunting for anything that LOOKS like an app
     * name — `x_nha_wi3_probe` is a WI-3 probe TABLE name and would trip that.
     * What matters is where the two scope-bearing expressions get their value:
     * both must take it from a variable, never a string.
     */
    // Only in the files that COMPOSE a write payload: there, a `sys_scope:` key
    // is always a scope being assigned. In tools.js it is a table NAME used as an
    // object key (`UNCREATABLE_TABLES`), which is a different thing entirely.
    if (f !== 'agent/tools.js') {
      const assigns = code.match(/sys_scope:\s*[^,\n}]+/g) || [];
      for (const a of assigns) {
        assert.ok(!/sys_scope:\s*['"`]/.test(a), `${f} assigns a literal to sys_scope: ${a.trim()}`);
      }
    }
    const switches = code.match(/setCurrentApplicationId\([^)]*\)/g) || [];
    for (const sw of switches) {
      assert.ok(!/\(['"`]/.test(sw), `${f} switches the application to a literal: ${sw}`);
    }
  }

  // And positively: the two places a scope is applied read it from a parameter.
  const spec = await readFile(new URL('../src/servicenow/acl-spec.js', import.meta.url), 'utf8');
  assert.match(spec, /sys_scope:\s*scopeSysId/, 'the payload asserts the scope passed in');
  assert.match(spec, /let aclScope = scope\.sys_scope;/, 'the ACL scope DEFAULTS to the target object\'s own scope');
  const shim = await readFile(new URL('../src/servicenow/elevation-shim.js', import.meta.url), 'utf8');
  assert.match(shim, /var SCOPE = \$\{jsLiteral\(scopeSysId\)\}/, 'the shim switches to the scope it was handed');
});

test('INVARIANT — a global target and a scoped target take the SAME derive-and-honour path', async () => {
  const globalTarget = await resolveAclSpec({ table: 'tbl', operation: 'read', roles: ['itil'] }, stubs({ objectScope: GLOBAL_SCOPE }));
  const scopedTarget = await resolveAclSpec({ table: 'tbl', operation: 'read', roles: ['itil'] }, stubs({ objectScope: APP }));

  assert.equal(globalTarget.ok, true);
  assert.equal(scopedTarget.ok, true);
  assert.equal(globalTarget.resolved.aclScope, GLOBAL_SCOPE, 'a global table yields a global rule');
  assert.equal(scopedTarget.resolved.aclScope, APP, 'a scoped table yields a rule in THAT app');
  // Neither was special-cased: both simply took the target's own scope.
  assert.equal(globalTarget.resolved.aclScope, globalTarget.resolved.objectScope);
  assert.equal(scopedTarget.resolved.aclScope, scopedTarget.resolved.objectScope);
});

test('INVARIANT — a named scope that does not resolve is refused, never defaulted to global', async () => {
  const r = await resolveAclSpec(
    { table: 'tbl', operation: 'read', roles: ['itil'], scope: 'x_no_such_app' },
    { ...stubs({ objectScope: GLOBAL_SCOPE }), _resolveScope: async () => null },
  );
  assert.equal(r.ok, false);
  assert.equal(r.refusal.reason, 'unknown_scope');
  assert.match(r.refusal.message, /defaulting to global/);
});

/* ------------------------------------------------------------------ *
 * INVARIANT — sys_scope asserted = the derived scope; a rewrite is COERCED
 * ------------------------------------------------------------------ */

test('INVARIANT — the asserted sys_scope follows the derived scope, and a rewrite renders COERCED', async () => {
  const r = await resolveAclSpec({ table: 'tbl', operation: 'read', roles: ['itil'] }, stubs({ objectScope: APP }));
  assert.equal(r.resolved.payload.sys_scope, APP, 'the INTENDED scope is the asserted field');

  /*
   * Gate A B1 vs B2 is the whole reason this is asserted: B1 omitted sys_scope
   * and rendered a clean EXECUTED while landing somewhere nobody chose; B2
   * asserted it and the projection guard caught the rewrite. WI-ACL-1 asserted
   * the constant 'global', which could only ever catch a rewrite AWAY from
   * global. Asserting the derived scope catches it in either direction.
   */
  const requested = r.resolved.payload;
  const landedGlobal = { ...requested, sys_id: 'd'.repeat(32), sys_scope: GLOBAL_SCOPE };
  const outcome = assessAclUnitTier({
    requested, actual: landedGlobal, comparedFields: [...Object.keys(requested), 'sys_id'],
    expectedRoleSysIds: [ITIL], actualRoleSysIds: [ITIL], conditionSources: ['roles'],
  });
  assert.equal(outcome.tier, 'COERCED', 'a scoped rule that lands global is never green');
  assert.ok(outcome.mismatches.some((m) => m.field === 'sys_scope'));
  assert.equal(elevationOutcome({ tier: outcome.tier, mismatches: outcome.mismatches, acl: { roles: outcome.roles } }).green, false);
});

/* ------------------------------------------------------------------ *
 * INVARIANT — the scope switch is restored in an OUTERMOST finally
 * ------------------------------------------------------------------ */

test('INVARIANT — the scope context is captured before the work and restored in the outermost finally', () => {
  /*
   * `[pool-switch-risk]`, the residual Gate S left UNVERIFIED. The worker is
   * POOLED and Gate 4 already measured that pool carrying state something else
   * left behind. A switch that outlived this execution would silently stamp
   * whatever ran next into the wrong application.
   */
  for (const [operation, extra] of [
    ['create', { sysId: 'a'.repeat(32), payload: { name: 'tbl' } }],
    ['update', { sysId: 'a'.repeat(32), payload: { active: 'true' } }],
    ['delete', { sysId: 'a'.repeat(32), payload: {} }],
  ]) {
    const body = buildAclUnitBody({ role: ROLE, runnerUserSysId: RUNNER, operation, roleSysIds: [], scopeSysId: APP, ...extra });

    const capture = body.indexOf('BEFORE_APP = String(gs.getCurrentApplicationId())');
    const switchAt = body.indexOf('gs.setCurrentApplicationId(SCOPE)');
    const restore = body.indexOf('gs.setCurrentApplicationId(BEFORE_APP)');
    assert.ok(capture > 0 && switchAt > capture, `${operation}: the previous scope is captured BEFORE the switch`);
    assert.ok(restore > switchAt, `${operation}: the restore follows the switch`);

    // The capture precedes the main try, so a throw anywhere inside it still has
    // a value to restore to.
    const mainTry = body.indexOf('\ntry {\n  // (a) runner precondition');
    assert.ok(capture < mainTry, `${operation}: capture happens before the main try block`);

    // The restore is in the OUTERMOST finally — the last statement of the script,
    // reached on the success path, the swallowed-error path, and a throw before
    // the switch was ever attempted.
    const tail = body.slice(body.lastIndexOf('} catch (e) {'));
    assert.match(tail, /\} finally \{[\s\S]*setCurrentApplicationId\(BEFORE_APP\)[\s\S]*\}\s*$/,
      `${operation}: the restore must be the outermost finally, not nested inside the elevation block`);
    // ...and it is guarded, so a failing restore cannot mask the original error.
    assert.match(body.slice(restore - 60, restore + 120), /try \{[\s\S]*catch/, `${operation}: the restore is itself guarded`);
  }
});

test('INVARIANT — no scope switch is emitted when none was derived', () => {
  const body = buildAclUnitBody({ role: ROLE, runnerUserSysId: RUNNER, operation: 'create', sysId: 'a'.repeat(32), payload: { name: 'tbl' }, roleSysIds: [], scopeSysId: null });
  assert.match(body, /var SCOPE = null;/);
  assert.match(body, /if \(SCOPE !== null\) \{ gs\.setCurrentApplicationId\(SCOPE\); \}/,
    'the switch is conditional, so a null scope is a no-op rather than a switch to nothing');
  // The restore still runs — restoring to the value already current is harmless,
  // and making it unconditional removes a branch that could be got wrong.
  assert.match(body, /setCurrentApplicationId\(BEFORE_APP\)/);
});

/* ------------------------------------------------------------------ *
 * INVARIANT — R1..R5, each refused, each before any approval
 * ------------------------------------------------------------------ */

test('INVARIANT R1 — a cross-scope object with no field in scope is refused', async () => {
  const r = await resolveAclSpec(
    { table: 'tbl', operation: 'read', roles: ['itil'], scope: 'x_2196302_nwforge' },
    stubs({ objectScope: GLOBAL_SCOPE, fieldsInScope: [] }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.refusal.reason, 'cross_scope_object');
  assert.equal(r.refusal.detail.rule, 'R1');
  assert.match(r.refusal.message, /platform will NOT stop this/, 'the refusal says why nothing else will catch it');
});

test('INVARIANT R1 — the field-in-scope branch ALLOWS a cross-scope rule (the docs\' second case)', async () => {
  // Gate S found a live example: cmdb_software_instance, ACL in CMDB Workspace,
  // table global. R1 cannot be simplified to same-scope-only.
  const r = await resolveAclSpec(
    { table: 'tbl', operation: 'read', roles: ['itil'], scope: 'x_2196302_nwforge' },
    stubs({ objectScope: GLOBAL_SCOPE, fieldsInScope: ['u_my_column'] }),
  );
  assert.equal(r.ok, true, 'a table carrying a field in the ACL scope is a legal cross-scope target');
  assert.equal(r.resolved.aclScope, APP);
  assert.deepEqual(r.resolved.fieldInScope.fields, ['u_my_column']);
});

test('INVARIANT R1 — columns on a PSEUDO-table do not count as a field in scope', async () => {
  /*
   * Gate S measured x_2196302_nwforge owning 73 scoped dictionary columns, ZERO
   * of which belonged to a table present in sys_db_object — all were on
   * var__m_sys_hub_flow_* flow-variable pseudo-tables. Counting those would
   * "find" a legal target that cannot be written to.
   */
  const res = await tableHasFieldInScope('var__m_sys_hub_flow_input_x', APP, {
    _query: async (t) => (t === 'sys_dictionary' ? [{ name: 'var__m_x', element: 'taskSysId' }] : []),
  });
  assert.equal(res.has, false);
  assert.match(res.note, /pseudo-table/);

  const r = await resolveAclSpec(
    { table: 'tbl', operation: 'read', roles: ['itil'], scope: 'x_2196302_nwforge' },
    stubs({ objectScope: GLOBAL_SCOPE, fieldsInScope: ['taskSysId'], tableExists: false }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.refusal.reason, 'cross_scope_object');
});

test('INVARIANT R2 — a script on a cross-scope table is refused', () => {
  const v = checkScopeRules({
    aclScope: APP, objectScope: GLOBAL_SCOPE, table: 'tbl', field: null,
    script: 'answer = current.active;', roles: [], fieldInScope: { has: true, fields: ['u_c'] },
  });
  assert.equal(v.reason, 'cross_scope_script');
  assert.equal(v.detail.rule, 'R2');
  assert.match(v.message, /stores such a script verbatim/, 'names the measured platform behaviour');
  // Same pairing without a script is fine — R2 is about the script, not the pairing.
  assert.equal(checkScopeRules({ aclScope: APP, objectScope: GLOBAL_SCOPE, table: 'tbl', field: null, script: null, roles: [], fieldInScope: { has: true, fields: ['u_c'] } }), null);
});

test('INVARIANT R3 — a wildcard table outside global is refused', () => {
  const v = checkScopeRules({ aclScope: APP, objectScope: APP, table: '*', field: null, script: null, roles: [] });
  assert.equal(v.reason, 'wildcard_table_scoped');
  assert.equal(v.detail.rule, 'R3');
  // In global it passes R3 (the docs allow it there) — the tool still refuses
  // every wildcard table earlier, by its own stricter policy. R3 is the narrower
  // rule underneath that policy, not a relaxation of it.
  assert.equal(checkScopeRules({ aclScope: GLOBAL_SCOPE, objectScope: GLOBAL_SCOPE, table: '*', field: null, script: null, roles: [] }), null);
});

test('INVARIANT R3 — the tool refuses a wildcard-table request outright, in any scope', async () => {
  for (const scope of [undefined, 'x_2196302_nwforge']) {
    const r = await resolveAclSpec({ table: '*', operation: 'read', roles: ['itil'], scope }, stubs({ objectScope: APP }));
    assert.equal(r.ok, false);
    assert.match(r.refusal.reason, /wildcard_table/, `scope=${scope}: a wildcard table is refused`);
  }
});

test('INVARIANT R4 — a role link on a cross-scope ACL is refused', () => {
  const v = checkScopeRules({
    aclScope: APP, objectScope: OTHER_APP, table: 'tbl', field: null, script: null,
    roles: ['itil'], fieldInScope: { has: false, fields: [] },
  });
  // R1 fires first on this pairing — which is correct, and is why R4's own test
  // uses a pairing R1 permits.
  assert.equal(v.detail.rule, 'R1');

  const v4 = checkScopeRules({
    aclScope: APP, objectScope: OTHER_APP, table: 'tbl', field: null, script: null,
    roles: ['itil'], fieldInScope: { has: false, fields: [] },
  });
  assert.ok(v4, 'a cross-scope role link never passes');

  // And the writer satisfies R4 structurally: it switches into the ACL's own
  // scope before authoring the record AND its links, in one execution.
  const body = buildAclUnitBody({ role: ROLE, runnerUserSysId: RUNNER, operation: 'create', sysId: 'a'.repeat(32), payload: { name: 'tbl' }, roleSysIds: [ITIL], scopeSysId: APP });
  const switchAt = body.indexOf('gs.setCurrentApplicationId(SCOPE)');
  const addLinks = body.indexOf('addLinks(newId, ROLE_IDS)');
  assert.ok(switchAt > 0 && addLinks > switchAt, 'the role links are written AFTER the switch into the ACL scope');
});

test('INVARIANT R5 — a wildcard field on a cross-scope table is refused', () => {
  const v = checkScopeRules({
    aclScope: APP, objectScope: GLOBAL_SCOPE, table: 'tbl', field: '*', script: null,
    roles: [], fieldInScope: { has: true, fields: ['u_c'] },
  });
  assert.equal(v.reason, 'wildcard_field_cross_scope');
  assert.equal(v.detail.rule, 'R5');
  // Same-scope wildcard field is allowed.
  assert.equal(checkScopeRules({ aclScope: APP, objectScope: APP, table: 'tbl', field: '*', script: null, roles: [] }), null);
});

test('INVARIANT — every R-rule refusal happens BEFORE the approval card', async () => {
  let approvalRequested = false;
  let dispatched = false;
  const r = await runGatedWrite({
    descriptor: { table: 'sys_security_acl', operation: 'insert', requested: {}, sys_id: null, acl_spec: { table: 'tbl', operation: 'read', roles: ['itil'], scope: 'x_2196302_nwforge' } },
    runnerUserSysId: RUNNER,
    requestApproval: async () => { approvalRequested = true; return { approved: true, source: 'user' }; },
    _preDecision: async ({ table, operation }) => ({
      gated: true, decision: 'elevate', op: { table, operation }, required_role: ROLE,
      precheck: { eligible: true, branch: 'assigned', runner_assigned: true, role_is_elevated_privilege: true }, reason: 'eligible',
    }),
    _dispatchAclUnit: async () => { dispatched = true; return {}; },
    _prepareAclUnit: (args) => prepareAclUnit({
      ...args,
      _resolve: (spec) => resolveAclSpec(spec, stubs({ objectScope: GLOBAL_SCOPE, fieldsInScope: [] })),
    }),
  });
  assert.equal(approvalRequested, false, 'no human is asked to approve a rule that breaks a scope restriction');
  assert.equal(dispatched, false);
  assert.equal(r.decision, 'refused_spec');
  assert.equal(r.specRefusal.reason, 'cross_scope_object');
});

/* ------------------------------------------------------------------ *
 * INVARIANT — the scope reaches the writer, and the card
 * ------------------------------------------------------------------ */

test('INVARIANT — the derived scope reaches the shim and the approval card', async () => {
  const prep = await prepareAclUnit({
    operation: 'create', nonce: 'd'.repeat(32),
    spec: { table: 'tbl', operation: 'read', roles: ['itil'] },
    _resolve: async () => ({
      ok: true,
      resolved: {
        spec: { name: 'tbl', operation: 'read', roles: ['itil'], active: true, decision_type: 'allow' },
        payload: { name: 'tbl', sys_scope: APP }, roleSysIds: [ITIL], roleNames: ['itil'],
        aclScope: APP, objectScope: APP, scope: { sys_scope: APP }, conditionSources: ['roles'],
      },
    }),
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.unit.scopeSysId, APP, 'the unit carries the scope the shim will switch into');
  assert.equal(prep.unit.summary.scope, APP, 'and the card names it');
  assert.equal(prep.unit.summary.cross_scope, false);
});

test('INVARIANT — a delete runs in the ACL\'s OWN scope', async () => {
  const prep = await prepareAclUnit({
    operation: 'delete', sysId: 'a'.repeat(32),
    _readCurrent: async () => ({
      found: true, sys_id: 'a'.repeat(32), sys_mod_count: 2, roleSysIds: [ITIL],
      current: { scope: APP, table: 'tbl', field: null, operation: 'read', roles: ['itil'], active: true },
    }),
  });
  assert.equal(prep.ok, true);
  assert.equal(prep.unit.scopeSysId, APP,
    'removing a scoped record from a global context is the same cross-scope write R4 refuses on the way in');
});

test('INVARIANT — resolveScopeRef resolves by name or sys_id, and refuses ambiguity', async () => {
  assert.deepEqual(await resolveScopeRef('global'), { sys_id: GLOBAL_SCOPE, scope: GLOBAL_SCOPE, name: 'Global' });
  assert.equal(await resolveScopeRef(''), null);
  assert.equal(await resolveScopeRef('x_dup', { _query: async () => [{ sys_id: '1' }, { sys_id: '2' }] }), null,
    'two matches is not a resolution');
  const one = await resolveScopeRef('x_2196302_nwforge', { _query: async () => [{ sys_id: APP, scope: 'x_2196302_nwforge', name: 'NowForge Flows' }] });
  assert.equal(one.sys_id, APP);
});
