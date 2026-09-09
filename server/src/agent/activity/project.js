import { readTask, readSteps, readToolEvents } from '../evidence/read-model.js';
import { redact } from '../../memory/redact.js';
import { ACTIVITY_TYPE, ACTIVITY_STATUS, activityEvent } from './schemas.js';
import { agentStatus, planProgress } from './status.js';
import { dedupe } from './normalize.js';

/**
 * EXPERIENCE — THE DURABLE ACTIVITY TIMELINE, REBUILT FROM THE DATABASE.
 *
 * §58 asks that a refresh reconstruct the workspace exactly, and §51 that
 * reopening a past task show what it did. Both need the same thing: a timeline
 * that does not depend on anyone having been connected while it happened.
 *
 * ═══ NO NEW QUERIES, AND NO NEW TABLE ═══
 *
 * Every read below goes through `agent/evidence/read-model.js`, which is
 * already the query layer for exactly these three sources and already carries
 * the two properties this projection needs: it is SELECT-only — there is no
 * INSERT, UPDATE, DELETE or ServiceNow client anywhere in its scope — and it
 * marks each correlated row `exact`, so a row matched by session-and-window
 * rather than by task id is never presented as certainly this task's.
 *
 * Writing a second set of queries here would have been easy and would have
 * created a second answer to "what did this task do", with nothing to say which
 * was right. §73 forbids this layer owning an evidence store; reusing the query
 * layer is how that is kept true rather than merely intended.
 *
 * ═══ SEQ, AND WHY IT IS NOT A TIMESTAMP ═══
 *
 * `seq` is assigned here, by the projection, from the deterministic ordering
 * the tables already have — `agent_task_steps.sequence` and `tool_events.seq`,
 * both allocated inside their INSERT. Two events written in the same
 * millisecond have a defined order in those columns and an undefined one by
 * timestamp, so ordering by `ts` would make the timeline non-deterministic for
 * a fast plan. §10's `since` cursor is this number, which is why it has to be
 * stable across calls.
 *
 * ═══ SECRETS ═══
 *
 * §59 lists activity as one of the surfaces a credential must never reach, and
 * §18 asks for the canonical arguments to be visible. Both are satisfiable at
 * once only if the redaction happens HERE, at the boundary, rather than in the
 * client: every `metadata` object below goes through the existing redactor on
 * its way out, so there is no path by which a payload reaches the browser
 * unredacted and no second key list to fall behind.
 */

/* Statuses a durable step row can hold, mapped to the activity vocabulary. */
const STEP_STATUS = Object.freeze({
  planned: ACTIVITY_STATUS.QUEUED,
  pending: ACTIVITY_STATUS.QUEUED,
  ready: ACTIVITY_STATUS.QUEUED,
  running: ACTIVITY_STATUS.RUNNING,
  executing: ACTIVITY_STATUS.RUNNING,
  verifying: ACTIVITY_STATUS.RUNNING,
  awaiting_approval: ACTIVITY_STATUS.BLOCKED,
  blocked: ACTIVITY_STATUS.BLOCKED,
  completed: ACTIVITY_STATUS.COMPLETED,
  failed: ACTIVITY_STATUS.FAILED,
  skipped: ACTIVITY_STATUS.CANCELLED,
  cancelled: ACTIVITY_STATUS.CANCELLED,
});

const TASK_STATUS = Object.freeze({
  planned: ACTIVITY_STATUS.QUEUED,
  running: ACTIVITY_STATUS.RUNNING,
  awaiting_approval: ACTIVITY_STATUS.BLOCKED,
  blocked: ACTIVITY_STATUS.BLOCKED,
  completed: ACTIVITY_STATUS.COMPLETED,
  failed: ACTIVITY_STATUS.FAILED,
  cancelled: ACTIVITY_STATUS.CANCELLED,
});

const parse = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
};

/**
 * §20 — a tool row's SAFE summary.
 *
 * The tool's own name, its status word and, for a read, the table it touched.
 * Not the arguments: those live in `metadata`, which is redacted, and the
 * summary line is rendered in a compact list where a long payload would be
 * unreadable as well as unwise.
 */
