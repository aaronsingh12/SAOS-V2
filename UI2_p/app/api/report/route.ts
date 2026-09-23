import { getAgentRuntime } from "@/lib/agents/runtime";
import { getState } from "@/lib/core/workflow";
import { latestAgentRuns } from "@/lib/agents/runner";

export const dynamic = "force-dynamic";

export async function GET() {
  const [state, runtime, runs] = await Promise.all([
    getState(),
    getAgentRuntime(),
    latestAgentRuns(),
  ]);
  const runtimeTotals = runtime.agents.reduce<Record<string, number>>(
    (totals, agent) => {
      totals[agent.runtimeState] = (totals[agent.runtimeState] ?? 0) + 1;
      return totals;
    },
    {},
  );
  const riskUnknown = state.plans.filter(
    (plan) => plan.riskAssessment?.overall !== "Scored",
  ).length;
  return Response.json({
    generatedAt: new Date().toISOString(),
    verdict: runtime.coverageComplete
      ? "complete-for-loaded-scope"
      : "coverage-incomplete",
    source: {
      connected: state.connectionConfigured,
      host: state.sourceHost,
      twinVersion: state.twinVersion,
      objectCount: state.objectCount,
      tableCounts: state.tableCounts,
      verifiedTableCount: runtime.serviceNowTables.length,
      skippedTables: state.sourceMissingTables,
      skippedTableErrors: state.sourceTableErrors,
    },
    agents: {
      runtimeTotals,
      coverageComplete: runtime.coverageComplete,
      gaps: runtime.coverageGaps,
      latestRuns: runs,
    },
    findings: {
      open: state.plans.length,
      highPriority: state.plans.filter(
        (plan) => plan.risk === "High" || plan.risk === "Critical",
      ).length,
      riskPosture:
        state.plans.length === 0
          ? "no-open-findings"
          : riskUnknown
            ? "not-scored-impact-data-missing"
            : "scored",
    },
    audit: state.auditIntegrity,
    verification: {
      readOnlyConnector: false,
      connectorMode: "read-by-default; scoped-write-on-apply",
      productionWriteback: true,
      writebackScope: ["cmdb_rel_ci.delete_relationship"],
      writebackRequiresPreviewApproval: true,
      rollbackPayloadCaptured: true,
      llmCreatesFindings: false,
      incompleteCoreSnapshotsDiscarded: true,
      incompleteOptionalTablesExcludedAndReported: true,
    },
  });
}
