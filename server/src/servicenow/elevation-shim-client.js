import { getSettings } from '../config/store.js';
import { table } from './client.js';
import { preDecision } from './elevation-gate.js';
import { classifyRequiredRole } from './required-role-classifier.js';
import {
  mintNonce, NONCE_FIELD, dispatchElevatedWrite, dispatchAclUnit, assessOutcomeTier,
} from './elevation-shim.js';
import { prepareAclUnit } from './acl-spec.js';
import { log } from '../logging.js';

/**
 * WI-3 — the SHIM CLIENT: the one and only route from an agent op to elevation.
 *
 * The model never calls the shim. It never chooses to elevate. The only path to
 * an elevated write is:
 *
 *   agent op -> mechanical (table,op) derivation -> WI-2 classifier ->
 *   WI-2 eligibility -> APPROVAL -> shim -> read the target back by nonce ->
 *   honest EXECUTED/COERCED/FAILED tier.
 *
 * This module owns that ORDER. `runGatedWrite` will not dispatch the shim until
 * an approval callback has returned approved, and it never dispatches on an
 * ineligible or fail-closed plan. Deny => nothing elevated, nothing written.
 *
 * FAIL-CLOSED. If the eligibility read errors or times out on a gated op, the
 * plan is `blocked_read_failed` and the op is refused — never fail-open.
 *
 * NO UN-ELEVATED REVERT. On a FAILED or COERCED outcome this reports the tier
 * and STOPS. It does not attempt to undo — rollback of a gated op is itself
 * gated (WI-1) and is a separate WI.
 *
 * FORWARD create + update (WI-5), and ACL delete (WI-ACL-1). The classifier gates
 * create/update/delete so all three route through the gate.
 *
 *   - For a plain single-record gated write, create and update are implemented
 *     and delete still returns a structured fail-closed "not implemented":
 *     generic rollback of a gated op is its own WI.
 *   - For an ACL (a descriptor carrying `acl_spec`), all three are implemented,
 *     as an ATOMIC UNIT over `sys_security_acl` + `sys_security_acl_role`. Delete
 *     is not an exception carved out here — it is a first-class ACL operation,
 *     and it has to be, because the only safe response to a half-authored ACL is
 *     removing it through this same elevated channel (an un-elevated delete
 *     silently no-ops — WI-1).
 *
 * Never an un-elevated fallback, on any path.
 *
 * WI-ACL-1 adds one step to the ORDER, and its position is load-bearing: the ACL
 * SPEC is validated against the instance BETWEEN the eligibility plan and the
 * approval card. See `runGatedWrite`.
 */

/** operation names the classifier speaks; describeWrite emits 'insert' for a create. */
const OP_MAP = { insert: 'create', create: 'create', update: 'update', delete: 'delete' };

/**
 * Derive `(table, operation)` from a tool's own `describeWrite` descriptor.
 * MECHANICAL — a fixed map, no LLM, no interpretation. Same descriptor, same op.
 */
export function deriveElevationOp(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return null;
  const table = String(descriptor.table ?? '');
  const operation = OP_MAP[String(descriptor.operation ?? '')] ?? null;
  if (!/^[a-z0-9_]+$/i.test(table) || !operation) return null;
  return { table, operation };
}

/** Is this descriptor's op gated? Pure, offline — the classifier decides. */
export function isGatedDescriptor(descriptor) {
  const op = deriveElevationOp(descriptor);
  if (!op) return false;
  try { return classifyRequiredRole(op).gated === true; } catch { return false; }
}

let cachedRunner = null;
/**
 * The runner is the identity NHA authenticates as — the account whose dormant
 * `security_admin` the shim activates. Resolved from the configured username,
 * cached. On this PDI that is `admin` (holds security_admin dormantly).
 * `[A-runner]`: a dedicated non-admin integration user is the production shape
 * and does not exist here.
 */
