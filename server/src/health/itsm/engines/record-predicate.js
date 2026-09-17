import { declareRequirement, isCompleteFor } from '../data-access.js';
import { fromSnowTime, toSnowTime, shiftDate, UNITS_MS, parseWindow } from '../run-context.js';
import { recordFinding } from '../findings.js';
import { result, preflight, STATUS, empty as isEmpty } from './result.js';

/**
 * ENGINE 1 — Record Predicate.
 *
 * A per-record test over the fields of one task table, expressed as DATA:
 *
 *   { field: 'close_notes', op: 'empty' }
 *   { field: 'close_notes', op: 'length_lt', value: 20 }
 *   { field: 'sys_created_on', field2: 'closed_at', op: 'interval_lt', value: 60, unit: 'seconds' }
 *   { field: 'sys_created_on', op: 'date_before', window: '2 days' }        // older than 2 days at the run anchor
 *   { field: 'priority', op: 'equals', value: '1' }
 *   { field: 'caller_id', field2: 'resolved_by', op: 'same_as' }             // two fields of the record equal (in memory)
 *   { field: 'close_code', op: 'in', value: ['unsuccessful'] }
 *
 * Predicates AND together. The engine plans a PUSHDOWN: every predicate the
 * Table API can express becomes part of the encoded query (`close_notesISEMPTY`,
 * `priority=1`, `sys_created_on<2026-09-14 00:00:00`), so only the rows that
 * already satisfy those are read; the rest ("length under 20 after trimming",
 * "closed within 60 s of creation" — field-to-field arithmetic the API cannot
 * do) run in memory over the reduced set. A rule with only pushable predicates
 * uses the `ids` strategy and never retrieves a text body at all.
 *
 * A row that lacks a field the predicate reads is UNEVALUABLE, not a pass and
 * not a fail: a hidden `assignment_group` is a coverage gap (the existing
 * ITSM-INC-UNASSIGNED guards the same way), and the count is reported.
 */

export const ENGINE_KEY = 'record_predicate';
export const ENGINE_VERSION = '1.1.0';

export const OPS = Object.freeze([
  'empty', 'not_empty', 'equals', 'not_equals', 'in', 'not_in',
  'length_lt', 'length_gt', 'interval_lt', 'interval_gt', 'date_before', 'date_after', 'same_as', 'differs_from',
]);
const PUSHABLE = new Set(['empty', 'not_empty', 'equals', 'not_equals', 'in', 'not_in', 'date_before', 'date_after']);

export class PredicateError extends Error {
  constructor(message) { super(message); this.name = 'PredicateError'; }
}

export function validatePredicate(p) {
  if (!p || typeof p !== 'object') throw new PredicateError('a predicate must be an object');
  if (!OPS.includes(p.op)) throw new PredicateError(`op "${p.op}" is not one of ${OPS.join(', ')}`);
  if (!p.field || typeof p.field !== 'string') throw new PredicateError(`predicate ${p.op} needs a field`);
  if (['length_lt', 'length_gt'].includes(p.op) && !(Number.isFinite(p.value) && p.value >= 0)) throw new PredicateError(`${p.op} needs a non-negative numeric value`);
  if (['interval_lt', 'interval_gt'].includes(p.op)) {
    if (!(Number.isFinite(p.value) && p.value >= 0)) throw new PredicateError(`${p.op} needs a non-negative numeric value`);
    if (!(p.unit in UNITS_MS)) throw new PredicateError(`${p.op} needs a unit (${Object.keys(UNITS_MS).join(', ')})`);
  }
  if (['equals', 'not_equals'].includes(p.op) && p.value === undefined) throw new PredicateError(`${p.op} needs a value`);
  if (['in', 'not_in'].includes(p.op) && !Array.isArray(p.value)) throw new PredicateError(`${p.op} needs a list value`);
  if (['date_before', 'date_after'].includes(p.op) && !p.window && !p.at) throw new PredicateError(`${p.op} needs a window (relative to the run anchor) or an absolute time`);
  if (['same_as', 'differs_from'].includes(p.op) && !p.field2) throw new PredicateError(`${p.op} needs field2`);
  return true;
}

