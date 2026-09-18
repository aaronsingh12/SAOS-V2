import crypto from 'node:crypto';
import { Router } from 'express';
import { log } from '../logging.js';
import { createSession, getSession, sessionBelongsToCurrentInstance } from '../memory/sessions.js';
import { createTask, startTask, completeTask, failTask, cancelTask } from '../memory/tasks.js';
import {
  generatePlan, validatePlan, savePlan, loadPlan, setPlanState,
  approvePlan, buildReview, executePlan, mutatingSteps,
} from '../agent/plan/index.js';
import { recordDiagnosis, recordLint, recordTest, recordChange, loadCapturedBaseline } from '../agent/plan/store.js';
import { diagnose } from '../agent/doctor/index.js';
import { makeContext, lintFlow, renderLint, emptyResult as emptyLintResult, RULE_IDS } from '../agent/lint/index.js';
import { testFlow, renderTest } from '../agent/test/index.js';
import { compareFlow, renderComparison } from '../agent/change/index.js';
import { ask, knowledgeFor, fromLiveReading, renderAnswer } from '../agent/knowledge/index.js';
import { buildApplication, renderBuild } from '../agent/appbuild/index.js';
import { recordAppBuild } from '../agent/plan/store.js';
import { validateScopeName, vendorPrefix, MAX_SCOPE_LENGTH } from '../servicenow/app-create.js';
import { toolMap } from '../agent/tools.js';
import { currentInstance } from '../memory/facts.js';
import { triggerOf, isDisposable } from '../agent/test/index.js';
import { flowExecutionsFor } from '../servicenow/diagnostics.js';
import { findFlow, readFlowArtifact } from '../servicenow/flow-artifact.js';
import { resolveFlowForRequest } from '../agent/lint/intent.js';
import { getSchema } from '../servicenow/schema.js';
import { derivationOf } from '../servicenow/semantic/tables.js';
import { discoverAll } from '../agent/capability-discovery.js';
import { chatOnce } from '../agent/providers/index.js';
import { codegenDecoding } from '../agent/decoding.js';
import { awaitApprovalDecision, resolveApproval, APPROVAL_SOURCES } from '../agent/orchestrator.js';
import { getSettings } from '../config/store.js';
import { buildEvidence } from '../agent/evidence/index.js';
import { activityForTask, taskHistory } from '../agent/activity/index.js';
import { recoverStep } from '../agent/recovery/index.js';
import { table } from '../servicenow/client.js';

export const planRouter = Router();

/**
 * PHASE 4 — the plan route: propose, review, approve, execute, verify.
 *
 * ADDITIVE. `POST /api/agent/chat` is untouched and still runs the ordinary
 * turn loop; this is a second, opt-in entry point for work that should be
 * planned before it is done. Replacing the chat path would have meant
 * redesigning the agent, which this phase is explicitly not for.
 *
 * IT REUSES EVERYTHING. The task comes from Phase 1, the capability and
 * semantic checks from Phase 3, the approval gate and its nonce from Phase 0's
 * hardening, and execution from the existing tool/guard/verify pipeline. What
 * this file adds is the ORDER those run in, and the SSE frames that let a
 * client watch it.
 *
 * SSE IS TRANSPORT, NOT STATE. Every frame here is a projection of the durable
 * plan, and a client that reconnects reads the plan back rather than replaying
 * the stream — which is why `GET /:taskId` exists.
 */

/** The terminal-frame invariant, same as the chat route: exactly one, always. */
function streamOf(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return (event) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client gone */ }
  };
}

/**
 * POST /api/agent/plan  { sessionId, message }
 *
 * The whole pipeline, streamed.
 */
