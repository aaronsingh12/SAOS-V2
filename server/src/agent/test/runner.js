/**
 * PHASE 17 — THE COMPOSITION, AND NOTHING ELSE.
 *
 * Read down this file and the only new ideas are: which flow, what fixture,
 * what to assert, and what the answer means. Everything with teeth is CALLED:
 *
 *   planning + validation   generatePlan (with a deterministic proposal)
 *   canonicalisation        inside stampPlatformFacts / savePlan
 *   the fingerprint         savePlan, re-checked by the executor every step
 *   approval                the existing gate, injected as `approve`
 *   execution               executePlan
 *   write guards            inside runStep, unchanged
 *   read-back verification  the mutation pipeline, unchanged
 *   the mutation ledger     appendMutation, unchanged
 *   evidence                agent_task_steps + tool_events, unchanged
 *   redaction               the existing redactor, at the evidence boundary
 *
 * EVERY DEPENDENCY IS INJECTED, and not only for testability. It makes the
 * absence of a second path a property of the import graph: there is no import
 * of the ServiceNow client, of a provider, or of the database anywhere under
 * `agent/test/`, so "NowTest cannot reach the instance on its own" is checkable
 * rather than promised. §68's boundary list is enforced by `test/index.js`
 * having nothing to enforce.
 *
 * §17 — CLEANUP RUNS IN A `finally`, ALWAYS.
 *
 * The happy path deletes the fixture as the plan's last step, so one approval
 * covers the whole test and the person who approved it saw the delete. But the
 * executor stops a plan at its first failed step, and a cancellation stops it
 * between steps — so the `finally` below asks the ownership ledger what is
 * still outstanding and runs a second plan, through the SAME executor and the
 * SAME approval engine, for exactly those records. A cleanup that does not
 * happen is reported as a cleanup that did not happen (§36).
 */
import { RESULTS, BLOCKS, CLEANUP, MODES, FAILURES, emptyResult } from './schemas.js';
import { readTestIntent } from './intent.js';
import { triggerOf, satisfyCondition, verifyTriggerSatisfied } from './trigger.js';
import { effectsOf, requiredEffects } from './effects.js';
import { buildFixture, ownership, isDisposable, DISPOSABLE_LIST } from './fixture.js';
import { assertionsFor, evaluate, cellValue, unexpectedEffects } from './assertions.js';
import { buildContract, validateContract, coverageOf } from './contract.js';
import {
  buildTestPlan, cleanupPlan, countableAssertions, STEP_IDS, DEFAULT_TEST_TIMEOUT_MS,
} from './planner.js';
import { decideResult } from './result.js';

const now = () => Date.now();

/**
 * Run one flow test.
 *
 * @param deps every collaborator, injected. See the module comment.
 */
