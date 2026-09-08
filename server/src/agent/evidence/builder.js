import { fingerprintMatches } from '../plan/fingerprint.js';
import { redact } from './redact.js';
import { decideStatus, STATUS } from './status.js';
import {
  readTask, readSteps, readToolEvents, readMutations, readBuilds,
  readRequest, sessionExists, taskWindow,
} from './read-model.js';

/**
 * PHASE 5 — THE EVIDENCE BUILDER.
 *
 * Assembles one answer to "what actually happened, and how do we know" from
 * durable records alone. Deterministic: no model, no network, no clock, no
 * in-memory agent state. The same database always yields the same object.
 *
 * THE RULE THE WHOLE THING TURNS ON: A PLAN IS NOT A RESULT.
 *
 * A plan says what was intended. A read-back says what is true. When they
 * disagree the read-back wins and the disagreement is REPORTED — the plan is
 * never rewritten to match the outcome, because that would erase the only
 * record that something went differently than intended. Phase 3's ladder puts
 * `live_state` above everything, and this is that ladder applied to a finished
 * run.
 *
 * AND: HTTP 200 IS NOT VERIFICATION. Execution status and verification status
 * are separate fields on every step, and a promised effect with no verification
 * evidence is `unverified` rather than `success`. That distinction is the
 * reason this phase exists.
 */

/** Where a piece of evidence came from. Phase 3's vocabulary, not a new one. */
export const SOURCE = Object.freeze({
  TASK: 'task',
  PLAN: 'plan',
  APPROVAL: 'approval',
  TOOL_EVENT: 'tool_event',
  MUTATION_LEDGER: 'mutation_ledger',
  READBACK: 'service_now_readback',
  VERIFICATION: 'verification',
  BUILD: 'build_event',
  // Phase 7 — written by `recordRecoveryAttempt`, read back verbatim. Nothing
  // in this section is inferred from anything else.
  RECOVERY: 'recovery_attempt',
  // PHASE 12 — written by the executor at resolution time, read back verbatim.
  DATAFLOW: 'dataflow_resolution',
  /*
   * PHASE 14 — the Doctor's finished analysis, read back from
   * `agent_tasks.metadata_json`.
   *
   * A DELIBERATELY DISTINCT WORD, because this section is unlike every other
   * one here. The rest of this file projects things the platform DID; this
   * projects a conclusion drawn about them. The facts inside it are themselves
   * provenanced back to the step that read them, so a reader can always get
   * from a diagnostic sentence to the tool result it came from — but the
   * sentence is analysis, and the vocabulary should not let it pass for an
   * observation.
   */
  DIAGNOSIS: 'diagnostic_analysis',
});

/**
 * PHASE 14 — the stored diagnosis, projected and redacted.
 *
 * Read from the task row rather than recomputed: the analysis ran once, against
 * the evidence that existed then, and re-deriving it here would produce a
 * second answer that could differ from the one the user was shown. This layer
 * reports; it does not think.
 *
 * EVERYTHING FREE-TEXT GOES THROUGH `redact`. Diagnostic statements quote field
 * values off real records, so a diagnosis is exactly the kind of narrative that
 * could carry a credential out of an instance and into a report (§52).
 */
