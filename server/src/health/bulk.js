import { FIX_FIELD } from './proposal.js';

/**
 * Bulk remediation — the PURE half.
 *
 * ═══ WHAT THIS MODULE IS, AND IS NOT ═══
 *
 * Bulk Fix is an orchestration layer around the single-finding flow, not a
 * second flow. Every selected finding still goes through `buildProposal`, still
 * gets its own proposal row, still has its own fingerprint checked, still has
 * its plan bound by the route, still raises the executor's per-record card and
 * still reads back. Nothing here writes, binds an approval or talks to the
 * instance — this file cannot even name those functions.
 *
 * What lives here is the part that is the same for every finding type and can
 * be asserted offline: how a selection is normalised and capped, the status
 * vocabulary each item settles into, and the roll-up that refuses to round a
 * batch of three-applied-two-failed up to "done".
 *
 * ═══ WHY THE STATUS VOCABULARY IS CLOSED ═══
 *
 * A batch hides a failure the moment its report is one word. "5 fixed" beside
 * one finding that only had a value on two of its records is the lie this
 * module exists to avoid, so every item carries exactly one of the statuses
 * below, with a note, and the summary counts them by status. The words are
 * chosen so that `applied` can only mean "every approved record landed and
 * read back" — the same meaning the proposal store gives it.
 */

/** The most findings one bulk operation may hold. Each proposal is itself capped
 *  at 25 records, so this bounds a batch at ~625 writes, each behind its own card. */
export const BULK_MAX = 25;

export const BULK_ITEM_STATUS = Object.freeze({
  /* proposal phase */
  PENDING: 'pending',                 // selected, nothing has happened yet
  PROPOSED: 'proposed',               // a proposal exists and has at least one executable change
  NEEDS_VALUE: 'needs_value',         // a proposal exists but no change carries a value — a human must supply one
  NO_FIELD_FIX: 'no_field_fix',       // the rule has no single-field fix; manual steps are the remedy
  STALE: 'stale',                     // the finding or its run is no longer on this instance
  PROPOSAL_FAILED: 'proposal_failed', // the proposal could not be generated (an exception, not a blank)
  /* apply phase */
  EXCLUDED: 'excluded',               // the reviewer left it out of the batch
  ALREADY_DECIDED: 'already_decided', // the proposal was approved/rejected/applied before this batch reached it
  APPLIED: 'applied',
  PARTIAL: 'partial',
  FAILED: 'failed',
  CANCELLED: 'cancelled',             // the batch was stopped while this item was running
  NOT_STARTED: 'not_started',         // the batch was stopped before this item was reached
});

/** Statuses that mean "this item did not change the instance, and will not". */
export const SKIPPED_STATUSES = new Set([
  BULK_ITEM_STATUS.NEEDS_VALUE, BULK_ITEM_STATUS.NO_FIELD_FIX, BULK_ITEM_STATUS.STALE,
  BULK_ITEM_STATUS.PROPOSAL_FAILED, BULK_ITEM_STATUS.EXCLUDED, BULK_ITEM_STATUS.ALREADY_DECIDED,
  BULK_ITEM_STATUS.NOT_STARTED,
]);

/** Does this rule have an automated (single-field) fix the proposal can offer? */
export function hasFieldFix(ruleId) {
  return Boolean(FIX_FIELD[ruleId]);
}

const FP = /^[0-9a-f]{64}$/i;

/**
 * Normalise a selection from the client into `{ runId, fingerprint }` pairs.
 *
 * Deduplicated on the pair, because a finding can be selected from the All view
 * and a module tab in the same session; capped, because a batch of five hundred
 * cards is not a workflow anybody can review. Refuses rather than trims: a
 * silently shortened batch would report "done" for findings nobody touched.
 */
