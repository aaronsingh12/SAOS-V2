import { log, shortId } from '../logging.js';
import {
  createTask, createStep,
  startTask, startStep,
  completeTask, completeStep,
  failTask, failStep,
  cancelTask, cancelStep,
  markTaskAwaitingApproval, markStepAwaitingApproval,
  resumeTask, resumeStep,
} from '../memory/tasks.js';

/**
 * PHASE 1 — the task lifecycle, as a PROJECTION of the turn's own event stream.
 *
 * THE DESIGN DECISION THIS FILE IS. `runTurn` already announces everything the
 * task layer needs to know. It emits exactly one terminal frame — `done`,
 * `error` or `cancelled`, an invariant Phase 0 tightened and the SSE reader
 * enforces at the other end — and it emits `approval_required` when a card goes
 * up and `approval_resolved` / `approval_cancelled` when one comes down. So the
 * task lifecycle can be derived from what the turn already says, rather than by
 * threading state through the loop.
 *
 * That is worth more than tidiness. It means:
 *
 *   - `runTurn` is not modified at all. Its control flow, its six turn-control
 *     guards, its approval gate, its cancellation boundaries and its
 *     finalisation paths are byte-for-byte what Phase 0 left. There is no new
 *     way for the loop to end, and no new way for it to fail.
 *   - the dependency arrow stays pointing down. The orchestrator does not know
 *     tasks exist; the task layer watches its output. Reverse that and the
 *     execution layer starts depending on orchestration, which is the one
 *     direction §19 forbids.
 *   - the projection cannot desynchronise from the turn, because it is reading
 *     the turn's own account of itself rather than keeping a second one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not plan, decompose, retry, resume,
 * checkpoint or schedule. It creates one task and one step per user turn and
 * moves them through states the turn reaches on its own. Provider retries live
 * inside the adapter, below `chatTurn`; tool calls and iterations live inside
 * the loop. None of them reach this file, which is why "1 turn -> 1 task -> 1
 * step" is structural rather than something a counter has to enforce.
 *
 * NOTHING HERE THROWS. `observe` runs inside `emit`, on the path that streams
 * to the user, and a bookkeeping failure must never take a turn with it — by
 * the time these run, whatever is being recorded has already happened. The
 * store swallows and logs; this adds a second net around the projection itself.
 */

/**
 * The frames that move a task, and the only ones this reads.
 *
 * Everything else in the stream — `assistant_text`, `tool_use`, `tool_result`,
 * `budget`, `meta`, `mutation_report` and the rest — is ignored outright. Not
 * for want of interest: a turn emits dozens of those, each would cost a write,
 * and none of them changes what state the TURN is in. §18 asks for negligible
 * overhead, and the cheapest way to get it is to touch the database only when
 * the lifecycle actually moves.
 */
const LIFECYCLE_FRAMES = Object.freeze([
  'approval_required',
  'approval_resolved',
  'approval_cancelled',
  'done',
  'error',
  'cancelled',
]);

/**
 * Open a task and its first step for one logical user turn, both running.
 *
 * "Logical user turn" is the unit, and the caller is one HTTP request — which
 * is what makes the idempotency requirement structural. A provider retry
 * happens inside `withRetry` in the adapter; an iteration happens inside the
 * loop; a tool call happens inside an iteration. None of them can reach here,
 * so none of them can mint a task.
 *
 * A client-initiated Retry (`POST /chat { retry: true }`) DOES arrive as a new
 * request and therefore gets a new task. That is the honest reading: it is a
 * second execution, and folding it into the first task's record would mean
 * reopening a task that had already terminated — which is task-level retry,
 * and task-level retry is explicitly not part of this phase. The request is
 * marked in the task's metadata so the two can be told apart later, and no
 * pointer is stored between them, because a pointer would imply a relationship
 * the schema does not yet model.
 *
 * Returns a tracker whose ids may be null: if the store could not write, the
 * turn still runs and the tracker becomes inert. Losing the projection is a
 * defect worth logging loudly, not a reason to refuse work.
 */
