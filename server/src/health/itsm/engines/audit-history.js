import { declareRequirement } from '../data-access.js';
import { fromSnowTime } from '../run-context.js';
import { CAPABILITY } from '../capability.js';
import { historicalFinding } from '../findings.js';
import { result, preflight, STATUS, notePopulation } from './result.js';
import { readConfiguration } from './configuration.js';

/**
 * ENGINE 8 — Audit & Journal History.
 *
 * Bulk access to `sys_audit` (field changes), `sys_journal_field` (work notes,
 * comments) and `task_sla` (SLA stages) for a POPULATION of records — the
 * records a rule is about, never the whole table — and the derivations the
 * ITSM rules need from them: transitions per field, counts, first-set and
 * last-change times, gaps.
 *
 * Where a count is all a rule needs (work notes per incident, reschedules per
 * change) the Aggregate API answers it per document without a row read.
 * `diagnostics.auditFor / journalFor` (one record, bounded) are left as they
 * are for the agent.
 *
 * AUDIT OFF IS A CAPABILITY, NOT A PASS. `sys_audit` only holds what the
 * dictionary says is audited (`cmdb_ci` is not, on dev424910). Every read here
 * starts from `probes.auditEnabled(table)`; UNAVAILABLE or UNKNOWN ends in a
 * skip with that reason, and no rule ever concludes "no transitions" from a
 * table that records none.
 */

export const ENGINE_KEY = 'audit_history';
export const ENGINE_VERSION = '1.2.0';
export const BATCH = 50;

const chunks = (xs, n = BATCH) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);

/**
 * sys_audit rows for these documents (and optionally only these fields),
 * within a window. Batched by documentkey.
 */
export async function fetchAudit(ctx, { table, documentKeys, fields = null, window = null }) {
  const probe = await ctx.probes.auditEnabled(table);
  if (probe.state !== CAPABILITY.AVAILABLE) return { status: 'unavailable', capability: probe, rows: [], coverage: [] };
  const rows = []; const coverage = [];
  let complete = true;
  for (const part of chunks([...new Set(documentKeys)])) {
    const clauses = [`tablename=${table}`, `documentkeyIN${part.join(',')}`];
    if (fields?.length) clauses.push(`fieldnameIN${fields.join(',')}`);
    if (window) clauses.push(`sys_created_on>=${window.start_snow}`, `sys_created_on<=${window.end_snow}`);
    const r = await ctx.reads.read(declareRequirement({ table: 'sys_audit', fields: ['documentkey', 'fieldname', 'oldvalue', 'newvalue', 'sys_created_on', 'user'], query: clauses.join('^'), strategy: 'rows' }));
    coverage.push(r.coverage);
    if (!usable(r.coverage) || r.coverage.truncated) complete = false;
    rows.push(...r.rows);
  }
  return { status: 'ok', capability: probe, rows, coverage, complete };
}

/** Journal entries (work_notes / comments) per document, as counts via the Aggregate API — no rows. */
export async function countJournal(ctx, { table, documentKeys, element = 'work_notes' }) {
  const counts = new Map(documentKeys.map((k) => [k, 0]));
  const coverage = [];
  let complete = true;
  for (const part of chunks([...new Set(documentKeys)])) {
    const r = await ctx.reads.read(declareRequirement({ table: 'sys_journal_field', query: `name=${table}^element=${element}^element_idIN${part.join(',')}`, strategy: 'aggregate', groupBy: ['element_id'] }));
    coverage.push(r.coverage);
    if (r.coverage.status !== 'complete') { complete = false; continue; }
    for (const g of r.groups) if (counts.has(g.group.element_id)) counts.set(g.group.element_id, g.count);
  }
  return { counts, coverage, complete };
}

/** Journal rows (with timestamps) for a small population — gap analysis on major incidents, not on every incident. */
export async function fetchJournal(ctx, { table, documentKeys, element = 'work_notes' }) {
  const rows = []; const coverage = [];
  let complete = true;
  for (const part of chunks([...new Set(documentKeys)])) {
    const r = await ctx.reads.read(declareRequirement({ table: 'sys_journal_field', fields: ['element_id', 'element', 'sys_created_on', 'sys_created_by'], query: `name=${table}^element=${element}^element_idIN${part.join(',')}`, strategy: 'rows' }));
    coverage.push(r.coverage);
    if (!usable(r.coverage) || r.coverage.truncated) complete = false;
    rows.push(...r.rows);
  }
  return { rows, coverage, complete };
}