planRouter.post('/', async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId || !message) {
    return res.status(400).json({ message: 'sessionId and message are required' });
  }
  if (!getSession(sessionId)) createSession({ id: sessionId });

  const emit = streamOf(res);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);

  /*
   * Phase 0's cancellation, unchanged: one controller per request, aborted when
   * the client goes away, checked by the executor at step boundaries only.
   */
  const controller = new AbortController();
  let settled = false;
  const onClientGone = () => { if (!settled && !res.writableEnded) controller.abort(); };
  res.on('close', onClientGone);

  // The task is Phase 1's, so a plan lives in the same durable place a turn does.
  const task = createTask({ sessionId, goal: message, metadata: { planned: true } });
  if (!task) {
    emit({ type: 'plan_failed', reason: 'no_task', note: 'The task record could not be created, so nothing was planned.' });
    settled = true; clearInterval(keepAlive); res.end();
    return undefined;
  }
  startTask(task.id);

  try {
    /* ---- PLAN ---- */
    emit({ type: 'plan_started', taskId: task.id, goal: message });
    const generated = await generatePlan({ goal: message, signal: controller.signal });
    if (!generated.ok) {
      setPlanState(task.id, 'failed', { failure_reason: generated.note ?? generated.reason });
      failTask(task.id, generated.note ?? generated.reason);
      emit({
        type: 'plan_failed', taskId: task.id, reason: generated.reason,
        note: generated.note ?? null,
        // The refusals a human can act on, named rather than summarised.
        problems: (generated.fatal ?? []).map((p) => ({ code: p.code, step: p.step, message: p.message })),
      });
      return undefined;
    }

    const saved = savePlan(task.id, generated.plan);
    if (!saved.ok) {
      setPlanState(task.id, 'failed', { failure_reason: saved.error });
      failTask(task.id, saved.error);
      emit({ type: 'plan_failed', taskId: task.id, reason: 'not_saved', note: saved.error });
      return undefined;
    }
    setPlanState(task.id, 'ready');
    emit({ type: 'plan_created', taskId: task.id, fingerprint: saved.fingerprint, steps: saved.steps });

    /* ---- REVIEW ---- */
    const review = buildReview(generated.plan, { fingerprint: saved.fingerprint, discovered: generated.discovered });
    emit({ type: 'plan_ready', taskId: task.id, review });

    if (!review.approvalRequired) {
      // A read-only plan needs no card. It still passes through the state
      // machine, because the machine is what makes "nothing was approved
      // because nothing needed approving" a recorded fact.
      setPlanState(task.id, 'executing', {
        approved_fingerprint: saved.fingerprint,
        approved_at: new Date().toISOString(),
        approved_source: 'read_only_plan',
      });
    } else {
      setPlanState(task.id, 'awaiting_review');
      emit({ type: 'review_required', taskId: task.id, fingerprint: saved.fingerprint, review });
      setPlanState(task.id, 'awaiting_approval');

      /* ---- APPROVE ---- through the existing gate, bound to the fingerprint */
      const approvalId = crypto.randomUUID();
      const nonce = crypto.randomBytes(32).toString('base64url');
      emit({
        type: 'approval_required', approvalId, nonce,
        name: 'execute this plan',
        input: { goal: review.goal, steps: review.steps.length, changes: review.plannedChanges.length },
        plan: { taskId: task.id, fingerprint: saved.fingerprint },
        warning: review.destructive.length
          ? `${review.destructive.length} step(s) cannot be undone.`
          : null,
      });
      const decision = await awaitApprovalDecision(sessionId, approvalId, nonce, controller.signal);
      emit({ type: 'approval_resolved', approvalId, approved: decision.approved, source: decision.source, at: decision.at });

      if (decision.source === 'cancelled') {
        setPlanState(task.id, 'cancelled');
        cancelTask(task.id);
        emit({ type: 'plan_cancelled', taskId: task.id, note: 'The plan was cancelled before it was approved. Nothing ran.' });
        return undefined;
      }
      if (!decision.approved) {
        // A rejection ends it. It is never turned into a retry.
        const note = decision.source === 'timeout'
          ? 'The plan was never answered and the approval expired. Nothing ran.'
          : 'The plan was rejected. Nothing ran, and it will not be retried.';
        setPlanState(task.id, 'failed', { failure_reason: note });
        failTask(task.id, note);
        emit({ type: 'plan_failed', taskId: task.id, reason: 'rejected', note });
        return undefined;
      }

      // The binding. If the plan moved between the card and the click, this
      // refuses rather than executing whatever it says now.
      const bound = approvePlan(task.id, saved.fingerprint, { source: decision.source, at: decision.at });
      if (!bound.ok) {
        const note = bound.reason === 'fingerprint_mismatch'
          ? 'The plan changed after it was shown to you, so this approval does not apply to it. Nothing ran; plan again.'
          : `The plan could not be approved (${bound.reason}).`;
        setPlanState(task.id, 'failed', { failure_reason: note });
        failTask(task.id, note);
        emit({ type: 'plan_failed', taskId: task.id, reason: bound.reason, note });
        return undefined;
      }
    }

    /* ---- EXECUTE + VERIFY ---- */
    const { agent } = getSettings();
    const result = await executePlan({
      taskId: task.id,
      sessionId,
      turnSeq: 0,
      emit,
      signal: controller.signal,
      autoApprove: Boolean(agent.autoApprove),
      /*
       * PHASE 7 — THE TWO HALVES ARE JOINED HERE, AND ONLY HERE.
       *
       * The executor takes recovery as a parameter and imports none of it; the
       * recovery engine takes its execution surface as a parameter and imports
       * none of the executor. Neither can reach the other on its own, so the
       * composition is a deliberate act at the edge of the system rather than a
       * dependency buried in either module. The boundary tests assert both
       * directions on the import graph.
       *
       * `readRecord` is the reconciliation read, supplied from the SAME client
       * the mutation pipeline snapshots with. Recovery performs no I/O of its
       * own; without this it simply does not reconcile, and then refuses to
       * repeat anything rather than assuming the effect is absent.
       */
      recoverStep: (args) => recoverStep({
        ...args,
        readRecord: ({ table: t, sys_id: sysId }) => table.get(t, sysId, 'all'),
      }),
    });

    // The plan's own terminal frame has already been emitted by the executor;
    // the TASK's Phase 1 lifecycle is closed here to match.
    if (result.ok) completeTask(task.id);
    else if (result.reason === 'cancelled') cancelTask(task.id);
    else failTask(task.id, result.note ?? result.reason);
    return undefined;
  } catch (err) {
    log.error('plan', `the plan stream failed outside the pipeline — ${err.message}`, err);
    try { setPlanState(task.id, 'failed', { failure_reason: err.message }); } catch { /* already failing */ }
    try { failTask(task.id, err.message); } catch { /* already failing */ }
    emit({ type: 'plan_failed', taskId: task.id, reason: 'error', note: err.message });
    return undefined;
  } finally {
    clearInterval(keepAlive);
    settled = true;
    res.off('close', onClientGone);
    res.end();
  }
});

/**
 * GET /api/agent/plan/:taskId
 *
 * The reconnect path. A client that lost the stream reads the plan back and
 * rebuilds exactly what it was showing — which is only possible because the
 * database, not the stream, is the source of truth.
 */
