import { getDb, getTwinVersion } from "@/lib/core/db";
import { errorResponse } from "@/lib/core/http";

export const dynamic = "force-dynamic";

// Non-configuration metadata, ephemeral audit journals, and dynamic runtime clock tickers
// (SLA percentage/time elapsed counters tick continuously as time passes, and are not configuration drift)
const IGNORED_METADATA_FIELDS = new Set([
  "sys_updated_on",
  "sys_updated_by",
  "sys_mod_count",
  "sys_created_on",
  "sys_created_by",
  "sys_tags",
  "sys_id",
  // Ephemeral journal activity fields (audit notes appended during remediation, not static record attributes)
  "work_notes",
  "comments",
  "comments_and_work_notes",
  "close_notes",
  "journal_entry",
  // SLA runtime elapsed clock fields (dynamic counters, not governance configuration drift)
  "percentage",
  "business_percentage",
  "duration",
  "business_duration",
  "time_left",
  "business_time_left",
  "planned_end_time",
  "original_breach_time",
  "pause_duration",
  "pause_time",
]);

function getRecordDisplayName(table: string, payload: Record<string, unknown>, sysId: string): string {
  if (payload.number && String(payload.number).trim() !== "") {
    const num = String(payload.number).trim();
    if (payload.short_description && String(payload.short_description).trim() !== "") {
      return `${num} — ${String(payload.short_description).trim()}`;
    }
    return num;
  }
  if (payload.name && String(payload.name).trim() !== "") {
    return String(payload.name).trim();
  }
  if (payload.short_description && String(payload.short_description).trim() !== "") {
    return String(payload.short_description).trim();
  }
  if (payload.caller_id && String(payload.caller_id).trim() !== "") {
    return `${table.toUpperCase()} (Caller: ${String(payload.caller_id).slice(0, 8)}...)`;
  }
  if (payload.parent && payload.child) {
    return `Rel: ${String(payload.parent).slice(0, 8)} ➔ ${String(payload.child).slice(0, 8)}`;
  }
  return `${table} [${sysId.slice(0, 8)}]`;
}

