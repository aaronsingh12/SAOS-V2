import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log } from '../logging.js';

/**
 * M6 — running the two Python processes from the UI instead of from a terminal.
 *
 * The capture agent and the STT sidecar have always been started by hand, in
 * two VS Code terminals, which meant meeting capture only worked when someone
 * remembered to start it and left the terminals open. This supervises both from
 * the server, so a button in the app is enough.
 *
 * WHAT THIS IS NOT. It is not a process manager: no restarts, no backoff, no
 * daemonising. It spawns a child, watches it, kills it, and reports honestly
 * what state it is in. Anything cleverer would be a second scheduler competing
 * with the one the operating system already has.
 *
 * THE THREE THINGS THAT MATTER
 *
 * 1. IT MUST NOT LIE ABOUT WHETHER SOMETHING IS RUNNING. "Spawned" and
 *    "working" are different facts, and this module only knows the first one.
 *    Liveness for the agent comes from its HEARTBEAT and for the sidecar from
 *    its HEALTH ENDPOINT — both owned elsewhere, both unchanged. A child whose
 *    pid exists but which crashed on an import error is reported as exited,
 *    with its output, not as running.
 *
 * 2. IT MUST NOT START A SECOND ONE. The agent holds the microphone and opens
 *    meetings on the server; two of them would produce duplicate meetings and
 *    fight over the same devices. The sidecar binds a port and the second would
 *    simply fail. Neither failure is obvious from the UI, so the ROUTE refuses
 *    when something is already alive — including an instance started by hand in
 *    a terminal, which this module cannot see and must never assume away.
 *
 * 3. STOPPING MUST NOT ABANDON A MEETING MID-WRITE. This is a Windows problem
 *    with a Windows answer, and it is why `requestStop` exists. There is no
 *    SIGTERM on Windows — Node's `kill()` calls TerminateProcess, which is a
 *    hard kill — so a "graceful stop" implemented with signals would silently
 *    be a hard one, cutting off a recording that was in progress. Instead the
 *    stop is COOPERATIVE: the flag is set here, the agent reads it on its next
 *    heartbeat (≤5s), finishes the meeting it is recording and exits on its
 *    own. The hard kill is the fallback, after a timeout, and it is reported as
 *    one.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** <repo>/meeting-agent — server/src/meetings -> server/src -> server -> repo */
const AGENT_DIR = path.resolve(__dirname, '../../..', 'meeting-agent');

/**
 * The two processes, and the module each one runs.
 *
 * `graceful` says whether this process can be asked to stop rather than killed.
 * Only the agent can: it heartbeats, so there is a channel to ask it on. The
 * sidecar is stateless by design ("it owns no queue, no priorities, no
 * backpressure policy"), so a hard kill costs at most one in-flight
 * transcription, which the Node queue still has pending and will retry.
 */
export const PROCESSES = Object.freeze({
  agent: {
    module: 'meeting_agent',
    label: 'capture agent',
    graceful: true,
    what: 'detects meetings, records them, and posts utterances',
  },
  stt: {
    module: 'meeting_agent.stt_server',
    label: 'transcription sidecar',
    graceful: false,
    what: 'turns one WAV into text on port 4600',
  },
});

/** How long a cooperative stop is given before the process is killed. */
export const GRACEFUL_STOP_MS = 20_000;

/** Output lines kept per process. Enough to see a Python traceback whole. */
const LOG_LINES = 200;

/* ------------------------------------------------------------------ *
 * Which Python
 * ------------------------------------------------------------------ */

/**
 * Find the interpreter, and REFUSE rather than fall back to one that will not
 * work.
 *
 * The agent's dependencies (sounddevice, onnxruntime, faster-whisper) are
 * installed into `meeting-agent/.venv`, so a bare `python` from PATH is not an
 * "almost right" answer — it is a `ModuleNotFoundError` several seconds after a
 * button press, attributed to nothing. Naming the missing venv and the command
 * that creates it is the whole difference between a setup step and a bug.
 *
 * `NHA_MEETING_PYTHON` overrides, for a machine whose environment is managed
 * some other way.
 */
export function resolvePython() {
  const override = process.env.NHA_MEETING_PYTHON;
  if (override) {
    if (!fs.existsSync(override)) {
      return {
        ok: false,
        reason: `NHA_MEETING_PYTHON points at ${override}, which does not exist.`,
        fixes: ['Correct NHA_MEETING_PYTHON, or unset it to use meeting-agent/.venv.'],
      };
    }
    return { ok: true, python: override, source: 'NHA_MEETING_PYTHON' };
  }

  const candidates = process.platform === 'win32'
    ? [path.join(AGENT_DIR, '.venv', 'Scripts', 'python.exe')]
    : [path.join(AGENT_DIR, '.venv', 'bin', 'python3'), path.join(AGENT_DIR, '.venv', 'bin', 'python')];

  for (const c of candidates) {
    if (fs.existsSync(c)) return { ok: true, python: c, source: 'venv' };
  }

  return {
    ok: false,
    reason: `No Python environment at ${path.join(AGENT_DIR, '.venv')}.`,
    fixes: [
      'cd meeting-agent',
      process.platform === 'win32'
        ? 'python -m venv .venv && .\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt'
        : 'python3 -m venv .venv && ./.venv/bin/python -m pip install -r requirements.txt',
    ],
  };
}