export async function resolveRunnerSysId({ force = false } = {}) {
  if (cachedRunner && !force) return cachedRunner;
  const username = getSettings().connection?.username;
  if (!username) throw new Error('No ServiceNow username is configured, so the elevation runner cannot be resolved.');
  const rows = await table.query('sys_user', { query: `user_name=${username}`, fields: 'sys_id,user_name', limit: 1, display: 'false' });
  const sysId = rows[0]?.sys_id;
  if (!/^[0-9a-f]{32}$/i.test(String(sysId || ''))) {
    throw new Error(`The configured user "${username}" did not resolve to a sys_user sys_id, so the elevation runner is unknown.`);
  }
  cachedRunner = String(sysId).toLowerCase();
  return cachedRunner;
}
export function _resetRunnerCache() { cachedRunner = null; }

/**
 * Plan the elevation for one op: mechanical derive -> WI-2 preDecision. Never
 * throws — a read error is caught and returned as a fail-closed plan, so a gated
 * op can never slip through on an exception.
 */
export async function planElevation({ descriptor, runnerUserSysId, emit, timeoutMs, _preDecision = preDecision } = {}) {
  const op = deriveElevationOp(descriptor);
  if (!op) return { gated: false, decision: 'no_elevation_needed', op: null, requiredRole: null, eligibility: null, reason: 'no (table, op) could be derived' };
  try {
    const d = await _preDecision({ table: op.table, operation: op.operation, runnerUserSysId, emit, timeoutMs });
    return {
      gated: d.gated,
      decision: d.decision,
      op: d.op,
      requiredRole: d.required_role,
      eligibility: d.precheck ?? null,
      reason: d.reason,
    };
  } catch (err) {
    // FAIL-CLOSED. A gated op whose eligibility could not be read is refused.
    log.error('elevation', `eligibility read failed for ${op.table}.${op.operation}: ${err.message}`);
    return {
      gated: true, decision: 'blocked_read_failed', op,
      requiredRole: (classifyRequiredRole(op).required_role) || null,
      eligibility: null, reason: `eligibility_read_failed: ${err.message}`,
    };
  }
}

/**
 * The approval card enrichment — what the human must see BEFORE any elevation.
 * Names the op, target, the role it will elevate, that it WILL elevate, and the
 * eligibility verdict.
 */
export function buildElevationApprovalPayload({ plan, descriptor, aclUnit = null }) {
  const payload = {
    kind: 'role_elevation',
    high_risk: true,
    op: plan.op,
    target: { table: descriptor?.table ?? plan.op?.table ?? null, sys_id: descriptor?.sys_id ?? null },
    required_role: plan.requiredRole,
    will_elevate: true,
    eligibility: plan.eligibility
      ? { eligible: plan.eligibility.eligible, branch: plan.eligibility.branch, runner_assigned: plan.eligibility.runner_assigned, role_is_elevated_privilege: plan.eligibility.role_is_elevated_privilege }
      : null,
    note: `This will elevate ${plan.requiredRole} and author a ${plan.op?.operation} on ${plan.op?.table} through the secure API. Approving authorises the elevation.`,
  };

  /*
   * WI-ACL-1 — an ACL card must show the RULE, not the row.
   *
   * `sys_security_acl` field values do not tell a human what they are agreeing
   * to: the role requirement is not even on this table, and `operation` can be a
   * bare sys_id. So the card carries the resolved summary — which object, which
   * operation, which roles BY NAME, whether it will be active, and what the
   * conditions are — because "approve a write to sys_security_acl" is not
   * informed consent to "deny everyone without itil read access to incident".
   */
  if (aclUnit) {
    payload.acl = {
      unit: 'acl_and_role_links',
      atomic: true,
      ...aclUnit.summary,
      role_links: aclUnit.roleSysIds.length,
      note: aclUnit.operation === 'delete'
        ? 'This DELETES the ACL and every role link on it, through the elevated channel. Access that this rule granted will stop being granted.'
        : `This authors the ACL and its ${aclUnit.roleSysIds.length} role link(s) as ONE atomic unit — if the role links do not land, the ACL is rolled back rather than left role-less (a role-less ACL with no other condition is empty, and an empty ACL denies everyone).`,
    };
    payload.note = `${payload.note} ${payload.acl.note}`;
  }
  return payload;
}

/**
 * The nonce-tagged payload for a create: the requested fields plus the nonce in
 * the read-back field, so NHA can find the record it just wrote.
 */
