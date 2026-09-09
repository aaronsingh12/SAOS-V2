import { FAILURE_KINDS } from './classification.js';

/**
 * PHASE 6 — THE RECOVERY POLICY. A table, not a judgement.
 *
 * One row per failure kind, and the row is the whole decision about what may
 * happen next. There is no default branch, no "otherwise retry", and no way for
 * an unlisted kind to acquire a permissive answer: `POLICY` is asserted
 * complete against the taxonomy, and a kind added without a row fails a test
 * rather than falling through to something lenient.
 *
 * `automatic: true` IS THE ONLY PERMISSION IN THIS FILE, and it is narrow. It
 * means "this may be re-attempted without asking a person" — and even then only
 * after `idempotency.js` has established the operation is safe to repeat and
 * the attempt budget has room. Three independent conditions, all deterministic,
 * all required.
 *
 * NOTHING HERE CAN APPROVE ANYTHING. `requiresApproval: true` means the
 * EXISTING gate must be reached; it does not mean this file grants anything.
 * The approval authority is Phase 0's gate and Phase 4's fingerprint binding,
 * unchanged and unconsulted by this table.
 */

/** What recovery may decide to do. Closed. */
export const DECISIONS = Object.freeze({
  RETRY: 'RETRY',
  REPLAN: 'REPLAN',
  STOP: 'STOP',
  WAIT_FOR_APPROVAL: 'WAIT_FOR_APPROVAL',
  MANUAL_INTERVENTION: 'MANUAL_INTERVENTION',
});

/**
 * The limits, enforced in code rather than hoped for.
 *
 * Small and fixed. `MAX_ATTEMPTS` counts total attempts of one step including
 * the original, so 2 means "the first try, and at most one more" — the loop in
 * `decision.js` cannot exceed it because the comparison is on a stored count
 * rather than on a flag someone has to reset.
 */
export const LIMITS = Object.freeze({
  MAX_ATTEMPTS: 2,          // total attempts per step, original included
  MAX_REPLANS: 1,           // re-plans per task
  MAX_RECOVERY_STEPS: 4,    // total recovery actions per task, of any kind
});

/**
 * The policy table.
 *
 * `automatic` is true for exactly three kinds, and each is a case where the
 * operation demonstrably did not reach the instance's business logic: the
 * network never carried it, the instance asked for less traffic, or the
 * instance faulted on its own side. Everything else needs either a new plan or
 * a person.
 *
 * TIMEOUT is deliberately NOT automatic. A timeout is the one failure where the
 * operation may have fully succeeded with the response lost, so it goes to
 * reconciliation first — see `reconcile.js`.
 */
export const POLICY = Object.freeze({
  TRANSIENT: {
    decision: DECISIONS.RETRY, automatic: true, requiresApproval: false, maxAttempts: LIMITS.MAX_ATTEMPTS,
    rationale: 'the instance faulted on its own side; the request never reached its business logic',
  },
  NETWORK: {
    decision: DECISIONS.RETRY, automatic: true, requiresApproval: false, maxAttempts: LIMITS.MAX_ATTEMPTS,
    rationale: 'nothing was carried to the instance, so nothing can have taken effect',
  },
  RATE_LIMITED: {
    decision: DECISIONS.RETRY, automatic: true, requiresApproval: false, maxAttempts: LIMITS.MAX_ATTEMPTS,
    backoff: true,
    rationale: 'the instance asked for less traffic; the same request after a pause is the correct response',
  },
  TIMEOUT: {
    // RECONCILE FIRST. The response was lost, so whether it took effect is
    // unknown — and a retry before checking is how duplicates are made.
    decision: DECISIONS.RETRY, automatic: false, requiresApproval: false, reconcileFirst: true,
    maxAttempts: LIMITS.MAX_ATTEMPTS,
    rationale: 'the operation may have succeeded with the response lost; its effect must be established before anything is repeated',
  },

  AUTHENTICATION: {
    decision: DECISIONS.MANUAL_INTERVENTION, automatic: false, requiresApproval: false, maxAttempts: 0,
    rationale: 'the credentials were rejected; no number of retries fixes that, and a person must change the configuration',
  },
  AUTHORIZATION: {
    decision: DECISIONS.MANUAL_INTERVENTION, automatic: false, requiresApproval: false, maxAttempts: 0,
    rationale: 'the instance refused on permission grounds; repeating it reproduces the refusal exactly',
  },

  VALIDATION: {
    decision: DECISIONS.REPLAN, automatic: false, requiresApproval: true, maxAttempts: 0,
    rationale: 'the request itself was rejected, so only a changed request can succeed — and a changed request is a new approval surface',
  },
  REFERENCE: {
    decision: DECISIONS.REPLAN, automatic: false, requiresApproval: true, maxAttempts: 0,
    rationale: 'the reference could not be resolved; re-resolving it changes the payload, which needs review',
  },
  SCOPE: {
    decision: DECISIONS.STOP, automatic: false, requiresApproval: true, maxAttempts: 0,
    rationale: 'a scope refusal is a decision about where an artifact belongs, and that is a human call',
  },

  BUILD: {
    decision: DECISIONS.REPLAN, automatic: false, requiresApproval: true, maxAttempts: 0,
    rationale: 'the source did not compile; regenerating it goes through the existing build path and its gates',
  },
  INSTALL: {
    // An install that failed may have partly landed — installs ship the whole
    // application. Repeating one blind is not deterministically safe.
    decision: DECISIONS.STOP, automatic: false, requiresApproval: true, maxAttempts: 0,
    rationale: 'an install deploys the whole application, so what reached the instance must be read back before anything is repeated',
  },

  VERIFICATION: {
    decision: DECISIONS.REPLAN, automatic: false, requiresApproval: true, maxAttempts: 0,
    rationale: 'the effect did not hold; repeating the identical write reproduces the identical non-effect, so the plan must change',
  },

  APPROVAL_STALE: {
    decision: DECISIONS.WAIT_FOR_APPROVAL, automatic: false, requiresApproval: true, maxAttempts: 0,
    rationale: 'the plan changed after approval; a new approval is required and cannot be inherited',
  },
  CANCELLED: {
    decision: DECISIONS.STOP, automatic: false, requiresApproval: false, maxAttempts: 0,
    rationale: 'a cancellation is a decision, and recovering from it would be overriding the person who made it',
  },
  BLOCKED: {
    decision: DECISIONS.STOP, automatic: false, requiresApproval: true, maxAttempts: 0,
    rationale: 'a control refused; the next move is a human decision, not another attempt',
  },
  UNSUPPORTED: {
    decision: DECISIONS.STOP, automatic: false, requiresApproval: false, maxAttempts: 0,
    rationale: 'this instance cannot do it through any supported mechanism, and none is improvised',
  },
  UNKNOWN: {
    decision: DECISIONS.STOP, automatic: false, requiresApproval: false, maxAttempts: 0,
    rationale: 'nothing established what went wrong, so nothing can be shown to be safe',
  },
});

/** Look up the row. Refuses an unlisted kind rather than defaulting. */
export function policyFor(kind) {
  const row = POLICY[kind];
  if (!row) {
    throw new Error(`no recovery policy for failure kind "${kind}" — the table must be complete`);
  }
  return row;
}

/** Exported so a test can assert the table covers the taxonomy exactly. */
export const POLICY_KINDS = Object.freeze(Object.keys(POLICY));
export { FAILURE_KINDS };
