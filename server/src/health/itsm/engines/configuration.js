import { declareRequirement } from '../data-access.js';
import { configurationFinding } from '../findings.js';
import { CAPABILITY } from '../capability.js';
import { result, preflight, STATUS, notePopulation } from './result.js';

/**
 * ENGINE 5 — Configuration Inspection.
 *
 * Reads platform CONFIGURATION — choice lists, dictionary, SLA definitions,
 * schedules, properties — through named readers, so a rule says
 * `reader: 'sys_choice', args: { table: 'incident', element: 'category' }`
 * and never carries a ServiceNow query of its own.
 *
 * TWO CLASSES OF READER, deliberately kept apart:
 *
 *   established   the object's table and fields are known from the existing
 *                 codebase or the platform's own data model (sys_choice,
 *                 sys_dictionary, contract_sla — the field list mirrors
 *                 sla.js DEF_FIELDS — cmn_schedule, sys_properties). These read.
 *
 *   placeholder   the workbook names a CONCEPT (assignment rules, notification
 *                 recipients, UI/data policies, change models, standard-change
 *                 templates, CAB, conflict detection, major-incident
 *                 configuration, knowledge suggestion, the priority matrix,
 *                 approval routing, the change calendar) whose platform object
 *                 is a candidate at best. These answer `unsupported` with the
 *                 candidate table named and, where one is named, whether it
 *                 exists on this instance — and they invent no schema. Making
 *                 one established is a Phase 4 decision per object, taken
 *                 against a real instance.
 *
 * Every read returns `{ status: ok | unavailable | unsupported | error, rows,
 * coverage, reason }`; an engine result built on `unavailable` is a skip,
 * never an "absent" finding.
 */

export const ENGINE_KEY = 'configuration';
export const ENGINE_VERSION = '1.2.0';

export class ConfigurationError extends Error {
  constructor(message) { super(message); this.name = 'ConfigurationError'; }
}

const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);

async function read(ctx, req) {
  const r = await ctx.reads.read(req);
  if (!usable(r.coverage)) {
    return { status: r.coverage.status === 'unavailable' ? 'unavailable' : 'error', rows: [], coverage: r.coverage, reason: r.coverage.error };
  }
  return { status: 'ok', rows: r.rows, coverage: r.coverage, reason: null };
}

/* ── established readers ─────────────────────────────────────────────────── */

