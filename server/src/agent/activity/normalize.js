import { ACTIVITY_TYPE, ACTIVITY_STATUS, activityEvent } from './schemas.js';

/**
 * EXPERIENCE — ONE SSE FRAME BECOMES ONE ACTIVITY EVENT, OR NONE.
 *
 * §7 asks the workspace to prefer events that actually exist, and §8 forbids
 * displaying anything the backend did not do. So this file is a TOTAL MAP over
 * the frame vocabulary the agent workspace can receive, and it has exactly two
 * kinds of entry:
 *
 *   a descriptor   this frame is an activity event, of this type and status
 *   null           this frame is real, and is NOT activity
 *
 * The second kind is the load-bearing one. `budget`, `meta`, `compacted` and
 * `context_profile` are genuine frames carrying genuine information, and none
 * of them is a thing the agent DID — rendering them in the timeline would fill
 * it with housekeeping and, worse, would make the timeline's length stop
 * meaning anything. Declaring them null is a decision recorded in code rather
 * than an omission, and `test/experience-safety.test.js` asserts that every
 * frame the live source can emit appears here as one or the other. A new frame
 * added to the orchestrator without a decision here is a test failure, not a
 * silently dropped event.
 *
 * NOTHING HERE INVENTS. Every title is derived from the frame's own fields; a
 * frame that does not carry a name gets a generic title naming its own type,
 * never a guess at what the agent was "probably" doing.
 *
 * ═══ IDENTITY, AND WHY IT IS NOT THE DURABLE IDENTITY ═══
 *
 * §11 requires deduplication by durable event identity. A LIVE frame does not
 * have one: a tool call arrives carrying the model's call id, while the row it
 * eventually writes is keyed `(session, seq)`. The two name the same real event
 * and cannot be reconciled without inventing a mapping neither side stores.
 *
 * So the live identity is `<type>:<taskId>:<frame key>` and the durable one is
 * `<type>:<taskId>:<row key>` (see project.js), and they are NEVER merged.
 * Reconnect and refresh REPLACE the timeline from the durable projection rather
 * than appending to it — which is a stronger guarantee than de-duplicating a
 * merge, because there is no merge in which a duplicate could appear. What the
 * keying does buy, and what §11 actually asks for, is that repeated frames
 * about ONE call — `tool_use` then `tool_result` — land on one event and patch
 * it, instead of showing the same execution twice.
 */

/** The two halves of a tool call share an id, so they share an activity event. */
const toolKey = (f) => f?.id ?? f?.name ?? 'tool';

/** A step's identity is the plan-local step id, which is stable across retries. */
const stepKey = (f) => f?.stepId ?? f?.step?.id ?? f?.id ?? 'step';

