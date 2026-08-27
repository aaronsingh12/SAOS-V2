import crypto from 'node:crypto';
import { table } from './client.js';
import { jsLiteral, utcStamp } from './execution-harness.js';
import { validateScriptSyntax } from './script-liveness.js';
import { assertRoleName } from './role-elevation.js';
import { assertSysId, assertIdentifier } from './role-model.js';

/**
 * The elevation SHIM — an atomic elevated write, no result-capture sink.
 *
 * WI-3 RETROFIT (was WI-1). WI-1 returned its verdict through a
 * `sys_user_preference` sink row keyed by a nonce (the harness result-capture).
 * That sink is GONE here. The shim now leaves exactly one thing behind: the
 * TARGET RECORD, tagged with the correlation nonce on write. NHA learns the
 * outcome by reading that record back over its ordinary REST path — un-elevated
 * is fine, `sys_security_acl` is REST-readable (Gate 0 A4/H6) — and comparing
 * requested vs actual field values.
 *
 * WHY THIS IS HONEST WITHOUT THE SINK. A gated write CANNOT land un-elevated
 * (WI-1: un-elevated `GlideRecordSecure.insert()` returns `"null"`, no persist).
 * So a target record present on a gated table, carrying this run's nonce, is
 * itself proof that elevation occurred — no self-report needed, and none is
 * trusted. Absence reports FAILED; it is never painted green.
 *
 * ACCEPTED TRADE-OFF (WI-3, explicit). Without the sink, a FAILED write reports
 * "did not land" (true) with no shim-internal reason. That is acceptable:
 * eligibility failures are caught up front by the WI-2 gate, and NHA must never
 * fabricate a reason or paint green on absence. Pre-dispatch we still run the
 * ES3 liveness linter (`validateScriptSyntax`) so the known silent-non-execution
 * class is caught before the job is created — cheap insurance, no sink required.
 *
 * CARRY-FORWARD INVARIANTS, all still enforced and each still tested:
 *   - the gated write is `GlideRecordSecure` ONLY (a plain GlideRecord insert on
 *     the gated table persists un-elevated — WI-1 B1a — and is banned here);
 *   - `gs.hasRole` is asserted true immediately before the write; false aborts;
 *   - success = target READ-BACK, never `insert()`/`canCreate()` (both lie);
 *   - de-elevate in `finally`, on every path;
 *   - the shim NEVER deletes `sys_update_xml` — provenance, recorded not swept.
 *
 * NOT MODEL-CALLABLE. Invoked only by the gated pipeline (elevation-shim-
 * client.js) after classifier + eligibility + approval, and by tests. Absent
 * from server/src/agent/tools.js. No role name is hardcoded — `security_admin`
 * is discovered live and handed in as `role`.
 */

/** How far back run_start is set so the scheduler claims the job immediately. */
const JOB_START_BACKDATE_MS = 60_000;
const DEFAULT_POLL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 90_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The field the nonce is tagged into on the target record, and read back by. */
export const NONCE_FIELD = 'description';
/** The throwaway probe target: an inactive ACL on a nonexistent table. */
export const PROBE_ACL_NAME = 'x_nha_wi3_probe';

