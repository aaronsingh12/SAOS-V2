import { declareRequirement } from '../data-access.js';
import { fromSnowTime, windowMs, parseWindow } from '../run-context.js';
import { crossDomainFinding, recordFinding } from '../findings.js';
import { expandSchedule } from '../schedules.js';
import { readConfiguration } from './configuration.js';
import { result, preflight, STATUS } from './result.js';

/**
 * ENGINE 7 — Temporal Correlation.
 *
 * Joins events across records or tables by a shared key (usually a CI) and a
 * time window, intersects intervals with schedule spans, and compares rates
 * before and after an anchor. Every window comes from the run context —
 * `ctx.run.window('72 hours')`, `ctx.run.around(eventTime, '30 minutes')` — so
 * two rules never disagree about when "now" was.
 *
 * The primitive is a KEY × TIME INDEX: rows bucketed by key and sorted by
 * time, built once for a table (`ctx.shared`) and probed by every rule that
 * correlates against it. "Changes on this CI in the 72 h before this incident"
 * is then a binary search per incident, not a scan per pair.
 */

export const ENGINE_KEY = 'temporal_correlation';
export const ENGINE_VERSION = '1.1.0';

export class TemporalError extends Error {
  constructor(message) { super(message); this.name = 'TemporalError'; }
}

/** Rows bucketed by `keyField`, each bucket sorted by `timeField` (ms). Rows without a key or time are counted, not indexed. */
export function createTimeIndex(rows, { keyField, timeField }) {
  const buckets = new Map();
  let skipped = 0;
  for (const r of rows) {
    const key = r[keyField];
    const t = fromSnowTime(r[timeField]);
    if (!key || !t) { skipped += 1; continue; }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ t: t.getTime(), row: r });
  }
  for (const b of buckets.values()) b.sort((a, b2) => a.t - b2.t);

  /** Rows for `key` with time in [from, to] (ms, inclusive). Binary search on the sorted bucket. */
  const between = (key, from, to) => {
    const b = buckets.get(key);
    if (!b) return [];
    let lo = 0; let hi = b.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (b[mid].t < from) lo = mid + 1; else hi = mid; }
    const out = [];
    for (let i = lo; i < b.length && b[i].t <= to; i++) out.push(b[i].row);
    return out;
  };

  return Object.freeze({ keyField, timeField, size: rows.length - skipped, skipped, keys: () => [...buckets.keys()], between, bucket: (k) => (buckets.get(k) || []).map((x) => x.row) });
}

/**
 * Window join: for each left row, the right rows sharing its key whose time
 * falls in the window before (or after) the left row's time. `expandKeys`
 * lets a rule widen the match to dependent CIs (from the graph engine).
 *
 * Returns pairs `{ left, right, key, delta_ms }` and the count of left rows
 * that had no time / key.
 */
export function windowJoin(leftRows, rightIndex, { keyField, timeField, window, direction = 'before', expandKeys = null } = {}) {
  const span = windowMs(window);
  const pairs = [];
  let unmatched = 0; let unevaluable = 0;
  for (const l of leftRows) {
    const key = l[keyField];
    const t = fromSnowTime(l[timeField]);
    if (!key || !t) { unevaluable += 1; continue; }
    const keys = expandKeys ? [key, ...expandKeys(key)] : [key];
    const [from, to] = direction === 'before' ? [t.getTime() - span, t.getTime()] : [t.getTime(), t.getTime() + span];
    let any = false;
    for (const k of keys) {
      for (const r of rightIndex.between(k, from, to)) {
        const rt = fromSnowTime(r[rightIndex.timeField]).getTime();
        pairs.push({ left: l, right: r, key: k, via_dependent: k !== key, delta_ms: direction === 'before' ? t.getTime() - rt : rt - t.getTime() });
        any = true;
      }
    }
    if (!any) unmatched += 1;
  }
  return { pairs, matched: leftRows.length - unmatched - unevaluable, unmatched, unevaluable, window: parseWindow(window), direction };
}

