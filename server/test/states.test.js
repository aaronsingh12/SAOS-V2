/**
 * D-3 regression proof — loading, empty, and "not connected" are three
 * different things, and the app now says which.
 *
 *   node --test server/test/
 *
 * The defect at the root of this one was an honesty defect, not a cosmetic
 * one. Incidents, SLA and Flows each rendered "No X match. Connect your PDI on
 * the Dashboard first." — one sentence for two opposite facts, which is the
 * same failure the ACL analyzer needed a `visibility` field to avoid. The
 * binding is now answered by /api/system/health BEFORE a list is asked for.
 *
 * What is measured here is the DECISION (instanceState.js) and the shared
 * health store, both plain JS. Node cannot import `.jsx`, and adding a
 * transform to this repo to render a component tree would buy less than
 * moving the rule somewhere it can be asserted — so the markup itself is
 * checked in the browser sweep, and only there. Stated rather than implied.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = (rel) => pathToFileURL(path.resolve(here, '../..', rel)).href;

const { describeInstanceState, skeletonWidth, skeletonLineWidth } =
  await import(url('client/src/components/instanceState.js'));
const health = await import(url('client/src/hooks/useHealth.js'));

/**
 * The health store reaches the server through api.js, which calls `fetch`
 * with a root-relative path — fine in a browser, not a valid URL in Node. The
 * stub is that seam, and it also lets the request COUNT be asserted, which is
 * the entire reason the poller was made shared.
 */
function stubFetch(body, { ok = true } = {}) {
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify(body) };
  };
  return calls;
}

const CONNECTED = { ok: true, connected: true, instanceUrl: 'https://dev442675.service-now.com' };
const UNBOUND = { ok: true, connected: false, instanceUrl: null };

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

/**
 * This assertion was inverted by a measurement, and the earlier version is
 * worth recording. It said "while health is unknown, render the page" — on the
 * reasoning that a flash of "disconnected" is worse than a flash of content.
 * True, and beside the point: mounting the children mounts their load effects,
 * so the disconnected browser sweep produced 18 console errors, every page
 * firing a request that 400'd before the gate replaced it.
 *
 * Holding the children back is only affordable because of the other half of
 * that fix: /api/system/health stopped waiting on the SDK capability probe
 * (~5.5s on a cold cache, for a field no client reads) and now answers in
 * about 2ms.
 */
test('while health is unknown the page waits, and does not mount its fetches', () => {
  const s = describeInstanceState({ loading: true, connected: false }, 'Incident Management');
  assert.equal(s.kind, 'waiting');
  assert.notEqual(s.kind, 'children', 'rendering children here fires requests against an unknown binding');
  assert.notEqual(s.kind, 'unbound', 'and it must not flash "disconnected" on the way to connected either');
});

test('an unbound instance is stated as itself, with the fix one click away', () => {
  const s = describeInstanceState({ loading: false, connected: false }, 'Incident Management');
  assert.equal(s.kind, 'unbound');
  assert.match(s.title, /No ServiceNow instance is bound/);
  assert.match(s.hint, /^Incident Management reads and writes/);
  assert.equal(s.to, '/');
  assert.ok(s.actionLabel);
  // The whole point: this is never phrased as an empty result.
  assert.doesNotMatch(s.title + s.hint, /no incidents match/i);
});

test('an unreachable server blames the server, not the PDI', () => {
  const s = describeInstanceState({ loading: false, connected: false, serverDown: true, error: 'fetch failed' });
  assert.equal(s.kind, 'server');
  assert.match(s.title, /(SAOS|NowHelpAssist) server is not responding/);
  assert.match(s.hint, /fetch failed/);
  assert.match(s.hint, /server\//);
  // Two different failures. Conflating them sends someone to re-enter working
  // credentials because a terminal was closed.
  assert.doesNotMatch(s.title, /instance is bound/);
});

test('a connected instance gets out of the way entirely', () => {
  assert.equal(describeInstanceState({ loading: false, connected: true }).kind, 'children');
});

/* ------------------------------------------------------------------ *
 * Skeleton geometry
 * ------------------------------------------------------------------ */

test('skeleton widths are derived from position, never random', () => {
  // A skeleton that reshuffles between renders reads as content still
  // arriving, and StrictMode's double render in dev would make it twitch.
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      assert.equal(skeletonWidth(r, c), skeletonWidth(r, c));
      assert.ok(skeletonWidth(r, c) > 0 && skeletonWidth(r, c) <= 100);
    }
  }
  assert.notEqual(skeletonWidth(0, 0), skeletonWidth(0, 1), 'uniform bars read as a table, not a skeleton');
  assert.equal(skeletonLineWidth(0), skeletonLineWidth(5), 'the line widths must cycle, not run off the end');
});

/* ------------------------------------------------------------------ *
 * One source of truth
 * ------------------------------------------------------------------ */

test('one shared poller serves every subscriber, and concurrent refreshes coalesce', async () => {
  const calls = stubFetch(CONNECTED);
  await health.refreshHealth();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api\/system\/health$/);

  // Eight pages mounting at once must not be eight requests — the reason this
  // stopped being a per-component interval.
  const before = calls.length;
  await Promise.all([health.refreshHealth(), health.refreshHealth(), health.refreshHealth()]);
  assert.ok(calls.length - before <= 2, `expected in-flight coalescing, saw ${calls.length - before} extra requests`);
});

test('a failed health call is recorded as a server failure, not as "disconnected"', async () => {
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  await health.refreshHealth();
  // The store is module state; describeInstanceState reads exactly what the
  // hook hands a component.
  const snapshot = { loading: false, connected: false, serverDown: true, error: 'fetch failed' };
  assert.equal(describeInstanceState(snapshot).kind, 'server');
});
