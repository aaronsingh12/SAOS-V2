/**
 * PHASE 9 — RESTART AND CRASH BOUNDARIES.
 *
 *   node --test server/test/
 *
 * THE QUESTION. A process dies at an arbitrary moment. What does the database
 * say afterwards, and can that record ever be more confident than the truth?
 *
 * A CRASH IS SIMULATED BY CLOSING THE FILE, not by killing a process. That is
 * the harsher test, not the weaker one: it drops every piece of in-memory state
 * — the AbortController, the pending approval map, the plan the executor was
 * holding — while leaving the file exactly as the last committed write left it.
 * Anything the system "knows" afterwards had to come off disk.
 *
 * THE RULE BEING PROVEN. The durable record must never claim an operation
 * happened because memory said so. Where a mutation's outcome is genuinely
 * unknown after a crash — the response was lost with the process — the record
 * must say `executing` or `unverified`, and recovery must refuse to repeat it.
 *
 * A NOTE ON WHAT IS *NOT* CLAIMED. This build has no crash-recovery sweeper: a
 * task left `executing` by a dead process stays `executing` until something asks
 * about it. That is deliberate — inventing a terminal state for a run nobody
 * observed would be exactly the lie this phase exists to prevent — and the tests
 * below assert the honest state rather than a tidy one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p9res-'));
const HOME_FILE = path.join(scratchDir, 'home.db');
_setDbForTests(migrate(new DatabaseSync(HOME_FILE)));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const P = await import('../src/agent/plan/index.js');
const R = await import('../src/agent/recovery/index.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask, getTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { appendMutation } = await import('../src/memory/ledger.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');

const SYS = 'c'.repeat(32);
const localTool = (name, spec) => { toolMap.set(name, { name, ...spec }); return () => toolMap.delete(name); };

let fileN = 0;
/**
 * Run `before` against a private database file, then CLOSE it — the crash — and
 * run `after` against the same file freshly reopened. Nothing survives except
 * what was committed.
 */
async function acrossRestart(before, after) {
  const file = path.join(scratchDir, `crash-${++fileN}.db`);
  const first = migrate(new DatabaseSync(file));
  _setDbForTests(first);
  let carried;
  try {
    carried = await before();
  } finally {
    first.close();          // ← the crash: every in-memory structure is gone
  }
  const second = migrate(new DatabaseSync(file));
  _setDbForTests(second);
  try {
    return await after(carried);
  } finally {
    second.close();
    _setDbForTests(migrate(new DatabaseSync(HOME_FILE)));
  }
}

function seed(sessionId = 'crash', goal = 'a plan interrupted by a crash') {
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sessionId, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId, goal });
  startTask(t.id);
  return t.id;
}

const writeStep = (over = {}) => ({
  id: 'step_1',
  operation: 'update the incident',
  capability: 'record_update',
  tool: over.tool ?? null,
  mechanism: null,
  scope: null,
  mutating: true,
  target: { table: 'incident', sys_id: SYS },
  inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'AFTER' } },
  depends_on: [],
  expected_effects: ['short_description becomes AFTER'],
  verification: { strategy: 'read_back', asserts: ['short_description == AFTER'] },
  ...over,
});

const savePlan = (taskId, steps, goal = 'g') => P.savePlan(taskId, { goal, steps });

/* ================================================================== *
 * A. THE BOUNDARIES, one per crash point
 * ================================================================== */

test('B1 — crash AFTER task creation: the task survives with no plan and no claims', async () => {
  await acrossRestart(
    () => ({ taskId: seed() }),
    ({ taskId }) => {
      const task = getTask(taskId);
      assert.ok(task, 'the task did not survive');
      assert.equal(task.state, 'running', 'a task nobody finished was reported terminal');
      assert.equal(P.loadPlan(taskId).planState, null, 'a task with no plan claims a plan state');
      const ev = buildEvidence(taskId);
      assert.equal(ev.plan, null, 'evidence invented a plan');
      assert.deepEqual(ev.changes, [], 'evidence claimed a change that never happened');
      assert.ok(ev.uncertainties.some((u) => u.kind === 'incomplete'),
        'a run with no terminal timestamp was not flagged as incomplete');
    },
  );
});

