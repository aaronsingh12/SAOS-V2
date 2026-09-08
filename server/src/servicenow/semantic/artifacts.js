import { fact, unknown, STATUS } from './provenance.js';
import { describeTable, DERIVED_FIELDS } from './tables.js';

/**
 * PHASE 3 — WHAT A SERVICENOW ARTIFACT *IS*, beyond the row it is stored in.
 *
 * A flow is not a `sys_hub_flow` row. A catalog item is not an `sc_cat_item`
 * row. Each is a structure with parts that live in other tables, relationships
 * that a dictionary read cannot show you, and a way of being proven correct
 * that is specific to its kind. This file is the declarative model of that,
 * and it is DATA: no I/O, no decisions, nothing executable.
 *
 * TWO RULES SHAPED EVERY ENTRY.
 *
 * First, nothing here is invented. Every table name, part and relationship is
 * one this repository already reads or writes, and the `evidence` field on each
 * model names where in the codebase that happens. A model that described a
 * relationship the implementation does not have would be the most convincing
 * possible way to fabricate a ServiceNow fact.
 *
 * Second, the STRUCTURE is declared here and the SHAPE is read live. The model
 * says a flow has a trigger and that the trigger's configuration lives in
 * `sys_hub_trigger_instance_v2`; it does not say what fields that table has —
 * `describeArtifact` merges the live dictionary in for that, so a model that
 * goes stale against a release is corrected by the instance rather than
 * believed.
 */

/**
 * The artifact registry.
 *
 * `verification` is the load-bearing column and is the honest answer for each
 * kind rather than an aspiration:
 *
 *   semantic     the artifact can be fired on a real record and its promised
 *                effects asserted (fluent.js `verify`).
 *   read_back    the write is read back off the instance and diffed
 *                (write-verify.js / mutation-pipeline.js).
 *   none         no automated proof exists here, and saying so is the point —
 *                a catalog UI policy is evaluated in the BROWSER, so no
 *                server-side read can prove it works.
 */
