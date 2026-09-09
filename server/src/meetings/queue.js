import { getDb } from '../memory/db.js';
import { log } from '../logging.js';
import { transcribeFile, SttError } from './stt.js';

/**
 * THE LIVE TRANSCRIPTION QUEUE.
 *
 * One worker, one utterance at a time. Concurrency is deliberately 1: the work
 * is CPU-bound on a machine with no GPU, so two parallel transcriptions finish
 * no sooner together and make every latency number unpredictable — while also
 * competing with the meeting software the user is actually in.
 *
 * The queue lives here rather than in the sidecar because backpressure policy
 * is a product decision, not an STT detail. What to do when we fall behind —
 * degrade the model, and say so out loud — is exactly the kind of choice that
 * has to be visible in the app rather than buried in a Python service.
 *
 * MEASURED on this machine (8 cores, no GPU, base.en int8):
 *   real captured utterance, 3.04s audio -> 0.78s wall
 *   real captured utterance, 3.65s audio -> 0.69s wall
 * The cost is close to FIXED per call (Whisper pads to a 30s window), so the
 * backlog is tracked in utterance COUNT as well as audio seconds — twenty
 * two-second utterances cost far more than two twenty-second ones.
 */

/** Live pass. Chosen by measurement: see meeting_agent/stt_server.py. */
export const LIVE_MODEL = 'base.en';
/** Where the auto-downgrade goes. Faster, and measurably worse on domain words. */
export const FALLBACK_MODEL = 'tiny.en';

/**
 * Backlog past which the live pass is downgraded.
 *
 * 30 seconds of unprocessed speech is the point at which the transcript stops
 * being "live" in any useful sense — the conversation has moved on, and a
 * transcript that keeps falling further behind never recovers on its own.
 */
export const DOWNGRADE_BACKLOG_MS = 30_000;
/** Hysteresis, so a single slow utterance does not flap the model back and forth. */
export const RESTORE_AFTER_MS = 60_000;

const MAX_ATTEMPTS = 2;

const state = {
  queue: [],
  running: false,
  model: LIVE_MODEL,
  downgradedAt: null,
  completed: 0,
  failed: 0,
  audioMs: 0,
  wallMs: 0,
  lastError: null,
  listeners: new Set(),
};

