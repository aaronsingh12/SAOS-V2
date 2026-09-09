import crypto from 'node:crypto';
import { Router } from 'express';
import { flows, designFlowBlueprint } from '../servicenow/flows.js';
import { capability, createLiveFlow, listManaged, removeManaged, smokeRun, subflowCatalog, verify } from '../servicenow/fluent.js';
import { startBuildRun, finishBuildRun, auditedEmit } from '../memory/audit.js';
import { awaitApprovalDecision } from '../agent/orchestrator.js';
import { log } from '../logging.js';

export const flowsRouter = Router();

/* ---------------- live authoring (Fluent SDK) ----------------
 * Registered before '/:sysId' so "live" is not read as a sys_id. */

flowsRouter.get('/live/capability', async (req, res, next) => {
  try { res.json(await capability({ deep: req.query.deep === 'true', force: req.query.force === 'true' })); }
  catch (err) { next(err); }
});

flowsRouter.get('/live', async (_req, res, next) => {
  try { res.json(await listManaged()); } catch (err) { next(err); }
});

/** The reuse catalog exactly as codegen is shown it. Read-only. */
flowsRouter.get('/live/catalog', async (_req, res, next) => {
  try { res.json({ subflows: await subflowCatalog() }); } catch (err) { next(err); }
});

/**
 * POST /api/flows/live { spec } | { blueprint }, optional updates, artifact_type, sessionId
 * Streams SSE progress, mirroring /api/agent/chat.
 *
 * SESSION 1 / WI-4 — BEHIND THE ONE APPROVAL GATE.
 *
 * This route installs a whole application onto the bound instance, and until
 * now it did so on a button press with no card: the Flows page was the one
 * surface where a mutation reached the instance without the gate every other
 * path passes through. It now waits at the SAME gate the turn loop and the
 * plan executor use — `awaitApprovalDecision`, the nonce-bound card, and
 * `POST /api/agent/approve` as the only resolver — so the page renders the
 * card and the person clicks it, exactly as in the workspace. The pending
 * entry is registered before the card is emitted (WI-2).
 *
 * `sessionId` is whatever the page supplies (it mints one per visit); the gate
 * needs an address to resolve against, not a chat transcript.
 */
