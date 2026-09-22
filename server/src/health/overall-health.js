import crypto from 'node:crypto';
import { FAILED_READ_STATUSES } from './extract.js';

/**
 * OVERALL HEALTH — the Full System Scan's one number, and what sits beside it.
 *
 * PURE. Module summaries in; the overall scope out. No socket, no database.
 *
 * ═══ THE DEFINITION (locked 21 Sep 2026) ═══
 *
 *   Overall Health is the weighted mean share of attainable health across the
 *   SCORED areas, each scored area counting once.
 *
 *     overall = Σ w_i × S_i ÷ Σ w_i     over areas with a score
 *
 * It sits ABOVE the module scoring layer and consumes nothing below a
 * module's own summary: CMDB Quality, the ITOM capability checks and ITSM
 * Quality each normalise their own unit (a CI, a check, a work record) so that
 * the size of an area never decides the estate's number. It is NOT a finding
 * count, a record percentage, a rule pass rate, a risk score or a coverage
 * score, and Platform — which has no score by design — is not imputed.
 *
 * ═══ THREE THINGS THE ARCHITECTURE KEEPS APART, KEPT APART ═══
 *
 *   HEALTH      the number, and the band it sits in (the existing vocabulary).
 *   ASSESSMENT  whether the number can be quoted. Any scored area whose number
 *               is withheld or gated makes the overall "Assessment incomplete",
 *               which REPLACES the health word — exactly as it does on an area
 *               card and as the CMDB gate variant publishes a null value.
 *   COVERAGE    how much of the applicable instance was assessed. Never in the
 *               arithmetic: coverage = assessed ÷ (assessed + gaps the instance
 *               could close), with inapplicable populations, uninstalled
 *               products and product gaps outside both sides.
 *
 * Systemic findings are never counted here a second time: CMDB gate blockers
 * are the assessment state, posture is a count beside the score, and findings
 * escalated to Systemic are already inside the CMDB number.
 *
 * ═══ WEIGHTS ═══
 *
 * Equal weights over the scored areas are the declared v1 default — no
 * evidence in this repository prefers one area, and the choice moves the
 * number by less than the band shown beside it. A missing area is dropped and
 * the rest renormalised: missing is never 0 and never 100. The effective
 * weights are stored with every result and hashed into the scoring key, so a
 * later change starts a new trend series rather than repainting history.
 */

export const OVERALL_MODEL = 'overall-health/1';
/** How coverage is defined (assessed ÷ (assessed + instance-actionable gaps)) and how status is decided. Bumped when either changes. */
export const COVERAGE_DEFINITION = 'instance-actionable/1';
export const STATUS_RULES = 'area-precedence/1';

/** The areas that can carry a score today, and the declared default weights. */
export const SCORABLE_MODULES = Object.freeze(['cmdb', 'itom', 'itsm']);
export const DEFAULT_WEIGHTS = Object.freeze({ cmdb: 1 / 3, itom: 1 / 3, itsm: 1 / 3, platform: 0 });

/**
 * The health bands — the same thresholds and words `verdict()` uses on the
 * page, served so the overall's word is never coined twice.
 */
export const HEALTH_BANDS = Object.freeze([
  { key: 'healthy', word: 'Healthy', min: 90, tone: 'ok', line: 'Most of what was measured came back clean.' },
  { key: 'mostly_healthy', word: 'Mostly healthy', min: 75, tone: 'ok', line: 'A minority of what was measured needs attention.' },
  { key: 'needs_attention', word: 'Needs attention', min: 50, tone: 'warn', line: 'A large share of what was measured carries defects, or a capability is missing.' },
  { key: 'needs_work', word: 'Needs work', min: 0, tone: 'bad', line: 'Most of what was measured is defective.' },
]);
export function healthBand(score) {
  if (score == null || !Number.isFinite(score)) return null;
  const band = HEALTH_BANDS.find((b) => score >= b.min) ?? HEALTH_BANDS[HEALTH_BANDS.length - 1];
  return { ...band, rank: HEALTH_BANDS.indexOf(band) };   // rank 0 = best
}

const pct1 = (n) => Number(n.toFixed(1));
const pct3 = (n) => Number(n.toFixed(3));
const hash = (payload) => crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);

/* ── Coverage, per area, under one definition ──────────────────────────────
 * assessed ÷ (assessed + instance-actionable gaps). Each area supplies what
 * it already knows; nothing is estimated. `null` when the area cannot say.  */

