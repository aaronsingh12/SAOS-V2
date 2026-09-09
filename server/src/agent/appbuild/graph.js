/**
 * PHASE 20 — THE DEPENDENCY GRAPH (§9, §10, §11).
 *
 * §9's closing line is the one that matters: "Actual dependency direction must
 * be based on the artifact semantics. Do not invent dependencies." So the edges
 * here come from two places and no others:
 *
 *   DECLARED   a component's own `depends_on`, which the architect wrote
 *   SEMANTIC   a relationship the artifact itself establishes — a field belongs
 *              to a table, a reference field needs its TARGET table, an ACL
 *              names a role and a table, a catalog variable belongs to its item
 *
 * The second is derived by reading the component, not by a rule of thumb about
 * what usually depends on what. §11 is explicit about that too: the canonical
 * ordering it lists is only to be used "where actual capability dependencies
 * justify it", so nothing here orders a role before an ACL because a list said
 * so — it does so because that ACL names that role.
 *
 * ═══ WHY THE ORDER MUST BE DETERMINISTIC ═══
 *
 * §11 asks for deterministic dependency order, and a topological sort has many
 * valid answers. Two runs producing two different orders would produce two
 * different plans, two different fingerprints, and an approval that goes stale
 * for no reason. So ties break on the component id — the same discipline the
 * plan executor's own `executionOrder` uses.
 */
import { COMPONENT } from './schemas.js';

/* ------------------------------------------------------------------ *
 * Edges the artifacts themselves establish
 * ------------------------------------------------------------------ */

/**
 * The dependencies a component's own semantics require.
 *
 * Each is a fact about ServiceNow, stated once:
 *
 *   a FIELD cannot exist before its table
 *   a REFERENCE field cannot resolve before the table it points AT
 *   an ACL names a table and (usually) a role, and needs both
 *   a CATALOG VARIABLE belongs to its catalog item
 *   everything scoped belongs to its application
 *
 * A dependency on something not in this architecture is NOT added — it is
 * reported by `validateGraph` as a missing dependency, because a component that
 * silently depends on an artifact nobody is building is exactly §10's case.
 */
export function semanticEdges(component) {
  const out = [];
  const add = (id, why) => { if (id) out.push({ to: String(id), why }); };

  switch (component.type) {
    case COMPONENT.FIELD:
      add(component.spec?.table, 'a field cannot exist before the table it is on');
      /* §21 — a reference field's target must exist or be built first, or the
       * reference dangles. */
      if (component.spec?.type === 'reference') {
        add(component.spec?.reference, 'a reference field cannot resolve before the table it points at');
      }
      break;
    case COMPONENT.ACL:
      add(component.spec?.table, 'an ACL protects a table, which must exist first');
      add(component.spec?.role, 'an ACL grants to a role, which must exist first');
      break;
    case COMPONENT.CATALOG_VARIABLE:
      add(component.spec?.catalog_item, 'a variable belongs to its catalog item');
      break;
    case COMPONENT.SLA:
      add(component.spec?.table, 'an SLA attaches to a table');
      break;
    case COMPONENT.FLOW:
      add(component.spec?.table, 'a record-triggered flow listens to a table');
      break;
    case COMPONENT.RECORD:
      add(component.spec?.table, 'a record needs its table');
      break;
    default:
      break;
  }

  /* Everything in a scoped application belongs to the application. Only added
   * when the application is a component of THIS build — an app that already
   * exists is not a dependency, it is a fact. */
  if (component.type !== COMPONENT.APPLICATION && component.spec?.application) {
    add(component.spec.application, 'a scoped artifact belongs to its application');
  }
  return out;
}

/**
 * Build the graph.
 *
 * @param components  from the architect
 * @returns { nodes, edges, byId }
 *
 * An edge points from a component to what it NEEDS, so a topological sort
 * produces build order directly.
 */
export function buildGraph(components) {
  const byId = new Map(components.map((c) => [c.id, c]));
  const edges = [];

  for (const c of components) {
    const declared = (c.depends_on ?? []).map((to) => ({ from: c.id, to: String(to), why: 'declared by the architecture', kind: 'declared' }));
    const semantic = semanticEdges(c).map((e) => ({ from: c.id, to: e.to, why: e.why, kind: 'semantic' }));
    for (const e of [...declared, ...semantic]) {
      /* Deduplicate: a declared edge and a semantic edge for the same pair are
       * one dependency with two reasons, not two dependencies. */
      const existing = edges.find((x) => x.from === e.from && x.to === e.to);
      if (existing) {
        if (!existing.why.includes(e.why)) existing.why += `; ${e.why}`;
        if (existing.kind !== e.kind) existing.kind = 'declared+semantic';
        continue;
      }
      edges.push({ ...e });
    }
  }

  return { nodes: components.map((c) => c.id), edges, byId };
}

/* ------------------------------------------------------------------ *
 * §10 — what makes a graph unbuildable
 * ------------------------------------------------------------------ */

/**
 * Reject cycles, missing dependencies, unknown artifacts and duplicate identity.
 *
 * All four BEFORE execution, and all four fatal. §68.5 makes invalid dependency
 * ordering a release blocker, and the only way an invalid order reaches the
 * executor is if one of these was tolerated.
 */
