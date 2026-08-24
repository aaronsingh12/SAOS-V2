import { Router } from 'express';
import { log } from '../logging.js';
import { runTurn, resolveApproval, APPROVAL_SOURCES } from '../agent/orchestrator.js';
import { providerInfo } from '../agent/providers/index.js';
import {
  listSessions,
  createSession,
  getSession,
  renameSession,
  deleteSession,
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
  const emit = (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
  };
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);
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
    await runTurn(sessionId, message, emit, { retry: Boolean(retry) });
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
    res.end();
  }
});

/**
 * POST /api/agent/approve  { sessionId, approvalId, approved }
 *
 * The approval card's two buttons post here and nowhere else, so a decision
 * arriving here is recorded as `user_click` (WI-4). This app is unauthenticated
 * local dev: anything that knows an approvalId can reach this endpoint and would
 * be recorded the same way. That limit is documented in
 * docs/incidents/2026-08-24-ask-act.md rather than hidden behind a value this
 * route cannot verify.
 *
 * `ok:false` means the gate was not waiting for this approval — it had already
 * been answered, or it timed out. The client SHOWS that rather than assuming its
 * click landed.
 */
agentRouter.post('/approve', (req, res) => {
  const { sessionId, approvalId, approved } = req.body || {};
  const ok = resolveApproval(sessionId, approvalId, approved, APPROVAL_SOURCES.USER_CLICK);
  res.json({ ok });
});
