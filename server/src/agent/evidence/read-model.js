import { getDb } from '../../memory/db.js';
import { loadBuildEvents } from '../../memory/audit.js';

/**
 * PHASE 5 — THE QUERY LAYER. Reads only.
 *
 * Every function here is a SELECT. There is no INSERT, no UPDATE, no DELETE and
 * no ServiceNow client in scope — the evidence layer cannot execute, approve,
 * elevate or modify anything, and the absence of the capability is the
 * guarantee rather than a rule someone has to keep.
 *
 * WHAT IT READS, AND HOW PRECISELY
 *
 * Two kinds of source, and the difference is stated in the evidence itself
 * rather than smoothed over:
 *
 *   EXACT — `agent_tasks` and `agent_task_steps`. A plan step carries its own
 *   result, verification verdict and approval (Phase 4 stores them), so step
 *   evidence needs no join and cannot be attributed to the wrong run.
 *
 *   CORRELATED — `tool_events`, `mutation_ledger`, `build_runs`. None carries a
 *   task id, so they are matched by session and the task's own recorded time
 *   window. That is deterministic (both inputs are persisted) but it is not a
 *   key: two plans running concurrently in one session would each see the
 *   other's rows. Every correlated item says so, and the evidence carries the
 *   window it used.
 *
 * NO NEW TABLE. Part 1 asks for a migration only if the durable data genuinely
 * cannot reconstruct evidence. It can: the exact half is complete for plan
 * steps, and the correlated half is supplementary cross-reference. Adding a
 * third copy of what tool_events already records would be redundant storage of
 * the kind this phase is meant to avoid.
 */

const parse = (v) => { if (!v) return null; try { return JSON.parse(v); } catch { return null; } };

/* ------------------------------------------------------------------ *
 * Exact sources
 * ------------------------------------------------------------------ */

export function readTask(taskId) {
  return getDb().prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId) ?? null;
}

/**
 * The plan's steps, in the table's own deterministic order.
 *
 * ORDERED BY `sequence`, never by `created_at`. Phase 1 allocates sequence from
 * MAX+1 inside the insert and constrains it UNIQUE per task, so it is the
 * durable ordering; timestamps can collide at millisecond resolution and would
 * make the projection non-deterministic for a fast plan.
 */
export function readSteps(taskId) {
  return getDb().prepare(
    'SELECT * FROM agent_task_steps WHERE task_id = ? ORDER BY sequence ASC',
  ).all(taskId).map((r) => ({
    ...r,
    mutating: Boolean(r.mutating),
    depends_on: parse(r.depends_on) ?? [],
    inputs: parse(r.inputs_json) ?? {},
    expected_effects: parse(r.effects_json) ?? [],
    verification: parse(r.verification_json),
    approval: parse(r.approval_json),
    result: parse(r.result_json),
    // Phase 7 — the recovery lineage. `recordRecoveryAttempt` appends here and
    // never overwrites, so this is the full attempt history, in order.
    metadata: parse(r.metadata_json) ?? {},
  }));
}

/* ------------------------------------------------------------------ *
 * Correlated sources
 * ------------------------------------------------------------------ */

/**
 * The window a task occupied.
 *
 * Both ends come from persisted columns. The open end — a task still running,
 * or one a dead process left running — is reported as null and the correlation
 * then runs to now, which is the only honest reading: rows are still arriving.
 */
export function taskWindow(task) {
  return {
    from: task.started_at ?? task.created_at,
    to: task.completed_at ?? task.cancelled_at ?? null,
    open: !(task.completed_at ?? task.cancelled_at),
  };
}

const inWindow = (ts, w) => Boolean(ts) && ts >= w.from && (w.to === null || ts <= w.to);

/**
 * PHASE 8 — DOES THIS AUDIT ROW BELONG TO THIS TASK?
 *
 * Two rules, and the order matters.
 *
 * A row that NAMES a task belongs to that task and to no other. This is the
 * rule that closes the defect: before migration 23 neither audit table carried
 * a task id, so two plans running in one session each claimed the other's
 * mutations — and `changes` reported them as fact, not as correlation.
 *
 * A row that names NO task falls back to the session-plus-window match it has
 * always had. That covers every row written before migration 23 and every row
 * the ordinary turn loop writes, which has no plan to name. Nothing is
 * back-filled with a guess, and nothing that used to appear disappears.
 *
 * The consequence worth stating plainly: a row belonging to another task is
 * excluded even when it falls inside this task's window, which is exactly the
 * case that was wrong.
 */
