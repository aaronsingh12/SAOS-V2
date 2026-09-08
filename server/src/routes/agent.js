import { Router } from 'express';
import { log } from '../logging.js';
import { runTurn, resolveApproval, APPROVAL_SOURCES } from '../agent/orchestrator.js';
import { beginTurn } from '../agent/task-tracker.js';
import { enabledSkills, skillSnapshot } from '../agent/skills/index.js';
import { providerInfo } from '../agent/providers/index.js';
import {
  listSessions,
  createSession,
  getSession,
  renameSession,
  deleteSession,
  deleteAllSessions,
  loadMessages,
  loadToolEvents,
  loadDigests,
} from '../memory/sessions.js';
import { search, searchSessions, embeddingsAvailable, pullCommand, embedModelName } from '../memory/recall.js';
import { listFacts, recordFact, deleteFact, rememberFromChat, seedLedger } from '../memory/facts.js';
import { clearSession as clearWriteGuard } from '../agent/write-guard.js';
import { estimateTokens, buildDigestNote } from '../memory/compaction.js';
import { computeBudget } from '../memory/budget.js';
import { buildSystemPrompt } from '../agent/prompts.js';
import { TOOLS } from '../agent/tools.js';
import { loadHistory } from '../memory/sessions.js';

export const agentRouter = Router();

agentRouter.get('/info', (_req, res) => res.json(providerInfo()));

/* ------------------------------------------------------------------ *
 * Sessions (A-1)
 * ------------------------------------------------------------------ */

agentRouter.get('/sessions', (_req, res) => res.json(listSessions()));

agentRouter.post('/sessions', (req, res) => {
  res.json(createSession({ id: req.body?.id, title: req.body?.title }));
});

agentRouter.get('/sessions/:id', async (req, res, next) => {
  const s = getSession(req.params.id);
  if (!s) return next(Object.assign(new Error('No such session.'), { status: 404 }));
  const history = loadHistory(req.params.id);
  // The budget is measured, not constant: it depends on this session's digests,
  // which are part of the system prompt. Reporting a constant here is what let
  // the real allowance drift to 4% of the window without anyone seeing it.
  const budgets = await computeBudget({
    system: buildSystemPrompt({ digestNote: buildDigestNote(req.params.id) }),
    tools: TOOLS,
  });
  res.json({
    ...s,
    // How many turns this chat has. The Meetings handoff uses it to decide
    // whether the brief still belongs in the composer — a chat that has been
    // used must never have its first message re-suggested underneath someone.
    messageCount: history.length,
    // The UI shows this so a session approaching compaction is visible before
    // it happens, rather than the transcript quietly changing shape one turn.
    tokens: {
      estimated: estimateTokens(history),
      budget: budgets.budget,
      modelContext: budgets.modelCtx,
      fixedOverhead: budgets.fixed,
      outputHeadroom: budgets.headroom,
    },
    digests: loadDigests(req.params.id).length,
  });
});

agentRouter.get('/sessions/:id/messages', (req, res) => {
  res.json({
    messages: loadMessages(req.params.id),
    digests: loadDigests(req.params.id),
    toolEvents: loadToolEvents(req.params.id),
  });
});

agentRouter.patch('/sessions/:id', (req, res, next) => {
  try { res.json(renameSession(req.params.id, req.body?.title)); }
  catch (err) { next(Object.assign(err, { status: 400 })); }
});

/*
 * Bulk chat delete. Registered BEFORE '/sessions/:id' so that the literal path
 * is not captured as an id — Express matches in declaration order, and
 * `DELETE /sessions` would otherwise never reach here.
 *
 * Conversation history only. The audit trail is preserved by construction (see
 * deleteAllSessions) and the response reports the before/after counts so the UI
 * can state what survived rather than promise it.
 */
agentRouter.delete('/sessions', (_req, res) => {
  const sessions = listSessions({ limit: 10_000 });
  for (const s of sessions) clearWriteGuard(s.id);
  const result = deleteAllSessions();
  log.info('agent', `deleted ${result.deleted} chat session(s); audit preserved: ${result.auditPreserved}`);
  res.json(result);
});

agentRouter.delete('/sessions/:id', (req, res) => {
  // The write guard's registries are in-memory and keyed on the session; a
  // deleted session must not leave its drop history behind for the id to be
  // reused against.
  clearWriteGuard(req.params.id);
  res.json(deleteSession(req.params.id));
});

/* ------------------------------------------------------------------ *
 * Recall (A-5)
 * ------------------------------------------------------------------ */

