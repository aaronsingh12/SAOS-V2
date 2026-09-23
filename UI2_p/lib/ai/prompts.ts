export type FixAction = {
  operation: "patch" | "delete" | "create";
  table: string;
  sysId?: string;
  fields?: Record<string, unknown>;
  description: string;
};

export type FixPlan = {
  summary: string;
  whatWasMissing?: string;
  whatIsAdded?: string;
  rootCause: string;
  fixActions: FixAction[];
  verifyAfter: string;
  impactIfIgnored: string;
};

export type RuleContext = {
  code?: string;
  domain?: string;
  standard?: string;
  severity?: string;
  weight?: number;
  whatItMeans?: string;
  whyItMatters?: string;
  falsePositiveGuard?: string;
  crossDomainLink?: string;
};

export function buildFixPrompt(
  ruleId: string,
  title: string,
  explanation: string,
  evidence: Record<string, unknown>,
  targetData?: Record<string, unknown>,
  candidateCIs?: { name: string; sysId: string; className: string }[],
  ruleContext?: RuleContext,
  targetTable?: string,
  targetSysId?: string,
): string {
  const isCmdb = !ruleId.toUpperCase().startsWith("ITSM");
  const resolvedTable = targetTable || (isCmdb ? "cmdb_ci" : "incident");
  const resolvedSysId = targetSysId || String(evidence?.sysId || evidence?.sys_id || "");
  const targetSummary = targetData
    ? JSON.stringify(targetData, null, 2)
    : JSON.stringify(evidence, null, 2);

  const ciSection =
    candidateCIs && candidateCIs.length > 0
      ? `\nAVAILABLE SERVICENOW CONFIGURATION ITEMS (Choose the most appropriate CI and use its exact sysId for fields.cmdb_ci):\n${candidateCIs
          .map((c) => `- ${c.name} [sys_id: ${c.sysId}, class: ${c.className}]`)
          .join("\n")}\n`
      : "";

  const governanceContext = ruleContext
    ? `\nSAOS 755 MASTER GOVERNANCE RULE INTELLIGENCE:
- Standard: ${ruleContext.standard || "Enterprise CSDM / ITIL Standard"} [Code: ${ruleContext.code || ruleId}]
- Severity Band: ${ruleContext.severity || "Critical"} (Governance Weight: ${ruleContext.weight || 40})
${ruleContext.whatItMeans ? `- Technical Mechanism (What It Means): ${ruleContext.whatItMeans}` : ""}
${ruleContext.whyItMatters ? `- Operational Blast Radius (Why It Matters): ${ruleContext.whyItMatters}` : ""}
${ruleContext.crossDomainLink ? `- Cross-Domain Ripple: ${ruleContext.crossDomainLink}` : ""}\n`
    : "";

  return `You are SAOS AI, a Principal ServiceNow CMDB & ITSM Enterprise Architect.
Analyze the following operational issue and formulate an exact, safe, and reversible remediation plan.

CRITICAL LANGUAGE MANDATE:
You MUST formulate ALL output strictly and exclusively in standard English. NEVER use Chinese (中文 / 汉字), Japanese, or any non-English script under any circumstances. Every single word must be professional English.

TARGET SERVICENOW RECORD TO REMEDIATE:
- Target Table: ${resolvedTable}
- Target Record SysId: ${resolvedSysId}
- IMPORTANT: You are modifying this ${resolvedTable} record. Therefore, fixActions MUST have "table": "${resolvedTable}" and "sysId": "${resolvedSysId}".
- DO NOT set "table": "cmdb_ci" if Target Table is "${resolvedTable}". If you are linking a CI to an incident, set fields.cmdb_ci on table "${resolvedTable}".

RULE: ${ruleId}
ISSUE: ${title}
EXPLANATION: ${explanation}
EVIDENCE: ${JSON.stringify(evidence)}
${governanceContext}RECORD DATA:
${targetSummary}
${ciSection}
INSTRUCTIONS:
1. LANGUAGE GUARD: English only. Strictly zero Chinese characters.
2. Specify what exact attribute, relationship, or data was missing or broken in the record (whatWasMissing) in English.
3. Specify what exact field, CI, or value the AI is adding/fixing (whatIsAdded) in English.
4. Formulate rootCause as a concise, plain-text string (NEVER a JSON object) explaining why this occurred in ServiceNow, in English.
5. Formulate impactIfIgnored as a high-impact plain-text string reflecting the operational blast radius, in English.
6. Formulate explicit, minimal fixActions targeting the correct ServiceNow table:
   - For ITSM incident without CI (ITSM-016): patch table 'incident' with sysId '${resolvedSysId}', fields: { cmdb_ci: "<chosen_ci_sys_id>" }.
   - For ITSM change without CI (ITSM-094): patch table 'change_request' with sysId '${resolvedSysId}', fields: { cmdb_ci: "<chosen_ci_sys_id>" }.
   - For ITSM unassigned P1 incident: patch table 'incident' assigned_to or assignment_group.
   - For CMDB ownership: patch table 'cmdb_ci' with assigned_to, support_group, or owned_by.
   - For CMDB classification: patch table 'cmdb_ci' with the appropriate specific sys_class_name.
   - For CMDB lifecycle: patch table 'cmdb_ci' operational_status to match install_status.
   - For duplicate relationships: delete the duplicate 'cmdb_rel_ci' record.
7. NEVER touch sys_id, sys_domain, or sys_created_on.
8. Output MUST be valid JSON matching this schema:
{
  "summary": "Brief 1-sentence fix summary in English",
  "whatWasMissing": "Specific missing attribute, broken link, or compliance gap in English",
  "whatIsAdded": "Exact value, CI reference, or state being added or corrected in English",
  "rootCause": "Clear explanation string of cause in English",
  "fixActions": [
    {
      "operation": "patch" | "delete" | "create",
      "table": "${resolvedTable}",
      "sysId": "${resolvedSysId}",
      "fields": { "field_name": "value" },
      "description": "What this change accomplishes in English"
    }
  ],
  "verifyAfter": "How to verify the fix was effective in English",
  "impactIfIgnored": "Business and operational blast radius string in English"
}

Respond ONLY with valid JSON. No conversational preamble or Markdown fences.`;
}

