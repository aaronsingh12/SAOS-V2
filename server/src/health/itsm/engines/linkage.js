import { declareRequirement } from '../data-access.js';
import { recordFinding } from '../findings.js';
import { result, preflight, STATUS, empty as isEmpty, notePopulation, withhold, UNDETERMINED } from './result.js';

/**
 * ENGINE 4 — Cross-Record Linkage.
 *
 * "Does a related record exist, and in what state?" — incident ↔ problem,
 * problem ↔ change, change ↔ approval, task ↔ CI, incident ↔ knowledge.
 *
 * The primitive is an INDEX built once per source: `indexBy(rows, key)`
 * groups a table by a field (or a many-to-many table by either column), and
 * every join, anti-join, existence and state check is a Map lookup over it.
 * Two rules linking incidents to problems share one index of `incident` by
 * `problem_id`; nothing re-queries.
 *
 * Links are declared as data:
 *   { kind: 'reference', from: 'incident', field: 'problem_id', to: 'problem' }
 *   { kind: 'm2m', table: 'task_ci', from: 'change_request', from_field: 'task', to: 'cmdb_ci', to_field: 'ci_item' }
 *
 * A target that cannot be read is not "no links": the join reports
 * `available: false` with the coverage, and the calling rule skips. Duplicate
 * relationship rows (the same pair twice in an m2m table) count once.
 */

export const ENGINE_KEY = 'linkage';
export const ENGINE_VERSION = '1.2.0';

export const LINK_KINDS = Object.freeze(['reference', 'm2m']);
export const EXPECTATIONS = Object.freeze(['exists', 'absent', 'count_gte', 'all_in_state', 'any_in_state']);

export class LinkageError extends Error {
  constructor(message) { super(message); this.name = 'LinkageError'; }
}

/** Index rows by a key field: Map(value → rows[]). Rows with an empty key are skipped (no link). */
export function indexBy(rows, key) {
  const index = new Map();
  for (const r of rows) {
    const v = r[key];
    if (isEmpty(v)) continue;
    if (!index.has(v)) index.set(v, []);
    index.get(v).push(r);
  }
  return index;
}

/** An m2m table as a Map(from → Set(to)), de-duplicating repeated pairs. */
export function indexPairs(rows, fromField, toField) {
  const index = new Map();
  for (const r of rows) {
    const a = r[fromField]; const b = r[toField];
    if (isEmpty(a) || isEmpty(b)) continue;
    if (!index.has(a)) index.set(a, new Set());
    index.get(a).add(b);
  }
  return index;
}

/**
 * Join: for each source row, the related target rows.
 *   reference link on the SOURCE  (incident.problem_id → problem):     targets = byId.get(source[field])
 *   reference link on the TARGET  (problem ← incident.problem_id):     targets = index.get(source.sys_id)
 *   m2m                                                               targets = pairs.get(source.sys_id) → byId
 */
export function join(sources, targets, link) {
  const byId = new Map(targets.map((t) => [t.sys_id, t]));
  const out = new Map();
  if (link.kind === 'reference' && link.direction !== 'inbound') {
    for (const s of sources) {
      const v = s[link.field];
      out.set(s.sys_id, !isEmpty(v) && byId.has(v) ? [byId.get(v)] : []);
    }
  } else if (link.kind === 'reference') {
    const inbound = indexBy(targets, link.field);
    for (const s of sources) out.set(s.sys_id, inbound.get(s.sys_id) || []);
  } else if (link.kind === 'm2m') {
    const pairs = indexPairs(link.rows || [], link.from_field, link.to_field);
    for (const s of sources) out.set(s.sys_id, [...(pairs.get(s.sys_id) || [])].map((id) => byId.get(id)).filter(Boolean));
  } else {
    throw new LinkageError(`link kind "${link.kind}" is not one of ${LINK_KINDS.join(', ')}`);
  }
  return out;
}

/** Sources with NO related target. */
export function antiJoin(sources, targets, link) {
  const j = join(sources, targets, link);
  return sources.filter((s) => (j.get(s.sys_id) || []).length === 0);
}

