/**
 * WI-2 — the required-role CLASSIFIER. Deterministic, offline, non-LLM.
 *
 * This is the first half of the security gate the design (§3, §14) requires: a
 * pure `(table, operation) -> required role | none` lookup, with NO model call
 * and NO instance call. The model never decides authorization; this map does,
 * and it is data a human can read in a diff.
 *
 * ZERO IMPORTS on purpose. A classifier that transitively pulled in the HTTP
 * client or a provider could not honestly claim "no instance call, no LLM" — the
 * strongest version of that claim is a module that has nothing to call. Its own
 * identifier check is inlined for the same reason.
 *
 * WHY THE ROLE NAME IS A LEGITIMATE CONSTANT HERE, when role-model.js is
 * forbidden from naming one. role-model.js DISCOVERS roles live because the
 * obvious REST transport returns a plausible list with `security_admin` missing
 * (Gate 0 D-2/H6) — hardcoding there would bake in that blind spot. This map is
 * the opposite category: a MEASURED security-policy fact
 * (`sys_security_acl` CRUD -> `security_admin`, EXECUTED in Gate 0 and WI-1),
 * carried with its provenance and verification tier. It is corroborable live
 * against `deriveRequiredRoles` (role-model.js 1.4), which reads the governing
 * ACLs from the instance — this classifier is the fast, offline pre-decision,
 * not a substitute for that derivation.
 */

const IDENT_RE = /^[a-z0-9_]+$/i;

/**
 * The gated operations, keyed (table -> operation -> required role).
 *
 * ESTABLISHED (EXECUTED). Gate 0 proved elevated `GlideRecordSecure` create on
 * `sys_security_acl` needs `security_admin`; WI-1 proved DELETE is gated too — an
 * un-elevated delete silently no-ops. The delete entry is therefore mandatory,
 * not optional: a classifier that omitted it would let a revert or rollback run
 * un-elevated and silently do nothing, which is exactly the confidently-wrong
 * failure this project exists to make visible.
 *
 * `sys_security_acl_role` — ADDED BY GATE A (A1/A1b), and it closes a LOCKOUT
 * hole, not a tidiness one. The role requirement of an ACL does not live on the
 * ACL: it is a row in `sys_security_acl_role` pointing at `sys_user_role`. Gate A
 * resolved the governing ACLs SERVER-SIDE (REST cannot see `security_admin` on
 * `sys_user_role` — Gate 0 D-2 — so a REST resolve returns an empty role list and
 * hides this) and measured:
 *
 *     sys_security_acl_role  create -> ["security_admin"]  admin_overrides=0
 *     sys_security_acl_role  write  -> ["security_admin"]  admin_overrides=0
 *     sys_security_acl_role  delete -> ["security_admin"]  admin_overrides=0
 *
 * — identical to `sys_security_acl` itself. Before this entry existed, a
 * role-link write classified as UNGATED, so it took the ordinary un-elevated
 * path, was denied, and silently no-opped (WI-1's measured class). The ACL then
 * persisted with NO role and NO other condition: an EMPTY ACL, which the platform
 * denies by default. A gap in our own gate was therefore a route to locking every
 * user out of a table. That is why this is EXECUTED-tier data, not a guess.
 */
const GATED = {
  sys_security_acl: {
    create: 'security_admin',
    update: 'security_admin',
    delete: 'security_admin',
  },
  sys_security_acl_role: {
    create: 'security_admin',
    update: 'security_admin',
    delete: 'security_admin',
  },
};

/**
 * Where each gated entry's measurement came from. Carried per-table so a reader
 * of a classification can trace it to the probe that established it, rather than
 * to one sentence covering entries measured years and gates apart.
 */
const PROVENANCE = {
  sys_security_acl:
    'Gate 0 + WI-1 (EXECUTED): sys_security_acl create/update/delete require security_admin; '
    + 'delete proven gated by WI-1 (un-elevated delete silently no-ops)',
  sys_security_acl_role:
    'Gate A A1b (EXECUTED): the governing ACLs for sys_security_acl_role create/write/delete each '
    + 'require security_admin with admin_overrides=0, resolved SERVER-SIDE because REST cannot see '
    + 'security_admin on sys_user_role (Gate 0 D-2). Ungated, a role-link write silently no-ops and '
    + 'leaves a role-less — therefore EMPTY, therefore deny-everyone — ACL behind',
};

/**
 * [A-hss] — the UNVERIFIED follow-up, kept INERT.
 *
 * Some High Security Settings / `sys_properties` writes require `security_admin`,
 * but the EXACT set is not enumerated on this instance. Hardcoding a guessed list
 * would be precisely the trap the house rules forbid. So these are recorded as
 * follow-ups a human can act on — and `classifyRequiredRole` NEVER consults them:
 * a `sys_properties` write classifies as ungated until the set is measured and
 * promoted into `GATED` with an EXECUTED tier.
 */
export const UNVERIFIED_FOLLOWUPS = [
  {
    table: 'sys_properties',
    operation: 'update',
    suspected_role: 'security_admin',
    tier: 'UNVERIFIED',
    inert: true,
    needs:
      'Enumerate which sys_properties / High Security Settings writes actually require '
      + 'security_admin on a live PDI (probe each candidate property, un-elevated vs elevated, '
      + 'read-back) before promoting any into the gated map. Until then, do not classify '
      + 'property writes as gated.',
  },
];

/**
 * Classify one operation. Pure: same inputs, same output, forever; no network,
 * no model. Throws only on a malformed identifier — a caller bug worth naming at
 * the boundary rather than silently treating as ungated.
 */
export function classifyRequiredRole({ table, operation } = {}) {
  const t = String(table ?? '');
  const op = String(operation ?? '');
  if (!IDENT_RE.test(t) || !IDENT_RE.test(op)) {
    throw new Error(
      `classifyRequiredRole needs a table and operation matching [a-z0-9_]+, `
      + `got (${JSON.stringify(table)}, ${JSON.stringify(operation)}).`,
    );
  }
  const role = (GATED[t] && GATED[t][op]) || null;
  return {
    op: { table: t, operation: op },
    gated: role !== null,
    required_role: role,
    tier: role ? 'EXECUTED' : 'none',
    provenance: role ? PROVENANCE[t] : null,
  };
}

/** The tables this classifier has a measured, gated entry for. Exported for tests/introspection. */
export function gatedTables() {
  return Object.keys(GATED);
}
