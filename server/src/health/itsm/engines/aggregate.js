import { declareRequirement } from '../data-access.js';
import { aggregateFinding } from '../findings.js';
import { result, preflight, STATUS } from './result.js';

/**
 * ENGINE 2 — Aggregate & Distribution.
 *
 * Counts, shares, ratios, averages, sums and distributions over a slice,
 * grouped or not, judged against a threshold — WITHOUT reading rows. The
 * measure goes to the Aggregate API (`client.aggregate`: count/avg/sum/min/max
 * per group) and comes back as O(groups) numbers whatever the table size.
 * `aggregateRows()` computes the same shape from rows already in memory, for
 * callers that have them (and for the offline suite).
 *
 * Thresholds are data: `{ op: 'gt', value: 70, escalate_at: 85 }`. Two-tier
 * thresholds ("8%, escalate above 15%") are supported where the workbook
 * states them; `minimum_volume` withholds a judgement on too small a
 * population ("small sample sizes producing unstable rates" — ITSM-124's
 * false-positive guard) rather than reporting noise as a finding.
 *
 * DECISION 2 — there is no "ideal distribution". Every distribution measure
 * here is EMPIRICAL: the observed shares of the relevant population, judged
 * against the rule's explicit threshold with a minimum-volume guard, and the
 * observed distribution itself is the evidence. `joint_share` is the
 * category × resolution-code relationship ITSM-024 asks for: for every primary
 * value with enough volume, the share of each secondary value within it.
 */

export const ENGINE_KEY = 'aggregate';
export const ENGINE_VERSION = '1.1.0';

export const MEASURES = Object.freeze(['count', 'share', 'ratio', 'percentage', 'average', 'sum', 'distribution', 'joint_share']);
export const THRESHOLD_OPS = Object.freeze(['gt', 'gte', 'lt', 'lte']);

export class AggregateError extends Error {
  constructor(message) { super(message); this.name = 'AggregateError'; }
}

const cmp = { gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b };
const round1 = (n) => Number(n.toFixed(1));

/** In-memory equivalent of `client.aggregate` over rows — same output shape. */
export function aggregateRows(rows, { groupBy = [], avg = [], sum = [] } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const key = groupBy.map((f) => `${f}=${r[f] ?? ''}`).join('|');
    if (!groups.has(key)) {
      groups.set(key, { group: Object.fromEntries(groupBy.map((f) => [f, r[f] ?? ''])), count: 0, _sum: {}, _n: {} });
    }
    const g = groups.get(key);
    g.count += 1;
    for (const f of new Set([...avg, ...sum])) {
      const v = Number(r[f]);
      if (Number.isFinite(v)) { g._sum[f] = (g._sum[f] || 0) + v; g._n[f] = (g._n[f] || 0) + 1; }
    }
  }
  return [...groups.values()].map((g) => ({
    group: g.group,
    count: g.count,
    avg: Object.fromEntries(avg.map((f) => [f, g._n[f] ? g._sum[f] / g._n[f] : null])),
    sum: Object.fromEntries(sum.map((f) => [f, g._sum[f] ?? 0])),
    min: {},
    max: {},
  }));
}

export function validateThreshold(t) {
  if (t == null) return null;
  if (!THRESHOLD_OPS.includes(t.op)) throw new AggregateError(`threshold op "${t.op}" is not one of ${THRESHOLD_OPS.join(', ')}`);
  if (!Number.isFinite(t.value)) throw new AggregateError('threshold value must be a number');
  if (t.escalate_at != null && !Number.isFinite(t.escalate_at)) throw new AggregateError('escalate_at must be a number');
  return t;
}

/** Judge one observed number against a threshold: `{ breached, escalated }`. */
export function judge(observed, threshold) {
  const t = validateThreshold(threshold);
  if (!t || observed == null) return { breached: false, escalated: false };
  const breached = cmp[t.op](observed, t.value);
  const escalated = breached && t.escalate_at != null && cmp[t.op](observed, t.escalate_at);
  return { breached, escalated };
}