const belongsToTask = (row, task, w) => (
  row.task_id ? row.task_id === task.id : inWindow(row.ts, w)
);

/**
 * Tool events this task plausibly produced.
 *
 * ORDERED BY `seq`, which is the durable per-session sequence, not by `ts`.
 * Two events written in the same millisecond have a defined order in `seq` and
 * an undefined one by timestamp.
 */
export function readToolEvents(task) {
  if (!task.session_id) return [];
  const w = taskWindow(task);
  return getDb().prepare(
    'SELECT * FROM tool_events WHERE session = ? ORDER BY seq ASC',
  ).all(task.session_id)
    .filter((r) => belongsToTask(r, task, w))
    .map((r) => ({
      seq: r.seq,
      ts: r.ts,
      // PHASE 8 — true when the row names this task, false when it was matched
      // by the window. Carried per row so the projection never has to average
      // "mostly exact" into a single misleading flag.
      exact: Boolean(r.task_id),
      kind: r.kind,
      name: r.name,
      status: r.result_status,
      mutating: Boolean(r.mutating),
      approval: r.approval,
      approvedSource: r.approved_source,
      approvedAt: r.approved_at,
      instance: r.instance,
      actor: r.actor,
      payload: parse(r.payload),
      result: r.result ?? null,
    }));
}

/**
 * Mutations recorded in the ledger during this task.
 *
 * The ledger is the harness's own account of what was written — it survives
 * compaction by construction, which is what makes it usable as evidence at all.
 */
export function readMutations(task) {
  if (!task.session_id) return [];
  const w = taskWindow(task);
  return getDb().prepare(
    'SELECT * FROM mutation_ledger WHERE session = ? ORDER BY id ASC',
  ).all(task.session_id)
    .filter((r) => belongsToTask(r, task, w))
    .map((r) => ({
      id: r.id,
      ts: r.ts,
      exact: Boolean(r.task_id),   // PHASE 8 — see readToolEvents
      tool: r.tool,
      table: r.table_name,
      sysId: r.sys_id,
      displayId: r.display_id,
      requested: parse(r.requested) ?? {},
      verification: parse(r.verification),
      status: r.status,
      approval: r.approval,
      approvedSource: r.approved_source,
      approvedAt: r.approved_at,
      capture: parse(r.capture),
      instance: r.instance,
      actor: r.actor,
    }));
}

/** SDK build runs, with their event streams. */
export function readBuilds(task) {
  if (!task.session_id) return [];
  const w = taskWindow(task);
  return getDb().prepare(
    'SELECT * FROM build_runs WHERE session = ? ORDER BY started ASC',
  ).all(task.session_id)
    .filter((r) => inWindow(r.started, w))
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      status: r.status,
      request: parse(r.request),
      summary: r.summary,
      dropped: Boolean(r.dropped),
      started: r.started,
      finished: r.finished,
      instance: r.instance,
      actor: r.actor,
      events: loadBuildEvents(r.id),
    }));
}

/**
 * The originating user request, verbatim.
 *
 * `agent_tasks.goal` is the user's own words, stored by Phase 1 at task
 * creation. It is NOT the plan's restatement of them and NOT a model summary —
 * Phase 4's planner explicitly overwrites any goal the model tried to rewrite,
 * so this stays authoritative evidence of what was actually asked.
 *
 * The transcript is consulted only as a fallback, and is marked as such. It can
 * be compacted away; the goal cannot.
 */
export function readRequest(task) {
  if (task.goal) return { text: task.goal, source: 'task', compactable: false };
  if (!task.session_id) return { text: null, source: null, compactable: false };
  const row = getDb().prepare(
    "SELECT json FROM messages WHERE session = ? AND role = 'user' ORDER BY seq ASC LIMIT 1",
  ).get(task.session_id);
  const entry = parse(row?.json);
  return entry?.text
    ? { text: entry.text, source: 'transcript', compactable: true }
    : { text: null, source: null, compactable: false };
}

/** Does the originating conversation still exist? Evidence must not need it to. */
export function sessionExists(sessionId) {
  if (!sessionId) return false;
  return Boolean(getDb().prepare('SELECT 1 AS x FROM sessions WHERE id = ?').get(sessionId));
}
