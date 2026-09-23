import "server-only";

import { appendAuditTx } from "./audit";
import { getConnectionConfig } from "./connection";
import { getDb, getTwinVersion } from "./db";

type SnowRecord = Record<string, unknown> & {
  sys_id?: unknown;
  sys_domain?: unknown;
  sys_updated_on?: unknown;
};
/**
 * Tables SAOS can inspect in a deep scan.  This is deliberately an allow-list:
 * arbitrary ServiceNow tables may contain secrets or script source and are
 * never copied just because they exist in sys_db_object.
 */
const deepScanTables = [
  // CMDB & CSDM Core
  "cmdb_ci",
  "cmdb_rel_ci",
  "cmdb_ci_service",
  "cmdb_ci_service_business",
  "cmdb_ci_service_technical",
  "service_offering",
  "svc_ci_assoc",
  "cmdb_model",
  "cmdb_ci_appl",
  "cmdb_rel_type",
  "cmdb_identifier",
  "cmdb_identifier_entry",
  "cmdb_health_inclusion_rule",
  "cmdb_health_result",
  "alm_asset",
  "alm_hardware",

  // ITSM Operations
  "incident",
  "task_sla",
  "contract_sla",
  "change_request",
  "problem",
  "sc_request",
  "sc_req_item",
  "task",

  // ITOM (Operations Management & Discovery)
  "em_event",
  "em_alert",
  "em_match_rule",
  "em_connector_instance",
  "discovery_status",
  "discovery_device_history",
  "discovery_schedule",
  "discovery_log",
  "discovery_credentials",
  "ecc_agent",
  "ecc_queue",

  // Platform, Foundation & Data Quality (CSDM Foundation)
  "sys_user",
  "sys_user_group",
  "sys_user_grmember",
  "sys_user_has_role",
  "cmn_location",
  "cmn_department",
  "cmn_cost_center",
  "cmn_schedule",
  "core_company",
  "kb_knowledge",
] as const;

const safeFieldCandidates = [
  // System
  "sys_id",
  "sys_domain",
  "sys_updated_on",
  "sys_created_on",
  "sys_class_name",
  "sys_scope",
  "scope",
  "sys_package",
  "sys_created_by",
  "sys_updated_by",
  // CMDB CI core
  "name",
  "short_description",
  "active",
  "state",
  "status",
  "install_status",
  "operational_status",
  // CMDB Ownership
  "assigned_to",
  "owned_by",
  "managed_by",
  "support_group",
  "assignment_group",
  "managed_by_group",
  // CMDB Identity
  "serial_number",
  "asset_tag",
  "fqdn",
  "dns_domain",
  "ip_address",
  "mac_address",
  // CMDB Classification
  "category",
  "subcategory",
  "environment",
  "company",
  "department",
  "location",
  "cost_center",
  // CMDB Hardware
  "manufacturer",
  "model_id",
  "model_number",
  "os",
  "os_version",
  "os_domain",
  "cpu_count",
  "ram",
  "disk_space",
  // CMDB Discovery
  "last_discovered",
  "discovery_source",
  "first_discovered",
  // CMDB Business
  "business_criticality",
  "business_impact",
  "service_criticality",
  "service_impact",
  // Relationships
  "parent",
  "child",
  "type",
  // ITSM shared
  "number",
  "priority",
  "severity",
  "impact",
  "urgency",
  "opened_at",
  "closed_at",
  "resolved_at",
  "due_date",
  "source",
  "stage",
  // Incident specific
  "cmdb_ci",
  "caller_id",
  "close_code",
  "close_notes",
  "contact_type",
  "escalation",
  "reassignment_count",
  // SLA specific
  "has_breached",
  "task",
  "sla",
  "percentage",
  "ci_item",
  "business_percentage",
  "time_left",
  "business_time_left",
  "planned_end_time",
  "target",
  // Change specific
  "approval",
  "risk",
  "phase",
  "phase_state",
  "cab_required",
  "test_plan",
  "backout_plan",
  // Problem specific
  "root_cause_ci",
  "cause_notes",
  "known_error",
  "workaround",
  "related_incidents",
  // Foundation & User specific
  "user_name",
  "email",
  "first_name",
  "last_name",
  "manager",
  "title",
  "employee_number",
  "vip",
  "locked_out",
  // Group & Contract SLA specific
  "duration",
  "schedule",
  "timezone",
  "collection",
  "start_condition",
  "stop_condition",
  "pause_condition",
  "reset_condition",
  "city",
  "country",
  "dept_head",
  // ITOM & Event Management specific
  "node",
  "resource",
  "metric_name",
  "alert",
  "event_class",
  "additional_info",
  // CSDM & Service Offering specific
  "service_classification",
  "used_for",
  "service_owner",
  // Asset & Catalog specific
  "ci",
  "model",
  "warranty_expiration",
  "request",
  "request_item",
  "quantity",
  "price",
  "topic",
  "workflow_state",
  // Discovery & MID specific
  "ranges",
  "discover",
  "host_name",
  // CSDM Assoc specific
  "service_id",
  "ci_id",
  // Platform Scripts & Transform specific
  "when",
  "action_insert",
  "action_update",
  "action_delete",
  "script",
  "source_table",
  "target_table",
  "code",
] as const;

