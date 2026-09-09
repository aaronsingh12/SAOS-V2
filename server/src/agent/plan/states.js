/**
 * PHASE 4 — THE PLAN STATE MACHINE, AND THE STEP STATE MACHINE.
 *
 * Two vocabularies, deliberately separate from Phase 1's task states.
 *
 * Phase 1's `TASK_STATES` project the TURN: a task exists for every agent turn
 * and moves running -> completed with it. A plan has a lifecycle the turn's
 * does not express — being reviewed by a human, being approved against a
 * fingerprint, being verified after execution — and overloading the turn's
 * words would either break that projection or make `running` mean four things.
 * So a task carries both, and `plan_state` is null for the tasks that have no
 * plan (which is every turn Phases 0-3 produce).
 *
 * TRANSITIONS ARE A CLOSED TABLE, NOT A CONVENTION. `canTransition` is the only
 * thing that decides, and the store refuses anything it rejects. That matters
 * most for the two shapes this phase exists to prevent: a plan reaching
 * EXECUTING without passing through AWAITING_APPROVAL, and a terminal plan
 * moving again — which is what a stale approval replayed against a changed plan
 * would look like.
 */

/** The plan lifecycle. */
export const PLAN_STATES = Object.freeze([
  'planning',
  'ready',
  'awaiting_review',
  'awaiting_approval',
  'executing',
  'verifying',
  'completed',
  'failed',
  'cancelled',
]);

/** The step lifecycle. */
export const STEP_STATES = Object.freeze([
  'pending',
  'ready',
  'awaiting_approval',
  'executing',
  'verifying',
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);

export const PLAN_TERMINAL = Object.freeze(['completed', 'failed', 'cancelled']);
export const STEP_TERMINAL = Object.freeze(['completed', 'failed', 'skipped', 'cancelled']);

/**
 * Legal plan transitions.
 *
 * Read it as: what could a plan honestly do next?
 *
 * The path to execution is the point. `awaiting_approval -> executing` is the
 * ONLY edge into EXECUTING, so a plan cannot reach a mutation without having
 * been offered for approval — not because the executor remembers to ask, but
 * because there is no other way through this table. Every state can fail and
 * every non-terminal state can be cancelled, because both of those can happen
 * at any moment and a machine that could not express them would be lying.
 */
const PLAN_TRANSITIONS = Object.freeze({
  planning: ['ready', 'failed', 'cancelled'],
  // A plan may go straight to approval when nothing needs human review, but the
  // read-only case can also complete without ever asking for anything.
  ready: ['awaiting_review', 'awaiting_approval', 'executing', 'failed', 'cancelled'],
  awaiting_review: ['awaiting_approval', 'ready', 'failed', 'cancelled'],
  // Rejection ends the plan. It is NOT a route back to planning: turning a
  // refusal into a retry is exactly what Part 9 forbids.
  awaiting_approval: ['executing', 'failed', 'cancelled'],
  executing: ['verifying', 'awaiting_approval', 'completed', 'failed', 'cancelled'],
  verifying: ['executing', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
});

const STEP_TRANSITIONS = Object.freeze({
  pending: ['ready', 'skipped', 'failed', 'cancelled'],
  ready: ['awaiting_approval', 'executing', 'skipped', 'failed', 'cancelled'],
  awaiting_approval: ['executing', 'skipped', 'failed', 'cancelled'],
  executing: ['verifying', 'completed', 'failed', 'cancelled'],
  verifying: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  skipped: [],
  cancelled: [],
});

export function canTransition(kind, from, to) {
  const table = kind === 'plan' ? PLAN_TRANSITIONS : STEP_TRANSITIONS;
  return Boolean(table[from]?.includes(to));
}

export function isTerminal(kind, state) {
  return (kind === 'plan' ? PLAN_TERMINAL : STEP_TERMINAL).includes(state);
}

/** Every state that must have been passed through before a mutation may run. */
export const REQUIRED_BEFORE_EXECUTION = Object.freeze(['awaiting_approval']);

export const PLAN_TRANSITION_TABLE = PLAN_TRANSITIONS;
export const STEP_TRANSITION_TABLE = STEP_TRANSITIONS;
