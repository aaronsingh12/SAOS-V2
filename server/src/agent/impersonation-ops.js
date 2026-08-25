import { resolveHarnessIdentity } from '../servicenow/impersonation.js';
import {
  evaluateEligibility, discoverImpersonationTarget, VERDICT, DISCOVERY,
} from '../servicenow/impersonation-target.js';
import {
  startMode, endMode, switchTarget, getMode, impFacts, impersonationBoundaryLine,
} from '../memory/impersonation-mode.js';

/**
 * B3 — the four operations that manage impersonation mode.
 *
 * These compose the earlier phases rather than re-deciding anything:
 * B2 says who is eligible, B1 says what the instance actually reports, and the
 * mode table holds the answer between turns.
 *
 * WHAT "MODE" IS, EXACTLY. Under M1 there is no persistent ServiceNow session —
 * each wrapper execution impersonates, acts and reverts inside one bounded job.
 * So starting mode changes nothing on the instance. It records which target the
 * NEXT execution will stamp. Saying it any other way would invite a reader to
 * believe a session is sitting open somewhere, and none is.
 *
 * WHY START IS `mutating: true` AND END IS NOT. Start escalates: it decides
 * whose authority subsequent instructions carry. End de-escalates, and gating
 * de-escalation only makes it likelier that someone stays impersonating because
 * dismissing a dialog was easier.
 */

const SYS_ID_RE = /^[0-9a-f]{32}$/i;

/**
 * The real actor and the live truth about this execution context, read fresh.
 *
 * ADMIN_SYS_ID is a PARAMETER (never a literal) and this is the only sanctioned
 * way to obtain it.
 */
async function realActor() {
  const id = await resolveHarnessIdentity();
  return { sys_id: id.user, user_name: id.name, has_admin: id.has_admin, session: id.session };
}

/**
 * The actor resolver, injectable.
 *
 * Defaults to the live probe. Overridable so the mode logic can be exercised
 * without standing up a harness execution per assertion — the same reason B2's
 * integration account is a parameter. Nothing in production passes it.
 */
const actorVia = (override) => (typeof override === 'function' ? override : realActor);

/**
 * Turn what a human typed into exactly one target, or refuse.
 *
 * A bare sys_id is taken as-is and re-verified by the gate; anything else goes
 * through discovery, which never auto-picks on a multi-match.
 */
async function resolveTarget(user) {
  const term = String(user ?? '').trim();
  if (!term) return { ok: false, refusal: { status: 'refused', reason: 'no_target', message: 'Name the user to impersonate.' } };
  if (SYS_ID_RE.test(term)) return { ok: true, sysId: term, via: 'sys_id' };

  const found = await discoverImpersonationTarget(term);
  if (found.status === DISCOVERY.NOT_FOUND) {
    return {
      ok: false,
      refusal: {
        status: 'refused', reason: 'user_not_found',
        message: `No user matches "${term}".`,
        candidates: [],
      },
    };
  }
  if (found.status === DISCOVERY.AMBIGUOUS) {
    return {
      ok: false,
      refusal: {
        status: 'needs_disambiguation', reason: 'ambiguous_target',
        message: found.message,
        candidates: found.candidates,
        next: 'Ask the user which of these they mean, then call again with that sys_id. Do not pick one.',
      },
    };
  }
  return { ok: true, sysId: found.resolved.sys_id, via: 'discovery', resolved: found.resolved };
}

/**
 * Run the gate and translate its verdict into a start/switch decision.
 *
 * The SOFT_DENY branch is the interesting one. `elevatedApproval` is NOT the
 * authorisation — the human's click on the approval card is, and the card shows
 * this whole input, so a model that sets the flag by itself has published that
 * fact to the person being asked rather than hidden it. The flag's job is to
 * make an admin target impossible to approve *inattentively*; `executeTool`
 * still refuses anything without a user_click-attributed approval.
 */
async function gateFor({ sysId, actor, elevatedApproval }) {
  const eligibility = await evaluateEligibility({ sysId, adminSysId: actor.sys_id });

  if (eligibility.verdict === VERDICT.DENY) {
    return {
      ok: false,
      refusal: {
        status: 'refused', reason: eligibility.reason, message: eligibility.detail,
        target: eligibility.target, checks: eligibility.checks,
      },
    };
  }

  if (eligibility.verdict === VERDICT.SOFT_DENY) {
    if (elevatedApproval !== true) {
      return {
        ok: false,
        refusal: {
          status: 'refused', reason: eligibility.reason, message: eligibility.detail,
          target: eligibility.target,
          requiresElevatedApproval: true,
          next: `${eligibility.target.user_name} holds the admin role. Tell the user that plainly, and only if they `
            + 'explicitly confirm they want to impersonate an administrator, call again with elevated_approval: true. '
            + 'The approval card will show that flag, so they can see what they are agreeing to.',
        },
      };
    }
    return { ok: true, eligibility, elevated: true };
  }

  return { ok: true, eligibility, elevated: false };
}

