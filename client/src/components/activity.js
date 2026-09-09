/**
 * THE WORKSPACE'S VIEW OF WHAT THE AGENT IS DOING.
 *
 * A SECOND COPY OF A SERVER VOCABULARY IS A LIABILITY, so this one is guarded
 * rather than trusted: `server/test/experience-client.test.js` reads this file
 * and asserts that every activity frame the server can normalise appears in
 * `FRAME_MAP` below, and that the status words here are exactly the server's.
 * A frame added to the orchestrator without a decision here fails that test.
 *
 * WHY A COPY EXISTS AT ALL. The live timeline has to render as frames arrive,
 * and asking the server to re-project after every frame would mean a round trip
 * per tool call. So the client maps frames locally while streaming, and the
 * SERVER's projection is authoritative for everything else — refresh, reconnect
 * and reopening a past task all REPLACE the timeline from
 * `GET /api/agent/plan/:taskId/activity` rather than merging into it.
 *
 * That replacement is what makes §11 hold. A live event and its durable row
 * have different identities — the model's call id versus `(session, seq)` — and
 * no merge of the two could avoid duplicating; there is simply no merge.
 *
 * NOTHING HERE INVENTS STATE. Every entry maps a frame the backend actually
 * emitted. There is no timer, no optimistic transition and no "probably
 * finished by now": if the backend never said it, the workspace never shows it.
 */

export const ACTIVITY_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
});

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

/** §13 — most significant first. Identical to the server's, and asserted so. */
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

/**
 * §12/§48/§49 — what the header says, and whether it may animate.
 *
 * `spin` is false for every waiting state. §48 is explicit that a permanent
 * animated spinner while the turn is waiting for approval or user input is
 * wrong, because those are different states from working — and the label says
 * WHO is being waited on rather than leaving the user to guess.
 */
export const STATUS_LABEL = Object.freeze({
  IDLE: { text: 'Idle', tone: 'idle', spin: false },
  THINKING: { text: 'Thinking', tone: 'busy', spin: true },
  PLANNING: { text: 'Planning', tone: 'busy', spin: true },
  EXECUTING: { text: 'Executing', tone: 'busy', spin: true },
  VERIFYING: { text: 'Verifying', tone: 'busy', spin: true },
  RECOVERING: { text: 'Recovering', tone: 'warn', spin: true },
  WAITING_FOR_APPROVAL: { text: 'Waiting for approval', tone: 'warn', spin: false },
  WAITING_FOR_USER: { text: 'Waiting for you', tone: 'warn', spin: false },
  WAITING_FOR_SYSTEM: { text: 'Waiting on the system', tone: 'warn', spin: false },
  BLOCKED: { text: 'Blocked', tone: 'warn', spin: false },
  COMPLETED: { text: 'Completed', tone: 'ok', spin: false },
  FAILED: { text: 'Failed', tone: 'bad', spin: false },
  CANCELLED: { text: 'Cancelled', tone: 'idle', spin: false },
});

/** The glyph beside a timeline row. Status only — never a guess at intent. */
export const STATUS_MARK = Object.freeze({
  queued: '○',
  running: '⟳',
  completed: '✓',
  failed: '✗',
  blocked: '⊘',
  cancelled: '—',
});

