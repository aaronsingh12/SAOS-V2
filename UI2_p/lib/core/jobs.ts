import "server-only";

import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { syncServiceNow } from "./servicenow";
import { runScan } from "./scan";

export type JobKind = "sync" | "scan";
export type JobStatus = "queued" | "running" | "completed" | "failed";

export type ScanJob = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  phase: string;
  currentAgent: string | null;
  currentTable: string | null;
  progress: number;
  total: number;
  message: string;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type JobRow = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  phase: string;
  current_agent: string | null;
  current_table: string | null;
  progress: number;
  total: number;
  message: string;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function mapJob(row: JobRow): ScanJob {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    phase: row.phase,
    currentAgent: row.current_agent,
    currentTable: row.current_table,
    progress: row.progress,
    total: row.total,
    message: row.message,
    result: row.result,
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function getScanJob(id: string) {
  const db = await getDb();
  const result = await db.query<JobRow>("SELECT * FROM scan_jobs WHERE id=$1", [
    id,
  ]);
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

async function updateJob(id: string, patch: Partial<ScanJob>) {
  const db = await getDb();
  await db.query(
    "UPDATE scan_jobs SET status=COALESCE($2,status),phase=COALESCE($3,phase),current_agent=COALESCE($4,current_agent),current_table=COALESCE($5,current_table),progress=COALESCE($6,progress),total=COALESCE($7,total),message=COALESCE($8,message),result=COALESCE($9,result),error=COALESCE($10,error),updated_at=now() WHERE id=$1",
    [
      id,
      patch.status ?? null,
      patch.phase ?? null,
      patch.currentAgent ?? null,
      patch.currentTable ?? null,
      patch.progress ?? null,
      patch.total ?? null,
      patch.message ?? null,
      patch.result ? JSON.stringify(patch.result) : null,
      patch.error ?? null,
    ],
  );
}

async function createJob(kind: JobKind) {
  const id = randomUUID();
  const db = await getDb();
  await db.query(
    "INSERT INTO scan_jobs(id,kind,status,phase,message) VALUES($1,$2,'queued','queued',$3)",
    [
      id,
      kind,
      kind === "sync"
        ? "Waiting to read ServiceNow"
        : "Waiting to check the local twin",
    ],
  );
  return id;
}

async function executeJob(id: string, kind: JobKind) {
  await updateJob(id, {
    status: "running",
    phase: kind === "sync" ? "extract" : "analysis",
    currentAgent: kind === "sync" ? "Extraction" : "CMDB rule engine",
    message:
      kind === "sync" ? "Reading source records" : "Checking supported rules",
  });
  try {
    if (kind === "sync") {
      const sync = await syncServiceNow((progress) => updateJob(id, progress));
      await updateJob(id, {
        phase: "analysis",
        currentAgent: "CMDB rule engine",
        currentTable: "local twin",
        progress: 50,
        total: 100,
        message: "Source snapshot complete; checking supported rules",
      });
      const scan = await runScan((progress) => updateJob(id, progress));
      await updateJob(id, {
        status: "completed",
        phase: "completed",
        progress: 100,
        message: "Records loaded and checked",
        result: { sync, scan },
      });
      return;
    }
    const result = await runScan((progress) => updateJob(id, progress));
    await updateJob(id, {
      status: "completed",
      phase: "completed",
      progress: 100,
      message: "Checks completed",
      result: result as unknown as Record<string, unknown>,
    });
  } catch (error) {
    await updateJob(id, {
      status: "failed",
      phase: "failed",
      message:
        "The job stopped. Check the error and local copy before starting again.",
      error: error instanceof Error ? error.message : "Scan failed",
    });
  }
}

let startPromise: Promise<{ jobId: string }> | null = null;

export async function startScanJob(kind: JobKind) {
  // A double-click or two browser tabs must not mutate the same local twin
  // concurrently. Return the existing job so both views follow one run.
  if (startPromise) return startPromise;
  startPromise = (async () => {
    const db = await getDb();
    const active = await db.query<{ id: string }>(
      "SELECT id FROM scan_jobs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
    );
    if (active.rows[0]) return { jobId: active.rows[0].id };
    const id = await createJob(kind);
    void executeJob(id, kind);
    return { jobId: id };
  })();
  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}
