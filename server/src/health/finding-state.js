import { getDb } from '../memory/db.js';
import { boundInstance } from '../servicenow/instance-binding.js';

/**
 * The finding lifecycle — how a team says "we know about this one".
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * Without it, every run re-reports every finding for ever. A team reviews 900,
 * decides 400 are known and accepted, and has no way to record that — so the
 * next run shows 900 again. Within about three runs nobody opens the page. A
 * health checker that cannot be told "we know, and we accepted it" gets
 * ignored, and being ignored is a worse failure than a few false positives.
 *
 * ═══ THE TWO PROPERTIES THAT KEEP IT HONEST ═══
 *
 * **Muting is presentation, never deletion.** A muted finding is still
 * detected, still stored, still counted in the totals, and still readable in
 * one click. What changes is whether it demands attention. A health tool that
 * could make findings disappear would be a tool for hiding problems.
 *
 * **State is keyed on the FINGERPRINT.** That is sha256 over rule + table + the
 * sorted sys_ids, so it is stable for the same problem on the same records and
 * different the moment the affected set changes. Muting "these four CIs have no
 * owner" carries forward across runs and CANNOT suppress a fifth CI that goes
 * ownerless next week — that is a different fingerprint and arrives as new.
 */

export const FINDING_STATES = Object.freeze(['open', 'acknowledged', 'muted', 'accepted']);

/** What each state means, served so the UI does not coin its own words. */
export const STATE_VOCABULARY = Object.freeze([
  { key: 'open', label: 'Open', blurb: 'Nobody has looked at it yet.' },
  { key: 'acknowledged', label: 'Acknowledged', blurb: 'Seen, and on somebody\'s list. Still counted as outstanding.' },
  { key: 'muted', label: 'Muted', blurb: 'Known and deliberately quiet. Still detected and still visible — it just stops asking.' },
  { key: 'accepted', label: 'Accepted risk', blurb: 'A decision was taken not to fix it. Needs a reason.' },
]);

/** States that stop a finding from demanding attention. */
export const QUIET_STATES = Object.freeze(['muted', 'accepted']);

/** States a person must give a reason for — an unexplained decision is not one. */
const NEEDS_REASON = new Set(['muted', 'accepted']);

const nowIso = () => new Date().toISOString();
const key = () => boundInstance().key || 'unbound';

function shape(row) {
  if (!row) return null;
  /*
   * AN EXPIRED SNOOZE IS OPEN AGAIN, computed at read time rather than by a
   * sweep. There is no background job in this app, and a state that quietly
   * stayed muted past its own end date would be exactly the permanent blind
   * spot `expires_at` exists to prevent.
   */
  const expired = row.expires_at && row.expires_at <= nowIso();
  return {
    fingerprint: row.fingerprint,
    ruleId: row.rule_id,
    state: expired ? 'open' : row.state,
    storedState: row.state,
    expired: Boolean(expired),
    reason: row.reason,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedSource: row.decided_source,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

/**
 * Set a state.
 *
 * `source` is fixed at `user_click` because nothing else may decide this. A
 * model that could mute its own findings would be a model that can hide its own
 * mistakes.
 */
export function setFindingState(fingerprint, { state, reason = null, ruleId = null, expiresAt = null }) {
  if (!FINDING_STATES.includes(state)) {
    return { ok: false, reason: 'unknown_state', allowed: FINDING_STATES };
  }
  if (NEEDS_REASON.has(state) && !String(reason || '').trim()) {
    return {
      ok: false,
      reason: 'reason_required',
      note: `"${state}" is a decision. It needs a reason, so the next person can tell an accepted risk from an unexplained silence.`,
    };
  }

  const db = getDb();
  const existing = db.prepare(
    'SELECT first_seen FROM health_finding_state WHERE instance_key = ? AND fingerprint = ?',
  ).get(key(), fingerprint);

  db.prepare(`
    INSERT INTO health_finding_state
      (instance_key, fingerprint, rule_id, state, reason, expires_at, decided_at, decided_source, first_seen, last_seen)
    VALUES (?,?,?,?,?,?,?, 'user_click', ?, ?)
    ON CONFLICT(instance_key, fingerprint) DO UPDATE SET
      state = excluded.state,
      reason = excluded.reason,
      expires_at = excluded.expires_at,
      decided_at = excluded.decided_at,
      decided_source = excluded.decided_source,
      last_seen = excluded.last_seen
  `).run(key(), fingerprint, ruleId || '', state, reason, expiresAt, nowIso(),
    existing?.first_seen || nowIso(), nowIso());

  return { ok: true, state: shape(getRow(fingerprint)) };
}

function getRow(fingerprint) {
  return getDb().prepare(
    'SELECT * FROM health_finding_state WHERE instance_key = ? AND fingerprint = ?',
  ).get(key(), fingerprint);
}

export function getFindingState(fingerprint) {
  return shape(getRow(fingerprint));
}

/** Every state on this instance, as a map the findings list can decorate with. */
export function stateMap() {
  const rows = getDb().prepare(
    'SELECT * FROM health_finding_state WHERE instance_key = ?',
  ).all(key());
  const out = new Map();
  for (const r of rows) out.set(r.fingerprint, shape(r));
  return out;
}

/** Drop a state entirely — the finding returns to plain `open` with no history. */
export function clearFindingState(fingerprint) {
  const res = getDb().prepare(
    'DELETE FROM health_finding_state WHERE instance_key = ? AND fingerprint = ?',
  ).run(key(), fingerprint);
  return { ok: res.changes > 0 };
}

/**
 * How many findings in a set are quiet, and how many are genuinely outstanding.
 *
 * Both numbers are reported. "12 outstanding" alone would hide that 400 were
 * muted, and the whole point of muting is that it stays inspectable.
 */
export function summarise(fingerprints) {
  const states = stateMap();
  let quiet = 0;
  let acknowledged = 0;
  for (const fp of fingerprints) {
    const s = states.get(fp);
    if (!s) continue;
    if (QUIET_STATES.includes(s.state)) quiet += 1;
    else if (s.state === 'acknowledged') acknowledged += 1;
  }
  return {
    total: fingerprints.length,
    quiet,
    acknowledged,
    outstanding: fingerprints.length - quiet,
  };
}
