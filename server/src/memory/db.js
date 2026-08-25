import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../logging.js';

/**
 * One SQLite file for everything NowHelpAssist needs to remember: sessions,
 * messages, tool events, the per-instance knowledge ledger, and recall
 * embeddings.
 *
 * Why the built-in `node:sqlite` rather than better-sqlite3 — this was checked,
 * not assumed. On this machine (Node v24.18.0) the built-in covers every need:
 *
 *   DatabaseSync / StatementSync   present
 *   BLOB round-trip (Uint8Array)   works — needed for float32 embeddings
 *   FTS5 virtual tables            available — needed for the keyword fallback
 *
 * That makes the whole storage layer dependency-free, which matters here: this
 * is a Windows machine with no node-gyp toolchain, and better-sqlite3 would
 * have meant relying on a prebuilt binary matching this exact Node ABI.
 *
 * Migrations are idempotent and run on boot, keyed on `PRAGMA user_version`, so
 * starting an older or newer server against an existing file is safe.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'nowhelpassist.db');
const LEGACY_DB_FILE = path.join(DATA_DIR, 'nowforge.db');

let handle = null;

/**
 * Each migration runs exactly once, in order. NEVER edit one that has shipped —
 * append a new one. `user_version` is the only thing that decides what has run,
 * and an edited migration would silently skip on every existing database.
 */
