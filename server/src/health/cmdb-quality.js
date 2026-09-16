import catalogue from './catalogue/cmdb.json' with { type: 'json' };

/**
 * CMDB QUALITY — the two-layer score the SAOS rule catalogue defines.
 *
 * PURE. Findings, KPI measurements and a scope in; a score out. No socket, no
 * database, no model.
 *
 * ═══ WHY TWO LAYERS ═══
 *
 * The previous CMDB number was a pass rate: the share of CIs no rule objected
 * to. One Low finding failed a whole record, which is how an estate scored
 * 0.3%. It also let a broken GOVERNANCE mechanism — no inclusion rule, a dead
 * health job — sit inside the same arithmetic as a missing serial number.
 *
 *   LAYER 1 — THE TRUST GATE. A finding whose BASE severity is Systemic never
 *   deducts from a record. It decides whether the number can be believed: while
 *   one is live the score is "not trustworthy", with the reasons.
 *
 *   LAYER 2 — DIMENSION SCORES, then the composite.
 *     record_score(r, d) = max(0, 100 − Σ w(effective band))   over record findings in d on r
 *     record_part(d)     = mean record_score over in-scope records
 *     kpi_part(d)        = mean passing % of the percentage rules measured in d
 *     dimension_score(d) = 70% record_part + 30% kpi_part when both exist; whichever exists otherwise
 *     composite          = Σ weight_d × score_d ÷ Σ weight_d over MEASURED dimensions
 *   w: Critical 40 · High 15 · Moderate 5 · Low 1 · escalated-to-Systemic 100.
 *
 * ═══ RULES ARE ROUTED BY KIND (decisions of 16 Sep) ═══
 *
 *   record   — deducts from the records it names.
 *   kpi      — a percentage or ratio. Scored at the level it measures: its
 *              passing % is a dimension sub-score. Never smeared across records.
 *   context  — structural context (e.g. classes with fewer than five records):
 *              shown, never scored.
 *   trend    — shown; gates only if its base is Systemic.
 *
 * And by TRACK. The composite is a DATA-QUALITY score, so findings that are
 * not data quality never move it: governance posture (Group 9), the platform
 * indicator (Group 13), drift and regression (Group 14) and CSDM maturity
 * (Group 11 outside D10) are counted in their own panels. A base-Systemic
 * finding gates whatever its track.
 *
 * ═══ TWO PROVISIONAL STATES, NEVER MERGED ═══
 *
 *   gate-provisional      a base-Systemic finding is live  → "Score not trustworthy"
 *   coverage-provisional  not every dimension is measured  → "Provisional — x of 100 weight measured"
 *
 * ═══ GATE-SYSTEMIC IS NOT ESCALATED-SYSTEMIC ═══
 *
 * A record finding escalated to Systemic by its context zeroes its record
 * (w = 100). It COUNTED, so it is not a blocker: it is listed as "Escalated —
 * Systemic" with the chain that got it there, apart from the gate.
 *
 * ═══ SYSTEMIC IS NOT THE SAME AS GATE (18 Sep) ═══
 *
 * A Systemic finding gates only when it invalidates what the composite MEANS.
 * `systemicKind` decides, per rule:
 *   config_absence  gate only (CMDB-001, 002, 044, 045)
 *   measured_kpi    gate on breach AND contribute its sub-score (CMDB-003, 046, 057, 070, 141)
 *   posture         neither gate nor score — shown as Systemic posture (CMDB-038, 056, 091, 104, 112, 131)
 *   derived         shown only (CMDB-116, computed from the composite itself)
 *
 * ═══ A RECORD IS CHARGED FOR ITS OWN CONTEXT, NEVER ITS CLASS'S (18 Sep) ═══
 *
 * A per-CI escalator (business-critical support, production, shared
 * infrastructure…) is a property of the CI: at effective Systemic it zeroes
 * THAT record. The class-defect-rate escalator is a property of the CLASS: it
 * raises reporting severity by surfacing one pattern finding, and never changes
 * what a record is charged. So every record finding carries two bands:
 * `severity` (where it is reported) and `deduction_severity` (what it costs).
 *
 * ═══ ONE DEFECT, ONE CHARGE ═══
 *
 * One duplicate pair is caught by several rules at once (serial, address,
 * asymmetric, fuzzy). Findings that describe the same set share a
 * `dedupe_key`, and a record pays only the heaviest of them.
 */

