import crypto from 'node:crypto';
import { getDb } from './db.js';
import { getSettings } from '../config/store.js';
import { currentActor } from './audit.js';

/**
 * A-1 — session persistence.
 *
 * The bug this fixes at the root: chat history lived in a module-level `Map`,
 * so navigating Agent -> Settings -> Agent lost the transcript, and restarting
 * the server lost every conversation that had ever happened. The agent could
 * not be asked about a sys_id from two turns earlier because there were no
 * earlier turns.
 *
 * The orchestrator now writes through on every append. `messages.json` holds
 * the neutral history entry verbatim, so this table does not need migrating
 * each time an adapter learns a new field.
 */

const now = () => new Date().toISOString();

/** A session title is the first user message, trimmed to something readable. */
export function deriveTitle(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'New chat';
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

/** The instance a session belongs to; conversations are per-instance context. */
function currentInstance() {
  return (getSettings().connection.instanceUrl || '').replace(/\/+$/, '') || '(unbound)';
}

export function createSession({ id, title } = {}) {
  const db = getDb();
  const sid = id || crypto.randomUUID();
  const ts = now();
  db.prepare(
    'INSERT OR IGNORE INTO sessions (id, title, created, updated, instance) VALUES (?, ?, ?, ?, ?)'
  ).run(sid, title || null, ts, ts, currentInstance());
  return getSession(sid);
}

export function getSession(id) {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return row || null;
}

/** Newest first — the rail's order. */
export function listSessions({ limit = 200 } = {}) {
  return getDb()
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM messages m WHERE m.session = s.id) AS message_count,
              (SELECT COUNT(*) FROM tool_events t WHERE t.session = s.id AND t.mutating = 1) AS mutation_count
         FROM sessions s
        ORDER BY s.updated DESC
        LIMIT ?`
    )
    .all(limit);
}

export function renameSession(id, title) {
  const clean = String(title || '').trim();
  if (!clean) throw new Error('A session title cannot be empty.');
  const res = getDb().prepare('UPDATE sessions SET title = ?, updated = ? WHERE id = ?').run(clean, now(), id);
  if (res.changes === 0) throw new Error(`No session ${id}.`);
  return getSession(id);
}

export function deleteSession(id) {
  // messages, tool_events and digests cascade; chunks are cleaned explicitly
  // because they are keyed by (kind, session, ref) rather than by a FK, so that
  // a fact chunk and a message chunk can share the table.
  const db = getDb();
  db.prepare('DELETE FROM chunks WHERE kind = ? AND session = ?').run('message', id);
  const res = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return { deleted: res.changes > 0 };
}

/** Next sequence number for a session's message log. */
function nextSeq(sessionId) {
  const row = getDb().prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM messages WHERE session = ?').get(sessionId);
  return (row?.m ?? -1) + 1;
}

/**
 * Append one neutral-history entry. Returns the stored seq.
 *
 * The session is created on demand: the client mints a session id before the
 * first turn, and requiring an explicit create first would mean a lost race
 * silently drops the opening message.
 */
export function appendMessage(sessionId, entry) {
  const db = getDb();
  if (!getSession(sessionId)) createSession({ id: sessionId });
  const seq = nextSeq(sessionId);
  const ts = now();
  db.prepare('INSERT INTO messages (session, seq, role, json, ts) VALUES (?, ?, ?, ?, ?)').run(
    sessionId,
    seq,
    entry.role,
    JSON.stringify(entry),
    ts
  );

  // First user message names the session, unless the user has renamed it.
  if (entry.role === 'user') {
    const s = getSession(sessionId);
    if (!s.title) db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(deriveTitle(entry.text), sessionId);
  }
  db.prepare('UPDATE sessions SET updated = ? WHERE id = ?').run(ts, sessionId);
  return seq;
}

/**
 * Replace one already-stored entry in place (WI-3).
 *
 * The narrow reason this exists: when the ask-XOR-act guard withholds a write,
 * the assistant row carrying that tool call has already been appended. A
 * `tool_calls` entry with no matching tool result is the one shape the wire
 * format rejects outright, so leaving it there would not merely be untidy — it
 * would make every later request in the session fail, which is the defect
 * `toOpenAiMessages` was written to close. Withheld means withheld: the call
 * leaves history with it.
 *
 * Deliberately not a general-purpose editor. It refuses to touch a row that is
 * not there, and it does not renumber, move or merge anything.
 */
export function rewriteMessage(sessionId, seq, entry) {
  const db = getDb();
  const res = db.prepare('UPDATE messages SET role = ?, json = ? WHERE session = ? AND seq = ?')
    .run(entry.role, JSON.stringify(entry), sessionId, Number(seq));
  if (res.changes === 0) throw new Error(`No message ${seq} in session ${sessionId} to rewrite.`);
  return seq;
}

/** The neutral history, in order — exactly what the orchestrator loop wants. */
/** The seq of the newest user message — the key a retried turn's ledger hangs off. */
export function latestUserSeq(sessionId) {
  const row = getDb()
    .prepare("SELECT MAX(seq) AS s FROM messages WHERE session = ? AND role = 'user'")
    .get(sessionId);
  return row?.s ?? 0;
}

export function loadHistory(sessionId) {
  const rows = getDb()
    .prepare('SELECT json FROM messages WHERE session = ? ORDER BY seq ASC')
    .all(sessionId);
  const out = [];
  for (const r of rows) {
    try { out.push(JSON.parse(r.json)); } catch { /* a corrupt row must not sink the session */ }
  }
  return out;
}

/** Rows for the UI, with their seq so the client can key on something stable. */
export function loadMessages(sessionId) {
  return getDb()
    .prepare('SELECT seq, role, json, ts FROM messages WHERE session = ? ORDER BY seq ASC')
    .all(sessionId)
    .map((r) => {
      let entry = null;
      try { entry = JSON.parse(r.json); } catch { /* leave null */ }
      return { seq: r.seq, role: r.role, ts: r.ts, entry };
    })
    .filter((m) => m.entry);
}

/**
 * The audit trail. Separate from messages because compaction rewrites history
 * and must never rewrite the record of what was done to the instance.
 *
 * D-5 added `result`, `instance` and `actor`. The first is what made this
 * table able to answer its own question: a created record's sys_id exists only
 * in the tool's return value, so without it "what did this session do to the
 * instance" was unanswerable from the audit trail itself. The other two are
 * captured per event rather than read off the session, because the bound
 * connection can change underneath a long conversation and the trail has to
 * say which instance a write actually landed on.
 */
export function recordToolEvent(sessionId, event) {
  const db = getDb();
  if (!getSession(sessionId)) createSession({ id: sessionId });
  const row = db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM tool_events WHERE session = ?').get(sessionId);
  const seq = (row?.m ?? -1) + 1;
  const { instance, actor } = currentActor();
  db.prepare(
    `INSERT INTO tool_events (session, seq, kind, name, payload, result, result_status, mutating, approval,
                              approved_source, approved_at, instance, actor, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    seq,
    event.kind,
    event.name ?? null,
    event.payload === undefined ? null : JSON.stringify(event.payload),
    event.result === undefined || event.result === null ? null : String(event.result),
    event.resultStatus ?? null,
    event.mutating ? 1 : 0,
    event.approval ?? null,
    // WI-4. Written as given — an approval this code cannot attribute is stored
    // as 'unknown' rather than guessed at, and 'unknown' does not execute.
    event.approval ? (event.approvedSource ?? 'unknown') : null,
    event.approvedAt ?? null,
    instance,
    actor,
    now()
  );
  return seq;
}

export function loadToolEvents(sessionId) {
  return getDb()
    .prepare('SELECT * FROM tool_events WHERE session = ? ORDER BY seq ASC')
    .all(sessionId)
    .map((r) => ({
      ...r,
      mutating: Boolean(r.mutating),
      payload: r.payload ? safeParse(r.payload) : null,
    }));
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

/** Replace a span of history with a digest (A-3). Tool events are untouched. */
export function replaceSpanWithDigest(sessionId, fromSeq, toSeq, digestText) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM messages WHERE session = ? AND seq >= ? AND seq <= ?').run(sessionId, fromSeq, toSeq);
    db.prepare('DELETE FROM chunks WHERE kind = ? AND session = ? AND CAST(ref AS INTEGER) BETWEEN ? AND ?')
      .run('message', sessionId, fromSeq, toSeq);
    db.prepare('INSERT OR REPLACE INTO digests (session, from_seq, to_seq, text, ts) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, fromSeq, toSeq, digestText, now());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function loadDigests(sessionId) {
  return getDb()
    .prepare('SELECT from_seq, to_seq, text, ts FROM digests WHERE session = ? ORDER BY from_seq ASC')
    .all(sessionId);
}