test('B2 — crash AFTER plan persistence: the plan and its fingerprint survive, unapproved', async () => {
  await acrossRestart(
    () => {
      const taskId = seed();
      const saved = savePlan(taskId, [writeStep()]);
      return { taskId, fingerprint: saved.fingerprint };
    },
    ({ taskId, fingerprint }) => {
      const plan = P.loadPlan(taskId);
      assert.equal(plan.fingerprint, fingerprint, 'the fingerprint changed across a restart');
      assert.equal(plan.approvedFingerprint, null, 'a plan came back already approved');
      assert.equal(plan.steps[0].state, 'pending');
      // The binding must refuse: nothing was ever approved.
      assert.equal(P.checkApprovalBinding(taskId).ok, false, 'an unapproved plan is bound');
    },
  );
});

test('B3 — crash AFTER approval creation but BEFORE resolution: nothing is authorised', async () => {
  await acrossRestart(
    () => {
      const taskId = seed();
      savePlan(taskId, [writeStep()]);
      P.setPlanState(taskId, 'ready');
      P.setPlanState(taskId, 'awaiting_approval');
      P.setStepState(taskId, 'step_1', 'ready');
      P.setStepState(taskId, 'step_1', 'awaiting_approval');
      return { taskId };
    },
    ({ taskId }) => {
      /*
       * The pending approval lived in memory and is gone. That is correct: an
       * approval nobody answered must not survive a restart, because the card it
       * belonged to is gone too and the nonce with it. What survives is a plan
       * still waiting — which cannot execute, because nothing bound it.
       */
      const plan = P.loadPlan(taskId);
      assert.equal(plan.planState, 'awaiting_approval');
      assert.equal(plan.approvedFingerprint, null, 'an unanswered approval survived as an approval');
      assert.equal(P.checkApprovalBinding(taskId).ok, false);
      const ev = buildEvidence(taskId);
      assert.notEqual(ev.approval.status, 'approved', 'evidence reports an approval nobody gave');
      assert.deepEqual(ev.changes, []);
    },
  );
});

test('B4 — crash AFTER approval resolution: the binding survives, because it is durable', async () => {
  await acrossRestart(
    () => {
      const taskId = seed();
      const saved = savePlan(taskId, [writeStep()]);
      P.setPlanState(taskId, 'ready');
      P.setPlanState(taskId, 'awaiting_approval');
      P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
      return { taskId, fingerprint: saved.fingerprint };
    },
    ({ taskId, fingerprint }) => {
      const plan = P.loadPlan(taskId);
      assert.equal(plan.approvedFingerprint, fingerprint, 'a real approval was lost on restart');
      assert.equal(plan.approvedSource, APPROVAL_SOURCES.USER_CLICK,
        'the approval survived without its provenance');
      assert.ok(plan.approvedAt);
      assert.equal(P.checkApprovalBinding(taskId).ok, true);
      // And it still binds only THIS plan.
      savePlan(taskId, [writeStep({ operation: 'DELETE the incident' })]);
      assert.equal(P.checkApprovalBinding(taskId).ok, false,
        'the surviving approval bound a plan edited after the restart');
    },
  );
});

test('B5 — crash IMMEDIATELY BEFORE execution: no ledger row, no claim of a change', async () => {
  await acrossRestart(
    () => {
      const taskId = seed();
      const saved = savePlan(taskId, [writeStep()]);
      P.setPlanState(taskId, 'ready');
      P.setPlanState(taskId, 'awaiting_approval');
      P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
      P.setPlanState(taskId, 'executing');
      P.setStepState(taskId, 'step_1', 'ready');
      return { taskId };
    },
    ({ taskId }) => {
      const ev = buildEvidence(taskId);
      assert.deepEqual(ev.changes, [], 'a change was claimed for a step that never ran');
      assert.equal(ev.steps[0].executed, false, 'a step that never ran is reported as executed');
      assert.notEqual(ev.final.status, 'VERIFIED');
      assert.equal(P.loadPlan(taskId).steps[0].state, 'ready');
    },
  );
});

