import masterCatalogData from "./master-catalog.json";

export type RuleKnowledge = {
  id: string;
  code: string;
  domain: "CMDB" | "ITSM" | "ITOM" | "Platform" | "Data Quality";
  group?: string;
  standard: string;
  title: string;
  severity: "Systemic" | "Critical" | "High" | "Moderate" | "Low";
  weight: number;
  whatItMeans: string;
  whyItMatters: string;
  falsePositiveGuard: string;
  crossDomainLink?: string;
  remediationLane: 1 | 2 | 3;
  rawRemediationLane?: string;
  sourceTables?: string;
  detectionLogic?: string;
  threshold?: string;
  confidenceBasis?: string;
  evidenceToShow?: string;
};

// Aliases mapping programmatic finding ruleIds to master 755 catalog codes
const PROGRAMMATIC_ALIASES: Record<string, string> = {
  "cmdb.ci.identity_collision": "CMDB-035",
  "cmdb.ci.missing_ip": "CMDB-013",
  "cmdb.ci.orphan": "CMDB-058",
  "cmdb.owner.missing": "CMDB-105",
  "cmdb.ci.stale_updated": "CMDB-077",
  "cmdb.discovery.stale": "CMDB-135",
  "cmdb.ci.no_model": "DQ-086",
  "itsm.incident.no_ci": "ITSM-016",
  "itsm.change.no_ci": "ITSM-094",
  "itsm.sla.breached": "ITSM-033",
  "cmdb.ci.duplicate_name_class": "CMDB-040",
  "cmdb.ci.missing_environment": "CMDB-016",
  "cmdb.ci.missing_location": "CMDB-020",
  "itsm.incident.p1_unassigned": "ITSM-004",
  "itsm.sla.at_risk": "ITSM-033",
  "itsm.sla.imminent_breach": "ITSM-035",
  "itsm.change.no_approval": "ITSM-081",
  "cmdb.relationship.duplicate": "CMDB-069",
  "cmdb.ci.lifecycle_conflict": "CMDB-023",
  "cmdb.ci.missing_class": "CMDB-027",
  "cmdb.relationship.orphan_endpoint": "CMDB-083",
  "itsm.incident.stale": "ITSM-037",
  "itsm.problem.no_root_cause": "ITSM-062",
  "csdm.service.no_supporting_cis": "CMDB-110",
  "csdm.service.missing_owner": "CMDB-106",
  "itom.alert.unbound_ci": "ITOM-098",
  "itom.alert.zero_relations_ci": "ITOM-096",
  "itom.alert.retired_ci": "ITOM-101",
  "itom.discovery.coverage_gap": "ITOM-001",
  "dq.group.empty": "CMDB-102",
};


// Index all 755 master catalog rules
const MASTER_RULES_BY_CODE = new Map<string, RuleKnowledge>();

for (const raw of (masterCatalogData as any).rules || []) {
  const normSev: RuleKnowledge["severity"] =
    raw.baseSeverity === "Systemic"
      ? "Systemic"
      : raw.baseSeverity === "Critical"
        ? "Critical"
        : raw.baseSeverity === "High"
          ? "High"
          : raw.baseSeverity === "Low"
            ? "Low"
            : "Moderate";

  const weight =
    normSev === "Systemic"
      ? 100
      : normSev === "Critical"
        ? 40
        : normSev === "High"
          ? 15
          : normSev === "Moderate"
            ? 5
            : 1;

  const standard =
    raw.domain === "CMDB"
      ? "CSDM 4.0 IRE Standard"
      : raw.domain === "ITSM"
        ? "ITIL v4 Service Management"
        : raw.domain === "ITOM"
          ? "ITOM Service Mapping Standard"
          : raw.domain === "Data Quality"
            ? "IRE Data Integrity Standard"
            : "ServiceNow Platform Governance";

  const knowledge: RuleKnowledge = {
    id: raw.id,
    code: raw.id,
    domain: raw.domain,
    group: raw.group || "",
    standard,
    title: raw.title || raw.id,
    severity: normSev,
    weight,
    whatItMeans:
      raw.whatItMeans ||
      "Data integrity policy violation detected during deep ServiceNow twin evaluation.",
    whyItMatters:
      raw.whyItMatters ||
      "Creates operational risk, degrades CMDB trust, and compromises downstream incident triage.",
    falsePositiveGuard:
      raw.falsePositiveGuard ||
      "Verified structural condition against active ServiceNow database record.",
    crossDomainLink: raw.crossDomainLink || undefined,
    remediationLane: (raw.remediationLane === 1 || raw.remediationLane === 3 ? raw.remediationLane : 2) as 1 | 2 | 3,
    rawRemediationLane: raw.rawRemediationLane,
    sourceTables: raw.sourceTables,
    detectionLogic: raw.detectionLogic,
    threshold: raw.threshold,
    confidenceBasis: raw.confidenceBasis,
    evidenceToShow: raw.evidenceToShow,
  };

  MASTER_RULES_BY_CODE.set(raw.id.toUpperCase().trim(), knowledge);
}