const S = ACTIVITY_STATUS;
const T = (s) => s;
const trim = (v, n = 140) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}...` : t;
};
const orNull = (v) => (v ? v : null);

/** A tool's two frames share the model's call id, so they share one row. */
const toolKey = (f) => f?.id ?? f?.name ?? 'tool';
const stepKey = (f) => f?.stepId ?? f?.step?.id ?? f?.id ?? 'step';

/**
 * frame type -> row, or null for "real frame, not activity".
 *
 * The `null` entries carry the same weight as the mapped ones: they are the
 * record of a decision that a frame is NOT something the agent did. `budget`,
 * `meta` and `compacted` are all genuine and none of them belongs in a list of
 * actions.
 */
export const FRAME_MAP = Object.freeze({
  task_started: (f) => ({ type: 'task', status: S.RUNNING, key: `start:${f.taskId ?? ''}`, title: 'Task started' }),
  done: () => ({ type: 'task', status: S.COMPLETED, key: 'end', title: 'Task completed' }),
  error: (f) => ({ type: 'task', status: S.FAILED, key: 'end', title: 'Task failed', summary: orNull(trim(f.message)) }),
  cancelled: (f) => ({ type: 'task', status: S.CANCELLED, key: 'end', title: 'Task cancelled', summary: orNull(trim(f.reason ?? f.message)) }),
  stalled_turn_ended: (f) => ({ type: 'task', status: S.FAILED, key: 'stalled', title: 'Turn ended without progress', summary: orNull(trim(f.reason ?? f.message)) }),
  awaiting_user: (f) => ({ type: 'task', status: S.BLOCKED, key: 'awaiting_user', title: 'Waiting for you', summary: orNull(trim(f.question ?? f.message)) }),

  tool_use: (f) => ({ type: 'tool', status: S.RUNNING, key: toolKey(f), title: T(f.name) || 'Tool call' }),
  tool_result: (f) => ({
    type: 'tool', status: f.isError ? S.FAILED : S.COMPLETED, key: toolKey(f),
    title: T(f.name) || 'Tool result',
    /* §21 — the backend's own error text, never a friendlier rewording. */
    summary: f.isError ? orNull(trim(f.output ?? f.message)) : null,
  }),
  tool_blocked: (f) => ({ type: 'tool', status: S.BLOCKED, key: toolKey(f), title: T(f.name) || 'Tool blocked', summary: orNull(trim(f.message ?? f.reason)) }),
  tool_not_in_context: (f) => ({ type: 'tool', status: S.BLOCKED, key: `ctx:${toolKey(f)}`, title: T(f.name) || 'Tool not offered', summary: 'Not in this turn’s tool set.' }),
  mutation_bounced: (f) => ({ type: 'tool', status: S.BLOCKED, key: `bounced:${toolKey(f)}`, title: f.name ? `${f.name} bounced` : 'Mutation bounced', summary: orNull(trim(f.message ?? f.reason)) }),
  mutations_held: (f) => ({ type: 'tool', status: S.BLOCKED, key: 'mutations_held', title: 'Mutations held', summary: trim(f.reason ?? f.message ?? 'A question was asked in the same turn.') }),
  calls_discarded: (f) => ({ type: 'tool', status: S.CANCELLED, key: 'discarded', title: 'Queued tool calls discarded', summary: orNull(trim(f.reason ?? f.message)) }),
  guard_forced: (f) => ({ type: 'tool', status: S.BLOCKED, key: `guard:${f.guard ?? 'turn'}`, title: 'Turn-control guard fired', summary: orNull(trim(f.message ?? f.reason)) }),

  approval_required: (f) => ({ type: 'approval', status: S.RUNNING, key: f.approvalId ?? f.id ?? 'approval', title: 'Approval required', summary: f.name ? `for ${f.name}` : null }),
  approval_resolved: (f) => ({
    type: 'approval', status: f.approved ? S.COMPLETED : S.FAILED, key: f.approvalId ?? f.id ?? 'approval',
    title: f.approved ? 'Approval granted' : 'Approval rejected', summary: f.source ? `decided by ${f.source}` : null,
  }),
  approval_cancelled: (f) => ({ type: 'approval', status: S.CANCELLED, key: f.approvalId ?? f.id ?? 'approval', title: 'Approval never decided', summary: 'The turn stopped while the card was open.' }),
  approve_token_mismatch: (f) => ({ type: 'approval', status: S.BLOCKED, key: `mismatch:${f.approvalId ?? 'approval'}`, title: 'Approval refused', summary: 'still pending' }),
  await_new_approval: () => ({ type: 'approval', status: S.RUNNING, key: 'stale', title: 'Approval expired', summary: 'The plan changed after it was approved.' }),
  review_required: () => ({ type: 'approval', status: S.RUNNING, key: 'review', title: 'Plan review required' }),

  plan_created: (f) => ({ type: 'plan', status: S.COMPLETED, key: 'created', title: 'Plan created', summary: Number.isFinite(f.steps) ? `${f.steps} step${f.steps === 1 ? '' : 's'}` : null }),
  plan_ready: () => ({ type: 'plan', status: S.COMPLETED, key: 'ready', title: 'Plan validated' }),
  plan_started: () => ({ type: 'plan', status: S.RUNNING, key: 'exec', title: 'Executing plan' }),
  plan_completed: () => ({ type: 'plan', status: S.COMPLETED, key: 'exec', title: 'Plan completed' }),
  plan_failed: (f) => ({ type: 'plan', status: S.FAILED, key: 'exec', title: 'Plan failed', summary: orNull(trim(f.message ?? f.reason)) }),
  plan_cancelled: () => ({ type: 'plan', status: S.CANCELLED, key: 'exec', title: 'Plan cancelled' }),

  step_started: (f) => ({ type: 'step', status: S.RUNNING, key: stepKey(f), title: f.description ? trim(f.description, 80) : `Step ${stepKey(f)}`, summary: orNull(f.operation) }),
  step_completed: (f) => ({ type: 'step', status: S.COMPLETED, key: stepKey(f), title: f.description ? trim(f.description, 80) : `Step ${stepKey(f)}` }),
  step_failed: (f) => ({ type: 'step', status: S.FAILED, key: stepKey(f), title: f.description ? trim(f.description, 80) : `Step ${stepKey(f)}`, summary: orNull(trim(f.message ?? f.reason)) }),
  step_awaiting_approval: (f) => ({ type: 'approval', status: S.RUNNING, key: `step:${stepKey(f)}`, title: 'Approval required', summary: f.description ? trim(f.description, 80) : null }),
  step_dataflow_resolved: (f) => ({ type: 'step', status: S.RUNNING, key: `dataflow:${stepKey(f)}`, title: 'Reference resolved', summary: orNull(trim(f.reference)) }),
  step_outputs: null,

  step_verification_started: (f) => ({ type: 'verification', status: S.RUNNING, key: stepKey(f), title: 'Verifying', summary: orNull(f.strategy) }),
  step_verified: (f) => ({
    type: 'verification', status: f.verdict === 'verified' ? S.COMPLETED : S.FAILED, key: stepKey(f),
    /* §79.3 — the backend's verdict, copied. The UI never decides "verified". */
    title: `Verification: ${f.verdict ?? 'unknown'}`, summary: orNull(trim(f.detail ?? f.message)),
  }),

  recovery_retry_started: (f) => ({ type: 'recovery', status: S.RUNNING, key: `retry:${stepKey(f)}`, title: 'Retrying', summary: orNull(trim(f.reason)) }),
  recovery_stopped: (f) => ({ type: 'recovery', status: S.COMPLETED, key: `stopped:${stepKey(f)}`, title: 'Recovery stopped', summary: orNull(trim(f.reason)) }),
  recovery_decision: (f) => ({ type: 'recovery', status: S.COMPLETED, key: `decision:${stepKey(f)}`, title: 'Recovery decision', summary: orNull(trim(f.decision ?? f.action)) }),
  replan: () => ({ type: 'recovery', status: S.RUNNING, key: 'replan', title: 'Re-planning' }),
  retry_identical: (f) => ({ type: 'recovery', status: S.BLOCKED, key: `identical:${stepKey(f)}`, title: 'Identical retry refused', summary: orNull(trim(f.reason)) }),
  reconcile: (f) => ({ type: 'recovery', status: S.RUNNING, key: `reconcile:${stepKey(f)}`, title: 'Reconciling state', summary: orNull(trim(f.reason)) }),

  investigation_started: () => ({ type: 'plan', status: S.RUNNING, key: 'diag', title: 'Investigating' }),
  diagnosis: null,
  diagnosis_complete: () => ({ type: 'plan', status: S.COMPLETED, key: 'diag', title: 'Diagnosis complete' }),
  lint_started: () => ({ type: 'plan', status: S.RUNNING, key: 'lint', title: 'Linting' }),
  lint_complete: (f) => ({ type: 'plan', status: S.COMPLETED, key: 'lint', title: 'Lint complete', summary: Number.isFinite(f.findings) ? `${f.findings} finding${f.findings === 1 ? '' : 's'}` : null }),
  test_flow_identified: (f) => ({ type: 'plan', status: S.COMPLETED, key: 'test:flow', title: 'Flow identified', summary: orNull(trim(f.flow?.name)) }),
  test_contract: () => ({ type: 'plan', status: S.COMPLETED, key: 'test:contract', title: 'Test contract read' }),
  test_plan_ready: () => ({ type: 'plan', status: S.COMPLETED, key: 'test:plan', title: 'Test plan ready' }),
  test_started: () => ({ type: 'plan', status: S.RUNNING, key: 'test:run', title: 'Running the test' }),
  test_cleanup_started: () => ({ type: 'plan', status: S.RUNNING, key: 'test:cleanup', title: 'Cleaning up test records' }),
  test_decided: null,
  test_complete: (f) => ({ type: 'plan', status: S.COMPLETED, key: 'test:run', title: 'Test complete', summary: orNull(trim(f.test?.verdict)) }),
  change_artifact_identified: (f) => ({ type: 'plan', status: S.COMPLETED, key: 'change:artifact', title: 'Artifact identified', summary: orNull(trim(f.artifact?.name)) }),
  change_states_read: () => ({ type: 'plan', status: S.COMPLETED, key: 'change:states', title: 'Both states read' }),
  change_baseline_captured: () => ({ type: 'plan', status: S.COMPLETED, key: 'change:baseline', title: 'Baseline captured' }),
  change_decided: null,
  change_complete: () => ({ type: 'plan', status: S.COMPLETED, key: 'change:done', title: 'Comparison complete' }),
  knowledge_answered: () => ({ type: 'plan', status: S.COMPLETED, key: 'knowledge', title: 'Knowledge retrieved' }),
  knowledge_complete: () => ({ type: 'plan', status: S.COMPLETED, key: 'knowledge:done', title: 'Answer assembled' }),
  appbuild_requirements: () => ({ type: 'plan', status: S.COMPLETED, key: 'ab:req', title: 'Requirements parsed' }),
  appbuild_discovered: () => ({ type: 'plan', status: S.COMPLETED, key: 'ab:disc', title: 'Instance inspected' }),
  appbuild_capability: (f) => ({ type: 'plan', status: S.COMPLETED, key: 'ab:cap', title: 'Capabilities checked', summary: Number.isFinite(f.summary?.executable) ? `${f.summary.executable} buildable` : null }),
  appbuild_plan_ready: () => ({ type: 'plan', status: S.COMPLETED, key: 'ab:plan', title: 'Build plan ready' }),
  appbuild_decided: null,
  appbuild_complete: () => ({ type: 'plan', status: S.COMPLETED, key: 'ab:done', title: 'Build concluded' }),

  /* Real frames that are NOT activity. */
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

/**
 * One frame -> one row, or null.
 *
 * An unknown frame produces nothing. That is the safe direction: a frame this
 * map has not seen must not become a generically-titled row implying the agent
 * did something the workspace cannot name.
 */
export function rowFromFrame(frame, { taskId = null, seq = 0 } = {}) {
  const entry = FRAME_MAP[frame?.type];
  if (typeof entry !== 'function') return null;
  let d;
  try { d = entry(frame); } catch { return null; }
  if (!d) return null;
  return {
    id: `${d.type}:${taskId ?? 'live'}:${d.key}`,
    seq,
    type: d.type,
    status: d.status,
    title: d.title,
    summary: d.summary ?? null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * §11 — one row per identity, in first-appearance order, keeping the latest.
 *
 * `tool_use` then `tool_result` are two frames about one execution; the second
 * knows how it ended and the first decides where it sits.
 */
export function mergeRows(rows, incoming) {
  const next = rows.slice();
  const at = next.findIndex((r) => r.id === incoming.id);
  if (at === -1) next.push(incoming);
  else next[at] = { ...next[at], ...incoming, seq: next[at].seq };
  return next;
}

/**
 * §12/§13 — the workspace status, from what is on screen and what the server said.
 *
 * `serverStatus` is authoritative when present: it is derived from the durable
 * rows by `agent/activity/status.js`, and the client's own reading is only used
 * while a turn is streaming and no projection has been fetched.
 *
 * The local reading is deliberately narrow — running, waiting for approval,
 * waiting for the user, or thinking — because those are the only four a frame
 * stream can establish without the tables. Anything finer would be a guess.
 */
export function deriveStatus({ running, stopping, rows = [], serverStatus = null, terminal = null }) {
  if (terminal) return terminal;
  if (!running) return serverStatus ?? AGENT_STATUS.IDLE;
  if (stopping) return AGENT_STATUS.CANCELLED;

  const live = rows.filter((r) => r.status === ACTIVITY_STATUS.RUNNING);
  const signals = [];
  if (rows.some((r) => r.type === 'approval' && r.status === ACTIVITY_STATUS.RUNNING)) {
    signals.push(AGENT_STATUS.WAITING_FOR_APPROVAL);
  }
  if (rows.some((r) => r.type === 'task' && r.status === ACTIVITY_STATUS.BLOCKED)) {
    signals.push(AGENT_STATUS.WAITING_FOR_USER);
  }
  if (live.some((r) => r.type === 'recovery')) signals.push(AGENT_STATUS.RECOVERING);
  if (live.some((r) => r.type === 'tool' || r.type === 'step')) signals.push(AGENT_STATUS.EXECUTING);
  if (live.some((r) => r.type === 'verification')) signals.push(AGENT_STATUS.VERIFYING);
  if (live.some((r) => r.type === 'plan')) signals.push(AGENT_STATUS.PLANNING);
  if (!signals.length) return AGENT_STATUS.THINKING;

  let best = AGENT_STATUS.THINKING;
  let rank = Infinity;
  for (const s of signals) {
    const r = STATUS_PRECEDENCE.indexOf(s);
    if (r !== -1 && r < rank) { rank = r; best = s; }
  }
  return best;
}
