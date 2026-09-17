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

/** Value helpers shared by the engines. */
export const empty = (v) => v === undefined || v === null || String(v).trim() === '';
export const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