const MIGRATIONS = [
  // 1 — sessions, messages, tool events (A-1)
  `
  CREATE TABLE IF NOT EXISTS sessions (
    id       TEXT PRIMARY KEY,
    title    TEXT,
    created  TEXT NOT NULL,
    updated  TEXT NOT NULL,
    instance TEXT
  );

  -- One row per neutral-history entry. \`json\` is the entry verbatim, so the
  -- orchestrator's format stays the single source of truth and this table does
  -- not have to be migrated every time a provider adapter learns something new.
  CREATE TABLE IF NOT EXISTS messages (
    session TEXT NOT NULL,
    seq     INTEGER NOT NULL,
    role    TEXT NOT NULL,
    json    TEXT NOT NULL,
    ts      TEXT NOT NULL,
    PRIMARY KEY (session, seq),
    FOREIGN KEY (session) REFERENCES sessions(id) ON DELETE CASCADE
  );

  -- Separate from messages on purpose: this is the audit trail of what the
  -- agent DID to the instance, including whether a human approved it. It
  -- outlives compaction, which rewrites messages but must never rewrite this.
  CREATE TABLE IF NOT EXISTS tool_events (
    session       TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    kind          TEXT NOT NULL,
    name          TEXT,
    payload       TEXT,
    result_status TEXT,
    mutating      INTEGER NOT NULL DEFAULT 0,
    approval      TEXT,
    ts            TEXT NOT NULL,
    PRIMARY KEY (session, seq),
    FOREIGN KEY (session) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated DESC);
  CREATE INDEX IF NOT EXISTS idx_tool_events_name ON tool_events(session, name);
  `,

  // 2 — instance knowledge ledger (A-4)
  `
  CREATE TABLE IF NOT EXISTS facts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    instance   TEXT NOT NULL,
    kind       TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    provenance TEXT,
    confidence REAL NOT NULL DEFAULT 0.5,
    ts         TEXT NOT NULL,
    UNIQUE (instance, kind, key)
  );
  CREATE INDEX IF NOT EXISTS idx_facts_instance ON facts(instance, kind);
  `,

  // 3 — recall: embeddings, and an FTS index for the no-embedding fallback (A-5)
  `
  CREATE TABLE IF NOT EXISTS chunks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    kind     TEXT NOT NULL,          -- 'message' | 'fact'
    session  TEXT,                   -- null for facts
    ref      TEXT NOT NULL,          -- message seq, or fact id
    instance TEXT,
    text     TEXT NOT NULL,
    ts       TEXT NOT NULL,
    UNIQUE (kind, session, ref)
  );

  -- float32 little-endian blob + its dimension, so a model change is detectable
  -- rather than producing silently meaningless cosine scores.
  CREATE TABLE IF NOT EXISTS embeddings (
    chunk  INTEGER PRIMARY KEY,
    model  TEXT NOT NULL,
    dim    INTEGER NOT NULL,
    vec    BLOB NOT NULL,
    FOREIGN KEY (chunk) REFERENCES chunks(id) ON DELETE CASCADE
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text,
    content='chunks',
    content_rowid='id',
    tokenize='porter unicode61'
  );

  -- Triggers keep FTS in step with chunks. Without them the fallback search
  -- silently returns stale rows, which is exactly the class of quiet wrongness
  -- this project keeps having to dig out.
  CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;

  CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session);
  `,

  // 4 — compaction digests (A-3)
  `
  CREATE TABLE IF NOT EXISTS digests (
    session   TEXT NOT NULL,
    from_seq  INTEGER NOT NULL,
    to_seq    INTEGER NOT NULL,
    text      TEXT NOT NULL,
    ts        TEXT NOT NULL,
    PRIMARY KEY (session, from_seq),
    FOREIGN KEY (session) REFERENCES sessions(id) ON DELETE CASCADE
  );
  `,

  // 5 — the audit trail (D-5)
  //
  // Two gaps this closes, both of which made \`tool_events\` unable to answer
  // the question it exists for.
  //
  // (a) It recorded WHAT was called and whether it succeeded, but never what
  //     came back — and the sys_id of the thing that was created is in the
  //     result, nowhere else. "Reconstruct what this session did to the
  //     instance" was unanswerable from the table named after it.
  // (b) It is keyed on an agent session, so every build driven from the UI —
  //     a flow deploy, a catalog UI policy, an SLA verification, each of which
  //     writes to the instance through the SDK — left no trace anywhere.
  //
  // \`actor\` and \`instance\` are captured per event rather than read from the
  // session, because the bound connection can change underneath a session and
  // the audit has to say which instance a write actually landed on.
  `
  ALTER TABLE tool_events ADD COLUMN result TEXT;
  ALTER TABLE tool_events ADD COLUMN actor TEXT;
  ALTER TABLE tool_events ADD COLUMN instance TEXT;

  -- One row per UI-driven build. These are long (a Fluent build and a whole-
  -- application install take about a minute), so the run and its event stream
  -- are separate: the run is the auditable unit, the events are the evidence.
  CREATE TABLE IF NOT EXISTS build_runs (
    id       TEXT PRIMARY KEY,
    kind     TEXT NOT NULL,
    label    TEXT,
    instance TEXT,
    actor    TEXT,
    session  TEXT,               -- set when an agent turn drove it; null for UI
    status   TEXT NOT NULL,      -- running | ok | error
    request  TEXT,
    summary  TEXT,
    dropped  INTEGER NOT NULL DEFAULT 0,
    started  TEXT NOT NULL,
    finished TEXT
  );

  CREATE TABLE IF NOT EXISTS build_events (
    run     TEXT NOT NULL,
    seq     INTEGER NOT NULL,
    type    TEXT,
    payload TEXT,
    ts      TEXT NOT NULL,
    PRIMARY KEY (run, seq),
    FOREIGN KEY (run) REFERENCES build_runs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_build_runs_started ON build_runs(started DESC);
  CREATE INDEX IF NOT EXISTS idx_tool_events_ts ON tool_events(ts DESC);
  `,

  // 6 — session update-set capture (v0.5a transport)
  //
  // Two tables, because they answer different questions and have different
  // lifetimes. \`capture_state\` is a preference; \`capture_sets\` is a record of
  // something that exists on an instance and will outlive the session row.
  //
  // Capture is ON by default, so ABSENCE of a row means enabled. Only an
  // explicit toggle writes here — which keeps the default in one place
  // (\`isCaptureOn\`) rather than depending on every session-creation path
  // remembering to seed a row.
  `
  CREATE TABLE IF NOT EXISTS capture_state (
    session TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    updated TEXT NOT NULL,
    FOREIGN KEY (session) REFERENCES sessions(id) ON DELETE CASCADE
  );

  -- One row per (session, instance, scope). The UNIQUE key is what makes the
  -- set creation LAZY and idempotent: the first captured change in a scope
  -- creates the set, every later one finds it.
  --
  -- \`scope_id\` is TEXT and is not validated as a GUID, because the global
  -- scope's sys_id is the literal string 'global' (§33).
  --
  -- \`instance\` is part of the key because the bound connection can change
  -- underneath a session, and a set sys_id from one PDI means nothing on
  -- another — the same reason audit rows carry their own instance.
  CREATE TABLE IF NOT EXISTS capture_sets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session    TEXT NOT NULL,
    instance   TEXT NOT NULL,
    scope_id   TEXT NOT NULL,
    scope_name TEXT NOT NULL,
    set_sys_id TEXT NOT NULL,
    set_name   TEXT NOT NULL,
    parent_set TEXT,
    created    TEXT NOT NULL,
    UNIQUE (session, instance, scope_id)
  );

  CREATE INDEX IF NOT EXISTS idx_capture_sets_session ON capture_sets(session);
  `,

  // 7 — the mutation ledger (WI-2)
  //
  // Its own table, and that is the whole design. Compaction deletes from
  // `messages` and `chunks` and touches nothing else, so a ledger row cannot be
  // folded, summarised or dropped by it — the same structural property that
  // makes `tool_events` outlive compaction, rather than a rule someone has to
  // keep remembering.
  //
  // It exists because a compaction fired mid-turn (13,348 -> 3,062 tokens)
  // immediately before a closing summary, and that summary omitted an approved,
  // executed record creation entirely. A user-approved mutation got zero
  // end-of-turn reporting. The report is now rendered FROM this table rather
  // than from what the model can still remember.
  `
  CREATE TABLE IF NOT EXISTS mutation_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session       TEXT NOT NULL,
    turn_seq      INTEGER NOT NULL,   -- seq of the user message that opened the turn
    ts            TEXT NOT NULL,
    tool          TEXT NOT NULL,
    table_name    TEXT,
    sys_id        TEXT,
    display_id    TEXT,               -- the number or name a human would search for
    requested     TEXT,               -- JSON: the fields that were sent
    verification  TEXT,               -- JSON: the WI-1 verdict
    status        TEXT NOT NULL,      -- applied | partial | no-op | transformed | unverified | self-verified
    approval      TEXT,               -- approved | auto | rejected
    capture       TEXT,               -- JSON: the transport capture annotation
    instance      TEXT,
    actor         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_mutation_ledger_session ON mutation_ledger(session, turn_seq);
  `,

  // 8 — approval PROVENANCE (WI-4)
  //
  // Investigating 2026-08-24 stopped at a question the database could not
  // answer: an update executed with `approval = 'approved'` while the
  // auto-approve checkbox was off, and nothing anywhere recorded WHO resolved
  // it or WHEN. Approval state lived as an unresolved Promise in a process-local
  // Map and collapsed into a single terminal string at execution time — no
  // history, no transition timestamp, no actor. "A user clicked it" was the
  // likeliest explanation and remained unprovable.
  //
  // `approved_source` is the missing half: user_click | auto_approve | unknown.
  // `approved_at` is when the decision was made, which is NOT `ts` — that is
  // written after the tool has run, and on a slow write the two differ by
  // seconds.
  //
  // Existing rows are backfilled to 'unknown' and rendered as such. Every one of
  // them predates this column, so any other value would be a guess presented as
  // a record — which is the exact failure mode this project keeps closing.
  `
  ALTER TABLE mutation_ledger ADD COLUMN approved_source TEXT;
  ALTER TABLE mutation_ledger ADD COLUMN approved_at TEXT;
  ALTER TABLE tool_events ADD COLUMN approved_source TEXT;
  ALTER TABLE tool_events ADD COLUMN approved_at TEXT;

  UPDATE mutation_ledger SET approved_source = 'unknown' WHERE approval IS NOT NULL AND approved_source IS NULL;
  UPDATE tool_events     SET approved_source = 'unknown' WHERE approval IS NOT NULL AND approved_source IS NULL;
  `,

  // 9 — sys_id PROVENANCE (follow-up WI-1)
  //
  // WHY THIS IS AN INDEX AND NOT A SECOND SOURCE OF TRUTH.
  //
  // The obvious home for "which sys_ids does this session know about" was the
  // thing that already carries identifiers across a compaction. There isn't
  // one: `replaceSpanWithDigest` deletes from `messages` and `chunks` and
  // writes ONE row to `digests`, whose only payload is `text` — free-form
  // markdown authored by the summariser model. Its own prompt says "A mistyped
  // sys_id is worse than an omitted one — it will be used", and compaction.js
  // records a measured run where a digest dropped a flow sys_id entirely. A
  // hard block on writes cannot take its truth from the artefact it exists to
  // police.
  //
  // So every row here is written by the SAME CALL that writes the durable
  // record it is derived from — `recordToolEvent`, `appendMessage`,
  // `recordFact`. One producer per source, nothing to reconcile, nothing that
  // can drift out of step with the thing it indexes.
  //
  // It survives compaction for the same structural reason `tool_events` does:
  // compaction touches `messages` and `chunks` and nothing else.
  //
  // `row_count` is the cardinality of the RESULT SET the sys_id arrived in — a
  // read that returned five incidents registers five rows of row_count 5, and
  // "the model picked one of those and wrote to it" becomes a fact the harness
  // can check instead of a shape it has to infer from prose.
  //
  // `event_seq` defaults to -1 rather than NULL because SQLite treats NULLs as
  // distinct in a UNIQUE index, and a nullable column there would let the same
  // user-supplied sys_id insert without limit.
  `
  CREATE TABLE IF NOT EXISTS sysid_provenance (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session    TEXT NOT NULL,
    sys_id     TEXT NOT NULL,
    table_name TEXT,
    display_id TEXT,                       -- INC0010052, when the row carried one
    source     TEXT NOT NULL,              -- user_message | tool_result | ledger_fact
    event_seq  INTEGER NOT NULL DEFAULT -1,-- tool_events.seq of the read it came from
    row_count  INTEGER NOT NULL DEFAULT 1, -- records in that result set
    ts         TEXT NOT NULL,
    UNIQUE (session, sys_id, source, event_seq),
    FOREIGN KEY (session) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sysid_prov_lookup ON sysid_provenance(session, sys_id);
  CREATE INDEX IF NOT EXISTS idx_sysid_prov_display ON sysid_provenance(session, display_id);
  `,

  // 10 - impersonation mode (B3, D6)
  //
  // The four `imp.*` facts, held as STATE rather than history. Under M1 there
  // is no persistent ServiceNow session: "mode" is purely which target the next
  // wrapper execution stamps, so it has to survive everything that rewrites the
  // transcript. A table earns that structurally - compaction deletes from
  // `messages` and `chunks` and touches nothing else - which is the same
  // property that makes the mutation ledger and tool_events compaction-proof.
  // A rule someone has to remember would not be worth as much.
  //
  // `original_sys_id` is the REAL actor. Phase 0 measured that the instance
  // records only the impersonated user - no Begin/End events, an empty history
  // table, and a sys_audit.user that is a session GUID either way - so this
  // column is the only place the real initiator exists at all.
  //
  // One row per session: a session is impersonating exactly one target or none.
  `
  CREATE TABLE IF NOT EXISTS impersonation_mode (
    session          TEXT PRIMARY KEY,
    active           INTEGER NOT NULL DEFAULT 0,
    target_sys_id    TEXT,
    target_user_name TEXT,
    target_display   TEXT,
    original_sys_id  TEXT,
    original_user_name TEXT,
    task             TEXT,
    started_at       TEXT,
    updated_at       TEXT NOT NULL,
    instance         TEXT,
    FOREIGN KEY (session) REFERENCES sessions(id) ON DELETE CASCADE
  );
  `,
];

