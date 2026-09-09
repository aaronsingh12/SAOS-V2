import { table, SnowError } from './client.js';
import { listWorkspaces, workspaceForScope } from './workspaces.js';

/**
 * Applications and scopes — read only.
 *
 * Three measurements off dev442675 (§33) shape this file, and each one would
 * produce a confidently wrong page if it were assumed instead:
 *
 *   1. `sys_store_app` answers 403 "Failed API level ACL Validation" to admin
 *      over REST — and so do `sys_package` and `sys_plugins`. Querying the
 *      table the store apps live on is therefore not an option.
 *
 *   2. They are readable anyway, through the PARENT. `sys_scope` returns all
 *      743 rows with `sys_class_name` telling you which is which: 739
 *      sys_store_app, 3 sys_app, 1 sys_scope. So one read of the parent
 *      answers the whole page, and the class name — not a second query — is
 *      what separates a custom application from a store one.
 *
 *   3. `global` has `sys_id = 'global'`, a literal, not a 32-hex GUID. Every
 *      `application` reference on an update row or update set carries that
 *      same literal, which is why nothing here validates a scope id as hex.
 *
 * The managed flag comes from the workspace registry rather than a hardcoded
 * scope, because a hardcoded platform list goes stale silently (trap #28) and
 * this one would go stale the moment a second scoped application exists.
 */

const raw = (cell) => (cell && typeof cell === 'object' ? cell.value : cell);

