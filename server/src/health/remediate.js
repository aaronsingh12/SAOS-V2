import {
  generatePlan, savePlan, setPlanState, buildReview, executePlan, loadPlan,
} from '../agent/plan/index.js';
import { createTask, startTask, completeTask, failTask } from '../memory/tasks.js';
import { getSession, createSession, recordToolEvent } from '../memory/sessions.js';
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
 * ═══ TWO APPROVALS, AND WHY THE SECOND ONE IS NOT ANSWERED HERE ═══
 *
 * Approve and apply binds the PLAN: the proposal's fingerprint is checked before
 * a plan is built, and the plan's fingerprint is bound by `approvePlan` and
 * re-checked before every step. If either version moved between the click and
 * the execution, nothing runs.
 *
 * The executor then asks its own per-step gate before each write, exactly as it
 * does for every other plan. That card is answered by the human, in the drawer,
 * through `POST /api/agent/approve` — the one resolver in this system. An
 * earlier version of this comment claimed the second card was never raised. It
 * was wrong: the executor raises it unconditionally, and the drawer did not
 * render it, so a remediation that got past the provenance guard would have
 * waited five minutes for an answer nobody could give. Answering it in-process
 * instead would have made `routes/health.js` a second resolver, which the
 * approval inventory forbids for good reason.
 *
 * ═══ WHY THE TARGETS ARE RE-READ BEFORE THE PLAN IS BUILT ═══
 *
 * The executor refuses a write to any sys_id that has never appeared in the
 * session doing the writing. That guard is right, and remediation is not exempt
 * from it. Health Assist's reads — the extraction, the proposal's current
 * values, the reference lookup — happen outside any session, so the
 * remediation session had seen nothing and every step was BLOCKED as a
 * confabulated sys_id. The agent path worked only because its own read put the
 * record in front of the session first.
 *
 * So remediation does what the agent does: it reads each target, and each
 * referenced record it is about to point a field at, from the instance at
 * approval time, and records that read as an ordinary `get_record` tool event.
 * Provenance is registered by the same single producer every other read uses —
 * no exemption, no side door — and a record that no longer exists stops the
 * remediation before a plan is built, instead of surfacing as a failed write.
 */

const SYS_ID = /^[0-9a-f]{32}$/i;

/**
 * Re-read every record a remediation will write to or point at, in `sessionId`.
 *
 * Returns `{ ok: true, observed }` or `{ ok: false, reason, note, missing }`. A
 * record that cannot be read is a refusal, not a warning: writing to a record
 * nobody could just read is the exact write the provenance guard exists to stop.
 */
