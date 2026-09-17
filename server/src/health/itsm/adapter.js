import { getITSMRule, SEVERITY_WORDS } from './catalogue.js';

/**
 * ITSM PHASE 3 — the catalogue adapter.
 *
 * The CMDB catalogue (`health/catalogue/cmdb.json`) and the ITSM catalogue
 * (`health/rules/itsm/catalogue.json`) do not share a schema. CMDB entries
 * carry derived, engine-ready fields — `base: 'CRITICAL'`, `lane: 2`, `kind`,
 * `track`, `systemicKind` — and `cmdb-quality.js` reads them directly. ITSM
 * entries are the workbook verbatim: `base_severity: 'Critical'`,
 * `remediation_lane: 'Lane 1 where unambiguous, Lane 3 otherwise'`, no
 * `kind`, no `track`.
 *
 * This adapter is the ONE place the two vocabularies meet. It exists so that
 * neither catalogue has to change shape to be read by the other's code, and
 * so that every mapping is a named, tested table rather than a `.toUpperCase()`
 * somewhere. The CMDB path (`catalogueRule`, `addCatalogued`, `effectiveBand`)
 * is untouched.
 */

/**
 * THE SEVERITY MAPPING.
 *
 * Workbook word → engine band. Four of five are the same word upper-cased; the
 * fifth is not: the workbook (and the Schema tab of every SAOS tracker) says
 * **Moderate**, and the engine key is **MEDIUM** — `health/rules.js` keeps the
 * key so stored runs keep their meaning and labels it "Moderate" for display.
 * The weights agree on both sides (100 / 40 / 15 / 5 / 1) and are NOT
 * re-declared here: severity weight is a scoring decision, and scoring is not
 * this phase's.
 *
 * Both directions are explicit and total over their vocabularies. An input
 * outside them throws — a mis-cased "critical" from a hand-edited catalogue
 * must not become a Low finding by falling through a default.
 */
export const SEVERITY_WORD_TO_BAND = Object.freeze({
  Systemic: 'SYSTEMIC',
  Critical: 'CRITICAL',
  High: 'HIGH',
  Moderate: 'MEDIUM',
  Low: 'LOW',
});

export const BAND_TO_SEVERITY_WORD = Object.freeze(
  Object.fromEntries(Object.entries(SEVERITY_WORD_TO_BAND).map(([w, b]) => [b, w])),
);

export const ENGINE_BANDS = Object.freeze(['SYSTEMIC', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

export class AdapterError extends Error {
  constructor(message) { super(message); this.name = 'AdapterError'; }
}

export function toEngineBand(word) {
  const band = SEVERITY_WORD_TO_BAND[word];
  if (!band) throw new AdapterError(`"${word}" is not a workbook severity (${SEVERITY_WORDS.join(', ')})`);
  return band;
}

export function toSeverityWord(band) {
  const word = BAND_TO_SEVERITY_WORD[band];
  if (!word) throw new AdapterError(`"${band}" is not an engine severity band (${ENGINE_BANDS.join(', ')})`);
  return word;
}

/**
 * Which lanes a workbook `remediation_lane` names — as a SET, in the order
 * written, with the text kept. "Lane 1 where unambiguous, Lane 3 otherwise" is
 * `{ lanes: [1, 3], text }`, not `1`. Choosing one lane is a remediation
 * decision for a later phase; this only reads what is written.
 */
export function parseLanes(text) {
  const lanes = [];
  for (const m of String(text || '').matchAll(/\bLane\s+([123])\b/g)) {
    const n = Number(m[1]);
    if (!lanes.includes(n)) lanes.push(n);
  }
  return Object.freeze({ lanes: Object.freeze(lanes), text: text ?? null });
}

/**
 * The engine-facing view of one ITSM rule.
 *
 * Field names follow the CMDB catalogue's camelCase where the meaning is the
 * same (`title`, `base`, `whatItMeans`, `detectionLogic`, …) so a future shared
 * consumer sees one shape; the workbook's own text is kept under `workbook` so
 * nothing is lost in the translation. Fields the CMDB catalogue derives and the
 * workbook does not state — `kind`, `track`, `dimension`, `systemicKind`,
 * an integer `lane` — are deliberately ABSENT, not defaulted.
 */
export function adaptRule(idOrRule) {
  const r = typeof idOrRule === 'string' ? getITSMRule(idOrRule) : idOrRule;
  return Object.freeze({
    id: r.id,
    slot: r.slot,
    domain: 'ITSM',
    group: r.group,
    title: r.rule,
    base: toEngineBand(r.base_severity),
    baseWord: r.base_severity,
    whatItMeans: r.what_it_means,
    whyItMatters: r.why_it_matters,
    sourceTables: r.source_tables_fields,
    detectionLogic: r.detection_logic,
    threshold: r.threshold_parameter,
    confidenceBasis: r.confidence_basis,
    evidenceToShow: r.evidence_to_show,
    falsePositiveGuard: r.false_positive_guard,
    remediationLane: parseLanes(r.remediation_lane),
    crossDomainLink: r.cross_domain_link,
    implementationStatus: r.implementation_status,
    validationStatus: r.validation_status,
    architecture: r.architecture,
    workbook: r,
  });
}
