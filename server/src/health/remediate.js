import {
  generatePlan, savePlan, setPlanState, buildReview, executePlan, loadPlan,
} from '../agent/plan/index.js';
import { createTask, startTask, completeTask, failTask } from '../memory/tasks.js';
import { getSession, createSession } from '../memory/sessions.js';
import { getSettings } from '../config/store.js';
import { log } from '../logging.js';
import { planFromProposal, executableChanges, proposalFingerprint } from './proposal.js';
import { approveProposal, attachTask, recordExecution, recordValidation } from './proposal-store.js';

/**
 * Executing an approved remediation.
 *
 * ═══ THIS MODULE RUNS NOTHING ITSELF ═══
 *
 * It converts an approved proposal into a plan and hands it to the EXISTING
 * pipeline — `generatePlan` (for validation and canonicalisation) → `savePlan`
 * → `buildReview` → `approvePlan` → `executePlan`. Every guarantee the rest of
 * the app already has therefore applies unchanged:
 *
 *   - a plan cannot reach EXECUTING except from AWAITING_APPROVAL, because the
 *     transition table has no other edge in;
 *   - the approval is bound to the plan's fingerprint and RE-CHECKED before
 *     every step, so a plan edited after approval cannot execute under it;
 *   - each write goes through the mutation pipeline, which re-reads the record
 *     and compares — a 2xx that stored nothing comes back `no-op`, not success;
 *   - every step lands in `agent_tasks` / `agent_task_steps` and the evidence
 *     projection, so the remediation is auditable the same way a chat turn is.
 *
 * Writing a second executor here would have meant a second gate, a second
 * read-back and a second audit trail — three chances to be subtly weaker than
 * the ones that already exist.
 *
 * ═══ WHY THIS IS TWO FUNCTIONS AND NOT ONE ═══
 *
 * `prepareRemediation` builds and saves the plan; `runRemediation` executes it.
 * The approval is bound BETWEEN them, by `routes/health.js`, because `routes/`
 * is the only place in this system where an approval is raised or bound — a
 * reader auditing "what can authorise a write" should be able to read the
 * routers and stop.
 *
 * An earlier shape passed `approvePlan` in as a callback. That was worse than
 * it looked: the call then lived here under an alias, invisible both to the
 * approval inventory that guards this rule and to the person reading the
 * router. Splitting the function puts the binding where it can be seen.
 *
 * ═══ WHY THE APPROVAL IS NOT ASKED FOR TWICE ═══
 *
 * The plan route raises an approval card because its plan was generated from a
 * sentence and the human has not seen it yet. Here the human has just read the
 * exact change list, edited it, and pressed Approve and apply — that IS the
 * approval, and it carries `user_click` provenance. Re-prompting would train
 * people to click through the gate, which is worse than not showing it.
 *
 * What makes that safe is that the approval is bound to content twice over: the
 * proposal's own fingerprint is checked before a plan is built, and the plan's
 * fingerprint is checked by `approvePlan` before a step runs. If either version
 * moved between the click and the execution, nothing runs.
 */

/** A failure to read a record back is not a successful validation. */
const UNKNOWN = 'unknown';

/**
 * Did the change actually land, and did it clear the finding?
 *
 * A TARGETED re-check, not a health run. It re-reads each record that was
 * supposed to change and compares the field against what was approved. It
 * answers "is this record still the way the rule objected to" and nothing
 * wider, and the result says so — a full re-run is the user's next step, not
 * something this quietly implies it did.
 */