export async function testFlow({
  request,
  taskId,
  sessionId,
  sys_id: sysId = null,
  /* identification + artifact */
  find,
  readArtifact,
  chat = null,
  /* the dictionary, and the semantic layer */
  schemaFor,
  derivation = () => null,
  /* the existing plan pipeline */
  generate,
  run,
  plan: planApi,
  approve = null,
  autoApprove = false,
  /*
   * Extra fields for the DISPOSABLE fixture, each validated against the live
   * dictionary before it is written. Not a way to test against an existing
   * record — see `validateExtraFields` for what this is for and what it
   * refuses.
   */
  fixture_fields: fixtureFields = {},
  /* optional: §41, surfaced, never a gate */
  lint = null,
  /* durable persistence, injected so this module never touches a database */
  record = null,
  /* the cleanup plan needs its own task id; the caller mints it */
  newTaskId = null,
  timeoutMs = DEFAULT_TEST_TIMEOUT_MS,
  signal = null,
  emit = () => {},
} = {}) {
  const started = now();
  const timings = {};
  const owned = ownership();
  const base = emptyResult({ mode: MODES.DISPOSABLE });
  let out = base;

  const cancelled = () => Boolean(signal?.aborted);

  try {
    /* ---- 1. which flow (§8) ---- */
    const intent = await readTestIntent({ request, find, chat, signal, sys_id: sysId });
    if (!intent.ok) {
      return blocked(base, intent.block, intent.note, {
        candidates: intent.found?.candidates ?? [],
        mode: intent.mode,
      });
    }
    const flow = { sys_id: intent.found.sys_id, name: intent.found.name };
    emit({ type: 'test_flow_identified', taskId, flow, by: intent.by });

    /* ---- 2. the live artifact (§9) ---- */
    const artifact = await readArtifact(flow.sys_id);
    out = { ...base, artifact: projectArtifact(artifact) };
    if (artifact?.flow?.active === false) {
      return blocked(out, BLOCKS.FLOW_INACTIVE,
        `"${flow.name}" is not active, so creating a record cannot make it run. Nothing was created.`);
    }

    /* ---- 3. the trigger (§10, §14) ---- */
    const trigger = triggerOf(artifact);
    if (!trigger.ok) {
      return blocked(out,
        trigger.reason === 'trigger_kind_unsupported' ? BLOCKS.TRIGGER_UNSUPPORTED : BLOCKS.TRIGGER_UNREADABLE,
        trigger.note);
    }
    if (!isDisposable(trigger.table)) {
      return blocked(out, BLOCKS.FIXTURE_TABLE_NOT_DISPOSABLE,
        `"${flow.name}" is triggered by records on "${trigger.table}". This build creates disposable test records on `
        + `${DISPOSABLE_LIST.join(' and ')} only, so nothing was created. Creating a record on an arbitrary table to `
        + 'see what happens is not a decision a test may make on its own.');
    }

    /* ---- 4. the dictionary ---- */
    const fields = await fieldsOf(schemaFor, trigger.table);

    /* ---- 5. what a record must look like (§14, §15) ---- */
    const satisfaction = satisfyCondition(trigger, { fields, derivation });

    /* ---- 6. what the flow promises (§10, §11) ---- */
    const effects = requiredEffects(effectsOf(artifact, trigger));

    /* ---- 7. the fixture (§16, §47) ---- */
    const fixture = buildFixture({ trigger, satisfaction, effects, fields, taskId, extra: fixtureFields, derivation });
    if (!fixture.ok) {
      return blocked(out, fixture.block, fixture.note, { unsupported: fixture.unsupported ?? [] });
    }

    /* ---- 8. the assertions (§12, §23) ---- */
    const { assertions, refused, uncovered } = assertionsFor({ effects, fixture, fields });

    /* ---- 9. §27 locators, only where the dictionary supports one ---- */
    const countable = await countableAssertions({
      assertions,
      markerField: fixture.marker_field,
      hasField: async (t, f) => {
        const map = await fieldsOf(schemaFor, t);
        return Boolean(map && map.has(f));
      },
    });

    timings.derive_ms = now() - started;

    /* ---- 10. the contract, validated before anything is written (§45) ---- */
    const lintResult = typeof lint === 'function' ? await safely(() => lint(artifact)) : null;
    const contract = buildContract({
      artifact, trigger, satisfaction, effects, fixture, assertions,
      refused, uncovered, timeout_ms: timeoutMs, lint: lintResult,
    });
    const check = validateContract(contract);
    out = { ...out, contract, lint: lintResult, limitations: limitationsOf(contract, check.coverage) };
    if (!check.ok) {
      return blocked(out, check.block ?? BLOCKS.CONTRACT_INVALID,
        `The test contract is not executable: ${check.problems.filter((p) => p.fatal !== false).map((p) => p.message).join(' ')}`,
        { problems: check.problems });
    }
    emit({ type: 'test_contract', taskId, contract, coverage: check.coverage });

    if (cancelled()) return cancelledResult(out, owned, 'The test was cancelled before anything was created.');

    /* ---- 11. the plan, proposed deterministically and validated as any other ---- */
    const built = buildTestPlan({ contract, flow, timeoutMs, countable });
    const planned = await generate({
      goal: built.plan.goal,
      propose: () => built.plan,
      signal,
    });
    if (!planned.ok) {
      return blocked(out, BLOCKS.PLAN_REFUSED,
        `The plan this test would run was refused before anything was created: `
        + `${(planned.fatal ?? []).map((p) => p.message).join(' ') || planned.note || planned.reason}`,
        { problems: planned.fatal ?? [] });
    }

    const saved = planApi.save(taskId, planned.plan);
    if (!saved.ok) {
      return blocked(out, BLOCKS.PLAN_REFUSED, `The test plan could not be stored: ${saved.error}`);
    }
    planApi.setState(taskId, 'ready');
    const review = planApi.review(planned.plan, { fingerprint: saved.fingerprint, discovered: planned.discovered });
    out = { ...out, plan: { taskId, fingerprint: saved.fingerprint, steps: planned.plan.steps.length } };
    emit({ type: 'test_plan_ready', taskId, fingerprint: saved.fingerprint, review });

    /* ---- 12. approval — the existing engine, never a NowTest one (§31) ---- */
    if (review.approvalRequired) {
      if (autoApprove) {
        planApi.setState(taskId, 'awaiting_review');
        planApi.setState(taskId, 'awaiting_approval');
        const bound = planApi.approve(taskId, saved.fingerprint, { source: 'auto_approve' });
        if (!bound.ok) {
          return blocked(out, BLOCKS.APPROVAL_REFUSED, `The test plan could not be approved: ${bound.reason}`);
        }
      } else {
        if (typeof approve !== 'function') {
          return blocked(out, BLOCKS.APPROVAL_REFUSED,
            'This test needs approval to create a record, and no approval channel was available to ask through.');
        }
        planApi.setState(taskId, 'awaiting_review');
        planApi.setState(taskId, 'awaiting_approval');
        const decision = await approve({ taskId, fingerprint: saved.fingerprint, review, signal });
        if (decision?.source === 'cancelled' || cancelled()) {
          planApi.setState(taskId, 'cancelled');
          return cancelledResult(out, owned, 'The test was cancelled while waiting for approval. Nothing was created.');
        }
        if (!decision?.approved) {
          planApi.setState(taskId, 'failed', { failure_reason: 'the test was not approved' });
          return blocked(out, BLOCKS.APPROVAL_REFUSED,
            decision?.source === 'timeout'
              ? 'The approval for this test expired unanswered. Nothing was created.'
              : 'The test was not approved. Nothing was created.');
        }
        const bound = planApi.approve(taskId, saved.fingerprint, { source: decision.source, at: decision.at });
        if (!bound.ok) {
          return blocked(out, BLOCKS.APPROVAL_REFUSED,
            bound.reason === 'fingerprint_mismatch'
              ? 'The test plan changed after it was shown, so the approval does not apply to it. Nothing was created.'
              : `The test plan could not be approved (${bound.reason}).`);
        }
      }
    } else {
      /* A test that needs no approval is a test that creates nothing, which
       * should be impossible. Refuse rather than proceed under an assumption. */
      return blocked(out, BLOCKS.CONTRACT_INVALID,
        'The test plan was assessed as needing no approval, which would mean it creates nothing. It was not run.');
    }

    /* ---- 13. run it ---- */
    emit({ type: 'test_started', taskId, flow, fixture: { table: contract.fixture.table, marker: contract.fixture.marker } });
    const t0 = now();
    /*
     * `autoApprove` is forwarded exactly as `routes/plan.js` forwards it to the
     * ordinary plan route's `executePlan`. With it off, the executor raises its
     * own per-step card for each mutation on top of the plan-level card above —
     * which is the behaviour every other plan in this build already has, and
     * making testing the exception would be quietly weakening the gate for the
     * one operation that writes to prove something.
     */
    const outcome = await run({ taskId, sessionId, emit, signal, autoApprove });
    timings.execution_ms = now() - t0;

    /* ---- 14. read the DURABLE record of what happened ---- */
    const after = planApi.load(taskId);
    const steps = after?.steps ?? [];
    const byId = new Map(steps.map((s) => [s.id, s]));

    const createStep = byId.get(STEP_IDS.CREATE) ?? null;
    const createdRecord = createStep?.state === 'completed' ? createStep.result ?? null : null;
    const fixtureSysId = createdRecord ? String(cellValue(createdRecord.sys_id) ?? '') : null;
    if (fixtureSysId) owned.claim({ table: contract.fixture.table, sys_id: fixtureSysId, marker: contract.fixture.marker });

    const fixtureState = {
      created: Boolean(fixtureSysId),
      sys_id: fixtureSysId,
      table: contract.fixture.table,
      marker: contract.fixture.marker,
      marker_field: contract.fixture.marker_field,
      data: contract.fixture.data,
      error: createStep && createStep.state !== 'completed'
        ? createStep.failureReason ?? 'the create step did not complete'
        : null,
      /* §33/§34 — a create whose outcome is genuinely unknown must not be
       * retried or assumed. `isFailedWrite` already ran inside the executor; a
       * step that neither completed nor failed cleanly is reported as unknown. */
      outcome_unknown: Boolean(createStep && !['completed', 'failed', 'cancelled'].includes(createStep.state)),
    };

    const waitStep = byId.get(STEP_IDS.WAIT) ?? null;
    const execution = waitStep?.state === 'completed' ? waitStep.result ?? null : null;

    const readStep = byId.get(STEP_IDS.READ) ?? null;
    const journalStep = byId.get(STEP_IDS.JOURNAL) ?? null;

    const evidence = {
      created: createdRecord ? { value: createdRecord, source: sourceOf(createStep, contract.fixture.table, fixtureSysId) } : null,
      after: readStep?.state === 'completed'
        ? { value: readStep.result ?? null, source: sourceOf(readStep, contract.fixture.table, fixtureSysId) }
        : null,
      journal: journalStep?.state === 'completed'
        ? { value: journalStep.result ?? null, source: sourceOf(journalStep, contract.fixture.table, fixtureSysId) }
        : null,
      counts: new Map(),
    };
    built.countOrder.forEach((assertionId, i) => {
      const s = byId.get(`${STEP_IDS.COUNT}_${i + 1}`);
      if (s?.state === 'completed') {
        evidence.counts.set(assertionId, { value: s.result ?? [], source: sourceOf(s, s.inputs?.table ?? null, null) });
      }
    });

    /* ---- 15. did the record actually satisfy the trigger? (§45, §56) ---- */
    const triggerCheck = evidence.created
      ? verifyTriggerSatisfied({
        trigger, satisfaction, record: evidence.created.value,
        readField: (r, f) => cellValue(r?.[f]),
      })
      : null;

    /*
     * §65 — the phases, measured separately.
     *
     * `execution_ms` is the whole executor call, which includes the create, the
     * bounded wait, the read-backs and the plan's own cleanup step; the wait
     * dominates it and the step rows carry the breakdown. `setup_ms` is pulled
     * out of the create step itself where the executor recorded both ends,
     * because "how long does it take to make a fixture" and "how long does the
     * flow take" are separate questions and averaging them answers neither.
     */
    timings.setup_ms = spanOf(createStep);
    timings.wait_ms = spanOf(waitStep);
    timings.read_ms = spanOf(readStep);

    /* ---- 16. decide every assertion, deterministically ---- */
    const assertStarted = now();
    const decided = evaluate(assertions, evidence);
    /* §28 — reported, never a verdict. */
    const unexpected = unexpectedEffects({
      created: evidence.created,
      after: evidence.after,
      promised: (effects.required ?? []).map((e) => e.field).filter(Boolean),
      derived: (satisfaction.derived ?? []).map((d) => d.field),
    });
    timings.assert_ms = now() - assertStarted;

    /* ---- 17. cleanup: the step, then the guarantee ---- */
    const cleanupStep = byId.get(STEP_IDS.CLEANUP) ?? null;
    if (cleanupStep?.state === 'completed' && fixtureSysId) {
      owned.settle({ sys_id: fixtureSysId, deleted: true });
    }

    const wasCancelled = outcome?.reason === 'cancelled' || cancelled();
    const cleanupStarted = now();
    const cleanup = await ensureCleanup({
      owned, run, generate, planApi, newTaskId, sessionId, emit, autoApprove, approve,
      /* Cancellation must not stop cleanup, so the signal is deliberately not
       * forwarded: §32 says the mutation-boundary rules stay authoritative and
       * a cancelled run still tidies up after itself. */
      alreadyDone: cleanupStep?.state === 'completed',
    });
    /*
     * TWO cleanup numbers, because there are two cleanup paths and reporting
     * only the second would make cleanup look free. `delete_ms` is the plan's
     * own delete step, which is where cleanup happens on every ordinary run and
     * is already inside `execution_ms`. `cleanup_ms` is the `finally`
     * guarantee, which does no work at all when the step already succeeded.
     */
    timings.delete_ms = spanOf(cleanupStep);
    timings.cleanup_ms = now() - cleanupStarted;
    timings.total_ms = now() - started;

    /*
     * §4 - CANCELLATION IS A PARAMETER OF THE ARITHMETIC, NOT A SECOND COPY OF IT.
     *
     * FOUND BY REVIEW. This branch used to hand-build the cancelled result, and
     * the hand-built object was wrong in two ways that only showed up together:
     * it reported `passed: 0` beside assertion rows that really had passed, and
     * it dropped CLEANUP_FAILED from a run that had left a record on the
     * instance - the one thing §36 says may never go unsaid. `decideResult`
     * already ranks cancellation above every other answer and already classifies
     * a cleanup that did not happen, so duplicating it here made that code dead
     * as well as wrong.
     */
    const verdict = decideResult({
      contract,
      coverage: check.coverage,
      fixture: fixtureState,
      triggerCheck,
      execution,
      assertions: decided,
      cleanup,
      cancelled: wasCancelled,
      unexpected,
    });
    if (wasCancelled) {
      /* How far it got is the first thing a person wants to know. */
      verdict.statement = `The test was cancelled after ${steps.filter((s) => s.state === 'completed').length} step(s). `
        + 'What ran is reported; nothing beyond it is claimed.';
    }

    const result = {
      ...out,
      status: verdict.status,
      assertion_verdict: verdict.assertion_verdict,
      statement: verdict.statement,
      failures: verdict.failures,
      counts: verdict.counts,
      mode: MODES.DISPOSABLE,
      flow,
      fixture: fixtureState,
      trigger_check: triggerCheck,
      execution: projectExecution(execution),
      assertions: decided,
      unexpected_effects: unexpected,
      cleanup,
      plan: { taskId, fingerprint: saved.fingerprint, steps: steps.map(projectStep), outcome: outcome?.reason ?? 'ok' },
      coverage: check.coverage,
      contract,
      timings,
      /* §40 — the continuation, offered rather than launched. */
      doctor: doctorHandoff({ verdict, flow, fixtureState, execution }),
    };

    if (typeof record === 'function') record(taskId, result);
    /*
     * NOT `test_complete`. That frame is TERMINAL and belongs to the route,
     * which emits exactly one of it or `plan_failed` — the invariant every
     * stream in this build honours. A domain that also emitted it would put two
     * terminal frames on one stream, and a client counting them would be right
     * to be confused. This one says the verdict is decided; the route says the
     * stream is over.
     */
    emit({ type: 'test_decided', taskId, status: result.status });
    return result;
  } catch (err) {
    /*
     * Anything unforeseen. The fixture may exist, so cleanup still runs, and
     * the run reports BLOCKED with the error rather than a verdict it did not
     * earn.
     */
    const cleanup = await ensureCleanup({
      owned, run, generate, planApi, newTaskId, sessionId, emit, autoApprove, approve, alreadyDone: false,
    }).catch((e) => ({ status: CLEANUP.UNKNOWN, records_created: owned.size, records_deleted: 0, records: owned.all(), note: e.message }));
    timings.total_ms = now() - started;
    const result = {
      ...out,
      status: RESULTS.BLOCKED,
      statement: `The test could not be completed: ${err.message}`,
      /* A run that died still has to say whether it left something behind. */
      failures: [CLEANUP.PASS, CLEANUP.NOT_NEEDED].includes(cleanup?.status) ? [] : [FAILURES.CLEANUP_FAILED],
      cleanup,
      timings,
      stopped: { reason: 'error', note: err.message },
    };
    if (typeof record === 'function') record(taskId, result);
    emit({ type: 'test_decided', taskId, status: result.status });
    return result;
  }
}