function diagnosisSection(taskRow) {
  const meta = (() => {
    try { return JSON.parse(taskRow?.metadata_json ?? 'null') ?? {}; } catch { return {}; }
  })();
  const d = meta.diagnosis;
  if (!d) return null;

  return {
    source: SOURCE.DIAGNOSIS,
    at: d.at ?? null,
    mode: d.mode ?? null,
    subject: redact(d.subject ?? null),
    symptom: redact(d.symptom ?? null),
    outcome: d.outcome ?? null,
    cause_label: d.cause_label ?? null,
    reason: redact(d.reason ?? null),
    symptom_confirmed: d.symptom_confirmed ?? null,

    investigation: redact(d.investigation ?? null),

    /*
     * PHASE 15 — the timeline (§50).
     *
     * Every entry carries `fact_id`, so a line on the timeline is always
     * traceable back to the observation it came from. That is what keeps it
     * evidence rather than narration: a reader can ask "how do you know the
     * flow errored at 08:59:56?" and follow the id to the tool result.
     *
     * Ordering only. There is no `caused` field here and no way to express one,
     * because §24 forbids causation being read off chronology and the surest
     * way to prevent that is to have nowhere to write it down.
     */
    timeline: d.timeline
      ? {
        span: d.timeline.span ?? null,
        timed: d.timeline.timed ?? 0,
        untimed: d.timeline.untimed ?? 0,
        simultaneous: d.timeline.simultaneous ?? [],
        events: (d.timeline.events ?? []).map((e) => ({
          at: e.at,
          kind: e.kind,
          label: redact(e.label),
          detail: redact(e.detail ?? null),
          fact_id: e.fact_id ?? null,
          source: e.source ?? null,
        })),
      }
      : null,

    /*
     * Facts keep their provenance. That pair — the sentence and the step it
     * came from — is what makes a diagnosis auditable rather than merely
     * readable, and §49 requires the chain to survive without the transcript.
     */
    facts: (d.facts ?? []).map((f) => ({
      id: f.id, statement: redact(f.statement), field: f.field,
      value: redact(f.value), source: f.source,
    })),

    hypotheses: (d.hypotheses ?? []).map((h) => ({
      id: h.id,
      statement: redact(h.statement),
      status: h.status,
      confidence: h.confidence,
      support_level: h.support_level,
      evidence_for: h.evidence_for ?? [],
      evidence_against: h.evidence_against ?? [],
      missing_evidence: redact(h.missing_evidence ?? []),
      /* What the analyst claimed versus what the evidence bore out. */
      claimed: h.claimed ?? null,
      overstated: Boolean(h.overstated),
    })),

    conclusion: d.conclusion
      ? { ...d.conclusion, statement: redact(d.conclusion.statement) }
      : null,

    recommendations: (d.recommendations ?? []).map((r) => ({
      statement: redact(r.statement),
      reason: redact(r.reason ?? []),
      risk: r.risk ?? null,
      mutation: Boolean(r.mutation),
      requires_approval: Boolean(r.requires_approval),
      ...(r.withheld ? { withheld: redact(r.withheld) } : {}),
    })),

    unknowns: (d.unknowns ?? []).map((u) => ({
      statement: redact(u.statement), reason: redact(u.reason),
    })),

    /*
     * The safety measurements, carried into the permanent record.
     *
     * §38 makes the unsupported-claim rate the headline metric and §55.2 makes
     * a fabricated fact a release blocker. Keeping both counts in the evidence —
     * rather than only in a test run — means a reviewer can audit them on any
     * real diagnosis after the fact.
     */
    integrity: {
      invented_citations: (d.invented_citations ?? []).map((c) => ({
        slot: c.slot, id: c.id, hypothesis: redact(c.hypothesis),
      })),
      overstated_hypotheses: d.overstated ?? [],
    },

    stopped: d.stopped ? redact(d.stopped) : null,
  };
}

const item = (value, source, extra = {}) => ({ value, source, ...extra });

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

function taskSection(task) {
  return {
    id: task.id,
    state: item(task.state, SOURCE.TASK),
    planState: item(task.plan_state ?? null, SOURCE.PLAN),
    createdAt: task.created_at,
    startedAt: task.started_at,
    completedAt: task.completed_at,
    cancelledAt: task.cancelled_at,
    /*
     * PHASE 8 — REDACTED, like every other free text in this projection.
     *
     * A failure reason is built from whatever the tool threw, and a transport
     * error is the single likeliest place for an `Authorization: Basic …`
     * header to appear verbatim. Phase 5 redacted inputs, results and requested
     * fields but not this one, so a failed call could put a credential straight
     * into the evidence object — which is precisely what that phase forbade.
     * Found by running the redaction assertion over a REAL failure rather than
     * a hand-made fixture.
     */
    failureReason: redact(task.failure_reason ?? null),
    instance: task.instance ?? null,
    actor: task.actor ?? null,
    session: {
      id: task.session_id,
      // Phase 1 deliberately gave tasks no foreign key to sessions, so evidence
      // outlives the conversation. Reported so a reader knows the transcript is
      // gone rather than wondering why it is missing.
      exists: sessionExists(task.session_id),
    },
  };
}