/** ITSM blocker kinds the instance can act on; the rest are product gaps, outside both sides. */
const ITSM_INSTANCE_BLOCKERS = new Set(['unconfigured_parameter', 'instance_value', 'capability', 'read', 'input']);
/** ITSM undetermined kinds that are the instance's data, not the design's. */
const ITSM_INSTANCE_UNDETERMINED = new Set(['below_minimum_volume', 'insufficient_history', 'population_unknown', 'input_inconclusive']);
const ITSM_INAPPLICABLE_UNDETERMINED = new Set(['empty_population', 'nothing_judgeable', 'population_undeclared']);

/**
 * CMDB: the weight of measured dimensions over the weight of dimensions that
 * could have been measured on this instance. A dimension with no rule built
 * is a product gap and sits outside both sides.
 */
export function cmdbCoverage(cmdbQuality) {
  const dims = cmdbQuality?.dimensions;
  if (!Array.isArray(dims) || !dims.length) return null;
  let assessed = 0;
  let gaps = 0;
  let excluded = 0;
  for (const d of dims) {
    if (d.measured) assessed += d.weight;
    else if (!d.rules_built) excluded += d.weight;
    else gaps += d.weight;
  }
  const denominator = assessed + gaps;
  return {
    share: denominator ? pct3(assessed / denominator) : null,
    basis: 'dimension weight measured ÷ dimension weight measurable on this instance',
    assessed, gaps, excluded,
    unit: 'dimension weight',
  };
}

/** ITOM: applicable checks over applicable checks plus checks lost to a read failure. */
export function itomCoverage(checks) {
  if (!Array.isArray(checks) || !checks.length) return null;
  let assessed = 0;
  let gaps = 0;
  let excluded = 0;
  for (const c of checks) {
    if (c.result !== 'not_applicable') { assessed += 1; continue; }
    if (!c.gap) return null;              // a run recorded before checks said WHY: it cannot say
    if (c.gap === 'read_failed') gaps += 1;
    else excluded += 1;                   // not requested, not on this instance, nothing to check
  }
  const denominator = assessed + gaps;
  return {
    share: denominator ? pct3(assessed / denominator) : null,
    basis: 'applicable checks ÷ (applicable checks + checks lost to a read failure)',
    assessed, gaps, excluded, unit: 'checks',
  };
}

/**
 * ITSM: rules that established a verdict over those plus rules the instance
 * could have let run — unconfigured parameters, failed reads, missing
 * capabilities, thin data. Objects the workbook leaves undefined and
 * detection gaps are product gaps, outside both sides.
 */
export function itsmCoverage(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let assessed = 0;
  let gaps = 0;
  let excluded = 0;
  const byKind = {};
  const count = (k) => { byKind[k] = (byKind[k] || 0) + 1; };
  for (const r of rows) {
    if (r.status === 'evaluated') {
      if (r.verdict === 'pass' || r.verdict === 'fail') { assessed += 1; count('assessed'); continue; }
      const u = r.undetermined?.kind;
      if (u && ITSM_INSTANCE_UNDETERMINED.has(u)) { gaps += 1; count(`undetermined:${u}`); continue; }
      if (u && ITSM_INAPPLICABLE_UNDETERMINED.has(u)) { excluded += 1; count(`inapplicable:${u}`); continue; }
      excluded += 1; count('detection_gap');                                    // partial scope: the design, not the instance
      continue;
    }
    const kind = r.blocker?.kind ?? r.status;
    if (ITSM_INSTANCE_BLOCKERS.has(kind)) { gaps += 1; count(`blocked:${kind}`); }
    else { excluded += 1; count(`product:${kind}`); }
  }
  const denominator = assessed + gaps;
  return {
    share: denominator ? pct3(assessed / denominator) : null,
    basis: 'rules with a verdict ÷ (those + rules the instance could have let run)',
    assessed, gaps, excluded, unit: 'rules', by_kind: byKind,
  };
}

/**
 * Platform (and any area with no model of its own): its tables. A table is
 * assessed when every row the platform counts was read; a failed read or a
 * row-incomplete read is a gap; a table absent from this instance is outside
 * both sides.
 */
export function tableCoverage(tables, coverage) {
  if (!Array.isArray(tables) || !tables.length || !coverage) return null;
  let assessed = 0;
  let gaps = 0;
  let excluded = 0;
  for (const t of tables) {
    const c = coverage[t];
    if (!c || c.status === 'not_requested' || c.status === 'unavailable') { excluded += 1; continue; }
    if (FAILED_READ_STATUSES.includes(c.status) || c.rows_complete === false) { gaps += 1; continue; }
    assessed += 1;
  }
  const denominator = assessed + gaps;
  return {
    share: denominator ? pct3(assessed / denominator) : null,
    basis: 'tables read in full ÷ (those + tables the account could not read in full)',
    assessed, gaps, excluded, unit: 'tables',
  };
}

