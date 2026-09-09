import { log, shortId } from '../../logging.js';
import { buildEvidence } from '../evidence/index.js';
import {
  loadPlan, getStepByPlanId, setStepState, setPlanState,
  recordRecoveryAttempt, recoveryHistory, checkApprovalBinding,
  reopenStepForRecovery,
} from '../plan/index.js';
import { decideRecovery, historyFrom, DECISIONS, LIMITS } from './decision.js';
import { reconcileIntent, RECONCILIATION } from './reconcile.js';
import { isAutoRetryable } from './idempotency.js';

/**
 * PHASE 6 — THE RECOVERY EXECUTOR. An orchestrator, not an engine.
 *
 * WHAT IT DOES: reads the durable evidence, asks the deterministic decision
 * layer what is permitted, records the decision on the step's lineage, and —
 * only for the one decision that permits it — hands the identical operation
 * back to the EXISTING plan executor.
 *
 * WHAT IT CANNOT DO, structurally. It imports no ServiceNow client, no
 * execution harness, no SDK, no elevation shim, and no database write beyond
 * the plan store's own lineage recorder. It cannot approve anything: producing
 * `RETRY` is a proposal that the existing gate, write guards, provenance and
 * read-back verifier all still stand between. There is no path from this file
 * to a write that does not pass through them.
 *
 * THE THREE THINGS IT REFUSES TO DO
 *
 *   It never repeats a mutation before establishing whether the effect is
 *   already present — a timeout on a create is the case that makes duplicates.
 *
 *   It never changes a payload and calls it a retry. A changed operation is a
 *   re-plan, which produces a new fingerprint and needs a new approval.
 *
 *   It never reports recovery as successful on the strength of execution. The
 *   existing verifier decides that, exactly as it does on the first attempt.
 */

/** How a recovery attempt turned out. Closed, and none of these means "probably". */
export const OUTCOME = Object.freeze({
  RECOVERED: 'RECOVERED',           // re-executed AND verified
  NOT_RECOVERED: 'NOT_RECOVERED',   // re-executed and did not verify
  ALREADY_SATISFIED: 'ALREADY_SATISFIED',
  STOPPED: 'STOPPED',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  MANUAL: 'MANUAL',
});

/**
 * Consider recovery for a failed step, and carry out whatever is permitted.
 *
 * `executeStep` is injected — it is the existing plan executor's single-step
 * path, passed in rather than imported, so this module has no way to reach a
 * write except through what the caller gives it. That is the architecture
 * boundary made structural rather than documented.
 */
