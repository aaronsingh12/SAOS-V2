
import type { Plan } from "./types";
import type { HealthScore } from "./scoring";
import { getMasterRule } from "@/lib/rules/catalog";

export type FixStrategy = "patch" | "delete" | "flag" | "merge";

export type FindingGroup = {
  id: string; // module:ruleId:domain
  module: "cmdb" | "itsm" | "csdm" | "itom" | "data quality" | "platform";
  ruleId: string;
  ruleTitle: string;
  domain: string;
  count: number;
  openCount: number;
  fixedCount: number;
  worstScore: number;
  plans: Plan[];
  fixStrategy: FixStrategy;
  targetTable: string;
  verificationStatus: "unverified" | "verified" | "fixing" | "fixed" | "rejected";
  summary: string;
};

const ruleMeta: Record<
  string,
  {
    title: string;
    fixStrategy: FixStrategy;
    targetTable: string;
    summary: string;
    module: "cmdb" | "itsm" | "csdm" | "itom" | "data quality" | "platform";
  }
> = {
  "cmdb.owner.missing": {
    title: "Blank Ownership Fields",
    fixStrategy: "patch",
    targetTable: "cmdb_ci",
    summary: "CIs with missing assigned_to, owned_by, managed_by, or support_group.",
    module: "cmdb",
  },
  "cmdb.discovery.stale": {
    title: "Stale Discovery (>90 Days)",
    fixStrategy: "patch",
    targetTable: "cmdb_ci",
    summary: "CIs not refreshed by discovery schedules or ITOM probes in over 90 days.",
    module: "itom",
  },
  "CMDB-016": {
    title: "Stale Discovery (>90 Days)",
    fixStrategy: "patch",
    targetTable: "cmdb_ci",
    summary: "CIs not refreshed by discovery schedules or ITOM probes in over 90 days.",
    module: "itom",
  },
  "CMDB-106": {
    title: "Services Missing Owner (CSDM 4.0)",
    fixStrategy: "patch",
    targetTable: "cmdb_ci_service",
    summary: "CSDM Business and Application Services lacking designated service ownership.",
    module: "csdm",
  },
  "csdm.service.missing_owner": {
    title: "Services Missing Owner (CSDM 4.0)",
    fixStrategy: "patch",
    targetTable: "cmdb_ci_service",
    summary: "CSDM Business and Application Services lacking designated service ownership.",
    module: "csdm",
  },
  "CMDB-110": {
    title: "Services With No Supporting CIs (CSDM 4.0)",
    fixStrategy: "patch",
    targetTable: "cmdb_ci_service",
    summary: "CSDM Services with no downstream supporting infrastructure or application CIs.",
    module: "csdm",
  },
  "csdm.service.no_supporting_cis": {
    title: "Services With No Supporting CIs (CSDM 4.0)",
    fixStrategy: "patch",
    targetTable: "cmdb_ci_service",
    summary: "CSDM Services with no downstream supporting infrastructure or application CIs.",
    module: "csdm",
  },
  "cmdb.ci.identity_collision": {
    title: "CI Identity Collisions",
    fixStrategy: "patch",
    targetTable: "cmdb_ci",
    summary: "Duplicate CIs sharing the same serial number, asset tag, or FQDN.",
    module: "cmdb",
  },
  "cmdb.relationship.duplicate": {
    title: "Duplicate Relationships",
    fixStrategy: "delete",
    targetTable: "cmdb_rel_ci",
    summary: "Redundant identical relationships between the same parent and child CIs.",
    module: "cmdb",
  },
  "cmdb.ci.orphan": {
    title: "Orphan CIs (Zero Relationships)",
    fixStrategy: "patch",
    targetTable: "cmdb_ci",
    summary: "Active infrastructure items isolated with no CMDB relationship connections.",
    module: "cmdb",
  },
  "cmdb.ci.missing_class": {
    title: "Unclassified CIs (Base Class)",
    fixStrategy: "patch",
    targetTable: "cmdb_ci",
    summary: "CIs stored under the generic 'cmdb_ci' base class without specialization.",
    module: "cmdb",
  },
  "cmdb.ci.missing_location": {
    title: "Missing Physical Location",
    fixStrategy: "patch",
    targetTable: "cmdb_ci",
    summary: "Physical server or network resources without recorded location.",
    module: "cmdb",
  },
  "cmdb.ci.lifecycle_conflict": {
    title: "Lifecycle State Conflicts",
    fixStrategy: "patch",
    targetTable: "cmdb_ci",
    summary: "CIs marked retired or decommissioned yet still flagged as operational.",
    module: "cmdb",
  },
  "cmdb.ci.no_model": {
    title: "Missing Hardware Models",
    fixStrategy: "patch",
    targetTable: "cmdb_ci",
    summary: "Hardware configuration items missing catalog model link.",
    module: "cmdb",
  },
  "cmdb.ci.missing_ip": {
    title: "Missing IP Addresses",
    fixStrategy: "patch",
    targetTable: "cmdb_ci",
    summary: "Active servers or network gear lacking an IP address record.",
    module: "cmdb",
  },
  "cmdb.relationship.orphan_endpoint": {
    title: "Orphan Relationship Endpoints",
    fixStrategy: "delete",
    targetTable: "cmdb_rel_ci",
    summary: "Relationships referencing missing or deleted CIs.",
    module: "cmdb",
  },
  "cmdb.ci.duplicate_name_class": {
    title: "Duplicate CI Name & Class",
    fixStrategy: "patch",
    targetTable: "cmdb_ci",
    summary: "Multiple active items sharing the exact same name and CI class.",
    module: "cmdb",
  },
  "cmdb.ci.missing_environment": {
    title: "Missing Environment Designation",
    fixStrategy: "patch",
    targetTable: "cmdb_ci",
    summary: "Production/staging servers without defined environment.",
    module: "cmdb",
  },
  "cmdb.ci.stale_updated": {
    title: "Unmodified / Stale Records (>180 Days)",
    fixStrategy: "patch",
    targetTable: "cmdb_ci",
    summary: "Active configuration items with no updates in 180 days.",
    module: "cmdb",
  },
  "itsm.incident.p1_unassigned": {
    title: "Unassigned High-Priority Incidents",
    fixStrategy: "patch",
    targetTable: "incident",
    summary: "Active P1/P2 incidents without assigned engineer or owner.",
    module: "itsm",
  },
  "itsm.incident.no_ci": {
    title: "Incidents Without Linked CI",
    fixStrategy: "patch",
    targetTable: "incident",
    summary: "Active incidents with blank cmdb_ci preventing outage correlation.",
    module: "itsm",
  },
  "itsm.incident.stale": {
    title: "Stale Active Incidents (>30 Days)",
    fixStrategy: "patch",
    targetTable: "incident",
    summary: "Incidents in active state without updates in over a month.",
    module: "itsm",
  },
  "itsm.sla.imminent_breach": {
    title: "Critical SLAs Imminent Breach (<5m / >95%)",
    fixStrategy: "patch",
    targetTable: "incident",
    summary: "Active SLAs within 5 minutes of breach or >95% elapsed duration.",
    module: "itsm",
  },
  "itsm.sla.breached": {
    title: "Breached SLAs",
    fixStrategy: "patch",
    targetTable: "incident",
    summary: "Tasks where SLA target commitments have failed.",
    module: "itsm",
  },
  "itsm.sla.at_risk": {
    title: "SLAs Approaching Breach (>80%)",
    fixStrategy: "patch",
    targetTable: "incident",
    summary: "Active SLAs with over 80% elapsed time requiring urgent resolution.",
    module: "itsm",
  },
  "itsm.change.no_ci": {
    title: "Changes Without Target CI",
    fixStrategy: "patch",
    targetTable: "change_request",
    summary: "Change requests lacking target CI, obstructing collision analysis.",
    module: "itsm",
  },
  "itsm.change.no_approval": {
    title: "Changes Advancing Without Approval",
    fixStrategy: "patch",
    targetTable: "change_request",
    summary: "Changes scheduled or implementing without recorded approved authorization.",
    module: "itsm",
  },
  "itsm.problem.no_root_cause": {
    title: "Problems Missing Root Cause",
    fixStrategy: "patch",
    targetTable: "problem",
    summary: "Open problem investigations lacking root cause CI or diagnostic notes.",
    module: "itsm",
  },
  "DQ-084": {
    title: "Empty Support Groups (No Active Manager)",
    fixStrategy: "patch",
    targetTable: "sys_user_group",
    summary: "Assignment groups with no assigned active manager or valid manager reference.",
    module: "data quality",
  },
  "dq.group.no_manager": {
    title: "Empty Support Groups (No Active Manager)",
    fixStrategy: "patch",
    targetTable: "sys_user_group",
    summary: "Assignment groups with no assigned active manager or valid manager reference.",
    module: "data quality",
  },
  "DQ-086": {
    title: "Users With Inactive Managers",
    fixStrategy: "patch",
    targetTable: "sys_user",
    summary: "Active user accounts assigned to inactive manager profiles, causing approval deadlocks.",
    module: "data quality",
  },
  "dq.user.inactive_manager": {
    title: "Users With Inactive Managers",
    fixStrategy: "patch",
    targetTable: "sys_user",
    summary: "Active user accounts assigned to inactive manager profiles, causing approval deadlocks.",
    module: "data quality",
  },
};

