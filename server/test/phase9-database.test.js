/**
 * PHASE 9 — DATABASE INTEGRITY.
 *
 *   node --test server/test/
 *
 * A migration history is the one part of a system that cannot be re-derived. The
 * database on a running installation went through every migration in order; a
 * fresh one goes through them in a single pass. This file audits that history
 * for the ways it could quietly take data away from somebody who upgrades, and
 * proves the durable state survives a restart.
 *
 * THREE FINDINGS FROM WRITING IT, recorded because they are easy to get wrong:
 *
 *   `DROP TABLE` is NOT destructive on its own. SQLite cannot alter a table's
 *   constraints, so the only way to change one is the rebuild pattern — create,
 *   copy every row, drop, rename. Migration 14 does exactly that. The rule that
 *   matters is that every DROP is preceded by a copy.
 *
 *   `NOT NULL` on a new column is NOT unsafe when it carries a DEFAULT. Without
 *   one, SQLite refuses outright on any populated table — which is precisely the
 *   database that matters.
 *
 *   REPLAY FROM AN ARBITRARY REWIND is not a property this history has, and it
 *   is not one it needs. `user_version` only ever moves forward in production.
 *   What matters instead is that a FAILED migration leaves nothing behind, and
 *   that is asserted directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p9db-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { getDb } = await import('../src/memory/db.js');
const { createTask, startTask, completeTask } = await import('../src/memory/tasks.js');
const P = await import('../src/agent/plan/index.js');

const DB_SRC = fs.readFileSync(new URL('../src/memory/db.js', import.meta.url), 'utf8');
const HEAD_VERSION = 25;

/** The migration bodies only, with comments stripped. */
const MIGRATION_BODY = (() => {
  const i = DB_SRC.indexOf('const MIGRATIONS');
  const j = DB_SRC.indexOf('\n];', i);
  return DB_SRC.slice(i, j).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
})();

let tmpN = 0;
const freshFile = () => path.join(scratchDir, `db-${++tmpN}.sqlite`);

function schemaOf(db) {
  return db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  ).all().map((r) => ({
    type: r.type, name: r.name, tbl_name: r.tbl_name,
    sql: (r.sql ?? '').replace(/\s+/g, ' ').trim(),
  }));
}

function columnsOf(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((r) => r.name);
  const out = {};
  for (const t of tables) {
    out[t] = db.prepare(`PRAGMA table_info(${t})`).all()
      .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value ?? 'NULL'}:${c.pk}`);
  }
  return out;
}

/* ================================================================== *
 * A. THE HISTORY
 * ================================================================== */

test('D1 — the head is 25 and a fresh database reaches it', () => {
  const db = migrate(new DatabaseSync(freshFile()));
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, HEAD_VERSION);
  } finally { db.close(); }
});

test('D2 — no shipped migration LOSES data', () => {
  const drops = [...MIGRATION_BODY.matchAll(/\bDROP\s+TABLE\s+(\w+)/gi)].map((m) => m[1]);
  assert.ok(drops.length > 0, 'the DROP scan found nothing — the parser is wrong, not the schema');
  for (const dropped of drops) {
    // Every row must have been copied somewhere before the table goes.
    const copied = new RegExp(`INSERT\\s+INTO\\s+\\w+[\\s\\S]{0,800}?FROM\\s+${dropped}\\b`, 'i').test(MIGRATION_BODY);
    assert.ok(copied, `${dropped} is dropped without its rows being copied first — data loss on upgrade`);
    // And the replacement takes the original name back, so nothing downstream breaks.
    assert.ok(new RegExp(`RENAME\\s+TO\\s+${dropped}\\b`, 'i').test(MIGRATION_BODY),
      `${dropped} is dropped and never restored under its own name`);
  }
  // These have no safe form in a shipped migration.
  for (const forbidden of [/\bDELETE\s+FROM\b/i, /\bDROP\s+COLUMN\b/i, /\bTRUNCATE\b/i, /\bDROP\s+INDEX\b/i]) {
    assert.ok(!forbidden.test(MIGRATION_BODY), `a shipped migration contains ${forbidden}`);
  }
});

test('D3 — every ADD COLUMN can survive a populated table', () => {
  const adds = [...DB_SRC.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\s+([A-Z]+)([^;'`]*)/gi)];
  assert.ok(adds.length > 0, 'no ADD COLUMN found — the parser is wrong, not the schema');
  for (const [, table, col, , rest] of adds) {
    if (/NOT\s+NULL/i.test(rest)) {
      assert.match(rest, /DEFAULT/i,
        `${table}.${col} is NOT NULL with no DEFAULT — the migration fails on any populated database`);
    }
  }
  // The Phase 8 correlation columns must stay nullable and default-free: an old
  // row has to keep meaning "names no task" rather than being back-filled.
  for (const t of ['mutation_ledger', 'tool_events']) {
    const m = new RegExp(`ALTER TABLE ${t}\\s+ADD COLUMN task_id TEXT([^;]*)`, 'i').exec(DB_SRC);
    assert.ok(m, `${t}.task_id is no longer added`);
    assert.ok(!/NOT\s+NULL|DEFAULT/i.test(m[1]),
      `${t}.task_id gained a constraint — an old row would then claim a task it never had`);
  }
});

