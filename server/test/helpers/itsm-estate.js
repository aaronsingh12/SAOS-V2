import { fakeInstance, platformMeta } from './itsm-fake-instance.js';
import { createEvaluationContext } from '../../src/health/itsm/context.js';

/**
 * A small but complete ITSM estate for the Phase 4 rule tests: the platform
 * metadata every configured rule probes (tables, fields, audit flags), the
 * choice lists the rules resolve values from, and a handful of records per
 * process with one deliberate offender per rule where one is expressible.
 *
 * Everything is a plain object so a test can spread and override it.
 */

export const NOW = new Date('2026-09-16T12:00:00Z');

export const ESTATE_META = platformMeta({
  tables: {
    incident: { fields: ['number', 'priority', 'impact', 'urgency', 'state', 'active', 'category', 'subcategory', 'close_code', 'close_notes', 'short_description', 'description', 'resolved_at', 'closed_at', 'closed_by', 'sys_created_on', 'sys_updated_on', 'assignment_group', 'assigned_to', 'caller_id', 'resolved_by', 'cmdb_ci', 'business_service', 'reopen_count', 'reassignment_count', 'hold_reason', 'problem_id', 'rfc', 'contact_type', 'location', 'department', 'work_notes', 'u_custom'], superClass: 'task' },
    problem: { fields: ['number', 'state', 'active', 'cause_notes', 'description', 'short_description', 'assignment_group', 'assigned_to', 'cmdb_ci', 'business_service', 'closed_at', 'sys_created_on', 'known_error', 'rfc', 'workaround', 'fix_notes', 'close_code', 'priority'] },
    change_request: { fields: ['number', 'type', 'risk', 'impact', 'state', 'active', 'approval', 'close_code', 'close_notes', 'implementation_plan', 'backout_plan', 'test_plan', 'justification', 'reason', 'parent', 'start_date', 'end_date', 'work_start', 'work_end', 'cmdb_ci', 'business_service', 'assignment_group', 'sys_created_on', 'requested_by'], superClass: 'task' },
    task: { fields: ['approval', 'state', 'active'] },
    /* the objects the DECISION 5 pipeline verifies (present on dev442675) */
    dl_u_priority: { fields: ['impact', 'urgency', 'priority'] },
    sysrule_assignment: { fields: ['name', 'table', 'condition', 'group', 'user', 'active'] },
    sysevent_email_action: { fields: ['name', 'collection', 'active', 'recipient_users', 'recipient_groups'] },
    cab_meeting: { fields: ['start', 'end', 'state'] },
    sys_user_delegate: { fields: ['user', 'delegate', 'starts', 'ends'] },
    sysapproval_approver: { fields: ['approver', 'state', 'sysapproval', 'sys_created_on', 'sys_updated_on'] },
    m2m_kb_task: { fields: ['kb_knowledge', 'task'] },
    kb_knowledge: { fields: ['workflow_state', 'number'] },
    cmn_schedule_blackout: { fields: ['name', 'type', 'time_zone'], superClass: 'cmn_schedule' },
    cmn_schedule_maintenance: { fields: ['name', 'type', 'time_zone'], superClass: 'cmn_schedule' },
    task_sla: { fields: ['has_breached', 'sla', 'task'] },
    cmdb_ci: { fields: ['install_status', 'name', 'sys_class_name'] },
    cmdb_ci_service: { fields: ['name', 'busines_criticality'] },
    cmdb_rel_ci: { fields: ['parent', 'child', 'type'] },
    sys_user: { fields: ['active', 'user_name', 'name'] },
    sys_user_group: { fields: ['name'] },
    sys_user_grmember: { fields: ['group', 'user'] },
    sys_choice: { fields: ['name', 'element', 'label', 'value', 'sequence', 'dependent_value', 'inactive', 'language'] },
    sys_dictionary: { fields: ['name', 'element', 'mandatory'] },
    sys_audit: { fields: ['tablename', 'documentkey', 'fieldname', 'oldvalue', 'newvalue', 'sys_created_on'] },
    sys_journal_field: { fields: ['name', 'element', 'element_id', 'sys_created_on'] },
    contract_sla: { fields: ['name', 'collection', 'start_condition', 'schedule', 'active'] },
    cmn_schedule: { fields: ['name', 'type', 'time_zone'] },
    cmn_schedule_span: { fields: ['schedule', 'start_date_time', 'end_date_time', 'repeat_type', 'all_day', 'repeat_count', 'repeat_until', 'days_of_week'] },
    sys_db_object: {}, sys_properties: {},
  },
  audited: ['problem', 'change_request', 'incident'],
});