export function buildTaggedCreatePayload({ requested, nonce, nonceField = NONCE_FIELD }) {
  const base = { ...(requested || {}) };
  const existing = base[nonceField] ? `${base[nonceField]} ` : '';
  base[nonceField] = `${existing}[nha-elev:${nonce}]`;
  return base;
}

/**
 * Execute one approved gated write and tier it off the target read-back.
 *
 * FORWARD create + update (WI-5). Delete returns a fail-closed "not implemented"
 * — rollback of a gated op is itself gated and is a separate WI. NEVER reverts on
 * failure, whatever the tier.
 *
 *   create — tag the payload with the nonce in the read-back field, dispatch,
 *            read the target back by nonce.
 *   update — dispatch a GlideRecordSecure.get(sys_id) → setValue → update, read
 *            the target back BY SYS_ID (the sys_id is already known; no tag),
 *            using a sys_mod_count increment as the "job ran" signal so a coerced
 *            field reads back as COERCED rather than timing out as FAILED.
 */
export async function executeGatedWrite({
  descriptor, runnerUserSysId, requiredRole, nonce, platformOwned = [NONCE_FIELD],
  aclUnit = null, emit = () => {}, _dispatch = dispatchElevatedWrite, _dispatchAclUnit = dispatchAclUnit,
} = {}) {
  const op = deriveElevationOp(descriptor);

  /*
   * WI-ACL-1 — an ACL goes through the ATOMIC UNIT path, never the single-record
   * one. Everything it needs was resolved and validated before approval, so this
   * is dispatch only: no decisions are taken here.
   */
  if (aclUnit) {
    const r = await _dispatchAclUnit({
      role: requiredRole, runnerUserSysId, operation: aclUnit.operation,
      payload: aclUnit.payload, roleSysIds: aclUnit.roleSysIds, sysId: aclUnit.sysId, nonce,
      beforeModCount: aclUnit.beforeModCount, beforeRoleSysIds: aclUnit.beforeRoleSysIds,
      conditionSources: aclUnit.conditionSources, platformOwned, emit,
    });
    return {
      wrote: r.outcome?.tier === 'EXECUTED',
      elevated_path: true, ingestionTier: 'elevated-path',
      outcome: r.outcome, actual: r.actual ?? null, job: r.job, dispatched: r.dispatched,
      aclUnit,
    };
  }

  if (op?.operation === 'create') {
    const payload = buildTaggedCreatePayload({ requested: descriptor.requested, nonce });
    const r = await _dispatch({
      role: requiredRole, runnerUserSysId, table: op.table, operation: 'create', payload, nonce,
      name: payload.name ?? null, platformOwned, emit,
    });
    return { wrote: r.outcome?.landed === true, elevated_path: true, ingestionTier: 'elevated-path', outcome: r.outcome, actual: r.actual ?? null, job: r.job, dispatched: r.dispatched };
  }

  if (op?.operation === 'update') {
    if (!/^[0-9a-f]{32}$/i.test(String(descriptor.sys_id || ''))) {
      // Fail-closed: an update with no target sys_id has nothing to elevate onto.
      return { wrote: false, elevated_path: true, outcome: { tier: 'FAILED', landed: false, sys_id: null, mismatches: [], coerced: [], detail: 'update has no target sys_id — nothing to update, no write attempted' }, not_implemented: false };
    }
    const r = await _dispatch({
      role: requiredRole, runnerUserSysId, table: op.table, operation: 'update',
      payload: descriptor.requested || {}, sysId: descriptor.sys_id, nonce, platformOwned, emit,
    });
    return { wrote: r.outcome?.landed === true, elevated_path: true, ingestionTier: 'elevated-path', outcome: r.outcome, actual: r.actual ?? null, job: r.job, dispatched: r.dispatched };
  }

  // delete — rollback is a separate WI. Fail-closed, no un-elevated fallback.
  return {
    wrote: false, elevated_path: true,
    outcome: { tier: 'FAILED', landed: false, sys_id: null, mismatches: [], coerced: [], detail: `elevated ${op?.operation ?? 'op'} is not implemented (forward create + update only; delete/rollback is a separate WI)` },
    not_implemented: true,
  };
}

