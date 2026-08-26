import { jsLiteral } from './execution-harness.js';
import { runConfirmedScript, LIVENESS } from './script-liveness.js';
import { ELEVATION_MARKER } from './role-elevation.js';

/**
 * Phase 1 — the dynamic role model. READ ONLY, and SERVER-SIDE ONLY.
 *
 * WHY EVERY QUERY HERE IS A SERVER SCRIPT rather than a Table API call, which
 * would be shorter and is what the obvious implementation does:
 *
 *   Phase 0 D-2 measured that `sys_user_role` over the REST Table API returns
 *   FOUR roles for `elevated_privilege=true` and silently omits `security_admin`
 *   — the exact role this feature turns on. Not an error. Not a 403. An empty
 *   space where a row should be. `GET` by sys_id is honest (404 "Record doesn't
 *   exist or ACL restricts the record retrieval"); the QUERY is not, and a
 *   query is what discovery uses. Server-side GlideRecord returns five.
 *
 *   So a REST-backed discovery does not merely under-report. It hardcodes by
 *   omission: the role list it produces can never contain the role the demo
 *   needs, and nothing anywhere says so. That is the single most dangerous
 *   shape this sprint can produce, and the only defence is to not use that
 *   transport for role questions at all.
 *
 * The ACL tables themselves ARE readable over REST on this instance (verified
 * during the Phase 5 sweep: `sys_security_acl` and `sys_security_acl_role` both
 * return rows). 1.4 still runs server-side, for one reason: it resolves ROLES,
 * and a required-role derivation that silently drops `security_admin` from its
 * answer is the D-2 failure wearing a different hat.
 *
 * Nothing in this file names a role. The Phase 5 baseline is clean and the
 * forward rules keep it that way: `elevated_privilege` is a platform FIELD name
 * (constant), and the set of roles it selects is a live query result (never a
 * list).
 */

/** Bound on the role-containment walk. Deep enough for any real hierarchy. */
const MAX_CONTAINMENT_DEPTH = 10;

const IDENTIFIER_RE = /^[a-z0-9_]+$/i;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;

export function assertIdentifier(value, what = 'identifier') {
  const v = String(value ?? '');
  if (!IDENTIFIER_RE.test(v)) {
    throw new Error(`${what} must match [a-z0-9_]+, got ${JSON.stringify(value)}.`);
  }
  return v;
}

export function assertSysId(value, what = 'sys_id') {
  const v = String(value ?? '');
  if (!SYS_ID_RE.test(v)) {
    throw new Error(`${what} must be a 32-character hex sys_id resolved live from the instance, got ${JSON.stringify(value)}.`);
  }
  return v.toLowerCase();
}

