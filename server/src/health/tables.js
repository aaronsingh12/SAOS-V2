import crypto from 'node:crypto';

/**
 * The extraction allow-list — Health Assist may read these tables and no others.
 *
 * Ported from SAOS `app/servicenow/tables.py`. The property that matters is not
 * the list, it is that there IS one: a health check that could name an
 * arbitrary table is a health check that can be pointed at anything, and the
 * agent surface elsewhere in this app already has a gate for that. This module
 * reads, so instead of a gate it gets a closed vocabulary.
 *
 * Every spec carries its own field list. That is also deliberate:
 * `sysparm_fields` DROPS names the table does not have, without complaint
 * (trap #4), so the extractor compares what came back against what was asked
 * for and reports the difference as coverage rather than letting a rule run on
 * a field that was never populated.
 *
 * `required: true` means the run cannot proceed without it. Everything else is
 * optional and its absence is reported as `not_requested`, never as zero rows —
 * "we did not look" and "there is nothing there" are different facts.
 */

/** sys_id and sys_updated_on are implicit on every spec: identity, and staleness. */
function spec(key, fields, required = false, { filter = null, filterLabel = null, optIn = false } = {}) {
  return Object.freeze({
    key,
    fields: Object.freeze([...new Set(['sys_id', 'sys_updated_on', ...fields.split(',')])]),
    required,
    filter,
    filterLabel,
    /*
     * OPT-IN: in the allow-list, but never read unless a caller names it.
     *
     * `sys_audit` is the case this exists for. It is an append-only log, so it
     * changes on EVERY run: including it by default would make the CMDB module
     * report "changed" on every incremental check and destroy the scan reuse the
     * planner exists for — a bad trade for the one rule that wants it
     * (CMDB-077). An estate that would rather have the rule can ask for the
     * table by name, and the cost is then a choice rather than a surprise.
     */
    optIn,
  });
}

/**
 * Days of closed ITSM history a run reads alongside everything still open.
 *
 * An ITSM table on a real instance holds every incident since go-live, and
 * health is a question about what is live NOW plus recent outcomes. Reading all
 * of it would make a run take as long as the instance is old. The window is
 * stated on the coverage row, so a score computed over it says what it covers.
 */
export const ITSM_WINDOW_DAYS = 90;

/**
 * `active=true OR updated inside the window`, as an encoded query.
 *
 * The date is computed here rather than with `javascript:gs.daysAgoStart()`:
 * a script clause in a REST query is something some instances restrict, and a
 * literal is testable offline. `^OR` binds to the condition before it, so the
 * extractor's `sys_updated_on<=cutoff^<this>` reads as
 * `cutoff AND (active OR recent)` — which is the intended slice.
 */
function openOrRecent(cutoff) {
  const base = cutoff ? new Date(`${String(cutoff).replace(' ', 'T')}Z`) : new Date();
  const from = new Date(base.getTime() - ITSM_WINDOW_DAYS * 86_400_000)
    .toISOString().replace('T', ' ').slice(0, 19);
  return `active=true^ORsys_updated_on>=${from}`;
}

const ITSM_SLICE = { filter: openOrRecent, filterLabel: `active, or updated in the last ${ITSM_WINDOW_DAYS} days` };