/** Routes subscribe so a finished transcript reaches the open SSE streams. */
export function onTranscription(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

function emit(event) {
  for (const fn of state.listeners) {
    try { fn(event); } catch { /* a listener must not kill the worker */ }
  }
}

/* ------------------------------------------------------------------ *
 * The meter
 * ------------------------------------------------------------------ */

export function sttStatus() {
  const backlogMs = state.queue.reduce((a, j) => a + j.durationMs, 0);
  return {
    model: state.model,
    liveModel: LIVE_MODEL,
    downgraded: state.model !== LIVE_MODEL,
    downgradedAt: state.downgradedAt,
    queued: state.queue.length,
    backlogMs,
    running: state.running,
    completed: state.completed,
    failed: state.failed,
    // What this machine has ACTUALLY achieved, not what a model is rated at.
    // Below 1.0 means transcription is slower than the speech arriving, which
    // is the number that decides whether any of this works on a given laptop.
    measuredRtf: state.wallMs > 0 ? Number((state.audioMs / state.wallMs).toFixed(2)) : null,
    lastError: state.lastError,
  };
}

/* ------------------------------------------------------------------ *
 * Enqueue
 * ------------------------------------------------------------------ */

export function enqueueSegment(seg) {
  if (!seg?.audio_path) return false;
  if (seg.stt_state && seg.stt_state !== 'pending') return false;
  if (state.queue.some((j) => j.meeting === seg.meeting && j.idx === seg.idx)) return false;
  state.queue.push({
    meeting: seg.meeting,
    idx: seg.idx,
    path: seg.audio_path,
    durationMs: Math.max(0, (seg.end_ms || 0) - (seg.start_ms || 0)),
  });
  pump();
  return true;
}

/**
 * Re-queue everything still owed.
 *
 * Called on boot. The queue is in memory, so a server restart mid-meeting would
 * otherwise leave every pending utterance permanently untranscribed while its
 * audio sat on disk — a hole in the transcript that nothing would ever fill and
 * nothing would report.
 */
export function requeuePending({ limit = 500 } = {}) {
  const rows = getDb().prepare(
    `SELECT meeting, idx, audio_path, start_ms, end_ms, stt_state
       FROM meeting_segments
      WHERE stt_state = 'pending' AND audio_path IS NOT NULL
      ORDER BY start_ms ASC LIMIT ?`
  ).all(limit);
  let n = 0;
  for (const r of rows) if (enqueueSegment(r)) n += 1;
  if (n) log.info('meetings', `re-queued ${n} utterance(s) that were still awaiting transcription`);
  return n;
}

/* ------------------------------------------------------------------ *
 * The worker
 * ------------------------------------------------------------------ */

function considerModel() {
  const backlogMs = state.queue.reduce((a, j) => a + j.durationMs, 0);

  if (state.model === LIVE_MODEL && backlogMs > DOWNGRADE_BACKLOG_MS) {
    state.model = FALLBACK_MODEL;
    state.downgradedAt = Date.now();
    // LOUD. A silently degraded transcript is a worse transcript that nobody
    // knows is worse, and this is the exact moment the user needs to be told.
    log.warn('meetings',
      `transcription is ${Math.round(backlogMs / 1000)}s behind — switching the live model from `
      + `${LIVE_MODEL} to ${FALLBACK_MODEL} to catch up. ${FALLBACK_MODEL} is faster and measurably `
      + `worse on domain words (it wrote "Full filament" for "fulfilment" on the benchmark). `
      + `It will switch back once the backlog clears.`);
    emit({ type: 'stt_model', ...sttStatus() });
    return;
  }

  if (state.model !== LIVE_MODEL
      && backlogMs === 0
      && state.downgradedAt
      && Date.now() - state.downgradedAt > RESTORE_AFTER_MS) {
    state.model = LIVE_MODEL;
    state.downgradedAt = null;
    log.info('meetings', `transcription caught up — restoring the live model to ${LIVE_MODEL}`);
    emit({ type: 'stt_model', ...sttStatus() });
  }
}

function finish(job, patch) {
  getDb().prepare(
    `UPDATE meeting_segments
        SET text = ?, text_model = ?, stt_state = ?, stt_error = ?, stt_ms = ?,
            stt_attempts = stt_attempts + 1
      WHERE meeting = ? AND idx = ?`
  ).run(
    patch.text ?? null, patch.model ?? null, patch.sttState,
    patch.error ?? null, patch.ms ?? null, job.meeting, job.idx,
  );
  const row = getDb().prepare('SELECT * FROM meeting_segments WHERE meeting = ? AND idx = ?')
    .get(job.meeting, job.idx);
  emit({ type: 'segment_text', segment: row, stt: sttStatus() });
}

async function pump() {
  if (state.running) return;
  state.running = true;
  try {
    while (state.queue.length) {
      considerModel();
      const job = state.queue.shift();
      const t0 = Date.now();
      try {
        const out = await transcribeFile({ path: job.path, model: state.model });
        const wall = Date.now() - t0;
        state.audioMs += job.durationMs;
        state.wallMs += wall;
        state.completed += 1;
        // A discarded transcript is not the same as silence, and the page must
        // be able to say which. The sidecar's reason is carried through rather
        // than collapsed into a blank cell.
        /*
         * LOW CONFIDENCE IS NOT THE SAME AS SILENCE.
         *
         * The first version threw away every transcript that failed Whisper's
         * confidence checks. That kept fabrications out, but it also meant a
         * real sentence spoken over wind, breath or a third person talking
         * vanished completely — the reported symptom was "the conversation
         * goes nil", and the data agreed: 60 of 118 captured utterances
         * produced nothing at all.
         *
         * The thresholds cannot be loosened to fix that. Measured on real
         * audio, genuine speech reaches avg_logprob -0.63 while fabricated
         * text reaches -0.75, so no threshold separates them cleanly.
         *
         * So the text is KEPT and marked `low` instead:
         *   - it is shown in the transcript, flagged, so nothing silently
         *     disappears and a person can read what was probably said;
         *   - it can never be CITED as evidence (evidence.js requires 'done'),
         *     so a fabrication still cannot anchor a requirement.
         *
         * The safety property is unchanged; only the silence is gone.
         */
        const doubt = out.rejected || (out.hallucinated ? 'silence hallucination' : null)
          || (out.degenerate ? 'decoder loop' : null);
        // A decoder loop is not "probably right" — it is noise shaped like
        // words, and the sidecar already blanked it. Nothing to show.
        const worthShowing = out.text || (doubt && !out.degenerate ? out.rawText : '');
        finish(job, {
          text: worthShowing || '',
          error: doubt ? `low confidence: ${doubt}` : null,
          model: out.model || state.model,
          // done  — transcribed and trusted
          // low   — transcribed, shown, but NOT citable as evidence
          // empty — the model genuinely found no words
          sttState: doubt && worthShowing ? 'low' : (out.text ? 'done' : 'empty'),
          ms: wall,
        });
      } catch (err) {
        const wall = Date.now() - t0;
        state.wallMs += wall;
        const attempts = getDb()
          .prepare('SELECT stt_attempts AS n FROM meeting_segments WHERE meeting = ? AND idx = ?')
          .get(job.meeting, job.idx)?.n ?? 0;
        const retryable = err instanceof SttError && attempts + 1 < MAX_ATTEMPTS;
        state.lastError = err.message;
        if (retryable) {
          // One retry, at the BACK of the queue: a sidecar that has just been
          // started is the common case, and retrying immediately would burn
          // the attempt before it finished loading its model.
          getDb().prepare('UPDATE meeting_segments SET stt_attempts = stt_attempts + 1 WHERE meeting = ? AND idx = ?')
            .run(job.meeting, job.idx);
          state.queue.push(job);
          log.warn('meetings', `utterance ${job.idx} could not be transcribed (${err.message}); will retry once`);
          // Nothing is gained by hammering an absent sidecar.
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          state.failed += 1;
          log.error('meetings', `utterance ${job.idx} FAILED transcription: ${err.message}`);
          finish(job, { text: null, model: null, sttState: 'failed', error: err.message, ms: wall });
        }
      }
    }
  } finally {
    state.running = false;
    considerModel();
  }
}

/** Test seam — the suite drives the worker without a sidecar or a timer. */
export function _resetQueueForTests() {
  state.queue = [];
  state.running = false;
  state.model = LIVE_MODEL;
  state.downgradedAt = null;
  state.completed = 0;
  state.failed = 0;
  state.audioMs = 0;
  state.wallMs = 0;
  state.lastError = null;
  state.listeners.clear();
}

/** Awaits an idle queue. Only the tests need this; the app is event-driven. */
export async function _drainForTests() {
  while (state.running || state.queue.length) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 10));
  }
}