/**
 * Compute a measure over aggregate groups.
 *
 *   count        total count (or of `groups` matching `where`)
 *   share        the largest group's share of the total, or of the group matching `of` — "one band holds >70%"
 *   ratio        count(groups matching `numerator`) / count(groups matching `denominator` or all) — "reopened / resolved"
 *   percentage   ratio × 100
 *   average      avg of `field` across groups, count-weighted
 *   sum          sum of `field` across groups
 *   distribution every group's count and share — reported, no single number
 *
 * `where(group) → boolean` selectors are plain functions so a rule's
 * configuration can express "priority = 1" or "close_code in {…}" without a
 * second query language.
 */
export function computeMeasure(groups, { measure, of = null, numerator = null, denominator = null, field = null, primary = null, secondary = null, minimum_group_volume = null } = {}) {
  if (!MEASURES.includes(measure)) throw new AggregateError(`measure "${measure}" is not one of ${MEASURES.join(', ')}`);
  const total = groups.reduce((n, g) => n + g.count, 0);
  const selected = (sel) => groups.filter((g) => (typeof sel === 'function' ? sel(g.group) : true)).reduce((n, g) => n + g.count, 0);
  switch (measure) {
    case 'count': return { observed: numerator ? selected(numerator) : total, population: total, count: numerator ? selected(numerator) : total };
    case 'share': {
      if (!total) return { observed: null, population: 0 };
      if (of) { const n = selected(of); return { observed: round1(100 * n / total), population: total, count: n, percentage: round1(100 * n / total) }; }
      const top = [...groups].sort((a, b) => b.count - a.count)[0];
      return { observed: round1(100 * top.count / total), population: total, count: top.count, percentage: round1(100 * top.count / total), group: top.group };
    }
    case 'ratio':
    case 'percentage': {
      const den = denominator ? selected(denominator) : total;
      const num = selected(numerator || (() => true));
      if (!den) return { observed: null, population: 0, count: num };
      const ratio = num / den;
      return { observed: measure === 'ratio' ? Number(ratio.toFixed(4)) : round1(100 * ratio), population: den, count: num, percentage: round1(100 * ratio) };
    }
    case 'average': {
      if (!field) throw new AggregateError('average needs a field');
      let s = 0; let n = 0;
      for (const g of groups) if (g.avg?.[field] != null) { s += g.avg[field] * g.count; n += g.count; }
      return { observed: n ? Number((s / n).toFixed(3)) : null, population: n };
    }
    case 'sum': {
      if (!field) throw new AggregateError('sum needs a field');
      return { observed: groups.reduce((s, g) => s + (g.sum?.[field] ?? 0), 0), population: total };
    }
    case 'distribution': {
      const distribution = groups.map((g) => ({ group: g.group, count: g.count, share: total ? round1(100 * g.count / total) : null })).sort((a, b) => b.count - a.count);
      return { observed: null, population: total, distribution };
    }
    case 'joint_share': {
      /*
       * groups are keyed by [primary, secondary] (e.g. category × close_code).
       * For each primary value: its volume, and every secondary value's share
       * WITHIN it. `minimum_group_volume` withholds pairs whose primary has too
       * little volume to say anything — a category with three incidents has no
       * "expected" resolution codes. Nothing here says which share is
       * anomalous; the caller's threshold does.
       */
      if (!primary || !secondary) throw new AggregateError('joint_share needs primary and secondary fields');
      const byPrimary = new Map();
      for (const g of groups) {
        const pk = g.group[primary] ?? '';
        if (!byPrimary.has(pk)) byPrimary.set(pk, { primary: pk, volume: 0, pairs: [] });
        const b = byPrimary.get(pk);
        b.volume += g.count;
        b.pairs.push({ secondary: g.group[secondary] ?? '', count: g.count });
      }
      const pairs = [];
      let withheld = 0;
      for (const b of byPrimary.values()) {
        if (minimum_group_volume != null && b.volume < minimum_group_volume) { withheld += 1; continue; }
        for (const pr of b.pairs) pairs.push({ [primary]: b.primary, [secondary]: pr.secondary, count: pr.count, primary_volume: b.volume, share_within_primary: round1(100 * pr.count / b.volume) });
      }
      pairs.sort((a, b) => a.share_within_primary - b.share_within_primary || b.count - a.count);
      return { observed: null, population: total, pairs, primaries: byPrimary.size, primaries_withheld: withheld, distribution: pairs };
    }
    default: throw new AggregateError(`unsupported measure ${measure}`);
  }
}