test('B6 — crash DURING tool execution: the outcome is UNKNOWN and stays unknown', async () => {
  /*
   * THE HARDEST CASE, and the one the whole discipline exists for. The step was
   * marked `executing`, the request went out, and the process died before any
   * answer came back. The instance may or may not have applied the write.
   *
   * There is no honest terminal state for this, so the record keeps saying
   * `executing`. What must NOT happen is a tidy-up that decides it failed (and
   * invites a retry that duplicates) or decides it succeeded (and reports a
   * change nobody can point to).
   */
  await acrossRestart(
    () => {
      const taskId = seed();
      const saved = savePlan(taskId, [writeStep({ tool: 'update_record' })]);
      P.setPlanState(taskId, 'ready');
      P.setPlanState(taskId, 'awaiting_approval');
      P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
      P.setPlanState(taskId, 'executing');
      P.setStepState(taskId, 'step_1', 'ready');
      P.setStepState(taskId, 'step_1', 'executing');
      return { taskId };
    },
    async ({ taskId }) => {
      const plan = P.loadPlan(taskId);
      assert.equal(plan.steps[0].state, 'executing',
        'a step interrupted mid-call was given a terminal state nobody observed');
      assert.ok(plan.steps[0].startedAt, 'the step lost its start time');
      assert.equal(plan.steps[0].completedAt, null, 'a step that never completed has a completion time');

      const ev = buildEvidence(taskId);
      assert.deepEqual(ev.changes, [], 'a change was claimed with no ledger row behind it');
      assert.notEqual(ev.final.status, 'VERIFIED');
      assert.ok(ev.uncertainties.some((u) => u.kind === 'incomplete'));

      // RECOVERY MUST REFUSE. The effect is unestablished and the operation
      // cannot be shown to be safe to repeat.
      let executed = 0;
      const out = await R.recoverStep({
        taskId, stepId: 'step_1', sessionId: 'crash',
        error: null,
        descriptor: { operation: 'update', table: 'incident', sys_id: SYS, requested: { short_description: 'AFTER' } },
        executeStep: async () => { executed += 1; return { ok: true }; },
        // No readRecord: nothing can establish whether it landed.
      });
      assert.equal(executed, 0, 'a mutation with an unknown outcome was repeated after a crash');
      assert.notEqual(out.outcome, R.OUTCOME.RECOVERED);
    },
  );
});

test('B7 — crash AFTER the mutation but BEFORE verification: the write is recorded, unverified', async () => {
  await acrossRestart(
    () => {
      const taskId = seed();
      const saved = savePlan(taskId, [writeStep({ tool: 'update_record' })]);
      P.setPlanState(taskId, 'ready');
      P.setPlanState(taskId, 'awaiting_approval');
      P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
      P.setPlanState(taskId, 'executing');
      P.setStepState(taskId, 'step_1', 'ready');
      P.setStepState(taskId, 'step_1', 'executing');
      // The ledger row lands; the verifier never runs.
      appendMutation({
        sessionId: 'crash', turnSeq: 0, tool: 'update_record', taskId,
        descriptor: { table: 'incident', sys_id: SYS, operation: 'update', requested: { short_description: 'AFTER' } },
        result: { sys_id: SYS },
        verification: null,                       // ← nothing was proven
        approval: 'approved', approvedSource: APPROVAL_SOURCES.USER_CLICK,
      });
      return { taskId };
    },
    ({ taskId }) => {
      const ev = buildEvidence(taskId);
      // The write IS recorded — it happened, and hiding it would be worse.
      assert.equal(ev.changes.length, 1, 'a recorded mutation was lost across the restart');
      assert.equal(ev.changes[0].exact, true, 'the surviving ledger row lost its task');
      // But it is NOT verified, and the run is not VERIFIED.
      assert.equal(ev.changes[0].verification_status, 'unverified');
      assert.notEqual(ev.final.status, 'VERIFIED',
        'a write nobody read back was reported as verified');
    },
  );
});

