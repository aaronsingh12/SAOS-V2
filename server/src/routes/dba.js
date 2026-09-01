import { Router } from 'express';
import { metaQuery } from '../servicenow/dba-metadata.js';
import {
  getTable, getHierarchy, listFields, getReferences, getRelationships,
  classify, classifyFromRow, listChoices, listIndexes, generateSchemaMap,
} from '../servicenow/dba-schema.js';

/**
 * Phase T1 — the Tables pane, READ ONLY.
 *
 * Every handler here is a thin wrapper over an existing Layer-1 function. There
 * is deliberately no new backend logic and no new data path: the pane reads
 * exactly what the agent's DBA tools read, so the two can never answer the same
 * question differently. If a number here disagrees with the chat, one of them
 * is wrong — and they share the code that produces it.
 *
 * NOTHING IN THIS FILE MUTATES. No create, no add, no modify, no drop. Those
 * are Phase T2 and route through the gated tools with their approval flow
 * intact; a read-only pane must not grow a write path by accident, so there is
 * no POST/PATCH/DELETE here at all.
 */

export const dbaRouter = Router();

/** A table name is an identifier; anything else is refused before it is used. */
const NAME_RE = /^[a-z0-9_]+$/i;
function assertName(name) {
  if (!NAME_RE.test(String(name || ''))) {
    throw Object.assign(new Error(`"${name}" is not a valid table name.`), { status: 400 });
  }
  return name;
}

/**
 * The table list.
 *
 * Filtering happens on the INSTANCE (an encoded query) rather than by pulling
 * every row and filtering in Node — the instance has thousands of tables and
 * `metaQuery` would honestly report a truncated read, which is the right
 * behaviour but a poor way to answer "find me incident".
 *
 * The result carries `complete` from metaQuery, so the UI can say "these are
 * the first N of M" instead of presenting a page as the whole truth.
 */
dbaRouter.get('/tables', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const scope = String(req.query.scope || '').trim();
    const kind = String(req.query.kind || 'all');
    const max = Math.min(Math.max(Number(req.query.max) || 200, 1), 2000);

    const clauses = [];
    if (q) clauses.push(`nameLIKE${q}^ORlabelLIKE${q}`);
    if (scope) clauses.push(`sys_scope=${scope}`);
    // Custom vs OOTB is decided by the NAME PREFIX, the same rule classify uses.
    if (kind === 'custom') clauses.push('nameSTARTSWITHx_^ORnameSTARTSWITHu_');
    if (kind === 'ootb') clauses.push('nameNOT LIKEx_^nameNOT LIKEu_');

    const rows = await metaQuery('sys_db_object', {
      query: clauses.join('^'),
      fields: 'sys_id,name,label,super_class.name,sys_scope,sys_update_name,is_extendable',
      max,
    });

    const tables = rows
      .map((r) => ({
        name: r.name,
        label: r.label || r.name,
        extends: r['super_class.name'] || null,
        scope: r.sys_scope || null,
        extendable: r.is_extendable === 'true',
        classification: classifyFromRow(r),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      tables,
      count: tables.length,
      // Straight from the paging primitive — a floor is never reported as a total.
      complete: rows.complete === true,
      truncated: rows.truncated === true,
      expectedTotal: rows.expectedTotal ?? null,
      ...(rows.incompleteReason ? { incompleteReason: rows.incompleteReason } : {}),
      filters: { q: q || null, scope: scope || null, kind },
      note: 'Classification here is name/scope only. Open a table for the full check, which also asks whether a '
        + 'platform table has been customized.',
    });
  } catch (err) { next(err); }
});

/** The scopes present on the instance, for the filter — read live, never a constant. */
dbaRouter.get('/scopes', async (_req, res, next) => {
  try {
    const rows = await metaQuery('sys_scope', { query: '', fields: 'sys_id,scope,name', max: 5000 });
    res.json({
      scopes: rows
        .map((r) => ({ sys_id: r.sys_id, scope: r.scope, name: r.name || r.scope }))
        .sort((a, b) => String(a.scope).localeCompare(String(b.scope))),
      complete: rows.complete === true,
    });
  } catch (err) { next(err); }
});

/* ── one table, read every way Layer 1 can read it ───────────────────────── */

dbaRouter.get('/table/:name', async (req, res, next) => {
  try { res.json(await getTable(assertName(req.params.name))); } catch (err) { next(err); }
});

dbaRouter.get('/table/:name/fields', async (req, res, next) => {
  try {
    // The toggle is the caller's; the default matches the tool's default.
    const includeInherited = req.query.inherited !== '0';
    res.json(await listFields(assertName(req.params.name), { includeInherited }));
  } catch (err) { next(err); }
});

dbaRouter.get('/table/:name/hierarchy', async (req, res, next) => {
  try {
    const depth = Math.min(Math.max(Number(req.query.depth) || 2, 1), 4);
    res.json(await getHierarchy(assertName(req.params.name), { depth }));
  } catch (err) { next(err); }
});

dbaRouter.get('/table/:name/references', async (req, res, next) => {
  try { res.json(await getReferences(assertName(req.params.name))); } catch (err) { next(err); }
});

dbaRouter.get('/table/:name/relationships', async (req, res, next) => {
  try { res.json(await getRelationships(assertName(req.params.name))); } catch (err) { next(err); }
});

dbaRouter.get('/table/:name/classify', async (req, res, next) => {
  try { res.json(await classify(assertName(req.params.name))); } catch (err) { next(err); }
});

dbaRouter.get('/table/:name/choices/:element', async (req, res, next) => {
  try { res.json(await listChoices(assertName(req.params.name), assertName(req.params.element))); } catch (err) { next(err); }
});

/**
 * Indexes — the one read that is honestly UNAVAILABLE on this instance.
 *
 * `sys_index` is 403 over REST and is read through a server-side script, which
 * can fail or be blocked. This does NOT translate that into an empty list: the
 * shape carries `available`, `complete` and `zeroMeans`, and the UI renders the
 * unavailable state as its own thing. Every table has at least a primary key,
 * so a zero here would be a false answer, not a small one.
 */
dbaRouter.get('/table/:name/indexes', async (req, res, next) => {
  try {
    const includeInherited = req.query.inherited === '1';
    res.json(await listIndexes(assertName(req.params.name), { includeInherited }));
  } catch (err) { next(err); }
});

dbaRouter.get('/table/:name/map', async (req, res, next) => {
  try {
    const depth = Math.min(Math.max(Number(req.query.depth) || 1, 1), 3);
    res.json(await generateSchemaMap(assertName(req.params.name), { depth }));
  } catch (err) { next(err); }
});