const ESTABLISHED = Object.freeze({
  /** Choice list for one field, including dependent choices (subcategory ← category). */
  sys_choice: {
    table: 'sys_choice',
    async read(ctx, { table, element, includeInactive = false, language = 'en' } = {}) {
      if (!table || !element) throw new ConfigurationError('sys_choice needs table and element');
      const q = `name=${table}^element=${element}${includeInactive ? '' : '^inactive=false'}${language ? `^language=${language}` : ''}`;
      return read(ctx, declareRequirement({ table: 'sys_choice', fields: ['name', 'element', 'label', 'value', 'sequence', 'dependent_value', 'inactive'], query: q, strategy: 'rows' }));
    },
  },
  /** Dictionary entries for a table (its own, not inherited): custom-field and mandatory questions. */
  sys_dictionary: {
    table: 'sys_dictionary',
    async read(ctx, { table, elements = null } = {}) {
      if (!table) throw new ConfigurationError('sys_dictionary needs a table');
      const q = `name=${table}^elementISNOTEMPTY${elements?.length ? `^elementIN${elements.join(',')}` : ''}`;
      return read(ctx, declareRequirement({ table: 'sys_dictionary', fields: ['name', 'element', 'column_label', 'internal_type', 'mandatory', 'reference', 'sys_created_on', 'sys_created_by', 'sys_updated_on'], query: q, strategy: 'rows' }));
    },
  },
  /** SLA definitions — the same fields servicenow/sla.js reads. */
  sla_definition: {
    table: 'contract_sla',
    async read(ctx, { collection = null, activeOnly = false } = {}) {
      const clauses = [];
      if (collection) clauses.push(`collection=${collection}`);
      if (activeOnly) clauses.push('active=true');
      return read(ctx, declareRequirement({
        table: 'contract_sla',
        fields: ['name', 'collection', 'type', 'target', 'active', 'duration', 'duration_type', 'schedule', 'schedule_source', 'timezone', 'timezone_source',
          'retroactive', 'start_condition', 'stop_condition', 'pause_condition', 'reset_condition', 'cancel_condition', 'sys_updated_on'],
        query: clauses.join('^'), strategy: 'rows',
      }));
    },
  },
  /**
   * Schedules, optionally by type (blackout / maintenance), with their spans.
   * Spans are returned RAW: a repeating span is a rule, not an interval, and
   * expanding it into concrete dates is a calendar computation this phase
   * does not do — `expanded: false` says so on each repeating span.
   */
  schedule: {
    table: 'cmn_schedule',
    /**
     * `table` selects the platform's own subclass — cmn_schedule_blackout /
     * cmn_schedule_maintenance (the tables the Blackout Schedules and
     * Maintenance Schedules modules list; both extend cmn_schedule_condition
     * → cmn_schedule, verified on dev442675) — so "blackout" is a class, not
     * a type value anyone assumed. The caller has already run the DECISION 5
     * pipeline on that table (requires_tables).
     */
    async read(ctx, { table = 'cmn_schedule', type = null, withSpans = true } = {}) {
      const sched = await read(ctx, declareRequirement({ table, fields: ['name', 'type', 'time_zone', 'parent'], query: type ? `type=${type}` : '', strategy: 'rows' }));
      if (sched.status !== 'ok' || !withSpans || !sched.rows.length) return sched;
      const ids = sched.rows.map((s) => s.sys_id);
      const spans = await read(ctx, declareRequirement({ table: 'cmn_schedule_span', fields: ['schedule', 'name', 'type', 'start_date_time', 'end_date_time', 'all_day', 'repeat_type', 'repeat_count', 'repeat_until', 'days_of_week', 'show_as'], query: `scheduleIN${ids.join(',')}`, strategy: 'rows' }));
      const bySchedule = new Map();
      for (const sp of spans.rows) {
        if (!bySchedule.has(sp.schedule)) bySchedule.set(sp.schedule, []);
        bySchedule.get(sp.schedule).push({ ...sp, expanded: !sp.repeat_type || sp.repeat_type === '' || sp.repeat_type === 'none' });
      }
      return { ...sched, rows: sched.rows.map((s) => ({ ...s, spans: bySchedule.get(s.sys_id) || [] })), coverage: sched.coverage, spans_coverage: spans.coverage, spans_status: spans.status };
    },
  },
  /** System properties by exact name. */
  sys_properties: {
    table: 'sys_properties',
    async read(ctx, { names = [] } = {}) {
      if (!names.length) throw new ConfigurationError('sys_properties needs names');
      return read(ctx, declareRequirement({ table: 'sys_properties', fields: ['name', 'value', 'type', 'sys_updated_on'], query: `nameIN${names.join(',')}`, strategy: 'rows' }));
    },
  },
});

/* ── verified readers: concept → candidate table + the schema it must carry ── */

/**
 * A VERIFIED reader names the platform table that IS the concept and the
 * fields the concept needs. Every read first runs the DECISION 5 pipeline
 * (`probes.configurationObject`: candidate → discovery → schema → capability)
 * and reads only when the object is usable on THIS instance; otherwise it
 * answers `unavailable` with the step reached. The candidates were confirmed
 * on dev442675 on 2026-09-17 (schema and readability); an instance without
 * them makes the rules UNAVAILABLE, never PASS.
 */
const VERIFIED = Object.freeze({
  /** The priority data lookup: impact × urgency → priority. */
  priority_matrix: {
    table: 'dl_u_priority', fields: ['impact', 'urgency', 'priority'], rules: ['ITSM-005', 'ITSM-001'],
    async read(ctx) { return read(ctx, declareRequirement({ table: 'dl_u_priority', fields: ['impact', 'urgency', 'priority'], query: '', strategy: 'rows' })); },
  },
  /** Assignment rules, by the table they route. */
  assignment_rule: {
    table: 'sysrule_assignment', fields: ['name', 'table', 'condition', 'group', 'user', 'active'], rules: ['ITSM-004', 'ITSM-029'],
    async read(ctx, { table = null, activeOnly = true } = {}) {
      const clauses = []; if (table) clauses.push(`table=${table}`); if (activeOnly) clauses.push('active=true');
      return read(ctx, declareRequirement({ table: 'sysrule_assignment', fields: ['name', 'table', 'condition', 'group', 'user', 'active'], query: clauses.join('^'), strategy: 'rows' }));
    },
  },
  /** Notification definitions with their recipient lists (glide_list of sys_ids). */
  notification: {
    table: 'sysevent_email_action', fields: ['name', 'collection', 'active', 'recipient_users', 'recipient_groups'], rules: ['ITSM-011'],
    async read(ctx, { activeOnly = true, collections = null } = {}) {
      const clauses = []; if (activeOnly) clauses.push('active=true'); if (collections?.length) clauses.push(`collectionIN${collections.join(',')}`);
      return read(ctx, declareRequirement({ table: 'sysevent_email_action', fields: ['name', 'collection', 'active', 'recipient_users', 'recipient_groups'], query: clauses.join('^'), strategy: 'rows' }));
    },
  },
  /** CAB meetings (CAB workbench). */
  cab: {
    table: 'cab_meeting', fields: ['start', 'end', 'state'], rules: ['ITSM-082'],
    async read(ctx, { query = '' } = {}) { return read(ctx, declareRequirement({ table: 'cab_meeting', fields: ['start', 'end', 'state'], query, strategy: 'rows' })); },
  },
});

