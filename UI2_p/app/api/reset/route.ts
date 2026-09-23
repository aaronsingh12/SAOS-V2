import "server-only";

import { NextResponse } from "next/server";
import { getDb } from "@/lib/core/db";
import { appendAuditTx, resetAuditChainTx } from "@/lib/core/audit";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      scope?: "scans" | "all";
      clearHistory?: boolean;
      actor?: string;
    };

    const scope = body.scope || "scans";
    const clearHistory = body.clearHistory ?? true;
    const actor = (body.actor || "operator").trim() || "operator";
    const db = await getDb();

    let wipedSummary = "";

    await db.transaction(async (tx) => {
      // 1. Delete all remediation plans
      await tx.query("DELETE FROM remediation_plans");

      // 2. Delete all findings
      await tx.query("DELETE FROM findings");

      // 3. Delete all agent runs & scan jobs
      await tx.query("DELETE FROM agent_runs");
      await tx.query("DELETE FROM scan_jobs");

      // 4. Always delete cached health summary so Overview completely resets
      await tx.query("DELETE FROM meta WHERE key = 'health_summary'");

      // 5. Delete past twin object history so Compare baseline starts fresh
      await tx.query("DELETE FROM twin_object_history");

      if (scope === "all") {
        // Full clean wipe: also delete twin objects
        await tx.query("DELETE FROM twin_objects");

        // Clear sync metadata
        await tx.query(
          "DELETE FROM meta WHERE key IN ('last_sync', 'coverage_complete', 'coverage_gaps', 'source_table_errors', 'source_missing_tables')",
        );

        wipedSummary = "All twin records, findings, and scan history wiped.";
      } else {
        // Scans wipe: preserve cached twin objects, but mark their version as 0
        await tx.query("UPDATE twin_objects SET twin_version = 0");
        wipedSummary = "All findings, remediation plans, and scan history wiped.";
      }

      // Reset twin_version in meta to 0 so the very next scan starts as Version 1
      await tx.query(
        "INSERT INTO meta(key, value) VALUES('twin_version', '0') ON CONFLICT(key) DO UPDATE SET value = '0'",
      );

      // Handle Audit & History log chain
      if (clearHistory) {
        await resetAuditChainTx(
          tx,
          actor,
          `${wipedSummary} Audit chain reset to genesis. Ready for Twin Version 1.`,
        );
      } else {
        await appendAuditTx(
          tx,
          scope === "all" ? "TWIN_ESTATE_AND_SCANS_WIPED" : "SCANS_AND_FINDINGS_WIPED",
          {
            scope,
            resetTwinVersionTo: 0,
            nextScanVersion: 1,
            summary: wipedSummary,
          },
          actor,
        );
      }
    });

    return NextResponse.json({
      ok: true,
      scope,
      message: `${wipedSummary} Next scan will be treated as Version 1.`,
      nextTwinVersion: 1,
    });
  } catch (error) {
    console.error("Failed to wipe scans:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to wipe scans and reset state",
      },
      { status: 500 },
    );
  }
}
