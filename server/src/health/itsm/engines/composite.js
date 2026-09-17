import { result, preflight, STATUS } from './result.js';

/**
 * ENGINE 10 — Composite / Rule Dependency.
 *
 * Some rules consume other rules' RESULTS: ITSM-124 and 125 re-aggregate
 * ITSM-123's correlated pairs; ITSM-129 fires only when 016 and 094 both
 * breach; ITSM-134 is the union of 018, 065 and 101. The map records these as
 * `dependencies.consumes_output_of`. This engine turns that into an order of
 * execution and a cache, so an upstream rule runs once and its result is
 * handed down rather than recomputed.
 *
 * The DAG is validated before anything runs (a cycle is a configuration
 * error, reported by naming the cycle), executed in topological order, and
 * every consumer receives its inputs' results with their CONFIDENCE — a
 * downstream finding cannot be more certain than the least certain thing it
 * was built from (ITSM-124 "inherits ITSM-123 correlation confidence").
 */

export const ENGINE_KEY = 'composite';
export const ENGINE_VERSION = '1.1.0';

export class DependencyError extends Error {
  constructor(message, detail = null) { super(message); this.name = 'DependencyError'; this.detail = detail; }
}

/** rules: [{ id, dependsOn: [ids] }] → { nodes: Map(id → deps[]), edges } ; unknown dependencies are refused. */
export function buildDag(rules) {
  const nodes = new Map(rules.map((r) => [r.id, [...new Set(r.dependsOn || [])]]));
  let edges = 0;
  for (const [id, deps] of nodes) {
    for (const d of deps) {
      if (!nodes.has(d)) throw new DependencyError(`${id} depends on ${d}, which is not in the set`, { rule: id, missing: d });
      if (d === id) throw new DependencyError(`${id} depends on itself`, { rule: id });
      edges += 1;
    }
  }
  return { nodes, edges };
}

/** Cycle detection: returns the first cycle found as a path, or null. */
export function findCycle(dag) {
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'active') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'active'); stack.push(id);
    for (const d of dag.nodes.get(id)) { const c = visit(d); if (c) return c; }
    stack.pop(); state.set(id, 'done');
    return null;
  };
  for (const id of dag.nodes.keys()) { const c = visit(id); if (c) return c; }
  return null;
}

export function validateDag(dag) {
  const cycle = findCycle(dag);
  if (cycle) throw new DependencyError(`dependency cycle: ${cycle.join(' → ')}`, { cycle });
  return true;
}

/** Topological order — dependencies before dependants; ties by id, so the order is deterministic. */
export function topologicalOrder(dag) {
  validateDag(dag);
  const indeg = new Map([...dag.nodes.keys()].map((id) => [id, 0]));
  const dependants = new Map([...dag.nodes.keys()].map((id) => [id, []]));
  for (const [id, deps] of dag.nodes) for (const d of deps) { indeg.set(id, indeg.get(id) + 1); dependants.get(d).push(id); }
  const ready = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort();
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const dep of dependants.get(id).sort()) {
      indeg.set(dep, indeg.get(dep) - 1);
      if (indeg.get(dep) === 0) { ready.push(dep); ready.sort(); }
    }
  }
  return order;
}

/** Everything `id` transitively depends on, and everything that depends on it. */
export function dependencyLookup(dag, id) {
  if (!dag.nodes.has(id)) throw new DependencyError(`${id} is not in the set`);
  const up = new Set(); const down = new Set();
  const walkUp = (x) => { for (const d of dag.nodes.get(x)) if (!up.has(d)) { up.add(d); walkUp(d); } };
  const walkDown = (x) => { for (const [y, deps] of dag.nodes) if (deps.includes(x) && !down.has(y)) { down.add(y); walkDown(y); } };
  walkUp(id); walkDown(id);
  return { depends_on: [...up].sort(), depended_on_by: [...down].sort() };
}

/**
 * Confidence propagation: a composite's confidence is the minimum of its own
 * and its inputs' — the weakest link. Stated here as the rule so it is one
 * place and one sentence; the workbook says only that 124/125 "inherit"
 * 123's confidence, which min() satisfies exactly for a single input.
 */
export function propagateConfidence(own, inputs) {
  const cs = inputs.map((i) => (typeof i?.confidence === 'number' ? i.confidence : 1)).filter((c) => Number.isFinite(c));
  return Number(Math.min(own ?? 1, ...cs).toFixed(3));
}