/**
 * Bring one database up to the current schema. Exported so the offline test
 * suite can build a scratch database through the SAME code path — copying
 * `sqlite_master` instead would drag in FTS5's internal shadow tables, which
 * cannot be created directly, and would test a replica rather than the real
 * migrations.
 */
export function migrate(db) {
  db.exec('PRAGMA foreign_keys = ON');
  const current = db.prepare('PRAGMA user_version').get().user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
      log.info('storage', `migration ${v + 1} applied`);
    } catch (err) {
      db.exec('ROLLBACK');
      // Loud: a half-migrated database is worse than one that refuses to open.
      throw new Error(`NowHelpAssist database migration ${v + 1} failed: ${err.message}`);
    }
  }
  return db;
}

/**
 * Carry an existing database across the NowForge -> NowHelpAssist rename.
 *
 * The file name is an ADDRESS, not a label: every session, tool event, digest
 * and audit row already lives at the old one. Renaming the product without
 * this would silently start a fresh database and leave a working history
 * orphaned next to it, which for the Audit page in particular would be the
 * exact failure it exists to prevent.
 *
 * The WAL is checkpointed into the main file before the rename, so moving one
 * file cannot strand committed data in a `-wal` nobody will look for again.
 * Runs once: the moment the new file exists this is a no-op.
 */
