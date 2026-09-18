import crypto from 'node:crypto';
import { getDb } from './db.js';
import { currentActor } from './audit.js';
import { log } from '../logging.js';

/**
 * PHASE 1 — the durable task/step substrate.
 *
 * WHAT THIS IS. Every agent turn is already a unit of work: it has a goal, a
 * lifecycle, and an outcome. What it has never had is an identity that outlives
 * the process. "What was this agent asked to do, and how did it end" could only
 * be answered by reading a transcript, and a transcript is exactly the thing
 * compaction is allowed to rewrite.
 *
 * WHAT THIS IS NOT, and this is the more important half. There is no planner
 * here, no decomposition, no retry, no recovery and no scheduler. One turn
 * produces one task with one step, whatever happens inside it — however many
 * provider iterations, provider retries or tool calls that turn spends. The
 * tables carry states that a later phase will drive; this phase only PROJECTS
 * the lifecycle the turn already had onto them.
 *
 * WHERE IT SITS. Above the execution layer and below nothing. It imports the
 * database, the actor helper and the logger, and that is the complete list —
 * no ServiceNow module, no orchestrator, no tool registry. The dependency
 * arrow runs one way (task layer -> orchestrator -> execution -> ServiceNow)
 * and `test/agent-tasks.test.js` asserts it on the import graph rather than
 * trusting this paragraph.
 *
 * WHY TRANSITION FUNCTIONS RATHER THAN UPDATES. Scattered
 * `UPDATE agent_tasks SET state = ...` is how a state column stops meaning
 * anything: every call site invents its own rules and none of them agree. The
 * functions below are the only writers, each names the transition it performs,
 * and each refuses a transition that is not legal from the current state. That
 * is deliberately not a state-machine ENGINE — it is a lookup table and a
 * guard, which is all this phase needs.
 *
 * NOTHING HERE THROWS INTO A TURN. A failure to record bookkeeping must never
 * fail the work it was recording, so every writer catches, logs loudly and
 * returns a falsy result. This is the same discipline `agent/capture.js` and
 * `memory/ledger.js` already follow, and for the same reason: by the time these
 * run, the thing being recorded has already happened.
 */

const now = () => new Date().toISOString();

/**
 * The task states, and the complete list of them.
 *
 * `blocked` is declared and never entered in this phase. It is here because it
 * is part of the vocabulary a later kernel needs and adding a state to a
 * shipped table is more disruptive than declaring an unused one — but nothing
 * transitions into it, and no code below can.
 */