/** Do two closed intervals [a1,a2] and [b1,b2] (ms) overlap? Touching endpoints count as overlap. */
export const intervalsIntersect = (a1, a2, b1, b2) => a1 <= b2 && b1 <= a2;

/**
 * Which spans each interval intersects. `intervals: [{ id, start, end }]`
 * (snow times or Dates), `spans: [{ id, start, end }]`. Spans that are not
 * concrete (a repeating schedule span not expanded) are reported separately
 * and never matched — an unexpanded rule is not a window.
 */
export function intervalIntersections(intervals, spans) {
  const ms = (v) => (v instanceof Date ? v : fromSnowTime(v))?.getTime() ?? null;
  const concrete = []; const unexpanded = [];
  for (const s of spans) {
    const a = ms(s.start); const b = ms(s.end);
    if (a == null || b == null || s.expanded === false) unexpanded.push(s); else concrete.push({ ...s, a, b });
  }
  /*
   * DECISION 9: a span that is not a concrete interval (a recurrence left
   * unexpanded, or missing bounds) makes the answer UNAVAILABLE. "0 hits"
   * from a schedule we could not place on the timeline would read as "no
   * blackout" — the one reading this function must never produce.
   */
  if (unexpanded.length) {
    return { status: 'unavailable', reason: `${unexpanded.length} schedule span(s) are not concrete intervals (unexpanded recurrence or missing bounds) — intersections cannot be claimed`, hits: [], unevaluable: 0, unexpanded_spans: unexpanded.length };
  }
  const hits = [];
  let unevaluable = 0;
  for (const iv of intervals) {
    const a = ms(iv.start); const b = ms(iv.end);
    if (a == null || b == null) { unevaluable += 1; continue; }
    for (const s of concrete) if (intervalsIntersect(a, b, s.a, s.b)) hits.push({ interval: iv, span: s, overlap_ms: Math.min(b, s.b) - Math.max(a, s.a) });
  }
  return { status: 'ok', reason: null, hits, unevaluable, unexpanded_spans: 0 };
}

/**
 * Schedules of a type (blackout, maintenance …), expanded over the analysis
 * window. `unavailable` when any schedule could not be fully expanded or the
 * schedules could not be read; `none_defined` when no schedule of that type
 * exists — the calling rule says what that means (ITSM-085 reports it).
 */
export async function expandedSchedules(ctx, { table = 'cmn_schedule', type = null, window, dayCodeBase = 1 } = {}) {
  const cfg = await readConfiguration(ctx, 'schedule', { table, type, withSpans: true });
  if (cfg.status !== 'ok') return { status: 'unavailable', reason: `schedules could not be read: ${cfg.reason}`, intervals: [], schedules: 0, coverage: cfg.coverage };
  if (cfg.spans_status && cfg.spans_status !== 'ok') return { status: 'unavailable', reason: 'schedule spans could not be read', intervals: [], schedules: cfg.rows.length, coverage: cfg.coverage };
  const intervals = []; const problems = [];
  for (const sched of cfg.rows) {
    const ex = expandSchedule(sched, { window, dayCodeBase });
    if (ex.status !== 'ok') problems.push({ schedule: sched.sys_id, name: sched.name, reason: ex.reason });
    intervals.push(...ex.intervals);
  }
  if (problems.length) return { status: 'unavailable', reason: `${problems.length} schedule(s) could not be expanded: ${problems.map((x) => `${x.name ?? x.schedule}: ${x.reason}`).join('; ')}`, intervals: [], schedules: cfg.rows.length, problems, coverage: cfg.coverage };
  return { status: cfg.rows.length ? 'ok' : 'none_defined', reason: cfg.rows.length ? null : `no schedules are defined in ${table}${type ? ` of type "${type}"` : ''}`, intervals, schedules: cfg.rows.length, coverage: cfg.coverage };
}