/** The absolute time a date predicate compares against, from the run anchor. */
function boundOf(p, ctx) {
  if (p.at) return fromSnowTime(p.at) ?? (() => { throw new PredicateError(`"${p.at}" is not a time`); })();
  return shiftDate(ctx.run.now, parseWindow(p.window), -1);
}

/**
 * Compile to `(row) => true | false | null` — null = unevaluable (missing field / unparseable date).
 */
export function compilePredicate(p, ctx) {
  validatePredicate(p);
  const has = (row, f) => f in row;
  switch (p.op) {
    case 'empty': return (row) => (has(row, p.field) ? isEmpty(row[p.field]) : null);
    case 'not_empty': return (row) => (has(row, p.field) ? !isEmpty(row[p.field]) : null);
    case 'equals': return (row) => (has(row, p.field) ? String(row[p.field]) === String(p.value) : null);
    case 'not_equals': return (row) => (has(row, p.field) ? String(row[p.field]) !== String(p.value) : null);
    case 'in': { const set = new Set(p.value.map(String)); return (row) => (has(row, p.field) ? set.has(String(row[p.field])) : null); }
    case 'not_in': { const set = new Set(p.value.map(String)); return (row) => (has(row, p.field) ? !set.has(String(row[p.field])) : null); }
    case 'same_as': return (row) => (has(row, p.field) && has(row, p.field2) ? !isEmpty(row[p.field]) && String(row[p.field]) === String(row[p.field2]) : null);
    case 'differs_from': return (row) => (has(row, p.field) && has(row, p.field2) ? String(row[p.field] ?? '') !== String(row[p.field2] ?? '') : null);
    case 'length_lt': return (row) => (has(row, p.field) ? String(row[p.field] ?? '').trim().length < p.value : null);
    case 'length_gt': return (row) => (has(row, p.field) ? String(row[p.field] ?? '').trim().length > p.value : null);
    case 'interval_lt':
    case 'interval_gt': {
      const limit = p.value * UNITS_MS[p.unit];
      return (row) => {
        if (!has(row, p.field)) return null;
        const a = fromSnowTime(row[p.field]);
        const b = p.field2 ? (has(row, p.field2) ? fromSnowTime(row[p.field2]) : null) : ctx.run.now;
        if (!a || !b) return null;
        const delta = b.getTime() - a.getTime();
        return p.op === 'interval_lt' ? delta < limit : delta > limit;
      };
    }
    case 'date_before':
    case 'date_after': {
      const bound = boundOf(p, ctx).getTime();
      return (row) => {
        if (!has(row, p.field)) return null;
        const t = fromSnowTime(row[p.field]);
        if (!t) return null;
        return p.op === 'date_before' ? t.getTime() < bound : t.getTime() > bound;
      };
    }
    default: throw new PredicateError(`unsupported op ${p.op}`);
  }
}

/** The encoded-query clause for a pushable predicate, or null when it must run in memory. */
export function toEncodedQuery(p, ctx) {
  validatePredicate(p);
  if (!PUSHABLE.has(p.op)) return null;
  switch (p.op) {
    case 'empty': return `${p.field}ISEMPTY`;
    case 'not_empty': return `${p.field}ISNOTEMPTY`;
    case 'equals': return `${p.field}=${p.value}`;
    case 'not_equals': return `${p.field}!=${p.value}`;
    case 'in': return `${p.field}IN${p.value.join(',')}`;
    case 'not_in': return `${p.field}NOT IN${p.value.join(',')}`;
    case 'date_before': return `${p.field}<${toSnowTime(boundOf(p, ctx))}`;
    case 'date_after': return `${p.field}>${toSnowTime(boundOf(p, ctx))}`;
    default: return null;
  }
}

/**
 * Split predicates into what the query can do and what stays in memory, and
 * choose the read strategy: `ids` when nothing is residual and no evidence
 * fields are wanted beyond identity, else `rows` over the pushed query.
 */
export function pushdownPlan({ scope = '', predicates = [], evidenceFields = [], keep = [] }, ctx) {
  const pushed = [];
  const residual = [];
  const clauses = scope ? [scope] : [];
  for (const p of predicates) {
    const clause = toEncodedQuery(p, ctx);
    if (clause) { pushed.push(p); clauses.push(clause); } else residual.push(p);
  }
  const residualFields = [...new Set(residual.flatMap((p) => [p.field, p.field2].filter(Boolean)))];
  const fields = [...new Set([...residualFields, ...evidenceFields, ...keep])];
  const strategy = residual.length === 0 && fields.length === 0 ? 'ids' : 'rows';
  return Object.freeze({ query: clauses.join('^'), pushed, residual, fields, strategy });
}