/** Mode + the exact pull command, so the UI banner never has to guess. */
/*
 * OpenRouter's model list, proxied so the picker is populated LIVE.
 *
 * Measured: GET https://openrouter.ai/api/v1/models is public (no key), returns
 * { data: [{ id, name, context_length, pricing, ... }] }, and held 396 entries
 * the day this was written. Shipping a hardcoded list of those would be trap
 * #28 — a platform list that goes stale silently.
 *
 * Failure is reported, never substituted: if the fetch fails the UI is told so
 * and the user can still type an id by hand.
 */
agentRouter.get('/openrouter/models', async (_req, res) => {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`openrouter.ai answered ${r.status}`);
    const body = await r.json();
    const models = (body.data || [])
      .map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id));
    res.json({ ok: true, count: models.length, models });
  } catch (err) {
    log.warn('agent', `could not load the OpenRouter model list: ${err.message}`);
    res.json({ ok: false, count: 0, models: [], error: `Could not load the model list (${err.message}). Type a vendor/model id instead.` });
  }
});

agentRouter.get('/memory/status', async (_req, res) => {
  const avail = await embeddingsAvailable();
  res.json({
    mode: avail.ok ? 'semantic' : 'keyword',
    degraded: !avail.ok,
    model: embedModelName(),
    dim: avail.dim,
    reason: avail.reason,
    command: avail.ok ? null : pullCommand(),
  });
});

