import { getDb } from './db.js';
import { currentInstance } from './facts.js';

/**
 * B3 — impersonation mode, as STATE.
 *
 * Under M1 there is no persistent ServiceNow session. Every wrapper execution
 * impersonates, acts and reverts inside one bounded job, and Phase 0 proved the
 * execution boundary reverts even when a `finally` never runs. So "mode" here
 * means exactly one thing: WHICH TARGET THE NEXT EXECUTION WILL STAMP. It is
 * NHA-side bookkeeping, not a live instance session, and this module never
 * claims otherwise.
 *
 * WHY A TABLE RATHER THAN A FACT IN THE TRANSCRIPT. The four `imp.*` facts have
 * to survive compaction intact. Compaction rewrites `messages` and `chunks` and
 * touches nothing else, so a row here is structurally safe in the same way the
 * mutation ledger and `tool_events` are. That property is worth more than a
 * rule someone has to keep remembering — there is no code path that could fold
 * one of these into a digest even by mistake.
 *
 * WHY `imp.original` MATTERS MORE THAN IT LOOKS. Phase 0 measured that the
 * instance keeps NO record of who really acted: no Begin/End events, an
 * impersonation-history table that is empty on every read, and a
 * `sys_audit.user` that is the same session GUID whether impersonating or not.
 * Every impersonated record carries the TARGET's name and nothing else. This
 * column is the only place the real initiator exists, which is what makes B5's
 * audit ledger the sole provenance rather than a convenience.
 */

const now = () => new Date().toISOString();

/** One row per session — a session impersonates exactly one target, or none. */
function readRow(sessionId) {
  return getDb().prepare('SELECT * FROM impersonation_mode WHERE session = ?').get(sessionId) ?? null;
}

/**
 * The mode, as the rest of NHA sees it.
 *
 * Always returns a shape — an absent row is `active: false`, never null — so no
 * caller has to decide what "no row" means, and "am I impersonating?" cannot be
 * answered by accident with `undefined`.
 */
export function getMode(sessionId) {
  const row = readRow(sessionId);
  if (!row || !row.active) {
    return { active: false, target: null, original: null, task: null, startedAt: null, updatedAt: row?.updated_at ?? null };
  }
  return {
    active: true,
    target: { sys_id: row.target_sys_id, user_name: row.target_user_name, display: row.target_display },
    original: { sys_id: row.original_sys_id, user_name: row.original_user_name },
    task: row.task ?? null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    instance: row.instance,
  };
}

/**
 * Begin impersonation mode.
 *
 * `original` is the REAL actor and is captured once, at start. A later switch
 * preserves it (see `switchTarget`): the chain of who-was-really-driving must
 * not be rewritten by re-targeting, or the audit answer changes retroactively.
 */
export function startMode({ sessionId, target, original, task, instance } = {}) {
  if (!sessionId) throw new Error('startMode needs a sessionId.');
  if (!target?.sys_id || !target?.user_name) throw new Error('startMode needs a target with sys_id and user_name.');
  if (!original?.sys_id) throw new Error('startMode needs the original (real) actor sys_id.');
  const ts = now();
  getDb().prepare(
    `INSERT INTO impersonation_mode
       (session, active, target_sys_id, target_user_name, target_display, original_sys_id, original_user_name, task, started_at, updated_at, instance)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session) DO UPDATE SET
       active = 1, target_sys_id = excluded.target_sys_id, target_user_name = excluded.target_user_name,
       target_display = excluded.target_display, original_sys_id = excluded.original_sys_id,
       original_user_name = excluded.original_user_name, task = excluded.task,
       started_at = excluded.started_at, updated_at = excluded.updated_at, instance = excluded.instance`
  ).run(
    sessionId, target.sys_id, target.user_name, target.display ?? target.user_name,
    original.sys_id, original.user_name ?? null, task ?? null, ts, ts, instance ?? safeInstance(),
  );
  return getMode(sessionId);
}

/**
 * Re-target without losing who is really driving.
 *
 * The original actor is carried over from the existing row rather than re-read
 * from the caller: a switch changes WHO IS BEING IMPERSONATED, never WHO IS
 * DOING IT. Switching while inactive is a start, and is treated as one.
 */
export function switchTarget({ sessionId, target, task, original } = {}) {
  const existing = readRow(sessionId);
  const carriedOriginal = existing?.active
    ? { sys_id: existing.original_sys_id, user_name: existing.original_user_name }
    : original;
  if (!carriedOriginal?.sys_id) throw new Error('switchTarget needs an original actor: none is stored and none was supplied.');
  const carriedTask = task ?? (existing?.active ? existing.task : null);
  return startMode({ sessionId, target, original: carriedOriginal, task: carriedTask });
}

/** End mode. Idempotent: ending when nothing is active is a no-op, not an error. */
export function endMode(sessionId) {
  const before = getMode(sessionId);
  getDb().prepare(
    `INSERT INTO impersonation_mode (session, active, updated_at)
     VALUES (?, 0, ?)
     ON CONFLICT(session) DO UPDATE SET
       active = 0, target_sys_id = NULL, target_user_name = NULL, target_display = NULL,
       task = NULL, started_at = NULL, updated_at = excluded.updated_at`
  ).run(sessionId, now());
  return { ended: before.active, previous: before.active ? before : null, mode: getMode(sessionId) };
}

/**
 * The four `imp.*` facts (D6), in the shape the report contract consumes.
 *
 * Deliberately NOT derived from `isImpersonating()` or any other platform
 * predicate: Phase 0 measured those to be constants in this execution context.
 * This is NHA's own state and says so.
 */
export function impFacts(sessionId) {
  const m = getMode(sessionId);
  return {
    'imp.active': m.active,
    'imp.target': m.active ? { sys_id: m.target.sys_id, user_name: m.target.user_name, display: m.target.display } : null,
    'imp.original': m.active ? { sys_id: m.original.sys_id, user_name: m.original.user_name } : null,
    'imp.task': m.active ? m.task : null,
  };
}

/**
 * One line for the end-of-turn report.
 *
 * Surfaced every turn while mode is active, because the thing a human most
 * needs to not lose track of is whose authority their next instruction will
 * carry. Returns null when inactive — silence is the correct rendering of "you
 * are yourself".
 */
export function impersonationBoundaryLine(sessionId) {
  const m = getMode(sessionId);
  if (!m.active) return null;
  const who = m.target.user_name;
  const real = m.original.user_name || m.original.sys_id;
  const task = m.task ? ` — task: ${m.task}` : '';
  return `**Impersonating \`${who}\`** (really ${real})${task}. `
    + 'Actions on the instance are attributed to the impersonated user, and the instance keeps no record '
    + 'of the real initiator — NowHelpAssist\'s audit ledger is the only place that exists.';
}

function safeInstance() {
  try { return currentInstance(); } catch { return null; }
}
