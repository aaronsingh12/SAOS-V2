import catalogueJson from '../rules/itsm/catalogue.json' with { type: 'json' };
import architectureJson from '../rules/itsm/architecture-map.json' with { type: 'json' };

/**
 * ITSM PHASE 3 — the rule-as-data loader.
 *
 * The catalogue (`rules/itsm/catalogue.json`, 139 rules transcribed from the
 * SAOS tracker) and the architecture map (`architecture-map.json`, one
 * classification per rule) are DATA. This module is the only way the running
 * code reads them, and it validates both on first use so a hand edit that
 * drops a rule, doubles an id or breaks the slot order fails at boot rather
 * than as a missing finding nobody notices.
 *
 * Identity is the slot: rule n is `ITSM-nnn`, is `rules[n-1]` in the catalogue,
 * and came from Excel row n+1. All three are asserted, every load.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not execute anything, and it is not
 * imported by the health engine (`health/rules.js`, `health/index.js`) or by
 * any route. Phase 4 connects specific rules to engines; until then the eleven
 * hard-coded ITSM rules in `rules.js` are what runs.
 */

export const ITSM_RULE_COUNT = 139;
export const ITSM_ID_PATTERN = /^ITSM-(\d{3})$/;

/* The sixteen fields the workbook's Schema sheet defines — required on every rule. */
export const REQUIRED_RULE_FIELDS = Object.freeze([
  'id', 'group', 'rule', 'base_severity', 'what_it_means', 'why_it_matters',
  'source_tables_fields', 'detection_logic', 'threshold_parameter', 'confidence_basis',
  'evidence_to_show', 'false_positive_guard', 'remediation_lane', 'cross_domain_link',
  'implementation_status', 'validation_status',
]);

export const SEVERITY_WORDS = Object.freeze(['Systemic', 'Critical', 'High', 'Moderate', 'Low']);

export class CatalogueError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = 'CatalogueError';
    this.detail = detail;
  }
}

const idFor = (slot) => `ITSM-${String(slot).padStart(3, '0')}`;
export const slotOf = (id) => {
  const m = ITSM_ID_PATTERN.exec(String(id || ''));
  return m ? Number(m[1]) : null;
};

/**
 * Validate the catalogue shape. Pure; exported so the suite can feed it a
 * broken copy and see it refuse.
 */
export function validateCatalogue(cat) {
  if (!cat || !Array.isArray(cat.rules)) throw new CatalogueError('the ITSM catalogue has no rules array');
  if (cat.rules.length !== ITSM_RULE_COUNT) {
    throw new CatalogueError(`the ITSM catalogue holds ${cat.rules.length} rules, expected ${ITSM_RULE_COUNT}`);
  }
  const seen = new Set();
  cat.rules.forEach((r, i) => {
    const expected = idFor(i + 1);
    if (r.id !== expected) throw new CatalogueError(`catalogue rules[${i}] is ${JSON.stringify(r.id)}, expected ${expected}`, { index: i });
    if (seen.has(r.id)) throw new CatalogueError(`duplicate rule id ${r.id}`);
    seen.add(r.id);
    if (r.excel_row !== i + 2) throw new CatalogueError(`${r.id}: excel_row ${r.excel_row} is not ${i + 2}`);
    for (const f of REQUIRED_RULE_FIELDS) {
      if (typeof r[f] !== 'string' || !r[f].trim()) throw new CatalogueError(`${r.id}: required field "${f}" is empty`);
    }
    if (!SEVERITY_WORDS.includes(r.base_severity)) throw new CatalogueError(`${r.id}: base_severity "${r.base_severity}" is not a workbook band`);
  });
  return true;
}

export function validateArchitecture(map, cat) {
  if (!map || !Array.isArray(map.entries)) throw new CatalogueError('the architecture map has no entries array');
  if (map.entries.length !== ITSM_RULE_COUNT) throw new CatalogueError(`the architecture map holds ${map.entries.length} entries, expected ${ITSM_RULE_COUNT}`);
  if (map.workbook_sha256 !== cat.source?.workbook_sha256) {
    throw new CatalogueError('the architecture map was built from a different workbook than the catalogue');
  }
  const archetypes = new Set(Object.keys(map.vocabularies?.archetypes || {}));
  const engines = new Set(Object.keys(map.vocabularies?.engines || {}));
  map.entries.forEach((e, i) => {
    if (e.slot !== i + 1 || e.rule_id !== idFor(i + 1)) throw new CatalogueError(`architecture entries[${i}] is slot ${e.slot} / ${e.rule_id}`);
    if (!archetypes.has(e.archetype)) throw new CatalogueError(`${e.rule_id}: unknown archetype ${e.archetype}`);
    if (!engines.has(e.recommended_engine)) throw new CatalogueError(`${e.rule_id}: unknown engine ${e.recommended_engine}`);
  });
  return true;
}

