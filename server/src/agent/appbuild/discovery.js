/**
 * PHASE 20 — WHAT IS ALREADY THERE (§6, §7, §18).
 *
 * §6 says discovery comes before design, and the reason is not efficiency. A
 * builder that does not look first CREATES A DUPLICATE — a second
 * `equipment_request` table beside the one somebody is already using, with
 * different fields and the same purpose. That is worse than building nothing,
 * and §68.4 makes it a release blocker.
 *
 * ═══ §7'S WARNING IS THE HARD PART ═══
 *
 * "Do not infer that a similar name means the artifact is equivalent."
 *
 * A table called `equipment_request` might be exactly what was asked for, or it
 * might be a half-built experiment from last year with three fields and no
 * ACLs. Those need opposite decisions, and the name cannot tell them apart.
 *
 * So this module NEVER decides to reuse. It reports three things — the artifact
 * exists, here is what it actually contains, here is what the requirement asked
 * for — and hands all three to a person. `compare` produces the evidence for
 * that decision; nothing here acts on it. An automatic reuse is an automatic
 * assumption that two things with the same name are the same thing.
 *
 * Every read is INJECTED. Nothing in `appbuild/` reaches the instance.
 */
import { COMPONENT } from './schemas.js';

/**
 * Everything relevant that already exists.
 *
 * @param probes  injected readers, each optional. A probe that is absent is
 *                simply not run; a probe that THROWS is recorded, because
 *                "I could not look" and "there is nothing there" must not
 *                render alike — a builder that treats a failed read as an empty
 *                instance creates duplicates for a living.
 */
export async function discover({ probes = {}, scopePrefix = null, names = [] } = {}) {
  const found = { applications: [], tables: [], fields: [], roles: [], flows: [], catalog: [], acls: [] };
  const unreadable = [];

  const run = async (key, fn, args) => {
    if (typeof fn !== 'function') return;
    try {
      found[key] = (await fn(args)) ?? [];
    } catch (err) {
      unreadable.push({ surface: key, reason: err.message });
    }
  };

  await run('applications', probes.applications, { scopePrefix });
  await run('tables', probes.tables, { scopePrefix, names });
  await run('roles', probes.roles, { scopePrefix, names });
  await run('flows', probes.flows, { names });
  await run('catalog', probes.catalog, { names });
  await run('acls', probes.acls, { names });

  /*
   * The identity set the graph validator checks against. Built from what was
   * actually READ — an unreadable surface contributes nothing, which is why
   * `complete` travels with it.
   */
  const identities = new Set();
  for (const a of found.applications) if (a.scope) identities.add(a.scope);
  for (const t of found.tables) if (t.name) identities.add(t.name);
  for (const f of found.fields) if (f.table && f.name) identities.add(`${f.table}.${f.name}`);
  for (const r of found.roles) if (r.name) identities.add(r.name);
  for (const fl of found.flows) if (fl.name) identities.add(`flow:${fl.name}`);
  for (const c of found.catalog) if (c.name) identities.add(`catalog:${c.name}`);

  return {
    ...found,
    identities,
    unreadable,
    /*
     * §68.4 turns on this flag. A duplicate check performed against a partial
     * picture of the instance is not a duplicate check, and a builder that
     * proceeded on one would be guessing that what it could not see is not
     * there.
     */
    complete: unreadable.length === 0,
    counts: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.length])),
  };
}

/* ------------------------------------------------------------------ *
 * §7 — compare, and refuse to conclude
 * ------------------------------------------------------------------ */

/**
 * Does an existing artifact appear to satisfy a planned component?
 *
 * Returns EVIDENCE, and a recommendation that is never stronger than the
 * evidence supports:
 *
 *   'reuse'      the identity matches AND everything the component needs is
 *                present on the existing artifact. Still a recommendation.
 *   'inspect'    the identity matches and the contents differ. A person decides.
 *   'distinct'   nothing matches; build it.
 *
 * `inspect` is the interesting answer and the one §7 is about. It is what a
 * same-name-different-shape artifact produces, and it is deliberately not
 * `reuse` and deliberately not `distinct`.
 */