/**
 * ITSM-112 / 127 shape: records with an interval [start_field, end_field]
 * intersected with the expanded spans of every schedule of `schedule_type`.
 *   { mode: 'schedule_intersection', table, scope, start_field, end_field, schedule_type, analysis_window,
 *     evidence_fields[], severity, title, description }
 */
async function evaluateScheduleIntersection(rule, ctx) {
  const c = rule.config;
  const gate = await preflight(rule, ENGINE_KEY, ctx, {
    requiredCapabilities: [() => ctx.probes.fieldsExist(c.table, [c.start_field, c.end_field]), () => ctx.probes.readable(c.schedule_table ?? 'cmn_schedule'), () => ctx.probes.readable('cmn_schedule_span')],
    requiredParameters: c.required_parameters || [],
  });
  if (gate) return gate;
  const out = result(rule, ENGINE_KEY, { coverage: [], parameters: ctx.parametersFor(rule.id) });
  /* The analysis window: the rule's, or — when it declares none — the extent of the records' own intervals. */
  let window = c.analysis_window ? ctx.run.window(c.analysis_window) : null;
  let src = null;
  if (!window) {
    src = await ctx.reads.read(declareRequirement({ table: c.table, fields: [c.start_field, c.end_field, ...(c.evidence_fields || [])], query: c.scope || '', strategy: 'rows' }));
    out.coverage.push(src.coverage);
    if (!['complete', 'limited', 'truncated'].includes(src.coverage.status)) { out.status = STATUS.UNAVAILABLE; out.skipped.push({ rule: rule.id, table: c.table, reason: `${c.table} could not be read (${src.coverage.status})` }); return out; }
    const times = src.rows.flatMap((r) => [fromSnowTime(r[c.start_field]), fromSnowTime(r[c.end_field])]).filter(Boolean).map((d) => d.getTime());
    if (!times.length) { out.kpis.push({ rule_id: rule.id, numerator: 0, denominator: 0, pass_pct: null, basis: 'no records with interval bounds' }); return out; }
    window = { start: new Date(Math.min(...times)), end: new Date(Math.max(...times)), label: 'extent of the records', spec: null };
  }
  const sched = await expandedSchedules(ctx, { table: c.schedule_table ?? 'cmn_schedule', type: c.schedule_type ?? null, window, dayCodeBase: c.day_code_base ?? 1 });
  if (sched.coverage) out.coverage.push(sched.coverage);
  if (sched.status !== 'ok') {
    /* unavailable, or none defined — the workbook: "requires blackout windows to be defined; report ITSM-085 where they are not". */
    out.status = STATUS.UNAVAILABLE;
    out.skipped.push({ rule: rule.id, table: 'cmn_schedule', reason: sched.status === 'none_defined' ? `${sched.reason} — see ITSM-085` : sched.reason, capability: 'UNAVAILABLE' });
    return out;
  }
  if (!src) {
    src = await ctx.reads.read(declareRequirement({ table: c.table, fields: [c.start_field, c.end_field, ...(c.evidence_fields || [])], query: c.scope || '', strategy: 'rows' }));
    out.coverage.push(src.coverage);
    if (!['complete', 'limited', 'truncated'].includes(src.coverage.status)) {
      out.status = STATUS.UNAVAILABLE;
      out.skipped.push({ rule: rule.id, table: c.table, reason: `${c.table} could not be read (${src.coverage.status})` });
      return out;
    }
  }
  const intervals = src.rows.map((r) => ({ id: r.sys_id, start: r[c.start_field], end: r[c.end_field], row: r }));
  const x = intervalIntersections(intervals, sched.intervals);
  if (x.status !== 'ok') { out.status = STATUS.UNAVAILABLE; out.skipped.push({ rule: rule.id, table: 'cmn_schedule', reason: x.reason }); return out; }
  if (x.unevaluable) out.skipped.push({ rule: rule.id, table: c.table, reason: 'rows without both interval bounds could not be checked', excluded_records: x.unevaluable });
  const offenders = [...new Map(x.hits.map((h) => [h.interval.id, h.interval.row])).values()];
  if (offenders.length) {
    out.findings.push(recordFinding({
      rule, table: c.table, records: offenders, fields: [c.start_field, c.end_field, ...(c.evidence_fields || [])], title: c.title || rule.title, description: c.description || rule.whatItMeans,
      severity: c.severity || rule.base, confidence: c.confidence ?? 1.0, recommendation: c.recommendation ?? null, collected_at: ctx.run.run_started_at,
    }));
  }
  const evaluated = intervals.length - x.unevaluable;
  out.kpis.push({ rule_id: rule.id, numerator: evaluated - offenders.length, denominator: evaluated, pass_pct: evaluated ? Number((100 * (1 - offenders.length / evaluated)).toFixed(1)) : null, basis: `${sched.schedules} ${c.schedule_table ?? c.schedule_type ?? 'cmn_schedule'} schedule(s) expanded to ${sched.intervals.length} interval(s) over ${window.label}` });
  return out;
}

