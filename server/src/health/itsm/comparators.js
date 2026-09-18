import { declareRequirement } from './data-access.js';
import { recordFinding, aggregateFinding } from './findings.js';
import { fromSnowTime } from './run-context.js';
import { readConfiguration } from './engines/configuration.js';
import { boundedGraph } from './engines/relationship-graph.js';
import { createResolver } from './engines/reference-integrity.js';
import { undeterminedOf } from './engines/result.js';

/**
 * ITSM PHASE 4 — the named callbacks a declarative rule config may reference.
 *
 * Three small libraries, each a map of `name → (args) → function`:
 *
 *   COMPARATORS   configuration engine `compare(rows, ctx)`: judge a
 *                 configuration object against usage, and answer
 *                 `{ offenders, observed, expected, absent }` — or
 *                 `{ unavailable: reason }` when the usage read failed, which
 *                 the engine turns into UNAVAILABLE, never "absent".
 *                 Every answer also carries `population` (engines/result.js):
 *                 what the comparison judged. Without one, "no offender" is not
 *                 read as a pass (Phase 5 closure).
 *   EXPANDERS     temporal engine `expand_keys`: `{ prepare(ctx, keys) }` that
 *                 builds a key → related keys function over the given keys only
 *                 (DECISION 11).
 *   COMBINATORS   composite engine `combine(inputs, ctx)`: derive one rule's
 *                 findings / kpis / measures from other rules' results.
 *
 * Nothing here is keyed on a rule id. A comparator that only one rule uses is
 * still written for its SHAPE ("choices against usage"), so the next rule of
 * that shape is a JSON entry.
 */

const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);
const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const round1 = (n) => Number(n.toFixed(1));

/** A grouped count over a table slice, through the run's read cache. */
async function countBy(ctx, { table, query = '', groupBy = [] }) {
  const r = await ctx.reads.read(declareRequirement({ table, query, strategy: 'aggregate', groupBy }));
  if (r.coverage.status !== 'complete') return { unavailable: `aggregate over ${table} failed (${r.coverage.status}): ${r.coverage.error ?? ''}`, coverage: r.coverage };
  return { groups: r.groups, coverage: r.coverage, total: r.groups.reduce((n, g) => n + g.count, 0) };
}

const windowClause = (ctx, window, field = 'sys_created_on') => (window ? `${field}>=${ctx.run.window(window).start_snow}` : '');
const and = (...clauses) => clauses.filter(Boolean).join('^');

/* ── COMPARATORS ────────────────────────────────────────────────────────── */

