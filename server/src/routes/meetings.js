import fs from 'node:fs';
import { Router } from 'express';
import { log } from '../logging.js';
import {
  startMeeting, endMeeting, addSegment, getSegment, listSegments,
  getMeeting, listMeetings, confirmMeeting, discardMeeting, pendingAudio,
  MEETING_STATUS,
} from '../meetings/store.js';
import { isInsideMeetingDir, currentAudioRoot } from '../meetings/audio-store.js';
import { enqueueSegment, onTranscription, sttStatus, requeuePending } from '../meetings/queue.js';
import { sttHealth } from '../meetings/stt.js';
import { runPass, pendingSpeechMs, PASS_TRIGGER_MS } from '../meetings/understanding.js';
import { listFindings, updateFinding, addFinding, deleteFinding, approvedSet } from '../meetings/findings.js';
import { meetingBrief, handoffToAgent } from '../meetings/handoff.js';
import {
  startProcess, stopProcess, supervisorStatus, processOutput,
  isManaged, isStopRequested, installExitCleanup, PROCESSES,
} from '../meetings/supervisor.js';

export const meetingsRouter = Router();

/* ------------------------------------------------------------------ *
 * Agent liveness
 * ------------------------------------------------------------------ */

/*
 * The capture agent's heartbeat is IN MEMORY and deliberately not a table.
 *
 * "Is the agent running right now" is an ephemeral fact with a lifetime of
 * seconds. Persisting it would mean a server restart reports an agent that
 * connected yesterday as present — a stale yes, which is worse than a no,
 * because the whole point of the capability endpoint is to tell the user
 * truthfully that nothing is listening.
 */
const AGENT_STALE_MS = 15_000;
let agentState = null;

meetingsRouter.post('/agent/heartbeat', (req, res) => {
  const b = req.body || {};
  const first = !agentState;
  agentState = {
    at: Date.now(),
    version: b.version || null,
    devices: b.devices || null,
    vad: b.vad || null,
    detecting: b.detecting !== false,
    activeMeeting: b.active_meeting || null,
    notes: b.notes || null,
  };
  if (first) log.info('meetings', `capture agent connected  v${agentState.version || '?'}  vad=${agentState.vad || '?'}`);
  /*
   * THE COOPERATIVE STOP CHANNEL (M6).
   *
   * There is no SIGTERM on Windows — Node's kill() is TerminateProcess, a hard
   * kill — so a stop implemented with signals would cut a recording off
   * mid-write while looking perfectly graceful in the code. The heartbeat is
   * already a five-second round trip the agent makes anyway, so the stop is
   * asked for HERE and the agent closes the meeting it is recording before it
   * exits.
   *
   * Only ever true for an agent this server actually spawned. One started by
   * hand in a terminal is nothing to do with us and is never told to stop.
   */
  res.json({
    ok: true,
    audioRoot: currentAudioRoot(),
    stop: isManaged('agent') && isStopRequested('agent'),
  });
});

/**
 * Mirrors /api/flows/live/capability: it answers "can this feature work right
 * now", and when it cannot it says what to run. The UI already knows how to
 * render that shape, so an absent agent reads as a setup step rather than as
 * a broken page.
 */
meetingsRouter.get('/capability', async (_req, res) => {
  const fresh = agentState && (Date.now() - agentState.at) < AGENT_STALE_MS;
  const pending = pendingAudio();
  const stt = await sttHealth();
  res.json({
    // Capture and transcription are separate capabilities and fail separately:
    // the agent can be recording perfectly while the sidecar is not running, in
    // which case audio is safe on disk and the transcript is merely late. One
    // combined boolean would hide which half is broken.
    ok: Boolean(fresh),
    stt: { ...stt, queue: sttStatus() },
    agent: fresh
      ? {
        version: agentState.version,
        devices: agentState.devices,
        vad: agentState.vad,
        detecting: agentState.detecting,
        activeMeeting: agentState.activeMeeting,
        lastSeenMs: Date.now() - agentState.at,
      }
      : null,
    lastSeenMs: agentState ? Date.now() - agentState.at : null,
    audioRoot: currentAudioRoot(),
    pendingAudio: pending,
    fixes: [
      ...(stt.ok ? [] : [
        'The transcription sidecar is not running - utterances will be captured but not transcribed.',
        'cd meeting-agent && .\.venv\Scripts\python.exe -m meeting_agent.stt_server',
      ]),
      ...(fresh ? [] : [
      'The NowHelpAssist capture agent is not running — nothing is listening for meetings.',
      'cd meeting-agent && python -m pip install -r requirements.txt',
      'python -m meeting_agent.diagnose      # confirm your devices and meeting detection first',
      'python -m meeting_agent               # start listening',
      ]),
    ],
  });
});

