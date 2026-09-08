import { getDb } from '../memory/db.js';
import { KINDS, fingerprint } from './understanding.js';

/**
 * The human's half of the review.
 *
 * The user's job here is to VALIDATE the model's understanding, not to do the
 * extraction themselves — so the operations are confirm, correct, reject and
 * add-what-was-missed, and nothing else.
 *
 * A correction is stored in `edited_text` beside the original rather than over
 * it. Two different facts are being recorded: what the model claimed, and what
 * the person says is actually true. Overwriting the first would make "how good
 * is this feature" unanswerable a week later.
 */

const now = () => new Date().toISOString();

export const STATUSES = Object.freeze(['proposed', 'confirmed', 'rejected']);

export function listFindings(meetingId) {
  const db = getDb();
  const findings = db.prepare(
    `SELECT * FROM meeting_findings WHERE meeting = ?
      ORDER BY CASE kind WHEN 'requirement' THEN 0 WHEN 'decision' THEN 1 WHEN 'criterion' THEN 2
                         WHEN 'question' THEN 3 ELSE 4 END, id`
  ).all(meetingId);
  if (!findings.length) return [];
  const evidence = db.prepare(
    `SELECT e.* FROM meeting_evidence e
       JOIN meeting_findings f ON f.id = e.finding
      WHERE f.meeting = ? ORDER BY e.id`
  ).all(meetingId);
  const byFinding = new Map();
  for (const e of evidence) {
    if (!byFinding.has(e.finding)) byFinding.set(e.finding, []);
    byFinding.get(e.finding).push(e);
  }
  return findings.map((f) => ({
    ...f,
    evidence: byFinding.get(f.id) || [],
    // Convenience for the client, computed here so both halves agree on what
    // "backed by evidence" means.
    verified: (byFinding.get(f.id) || []).some((e) => e.verified === 1),
  }));
}

export function getFinding(meetingId, id) {
  return getDb().prepare('SELECT * FROM meeting_findings WHERE meeting = ? AND id = ?')
    .get(meetingId, Number(id)) || null;
}

/**
 * Confirm, correct or reject.
 *
 * Editing the text changes the finding's identity, so the fingerprint is
 * recomputed — otherwise a later pass could re-propose the model's original
 * wording as a "new" finding the user had already fixed.
 */
export function updateFinding(meetingId, id, patch = {}) {
  const db = getDb();
  const existing = getFinding(meetingId, id);
  if (!existing) return null;

  const next = {
    status: patch.status !== undefined ? String(patch.status) : existing.status,
    edited_text: patch.text !== undefined
      ? (String(patch.text).trim() || null)
      : existing.edited_text,
    kind: patch.kind !== undefined ? String(patch.kind) : existing.kind,
  };
  if (!STATUSES.includes(next.status)) {
    throw Object.assign(new Error(`status must be one of ${STATUSES.join(', ')}`), { status: 400 });
  }
  if (!KINDS.includes(next.kind)) {
    throw Object.assign(new Error(`kind must be one of ${KINDS.join(', ')}`), { status: 400 });
  }

  const effective = next.edited_text || existing.text;
  db.prepare(
    `UPDATE meeting_findings SET status = ?, edited_text = ?, kind = ?, fingerprint = ?, updated = ?
      WHERE meeting = ? AND id = ?`
  ).run(next.status, next.edited_text, next.kind, fingerprint(next.kind, effective), now(), meetingId, Number(id));
  return getFinding(meetingId, id);
}

/**
 * Something the meeting covered and the model missed.
 *
 * Recorded with origin 'human' and NO evidence requirement. The person was in
 * the room; demanding they cite a transcript line would be asking them to
 * satisfy a check that exists to police the model, not them. It is confirmed
 * on arrival for the same reason — they are not proposing it, they are stating
 * it.
 */
export function addFinding(meetingId, { kind, text }) {
  const db = getDb();
  const k = String(kind || 'requirement');
  const body = String(text || '').trim();
  if (!KINDS.includes(k)) {
    throw Object.assign(new Error(`kind must be one of ${KINDS.join(', ')}`), { status: 400 });
  }
  if (!body) throw Object.assign(new Error('text is required'), { status: 400 });

  const fp = fingerprint(k, body);
  const res = db.prepare(
    `INSERT INTO meeting_findings (meeting, kind, text, status, origin, pass, fingerprint, created)
     VALUES (?, ?, ?, 'confirmed', 'human', 0, ?, ?)
     ON CONFLICT (meeting, fingerprint) DO NOTHING`
  ).run(meetingId, k, body, fp, now());
  if (!res.changes) {
    throw Object.assign(new Error('That is already recorded for this meeting.'), { status: 409 });
  }
  return db.prepare('SELECT * FROM meeting_findings WHERE meeting = ? AND fingerprint = ?').get(meetingId, fp);
}

export function deleteFinding(meetingId, id) {
  const res = getDb().prepare('DELETE FROM meeting_findings WHERE meeting = ? AND id = ?')
    .run(meetingId, Number(id));
  return { deleted: res.changes };
}

/**
 * THE APPROVED REQUIREMENT SET — the contract phase 5 builds from.
 *
 * Only confirmed findings, and for model-authored ones only those an evidence
 * check actually passed. A human-added finding needs no citation. This is the
 * one function the ServiceNow half of the module will ever call, and it is
 * deliberately narrow: everything upstream of it can be replaced without the
 * build stage noticing.
 */
export function approvedSet(meetingId) {
  const all = listFindings(meetingId);
  const eligible = all.filter((f) =>
    f.status === 'confirmed' && (f.origin === 'human' || f.verified));
  return {
    meeting: meetingId,
    requirements: eligible.filter((f) => f.kind === 'requirement'),
    decisions: eligible.filter((f) => f.kind === 'decision'),
    criteria: eligible.filter((f) => f.kind === 'criterion'),
    openQuestions: all.filter((f) => f.kind === 'question' && f.status !== 'rejected'),
    assumptions: eligible.filter((f) => f.kind === 'assumption'),
    counts: {
      total: all.length,
      confirmed: all.filter((f) => f.status === 'confirmed').length,
      proposed: all.filter((f) => f.status === 'proposed').length,
      rejected: all.filter((f) => f.status === 'rejected').length,
      unverified: all.filter((f) => f.origin === 'model' && !f.verified).length,
    },
  };
}