export async function observeTargets({ sessionId, taskId = null, changes, readRecord, signal = null }) {
  if (typeof readRecord !== 'function') {
    return {
      ok: false, reason: 'no_reader',
      note: 'The records could not be re-read before applying (no instance reader was supplied). Nothing ran.',
    };
  }
  const wanted = new Map();
  for (const c of changes) {
    wanted.set(`${c.table}:${c.sys_id}`, { table: c.table, sys_id: c.sys_id, role: 'target' });
    if (c.fieldKind === 'reference' && c.references && SYS_ID.test(String(c.proposedValue ?? ''))) {
      const key = `${c.references}:${c.proposedValue}`;
      if (!wanted.has(key)) wanted.set(key, { table: c.references, sys_id: c.proposedValue, role: 'reference' });
    }
  }

  const missing = [];
  let observed = 0;
  for (const w of wanted.values()) {
    if (signal?.aborted) return { ok: false, reason: 'cancelled', note: 'Cancelled before anything was applied.' };
    let row = null;
    let failure = null;
    try { row = await readRecord(w.table, w.sys_id); } catch (err) { failure = err?.message || String(err); }
    if (row) {
      recordToolEvent(sessionId, {
        taskId,
        kind: 'tool_call',
        name: 'get_record',
        payload: { table: w.table, sys_id: w.sys_id },
        result: JSON.stringify(row),
        resultStatus: 'ok',
        mutating: false,
      });
      observed += 1;
    } else {
      /*
       * Recorded as a GUARD, not a tool call. A `tool_call` result is indexed
       * for sys_ids, and the error text of a failed read names the very sys_id
       * that could not be read — so a failed read would have registered the
       * record as seen. Caught by the test for exactly this; a read that
       * returned nothing is not evidence the record exists.
       */
      const reason = failure || 'no record returned';
      recordToolEvent(sessionId, {
        taskId,
        kind: 'guard',
        name: 'remediation_target_unreadable',
        payload: { table: w.table, sys_id: w.sys_id, role: w.role },
        result: reason,
        resultStatus: 'blocked',
        mutating: false,
      });
      missing.push({ ...w, reason });
    }
  }

  if (missing.length) {
    const list = missing.slice(0, 5)
      .map((m) => `${m.table}/${m.sys_id}${m.role === 'reference' ? ' (the value being set)' : ''} — ${m.reason}`)
      .join('; ');
    return {
      ok: false,
      reason: 'target_unreadable',
      missing,
      note: `${missing.length} record(s) could not be re-read from the instance just now, so nothing was applied: ${list}`
        + `${missing.length > 5 ? '; …' : ''}. They may have been deleted, or this user may not be able to read them. `
        + 'Re-run the health check or generate a new plan.',
    };
  }
  return { ok: true, observed };
}

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
  proposalId, proposal, runId, presentedFingerprint, emit = () => {}, signal = null, readRecord,
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
    /* See "WHY THE TARGETS ARE RE-READ" above. Before the plan exists, so a
       record that vanished stops here rather than as a failed step. */
    emit({ type: 'targets_observing', taskId: task.id, records: changes.length });
    const seen = await observeTargets({ sessionId, taskId: task.id, changes, readRecord, signal });
    if (!seen.ok) {
      setPlanState(task.id, 'failed', { failure_reason: seen.note });
      failTask(task.id, seen.note);
      return { ok: false, reason: seen.reason, note: seen.note, taskId: task.id, missing: seen.missing ?? [] };
    }
    emit({ type: 'targets_observed', taskId: task.id, observed: seen.observed });

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
    /* `sessionId` travels with the frame because the drawer answers each step's
       approval card with it, through POST /api/agent/approve. */
    emit({ type: 'execution_started', taskId, sessionId, steps: draft.steps.length });

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
      /*
       * `verification.status` is the mutation pipeline's verdict (applied,
       * no-op, partial, unverified, self-verified). This used to read
       * `verification.verdict ?? verification.strategy` — neither exists on a
       * step row, so a blocked step showed "read-back read_back", the PLAN's
       * declared strategy, as if a read-back had happened. And the reason was
       * read from `failure_reason` when the row calls it `failureReason`, so
       * the BLOCKED explanation never reached the drawer.
       */
      const verdict = row?.verification?.status ?? null;
      const ok = row?.state === 'completed' && !['no-op', 'partial', 'unverified'].includes(verdict);
      return {
        sys_id: change.sys_id,
        table: change.table,
        field: change.field,
        before: change.currentValue,
        after: ok ? change.proposedValue : (row?.result?.stored ?? null),
        state: row?.state ?? 'not_reached',
        verdict,
        ok,
        note: row?.failureReason
          ?? (row ? null : 'This step was never reached, so nothing was sent for this record.'),
      };
    });

    const status = recordExecution(proposalId, {
      results,
      error: result.ok ? null : (result.note || result.reason),
    });

    /*
     * Validation checks that approved values LANDED. When nothing was applied
     * there is nothing to check, and "Validation failed — 0 of 1" beside a
     * blocked step reads as though a write happened and did not stick. Say
     * what is true instead.
     */
    const appliedChanges = changes.filter((_, i) => results[i]?.state === 'completed');
    const validation = appliedChanges.length
      ? await validateRemediation(proposal, appliedChanges, { readRecord })
      : {
        method: 'targeted_read_back',
        skipped: true,
        checks: [],
        cleared: 0,
        total: 0,
        ok: false,
        note: 'Nothing was applied, so there was nothing to validate. The reason is shown on each record above.',
      };
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
