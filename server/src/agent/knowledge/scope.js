/**
 * PHASE 19 — INSTANCE ISOLATION.
 *
 * §80.1 is the first release blocker in the list and the one most likely to be
 * violated by accident: knowledge learned on one PDI appearing as fact on
 * another. It is easy to violate because every store here is keyed on a URL
 * string, and a URL string is easy to get slightly wrong — a trailing slash, a
 * protocol, a case difference — and a scope check that silently fails to match
 * fails OPEN unless it is written not to.
 *
 * SO THE RULE IS A WHITELIST, NOT A BLACKLIST. `admits` returns true for
 * exactly two cases and false for everything else, including everything it does
 * not understand:
 *
 *   1. the item is GLOBAL          — it makes no claim about any instance
 *   2. the item's instance MATCHES  — after normalisation, exactly
 *
 * There is no third branch. An item whose scope this build cannot parse is not
 * admitted, and an unbound session admits nothing but global knowledge. Both
 * are the safe direction: the cost is a missing paragraph of context, and the
 * cost of the other direction is a fact about someone else's instance being
 * presented as a fact about yours.
 *
 * WHY NORMALISATION IS HERE AND NOT AT THE STORES. `facts.js` already
 * normalises when it writes (`currentInstance` strips trailing slashes) and
 * `observations.js` stores whatever it is given. Two stores with two
 * conventions is exactly how a scope check starts matching by luck, so
 * everything is normalised again on the way IN to a comparison — cheap,
 * idempotent, and it makes the comparison independent of which store the row
 * came from.
 */
import { SCOPES, SCOPE_ORDER, UNIVERSAL } from './schemas.js';

/**
 * One instance identity, canonically.
 *
 * Protocol, trailing slashes and case are transport, not identity:
 * `https://dev424910.service-now.com/` and `dev424910.service-now.com` are the
 * same PDI, and a check that treated them as different would silently drop
 * every fact about it.
 */
export function normalizeInstance(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw === UNIVERSAL) return UNIVERSAL;
  return raw
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase() || null;
}

/**
 * Is this item global — i.e. does it make no claim about any one instance?
 *
 * FOUND BY THIS PHASE'S OWN ISOLATION TEST, and it was the exact fail-open the
 * comment above promises does not exist. The first version also treated a NULL
 * instance as global:
 *
 *     item.scope.level === GLOBAL || item.scope.instance === null || ... '*'
 *
 * So an item DECLARING `level: INSTANCE` while naming no instance — a malformed
 * row, a partially-written adapter, a store that changed shape — was admitted
 * everywhere, which is the one outcome §80.1 exists to prevent.
 *
 * Global now means the item SAYS it is global: either by level, or by the `*`
 * marker both existing stores already use. A missing instance under a
 * non-global level is malformed, and malformed is refused below rather than
 * waved through.
 */
export const isGlobalScope = (item) => item?.scope?.level === SCOPES.GLOBAL
  || item?.scope?.instance === UNIVERSAL;

/**
 * May this item be shown to someone asking about this instance?
 *
 * @returns {{ admitted: boolean, reason: string }}
 *
 * The reason is returned on BOTH paths, not just the refusal. §73 asks for the
 * retrieval to be auditable, and "why was this included" is exactly as much a
 * part of that as "why was this dropped" — an item admitted for the wrong
 * reason is the failure this whole file is about, and it is invisible if only
 * exclusions carry an explanation.
 */
export function admits(item, { instance }) {
  const want = normalizeInstance(instance);

  if (isGlobalScope(item)) {
    return { admitted: true, reason: 'global — it makes no claim about any particular instance' };
  }

  const have = normalizeInstance(item?.scope?.instance);
  if (!have) {
    return {
      admitted: false,
      reason: 'the item claims an instance scope but names no instance, so which instance it is about is not established',
    };
  }
  if (!want) {
    return {
      admitted: false,
      reason: 'this session is not bound to an instance, so an instance-scoped claim cannot be shown to apply here',
    };
  }
  if (have !== want) {
    return {
      admitted: false,
      reason: `it was learned on ${have} and this is ${want}`,
    };
  }
  return { admitted: true, reason: `learned on this instance (${have})` };
}

/**
 * Filter a list, keeping what was dropped and why (§73).
 *
 * The dropped list is not decoration. A cross-instance leak is invisible when
 * it happens and obvious in a log of what the filter refused, so the refusals
 * travel with the result rather than being discarded at the boundary.
 */
export function isolate(items, { instance }) {
  const kept = [];
  const dropped = [];
  for (const item of items) {
    const verdict = admits(item, { instance });
    if (verdict.admitted) kept.push({ ...item, admitted_because: verdict.reason });
    else dropped.push({ id: item.id, title: item.title, reason: verdict.reason });
  }
  return { kept, dropped };
}

/* ------------------------------------------------------------------ *
 * §10 / §11 — how specific a claim is
 * ------------------------------------------------------------------ */

/**
 * The narrowest scope this item actually claims.
 *
 * Derived from what the item carries rather than from what it says it is, so an
 * item that names a table IS table-scoped whichever store it came from. §11
 * ranks a same-table claim above a global one, and this is the input to that.
 */
export function scopeLevelOf(item) {
  if (item?.scope?.artifact) return SCOPES.ARTIFACT;
  if (item?.scope?.table) return SCOPES.TABLE;
  if (item?.scope?.application) return SCOPES.APPLICATION;
  if (item?.scope?.instance && item.scope.instance !== UNIVERSAL) return SCOPES.INSTANCE;
  return SCOPES.GLOBAL;
}

/** 0 for the most specific scope. Used by ranking; never by admission. */
export function scopeRank(item) {
  const i = SCOPE_ORDER.indexOf(scopeLevelOf(item));
  return i === -1 ? SCOPE_ORDER.length : i;
}

/**
 * How well an item's scope matches what was asked about.
 *
 * Returns 1 for an exact match on the narrowest thing the QUERY named, falling
 * to 0 for an item that names nothing the query did. Deliberately not a
 * penalty for global knowledge: documentation that does not mention your table
 * is not wrong, it is general, and §12's spirit applies to scope as much as to
 * age.
 */
export function scopeAffinity(item, { table = null, application = null, artifact = null } = {}) {
  let score = 0;
  if (artifact && item?.scope?.artifact && String(item.scope.artifact).toLowerCase() === String(artifact).toLowerCase()) score += 1;
  if (table && item?.scope?.table && String(item.scope.table).toLowerCase() === String(table).toLowerCase()) score += 1;
  if (application && item?.scope?.application && String(item.scope.application).toLowerCase() === String(application).toLowerCase()) score += 1;
  const asked = [artifact, table, application].filter(Boolean).length;
  return asked ? score / asked : 0;
}

/**
 * A one-line description of the scope a run was performed under.
 *
 * Carried on every answer so a reader can tell which instance the result is
 * about without inferring it, and so an audit of a stored answer says which
 * isolation was applied at the time.
 */
export function describeScope({ instance, application = null, table = null, artifact = null }) {
  const inst = normalizeInstance(instance);
  return {
    instance: inst,
    application: application ?? null,
    table: table ?? null,
    artifact: artifact ?? null,
    bound: Boolean(inst),
    note: inst
      ? `Instance-scoped knowledge is limited to ${inst}; global knowledge is admitted for any instance.`
      : 'This session is not bound to an instance, so only global knowledge is admitted.',
  };
}
