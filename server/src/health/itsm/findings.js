import crypto from 'node:crypto';
import { ENGINE_BANDS } from './adapter.js';

/**
 * ITSM PHASE 3 — the finding contract, extended.
 *
 * `health/rules.js add()` produces one shape: a record finding — a rule, a
 * table, the sys_ids it is about, one evidence row per (record, field) with the
 * field's VALUE. Most of the ITSM catalogue does not produce that: a dominance
 * share has no record, a missing SLA definition is about a configuration row,
 * a reopen rate is about a window, a change-to-incident correlation is about a
 * pair and a path.
 *
 * So a finding here is the SAME base object every consumer already reads
 * (fingerprint, rule_id, domain, table, target_ids, severity, confidence,
 * evidence, estate_wide …) plus a `kind` and a `detail` block whose shape is
 * fixed per kind. Nothing existing has to change to store or list one; a later
 * phase teaches the UI to render `detail`.
 *
 * EVIDENCE IS SAFE BY CONSTRUCTION. An evidence row carries a value only when
 * the caller asks for it AND the field is not marked sensitive; a sensitive
 * field is reported as count-and-location (ITSM-028's contract: never the
 * matched value). The redaction happens here, at construction, so no renderer
 * has to remember.
 */

export const FINDING_KINDS = Object.freeze(['record', 'aggregate', 'configuration', 'historical', 'relationship', 'cross_domain']);
export const REDACTED = '[redacted — count and location only]';

