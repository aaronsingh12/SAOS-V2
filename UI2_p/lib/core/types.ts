export type Risk = "Systemic" | "Critical" | "High" | "Moderate" | "Medium" | "Low";
export type Lane = 1 | 2 | 3;
export type PlanStatus =
  | "Proposed"
  | "Previewed"
  | "Approved"
  | "Applied"
  | "Validated"
  | "Rejected"
  | "Failed";

export type RiskAssessment = {
  severity: Risk;
  confidence: { score: number; basis: string };
  evidenceCompleteness: { score: number; missing: string[]; basis: string };
  dataFreshness: {
    score: number | null;
    observedAt: string | null;
    basis: string;
  };
  businessCriticality: { score: number | null; basis: string };
  blastRadius: { count: number | null; basis: string };
  serviceImpact: { score: number | null; basis: string };
  overall: "Not scored" | "Scored";
  cautions: string[];
  severityWeight?: number;
  severityModifier?: string;
};

export type TwinObject = {
  id: string;
  table: string;
  sysId: string;
  domain: string;
  version: number;
  data: Record<string, unknown>;
};

export type Module = "cmdb" | "itsm" | "itom" | "platform" | "data-quality";

export type Finding = {
  id: string;
  ruleId: string;
  ruleVersion: string;
  domain: string;
  targetId: string;
  title: string;
  explanation: string;
  evidence: Record<string, unknown>;
  confidence: number;
  risk: Risk;
  lane: Lane;
  suggestedAfter: Record<string, unknown> | null;
  approvalRequired: boolean;
  twinVersion: number;
  riskAssessment: RiskAssessment;
  module?: Module;
  whatItMeans?: string;
  whyItMatters?: string;
  falsePositiveGuard?: string;
  crossDomainLink?: string;
  sourceTables?: string;
};

export type Plan = Finding & {
  status: PlanStatus;
  createdAt: string;
  preview: Record<string, unknown> | null;
  approvedBy: string | null;
  updateSetXml?: string | null;
};


