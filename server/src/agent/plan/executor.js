import crypto from 'node:crypto';
import { log, ms, shortId } from '../../logging.js';
import { toolMap } from '../tools.js';
/* One definition of "which steps can write", shared with the validator so the
 * pre-execution check and the plan-time rule cannot drift apart. */
import { mutatingSteps } from './validator.js';
import {
  executeTool, awaitApprovalDecision, APPROVAL_SOURCES,
} from '../orchestrator.js';
import { snapshotBefore, verifyMutation, attachVerification, isFailedWrite } from '../mutation-pipeline.js';
import { checkBeforeGate, recordRejection, recordDrops } from '../write-guard.js';
import { checkWriteTarget } from '../../memory/provenance.js';
import { appendMutation } from '../../memory/ledger.js';
import { recordToolEvent } from '../../memory/sessions.js';
import { captureAfterTool, captureMark } from '../capture.js';
import {
  loadPlan, setPlanState, setStepState, recordStepResult,
  checkApprovalBinding, executionOrder,
  recordStepOutputs, stepOutputs, recordStepDataflow,
} from './store.js';
import {
  findReferences, resolveReferences, extractOutputs, producerIsUsable,
} from './dataflow.js';

/**
 * PHASE 4 — THE PLAN EXECUTOR.
 *
 * IT OWNS ORDERING AND NOTHING ELSE. Every control this project has stays
 * exactly where it was and is called, not reimplemented:
 *
 *   the tool registry        toolMap
 *   the approval gate        awaitApprovalDecision + resolveApproval + executeTool
 *   the write guards         checkWriteTarget, checkBeforeGate
 *   the mutation pipeline    snapshotBefore, verifyMutation, attachVerification
 *   provenance               appendMutation, recordToolEvent
 *   transport capture        captureAfterTool
 *
 * `executeTool` is the important one. It refuses any mutation whose approval is
 * not both resolved AND attributable, so this executor cannot run a write by
 * deciding it is fine — it has to produce a real `user_click` decision from the
 * real gate, exactly as the turn loop does.
 *
 * THE FINGERPRINT IS CHECKED BEFORE EVERY STEP, not once at the start. An
 * approval authorises a specific plan; a plan edited afterwards is a different
 * plan nobody approved. Checking once would leave the whole rest of the run
 * inheriting a binding that no longer describes it.
 *
 * NO RECOVERY, NO RETRIES, NO ROLLBACK. A failed step fails the plan, loudly,
 * with the reason. Phase 4 deliberately stops there: retrying a mutation whose
 * outcome is unknown is how a duplicate record gets created, and undoing a
 * partial run needs a rollback model this project does not have yet.
 */

const nowIso = () => new Date().toISOString();

/**
 * Ask the human, through the existing gate.
 *
 * The card carries the plan fingerprint so the client can bind its answer to
 * the plan it is looking at, and the nonce so the answer can be proven to have
 * come from this card. Both are the mechanisms already in place; this adds no
 * new ones.
 */
async function requestApproval({ sessionId, step, plan, emit, signal, dataflow = null }) {
  const approvalId = crypto.randomUUID();
  const nonce = crypto.randomBytes(32).toString('base64url');
  emit({
    type: 'approval_required',
    approvalId,
    nonce,
    name: step.tool ?? step.operation,
    input: step.inputs ?? {},
    /*
     * PHASE 13 — ENOUGH FOR A PERSON TO KNOW WHAT THEY ARE AGREEING TO.
     *
     * The card already carried the tool name and the canonical arguments, which
     * is what will run but not what it MEANS. Three additions, all read from the
     * step that was validated and fingerprinted — nothing is recomputed here,
     * and nothing new is decided:
     *
     *   operation      the sentence the plan itself used
     *   target         which record, as the plan named it
     *   verification   what will be checked afterwards, so "approve" is also a
     *                  statement about what proof will exist
     *
     * A reader can now answer "what, to which record, and how will I know it
     * worked" without reading a JSON blob.
     */
    operation: step.operation ?? null,
    target: step.target ?? null,
    verification: step.verification
      ? { strategy: step.verification.strategy ?? null, asserts: step.verification.asserts ?? [] }
      : null,
    expectedEffects: step.expected_effects ?? [],
    /*
     * PHASE 12 — WHERE A VALUE CAME FROM, beside the value itself.
     *
     * A card showing only `sys_id: 62826bf0…` asks a person to authorise a
     * write to a record they have no way to identify. A card showing only
     * `sys_id: <reference>` asks them to authorise something whose target they
     * cannot see. Both are shown: the value that will run, and the declared
     * reference it was resolved from, so the sentence a reader forms is
     * "this updates the record step 1 found" — which is what they are actually
     * being asked.
     *
     * Null when the step used no references, so an ordinary card is unchanged.
     */
    dataflow: dataflow?.length
      ? dataflow.map((r) => ({ path: r.path, declared: r.declared, resolved: r.resolved }))
      : null,
    plan: { taskId: plan.taskId, stepId: step.id, fingerprint: plan.fingerprint },
    warning: step.approval?.requiresElevation
      ? `This step requires elevation to ${step.approval.elevationRole}.`
      : null,
  });
  log.warn('plan', `approval required for step ${step.id} (${step.operation}) — waiting for the user`);
  const decision = await awaitApprovalDecision(sessionId, approvalId, nonce, signal);
  emit({ type: 'approval_resolved', approvalId, approved: decision.approved, source: decision.source, at: decision.at });
  return decision;
}