export const isVerified = (name) => name in VERIFIED;
export const VERIFIED_OBJECTS = Object.freeze(Object.fromEntries(Object.entries(VERIFIED).map(([k, v]) => [k, { table: v.table, fields: v.fields, rules: v.rules }])));

/* ── placeholders: concept → candidate table, no schema ───────────────────── */

export const PLACEHOLDERS = Object.freeze({
  ui_policy: { candidate: 'sys_ui_policy', rules: ['ITSM-010', 'ITSM-087', 'ITSM-090'] },
  data_policy: { candidate: 'sys_data_policy2', rules: ['ITSM-010', 'ITSM-087', 'ITSM-090'] },
  change_model: { candidate: 'chg_model', rules: ['ITSM-087', 'ITSM-092', 'ITSM-122'] },
  standard_change_template: { candidate: 'std_change_producer_version', rules: ['ITSM-080', 'ITSM-089', 'ITSM-117'] },
  conflict_detection: { candidate: 'conflict', rules: ['ITSM-084', 'ITSM-118', 'ITSM-138'] },
  major_incident: { candidate: null, rules: ['ITSM-045', 'ITSM-046', 'ITSM-047', 'ITSM-051', 'ITSM-052'] },
  knowledge_suggestion: { candidate: 'cxs_table_config', rules: ['ITSM-015'] },
  approval_routing: { candidate: null, rules: ['ITSM-081', 'ITSM-086', 'ITSM-091'] },
  change_calendar: { candidate: null, rules: ['ITSM-093'] },
  approval_delegation: { candidate: 'sys_user_delegate', rules: ['ITSM-088'] },
  /* Phase 4 additions — concepts the rule configs name and the instance must confirm. */
  post_incident_review: { candidate: null, rules: ['ITSM-047', 'ITSM-052', 'ITSM-078', 'ITSM-092', 'ITSM-122'] },
  knowledge_link: { candidate: 'm2m_kb_task', rules: ['ITSM-066', 'ITSM-076', 'ITSM-139'] },
  autoclose_configuration: { candidate: 'sys_properties', rules: ['ITSM-007', 'ITSM-031'] },
  communication_plan: { candidate: null, rules: ['ITSM-046'] },
  risk_assessment: { candidate: null, rules: ['ITSM-083', 'ITSM-131'] },
});

export const READERS = Object.freeze([...Object.keys(ESTABLISHED), ...Object.keys(VERIFIED), ...Object.keys(PLACEHOLDERS)]);
export const isEstablished = (name) => name in ESTABLISHED;

/**
 * Read a configuration object by reader name. Placeholders probe their
 * candidate table (when one is named) so the answer says whether the object
 * COULD be read on this instance — and still read nothing from it.
 */
