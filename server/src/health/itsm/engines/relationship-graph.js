import { declareRequirement } from '../data-access.js';
import { relationshipFinding } from '../findings.js';
import { result, preflight, STATUS } from './result.js';
import { canRun } from '../capability.js';

/**
 * ENGINE 6 — Relationship Graph.
 *
 * DECISION 11 — the graph is BOUNDED. An ITSM rule names the CIs its records
 * reference; the store below reads only the `cmdb_rel_ci` rows touching those
 * CIs (`parentIN…` / `childIN…`, fifty at a time), then the rows touching what
 * they reached, to the rule's depth. It never reads the relationship table
 * whole, and a rule that names no CI reads nothing. Edges are cached per run
 * across rules, so two rules seeding overlapping CIs share the reads.
 *
 * Every answer about ABSENCE — "zero edges", "no path to a service" — is only
 * sound when every read that could have found the edge succeeded, so the
 * store records per-node completeness and `buildGraph` carries it: an
 * incomplete graph answers `null` for absence, never `false`.
 *
 * `health/rules.js synthesize()` keeps its own whole-table walk for the CMDB
 * module; it is untouched.
 */

export const ENGINE_KEY = 'relationship_graph';
export const ENGINE_VERSION = '1.1.0';

/** Build from cmdb_rel_ci rows: `{ parent, child, type, type.name?, sys_id }`. */
export function buildGraph(rels, { coverage = null, serviceIds = [] } = {}) {
  const out = new Map();     // parent → [{ to: child, type, rel }]
  const inn = new Map();     // child → [{ to: parent, type, rel }]
  const und = new Map();     // undirected adjacency, as synthesize() builds it
  const pairs = new Map();   // `${a}|${b}` → rel rows (relationship lookup)
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  let edges = 0;
  for (const r of rels) {
    if (!r.parent || !r.child) continue;
    const type = r['type.name'] ?? r.type ?? null;
    add(out, r.parent, { to: r.child, type, rel: r.sys_id });
    add(inn, r.child, { to: r.parent, type, rel: r.sys_id });
    add(und, r.parent, r.child);
    add(und, r.child, r.parent);
    add(pairs, `${r.parent}|${r.child}`, r);
    edges += 1;
  }
  const services = new Set(serviceIds);
  const complete = coverage ? Boolean(coverage.rowsComplete ?? coverage.rows_complete ?? coverage.status === 'complete') : null;

  const neighbours = (id, direction) => (direction === 'out' ? out : direction === 'in' ? inn : null)?.get(id)
    ?? (direction === 'both' ? (und.get(id) || []).map((to) => ({ to, type: null, rel: null })) : []);

  /** Edge count for a CI, by direction. */
  const degree = (id, { direction = 'both' } = {}) => (direction === 'both' ? (und.get(id) || []).length : (neighbours(id, direction) || []).length);

  /** BFS to `depth`, returning Map(id → depth) excluding the seed. */
  const traverse = (seeds, { depth = 3, direction = 'both' } = {}) => {
    const visited = new Map();
    let frontier = [...new Set(seeds)];
    for (const s of frontier) visited.set(s, 0);
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next = [];
      for (const n of frontier) {
        for (const e of neighbours(n, direction) || []) {
          if (!visited.has(e.to)) { visited.set(e.to, d); next.push(e.to); }
        }
      }
      frontier = next;
    }
    for (const s of seeds) visited.delete(s);
    return visited;
  };

  /** CIs that depend on `id` — the children reachable downstream (parent → child) to `depth`. */
  const dependents = (id, depth = 2) => traverse([id], { depth, direction: 'out' });

  /**
   * Shortest path from a CI to any known service id, following edges in
   * either direction (a service may be parent or child of what it depends on,
   * per relationship type — the direction convention is instance-specific).
   * `{ found, service, path: [ids], depth }`; `found: null` when the graph is
   * incomplete and no path was seen — absence cannot be claimed.
   */
  const pathToService = (id, { depth = 3, direction = 'both' } = {}) => {
    if (services.has(id)) return { found: true, service: id, path: [id], depth: 0 };
    const prev = new Map([[id, null]]);
    let frontier = [id];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next = [];
      for (const n of frontier) {
        for (const e of neighbours(n, direction) || []) {
          if (prev.has(e.to)) continue;
          prev.set(e.to, n);
          if (services.has(e.to)) {
            const path = [e.to];
            let cur = n;
            while (cur) { path.unshift(cur); cur = prev.get(cur); }
            return { found: true, service: e.to, path, depth: d };
          }
          next.push(e.to);
        }
      }
      frontier = next;
    }
    return { found: complete === false ? null : false, service: null, path: [], depth: null };
  };

  const relationship = (a, b) => [...(pairs.get(`${a}|${b}`) || []), ...(pairs.get(`${b}|${a}`) || [])];

  return Object.freeze({ nodes: und.size, edges, complete, coverage, degree, traverse, dependents, pathToService, relationship, neighbours });
}

