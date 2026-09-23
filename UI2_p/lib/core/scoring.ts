import "server-only";

import type { Finding, TwinObject } from "./types";
import { SEVERITY_WEIGHTS } from "./risk";

function computeFindingPenalty(findingsList: Finding[], maxCap = 45): number {
  let penaltySum = 0;
  for (const f of findingsList) {
    const risk = (f.risk || "Moderate") as keyof typeof SEVERITY_WEIGHTS;
    const weight = SEVERITY_WEIGHTS[risk] ?? 5;
    // Scale: Systemic(100) -> 35, Critical(40) -> 18, High(15) -> 9, Moderate(5) -> 3, Low(1) -> 1
    if (weight >= 100) penaltySum += 35;
    else if (weight >= 40) penaltySum += 18;
    else if (weight >= 15) penaltySum += 9;
    else if (weight >= 5) penaltySum += 3;
    else penaltySum += 1;
  }
  return Math.min(maxCap, penaltySum);
}

export type SignalBreakdown = {
  findingPenalty: number;
  businessCriticality: number;
  slaExposure: number;
  incidentExposure: number;
  serviceCentrality: number;
  priority: number;
  dataFreshness: number;
};

export type HealthScore = {
  entityId: string;
  entityType: "ci" | "incident" | "sla" | "change" | "problem";
  name: string;
  score: number; // 0-100 (100 = optimal, lower = worse)
  rank: number;
  signals: SignalBreakdown;
  findings: string[];
  module: "cmdb" | "itsm";
};

export type SystemHealthSummary = {
  cmdbHealthScore: number;
  itsmHealthScore: number;
  csdmHealthScore: number;
  itomHealthScore: number;
  dataQualityHealthScore: number;
  totalCIs: number;
  totalRelationships: number;
  totalIssues: number;
  fixedCount: number;
  worstItems: HealthScore[];
  scoresByEntity: Record<string, HealthScore>;
};