/** task_sla rows for these tasks. */
export async function fetchTaskSla(ctx, { taskIds, fields = ['task', 'sla', 'stage', 'has_breached', 'pause_duration', 'business_pause_duration', 'planned_end_time', 'start_time', 'end_time'] }) {
  const rows = []; const coverage = [];
  let complete = true;
  for (const part of chunks([...new Set(taskIds)])) {
    const r = await ctx.reads.read(declareRequirement({ table: 'task_sla', fields, query: `taskIN${part.join(',')}`, strategy: 'rows' }));
    coverage.push(r.coverage);
    if (!usable(r.coverage) || r.coverage.truncated) complete = false;
    rows.push(...r.rows);
  }
  return { rows, coverage, complete };
}

/* ── derivations, pure ──────────────────────────────────────────────────── */

/** Per document, the ordered transitions of one field: `[{ sys_id, field, from, to, at, user }]`. */
export function reconstructTransitions(auditRows, field) {
  const by = new Map();
  for (const r of auditRows) {
    if (field && r.fieldname !== field) continue;
    if (!by.has(r.documentkey)) by.set(r.documentkey, []);
    by.get(r.documentkey).push({ sys_id: r.documentkey, field: r.fieldname, from: r.oldvalue ?? null, to: r.newvalue ?? null, at: r.sys_created_on, user: r.user ?? null });
  }
  for (const list of by.values()) list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return by;
}

/** Event counts per document (optionally per field). */
export function countEvents(auditRows, { field = null } = {}) {
  const counts = new Map();
  for (const r of auditRows) {
    if (field && r.fieldname !== field) continue;
    counts.set(r.documentkey, (counts.get(r.documentkey) || 0) + 1);
  }
  return counts;
}

/** Newest change time per document for a field (or any). */
export function lastChangeAt(auditRows, { field = null } = {}) {
  const out = new Map();
  for (const r of auditRows) {
    if (field && r.fieldname !== field) continue;
    const cur = out.get(r.documentkey);
    if (!cur || String(r.sys_created_on) > String(cur)) out.set(r.documentkey, r.sys_created_on);
  }
  return out;
}

/** First time a field was set to a non-empty value, per document. */
export function firstSetAt(auditRows, field) {
  const out = new Map();
  for (const r of auditRows) {
    if (r.fieldname !== field || r.newvalue == null || String(r.newvalue).trim() === '') continue;
    const cur = out.get(r.documentkey);
    if (!cur || String(r.sys_created_on) < String(cur)) out.set(r.documentkey, r.sys_created_on);
  }
  return out;
}

/**
 * DECISION 10 — the state order comes from the INSTANCE, never from literals.
 *
 * `deriveStateOrder` builds it from the field's configured choices: the
 * platform keeps a `sequence` on every `sys_choice` row, which is the order
 * the choices are configured to appear in, and for a state field that is the
 * lifecycle order the instance itself declares. The derivation is VERIFIED
 * before it is used: there must be choices, every one must carry a numeric
 * sequence, and no two may share one or share a value — anything less and the
 * order is `unavailable`, and so is ITSM-072.
 */
export function deriveStateOrder(choiceRows, { table = null, element = null } = {}) {
  const rows = (choiceRows || []).filter((r) => r && r.value !== undefined && r.value !== null && String(r.value) !== '');
  const where = table && element ? ` for ${table}.${element}` : '';
  if (!rows.length) return { status: 'unavailable', reason: `no choice rows${where} — the instance defines no state order to evaluate against`, order: [] };
  const seqOf = (r) => (r.sequence === '' || r.sequence == null ? NaN : Number(r.sequence));
  const seqs = rows.map(seqOf);
  if (seqs.some((n) => !Number.isFinite(n))) return { status: 'unavailable', reason: `${seqs.filter((n) => !Number.isFinite(n)).length} choice(s)${where} have no numeric sequence — the order cannot be verified`, order: [] };
  if (new Set(seqs).size !== seqs.length) return { status: 'unavailable', reason: `choices${where} share a sequence number — the order is ambiguous`, order: [] };
  const values = rows.map((r) => String(r.value));
  if (new Set(values).size !== values.length) return { status: 'unavailable', reason: `duplicate choice values${where} — the order is ambiguous`, order: [] };
  const order = [...rows].sort((x, y) => seqOf(x) - seqOf(y)).map((r) => String(r.value));
  return { status: 'ok', order, source: 'sys_choice.sequence', table, element, choices: rows.length };
}