export const BAND_ORDER = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'SYSTEMIC']);
export const BAND_WEIGHT = Object.freeze({ SYSTEMIC: 100, CRITICAL: 40, HIGH: 15, MEDIUM: 5, LOW: 1 });
export const BLEND_DEFAULTS = Object.freeze({ record: 0.7, kpi: 0.3 });

export const CMDB_DIMENSIONS = Object.freeze(catalogue.dimensions.map((d) => Object.freeze({ ...d })));
export const CMDB_CATALOGUE = Object.freeze(Object.fromEntries(catalogue.rules.map((r) => [r.id, Object.freeze(r)])));
export const CATALOGUE_SOURCE = catalogue.source;

/** The modifier vocabulary, word for word from the Schema tab. */
/**
 * THE TWO MODIFIER FAMILIES (confirmed 19 Sep).
 *
 *   per_ci      a fact about THIS record — the CI supports a Business Critical
 *               service, runs in production, is shared infrastructure, is
 *               already retiring, has an approved exception. It changes what the
 *               record is CHARGED, and at Systemic it zeroes that record.
 *   population  a fact about the CLASS the record happens to sit in — the defect
 *               rate in its class, or being below the materiality floor. It
 *               changes only where the finding is REPORTED. The charge stays at
 *               the record's own band, always.
 *
 * The family is a property of the modifier, not of the caller, so a new modifier
 * cannot quietly join the wrong one: `POPULATION_MODIFIERS` is derived from it
 * and a test asserts the two lists agree.
 */
export const MODIFIER_FAMILY = Object.freeze({
  business_critical_service: 'per_ci',
  production: 'per_ci',
  cross_domain_cause: 'per_ci',
  duration_over_30_days: 'per_ci',
  shared_infrastructure: 'per_ci',
  silent_failure: 'per_ci',
  recurred: 'per_ci',
  control: 'per_ci',
  rule_threshold: 'per_ci',
  class_defect_rate: 'population',
  non_production: 'per_ci',
  not_consumed: 'per_ci',
  approved_exception: 'per_ci',
  compensating_control: 'per_ci',
  retiring: 'per_ci',
  below_materiality: 'population',
});

export const ESCALATORS = Object.freeze({
  business_critical_service: 'Supports a Business Critical service',
  production: 'Production environment',
  cross_domain_cause: 'Traced cause of downstream findings in another domain',
  duration_over_30_days: 'Duration beyond 30 days',
  shared_infrastructure: 'Shared infrastructure (network core, auth, shared DB)',
  silent_failure: 'Silent failure (reports success, wrong result)',
  recurred: 'Recurred after prior remediation',
  class_defect_rate: 'Defect rate in class exceeds materiality threshold',
  control: 'Involves an approval, authorisation or segregation-of-duties control',
  rule_threshold: 'Rule-specific escalation stated in its Threshold / Parameter',
});
export const DE_ESCALATORS = Object.freeze({
  non_production: 'Non-production and correctly tagged',
  not_consumed: 'Class not consumed by any process',
  approved_exception: 'Approved exception on file',
  below_materiality: 'Below materiality floor for the class',
  compensating_control: 'Compensating control evidenced',
  retiring: 'Already flagged for retirement',
});

/* Derived from MODIFIER_FAMILY, never written twice: the population family moves
   where a finding is reported and never what a record is charged (18 Sep). */
export const POPULATION_MODIFIERS = Object.freeze(
  Object.entries(MODIFIER_FAMILY).filter(([, family]) => family === 'population').map(([key]) => key),
);
export const familyOf = (key) => MODIFIER_FAMILY[key] ?? null;
/* The Systemic kinds that gate the composite. `posture` and `derived` never do. */
export const GATING_KINDS = Object.freeze(new Set(['config_absence', 'measured_kpi']));

export function catalogueRule(id) {
  return CMDB_CATALOGUE[id] ?? null;
}

/**
 * effective_band = clamp(base + count(escalators) − count(de-escalators), Low, Systemic)
 *
 * Modifiers STACK — both worked examples on the Schema tab move two bands.
 * Unknown keys are refused rather than counted, so a typo cannot move a band.
 */