test('B8 — crash AFTER verification but BEFORE evidence: evidence rebuilds from the rows', async () => {
  /*
   * Evidence is a PROJECTION, built on demand from durable rows. There is no
   * "evidence construction" step that can be interrupted — which is itself the
   * property being asserted: whatever was committed is enough to rebuild it.
   */
  await acrossRestart(
    () => {
      const taskId = seed();
      const saved = savePlan(taskId, [writeStep({ tool: 'update_record' })]);
      P.setPlanState(taskId, 'ready');
      P.setPlanState(taskId, 'awaiting_approval');
      P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
      P.setPlanState(taskId, 'executing');
      P.setStepState(taskId, 'step_1', 'ready');
      P.setStepState(taskId, 'step_1', 'executing');
      appendMutation({
        sessionId: 'crash', turnSeq: 0, tool: 'update_record', taskId,
        descriptor: { table: 'incident', sys_id: SYS, operation: 'update', requested: { short_description: 'AFTER' } },
        result: { sys_id: SYS },
        verification: { status: 'applied', operation: 'update', applied: [{ field: 'short_description', value: 'AFTER' }] },
        approval: 'approved', approvedSource: APPROVAL_SOURCES.USER_CLICK,
      });
      P.recordStepResult(taskId, 'step_1', {
        result: { sys_id: SYS },
        verification: { status: 'applied', strategy: 'read_back', applied: [{ field: 'short_description', value: 'AFTER' }] },
      });
      P.setStepState(taskId, 'step_1', 'completed');
      return { taskId };
    },
    ({ taskId }) => {
      const ev = buildEvidence(taskId);
      assert.equal(ev.changes.length, 1);
      assert.equal(ev.changes[0].verification_status, 'applied');
      assert.equal(ev.steps[0].execution_status, 'completed');
      assert.equal(ev.steps[0].verification_status, 'applied');
      // The PLAN was never closed — the process died first — and the projection
      // says so rather than closing it retroactively.
      assert.equal(P.loadPlan(taskId).planState, 'executing');
      assert.ok(ev.uncertainties.some((u) => u.kind === 'incomplete'));
    },
  );
});

test('B9 — crash DURING recovery: the attempt already recorded survives, and no second one is invented', async () => {
  await acrossRestart(
    () => {
      const taskId = seed();
      savePlan(taskId, [writeStep({ tool: 'update_record' })]);
      P.setStepState(taskId, 'step_1', 'ready');
      P.setStepState(taskId, 'step_1', 'executing');
      P.setStepState(taskId, 'step_1', 'failed', { failure_reason: 'the instance faulted' });
      P.recordRecoveryAttempt(taskId, 'step_1', {
        attempt: 1, failureKind: 'TRANSIENT', decision: 'RETRY',
        reason: 'transient', idempotency: 'IDEMPOTENT', outcome: 'NOT_RECOVERED',
      });
      return { taskId };
    },
    ({ taskId }) => {
      const history = P.recoveryHistory(taskId, 'step_1');
      assert.equal(history.attempts.length, 1, 'the recovery lineage did not survive intact');
      assert.equal(history.attempts[0].decision, 'RETRY');
      assert.equal(history.attempts[0].outcome, 'NOT_RECOVERED');
      const ev = buildEvidence(taskId);
      assert.equal(ev.recovery.attempted, true);
      assert.equal(ev.recovery.recoveredSteps, 0, 'an interrupted recovery was reported as recovered');
      assert.equal(ev.recovery.unrecoveredSteps, 1);
      assert.ok(ev.uncertainties.some((u) => u.kind === 'unrecovered_failure'));
    },
  );
});

