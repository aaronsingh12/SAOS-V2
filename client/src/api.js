import { logToServer } from './logging.js';

const BASE = '/api';

/**
 * Every call reports its outcome to the server terminal.
 *
 * Failures are logged with the status and the server's own message, so a
 * 400 the user only saw as a red box is greppable next to the request that
 * caused it. Bodies are NOT logged: this app posts a ServiceNow password
 * and an API key through here.
 */
async function request(method, path, body) {
  const start = Date.now();
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // The server is unreachable — the one failure the server cannot log.
    logToServer('error', `${method} ${path} — network failure: ${err.message}`);
    throw err;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const message = data?.message || `Request failed (${res.status})`;
    logToServer('error', `${method} ${path} → ${res.status}  ${message}`, data?.detail);
    throw new Error(message);
  }
  logToServer('debug', `${method} ${path} → ${res.status}  ${Date.now() - start}ms`);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  patch: (p, b) => request('PATCH', p, b),
  put: (p, b) => request('PUT', p, b),
  del: (p) => request('DELETE', p),
  upload: (p, file, { signal } = {}) => upload(p, file, signal),
};

/**
 * Upload one file as the raw request body (the server takes the name from the
 * query string, so no multipart encoding is needed on either side). Logged
 * like every other call — name and size only, never content.
 */
async function upload(path, file, signal) {
  const start = Date.now();
  let res;
  try {
    res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
      signal,
    });
  } catch (err) {
    if (err?.name !== 'AbortError') logToServer('error', `POST ${path} — network failure: ${err.message}`);
    throw err;
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const message = data?.message || `Upload failed (${res.status})`;
    logToServer('warn', `POST ${path} → ${res.status}  ${message}`);
    throw new Error(message);
  }
  logToServer('debug', `POST ${path} → ${res.status}  ${file.size}B  ${Date.now() - start}ms`);
  return data;
}

/**
 * Send a request and read Server-Sent Events off the response body.
 *
 * `method` exists because deleting a catalog UI policy is also a build and an
 * install — it removes the Fluent source and reinstalls the application — so it
 * streams progress exactly like the create does.
 *
 * A STREAM MUST END WITH `done` OR `error`, and this enforces it.
 *
 * That is an invariant of every SSE route in this app, not a convention: the
 * agent turn, the three catalog builds, both flow routes and the SLA verifier
 * all terminate with one or the other on every path, including their failure
 * paths. Nothing enforced it here, so a stream that simply STOPPED — the server
 * process dying mid-turn, which is what the `--watch` restart defect did — was
 * indistinguishable from one that finished. The caller's `await` resolved, its
 * `finally` cleared the spinner, and the user was left looking at a transcript
 * that had quietly stopped halfway with no error anywhere.
 *
 * A truncated stream now throws, so it lands in the same `catch` every other
 * failure already uses and renders as the same red bubble. No new UI, and one
 * fewer way for this app to fail silently.
 */
/**
 * Phase 0 — was this failure US, stopping on purpose?
 *
 * A cancelled fetch reaches the caller as an AbortError, and without this it
 * would be reported as a network failure or — worse — as the truncated-stream
 * defect below, telling a user who just pressed Stop that the connection was
 * lost and they should check the server terminal.
 */
const isAbortError = (err) => err?.name === 'AbortError';

function cancelledError() {
  const err = new Error('Stopped.');
  err.cancelled = true;
  return err;
}

/**
 * `signal` (Phase 0) aborts the request. The server sees the disconnect and
 * stops its turn at the next safe boundary — so the caller's `catch` runs while
 * the server is still winding down, and must not claim anything about what the
 * turn did or did not finish.
 */
export async function sse(path, body, onEvent, method = 'POST', { signal } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) throw cancelledError();
    throw err;
  }
  if (!res.ok || !res.body) {
    let msg = 'Stream failed';
    try { msg = (await res.json()).message || msg; } catch { /* keep default */ }
    logToServer('error', `${method} ${path} (stream) → ${res.status}  ${msg}`);
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  // Set by the `done`/`error`/`cancelled` frame. Its ABSENCE at end-of-stream
  // is the bug.
  let terminated = false;
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      // Aborting the fetch tears down the reader mid-read. That is not a lost
      // connection, it is the Stop button working.
      if (isAbortError(err) || signal?.aborted) throw cancelledError();
      throw err;
    }
    const { done, value } = chunk;
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          let evt = null;
          try { evt = JSON.parse(line.slice(6)); }
          catch (err) { logToServer('warn', `${path} sent an unparseable SSE frame: ${err.message}`); }
          if (evt) {
            // Phase 0 — `cancelled` is a third terminal state, not an error and
            // not a completion. A stream that ends on one has ended correctly,
            // so it must satisfy the invariant below exactly as the other two do.
            if (evt.type === 'done' || evt.type === 'error' || evt.type === 'cancelled') terminated = true;
            // The failure that started all this arrived here, was rendered as
            // a red box, and was never written down anywhere.
            if (evt.type === 'error') logToServer('error', `${path} stream error: ${evt.message}`, evt.detail);
            try { onEvent(evt); }
            catch (err) { logToServer('error', `handler for ${path} threw on a ${evt.type} event: ${err.message}`, err.stack); }
          }
        }
      }
    }
  }
  if (!terminated) {
    // Deliberately not a silent return and deliberately not a toast: the
    // caller's own error path already knows how to show this, and the terminal
    // needs the line more than the console does.
    const message =
      'The connection to the SAOS server ended before this finished, so it is unknown how far it got. '
      + 'Check the server terminal — if it is not running, start it with `npm run dev` in server/. '
      + 'Anything already written to the instance is on the Audit page.';
    logToServer('error', `${method} ${path} (stream) ended without a done/error frame — connection lost mid-stream`);
    throw new Error(message);
  }
}

/** ServiceNow display='all' fields come back as {value, display_value}. */
export const val = (r, f) => {
  const v = r?.[f];
  return v && typeof v === 'object' ? v.value : v;
};
export const disp = (r, f) => {
  const v = r?.[f];
  return v && typeof v === 'object' ? (v.display_value ?? v.value ?? '') : (v ?? '');
};