const choice = (sys_id, name, element, label, value, sequence, extra = {}) => ({ sys_id, name, element, label, value, sequence: String(sequence), inactive: 'false', language: 'en', ...extra });

export const CHOICES = [
  choice('ch-inc-state-1', 'incident', 'state', 'New', '1', 1),
  choice('ch-inc-state-3', 'incident', 'state', 'On Hold', '3', 3),
  choice('ch-inc-state-6', 'incident', 'state', 'Resolved', '6', 6),
  choice('ch-inc-state-9', 'incident', 'state', 'Custom Parked', '9', 9),
  choice('ch-cat-sw', 'incident', 'category', 'Software', 'software', 1),
  choice('ch-cat-net', 'incident', 'category', 'Network', 'network', 2),
  choice('ch-cat-unused', 'incident', 'category', 'Facilities', 'facilities', 3),
  choice('ch-sub-email', 'incident', 'subcategory', 'Email', 'email', 1, { dependent_value: 'software' }),
  choice('ch-ci-retired', 'cmdb_ci', 'install_status', 'Retired', '7', 7),
  choice('ch-ci-installed', 'cmdb_ci', 'install_status', 'Installed', '1', 1),
  choice('ch-prb-101', 'problem', 'state', 'New', '101', 1),
  choice('ch-prb-102', 'problem', 'state', 'Assess', '102', 2),
  choice('ch-prb-103', 'problem', 'state', 'Root Cause Analysis', '103', 3),
  choice('ch-prb-107', 'problem', 'state', 'Closed', '107', 7),
  choice('ch-prb-cnr', 'problem', 'close_code', 'Cannot Reproduce', 'cannot_reproduce', 1),
  choice('ch-prb-fix', 'problem', 'close_code', 'Fix Applied', 'fix_applied', 2),
  /* inherited fields keep their choice lists under the defining table (task), as on the platform */
  choice('ch-task-appr-a', 'task', 'approval', 'Approved', 'approved', 2),
  choice('ch-task-appr-r', 'task', 'approval', 'Requested', 'requested', 1),
  choice('ch-chg-type-s', 'change_request', 'type', 'Standard', 'standard', 1),
  choice('ch-chg-type-n', 'change_request', 'type', 'Normal', 'normal', 2),
  choice('ch-chg-type-e', 'change_request', 'type', 'Emergency', 'emergency', 3),
  choice('ch-chg-close-s', 'change_request', 'close_code', 'Successful', 'successful', 0),
  choice('ch-chg-close-u', 'change_request', 'close_code', 'Unsuccessful', 'unsuccessful', 2),
  choice('ch-appr-state', 'sysapproval_approver', 'state', 'Approved', 'approved', 4),
  choice('ch-kb-pub', 'kb_knowledge', 'workflow_state', 'Published', 'published', 5),
  choice('ch-kb-ret', 'kb_knowledge', 'workflow_state', 'Retired', 'retired', 6),
];