export async function readConfiguration(ctx, name, args = {}) {
  if (ESTABLISHED[name]) return { reader: name, ...(await ESTABLISHED[name].read(ctx, args)) };
  if (VERIFIED[name]) {
    const v = VERIFIED[name];
    const probe = await ctx.probes.configurationObject(name, { table: v.table, fields: v.fields });
    if (probe.state !== CAPABILITY.AVAILABLE) {
      return { reader: name, status: probe.state === CAPABILITY.UNKNOWN ? 'unknown' : 'unavailable', rows: [], coverage: null, reason: `"${name}": ${probe.reason}`, candidate_table: v.table, candidate_state: probe.state, resolution_step: probe.step ?? null, rules: v.rules };
    }
    return { reader: name, ...(await v.read(ctx, args)), candidate_table: v.table, candidate_state: probe.state, resolution_step: 'usable' };
  }
  const ph = PLACEHOLDERS[name];
  if (!ph) throw new ConfigurationError(`"${name}" is not a configuration reader (${READERS.join(', ')})`);
  /* DECISION 5: the full resolution pipeline, not a bare existence check. */
  const probe = await ctx.probes.configurationObject(name, { table: ph.candidate, fields: args.expected_fields ?? ph.expected_fields });
  return {
    reader: name,
    status: probe.state === CAPABILITY.AVAILABLE ? 'unsupported' : probe.state === CAPABILITY.UNKNOWN ? 'unknown' : 'unavailable',
    rows: [], coverage: null,
    reason: probe.state === CAPABILITY.AVAILABLE
      ? `candidate ${ph.candidate} verified as usable, but no established reader exists for "${name}" yet — a reader must be written against the verified schema`
      : `"${name}": ${probe.reason}`,
    candidate_table: ph.candidate, candidate_state: probe.state, resolution_step: probe.step ?? null, rules: ph.rules,
  };
}

/**
 * Engine contract. `rule.config`:
 *   { reader, args, compare: (rows, ctx) => { offenders: [{sys_id, field, value}], observed, expected, absent, unavailable?, coverage? }, severity, title, description }
 *
 * The comparison ("configured but unused", "absent where volume exists") is
 * rule-specific and often needs an aggregate from the usage side; it is a
 * function on the configuration so the engine stays generic.
 */
export const engine = Object.freeze({
  key: ENGINE_KEY,
  name: 'Configuration Inspection Engine',
  version: ENGINE_VERSION,
  canEvaluate: (rule) => rule?.architecture?.engine === ENGINE_KEY || rule?.architecture?.also_requires?.includes(ENGINE_KEY),
  prepare: async () => undefined,
  async evaluate(rule, ctx) {
    const c = rule.config;
    const gate = await preflight(rule, ENGINE_KEY, ctx, { requiredParameters: c?.required_parameters || [] });
    if (gate) return gate;
    const cfg = await readConfiguration(ctx, c.reader, c.args || {});
    const out = result(rule, ENGINE_KEY, { coverage: cfg.coverage ? [cfg.coverage] : [], parameters: ctx.parametersFor(rule.id) });
    if (cfg.status !== 'ok') {
      out.status = STATUS.UNAVAILABLE;
      out.skipped.push({ rule: rule.id, table: cfg.candidate_table ?? ESTABLISHED[c.reader]?.table ?? null, reason: `configuration reader "${c.reader}": ${cfg.status} — ${cfg.reason}`, capability: cfg.candidate_state ?? null });
      if (cfg.candidate_state) out.blocker = { kind: 'undefined_object', object: c.reader, candidate_table: cfg.candidate_table ?? null, step: cfg.resolution_step ?? null, state: cfg.candidate_state, reason: cfg.reason };
      return out;
    }
    const cmp = await c.compare(cfg.rows, ctx);
    if (cmp?.coverage) out.coverage.push(cmp.coverage);
    if (cmp?.unavailable) {
      /* The usage side could not be read — no claim about the configuration is made. */
      out.status = STATUS.UNAVAILABLE;
      out.skipped.push({ rule: rule.id, table: ESTABLISHED[c.reader]?.table ?? null, reason: cmp.unavailable });
      return out;
    }
    out.observed = cmp?.observed ?? null;
    /*
     * EMPTY POPULATION (Phase 5 closure): the comparator knows what it judged — the
     * usage records, the fields, the notifications — and says so. One that does
     * not declares nothing, and its "no finding" is not read as a pass.
     */
    if (cmp?.population) notePopulation(out, cmp.population);
    if (cmp?.offenders?.length || cmp?.absent) {
      out.findings.push(configurationFinding({
        rule, object: c.reader, table: ESTABLISHED[c.reader]?.table ?? null, records: cmp.offenders || [], observed: cmp.observed, expected: cmp.expected,
        title: c.title || rule.title, description: c.description || rule.whatItMeans, severity: c.severity || rule.base, confidence: c.confidence ?? 1.0,
        recommendation: c.recommendation ?? null, collected_at: ctx.run.run_started_at,
      }));
    }
    return out;
  },
});
