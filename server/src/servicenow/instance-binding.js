import { getSettings, _setBindingHook } from '../config/store.js';
import { log } from '../logging.js';

/**
 * THE SINGLE SOURCE OF TRUTH FOR WHICH INSTANCE NOWHELPASSIST IS BOUND TO.
 *
 * The bound instance is whatever the UI currently specifies. Nothing else in
 * this project may hold an instance address — not a constant, not a static
 * config file, not a standing SDK credential alias. Change the connection in
 * the UI and the whole application, both tiers and all per-instance state,
 * follows with no code change.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 *
 * NowHelpAssist binds to "the instance" twice: the Table API reads
 * `settings.json`, and the SDK CLI bound through a stored credential alias.
 * The PDI was swapped and only the first moved. The result was not an error —
 * it was a DBA authoring run that BUILT and INSTALLED successfully on
 * dev442675 while the read-back checked dev428633 and correctly reported
 * nothing there. Neither tier could detect it alone.
 *
 * Repointing the alias would have fixed that day and rebuilt the same trap for
 * the next swap. The fix is that the SDK tier no longer has a binding of its
 * own: it is DERIVED, per invocation, from the same UI config the REST tier
 * reads.
 *
 * ── THE MECHANISM, MEASURED 2026-08-31 ───────────────────────────────────────
 *
 * The SDK's CI environment variables override the stored alias completely.
 * Proven with a discriminator — a table that exists on the alias host and not
 * on the UI host — run twice, same command:
 *
 *   alias path (no env):  "Attempting to log into instance https://dev442675…"
 *                         Retrieved 1 record(s)
 *   CI env path:          "Running in CI mode, using instance https://dev428633…"
 *                         Retrieved 0 record(s)
 *
 * That second line is also the backstop: the CLI ECHOES the instance it
 * actually used, so the guard can compare what the SDK really targeted against
 * what the UI specified, rather than trusting that the env vars were applied.
 */

/** Normalise a URL to the key every piece of per-instance state is filed under. */
export function instanceKeyFrom(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The currently bound instance, read fresh from the UI-owned config every time.
 *
 * Deliberately not cached: a stale binding is the entire failure this module
 * exists to prevent, and `getSettings()` is already a memory read.
 */
export function boundInstance() {
  const c = getSettings().connection || {};
  const url = (c.instanceUrl || '').replace(/\/+$/, '');
  const key = instanceKeyFrom(url);
  return {
    configured: Boolean(url && c.username),
    url: url || null,
    host: key,
    key,
    username: c.username || null,
    authType: c.authType || 'basic',
  };
}

/**
 * The environment that binds a `now-sdk` invocation to the UI-specified
 * instance, derived at call time.
 *
 * Returns `null` when nothing is bound, so a caller fails closed rather than
 * silently falling through to whatever credential store happens to exist.
 */
export function sdkAuthEnv() {
  const c = getSettings().connection || {};
  const url = (c.instanceUrl || '').replace(/\/+$/, '');
  if (!url || !c.username) return null;

  if (c.authType === 'oauth' && c.clientId && c.clientSecret) {
    return {
      SN_SDK_NODE_ENV: 'SN_SDK_CI_INSTALL',
      SN_SDK_AUTH_TYPE: 'oauth',
      SN_SDK_INSTANCE_URL: url,
      SN_SDK_USER: c.username,
      SN_SDK_USER_PWD: c.password || '',
      SN_SDK_OAUTH_CLIENT_ID: c.clientId,
      SN_SDK_OAUTH_CLIENT_SECRET: c.clientSecret,
    };
  }
  if (!c.password) return null;
  return {
    SN_SDK_NODE_ENV: 'SN_SDK_CI_INSTALL',
    SN_SDK_AUTH_TYPE: 'basic',
    SN_SDK_INSTANCE_URL: url,
    SN_SDK_USER: c.username,
    SN_SDK_USER_PWD: c.password,
  };
}

/**
 * The instance the SDK says it used, parsed from its own output.
 *
 * Both shapes are emitted, and either proves the target:
 *   "[now-sdk] Running in CI mode, using instance https://devXXXXXX.service-now.com"
 *   "[now-sdk] Attempting to log into instance https://devXXXXXX.service-now.com as admin."
 *
 * Returns null when the output names no instance — which a caller must treat as
 * "unknown", never as "agrees".
 */
export function parseSdkInstanceEcho(output) {
  const text = String(output || '');
  const m = /(?:using instance|log into instance)\s+(https?:\/\/\S+?)(?:\s|,|\.$|$)/i.exec(text);
  return m ? instanceKeyFrom(m[1]) : null;
}

/* ── per-instance state: flush on switch ──────────────────────────────────── */

/**
 * Everything that caches or files something per instance registers here.
 *
 * A schema cache built against instance A, consulted after a switch to B, is a
 * confidently wrong answer of exactly the kind this project exists to prevent:
 * every field it reports is real, and none of it is about the instance the user
 * is looking at.
 */
const flushers = new Map();

export function registerInstanceScopedCache(name, flush) {
  flushers.set(name, flush);
}

export function flushInstanceScopedState(reason = 'instance switch') {
  const flushed = [];
  const failed = [];
  for (const [name, flush] of flushers) {
    try { flush(); flushed.push(name); } catch (err) { failed.push({ name, error: err.message }); }
  }
  log.info('binding', `flushed per-instance state (${reason}): ${flushed.join(', ') || 'nothing registered'}`);
  if (failed.length) log.error('binding', `some per-instance state did NOT flush: ${failed.map((f) => f.name).join(', ')}`, failed);
  return { flushed, failed };
}

/* ── the switch handler ───────────────────────────────────────────────────── */

const listeners = new Set();

export function onInstanceChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let lastKey = null;

/**
 * Called after the UI config is written. Idempotent: a save that does not
 * change the instance flushes nothing, so editing an unrelated setting does
 * not throw away a warm schema cache.
 */
export function notifyBindingSaved() {
  const { key } = boundInstance();
  if (key === lastKey) return { changed: false, instance: key };
  const previous = lastKey;
  lastKey = key;
  const flush = flushInstanceScopedState(`bound instance ${previous || '(none)'} -> ${key || '(none)'}`);
  for (const fn of listeners) {
    try { fn({ previous, current: key }); } catch (err) { log.error('binding', `an instance-change listener threw: ${err.message}`); }
  }
  return { changed: true, previous, instance: key, ...flush };
}

/** Test seam, and the boot path: adopt the current binding without flushing. */
export function primeBinding() {
  lastKey = boundInstance().key;
  return lastKey;
}

/*
 * Wire the hook the moment this module is loaded.
 *
 * `config/store.js` owns the write and calls back; this module owns what a
 * switch MEANS. Registering here rather than at a call site means there is no
 * path that saves a connection without the flush happening — including the
 * Settings route, a test, or anything added later.
 */
_setBindingHook(() => notifyBindingSaved());
primeBinding();