const toolSummary = (row) => {
  const bits = [];
  if (row.payload?.table) bits.push(String(row.payload.table));
  if (row.status) bits.push(String(row.status));
  if (row.mutating) bits.push('mutating');
  return bits.length ? bits.join(' · ') : null;
};

/**
 * A tool row's status, from the row's own words.
 *
 * `result_status` is written by the orchestrator and is the backend's account
 * of how the call ended. Anything it does not recognise becomes COMPLETED with
 * the raw word carried in the summary — never FAILED, because inventing a
 * failure is as dishonest as inventing a success, and never a guess parsed out
 * of the result text.
 */
const toolStatus = (row) => {
  const s = String(row.status ?? '').toLowerCase();
  if (!s) return ACTIVITY_STATUS.COMPLETED;
  if (s === 'error' || s.startsWith('elev_') || s.includes('refused') || s.includes('blocked')) {
    return s.includes('blocked') || s.includes('refused') ? ACTIVITY_STATUS.BLOCKED : ACTIVITY_STATUS.FAILED;
  }
  if (s === 'cancelled') return ACTIVITY_STATUS.CANCELLED;
  if (s === 'not-exposed') return ACTIVITY_STATUS.BLOCKED;
  return ACTIVITY_STATUS.COMPLETED;
};

/**
 * The durable timeline for one task.
 *
 * Returns null — never an empty timeline — when the task does not exist. §27's
 * distinction applies here too: "this task did nothing" and "there is no such
 * task" are different answers and must not render the same.
 */
