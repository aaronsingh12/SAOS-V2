import crypto from 'node:crypto';
import { ITSM_RULE_CONFIGS } from './rules/index.js';
import { ITSM_PARAMETERS } from './parameters.js';
import { ITSM_ENGINE_REGISTRY } from './registry.js';

/**
 * ITSM MEASURE HISTORY — what a trend rule needs from earlier scans.
 *
 * A trend cannot be read from one scan (ITSM-041: "Requires at least 3
 * windows"). The aggregate engine already asks `ctx.measureHistory[key]` for
 * earlier readings of a measure and says "no direction claimed" without them;
 * nothing supplied them, so the rule could never be judged. This module is the
 * supply, built to the rules the Phase 5 decision set for it:
 *
 *   PER BOUND INSTANCE   readings come only from runs stored for the instance
 *                        this scan is bound to (store.js reads by instance_key).
 *   ONLY REAL READINGS   a reading is a value a scan measured and stored in
 *                        `manifest.itsm.measures`. Nothing is back-filled, and a
 *                        verification run (nothing re-read) adds no reading.
 *   COMPARABLE ONLY      every reading carries a comparability key: the rule's
 *                        configuration, the parameter values it resolved, the
 *                        engine and its version, and the measure key. A reading
 *                        taken under any other key is SET ASIDE and counted —
 *                        never compared — so a changed threshold, window or
 *                        engine starts a new series instead of bending the old.
 *   TIME, EXPLICITLY     `at` is the run anchor in UTC (ISO 8601); `window` is
 *                        the rule's declared analysis window, or null when the
 *                        rule declares none (the reading is then over the rule's
 *                        whole scope at that anchor, and the record says so).
 *   NOT DEGRADED         a run whose ITSM reads failed contributes nothing.
 *
 * Pure: the store reads the runs, this shapes and filters them.
 */

export const MEASURE_HISTORY_VERSION = '1.0.0';

const ruleOfMeasure = (key) => /^(ITSM-\d{3})\b/.exec(String(key))?.[1] ?? null;

/** The comparability key of one rule's measures under this scan's configuration and parameters. */
export function measureComparability(ruleId, { configs = ITSM_RULE_CONFIGS, parameters = ITSM_PARAMETERS, runtime = {} } = {}) {
  const entry = configs.get(ruleId);
  if (!entry) return null;
  const resolved = parameters.resolve(ruleId, { runtime: runtime[ruleId] || {} });
  const params = Object.fromEntries(Object.entries(resolved.parameters || {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, p]) => [k, { value: p.value ?? null, unit: p.unit ?? null, status: p.status }]));
  const engine = ITSM_ENGINE_REGISTRY[entry.engine];
  const basis = { history: MEASURE_HISTORY_VERSION, rule_id: ruleId, engine: entry.engine, engine_version: engine?.version ?? null, config: entry.config, parameters: params };
  return crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0, 16);
}

/**
 * The readings this scan measured, ready to store in `manifest.itsm.measures`.
 * One entry per measure key a rule recorded (variants keep their `[label]`).
 */
export function collectMeasures(run, { configs = ITSM_RULE_CONFIGS, parameters = ITSM_PARAMETERS, runtime = {}, timezone = 'UTC' } = {}) {
  const out = {};
  const keys = new Map();
  for (const [id, res] of run.results) {
    if (res.status !== 'evaluated' || !res.measures) continue;
    if (!keys.has(id)) keys.set(id, measureComparability(id, { configs, parameters, runtime }));
    const cfg = configs.get(id)?.config || {};
    for (const [key, m] of Object.entries(res.measures)) {
      if (!m || m.value === undefined) continue;
      out[key] = Object.freeze({
        rule_id: id,
        value: typeof m.value === 'number' && Number.isFinite(m.value) ? m.value : null,
        population: m.population ?? null,
        at: m.at ?? null,
        timezone,
        window: cfg.window ? JSON.parse(JSON.stringify(cfg.window)) : null,
        basis: cfg.basis ?? null,
        comparability: keys.get(id),
      });
    }
  }
  return out;
}

/** Is a stored run a source of ITSM readings? `{ ok, reason }`. */
export function itsmSnapshotEligibility(run) {
  const m = run?.manifest;
  if (!m) return { ok: false, reason: 'no manifest' };
  if (!['completed', 'partial'].includes(run.status)) return { ok: false, reason: `run ${run.status}` };
  if (m.kind === 'verification') return { ok: false, reason: 'a verification re-reads nothing, so it measures nothing' };
  if (!m.itsm) return { ok: false, reason: 'ITSM was not scanned' };
  if (!m.itsm.measures) return { ok: false, reason: 'scanned before ITSM measures were stored' };
  if (m.degraded?.itsm?.length) return { ok: false, reason: 'ITSM reads failed in that run' };
  return { ok: true, reason: null };
}

/**
 * Stored runs (newest first, as the store reads them) → every reading per
 * measure key, OLDEST FIRST, each with its run and comparability key.
 */
export function historyFromRuns(runs) {
  const readings = {};
  const excluded = [];
  for (const run of runs) {
    const e = itsmSnapshotEligibility(run);
    if (!e.ok) { excluded.push({ run_id: run.id, reason: e.reason }); continue; }
    for (const [key, m] of Object.entries(run.manifest.itsm.measures)) {
      (readings[key] ||= []).push({ run_id: run.id, value: m.value, population: m.population ?? null, at: m.at, comparability: m.comparability ?? null, window: m.window ?? null });
    }
  }
  for (const list of Object.values(readings)) list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { readings, excluded };
}

/**
 * What THIS scan's trend rules may compare with: readings taken strictly before
 * `now`, with a value, under the SAME comparability key. Everything else is
 * counted as set aside, with why.
 */
export function historyForScan(history, { configs = ITSM_RULE_CONFIGS, parameters = ITSM_PARAMETERS, runtime = {}, now = new Date() } = {}) {
  const measureHistory = {};
  const used = {};
  const setAside = {};
  const keys = new Map();
  const cutoff = now.toISOString();
  for (const [key, list] of Object.entries(history?.readings || {})) {
    const rule = ruleOfMeasure(key);
    if (!rule) continue;
    if (!keys.has(rule)) keys.set(rule, measureComparability(rule, { configs, parameters, runtime }));
    const want = keys.get(rule);
    const keep = [];
    const aside = { other_model: 0, no_value: 0, not_earlier: 0 };
    for (const r of list) {
      if (!(String(r.at) < cutoff)) { aside.not_earlier += 1; continue; }
      if (r.value == null) { aside.no_value += 1; continue; }
      if (!want || r.comparability !== want) { aside.other_model += 1; continue; }
      keep.push({ value: r.value, at: r.at });
    }
    if (keep.length) { measureHistory[key] = Object.freeze(keep); used[key] = keep.length; }
    const n = aside.other_model + aside.no_value + aside.not_earlier;
    if (n) setAside[key] = { count: n, ...aside };
  }
  return { measureHistory: Object.freeze(measureHistory), used, set_aside: setAside, excluded_runs: (history?.excluded || []).length };
}