export const TABLES = Object.freeze({
  /* Group 2 (Completeness) reads mac_address, company, location, cost_center,
     correlation_id and life_cycle_stage_status — all on cmdb_ci itself, verified on
     dev424910. `used_for` is NOT on cmdb_ci (only on servers, applications…), so it is
     read per class in extractCmdbMeta. `business_criticality` is not on cmdb_ci on
     that version either; it stays requested and is reported as a missing field. */
  cmdb_ci: spec('cis', 'name,sys_class_name,serial_number,fqdn,ip_address,mac_address,owned_by,owned_by.active,owned_by.name,managed_by,managed_by.active,managed_by.name,assigned_to,assigned_to.active,support_group,support_group.name,operational_status,install_status,discovery_source,last_discovered,first_discovered,business_criticality,company,location,cost_center,correlation_id,life_cycle_stage,life_cycle_stage_status,asset,sys_created_on,sys_created_by,sys_updated_by,sys_mod_count', true),
  cmdb_rel_ci: spec('relationships', 'parent,child,type,type.name,sys_created_by,sys_created_on', true),
  cmdb_ci_service: spec('services', 'name,sys_class_name,owned_by,owned_by.name,managed_by,support_group,support_group.name,operational_status,life_cycle_stage,life_cycle_stage_status,busines_criticality,used_for'),
  service_offering: spec('offerings', 'name,parent,owned_by'),
  ecc_agent: spec('mid_servers', 'name,status,validated,last_refreshed'),
  ecc_queue: spec('ecc_queue', 'name,state,queue,agent,sys_created_on'),
  em_alert: spec('alerts', 'number,cmdb_ci,state,severity,source'),
  /* ── ITSM ────────────────────────────────────────────────────────────────
   * Read as a slice — open records plus the recent window — for the reason
   * given on ITSM_WINDOW_DAYS. The fields are the ones the ITSM rules actually
   * use; anything else would only widen what an ACL can drop. */
  incident: spec('incidents', 'number,short_description,cmdb_ci,business_service,priority,state,active,assignment_group,assigned_to,sys_created_on,resolved_at,reopen_count', false, ITSM_SLICE),
  change_request: spec('changes', 'number,short_description,cmdb_ci,priority,state,active,type,close_code,assignment_group,start_date,end_date,sys_created_on', false, ITSM_SLICE),
  problem: spec('problems', 'number,short_description,cmdb_ci,priority,state,active,assignment_group,sys_created_on', false, ITSM_SLICE),
  sys_script: spec('business_rules', 'name,collection,active,when,condition,filter_condition,script,sys_scope'),
  sys_rest_message: spec('integrations', 'name,rest_endpoint,sys_scope'),
  sys_trigger: spec('jobs', 'name,state,next_action,sys_created_on'),
  sys_upgrade_history_log: spec('upgrade_logs', 'name,disposition,resolution_status,upgrade_history'),
  sys_user_has_role: spec('user_roles', 'user,user.active,role,role.name,inherited'),

  /* ── ITOM ────────────────────────────────────────────────────────────────
   *
   * Probed on dev424910 before being added, because a spec for a table that is
   * not on the instance reports `unavailable` forever and teaches a reader to
   * ignore the coverage strip. What is here EXISTS; several are legitimately
   * EMPTY, which for ITOM is the interesting case rather than the boring one —
   * an empty `discovery_status` means Discovery has never run, and that is a
   * finding, not a clean bill of health.
   *
   * Event Management (`em_event`, `em_match_rule`) is deliberately absent: it
   * is not installed here and answers 400. `em_alert` stays in the list above
   * because the rule that reads it predates this and its coverage already
   * reports `unavailable` correctly.
   */
  discovery_status: spec('discovery_schedules', 'status,state,started,completed,duration,scan_type,source,discover,agent,sys_created_on'),
  discovery_device_history: spec('discovery_devices', 'source,issues,state,last_scan,scan_status,cmdb_ci,discovery_status,sys_created_on'),
  discovery_log: spec('discovery_logs', 'level,message,source,agent,sys_created_on,discovery_status'),
  discovery_credentials: spec('credentials', 'name,type,active,user_name,applies_to,order,tag'),
  ecc_agent_capability: spec('mid_capabilities', 'agent,capability,value'),
  ecc_agent_issue: spec('mid_issues', 'agent,issue,state,severity,sys_created_on'),
  svc_ci_assoc: spec('service_ci_links', 'service,ci,manual'),
  cmdb_ci_service_discovered: spec('discovered_services', 'name,operational_status,service_classification,busines_criticality,owned_by,used_for'),
  cmdb_ci_outage: spec('outages', 'cmdb_ci,type,begin,end,duration,details,task_number'),
  sysauto: spec('scheduled_jobs', 'name,active,run_type,run_start,run_period,conditional,condition'),

  /* ── CMDB HEALTH GOVERNANCE — the trust gate (SAOS Group 1) ─────────────
   * Verified on dev424910, 15 Sep 2026. `cmdb_health_inclusion_rule` does not
   * exist: inclusion rules are `cmdb_health_config`, weights are
   * `cmdb_health_metric_pref`, configured attributes are
   * `cmdb_recommended_fields`, principal classes are `cmdb_class_info`. All are
   * small configuration tables. `sysauto_script` is read only for the CMDB
   * Health jobs, and the filter goes into the count so "complete" still means
   * every matching row. */
  cmdb_health_config: spec('health_inclusion_rules', 'applies_to,active_record_condition,metric,sys_overrides,sys_created_on'),
  cmdb_health_metric: spec('health_metrics', 'name,friendly_name,parent'),
  cmdb_health_metric_pref: spec('health_metric_weights', 'metric,active,weighted_average_contribution,failure_threshold,sys_mod_count,sys_created_on'),
  cmdb_class_info: spec('class_info', 'class,principal_class,managed_by_group,managed_by_group.name'),
  cmdb_recommended_fields: spec('recommended_fields', 'table,recommended,active'),
  cmdb_data_management_policy: spec('data_manager_policies', 'name,table,policy_execution_job,cmdb_policy_type,encoded_query,archive_for_days,needs_review,assignee,assignee.active,task_assignment_type,task_management_user,task_management_user.active,task_management_group,user,user_group,sys_created_on'),

  /* Group 9 (Data Manager and attestation). WHAT THIS INSTANCE ACTUALLY RUNS:
     the modern Data Manager tables are `cmdb_data_management_*` (NOT
     `cmdb_data_manager_*`, which does not exist), and dev424910 holds 3 policies
     with ZERO executions. Attestation here is the LEGACY Certification module —
     `dcf_*` is not installed, but cert_audit (10 definitions), cert_audit_result
     (613 results: 561 Failed, 52 Certified) and cert_follow_on_task (544 open,
     97 past 60 days) are live. Both mechanisms are read, because an estate may
     run either, both or neither, and "not configured" and "not installed" are
     different findings. */
  /* Group 14 (CMDB-138): the tasks a Data Manager attestation cycle raises. Empty
     on dev424910 — the policies there have never run (CMDB-092). */
  cmdb_data_management_task: spec('data_manager_tasks', 'number,state,active,opened_at,due_date,closed_at,policy_id,assigned_to,sys_created_on'),
  cert_audit: spec('attestation_configs', 'name,active,audit_type,table,filter,template,assign_to,assign_to.active,assign_to.name,assign_to_group,assign_to_group.name,assignment_type,create_tasks,last_run_date,next_scheduled_run,run_type,run_period,short_description,sys_created_on'),
  cert_audit_result: spec('attestation_results', 'audit,state,configuration_item,column_name,desired_value,discrepancy_value,failed_condition,follow_on_task,certification_template,table,sys_created_on'),
  cert_filter: spec('attestation_filters', 'name,table,filter_condition,active,short_description'),
  cert_follow_on_task: spec('attestation_tasks', 'number,active,state,cmdb_ci,assigned_to,assigned_to.active,assignment_group,due_date,opened_at,short_description,sys_created_on'),
  /* Platform archival. There is no `cmdb_archive_rule` on this version: archive
     and destroy rules live on sys_archive / sys_archive_destroy and name their
     table, so a retention policy for a CMDB class is found by its `table`. */
  sys_archive: spec('archive_rules', 'name,table,active,condition,last_run_date,next_run_date,record_estimate,total'),
  sys_archive_destroy: spec('destroy_rules', 'name,table,active,archive_duration,condition'),
  /* Group membership, for resolving an attester to somebody who can answer. */
  sys_user_grmember: spec('group_members', 'group,user,user.active'),
  cmdb_policy_scheduled_job: spec('data_manager_jobs', 'name,active,run_type,run_period'),
  /* Group 2 (Completeness) and CMDB-140 (identity attributes). */
  cmn_location: spec('locations', 'name,parent'),
  core_company: spec('companies', 'name,parent'),
  cmdb_identifier: spec('identification_rules', 'name,applies_to,active,independent'),
  cmdb_identifier_entry: spec('identification_entries', 'identifier,table,attributes,order,allow_null_attribute,active'),
  life_cycle_stage_status: spec('lifecycle_statuses', 'name,life_cycle_stage'),
  /* Group 3 (Correctness). life_cycle_mapping is the instance's own mapping of
     install_status / operational_status onto lifecycle stages — the "permitted
     set" CMDB-023 reads instead of hardcoding one. */
  life_cycle_mapping: spec('lifecycle_mappings', 'table,legacy_field_name,legacy_field_value,legacy_subfield_name,legacy_subfield_value,life_cycle_control,active,priority'),
  life_cycle_control: spec('lifecycle_controls', 'table,life_cycle_stage,life_cycle_stage_status,display_name,active'),
  cmdb_reconciliation_definition: spec('reconciliation_rules', 'name,applies_to,discovery_source,attributes,priority,active'),
  cmdb_datasource_attribute_value: spec('source_attribute_values', 'ci,class,attribute,value,discovery_source,updated_on'),
  /* Group 6 (Relationships). cmdb_rel_type carries descriptors only on this
     version — no permitted class scope — which is why CMDB-064 takes its scope
     from the hosting metadata and reports the rest as unscoped. */
  cmdb_rel_type: spec('relationship_types', 'name,parent_descriptor,child_descriptor'),

  /* Group 5 (Identification and reconciliation). Verified present on dev424910,
     16 Sep 2026: this version keeps NO `cmdb_ire_error` table — per-run counters
     live in cmdb_ire_output_aggregate_stats, and per-CI source attribution (the
     only trace of IRE having run) in sys_object_source. */
  sys_object_source: spec('ci_source_attribution', 'name,source_feed,target_table,target_sys_id,last_scan,id,sys_created_on'),
  cmdb_datasource_precedence: spec('source_precedence', 'name,applies_to,discovery_source,order,fall_back,active'),
  cmdb_datasource_last_update: spec('source_last_write', 'discovery_source,class,attribute,record,updated_on'),
  cmdb_datasource_staleness: spec('source_staleness', 'name,applies_to,discovery_source,duration,active'),
  cmdb_ire_output_aggregate_stats: spec('ire_run_stats', 'run_id,run_table,errors,warnings,inserted,updated,unchanged,partial,incomplete,distinct_error_codes,distinct_warning_codes,expected_target_table,sys_created_on'),
  cmdb_metadata_hosting: spec('hosting_metadata', 'parent_type,child_type,rel_type,is_reverse'),

  /* Group 7 (Freshness and source coverage). `discovery_schedule` DOES NOT EXIST
     on dev424910 — a PDI without the Discovery product answers `400 Invalid
     table`, which `classifyFailure` reports as `unavailable` rather than as a
     failed read, so asking for it costs nothing and the answer is the finding:
     CMDB-070 reports "no discovery capability" as posture instead of gating the
     composite on a product the estate has not bought. */
  discovery_schedule: spec('discovery_schedules', 'name,active,discover,run_type,run_period,run_time,run_dayofweek,run_start,max_run_time,location,mid_server'),
  discovery_device_history: spec('discovery_runs', 'cmdb_ci,source,issue,state,status,started,completed,last_updated,sys_created_on'),
  discovery_range_item: spec('discovery_ranges', 'name,type,network_ip,netmask,start_ip_address,end_ip_address,summary,active,parent'),
  /* Group 13 (Scale and platform impact). `sys_table_rotation` is 40 rows and is
     read normally; `syslog_transaction` is 292,530 rows on dev424910 and is
     OPT-IN, because a rule about scale must not itself become the scale problem. */
  sys_table_rotation: spec('rotation_rules', 'name,table_name,duration,rotations'),
  syslog_transaction: spec('transactions', 'url,table,response_time,sql_time,sql_count,sys_created_on,sys_created_by', false, {
    filter: () => 'tableSTARTSWITHcmdb',
    filterLabel: 'transactions against CMDB tables',
    optIn: true,
  }),

  /* OPT-IN ONLY — see `optIn` on `spec`. CMDB-077 wants it; scan reuse pays for it. */
  sys_audit: spec('ci_audit', 'tablename,documentkey,fieldname,oldvalue,newvalue,user,sys_created_on', false, {
    filter: () => 'tablenameSTARTSWITHcmdb_ci',
    filterLabel: 'audit entries on CMDB tables',
    optIn: true,
  }),

  /* Group 8 (Lifecycle and retirement). The asset register is the OTHER opinion
     about the same physical thing, and D8 exists to find where the two disagree.
     Verified on dev424910: the link is `alm_asset.ci` (941 rows set) with
     `cmdb_ci.asset` pointing back (951), and the two install_status choice lists
     do NOT share values — 7 is Retired on both, but 10 is Consumed on the asset
     and Absent is 100 on the CI, which is why the mapping is read from
     sys_choice LABELS and never from the numbers. */
  alm_asset: spec('assets', 'display_name,ci,install_status,substatus,retired,retirement_date,life_cycle_stage,life_cycle_stage_status,model_category,serial_number,sys_created_on'),
  cmdb_metadata_containment: spec('containment_metadata', 'ci_type,parent_id,rel_type,always_include,is_reverse'),

  /* Group 4 (Uniqueness). The CMDB de-duplication tasks, and the CIs each one
     covers (duplicate_audit_result.follow_on_task → the task). */
  reconcile_duplicate_task: spec('dedup_tasks', 'number,active,state,opened_at,sys_created_on,assignment_group,duplicate_count'),
  duplicate_audit_result: spec('dedup_task_cis', 'follow_on_task,duplicate_ci,table'),
  sysauto_script: spec('health_jobs', 'name,active,run_type,run_period,run_time,run_dayofweek,run_dayofmonth', false, {
    filter: () => 'nameLIKECMDB Health',
    filterLabel: "scheduled scripts named like 'CMDB Health'",
  }),
});