planRouter.get('/:taskId', (req, res, next) => {
  const plan = loadPlan(req.params.taskId);
  if (!plan) return next(Object.assign(new Error('No such plan.'), { status: 404 }));
  return res.json({
    ...plan,
    review: plan.proposed ? buildReview(plan.proposed, { fingerprint: plan.fingerprint }) : null,
    // The live step states, which is what a reconnecting client actually needs.
    progress: {
      total: plan.steps.length,
      completed: plan.steps.filter((s) => s.state === 'completed').length,
      failed: plan.steps.filter((s) => s.state === 'failed').length,
      skipped: plan.steps.filter((s) => s.state === 'skipped').length,
      current: plan.steps.find((s) => ['executing', 'verifying', 'awaiting_approval'].includes(s.state))?.id ?? null,
    },
  });
});

/**
 * GET /api/agent/plan/:taskId/evidence
 *
 * PHASE 5 — the durable evidence projection. READ-ONLY.
 *
 * Mounted here rather than on its own router because evidence is about a task,
 * and a task is what this route creates — a second endpoint elsewhere would be
 * a duplicate address for one concept.
 *
 * It performs no mutation, consults no model, and needs nothing in memory: the
 * whole object is projected from the database, so it answers identically after
 * a restart and after the originating chat has been deleted. Phase 1 gave tasks
 * no foreign key to sessions precisely so that stays true.
 *
 * A task that does not exist is a deterministic 404, never an empty evidence
 * object — "this task did nothing" and "there is no such task" are different
 * answers and must not render the same.
 */
planRouter.get('/:taskId/evidence', (req, res, next) => {
  const evidence = buildEvidence(req.params.taskId);
  if (!evidence) return next(Object.assign(new Error('No such task.'), { status: 404 }));
  return res.json(evidence);
});

/**
 * GET /api/agent/plan/:taskId/activity[?since=N]
 *
 * EXPERIENCE §6/§10/§58 — the durable activity timeline. READ-ONLY.
 *
 * MOUNTED HERE, beside evidence, for the reason evidence gives for being here:
 * activity is about a task, and a task is what this router creates. A second
 * address for one concept would be a second thing to keep in step.
 *
 * WHAT IT IS FOR. Three moments, all of which are the same request:
 *
 *   the browser refreshed              (§58 — reconstruct exactly)
 *   the stream dropped and reconnected (§10 — recover, continue, no duplicates)
 *   a past task was reopened           (§51/§52 — show history, re-execute nothing)
 *
 * §52 is the one worth being explicit about: this is a SELECT. There is no path
 * from here to the executor, the approval gate or a ServiceNow call, so opening
 * a completed task cannot re-run a single thing it did — which is a property of
 * the code rather than a promise about how the component is mounted.
 *
 * `since` is the cursor from a previous response, and the events are the ones
 * numbered after it. The numbering comes from the tables' own deterministic
 * ordering, so asking twice with the same cursor returns the same events and
 * §11's duplicate can never be constructed.
 *
 * A task that does not exist is a 404, never an empty timeline — the same
 * distinction the evidence route above draws, for the same reason.
 */
planRouter.get('/:taskId/activity', (req, res, next) => {
  const since = req.query.since === undefined ? null : Number(req.query.since);
  if (since !== null && !Number.isFinite(since)) {
    return next(Object.assign(new Error('since must be a number.'), { status: 400 }));
  }
  const activity = activityForTask(req.params.taskId, { since });
  if (!activity) return next(Object.assign(new Error('No such task.'), { status: 404 }));
  return res.json(activity);
});

/**
 * GET /api/agent/plan/history/:sessionId
 *
 * EXPERIENCE §51 — past tasks for a chat, newest first.
 *
 * Built on `agent_tasks`, which §51 asks for in as many words: use the existing
 * durable task data, do not create another task database. No timeline is
 * loaded — a list of a dozen lines has no business reading a thousand rows —
 * and opening one fetches its activity through the route above.
 *
 * TWO SEGMENTS, which is what keeps it unambiguous: `/:taskId` matches one
 * segment and cannot claim `/history/<id>`, and the sibling two-segment routes
 * end in the literals `evidence` and `activity`. So this is reachable wherever
 * it is mounted — but adding a one-segment route named `history` later would
 * not be, and that is the trap worth naming rather than discovering.
 */
planRouter.get('/history/:sessionId', (req, res) => {
  if (!sessionBelongsToCurrentInstance(req.params.sessionId)) {
    return res.status(404).json({ message: 'No task history for this session on this instance.' });
  }
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  return res.json({ tasks: taskHistory(req.params.sessionId, { limit }) });
});

/**
 * POST /api/agent/plan/diagnose  { sessionId, message }
 *
 * PHASE 14 — the ServiceNow Doctor, streamed.
 *
 * ADDITIVE, in exactly the way the plan route itself was: `POST /` is
 * untouched and still plans work to be DONE; this plans work to be UNDERSTOOD.
 * Nothing here is a second pipeline — read the handler and every collaborator
 * it passes to `diagnose` is a function this file already imported for the
 * remediation path above.
 *
 * THE ONE DIFFERENCE THAT MATTERS is `mutatingSteps`, handed in as
 * `plan.violations`. That is what makes the mode real: the Doctor cannot
 * execute a plan the registry says would write, and the check happens twice —
 * once at validation and once against the STORED plan, because `savePlan` does
 * not validate.
 *
 * The terminal-frame invariant is honoured the same way the rest of this file
 * honours it: exactly one of `diagnosis_complete` or `plan_failed` leaves here.
 */
