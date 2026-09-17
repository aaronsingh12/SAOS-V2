#!/usr/bin/env node
/**
 * ITSM Phase 4 closure — READ-ONLY validation against the configured ServiceNow
 * instance (Dashboard → Connection). Writes nothing to the instance.
 *
 *   node scripts/itsm-instance-validation.mjs            → rules/itsm/instance-validation.json
 *
 * What it records (metadata and counts only — never record contents):
 *   1. object existence for every candidate / workbook-named table
 *   2. field existence for every field the rule configurations read
 *   3. choice lists the rules resolve by label (and the state-order sequences)
 *   4. audit flags on the task tables and cmdb_ci
 *   5. schedule metadata (types, span repeat types, the days_of_week convention where an OOB span shows it)
 *   6. custom-field convention on incident
 *   7. table sizes for the performance section
 *   8. one full run of every configured rule through the runner, with per-rule / per-engine timing and per-table request counts
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'src/health/rules/itsm/instance-validation.json');

const { table: client } = await import('../src/servicenow/client.js');
const { getSettings } = await import('../src/config/store.js');
const { createEvaluationContext } = await import('../src/health/itsm/context.js');
const { createProbes } = await import('../src/health/itsm/capability.js');
const { runITSMRules } = await import('../src/health/itsm/runner.js');
const { ITSM_RULE_CONFIGS } = await import('../src/health/itsm/rules/index.js');
const { PLACEHOLDERS } = await import('../src/health/itsm/engines/configuration.js');
const { getITSMRule } = await import('../src/health/itsm/catalogue.js');

const instance = new URL(getSettings().connection.instanceUrl).host;
const started = Date.now();
const out = { instance, generated: new Date().toISOString(), read_only: true };

/* ── a counting wrapper so the run can be measured ── */
const calls = { query: 0, count: 0, aggregate: 0, byTable: {} };
const counting = {
  async query(t, o) { calls.query += 1; calls.byTable[t] = (calls.byTable[t] || 0) + 1; return client.query(t, o); },
  async count(t, q) { calls.count += 1; calls.byTable[t] = (calls.byTable[t] || 0) + 1; return client.count(t, q); },
  async aggregate(t, o) { calls.aggregate += 1; calls.byTable[t] = (calls.byTable[t] || 0) + 1; return client.aggregate(t, o); },
  async countBy(t, q, g) { calls.aggregate += 1; calls.byTable[t] = (calls.byTable[t] || 0) + 1; return client.countBy(t, q, g); },
};
const probes = createProbes({ client: counting });

/* 1. objects */
const candidateTables = [...new Set([
  ...Object.values(PLACEHOLDERS).map((p) => p.candidate).filter(Boolean),
  'problem_task', 'change_task', 'em_alert', 'sys_attachment', 'service_offering', 'task_ci', 'm2m_kb_task', 'sysapproval_approver', 'std_change_proposal',
  'incident', 'problem', 'change_request', 'task_sla', 'contract_sla', 'cmn_schedule', 'cmn_schedule_span', 'sys_audit', 'sys_journal_field', 'cmdb_ci', 'cmdb_rel_ci', 'cmdb_ci_service', 'sys_user', 'sys_user_group', 'sys_user_grmember', 'sys_choice', 'sys_dictionary', 'sys_properties', 'kb_knowledge',
])].sort();
out.objects = {};
for (const t of candidateTables) {
  const exists = await probes.tableExists(t);
  const readable = exists.state === 'AVAILABLE' ? await probes.readable(t) : null;
  out.objects[t] = { exists: exists.state, readable: readable?.state ?? null, reason: exists.state === 'AVAILABLE' ? readable?.reason ?? null : exists.reason };
}
out.placeholders = Object.fromEntries(Object.entries(PLACEHOLDERS).map(([name, p]) => [name, { candidate: p.candidate, exists: p.candidate ? out.objects[p.candidate]?.exists : 'NO_CANDIDATE', rules: p.rules }]));

