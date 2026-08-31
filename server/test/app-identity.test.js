import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_CONFIG = path.join(SERVER_ROOT, 'fluent-workspace', 'now.config.json');

/*
 * The application identity contract, asserted against the file that is actually
 * committed.
 *
 * These are cheap and they exist because the alternative was measured twice: a
 * pinned scope sys_id sent a build to an application on a retired instance, and
 * a pinned scope NAME could not be registered on the new one at all because the
 * vendor prefix is issued by the instance rather than chosen.
 *
 * The rule they encode:
 *   scope NAME    canonical project identity — belongs in source
 *   scope SYS_ID  instance-local — must never be in source
 */

const config = () => JSON.parse(fs.readFileSync(APP_CONFIG, 'utf8'));

/*
 * The COMMITTED config, not the working copy.
 *
 * `withMaterializedConfig` writes the resolved scopeId into this file for the
 * seconds a build/install needs it and restores it in a `finally`. A test that
 * read the working tree would therefore fail whenever a deploy happened to be
 * in flight — which it did, the first time these ran. The invariant being
 * asserted is "no instance-local id is IN SOURCE", so read what git has.
 */
function committedConfig() {
  try {
    const out = execFileSync('git', ['show', 'HEAD:server/fluent-workspace/now.config.json'], {
      cwd: path.resolve(SERVER_ROOT, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  } catch {
    return null;   // not a git checkout, or the file is not committed yet
  }
}

test('the committed workspace config names a scope', () => {
  assert.match(config().scope, /^x_[0-9]+_[a-z0-9_]+$/);
});

test('the committed workspace config carries NO scope sys_id', () => {
  // The SDK build schema requires `scopeId`, so it is materialised around a
  // build/install and restored in a `finally`. If it is ever found here, the
  // restore leaked and an instance-local id has been committed.
  const cfg = committedConfig();
  if (!cfg) return;   // nothing committed to assert against
  assert.equal('scopeId' in cfg, false,
    'now.config.json carries a scopeId — an instance-local sys_id must not be committed');
});

test('the workspace config holds nothing else instance-specific', () => {
  const cfg = committedConfig();
  if (!cfg) return;
  assert.deepEqual(Object.keys(cfg).sort(), ['name', 'scope']);
  const text = JSON.stringify(cfg);
  assert.doesNotMatch(text, /service-now\.com/, 'no hostname belongs in the workspace config');
  assert.doesNotMatch(text, /\b[0-9a-f]{32}\b/, 'no sys_id belongs in the workspace config');
});

test('the retired scope name is gone from the committed identity', () => {
  // The old application was registered under a vendor prefix this instance does
  // not issue, so the name could never be re-registered here.
  assert.doesNotMatch(JSON.stringify(config()), /x_2196302/);
});

test('the scope name fits the platform cap the SDK enforces', () => {
  // now-sdk init: "cannot be greater than 18 characters".
  assert.ok(config().scope.length <= 18, `${config().scope} is ${config().scope.length} characters`);
});
