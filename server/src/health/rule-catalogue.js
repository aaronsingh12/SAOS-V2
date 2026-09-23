import cmdbCatalogue from './catalogue/cmdb.json' with { type: 'json' };
import { AGENTS } from './rules.js';
import { REMEDIATION } from './remediation.js';
import { scopeOfRule } from './scopes.js';
import { TABLES } from './tables.js';

/**
 * THE UNIFIED RULE CATALOGUE — every rule a health scan can produce a finding
 * for, described by what the RULE is, never by what one finding happened to say.
 *
 * Three sources, because Health Assist grew three ways and none of them holds
 * everything:
 *
 *   cmdb_catalogue   health/catalogue/cmdb.json — the SAOS CMDB tracker, 143 rules
 *   itsm_catalogue   the ITSM tracker, 139 rules — INJECTED by health/index.js
 *                    through registerItsmCatalogueRules(), because only the
 *                    ITSM loader may read that catalogue and only the scan
 *                    facade may import health/itsm (the two BOUNDARY tests)
 *   legacy           the 43 hand-written rules in rules.js (CMDB-OWNER, MID-DOWN,
 *                    ITSM-INC-UNASSIGNED …), described by their human-authored
 *                    REMEDIATION entry
 *
 * Finding dimensions (finding-dimensions.js) are resolved against THIS, not
 * against finding titles. A title can carry a CI name, a record number or a
 * user; a rule's definition cannot, which is also what makes it safe to hand to
 * a model when a dimension is being designed (health/dimension-assist.js).
 *
 * PURE. No socket, no database, no model — the same input always produces the
 * same catalogue, so a test can pin it.
 */

/*
 * The legacy rules carry no metadata of their own beyond their REMEDIATION
 * entry, so where each one reports FROM is stated here: the agent (which
 * decides its domain, via AGENTS) and the table it reads. It mirrors the
 * `this.add(agent, rule, table, …)` calls in rules.js exactly, and
 * `health-dimensions.test.js` holds the two together by reading that source —
 * a rule added there without a line here fails the suite rather than reaching
 * the dimension UI with no domain.
 */
export const LEGACY_RULE_ORIGIN = Object.freeze({
  'CMDB-OWNER': ['cmdb_agent', 'cmdb_ci'],
  'CMDB-STALE': ['cmdb_agent', 'cmdb_ci'],
  'CMDB-DUPLICATE': ['cmdb_agent', 'cmdb_ci'],
  'CMDB-UNRELATED': ['cmdb_agent', 'cmdb_ci'],
  'REL-SELF': ['relationship_agent', 'cmdb_rel_ci'],
  'REL-DUPLICATE': ['relationship_agent', 'cmdb_rel_ci'],
  'CSDM-OWNER': ['csdm_agent', 'cmdb_ci_service'],
  'CSDM-LIFECYCLE': ['csdm_agent', 'cmdb_ci_service'],
  'CSDM-OFFERING': ['csdm_agent', 'cmdb_ci_service'],
  'CUSTOM-BEFORE-UPDATE': ['customization_agent', 'sys_script'],
  'INT-HTTP': ['integration_agent', 'sys_rest_message'],
  'PERF-JOB-ERROR': ['performance_agent', 'sys_trigger'],
  'PERF-ECC-AGE': ['performance_agent', 'ecc_queue'],
  'UPGRADE-SKIPPED': ['upgrade_agent', 'sys_upgrade_history_log'],
  'SEC-INACTIVE-ROLE': ['security_agent', 'sys_user_has_role'],
  'MID-DOWN': ['mid_server_agent', 'ecc_agent'],
  'MID-NONE': ['mid_server_agent', 'ecc_agent'],
  'MID-NOT-VALIDATED': ['mid_server_agent', 'ecc_agent'],
  'MID-NO-CAPABILITY': ['mid_server_agent', 'ecc_agent'],
  'MID-ISSUE': ['mid_server_agent', 'ecc_agent_issue'],
  'EVENT-UNBOUND': ['event_management_agent', 'em_alert'],
  'DISC-NEVER-RAN': ['discovery_agent', 'discovery_status'],
  'DISC-FAILED': ['discovery_agent', 'discovery_status'],
  'DISC-STALE': ['discovery_agent', 'discovery_status'],
  'DISC-DEVICE-ISSUE': ['discovery_agent', 'discovery_device_history'],
  'DISC-LOG-ERROR': ['discovery_agent', 'discovery_log'],
  'CRED-NONE': ['credential_agent', 'discovery_credentials'],
  'CRED-INACTIVE': ['credential_agent', 'discovery_credentials'],
  'CRED-ALL-INACTIVE': ['credential_agent', 'discovery_credentials'],
  'SM-NOT-IN-USE': ['service_mapping_agent', 'svc_ci_assoc'],
  'SM-UNMAPPED': ['service_mapping_agent', 'cmdb_ci_service_discovered'],
  'OUTAGE-OPEN': ['availability_agent', 'cmdb_ci_outage'],
  'ITSM-INC-UNASSIGNED': ['incident_agent', 'incident'],
  'ITSM-INC-P1-AGED': ['incident_agent', 'incident'],
  'ITSM-INC-STALE': ['incident_agent', 'incident'],
  'ITSM-INC-NO-CI': ['incident_agent', 'incident'],
  'ITSM-INC-REOPENED': ['incident_agent', 'incident'],
  'ITSM-CHG-STALE': ['change_agent', 'change_request'],
  'ITSM-CHG-NO-CI': ['change_agent', 'change_request'],
  'ITSM-CHG-OVERDUE': ['change_agent', 'change_request'],
  'ITSM-CHG-FAILED': ['change_agent', 'change_request'],
  'ITSM-PRB-UNASSIGNED': ['problem_agent', 'problem'],
  'ITSM-PRB-STALE': ['problem_agent', 'problem'],
});

