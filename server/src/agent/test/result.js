/**
 * PHASE 17 — THE ARITHMETIC THAT PICKS ONE OF FIVE WORDS.
 *
 * Nothing in this file reads a model, a prose summary, or a tool's own report
 * of its success. It reads four things — whether the fixture was created,
 * whether the trigger was actually satisfied, what state the execution reached,
 * and how each assertion compared — and returns one of the five §4 results.
 *
 * ORDER MATTERS AND IS THE POINT. The checks below run in the order a person
 * would have to run them to be honest, because each earlier answer changes what
 * a later one is evidence OF:
 *
 *   1. was it cancelled            nothing after this is a verdict
 *   2. did the fixture exist       no fixture, no test
 *   3. did the trigger match       an unmatched trigger means the flow was
 *                                  never going to run, so the flow is not what
 *                                  the assertions measured
 *   4. did anything run            absence within a window is not proof of
 *                                  absence, so it is INCONCLUSIVE, never FAIL
 *   5. did it finish               still running at the deadline is §22's
 *                                  INCONCLUSIVE, and §70.8 makes it a blocker
 *                                  to call it a failure
 *   6. did it error                a definite execution failure IS evidence
 *   7. what did the assertions say
 *   8. was every promise checked   an unchecked promise cannot reach PASS
 *   9. did cleanup work            §36, and never silently
 *
 * THE TWO RULES THIS EXISTS TO MAKE UNBREAKABLE:
 *
 *   A PASS REQUIRES REAL READ-BACK. `PASS` is returned only when at least one
 *   assertion passed and every assertion passed and every promised effect was
 *   covered and the execution settled. An empty assertion list can never be
 *   PASS — vacuous truth is the easiest way to report success for nothing.
 *
 *   A TIMEOUT IS NEITHER. §70.7 and §70.8 are two halves of one blocker, and
 *   the only way to satisfy both is a third answer.
 */
import {
  RESULTS, FAILURES, ASSERTION_STATES, ASSERTIONS, CLEANUP,
} from './schemas.js';
import { tally } from './assertions.js';

/* Execution states, as `diagnostics.js` classifies them. Named here rather than
 * imported so this module has no dependency on the ServiceNow layer at all. */
const EXECUTION = Object.freeze({
  COMPLETE: 'EXECUTION_COMPLETE',
  ERROR: 'EXECUTION_ERROR',
  CANCELLED: 'EXECUTION_CANCELLED',
  INTERRUPTED: 'EXECUTION_INTERRUPTED',
  NONE: 'NO_EXECUTION_FOUND',
});

/**
 * Decide the result.
 *
 * @param contract    from `buildContract`
 * @param coverage    from `coverageOf`
 * @param fixture     { created, sys_id, table, error }
 * @param triggerCheck from `verifyTriggerSatisfied`, or null when not checked
 * @param execution   the wait step's result, or null when it never ran
 * @param assertions  evaluated
 * @param cleanup     { status, ... }
 * @param cancelled   whether the run was cancelled
 */