/** A per-run correlation nonce. Hex only, so it never needs escaping in source. */
export function mintNonce() {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * The throwaway ACL the live proof authors: role-less, INACTIVE, on a
 * nonexistent table, its `description` carrying the nonce so NHA can read it
 * back. Built directly — a static inactive probe is the smallest gated write.
 */
export function buildProbeAclPayload({ nonce }) {
  if (!/^[0-9a-f]{32}$/.test(String(nonce || ''))) {
    throw new Error(`buildProbeAclPayload needs a 32-char hex nonce, got ${JSON.stringify(nonce)}.`);
  }
  return {
    name: PROBE_ACL_NAME,
    operation: 'read',
    type: 'record',
    active: 'false',
    admin_overrides: 'false',
    description: `NHA elevation-shim probe ${nonce} — throwaway, safe to delete`,
  };
}

/**
 * The elevated-write job body. ES3, standalone (no `out`, no sink). The proven
 * lifecycle, inlined: runner precondition -> reachability -> enable -> ASSERT
 * gs.hasRole -> GlideRecordSecure write -> finally disable.
 *
 * The `insert()` return is deliberately discarded: it lies (WI-1), and the truth
 * is the caller's target read-back. A body that cannot confirm elevation simply
 * does not write — it never falls back to a plain GlideRecord.
 */
export function buildElevatedWriteBody({ role, runnerUserSysId, table: tableName, operation = 'create', payload, sysId = null }) {
  const roleName = assertRoleName(role);
  const runner = assertSysId(runnerUserSysId, 'the runner user sys_id');
  const tbl = assertIdentifier(tableName, 'table');
  if (!payload || typeof payload !== 'object') throw new Error('An elevated write needs a payload object.');
  if (operation !== 'create' && operation !== 'update') {
    throw new Error(`buildElevatedWriteBody supports create and update only, got ${JSON.stringify(operation)} (delete/rollback is a separate WI).`);
  }
  const targetSysId = operation === 'update' ? assertSysId(sysId, 'the update target sys_id') : null;

  // The gated mutation — GlideRecordSecure ONLY, whichever operation. For update
  // the record is FETCHED by sys_id first; if it does not read back the write is
  // simply not attempted (never a plain-GlideRecord fallback). The write's return
  // (insert()/update()) is DISCARDED — it lies (WI-1); truth is the read-back.
  const writeLines = operation === 'create'
    ? [
      '        var w = new GlideRecordSecure(TARGET_TABLE);',
      '        w.initialize();',
      '        for (var k in REC) { if (REC.hasOwnProperty(k)) { w.setValue(k, REC[k]); } }',
      '        w.insert(); // return DISCARDED — truth is the target read-back',
    ]
    : [
      '        var w = new GlideRecordSecure(TARGET_TABLE);',
      '        if (w.get(SYS_ID)) {',
      '          for (var k in REC) { if (REC.hasOwnProperty(k)) { w.setValue(k, REC[k]); } }',
      '          w.update(); // return DISCARDED — truth is the read-back by sys_id',
      '        }',
    ];

  return [
    `var ROLE = ${jsLiteral(roleName)};`,
    `var RUNNER = ${jsLiteral(runner)};`,
    `var TARGET_TABLE = ${jsLiteral(tbl)};`,
    `var REC = ${jsLiteral(payload)};`,
    `var SYS_ID = ${jsLiteral(targetSysId)};`,
    'try {',
    '  // (a) runner precondition — server-side (Gate 0 H6: role record is 0 rows over REST).',
    "  var roleGr = new GlideRecord('sys_user_role');",
    "  roleGr.addQuery('name', ROLE);",
    '  roleGr.query();',
    '  var runnerHasRole = false;',
    '  if (roleGr.next()) {',
    '    var roleId = roleGr.getUniqueValue();',
    "    var hasGr = new GlideRecord('sys_user_has_role');",
    "    hasGr.addQuery('user', RUNNER);",
    "    hasGr.addQuery('role', roleId);",
    '    hasGr.query();',
    '    runnerHasRole = (hasGr.next() ? true : false);',
    '  }',
    '',
    '  // (b) reachability guard — re-assert Gate 0 A2.',
    "  var reachable = (typeof GlideSecurityManager === 'function') && (GlideSecurityManager.get() !== null);",
    '',
    '  if (runnerHasRole && reachable) {',
    '    GlideSecurityManager.get().enableElevatedRole(ROLE);',
    '    try {',
    '      // (c) ASSERT the true seam before writing. A denied write is silent,',
    '      // so an un-elevated write must never be attempted (WI-1).',
    '      if (gs.hasRole(ROLE) === true) {',
    '        // (d) the gated mutation. GlideRecordSecure ONLY.',
    ...writeLines,
    '      }',
    '    } finally {',
    '      // (g) de-elevate on every path.',
    '      GlideSecurityManager.get().disableElevatedRole(ROLE);',
    '    }',
    '  }',
    '} catch (e) {',
    '  // Swallowed on purpose: the job reports nothing, and a self-report would',
    '  // be the thing we refuse to trust. Truth is the caller reading the target.',
    '}',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * WI-ACL-1 — the ATOMIC ACL UNIT (ACL record + its role links)
 * ------------------------------------------------------------------ */

/** The role-link table. Gated on `security_admin` since Gate A A1b. */
export const ACL_ROLE_TABLE = 'sys_security_acl_role';
export const ACL_TABLE = 'sys_security_acl';

/**
 * The elevated body for an ACL authored AS ONE UNIT: the `sys_security_acl`
 * record and every `sys_security_acl_role` link, all-or-nothing.
 *
 * ── Why atomicity is the whole point here ────────────────────────────────
 *
 * An ACL's role requirement does not live on the ACL. It is a row in
 * `sys_security_acl_role`. So "create the ACL, then link the role" is two
 * writes, and the gap between them is a real, reachable state: an ACL with no
 * role. If the spec named no other condition, that ACL is EMPTY — and an empty
 * ACL does not fail, it saves and DENIES EVERYONE it matches.
 *
 * A partial success here is therefore not a partial success. It is a lockout.
 * That is why the failure path is not "report and stop" (the shim's usual, and
 * correct, discipline for a single record) but ROLL BACK IN THE SAME ELEVATED
 * EXECUTION: the only moment this process is able to delete that ACL is while it
 * still holds the role, and `security_admin` is gone the instant the execution
 * ends (Phase 0 probe 0.4). Leaving the rollback to a later call would mean
 * leaving a deny-everyone ACL in place for as long as that call took to arrive —
 * or forever, if it never did.
 *
 * ── What is carried forward from WI-1/WI-3/WI-5, unchanged ───────────────
 *   - `GlideRecordSecure` ONLY, for every write, on both tables (a plain
 *     GlideRecord insert persists un-elevated — WI-1 B1a — and would make the
 *     elevation decorative);
 *   - `gs.hasRole` asserted true immediately before any write; false writes nothing;
 *   - insert()/update() return values DISCARDED — they lie (WI-1);
 *   - de-elevate in `finally`, on every path;
 *   - NO sink: this body reports nothing. Truth is the caller's read-back of
 *     BOTH tables. A self-report is the thing we refuse to trust.
 *
 * The rollback's own success is likewise not self-reported — the caller reads the
 * ACL back and a surviving role-less ACL is rendered as the loudest failure the
 * renderer has.
 */
export function buildAclUnitBody({
  role, runnerUserSysId, operation = 'create', payload, roleSysIds = [], sysId = null, nonce,
}) {
  const roleName = assertRoleName(role);
  const runner = assertSysId(runnerUserSysId, 'the runner user sys_id');
  if (operation !== 'create' && operation !== 'update' && operation !== 'delete') {
    throw new Error(`buildAclUnitBody supports create, update and delete, got ${JSON.stringify(operation)}.`);
  }
  if (operation !== 'delete' && (!payload || typeof payload !== 'object')) {
    throw new Error('An ACL unit write needs a payload object.');
  }
  if (operation !== 'create') assertSysId(sysId, 'the target ACL sys_id');
  if (operation === 'create' && !/^[0-9a-f]{32}$/.test(String(nonce || ''))) {
    throw new Error('buildAclUnitBody needs a 32-char hex nonce to find the created ACL server-side.');
  }
  for (const r of roleSysIds) assertSysId(r, 'a role sys_id for the ACL role link');

  const head = [
    `var ROLE = ${jsLiteral(roleName)};`,
    `var RUNNER = ${jsLiteral(runner)};`,
    `var ACL_TABLE = ${jsLiteral(ACL_TABLE)};`,
    `var LINK_TABLE = ${jsLiteral(ACL_ROLE_TABLE)};`,
    `var REC = ${jsLiteral(payload || {})};`,
    `var ROLE_IDS = ${jsLiteral(roleSysIds)};`,
    `var ACL_ID = ${jsLiteral(sysId)};`,
    `var NONCE = ${jsLiteral(nonce || '')};`,
    '',
    '// Helpers, inlined: this body must stand alone on a scheduler worker.',
    'function linkIdsFor(aclId) {',
    '  var found = [];',
    '  var q = new GlideRecord(LINK_TABLE);',
    "  q.addQuery('sys_security_acl', aclId);",
    '  q.query();',
    "  while (q.next()) { found.push({ link: q.getUniqueValue(), role: String(q.getValue('sys_user_role')) }); }",
    '  return found;',
    '}',
    'function dropLinks(aclId) {',
    '  var ls = linkIdsFor(aclId);',
    '  for (var i = 0; i < ls.length; i++) {',
    '    var d = new GlideRecordSecure(LINK_TABLE);',
    '    if (d.get(ls[i].link)) { d.deleteRecord(); }',
    '  }',
    '}',
    'function addLinks(aclId, ids) {',
    '  for (var i = 0; i < ids.length; i++) {',
    '    var m = new GlideRecordSecure(LINK_TABLE);',
    '    m.initialize();',
    "    m.setValue('sys_security_acl', aclId);",
    "    m.setValue('sys_user_role', ids[i]);",
    '    m.insert(); // return DISCARDED — truth is the read-back',
    '  }',
    '}',
    'function linksComplete(aclId, want) {',
    '  var got = linkIdsFor(aclId);',
    '  if (got.length !== want.length) { return false; }',
    '  for (var i = 0; i < want.length; i++) {',
    '    var hit = false;',
    '    for (var j = 0; j < got.length; j++) { if (got[j].role === want[i]) { hit = true; } }',
    '    if (!hit) { return false; }',
    '  }',
    '  return true;',
    '}',
  ];

  let work;
  if (operation === 'create') {
    work = [
      '        // (d1) the ACL record.',
      '        var w = new GlideRecordSecure(ACL_TABLE);',
      '        w.initialize();',
      '        for (var k in REC) { if (REC.hasOwnProperty(k)) { w.setValue(k, REC[k]); } }',
      '        w.insert(); // return DISCARDED — it lies (WI-1)',
      '',
      '        // (d2) find what landed, by the nonce carried in description.',
      '        var f = new GlideRecord(ACL_TABLE);',
      "        f.addQuery('description', 'CONTAINS', NONCE);",
      '        f.query();',
      "        var newId = f.next() ? f.getUniqueValue() : '';",
      '',
      '        // (d3) the role links, in the SAME elevated execution.',
      '        if (newId) { addLinks(newId, ROLE_IDS); }',
      '',
      '        // (d4) ATOMICITY. Anything short of the whole unit is rolled back',
      '        // HERE, while this execution still holds the role — a role-less ACL',
      '        // is an EMPTY ACL, and an empty ACL denies everyone it matches.',
      '        if (newId && !linksComplete(newId, ROLE_IDS)) {',
      '          dropLinks(newId);',
      '          var rb = new GlideRecordSecure(ACL_TABLE);',
      '          if (rb.get(newId)) { rb.deleteRecord(); }',
      '        }',
    ];
  } else if (operation === 'update') {
    work = [
      '        // (d1) capture the BEFORE state, so a failed link half can be undone.',
      '        var before = new GlideRecord(ACL_TABLE);',
      '        var haveBefore = before.get(ACL_ID);',
      '        var beforeFields = {};',
      '        if (haveBefore) { for (var bk in REC) { if (REC.hasOwnProperty(bk)) { beforeFields[bk] = String(before.getValue(bk) === null ? \'\' : before.getValue(bk)); } } }',
      '        var beforeLinks = haveBefore ? linkIdsFor(ACL_ID) : [];',
      '        var beforeRoleIds = [];',
      '        for (var bi = 0; bi < beforeLinks.length; bi++) { beforeRoleIds.push(beforeLinks[bi].role); }',
      '',
      '        if (haveBefore) {',
      '          // (d2) the ACL fields.',
      '          var u = new GlideRecordSecure(ACL_TABLE);',
      '          if (u.get(ACL_ID)) {',
      '            for (var k2 in REC) { if (REC.hasOwnProperty(k2)) { u.setValue(k2, REC[k2]); } }',
      '            u.update(); // return DISCARDED',
      '          }',
      '',
      '          // (d3) reconcile the role links to exactly ROLE_IDS.',
      '          dropLinks(ACL_ID);',
      '          addLinks(ACL_ID, ROLE_IDS);',
      '',
      '          // (d4) ATOMICITY. If the links did not land as asked, put the ACL',
      '          // back the way it was — fields AND links. An update that half-ran',
      '          // can strip the role requirement off a live rule.',
      '          if (!linksComplete(ACL_ID, ROLE_IDS)) {',
      '            dropLinks(ACL_ID);',
      '            addLinks(ACL_ID, beforeRoleIds);',
      '            var rv = new GlideRecordSecure(ACL_TABLE);',
      '            if (rv.get(ACL_ID)) {',
      '              for (var k3 in beforeFields) { if (beforeFields.hasOwnProperty(k3)) { rv.setValue(k3, beforeFields[k3]); } }',
      '              rv.update();',
      '            }',
      '          }',
      '        }',
    ];
  } else {
    work = [
      '        // (d1) LINKS FIRST. A link outliving its ACL is an orphan row',
      '        // pointing at nothing; the ACL outliving its links is a role-less,',
      '        // deny-everyone rule. Both are worse than either delete alone, and',
      '        // this order makes the dangerous window the harmless one.',
      '        dropLinks(ACL_ID);',
      '        if (linkIdsFor(ACL_ID).length === 0) {',
      '          var dr = new GlideRecordSecure(ACL_TABLE);',
      '          if (dr.get(ACL_ID)) { dr.deleteRecord(); }',
      '        }',
    ];
  }

  return [
    ...head,
    'try {',
    '  // (a) runner precondition — server-side (Gate 0 H6: role record is 0 rows over REST).',
    "  var roleGr = new GlideRecord('sys_user_role');",
    "  roleGr.addQuery('name', ROLE);",
    '  roleGr.query();',
    '  var runnerHasRole = false;',
    '  if (roleGr.next()) {',
    '    var roleId = roleGr.getUniqueValue();',
    "    var hasGr = new GlideRecord('sys_user_has_role');",
    "    hasGr.addQuery('user', RUNNER);",
    "    hasGr.addQuery('role', roleId);",
    '    hasGr.query();',
    '    runnerHasRole = (hasGr.next() ? true : false);',
    '  }',
    '',
    '  // (b) reachability guard — re-assert Gate 0 A2.',
    "  var reachable = (typeof GlideSecurityManager === 'function') && (GlideSecurityManager.get() !== null);",
    '',
    '  if (runnerHasRole && reachable) {',
    '    GlideSecurityManager.get().enableElevatedRole(ROLE);',
    '    try {',
    '      // (c) ASSERT the true seam before writing. A denied write is silent,',
    '      // so an un-elevated write must never be attempted (WI-1).',
    '      if (gs.hasRole(ROLE) === true) {',
    ...work,
    '      }',
    '    } finally {',
    '      // (g) de-elevate on every path.',
    '      GlideSecurityManager.get().disableElevatedRole(ROLE);',
    '    }',
    '  }',
    '} catch (e) {',
    '  // Swallowed on purpose: the job reports nothing, and a self-report would',
    '  // be the thing we refuse to trust. Truth is the caller reading both tables.',
    '}',
  ].join('\n');
}

/**
 * Tier an ACL UNIT from the read-back of BOTH tables.
 *
 * Green requires both halves. The field half reuses `assessOutcomeTier` (so the
 * projection-superset guard and the platform-owned-field handling are the same
 * code, not a second implementation that could drift). The role half is an exact
 * SET comparison against the sys_ids that were requested — no name resolution at
 * read-back time, because the sys_ids were already resolved and verified live
 * during validation, and re-resolving names over REST would reintroduce the D-2
 * blind spot at the last step.
 *
 * The distinct, loudest state: `role_less`. An ACL that landed, was asked for
 * roles, has none, and carries no other condition is the deny-everyone lockout.
 * It is reported as FAILED — not COERCED — because nothing about it succeeded,
 * and because the rollback that should have prevented it did not run.
 */
export function assessAclUnitTier({
  requested, actual, comparedFields = null, platformOwned = [],
  expectedRoleSysIds = [], actualRoleSysIds = null, conditionSources = [],
}) {
  const fieldOutcome = assessOutcomeTier({ requested, actual, comparedFields, platformOwned });

  const want = [...new Set(expectedRoleSysIds.map(String))];
  const got = actualRoleSysIds === null ? null : [...new Set(actualRoleSysIds.map(String))];
  const missing = got === null ? want : want.filter((r) => !got.includes(r));
  const extra = got === null ? [] : got.filter((r) => !want.includes(r));
  const rolesRead = got !== null;
  const rolesOk = rolesRead && missing.length === 0 && extra.length === 0;

  const roles = {
    expected: want, actual: got, missing, extra, ok: rolesOk, read: rolesRead,
    detail: !rolesRead
      ? 'the role links were not read back, so the role requirement is NOT confirmed'
      : (rolesOk
        ? (want.length ? `all ${want.length} role link(s) present and no extras` : 'no roles requested, and none present')
        : `role links do not match: ${missing.length} missing, ${extra.length} unexpected`),
  };

  if (!fieldOutcome.landed) {
    return { ...fieldOutcome, roles, role_less: false, unit: 'acl' };
  }

  // The lockout state, named and separated from ordinary coercion.
  const otherConditions = conditionSources.filter((s) => s !== 'roles');
  const roleLess = want.length > 0 && rolesRead && got.length === 0;
  if (roleLess && otherConditions.length === 0) {
    return {
      ...fieldOutcome,
      tier: 'FAILED', roles, role_less: true, unit: 'acl',
      detail: 'the ACL record landed but NONE of its role links did, and it carries no other condition — that is an '
        + 'EMPTY ACL, which denies everyone it matches. The atomic rollback should have removed it and did not. '
        + 'Delete this ACL on the instance before anything relies on it.',
    };
  }

  if (!rolesOk) {
    return {
      ...fieldOutcome,
      tier: 'COERCED', roles, role_less: roleLess, unit: 'acl',
      detail: `${fieldOutcome.detail}; and the role requirement did not land as asked — ${roles.detail}`,
    };
  }

  return { ...fieldOutcome, roles, role_less: false, unit: 'acl' };
}

/**
 * Read the nonce-tagged target back over the ordinary REST path. This is the
 * ONLY success signal. Un-elevated is fine — the table is REST-readable (H6),
 * and a gated write cannot have landed un-elevated, so presence is proof.
 */
export async function readTargetByNonce({ table: tableName, nonce, name = null, nonceField = NONCE_FIELD, fields = null }) {
  const tbl = assertIdentifier(tableName, 'table');
  if (!/^[0-9a-f]{32}$/.test(String(nonce || ''))) throw new Error('readTargetByNonce needs a 32-char hex nonce.');
  const clauses = [`${nonceField}LIKE${nonce}`];
  if (name) clauses.push(`name=${name}`);
  const rows = await table.query(tbl, {
    query: clauses.join('^'),
    // The projection MUST cover every field we will compare, or an unfetched
    // field reads back empty and a clean write mis-tiers as COERCED.
    fields: fields || 'sys_id,name,operation,active,description,sys_created_by,sys_scope',
    limit: 5, display: 'false',
  }).catch(() => []);
  return rows;
}

/** The field projection a requested-vs-actual comparison needs: sys_id + every requested key. */
function fieldsForComparison(payload, nonceField) {
  const keys = new Set(['sys_id', nonceField, ...Object.keys(payload || {})]);
  return [...keys];
}

/**
 * Tier one outcome from the target read-back, comparing requested vs actual.
 *   EXECUTED — landed and every asserted field was VERIFIED to match.
 *   COERCED  — landed but a field differs, was platform-rewritten, or was
 *              asserted OUTSIDE the read-back projection (so not confirmable).
 *   FAILED   — not present.
 *
 * PROJECTION-SUPERSET GUARD (WI-4). EXECUTED is reachable only when the read-back
 * projection is a SUPERSET of every asserted field. An asserted field that was
 * not in the projection was not read, so it cannot be confirmed — treating it as
 * matched would be the M3/renderer-dishonesty class one layer down. Such a field
 * is surfaced as `unverified` and the tier is DOWNGRADED off EXECUTED. Only the
 * fields actually compared appear in `compared_fields`/`compared_detail`, so the
 * renderer's "confirmed" scope is exactly the verified scope.
 *
 * `comparedFields` is the projection actually fetched. Omitting it defaults to
 * "every requested field was projected" (back-compat) — callers that read a
 * partial projection MUST pass it so the guard can see the gap.
 * `platformOwned` names fields the platform rewrites (e.g. an ACL `description`
 * business rule) so their divergence reads as COERCED, never as a dropped write.
 */
export function assessOutcomeTier({ requested, actual, comparedFields = null, platformOwned = [] }) {
  const reqKeys = Object.keys(requested || {});
  if (!actual) {
    return { tier: 'FAILED', landed: false, sys_id: null, mismatches: [], coerced: [], unverified: reqKeys, compared_fields: [], compared_detail: [], detail: 'the target record is not present — the write did not land' };
  }
  const cell = (v) => (v && typeof v === 'object' ? (v.value ?? '') : (v ?? ''));
  const projection = comparedFields ? new Set(comparedFields) : new Set(reqKeys);
  const owned = new Set(platformOwned);
  const mismatches = [];
  const coerced = [];
  const unverified = [];        // asserted, but outside the projection — NOT confirmable
  const compared_fields = [];   // asserted AND projected — the verified scope
  const compared_detail = [];
  for (const f of reqKeys) {
    const want = String(requested[f] ?? '');
    if (!projection.has(f)) { unverified.push(f); continue; }
    const got = String(cell(actual[f]) ?? '');
    compared_fields.push(f);
    compared_detail.push({ field: f, requested: want, actual: got });
    if (want === got) continue;
    if (owned.has(f) && got !== '') coerced.push({ field: f, requested: want, actual: got });
    else mismatches.push({ field: f, requested: want, actual: got });
  }
  const base = { landed: true, sys_id: cell(actual.sys_id) || null, compared_fields, compared_detail, unverified };
  if (mismatches.length) {
    return { tier: 'COERCED', ...base, mismatches, coerced, detail: `landed, but ${mismatches.length} field(s) differ from what was requested` };
  }
  if (unverified.length) {
    // Landed, nothing seen to differ — but an asserted field was never read, so
    // this cannot be called EXECUTED. Loud, non-green.
    return { tier: 'COERCED', ...base, mismatches: [], coerced, detail: `landed, but ${unverified.length} asserted field(s) were outside the read-back projection and are NOT confirmed: ${unverified.join(', ')}` };
  }
  if (coerced.length) {
    return { tier: 'COERCED', ...base, mismatches: [], coerced, detail: `landed; ${coerced.length} platform-owned field(s) were rewritten` };
  }
  return { tier: 'EXECUTED', ...base, mismatches: [], coerced: [], detail: 'landed and every requested field matches' };
}

/**
 * Dispatch one elevated write and read the outcome off the TARGET record.
 *
 * Creates the one-shot `sysauto_script` job (the proven trigger path), reads the
 * target back over REST (by nonce for create; by sys_id, gated on a sys_mod_count
 * increment, for update), and cleans up the JOB only. It does NOT
 * create a `sys_user_preference` sink, does NOT delete `sys_update_xml` the write
 * leaves (provenance), and does NOT delete the target (forward write; the
 * acceptance test reverts through the elevated channel).
 */
export async function dispatchElevatedWrite({
  role, runnerUserSysId, table: tableName, operation = 'create', payload, nonce, sysId = null,
  name = null, platformOwned = [], nonceField = NONCE_FIELD,
  timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS, emit = () => {},
} = {}) {
  const roleName = assertRoleName(role);
  const runner = assertSysId(runnerUserSysId, 'the runner user sys_id');
  const tbl = assertIdentifier(tableName, 'table');
  if (!/^[0-9a-f]{32}$/.test(String(nonce || ''))) throw new Error('dispatchElevatedWrite needs a 32-char hex nonce.');
  const targetSysId = operation === 'update' ? assertSysId(sysId, 'the update target sys_id') : null;

  const body = buildElevatedWriteBody({ role: roleName, runnerUserSysId: runner, table: tbl, operation, payload, sysId: targetSysId });

  // The known silent-non-execution class, caught before the job is created.
  const validation = validateScriptSyntax(body);
  if (!validation.ok) {
    return {
      dispatched: false, job: null, nonce,
      outcome: { tier: 'FAILED', landed: false, sys_id: null, mismatches: [], coerced: [], detail: `refused pre-dispatch: ${validation.errors.map((e) => e.message).join(' | ')}` },
      validation,
    };
  }

  // For an update, the "job ran" signal is a sys_mod_count INCREMENT (the field
  // value is a separate question — that is the tier). Captured before dispatch so
  // a coerced update reads back as COERCED rather than timing out as FAILED.
  let beforeMod = -1;
  if (operation === 'update') {
    const beforeRows = await table.query(tbl, { query: `sys_id=${targetSysId}`, fields: 'sys_mod_count', limit: 1, display: 'false' }).catch(() => []);
    beforeMod = Number(beforeRows[0]?.sys_mod_count ?? -1);
  }

  const jobId = crypto.randomUUID().replace(/-/g, '');
  let created = false;
  try {
    emit({ type: 'elev_job_creating', job: jobId, table: tbl, operation });
    await table.create('sysauto_script', {
      sys_id: jobId,
      name: `NHA elevated ${operation} — ${tbl}`.slice(0, 60),
      active: 'true',
      run_type: 'once',
      run_start: utcStamp(Date.now() - JOB_START_BACKDATE_MS),
      script: body,
    });
    created = true;
    emit({ type: 'elev_job_created', job: jobId });

    // The projection MUST be a superset of every asserted field (WI-4 guard).
    const projection = operation === 'update'
      ? [...new Set(['sys_id', 'sys_mod_count', ...Object.keys(payload)])]
      : fieldsForComparison(payload, nonceField);
    let actual = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      if (operation === 'update') {
        const rows = await table.query(tbl, { query: `sys_id=${targetSysId}`, fields: projection.join(','), limit: 1, display: 'false' }).catch(() => []);
        if (rows.length && Number(rows[0].sys_mod_count) > beforeMod) { actual = rows[0]; break; }
      } else {
        const rows = await readTargetByNonce({ table: tbl, nonce, name, nonceField, fields: projection.join(',') });
        if (rows.length) { actual = rows[0]; break; }
      }
      emit({ type: 'elev_waiting', remainingMs: Math.max(0, deadline - Date.now()) });
    }

    const outcome = assessOutcomeTier({ requested: payload, actual, comparedFields: projection, platformOwned });
    return { dispatched: true, job: jobId, nonce, operation, outcome, actual, validation };
  } finally {
    if (created) {
      await table.remove('sysauto_script', jobId).catch(() => {});
      const still = await table.get('sysauto_script', jobId, 'false').catch(() => null);
      emit({ type: 'elev_job_cleanup', job: jobId, deleted: still == null });
    }
  }
}

/**
 * Dispatch one ATOMIC ACL UNIT and tier it off a read-back of BOTH tables.
 *
 * Same transport and same discipline as `dispatchElevatedWrite` — one-shot
 * `sysauto_script`, no sink, job cleaned up afterwards, `sys_update_xml` left
 * alone as provenance. What differs is the success signal, because an ACL's
 * truth lives in two tables:
 *
 *   create — poll for the ACL by nonce, then read its role links.
 *   update — poll for EITHER a `sys_mod_count` increment on the ACL OR a change
 *            in its link set. Both are needed: a roles-only update never touches
 *            the ACL row, so `sys_mod_count` alone would time out as FAILED on a
 *            write that in fact landed perfectly. The caller guarantees that
 *            SOMETHING must change — a no-op update is refused before approval —
 *            which is what makes either signal conclusive rather than ambiguous.
 *   delete — poll for the ACL's ABSENCE, then check that no orphan links survive.
 */
export async function dispatchAclUnit({
  role, runnerUserSysId, operation = 'create', payload = {}, roleSysIds = [], sysId = null, nonce,
  beforeModCount = -1, beforeRoleSysIds = [], conditionSources = [], platformOwned = [],
  nonceField = NONCE_FIELD, timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS, emit = () => {},
} = {}) {
  const body = buildAclUnitBody({ role, runnerUserSysId, operation, payload, roleSysIds, sysId, nonce });

  // The known silent-non-execution class, caught before the job is created.
  const validation = validateScriptSyntax(body);
  if (!validation.ok) {
    return {
      dispatched: false, job: null, nonce, operation,
      outcome: {
        tier: 'FAILED', landed: false, sys_id: null, mismatches: [], coerced: [], unverified: [],
        compared_fields: [], compared_detail: [], role_less: false, unit: 'acl',
        roles: { expected: roleSysIds, actual: null, missing: roleSysIds, extra: [], ok: false, read: false, detail: 'not attempted' },
        detail: `refused pre-dispatch: ${validation.errors.map((e) => e.message).join(' | ')}`,
      },
      validation,
    };
  }

  const linksFor = (aclSysId) => table.query(ACL_ROLE_TABLE, {
    query: `sys_security_acl=${aclSysId}`, fields: 'sys_id,sys_user_role', limit: 100, display: 'false',
  }).then((rows) => rows.map((r) => String(r.sys_user_role)).filter(Boolean)).catch(() => null);

  const projection = operation === 'create'
    ? [...new Set(['sys_id', nonceField, ...Object.keys(payload)])]
    : [...new Set(['sys_id', 'sys_mod_count', ...Object.keys(payload)])];
  const beforeLinkKey = [...beforeRoleSysIds].map(String).sort().join(',');

  const jobId = crypto.randomUUID().replace(/-/g, '');
  let created = false;
  try {
    emit({ type: 'elev_job_creating', job: jobId, table: ACL_TABLE, operation, unit: 'acl' });
    await table.create('sysauto_script', {
      sys_id: jobId,
      name: `NHA elevated ACL ${operation}`.slice(0, 60),
      active: 'true',
      run_type: 'once',
      run_start: utcStamp(Date.now() - JOB_START_BACKDATE_MS),
      script: body,
    });
    created = true;
    emit({ type: 'elev_job_created', job: jobId });

    let actual = null;
    let actualRoleSysIds = null;
    let aclGone = false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);

      if (operation === 'create') {
        const rows = await readTargetByNonce({ table: ACL_TABLE, nonce, name: payload.name ?? null, nonceField, fields: projection.join(',') });
        if (rows.length) {
          actual = rows[0];
          actualRoleSysIds = await linksFor(String(actual.sys_id));
          break;
        }
      } else if (operation === 'update') {
        const rows = await table.query(ACL_TABLE, { query: `sys_id=${sysId}`, fields: projection.join(','), limit: 1, display: 'false' }).catch(() => []);
        const links = await linksFor(sysId);
        const linkKey = links === null ? null : [...links].map(String).sort().join(',');
        const fieldsMoved = rows.length > 0 && Number(rows[0].sys_mod_count) > beforeModCount;
        const linksMoved = linkKey !== null && linkKey !== beforeLinkKey;
        if (fieldsMoved || linksMoved) { actual = rows[0] ?? null; actualRoleSysIds = links; break; }
      } else {
        const rows = await table.query(ACL_TABLE, { query: `sys_id=${sysId}`, fields: 'sys_id', limit: 1, display: 'false' }).catch(() => null);
        if (rows !== null && rows.length === 0) {
          aclGone = true;
          actualRoleSysIds = await linksFor(sysId);
          break;
        }
      }
      emit({ type: 'elev_waiting', remainingMs: Math.max(0, deadline - Date.now()) });
    }

    if (operation === 'delete') {
      const outcome = aclUnitDeleteOutcome({ sysId, aclGone, actualRoleSysIds });
      return { dispatched: true, job: jobId, nonce, operation, outcome, actual: null, validation };
    }

    const outcome = assessAclUnitTier({
      requested: payload, actual, comparedFields: projection, platformOwned,
      expectedRoleSysIds: roleSysIds, actualRoleSysIds, conditionSources,
    });
    return { dispatched: true, job: jobId, nonce, operation, outcome, actual, validation };
  } finally {
    if (created) {
      await table.remove('sysauto_script', jobId).catch(() => {});
      const still = await table.get('sysauto_script', jobId, 'false').catch(() => null);
      emit({ type: 'elev_job_cleanup', job: jobId, deleted: still == null });
    }
  }
}

