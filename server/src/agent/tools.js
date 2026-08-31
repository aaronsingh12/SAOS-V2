import { table, testConnection } from '../servicenow/client.js';
import { getSchema, toCompactSchema, referenceLookup, tableLookup } from '../servicenow/schema.js';
import { catalog } from '../servicenow/catalog.js';
import { flows, designFlowBlueprint } from '../servicenow/flows.js';
import { capability, createLiveFlow, listManaged, removeManaged, smokeRun, verify } from '../servicenow/fluent.js';
import { listSlas, getSla, slaMeta, createSla, verifySla } from '../servicenow/sla.js';
import { listPoliciesForItem, itemVariables, createPolicy, CONDITION_OPERATORS } from '../servicenow/catalogPolicy.js';
import { aclReport, aclDiff, explainAclReport } from '../servicenow/acl.js';
import { search } from '../memory/recall.js';
import { recordCalculatedFields, listFacts, recordFact } from '../memory/facts.js';
import { listApplications } from '../servicenow/applications.js';
import { listCapturedSets, setContents } from '../servicenow/transport.js';
import { createApplication, vendorPrefix, suggestScopeName, validateScopeName, studioSteps, MAX_SCOPE_LENGTH } from '../servicenow/app-create.js';
import { startImpersonation, endImpersonation, switchImpersonation, impersonationStatus } from './impersonation-ops.js';
import { whoReallyDid, impersonationAuditForSession, impersonationAuditForTarget } from '../memory/impersonation-audit.js';
import { writeAsCurrentIdentity } from './impersonated-write.js';
import { getDbaContext } from '../servicenow/dba-context.js';
import { metaQuery } from '../servicenow/dba-metadata.js';
import {
  getTable as dbaGetTable,
  listFields as dbaListFields,
  getField as dbaGetField,
  getHierarchy as dbaGetHierarchy,
  getReferences as dbaGetReferences,
  resolveReference as dbaResolveReference,
  dotWalk as dbaDotWalk,
  classify as dbaClassify,
  resolveIdentifier as dbaResolveIdentifier,
  listChoices as dbaListChoices,
  getRelationships as dbaGetRelationships,
  listIndexes as dbaListIndexes,
  generateSchemaMap as dbaSchemaMap,
} from '../servicenow/dba-schema.js';
import {
  analyzeImpact as dbaAnalyzeImpact,
  classifyOperation as dbaClassifyOperation,
  checkIntegrity as dbaCheckIntegrity,
  preflight as dbaPreflight,
} from '../servicenow/dba-impact.js';
import { appendMutation, mutationsForSession } from '../memory/ledger.js';

const cellValue = (c) => (c && typeof c === 'object' && 'value' in c ? c.value : c);

/**
 * WI-5 — the application-creation capability boundary.
 *
 * Measured in the transcript: `create_record` on `sys_scope` produced a record
 * with `sys_class_name: "sys_scope"`, `scope: ""` and no version — a HUSK. It
 * never appears in Studio's application list and nothing can be developed in
 * it. Worse, the model had correctly refused one turn earlier, then complied
 * with invented field values, so guidance alone demonstrably does not hold.
 *
 * A real custom application is a `sys_app` record (which extends `sys_scope`)
 * with a technical `scope` name of the form `x_<vendor>_<name>`, a version and
 * a vendor prefix — created through Studio or the SDK, never by inserting the
 * parent table over REST.
 */
const UNCREATABLE_TABLES = {
  sys_scope: 'application scope',
  sys_app: 'custom application',
};

export function assertCreatableTable(t) {
  const label = UNCREATABLE_TABLES[String(t || '').trim()];
  if (!label) return;
  throw Object.assign(new Error(
    `create_record cannot create ${label === 'custom application' ? 'a custom application' : 'an application scope'}. Inserting into ${t} over REST produces a non-functional husk, `
    + 'not an application: sys_class_name stays "sys_scope" instead of becoming "sys_app", the technical '
    + '`scope` name is empty (a real one looks like x_<vendor>_<name>), there is no version, and Studio will '
    + 'not list it — nothing can be developed inside it. '
    + 'Use the create_application tool instead: it goes through the ServiceNow SDK, which scaffolds a real '
    + 'sys_app with a valid scope name, version and vendor prefix. The manual route is All → Studio → '
    + 'Create Application. Do not submit an insert on this table.'
  ), { status: 422, detail: { table: t, reason: 'application-husk-guard', tool: 'create_record' } });
}

/**
 * WI-ACL-1 — the ACL write tools' `execute` must be UNREACHABLE, and must say so.
 *
 * `create_acl` / `update_acl` / `delete_acl` never execute: the orchestrator
 * intercepts their gated descriptor and routes the whole call through the
 * elevation pipeline before `executeTool` is reached. Leaving `execute` as a
 * REST write "just in case" would be the worst possible fallback — un-elevated
 * writes to `sys_security_acl` are denied SILENTLY (WI-1), so the tool would
 * report success while changing nothing, and a user would believe access had
 * been altered when it had not.
 *
 * So it throws. If the interception is ever removed, reordered, or the
 * classifier entry is dropped, this is a loud failure at the exact moment the
 * guarantee breaks — not a quiet no-op discovered later by someone who trusted
 * a green tick.
 */
function unreachableAclWrite(toolName) {
  return Object.assign(new Error(
    `${toolName} reached the ordinary tool path, which must never happen. ACL writes are only valid through the `
    + 'elevation gate (classifier -> eligibility -> spec validation -> approval -> elevated atomic write -> read-back). '
    + 'An un-elevated write to sys_security_acl is DENIED SILENTLY, so nothing was attempted rather than something '
    + 'appearing to work. This is a wiring defect in the orchestrator, not a problem with the request.'
  ), { status: 500, detail: { tool: toolName, reason: 'acl-write-bypassed-elevation-gate' } });
}

/**
 * The human-readable half of an ACL descriptor.
 *
 * `descriptor.requested` is what the pre-gate guards and the audit ledger see,
 * so it holds the REQUEST in the user's terms (roles by name, the table, the
 * operation) rather than `sys_security_acl` column values — which at this point
 * do not exist yet, and which would not tell a reader what the rule does even
 * once they did. The resolved column payload is built later, after validation.
 */
function aclDescriptorSummary(input = {}) {
  const summary = {};
  for (const k of ['table', 'field', 'operation', 'decision_type', 'data_condition', 'script', 'applies_to', 'description', 'scope']) {
    if (input[k] !== undefined && input[k] !== null && input[k] !== '') summary[k] = String(input[k]);
  }
  for (const k of ['active', 'admin_overrides']) {
    if (input[k] !== undefined && input[k] !== null) summary[k] = String(input[k]);
  }
  if (Array.isArray(input.roles)) summary.roles = input.roles.join(', ');
  if (Array.isArray(input.security_attributes) && input.security_attributes.length) summary.security_attributes = input.security_attributes.join(', ');
  return summary;
}

/**
 * Tool registry — the agent's hands.
 * `mutating: true` tools are intercepted by the approval gate unless the user
 * has enabled auto-approve (same idea as Claude Code's permission prompts).
 *
 * `describeWrite(input, result)` — OPTIONAL, and only on mutators. It tells the
 * mutation pipeline what a tool actually wrote, so post-write verification
 * (WI-1) can diff the request against the record without guessing which part of
 * a tool's arguments was the payload. Shape:
 *
 *   { table, sys_id, operation: 'insert' | 'update' | 'delete', requested }
 *
 * Returning `null` means "not verifiable by field diff", and that is a real
 * answer rather than a gap: the SDK-backed tools (create_flow_live,
 * create_ui_policy) and the verifiers already read their work back off the
 * instance through their own paths, and forcing a second diff onto them would
 * report a shape mismatch as a lost write. Those say so in `verifiedBy`.
 */
