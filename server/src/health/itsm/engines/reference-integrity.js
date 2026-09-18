import { declareRequirement, isCompleteFor } from '../data-access.js';
import { recordFinding } from '../findings.js';
import { result, preflight, STATUS, empty as isEmpty, truthy, notePopulation } from './result.js';

/**
 * ENGINE 3 — Reference Integrity.
 *
 * A reference field points somewhere; does the target exist, is it active, is
 * it in a state that makes the reference valid? Resolved in BATCHES
 * (`sys_idIN…`, fifty at a time — the size `extractCmdbMeta` already uses) and
 * cached for the run, so ITSM-018, 065, 101 and 134 — all "is this group
 * empty" — resolve each group ONCE.
 *
 * COMPLETENESS GATING. "The referenced CI does not exist" is a claim about
 * what was NOT found. It is sound only if the target set was read completely;
 * against a partial read a dangling reference and an unread target look the
 * same. The engine therefore takes the target read's coverage and, for the
 * `exists` check, refuses to report a missing target from an incomplete read —
 * it reports `unverifiable` with the coverage instead. Inactive/invalid-state
 * checks are claims about rows that WERE read and need no such gate.
 */

export const ENGINE_KEY = 'reference_integrity';
export const ENGINE_VERSION = '1.2.0';
export const BATCH = 50;

export const CHECKS = Object.freeze(['exists', 'active', 'state', 'members_active']);

const chunks = (xs, n = BATCH) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * A per-run resolver: `resolve(table, ids, fields)` reads only the ids not yet
 * cached, in batches, and returns a Map id → row (absent = not found). The
 * coverage of the batched reads is accumulated so a failed batch is known.
 */
export function createResolver(ctx) {
  const cache = new Map();   // `${table}` → Map(id → row | null)
  const asked = new Map();   // `${table}` → Map(id → Set(fields already requested))
  const coverage = [];
  const tableCache = (m, t) => { if (!m.has(t)) m.set(t, new Map()); return m.get(t); };

  async function resolve(tableName, ids, { fields = [] } = {}) {
    const known = tableCache(cache, tableName);
    const requested = tableCache(asked, tableName);
    const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
    /*
     * A cached row is reused only if every field this caller needs was ASKED
     * FOR before — not merely present. A row fetched for an 'exists' check was
     * never asked for install_status, so a 'state' check re-reads it; but a
     * field the platform dropped (cmdb_ci has no `active`) stays dropped, and
     * keying on presence would re-read the same rows on every call for ever.
     */
    const missing = wanted.filter((id) => !known.has(id) || fields.some((f) => !requested.get(id)?.has(f)));
    let complete = true;
    for (const part of chunks(missing)) {
      const req = declareRequirement({ table: tableName, fields, query: `sys_idIN${part.join(',')}`, strategy: 'rows', maxRows: part.length + 5 });
      const { rows, coverage: cov } = await ctx.reads.read(req);
      coverage.push(cov);
      if (!['complete', 'limited'].includes(cov.status)) { complete = false; continue; }
      const seen = new Set();
      for (const r of rows) { known.set(r.sys_id, { ...(known.get(r.sys_id) || {}), ...r }); seen.add(r.sys_id); }
      /* A batch that read to its end and did not return an id: that id has no row (or is hidden by an ACL — the same fact to a reference). */
      if (cov.rowsComplete || cov.status === 'complete') for (const id of part) if (!seen.has(id)) known.set(id, null);
      for (const id of part) { if (!requested.has(id)) requested.set(id, new Set()); for (const f of fields) requested.get(id).add(f); }
    }
    const out = new Map();
    for (const id of wanted) if (known.has(id)) out.set(id, known.get(id));
    return { rows: out, complete };
  }

  /** Group → active member user sys_ids, via sys_user_grmember joined to sys_user.active. */
  async function groupMembers(groupIds) {
    const wanted = [...new Set(groupIds.filter(Boolean))];
    const members = new Map(wanted.map((g) => [g, []]));
    let complete = true;
    for (const part of chunks(wanted)) {
      const req = declareRequirement({ table: 'sys_user_grmember', fields: ['group', 'user'], query: `groupIN${part.join(',')}`, strategy: 'rows' });
      const { rows, coverage: cov } = await ctx.reads.read(req);
      coverage.push(cov);
      if (!['complete', 'limited', 'truncated'].includes(cov.status) || cov.truncated) complete = false;
      for (const r of rows) members.get(r.group)?.push(r.user);
    }
    const users = [...new Set([...members.values()].flat())];
    const { rows: userRows, complete: usersComplete } = await resolve('sys_user', users, { fields: ['active', 'user_name', 'name'] });
    const active = new Map();
    for (const [g, us] of members) active.set(g, us.filter((u) => userRows.get(u) && truthy(userRows.get(u).active)));
    return { members, active, complete: complete && usersComplete };
  }

  return Object.freeze({ resolve, groupMembers, coverage: () => [...coverage], cached: (t) => tableCache(cache, t).size });
}

/**
 * Check one reference field across rows.
 *
 *   exists         target row present (needs a complete target read to claim absence)
 *   active         target.active is truthy
 *   state          target[stateField] in invalidStates — or, with validStates, NOT in validStates
 *   members_active the target group has ≥1 active member
 *
 * Returns `{ valid, missing, inactive, invalid_state, unverifiable, empty }` —
 * arrays of the SOURCE rows — plus `complete` for the target read.
 */