function adoptLegacyDatabase() {
  if (fs.existsSync(DB_FILE) || !fs.existsSync(LEGACY_DB_FILE)) return null;
  const old = new DatabaseSync(LEGACY_DB_FILE);
  try { old.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { old.close(); }
  fs.renameSync(LEGACY_DB_FILE, DB_FILE);
  for (const suffix of ['-wal', '-shm']) {
    // Empty after the checkpoint, and stale against the new name.
    try { fs.rmSync(LEGACY_DB_FILE + suffix, { force: true }); } catch { /* nothing to clean */ }
  }
  return LEGACY_DB_FILE;
}

/** Opens the database, applying any migrations this file has not yet seen. */
export function getDb() {
  if (handle) return handle;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const adopted = adoptLegacyDatabase();
  if (adopted) log.info('storage', `adopted ${path.basename(adopted)} as ${path.basename(DB_FILE)}`);
  const db = new DatabaseSync(DB_FILE);

  // WAL survives a hard kill mid-write, which is exactly the acceptance test
  // for A-2 ("kill and restart the server, resume the same session").
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  /*
   * WAL permits many readers but exactly ONE writer, and SQLite's default
   * behaviour when the write lock is held is to fail the statement immediately
   * with SQLITE_BUSY rather than wait for it.
   *
   * MEASURED, during the `node --watch` restart investigation: a second server
   * process overlapping the first for a few hundred milliseconds killed the
   * NEW one at boot with an uncaught `Error: database is locked` thrown out of
   * `seedLedger()` — before the listener was ever reached. The old process was
   * mid-write for microseconds; the new one did not wait even that long.
   *
   * The same window exists whenever two things write at once: a chat turn
   * appending messages while the recall indexer writes an embedding, or a
   * restart handing over. None of those are errors — they are contention, and
   * contention should be waited out, not raised.
   *
   * 5s is far longer than any write here takes (every statement in this file is
   * a single small row) and short enough that a genuine deadlock still surfaces
   * as an error rather than a hang.
   */
  db.exec('PRAGMA busy_timeout = 5000');

  handle = migrate(db);
  return handle;
}

/** Test hook: point the store at a scratch file, or back at the real one. */
export function _setDbForTests(db) {
  handle = db;
}

export const DB_PATH = DB_FILE;