planRouter.post('/diagnose', async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId || !message) {
    return res.status(400).json({ message: 'sessionId and message are required' });
  }
  if (!getSession(sessionId)) createSession({ id: sessionId });

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const emit = streamOf(res);

  const task = createTask({ sessionId, goal: message });
  startTask(task.id);
  emit({ type: 'task_started', taskId: task.id });

  try {
    const diagnosis = await diagnose({
      request: message,
      taskId: task.id,
      sessionId,
      /* Every one of these is the existing implementation, injected. */
      generate: generatePlan,
      chat: chatOnce,
      run: (opts) => executePlan({ ...opts, recoverStep }),
      plan: {
        save: savePlan,
        load: loadPlan,
        setState: setPlanState,
        review: buildReview,
        violations: mutatingSteps,
      },
      record: recordDiagnosis,
      decoding: codegenDecoding(),
      signal: controller.signal,
      emit,
    });

    /*
     * A stopped diagnosis is still a completed REQUEST. The run did what it
     * could and said why it stopped, which is a result rather than an error —
     * failing the task here would file "I could not establish the cause" as a
     * malfunction, and §47 makes that answer a success.
     */
    completeTask(task.id);
    /* §37 — known traps, runbooks and past diagnoses for the same subject. The
      * live incident evidence above remains authoritative; this is context. */
    const knowledge = await panelFor(diagnosis.subject?.identifier
      ? `${diagnosis.subject.type} ${diagnosis.subject.identifier}`
      : message);
    emit({ type: 'diagnosis_complete', taskId: task.id, diagnosis, knowledge });
  } catch (err) {
    log.error('plan', `diagnosis failed for task ${task.id}: ${err.message}`, err);
    failTask(task.id, err.message);
    emit({ type: 'plan_failed', taskId: task.id, reason: 'diagnosis_failed', note: err.message });
  }
  return res.end();
});

/**
 * POST /api/agent/plan/lint  { sessionId, message, sys_id? }
 *
 * PHASE 16 — NowLint, streamed.
 *
 * ADDITIVE, like the diagnose route beside it. Read the handler and every
 * authority it hands to the linter is something this file already had: the
 * dictionary, the raw table reader, the semantic layer, capability discovery.
 *
 * THERE IS NO EXECUTION HERE AT ALL, which is why §33 needs no gate in this
 * handler: linting reads and reasons, and the only mutation NowLint can lead to
 * is a FIX, which becomes a goal for the existing planner and travels the same
 * approval path as everything else (§5, §35). A lint run cannot write, because
 * nothing in the path it takes can.
 *
 * The terminal-frame invariant is honoured as elsewhere: exactly one of
 * `lint_complete` or `plan_failed` leaves here.
 */
planRouter.post('/lint', async (req, res) => {
  const { sessionId, message, sys_id: sysId = null } = req.body || {};
  if (!sessionId || !message) {
    return res.status(400).json({ message: 'sessionId and message are required' });
  }
  if (!getSession(sessionId)) createSession({ id: sessionId });

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const emit = streamOf(res);

  const task = createTask({ sessionId, goal: message });
  startTask(task.id);
  emit({ type: 'task_started', taskId: task.id });

  try {
    /*
     * §6 — an ambiguous name STOPS. The flow to lint is identified, never
     * chosen: linting the wrong flow and reporting confidently on it is worse
     * than asking which one was meant.
     */
    const found = sysId
      ? await findFlow({ sys_id: sysId })
      : (await resolveFlowForRequest({ request: message, find: findFlow, chat: chatOnce })).found;
    if (!found.ok) {
      const stopped = {
        ...emptyLintResult(),
        stopped: { reason: found.reason, note: found.note, candidates: found.candidates ?? [] },
      };
      completeTask(task.id);
      emit({ type: 'lint_complete', taskId: task.id, lint: stopped, markdown: renderLint(stopped) });
      return res.end();
    }

    emit({ type: 'lint_started', taskId: task.id, flow: { sys_id: found.sys_id, name: found.name } });

    const artifact = await readFlowArtifact(found.sys_id);
    const ctx = makeContext({
      getSchema, table, derivationOf, discovered: discoverAll({}),
    });
    const lint = await lintFlow(artifact, ctx);

    recordLint(task.id, lint);
    completeTask(task.id);
    /* §38 — knowledge may EXPLAIN a finding. It never replaces the live
      * semantic rule that produced it, which is why it rides alongside the
      * result rather than inside a finding. */
    const knowledge = await panelFor(`${found.name} ${lint.findings.map((f) => f.rule_id).join(' ')}`);
    emit({ type: 'lint_complete', taskId: task.id, lint, markdown: renderLint(lint), knowledge });
  } catch (err) {
    log.error('plan', `lint failed for task ${task.id}: ${err.message}`, err);
    failTask(task.id, err.message);
    emit({ type: 'plan_failed', taskId: task.id, reason: 'lint_failed', note: err.message });
  }
  return res.end();
});

/**
 * POST /api/agent/plan/test  { sessionId, message, sys_id?, fixture_fields?, timeout_ms? }
 *
 * PHASE 17 — NowTest, streamed.
 *
 * ADDITIVE, exactly as `/diagnose` and `/lint` are, and it is the first of the
 * three that WRITES. That difference is handled by using the pipeline this file
 * already has rather than by adding anything: the plan is validated, saved,
 * fingerprinted, shown as a review, put through the SAME approval card the
 * ordinary plan route raises, and executed by the SAME executor with the SAME
 * recovery. Read the handler and there is no second write path here — there is
 * one `executePlan`, and `testFlow` is handed it.
 *
 * WHAT THIS HANDLER ADDS is the approval CHANNEL, which is a property of being
 * an HTTP stream rather than of testing: `awaitApprovalDecision` needs a card on
 * the wire and an id to match the answer to, and neither belongs inside a domain
 * module. So the domain asks a function, and this is that function.
 *
 * The terminal-frame invariant holds as elsewhere: exactly one of
 * `test_complete` or `plan_failed` leaves here.
 */
