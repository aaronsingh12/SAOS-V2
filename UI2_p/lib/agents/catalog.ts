export type AgentClass = "Sensing" | "Analysis" | "Synthesis" | "Action";
export type AgentStatus = "ready" | "partial" | "planned";
export type AgentModule = "cmdb" | "itsm" | "platform";

export type AgentDefinition = {
  id: string;
  name: string;
  className: AgentClass;
  status: AgentStatus;
  module: AgentModule;
  requiredTables: string[];
  evidence: string;
  note: string;
};

const sensing = (
  id: string,
  name: string,
  module: AgentModule,
  status: AgentStatus,
  requiredTables: string[],
  evidence: string,
  note: string,
): AgentDefinition => ({
  id,
  name,
  className: "Sensing",
  module,
  status,
  requiredTables,
  evidence,
  note,
});

const analysis = (
  id: string,
  name: string,
  module: AgentModule,
  status: AgentStatus,
  requiredTables: string[],
  evidence: string,
  note: string,
): AgentDefinition => ({
  id,
  name,
  className: "Analysis",
  module,
  status,
  requiredTables,
  evidence,
  note,
});

const synthesis = (
  id: string,
  name: string,
  module: AgentModule,
  status: AgentStatus,
  evidence: string,
  note: string,
): AgentDefinition => ({
  id,
  name,
  className: "Synthesis",
  module,
  status,
  requiredTables: ["local findings", "local twin graph"],
  evidence,
  note,
});

const action = (
  id: string,
  name: string,
  module: AgentModule,
  status: AgentStatus,
  evidence: string,
  note: string,
): AgentDefinition => ({
  id,
  name,
  className: "Action",
  module,
  status,
  requiredTables: ["local findings", "audit log"],
  evidence,
  note,
});