/* ── The module contract ──────────────────────────────────────────────────── */

/**
 * One shape per area, derived from the summary `summariseScopes` already
 * writes. Nothing here re-decides a score; it reads what the module decided.
 *
 * @param {string} key      scope key
 * @param {object|null} summary  the area's stored summary, or null when the area has no result
 * @param {object} [opts]
 * @param {object} [opts.coverage]  table → coverage descriptor (for table-based coverage)
 */
export function moduleContract(key, summary, { coverage = null } = {}) {
  if (!summary) {
    return {
      key, score: null, score_kind: null, coverage: null,
      assessment: { state: 'not_scanned', blockers: 0, reasons: ['This area has no result yet.'] },
      systemic: { blockers: 0, posture: 0, escalated_inside_score: 0 },
      scoring: null,
    };
  }
  const gate = summary.gate ?? null;
  const gated = Boolean(gate && !gate.trustworthy && summary.score != null);
  const cq = summary.cmdb_quality ?? null;
  const iq = summary.itsm_quality ?? null;

  let cov = null;
  if (key === 'cmdb') cov = cmdbCoverage(cq);
  else if (key === 'itom') cov = itomCoverage(summary.checks);
  else if (key === 'itsm') cov = iq?.coverage ?? null;
  else cov = tableCoverage(summary.tables, coverage);

  let state;
  const reasons = [];
  if (summary.score_kind === 'none') { state = 'not_scored'; reasons.push(summary.score_withheld_because || 'This area is not scored by design.'); }
  else if (summary.score == null) { state = 'withheld'; reasons.push(summary.score_withheld_because || 'The score was withheld on this run.'); }
  else if (gated) {
    state = 'incomplete';
    const n = gate.blockers?.length ?? 0;
    reasons.push(`${n} ${key.toUpperCase()} blocker${n === 1 ? '' : 's'} must be cleared before this score can be quoted.`);
  } else state = 'assessed';

  const systemic = {
    blockers: gate && !gate.trustworthy ? (gate.blockers?.length ?? 0) : 0,
    posture: (cq?.posture?.length ?? 0) + (iq?.systemic?.findings ?? 0),
    escalated_inside_score: cq?.escalated?.length ?? 0,
  };

  return {
    key,
    score: summary.score ?? null,
    score_kind: summary.score_kind ?? null,
    coverage: cov?.share ?? null,
    coverage_detail: cov,
    assessment: { state, blockers: systemic.blockers, reasons },
    systemic,
    scoring: summary.scoring ?? null,
  };
}

/* ── The aggregation ──────────────────────────────────────────────────────── */

/**
 * Score the estate.
 *
 * @param {object} args
 * @param {Record<string, object>} args.modules   scope key → contract (moduleContract) for every module the view covers
 * @param {Record<string, number>} [args.weights] declared weights; defaults to DEFAULT_WEIGHTS
 */