planRouter.post('/test', async (req, res) => {
  const {
    sessionId, message, sys_id: sysId = null,
    fixture_fields: fixtureFields = {}, timeout_ms: timeoutMs = undefined,
  } = req.body || {};
  if (!sessionId || !message) {
    return res.status(400).json({ message: 'sessionId and message are required' });
  }
  if (!getSession(sessionId)) createSession({ id: sessionId });

  const emit = streamOf(res);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 15000);
  const controller = new AbortController();
  let settled = false;
  const onClientGone = () => { if (!settled && !res.writableEnded) controller.abort(); };
  res.on('close', onClientGone);

  const task = createTask({ sessionId, goal: message, metadata: { nowtest: true } });
  startTask(task.id);
  emit({ type: 'task_started', taskId: task.id });

  try {
    const { agent } = getSettings();
    const result = await testFlow({
      request: message,
      taskId: task.id,
      sessionId,
      sys_id: sysId,
      fixture_fields: fixtureFields,
      timeoutMs,
      /* Every one of these is the existing implementation, injected. */
      find: findFlow,
      readArtifact: readFlowArtifact,
      chat: chatOnce,
      schemaFor: getSchema,
      derivation: derivationOf,
      generate: generatePlan,
      run: (opts) => executePlan({
        ...opts,
        recoverStep: (args) => recoverStep({
          ...args,
          readRecord: ({ table: t, sys_id: id }) => table.get(t, id, 'all'),
        }),
      }),
      plan: {
        save: savePlan,
        load: loadPlan,
        setState: setPlanState,
        approve: approvePlan,
        review: buildReview,
        violations: mutatingSteps,
      },
      autoApprove: Boolean(agent.autoApprove),
      /*
       * THE APPROVAL CHANNEL — the existing gate, nothing new.
       *
       * The same nonce, the same `awaitApprovalDecision`, the same
       * `POST /api/agent/approve` endpoint the ordinary plan route uses. What
       * the card says is different because what is being authorised is
       * different, and that is the whole of the difference.
       */
      approve: async ({ taskId, fingerprint, review, cleanup = false }) => {
        const approvalId = crypto.randomUUID();
        const nonce = crypto.randomBytes(32).toString('base64url');
        emit({
          type: 'approval_required',
          approvalId,
          nonce,
          name: cleanup ? 'delete a leftover test record' : 'run this flow test',
          input: { goal: review.goal, steps: review.steps.length, changes: review.plannedChanges.length },
          plan: { taskId, fingerprint },
          warning: cleanup
            ? 'A previous test could not remove the record it created. This deletes it.'
            : 'This creates a real, disposable record on the instance to make the flow run, and deletes it afterwards.',
        });
        const decision = await awaitApprovalDecision(sessionId, approvalId, nonce, controller.signal);
        emit({ type: 'approval_resolved', approvalId, approved: decision.approved, source: decision.source, at: decision.at });
        return decision;
      },
      /* §41 — lint findings surfaced beside the test. They never gate it. */
      lint: async (artifact) => lintFlow(artifact, makeContext({
        getSchema, table, derivationOf, discovered: discoverAll({}),
      })),
      record: recordTest,
      /* The cleanup plan is a real task of its own, created the ordinary way. */
      newTaskId: () => {
        const t = createTask({ sessionId, goal: 'remove a leftover NowTest fixture', metadata: { nowtest_cleanup: true } });
        startTask(t.id);
        return t.id;
      },
      signal: controller.signal,
      emit,
    });

    /*
     * A BLOCKED or INCONCLUSIVE test is a completed REQUEST. The run did what
     * it could and said what it could not; filing that as a malfunction would
     * make "I cannot establish this" look like an error, and §39 makes it an
     * answer.
     */
    completeTask(task.id);
    /* §39 — guidance for fixture generation. The fixture itself was validated
      * against the live schema and semantics, and still is; nothing retrieved
      * here changed it. */
    const knowledge = await panelFor(`${result.artifact?.name ?? message} fixture trigger`);
    emit({ type: 'test_complete', taskId: task.id, test: result, markdown: renderTest(result), knowledge });
  } catch (err) {
    log.error('plan', `test failed for task ${task.id}: ${err.message}`, err);
    failTask(task.id, err.message);
    emit({ type: 'plan_failed', taskId: task.id, reason: 'test_failed', note: err.message });
  } finally {
    clearInterval(keepAlive);
    settled = true;
    res.off('close', onClientGone);
    res.end();
  }
  return undefined;
});

/**
 * PHASE 19 — LIVE EVIDENCE, for a question that needs it (§17, §60, §67).
 *
 * The knowledge domain cannot read the instance — it imports no client, which is
 * what makes §77's boundary structural. So the reading happens HERE, where the
 * client already lives, and arrives as an ordinary knowledge item carrying the
 * evidence that produced it.
 *
 * EVERY ITEM IT RETURNS HAS AN ARTIFACT BEHIND IT. `fromLiveReading` refuses to
 * build one without evidence, so a subject this cannot read produces NOTHING
 * rather than a confident sentence — and the answer then reports
 * INSUFFICIENT_EVIDENCE, which is the honest outcome and the one §68 asks for.
 *
 * TWO KINDS OF READING, because the dictionary and the semantic ledger answer
 * different questions and §2's whole example turns on the difference:
 *
 *   the dictionary  what the column IS — type, read-only, mandatory
 *   derivationOf    whether the platform OVERWRITES it, which the dictionary
 *                   does not express and never will
 */