export const ARTIFACTS = Object.freeze({
  incident: {
    kind: 'incident',
    label: 'Incident',
    table: 'incident',
    extends: 'task',
    classification: 'data',
    parts: ['caller_id', 'assignment_group', 'assigned_to', 'impact', 'urgency', 'priority', 'state', 'short_description', 'description'],
    derived: { priority: ['impact', 'urgency'] },
    relationships: [
      { field: 'caller_id', to: 'sys_user', nature: 'reference' },
      { field: 'assignment_group', to: 'sys_user_group', nature: 'reference' },
      { field: 'assigned_to', to: 'sys_user', nature: 'reference' },
      { field: 'parent', to: 'task', nature: 'reference' },
    ],
    mechanism: 'rest',
    verification: 'read_back',
    // An incident does not extend sys_metadata, so it is never in an update set
    // and never belongs to an application scope (ledger: incidents-are-data-not-config).
    capturedByUpdateSet: false,
    evidence: 'servicenow/client.js table API; tools create_incident/update_record; ledger incidents-are-data-not-config',
  },

  catalog_item: {
    kind: 'catalog_item',
    label: 'Catalog Item',
    table: 'sc_cat_item',
    classification: 'configuration',
    parts: ['name', 'short_description', 'category', 'variables', 'variable_sets', 'ui_policies'],
    relationships: [
      { field: 'category', to: 'sc_category', nature: 'reference' },
      { part: 'variables', to: 'item_option_new', nature: 'child', via: 'cat_item' },
      { part: 'variable_sets', to: 'io_set_item', nature: 'child' },
      { part: 'ui_policies', to: 'catalog_ui_policy', nature: 'child', via: 'catalog_item' },
      { part: 'ordering', to: 'sc_request', nature: 'produces' },
      { part: 'fulfilment', to: 'sc_req_item', nature: 'produces' },
    ],
    mechanism: 'rest',
    // The item and its variables go over REST; the UI POLICY ACTIONS cannot —
    // catalog_ui_policy_action accepts a POST and silently discards the two
    // fields that attach it (ledger: ui-policy-action-not-writable-over-rest),
    // so that half is authored through the SDK.
    mechanismNotes: { ui_policy_actions: 'sdk' },
    verification: 'read_back',
    verificationNotes: 'A UI policy is evaluated in the browser; no server-side read proves it fires '
      + '(ledger: ui-policy-proven-only-by-the-form).',
    capturedByUpdateSet: true,
    evidence: 'servicenow/catalog.js, servicenow/catalogPolicy.js; ledger ui-policy-action-not-writable-over-rest',
  },

  request: {
    kind: 'request',
    label: 'Request',
    table: 'sc_request',
    extends: 'task',
    classification: 'data',
    parts: ['number', 'requested_for', 'stage', 'request_state'],
    relationships: [
      { field: 'requested_for', to: 'sys_user', nature: 'reference' },
      { part: 'items', to: 'sc_req_item', nature: 'child', via: 'request' },
    ],
    mechanism: 'rest',
    verification: 'read_back',
    capturedByUpdateSet: false,
    evidence: 'servicenow/catalog.js; the ordering path',
  },

  requested_item: {
    kind: 'requested_item',
    label: 'Requested Item (RITM)',
    table: 'sc_req_item',
    extends: 'task',
    classification: 'data',
    parts: ['number', 'cat_item', 'request', 'stage', 'variables'],
    relationships: [
      { field: 'cat_item', to: 'sc_cat_item', nature: 'reference' },
      { field: 'request', to: 'sc_request', nature: 'reference' },
      { part: 'variables', to: 'sc_item_option_mtom', nature: 'child' },
      { part: 'tasks', to: 'sc_task', nature: 'child', via: 'request_item' },
    ],
    mechanism: 'rest',
    verification: 'read_back',
    capturedByUpdateSet: false,
    evidence: 'servicenow/catalog.js; the fulfilment path',
  },

  flow: {
    kind: 'flow',
    label: 'Flow',
    table: 'sys_hub_flow',
    classification: 'configuration',
    parts: ['trigger', 'conditions', 'actions', 'inputs', 'execution_context'],
    structure: {
      trigger: {
        table: 'sys_hub_trigger_instance_v2',
        // Measured: this table has no `condition` or `table_name` column. The
        // configuration is a gzip+base64 blob in `trigger_inputs`
        // (ledger: trigger-instance-v2-blob).
        note: 'The trigger configuration is an encoded blob in trigger_inputs, not queryable columns.',
        strategyDefault: 'once',
      },
      actions: { table: 'sys_hub_action_instance_v2' },
      execution_context: { table: 'sys_flow_context', states: ['COMPLETE', 'WAITING', 'PAUSED', 'ERROR', 'CANCELLED'] },
      outputs: { table: 'sys_flow_runtime_value' },
    },
    relationships: [
      { part: 'trigger', to: 'sys_hub_trigger_instance_v2', nature: 'child', via: 'flow' },
      { part: 'actions', to: 'sys_hub_action_instance_v2', nature: 'child', via: 'flow' },
      { part: 'executions', to: 'sys_flow_context', nature: 'runtime' },
    ],
    // A flow is authored as Fluent source and installed by the SDK. There is no
    // REST endpoint that creates a working flow.
    mechanism: 'sdk',
    verification: 'semantic',
    verificationNotes: 'Fired on a real record and asserted against the promised effects (fluent.js verify).',
    capturedByUpdateSet: true,
    evidence: 'servicenow/flows.js, servicenow/fluent.js; ledger trigger-instance-v2-blob, trigger-strategy-default-once',
  },

  subflow: {
    kind: 'subflow',
    label: 'Subflow',
    table: 'sys_hub_flow',
    classification: 'configuration',
    // A subflow has no trigger: it is CALLED. That is the whole reason the
    // execution harness exists.
    parts: ['inputs', 'outputs', 'actions', 'execution_context'],
    structure: {
      contract: { note: 'Declared inputs and outputs form the subflow contract (servicenow/subflows.js).' },
      invocation: { mechanism: 'harness', api: 'sn_fd.FlowAPI.getRunner().subflow(<scope>.<name>)' },
      execution_context: { table: 'sys_flow_context' },
      outputs: { table: 'sys_flow_runtime_value', note: 'type=output carries the JSON map of outputs.' },
    },
    relationships: [
      { part: 'callers', to: 'sys_hub_flow', nature: 'call_graph' },
    ],
    mechanism: 'sdk',
    invocationMechanism: 'harness',
    verification: 'semantic',
    verificationNotes: 'Triggerless, so it is set up, invoked through the harness, settled and asserted.',
    capturedByUpdateSet: true,
    evidence: 'servicenow/subflows.js, servicenow/execution-harness.js',
  },

  sla_definition: {
    kind: 'sla_definition',
    label: 'SLA Definition',
    table: 'contract_sla',
    classification: 'configuration',
    parts: ['name', 'table', 'duration', 'schedule', 'schedule_source', 'start_condition', 'stop_condition'],
    structure: {
      // Measured: duration is an offset from 1970-01-01 with whole days carried
      // in the DATE half (ledger: contract-sla-duration-carries-days).
      duration: { type: 'glide_duration', note: 'Stored as an offset from 1970-01-01; days live in the date half.' },
      // Measured: the schedule is IGNORED unless schedule_source is
      // "sla_definition" (ledger: sla-schedule-inert-without-source).
      schedule: { requires: { schedule_source: 'sla_definition' }, note: 'Setting the reference alone leaves the clock 24x7.' },
      clock: { table: 'task_sla', note: 'Times are UTC; the display half is rendered in the session timezone.' },
    },
    relationships: [
      { part: 'attachments', to: 'task_sla', nature: 'runtime', via: 'sla' },
      { field: 'schedule', to: 'cmn_schedule', nature: 'reference' },
    ],
    mechanism: 'rest',
    verification: 'semantic',
    verificationNotes: 'A matching record is created and the platform is made to run the clock; the breach time is '
      + 'asserted against the RIGHT definition, because out-of-box SLAs attach to the same record '
      + '(ledger: task-sla-row-proves-nothing).',
    capturedByUpdateSet: true,
    evidence: 'servicenow/sla.js; ledger sla-schedule-inert-without-source, contract-sla-duration-carries-days',
  },

  acl: {
    kind: 'acl',
    label: 'Access Control (ACL)',
    table: 'sys_security_acl',
    classification: 'configuration',
    parts: ['name', 'operation', 'type', 'active', 'roles', 'condition', 'script', 'admin_overrides'],
    structure: {
      // An ACL is TWO records: the rule, and the role links that say who it
      // requires. Authored as one all-or-nothing unit.
      unit: { tables: ['sys_security_acl', 'sys_security_acl_role'], note: 'The rule and its role links are one atomic change.' },
      operation: { note: 'operation and type are references whose sys_ids follow two conventions; resolve through display_value.' },
      naming: { note: 'A name belongs to a table only if it equals it or starts with it plus a dot — a bare prefix matches siblings.' },
      evaluation: { note: 'ACLs are INHERITED; a table is governed by its parents\' rows too, and every matching rule is evaluated.' },
    },
    relationships: [
      { part: 'roles', to: 'sys_security_acl_role', nature: 'child', via: 'sys_security_acl' },
      { part: 'role', to: 'sys_user_role', nature: 'reference' },
    ],
    mechanism: 'rest',
    // Both the rule and the role links are security_admin-gated; an un-elevated
    // write is denied SILENTLY (returns success, changes nothing).
    requiresElevation: true,
    elevationRole: 'security_admin',
    verification: 'read_back',
    verificationNotes: 'Read back through the elevated path; an empty rule is reported as denying everyone it matches.',
    capturedByUpdateSet: true,
    evidence: 'servicenow/acl.js, acl-authoring.js, acl-spec.js, required-role-classifier.js',
  },

  table: {
    kind: 'table',
    label: 'Table',
    table: 'sys_db_object',
    classification: 'configuration',
    parts: ['name', 'label', 'super_class', 'columns', 'indexes', 'scope'],
    structure: {
      columns: { table: 'sys_dictionary' },
      overrides: { table: 'sys_dictionary_override' },
      hierarchy: { note: 'super_class stores the parent\'s sys_db_object sys_id; walking up dot-walks super_class.name.' },
    },
    relationships: [
      { part: 'columns', to: 'sys_dictionary', nature: 'child', via: 'name' },
      { part: 'inbound_references', to: 'sys_dictionary', nature: 'referenced_by', via: 'reference' },
    ],
    // There is no REST endpoint that creates a table; inserting the metadata
    // rows by hand produces something shaped like a table with none of the
    // artifacts the platform generates alongside one.
    mechanism: 'sdk',
    verification: 'read_back',
    capturedByUpdateSet: true,
    evidence: 'servicenow/dba-schema.js, dba-authoring.js',
  },

  application: {
    kind: 'application',
    label: 'Application',
    table: 'sys_app',
    classification: 'configuration',
    parts: ['name', 'scope', 'version', 'short_description'],
    structure: {
      // Measured: inserting into sys_scope over REST produces a HUSK —
      // sys_class_name stays sys_scope, the technical name is empty, Studio
      // will not list it (ledger: sys-scope-insert-is-a-husk).
      creation: { mechanism: 'sdk', note: 'A REST insert into sys_scope creates a husk, not an application.' },
      scopeName: { pattern: 'x_<vendor>_<name>', note: 'Permanent once created.' },
    },
    relationships: [
      { part: 'scope', to: 'sys_scope', nature: 'identity' },
      { part: 'artifacts', to: 'sys_metadata', nature: 'owns' },
    ],
    mechanism: 'sdk',
    verification: 'read_back',
    capturedByUpdateSet: false,
    capturedByUpdateSetNote: 'A scoped application is its own migration unit; it is not carried in an update set.',
    evidence: 'servicenow/applications.js, app-create.js, workspaces.js; ledger sys-scope-insert-is-a-husk',
  },

  update_set: {
    kind: 'update_set',
    label: 'Update Set',
    table: 'sys_update_set',
    classification: 'configuration',
    parts: ['name', 'state', 'application', 'changes'],
    structure: {
      changes: { table: 'sys_update_xml' },
      // Measured: sys_update_set.application is forced to the session's current
      // application scope on both insert and update, so it cannot be set over
      // REST at all (ledger: rest-silently-drops-field-writes).
      application: { writable: false, note: 'Forced to the session scope on insert AND update; unsettable over REST.' },
      carries: { note: 'Configuration only — anything extending sys_metadata. Never task data.' },
    },
    relationships: [
      { part: 'changes', to: 'sys_update_xml', nature: 'child', via: 'update_set' },
    ],
    mechanism: 'rest',
    mechanismNotes: { scoped_set_creation: 'harness' },
    verification: 'read_back',
    capturedByUpdateSet: false,
    evidence: 'servicenow/transport.js, transport-export.js; ledger rest-silently-drops-field-writes',
  },
});