const COMPARATORS_MUTABLE = {
  /** The object is absent: no rows at all. */
  absent: () => async (rows) => ({ offenders: [], observed: rows.length, expected: '≥ 1', absent: rows.length === 0, population: { total: 1, judged: 1, unit: 'presence check', basis: 'whether the object has any row — its absence is the finding' } }),

  /** Rows matching a selector are the offenders (`selector` is a compiled or raw expression). */
  rows_where: ({ selector, field = 'configuration' }) => {
    const test = typeof selector === 'function' ? selector : compileLazy(selector);
    return async (rows) => {
      const offenders = rows.filter((r) => test(r)).map((r) => ({ sys_id: r.sys_id, field, value: r[field] ?? r.name ?? null }));
      return { offenders, observed: offenders.length, expected: 0, absent: false, population: { total: rows.length, judged: rows.length, unit: 'configuration rows', basis: `the ${field} rows the selector is tested on` } };
    };
  },

  /**
   * A choice list against its usage: choices with zero use in the window are
   * unused; a value above `dominance_share` of the total dominates.
   */
  choice_usage: ({ table, field, window = null, dominance_share = null, unused = true }) => async (rows, ctx) => {
    if (!rows.length) return { unavailable: `no choices are configured for ${table}.${field} on this instance (or the choice list could not be read) — usage cannot be judged against an empty list` };
    const agg = await countBy(ctx, { table, query: windowClause(ctx, window), groupBy: [field] });
    if (agg.unavailable) return agg;
    const used = new Map(agg.groups.map((g) => [String(g.group[field] ?? ''), g.count]));
    const offenders = [];
    /*
     * EMPTY POPULATION (Phase 5 closure): with no record in the window every choice
     * reads as "unused" — a FAIL built on nothing. Usage is judged only when there
     * is usage to judge; otherwise the population is empty and the rule says so.
     */
    if (unused && agg.total > 0) for (const ch of rows) if (!used.get(String(ch.value))) offenders.push({ sys_id: ch.sys_id, field: 'unused_choice', value: ch.value });
    const distribution = [...used.entries()].map(([value, count]) => ({ value, count, share: agg.total ? round1(100 * count / agg.total) : null })).sort((a, b) => b.count - a.count);
    if (dominance_share != null) for (const d of distribution) if (d.share != null && d.share > dominance_share) offenders.push({ sys_id: rows.find((ch) => String(ch.value) === d.value)?.sys_id ?? null, field: 'dominant_choice', value: `${d.value} (${d.share}%)` });
    return { offenders, observed: { choices: rows.length, used: used.size, total: agg.total, distribution }, expected: { unused: 0, dominance_share }, absent: false, population: { total: agg.total, judged: agg.total, unit: `${table} records`, basis: `${table} usage of ${field}${window ? ' in the window' : ''} against ${rows.length} configured choice(s)` } };
  },

  /**
   * Dependent choice pairs: `rows` are the CHILD choices (with
   * `dependent_value` naming the parent value). Usage pairs with volume
   * whose child is not a configured dependent of the parent are offenders.
   */
  dependent_choice_pairs: ({ table, parent_field, child_field, scope = '' }) => async (rows, ctx) => {
    if (!rows.length) return { unavailable: `no dependent choices are configured for ${table}.${child_field} on this instance — pairs cannot be judged against an empty list` };
    const valid = new Set(rows.map((ch) => `${ch.dependent_value ?? ''}|${ch.value}`));
    const agg = await countBy(ctx, { table, query: and(scope, `${child_field}ISNOTEMPTY`), groupBy: [parent_field, child_field] });
    if (agg.unavailable) return agg;
    const offenders = agg.groups
      .filter((g) => !isEmpty(g.group[child_field]) && !valid.has(`${g.group[parent_field] ?? ''}|${g.group[child_field]}`))
      .map((g) => ({ sys_id: null, field: `${parent_field}/${child_field}`, value: `${g.group[parent_field]} / ${g.group[child_field]} (${g.count})` }));
    return { offenders, observed: { pairs_in_use: agg.groups.length, invalid: offenders.length }, expected: 'every pair in use configured as a dependent choice', absent: false, population: { total: agg.total, judged: agg.total, unit: `${table} records`, basis: `${table} with ${child_field} set${scope ? ` where ${scope}` : ''}` } };
  },

  /**
   * SLA per band: `rows` are SLA definitions; every value of `field` with
   * volume needs a definition whose `start_condition` names it.
   */
  sla_per_band: ({ table, field, scope = '' }) => async (rows, ctx) => {
    const agg = await countBy(ctx, { table, query: and(scope, `${field}ISNOTEMPTY`), groupBy: [field] });
    if (agg.unavailable) return agg;
    const conditions = rows.map((d) => String(d.start_condition ?? ''));
    const offenders = agg.groups
      .filter((g) => g.count > 0 && !conditions.some((cnd) => cnd.includes(`${field}=${g.group[field]}`) || cnd.includes(`${field}IN`) && cnd.split('^').some((cl) => cl.startsWith(`${field}IN`) && cl.slice(field.length + 2).split(',').includes(String(g.group[field])))))
      .map((g) => ({ sys_id: null, field, value: `${g.group[field]} (${g.count} records, no SLA start condition)` }));
    return { offenders, observed: { bands: agg.groups.map((g) => ({ [field]: g.group[field], count: g.count })), definitions: rows.length }, expected: 'a start condition per band with volume', absent: rows.length === 0, population: { total: agg.total, judged: agg.total, unit: `${table} records`, basis: `${table} with ${field} set — the bands with volume` } };
  },

  /**
   * Custom fields (dictionary rows whose element starts with `prefix`, the
   * platform's convention) with a population rate below `population_rate`.
   * One count per field, server-side.
   */
  custom_field_population: ({ table, prefix = 'u_', population_rate, scope = '', require_not_mandatory = false }) => async (rows, ctx) => {
    const candidates = rows.filter((d) => String(d.element ?? '').startsWith(prefix));
    const custom = candidates.filter((d) => !require_not_mandatory || !['true', '1', 'yes'].includes(String(d.mandatory ?? '').toLowerCase()));
    const totalReq = await ctx.reads.read(declareRequirement({ table, query: scope, strategy: 'exists' }));
    if (totalReq.count == null) return { unavailable: `count over ${table} failed (${totalReq.coverage.status})`, coverage: totalReq.coverage };
    const total = totalReq.count;
    const offenders = []; const observed = [];
    for (const d of custom) {
      const r = await ctx.reads.read(declareRequirement({ table, query: and(scope, `${d.element}ISNOTEMPTY`), strategy: 'exists' }));
      if (r.count == null) return { unavailable: `count of ${table}.${d.element} failed (${r.coverage.status})`, coverage: r.coverage };
      const rate = total ? round1(100 * r.count / total) : null;
      observed.push({ element: d.element, populated: r.count, rate });
      if (rate != null && rate < population_rate) offenders.push({ sys_id: d.sys_id, field: d.element, value: `${rate}% populated` });
    }
    /*
     * EMPTY POPULATION (Phase 5 closure): the population is the candidate fields. A
     * field enforced as mandatory is judged by that (where the rule requires it not
     * to be); every other field is judged only by a rate, and a rate needs records.
     */
    const judged = (candidates.length - custom.length) + observed.filter((o) => o.rate != null).length;
    return { offenders, observed: { custom_fields: custom.length, total, fields: observed }, expected: `≥ ${population_rate}% populated`, absent: false, population: { total: candidates.length, judged, unit: 'fields', basis: `${table} fields${prefix ? ` prefixed ${prefix}` : ''}${require_not_mandatory ? ' (mandatory ones judged as enforced)' : ''}, rates over ${total} record(s)` } };
  },

  /**
   * Custom states (the instance's own list — the workbook does not say which
   * values are custom) with volume and no mention in any SLA pause/stop
   * condition. `rows` are the state choices.
   */
  states_absent_from_sla_conditions: ({ table, field = 'state', custom_values, collection }) => async (rows, ctx) => {
    if (!rows.length) return { unavailable: `no state choices are configured for ${table}.${field} on this instance — nothing to judge` };
    const sla = await readConfiguration(ctx, 'sla_definition', { collection });
    if (sla.status !== 'ok') return { unavailable: `SLA definitions could not be read: ${sla.reason}`, coverage: sla.coverage };
    const agg = await countBy(ctx, { table, groupBy: [field] });
    if (agg.unavailable) return agg;
    const volume = new Map(agg.groups.map((g) => [String(g.group[field] ?? ''), g.count]));
    const text = sla.rows.map((d) => `${d.pause_condition ?? ''}^${d.stop_condition ?? ''}`).join('^');
    const offenders = rows
      .filter((ch) => custom_values.map(String).includes(String(ch.value)) && (volume.get(String(ch.value)) || 0) > 0 && !text.includes(`${field}=${ch.value}`) && !text.split('^').some((cl) => cl.startsWith(`${field}IN`) && cl.slice(field.length + 2).split(',').includes(String(ch.value))))
      .map((ch) => ({ sys_id: ch.sys_id, field, value: `${ch.label ?? ch.value} (${volume.get(String(ch.value))} records)` }));
    return { offenders, observed: { custom_states: custom_values.length, definitions: sla.rows.length }, expected: 'each custom state in a pause or stop condition', absent: false, population: { total: agg.total, judged: agg.total, unit: `${table} records`, basis: `${table} volume per ${field} — a custom state is judged by its volume` } };
  },
};

