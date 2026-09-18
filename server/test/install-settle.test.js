import test from 'node:test';
import assert from 'node:assert/strict';

import { settleTimedOutInstall } from '../src/servicenow/fluent.js';

/**
 * A TIMED-OUT INSTALL IS NOT A FAILED INSTALL.
 *
 * MEASURED on dev424910, 17 Sep 2026: three consecutive `now-sdk install` runs
 * each reported `The deployment request timed out waiting for a response` and
 * each had COMPLETED server-side — eleven artifacts, all correct. The SDK aborts
 * its deployment wait at `AbortSignal.timeout(options.timeoutMs ?? 300000)`
 * (sdk-api/dist/connector.js) and `now-sdk install --help` exposes no flag for
 * it, so this is not a misconfiguration to be tuned away; it is the normal
 * behaviour of a slow install.
 *
 * Reporting that exit code as the verdict tells a user their flow was not
 * created when it was. These tests pin the FOUR answers this resolver must keep
 * apart, because collapsing any two of them misleads someone at a keyboard:
 *
 *   landed         absent before, present now - or the stamp moved
 *   absent         not there before, not there now: a real negative
 *   indeterminate  present, stamp unmoved. An install with nothing to change
 *                  looks identical to one that never ran
 *   unknown        the instance could not be read, which is NOT "absent"
 *
 * The instance reader is injected, so none of this touches a real instance.
 */

const stampOf = (sysId, updatedOn) => ({ sysId, updatedOn, scope: 'x_2002152_nwforge' });

/** A reader that answers from a script, one entry per poll. */
const reader = (answers) => {
  let i = 0;
  return async () => answers[Math.min(i++, answers.length - 1)];
};

test('a NEW artifact that appeared after the timeout counts as landed', async () => {
  const res = await settleTimedOutInstall({
    name: 'Critical Incident Auto Progress',
    before: null,
    waitMs: 1000,
    pollMs: 1,
    stamp: reader([null, null, stampOf('abc123', '2026-09-17 17:55:00')]),
  });
  assert.equal(res.landed, true);
  assert.equal(res.sysId, 'abc123');
  assert.match(res.note, /now exists on the instance, so it landed/);
});

test('an UPDATED artifact is detected by its stamp moving, with no clock arithmetic', async () => {
  const before = stampOf('abc123', '2026-09-17 17:00:00');
  const res = await settleTimedOutInstall({
    name: 'Critical Incident Auto Progress',
    before,
    waitMs: 1000,
    pollMs: 1,
    stamp: reader([before, before, stampOf('abc123', '2026-09-17 17:55:00')]),
  });
  assert.equal(res.landed, true);
  assert.deepEqual(res.was, { sysId: 'abc123', updatedOn: '2026-09-17 17:00:00' });
  assert.deepEqual(res.now, { sysId: 'abc123', updatedOn: '2026-09-17 17:55:00' });
  assert.match(res.note, /17:00:00 -> 2026-09-17 17:55:00/);
});

test('an artifact that never changes is not claimed as landed', async () => {
  const before = stampOf('abc123', '2026-09-17 17:00:00');
  const res = await settleTimedOutInstall({
    name: 'Critical Incident Auto Progress',
    before,
    waitMs: 60,
    pollMs: 1,
    stamp: reader([before]),
  });
  assert.equal(res.landed, false, 'nothing observed changing is not evidence that it did');
  assert.equal(res.checked, true);
});

test('an UNREADABLE instance is "unknown", never "did not land"', async () => {
  const res = await settleTimedOutInstall({
    name: 'Critical Incident Auto Progress',
    before: null,
    waitMs: 60,
    pollMs: 1,
    stamp: reader([undefined]),
  });
  assert.equal(res.landed, false);
  assert.match(res.note, /whether it landed is UNKNOWN/,
    '"we could not look" and "it is not there" are different answers');
});

test('it stops as soon as the artifact is seen, rather than waiting out the window', async () => {
  const started = Date.now();
  const res = await settleTimedOutInstall({
    name: 'X',
    before: null,
    waitMs: 5000,
    pollMs: 1,
    stamp: reader([stampOf('s1', 'now')]),
  });
  assert.equal(res.landed, true);
  assert.ok(Date.now() - started < 2000, 'a found artifact must not keep polling');
});

test('an install that was not for one named artifact is reported unchecked, not failed', async () => {
  const res = await settleTimedOutInstall({ name: null, before: null, waitMs: 10, pollMs: 1 });
  assert.equal(res.checked, false);
  assert.equal(res.landed, undefined);
  assert.match(res.reason, /not for one named artifact/);
});

test('a re-created artifact (new sys_id, same name) counts as landed', async () => {
  const before = stampOf('old000', '2026-09-17 17:00:00');
  const res = await settleTimedOutInstall({
    name: 'X',
    before,
    waitMs: 1000,
    pollMs: 1,
    stamp: reader([stampOf('new111', '2026-09-17 17:00:00')]),
  });
  assert.equal(res.landed, true, 'the sys_id changing is a change, even with the same timestamp');
  assert.equal(res.sysId, 'new111');
});

test('an artifact that exists but did not change is INDETERMINATE, not missing', async () => {
  const before = stampOf('abc123', '2026-09-17 17:00:00');
  const res = await settleTimedOutInstall({
    name: 'E2E 08 Scheduled Weekly',
    before,
    waitMs: 60,
    pollMs: 1,
    stamp: reader([before]),
  });
  assert.equal(res.landed, false);
  assert.equal(res.indeterminate, true);
  assert.equal(res.absent, undefined);
  assert.equal(res.sysId, 'abc123', 'the artifact is present and its id is reported');
  assert.match(res.note, /IS on the instance/);
  assert.match(res.note, /undetermined/);
});

test('a NEW artifact that never appeared is absent, which IS a real negative', async () => {
  const res = await settleTimedOutInstall({
    name: 'Never Created',
    before: null,
    waitMs: 60,
    pollMs: 1,
    stamp: reader([null]),
  });
  assert.equal(res.landed, false);
  assert.equal(res.absent, true);
  assert.equal(res.indeterminate, undefined);
  assert.match(res.note, /nothing landed/);
});
