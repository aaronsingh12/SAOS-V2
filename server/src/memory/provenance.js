import { getDb } from './db.js';
import { log } from '../logging.js';

/**
 * Follow-up WI-1 — where every sys_id in this session came from.
 *
 * THE DEBT THIS CLOSES. A weak model will produce a well-formed 32-hex string
 * that no record has ever had, put it in an `update_record` payload, and the
 * gate will render it a card. `bfdd8816…` is the standing example. Nothing
 * downstream can catch it either: the write reaches a sys_id that does not
 * exist, the platform answers, and the read-back verifies whatever it finds.
 *
 * A sys_id with no provenance is not a target. That is the whole rule.
 *
 * AN INDEX, NOT A SECOND SOURCE OF TRUTH. Every row is written by the same
 * call that writes the durable record it derives from, so there is exactly one
 * producer per source and nothing to reconcile:
 *
 *   tool_result   recordToolEvent  — already holds the full result JSON, which
 *                                    is also the only place the table, the row
 *                                    count, and the number↔sys_id pairing all
 *                                    exist at once
 *   user_message  appendMessage    — written before any compaction can reach
 *                                    the message it came from
 *   ledger_fact   recordFact       — the facts table is already durable
 *
 * NEVER THROWS. A registry failure must not fail the turn it is indexing;
 * every entry point swallows and logs. The consequence of a missed write is a
 * later hard block with an honest message, which is the safe direction.
 */

const now = () => new Date().toISOString();

export const PROVENANCE_SOURCES = Object.freeze({
  USER_MESSAGE: 'user_message',
  TOOL_RESULT: 'tool_result',
  LEDGER_FACT: 'ledger_fact',
});

/** A ServiceNow sys_id, and the id a human reads off a card. */
export const SYS_ID_RE = /\b[0-9a-f]{32}\b/g;
export const RECORD_NUMBER_RE = /\b[A-Z]{2,6}\d{6,}\b/g;

/** The platform returns either a bare value or a {display_value, value} pair. */
const cell = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

/**
 * Every record in a tool result, as {sys_id, display_id}.
 *
 * Walks rather than pattern-matches on the known tool shapes: a query returns
 * an array, a get returns an object, and a composite builder returns an object
 * with records nested two or three deep. Missing one of those shapes here does
 * not produce a wrong answer later — it produces a hard block with a message
 * saying the sys_id was never seen, which is loud and recoverable.
 */
export function extractRecords(value, depth = 0, out = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 6) return out;
  if (Array.isArray(value)) {
    for (const item of value) extractRecords(item, depth + 1, out, seen);
    return out;
  }
  const sysId = String(cell(value.sys_id) ?? '').trim().toLowerCase();
  if (/^[0-9a-f]{32}$/.test(sysId) && !seen.has(sysId)) {
    seen.add(sysId);
    const display = ['number', 'name', 'title'].map((f) => cell(value[f])).find((v) => v);
    out.push({ sys_id: sysId, display_id: display ? String(display) : null });
  }
  for (const v of Object.values(value)) {
    if (v && typeof v === 'object') extractRecords(v, depth + 1, out, seen);
  }
  return out;
}