/**
 * Tier a DELETE. Absence is the success signal, so the tiers invert: an ACL that
 * reads back is the failure. The middle state is real and worth its own tier —
 * the ACL gone but its role links surviving leaves rows pointing at nothing.
 */
export function aclUnitDeleteOutcome({ sysId, aclGone, actualRoleSysIds }) {
  const base = {
    landed: aclGone, sys_id: sysId, mismatches: [], coerced: [], unverified: [],
    compared_fields: [], compared_detail: [], unit: 'acl', role_less: false,
  };
  if (!aclGone) {
    return {
      ...base, tier: 'FAILED',
      roles: { expected: [], actual: actualRoleSysIds, missing: [], extra: [], ok: false, read: actualRoleSysIds !== null, detail: 'the ACL was not removed' },
      detail: 'the ACL is still present on the instance — the delete did not land',
    };
  }
  const orphans = actualRoleSysIds === null ? null : actualRoleSysIds.length;
  if (orphans) {
    return {
      ...base, tier: 'COERCED',
      roles: { expected: [], actual: actualRoleSysIds, missing: [], extra: actualRoleSysIds, ok: false, read: true, detail: `${orphans} role link(s) outlived the ACL` },
      detail: `the ACL was deleted, but ${orphans} sys_security_acl_role row(s) survive and now point at nothing — remove them`,
    };
  }
  return {
    ...base, tier: 'EXECUTED',
    compared_fields: ['sys_id'],
    compared_detail: [{ field: 'sys_id', requested: '(removed)', actual: '(absent)' }],
    roles: { expected: [], actual: actualRoleSysIds ?? [], missing: [], extra: [], ok: true, read: actualRoleSysIds !== null, detail: 'no role links remain' },
    detail: 'the ACL and every role link are gone, confirmed by read-back',
  };
}
