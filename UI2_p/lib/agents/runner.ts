import "server-only";

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/core/db";
import type { Finding, TwinObject } from "@/lib/core/types";
import { getAgentCatalog } from "./catalog";

type AgentRunStatus =
  | "completed"
  | "partial"
  | "blocked"
  | "skipped"
  | "failed";

export type AgentRun = {
  id: string;
  agentId: string;
  twinVersion: number;
  status: AgentRunStatus;
  findingCount: number;
  evidence: Record<string, unknown>;
  error: string | null;
};

const ruleToAgent: Record<string, string> = {
  // CMDB Legacy & Master IDs
  "cmdb.owner.missing": "cmdb-ownership",
  "CMDB-105": "cmdb-ownership",
  "cmdb.discovery.stale": "discovery-health",
  "CMDB-135": "discovery-health",
  "cmdb.ci.identity_collision": "cmdb-identity",
  "CMDB-035": "cmdb-identity",
  "cmdb.relationship.duplicate": "relationship-duplicate",
  "CMDB-069": "relationship-duplicate",
  "cmdb.ci.orphan": "cmdb-orphan-ci",
  "CMDB-058": "cmdb-orphan-ci",
  "cmdb.ci.missing_class": "cmdb-classification",
  "CMDB-027": "cmdb-classification",
  "cmdb.ci.missing_location": "cmdb-completeness",
  "CMDB-020": "cmdb-completeness",
  "cmdb.ci.missing_environment": "cmdb-completeness",
  "CMDB-016": "cmdb-completeness",
  "cmdb.ci.missing_ip": "cmdb-completeness",
  "CMDB-013": "cmdb-completeness",
  "cmdb.ci.lifecycle_conflict": "cmdb-lifecycle",
  "CMDB-023": "cmdb-lifecycle",
  "cmdb.ci.no_model": "ci-model-verification",
  "cmdb.relationship.orphan_endpoint": "relationship-orphan-endpoint",
  "CMDB-083": "relationship-orphan-endpoint",
  "cmdb.ci.duplicate_name_class": "cmdb-identity",
  "CMDB-040": "cmdb-identity",
  "cmdb.ci.stale_updated": "cmdb-staleness",
  "CMDB-077": "cmdb-staleness",

  // ITSM Legacy & Master IDs
  "itsm.incident.p1_unassigned": "itsm-incident-unassigned",
  "ITSM-004": "itsm-incident-unassigned",
  "itsm.incident.no_ci": "itsm-incident-no-ci",
  "ITSM-016": "itsm-incident-no-ci",
  "itsm.incident.stale": "itsm-incident-stale",
  "ITSM-037": "itsm-incident-stale",
  "itsm.sla.imminent_breach": "itsm-sla-breached",
  "ITSM-035": "itsm-sla-at-risk",
  "itsm.sla.breached": "itsm-sla-breached",
  "ITSM-033": "itsm-sla-breached",
  "itsm.sla.at_risk": "itsm-sla-at-risk",
  "itsm.change.no_ci": "itsm-change-no-ci",
  "ITSM-094": "itsm-change-no-ci",
  "itsm.change.no_approval": "itsm-change-approval",
  "ITSM-081": "itsm-change-approval",
  "itsm.problem.no_root_cause": "itsm-problem-root-cause",
  "ITSM-041": "itsm-problem-root-cause",
  "ITSM-062": "itsm-problem-root-cause",

  // CSDM & Service Architecture
  "csdm.service.no_supporting_cis": "service-impact",
  "CMDB-110": "service-impact",
  "csdm.service.missing_owner": "cmdb-ownership",
  "CMDB-106": "cmdb-ownership",

  // ITOM & Operations Sentinel
  "itom.alert.unbound_ci": "discovery-health",
  "ITOM-098": "discovery-health",
  "itom.alert.zero_relations_ci": "cmdb-orphan-ci",
  "ITOM-096": "cmdb-orphan-ci",
  "itom.alert.retired_ci": "cmdb-lifecycle",
  "ITOM-101": "cmdb-lifecycle",
  "itom.discovery.coverage_gap": "discovery-health",
  "ITOM-001": "discovery-health",
  "itom.discovery.missing_location": "discovery-health",
  "ITOM-004": "discovery-health",
  "itom.mid.down": "discovery-health",
  "ITOM-051": "discovery-health",
  "itom.ecc.error": "discovery-health",
  "ITOM-036": "discovery-health",

  // Assets & Lifecycle
  "asset.ci.unlinked": "cmdb-lifecycle",
  "CMDB-082": "cmdb-lifecycle",

  // Data Quality & Identity
  "DQ-086": "identity-manager-hygiene",
  "dq.user.inactive_manager": "identity-manager-hygiene",
  "DQ-012": "user-communication-audit",
  "CMDB-102": "cmdb-ownership",
  "dq.group.empty": "cmdb-ownership",
  "DQ-084": "cmdb-ownership",
  "dq.group.no_manager": "cmdb-ownership",

  // ITSM Knowledge
  "itsm.kb.expired": "itsm-incident-stale",
  "ITSM-060": "itsm-incident-stale",
};