test('D4 — migrating an already-current database is a no-op', () => {
  const db = migrate(new DatabaseSync(freshFile()));
  try {
    const before = schemaOf(db);
    migrate(db);
    migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, HEAD_VERSION);
    assert.deepEqual(schemaOf(db), before, 're-running migrations changed the schema');
  } finally { db.close(); }
});

test('D5 — a FAILED migration leaves the database exactly as it was', () => {
  /*
   * THE PROPERTY THAT ACTUALLY MATTERS.
   *
   * Arbitrary replay is not something this history supports: several shipped
   * migrations use a bare `ALTER TABLE ... ADD COLUMN`, which SQLite cannot
   * express conditionally, and rewriting them is forbidden — they have already
   * run on real databases. In production `user_version` only moves forward, so
   * they never re-run.
   *
   * What must hold instead is that when a migration DOES fail, it fails cleanly:
   * the transaction rolls back, `user_version` does not advance, and the next
   * start sees the same database rather than a half-migrated one. That is
   * verified here by forcing exactly the failure a replay would cause.
   */
  const file = freshFile();
  const db = migrate(new DatabaseSync(file));
  try {
    const before = schemaOf(db);
    // Rewind into the range where a bare ADD COLUMN will collide.
    db.exec('PRAGMA user_version = 4');
    assert.throws(() => migrate(db), /migration 5 failed/,
      'a colliding migration did not fail loudly');
    // Rolled back: the schema is untouched and the version did not advance.
    assert.deepEqual(schemaOf(db), before, 'a failed migration changed the schema');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4,
      'a failed migration advanced user_version, so the next start would skip it');
  } finally { db.close(); }
});

test('D6 — migrations 23 and 24 ARE replay-safe, because Phase 8 made it so', () => {
  // The migrations written after the replay hazard was understood. 23 guards its
  // own ALTERs and 24 is CREATE TABLE IF NOT EXISTS, so re-running both is
  // harmless. Rewinding to 22 replays them together.
  const file = freshFile();
  const db = migrate(new DatabaseSync(file));
  try {
    const before = schemaOf(db);
    db.exec('PRAGMA user_version = 22');
    migrate(db);   // must not throw
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, HEAD_VERSION);
    assert.deepEqual(schemaOf(db), before, 'replaying migrations 23-24 changed the schema');
  } finally { db.close(); }
});

/* ================================================================== *
 * B. FRESH vs UPGRADED
 * ================================================================== */

test('D7 — a database built in one pass and one built across restarts are identical', () => {
  /*
   * The real-world difference between "fresh" and "upgraded" is that an upgraded
   * database was migrated by a DIFFERENT PROCESS at a different time, with the
   * file closed and reopened in between. That is what is simulated here: the
   * upgraded one is created empty, closed, reopened, migrated, closed, reopened
   * and migrated again.
   *
   * They must agree exactly. Anything else means a migration is not
   * deterministic — reading a clock, an environment variable, or the state of
   * something outside the file.
   */
  const freshDb = migrate(new DatabaseSync(freshFile()));

  const upgradedFile = freshFile();
  let up = new DatabaseSync(upgradedFile);
  up.exec('PRAGMA journal_mode = WAL');
  up.close();
  up = migrate(new DatabaseSync(upgradedFile));
  up.close();
  up = migrate(new DatabaseSync(upgradedFile));

  try {
    assert.deepEqual(columnsOf(up), columnsOf(freshDb),
      'the upgraded database has different columns from a fresh one');
    assert.deepEqual(schemaOf(up), schemaOf(freshDb),
      'the upgraded database has different objects from a fresh one');
    assert.equal(
      up.prepare('PRAGMA user_version').get().user_version,
      freshDb.prepare('PRAGMA user_version').get().user_version,
    );
  } finally { freshDb.close(); up.close(); }
});