/**
 * The full evaluation over one set of groups: measure → minimum volume →
 * threshold → a metric block ready for `aggregateFinding`.
 */
export function evaluateMeasure(groups, { measure, threshold = null, minimum_volume = null, unit = null, window = null, basis = null, ...selectors } = {}) {
  const m = computeMeasure(groups, { measure, ...selectors });
  const volume = m.population ?? 0;
  if (minimum_volume != null && volume < minimum_volume) {
    return { measure, ...m, threshold, breached: false, escalated: false, status: 'insufficient_volume', minimum_volume, unit, window, basis };
  }
  if (measure === 'joint_share') {
    /* Judged PER PAIR against the rule's threshold on share_within_primary; the breach is the set of pairs. */
    const t = validateThreshold(threshold);
    const flagged = t ? m.pairs.filter((p) => cmp[t.op](p.share_within_primary, t.value)) : [];
    return { measure, ...m, threshold, breached: flagged.length > 0, escalated: false, flagged, status: m.pairs.length ? 'ok' : 'empty', unit, window, basis };
  }
  const { breached, escalated } = judge(m.observed, threshold);
  return { measure, ...m, threshold, breached, escalated, status: m.observed == null && measure !== 'distribution' ? 'empty' : 'ok', unit, window, basis };
}

/**
 * Trend over measures recorded on earlier runs (`ctx`'s measure history) plus
 * this run. Needs at least `minWindows` points — ITSM-041 says three — or it
 * says so instead of extrapolating from two.
 */
