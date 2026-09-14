/**
 * F13 — an HTTP failure leaves the same evidence an empty completion does.
 *
 *   node --test server/test/
 *
 * THE ASYMMETRY. F4 dumps and PERSISTS everything known about a request that
 * came back empty. A request that came back 500 got one line of stderr and
 * nothing durable — which is backwards, because the 500 is the failure that
 * actually killed a turn on 2026-08-24.
 *
 * The two questions a failed model call raises are the same either way: was
 * the request we sent degenerate, and does the upstream agree the fault was
 * its own? `roleSequence` answers the first. `upstreamRef` answers the second,
 * and is the field the live incident turned on — three DISTINCT refs across
 * three attempts is what proved the upstream was genuinely failing three times
 * rather than replaying one cached answer. It is also the only handle anyone
 * outside this process has on the failure.
 *
 * Same shape, same `tool_events` home, different name: a 500 and an empty 200
 * must stay countable apart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-http-dump-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { chat, upstreamRefFrom } = await import('../src/agent/providers/openaiCompat.js');
const { SERVER_ERROR_ATTEMPTS } = await import('../src/agent/providers/retry.js');
const { createSession, recordToolEvent, loadToolEvents } = await import('../src/memory/sessions.js');

const HISTORY = [
  { role: 'user', text: 'create the remaining shared variables' },
  { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'query_records', input: { table: 'item_option_new' } }] },
  { role: 'tool', results: [{ id: 'c1', name: 'query_records', output: '[]' }] },
];

const REF = '0f9a1c33-6b2e-4d51-9c77-2a4f8e10b3d5';

/** The wire shape of the live failure: a 5xx with the upstream's own ref id. */
function alwaysHttp(status, bodyFor = (n) => ({ error: { message: `Internal Server Error (ref: ${REF}-${n})` } })) {
  const state = { calls: 0 };
  globalThis.fetch = async (_url, init) => {
    if (JSON.parse(init.body).max_tokens === 1) return { ok: true, status: 200, json: async () => ({}) };
    state.calls += 1;
    return { ok: false, status, json: async () => bodyFor(state.calls) };
  };
  return state;
}

/**
 * F11 spaced the 5xx retries across ~49s, which is the point of it and far too
 * long to sit through here. The backoff calls the global `setTimeout`, so the
 * sleeps are fired immediately.
 */
async function withMockedClock(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (cb) => real(cb, 0);
  try { return await fn(); } finally { globalThis.setTimeout = real; }
}

/* ------------------------------------------------------------------ *
 * The ref, out of whatever it came wrapped in
 * ------------------------------------------------------------------ */

test('the upstream ref is read out of a message or a body', () => {
  assert.equal(upstreamRefFrom(`Internal Server Error (ref: ${REF})`), REF);
  assert.equal(upstreamRefFrom(`{"error":{"message":"boom (ref: ${REF})"}}`), REF);
  // Whatever the upstream chose to call it — asserting a uuid shape would drop
  // the ref on the day the format changes, which is the day it matters most.
  assert.equal(upstreamRefFrom('failed (ref: r7)'), 'r7');
  assert.equal(upstreamRefFrom('plain 500, no ref anywhere'), null);
  assert.equal(upstreamRefFrom(null), null);
});

/* ------------------------------------------------------------------ *
 * The adapter attaches it
 * ------------------------------------------------------------------ */

