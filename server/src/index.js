import express from 'express';
import cors from 'cors';
import { systemRouter } from './routes/system.js';
import { incidentsRouter } from './routes/incidents.js';
import { catalogRouter } from './routes/catalog.js';
import { flowsRouter } from './routes/flows.js';
import { agentRouter } from './routes/agent.js';
import { planRouter } from './routes/plan.js';
import { slaRouter } from './routes/sla.js';
import { accessRouter } from './routes/access.js';
import { dbaRouter } from './routes/dba.js';
import { meetingsRouter } from './routes/meetings.js';
import { requeuePending } from './meetings/queue.js';
import { closeOrphanedRecordings } from './meetings/store.js';
import { auditRouter } from './routes/audit.js';
import { applicationsRouter } from './routes/applications.js';
import { transportRouter } from './routes/transport.js';
import { logsRouter } from './routes/logs.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { skillsRouter } from './routes/skills.js';
import { log, requestLogger, banner } from './logging.js';
import { SnowError } from './servicenow/client.js';
import { getDb } from './memory/db.js';
import { seedLedger } from './memory/facts.js';
import { getSettings } from './config/store.js';
// Loaded for its side effect: registers the instance-switch hook on config/store
// so no path can save a connection without per-instance state being flushed (B6).
import { boundInstance } from './servicenow/instance-binding.js';
import { DB_PATH } from './memory/db.js';
// Registration side effect: hooks the post-install state reconciler onto every
// deploy, so an install cannot silently revert an out-of-SDK-model flag (F1).
import './servicenow/post-install-state.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
// Before the routes, so a request is logged even when it 404s.
app.use(requestLogger());

app.use('/api/system', systemRouter);
app.use('/api/incidents', incidentsRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/flows', flowsRouter);
app.use('/api/agent', agentRouter);
// Phase 4: plan -> review -> approve -> execute -> verify. ADDITIVE — the
// chat route above is untouched and still runs the ordinary turn loop.
// Mounted UNDER /api/agent so a plan's approval card resolves through the
// same POST /api/agent/approve endpoint every other approval already uses.
app.use('/api/agent/plan', planRouter);
app.use('/api/sla', slaRouter);
app.use('/api/access', accessRouter);
// Phase T1: the Tables pane. Read-only — see routes/dba.js.
app.use('/api/dba', dbaRouter);
// Meeting Intelligence phase 1: capture ingest from the local agent, plus the
// reads the Meetings page needs. No transcription yet — see meetings/store.js.
app.use('/api/meetings', meetingsRouter);
app.use('/api/audit', auditRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api/transport', transportRouter);
app.use('/api/logs', logsRouter);
app.use('/api/knowledge', knowledgeRouter);
/*
 * EXPERIENCE §28 — the skill registry. Read, install, enable, disable, remove.
 * Nothing here executes a skill: a skill is data, and there is no route that
 * could run one (§29, §31, §75).
 */
app.use('/api/skills', skillsRouter);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err instanceof SnowError ? err.status : (err.status || 500);
  // The terminal gets the stack; the browser gets the message. Before this,
  // a 500 was a red box in the UI and nothing anywhere else.
  log.error('http', `${req.method} ${req.originalUrl.split('?')[0]} — ${err.message}`, err.detail ? { detail: err.detail, stack: err.stack } : err);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    message: err.message || 'Internal error',
    detail: err.detail || null,
  });
});

// A crash in an async handler must not die silently in a detached terminal.
process.on('unhandledRejection', (reason) => log.error('process', 'unhandled promise rejection', reason));
process.on('uncaughtException', (err) => { log.error('process', 'uncaught exception', err); process.exit(1); });

const PORT = Number(process.env.PORT) || 4000;

/*
 * WI-3 — THE LISTENER BINDS LOOPBACK, AND SAYS SO IF IT CANNOT.
 *
 * This process holds a ServiceNow admin password, and `POST /api/agent/approve`
 * authorises writes to a live instance. It has no authentication of any kind —
 * that is a deliberate, documented property of a local dev tool, and it is only
 * defensible while the socket is unreachable from anywhere else. `app.listen(PORT)`
 * binds 0.0.0.0, which on a laptop on a conference network is the whole app,
 * admin credentials included, offered to the LAN.
 *
 * `HOST` exists so that someone who genuinely means to expose it has to say so
 * out loud. Anything but a loopback address fails at boot rather than starting
 * and hoping — the alternative is a server that is only as safe as the network
 * it happens to be on, with nothing anywhere saying which one that was.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const HOST = process.env.HOST || '127.0.0.1';
if (!LOOPBACK.has(HOST)) {
  log.error('http',
    `refusing to bind ${HOST}: NowHelpAssist is unauthenticated and holds instance admin credentials, ` +
    `and its approval endpoint authorises writes to ${getSettings().connection.instanceUrl || 'the bound instance'}. ` +
    `It may only listen on loopback (${[...LOOPBACK].join(', ')}). Unset HOST, or put a real proxy in front of it.`);
  process.exit(1);
}

// Storage comes up before the listener: migrations are idempotent, and a
// database that cannot open should stop the server rather than fail the first
// chat turn with something unrecognisable.
getDb();
const seeded = seedLedger();

/*
 * The transcription queue is in memory, so a restart mid-meeting would leave
 * every already-captured utterance permanently untranscribed while its audio
 * sat on disk — a hole in the transcript that nothing would ever fill and
 * nothing would report. Re-queuing on boot is what makes the crash-safety
 * claim in meetings/queue.js true rather than aspirational.
 */
