import { tasksForSession, getTask, stepsForTask } from '../../memory/tasks.js';
import { agentStatus, planProgress } from './status.js';

/**
 * EXPERIENCE — the activity read model's public surface.
 *
 * A READ MODEL AND NOTHING ELSE. There is no writer anywhere below this file:
 * no INSERT, no UPDATE, no transition function, no ServiceNow client and no
 * approval. §73 forbids the Experience layer owning execution, verification,
 * approval, recovery, the task state machine or the evidence store, and the way
 * that is guaranteed is that the capability is absent rather than unused —
 * `test/experience-safety.test.js` asserts it against the import graph.
 */

export {
  ACTIVITY_TYPE, ACTIVITY_TYPES, ACTIVITY_STATUS, ACTIVITY_STATUSES,
  AGENT_STATUS, AGENT_STATUSES, STATUS_PRECEDENCE, TERMINAL_AGENT_STATUSES,
  isWorking, isWaiting, mostSignificant, activityEvent,
} from './schemas.js';

export { FRAME_MAP, KNOWN_FRAMES, ACTIVITY_FRAMES, fromFrame, dedupe } from './normalize.js';
export { agentStatus, planProgress } from './status.js';
export { activityForTask } from './project.js';

/**
 * §51 — past tasks for a session, newest first.
 *
 * Built on the EXISTING durable task table, which is what §51 asks for in as
 * many words: "Use existing durable task/audit data. Do not create another task
 * database." Each row carries the same derived status the live workspace shows,
 * so a completed task reads identically whether it is being watched or reopened
 * a week later.
 *
 * Deliberately does NOT include the events. A history list that loaded every
 * timeline would read hundreds of rows to render a dozen lines; the timeline is
 * fetched when a task is opened (§52), and opening one re-executes nothing.
 */
export function taskHistory(sessionId, { limit = 50 } = {}) {
  return tasksForSession(sessionId, { limit }).map((t) => {
    const steps = stepsForTask(t.id);
    return {
      task_id: t.id,
      goal: t.goal ?? null,
      state: t.state,
      plan_state: t.plan_state ?? null,
      status: agentStatus(t, steps),
      created_at: t.created_at,
      completed_at: t.completed_at ?? t.cancelled_at ?? null,
      failure_reason: t.failure_reason ?? null,
      progress: planProgress(steps),
      skills: Array.isArray(t.metadata?.skills) ? t.metadata.skills : [],
    };
  });
}

/**
 * The status of one task, without building its timeline.
 *
 * The cheap call: the header's live indicator needs a word, not a hundred
 * events. Returns IDLE for a task that does not exist, because "no task" is
 * what IDLE means and a 404 for a status poll would be noise.
 */
export function statusForTask(taskId) {
  const task = taskId ? getTask(taskId) : null;
  if (!task) return { task_id: taskId ?? null, status: agentStatus(null), state: null };
  const steps = stepsForTask(task.id);
  return {
    task_id: task.id,
    status: agentStatus(task, steps),
    state: task.state,
    plan_state: task.plan_state ?? null,
    progress: planProgress(steps),
  };
}