export const ARTIFACT_KINDS = Object.freeze(Object.keys(ARTIFACTS));

/** Which artifact model, if any, describes this table. */
export function artifactForTable(tableName) {
  const name = String(tableName || '');
  const hit = Object.values(ARTIFACTS).find((a) => a.table === name);
  return hit || null;
}

/* ------------------------------------------------------------------ *
 * Reference fields
 * ------------------------------------------------------------------ */

/**
 * Does this field point at a record in another table, and which?
 *
 * PHASE 13 — WHY THIS EXISTS, and it is not a style preference. Measured on the
 * live instance, writing a person's NAME into `incident.assigned_to`:
 *
 *   "Abel Tuter"            -> resolved to 62826bf0…  read-back: TRANSFORMED
 *   "Zzz Nonexistent Person"-> stored VERBATIM, display_value ""   read-back: APPLIED
 *
 * The second row is the whole problem. The platform accepted a string that
 * identifies nobody, left a dangling reference on the record, and returned
 * success — and `applied` is not in `isFailedWrite`, so it reaches evidence as
 * VERIFIED. A person would be told the incident was assigned when it was
 * assigned to no one. Nothing downstream can catch this: the write succeeded,
 * the read-back agreed, and the value is exactly what was asked for.
 *
 * So it has to be caught BEFORE the write, and this is the fact that lets it
 * be: a reference field holds a sys_id, therefore a literal that is not a
 * sys_id is a name that has not been resolved yet.
 *
 * SOURCED, NOT INVENTED. The answer comes from the `relationships` the artifact
 * models already declare — the same declarations `describeArtifact` asks the
 * live dictionary to confirm. Nothing here adds ServiceNow knowledge; it reads
 * what the semantic layer had already written down.
 */