// A meeting still marked `recording` at boot is one the agent never closed.
const orphans = closeOrphanedRecordings();
const requeued = requeuePending();

/*
 * The listener, and why it is not a one-liner any more.
 *
 * MEASURED on this machine (Node v24.18.0, Windows 11), reproduced 3/3:
 * `npm run dev` is `node --watch src/index.js`. On the FIRST source edit the
 * watcher force-kills the old process and starts the new one immediately —
 * before the OS has released the listening socket. The new process then got
 * `EADDRINUSE` as an unhandled 'error' event on the http server, which the
 * `uncaughtException` handler above turned into `process.exit(1)`. `--watch`
 * printed "Failed running 'src/index.js'. Waiting for file changes before
 * restarting..." and the API server stayed DEAD until someone touched another
 * file.
 *
 * From the browser that reads exactly as the reported symptom, in this order:
 *   [vite] http proxy error: /api/...  Error: read ECONNRESET      <- the kill
 *   [vite] http proxy error: /api/...  AggregateError [ECONNREFUSED]  <- after
 *
 * Two things were wrong and both are fixed here:
 *   1. a transient port race was terminal. It is now retried, because the
 *      socket is released within a few hundred milliseconds and waiting for it
 *      is the whole fix;
 *   2. a genuinely occupied port died with a Node stack trace naming
 *      `net.js`. It now says which port, and what to do about it.
 *
 * The retry window is deliberately short. It is long enough for a watcher
 * handoff and far too short to mask a second server someone actually left
 * running — that still fails, loudly, with instructions.
 */
const LISTEN_RETRY_MS = 250;
const LISTEN_RETRIES = 10;

let server = null;

function start(attempt = 1) {
  server = app.listen(PORT, HOST, () => {
    const s = getSettings();
    banner([
      `NowHelpAssist  ·  http://localhost:${PORT}   (bound ${HOST} — loopback only)`,
      `instance   ${s.connection.instanceUrl || '(none bound)'}   (both tiers derive from this)`,
      `model      ${s.llm.provider} · ${s.llm.model || '(default)'}`,
      `storage    ${DB_PATH}`,
      `ledger     ${seeded.seeded} facts for ${seeded.instance}`,
      `meetings   ${requeued} utterance(s) re-queued${orphans ? `, ${orphans} stuck meeting(s) closed` : ''}`,
      `log level  ${log.level}   (LOG_LEVEL=debug for polls and reads)`,
    ]);
  });
  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') {
      log.error('http', `the server could not start: ${err.message}`, err);
      process.exit(1);
    }
    if (attempt < LISTEN_RETRIES) {
      // Only the first one is worth a line; the rest would be noise on what is
      // normally a sub-second wait.
      if (attempt === 1) {
        log.warn('http', `port ${PORT} is still held by the previous process — waiting for it to be released ` +
          `(up to ${LISTEN_RETRIES * LISTEN_RETRY_MS}ms). This is the normal --watch restart handoff.`);
      }
      // NOT unref'd: while the server is not listening nothing else holds the
      // event loop open, so an unref'd timer would exit the process silently —
      // which is the failure being fixed, wearing a different hat.
      setTimeout(() => start(attempt + 1), LISTEN_RETRY_MS);
      return;
    }
    log.error('http',
      `port ${PORT} is already in use after ${LISTEN_RETRIES} attempts over ` +
      `${LISTEN_RETRIES * LISTEN_RETRY_MS}ms. Another NowHelpAssist server is almost certainly still running. ` +
      `Stop it, or start this one on a different port with PORT=4001 npm run dev ` +
      `(the client proxies to 4000, so change client/vite.config.js too).`);
    process.exit(1);
  });
}

/*
 * Shut down so the NEXT process does not have to wait at all.
 *
 * Without this the port is released only when the OS reaps the killed process,
 * which is the race above. `closeAllConnections` is the load-bearing call:
 * `server.close()` alone waits for every keep-alive socket to go idle, and the
 * client holds one open per tab plus one per in-flight SSE stream — so a plain
 * close would hang until the timeout and never actually free the port faster.
 */
function shutdown(signal) {
  log.info('process', `${signal} — shutting down`);
  if (!server) process.exit(0);
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  // A socket that refuses to die must not hold the port hostage either.
  setTimeout(() => process.exit(0), 2000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => shutdown(sig));
}

start();
