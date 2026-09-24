/**
 * PHASE 2 — THE CAPABILITY TAXONOMY, AND THE THREE STATIC MAPS.
 *
 * This file is DATA. It contains no logic that can decide anything about a
 * ServiceNow operation: no policy, no approval, no execution, no I/O. It says
 * only which of the agent's tools, operating rules and measured facts belong to
 * which area of ServiceNow work, so the assembly layer can send the model the
 * part of its surface the current request is actually about.
 *
 * WHY THE MAPS LIVE HERE AND NOT ON THE TOOLS THEMSELVES. The registry contract
 * in agent/tools.js is `{ name, description, inputSchema, mutating, execute,
 * describeWrite }`, and it is consumed by the orchestrator, the approval gate,
 * the write guard and the mutation ledger. Threading a classification through
 * 90 tool literals would put a presentation concern inside the execution
 * contract and produce a diff nobody could review. A companion map keeps the
 * contract untouched — and `test/context-engine.test.js` asserts the map covers
 * the LIVE registry exactly, so it cannot silently go stale when a tool is
 * added.
 *
 * THE DEFAULT IS ALWAYS "INCLUDE". An unclassified rule is global. An
 * unclassified fact is global. An unclassified tool is a test failure rather
 * than a silent exclusion. Every direction of doubt resolves toward the model
 * seeing MORE, because the cost of a missing tool is a broken turn and the cost
 * of a missing safety rule is a wrong write, while the cost of an extra one is
 * some tokens.
 */

/**
 * The taxonomy. Deliberately small — around twenty areas that correspond to
 * things this agent actually does, rather than a hierarchy invented in advance.
 *
 * `core` is not a domain. It is the set every profile receives: reading schema,
 * resolving references, reading records, and reaching memory and documentation.
 * Almost every operating rule assumes those are available — rule 1 requires
 * `lookup_reference`, rules 2 and 17 require `get_table_schema` — so a profile
 * without them would contradict its own instructions.
 */
export const CAPABILITIES = Object.freeze([
  'core',
  'record_read',
  'record_mutation',
  'schema_read',
  'schema_authoring',
  'reference_analysis',
  'dependency_analysis',
  'impact_analysis',
  'incident',
  'catalog',
  /*
   * EXPERIENCE §79.13 — READING a flow, as distinct from authoring one.
   *
   * Added because the Skills layer made an existing gap visible rather than
   * because anything needed a new profile. NowLint and Change Intelligence read
   * published flows and never edit one, but `list_flows` and `get_flow` were
   * reachable only through `flow_authoring` — so a skill declaring what those
   * two domains actually do computed a permission set including
   * `create_flow_live` and `delete_live_flow`, and a permission display that
   * overstates is the same defect as one that understates.
   *
   * PURELY ADDITIVE. `flow_authoring` implies it, so every existing profile
   * selects exactly the tools it selected before; nothing classifies a request
   * to `flow_read`, so no request changes shape. It exists so a read-only flow
   * capability can be NAMED.
   */
  'flow_read',
  'flow_authoring',
  'sla',
  'acl',
  'application',
  /*
   * Business rules, email notifications and server-side scripts — the three
   * authoring areas the agent used to report it could not reach. Each is its
   * own domain so its tools come from its own requests, never leaking into an
   * unrelated one (the rule this map follows, below).
   */
  'business_rule',
  'notification',
  'scripting',
  'update_set',
  'impersonation',
  'dba',
  'verification',
  'build',
  'deployment',
  'knowledge',
  'memory',
]);

const KNOWN = new Set(CAPABILITIES);

/**
 * Capabilities that IMPLY others, applied as a closure before selection.
 *
 * This is the mechanism that stops a narrow classification from producing a
 * turn that cannot finish. Authoring a flow means building it, deploying it and
 * offering to verify it — rule 7 says so in the prompt — so a request
 * classified `flow_authoring` must arrive with those tools already present
 * rather than discovering the gap three iterations in.
 *
 * Expansion is one-way and monotonic: it only ever adds.
 */
export const IMPLIES = Object.freeze({
  flow_authoring: ['flow_read', 'build', 'deployment', 'verification', 'schema_read', 'reference_analysis'],
  sla: ['verification', 'schema_read'],
  acl: ['schema_read'],
  catalog: ['schema_read', 'reference_analysis'],
  schema_authoring: ['dba', 'impact_analysis', 'dependency_analysis', 'schema_read', 'build'],
  dba: ['schema_read'],
  impact_analysis: ['dependency_analysis', 'schema_read', 'dba'],
  dependency_analysis: ['schema_read', 'dba'],
  application: ['build'],
  business_rule: ['schema_read', 'reference_analysis'],
  notification: ['schema_read', 'reference_analysis'],
  scripting: ['schema_read'],
  incident: ['record_read', 'record_mutation', 'schema_read'],
  record_mutation: ['record_read', 'schema_read', 'reference_analysis'],
  impersonation: ['record_read'],
});

