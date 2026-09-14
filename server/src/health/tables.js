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
  cmdb_ci: spec('cis', 'name,sys_class_name,serial_number,fqdn,ip_address,owned_by,managed_by,support_group,operational_status,install_status,discovery_source,last_discovered,business_criticality', true),
  cmdb_rel_ci: spec('relationships', 'parent,child,type,type.name', true),
  cmdb_ci_service: spec('services', 'name,sys_class_name,owned_by,operational_status,life_cycle_stage,life_cycle_stage_status'),
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