export function referenceFieldOf(tableName, fieldName) {
  const artifact = artifactForTable(tableName);
  if (!artifact) return null;
  const rel = (artifact.relationships || [])
    .find((r) => r.field && r.field === fieldName && r.nature === 'reference');
  if (!rel) return null;
  return fact(
    { references: rel.to, field: fieldName },
    'managed_source',
    {
      note: `${tableName}.${fieldName} points at a ${rel.to} record, which is identified by sys_id.`,
      evidence: { artifact: artifact.table, declared: rel },
    },
  );
}

/**
 * The constraints a planner must satisfy, written out for the planner.
 *
 * PHASE 13 — CLOSING A CHANNEL THAT WAS BUILT AND NEVER CONNECTED.
 * `plannerSystem` has always accepted a `semantics` block and rendered it under
 * SEMANTIC CONSTRAINTS; every caller passed null. So the deterministic layer
 * knew two things the model was never told, and then refused the model's plans
 * for not knowing them:
 *
 *   priority is computed        -> writes_derived_field
 *   a reference field is an id  -> reference_field_not_an_identity
 *
 * Measured: asked to raise an incident's priority, the model wrote `priority`
 * directly on every attempt and every attempt was refused. The system was SAFE
 * and useless — the request was reasonable and simply could not be served.
 *
 * This states the rule the validator will apply, in the same words, sourced
 * from the same declarations. It adds no ServiceNow knowledge: DERIVED_FIELDS
 * and each artifact's `relationships` are what the validator itself reads. The
 * model is not being trusted with the rule — it is being told what it will be
 * held to, and the validator still decides.
 */