/** Close a requested set under IMPLIES. Deterministic and order-independent. */
export function expandCapabilities(requested) {
  const out = new Set(['core']);
  const queue = [...(requested || [])];
  while (queue.length) {
    const cap = queue.shift();
    if (!KNOWN.has(cap) || out.has(cap)) continue;
    out.add(cap);
    for (const implied of IMPLIES[cap] || []) if (!out.has(implied)) queue.push(implied);
  }
  // Sorted so the same input always produces the same array, which is what
  // makes the whole profile comparable between two invocations.
  return Object.freeze([...out].sort());
}

/* ------------------------------------------------------------------ *
 * 1. TOOLS
 *
 * Every tool in the live registry appears exactly once. The suite asserts
 * that both ways — no tool missing, no entry naming a tool that no longer
 * exists — so adding a tool without classifying it fails a test rather than
 * quietly making it unreachable.
 * ------------------------------------------------------------------ */

/**
 * THE RULE THIS MAP FOLLOWS, discovered by getting it wrong twice.
 *
 * A tool is tagged with the DOMAIN it belongs to, and with a CROSS-CUTTING
 * capability only when it is that capability's own generic surface.
 *
 * The cross-cutting ones — `record_mutation`, `verification`, `build`,
 * `deployment`, `schema_read`, `reference_analysis`, `dependency_analysis` —
 * describe what a tool DOES, not where it lives. Used as selectors on a domain
 * tool they leak that whole domain into every request that implies them:
 * tagging `create_sla` with `record_mutation` exposed it on any incident
 * update; tagging `verify_sla_live` with `verification` exposed it on any flow
 * task, because authoring a flow implies verifying one; tagging
 * `create_flow_live` with `build` exposed it on any column change.
 *
 * So those capabilities still drive RULE and FACT selection, where "this turn
 * involves verification" is exactly the right question — and they select tools
 * only through `core` and the three generic record tools. A domain's tools come
 * from the domain, and from nowhere else.
 *
 * `dependency_analysis` reaches the DBA tools the same way, through IMPLIES
 * rather than through a tag: asking what depends on a table implies `dba`, and
 * `dba` selects the tools. Tagging them as well would be redundant, and a
 * redundant tag is the shape the leaks above started as.
 */