export function decideResult({
  contract, coverage, fixture, triggerCheck = null, execution = null,
  assertions = [], cleanup = { status: CLEANUP.NOT_NEEDED }, cancelled = false,
  unexpected = [],
}) {
  const counts = tally(assertions);
  const failures = [];
  let status = null;
  let statement = null;

  /* ---- 1. cancellation ---- */
  if (cancelled) {
    status = RESULTS.CANCELLED;
    statement = 'The test was cancelled. What had already been read is reported; nothing beyond it is claimed.';
  }

  /* ---- 2. the fixture ---- */
  if (!status && !fixture?.created) {
    failures.push(FAILURES.FIXTURE_SETUP_FAILED);
    status = RESULTS.BLOCKED;
    statement = fixture?.error
      ? `The test record could not be created, so the flow was never triggered: ${fixture.error}`
      : 'The test record could not be created, so the flow was never triggered.';
  }

  /* ---- 3. did the record actually match the trigger? ---- */
  if (!status && triggerCheck && !triggerCheck.satisfied) {
    failures.push(FAILURES.TRIGGER_NOT_SATISFIED);
    status = RESULTS.INCONCLUSIVE;
    statement = `${triggerCheck.note} Nothing is claimed about what this flow does, because it was never asked to do it.`;
  }

  /* ---- 4/5. did anything run, and did it finish? ---- */
  const state = execution?.state ?? null;
  const settled = Boolean(execution?.settled);
  if (!status && execution) {
    if (!execution.found) {
      failures.push(FAILURES.FLOW_NOT_EXECUTED);
      status = RESULTS.INCONCLUSIVE;
      statement = `No execution of this flow was recorded against the test record within `
        + `${Math.round((execution.waited_ms ?? 0) / 1000)}s. An execution that has not been recorded is not `
        + 'proof that the flow will never run, so no claim is made about it.';
    } else if (!settled) {
      failures.push(FAILURES.TIMEOUT);
      status = RESULTS.INCONCLUSIVE;
      statement = `The flow was triggered, but its execution was still ${readable(state)} when the test's `
        + `${Math.round((execution.timeout_ms ?? execution.waited_ms ?? 0) / 1000)}s timeout expired. `
        + 'No claim is made about whether the expected effect would eventually occur.';
    } else if (state !== EXECUTION.COMPLETE && state !== EXECUTION.ERROR) {
      /*
       * SETTLED IS NOT THE SAME AS FINISHED, and conflating them produced a
       * PASS for a flow that never ran to the end.
       *
       * FOUND BY REVIEW, and it reproduced exactly: `TERMINAL_EXECUTION`
       * includes CANCELLED and PRESUMED_INTERRUPTED because the poller must stop
       * looking at them - there is nothing more to wait for. But "stop waiting"
       * and "the flow did its job" are different claims, and the arithmetic
       * below treated a cancelled execution exactly like a completed one: every
       * assertion happened to pass, coverage was complete, and the run reported
       * PASS about a flow somebody had stopped half way.
       *
       * ERROR keeps its own branch because it IS a definite outcome - the flow
       * ran and failed, which §21 says is normally a FAIL. Cancelled and
       * presumed-interrupted are neither: the flow was stopped from outside, so
       * nothing about its behaviour is established in either direction.
       */
      failures.push(FAILURES.FLOW_NOT_EXECUTED);
      status = RESULTS.INCONCLUSIVE;
      statement = `The flow was triggered, but its execution ended as ${readable(state)} rather than completing, `
        + 'so it never ran to the end. Nothing is claimed about what it would have done.';
    }
  } else if (!status && !execution) {
    failures.push(FAILURES.FLOW_NOT_EXECUTED);
    status = RESULTS.INCONCLUSIVE;
    statement = 'The execution history was never read, so nothing is known about whether the flow ran.';
  }

  /* ---- 6. a definite execution failure ----
   *
   * ERROR only. An execution that was cancelled or presumed interrupted is
   * handled above as "it did not finish", because blaming the flow for being
   * stopped from outside would be exactly the unsupported claim this phase
   * exists to refuse. */
  const errored = settled && state === EXECUTION.ERROR;
  if (errored) failures.push(FAILURES.FLOW_EXECUTION_ERROR);

  /* ---- 7. the assertions ---- */
  const failed = assertions.filter((a) => a.status === ASSERTION_STATES.FAIL);
  for (const a of failed) failures.push(classifyAssertion(a));

  if (!status) {
    if (failed.length) {
      status = RESULTS.FAIL;
      statement = errored
        ? `The flow executed and ERRORED, and ${failed.length} of ${counts.total} expected effect(s) did not occur.`
        : `The flow executed, and ${failed.length} of ${counts.total} expected effect(s) did not occur as promised.`;
    } else if (counts.unavailable > 0) {
      failures.push(FAILURES.ASSERTION_UNAVAILABLE);
      status = RESULTS.INCONCLUSIVE;
      statement = `${counts.unavailable} of ${counts.total} check(s) had no evidence to decide them, so this run `
        + 'does not establish that the flow behaved correctly.';
    } else if (!counts.total) {
      /* Vacuously passing is the failure mode this branch exists to prevent. */
      failures.push(FAILURES.ASSERTION_UNAVAILABLE);
      status = RESULTS.INCONCLUSIVE;
      statement = 'Nothing about this flow could be checked by reading the record it was triggered by, '
        + 'so the run proves only that it ran.';
    } else if (errored) {
      /*
       * Every assertion passed and the execution still errored. §21 says a
       * failed execution is normally a FAIL, and it is right: something in the
       * flow did not complete, and what it would have gone on to do was never
       * attempted. The passing assertions are kept and reported.
       */
      status = RESULTS.FAIL;
      statement = 'Every checked effect occurred, but the flow execution itself ended in ERROR, so part of the flow '
        + 'did not run. What it would have done afterwards is not established.';
    } else if (!coverage?.complete) {
      failures.push(FAILURES.ASSERTION_UNAVAILABLE);
      status = RESULTS.INCONCLUSIVE;
      statement = `Every one of the ${counts.passed} checked effect(s) occurred, but ${uncheckedNote(coverage)} `
        + 'so this run does not establish that the whole flow behaved correctly.';
    } else {
      status = RESULTS.PASS;
      /*
       * The PASS sentence names its own limits. A reader who stops at the first
       * line must not come away believing more was checked than was: if the
       * flow does something no record read can see, the headline says so.
       */
      const unseen = coverage?.unobservable?.length ?? 0;
      statement = `All ${counts.passed} expected effect(s) were verified from ServiceNow read-back.`
        + (unseen
          ? ` ${unseen} other action(s) in this flow do something no record read can observe, and are not covered.`
          : '');
    }
  }

  /* ---- 8. §28 — unexpected effects are reported, never an automatic failure ---- */
  if (unexpected.length) failures.push(FAILURES.UNEXPECTED_EFFECT);

  /* ---- 9. §36 — cleanup ---- */
  const verdict = status;
  if (cleanup?.status === CLEANUP.FAILED || cleanup?.status === CLEANUP.REFUSED || cleanup?.status === CLEANUP.UNKNOWN) {
    failures.push(FAILURES.CLEANUP_FAILED);
    /*
     * A cleanup that did not happen never leaves a clean result standing.
     *
     * A run whose own verdict was FAIL or INCONCLUSIVE already tells a reader
     * to look, so it keeps its verdict and gains the cleanup failure beside it.
     * A run that would have reported PASS must not: PASS is the one word a
     * reader takes as "nothing needs my attention", and a test record is still
     * on the instance. Its assertion verdict is preserved on the result so the
     * finding about the FLOW is not lost — only the headline changes.
     */
    if (status === RESULTS.PASS) {
      status = RESULTS.BLOCKED;
      statement = `${statement} The test record could not be removed, so this run needs attention `
        + 'before it can be treated as clean.';
    }
  }

  return {
    status,
    assertion_verdict: verdict,
    statement,
    failures: [...new Set(failures)],
    counts,
    execution_state: state,
    execution_settled: settled,
  };
}