async function runRead(body, label, { emit, timeoutMs } = {}) {
  const res = await runConfirmedScript({ body, label, marker: ELEVATION_MARKER, timeoutMs, emit });
  if (res.liveness !== LIVENESS.CONFIRMED) {
    throw new Error(`${label} did not execute: ${res.liveness} — ${res.detail}`);
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * 1.1 — elevatable-role discovery
 * ------------------------------------------------------------------ */

/**
 * Every role the PLATFORM marks as requiring elevation.
 *
 * `elevated_privilege` is a platform field name and therefore a legitimate
 * constant (Phase 5 §5.6). The roles it selects are not, and are never listed
 * here — the whole point of the probe that produced this module is that the
 * obvious transport returns a plausible list with the important row missing.
 */
export function buildElevatableRolesSource() {
  return [
    "  var eg = new GlideRecord('sys_user_role');",
    "  eg.addQuery('elevated_privilege', true);",
    "  eg.orderBy('name');",
    '  eg.query();',
    '  var found = [];',
    '  while (eg.next()) {',
    '    found.push({',
    '      sys_id: eg.getUniqueValue(),',
    "      name: String(eg.getValue('name')),",
    "      description: String(eg.getValue('description') || ''),",
    "      grantable: String(eg.getValue('grantable')),",
    "      scoped_admin: String(eg.getValue('scoped_admin'))",
    '    });',
    '  }',
    '  out.elevatable = { roles: found, counted: found.length,',
    "                     transport: 'server-side GlideRecord (REST omits security_admin — Phase 0 D-2)' };",
  ].join('\n');
}

export async function discoverElevatableRoles({ emit, timeoutMs } = {}) {
  const res = await runRead(buildElevatableRolesSource(), 'discover elevatable roles', { emit, timeoutMs });
  return { ...res.payload.elevatable, sentinel: res.sentinel };
}

/* ------------------------------------------------------------------ *
 * 1.2 — effective roles for one user
 * ------------------------------------------------------------------ */

/**
 * Direct grants, group inheritance, and role containment, kept in SEPARATE
 * buckets rather than merged into one set.
 *
 * The buckets matter because they answer different questions. "Which roles does
 * this user hold" is the union; "why do they hold this one" is the bucket. A
 * single flat list cannot tell a deliberate grant from one that arrived through
 * a group somebody else administers.
 *
 * One honest overlap, stated rather than hidden: `sys_user_has_role`
 * MATERIALISES inherited grants, so the `direct` bucket is already a superset
 * of hand-assigned roles. Its own `inherited` flag says which is which, and the
 * group/containment walks are still performed because they name the PATH, which
 * the materialised row does not.
 */
export function buildEffectiveRolesSource(userSysId) {
  const user = assertSysId(userSysId, 'userSysId');
  return [
    `  var USER = ${jsLiteral(user)};`,
    '  var seen = {};',
    '  var model = { direct: [], via_group: [], via_containment: [], groups: [] };',
    '',
    '  var roleName = function (rid) {',
    "    var rr = new GlideRecord('sys_user_role');",
    "    if (rr.get(rid)) { return String(rr.getValue('name')); }",
    '    return null;',
    '  };',
    '  var add = function (bucket, rid) {',
    '    if (!rid || seen[rid]) { return false; }',
    '    seen[rid] = true;',
    '    bucket.push({ sys_id: rid, name: roleName(rid) });',
    '    return true;',
    '  };',
    '',
    '  // Direct (materialised) grants.',
    "  var hr = new GlideRecord('sys_user_has_role');",
    "  hr.addQuery('user', USER);",
    '  hr.query();',
    '  while (hr.next()) {',
    "    var did = String(hr.getValue('role'));",
    '    if (!seen[did]) {',
    '      seen[did] = true;',
    "      model.direct.push({ sys_id: did, name: roleName(did), inherited: String(hr.getValue('inherited')) });",
    '    }',
    '  }',
    '',
    '  // Group membership -> group roles.',
    "  var gm = new GlideRecord('sys_user_grmember');",
    "  gm.addQuery('user', USER);",
    '  gm.query();',
    '  var groupIds = [];',
    '  while (gm.next()) {',
    "    var gid = String(gm.getValue('group'));",
    '    groupIds.push(gid);',
    '    model.groups.push({ sys_id: gid });',
    '  }',
    '  if (groupIds.length > 0) {',
    "    var ghr = new GlideRecord('sys_group_has_role');",
    "    ghr.addQuery('group', 'IN', groupIds.join(','));",
    '    ghr.query();',
    "    while (ghr.next()) { add(model.via_group, String(ghr.getValue('role'))); }",
    '  }',
    '',
    '  // Role containment, walked transitively and bounded.',
    '  var frontier = [];',
    '  for (var k in seen) { if (seen.hasOwnProperty(k)) { frontier.push(k); } }',
    '  var depth = 0;',
    `  while (frontier.length > 0 && depth < ${MAX_CONTAINMENT_DEPTH}) {`,
    "    var rc = new GlideRecord('sys_user_role_contains');",
    "    rc.addQuery('role', 'IN', frontier.join(','));",
    '    rc.query();',
    '    var nextFrontier = [];',
    '    while (rc.next()) {',
    "      var cid = String(rc.getValue('contains'));",
    '      if (add(model.via_containment, cid)) { nextFrontier.push(cid); }',
    '    }',
    '    frontier = nextFrontier;',
    '    depth++;',
    '  }',
    '  model.containment_depth = depth;',
    `  model.containment_exhausted = (depth >= ${MAX_CONTAINMENT_DEPTH});`,
    '  model.total = model.direct.length + model.via_group.length + model.via_containment.length;',
    '  out.effective = model;',
  ].join('\n');
}

export async function effectiveRoles({ userSysId, emit, timeoutMs } = {}) {
  const res = await runRead(buildEffectiveRolesSource(userSysId), 'effective roles', { emit, timeoutMs });
  return { ...res.payload.effective, sentinel: res.sentinel };
}

/* ------------------------------------------------------------------ *
 * 1.4 — required-role derivation for (table, operation)
 * ------------------------------------------------------------------ */

/**
 * Which ACL names govern `(table, field)`, in platform precedence order.
 *
 * Pure and exported: the precedence IS the derivation, and it is the part a
 * test can pin down completely without an instance.
 *
 * `table.None` sits alongside `table.*` because the platform writes it for a
 * record-level rule authored through some UI paths, and a derivation that only
 * looked for `table.*` would miss it and fall through to a less specific tier —
 * reporting a role that does not govern the operation asked about.
 */
export function precedenceTiers(tableName, field = null) {
  const t = assertIdentifier(tableName, 'table');
  const tiers = [];
  if (field) tiers.push({ tier: 'field', names: [`${t}.${assertIdentifier(field, 'field')}`] });
  tiers.push({ tier: 'wildcard', names: [`${t}.*`, `${t}.None`] });
  tiers.push({ tier: 'record', names: [t] });
  return tiers;
}

/**
 * Derive, live, which roles an operation on a table requires.
 *
 * `sys_security_acl.operation` is a REFERENCE with two id shapes (acl.js §1):
 * the core operations carry literal short sys_ids equal to their own names
 * (`read`, `write`, `create`, `delete`, `execute`), extended ones carry ordinary
 * 32-hex ids. Rather than assume either, the operation is looked up in
 * `sys_security_operation` AND the literal name is accepted — so a core
 * operation matches on its name-as-sys_id and an extended one on its real id.
 */
export function buildRequiredRoleSource({ table, operation, field = null }) {
  assertIdentifier(table, 'table');
  assertIdentifier(operation, 'operation');
  const tiers = precedenceTiers(table, field);

  return [
    `  var TIERS = ${jsLiteral(tiers)};`,
    `  var OPERATION = ${jsLiteral(operation)};`,
    '',
    '  // Both id shapes for this operation. See the comment above this source.',
    '  var opMatch = {};',
    '  opMatch[OPERATION] = true;',
    "  var og = new GlideRecord('sys_security_operation');",
    "  og.addQuery('name', OPERATION);",
    '  og.query();',
    '  var opRowCount = 0;',
    '  while (og.next()) { opMatch[og.getUniqueValue()] = true; opRowCount++; }',
    '',
    '  var roleName = function (rid) {',
    "    var rr = new GlideRecord('sys_user_role');",
    "    if (rr.get(rid)) { return String(rr.getValue('name')); }",
    '    return null;',
    '  };',
    '',
    '  var walked = [];',
    '  for (var ti = 0; ti < TIERS.length; ti++) {',
    '    var names = TIERS[ti].names;',
    "    var ag = new GlideRecord('sys_security_acl');",
    "    ag.addQuery('name', 'IN', names.join(','));",
    "    ag.addQuery('active', true);",
    '    ag.query();',
    '    var acls = [];',
    '    while (ag.next()) {',
    "      var opValue = String(ag.getValue('operation'));",
    '      if (!opMatch[opValue]) { continue; }',
    '      var aclId = ag.getUniqueValue();',
    '      var roles = [];',
    "      var rg = new GlideRecord('sys_security_acl_role');",
    "      rg.addQuery('sys_security_acl', aclId);",
    '      rg.query();',
    '      while (rg.next()) {',
    "        var rid = String(rg.getValue('sys_user_role'));",
    '        roles.push({ sys_id: rid, name: roleName(rid) });',
    '      }',
    '      acls.push({',
    '        sys_id: aclId,',
    "        name: String(ag.getValue('name')),",
    "        admin_overrides: String(ag.getValue('admin_overrides')),",
    "        condition: String(ag.getValue('condition') || ''),",
    "        has_script: (String(ag.getValue('script') || '').length > 0),",
    '        roles: roles',
    '      });',
    '    }',
    '    walked.push({ tier: TIERS[ti].tier, names: names, matched: acls.length, acls: acls });',
    '  }',
    '',
    '  out.required = { operation: OPERATION, operation_rows: opRowCount, tiers: walked };',
  ].join('\n');
}

/**
 * Reduce the walked tiers to a verdict. Pure, and FAIL-CLOSED.
 *
 * Fail-closed here means one specific thing: `resolved: false` never falls back
 * to a guess. Phase 0 D-1 makes that temptation concrete — it would be very easy
 * to shrug and return `security_admin`, and it would be wrong, because 0.5
 * proved `security_admin` is not what governs the write path this feature uses.
 * A derivation that cannot name the role says so.
 *
 * Three distinct unresolved outcomes, kept apart because their remedies differ:
 *
 *   no_acl_matched              nothing governs this operation at any tier
 *   acl_matched_but_no_role     a rule governs it and requires NO role
 *   ambiguous                   the governing tier names more than one role
 */
export function resolveRequiredRoles(required) {
  const tiers = required?.tiers ?? [];
  const winning = tiers.find((t) => t.matched > 0) ?? null;

  if (!winning) {
    return {
      resolved: false,
      reason: 'no_acl_matched',
      detail: `No active ACL matches ${required?.operation ?? 'that operation'} at any precedence tier `
        + `(${tiers.map((t) => t.names.join('/')).join(' -> ') || 'none walked'}). `
        + 'No role can be derived, and none is assumed.',
      tier: null, roles: [], tiers,
    };
  }

  const roles = [];
  const seen = new Set();
  let roleless = 0;
  for (const acl of winning.acls) {
    if (!acl.roles.length) { roleless += 1; continue; }
    for (const r of acl.roles) {
      const key = r.name ?? r.sys_id;
      if (!seen.has(key)) { seen.add(key); roles.push(r); }
    }
  }

  if (!roles.length) {
    return {
      resolved: false,
      reason: 'acl_matched_but_no_role',
      detail: `${winning.matched} active ACL(s) govern this operation at the "${winning.tier}" tier, and none of `
        + 'them requires a role. Anyone who passes the condition is permitted, so there is no required role to name.',
      tier: winning.tier, roles: [], rolelessAcls: roleless, tiers,
    };
  }

  if (roles.length > 1) {
    return {
      resolved: false,
      reason: 'ambiguous',
      detail: `The "${winning.tier}" tier names ${roles.length} distinct roles `
        + `(${roles.map((r) => r.name ?? r.sys_id).join(', ')}). Any one of them may satisfy the rule, so a single `
        + 'required role cannot be derived. All are reported; none is chosen.',
      tier: winning.tier, roles, rolelessAcls: roleless, tiers,
    };
  }

  return {
    resolved: true,
    reason: null,
    detail: `${roles[0].name ?? roles[0].sys_id} is required for this operation, derived from `
      + `${winning.matched} active ACL(s) at the "${winning.tier}" tier.`,
    tier: winning.tier, roles, rolelessAcls: roleless, tiers,
  };
}

export async function deriveRequiredRoles({ table, operation, field = null, emit, timeoutMs } = {}) {
  const body = buildRequiredRoleSource({ table, operation, field });
  const res = await runRead(body, `required role for ${table}.${field ?? '(record)'} ${operation}`, { emit, timeoutMs });
  const required = res.payload.required;
  return { ...resolveRequiredRoles(required), operation: required.operation, table, field, sentinel: res.sentinel };
}

/* ------------------------------------------------------------------ *
 * 1.3 — eligibility, FOR DISPLAY AND LOGGING ONLY
 * ------------------------------------------------------------------ */

/**
 * Would this user be able to elevate this role?
 *
 * DEMO MODE: this is NOT a gate. Nothing calls it to decide anything, and
 * `runElevated` does not consult it. It exists so a UI and a log can say
 * something true about the request, and so the pre-production hardening pass
 * has the predicate already written and already tested when it turns the gate on.
 *
 * The name is the trap here: an "eligibility" function that is not enforced
 * reads, at a glance, exactly like one that is. Hence `advisory: true` on every
 * return — a caller that treats this as a decision has to ignore a field that
 * says not to.
 */
export function assessEligibility({ role, elevatable, effective }) {
  const roleName = String(role ?? '');
  const known = (elevatable?.roles ?? []).find((r) => r.name === roleName) ?? null;
  const held = [
    ...(effective?.direct ?? []),
    ...(effective?.via_group ?? []),
    ...(effective?.via_containment ?? []),
  ].find((r) => r.name === roleName) ?? null;

  const notes = [];
  if (!known) {
    notes.push(
      `"${roleName}" is not among the roles this instance marks elevated_privilege=true. That is not proof it `
      + 'cannot be elevated — it means the platform does not classify it as an elevation, so enableElevatedRole '
      + 'may simply do nothing.'
    );
  }
  if (!held) {
    notes.push(
      `The executing user does not hold "${roleName}" in any bucket (direct, group, containment). On this `
      + 'instance the admin holds security_admin dormantly and it still elevates, so a missing grant is a signal '
      + 'to report rather than a prediction of failure.'
    );
  }

  return {
    advisory: true,
    role: roleName,
    platformMarksElevatable: Boolean(known),
    userHoldsRole: Boolean(held),
    heldVia: held ? (effective.direct.includes(held) ? 'direct' : effective.via_group.includes(held) ? 'group' : 'containment') : null,
    notes,
    enforced: false,
    enforcementNote: 'Demo mode: eligibility is computed for display and logging only and gates nothing. '
      + 'The pre-production hardening pass turns this into a blocking check at the same call site.',
  };
}