export const TOOL_CAPABILITIES = Object.freeze({
  // --- core: available in every profile -------------------------------------
  test_connection: ['core'],
  get_table_schema: ['core', 'schema_read'],
  lookup_reference: ['core', 'reference_analysis'],
  lookup_table: ['core', 'schema_read'],
  query_records: ['core', 'record_read'],
  get_record: ['core', 'record_read'],
  /*
   * PHASE 15 — the diagnostic evidence surfaces.
   *
   * Classified `record_read` because that is what they are: scoped, read-only
   * reads of one record's history. Plus `incident`, so an incident-shaped
   * profile carries them — the case Phase 15 exists to serve. Deliberately NOT
   * `core`: a profile with no reason to investigate should not pay for six
   * extra tool descriptions in every prompt.
   */
  find_flow_executions: ['record_read', 'incident'],
  get_flow_execution: ['record_read', 'incident'],
  /* PHASE 17 — classified with the surface it polls, for the same reasons. */
  wait_for_flow_execution: ['record_read', 'incident'],
  get_record_audit: ['record_read', 'incident'],
  get_record_journal: ['record_read', 'incident'],
  get_record_slas: ['record_read', 'incident', 'sla'],
  get_ci_relationships: ['record_read', 'incident'],

  /* The whole surface, in every profile — so "can you do X" is answered from the
     registry rather than from the slice a request was classified into. */
  list_agent_capabilities: ['core'],

  recall_memory: ['core', 'memory'],
  // Always present: a turn with a file attached can be about anything.
  read_attachment: ['core'],
  list_instance_facts: ['core', 'memory'],
  remember_fact: ['core', 'memory'],
  search_servicenow_docs: ['core', 'knowledge'],
  knowledge_status: ['core', 'knowledge'],
  resolve_source_conflict: ['core', 'knowledge'],
  record_verified_observation: ['core', 'knowledge'],
  list_verified_observations: ['core', 'knowledge'],

  // --- the GENERIC record-writing surface -----------------------------------
  // `record_mutation` means these three tools and nothing else. It is NOT a
  // label for "this tool writes" — the registry's own `mutating` flag says
  // that, and it is what the approval gate reads. Tagging a domain tool with it
  // would make that domain's authoring surface reachable from any request that
  // merely implied a record write.
  create_record: ['record_mutation'],
  update_record: ['record_mutation'],
  delete_record: ['record_mutation'],

  // --- incident --------------------------------------------------------------
  create_incident: ['incident'],

  // --- catalog ---------------------------------------------------------------
  create_catalog_item: ['catalog'],
  create_record_producer: ['catalog'],
  get_catalog_item: ['catalog'],
  add_catalog_variable: ['catalog'],
  update_catalog_variable: ['catalog'],
  list_ui_policies: ['catalog'],
  create_ui_policy: ['catalog'],
  update_ui_policy: ['catalog'],
  delete_ui_policy: ['catalog'],
  list_catalogs: ['catalog'],
  create_catalog: ['catalog'],
  list_catalog_categories: ['catalog'],
  create_catalog_category: ['catalog'],
  list_variable_sets: ['catalog'],
  create_variable_set: ['catalog'],
  add_variable_set_variable: ['catalog'],
  attach_variable_set: ['catalog'],
  detach_variable_set: ['catalog'],

  // --- flows and subflows ----------------------------------------------------
  // Subflows are authored through the same tools with `artifact_type`, so they
  // are not a separate capability: splitting them would produce two profiles
  // that must always be requested together.
  list_flows: ['flow_authoring', 'flow_read'],
  get_flow: ['flow_authoring', 'flow_read'],
  edit_flow: ['flow_authoring'],
  restore_flow: ['flow_authoring'],
  design_flow_blueprint: ['flow_authoring'],
  flow_authoring_capability: ['flow_authoring'],
  create_flow_live: ['flow_authoring'],
  /*
   * Publishing an installed artifact. `flow_authoring` ONLY.
   *
   * It was briefly tagged `['flow_authoring', 'deployment']` on the reasoning
   * that "make this flow live" is a deployment question. T3b caught it, and
   * T3b is right: `deployment` is CROSS-CUTTING, so tagging a domain tool with
   * it drags the whole flow domain into every request that merely implies
   * deployment — a column change would have started carrying the flow tools,
   * which is the exact leak that guard was written for. The flow domain
   * selects its own tools and nothing else does.
   */
  activate_flow: ['flow_authoring'],
  list_live_flows: ['flow_authoring'],
  delete_live_flow: ['flow_authoring'],
  verify_flow_live: ['flow_authoring'],
  smoke_test_flow: ['flow_authoring'],

  // --- SLA -------------------------------------------------------------------
  list_slas: ['sla'],
  get_sla: ['sla'],
  sla_meta: ['sla'],
  create_sla: ['sla'],
  verify_sla_live: ['sla'],

  // --- access control --------------------------------------------------------
  acl_report: ['acl'],
  acl_diff: ['acl'],
  explain_acls: ['acl'],
  create_acl: ['acl'],
  update_acl: ['acl'],
  delete_acl: ['acl'],

  // --- applications and transport -------------------------------------------
  list_applications: ['application'],
  create_application: ['application'],
  create_custom_application: ['application'],
  check_scope_name: ['application'],
  list_captured_sets: ['update_set'],

  // --- business rules, notifications, server scripts -----------------------
  list_business_rules: ['business_rule'],
  create_business_rule: ['business_rule'],
  update_business_rule: ['business_rule'],
  list_notifications: ['notification'],
  create_notification: ['notification'],
  run_server_script: ['scripting'],

  // --- impersonation ---------------------------------------------------------
  impersonation_start: ['impersonation'],
  impersonation_switch: ['impersonation'],
  impersonation_end: ['impersonation'],
  impersonation_status: ['impersonation'],
  impersonation_provenance: ['impersonation'],

  // --- DBA: schema intelligence (read) ---------------------------------------
  dba_context: ['dba'],
  dba_raw_metadata: ['dba'],
  dba_get_table: ['dba'],
  dba_list_fields: ['dba'],
  dba_get_field: ['dba'],
  dba_get_hierarchy: ['dba'],
  dba_get_references: ['dba'],
  dba_resolve_reference: ['dba'],
  dba_dot_walk: ['dba'],
  dba_classify: ['dba'],
  dba_resolve_identifier: ['dba'],
  dba_list_choices: ['dba'],
  dba_get_relationships: ['dba'],
  dba_list_indexes: ['dba'],
  dba_schema_map: ['dba'],

  // --- DBA: impact and safety (read) ----------------------------------------
  dba_analyze_impact: ['dba', 'impact_analysis'],
  dba_classify_operation: ['dba', 'impact_analysis'],
  dba_check_integrity: ['dba', 'impact_analysis'],
  dba_preflight: ['dba', 'impact_analysis', 'schema_authoring'],
  dba_audit: ['dba', 'impact_analysis'],

  // --- DBA: schema authoring -------------------------------------------------
  dba_preview_table_source: ['dba', 'schema_authoring'],
  dba_create_table: ['dba', 'schema_authoring'],
  dba_table_constraints: ['dba', 'schema_authoring'],
  dba_column_route: ['dba', 'schema_authoring'],
  dba_add_field: ['dba', 'schema_authoring'],
  dba_modify_field: ['dba', 'schema_authoring'],
  dba_drop_field: ['dba', 'schema_authoring'],
  dba_augment_table: ['dba', 'schema_authoring'],

  // --- DBA: data operations and the irreversible gate ------------------------
  dba_set_field_value: ['dba'],
  dba_delete_record: ['dba'],
  dba_create_record: ['dba'],
  dba_read_record: ['dba', 'record_read'],
  dba_recovery_status: ['dba'],
  dba_snapshot: ['dba'],
  dba_destructive_gate: ['dba'],
  dba_execute_irreversible: ['dba'],
});