export function calculateHealthScores(
  objects: TwinObject[],
  findings: Finding[],
  fixedCount = 0,
): SystemHealthSummary {
  const cis = objects.filter((o) => o.table === "cmdb_ci");
  const rels = objects.filter((o) => o.table === "cmdb_rel_ci");
  const incidents = objects.filter((o) => o.table === "incident");
  const slas = objects.filter((o) => o.table === "task_sla");
  const changes = objects.filter((o) => o.table === "change_request");
  const problems = objects.filter((o) => o.table === "problem");

  // Build lookup maps
  const findingsByTargetId = new Map<string, Finding[]>();
  for (const f of findings) {
    const target = f.targetId;
    const list = findingsByTargetId.get(target) ?? [];
    list.push(f);
    findingsByTargetId.set(target, list);
  }

  // Cross-module maps:
  // CIs linked to incidents
  const incidentIdsByCiId = new Map<string, TwinObject[]>();
  for (const inc of incidents) {
    const ciId = String(inc.data.cmdb_ci ?? "").trim();
    if (ciId) {
      const list = incidentIdsByCiId.get(ciId) ?? [];
      list.push(inc);
      incidentIdsByCiId.set(ciId, list);
    }
  }

  // SLAs linked to task (incident / change)
  const breachedSlasByTaskId = new Map<string, TwinObject[]>();
  const criticalSlasByTaskId = new Map<string, TwinObject[]>();
  for (const sla of slas) {
    const isBreached = String(sla.data.has_breached ?? "").toLowerCase() === "true";
    const pct = parseFloat(String(sla.data.percentage ?? sla.data.business_percentage ?? "0"));
    const timeLeftStr = String(sla.data.time_left ?? sla.data.business_time_left ?? "");
    const plannedEndStr = String(sla.data.planned_end_time ?? sla.data.target ?? "");

    let is5MinImminent = pct >= 95;
    if (timeLeftStr) {
      const sec = parseFloat(timeLeftStr);
      if (!isNaN(sec) && !timeLeftStr.includes(":") && sec > 0 && sec <= 300) {
        is5MinImminent = true;
      }
      const match = timeLeftStr.match(/(?:(\d+):)?(\d+):(\d+)/);
      if (match) {
        const hours = parseInt(match[1] || "0", 10);
        const mins = parseInt(match[2] || "0", 10);
        if (hours === 0 && mins <= 5) is5MinImminent = true;
      }
    }
    if (plannedEndStr) {
      const diff = Date.parse(plannedEndStr.replace(" ", "T")) - Date.now();
      if (diff > 0 && diff <= 5 * 60 * 1000) {
        is5MinImminent = true;
      }
    }

    const taskId = String(sla.data.task ?? "").trim();
    if (taskId) {
      if (isBreached) {
        const list = breachedSlasByTaskId.get(taskId) ?? [];
        list.push(sla);
        breachedSlasByTaskId.set(taskId, list);
      }
      if (isBreached || is5MinImminent) {
        const list = criticalSlasByTaskId.get(taskId) ?? [];
        list.push(sla);
        criticalSlasByTaskId.set(taskId, list);
      }
    }
  }

  // Centrality: relationship counts per CI
  const relationshipCountByCi = new Map<string, number>();
  for (const r of rels) {
    const p = String(r.data.parent ?? "").trim();
    const c = String(r.data.child ?? "").trim();
    if (p) relationshipCountByCi.set(p, (relationshipCountByCi.get(p) ?? 0) + 1);
    if (c) relationshipCountByCi.set(c, (relationshipCountByCi.get(c) ?? 0) + 1);
  }

  const scores: HealthScore[] = [];

  // Score CIs
  for (const ci of cis) {
    const ciFindings = findingsByTargetId.get(ci.id) ?? [];
    const entityName = String(ci.data.name || ci.data.short_description || ci.sysId).trim();

    // 1. Finding penalty (derived from 755 Master Rules weights: Systemic, Critical, High, Moderate, Low)
    const findingPenalty = computeFindingPenalty(ciFindings, 40);

    // 2. Business Criticality (up to 20)
    const crit = String(
      ci.data.business_criticality || ci.data.service_criticality || "",
    ).toLowerCase();
    let businessCriticality = 0;
    if (crit.includes("1") || crit.includes("critical") || crit.includes("high")) {
      businessCriticality = ciFindings.length > 0 ? 20 : 0;
    } else if (crit.includes("2") || crit.includes("medium")) {
      businessCriticality = ciFindings.length > 0 ? 10 : 0;
    }

    // 3. SLA Exposure (up to 25)
    // Check if any linked incident has a breached or imminent SLA breach (<5m)
    const linkedIncs = incidentIdsByCiId.get(ci.sysId) ?? incidentIdsByCiId.get(ci.id) ?? [];
    let hasCriticalSla = false;
    for (const inc of linkedIncs) {
      const num = String(inc.data.number ?? "").trim();
      if (
        criticalSlasByTaskId.has(inc.sysId) ||
        (num && criticalSlasByTaskId.has(num)) ||
        breachedSlasByTaskId.has(inc.sysId) ||
        (num && breachedSlasByTaskId.has(num))
      ) {
        hasCriticalSla = true;
        break;
      }
    }
    const slaExposure = hasCriticalSla ? 25 : 0;

    // 4. Incident Exposure (up to 10)
    let hasP1Inc = false;
    let hasP2Inc = false;
    for (const inc of linkedIncs) {
      const p = String(inc.data.priority ?? "");
      if (p === "1") hasP1Inc = true;
      if (p === "2") hasP2Inc = true;
    }
    const incidentExposure = hasP1Inc ? 10 : hasP2Inc ? 6 : 0;

    // 5. Service Centrality (up to 10)
    const relCount = relationshipCountByCi.get(ci.sysId) ?? 0;
    const serviceCentrality = relCount > 10 ? 10 : relCount > 4 ? 5 : 0;

    // 6. Priority (CIs don't have priority field, so 0)
    const priority = 0;

    // 7. Data Freshness (up to 5)
    let dataFreshness = 0;
    const disc = String(ci.data.last_discovered ?? "");
    if (disc) {
      const t = Date.parse(disc.replace(" ", "T"));
      if (!isNaN(t) && Date.now() - t > 90 * 86400_000) {
        dataFreshness = 5;
      }
    } else {
      dataFreshness = 3;
    }

    const totalDeduction =
      findingPenalty +
      businessCriticality +
      slaExposure +
      incidentExposure +
      serviceCentrality +
      priority +
      dataFreshness;

    const score = Math.max(0, Math.min(100, Math.round(100 - totalDeduction)));

    scores.push({
      entityId: ci.sysId,
      entityType: "ci",
      name: entityName,
      score,
      rank: 0,
      signals: {
        findingPenalty,
        businessCriticality,
        slaExposure,
        incidentExposure,
        serviceCentrality,
        priority,
        dataFreshness,
      },
      findings: ciFindings.map((f) => f.title),
      module: "cmdb",
    });
  }

  // Score Incidents
  for (const inc of incidents) {
    const incFindings = findingsByTargetId.get(inc.id) ?? [];
    const entityName = String(inc.data.number || inc.data.short_description || inc.sysId).trim();
    const incNum = String(inc.data.number ?? "").trim();

    // Also associate findings from SLAs attached to this incident
    const attachedSlas = slas.filter(
      (s) =>
        String(s.data.task ?? "").trim() === inc.sysId ||
        (incNum && String(s.data.task ?? "").trim() === incNum),
    );
    for (const sla of attachedSlas) {
      const slaFindings = findingsByTargetId.get(sla.id) ?? [];
      for (const sf of slaFindings) {
        if (!incFindings.some((f) => f.id === sf.id)) {
          incFindings.push(sf);
        }
      }
    }

    // Finding penalty derived from 755 Master Rules weights
    const findingPenalty = computeFindingPenalty(incFindings, 45);

    const isBreached =
      breachedSlasByTaskId.has(inc.sysId) ||
      (Boolean(incNum) && breachedSlasByTaskId.has(incNum));
    const hasCriticalSla =
      criticalSlasByTaskId.has(inc.sysId) ||
      (Boolean(incNum) && criticalSlasByTaskId.has(incNum));

    // SLA Exposure: 40 points penalty if SLA is breached or in imminent breach (<5m)
    const slaExposure = isBreached || hasCriticalSla ? 40 : 0;

    const prioVal = String(inc.data.priority ?? "");
    const priority = prioVal === "1" ? 25 : prioVal === "2" ? 15 : prioVal === "3" ? 10 : 5;

    const totalDeduction = findingPenalty + slaExposure + priority;
    const score = Math.max(0, Math.min(100, Math.round(100 - totalDeduction)));

    scores.push({
      entityId: inc.sysId,
      entityType: "incident",
      name: entityName,
      score,
      rank: 0,
      signals: {
        findingPenalty,
        businessCriticality: 0,
        slaExposure,
        incidentExposure: 0,
        serviceCentrality: 0,
        priority,
        dataFreshness: 0,
      },
      findings: incFindings.map((f) => f.title),
      module: "itsm",
    });
  }

  // Score SLAs directly
  for (const sla of slas) {
    const slaFindings = findingsByTargetId.get(sla.id) ?? [];
    if (slaFindings.length === 0) continue;

    const isBreached = String(sla.data.has_breached ?? "").toLowerCase() === "true";
    const pct = parseFloat(String(sla.data.percentage ?? sla.data.business_percentage ?? "0"));
    const timeLeftStr = String(sla.data.time_left ?? sla.data.business_time_left ?? "");
    let isImminent = pct >= 95 || slaFindings.some((f) => f.ruleId === "itsm.sla.imminent_breach");
    if (timeLeftStr) {
      const sec = parseFloat(timeLeftStr);
      if (!isNaN(sec) && !timeLeftStr.includes(":") && sec > 0 && sec <= 300) isImminent = true;
    }

    const taskLabel = String(sla.data.task || sla.sysId).trim();
    const entityName = `SLA: ${String(sla.data.sla || "Resolution").trim()} (${taskLabel})`;

    let findingPenalty = 0;
    for (const f of slaFindings) {
      if (f.risk === "Critical") findingPenalty += 40;
      else if (f.risk === "High") findingPenalty += 25;
      else findingPenalty += 10;
    }
    findingPenalty = Math.min(50, findingPenalty);

    const priority = isBreached ? 45 : isImminent ? 38 : 15;
    const totalDeduction = findingPenalty + priority;
    const score = Math.max(0, Math.min(100, Math.round(100 - totalDeduction)));

    scores.push({
      entityId: sla.sysId,
      entityType: "sla",
      name: entityName,
      score,
      rank: 0,
      signals: {
        findingPenalty,
        businessCriticality: 0,
        slaExposure: isBreached ? 40 : isImminent ? 35 : 10,
        incidentExposure: 0,
        serviceCentrality: 0,
        priority,
        dataFreshness: 0,
      },
      findings: slaFindings.map((f) => f.title),
      module: "itsm",
    });
  }

  // Score Changes
  for (const chg of changes) {
    const chgFindings = findingsByTargetId.get(chg.id) ?? [];
    const entityName = String(chg.data.number || chg.data.short_description || chg.sysId).trim();

    const findingPenalty = computeFindingPenalty(chgFindings, 40);
    const prioVal = String(chg.data.priority ?? "");
    const priority = prioVal === "1" ? 20 : prioVal === "2" ? 12 : 5;

    const totalDeduction = findingPenalty + priority;
    const score = Math.max(0, Math.min(100, Math.round(100 - totalDeduction)));

    scores.push({
      entityId: chg.sysId,
      entityType: "change",
      name: entityName,
      score,
      rank: 0,
      signals: {
        findingPenalty,
        businessCriticality: 0,
        slaExposure: 0,
        incidentExposure: 0,
        serviceCentrality: 0,
        priority,
        dataFreshness: 0,
      },
      findings: chgFindings.map((f) => f.title),
      module: "itsm",
    });
  }

  // Score Problems
  for (const prb of problems) {
    const prbFindings = findingsByTargetId.get(prb.id) ?? [];
    const entityName = String(prb.data.number || prb.data.short_description || prb.sysId).trim();

    const findingPenalty = computeFindingPenalty(prbFindings, 40);
    const prioVal = String(prb.data.priority ?? "");
    const priority = prioVal === "1" ? 20 : prioVal === "2" ? 12 : 5;

    const totalDeduction = findingPenalty + priority;
    const score = Math.max(0, Math.min(100, Math.round(100 - totalDeduction)));

    scores.push({
      entityId: prb.sysId,
      entityType: "problem",
      name: entityName,
      score,
      rank: 0,
      signals: {
        findingPenalty,
        businessCriticality: 0,
        slaExposure: 0,
        incidentExposure: 0,
        serviceCentrality: 0,
        priority,
        dataFreshness: 0,
      },
      findings: prbFindings.map((f) => f.title),
      module: "itsm",
    });
  }

  // Sort by lowest score (worst first)
  scores.sort((a, b) => a.score - b.score);
  scores.forEach((s, idx) => {
    s.rank = idx + 1;
  });

  const scoresByEntity: Record<string, HealthScore> = {};
  for (const s of scores) {
    scoresByEntity[s.entityId] = s;
  }

  const cmdbScores = scores.filter((s) => s.module === "cmdb");
  const itsmScores = scores.filter((s) => s.module === "itsm");

  const cmdbHealthScore = cmdbScores.length
    ? Math.round(cmdbScores.reduce((sum, s) => sum + s.score, 0) / cmdbScores.length)
    : 100;

  const itsmHealthScore = itsmScores.length
    ? Math.round(itsmScores.reduce((sum, s) => sum + s.score, 0) / itsmScores.length)
    : 100;

  // CSDM Health: based on Service CIs and CSDM compliance findings (CMDB-106, CMDB-110)
  const csdmFindings = findings.filter(
    (f) =>
      f.ruleId === "CMDB-106" ||
      f.ruleId === "CMDB-110" ||
      f.ruleId.toLowerCase().startsWith("csdm"),
  );
  const serviceCount = objects.filter((o) => o.table === "cmdb_ci_service").length;
  const csdmHealthScore = Math.max(
    30,
    Math.min(
      100,
      100 -
        computeFindingPenalty(csdmFindings, 50) -
        (serviceCount > 0 ? Math.round((csdmFindings.length / serviceCount) * 40) : 0),
    ),
  );

  // ITOM Health: based on Discovery staleness and telemetry findings (CMDB-016, ITOM-*)
  const itomFindings = findings.filter(
    (f) =>
      f.ruleId === "CMDB-016" ||
      f.ruleId.toLowerCase().includes("discovery") ||
      f.ruleId.toLowerCase().startsWith("itom"),
  );
  const itomHealthScore = Math.max(
    35,
    Math.min(100, 100 - computeFindingPenalty(itomFindings, 45)),
  );

  // Data Quality Health: based on Foundation identity, manager & group governance findings (DQ-084, DQ-086)
  const dqFindings = findings.filter(
    (f) =>
      f.ruleId.startsWith("DQ") ||
      f.ruleId.toLowerCase().includes("manager") ||
      f.ruleId.toLowerCase().includes("group"),
  );
  const dqHealthScore = Math.max(
    40,
    Math.min(100, 100 - computeFindingPenalty(dqFindings, 40)),
  );

  // Worst items: filter to those with findings or score < 80
  const worstItems = scores.filter((s) => s.findings.length > 0 || s.score < 80).slice(0, 10);

  return {
    cmdbHealthScore,
    itsmHealthScore,
    csdmHealthScore,
    itomHealthScore,
    dataQualityHealthScore: dqHealthScore,
    totalCIs: cis.length,
    totalRelationships: rels.length,
    totalIssues: findings.length,
    fixedCount,
    worstItems,
    scoresByEntity,
  };
}
