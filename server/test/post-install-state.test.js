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

/* ------------------------------------------------------------------ *
 * F1b — a flow that was published is meant to STAY published
 * ------------------------------------------------------------------ */

/*
 * The same drift, one table over. `now-sdk install` re-applies the app from
 * source, and a flow in source is a DRAFT — so any install, of anything in the
 * app, returns every published flow to draft with nothing saying so. These
 * tests pin the three answers that must stay apart: it is still published, the
 * install un-published it and we republished, and we could not tell.
 */

/** A fake flow whose published proof an install can be made to revert. */
function fakeFlow(published, { publishWorks = true } = {}) {
  const state = { published, publishes: 0 };
  return {
    state,
    appliers: {
      flow_published: {
        describe: (i) => `"${i.target}" published`,
        async read() {
          if (state.published === 'unreadable') return { found: true, sysId: 'f1', current: false, unknown: true, note: 'the named snapshot could not be read' };
          return { found: true, sysId: 'f1', current: state.published === true };
        },
        async write() {
          state.publishes += 1;
          if (!publishWorks) throw new Error('the platform reported 0/1 succeeded');
          state.published = true;
        },
        async readBack() { return state.published === true; },
      },
    },
  };
}

const PUBLISHED = { kind: 'flow_published', target: 'Escalate Network P1 Incident', value: true };

test('an install that returned a published flow to draft is detected and REPUBLISHED', async () => {
  const f = fakeFlow(false);
  const r = await reconcileIntents([PUBLISHED], { appliers: f.appliers });
  assert.equal(r.applied[0].outcome, 're-applied');
  assert.equal(r.applied[0].ok, true);
  assert.equal(f.state.publishes, 1);
  assert.equal(f.state.published, true);
});

test('a flow the install left published is ALREADY-CORRECT — it is not republished', async () => {
  const f = fakeFlow(true);
  const r = await reconcileIntents([PUBLISHED], { appliers: f.appliers });
  assert.equal(r.applied[0].outcome, 'already-correct');
  assert.equal(f.state.publishes, 0, 'republishing a live flow would create a snapshot nobody asked for');
});

test('a published state that cannot be READ is state-unknown — never a pass, and nothing is written', async () => {
  const f = fakeFlow('unreadable');
  const r = await reconcileIntents([PUBLISHED], { appliers: f.appliers });
  assert.equal(r.applied[0].outcome, 'state-unknown');
  assert.equal(r.applied[0].ok, false, '"we could not look" must not be reported as "it is fine"');
  assert.equal(f.state.publishes, 0, 'acting on an unknown state would be acting on a guess');
  assert.match(r.applied[0].note, /could not be read/);
});

test('a republish that the platform refuses is a named failure, not a silent draft', async () => {
  const f = fakeFlow(false, { publishWorks: false });
  const r = await reconcileIntents([PUBLISHED], { appliers: f.appliers });
  assert.equal(r.applied[0].outcome, 'error');
  assert.equal(r.applied[0].ok, false);
  assert.match(r.applied[0].error, /0\/1 succeeded/);
});

test('flow_published is a registered kind, and it refuses an intent it could never keep', async () => {
  assert.ok(POST_INSTALL_KINDS.includes('flow_published'));
  const { recordIntendedState } = await import('../src/servicenow/post-install-state.js');
  assert.throws(
    () => recordIntendedState({ kind: 'flow_published', target: 'Some Flow', value: false }, 'dev424910.service-now.com'),
    /can only be `true`/,
    'there is no un-publish call, so "keep this a draft" is a promise nothing could honour',
  );
});

/* ------------------------------------------------------------------ *
 * The hook has to run on the path flows actually take
 * ------------------------------------------------------------------ */

/*
 * MEASURED 2026-09-17: `reconcilePostInstall` was registered and recording
 * intents, and never ran on a flow deploy. `installWorkspace()` looped over the
 * hooks; `deploy()` — which every flow goes through — called `runSdk(['install'
 * …])` directly and called no hook at all. So the one state most in need of
 * re-applying after an install, a published flow, was reconciled on every path
 * except the one that installs flows.
 *
 * This is a source contract rather than a behavioural test because exercising
 * it for real costs a six-minute install against a live instance. It pins the
 * two call sites and the registration, which is the whole chain.
 */
test('both install paths run the post-install hooks, and the reconciler registers itself', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));

  const fluent = fs.readFileSync(path.join(here, '../src/servicenow/fluent.js'), 'utf8');
  const calls = fluent.match(/runPostInstallHooks\(/g) ?? [];
  assert.ok(calls.length >= 3, `expected a definition and two call sites, found ${calls.length}`);

  /* The body of deploy() must reach the hook runner. */
  const deployAt = fluent.indexOf('export async function deploy(');
  assert.ok(deployAt > 0, 'deploy() should exist');
  const deployBody = fluent.slice(deployAt, deployAt + 6000);
  assert.match(deployBody, /runPostInstallHooks\(/, 'deploy() must run the post-install hooks — flows install through it');

  const installAt = fluent.indexOf('export async function installWorkspace(');
  const installBody = fluent.slice(installAt, installAt + 3000);
  assert.match(installBody, /runPostInstallHooks\(/, 'installWorkspace() must keep running them');

  const reconciler = fs.readFileSync(path.join(here, '../src/servicenow/post-install-state.js'), 'utf8');
  assert.match(reconciler, /registerPostInstallHook\(reconcilePostInstall\)/, 'the reconciler registers itself at import');

  const index = fs.readFileSync(path.join(here, '../src/index.js'), 'utf8');
  assert.match(index, /servicenow\/post-install-state\.js/, 'and the server imports it, which is what performs the registration');
});