function approvalSection(task, steps) {
  const required = steps.some((s) => s.mutating) || Boolean(task.plan_state && steps.length);
  const approved = task.approved_fingerprint ?? null;
  const current = task.plan_fingerprint ?? null;

  if (!approved) {
    const rejected = task.plan_state === 'failed'
      && /reject/i.test(String(task.failure_reason ?? ''));
    return {
      required,
      status: rejected ? 'rejected' : (required ? 'not_approved' : 'not_required'),
      requested: task.plan_state === 'awaiting_approval' || rejected,
      approved_fingerprint: null,
      current_fingerprint: current,
      valid: false,
      reason: rejected ? 'rejected' : 'never approved',
      source: SOURCE.APPROVAL,
    };
  }

  /*
   * THE STALENESS CHECK, using Phase 4's own comparison.
   *
   * Not reimplemented and not loosened: a plan whose fingerprint has moved
   * since approval is stale, and the evidence says so rather than presenting a
   * run as authorised when the thing authorised was something else.
   */
  const valid = fingerprintMatches(approved, current ?? '');
  return {
    required,
    status: 'approved',
    requested: true,
    approved_fingerprint: approved,
    current_fingerprint: current,
    approved_at: task.approved_at ?? null,
    approved_source: task.approved_source ?? null,
    valid,
    reason: valid ? null : 'approval_stale',
    note: valid ? null
      : 'The plan changed after it was approved, so this approval does not describe what would run now.',
    source: SOURCE.APPROVAL,
  };
}

/**
 * How a step's verification actually came out.
 *
 * Reads BOTH shapes this project produces: the write-verify verdict
 * (`{status, applied, dropped, transformed}`) that every REST mutation gets,
 * and the plan's declared strategy with its asserts. Returns a normalised view
 * plus a boolean that is deliberately three-valued — true, false, or null for
 * "no evidence either way", because collapsing null into false would report a
 * clean run as broken and collapsing it into true is the failure this phase
 * exists to prevent.
 */
function verificationOf(step) {
  const v = step.verification;
  if (!v) return { status: 'none', strategy: null, passed: null, assertions: [], note: 'no verification evidence' };

  // A plan step that has not run yet still carries its declared strategy.
  const declaredOnly = v.strategy && !('status' in v);
  if (declaredOnly) {
    return {
      status: 'pending',
      strategy: v.strategy,
      passed: null,
      assertions: (v.asserts ?? []).map((a) => ({ name: String(a), expected: null, actual: null, passed: null })),
      note: 'a verification strategy was declared; no verdict has been recorded',
    };
  }

  // The write-verify verdict.
  const status = v.status ?? 'unverified';
  const dropped = v.dropped ?? [];
  const transformed = v.transformed ?? [];
  const applied = v.applied ?? [];
  const passed = status === 'applied' ? true
    : (status === 'no-op' || status === 'partial') ? false
      : null;                         // unverified / self-verified / transformed

  const assertions = [
    ...applied.map((a) => ({ name: a.field, expected: a.value, actual: a.value, passed: true, source: SOURCE.READBACK })),
    ...dropped.map((d) => ({ name: d.field, expected: d.requested, actual: d.actual ?? null, passed: false, reason: d.reason, source: SOURCE.READBACK })),
    ...transformed.map((t) => ({ name: t.field, expected: t.requested, actual: t.actual, passed: null, reason: 'the platform stored a different value', source: SOURCE.READBACK })),
  ];

  return {
    status,
    strategy: v.strategy ?? (status === 'self-verified' ? 'self_reported' : 'read_back'),
    passed,
    summary: v.summary ?? null,
    assertions,
    failed_assertions: assertions.filter((a) => a.passed === false),
    unverifiable: v.unverifiable ?? [],
    note: status === 'self-verified'
      ? 'the tool reported its own read-back; no independent diff was performed'
      : null,
  };
}

