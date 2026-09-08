import { classifyFailure, signalsFromEvidence } from './classification.js';
import { classifyIdempotency, IDEMPOTENCY, isAutoRetryable } from './idempotency.js';
import { policyFor, DECISIONS, LIMITS } from './policy.js';
import { RECONCILIATION, mayRepeatAfter } from './reconcile.js';

/**
 * PHASE 6 — THE RECOVERY DECISION. Pure, and explainable without a model.
 *
 * Four independent inputs, all deterministic, all required before anything may
 * be re-attempted automatically:
 *
 *   1. WHAT FAILED          classification.js, evidence-first
 *   2. IS IT SAFE TO REPEAT idempotency.js, from registry metadata
 *   3. IS IT PERMITTED      policy.js, a closed table with no default branch
 *   4. IS THERE BUDGET      the attempt counts below, enforced on stored state
 *
 * ANY ONE OF THEM SAYING NO STOPS IT. That conjunction is the safety property:
 * a transient network fault on a create is still not automatically retried,
 * because the operation is NON_IDEMPOTENT however benign the failure was.
 *
 * NO CLOCK, NO RANDOMNESS, NO MODEL. The same evidence and the same stored
 * attempt history always produce the same decision — which is what makes a
 * recovery decision something a person can audit rather than observe.
 *
 * IT DECIDES; IT DOES NOT ACT. Producing `RETRY` is not permission to write. It
 * is a proposal the executor carries out through the existing gate, guards and
 * verifier, none of which this file can reach.
 */

export { DECISIONS, LIMITS };

const decision = (kind, fields) => Object.freeze({
  decision: kind,
  ...fields,
});

/**
 * Decide what, if anything, may happen after a failure.
 *
 * @param {object} opts
 * @param {object} opts.evidence      the Phase 5 projection — the source of truth
 * @param {string} opts.stepId        which step failed; inferred when absent
 * @param {object} opts.descriptor    the failed tool's own describeWrite output
 * @param {object} opts.capability    the Phase 3 discovery result for the step
 * @param {object} opts.error         the structured error, if one was captured
 * @param {object} opts.reconciliation  the result of reconcile.js, when one was performed
 * @param {object} opts.history       { attempts, replans, recoverySteps } from durable metadata
 * @param {boolean} opts.cancelled    the Phase 0 signal, observed not owned
 */