/* ── comparators over VERIFIED objects (their table was confirmed by the DECISION 5 pipeline before the read) ── */

/** Field names an encoded condition reads — the same reading the runner's field gate uses. */
const conditionFields = (condition) => {
  const out = new Set();
  for (const clause of String(condition || '').split('^')) {
    const m = /^(?:OR|NQ)?([a-z0-9_]+)/.exec(clause);
    if (m && !clause.startsWith('ORDERBY') && !clause.startsWith('EQ')) out.add(m[1]);
  }
  return out;
};

Object.assign(COMPARATORS_MUTABLE, {
  /**
   * A data lookup (rows: { ...inputs, output }) against the records: groups of
   * records whose `output` differs from the lookup row for their inputs.
   * Records whose input pair has no lookup row are unverifiable, not offenders.
   */
  lookup_mismatch: ({ table, inputs, output, scope = '' }) => async (rows, ctx) => {
    if (!rows.length) return { unavailable: `the lookup table carries no rows on this instance — nothing to judge against` };
    const key = (o) => inputs.map((f) => String(o[f] ?? '')).join('|');
    const expected = new Map(rows.map((r) => [key(r), String(r[output] ?? '')]));
    const agg = await countBy(ctx, { table, query: and(scope, ...inputs.map((f) => `${f}ISNOTEMPTY`)), groupBy: [...inputs, output] });
    if (agg.unavailable) return agg;
    const offenders = []; let mismatched = 0; let unverifiable = 0;
    for (const g of agg.groups) {
      const exp = expected.get(key(g.group));
      if (exp === undefined) { unverifiable += g.count; continue; }
      if (exp !== String(g.group[output] ?? '')) { mismatched += g.count; offenders.push({ sys_id: null, field: [...inputs, output].join('/'), value: `${inputs.map((f) => `${f}=${g.group[f]}`).join(', ')} → ${output}=${g.group[output]} (lookup says ${exp}) × ${g.count}` }); }
    }
    const judged = agg.total - unverifiable;
    return { offenders, observed: { lookup_rows: rows.length, records: agg.total, mismatched, unverifiable, ratio: judged ? round1(100 * mismatched / judged) : null }, expected: 'every record\'s output equals the lookup row for its inputs', absent: false, population: { total: agg.total, judged, unit: `${table} records`, basis: `${table} with ${inputs.join(' and ')} set; records whose inputs have no lookup row are not judged` } };
  },

  /**
   * Assignment rules (rows) that reference `fields` in their condition, and
   * the records of `table` that leave those fields empty. Fires only where a
   * rule references the field — no rule, nothing to report.
   */
  rules_referencing_fields: ({ table, fields, scope = '' }) => async (rows, ctx) => {
    const offenders = []; const observed = {};
    let referenced = 0;
    for (const f of fields) {
      const referencing = rows.filter((r) => conditionFields(r.condition).has(f));
      observed[f] = { rules_referencing: referencing.length };
      if (!referencing.length) continue;
      referenced += 1;
      const r = await ctx.reads.read(declareRequirement({ table, query: and(scope, `${f}ISEMPTY`), strategy: 'exists' }));
      if (r.count == null) return { unavailable: `count of ${table} with empty ${f} failed (${r.coverage.status})`, coverage: r.coverage };
      observed[f].records_empty = r.count;
      if (r.count > 0) offenders.push({ sys_id: null, field: f, value: `${r.count} ${table} record(s) with empty ${f}; referenced by ${referencing.map((x) => x.name || x.sys_id).join(', ')}` });
    }
    /*
     * EMPTY POPULATION (Phase 5 closure). Two populations, in the workbook's order:
     *   no rule references any of the fields → the workbook's own gate ("fires only
     *     where routing rules reference the fields") answers: nothing is routed on
     *     them, which is determinate, not empty data;
     *   a rule references one → the records in scope are the population, and with
     *     none of them "no empty field" establishes nothing.
     */
    if (!referenced) return { offenders, observed, expected: 'no empty routing field where an assignment rule evaluates it', absent: false, population: { total: 0, judged: 0, unit: 'routing fields referenced by an active assignment rule', basis: `${fields.join(', ')} on ${table}`, determinate_when_empty: 'the workbook threshold: "Fires only where routing rules reference the fields" — no active assignment rule references them' } };
    let inScope = null;
    if (!offenders.length) {
      const pop = await ctx.reads.read(declareRequirement({ table, query: scope, strategy: 'exists' }));
      if (pop.count == null) return { unavailable: `count of ${table}${scope ? ` where ${scope}` : ''} failed (${pop.coverage.status})`, coverage: pop.coverage };
      inScope = pop.count;
    }
    return { offenders, observed, expected: 'no empty routing field where an assignment rule evaluates it', absent: false, population: { total: inScope, judged: inScope ?? null, unit: `${table} records`, basis: `${table}${scope ? ` where ${scope}` : ''}, routed on ${fields.filter((f) => observed[f].rules_referencing).join(', ')}` } };
  },

  /**
   * Notification recipients (glide_list fields of user / group sys_ids) that
   * resolve to inactive users or groups with no active member. Resolved in
   * batches through the run's reference resolver.
   */
  recipients_resolve: ({ user_field = 'recipient_users', group_field = 'recipient_groups' } = {}) => async (rows, ctx) => {
    const split = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const resolver = await ctx.shared.getOrBuild('reference_resolver', async () => createResolver(ctx));
    const users = [...new Set(rows.flatMap((r) => split(r[user_field])))];
    const groups = [...new Set(rows.flatMap((r) => split(r[group_field])))];
    const { rows: userRows, complete: usersComplete } = await resolver.resolve('sys_user', users, { fields: ['active', 'user_name'] });
    const { active, complete: groupsComplete } = await resolver.groupMembers(groups);
    if (!usersComplete || !groupsComplete) return { unavailable: 'recipient users / groups could not be resolved completely — no claim about inactive recipients is made', coverage: resolver.coverage().at(-1) };
    const offenders = [];
    for (const r of rows) {
      const inactive = split(r[user_field]).filter((u) => { const x = userRows.get(u); return x === null || (x && !['true', '1', 'yes'].includes(String(x.active).toLowerCase())); });
      const empty = split(r[group_field]).filter((g) => (active.get(g) || []).length === 0);
      if (inactive.length || empty.length) offenders.push({ sys_id: r.sys_id, field: 'recipients', value: `${r.name ?? r.sys_id}: ${inactive.length} inactive/missing user(s), ${empty.length} empty group(s)` });
    }
    return { offenders, observed: { notifications: rows.length, users_checked: users.length, groups_checked: groups.length }, expected: 'every recipient resolves to an active user or a group with active members', absent: false, population: { total: rows.length, judged: rows.length, unit: 'notifications', basis: 'notification rules and their recipients' } };
  },

  /** The object (rows) is absent while `volume_table` has records in the window — absence that matters. */
  absent_despite_volume: ({ volume_table, window = null, query = '' }) => async (rows, ctx) => {
    const r = await ctx.reads.read(declareRequirement({ table: volume_table, query: and(query, windowClause(ctx, window)), strategy: 'exists' }));
    if (r.count == null) return { unavailable: `count over ${volume_table} failed (${r.coverage.status})`, coverage: r.coverage };
    /* EMPTY POPULATION (Phase 5 closure): present is judged by presence; absent is judged only where there is volume. */
    const population = rows.length
      ? { total: 1, judged: 1, unit: 'presence check', basis: 'the object has rows' }
      : { total: r.count, judged: r.count, unit: `${volume_table} records${window ? ' in the window' : ''}`, basis: `absence matters only where ${volume_table} has volume` };
    return { offenders: [], observed: { rows: rows.length, [`${volume_table}_in_window`]: r.count }, expected: rows.length ? 'present' : `≥ 1 where ${volume_table} has volume`, absent: rows.length === 0 && r.count > 0, population };
  },
});