/** Sources with at least `min` related targets. */
export function existenceJoin(sources, targets, link, { min = 1 } = {}) {
  const j = join(sources, targets, link);
  return sources.filter((s) => (j.get(s.sys_id) || []).length >= min);
}

/**
 * State join: sources whose related targets satisfy a state test.
 *   mode 'any'  at least one target passes `test`
 *   mode 'all'  every target passes (and there is at least one)
 *   mode 'none' no target passes (and there is at least one)
 */
export function stateJoin(sources, targets, link, test, { mode = 'any' } = {}) {
  const j = join(sources, targets, link);
  return sources.filter((s) => {
    const ts = j.get(s.sys_id) || [];
    if (!ts.length) return false;
    const hits = ts.filter((t) => test(t, s)).length;
    if (mode === 'any') return hits > 0;
    if (mode === 'all') return hits === ts.length;
    if (mode === 'none') return hits === 0;
    throw new LinkageError(`mode "${mode}"`);
  });
}

/** Link counts per source id — for "problems with zero linked incidents" without materialising the join. */
export function countLinks(sources, targets, link) {
  const j = join(sources, targets, link);
  return new Map([...j.entries()].map(([id, ts]) => [id, ts.length]));
}

/**
 * Engine contract. `rule.config`:
 *   { from: {table, query, fields[]}, to: {table, query, fields[]}, link: {kind, field, direction, m2m: {table, from_field, to_field}},
 *     expect: 'exists'|'absent'|'count_gte'|'all_in_state'|'any_in_state', min, state_test (fn), report_ratio, threshold {op, value}, minimum_volume,
 *     evidence_fields[], severity, title, description }
 */
