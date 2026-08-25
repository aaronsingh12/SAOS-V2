import { runImpersonated } from '../servicenow/impersonation.js';
import { LIVENESS } from '../servicenow/script-liveness.js';
import { getMode } from '../memory/impersonation-mode.js';
import {
  recordWriteIntent, confirmWriteIntent, abortWriteIntent, AUDIT_STATUS,
} from '../memory/impersonation-audit.js';
import { classifyDenial, denialSentence } from './impersonation-render.js';
import { log } from '../logging.js';

/**
 * B7 — the missing caller.
 *
 * B1 built the wrapper, B5 built provenance, B6 built the honest chip, and none
 * of them had a write path to act on: `runImpersonated` had no write mode and no
 * mutating tool routed through it. This is that path, and it is the highest-risk
 * operation in the feature — a mutation that persists on a real instance,
 * attributed to a real person, with every measured trap live at once.
 *
 * THE ORDER IS THE DESIGN:
 *
 *   1. INTENT is recorded before the instance is touched. A crash after this
 *      point leaves a row with no change (untidy); recording afterwards would
 *      risk a change with no row (unanswerable). Provenance is the thing that
 *      must not be lost, so it is written first.
 *   2. The wrapper asks the operation's OWN capability flag and does not
 *      dispatch a write it will refuse. Nothing throws on denial here, so a
 *      write that was never going to land has to be decided about in advance.
 *   3. On success the write is read back twice — as the target (can they see
 *      what they did?) and as admin (what does the instance say they did?) —
 *      and the intent is CONFIRMED with what the instance actually stamped
 *      rather than with what we intended it to stamp.
 *   4. A refusal ABORTS the intent. "We decided not to" and "we do not know
 *      whether it happened" are different facts and never share a state.
 */

/** Should this call go through the impersonation wrapper at all? */
export function willExecuteImpersonated(sessionId, tool) {
  if (!tool?.impersonable) return false;
  try { return getMode(sessionId).active; } catch { return false; }
}

/**
 * Run one mutating operation as the impersonated user.
 *
 * Returns a result shaped for a tool: the instance's answer plus an explicit
 * account of what identity it executed under and whether provenance was
 * recorded. Never silently falls back to writing as the service account — a
 * degraded path that quietly changed whose name lands on a record would be the
 * worst possible failure of this feature.
 */
