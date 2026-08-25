import { table } from './client.js';
import { referenceLookup } from './schema.js';
import { getSettings } from '../config/store.js';
import { assertSysId } from './impersonation.js';

/**
 * B2 — who may be impersonated, decided by NHA and nothing else.
 *
 * WHY THIS EXISTS RATHER THAN A PLATFORM CALL. `GlideImpersonate.canImpersonate()`
 * is not merely useless here, it is actively misleading. Measured in Phase 0 and
 * at the B1 proof gate, on the live instance:
 *
 *   - it returned `true` for an INACTIVE user;
 *   - it returned `true` for a minted GUID proven to match ZERO sys_user rows;
 *   - and `impersonate()` on that same GUID did not fail and did not no-op —
 *     it silently switched the session to `guest` (active, zero roles).
 *
 * So a target that reaches the wrapper unverified does not produce an error. It
 * produces a Guest session that every downstream answer then describes as the
 * user who was asked for. `canImpersonate()` is not called anywhere in this
 * module, not even as a hint.
 *
 * THREE NETS defend the existence check, in order:
 *   1. `discoverImpersonationTarget` only ever yields sys_ids read off real rows.
 *   2. `evaluateEligibility` RE-VERIFIES existence at gate time — catching a
 *      TOCTOU delete between discovery and use, and catching any sys_id that
 *      arrived user-typed or model-produced rather than through discovery.
 *   3. The wrapper's `gs.getUserID() === requested` assert is the final backstop
 *      (B1), and it is what distinguishes a DELIBERATE guest impersonation from
 *      a trap-#17 substitution: ask for guest's real sys_id and the assert
 *      passes; ask for a bogus id and land on guest, and it fails.
 */

export const VERDICT = {
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  SOFT_DENY: 'SOFT_DENY_REQUIRES_ELEVATED_APPROVAL',
};

export const DENY_REASON = {
  USER_NOT_FOUND: 'user_not_found',
  SYS_ID_NOT_UNIQUE: 'sys_id_not_unique',
  USER_INACTIVE: 'user_inactive',
  USER_HAS_NO_USER_NAME: 'user_has_no_user_name',
  CANNOT_IMPERSONATE_EXECUTOR: 'cannot_impersonate_executor',
  CANNOT_IMPERSONATE_INTEGRATION_ACCOUNT: 'cannot_impersonate_integration_account',
};

export const SOFT_DENY_REASON = { TARGET_HOLDS_ADMIN: 'target_holds_admin_role' };

export const DISCOVERY = { RESOLVED: 'resolved', AMBIGUOUS: 'ambiguous', NOT_FOUND: 'not_found' };

/** The platform compares strings case-insensitively on `=`; so do we. */
const sameId = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** REST returns 'true'/'false'; GlideRecord getValue returns '1'/'0'. Accept both. */
const isTrue = (v) => v === true || v === 'true' || v === '1';

/**
 * Find a user to impersonate from something a human typed.
 *
 * Delegates ranking to `referenceLookup`, which already carries the WI-4 fix:
 * an exact `user_name` hit outranks a contains-match on the display name, so
 * "admin" resolves to `user_name = admin` rather than "Certification Admin".
 * Reimplementing that ranking here would fork a defect that already cost a
 * debugging cycle.
 *
 * NEVER auto-picks on a multi-match. Impersonation is exactly the operation
 * where resolving "a name" instead of "a record" means acting as the wrong
 * person, and the platform will not complain.
 */
export async function discoverImpersonationTarget(term, { limit = 10 } = {}) {
  const q = String(term ?? '').trim();
  if (!q) return { status: DISCOVERY.NOT_FOUND, term: q, candidates: [], resolved: null };

  const hits = await referenceLookup('sys_user', q, limit);
  const candidates = hits.map((h) => ({
    sys_id: h.sys_id,
    display: h.display,
    user_name: h.key === 'user_name' ? h.keyValue : undefined,
    matchType: h.matchType,
  }));

  if (!candidates.length) return { status: DISCOVERY.NOT_FOUND, term: q, candidates: [], resolved: null };

  if (hits.ambiguous) {
    return {
      status: DISCOVERY.AMBIGUOUS,
      term: q,
      candidates,
      resolved: null,
      message: `"${q}" matched ${candidates.length} user${candidates.length === 1 ? '' : 's'} without a single exact hit. `
        + 'Pick one before impersonating — impersonating the wrong person produces no error.',
    };
  }

  return { status: DISCOVERY.RESOLVED, term: q, candidates, resolved: candidates[0] };
}

