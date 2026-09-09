import crypto from 'node:crypto';
import { getDb } from '../memory/db.js';
import { getSettings } from '../config/store.js';
import { log } from '../logging.js';
import { audioDirFor, ensureAudioDir, removeAudioDir, dirBytes } from './audio-store.js';

const now = () => new Date().toISOString();

export const MEETING_STATUS = Object.freeze({
  RECORDING: 'recording',
  CAPTURED: 'captured',
  CONFIRMED: 'confirmed',
  DISCARDED: 'discarded',
});

export const TRACKS = Object.freeze(['mic', 'system']);

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * Open a meeting and hand the agent the directory it may write to.
 *
 * The instance is stamped at capture time rather than read at build time. A
 * meeting recorded while pointed at one PDI and built against another is a real
 * sequence — the connection is a single mutable setting — and the honest record
 * is which instance was bound when the conversation happened.
 */
export function startMeeting({ title, sourceApp, sourcePid, detectedBy, agentVersion, startedAt } = {}) {
  const db = getDb();
  const id = crypto.randomUUID();
  const dir = ensureAudioDir(id);
  const started = startedAt || now();
  const instance = (getSettings().connection.instanceUrl || '').replace(/\/+$/, '') || null;
  db.prepare(
    `INSERT INTO meetings (id, title, source_app, source_pid, detected_by, status, started, audio_dir, agent_version, instance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    title || null,
    sourceApp || null,
    Number.isFinite(sourcePid) ? sourcePid : null,
    detectedBy || 'auto',
    MEETING_STATUS.RECORDING,
    started,
    dir,
    agentVersion || null,
    instance,
  );
  log.info('meetings', `meeting started  ${id}  ${title || '(untitled)'}  via ${detectedBy || 'auto'}`);
  return { id, audioDir: dir, started, instance };
}

export function endMeeting(id, { endedAt } = {}) {
  const db = getDb();
  const m = getMeeting(id);
  if (!m) return null;
  const ended = endedAt || now();
  const duration = Math.max(0, Date.parse(ended) - Date.parse(m.started)) || null;
  const bytes = dirBytes(audioDirFor(id));
  db.prepare(
    `UPDATE meetings SET status = ?, ended = ?, duration_ms = ?, audio_bytes = ? WHERE id = ?`
  ).run(MEETING_STATUS.CAPTURED, ended, duration, bytes, id);
  log.info('meetings', `meeting ended  ${id}  ${Math.round((duration || 0) / 1000)}s  ${segmentCount(id)} utterances  ${bytes} bytes`);
  return getMeeting(id);
}

/* ------------------------------------------------------------------ *
 * Segments
 * ------------------------------------------------------------------ */

/**
 * Record one closed utterance.
 *
 * IDEMPOTENT ON (meeting, idx), and that is load-bearing rather than defensive.
 * The agent posts over a socket that can drop; its only safe recovery is to
 * post again. Without the upsert a retry would either fail the whole meeting on
 * a constraint error or, worse, duplicate the utterance and double-count it in
 * every later stage. `idx` comes from the agent because only the agent knows
 * capture order — arrival order here is not timeline order.
 */
export function addSegment(meetingId, seg) {
  const db = getDb();
  const idx = Number(seg.idx);
  if (!Number.isInteger(idx) || idx < 0) {
    throw Object.assign(new Error('idx must be a non-negative integer assigned at capture time'), { status: 400 });
  }
  if (!TRACKS.includes(seg.track)) {
    throw Object.assign(new Error(`track must be one of ${TRACKS.join(', ')}`), { status: 400 });
  }
  const start = Number(seg.start_ms);
  const end = Number(seg.end_ms);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw Object.assign(new Error('start_ms and end_ms must be numbers with end_ms >= start_ms'), { status: 400 });
  }
  db.prepare(
    `INSERT INTO meeting_segments (meeting, idx, track, start_ms, end_ms, audio_path, bytes, sha256, rms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (meeting, idx) DO UPDATE SET
       track = excluded.track, start_ms = excluded.start_ms, end_ms = excluded.end_ms,
       audio_path = excluded.audio_path, bytes = excluded.bytes,
       sha256 = excluded.sha256, rms = excluded.rms`
  ).run(
    meetingId, idx, seg.track, Math.round(start), Math.round(end),
    seg.audio_path || null, Number(seg.bytes) || 0, seg.sha256 || null,
    Number.isFinite(Number(seg.rms)) ? Number(seg.rms) : null,
  );
  return getSegment(meetingId, idx);
}

export function getSegment(meetingId, idx) {
  return getDb().prepare('SELECT * FROM meeting_segments WHERE meeting = ? AND idx = ?').get(meetingId, Number(idx)) || null;
}

/**
 * The timeline, in TIME order.
 *
 * Ordered by start_ms and then idx — never by `id`, which is arrival order. Two
 * tracks are being written concurrently by two threads, so insertion order is
 * whichever utterance happened to close first, and reading it back that way
 * would interleave the conversation wrongly and put an answer before its
 * question.
 */
export function listSegments(meetingId) {
  return getDb()
    .prepare('SELECT * FROM meeting_segments WHERE meeting = ? ORDER BY start_ms ASC, idx ASC')
    .all(meetingId);
}

export function segmentCount(meetingId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM meeting_segments WHERE meeting = ?').get(meetingId).n;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export function getMeeting(id) {
  return getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id) || null;
}

export function listMeetings({ limit = 100 } = {}) {
  const rows = getDb()
    .prepare('SELECT * FROM meetings ORDER BY started DESC LIMIT ?')
    .all(Math.min(Number(limit) || 100, 500));
  const counts = getDb()
    .prepare('SELECT meeting, COUNT(*) AS n, SUM(end_ms - start_ms) AS speech_ms FROM meeting_segments GROUP BY meeting')
    .all();
  const byId = new Map(counts.map((c) => [c.meeting, c]));
  return rows.map((r) => ({
    ...r,
    segments: byId.get(r.id)?.n || 0,
    speech_ms: byId.get(r.id)?.speech_ms || 0,
  }));
}

/**
 * How much recorded audio is sitting on disk awaiting a decision.
 *
 * Deletion is tied to the user confirming a transcript, which means a meeting
 * nobody ever opens keeps its audio forever. That is the honest consequence of
 * the retention rule, so the number is surfaced rather than quietly growing —
 * the Meetings page shows it, permanently.
 */
export function pendingAudio() {
  const rows = getDb()
    .prepare(`SELECT id, title, started, audio_bytes FROM meetings
              WHERE audio_dir IS NOT NULL AND status IN (?, ?)`)
    .all(MEETING_STATUS.RECORDING, MEETING_STATUS.CAPTURED);
  // Measured off the filesystem, not the column: a meeting still recording has
  // a stale audio_bytes, and a column that disagrees with the disk is worse
  // than no column.
  const meetings = rows.map((r) => ({ ...r, bytes: dirBytes(audioDirFor(r.id)) }));
  return { meetings, count: meetings.length, bytes: meetings.reduce((a, m) => a + m.bytes, 0) };
}

/* ------------------------------------------------------------------ *
 * Retention
 * ------------------------------------------------------------------ */

/**
 * CONFIRM A TRANSCRIPT — freeze it, then delete the audio.
 *
 * The user asked for exactly this rule: the recording goes once they have
 * confirmed the transcript is saved. Two consequences are made explicit here
 * rather than left implicit:
 *
 *   - The meeting is FROZEN at this point. From here the transcript is the only
 *     record of what was said, which is precisely what makes a later evidence
 *     citation trustworthy — it points at something that can no longer change.
 *   - If the deletion does not fully succeed, the meeting is STILL confirmed
 *     (the user's decision stands and re-asking would be noise) but `audio_dir`
 *     is kept, so it continues to count as holding bytes and the caller gets
 *     the surviving paths to show. Reporting a clean delete here would be a
 *     lie about voice recordings, which is the one lie this module must not
 *     tell.
 */
export function confirmMeeting(id) {
  const db = getDb();
  const m = getMeeting(id);
  if (!m) return null;
  if (m.status === MEETING_STATUS.RECORDING) {
    throw Object.assign(new Error(
      'This meeting is still recording. Confirming now would delete audio the agent is actively writing to. '
      + 'Stop the meeting first.'
    ), { status: 409 });
  }

  const result = removeAudioDir(m.audio_dir || audioDirFor(id));
  const ts = now();

  db.prepare(
    `UPDATE meetings SET status = ?, confirmed = ?, audio_deleted = ?, audio_dir = ?, audio_bytes = ? WHERE id = ?`
  ).run(
    MEETING_STATUS.CONFIRMED,
    ts,
    result.ok ? ts : null,
    result.ok ? null : (m.audio_dir || audioDirFor(id)),
    result.ok ? 0 : dirBytes(audioDirFor(id)),
    id,
  );

  // The audio path on each segment is now a claim about a file that is gone.
  if (result.ok) db.prepare('UPDATE meeting_segments SET audio_path = NULL WHERE meeting = ?').run(id);

  return { meeting: getMeeting(id), deletion: result };
}

/**
 * Close meetings left stuck in `recording`.
 *
 * A meeting only leaves `recording` when the agent posts /end. If the agent
 * dies, is killed, or hangs before that — which is exactly what the WASAPI
 * loopback deadlock did, since a blocking read on a silent loopback never
 * returned and took the whole agent down with it — the row stays `recording`
 * forever. The page then shows a meeting that is permanently in progress, its
 * audio is never eligible for confirmation, and the utterances that WERE
 * captured can never be reviewed.
 *
 * Called at boot, when nothing can legitimately be recording yet: the agent
 * connects afterwards and opens its own meeting. The duration is recomputed
 * from the last utterance rather than from `now`, because the wall clock since
 * has nothing to do with how long anyone was talking.
 */
export function closeOrphanedRecordings() {
  const db = getDb();
  const rows = db.prepare(`SELECT id, started FROM meetings WHERE status = ?`).all(MEETING_STATUS.RECORDING);
  const closed = [];
  for (const r of rows) {
    const last = db.prepare('SELECT MAX(end_ms) AS ms FROM meeting_segments WHERE meeting = ?').get(r.id)?.ms;
    const duration = Number.isFinite(last) && last > 0 ? last : null;
    const ended = duration
      ? new Date(Date.parse(r.started) + duration).toISOString()
      : r.started;
    db.prepare(
      `UPDATE meetings SET status = ?, ended = ?, duration_ms = ?, audio_bytes = ?,
              notes = COALESCE(notes, '') || ?
         WHERE id = ?`
    ).run(
      MEETING_STATUS.CAPTURED, ended, duration, dirBytes(audioDirFor(r.id)),
      'Closed automatically: the capture agent stopped without ending this meeting.',
      r.id,
    );
    closed.push(r.id);
  }
  if (closed.length) {
    log.warn('meetings',
      `${closed.length} meeting(s) were still marked as recording and have been closed — `
      + 'the capture agent stopped without posting /end. Anything already captured is intact.');
  }
  return closed.length;
}

/** Discard a meeting outright — the "I didn't want that recorded" button. */
export function discardMeeting(id) {
  const db = getDb();
  const m = getMeeting(id);
  if (!m) return null;
  const result = removeAudioDir(m.audio_dir || audioDirFor(id));
  db.prepare(
    `UPDATE meetings SET status = ?, audio_deleted = ?, audio_dir = ?, audio_bytes = 0, ended = COALESCE(ended, ?) WHERE id = ?`
  ).run(MEETING_STATUS.DISCARDED, result.ok ? now() : null, result.ok ? null : m.audio_dir, now(), id);
  if (result.ok) db.prepare('UPDATE meeting_segments SET audio_path = NULL WHERE meeting = ?').run(id);
  log.info('meetings', `meeting discarded  ${id}  audio removed: ${result.ok}`);
  return { meeting: getMeeting(id), deletion: result };
}