/* ------------------------------------------------------------------ *
 * §17 / §18 / §36 — the cleanup guarantee
 * ------------------------------------------------------------------ */

/**
 * Delete anything this run created that is still there.
 *
 * ONLY WHAT THIS RUN CREATED. The ledger holds sys_ids observed coming back
 * from a create in this run; nothing else is ever deleted, and there is no
 * query by marker anywhere in this file. §18 and §70.13 are the same rule seen
 * from two sides, and this is where it is kept.
 */
export async function ensureCleanup({
  owned, run, generate, planApi, newTaskId, sessionId, emit = () => {},
  autoApprove = false, approve = null, alreadyDone = false,
}) {
  const created = owned.size;
  const outstanding = owned.outstanding();

  if (!created) {
    return { status: CLEANUP.NOT_NEEDED, records_created: 0, records_deleted: 0, records: [], note: 'Nothing was created.' };
  }
  if (!outstanding.length) {
    return {
      status: CLEANUP.PASS,
      records_created: created,
      records_deleted: created,
      records: owned.all(),
      note: alreadyDone ? 'Removed by the test plan\'s own cleanup step.' : 'Removed.',
    };
  }
  if (typeof newTaskId !== 'function') {
    return {
      status: CLEANUP.FAILED,
      records_created: created,
      records_deleted: created - outstanding.length,
      records: owned.all(),
      note: `${outstanding.length} test record(s) remain and no second plan could be created to remove them: `
        + outstanding.map((r) => `${r.table} ${r.sys_id}`).join(', '),
    };
  }

  for (const row of outstanding) {
    const id = newTaskId();
    try {
      emit({ type: 'test_cleanup_started', taskId: id, table: row.table, sys_id: row.sys_id });
      const built = cleanupPlan({ table: row.table, sysId: row.sys_id, marker: row.marker });
      const planned = await generate({ goal: built.goal, propose: () => built });
      if (!planned.ok) {
        owned.settle({ sys_id: row.sys_id, deleted: false, note: `cleanup plan refused: ${planned.reason}` });
        continue;
      }
      const saved = planApi.save(id, planned.plan);
      if (!saved.ok) {
        owned.settle({ sys_id: row.sys_id, deleted: false, note: `cleanup plan not stored: ${saved.error}` });
        continue;
      }
      planApi.setState(id, 'ready');
      planApi.setState(id, 'awaiting_review');
      planApi.setState(id, 'awaiting_approval');

      let decision = { approved: autoApprove, source: 'auto_approve' };
      if (!autoApprove) {
        if (typeof approve !== 'function') {
          owned.settle({ sys_id: row.sys_id, deleted: false, note: 'no approval channel was available to authorise the cleanup' });
          continue;
        }
        const review = planApi.review(planned.plan, { fingerprint: saved.fingerprint, discovered: planned.discovered });
        decision = await approve({ taskId: id, fingerprint: saved.fingerprint, review, cleanup: true });
      }
      if (!decision?.approved) {
        owned.settle({ sys_id: row.sys_id, deleted: false, note: 'the cleanup was not approved' });
        continue;
      }
      const bound = planApi.approve(id, saved.fingerprint, { source: decision.source ?? 'auto_approve', at: decision.at });
      if (!bound.ok) {
        owned.settle({ sys_id: row.sys_id, deleted: false, note: `cleanup approval refused: ${bound.reason}` });
        continue;
      }
      const outcome = await run({ taskId: id, sessionId, emit, autoApprove });
      owned.settle({
        sys_id: row.sys_id,
        deleted: Boolean(outcome?.ok),
        note: outcome?.ok ? null : outcome?.note ?? outcome?.reason ?? 'the delete did not complete',
      });
    } catch (err) {
      owned.settle({ sys_id: row.sys_id, deleted: false, note: err.message });
    }
  }

  const left = owned.outstanding();
  const refused = owned.all().filter((r) => !r.deleted && /not approved|no approval channel/i.test(r.note ?? ''));
  return {
    status: left.length ? (refused.length === left.length ? CLEANUP.REFUSED : CLEANUP.FAILED) : CLEANUP.PASS,
    records_created: created,
    records_deleted: created - left.length,
    records: owned.all(),
    note: left.length
      ? `${left.length} test record(s) are still on the instance: `
        + left.map((r) => `${r.table} ${r.sys_id}${r.note ? ` (${r.note})` : ''}`).join(', ')
      : 'Every record this test created was deleted and the delete was verified.',
  };
}

