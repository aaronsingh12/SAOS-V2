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
function spec(key, fields, required = false) {
  return Object.freeze({
    key,
    fields: Object.freeze([...new Set(['sys_id', 'sys_updated_on', ...fields.split(',')])]),
    required,
  });
}

export const TABLES = Object.freeze({
  cmdb_ci: spec('cis', 'name,sys_class_name,serial_number,fqdn,ip_address,owned_by,managed_by,support_group,operational_status,install_status,discovery_source,last_discovered,business_criticality', true),
  cmdb_rel_ci: spec('relationships', 'parent,child,type,type.name', true),
  cmdb_ci_service: spec('services', 'name,sys_class_name,owned_by,operational_status,life_cycle_stage,life_cycle_stage_status'),
  service_offering: spec('offerings', 'name,parent,owned_by'),
  ecc_agent: spec('mid_servers', 'name,status,validated,last_refreshed'),
  ecc_queue: spec('ecc_queue', 'name,state,queue,agent,sys_created_on'),
  em_alert: spec('alerts', 'number,cmdb_ci,state,severity,source'),
  incident: spec('incidents', 'number,cmdb_ci,priority,state,active,sys_created_on,resolved_at,reopen_count'),
  change_request: spec('changes', 'number,cmdb_ci,priority,state,active,type,close_code'),
  problem: spec('problems', 'number,cmdb_ci,priority,state,active'),
  sys_script: spec('business_rules', 'name,collection,active,when,condition,filter_condition,script,sys_scope'),
  sys_rest_message: spec('integrations', 'name,rest_endpoint,sys_scope'),
  sys_trigger: spec('jobs', 'name,state,next_action,sys_created_on'),
  sys_upgrade_history_log: spec('upgrade_logs', 'name,disposition,resolution_status,upgrade_history'),
  sys_user_has_role: spec('user_roles', 'user,user.active,role,role.name,inherited'),
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