/** The tables a run reads unless the caller narrows it. Opt-in tables are not among them. */
export const DEFAULT_TABLES = Object.freeze(Object.entries(TABLES).filter(([, s]) => !s.optIn).map(([name]) => name));

/** Tables that exist in the allow-list but are only read when asked for by name. */
export const OPT_IN_TABLES = Object.freeze(Object.entries(TABLES).filter(([, s]) => s.optIn).map(([name]) => name));

export const REQUIRED_TABLES = Object.freeze(
  Object.entries(TABLES).filter(([, s]) => s.required).map(([name]) => name),
);

/**
 * Resolve a requested table set against the allow-list.
 *
 * An unknown name is REFUSED rather than skipped: a caller who asked for
 * `cmdb_ci_serverz` and silently got a run without it would read the clean
 * result as "no server problems".
 */
export function resolveTables(requested) {
  if (!requested || !requested.length) return [...DEFAULT_TABLES];
  const unknown = requested.filter((t) => !TABLES[t]);
  if (unknown.length) {
    throw Object.assign(
      new Error(`Not in the Health Assist extraction allow-list: ${unknown.join(', ')}. `
        + `Allowed: ${Object.keys(TABLES).join(', ')}.`),
      { status: 422 },
    );
  }
  return [...new Set([...REQUIRED_TABLES, ...requested])];
}