export function trend(points, { minWindows = 3 } = {}) {
  const xs = points.filter((p) => p && Number.isFinite(p.value)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (xs.length < minWindows) return { status: 'insufficient_windows', windows: xs.length, required: minWindows, direction: null, slope: null };
  const n = xs.length;
  const meanX = (n - 1) / 2;
  const meanY = xs.reduce((s, p) => s + p.value, 0) / n;
  let num = 0; let den = 0;
  xs.forEach((p, i) => { num += (i - meanX) * (p.value - meanY); den += (i - meanX) ** 2; });
  const slope = den ? num / den : 0;
  return { status: 'ok', windows: n, direction: slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat', slope: Number(slope.toFixed(4)), first: xs[0].value, last: xs[n - 1].value };
}

/**
 * DECISION 2, stated once: the "expected" distribution IS the empirical one.
 * There is no reference model to compare against; a rule states a threshold on
 * an observed share (or leaves it UNCONFIGURED), and `evaluateMeasure` applies
 * it. Kept as a named export so a caller looking for a model finds this
 * sentence instead.
 */
export const EXPECTED_DISTRIBUTION = Object.freeze({ method: 'empirical', reference: 'DECISIONS.md §2' });

/**
 * A ratio of two server-side COUNTS — numerator query over denominator query,
 * optionally per group and optionally across two tables ("problems created /
 * incidents created"). Nothing is read but numbers. Returns
 * `{ status, rows: [{ group, numerator, denominator, percentage }], coverage }`.
 */
export async function countRatio(ctx, { table, numerator, denominator, group_by = [], windowClause = '' }) {
  const spec = (side) => (typeof side === 'string' ? { table, query: side } : { table: side?.table ?? table, query: side?.query ?? '' });
  const n = spec(numerator); const d = spec(denominator);
  const and = (...cs) => cs.filter(Boolean).join('^');
  const read = (sp) => ctx.reads.read(declareRequirement({ table: sp.table, query: and(sp.query, windowClause), strategy: 'aggregate', groupBy: group_by }));
  const [nr, dr] = await Promise.all([read(n), read(d)]);
  const coverage = [nr.coverage, dr.coverage];
  if (nr.coverage.status !== 'complete' || dr.coverage.status !== 'complete') return { status: 'unavailable', reason: `count over ${nr.coverage.status !== 'complete' ? n.table : d.table} failed`, rows: [], coverage };
  const key = (g) => group_by.map((f) => `${f}=${g.group[f] ?? ''}`).join('|');
  const num = new Map(nr.groups.map((g) => [key(g), g.count]));
  const rows = dr.groups.map((g) => ({ group: g.group, numerator: num.get(key(g)) || 0, denominator: g.count, percentage: g.count ? round1(100 * (num.get(key(g)) || 0) / g.count) : null }));
  if (!group_by.length && !rows.length) rows.push({ group: {}, numerator: nr.groups.reduce((x, g) => x + g.count, 0), denominator: 0, percentage: null });
  return { status: 'ok', rows, coverage };
}

/**
 * Engine contract. `rule.config`:
 *   { table, query, window, window_field, group_by[], avg[], sum[], measure, of/numerator/denominator (selectors), field,
 *     threshold {op,value,escalate_at}, minimum_volume, severity, escalated_severity, title, description,
 *     trend: { min_windows, direction }                      — judge the measure's run-to-run trend (ctx.measureHistory)
 *     numerator_query / denominator_query (+ group_by)        — the count-ratio path: percentage per group, one finding per breaching group }
 */
/** The judgement is on the TREND of the measure across runs (ctx.measureHistory), not on this run's value. */
function judgeTrend(rule, ctx, out, metric) {
  const c = rule.config;
  const key = c.measure_key || `${rule.id}:${metric.measure}`;
  const history = (ctx.measureHistory?.[key] || []).map((h) => ({ value: h.value, at: h.at }));
  const t = trend([...history, { value: metric.observed, at: ctx.run.run_started_at }], { minWindows: c.trend.min_windows ?? 3 });
  out.trend = t;
  out.measures[key] = { value: metric.observed, population: metric.population, at: ctx.run.run_started_at };
  if (t.status !== 'ok') { out.skipped.push({ rule: rule.id, table: c.table, reason: `trend needs ${t.required} windows, ${t.windows} recorded — no direction claimed` }); return out; }
  if (t.direction === c.trend.direction) {
    out.findings.push(aggregateFinding({ rule, table: c.table, metric: { ...metric, breached: true, basis: `${c.trend.direction} over ${t.windows} windows (${t.first} → ${t.last})` }, title: c.title || rule.title, description: c.description || rule.whatItMeans, severity: c.severity || rule.base, confidence: c.confidence ?? 1.0, recommendation: c.recommendation ?? null, collected_at: ctx.run.run_started_at }));
  }
  return out;
}

async function evaluateCountRatio(rule, ctx, windowClause) {
  const c = rule.config;
  const r = await countRatio(ctx, { table: c.table, numerator: c.numerator_query, denominator: c.denominator_query ?? c.query ?? '', group_by: c.group_by || [], windowClause });
  const out = result(rule, ENGINE_KEY, { coverage: r.coverage, parameters: ctx.parametersFor(rule.id) });
  if (r.status !== 'ok') { out.status = STATUS.UNAVAILABLE; out.skipped.push({ rule: rule.id, table: c.table, reason: r.reason }); return out; }
  out.ratios = r.rows;
  if (c.trend) {
    const row = r.rows[0];
    return judgeTrend(rule, ctx, out, { measure: 'percentage', observed: row?.percentage ?? null, population: row?.denominator ?? 0, count: row?.numerator ?? 0, percentage: row?.percentage ?? null, threshold: null, basis: c.basis ?? null });
  }
  const t = validateThreshold(c.threshold);
  let withheld = 0;
  for (const row of r.rows) {
    const keyName = c.measure_key || `${rule.id}:percentage`;
    const gk = Object.values(row.group).join('|');
    out.measures[gk ? `${keyName}[${gk}]` : keyName] = { value: row.percentage, population: row.denominator, at: ctx.run.run_started_at };
    if (!Object.keys(row.group).length || r.rows.length === 1) out.kpis.push({ rule_id: rule.id, numerator: row.denominator - row.numerator, denominator: row.denominator, pass_pct: row.percentage == null ? null : round1(100 - row.percentage), basis: c.basis ?? `${c.numerator_query} / ${c.denominator_query ?? c.query ?? 'all'}` });
    if (c.minimum_volume != null && row.denominator < c.minimum_volume) { withheld += 1; continue; }
    const { breached, escalated } = judge(row.percentage, t);
    if (breached) {
      out.findings.push(aggregateFinding({
        rule, table: c.table, group: row.group, metric: { measure: 'percentage', observed: row.percentage, threshold: t, breached, escalated, population: row.denominator, count: row.numerator, percentage: row.percentage, basis: c.basis ?? null, window: c.window ?? null },
        title: c.title || rule.title, description: c.description || rule.whatItMeans, severity: escalated && c.escalated_severity ? c.escalated_severity : (c.severity || rule.base), confidence: c.confidence ?? 1.0, recommendation: c.recommendation ?? null, collected_at: ctx.run.run_started_at,
      }));
    }
  }
  if (withheld) out.skipped.push({ rule: rule.id, table: c.table, reason: `${withheld} group(s) below the minimum volume ${c.minimum_volume} were not judged` });
  return out;
}

export const engine = Object.freeze({
  key: ENGINE_KEY,
  name: 'Aggregate & Distribution Engine',
  version: ENGINE_VERSION,
  canEvaluate: (rule) => rule?.architecture?.engine === 'aggregate' || rule?.architecture?.also_requires?.includes('aggregate'),
  prepare: async () => undefined,
  async evaluate(rule, ctx) {
    const c = rule.config;
    const gate = await preflight(rule, ENGINE_KEY, ctx, {
      requiredCapabilities: c ? [() => ctx.probes.readable(c.table)] : [],
      requiredParameters: c?.required_parameters || [],
    });
    if (gate) return gate;
    const windowClause = c.window ? `${c.window_field || 'sys_created_on'}>=${ctx.run.window(c.window).start_snow}` : '';
    if (c.numerator_query !== undefined) return evaluateCountRatio(rule, ctx, windowClause);
    const req = declareRequirement({ table: c.table, query: [c.query || '', windowClause].filter(Boolean).join('^'), strategy: 'aggregate', groupBy: c.group_by || [], avg: c.avg || [], sum: c.sum || [] });
    const { groups, coverage } = await ctx.reads.read(req);
    const out = result(rule, ENGINE_KEY, { coverage: [coverage], parameters: ctx.parametersFor(rule.id) });
    if (coverage.status !== 'complete') {
      out.status = STATUS.UNAVAILABLE;
      out.skipped.push({ rule: rule.id, table: c.table, reason: `aggregate over ${c.table} failed (${coverage.status}): ${coverage.error}` });
      return out;
    }
    const metric = evaluateMeasure(groups, {
      measure: c.measure, threshold: c.threshold, minimum_volume: c.minimum_volume, of: c.of, numerator: c.numerator, denominator: c.denominator,
      field: c.field, unit: c.unit, window: c.window ?? null, basis: c.basis ?? null,
      primary: c.primary ?? null, secondary: c.secondary ?? null, minimum_group_volume: c.minimum_group_volume ?? null,
    });
    out.measures[c.measure_key || `${rule.id}:${c.measure}`] = { value: metric.observed, population: metric.population, at: ctx.run.run_started_at };
    if (metric.population != null && ['ratio', 'percentage', 'share'].includes(c.measure)) {
      out.kpis.push({ rule_id: rule.id, numerator: metric.count ?? null, denominator: metric.population, pass_pct: metric.percentage != null ? round1(100 - metric.percentage) : null, basis: c.basis ?? c.measure });
    }
    if (metric.status === 'insufficient_volume') {
      out.skipped.push({ rule: rule.id, table: c.table, reason: `population ${metric.population} is below the minimum volume ${c.minimum_volume}` });
      return out;
    }
    if (c.trend) return judgeTrend(rule, ctx, out, metric);
    if (metric.breached) {
      out.findings.push(aggregateFinding({
        rule, table: c.table, metric, group: metric.group || {}, title: c.title || rule.title, description: c.description || rule.whatItMeans,
        severity: metric.escalated && c.escalated_severity ? c.escalated_severity : (c.severity || rule.base), confidence: c.confidence ?? 1.0,
        recommendation: c.recommendation ?? null, collected_at: ctx.run.run_started_at,
      }));
    }
    return out;
  },
});