const inc = (o) => ({ number: o.sys_id.toUpperCase(), priority: '3', impact: '2', urgency: '2', location: 'loc-1', department: 'dept-1', state: '6', active: 'false', category: 'software', subcategory: 'email', close_code: 'Solved', close_notes: 'Restarted the service after confirming the root cause with the user', short_description: 'Something broke', description: 'plain text', resolved_at: '2026-09-01 10:00:00', closed_at: '2026-09-02 10:00:00', closed_by: 'u1', sys_created_on: '2026-08-30 09:00:00', sys_updated_on: '2026-09-02 10:00:00', assignment_group: 'g-live', assigned_to: 'u1', caller_id: 'u2', resolved_by: 'u1', cmdb_ci: 'ci-app', business_service: 'svc-email', reopen_count: '0', reassignment_count: '1', hold_reason: '', problem_id: '', rfc: '', contact_type: 'phone', ...o });
const prb = (o) => ({ number: o.sys_id.toUpperCase(), state: '107', active: 'false', cause_notes: 'The connection pool leaked handles under sustained load, exhausting sockets', description: 'Email intermittently unavailable', short_description: 'Email unavailable', assignment_group: 'g-live', assigned_to: 'u1', cmdb_ci: 'ci-app', business_service: 'svc-email', closed_at: '2026-06-01 00:00:00', sys_created_on: '2026-01-01 00:00:00', known_error: 'false', rfc: 'chg-ok', workaround: 'restart', fix_notes: '', close_code: 'fix_applied', priority: '3', ...o });
const chg = (o) => ({ number: o.sys_id.toUpperCase(), requested_by: 'u1', type: 'normal', risk: 'moderate', impact: '3', state: '3', active: 'false', approval: 'approved', close_code: 'successful', close_notes: 'done', implementation_plan: 'plan', backout_plan: 'rollback', test_plan: 'tested', justification: 'because', reason: 'reason', parent: '', start_date: '2026-08-01 10:00:00', end_date: '2026-08-01 12:00:00', work_start: '2026-08-01 10:05:00', work_end: '2026-08-01 11:55:00', cmdb_ci: 'ci-app', business_service: 'svc-email', assignment_group: 'g-live', sys_created_on: '2026-07-20 09:00:00', ...o });