export async function validateRemediation(proposal, changes, { readRecord }) {
  const checks = [];
  for (const c of changes) {
    if (c.fieldKind === 'delete') {
      let present = UNKNOWN;
      try { present = (await readRecord(c.table, c.sys_id)) ? 'yes' : 'no'; }
      catch { present = UNKNOWN; }
      checks.push({
        sys_id: c.sys_id, table: c.table, field: null, expected: '<deleted>',
        actual: present === 'no' ? '<deleted>' : present === 'yes' ? '<still present>' : UNKNOWN,
        cleared: present === 'no',
      });
      continue;
    }
    try {
      const row = await readRecord(c.table, c.sys_id);
      const raw = row?.[c.field];
      const actual = raw && typeof raw === 'object' ? (raw.value ?? '') : (raw ?? '');
      checks.push({
        sys_id: c.sys_id,
        table: c.table,
        field: c.field,
        expected: c.proposedValue,
        actual: String(actual),
        /* Compared against the APPROVED value, not merely "is it non-empty".
           A field that was filled with something else is not this fix working. */
        cleared: String(actual) === String(c.proposedValue),
      });
    } catch (err) {
      checks.push({
        sys_id: c.sys_id, table: c.table, field: c.field,
        expected: c.proposedValue, actual: UNKNOWN, cleared: false,
        note: err?.message || 'the record could not be re-read',
      });
    }
  }

  const cleared = checks.filter((c) => c.cleared).length;
  return {
    method: 'targeted_read_back',
    checks,
    cleared,
    total: checks.length,
    ok: cleared === checks.length && checks.length > 0,
    note: 'Each record was re-read and its field compared with the approved value. '
      + 'This confirms the change landed; it does not re-run the whole health check — do that to confirm the finding clears.',
  };
}

/**
 * Turn an approved proposal into a completed, verified remediation.
 *
 * `emit` receives the plan pipeline's own frames verbatim plus this module's,
 * so the UI shows the same vocabulary the agent workspace does.
 */
export async function prepareRemediation({
  proposalId, proposal, runId, presentedFingerprint, emit = () => {}, signal = null,
}) {
  /*
   * GUARD ONE — the proposal the user approved is the proposal on disk.
   *
   * Checked BEFORE a plan is built, so a stale approval never reaches the
   * executor at all. The plan layer checks its own hash a moment later; having
   * both means an edit between the click and the build is caught at the first
   * opportunity rather than the last.
   */
  const current = proposalFingerprint(proposal);
  if (presentedFingerprint && current !== presentedFingerprint) {
    return {
      ok: false,
      reason: 'fingerprint_mismatch',
      note: 'The proposal changed after it was shown to you, so this approval does not apply to it. '
        + 'Nothing ran — review the current version and approve that.',
    };
  }

  const changes = executableChanges(proposal);
  if (!changes.length) {
    return {
      ok: false,
      reason: 'nothing_to_do',
      note: 'Every proposed change was removed or has no value, so there is nothing to apply. Nothing ran.',
    };
  }

  /* A session so the remediation is visible and followable in the agent, like
     any other task. Tasks require one; inventing a hidden one would put this
     work somewhere nobody could find it. */
  const sessionId = `health-${proposalId}`;
  if (!getSession(sessionId)) {
    createSession({ id: sessionId, title: `Health Assist — ${proposal.ruleId}` });
  }

  const draft = planFromProposal(proposal);
  const task = createTask({
    sessionId,
    goal: draft.goal,
    metadata: { planned: true, healthProposal: proposalId, healthRun: runId, rule: proposal.ruleId },
  });
  if (!task) return { ok: false, reason: 'no_task', note: 'The task record could not be created, so nothing ran.' };
  startTask(task.id);

  try {
    /*
     * The approved change list goes through the ORDINARY planner seam. The
     * model is not consulted — `propose` returns the plan the human approved —
     * but every deterministic check downstream runs unchanged: validation,
     * canonicalisation, the platform-fact stamp and the dataflow rules. A plan
     * a person hand-edited is exactly the plan that most needs validating.
     */
    const generated = await generatePlan({ goal: draft.goal, propose: () => draft, signal });
    if (!generated.ok) {
      const note = generated.note
        || `The approved changes did not form a runnable plan (${generated.reason}). Nothing ran.`;
      setPlanState(task.id, 'failed', { failure_reason: note });
      failTask(task.id, note);
      return {
        ok: false, reason: generated.reason, note, taskId: task.id,
        problems: (generated.fatal ?? []).map((p) => ({ code: p.code, step: p.step, message: p.message })),
      };
    }

    const saved = savePlan(task.id, generated.plan);
    if (!saved.ok) {
      setPlanState(task.id, 'failed', { failure_reason: saved.error });
      failTask(task.id, saved.error);
      return { ok: false, reason: 'not_saved', note: saved.error, taskId: task.id };
    }
    setPlanState(task.id, 'ready');

    const review = buildReview(generated.plan, { fingerprint: saved.fingerprint });
    emit({ type: 'plan_created', taskId: task.id, fingerprint: saved.fingerprint, review });

    approveProposal(proposalId, current, { planJson: generated.plan, planFingerprint: saved.fingerprint });
    attachTask(proposalId, task.id);

    /*
     * The plan is now parked at AWAITING_APPROVAL, which is the only state the
     * edge into EXECUTING leaves from. The route binds the approval next; until
     * it does, nothing can run — `checkApprovalBinding` refuses a plan that was
     * never approved before every single step.
     */
    setPlanState(task.id, 'awaiting_review');
    setPlanState(task.id, 'awaiting_approval');

    return {
      ok: true,
      taskId: task.id,
      sessionId,
      planFingerprint: saved.fingerprint,
      steps: generated.plan.steps.length,
      changes,
    };
  } catch (err) {
    log.error('health', `remediation ${proposalId.slice(0, 8)} could not be prepared — ${err.message}`, err);
    try { setPlanState(task.id, 'failed', { failure_reason: err.message }); } catch { /* already failing */ }
    try { failTask(task.id, err.message); } catch { /* already failing */ }
    return { ok: false, reason: 'error', note: err.message, taskId: task.id };
  }
}