test('D8 — both paths BEHAVE the same, not just look the same', () => {
  const a = migrate(new DatabaseSync(freshFile()));
  const bFile = freshFile();
  let b = migrate(new DatabaseSync(bFile));
  b.close();
  b = migrate(new DatabaseSync(bFile));
  try {
    for (const db of [a, b]) {
      const now = new Date().toISOString();
      db.prepare('INSERT INTO sessions (id, created, updated) VALUES (?, ?, ?)').run('s', now, now);
      // The Phase 8 correlation columns must accept a task id on both paths.
      db.prepare(
        'INSERT INTO tool_events (session, seq, kind, name, ts, mutating, task_id) VALUES (?, ?, ?, ?, ?, 0, ?)',
      ).run('s', 0, 'tool_call', 't', now, 'task-1');
      db.prepare(
        'INSERT INTO mutation_ledger (session, turn_seq, ts, tool, status, task_id) VALUES (?, 0, ?, ?, ?, ?)',
      ).run('s', now, 'update_record', 'applied', 'task-1');
      assert.equal(db.prepare('SELECT task_id FROM tool_events WHERE session = ?').get('s').task_id, 'task-1');
      assert.equal(db.prepare('SELECT task_id FROM mutation_ledger WHERE session = ?').get('s').task_id, 'task-1');
      // And a NULL task id is still allowed, which is what every legacy row is.
      db.prepare(
        'INSERT INTO tool_events (session, seq, kind, name, ts, mutating) VALUES (?, ?, ?, ?, ?, 0)',
      ).run('s', 1, 'tool_call', 'legacy', now);
      assert.equal(db.prepare('SELECT task_id FROM tool_events WHERE seq = 1').get().task_id, null);
    }
  } finally { a.close(); b.close(); }
});

/* ================================================================== *
 * C. INDEXES, KEYS, OWNERSHIP
 * ================================================================== */

test('D9 — every column the read paths filter on is indexed', () => {
  const db = migrate(new DatabaseSync(freshFile()));
  try {
    const names = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
    ).all().map((r) => r.name));
    for (const required of [
      'idx_mutation_ledger_task',   // Phase 8: without it, evidence scans the whole ledger
      'idx_tool_events_task',
      'idx_mutation_ledger_session',
      'idx_agent_tasks_session',
      'idx_agent_task_steps_task',
      'idx_agent_task_steps_planid',
    ]) {
      assert.ok(names.has(required), `${required} is missing`);
    }
  } finally { db.close(); }
});

test('D10 — a step sequence and a plan step id are unique within their task', () => {
  const sid = 'p9db-seq';
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal: 'seq' });
  startTask(t.id);

  const readStep = (id, deps) => ({
    id, operation: `op ${id}`, capability: 'record_read', tool: 'get_record',
    mutating: false, inputs: {}, depends_on: deps, expected_effects: [], verification: null,
  });
  P.savePlan(t.id, { goal: 'g', steps: [readStep('a', []), readStep('b', ['a']), readStep('c', ['b'])] });

  const rows = getDb().prepare(
    'SELECT sequence, plan_step_id FROM agent_task_steps WHERE task_id = ? ORDER BY sequence',
  ).all(t.id);
  const seqs = rows.map((r) => r.sequence);
  const ids = rows.map((r) => r.plan_step_id);
  assert.equal(new Set(seqs).size, seqs.length, `duplicate sequence within one task: ${seqs.join(',')}`);
  assert.equal(new Set(ids).size, ids.length, `duplicate plan_step_id within one task: ${ids.join(',')}`);

  // A re-plan REPLACES rather than accumulating — otherwise the orphans would
  // show up in evidence as steps that were never run.
  P.savePlan(t.id, { goal: 'g', steps: [readStep('a', [])] });
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS n FROM agent_task_steps WHERE task_id = ?').get(t.id).n, 1,
    'a re-saved plan left orphan steps behind',
  );
});