export class FindingError extends Error {
  constructor(message) { super(message); this.name = 'FindingError'; }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Fingerprints — stable across runs for the same fact:
 *   record        rule | table | sorted sys_ids           (identical to rules.js)
 *   aggregate     rule | table | measure | sorted group key
 *   configuration rule | object | sorted sys_ids (or 'absent')
 *   historical    rule | table | sorted sys_ids | field
 *   relationship  rule | source table | source id | target table | target id
 *   cross_domain  rule | domain | sorted sys_ids
 */
export function fingerprintFor(kind, parts) {
  const ids = (xs) => [...(xs || [])].map(String).sort().join('|');
  switch (kind) {
    case 'record': return sha(`${parts.rule_id}|${parts.table}|${ids(parts.target_ids)}`);
    case 'aggregate': return sha(`${parts.rule_id}|${parts.table}|${parts.measure}|${ids(Object.entries(parts.group || {}).map(([k, v]) => `${k}=${v}`))}`);
    case 'configuration': return sha(`${parts.rule_id}|${parts.object}|${parts.target_ids?.length ? ids(parts.target_ids) : 'absent'}`);
    case 'historical': return sha(`${parts.rule_id}|${parts.table}|${ids(parts.target_ids)}|${parts.field || ''}`);
    case 'relationship': return sha(`${parts.rule_id}|${parts.source_table}|${parts.source_id}|${parts.target_table}|${parts.target_id}`);
    case 'cross_domain': return sha(`${parts.rule_id}|${parts.related_domain}|${ids(parts.target_ids)}`);
    default: throw new FindingError(`unknown finding kind ${kind}`);
  }
}

/**
 * One evidence row. `value` is included only when `includeValue` and the field
 * is not sensitive. `location` (table.field[, sys_id]) is always included.
 */
export function evidenceRow({ table, sys_id = null, field, value = undefined, reason, collected_at, sensitive = false, includeValue = true, source = 'ServiceNow Table REST API' }) {
  const redacted = sensitive || !includeValue;
  return Object.freeze({
    source,
    sn_table: table,
    sn_sys_id: sys_id,
    field_name: field,
    field_value: redacted ? REDACTED : (value === undefined || value === null ? null : String(value)),
    redacted,
    reason,
    collected_at,
  });
}

/** Evidence for a set of records × fields, honouring a sensitive-field list. Matches `add()`'s per-(record, field) shape. */
export function recordEvidence(records, fields, { table, reason, collected_at, sensitive = [] }) {
  const out = [];
  const sens = new Set(sensitive);
  for (const r of records) {
    for (const f of fields) {
      if (!(f in r)) continue;
      out.push(evidenceRow({ table, sys_id: r.sys_id, field: f, value: r[f], reason, collected_at, sensitive: sens.has(f) }));
    }
  }
  return out;
}

function base({ rule, kind, table, target_ids = [], title, description, severity, confidence = 1.0, evidence = [], recommendation = null, agent_id = 'itsm_agent', domain = 'ITSM', collected_at }) {
  if (!FINDING_KINDS.includes(kind)) throw new FindingError(`unknown finding kind ${kind}`);
  if (!rule?.id) throw new FindingError('a finding needs its rule');
  if (!ENGINE_BANDS.includes(severity)) throw new FindingError(`severity "${severity}" is not an engine band`);
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new FindingError('confidence must be 0…1');
  return {
    kind,
    rule_id: rule.id,
    agent_id,
    domain,
    table,
    target_ids: [...target_ids],
    title,
    description,
    severity,
    base_severity: rule.base ?? severity,
    confidence,
    estate_wide: target_ids.length === 0,
    affected_ci_ids: [],
    affected_service_ids: [],
    evidence,
    recommendation,
    collected_at,
  };
}

/** Record finding: the records, the fields read, one evidence row per (record, field). */
export function recordFinding({ rule, table, records, fields, title, description, severity, confidence, recommendation, collected_at, sensitive = [], agent_id }) {
  const target_ids = records.map((r) => r.sys_id);
  const f = base({ rule, kind: 'record', table, target_ids, title, description, severity, confidence, recommendation, collected_at, agent_id,
    evidence: recordEvidence(records, fields, { table, reason: description, collected_at, sensitive }) });
  f.detail = Object.freeze({ fields: [...fields], record_count: records.length });
  f.fingerprint = fingerprintFor('record', f);
  return Object.freeze(f);
}

/**
 * Aggregate finding: no records, a metric. `metric` is what the Aggregate
 * engine returns: `{ measure, observed, threshold, breached, escalated?,
 * population, unit, groups?, window?, basis }`.
 */
export function aggregateFinding({ rule, table, metric, group = {}, title, description, severity, confidence, recommendation, collected_at, agent_id }) {
  if (!metric || typeof metric.measure !== 'string') throw new FindingError('an aggregate finding needs a metric with a measure');
  const f = base({ rule, kind: 'aggregate', table, target_ids: [], title, description, severity, confidence, recommendation, collected_at, agent_id,
    evidence: [evidenceRow({ table, field: metric.measure, value: metric.observed, reason: description, collected_at, source: 'ServiceNow Aggregate API' })] });
  f.detail = Object.freeze({
    measure: metric.measure,
    observed: metric.observed ?? null,
    expected: metric.threshold ?? null,
    breached: Boolean(metric.breached),
    escalated: Boolean(metric.escalated),
    population: metric.population ?? null,
    count: metric.count ?? null,
    percentage: metric.percentage ?? null,
    distribution: metric.distribution ?? null,
    group: { ...group },
    window: metric.window ?? null,
    basis: metric.basis ?? null,
    unit: metric.unit ?? null,
  });
  f.fingerprint = fingerprintFor('aggregate', { rule_id: rule.id, table, measure: metric.measure, group });
  return Object.freeze(f);
}

/** Configuration finding: about a configuration object — a definition, a choice, a rule — or its absence. */
export function configurationFinding({ rule, object, table = null, records = [], observed, expected, title, description, severity, confidence, recommendation, collected_at, agent_id }) {
  const target_ids = records.map((r) => r.sys_id).filter(Boolean);
  const f = base({ rule, kind: 'configuration', table: table ?? object, target_ids, title, description, severity, confidence, recommendation, collected_at, agent_id,
    evidence: records.map((r) => evidenceRow({ table: table ?? object, sys_id: r.sys_id ?? null, field: r.field ?? 'configuration', value: r.value, reason: description, collected_at, source: 'ServiceNow configuration' })) });
  f.detail = Object.freeze({ object, observed: observed ?? null, expected: expected ?? null, absent: target_ids.length === 0 });
  f.fingerprint = fingerprintFor('configuration', { rule_id: rule.id, object, target_ids });
  return Object.freeze(f);
}

/** Historical finding: derived from audit / journal history over a window. */
export function historicalFinding({ rule, table, records, field = null, window, events, transitions = [], title, description, severity, confidence, recommendation, collected_at, agent_id }) {
  const target_ids = records.map((r) => r.sys_id);
  const f = base({ rule, kind: 'historical', table, target_ids, title, description, severity, confidence, recommendation, collected_at, agent_id,
    evidence: transitions.slice(0, 50).map((t) => evidenceRow({ table, sys_id: t.sys_id, field: t.field ?? field, value: `${t.from ?? ''} → ${t.to ?? ''} @ ${t.at ?? ''}`, reason: description, collected_at, source: 'ServiceNow sys_audit / journal' })) });
  f.detail = Object.freeze({
    field,
    window: window ? { start: window.start_snow ?? window.start ?? null, end: window.end_snow ?? window.end ?? null } : null,
    event_counts: events ?? null,
    transitions: transitions.length,
  });
  f.fingerprint = fingerprintFor('historical', { rule_id: rule.id, table, target_ids, field });
  return Object.freeze(f);
}

/** Relationship finding: a source record, a target record, and the relationship/path between them. */
export function relationshipFinding({ rule, source, target, relationship, path = [], depth = null, title, description, severity, confidence, recommendation, collected_at, agent_id }) {
  const f = base({ rule, kind: 'relationship', table: source.table, target_ids: [source.sys_id], title, description, severity, confidence, recommendation, collected_at, agent_id,
    evidence: [
      evidenceRow({ table: source.table, sys_id: source.sys_id, field: 'relationship', value: relationship, reason: description, collected_at, source: 'ServiceNow cmdb_rel_ci' }),
      ...(target?.sys_id ? [evidenceRow({ table: target.table, sys_id: target.sys_id, field: 'related', value: target.label ?? target.sys_id, reason: description, collected_at, source: 'ServiceNow cmdb_rel_ci' })] : []),
    ] });
  f.affected_ci_ids = [source, target, ...path].filter((x) => x?.table === 'cmdb_ci' && x.sys_id).map((x) => x.sys_id);
  f.detail = Object.freeze({
    source: { table: source.table, sys_id: source.sys_id },
    target: target ? { table: target.table, sys_id: target.sys_id } : null,
    relationship,
    path: path.map((p) => ({ table: p.table, sys_id: p.sys_id })),
    depth,
  });
  f.fingerprint = fingerprintFor('relationship', { rule_id: rule.id, source_table: source.table, source_id: source.sys_id, target_table: target?.table ?? '', target_id: target?.sys_id ?? '' });
  return Object.freeze(f);
}

/** Cross-domain finding: an ITSM fact that depends on another domain's data (CMDB, ITOM, CSDM). */
export function crossDomainFinding({ rule, table, records = [], related_domain, provenance, title, description, severity, confidence, recommendation, collected_at, agent_id }) {
  const target_ids = records.map((r) => r.sys_id);
  const f = base({ rule, kind: 'cross_domain', table, target_ids, title, description, severity, confidence, recommendation, collected_at, agent_id,
    evidence: records.slice(0, 50).map((r) => evidenceRow({ table, sys_id: r.sys_id, field: r.field ?? 'cross_domain', value: r.value, reason: description, collected_at })) });
  f.detail = Object.freeze({
    domain: 'ITSM',
    related_domain,
    source: table,
    /* Which other-domain rules / reads this rests on, and their confidence. */
    provenance: Object.freeze({ ...(provenance || {}) }),
  });
  f.fingerprint = fingerprintFor('cross_domain', { rule_id: rule.id, related_domain, target_ids });
  return Object.freeze(f);
}

/**
 * A skip: the rule could not be evaluated. Same vocabulary as
 * `EstateRules.skipped[]` so the two lists can be concatenated.
 */
export function skip(rule, { table = null, reason, capability = null, parameter = null }) {
  return Object.freeze({ rule: rule.id ?? rule, table, reason, capability, parameter });
}