export const TASK_STATES = Object.freeze([
  'planned',
  'running',
  'awaiting_approval',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

/** The step states. Identical vocabulary, deliberately: a step is a task's unit. */
export const STEP_STATES = Object.freeze([...TASK_STATES]);

/**
 * The step kinds that are actually created.
 *
 * Phase 1 shipped exactly one — `turn` — with the note that adding more "before
 * a planner exists would be guessing at it". Phase 4 built the planner, so
 * `plan_step` is the second and it is not a guess: it is the kind
 * `plan/store.js` writes for every step of a durable plan.
 *
 * The list stays closed. `analysis`, `verification`, `checkpoint` and `recovery`
 * remain unimplemented, because each still describes a phase that does not
 * exist yet, and a kind nothing produces is a guess about it.
 */
export const STEP_KINDS = Object.freeze(['turn', 'plan_step']);

/** Once a task or step reaches one of these it never moves again. */
export const TERMINAL_STATES = Object.freeze(['completed', 'failed', 'cancelled']);

/**
 * Which states each state may move to.
 *
 * Read it as the answer to one question: could a turn legitimately do this? A
 * running turn can reach the gate (`awaiting_approval`) and come back; a
 * waiting one can be cancelled where it stands; nothing leaves a terminal
 * state, because a turn that has ended has ended.
 */
const LEGAL = Object.freeze({
  planned: ['running', 'cancelled', 'failed'],
  running: ['awaiting_approval', 'blocked', 'completed', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'blocked', 'completed', 'failed', 'cancelled'],
  blocked: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
});

export function canTransition(from, to) {
  return Boolean(LEGAL[from]?.includes(to));
}

const json = (v) => {
  if (v === null || v === undefined) return null;
  try { return JSON.stringify(v); } catch { return null; }
};

const parse = (v) => {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
};

const shapeTask = (r) => (r ? { ...r, metadata: parse(r.metadata_json) } : null);
const shapeStep = (r) => (r ? { ...r, metadata: parse(r.metadata_json) } : null);

/* ------------------------------------------------------------------ *
 * Creation
 * ------------------------------------------------------------------ */

/**
 * Open a task for one logical user turn.
 *
 * The id is minted HERE, by the application, from the CSPRNG — the same
 * convention `createSession` uses. Nothing outside this module may choose it,
 * and in particular the model cannot: task identity, step identity, sequence
 * and state are control-plane fields, and a tool that could set one could
 * rewrite the record of what it had done.
 *
 * Starts `planned`. The caller starts it, so "created" and "began executing"
 * stay two separate facts with two separate timestamps.
 */
export function createTask({ sessionId, goal = null, metadata = null } = {}) {
  try {
    if (!sessionId) throw new Error('a task needs a session');
    const { instance, actor } = currentActor();
    const session = getDb().prepare('SELECT instance FROM sessions WHERE id = ?').get(sessionId);
    if (session && session.instance !== instance) {
      throw Object.assign(
        new Error('This chat belongs to another instance. Start a new chat for the current instance.'),
        { code: 'session_instance_mismatch' }
      );
    }
    const id = crypto.randomUUID();
    const ts = now();
    getDb().prepare(
      `INSERT INTO agent_tasks (id, session_id, state, goal, created_at, updated_at, metadata_json, instance, actor)
       VALUES (?, ?, 'planned', ?, ?, ?, ?, ?, ?)`
    ).run(id, sessionId, goal ?? null, ts, ts, json(metadata), instance, actor);
    return getTask(id);
  } catch (err) {
    log.error('tasks', `could not open a task for session ${sessionId}: ${err.message}`, err);
    return null;
  }
}

/**
 * Add a step to a task.
 *
 * `sequence` is allocated from `MAX(sequence) + 1` INSIDE the insert, so the
 * number comes from the table rather than from anything a caller counted in
 * memory. Combined with the UNIQUE (task_id, sequence) constraint that makes
 * ordering a property of the data — §4's requirement — rather than of the order
 * rows happen to be read back in.
 */
export function createStep({ taskId, kind = 'turn', description = null, capability = null, metadata = null } = {}) {
  try {
    if (!taskId) throw new Error('a step needs a task');
    if (!STEP_KINDS.includes(kind)) throw new Error(`unknown step kind "${kind}"`);
    const id = crypto.randomUUID();
    const ts = now();
    getDb().prepare(
      `INSERT INTO agent_task_steps
         (id, task_id, sequence, state, kind, description, capability, metadata_json, created_at, updated_at)
       VALUES (
         ?, ?,
         (SELECT COALESCE(MAX(sequence), 0) + 1 FROM agent_task_steps WHERE task_id = ?),
         'planned', ?, ?, ?, ?, ?, ?
       )`
    ).run(id, taskId, taskId, kind, description ?? null, capability ?? null, json(metadata), ts, ts);
    return getStep(id);
  } catch (err) {
    log.error('tasks', `could not open a step on task ${taskId}: ${err.message}`, err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Transitions
 *
 * One private mover, and a named function per transition. The named functions
 * are what call sites use, so a reader of the route can see the lifecycle
 * without reading SQL, and so a future phase can find every writer by name.
 * ------------------------------------------------------------------ */

/**
 * Move one row, or refuse and say why.
 *
 * A refused transition is LOGGED rather than thrown. Two of them are expected
 * and harmless: a redundant move (already in the target state) and a move out
 * of a terminal state, which is what a second terminal frame would attempt. The
 * turn is over by then and failing it retroactively would be absurd — but a
 * silent refusal would hide a projection that had genuinely lost track, so it
 * is never silent.
 */
function move(kind, id, to, patch = {}) {
  const table = kind === 'task' ? 'agent_tasks' : 'agent_task_steps';
  try {
    if (!id) return null;
    const db = getDb();
    const row = db.prepare(`SELECT state FROM ${table} WHERE id = ?`).get(id);
    if (!row) {
      log.warn('tasks', `no such ${kind} ${id} to move to ${to}`);
      return null;
    }
    if (row.state === to) return kind === 'task' ? getTask(id) : getStep(id);
    if (!canTransition(row.state, to)) {
      log.warn('tasks', `refused ${kind} ${id}: ${row.state} -> ${to} is not a legal transition`);
      return kind === 'task' ? getTask(id) : getStep(id);
    }
    const cols = ['state = ?', 'updated_at = ?'];
    const vals = [to, now()];
    for (const [col, val] of Object.entries(patch)) {
      cols.push(`${col} = ?`);
      vals.push(val);
    }
    vals.push(id);
    db.prepare(`UPDATE ${table} SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
    return kind === 'task' ? getTask(id) : getStep(id);
  } catch (err) {
    log.error('tasks', `could not move ${kind} ${id} to ${to}: ${err.message}`, err);
    return null;
  }
}

export const startTask = (id) => move('task', id, 'running', { started_at: now() });
export const startStep = (id) => move('step', id, 'running', { started_at: now() });

export const completeTask = (id) => move('task', id, 'completed', { completed_at: now() });
export const completeStep = (id) => move('step', id, 'completed', { completed_at: now() });

/**
 * The reason is stored, never derived.
 *
 * It comes from the existing terminal frame's own message: this phase does not
 * classify failures, it records the classification the turn already made.
 */
export const failTask = (id, reason = null) => move('task', id, 'failed', { failure_reason: reason ?? null });
export const failStep = (id, reason = null) => move('step', id, 'failed', { failure_reason: reason ?? null });

export const cancelTask = (id) => move('task', id, 'cancelled', { cancelled_at: now() });
export const cancelStep = (id) => move('step', id, 'cancelled');

export const markTaskAwaitingApproval = (id) => move('task', id, 'awaiting_approval');
export const markStepAwaitingApproval = (id) => move('step', id, 'awaiting_approval');

/**
 * Back to work after the gate resolved.
 *
 * Its own name rather than a second call to `startTask`, because `started_at`
 * must not be rewritten: a turn that paused for approval three times still
 * started once, and overwriting that would make the duration of every gated
 * turn a lie.
 */
export const resumeTask = (id) => move('task', id, 'running');
export const resumeStep = (id) => move('step', id, 'running');

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export function getTask(id) {
  try { return shapeTask(getDb().prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) ?? null); }
  catch (err) { log.error('tasks', `could not read task ${id}: ${err.message}`); return null; }
}

export function getStep(id) {
  try { return shapeStep(getDb().prepare('SELECT * FROM agent_task_steps WHERE id = ?').get(id) ?? null); }
  catch (err) { log.error('tasks', `could not read step ${id}: ${err.message}`); return null; }
}

/** A task's steps, in the order the table says — never in insertion order. */
export function stepsForTask(taskId) {
  try {
    return getDb().prepare('SELECT * FROM agent_task_steps WHERE task_id = ? ORDER BY sequence ASC')
      .all(taskId).map(shapeStep);
  } catch (err) {
    log.error('tasks', `could not read the steps of task ${taskId}: ${err.message}`);
    return [];
  }
}

export function tasksForSession(sessionId, { limit = 100 } = {}) {
  try {
    const { instance } = currentActor();
    return getDb().prepare('SELECT * FROM agent_tasks WHERE session_id = ? AND instance = ? ORDER BY created_at DESC LIMIT ?')
      .all(sessionId, instance, limit).map(shapeTask);
  } catch (err) {
    log.error('tasks', `could not read the tasks of session ${sessionId}: ${err.message}`);
    return [];
  }
}

/**
 * Tasks left `running` or `awaiting_approval` by a process that died.
 *
 * A READ, and only a read. Phase 1 does not recover, resume, retry or
 * fail these — §17 is explicit that a durable, observable stale state is the
 * wanted outcome and that deciding what to do about it belongs to the recovery
 * phase. This exists so that decision has something to be made from.
 */
export function unfinishedTasks({ limit = 100 } = {}) {
  try {
    const { instance } = currentActor();
    return getDb().prepare(
      `SELECT * FROM agent_tasks WHERE instance = ? AND state IN ('planned', 'running', 'awaiting_approval', 'blocked')
       ORDER BY created_at DESC LIMIT ?`
    ).all(instance, limit).map(shapeTask);
  } catch (err) {
    log.error('tasks', `could not read unfinished tasks: ${err.message}`);
    return [];
  }
}