export function effectiveBand(base, { escalators = [], deEscalators = [] } = {}) {
  const start = BAND_ORDER.indexOf(base);
  if (start < 0) throw new Error(`Unknown base band "${base}"`);
  const up = escalators.filter((k) => k in ESCALATORS).length;
  const down = deEscalators.filter((k) => k in DE_ESCALATORS).length;
  const at = Math.min(BAND_ORDER.length - 1, Math.max(0, start + up - down));
  return BAND_ORDER[at];
}

const pct1 = (n) => Number(n.toFixed(1));
const labelOf = (key) => ESCALATORS[key] || DE_ESCALATORS[key] || key;

/**
 * Score CMDB Quality.
 *
 * @param {object}   args
 * @param {object[]} args.findings     every detected finding
 * @param {object[]} args.kpis         percentage measurements: { rule_id, pass_pct, numerator, denominator, basis }
 * @param {{ids: Iterable<string>, basis: string}} args.inScope  records the inclusion rules cover
 * @param {Set<string>} args.implemented  catalogue rule IDs this build evaluates
 * @param {{record: number, kpi: number}} args.blend
 * @param {object}   args.measures     context measures recorded by the rules — reported, never scored
 */
export function scoreCmdbQuality({
  findings = [], kpis = [], inScope = { ids: [], basis: '' }, implemented = new Set(), blend = BLEND_DEFAULTS, measures = {},
  dimensionScope = {},
} = {}) {
  const scopeIds = new Set(inScope.ids || []);
  /*
   * A DIMENSION MAY SCORE A NARROWER SET (decision 7 of 19 Sep).
   *
   * The data-quality dimensions judge records that are supposed to be
   * maintained, so retired, stolen and absent CIs are out of their scope — but
   * they stay in the estate, because the lifecycle dimension exists to evaluate
   * exactly those. A dimension with no entry here scores every in-scope record.
   */
  const scopeFor = (dim) => (dimensionScope[dim] ? new Set(dimensionScope[dim]) : scopeIds);
  const catalogued = findings.filter((f) => CMDB_CATALOGUE[f.rule_id]);

  const GATING = GATING_KINDS;
  const deductionBand = (f, id) => f.deduction_by_record?.[id] ?? f.deduction_severity ?? f.severity;

  /* ── Layer 1: the gate. BASE Systemic AND a gating kind. ── */
  const baseSystemic = catalogued.filter((f) => CMDB_CATALOGUE[f.rule_id].base === 'SYSTEMIC');
  const blockers = baseSystemic
    .filter((f) => GATING.has(CMDB_CATALOGUE[f.rule_id].systemicKind))
    .map((f) => ({
      rule_id: f.rule_id, fingerprint: f.fingerprint, title: f.title,
      systemic_kind: CMDB_CATALOGUE[f.rule_id].systemicKind,
      headline: f.rule_id === 'CMDB-141',
    }));
  /* Systemic POSTURE: surfaced, never gating, never scored. */
  const posture = baseSystemic
    .filter((f) => !GATING.has(CMDB_CATALOGUE[f.rule_id].systemicKind))
    .map((f) => ({ rule_id: f.rule_id, fingerprint: f.fingerprint, title: f.title, systemic_kind: CMDB_CATALOGUE[f.rule_id].systemicKind ?? null }));

  /* ── Escalated to Systemic by the CI's OWN context: it zeroed its record. ── */
  const escalated = catalogued
    .filter((f) => !f.pattern && !f.unscored_reason && CMDB_CATALOGUE[f.rule_id].base !== 'SYSTEMIC'
      && ((f.target_ids || []).some((id) => deductionBand(f, id) === 'SYSTEMIC')))
    .map((f) => ({
      rule_id: f.rule_id, fingerprint: f.fingerprint, title: f.title,
      chain: {
        base: CMDB_CATALOGUE[f.rule_id].base,
        effective: 'SYSTEMIC',
        escalators: (f.modifiers?.escalators || []).map((k) => ({ key: k, label: labelOf(k) })),
        de_escalators: (f.modifiers?.de_escalators || []).map((k) => ({ key: k, label: labelOf(k) })),
      },
      records: (f.target_ids || []).filter((id) => deductionBand(f, id) === 'SYSTEMIC').length,
    }));

  /* ── Class-wide PATTERNS: reported severity only, never a charge. ── */
  const patterns = catalogued.filter((f) => f.pattern).map((f) => ({
    rule_id: f.rule_id, fingerprint: f.fingerprint, title: f.title, severity: f.severity,
    class: f.materiality?.class ?? null, affected: f.materiality?.affected ?? (f.target_ids || []).length,
    class_size: f.materiality?.class_size ?? null,
  }));

  /* ── Layer 2: record deductions and KPI parts, per dimension. ── */
  const deductions = new Map();              // dim -> Map(recordId -> Map(dedupeKey -> weight))
  const dimFindings = {};
  const unscored = [];
  const tracks = {};
  let defects = 0;
  let weighted = 0;

  for (const f of catalogued) {
    const rule = CMDB_CATALOGUE[f.rule_id];
    if (rule.base === 'SYSTEMIC') continue;                 // gate or posture — never a deduction
    if (rule.track !== 'dimension' || !rule.dimension) {
      tracks[rule.track] = (tracks[rule.track] || 0) + 1;   // governance, platform, trend, csdm-maturity, context, gate-config, posture
      continue;
    }
    dimFindings[rule.dimension] = (dimFindings[rule.dimension] || 0) + 1;
    if (f.unscored_reason) {
      unscored.push({ rule_id: f.rule_id, fingerprint: f.fingerprint, reason: f.unscored_reason });
      continue;
    }
    if (f.pattern) {
      unscored.push({ rule_id: f.rule_id, fingerprint: f.fingerprint, reason: 'class-wide pattern — raises reporting severity; the records it covers are charged by their own findings' });
      continue;
    }
    if (rule.kind !== 'record') {
      unscored.push({ rule_id: f.rule_id, fingerprint: f.fingerprint, reason: `${rule.kind} rule — scored through its measurement, not per record` });
      continue;
    }
    if (!(f.target_ids || []).length) {
      unscored.push({ rule_id: f.rule_id, fingerprint: f.fingerprint, reason: 'names no records, so there is no record to deduct from' });
      continue;
    }
    if (!deductions.has(rule.dimension)) deductions.set(rule.dimension, new Map());
    const byRecord = deductions.get(rule.dimension);
    const inDimension = scopeFor(rule.dimension);
    const key = f.dedupe_key || f.fingerprint;
    for (const id of f.target_ids) {
      if (!inDimension.has(id)) continue;
      const band = deductionBand(f, id);
      /*
       * The multiplier is PER RECORD. CMDB-033 charges 5x the CI that is the
       * defect — the empty twin nothing points at — and leaves the populated
       * twin, which is the victim of the duplicate, at its ordinary band
       * (confirmed 19 Sep).
       */
      const multiplier = f.deduction_multiplier_by_record?.[id] ?? f.deduction_multiplier ?? 1;
      const w = (BAND_WEIGHT[band in BAND_WEIGHT ? band : rule.base]) * multiplier;
      if (!byRecord.has(id)) byRecord.set(id, new Map());
      const charges = byRecord.get(id);
      if (!charges.has(key)) defects += 1;
      charges.set(key, Math.max(charges.get(key) || 0, w));
    }
  }
  for (const byRecord of deductions.values()) {
    for (const charges of byRecord.values()) for (const w of charges.values()) weighted += w;
  }

  const kpiByDim = {};
  for (const k of kpis) {
    const rule = CMDB_CATALOGUE[k.rule_id];
    if (!rule?.dimension || rule.track !== 'dimension' || k.pass_pct == null || !Number.isFinite(k.pass_pct)) continue;
    (kpiByDim[rule.dimension] ||= []).push({ ...k, title: rule.title, base: rule.base });
  }

  const principalCaveat = catalogued.some((f) => f.rule_id === 'CMDB-139');
  const N = scopeIds.size;

  const dimensions = CMDB_DIMENSIONS.map((d) => {
    const inDim = Object.values(CMDB_CATALOGUE).filter((r) => r.dimension === d.key && r.track === 'dimension');
    const built = inDim.filter((r) => implemented.has(r.id));
    const recordBuilt = built.filter((r) => r.kind === 'record');
    const measuredKpis = kpiByDim[d.key] || [];
    const caveats = [];
    if (principalCaveat && built.some((r) => r.principalScoped)) {
      caveats.push('No principal classes are designated (CMDB-139): principal-scoped rules here use the all-populated-classes fallback, so classes are not weighted by operational importance.');
    }
    const base = {
      key: d.key, label: d.label, weight: d.weight,
      rules_total: inDim.length, rules_built: built.length,
      findings: dimFindings[d.key] || 0,
      caveats,
    };

    const dimIds = scopeFor(d.key);
    const dimN = dimIds.size;
    const hasRecord = recordBuilt.length > 0 && dimN > 0;
    const hasKpi = measuredKpis.length > 0;
    if (!hasRecord && !hasKpi) {
      return {
        ...base, measured: false, score: null,
        not_measured_because: built.length ? 'Its built rules produced no measurement on this run.' : 'No rule in this dimension is built yet.',
      };
    }

    let recordPart = null;
    let affected = 0;
    if (hasRecord) {
      const byRecord = deductions.get(d.key) || new Map();
      let lost = 0;
      for (const charges of byRecord.values()) {
        let sum = 0;
        for (const w of charges.values()) sum += w;
        lost += Math.min(100, sum);
      }
      recordPart = 100 - lost / dimN;
      affected = byRecord.size;
    }
    const kpiPart = hasKpi ? measuredKpis.reduce((n, k) => n + k.pass_pct, 0) / measuredKpis.length : null;
    const score = hasRecord && hasKpi
      ? blend.record * recordPart + blend.kpi * kpiPart
      : (hasRecord ? recordPart : kpiPart);

    return {
      ...base,
      measured: true,
      score: pct1(score),
      record_part: recordPart == null ? null : pct1(recordPart),
      kpi_part: kpiPart == null ? null : pct1(kpiPart),
      blend: hasRecord && hasKpi ? { record: blend.record, kpi: blend.kpi } : null,
      kpis: measuredKpis.map((k) => ({ rule_id: k.rule_id, title: k.title, pass_pct: pct1(k.pass_pct), numerator: k.numerator, denominator: k.denominator, basis: k.basis })),
      records_affected: affected,
      records_scored: dimN,
      scope_note: dimN === N ? null : `${(N - dimN).toLocaleString('en-US')} record(s) out of this dimension's scope — retired, stolen or absent CIs are evaluated by the lifecycle dimension, not this one`,
    };
  });

  const measured = dimensions.filter((d) => d.measured);
  const measuredWeight = measured.reduce((n, d) => n + d.weight, 0);
  const composite = measuredWeight
    ? pct1(measured.reduce((n, d) => n + d.weight * d.score, 0) / measuredWeight)
    : null;
  const gateProvisional = blockers.length > 0;
  const coverageProvisional = measuredWeight < 100;

  return {
    model: 'CMDB Quality',
    catalogue: CATALOGUE_SOURCE,
    gate: {
      trustworthy: !gateProvisional,
      label: gateProvisional ? 'Score not trustworthy' : null,
      blockers,
      /* The headline measure is named in the gate narrative even when it is
         passing, because it is the one number that says the CMDB works. */
      headline: kpis.find((k) => k.rule_id === 'CMDB-141') ?? null,
    },
    escalated,
    patterns,
    posture,
    /* Context measures (CMDB-043) and trend inputs (CMDB-038): shown, never scored. */
    measures,
    in_scope: { records: N, basis: inScope.basis || '' },
    composite: {
      score: composite,
      measured_weight: measuredWeight,
      gate_provisional: gateProvisional,
      coverage_provisional: coverageProvisional,
      coverage_label: coverageProvisional && composite != null ? `Provisional — ${measuredWeight} of 100 weight measured` : null,
      not_measured_because: composite == null ? 'No CMDB Quality dimension produced a measurement yet, so there is nothing to average.' : null,
      definition: 'Σ weight × dimension score over measured dimensions ÷ their weight. A dimension blends its mean record score (a record starts at 100 and loses the weight of each finding on it) with the passing % of its percentage rules.',
    },
    dimensions,
    tracks,
    unscored_findings: unscored,
    density: {
      defects_per_100_records: N ? pct1((defects * 100) / N) : null,
      weighted_per_100_records: N ? pct1((weighted * 100) / N) : null,
      note: 'Secondary trend metric only. The headline is the composite.',
    },
    rules: {
      catalogued: catalogue.rules.length,
      built: [...implemented].filter((id) => CMDB_CATALOGUE[id]).length,
    },
  };
}