test('B10 — crash AFTER attempt 1 and BEFORE attempt 2: the budget is read off disk, not memory', async () => {
  await acrossRestart(
    () => {
      const taskId = seed();
      savePlan(taskId, [writeStep({ tool: 'update_record' })]);
      P.setStepState(taskId, 'step_1', 'ready');
      P.setStepState(taskId, 'step_1', 'executing');
      P.setStepState(taskId, 'step_1', 'failed', { failure_reason: 'boom' });
      // Attempt 1 is on disk. A fresh process has no memory of it.
      P.recordRecoveryAttempt(taskId, 'step_1', {
        attempt: 1, failureKind: 'TRANSIENT', decision: 'RETRY', outcome: 'NOT_RECOVERED',
      });
      return { taskId };
    },
    async ({ taskId }) => {
      /*
       * THE BUDGET IS DURABLE. A restart must not hand the step a fresh
       * allowance — that would turn MAX_ATTEMPTS into "twice per process
       * lifetime", and a crash-looping server into a duplicate factory.
       */
      const history = R.historyFrom({ recovery: P.recoveryHistory(taskId, 'step_1') });
      assert.equal(history.attempts, 1, 'the attempt count reset across the restart');

      let executed = 0;
      const out = await R.recoverStep({
        taskId, stepId: 'step_1', sessionId: 'crash',
        error: { status: 503 },
        descriptor: { operation: 'update', table: 'incident', sys_id: SYS, requested: { short_description: 'AFTER' } },
        executeStep: async () => { executed += 1; return { ok: false, note: 'still failing' }; },
      });
      // One prior attempt is already spent, so this is the last one the policy
      // permits — and the decision comes from the stored history.
      assert.ok(['RETRY', 'STOP'].includes(out.decision.decision), `unexpected ${out.decision.decision}`);
      if (out.decision.decision === 'STOP') {
        assert.match(out.decision.reason, /budget_exhausted/);
        assert.equal(executed, 0);
      }
      // Either way, the lineage on disk grew by exactly one.
      assert.equal(P.recoveryHistory(taskId, 'step_1').attempts.length, 2,
        'the restart lost or duplicated an attempt record');
    },
  );
});

/* ================================================================== *
 * B. THE GENERAL RULE
 * ================================================================== */

test('B11 — nothing in the durable record depends on in-memory state', () => {
  /*
   * The structural half of the claim. `loadPlan` reconstructs everything from
   * the database; there is no cache to go stale and no module-level map holding
   * a plan, a task or an approval binding between requests.
   */
  const store = fs.readFileSync(new URL('../src/agent/plan/store.js', import.meta.url), 'utf8');
  assert.ok(!/^const\s+\w+\s*=\s*new Map\(\)/m.test(store.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the plan store keeps an in-memory map');
  assert.match(store, /reconstructed from the database alone/,
    'loadPlan no longer claims to be database-only');

  // The one in-memory structure that exists — the pending approval map — is
  // deliberately NOT durable, because a card nobody can answer must not survive.
  const orch = fs.readFileSync(new URL('../src/agent/orchestrator.js', import.meta.url), 'utf8');
  assert.match(orch, /pending/, 'the pending approval map is gone');
});

test('B12 — a task left running by a dead process is reported as incomplete, not failed', async () => {
  await acrossRestart(
    () => {
      const taskId = seed();
      savePlan(taskId, [writeStep({ tool: 'update_record' })]);
      P.setPlanState(taskId, 'ready');
      P.setPlanState(taskId, 'executing');
      return { taskId };
    },
    ({ taskId }) => {
      const ev = buildEvidence(taskId);
      /*
       * NOT `FAILED`. Nobody observed a failure — the process simply stopped
       * existing. Calling it failed would invite a retry of a mutation whose
       * outcome is unknown, which is the one thing that must never follow from
       * a crash.
       */
      assert.notEqual(ev.final.status, 'FAILED',
        'an interrupted run was reported as failed, which invites an unsafe retry');
      const u = ev.uncertainties.find((x) => x.kind === 'incomplete');
      assert.ok(u, 'an interrupted run carries no uncertainty');
      assert.match(u.note, /may still be running|process that owned it died/);
    },
  );
});