/** Is the agent's source tree even here? A packaged install may not ship it. */
export function agentInstalled() {
  return fs.existsSync(path.join(AGENT_DIR, 'meeting_agent', '__main__.py'));
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/** name -> { child, pid, startedAt, stopRequestedAt, killTimer, lines, exit } */
const state = new Map();

/**
 * Test seam, mirroring `_setChatTurnForTests` in agent/providers/index.js.
 *
 * What this module owns is a STATE MACHINE — spawned, alive, asked to stop,
 * killed, exited-on-its-own — and nothing short of driving it with a real child
 * process tests it. The one child it must never spawn in a test is the real
 * agent: that takes the microphone and opens meetings against whatever server
 * happens to be listening on port 4000, which on this machine is usually the
 * developer's own.
 *
 * So the tests substitute a throwaway process here and exercise everything else
 * for real — real pids, real stdout, real exit codes. Null in every non-test
 * process; only the suite ever calls this.
 */
let spawnFn = spawn;
export function _setSpawnForTests(fn) { spawnFn = fn || spawn; }

const blank = () => ({
  child: null, pid: null, startedAt: null,
  stopRequestedAt: null, killTimer: null,
  lines: [], exit: null,
});

function slot(name) {
  if (!state.has(name)) state.set(name, blank());
  return state.get(name);
}

function record(name, stream, text) {
  const s = slot(name);
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    s.lines.push({ at: new Date().toISOString(), stream, line: line.slice(0, 1000) });
  }
  // Bounded: a process left running for a week must not become a memory leak.
  if (s.lines.length > LOG_LINES) s.lines.splice(0, s.lines.length - LOG_LINES);
}

/** Is this a child WE spawned, and is it still alive? */
export function isManaged(name) {
  const s = state.get(name);
  return Boolean(s?.child && s.child.exitCode === null && !s.child.killed);
}

/**
 * Has a stop been asked for and not yet happened?
 *
 * Read by the heartbeat route, which is the channel the agent listens on. This
 * is the entire cooperative-stop mechanism on this side.
 */
export function isStopRequested(name) {
  return Boolean(state.get(name)?.stopRequestedAt);
}

/* ------------------------------------------------------------------ *
 * Start / stop
 * ------------------------------------------------------------------ */

/**
 * Spawn one process.
 *
 * Refuses if one is already running under this server. It deliberately does NOT
 * check whether one is running OUTSIDE it — this module cannot see a terminal —
 * so the caller must do that. `routes/meetings.js` does, using the heartbeat
 * and the sidecar's health endpoint, which are the only two things that
 * actually know.
 *
 * @param {'agent'|'stt'} name
 * @param {{ serverPort: number }} opts
 */
