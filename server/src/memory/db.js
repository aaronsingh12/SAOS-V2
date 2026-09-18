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

  // 11 - the pending task-boundary question (B4, D3)
  //
  // When a user turn does not clearly continue the task impersonation was
  // started for, the turn STOPS and asks. The request that triggered it is held
  // here so the next turn can tell an answer ("yes, continue") from a fresh
  // instruction, and so consent EXTENDS the task descriptor rather than being
  // re-asked every turn afterwards.
  //
  // On the mode row rather than in the transcript for the same reason as the
  // mode itself: a compaction must not be able to remove the memory that a
  // question is outstanding.
  `
  ALTER TABLE impersonation_mode ADD COLUMN pending_request TEXT;
  ALTER TABLE impersonation_mode ADD COLUMN pending_asked_at TEXT;
  `,

  // 12 - impersonation audit provenance (B5)
  //
  // THE ONLY PLACE THE REAL ACTOR EXISTS. Phase 0 measured that this instance
  // keeps no impersonation audit of any kind: zero 'Impersonate Begin'/'End'
  // rows in syslog and sysevent (the events are not even registered in
  // sysevent_register), sys_user_impersonation absent, sys_user_impersonation_history
  // present but holding zero rows ever, and - with glide.audit.track_impersonation
  // set true and confirmed active - a sys_audit.user holding an IDENTICAL session
  // GUID whether impersonating or not. Every impersonated record carries the
  // TARGET's name and nothing else.
  //
  // So this table is not a convenience copy of something the platform already
  // knows. Delete it and the question "who actually did this" has no answer
  // anywhere, on any system.
  //
  // NO FOREIGN KEY TO sessions, deliberately - matching mutation_ledger. A row
  // here explains a change that is still sitting on the instance; deleting the
  // conversation must not erase the only account of who caused it.
  `
  CREATE TABLE IF NOT EXISTS impersonation_audit (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    session                  TEXT NOT NULL,
    turn_seq                 INTEGER NOT NULL DEFAULT -1,
    ts                       TEXT NOT NULL,
    kind                     TEXT NOT NULL,   -- mutation | mode_start | mode_switch | mode_end
    real_initiator_sys_id    TEXT NOT NULL,
    real_initiator_user_name TEXT,
    harness_session          TEXT,
    target_sys_id            TEXT,
    target_user_name         TEXT,
    table_name               TEXT,
    sys_id                   TEXT,
    display_id               TEXT,
    operation                TEXT,
    tool                     TEXT,
    change_summary           TEXT,
    verification_status      TEXT,
    task                     TEXT,
    instance                 TEXT,

    -- Did the write ACTUALLY execute under the impersonated identity, or did it
    -- run as the NowHelpAssist service account while mode happened to be on?
    --
    -- This column exists because the two cases have OPPOSITE audit meanings and
    -- are trivial to confuse. Only the first produces an attribution gap: the
    -- instance stamps the target's name and knows nothing else. In the second
    -- the instance already records the service account correctly and there is
    -- no gap at all. A row that asserted the first when the second happened
    -- would be a fabricated audit finding - worse than no row, because someone
    -- would act on it.
    executed_impersonated    INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_imp_audit_record  ON impersonation_audit(sys_id);
  CREATE INDEX IF NOT EXISTS idx_imp_audit_session ON impersonation_audit(session, turn_seq);
  CREATE INDEX IF NOT EXISTS idx_imp_audit_target  ON impersonation_audit(target_sys_id);
  `,

  // 13 - write-ahead provenance (B7)
  //
  // B5 recorded provenance AFTER the fact, which cannot survive the one case
  // that matters: a crash between the write landing on the instance and the row
  // being written. That leaves a real change on a real record with no account of
  // who caused it - the exact state this table exists to make impossible.
  //
  // So an impersonated write now records INTENT first, dispatches, then
  // confirms. The three terminal states are distinguishable on purpose:
  //
  //   intent    + no mutation   -> harmless orphan (crash before dispatch)
  //   intent    + mutation      -> UNCONFIRMED: a change may exist unrecorded,
  //                               and `unconfirmedIntents` is how it is found
  //   confirmed                 -> the write landed and was read back
  //   aborted                   -> never dispatched (pre-flight refused it),
  //                               and must never be mistaken for either
  //
  // `attributed_user_name` is what the INSTANCE says afterwards, read back as
  // admin. Storing it rather than assuming it is what lets a later reader see
  // that NowHelpAssist's claim and the instance's stamp actually agree.
  `
  ALTER TABLE impersonation_audit ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed';
  ALTER TABLE impersonation_audit ADD COLUMN intent_at TEXT;
  ALTER TABLE impersonation_audit ADD COLUMN confirmed_at TEXT;
  ALTER TABLE impersonation_audit ADD COLUMN abort_reason TEXT;
  ALTER TABLE impersonation_audit ADD COLUMN attributed_user_name TEXT;

  CREATE INDEX IF NOT EXISTS idx_imp_audit_status ON impersonation_audit(status);
  `,
  // 14 — SPLIT THE AUDIT TRAIL FROM CONVERSATION HISTORY.
  //
  // `tool_events` says in its own schema comment that it "outlives compaction …
  // but must never be rewritten", and `sysid_provenance` is the record of where
  // a sys_id came from. Both are audit. Both nonetheless carried
  // `ON DELETE CASCADE` on `sessions`, with `PRAGMA foreign_keys = ON` — so
  // deleting a chat silently destroyed the evidence of what that chat DID to a
  // ServiceNow instance.
  //
  // Nothing had exercised it: sessions were only ever deleted one at a time and
  // rarely. Adding a "delete all chats" button would have turned a latent bug
  // into a one-click audit wipe, which is why this ships with it rather than
  // after it.
  //
  // SQLite cannot drop a constraint, so each table is rebuilt without the
  // foreign key and its rows copied across. `session` stays as a plain column:
  // an audit row keyed to a conversation that no longer exists is exactly what
  // is wanted — the record outlives the chat that produced it.
  //
  // `mutation_ledger` was already safe (it carries `session` as a bare column
  // with no FK) and is deliberately untouched here.
  //
  // THE COLUMN LIST BELOW IS THE CURRENT ONE, NOT MIGRATION 1'S. A rebuild-and-
  // copy has to enumerate every column the table has by now, including the ones
  // migrations 5 and 8 added by ALTER (`result`, `actor`, `instance`,
  // `approved_source`, `approved_at`). The first draft of this migration copied
  // migration 1's nine columns and would have silently dropped five columns of
  // audit data — caught only because the scratch database in the test suite is
  // built through the real migrations rather than from a hand-written replica.
  `
  PRAGMA foreign_keys = OFF;

  CREATE TABLE tool_events_audit (
    session         TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    kind            TEXT NOT NULL,
    name            TEXT,
    payload         TEXT,
    result          TEXT,
    result_status   TEXT,
    mutating        INTEGER NOT NULL DEFAULT 0,
    approval        TEXT,
    approved_source TEXT,
    approved_at     TEXT,
    instance        TEXT,
    actor           TEXT,
    ts              TEXT NOT NULL,
    PRIMARY KEY (session, seq)
  );
  INSERT INTO tool_events_audit (session, seq, kind, name, payload, result, result_status, mutating, approval,
                                 approved_source, approved_at, instance, actor, ts)
    SELECT session, seq, kind, name, payload, result, result_status, mutating, approval,
           approved_source, approved_at, instance, actor, ts FROM tool_events;
  DROP TABLE tool_events;
  ALTER TABLE tool_events_audit RENAME TO tool_events;
  CREATE INDEX IF NOT EXISTS idx_tool_events_name ON tool_events(session, name);
  CREATE INDEX IF NOT EXISTS idx_tool_events_ts   ON tool_events(ts DESC);

  CREATE TABLE sysid_provenance_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session    TEXT NOT NULL,
    sys_id     TEXT NOT NULL,
    table_name TEXT,
    display_id TEXT,
    source     TEXT NOT NULL,
    event_seq  INTEGER NOT NULL DEFAULT -1,
    row_count  INTEGER NOT NULL DEFAULT 1,
    ts         TEXT NOT NULL,
    UNIQUE (session, sys_id, source, event_seq)
  );
  INSERT INTO sysid_provenance_audit (id, session, sys_id, table_name, display_id, source, event_seq, row_count, ts)
    SELECT id, session, sys_id, table_name, display_id, source, event_seq, row_count, ts FROM sysid_provenance;
  DROP TABLE sysid_provenance;
  ALTER TABLE sysid_provenance_audit RENAME TO sysid_provenance;
  CREATE INDEX IF NOT EXISTS idx_sysid_prov_lookup  ON sysid_provenance(session, sys_id);
  CREATE INDEX IF NOT EXISTS idx_sysid_prov_display ON sysid_provenance(session, display_id);

  PRAGMA foreign_keys = ON;
  `,

  // 15 — MEETING INTELLIGENCE, PHASE 1: CAPTURE.
  //
  // The capture agent is a separate OS-level process. It hears the meeting,
  // splits it into utterances on silence, writes each one to disk, and posts
  // the METADATA here. Audio bytes never travel over HTTP — both halves are on
  // the same machine, so a path is cheaper, debuggable (you can play any single
  // utterance back) and makes retention a directory removal rather than a
  // row-by-row sweep.
  //
  // `idx` is assigned by the AGENT at capture time, not on arrival. A short
  // utterance can finish transcribing before a long one that started earlier,
  // so arrival order is not timeline order and never will be. UNIQUE(meeting,
  // idx) is therefore both the ordering key and the idempotency key: the agent
  // may re-post an utterance after a dropped connection and get the same row.
  //
  // `text` / `speaker` are nullable and unused in this phase. They are declared
  // now so phase 2 fills a column rather than renaming a table — the migration
  // that adds transcription should not have to rewrite this one.
  `
  CREATE TABLE IF NOT EXISTS meetings (
    id            TEXT PRIMARY KEY,
    title         TEXT,
    source_app    TEXT,
    source_pid    INTEGER,
    -- 'auto' (the detector fired), 'manual' (the user pressed record) or
    -- 'simulated' (scripts/fake-meeting.mjs). Worth storing: a meeting nobody
    -- chose to record is exactly the one whose consent story has to be legible.
    detected_by   TEXT NOT NULL DEFAULT 'auto',
    -- recording -> captured -> confirmed | discarded
    status        TEXT NOT NULL DEFAULT 'recording',
    started       TEXT NOT NULL,
    ended         TEXT,
    duration_ms   INTEGER,
    -- Absolute path to this meeting's utterance folder. NULL once the audio has
    -- been removed AND the removal verified — so a non-null value here is a
    -- claim that bytes are still on disk, and the Meetings page bases its
    -- "awaiting confirmation" total on it.
    audio_dir     TEXT,
    audio_bytes   INTEGER NOT NULL DEFAULT 0,
    audio_deleted TEXT,
    -- The moment the user confirmed the transcript. This freezes the meeting:
    -- audio goes, and from here the transcript is the only record, which is
    -- what makes an evidence citation point at something permanent.
    confirmed     TEXT,
    agent_version TEXT,
    instance      TEXT,
    notes         TEXT
  );

  CREATE TABLE IF NOT EXISTS meeting_segments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,
    -- 'mic' (this user) or 'system' (everyone else, via WASAPI loopback).
    -- Recording them separately is not tidiness: it means the local speaker is
    -- known with zero inference, so diarization only ever has to split 'system'.
    track      TEXT NOT NULL,
    start_ms   INTEGER NOT NULL,
    end_ms     INTEGER NOT NULL,
    audio_path TEXT,
    bytes      INTEGER NOT NULL DEFAULT 0,
    sha256     TEXT,
    rms        REAL,
    text       TEXT,
    text_model TEXT,
    refined    INTEGER NOT NULL DEFAULT 0,
    speaker    TEXT,
    UNIQUE (meeting, idx)
  );

  -- The page reads the timeline in time order, which is NOT insertion order.
  CREATE INDEX IF NOT EXISTS idx_meeting_seg_time ON meeting_segments(meeting, start_ms);
  CREATE INDEX IF NOT EXISTS idx_meetings_started ON meetings(started DESC);
  `,

  // 16 — MEETING INTELLIGENCE, PHASE 2: LIVE TRANSCRIPTION STATE.
  //
  // Migration 15 already carries `text`, `text_model` and `refined`. What it
  // has no way to express is the DIFFERENCE BETWEEN THREE THINGS THAT ALL LOOK
  // LIKE AN EMPTY TRANSCRIPT:
  //
  //   pending  — not transcribed yet. The queue still owes us this one.
  //   empty    — transcribed, and the model genuinely found no words in it.
  //   failed   — the attempt errored. THIS IS NOT SILENCE, and a page that
  //              rendered it as an empty line would be quietly lying about a
  //              hole in the transcript that a requirement may have been in.
  //
  // `stt_state` makes those three distinguishable; `stt_error` says why a
  // failure failed; `stt_ms` is the wall time, which is what the backlog meter
  // and the auto-downgrade are computed from, and what makes a stall visible
  // after the fact rather than only while it is happening.
  `
  ALTER TABLE meeting_segments ADD COLUMN stt_state TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE meeting_segments ADD COLUMN stt_error TEXT;
  ALTER TABLE meeting_segments ADD COLUMN stt_ms INTEGER;
  ALTER TABLE meeting_segments ADD COLUMN stt_attempts INTEGER NOT NULL DEFAULT 0;

  -- The worker's "what is still owed" query, run on every completion.
  CREATE INDEX IF NOT EXISTS idx_meeting_seg_pending ON meeting_segments(stt_state, meeting);
  `,

  // 17 — MEETING INTELLIGENCE, PHASE 4: WHAT THE MEETING MEANT.
  //
  // A finding is something the model claims was asked for, decided, questioned
  // or assumed. Every one of them MUST cite the transcript, and every citation
  // is checked against the stored text before the finding is shown.
  //
  // That check is the whole safety mechanism of this module, and it exists
  // because of a property of the only model available here: gpt-oss:120b-cloud
  // provably ignores `seed`, so generation is non-reproducible, and the failure
  // mode of a weak model on this task is not a crash — it is a fluent,
  // confident, entirely invented requirement that reads exactly like the real
  // ones. Nothing about the TEXT distinguishes them.
  //
  // A quote does distinguish them. A fabricated requirement cannot cite words
  // that exist in a transcript it never read. So evidence is stored separately,
  // per citation, with its verification verdict and the reason it failed — and
  // an unverified finding is never allowed to become an approved requirement.
  //
  // `edited_text` is kept beside `text` rather than overwriting it: the human's
  // correction and the model's original claim are different facts, and an
  // audit of "what did the AI actually say" needs both.
  `
  CREATE TABLE IF NOT EXISTS meeting_findings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting     TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    -- requirement | decision | question | assumption | criterion
    kind        TEXT NOT NULL,
    text        TEXT NOT NULL,
    edited_text TEXT,
    -- proposed | confirmed | rejected
    status      TEXT NOT NULL DEFAULT 'proposed',
    -- 'model' or 'human'. A human-added finding needs no evidence: the person
    -- in the room is the evidence, and pretending otherwise would force them
    -- to fabricate a citation.
    origin      TEXT NOT NULL DEFAULT 'model',
    confidence  TEXT,
    -- Which rolling pass produced it, and a stable hash of the normalised text
    -- so the next pass over an overlapping window does not add it again.
    pass        INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT,
    created     TEXT NOT NULL,
    updated     TEXT,
    UNIQUE (meeting, fingerprint)
  );

  CREATE TABLE IF NOT EXISTS meeting_evidence (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    finding  INTEGER NOT NULL REFERENCES meeting_findings(id) ON DELETE CASCADE,
    -- The utterance the model cited, by the index it saw.
    seg_idx  INTEGER NOT NULL,
    quote    TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    -- Populated only on failure, and shown to the user verbatim. "the quote is
    -- not in that utterance" is a far more useful thing to read than a finding
    -- that quietly disappeared.
    reason   TEXT,
    start_ms INTEGER,
    end_ms   INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_meeting_findings ON meeting_findings(meeting, kind, status);
  CREATE INDEX IF NOT EXISTS idx_meeting_evidence ON meeting_evidence(finding);

  -- How far the rolling pass has read. Understanding runs DURING the meeting,
  -- so this is the watermark that makes each pass incremental rather than a
  -- re-read of the whole transcript every ninety seconds.
  ALTER TABLE meetings ADD COLUMN understood_through_ms INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE meetings ADD COLUMN understanding_state TEXT;
  ALTER TABLE meetings ADD COLUMN understanding_error TEXT;
  ALTER TABLE meetings ADD COLUMN passes INTEGER NOT NULL DEFAULT 0;
  `,

  // 18 — MEETING INTELLIGENCE, PHASE 5: THE BUILD PLAN.
  //
  // A plan is the bridge between the approved requirement set and the
  // ServiceNow machinery this application already has. It is stored rather than
  // computed on demand for one reason: the user APPROVES it, and an approval
  // has to refer to something fixed. Re-planning between the approval and the
  // build — which a non-reproducible model guarantees would produce a different
  // plan — would mean building something nobody agreed to.
  //
  // `steps` is the whole plan as JSON. It is deliberately not normalised into
  // one row per step: the plan is approved, executed and audited as a single
  // unit, and a schema per artifact type would have to change every time this
  // application learns to build something new.
  `
  CREATE TABLE IF NOT EXISTS meeting_plans (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    -- draft -> approved -> building -> built | failed
    status    TEXT NOT NULL DEFAULT 'draft',
    steps     TEXT NOT NULL,
    -- The requirement set the plan was made FROM, copied in at plan time.
    -- Without it, "what did we agree to build" becomes unanswerable the moment
    -- someone edits a finding afterwards.
    basis     TEXT,
    -- The run in build_runs, so the Audit page and the update-set sweep pick
    -- this up with no new code.
    build_run TEXT,
    result    TEXT,
    instance  TEXT,
    created   TEXT NOT NULL,
    approved  TEXT,
    finished  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_meeting_plans ON meeting_plans(meeting, created DESC);
  `,

  // 19 — WHERE A CHAT CAME FROM.
  //
  // A session started from a meeting is not the same thing as one somebody
  // typed, and the difference matters at the moment it matters most: you are
  // about to approve a write, and "what is this agent working from" should not
  // require remembering. So the origin is recorded on the session and the chat
  // is visibly marked for its whole life.
  //
  // This replaces the build-plan stage that used to live in the Meetings page.
  // The agent already has the approval gate, the tool cards, the iteration
  // budget and — unlike a plan screen — the ability to be argued with. Building
  // a second, weaker orchestrator beside it was the wrong shape; handing the
  // requirements over is the right one.
  //
  // `source_label` is DENORMALISED on purpose. It is the meeting's title as it
  // read at handoff, and it must survive the meeting being discarded — a chat
  // that says "from a meeting that no longer exists" is still more honest than
  // one that silently loses its provenance.
  `
  ALTER TABLE sessions ADD COLUMN source TEXT;
  ALTER TABLE sessions ADD COLUMN source_ref TEXT;
  ALTER TABLE sessions ADD COLUMN source_label TEXT;

  CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source, source_ref);
  `,

  // 20 — KNOWLEDGE: the ServiceNow documentation corpus (K1) and the SNADA
  // observation store (K5).
  //
  // DELIBERATELY SEPARATE from `chunks` / `embeddings`, which recall (A-5) owns.
  // Those two hold CONVERSATION — what was said in this project — and are keyed
  // on (kind, session, ref) with no room for the provenance a document needs.
  // Folding external documentation into the same table would put "what
  // ServiceNow's docs claim" and "what this project measured" into one result
  // set with no way to tell them apart, and the entire conflict ladder in
  // knowledge/precedence.js depends on being able to tell them apart.
  //
  // The mechanics are the same, on purpose: float32 blobs, brute-force cosine,
  // FTS5 for the no-embedding fallback. knowledge/store.js reuses recall's own
  // embed/cosine/chunk helpers rather than reimplementing them.
  `
  CREATE TABLE IF NOT EXISTS kb_documents (
    id            TEXT PRIMARY KEY,   -- caller-supplied stable id (see knowledge/schema.js)
    source        TEXT NOT NULL,      -- who published it
    product       TEXT NOT NULL,      -- which ServiceNow product/family
    topic         TEXT NOT NULL,      -- flow-designer, acl, sla, glide-api, ...
    version       TEXT NOT NULL,      -- release name AS THE SOURCE WROTE IT, never normalised
    -- Rank within the operator-supplied release order (settings.rag.releaseOrder).
    -- NULL means "this release is not in that list", which is a real state:
    -- retrieval must then fall back to updated_at and SAY it did.
    version_rank  INTEGER,
    document_type TEXT NOT NULL,      -- documentation | api-reference | release-note | ...
    url           TEXT NOT NULL,      -- the source's own URL. Never synthesised.
    updated_at    TEXT NOT NULL,      -- when the SOURCE last changed it
    title         TEXT,
    ingested_at   TEXT NOT NULL,      -- when WE read it. Different question.
    -- Lets re-ingestion skip an unchanged document instead of re-embedding it.
    content_hash  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kb_chunks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    document TEXT NOT NULL,
    seq      INTEGER NOT NULL,
    text     TEXT NOT NULL,
    UNIQUE (document, seq),
    FOREIGN KEY (document) REFERENCES kb_documents(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS kb_embeddings (
    chunk INTEGER PRIMARY KEY,
    model TEXT NOT NULL,
    dim   INTEGER NOT NULL,
    vec   BLOB NOT NULL,
    FOREIGN KEY (chunk) REFERENCES kb_chunks(id) ON DELETE CASCADE
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
    text,
    content='kb_chunks',
    content_rowid='id',
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS kb_chunks_ai AFTER INSERT ON kb_chunks BEGIN
    INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS kb_chunks_ad AFTER DELETE ON kb_chunks BEGIN
    INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS kb_chunks_au AFTER UPDATE ON kb_chunks BEGIN
    INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO kb_chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;

  CREATE INDEX IF NOT EXISTS idx_kb_docs_topic ON kb_documents(topic);
  CREATE INDEX IF NOT EXISTS idx_kb_docs_version ON kb_documents(version_rank);
  CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(document);

  -- K5 — what SNADA has VERIFIED for itself, which is a different kind of claim
  -- from anything in kb_documents and must never be stored beside it. Every row
  -- carries the evidence that made it true; knowledge/observations.js refuses a
  -- write without one, because an unverified observation is just an LLM output
  -- with a database row.
  CREATE TABLE IF NOT EXISTS snada_observations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    category      TEXT NOT NULL,     -- see OBSERVATION_CATEGORIES
    subject       TEXT NOT NULL,     -- the tool, table, SDK feature or API it is about
    observation   TEXT NOT NULL,     -- what was observed, in one sentence
    evidence_kind TEXT NOT NULL,     -- see EVIDENCE_KINDS
    evidence      TEXT NOT NULL,     -- the artifact itself: error text, read-back, compiler output
    -- '*' for a property of the SDK or the platform; an instance URL for
    -- anything measured on one PDI. Same rule as the fact ledger: a
    -- single-instance measurement must never leak to another instance.
    instance      TEXT NOT NULL,
    platform_version TEXT,           -- release, when it was actually determined
    tool_event    INTEGER,           -- tool_events.id, when the evidence came from a tool run
    observed_at   TEXT NOT NULL,
    confirmed_at  TEXT NOT NULL,
    confirmations INTEGER NOT NULL DEFAULT 1,
    UNIQUE (category, subject, instance, observation)
  );

  CREATE INDEX IF NOT EXISTS idx_obs_subject ON snada_observations(subject);
  CREATE INDEX IF NOT EXISTS idx_obs_category ON snada_observations(category);
  `,

  // 21 — PHASE 1: the durable task/step substrate.
  //
  // Behaviourally inert on arrival. Every agent turn already IS a unit of work;
  // it has simply never had a name that outlived the process, so "what was this
  // agent asked to do, and how did it end" could only be reconstructed by
  // reading a transcript. These two tables give that unit an identity and a
  // recorded lifecycle, and nothing else changes: one turn produces one task
  // with one step, whatever happens inside it.
  //
  // NO FOREIGN KEY TO `sessions`, and that is the same decision migration 19
  // made for `tool_events` and `sysid_provenance`. A task is a durable
  // projection of what the agent did, not part of the transcript — so deleting
  // a chat must not take it, exactly as deleting a chat does not take the
  // mutation ledger. `session_id` stays a plain column: a task pointing at a
  // conversation that no longer exists is the wanted outcome, not a dangling
  // reference to repair.
  //
  // The step->task FK IS a real parent/child relationship and does cascade:
  // a step without its task is meaningless, where a task without its chat is not.
  //
  // Every state column is written ONLY through the transition functions in
  // memory/tasks.js. No model-facing tool can reach this table — these are
  // control-plane fields, and test/agent-tasks.test.js asserts that structurally.
  `
  CREATE TABLE IF NOT EXISTS agent_tasks (
    id             TEXT PRIMARY KEY,       -- crypto.randomUUID(), like sessions
    session_id     TEXT NOT NULL,          -- deliberately NOT a foreign key (see above)
    state          TEXT NOT NULL,          -- see TASK_STATES in memory/tasks.js
    goal           TEXT,                   -- the user's own words, verbatim
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    started_at     TEXT,
    completed_at   TEXT,
    cancelled_at   TEXT,
    failure_reason TEXT,
    metadata_json  TEXT,
    instance       TEXT,                   -- which PDI this ran against, as every audit row records
    actor          TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_task_steps (
    id             TEXT PRIMARY KEY,
    task_id        TEXT NOT NULL,
    -- Deterministic within a task, and enforced by the UNIQUE below rather than
    -- by whatever order rows happen to come back in. Allocated from MAX+1 inside
    -- the same statement that inserts, so two concurrent turns on one task
    -- cannot both claim the same number.
    sequence       INTEGER NOT NULL,
    state          TEXT NOT NULL,          -- see STEP_STATES in memory/tasks.js
    kind           TEXT NOT NULL,          -- 'turn' is the only kind this phase creates
    description    TEXT,
    capability     TEXT,                   -- reserved: which capability a future planner assigned
    started_at     TEXT,
    completed_at   TEXT,
    failure_reason TEXT,
    metadata_json  TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    UNIQUE (task_id, sequence),
    FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
  );

  -- The access paths this phase actually has: "the tasks for this chat",
  -- "the steps of this task in order", and "what is still running" — which is
  -- the crash-visibility query, since a process that dies mid-turn leaves a
  -- running row behind on purpose (no automatic recovery in this phase).
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_session ON agent_tasks(session_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_tasks_state ON agent_tasks(state);
  CREATE INDEX IF NOT EXISTS idx_agent_task_steps_task ON agent_task_steps(task_id, sequence);
  CREATE INDEX IF NOT EXISTS idx_agent_task_steps_state ON agent_task_steps(state);
  `,

  // 22 — PHASE 4: the durable PLAN, carried on the Phase 1 tables.
  //
  // NO NEW TABLES, deliberately. A plan is a task with steps, which is exactly
  // what migration 21 already models — introducing `agent_plans` beside
  // `agent_tasks` would create a second lifecycle that could disagree with the
  // first about what a run is, and nothing would say which was right.
  //
  // `plan_state` is a SECOND state column and that needs its reason. Phase 1's
  // `state` is the TURN projection: a task exists for every agent turn and is
  // running/completed/cancelled with the turn that produced it. A plan has its
  // own lifecycle that the turn's does not express — being reviewed, being
  // approved, being verified — and merging the two vocabularies would either
  // break the Phase 1 projection or overload words that already mean something.
  // So `plan_state` is NULL for every task that has no plan, and the two are
  // read together rather than reconciled.
  //
  // THE FINGERPRINT COLUMNS ARE THE SECURITY PART. `plan_fingerprint` is what
  // the plan currently hashes to; `approved_fingerprint` is what a human
  // actually reviewed. The executor compares them before every step, so a plan
  // that changed after approval cannot inherit it.
  `
  ALTER TABLE agent_tasks ADD COLUMN plan_state TEXT;
  ALTER TABLE agent_tasks ADD COLUMN plan_fingerprint TEXT;
  ALTER TABLE agent_tasks ADD COLUMN approved_fingerprint TEXT;
  ALTER TABLE agent_tasks ADD COLUMN approved_at TEXT;
  ALTER TABLE agent_tasks ADD COLUMN approved_source TEXT;
  -- The review representation, stored so a reconnecting UI can rebuild the
  -- whole plan without the process that made it. SSE is transport; this is
  -- the source of truth.
  ALTER TABLE agent_tasks ADD COLUMN plan_json TEXT;

  -- The executable half of a step. plan_step_id is the plan-local name
  -- ("step_1") that dependencies are written against; sequence remains the
  -- table's own deterministic ordering from Phase 1.
  ALTER TABLE agent_task_steps ADD COLUMN plan_step_id TEXT;
  ALTER TABLE agent_task_steps ADD COLUMN operation TEXT;
  ALTER TABLE agent_task_steps ADD COLUMN mechanism TEXT;
  ALTER TABLE agent_task_steps ADD COLUMN scope TEXT;
  ALTER TABLE agent_task_steps ADD COLUMN tool TEXT;
  ALTER TABLE agent_task_steps ADD COLUMN mutating INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE agent_task_steps ADD COLUMN depends_on TEXT;        -- JSON array of plan_step_id
  ALTER TABLE agent_task_steps ADD COLUMN inputs_json TEXT;
  ALTER TABLE agent_task_steps ADD COLUMN effects_json TEXT;      -- promised effects
  ALTER TABLE agent_task_steps ADD COLUMN verification_json TEXT; -- strategy, then verdict
  ALTER TABLE agent_task_steps ADD COLUMN approval_json TEXT;
  ALTER TABLE agent_task_steps ADD COLUMN result_json TEXT;

  CREATE INDEX IF NOT EXISTS idx_agent_tasks_plan_state ON agent_tasks(plan_state);
  CREATE INDEX IF NOT EXISTS idx_agent_task_steps_planid ON agent_task_steps(task_id, plan_step_id);
  `,

  // 23 — PHASE 8: EXACT task correlation for the two audit records.
  //
  // THE DEFECT THIS CLOSES. Evidence correlated `tool_events` and
  // `mutation_ledger` by session plus the task's time window, because neither
  // table carried a task id. Two plans in one session overlap in time, so each
  // one's evidence claimed BOTH plans' mutations — and the `changes` section
  // presented them as fact, sourced `mutation_ledger`, without the
  // `exact: false` caveat the audit section at least carried. A run could
  // therefore report a record it never touched as one of its own changes.
  //
  // TWO NULLABLE COLUMNS, NOTHING ELSE. Not a new table, not a redesigned
  // ledger, not a second audit system. Rows written before this migration, and
  // rows written by the ordinary turn loop which has no plan, keep NULL and
  // keep the window fallback — so nothing existing changes meaning and no row
  // has to be back-filled with a guess.
  //
  // The rule the read model then applies: a row that NAMES a task belongs to
  // that task and to no other. That is what makes cross-claiming impossible
  // rather than unlikely.
  //
  // A FUNCTION, not a string, because SQLite has no `ADD COLUMN IF NOT EXISTS`
  // and both tables predate this migration — so it cannot be made replay-safe
  // in SQL the way every earlier migration is. The column check is the whole
  // reason: everything else here is ordinary idempotent DDL.
  (db) => {
    const has = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has('mutation_ledger', 'task_id')) db.exec('ALTER TABLE mutation_ledger ADD COLUMN task_id TEXT');
    if (!has('tool_events', 'task_id')) db.exec('ALTER TABLE tool_events ADD COLUMN task_id TEXT');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mutation_ledger_task ON mutation_ledger(task_id);
      CREATE INDEX IF NOT EXISTS idx_tool_events_task     ON tool_events(task_id);
    `);
  },

  // 24 — HEALTH ASSIST: estate health runs and their findings.
  //
  // Ported from the SAOS service, which kept these in PostgreSQL behind its own
  // ORM. They live here instead because a second database would mean a second
  // migration story, a second backup story and a second answer to "what did
  // this tool see" — and the whole point of folding SAOS in was to stop having
  // two of everything.
  //
  // TWO TABLES, not one. The manifest is per-run and is read whole; findings
  // are per-row and are filtered, sorted and paged. Keeping the findings inside
  // the manifest JSON would mean loading every finding to render a count.
  //
  // `instance_key` is on the RUN, and every read filters by it. A sys_id is
  // instance-local, so a finding from one PDI rendered under another names
  // records that do not exist there — the same reason `scopeIds` are cached per
  // instance rather than globally. Switching instances hides old runs; it never
  // reinterprets them.
  //
  // NO foreign key to `sessions`. A health run is a record of what was read off
  // the instance, in the same family as `tool_events` and `mutation_ledger`,
  // and migration 14 established that deleting a conversation must not delete
  // the record of what was done. Nothing here is written by a chat turn, so
  // there is no cascade to remove — the absence is the invariant.
  `
  CREATE TABLE IF NOT EXISTS health_runs (
    id             TEXT PRIMARY KEY,
    instance_key   TEXT NOT NULL,
    instance_url   TEXT,
    status         TEXT NOT NULL,          -- running | completed | partial | failed
    started_at     TEXT NOT NULL,
    completed_at   TEXT,
    cutoff         TEXT,
    manifest_json  TEXT,                   -- coverage, skipped rules, metrics, llm
    error          TEXT
  );

  CREATE TABLE IF NOT EXISTS health_findings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id          TEXT NOT NULL REFERENCES health_runs(id) ON DELETE CASCADE,
    fingerprint     TEXT NOT NULL,
    rule_id         TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    domain          TEXT NOT NULL,
    source_table    TEXT NOT NULL,
    severity        TEXT NOT NULL,
    priority        TEXT NOT NULL,
    priority_score  REAL NOT NULL,
    confidence      REAL NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    recommendation  TEXT,
    ai_summary      TEXT,
    target_ids      TEXT,                  -- JSON array
    evidence_json   TEXT,                  -- JSON array of evidence rows
    impact_json     TEXT                   -- reachability, with its interpretation
  );

  CREATE INDEX IF NOT EXISTS idx_health_runs_instance ON health_runs(instance_key, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_health_findings_run  ON health_findings(run_id, priority_score DESC);
  CREATE INDEX IF NOT EXISTS idx_health_findings_rule ON health_findings(run_id, rule_id);
  `,

  // 25 — HEALTH ASSIST REMEDIATION: the proposal, and everything that happened to it.
  //
  // ONE ROW PER REMEDIATION ATTEMPT, carrying its whole history rather than its
  // current state. The six questions this table has to answer are:
  //
  //   what did the check find?        finding_fingerprint -> health_findings
  //   what did the AI recommend?      draft_json          (never overwritten)
  //   what did the user change?       edited_json         (null until they edit)
  //   what exactly did they approve?  approved_fingerprint + approved_plan_json
  //   what actually ran?              task_id -> agent_tasks, execution_json
  //   did it really work?             validation_json
  //
  // `draft_json` IS NEVER UPDATED. A user edit writes `edited_json` beside it,
  // so "what did the AI originally propose" stays answerable after the fact —
  // which is the whole point of recording a proposal separately from a plan.
  //
  // `task_id` is the join to the ordinary plan machinery. Execution does not
  // happen here: the approved proposal becomes a plan on `agent_tasks`, passes
  // through the same state machine, gate and executor as every other write, and
  // this row keeps the pointer. No second executor, no second audit trail.
  //
  // NO foreign key to health_findings. A proposal is a record of what a person
  // authorised against the instance, and deleting a health run must not delete
  // the evidence that somebody approved a change — the same reasoning that took
  // tool_events out of the sessions cascade in migration 14.
  `
  CREATE TABLE IF NOT EXISTS health_proposals (
    id                   TEXT PRIMARY KEY,
    run_id               TEXT NOT NULL,
    finding_fingerprint  TEXT NOT NULL,
    rule_id              TEXT NOT NULL,
    instance_key         TEXT NOT NULL,

    -- draft | edited | approved | executing | applied | partial | failed | rejected
    status               TEXT NOT NULL,

    draft_json           TEXT NOT NULL,   -- the AI's original proposal, never rewritten
    edited_json          TEXT,            -- the user's version, when they changed something
    approved_plan_json   TEXT,            -- exactly what was authorised

    proposal_fingerprint TEXT,            -- hash of the executable changes, as approved
    plan_fingerprint     TEXT,            -- the plan layer's own hash of the same thing
    task_id              TEXT,            -- -> agent_tasks: where it actually ran

    created_at           TEXT NOT NULL,
    edited_at            TEXT,
    decided_at           TEXT,
    decision             TEXT,            -- approved | rejected
    decided_source       TEXT,            -- user_click, always: nothing else may decide
    reject_reason        TEXT,

    execution_json       TEXT,            -- per-record: before, after, verdict
    validation_json      TEXT,            -- did the finding actually clear?
    error                TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_health_proposals_finding
    ON health_proposals(run_id, finding_fingerprint, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_health_proposals_instance
    ON health_proposals(instance_key, created_at DESC);
  `,

  // 26 — FINDING LIFECYCLE: acknowledged, muted, accepted.
  //
  // THE PROBLEM THIS SOLVES. Without it, every run re-reports every finding
  // for ever. A team looks at 900 findings, decides 400 of them are known and
  // accepted, and has no way to say so — so the next run shows 900 again, and
  // within about three runs nobody opens the page. A health checker that cannot
  // be told "we know, and we have accepted it" is a health checker that gets
  // ignored, which is a worse outcome than a few false positives.
  //
  // KEYED ON THE FINGERPRINT, NOT THE RUN. That is the whole design. A
  // fingerprint is sha256 over rule + table + the sorted sys_ids, so it is
  // stable for the same problem on the same records across runs, and DIFFERENT
  // the moment the affected set changes. Muting "these four CIs have no owner"
  // therefore carries forward, and cannot silently suppress a fifth CI that
  // goes ownerless next week — that is a different fingerprint and comes back
  // as new.
  //
  // A STATE IS NEVER A DELETION. Muted findings are still produced, still
  // stored and still counted; the state changes how they are PRESENTED and
  // nothing else. Every state carries a reason and a timestamp, because
  // "somebody accepted this risk" is only useful if you can find out who and
  // why — and `expires_at` exists so a snooze is a decision with an end rather
  // than a permanent blind spot.
  //
  // No foreign key to health_findings: the state outlives the run that first
  // produced it, which is the entire point.
  `
  CREATE TABLE IF NOT EXISTS health_finding_state (
    instance_key   TEXT NOT NULL,
    fingerprint    TEXT NOT NULL,
    rule_id        TEXT NOT NULL,
    state          TEXT NOT NULL,      -- open | acknowledged | muted | accepted
    reason         TEXT,
    expires_at     TEXT,               -- a snooze ends; a permanent state does not
    decided_at     TEXT NOT NULL,
    decided_source TEXT NOT NULL,      -- user_click, always
    first_seen     TEXT,
    last_seen      TEXT,
    PRIMARY KEY (instance_key, fingerprint)
  );

  CREATE INDEX IF NOT EXISTS idx_health_finding_state_rule
    ON health_finding_state(instance_key, rule_id);
  `,

  // 27 — CMDB QUALITY SCORING on each finding.
  //
  // The SAOS catalogue gives every rule a BASE band, and the finding's context
  // modifiers move it to an EFFECTIVE band. `severity` keeps meaning what the
  // page filters and counts by — the effective band — and this column carries
  // what the two-layer score needs beside it: the base band, the dimension,
  // whether it is a trust-gate rule, which modifiers applied or could not be
  // evaluated, and whether the rule's False Positive Guard was checked.
  //
  // A COLUMN, not a table: it is one value per finding, read with the finding,
  // and pruned with it. NULL for legacy rules and for runs recorded before it.
  //
  // Guarded like migration 23, because a bare ALTER is not replay-safe — the
  // replay suite rewinds user_version and runs it again.
  (db) => {
    const has = db.prepare('PRAGMA table_info(health_findings)').all().some((c) => c.name === 'scoring_json');
    if (!has) db.exec('ALTER TABLE health_findings ADD COLUMN scoring_json TEXT');
  },

  // 28 — MODULE SCANS AND INCREMENTAL CHANGE CHECKS.
  //
  // A health scan can now be limited to CMDB, ITOM, ITSM or Platform, and each
  // module keeps its own latest result. `health_runs.modules_json` says which
  // modules a run produced results for: NULL for every run recorded before this
  // (they were full scans), `[]` for a run that only verified nothing changed.
  //
  // `health_table_scan_state` is the per-table configuration and the last read
  // and change check of each allow-listed table, per instance: whether
  // incremental checking is on for it, when it was last read completely, and
  // what the last check found. It is NOT what a module's reuse is compared
  // against — that is the stamp set stored in the manifest of the run that
  // produced the module's result (see health/incremental.js for why).
  //
  // `health_module_state` records when a module's current result was last
  // VERIFIED unchanged, and by which run. The result itself is always the
  // newest run that covered the module; this only adds "still true at".
  //
  // Guarded like 23 and 27: the ALTER is not replay-safe on its own.
  (db) => {
    const has = db.prepare('PRAGMA table_info(health_runs)').all().some((c) => c.name === 'modules_json');
    if (!has) db.exec('ALTER TABLE health_runs ADD COLUMN modules_json TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS health_table_scan_state (
        instance_key        TEXT NOT NULL,
        table_name          TEXT NOT NULL,
        enabled             INTEGER NOT NULL DEFAULT 1,   -- 0: always read in full
        spec_hash           TEXT,                          -- fields + slice at the last complete read
        last_read_at        TEXT,                          -- set only after a run finished
        last_read_run_id    TEXT,
        last_stamp_count    INTEGER,
        last_stamp_max      TEXT,                          -- newest sys_updated_on at that read
        last_stamp_error    TEXT,                          -- how the table failed, when it did
        deletion_log        INTEGER,                       -- 1 logged, 0 not, NULL unknown
        last_check_at       TEXT,
        last_check_changed  INTEGER,
        last_check_reason   TEXT,
        updated_at          TEXT NOT NULL,
        PRIMARY KEY (instance_key, table_name)
      );

      CREATE TABLE IF NOT EXISTS health_module_state (
        instance_key        TEXT NOT NULL,
        module              TEXT NOT NULL,                 -- cmdb | itom | itsm | platform
        source_run_id       TEXT,                          -- the run whose result was verified
        verified_at         TEXT,
        verified_by_run_id  TEXT,
        last_reasons_json   TEXT,                          -- why it was last re-read, if it was
        updated_at          TEXT NOT NULL,
        PRIMARY KEY (instance_key, module)
      );
    `);
  },

  // 29 — ITSM CATALOGUE PARAMETERS, per instance (ITSM Phase 5).
  //
  // The 139-rule catalogue resolves every threshold through three layers:
  // workbook default → instance override → runtime override (DECISIONS.md §4).
  // Until now the instance layer existed only in memory, so a real scan could
  // never fill the 29 parameters the workbook leaves to the customer. One row per
  // (instance, rule, parameter key); the value is typed JSON, validated against
  // the declaration before it is written (an override cannot invent a parameter).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS health_itsm_parameters (
        instance_key  TEXT NOT NULL,
        rule_id       TEXT NOT NULL,
        param_key     TEXT NOT NULL,
        value_json    TEXT NOT NULL,
        set_by        TEXT,
        set_at        TEXT NOT NULL,
        PRIMARY KEY (instance_key, rule_id, param_key)
      );
    `);
  },
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
      /*
       * PHASE 8 — a migration may be a FUNCTION as well as a SQL string.
       *
       * SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so a migration
       * that adds a column to a table an earlier migration did NOT create cannot
       * be written idempotently in SQL. Migration 23 is the first of those, and
       * the suite's own replay test caught it: it rewinds `user_version` and
       * re-runs, which a string-only migration could not survive.
       *
       * Strings still behave exactly as before. This adds an escape hatch for
       * the cases SQL cannot express, not a new migration format.
       */
      if (typeof MIGRATIONS[v] === 'function') MIGRATIONS[v](db);
      else db.exec(MIGRATIONS[v]);
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