test('D11 — the normal lifecycle leaves no orphaned rows', () => {
  const db = getDb();
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM agent_task_steps s LEFT JOIN agent_tasks t ON t.id = s.task_id WHERE t.id IS NULL').get().n,
    0, 'steps exist with no task',
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM agent_tasks a LEFT JOIN sessions s ON s.id = a.session_id WHERE a.session_id IS NOT NULL AND s.id IS NULL').get().n,
    0, 'tasks exist with no session',
  );
});

test('D12 — an audit row never names a task belonging to another session', () => {
  const db = getDb();
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM mutation_ledger m
    LEFT JOIN agent_tasks t ON t.id = m.task_id
    WHERE m.task_id IS NOT NULL AND (t.id IS NULL OR t.session_id != m.session)
  `).get().n, 0, 'a ledger row names a foreign or missing task');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS n FROM tool_events e
    LEFT JOIN agent_tasks t ON t.id = e.task_id
    WHERE e.task_id IS NOT NULL AND (t.id IS NULL OR t.session_id != e.session)
  `).get().n, 0, 'a tool event names a foreign or missing task');
});

/* ================================================================== *
 * D. RESTART PERSISTENCE
 * ================================================================== */

test('D13 — a plan, its steps and its recovery lineage survive a restart', () => {
  const file = freshFile();
  const now = new Date().toISOString();
  let taskId = null;

  const first = migrate(new DatabaseSync(file));
  _setDbForTests(first);
  try {
    first.prepare('INSERT INTO sessions (id, created, updated) VALUES (?, ?, ?)').run('restart', now, now);
    const t = createTask({ sessionId: 'restart', goal: 'survive a restart' });
    startTask(t.id);
    taskId = t.id;
    P.savePlan(taskId, {
      goal: 'survive a restart',
      steps: [{
        id: 'step_1', operation: 'update', capability: 'record_update', tool: 'update_record',
        mutating: true, target: { table: 'incident', sys_id: 'a'.repeat(32) },
        inputs: { table: 'incident', sys_id: 'a'.repeat(32), data: { short_description: 'x' } },
        depends_on: [], expected_effects: ['x'], verification: { strategy: 'read_back', asserts: ['ok'] },
      }],
    });
    P.recordRecoveryAttempt(taskId, 'step_1', { attempt: 1, decision: 'RETRY', outcome: 'NOT_RECOVERED' });
    completeTask(taskId);
  } finally { first.close(); }

  // A different process opening the same file. This is that.
  const second = migrate(new DatabaseSync(file));
  _setDbForTests(second);
  try {
    const plan = P.loadPlan(taskId);
    assert.ok(plan, 'the plan did not survive the restart');
    assert.equal(plan.goal, 'survive a restart');
    assert.equal(plan.steps.length, 1);
    assert.ok(plan.fingerprint, 'the fingerprint did not survive');
    const history = P.recoveryHistory(taskId, 'step_1');
    assert.equal(history.attempts.length, 1, 'the recovery lineage did not survive');
    assert.equal(history.attempts[0].decision, 'RETRY');
  } finally {
    second.close();
    _setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));
  }
});

test('D14 — WAL and foreign keys are on, and each migration is transactional', () => {
  const db = migrate(new DatabaseSync(freshFile()));
  try {
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1,
      'foreign keys are off, so an orphan row is possible');
  } finally { db.close(); }
  assert.match(DB_SRC, /journal_mode\s*=\s*WAL/i, 'WAL is not enabled');
  assert.match(DB_SRC, /db\.exec\('BEGIN'\)/);
  assert.match(DB_SRC, /db\.exec\('COMMIT'\)/);
  assert.match(DB_SRC, /db\.exec\('ROLLBACK'\)/);
  assert.match(DB_SRC, /migration \$\{v \+ 1\} failed/, 'a failed migration is not reported loudly');
});