// Fallback lookup object for compatibility
export const RULE_KNOWLEDGE_MAP: Record<string, RuleKnowledge> = {};
for (const [k, v] of MASTER_RULES_BY_CODE.entries()) {
  RULE_KNOWLEDGE_MAP[k] = v;
}
for (const [alias, code] of Object.entries(PROGRAMMATIC_ALIASES)) {
  const target = MASTER_RULES_BY_CODE.get(code.toUpperCase().trim());
  if (target) {
    RULE_KNOWLEDGE_MAP[alias] = { ...target, id: alias };
  }
}

/**
 * Resolves comprehensive architectural rule knowledge for any finding
 * across all 755 Master Catalog rules and factors.
 */
export function getRuleKnowledge(
  ruleId: string,
  plan?: {
    title?: string;
    whatItMeans?: string;
    whyItMatters?: string;
    falsePositiveGuard?: string;
    crossDomainLink?: string;
  } | null,
): RuleKnowledge {
  const normalizedId = (ruleId || "").trim();

  // 1. Check title for bracket code: e.g. "[CMDB-035] ..." or "[PLT-001] ..."
  const titleBracketMatch = plan?.title?.match(/\[([A-Z0-9_-]+)\]/i);
  if (titleBracketMatch) {
    const code = titleBracketMatch[1].toUpperCase().trim();
    const found = MASTER_RULES_BY_CODE.get(code);
    if (found) return found;
  }

  // 2. Direct lookup by ruleId as code (e.g. "CMDB-001", "DQ-002")
  const directCode = MASTER_RULES_BY_CODE.get(normalizedId.toUpperCase());
  if (directCode) return directCode;

  // 3. Lookup programmatic alias (e.g. "cmdb.ci.identity_collision" -> "CMDB-035")
  const aliasedCode = PROGRAMMATIC_ALIASES[normalizedId];
  if (aliasedCode) {
    const found = MASTER_RULES_BY_CODE.get(aliasedCode.toUpperCase());
    if (found) return found;
  }

  // 4. Compatibility map lookup
  const comp = RULE_KNOWLEDGE_MAP[normalizedId];
  if (comp) return comp;

  // 5. Fallback synthesis
  const isIt = normalizedId.startsWith("itsm.");
  const domain = isIt
    ? "ITSM"
    : normalizedId.startsWith("cmdb.")
      ? "CMDB"
      : normalizedId.startsWith("dq.") || normalizedId.startsWith("DQ-")
        ? "Data Quality"
        : normalizedId.startsWith("PLT-") || normalizedId.includes("sla")
          ? "Platform"
          : "CMDB";

  return {
    id: normalizedId,
    code: normalizedId.toUpperCase().replace(/\./g, "-"),
    domain: domain as any,
    standard: isIt ? "ITIL v4 Service Management" : "CSDM 4.0 Standard",
    title: plan?.title || normalizedId,
    severity: "High",
    weight: 15,
    whatItMeans:
      plan?.whatItMeans ||
      "Data integrity policy violation detected during deep ServiceNow twin evaluation.",
    whyItMatters:
      plan?.whyItMatters ||
      "Creates operational risk, degrades CMDB trust, and compromises downstream incident triage.",
    falsePositiveGuard:
      plan?.falsePositiveGuard ||
      "Verified structural condition against active ServiceNow database record.",
    crossDomainLink: plan?.crossDomainLink,
    remediationLane: 1,
  };
}
