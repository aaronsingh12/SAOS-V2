import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spawn } from 'node:child_process';

import {
  resolvePython, agentInstalled, supervisorStatus, processStatus,
  startProcess, stopProcess, isManaged, isStopRequested,
  processOutput, _resetForTests, _setSpawnForTests,
  PROCESSES, GRACEFUL_STOP_MS, AGENT_DIR,
} from '../src/meetings/supervisor.js';

/*
 * M6 — supervising the two Python processes.
 *
 * Real child processes, but never the real agent: spawning that would take the
 * microphone and open meetings on whatever server happened to be listening.
 * A tiny throwaway script stands in, which is enough to test everything this
 * module actually owns — spawn, capture output, refuse a double start, ask to
 * stop, kill, and report an unexpected exit honestly.
 *
 * The behaviour that CANNOT be tested here is the cooperative stop itself: it
 * needs the real agent's heartbeat loop and a real meeting in progress. What is
 * tested is this side of the contract — that `stopProcess` sets the flag the
 * heartbeat route hands over, and does NOT kill immediately.
 */

test.afterEach(() => {
  _resetForTests();
  _setSpawnForTests(null);
  delete process.env.NHA_MEETING_PYTHON;
});

/* ── the interpreter ──────────────────────────────────────────────────────── */

test('the two processes are the two documented modules', () => {
  assert.equal(PROCESSES.agent.module, 'meeting_agent');
  assert.equal(PROCESSES.stt.module, 'meeting_agent.stt_server');
  // Only the agent has a channel to be asked on, so only it can stop nicely.
  assert.equal(PROCESSES.agent.graceful, true);
  assert.equal(PROCESSES.stt.graceful, false);
});

test('a missing venv REFUSES with the command that creates it', () => {
  const saved = process.env.NHA_MEETING_PYTHON;
  process.env.NHA_MEETING_PYTHON = path.join(os.tmpdir(), 'nha-no-such-python');
  try {
    const py = resolvePython();
    assert.equal(py.ok, false);
    assert.match(py.reason, /does not exist/);
    assert.ok(py.fixes.length, 'a refusal with no fix is an unactionable error');
  } finally {
    if (saved === undefined) delete process.env.NHA_MEETING_PYTHON;
    else process.env.NHA_MEETING_PYTHON = saved;
  }
});

test('a bare "python" from PATH is never used as a fallback', () => {
  // The dependencies live in meeting-agent/.venv. A PATH python is not an
  // "almost right" answer, it is a ModuleNotFoundError several seconds after a
  // button press, attributed to nothing.
  const py = resolvePython();
  if (py.ok) {
    assert.match(py.python, /\.venv|NHA_MEETING_PYTHON/i,
      'only the venv (or an explicit override) may be used');
  } else {
    assert.ok(py.fixes.some((f) => /venv/.test(f)));
  }
});

test('status reports where the agent lives and whether it is present', () => {
  const s = supervisorStatus();
  assert.equal(s.agentDir, AGENT_DIR);
  assert.equal(s.available, agentInstalled());
  assert.deepEqual(s.processes.map((p) => p.name), ['agent', 'stt']);
});

/* ── spawning, with a stand-in ────────────────────────────────────────────── */

/**
 * Substitute a throwaway child for the real Python.
 *
 * Two halves, and both are needed. `NHA_MEETING_PYTHON` is pointed at this
 * Node binary so the interpreter check passes on a path that genuinely exists;
 * the spawn seam then runs `node -e <script>` instead of `python -m
 * meeting_agent`. Everything after that point is real — a real pid, real
 * stdout, real exit codes — which is what makes these tests worth having.
 *
 * The one thing never spawned is the real agent: it would take the microphone
 * and open meetings against whatever server is on port 4000.
 */