/* ------------------------------------------------------------------ *
 * Projections
 * ------------------------------------------------------------------ */

function blocked(partial, block, note, extra = {}) {
  return {
    ...partial,
    status: RESULTS.BLOCKED,
    statement: note,
    stopped: { reason: block, note, ...extra },
    failures: [],
    cleanup: { status: CLEANUP.NOT_NEEDED, records_created: 0, records_deleted: 0, records: [], note: 'Nothing was created.' },
  };
}

function cancelledResult(partial, owned, note) {
  return {
    ...partial,
    status: RESULTS.CANCELLED,
    statement: note,
    stopped: { reason: 'cancelled', note },
    cleanup: owned.size
      ? { status: CLEANUP.UNKNOWN, records_created: owned.size, records_deleted: 0, records: owned.all(), note }
      : { status: CLEANUP.NOT_NEEDED, records_created: 0, records_deleted: 0, records: [], note: 'Nothing was created.' },
  };
}

const projectArtifact = (a) => (a?.flow ? { ...a.flow, type: 'flow' } : null);

const projectExecution = (e) => (e ? {
  found: e.found,
  state: e.state,
  settled: e.settled,
  timed_out: e.timed_out,
  waited_ms: e.waited_ms,
  polls: e.polls,
  count: e.count,
  other_executions: e.other_executions ?? 0,
  executions: (e.executions ?? []).map((x) => ({
    sys_id: x.sys_id, execution_id: x.execution_id, state: x.state, raw_state: x.raw_state,
    error: x.error, started_at: x.started_at, last_updated_at: x.last_updated_at, run_time_ms: x.run_time_ms,
    flow: x.flow,
  })),
} : null);