/* ------------------------------------------------------------------ *
 * M6 — starting and stopping the two Python processes from the UI
 *
 * Until now both were started by hand in a terminal, which meant meeting
 * capture only worked when someone remembered to do it and left the window
 * open. The supervisor spawns them; THIS file decides whether it may, because
 * the two facts that make it unsafe — is an agent already heartbeating, is the
 * sidecar already answering — live here and not there.
 * ------------------------------------------------------------------ */

installExitCleanup();

/**
 * A refusal the client can actually show.
 *
 * `api.js` throws `new Error(body.message)` and drops the rest of the body, so
 * a refusal whose reason lives only in `error` or `fixes` reaches the user as
 * "Request failed (409)" — which is exactly the unactionable message this app
 * keeps designing against. The fix lines are folded into `message` so the one
 * field the client reads carries the whole answer; `error` and `fixes` stay
 * beside it for anything reading the response directly.
 */
function refusal(error, fixes = []) {
  const lines = (fixes || []).filter(Boolean);
  return {
    ok: false,
    error,
    fixes: lines,
    message: [error, ...lines].join('\n'),
  };
}

const agentIsFresh = () => Boolean(agentState && (Date.now() - agentState.at) < AGENT_STALE_MS);

/**
 * Is something already running that we did NOT spawn?
 *
 * This is the check that matters most. An agent started in a terminal is
 * invisible to the supervisor, and starting a second one would put two
 * recorders on the same microphone, both opening meetings on this server —
 * duplicate meetings, interleaved utterances, and no error anywhere to say so.
 * The sidecar's failure is milder (the second cannot bind port 4600) but just
 * as opaque from a button.
 *
 * So an unmanaged live process BLOCKS the start, and says where it came from.
 */
async function foreignInstance(name) {
  if (isManaged(name)) return null;
  if (name === 'agent') {
    if (!agentIsFresh()) return null;
    return {
      what: 'A capture agent is already running and heartbeating, but this server did not start it.',
      why: 'Starting a second one would put two recorders on the same microphone and open duplicate meetings.',
      fix: 'Stop the one you started in a terminal (Ctrl-C there), then start it from here.',
    };
  }
  const health = await sttHealth();
  if (!health.ok) return null;
  return {
    what: 'The transcription sidecar is already answering, but this server did not start it.',
    why: 'A second one cannot bind the same port and would exit immediately.',
    fix: 'Stop the one you started in a terminal (Ctrl-C there), then start it from here.',
  };
}

/** Everything the floating control needs, in one poll. */
meetingsRouter.get('/processes', async (_req, res) => {
  const sup = supervisorStatus();
  const stt = await sttHealth();
  const fresh = agentIsFresh();
  res.json({
    ...sup,
    /*
     * MANAGED and LIVE are different questions and are answered separately.
     *
     * `managed` is "we spawned it and its pid is alive" — which a process that
     * crashed on an import error can satisfy for a moment, and which a process
     * someone started in a terminal never satisfies at all. `live` is the real
     * one: the agent heartbeats, the sidecar answers /health. Collapsing them
     * into one boolean is how a UI ends up showing green while nothing is
     * listening.
     */
    live: {
      agent: fresh,
      stt: stt.ok,
    },
    // Running, but not by us — so the UI offers neither start nor stop, and
    // says why rather than showing a dead button.
    foreign: {
      agent: fresh && !isManaged('agent'),
      stt: stt.ok && !isManaged('stt'),
    },
    activeMeeting: fresh ? agentState.activeMeeting : null,
  });
});

meetingsRouter.get('/processes/:name/output', (req, res) => {
  const { name } = req.params;
  if (!PROCESSES[name]) return res.status(404).json({ error: `Unknown process "${name}".` });
  res.json({ name, lines: processOutput(name) });
});