export function semanticConstraints({ derived = DERIVED_FIELDS, artifacts = ARTIFACTS } = {}) {
  const lines = [];

  for (const [field, rule] of Object.entries(derived)) {
    lines.push(`- ${field} on ${rule.tables.join(', ')} is COMPUTED from `
      + `${rule.inputs.join(' + ')}. ${rule.guidance}`);
  }

  const refs = [];
  for (const art of Object.values(artifacts)) {
    for (const rel of art.relationships || []) {
      /* `field` is a column on this table; `part` is a structural relationship
       * (an ACL's role lives in a child record, not in a column). Only a
       * column can be written, so only a column is a constraint here. */
      if (rel.nature !== 'reference' || !rel.field) continue;
      refs.push(`${art.table}.${rel.field} -> ${rel.to}`);
    }
  }
  if (refs.length) {
    lines.push(`- These fields hold a sys_id, never a name: ${refs.join(', ')}. `
      + 'To set one from a name, first resolve it with lookup_reference and reference the result '
      + 'as { "$ref": "<step>.result.sys_id" }. Writing a name is refused: the platform accepts it '
      + 'and stores a broken reference that reads back as success.');
  }

  return lines.length ? lines.join('\n') : null;
}

/**
 * The declared model for one artifact kind, merged with the LIVE shape of its
 * table.
 *
 * The merge direction is the point: the model contributes structure the
 * dictionary cannot express (a flow's trigger is an encoded blob; an ACL is two
 * records; a duration carries days in its date half), and the instance
 * contributes the field list, the types and the choices. Where the model names
 * a relationship, the live schema is asked to CONFIRM it — a declared reference
 * that the dictionary does not have is reported as unconfirmed rather than
 * repeated, because a model that has drifted from a release is exactly the kind
 * of confident wrong answer this layer exists to prevent.
 */