function stepSection(step) {
  const verification = verificationOf(step);
  const executed = ['completed', 'failed', 'verifying'].includes(step.state) && Boolean(step.result || step.failure_reason);

  return {
    id: step.plan_step_id ?? `seq_${step.sequence}`,
    sequence: step.sequence,
    kind: step.kind,
    operation: step.operation ?? step.description ?? null,
    capability: step.capability ?? null,
    mechanism: step.mechanism ?? null,
    scope: step.scope ?? null,
    tool: step.tool ?? null,
    mutating: step.mutating,
    dependsOn: step.depends_on,
    inputs: redact(step.inputs),
    expectedEffects: step.expected_effects,

    /*
     * TWO STATUSES, KEPT APART.
     *
     * `execution_status` is whether the call happened and returned.
     * `verification_status` is whether the effect was proven. A step can be
     * executed and unverified; that is a real and common state, and collapsing
     * the two is exactly how "HTTP 200" becomes "done".
     */
    execution_status: step.state,
    verification_status: verification.status,
    executed,
    startedAt: step.started_at,
    completedAt: step.completed_at,
    failureReason: redact(step.failure_reason ?? null),   // PHASE 8 — see taskSection

    approval: step.approval
      ? { ...step.approval, source: SOURCE.APPROVAL }
      : { required: step.mutating, recorded: false, source: SOURCE.APPROVAL },
    /*
     * PHASE 9 — REDACTED, like every other projected structure.
     *
     * The assertion list flattens the verifier's `{field, value}` pairs into
     * `{name, expected, actual}`, so a secret FIELD arrives with its name under
     * `name` and its value under `expected`/`actual`. `redact` now understands
     * that shape — but only for objects it is actually given, and this one was
     * being spread straight through. A planted `api_key` reached the assertion
     * list verbatim until it was passed here.
     */
    verification: redact({ ...verification, source: SOURCE.VERIFICATION }),
    result: step.result ? redact(step.result) : null,
    resultSource: step.result ? SOURCE.TOOL_EVENT : null,
  };
}

/**
 * What actually changed on the instance.
 *
 * Assembled from the mutation ledger, which is the harness's own account and
 * survives compaction. `before_state` is reported as UNAVAILABLE rather than
 * reconstructed: the pre-write snapshot is consumed by the verifier to compute
 * the diff and is not persisted, and inventing one from the requested values
 * would be a guess presented as a record.
 */
function changesSection(mutations) {
  return mutations.map((m) => {
    const v = m.verification ?? {};
    return {
      table: m.table,
      sys_id: m.sysId,
      number: m.displayId,
      /*
       * PHASE 8 — is this change PROVEN to be this task's, or only correlated?
       *
       * `true` means the ledger row names this task. `false` means it was
       * matched by session and time window, which is what every row written
       * before migration 23 and every row from the plan-less turn loop still
       * relies on. The distinction is carried here rather than left to the
       * reader, because a change reported as fact when it might be another
       * plan's is the exact defect this phase found.
       */
      exact: m.exact === true,
      operation: v.operation ?? (m.tool?.includes('delete') ? 'delete' : 'write'),
      tool: m.tool,
      requested: redact(m.requested),
      changed_fields: (v.applied ?? []).map((a) => a.field),
      dropped_fields: (v.dropped ?? []).map((d) => d.field),
      transformed_fields: (v.transformed ?? []).map((t) => t.field),
      before_state: 'unavailable',
      before_state_note:
        'The pre-write snapshot is consumed by the verifier to compute the diff and is not persisted. '
        + 'It is reported as unavailable rather than reconstructed from what was requested.',
      /*
       * PHASE 9 — REDACTED. This reconstructs the real field names from the
       * verifier's pair list, so a secret field lands back under its own key
       * and key-based redaction can see it again. It was not redacted before,
       * which put a planted `api_key` into the change record verbatim.
       */
      after_state: (v.applied ?? []).length
        ? redact(Object.fromEntries((v.applied ?? []).map((a) => [a.field, a.value])))
        : null,
      verification_status: v.status ?? 'unverified',
      approval: { approval: m.approval, source: m.approvedSource, at: m.approvedAt },
      // PHASE 9 — the capture annotation quotes transport errors, which is
      // where an auth header arrives verbatim.
      capture: redact(m.capture ?? null),
      instance: m.instance,
      at: m.ts,
      source: SOURCE.MUTATION_LEDGER,
      correlated: true,
    };
  });
}

