/**
 * PHASE 17 — THE VOCABULARY NowTest IS ALLOWED TO SPEAK.
 *
 * Every word a test result can contain is enumerated here, for the reason
 * Phase 16 enumerated the lint vocabulary: a result that can say anything can
 * say something nobody defined, and nothing downstream can then check it.
 *
 * THE DISTINCTION THE WHOLE PHASE RESTS ON is between the five outcomes below.
 * Four of them are easy to tell apart. The fifth, INCONCLUSIVE, is the one that
 * makes the other four mean anything: without it, "the flow was still running
 * when the clock ran out" has to be recorded as either a pass or a failure, and
 * both are lies. §70 makes each of those lies a release blocker.
 *
 * NOTHING HERE DECIDES ANYTHING. These are names. The arithmetic that picks
 * between them is in `result.js` and reads only assertion outcomes, execution
 * state and cleanup state — never a model, and never a tool's own report of
 * its success.
 */

/* ------------------------------------------------------------------ *
 * §4 — the five results
 * ------------------------------------------------------------------ */

export const RESULTS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  INCONCLUSIVE: 'INCONCLUSIVE',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
});

export const RESULT_LIST = Object.freeze(Object.values(RESULTS));

/**
 * What each one asserts, in the words the report uses. Kept beside the names so
 * a reader of the code and a reader of the output are told the same thing.
 */
export const RESULT_MEANING = Object.freeze({
  [RESULTS.PASS]: 'Every required assertion passed against a real read-back of the instance.',
  [RESULTS.FAIL]: 'The test ran far enough to establish that an expected effect did not occur, or that the wrong effect did.',
  [RESULTS.INCONCLUSIVE]: 'The test could not establish whether the expected effect occurred. No claim is made either way.',
  [RESULTS.BLOCKED]: 'Policy, capability, authorisation or fixture constraints prevented the test from running.',
  [RESULTS.CANCELLED]: 'The test was cancelled. What ran is reported; nothing beyond it is claimed.',
});

/* ------------------------------------------------------------------ *
 * §42 — which layer failed
 * ------------------------------------------------------------------ */

/**
 * A failure names the layer it happened in.
 *
 * §42 is explicit that "TEST FAILED" is not an acceptable answer, and the
 * reason is practical rather than stylistic: the next action differs completely
 * between "the fixture could not be created" and "the flow ran and did not do
 * what it promised". Only the second is evidence about the flow.
 */
export const FAILURES = Object.freeze({
  FIXTURE_SETUP_FAILED: 'FIXTURE_SETUP_FAILED',
  TRIGGER_NOT_SATISFIED: 'TRIGGER_NOT_SATISFIED',
  FLOW_NOT_EXECUTED: 'FLOW_NOT_EXECUTED',
  FLOW_EXECUTION_ERROR: 'FLOW_EXECUTION_ERROR',
  EXPECTED_EFFECT_MISSING: 'EXPECTED_EFFECT_MISSING',
  EXPECTED_EFFECT_WRONG: 'EXPECTED_EFFECT_WRONG',
  UNEXPECTED_EFFECT: 'UNEXPECTED_EFFECT',
  ASSERTION_UNAVAILABLE: 'ASSERTION_UNAVAILABLE',
  CLEANUP_FAILED: 'CLEANUP_FAILED',
  TIMEOUT: 'TIMEOUT',
});

export const FAILURE_LIST = Object.freeze(Object.values(FAILURES));

/* ------------------------------------------------------------------ *
 * Why a test was blocked before it ran
 * ------------------------------------------------------------------ */

