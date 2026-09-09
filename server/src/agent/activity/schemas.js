/**
 * EXPERIENCE — THE ACTIVITY VOCABULARY.
 *
 * This file is DATA and a handful of total functions over it. It performs no
 * I/O, holds no state, and cannot decide anything about a ServiceNow
 * operation — which is the whole point, because §73 forbids the Experience
 * layer owning execution, verification, approval or the task state machine.
 *
 * WHAT AN ACTIVITY EVENT IS. A PRESENTATION projection of something the
 * backend already recorded or already announced. §6 is explicit that this is a
 * read model and not a second operational state machine, and the way that is
 * kept true here is by construction: every field below is copied from a task
 * row, a step row, a `tool_events` row or an SSE frame the orchestrator emits.
 * Nothing in this directory may invent one.
 *
 * WHY THE VOCABULARY IS CLOSED. §8 says every UI state must correspond to real
 * backend state, and §79.1/§79.2 make a fabricated running or completed state a
 * release blocker. A closed vocabulary makes that testable rather than
 * aspirational: `test/experience-safety.test.js` asserts that every type and
 * status the client can render is one of these, and that every frame the
 * orchestrator can emit maps to one of these or to nothing at all.
 */

/** §6 — the event families. One per kind of thing the backend records. */
export const ACTIVITY_TYPE = Object.freeze({
  TASK: 'task',
  PLAN: 'plan',
  STEP: 'step',
  TOOL: 'tool',
  APPROVAL: 'approval',
  VERIFICATION: 'verification',
  RECOVERY: 'recovery',
});

export const ACTIVITY_TYPES = Object.freeze(Object.values(ACTIVITY_TYPE));

/** §6 — the per-event lifecycle. Deliberately the same words the tables use. */
export const ACTIVITY_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
});

export const ACTIVITY_STATUSES = Object.freeze(Object.values(ACTIVITY_STATUS));

/**
 * §12 — the task-level status. Eleven words, and §49's three waiting kinds.
 *
 * "Do not call everything thinking", and equally: do not call all inactivity
 * working. WAITING_FOR_USER is a turn that asked a question; WAITING_FOR_SYSTEM
 * is a turn blocked on something neither the user nor the agent controls.
 */
export const AGENT_STATUS = Object.freeze({
  IDLE: 'IDLE',
  THINKING: 'THINKING',
  PLANNING: 'PLANNING',
  EXECUTING: 'EXECUTING',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  WAITING_FOR_USER: 'WAITING_FOR_USER',
  WAITING_FOR_SYSTEM: 'WAITING_FOR_SYSTEM',
  VERIFYING: 'VERIFYING',
  RECOVERING: 'RECOVERING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  BLOCKED: 'BLOCKED',
});

export const AGENT_STATUSES = Object.freeze(Object.values(AGENT_STATUS));

/**
 * §13 — DETERMINISTIC PRECEDENCE, most significant first.
 *
 * The rule this encodes: the latest arbitrary event must not decide the state.
 * A turn that is executing a tool while an approval card is on screen is
 * WAITING_FOR_APPROVAL, because the thing a person needs to know is that the
 * agent is waiting on them — and the reverse ordering would hide it behind
 * whichever frame happened to arrive last.
 *
 * Terminal states sit ABOVE every live one: a task that has ended has ended,
 * which is the same rule `memory/tasks.js` enforces on the durable row, stated
 * once more in the projection so the two cannot disagree.
 */
export const STATUS_PRECEDENCE = Object.freeze([
  AGENT_STATUS.CANCELLED,
  AGENT_STATUS.FAILED,
  AGENT_STATUS.COMPLETED,
  AGENT_STATUS.BLOCKED,
  AGENT_STATUS.WAITING_FOR_APPROVAL,
  AGENT_STATUS.WAITING_FOR_USER,
  AGENT_STATUS.WAITING_FOR_SYSTEM,
  AGENT_STATUS.RECOVERING,
  AGENT_STATUS.EXECUTING,
  AGENT_STATUS.VERIFYING,
  AGENT_STATUS.PLANNING,
  AGENT_STATUS.THINKING,
  AGENT_STATUS.IDLE,
]);

/** Terminal for the purposes of the workspace: nothing more will arrive. */
export const TERMINAL_AGENT_STATUSES = Object.freeze([
  AGENT_STATUS.COMPLETED, AGENT_STATUS.FAILED, AGENT_STATUS.CANCELLED,
]);

/**
 * §48/§49 — is a spinner honest here?
 *
 * True only while the agent is doing something. A turn waiting for a person is
 * NOT working, and animating it would be the "fake progress" §66 forbids.
 */
export const isWorking = (status) => [
  AGENT_STATUS.THINKING, AGENT_STATUS.PLANNING, AGENT_STATUS.EXECUTING,
  AGENT_STATUS.VERIFYING, AGENT_STATUS.RECOVERING,
].includes(status);

/** §49 — waiting, and on whom. Never rendered as working. */
export const isWaiting = (status) => [
  AGENT_STATUS.WAITING_FOR_APPROVAL, AGENT_STATUS.WAITING_FOR_USER,
  AGENT_STATUS.WAITING_FOR_SYSTEM, AGENT_STATUS.BLOCKED,
].includes(status);

/**
 * Pick the most significant of several observed statuses (§13).
 *
 * Total: an unknown word ranks below everything and an empty list is IDLE, so
 * a status this file has never heard of can never win the comparison and be
 * shown as if the projection understood it.
 */
export function mostSignificant(statuses = []) {
  let best = null;
  let bestRank = Infinity;
  for (const s of statuses) {
    const rank = STATUS_PRECEDENCE.indexOf(s);
    if (rank === -1) continue;
    if (rank < bestRank) { bestRank = rank; best = s; }
  }
  return best ?? AGENT_STATUS.IDLE;
}

/**
 * The one shape everything in this directory produces (§6).
 *
 * `id` is a DURABLE IDENTITY and §11 turns on it: the client keys its timeline
 * by this string, so re-reading the same projection — after a reconnect, after
 * a refresh, twice in a row — yields the same events rather than three copies
 * of one tool execution.
 *
 * `metadata` is whatever the source row carried that the panel needs. It is
 * REDACTED by the projection before it ever leaves the server (§59); this
 * function does not redact, because it is the shape, not the boundary.
 */
export function activityEvent({
  id, taskId, seq, timestamp, type, status, title, summary = null, metadata = null,
}) {
  if (!ACTIVITY_TYPES.includes(type)) throw new Error(`unknown activity type "${type}"`);
  if (!ACTIVITY_STATUSES.includes(status)) throw new Error(`unknown activity status "${status}"`);
  return Object.freeze({
    id: String(id),
    task_id: taskId ?? null,
    seq: Number.isFinite(seq) ? seq : 0,
    timestamp: timestamp ?? null,
    type,
    status,
    title: String(title ?? ''),
    summary: summary === null || summary === undefined ? null : String(summary),
    metadata: metadata ?? null,
  });
}