const requiredFieldsByTable: Record<string, string[]> = {
  cmdb_ci: [
    "sys_id",
    "sys_domain",
    "sys_updated_on",
    "name",
    "sys_class_name",
    "assigned_to",
    "owned_by",
    "managed_by",
    "support_group",
    "last_discovered",
    "serial_number",
    "asset_tag",
    "fqdn",
    "install_status",
    "operational_status",
    "environment",
    "location",
    "department",
    "company",
    "model_id",
    "ip_address",
    "mac_address",
    "category",
    "subcategory",
    "business_criticality",
    "discovery_source",
    "cost_center",
    "manufacturer",
    "os",
    "os_version",
  ],
  cmdb_rel_ci: [
    "sys_id",
    "sys_domain",
    "sys_updated_on",
    "parent",
    "child",
    "type",
  ],
  cmdb_ci_service: [
    "sys_id",
    "sys_domain",
    "sys_updated_on",
    "name",
    "service_criticality",
    "busines_criticality",
  ],
  cmdb_model: [
    "sys_id",
    "sys_domain",
    "sys_updated_on",
    "name",
    "manufacturer",
    "model_number",
  ],
  incident: [
    "sys_id",
    "sys_updated_on",
    "number",
    "active",
    "priority",
    "assigned_to",
    "assignment_group",
    "state",
    "cmdb_ci",
    "category",
    "subcategory",
    "short_description",
    "opened_at",
    "severity",
    "impact",
    "urgency",
    "escalation",
    "reassignment_count",
  ],
  task_sla: [
    "sys_id",
    "sys_updated_on",
    "has_breached",
    "task",
    "sla",
    "stage",
    "percentage",
    "ci_item",
    "business_percentage",
    "time_left",
    "business_time_left",
    "planned_end_time",
    "target",
  ],
  change_request: [
    "sys_id",
    "sys_updated_on",
    "number",
    "state",
    "type",
    "approval",
    "cmdb_ci",
    "assigned_to",
    "short_description",
    "risk",
    "priority",
    "cab_required",
    "phase",
    "phase_state",
  ],
  problem: [
    "sys_id",
    "sys_updated_on",
    "number",
    "state",
    "priority",
    "cmdb_ci",
    "root_cause_ci",
    "cause_notes",
    "assigned_to",
    "short_description",
    "known_error",
    "workaround",
  ],
  sys_user: [
    "sys_id",
    "sys_domain",
    "sys_updated_on",
    "name",
    "user_name",
    "email",
    "active",
    "manager",
    "title",
    "department",
    "location",
    "company",
    "employee_number",
    "vip",
    "locked_out",
  ],
  sys_user_group: [
    "sys_id",
    "sys_domain",
    "sys_updated_on",
    "name",
    "active",
    "manager",
    "description",
    "parent",
    "type",
  ],
  contract_sla: [
    "sys_id",
    "sys_domain",
    "sys_updated_on",
    "name",
    "active",
    "duration",
    "schedule",
    "timezone",
    "collection",
    "start_condition",
    "stop_condition",
    "pause_condition",
    "reset_condition",
    "target",
  ],
  cmn_location: [
    "sys_id",
    "sys_domain",
    "sys_updated_on",
    "name",
    "city",
    "state",
    "country",
    "parent",
  ],
  cmn_department: [
    "sys_id",
    "sys_domain",
    "sys_updated_on",
    "name",
    "dept_head",
    "parent",
  ],
};