function insert({ session, sys_id, table_name, display_id, source, event_seq, row_count }) {
  getDb().prepare(
    `INSERT OR IGNORE INTO sysid_provenance
       (session, sys_id, table_name, display_id, source, event_seq, row_count, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(session, sys_id, table_name ?? null, display_id ?? null, source, event_seq ?? -1, row_count ?? 1, now());
}

/**
 * Register everything a tool result put into context.
 *
 * `row_count` is the size of the result SET, not of the row — five incidents
 * from one query are five rows of row_count 5, which is what makes "the model
 * chose one of these" checkable without reading any prose.
 */
export function registerFromToolResult({ sessionId, seq, table, result }) {
  try {
    let parsed = result;
    if (typeof parsed === 'string') {
      // Tool results are stored as text, sometimes with harness notes appended
      // after the JSON. Parse what parses; a failure is a miss, not an error.
      try { parsed = JSON.parse(parsed); } catch { return 0; }
    }
    const records = extractRecords(parsed);
    if (!records.length) return 0;
    for (const r of records) {
      insert({
        session: sessionId, sys_id: r.sys_id, table_name: table || null, display_id: r.display_id,
        source: PROVENANCE_SOURCES.TOOL_RESULT, event_seq: seq ?? -1, row_count: records.length,
      });
    }
    return records.length;
  } catch (err) {
    log.warn('provenance', `could not index a tool result: ${err.message}`);
    return 0;
  }
}

/**
 * A sys_id the USER typed is a target by definition — they are the authority on
 * what they meant. Registered before any fold can reach the message.
 */
export function registerFromUserMessage(sessionId, text) {
  try {
    const ids = [...new Set(String(text || '').toLowerCase().match(SYS_ID_RE) || [])];
    for (const sys_id of ids) {
      insert({
        session: sessionId, sys_id, table_name: null, display_id: null,
        source: PROVENANCE_SOURCES.USER_MESSAGE, event_seq: -1, row_count: 1,
      });
    }
    return ids.length;
  } catch (err) {
    log.warn('provenance', `could not index a user message: ${err.message}`);
    return 0;
  }
}

/**
 * The knowledge ledger, consulted rather than mirrored.
 *
 * Facts are INSTANCE-scoped and this index is SESSION-scoped, so pre-registering
 * them would mean copying every fact into every session and threading a
 * sessionId through `recordFact`, `seedLedger` and the tools that call them —
 * a parameter most callers have no use for, and a copy that can go stale.
 *
 * So a sys_id the ledger already states is looked up on demand, and registered
 * at that point so the answer is recorded rather than recomputed. Same single
 * producer, later.
 */
function factStating(sysId) {
  try {
    return getDb()
      .prepare("SELECT kind, key, value FROM facts WHERE instr(lower(value), ?) > 0 LIMIT 1")
      .get(sysId) || null;
  } catch { return null; }
}

export function registerFromFact(sessionId, fact) {
  if (!sessionId || !fact) return 0;
  try {
    const ids = [...new Set(String(fact.value || '').toLowerCase().match(SYS_ID_RE) || [])];
    for (const sys_id of ids) {
      insert({
        session: sessionId, sys_id, table_name: null, display_id: fact.key || null,
        source: PROVENANCE_SOURCES.LEDGER_FACT, event_seq: -1, row_count: 1,
      });
    }
    return ids.length;
  } catch (err) {
    log.warn('provenance', `could not index a fact: ${err.message}`);
    return 0;
  }
}

/** Every registered origin for one sys_id in one session, oldest first. */
export function originsOf(sessionId, sysId) {
  if (!sessionId || !sysId) return [];
  try {
    return getDb()
      .prepare('SELECT * FROM sysid_provenance WHERE session = ? AND sys_id = ? ORDER BY id')
      .all(sessionId, String(sysId).trim().toLowerCase());
  } catch { return []; }
}

/**
 * THE ALIASING FIX, and the reason `display_id` is on the row.
 *
 * Identifiers alias; records do not. "INC0010055" and
 * "3324289783b6cf50b939cc65eeaad335" are two strings for one record, and the
 * only moment both are in hand is the read that resolved them — which is
 * exactly where this index is written. Counting identifiers rather than
 * records is the false positive that cost a live round last sprint; here it
 * cannot arise, because the question is answered against records.
 */
export function resolveDisplayId(sessionId, displayId) {
  if (!sessionId || !displayId) return null;
  try {
    const row = getDb()
      .prepare('SELECT sys_id FROM sysid_provenance WHERE session = ? AND display_id = ? ORDER BY id DESC LIMIT 1')
      .get(sessionId, String(displayId));
    return row?.sys_id || null;
  } catch { return null; }
}

/** Which records the user's own message names — by sys_id or by number. */
export function targetsNamedByUser(sessionId, text) {
  const raw = String(text || '');
  const out = new Set();
  for (const id of raw.toLowerCase().match(SYS_ID_RE) || []) out.add(id);
  for (const num of raw.match(RECORD_NUMBER_RE) || []) {
    const resolved = resolveDisplayId(sessionId, num);
    if (resolved) out.add(resolved);
  }
  return [...out];
}

/**
 * The gate's question, answered from the registry rather than from prose.
 *
 *   confabulated — nothing in this session ever produced this sys_id. Hard
 *                  block: no card, and the payload goes to the log because it
 *                  is the only record of what was about to happen.
 *   ambiguous    — it arrived only as one row of a multi-row read, and nothing
 *                  since has narrowed it: the user has not named it and no
 *                  later read returned it alone. The model is choosing.
 *   ok           — everything else.
 *
 * Narrowing is monotone on purpose. One unique arrival — a create, a get, a
 * user naming it — settles a sys_id for the rest of the session; a later broad
 * query cannot un-settle it, because the user's earlier choice does not expire.
 */
export function checkWriteTarget({ sessionId, sysId, userText = '' }) {
  const id = String(sysId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(id)) return { verdict: 'ok', reason: 'not-a-sys-id' };

  let origins = originsOf(sessionId, id);

  if (!origins.length) {
    // Last door before the hard block: the knowledge ledger. A sys_id this
    // project has already measured and written down is established, and
    // blocking a write to it would be the guard being wrong in the expensive
    // direction. Registered on the way past so it is recorded, not re-derived.
    const fact = factStating(id);
    if (fact) {
      registerFromFact(sessionId, { key: fact.key, value: fact.value });
      origins = originsOf(sessionId, id);
    }
  }
  if (!origins.length) return { verdict: 'confabulated', origins: [] };

  if (targetsNamedByUser(sessionId, userText).includes(id)) {
    return { verdict: 'ok', reason: 'user-named-it', origins };
  }
  const unique = origins.find((o) => o.row_count === 1);
  if (unique) return { verdict: 'ok', reason: `narrowed-by-${unique.source}`, origins };

  const widest = origins.reduce((a, b) => (b.row_count > a.row_count ? b : a));
  const siblings = getDb()
    .prepare('SELECT sys_id, display_id FROM sysid_provenance WHERE session = ? AND event_seq = ? ORDER BY id')
    .all(sessionId, widest.event_seq)
    .map((r) => r.display_id || r.sys_id);

  return { verdict: 'ambiguous', origins, rowCount: widest.row_count, candidates: siblings };
}

/** Test hook and housekeeping: the rows for one session. */
export function provenanceFor(sessionId) {
  try {
    return getDb().prepare('SELECT * FROM sysid_provenance WHERE session = ? ORDER BY id').all(sessionId);
  } catch { return []; }
}