export async function GET(request: Request) {
  try {
    const db = await getDb();
    const currentVersion = await getTwinVersion();

    // Query all distinct versions from history + current
    const versionResult = await db.query<{ twin_version: number }>(
      "SELECT DISTINCT twin_version FROM twin_object_history ORDER BY twin_version ASC",
    );
    const historyVersions = versionResult.rows.map((r) => Number(r.twin_version));
    const allVersionsSet = new Set([...historyVersions, currentVersion]);
    const availableVersions = Array.from(allVersionsSet).sort((a, b) => a - b);

    const { searchParams } = new URL(request.url);
    const reqFrom = searchParams.get("from");
    const reqTo = searchParams.get("to");

    let toVersion = reqTo ? parseInt(reqTo, 10) : currentVersion;
    if (isNaN(toVersion) || !allVersionsSet.has(toVersion)) toVersion = currentVersion;

    let fromVersion = reqFrom
      ? parseInt(reqFrom, 10)
      : toVersion > 1
        ? toVersion - 1
        : 1;
    if (isNaN(fromVersion) || !allVersionsSet.has(fromVersion)) {
      fromVersion = availableVersions[0] ?? 1;
    }

    // Load "to" version rows:
    let toRows: {
      id: string;
      table_name: string;
      sys_id: string;
      domain_id: string;
      payload: Record<string, unknown>;
    }[] = [];

    if (toVersion === currentVersion) {
      const currentResult = await db.query<{
        id: string;
        table_name: string;
        sys_id: string;
        domain_id: string;
        payload: Record<string, unknown>;
      }>("SELECT id, table_name, sys_id, domain_id, payload FROM twin_objects");
      toRows = currentResult.rows;
    } else {
      const toHistResult = await db.query<{
        id: string;
        table_name: string;
        sys_id: string;
        domain_id: string;
        payload: Record<string, unknown>;
      }>(
        "SELECT DISTINCT ON (id) id, table_name, sys_id, domain_id, payload FROM twin_object_history WHERE twin_version = $1 ORDER BY id",
        [toVersion],
      );
      toRows = toHistResult.rows;
    }

    // Load "from" version rows:
    let fromRows: {
      id: string;
      table_name: string;
      sys_id: string;
      domain_id: string;
      payload: Record<string, unknown>;
    }[] = [];

    if (fromVersion === currentVersion) {
      const currentResult = await db.query<{
        id: string;
        table_name: string;
        sys_id: string;
        domain_id: string;
        payload: Record<string, unknown>;
      }>("SELECT id, table_name, sys_id, domain_id, payload FROM twin_objects");
      fromRows = currentResult.rows;
    } else {
      const fromHistResult = await db.query<{
        id: string;
        table_name: string;
        sys_id: string;
        domain_id: string;
        payload: Record<string, unknown>;
      }>(
        "SELECT DISTINCT ON (id) id, table_name, sys_id, domain_id, payload FROM twin_object_history WHERE twin_version = $1 ORDER BY id",
        [fromVersion],
      );
      fromRows = fromHistResult.rows;
    }

    const fromMap = new Map<string, (typeof fromRows)[number]>(
      fromRows.map((r) => [r.id, r]),
    );
    const toMap = new Map<string, (typeof toRows)[number]>(
      toRows.map((r) => [r.id, r]),
    );

    let addedCount = 0;
    let modifiedCount = 0;
    let unchangedCount = 0;
    let removedCount = 0;

    type DiffItem = {
      id: string;
      tableName: string;
      sysId: string;
      name?: string;
      type: "added" | "modified" | "removed";
      changes?: { field: string; before: unknown; after: unknown }[];
      details?: Record<string, string>;
    };

    const addedDiffs: DiffItem[] = [];
    const modifiedDiffs: DiffItem[] = [];
    const removedDiffs: DiffItem[] = [];

    for (const [id, current] of toMap.entries()) {
      const prev = fromMap.get(id);
      const currentName = getRecordDisplayName(current.table_name, current.payload, current.sys_id);

      if (!prev) {
        addedCount++;
        if (addedDiffs.length < 100) {
          addedDiffs.push({
            id,
            tableName: current.table_name,
            sysId: current.sys_id,
            name: currentName,
            type: "added",
            details: {
              class: String(current.payload.sys_class_name || current.table_name),
              category: String(current.payload.category || ""),
              status: String(current.payload.operational_status || current.payload.state || ""),
            },
          });
        }
      } else {
        const functionalChanges: { field: string; before: unknown; after: unknown }[] = [];

        const allKeys = new Set([
          ...Object.keys(prev.payload || {}),
          ...Object.keys(current.payload || {}),
        ]);

        for (const k of allKeys) {
          if (k.startsWith("_") || IGNORED_METADATA_FIELDS.has(k)) continue;

          // If a key is missing from one version's extraction schema (e.g. unqueried column),
          // do not generate false drift (e.g. priority 1 -> empty). Genuine field clears in ServiceNow
          // are represented as empty strings ("") or null in both payloads.
          if (!(k in prev.payload) || !(k in current.payload)) {
            continue;
          }

          const raw1 = prev.payload[k];
          const raw2 = current.payload[k];
          const v1 = raw1 === undefined || raw1 === null ? "" : String(raw1).trim();
          const v2 = raw2 === undefined || raw2 === null ? "" : String(raw2).trim();

          if (v1 !== v2) {
            const beforeVal = raw1 !== undefined && raw1 !== null && v1 !== "" ? raw1 : "(empty)";
            const afterVal = raw2 !== undefined && raw2 !== null && v2 !== "" ? raw2 : "(empty)";
            functionalChanges.push({ field: k, before: beforeVal, after: afterVal });
          }
        }

        // Only count as modified if functional configuration/business attributes actually changed
        if (functionalChanges.length > 0) {
          modifiedCount++;
          if (modifiedDiffs.length < 100) {
            modifiedDiffs.push({
              id,
              tableName: current.table_name,
              sysId: current.sys_id,
              name: currentName,
              type: "modified",
              changes: functionalChanges,
            });
          }
        } else {
          unchangedCount++;
        }
      }
    }

    for (const [id, prev] of fromMap.entries()) {
      if (!toMap.has(id)) {
        removedCount++;
        if (removedDiffs.length < 100) {
          const prevName = getRecordDisplayName(prev.table_name, prev.payload, prev.sys_id);
          removedDiffs.push({
            id,
            tableName: prev.table_name,
            sysId: prev.sys_id,
            name: prevName,
            type: "removed",
            details: {
              class: String(prev.payload.sys_class_name || prev.table_name),
              parent: String(prev.payload.parent || ""),
              child: String(prev.payload.child || ""),
            },
          });
        }
      }
    }

    return Response.json({
      currentVersion,
      availableVersions,
      fromVersion,
      toVersion,
      hasBaseline: availableVersions.length > 1,
      totalCurrent: toRows.length,
      totalPrevious: fromRows.length,
      summary: {
        added: addedCount,
        modified: modifiedCount,
        unchanged: unchangedCount,
        removed: removedCount,
      },
      sampleDiffs: [...addedDiffs, ...modifiedDiffs, ...removedDiffs],
    });
  } catch (error) {
    return errorResponse(error);
  }
}