let loaded = null;

/**
 * Load, validate once, and freeze. Every accessor goes through here.
 *
 * `source` is a test seam: the suite passes a deliberately broken catalogue
 * to see the loader refuse, and never touches the real files.
 */
export function loadCatalogue({ catalogue = catalogueJson, architecture = architectureJson, force = false } = {}) {
  if (loaded && !force && catalogue === catalogueJson && architecture === architectureJson) return loaded;
  validateCatalogue(catalogue);
  validateArchitecture(architecture, catalogue);
  const byId = new Map();
  const rules = catalogue.rules.map((r, i) => {
    const arch = architecture.entries[i];
    const rule = Object.freeze({
      ...r,
      slot: i + 1,
      architecture: Object.freeze({
        archetype: arch.archetype,
        engine: arch.recommended_engine,
        also_requires: Object.freeze([...arch.also_requires]),
        semantic_class: arch.semantic_class,
        evaluation_level: arch.evaluation_level,
        tables: Object.freeze([...arch.tables]),
        candidate_tables: Object.freeze([...arch.candidate_tables]),
        tables_undefined: arch.tables_undefined,
        fields: Object.freeze([...arch.fields]),
        data_requirements: Object.freeze({ ...arch.data_requirements }),
        existing_engine_support: arch.existing_engine_support,
        dependencies: Object.freeze({
          consumes_output_of: Object.freeze([...arch.dependencies.consumes_output_of]),
          interpret_with: Object.freeze([...arch.dependencies.interpret_with]),
          related: Object.freeze([...arch.dependencies.related]),
          external: Object.freeze([...arch.dependencies.external]),
        }),
        result: Object.freeze({ ...arch.result }),
        volume: arch.volume,
        scale_risk: arch.scale_risk,
        complexity: arch.complexity,
        time_window: arch.time_window,
      }),
    });
    byId.set(rule.id, rule);
    return rule;
  });
  const result = Object.freeze({
    meta: Object.freeze({
      catalogue_version: catalogue.catalogue_version,
      workbook: catalogue.source.workbook,
      workbook_sha256: catalogue.source.workbook_sha256,
      generated: catalogue.generated,
      map_version: architecture.map_version,
      rule_count: rules.length,
      id_range: Object.freeze({ ...catalogue.id_range }),
      groups_observed: Object.freeze([...catalogue.groups_observed]),
      severity_bands: Object.freeze(catalogue.schema.severity_bands.map((b) => Object.freeze({ ...b }))),
    }),
    rules: Object.freeze(rules),
    byId,
  });
  if (catalogue === catalogueJson && architecture === architectureJson) loaded = result;
  return result;
}

/** Rule by id — `getITSMRule('ITSM-001')`. Unknown or malformed ids throw; nothing is guessed. */
export function getITSMRule(id) {
  const rule = loadCatalogue().byId.get(id);
  if (!rule) {
    const slot = slotOf(id);
    throw new CatalogueError(slot == null
      ? `${JSON.stringify(id)} is not an ITSM rule id (expected ITSM-001 … ITSM-${ITSM_RULE_COUNT})`
      : `${id} is outside the catalogue (ITSM-001 … ITSM-${ITSM_RULE_COUNT})`);
  }
  return rule;
}

export function hasITSMRule(id) {
  return loadCatalogue().byId.has(id);
}

/** All rules, in slot order. The array is frozen; treat it as read-only. */
export function getAllITSMRules() {
  return loadCatalogue().rules;
}

/** Rule by slot — `getITSMRuleBySlot(1)` is ITSM-001. */
export function getITSMRuleBySlot(slot) {
  const n = slot;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > ITSM_RULE_COUNT) {
    throw new CatalogueError(`slot ${JSON.stringify(slot)} is outside 1 … ${ITSM_RULE_COUNT}`);
  }
  return loadCatalogue().rules[n - 1];
}

/** Catalogue and map metadata: versions, workbook hash, bands. */
export function getITSMCatalogueMeta() {
  return loadCatalogue().meta;
}

/** Rules whose architecture names this engine as primary (or as support when `includeSupporting`). */
export function rulesForEngine(engineKey, { includeSupporting = false } = {}) {
  return getAllITSMRules().filter((r) => r.architecture.engine === engineKey
    || (includeSupporting && r.architecture.also_requires.includes(engineKey)));
}