/** Evaluate residual predicates over rows already narrowed by the pushed query. */
export function evaluateRecords(rows, residual, ctx) {
  const tests = residual.map((p) => compilePredicate(p, ctx));
  const offenders = [];
  let unevaluable = 0;
  for (const row of rows) {
    let verdict = true;
    for (const t of tests) {
      const v = t(row);
      if (v === null) { verdict = null; break; }
      if (!v) { verdict = false; break; }
    }
    if (verdict === null) unevaluable += 1;
    else if (verdict) offenders.push(row);
  }
  return { offenders, unevaluable, evaluated: rows.length - unevaluable };
}

/**
 * Engine contract. `rule.config`:
 *   { table, scope, predicates[], evidence_fields[], report_ratio, population_query?, sensitive[], severity, confidence, title, description }
 */
export const engine = Object.freeze({
  key: ENGINE_KEY,
  name: 'Record Predicate Engine',
  version: ENGINE_VERSION,
  canEvaluate: (rule) => rule?.architecture?.engine === ENGINE_KEY || rule?.architecture?.also_requires?.includes(ENGINE_KEY),
  prepare: async () => undefined,
  async evaluate(rule, ctx) {
    const c = rule.config;
    const gate = await preflight(rule, ENGINE_KEY, ctx, {
      requiredCapabilities: c ? [() => ctx.probes.fieldsExist(c.table, [...new Set(c.predicates.flatMap((p) => [p.field, p.field2].filter(Boolean)))])] : [],
      requiredParameters: c?.required_parameters || [],
    });
    if (gate) return gate;
    const plan = pushdownPlan({ scope: c.scope, predicates: c.predicates, evidenceFields: c.evidence_fields || [] }, ctx);
    const req = declareRequirement({ table: c.table, fields: plan.fields, query: plan.query, strategy: plan.strategy, sensitive: c.sensitive || [], maxRows: c.max_rows });
    const { rows, coverage } = await ctx.reads.read(req);
    const out = result(rule, ENGINE_KEY, { coverage: [coverage], parameters: ctx.parametersFor(rule.id) });
    if (!['complete', 'limited', 'truncated'].includes(coverage.status)) {
      out.status = STATUS.UNAVAILABLE;
      out.skipped.push({ rule: rule.id, table: c.table, reason: `${c.table} could not be read (${coverage.status}): ${coverage.error}` });
      return out;
    }
    const { offenders, unevaluable, evaluated } = evaluateRecords(rows, plan.residual, ctx);
    if (unevaluable) out.skipped.push({ rule: rule.id, table: c.table, reason: 'Fields omitted by API/ACL', excluded_records: unevaluable });
    if (offenders.length) {
      out.findings.push(recordFinding({
        rule, table: c.table, records: offenders, fields: c.evidence_fields || [], title: c.title || rule.title,
        description: c.description || rule.whatItMeans, severity: c.severity || rule.base, confidence: c.confidence ?? 1.0,
        recommendation: c.recommendation ?? null, collected_at: ctx.run.run_started_at, sensitive: c.sensitive || [],
      }));
    }
    if (c.report_ratio) {
      /* The denominator is the population the rule is about (an encoded query), counted server-side. */
      const popReq = declareRequirement({ table: c.table, query: c.population_query ?? c.scope ?? '', strategy: 'exists' });
      const pop = await ctx.reads.read(popReq);
      out.coverage.push(pop.coverage);
      const denominator = pop.count;
      if (denominator != null && denominator > 0) {
        out.kpis.push({
          rule_id: rule.id, numerator: denominator - offenders.length, denominator,
          pass_pct: Number((100 * (1 - offenders.length / denominator)).toFixed(1)),
          basis: `${offenders.length} of ${denominator} records match ${plan.query || 'the predicate'}`,
          complete: isCompleteFor(coverage, plan.fields),
        });
      }
    }
    return out;
  },
});