/* ------------------------------------------------------------------ *
 * 2. OPERATING RULES
 *
 * `GLOBAL` means the rule is sent on every invocation, whatever the request.
 * A rule is global unless there is a positive reason it is not — an unmapped
 * rule id is treated as global by `selectRules`, so a rule added later is
 * over-sent rather than lost.
 *
 * THE TEST OF "IS THIS GLOBAL" IS NOT TOPIC, IT IS CONSEQUENCE. The question is
 * "if the model does not see this on an unrelated turn, can it do damage or
 * report something false?" — never "is this rule about flows". Rule 23 is
 * nominally about update sets and is global, because the failure it prevents is
 * telling a user their incident was captured into one. Rule 19 is nominally
 * about a verification block and is global, because without it a partial write
 * gets narrated as a success.
 * ------------------------------------------------------------------ */

export const GLOBAL = 'GLOBAL';

export const RULE_CAPABILITIES = Object.freeze({
  1: GLOBAL,      // never invent sys_ids — the confabulation guard's own instruction
  2: GLOBAL,      // read the schema before writing
  3: GLOBAL,      // the approval gate IS the confirmation
  '3b': GLOBAL,   // never combine a question with a tool call
  4: GLOBAL,      // confirm destructive actions in conversation first
  5: ['catalog'],
  6: ['flow_authoring', 'build', 'deployment'],
  7: ['flow_authoring', 'verification'],
  8: GLOBAL,      // report the number and sys_id back
  9: GLOBAL,      // reply style — cheap, and it shapes every answer
  10: GLOBAL,     // read the error, adjust, retry once
  11: GLOBAL,     // "remember: ..."
  12: GLOBAL,     // recall_memory rather than claiming ignorance
  13: ['sla'],
  14: ['catalog'],
  15: ['acl'],
  '15b': ['acl'],
  '15c': ['acl'],
  '15d': ['acl'],
  '15e': ['acl'],
  16: GLOBAL,     // the native-capability check happens BEFORE designing
  17: GLOBAL,     // the field list is complete; a missing field means STOP AND ASK
  18: GLOBAL,     // an ambiguous reference may not enter a mutation payload
  19: GLOBAL,     // read the verification block before reporting anything
  20: GLOBAL,     // a dropped write means the platform is overriding you
  21: ['application'],
  22: ['application'],
  23: GLOBAL,     // configuration vs data — the update-set honesty rule
  24: GLOBAL,     // business-rule aborts: never silently drop blocked fields
  25: ['dba', 'schema_authoring'],
  26: GLOBAL,     // documentation informs, it never authorises
  27: GLOBAL,     // the precedence ladder
  28: GLOBAL,     // an observation must carry its artifact
});