const projectStep = (s) => ({
  id: s.id, tool: s.tool, operation: s.operation, state: s.state,
  mutating: s.mutating, failureReason: s.failureReason ?? null,
});

/**
 * How long one step took, from the durable row.
 *
 * Null rather than zero when either end is missing: a step that recorded no
 * timing did not take no time, and averaging a zero into a latency figure is
 * how a measurement becomes a lie.
 */
function spanOf(step) {
  if (!step?.startedAt || !step?.completedAt) return null;
  const from = Date.parse(String(step.startedAt).replace(' ', 'T'));
  const to = Date.parse(String(step.completedAt).replace(' ', 'T'));
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? to - from : null;
}

/** §43 — the read that answered an assertion, in the terms a person could repeat. */
const sourceOf = (step, table, sysId) => (step ? {
  step: step.id, tool: step.tool, table: table ?? step.inputs?.table ?? null,
  sys_id: sysId ?? null, at: step.completedAt ?? null,
} : null);

/**
 * §40 — the continuation, and why it is only a continuation.
 *
 * Doctor is not launched. A failing test establishes THAT an expected effect is
 * missing, which §62 is emphatic is not the same as establishing why — and
 * starting an investigation automatically would blur exactly that line, as well
 * as spending a model call nobody asked for.
 */