/**
 * Run one step.
 *
 * Returns a terminal verdict for the step; it never throws into the plan loop,
 * because a plan that died on an exception would leave its steps in whatever
 * state they were in and the durable record would stop describing reality.
 */
async function runStep({ plan, step, sessionId, turnSeq, emit, signal, autoApprove, dataflow = null }) {
  const started = Date.now();
  const tool = step.tool ? toolMap.get(step.tool) : null;

  if (step.tool && !tool) {
    // The registry is authoritative. A plan naming a verb this build does not
    // have cannot run, and no substitute is found for it.
    const note = `Step ${step.id} names the tool "${step.tool}", which is not in the registry. Nothing was run and no alternative was substituted.`;
    setStepState(plan.taskId, step.id, 'failed', { failure_reason: note });
    return { ok: false, state: 'failed', note };
  }
  if (!tool) {
    // A planning-only step (a decision, a wait) has nothing to execute. It is
    // completed rather than skipped: it did what it was for.
    setStepState(plan.taskId, step.id, 'completed');
    return { ok: true, state: 'completed', note: 'no tool — planning step' };
  }

  const mutating = Boolean(tool.mutating);

  /* ---- the write guards, before the gate, exactly as the turn loop runs them ---- */
  let descriptor = null;
  if (mutating && typeof tool.describeWrite === 'function') {
    try { descriptor = tool.describeWrite(step.inputs || {}, null); } catch { /* unverifiable */ }
  }
  if (mutating && descriptor?.sys_id) {
    const target = checkWriteTarget({ sessionId, sysId: descriptor.sys_id, userText: plan.goal ?? '' });
    if (target.verdict === 'confabulated') {
      const note = `BLOCKED: sys_id ${descriptor.sys_id} has never appeared in this session. It was not submitted to the approval gate and nothing was changed.`;
      log.error('plan', `step ${step.id} blocked — confabulated sys_id`);
      recordToolEvent(sessionId, {
        taskId: plan.taskId,
        kind: 'guard', name: 'confabulated_sys_id',
        payload: { plan: plan.taskId, step: step.id, tool: step.tool, sys_id: descriptor.sys_id, input: step.inputs },
        result: note, resultStatus: 'blocked', mutating: false, approval: null,
      });
      emit({ type: 'step_failed', step: step.id, reason: 'confabulated_sys_id', note });
      setStepState(plan.taskId, step.id, 'failed', { failure_reason: note });
      return { ok: false, state: 'failed', note };
    }
  }
  if (mutating && descriptor) {
    const verdict = checkBeforeGate({ sessionId, turnSeq, tool: step.tool, descriptor, force: false });
    if (!verdict.allowed) {
      log.warn('plan', `step ${step.id} blocked before approval — ${verdict.reason}`);
      recordToolEvent(sessionId, {
        taskId: plan.taskId,
        kind: 'tool_call', name: step.tool, payload: step.inputs, result: verdict.message,
        resultStatus: `blocked:${verdict.reason}`, mutating: true, approval: null,
      });
      emit({ type: 'step_failed', step: step.id, reason: verdict.reason, note: verdict.message });
      setStepState(plan.taskId, step.id, 'failed', { failure_reason: verdict.message });
      return { ok: false, state: 'failed', note: verdict.message };
    }
  }

  /* ---- the approval gate ---- */
  let approval = null;
  let approvedSource = null;
  let approvedAt = null;
  if (mutating) {
    if (autoApprove) {
      approval = 'auto';
      approvedSource = APPROVAL_SOURCES.AUTO_APPROVE;
      approvedAt = nowIso();
      log.warn('plan', `step ${step.id} ran UNGATED — auto-approve is on, nobody saw it`);
    } else {
      setStepState(plan.taskId, step.id, 'awaiting_approval');
      setPlanState(plan.taskId, 'awaiting_approval');
      emit({ type: 'step_awaiting_approval', step: step.id, operation: step.operation });
      const decision = await requestApproval({ sessionId, step, plan, emit, signal, dataflow });

      if (decision.source === 'cancelled') {
        // Phase 0's vocabulary, unchanged: a cancellation is not a rejection.
        const note = 'The plan was cancelled while this step was waiting for approval. It was never authorised and never ran.';
        recordToolEvent(sessionId, {
        taskId: plan.taskId,
          kind: 'tool_call', name: step.tool, payload: step.inputs, result: note,
          resultStatus: 'cancelled', mutating: true, approval: null,
        });
        setStepState(plan.taskId, step.id, 'cancelled', { failure_reason: note });
        return { ok: false, state: 'cancelled', note };
      }
      if (!decision.approved) {
        // A rejection ends the plan. It is never converted into a retry.
        const note = decision.source === 'timeout'
          ? 'This step was never answered and the approval expired. Nothing was executed.'
          : 'The user rejected this step. Nothing was executed, and it will not be retried.';
        if (descriptor) {
          recordRejection({ sessionId, turnSeq, tool: step.tool, table: descriptor.table, sys_id: descriptor.sys_id, requested: descriptor.requested });
        }
        recordToolEvent(sessionId, {
        taskId: plan.taskId,
          kind: 'tool_call', name: step.tool, payload: step.inputs, result: note,
          resultStatus: 'rejected', mutating: true, approval: 'rejected',
          approvedSource: decision.source, approvedAt: decision.at,
        });
        emit({ type: 'step_failed', step: step.id, reason: 'rejected', note });
        setStepState(plan.taskId, step.id, 'failed', { failure_reason: note });
        return { ok: false, state: 'failed', note, rejected: true };
      }
      approval = 'approved';
      approvedSource = decision.source;
      approvedAt = decision.at;
    }
    setPlanState(plan.taskId, 'executing');
  }

  /* ---- execution: the protected window ----
   *
   * From here to the end of capture, the cancellation signal is deliberately
   * NOT consulted. Phase 0's rule holds inside a plan exactly as it holds
   * inside a turn: a mutation that has started finishes and is recorded, and
   * the stop lands at the next boundary. */
  setStepState(plan.taskId, step.id, 'executing');
  emit({ type: 'step_started', step: step.id, operation: step.operation, tool: step.tool, mutating });

  const mark = mutating ? captureMark() : null;
  const before = await snapshotBefore(descriptor);

  try {
    /*
     * PHASE 11 — `step.inputs` IS the canonical execution argument object.
     *
     * `savePlan` canonicalises before it fingerprints and stores, so what comes
     * back out of `loadPlan` is exactly what was fingerprinted and approved.
     * There is deliberately NO merge, normalisation or repair here: anything
     * this line did to the arguments would be something the human never saw.
     *
     * One consequence worth naming. Because the target now reaches the tool,
     * `describeWrite` above produces a descriptor that HAS a sys_id — so
     * `checkWriteTarget` fires on steps where it previously could not, which
     * was the quieter half of the Phase 10 finding.
     */
    const raw = await executeTool(tool, step.inputs || {}, approval,
      { source: approvedSource, autoApprove: Boolean(autoApprove) },
      { sessionId, turnSeq });

    let verification = null;
    if (mutating) {
      setStepState(plan.taskId, step.id, 'verifying');
      emit({ type: 'step_verification_started', step: step.id });
      try {
        const d = typeof tool.describeWrite === 'function' ? tool.describeWrite(step.inputs || {}, raw) : null;
        verification = await verifyMutation({ descriptor: d, result: raw, before, toolName: step.tool });
      } catch (err) {
        verification = {
          verified: false, status: 'unverified', summary: `the write could not be verified: ${err.message}`,
          applied: [], dropped: [], transformed: [], unverifiable: [{ field: '(all)', reason: err.message }], noOpSignal: null,
        };
      }
    }

    const failed = isFailedWrite(verification);
    const output = attachVerification(JSON.stringify(raw ?? null, null, 1), verification);

    recordToolEvent(sessionId, {
        taskId: plan.taskId,
      kind: 'tool_call', name: step.tool, payload: step.inputs, result: output,
      resultStatus: verification && verification.status !== 'applied' && verification.status !== 'self-verified'
        ? verification.status : 'ok',
      mutating, approval, approvedSource, approvedAt,
    });

    if (mutating) {
      const d = typeof tool.describeWrite === 'function' ? tool.describeWrite(step.inputs || {}, raw) : null;
      if (d && verification?.dropped?.length) {
        recordDrops({ sessionId, turnSeq, table: d.table, sys_id: d.sys_id, operation: d.operation, verification });
      }
      appendMutation({
        sessionId, turnSeq, tool: step.tool, descriptor: d, result: raw,
        verification, approval, approvedSource, approvedAt,
        // PHASE 8 — this write belongs to THIS task, exactly. Not to whatever
        // else happened to be running in the same session at the same moment.
        taskId: plan.taskId,
      });
      try {
        const captured = await captureAfterTool({
          sessionId, sessionTitle: null, toolName: step.tool,
          input: step.inputs || {}, result: raw, since: mark,
          taskId: plan.taskId,   // PHASE 8 — the capture belongs to this task too
        });
        if (captured) emit({ ...captured, step: step.id });
      } catch (err) { log.warn('plan', `capture failed after step ${step.id}: ${err.message}`); }
    }

    recordStepResult(plan.taskId, step.id, {
      result: raw, verification,
      approval: approval ? { approval, source: approvedSource, at: approvedAt } : null,
    });

    if (failed) {
      const note = `${step.operation} did not land as requested: ${verification.summary}`;
      log.warn('plan', `step ${step.id} ${verification.status.toUpperCase()} — ${verification.summary}`);
      emit({ type: 'step_failed', step: step.id, reason: verification.status, note, verification });
      setStepState(plan.taskId, step.id, 'failed', { failure_reason: note });
      // Phase 7 — the descriptor travels with the failure so recovery can
      // classify and reconcile it. Additive: nothing that read this before
      // reads less.
      return { ok: false, state: 'failed', note, verification, descriptor };
    }

    /*
     * PHASE 12 — the step's DECLARED outputs, captured for later consumers.
     *
     * Only what the tool declared, read only where the tool said to read it —
     * never a copy of the whole result. Durable, so a reference still resolves
     * after a restart. Recorded only on the success path: a step that did not
     * complete produced nothing a consumer may rely on.
     */
    const produced = extractOutputs(step.tool, raw);
    if (produced) {
      recordStepOutputs(plan.taskId, step.id, produced);
      emit({ type: 'step_outputs', step: step.id, outputs: Object.keys(produced) });
    }

    log.info('plan', `step ${step.id} ok  ${ms(started)}`);
    emit({ type: 'step_verified', step: step.id, verification: verification ?? null });
    emit({ type: 'step_completed', step: step.id, operation: step.operation });
    setStepState(plan.taskId, step.id, 'completed');
    return { ok: true, state: 'completed', result: raw, verification };
  } catch (err) {
    const note = `${step.operation} failed: ${err.message}`;
    log.error('plan', `step ${step.id} failed — ${err.message}`, err.detail || err);
    recordToolEvent(sessionId, {
        taskId: plan.taskId,
      kind: 'tool_call', name: step.tool, payload: step.inputs, result: note,
      resultStatus: 'error', mutating, approval, approvedSource, approvedAt,
    });
    recordStepResult(plan.taskId, step.id, { failureReason: note });
    emit({ type: 'step_failed', step: step.id, reason: 'error', note });
    setStepState(plan.taskId, step.id, 'failed', { failure_reason: note });
    /*
     * Phase 7 — the STRUCTURED error, carried rather than flattened to prose.
     *
     * Recovery classifies from `status` and from `diagnoseFailure`'s verdict in
     * `detail`, and both are lost the moment this becomes a string. The message
     * stays too, because it is what a human reads.
     */
    return {
      ok: false, state: 'failed', note, descriptor,
      error: { status: err.status ?? null, message: err.message, detail: err.detail ?? null },
    };
  }
}