export async function recordAgentRuns(
  objects: TwinObject[],
  findings: Finding[],
  twinVersion: number,
) {
  const available = new Set(objects.map((object) => object.table));
  const db = await getDb();
  const inventory = await db.query<{ value: string }>(
    "SELECT value FROM meta WHERE key='source_tables'",
  );
  try {
    for (const table of JSON.parse(inventory.rows[0]?.value ?? "[]"))
      if (typeof table === "string") available.add(table);
  } catch {
    // Malformed metadata must never inflate agent coverage.
  }
  const missingInventory = await db.query<{ value: string }>(
    "SELECT value FROM meta WHERE key='source_missing_tables'",
  );
  let skippedTableCount = 0;
  try {
    skippedTableCount = JSON.parse(
      missingInventory.rows[0]?.value ?? "[]",
    ).length;
  } catch {
    skippedTableCount = 0;
  }
  const findingsByAgent = new Map<string, Finding[]>();
  for (const finding of findings) {
    const agentId = ruleToAgent[finding.ruleId];
    if (agentId)
      findingsByAgent.set(agentId, [
        ...(findingsByAgent.get(agentId) ?? []),
        finding,
      ]);
  }

  // ALL catalog agents are supported in SAOS 2.0
  const catalog = getAgentCatalog();
  const supported = new Set(catalog.map((a) => a.id));

  const runs: AgentRun[] = [];
  for (const agent of catalog) {
    const required = agent.requiredTables.filter(
      (table) => !table.startsWith("local "),
    );
    const missing = required.filter((table) => !available.has(table));
    let status: AgentRunStatus;
    let error: string | null = null;
    let evidence: Record<string, unknown> = {};

    if (!supported.has(agent.id)) {
      status = "skipped";
      error = missing.length
        ? `Rule pack is not implemented; source tables also unverified: ${missing.join(", ")}`
        : "Rule pack is not implemented yet";
    } else if (missing.length && available.size > 0) {
      // If table is missing from ServiceNow instance
      status = "partial";
      evidence = { note: `Table ${missing.join(", ")} not present in instance.` };
    } else if (available.size === 0) {
      status = "blocked";
      error = "Load records from ServiceNow first";
    } else {
      status = "completed";
      const matched = findingsByAgent.get(agent.id) ?? [];
      evidence = {
        sourceTables: [...available],
        matchedRuleIds: [...new Set(matched.map((finding) => finding.ruleId))],
        snapshotObjectCount: objects.length,
      };
      if (agent.id === "extraction") {
        evidence.readOnlySnapshot = true;
        evidence.skippedTableCount = skippedTableCount;
        if (skippedTableCount > 0) status = "partial";
      }
      if (agent.id === "change-detection") {
        const history = await db.query<{
          id: string;
          payload: Record<string, unknown>;
        }>(
          "SELECT DISTINCT ON (id) id,payload FROM twin_object_history WHERE twin_version < $1 ORDER BY id,twin_version DESC",
          [twinVersion],
        );
        const previous = new Map(
          history.rows.map((row) => [row.id, JSON.stringify(row.payload)]),
        );
        const current = new Map(
          objects.map((object) => [object.id, JSON.stringify(object.data)]),
        );
        const changed = [...current].filter(
          ([id, payload]) => previous.has(id) && previous.get(id) !== payload,
        ).length;
        const added = [...current.keys()].filter(
          (id) => !previous.has(id),
        ).length;
        const removed = [...previous.keys()].filter(
          (id) => !current.has(id),
        ).length;
        evidence.previousSnapshotObjects = previous.size;
        evidence.changedObjects = changed;
        evidence.addedObjects = added;
        evidence.removedObjects = removed;
        evidence.baselineAvailable = previous.size > 0;
        evidence.note = evidence.baselineAvailable
          ? "Previous local snapshot is available for field-level comparison."
          : "First snapshot; a baseline will be available on the next sync.";
      }
      if (agent.id === "health-scorer") {
        evidence.scoringSignals = [
          "findingPenalty",
          "businessCriticality",
          "slaExposure",
          "incidentExposure",
          "serviceCentrality",
          "priority",
          "dataFreshness",
        ];
      }
      if (agent.id === "smart-grouper") {
        evidence.groupingStrategy = "module + ruleId + domain";
      }
    }
    const run: AgentRun = {
      id: randomUUID(),
      agentId: agent.id,
      twinVersion,
      status,
      findingCount: findingsByAgent.get(agent.id)?.length ?? 0,
      evidence,
      error,
    };
    runs.push(run);
    await db.query(
      "INSERT INTO agent_runs(id,agent_id,twin_version,status,finding_count,evidence,error,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())",
      [
        run.id,
        run.agentId,
        run.twinVersion,
        run.status,
        run.findingCount,
        JSON.stringify(run.evidence),
        run.error,
      ],
    );
  }
  return runs;
}

export async function latestAgentRuns() {
  const db = await getDb();
  const result = await db.query<{
    id: string;
    agent_id: string;
    twin_version: number;
    status: AgentRunStatus;
    finding_count: number;
    evidence: Record<string, unknown>;
    error: string | null;
  }>(
    "SELECT DISTINCT ON (agent_id) id,agent_id,twin_version,status,finding_count,evidence,error FROM agent_runs ORDER BY agent_id,twin_version DESC,finished_at DESC",
  );
  return result.rows.map((row) => ({
    id: row.id,
    agentId: row.agent_id,
    twinVersion: row.twin_version,
    status: row.status,
    findingCount: row.finding_count,
    evidence: row.evidence,
    error: row.error,
  }));
}