function stubInterpreter(script) {
  process.env.NHA_MEETING_PYTHON = process.execPath;
  _setSpawnForTests((_python, _args, opts) => spawn(process.execPath, ['-e', script], opts));
  return () => { _setSpawnForTests(null); delete process.env.NHA_MEETING_PYTHON; };
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

test('a spawned process is reported managed, with its output captured', async (t) => {
  if (!agentInstalled()) return t.skip('meeting-agent/ is not present in this checkout');
  const cleanup = stubInterpreter('console.log("hello from the stub"); setInterval(() => {}, 1000);');
  try {
    const res = startProcess('stt', { serverPort: 4000 });
    assert.equal(res.ok, true);
    assert.ok(res.pid);
    await settle();

    assert.equal(isManaged('stt'), true);
    const st = processStatus('stt');
    assert.equal(st.managed, true);
    assert.equal(st.pid, res.pid);
    assert.ok(processOutput('stt').some((l) => l.line.includes('hello from the stub')),
      'stdout must be captured — it is the only evidence of why a start failed');
  } finally { cleanup(); }
});

test('starting a second one under this server is refused', async (t) => {
  if (!agentInstalled()) return t.skip('meeting-agent/ is not present in this checkout');
  const cleanup = stubInterpreter('setInterval(() => {}, 1000);');
  try {
    assert.equal(startProcess('stt', {}).ok, true);
    await settle(200);
    const second = startProcess('stt', {});
    assert.equal(second.ok, false, 'two sidecars would fight over the same port');
    assert.match(second.error, /already running/);
  } finally { cleanup(); }
});

test('a process that dies on its own is reported as an UNREQUESTED exit', async (t) => {
  if (!agentInstalled()) return t.skip('meeting-agent/ is not present in this checkout');
  // The crash-on-import case: a pid existed for a moment, and reporting that
  // moment as "running" is exactly the lie this module must not tell.
  const cleanup = stubInterpreter('console.error("ModuleNotFoundError: no module named sounddevice"); process.exit(1);');
  try {
    assert.equal(startProcess('stt', {}).ok, true);
    await settle(600);

    assert.equal(isManaged('stt'), false);
    const st = processStatus('stt');
    assert.equal(st.managed, false);
    assert.equal(st.lastExit.code, 1);
    assert.equal(st.lastExit.requested, false, 'nobody asked it to stop — that is the point');
    assert.ok(st.recent.some((l) => l.line.includes('ModuleNotFoundError')),
      'the reason it died must survive its death');
  } finally { cleanup(); }
});

/* ── stopping ─────────────────────────────────────────────────────────────── */

test('stopping the AGENT asks rather than kills, and the flag reaches the heartbeat', async (t) => {
  if (!agentInstalled()) return t.skip('meeting-agent/ is not present in this checkout');
  // The whole reason the cooperative path exists: on Windows there is no
  // SIGTERM, so a signal-based "graceful" stop would hard-kill a recording
  // mid-write while looking correct in the code.
  const cleanup = stubInterpreter('setInterval(() => {}, 1000);');
  try {
    startProcess('agent', {});
    await settle(200);

    const res = stopProcess('agent');
    assert.equal(res.ok, true);
    assert.equal(res.mode, 'graceful');
    assert.equal(res.deadlineMs, GRACEFUL_STOP_MS);

    // Still alive — it has been ASKED, not killed. This is what lets it finish
    // the meeting it is recording.
    assert.equal(isManaged('agent'), true);
    // And this is the flag the heartbeat route hands over.
    assert.equal(isStopRequested('agent'), true);
    assert.equal(processStatus('agent').stopping, true);
  } finally { cleanup(); }
});

test('stopping the SIDECAR terminates it — it is stateless and has no channel', async (t) => {
  if (!agentInstalled()) return t.skip('meeting-agent/ is not present in this checkout');
  const cleanup = stubInterpreter('setInterval(() => {}, 1000);');
  try {
    startProcess('stt', {});
    await settle(200);
    const res = stopProcess('stt');
    assert.equal(res.mode, 'terminated');
    await settle(500);
    assert.equal(isManaged('stt'), false);
    // A requested exit, so the UI does not report it as a crash.
    assert.equal(processStatus('stt').lastExit.requested, true);
  } finally { cleanup(); }
});

test('stopping something that is not running says so rather than pretending', () => {
  const res = stopProcess('agent');
  assert.equal(res.ok, false);
  assert.match(res.error, /not running under this server/);
});

test('an unknown process name is refused', () => {
  assert.equal(startProcess('nonsense', {}).ok, false);
  assert.equal(stopProcess('nonsense').ok, false);
});

/* ── the honesty property ─────────────────────────────────────────────────── */

test('isManaged is never true for a process this server did not spawn', () => {
  // The supervisor cannot see a terminal, and must never assume one away. An
  // agent started by hand is `managed: false` — which is what makes the route
  // refuse to start a second one rather than silently duplicating meetings.
  _resetForTests();
  assert.equal(isManaged('agent'), false);
  assert.equal(processStatus('agent').managed, false);
  assert.equal(processStatus('agent').pid, null);
});