export function buildAdaptationPrompt(
  ruleId: string,
  title: string,
  failedAction: FixAction,
  errorMessage: string,
  attemptNumber: number,
  evidence?: Record<string, unknown>,
  targetData?: Record<string, unknown>,
): string {
  const targetSummary = targetData
    ? JSON.stringify(targetData, null, 2)
    : JSON.stringify(evidence ?? {}, null, 2);

  return `You are SAOS Autonomous Remediation Agent.
Your previous patch attempt against the live ServiceNow instance FAILED.
You must analyze the error and formulate an ALTERNATIVE REVISED METHOD to successfully patch the instance.

CRITICAL LANGUAGE MANDATE:
Output MUST be exclusively in standard English. NEVER use Chinese (中文), Japanese, or any non-English script. Every single word must be English.

FAILURE REPORT:
Attempt Number: ${attemptNumber}
Target Table: ${failedAction.table}
Operation: ${failedAction.operation}
Attempted Payload: ${JSON.stringify(failedAction.fields ?? {})}
ServiceNow Error: "${errorMessage}"

ISSUE CONTEXT:
Rule: ${ruleId}
Title: ${title}
Record Data:
${targetSummary}

ADAPTATION GUIDELINES:
1. Target table must remain '${failedAction.table}' (or if specialized incident/change failed, its parent table 'task'). NEVER change table to 'cmdb_ci' if remediating an incident or change!
2. If a specific field was rejected (read-only, ACL denied, or invalid choice), remove the rejected field and patch valid attributes + ITIL journal notes.
3. If an SLA record failed, re-target to the parent task ('incident' or 'task') to escalate priority/urgency and log remediation work_notes.
4. If compound fields failed, decouple into minimal safe fields or use ITIL journal streams ('work_notes' on tasks/incidents, 'comments' on CMDB CIs) which are universally accepted by ServiceNow Table API.
5. Output MUST be valid JSON matching this schema:
{
  "summary": "Brief explanation of the adapted strategy in English",
  "adaptationReason": "Why this alternative method will bypass the previous ServiceNow failure in English",
  "fixActions": [
    {
      "operation": "patch" | "delete" | "create",
      "table": "${failedAction.table}",
      "sysId": "${failedAction.sysId || ""}",
      "fields": { "field_name": "value" },
      "description": "What this adapted action accomplishes in English"
    }
  ]
}

Respond ONLY with valid JSON. No conversational preamble or Markdown fences.`;
}