const truncate = (s, n = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}...` : t;
};

/** null rather than an empty string, so a missing summary renders as absent. */
const orNull = (s) => (s ? s : null);

/**
 * The map. Each descriptor is `(frame) => ({ type, status, key, title, summary })`
 * or `null` for "real frame, not activity".
 *
 * §47 — the titles are concise and action-oriented, and every one of them names
 * something that demonstrably happened. "Reading incident" is allowed because a
 * read ran; "Thinking deeply about the problem" is not, and there is nowhere in
 * this map it could be written.
 */
export const FRAME_MAP = Object.freeze({
  /* ---- the turn itself ---- */
  task_started: (f) => ({
    type: ACTIVITY_TYPE.TASK, status: ACTIVITY_STATUS.RUNNING, key: `start:${f.taskId ?? ''}`,
    title: 'Task started',
  }),
  done: () => ({ type: ACTIVITY_TYPE.TASK, status: ACTIVITY_STATUS.COMPLETED, key: 'end', title: 'Task completed' }),
  error: (f) => ({
    type: ACTIVITY_TYPE.TASK, status: ACTIVITY_STATUS.FAILED, key: 'end',
    title: 'Task failed', summary: orNull(truncate(f.message)),
  }),
  cancelled: (f) => ({
    type: ACTIVITY_TYPE.TASK, status: ACTIVITY_STATUS.CANCELLED, key: 'end',
    title: 'Task cancelled', summary: orNull(truncate(f.reason ?? f.message ?? null)),
  }),
  stalled_turn_ended: (f) => ({
    type: ACTIVITY_TYPE.TASK, status: ACTIVITY_STATUS.FAILED, key: 'stalled',
    title: 'Turn ended without progress', summary: orNull(truncate(f.reason ?? f.message ?? null)),
  }),
  /*
   * §49 — the turn asked a question and stopped. NOT working, and not an
   * approval either: nobody is being asked to authorise anything.
   */
  awaiting_user: (f) => ({
    type: ACTIVITY_TYPE.TASK, status: ACTIVITY_STATUS.BLOCKED, key: 'awaiting_user',
    title: 'Waiting for you', summary: orNull(truncate(f.question ?? f.message ?? null)),
  }),

  /* ---- tools (§20) ---- */
  tool_use: (f) => ({
    type: ACTIVITY_TYPE.TOOL, status: ACTIVITY_STATUS.RUNNING, key: toolKey(f),
    title: f.name ? String(f.name) : 'Tool call', summary: null,
  }),
  /*
   * §21 — the error summary comes from the backend's own structured result.
   * `isError` decides, never a heuristic over the output text: a tool whose
   * result merely CONTAINS the word "failed" has not failed, and reading it as
   * such would change the meaning of the backend's answer.
   */
  tool_result: (f) => ({
    type: ACTIVITY_TYPE.TOOL,
    status: f.isError ? ACTIVITY_STATUS.FAILED : ACTIVITY_STATUS.COMPLETED,
    key: toolKey(f),
    title: f.name ? String(f.name) : 'Tool result',
    summary: f.isError ? orNull(truncate(f.output ?? f.message ?? null)) : null,
  }),
  tool_blocked: (f) => ({
    type: ACTIVITY_TYPE.TOOL, status: ACTIVITY_STATUS.BLOCKED, key: toolKey(f),
    title: f.name ? String(f.name) : 'Tool blocked', summary: orNull(truncate(f.message ?? f.reason ?? null)),
  }),
  tool_not_in_context: (f) => ({
    type: ACTIVITY_TYPE.TOOL, status: ACTIVITY_STATUS.BLOCKED, key: `ctx:${toolKey(f)}`,
    title: f.name ? String(f.name) : 'Tool not offered',
    summary: 'Not in this turn’s tool set — the full set is now available.',
  }),
  mutation_bounced: (f) => ({
    type: ACTIVITY_TYPE.TOOL, status: ACTIVITY_STATUS.BLOCKED, key: `bounced:${toolKey(f)}`,
    title: f.name ? `${f.name} bounced` : 'Mutation bounced', summary: orNull(truncate(f.message ?? f.reason ?? null)),
  }),
  mutations_held: (f) => ({
    type: ACTIVITY_TYPE.TOOL, status: ACTIVITY_STATUS.BLOCKED, key: 'mutations_held',
    title: 'Mutations held', summary: truncate(f.reason ?? f.message ?? 'A question was asked in the same turn.'),
  }),
  calls_discarded: (f) => ({
    type: ACTIVITY_TYPE.TOOL, status: ACTIVITY_STATUS.CANCELLED, key: 'discarded',
    title: 'Queued tool calls discarded', summary: orNull(truncate(f.reason ?? f.message ?? null)),
  }),
  guard_forced: (f) => ({
    type: ACTIVITY_TYPE.TOOL, status: ACTIVITY_STATUS.BLOCKED, key: `guard:${f.guard ?? 'turn'}`,
    title: 'Turn-control guard fired', summary: orNull(truncate(f.message ?? f.reason ?? null)),
  }),

  /* ---- approvals (§22) ---- */
  approval_required: (f) => ({
    type: ACTIVITY_TYPE.APPROVAL, status: ACTIVITY_STATUS.RUNNING, key: f.approvalId ?? f.id ?? 'approval',
    title: 'Approval required', summary: f.name ? `for ${f.name}` : null,
  }),
  approval_resolved: (f) => ({
    type: ACTIVITY_TYPE.APPROVAL,
    status: f.approved ? ACTIVITY_STATUS.COMPLETED : ACTIVITY_STATUS.FAILED,
    key: f.approvalId ?? f.id ?? 'approval',
    title: f.approved ? 'Approval granted' : 'Approval rejected',
    summary: f.source ? `decided by ${f.source}` : null,
  }),
  approval_cancelled: (f) => ({
    type: ACTIVITY_TYPE.APPROVAL, status: ACTIVITY_STATUS.CANCELLED, key: f.approvalId ?? f.id ?? 'approval',
    title: 'Approval never decided', summary: 'The turn stopped while the card was open.',
  }),
  approve_token_mismatch: (f) => ({
    type: ACTIVITY_TYPE.APPROVAL, status: ACTIVITY_STATUS.BLOCKED, key: `mismatch:${f.approvalId ?? 'approval'}`,
    title: 'Approval refused',
    summary: `the request carried ${f.presented === 'absent' ? 'no token' : 'a different token'} — still pending`,
  }),
  await_new_approval: () => ({
    type: ACTIVITY_TYPE.APPROVAL, status: ACTIVITY_STATUS.RUNNING, key: 'stale',
    /* §24 — the plan changed, so the old approval no longer covers it. */
    title: 'Approval expired', summary: 'The plan changed after it was approved.',
  }),
  review_required: () => ({
    type: ACTIVITY_TYPE.APPROVAL, status: ACTIVITY_STATUS.RUNNING, key: 'review',
    title: 'Plan review required',
  }),

  /* ---- plan lifecycle (§16) ---- */
  plan_created: (f) => ({
    type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'created',
    title: 'Plan created', summary: Number.isFinite(f.steps) ? `${f.steps} step${f.steps === 1 ? '' : 's'}` : null,
  }),
  plan_ready: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'ready', title: 'Plan validated' }),
  plan_started: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.RUNNING, key: 'exec', title: 'Executing plan' }),
  plan_completed: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'exec', title: 'Plan completed' }),
  plan_failed: (f) => ({
    type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.FAILED, key: 'exec',
    title: 'Plan failed', summary: orNull(truncate(f.message ?? f.reason ?? null)),
  }),
  plan_cancelled: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.CANCELLED, key: 'exec', title: 'Plan cancelled' }),

  /* ---- steps (§16, §18) ---- */
  step_started: (f) => ({
    type: ACTIVITY_TYPE.STEP, status: ACTIVITY_STATUS.RUNNING, key: stepKey(f),
    title: f.description ? truncate(f.description, 80) : `Step ${stepKey(f)}`,
    summary: f.operation ? String(f.operation) : null,
  }),
  step_completed: (f) => ({
    type: ACTIVITY_TYPE.STEP, status: ACTIVITY_STATUS.COMPLETED, key: stepKey(f),
    title: f.description ? truncate(f.description, 80) : `Step ${stepKey(f)}`,
  }),
  step_failed: (f) => ({
    type: ACTIVITY_TYPE.STEP, status: ACTIVITY_STATUS.FAILED, key: stepKey(f),
    title: f.description ? truncate(f.description, 80) : `Step ${stepKey(f)}`,
    summary: orNull(truncate(f.message ?? f.reason ?? null)),
  }),
  step_awaiting_approval: (f) => ({
    type: ACTIVITY_TYPE.APPROVAL, status: ACTIVITY_STATUS.RUNNING, key: `step:${stepKey(f)}`,
    title: 'Approval required', summary: f.description ? truncate(f.description, 80) : null,
  }),
  /* §19 — the resolver's own record of what a `$ref` became. */
  step_dataflow_resolved: (f) => ({
    type: ACTIVITY_TYPE.STEP, status: ACTIVITY_STATUS.RUNNING, key: `dataflow:${stepKey(f)}`,
    title: 'Reference resolved', summary: orNull(truncate(f.reference ?? null)),
  }),
  step_outputs: null,

  /* ---- verification (§27) ---- */
  step_verification_started: (f) => ({
    type: ACTIVITY_TYPE.VERIFICATION, status: ACTIVITY_STATUS.RUNNING, key: stepKey(f),
    title: 'Verifying', summary: f.strategy ? String(f.strategy) : null,
  }),
  step_verified: (f) => ({
    type: ACTIVITY_TYPE.VERIFICATION,
    status: f.verdict === 'verified' ? ACTIVITY_STATUS.COMPLETED : ACTIVITY_STATUS.FAILED,
    key: stepKey(f),
    /* The verdict is the backend's word, copied. §79.3 turns on this line. */
    title: `Verification: ${f.verdict ?? 'unknown'}`,
    summary: orNull(truncate(f.detail ?? f.message ?? null)),
  }),

  /* ---- recovery (§12) ---- */
  recovery_retry_started: (f) => ({
    type: ACTIVITY_TYPE.RECOVERY, status: ACTIVITY_STATUS.RUNNING, key: `retry:${stepKey(f)}`,
    title: 'Retrying', summary: orNull(truncate(f.reason ?? null)),
  }),
  recovery_stopped: (f) => ({
    type: ACTIVITY_TYPE.RECOVERY, status: ACTIVITY_STATUS.COMPLETED, key: `stopped:${stepKey(f)}`,
    title: 'Recovery stopped', summary: orNull(truncate(f.reason ?? null)),
  }),
  recovery_decision: (f) => ({
    type: ACTIVITY_TYPE.RECOVERY, status: ACTIVITY_STATUS.COMPLETED, key: `decision:${stepKey(f)}`,
    title: 'Recovery decision', summary: orNull(truncate(f.decision ?? f.action ?? null)),
  }),
  replan: () => ({ type: ACTIVITY_TYPE.RECOVERY, status: ACTIVITY_STATUS.RUNNING, key: 'replan', title: 'Re-planning' }),
  retry_identical: (f) => ({
    type: ACTIVITY_TYPE.RECOVERY, status: ACTIVITY_STATUS.BLOCKED, key: `identical:${stepKey(f)}`,
    title: 'Identical retry refused', summary: orNull(truncate(f.reason ?? null)),
  }),
  reconcile: (f) => ({
    type: ACTIVITY_TYPE.RECOVERY, status: ACTIVITY_STATUS.RUNNING, key: `reconcile:${stepKey(f)}`,
    title: 'Reconciling state', summary: orNull(truncate(f.reason ?? null)),
  }),

  /* ---- the domain skills, each announcing what it actually did ---- */
  investigation_started: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.RUNNING, key: 'diag', title: 'Investigating' }),
  diagnosis: null,
  diagnosis_complete: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'diag', title: 'Diagnosis complete' }),
  lint_started: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.RUNNING, key: 'lint', title: 'Linting' }),
  lint_complete: (f) => ({
    type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'lint',
    title: 'Lint complete',
    summary: Number.isFinite(f.findings) ? `${f.findings} finding${f.findings === 1 ? '' : 's'}` : null,
  }),
  test_flow_identified: (f) => ({
    type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'test:flow',
    title: 'Flow identified', summary: orNull(truncate(f.flow?.name ?? null)),
  }),
  test_contract: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'test:contract', title: 'Test contract read' }),
  test_plan_ready: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'test:plan', title: 'Test plan ready' }),
  test_started: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.RUNNING, key: 'test:run', title: 'Running the test' }),
  test_cleanup_started: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.RUNNING, key: 'test:cleanup', title: 'Cleaning up test records' }),
  test_decided: null,
  test_complete: (f) => ({
    type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'test:run',
    title: 'Test complete', summary: orNull(truncate(f.test?.verdict ?? null)),
  }),
  change_artifact_identified: (f) => ({
    type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'change:artifact',
    title: 'Artifact identified', summary: orNull(truncate(f.artifact?.name ?? null)),
  }),
  change_states_read: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'change:states', title: 'Both states read' }),
  change_baseline_captured: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'change:baseline', title: 'Baseline captured' }),
  change_decided: null,
  change_complete: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'change:done', title: 'Comparison complete' }),
  knowledge_answered: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'knowledge', title: 'Knowledge retrieved' }),
  knowledge_complete: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'knowledge:done', title: 'Answer assembled' }),
  appbuild_requirements: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'ab:req', title: 'Requirements parsed' }),
  appbuild_discovered: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'ab:disc', title: 'Instance inspected' }),
  appbuild_capability: (f) => ({
    type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'ab:cap',
    title: 'Capabilities checked',
    summary: Number.isFinite(f.summary?.executable) ? `${f.summary.executable} buildable` : null,
  }),
  appbuild_plan_ready: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'ab:plan', title: 'Build plan ready' }),
  appbuild_decided: null,
  appbuild_complete: () => ({ type: ACTIVITY_TYPE.PLAN, status: ACTIVITY_STATUS.COMPLETED, key: 'ab:done', title: 'Build concluded' }),

  /* ---- real frames that are NOT activity (§7: do not invent execution) ---- */
  /*
   * §46 — which skills are active for this turn. Context, not an action: the
   * header renders it, the timeline does not, because "the Doctor is enabled"
   * is not something the agent DID.
   */
  skills_active: null,
  meta: null,
  budget: null,
  compacted: null,
  context_profile: null,
  knowledge: null,
  remembered: null,
  assistant_text: null,
  capture: null,
  mutation_report: null,
  nudged: null,
  intent: null,
  impersonation_boundary: null,
  impersonation_boundary_stop: null,
  impersonation_boundary_resolved: null,
  impersonation_provenance_failed: null,
});

/** Every frame type this module has an opinion about. */
export const KNOWN_FRAMES = Object.freeze(Object.keys(FRAME_MAP));

/** The subset that produces a timeline entry. */
export const ACTIVITY_FRAMES = Object.freeze(KNOWN_FRAMES.filter((k) => typeof FRAME_MAP[k] === 'function'));

/**
 * Turn one frame into one activity event, or null.
 *
 * `seq` is supplied by the CALLER — a monotone counter over the stream — rather
 * than derived here, because the projection and the live stream number their
 * events from different places and neither may guess at the other's.
 *
 * An UNKNOWN frame returns null. That is deliberately the safe direction: a
 * frame this map has never seen produces no timeline entry at all, rather than
 * a generically-titled one implying the agent did something the workspace
 * cannot name. The test suite is what stops that silence being permanent.
 */
export function fromFrame(frame, { taskId = null, seq = 0, timestamp = null } = {}) {
  const type = frame?.type;
  if (!type) return null;
  const entry = FRAME_MAP[type];
  if (typeof entry !== 'function') return null;   // unknown, or declared non-activity
  let d;
  try { d = entry(frame); } catch { return null; }
  if (!d) return null;
  return activityEvent({
    id: `${d.type}:${taskId ?? 'live'}:${d.key}`,
    taskId,
    seq,
    timestamp: timestamp ?? new Date().toISOString(),
    type: d.type,
    status: d.status,
    title: d.title,
    summary: d.summary ?? null,
    metadata: d.metadata ?? null,
  });
}

/**
 * §11 — collapse a list to one event per identity, keeping the LATEST.
 *
 * Latest, not first: `tool_use` then `tool_result` are two frames about one
 * execution, and the second is the one that knows how it ended. Order is
 * preserved by first appearance, so a running tool does not jump to the bottom
 * of the timeline at the moment it completes.
 */
export function dedupe(events = []) {
  const order = [];
  const byId = new Map();
  for (const e of events) {
    if (!e?.id) continue;
    if (!byId.has(e.id)) order.push(e.id);
    byId.set(e.id, e);
  }
  return order.map((id) => byId.get(id));
}