export function decideRecovery({
  evidence = null,
  stepId = null,
  descriptor = null,
  capability = null,
  error = null,
  reconciliation = null,
  history = { attempts: 1, replans: 0, recoverySteps: 0 },
  cancelled = false,
  registry = undefined,
} = {}) {
  const signals = { ...signalsFromEvidence(evidence, stepId), error, capability, cancelled };
  const failure = classifyFailure(signals);
  const policy = policyFor(failure.kind);
  const step = signals.step ?? null;
  const idempotency = classifyIdempotency({
    tool: step?.tool ?? null,
    descriptor,
    capability: capability?.name ?? step?.capability ?? null,
    ...(registry ? { registry } : {}),
  });

  const evidenceRefs = {
    taskId: evidence?.task?.id ?? null,
    stepId: step?.id ?? stepId ?? null,
    finalStatus: evidence?.final?.status ?? null,
    verificationStatus: step?.verification_status ?? null,
    approvalValid: evidence?.approval?.valid ?? null,
  };

  const base = {
    failure,
    idempotency: idempotency.idempotency,
    idempotencyReason: idempotency.reason,
    attempt: history.attempts ?? 1,
    max_attempts: policy.maxAttempts ?? 0,
    approval_required: policy.requiresApproval === true,
    recovery_action: null,
    evidence_refs: evidenceRefs,
    policy_rationale: policy.rationale,
  };

  /* ---- 0. CANCELLATION. Phase 0's decision, honoured not re-litigated. ---- */
  if (failure.kind === 'CANCELLED') {
    return decision(DECISIONS.STOP, {
      ...base,
      reason: 'the run was cancelled; no recovery attempt is started after a cancellation',
    });
  }

  /* ---- 1. BUDGET. Checked before anything is proposed. ---- */
  if ((history.recoverySteps ?? 0) >= LIMITS.MAX_RECOVERY_STEPS) {
    return decision(DECISIONS.STOP, {
      ...base,
      reason: 'recovery_budget_exhausted',
      detail: { recoverySteps: history.recoverySteps, limit: LIMITS.MAX_RECOVERY_STEPS },
    });
  }

  /* ---- 2. The policy's own answer for kinds that never re-attempt. ---- */
  if (policy.decision === DECISIONS.MANUAL_INTERVENTION) {
    return decision(DECISIONS.MANUAL_INTERVENTION, {
      ...base,
      reason: `${failure.kind}: ${failure.reason}`,
    });
  }
  if (policy.decision === DECISIONS.WAIT_FOR_APPROVAL) {
    return decision(DECISIONS.WAIT_FOR_APPROVAL, {
      ...base,
      reason: `${failure.kind}: ${failure.reason}`,
      recovery_action: { type: 'await_new_approval', target: evidenceRefs.taskId, inputs: {} },
    });
  }
  if (policy.decision === DECISIONS.STOP) {
    return decision(DECISIONS.STOP, {
      ...base,
      reason: `${failure.kind}: ${failure.reason}`,
    });
  }

  /* ---- 3. REPLAN. Distinct from retry, and never silent. ---- */
  if (policy.decision === DECISIONS.REPLAN) {
    if ((history.replans ?? 0) >= LIMITS.MAX_REPLANS) {
      return decision(DECISIONS.STOP, {
        ...base,
        reason: 'recovery_budget_exhausted: the re-plan limit was reached',
        detail: { replans: history.replans, limit: LIMITS.MAX_REPLANS },
      });
    }
    /*
     * A re-plan produces a DIFFERENT plan, which Phase 4's fingerprint will
     * refuse to execute under the old approval. That is the intended path and
     * it is stated in the action rather than left implicit: the new plan goes
     * through review and approval like any other.
     */
    return decision(DECISIONS.REPLAN, {
      ...base,
      approval_required: true,
      reason: `${failure.kind}: ${failure.reason}. A changed plan cannot inherit the previous approval.`,
      recovery_action: {
        type: 'replan',
        target: evidenceRefs.taskId,
        inputs: { because: failure.kind, step: evidenceRefs.stepId },
      },
    });
  }

  /* ---- 4. RETRY. The narrow path, and every condition must hold. ---- */

  /* 4a. Is the OPERATION safe to repeat at all? */
  if (!isAutoRetryable(idempotency.idempotency)) {
    return decision(DECISIONS.MANUAL_INTERVENTION, {
      ...base,
      reason: idempotency.idempotency === IDEMPOTENCY.NON_IDEMPOTENT
        ? `${failure.kind}, but the operation is NON_IDEMPOTENT: ${idempotency.reason}`
        : `${failure.kind}, but whether repeating the operation is safe could not be established: ${idempotency.reason}`,
    });
  }

  /* 4b. Has the budget for THIS step run out? */
  if ((history.attempts ?? 1) >= (policy.maxAttempts ?? 0)) {
    return decision(DECISIONS.STOP, {
      ...base,
      reason: 'recovery_budget_exhausted: the attempt limit for this step was reached',
      detail: { attempts: history.attempts, limit: policy.maxAttempts },
    });
  }

  /*
   * 4c. RECONCILE FIRST, where the policy demands it.
   *
   * A timeout is the case where the operation may have fully succeeded with the
   * response lost. Repeating before checking is how duplicates are made, so the
   * decision refuses until a reconciliation has been supplied — and then obeys
   * it.
   */
  if (policy.reconcileFirst) {
    if (!reconciliation) {
      return decision(DECISIONS.STOP, {
        ...base,
        reason: `${failure.kind}: the operation may already have taken effect, and that must be established `
          + 'before anything is repeated. Reconcile the intended effect against the record first.',
        recovery_action: { type: 'reconcile', target: descriptor?.sys_id ?? null, inputs: { table: descriptor?.table ?? null } },
      });
    }
    if (reconciliation.status === RECONCILIATION.ALREADY_SATISFIED) {
      // The best possible outcome: nothing to do, and nothing was done twice.
      return decision(DECISIONS.STOP, {
        ...base,
        reason: 'already_satisfied: the intended effect is already present, so the operation is not repeated',
        detail: { reconciliation: reconciliation.status, why: reconciliation.reason },
      });
    }
    if (!mayRepeatAfter(reconciliation)) {
      return decision(DECISIONS.MANUAL_INTERVENTION, {
        ...base,
        reason: `${failure.kind}: the effect could not be established as absent (${reconciliation.status}). `
          + `${reconciliation.reason}`,
        detail: { reconciliation: reconciliation.status },
      });
    }
  }

  /* 4d. Everything holds. Propose the identical operation, once more. */
  return decision(DECISIONS.RETRY, {
    ...base,
    automatic: policy.automatic === true,
    backoff: policy.backoff === true,
    reason: `${failure.kind}: ${policy.rationale}`,
    recovery_action: {
      // IDENTICAL inputs. A retry that changed the payload would be a different
      // operation wearing a retry's name, and would need a new approval.
      type: 'retry_identical',
      target: evidenceRefs.stepId,
      inputs: descriptor?.requested ?? step?.inputs ?? {},
    },
  });
}

/**
 * The durable attempt history for one step, read from step metadata.
 *
 * Metadata rather than a schema change: `agent_task_steps.metadata_json` already
 * exists and nothing else uses it for plan steps, so recovery lineage needs no
 * migration. Attempts are counted from the stored array, which is why the limit
 * cannot be bypassed by a process that forgot it had already tried.
 */
export function historyFrom(stepMetadata) {
  const recovery = stepMetadata?.recovery ?? null;
  const attempts = recovery?.attempts ?? [];
  return {
    attempts: attempts.length ? attempts.length : 1,
    replans: attempts.filter((a) => a.decision === DECISIONS.REPLAN).length,
    recoverySteps: attempts.length,
    entries: attempts,
  };
}