export async function describeArtifact(kind, { describe = describeTable } = {}) {
  const model = ARTIFACTS[kind];
  if (!model) {
    return {
      kind,
      status: STATUS.UNKNOWN,
      note: `"${kind}" is not a modelled artifact. Known kinds: ${ARTIFACT_KINDS.join(', ')}. `
        + 'Nothing is assumed about an unmodelled artifact.',
    };
  }

  const live = await describe(model.table);
  const declared = {
    kind: model.kind,
    label: model.label,
    table: model.table,
    classification: fact(model.classification, 'managed_source', {
      note: model.classification === 'data'
        ? 'Data: never carried by an update set and not owned by an application scope.'
        : 'Configuration: extends sys_metadata, so it travels in an update set or a scoped app.',
    }),
    parts: fact(model.parts, 'managed_source'),
    structure: model.structure ? fact(model.structure, 'managed_source') : null,
    mechanism: fact(model.mechanism, 'managed_source', {
      note: model.mechanismNotes ? `Exceptions: ${JSON.stringify(model.mechanismNotes)}` : null,
    }),
    verification: fact(model.verification, 'managed_source', { note: model.verificationNotes ?? null }),
    requiresElevation: model.requiresElevation
      ? fact(true, 'managed_source', { note: `requires ${model.elevationRole}`, evidence: { role: model.elevationRole } })
      : fact(false, 'managed_source'),
    capturedByUpdateSet: fact(Boolean(model.capturedByUpdateSet), 'managed_source', {
      note: model.capturedByUpdateSetNote ?? null,
    }),
    evidence: model.evidence,
  };

  // Confirm each declared relationship against the live dictionary.
  const liveRefs = new Map((live.references || []).map((r) => [r.field, r.table]));
  const relationships = (model.relationships || []).map((rel) => {
    if (!rel.field) {
      // A structural relationship (a child table, a runtime table). The
      // dictionary cannot confirm these, and saying so is more honest than
      // presenting them at the same confidence as a confirmed reference.
      return { ...rel, confirmed: fact(false, 'managed_source', { note: 'structural — not a dictionary reference, so not confirmable from the schema' }) };
    }
    const liveTarget = liveRefs.get(rel.field);
    if (!liveTarget) {
      return {
        ...rel,
        confirmed: unknown(`${model.table}.${rel.field} is declared to reference ${rel.to}, but the live dictionary `
          + 'does not carry that reference on this instance. Treat the declaration as unconfirmed.'),
      };
    }
    if (liveTarget !== rel.to) {
      return {
        ...rel,
        // LIVE SCHEMA WINS. The declared value is kept visible so a drift is
        // fixable rather than merely overridden.
        confirmed: fact(liveTarget, 'live_schema', {
          note: `the model declared ${rel.to} but this instance's dictionary says ${liveTarget}; live schema wins`,
          evidence: { declared: rel.to, live: liveTarget },
        }),
      };
    }
    return { ...rel, confirmed: fact(liveTarget, 'live_schema') };
  });

  return {
    ...declared,
    status: live.status,
    live,
    relationships,
    derived: model.derived
      ? fact(model.derived, 'ledger', { note: 'computed fields — see the field-level derivation for the evidence' })
      : null,
  };
}