export const TOOLS = [
  {
    name: 'test_connection',
    description: 'Verify the configured ServiceNow instance is reachable and authenticated.',
    mutating: false,
    inputSchema: { type: 'object', properties: {}, required: [] },
    execute: () => testConnection(),
  },
  {
    name: 'get_table_schema',
    description:
      'Get the field schema for any ServiceNow table, walking the inheritance chain (e.g. incident -> task). ' +
      'Returns EVERY field with its type, reference target, and mandatory flag — so if a field is not in the list, ' +
      'it does not exist on that table, and you can say so with confidence. Choice values are counted, not listed; ' +
      'pass expand:["state","priority"] to see the values for the specific fields you are about to write to. ' +
      'ALWAYS call this before creating or updating records on an unfamiliar table.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name, e.g. incident, sc_cat_item' },
        expand: {
          type: 'array',
          items: { type: 'string' },
          description: 'Field names whose choice values you need in full. Keep this short — name only the fields the current task touches.',
        },
        full: {
          type: 'boolean',
          description: 'Rarely needed. Returns labels, max lengths and defaults for every field as well — large enough to crowd out the rest of the conversation.',
        },
      },
      required: ['table'],
    },
    execute: async ({ table: t, expand, full }) => {
      const schema = await getSchema(t);
      // A-4 write path: fields the platform computes accept a write and then
      // discard it (trap #5's family). Recording them here means the next
      // session starts knowing, instead of rediscovering it by shipping a bug.
      try { recordCalculatedFields(t, schema); } catch { /* the ledger is never load-bearing for a read */ }
      /*
       * D-7 — compact by default, and the default is the correctness fix.
       *
       * MEASURED on dev442675: `incident` carries 91 fields and serialises to
       * 29,152 characters, about 8,330 tokens. The agent's history budget at
       * the time was 5,452, so one schema read was 153% of everything the
       * conversation could hold — and the orchestrator's 8,000-character result
       * cap hid that instead of fixing it. Fields are sorted alphabetically, so
       * the cut landed after `company`: the agent saw 26 of 91 fields, never
       * saw `state`, `priority` or `assignment_group`, and — because `u_`
       * fields sort last — could not observe that a custom field was ABSENT.
       *
       * Compact mode is 1,007 tokens for the same table, 8.3x smaller, with
       * every field name present. `full` stays for the UI and codegen paths
       * that genuinely need labels and defaults.
       */
      return full ? schema : toCompactSchema(schema, { expand });
    },
  },
  {
    name: 'lookup_reference',
    description:
      'Resolve a reference field value: search a table and get back ranked sys_id + display pairs. '
      + 'Use this to turn names like "Service Desk" or "Abel Tuter" into sys_ids BEFORE writing them into reference fields. Never invent sys_ids. '
      + 'Results are ranked exact-key > exact-display > starts-with > contains, and each carries a matchType: searching sys_user for "admin" '
      + 'matches the user whose user_name IS admin, not every display name containing the word. '
      + 'If the response says ambiguous:true, no single exact match was found and the top hit is a guess — CONFIRM it with the user before '
      + 'putting it in a mutation payload. Read-only use may proceed.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Referenced table, e.g. sys_user, sys_user_group, cmdb_ci' },
        search: { type: 'string', description: 'Text to search for' },
        limit: { type: 'number' },
      },
      required: ['table'],
    },
    execute: async ({ table: t, search, limit }) => {
      const rows = await referenceLookup(t, search || '', limit || 10);
      // The array's own properties do not survive JSON.stringify, and the
      // ambiguity verdict is the whole point of WI-4 — so it is lifted into an
      // object the model actually receives.
      return {
        table: t, search: search || '', ambiguous: rows.ambiguous, resolved: rows.resolved,
        ...(rows.confirmBefore ? { confirmBefore: rows.confirmBefore } : {}),
        results: [...rows],
      };
    },
  },
  {
    name: 'lookup_table',
    description: 'Find ServiceNow tables by name or label (searches sys_db_object). Use when you need the exact table name for a record producer, list collector, or flow trigger.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string' } },
      required: ['search'],
    },
    execute: ({ search }) => tableLookup(search),
  },
  {
    name: 'query_records',
    description:
      'Query any ServiceNow table with an encoded query. Returns records with both raw values and display values for every field (reference fields come back as {value: sys_id, display_value: label}).',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        query: { type: 'string', description: 'ServiceNow encoded query, e.g. active=true^priority=1' },
        fields: { type: 'string', description: 'Comma-separated field list (keep results small)' },
        limit: { type: 'number' },
        order_by_desc: { type: 'string' },
      },
      required: ['table'],
    },
    execute: ({ table: t, query, fields, limit, order_by_desc }) =>
      table.query(t, { query, fields, limit: Math.min(limit || 10, 50), orderByDesc: order_by_desc }),
  },
  {
    name: 'get_record',
    description: 'Fetch a single record by sys_id from any table.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, sys_id: { type: 'string' } },
      required: ['table', 'sys_id'],
    },
    execute: ({ table: t, sys_id }) => table.get(t, sys_id),
  },
  {
    name: 'create_record',
    description:
      'Create a record in any ServiceNow table. Reference fields must contain sys_ids you resolved with lookup_reference. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        data: { type: 'object', description: 'Field/value pairs' },
        force: {
          type: 'boolean',
          description:
            'Only set this after a write was reported as silently dropped AND you have stated a CHANGED strategy. '
            + 'It re-submits a write the harness has proof does not land. Retrying identically without a change wastes an approval.',
        },
      },
      required: ['table', 'data'],
    },
    // B7 — routes through the impersonation wrapper while mode is active, so
    // the record is created BY the impersonated user rather than merely on
    // their behalf. Nothing changes when mode is off.
    impersonable: true,
    execute: ({ table: t, data }, ctx = {}) => {
      assertCreatableTable(t);
      return writeAsCurrentIdentity({
        ctx, tool: 'create_record', table: t, operation: 'create', data,
        direct: () => table.create(t, data),
      });
    },
    describeWrite: ({ table: t, data }, result) => ({
      table: t, operation: 'insert', requested: data || {}, sys_id: cellValue(result?.sys_id),
    }),
  },
  {
    name: 'update_record',
    description: 'Update a record by sys_id. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        sys_id: { type: 'string' },
        data: { type: 'object' },
        force: {
          type: 'boolean',
          description:
            'Only set this after a write was reported as silently dropped AND you have stated a CHANGED strategy. '
            + 'It re-submits a write the harness has proof does not land. Retrying identically without a change wastes an approval.',
        },
      },
      required: ['table', 'sys_id', 'data'],
    },
    impersonable: true,
    execute: ({ table: t, sys_id, data }, ctx = {}) => writeAsCurrentIdentity({
      ctx, tool: 'update_record', table: t, sysId: sys_id, operation: 'update', data,
      direct: () => table.update(t, sys_id, data),
    }),
    describeWrite: ({ table: t, sys_id, data }) => ({
      table: t, operation: 'update', requested: data || {}, sys_id,
    }),
  },
  {
    name: 'delete_record',
    description: 'Delete a record by sys_id. Destructive — requires user approval. Confirm intent with the user before calling.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, sys_id: { type: 'string' } },
      required: ['table', 'sys_id'],
    },
    impersonable: true,
    execute: ({ table: t, sys_id }, ctx = {}) => writeAsCurrentIdentity({
      ctx, tool: 'delete_record', table: t, sysId: sys_id, operation: 'delete',
      direct: () => table.remove(t, sys_id),
    }),
    describeWrite: ({ table: t, sys_id }) => ({ table: t, operation: 'delete', requested: {}, sys_id }),
  },
  {
    name: 'create_incident',
    description:
      'Convenience tool to create an incident. Resolve caller/assignment_group/assigned_to to sys_ids first via lookup_reference. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        short_description: { type: 'string' },
        description: { type: 'string' },
        caller_id: { type: 'string', description: 'sys_id of a sys_user' },
        assignment_group: { type: 'string', description: 'sys_id of a sys_user_group' },
        assigned_to: { type: 'string', description: 'sys_id of a sys_user' },
        urgency: { type: 'string', description: '1|2|3' },
        impact: { type: 'string', description: '1|2|3' },
        category: { type: 'string' },
      },
      required: ['short_description'],
    },
    execute: (input) => table.create('incident', input),
    describeWrite: (input, result) => ({
      table: 'incident', operation: 'insert', requested: input || {}, sys_id: cellValue(result?.sys_id),
    }),
  },
  {
    name: 'create_catalog_item',
    description:
      'Composite builder: create a catalog item WITH its variables (and their choices) in one shot. Variable types: 1 Yes/No, 2 Multi Line Text, 3 Multiple Choice, 5 Select Box, 6 Single Line Text, 7 Checkbox, 8 Reference (set reference_table), 9 Date, 10 Date/Time, 21 List Collector (set reference_table), 25 Masked, 26 Email. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        short_description: { type: 'string' },
        description: { type: 'string' },
        category: { type: 'string', description: 'sys_id of sc_category (optional; resolve via lookup_reference on sc_category)' },
        variables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'internal name, snake_case' },
              question_text: { type: 'string' },
              type: { type: 'number', description: 'variable type code' },
              mandatory: { type: 'boolean' },
              reference_table: { type: 'string', description: 'for type 8 / 21' },
              choices: {
                type: 'array',
                items: { type: 'object', properties: { text: { type: 'string' }, value: { type: 'string' } } },
              },
            },
            required: ['name', 'type'],
          },
        },
      },
      required: ['name', 'short_description'],
    },
    execute: (input) => catalog.createCatalogItemComposite(input),
    describeWrite: (input, result) => ({
      table: 'sc_cat_item', operation: 'insert', sys_id: result?.item?.sys_id,
      // Only the item's own fields — `variables` is a child collection, and
      // diffing it against the item record would report every one as dropped.
      requested: {
        name: input?.name, short_description: input?.short_description,
        ...(input?.description ? { description: input.description } : {}),
        ...(input?.category ? { category: input.category } : {}),
      },
    }),
  },
  {
    name: 'create_record_producer',
    description: 'Create a record producer targeting a table (resolve exact table name with lookup_table first). Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        table_name: { type: 'string' },
        short_description: { type: 'string' },
        script: { type: 'string' },
      },
      required: ['name', 'table_name'],
    },
    execute: (input) => catalog.createRecordProducer(input),
    describeWrite: (input, result) => ({
      table: 'sc_cat_item_producer', operation: 'insert', sys_id: cellValue(result?.sys_id),
      requested: {
        name: input?.name, table_name: input?.table_name,
        ...(input?.short_description ? { short_description: input.short_description } : {}),
        ...(input?.script ? { script: input.script } : {}),
      },
    }),
  },
  {
    name: 'list_flows',
    description: 'List Flow Designer flows on the instance (name, active, status, scope).',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string' }, active_only: { type: 'boolean' } },
      required: [],
    },
    execute: ({ search, active_only }) => flows.list({ search, activeOnly: active_only }),
  },
  {
    name: 'get_flow',
    description: 'Read one flow top-to-bottom: header, trigger instances, ordered action instances, and flow logic blocks.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { sys_id: { type: 'string' } },
      required: ['sys_id'],
    },
    execute: ({ sys_id }) => flows.detail(sys_id),
  },
  {
    name: 'design_flow_blueprint',
    description:
      'DESIGN STEP. Turn a plain-language automation request into a precise flow blueprint: trigger, exact actions, configs, reference fields, and a test plan. Use this to think through and show the design before building. To actually build it on the instance, pass the blueprint to create_flow_live.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { description: { type: 'string' } },
      required: ['description'],
    },
    execute: ({ description }) => designFlowBlueprint(description),
  },
  {
    name: 'flow_authoring_capability',
    description:
      'Check whether live Flow Designer authoring is available: ServiceNow SDK present, credentials stored, workspace healthy. Call this before promising to build a real flow. If ok is false, the returned fixes[] carry the exact commands, and the Business Rule fallback becomes the only option.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { deep: { type: 'boolean', description: 'Also run an authenticated probe against the instance (slower, ~8s)' } },
      required: [],
    },
    execute: ({ deep }) => capability({ deep: Boolean(deep) }),
  },
  {
    name: 'create_flow_live',
    description:
      'BUILD STEP. Create or UPDATE a REAL, active Flow Designer flow on the instance from a plain-language description or a blueprint from design_flow_blueprint. Generates Fluent TypeScript, compiles it offline (nothing reaches the instance unless it compiles), installs it, and reads the result back. Returns the flow name, sys_id, type and link. Requires user approval. Note: installing deploys the whole managed application, so the response lists every artifact shipped. ' +
      'TO CHANGE AN EXISTING FLOW — adding a step, a condition, a branch — pass its EXACT current name as `updates`, and describe the flow as it should be when finished. Editing in place keeps the same sys_id. Creating a second flow instead collides with the first on its element keys and fails. Use list_live_flows to get the exact name. ' +
      'TO BUILD A REUSABLE SUBFLOW — the request says "create a subflow", or describes a callable unit with named inputs and no trigger — pass artifact_type: "subflow" and state its inputs and outputs in the description. A subflow has no trigger; it is invoked by other flows. ' +
      'BEFORE BUILDING A FLOW, call list_live_flows: if a managed subflow already does part of the work, describe the flow as CALLING it by name. Generating a second subflow with the same inputs is rejected before the build.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Plain-language automation request, describing the finished flow' },
        blueprint: { type: 'object', description: 'A blueprint object previously returned by design_flow_blueprint' },
        updates: {
          type: 'string',
          description:
            'Exact name of an existing managed flow or subflow to edit IN PLACE, keeping its sys_id. Omit when creating something new.',
        },
        artifact_type: {
          type: 'string',
          enum: ['flow', 'subflow'],
          description:
            'What to build. "flow" (default) has exactly one trigger. "subflow" is a reusable callable unit with typed inputs and outputs and NO trigger — use it when the request asks for a subflow, or for something other flows will call. On an edit this is ignored: an artifact cannot change kind.',
        },
      },
      required: [],
    },
    execute: async ({ description, blueprint, updates, artifact_type: artifactType }) => {
      const spec = description || (blueprint ? JSON.stringify(blueprint, null, 1) : null);
      if (!spec) throw new Error('Provide either description or blueprint.');
      return createLiveFlow(spec, () => {}, { updates: updates || null, artifactType: artifactType || null });
    },
  },
  {
    name: 'list_live_flows',
    description:
      'List the flows and subflows NowHelpAssist manages as Fluent source, with their current state on the instance. ' +
      'Each subflow carries its I/O CONTRACT (input and output names, types and reference tables) and each artifact carries ' +
      'its dependency edges: `calls` and `calledBy`. Read this BEFORE building a flow — if a subflow already does part of ' +
      'the work, the new flow should call it rather than re-implement it — and before deleting anything, because a subflow ' +
      'with callers cannot be removed.',
    mutating: false,
    inputSchema: { type: 'object', properties: {}, required: [] },
    execute: () => listManaged(),
  },
  {
    name: 'delete_live_flow',
    description:
      'Delete a NowHelpAssist-managed flow or subflow by name: removes its Fluent source, reinstalls, and confirms it is gone from the instance. Destructive — confirm with the user in conversation first. Requires user approval. ' +
      'A subflow that a managed flow still calls is REFUSED, with the callers named: delete or edit those callers first, then remove the subflow.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact flow/subflow name' } },
      required: ['name'],
    },
    execute: ({ name }) => removeManaged(name),
  },
  {
    name: 'verify_flow_live',
    description:
      'SEMANTIC VERIFICATION. Prove a deployed artifact actually does what was asked, then delete the test data. ' +
      'A record-triggered FLOW is fired by creating a record that matches its trigger. A SUBFLOW has no trigger, so it is CALLED: ' +
      'a one-shot scheduled job invokes it through sn_fd.FlowAPI with the test inputs in its spec, and both its effects on records and ' +
      'the values it RETURNS are asserted. Compiling only proves an artifact is well-formed — this proves it is correct. ' +
      'Writes real records, so it needs its own approval and never runs automatically after a deploy.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact flow name as deployed' } },
      required: ['name'],
    },
    execute: ({ name }) => verify(name),
  },
  {
    name: 'smoke_test_flow',
    description:
      'Optionally verify a deployed record-triggered flow by creating a test record that matches its trigger, waiting for a sys_flow_context execution, then deleting the test record. This writes real data, is NEVER part of a deploy, and needs its own approval. Resolve any reference values to sys_ids with lookup_reference first.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table to create the test record on, e.g. incident' },
        values: { type: 'object', description: 'Field values chosen to satisfy the flow trigger condition' },
        wait_ms: { type: 'number', description: 'How long to wait for an execution (default 45000)' },
      },
      required: ['table', 'values'],
    },
    execute: ({ table: t, values, wait_ms }) => smokeRun({ table: t, values, waitMs: wait_ms || 45000 }),
  },
  {
    name: 'get_catalog_item',
    description:
      'Read a catalog item top to bottom: its variables in order (with type, mandatory flag, help text, default, and the REAL choice values for choice-type variables), plus every UI policy scoped to it. Call this before proposing any change to an item — variable sys_ids and choice VALUES are what conditions and actions are built from, and neither can be guessed.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { sys_id: { type: 'string', description: 'sys_id of the sc_cat_item (resolve the name with lookup_reference on sc_cat_item)' } },
      required: ['sys_id'],
    },
    execute: async ({ sys_id }) => {
      const [item, policies] = await Promise.all([catalog.getItemDeep(sys_id), listPoliciesForItem(sys_id)]);
      return {
        item: { sys_id, name: item.item?.name?.display_value ?? item.item?.name, active: item.item?.active?.value },
        variables: policies.variables,
        variableSets: item.variableSets?.map((s) => ({ title: s.title?.display_value ?? s.title, variables: (s._variables || []).length })) || [],
        policies: policies.policies,
      };
    },
  },
  {
    name: 'add_catalog_variable',
    description:
      'Add one variable to an EXISTING catalog item. For a choice type (3 Multiple Choice, 5 Select Box, 18 Lookup Select Box, 22 Lookup Multiple Choice) pass choices — a choice with no value cannot be referenced by a UI policy condition. Call get_catalog_item first so the order does not collide. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        cat_item: { type: 'string', description: 'sys_id of the catalog item' },
        name: { type: 'string', description: 'internal name, snake_case' },
        question_text: { type: 'string' },
        type: { type: 'number', description: 'variable type code — read the real list from the catalog meta rather than assuming' },
        mandatory: { type: 'boolean' },
        order: { type: 'number' },
        help_text: { type: 'string' },
        default_value: { type: 'string' },
        reference_table: { type: 'string', description: 'for type 8 (Reference) / 21 (List Collector)' },
        choices: {
          type: 'array',
          items: { type: 'object', properties: { text: { type: 'string' }, value: { type: 'string' } } },
        },
      },
      required: ['cat_item', 'name', 'type'],
    },
    execute: ({ cat_item, ...v }) => catalog.createVariable({ cat_item }, v),
    describeWrite: ({ cat_item, ...v }, result) => ({
      table: 'item_option_new', operation: 'insert',
      // `cat_item` is the parent, not a field of the variable record.
      requested: v || {}, sys_id: cellValue(result?.variable?.sys_id),
    }),
  },
  {
    name: 'update_catalog_variable',
    description:
      'Update one variable in place: question_text, order, mandatory, help_text, default_value. Use this rather than deleting and recreating — a recreated variable gets a NEW sys_id, and every UI policy condition and action that names the old one silently stops matching. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        sys_id: { type: 'string', description: 'sys_id of the item_option_new record' },
        question_text: { type: 'string' },
        order: { type: 'number' },
        mandatory: { type: 'boolean' },
        help_text: { type: 'string' },
        default_value: { type: 'string' },
      },
      required: ['sys_id'],
    },
    execute: async ({ sys_id, ...patch }) => {
      const data = {};
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        data[k] = typeof v === 'boolean' ? String(v) : String(v);
      }
      if (!Object.keys(data).length) throw new Error('Nothing to update — pass at least one field.');
      const before = await table.get('item_option_new', sys_id);
      await catalog.updateVariable(sys_id, data);
      const after = await table.get('item_option_new', sys_id);
      // Read-back, because a write to a field that does not exist is accepted
      // and discarded rather than refused.
      const mismatches = Object.entries(data)
        .map(([f, want]) => ({ field: f, sent: want, stored: after?.[f]?.value ?? after?.[f] }))
        .filter((m) => String(m.stored) !== String(m.sent));
      return {
        ok: mismatches.length === 0,
        sys_id,
        name: after?.name?.value ?? after?.name,
        changed: Object.fromEntries(Object.keys(data).map((f) => [f, {
          from: before?.[f]?.value ?? before?.[f], to: after?.[f]?.value ?? after?.[f],
        }])),
        mismatches,
      };
    },
  },
  {
    name: 'list_ui_policies',
    description:
      'List the catalog UI policies scoped to one item, with their conditions decoded into readable form (which variable, which operator, which value) and their actions. Also reports problems NowHelpAssist can see without running the form: a condition on a variable that is not on the item, a value the variable cannot hold, or an action that leaves everything on "ignore" and therefore does nothing.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { cat_item: { type: 'string', description: 'sys_id of the catalog item' } },
      required: ['cat_item'],
    },
    execute: ({ cat_item }) => listPoliciesForItem(cat_item),
  },
  {
    name: 'create_ui_policy',
    description:
      'Create a catalog UI policy that shows, hides, requires or freezes a variable in response to another variable. Conditions and actions both address variables by their item_option_new sys_id, which you must read with get_catalog_item first — a condition naming anything else can never be satisfied, and NowHelpAssist refuses it rather than writing a policy that saves and does nothing. Choice values are checked against the variable real choices for the same reason. IMPORTANT: this compiles and installs through the ServiceNow SDK and takes about a minute, because catalog_ui_policy_action cannot be written over REST at all — a POST returns 201 and silently discards the fields that attach the action to its policy. Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        catalog_item: { type: 'string', description: 'sys_id of the catalog item' },
        short_description: { type: 'string', description: 'The policy name, e.g. "Require justification for permanent access"' },
        conditions: {
          type: 'array',
          description: 'WHEN. Every entry names a variable by sys_id.',
          items: {
            type: 'object',
            properties: {
              variable: { type: 'string', description: 'item_option_new sys_id of the variable being tested' },
              operator: { type: 'string', description: 'One of: =, !=, IN, NOT IN, ISEMPTY, ISNOTEMPTY, LIKE, STARTSWITH' },
              value: { type: 'string', description: 'For a choice variable this must be the choice VALUE, not its display text' },
              join: { type: 'string', description: 'AND (default) | OR' },
            },
            required: ['variable', 'operator'],
          },
        },
        actions: {
          type: 'array',
          description: 'THEN. Each state is the string "true", "false" or "ignore" — "ignore" means leave alone, and an action left entirely on ignore does nothing.',
          items: {
            type: 'object',
            properties: {
              variable: { type: 'string', description: 'item_option_new sys_id of the variable being changed' },
              visible: { type: 'string', description: 'true | false | ignore' },
              mandatory: { type: 'string', description: 'true | false | ignore' },
              disabled: { type: 'string', description: 'true | false | ignore — "disabled" is read-only' },
            },
            required: ['variable'],
          },
        },
        reverse_if_false: { type: 'boolean', description: 'Put the variables back when the condition stops being true. Default true, and almost always what "only when" means.' },
        active: { type: 'boolean' },
        order: { type: 'number' },
      },
      required: ['catalog_item', 'short_description', 'conditions', 'actions'],
    },
    execute: (input) => createPolicy(input),
  },
  {
    name: 'list_slas',
    description:
      'List SLA definitions (contract_sla) on the instance: name, table, duration (decoded to seconds and a human form), schedule, and the start/stop/pause conditions. Read-only.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Match on name' },
        table: { type: 'string', description: 'Restrict to SLAs that run on this table, e.g. incident' },
        active_only: { type: 'boolean' },
      },
      required: [],
    },
    execute: ({ search, table: t, active_only }) => listSlas({ search, collection: t, activeOnly: active_only }),
  },
  {
    name: 'get_sla',
    description: 'Read one SLA definition top to bottom by name or sys_id, including whether its schedule is actually in effect.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact name, or a sys_id' } },
      required: ['name'],
    },
    execute: ({ name }) =>
      (/^[0-9a-f]{32}$/i.test(name)
        ? getSla(name)
        : listSlas({ search: name }).then((r) => r.find((x) => x.name === name) || r[0] || null)),
  },
  {
    name: 'sla_meta',
    description: 'Choice values, schedules and relative-duration types available for building an SLA definition on this instance. Call before create_sla so every value is real.',
    mutating: false,
    inputSchema: { type: 'object', properties: {}, required: [] },
    execute: () => slaMeta(),
  },
  {
    name: 'create_sla',
    description:
      'Create an SLA definition (contract_sla) on the instance. Every condition is checked field-by-field against the target table BEFORE anything is written — a start condition naming a field that does not exist is not an error on this platform, it is a WIDER condition, and the SLA then attaches to every record on the table. duration accepts "4h", "90m", "2d 4h", "4:00:00" or seconds. A schedule is only honoured when schedule_source is "sla_definition". Requires user approval.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        collection: { type: 'string', description: 'Table the SLA runs on, e.g. incident' },
        duration: { type: 'string', description: '"4h", "90m", "2d 4h", "4:00:00", or a number of seconds' },
        start_condition: { type: 'string', description: 'Encoded query on the target table. Required.' },
        stop_condition: { type: 'string', description: 'Encoded query on the target table' },
        pause_condition: { type: 'string', description: 'Encoded query on the target table' },
        type: { type: 'string', description: 'SLA | OLA | Underpinning contract' },
        target: { type: 'string', description: 'response | resolution' },
        schedule: { type: 'string', description: 'sys_id of a cmn_schedule (resolve with lookup_reference on cmn_schedule)' },
        schedule_source: { type: 'string', description: 'no_schedule | sla_definition | task_field. A schedule is IGNORED unless this is sla_definition.' },
        duration_type: { type: 'string', description: 'sys_id of a cmn_relative_duration, INSTEAD of a fixed duration' },
        timezone_source: { type: 'string' },
        retroactive: { type: 'boolean' },
        when_to_cancel: { type: 'string' },
        active: { type: 'boolean' },
      },
      required: ['name', 'collection', 'start_condition'],
    },
    execute: (input) => createSla(input),
  },
  {
    name: 'verify_sla_live',
    description:
      "SEMANTIC VERIFICATION for an SLA. Derives a record from the definition's OWN start condition (driving calculated fields through their inputs), creates it, confirms the platform agrees it matches, then asserts that a task_sla attached REFERENCING THIS DEFINITION with a planned_end of start + duration inside a stated tolerance — and deletes the record again, reading back to prove it is gone. Note that other SLAs on the instance attach to the same record, so \"an SLA attached\" is not the assertion; \"this one attached\" is. Writes real records, so it needs its own approval.",
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact SLA definition name, or a sys_id' },
        tolerance_sec: { type: 'number', description: 'Allowed drift on planned_end (default 120)' },
      },
      required: ['name'],
    },
    execute: ({ name, tolerance_sec }) => verifySla(name, () => {}, { toleranceSec: tolerance_sec || undefined }),
  },
  {
    name: 'acl_report',
    description:
      'Read the access control rules for a table: record and field ACLs across the whole inheritance chain, with operation, roles, condition, active flag, admin_overrides, and whether a script guards the rule. Read-only, and it never authors an ACL. If the ACL tables are not readable on this connection the report says so — an empty result is a visibility answer, not "this table has no ACLs".',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        inherited: { type: 'boolean', description: 'Include ACLs defined on parent tables (default true)' },
      },
      required: ['table'],
    },
    execute: ({ table: t, inherited }) => aclReport(t, { includeInherited: inherited !== false }),
  },
  {
    name: 'acl_diff',
    description:
      'Compare two roles against one table: which ACL rows name each, per operation, plus field-level differences. This is a diff of what the rules SAY, not a simulation of the decision engine — the response carries that caveat and you must pass it on rather than telling the user what a role "can do".',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        role_a: { type: 'string', description: 'e.g. admin' },
        role_b: { type: 'string', description: 'e.g. itil' },
      },
      required: ['table', 'role_a', 'role_b'],
    },
    execute: ({ table: t, role_a, role_b }) => aclDiff(t, role_a, role_b),
  },
  {
    name: 'explain_acls',
    description:
      'Turn the structured ACL report for a table into a plain-language summary. The summary is GENERATED and the response labels it as such; the report it describes is read off the instance. Read-only.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' } },
      required: ['table'],
    },
    execute: async ({ table: t }) => explainAclReport(await aclReport(t)),
  },

  /* ---------------------------------------------------------------- *
   * WI-ACL-1 — ACL AUTHORING. Model-callable, but never model-executed.
   *
   * These three tools are the ONLY ACL write verbs, and none of them writes
   * anything. Their `execute` is unreachable: `describeWrite` produces a
   * `(sys_security_acl, create|update|delete)` descriptor, `isGatedDescriptor`
   * classifies it as gated, and `handleGatedElevation` intercepts the call
   * before `executeTool` is ever reached (orchestrator.js). The actual write
   * happens inside one elevated execution, as an atomic ACL + role-link unit,
   * after a human approves a card that names the rule in plain language.
   *
   * So the model can ASK for an ACL. It cannot author one, cannot elevate,
   * cannot reach the shim, and cannot fall back to `create_record` — that route
   * produces the same gated descriptor and lands in the same gate.
   *
   * The `execute` bodies exist only to make that unreachability LOUD rather
   * than implicit: if the interception is ever removed or reordered, these
   * throw instead of quietly performing an un-elevated write that would
   * silently no-op and leave the user believing access had changed.
   * ---------------------------------------------------------------- */
  {
    name: 'create_acl',
    description:
      'Author a NEW access control rule (ACL) on a GLOBAL table, together with the roles it requires, as one all-or-nothing '
      + 'elevated change. Requires user approval and elevates security_admin. '
      + 'The rule is refused BEFORE you are asked to approve it if it would be empty (no role, security attribute, condition '
      + 'or script — the platform denies by default on those, so it would lock people out rather than error), if a role or '
      + 'security attribute does not exist, if the script is trivially true, if a condition names a field the table does not '
      + 'have (the platform silently drops such a clause, making the rule WIDER than it reads), or if it would break one of '
      + "ServiceNow's scope restrictions. "
      + "The rule is authored in the TARGET TABLE'S OWN application scope, derived automatically — a scoped table gets a "
      + 'scoped rule, a global table a global one. '
      + 'Call acl_report on the table first: an ACL is evaluated alongside every other matching rule, so you need to know what '
      + 'is already there before adding one.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'The table the rule governs, e.g. incident. Must be a global-scope table. Wildcards are refused.' },
        field: { type: 'string', description: 'Optional. A field name for a field-level ACL, or "*" for every field. Omit for a record-level ACL.' },
        operation: { type: 'string', description: 'read, write, create, delete, or any operation the instance defines (sys_security_operation).' },
        decision_type: { type: 'string', description: '"allow" (Allow If — the default) or "deny" (Deny Unless).' },
        type: { type: 'string', description: 'ACL type. Only "record" is proven live here; anything else is refused.' },
        roles: { type: 'array', items: { type: 'string' }, description: 'Role NAMES this rule requires, e.g. ["itil"]. Resolved server-side; an unknown role is refused.' },
        security_attributes: { type: 'array', items: { type: 'string' }, description: 'Security attribute name. This table holds ONE; asking for more is refused rather than truncated.' },
        data_condition: { type: 'string', description: 'Encoded query the record must match, e.g. "state=1^assigned_toISNOTEMPTY". Fields are checked against the real schema.' },
        script: { type: 'string', description: 'ACL script. A trivially-true script is refused — it looks like a condition and constrains nothing.' },
        applies_to: { type: 'string', description: 'Optional case-sensitive record pre-filter (the Applies-to condition).' },
        active: { type: 'boolean', description: 'Default true. An inactive ACL is stored but never evaluated.' },
        admin_overrides: { type: 'boolean', description: 'Default false. When true, admin bypasses this rule.' },
        description: { type: 'string', description: 'Why this rule exists. Worth writing — the platform generates one otherwise.' },
        scope: {
          type: 'string',
          description:
            'Rarely needed. The application scope to author the rule INTO, e.g. "global" or an app scope name. '
            + "OMIT IT and the rule is authored in the target table's own scope, which is what ServiceNow requires "
            + 'and what you almost always want. Naming a different scope is legal only when the target table carries '
            + 'a field in that scope; anything else is refused.',
        },
      },
      required: ['table', 'operation'],
    },
    execute: () => { throw unreachableAclWrite('create_acl'); },
    describeWrite: (input) => ({
      table: 'sys_security_acl',
      operation: 'insert',
      requested: aclDescriptorSummary(input),
      sys_id: null,
      acl_spec: input,
    }),
  },
  {
    name: 'update_acl',
    description:
      'Change an existing ACL by sys_id — its condition, script, roles, active flag, decision type, applies-to filter or '
      + 'description — together with its role links, as one all-or-nothing elevated change. Requires user approval and elevates '
      + 'security_admin. '
      + 'The patch is merged onto the rule AS IT IS ON THE INSTANCE and the RESULT is validated, so a change that would leave '
      + 'the ACL empty (for example clearing its roles when the role was its only condition) is refused before you are asked to '
      + 'approve it — an empty ACL denies everyone it matches. A patch that changes nothing is also refused. '
      + 'It cannot repoint an ACL at a different table, field or operation: that is a different rule, and it is a delete plus a '
      + 'create. Read the ACL with acl_report first and use the sys_id that read returns.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        sys_id: { type: 'string', description: 'sys_id of the ACL to change, from acl_report.' },
        roles: { type: 'array', items: { type: 'string' }, description: 'The COMPLETE role list this rule should require afterwards — it replaces the current set, it does not add to it.' },
        security_attributes: { type: 'array', items: { type: 'string' } },
        data_condition: { type: 'string', description: 'Encoded query. Pass "" to clear it.' },
        script: { type: 'string', description: 'ACL script. Pass "" to clear it.' },
        applies_to: { type: 'string' },
        decision_type: { type: 'string', description: '"allow" or "deny".' },
        active: { type: 'boolean' },
        admin_overrides: { type: 'boolean' },
        description: { type: 'string' },
        scope: {
          type: 'string',
          description:
            'Rarely needed. The application scope to author the rule INTO, e.g. "global" or an app scope name. '
            + "OMIT IT and the rule is authored in the target table's own scope, which is what ServiceNow requires "
            + 'and what you almost always want. Naming a different scope is legal only when the target table carries '
            + 'a field in that scope; anything else is refused.',
        },
      },
      required: ['sys_id'],
    },
    execute: () => { throw unreachableAclWrite('update_acl'); },
    describeWrite: (input) => ({
      table: 'sys_security_acl',
      operation: 'update',
      requested: aclDescriptorSummary(input),
      sys_id: input?.sys_id ?? null,
      acl_spec: input,
    }),
  },
  {
    name: 'delete_acl',
    description:
      'Delete an ACL and every role link on it, through the elevated channel. Destructive — confirm with the user in '
      + 'conversation first, then call it; approval and elevation follow. '
      + 'This is the ONLY correct way to remove an ACL: delete_record on sys_security_acl runs un-elevated, is denied, and '
      + 'SILENTLY DOES NOTHING while appearing to succeed. Deleting a rule removes whatever access it granted, so read it with '
      + 'acl_report first and tell the user what it does before removing it.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: { sys_id: { type: 'string', description: 'sys_id of the ACL to delete, from acl_report.' } },
      required: ['sys_id'],
    },
    execute: () => { throw unreachableAclWrite('delete_acl'); },
    describeWrite: (input) => ({
      table: 'sys_security_acl',
      operation: 'delete',
      requested: {},
      sys_id: input?.sys_id ?? null,
      acl_spec: input,
    }),
  },
  {
    name: 'recall_memory',
    description:
      'Search every past conversation and the instance knowledge ledger. Use this whenever the user refers to earlier work — "what did we decide about vendor-hold incidents", "the flow we built last week", "that sys_id from before" — instead of guessing or saying you cannot know. Read-only. The response states which mode answered: "semantic" (embeddings) or "keyword" (the embedding model is not pulled), so report the mode if the results look thin.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in plain language' },
        limit: { type: 'number', description: 'Max results (default 8)' },
        session_id: { type: 'string', description: 'Restrict to one session; omit to search all of them' },
      },
      required: ['query'],
    },
    execute: ({ query, limit, session_id }) =>
      search(query, { limit: Math.min(limit || 8, 25), sessionId: session_id || null }),
  },
  {
    name: 'list_instance_facts',
    description:
      'Read the instance knowledge ledger: traps, measured facts about this instance, established decisions, and user preferences. These are already injected into your system prompt — call this only when you need the full list or a specific provenance.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', description: 'trap | mapping | decision | preference' } },
      required: [],
    },
    execute: ({ kind }) => listFacts({ kind: kind || undefined }),
  },
  {
    name: 'remember_fact',
    description:
      'Store something durable in the instance knowledge ledger, so future sessions start knowing it. Use for a measured fact about this instance, a decision the user made, or a preference they stated. Give provenance — how it was established. Not a mutation on the instance, but it does change future behaviour, so only record things you actually verified or the user actually said.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'trap | mapping | decision | preference' },
        key: { type: 'string', description: 'Short kebab-case identifier, e.g. incident-problem-link-absent' },
        value: { type: 'string', description: 'The fact itself, stated so a future session can act on it' },
        provenance: { type: 'string', description: 'How this was established (a read-back, a failed verification, the user said so)' },
      },
      required: ['kind', 'key', 'value'],
    },
    execute: ({ kind, key, value, provenance }) => recordFact({ kind, key, value, provenance }),
  },
  {
    name: 'list_applications',
    description:
      'List the application scopes on this instance: custom applications, store/plugin applications, and the global scope. '
      + 'Each says whether NowHelpAssist manages it (an SDK workspace on disk claims that scope) and, if so, how many managed sources it holds. '
      + 'Read-only. Use it to answer which scope an artifact belongs to, or which applications exist, instead of guessing a scope name. '
      + 'Note that anything you create over the Table API is born in the GLOBAL scope — REST silently ignores sys_scope — so a scoped artifact has to go through the SDK flow tools.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Match on application name or scope name' },
        kind: { type: 'string', description: 'custom | store | scope — omit for all' },
        managed: { type: 'boolean', description: 'Only applications NowHelpAssist manages' },
      },
      required: [],
    },
    execute: async ({ search, kind, managed }) => {
      const r = await listApplications({ search: search || '', kind: kind || '', managedOnly: managed === true, limit: 1000 });
      // The full 743-row list would swamp the context and teach nothing. Store
      // apps are summarised unless they were explicitly asked for.
      const listed = kind === 'store' || search
        ? r.applications.slice(0, 50)
        : r.applications.filter((a) => a.kind !== 'store');
      return {
        counts: r.counts,
        managedCount: r.managedCount,
        visibility: r.visibility.note,
        applications: listed.map((a) => ({
          name: a.name, scope: a.scope, version: a.version, kind: a.kind,
          managedByNowHelpAssist: a.managed, sources: a.workspace?.sourceCount ?? null,
        })),
        storeApplications: kind === 'store' || search ? undefined : `${r.counts.store || 0} store applications not listed — pass kind:"store" or a search term`,
      };
    },
  },
  {
    name: 'create_application',
    description:
      'Create a REAL custom ServiceNow application (a sys_app) through the SDK. This is the only supported way to make one here: '
      + 'inserting into sys_scope over REST produces a husk with no technical scope name that Studio will not list. '
      + 'Give a plain-language name and the scope is derived and validated against this instance vendor prefix and the '
      + '18-character platform limit, or pass one explicitly. '
      + 'This SCAFFOLDS the application workspace on disk and does NOT put anything on the instance yet: installing it is a separate step. '
      + 'Say so when you report back, and do not tell the user the application exists on the instance.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable application name, e.g. "Fleet Management"' },
        scope_name: { type: 'string', description: 'Optional explicit scope, e.g. x_2196302_fleet. Derived from the name when omitted.' },
        description: { type: 'string' },
      },
      required: ['name'],
    },
    execute: ({ name, scope_name: scopeName, description }) => createApplication({ name, scopeName, description }),
  },
  {
    name: 'check_scope_name',
    description:
      'Check what scope name a new application would get on this instance, and whether a proposed one is legal, WITHOUT creating anything. '
      + 'Read-only. Use before create_application when the technical name matters: the scope is permanent, and a wrong vendor prefix '
      + 'is only a warning at install time, after which the application may not install correctly.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The application name to derive a scope from' },
        scope_name: { type: 'string', description: 'A proposed scope name to validate instead' },
      },
      required: [],
    },
    execute: async ({ name, scope_name: scopeName }) => {
      const prefix = await vendorPrefix();
      const suggested = name ? suggestScopeName(name, prefix) : null;
      return {
        vendorPrefix: prefix,
        maxLength: MAX_SCOPE_LENGTH,
        charactersAvailable: MAX_SCOPE_LENGTH - prefix.length,
        ...(suggested ? { suggested } : {}),
        ...(scopeName ? { check: validateScopeName(scopeName, prefix) } : {}),
        manualAlternative: studioSteps(prefix),
      };
    },
  },
  {
    name: 'list_captured_sets',
    description:
      'List the update sets NowHelpAssist has created on this instance to capture configuration changes, with how many updates each holds. '
      + 'Pass a set sys_id to see exactly what is in one. Read-only. '
      + 'Update sets carry CONFIGURATION only — never task data such as incidents or requests.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { set: { type: 'string', description: 'sys_id of one set, to list its contents' } },
      required: [],
    },
    execute: async ({ set }) => (set ? setContents(set) : listCapturedSets({})),
  },

  /* ---------------------------------------------------------------- *
   * Impersonation mode (B3)
   *
   * These do NOT open a ServiceNow session. Under M1 each execution
   * impersonates and reverts inside one bounded job, so "mode" records which
   * target the NEXT execution stamps. The descriptions say so, because a model
   * that believes a session is open will reason wrongly about what ending does.
   * ---------------------------------------------------------------- */
  {
    name: 'impersonation_start',
    description:
      'Begin acting as another user, so reads and writes are evaluated against THEIR permissions and attributed to them. '
      + 'Requires user approval. Give a task descriptor saying what this is for — it is what lets NowHelpAssist notice later '
      + 'that a request has wandered outside the original task instead of silently carrying another user\'s authority into '
      + 'unrelated work. Eligibility is decided by NowHelpAssist against sys_user, not by the platform: canImpersonate() is '
      + 'not consulted because it approves inactive users and sys_ids that match no record. If the target holds the admin '
      + 'role this returns a refusal asking for elevated approval — tell the user plainly, and only call again with '
      + 'elevated_approval after they explicitly confirm. Note that no persistent ServiceNow session is opened: each '
      + 'execution impersonates and reverts inside one bounded job.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'user_name, display name, or sys_id. A name matching more than one user is returned as a list to choose from, never picked for you.' },
        task: { type: 'string', description: 'What this impersonation is for, in a phrase — e.g. "check what Aagamya can see on the Laptop Request item".' },
        elevated_approval: {
          type: 'boolean',
          description: 'Only after the user has explicitly confirmed they want to impersonate an ADMINISTRATOR. Never set this on your own initiative; it appears on the approval card the user sees.',
        },
      },
      required: ['user', 'task'],
    },
    execute: ({ user, task, elevated_approval }, { sessionId } = {}) =>
      startImpersonation({ sessionId, user, task, elevatedApproval: elevated_approval }),
  },
  {
    name: 'impersonation_switch',
    description:
      'Re-target impersonation to a different user. Same eligibility gate and approval as impersonation_start. '
      + 'The real initiator is preserved — switching changes who is being impersonated, never who is doing it.',
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'user_name, display name, or sys_id.' },
        task: { type: 'string', description: 'Optional new task descriptor. Omit to keep the current one.' },
        elevated_approval: { type: 'boolean', description: 'Only after explicit user confirmation for an ADMINISTRATOR target.' },
      },
      required: ['user'],
    },
    execute: ({ user, task, elevated_approval }, { sessionId } = {}) =>
      switchImpersonation({ sessionId, user, task, elevatedApproval: elevated_approval }),
  },
  {
    name: 'impersonation_end',
    description:
      'Stop acting as another user and return to the NowHelpAssist service identity. Not gated — stopping is always safe. '
      + 'Verifies by reading gs.getUserID() off the instance rather than assuming.',
    mutating: false,
    inputSchema: { type: 'object', properties: {}, required: [] },
    execute: (_input, { sessionId } = {}) => endImpersonation({ sessionId }),
  },
  {
    name: 'impersonation_status',
    description:
      'Report whether impersonation mode is active, who the target is, who the real initiator is, and the task it was '
      + 'started for. Pass probe: true to additionally read the effective user off the instance. Read-only.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { probe: { type: 'boolean', description: 'Also read gs.getUserID() live. Costs one bounded execution (a few seconds).' } },
      required: [],
    },
    execute: ({ probe }, { sessionId } = {}) => impersonationStatus({ sessionId, probe }),
  },
  {
    name: 'impersonation_provenance',
    description:
      'Answer "who really did this" for a record changed while impersonation mode was active. The instance keeps NO '
      + 'record of the real initiator behind an impersonated change - it stamps only the impersonated user - so this '
      + 'NowHelpAssist ledger is the only place the answer exists. Pass a record sys_id to look one up, or omit it to '
      + 'list what this session recorded. Read-only. Note the distinction it reports: a write that actually EXECUTED as '
      + 'the impersonated user has an attribution gap; one that ran under the NowHelpAssist service identity while mode '
      + 'happened to be active does not, and is attributed correctly by the instance.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        sys_id: { type: 'string', description: 'The changed record sys_id to trace back to its real initiator.' },
        target: { type: 'string', description: 'Instead: a user sys_id, to list everything that identity was used for.' },
      },
      required: [],
    },
    execute: ({ sys_id, target }, { sessionId } = {}) => {
      if (sys_id) return whoReallyDid(sys_id);
      if (target) return { target_sys_id: target, entries: impersonationAuditForTarget(target) };
      return { session: sessionId, entries: impersonationAuditForSession(sessionId) };
    },
  },

  /* ── Database Administration, Phase 0 — context and raw metadata ───────────
   *
   * Both are read-only. The DBA module's dependency order is fixed (Schema
   * Intelligence -> Impact & Safety -> Authoring -> Data ops) and nothing that
   * writes schema exists yet, deliberately.
   */
  {
    name: 'dba_context',
    description:
      'Report what the CONNECTED instance can actually recover, before promising anything about a delete or a schema '
      + 'change. Returns the database engine, the state of the Delete Recovery / Restore Deleted Records plugins, the '
      + 'per-category rollback retention in days, the identity and roles NowHelpAssist holds, the application scope, '
      + 'and the destructive-operation policy. '
      + 'CALL THIS BEFORE telling a user whether anything is reversible. The recovery verdict is three-state on '
      + 'purpose: "full", "partial" and "none" are different answers and rounding "partial" to either one is a lie. '
      + 'If the engine reports unknown, treat every delete as irreversible — never fill it in from memory.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Re-measure instead of using the cached context.' },
        probe_engine: {
          type: 'boolean',
          description: 'Default true. Engine detection costs one server-side script execution (~2s) because '
                     + 'glide.db.rdbms has no sys_properties row and is only readable via gs.getProperty. Pass false '
                     + 'to skip it — the engine then reports unknown rather than a remembered value.',
        },
      },
      required: [],
    },
    execute: ({ refresh, probe_engine }) =>
      getDbaContext({ refresh: Boolean(refresh), probeEngine: probe_engine !== false }),
  },
  {
    name: 'dba_raw_metadata',
    description:
      'Read the sys_* metadata tables that ARE the ServiceNow schema (sys_db_object, sys_dictionary, sys_choice, '
      + 'sys_glide_object, sys_relationship, sys_number, sys_security_acl, sys_update_version, and so on) with paging '
      + 'and two guards the plain Table API does not give you: '
      + '(1) requesting a column that does not exist FAILS LOUDLY instead of silently omitting it, so an absent key '
      + 'never reads as an empty value; (2) the result says whether it was truncated, so a page is never mistaken for '
      + 'a total. '
      + 'Some metadata tables are unreachable over REST on this instance and this tool says so by name rather than '
      + 'returning a permissions error: sys_index and sys_package are 403 (API-level ACL), sys_index_ii does not '
      + 'exist, and v_db_index is readable but always empty. Use get_table_schema for ordinary "what fields does this '
      + 'table have" questions; this is for reading the metadata records themselves.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'The metadata table to read, e.g. sys_dictionary, sys_db_object, sys_glide_object.' },
        query: { type: 'string', description: 'Encoded query, e.g. name=incident^elementISNOTEMPTY. Check every field you reference exists — unknown fields are dropped from a query silently.' },
        fields: { type: 'string', description: 'Comma-separated columns. Requesting one that does not exist is an error here, which is the point.' },
        max: { type: 'number', description: 'Row ceiling for this read. Default 5000.' },
      },
      required: ['table'],
    },
    execute: async ({ table: t, query, fields, max }) => {
      const rows = await metaQuery(t, { query, fields, max: Math.min(max || 5000, 10000) });
      return {
        table: t,
        query: query || '',
        count: rows.length,
        truncated: rows.truncated === true,
        ...(rows.truncated
          ? { truncatedNote: `This is the first ${rows.length} rows, not the total. Narrow the query or raise max before reporting a count.` }
          : {}),
        rows,
      };
    },
  },

  /* ── DBA Layer 1 — Schema Intelligence. Read-only, all of it. ───────────── */
  {
    name: 'dba_get_table',
    description:
      'Describe a table: label, what it extends, its full extends chain, whether it is extendable, its direct '
      + 'children, scope, auto-numbering prefix, and a core/custom classification. A table that does not exist '
      + 'says so explicitly — treat that as absent, not as possibly-renamed.',
    mutating: false,
    inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    execute: ({ table: t }) => dbaGetTable(t),
  },
  {
    name: 'dba_list_fields',
    description:
      'Every column on a table with its dictionary detail: type, reference target, qualifier, max length, '
      + 'mandatory/read-only/display/unique flags, default, and — the DBA-specific part — which table in the '
      + 'inheritance chain actually DEFINES each one. Set include_inherited:false for only the columns this table '
      + 'adds itself. Says if the scan was truncated; if it was, absence proves nothing.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, include_inherited: { type: 'boolean', description: 'Default true.' } },
      required: ['table'],
    },
    execute: ({ table: t, include_inherited }) => dbaListFields(t, { includeInherited: include_inherited !== false }),
  },
  {
    name: 'dba_get_field',
    description:
      'One column in full, and the answer to "where does this field actually come from?" — the ORIGIN table is the '
      + 'highest ancestor whose dictionary defines it. Also lists child-table overrides, reporting only attributes '
      + 'whose _override flag is actually set: an override row carrying values with no flag set changes nothing.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, element: { type: 'string', description: 'The column name.' } },
      required: ['table', 'element'],
    },
    execute: ({ table: t, element }) => dbaGetField(t, element),
  },
  {
    name: 'dba_get_hierarchy',
    description: 'The table tree: the extends chain upward to the root, and children downward to a stated depth. '
      + 'Says when the tree was cut, so a missing child is never mistaken for a childless table.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, depth: { type: 'number', description: 'How many levels of children. Default 2.' } },
      required: ['table'],
    },
    execute: ({ table: t, depth }) => dbaGetHierarchy(t, { depth: Math.min(Math.max(Number(depth) || 2, 1), 4) }),
  },
  {
    name: 'dba_get_references',
    description:
      'Both directions of the implicit relationships: OUTBOUND (reference fields on this table, and what they point '
      + 'at) and INBOUND (every field anywhere on the instance that points here). Use this for "show all fields '
      + 'referencing sys_user". The inbound scan is instance-wide and reports whether it was truncated — if it was, '
      + 'the count is a floor, not a total.',
    mutating: false,
    inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    execute: ({ table: t }) => dbaGetReferences(t),
  },
  {
    name: 'dba_resolve_reference',
    description:
      'For one reference field: the table it points at, that table\'s display field, and the qualifier with its kind '
      + '(simple / dynamic / advanced). Reports no qualifier when none is set — use_reference_qualifier reads '
      + '"simple" on many fields that have none, so "simple" alone does not mean one is in effect.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, element: { type: 'string' } },
      required: ['table', 'element'],
    },
    execute: ({ table: t, element }) => dbaResolveReference(t, element),
  },
  {
    name: 'dba_dot_walk',
    description:
      'Validate a dot-walk path hop by hop, e.g. caller_id.department.name from incident. Returns each hop with its '
      + 'type, or names exactly which hop failed and why (absent field, or a non-reference the path cannot continue '
      + 'through). Use before putting a dotted field in a query: an encoded query silently DROPS a condition on an '
      + 'unknown dot-walk and then matches everything.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string', description: 'The starting table.' }, path: { type: 'string', description: 'Dotted path, e.g. caller_id.department.name' } },
      required: ['table', 'path'],
    },
    execute: ({ table: t, path }) => dbaDotWalk(t, path),
  },
  {
    name: 'dba_classify',
    description:
      'Is this table core-ootb, ootb-customized, custom-in-scope or custom-global — and is it safe to modify? '
      + 'Combines three independent signals (name prefix, sys_metadata_customization, sys_update_version) because '
      + 'each alone is wrong somewhere, and returns the evidence for each. Platform tables come back "not-directly": '
      + 'extend them through the table-augments pattern, never by editing the base object.',
    mutating: false,
    inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    execute: ({ table: t }) => dbaClassify(t),
  },
  {
    name: 'dba_resolve_identifier',
    description:
      'Turn a human identifier into {table, sys_id, display}: a prefixed number like INC0012345 (resolved through '
      + 'the instance\'s own sys_number prefixes, not a guessed mapping), a sys_id, or a display value. A bare '
      + 'sys_id CANNOT be resolved without a table — nothing on the instance indexes sys_id to table — and it says '
      + 'so rather than guessing. Ambiguous matches are refused, not picked.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' }, table: { type: 'string', description: 'Required for a bare sys_id or display value.' } },
      required: ['value'],
    },
    execute: ({ value, table: t }) => dbaResolveIdentifier(value, { table: t || null }),
  },
  {
    name: 'dba_list_choices',
    description:
      'The sys_choice entries for a field, resolved the way the platform resolves them: the most-derived table in '
      + 'the chain that defines a set wins, and it says which table that was. Reports when a field\'s values come '
      + 'from a choice TABLE instead of sys_choice rather than returning an empty list.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, element: { type: 'string' } },
      required: ['table', 'element'],
    },
    execute: ({ table: t, element }) => dbaListChoices(t, element),
  },
  {
    name: 'dba_get_relationships',
    description:
      'Explicit relationships (sys_relationship records, for related lists no reference field can express) plus the '
      + 'implicit ones (reference fields in both directions). Most tables have zero explicit relationships and many '
      + 'implicit ones — that is normal, not a gap.',
    mutating: false,
    inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
    execute: ({ table: t }) => dbaGetRelationships(t),
  },
  {
    name: 'dba_list_indexes',
    description:
      'Index DEFINITION RECORDS for a table, read from sys_index through a server-side script (sys_index is 403 '
      + 'over REST here). ALWAYS PARTIAL, and it says so: sys_index holds only explicitly-defined index records — '
      + '33 instance-wide when measured, none for incident, task or sys_user — and no reachable source on this '
      + 'instance enumerates a table\'s physical indexes. A zero result means "no index definition record", NEVER '
      + '"this table has no indexes". Do not report a table as unindexed from this. Costs a few seconds.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, include_inherited: { type: 'boolean', description: 'Also scan ancestor tables. Default false.' } },
      required: ['table'],
    },
    execute: ({ table: t, include_inherited }) => dbaListIndexes(t, { includeInherited: Boolean(include_inherited) }),
  },
  {
    name: 'dba_schema_map',
    description:
      'A graph for rendering: nodes are tables, edges are extends / reference / relationship. DERIVED from '
      + 'sys_db_object, sys_dictionary and sys_relationship — ServiceNow exposes no schema-map API, so the graph is '
      + 'exactly as complete as the depth requested and nothing authoritative exists to check it against. Depth 1 on '
      + 'incident is ~43 nodes and ~200 edges; raise depth carefully.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, depth: { type: 'number', description: 'Hops to follow. Default 1. 2 is already large.' } },
      required: ['table'],
    },
    execute: ({ table: t, depth }) => dbaSchemaMap(t, { depth: Math.min(Math.max(Number(depth) || 1, 0), 2) }),
  },

  /* ── DBA Layer 2 — Impact & Safety. Read-only; nothing here authorises a write. ── */
  {
    name: 'dba_analyze_impact',
    description:
      'Answer "if I change this, what breaks?" for a table or one field. There is NO out-of-the-box API for this — '
      + 'the report is assembled by scanning the artifact tables (business rules, client scripts, UI policies, data '
      + 'policies, ACLs, UI actions, forms, sections, lists, transform maps, relationships, notifications, reports, '
      + 'templates, filters, child tables, inbound references), and it lists both what it scanned and what it CANNOT '
      + 'see. Findings are ranked structural > high > medium > low. Measured: incident has 481 dependents. '
      + 'Pass a field to also get field-level ACLs, form placements, dictionary overrides, choices and script '
      + 'text-matches — and a warning if the field is inherited, since changing it there changes every sibling table.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        field: { type: 'string', description: 'Optional. Analyse one column instead of the whole table.' },
      },
      required: ['table'],
    },
    execute: ({ table: t, field }) => dbaAnalyzeImpact({ table: t, field: field || null }),
  },
  {
    name: 'dba_classify_operation',
    description:
      'Is this operation reversible on THIS instance? Returns the rollback mechanism, the live recovery verdict, the '
      + 'retention in days read from the instance, the required role and scope constraint. '
      + 'For engine-dependent operations the flag reflects what the instance actually supports, not the documented '
      + 'matrix, and any divergence is stated — record_delete is documented reversible but is "partial" here. '
      + 'Drops, renames, re-types, narrowings and truncates create NO rollback context on any engine: never describe '
      + 'them as reversible. An unrecognised operation is treated as irreversible.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { operation: { type: 'string', description: 'e.g. drop_column, rename_table, record_delete, background_script, drop_index' } },
      required: ['operation'],
    },
    execute: ({ operation }) => dbaClassifyOperation(operation),
  },
  {
    name: 'dba_check_integrity',
    description:
      'Read-only data diagnostics for a table: empty values in mandatory columns (mandatory is enforced on the form, '
      + 'not in the database, so historic rows routinely violate it), duplicate values in unique columns, and '
      + 'references pointing at records that no longer exist. Every check is BOUNDED by a sample — a "clean" verdict '
      + 'means clean within that sample and is not a proof about the whole table.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string' }, sample: { type: 'number', description: 'Rows to examine per check. Default 500.' } },
      required: ['table'],
    },
    execute: ({ table: t, sample }) => dbaCheckIntegrity(t, { sample: Math.min(Math.max(Number(sample) || 500, 50), 2000) }),
  },
  {
    name: 'dba_preflight',
    description:
      'The go/no-go gate for a proposed change: combines reversibility, impact and classification into blockers and '
      + 'the confirmations required to proceed. Schema rules are applied only to schema operations — a record delete '
      + 'is data and is not blocked by "this is a platform table". A "go" verdict means nothing in the preflight '
      + 'blocks it; it does NOT mean safe. Read the impact report.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string' },
        table: { type: 'string' },
        field: { type: 'string' },
        include_integrity: { type: 'boolean', description: 'Also run the bounded integrity checks. Slower.' },
      },
      required: ['operation'],
    },
    execute: ({ operation, table: t, field, include_integrity }) =>
      dbaPreflight({ operation, table: t || null, field: field || null, includeIntegrity: Boolean(include_integrity) }),
  },
  {
    name: 'dba_audit',
    description:
      'Append a DBA change to NowHelpAssist\'s own audit trail (the same mutation ledger every other write uses — '
      + 'who, what, old, new, when, on which instance), or read back what this session recorded. The instance does '
      + 'not record the intent behind a schema change, only its result, so this ledger is where the "why" lives.',
    mutating: false,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['record', 'list'], description: 'Default list.' },
        table: { type: 'string' },
        sys_id: { type: 'string' },
        operation: { type: 'string', description: 'What was done, e.g. add_column.' },
        why: { type: 'string', description: 'The reason. This is the part the instance never keeps.' },
        before: { type: 'object', description: 'Prior state, if known.' },
        after: { type: 'object', description: 'New state.' },
      },
      required: [],
    },
    execute: ({ action, table: t, sys_id, operation, why, before, after }, { sessionId, turnSeq } = {}) => {
      if (action !== 'record') {
        return { session: sessionId, entries: mutationsForSession(sessionId, { limit: 100 }) };
      }
      const ok = appendMutation({
        sessionId,
        turnSeq: turnSeq ?? 0,
        tool: `dba:${operation || 'change'}`,
        descriptor: { table: t ?? null, sys_id: sys_id ?? null, requested: { operation, why, before, after } },
        result: sys_id ? { sys_id } : null,
        // Honest by construction: this tool records an assertion the caller
        // made. It has verified nothing itself, and says so rather than
        // borrowing the credibility of a real read-back.
        verification: { status: 'unverified', by: 'dba_audit', note: 'Recorded as reported by the caller; no read-back was performed by this tool.' },
        approval: null,
      });
      return ok
        ? { recorded: true, session: sessionId, operation, table: t ?? null, why: why ?? null }
        : { recorded: false, error: 'The audit entry could not be written to the local ledger.' };
    },
  },
];

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));
