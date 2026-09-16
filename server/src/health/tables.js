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
function spec(key, fields, required = false, { filter = null, filterLabel = null } = {}) {
  return Object.freeze({
    key,
    fields: Object.freeze([...new Set(['sys_id', 'sys_updated_on', ...fields.split(',')])]),
    required,
    filter,
    filterLabel,
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
  cmdb_ci: spec('cis', 'name,sys_class_name,serial_number,fqdn,ip_address,mac_address,owned_by,managed_by,support_group,operational_status,install_status,discovery_source,last_discovered,business_criticality,company,location,cost_center,correlation_id,life_cycle_stage_status,sys_created_on,sys_created_by', true),
  cmdb_rel_ci: spec('relationships', 'parent,child,type,type.name', true),
  cmdb_ci_service: spec('services', 'name,sys_class_name,owned_by,operational_status,life_cycle_stage,life_cycle_stage_status,busines_criticality,used_for'),
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
  cmdb_class_info: spec('class_info', 'class,principal_class'),
  cmdb_recommended_fields: spec('recommended_fields', 'table,recommended,active'),
  cmdb_data_management_policy: spec('data_manager_policies', 'name,table,policy_execution_job,cmdb_policy_type,sys_created_on'),
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
  /* Group 5 (Identification and reconciliation). Verified present on dev424910,
     19 Sep 2026: this version keeps NO `cmdb_ire_error` table — per-run counters
     live in cmdb_ire_output_aggregate_stats, and per-CI source attribution (the
     only trace of IRE having run) in sys_object_source. */
  sys_object_source: spec('ci_source_attribution', 'name,source_feed,target_table,target_sys_id,last_scan,id,sys_created_on'),
  cmdb_datasource_precedence: spec('source_precedence', 'name,applies_to,discovery_source,order,fall_back,active'),
  cmdb_datasource_last_update: spec('source_last_write', 'discovery_source,class,attribute,record,updated_on'),
  cmdb_datasource_staleness: spec('source_staleness', 'name,applies_to,discovery_source,duration,active'),
  cmdb_ire_output_aggregate_stats: spec('ire_run_stats', 'run_id,run_table,errors,warnings,inserted,updated,unchanged,partial,incomplete,distinct_error_codes,distinct_warning_codes,expected_target_table,sys_created_on'),
  cmdb_metadata_hosting: spec('hosting_metadata', 'parent_type,child_type,rel_type,is_reverse'),
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

/** The tables a run reads unless the caller narrows it. Required ones are never droppable. */
export const DEFAULT_TABLES = Object.freeze(Object.keys(TABLES));

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