/* ------------------------------------------------------------------ *
 * 3. FACTS AND TRAPS
 *
 * Keyed by the ledger's own `key`, never by matching the text.
 *
 * THAT DISTINCTION IS THE WHOLE POINT, and it is the answer to a measured
 * failure recorded in memory/facts.js: selecting facts by lexical overlap with
 * the turn was built, measured against seven realistic prompts, and did not
 * hold — "Add a field called warranty_expiry to the incident table" ranked two
 * ACL traps top and surfaced none of the three field-write traps that request
 * is actually about. The conclusion drawn there was that the ledger ships whole
 * "until a selector can be shown to keep the relevant fact".
 *
 * A key map is that selector. It cannot rank an ACL trap into a schema request,
 * because relevance is declared once, by a human, against the fact's identity —
 * not recomputed per turn from a similarity score. The suite re-runs that exact
 * failing prompt as a test.
 *
 * A fact with no entry here is GLOBAL. That covers every fact a user adds at
 * runtime through `remember_fact`, every fact `recordVerificationFailure`
 * writes, and any seed added later without a classification.
 * ------------------------------------------------------------------ */

export const FACT_CAPABILITIES = Object.freeze({
  // --- global: these bite on ANY read or write ------------------------------
  'priority-is-calculated': GLOBAL,
  'encoded-query-silent-drop': GLOBAL,
  'unknown-field-writes-accepted': GLOBAL,
  'sysparm-fields-drops-unknown': GLOBAL,
  'rest-silently-drops-field-writes': GLOBAL,
  'dictionary-readonly-does-not-predict-rest-writes': GLOBAL,
  'lookup-contains-shadows-exact': GLOBAL,
  'incidents-are-data-not-config': GLOBAL,
  'journal-fields-invisible-to-get': GLOBAL,
  'ollama-ignores-seed': GLOBAL,
  'model-repetition-loop-at-http-200': GLOBAL,

  // --- flows, the SDK, and deployment ---------------------------------------
  'trigger-strategy-default-once': ['flow_authoring'],
  'keys-ts-is-project-global': ['flow_authoring', 'build', 'schema_authoring'],
  'lookuprecord-miss-errors-flow': ['flow_authoring'],
  'install-ships-whole-application': ['build', 'deployment', 'flow_authoring', 'schema_authoring'],
  'trigger-instance-v2-blob': ['flow_authoring'],
  'schedules-stored-in-utc': ['flow_authoring'],
  'verify-locator-carries-proof': ['verification', 'flow_authoring'],
  'es3-reserved-key-kills-job-silently': ['build', 'verification', 'impersonation'],

  // --- SLA -------------------------------------------------------------------
  'task-sla-row-proves-nothing': ['sla'],
  'contract-sla-duration-carries-days': ['sla'],
  'sla-schedule-inert-without-source': ['sla'],
  'task-sla-times-are-utc': ['sla'],

  // --- access control --------------------------------------------------------
  'acl-operation-sysids-inconsistent': ['acl'],
  'acl-name-prefix-matches-siblings': ['acl'],
  'acl-read-only-never-authored': ['acl'],
  'admin-overrides-inverts-a-role-diff': ['acl'],

  // --- catalog ---------------------------------------------------------------
  'ui-policy-action-not-writable-over-rest': ['catalog'],
  'ui-policy-condition-is-io-prefixed-sysid': ['catalog'],
  'ui-policy-action-states-default-to-ignore': ['catalog'],
  'variable-type-codes-drift': ['catalog'],
  'edit-variables-in-place': ['catalog'],
  'ui-policy-proven-only-by-the-form': ['catalog', 'verification'],

  // --- impersonation ---------------------------------------------------------
  'impersonation-predicates-are-constants': ['impersonation'],
  'impersonate-unknown-sysid-lands-on-guest': ['impersonation'],
  'gliderecordsecure-rowcount-lies': ['impersonation'],
  'plain-gliderecord-ignores-impersonation': ['impersonation'],
  'impersonated-denials-are-silent': ['impersonation'],
  'impersonation-crash-safety-is-the-boundary': ['impersonation'],
  'impersonation-eligibility-is-nha-owned': ['impersonation'],
  'impersonation-provenance-is-nha-sole': ['impersonation'],
  'impersonation-has-no-instance-audit': ['impersonation'],

  // --- applications ----------------------------------------------------------
  'sys-scope-insert-is-a-husk': ['application'],

  // --- measured on this instance --------------------------------------------
  'incident.problem-link-absent': ['incident', 'schema_read'],
  'hardware-group-has-no-manager': ['reference_analysis'],
});

/** Is this a capability the taxonomy knows? Used to refuse invented ones. */
export const isCapability = (c) => KNOWN.has(c);
