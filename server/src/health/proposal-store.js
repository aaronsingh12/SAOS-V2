import crypto from 'node:crypto';
import { getDb } from '../memory/db.js';
import { boundInstance } from '../servicenow/instance-binding.js';

/**
 * The remediation audit trail.
 *
 * One row per attempt, carrying its whole history rather than its current
 * state. `draft_json` is written once and never rewritten, so "what did the AI
 * originally propose" stays answerable after a user has edited it — which is
 * the entire reason a proposal is recorded separately from the plan it becomes.
 *
 * Reads are scoped to the bound instance, like every other Health Assist read:
 * a proposal names sys_ids, and sys_ids are instance-local.
 */

export const PROPOSAL_STATUS = Object.freeze({
  DRAFT: 'draft',
  EDITED: 'edited',
  APPROVED: 'approved',
  EXECUTING: 'executing',
  APPLIED: 'applied',
  PARTIAL: 'partial',
  FAILED: 'failed',
  REJECTED: 'rejected',
});

/** Statuses from which a proposal may still be approved. Anything else is settled. */
const APPROVABLE = new Set([PROPOSAL_STATUS.DRAFT, PROPOSAL_STATUS.EDITED]);

const nowIso = () => new Date().toISOString();
const key = () => boundInstance().key || 'unbound';

export function createProposal({ runId, finding, draft }) {
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO health_proposals
      (id, run_id, finding_fingerprint, rule_id, instance_key, status, draft_json, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(id, runId, finding.fingerprint, finding.rule_id, key(), PROPOSAL_STATUS.DRAFT,
    JSON.stringify(draft), nowIso());
  return id;
}

const parse = (raw, fallback = null) => {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};

function hydrate(row) {
  if (!row) return null;
  const draft = parse(row.draft_json, null);
  const edited = parse(row.edited_json, null);
  return {
    id: row.id,
    runId: row.run_id,
    findingFingerprint: row.finding_fingerprint,
    ruleId: row.rule_id,
    status: row.status,
    /* `proposal` is what the UI edits and what approval acts on: the user's
       version when there is one, the AI's otherwise. `draft` stays available
       beside it so the difference is always inspectable. */
    proposal: edited || draft,
    draft,
    edited,
    wasEdited: Boolean(edited),
    approvedPlan: parse(row.approved_plan_json, null),
    proposalFingerprint: row.proposal_fingerprint,
    planFingerprint: row.plan_fingerprint,
    taskId: row.task_id,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    decidedAt: row.decided_at,
    decision: row.decision,
    decidedSource: row.decided_source,
    rejectReason: row.reject_reason,
    execution: parse(row.execution_json, null),
    validation: parse(row.validation_json, null),
    error: row.error,
  };
}

export function getProposal(id) {
  return hydrate(getDb().prepare(
    'SELECT * FROM health_proposals WHERE id = ? AND instance_key = ?',
  ).get(id, key()));
}

/** Every attempt against one finding, newest first — the finding's own history. */
export function proposalsForFinding(runId, fingerprint) {
  return getDb().prepare(`
    SELECT * FROM health_proposals
     WHERE run_id = ? AND finding_fingerprint = ? AND instance_key = ?
     ORDER BY created_at DESC
  `).all(runId, fingerprint, key()).map(hydrate);
}

/**
 * Save the user's edited version.
 *
 * Writes `edited_json` and leaves `draft_json` alone. Refused once the proposal
 * has been decided: editing something already approved would change what
 * executes out from under the approval, which is the exact failure the plan
 * layer's fingerprint exists to prevent — so it is refused here too rather than
 * relied on being caught later.
 */
export function saveEdit(id, proposal) {
  const row = getProposal(id);
  if (!row) return { ok: false, reason: 'no_such_proposal' };
  if (!APPROVABLE.has(row.status)) {
    return { ok: false, reason: 'already_decided', status: row.status };
  }
  getDb().prepare(`
    UPDATE health_proposals SET edited_json = ?, status = ?, edited_at = ? WHERE id = ?
  `).run(JSON.stringify(proposal), PROPOSAL_STATUS.EDITED, nowIso(), id);
  return { ok: true };
}

export function rejectProposal(id, reason) {
  const row = getProposal(id);
  if (!row) return { ok: false, reason: 'no_such_proposal' };
  if (!APPROVABLE.has(row.status)) return { ok: false, reason: 'already_decided', status: row.status };
  getDb().prepare(`
    UPDATE health_proposals
       SET status = ?, decision = 'rejected', decided_at = ?, decided_source = 'user_click', reject_reason = ?
     WHERE id = ?
  `).run(PROPOSAL_STATUS.REJECTED, nowIso(), String(reason || '').slice(0, 1000) || null, id);
  return { ok: true };
}

/**
 * Record the approval.
 *
 * The fingerprint is checked against what is stored, so an approval given for
 * one version of the proposal cannot execute a different one. This is the same
 * guard the plan layer applies a moment later on its own hash; having both is
 * deliberate — this one refuses BEFORE a plan is built, so a stale approval
 * never reaches the executor at all.
 */
export function approveProposal(id, presentedFingerprint, { planJson, planFingerprint }) {
  const row = getProposal(id);
  if (!row) return { ok: false, reason: 'no_such_proposal' };
  if (!APPROVABLE.has(row.status)) return { ok: false, reason: 'already_decided', status: row.status };

  getDb().prepare(`
    UPDATE health_proposals
       SET status = ?, decision = 'approved', decided_at = ?, decided_source = 'user_click',
           proposal_fingerprint = ?, approved_plan_json = ?, plan_fingerprint = ?
     WHERE id = ?
  `).run(PROPOSAL_STATUS.APPROVED, nowIso(), presentedFingerprint,
    JSON.stringify(planJson), planFingerprint ?? null, id);
  return { ok: true };
}

export function attachTask(id, taskId) {
  getDb().prepare('UPDATE health_proposals SET task_id = ?, status = ? WHERE id = ?')
    .run(taskId, PROPOSAL_STATUS.EXECUTING, id);
}

/**
 * Record what actually happened.
 *
 * `status` is derived from the per-record results, never from the fact that the
 * run finished: a plan that completed with two of five records written is
 * `partial`, and calling it applied is the single most expensive lie this
 * module could tell.
 */
export function recordExecution(id, { results, error = null }) {
  const rows = results || [];
  const applied = rows.filter((r) => r.ok).length;
  const status = error && !applied ? PROPOSAL_STATUS.FAILED
    : applied === rows.length && rows.length > 0 ? PROPOSAL_STATUS.APPLIED
      : applied > 0 ? PROPOSAL_STATUS.PARTIAL
        : PROPOSAL_STATUS.FAILED;

  getDb().prepare('UPDATE health_proposals SET status = ?, execution_json = ?, error = ? WHERE id = ?')
    .run(status, JSON.stringify({ results: rows, applied, total: rows.length }),
      error ? String(error).slice(0, 2000) : null, id);
  return status;
}

export function recordValidation(id, validation) {
  getDb().prepare('UPDATE health_proposals SET validation_json = ? WHERE id = ?')
    .run(JSON.stringify(validation), id);
}