/**
 * Execute an approved plan, in dependency order.
 *
 * Every iteration re-reads the plan from the database and re-checks the
 * approval binding, so a plan that changed mid-run stops rather than finishing
 * under an approval that no longer describes it.
 */
/**
 * PHASE 15 — every step that transitively depends on this one.
 *
 * Used only by `continueOnStepFailure`, to skip exactly the steps a failure
 * actually orphaned and no others. Computed from `depends_on`, which the
 * validator has already proved acyclic, so the walk terminates.
 */
function dependentsOf(stepId, order) {
  const out = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of order) {
      if (out.has(s.id) || s.id === stepId) continue;
      const deps = Array.isArray(s.depends_on) ? s.depends_on : [];
      if (deps.some((d) => d === stepId || out.has(d))) {
        out.add(s.id);
        changed = true;
      }
    }
  }
  return [...out];
}

export async function executePlan({
  taskId, sessionId, turnSeq = 0, emit = () => {}, signal = null, autoApprove = false,
  /*
   * PHASE 7 — RECOVERY, INJECTED.
   *
   * A small interface, not an import. This module knows nothing about how a
   * failure is classified, what the policy table says, or how idempotency is
   * established — it hands a failure over and handles the five decisions that
   * can come back. Wiring the two together is the ROUTE'S job, which is what
   * keeps the executor free of recovery internals.
   *
   * `null` is the Phase 4 behaviour, unchanged and byte-for-byte: a failed step
   * fails the plan. Every test written before this phase passes no recoverer
   * and therefore exercises exactly the path it always did.
   */
  recoverStep = null,
  /*
   * PHASE 15 — CONTINUE PAST A FAILED READ, and only ever past a read.
   *
   * MEASURED, and it made the whole phase useless before it was fixed. A
   * ten-step investigation of a real incident completed ONE step: step_2
   * referenced `step_1.result.assignment_group`, that incident had no
   * assignment group, the reference correctly refused to resolve — and the
   * plan failed, skipping the audit, journal, SLA and automation reads that
   * depended on step_1 alone and would all have succeeded.
   *
   * An incident with no assignment group is ORDINARY. In an investigation a
   * reference that leads nowhere is a gap in the evidence, not a broken plan,
   * and `gapsFrom` already knows how to report one.
   *
   * WHY THIS IS SAFE HERE AND NOWHERE ELSE. The executor fails a plan on the
   * first failed step because a half-applied CHANGE is dangerous: some records
   * modified, some not, and no way to tell which. That reasoning does not apply
   * when no step can change anything. So this option is refused outright unless
   * every step is read-only by the registry's account — the flag cannot be used
   * to half-apply a mutation because a plan that could mutate will not accept
   * it.
   *
   * Only the failed step's DEPENDENTS are skipped. A sibling that needed
   * nothing from it still runs, which is the entire point.
   */
  continueOnStepFailure = false,
} = {}) {
  const cancelled = () => Boolean(signal?.aborted);
  let plan = loadPlan(taskId);
  if (!plan) return { ok: false, reason: 'no_such_plan' };

  /*
   * The invariant above, enforced before a single step runs. A caller that asks
   * to continue past failures on a plan that can write is refused, not
   * quietly downgraded — silently ignoring the flag would leave the caller
   * believing it was in effect.
   */
  if (continueOnStepFailure) {
    const canWrite = mutatingSteps(plan);
    if (canWrite.length) {
      const note = `Refusing to continue past step failures on a plan that can change the instance: `
        + `${canWrite.map((v) => `${v.step} (${v.tool})`).join(', ')}. `
        + 'Continuing past a failure is only safe when no step can write.';
      setPlanState(taskId, 'failed', { failure_reason: note });
      emit({ type: 'plan_failed', taskId, reason: 'continue_on_failure_requires_read_only', note });
      return { ok: false, reason: 'continue_on_failure_requires_read_only', note };
    }
  }

  const ordered = executionOrder(plan.steps);
  if (!ordered.ok) {
    const note = `The plan's steps cannot be ordered: ${ordered.reason}.`;
    setPlanState(taskId, 'failed', { failure_reason: note });
    emit({ type: 'plan_failed', taskId, reason: ordered.reason, note });
    return { ok: false, reason: ordered.reason, note };
  }

  const results = [];
  /* Steps already accounted for by a failure upstream, and why. */
  const skipped = new Set();
  const blocked = new Map();
  for (const planned of ordered.order) {
    if (skipped.has(planned.id)) continue;
    /* Phase 0 boundary: between steps, never inside one. */
    if (cancelled()) {
      const note = 'The plan was cancelled; no further steps were started.';
      log.warn('plan', `plan ${shortId(taskId)} cancelled after ${results.length} step(s)`);
      for (const s of ordered.order.slice(results.length)) setStepState(taskId, s.id, 'cancelled');
      setPlanState(taskId, 'cancelled');
      emit({ type: 'plan_cancelled', taskId, completed: results.length, note });
      return { ok: false, reason: 'cancelled', results, note };
    }

    // THE BINDING, re-checked before every step.
    const bound = checkApprovalBinding(taskId);
    if (!bound.ok) {
      log.error('plan', `plan ${shortId(taskId)} refused at step ${planned.id}: ${bound.reason}`);
      setPlanState(taskId, 'failed', { failure_reason: bound.note ?? bound.reason });
      emit({ type: 'plan_failed', taskId, reason: bound.reason, note: bound.note ?? bound.reason, step: planned.id });
      return { ok: false, reason: bound.reason, note: bound.note, results };
    }

    // Re-read, so a step's stored inputs are what actually run.
    plan = loadPlan(taskId);
    const step = plan.steps.find((s) => s.id === planned.id);
    if (!step) continue;
    if (step.state !== 'pending' && step.state !== 'ready') {
      results.push({ step: step.id, state: step.state, skipped: true });
      continue;
    }

    setStepState(taskId, step.id, 'ready');

    /*
     * PHASE 12 — RESOLUTION, and why it belongs exactly here.
     *
     * The step as stored holds the REFERENCE — `{ "$ref": "step_1.result.sys_id" }`
     * — and that reference is what was fingerprinted and what a human approved.
     * The value it names does not exist until the producer has run, so it is
     * supplied now, from the producer's own recorded output.
     *
     * THIS IS NOT POST-APPROVAL NORMALISATION. Nothing about the plan is
     * rewritten or repaired: the stored plan still says `$ref`, the approval
     * still binds that reference, and every resolved value is traceable to the
     * declared reference it came from. What a person authorised was "the record
     * step 1 finds", and that is precisely what runs.
     *
     * IT IS ALSO NOT A SECOND EXECUTION PATH. Resolution produces arguments and
     * stops. `runStep` below is the same function, with the same guards, gate,
     * verifier and ledger — it simply receives a step whose references have
     * become values.
     *
     * EVERY FAILURE STOPS. A producer that failed, was cancelled, or never
     * recorded the output leaves the reference unresolved, and an unresolved
     * reference fails the step. Nothing is substituted for a missing value.
     */
    let executable = step;
    let dataflow = null;
    const refs = findReferences(step);
    if (refs.length) {
      const producers = new Set();
      for (const r of refs) {
        const id = String(r.raw).split('.')[0];
        if (id) producers.add(id);
      }

      // A producer must be in a state that produced something usable.
      const unusable = [];
      const outputsByStep = {};
      for (const id of producers) {
        const producerStep = plan.steps.find((x) => x.id === id) ?? null;
        const usable = producerIsUsable(producerStep);
        if (!usable.ok) { unusable.push({ producer: id, ...usable }); continue; }
        outputsByStep[id] = stepOutputs(taskId, id) ?? {};
      }

      if (unusable.length) {
        const first = unusable[0];
        const note = `Step ${step.id} needs a value from ${first.producer}, which is ${first.state ?? 'not finished'}. `
          + 'A step that did not complete produced nothing to read, and nothing is substituted for it.';
        log.warn('plan', `step ${step.id} blocked — producer ${first.producer} is ${first.state}`);
        recordToolEvent(sessionId, {
          taskId,
          kind: 'guard', name: 'dataflow_producer_unusable',
          payload: { step: step.id, producer: first.producer, producerState: first.state ?? null, code: first.code },
          result: note, resultStatus: 'blocked', mutating: false, approval: null,
        });
        emit({ type: 'step_failed', step: step.id, reason: first.code, note });
        setStepState(taskId, step.id, 'failed', { failure_reason: note });
        results.push({ step: step.id, ok: false, state: 'failed', note });

        if (continueOnStepFailure) {
          /*
           * Skip what genuinely depended on this step, transitively, and carry
           * on with everything else. `blocked` records why, so the diagnosis
           * can say "this read never ran because the one before it found
           * nothing" rather than leaving a silent hole.
           */
          const orphaned = dependentsOf(step.id, ordered.order);
          for (const sk of orphaned) {
            setStepState(taskId, sk, 'skipped');
            blocked.set(sk, `it depended on ${step.id}, which could not resolve its inputs`);
          }
          skipped.add(step.id);
          for (const sk of orphaned) skipped.add(sk);
          continue;
        }

        const remaining = ordered.order.slice(results.length);
        for (const sk of remaining) setStepState(taskId, sk.id, 'skipped');
        setPlanState(taskId, 'failed', { failure_reason: note });
        emit({
          type: 'plan_failed', taskId, step: step.id, reason: first.code, note,
          completed: results.filter((r) => r.ok).length, skipped: remaining.length,
          replanRequired: false, recovery: null,
        });
        return { ok: false, reason: first.code, step: step.id, note, results, replanRequired: false, recovery: null };
      }

      const resolved = resolveReferences(step, outputsByStep);
      if (!resolved.ok) {
        const first = resolved.problems[0];
        const note = `Step ${step.id} could not resolve ${first.path}: ${first.message}`;
        log.warn('plan', `step ${step.id} blocked — ${first.code}`);
        recordToolEvent(sessionId, {
          taskId,
          kind: 'guard', name: 'dataflow_unresolved',
          payload: { step: step.id, problems: resolved.problems },
          result: note, resultStatus: 'blocked', mutating: false, approval: null,
        });
        emit({ type: 'step_failed', step: step.id, reason: first.code, note });
        setStepState(taskId, step.id, 'failed', { failure_reason: note });
        results.push({ step: step.id, ok: false, state: 'failed', note });

        /*
         * The SECOND of the two ways a reference can fail, and the one that
         * matters most in practice: the producer ran fine, but the value it
         * produced is empty. An incident with no assignment group reaches here,
         * and before this branch existed it took the whole investigation down
         * with it — nine further reads skipped, eight of which needed nothing
         * from this step.
         */
        if (continueOnStepFailure) {
          const orphaned = dependentsOf(step.id, ordered.order);
          for (const sk of orphaned) {
            setStepState(taskId, sk, 'skipped');
            blocked.set(sk, `it depended on ${step.id}, which could not resolve its inputs`);
          }
          skipped.add(step.id);
          for (const sk of orphaned) skipped.add(sk);
          continue;
        }

        const remaining = ordered.order.slice(results.length);
        for (const sk of remaining) setStepState(taskId, sk.id, 'skipped');
        setPlanState(taskId, 'failed', { failure_reason: note });
        emit({
          type: 'plan_failed', taskId, step: step.id, reason: first.code, note,
          completed: results.filter((r) => r.ok).length, skipped: remaining.length,
          replanRequired: false, recovery: null,
        });
        return { ok: false, reason: first.code, step: step.id, note, results, replanRequired: false, recovery: null };
      }

      executable = { ...step, inputs: resolved.args, target: resolved.target };
      dataflow = resolved.resolutions;
      // The resolution is recorded on the step, so evidence can show the
      // declared reference beside the value it became.
      recordStepDataflow(taskId, step.id, dataflow);
      emit({
        type: 'step_dataflow_resolved',
        step: step.id,
        resolutions: dataflow.map((r) => ({ path: r.path, declared: r.declared })),
      });
    }

    const outcome = await runStep({
      plan, step: executable, sessionId, turnSeq, emit, signal, autoApprove, dataflow,
    });
    results.push({ step: step.id, ...outcome });

    /*
     * PHASE 7 — THE INTEGRATION POINT, and the only one.
     *
     * Deliberately here rather than inside `runStep`: this is where a step
     * failure became a plan failure, so it is the narrowest boundary at which
     * recovery can be considered. The whole mutation path above — guards, gate,
     * execution, read-back, ledger, capture — is untouched, and a retry
     * re-enters it through `runStep` rather than around it.
     *
     * TWO OUTCOMES ARE NOT FAILURES AND NEVER REACH RECOVERY.
     *
     * A CANCELLATION is excluded by `state === 'failed'` — Phase 0 gives it its
     * own state precisely so it cannot be mistaken for something that went
     * wrong.
     *
     * A REJECTION is excluded explicitly, because it does not have its own
     * state: `runStep` returns `failed` with `rejected: true`. A person looked
     * at this operation and said no. Handing that to recovery would put the
     * same card back in front of them, which is a refusal being re-asked until
     * it changes — the exact shape Phase 4 forbids. Nothing failed here; the
     * control worked.
     */
    if (!outcome.ok && recoverStep && outcome.state === 'failed' && !outcome.rejected) {
      const recovery = await recoverStep({
        taskId,
        stepId: step.id,
        sessionId,
        error: outcome.error ?? null,
        descriptor: outcome.descriptor ?? null,
        signal,
        emit,
        /*
         * THE RETRY RE-ENTERS THE EXISTING PIPELINE.
         *
         * Recovery is handed this closure rather than any ability to execute.
         * It calls `runStep` — the same function, with the same guards, the
         * same approval gate, the same verifier and the same ledger — on a
         * FRESHLY LOADED plan, so a retry is subject to everything the first
         * attempt was. There is no path from recovery to a write that does not
         * go through here.
         */
        executeStep: async ({ signal: retrySignal } = {}) => {
          const fresh = loadPlan(taskId);
          const freshStep = fresh?.steps.find((x) => x.id === step.id);
          if (!freshStep) return { ok: false, note: 'the step disappeared before the retry' };
          setStepState(taskId, step.id, 'ready');
          /*
           * PHASE 12 — A RETRY RE-USES THE ARGUMENTS, IT DOES NOT RE-RESOLVE.
           *
           * The step reloaded from storage still holds the `$ref`, because that
           * is what was fingerprinted. Handing it to `runStep` unresolved would
           * send a reference object to the tool; re-resolving it here would be
           * a second, unapproved decision about which record to touch — and if
           * the producer's output had changed in between, the retry would hit a
           * different record than the one approved.
           *
           * So the already-resolved arguments are carried across verbatim.
           * Everything else about the step comes from the fresh row.
           */
          return runStep({
            plan: fresh,
            step: { ...freshStep, inputs: executable.inputs, target: executable.target },
            sessionId, turnSeq, emit,
            signal: retrySignal ?? signal, autoApprove, dataflow,
          });
        },
      });

      /* The five decisions, each handled explicitly. */
      if (recovery.outcome === 'RECOVERED') {
        // The retry executed AND verified — the existing verifier said so, and
        // recovery cannot overrule it. The step's own state is already
        // `completed`, set by runStep.
        log.info('plan', `step ${step.id} recovered on attempt ${(recovery.decision?.attempt ?? 1) + 1}`);
        results[results.length - 1] = { step: step.id, ok: true, state: 'completed', recovered: true, recovery };
        continue;
      }
      // Everything else leaves the failure standing, and carries WHY the
      // recovery did not happen into the plan's own failure record.
      outcome.recovery = recovery;
      outcome.note = `${outcome.note} | recovery: ${recovery.decision?.decision ?? recovery.outcome} — ${recovery.reason}`;
      results[results.length - 1] = { step: step.id, ...outcome };
      /*
       * WAIT_FOR_APPROVAL AND MANUAL_INTERVENTION BOTH END THE RUN.
       *
       * The temptation is to park the plan in `awaiting_approval` — the state
       * exists, and `executing -> awaiting_approval` is a legal edge. It would
       * be wrong. Nothing in this phase resumes a parked plan, so the plan would
       * sit in a non-terminal state forever and the stream would close without
       * a terminal frame, breaking the invariant the whole transport rests on.
       *
       * So the plan fails, and the reason says a person has to decide. That is
       * the true statement: this run is over, and what happens next is a human's
       * call, made through the ordinary plan -> approve path.
       */
      if (recovery.decision?.decision === 'REPLAN') outcome.replanRequired = true;
    }

    if (!outcome.ok) {
      // No automatic alternative mechanism, no rollback. The plan fails with
      // the reason, and anything already written stays written and recorded.
      const remaining = ordered.order.slice(results.length);
      for (const s of remaining) setStepState(taskId, s.id, 'skipped');
      const terminal = outcome.state === 'cancelled' ? 'cancelled' : 'failed';
      setPlanState(taskId, terminal, terminal === 'failed' ? { failure_reason: outcome.note } : {});
      emit({
        type: terminal === 'cancelled' ? 'plan_cancelled' : 'plan_failed',
        taskId, step: step.id, reason: outcome.state, note: outcome.note,
        completed: results.filter((r) => r.ok).length, skipped: remaining.length,
        // Phase 7 — surfaced, never acted on. The caller runs the ordinary
        // plan -> validate -> fingerprint -> review -> approve path.
        replanRequired: outcome.replanRequired === true,
        recovery: outcome.recovery
          ? {
            decision: outcome.recovery.decision?.decision ?? null,
            failure: outcome.recovery.decision?.failure?.kind ?? null,
            reason: outcome.recovery.reason,
            attempts: outcome.recovery.decision?.attempt ?? null,
          }
          : null,
      });
      return {
        ok: false, reason: outcome.state, step: step.id, note: outcome.note, results,
        replanRequired: outcome.replanRequired === true,
        recovery: outcome.recovery ?? null,
      };
    }
  }

  setPlanState(taskId, 'completed');
  emit({ type: 'plan_completed', taskId, steps: results.length });
  log.info('plan', `plan ${shortId(taskId)} completed — ${results.length} step(s)`);
  return { ok: true, results };
}