export function scoreOverall({ modules = {}, weights = DEFAULT_WEIGHTS } = {}) {
  const keys = Object.keys(modules);
  const scorable = keys.filter((k) => modules[k]?.score_kind !== 'none' && (weights[k] ?? 0) > 0);

  /* Who is in: every area with a score and a positive declared weight. */
  const included = scorable.filter((k) => modules[k].score != null);
  const weightSum = included.reduce((n, k) => n + weights[k], 0);
  const breakdown = {};
  for (const k of keys) {
    const c = modules[k];
    const inc = included.includes(k);
    breakdown[k] = {
      score: c.score,
      score_kind: c.score_kind,
      weight: weights[k] ?? 0,
      effective_weight: inc ? pct3(weights[k] / weightSum) : 0,
      included: inc,
      band: c.score != null ? healthBand(c.score)?.key ?? null : null,
      assessment: c.assessment?.state ?? null,
      coverage: c.coverage ?? null,
      scoring: c.scoring ?? null,
    };
  }
  const exact = included.length ? included.reduce((n, k) => n + weights[k] * modules[k].score, 0) / weightSum : null;
  const score = exact == null ? null : pct1(exact);
  const band = healthBand(exact);

  /* ── Assessment: the same precedence an area card uses ── */
  const scanned = keys.filter((k) => modules[k]?.assessment?.state !== 'not_scanned');
  const scanScorable = scorable.filter((k) => modules[k].assessment.state !== 'not_scanned');
  const blocked = scorable.filter((k) => ['incomplete', 'withheld', 'not_scanned'].includes(modules[k].assessment.state));
  let status;
  if (!scanned.length) status = { state: 'not_scanned', word: 'Not scanned', tone: 'idle', reason: 'No area has a result yet.' };
  else if (!scanScorable.length) status = { state: 'not_scored', word: 'Score unavailable', tone: 'idle', reason: 'No scored area has a result yet.' };
  else if (blocked.length) {
    const parts = blocked.map((k) => {
      const c = modules[k];
      if (c.assessment.state === 'not_scanned') return `${k.toUpperCase()} not scanned`;
      if (c.assessment.state === 'withheld') return `${k.toUpperCase()} score withheld`;
      const n = c.assessment.blockers;
      return `${n} ${k.toUpperCase()} blocker${n === 1 ? '' : 's'}`;
    });
    status = { state: 'incomplete', word: 'Assessment incomplete', tone: 'systemic', reason: parts.join(' · '), blocked };
  } else status = { state: 'assessed', word: band.word, tone: band.tone, reason: band.line };

  /* ── Attribution: a scored area in a worse band than the estate, named — never a rule ── */
  let attribution = null;
  if (status.state === 'assessed' && band) {
    const worse = included
      .map((k) => ({ key: k, band: healthBand(modules[k].score) }))
      .filter((x) => x.band.rank > band.rank)
      .sort((a, b) => b.band.rank - a.band.rank || modules[a.key].score - modules[b.key].score);
    if (worse.length) {
      const w = worse[0];
      attribution = { key: w.key, band: w.band.key, word: `${w.key.toUpperCase()} ${w.band.word.toLowerCase()}`, score: modules[w.key].score };
    }
  }

  /* ── Coverage: the same weights, over areas that can say — never in the score ── */
  const withCoverage = included.filter((k) => modules[k].coverage != null);
  const covWeight = withCoverage.reduce((n, k) => n + weights[k], 0);
  const coverage = withCoverage.length
    ? pct3(withCoverage.reduce((n, k) => n + weights[k] * modules[k].coverage, 0) / covWeight)
    : null;

  /* ── Systemic: traceable to the areas, counted once ── */
  const systemic = {
    blockers: keys.reduce((n, k) => n + (modules[k].systemic?.blockers ?? 0), 0),
    posture: keys.reduce((n, k) => n + (modules[k].systemic?.posture ?? 0), 0),
    escalated_inside_score: keys.reduce((n, k) => n + (modules[k].systemic?.escalated_inside_score ?? 0), 0),
    by_module: Object.fromEntries(keys.map((k) => [k, modules[k].systemic ?? { blockers: 0, posture: 0, escalated_inside_score: 0 }])),
  };

  const effective = Object.fromEntries(included.map((k) => [k, breakdown[k].effective_weight]));
  const scoring = {
    model: OVERALL_MODEL,
    weights: effective,
    declared_weights: Object.fromEntries(keys.map((k) => [k, weights[k] ?? 0])),
    coverage_definition: COVERAGE_DEFINITION,
    status_rules: STATUS_RULES,
    participants: included.slice().sort(),
    module_keys: Object.fromEntries(included.slice().sort().map((k) => [k, modules[k].scoring?.key ?? null])),
  };
  scoring.key = hash({
    model: scoring.model,
    weights: Object.entries(effective).sort(),
    coverage_definition: scoring.coverage_definition,
    status_rules: scoring.status_rules,
    participants: scoring.participants,
    module_keys: Object.entries(scoring.module_keys).sort(),
  });

  return {
    score,
    score_exact: exact == null ? null : pct3(exact),
    score_kind: 'overall',
    score_basis: included.length
      ? `${included.map((k) => `${k.toUpperCase()} ${modules[k].score}`).join(' · ')} — equal weights over ${included.length} scored area${included.length === 1 ? '' : 's'}${keys.filter((k) => !included.includes(k)).length ? `; ${keys.filter((k) => !included.includes(k)).map((k) => k.toUpperCase()).join(', ')} not scored` : ''}`
      : null,
    score_definition: 'Mean share of attainable health across the scored areas, each area counted once. Not a percentage of records or checks.',
    score_withheld_because: included.length ? null : (status.reason ?? 'No scored area has a result yet.'),
    status,
    health_band: band ? { key: band.key, word: band.word, tone: band.tone } : null,
    attribution,
    coverage,
    systemic,
    module_breakdown: breakdown,
    scoring,
  };
}
