import "server-only";

import { PGlite } from "@electric-sql/pglite";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const dataDir =
  process.env.SAOS_DATA_DIR ?? join(process.cwd(), ".saos-data", "postgres");

const schema = `
CREATE TABLE IF NOT EXISTS meta (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE IF NOT EXISTS twin_objects (
  id text PRIMARY KEY, table_name text NOT NULL, sys_id text NOT NULL,
  domain_id text NOT NULL, twin_version integer NOT NULL,
  payload jsonb NOT NULL, source_updated_at text, synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(table_name, sys_id, domain_id)
);
CREATE INDEX IF NOT EXISTS twin_objects_scope_idx ON twin_objects(domain_id, table_name);
CREATE TABLE IF NOT EXISTS twin_object_history (
  id text NOT NULL,
  table_name text NOT NULL,
  sys_id text NOT NULL,
  domain_id text NOT NULL,
  twin_version integer NOT NULL,
  payload jsonb NOT NULL,
  source_updated_at text,
  archived_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(id, twin_version)
);
CREATE INDEX IF NOT EXISTS twin_object_history_lookup_idx ON twin_object_history(table_name, sys_id, domain_id, twin_version DESC);
CREATE TABLE IF NOT EXISTS findings (
  id text PRIMARY KEY, rule_id text NOT NULL, rule_version text NOT NULL,
  domain_id text NOT NULL, target_id text NOT NULL, title text NOT NULL,
  explanation text NOT NULL, evidence jsonb NOT NULL, confidence integer NOT NULL CHECK(confidence BETWEEN 0 AND 100),
  risk text NOT NULL, lane integer NOT NULL CHECK(lane BETWEEN 1 AND 3),
  suggested_after jsonb, approval_required boolean NOT NULL,
  twin_version integer NOT NULL, status text NOT NULL DEFAULT 'Open',
  risk_assessment jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE findings ADD COLUMN IF NOT EXISTS risk_assessment jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS what_it_means text;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS why_it_matters text;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS false_positive_guard text;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS cross_domain_link text;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS source_tables text;
CREATE TABLE IF NOT EXISTS remediation_plans (
  id text PRIMARY KEY, finding_id text NOT NULL REFERENCES findings(id),
  status text NOT NULL DEFAULT 'Proposed', preview jsonb, approved_by text,
  source_twin_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  update_set_xml text
);
ALTER TABLE remediation_plans ADD COLUMN IF NOT EXISTS update_set_xml text;
CREATE TABLE IF NOT EXISTS scan_jobs (
  id text PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL,
  phase text NOT NULL,
  current_agent text,
  current_table text,
  progress integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  message text NOT NULL,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  twin_version integer NOT NULL,
  status text NOT NULL,
  finding_count integer NOT NULL DEFAULT 0,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_runs_latest_idx ON agent_runs(agent_id, twin_version DESC);
CREATE TABLE IF NOT EXISTS audit_log (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurred_at timestamptz NOT NULL,
  actor text NOT NULL, action text NOT NULL, payload jsonb NOT NULL,
  prev_hash text NOT NULL, entry_hash text NOT NULL UNIQUE
);
CREATE OR REPLACE FUNCTION saos_forbid_audit_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append only'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_no_update ON audit_log;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION saos_forbid_audit_mutation();
`;

declare global {
  var saosDbPromise: Promise<PGlite> | undefined;
}

async function createDb() {
  await mkdir(dataDir, { recursive: true });
  let db: PGlite;
  try {
    db = await PGlite.create(dataDir);
  } catch (err) {
    console.error(
      `[SAOS DB] PGlite failed to open at ${dataDir} (likely interrupted/corrupt WAL checkpoint):`,
      err,
    );
    // Archive corrupt database directory so nothing is permanently lost
    const corruptBackup = `${dataDir}.corrupted.${Date.now()}`;
    try {
      await rename(dataDir, corruptBackup);
      console.warn(`[SAOS DB] Archived corrupt database to ${corruptBackup}`);
    } catch (archiveErr) {
      console.error(`[SAOS DB] Failed to rename corrupt database directory:`, archiveErr);
      await rm(dataDir, { recursive: true, force: true });
    }
    await mkdir(dataDir, { recursive: true });
    console.info(`[SAOS DB] Creating fresh database at ${dataDir}...`);
    db = await PGlite.create(dataDir);
  }

  // Graceful shutdown hooks to flush checkpoints cleanly
  const closeDb = async () => {
    try {
      if (db) {
        await db.close();
      }
    } catch {
      // ignore on process exit
    }
  };
  process.once("SIGTERM", closeDb);
  process.once("SIGINT", closeDb);

  await db.exec(schema);
  // Jobs execute in this local Node process. A process restart cannot resume
  // the old promise, so never leave a stale "running" label behind.
  await db.query(
    "UPDATE scan_jobs SET status='failed',phase='interrupted',message='The app restarted before this job finished',error='Restarted during job; start a new scan',updated_at=now() WHERE status IN ('queued','running')",
  );
  const current = await db.query<{ value: string }>(
    "SELECT value FROM meta WHERE key = 'twin_version'",
  );
  if (current.rows.length === 0) {
    await db.query("INSERT INTO meta(key,value) VALUES ('twin_version','0')");
  }
  return db;
}

export function getDb() {
  if (!globalThis.saosDbPromise) {
    globalThis.saosDbPromise = createDb().catch((err) => {
      // If initialization fails, reset the promise so next request can retry instead of caching rejection
      globalThis.saosDbPromise = undefined;
      throw err;
    });
  }
  return globalThis.saosDbPromise;
}

export async function getTwinVersion() {
  const db = await getDb();
  const result = await db.query<{ value: string }>(
    "SELECT value FROM meta WHERE key='twin_version'",
  );
  return Number(result.rows[0].value);
}