meetingsRouter.post('/processes/:name/start', async (req, res) => {
  const { name } = req.params;
  if (!PROCESSES[name]) return res.status(404).json({ error: `Unknown process "${name}".` });

  const foreign = await foreignInstance(name);
  if (foreign) {
    // 409, not 500: nothing is broken here, the request is simply refused.
    return res.status(409).json(refusal(foreign.what, [foreign.why, foreign.fix]));
  }

  const result = startProcess(name, { serverPort: req.socket.localPort });
  if (!result.ok) return res.status(400).json(refusal(result.error, result.fixes));
  res.json(result);
});

meetingsRouter.post('/processes/:name/stop', (req, res) => {
  const { name } = req.params;
  if (!PROCESSES[name]) return res.status(404).json({ error: `Unknown process "${name}".` });
  const result = stopProcess(name);
  if (!result.ok) return res.status(400).json(refusal(result.error));
  res.json(result);
});

/** The meter, on its own endpoint so the page can poll it cheaply. */
meetingsRouter.get('/stt/status', async (_req, res) => {
  res.json({ queue: sttStatus(), sidecar: await sttHealth() });
});

/* ------------------------------------------------------------------ *
 * Live updates (SSE) — same contract as every other stream in this app
 * ------------------------------------------------------------------ */

const subscribers = new Map(); // meetingId -> Set<res>

function broadcast(meetingId, event) {
  const set = subscribers.get(meetingId);
  if (!set) return;
  for (const res of set) {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
  }
}

/*
 * The queue finishes a transcript on its own schedule, long after the request
 * that enqueued it has been answered. This is how that result reaches whoever
 * is watching the meeting live.
 */
onTranscription((event) => {
  const id = event?.segment?.meeting;
  if (id) broadcast(id, event);
  else for (const key of subscribers.keys()) broadcast(key, event);
  if (id) considerUnderstanding(id);
});

/*
 * THE ROLLING TRIGGER.
 *
 * Understanding runs while the meeting is still going, so the findings are
 * already on screen when someone hangs up rather than starting then. It is
 * driven by transcripts landing rather than by a timer, because a timer would
 * fire during silence and read nothing.
 *
 * Serialised per meeting: the model call takes seconds and utterances keep
 * arriving underneath it, so without this a long pass would overlap the next
 * one and both would read the same window.
 */
const understanding = new Set();

async function considerUnderstanding(meetingId, { force = false } = {}) {
  if (understanding.has(meetingId)) return;
  if (!force && pendingSpeechMs(meetingId) < PASS_TRIGGER_MS) return;
  understanding.add(meetingId);
  try {
    const result = await runPass(meetingId, { force });
    if (result.added?.length || result.rejected) {
      broadcast(meetingId, { type: 'findings', ...result, findings: listFindings(meetingId) });
    }
  } catch (err) {
    log.error('meetings', `understanding failed for ${meetingId}: ${err.message}`);
    broadcast(meetingId, { type: 'understanding_error', message: err.message });
  } finally {
    understanding.delete(meetingId);
  }
}

meetingsRouter.get('/:id/stream', (req, res, next) => {
  const m = getMeeting(req.params.id);
  if (!m) return next(Object.assign(new Error('No such meeting.'), { status: 404 }));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const set = subscribers.get(m.id) || new Set();
  set.add(res);
  subscribers.set(m.id, set);

  res.write(`data: ${JSON.stringify({ type: 'hello', meeting: m, segments: listSegments(m.id) })}\n\n`);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);

  // A meeting that is already over will never emit again, so the stream is
  // terminated immediately rather than left open forever waiting on a
  // recording that finished before the page loaded.
  if (m.status !== MEETING_STATUS.RECORDING) {
    res.write(`data: ${JSON.stringify({ type: 'done', reason: 'meeting-not-recording', status: m.status })}\n\n`);
  }

  const close = () => {
    clearInterval(keepAlive);
    const s = subscribers.get(m.id);
    if (s) { s.delete(res); if (!s.size) subscribers.delete(m.id); }
  };
  req.on('close', close);
});

/* ------------------------------------------------------------------ *
 * Ingest — called by the capture agent, not the browser
 * ------------------------------------------------------------------ */

