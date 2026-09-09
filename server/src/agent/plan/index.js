/**
 * PHASE 4 — plan → review → approve → execute → verify.
 *
 * The public surface, and the order the pieces run in:
 *
 *   generatePlan   the model PROPOSES a candidate
 *   validatePlan   deterministic refusal before anyone is asked to approve
 *   savePlan       the durable record — the source of truth, not the SSE stream
 *   buildReview    what a human reads
 *   approvePlan    binds a decision to the fingerprint they reviewed
 *   executePlan    runs it through the EXISTING gate, guards and verifier
 *
 * Two invariants hold this together, and both are enforced rather than
 * documented: a plan cannot reach EXECUTING except through AWAITING_APPROVAL
 * (the transition table in states.js), and a plan that changed after approval
 * cannot execute under it (the fingerprint, re-checked before every step).
 */
export {
  PLAN_STATES, STEP_STATES, PLAN_TERMINAL, STEP_TERMINAL,
  canTransition, isTerminal, PLAN_TRANSITION_TABLE, STEP_TRANSITION_TABLE,
} from './states.js';

export {
  fingerprintPlan, canonicalPlan, diffPlans, fingerprintMatches, FINGERPRINTED_STEP_FIELDS,
} from './fingerprint.js';

export {
  savePlan, loadPlan, getStepByPlanId,
  setPlanState, setStepState, recordStepResult,
  approvePlan, checkApprovalBinding, executionOrder,
  recordRecoveryAttempt, recoveryHistory, reopenStepForRecovery,
  recordStepOutputs, stepOutputs, recordStepDataflow,
} from './store.js';

export { validatePlan, mutatingSteps } from './validator.js';
export {
  REF_KEY, DATAFLOW_CODES, RESOLUTION_CODES, DATAFLOW_TYPES, SLOT_TYPES,
  parseReference, findReferences, findAttemptedReferences, validateDataflow,
  resolveReferences, extractOutputs, declaredOutputsOf, hasReferences,
  producerIsUsable, typeSatisfies,
} from './dataflow.js';

export {
  canonicalExecutionArgs, canonicalisePlan, isCanonical,
  LIFTABLE_TARGET_KEYS, CANONICAL_CODES,
} from './canonical.js';

export { generatePlan, plannerSystem, extractPlanJson, normalizeCandidate, stampPlatformFacts, MAX_STEPS } from './planner.js';
export { buildReview, renderReview } from './review.js';
export { executePlan } from './executor.js';
