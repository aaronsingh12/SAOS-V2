import crypto from 'node:crypto';
import { getDb } from '../memory/db.js';
import { ruleCatalogue, getCatalogueRule, isCatalogueRule, publicRule } from './rule-catalogue.js';

/**
 * HEALTH FINDING DIMENSIONS — the one authoritative resolution layer.
 *
 * A dimension is a THEME that groups RULES ("Ownership & Accountability"). It is
 * not a finding, a severity, a score, a lifecycle state or a fix, and it is not
 * the AREA/domain: the area says which pack produced a finding, the dimension
 * says what kind of problem it is, so CMDB-OWNER and ITSM-INC-UNASSIGNED share
 * a dimension while keeping their own areas.
 *
 *   rule_id ──► health_dimension_rules ──► health_dimensions
 *
 * Everything is resolved at READ time. No finding row is written, ever — which
 * is why a mapping edited today reclassifies yesterday's findings at once, and
 * why deleting a dimension cannot lose a finding: it only removes a view.
 *
 * ONE FINDING, MANY VIEWS. A rule may sit in several dimensions, so one finding
 * may appear under several. It is still one row, one fingerprint, one lifecycle
 * state and one fix; dimension totals may therefore sum to more than the number
 * of findings, and the API says so rather than hiding it.
 *
 * UNCLASSIFIED is a SYSTEM dimension with no mappings of its own: it is every
 * rule no dimension claims — including a rule added to the engine tomorrow that
 * nobody has classified yet. A finding is never dropped for want of a mapping.
 *
 * THE BUILT-IN TAXONOMY IS CODE. Its definitions and rule mappings live below,
 * reviewed like any other code, and are synced into the tables so that one SQL
 * path serves built-in and custom dimensions alike. The API cannot edit or
 * delete a built-in, so a release can change the taxonomy without a user's
 * edit silently disagreeing with it.
 *
 * NOTHING HERE TALKS TO THE INSTANCE OR A MODEL. AI assistance for designing a
 * custom dimension lives in dimension-assist.js and only ever proposes; a saved
 * mapping is deterministic data.
 *
 * TWO THINGS ARE CALLED "DIMENSION" IN health/, AND THEY ARE NOT THE SAME.
 * This module is the FINDING dimension (the classification above; formerly
 * "category", renamed by migration 31). The CMDB Quality score has its own ten
 * QUALITY dimensions, D1 Completeness … D10 Consumption (cmdb-quality.js), which
 * a CMDB catalogue rule names in its `dimension` field. This module never reads
 * or writes scoring; where it exposes a rule's D1–D10 value it calls it
 * `qualityDimension`, so the two can never be confused in an API.
 */

export const UNCLASSIFIED_ID = 'unclassified';

export const DIMENSION_TYPES = Object.freeze({ BUILT_IN: 'built_in', CUSTOM: 'custom', SYSTEM: 'system' });
export const MAPPING_SOURCES = Object.freeze(['manual', 'matcher', 'ai']);

export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 1000;
export const RULES_MAX = 400;

/* ------------------------------------------------------------------ *
 * The built-in taxonomy
 * ------------------------------------------------------------------ */

export const BUILTIN_DIMENSIONS = Object.freeze([
  { id: 'ownership-accountability', name: 'Ownership & Accountability',
    description: 'Problems involving ownership, assignment responsibility, accountability, or missing responsible parties.' },
  { id: 'missing-incomplete-data', name: 'Missing / Incomplete Data',
    description: 'Required or important data is missing, blank, incomplete, or insufficient.' },
  { id: 'wrong-invalid-data', name: 'Wrong / Invalid Data',
    description: 'Data exists but is incorrect, invalid, inconsistent, or violates expected rules.' },
  { id: 'duplicates-identity', name: 'Duplicates & Identity',
    description: 'Duplicate records, identity collisions, duplicate CIs, or identity-quality problems.' },
  { id: 'relationships-impact', name: 'Relationships & Impact Analysis',
    description: 'Missing, incorrect, broken, or incomplete relationships between records, CIs and services.' },
  { id: 'stale-not-refreshed', name: 'Stale / Not Refreshed',
    description: 'Data or records are outdated, stale, or not being refreshed appropriately.' },
  { id: 'lifecycle-retirement', name: 'Lifecycle & Retirement',
    description: 'Lifecycle state, retirement, decommissioning, obsolete records, or lifecycle management problems.' },
  { id: 'service-model-csdm', name: 'Service Model (CSDM)',
    description: 'Service modelling and CSDM-related structural or semantic problems.' },
  { id: 'work-not-linked-to-ci', name: 'Work Not Linked to CI',
    description: 'Incidents, problems, changes or other work records that lack the CI or service they concern.' },
  { id: 'work-stuck-sla-backlog', name: 'Work Stuck / SLA & Backlog',
    description: 'Stuck or overdue work, SLA problems, backlog accumulation, or workflow delays.' },
  { id: 'change-control-compliance', name: 'Change Control & Compliance',
    description: 'Change management, control, compliance, approval, or change-process issues.' },
  { id: 'governance-attestation', name: 'Governance & Attestation',
    description: 'Governance, certification, attestation, ownership verification, audit, and control evidence.' },
  { id: 'discovery-itom-machinery', name: 'Discovery & ITOM Machinery',
    description: 'Discovery, identification, operational data collection, infrastructure monitoring, and ITOM mechanism problems.' },
  { id: 'security-access', name: 'Security & Access',
    description: 'Security, access control, authorisation, ACLs, permissions, or security-related health problems.' },
  { id: 'customization-platform-risk', name: 'Customization & Platform Risk',
    description: 'Unsafe or custom platform behaviour, excessive customisation, technical debt, or platform-risk findings.' },
]);

