import "server-only";

import { createHash } from "node:crypto";
import { appendAuditTx } from "./audit";
import { getDb, getTwinVersion } from "./db";
import { getConnectionConfig } from "./connection";
import type { Finding, TwinObject } from "./types";
import { assessRisk } from "./risk";
import { recordAgentRuns } from "@/lib/agents/runner";
import { calculateHealthScores } from "./scoring";
import { getMasterRule } from "@/lib/rules/catalog";
import { generateServiceNowUpdateSetXml } from "./update-set-generator";
import { getAiProviderStatus } from "@/lib/ai/provider";
import { consultLlmForScanAudit, type FindingClusterSummary } from "@/lib/ai/local";

const RULE_VERSION = "2.0.0";

export const RULE_ID_MAP: Record<string, string> = {
  "cmdb.owner.missing": "CMDB-105",
  "cmdb.discovery.stale": "CMDB-135",
  "cmdb.ci.identity_collision": "CMDB-035",
  "cmdb.relationship.duplicate": "CMDB-069",
  "cmdb.ci.orphan": "CMDB-058",
  "cmdb.ci.missing_class": "CMDB-027",
  "cmdb.ci.missing_location": "CMDB-020",
  "cmdb.ci.missing_environment": "CMDB-016",
  "cmdb.ci.missing_ip": "CMDB-013",
  "cmdb.ci.lifecycle_conflict": "CMDB-023",
  "cmdb.ci.no_model": "DQ-086",
  "cmdb.relationship.orphan_endpoint": "CMDB-083",
  "cmdb.ci.duplicate_name_class": "CMDB-040",
  "cmdb.ci.stale_updated": "CMDB-077",
  "itsm.incident.p1_unassigned": "ITSM-004",
  "itsm.incident.no_ci": "ITSM-016",
  "itsm.incident.stale": "ITSM-037",
  "itsm.sla.imminent_breach": "ITSM-035",
  "itsm.sla.breached": "ITSM-033",
  "itsm.sla.at_risk": "ITSM-033",
  "itsm.change.no_ci": "ITSM-094",
  "itsm.change.no_approval": "ITSM-081",
  "itsm.problem.no_root_cause": "ITSM-062",
  "csdm.service.no_supporting_cis": "CMDB-110",
  "csdm.service.missing_owner": "CMDB-106",
  "itom.alert.unbound_ci": "ITOM-098",
  "itom.alert.zero_relations_ci": "ITOM-096",
  "itom.alert.retired_ci": "ITOM-101",
  "itom.discovery.coverage_gap": "ITOM-001",
  "itom.discovery.missing_location": "ITOM-004",
  "itom.mid.down": "ITOM-051",
  "itom.ecc.error": "ITOM-036",
  "asset.ci.unlinked": "CMDB-082",
  "dq.group.empty": "CMDB-102",
  "dq.group.no_manager": "DQ-084",
  "dq.user.inactive_manager": "DQ-086",
  "itsm.kb.expired": "ITSM-060",
};

const idFor = (rule: string, domain: string, target: string) =>
  createHash("sha256")
    .update(`${rule}:${domain}:${target}`)
    .digest("hex")
    .slice(0, 24);

const value = (data: Record<string, unknown>, key: string) =>
  String(data[key] ?? "").trim();