export const CATALOGUE_SOURCES = Object.freeze({
  cmdb_catalogue: 'CMDB rule catalogue',
  itsm_catalogue: 'ITSM rule catalogue',
  legacy: 'Health Assist core rules',
});

const DIMENSION_LABEL = Object.freeze(Object.fromEntries(
  (cmdbCatalogue.dimensions || []).map((d) => [d.key, d.label]),
));

/*
 * The allow-listed tables a rule's prose NAMES. The catalogues describe their
 * sources in sentences ("cmdb_recommended_fields (table, recommended, active)
 * for …"), and a matcher needs table names, not sentences. Only names that are
 * real allow-listed tables are kept, so a word that happens to look like an
 * identifier ("table", "active") never becomes a table.
 */
const KNOWN_TABLES = new Set(Object.keys(TABLES));
function tablesNamedIn(text) {
  const out = [];
  for (const tok of String(text || '').match(/\b[a-z][a-z0-9_]{2,}\b/g) || []) {
    if (KNOWN_TABLES.has(tok) && !out.includes(tok)) out.push(tok);
  }
  return out;
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function cmdbEntry(r) {
  return {
    ruleId: r.id,
    title: r.title,
    whatItMeans: r.whatItMeans || '',
    whyItMatters: r.whyItMatters || '',
    source: 'cmdb_catalogue',
    module: scopeOfRule(r.id),
    /* A catalogue rule reports under whichever agent its pack chose, and some
       packs use several, so no single domain is claimed for it. Group and
       dimension are the stable handles. */
    domain: null,
    domainLabel: null,
    sourceTables: tablesNamedIn(r.sourceTables),
    /* The CMDB QUALITY dimension this rule scores in (D1–D10) — not a finding
       dimension (finding-dimensions.js). Named apart so the two never share a key. */
    qualityDimension: r.dimension || null,
    qualityDimensionLabel: r.dimension ? (DIMENSION_LABEL[r.dimension] || null) : null,
    group: `CMDB-G${String(r.group).padStart(2, '0')}`,
    groupName: r.groupName || null,
    baseSeverity: r.base || null,
    track: r.track || null,
  };
}

function itsmEntry(r) {
  return {
    ruleId: r.id,
    title: r.rule,
    whatItMeans: r.what_it_means || '',
    whyItMatters: r.why_it_matters || '',
    source: 'itsm_catalogue',
    module: scopeOfRule(r.id),
    domain: 'ITSM',
    domainLabel: AGENTS.itsm_agent?.[1] || 'ITSM catalogue',
    /* The architecture map's own table list where it has one; the prose otherwise. */
    sourceTables: [...new Set([...(r.architecture?.tables || []).filter((t) => KNOWN_TABLES.has(t)), ...tablesNamedIn(r.source_tables_fields)])],
    qualityDimension: null,
    qualityDimensionLabel: null,
    /* "1A. Configuration and design" → group id "ITSM-1A", name "Configuration and design".
       The one un-numbered group ("Cross-Process and Cross-Domain") is ITSM-X. */
    group: `ITSM-${/^(\w+)\.\s/.exec(String(r.group))?.[1] ?? 'X'}`,
    groupName: String(r.group).replace(/^\w+\.\s+/, '').trim() || r.group,
    baseSeverity: r.base_severity ? String(r.base_severity).toUpperCase() : null,
    track: null,
  };
}

function legacyEntry(ruleId, [agent, table]) {
  const rem = REMEDIATION[ruleId] || {};
  const [domain, domainLabel] = AGENTS[agent] || [null, null];
  return {
    ruleId,
    title: rem.headline || ruleId,
    whatItMeans: rem.problem || '',
    whyItMatters: rem.why || '',
    source: 'legacy',
    module: scopeOfRule(ruleId),
    domain,
    domainLabel,
    sourceTables: [table],
    qualityDimension: null,
    qualityDimensionLabel: null,
    /* The legacy rules group by the domain that reports them. */
    group: domain ? `CORE-${domain}` : null,
    groupName: domainLabel,
    baseSeverity: null,
    track: null,
  };
}

/*
 * The ITSM rules arrive by injection, exactly as remediation.js receives its
 * ITSM guidance (registerItsmCatalogue): health/index.js, the one module
 * outside health/itsm allowed to import it, registers the loader at import
 * time. Until then the catalogue simply has no ITSM rules — and registering
 * rebuilds it, so nothing built earlier goes stale.
 */
let itsmRules = () => [];
let CATALOGUE = null;

export function registerItsmCatalogueRules(listRules) {
  if (typeof listRules !== 'function') throw new TypeError('registerItsmCatalogueRules needs a function returning the ITSM rules');
  itsmRules = listRules;
  CATALOGUE = null;
}

function build() {
  const entries = [
    ...cmdbCatalogue.rules.map(cmdbEntry),
    ...itsmRules().map(itsmEntry),
    ...Object.entries(LEGACY_RULE_ORIGIN).map(([id, origin]) => legacyEntry(id, origin)),
  ];
  const byId = new Map();
  for (const e of entries) {
    /* A rule id is the identity of everything downstream — a dimension mapping,
       a finding, a lifecycle state. Two sources claiming one id would make
       every one of those ambiguous, so the catalogue refuses to load. */
    if (byId.has(e.ruleId)) throw new Error(`rule-catalogue: ${e.ruleId} is defined by both ${byId.get(e.ruleId).source} and ${e.source}`);
    byId.set(e.ruleId, Object.freeze({ ...e, sourceTables: Object.freeze(e.sourceTables) }));
  }
  return byId;
}

const catalogue = () => (CATALOGUE ??= build());

/** Every rule, in a stable order (CMDB, ITSM, then core rules). */
export function ruleCatalogue() {
  return [...catalogue().values()];
}

export function getCatalogueRule(ruleId) {
  return catalogue().get(String(ruleId ?? '')) || null;
}

export function isCatalogueRule(ruleId) {
  return catalogue().has(String(ruleId ?? ''));
}

export function catalogueSize() {
  return catalogue().size;
}

/**
 * The fields a dimension designer — human or model — may see about a rule.
 *
 * Generic rule-definition text only. Nothing here is read from an instance:
 * no finding, no record, no sys_id, no evidence. `health-dimensions.test.js`
 * asserts the key list, so widening it is a reviewed change.
 */
export const PUBLIC_RULE_FIELDS = Object.freeze([
  'ruleId', 'title', 'whatItMeans', 'source', 'module', 'domain', 'domainLabel',
  'sourceTables', 'qualityDimension', 'qualityDimensionLabel', 'group', 'groupName', 'baseSeverity',
]);

export function publicRule(entry, { meaningChars = 400 } = {}) {
  if (!entry) return null;
  const out = {};
  for (const k of PUBLIC_RULE_FIELDS) out[k] = entry[k] ?? null;
  out.whatItMeans = clip(entry.whatItMeans, meaningChars);
  return out;
}
