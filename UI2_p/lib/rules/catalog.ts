import masterCatalogData from "./master-catalog.json";

export type RuleDomain = "CMDB" | "ITSM" | "ITOM" | "Platform" | "Data Quality";
export type RuleSeverity = "Systemic" | "Critical" | "High" | "Moderate" | "Low";

export type MasterRule = {
  id: string;
  domain: RuleDomain;
  group: string;
  title: string;
  baseSeverity: RuleSeverity;
  rawSeverity: string;
  whatItMeans: string;
  whyItMatters: string;
  sourceTables: string;
  detectionLogic: string;
  threshold: string;
  confidenceBasis: string;
  evidenceToShow: string;
  falsePositiveGuard: string;
  remediationLane: 1 | 2 | 3;
  rawRemediationLane: string;
  crossDomainLink: string;
};

export type MasterCatalogMetadata = {
  version: string;
  sourceFile: string;
  totalRules: number;
  domainCounts: Record<RuleDomain, number>;
  generatedAt: string;
};

const catalog = masterCatalogData as {
  metadata: MasterCatalogMetadata;
  rules: MasterRule[];
};

const ruleById = new Map<string, MasterRule>();
for (const rule of catalog.rules) {
  ruleById.set(rule.id, rule);
}

export function getAllMasterRules(): MasterRule[] {
  return catalog.rules;
}

export function getMasterCatalogMetadata(): MasterCatalogMetadata {
  return catalog.metadata;
}

export function getMasterRule(id: string): MasterRule | undefined {
  return ruleById.get(id);
}

export function getRulesByDomain(domain: RuleDomain): MasterRule[] {
  return catalog.rules.filter((rule) => rule.domain === domain);
}

export function getRulesBySeverity(severity: RuleSeverity): MasterRule[] {
  return catalog.rules.filter((rule) => rule.baseSeverity === severity);
}

export function getRulesByLane(lane: 1 | 2 | 3): MasterRule[] {
  return catalog.rules.filter((rule) => rule.remediationLane === lane);
}

export function searchMasterRules(query: string): MasterRule[] {
  const q = query.toLowerCase().trim();
  if (!q) return catalog.rules;
  return catalog.rules.filter(
    (rule) =>
      rule.id.toLowerCase().includes(q) ||
      rule.title.toLowerCase().includes(q) ||
      rule.group.toLowerCase().includes(q) ||
      rule.sourceTables.toLowerCase().includes(q) ||
      rule.whatItMeans.toLowerCase().includes(q) ||
      rule.whyItMatters.toLowerCase().includes(q)
  );
}