agentRouter.get('/memory/search', async (req, res, next) => {
  const q = String(req.query.q || '').trim();
  if (!q) return next(Object.assign(new Error('q is required'), { status: 400 }));
  try {
    if (req.query.sessions === 'true') return res.json(await searchSessions(q, { limit: Number(req.query.limit) || 20 }));
    res.json(await search(q, { limit: Number(req.query.limit) || 8, sessionId: req.query.session || null }));
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ *
 * Knowledge ledger (A-4)
 * ------------------------------------------------------------------ */

agentRouter.get('/facts', (req, res) => res.json(listFacts({ kind: req.query.kind || undefined })));

agentRouter.post('/facts', (req, res, next) => {
  try { res.json(recordFact(req.body || {})); }
  catch (err) { next(Object.assign(err, { status: 400 })); }
});

agentRouter.delete('/facts/:id', (req, res) => res.json(deleteFact(Number(req.params.id))));

agentRouter.post('/facts/seed', (_req, res) => res.json(seedLedger()));

/* ------------------------------------------------------------------ *
 * Chat
 * ------------------------------------------------------------------ */

/**
 * POST /api/agent/chat  { sessionId, message }
 * Streams Server-Sent Events over the POST response body.
 *
 * PHASE 0 — this is where cancellation is OWNED. One controller per request,
 * living in this closure and nowhere else: there is no registry of in-flight
 * turns and no module-level state, so nothing outside this request can reach
 * this controller and two concurrent turns cannot cancel one another.
 *
 * The client stops a turn by aborting its own fetch, which closes this
 * response. There is no cancel endpoint, and that is deliberate — a second
 * route would need to identify the turn, which means a registry, which means
 * exactly the global state this phase is not allowed to introduce.
 */
agentRouter.post('/chat', async (req, res) => {
  const { sessionId, message, retry } = req.body || {};
  if (!sessionId || !message) {
    return res.status(400).json({ message: 'sessionId and message are required' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  /*
   * PHASE 1 — the durable task, opened BEFORE the turn begins.
   *
   * One HTTP request, one logical user turn, one task, one step. Opening it
   * here rather than lazily inside the loop is what makes that true
   * structurally: provider retries live inside the adapter, iterations and tool
   * calls live inside `runTurn`, and none of them can reach this line.
   *
   * `runTurn` is not told about any of it. The lifecycle is projected from the
   * frames it already emits (see agent/task-tracker.js), so the loop, its
   * guards, its approval gate and its cancellation boundaries are untouched.
   */
  /*
   * EXPERIENCE §44 — which skills this turn is running under, snapshotted now.
   *
   * Read here rather than inside `runTurn` so the task's record and the turn's
   * tool surface come from ONE read of the registry: two reads could straddle a
   * toggle and record a set the turn did not actually run with.
   */
  const task = beginTurn({
    sessionId,
    goal: message,
    retry: Boolean(retry),
    skills: skillSnapshot(enabledSkills({ tools: TOOLS })),
  });

  const emit = (event) => {
    // Projected BEFORE the write, so a client that has already gone away cannot
    // cost the task its terminal state — the durable record is the point, and
    // it must not depend on anyone still listening. Never throws.
    task.observe(event);
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
  };
  /*
   * PHASE 8 — tell the client which task this turn is.
   *
   * The id already existed; it simply never left the server, so the durable
   * evidence Phase 5 builds had no way of being asked for. One additive frame,
   * emitted before anything else, is the whole change: the client can now call
   * the EXISTING `GET /api/agent/plan/:taskId/evidence` for this turn.
   *
   * Additive on purpose. A client that ignores this frame behaves exactly as it
   * did, and no existing frame changed shape.
   */
  if (task.taskId) {
    try { res.write(`data: ${JSON.stringify({ type: 'task_started', taskId: task.taskId })}

`); }
    catch { /* client gone */ }
  }
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);

  /*
   * THE LIFECYCLE TRAP, and the two guards against it.
   *
   * `response` emits 'close' for BOTH outcomes Node has: "the response is
   * completed" and "the underlying connection was terminated prematurely".
   * Only the second is a cancellation. Reading them as the same event would
   * abort the controller at the end of every successful turn — harmless today,
   * because the turn has already returned, and a live trap for anyone who later
   * does work after the await.
   *
   * So the handler needs positive evidence the response did NOT finish, and it
   * gets two independent pieces: `turnSettled`, which this handler sets before
   * `res.end()`, and `res.writableEnded`, which Node sets. Either one being
   * true means this was a normal completion.
   */
  const controller = new AbortController();
  let turnSettled = false;
  const onClientGone = () => {
    if (turnSettled || res.writableEnded) return;
    log.warn('agent', `client disconnected mid-turn — cancelling  session=${sessionId.slice(0, 8)}`);
    controller.abort();
  };
  res.on('close', onClientGone);

  try {
    // "remember: ..." is handled before the turn so the fact is in the ledger
    // by the time the system prompt is built, and the agent can confirm it in
    // the same breath rather than a turn late.
    // A retry re-issues an existing turn; it must not re-trigger the side
    // effects of receiving the message for the first time.
    if (!retry) {
      const remembered = rememberFromChat(message);
      if (remembered) emit({ type: 'remembered', fact: remembered });
    }
    /*
     * EXPERIENCE §8 — the turn stamps its own task on the rows it writes.
     *
     * `task.taskId` is null only when the store could not open a task, and the
     * turn still runs: losing the projection is a defect worth logging, not a
     * reason to refuse work. A null id simply keeps the window fallback.
     */
    await runTurn(sessionId, message, emit, {
      retry: Boolean(retry), signal: controller.signal, taskId: task.taskId,
    });
  } catch (err) {
    /*
     * The stream's terminal frame is an INVARIANT, and this is the hole in it.
     *
     * `runTurn` catches its own failures and emits `error`, so this block was
     * assumed unreachable — but everything AROUND it is unguarded: the
     * `rememberFromChat` call above, and `runTurn`'s own `finally`. A throw
     * from either ran straight into the `finally` below, which called
     * `res.end()` on a 200 that had promised an event stream. The client saw a
     * clean end with no `done` and no `error`, and — because these headers are
     * already sent — Express's error middleware could not have rendered
     * anything either. The turn simply stopped, and nothing anywhere said so.
     *
     * Not retryable: an exception out here is a defect in the harness, not the
     * upstream wobbling, and offering Retry on it would just fail again.
     */
    log.error('agent', `chat stream failed outside the turn — ${err.message}`, err);
    emit({ type: 'error', message: err.message, retryable: false });
  } finally {
    clearInterval(keepAlive);
    // Phase 1 — the net. A no-op on every ordinary path, because the terminal
    // frame above has already settled the task; it fires only if the stream
    // somehow ended without one, which is an invariant violation worth
    // recording rather than leaving a task `running` for a request that has
    // provably finished.
    task.settle();
    // Set BEFORE res.end(), so the 'close' that end() causes is recognised as a
    // completion rather than as a disconnect (see onClientGone above).
    turnSettled = true;
    res.off('close', onClientGone);
    res.end();
  }
});

/**
 * POST /api/agent/approve  { sessionId, approvalId, approved, nonce }
 *
 * The approval card's two buttons post here and nowhere else. `nonce` is the
 * token the server minted for THIS card and sent once, in the
 * `approval_required` frame; without it the decision is refused and the
 * approval stays pending (WI-3).
 *
 * So `user_click` now means "originated from the rendered card of this
 * session", which is narrower than it was and still not proof a human clicked:
 * anything with access to this session's SSE stream sees the token. The
 * caveat stands with smaller scope, and is written down in
 * docs/incidents/2026-08-24-ask-act.md rather than hidden behind a value this
 * route cannot verify.
 *
 * `ok:false` carries a `reason`:
 *   no-such-approval — already answered, or timed out
 *   token-mismatch   — wrong or missing nonce; the approval is STILL PENDING
 * The client shows both rather than assuming its click landed.
 */
agentRouter.post('/approve', (req, res) => {
  const { sessionId, approvalId, approved, nonce } = req.body || {};
  const result = resolveApproval(sessionId, approvalId, approved, APPROVAL_SOURCES.USER_CLICK, nonce);
  res.json(result);
});