export async function recoverStep({
  taskId,
  stepId,
  sessionId,
  error = null,
  capability = null,
  descriptor = null,
  signal = null,
  emit = () => {},
  executeStep = null,
  readRecord = null,
} = {}) {
  const cancelled = () => Boolean(signal?.aborted);

  const evidence = buildEvidence(taskId);
  if (!evidence) return { outcome: OUTCOME.STOPPED, reason: 'no_such_task' };

  const plan = loadPlan(taskId);
  const step = getStepByPlanId(taskId, stepId);
  if (!step) return { outcome: OUTCOME.STOPPED, reason: 'no_such_step' };

  const history = historyFrom({ recovery: recoveryHistory(taskId, stepId) });

  /*
   * PHASE 0, HONOURED NOT RE-IMPLEMENTED.
   *
   * A cancelled run starts no new recovery attempt. This is the only
   * cancellation check in this file, and it sits at a boundary — nothing here
   * reaches inside a mutation window, which stays exactly as Phase 0 left it.
   */
  if (cancelled()) {
    const d = { decision: DECISIONS.STOP, reason: 'cancelled: no recovery attempt is started after a cancellation' };
    recordRecoveryAttempt(taskId, stepId, { attempt: history.attempts, ...d, outcome: OUTCOME.STOPPED });
    emit({ type: 'recovery_stopped', step: stepId, reason: 'cancelled' });
    return { outcome: OUTCOME.STOPPED, reason: 'cancelled', decision: d };
  }

  /*
   * RECONCILE BEFORE DECIDING, where the operation may already have landed.
   *
   * The read goes through `readRecord`, which the caller supplies from the
   * existing read path — this module performs no I/O of its own. A caller that
   * supplies none simply gets no reconciliation, and the decision layer then
   * refuses to repeat anything rather than assuming.
   */
  let reconciliation = null;
  if (descriptor && readRecord && String(descriptor.operation ?? '').toLowerCase() !== 'create') {
    try {
      const current = await readRecord({ table: descriptor.table, sys_id: descriptor.sys_id });
      reconciliation = reconcileIntent({ descriptor, current });
    } catch (err) {
      // A failed read is not a licence to proceed: it leaves the effect
      // unestablished, which the decision layer treats as a stop.
      reconciliation = { status: RECONCILIATION.UNKNOWN, reason: `the record could not be read back: ${err.message}` };
    }
  }

  const decision = decideRecovery({
    evidence, stepId, descriptor, capability, error, reconciliation, history,
    cancelled: cancelled(),
  });

  log.info('recovery',
    `${shortId(taskId)}/${stepId}: ${decision.failure.kind} -> ${decision.decision} `
    + `(attempt ${decision.attempt}/${decision.max_attempts}, ${decision.idempotency})`);
  emit({
    type: 'recovery_decision',
    step: stepId,
    failure: decision.failure.kind,
    decision: decision.decision,
    reason: decision.reason,
    attempt: decision.attempt,
    maxAttempts: decision.max_attempts,
    idempotency: decision.idempotency,
    approvalRequired: decision.approval_required,
  });

  /* ---- Everything that is not a retry is recorded and stops here. ---- */
  if (decision.decision !== DECISIONS.RETRY) {
    const outcome = decision.decision === DECISIONS.WAIT_FOR_APPROVAL ? OUTCOME.AWAITING_APPROVAL
      : decision.decision === DECISIONS.MANUAL_INTERVENTION ? OUTCOME.MANUAL
        : decision.reason?.startsWith('already_satisfied') ? OUTCOME.ALREADY_SATISFIED
          : OUTCOME.STOPPED;
    recordRecoveryAttempt(taskId, stepId, {
      attempt: decision.attempt,
      failureKind: decision.failure.kind,
      decision: decision.decision,
      reason: decision.reason,
      idempotency: decision.idempotency,
      approvalRequired: decision.approval_required,
      outcome,
    });
    /*
     * A re-plan does NOT execute here. It is reported so the caller can run the
     * existing planner, whose output goes through validation, a new fingerprint,
     * review and approval like any other plan. Executing it from inside recovery
     * would be exactly the silent path Phase 4 forbids.
     */
    return { outcome, reason: decision.reason, decision };
  }

  /* ---- RETRY. Permitted, bounded, and identical. ---- */

  /*
   * THE SAME QUESTION, ASKED AGAIN AT THE EXECUTION BOUNDARY.
   *
   * `decideRecovery` already refuses to produce RETRY for anything outside the
   * auto-retryable classes, so reaching this line with a NON_IDEMPOTENT or
   * UNKNOWN class means the decision layer has a bug. This re-reads the
   * decision's OWN recorded class rather than re-deriving it — it duplicates no
   * classification logic, it just declines to take a decision's word for the
   * one thing that decision was supposed to have established.
   *
   * It is unreachable through the normal path, and the suite proves that by
   * forging a decision that claims RETRY on a create.
   */
  if (!isAutoRetryable(decision.idempotency)) {
    log.error('recovery', `REFUSED: a ${decision.idempotency} operation reached the retry path — this is a decision-layer bug`);
    recordRecoveryAttempt(taskId, stepId, {
      attempt: decision.attempt, failureKind: decision.failure.kind,
      decision: DECISIONS.MANUAL_INTERVENTION,
      reason: `refused at the execution boundary: ${decision.idempotency} operations are never repeated automatically`,
      idempotency: decision.idempotency,
      outcome: OUTCOME.MANUAL,
    });
    emit({ type: 'recovery_stopped', step: stepId, reason: 'not_auto_retryable' });
    return { outcome: OUTCOME.MANUAL, reason: 'not_auto_retryable', decision };
  }

  if (!executeStep) {
    // No execution surface was supplied, so nothing can be re-attempted. Said
    // plainly rather than treated as a failure of the step.
    recordRecoveryAttempt(taskId, stepId, {
      attempt: decision.attempt, failureKind: decision.failure.kind,
      decision: decision.decision, reason: 'no execution surface was supplied to recovery',
      outcome: OUTCOME.STOPPED,
    });
    return { outcome: OUTCOME.STOPPED, reason: 'no_executor', decision };
  }

  /*
   * THE APPROVAL BINDING, RE-CHECKED. A retry runs the same plan, so the
   * binding must still hold — and if the plan moved while the step was failing,
   * this refuses rather than re-executing under an approval that no longer
   * describes it.
   */
  const bound = checkApprovalBinding(taskId);
  if (!bound.ok) {
    recordRecoveryAttempt(taskId, stepId, {
      attempt: decision.attempt, failureKind: decision.failure.kind,
      decision: DECISIONS.WAIT_FOR_APPROVAL, reason: bound.note ?? bound.reason,
      outcome: OUTCOME.AWAITING_APPROVAL,
    });
    emit({ type: 'recovery_stopped', step: stepId, reason: bound.reason });
    return { outcome: OUTCOME.AWAITING_APPROVAL, reason: bound.reason, decision };
  }

  /*
   * The step is reopened so the EXISTING executor runs it through its whole
   * path again — guards, gate, execution, read-back, ledger. Recovery shortcuts
   * none of it and carries none of the previous attempt's approval: the gate is
   * reached again exactly as it was the first time.
   *
   * `reopenStepForRecovery` rather than `setStepState`, because a failed step is
   * terminal and the transition table refuses to move it. That refusal is
   * correct and stays; this is the one named, audited exception, and it keeps
   * the failed attempt's own record intact underneath.
   */
  const reopened = reopenStepForRecovery(taskId, stepId, { reason: `${decision.failure.kind}: ${decision.reason}` });
  if (!reopened.ok && reopened.reason === 'no_such_step') {
    recordRecoveryAttempt(taskId, stepId, {
      attempt: decision.attempt, failureKind: decision.failure.kind,
      decision: DECISIONS.STOP, reason: 'the step could not be reopened for a retry',
      outcome: OUTCOME.STOPPED,
    });
    return { outcome: OUTCOME.STOPPED, reason: 'not_reopenable', decision };
  }
  setPlanState(taskId, 'executing');
  emit({ type: 'recovery_retry_started', step: stepId, attempt: decision.attempt + 1, of: decision.max_attempts });

  let result;
  try {
    result = await executeStep({ taskId, stepId, sessionId, signal });
  } catch (err) {
    result = { ok: false, note: err.message };
  }

  /*
   * THE OUTCOME IS DECIDED BY VERIFICATION, NOT BY THE CALL RETURNING.
   *
   * `executeStep` reports `ok` when the tool ran and its read-back verified.
   * Recovery adds nothing to that judgement and cannot overrule it — an
   * execution that completed without a verified effect is NOT_RECOVERED.
   */
  const recovered = result?.ok === true;
  recordRecoveryAttempt(taskId, stepId, {
    attempt: decision.attempt,
    failureKind: decision.failure.kind,
    decision: DECISIONS.RETRY,
    reason: decision.reason,
    idempotency: decision.idempotency,
    approvalRequired: decision.approval_required,
    outcome: recovered ? OUTCOME.RECOVERED : OUTCOME.NOT_RECOVERED,
    result: recovered ? 'verified' : (result?.note ?? 'the retry did not verify'),
  });

  emit({
    type: recovered ? 'recovery_succeeded' : 'recovery_failed',
    step: stepId,
    attempt: decision.attempt + 1,
    note: recovered ? null : (result?.note ?? null),
  });

  return {
    outcome: recovered ? OUTCOME.RECOVERED : OUTCOME.NOT_RECOVERED,
    reason: recovered ? 'the retry executed and verified' : (result?.note ?? 'the retry did not verify'),
    decision,
    result,
    plan,
  };
}

export { DECISIONS, LIMITS };
