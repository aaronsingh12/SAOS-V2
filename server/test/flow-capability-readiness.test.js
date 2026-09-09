import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { AUTH_READY } from '../src/servicenow/fluent.js';

/*
 * The readiness ladder, and the defect it is named after.
 *
 * LIVE 2026-09-02. `flow_authoring_capability` with `deep: true` reported
 * `ok: false` while every sub-check passed — CLI 4.10.1 present, auth verified
 * 'live', a workspace with 25 sources, `lastInstall.ok: true` from three hours
 * earlier — and with an EMPTY `fixes` array. The agent obeyed its operating
 * rule ("Business Rule fallback ONLY when the capability check reports
 * ok:false"), announced that native Flow Designer was unavailable, and offered
 * to hand-write a business rule instead of the flow and subflow that had been
 * working all day.
 *
 * The cause was one equality. Readiness read `auth.verified === 'derived'`,
 * and the deep probe UPGRADES 'derived' to 'live' when it proves the
 * credentials against the instance. So proving the credentials work is what
 * made the report say authoring was unavailable — and nothing pushed a fix,
 * because nothing had actually failed.
 *
 * These tests are cheap and offline on purpose. `capability()` shells out to
 * the SDK and reaches the instance; what broke was a pure predicate, and a
 * predicate is what is pinned here.
 */

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const fluentSource = fs.readFileSync(path.join(SRC, 'servicenow', 'fluent.js'), 'utf8');

/* ── the ladder ───────────────────────────────────────────────────────────── */

test('a PROVEN credential counts as ready — the regression itself', () => {
  // 'live' is 'derived' plus evidence. If the weaker state is ready, the
  // stronger one cannot be less so.
  assert.equal(AUTH_READY.has('live'), true,
    'a credential proven against the instance must not report flow authoring as unavailable');
});

test('a merely derived credential is ready — the shallow path still works', () => {
  assert.equal(AUTH_READY.has('derived'), true);
});

test('unproven and rejected states are NOT ready', () => {
  // 'unknown' = no credentials were derived at all.
  // 'failed'  = the instance rejected them, which is a real refusal.
  assert.equal(AUTH_READY.has('unknown'), false);
  assert.equal(AUTH_READY.has('failed'), false);
});

test('readiness covers exactly the two evidenced states', () => {
  // Pinned as a set rather than by membership: a fifth state added to the
  // ladder without a decision about its readiness fails here rather than
  // silently defaulting to not-ready and disabling flow authoring.
  assert.deepEqual([...AUTH_READY].sort(), ['derived', 'live']);
});

/* ── the shape of the bug, so it cannot come back in another spelling ─────── */

test('readiness is not decided by an equality against a single auth state', () => {
  // The literal defect: `auth.verified === 'derived'` inside the ok expression.
  // Any equality test against one rung of a four-rung ladder is the same bug
  // wearing a different value.
  const okLine = fluentSource.split('\n').find((l) => /^\s*ok:\s*Boolean\(/.test(l));
  assert.ok(okLine, 'the capability readiness expression must still be findable');
  assert.doesNotMatch(okLine, /auth\.verified\s*===/,
    'readiness must consult AUTH_READY, not compare against one state — see the 2026-09-02 defect');
  assert.match(okLine, /AUTH_READY\.has\(auth\.verified\)/);
});

test('the deep probe still only upgrades a freshly DERIVED credential', () => {
  // The gate at the probe is a different question from readiness and must stay
  // an equality: re-probing an already-'live' or 'failed' state would be a
  // second round trip with nothing to learn.
  assert.match(fluentSource, /if \(deep && auth\.verified === 'derived'\)/,
    'the probe gate is deliberately narrow and must not be widened to AUTH_READY');
});

/* ── the invariant that would have caught it ──────────────────────────────── */

test('an unexplained refusal is detected and reported rather than shipped silently', () => {
  /*
   * Every not-ready path in capability() pushes a fix. So `ok:false` with an
   * empty `fixes` is a state the function has no legitimate way to produce —
   * it means readiness was decided by something that never explained itself.
   *
   * It matters because of what the agent is told to do with it: fall back to a
   * business rule, and quote fixes[] when explaining why. An empty fixes is an
   * instruction to abandon flow authoring with nothing to say about it, which
   * is precisely what the user saw.
   */
  assert.match(fluentSource, /if \(!value\.ok && fixes\.length === 0\)/,
    'capability() must detect a refusal it cannot justify');
  // Loud, and shipped to the caller — a log line alone would have been invisible
  // to the agent, which only ever sees the JSON.
  assert.match(fluentSource, /capability reported ok:false with NO fixes/);
  assert.match(fluentSource, /Do NOT fall back to a Business Rule/,
    'the contradiction must tell the agent not to act on it');
});

test('the logger this file calls is actually imported', () => {
  // `log.error` was already called on two paths here with nothing importing it:
  // a latent ReferenceError that could only fire once something else had
  // already gone wrong, making the reporter the second failure.
  assert.match(fluentSource, /import \{ log \} from '\.\.\/logging\.js'/);
  // Both call sites named rather than counted: a count passes for the wrong
  // reason the moment someone adds a third log line elsewhere.
  assert.match(fluentSource, /log\.error\('fluent',\s*\n?\s*`capability reported ok:false/,
    'the unexplained-refusal report must still log');
  assert.match(fluentSource, /log\.error\('fluent', `a post-install hook threw/,
    'the pre-existing call this import was missing for must still be covered');
});