export const BLOCKS = Object.freeze({
  FLOW_NOT_IDENTIFIED: 'FLOW_NOT_IDENTIFIED',
  FLOW_AMBIGUOUS: 'FLOW_AMBIGUOUS',
  FLOW_INACTIVE: 'FLOW_INACTIVE',
  TRIGGER_UNREADABLE: 'TRIGGER_UNREADABLE',
  TRIGGER_UNSUPPORTED: 'TRIGGER_UNSUPPORTED',
  FIXTURE_TABLE_NOT_DISPOSABLE: 'FIXTURE_TABLE_NOT_DISPOSABLE',
  FIXTURE_UNSATISFIABLE: 'FIXTURE_UNSATISFIABLE',
  NO_MARKER_FIELD: 'NO_MARKER_FIELD',
  NO_OBSERVABLE_EFFECT: 'NO_OBSERVABLE_EFFECT',
  CONTRACT_INVALID: 'CONTRACT_INVALID',
  PLAN_REFUSED: 'PLAN_REFUSED',
  APPROVAL_REFUSED: 'APPROVAL_REFUSED',
  USER_FIXTURE_MODE: 'USER_FIXTURE_MODE',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  FIXTURE_OUTCOME_UNKNOWN: 'FIXTURE_OUTCOME_UNKNOWN',
});

/* ------------------------------------------------------------------ *
 * §23 — the assertion kinds, and no more of them
 * ------------------------------------------------------------------ */

/**
 * §23 says: implement only the assertion types actually needed, and do not
 * build an expression language. These nine are the ones the effects derived
 * from a live flow artifact can produce, and each one is a comparison a person
 * could perform by hand against the same read-back.
 */
export const ASSERTIONS = Object.freeze({
  EQUALS: 'equals',
  NOT_EQUALS: 'not_equals',
  EXISTS: 'exists',
  NOT_EXISTS: 'not_exists',
  CONTAINS: 'contains',
  CHANGED: 'changed',
  RECORD_COUNT: 'record_count',
  REFERENCE_IDENTITY: 'reference_identity',
  JOURNAL_ADDED: 'journal_added',
});

export const ASSERTION_LIST = Object.freeze(Object.values(ASSERTIONS));

/** An assertion's outcome. UNAVAILABLE is not a failure — see §13 and §46. */
export const ASSERTION_STATES = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  UNAVAILABLE: 'UNAVAILABLE',
});

/* ------------------------------------------------------------------ *
 * §10/§11 — the kinds of effect an artifact can promise
 * ------------------------------------------------------------------ */

export const EFFECT_KINDS = Object.freeze({
  FIELD: 'field',
  JOURNAL: 'journal',
  REFERENCE: 'reference',
  CREATED_RECORD: 'created_record',
  /* Read off the artifact, and honestly not checkable from outside. It still
   * appears in the contract: an effect nobody can observe is a limitation of
   * the test, and hiding it would let a partial test report a clean pass. */
  UNOBSERVABLE: 'unobservable',
});

/* ------------------------------------------------------------------ *
 * §3 — the two modes
 * ------------------------------------------------------------------ */

export const MODES = Object.freeze({
  DISPOSABLE: 'disposable_fixture',
  USER_FIXTURE: 'user_fixture',
});

/* ------------------------------------------------------------------ *
 * §36 — cleanup is part of the result, never a footnote
 * ------------------------------------------------------------------ */

export const CLEANUP = Object.freeze({
  NOT_NEEDED: 'NOT_NEEDED',
  PASS: 'PASS',
  FAILED: 'FAILED',
  REFUSED: 'REFUSED',
  UNKNOWN: 'UNKNOWN',
});

/**
 * The shape every run returns, including the ones that stopped early.
 *
 * A stopped run returns this same object rather than something smaller, for the
 * reason Phase 14's diagnosis does: a caller counting results across runs
 * should not have to distinguish "the key is missing" from "there were none",
 * and an empty array says the second where an absent key says neither.
 */
export function emptyResult({ mode = MODES.DISPOSABLE } = {}) {
  return {
    status: null,
    mode,
    artifact: null,
    contract: null,
    fixture: null,
    execution: null,
    assertions: [],
    unexpected_effects: [],
    cleanup: { status: CLEANUP.NOT_NEEDED, records_created: 0, records_deleted: 0, records: [], note: null },
    failures: [],
    evidence: [],
    limitations: [],
    lint: null,
    stopped: null,
    timings: {},
  };
}