/* 2. fields the configurations read */
const fieldsByTable = {};
const collect = (node, table) => {
  if (Array.isArray(node)) { for (const x of node) collect(x, table); return; }
  if (!node || typeof node !== 'object') return;
  const t = node.table ?? table;
  for (const k of ['fields', 'evidence_fields']) for (const f of node[k] || []) if (t && typeof f === 'string') (fieldsByTable[t] ||= new Set()).add(f);
  for (const k of ['field', 'field2', 'ci_field', 'key_field', 'time_field', 'start_field', 'end_field', 'text_field', 'block_field', 'require_no_link', 'length_field', 'state_field']) if (t && typeof node[k] === 'string' && !node[k].includes('.')) (fieldsByTable[t] ||= new Set()).add(node[k]);
  for (const p of node.predicates || []) { for (const k of ['field', 'field2']) if (t && p[k]) (fieldsByTable[t] ||= new Set()).add(p[k]); }
  for (const [k, v] of Object.entries(node)) if (typeof v === 'object') collect(v, ['left', 'right', 'from', 'to'].includes(k) ? v?.table ?? t : t);
};
for (const e of ITSM_RULE_CONFIGS.values()) if (!e.config.requires_objects?.length && !e.config.undefined_dependencies?.length) collect(e.config, null);
out.fields = {};
for (const [t, fs_] of Object.entries(fieldsByTable)) {
  if (out.objects[t]?.exists !== 'AVAILABLE') { out.fields[t] = { state: 'TABLE_' + (out.objects[t]?.exists ?? 'UNPROBED') }; continue; }
  const v = await probes.fieldsExist(t, [...fs_].sort());
  out.fields[t] = { state: v.state, checked: [...fs_].sort(), missing: v.missing ?? [], reason: v.state === 'AVAILABLE' ? null : v.reason };
}

/* 3. choice lists (label → value), with sequences for the state orders */
const choiceLists = [['incident', 'state'], ['task', 'state'], ['cmdb_ci', 'install_status'], ['problem', 'state'], ['problem', 'close_code'], ['problem', 'resolution_code'], ['task', 'approval'], ['change_request', 'approval'], ['change_request', 'type'], ['change_request', 'close_code'], ['change_request', 'state'], ['cmn_schedule', 'type'], ['cmn_schedule_span', 'repeat_type'], ['incident', 'contact_type'], ['incident', 'close_code'], ['task_sla', 'stage']];
out.choices = {};
for (const [name, element] of choiceLists) {
  const rows = await counting.query('sys_choice', { query: `name=${name}^element=${element}^inactive=false^language=en^ORDERBYsequence`, fields: 'label,value,sequence', limit: 200, display: 'false' });
  out.choices[`${name}.${element}`] = rows.map((r) => ({ label: r.label, value: r.value, sequence: r.sequence }));
}
const labelsNeeded = { 'incident.state': ['On Hold'], 'cmdb_ci.install_status': ['Retired'], 'problem.close_code': ['Cannot Reproduce'], 'task.approval': ['Approved'], 'change_request.approval': ['Approved'], 'change_request.type': ['Emergency'], 'change_request.close_code': ['Successful', 'Unsuccessful'], 'cmn_schedule.type': ['Blackout', 'Maintenance'] };
out.labels = Object.fromEntries(Object.entries(labelsNeeded).map(([k, labels]) => [k, Object.fromEntries(labels.map((l) => [l, (out.choices[k] || []).filter((c) => String(c.label).toLowerCase() === l.toLowerCase()).map((c) => c.value)]))]));

/* 4. audit flags */
out.audit = {};
for (const t of ['incident', 'problem', 'change_request', 'cmdb_ci', 'task']) out.audit[t] = (await probes.auditEnabled(t)).state;

/* 5. schedules */
const schedules = await counting.query('cmn_schedule', { query: 'ORDERBYname', fields: 'name,type,time_zone', limit: 200, display: 'false' });
out.schedules = { count: schedules.length, types: [...new Set(schedules.map((s) => s.type))].sort(), with_time_zone: schedules.filter((s) => s.time_zone).length, without_time_zone: schedules.filter((s) => !s.time_zone).length };
const spanDict = await counting.query('sys_dictionary', { query: 'name=cmn_schedule_span^elementISNOTEMPTY', fields: 'element,internal_type', limit: 200, display: 'false' });
out.schedule_span_fields = spanDict.map((d) => d.element).sort();
const spans = await counting.query('cmn_schedule_span', { query: 'repeat_type=weekly^ORrepeat_type=weekdays^ORDERBYsys_created_on', fields: 'name,repeat_type,days_of_week,schedule.name,start_date_time,end_date_time,all_day,repeat_count,repeat_until', limit: 40, display: 'false' });
out.weekly_spans_sample = spans.map((s) => ({ schedule: s['schedule.name'], name: s.name, repeat_type: s.repeat_type, days_of_week: s.days_of_week, all_day: s.all_day }));
const repeatTypes = await counting.countBy('cmn_schedule_span', '', 'repeat_type');
out.span_repeat_types = repeatTypes;
/* The convention test: an OOB span named for weekdays or a weekend tells which digits mean which day. */
const weekdayish = spans.filter((s) => /weekday|mon.*fri|8-5|9-5/i.test(`${s.name} ${s['schedule.name']}`));
const weekendish = spans.filter((s) => /weekend|sat|sun/i.test(`${s.name} ${s['schedule.name']}`));
out.days_of_week_evidence = { weekday_spans: weekdayish.map((s) => ({ name: s.name, schedule: s['schedule.name'], days_of_week: s.days_of_week })), weekend_spans: weekendish.map((s) => ({ name: s.name, schedule: s['schedule.name'], days_of_week: s.days_of_week })) };
const dowChoices = await counting.query('sys_choice', { query: 'name=cmn_schedule_span^element=days_of_week^ORDERBYsequence', fields: 'label,value,sequence,language', limit: 50, display: 'false' });
out.days_of_week_choices = dowChoices.map((c) => ({ label: c.label, value: c.value, sequence: c.sequence, language: c.language }));