async function liveEvidenceFor({ subjects, scope }) {
  const out = [];
  const at = new Date().toISOString();
  const instance = scope?.instance ?? currentInstance();

  for (const subject of subjects.slice(0, 4)) {
    let schema = null;
    try {
      schema = await getSchema(subject.table);
    } catch {
      /* A table that cannot be read produces no claim about itself. */
      continue;
    }
    /* An empty dictionary is not an empty table — the Phase 16 finding, and it
     * matters just as much here: zero fields means the read told us nothing. */
    if (!schema?.fields?.length) continue;

    if (subject.kind === 'table') {
      out.push(fromLiveReading({
        id: subject.table,
        title: subject.table,
        statement: `${subject.table} exists on this instance and has ${schema.fields.length} field(s) in its dictionary.`,
        evidence: `getSchema(${subject.table}) returned ${schema.fields.length} fields`,
        scope: { instance, table: subject.table },
        at,
        tool: 'get_table_schema',
      }));
      continue;
    }

    const field = schema.fields.find((f) => f.name === subject.field);
    if (!field) {
      out.push(fromLiveReading({
        id: `${subject.table}.${subject.field}`,
        title: `${subject.table}.${subject.field}`,
        statement: `${subject.table}.${subject.field} is not a field on ${subject.table} according to the live dictionary.`,
        evidence: `getSchema(${subject.table}) returned ${schema.fields.length} fields, none named ${subject.field}`,
        scope: { instance, table: subject.table },
        at,
        tool: 'get_table_schema',
      }));
      continue;
    }

    const bits = [`is of type ${field.type}`];
    if (field.readOnly === true) bits.push('is marked read-only in the dictionary');
    if (field.mandatory === true) bits.push('is mandatory');
    out.push(fromLiveReading({
      id: `${subject.table}.${subject.field}`,
      title: `${subject.table}.${subject.field}`,
      statement: `${subject.table}.${subject.field} ${bits.join(', ')} on this instance.`,
      evidence: JSON.stringify({ name: field.name, type: field.type, readOnly: field.readOnly, mandatory: field.mandatory }),
      scope: { instance, table: subject.table },
      at,
      tool: 'get_table_schema',
    }));

    /*
     * The one thing the dictionary cannot tell you. `priority` is not marked
     * read-only — that is precisely why the ledger fact exists — so a run that
     * consulted only the dictionary would agree with the documentation that
     * says priority is writable, and be wrong.
     */
    const derived = derivationOf(subject.table, subject.field, { hierarchy: [subject.table] });
    if (derived) {
      out.push(fromLiveReading({
        id: `${subject.table}.${subject.field}#derived`,
        title: `${subject.table}.${subject.field}`,
        statement: `${subject.table}.${subject.field} is derived from ${derived.value.from.join(' + ')} on this instance; `
          + 'a direct write is accepted and silently overwritten.',
        evidence: JSON.stringify({ derived: true, from: derived.value.from, note: derived.note ?? null }),
        scope: { instance, table: subject.table },
        at,
        tool: 'semantic_layer',
      }));
    }
  }
  return out;
}

/**
 * §37-§40 — the knowledge panel another domain's answer carries.
 *
 * ONE HELPER FOR ALL FOUR, so the authority labelling cannot drift between
 * them. It never throws: knowledge is context, and a domain's real answer must
 * not fail because the corpus had a bad day.
 */
async function panelFor(subject) {
  try {
    const k = await knowledgeFor({ subject });
    return { panel: k.panel, sources: k.sources, degraded: k.degraded, complete: k.complete, authorises: false };
  } catch (err) {
    log.warn('plan', `knowledge panel unavailable: ${err.message}`);
    /* §80.8 — unavailable is not empty, and the panel says which it is. */
    return { panel: null, sources: [], degraded: false, complete: false, unavailable: err.message, authorises: false };
  }
}

/**
 * POST /api/agent/plan/build  { sessionId, message }
 *
 * PHASE 20 — the Application Builder, streamed.
 *
 * ADDITIVE, like the five routes before it. What it adds over `POST /` — the
 * ordinary plan route — is everything that happens BEFORE a plan exists:
 * requirements, discovery, architecture, a dependency graph, and the capability
 * gate that decides whether a plan may be produced at all.
 *
 * THE BUILD ITSELF IS THAT SAME ROUTE'S MACHINERY. `generatePlan`, `savePlan`,
 * `buildReview`, the approval card, `executePlan` — every one is handed to the
 * builder rather than reimplemented, which is §13 and §64. On an environment
 * without the SDK the run stops at the gate having designed the whole
 * application, and writes nothing.
 *
 * The terminal-frame invariant holds as elsewhere: exactly one of
 * `appbuild_complete` or `plan_failed` leaves here.
 */
