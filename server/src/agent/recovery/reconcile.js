import { diffWrite } from '../../servicenow/write-verify.js';

/**
 * PHASE 6 — DID IT ALREADY HAPPEN?
 *
 * THE FAILURE THIS PREVENTS, CONCRETELY. A POST to `/incident` times out. The
 * response is lost. The incident may exist. Retrying makes two.
 *
 * So no mutation is ever repeated before establishing whether its effect is
 * already present. This module answers that question and nothing else: it does
 * no I/O, performs no read, and calls no ServiceNow client. The recovery
 * executor obtains the current record through the EXISTING read tools and hands
 * it here; this compares intent against reality.
 *
 * IT REUSES THE VERIFIER'S COMPARATOR. `diffWrite` already knows that booleans
 * come back as platform strings, that a reference compares by sys_id and never
 * by display value, that a resolved choice label is a transformation rather
 * than a loss, and that a journal field cannot be verified by echo at all. A
 * second comparison written here would get some of that wrong and would
 * disagree with the verdict the execution path produces.
 *
 * WHAT IT WILL NOT DO. It has no answer for a create. There is no deterministic
 * way in this build to tell "the record I just tried to make" from "a similar
 * record someone else made", and inventing a heuristic — matching on
 * short_description, on a time window — would be exactly the guess this project
 * forbids. A create reconciles to UNKNOWN, which stops.
 */

export const RECONCILIATION = Object.freeze({
  ALREADY_SATISFIED: 'ALREADY_SATISFIED',   // the effect is present; do not repeat
  NOT_APPLIED: 'NOT_APPLIED',               // the effect is absent; repeating is meaningful
  DIVERGED: 'DIVERGED',                     // present but different; a person must look
  UNKNOWN: 'UNKNOWN',                       // cannot be established; stop
});

const result = (status, reason, detail = null) => Object.freeze({ status, reason, detail });

/**
 * Compare an intended write against the record as it stands now.
 *
 * @param {object} opts
 * @param {object} opts.descriptor  the tool's own describeWrite output
 * @param {object} opts.current     the record, read back through an existing read tool
 * @param {object} opts.fieldTypes  optional dictionary types, for the journal exclusion
 */
export function reconcileIntent({ descriptor = null, current = null, fieldTypes = {}, hierarchy = [] } = {}) {
  if (!descriptor) {
    return result(RECONCILIATION.UNKNOWN,
      'the operation did not describe its write, so its intended effect cannot be compared against anything');
  }

  const op = String(descriptor.operation ?? '').toLowerCase();

  /*
   * CREATE. The one case with no honest answer.
   *
   * Reconciling a create needs a deterministic way to recognise the record this
   * attempt made. Nothing in this build provides one, so the answer is UNKNOWN
   * and the caller stops. That is not a gap to be filled with a heuristic — a
   * wrong match here means either a duplicate or a stranger's record adopted as
   * ours.
   */
  if (op === 'create' || op === 'insert') {
    return result(RECONCILIATION.UNKNOWN,
      'a create cannot be reconciled: there is no deterministic way here to tell the record this attempt made '
      + 'from a similar one that already existed. A person must check before anything is created again.',
      { operation: op });
  }

  if (op === 'delete') {
    if (current === null || current === undefined) {
      return result(RECONCILIATION.ALREADY_SATISFIED,
        'the record is gone, which is what the delete intended', { operation: op });
    }
    return result(RECONCILIATION.NOT_APPLIED,
      'the record is still present, so the delete did not take effect', { operation: op });
  }

  if (op !== 'update') {
    return result(RECONCILIATION.UNKNOWN,
      `the operation "${op || '(unstated)'}" has no established reconciliation here`, { operation: op });
  }

  /* UPDATE. */
  if (current === null || current === undefined) {
    return result(RECONCILIATION.UNKNOWN,
      'the target record could not be read back, so whether the update took effect is not known',
      { operation: op, sys_id: descriptor.sys_id ?? null });
  }

  const requested = descriptor.requested ?? {};
  if (!Object.keys(requested).length) {
    return result(RECONCILIATION.UNKNOWN, 'the update requested no fields, so there is nothing to compare');
  }

  /*
   * The existing comparator decides. `before` is deliberately null: the
   * pre-write snapshot is gone by now (Phase 5 reports it unavailable), and the
   * question here is only "does the record match the intent", which the diff
   * answers without it.
   */
  const verdict = diffWrite({
    table: descriptor.table,
    operation: 'update',
    requested,
    returned: current,
    before: null,
    fieldTypes,
    hierarchy,
  });

  if (verdict.status === 'applied') {
    return result(RECONCILIATION.ALREADY_SATISFIED,
      'every requested field already holds the intended value, so the update took effect and must not be repeated',
      { verification: verdict });
  }
  if (verdict.status === 'no-op') {
    return result(RECONCILIATION.NOT_APPLIED,
      'none of the requested fields holds its intended value, so the update did not take effect',
      { verification: verdict });
  }
  if (verdict.status === 'partial') {
    return result(RECONCILIATION.DIVERGED,
      'the record holds some of the intended values and not others; a partial effect is not something to repeat blindly',
      { verification: verdict, dropped: verdict.dropped });
  }
  if (verdict.status === 'transformed') {
    return result(RECONCILIATION.DIVERGED,
      'the record holds different values from those requested — the platform transformed them, and repeating the '
      + 'same write would transform them again',
      { verification: verdict, transformed: verdict.transformed });
  }

  return result(RECONCILIATION.UNKNOWN,
    `the comparison could not establish the effect (${verdict.status}): ${verdict.summary ?? ''}`,
    { verification: verdict });
}

/**
 * Does this reconciliation permit a repeat?
 *
 * ONLY `NOT_APPLIED` does. Everything else either means the effect is present
 * (repeating is pointless and possibly harmful) or means it could not be
 * established (repeating is a guess).
 */
export function mayRepeatAfter(reconciliation) {
  return reconciliation?.status === RECONCILIATION.NOT_APPLIED;
}