export function startProcess(name, { serverPort } = {}) {
  const spec = PROCESSES[name];
  if (!spec) return { ok: false, error: `Unknown process "${name}".` };
  if (isManaged(name)) {
    return { ok: false, error: `The ${spec.label} is already running (pid ${state.get(name).pid}).` };
  }
  if (!agentInstalled()) {
    return {
      ok: false,
      error: `The capture agent source is not present at ${AGENT_DIR}.`,
      fixes: ['This build does not ship meeting-agent/. Check out the full repository to use meeting capture.'],
    };
  }

  const py = resolvePython();
  if (!py.ok) return { ok: false, error: py.reason, fixes: py.fixes };

  const s = blank();
  state.set(name, s);

  let child;
  try {
    child = spawnFn(py.python, ['-m', spec.module], {
      cwd: AGENT_DIR,
      env: {
        ...process.env,
        // The agent defaults to 127.0.0.1:4000. If this server was started on
        // another port, that default is wrong and the agent would heartbeat
        // into nothing — so it is told explicitly rather than left to agree by
        // coincidence.
        NHA_SERVER: `http://127.0.0.1:${serverPort || process.env.PORT || 4000}`,
        // Unbuffered, or Python holds whole lines back and the output pane
        // stays empty through the exact minute someone is watching it to find
        // out why nothing happened.
        PYTHONUNBUFFERED: '1',
      },
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, error: `Could not start the ${spec.label}: ${err.message}` };
  }

  s.child = child;
  s.pid = child.pid;
  s.startedAt = new Date().toISOString();
  record(name, 'system', `$ ${py.python} -m ${spec.module}`);

  child.stdout?.on('data', (d) => record(name, 'out', d));
  child.stderr?.on('data', (d) => record(name, 'err', d));

  child.on('error', (err) => {
    record(name, 'err', `failed to run: ${err.message}`);
    log.error('meetings', `${spec.label} failed to start: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    if (s.killTimer) { clearTimeout(s.killTimer); s.killTimer = null; }
    const requested = Boolean(s.stopRequestedAt);
    s.exit = { code, signal, at: new Date().toISOString(), requested };
    s.stopRequestedAt = null;
    record(name, 'system', `exited with code ${code}${signal ? ` (${signal})` : ''}`);
    // An UNREQUESTED exit is the interesting one: it means the process died on
    // its own, and the reason is in the lines above it.
    const how = requested ? 'stopped' : `EXITED UNEXPECTEDLY (code ${code}${signal ? `, ${signal}` : ''})`;
    log[requested ? 'info' : 'warn']('meetings', `${spec.label} ${how}`);
  });

  log.info('meetings', `${spec.label} started  pid ${child.pid}  (${py.source})`);
  return { ok: true, pid: child.pid, python: py.python, startedAt: s.startedAt };
}

/**
 * Stop one process.
 *
 * For the agent this ASKS rather than kills: the flag is set, the heartbeat
 * route hands it over within five seconds, and the agent closes the meeting it
 * is recording before exiting. A recording cut off mid-write is the one outcome
 * a stop button must not produce, and on Windows a signal-based "graceful" stop
 * would produce exactly that while looking correct in the code.
 *
 * The kill is the fallback, on a timer, and it says that it was a kill.
 */
export function stopProcess(name) {
  const spec = PROCESSES[name];
  if (!spec) return { ok: false, error: `Unknown process "${name}".` };
  const s = state.get(name);
  if (!isManaged(name)) {
    return { ok: false, error: `The ${spec.label} is not running under this server.` };
  }
  if (s.stopRequestedAt) {
    return { ok: true, mode: 'already-stopping', requestedAt: s.stopRequestedAt };
  }

  s.stopRequestedAt = new Date().toISOString();

  if (!spec.graceful) {
    record(name, 'system', 'stopping');
    s.child.kill();
    return { ok: true, mode: 'terminated' };
  }

  record(name, 'system', 'stop requested — it will finish the current meeting first');
  s.killTimer = setTimeout(() => {
    if (!isManaged(name)) return;
    record(name, 'system', `did not stop within ${GRACEFUL_STOP_MS / 1000}s — killing it`);
    log.warn('meetings',
      `${spec.label} did not stop within ${GRACEFUL_STOP_MS / 1000}s; killing pid ${s.pid}. ` +
      'A meeting that was recording may be left open — check the Meetings page.');
    try { s.child.kill(); } catch { /* already gone */ }
  }, GRACEFUL_STOP_MS);
  // A pending kill must never hold the process open on its own.
  s.killTimer.unref?.();

  return { ok: true, mode: 'graceful', deadlineMs: GRACEFUL_STOP_MS };
}

/**
 * What this module actually knows, per process, stated as three separate facts
 * rather than one blurred "running".
 */
export function processStatus(name) {
  const spec = PROCESSES[name];
  const s = state.get(name) || blank();
  const managed = isManaged(name);
  return {
    name,
    label: spec.label,
    what: spec.what,
    // We spawned it and its pid is alive. NOT a claim that it works — see the
    // heartbeat and the sidecar health check for that.
    managed,
    pid: managed ? s.pid : null,
    startedAt: managed ? s.startedAt : null,
    stopping: managed && Boolean(s.stopRequestedAt),
    graceful: spec.graceful,
    // Kept after exit on purpose: "it died" plus the reason is the state
    // someone most needs, and clearing it on exit would erase the answer.
    lastExit: s.exit,
    recent: s.lines.slice(-40),
  };
}

export function supervisorStatus() {
  const py = resolvePython();
  return {
    available: agentInstalled(),
    agentDir: AGENT_DIR,
    python: py.ok
      ? { ok: true, path: py.python, source: py.source }
      : { ok: false, reason: py.reason, fixes: py.fixes },
    processes: Object.keys(PROCESSES).map(processStatus),
  };
}

/** Recent output for one process, for the panel that shows why it failed. */
export function processOutput(name, { limit = LOG_LINES } = {}) {
  const s = state.get(name) || blank();
  return s.lines.slice(-limit);
}

/* ------------------------------------------------------------------ *
 * Never leave orphans
 * ------------------------------------------------------------------ */

/**
 * A child outliving the server is the worst outcome available here: it still
 * holds the microphone, still opens meetings against a server that is gone, and
 * nothing in the UI can see it any more to stop it. `node --watch` restarts
 * make that a routine event rather than a rare one, so this is not defensive
 * tidying — without it, a few minutes of development leaves several agents
 * recording.
 *
 * Killed rather than asked: the exit handlers are synchronous and there is no
 * time left to wait 20 seconds for a cooperative stop.
 */
let hooked = false;
export function installExitCleanup() {
  if (hooked) return;
  hooked = true;
  const killAll = () => {
    for (const name of state.keys()) {
      if (!isManaged(name)) continue;
      try { state.get(name).child.kill(); } catch { /* already gone */ }
    }
  };
  process.on('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { killAll(); process.exit(0); });
  }
}

/** Test seam: forget everything, killing anything still running. */
export function _resetForTests() {
  for (const name of [...state.keys()]) {
    const s = state.get(name);
    if (s.killTimer) clearTimeout(s.killTimer);
    if (isManaged(name)) { try { s.child.kill(); } catch { /* gone */ } }
  }
  state.clear();
}

export { AGENT_DIR };