export const UNCLASSIFIED = Object.freeze({
  id: UNCLASSIFIED_ID, name: 'Unclassified',
  description: 'Rules no dimension claims yet — including rules added to Health Assist after the taxonomy was last reviewed. Their findings work exactly as any other; they are simply not grouped.',
});

/*
 * RULE → BUILT-IN DIMENSIONS.
 *
 * Classified from each rule's catalogue definition (title, what it means,
 * group, CMDB quality dimension), never from a finding. Multi-label only where the rule's
 * own definition names both themes. A rule absent here is Unclassified ON
 * PURPOSE — "cannot say with confidence" is the honest answer for, e.g., the
 * reopen-rate and problem-effectiveness rules, which measure process outcomes
 * no theme below describes.
 *
 * Short keys keep 325 lines reviewable; `health-dimensions.test.js` asserts
 * every key is a built-in and every rule id is in the catalogue.
 */
const K = Object.freeze({
  own: 'ownership-accountability', missing: 'missing-incomplete-data', invalid: 'wrong-invalid-data',
  dup: 'duplicates-identity', rel: 'relationships-impact', stale: 'stale-not-refreshed',
  life: 'lifecycle-retirement', csdm: 'service-model-csdm', unlinked: 'work-not-linked-to-ci',
  stuck: 'work-stuck-sla-backlog', change: 'change-control-compliance', gov: 'governance-attestation',
  disc: 'discovery-itom-machinery', sec: 'security-access', custom: 'customization-platform-risk',
});