export function evaluateTwin(
  objects: TwinObject[],
  twinVersion: number,
  now = new Date(),
): Finding[] {
  const findings: Finding[] = [];
  const byDomain = new Map<string, TwinObject[]>();

  for (const object of objects) {
    const scoped = byDomain.get(object.domain);
    if (scoped) scoped.push(object);
    else byDomain.set(object.domain, [object]);
  }

  const push = (
    ruleId: string,
    object: TwinObject,
    title: string,
    explanation: string,
    evidence: Record<string, unknown>,
    risk: Finding["risk"],
    confidence: number,
    lane: Finding["lane"],
    suggestedAfter: Record<string, unknown> | null,
    approvalRequired = false,
    requiredEvidence: string[] = [],
    module: Finding["module"] = ruleId.startsWith("itsm.") ? "itsm" : "cmdb",
  ) => {
    const riskAssessment = assessRisk(risk, object, evidence, requiredEvidence);
    const masterRuleId = RULE_ID_MAP[ruleId] || ruleId;
    const master = getMasterRule(masterRuleId);
    const whatItMeans = master?.whatItMeans;
    const whyItMatters = master?.whyItMatters;
    const falsePositiveGuard = master?.falsePositiveGuard;
    const crossDomainLink = master?.crossDomainLink;
    const sourceTables = master?.sourceTables || object.table;
    const effectiveLane = (master?.remediationLane ?? lane) as Finding["lane"];
    const effectiveModule = master
      ? (master.domain.toLowerCase().replace(" ", "-") as Finding["module"])
      : module;

    findings.push({
      id: idFor(ruleId, object.domain, object.id),
      ruleId: masterRuleId,
      ruleVersion: RULE_VERSION,
      domain: object.domain,
      targetId: object.id,
      title: master?.title ? `[${masterRuleId}] ${master.title}` : title,
      explanation: master?.whatItMeans || explanation,
      evidence,
      confidence: riskAssessment.confidence.score,
      risk: riskAssessment.severity,
      lane: effectiveLane,
      suggestedAfter,
      approvalRequired,
      twinVersion,
      riskAssessment,
      module: effectiveModule,
      whatItMeans,
      whyItMatters,
      falsePositiveGuard,
      crossDomainLink,
      sourceTables,
    });
  };

  for (const [domain, scoped] of byDomain) {
    const cis = scoped.filter((o) => o.table === "cmdb_ci");
    const relationships = scoped.filter((o) => o.table === "cmdb_rel_ci");
    const ciIds = new Set(cis.map((o) => o.sysId));

    // Maps for fast relation lookup
    const ciRelCount = new Map<string, number>();
    const relationKeys = new Map<string, TwinObject[]>();

    for (const rel of relationships) {
      const parent = value(rel.data, "parent");
      const child = value(rel.data, "child");
      const type = value(rel.data, "type");
      const key = `${parent}:${child}:${type}`;

      relationKeys.set(key, [...(relationKeys.get(key) ?? []), rel]);

      if (parent) ciRelCount.set(parent, (ciRelCount.get(parent) ?? 0) + 1);
      if (child) ciRelCount.set(child, (ciRelCount.get(child) ?? 0) + 1);

      // Rule 11: cmdb.relationship.orphan_endpoint
      const parentExists = !parent || ciIds.has(parent);
      const childExists = !child || ciIds.has(child);
      if (!parentExists || !childExists) {
        push(
          "cmdb.relationship.orphan_endpoint",
          rel,
          `Relationship has missing CI endpoint: ${rel.sysId}`,
          "This relationship references a parent or child CI that does not exist in the CMDB snapshot. Removing or correcting orphan relationships prevents broken topology paths.",
          {
            sysId: rel.sysId,
            parent,
            child,
            type,
            missingEndpoint: !parentExists && !childExists ? "both" : !parentExists ? "parent" : "child",
          },
          "Medium",
          95,
          1,
          { action: "delete_relationship", sysId: rel.sysId },
          true,
          ["sysId", "parent", "child", "type"],
          "cmdb",
        );
      }
    }

    // Rule 4: cmdb.relationship.duplicate
    for (const group of relationKeys.values()) {
      if (group.length > 1) {
        for (const rel of group.slice(1)) {
          if (
            ciIds.has(value(rel.data, "parent")) &&
            ciIds.has(value(rel.data, "child"))
          ) {
            push(
              "cmdb.relationship.duplicate",
              rel,
              `Repeated relationship: ${rel.sysId}`,
              "Two records have the same source, destination, and relationship type in this domain. Review both records before removing duplicate.",
              {
                canonicalSysId: group[0].sysId,
                duplicateSysId: rel.sysId,
                parent: value(rel.data, "parent"),
                child: value(rel.data, "child"),
                domain,
              },
              "High",
              100,
              1,
              { action: "delete_relationship", sysId: rel.sysId },
              true,
              ["canonicalSysId", "duplicateSysId", "parent", "child", "domain"],
              "cmdb",
            );
          }
        }
      }
    }

    // Identity collisions and duplicate name+class
    const identityGroups = new Map<
      string,
      { field: string; value: string; objects: TwinObject[] }
    >();
    const nameClassGroups = new Map<string, TwinObject[]>();

    // ----------------- CMDB CI CHECKS -----------------
    for (const ci of cis) {
      const name = value(ci.data, "name");
      const className = value(ci.data, "sys_class_name").toLowerCase();
      const activeVal = value(ci.data, "active").toLowerCase();
      const isActive = activeVal !== "false" && activeVal !== "0";

      // Group for Rule 3: Identity collisions (serial, asset_tag, fqdn)
      for (const field of ["serial_number", "asset_tag", "fqdn"]) {
        const identity = value(ci.data, field).toLowerCase();
        if (!className || !identity) continue;
        const key = `${className}:${field}:${identity}`;
        const group = identityGroups.get(key) ?? {
          field,
          value: identity,
          objects: [],
        };
        group.objects.push(ci);
        identityGroups.set(key, group);
        break;
      }

      // Group for Rule 12: Duplicate name + class
      if (name && className && isActive) {
        const nameClassKey = `${className}:::${name.toLowerCase()}`;
        const group = nameClassGroups.get(nameClassKey) ?? [];
        group.push(ci);
        nameClassGroups.set(nameClassKey, group);
      }

      // Rule 1: cmdb.owner.missing
      const ownerFields = [
        "assigned_to",
        "owned_by",
        "managed_by",
        "support_group",
      ];
      if (
        ownerFields.every((field) => Object.hasOwn(ci.data, field)) &&
        ownerFields.every((field) => !value(ci.data, field))
      ) {
        push(
          "cmdb.owner.missing",
          ci,
          `Ownership fields blank: ${name || ci.sysId}`,
          "All inspected ownership fields are blank. Assign an accountable individual or support group in ServiceNow.",
          { sysId: ci.sysId, name, inspectedFields: ownerFields },
          "Medium",
          100,
          3,
          { action: "patch_record", table: "cmdb_ci", sysId: ci.sysId, fields: { assigned_to: "", support_group: "" } },
          false,
          ["sysId", "inspectedFields"],
          "cmdb",
        );
      }

      // Rule 2: cmdb.discovery.stale
      const discovered = value(ci.data, "last_discovered");
      const timestamp = Date.parse(
        discovered.replace(" ", "T") + (discovered.includes("Z") ? "" : "Z"),
      );
      if (
        discovered &&
        Number.isFinite(timestamp) &&
        now.getTime() - timestamp > 90 * 86400_000
      ) {
        push(
          "cmdb.discovery.stale",
          ci,
          `Stale discovery date (>90 days): ${name || ci.sysId}`,
          "The source reports no discovery in more than 90 days. Check whether this CI is still active or needs re-discovery.",
          {
            sysId: ci.sysId,
            name,
            lastDiscovered: discovered,
            ageDays: Math.floor((now.getTime() - timestamp) / 86400_000),
            thresholdDays: 90,
          },
          "Medium",
          100,
          3,
          null,
          false,
          ["lastDiscovered", "ageDays", "thresholdDays"],
          "cmdb",
        );
      }

      // Rule 5: cmdb.ci.orphan (zero relationships)
      if (isActive && (ciRelCount.get(ci.sysId) ?? 0) === 0) {
        push(
          "cmdb.ci.orphan",
          ci,
          `Orphan CI with zero relationships: ${name || ci.sysId}`,
          "This active configuration item has no incoming or outgoing relationships in the CMDB. Orphan CIs undermine dependency mapping and root-cause isolation.",
          {
            sysId: ci.sysId,
            name,
            className: value(ci.data, "sys_class_name"),
            relationshipCount: 0,
          },
          "Medium",
          90,
          2,
          null,
          false,
          ["sysId", "name", "relationshipCount"],
          "cmdb",
        );
      }

      // Rule 6: cmdb.ci.missing_class
      const rawClass = value(ci.data, "sys_class_name");
      if (!rawClass || rawClass.toLowerCase() === "cmdb_ci") {
        push(
          "cmdb.ci.missing_class",
          ci,
          `Unclassified or base CMDB CI: ${name || ci.sysId}`,
          "Record is classified as generic base 'cmdb_ci' without specific model/hardware/software specialization.",
          {
            sysId: ci.sysId,
            name,
            currentClass: rawClass || "(empty)",
          },
          "Medium",
          95,
          2,
          { action: "patch_record", table: "cmdb_ci", sysId: ci.sysId, fields: { sys_class_name: "" } },
          false,
          ["sysId", "currentClass"],
          "cmdb",
        );
      }

      // Rule 7: cmdb.ci.missing_location
      const isHardwareOrServer =
        className.includes("server") ||
        className.includes("hardware") ||
        className.includes("computer") ||
        className.includes("network");
      if (isHardwareOrServer && !value(ci.data, "location")) {
        push(
          "cmdb.ci.missing_location",
          ci,
          `Missing physical location: ${name || ci.sysId}`,
          "Infrastructure CI has no location specified. Physical and data-center resources must have a recorded location.",
          {
            sysId: ci.sysId,
            name,
            className: value(ci.data, "sys_class_name"),
          },
          "Low",
          85,
          3,
          { action: "patch_record", table: "cmdb_ci", sysId: ci.sysId, fields: { location: "" } },
          false,
          ["sysId", "name"],
          "cmdb",
        );
      }

      // Rule 8: cmdb.ci.lifecycle_conflict
      const opStatus = value(ci.data, "operational_status");
      const instStatus = value(ci.data, "install_status");
      // 1 = Operational, 7/8 = Retired / Decommissioned
      const isRetiredInstall = instStatus === "7" || instStatus === "8" || instStatus.toLowerCase() === "retired";
      const isOperationalOp = opStatus === "1" || opStatus.toLowerCase() === "operational";
      if (isRetiredInstall && isOperationalOp) {
        push(
          "cmdb.ci.lifecycle_conflict",
          ci,
          `Lifecycle contradiction (Operational vs Retired): ${name || ci.sysId}`,
          "CI has install_status set to Retired/Decommissioned, yet operational_status is still marked Operational. Align lifecycle attributes to prevent ghost assets.",
          {
            sysId: ci.sysId,
            name,
            operationalStatus: opStatus,
            installStatus: instStatus,
          },
          "High",
          95,
          2,
          { action: "patch_record", table: "cmdb_ci", sysId: ci.sysId, fields: { operational_status: "2" } },
          false,
          ["sysId", "operationalStatus", "installStatus"],
          "cmdb",
        );
      }

      // Rule 9: cmdb.ci.no_model
      if (isHardwareOrServer && !value(ci.data, "model_id") && !value(ci.data, "model_number")) {
        push(
          "cmdb.ci.no_model",
          ci,
          `Hardware model missing: ${name || ci.sysId}`,
          "Hardware or server CI has no linked model definition or model number.",
          {
            sysId: ci.sysId,
            name,
            className: value(ci.data, "sys_class_name"),
          },
          "Medium",
          90,
          3,
          { action: "patch_record", table: "cmdb_ci", sysId: ci.sysId, fields: { model_id: "" } },
          false,
          ["sysId", "name"],
          "cmdb",
        );
      }

      // Rule 10: cmdb.ci.missing_ip
      if (isHardwareOrServer && !value(ci.data, "ip_address")) {
        push(
          "cmdb.ci.missing_ip",
          ci,
          `IP address missing on network/server CI: ${name || ci.sysId}`,
          "Active server or network CI is missing an IP address, blocking automated health probing and telemetry correlation.",
          {
            sysId: ci.sysId,
            name,
            className: value(ci.data, "sys_class_name"),
          },
          "Medium",
          85,
          3,
          { action: "patch_record", table: "cmdb_ci", sysId: ci.sysId, fields: { ip_address: "" } },
          false,
          ["sysId", "name"],
          "cmdb",
        );
      }

      // Rule 13: cmdb.ci.missing_environment
      if (
        (className.includes("server") || className.includes("database") || className.includes("appl")) &&
        !value(ci.data, "environment")
      ) {
        push(
          "cmdb.ci.missing_environment",
          ci,
          `Missing environment designation: ${name || ci.sysId}`,
          "Server or application CI does not declare environment (Production, Staging, Development).",
          {
            sysId: ci.sysId,
            name,
            className: value(ci.data, "sys_class_name"),
          },
          "Low",
          85,
          3,
          { action: "patch_record", table: "cmdb_ci", sysId: ci.sysId, fields: { environment: "Production" } },
          false,
          ["sysId", "name"],
          "cmdb",
        );
      }

      // Rule 14: cmdb.ci.stale_updated
      const updatedOn = value(ci.data, "sys_updated_on");
      if (updatedOn && isActive) {
        const updateTime = Date.parse(updatedOn.replace(" ", "T"));
        if (!isNaN(updateTime) && now.getTime() - updateTime > 180 * 86400_000) {
          push(
            "cmdb.ci.stale_updated",
            ci,
            `No system updates in >180 days: ${name || ci.sysId}`,
            "CI record has not been updated or modified by any integration or engineer in over 180 days.",
            {
              sysId: ci.sysId,
              name,
              sysUpdatedOn: updatedOn,
              ageDays: Math.floor((now.getTime() - updateTime) / 86400_000),
            },
            "Medium",
            90,
            3,
            null,
            false,
            ["sysId", "sysUpdatedOn"],
            "cmdb",
          );
        }
      }
    }

    // Rule 3: Identity collisions
    for (const group of identityGroups.values()) {
      if (group.objects.length < 2) continue;
      const canonical = group.objects[0];
      for (const duplicate of group.objects.slice(1)) {
        push(
          "cmdb.ci.identity_collision",
          duplicate,
          `Possible duplicate CI: ${value(duplicate.data, "name") || duplicate.sysId}`,
          "Two CIs in the same domain share a strong identity field. Verify the source records before merging or retiring.",
          {
            identityField: group.field,
            identityValue: group.value,
            canonicalSysId: canonical.sysId,
            duplicateSysId: duplicate.sysId,
            domain,
          },
          "High",
          100,
          2,
          null,
          false,
          [
            "identityField",
            "identityValue",
            "canonicalSysId",
            "duplicateSysId",
            "domain",
          ],
          "cmdb",
        );
      }
    }

    // Rule 12: Duplicate Name & Class
    for (const group of nameClassGroups.values()) {
      if (group.length < 2) continue;
      const canonical = group[0];
      for (const duplicate of group.slice(1)) {
        push(
          "cmdb.ci.duplicate_name_class",
          duplicate,
          `Multiple active CIs with identical name and class: ${value(duplicate.data, "name")}`,
          "Found duplicate active configuration items sharing the exact same name and class in the same domain.",
          {
            name: value(duplicate.data, "name"),
            className: value(duplicate.data, "sys_class_name"),
            canonicalSysId: canonical.sysId,
            duplicateSysId: duplicate.sysId,
          },
          "Low",
          90,
          2,
          null,
          false,
          ["name", "className", "canonicalSysId", "duplicateSysId"],
          "cmdb",
        );
      }
    }

    // ----------------- ITSM CHECKS -----------------

    // Rule 15: itsm.incident.p1_unassigned
    for (const item of scoped) {
      if (item.table !== "incident") continue;
      const act = value(item.data, "active").toLowerCase();
      const prio = value(item.data, "priority");
      const assigned = value(item.data, "assigned_to");
      const incNumber = value(item.data, "number") || item.sysId;

      if (act !== "false" && act !== "0" && (prio === "1" || prio === "2") && !assigned) {
        push(
          "itsm.incident.p1_unassigned",
          item,
          `Priority ${prio} incident has no assignee: ${incNumber}`,
          "The incident is active and high-priority, but the assignee field is blank. High-priority incidents require immediate owner assignment.",
          {
            sysId: item.sysId,
            number: incNumber,
            priority: prio,
            active: "true",
          },
          "High",
          100,
          2,
          { action: "patch_record", table: "incident", sysId: item.sysId, fields: { assigned_to: "" } },
          false,
          ["sysId", "number", "priority"],
          "itsm",
        );
      }

      // Rule 16: itsm.incident.no_ci
      const cmdbCi = value(item.data, "cmdb_ci");
      if (act !== "false" && act !== "0" && !cmdbCi) {
        push(
          "itsm.incident.no_ci",
          item,
          `Incident missing linked CI: ${incNumber}`,
          "Active incident has no Configuration Item linked. Linking CIs is required for service outage tracking and change correlation.",
          {
            sysId: item.sysId,
            number: incNumber,
            priority: prio,
          },
          "Medium",
          95,
          2,
          null,
          false,
          ["sysId", "number"],
          "itsm",
        );
      }

      // Rule 17: itsm.incident.stale
      const incUpdated = value(item.data, "sys_updated_on");
      if (act !== "false" && act !== "0" && incUpdated) {
        const incUpdateTime = Date.parse(incUpdated.replace(" ", "T"));
        if (!isNaN(incUpdateTime) && now.getTime() - incUpdateTime > 30 * 86400_000) {
          push(
            "itsm.incident.stale",
            item,
            `Active incident not updated in >30 days: ${incNumber}`,
            "Incident remains active but has had no status or notes update in more than 30 days. Review for resolution or closure.",
            {
              sysId: item.sysId,
              number: incNumber,
              sysUpdatedOn: incUpdated,
              ageDays: Math.floor((now.getTime() - incUpdateTime) / 86400_000),
            },
            "Medium",
            90,
            3,
            null,
            false,
            ["sysId", "number", "sysUpdatedOn"],
            "itsm",
          );
        }
      }
    }

    // Index parent tasks for SLA resolution checking
    const taskBySysId = new Map<string, TwinObject>();
    for (const item of scoped) {
      if (item.table === "incident" || item.table === "task" || item.table === "change_request" || item.table === "problem") {
        taskBySysId.set(item.sysId, item);
        const num = value(item.data, "number");
        if (num) taskBySysId.set(num, item);
      }
    }

    // Rules 18 & 19: task_sla checks
    for (const sla of scoped) {
      if (sla.table !== "task_sla") continue;
      const breached = value(sla.data, "has_breached").toLowerCase() === "true";
      const pct = parseFloat(value(sla.data, "percentage") || value(sla.data, "business_percentage") || "0");
      const stage = value(sla.data, "stage").toLowerCase();
      const timeLeftStr = value(sla.data, "time_left") || value(sla.data, "business_time_left");
      const plannedEndStr = value(sla.data, "planned_end_time") || value(sla.data, "target");

      const taskSysId = value(sla.data, "task");
      const parentTask = taskSysId ? taskBySysId.get(taskSysId) : undefined;
      const parentState = parentTask ? value(parentTask.data, "state") : "";
      const isParentClosed = parentState === "6" || parentState === "7" || parentState === "8" || parentState === "closed" || parentState === "resolved";
      const isParentEscalated = parentTask ? (value(parentTask.data, "priority") === "1" && value(parentTask.data, "urgency") === "1") : false;
      const hasRemediationNotes = parentTask ? String(parentTask.data.work_notes || "").includes("SAOS Autonomous Remediation") : false;
      const isAlreadyRemediatedOnInstance = isParentClosed || (isParentEscalated && hasRemediationNotes);

      // Imminent breach detection (<= 5 minutes left or >= 95% elapsed)
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

      // Rule 18: itsm.sla.breached
      if (breached && !isAlreadyRemediatedOnInstance) {
        push(
          "itsm.sla.breached",
          sla,
          `Breached SLA on task: ${value(sla.data, "task") || sla.sysId}`,
          "ServiceNow reports this SLA as breached. This directly damages operational compliance and customer commitments.",
          {
            sysId: sla.sysId,
            hasBreached: "true",
            task: value(sla.data, "task"),
            sla: value(sla.data, "sla"),
            percentage: pct,
          },
          "Critical",
          100,
          3,
          null,
          false,
          ["sysId", "hasBreached"],
          "itsm",
        );
      } else if (is5MinImminent && (stage === "in_progress" || stage === "active" || !stage)) {
        // Rule: itsm.sla.imminent_breach (<5m remaining or >=95% elapsed)
        push(
          "itsm.sla.imminent_breach",
          sla,
          `Critical SLA Imminent Breach (<5m remaining): ${value(sla.data, "task") || sla.sysId}`,
          `Active SLA has under 5 minutes remaining (${timeLeftStr ? timeLeftStr + " left" : pct.toFixed(0) + "% elapsed"}). Immediate escalation required to prevent breach.`,
          {
            sysId: sla.sysId,
            task: value(sla.data, "task"),
            sla: value(sla.data, "sla"),
            percentage: pct,
            timeLeft: timeLeftStr || "< 5 minutes",
            stage,
          },
          "Critical",
          100,
          3,
          null,
          false,
          ["sysId", "percentage"],
          "itsm",
        );
      } else if (pct >= 80 && (stage === "in_progress" || stage === "active" || !stage)) {
        // Rule 19: itsm.sla.at_risk
        push(
          "itsm.sla.at_risk",
          sla,
          `SLA at breach risk (${pct.toFixed(0)}% elapsed): ${value(sla.data, "task") || sla.sysId}`,
          "Active SLA has surpassed 80% duration without closure, placing the service commitment at immediate risk of breach.",
          {
            sysId: sla.sysId,
            task: value(sla.data, "task"),
            percentage: pct,
            stage,
          },
          "High",
          90,
          2,
          null,
          false,
          ["sysId", "percentage"],
          "itsm",
        );
      }
    }

    // Rules 20 & 21: change_request checks
    for (const chg of scoped) {
      if (chg.table !== "change_request") continue;
      const chgNum = value(chg.data, "number") || chg.sysId;
      const chgCi = value(chg.data, "cmdb_ci");
      const approval = value(chg.data, "approval").toLowerCase();
      const state = value(chg.data, "state").toLowerCase();

      // Rule 20: itsm.change.no_ci
      if (!chgCi) {
        push(
          "itsm.change.no_ci",
          chg,
          `Change request missing affected CI: ${chgNum}`,
          "Change request has no target Configuration Item specified, preventing automated collision and CAB risk analysis.",
          {
            sysId: chg.sysId,
            number: chgNum,
            state,
          },
          "Medium",
          95,
          2,
          { action: "patch_record", table: "change_request", sysId: chg.sysId, fields: { cmdb_ci: "" } },
          false,
          ["sysId", "number"],
          "itsm",
        );
      }

      // Rule 21: itsm.change.no_approval
      // If state is scheduled or implement (often '3' or 'implement' or 'scheduled') but approval is not approved
      if (
        (state === "scheduled" || state === "implement" || state === "-1" || state === "3") &&
        approval !== "approved" &&
        approval !== ""
      ) {
        push(
          "itsm.change.no_approval",
          chg,
          `Change advancing without formal approval: ${chgNum}`,
          "Change request is scheduled or implementing without recorded 'approved' authorization.",
          {
            sysId: chg.sysId,
            number: chgNum,
            approval,
            state,
          },
          "High",
          90,
          2,
          null,
          false,
          ["sysId", "number", "approval"],
          "itsm",
        );
      }
    }

    // Rule 22: itsm.problem.no_root_cause
    for (const prb of scoped) {
      if (prb.table !== "problem") continue;
      const prbNum = value(prb.data, "number") || prb.sysId;
      const rcCi = value(prb.data, "root_cause_ci") || value(prb.data, "cmdb_ci");
      const causeNotes = value(prb.data, "cause_notes") || value(prb.data, "workaround");
      const state = value(prb.data, "state");

      if (!rcCi && !causeNotes) {
        push(
          "itsm.problem.no_root_cause",
          prb,
          `Problem record missing root cause: ${prbNum}`,
          "Problem ticket has neither a documented root cause CI nor diagnostic notes.",
          {
            sysId: prb.sysId,
            number: prbNum,
            state,
          },
          "Medium",
          90,
          2,
          null,
          false,
          ["sysId", "number"],
          "itsm",
        );
      }
    }

    // ----------------- CSDM & SERVICE MODEL CHECKS -----------------
    const services = scoped.filter(
      (o) =>
        o.table === "cmdb_ci_service" ||
        o.table === "cmdb_ci_service_business" ||
        o.table === "cmdb_ci_service_technical" ||
        o.table === "service_offering",
    );

    for (const svc of services) {
      const svcName = value(svc.data, "name") || svc.sysId;
      const svcActive =
        value(svc.data, "operational_status") !== "2" &&
        value(svc.data, "install_status") !== "7";
      const edgeCount = ciRelCount.get(svc.sysId) ?? 0;

      // Rule: csdm.service.no_supporting_cis -> CMDB-110
      if (svcActive && edgeCount === 0) {
        push(
          "csdm.service.no_supporting_cis",
          svc,
          `Application/Business Service with no supporting CIs: ${svcName}`,
          "This active CSDM service has zero infrastructure or application dependencies mapped in CMDB relationships. Services without supporting CIs cannot compute alert blast radius or impact scores.",
          {
            sysId: svc.sysId,
            serviceName: svcName,
            className: svc.table,
            relationshipCount: 0,
          },
          "High",
          95,
          2,
          null,
          false,
          ["sysId", "serviceName", "relationshipCount"],
          "cmdb",
        );
      }

      // Rule: csdm.service.missing_owner -> CMDB-106
      const svcOwner =
        value(svc.data, "owned_by") ||
        value(svc.data, "managed_by") ||
        value(svc.data, "service_owner");
      const svcGroup =
        value(svc.data, "support_group") || value(svc.data, "assignment_group");
      if (svcActive && !svcOwner && !svcGroup) {
        push(
          "csdm.service.missing_owner",
          svc,
          `CSDM Service missing accountable owner and support group: ${svcName}`,
          "Service definition has neither an accountable individual owner nor an assigned support group.",
          {
            sysId: svc.sysId,
            serviceName: svcName,
            className: svc.table,
          },
          "Medium",
          90,
          3,
          {
            action: "patch_record",
            table: svc.table,
            sysId: svc.sysId,
            fields: { support_group: "" },
          },
          false,
          ["sysId", "serviceName"],
          "cmdb",
        );
      }
    }

    // ----------------- ITOM OPERATIONS & EVENT CHECKS -----------------
    const alerts = scoped.filter(
      (o) => o.table === "em_alert" || o.table === "em_event",
    );
    for (const alt of alerts) {
      const altNum =
        value(alt.data, "number") || value(alt.data, "node") || alt.sysId;
      const boundCiId = value(alt.data, "cmdb_ci");

      // Rule: itom.alert.unbound_ci -> ITOM-098
      if (!boundCiId) {
        push(
          "itom.alert.unbound_ci",
          alt,
          `ITOM Event/Alert failed to bind to any CI: ${altNum}`,
          "Active ITOM alert or ingested event has no bound Configuration Item. Node name could not be resolved by IRE or event rules.",
          {
            sysId: alt.sysId,
            alertNumber: altNum,
            node: value(alt.data, "node"),
            severity: value(alt.data, "severity"),
          },
          "High",
          90,
          2,
          null,
          false,
          ["sysId", "alertNumber"],
          "itom",
        );
      } else {
        const boundCi = scoped.find((o) => o.sysId === boundCiId);
        if (boundCi) {
          const ciInst = value(boundCi.data, "install_status");
          const ciOp = value(boundCi.data, "operational_status");
          const isRetired = ciInst === "7" || ciInst === "8" || ciOp === "2";
          if (isRetired) {
            push(
              "itom.alert.retired_ci",
              alt,
              `ITOM Alert resolving to retired/decommissioned CI: ${altNum}`,
              "Incoming alert bound to a configuration item that is marked as retired or decommissioned in CMDB.",
              {
                sysId: alt.sysId,
                alertNumber: altNum,
                boundCiId,
                ciName: value(boundCi.data, "name"),
                installStatus: ciInst,
              },
              "High",
              95,
              2,
              null,
              false,
              ["sysId", "boundCiId"],
              "itom",
            );
          }
          if ((ciRelCount.get(boundCiId) ?? 0) === 0) {
            push(
              "itom.alert.zero_relations_ci",
              alt,
              `ITOM Alert bound to isolated CI with zero relationships: ${altNum}`,
              "Alert is attached to an orphan CI with no mapped dependencies. Impact trees and business service outage calculations will show 0 affected services.",
              {
                sysId: alt.sysId,
                alertNumber: altNum,
                boundCiId,
                ciName: value(boundCi.data, "name"),
              },
              "Medium",
              90,
              2,
              null,
              false,
              ["sysId", "boundCiId"],
              "itom",
            );
          }
        }
      }
    }

    // ----------------- FOUNDATION & DATA QUALITY CHECKS -----------------
    const users = scoped.filter((o) => o.table === "sys_user");
    const userById = new Map<string, TwinObject>();
    for (const u of users) {
      userById.set(u.sysId, u);
    }
    for (const u of users) {
      const uActive = value(u.data, "active").toLowerCase();
      const mgrId = value(u.data, "manager");
      if (uActive !== "false" && uActive !== "0" && mgrId) {
        const mgr = userById.get(mgrId);
        if (mgr) {
          const mgrActive = value(mgr.data, "active").toLowerCase();
          if (mgrActive === "false" || mgrActive === "0") {
            push(
              "dq.user.inactive_manager",
              u,
              `Active user has inactive manager: ${value(u.data, "name") || u.sysId}`,
              "User is active in ServiceNow but their assigned manager account is deactivated or locked out. Review organization hierarchy.",
              {
                sysId: u.sysId,
                userName: value(u.data, "name"),
                managerId: mgrId,
                managerName: value(mgr.data, "name"),
              },
              "Medium",
              95,
              3,
              {
                action: "patch_record",
                table: "sys_user",
                sysId: u.sysId,
                fields: { manager: "" },
              },
              false,
              ["sysId", "managerId"],
              "data-quality",
            );
          }
        }
      }
    }

    // Foundation User Groups & Membership
    const groups = scoped.filter((o) => o.table === "sys_user_group");
    const groupMembers = scoped.filter((o) => o.table === "sys_user_grmember");
    const memberCountByGroup = new Map<string, number>();
    for (const gm of groupMembers) {
      const gid = value(gm.data, "group");
      if (gid) memberCountByGroup.set(gid, (memberCountByGroup.get(gid) ?? 0) + 1);
    }
    for (const g of groups) {
      const gActive = value(g.data, "active").toLowerCase();
      if (gActive === "false" || gActive === "0") continue;
      const gName = value(g.data, "name") || g.sysId;
      const count = memberCountByGroup.get(g.sysId) ?? 0;
      const mgr = value(g.data, "manager");
      const email = value(g.data, "email");

      // Rule: dq.group.empty -> CMDB-102
      if (count === 0) {
        push(
          "dq.group.empty",
          g,
          `Assignment/Support group has zero active members: ${gName}`,
          "Group is active in ServiceNow but has no members in sys_user_grmember. Tickets or tasks routed here will sit unhandled.",
          {
            sysId: g.sysId,
            groupName: gName,
            memberCount: 0,
          },
          "High",
          95,
          2,
          null,
          false,
          ["sysId", "groupName"],
          "data-quality",
        );
      }

      // Rule: dq.group.no_manager -> DQ-084
      if (!mgr && !email) {
        push(
          "dq.group.no_manager",
          g,
          `Group missing both manager and group email: ${gName}`,
          "Group has neither an accountable manager nor a shared distribution email address for escalation.",
          {
            sysId: g.sysId,
            groupName: gName,
          },
          "Medium",
          90,
          3,
          null,
          false,
          ["sysId", "groupName"],
          "data-quality",
        );
      }
    }

    // Asset & Hardware Records (alm_asset)
    const assets = scoped.filter((o) => o.table === "alm_asset" || o.table === "alm_hardware");
    for (const ast of assets) {
      const astActive = value(ast.data, "install_status") !== "7"; // not retired
      const linkedCi = value(ast.data, "ci");
      const astName = value(ast.data, "display_name") || value(ast.data, "asset_tag") || ast.sysId;

      // Rule: asset.ci.unlinked -> CMDB-082 (Active asset without linked CI)
      if (astActive && !linkedCi) {
        push(
          "asset.ci.unlinked",
          ast,
          `Active hardware asset has no linked CI in CMDB: ${astName}`,
          "Physical or software asset exists in asset management but has no corresponding CI in CMDB. ITAM and ITSM workflows cannot reconcile operational state.",
          {
            sysId: ast.sysId,
            assetTag: value(ast.data, "asset_tag"),
            displayName: astName,
          },
          "Medium",
          90,
          2,
          null,
          false,
          ["sysId", "assetTag"],
          "cmdb",
        );
      }
    }

    // ITOM Discovery Schedules (discovery_schedule)
    const schedules = scoped.filter((o) => o.table === "discovery_schedule");
    for (const sched of schedules) {
      const sActive = value(sched.data, "active").toLowerCase();
      if (sActive === "false" || sActive === "0") continue;
      const sName = value(sched.data, "name") || sched.sysId;
      const loc = value(sched.data, "location");

      // Rule: itom.discovery.missing_location -> ITOM-004
      if (!loc) {
        push(
          "itom.discovery.missing_location",
          sched,
          `Location not defined on discovery schedule: ${sName}`,
          "Discovery schedule has no associated location. Discovered CIs will lack geographic hierarchy or require manual tagging.",
          {
            sysId: sched.sysId,
            scheduleName: sName,
          },
          "Medium",
          90,
          3,
          null,
          false,
          ["sysId", "scheduleName"],
          "itom",
        );
      }
    }

    // ITOM MID Servers (ecc_agent)
    const midServers = scoped.filter((o) => o.table === "ecc_agent");
    for (const mid of midServers) {
      const mStatus = value(mid.data, "status").toLowerCase();
      const mName = value(mid.data, "name") || mid.sysId;
      if (mStatus !== "up" && mStatus !== "") {
        push(
          "itom.mid.down",
          mid,
          `MID Server status is Down or Degraded: ${mName}`,
          "MID Server is currently reporting non-Up status, impacting automated discovery, orchestration, and event collection.",
          {
            sysId: mid.sysId,
            name: mName,
            status: mStatus,
          },
          "Critical",
          100,
          3,
          null,
          false,
          ["sysId", "name", "status"],
          "itom",
        );
      }
    }

    // ITOM ECC Queue (ecc_queue)
    const eccQueue = scoped.filter((o) => o.table === "ecc_queue");
    for (const ecc of eccQueue) {
      const eState = value(ecc.data, "state").toLowerCase();
      if (eState === "error") {
        push(
          "itom.ecc.error",
          ecc,
          `ECC Queue payload in Error state: ${ecc.sysId}`,
          "Message in ServiceNow ECC queue encountered an error during MID server transmission or XML payload parsing.",
          {
            sysId: ecc.sysId,
            agent: value(ecc.data, "agent"),
            topic: value(ecc.data, "topic"),
            state: eState,
          },
          "High",
          95,
          2,
          null,
          false,
          ["sysId", "state"],
          "itom",
        );
      }
    }

    // ITSM Knowledge Articles (kb_knowledge)
    const kbArticles = scoped.filter((o) => o.table === "kb_knowledge");
    for (const kb of kbArticles) {
      const validTo = value(kb.data, "valid_to");
      const kbNum = value(kb.data, "number") || kb.sysId;
      if (validTo) {
        const validTime = Date.parse(validTo.replace(" ", "T"));
        if (!isNaN(validTime) && validTime < now.getTime()) {
          push(
            "itsm.kb.expired",
            kb,
            `Knowledge article passed valid_to expiration: ${kbNum}`,
            "Knowledge base article is past its defined validity expiration date. Outdated guidance risk for technicians and self-service users.",
            {
              sysId: kb.sysId,
              number: kbNum,
              validTo,
              shortDescription: value(kb.data, "short_description"),
            },
            "Low",
            85,
            3,
            null,
            false,
            ["sysId", "number", "validTo"],
            "itsm",
          );
        }
      }
    }
  }

  const riskOrder: Record<Finding["risk"], number> = {
    Systemic: 0,
    Critical: 1,
    High: 2,
    Moderate: 3,
    Medium: 3,
    Low: 4,
  };

  return findings.sort(
    (a, b) =>
      (riskOrder[a.risk] ?? 5) - (riskOrder[b.risk] ?? 5) ||
      b.confidence - a.confidence,
  );
}