export async function checkReferences(rows, { field, target, check, resolver, stateField = null, invalidStates = [], validStates = null, activeField = 'active', targetFields = [] }) {
  if (!CHECKS.includes(check)) throw new Error(`check "${check}" is not one of ${CHECKS.join(', ')}`);
  const out = { valid: [], missing: [], inactive: [], invalid_state: [], unverifiable: [], empty: [], complete: true };
  const withRef = rows.filter((r) => field in r && !isEmpty(r[field]));
  out.empty = rows.filter((r) => field in r && isEmpty(r[field]));
  out.unverifiable.push(...rows.filter((r) => !(field in r)));
  const ids = withRef.map((r) => r[field]);

  if (check === 'members_active') {
    const { active, complete } = await resolver.groupMembers(ids);
    out.complete = complete;
    for (const r of withRef) {
      const a = active.get(r[field]);
      if (a == null) out.unverifiable.push(r);
      else if (a.length === 0) out.inactive.push(r);
      else out.valid.push(r);
    }
    return out;
  }

  const fields = [...new Set([activeField, stateField, ...targetFields].filter(Boolean))];
  const { rows: targets, complete } = await resolver.resolve(target, ids, { fields });
  out.complete = complete;
  for (const r of withRef) {
    const t = targets.get(r[field]);
    if (t === undefined) { out.unverifiable.push(r); continue; }
    if (t === null) {
      /* Absent from a COMPLETE batch read → missing. From an incomplete one → we cannot say. */
      if (complete) out.missing.push(r); else out.unverifiable.push(r);
      continue;
    }
    if (check === 'exists') { out.valid.push(r); continue; }
    if (check === 'active') { (truthy(t[activeField]) ? out.valid : out.inactive).push(r); continue; }
    if (check === 'state') {
      const bad = validStates ? !validStates.map(String).includes(String(t[stateField])) : invalidStates.map(String).includes(String(t[stateField]));
      (bad ? out.invalid_state : out.valid).push(r);
    }
  }
  return out;
}

/**
 * Engine contract. `rule.config`:
 *   { table, scope, field, target, check, state_field, invalid_states[], evidence_fields[], report: ['missing','inactive','invalid_state'], severity, title, description }
 */
export const engine = Object.freeze({
  key: ENGINE_KEY,
  name: 'Reference Integrity Engine',
  version: ENGINE_VERSION,
  canEvaluate: (rule) => rule?.architecture?.engine === ENGINE_KEY || rule?.architecture?.also_requires?.includes(ENGINE_KEY),
  prepare: async (ctx) => ctx.shared.getOrBuild('reference_resolver', async () => createResolver(ctx)),
  async evaluate(rule, ctx) {
    const c = rule.config;
    const gate = await preflight(rule, ENGINE_KEY, ctx, {
      requiredCapabilities: c ? [() => ctx.probes.fieldsExist(c.table, [c.field]), () => ctx.probes.readable(c.check === 'members_active' ? 'sys_user_grmember' : c.target)] : [],
      requiredParameters: c?.required_parameters || [],
    });
    if (gate) return gate;
    const resolver = await this.prepare(ctx);
    const req = declareRequirement({ table: c.table, fields: [c.field, ...(c.evidence_fields || [])], query: c.scope || '', strategy: 'rows' });
    const { rows, coverage } = await ctx.reads.read(req);
    const out = result(rule, ENGINE_KEY, { coverage: [coverage], parameters: ctx.parametersFor(rule.id) });
    if (!['complete', 'limited', 'truncated'].includes(coverage.status)) {
      out.status = STATUS.UNAVAILABLE;
      out.skipped.push({ rule: rule.id, table: c.table, reason: `${c.table} could not be read (${coverage.status}): ${coverage.error}` });
      return out;
    }
    const checked = await checkReferences(rows, { field: c.field, target: c.target, check: c.check, resolver, stateField: c.state_field, invalidStates: c.invalid_states || [], validStates: c.valid_states ?? null, activeField: c.active_field || 'active' });
    out.coverage.push(...resolver.coverage());
    if (checked.unverifiable.length) out.skipped.push({ rule: rule.id, table: c.table, reason: 'reference target could not be verified (field hidden, or target read incomplete)', excluded_records: checked.unverifiable.length });
    for (const kind of c.report || ['missing', 'inactive', 'invalid_state']) {
      const records = checked[kind] || [];
      if (!records.length) continue;
      out.findings.push(recordFinding({
        rule, table: c.table, records, fields: [c.field, ...(c.evidence_fields || [])], title: `${c.title || rule.title} (${kind})`,
        description: c.description || rule.whatItMeans, severity: c.severity || rule.base, confidence: c.confidence ?? 1.0,
        recommendation: c.recommendation ?? null, collected_at: ctx.run.run_started_at,
      }));
    }
    /* Evaluated = rows the check could answer for; an empty reference is evaluated only when 'empty' is a reported case. */
    const reported = c.report || ['missing', 'inactive', 'invalid_state'];
    const offenders = reported.reduce((n, kind) => n + (checked[kind] || []).length, 0);
    const evaluated = rows.length - checked.unverifiable.length - (reported.includes('empty') ? 0 : checked.empty.length);
    /* EMPTY POPULATION (Phase 5 closure): judged = the rows the check could answer for, as the kpi counts them. */
    notePopulation(out, { total: rows.length, judged: evaluated, unit: `${c.table} records`, basis: `${c.table}${c.scope ? ` where ${c.scope}` : ''} → ${c.field} (${c.check})` });
    out.kpis.push({ rule_id: rule.id, numerator: evaluated - offenders, denominator: evaluated, pass_pct: evaluated ? Number((100 * (1 - offenders / evaluated)).toFixed(1)) : null, basis: `${c.field} → ${c.target} (${c.check}: ${reported.join('/')})`, complete: checked.complete && isCompleteFor(coverage, [c.field]) });
    return out;
  },
});
