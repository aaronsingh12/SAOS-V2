import { table as instanceClient, SnowError } from '../../servicenow/client.js';
import { classifyFailure } from '../extract.js';

/**
 * ITSM PHASE 3 — capability probes.
 *
 * Before a rule runs, the question is not "is the estate healthy" but "can this
 * instance answer the question at all": does the table exist (MIM, CAB
 * Workbench and conflict detection are plugins), does the field exist
 * (`business_criticality` is not on `cmdb_ci` on every release — trap #4), is
 * the table audited (`cmdb_ci` is not, on dev424910), can this account read it.
 *
 * Four answers, and the difference between them is the whole point:
 *
 *   AVAILABLE    the platform confirmed it
 *   UNAVAILABLE  the platform confirmed it is NOT there (table absent, field
 *                absent, audit off) — the rule skips as "not installed /
 *                not audited", it does NOT fire as "absent"
 *   PARTIAL      there, but not fully usable (some fields missing, or readable
 *                but not countable)
 *   UNKNOWN      the probe itself failed (403, timeout). UNKNOWN is never
 *                treated as AVAILABLE and never as UNAVAILABLE: a rule that
 *                cannot establish its capability skips with that reason.
 *
 * A probe is cached per run — the same `sys_db_object` question asked by
 * fifteen rules is asked of the instance once.
 */

export const CAPABILITY = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
  PARTIAL: 'PARTIAL',
  UNKNOWN: 'UNKNOWN',
});

const now = () => new Date().toISOString();
const verdict = (state, reason, extra = {}) => Object.freeze({ state, reason, checked_at: now(), ...extra });

function failure(err) {
  const code = err instanceof SnowError || err?.status ? classifyFailure(err) : 'upstream_error';
  return verdict(CAPABILITY.UNKNOWN, `the probe failed (${code}): ${err?.message || err}`, { code });
}

