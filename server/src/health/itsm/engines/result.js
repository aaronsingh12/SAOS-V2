import { skip as makeSkip } from '../findings.js';
import { canRun } from '../capability.js';

/**
 * ITSM PHASE 3 — the one result shape every engine returns, and the checks
 * every engine performs before it does anything.
 *
 *   status      evaluated | skipped | not_configured
 *   findings    extended findings (findings.js)
 *   kpis        { rule_id, pass_pct, numerator, denominator, basis } — the
 *               measure whether or not a threshold was breached, so a rule
 *               that PASSES still leaves a trace
 *   skipped     { rule, table, reason, capability?, parameter? } — same
 *               vocabulary as EstateRules.skipped[]
 *   coverage    every read the evaluation depended on
 *   measures    run-to-run snapshots for trended rules
 *
 * `not_configured` is the Phase 3 answer for every catalogue rule: the engine
 * exists, the rule's engine configuration does not yet. It is a status, not
 * an error, so a registry sweep can list what remains to be configured.
 */

/**
 * DECISION 3 / 5 — three non-evaluated states, kept apart because they are
 * fixed by different people:
 *   not_configured  no engine configuration for the rule (a build gap)
 *   unconfigured    a required parameter has no value (an instance decision)
 *   unavailable     the instance cannot answer (object, field, audit, read)
 * None of them is a pass, and none produces a finding. `error` is an engine
 * or configuration fault caught by the runner — reported, never a pass.
 */
export const STATUS = Object.freeze({ EVALUATED: 'evaluated', SKIPPED: 'skipped', NOT_CONFIGURED: 'not_configured', UNCONFIGURED: 'unconfigured', UNAVAILABLE: 'unavailable', ERROR: 'error' });

export function result(rule, engine, over = {}) {
  return {
    rule_id: rule.id,
    engine,
    status: STATUS.EVALUATED,
    findings: [],
    kpis: [],
    skipped: [],
    coverage: [],
    measures: {},
    parameters: null,
    capability: null,
    ...over,
  };
}

export function notConfigured(rule, engine, reason = 'no engine configuration for this rule (Phase 4)') {
  return result(rule, engine, { status: STATUS.NOT_CONFIGURED, skipped: [makeSkip(rule, { reason })] });
}

export function skipped(rule, engine, reason, extra = {}) {
  return result(rule, engine, { status: STATUS.SKIPPED, skipped: [makeSkip(rule, { reason, ...extra })], ...extra.result });
}

/**
 * The gate every engine runs first: configuration present, capability
 * AVAILABLE (or PARTIAL when tolerated), parameters resolved. Returns null
 * when the rule may proceed, or the result to return instead.
 */
export async function preflight(rule, engine, ctx, { requiredCapabilities = [], allowPartial = false, requiredParameters = [] } = {}) {
  if (!rule.config) return notConfigured(rule, engine);
  const verdicts = [];
  for (const probe of requiredCapabilities) verdicts.push(await probe());
  if (verdicts.length) {
    const combined = ctx.probes.combine(verdicts);
    if (!canRun(combined, { allowPartial })) {
      const out = skipped(rule, engine, `capability ${combined.state}: ${combined.reason}`, { capability: combined.state, result: { capability: combined } });
      out.status = STATUS.UNAVAILABLE;
      return out;
    }
  }
  const params = ctx.parametersFor(rule.id);
  if (params.status === 'UNCONFIGURED' && params.reason === 'undeclared' && requiredParameters.length) {
    const out = skipped(rule, engine, `parameters for ${rule.id} are UNCONFIGURED (no declaration transcribed) — workbook: "${params.workbook_text}"`, { parameter: requiredParameters.join(','), result: { parameters: params } });
    out.status = STATUS.UNCONFIGURED;
    return out;
  }
  const missing = requiredParameters.filter((k) => params.parameters[k]?.status !== 'RESOLVED');
  if (missing.length) {
    const out = skipped(rule, engine, `parameter ${missing.join(', ')} is UNCONFIGURED — the workbook gives no default and no instance override is set`, { parameter: missing.join(','), result: { parameters: params } });
    out.status = STATUS.UNCONFIGURED;
    return out;
  }
  return null;
}

