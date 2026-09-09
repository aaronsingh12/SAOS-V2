/**
 * PHASE 5 — THE FINAL STATUS, DECIDED BY RULE.
 *
 * NO MODEL CHOOSES THIS. The whole value of a final status is that it means the
 * same thing every time, and a status a language model picked would mean
 * whatever it felt like that turn. Every input below is a durable record; the
 * function is pure; the same database state always produces the same word.
 *
 * THE DISTINCTION THAT MATTERS MOST is between UNVERIFIED and VERIFIED. A tool
 * call that returned HTTP 200 is not a verified effect — this whole project
 * exists because the Table API answers 2xx for writes it silently discarded. So
 * execution success and verification success are tracked apart, and a promised
 * effect with no verification evidence is UNVERIFIED, never "success".
 *
 * THE ORDER OF THE RULES IS THE SEMANTICS. They are checked most-severe first,
 * so a cancelled task that also had a failed step reads as CANCELLED (the
 * reason it stopped), and a task blocked before execution never reports on
 * verification it never reached.
 */

export const STATUS = Object.freeze({
  VERIFIED: 'VERIFIED',
  PARTIALLY_VERIFIED: 'PARTIALLY_VERIFIED',
  UNVERIFIED: 'UNVERIFIED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  BLOCKED: 'BLOCKED',
});

export const STATUSES = Object.freeze(Object.values(STATUS));

/**
 * Why a task never got to execute.
 *
 * BLOCKED is not a failure — nothing went wrong, the platform correctly refused
 * to proceed. Separating it matters because the two need different responses: a
 * failure wants diagnosis, a block wants a decision from a person.
 */
const BLOCKING_REASONS = Object.freeze([
  'not_approved',        // the plan was never approved
  'approval_stale',      // the plan changed after approval
  'rejected',            // a human said no
  'fingerprint_mismatch',
  'no_capabilities',     // nothing is available on this instance
  'invalid',             // the plan failed deterministic validation
  'unsupported',
  'capability_unavailable',
  'no_supported_execution_mechanism',
]);

export const isBlockingReason = (r) => BLOCKING_REASONS.includes(String(r ?? ''));

/**
 * Decide the final status.
 *
 * @param {object} facts   everything the projection established, all durable
 * @param {string} facts.planState        the Phase 4 plan state, or null
 * @param {string} facts.taskState        the Phase 1 task state
 * @param {string} facts.failureReason
 * @param {object[]} facts.steps          { state, executed, verification }
 * @param {object[]} facts.effects        { verified: true|false|null }
 * @param {boolean} facts.executedAnything
 */
export function decideStatus(facts = {}) {
  const {
    planState = null, taskState = null, failureReason = null,
    steps = [], effects = [], executedAnything = false,
  } = facts;

  /* 1. CANCELLED — the reason it stopped outranks anything it had done. */
  if (planState === 'cancelled' || taskState === 'cancelled') {
    return { status: STATUS.CANCELLED, reason: 'the run was cancelled before it finished' };
  }

  /* 2. BLOCKED — it never got to execute, and that was the correct outcome. */
  if (!executedAnything && (isBlockingReason(failureReason) || steps.every((s) => s.state === 'pending' || s.state === 'skipped'))) {
    if (planState === 'failed' || taskState === 'failed' || steps.length) {
      return {
        status: STATUS.BLOCKED,
        reason: failureReason
          ? `execution was refused: ${failureReason}`
          : 'no step was ever started',
      };
    }
  }
  // A blocking reason is blocking even where something ran first: an approval
  // that went stale mid-plan stopped the rest, and calling that FAILED would
  // suggest a defect where there was a control working.
  if (isBlockingReason(failureReason)) {
    return { status: STATUS.BLOCKED, reason: `execution was refused: ${failureReason}` };
  }

  /* 3. FAILED — a step actually failed. */
  const failedSteps = steps.filter((s) => s.state === 'failed');
  if (failedSteps.length) {
    return {
      status: STATUS.FAILED,
      reason: `${failedSteps.length} step(s) failed: ${failedSteps.map((s) => s.id).join(', ')}`,
    };
  }
  if (planState === 'failed' || taskState === 'failed') {
    return { status: STATUS.FAILED, reason: failureReason || 'the run failed' };
  }

  /* 4. Nothing ran and nothing was refused — there is nothing to report on. */
  if (!executedAnything) {
    return { status: STATUS.UNVERIFIED, reason: 'nothing was executed, so there is nothing verified' };
  }

  /*
   * 5. Verification. THE POINT OF THE PHASE.
   *
   * `effects` are the promised effects, each carrying whether verification
   * evidence supports it. `null` means no evidence either way — which is
   * UNVERIFIED, never success. A run that executed cleanly and proved nothing
   * has not done what was asked; it has only not visibly failed.
   */
  if (!effects.length) {
    return {
      status: STATUS.UNVERIFIED,
      reason: 'execution completed, but nothing promised an effect that could be verified',
    };
  }
  const passed = effects.filter((e) => e.verified === true).length;
  const failed = effects.filter((e) => e.verified === false).length;
  const unknown = effects.filter((e) => e.verified === null || e.verified === undefined).length;

  if (failed) {
    return {
      status: STATUS.FAILED,
      reason: `${failed} of ${effects.length} promised effect(s) were checked and did not hold`,
    };
  }
  if (passed === effects.length) {
    return { status: STATUS.VERIFIED, reason: `all ${effects.length} promised effect(s) were verified` };
  }
  if (passed > 0) {
    return {
      status: STATUS.PARTIALLY_VERIFIED,
      reason: `${passed} of ${effects.length} promised effect(s) were verified; ${unknown} remain unverified`,
    };
  }
  return {
    status: STATUS.UNVERIFIED,
    reason: `execution completed, but none of the ${effects.length} promised effect(s) has verification evidence`,
  };
}
