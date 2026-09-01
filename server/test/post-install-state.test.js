import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileIntents, POST_INSTALL_KINDS } from '../src/servicenow/post-install-state.js';

/*
 * F1 — the drift a one-off fix created.
 *
 * `emp_assets` was asked to be INACTIVE. Fluent's Table() has no `active`
 * option, so the flag can only be set over the Table API after the install —
 * and `now-sdk install` re-applies the whole app from source on every deploy.
 * The flag was one unrelated install away from flipping back to active: a
 * change nobody made, that nothing reported.
 *
 * The reconciler records the INTENT and re-applies it after every deploy. What
 * these tests pin is the part that carries the rules — the outcomes it
 * distinguishes. Collapsing any two of them would hide the drift again.
 */

/** A fake target whose stored value an install can be made to revert. */
function fakeApplier(initial, { writeLands = true, absent = false } = {}) {
  const state = { value: initial, writes: 0 };
  return {
    state,
    appliers: {
      table_active: {
        describe: (i) => `${i.target}.active = ${i.value}`,
        async read() { return absent ? { found: false } : { found: true, sysId: 'sys1', current: state.value }; },
        async write(intent) { state.writes += 1; if (writeLands) state.value = intent.value; },
        async readBack() { return state.value; },
      },
    },
  };
}

const INTENT = { kind: 'table_active', target: 'x_2002152_nwforge_emp_assets', value: false };

test('an install that reverted the flag is detected and RE-APPLIED', async () => {
  // The exact scenario: the deploy put active back to true.
  const f = fakeApplier(true);
  const r = await reconcileIntents([INTENT], { appliers: f.appliers });
  assert.equal(r.applied[0].outcome, 're-applied');
  assert.equal(r.applied[0].ok, true);
  assert.equal(r.applied[0].from, true);
  assert.equal(r.applied[0].to, false);
  assert.equal(r.reApplied, 1);
  assert.equal(f.state.value, false, 'the flag must end up as intended');
});

test('a flag the install did not touch is ALREADY-CORRECT, not a re-apply', async () => {
  // The distinction matters: "the install reverted this and we fixed it" is a
  // thing to log; "nothing happened" is not, and reporting both the same way
  // would make the signal worthless.
  const f = fakeApplier(false);
  const r = await reconcileIntents([INTENT], { appliers: f.appliers });
  assert.equal(r.applied[0].outcome, 'already-correct');
  assert.equal(r.reApplied, 0);
  assert.equal(f.state.writes, 0, 'nothing should be written when nothing drifted');
});

test('a write whose READ-BACK disagrees is a failure, never a success', async () => {
  // The M-1 lesson: the write returning is a claim. Only the read-back decides.
  const f = fakeApplier(true, { writeLands: false });
  const r = await reconcileIntents([INTENT], { appliers: f.appliers });
  assert.equal(r.applied[0].outcome, 'write-did-not-land');
  assert.equal(r.applied[0].ok, false);
  assert.equal(r.applied[0].readBack, true);
  assert.equal(r.failed, 1);
  assert.match(r.warning, /NOT as asked/);
});

test('a target that no longer exists is reported, not silently skipped', async () => {
  // A dropped table is a legitimate reason for an intent to have nothing to do.
  // It is still surfaced, so a stale intent is visible rather than invisible.
  const f = fakeApplier(true, { absent: true });
  const r = await reconcileIntents([INTENT], { appliers: f.appliers });
  assert.equal(r.applied[0].outcome, 'target-absent');
  assert.equal(r.applied[0].ok, true);
  assert.equal(r.failed, 0);
});

test('an applier that throws fails that intent alone', async () => {
  const appliers = {
    table_active: {
      describe: () => 'x',
      async read() { throw new Error('instance unreachable'); },
    },
  };
  const r = await reconcileIntents([INTENT], { appliers });
  assert.equal(r.applied[0].outcome, 'error');
  assert.equal(r.applied[0].ok, false);
  assert.match(r.applied[0].error, /instance unreachable/);
});

test('an intent of an unknown kind fails loudly rather than being dropped', async () => {
  const r = await reconcileIntents([{ kind: 'some_future_thing', target: 't', value: 1 }], { appliers: {} });
  assert.equal(r.applied[0].outcome, 'unknown-kind');
  assert.equal(r.applied[0].ok, false);
});

test('one failing intent does not stop the others', async () => {
  const good = fakeApplier(true);
  const appliers = {
    ...good.appliers,
    broken: { describe: () => 'b', async read() { throw new Error('nope'); } },
  };
  const r = await reconcileIntents(
    [{ kind: 'broken', target: 'b', value: 1 }, INTENT],
    { appliers },
  );
  assert.equal(r.count, 2);
  assert.equal(r.failed, 1);
  assert.equal(good.state.value, false, 'the healthy intent must still be applied');
});

test('no intents is a clean no-op', async () => {
  const r = await reconcileIntents([], {});
  assert.equal(r.count, 0);
  assert.equal(r.reApplied, 0);
  assert.equal(r.failed, 0);
});

test('table_active is a registered kind', () => {
  assert.ok(POST_INSTALL_KINDS.includes('table_active'));
});
