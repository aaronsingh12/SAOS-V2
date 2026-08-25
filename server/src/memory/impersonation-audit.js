import { getDb } from './db.js';
import { currentInstance } from './facts.js';
import { getMode } from './impersonation-mode.js';

/**
 * B5 — impersonation provenance. The sole answer to "who really did this".
 *
 * WHAT PHASE 0 ESTABLISHED, and why this is load-bearing rather than a
 * convenience copy of something the platform already knows:
 *
 *   - 'Impersonate Begin' / 'Impersonate End' produce ZERO rows in syslog and
 *     zero in sysevent. The events are not registered in sysevent_register at
 *     all, so they are not merely unlogged — they do not exist here.
 *   - `sys_user_impersonation` does not exist. `sys_user_impersonation_history`
 *     does, and has held zero rows on every read.
 *   - With `glide.audit.track_impersonation` created, set true, and confirmed
 *     active by the running script, `sys_audit.user` held an IDENTICAL session
 *     GUID whether impersonating or not. The dual identity the documentation
 *     promises did not appear.
 *
 * Every record an impersonated execution touches carries the TARGET's name in
 * `sys_created_by` / `sys_updated_by` and nothing else. Delete this table and
 * the question "who actually caused this change" has no answer on any system.
 *
 * READS ARE NOT AUDITED (D4). Only mutations and mode transitions. A read
 * performed as someone else changes nothing and is ungated; auditing every one
 * would bury the rows that matter in rows that do not.
 *
 * Hard Rule 6 — a row is not RECORDED until it has been read back. Every append
 * here re-reads what it wrote and reports whether it is really there. It does
 * not throw: an audit failure must not destroy the turn that produced the
 * change. It does fail LOUDLY, returning `recorded: false` with a reason, so a
 * caller can surface it rather than assume provenance exists.
 */

const now = () => new Date().toISOString();

export const AUDIT_KIND = {
  MUTATION: 'mutation',
  MODE_START: 'mode_start',
  MODE_SWITCH: 'mode_switch',
  MODE_END: 'mode_end',
};

const cell = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

/**
 * A short, human-readable account of what changed.
 *
 * Field NAMES, not values: the audit answer is "who did what to which record",
 * and copying field values in would duplicate data that may be personal onto a
 * second system with a different retention story.
 */
export function summariseChange({ descriptor, verification, tool }) {
  const op = descriptor?.operation ?? null;
  const fields = Object.keys(descriptor?.requested ?? {});
  const parts = [];
  if (op) parts.push(op);
  if (fields.length) parts.push(`fields: ${fields.slice(0, 12).join(', ')}${fields.length > 12 ? ` (+${fields.length - 12})` : ''}`);
  if (!parts.length && tool) parts.push(`via ${tool}`);
  if (verification?.status && verification.status !== 'applied') parts.push(`verification: ${verification.status}`);
  return parts.join(' — ') || null;
}

/** Pull the record's human-facing id out of whatever the tool returned. */
function deriveDisplayId(result) {
  if (!result || typeof result !== 'object') return null;
  for (const f of ['number', 'name', 'title', 'short_description']) {
    const v = cell(result[f]);
    if (v) return String(v);
  }
  return null;
}

