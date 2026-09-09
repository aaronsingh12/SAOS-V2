import { runConfirmedScript, LIVENESS } from './script-liveness.js';
import { jsLiteral } from './execution-harness.js';
import { assertRoleName } from './role-elevation.js';
import { assertSysId } from './role-model.js';
import { classifyRequiredRole } from './required-role-classifier.js';

/**
 * WI-2 — the eligibility PRECHECK (Check A) and the combined pre-decision.
 *
 * The classifier (required-role-classifier.js) answers "does this operation need
 * elevation?". This module answers "is the runner even ALLOWED to elevate to the
 * role it needs?" — before any shim is invoked. Together they are the
 * deterministic, non-LLM gate the design requires: the model never decides
 * authorization.
 *
 * TWO QUESTIONS, NEVER CONFLATED (Gate 0 A1/A3):
 *   - "ASSIGNED?"        — does the runner HOLD the role, dormant or active?
 *                          Read from `sys_user_has_role` (+ group-derived). This
 *                          is eligibility. It is THIS module's job.
 *   - "ELEVATED RIGHT NOW?" — is the role active in the session? Read from
 *                          `gs.hasRole`. That is RUNTIME state, the shim's job at
 *                          invocation. It is deliberately NOT read here — reading
 *                          it would answer the wrong question, and a dormant
 *                          `security_admin` (the whole point) would look
 *                          ineligible every time.
 *
 * THE H6 GUARD IS LOAD-BEARING. Gate 0 H6 proved the `security_admin` role RECORD
 * is invisible over plain REST (0 rows) yet readable server-side. So the
 * assignment read is a SERVER-SIDE `GlideRecord`, and a REST-0-rows result must
 * never be interpreted as "not assigned" — that interpretation would refuse
 * every legitimate elevation. This module never performs that REST read.
 *
 * NO LLM. NO SHIM. This module imports no provider client and no elevation-shim:
 * it DECIDES, it does not act. WI-3 consumes the pre-decision and decides
 * whether to invoke the shim behind an approval gate.
 */

/** Distinct sentinel marker for the eligibility read path. */
export const GATE_MARKER = 'NHA_GATE::';

/**
 * Server-side eligibility read: resolve the role by name, read its
 * `elevated_privilege`, and confirm assignment via `sys_user_has_role`
 * (materialised — a superset of hand-assigned, per role-model.js) and, for
 * provenance, via the user's group grants. All server-side; no REST read of the
 * role record (Gate 0 H6). Writes onto `out.eligibility`.
 */
export function buildEligibilitySource({ userSysId, roleName }) {
  const user = assertSysId(userSysId, 'userSysId');
  const role = assertRoleName(roleName);
  return [
    `  var ROLE_NAME = ${jsLiteral(role)};`,
    `  var USER = ${jsLiteral(user)};`,
    '  var elig = {',
    '    role_name: ROLE_NAME, user: USER,',
    '    role_found: false, role_sys_id: null, elevated_privilege: false,',
    '    assigned: false, via_direct: false, via_group: false, direct_inherited: null,',
    "    assignment_transport: 'server-side sys_user_has_role (+ sys_group_has_role); NOT a REST read of the role record (Gate 0 H6: REST returns 0 rows for security_admin)'",
    '  };',
    '',
    '  // The role record is readable server-side though invisible over REST (H6).',
    "  var r = new GlideRecord('sys_user_role');",
    "  r.addQuery('name', ROLE_NAME);",
    '  r.query();',
    '  if (r.next()) {',
    '    elig.role_found = true;',
    '    elig.role_sys_id = r.getUniqueValue();',
    "    elig.elevated_privilege = (String(r.getValue('elevated_privilege')) === '1');",
    '',
    '    // Direct + materialised (group-inherited grants are materialised here too).',
    "    var h = new GlideRecord('sys_user_has_role');",
    "    h.addQuery('user', USER);",
    "    h.addQuery('role', elig.role_sys_id);",
    '    h.query();',
    "    if (h.next()) { elig.via_direct = true; elig.direct_inherited = String(h.getValue('inherited')); }",
    '',
    '    // Group path, read explicitly for provenance (which grant made them eligible).',
    '    var groupIds = [];',
    "    var gm = new GlideRecord('sys_user_grmember');",
    "    gm.addQuery('user', USER);",
    '    gm.query();',
    "    while (gm.next()) { groupIds.push(String(gm.getValue('group'))); }",
    '    if (groupIds.length > 0) {',
    "      var ghr = new GlideRecord('sys_group_has_role');",
    "      ghr.addQuery('group', 'IN', groupIds.join(','));",
    "      ghr.addQuery('role', elig.role_sys_id);",
    '      ghr.query();',
    '      if (ghr.next()) { elig.via_group = true; }',
    '    }',
    '',
    '    elig.assigned = (elig.via_direct || elig.via_group);',
    '  }',
    '  out.eligibility = elig;',
  ].join('\n');
}