/**
 * PHASE 5 CLOSURE — EMPTY POPULATION. "No offender" is a PASS only when
 * something was judged. Every evaluated result declares the population its
 * judgement was over:
 *
 *   population    { total, judged, unit, basis }
 *     total       what is in the rule's scope (records, fields, input rules …);
 *                 null when it was not counted
 *     judged      how many of those the detection could answer for
 *     unit        what one of them is
 *     basis       the scope, in words
 *   undetermined  { kind, reason } — set when the engine withheld its judgement
 *                 over a population that was there (UNDETERMINED below)
 *
 * The runner decides the verdict from it in one place (runner.js verdictOf):
 * an evaluated result with no finding is `inconclusive` — never `pass` — when
 * `judged` is 0, when `undetermined` is set, or when no population was declared
 * at all. A finding is still a finding: the population contract never turns an
 * offender into a pass, and never turns "nothing to judge" into a FAIL.
 *
 * Kept apart from the non-evaluated states on purpose: an empty population is
 * a fact about the data (the table was read and holds nothing in scope), not
 * UNAVAILABLE (the instance could not answer) and not UNCONFIGURED (a
 * parameter has no value).
 *
 * `determinate_when_empty` is the one exception, declared per detection shape
 * where the workbook makes an empty CONFIGURATION population itself the
 * answer ("fires only where routing rules reference the fields": no rule
 * references them, nothing can be routed on an empty field). It is a string
 * naming that reading, never a default.
 */
export const UNDETERMINED = Object.freeze({
  EMPTY_POPULATION: 'empty_population',        // nothing in scope
  NOTHING_JUDGEABLE: 'nothing_judgeable',      // records in scope, none the detection could answer for
  BELOW_MINIMUM_VOLUME: 'below_minimum_volume', // DECISION 2: small populations are not judged
  INSUFFICIENT_HISTORY: 'insufficient_history', // a trend without its minimum windows
  POPULATION_UNKNOWN: 'population_unknown',    // the population count itself failed
  INPUT_INCONCLUSIVE: 'input_inconclusive',    // a composite over an input that established nothing
  POPULATION_UNDECLARED: 'population_undeclared', // the engine path declared no population — fail-safe
});

/** Declare what the result judged (see above). Returns `out`. */
export function notePopulation(out, { total = null, judged = total, unit = 'records', basis = null, determinate_when_empty = null } = {}) {
  out.population = Object.freeze({ total, judged, unit, basis, ...(determinate_when_empty ? { determinate_when_empty } : {}) });
  return out;
}

/** Withhold the judgement over a population that was there. Returns `out`. */
export function withhold(out, kind, reason) {
  if (!Object.values(UNDETERMINED).includes(kind)) throw new Error(`undetermined kind "${kind}" is not one of ${Object.values(UNDETERMINED).join(', ')}`);
  out.undetermined = Object.freeze({ kind, reason });
  return out;
}

/**
 * Why an evaluated result with no finding establishes nothing — `{ kind, reason }`
 * — or null when its "no finding" is a real pass. The single reading the runner
 * and the integration layer share.
 */
export function undeterminedOf(res) {
  if (!res || res.status !== STATUS.EVALUATED) return null;
  if (res.undetermined) return res.undetermined;
  const p = res.population;
  if (!p) return { kind: UNDETERMINED.POPULATION_UNDECLARED, reason: 'the evaluation declared no population, so "no finding" cannot be read as healthy' };
  if (p.judged === 0 || p.judged == null) {
    if (p.total === 0 && p.determinate_when_empty) return null;
    if (p.total == null && p.judged == null) return { kind: UNDETERMINED.POPULATION_UNKNOWN, reason: `the population${p.basis ? ` (${p.basis})` : ''} could not be counted` };
    if (p.total === 0 || p.total == null) return { kind: UNDETERMINED.EMPTY_POPULATION, reason: `no ${p.unit} in scope${p.basis ? ` (${p.basis})` : ''}` };
    return { kind: UNDETERMINED.NOTHING_JUDGEABLE, reason: `${p.total} ${p.unit} in scope${p.basis ? ` (${p.basis})` : ''}, none of which the detection could answer for` };
  }
  return null;
}

/** Value helpers shared by the engines. */
export const empty = (v) => v === undefined || v === null || String(v).trim() === '';
export const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