/** Which §42 class a failed assertion belongs to. */
function classifyAssertion(a) {
  switch (a.type) {
    case ASSERTIONS.CHANGED:
    case ASSERTIONS.EXISTS:
    case ASSERTIONS.JOURNAL_ADDED:
      return FAILURES.EXPECTED_EFFECT_MISSING;
    case ASSERTIONS.RECORD_COUNT:
      return String(a.actual) === '0' ? FAILURES.EXPECTED_EFFECT_MISSING : FAILURES.EXPECTED_EFFECT_WRONG;
    case ASSERTIONS.EQUALS:
    case ASSERTIONS.REFERENCE_IDENTITY:
      return String(a.actual ?? '').trim() === '' ? FAILURES.EXPECTED_EFFECT_MISSING : FAILURES.EXPECTED_EFFECT_WRONG;
    default:
      return FAILURES.EXPECTED_EFFECT_WRONG;
  }
}

const READABLE = Object.freeze({
  EXECUTION_WAITING: 'waiting',
  EXECUTION_RUNNING: 'still running',
  EXECUTION_PAUSED: 'paused',
  EXECUTION_COMPLETE: 'complete',
  EXECUTION_ERROR: 'in error',
  EXECUTION_CANCELLED: 'cancelled',
  EXECUTION_INTERRUPTED: 'interrupted',
  EXECUTION_UNKNOWN: 'in a state this build does not recognise',
  NO_EXECUTION_FOUND: 'absent',
});

export const readable = (state) => READABLE[state] ?? String(state ?? 'unknown');

function uncheckedNote(coverage) {
  /* Only UNCOVERED effects reach this branch — an unobservable action is a
   * stated limit rather than a coverage gap, and `coverageOf` explains why. */
  return coverage?.uncovered?.length
    ? `${coverage.uncovered.length} promised effect(s) could not be checked,`
    : 'not every promised effect was checked,';
}

export const EXECUTION_STATE_NAMES = EXECUTION;