/* 6. custom-field convention */
const incDict = await counting.query('sys_dictionary', { query: 'name=incident^elementISNOTEMPTY', fields: 'element,sys_created_by,sys_customer_update', limit: 500, display: 'false' });
out.custom_fields = { incident_own_columns: incDict.length, u_prefixed: incDict.filter((d) => d.element.startsWith('u_')).map((d) => d.element), non_u_customer_updated: incDict.filter((d) => !d.element.startsWith('u_') && String(d.sys_customer_update) === 'true').map((d) => d.element) };

/* 7. sizes */
out.sizes = {};
for (const t of ['incident', 'problem', 'change_request', 'task_sla', 'contract_sla', 'cmdb_ci', 'cmdb_rel_ci', 'cmdb_ci_service', 'sys_user', 'sys_user_group', 'sys_user_grmember', 'cmn_schedule', 'cmn_schedule_span', 'sys_journal_field', 'sys_audit']) {
  try { out.sizes[t] = await counting.count(t, ''); } catch (e) { out.sizes[t] = `error ${e.status ?? ''}`; }
}
out.metadata_requests = { ...calls, byTable: { ...calls.byTable } };

/* 8. the run */
for (const k of Object.keys(calls.byTable)) delete calls.byTable[k];
calls.query = 0; calls.count = 0; calls.aggregate = 0;
const ctx = createEvaluationContext({ client: counting, now: new Date() });
const t0 = Date.now();
const run = await runITSMRules(ctx);
const elapsed = Date.now() - t0;
const byEngine = {};
const rules = {};
for (const [id, r] of run.results) {
  const e = r.engine;
  byEngine[e] ||= { rules: 0, ms: 0, evaluated: 0, findings: 0 };
  byEngine[e].rules += 1; byEngine[e].ms += run.timing[id] ?? 0; if (r.status === 'evaluated') byEngine[e].evaluated += 1; byEngine[e].findings += r.findings.length;
  rules[id] = {
    slot: getITSMRule(id).slot, engine: e, status: r.status, verdict: r.verdict ?? null, findings: r.findings.length,
    kpis: r.kpis.map((k) => ({ numerator: k.numerator, denominator: k.denominator, pass_pct: k.pass_pct, complete: k.complete ?? null, variant: k.variant ?? null })),
    blocker: r.blocker ? { kind: r.blocker.kind, step: r.blocker.step ?? null, object: r.blocker.object ?? r.blocker.table ?? null, parameters: r.blocker.parameters ?? null } : null,
    reason: r.status === 'evaluated' ? null : (r.skipped[0]?.reason ?? null),
    coverage: r.coverage.map((c) => ({ table: c.table, status: c.status, rows: c.rowsFetched ?? null, complete: c.rowsComplete ?? null })).slice(0, 8),
    ms: run.timing[id] ?? null,
  };
}
out.run = { elapsed_ms: elapsed, summary: run.summary, verdicts: run.verdicts, requests: { ...calls, byTable: { ...calls.byTable } }, cached_reads: run.cached_reads, probe_cache: ctx.probes.cacheSize(), by_engine: byEngine, rules };
out.total_ms = Date.now() - started;
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ instance, objects: Object.fromEntries(Object.entries(out.objects).map(([k, v]) => [k, v.exists])), labels: out.labels, audit: out.audit, schedules: out.schedules, days_of_week: out.days_of_week_evidence, dow_choices: out.days_of_week_choices, sizes: out.sizes, run: { elapsed, summary: run.summary, verdicts: run.verdicts, requests: out.run.requests, by_engine: byEngine } }, null, 2));
