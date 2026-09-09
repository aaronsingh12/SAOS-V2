import { AGENT_STATUS, mostSignificant } from './schemas.js';

/**
 * EXPERIENCE — WHAT IS THE AGENT DOING, DERIVED FROM DURABLE STATE.
 *
 * §12 asks for a task-level status and names eleven; §13 asks for deterministic
 * precedence when several signals are present at once, and says in as many
 * words that the latest arbitrary UI event must not decide it.
 *
 * So this function takes STATE, not events. Its inputs are the `agent_tasks`
 * row, its `agent_task_steps` rows and the plan's own `plan_state` — all three
 * durable, all three written by code this layer does not own. Two calls with
 * the same rows give the same answer, before and after a refresh, in the
 * browser and in a test. §66's ban on progress that "continues regardless of
 * actual backend state" is met by construction: there is no timer here, no
 * animation state, and nothing that advances on its own.
 *
 * TWO STATE COLUMNS, READ TOGETHER. Migration 22 is explicit that `state` is
 * the TURN projection and `plan_state` is the PLAN's own lifecycle, that they
 * use different vocabularies on purpose, and that they are read together rather
 * than reconciled. This file is where they are read together, and the ordering
 * below is the reconciliation — stated once, in one place, rather than implied
 * by whichever branch a renderer happened to check first.
 */

/** `agent_tasks.state` -> the status it forces, when it forces one. */
const TASK_STATE = Object.freeze({
  completed: AGENT_STATUS.COMPLETED,
  failed: AGENT_STATUS.FAILED,
  cancelled: AGENT_STATUS.CANCELLED,
  blocked: AGENT_STATUS.BLOCKED,
  awaiting_approval: AGENT_STATUS.WAITING_FOR_APPROVAL,
});

/** `agent_tasks.plan_state` -> what the plan says it is doing. */
const PLAN_STATE = Object.freeze({
  planning: AGENT_STATUS.PLANNING,
  ready: AGENT_STATUS.PLANNING,
  awaiting_review: AGENT_STATUS.WAITING_FOR_USER,
  awaiting_approval: AGENT_STATUS.WAITING_FOR_APPROVAL,
  executing: AGENT_STATUS.EXECUTING,
  verifying: AGENT_STATUS.VERIFYING,
  completed: AGENT_STATUS.COMPLETED,
  failed: AGENT_STATUS.FAILED,
  cancelled: AGENT_STATUS.CANCELLED,
});

/** `agent_task_steps.state` -> what an individual step contributes. */
const STEP_STATE = Object.freeze({
  awaiting_approval: AGENT_STATUS.WAITING_FOR_APPROVAL,
  executing: AGENT_STATUS.EXECUTING,
  verifying: AGENT_STATUS.VERIFYING,
  running: AGENT_STATUS.EXECUTING,
});

/**
 * The task-level status (§12), by precedence (§13).
 *
 * @param {object|null} task   an `agent_tasks` row, or null for "no task"
 * @param {object[]}    steps  its `agent_task_steps` rows
 * @param {object}      hints  live-only facts the tables cannot hold:
 *                             `awaitingUser` (the turn asked a question and is
 *                             waiting on a person) and `recovering` (a retry is
 *                             in flight). Both default false, and both are
 *                             IGNORED once the task has reached a terminal
 *                             state — a finished task is finished whatever a
 *                             stale hint says.
 *
 * TERMINAL FIRST, ALWAYS. A completed task whose last step row still reads
 * `executing` — which a crashed process can leave behind — is COMPLETED, not
 * EXECUTING. The task row is the authority on whether the task ended; the step
 * rows are the authority on what it was doing while it had not.
 */
export function agentStatus(task, steps = [], { awaitingUser = false, recovering = false } = {}) {
  if (!task) return AGENT_STATUS.IDLE;

  const forced = TASK_STATE[task.state];
  /*
   * `blocked` and `awaiting_approval` are NOT terminal, so they take part in
   * precedence rather than short-circuiting: a task awaiting approval is
   * WAITING_FOR_APPROVAL, and precedence already ranks that above everything
   * live. Only the three genuinely terminal states return early.
   */
  if (forced === AGENT_STATUS.COMPLETED || forced === AGENT_STATUS.FAILED || forced === AGENT_STATUS.CANCELLED) {
    return forced;
  }

  const signals = [];
  if (forced) signals.push(forced);
  if (task.plan_state && PLAN_STATE[task.plan_state]) signals.push(PLAN_STATE[task.plan_state]);
  for (const s of steps) {
    if (s?.state && STEP_STATE[s.state]) signals.push(STEP_STATE[s.state]);
  }
  if (awaitingUser) signals.push(AGENT_STATUS.WAITING_FOR_USER);
  if (recovering) signals.push(AGENT_STATUS.RECOVERING);

  /*
   * A running task with nothing more specific to say is THINKING — the model is
   * deciding what to do and no tool, plan or gate is live. §12's "do not call
   * everything thinking" is honoured by this being the LAST resort rather than
   * the first: every more specific signal above outranks it.
   */
  if (task.state === 'running' && !signals.length) return AGENT_STATUS.THINKING;
  if (!signals.length) return AGENT_STATUS.IDLE;

  return mostSignificant(signals);
}

/**
 * §17 — the one-line plan summary the collapsed panel shows.
 *
 * Counts only. Nothing here reads a step's inputs, so it cannot leak one, and
 * a plan with no steps reports zero rather than being hidden.
 */
export function planProgress(steps = []) {
  const count = (state) => steps.filter((s) => s?.state === state).length;
  return {
    total: steps.length,
    completed: count('completed'),
    running: count('executing') + count('verifying') + count('running'),
    queued: count('pending') + count('ready') + count('planned'),
    failed: count('failed'),
    skipped: count('skipped'),
    awaiting_approval: count('awaiting_approval'),
  };
}