export const BATCH = 50;
const chunks = (xs, n = BATCH) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const usable = (cov) => ['complete', 'limited'].includes(cov?.status) && !cov?.truncated;

/**
 * The per-run edge store. `expand(nodes)` reads the relationships touching
 * nodes not yet read; `edges()` is everything read so far. Per-node
 * completeness is what a bounded absence claim rests on.
 */
export function createGraphStore(ctx) {
  const edges = new Map();        // rel sys_id → row
  const read = new Set();         // nodes whose touching edges were read
  const incomplete = new Set();   // nodes whose read failed or was cut short
  const coverage = [];
  const services = new Map();     // node → cmdb_ci_service row | null
  let serviceReads = 0;

  async function expand(nodes) {
    const wanted = [...new Set(nodes.filter((n) => typeof n === 'string' && n && !read.has(n)))];
    for (const part of chunks(wanted)) {
      for (const side of ['parent', 'child']) {
        const r = await ctx.reads.read(declareRequirement({ table: 'cmdb_rel_ci', fields: ['parent', 'child', 'type', 'type.name'], query: `${side}IN${part.join(',')}`, strategy: 'rows' }));
        coverage.push(r.coverage);
        if (!usable(r.coverage)) { for (const n of part) incomplete.add(n); continue; }
        for (const row of r.rows) edges.set(row.sys_id, row);
      }
      for (const n of part) read.add(n);
    }
  }

  /** Which of these nodes are services — cmdb_ci_service answers for itself and its subclasses, by id. */
  async function servicesAmong(nodes) {
    const wanted = [...new Set(nodes.filter((n) => n && !services.has(n)))];
    for (const part of chunks(wanted)) {
      const r = await ctx.reads.read(declareRequirement({ table: 'cmdb_ci_service', fields: ['name', 'busines_criticality'], query: `sys_idIN${part.join(',')}`, strategy: 'rows' }));
      coverage.push(r.coverage);
      serviceReads += 1;
      const found = new Set(r.rows.map((x) => x.sys_id));
      for (const row of r.rows) services.set(row.sys_id, row);
      if (usable(r.coverage)) for (const n of part) if (!found.has(n)) services.set(n, null);
    }
    return new Set(nodes.filter((n) => services.get(n)));
  }

  return Object.freeze({
    expand, servicesAmong,
    edges: () => [...edges.values()],
    isRead: (n) => read.has(n) && !incomplete.has(n),
    incompleteNodes: () => [...incomplete],
    coverage: () => [...coverage],
    stats: () => ({ edges: edges.size, nodes_read: read.size, incomplete: incomplete.size, service_reads: serviceReads }),
    service: (n) => services.get(n) ?? null,
  });
}

/**
 * A graph bounded to `seeds` and `depth`: read the seeds' edges, then the
 * edges of what they reached, `depth` times. `degree` for a seed needs depth 1;
 * `pathToService` to depth d needs d expansions. The result is a
 * `buildGraph` over the edges read, with `complete` true only if every read
 * along the way was complete.
 */