export async function runScan(
  onProgress?: (progress: {
    phase?: string;
    currentAgent?: string;
    currentTable?: string;
    progress?: number;
    total?: number;
    message?: string;
  }) => Promise<void> | void,
) {
  const db = await getDb();
  let twinVersion = await getTwinVersion();
  if (twinVersion <= 0) {
    twinVersion = 1;
    await db.query("UPDATE meta SET value='1' WHERE key='twin_version'");
    await db.query("UPDATE twin_objects SET twin_version=1");
  }
  const source = await db.query<{ value: string }>(
    "SELECT value FROM meta WHERE key='source_origin'",
  );
  const connection = await getConnectionConfig();
  if (
    !source.rows[0] ||
    !connection ||
    source.rows[0].value !== connection.instanceUrl
  )
    throw new Error(
      "The local copy does not match the selected instance. Load records first.",
    );
  const rows = await db.query<{
    id: string;
    table_name: string;
    sys_id: string;
    domain_id: string;
    twin_version: number;
    payload: Record<string, unknown>;
  }>(
    "SELECT id,table_name,sys_id,domain_id,twin_version,payload FROM twin_objects",
  );
  const objects = rows.rows.map((row) => ({
    id: row.id,
    table: row.table_name,
    sysId: row.sys_id,
    domain: row.domain_id,
    version: row.twin_version,
    data: row.payload,
  }));
  if (objects.length === 0)
    throw new Error(
      "Connect and load ServiceNow records before checking for problems",
    );

  // STRICT REQUIREMENT: LLM must be active and selected in settings to perform an autonomous scan
  const aiStatus = await getAiProviderStatus();
  if (!aiStatus.available || !aiStatus.model) {
    throw new Error(
      `LLM Consulting Engine is required to scan. ${aiStatus.message || "Please select and run an Ollama model in Settings."}`,
    );
  }

  await onProgress?.({
    phase: "sensing",
    currentAgent: "Discovery & Topology Sensor",
    currentTable: "cmdb_ci",
    progress: 10,
    total: 100,
    message:
      "Auditing Configuration Items for ownership, classification & orphan topology (CMDB-105, CMDB-058)...",
  });

  await onProgress?.({
    phase: "analysis",
    currentAgent: "Relationship Topology Auditor",
    currentTable: "cmdb_rel_ci",
    progress: 20,
    total: 100,
    message:
      "Auditing relationship parent/child pointers & duplicate dependencies (CMDB-069, CMDB-083)...",
  });

  await onProgress?.({
    phase: "analysis",
    currentAgent: "CSDM Service Architect",
    currentTable: "cmdb_ci_service / service_offering",
    progress: 30,
    total: 100,
    message:
      "Evaluating CSDM Business & Technical Services for supporting CIs & owners (CMDB-110, CMDB-106)...",
  });

  await onProgress?.({
    phase: "analysis",
    currentAgent: "ITOM Event & Discovery Sentinel",
    currentTable: "em_alert / em_event / discovery_status",
    progress: 40,
    total: 100,
    message:
      "Analyzing ITOM event bindings, alert anomalies & discovery schedules (ITOM-098, ITOM-096, ITOM-001)...",
  });

  await onProgress?.({
    phase: "analysis",
    currentAgent: "SLA Commitment Monitor",
    currentTable: "task_sla",
    progress: 50,
    total: 100,
    message:
      "Scanning SLA records for contractual breaches & threshold status (ITSM-033, ITSM-035)...",
  });

  await onProgress?.({
    phase: "analysis",
    currentAgent: "ITSM Process Auditor",
    currentTable: "incident / change_request / problem",
    progress: 58,
    total: 100,
    message:
      "Evaluating ticket-to-CI binding, approvals & problem root causes (ITSM-016, ITSM-094, ITSM-062)...",
  });

  await onProgress?.({
    phase: "analysis",
    currentAgent: "Data Quality & Identity Auditor",
    currentTable: "sys_user / sys_user_group",
    progress: 65,
    total: 100,
    message:
      "Auditing foundation users, inactive managers & empty support groups (DQ-086, CMDB-102)...",
  });

  const appliedRows = await db.query<{ finding_id: string }>(
    "SELECT finding_id FROM remediation_plans WHERE status='Applied'",
  );
  const appliedFindingIds = new Set(appliedRows.rows.map((r) => r.finding_id));

  const findings = evaluateTwin(objects, twinVersion);

  // Active findings exclude those already verified and remediated on ServiceNow
  const activeFindings = findings.filter((f) => !appliedFindingIds.has(f.id));

  // Build cluster summaries for LLM review
  const clusterMap = new Map<string, FindingClusterSummary>();
  for (const f of activeFindings) {
    const existing = clusterMap.get(f.ruleId);
    if (existing) {
      existing.count++;
    } else {
      const upper = f.ruleId.toUpperCase();
      const governanceDomain =
        upper === "CMDB-106" || upper === "CMDB-110" || upper.startsWith("CSDM")
          ? "CSDM"
          : upper === "CMDB-016" || upper.startsWith("ITOM") || upper.includes("DISCOVERY")
            ? "ITOM"
            : upper.startsWith("ITSM")
              ? "ITSM"
              : upper.startsWith("DQ")
                ? "Data Quality"
                : upper.startsWith("PLT") || upper.startsWith("SEC")
                  ? "Platform"
                  : "CMDB";

      clusterMap.set(f.ruleId, {
        ruleId: f.ruleId,
        count: 1,
        sampleEvidence: f.evidence,
        preliminaryTitle: f.title,
        domain: governanceDomain,
      });
    }
  }
  const clusters = Array.from(clusterMap.values());

  await onProgress?.({
    phase: "llm_consulting",
    currentAgent: `LLM Autonomous Consultant (${aiStatus.model})`,
    currentTable: "catalog segregation",
    progress: 60,
    total: 100,
    message: `Consulting ${aiStatus.model} for finding verification, root cause & domain segregation...`,
  });

  let llmConsultation = null;
  try {
    llmConsultation = await consultLlmForScanAudit(clusters);
  } catch (err) {
    throw new Error(
      `LLM Consulting failed with model '${aiStatus.model}': ${err instanceof Error ? err.message : String(err)}. Active LLM is strictly required for scan integrity.`,
    );
  }

  // Compute multi-signal health scores
  const healthSummary = calculateHealthScores(objects, activeFindings);
  healthSummary.fixedCount = (healthSummary.fixedCount || 0) + appliedFindingIds.size;
  healthSummary.totalIssues = Math.max(0, activeFindings.length);

  await onProgress?.({
    phase: "remediation_staging",
    currentAgent: "Update Set XML Synthesizer & Health Scorer",
    currentTable: "sys_remote_update_set / findings",
    progress: 88,
    total: 100,
    message: "Synthesizing staged Update Set XMLs & computing multi-signal health scores...",
  });

  await db.transaction(async (tx) => {
    await tx.query("UPDATE findings SET status='Resolved' WHERE status='Open'");
    for (const f of findings) {
      const isAlreadyApplied = appliedFindingIds.has(f.id);
      const initialStatus = isAlreadyApplied ? "Resolved" : "Open";

      let updateSetXml: string | null = null;
      if (f.lane === 2) {
        try {
          updateSetXml = generateServiceNowUpdateSetXml({
            ruleId: f.ruleId,
            ruleTitle: f.title,
            targetTable: f.targetId.includes(":")
              ? f.targetId.split(":")[0]
              : (f.evidence?.table as string) || "cmdb_ci",
            targetSysId: f.targetId.includes(":")
              ? f.targetId.split(":")[1]
              : (f.evidence?.sysId as string) || f.targetId,
            targetName:
              (f.evidence?.name as string) ||
              (f.evidence?.number as string) ||
              undefined,
            fields: f.suggestedAfter,
          });
        } catch {
          updateSetXml = null;
        }
      }


      await tx.query(
        "INSERT INTO findings(id,rule_id,rule_version,domain_id,target_id,title,explanation,evidence,confidence,risk,lane,suggested_after,approval_required,twin_version,risk_assessment,status,what_it_means,why_it_matters,false_positive_guard,cross_domain_link,source_tables) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT(id) DO UPDATE SET rule_version=EXCLUDED.rule_version,title=EXCLUDED.title,explanation=EXCLUDED.explanation,evidence=EXCLUDED.evidence,confidence=EXCLUDED.confidence,risk=EXCLUDED.risk,lane=EXCLUDED.lane,suggested_after=EXCLUDED.suggested_after,approval_required=EXCLUDED.approval_required,twin_version=EXCLUDED.twin_version,risk_assessment=EXCLUDED.risk_assessment,what_it_means=EXCLUDED.what_it_means,why_it_matters=EXCLUDED.why_it_matters,false_positive_guard=EXCLUDED.false_positive_guard,cross_domain_link=EXCLUDED.cross_domain_link,source_tables=EXCLUDED.source_tables,status=CASE WHEN (SELECT status FROM remediation_plans WHERE finding_id=EXCLUDED.id)='Applied' THEN 'Resolved' ELSE 'Open' END",
        [
          f.id,
          f.ruleId,
          f.ruleVersion,
          f.domain,
          f.targetId,
          f.title,
          f.explanation,
          JSON.stringify(f.evidence),
          f.confidence,
          f.risk,
          f.lane,
          f.suggestedAfter ? JSON.stringify(f.suggestedAfter) : null,
          f.approvalRequired,
          f.twinVersion,
          JSON.stringify(f.riskAssessment),
          initialStatus,
          f.whatItMeans ?? null,
          f.whyItMatters ?? null,
          f.falsePositiveGuard ?? null,
          f.crossDomainLink ?? null,
          f.sourceTables ?? null,
        ],
      );
      await tx.query(
        "INSERT INTO remediation_plans(id,finding_id,source_twin_version,update_set_xml) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET update_set_xml=COALESCE(EXCLUDED.update_set_xml, remediation_plans.update_set_xml)",
        [`plan-${f.id}`, f.id, twinVersion, updateSetXml],
      );
    }
    // Store health summary in meta for fast retrieval
    await tx.query(
      "INSERT INTO meta(key,value) VALUES('health_summary',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [JSON.stringify(healthSummary)],
    );
    if (llmConsultation) {
      await tx.query(
        "INSERT INTO meta(key,value) VALUES('llm_consultation',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
        [JSON.stringify(llmConsultation)],
      );
    }
    await appendAuditTx(tx, "SCAN_COMPLETED", {
      twinVersion,
      objectCount: objects.length,
      findingCount: findings.length,
      ruleVersion: RULE_VERSION,
      cmdbScore: healthSummary.cmdbHealthScore,
      itsmScore: healthSummary.itsmHealthScore,
      llmModel: aiStatus.model,
    });
  });


  const agentRuns = await recordAgentRuns(objects, findings, twinVersion);

  await onProgress?.({
    phase: "completed",
    currentAgent: "Audit",
    currentTable: "local audit log",
    progress: 100,
    total: 100,
    message: "Evidence, scores, and audit history saved",
  });

  return {
    twinVersion,
    objectCount: objects.length,
    findingCount: findings.length,
    agentRunCount: agentRuns.length,
    cmdbScore: healthSummary.cmdbHealthScore,
    itsmScore: healthSummary.itsmHealthScore,
  };
}