meetingsRouter.post('/', (req, res, next) => {
  try {
    const b = req.body || {};
    const started = startMeeting({
      title: b.title,
      sourceApp: b.source_app,
      sourcePid: Number(b.source_pid),
      detectedBy: b.detected_by || 'auto',
      agentVersion: b.agent_version,
      startedAt: b.started_at,
    });
    res.status(201).json(started);
  } catch (err) { next(err); }
});

meetingsRouter.post('/:id/segment', (req, res, next) => {
  try {
    const m = getMeeting(req.params.id);
    if (!m) return next(Object.assign(new Error('No such meeting.'), { status: 404 }));
    if (m.status === MEETING_STATUS.CONFIRMED || m.status === MEETING_STATUS.DISCARDED) {
      // Frozen means frozen. Accepting a late utterance into a confirmed
      // meeting would mutate a transcript that evidence already points at.
      return next(Object.assign(new Error(`This meeting is ${m.status} and no longer accepts utterances.`), { status: 409 }));
    }
    const body = req.body || {};
    if (body.audio_path && !isInsideMeetingDir(m.id, body.audio_path)) {
      return next(Object.assign(new Error(
        'audio_path must be inside this meeting\'s own audio directory. '
        + 'The server owns the layout and hands it to the agent on start.'
      ), { status: 400 }));
    }
    const seg = addSegment(m.id, body);
    // Transcription starts NOW, while the meeting is still going. That is the
    // whole point of phase 2: by the time someone hangs up the pipeline is one
    // utterance behind, not one meeting behind.
    enqueueSegment(seg);
    broadcast(m.id, { type: 'segment', segment: seg });
    res.status(201).json(seg);
  } catch (err) { next(err); }
});