export async function boundedGraph(ctx, { seeds, depth = 1 } = {}) {
  const store = await ctx.shared.getOrBuild('graph_store', async () => createGraphStore(ctx));
  let frontier = [...new Set(seeds.filter(Boolean))];
  const reached = new Set(frontier);
  for (let d = 0; d < Math.max(1, depth) && frontier.length; d++) {
    await store.expand(frontier);
    const next = new Set();
    for (const e of store.edges()) {
      if (reached.has(e.parent) && !reached.has(e.child)) next.add(e.child);
      if (reached.has(e.child) && !reached.has(e.parent)) next.add(e.parent);
    }
    for (const n of next) reached.add(n);
    frontier = [...next].filter((n) => !store.isRead(n));
  }
  const serviceIds = await store.servicesAmong([...reached]);
  const incomplete = store.incompleteNodes().filter((n) => reached.has(n));
  const coverage = { table: 'cmdb_rel_ci', status: incomplete.length ? 'limited' : 'complete', rowsComplete: incomplete.length === 0, bounded: true, seeds: seeds.length, reached: reached.size, depth, incomplete_nodes: incomplete.length };
  const graph = buildGraph(store.edges().filter((e) => reached.has(e.parent) || reached.has(e.child)), { coverage, serviceIds: [...serviceIds] });
  return Object.freeze({ ...graph, scope: { seeds: [...new Set(seeds)], depth, reached: reached.size }, store });
}

/**
 * Engine contract. `rule.config`:
 *   { table, scope, ci_field, question: 'degree'|'path_to_service'|'dependents', depth, direction, offend: (answer, row) => boolean,
 *     report_ratio, threshold {op, value}, evidence_fields[], severity, title, description }
 *
 * `answer` carries `dependents_count` for the dependents question and
 * `service_criticality` (the reached service's busines_criticality) for
 * path_to_service, so an offend expression can test them. With `threshold`
 * the rule is ESTATE-LEVEL: the offending share of evaluated records is the
 * measure, findings are emitted only when it breaches, and the kpi is always
 * recorded.
 */