export function normaliseSelection(raw, { max = BULK_MAX } = {}) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: 'empty', note: 'Select at least one finding.' };
  }
  const seen = new Set();
  const items = [];
  for (const r of raw) {
    const runId = typeof r?.runId === 'string' ? r.runId.trim() : '';
    const fingerprint = typeof r?.fingerprint === 'string' ? r.fingerprint.trim().toLowerCase() : '';
    if (!runId || !FP.test(fingerprint)) {
      return { ok: false, reason: 'malformed', note: 'Every item needs a runId and a finding fingerprint.' };
    }
    const key = `${runId}:${fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, runId, fingerprint });
  }
  if (items.length > max) {
    return {
      ok: false, reason: 'too_many',
      note: `A bulk fix covers at most ${max} findings at a time; ${items.length} were selected. Fix the first ${max}, re-scan, then continue.`,
    };
  }
  return { ok: true, items };
}

/**
 * Normalise the approve-phase body: `{ proposalId, fingerprint }` pairs, each
 * the version the reviewer was looking at. A missing fingerprint is refused
 * rather than defaulted, because "approve whatever is stored now" is exactly
 * the approval-of-an-unseen-version the fingerprint check exists to stop.
 */
export function normaliseApprovals(raw, { max = BULK_MAX } = {}) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: 'empty', note: 'Nothing was included in the batch.' };
  }
  const seen = new Set();
  const items = [];
  for (const r of raw) {
    const proposalId = typeof r?.proposalId === 'string' ? r.proposalId.trim() : '';
    const fingerprint = typeof r?.fingerprint === 'string' ? r.fingerprint.trim() : '';
    if (!proposalId || !FP.test(fingerprint)) {
      return { ok: false, reason: 'malformed', note: 'Every item needs a proposalId and the fingerprint that was reviewed.' };
    }
    if (seen.has(proposalId)) continue;
    seen.add(proposalId);
    items.push({ proposalId, fingerprint });
  }
  if (items.length > max) {
    return { ok: false, reason: 'too_many', note: `A bulk fix applies at most ${max} proposals at a time.` };
  }
  return { ok: true, items };
}

/**
 * Which status a freshly built proposal puts its item in.
 *
 * Decided from the proposal's own facts — its `llm.status` and its executable
 * change count — never from the rule id, so a rule added to FIX_FIELD tomorrow
 * classifies correctly without anyone touching this file.
 */
export function classifyProposal(proposal, executableCount) {
  if (!proposal) return BULK_ITEM_STATUS.PROPOSAL_FAILED;
  if (proposal.llm?.status === 'no_field_fix' || (!proposal.field && proposal.operation !== 'delete')) {
    return BULK_ITEM_STATUS.NO_FIELD_FIX;
  }
  if (executableCount > 0) return BULK_ITEM_STATUS.PROPOSED;
  /* Every target the finding named could not be read just now — deleted, or
     hidden from this user. That is not a missing value; it is a finding the
     instance no longer supports, and a re-scan is the honest next step. */
  if (!(proposal.changes || []).length && (proposal.unreadable || []).length) return BULK_ITEM_STATUS.STALE;
  return BULK_ITEM_STATUS.NEEDS_VALUE;
}

/** The note that goes with a proposal-phase status. One place, so both routes say the same thing. */
export function proposalNote(status) {
  switch (status) {
    case BULK_ITEM_STATUS.NO_FIELD_FIX:
      return 'This rule has no single-field fix, so there is nothing to apply automatically. The manual steps are the remedy.';
    case BULK_ITEM_STATUS.NEEDS_VALUE:
      return 'No change carries a value yet. Supply one in the review, or leave this finding out.';
    case BULK_ITEM_STATUS.STALE:
      return 'None of the records this finding names could be read from the instance just now. Re-run the scan.';
    default:
      return null;
  }
}

/**
 * Map the single-flow result (`prepareRemediation` / `runRemediation` /
 * the route's bind) onto an item status. `result.status` is the proposal
 * store's verdict, derived from per-record read-backs — it is used as-is.
 */
export function classifyOutcome(result) {
  if (!result) return BULK_ITEM_STATUS.FAILED;
  if (result.reason === 'cancelled') return BULK_ITEM_STATUS.CANCELLED;
  if (result.ok) {
    return result.status === 'applied' ? BULK_ITEM_STATUS.APPLIED
      : result.status === 'partial' ? BULK_ITEM_STATUS.PARTIAL
        : BULK_ITEM_STATUS.FAILED;
  }
  /* A run that reached execution but did not land everything reports its
     store status; a run that never got a plan is simply failed. */
  if (result.status === 'partial') return BULK_ITEM_STATUS.PARTIAL;
  return BULK_ITEM_STATUS.FAILED;
}

/**
 * The batch summary — counts by status, and the one-line verdict.
 *
 * `ok` is true only when every item that was included applied in full. A batch
 * with anything skipped, partial or failed is NOT ok, whatever the majority did.
 */
export function summarise(items) {
  const counts = {};
  for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;
  const applied = counts[BULK_ITEM_STATUS.APPLIED] || 0;
  const partial = counts[BULK_ITEM_STATUS.PARTIAL] || 0;
  const failed = (counts[BULK_ITEM_STATUS.FAILED] || 0) + (counts[BULK_ITEM_STATUS.CANCELLED] || 0);
  const skipped = items.filter((it) => SKIPPED_STATUSES.has(it.status)).length;
  const total = items.length;
  const ok = total > 0 && applied === total;
  const parts = [];
  if (applied) parts.push(`${applied} applied`);
  if (partial) parts.push(`${partial} partially applied`);
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} skipped`);
  return {
    total, applied, partial, failed, skipped, counts, ok,
    note: parts.length ? `${parts.join(' · ')} of ${total}.` : 'Nothing was processed.',
  };
}