/**
 * Run an APPROVED plan and report what actually landed.
 *
 * Called only after the route has bound the approval. It does not check the
 * approval itself and does not need to: `executePlan` re-checks the binding
 * before every step, so a plan that reached here unapproved simply does not
 * execute.
 */
export async function runRemediation({
  proposalId, proposal, taskId, sessionId, changes, emit = () => {}, signal = null, readRecord,
}) {
  const draft = planFromProposal(proposal);
  try {
    emit({ type: 'execution_started', taskId, steps: draft.steps.length });

    const { agent } = getSettings();
    const result = await executePlan({
      taskId,
      sessionId,
      turnSeq: 0,
      emit,
      signal,
      /*
       * Auto-approve is deliberately NOT threaded through from settings.
       *
       * The human authorised THIS change list. Letting a global auto-approve
       * preference also cover it would mean the setting could widen what a
       * specific approval covered, which is not what either control means.
       */
      autoApprove: Boolean(agent?.autoApprove) && false,
    });

    /*
     * WHAT ACTUALLY LANDED, per record, read off the durable step rows rather
     * than the executor's return value — the rows carry the verification
     * verdict, which is the thing that decides whether a write counts.
     */
    const after = loadPlan(taskId);
    const byStep = new Map((after?.steps || []).map((s) => [s.id, s]));
    const results = draft.steps.map((s, i) => {
      const row = byStep.get(s.id);
      const change = changes[i];
      const verdict = row?.verification?.verdict ?? row?.verification?.strategy ?? null;
      const ok = row?.state === 'completed' && verdict !== 'no-op' && verdict !== 'partial';
      return {
        sys_id: change.sys_id,
        table: change.table,
        field: change.field,
        before: change.currentValue,
        after: ok ? change.proposedValue : (row?.result?.stored ?? null),
        state: row?.state ?? 'not_reached',
        verdict,
        ok,
        note: row?.result?.note ?? row?.failure_reason ?? null,
      };
    });

    const status = recordExecution(proposalId, {
      results,
      error: result.ok ? null : (result.note || result.reason),
    });

    const validation = await validateRemediation(proposal, changes, { readRecord });
    recordValidation(proposalId, validation);

    if (result.ok) completeTask(taskId);
    else failTask(taskId, result.note ?? result.reason);

    emit({ type: 'execution_complete', taskId, status, results, validation });

    return {
      ok: result.ok, status, taskId, results, validation,
      note: result.ok ? null : (result.note ?? result.reason),
    };
  } catch (err) {
    log.error('health', `remediation ${proposalId.slice(0, 8)} failed outside the pipeline — ${err.message}`, err);
    try { setPlanState(taskId, 'failed', { failure_reason: err.message }); } catch { /* already failing */ }
    try { failTask(taskId, err.message); } catch { /* already failing */ }
    recordExecution(proposalId, { results: [], error: err.message });
    return { ok: false, reason: 'error', note: err.message, taskId };
  }
}