const RULE_THEMES = {
  /* ── CMDB catalogue · G1 health configuration meta — governance of the CMDB health machinery ── */
  'CMDB-001': 'gov', 'CMDB-002': 'gov', 'CMDB-003': 'gov', 'CMDB-004': 'gov', 'CMDB-005': 'gov',
  'CMDB-006': 'gov', 'CMDB-007': 'gov', 'CMDB-008': 'gov', 'CMDB-009': 'gov stale', 'CMDB-010': 'gov',
  'CMDB-011': 'gov', 'CMDB-139': 'gov',
  /* ── G2 completeness (D1) ── */
  'CMDB-012': 'missing', 'CMDB-013': 'missing', 'CMDB-014': 'missing', 'CMDB-015': 'missing',
  'CMDB-016': 'missing', 'CMDB-017': 'missing invalid', 'CMDB-018': 'missing', 'CMDB-019': 'missing',
  'CMDB-020': 'missing', 'CMDB-021': 'missing', 'CMDB-022': 'missing', 'CMDB-140': 'missing dup',
  /* ── G3 correctness (D2) ── */
  'CMDB-023': 'invalid life', 'CMDB-024': 'invalid life', 'CMDB-025': 'invalid', 'CMDB-026': 'invalid disc',
  'CMDB-027': 'invalid', 'CMDB-028': 'invalid', 'CMDB-029': 'invalid', 'CMDB-030': 'invalid',
  'CMDB-031': 'invalid', 'CMDB-032': 'invalid',
  /* ── G4 uniqueness (D3) ── */
  'CMDB-033': 'dup', 'CMDB-034': 'dup', 'CMDB-035': 'dup', 'CMDB-036': 'dup', 'CMDB-037': 'dup',
  'CMDB-038': 'dup', 'CMDB-039': 'dup disc', 'CMDB-040': 'dup', 'CMDB-041': 'dup', 'CMDB-042': 'dup stuck',
  'CMDB-043': 'dup',
  /* ── G5 identification (D4: can IRE tell CIs apart) and reconciliation (D5: which source wins) ── */
  'CMDB-044': 'dup disc', 'CMDB-045': 'dup disc', 'CMDB-046': 'dup disc', 'CMDB-047': 'dup disc',
  'CMDB-050': 'dup disc', 'CMDB-053': 'dup disc', 'CMDB-054': 'dup disc',
  'CMDB-048': 'disc', 'CMDB-049': 'disc stale', 'CMDB-051': 'disc', 'CMDB-052': 'disc', 'CMDB-055': 'disc',
  /* ── G6 relationships (D6) ── */
  'CMDB-056': 'rel', 'CMDB-057': 'rel', 'CMDB-058': 'rel', 'CMDB-059': 'rel', 'CMDB-060': 'rel',
  'CMDB-061': 'rel life', 'CMDB-062': 'rel invalid', 'CMDB-063': 'rel invalid', 'CMDB-064': 'rel invalid',
  'CMDB-065': 'rel invalid', 'CMDB-066': 'rel stale', 'CMDB-067': 'rel', 'CMDB-068': 'rel', 'CMDB-069': 'rel dup',
  /* ── G7 freshness and source coverage (D7) ── */
  'CMDB-070': 'stale disc', 'CMDB-071': 'disc', 'CMDB-072': 'stale disc', 'CMDB-073': 'invalid disc',
  'CMDB-074': 'disc', 'CMDB-075': 'stale', 'CMDB-076': 'stale disc', 'CMDB-077': 'stale', 'CMDB-078': 'disc',
  'CMDB-079': 'disc', 'CMDB-142': 'stale', 'CMDB-143': 'stale',
  /* ── G8 lifecycle and retirement (D8) ── */
  'CMDB-080': 'life rel', 'CMDB-081': 'life csdm', 'CMDB-082': 'life invalid', 'CMDB-083': 'life rel',
  'CMDB-084': 'life', 'CMDB-085': 'life', 'CMDB-086': 'life invalid', 'CMDB-087': 'life invalid',
  'CMDB-088': 'life', 'CMDB-089': 'life stale', 'CMDB-090': 'life',
  /* ── G9 Data Manager and attestation ── */
  'CMDB-091': 'gov', 'CMDB-092': 'gov', 'CMDB-093': 'gov own', 'CMDB-094': 'gov own', 'CMDB-095': 'gov',
  'CMDB-096': 'gov', 'CMDB-097': 'gov', 'CMDB-098': 'gov', 'CMDB-099': 'gov', 'CMDB-100': 'gov dup',
  'CMDB-101': 'gov life',
  /* ── G10 ownership (D9) ── */
  'CMDB-102': 'own', 'CMDB-103': 'own', 'CMDB-104': 'own', 'CMDB-105': 'own', 'CMDB-106': 'own',
  'CMDB-107': 'own', 'CMDB-108': 'own',
  /* ── G11 CSDM linkage ── */
  'CMDB-109': 'csdm rel', 'CMDB-110': 'csdm rel', 'CMDB-111': 'csdm invalid', 'CMDB-112': 'csdm',
  'CMDB-113': 'csdm rel', 'CMDB-114': 'csdm rel', 'CMDB-115': 'csdm',
  /* ── G12 consumption and trust. CMDB-116 (the trust score itself) and CMDB-121
     (CIs no task references) describe use of the CMDB, which no theme covers. ── */
  'CMDB-117': 'unlinked csdm', 'CMDB-118': 'unlinked', 'CMDB-119': 'custom', 'CMDB-120': 'custom',
  'CMDB-122': 'custom', 'CMDB-123': 'custom missing', 'CMDB-141': 'rel csdm',
  /* ── G13 scale and platform impact ── */
  'CMDB-124': 'custom rel', 'CMDB-125': 'custom', 'CMDB-126': 'custom', 'CMDB-127': 'custom',
  'CMDB-128': 'custom', 'CMDB-129': 'custom', 'CMDB-130': 'custom',
  /* ── G14 drift. CMDB-131/132/137 measure the findings and the score themselves,
     not a kind of defect, so they stay Unclassified. ── */
  'CMDB-133': 'dup disc', 'CMDB-134': 'dup', 'CMDB-135': 'stale', 'CMDB-136': 'rel', 'CMDB-138': 'gov',

  /* ── ITSM catalogue · 1A incident configuration and design ── */
  'ITSM-003': 'stuck', 'ITSM-004': 'own', 'ITSM-005': 'invalid', 'ITSM-006': 'invalid', 'ITSM-008': 'invalid',
  'ITSM-009': 'stuck', 'ITSM-011': 'own', 'ITSM-012': 'stuck', 'ITSM-013': 'stuck custom', 'ITSM-014': 'custom missing',
  /* ── 1B incident data quality ── */
  'ITSM-016': 'unlinked', 'ITSM-017': 'unlinked csdm', 'ITSM-018': 'own', 'ITSM-019': 'unlinked life',
  'ITSM-020': 'missing', 'ITSM-021': 'missing', 'ITSM-022': 'invalid', 'ITSM-023': 'missing',
  'ITSM-024': 'invalid', 'ITSM-025': 'invalid', 'ITSM-026': 'missing', 'ITSM-027': 'missing',
  'ITSM-028': 'sec', 'ITSM-029': 'missing',
  /* ── 1C incident process behaviour ── */
  'ITSM-032': 'own stuck', 'ITSM-033': 'stuck', 'ITSM-034': 'stuck', 'ITSM-035': 'stuck', 'ITSM-037': 'stuck',
  'ITSM-042': 'own', 'ITSM-043': 'missing',
  /* ── 1D major incident ── */
  'ITSM-049': 'unlinked csdm', 'ITSM-050': 'stuck', 'ITSM-052': 'stuck',
  /* ── 2A/2B/2C problem ── */
  'ITSM-056': 'stuck', 'ITSM-061': 'stuck', 'ITSM-062': 'missing', 'ITSM-063': 'missing', 'ITSM-065': 'own',
  'ITSM-067': 'unlinked', 'ITSM-068': 'stuck', 'ITSM-069': 'invalid', 'ITSM-070': 'missing', 'ITSM-073': 'invalid',
  /* ── 3A change configuration and control design ── */
  'ITSM-080': 'change', 'ITSM-081': 'change', 'ITSM-082': 'change', 'ITSM-083': 'change', 'ITSM-084': 'change',
  'ITSM-085': 'change', 'ITSM-086': 'change', 'ITSM-087': 'change', 'ITSM-088': 'change own', 'ITSM-089': 'change',
  'ITSM-090': 'change', 'ITSM-091': 'change', 'ITSM-092': 'change', 'ITSM-093': 'change',
  /* ── 3B change data quality ── */
  'ITSM-094': 'change unlinked', 'ITSM-095': 'change unlinked life', 'ITSM-096': 'change missing',
  'ITSM-097': 'change missing', 'ITSM-098': 'change missing', 'ITSM-099': 'change missing',
  'ITSM-100': 'change invalid', 'ITSM-101': 'change own', 'ITSM-102': 'change missing', 'ITSM-103': 'change missing',
  'ITSM-104': 'change missing', 'ITSM-105': 'change unlinked',
  /* ── 3C change process behaviour and control ── */
  'ITSM-106': 'change', 'ITSM-107': 'change', 'ITSM-108': 'change', 'ITSM-109': 'change', 'ITSM-110': 'change',
  'ITSM-111': 'change', 'ITSM-112': 'change', 'ITSM-113': 'change', 'ITSM-114': 'change', 'ITSM-115': 'change',
  'ITSM-116': 'change', 'ITSM-117': 'change', 'ITSM-118': 'change', 'ITSM-119': 'change', 'ITSM-120': 'change stuck',
  'ITSM-121': 'change', 'ITSM-122': 'change',
  /* ── 3D change–incident correlation ── */
  'ITSM-123': 'change', 'ITSM-124': 'change', 'ITSM-125': 'change', 'ITSM-126': 'change unlinked',
  'ITSM-127': 'change', 'ITSM-128': 'change',
  /* ── cross-process and cross-domain ── */
  'ITSM-129': 'unlinked', 'ITSM-130': 'rel', 'ITSM-131': 'change rel', 'ITSM-132': 'stale disc',
  'ITSM-134': 'own', 'ITSM-135': 'own invalid', 'ITSM-136': 'csdm', 'ITSM-137': 'csdm', 'ITSM-138': 'change rel',

  /* ── Health Assist core rules ── */
  'CMDB-OWNER': 'own', 'CMDB-STALE': 'stale', 'CMDB-DUPLICATE': 'dup', 'CMDB-UNRELATED': 'rel',
  'REL-SELF': 'rel invalid', 'REL-DUPLICATE': 'rel dup',
  'CSDM-OWNER': 'csdm own', 'CSDM-LIFECYCLE': 'csdm life missing', 'CSDM-OFFERING': 'csdm',
  'CUSTOM-BEFORE-UPDATE': 'custom', 'INT-HTTP': 'sec', 'PERF-JOB-ERROR': 'custom', 'PERF-ECC-AGE': 'disc',
  'UPGRADE-SKIPPED': 'custom', 'SEC-INACTIVE-ROLE': 'sec',
  'MID-DOWN': 'disc', 'MID-NONE': 'disc', 'MID-NOT-VALIDATED': 'disc', 'MID-NO-CAPABILITY': 'disc', 'MID-ISSUE': 'disc',
  'EVENT-UNBOUND': 'disc', 'DISC-NEVER-RAN': 'disc', 'DISC-FAILED': 'disc', 'DISC-STALE': 'disc stale',
  'DISC-DEVICE-ISSUE': 'disc', 'DISC-LOG-ERROR': 'disc', 'CRED-NONE': 'disc', 'CRED-INACTIVE': 'disc',
  'CRED-ALL-INACTIVE': 'disc', 'SM-NOT-IN-USE': 'disc csdm', 'SM-UNMAPPED': 'disc csdm', 'OUTAGE-OPEN': 'disc',
  'ITSM-INC-UNASSIGNED': 'own', 'ITSM-INC-P1-AGED': 'stuck', 'ITSM-INC-STALE': 'stuck', 'ITSM-INC-NO-CI': 'unlinked',
  'ITSM-CHG-STALE': 'change stuck', 'ITSM-CHG-NO-CI': 'change unlinked', 'ITSM-CHG-OVERDUE': 'change stuck',
  'ITSM-CHG-FAILED': 'change', 'ITSM-PRB-UNASSIGNED': 'own', 'ITSM-PRB-STALE': 'stuck',
};

