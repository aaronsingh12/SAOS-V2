/**
 * PHASE 17 — NowTest, the public surface.
 *
 * §68 asks that NowTest own no ServiceNow client, no approval, no execution, no
 * verification, no recovery, no evidence persistence and no redaction. The
 * check is mechanical rather than aspirational: this directory's ONLY imports
 * outside itself are `../lint/rules.js` (one parser, reused rather than copied)
 * and `../lint/intent.js` (one resolver, reused for the same reason). There is
 * no import of `servicenow/`, of `memory/`, of a provider, or of the executor
 * anywhere under `agent/test/`, so every one of those capabilities reaches this
 * domain as an injected function or does not reach it at all.
 *
 * A test is therefore composition, and `runner.js` is where the composing
 * happens. Everything else here is a pure function over data that was read from
 * the instance.
 */
export { testFlow, ensureCleanup } from './runner.js';
export { renderTest } from './render.js';
export {
  RESULTS, RESULT_LIST, RESULT_MEANING, FAILURES, FAILURE_LIST, BLOCKS,
  ASSERTIONS, ASSERTION_LIST, ASSERTION_STATES, EFFECT_KINDS, MODES, CLEANUP,
  emptyResult,
} from './schemas.js';
export {
  parseEncodedQuery, triggerOf, satisfyCondition, verifyTriggerSatisfied,
  triggerContract, FIREABLE_BY_INSERT,
} from './trigger.js';
export { effectsOf, requiredEffects, isUnconditional } from './effects.js';
export {
  DISPOSABLE_TABLES, DISPOSABLE_LIST, isDisposable, markerFor, readMarker,
  chooseMarkerField, buildFixture, ownership, validateExtraFields,
} from './fixture.js';
export {
  assertionsFor, evaluate, tally, selfWritten, cellValue, cellDisplay, unexpectedEffects,
} from './assertions.js';
export { buildContract, validateContract, coverageOf } from './contract.js';
export {
  buildTestPlan, cleanupPlan, countableAssertions, STEP_IDS,
  DEFAULT_TEST_TIMEOUT_MS, DEFAULT_POLL_MS,
} from './planner.js';
export { decideResult, readable, EXECUTION_STATE_NAMES } from './result.js';
export { readTestIntent, detectUserFixture, userFixtureRefusal } from './intent.js';
