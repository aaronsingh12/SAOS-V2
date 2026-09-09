/**
 * SESSION 1 / WI-3 — NO UNKNOWN WINDOW ON A WARM SERVER.
 *
 *   node --test server/test/
 *
 * THE DEFECT, measured 2026-09-08. `cachedCapability()` returned null the
 * moment its 30-second TTL expired, even though it still held the last probe
 * result, and it kept returning null for the ~8 seconds the refresh took.
 * Discovery reads that null as `unknown`, `unknown` is never available, so
 * `flow_authoring` (and every other SDK capability) vanished from the planner
 * prompt on every refresh — and the planner, offered only REST, planned a
 * `create_record` against a flow table.
 *
 * THE RULE THIS PINS. Staleness is not ignorance. A value the probe already
 * established is served while the next probe runs; it is downgraded to
 * UNKNOWN only when a probe actually FAILS, never because the clock moved. A
 * cold process still starts UNKNOWN until its first probe — but that probe is
 * kicked at boot and on an instance switch, not lazily by the first request
 * that happens to need it.
 *
 * Offline: the probe is injected, and the clock is driven through the cache's
 * own timestamp rather than by waiting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-s1cap-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const F = await import('../src/servicenow/fluent.js');
const { cachedCapability, primeCapability, CAP_TTL_MS, _setCapabilityProbeForTests, _setCapCacheForTests } = F;
const { sdkMechanism, discoverAll } = await import('../src/agent/capability-discovery.js');
const { flushInstanceScopedState } = await import('../src/servicenow/instance-binding.js');
const { STATUS } = await import('../src/servicenow/semantic/provenance.js');

const READY = Object.freeze({
  ok: true,
  cli: { present: true, version: '4.10.1', error: null },
  auth: { verified: 'derived', host: 'dev424910.service-now.com' },
  workspace: { present: true, scope: 'x_2002152_nwforge', error: null, sources: [] },
  cheatsheet: { present: true },
  fixes: [],
});

const tick = () => new Promise((r) => setImmediate(r));

test.beforeEach(() => { _setCapabilityProbeForTests(null); _setCapCacheForTests(null); });
test.after(() => { _setCapabilityProbeForTests(null); _setCapCacheForTests(null); });

/* ------------------------------------------------------------------ *
 * Stale-while-revalidate
 * ------------------------------------------------------------------ */

test('past the TTL the last known value is still served, and ONE refresh is triggered', async () => {
  let probes = 0;
  let release;
  _setCapabilityProbeForTests(() => { probes += 1; return new Promise((r) => { release = r; }); });
  _setCapCacheForTests({ at: Date.now() - CAP_TTL_MS - 1000, value: READY });

  const first = cachedCapability();
  assert.equal(first?.ok, true, 'a stale value must be served, not replaced by null');
  assert.equal(first.workspace.scope, 'x_2002152_nwforge');
  assert.equal(probes, 1, 'staleness must trigger exactly one refresh');

  // Asked again while the refresh is in flight: same value, no second probe.
  assert.equal(cachedCapability()?.ok, true);
  assert.equal(probes, 1, 'a refresh already in flight must not be duplicated');

  // Discovery, which is what the planner reads, sees the SDK as KNOWN throughout.
  assert.equal(sdkMechanism().status, STATUS.KNOWN);
  const d = discoverAll();
  assert.equal(d.capabilities.flow_authoring.available, true);
  assert.equal(d.capabilities.flow_authoring.mechanism, 'sdk');
  assert.equal(d.capabilities.flow_authoring.scope, 'x_2002152_nwforge');

  release({ ...READY, cli: { ...READY.cli, version: '4.10.2' } });
  await tick(); await tick();
  assert.equal(cachedCapability().cli.version, '4.10.2', 'the refreshed value replaces the stale one');
});

test('B3 — a FAILED probe downgrades a stale value to UNKNOWN; staleness alone never does', async () => {
  _setCapabilityProbeForTests(() => Promise.reject(new Error('now-sdk exploded')));
  _setCapCacheForTests({ at: Date.now() - CAP_TTL_MS - 1000, value: READY });

  assert.equal(cachedCapability()?.ok, true, 'served stale until the probe answers');
  await tick(); await tick(); await tick();
  assert.equal(cachedCapability(), null, 'after the probe FAILED the value must be gone');
  assert.equal(sdkMechanism().status, STATUS.UNKNOWN);
  assert.equal(discoverAll().capabilities.flow_authoring.available, false);
});

test('a cold process is UNKNOWN until its first probe completes', async () => {
  let release;
  _setCapabilityProbeForTests(() => new Promise((r) => { release = r; }));
  assert.equal(cachedCapability(), null);
  assert.equal(sdkMechanism().status, STATUS.UNKNOWN);
  release(READY);
  await tick(); await tick();
  assert.equal(cachedCapability()?.ok, true);
  assert.equal(sdkMechanism().status, STATUS.KNOWN);
});

/* ------------------------------------------------------------------ *
 * The probe runs at boot and on an instance switch, not lazily
 * ------------------------------------------------------------------ */

test('primeCapability() runs the probe without being asked by a request, and resolves to the value', async () => {
  let probes = 0;
  _setCapabilityProbeForTests(async () => { probes += 1; return READY; });
  const v = await primeCapability();
  assert.equal(probes, 1);
  assert.equal(v?.ok, true);
  assert.equal(cachedCapability()?.ok, true);
  assert.equal(discoverAll().capabilities.flow_authoring.available, true);
});

test('an instance switch flushes the cached probe and starts a new one', async () => {
  let probes = 0;
  _setCapabilityProbeForTests(async () => { probes += 1; return READY; });
  _setCapCacheForTests({ at: Date.now(), value: { ...READY, auth: { verified: 'derived', host: 'old.service-now.com' } } });
  assert.equal(cachedCapability().auth.host, 'old.service-now.com');

  const r = flushInstanceScopedState('test switch');
  assert.ok(r.flushed.includes('sdk-capability'), `the SDK probe cache is not registered as per-instance state: ${r.flushed.join(', ')}`);
  // Flushed: the old host's answer is gone (UNKNOWN, honestly) and a fresh
  // probe is already running rather than waiting for the next request.
  assert.equal(cachedCapability(), null);
  await tick(); await tick();
  assert.equal(probes >= 1, true, 'no probe was kicked after the switch');
  assert.equal(cachedCapability()?.auth.host, 'dev424910.service-now.com');
});

/* ------------------------------------------------------------------ *
 * The boot path actually calls it
 * ------------------------------------------------------------------ */

test('the server primes the SDK probe at boot', () => {
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /primeCapability\(\)/, 'index.js must kick the first probe at boot rather than leaving it to the first request');
});