function doctorHandoff({ verdict, flow, fixtureState, execution }) {
  if (verdict.status !== RESULTS.FAIL) return null;
  return {
    available: true,
    /* The fixture is deleted by the time anyone clicks this, so the request is
     * framed around the FLOW and the execution, which outlive it. */
    request: `Why did the flow "${flow.name}" not produce its expected effect when it ran`
      + `${execution?.executions?.[0]?.sys_id ? ` (execution ${execution.executions[0].sys_id})` : ''}?`,
    established: 'An expected effect was observed to be missing. Nothing about its cause is established.',
    execution_sys_id: execution?.executions?.[0]?.sys_id ?? null,
    fixture_sys_id: fixtureState?.sys_id ?? null,
  };
}

function limitationsOf(contract, coverage) {
  const out = [];
  for (const e of contract.conditional_effects ?? []) {
    out.push(`${e.statement} — this sits inside a branch, so it is not required of every run and is not asserted.`);
  }
  /*
   * ALWAYS, including on a PASS. `coverageOf` explains why an unobservable
   * action does not bar a PASS; this is the other half of that decision, and
   * without it the omission would be silent — which is the thing §13 actually
   * forbids.
   */
  for (const e of contract.unobservable_effects ?? []) {
    out.push(`${e.statement}`);
  }
  for (const r of contract.refused_assertions ?? []) {
    out.push(`No assertion was written for ${r.field}: ${r.reason}`);
  }
  if (coverage && !coverage.complete && coverage.required) {
    out.push(coverage.note);
  }
  return out;
}

async function fieldsOf(schemaFor, table) {
  if (typeof schemaFor !== 'function') return null;
  try {
    const schema = await schemaFor(table);
    const list = schema?.fields ?? [];
    /*
     * AN EMPTY DICTIONARY IS NOT AN EMPTY TABLE — the Phase 16 finding, and it
     * matters more here. `getSchema` on a table this instance does not have
     * returns zero fields without throwing, and a zero-field map would make
     * every trigger term look like a field that does not exist.
     */
    return list.length ? new Map(list.map((f) => [f.name, f])) : null;
  } catch {
    return null;
  }
}

async function safely(fn) {
  try { return await fn(); } catch { return null; }
}
