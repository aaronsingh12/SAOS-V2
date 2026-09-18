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
 * ═══ SYSTEMIC IS NOT THE SAME AS GATE (16 Sep 2026) ═══
 *
 * A Systemic finding gates only when it invalidates what the composite MEANS.
 * `systemicKind` decides, per rule:
 *   config_absence  gate only (CMDB-001, 002, 044, 045)
 *   measured_kpi    gate on breach AND contribute its sub-score (CMDB-003, 046, 057, 070, 141)
 *   posture         neither gate nor score — shown as Systemic posture (CMDB-038, 056, 091, 104, 112, 131)
 *   derived         shown only (CMDB-116, computed from the composite itself)
 *
 * ═══ A RECORD IS CHARGED FOR ITS OWN CONTEXT, NEVER ITS CLASS'S (16 Sep 2026) ═══
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
/**
 * ═══ THE BLEND IS PER DIMENSION TYPE, NOT ONE GLOBAL RATIO (Sep 2026) ═══
 *
 * A dimension score blends its mean RECORD score with the mean pass rate of its
 * PERCENTAGE rules. One ratio for all ten dimensions assumed they ask the same
 * shape of question, and they do not.
 *
 * Measured on dev424910 when D10 was completed: its record part was 96.0 and its
 * KPI part 0.0, so the blend alone decided the score — 67.2 at 70/30, 38.4 at
 * 40/60. And the record part was near-inert BY DESIGN: consequence scoping
 * correctly makes a long tail of unreferenced laptops quiet, which leaves a mean
 * of 96 that moves barely at all. Meanwhile the KPI half was saying something
 * stark and true — no incident in the window named a CI, and impact analysis
 * returned nothing 52 times out of 52.
 *
 * So the ratio follows the SHAPE of the question:
 *
 *   record   the defect is a property of a record, and counting records is the
 *            measurement. Completeness, correctness, uniqueness, lifecycle,
 *            ownership. (These currently publish no KPIs at all, so the ratio is
 *            moot for them today — it is declared for when they do.)
 *   mixed    per-record defects AND an estate-level rate both carry real signal.
 *            Relationships, freshness, identification, reconciliation.
 *   estate   the question is about the estate, not about any record. Consumption
 *            is the clear case: "does anybody use this CMDB" cannot be answered
 *            by averaging CIs, and a per-record mean will always flatter it.
 *
 * This is consequence scoping applied one level up: where a defect is
 * near-universal and low-consequence per record, the per-record mean stops being
 * informative, and the dimension's weight belongs with the measure that still is.
 */
export const DIMENSION_KIND = Object.freeze({
  D1: 'record', D2: 'record', D3: 'record', D8: 'record', D9: 'record',
  /* D4 and D5 are unvalidated on this estate — no rule in either has ever charged
     a record here — so they take the middle ratio until one does. */
  D4: 'mixed', D5: 'mixed', D6: 'mixed', D7: 'mixed',
  D10: 'estate',
});

export const BLEND_BY_KIND = Object.freeze({
  record: Object.freeze({ record: 0.7, kpi: 0.3 }),
  mixed: Object.freeze({ record: 0.6, kpi: 0.4 }),
  estate: Object.freeze({ record: 0.3, kpi: 0.7 }),
});

/** The old single ratio, kept as the fallback for a dimension with no declared kind. */
export const BLEND_DEFAULTS = BLEND_BY_KIND.record;

/** The blend a dimension uses, and why — published with the score. */
export function blendFor(dimension, override = null) {
  if (override) return { ...override, kind: 'override' };
  const kind = DIMENSION_KIND[dimension] || 'mixed';
  return { ...BLEND_BY_KIND[kind], kind };
}

export const CMDB_DIMENSIONS = Object.freeze(catalogue.dimensions.map((d) => Object.freeze({ ...d })));
export const CMDB_CATALOGUE = Object.freeze(Object.fromEntries(catalogue.rules.map((r) => [r.id, Object.freeze(r)])));
export const CATALOGUE_SOURCE = catalogue.source;

