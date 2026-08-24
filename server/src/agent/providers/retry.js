import { log } from '../../logging.js';

/**
 * Bounded retry for the model call, and only for the model call.
 *
 * This exists because of a measurement, not a hunch. A session kept failing
 * with `Internal Server Error (ref: …)` from Ollama's cloud shim. Replaying the
 * captured request body showed something that looked at first like a size
 * limit — 111KB failed, 88KB passed — and the obvious "fix" would have been to
 * truncate history hard. Sending the SAME body six times showed what it
 * actually is:
 *
 *   the full failing request   111,412B   4/6 ok
 *   the same, without tools     88,094B   5/6 ok
 *   half the history            80,314B   6/6 ok
 *
 * Nothing is deterministic. The upstream is simply flaky, with failure
 * probability rising with request size, so an earlier bisect showing 24 tools
 * failing while 30 tools passed was noise being read as signal. Truncating the
 * agent's memory to work around that would have degraded it for no reason.
 *
 * What is safe to retry: this wraps the LLM request ONLY. It is a read, it
 * writes nothing to the instance, and tool execution sits outside it — a
 * mutation approved at the gate is never re-run by this.
 *
 * What is NOT retried: any 4xx other than 408/429. Those are our own malformed
 * request, and retrying one three times turns a clear bug into a slow one —
 * which is exactly how the `invalid message content type: <nil>` defect stayed
 * invisible for as long as it did.
 *
 * Every retry is logged at warn. A silent retry would hide an upstream getting
 * steadily worse behind a slightly slower app.
 */

export const RETRY_ATTEMPTS = 3;
const BASE_DELAY_MS = 600;

/**
 * A cold start is not a blip, and must not be waited on like one.
 *
 * `finish_reason: load` means the backend was loading the model and generated
 * nothing. For a 120b cloud model that takes far longer than the 600ms/1.8s a
 * 5xx deserves, so the generic backoff burned all three attempts inside ~2.4s
 * and reported failure while the model was still coming up — observed exactly
 * that way in a live session.
 *
 * D-7 changed how that wait is spent. Sleeping longer was guesswork about how
 * long a load takes; instead the caller now supplies a `beforeRetry` warm-up
 * that issues a one-token request and BLOCKS until the model is resident. The
 * wait is therefore the load itself rather than an estimate of it, and these
 * delays shrink to what they should always have been — a short settle before
 * the real call, not a stand-in for the load.
 */
export const COLD_START_DELAYS_MS = [1_000, 3_000, 6_000];
export const isColdStart = (err) => /finish reason: load/i.test(err?.message || '');

/**
 * F11 — a 5xx is an OUTAGE, and the generic curve was sized for a blip.
 *
 * Measured live 2026-08-24: three consecutive HTTP 500s from Ollama's cloud
 * shim, each carrying its own upstream `ref:` id — so three genuinely distinct
 * failures, not one cached answer replayed — exhausted the whole retry budget
 * in ~6.6s and killed the turn. 6.6s is not a serious attempt to outlast an
 * upstream having a bad minute; it is three pokes inside the same blip.
 *
 * So a 5xx gets its own budget and its own spacing: five attempts across
 * [2s, 5s, 12s, 30s], ~49s of waiting, which spans an upstream wobble rather
 * than sampling one instant of it four times over.
 *
 * Deliberately NOT extended to 408 or 429. A 408 already cost the caller the
 * full request timeout before it failed, and a 429 means the upstream has
 * asked for less traffic — answering either with a longer, more patient siege
 * is the wrong reply. Those keep the existing budget and curve.
 */
export const SERVER_ERROR_ATTEMPTS = 5;
export const SERVER_ERROR_DELAYS_MS = [2_000, 5_000, 12_000, 30_000];
const isServerError = (err) => err?.status >= 500 && err?.status < 600;

/** 408 timeout, 429 rate limit, and anything 5xx. Nothing else. */
export function isRetryableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/** Mark an error as worth another attempt. */
export function retryable(err, status) {
  err.retryable = true;
  if (status !== undefined) err.status = status;
  return err;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ±20%, so a fleet of turns retrying at once does not land in lockstep. */
const jitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));

/**
 * `beforeRetry(err, attempt)` runs after a retryable failure and before the
 * backoff sleep. It may throw nothing useful — a warm-up that fails is not a
 * reason to abandon the real retry, so its errors are swallowed and logged.
 */
export async function withRetry(label, fn, { attempts = RETRY_ATTEMPTS, beforeRetry = null } = {}) {
  let lastError;
  // The budget is not known up front any more: it depends on WHAT failed, and
  // that is only visible after the first failure (F11).
  let budget = attempts;
  let made = 0;
  for (let attempt = 1; attempt <= budget; attempt++) {
    made = attempt;
    try {
      const value = await fn(attempt);
      if (attempt > 1) log.warn('llm', `${label} succeeded on attempt ${attempt}/${budget}`);
      return value;
    } catch (err) {
      lastError = err;
      if (err.retryable && isServerError(err)) budget = Math.max(budget, SERVER_ERROR_ATTEMPTS);
      if (!err.retryable || attempt === budget) break;
      if (beforeRetry) {
        try {
          await beforeRetry(err, attempt);
        } catch (warmErr) {
          // The warm-up is an optimisation. Losing it costs a slower retry,
          // not a failed one, so it must never replace the error we are
          // actually reporting.
          log.warn('llm', `${label} warm-up before attempt ${attempt + 1} failed — retrying anyway`, warmErr.message);
        }
      }
      // Cold starts and 5xx outages each get their own schedule; everything
      // else stays exponential with jitter, so repeated turns do not land in
      // lockstep.
      const pick = (curve) => jitter(curve[Math.min(attempt - 1, curve.length - 1)]);
      const delay = isColdStart(err) ? COLD_START_DELAYS_MS[Math.min(attempt - 1, COLD_START_DELAYS_MS.length - 1)]
        : isServerError(err) ? pick(SERVER_ERROR_DELAYS_MS)
        : Math.round(BASE_DELAY_MS * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
      log.warn('llm', `${label} attempt ${attempt}/${budget} failed (${err.status || 'network'}) — retrying in ${delay}ms`, err.message);
      await sleep(delay);
    }
  }
  if (lastError?.retryable) {
    // Say how hard it tried, so "the model is down" is distinguishable from
    // "the request was wrong" without reading the log. The count is the one
    // actually made — a 5xx and a 429 no longer stop in the same place.
    lastError.message = `${lastError.message} (after ${made} attempts)`;
  }
  throw lastError;
}