/**
 * Before/after: count events in the window before an anchor and the window
 * after it. `{ before, after, change, complete }` — `complete` is false when
 * the after-window has not fully elapsed at the run anchor (ITSM-074's guard:
 * do not evaluate before the full window has passed).
 */
export function beforeAfter(events, { timeField, anchor, window, now }) {
  const span = windowMs(window);
  const t0 = (anchor instanceof Date ? anchor : fromSnowTime(anchor))?.getTime();
  if (t0 == null) throw new TemporalError('before/after needs an anchor time');
  const nowMs = (now instanceof Date ? now : fromSnowTime(now))?.getTime() ?? Date.now();
  let before = 0; let after = 0;
  for (const e of events) {
    const t = fromSnowTime(e[timeField])?.getTime();
    if (t == null) continue;
    if (t >= t0 - span && t < t0) before += 1;
    else if (t >= t0 && t <= t0 + span) after += 1;
  }
  const complete = nowMs >= t0 + span;
  return { before, after, change: before ? Number(((after - before) / before).toFixed(4)) : null, complete, window: parseWindow(window) };
}

/** Build (once per run) the shared index for a table's rows. */
export async function sharedIndex(ctx, { table, query = '', keyField, timeField, fields = [] }) {
  return ctx.shared.getOrBuild(`time_index:${table}:${query}:${keyField}:${timeField}`, async () => {
    const { rows, coverage } = await ctx.reads.read(declareRequirement({ table, fields: [keyField, timeField, ...fields], query, strategy: 'rows' }));
    return { index: createTimeIndex(rows, { keyField, timeField }), coverage };
  });
}

/**
 * ITSM-074 shape: for every left record (a closed problem) the right-hand
 * events keyed to it (its incidents) are counted in the window before and
 * after the anchor time; the record offends when the change from before to
 * after is not at least the required decline. Anchors whose after-window
 * has not fully elapsed are not judged (the workbook's own guard).
 *   { mode: 'before_after', left: {table, query, time_field, fields[]}, right: {table, query, key_field, time_field},
 *     window, required_decline (fraction 0–1), evidence_fields[], severity, title, description }
 */