/** A per-run result cache keyed by rule id, with a miss counter so tests can prove reuse. */
export function createResultCache(store = new Map()) {
  let hits = 0; let misses = 0;
  return Object.freeze({
    has: (id) => store.has(id),
    get: (id) => { if (store.has(id)) { hits += 1; return store.get(id); } misses += 1; return undefined; },
    set: (id, value) => { store.set(id, value); return value; },
    stats: () => ({ hits, misses, size: store.size }),
  });
}

/**
 * Run a set of rules in dependency order through `evaluateOne(rule, inputs, ctx)`,
 * caching each result. `inputs` is `{ [depId]: result }`. A dependency whose
 * evaluation was skipped or not configured makes its dependants SKIP with that
 * reason — a composite over a missing input is not a finding.
 */
export async function runOrdered(rules, ctx, evaluateOne) {
  const dag = buildDag(rules.map((r) => ({ id: r.id, dependsOn: r.dependsOn || [] })));
  const order = topologicalOrder(dag);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const cache = createResultCache(ctx.results);
  const out = new Map();
  for (const id of order) {
    if (cache.has(id)) { out.set(id, cache.get(id)); continue; }
    const rule = byId.get(id);
    const inputs = {};
    let blocked = null;
    for (const d of dag.nodes.get(id)) {
      const r = out.get(d);
      inputs[d] = r;
      if (!r || r.status !== STATUS.EVALUATED) blocked = blocked || `${d} was ${r?.status ?? 'not evaluated'}`;
    }
    const res = blocked
      ? result(rule, ENGINE_KEY, { status: STATUS.SKIPPED, skipped: [{ rule: id, table: null, reason: `input ${blocked}` }] })
      : await evaluateOne(rule, inputs, ctx);
    cache.set(id, res);
    out.set(id, res);
  }
  return { order, results: out, cache: cache.stats() };
}

/**
 * Engine contract. `rule.config`:
 *   { inputs: [rule ids], combine: (inputResults, ctx, rule) => { findings[], kpis[], measures{}, coverage?, unavailable? }, confidence }
 * The inputs must already be in `ctx.results` (put there by `runOrdered`).
 */
export const engine = Object.freeze({
  key: ENGINE_KEY,
  name: 'Composite / Rule-Dependency Engine',
  version: ENGINE_VERSION,
  canEvaluate: (rule) => rule?.architecture?.engine === ENGINE_KEY || (rule?.architecture?.dependencies?.consumes_output_of?.length > 0),
  prepare: async () => undefined,
  async evaluate(rule, ctx) {
    const c = rule.config;
    const gate = await preflight(rule, ENGINE_KEY, ctx, { requiredParameters: c?.required_parameters || [] });
    if (gate) return gate;
    const inputs = {};
    for (const d of c.inputs || []) {
      const r = ctx.results.get(d);
      if (!r || r.status !== STATUS.EVALUATED) {
        return result(rule, ENGINE_KEY, { status: STATUS.SKIPPED, skipped: [{ rule: rule.id, table: null, reason: `input ${d} was ${r?.status ?? 'not evaluated'} in this run` }] });
      }
      inputs[d] = r;
    }
    const combined = await c.combine(inputs, ctx, rule);
    const out = result(rule, ENGINE_KEY, { parameters: ctx.parametersFor(rule.id) });
    out.coverage = [...Object.values(inputs).flatMap((r) => r.coverage || []), ...(combined?.coverage || [])];
    if (combined?.unavailable) {
      out.status = STATUS.UNAVAILABLE;
      out.skipped.push({ rule: rule.id, table: null, reason: combined.unavailable });
      return out;
    }
    /* DECISION 7: min over own and every input's findings — never an average. */
    const confidence = propagateConfidence(c.confidence ?? 1, Object.values(inputs).flatMap((r) => r.findings));
    out.findings = (combined?.findings || []).map((f) => ({ ...f, confidence: Math.min(f.confidence ?? 1, confidence) }));
    out.kpis = combined?.kpis || [];
    out.measures = combined?.measures || {};
    out.inputs = Object.fromEntries(Object.entries(inputs).map(([id, r]) => [id, { status: r.status, findings: (r.findings || []).length }]));
    return out;
  },
});