function insertAndReadBack(row) {
  const db = getDb();
  const cols = Object.keys(row);
  const stmt = db.prepare(
    `INSERT INTO impersonation_audit (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  );
  const info = stmt.run(...cols.map((c) => row[c]));
  const id = Number(info.lastInsertRowid);
  // Hard Rule 6 — written is not recorded.
  const back = db.prepare('SELECT * FROM impersonation_audit WHERE id = ?').get(id);
  if (!back) return { recorded: false, id: null, reason: 'the row was inserted and could not be read back' };
  if (back.real_initiator_sys_id !== row.real_initiator_sys_id) {
    return { recorded: false, id, reason: 'the row read back with a different real initiator than was written' };
  }
  return { recorded: true, id, row: back };
}

/**
 * Record one impersonated mutation.
 *
 * Returns `{ recorded: false, reason: 'not-impersonating' }` when mode is off —
 * which is the normal case and not a failure. Everything NHA does under its own
 * identity is already attributable through the mutation ledger and tool_events.
 */
export function appendImpersonatedMutation({
  sessionId, turnSeq, tool, descriptor, result, verification, harnessSession = null,
  executedImpersonated = false,
} = {}) {
  try {
    const mode = getMode(sessionId);
    if (!mode.active) return { recorded: false, reason: 'not-impersonating' };

    return insertAndReadBack({
      session: sessionId,
      turn_seq: Number(turnSeq ?? -1),
      ts: now(),
      kind: AUDIT_KIND.MUTATION,
      real_initiator_sys_id: mode.original.sys_id,
      real_initiator_user_name: mode.original.user_name ?? null,
      harness_session: harnessSession,
      target_sys_id: mode.target.sys_id,
      target_user_name: mode.target.user_name,
      table_name: descriptor?.table ?? null,
      sys_id: descriptor?.sys_id ?? (result && cell(result.sys_id)) ?? null,
      display_id: deriveDisplayId(result),
      operation: descriptor?.operation ?? null,
      tool: tool ?? null,
      change_summary: summariseChange({ descriptor, verification, tool }),
      verification_status: verification?.status ?? null,
      task: mode.task ?? null,
      instance: safeInstance(),
      executed_impersonated: executedImpersonated ? 1 : 0,
    });
  } catch (err) {
    return { recorded: false, reason: `impersonation audit failed: ${err.message}` };
  }
}

/**
 * Record a mode transition.
 *
 * Start and switch are the moments authority changed hands, and end is the
 * moment it stopped. Without them the mutation rows describe actions with no
 * account of when the arrangement that permitted them began.
 */
export function appendModeEvent({
  sessionId, turnSeq = -1, kind, target, original, task, harnessSession = null,
} = {}) {
  try {
    if (!original?.sys_id) return { recorded: false, reason: 'no real initiator to record' };
    return insertAndReadBack({
      session: sessionId,
      turn_seq: Number(turnSeq ?? -1),
      ts: now(),
      kind,
      real_initiator_sys_id: original.sys_id,
      real_initiator_user_name: original.user_name ?? null,
      harness_session: harnessSession,
      target_sys_id: target?.sys_id ?? null,
      target_user_name: target?.user_name ?? null,
      table_name: null, sys_id: null, display_id: null, operation: null, tool: null,
      change_summary: null, verification_status: null,
      task: task ?? null,
      instance: safeInstance(),
      executed_impersonated: 0,
    });
  } catch (err) {
    return { recorded: false, reason: `impersonation audit failed: ${err.message}` };
  }
}

/**
 * THE REVERSE LOOKUP — the question this whole phase exists to answer.
 *
 * Someone finds a record on the instance stamped `aagamya.tanwar`. They ask who
 * actually did it. The instance cannot tell them. This can.
 */
export function whoReallyDid(sysId) {
  const id = String(sysId ?? '').trim();
  if (!id) return { found: false, sys_id: null, entries: [] };
  const rows = getDb().prepare(
    'SELECT * FROM impersonation_audit WHERE sys_id = ? AND kind = ? ORDER BY ts DESC, id DESC'
  ).all(id, AUDIT_KIND.MUTATION);

  if (!rows.length) {
    return {
      found: false,
      sys_id: id,
      entries: [],
      answer: `No NowHelpAssist impersonation record touched ${id}. Either it was changed by NowHelpAssist under its `
        + 'own identity — the mutation ledger covers that — or it was changed outside NowHelpAssist entirely.',
    };
  }

  const latest = rows[0];
  const initiator = latest.real_initiator_user_name ?? latest.real_initiator_sys_id;
  const gap = latest.executed_impersonated === 1;

  /*
   * The two cases mean OPPOSITE things and must never share a sentence.
   *
   * Only a genuinely impersonated execution creates an attribution gap — the
   * instance stamped the target and kept no account of anyone else. A write
   * that ran as the service account while mode happened to be on is already
   * attributed correctly by the instance; describing it as a gap would be
   * inventing an audit finding someone might act on.
   */
  return {
    found: true,
    sys_id: id,
    executed_impersonated: gap,
    real_initiator: { sys_id: latest.real_initiator_sys_id, user_name: latest.real_initiator_user_name },
    attributed_to: gap
      ? { sys_id: latest.target_sys_id, user_name: latest.target_user_name }
      : { sys_id: latest.real_initiator_sys_id, user_name: latest.real_initiator_user_name },
    impersonation_mode_target: { sys_id: latest.target_sys_id, user_name: latest.target_user_name },
    task: latest.task,
    entries: rows,
    answer: gap
      ? `${id} is attributed on the instance to ${latest.target_user_name}, but was actually caused by `
        + `${initiator} impersonating them${latest.task ? ` for: ${latest.task}` : ''}. `
        + `The instance itself records only ${latest.target_user_name}.`
      : `${id} was changed by ${initiator} under the NowHelpAssist service identity, while impersonation mode was `
        + `active for ${latest.target_user_name}${latest.task ? ` (task: ${latest.task})` : ''}. `
        + 'The write did NOT execute as that user, so the instance attributes it correctly and there is no '
        + 'attribution gap here.',
  };
}

/** Everything recorded for one session, newest first. */
export function impersonationAuditForSession(sessionId, { limit = 500 } = {}) {
  return getDb().prepare(
    'SELECT * FROM impersonation_audit WHERE session = ? ORDER BY id DESC LIMIT ?'
  ).all(sessionId, limit);
}

/** Everything an impersonated identity was used for, across all sessions. */
export function impersonationAuditForTarget(targetSysId, { limit = 500 } = {}) {
  return getDb().prepare(
    'SELECT * FROM impersonation_audit WHERE target_sys_id = ? ORDER BY id DESC LIMIT ?'
  ).all(String(targetSysId ?? ''), limit);
}

function safeInstance() {
  try { return currentInstance(); } catch { return null; }
}