async function config() {
  const saved = await getConnectionConfig();
  if (!saved) throw new Error("ServiceNow connection is not configured");
  const url = new URL(saved.instanceUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("ServiceNow URL must be a plain HTTPS origin");
  const origin = url.origin;
  const username = saved.username;
  const password = saved.password;
  if (!username || !password)
    throw new Error(
      "ServiceNow read-only username/password are not configured",
    );
  return {
    origin,
    auth: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    domainMode: saved.domainMode,
  };
}

async function request(path: string) {
  const { origin, auth } = await config();
  const response = await fetch(`${origin}${path}`, {
    headers: { Authorization: auth, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`ServiceNow read failed (${response.status})`);
  const body = (await response.json()) as { result: SnowRecord[] };
  const totalHeader = response.headers.get("x-total-count");
  const total = totalHeader === null ? null : Number(totalHeader);
  if (
    !Array.isArray(body.result) ||
    total === null ||
    !Number.isSafeInteger(total) ||
    total < 0
  )
    throw new Error(
      "ServiceNow did not provide a valid count; snapshot cannot be trusted",
    );
  return { result: body.result, total };
}

async function writeRequest(
  path: string,
  method: "DELETE" | "POST" | "PATCH",
  payload?: Record<string, unknown>,
) {
  const { origin, auth } = await config();
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: auth,
      Accept: "application/json",
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    result?: SnowRecord;
    error?: { message?: string };
  };
  if (!response.ok)
    throw new Error(
      `ServiceNow ${method} failed (${response.status})${body.error?.message ? `: ${body.error.message}` : ""}`,
    );
  return body.result ?? {};
}

async function readOne(path: string): Promise<SnowRecord | null> {
  const { origin, auth } = await config();
  const response = await fetch(`${origin}${path}`, {
    headers: { Authorization: auth, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`ServiceNow record read failed (${response.status})`);
  const body = (await response.json()) as { result?: SnowRecord };
  if (!body.result || Array.isArray(body.result))
    throw new Error("ServiceNow returned an invalid record response");
  return body.result;
}

export async function listReadableTables() {
  const data = await request(
    "/api/now/table/sys_db_object?sysparm_limit=10000&sysparm_no_count=false&sysparm_fields=name,label,super_class,sys_scope&sysparm_query=ORDERBYname",
  );
  return data.result
    .map((record) => field(record.name))
    .filter(Boolean)
    .sort();
}

async function listDictionaryFields(tables: string[]) {
  const encoded = encodeURIComponent(tables.join(","));
  const data = await request(
    `/api/now/table/sys_dictionary?sysparm_limit=10000&sysparm_no_count=false&sysparm_fields=name,element&sysparm_query=nameIN${encoded}`,
  );
  const fields = new Map<string, Set<string>>();
  for (const record of data.result) {
    const table = field(record.name);
    const element = field(record.element);
    if (!table || !element) continue;
    const current = fields.get(table) ?? new Set<string>();
    current.add(element);
    fields.set(table, current);
  }
  return fields;
}

function requestedTables() {
  const configured = process.env.SAOS_SCAN_TABLES?.split(",")
    .map((table) => table.trim())
    .filter(Boolean);
  return configured?.length ? [...new Set(configured)] : [...deepScanTables];
}

function sourcePayload(record: SnowRecord) {
  return Object.fromEntries(
    Object.entries(record).map(([key, val]) => [key, field(val)]),
  );
}

const field = (value: unknown) =>
  typeof value === "object" && value !== null && "value" in value
    ? String((value as { value: unknown }).value ?? "")
    : String(value ?? "");

export async function testConnection() {
  const data = await request(
    "/api/now/table/cmdb_ci?sysparm_limit=1&sysparm_no_count=false&sysparm_fields=sys_id,name,sys_domain",
  );
  return {
    connected: true,
    visibleCiCount: data.total,
    sampleCount: data.result.length,
  };
}

export async function readRecord(
  table: string,
  sysId: string,
  fields?: string[],
) {
  const fieldsParam =
    fields && fields.length > 0
      ? `?sysparm_fields=${fields.join(",")}&sysparm_display_value=false`
      : "?sysparm_display_value=false";
  const data = await readOne(
    `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}${fieldsParam}`,
  );
  return data ? sourcePayload(data) : null;
}

export async function patchRecord(
  table: string,
  sysId: string,
  fields: Record<string, unknown>,
) {
  // Disallow forbidden internal fields
  const forbidden = new Set([
    "sys_id",
    "sys_domain",
    "sys_created_on",
    "sys_created_by",
    "sys_mod_count",
  ]);
  const safeFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!forbidden.has(k) && v !== undefined) {
      safeFields[k] = v;
    }
  }
  const result = await writeRequest(
    `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`,
    "PATCH",
    safeFields,
  );
  return {
    sysId,
    table,
    operation: "patch_record" as const,
    updated: result,
  };
}

export async function readRelationship(sysId: string) {
  const data = await readOne(
    `/api/now/table/cmdb_rel_ci/${encodeURIComponent(sysId)}?sysparm_fields=sys_id,sys_domain,sys_updated_on,parent,child,type&sysparm_display_value=false`,
  );
  return data ? sourcePayload(data) : null;
}

export async function deleteRelationship(sysId: string) {
  await writeRequest(
    `/api/now/table/cmdb_rel_ci/${encodeURIComponent(sysId)}`,
    "DELETE",
  );
  return { sysId, operation: "delete_relationship" as const };
}

export async function deleteRecord(table: string, sysId: string) {
  await writeRequest(
    `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`,
    "DELETE",
  );
  return { sysId, table, operation: "delete_record" as const };
}

export async function createRecord(table: string, fields: Record<string, unknown>) {
  const result = await writeRequest(
    `/api/now/table/${encodeURIComponent(table)}`,
    "POST",
    fields,
  );
  return { table, sysId: field(result.sys_id), operation: "create_record" as const };
}

export async function createRelationship(
  parent: string,
  child: string,
  type: string,
) {
  const result = await writeRequest("/api/now/table/cmdb_rel_ci", "POST", {
    parent,
    child,
    type,
  });
  return {
    sysId: field(result.sys_id) || null,
    operation: "create_relationship" as const,
  };
}

export async function restoreRelationship(payload: Record<string, unknown>) {
  const safePayload = Object.fromEntries(
    ["sys_id", "sys_domain", "parent", "child", "type"].flatMap((key) =>
      payload[key] === undefined || payload[key] === ""
        ? []
        : [[key, String(payload[key])]],
    ),
  );
  const result = await writeRequest(
    "/api/now/table/cmdb_rel_ci",
    "POST",
    safePayload,
  );
  return {
    sysId: field(result.sys_id) || null,
    operation: "restore_relationship" as const,
  };
}

export async function syncServiceNow(
  onProgress?: (progress: {
    phase?: string;
    currentAgent?: string;
    currentTable?: string;
    progress?: number;
    total?: number;
    message?: string;
  }) => Promise<void> | void,
) {
  const { origin, domainMode } = await config();
  const requested = requestedTables();
  const readable = await listReadableTables();
  const readableSet = new Set(readable);
  const tables = requested.filter((table) => readableSet.has(table));
  const missing = new Set(requested.filter((table) => !readableSet.has(table)));
  const tableErrors: Record<string, string> = {};
  const completeTables: string[] = [];
  if (!tables.length)
    throw new Error(
      "No allowed scan tables are readable. Grant read access to sys_db_object and the SAOS scope tables, then retry.",
    );
  // Dictionary metadata can itself be ACL-filtered or paginated. Mandatory
  // fields for supported rules are requested explicitly below.
  const dictionaryFields = await listDictionaryFields(tables).catch(
    () => new Map<string, Set<string>>(),
  );
  const records: {
    table: string;
    sysId: string;
    domain: string;
    payload: Record<string, unknown>;
    updated: string;
  }[] = [];
  const ciDomainById = new Map<string, string | null>();
  for (let tableIdx = 0; tableIdx < tables.length; tableIdx++) {
    const table = tables[tableIdx];
    const firstRecord = records.length;
    try {
      await onProgress?.({
        phase: "extract",
        currentAgent: "Extraction",
        currentTable: table,
        progress: 0,
        total: 0,
        message: `Reading ${table} (table ${tableIdx + 1} of ${tables.length})`,
      });
      let expected = -1;
      const seen = new Set<string>();
      const maxRecords = 100_000;
      for (let offset = 0; offset < maxRecords; offset += 500) {
        const dictionary = dictionaryFields.get(table) ?? new Set<string>();
        const fieldsForTable = safeFieldCandidates.filter(
          (candidate) =>
            (table !== "sn_hr_core_case" ||
              !["name", "short_description"].includes(candidate)) &&
            (candidate === "sys_id" ||
              candidate === "sys_updated_on" ||
              dictionary.has(candidate)),
        );
        // CMDB checks require these fields to be explicitly present. If a
        // dictionary ACL hides them, the source is rejected rather than guessed.
        const tableRequired = requiredFieldsByTable[table] ?? ["sys_id"];
        const required = tableRequired.filter(
          (candidate) =>
            ["sys_id", "sys_domain", "sys_updated_on"].includes(candidate) ||
            dictionary.size === 0 ||
            dictionary.has(candidate),
        );
        const fields = [...new Set([...fieldsForTable, ...required])].join(",");
        const data = await request(
          `/api/now/table/${table}?sysparm_limit=500&sysparm_offset=${offset}&sysparm_no_count=false&sysparm_fields=${fields}&sysparm_display_value=false&sysparm_query=ORDERBYsys_id`,
        );
        if (expected < 0) expected = data.total;
        if (expected > maxRecords)
          throw new Error(
            `${table} has ${expected} records, above the ${maxRecords} record safety limit`,
          );
        const currentCount = Math.min(offset + data.result.length, data.total);
        await onProgress?.({
          phase: "extract",
          currentAgent: "Extraction",
          currentTable: table,
          progress: currentCount,
          total: data.total,
          message: `Read ${currentCount.toLocaleString()} of ${data.total.toLocaleString()} ${table} records (table ${tableIdx + 1}/${tables.length})`,
        });
        if (data.total !== expected)
          throw new Error(`${table} changed during pagination; retry sync`);
        for (const record of data.result) {
          const sysId = field(record.sys_id);
          if (!sysId || seen.has(sysId))
            throw new Error(
              `${table} returned missing or duplicate record ID; snapshot discarded`,
            );
          seen.add(sysId);
          if (
            table === "cmdb_rel_ci" &&
            !["parent", "child", "type"].every((name) =>
              Object.hasOwn(record, name),
            )
          )
            throw new Error(
              "Relationship fields are not readable; snapshot discarded",
            );
          if (
            table === "cmdb_ci" &&
            !["assigned_to", "owned_by", "managed_by", "support_group"].every(
              (name) => Object.hasOwn(record, name),
            )
          )
            throw new Error(
              "Ownership fields are not readable; snapshot discarded",
            );
          if (
            table === "cmdb_ci" &&
            !Object.hasOwn(record, "sys_domain") &&
            domainMode !== "global"
          )
            throw new Error(
              "Domain field is unavailable on cmdb_ci; choose Global mode only if this instance is not domain-separated",
            );
          const payload = sourcePayload(record);
          let domain =
            field(record.sys_domain) || "global";
          if (
            table === "cmdb_rel_ci" &&
            domain === "unknown" &&
            domainMode === "separated"
          ) {
            const parentDomain = ciDomainById.get(field(record.parent));
            const childDomain = ciDomainById.get(field(record.child));
            if (parentDomain && childDomain && parentDomain === childDomain) {
              domain = parentDomain;
              payload._saosDomainBasis = "matching visible CI endpoints";
            } else {
              payload._saosDomainBasis =
                "unknown; relationship checks withheld";
            }
          }
          if (table === "cmdb_ci") {
            const prior = ciDomainById.get(sysId);
            ciDomainById.set(sysId, prior && prior !== domain ? null : domain);
          }
          records.push({
            table,
            sysId,
            domain,
            payload,
            updated: field(record.sys_updated_on),
          });
        }
        if (offset + 500 >= expected) break;
      }
      if (seen.size !== expected)
        throw new Error(
          `${table}: ${expected - seen.size} records were not readable; snapshot discarded`,
        );
      completeTables.push(table);
    } catch (error) {
      // A single optional module must not discard a verified CMDB snapshot.
      // It is excluded entirely, with a persisted and visible coverage gap.
      records.splice(firstRecord);
      if (table === "cmdb_ci" || table === "cmdb_rel_ci") throw error;
      missing.add(table);
      tableErrors[table] =
        error instanceof Error ? error.message : "Read failed";
      await onProgress?.({
        phase: "extract",
        currentAgent: "Extraction",
        currentTable: table,
        message: `Skipped ${table}: ${tableErrors[table]}`,
      });
    }
  }
  const db = await getDb();
  const nextVersion = (await getTwinVersion()) + 1;
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO twin_object_history(id,table_name,sys_id,domain_id,twin_version,payload,source_updated_at) SELECT id,table_name,sys_id,domain_id,twin_version,payload,source_updated_at FROM twin_objects ON CONFLICT DO NOTHING",
    );
    await tx.query("DELETE FROM twin_objects");
    for (const record of records)
      await tx.query(
        "INSERT INTO twin_objects(id,table_name,sys_id,domain_id,twin_version,payload,source_updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          `${record.table}:${record.sysId}:${record.domain}`,
          record.table,
          record.sysId,
          record.domain,
          nextVersion,
          JSON.stringify(record.payload),
          record.updated,
        ],
      );
    await tx.query("UPDATE meta SET value=$1 WHERE key='twin_version'", [
      String(nextVersion),
    ]);
    await tx.query(
      "INSERT INTO meta(key,value) VALUES('source_origin',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [origin],
    );
    await tx.query(
      "INSERT INTO meta(key,value) VALUES('source_tables',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [JSON.stringify(completeTables)],
    );
    await tx.query(
      "INSERT INTO meta(key,value) VALUES('source_missing_tables',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [JSON.stringify([...missing])],
    );
    await tx.query(
      "INSERT INTO meta(key,value) VALUES('source_table_errors',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [JSON.stringify(tableErrors)],
    );
    await tx.query(
      "UPDATE remediation_plans SET status='Proposed',preview=NULL,approved_by=NULL,source_twin_version=$1,updated_at=now() WHERE source_twin_version<>$1 AND status!='Applied'",
      [nextVersion],
    );
    await appendAuditTx(tx, "TWIN_SYNC_COMPLETED", {
      twinVersion: nextVersion,
      counts: Object.fromEntries(
        completeTables.map((t) => [
          t,
          records.filter((r) => r.table === t).length,
        ]),
      ),
      skippedTables: [...missing],
    });
  });
  return {
    twinVersion: nextVersion,
    count: records.length,
    completeTables,
    skippedTables: [...missing],
    tableErrors,
  };
}
