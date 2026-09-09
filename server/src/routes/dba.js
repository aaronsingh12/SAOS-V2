import crypto from 'node:crypto';
import { Router } from 'express';
import { metaQuery } from '../servicenow/dba-metadata.js';
import {
  getTable, getHierarchy, listFields, getReferences, getRelationships,
  classify, classifyFromRow, listChoices, listIndexes, generateSchemaMap,
} from '../servicenow/dba-schema.js';
import { liveTableConstraints } from '../servicenow/dba-authoring.js';
import { assertTiersAgree, assertAppBinding } from '../servicenow/fluent.js';
import { toolMap } from '../agent/tools.js';
import { executeTool, APPROVAL_SOURCES } from '../agent/orchestrator.js';
import { appendMutation } from '../memory/ledger.js';
import { log } from '../logging.js';

/**
 * The Tables pane's HTTP surface.
 *
 * ── READS (T1) ───────────────────────────────────────────────────────────────
 *
 * Every GET here is a thin wrapper over an existing Layer-1 function. There is
 * deliberately no new backend logic and no new data path: the pane reads
 * exactly what the agent's DBA tools read, so the two cannot answer the same
 * question differently. If a number here disagrees with the chat, one of them
 * is wrong — and they share the code that produces it.
 *
 * ── WRITES (T2) ──────────────────────────────────────────────────────────────
 *
 * There is exactly ONE write endpoint, POST /action, and it does not implement
 * a write: it hands a registry tool to the agent loop's own `executeTool`,
 * which is where the approval gate lives. See its comment. No other verb is
 * defined on any path in this file, so anything not explicitly wired there
 * still 404s — the T1 guarantee is unchanged for everything except the four
 * allowlisted tools.
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

/* ── Phase T2: writes, through the EXISTING gates ─────────────────────────── */

/**
 * The live constraints a table spec is judged by — the form reads these so the
 * rules live in one place. If the SDK grows a column type, the form offers it
 * without anyone editing the form.
 */
dbaRouter.get('/constraints', async (_req, res, next) => {
  try { res.json(await liveTableConstraints()); } catch (err) { next(err); }
});

/**
 * The ONLY write endpoint, and it does not implement a write.
 *
 * ── WHY THIS IS NOT A NEW MUTATION PATH ──────────────────────────────────────
 *
 * It looks up the tool in the SAME registry the agent loop uses and hands it to
 * the SAME `executeTool`, which is where the approval gate lives. That gate
 * refuses any mutating tool whose approval is not resolved AND attributable —
 * `approved` demands `user_click`, `auto` demands auto-approve actually being
 * on, and `unknown` is never executable. Nothing here relaxes it: the pane
 * passes a real human click through the same door the chat card does.
 *
 * Everything the tools already carry therefore still applies, unchanged:
 * spec validation and normalization, `dba_column_route`, `preflight`, the E2
 * `destructiveGate` (escalation + export + typed phrase + impact ack), the
 * source-edit-and-reinstall path, the post-install `active` reconciler, and the
 * independent `verifyTable` / `verifyColumn` read-backs. This endpoint adds
 * exactly three things: an allowlist, a fail-closed binding check, and the
 * ledger row.
 *
 * A tool NOT on the allowlist is refused even if it exists and is mutating —
 * so wiring a new capability into the pane is a deliberate act, not something
 * that happens because a tool was added to the registry for the agent.
 */
/**
 * In-flight and recently finished write jobs.
 *
 * In-process and deliberately not persisted. Losing one on a restart is not a
 * lost write — the write either landed on the instance or it did not, and the
 * pane's answer to a missing job is to READ THE TABLE BACK, never to retry. A
 * retry would re-apply whatever the server already did.
 */
const JOBS = new Map();
const JOB_TTL_MS = 30 * 60_000;

function reapJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of JOBS) {
    if (j.status === 'done' && Date.parse(j.finishedAt ?? j.startedAt) < cutoff) JOBS.delete(id);
  }
}

const UI_WRITE_TOOLS = new Set([
  'dba_create_table',   // validated + normalized + read back by verifyTable
  'dba_add_field',      // in-scope source edit + reinstall + read back
  'dba_modify_field',   // safe half only; narrow/retype refuse and name the gate
  'dba_drop_field',     // refuses by default; needs the full E2 confirmation set
]);