/**
 * Store-app descriptions arrive HTML-encoded — `table&#39;s fields` — and React
 * escapes text, so the entity renders literally on the page. Decoding the five
 * XML entities plus numeric references covers what this field actually carries;
 * it is NOT a general HTML sanitiser and the result is still rendered as text,
 * never as markup.
 */
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Fields to request. `sysparm_fields` DROPS an unknown name without complaint
 * (trap #4), so what came back is compared with what was asked for and the
 * difference is REPORTED — measured here: `trial_allowed` does not exist on
 * this instance and vanished silently.
 */
const WANTED = [
  'sys_id', 'name', 'scope', 'version', 'vendor', 'vendor_prefix', 'active', 'private',
  'short_description', 'source', 'sys_class_name', 'can_edit_in_studio', 'licensable',
  'sys_created_by', 'sys_updated_on',
];

/** sys_class_name → what a human calls it. */
const KINDS = {
  sys_app: 'custom',
  sys_store_app: 'store',
  sys_scope: 'scope',
};

function classify(row) {
  const cls = raw(row.sys_class_name) || 'sys_scope';
  return KINDS[cls] || cls;
}

/**
 * Every scope on the instance, with the ones we manage flagged.
 *
 * `search` matches name or scope. `kind` filters to custom / store / scope.
 * Nothing here writes, and nothing here is cached: a scope list that is one
 * install out of date is exactly the sort of quietly-wrong answer the rest of
 * this repo spends its time avoiding.
 */
export async function listApplications({ search = '', kind = '', managedOnly = false, limit = 1000 } = {}) {
  const clauses = [];
  if (search) {
    const s = String(search).replace(/\^/g, ' ');
    clauses.push(`nameLIKE${s}^ORscopeLIKE${s}`);
  }
  const rows = await table.query('sys_scope', {
    query: clauses.join('^') + (clauses.length ? '^' : '') + 'ORDERBYscope',
    fields: WANTED.join(','),
    limit,
    display: 'false',
  });

  // trap #4 — say which requested fields the instance did not return, rather
  // than letting a missing column read as an empty value.
  const returned = new Set(Object.keys(rows[0] || {}));
  const droppedFields = rows.length ? WANTED.filter((f) => !returned.has(f)) : [];

  const workspaces = await listWorkspaces();
  /*
   * Keyed by scope NAME only.
   *
   * This also keyed workspaces by their scope sys_id, read from a pin in
   * now.config.json. That pin is gone — a sys_id is instance-local — so the
   * name is the only address a workspace has that is true on every instance.
   */
  const byScope = new Map();
  for (const w of workspaces) {
    if (w.scope) byScope.set(w.scope, w);
  }

  let apps = rows.map((r) => {
    const scope = raw(r.scope) || '';
    const ws = byScope.get(scope) || null;
    return {
      sys_id: raw(r.sys_id),
      name: raw(r.name) || scope,
      scope,
      version: raw(r.version) || '',
      vendor: raw(r.vendor) || '',
      active: raw(r.active) === 'true',
      private: raw(r.private) === 'true',
      shortDescription: decodeEntities(raw(r.short_description)),
      kind: classify(r),
      canEditInStudio: raw(r.can_edit_in_studio) === 'true',
      createdBy: raw(r.sys_created_by) || '',
      updatedOn: raw(r.sys_updated_on) || '',
      managed: Boolean(ws),
      workspace: ws
        ? { id: ws.id, dir: ws.dir, sourceCount: ws.sourceCount, installable: ws.installable, error: ws.error }
        : null,
    };
  });

  if (kind) apps = apps.filter((a) => a.kind === kind);
  if (managedOnly) apps = apps.filter((a) => a.managed);

  const counts = apps.reduce((acc, a) => { acc[a.kind] = (acc[a.kind] || 0) + 1; return acc; }, {});

  return {
    applications: apps,
    counts,
    total: apps.length,
    managedCount: apps.filter((a) => a.managed).length,
    /**
     * Where the store apps came from, stated rather than implied. The ACL
     * lesson from B-3 applies verbatim: an empty list is not an answer, and a
     * page that silently omits 739 applications because one table is closed
     * looks identical to an instance that has none.
     */
    visibility: {
      source: 'sys_scope',
      note: 'sys_store_app, sys_package and sys_plugins answer 403 (API-level ACL) to this user over REST. '
          + 'Store applications are read through their sys_scope parent instead, which returns them in full.',
      droppedFields,
    },
    /** Workspaces that exist on disk but match no scope on this instance. */
    orphanWorkspaces: workspaces
      .filter((w) => w.scope && !apps.some((a) => a.scope === w.scope))
      .map((w) => ({ id: w.id, scope: w.scope, dir: w.dir, error: w.error })),
  };
}

/** One application, by sys_id or by scope name. Both are addresses callers hold. */
export async function getApplication(idOrScope) {
  if (!idOrScope) throw new SnowError('An application sys_id or scope name is required', 400);
  const key = String(idOrScope);
  const rows = await table.query('sys_scope', {
    query: `sys_id=${key}^ORscope=${key}`,
    fields: WANTED.join(','),
    limit: 1,
    display: 'false',
  });
  if (!rows.length) throw new SnowError(`No application or scope matches "${key}" on this instance.`, 404);
  const one = (await listApplications({ limit: 1000 })).applications.find(
    (a) => a.sys_id === raw(rows[0].sys_id)
  );
  return one || null;
}

/**
 * Resolve a set of scope ids to display labels in one read.
 *
 * Artifact lists carry `sys_scope` as a sys_id and want a badge. Doing that per
 * row is N reads for a 50-row list, so callers hand over the whole set and get
 * a map back. Unknown ids map to themselves rather than to blank — a badge that
 * silently empties is indistinguishable from an artifact with no scope.
 */
export async function scopeLabels(ids = []) {
  const wanted = [...new Set(ids.map((i) => String(i || '')).filter(Boolean))];
  if (!wanted.length) return {};
  const out = {};
  // `global` is a literal sys_id and needs no lookup; asking for it in an IN
  // clause is harmless but pointless.
  const lookup = wanted.filter((w) => w !== 'global');
  if (wanted.includes('global')) out.global = 'global';
  if (lookup.length) {
    const rows = await table.query('sys_scope', {
      query: `sys_idIN${lookup.join(',')}`,
      fields: 'sys_id,scope,name',
      limit: Math.max(lookup.length, 50),
      display: 'false',
    });
    for (const r of rows) out[raw(r.sys_id)] = raw(r.scope) || raw(r.name) || raw(r.sys_id);
  }
  for (const w of wanted) if (!out[w]) out[w] = w;
  return out;
}

/** The registry on its own, for the Transport page and the agent tool. */
export async function workspaceRegistry() {
  const workspaces = await listWorkspaces();
  return { workspaces, count: workspaces.length };
}

export { workspaceForScope };