planRouter.post('/build', async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId || !message) {
    return res.status(400).json({ message: 'sessionId and message are required' });
  }
  if (!getSession(sessionId)) createSession({ id: sessionId });

  const controller = new AbortController();
  let settled = false;
  const onGone = () => { if (!settled && !res.writableEnded) controller.abort(); };
  res.on('close', onGone);
  const emit = streamOf(res);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, 15000);

  const task = createTask({ sessionId, goal: message, metadata: { appbuild: true } });
  startTask(task.id);
  emit({ type: 'task_started', taskId: task.id });

  try {
    const discovered = discoverAll({});
    const prefix = await vendorPrefix();

    /* §16 — the field types this instance actually has, read rather than
     * assumed. An architecture that names a type the dictionary does not carry
     * is refused against THIS list. */
    const sample = await getSchema('task').catch(() => ({ fields: [] }));
    const fieldTypes = new Set(sample.fields.map((f) => f.type).filter(Boolean));

    const result = await buildApplication({
      request: message,
      taskId: task.id,
      sessionId,
      chat: chatOnce,
      decoding: codegenDecoding(),
      discovered,
      naming: { prefix, maxScope: MAX_SCOPE_LENGTH, validateScopeName, maxNameLength: {} },
      fieldTypes,
      registry: toolMap,
      /* §21 — the live dictionary answers whether a referenced table exists.
       * Discovery only sees this application's own scope, so without this a
       * reference to `sys_user` is refused as pointing at nothing. */
      tableExists: async (t) => {
        const schema = await getSchema(t).catch(() => null);
        return Boolean(schema?.fields?.length);
      },
      /* §6 — discovery, so nothing is rebuilt that already exists. */
      probes: {
        applications: async () => table.query('sys_app', { query: `scopeSTARTSWITH${prefix}`, fields: 'name,scope,sys_id', limit: 50, display: 'false' }).catch(() => []),
        tables: async () => table.query('sys_db_object', { query: `nameSTARTSWITH${prefix}`, fields: 'name,label,sys_id', limit: 100, display: 'false' }).catch(() => []),
        roles: async () => table.query('sys_user_role', { query: `nameSTARTSWITH${prefix}`, fields: 'name,sys_id', limit: 100, display: 'false' }).catch(() => []),
        flows: async () => [],
        catalog: async () => [],
      },
      /* §13/§43/§64 — the EXISTING pipeline, injected whole. */
      plan: {
        generate: generatePlan,
        save: savePlan,
        load: loadPlan,
        setState: setPlanState,
        review: buildReview,
        /*
         * §42 — the existing approval card and the existing binding. The
         * builder raises no card of its own; it hands the review here and waits
         * for the same gate every other mutation goes through.
         */
        approve: async ({ taskId, fingerprint, review }) => {
          setPlanState(taskId, 'awaiting_review');
          const approvalId = crypto.randomUUID();
          const nonce = crypto.randomBytes(32).toString('base64url');
          emit({
            type: 'approval_required', approvalId, nonce,
            name: 'build this application',
            input: { goal: review.goal, steps: review.steps?.length ?? 0 },
            plan: { taskId, fingerprint },
            warning: review.destructive?.length ? `${review.destructive.length} step(s) cannot be undone.` : null,
          });
          setPlanState(taskId, 'awaiting_approval');
          const decision = await awaitApprovalDecision(sessionId, approvalId, nonce, controller.signal);
          emit({ type: 'approval_resolved', approvalId, approved: decision.approved, source: decision.source, at: decision.at });

          if (decision.source === 'cancelled') {
            return { ok: false, cancelled: true, reason: 'cancelled', note: 'The build was cancelled before anything ran.' };
          }
          if (!decision.approved) {
            return { ok: false, reason: 'rejected', note: 'The build was not approved. Nothing ran.' };
          }
          const bound = approvePlan(taskId, fingerprint, { source: decision.source, at: decision.at });
          return bound.ok
            ? { ok: true, source: decision.source }
            : { ok: false, reason: bound.reason, note: 'The plan changed after it was shown, so this approval does not apply to it.' };
        },
      },
      run: (o) => executePlan({ ...o, recoverStep }),
      /* §34/§39 — the other domains, through their own mechanisms. */
      knowledgeFor,
      readBack: async (entry) => {
        const t = entry.table
          ?? (entry.type === 'catalog' ? 'sc_cat_item' : entry.type === 'role' ? 'sys_user_role' : null);
        if (!t || !entry.sys_id) return null;
        return table.get(t, entry.sys_id, 'false').catch(() => null);
      },
      record: recordAppBuild,
      at: new Date().toISOString(),
      signal: controller.signal,
      emit,
    });

    completeTask(task.id);
    emit({
      type: 'appbuild_complete', taskId: task.id, build: result,
      markdown: result.markdown ?? renderBuild(result),
    });
  } catch (err) {
    log.error('plan', `application build failed for task ${task.id}: ${err.message}`, err);
    failTask(task.id, err.message);
    emit({ type: 'plan_failed', taskId: task.id, reason: 'appbuild_failed', note: err.message });
  } finally {
    clearInterval(keepAlive);
    settled = true;
    res.off('close', onGone);
  }
  return res.end();
});

/**
 * POST /api/agent/plan/knowledge  { sessionId, message, table? }
 *
 * PHASE 19 — Instance Knowledge, streamed.
 *
 * ADDITIVE, like the four routes above it, and like `/change` it writes
 * nothing. What it adds over the retrieval that already reaches every turn's
 * prompt is ADJUDICATION: the same question is put to the trap ledger, the
 * observation store, the documentation corpus AND the live instance, and where
 * they disagree the disagreement is reported rather than silently resolved.
 *
 * The terminal-frame invariant holds as elsewhere: exactly one of
 * `knowledge_complete` or `plan_failed` leaves here.
 */
planRouter.post('/knowledge', async (req, res) => {
  const { sessionId, message, table = null, application = null } = req.body || {};
  if (!sessionId || !message) {
    return res.status(400).json({ message: 'sessionId and message are required' });
  }
  if (!getSession(sessionId)) createSession({ id: sessionId });

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const emit = streamOf(res);

  const task = createTask({ sessionId, goal: message, metadata: { knowledge: true } });
  startTask(task.id);
  emit({ type: 'task_started', taskId: task.id });

  try {
    const answer = await ask({
      question: message,
      taskId: task.id,
      table,
      application,
      /* The only way live truth enters the domain. */
      liveEvidence: liveEvidenceFor,
      signal: controller.signal,
      emit,
    });

    completeTask(task.id);
    emit({
      type: 'knowledge_complete',
      taskId: task.id,
      knowledge: answer,
      markdown: answer.markdown ?? renderAnswer(answer),
    });
  } catch (err) {
    log.error('plan', `knowledge question failed for task ${task.id}: ${err.message}`, err);
    failTask(task.id, err.message);
    emit({ type: 'plan_failed', taskId: task.id, reason: 'knowledge_failed', note: err.message });
  }
  return res.end();
});