dbaRouter.post('/action', async (req, res) => {
  const { tool: toolName, input = {}, sessionId = null, turnSeq = 0 } = req.body || {};

  if (!UI_WRITE_TOOLS.has(toolName)) {
    return res.status(400).json({
      ok: false,
      refused: 'not-a-ui-write-tool',
      message: `"${toolName}" is not wired into the Tables pane. The pane may only drive: `
        + `${[...UI_WRITE_TOOLS].join(', ')}. Adding one is a deliberate change to this allowlist, not something `
        + 'that follows from a tool existing in the registry.',
    });
  }
  const tool = toolMap.get(toolName);
  if (!tool?.mutating) {
    return res.status(500).json({ ok: false, refused: 'tool-not-mutating', message: `"${toolName}" is not a mutating tool.` });
  }

  /*
   * FAIL CLOSED on the binding, exactly as the deploy path does. Both guards
   * must hold before a write is attempted — a spec installed against the wrong
   * instance, or against a scope that does not exist there, is the failure the
   * whole binding discipline exists to prevent.
   */
  try {
    await assertTiersAgree({ probe: false });
    await assertAppBinding();
  } catch (err) {
    return res.status(err.status ?? 409).json({
      ok: false,
      refused: 'binding',
      message: `Refused before touching the instance: ${err.message}`,
    });
  }

  /*
   * ── WHY THIS ANSWERS BEFORE THE WORK FINISHES ──────────────────────────────
   *
   * MEASURED: a create/add/modify installs the whole application and takes six
   * to eight minutes. A synchronous response cannot survive that — undici's
   * default header timeout is five minutes and a browser's is its own business,
   * so the first live create through this endpoint returned
   * UND_ERR_HEADERS_TIMEOUT to the caller while the install went on to succeed.
   * That is the §44 shape one layer up: the client gives up on a request the
   * server completes, and the user is told a failure that did not happen.
   *
   * So the job is started, an id is returned, and the pane polls. The gate,
   * the tools and the ledger are untouched — only the transport changed. A
   * REFUSAL still resolves in milliseconds, so the common case still feels
   * immediate; it is only real work that takes minutes.
   */
  const jobId = crypto.randomUUID();
  const job = { id: jobId, tool: toolName, status: 'running', startedAt: new Date().toISOString(), result: null, error: null };
  JOBS.set(jobId, job);
  reapJobs();

  const run = (async () => {
    // The gate. `approved` + user_click is the only combination the pane can
    // present, and executeTool is what enforces that — not this file.
    const result = await executeTool(
      tool,
      input,
      'approved',
      { source: APPROVAL_SOURCES.USER_CLICK, autoApprove: false },
      { sessionId, turnSeq },
    );

    /*
     * The ledger row carries the TOOL'S OWN verification, not "the request
     * returned 200". Every DBA write tool reads its work back over a different
     * transport from the one that made it, and that read-back is what is
     * recorded and what the pane renders.
     */
    const verification = result?.verification
      ? { status: result.ok ? 'applied' : 'unverified', verified: result.ok === true, summary: result.stage ?? null, detail: result.verification }
      : { status: result?.ok ? 'applied' : 'unverified', verified: result?.ok === true, summary: result?.stage ?? null };

    appendMutation({
      sessionId: sessionId ?? 'tables-pane',
      turnSeq,
      tool: toolName,
      descriptor: { table: input.table ?? input.spec?.name ?? null, requested: input },
      result,
      verification,
      approval: 'approved',
      approvedSource: APPROVAL_SOURCES.USER_CLICK,
      approvedAt: new Date().toISOString(),
    });

    return {
      ok: result?.ok === true,
      tool: toolName,
      result,
      // Named so the UI cannot present a submission as a verification.
      verifiedBy: result?.verifiedBy
        ?? (result?.verification ? 'the tool read its work back off the instance over the Table API' : null),
    };
  })();

  run.then(
    (payload) => { job.status = 'done'; job.result = payload; job.finishedAt = new Date().toISOString(); },
    (err) => {
      log.error('dba', `${toolName} refused or failed: ${err.message}`);
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
      job.result = {
        ok: false, tool: toolName,
        refused: err.detail?.reason ?? null,
        message: err.message,
        detail: err.detail ?? null,
      };
    },
  );

  /*
   * Give a fast answer a moment to land, so the common case is one round trip.
   *
   * NOT "a refusal is instant" — that was the first version of this comment and
   * it measured false: a drop refusal took 34 SECONDS, because the gate builds
   * an impact report before it can say what is missing. So this is a courtesy
   * window, not a guarantee, and anything slower falls through to the poll.
   */
  const settled = await Promise.race([run.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 8000))]);
  if (settled && job.status === 'done') return res.json({ ...job.result, jobId, status: 'done' });

  res.status(202).json({
    jobId,
    status: 'running',
    tool: toolName,
    message: 'This installs the whole application and takes several minutes. Poll GET /api/dba/action/<jobId>. '
      + 'The instance is the authority — if this job is lost, read the table back rather than retrying, because a '
      + 'retry would re-apply whatever the server already did.',
  });
});

/** Poll one job. Unknown ids are reported as unknown, never as failed. */
dbaRouter.get('/action/:jobId', (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      status: 'unknown',
      message: 'No such job on this server. It may have finished long enough ago to be reaped, or the server '
        + 'restarted. Read the table back — the instance is the authority, and a retry would re-apply whatever '
        + 'already landed.',
    });
  }
  if (job.status !== 'done') return res.json({ jobId: job.id, status: 'running', tool: job.tool, startedAt: job.startedAt });
  res.json({ ...job.result, jobId: job.id, status: 'done', startedAt: job.startedAt, finishedAt: job.finishedAt });
});

/**
 * The pre-destruction export, which is a READ.
 *
 * `dba_snapshot` is `mutating: false` — it captures what exists so a drop has
 * evidence behind it, and it changes nothing. It therefore does not belong on
 * the write endpoint (which refuses non-mutating tools) and gets its own read
 * route. The snapshotId it returns is one of the four things the destructive
 * gate demands; the gate, not this route, decides whether that is enough.
 */
dbaRouter.post('/snapshot', async (req, res) => {
  const { table: tableName, field = null, operation = 'drop_column' } = req.body || {};
  try {
    const tool = toolMap.get('dba_snapshot');
    if (!tool) return res.status(500).json({ ok: false, message: 'dba_snapshot is not registered.' });
    const result = await executeTool(tool, { operation, table: assertName(tableName), field }, null, null, {});
    res.json({ ok: true, result });
  } catch (err) {
    res.status(err.status ?? 500).json({ ok: false, message: err.message });
  }
});