/** The modifier vocabulary, word for word from the Schema tab. */
/**
 * THE TWO MODIFIER FAMILIES (confirmed 16 Sep 2026).
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
   where a finding is reported and never what a record is charged (16 Sep 2026). */
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
  findings = [], kpis = [], inScope = { ids: [], basis: '' }, implemented = new Set(), blend = null, measures = {},
  dimensionScope = {}, skippedRules = [], configRules = [],
} = {}) {
  /*
   * A DIMENSION IS MEASURED ONLY IF SOMETHING THAT CAN CHARGE A RECORD RAN.
   *
   * Measured on dev424910, 16 Sep 2026: D4 and D5 reported 100 while every rule that
   * could deduct had skipped — no source attribution, no reconciliation
   * definitions — and the only findings were configuration ones that deduct
   * nothing by design. A clean 100 from rules that never ran is exactly the
   * failure "not measured" exists to prevent.
   */
  const didNotRun = new Set(skippedRules.map((x) => (typeof x === 'string' ? x : x.rule)).filter(Boolean));
  const configOnly = new Set(configRules);
  const scopeIds = new Set(inScope.ids || []);
  /*
   * A DIMENSION MAY SCORE A NARROWER SET (decision 7 of 16 Sep 2026).
   *
   * The data-quality dimensions judge records that are supposed to be
   * maintained, so retired, stolen and absent CIs are out of their scope — but
   * they stay in the estate, because the lifecycle dimension exists to evaluate
   * exactly those. A dimension with no entry here scores every in-scope record.
   */
  const baseScopeFor = (dim) => (dimensionScope[dim] ? new Set(dimensionScope[dim]) : scopeIds);
  /*
   * A CONTRADICTION rule judges records a quality rule would skip — a retired CI
   * whose two status fields disagree, an edge into a dead one. Its charge would
   * otherwise be dropped, because the record is outside the dimension's
   * quality scope. So the records such a rule actually charged JOIN the
   * denominator of the dimension that charged them: the mean still describes
   * exactly the records this dimension judged, no more and no fewer.
   */
  let contradictionCharged = null;
  const chargedByContradiction = () => {
    if (contradictionCharged) return contradictionCharged;
    contradictionCharged = {};
    for (const f of catalogued) {
      const rule = CMDB_CATALOGUE[f.rule_id];
      if (rule.intent !== 'contradiction' || rule.track !== 'dimension' || !rule.dimension) continue;
      if (rule.base === 'SYSTEMIC' || f.pattern || f.unscored_reason || rule.kind !== 'record') continue;
      (contradictionCharged[rule.dimension] ||= new Set());
      for (const id of f.target_ids || []) if (scopeIds.has(id)) contradictionCharged[rule.dimension].add(id);
    }
    return contradictionCharged;
  };
  const scopeCache = new Map();
  const scopeFor = (dim) => {
    if (!scopeCache.has(dim)) {
      const ids = baseScopeFor(dim);
      const extra = chargedByContradiction()[dim];
      scopeCache.set(dim, extra?.size ? new Set([...ids, ...extra]) : ids);
    }
    return scopeCache.get(dim);
  };
  const catalogued = findings.filter((f) => CMDB_CATALOGUE[f.rule_id]);

  const GATING = GATING_KINDS;
  const deductionBand = (f, id) => f.deduction_by_record?.[id] ?? f.deduction_severity ?? f.severity;

  /*
   * A KPI CANNOT GATE ON A CAPABILITY THE ESTATE DOES NOT HAVE (decision 2 of
   * Sep 2026).
   *
   * A `measured_kpi` gates because a measured failure invalidates what the
   * composite means. But when the thing being measured is ABSENT rather than
   * failing — no service map to traverse from, no Discovery installed to be
   * behind schedule — a gate would be reporting a policy ("you should own this
   * product") as a measurement. That is posture: surfaced, non-gating,
   * non-scoring.
   *
   * A rule downgrades itself by setting `systemic_kind_override` on the finding
   * and must say why in `systemic_kind_override_reason`. The override can only
   * ever DOWNGRADE: a rule cannot promote itself into the gate, so the gate's
   * membership stays the catalogue's decision and never a rule pack's.
   */
  const kindOf = (f) => {
    const declared = CMDB_CATALOGUE[f.rule_id].systemicKind;
    const override = f.systemic_kind_override;
    return override && !GATING.has(override) ? override : declared;
  };

  /* ── Layer 1: the gate. BASE Systemic AND a gating kind. ── */
  const baseSystemic = catalogued.filter((f) => CMDB_CATALOGUE[f.rule_id].base === 'SYSTEMIC');
  const blockers = baseSystemic
    .filter((f) => GATING.has(kindOf(f)))
    .map((f) => ({
      rule_id: f.rule_id, fingerprint: f.fingerprint, title: f.title,
      systemic_kind: kindOf(f),
      headline: f.rule_id === 'CMDB-141',
    }));
  /* Systemic POSTURE: surfaced, never gating, never scored. */
  const posture = baseSystemic
    .filter((f) => !GATING.has(kindOf(f)))
    .map((f) => ({
      rule_id: f.rule_id, fingerprint: f.fingerprint, title: f.title,
      systemic_kind: kindOf(f) ?? null,
      downgraded_from: f.systemic_kind_override ? CMDB_CATALOGUE[f.rule_id].systemicKind : undefined,
      downgraded_because: f.systemic_kind_override_reason || undefined,
    }));

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
       * (confirmed 16 Sep 2026).
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
    /* Rules that can actually deduct, and did run. */
    const chargeable = recordBuilt.filter((r) => !configOnly.has(r.id) && !didNotRun.has(r.id));
    const configHere = recordBuilt.filter((r) => configOnly.has(r.id));
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
    const hasRecord = chargeable.length > 0 && dimN > 0;
    const hasKpi = measuredKpis.length > 0;
    if (configHere.length) {
      caveats.push(`${configHere.length} rule(s) here judge CONFIGURATION (identification rules, precedence definitions). They are reported and can gate, but they deduct from no record, so they do not move this score.`);
    }
    if (!hasRecord && !hasKpi) {
      /* Name only what COULD have measured it: the charging record rules and the
         percentage rules. A configuration rule skipping is not why there is no
         record score — it could never have produced one. */
      const skippedHere = [...built.filter((r) => didNotRun.has(r.id)
        && ((r.kind === 'record' && !configOnly.has(r.id)) || r.kind === 'kpi')).map((r) => r.id)].sort();
      return {
        ...base, measured: false, score: null,
        not_measured_because: !built.length
          ? 'No rule in this dimension is built yet.'
          : skippedHere.length
            ? `Every rule here that can charge a record skipped on this run (${skippedHere.join(', ')}), so there is no record measurement — only the configuration findings above, which deduct nothing.`
            : 'Its built rules produced no measurement on this run.',
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
    const dimBlend = blendFor(d.key, blend);
    const score = hasRecord && hasKpi
      ? dimBlend.record * recordPart + dimBlend.kpi * kpiPart
      : (hasRecord ? recordPart : kpiPart);

    /*
     * WHAT THE KPI HALF ACTUALLY RESTS ON.
     *
     * A dimension's KPI half is the mean of whichever percentage rules produced a
     * measurement — and on a given estate that can be far fewer than were built.
     * Measured on dev424910: D10's KPI half is 70% of the dimension, CMDB-117 and
     * CMDB-118 both abstain below their volume floor, and CMDB-141 carries all of
     * it alone. A 28.8 read as "a broad assessment of consumption" would be wrong;
     * it is one measurement. And when that measurement is also a trust-gate
     * blocker, the estate is being told the same thing twice — once as a score
     * and once as a gate — which the reader should know before counting it twice.
     */
    const kpiBuilt = built.filter((r) => r.kind === 'kpi').map((r) => r.id);
    let kpiBasis = null;
    if (hasKpi) {
      const measuredIds = measuredKpis.map((k) => k.rule_id);
      const unmeasured = kpiBuilt.filter((id) => !measuredIds.includes(id));
      const kpiShare = hasRecord ? dimBlend.kpi : 1;
      const alsoGating = measuredIds.filter((id) => blockers.some((b) => b.rule_id === id));
      kpiBasis = { share: kpiShare, measured: measuredIds, unmeasured, also_gating: alsoGating };
      if (unmeasured.length) {
        /* "Produced no measurement" covers both an abstention (below a volume
           floor, a table unread) and an empty population (no custom attributes
           to measure) — the reader needs to know the KPI half is narrow, and the
           rule's own skip says which. */
        caveats.push(`Its KPI half (${Math.round(kpiShare * 100)}% of this dimension) rests on ${measuredIds.length === 1 ? 'ONE measurement' : `${measuredIds.length} measurements`} — ${measuredIds.join(', ')} — while ${unmeasured.join(', ')} produced no measurement on this run (each rule's skip says why). Read the score as ${measuredIds.length === 1 ? `what ${measuredIds[0]} says` : 'what those rules say'}, not as a broad assessment of the dimension.`);
      }
      if (alsoGating.length) {
        caveats.push(`${alsoGating.join(', ')} ${alsoGating.length === 1 ? 'is' : 'are'} also a trust-gate blocker, so this estate is hearing the same signal twice — once in this score and once as the gate. It is one problem, not two.`);
      }
    } else if (kpiBuilt.length) {
      /*
       * THE ZERO CASE (CMDB checkpoint, 17 Sep 2026). The disclosure above fired
       * only when at least one KPI measured, so a dimension whose KPI half was
       * entirely absent read as a complete record score with no caveat. Measured on
       * dev424910: D1 has CMDB-021 built, it produced nothing, and 73.8 was the
       * record mean alone — silently, while D7 and D10 disclosed a PARTIAL KPI half.
       */
      kpiBasis = { share: 0, measured: [], unmeasured: kpiBuilt, also_gating: [] };
      caveats.push(`Its KPI part is ABSENT on this run: ${kpiBuilt.join(', ')} ${kpiBuilt.length === 1 ? 'is' : 'are'} built for this dimension and produced no measurement (each rule's skip says why), so the score is the record mean alone and the ${Math.round(dimBlend.record * 100)}/${Math.round(dimBlend.kpi * 100)} ${dimBlend.kind} blend was not applied. Read it as what the record rules say, not as the whole dimension.`);
    }
    /* The mirror: a KPI-only score while record rules that could have charged produced nothing. */
    const recordSilent = recordBuilt.filter((r) => !configOnly.has(r.id)).map((r) => r.id);
    if (hasKpi && !hasRecord && recordSilent.length) {
      caveats.push(`Its record part is ABSENT on this run: ${recordSilent.join(', ')} ${recordSilent.length === 1 ? 'is' : 'are'} built for this dimension and charged no record (each rule's skip says why), so the score is the KPI mean alone and no blend was applied. Read it as what the percentage rules say, not as the whole dimension.`);
    }

    return {
      ...base,
      measured: true,
      score: pct1(score),
      record_part: recordPart == null ? null : pct1(recordPart),
      kpi_part: kpiPart == null ? null : pct1(kpiPart),
      blend: hasRecord && hasKpi ? { record: dimBlend.record, kpi: dimBlend.kpi, kind: dimBlend.kind } : null,
      kpi_basis: kpiBasis,
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
      /*
       * ═══ THE THREE VARIANTS (CMDB-116) ═══
       *
       * A naked composite is the most dangerous thing this module can produce:
       * it is a number somebody will screenshot. The same arithmetic is
       * therefore published three ways, each qualified by what it does NOT
       * account for, so the figure cannot be quoted without its caveat.
       *
       *   raw       the arithmetic, and nothing else.
       *   coverage  the arithmetic over the weight actually measured.
       *   gate      whether the arithmetic means anything at all.
       *
       * The GATE variant is the one that matters and is marked `dominant`: when
       * the trust gate is open, the other two are describing a number nobody
       * should be acting on yet. CMDB-116 is `derived` and deducts nothing — this
       * is presentation, not scoring.
       */
      variants: composite == null ? [] : [
        {
          key: 'raw',
          label: 'Composite',
          value: composite,
          qualifier: `Σ weight × dimension over the ${measuredWeight} weight measured`,
          caveat: 'The arithmetic alone. It does not say how much of the model was measured, or whether the measurement can be trusted.',
          dominant: false,
        },
        {
          key: 'coverage',
          label: coverageProvisional ? 'Coverage-qualified' : 'Full coverage',
          value: composite,
          qualifier: `${measuredWeight} of 100 weight measured`,
          caveat: coverageProvisional
            ? `${100 - measuredWeight} of 100 weight was NOT measured on this run, so this figure describes ${measuredWeight}% of the model and says nothing about the rest.`
            : 'Every dimension produced a measurement on this run.',
          dominant: false,
        },
        {
          key: 'gate',
          label: gateProvisional ? 'Not trustworthy yet' : 'Trustworthy',
          value: gateProvisional ? null : composite,
          qualifier: gateProvisional
            ? `${blockers.length} trust blocker(s): ${[...new Set(blockers.map((b) => b.rule_id))].join(', ')}`
            : 'No trust blocker',
          caveat: gateProvisional
            ? 'The trust gate is OPEN. Configuration the score depends on is missing or a measured capability has failed, so the number above is arithmetic over data that cannot yet carry it. Clear the blockers before quoting a score.'
            : 'Nothing invalidates what this score means.',
          dominant: true,
        },
      ],
      weights_caveat: 'The dimension weights are SAOS defaults and have not been reviewed by this customer (CMDB-116 false-positive guard).',
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