test('a 500 carries a guard dump with the status, the ref and the role sequence', async () => {
  const state = alwaysHttp(500);
  await withMockedClock(() => assert.rejects(
    () => chat({ provider: 'ollama', model: 'gpt-oss:120b-cloud', system: 'sys', history: HISTORY, tools: [] }),
    (err) => {
      assert.ok(err.guardDump, 'an HTTP failure is still stderr-only — F13 regressed');
      assert.equal(err.guardDump.status, 500);
      // The LAST attempt's ref, matching the message: that is the one worth
      // quoting, and the one the retry reported.
      assert.equal(err.guardDump.upstreamRef, `${REF}-${SERVER_ERROR_ATTEMPTS}`);
      assert.equal(err.guardDump.attempts, SERVER_ERROR_ATTEMPTS);
      // The field the live incident actually needed: it says at a glance
      // whether a user turn was in the request at all.
      assert.equal(err.guardDump.roleSequence, 'system>user>assistant>tool');
      assert.equal(err.guardDump.historyEntries, HISTORY.length);
      assert.ok(err.guardDump.estRequestTokens > 0);
      assert.ok(err.guardDump.body.includes(REF), 'the upstream body was not kept');
      // Named separately from F4 so the two failure modes stay countable apart.
      assert.equal(err.guard.name, 'f13_http_error');
      assert.equal(err.guard.status, 'http-500');
      return true;
    }
  ));
  assert.equal(state.calls, SERVER_ERROR_ATTEMPTS);
});

test('a 400 gets the dump too — it is the request that is wrong, and this says which', async () => {
  const state = alwaysHttp(400, () => ({ error: { message: 'invalid message content type: <nil>' } }));
  await assert.rejects(
    () => chat({ provider: 'ollama', system: 'sys', history: HISTORY, tools: [] }),
    (err) => {
      assert.equal(err.guardDump.status, 400);
      assert.equal(err.guardDump.attempts, 1, 'a 4xx is not retried, and must not claim it was');
      assert.equal(err.guardDump.upstreamRef, null, 'no ref was offered — say so rather than inventing one');
      assert.match(err.guardDump.roleSequence, /^system>user>/);
      assert.equal(err.guard.status, 'http-400');
      return true;
    }
  );
  assert.equal(state.calls, 1);
});

test('the captured body is bounded — a failure path is the worst place for a runaway write', async () => {
  alwaysHttp(503, () => ({ error: { message: 'boom' }, padding: 'p'.repeat(80_000) }));
  await withMockedClock(() => assert.rejects(
    () => chat({ provider: 'ollama', system: 'sys', history: HISTORY, tools: [] }),
    (err) => {
      assert.equal(typeof err.guardDump.body, 'string');
      assert.equal(err.guardDump.body.length, 16_384);
      return true;
    }
  ));
});

/* ------------------------------------------------------------------ *
 * It lands, under its own name
 * ------------------------------------------------------------------ */

test('the dump lands as an f13 guard row, distinct from an f4 one', async () => {
  const id = 'http-dump-lands';
  createSession({ id });
  alwaysHttp(500);

  let caught = null;
  await withMockedClock(() => chat({ provider: 'ollama', system: 'sys', history: HISTORY, tools: [] })
    .catch((err) => { caught = err; }));
  assert.ok(caught?.guardDump, 'nothing to persist — the adapter half regressed');

  // The write the orchestrator's chatTurn catch makes, verbatim.
  const guard = caught.guard || { name: 'f4_empty_completion', status: 'empty-completion' };
  recordToolEvent(id, {
    kind: 'guard',
    name: guard.name,
    payload: { iteration: 4, ...caught.guardDump },
    result: caught.message,
    resultStatus: guard.status,
    mutating: false,
    approval: null,
  });
  // And an F4 row beside it, to prove the two are told apart rather than
  // merged into one undifferentiated "the model call failed" bucket.
  recordToolEvent(id, {
    kind: 'guard',
    name: 'f4_empty_completion',
    payload: { roleSequence: 'system>user' },
    resultStatus: 'empty-completion',
    mutating: false,
    approval: null,
  });

  const guards = loadToolEvents(id).filter((e) => e.kind === 'guard');
  assert.equal(guards.length, 2);
  const http = guards.find((g) => g.name === 'f13_http_error');
  assert.ok(http, 'the HTTP failure was not recorded under its own name');
  assert.equal(http.result_status, 'http-500');
  assert.equal(http.mutating, false);
  // The payload survives the JSON round-trip through SQLite intact.
  assert.equal(http.payload.status, 500);
  assert.equal(http.payload.upstreamRef, `${REF}-${SERVER_ERROR_ATTEMPTS}`);
  assert.equal(http.payload.roleSequence, 'system>user>assistant>tool');
  assert.equal(http.payload.iteration, 4);
  assert.match(http.result, new RegExp(`after ${SERVER_ERROR_ATTEMPTS} attempts`));
  assert.ok(guards.some((g) => g.name === 'f4_empty_completion'));
});

