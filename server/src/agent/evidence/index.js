/**
 * PHASE 5 — the evidence read model.
 *
 * One question, answered from durable records alone: what actually happened
 * during this task, and how do we know?
 *
 * A READ MODEL AND NOTHING ELSE. Nothing here executes a tool, writes to
 * ServiceNow, approves a mutation, elevates a role or changes a plan, a task or
 * a verification result. It has no ServiceNow client in scope and issues no
 * statement but SELECT — the absence of the capability is the guarantee, and
 * `test/evidence.test.js` asserts it on the import graph.
 *
 * DETERMINISTIC. No model, no clock, no randomness, no in-memory agent state.
 * The same database yields the same object, which is what makes evidence
 * something you can cite rather than something you happened to see.
 *
 * IT IS NOT THE AUDIT TRAIL. The audit answers "what events occurred" across
 * everything; this answers "what happened during THIS task". They stay separate
 * — the audit tables remain the underlying historical record and are read, not
 * replaced.
 */
export { buildEvidence, SOURCE } from './builder.js';
export { STATUS, STATUSES, decideStatus, isBlockingReason } from './status.js';
export { redact, findSecrets, SECRET_KEYS, REDACTED } from './redact.js';
export {
  readTask, readSteps, readToolEvents, readMutations, readBuilds,
  readRequest, sessionExists, taskWindow,
} from './read-model.js';