export function activityForTask(taskId, { since = null } = {}) {
  const task = readTask(taskId);
  if (!task) return null;

  const steps = readSteps(taskId);
  const tools = readToolEvents(task);
  const events = [];
  let seq = 0;

  /* ---- the task itself, opened ---- */
  events.push(activityEvent({
    id: `task:${task.id}:start`,
    taskId: task.id,
    seq: seq += 1,
    timestamp: task.started_at ?? task.created_at,
    type: ACTIVITY_TYPE.TASK,
    status: ACTIVITY_STATUS.RUNNING,
    title: 'Task started',
    summary: task.goal ? String(task.goal).slice(0, 140) : null,
  }));

  /* ---- its steps, in the table's own order ---- */
  for (const s of steps) {
    const meta = {
      operation: s.operation ?? null,
      mechanism: s.mechanism ?? null,
      tool: s.tool ?? null,
      scope: s.scope ?? null,
      mutating: Boolean(s.mutating),
      depends_on: parse(s.depends_on) ?? [],
      /* §18 — the CANONICAL arguments, which is what actually ran. */
      inputs: parse(s.inputs_json),
      effects: parse(s.effects_json),
      verification: parse(s.verification_json),
      plan_step_id: s.plan_step_id ?? null,
      sequence: s.sequence ?? null,
    };
    events.push(activityEvent({
      id: `step:${task.id}:${s.plan_step_id ?? s.id}`,
      taskId: task.id,
      seq: seq += 1,
      timestamp: s.completed_at ?? s.started_at ?? s.created_at,
      type: ACTIVITY_TYPE.STEP,
      status: STEP_STATUS[s.state] ?? ACTIVITY_STATUS.QUEUED,
      title: s.description || s.operation || `Step ${s.sequence}`,
      summary: s.failure_reason ? String(s.failure_reason).slice(0, 140) : (s.operation ?? null),
      metadata: redact(meta),
    }));

    /*
     * §27 — a verification event exists only when a verdict was RECORDED.
     *
     * A step with no `verification_json` produces no verification row, so the
     * timeline cannot show "verified" for a step nothing verified. That is
     * §79.3 expressed as an absence rather than as a rule.
     */
    const verdict = parse(s.verification_json);
    if (verdict && (verdict.status || verdict.verdict)) {
      const word = String(verdict.status ?? verdict.verdict);
      events.push(activityEvent({
        id: `verification:${task.id}:${s.plan_step_id ?? s.id}`,
        taskId: task.id,
        seq: seq += 1,
        timestamp: s.completed_at ?? s.updated_at,
        type: ACTIVITY_TYPE.VERIFICATION,
        status: word === 'verified' ? ACTIVITY_STATUS.COMPLETED : ACTIVITY_STATUS.FAILED,
        title: `Verification: ${word}`,
        summary: verdict.strategy ? String(verdict.strategy) : null,
        metadata: redact(verdict),
      }));
    }

    /* §22/§23 — an approval event exists only when one was recorded. */
    const approval = parse(s.approval_json);
    if (approval && (approval.decision || approval.approved !== undefined || approval.source)) {
      const granted = approval.approved === true || approval.decision === 'approved';
      events.push(activityEvent({
        id: `approval:${task.id}:${s.plan_step_id ?? s.id}`,
        taskId: task.id,
        seq: seq += 1,
        timestamp: approval.at ?? s.updated_at,
        type: ACTIVITY_TYPE.APPROVAL,
        status: granted ? ACTIVITY_STATUS.COMPLETED : ACTIVITY_STATUS.FAILED,
        title: granted ? 'Approval granted' : 'Approval rejected',
        summary: approval.source ? `decided by ${approval.source}` : null,
        metadata: redact(approval),
      }));
    }
  }

  /* ---- the tools it ran (§20) ---- */
  for (const t of tools) {
    events.push(activityEvent({
      id: `tool:${task.id}:${t.seq}`,
      taskId: task.id,
      seq: seq += 1,
      timestamp: t.ts,
      type: ACTIVITY_TYPE.TOOL,
      status: toolStatus(t),
      title: t.name || t.kind || 'tool',
      summary: toolSummary(t),
      metadata: redact({
        kind: t.kind,
        mutating: t.mutating,
        approval: t.approval,
        approved_source: t.approvedSource,
        approved_at: t.approvedAt,
        result_status: t.status,
        /*
         * §8 — carried per row, never averaged. A row matched by the task's
         * time window rather than by its id is marked, and the panel says so,
         * because "this task ran it" and "this task probably ran it" are
         * different claims.
         */
        exact: t.exact,
        inputs: t.payload,
      }),
    }));
  }

  /* ---- and how it ended, if it has ---- */
  if (['completed', 'failed', 'cancelled'].includes(task.state)) {
    events.push(activityEvent({
      id: `task:${task.id}:end`,
      taskId: task.id,
      seq: seq += 1,
      timestamp: task.completed_at ?? task.cancelled_at ?? task.updated_at,
      type: ACTIVITY_TYPE.TASK,
      status: TASK_STATUS[task.state],
      title: `Task ${task.state}`,
      summary: task.failure_reason ? String(task.failure_reason).slice(0, 200) : null,
    }));
  }

  const all = dedupe(events);
  const cursor = all.length ? all[all.length - 1].seq : 0;

  return {
    task_id: task.id,
    session_id: task.session_id ?? null,
    goal: task.goal ?? null,
    /* §12 — the status, derived from the same rows the events came from. */
    status: agentStatus(task, steps),
    state: task.state,
    plan_state: task.plan_state ?? null,
    created_at: task.created_at,
    started_at: task.started_at ?? null,
    completed_at: task.completed_at ?? task.cancelled_at ?? null,
    failure_reason: task.failure_reason ?? null,
    progress: planProgress(steps),
    /*
     * §44 — the skills this task ran under, as recorded when it opened. Read
     * back from the task's own metadata rather than from the live registry, so
     * a skill enabled since cannot retroactively appear in a finished run.
     *
     * `readTask` returns the RAW row, so the JSON is in `metadata_json` and has
     * to be parsed here. Reading `task.metadata` — which `memory/tasks.js`
     * shapes but the evidence read-model deliberately does not — silently
     * returned an empty list for every task, which is exactly the shape of
     * failure this section is about: a task that ran under skills reporting
     * that it ran under none.
     */
    skills: Array.isArray(parse(task.metadata_json)?.skills) ? parse(task.metadata_json).skills : [],
    /* §10 — everything after `since`, and the cursor to ask from next time. */
    events: since === null || since === undefined ? all : all.filter((e) => e.seq > Number(since)),
    cursor,
    total: all.length,
  };
}