test('the empty-completion path is untouched — it still names itself f4', async () => {
  // F13 shares F4's wiring; the regression it could cause is renaming F4's own
  // rows, so that is asserted directly.
  globalThis.fetch = async (_url, init) => {
    if (JSON.parse(init.body).max_tokens === 1) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) };
  };
  await assert.rejects(
    () => chat({ provider: 'ollama', system: 'sys', history: HISTORY, tools: [], maxTokens: 4096 }),
    (err) => {
      assert.ok(err.guardDump, 'F4 lost its dump');
      assert.equal(err.guardDump.finishReason, 'length');
      assert.equal(err.guardDump.maxTokens, 4096);
      // No `guard` on this error, so the orchestrator falls back to F4's name.
      assert.equal(err.guard, undefined);
      assert.equal(err.guardDump.status, undefined, 'an empty 200 has no HTTP failure to report');
      return true;
    }
  );
});

/* ────────────────────────────────────────────────────────────────────────
 * REGRESSION — the 401 advice has to fit the instance it is talking to.
 *
 * Measured live: connecting `techsnitchpvtltddemo2.service-now.com` (a real
 * corporate demo instance) produced a 401 whose advice was "the PDI is
 * hibernating — wake it at developer.servicenow.com". That instance is not a
 * PDI, does not hibernate, and does not exist on developer.servicenow.com, so
 * the one actionable line sent the reader somewhere useless and buried the
 * causes that do apply there.
 * ──────────────────────────────────────────────────────────────────────── */

test('a 401 on a NON-PDI host does not offer PDI hibernation advice', async () => {
  const { diagnoseFailure } = await import('../src/servicenow/client.js');
  const d = diagnoseFailure({
    status: 401, host: 'techsnitchpvtltddemo2.service-now.com',
    username: 'navin.chanchal', detail: 'Required to provide Auth information',
  });
  assert.equal(d.isPdi, false);
  assert.equal(/hibernat/i.test(d.message), false, 'a corporate instance was told to wake a PDI');
  assert.equal(/developer\.servicenow\.com/.test(d.message), false);
  // And it names the causes that actually apply to a real sub-prod instance.
  assert.match(d.message, /multi-factor/i);
  assert.match(d.message, /snc_platform_rest_api_access/);
  assert.match(d.message, /locked/i);
});

test('a 401 on a PDI host keeps the hibernation advice, which is right there', async () => {
  const { diagnoseFailure } = await import('../src/servicenow/client.js');
  const d = diagnoseFailure({
    status: 401, host: 'dev424910.service-now.com', username: 'admin', detail: 'x',
  });
  assert.equal(d.isPdi, true);
  assert.match(d.message, /hibernating/i);
  assert.match(d.message, /developer\.servicenow\.com/);
});

test('the 401 says the platform cannot distinguish these causes, rather than picking one', async () => {
  /*
   * A wrong password, an MFA-required user and a missing REST role all answer
   * 401 with the same body — verified against a live instance. Naming one as
   * "most likely" would be a guess presented as a diagnosis.
   */
  const { diagnoseFailure } = await import('../src/servicenow/client.js');
  const d = diagnoseFailure({ status: 401, host: 'x.service-now.com', username: 'u', detail: 'y' });
  assert.match(d.message, /answers all of these the same way, so none can be ruled out/);
  assert.match(d.message, /login\.do is the quickest way/);
});