function buildsSection(builds) {
  return builds.map((b) => ({
    id: b.id,
    kind: b.kind,
    label: b.label,
    // `status` is the run's own recorded outcome. A source file existing on
    // disk is not a deployment, and this never infers one from it.
    status: b.status,
    started: b.started,
    finished: b.finished,
    summary: b.summary,
    diagnostics: b.events
      .filter((e) => /error|diagnostic|fail/i.test(e.type))
      .map((e) => ({ seq: e.seq, type: e.type, payload: redact(e.payload) })),
    events: b.events.map((e) => ({ seq: e.seq, type: e.type, at: e.ts })),
    deployed: b.status === 'ok',
    source: SOURCE.BUILD,
    correlated: true,
  }));
}

/**
 * PROMISED-EFFECT COVERAGE — the existing invariant, applied to a finished run.
 *
 * Every effect a step promised must be traceable to execution and to
 * verification. An effect with no verification evidence is `unverified`; it is
 * never reported as met because the step around it completed.
 */
function effectsSection(steps) {
  const out = [];
  for (const s of steps) {
    const v = verificationOf(s);
    for (const effect of s.expected_effects ?? []) {
      const asserted = v.assertions.some((a) => String(a.name) && String(effect).toLowerCase().includes(String(a.name).toLowerCase()));
      let verified = null;
      if (s.state === 'completed' && v.passed === true) verified = true;
      else if (v.passed === false || s.state === 'failed') verified = false;
      out.push({
        effect: String(effect),
        step: s.plan_step_id ?? `seq_${s.sequence}`,
        executed: ['completed', 'failed'].includes(s.state),
        verified,
        asserted,
        verification_status: v.status,
        note: verified === null
          ? 'no verification evidence supports or refutes this effect'
          : null,
        source: SOURCE.VERIFICATION,
      });
    }
  }
  return out;
}

/**
 * Everything that is genuinely not known.
 *
 * Surfaced as a section rather than left to be inferred from absence, because
 * absence is exactly what a reader will not notice.
 */