export const ESTATE = {
  ...ESTATE_META,
  sys_choice: CHOICES,
  incident: [
    inc({ sys_id: 'inc-ok' }),
    /* the offender for most incident rules */
    inc({ sys_id: 'inc-bad', priority: '1', impact: '1', urgency: '1', category: 'software', subcategory: 'bogus', close_code: 'Other', close_notes: 'short', short_description: 'Email down', description: 'PAN ABCDE1234F on file', closed_at: '2026-08-30 09:00:20', resolved_at: '2026-08-30 09:00:10', sys_created_on: '2026-08-30 09:00:00', assignment_group: 'g-empty', caller_id: 'u1', resolved_by: 'u1', cmdb_ci: 'ci-retired', business_service: '', reopen_count: '2', reassignment_count: '6', problem_id: '' }),
    inc({ sys_id: 'inc-open', state: '3', active: 'true', priority: '1', impact: '3', urgency: '3', location: '', hold_reason: '', close_code: '', close_notes: '', resolved_at: '', closed_at: '', closed_by: '', sys_created_on: '2026-09-10 09:00:00', assignment_group: '', assigned_to: 'u1', cmdb_ci: '', business_service: '', problem_id: 'prb-open' }),
    inc({ sys_id: 'inc-copy', short_description: 'Email down', close_notes: 'Email down', category: 'network', subcategory: '', cmdb_ci: 'ci-lonely', business_service: '', problem_id: 'prb-closed' }),
  ],
  problem: [
    prb({ sys_id: 'prb-ok' }),
    prb({ sys_id: 'prb-closed', cause_notes: '', rfc: '', workaround: '', close_code: 'cannot_reproduce', cmdb_ci: '', business_service: '' }),
    prb({ sys_id: 'prb-open', state: '101', active: 'true', closed_at: '', assigned_to: 'u-gone', assignment_group: 'g-empty', workaround: '', cause_notes: 'The connection pool leaked handles under sustained load, exhausting sockets', sys_created_on: '2026-01-01 00:00:00', close_code: '' }),
  ],
  change_request: [
    chg({ sys_id: 'chg-ok' }),
    chg({ sys_id: 'chg-bad', requested_by: 'u2', type: 'emergency', risk: 'high', impact: '', close_code: 'unsuccessful', close_notes: '', implementation_plan: '', backout_plan: '', test_plan: '', justification: '', reason: '', start_date: '', end_date: '2026-08-01 12:00:00', work_start: '2026-08-01 08:00:00', work_end: '2026-08-01 14:00:00', cmdb_ci: 'ci-retired', business_service: '', assignment_group: 'g-empty', sys_created_on: '2026-08-01 09:00:00' }),
    chg({ sys_id: 'chg-p1', work_end: '2026-08-29 12:00:00', cmdb_ci: 'ci-db', close_code: 'successful' }),
  ],
  task_sla: [{ sys_id: 'sla-a', has_breached: 'true', sla: 'sla-p1', task: 'inc-bad' }, { sys_id: 'sla-b', has_breached: 'false', sla: 'sla-p1', task: 'inc-ok' }],
  cmdb_ci: [
    { sys_id: 'ci-app', install_status: '1', name: 'app01', sys_class_name: 'cmdb_ci_appl' },
    { sys_id: 'ci-db', install_status: '1', name: 'db01', sys_class_name: 'cmdb_ci_database' },
    { sys_id: 'ci-retired', install_status: '7', name: 'old01', sys_class_name: 'cmdb_ci_server' },
    { sys_id: 'ci-lonely', install_status: '1', name: 'lonely01', sys_class_name: 'cmdb_ci_server' },
  ],
  cmdb_ci_service: [{ sys_id: 'svc-email', name: 'Email', busines_criticality: '1 - most critical' }],
  cmdb_rel_ci: [
    { sys_id: 'rel-1', parent: 'svc-email', child: 'ci-app', type: 'Depends on::Used by' },
    { sys_id: 'rel-2', parent: 'ci-app', child: 'ci-db', type: 'Depends on::Used by' },
  ],
  sys_user: [{ sys_id: 'u1', active: 'true', user_name: 'alice', name: 'Alice' }, { sys_id: 'u2', active: 'true', user_name: 'bob', name: 'Bob' }, { sys_id: 'u-gone', active: 'false', user_name: 'gone', name: 'Gone' }],
  sys_user_group: [{ sys_id: 'g-live', name: 'Live' }, { sys_id: 'g-empty', name: 'Empty' }],
  sys_user_grmember: [{ sys_id: 'm1', group: 'g-live', user: 'u1' }, { sys_id: 'm2', group: 'g-empty', user: 'u-gone' }],
  sys_audit: [
    { sys_id: 'au1', tablename: 'problem', documentkey: 'prb-ok', fieldname: 'state', oldvalue: '101', newvalue: '102', sys_created_on: '2026-02-01 00:00:00' },
    { sys_id: 'au2', tablename: 'problem', documentkey: 'prb-ok', fieldname: 'state', oldvalue: '102', newvalue: '103', sys_created_on: '2026-03-01 00:00:00' },
    { sys_id: 'au3', tablename: 'problem', documentkey: 'prb-ok', fieldname: 'state', oldvalue: '103', newvalue: '102', sys_created_on: '2026-03-10 00:00:00' },
    { sys_id: 'au4', tablename: 'problem', documentkey: 'prb-ok', fieldname: 'state', oldvalue: '102', newvalue: '101', sys_created_on: '2026-03-20 00:00:00' },
    { sys_id: 'au5', tablename: 'problem', documentkey: 'prb-ok', fieldname: 'state', oldvalue: '101', newvalue: '107', sys_created_on: '2026-06-01 00:00:00' },
    { sys_id: 'au6', tablename: 'change_request', documentkey: 'chg-bad', fieldname: 'start_date', oldvalue: 'a', newvalue: 'b', sys_created_on: '2026-07-21 00:00:00' },
    { sys_id: 'au7', tablename: 'change_request', documentkey: 'chg-bad', fieldname: 'start_date', oldvalue: 'b', newvalue: 'c', sys_created_on: '2026-07-22 00:00:00' },
    { sys_id: 'au8', tablename: 'change_request', documentkey: 'chg-bad', fieldname: 'start_date', oldvalue: 'c', newvalue: 'd', sys_created_on: '2026-07-23 00:00:00' },
  ],
  sys_journal_field: [{ sys_id: 'j1', name: 'incident', element: 'work_notes', element_id: 'inc-ok', sys_created_on: '2026-08-31 00:00:00' }],
  sys_dictionary: [...ESTATE_META.sys_dictionary, { sys_id: 'dict-chg-risk-m', name: 'change_request', element: 'risk', mandatory: 'false' }],
  contract_sla: [{ sys_id: 'sla-p1', name: 'P1 resolution', collection: 'incident', start_condition: 'priority=1', schedule: '', active: 'true' }],
  cmn_schedule: [], cmn_schedule_span: [], cmn_schedule_blackout: [], cmn_schedule_maintenance: [], sys_properties: [],
  /* verified objects */
  dl_u_priority: [
    { sys_id: 'dl-11', impact: '1', urgency: '1', priority: '1' }, { sys_id: 'dl-12', impact: '1', urgency: '2', priority: '2' }, { sys_id: 'dl-21', impact: '2', urgency: '1', priority: '2' },
    { sys_id: 'dl-22', impact: '2', urgency: '2', priority: '3' }, { sys_id: 'dl-33', impact: '3', urgency: '3', priority: '5' },
  ],
  sysrule_assignment: [{ sys_id: 'ar-1', name: 'Route network by location', table: 'incident', condition: 'category=network^locationISNOTEMPTY', group: 'g-live', user: '', active: 'true' }],
  sysevent_email_action: [
    { sys_id: 'nt-bad', name: 'Incident assigned (stale recipients)', collection: 'incident', active: 'true', recipient_users: 'u1,u-gone', recipient_groups: 'g-empty' },
    { sys_id: 'nt-ok', name: 'Change approved', collection: 'change_request', active: 'true', recipient_users: 'u1', recipient_groups: 'g-live' },
  ],
  cab_meeting: [],
  sys_user_delegate: [
    { sys_id: 'dg-open', user: 'u1', delegate: 'u-gone', starts: '2026-01-01 00:00:00', ends: '' },
    { sys_id: 'dg-ok', user: 'u1', delegate: 'u2', starts: '2026-01-01 00:00:00', ends: '2026-12-31 00:00:00' },
    { sys_id: 'dg-expired', user: 'u2', delegate: 'u-gone', starts: '2026-01-01 00:00:00', ends: '2026-02-01 00:00:00' },
  ],
  sysapproval_approver: [
    { sys_id: 'ap-self', approver: 'u2', state: 'approved', sysapproval: 'chg-bad', 'sysapproval.sys_class_name': 'change_request', sys_created_on: '2026-07-21 09:00:00', sys_updated_on: '2026-07-21 09:01:00' },
    { sys_id: 'ap-ok', approver: 'u2', state: 'approved', sysapproval: 'chg-ok', 'sysapproval.sys_class_name': 'change_request', sys_created_on: '2026-07-21 09:00:00', sys_updated_on: '2026-07-21 12:00:00' },
    { sys_id: 'ap-p1', approver: 'u-gone', state: 'approved', sysapproval: 'chg-p1', 'sysapproval.sys_class_name': 'change_request', sys_created_on: '2026-07-21 09:00:00', sys_updated_on: '2026-07-22 09:00:00' },
  ],
  m2m_kb_task: [
    { sys_id: 'kt-retired', task: 'inc-bad', 'task.sys_class_name': 'incident', kb_knowledge: 'kb-retired' },
    { sys_id: 'kt-ok', task: 'inc-ok', 'task.sys_class_name': 'incident', kb_knowledge: 'kb-pub' },
  ],
  kb_knowledge: [{ sys_id: 'kb-pub', number: 'KB0001', workflow_state: 'published' }, { sys_id: 'kb-retired', number: 'KB0002', workflow_state: 'retired' }],
};

/* Tables the estate does NOT have — the candidate objects the placeholders probe. */
export const ABSENT = ['problem_task', 'change_task', 'em_alert', 'sys_attachment', 'sys_ui_policy', 'sys_data_policy2', 'chg_model', 'std_change_producer_version', 'conflict', 'cxs_table_config'];

export function estateContext(overrides = {}, { instance = {}, ...ctxOpts } = {}) {
  const tables = { ...ESTATE, ...overrides };
  const client = fakeInstance(tables, { absent: ABSENT, ...instance });
  return createEvaluationContext({ client, now: NOW, ...ctxOpts });
}