export function groupPlans(
  plans: Plan[],
  healthScores?: Record<string, HealthScore>,
): FindingGroup[] {
  const map = new Map<string, Plan[]>();

  for (const plan of plans) {
    const upper = plan.ruleId.toUpperCase();
    let module: "cmdb" | "itsm" | "csdm" | "itom" | "data quality" | "platform" = "cmdb";
    if (
      upper === "CMDB-106" ||
      upper === "CMDB-110" ||
      upper.startsWith("CSDM.") ||
      upper.startsWith("CSDM-") ||
      upper.startsWith("CSDM")
    ) {
      module = "csdm";
    } else if (
      upper === "CMDB-016" ||
      upper.startsWith("DISCOVERY.") ||
      upper.startsWith("ITOM.") ||
      upper.startsWith("ITOM-") ||
      upper.includes("DISCOVERY")
    ) {
      module = "itom";
    } else if (upper.startsWith("ITSM.") || upper.startsWith("ITSM-")) {
      module = "itsm";
    } else if (upper.startsWith("DQ.") || upper.startsWith("DQ-") || upper.startsWith("DQ")) {
      module = "data quality";
    } else if (upper.startsWith("PLT.") || upper.startsWith("PLT-") || upper.startsWith("SEC-")) {
      module = "platform";
    }

    const groupKey = `${module}:${plan.ruleId}:${plan.domain || "global"}`;
    const list = map.get(groupKey) ?? [];
    list.push(plan);
    map.set(groupKey, list);
  }

  const groups: FindingGroup[] = [];

  for (const [groupKey, groupPlans] of map.entries()) {
    const [module, ruleId, domain] = groupKey.split(":");
    const master = getMasterRule(ruleId);
    const meta = ruleMeta[ruleId] ?? {
      title: master?.title ? `[${ruleId}] ${master.title}` : ruleId,
      fixStrategy: (master?.remediationLane === 2 ? "patch" : "flag") as FixStrategy,
      targetTable:
        ruleId === "ITSM-033"
          ? "task_sla"
          : ruleId === "ITSM-094"
            ? "change_request"
            : ruleId === "DQ-084" || ruleId === "dq.group.no_manager"
              ? "sys_user_group"
              : ruleId === "DQ-086" || ruleId === "dq.user.inactive_manager"
                ? "sys_user"
                : ruleId === "CMDB-106" || ruleId === "CMDB-110" || ruleId.startsWith("csdm")
                  ? "cmdb_ci_service"
                  : module === "itsm"
                    ? "incident"
                    : master?.sourceTables?.split(",")[0]?.trim() || "cmdb_ci",
      summary: master?.whatItMeans || groupPlans[0]?.title || "Operational findings",
      module: (module as "cmdb" | "itsm" | "csdm" | "itom" | "data quality" | "platform"),
    };

    // Calculate worst score among entities in this group
    let worstScore = 100;
    if (healthScores) {
      for (const p of groupPlans) {
        // Extract sysId from targetId or evidence
        const sysId =
          String(p.evidence?.sysId ?? "") ||
          String(p.targetId.split(":")[1] ?? "");
        const taskSysId = String(p.evidence?.task ?? "");
        const entityScore = healthScores[sysId] || (taskSysId ? healthScores[taskSysId] : undefined);
        if (entityScore) {
          worstScore = Math.min(worstScore, entityScore.score);
        }
      }
    }

    // Determine baseline severity score for the rule.
    // Critical failures like Breached SLAs must NEVER look like healthy green (e.g. 75)!
    // They must be marked with a low score and highlighted in RED.
    let baselineScore: number;
    if (ruleId === "itsm.sla.breached" || ruleId === "ITSM-033") {
      baselineScore = 18; // Critical Red: Contract SLA Breached
    } else if (ruleId === "itsm.sla.imminent_breach" || ruleId === "ITSM-035") {
      baselineScore = 24; // Critical Red: Imminent SLA breach (<5 min)
    } else if (ruleId === "itsm.incident.p1_unassigned" || ruleId === "ITSM-004") {
      baselineScore = 25; // Critical Red: High priority incident unassigned
    } else if (
      ruleId === "cmdb.relationship.duplicate" ||
      ruleId === "cmdb.relationship.orphan_endpoint" ||
      ruleId === "CMDB-069" ||
      ruleId === "CMDB-083"
    ) {
      baselineScore = 35; // Critical/High Red: CMDB graph corruption
    } else if (ruleId.includes("no_ci") || ruleId.includes("missing_ci") || ruleId === "ITSM-016" || ruleId === "ITSM-094") {
      baselineScore = 40; // High Red/Amber: Outage correlation gap
    } else if (ruleId === "CMDB-058") {
      baselineScore = 38; // High Red/Amber: Principal orphan CI
    } else {
      const hasCritical = groupPlans.some((p) => p.risk === "Critical");
      const hasHigh = groupPlans.some((p) => p.risk === "High");
      const hasMedium = groupPlans.some((p) => p.risk === "Medium");
      baselineScore = hasCritical ? 20 : hasHigh ? 40 : hasMedium ? 60 : 75;
    }

    const unmitigatedScore = worstScore === 100 ? baselineScore : Math.min(worstScore, baselineScore);

    // Sort plans: Proposed & unapplied first at the top, Applied/Fixed at the bottom
    const openPlans = groupPlans.filter((p) => p.status !== "Applied" && p.status !== "Rejected");
    const fixedPlans = groupPlans.filter((p) => p.status === "Applied");
    const rejectedPlans = groupPlans.filter((p) => p.status === "Rejected");
    const sortedPlans = [...openPlans, ...fixedPlans, ...rejectedPlans];

    const openCount = openPlans.length;
    const fixedCount = fixedPlans.length;

    // Determine group verification status
    const allFixed = fixedCount === groupPlans.length && groupPlans.length > 0;
    const anyApproved = openPlans.some((p) => p.status === "Approved");
    const anyRejected = rejectedPlans.length === groupPlans.length && groupPlans.length > 0;

    let verificationStatus: FindingGroup["verificationStatus"] = "unverified";
    if (allFixed) verificationStatus = "fixed";
    else if (anyApproved) verificationStatus = "verified";
    else if (anyRejected) verificationStatus = "rejected";

    // Dynamic recovery: when all are fixed, score becomes 100; otherwise recovers proportionally
    const groupScore = allFixed
      ? 100
      : Math.min(
          100,
          Math.round(
            unmitigatedScore +
              (fixedCount / Math.max(1, groupPlans.length)) * (100 - unmitigatedScore),
          ),
        );

    groups.push({
      id: groupKey,
      module: meta.module,
      ruleId,
      ruleTitle: meta.title,
      domain: domain || "global",
      count: groupPlans.length,
      openCount,
      fixedCount,
      worstScore: groupScore,
      plans: sortedPlans,
      fixStrategy: meta.fixStrategy,
      targetTable: meta.targetTable,
      verificationStatus,
      summary: meta.summary,
    });
  }

  // Sort groups: worst score first, then highest count
  return groups.sort((a, b) => a.worstScore - b.worstScore || b.count - a.count);
}