/**
 * Combine the server-side read into the Check-A verdict. PURE — no network — so
 * the branch logic is fully covered offline. `eligible = runner_assigned &&
 * role_is_elevated_privilege`; `reason` names the first failing condition, and
 * `branch` distinguishes them so a caller never confuses "not assigned" (a
 * permission fact) with "not elevated-privilege" (a different role class) or
 * "couldn't read" (fail-closed, not a definitive negative).
 */
export function assessEligibilityVerdict(raw, requiredRole, runnerUserSysId = null) {
  const base = {
    required_role: requiredRole,
    runner_user: runnerUserSysId,
    runner_assigned: false,
    role_is_elevated_privilege: false,
    via_direct: false,
    via_group: false,
    assignment_transport: raw?.assignment_transport ?? null,
  };
  if (!raw || typeof raw !== 'object') {
    return { ...base, eligible: false, branch: 'no_read', reason: 'the eligibility read returned no payload; eligibility is unconfirmed (fail-closed, not a definitive "not assigned")' };
  }
  const assigned = raw.assigned === true;
  const elevated = raw.elevated_privilege === true;
  const out = {
    ...base,
    runner_assigned: assigned,
    role_is_elevated_privilege: elevated,
    via_direct: raw.via_direct === true,
    via_group: raw.via_group === true,
  };
  if (raw.role_found !== true) {
    return { ...out, eligible: false, branch: 'role_not_found', reason: `required role ${requiredRole} was not found server-side` };
  }
  if (!assigned) {
    return {
      ...out, eligible: false, branch: 'not_assigned',
      reason: `runner is not assigned ${requiredRole} (read server-side; a plain REST read of this role record returns 0 rows and must NOT be read as "not assigned" — Gate 0 H6)`,
    };
  }
  if (!elevated) {
    return {
      ...out, eligible: false, branch: 'not_elevated_privilege',
      reason: `${requiredRole} is not an elevated-privilege role (elevated_privilege != 1); it is not on the elevation path`,
    };
  }
  return { ...out, eligible: true, branch: 'eligible', reason: null };
}

/**
 * Check A end to end: server-side read + verdict. `_run` is an injectable seam
 * for offline tests; it defaults to the real confirmed-script runner and is
 * never a fallback to a weaker mechanism.
 */
export async function eligibilityPrecheck({
  runnerUserSysId, requiredRole, emit, timeoutMs, _run = runConfirmedScript,
} = {}) {
  const runner = assertSysId(runnerUserSysId, 'the runner user sys_id');
  const role = assertRoleName(requiredRole);
  const body = buildEligibilitySource({ userSysId: runner, roleName: role });
  const res = await _run({ body, label: `eligibility ${role}`, marker: GATE_MARKER, timeoutMs, emit });
  const raw = res.payload?.eligibility ?? null;
  const verdict = assessEligibilityVerdict(raw, role, runner);
  return {
    liveness: res.liveness,
    confirmed: res.liveness === LIVENESS.CONFIRMED,
    sentinel: res.sentinel,
    raw,
    detail: res.detail,
    ...verdict,
  };
}

/**
 * The combined PRE-DECISION WI-3 will consume. WI-2 decides; it does not act.
 *
 * decision:
 *   - 'no_elevation_needed' — the op is ungated; proceed without a shim.
 *   - 'elevate'             — gated AND the runner is eligible; WI-3 may invoke
 *                             the shim (behind its approval gate).
 *   - 'refuse'             — gated and the runner is definitively INELIGIBLE.
 *                             Hard stop. No shim call, no downgraded/plain path.
 *   - 'blocked_read_failed' — gated but eligibility could not be confirmed
 *                             (fail-closed). Also no shim call; distinct from a
 *                             definitive refusal so a caller does not tell the
 *                             user they lack a role they may well hold.
 */
export async function preDecision({
  table, operation, runnerUserSysId, emit, timeoutMs, _run = runConfirmedScript,
} = {}) {
  const classification = classifyRequiredRole({ table, operation });
  if (!classification.gated) {
    return {
      op: classification.op,
      gated: false,
      required_role: null,
      eligible: true,
      reason: null,
      decision: 'no_elevation_needed',
      classification,
      precheck: null,
    };
  }

  const precheck = await eligibilityPrecheck({
    runnerUserSysId, requiredRole: classification.required_role, emit, timeoutMs, _run,
  });

  let decision;
  if (!precheck.confirmed) decision = 'blocked_read_failed';
  else if (precheck.eligible) decision = 'elevate';
  else decision = 'refuse';

  return {
    op: classification.op,
    gated: true,
    required_role: classification.required_role,
    eligible: precheck.eligible === true,
    reason: precheck.reason,
    decision,
    classification,
    precheck,
  };
}