async function evaluateBeforeAfter(rule, ctx) {
  const c = rule.config;
  const gate = await preflight(rule, ENGINE_KEY, ctx, {
    requiredCapabilities: [() => ctx.probes.fieldsExist(c.left.table, [c.left.time_field]), () => ctx.probes.fieldsExist(c.right.table, [c.right.key_field, c.right.time_field])],
    requiredParameters: c.required_parameters || [],
  });
  if (gate) return gate;
  const right = await sharedIndex(ctx, { table: c.right.table, query: c.right.query || '', keyField: c.right.key_field, timeField: c.right.time_field });
  const left = await ctx.reads.read(declareRequirement({ table: c.left.table, fields: [c.left.time_field, ...(c.left.fields || []), ...(c.evidence_fields || [])], query: c.left.query || '', strategy: 'rows' }));
  const out = result(rule, ENGINE_KEY, { coverage: [left.coverage, right.coverage], parameters: ctx.parametersFor(rule.id) });
  const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov.status);
  if (!usable(left.coverage) || !usable(right.coverage)) {
    out.status = STATUS.UNAVAILABLE;
    const bad = usable(left.coverage) ? right.coverage : left.coverage;
    out.skipped.push({ rule: rule.id, table: bad.table, reason: `${bad.table} could not be read (${bad.status})` });
    return out;
  }
  const offenders = []; let notElapsed = 0; let unevaluable = 0; let judged = 0;
  const details = {};
  for (const l of left.rows) {
    const anchor = fromSnowTime(l[c.left.time_field]);
    if (!anchor) { unevaluable += 1; continue; }
    const events = right.index.between(l.sys_id, -Infinity, Infinity);
    const ba = beforeAfter(events, { timeField: c.right.time_field, anchor, window: c.window, now: ctx.run.now });
    if (!ba.complete) { notElapsed += 1; continue; }
    judged += 1;
    details[l.sys_id] = { before: ba.before, after: ba.after, change: ba.change };
    /* "not declining": after ≥ before × (1 − required_decline); a record with nothing before has nothing to decline from. */
    if (ba.before > 0 && ba.after >= ba.before * (1 - c.required_decline)) offenders.push({ ...l, incidents_before: ba.before, incidents_after: ba.after });
  }
  if (unevaluable) out.skipped.push({ rule: rule.id, table: c.left.table, reason: 'rows without an anchor time could not be evaluated', excluded_records: unevaluable });
  if (notElapsed) out.skipped.push({ rule: rule.id, table: c.left.table, reason: `the after-window (${c.window}) has not fully elapsed`, excluded_records: notElapsed });
  if (offenders.length) {
    out.findings.push(recordFinding({ rule, table: c.left.table, records: offenders, fields: [...(c.evidence_fields || []), 'incidents_before', 'incidents_after'], title: c.title || rule.title, description: c.description || rule.whatItMeans, severity: c.severity || rule.base, confidence: c.confidence ?? 1.0, recommendation: c.recommendation ?? null, collected_at: ctx.run.run_started_at }));
  }
  out.before_after = details;
  out.kpis.push({ rule_id: rule.id, numerator: judged - offenders.length, denominator: judged, pass_pct: judged ? Number((100 * (1 - offenders.length / judged)).toFixed(1)) : null, basis: `${c.right.table} per ${c.left.table} in ${c.window} before vs after; required decline ${Math.round(c.required_decline * 100)}%` });
  return out;
}

/**
 * Engine contract. `rule.config`:
 *   { left: {table, query, key_field, time_field, fields[]}, right: {table, query, key_field, time_field, fields[]},
 *     window, direction, expand_keys (fn key → [keys], or { prepare(ctx, keys) → fn } built once the left keys are known),
 *     offend: 'matched'|'unmatched', report_ratio, related_domain, severity, title, description }
 *
 * The matched pairs are kept on the result (`out.pairs`: left id, right id,
 * key, via_dependent, delta_ms, and the two rows) so a composite rule
 * (ITSM-124 / 125 over ITSM-123) re-aggregates them without a second read.
 */