/**
 * Read the target's row, asserting it is exactly one.
 *
 * "Exactly one" is not defensive noise: a zero-row answer is precisely the
 * trap-#17 input, and this is the last place it can be caught cheaply.
 */
async function readTargetRow(sysId) {
  const rows = await table.query('sys_user', {
    query: `sys_id=${sysId}`,
    fields: 'sys_id,user_name,name,active,locked_out',
    display: 'false',
    limit: 5,
  });
  return rows;
}

/**
 * The account NHA itself authenticates as.
 *
 * Sourced from config, never a literal (PARAMETERS). Overridable by argument so
 * the gate can be exercised without a settings file present, and so a caller
 * with a different service account does not have to mutate global config.
 */
function integrationUserName(override) {
  if (override !== undefined && override !== null) return String(override).trim().toLowerCase();
  return String(getSettings().connection.username ?? '').trim().toLowerCase();
}

/**
 * Resolve the `admin` role by name, then ask whether this user holds it.
 *
 * Two queries rather than one dot-walked encoded query, so the role sys_id is
 * echoed (Hard Rule 1) and the check does not depend on dot-walk support in the
 * REST query parser. `sys_user_has_role` materialises INHERITED grants too, so
 * a user who gets admin through a group or role containment is caught.
 */
async function holdsAdminRole(sysId) {
  const roles = await table.query('sys_user_role', {
    query: 'name=admin', fields: 'sys_id,name', display: 'false', limit: 5,
  });
  if (roles.length !== 1) {
    return { holds: null, roleSysId: null, detail: `Expected exactly one sys_user_role named "admin", found ${roles.length}.` };
  }
  const roleSysId = roles[0].sys_id;
  const grants = await table.query('sys_user_has_role', {
    query: `user=${sysId}^role=${roleSysId}`, fields: 'sys_id,inherited', display: 'false', limit: 5,
  });
  return {
    holds: grants.length > 0,
    roleSysId,
    inherited: grants.length ? isTrue(grants[0].inherited) : null,
    detail: `${grants.length} grant row(s) of role ${roleSysId}.`,
  };
}

/**
 * The deterministic gate. Six checks, evaluated live, in dependency order.
 *
 * Returns the whole trail rather than a bare boolean: B3 routes the soft-deny
 * through elevated approval and B6 renders the reason, and both need to say
 * WHICH check spoke.
 */