/**
 * The encoded-query slice a table is read with, at a cutoff.
 *
 * ONE definition, used by the read and by the change check. If the two built
 * their slice separately, a table would be compared against a different set of
 * rows than it was read with, and would look changed on every run — or worse,
 * unchanged when it was not.
 */
export function sliceOf(tableName, cutoff) {
  const spec = TABLES[tableName];
  if (!spec) return '';
  return typeof spec.filter === 'function' ? spec.filter(cutoff) : (spec.filter || '');
}

/**
 * The whole encoded query a table is read with at a cutoff — the slice AND the
 * cutoff bound.
 *
 * The bound is part of the slice, not an implementation detail of the read.
 * Measured on dev424910: one change request carries `sys_updated_on` of
 * 2035-08-22. The read never saw it (it reads up to the run's cutoff) while a
 * change check without the bound counted it, so `change_request` looked changed
 * on every run for ever — and CMDB and ITSM could never be kept. Both sides now
 * ask the same question, each at its own moment.
 */
export function sliceWhere(tableName, cutoff) {
  const narrowing = sliceOf(tableName, cutoff);
  return `sys_updated_on<=${cutoff}${narrowing ? `^${narrowing}` : ''}`;
}

/**
 * What a table's read ASKS FOR — its fields and its slice definition.
 *
 * Stored beside the last successful read. A group that adds a field to a spec
 * changes this, and the table is read in full again: rows saved before the
 * field existed cannot answer a rule that needs it.
 */
export function specHash(tableName) {
  const spec = TABLES[tableName];
  if (!spec) return null;
  const filter = typeof spec.filter === 'function' ? `fn:${spec.filter.toString()}` : (spec.filter || '');
  return crypto.createHash('sha256')
    .update(JSON.stringify({ fields: spec.fields, filter, label: spec.filterLabel || null }))
    .digest('hex').slice(0, 16);
}