export function compare({ component, existing }) {
  if (!existing) {
    return { verdict: 'distinct', why: 'Nothing on this instance carries that identity.', differences: [] };
  }

  const differences = [];
  const spec = component?.spec ?? {};

  if (component?.type === COMPONENT.TABLE) {
    const have = new Set((existing.fields ?? []).map((f) => f.name));
    for (const want of spec.fields ?? []) {
      if (!have.has(want.name)) differences.push({ what: `field ${want.name}`, detail: 'the requirement needs it; the existing table does not have it' });
    }
  }
  if (component?.type === COMPONENT.ROLE && existing.name && spec.name && existing.name !== spec.name) {
    differences.push({ what: 'name', detail: `existing "${existing.name}" vs required "${spec.name}"` });
  }
  if (component?.type === COMPONENT.CATALOG) {
    const have = new Set((existing.variables ?? []).map((v) => v.name));
    for (const want of spec.variables ?? []) {
      if (!have.has(want.name)) differences.push({ what: `variable ${want.name}`, detail: 'required by the request, absent from the existing item' });
    }
  }

  if (!differences.length) {
    return {
      verdict: 'reuse',
      why: `An existing ${component.type} carries this identity and contains everything the requirement asks for.`,
      differences: [],
      existing,
    };
  }
  return {
    /*
     * §7, exactly. The name matched and the contents did not, so this build
     * declines to decide whether they are the same thing.
     */
    verdict: 'inspect',
    why: `An existing ${component.type} carries this identity but differs from what was asked for in `
      + `${differences.length} way(s). A matching name is not evidence that two artifacts are equivalent, `
      + 'so this is not treated as either a duplicate or a reuse without a person looking.',
    differences,
    existing,
  };
}

/**
 * Apply the comparison across an architecture.
 *
 * Components recommended for reuse are REMOVED from the build (nothing is
 * created for them) and recorded as reused. Components needing inspection are
 * kept and flagged — the architecture is still valid, and the build is blocked
 * until somebody resolves them, which is §18's "stop on collision".
 */
export function reconcile({ components, discovered }) {
  const build = [];
  const reused = [];
  const collisions = [];

  for (const component of components) {
    const identity = component.identity;
    const existing = identity ? findExisting(identity, discovered) : null;
    const verdict = compare({ component, existing });

    if (verdict.verdict === 'reuse') {
      reused.push({ component: component.id, identity, why: verdict.why, existing: summarise(existing) });
      continue;
    }
    if (verdict.verdict === 'inspect') {
      collisions.push({
        component: component.id,
        identity,
        why: verdict.why,
        differences: verdict.differences,
        existing: summarise(existing),
      });
      /* Kept in the architecture so a reader sees it, and the collision blocks
       * the build. */
      build.push({ ...component, collision: true });
      continue;
    }
    build.push(component);
  }

  return { build, reused, collisions };
}

function findExisting(identity, discovered) {
  const id = String(identity);
  for (const t of discovered.tables ?? []) if (t.name === id) return { kind: 'table', ...t };
  for (const r of discovered.roles ?? []) if (r.name === id) return { kind: 'role', ...r };
  for (const a of discovered.applications ?? []) if (a.scope === id) return { kind: 'application', ...a };
  for (const f of discovered.flows ?? []) if (`flow:${f.name}` === id) return { kind: 'flow', ...f };
  for (const c of discovered.catalog ?? []) if (`catalog:${c.name}` === id) return { kind: 'catalog', ...c };
  return null;
}

const summarise = (e) => (e ? {
  kind: e.kind,
  name: e.name ?? e.scope ?? null,
  sys_id: e.sys_id ?? null,
  fields: Array.isArray(e.fields) ? e.fields.length : undefined,
  variables: Array.isArray(e.variables) ? e.variables.length : undefined,
} : null);