export function beginTurn({ sessionId, goal = null, retry = false, skills = null } = {}) {
  /*
   * EXPERIENCE §44/§45 — THE SKILL SET THIS TURN RAN UNDER, RECORDED AT OPEN.
   *
   * §45's rule is that enabling or disabling a skill mid-task must not mutate
   * the running task's execution contract; future planning uses the new set.
   * That is only enforceable if the task's set is a SNAPSHOT rather than a
   * lookup, so it is written into `metadata_json` — an existing column, no
   * migration — at the moment the task opens.
   *
   * The consequence, which is the point: the activity projection reads this
   * back from the TASK, never from the live registry. A skill turned off an
   * hour later cannot make a completed run appear to have been done without it.
   */
  const metadata = {};
  if (retry) metadata.retry = true;
  if (Array.isArray(skills) && skills.length) metadata.skills = skills;

  const task = createTask({
    sessionId,
    goal,
    metadata: Object.keys(metadata).length ? metadata : null,
  });
  const step = task
    ? createStep({
      taskId: task.id,
      kind: 'turn',
      // The whole turn is one step in this phase, and the description says so
      // rather than leaving a future reader to infer it from a lone row.
      description: 'One agent turn, executed by runTurn()',
    })
    : null;

  if (task) startTask(task.id);
  if (step) startStep(step.id);

  if (!task || !step) {
    log.error('tasks', `turn is running WITHOUT a task record  session=${shortId(sessionId)}`
      + ` (task=${task ? 'ok' : 'FAILED'}, step=${step ? 'ok' : 'FAILED'})`);
  } else {
    log.debug('tasks', `task ${shortId(task.id)} step ${step.sequence} running  session=${shortId(sessionId)}`);
  }

  const taskId = task?.id ?? null;
  const stepId = step?.id ?? null;
  // Guards the settle() net below: once a terminal frame has been projected,
  // nothing may overwrite it. Local to this tracker — there is no registry, no
  // map keyed by session, and nothing process-global (§16).
  let settled = false;

  const both = (taskFn, stepFn, ...args) => {
    try {
      if (taskId) taskFn(taskId, ...args);
      if (stepId) stepFn(stepId, ...args);
    } catch (err) {
      log.error('tasks', `task projection failed: ${err.message}`, err);
    }
  };

  return {
    taskId,
    stepId,

    /**
     * Project one emitted frame onto the task and its step.
     *
     * Called for EVERY frame, and returns immediately for the overwhelming
     * majority of them. The two states it drives are the two the turn actually
     * has: waiting for a person, and finished.
     */
    observe(event) {
      const type = event?.type;
      if (!type || !LIFECYCLE_FRAMES.includes(type)) return;
      switch (type) {
        case 'approval_required':
          // The turn has stopped and is waiting for a human. Projected, never
          // interpreted: the approval decision object itself is untouched and
          // still belongs entirely to the orchestrator.
          both(markTaskAwaitingApproval, markStepAwaitingApproval);
          break;
        case 'approval_resolved':
        case 'approval_cancelled':
          // The card came down — approved, rejected, timed out or cancelled.
          // All four mean the same thing HERE: nobody is being waited on any
          // more. What the decision WAS stays the orchestrator's business.
          both(resumeTask, resumeStep);
          break;
        case 'done':
          settled = true;
          both(completeTask, completeStep);
          break;
        case 'cancelled':
          settled = true;
          both(cancelTask, cancelStep);
          break;
        case 'error':
          settled = true;
          // The reason is the turn's own message, copied. This phase does not
          // classify failures — it records the classification already made.
          both(failTask, failStep, event.message || null);
          break;
        default:
          break;
      }
    },

    /**
     * The net, run from the route's `finally`.
     *
     * A stream that ends without a terminal frame is not a possibility this
     * codebase tolerates — `sse()` throws on it at the client, and the route
     * emits one on every path including its outer catch. So reaching here
     * unsettled means the invariant broke, and the honest projection is
     * `failed` with a reason that names what happened rather than a task left
     * `running` forever by a request that has demonstrably ended.
     *
     * NOT a crash handler. A process that DIES mid-turn never runs this, and
     * §17 wants exactly that: the row stays `running`, durable and observable,
     * for a recovery phase to decide about.
     */
    settle() {
      if (settled) return;
      settled = true;
      log.error('tasks', `turn ended with no terminal frame  session=${shortId(sessionId)}`
        + ` task=${taskId ? shortId(taskId) : 'none'} — recording it as failed`);
      both(failTask, failStep, 'The turn ended without emitting a terminal frame.');
    },
  };
}
