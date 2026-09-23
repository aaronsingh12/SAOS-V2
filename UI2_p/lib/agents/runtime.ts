import "server-only";

import { getDb } from "@/lib/core/db";
import { getAgentCatalog } from "./catalog";
import type { AgentStatus, AgentModule } from "./catalog";

export type AgentRuntimeState =
  | "ready"
  | "partial"
  | "blocked"
  | "planned"
  | "not_applicable";

export type AgentRuntime = {
  id: string;
  name: string;
  className: string;
  module: AgentModule;
  catalogStatus: AgentStatus;
  runtimeState: AgentRuntimeState;
  availableTables: string[];
  missingTables: string[];
  message: string;
};

export async function getAgentRuntime() {
  const db = await getDb();
  const tableRows = await db.query<{ table_name: string }>(
    "SELECT DISTINCT table_name FROM twin_objects ORDER BY table_name",
  );
  const hasLocalTwin = tableRows.rows.length > 0;
  const available = new Set(tableRows.rows.map((row) => row.table_name));

  const sourceTablesRow = await db.query<{ value: string }>(
    "SELECT value FROM meta WHERE key='source_tables'",
  );
  try {
    for (const table of JSON.parse(sourceTablesRow.rows[0]?.value ?? "[]"))
      if (typeof table === "string") available.add(table);
  } catch {
    // A malformed inventory must not crash the status screen.
  }

  const missingTablesRow = await db.query<{ value: string }>(
    "SELECT value FROM meta WHERE key='source_missing_tables'",
  );
  const sourceMissing = new Set<string>();
  try {
    for (const table of JSON.parse(missingTablesRow.rows[0]?.value ?? "[]"))
      if (typeof table === "string") sourceMissing.add(table);
  } catch {
    // A malformed inventory is reported as unavailable below.
  }

  let serviceNowTables: string[] = [];
  if (sourceTablesRow.rows[0]?.value) {
    try {
      serviceNowTables = JSON.parse(sourceTablesRow.rows[0].value);
    } catch {
      serviceNowTables = [];
    }
  }

  const findings = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM findings WHERE status='Open'",
  );

  const agents: AgentRuntime[] = getAgentCatalog().map((agent) => {
    const sourceTables = agent.requiredTables.filter(
      (table) => !table.startsWith("local "),
    );
    const missingTables = sourceTables.filter((table) => !available.has(table));
    const availableTables = sourceTables.filter((table) =>
      available.has(table),
    );

    let runtimeState: AgentRuntimeState = agent.status;
    let message = agent.note;

    if (!hasLocalTwin) {
      runtimeState = "blocked";
      message = "Load ServiceNow records to activate this agent.";
    } else if (agent.id === "extraction") {
      runtimeState = sourceMissing.size > 0 ? "partial" : "ready";
      message =
        sourceMissing.size > 0
          ? `${serviceNowTables.length} tables verified, ${sourceMissing.size} optional tables were not found.`
          : "All configured source tables verified in local twin.";
    } else if (
      agent.id === "health-scorer" ||
      agent.id === "smart-grouper" ||
      agent.id === "fix-applier" ||
      agent.id === "llm-consultant" ||
      agent.id === "update-set-synthesizer"
    ) {
      runtimeState = "ready";
      message = agent.note;
    } else if (missingTables.length) {
      runtimeState = "partial";
      message = `Operating on available records; optional table ${missingTables.join(", ")} was not present on this instance.`;
    } else {
      runtimeState = "ready";
      message = agent.note;
    }

    return {
      id: agent.id,
      name: agent.name,
      className: agent.className,
      module: agent.module,
      catalogStatus: agent.status,
      runtimeState,
      availableTables,
      missingTables,
      message,
    };
  });

  const coverageGaps = agents
    .filter(
      (agent) =>
        agent.runtimeState === "blocked" ||
        agent.runtimeState === "planned" ||
        agent.runtimeState === "partial",
    )
    .map((agent) => `${agent.name}: ${agent.message}`);

  return {
    agents,
    availableTables: [...available],
    serviceNowTables,
    twinHasData: hasLocalTwin,
    openFindingCount: Number(findings.rows[0]?.count ?? 0),
    coverageComplete: coverageGaps.length === 0,
    coverageGaps,
  };
}