export const engine = Object.freeze({
  key: ENGINE_KEY,
  name: 'Temporal Correlation Engine',
  version: ENGINE_VERSION,
  canEvaluate: (rule) => rule?.architecture?.engine === ENGINE_KEY || rule?.architecture?.also_requires?.includes(ENGINE_KEY),
  prepare: async () => undefined,
  async evaluate(rule, ctx) {
    const c = rule.config;
    if (c?.mode === 'schedule_intersection') return evaluateScheduleIntersection(rule, ctx);
    if (c?.mode === 'before_after') return evaluateBeforeAfter(rule, ctx);
    const gate = await preflight(rule, ENGINE_KEY, ctx, {
      requiredCapabilities: c ? [() => ctx.probes.fieldsExist(c.left.table, [c.left.key_field, c.left.time_field]), () => ctx.probes.fieldsExist(c.right.table, [c.right.key_field, c.right.time_field])] : [],
      requiredParameters: c?.required_parameters || [],
    });
    if (gate) return gate;
    const right = await sharedIndex(ctx, { table: c.right.table, query: c.right.query || '', keyField: c.right.key_field, timeField: c.right.time_field, fields: c.right.fields || [] });
    const left = await ctx.reads.read(declareRequirement({ table: c.left.table, fields: [c.left.key_field, c.left.time_field, ...(c.left.fields || [])], query: c.left.query || '', strategy: 'rows' }));
    const out = result(rule, ENGINE_KEY, { coverage: [left.coverage, right.coverage], parameters: ctx.parametersFor(rule.id) });
    const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov.status);
    if (!usable(left.coverage) || !usable(right.coverage)) {
      out.status = STATUS.UNAVAILABLE;
      const bad = usable(left.coverage) ? right.coverage : left.coverage;
      out.skipped.push({ rule: rule.id, table: bad.table, reason: `${bad.table} could not be read (${bad.status})` });
      return out;
    }
    let expandKeys = c.expand_keys || null;
    if (expandKeys && typeof expandKeys !== 'function') {
      /* DECISION 11: the expander (dependent CIs) is built over the left rows' keys only, never the whole graph. */
      const prepared = await expandKeys.prepare(ctx, [...new Set(left.rows.map((r) => r[c.left.key_field]).filter(Boolean))]);
      if (prepared.status && prepared.status !== 'ok') {
        out.status = STATUS.UNAVAILABLE;
        out.skipped.push({ rule: rule.id, table: 'cmdb_rel_ci', reason: prepared.reason });
        if (prepared.coverage) out.coverage.push(prepared.coverage);
        return out;
      }
      if (prepared.coverage) out.coverage.push(prepared.coverage);
      expandKeys = prepared.expand ?? prepared;
    }
    const joined = windowJoin(left.rows, right.index, { keyField: c.left.key_field, timeField: c.left.time_field, window: c.window, direction: c.direction || 'before', expandKeys });
    out.pairs = joined.pairs.map((p) => ({ left: p.left.sys_id, right: p.right.sys_id, key: p.key, via_dependent: p.via_dependent, delta_ms: p.delta_ms, left_row: p.left, right_row: p.right }));
    const offenders = c.offend === 'unmatched'
      ? left.rows.filter((l) => !joined.pairs.some((p) => p.left === l))
      : [...new Set(joined.pairs.map((p) => p.left))];
    if (joined.unevaluable) out.skipped.push({ rule: rule.id, table: c.left.table, reason: 'rows without a key or a time could not be correlated', excluded_records: joined.unevaluable });
    if (offenders.length) {
      out.findings.push(crossDomainFinding({
        rule, table: c.left.table, records: offenders.map((r) => ({ sys_id: r.sys_id, field: c.left.key_field, value: r[c.left.key_field] })),
        related_domain: c.related_domain || 'ITSM', provenance: { window: joined.window, direction: joined.direction, right_table: c.right.table, pairs: joined.pairs.length, expanded_keys: Boolean(c.expand_keys) },
        title: c.title || rule.title, description: c.description || rule.whatItMeans, severity: c.severity || rule.base, confidence: c.confidence ?? 1.0,
        recommendation: c.recommendation ?? null, collected_at: ctx.run.run_started_at,
      }));
    }
    const evaluated = left.rows.length - joined.unevaluable;
    out.kpis.push({ rule_id: rule.id, numerator: evaluated - offenders.length, denominator: evaluated, pass_pct: evaluated ? Number((100 * (1 - offenders.length / evaluated)).toFixed(1)) : null, basis: `${c.left.table} ${c.offend === 'unmatched' ? 'not ' : ''}correlated with ${c.right.table} within ${c.window} ${c.direction || 'before'} (${joined.matched} matched)`, complete: left.coverage.rowsComplete && right.coverage.rowsComplete });
    return out;
  },
});