export const engine = Object.freeze({
  key: ENGINE_KEY,
  name: 'Cross-Record Linkage Engine',
  version: ENGINE_VERSION,
  canEvaluate: (rule) => rule?.architecture?.engine === ENGINE_KEY || rule?.architecture?.also_requires?.includes(ENGINE_KEY),
  prepare: async () => undefined,
  async evaluate(rule, ctx) {
    const c = rule.config;
    const gate = await preflight(rule, ENGINE_KEY, ctx, {
      requiredCapabilities: c ? [
        () => ctx.probes.readable(c.from.table), () => ctx.probes.readable(c.to.table),
        /* the link field must EXIST where it is read: a query on a missing field matches every row on the platform, which would read as "no links" */
        ...(c.link.kind === 'reference' ? [() => ctx.probes.fieldsExist(c.link.direction === 'inbound' ? c.to.table : c.from.table, [c.link.field])] : []),
        ...(c.link.kind === 'm2m' ? [() => ctx.probes.readable(c.link.m2m.table), () => ctx.probes.fieldsExist(c.link.m2m.table, [c.link.m2m.from_field, c.link.m2m.to_field])] : []),
      ] : [],
      requiredParameters: c?.required_parameters || [],
    });
    if (gate) return gate;
    if (!EXPECTATIONS.includes(c.expect)) throw new LinkageError(`expect "${c.expect}" is not one of ${EXPECTATIONS.join(', ')}`);
    const fromReq = declareRequirement({ table: c.from.table, fields: [...(c.from.fields || []), ...(c.link.kind === 'reference' && c.link.direction !== 'inbound' ? [c.link.field] : []), ...(c.evidence_fields || [])], query: c.from.query || '', strategy: 'rows' });
    const toReq = declareRequirement({ table: c.to.table, fields: [...(c.to.fields || []), ...(c.link.kind === 'reference' && c.link.direction === 'inbound' ? [c.link.field] : [])], query: c.to.query || '', strategy: 'rows' });
    const from = await ctx.reads.read(fromReq);
    const to = await ctx.reads.read(toReq);
    const out = result(rule, ENGINE_KEY, { coverage: [from.coverage, to.coverage], parameters: ctx.parametersFor(rule.id) });
    const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov.status);
    if (!usable(from.coverage) || !usable(to.coverage)) {
      out.status = STATUS.UNAVAILABLE;
      const bad = !usable(from.coverage) ? from.coverage : to.coverage;
      out.skipped.push({ rule: rule.id, table: bad.table, reason: `${bad.table} could not be read (${bad.status}): ${bad.error}` });
      return out;
    }
    let link = { ...c.link };
    if (link.kind === 'm2m') {
      const m2mReq = declareRequirement({ table: link.m2m.table, fields: [link.m2m.from_field, link.m2m.to_field], query: link.m2m.query || '', strategy: 'rows' });
      const m2m = await ctx.reads.read(m2mReq);
      out.coverage.push(m2m.coverage);
      if (!usable(m2m.coverage)) {
        out.status = STATUS.UNAVAILABLE;
        out.skipped.push({ rule: rule.id, table: link.m2m.table, reason: `${link.m2m.table} could not be read (${m2m.coverage.status})` });
        return out;
      }
      link = { kind: 'm2m', rows: m2m.rows, from_field: link.m2m.from_field, to_field: link.m2m.to_field };
    }
    /* An ABSENCE claim ("no linked problem") needs the target read to be complete. */
    const absenceClaim = ['absent', 'count_gte'].includes(c.expect);
    if (absenceClaim && !to.coverage.rowsComplete) {
      out.status = STATUS.UNAVAILABLE;
      out.skipped.push({ rule: rule.id, table: c.to.table, reason: `${c.to.table} was not read completely (${to.coverage.rowsFetched} of ${to.coverage.totalKnown ?? '?'}), so "no linked record" cannot be claimed` });
      return out;
    }
    let offenders;
    switch (c.expect) {
      case 'absent': offenders = antiJoin(from.rows, to.rows, link); break;
      case 'exists': offenders = existenceJoin(from.rows, to.rows, link); break;
      case 'count_gte': offenders = existenceJoin(from.rows, to.rows, link, { min: c.min ?? 1 }); break;
      case 'all_in_state': offenders = stateJoin(from.rows, to.rows, link, c.state_test, { mode: 'all' }); break;
      case 'any_in_state': offenders = stateJoin(from.rows, to.rows, link, c.state_test, { mode: 'any' }); break;
      default: throw new LinkageError(c.expect);
    }
    /* EMPTY POPULATION (Phase 5 closure): the population is the source side — every record whose links are judged. */
    notePopulation(out, { total: from.coverage.totalKnown ?? from.rows.length, judged: from.rows.length, unit: `${c.from.table} records`, basis: c.from.query ? `${c.from.table} where ${c.from.query}` : `every ${c.from.table} record` });
    const share = from.rows.length ? Number((100 * offenders.length / from.rows.length).toFixed(1)) : null;
    if ((c.report_ratio || c.threshold) && from.rows.length) {
      out.kpis.push({ rule_id: rule.id, numerator: from.rows.length - offenders.length, denominator: from.rows.length, pass_pct: Number((100 - share).toFixed(1)), basis: `${c.from.table} → ${c.to.table} (${c.expect})`, complete: from.coverage.rowsComplete && to.coverage.rowsComplete });
      out.measures[`${rule.id}:offending_share`] = { value: share, population: from.rows.length, at: ctx.run.run_started_at };
    }
    if (c.threshold) {
      /* Estate-level: findings only when the offending share breaches. */
      const cmp = { gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b }[c.threshold.op];
      if (!cmp) throw new LinkageError(`threshold op ${c.threshold.op}`);
      if (c.minimum_volume != null && from.rows.length < c.minimum_volume) {
        out.skipped.push({ rule: rule.id, table: c.from.table, reason: `population ${from.rows.length} is below the minimum volume ${c.minimum_volume}` });
        if (from.rows.length) withhold(out, UNDETERMINED.BELOW_MINIMUM_VOLUME, `population ${from.rows.length} is below the minimum volume ${c.minimum_volume}`);
        return out;
      }
      if (share == null || !cmp(share, c.threshold.value)) return out;
    }
    if (offenders.length) {
      out.findings.push(recordFinding({
        rule, table: c.from.table, records: offenders, fields: c.evidence_fields || [], title: c.title || rule.title, description: c.description || rule.whatItMeans,
        severity: c.severity || rule.base, confidence: c.confidence ?? 1.0, recommendation: c.recommendation ?? null, collected_at: ctx.run.run_started_at,
      }));
    }
    return out;
  },
});