export const agentCatalog: AgentDefinition[] = [
  // ==========================================
  // CMDB Agents (14)
  // ==========================================
  sensing(
    "extraction",
    "Extraction",
    "cmdb",
    "ready",
    ["cmdb_ci", "cmdb_rel_ci"],
    "Read-only Table API extraction with strict count validation and pagination",
    "Captures full snapshot of CMDB and ITSM source records into local twin.",
  ),
  sensing(
    "change-detection",
    "Change Detection",
    "cmdb",
    "ready",
    ["cmdb_ci", "cmdb_rel_ci"],
    "Twin version diff and source updated timestamp tracking",
    "Identifies CI drift and changes between consecutive scans.",
  ),
  sensing(
    "discovery-health",
    "Discovery Health",
    "cmdb",
    "ready",
    ["cmdb_ci"],
    "Discovery freshness, last_discovered timestamps, and coverage gaps",
    "Detects configuration items not refreshed or discovered in >90 days.",
  ),
  analysis(
    "cmdb-ownership",
    "Ownership Verification",
    "cmdb",
    "ready",
    ["cmdb_ci"],
    "Assigned_to, owned_by, managed_by, support_group coverage",
    "Finds CIs where all critical ownership and accountability fields are empty.",
  ),
  analysis(
    "cmdb-classification",
    "CI Classification",
    "cmdb",
    "ready",
    ["cmdb_ci"],
    "sys_class_name inspection against generic base class",
    "Flags CIs assigned to generic 'cmdb_ci' instead of specialized classes.",
  ),
  analysis(
    "cmdb-completeness",
    "Completeness & Attributes",
    "cmdb",
    "ready",
    ["cmdb_ci"],
    "Location, environment, and IP address presence on infrastructure CIs",
    "Audits missing environment, physical location, or network coordinates.",
  ),
  analysis(
    "cmdb-staleness",
    "Staleness Evaluator",
    "cmdb",
    "ready",
    ["cmdb_ci"],
    "sys_updated_on timestamp age (>180 days) on active CIs",
    "Identifies abandoned CIs that have not received system updates.",
  ),
  analysis(
    "cmdb-lifecycle",
    "Lifecycle Integrity",
    "cmdb",
    "ready",
    ["cmdb_ci"],
    "operational_status vs install_status contradiction detection",
    "Detects retired/decommissioned CIs still marked operational.",
  ),
  analysis(
    "cmdb-identity",
    "Identity & De-duplication",
    "cmdb",
    "ready",
    ["cmdb_ci"],
    "Serial number, asset tag, FQDN, and identical name+class collision analysis",
    "Surfaces potential duplicates and identity collisions across same-class CIs.",
  ),
  analysis(
    "relationship-duplicate",
    "Duplicate Relationships",
    "cmdb",
    "ready",
    ["cmdb_rel_ci"],
    "Parent, child, and relationship type uniqueness verification",
    "Detects and prepares reversible deletion plans for duplicate relationships.",
  ),
  analysis(
    "relationship-orphan-endpoint",
    "Orphan Relationship Endpoints",
    "cmdb",
    "ready",
    ["cmdb_rel_ci", "cmdb_ci"],
    "Relationship parent and child existence verification",
    "Flags relationships pointing to non-existent CIs in the CMDB.",
  ),
  analysis(
    "cmdb-orphan-ci",
    "Orphan CIs",
    "cmdb",
    "ready",
    ["cmdb_ci", "cmdb_rel_ci"],
    "Graph relationship degree verification (zero relationships)",
    "Identifies active infrastructure CIs isolated without topology links.",
  ),
  analysis(
    "ci-model-verification",
    "CI Model Verification",
    "cmdb",
    "ready",
    ["cmdb_ci"],
    "Hardware and computer model_id assignment verification",
    "Detects hardware resources lacking catalog model identifiers.",
  ),
  analysis(
    "service-impact",
    "Service Impact & Mapping",
    "cmdb",
    "ready",
    ["cmdb_ci"],
    "Service dependency mapping and blast-radius score propagation",
    "Evaluates upstream service criticality and impact blast radius.",
  ),

  // ==========================================
  // ITSM Agents (8)
  // ==========================================
  analysis(
    "itsm-incident-unassigned",
    "P1/P2 Incident Assignment",
    "itsm",
    "ready",
    ["incident"],
    "Active high-priority incident assignee verification",
    "Enforces immediate ownership on Critical and High priority incidents.",
  ),
  analysis(
    "itsm-incident-no-ci",
    "Incident CI Linkage",
    "itsm",
    "ready",
    ["incident"],
    "Incident cmdb_ci association checking",
    "Identifies active incidents lacking associated Configuration Items.",
  ),
  analysis(
    "itsm-incident-stale",
    "Incident Freshness & Staleness",
    "itsm",
    "ready",
    ["incident"],
    "Incident update freshness (>30 days inactive)",
    "Catches abandoned active incidents without engineer progress.",
  ),
  analysis(
    "itsm-sla-breached",
    "SLA Breach Monitor",
    "itsm",
    "ready",
    ["task_sla"],
    "task_sla has_breached status verification",
    "Identifies breached service commitments and correlates back to CI health.",
  ),
  analysis(
    "itsm-sla-at-risk",
    "SLA Breach Prevention",
    "itsm",
    "ready",
    ["task_sla"],
    "SLA elapsed duration >80% threshold monitoring",
    "Alerts on active SLAs approaching breach before commitment fails.",
  ),
  analysis(
    "itsm-change-no-ci",
    "Change CI Association",
    "itsm",
    "ready",
    ["change_request"],
    "Change request cmdb_ci specification",
    "Flags changes scheduled without target CI, preventing collision assessment.",
  ),
  analysis(
    "itsm-change-approval",
    "Change Approval Compliance",
    "itsm",
    "ready",
    ["change_request"],
    "Scheduled/implementing change approval state verification",
    "Detects changes proceeding into implementation without formal approval.",
  ),
  analysis(
    "itsm-problem-root-cause",
    "Problem Root Cause Enforcement",
    "itsm",
    "ready",
    ["problem"],
    "Problem root_cause_ci and cause_notes completeness",
    "Ensures open problems document root cause CI or diagnostic findings.",
  ),

  // ==========================================
  // Data Quality & Identity Hygiene Agents (2)
  // ==========================================
  analysis(
    "identity-manager-hygiene",
    "Manager Approval Chain Hygiene",
    "platform",
    "ready",
    ["sys_user"],
    "Active sys_user records referencing inactive managers in the approval hierarchy",
    "Audits approval bottlenecks and broken delegation chains in governance workflows.",
  ),
  analysis(
    "user-communication-audit",
    "User Contact & Account Completeness",
    "platform",
    "ready",
    ["sys_user"],
    "sys_user accounts with blank email or missing notification targets",
    "Prevents notification delivery failures and orphaned user identities.",
  ),

  // ==========================================
  // Synthesis, AI Reasoning & Action Agents (5)
  // ==========================================
  analysis(
    "llm-consultant",
    "Autonomous LLM Technical Architect & Auditor",
    "platform",
    "ready",
    ["local findings", "local twin graph"],
    "Dynamic local LLM reasoning engine validating catalog rules and priority risk scores",
    "Contextually differentiates finding mechanisms and synthesizes executive audit dossiers without hardcoding.",
  ),
  synthesis(
    "health-scorer",
    "Health Scorer",
    "platform",
    "ready",
    "Multi-signal weighted score across CMDB and ITSM entities",
    "Calculates unified CI and ITSM record health ranks (0-100).",
  ),
  synthesis(
    "smart-grouper",
    "Smart Grouper & Batch Planner",
    "platform",
    "ready",
    "Hierarchical grouping by module, rule, and domain",
    "Consolidates thousands of raw issues into ranked actionable batches.",
  ),
  action(
    "fix-applier",
    "Remediation Fix Applier",
    "platform",
    "ready",
    "Live-record verification, audit log, PATCH/DELETE/POST REST operations",
    "Applies human-approved fixes with automated rollback capability.",
  ),
  action(
    "update-set-synthesizer",
    "Update Set XML Synthesizer & Exporter",
    "platform",
    "ready",
    "ServiceNow sys_remote_update_set XML payload generation with Data Policies, SLA schedules, and Business Rules",
    "Exports compliant, staged Update Set XMLs directly importable into ServiceNow sub-production instances.",
  ),
];

export function getAgentCatalog() {
  return agentCatalog;
}