export const engine = Object.freeze({
  key: ENGINE_KEY,
  name: 'Relationship Graph Engine',
  version: ENGINE_VERSION,
  canEvaluate: (rule) => rule?.architecture?.engine === ENGINE_KEY || rule?.architecture?.also_requires?.includes(ENGINE_KEY),
  prepare: async (ctx) => ctx.shared.getOrBuild('graph_store', async () => createGraphStore(ctx)),
  async evaluate(rule, ctx) {
    const c = rule.config;
    const gate = await preflight(rule, ENGINE_KEY, ctx, {
      requiredCapabilities: c ? [() => ctx.probes.fieldsExist(c.table, [c.ci_field])] : [],
      requiredParameters: c?.required_parameters || [],
    });
    if (gate) return gate;
    /* DECISION 11: the records first, then ONLY their CIs' relationships. */
    const src = await ctx.reads.read(declareRequirement({ table: c.table, fields: [c.ci_field, ...(c.evidence_fields || [])], query: c.scope || '', strategy: 'rows' }));
    const out = result(rule, ENGINE_KEY, { coverage: [src.coverage], parameters: ctx.parametersFor(rule.id) });
    if (!['complete', 'limited', 'truncated'].includes(src.coverage.status)) {
      out.status = STATUS.UNAVAILABLE;
      out.skipped.push({ rule: rule.id, table: c.table, reason: `${c.table} could not be read (${src.coverage.status})` });
      return out;
    }
    const seeds = [...new Set(src.rows.map((r) => r[c.ci_field]).filter(Boolean))];
    if (!seeds.length) {
      /* Nothing references a CI: no relationship is needed, so none is read — not even a capability probe. */
      out.graph_scope = { seeds: [], depth: 0, reached: 0 };
      if (c.report_ratio || c.threshold) out.kpis.push({ rule_id: rule.id, numerator: 0, denominator: 0, pass_pct: null, basis: `no ${c.table} record in scope references a CI` });
      return out;
    }
    const capability = await ctx.probes.readable('cmdb_rel_ci');
    if (!canRun(capability)) {
      out.status = STATUS.UNAVAILABLE; out.capability = capability;
      out.skipped.push({ rule: rule.id, table: 'cmdb_rel_ci', reason: `capability ${capability.state}: ${capability.reason}`, capability: capability.state });
      return out;
    }
    const depth = c.question === 'degree' ? 1 : (c.depth ?? 3);
    const graph = await boundedGraph(ctx, { seeds, depth });
    out.coverage.push(graph.coverage);
    out.graph_scope = graph.scope;
    let unverifiable = 0; let evaluated = 0; let offenders = 0;
    const pending = [];
    for (const row of src.rows) {
      const ci = row[c.ci_field];
      if (!ci) continue;
      if (!graph.store.isRead(ci)) { unverifiable += 1; continue; }
      let answer;
      if (c.question === 'degree') answer = { degree: graph.degree(ci, { direction: c.direction || 'both' }) };
      else if (c.question === 'dependents') { const d = graph.dependents(ci, c.depth ?? 2); answer = { dependents: d, dependents_count: d.size }; }
      else if (c.question === 'path_to_service') {
        answer = graph.pathToService(ci, { depth: c.depth ?? 3, direction: c.direction || 'both' });
        answer = { ...answer, service_criticality: answer.service ? (graph.store.service(answer.service)?.busines_criticality ?? null) : null };
      } else throw new Error(`unknown graph question ${c.question}`);
      if (answer.found === null) { unverifiable += 1; continue; }
      evaluated += 1;
      if (c.offend(answer, row)) {
        offenders += 1;
        pending.push(relationshipFinding({
          rule, source: { table: c.table, sys_id: row.sys_id }, target: answer.service ? { table: 'cmdb_ci_service', sys_id: answer.service } : { table: 'cmdb_ci', sys_id: ci },
          relationship: c.question, path: (answer.path || []).map((id) => ({ table: 'cmdb_ci', sys_id: id })), depth: answer.depth ?? c.depth ?? null,
          title: c.title || rule.title, description: c.description || rule.whatItMeans, severity: c.severity || rule.base, confidence: c.confidence ?? 1.0,
          recommendation: c.recommendation ?? null, collected_at: ctx.run.run_started_at,
        }));
      }
    }
    if (unverifiable) out.skipped.push({ rule: rule.id, table: 'cmdb_rel_ci', reason: 'relationships for these CIs could not be read completely, so absence cannot be claimed', excluded_records: unverifiable });
    if (unverifiable && !evaluated) { out.status = STATUS.UNAVAILABLE; return out; }
    const share = evaluated ? Number((100 * offenders / evaluated).toFixed(1)) : null;
    if (c.report_ratio || c.threshold) {
      out.kpis.push({ rule_id: rule.id, numerator: evaluated - offenders, denominator: evaluated, pass_pct: share == null ? null : Number((100 - share).toFixed(1)), basis: `${c.table} records whose CI answers "${c.question}" as offending`, complete: unverifiable === 0 });
      out.measures[`${rule.id}:offending_share`] = { value: share, population: evaluated, at: ctx.run.run_started_at };
    }
    if (c.threshold) {
      const t = c.threshold;
      const cmp = { gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b }[t.op];
      if (!cmp) throw new Error(`${rule.id}: threshold op ${t.op}`);
      if (c.minimum_volume != null && evaluated < c.minimum_volume) { out.skipped.push({ rule: rule.id, table: c.table, reason: `population ${evaluated} is below the minimum volume ${c.minimum_volume}` }); return out; }
      if (share != null && cmp(share, t.value)) out.findings.push(...pending);
      return out;
    }
    out.findings.push(...pending);
    return out;
  },
});