flowsRouter.post('/live', async (req, res) => {
  const { spec, blueprint, updates, artifact_type: artifactType } = req.body || {};
  const sessionId = String(req.body?.sessionId || 'flows-page');
  const text = spec || (blueprint ? blueprintToSpec(blueprint) : null);
  if (!text) return res.status(400).json({ message: 'spec (or blueprint) is required' });
  if (artifactType && !['flow', 'subflow'].includes(artifactType)) {
    return res.status(400).json({ message: 'artifact_type must be "flow" or "subflow"' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
  };
  // D-5: this installs a whole application onto the instance, so it is
  // auditable activity and not just progress on a screen.
  const run = startBuildRun({
    kind: 'flow_build',
    label: firstLine(text),
    request: { spec: text, updates: updates || null, artifactType: artifactType || null, sessionId },
    session: sessionId,
  });
  const emit = auditedEmit(run, write);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);

  // A closed connection cancels a card that is still waiting; a build that has
  // started finishes and is recorded, exactly as in the turn loop.
  const controller = new AbortController();
  const onClientGone = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', onClientGone);

  try {
    const approvalId = crypto.randomUUID();
    const nonce = crypto.randomBytes(32).toString('base64url');
    const decisionPending = awaitApprovalDecision(sessionId, approvalId, nonce, controller.signal);
    emit({
      type: 'approval_required',
      approvalId,
      nonce,
      sessionId,
      name: 'create_flow_live',
      input: { spec: text, updates: updates || null, artifact_type: artifactType || null },
      operation: updates
        ? `Regenerate "${updates}" in place and reinstall the application`
        : `Generate, compile and install a new ${artifactType || 'flow'} into the workspace application`,
      warning: 'now-sdk install ships the WHOLE application — every managed artifact is redeployed, not just this one.',
    });
    log.warn('gate', `approval required: flows page build (${firstLine(text).slice(0, 60)}) — waiting for the user`);
    const decision = await decisionPending;
    emit({ type: 'approval_resolved', approvalId, approved: decision.approved, source: decision.source, at: decision.at });

    if (!decision.approved) {
      const reason = decision.source === 'cancelled' ? 'cancelled' : decision.source === 'timeout' ? 'approval_timeout' : 'rejected';
      const message = reason === 'cancelled'
        ? 'The page went away while the card was waiting. Nothing was built and nothing was installed.'
        : reason === 'approval_timeout'
          ? 'The approval was never answered and expired. Nothing was built and nothing was installed.'
          : 'The build was rejected. Nothing was built and nothing was installed.';
      emit({ type: 'error', reason, message });
      finishBuildRun(run, { status: 'error', summary: { reason, message } });
      return undefined;
    }

    const result = await createLiveFlow(text, emit, { updates: updates || null, artifactType: artifactType || null });
    emit(result.ok ? { type: 'done', result } : { type: 'error', ...result });
    finishBuildRun(run, { status: result.ok ? 'ok' : 'error', summary: result });
  } catch (err) {
    emit({ type: 'error', message: err.message });
    finishBuildRun(run, { status: 'error', summary: { message: err.message } });
  } finally {
    clearInterval(keepAlive);
    res.off('close', onClientGone);
    res.end();
  }
  return undefined;
});

/**
 * POST /api/flows/live/verify { name }
 * Runs the stored verification spec: setup → wait → assert → cleanup, streamed.
 * This CREATES a real record (and deletes it again), so it is never automatic.
 */
flowsRouter.post('/live/verify', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ message: 'name is required' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (event) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ } };
  // Verification writes a real record and deletes it again, which is exactly
  // the kind of thing someone reading an audit trail needs to see accounted for.
  const run = startBuildRun({ kind: 'flow_verify', label: name, request: { name } });
  const emit = auditedEmit(run, write);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);
  try {
    const result = await verify(name, emit);
    emit({ type: 'done', result });
    finishBuildRun(run, { status: result?.ok === false ? 'error' : 'ok', summary: result });
  } catch (err) {
    emit({ type: 'error', message: err.message });
    finishBuildRun(run, { status: 'error', summary: { message: err.message } });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

/**
 * POST /api/flows/live/smoke { table, values, wait_ms }
 * Explicitly fires a flow by creating (and then deleting) a matching record.
 * Never invoked as part of a deploy — the caller has to ask for it.
 */
flowsRouter.post('/live/smoke', async (req, res, next) => {
  const { table, values, wait_ms } = req.body || {};
  if (!table || !values) return res.status(400).json({ message: 'table and values are required' });
  // Not SSE, but it creates a record on the instance, so it is recorded as a
  // single-shot run. An audit that only covered the streaming endpoints would
  // be an audit with a hole in exactly the shape of "writes we did quickly".
  const run = startBuildRun({ kind: 'flow_smoke', label: table, request: { table, values, waitMs: wait_ms || 45000 } });
  try {
    const result = await smokeRun({ table, values, waitMs: wait_ms || 45000 });
    finishBuildRun(run, { status: result.ok ? 'ok' : 'error', summary: result });
    res.status(result.ok ? 200 : 422).json(result);
  } catch (err) {
    finishBuildRun(run, { status: 'error', summary: { message: err.message } });
    next(err);
  }
});

flowsRouter.delete('/live/:name', async (req, res, next) => {
  const name = decodeURIComponent(req.params.name);
  const run = startBuildRun({ kind: 'flow_delete', label: name, request: { name } });
  try {
    const result = await removeManaged(name);
    finishBuildRun(run, { status: result.ok ? 'ok' : 'error', summary: result });
    // A delete refused because a live flow still calls the subflow is a
    // CONFLICT, not a validation error: nothing about the request was wrong,
    // and the caller list is the thing the client has to show.
    res.status(result.ok ? 200 : result.blocked ? 409 : 422).json(result);
  } catch (err) {
    finishBuildRun(run, { status: 'error', summary: { message: err.message } });
    next(err);
  }
});

/** A run's label has to fit a table cell; the request itself is kept whole. */
function firstLine(text) {
  const line = String(text || '').split('\n').find((l) => l.trim()) || '';
  return line.trim().slice(0, 160);
}

/** A blueprint is already a precise design — flatten it into a spec sentence set. */
function blueprintToSpec(bp) {
  const t = bp.trigger || {};
  const lines = [
    `Create an automation named "${bp.name}".`,
    bp.description ? `Purpose: ${bp.description}` : null,
    t.type ? `Trigger: ${t.type}${t.table ? ` on the ${t.table} table` : ''}${t.condition_plain ? ` when ${t.condition_plain}` : ''}.` : null,
    t.condition_encoded_query ? `Trigger condition (encoded query): ${t.condition_encoded_query}` : null,
    t.schedule ? `Schedule: ${t.schedule}` : null,
    'Steps:',
    ...(bp.steps || []).map((s, i) => `  ${s.order ?? i + 1}. [${s.kind}] ${s.summary}${s.flow_designer_action ? ` (action: ${s.flow_designer_action})` : ''}`),
  ].filter(Boolean);
  return lines.join('\n');
}

flowsRouter.get('/', async (req, res, next) => {
  try {
    res.json(await flows.list({
      search: req.query.search,
      activeOnly: req.query.active === 'true',
      type: req.query.type || 'all',
    }));
  } catch (err) { next(err); }
});

flowsRouter.get('/executions', async (req, res, next) => {
  try { res.json(await flows.executions(req.query.flow)); } catch (err) { next(err); }
});

flowsRouter.get('/:sysId', async (req, res, next) => {
  try { res.json(await flows.detail(req.params.sysId)); } catch (err) { next(err); }
});

/*
 * SESSION 1 / WI-4 — two routes are gone from here on purpose:
 *
 *   POST /:sysId/active       flipped sys_hub_flow.active over REST — a raw
 *                             write to a Flow Designer header, which the
 *                             policy now refuses everywhere. A flow is
 *                             activated by installing it through the SDK.
 *   POST /blueprint-to-rule   created an inactive Business Rule "for
 *                             environments where the SDK cannot run" — an
 *                             artifact nobody asked for, substituted for the
 *                             one they did. Where the SDK cannot run the
 *                             honest answer is the capability banner.
 */

flowsRouter.post('/design', async (req, res, next) => {
  try {
    if (!req.body?.description) return res.status(400).json({ message: 'description is required' });
    res.json(await designFlowBlueprint(req.body.description));
  } catch (err) { next(err); }
});
