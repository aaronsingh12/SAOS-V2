import "server-only";

import { createHash } from "node:crypto";
import type { Transaction } from "@electric-sql/pglite";
import { getDb } from "./db";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function hashEntry(
  prevHash: string,
  occurredAt: string,
  actor: string,
  action: string,
  payload: Record<string, unknown>,
) {
  return createHash("sha256")
    .update(canonical({ prevHash, occurredAt, actor, action, payload }))
    .digest("hex");
}

export async function appendAuditTx(
  tx: Transaction,
  action: string,
  payload: Record<string, unknown>,
  actor = "local-operator",
) {
  const previous = await tx.query<{ entry_hash: string }>(
    "SELECT entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1",
  );
  const prevHash = previous.rows[0]?.entry_hash ?? "GENESIS";
  const occurredAt = new Date().toISOString();
  const entryHash = hashEntry(prevHash, occurredAt, actor, action, payload);
  await tx.query(
    "INSERT INTO audit_log(occurred_at,actor,action,payload,prev_hash,entry_hash) VALUES ($1,$2,$3,$4,$5,$6)",
    [occurredAt, actor, action, JSON.stringify(payload), prevHash, entryHash],
  );
  return entryHash;
}

export async function appendAudit(
  action: string,
  payload: Record<string, unknown>,
  actor = "local-operator",
) {
  const db = await getDb();
  return db.transaction((tx) => appendAuditTx(tx, action, payload, actor));
}

export async function listAudit(limit = 100) {
  const db = await getDb();
  const result = await db.query(
    "SELECT seq,occurred_at,actor,action,payload,prev_hash,entry_hash FROM audit_log ORDER BY seq DESC LIMIT $1",
    [limit],
  );
  return result.rows;
}

export async function listAllAudit() {
  const db = await getDb();
  const result = await db.query(
    "SELECT seq,occurred_at,actor,action,payload,prev_hash,entry_hash FROM audit_log ORDER BY seq ASC",
  );
  return result.rows;
}

export async function verifyAudit() {
  const db = await getDb();
  const result = await db.query<{
    seq: number;
    occurred_at: string;
    actor: string;
    action: string;
    payload: Record<string, unknown>;
    prev_hash: string;
    entry_hash: string;
  }>("SELECT * FROM audit_log ORDER BY seq ASC");
  let prevHash = "GENESIS";
  for (const entry of result.rows) {
    const hash = hashEntry(
      prevHash,
      new Date(entry.occurred_at).toISOString(),
      entry.actor,
      entry.action,
      entry.payload,
    );
    if (entry.prev_hash !== prevHash || entry.entry_hash !== hash)
      return { valid: false, checked: Number(entry.seq) };
    prevHash = entry.entry_hash;
  }
  return { valid: true, checked: result.rows.length };
}

export async function resetAuditChainTx(
  tx: Transaction,
  actor = "operator",
  message = "Audit chain reset to genesis",
) {
  await tx.query("DROP TRIGGER IF EXISTS audit_no_update ON audit_log");
  await tx.query("DELETE FROM audit_log");
  await tx.query(`
    CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION saos_forbid_audit_mutation()
  `);
  const occurredAt = new Date().toISOString();
  const payload = {
    message,
    actor,
    resetAt: occurredAt,
  };
  const entryHash = hashEntry(
    "GENESIS",
    occurredAt,
    actor,
    "SYSTEM_RESET_GENESIS",
    payload,
  );
  await tx.query(
    "INSERT INTO audit_log(occurred_at, actor, action, payload, prev_hash, entry_hash) VALUES ($1, $2, $3, $4, $5, $6)",
    [
      occurredAt,
      actor,
      "SYSTEM_RESET_GENESIS",
      JSON.stringify(payload),
      "GENESIS",
      entryHash,
    ],
  );
  return entryHash;
}