/** The verified order for a field on this instance, through the configuration reader (inactive choices excluded). */
export async function stateOrderFor(ctx, { table, element }) {
  const cfg = await readConfiguration(ctx, 'sys_choice', { table, element });
  if (cfg.status !== 'ok') return { status: 'unavailable', reason: `state choices for ${table}.${element} could not be read: ${cfg.reason}`, order: [], coverage: cfg.coverage };
  return { ...deriveStateOrder(cfg.rows, { table, element }), coverage: cfg.coverage };
}

/**
 * Transitions that move AGAINST a verified order (earlier → later). A
 * transition between states the order does not know is neither forward nor
 * backward — it is counted in `unknown` by the caller, never as a pass.
 * The empty order is refused: with no order there is no "backward", and a
 * count of zero would read as a pass (DECISION 10).
 */
export function backwardTransitions(transitions, order) {
  if (!Array.isArray(order) || !order.length) throw new Error('backwardTransitions needs a verified, non-empty state order — an empty order is not "no backward transitions"');
  const rank = new Map(order.map((s, i) => [String(s), i]));
  return transitions.filter((t) => rank.has(String(t.from)) && rank.has(String(t.to)) && rank.get(String(t.to)) < rank.get(String(t.from)));
}

/** Largest gap (ms) between consecutive timestamps, and where it was. */
export function maxGap(timestamps) {
  const ts = timestamps.map((t) => fromSnowTime(t)?.getTime()).filter((t) => t != null).sort((a, b) => a - b);
  let best = { gap_ms: 0, from: null, to: null };
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (gap > best.gap_ms) best = { gap_ms: gap, from: new Date(ts[i - 1]).toISOString(), to: new Date(ts[i]).toISOString() };
  }
  return best;
}

/** Time-window filter over audit/journal rows. */
export function withinWindow(rows, window, timeField = 'sys_created_on') {
  return rows.filter((r) => { const t = fromSnowTime(r[timeField]); return t && t >= window.start && t <= window.end; });
}

/**
 * Engine contract. `rule.config`:
 *   { table, scope, source: 'audit'|'journal_count'|'journal'|'task_sla', field, window, derive: 'transition_count'|'last_change_at'|'first_set_at'|'entries_count'|'backward_transitions'|'max_gap',
 *     order[], offend: (derived, row) => boolean, evidence_fields[], severity, title, description }
 */