/* A selector given raw is compiled without importing rule-config (which imports this file). */
function compileLazy(expr) {
  const isEmptyV = isEmpty;
  const one = (e) => {
    if (Array.isArray(e.all)) { const fs = e.all.map(one); return (o) => fs.every((f) => f(o)); }
    if (Array.isArray(e.any)) { const fs = e.any.map(one); return (o) => fs.some((f) => f(o)); }
    if (e.not) { const f = one(e.not); return (o) => !f(o); }
    const v = (o) => o?.[e.field];
    switch (e.op) {
      case 'empty': return (o) => isEmptyV(v(o));
      case 'not_empty': return (o) => !isEmptyV(v(o));
      case 'equals': return (o) => String(v(o) ?? '') === String(e.value);
      case 'not_equals': return (o) => String(v(o) ?? '') !== String(e.value);
      case 'in': return (o) => e.value.map(String).includes(String(v(o) ?? ''));
      case 'not_in': return (o) => !e.value.map(String).includes(String(v(o) ?? ''));
      case 'truthy': return (o) => ['true', '1', 'yes'].includes(String(v(o)).toLowerCase());
      case 'falsy': return (o) => !['true', '1', 'yes'].includes(String(v(o)).toLowerCase());
      default: throw new Error(`comparator selector op "${e.op}" is not supported`);
    }
  };
  return one(expr);
}

