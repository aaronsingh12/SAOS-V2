import test from 'node:test';
import assert from 'node:assert/strict';

import { _setSettingsForTests } from '../src/config/store.js';
import {
  instanceKeyFrom, boundInstance, sdkAuthEnv, parseSdkInstanceEcho,
  registerInstanceScopedCache, flushInstanceScopedState, notifyBindingSaved, primeBinding,
} from '../src/servicenow/instance-binding.js';

/*
 * The binding is the single source of truth for which instance NowHelpAssist
 * talks to. Every test here exists because the alternative was measured: an
 * install that succeeded on a retired PDI while the read-back checked the
 * current one and honestly reported nothing.
 */

const bind = (connection) => _setSettingsForTests({ connection });

test.afterEach(() => { _setSettingsForTests(null); });

/* ── normalisation ────────────────────────────────────────────────────────── */

test('an instance key is the bare lowercase host, however the URL was written', () => {
  const expected = 'dev12345.service-now.com';
  for (const form of [
    'https://dev12345.service-now.com',
    'https://dev12345.service-now.com/',
    'https://DEV12345.service-now.com',
    'dev12345.service-now.com',
    'https://dev12345.service-now.com/nav_to.do',
  ]) {
    assert.equal(instanceKeyFrom(form), expected, form);
  }
});

test('nothing normalises to a key', () => {
  assert.equal(instanceKeyFrom(''), null);
  assert.equal(instanceKeyFrom(null), null);
});

test('two different PDIs never collide on a key', () => {
  assert.notEqual(instanceKeyFrom('https://dev442675.service-now.com'), instanceKeyFrom('https://dev428633.service-now.com'));
});

/* ── the bound instance ───────────────────────────────────────────────────── */

test('an instance with no username is not configured', () => {
  bind({ instanceUrl: 'https://dev1.service-now.com' });
  assert.equal(boundInstance().configured, false);
});

test('a bound instance reports its host and trims a trailing slash', () => {
  bind({ instanceUrl: 'https://dev1.service-now.com/', username: 'admin', password: 'x' });
  const b = boundInstance();
  assert.equal(b.configured, true);
  assert.equal(b.url, 'https://dev1.service-now.com');
  assert.equal(b.host, 'dev1.service-now.com');
});

/* ── the derived SDK binding ──────────────────────────────────────────────── */

test('the SDK env is derived from the UI config and names the CI mode', () => {
  bind({ instanceUrl: 'https://dev1.service-now.com', username: 'admin', password: 'secret', authType: 'basic' });
  const env = sdkAuthEnv();
  assert.equal(env.SN_SDK_NODE_ENV, 'SN_SDK_CI_INSTALL');
  assert.equal(env.SN_SDK_AUTH_TYPE, 'basic');
  assert.equal(env.SN_SDK_INSTANCE_URL, 'https://dev1.service-now.com');
  assert.equal(env.SN_SDK_USER, 'admin');
  assert.equal(env.SN_SDK_USER_PWD, 'secret');
});

test('the derived env follows the UI with no code change — the whole point', () => {
  bind({ instanceUrl: 'https://alpha.service-now.com', username: 'admin', password: 'x' });
  assert.equal(sdkAuthEnv().SN_SDK_INSTANCE_URL, 'https://alpha.service-now.com');
  bind({ instanceUrl: 'https://beta.service-now.com', username: 'admin', password: 'x' });
  assert.equal(sdkAuthEnv().SN_SDK_INSTANCE_URL, 'https://beta.service-now.com');
});

test('incomplete credentials produce NO env, so a caller fails closed', () => {
  // Returning a partial env would let the CLI fall back to whatever credential
  // store exists — which is the retired-alias failure, wearing a new hat.
  bind({ instanceUrl: 'https://dev1.service-now.com', username: 'admin' });
  assert.equal(sdkAuthEnv(), null);
  bind({ instanceUrl: '', username: 'admin', password: 'x' });
  assert.equal(sdkAuthEnv(), null);
});

test('oauth carries the client credentials instead of relying on a password', () => {
  bind({ instanceUrl: 'https://dev1.service-now.com', username: 'admin', password: 'p', authType: 'oauth', clientId: 'cid', clientSecret: 'csec' });
  const env = sdkAuthEnv();
  assert.equal(env.SN_SDK_AUTH_TYPE, 'oauth');
  assert.equal(env.SN_SDK_OAUTH_CLIENT_ID, 'cid');
  assert.equal(env.SN_SDK_OAUTH_CLIENT_SECRET, 'csec');
});

/* ── the backstop: what the SDK says it targeted ──────────────────────────── */

test('both CLI echo shapes yield the host', () => {
  // Measured output, verbatim.
  assert.equal(
    parseSdkInstanceEcho('[now-sdk] Running in CI mode, using instance https://dev428633.service-now.com'),
    'dev428633.service-now.com',
  );
  assert.equal(
    parseSdkInstanceEcho('[now-sdk] Attempting to log into instance https://dev442675.service-now.com as admin.'),
    'dev442675.service-now.com',
  );
});

test('output naming no instance is null, never a silent "agrees"', () => {
  assert.equal(parseSdkInstanceEcho('[now-sdk] Retrieved 0 record(s)'), null);
  assert.equal(parseSdkInstanceEcho(''), null);
});

test('the echo is what catches a mismatch — the two hosts differ', () => {
  const ui = instanceKeyFrom('https://dev428633.service-now.com');
  const sdk = parseSdkInstanceEcho('[now-sdk] Attempting to log into instance https://dev442675.service-now.com as admin.');
  assert.notEqual(sdk, ui);
});

/* ── per-instance state ───────────────────────────────────────────────────── */

test('a switch flushes every registered cache; an unchanged save flushes none', () => {
  let flushes = 0;
  registerInstanceScopedCache('test-cache', () => { flushes += 1; });

  bind({ instanceUrl: 'https://alpha.service-now.com', username: 'admin', password: 'x' });
  primeBinding();

  // Saving the same instance must not throw away a warm cache.
  assert.equal(notifyBindingSaved().changed, false);
  assert.equal(flushes, 0);

  bind({ instanceUrl: 'https://beta.service-now.com', username: 'admin', password: 'x' });
  const res = notifyBindingSaved();
  assert.equal(res.changed, true);
  assert.equal(res.previous, 'alpha.service-now.com');
  assert.equal(res.instance, 'beta.service-now.com');
  assert.ok(res.flushed.includes('test-cache'));
  assert.equal(flushes, 1);
});

test('one cache throwing does not stop the others from flushing', () => {
  // A half-flushed switch is the worst outcome: some state is about the new
  // instance and some is about the old, with nothing saying which.
  registerInstanceScopedCache('throws', () => { throw new Error('nope'); });
  let other = 0;
  registerInstanceScopedCache('survivor', () => { other += 1; });
  const res = flushInstanceScopedState('test');
  assert.ok(res.flushed.includes('survivor'));
  assert.ok(res.failed.some((f) => f.name === 'throws'));
  assert.equal(other, 1);
});