export const engine = Object.freeze({
  key: ENGINE_KEY,
  name: 'Audit & Journal History Engine',
  version: ENGINE_VERSION,
  canEvaluate: (rule) => rule?.architecture?.engine === ENGINE_KEY || rule?.architecture?.also_requires?.includes(ENGINE_KEY),
  prepare: async () => undefined,
  async evaluate(rule, ctx) {
    const c = rule.config;
    const gate = await preflight(rule, ENGINE_KEY, ctx, {
      requiredCapabilities: c ? [() => ctx.probes.readable(c.table), ...(c.source === 'audit' ? [() => ctx.probes.auditEnabled(c.table)] : [])] : [],
      requiredParameters: c?.required_parameters || [],
    });
    if (gate) return gate;
    const pop = await ctx.reads.read(declareRequirement({ table: c.table, fields: c.evidence_fields || [], query: c.scope || '', strategy: 'rows' }));
    const out = result(rule, ENGINE_KEY, { coverage: [pop.coverage], parameters: ctx.parametersFor(rule.id) });
    if (!usable(pop.coverage)) {
      out.status = STATUS.UNAVAILABLE;
      out.skipped.push({ rule: rule.id, table: c.table, reason: `${c.table} could not be read (${pop.coverage.status})` });
      return out;
    }
    const ids = pop.rows.map((r) => r.sys_id);
    const window = c.window ? ctx.run.window(c.window) : null;
    let derived = new Map(); let transitionsBy = new Map();
    if (c.source === 'audit') {
      /* DECISION 10 — a literal state order in configuration is refused outright. */
      if (c.order !== undefined) throw new Error(`${rule.id}: a literal state order is not allowed (DECISIONS.md §10); use order_source: { table, element }`);
      let order = null;
      if (c.derive === 'backward_transitions') {
        if (!c.order_source?.table || !c.order_source?.element) throw new Error(`${rule.id}: backward_transitions needs order_source { table, element }`);
        const so = await stateOrderFor(ctx, c.order_source);
        if (so.coverage) out.coverage.push(so.coverage);
        if (so.status !== 'ok') {
          out.status = STATUS.UNAVAILABLE;
          out.skipped.push({ rule: rule.id, table: c.order_source.table, reason: `state order unavailable: ${so.reason}`, capability: 'UNAVAILABLE' });
          return out;
        }
        order = so.order;
        out.state_order = { source: so.source, order, choices: so.choices };
      }
      const audit = await fetchAudit(ctx, { table: c.table, documentKeys: ids, fields: c.field ? [c.field] : null, window });
      out.coverage.push(...audit.coverage);
      if (audit.status !== 'ok') {
        out.status = STATUS.UNAVAILABLE;
        out.skipped.push({ rule: rule.id, table: c.table, reason: `audit history is ${audit.capability.state}: ${audit.capability.reason}`, capability: audit.capability.state });
        return out;
      }
      transitionsBy = reconstructTransitions(audit.rows, c.field);
      if (c.derive === 'transition_count') derived = countEvents(audit.rows, { field: c.field });
      else if (c.derive === 'last_change_at') derived = lastChangeAt(audit.rows, { field: c.field });
      else if (c.derive === 'first_set_at') derived = firstSetAt(audit.rows, c.field);
      else if (c.derive === 'backward_transitions') derived = new Map([...transitionsBy].map(([id, ts]) => [id, backwardTransitions(ts, order).length]));
      else throw new Error(`unknown audit derivation ${c.derive}`);
    } else if (c.source === 'journal_count') {
      const j = await countJournal(ctx, { table: c.table, documentKeys: ids, element: c.field || 'work_notes' });
      out.coverage.push(...j.coverage);
      if (!j.complete) {
        /* A batch that failed leaves its documents at zero — which would read as "no work notes". Refuse. */
        out.status = STATUS.UNAVAILABLE;
        out.skipped.push({ rule: rule.id, table: 'sys_journal_field', reason: 'journal counts could not be read completely, so "no entries" cannot be claimed' });
        return out;
      }
      derived = j.counts;
    } else if (c.source === 'journal') {
      const j = await fetchJournal(ctx, { table: c.table, documentKeys: ids, element: c.field || 'work_notes' });
      out.coverage.push(...j.coverage);
      const by = new Map();
      for (const r of j.rows) { if (!by.has(r.element_id)) by.set(r.element_id, []); by.get(r.element_id).push(r.sys_created_on); }
      derived = new Map([...by].map(([id, ts]) => [id, maxGap(ts)]));
    } else throw new Error(`unknown history source ${c.source}`);
    /* EMPTY POPULATION (Phase 5 closure): every record in scope has its history judged. */
    notePopulation(out, { total: pop.coverage.totalKnown ?? pop.rows.length, judged: pop.rows.length, unit: `${c.table} records`, basis: c.scope ? `${c.table} where ${c.scope}` : `every ${c.table} record` });
    const offenders = pop.rows.filter((r) => c.offend(derived.has(r.sys_id) ? derived.get(r.sys_id) : null, r));
    if (offenders.length) {
      out.findings.push(historicalFinding({
        rule, table: c.table, records: offenders, field: c.field ?? null, window, events: Object.fromEntries(offenders.map((r) => [r.sys_id, derived.get(r.sys_id) ?? null])),
        transitions: offenders.flatMap((r) => transitionsBy.get(r.sys_id) || []), title: c.title || rule.title, description: c.description || rule.whatItMeans,
        severity: c.severity || rule.base, confidence: c.confidence ?? 1.0, recommendation: c.recommendation ?? null, collected_at: ctx.run.run_started_at,
      }));
    }
    return out;
  },
});