export async function runImpersonatedWrite({
  sessionId, turnSeq, tool, table, sysId = null, operation, data = {},
} = {}) {
  const mode = getMode(sessionId);
  if (!mode.active) throw new Error('runImpersonatedWrite called with no impersonation mode active.');

  // 1 — INTENT, before the instance is touched.
  const intent = recordWriteIntent({
    sessionId, turnSeq, tool, table, sysId, operation, requested: data,
  });
  if (!intent.recorded) {
    /*
     * Refuse rather than proceed. An impersonated write whose provenance could
     * not be recorded is exactly the record nobody can later account for, and
     * the instance keeps no account of its own (Phase 0 D-3/D-4/D-5).
     */
    log.error('impersonation', `refusing an impersonated ${operation}: provenance could not be recorded — ${intent.reason}`);
    return {
      ok: false,
      executed_impersonated: false,
      dispatched: false,
      reason: 'provenance_unavailable',
      message: 'Refused: the impersonation audit row could not be written, and this instance keeps no record of the '
        + `real initiator behind an impersonated change. Reason: ${intent.reason}`,
    };
  }
  const auditId = intent.id;

  // 2 — dispatch through the wrapper (pre-flight inside, one bounded execution).
  let run;
  try {
    run = await runImpersonated({
      adminSysId: mode.original.sys_id,
      targetSysId: mode.target.sys_id,
      op: { mode: operation, table, sys_id: sysId, data },
      label: `impersonated ${operation} ${table}`,
    });
  } catch (err) {
    // The intent stays unresolved on purpose: we do not know whether anything
    // reached the instance, and saying "aborted" would claim we did.
    log.error('impersonation', `impersonated ${operation} failed to dispatch cleanly: ${err.message}`);
    return {
      ok: false, executed_impersonated: true, dispatched: 'unknown', audit_id: auditId,
      reason: 'dispatch_error',
      message: `The impersonated ${operation} could not be completed: ${err.message}. Provenance row ${auditId} is `
        + 'recorded as INTENT and left unconfirmed — the change may or may not have landed. Read the record.',
    };
  }

  if (run.liveness !== LIVENESS.CONFIRMED) {
    const detail = `${run.liveness}${run.detail ? ` — ${run.detail}` : ''}`;
    if (run.liveness === LIVENESS.REJECTED_PRE_DISPATCH) {
      // Nothing was sent, so nothing can have happened.
      abortWriteIntent(auditId, `not dispatched: ${detail}`);
      return {
        ok: false, executed_impersonated: false, dispatched: false, audit_id: auditId,
        reason: 'rejected_pre_dispatch', message: detail,
      };
    }
    return {
      ok: false, executed_impersonated: true, dispatched: 'unknown', audit_id: auditId,
      reason: run.liveness.toLowerCase(),
      message: `${detail}. Provenance row ${auditId} is recorded as INTENT and left unconfirmed — the change may or `
        + 'may not have landed. Read the record.',
    };
  }

  const payload = run.payload ?? {};
  const result = payload.result ?? {};
  const preflight = payload.preflight ?? null;
  // The same table's flags as admin, captured before the switch (B7).
  const adminPreflight = payload.preflight_admin ?? null;

  // 3 — a refusal the wrapper decided in advance: nothing was written.
  if (result.dispatched === false) {
    const verdict = denialSentence({ preflight, adminPreflight, operation, target: mode.target });
    abortWriteIntent(auditId, result.reason ?? 'refused');
    return {
      ok: false,
      executed_impersonated: true,
      dispatched: false,
      audit_id: auditId,
      reason: result.reason ?? 'refused',
      preflight,
      preflight_admin: adminPreflight,
      denial: { layer: verdict.layer, label: verdict.label, sentence: verdict.sentence, detail: verdict.detail },
      identity: payload.identity ?? null,
      message: result.reason === 'target_cannot_see_record'
        ? `${mode.target.user_name} cannot see ${table} ${sysId}, so there was nothing to ${operation}. `
          + 'Nothing was written.'
        : verdict.sentence ?? 'The operation was refused before it was attempted.',
    };
  }

  // 4 — it landed. CONFIRM with what the instance says, not what we intended.
  const attribution = payload.attribution ?? null;
  const attributed = attribution?.found
    ? (operation === 'create' ? attribution.sys_created_by : attribution.sys_updated_by)
    : null;

  const confirmation = confirmWriteIntent(auditId, {
    sysId: result.sys_id ?? sysId,
    verificationStatus: attribution?.found === false && operation !== 'delete' ? 'unverified' : 'applied',
    attributedUserName: attributed,
  });
  if (!confirmation.confirmed) {
    log.error('impersonation', `write landed but provenance could not be confirmed: ${confirmation.reason}`);
  }

  /*
   * Does the instance agree with us about who did it? Asked rather than
   * assumed. A mismatch would mean the impersonation did not actually take for
   * the write, and that is worth surfacing loudly rather than recording quietly.
   */
  const attributionMatches = attributed == null ? null : attributed === mode.target.user_name;
  if (attributionMatches === false) {
    log.error('impersonation',
      `ATTRIBUTION MISMATCH on ${table} ${result.sys_id}: expected ${mode.target.user_name}, instance says ${attributed}`);
  }

  const targetCanSee = result.readback_as_target?.found ?? null;

  return {
    ok: true,
    executed_impersonated: true,
    dispatched: true,
    audit_id: auditId,
    provenance_confirmed: confirmation.confirmed,
    table,
    sys_id: result.sys_id ?? sysId,
    operation,
    identity: payload.identity ?? null,
    preflight,
    preflight_admin: adminPreflight,
    instance_attribution: attributed,
    attribution_matches_target: attributionMatches,
    target_can_read_result: targetCanSee,
    // The measured middle state, named where a reader will see it.
    ...(targetCanSee === false && operation !== 'delete'
      ? {
        note: `The ${operation} landed and is attributed to ${mode.target.user_name}, but they cannot READ this `
          + 'table — so they cannot see what was just done in their name. Verified by reading it back as '
          + 'NowHelpAssist instead.',
      }
      : {}),
  };
}

/**
 * The routing decision, in one place.
 *
 * A mutating tool calls this instead of writing directly. When impersonation
 * mode is active the write goes through the wrapper and lands as the target;
 * otherwise it takes its ordinary path unchanged. There is no third outcome —
 * in particular there is no fallback that quietly writes as the service account
 * when impersonation fails, because that would change whose name ends up on the
 * record without anyone being told.
 */
export async function writeAsCurrentIdentity({
  ctx = {}, tool, table, sysId = null, operation, data = {}, direct,
} = {}) {
  const sessionId = ctx.sessionId;
  const impersonating = sessionId ? getMode(sessionId).active : false;
  if (!impersonating) return direct();

  return runImpersonatedWrite({
    sessionId, turnSeq: ctx.turnSeq, tool, table, sysId, operation, data,
  });
}

export { AUDIT_STATUS };