export function createProbes({ client = instanceClient } = {}) {
  const cache = new Map();
  const memo = async (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn().catch((err) => failure(err)));
    return cache.get(key);
  };

  /** Does the table exist on this instance? `sys_db_object` is the platform's own answer. */
  const tableExists = (name) => memo(`table:${name}`, async () => {
    const rows = await client.query('sys_db_object', { query: `name=${name}`, fields: 'name,sys_class_name', limit: 1, offset: 0, display: 'false' });
    return rows.length
      ? verdict(CAPABILITY.AVAILABLE, `${name} exists`)
      : verdict(CAPABILITY.UNAVAILABLE, `${name} is not on this instance (no sys_db_object row)`);
  });

  /** The table's super-class chain (bounded), read once per run. */
  const tableChain = (tableName) => memo(`chain:${tableName}`, async () => {
    const chain = [tableName];
    for (let i = 0; i < 12; i++) {
      const rows = await client.query('sys_db_object', { query: `name=${chain[chain.length - 1]}`, fields: 'name,super_class.name', limit: 1, offset: 0, display: 'false' });
      const parent = rows[0]?.['super_class.name'];
      if (!parent || chain.includes(parent)) break;
      chain.push(parent);
    }
    return chain;
  });

  /**
   * Every element the table carries (its own dictionary rows and its
   * ancestors'), read ONCE per run: one dictionary read answers every field
   * question about the table, instead of one read per rule per field set.
   */
  const tableElements = (tableName) => memo(`elements:${tableName}`, async () => {
    const chain = await tableChain(tableName);
    const dict = await client.query('sys_dictionary', { query: `nameIN${chain.join(',')}^elementISNOTEMPTY`, fields: 'name,element', limit: 5000, offset: 0, display: 'false' });
    return new Set(dict.map((r) => r.element));
  });

  /** Do these fields exist on the table (its own dictionary or inherited)? */
  const fieldsExist = (tableName, fields) => memo(`fields:${tableName}:${[...fields].sort().join(',')}`, async () => {
    const t = await tableExists(tableName);
    if (t.state !== CAPABILITY.AVAILABLE) return t;
    const elements = await tableElements(tableName);
    if (!(elements instanceof Set)) return elements;   // the dictionary read itself failed → that probe failure
    const present = new Set(fields.filter((f) => elements.has(f)));
    const missing = fields.filter((f) => !present.has(f));
    if (!missing.length) return verdict(CAPABILITY.AVAILABLE, `all ${fields.length} field(s) exist on ${tableName}`, { present: [...present].sort() });
    if (missing.length === fields.length) return verdict(CAPABILITY.UNAVAILABLE, `none of ${fields.join(', ')} exist on ${tableName}`, { missing });
    return verdict(CAPABILITY.PARTIAL, `${missing.length} of ${fields.length} field(s) missing on ${tableName}: ${missing.join(', ')}`, { missing, present: [...present].sort() });
  });

  /**
   * Is the table audited? `sys_dictionary.audit` on the collection row — the
   * same flag `incremental.deletionLoggedTables` reads. Without it, every
   * audit-history rule for that table skips.
   */
  const auditEnabled = (tableName) => memo(`audit:${tableName}`, async () => {
    const t = await tableExists(tableName);
    if (t.state !== CAPABILITY.AVAILABLE) return t;
    const rows = await client.query('sys_dictionary', {
      query: `name=${tableName}^internal_type=collection`, fields: 'name,audit', limit: 1, offset: 0, display: 'false',
    });
    if (!rows.length) return verdict(CAPABILITY.UNKNOWN, `no collection row for ${tableName} in sys_dictionary`);
    return String(rows[0].audit) === 'true'
      ? verdict(CAPABILITY.AVAILABLE, `${tableName} is audited`)
      : verdict(CAPABILITY.UNAVAILABLE, `${tableName} is not audited (sys_dictionary.audit=false) — history rules cannot run`);
  });

  /** Can this account read the table at all? One bounded read; 403/401 → UNAVAILABLE with the reason, transport error → UNKNOWN. */
  const readable = (tableName) => memo(`read:${tableName}`, async () => {
    const t = await tableExists(tableName);
    if (t.state !== CAPABILITY.AVAILABLE) return t;
    try {
      await client.query(tableName, { query: '', fields: 'sys_id', limit: 1, offset: 0, display: 'false' });
      return verdict(CAPABILITY.AVAILABLE, `${tableName} is readable by this account`);
    } catch (err) {
      const code = err instanceof SnowError || err?.status ? classifyFailure(err) : 'upstream_error';
      if (['forbidden', 'unauthorized'].includes(code)) return verdict(CAPABILITY.UNAVAILABLE, `${tableName} is not readable by this account (${code})`, { code });
      return failure(err);
    }
  });

  /** Does at least one row match — the "is this configured at all" question? */
  const anyRows = (tableName, query = '') => memo(`any:${tableName}:${query}`, async () => {
    const r = await readable(tableName);
    if (r.state !== CAPABILITY.AVAILABLE) return r;
    const count = await client.count(tableName, query);
    return count > 0
      ? verdict(CAPABILITY.AVAILABLE, `${count} row(s) in ${tableName}${query ? ` where ${query}` : ''}`, { count })
      : verdict(CAPABILITY.UNAVAILABLE, `no rows in ${tableName}${query ? ` where ${query}` : ''}`, { count: 0 });
  });

  /** Does a relationship (cmdb_rel_ci) exist between two CIs, either direction? */
  const relationshipExists = (a, b) => memo(`rel:${[a, b].sort().join('|')}`, async () => {
    const count = await client.count('cmdb_rel_ci', `parent=${a}^child=${b}^ORparent=${b}^child=${a}`);
    return count > 0 ? verdict(CAPABILITY.AVAILABLE, `${count} relationship(s) between ${a} and ${b}`, { count })
      : verdict(CAPABILITY.UNAVAILABLE, `no relationship between ${a} and ${b}`, { count: 0 });
  });

  /**
   * A named configuration OBJECT — a plugin's table, or a concept the workbook
   * names without a table. Objects with no known table answer UNKNOWN with the
   * reason "UNDEFINED", never UNAVAILABLE: we have not looked, so we cannot say
   * it is absent.
   */
  /*
   * DECISION 5 — an object is resolved by inspection, in four steps, and a
   * candidate table stays a candidate until every step passes:
   *
   *   candidate ──► table discovery ──► schema verification ──► capability confirmation ──► usable
   *                 (sys_db_object)     (expected fields on     (readable by this
   *                                      the dictionary)         account)
   *
   * Each step that fails answers UNAVAILABLE with the step named. An object
   * with NO expected fields cannot be schema-verified, so it cannot be
   * confirmed — existing is not being the right table — and is UNAVAILABLE
   * with reason "not confidently identified". An object with no candidate
   * table at all is UNKNOWN (we have not looked), never UNAVAILABLE.
   */
  const configurationObject = (name, { table: tableName = null, fields = [] } = {}) => memo(`object:${name}:${tableName ?? ''}:${[...fields].sort().join(',')}`, async () => {
    if (!tableName) return verdict(CAPABILITY.UNKNOWN, `${name}: no platform table is defined for this object (UNDEFINED) — cannot probe`, { step: 'candidate' });
    const t = await tableExists(tableName);
    if (t.state !== CAPABILITY.AVAILABLE) return verdict(t.state === CAPABILITY.UNKNOWN ? CAPABILITY.UNKNOWN : CAPABILITY.UNAVAILABLE, `${name}: table discovery — ${t.reason}`, { table: tableName, step: 'table_discovery' });
    if (!fields.length) {
      return verdict(CAPABILITY.UNAVAILABLE, `${name}: candidate ${tableName} exists but no expected fields are defined to verify it against (UNDEFINED) — not confidently identified`, { table: tableName, step: 'schema_verification' });
    }
    const f = await fieldsExist(tableName, fields);
    if (f.state !== CAPABILITY.AVAILABLE) return verdict(f.state === CAPABILITY.UNKNOWN ? CAPABILITY.UNKNOWN : CAPABILITY.UNAVAILABLE, `${name}: schema verification — ${f.reason}`, { table: tableName, step: 'schema_verification', missing: f.missing ?? [] });
    const r = await readable(tableName);
    if (r.state !== CAPABILITY.AVAILABLE) return verdict(r.state, `${name}: capability confirmation — ${r.reason}`, { table: tableName, step: 'capability_confirmation' });
    return verdict(CAPABILITY.AVAILABLE, `${name}: ${tableName} verified (exists, carries ${fields.join(', ')}, readable) — usable`, { table: tableName, step: 'usable', fields: [...fields] });
  });

  /**
   * Combine several verdicts into one: UNAVAILABLE or UNKNOWN anywhere wins
   * (in that order of precedence — an outright absence is a firmer answer than
   * a failed probe), then PARTIAL, then AVAILABLE.
   */
  const combine = (verdicts) => {
    const states = verdicts.map((v) => v.state);
    const pick = (s) => verdicts.find((v) => v.state === s);
    if (states.includes(CAPABILITY.UNAVAILABLE)) return verdict(CAPABILITY.UNAVAILABLE, pick(CAPABILITY.UNAVAILABLE).reason, { parts: verdicts });
    if (states.includes(CAPABILITY.UNKNOWN)) return verdict(CAPABILITY.UNKNOWN, pick(CAPABILITY.UNKNOWN).reason, { parts: verdicts });
    if (states.includes(CAPABILITY.PARTIAL)) return verdict(CAPABILITY.PARTIAL, pick(CAPABILITY.PARTIAL).reason, { parts: verdicts });
    return verdict(CAPABILITY.AVAILABLE, 'every requirement is available', { parts: verdicts });
  };

  return Object.freeze({ tableExists, fieldsExist, auditEnabled, readable, anyRows, relationshipExists, configurationObject, combine, cacheSize: () => cache.size });
}

/** The gate every engine applies: only AVAILABLE runs; PARTIAL runs only if the caller says its missing parts are tolerable. */
export function canRun(verdict, { allowPartial = false } = {}) {
  if (!verdict) return false;
  if (verdict.state === CAPABILITY.AVAILABLE) return true;
  if (verdict.state === CAPABILITY.PARTIAL) return allowPartial;
  return false;
}