function uncertainties({ task, steps, effects, changes, approval, recovery }) {
  const out = [];
  /*
   * PHASE 7 — a failure that recovery could not resolve is an UNCERTAINTY, not
   * a footnote.
   *
   * It is listed first because it is the most consequential thing a reader can
   * learn about a run: something failed, the system considered fixing it, and
   * it is still not fixed. The reason recovery gave travels with it so the
   * reader knows whether it was refused, exhausted, or handed to a person.
   */
  for (const r of recovery?.steps ?? []) {
    if (r.recovered) continue;
    const last = r.attempts[r.attempts.length - 1] ?? {};
    out.push({
      kind: 'unrecovered_failure',
      step: r.step,
      // `last` is already redacted — it comes from the section above, not from
      // the raw lineage.
      note: `${r.operation ?? r.step} failed (${last.failure ?? 'unclassified'}) and was not recovered — `
        + `${last.decision ?? 'no decision'}: ${last.reason ?? 'no reason recorded'}`,
    });
  }
  /*
   * A REPEATED MUTATION IS ALSO AN UNCERTAINTY, even when it succeeded.
   *
   * A retry that verified is a real success, but the operation reached the
   * instance more than once, and anyone auditing side effects — a business rule
   * that fired twice, a notification sent twice — needs to know that from the
   * evidence rather than from reading the logs.
   */
  for (const r of recovery?.steps ?? []) {
    if (r.recovered && r.retried) {
      out.push({
        kind: 'repeated_mutation',
        step: r.step,
        note: `${r.operation ?? r.step} succeeded on a retry, so the operation reached the instance more than once; `
          + 'any side effects of the first attempt also happened',
      });
    }
  }
  if (!approval.valid && approval.status === 'approved') {
    out.push({ kind: 'approval_stale', note: approval.note });
  }
  for (const e of effects.filter((x) => x.verified === null)) {
    out.push({ kind: 'unverified_effect', step: e.step, note: `"${e.effect}" has no verification evidence` });
  }
  for (const s of steps.filter((x) => x.verification_status === 'self-verified')) {
    out.push({
      kind: 'self_reported_verification', step: s.id,
      note: `${s.tool ?? s.operation} reported its own read-back; no independent diff was performed`,
    });
  }
  for (const c of changes.filter((x) => x.transformed_fields.length)) {
    out.push({
      kind: 'transformed_write', table: c.table, sys_id: c.sys_id,
      note: `the platform stored different values for ${c.transformed_fields.join(', ')}`,
    });
  }
  /*
   * PHASE 9 — widened from "a plan that never closed" to "a RUN that never
   * closed".
   *
   * It used to require a `plan_state`, so a task abandoned before it ever
   * produced a plan — the shape a crash right after task creation leaves —
   * carried no uncertainty at all. Nothing false was claimed (the status is
   * UNVERIFIED and the change list is empty), but the record was silent about
   * being unfinished, and a reader cannot tell "nothing to do" from "nobody
   * came back". A task still `running` with no terminal timestamp is
   * incomplete whether or not it got as far as a plan.
   */
  const unfinished = !task.completed_at && !task.cancelled_at
    && task.plan_state !== 'failed' && task.state !== 'failed';
  if (unfinished && (task.plan_state || task.state === 'running')) {
    out.push({
      kind: 'incomplete',
      note: 'this run has no terminal timestamp — it may still be running, or the process that owned it died',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The entry point
 * ------------------------------------------------------------------ */

/**
 * PHASE 12 — WHERE A STEP'S VALUES CAME FROM.
 *
 * Read straight off each step's stored resolutions. Three things are kept
 * apart on purpose, because collapsing any two of them loses the fact a reader
 * needs:
 *
 *   DECLARED   `step_1.result.sys_id` — what the plan said, and what a human
 *              approved. It is the reference that was fingerprinted.
 *   RESOLVED   `62826bf0…` — the value the producer actually returned.
 *   CONSUMER   `target.sys_id` — the slot it was placed into.
 *
 * A record showing only the resolved value cannot answer 'why this record?';
 * one showing only the reference cannot answer 'which record?'. Both are here,
 * and the resolved value goes through the SAME redactor as every other runtime
 * value in this projection.
 *
 * A run that used no references reports `used: false` and an empty list, rather
 * than a section of zeroes implying a mechanism that was never involved.
 */
function dataflowSection(rawSteps) {
  const perStep = [];
  for (const s of rawSteps) {
    const resolutions = Array.isArray(s.metadata?.dataflow?.resolutions)
      ? s.metadata.dataflow.resolutions : [];
    const produced = s.metadata?.outputs?.values ?? null;
    if (!resolutions.length && !produced) continue;
    perStep.push({
      step: s.plan_step_id ?? `seq_${s.sequence}`,
      operation: s.operation ?? null,
      // What this step PRODUCED for others to read.
      produced: produced ? redact(produced) : null,
      // What this step CONSUMED, and from where.
      consumed: resolutions.map((r) => ({
        consumer: r.path,           // target.sys_id
        declared: r.declared,       // step_1.result.sys_id
        producer: r.producer ?? null,
        output: r.output ?? null,
        resolved: redact(r.resolved),
        source: SOURCE.DATAFLOW,
      })),
      source: SOURCE.DATAFLOW,
    });
  }
  return {
    used: perStep.some((p) => p.consumed.length > 0),
    steps: perStep,
    note: perStep.length
      ? 'Each consumed value shows the reference a human approved beside the value it resolved to.'
      : 'No step consumed the output of another step.',
    source: SOURCE.DATAFLOW,
  };
}

/**
 * PHASE 7 — WHAT RECOVERY DID, AND WHETHER IT WORKED.
 *
 * Read straight off each step's appended lineage. Every field here was written
 * by the recovery executor at the moment it decided; none of it is reconstructed
 * afterwards, so the section cannot drift from what actually happened.
 *
 * THE ONE RULE THIS SECTION EXISTS TO ENFORCE. `recovered` is true only where a
 * recorded attempt says RECOVERED — which the recovery executor writes only when
 * the EXISTING read-back verifier passed on the retry. An attempt that executed
 * without verifying is NOT_RECOVERED, and it reads as a failure here, because
 * "it ran again" is not evidence that it worked.
 *
 * A step that was never recovered contributes nothing, so a run with no
 * recovery has `attempted: false` and an empty list rather than a section full
 * of zeroes pretending to be a result.
 */
function recoverySection(rawSteps) {
  const perStep = [];
  for (const s of rawSteps) {
    const attempts = Array.isArray(s.metadata?.recovery?.attempts) ? s.metadata.recovery.attempts : [];
    if (!attempts.length) continue;
    const stepId = s.plan_step_id ?? `seq_${s.sequence}`;
    perStep.push({
      step: stepId,
      operation: s.operation ?? null,
      // The step's own final state. This is the authority on whether the step
      // ended up working — not the recovery record's opinion of itself.
      finalState: s.state,
      /*
       * `reason` and `result` quote the tool's own failure text, which is the
       * one place in this section that carries anything the instance said. It
       * goes through the SAME redactor every other free-text field in this file
       * goes through — a new section that skipped it would be a new way for a
       * credential in an error message to reach the evidence object.
       */
      attempts: attempts.map((a, i) => ({
        attempt: a.attempt ?? i,
        at: a.at ?? null,
        failure: a.failureKind ?? null,
        decision: a.decision ?? null,
        reason: redact(a.reason ?? null),
        idempotency: a.idempotency ?? null,
        approvalRequired: a.approvalRequired ?? null,
        outcome: a.outcome ?? null,
        result: redact(a.result ?? null),
        source: SOURCE.RECOVERY,
      })),
      // Only a RECOVERED outcome counts, and only alongside a step that
      // actually ended completed. Either one alone is not proof.
      recovered: attempts.some((a) => a.outcome === 'RECOVERED') && s.state === 'completed',
      retried: attempts.some((a) => a.decision === 'RETRY'),
      replanRequired: attempts.some((a) => a.decision === 'REPLAN'),
      needsHuman: attempts.some((a) => a.decision === 'WAIT_FOR_APPROVAL' || a.decision === 'MANUAL_INTERVENTION'),
      source: SOURCE.RECOVERY,
    });
  }

  return {
    attempted: perStep.length > 0,
    steps: perStep,
    recoveredSteps: perStep.filter((r) => r.recovered).length,
    unrecoveredSteps: perStep.filter((r) => !r.recovered).length,
    replanRequired: perStep.some((r) => r.replanRequired),
    needsHuman: perStep.some((r) => r.needsHuman),
    // The count that matters when reading a "successful" run: how many of the
    // effects standing at the end were produced by a second attempt.
    note: perStep.length
      ? 'A step listed here failed at least once. `recovered` is true only where a retry both executed and verified.'
      : 'No recovery was attempted.',
    source: SOURCE.RECOVERY,
  };
}

/**
 * Build the evidence for one task.
 *
 * Returns `null` for a task that does not exist — a deterministic not-found,
 * never an empty shell that reads as "this task did nothing".
 */
export function buildEvidence(taskId) {
  const task = readTask(taskId);
  if (!task) return null;

  const rawSteps = readSteps(taskId);
  const steps = rawSteps.map(stepSection);
  const mutations = readMutations(task);
  const changes = changesSection(mutations);
  const builds = buildsSection(readBuilds(task));
  const effects = effectsSection(rawSteps);
  const approval = approvalSection(task, rawSteps);
  const toolEvents = readToolEvents(task);
  const request = readRequest(task);
  const window = taskWindow(task);
  const recovery = recoverySection(rawSteps);
  const dataflow = dataflowSection(rawSteps);
  // PHASE 8 — exact only if EVERY correlated row named this task. An empty set
  // is exact: nothing was claimed, so nothing was claimed wrongly.
  const exactAudit = toolEvents.every((e) => e.exact) && mutations.every((m) => m.exact);

  const executedAnything = steps.some((s) => s.executed)
    || mutations.length > 0
    || toolEvents.some((e) => e.kind === 'tool_call');

  const final = decideStatus({
    planState: task.plan_state,
    taskState: task.state,
    /*
     * PHASE 8 — redacted on the way IN, not on the way out.
     *
     * `decideStatus` quotes this reason back in several of its branches
     * ("execution was refused: …"), so redacting its output would mean
     * remembering to do it in each one. Redacting the input means the status
     * decider never holds a credential at all, and no future branch can leak
     * one by echoing a field it was handed.
     */
    failureReason: redact(task.failure_reason),
    steps: rawSteps.map((s) => ({ id: s.plan_step_id ?? `seq_${s.sequence}`, state: s.state })),
    effects,
    executedAnything,
  });

  return {
    task: taskSection(task),

    request: {
      // The user's own words. Never a model paraphrase — Phase 4's planner
      // overwrites any goal a model tried to restate, so this is authoritative.
      text: request.text,
      source: request.source,
      compactable: request.compactable,
      note: request.source === 'transcript'
        ? 'recovered from the transcript, which compaction may later rewrite'
        : null,
    },

    plan: task.plan_state ? {
      state: task.plan_state,
      goal: task.goal,
      fingerprint: task.plan_fingerprint,
      stepCount: rawSteps.length,
      order: rawSteps.map((s) => s.plan_step_id ?? `seq_${s.sequence}`),
      capabilities: [...new Set(rawSteps.map((s) => s.capability).filter(Boolean))],
      mechanisms: [...new Set(rawSteps.map((s) => s.mechanism).filter(Boolean))],
      scopes: [...new Set(rawSteps.map((s) => s.scope).filter(Boolean))],
      source: SOURCE.PLAN,
    } : null,

    approval,
    steps,
    changes,
    builds,

    verification: {
      effects,
      promised: effects.length,
      verified: effects.filter((e) => e.verified === true).length,
      failed: effects.filter((e) => e.verified === false).length,
      unverified: effects.filter((e) => e.verified === null).length,
      // Coverage is about EVIDENCE, not about execution. A run can be 100%
      // executed and 0% covered.
      coverage: effects.length ? effects.filter((e) => e.verified !== null).length / effects.length : null,
      source: SOURCE.VERIFICATION,
    },

    recovery,
    dataflow,

    /*
     * PHASE 14 — null when the task was not a diagnosis, which is most of them.
     * A key that is present and null says "this ran, and it was not a
     * diagnosis"; an absent key would make every existing consumer have to
     * distinguish that from an older evidence shape.
     */
    diagnosis: diagnosisSection(task),

    /*
     * Phase 5 remains the authority on the final status.
     *
     * Recovery does not get a vote. `decideStatus` reads step states and
     * verified effects; a step that recovered is `completed` with a passing
     * read-back and reaches VERIFIED through exactly the path any first-attempt
     * success does. A step whose retry did not verify is still `failed`, and
     * still makes the run FAILED — there is no branch here that upgrades a
     * status because a recovery was attempted.
     */
    final: { status: final.status, reason: final.reason },

    uncertainties: uncertainties({ task, steps, effects, changes, approval, recovery }),

    /*
     * The correlated audit cross-reference, labelled as such.
     *
     * `tool_events` carries no task id, so these rows are matched by session
     * and the task's own recorded window. Deterministic — both inputs are
     * persisted — but not a key: two plans running concurrently in one session
     * would each see the other's rows. The window travels with the evidence so
     * a reader can judge it.
     */
    /*
     * The audit cross-reference, labelled by how each row was matched.
     *
     * PHASE 8 changed what this can claim. Rows written by the plan executor now
     * name their task (migration 23) and are EXACT. Rows from the ordinary turn
     * loop, and every row written before that migration, name no task and are
     * still matched by session plus this task's window — correlated, and said so.
     *
     * `exact` is now computed, not hard-coded false: it is true only when every
     * row in this projection named this task. A mixed set reports false and the
     * counts say how mixed, because rounding that up to "exact" is how a
     * correlated row gets read as a proven one.
     */
    audit: {
      correlation: exactAudit
        ? 'task id, recorded on each row'
        : 'task id where present, otherwise session + task time window',
      window,
      exact: exactAudit,
      counts: {
        toolEvents: toolEvents.length,
        toolEventsExact: toolEvents.filter((e) => e.exact).length,
        changes: changes.length,
        changesExact: changes.filter((c) => c.exact).length,
      },
      note: exactAudit
        ? 'Every row here names this task, so none of it can belong to another plan.'
        : 'Rows without a task id are matched by session and time window, so a concurrent plan in the '
          + 'same session could have produced them. Rows marked `exact` name this task and cannot. '
          + 'Step evidence above is always exact — it comes from the step rows themselves.',
      toolEvents: toolEvents.map((e) => ({
        seq: e.seq, at: e.ts, kind: e.kind, name: e.name, status: e.status,
        mutating: e.mutating, approval: e.approval, approvedSource: e.approvedSource,
        exact: e.exact === true,
        source: SOURCE.TOOL_EVENT,
      })),
    },
  };
}

export { STATUS };
