export type UpdateSetParams = {
  ruleId: string;
  ruleTitle: string;
  targetTable: string;
  targetSysId: string;
  targetName?: string;
  fields?: Record<string, unknown> | null;
  generatedBy?: string;
};

export function generateServiceNowUpdateSetXml(params: UpdateSetParams): string {
  const now = new Date();
  const dateStr = now.toISOString().replace("T", " ").substring(0, 19);
  const cleanRuleId = (params.ruleId || "GOV-001").toUpperCase();
  const updateSetName = `SAOS Governance Fix [${cleanRuleId}]: ${params.ruleTitle.substring(0, 50)}`;
  const targetName =
    params.targetName ||
    `${params.targetTable} [${params.targetSysId.substring(0, 8)}]`;
  const generatedBy = params.generatedBy || "SAOS-Autonomous-Governance";

  let innerPayload: string;
  let updateXmlType = params.targetTable;
  let updateXmlName = `${params.targetTable}_${params.targetSysId}`;

  // Case 1: Fields provided (Data remediation / record update)
  if (params.fields && Object.keys(params.fields).length > 0) {
    const fieldXml = Object.entries(params.fields)
      .filter(([k, v]) => v !== undefined && k !== "sys_id")
      .map(([k, v]) => `    <${k}>${escapeXml(String(v))}</${k}>`)
      .join("\n");

    innerPayload = `<?xml version="1.0" encoding="UTF-8"?>
<record_update table="${escapeXml(params.targetTable)}">
  <${escapeXml(params.targetTable)} action="INSERT_OR_UPDATE">
    <sys_id>${escapeXml(params.targetSysId)}</sys_id>
${fieldXml}
    <sys_updated_by>${escapeXml(generatedBy)}</sys_updated_by>
  </${escapeXml(params.targetTable)}>
</record_update>`;
  }
  // Case 2: Lane 2 / Policy / Rule Enforcement Update Set (Data Policy / SLA Definition / Policy Rule)
  else if (cleanRuleId.startsWith("ITSM-016") || cleanRuleId.startsWith("ITSM-094")) {
    // Enforce mandatory cmdb_ci via sys_data_policy2
    const table = cleanRuleId.startsWith("ITSM-094") ? "change_request" : "incident";
    updateXmlType = "sys_data_policy2";
    updateXmlName = `sys_data_policy2_saos_${table}_cmdb_ci_mandatory`;
    innerPayload = `<?xml version="1.0" encoding="UTF-8"?>
<record_update sys_domain="global" table="sys_data_policy2">
  <sys_data_policy2 action="INSERT_OR_UPDATE">
    <active>true</active>
    <apply_import_set>true</apply_import_set>
    <apply_soap>true</apply_soap>
    <enforce_ui>true</enforce_ui>
    <short_description>SAOS Enforcement: Mandatory Configuration Item on ${table}</short_description>
    <table_name>${table}</table_name>
    <sys_name>SAOS Mandatory CMDB CI (${table})</sys_name>
  </sys_data_policy2>
  <sys_data_policy_rule action="INSERT_OR_UPDATE">
    <disabled>ignore</disabled>
    <field>cmdb_ci</field>
    <mandatory>true</mandatory>
    <table_name>${table}</table_name>
  </sys_data_policy_rule>
</record_update>`;
  } else if (cleanRuleId.startsWith("ITSM-033") || cleanRuleId.startsWith("PLT-001")) {
    // SLA schedule & notification configuration
    updateXmlType = "contract_sla";
    updateXmlName = `contract_sla_${params.targetSysId}`;
    innerPayload = `<?xml version="1.0" encoding="UTF-8"?>
<record_update table="contract_sla">
  <contract_sla action="INSERT_OR_UPDATE">
    <sys_id>${escapeXml(params.targetSysId)}</sys_id>
    <schedule display_value="8-5 weekdays">08fcd0830a0a0b2600079f56b1adb9ae</schedule>
    <timezone>floating</timezone>
    <sys_updated_by>${escapeXml(generatedBy)}</sys_updated_by>
  </contract_sla>
</record_update>`;
  } else if (cleanRuleId.startsWith("ITSM-004") || cleanRuleId.startsWith("ITSM-018")) {
    // Assignment validation
    updateXmlType = "sys_data_policy2";
    updateXmlName = `sys_data_policy2_saos_incident_assignment_group`;
    innerPayload = `<?xml version="1.0" encoding="UTF-8"?>
<record_update sys_domain="global" table="sys_data_policy2">
  <sys_data_policy2 action="INSERT_OR_UPDATE">
    <active>true</active>
    <apply_import_set>true</apply_import_set>
    <apply_soap>true</apply_soap>
    <enforce_ui>true</enforce_ui>
    <short_description>SAOS Enforcement: Mandatory Assignment Group on P1 Incidents</short_description>
    <table_name>incident</table_name>
    <conditions>priority=1</conditions>
  </sys_data_policy2>
  <sys_data_policy_rule action="INSERT_OR_UPDATE">
    <disabled>ignore</disabled>
    <field>assignment_group</field>
    <mandatory>true</mandatory>
    <table_name>incident</table_name>
  </sys_data_policy_rule>
</record_update>`;
  } else if (cleanRuleId.startsWith("ITSM-062")) {
    // Problem RCA mandatory before close
    updateXmlType = "sys_data_policy2";
    updateXmlName = `sys_data_policy2_saos_problem_rca_mandatory`;
    innerPayload = `<?xml version="1.0" encoding="UTF-8"?>
<record_update sys_domain="global" table="sys_data_policy2">
  <sys_data_policy2 action="INSERT_OR_UPDATE">
    <active>true</active>
    <apply_import_set>true</apply_import_set>
    <apply_soap>true</apply_soap>
    <enforce_ui>true</enforce_ui>
    <short_description>SAOS Enforcement: Root Cause mandatory for closed Problems</short_description>
    <table_name>problem</table_name>
    <conditions>state=3</conditions>
  </sys_data_policy2>
  <sys_data_policy_rule action="INSERT_OR_UPDATE">
    <disabled>ignore</disabled>
    <field>root_cause</field>
    <mandatory>true</mandatory>
    <table_name>problem</table_name>
  </sys_data_policy_rule>
</record_update>`;
  } else if (
    cleanRuleId.startsWith("CMDB-016") ||
    cleanRuleId.startsWith("CMDB-020") ||
    cleanRuleId.startsWith("CMDB-013") ||
    cleanRuleId.startsWith("CMDB-105")
  ) {
    // CMDB data governance policy
    const fieldToMandate = cleanRuleId.startsWith("CMDB-016")
      ? "environment"
      : cleanRuleId.startsWith("CMDB-020")
        ? "location"
        : cleanRuleId.startsWith("CMDB-013")
          ? "ip_address"
          : "owned_by";
    updateXmlType = "sys_data_policy2";
    updateXmlName = `sys_data_policy2_saos_cmdb_ci_${fieldToMandate}`;
    innerPayload = `<?xml version="1.0" encoding="UTF-8"?>
<record_update sys_domain="global" table="sys_data_policy2">
  <sys_data_policy2 action="INSERT_OR_UPDATE">
    <active>true</active>
    <apply_import_set>true</apply_import_set>
    <apply_soap>true</apply_soap>
    <enforce_ui>true</enforce_ui>
    <short_description>SAOS Governance: Enforce ${fieldToMandate} on CI records</short_description>
    <table_name>${escapeXml(params.targetTable || "cmdb_ci")}</table_name>
  </sys_data_policy2>
  <sys_data_policy_rule action="INSERT_OR_UPDATE">
    <disabled>ignore</disabled>
    <field>${fieldToMandate}</field>
    <mandatory>true</mandatory>
    <table_name>${escapeXml(params.targetTable || "cmdb_ci")}</table_name>
  </sys_data_policy_rule>
</record_update>`;
  } else {
    // General governance policy wrapper
    innerPayload = `<?xml version="1.0" encoding="UTF-8"?>
<record_update table="${escapeXml(params.targetTable)}">
  <${escapeXml(params.targetTable)} action="INSERT_OR_UPDATE">
    <sys_id>${escapeXml(params.targetSysId)}</sys_id>
    <sys_updated_by>${escapeXml(generatedBy)}</sys_updated_by>
    <work_notes>[SAOS Autonomous Governance] Remediation update set applied for rule ${escapeXml(cleanRuleId)}.</work_notes>
  </${escapeXml(params.targetTable)}>
</record_update>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<unload unload_date="${dateStr}">
  <sys_remote_update_set action="INSERT_OR_UPDATE">
    <name>${escapeXml(updateSetName)}</name>
    <description>Automated staged configuration update set generated by SAOS Autonomous Operations for rule ${escapeXml(cleanRuleId)} (${escapeXml(params.ruleTitle)}).</description>
    <state>loaded</state>
    <release_date>${dateStr}</release_date>
    <application display_value="Global">global</application>
  </sys_remote_update_set>
  <sys_update_xml action="INSERT_OR_UPDATE">
    <name>${escapeXml(updateXmlName)}</name>
    <type>${escapeXml(updateXmlType)}</type>
    <action>INSERT_OR_UPDATE</action>
    <target_name>${escapeXml(targetName)}</target_name>
    <update_set display_value="${escapeXml(updateSetName)}"/>
    <payload><![CDATA[${innerPayload}]]></payload>
  </sys_update_xml>
</unload>`;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