/**
 * The full gated pipeline for one op. `requestApproval(payload)` must return
 * `{ approved: bool, source, at }`. This enforces the ORDER: refuse before any
 * approval on an ineligible/fail-closed plan; on an eligible plan, ask for
 * approval BEFORE dispatch; deny => no shim; approve => shim once, then tier.
 *
 * Returns a single structured object the caller audits and renders. It performs
 * NO revert on any failure path.
 */
export async function runGatedWrite({
  descriptor, runnerUserSysId, requestApproval, emit = () => {},
  _preDecision = preDecision, _dispatch = dispatchElevatedWrite,
  _prepareAclUnit = prepareAclUnit, _dispatchAclUnit = dispatchAclUnit,
} = {}) {
  const plan = await planElevation({ descriptor, runnerUserSysId, emit, _preDecision });

  if (!plan.gated) return { gated: false, plan };

  if (plan.decision !== 'elevate') {
    // refuse or blocked_read_failed — no approval requested, no shim, no fallback.
    return {
      gated: true, decision: plan.decision, plan,
      approved: false, wrote: false, elevated: false,
      outcome: { tier: 'FAILED', landed: false, detail: plan.reason },
      refused: true,
    };
  }

  if (typeof requestApproval !== 'function') {
    throw new Error('runGatedWrite needs a requestApproval callback: a gated write may not proceed without an approval decision.');
  }
  const nonce = mintNonce();

  /*
   * WI-ACL-1 — SPEC VALIDATION, and its position in this function is the point.
   *
   * It sits AFTER the eligibility plan and BEFORE `requestApproval`. An ACL spec
   * that would author an empty or invalid rule, name an unresolvable role, sit on
   * a scoped table, or change nothing at all is refused HERE — so no human is
   * ever shown a card for a write that was already going to be refused. Spending
   * an approval on a decision that was never real is the WI-3 lesson, and this is
   * the same lesson one layer in.
   *
   * It is also the last point at which refusing is free. After approval, refusing
   * means an approved operation that did nothing, which reads to a user exactly
   * like a silent failure.
   */
  let aclUnit = null;
  if (descriptor?.acl_spec) {
    const prep = await _prepareAclUnit({
      operation: plan.op.operation, spec: descriptor.acl_spec, sysId: descriptor.sys_id ?? null, nonce, emit,
    }).catch((err) => ({ ok: false, refusal: { reason: 'spec_check_failed', message: `The ACL specification could not be checked against the instance (${err.message}), so it is refused rather than authored unverified.`, detail: null } }));

    if (!prep.ok) {
      return {
        gated: true, decision: 'refused_spec', plan,
        approved: false, wrote: false, elevated: false,
        specRefusal: prep.refusal,
        outcome: { tier: 'FAILED', landed: false, detail: prep.refusal.message },
        refused: true,
      };
    }
    aclUnit = prep.unit;
  }

  const approvalPayload = buildElevationApprovalPayload({ plan, descriptor, aclUnit });
  const decision = await requestApproval(approvalPayload);

  if (!decision || decision.approved !== true) {
    // Deny => nothing elevated, nothing written. The shim is never called.
    return {
      gated: true, decision: 'denied', plan, approvalPayload,
      approved: false, wrote: false, elevated: false,
      outcome: { tier: 'FAILED', landed: false, detail: 'the user did not approve the elevation; nothing was elevated or written' },
      approvalSource: decision?.source ?? null,
    };
  }

  // Approved — and only now — the shim runs once.
  const exec = await executeGatedWrite({
    descriptor, runnerUserSysId, requiredRole: plan.requiredRole, nonce, aclUnit, emit, _dispatch, _dispatchAclUnit,
  });
  return {
    gated: true, decision: 'elevate', plan, approvalPayload,
    approved: true, approvalSource: decision.source ?? null, approvalAt: decision.at ?? null,
    nonce, elevated: exec.wrote === true || exec.outcome?.landed === true,
    wrote: exec.wrote, outcome: exec.outcome, actual: exec.actual ?? null,
    ingestionTier: exec.ingestionTier ?? null, job: exec.job ?? null,
    not_implemented: exec.not_implemented === true,
    aclUnit: exec.aclUnit ?? null,
  };
}