export async function evaluateEligibility({ sysId, adminSysId, integrationUser } = {}) {
  const target = assertSysId(sysId, 'target sysId');
  const admin = assertSysId(adminSysId, 'adminSysId');
  const checks = [];
  const deny = (reason, detail) => ({
    verdict: VERDICT.DENY, allowed: false, reason, detail, target_sys_id: target, target: null, checks,
  });

  // 1. EXISTS — exactly one row. The primary guard against trap #17.
  const rows = await readTargetRow(target);
  if (rows.length === 0) {
    checks.push({ check: 'exists', pass: false, detail: '0 rows in sys_user' });
    return deny(
      DENY_REASON.USER_NOT_FOUND,
      `No sys_user row has sys_id ${target}. impersonate() would NOT fail on this — it would silently `
      + 'switch the session to guest, and every answer would then describe guest as the requested user.',
    );
  }
  if (rows.length > 1) {
    checks.push({ check: 'exists', pass: false, detail: `${rows.length} rows` });
    return deny(DENY_REASON.SYS_ID_NOT_UNIQUE, `sys_id ${target} matched ${rows.length} rows in sys_user.`);
  }
  const row = rows[0];
  checks.push({ check: 'exists', pass: true, detail: `1 row (${row.user_name || '(no user_name)'})` });

  const identity = {
    sys_id: row.sys_id, user_name: row.user_name ?? '', display: row.name ?? '', active: isTrue(row.active),
  };

  // 2. ACTIVE — canImpersonate() said true for an inactive user, so we ask ourselves.
  if (!isTrue(row.active)) {
    checks.push({ check: 'active', pass: false, detail: `active=${row.active}` });
    return { ...deny(DENY_REASON.USER_INACTIVE, `${identity.user_name || target} is inactive.`), target: identity };
  }
  checks.push({ check: 'active', pass: true, detail: 'active=true' });

  // 3. HAS A USER ID — the platform's own documented requirement.
  if (!String(row.user_name ?? '').trim()) {
    checks.push({ check: 'user_name', pass: false, detail: 'empty' });
    return { ...deny(DENY_REASON.USER_HAS_NO_USER_NAME, `sys_user ${target} has no user_name; impersonation requires one.`), target: identity };
  }
  checks.push({ check: 'user_name', pass: true, detail: identity.user_name });

  // 4. NOT SELF — D2, hard.
  if (sameId(target, admin)) {
    checks.push({ check: 'not_self', pass: false, detail: 'target is the executor' });
    return { ...deny(DENY_REASON.CANNOT_IMPERSONATE_EXECUTOR, 'The executor cannot impersonate itself.'), target: identity };
  }
  checks.push({ check: 'not_self', pass: true, detail: 'target !== executor' });

  // 5. NOT THE INTEGRATION ACCOUNT — resolved from config, not hardcoded.
  const integration = integrationUserName(integrationUser);
  if (integration && identity.user_name.toLowerCase() === integration) {
    checks.push({ check: 'not_integration_account', pass: false, detail: identity.user_name });
    return {
      ...deny(
        DENY_REASON.CANNOT_IMPERSONATE_INTEGRATION_ACCOUNT,
        `${identity.user_name} is the account NHA authenticates as; impersonating it would make the audit trail circular.`,
      ),
      target: identity,
    };
  }
  checks.push({ check: 'not_integration_account', pass: true, detail: integration ? `!= ${integration}` : 'no integration user configured' });

  // 6. ADMIN SOFT-DENY — D2. Not a block: elevated human approval unlocks it.
  const adminRole = await holdsAdminRole(target);
  if (adminRole.holds === null) {
    checks.push({ check: 'admin_role', pass: false, detail: adminRole.detail });
    return {
      ...deny(DENY_REASON.USER_NOT_FOUND, `Could not evaluate the admin role: ${adminRole.detail}`),
      target: identity,
    };
  }
  if (adminRole.holds) {
    checks.push({ check: 'admin_role', pass: false, detail: `holds admin (inherited=${adminRole.inherited})` });
    return {
      verdict: VERDICT.SOFT_DENY,
      allowed: false,
      requiresElevatedApproval: true,
      reason: SOFT_DENY_REASON.TARGET_HOLDS_ADMIN,
      detail: `${identity.user_name} holds the admin role${adminRole.inherited ? ' (inherited)' : ''}. `
        + 'Impersonating an admin is permitted by the platform — Phase 0 confirmed it — so this gate is NHA policy, '
        + 'and only explicit elevated approval lifts it.',
      target_sys_id: target,
      target: identity,
      admin_role_sys_id: adminRole.roleSysId,
      checks,
    };
  }
  checks.push({ check: 'admin_role', pass: true, detail: 'does not hold admin' });

  return {
    verdict: VERDICT.ALLOW, allowed: true, reason: null, detail: null,
    target_sys_id: target, target: identity, checks,
  };
}

/**
 * Discovery then the gate, for the common "the user typed a name" path.
 *
 * A multi-match stops here and returns the candidate list. It is never resolved
 * by picking the first one.
 */
export async function resolveAndEvaluate({ term, adminSysId, integrationUser, limit = 10 } = {}) {
  const found = await discoverImpersonationTarget(term, { limit });
  if (found.status !== DISCOVERY.RESOLVED) return { discovery: found, eligibility: null };
  const eligibility = await evaluateEligibility({ sysId: found.resolved.sys_id, adminSysId, integrationUser });
  return { discovery: found, eligibility };
}