/** Everything a caller (and B6's renderer) needs about the resulting state. */
function stateReport(sessionId, extra = {}) {
  return {
    ...extra,
    mode: getMode(sessionId),
    facts: impFacts(sessionId),
    boundary: impersonationBoundaryLine(sessionId),
  };
}

/**
 * Begin impersonating. Gated: this is the operation that escalates.
 */
export async function startImpersonation({ sessionId, user, task, elevatedApproval, actorResolver } = {}) {
  if (!sessionId) throw new Error('impersonation_start needs a session.');
  if (!String(task ?? '').trim()) {
    return {
      status: 'refused', reason: 'no_task',
      message: 'Describe what this impersonation is for. The task descriptor is what lets NowHelpAssist notice '
        + 'later that a new request has wandered outside it, instead of silently carrying someone else\'s authority '
        + 'into unrelated work.',
    };
  }

  const actor = await actorVia(actorResolver)();
  const target = await resolveTarget(user);
  if (!target.ok) return target.refusal;

  const gate = await gateFor({ sysId: target.sysId, actor, elevatedApproval });
  if (!gate.ok) return gate.refusal;

  const t = gate.eligibility.target;
  startMode({
    sessionId,
    target: { sys_id: t.sys_id, user_name: t.user_name, display: t.display },
    original: { sys_id: actor.sys_id, user_name: actor.user_name },
    task: String(task).trim(),
  });

  return stateReport(sessionId, {
    status: 'started',
    elevated: gate.elevated,
    note: 'No ServiceNow session is now open. Under M1 each execution impersonates and reverts inside one '
      + 'bounded job; this records which target the next execution will stamp.',
  });
}

/**
 * Re-target. Same gate as start, and the real actor is never rewritten.
 */
export async function switchImpersonation({ sessionId, user, task, elevatedApproval, actorResolver } = {}) {
  if (!sessionId) throw new Error('impersonation_switch needs a session.');
  const before = getMode(sessionId);

  const actor = await actorVia(actorResolver)();
  const target = await resolveTarget(user);
  if (!target.ok) return target.refusal;

  const gate = await gateFor({ sysId: target.sysId, actor, elevatedApproval });
  if (!gate.ok) return gate.refusal;

  const t = gate.eligibility.target;
  switchTarget({
    sessionId,
    target: { sys_id: t.sys_id, user_name: t.user_name, display: t.display },
    task: task ? String(task).trim() : undefined,
    original: { sys_id: actor.sys_id, user_name: actor.user_name },
  });

  return stateReport(sessionId, {
    status: 'switched',
    elevated: gate.elevated,
    previousTarget: before.active ? before.target : null,
  });
}

/**
 * End impersonation, and VERIFY rather than assume.
 *
 * The verification is a live `gs.getUserID()` probe, never `isImpersonating()`:
 * Phase 0 measured that predicate to be a constant `true` before, during and
 * after, so branching on it would be branching on a literal.
 */
export async function endImpersonation({ sessionId, actorResolver } = {}) {
  if (!sessionId) throw new Error('impersonation_end needs a session.');
  const result = endMode(sessionId);

  let verification = null;
  try {
    const actor = await actorVia(actorResolver)();
    verification = {
      probed: true,
      effective_user_sys_id: actor.sys_id,
      effective_user_name: actor.user_name,
      has_admin: actor.has_admin,
      note: 'Read from gs.getUserID() on a fresh execution. isImpersonating() is not consulted — Phase 0 '
        + 'measured it as a constant true in this context.',
    };
  } catch (err) {
    verification = { probed: false, error: String(err.message ?? err) };
  }

  return stateReport(sessionId, {
    status: result.ended ? 'ended' : 'already_inactive',
    previous: result.previous,
    verification,
  });
}

/**
 * Report mode. `probe` costs one bounded execution, so it is opt-in.
 *
 * Reports NHA state and, when asked, what the instance says the effective user
 * is. It never reports `isImpersonating()` — a constant here, and printing it
 * would be printing a literal dressed as a measurement.
 */
export async function impersonationStatus({ sessionId, probe = false, actorResolver } = {}) {
  if (!sessionId) throw new Error('impersonation_status needs a session.');
  const base = stateReport(sessionId, { status: 'ok' });
  if (!probe) {
    return { ...base, live: null, note: 'Pass probe: true to additionally read gs.getUserID() off the instance.' };
  }
  try {
    const actor = await actorVia(actorResolver)();
    return {
      ...base,
      live: {
        effective_user_sys_id: actor.sys_id,
        effective_user_name: actor.user_name,
        has_admin: actor.has_admin,
        harness_session: actor.session,
        note: 'Between executions the harness identity is always the real actor — impersonation lives inside a '
          + 'single execution, so this reads the executor even while mode is active. That is the mechanism '
          + 'working, not mode being lost.',
      },
    };
  } catch (err) {
    return { ...base, live: { error: String(err.message ?? err) } };
  }
}