meetingsRouter.post('/:id/end', (req, res, next) => {
  try {
    const m = endMeeting(req.params.id, { endedAt: req.body?.ended_at });
    if (!m) return next(Object.assign(new Error('No such meeting.'), { status: 404 }));
    broadcast(m.id, { type: 'done', reason: 'meeting-ended', meeting: m });
    res.json(m);
    /*
     * The final pass, forced so the last stretch of speech is read even though
     * it is under the rolling threshold. Deliberately AFTER the response: the
     * agent is waiting on this call to shut down, and it must not be held open
     * for a model round-trip. Any remaining utterances are still transcribing,
     * and each of those will trigger considerUnderstanding again as it lands.
     */
    setTimeout(() => considerUnderstanding(m.id, { force: true }), 1500);
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ *
 * Reads — called by the browser
 * ------------------------------------------------------------------ */

meetingsRouter.get('/', (req, res) => {
  res.json({ meetings: listMeetings({ limit: req.query.limit }), pendingAudio: pendingAudio() });
});

/* ------------------------------------------------------------------ *
 * Findings — what the meeting meant
 * ------------------------------------------------------------------ */

meetingsRouter.get('/:id/findings', (req, res, next) => {
  const m = getMeeting(req.params.id);
  if (!m) return next(Object.assign(new Error('No such meeting.'), { status: 404 }));
  res.json({
    findings: listFindings(m.id),
    approved: approvedSet(m.id),
    understanding: {
      state: m.understanding_state || 'idle',
      error: m.understanding_error || null,
      passes: m.passes || 0,
      throughMs: m.understood_through_ms || 0,
      pendingMs: pendingSpeechMs(m.id),
      triggerMs: PASS_TRIGGER_MS,
    },
  });
});

/** Read the transcript now, whatever the watermark says. */
meetingsRouter.post('/:id/understand', async (req, res, next) => {
  const m = getMeeting(req.params.id);
  if (!m) return next(Object.assign(new Error('No such meeting.'), { status: 404 }));
  try {
    const result = await runPass(m.id, { force: true });
    res.status(result.ok ? 200 : 422).json({ ...result, findings: listFindings(m.id) });
  } catch (err) { next(err); }
});

meetingsRouter.post('/:id/findings', (req, res, next) => {
  const m = getMeeting(req.params.id);
  if (!m) return next(Object.assign(new Error('No such meeting.'), { status: 404 }));
  try { res.status(201).json(addFinding(m.id, req.body || {})); }
  catch (err) { next(err); }
});

meetingsRouter.patch('/:id/findings/:fid', (req, res, next) => {
  const m = getMeeting(req.params.id);
  if (!m) return next(Object.assign(new Error('No such meeting.'), { status: 404 }));
  try {
    const out = updateFinding(m.id, req.params.fid, req.body || {});
    if (!out) return next(Object.assign(new Error('No such finding.'), { status: 404 }));
    res.json(out);
  } catch (err) { next(err); }
});

meetingsRouter.delete('/:id/findings/:fid', (req, res, next) => {
  const m = getMeeting(req.params.id);
  if (!m) return next(Object.assign(new Error('No such meeting.'), { status: 404 }));
  res.json(deleteFinding(m.id, req.params.fid));
});

/* ------------------------------------------------------------------ *
 * Handing off to the agent
 *
 * The Meetings page does not build anything. It produces a brief and opens an
 * agent chat, because the agent already has the approval gate, the tool
 * registry and — the part a plan screen can never have — the ability to be
 * argued with mid-build.
 * ------------------------------------------------------------------ */

/** The brief, without creating anything. The page previews it before handing over. */
meetingsRouter.get('/:id/brief', (req, res, next) => {
  try { res.json(meetingBrief(req.params.id)); }
  catch (err) { next(err); }
});

/**
 * Open (or reopen) the agent chat for this meeting.
 *
 * Creates the session and returns it with the brief. It does NOT send the
 * brief: it lands in the composer so it can be read and edited before any tool
 * runs, which is the last point at which a mis-transcribed requirement can be
 * caught for free.
 */
meetingsRouter.post('/:id/handoff', (req, res, next) => {
  try {
    const out = handoffToAgent(req.params.id);
    res.status(out.reused ? 200 : 201).json(out);
  } catch (err) { next(err); }
});

meetingsRouter.get('/:id', (req, res, next) => {
  const m = getMeeting(req.params.id);
  if (!m) return next(Object.assign(new Error('No such meeting.'), { status: 404 }));
  res.json({ ...m, segments: listSegments(m.id) });
});

/**
 * Play one utterance back.
 *
 * This is the whole acceptance test for phase 1: the only way to know the
 * capture is clean, the tracks are the right way round and the chunk boundaries
 * fall on silence is to LISTEN to them. A waveform would look fine either way.
 */
meetingsRouter.get('/:id/segment/:idx/audio', (req, res, next) => {
  const m = getMeeting(req.params.id);
  if (!m) return next(Object.assign(new Error('No such meeting.'), { status: 404 }));
  const seg = getSegment(m.id, req.params.idx);
  if (!seg) return next(Object.assign(new Error('No such utterance.'), { status: 404 }));
  if (!seg.audio_path) {
    return next(Object.assign(new Error(
      m.confirmed
        ? 'The audio for this meeting was deleted when you confirmed the transcript.'
        : 'This utterance has no audio on disk.'
    ), { status: 410 }));
  }
  if (!isInsideMeetingDir(m.id, seg.audio_path) || !fs.existsSync(seg.audio_path)) {
    return next(Object.assign(new Error('The audio file is no longer on disk.'), { status: 410 }));
  }
  res.type('audio/wav');
  res.sendFile(seg.audio_path);
});

/* ------------------------------------------------------------------ *
 * Retention
 * ------------------------------------------------------------------ */

/**
 * The user's confirmation, and the deletion it triggers.
 *
 * The response carries the deletion result whether or not it worked, and the
 * client renders both — a partial delete has to be visible, because the files
 * it left behind are voice recordings the user believes are gone.
 */
meetingsRouter.post('/:id/confirm', (req, res, next) => {
  try {
    const out = confirmMeeting(req.params.id);
    if (!out) return next(Object.assign(new Error('No such meeting.'), { status: 404 }));
    res.status(out.deletion.ok ? 200 : 207).json(out);
  } catch (err) { next(err); }
});

meetingsRouter.delete('/:id', (req, res, next) => {
  try {
    const out = discardMeeting(req.params.id);
    if (!out) return next(Object.assign(new Error('No such meeting.'), { status: 404 }));
    res.status(out.deletion.ok ? 200 : 207).json(out);
  } catch (err) { next(err); }
});