export const COMPARATORS = Object.freeze(COMPARATORS_MUTABLE);

/* ── EXPANDERS ──────────────────────────────────────────────────────────── */

export const EXPANDERS = Object.freeze({
  /** key → the CIs that depend on it (parent → child) to `depth`, read for these keys only. */
  dependents_via_graph: ({ depth = 2, direction = 'out' }) => ({
    async prepare(ctx, keys) {
      const g = await boundedGraph(ctx, { seeds: keys, depth });
      if (g.complete === false) return { status: 'unavailable', reason: `relationships for ${g.coverage.incomplete_nodes} of the ${keys.length} referenced CIs could not be read completely — dependent-CI correlation cannot be claimed`, coverage: g.coverage };
      return { status: 'ok', coverage: g.coverage, expand: (k) => [...g.traverse([k], { depth, direction }).keys()] };
    },
  }),
});

/* ── COMBINATORS ────────────────────────────────────────────────────────── */

/** Every value of `field` an input's findings name in evidence. */
function evidenceValues(res, field) {
  const out = new Set();
  for (const f of res.findings || []) for (const e of f.evidence || []) if (e.field_name === field && !isEmpty(e.field_value) && !e.redacted) out.add(String(e.field_value));
  return out;
}

export const COMBINATORS = Object.freeze({
  /**
   * Values (a group, a CI) offending in at least `min_inputs` of the inputs —
   * "groups with zero active members referenced by open records in more than
   * one process".
   */
  shared_offenders: ({ field, min_inputs = 2, table, title, description, severity }) => async (inputs, ctx, rule) => {
    const counts = new Map();
    for (const [id, res] of Object.entries(inputs)) for (const v of evidenceValues(res, field)) { if (!counts.has(v)) counts.set(v, new Set()); counts.get(v).add(id); }
    const shared = [...counts.entries()].filter(([, ids]) => ids.size >= min_inputs);
    const findings = shared.length ? [recordFinding({
      rule, table: table ?? field, records: shared.map(([v, ids]) => ({ sys_id: v, [field]: v, processes: [...ids].sort().join(', ') })), fields: [field, 'processes'],
      title: title || rule.title, description: description || rule.whatItMeans, severity: severity || rule.base, confidence: 1.0, recommendation: null, collected_at: ctx.run.run_started_at,
    })] : [];
    return { findings, kpis: [], measures: { [`${rule.id}:shared`]: { value: shared.length, population: counts.size, at: ctx.run.run_started_at } } };
  },

  /** Fires only when EVERY input breached (has at least one finding); the evidence is each input's measure. */
  /**
   * Fires only when EVERY input breached. An input breaches when it has a
   * finding — or, for an input the workbook gives no threshold of its own
   * (`thresholds[id] = { op, value }`), when its offending share (100 − the
   * kpi's pass_pct) meets that threshold. The evidence is each input's rate
   * side by side.
   */
  all_breach: ({ thresholds = {}, title, description, severity }) => async (inputs, ctx, rule) => {
    const cmp = { gt: (x, y) => x > y, gte: (x, y) => x >= y, lt: (x, y) => x < y, lte: (x, y) => x <= y };
    const entries = Object.entries(inputs);
    const rateOf = (r) => { const k = (r.kpis || []).find((x) => x.pass_pct != null); return k ? round1(100 - k.pass_pct) : null; };
    const judged = entries.map(([id, r]) => {
      const t = thresholds[id];
      const rate = rateOf(r);
      if (t) {
        if (!cmp[t.op] || !Number.isFinite(t.value)) throw new Error(`all_breach: threshold for ${id} must be { op, value }`);
        return { id, rate, threshold: t, breached: rate != null && cmp[t.op](rate, t.value), judged_by: 'threshold', evaluable: rate != null };
      }
      return { id, rate, threshold: null, breached: (r.findings || []).length > 0, judged_by: 'findings', evaluable: true };
    });
    const measures = { [`${rule.id}:breaching_inputs`]: { value: judged.filter((j) => j.breached).length, population: entries.length, distribution: judged.map((j) => ({ value: j.id, count: j.rate, share: j.rate })), at: ctx.run.run_started_at } };
    /*
     * An input with no rate because its population was EMPTY is not an unavailable
     * input — it evaluated and established nothing, which the composite engine
     * reports as inconclusive (Phase 5 closure). Any other missing rate stays
     * UNAVAILABLE, as before.
     */
    const noRate = judged.filter((j) => !j.evaluable);
    if (noRate.some((j) => !undeterminedOf(inputs[j.id]))) return { findings: [], kpis: [], measures, unavailable: `input ${noRate.map((j) => j.id).join(', ')} recorded no rate to judge against its threshold` };
    if (noRate.length) return { findings: [], kpis: [], measures };
    if (!entries.length || judged.some((j) => !j.breached)) return { findings: [], kpis: [], measures };
    const metric = { measure: 'count', observed: judged.length, threshold: { op: 'gte', value: entries.length }, breached: true, population: entries.length, basis: `all of ${judged.map((j) => `${j.id} (${j.rate ?? '?'}%${j.threshold ? ` ${j.threshold.op} ${j.threshold.value}` : ''})`).join(', ')} breached`, distribution: judged.map((j) => ({ group: { rule: j.id }, count: j.rate, share: j.rate })) };
    return { findings: [aggregateFinding({ rule, table: 'estate', metric, title: title || rule.title, description: description || rule.whatItMeans, severity: severity || rule.base, confidence: 1.0, recommendation: null, collected_at: ctx.run.run_started_at })], kpis: [], measures };
  },

  /** Correlated pairs (a temporal input's `pairs`) counted per key; keys at or above `min` offend. */
  pairs_by_key: ({ input, key = 'key', min, table = 'cmdb_ci', title, description, severity }) => async (inputs, ctx, rule) => {
    const res = inputs[input];
    const pairs = res?.pairs || [];
    const counts = new Map();
    for (const p of pairs) { const k = key.includes('.') ? key.split('.').reduce((o, x) => o?.[x], p) : p[key]; if (isEmpty(k)) continue; counts.set(k, (counts.get(k) || 0) + 1); }
    const offenders = [...counts.entries()].filter(([, n]) => n >= min).map(([k, n]) => ({ sys_id: k, pairs: n }));
    const findings = offenders.length ? [recordFinding({ rule, table, records: offenders, fields: ['pairs'], title: title || rule.title, description: description || rule.whatItMeans, severity: severity || rule.base, confidence: 1.0, recommendation: null, collected_at: ctx.run.run_started_at })] : [];
    return { findings, kpis: [], measures: { [`${rule.id}:keys_over_threshold`]: { value: offenders.length, population: counts.size, at: ctx.run.run_started_at } } };
  },

  /** Correlated-pair rate per dimension of the right-hand row (group, type …) — reported as a distribution, no threshold. */
  rate_by_dimension: ({ input, dimensions = [], side = 'right_row' }) => async (inputs, ctx, rule) => {
    const res = inputs[input];
    const pairs = res?.pairs || [];
    const measures = {};
    for (const dim of dimensions) {
      const by = new Map();
      for (const p of pairs) { const v = String(p[side]?.[dim] ?? ''); by.set(v, (by.get(v) || 0) + 1); }
      measures[`${rule.id}:pairs_by_${dim}`] = { value: null, population: pairs.length, distribution: [...by.entries()].map(([value, count]) => ({ value, count, share: pairs.length ? round1(100 * count / pairs.length) : null })).sort((a, b) => b.count - a.count), at: ctx.run.run_started_at };
    }
    return { findings: [], kpis: [{ rule_id: rule.id, numerator: pairs.length, denominator: null, pass_pct: null, basis: `${pairs.length} correlated pairs from ${input}, by ${dimensions.join(', ')}` }], measures };
  },

  /**
   * Mean time from a cluster's first occurrence to the creation of the
   * problem its members link to (a text input's `clusters`). Clusters with no
   * linked problem are excluded and counted.
   */
  cluster_to_problem_latency: ({ input, link_field = 'problem_id', time_field = 'sys_created_on', problem_table = 'problem' }) => async (inputs, ctx, rule) => {
    const clusters = inputs[input]?.clusters || [];
    const linked = clusters.map((c) => ({ c, problem: c.members.map((m) => m[link_field]).find((v) => !isEmpty(v)) })).filter((x) => x.problem);
    const ids = [...new Set(linked.map((x) => x.problem))];
    const latencies = [];
    let coverage = [];
    if (ids.length) {
      const r = await ctx.reads.read(declareRequirement({ table: problem_table, fields: [time_field], query: `sys_idIN${ids.join(',')}`, strategy: 'rows' }));
      coverage = [r.coverage];
      if (!usable(r.coverage)) return { findings: [], kpis: [], measures: {}, unavailable: `${problem_table} could not be read (${r.coverage.status})` };
      const created = new Map(r.rows.map((p) => [p.sys_id, fromSnowTime(p[time_field])]));
      for (const { c, problem } of linked) {
        const first = c.members.map((m) => fromSnowTime(m[time_field])).filter(Boolean).sort((a, b) => a - b)[0];
        const pc = created.get(problem);
        if (first && pc) latencies.push({ cluster: c.representative?.sys_id ?? null, problem, hours: Number(((pc - first) / 3_600_000).toFixed(1)) });
      }
    }
    const mean = latencies.length ? Number((latencies.reduce((s, x) => s + x.hours, 0) / latencies.length).toFixed(1)) : null;
    return { findings: [], kpis: [{ rule_id: rule.id, numerator: latencies.length, denominator: clusters.length, pass_pct: null, basis: `${latencies.length} of ${clusters.length} clusters link to a problem; mean latency ${mean ?? 'n/a'} h` }], measures: { [`${rule.id}:mean_latency_hours`]: { value: mean, population: latencies.length, distribution: latencies, at: ctx.run.run_started_at } }, coverage };
  },
});

/* ── OFFENDERS (named offend tests, when an expression is not enough) ───── */

export const OFFENDERS = Object.freeze({});