/**
 * POST /api/agent/plan/change  { sessionId, message, sys_id?, baseline_sys_id? }
 *
 * PHASE 18 — Change Intelligence, streamed.
 *
 * ADDITIVE, exactly as `/diagnose`, `/lint` and `/test` are, and it is the one
 * of the four that writes NOTHING. That is not restraint in the handler: read
 * the injections below and every one is a READER — the artifact, the snapshot
 * list, the dictionary, the semantic ledger, the linter, two predicates from
 * NowTest. There is no tool, no executor and no client anywhere in the path,
 * because a comparison has nothing to do with any of them.
 *
 * DEPLOYMENT DOES NOT HAPPEN HERE AND CANNOT (§32, §59). A request to deploy is
 * still analysed — the whole point is to make the change understandable first —
 * and what comes back is a GOAL for `POST /` above, which is the ordinary plan
 * route with its ordinary review, its ordinary approval card and its ordinary
 * executor. The user takes that goal there; nothing in this handler can.
 *
 * The terminal-frame invariant holds as elsewhere: exactly one of
 * `change_complete` or `plan_failed` leaves here.
 */
planRouter.post('/change', async (req, res) => {
  const {
    sessionId, message, sys_id: sysId = null, baseline_sys_id: baselineSysId = null,
    baseline_task_id: baselineTaskId = null,
  } = req.body || {};
  if (!sessionId || !message) {
    return res.status(400).json({ message: 'sessionId and message are required' });
  }
  if (!getSession(sessionId)) createSession({ id: sessionId });

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const emit = streamOf(res);

  const task = createTask({ sessionId, goal: message, metadata: { change: true } });
  startTask(task.id);
  emit({ type: 'task_started', taskId: task.id });

  try {
    const discovered = discoverAll({});
    const comparison = await compareFlow({
      request: message,
      taskId: task.id,
      sys_id: sysId,
      baseline_sys_id: baselineSysId,
      /* Every one of these is the existing implementation, injected. */
      find: findFlow,
      chat: chatOnce,
      readArtifact: readFlowArtifact,
      /*
       * §4 — the baseline source, and the reason this phase has one. Flow
       * Designer writes a full copy of a flow when it is published, components
       * and all, so "the previous version" is something the instance can be
       * asked for rather than something this build has to remember.
       */
      findSnapshot: async (flowSysId) => {
        const rows = await table.query('sys_hub_flow_snapshot', {
          query: `parent_flow=${flowSysId}^ORDERBYDESCsys_created_on`,
          fields: 'sys_id,version,sys_created_on', limit: 10, display: 'false',
        }).catch(() => []);
        return rows.map((r) => ({ sys_id: r.sys_id, version: r.version, created_on: r.sys_created_on }));
      },
      /* §35 — a baseline captured earlier is used only when the caller names the
       * task it was captured on. Nothing goes looking for one. */
      capturedBaseline: baselineTaskId ? async () => loadCapturedBaseline(baselineTaskId) : null,
      fieldsOf: async (t) => {
        const schema = await getSchema(t).catch(() => ({ fields: [] }));
        /* An empty dictionary is not an empty table — the Phase 16 finding. */
        return schema.fields.length ? new Map(schema.fields.map((f) => [f.name, f])) : null;
      },
      derivationOf,
      /* §21/§22 — NowLint itself, not a copy of its conclusions. */
      lint: async (artifact) => lintFlow(artifact, makeContext({
        getSchema, table, derivationOf, discovered,
      })),
      allRuleIds: RULE_IDS,
      /* §23 — the two predicates NowTest uses to decide, so a recommendation
       * here and a refusal there cannot disagree. Neither runs anything. */
      testability: { triggerOf, isDisposable },
      /* §28 — history, attributed to neither state unless provenance allows it. */
      executionsFor: async (flowSysId) => {
        const seen = await flowExecutionsFor({ table: 'sys_hub_flow', sys_id: flowSysId }).catch(() => null);
        return seen?.executions ?? [];
      },
      record: recordChange,
      at: new Date().toISOString(),
      signal: controller.signal,
      emit,
    });

    /*
     * A comparison that stopped is still a completed REQUEST. "There is no
     * earlier version of this flow" is an answer, and §4 makes it the required
     * one where no trustworthy baseline exists.
     */
    completeTask(task.id);
    emit({
      type: 'change_complete', taskId: task.id, change: comparison,
      markdown: renderComparison(comparison),
      /* §40 — previous change notes, deployment runbooks and known risks. The
       * semantic diff above remains authoritative. */
      knowledge: await panelFor(`${comparison.artifact?.name ?? message} deployment change risk`),
    });
  } catch (err) {
    log.error('plan', `change comparison failed for task ${task.id}: ${err.message}`, err);
    failTask(task.id, err.message);
    emit({ type: 'plan_failed', taskId: task.id, reason: 'change_failed', note: err.message });
  }
  return res.end();
});

/**
 * POST /api/agent/plan/validate  { plan }
 *
 * A dry run of the deterministic checks, with no task and no execution. This is
 * what makes "the validator is the authority" inspectable: a plan can be judged
 * without anything being created.
 */
planRouter.post('/validate', (req, res) => {
  res.json(validatePlan(req.body?.plan));
});

/** The approval endpoint is the EXISTING one — `POST /api/agent/approve`. */
export { resolveApproval, APPROVAL_SOURCES };
