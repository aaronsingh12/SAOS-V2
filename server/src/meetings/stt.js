import { log } from '../logging.js';

/**
 * THE STT SEAM.
 *
 * Everything that knows how speech becomes text lives behind these two
 * functions. The sidecar is local Whisper today; swapping it for a hosted API
 * is a change to this file and nothing else — not the capture agent, not the
 * queue, not the database, not the page. That is the document's "make the STT
 * service replaceable" requirement expressed as a module boundary rather than
 * as an intention.
 *
 * Audio is passed BY PATH. Both processes are on this machine, so shipping
 * bytes over HTTP would cost a copy and a base64 inflation for nothing. A
 * remote backend would be the one case where that changes, and it is the one
 * case this file would be rewritten for anyway.
 */

const BASE = (process.env.NHA_STT_URL || 'http://127.0.0.1:4600').replace(/\/+$/, '');

/**
 * A transcription may take a while — a cold model load is ~22s on this
 * machine, and a pathological clip used to take 11s before the prompt gate.
 * The bound exists so a wedged sidecar fails a job instead of stalling the
 * queue forever; it is not a latency budget.
 */
const CALL_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 3_000;

export class SttError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'SttError';
    this.detail = detail || null;
  }
}

/** Is the sidecar there, and what has it actually achieved on this hardware? */
export async function sttHealth() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!r.ok) return { ok: false, reason: `the STT sidecar answered ${r.status}`, url: BASE };
    const body = await r.json();
    return { ...body, ok: true, url: BASE };
  } catch (err) {
    return {
      ok: false,
      url: BASE,
      reason: err?.name === 'TimeoutError'
        ? `the STT sidecar at ${BASE} did not answer within ${HEALTH_TIMEOUT_MS}ms`
        : `the STT sidecar at ${BASE} is not running (${err.message})`,
    };
  }
}

/**
 * Transcribe one utterance.
 *
 * Returns the sidecar's whole report rather than just the text, because the
 * parts around the text are what the meter, the auto-downgrade and the honesty
 * of the page are all built on: how long it took, which model produced it,
 * whether the vocabulary prompt was applied, and whether the output was a
 * decoder loop that had to be discarded.
 */
export async function transcribeFile({ path, model, prompt, beamSize } = {}) {
  if (!path) throw new SttError('a path is required');
  let res;
  try {
    res = await fetch(`${BASE}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, model, prompt, beam_size: beamSize }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SttError(
      err?.name === 'TimeoutError'
        ? `transcription timed out after ${CALL_TIMEOUT_MS}ms`
        : `the STT sidecar is unreachable (${err.message}). Start it with: python -m meeting_agent.stt_server`,
      { url: BASE },
    );
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new SttError(body?.error || `the STT sidecar answered ${res.status}`, body);

  if (body?.degenerate) {
    // Not an error — a measured Whisper failure mode. The text was a single
    // token repeated ('. . . . .'), which reads as content next to real
    // transcript, so the sidecar blanked it and said so. Worth a line, because
    // a run of these means something is wrong with the audio.
    log.warn('meetings', `a decoder loop was discarded for ${path} — the model repeated one token`);
  }
  return body;
}