export function validateGraph({ components, graph, existing = new Set() }) {
  const problems = [];
  const ids = new Set(components.map((c) => c.id));

  /* Duplicate identity WITHIN the architecture. */
  const seen = new Map();
  for (const c of components) {
    const identity = identityOf(c);
    if (!identity) continue;
    if (seen.has(identity)) {
      problems.push({
        code: 'duplicate_artifact',
        message: `Two components claim the same identity "${identity}": ${seen.get(identity)} and ${c.id}. `
          + 'One of them would silently overwrite the other.',
        components: [seen.get(identity), c.id],
      });
      continue;
    }
    seen.set(identity, c.id);
  }

  /* Duplicate against what ALREADY EXISTS on the instance (§6, §18, §68.4). */
  for (const c of components) {
    const identity = identityOf(c);
    if (identity && existing.has(identity)) {
      problems.push({
        code: 'already_exists',
        message: `${c.type} "${identity}" already exists on this instance. Creating it again would produce a `
          + 'duplicate, or overwrite something somebody else depends on.',
        components: [c.id],
      });
    }
  }

  /* Missing and unknown dependencies. */
  for (const e of graph.edges) {
    if (ids.has(e.to)) continue;
    /* A dependency naming something that already exists is SATISFIED, not
     * missing — that is the whole point of §6's reuse. */
    if (existing.has(e.to)) continue;
    problems.push({
      code: 'missing_dependency',
      message: `${e.from} depends on "${e.to}" (${e.why}), which is neither a component of this `
        + 'architecture nor an artifact that already exists.',
      components: [e.from],
    });
  }

  /* Cycles. */
  const cycle = findCycle(graph, ids);
  if (cycle) {
    problems.push({
      code: 'dependency_cycle',
      message: `These components depend on each other in a loop and none can be built first: ${cycle.join(' → ')}.`,
      components: cycle,
    });
  }

  return { ok: problems.length === 0, problems };
}

/** The identity a component would occupy on the instance. */
export function identityOf(component) {
  const s = component?.spec ?? {};
  switch (component?.type) {
    case COMPONENT.APPLICATION: return s.scope ?? s.name ?? null;
    case COMPONENT.TABLE: return s.name ?? null;
    case COMPONENT.FIELD: return s.table && s.name ? `${s.table}.${s.name}` : null;
    case COMPONENT.ROLE: return s.name ?? null;
    case COMPONENT.CATALOG: return s.name ? `catalog:${s.name}` : null;
    case COMPONENT.CATALOG_VARIABLE:
      return s.catalog_item && s.name ? `variable:${s.catalog_item}.${s.name}` : null;
    case COMPONENT.FLOW: return s.name ? `flow:${s.name}` : null;
    case COMPONENT.ACL:
      return s.table && s.operation ? `acl:${s.table}.${s.operation}${s.role ? `:${s.role}` : ''}` : null;
    case COMPONENT.SLA: return s.name ? `sla:${s.name}` : null;
    default: return null;
  }
}

/** Depth-first cycle detection, returning the loop it found. */
function findCycle(graph, ids) {
  const out = new Map();
  for (const id of ids) out.set(id, []);
  for (const e of graph.edges) {
    if (ids.has(e.from) && ids.has(e.to)) out.get(e.from).push(e.to);
  }

  const WHITE = 0; const GREY = 1; const BLACK = 2;
  const colour = new Map([...ids].map((id) => [id, WHITE]));
  const stack = [];
  let found = null;

  const visit = (id) => {
    if (found) return;
    colour.set(id, GREY);
    stack.push(id);
    for (const next of (out.get(id) ?? []).slice().sort()) {
      if (found) break;
      if (colour.get(next) === GREY) {
        found = [...stack.slice(stack.indexOf(next)), next];
        break;
      }
      if (colour.get(next) === WHITE) visit(next);
    }
    stack.pop();
    colour.set(id, BLACK);
  };

  for (const id of [...ids].sort()) {
    if (colour.get(id) === WHITE) visit(id);
    if (found) break;
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * §11 — build order
 * ------------------------------------------------------------------ */

/**
 * The order components may be built in, or the reason there is none.
 *
 * A deterministic topological sort. Ties break on the component id, so the same
 * architecture always produces the same order — which is what lets the plan
 * fingerprint mean anything (§14) and what stops an approval going stale
 * because a Map iterated differently.
 *
 * `existing` dependencies are satisfied from the start: an artifact already on
 * the instance is not waiting to be built.
 */
export function buildOrder({ components, graph, existing = new Set() }) {
  const ids = new Set(components.map((c) => c.id));
  const needs = new Map(components.map((c) => [c.id, new Set()]));
  for (const e of graph.edges) {
    if (ids.has(e.from) && ids.has(e.to)) needs.get(e.from).add(e.to);
  }

  const done = new Set();
  const order = [];
  const remaining = new Set(ids);

  while (remaining.size) {
    const ready = [...remaining]
      .filter((id) => [...needs.get(id)].every((n) => done.has(n) || existing.has(n)))
      .sort();
    if (!ready.length) {
      return {
        ok: false,
        reason: 'unorderable',
        unmet: [...remaining].sort().map((id) => ({
          component: id,
          waiting_for: [...needs.get(id)].filter((n) => !done.has(n) && !existing.has(n)).sort(),
        })),
      };
    }
    for (const id of ready) {
      order.push(id);
      done.add(id);
      remaining.delete(id);
    }
  }

  return { ok: true, order, components: order.map((id) => graph.byId.get(id)) };
}

/**
 * A reader's view of the dependency structure (§41).
 *
 * Grouped by the thing depended ON, because that is the question a person
 * reviewing a build plan actually asks: "what has to exist before this works?"
 */
export function describeDependencies(graph) {
  const out = [];
  for (const e of graph.edges) {
    const from = graph.byId.get(e.from);
    const to = graph.byId.get(e.to);
    out.push({
      from: e.from,
      from_label: from ? `${from.type} ${from.name}` : e.from,
      to: e.to,
      to_label: to ? `${to.type} ${to.name}` : e.to,
      kind: e.kind,
      why: e.why,
      /* An edge to something not in the build points at an existing artifact,
       * which is a REUSE and worth showing as one (§7). */
      external: !graph.byId.has(e.to),
    });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}