/** Built-in dimension id → the rule ids it holds, derived from RULE_THEMES. */
export const BUILTIN_RULES = Object.freeze((() => {
  const out = Object.fromEntries(BUILTIN_DIMENSIONS.map((c) => [c.id, []]));
  for (const [ruleId, themes] of Object.entries(RULE_THEMES)) {
    for (const t of themes.split(/\s+/)) {
      const id = K[t];
      if (!id) throw new Error(`dimensions: rule ${ruleId} names an unknown theme "${t}"`);
      out[id].push(ruleId);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Object.freeze(v)]));
})());

const BUILTIN_IDS = new Set(BUILTIN_DIMENSIONS.map((c) => c.id));

/* ------------------------------------------------------------------ *
 * Errors — the route turns `status` into the response code
 * ------------------------------------------------------------------ */

export class DimensionError extends Error {
  constructor(message, status = 422, detail = null) {
    super(message);
    this.name = 'DimensionError';
    this.status = status;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ *
 * Sync of the built-in taxonomy into the tables
 * ------------------------------------------------------------------ */

const nowIso = () => new Date().toISOString();
export const nameKeyOf = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/*
 * Once per database handle per process. Idempotent: it rewrites only the
 * `builtin`-sourced mapping rows of built-in dimensions, which the API can
 * never create, edit or delete — so a user's custom dimension is untouched by
 * it, and running it twice is running it once.
 */
const synced = new WeakSet();

export function syncBuiltinDimensions(db = getDb()) {
  if (synced.has(db)) return;
  const at = nowIso();
  db.exec('BEGIN');
  try {
    const upsert = db.prepare(`
      INSERT INTO health_dimensions (id, name, name_key, description, type, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, name_key = excluded.name_key, description = excluded.description,
        type = excluded.type, updated_at = CASE
          WHEN health_dimensions.name IS excluded.name AND health_dimensions.description IS excluded.description
          THEN health_dimensions.updated_at ELSE excluded.updated_at END
    `);
    /*
     * A custom dimension may already hold a name a later release gives to a
     * built-in. The user's row is not renamed from under them, and the sync
     * must not fail (Health would lose every dimension over one name): the
     * built-in keeps its own id-qualified key instead, and creating a SECOND
     * dimension of that name is still refused, because the custom row holds
     * the plain key.
     */
    const clash = db.prepare('SELECT id FROM health_dimensions WHERE name_key = ? AND id <> ?');
    const keyFor = (c) => (clash.get(nameKeyOf(c.name), c.id) ? `${nameKeyOf(c.name)}#${c.id}` : nameKeyOf(c.name));
    for (const c of BUILTIN_DIMENSIONS) upsert.run(c.id, c.name, keyFor(c), c.description, DIMENSION_TYPES.BUILT_IN, at, at);
    upsert.run(UNCLASSIFIED.id, UNCLASSIFIED.name, keyFor(UNCLASSIFIED), UNCLASSIFIED.description, DIMENSION_TYPES.SYSTEM, at, at);

    /* Only built-in-sourced rows of built-in dimensions are code's to rewrite. */
    db.prepare(`DELETE FROM health_dimension_rules WHERE source = 'builtin'`).run();
    db.prepare(`DELETE FROM health_dimension_rules WHERE dimension_id = ?`).run(UNCLASSIFIED_ID);
    const map = db.prepare(`
      INSERT OR IGNORE INTO health_dimension_rules (dimension_id, rule_id, source, created_at, updated_at)
      VALUES (?, ?, 'builtin', ?, ?)
    `);
    for (const [dimId, rules] of Object.entries(BUILTIN_RULES)) for (const r of rules) map.run(dimId, r, at, at);
    db.exec('COMMIT');
    synced.add(db);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function db() {
  const d = getDb();
  syncBuiltinDimensions(d);
  return d;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

const TYPE_ORDER = { built_in: 0, custom: 1, system: 2 };

function shapeDimension(row, ruleIds) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    type: row.type,
    editable: row.type === DIMENSION_TYPES.CUSTOM,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    rule_count: ruleIds.length,
  };
}

/** Every mapping row, as rule → [dimension ids] and dimension → [rule ids]. */
export function mappingIndex() {
  const rows = db().prepare('SELECT dimension_id, rule_id, source FROM health_dimension_rules').all();
  const byRule = new Map();
  const byDimension = new Map();
  for (const r of rows) {
    if (!byRule.has(r.rule_id)) byRule.set(r.rule_id, []);
    byRule.get(r.rule_id).push(r.dimension_id);
    if (!byDimension.has(r.dimension_id)) byDimension.set(r.dimension_id, []);
    byDimension.get(r.dimension_id).push({ ruleId: r.rule_id, source: r.source });
  }
  return { byRule, byDimension };
}

/** Catalogue rules no dimension claims — what Unclassified holds by definition. */
export function unmappedCatalogueRules(index = mappingIndex()) {
  return ruleCatalogue().filter((r) => !index.byRule.has(r.ruleId)).map((r) => r.ruleId);
}

/** Every dimension, built-ins first, then custom by name, then Unclassified. */
export function listDimensions() {
  const index = mappingIndex();
  const rows = db().prepare('SELECT * FROM health_dimensions').all();
  const unmapped = unmappedCatalogueRules(index);
  return rows
    .map((row) => shapeDimension(row, row.id === UNCLASSIFIED_ID ? unmapped : (index.byDimension.get(row.id) || []).map((m) => m.ruleId)))
    .sort((a, b) => (TYPE_ORDER[a.type] - TYPE_ORDER[b.type])
      || (a.type === 'built_in' ? builtinOrder(a.id) - builtinOrder(b.id) : a.name.localeCompare(b.name)));
}

const builtinOrder = (id) => BUILTIN_DIMENSIONS.findIndex((c) => c.id === id);

export function dimensionExists(id) {
  return Boolean(db().prepare('SELECT 1 FROM health_dimensions WHERE id = ?').get(String(id ?? '')));
}

/** One dimension with its rules, each described by the catalogue. */
export function getDimension(id) {
  const row = db().prepare('SELECT * FROM health_dimensions WHERE id = ?').get(String(id ?? ''));
  if (!row) return null;
  const index = mappingIndex();
  const mappings = row.id === UNCLASSIFIED_ID
    ? unmappedCatalogueRules(index).map((ruleId) => ({ ruleId, source: 'fallback' }))
    : (index.byDimension.get(row.id) || []);
  return {
    ...shapeDimension(row, mappings.map((m) => m.ruleId)),
    rules: mappings.map((m) => ({
      ...(publicRule(getCatalogueRule(m.ruleId)) || { ruleId: m.ruleId, title: m.ruleId, unknown: true }),
      mapping_source: m.source,
      dimensions: index.byRule.get(m.ruleId) || [],
    })),
  };
}

/** The dimension ids one rule resolves to — Unclassified when none claims it. */
export function dimensionsForRule(ruleId, index = mappingIndex()) {
  const ids = index.byRule.get(String(ruleId ?? ''));
  return ids?.length ? [...ids] : [UNCLASSIFIED_ID];
}

/**
 * The SQL fragment that restricts a health_findings query to one dimension.
 *
 * A subquery over the mapping table rather than an IN list built in memory:
 * the database does the join, the dimension value is always a bound parameter,
 * and an edit made a second ago is what the next query sees.
 */
export function dimensionClause(id) {
  const key = String(id ?? '');
  if (!dimensionExists(key)) throw new DimensionError(`No such dimension "${key}".`, 404);
  if (key === UNCLASSIFIED_ID) {
    return { clause: 'rule_id NOT IN (SELECT rule_id FROM health_dimension_rules)', args: [] };
  }
  return { clause: 'rule_id IN (SELECT rule_id FROM health_dimension_rules WHERE dimension_id = ?)', args: [key] };
}

/**
 * Per-dimension totals from per-(rule, severity) counts.
 *
 * `rows` is `[{ rule_id, severity, domain?, n }]` — one GROUP BY over the scoped
 * findings (store.js), never one query per dimension. A rule in two dimensions
 * counts in both, so the per-dimension totals may sum past `total`; `total` is
 * the number of distinct findings and is reported beside them, with
 * `severityTotals` — the distinct findings per severity.
 *
 * Per dimension it also keeps the counts by RULE (its top rules) and by DOMAIN
 * (the areas its findings come from). Both are the same rows regrouped, so
 * they sum exactly to the dimension's total.
 */
export function expandCounts(rows, { index = mappingIndex() } = {}) {
  const counts = new Map();
  const add = (m, k, n) => m.set(k, (m.get(k) || 0) + n);
  const bump = (id, r, n) => {
    if (!counts.has(id)) counts.set(id, { total: 0, severity: {}, rules: new Map(), domains: new Map() });
    const c = counts.get(id);
    c.total += n;
    c.severity[r.severity] = (c.severity[r.severity] || 0) + n;
    add(c.rules, r.rule_id, n);
    if (r.domain != null) add(c.domains, r.domain, n);
  };
  let total = 0;
  const severityTotals = {};
  const observedUnmapped = new Set();
  for (const r of rows) {
    const n = Number(r.n) || 0;
    total += n;
    severityTotals[r.severity] = (severityTotals[r.severity] || 0) + n;
    const ids = dimensionsForRule(r.rule_id, index);
    if (ids[0] === UNCLASSIFIED_ID) observedUnmapped.add(r.rule_id);
    for (const id of ids) bump(id, r, n);
  }
  return { counts, total, severityTotals, observedUnmapped: [...observedUnmapped].sort() };
}

/** A count map as `[{ key, n }]`, largest first, ties by key — stable for a UI. */
export function rankedCounts(map, keyName = 'key') {
  return [...(map || new Map())]
    .map(([k, n]) => ({ [keyName]: k, n }))
    .sort((a, b) => b.n - a.n || String(a[keyName]).localeCompare(String(b[keyName])));
}

/* ------------------------------------------------------------------ *
 * Validation of rules supplied by a caller
 * ------------------------------------------------------------------ */

/**
 * Normalise `[ 'CMDB-OWNER', { ruleId, source } ]` into unique, catalogue-
 * checked mappings. The client is never trusted to name a rule: an id the
 * server-side catalogue does not hold is refused, with every offender named.
 */
export function validateRuleList(input, { defaultSource = 'manual' } = {}) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new DimensionError('`rules` must be a list of rule ids.');
  if (input.length > RULES_MAX) throw new DimensionError(`A dimension may hold at most ${RULES_MAX} rules.`);
  const seen = new Map();
  const unknown = [];
  for (const item of input) {
    const ruleId = typeof item === 'string' ? item : item?.ruleId;
    const source = (typeof item === 'object' && item?.source) || defaultSource;
    if (typeof ruleId !== 'string' || !ruleId.trim()) throw new DimensionError('Every rule must be a non-empty rule id.');
    if (!MAPPING_SOURCES.includes(source)) throw new DimensionError(`Unknown mapping source "${source}" — expected ${MAPPING_SOURCES.join(', ')}.`);
    const id = ruleId.trim();
    if (!isCatalogueRule(id)) { unknown.push(id); continue; }
    /* A pair can exist once; a repeated id keeps its first source. */
    if (!seen.has(id)) seen.set(id, source);
  }
  if (unknown.length) {
    throw new DimensionError(
      `${unknown.length === 1 ? 'One rule is' : `${unknown.length} rules are`} not in the rule catalogue: ${unknown.join(', ')}.`,
      422, { unknown_rules: unknown },
    );
  }
  return [...seen].map(([ruleId, source]) => ({ ruleId, source }));
}

function validateText(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw new DimensionError('A dimension needs a name.');
    if (name.length > NAME_MAX) throw new DimensionError(`A dimension name is at most ${NAME_MAX} characters.`);
    out.name = name;
  }
  if (!partial || body.description !== undefined) {
    const description = String(body.description ?? '').trim();
    if (description.length > DESCRIPTION_MAX) throw new DimensionError(`A description is at most ${DESCRIPTION_MAX} characters.`);
    out.description = description;
  }
  return out;
}

function assertNameFree(name, exceptId = null) {
  const clash = db().prepare('SELECT id, name, type FROM health_dimensions WHERE name_key = ?').get(nameKeyOf(name));
  if (clash && clash.id !== exceptId) {
    throw new DimensionError(`A dimension called "${clash.name}" already exists${clash.type === 'custom' ? '' : ' (built in)'}.`, 409);
  }
}

function editableRow(id) {
  const row = db().prepare('SELECT * FROM health_dimensions WHERE id = ?').get(String(id ?? ''));
  if (!row) throw new DimensionError(`No such dimension "${id}".`, 404);
  if (row.type !== DIMENSION_TYPES.CUSTOM) {
    throw new DimensionError(
      row.type === DIMENSION_TYPES.SYSTEM
        ? 'Unclassified is a system dimension: it holds whatever no other dimension claims, so it cannot be edited or deleted.'
        : 'Built-in dimensions are part of the product taxonomy and cannot be edited or deleted. Create a custom dimension instead.',
      403,
    );
  }
  return row;
}

function writeRules(d, dimensionId, rules, at) {
  d.prepare('DELETE FROM health_dimension_rules WHERE dimension_id = ?').run(dimensionId);
  const ins = d.prepare(`
    INSERT INTO health_dimension_rules (dimension_id, rule_id, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const r of rules) ins.run(dimensionId, r.ruleId, r.source, at, at);
}

/* ------------------------------------------------------------------ *
 * Writes — custom dimensions only. None of these touches a finding.
 * ------------------------------------------------------------------ */

export function createDimension(body = {}, { actor = null } = {}) {
  const text = validateText(body);
  const rules = validateRuleList(body.rules);
  assertNameFree(text.name);
  const d = db();
  const id = crypto.randomUUID();
  const at = nowIso();
  d.exec('BEGIN');
  try {
    d.prepare(`
      INSERT INTO health_dimensions (id, name, name_key, description, type, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'custom', ?, ?, ?)
    `).run(id, text.name, nameKeyOf(text.name), text.description, actor, at, at);
    writeRules(d, id, rules, at);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    if (/UNIQUE constraint failed: health_dimensions\.name_key/.test(err.message)) {
      throw new DimensionError(`A dimension called "${text.name}" already exists.`, 409);
    }
    throw err;
  }
  return getDimension(id);
}

export function updateDimension(id, body = {}) {
  const row = editableRow(id);
  const text = validateText(body, { partial: true });
  const rules = body.rules === undefined ? null : validateRuleList(body.rules);
  if (text.name !== undefined) assertNameFree(text.name, row.id);
  const d = db();
  const at = nowIso();
  d.exec('BEGIN');
  try {
    d.prepare(`
      UPDATE health_dimensions
         SET name = COALESCE(?, name), name_key = COALESCE(?, name_key),
             description = COALESCE(?, description), updated_at = ?
       WHERE id = ?
    `).run(text.name ?? null, text.name !== undefined ? nameKeyOf(text.name) : null, text.description ?? null, at, row.id);
    if (rules) writeRules(d, row.id, rules, at);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    if (/UNIQUE constraint failed: health_dimensions\.name_key/.test(err.message)) {
      throw new DimensionError(`A dimension called "${text.name}" already exists.`, 409);
    }
    throw err;
  }
  return getDimension(row.id);
}

/**
 * Removes the dimension and its mappings — and nothing else. Findings, runs,
 * lifecycle states, evidence and proposals have no reference to either table;
 * a rule that loses its only dimension is simply Unclassified again.
 */
export function deleteDimension(id) {
  const row = editableRow(id);
  db().prepare('DELETE FROM health_dimensions WHERE id = ?').run(row.id);
  return { deleted: true, id: row.id, name: row.name };
}

/* ------------------------------------------------------------------ *
 * Smart matchers — deterministic, over the CATALOGUE only
 * ------------------------------------------------------------------ */

export const MATCHER_FIELDS = Object.freeze(['prefix', 'module', 'domain', 'group', 'qualityDimension', 'sourceTable', 'source', 'keyword', 'ruleIds']);
/* The pre-rename spelling of the D1–D10 matcher field, still accepted. */
const MATCHER_ALIASES = Object.freeze({ dimension: 'qualityDimension' });

const asList = (v) => (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]))
  .map((x) => String(x).trim()).filter(Boolean);

/**
 * Rules whose DEFINITION matches every field given. Within a field, any value
 * may match (OR); across fields, all must (AND). `keyword` searches the rule's
 * generic title and meaning — the catalogue's own words, never a finding's.
 * `ruleIds` adds explicit rules on top of whatever the other fields matched.
 * `qualityDimension` is the CMDB Quality dimension a rule scores in (D1–D10),
 * not a finding dimension.
 */
export function matchRules(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DimensionError('A matcher must be an object.');
  const matcher = Object.fromEntries(Object.entries(input).map(([k, v]) => [MATCHER_ALIASES[k] || k, v]));
  const unknownKeys = Object.keys(matcher).filter((k) => !MATCHER_FIELDS.includes(k));
  if (unknownKeys.length) throw new DimensionError(`Unknown matcher field${unknownKeys.length > 1 ? 's' : ''}: ${unknownKeys.join(', ')}. Expected ${MATCHER_FIELDS.join(', ')}.`);

  const f = Object.fromEntries(MATCHER_FIELDS.map((k) => [k, asList(matcher[k])]));
  const explicit = validateRuleList(f.ruleIds).map((r) => r.ruleId);
  const lower = (xs) => xs.map((x) => x.toLowerCase());
  const [prefix, module, domain, group, quality, table, source, keyword] = [
    lower(f.prefix), lower(f.module), lower(f.domain), lower(f.group), lower(f.qualityDimension),
    lower(f.sourceTable), lower(f.source), lower(f.keyword),
  ];
  const anyFilter = [prefix, module, domain, group, quality, table, source, keyword].some((xs) => xs.length);

  const matched = anyFilter ? ruleCatalogue().filter((r) => {
    const id = r.ruleId.toLowerCase();
    if (prefix.length && !prefix.some((p) => id.startsWith(p))) return false;
    if (module.length && !module.includes(String(r.module).toLowerCase())) return false;
    if (domain.length && !domain.includes(String(r.domain ?? '').toLowerCase())) return false;
    if (group.length && !group.some((g) => String(r.group ?? '').toLowerCase() === g
      || String(r.groupName ?? '').toLowerCase().includes(g))) return false;
    if (quality.length && !quality.some((d) => String(r.qualityDimension ?? '').toLowerCase() === d
      || String(r.qualityDimensionLabel ?? '').toLowerCase() === d)) return false;
    if (table.length && !r.sourceTables.some((t) => table.includes(t.toLowerCase()))) return false;
    if (source.length && !source.includes(r.source)) return false;
    if (keyword.length) {
      const text = `${r.title} ${r.whatItMeans}`.toLowerCase();
      if (!keyword.every((k) => text.includes(k))) return false;
    }
    return true;
  }).map((r) => r.ruleId) : [];

  const ids = [...new Set([...matched, ...explicit])];
  return ids.map((id) => publicRule(getCatalogueRule(id)));
}
