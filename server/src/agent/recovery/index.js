/**
 * PHASE 6 — the Recovery Engine.
 *
 *   classify the failure  →  is the operation safe to repeat?  →  is it
 *   permitted?  →  is there budget?  →  reconcile before repeating  →  hand the
 *   identical operation back to the existing executor  →  let the existing
 *   verifier decide whether it worked.
 *
 * FOUR INDEPENDENT DETERMINISTIC GATES, ALL REQUIRED. Any one saying no stops
 * it. A transient network fault on a create is still not retried, because the
 * operation is NON_IDEMPOTENT however benign the failure was.
 *
 * NO MODEL DECIDES ANYTHING HERE. Classification, policy, idempotency, the
 * attempt limit and the approval requirement are all pure functions over
 * durable evidence. A language model may later help EXPLAIN a failure or
 * PROPOSE a replacement plan; it can never establish that recovery is
 * authorised.
 *
 * IT IS NOT A SECOND MUTATION ENGINE. Recovery owns the decision and nothing
 * else — the approval gate, the write guards, provenance, the read-back
 * verifier and the plan executor are all reached rather than reimplemented, and
 * the boundary tests assert it on the import graph.
 */
export {
  FAILURE_KINDS, EVIDENCE_SOURCES, classifyFailure, signalsFromEvidence, matchingTrap,
} from './classification.js';

export {
  IDEMPOTENCY, AUTO_RETRYABLE, isAutoRetryable, classifyIdempotency, capabilityIsRead,
} from './idempotency.js';

export { POLICY, POLICY_KINDS, DECISIONS, LIMITS, policyFor } from './policy.js';
export { RECONCILIATION, reconcileIntent, mayRepeatAfter } from './reconcile.js';
export { decideRecovery, historyFrom } from './decision.js';
export { recoverStep, OUTCOME } from './executor.js';
