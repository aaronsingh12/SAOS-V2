/**
 * PHASE 14 — THE DOCTOR, ASSEMBLED FROM PARTS THAT ALREADY EXISTED.
 *
 * This file is the composition layer and almost nothing else. Read down it and
 * the only new ideas are: which goal to plan, that the plan must not write, and
 * how to turn results into facts. Everything with teeth — planning, validation,
 * canonicalisation, fingerprinting, approval, `executeTool`, read-back,
 * recovery, evidence, redaction — is called, not reimplemented.
 *
 * WHAT IS DELIBERATELY ABSENT, and each is a §42/§43 requirement:
 *
 *   no doctorExecutor        `executePlan` runs the reads
 *   no doctorVerify          diagnose mode writes nothing to verify; remediation
 *                            uses the existing read-back
 *   no doctorApproval        `approvePlan` / `resolveApproval`, unchanged
 *   no ServiceNow client     the only way to the instance is a registry tool
 *                            invoked by the executor
 *   no doctor memory         the durable record is `agent_tasks.metadata_json`
 *                            and the step rows that already exist
 *
 * EVERY DEPENDENCY IS INJECTED. Not for testability alone — it makes the
 * absence of a second path VISIBLE. There is no import of the client, no import
 * of a provider, and no import of the database anywhere in the `doctor/`
 * directory, so "the Doctor cannot reach ServiceNow on its own" is a property
 * of the import graph rather than a promise.
 *
 * ON APPROVING AN INVESTIGATION. `executePlan` re-checks the approval binding
 * before every step, including reads, so an investigation needs one — and the
 * build ALREADY has a convention for this. `routes/plan.js:113-121` handles a
 * plan whose `buildReview` reports `approvalRequired: false` by moving it to
 * `executing` with `approved_source: 'read_only_plan'` and raising no card,
 * with the comment that the state machine is what makes "nothing was approved
 * because nothing needed approving" a recorded fact.
 *
 * The Doctor uses that same convention rather than inventing a second one. It
 * is not a shortcut: `approvalRequired` is `mutating.length > 0` computed by
 * `buildReview`, and `assertReadOnly` has separately proved against the tool
 * REGISTRY that no step can write. Two independent derivations agree before a
 * read runs, and the moment a plan can write, neither applies — remediation
 * goes through a real approval card.
 */
import {
  MODES, STOP_REASONS, OUTCOMES, CAUSE_LABELS, CLAIM_TYPES, emptyDiagnosis,
} from './schemas.js';
import { readIntent } from './intent.js';
import {
  planInvestigation, assertReadOnly, subjectOf, investigationGoal,
  checkStepBudget, truncatedReads, BUDGET_EXHAUSTED,
} from './investigation.js';
import {
  factsFrom, gapsFrom, observationsFrom, indexFacts, checkCitations, isSecretField,
} from './evidence.js';
import { proposeHypotheses } from './hypotheses.js';
import {
  adjudicate, classify, conclusionFrom, checkSymptom, symptomFactIdsOf, causalFactIdsOf,
  diagnosticSurfaceWasRead, CAUSAL_SURFACES, unsupportedBlame, failureIsRelevant, symptomStems,
} from './diagnosis.js';
import { recommendFrom, approvalContext, remediationGoal } from './recommendations.js';
import { isFact, isInference, isUnknown, isHypothesis } from './schemas.js';
import { renderDiagnosis } from './render.js';
import { buildTimeline } from './timeline.js';

/**
 * Run a diagnosis.
 *
 * @param {object} deps  every collaborator, injected:
 *   generate      generatePlan
 *   chat          chatOnce
 *   run           executePlan
 *   plan          { save, load, setState, approve, violations }
 *   record        (taskId, diagnosis) => void   durable persistence
 *   decoding      the codegen decoding profile, for the analyst call
 *
 * Returns the §6 diagnostic result. It ALWAYS returns one, including when the
 * run stopped early — a caller never has to distinguish "no diagnosis" from
 * "the diagnosis key is missing", and a stopped run explains itself in
 * `stopped` rather than by being absent.
 */
export async function diagnose({
  request,
  taskId,
  sessionId,
  generate,
  chat,
  run,
  plan: planApi,
  record = null,
  decoding = undefined,
  signal = null,
  emit = () => {},
} = {}) {
  const intent = readIntent(request);

  /* §26 — an ambiguous request stops here rather than investigating a guess. */
  if (!intent.ok) {
    return stop(emptyDiagnosis({ mode: MODES.DIAGNOSE }), STOP_REASONS.INSUFFICIENT_EVIDENCE, intent.note);
  }

  const subject = subjectOf(intent.subject);
  const base = emptyDiagnosis({ subject, symptom: intent.symptom, mode: MODES.DIAGNOSE });

  /* 1. PLAN THE INVESTIGATION — one planner, told it may only read. */
  const planned = await planInvestigation({ subject, symptom: intent.symptom, generate, signal });
  if (!planned.ok) {
    const mutations = (planned.fatal ?? []).filter((p) => p.code === 'mutation_in_read_only_plan');
    return stop(
      base,
      mutations.length ? STOP_REASONS.MUTATION_IN_DIAGNOSE : STOP_REASONS.READ_FAILED,
      mutations.length
        ? `The investigation plan contained ${mutations.length} step(s) that would change the instance, `
          + 'and was refused before anything ran.'
        : `No investigation could be planned: ${(planned.fatal ?? []).map((p) => p.code).join(', ') || planned.reason}`,
    );
  }

  /* 2. THE LAST GATE. The validator already refused a writing plan; this
   *    re-checks the plan that will ACTUALLY run, because `savePlan` does not
   *    call the validator and a guard with a precondition is not a guard. */
  try {
    assertReadOnly(planned.plan, { violations: planApi.violations });
  } catch (err) {
    return stop(base, STOP_REASONS.MUTATION_IN_DIAGNOSE, err.message);
  }

  /* §18 — the step budget, checked before anything runs. */
  const budget = checkStepBudget(planned.plan);
  if (!budget.ok) {
    return stop(base, STOP_REASONS.INSUFFICIENT_EVIDENCE, budget.note);
  }

  const saved = planApi.save(taskId, planned.plan);
  planApi.setState(taskId, 'ready');

  /*
   * The existing read-only convention, used verbatim. `buildReview` decides
   * `approvalRequired` from the mutating steps it finds; if it disagrees with
   * the registry check above, that disagreement is itself a reason to stop
   * rather than something to reconcile quietly.
   */
  const review = planApi.review(planned.plan, { fingerprint: saved.fingerprint, discovered: planned.discovered });
  if (review.approvalRequired) {
    return stop(base, STOP_REASONS.MUTATION_IN_DIAGNOSE,
      'The review found this investigation would require approval, which means it would change '
      + 'something. A diagnosis does not change anything, so it was not run.');
  }
  planApi.setState(taskId, 'executing', {
    approved_fingerprint: saved.fingerprint,
    approved_at: new Date().toISOString(),
    approved_source: 'read_only_plan',
  });

  /* Re-check the STORED plan: canonicalisation happens inside savePlan, so what
   * was validated and what will run are not the same object. */
  const stored = planApi.load(taskId);
  try {
    assertReadOnly(stored, { violations: planApi.violations });
  } catch (err) {
    return stop(base, STOP_REASONS.MUTATION_IN_DIAGNOSE, err.message);
  }

  emit({ type: 'investigation_started', taskId, steps: stored.steps.length, goal: planned.goal });

  /* 3. EXECUTE THE READS — the existing executor, the existing chokepoint. */
  /*
   * §17/§52 — a read that finds nothing is a GAP, not a broken investigation.
   * The executor refuses this flag on any plan that could write, and
   * `assertReadOnly` has already proved this one cannot, so the two agree.
   */
  const outcome = await run({ taskId, sessionId, emit, signal, continueOnStepFailure: true });

  /* 4. COLLECT + NORMALIZE from the DURABLE rows, never from memory. */
  const after = planApi.load(taskId);
  const steps = after?.steps ?? [];
  const facts = factsFrom(steps);
  const gaps = gapsFrom(steps);
  const observations = observationsFrom(steps);
  const timeline = buildTimeline(steps, facts);
  const completedReads = steps.filter((s) => s.state === 'completed').length;

  const investigation = {
    goal: planned.goal,
    fingerprint: saved.fingerprint,
    steps: steps.map((s) => ({
      id: s.id, operation: s.operation, tool: s.tool, state: s.state,
      table: s.inputs?.table ?? null,
    })),
  };

  if (outcome?.reason === 'cancelled') {
    /* §51 — partial evidence is retained and the run does not claim a diagnosis. */
    return stop({ ...base, investigation, facts, observations, timeline: buildTimeline(steps, facts) },
      STOP_REASONS.CANCELLED,
      `The investigation was cancelled after ${completedReads} read(s). What was read is kept; nothing was concluded.`);
  }

  /* 5. ANALYZE — the only model call in the diagnosis, and it may only cite. */
  const byId = indexFacts(facts);
  const analysis = await proposeHypotheses({
    subject, symptom: intent.symptom, facts, gaps, byId, chat, decoding, signal,
  });

  if (!analysis.ok) {
    return stop({ ...base, investigation, facts, observations, timeline },
      STOP_REASONS.INSUFFICIENT_EVIDENCE,
      `The evidence was collected but could not be analysed: ${analysis.note ?? analysis.reason}.`);
  }

  /* 6. DIAGNOSE — arithmetic, not prose. Nothing below consults the model. */
  /*
   * THE USER'S OWN WORDS OUTRANK THE ANALYST'S READING OF THEM.
   *
   * FOUND ON THE REAL INSTANCE. A genuinely unassigned incident was reported as
   * NO_PROBLEM_FOUND, because the analyst answered `symptom_expect: "present"`
   * for the question "why is INC0010058 not assigned?" and that answer was
   * taken in preference to the one the intent parser had already derived
   * deterministically from the sentence. `checkSymptom` then asked "is
   * assigned_to populated?", found that it was not, and reported the symptom
   * as absent — inverting the finding.
   *
   * The intent parser matched the words "not ... assign" against a fixed table
   * and cannot have been persuaded of anything. So it wins, and the analyst's
   * reading is the FALLBACK for a complaint the table does not cover. The model
   * may suggest which field a vague symptom is about; it may not overrule a
   * determination already made from the user's own sentence.
   */
  const symptomCheck = (intent.symptom.field
    ? { field: intent.symptom.field, expect: intent.symptom.expect }
    : null) ?? analysis.symptomCheck;
  const symptomFactIds = symptomFactIdsOf(symptomCheck, facts);
  /*
   * PHASE 15 — which facts record an EVENT rather than a state. This is what
   * lets a hypothesis reach a root cause, and it is derived from the surfaces
   * the investigation actually read.
   */
  const causalFactIds = causalFactIdsOf(facts);
  const hypotheses = adjudicate(analysis.hypotheses, {
    symptomFactIds,
    causalFactIds,
    facts,
    /* §8 relevance needs to know WHAT is wrong and WHICH record has it. */
    symptomField: symptomCheck?.field ?? null,
    subjectSysId: facts.find((f) => f.source?.table === subject.type)?.source?.sys_id ?? null,
  });
  const symptomConfirmed = checkSymptom(symptomCheck, facts);

  const verdict = classify({
    hypotheses,
    completedReads,
    symptomConfirmed,
    symptomCheckedDeterministically: Boolean(intent.symptom.field),
    unknownCount: analysis.unknowns.length,
  });

  const leading = [...hypotheses]
    .filter((h) => h.status !== 'rejected')
    .sort((a, b) => rank(b) - rank(a))[0] ?? null;

  const conclusion = conclusionFrom(verdict, {
    statement: statementFor({ verdict, leading, symptomConfirmed, symptom: intent.symptom, subject }),
    supporting: leading?.evidence_for ?? symptomFactIds,
  });

  /* 7. RECOMMEND — separate, and never able to act by itself. */
  const recommendations = recommendFrom({
    outcome: verdict.outcome,
    conclusion,
    unknowns: analysis.unknowns,
  });

  const diagnosis = {
    ...base,
    investigation,
    facts,
    observations,
    timeline,
    hypotheses,
    inferences: hypotheses.map((h) => ({
      id: h.id, type: CLAIM_TYPES.INFERENCE, statement: h.statement,
      supporting_facts: h.evidence_for, confidence: h.confidence,
    })),
    conclusion,
    recommendations,
    unknowns: [
      ...analysis.unknowns,
      /*
       * §18/§60.7 — a read that hit its ceiling becomes a stated limitation.
       * Silently presenting a truncated list as complete is a release blocker,
       * and the honest place for it is beside the other things not known.
       */
      ...truncatedReads(steps).map((t) => ({
        type: CLAIM_TYPES.UNKNOWN,
        statement: `The ${t.tool} read in ${t.step} reached its limit of ${t.limit} row(s), `
          + 'so anything beyond that was not read and is not accounted for here.',
        reason: BUDGET_EXHAUSTED,
      })),
      ...gaps.map((g) => ({
      type: CLAIM_TYPES.UNKNOWN,
      statement: `The read planned as ${g.step} did not complete, so nothing it would have shown is known.`,
      reason: g.reason,
      })),
    ],
    outcome: verdict.outcome,
    cause_label: verdict.label,
    reason: verdict.reason,
    symptom_confirmed: symptomConfirmed,
    /* §38's headline metric, carried on the result so it cannot go unnoticed. */
    invented_citations: analysis.invented,
    overstated: hypotheses.filter((h) => h.overstated).map((h) => h.id),
    stopped: null,
  };

  if (typeof record === 'function') record(taskId, diagnosis);
  emit({ type: 'diagnosis', taskId, outcome: diagnosis.outcome, label: diagnosis.cause_label });
  return diagnosis;
}

const RANK = { strong: 3, moderate: 2, weak: 1, insufficient: 0 };
const rank = (h) => RANK[h?.support_level] ?? 0;

/** The one sentence a person reads first. Built from the verdict, never volunteered. */
function statementFor({ verdict, leading, symptomConfirmed, symptom, subject }) {
  const who = subject?.identifier ? `${subject.type} ${subject.identifier}` : 'the record';
  if (verdict.outcome === OUTCOMES.NO_PROBLEM_FOUND) {
    return `The reported condition is not present on ${who}.`;
  }
  if (verdict.outcome === OUTCOMES.INVESTIGATION_BLOCKED) {
    return `Nothing could be established about ${who}: ${verdict.reason}.`;
  }
  /*
   * WHEN NOTHING IS ESTABLISHED, DO NOT LEAD WITH ONE EXPLANATION.
   *
   * Seen in the DoD output: the verdict was MULTIPLE_PLAUSIBLE_CAUSES and the
   * headline read "ROOT CAUSE NOT ESTABLISHED: the incident may remain
   * unassigned because it lacks a caller_id" — naming the top-ranked guess as
   * though it were the finding. A reader skimming the first line would take
   * away a cause the run had just declined to choose between. Where several
   * explanations survive, the headline says so and the list below gives them
   * all equal billing.
   */
  if (verdict.outcome === OUTCOMES.MULTIPLE_PLAUSIBLE_CAUSES) {
    return `The reported condition is present on ${who}, and more than one explanation remains `
      + 'consistent with what was read. None is established.';
  }
  if (!leading) {
    return symptomConfirmed
      ? `The reported condition is present on ${who}, but its cause is not established by the evidence collected.`
      : 'No explanation for the reported condition could be supported by the evidence collected.';
  }
  if (verdict.outcome === OUTCOMES.INSUFFICIENT_EVIDENCE) {
    return `The reported condition is present on ${who}, but its cause is not established by the evidence collected.`;
  }
  return `${verdict.label}: ${leading.statement}`;
}

/** End a run early, with the reason on the record and nothing claimed. */
function stop(partial, reason, note) {
  return {
    ...partial,
    outcome: reason === STOP_REASONS.MUTATION_IN_DIAGNOSE || reason === STOP_REASONS.READ_FAILED
      ? OUTCOMES.INVESTIGATION_BLOCKED
      : partial.outcome ?? OUTCOMES.INSUFFICIENT_EVIDENCE,
    cause_label: CAUSE_LABELS[
      reason === STOP_REASONS.MUTATION_IN_DIAGNOSE || reason === STOP_REASONS.READ_FAILED
        ? OUTCOMES.INVESTIGATION_BLOCKED
        : partial.outcome ?? OUTCOMES.INSUFFICIENT_EVIDENCE
    ],
    conclusion: {
      type: CLAIM_TYPES.CONCLUSION,
      statement: note,
      supporting_evidence: [],
      status: 'qualified',
      root_cause: false,
      support_level: 'insufficient',
    },
    /*
     * A stopped run returns the SAME shape as a completed one. These two are
     * empty rather than absent because a reader counting unsupported claims
     * across runs should not have to special-case the runs that stopped — and a
     * missing key reads as "not measured" where an empty array reads as "none".
     */
    invented_citations: [],
    overstated: [],
    stopped: { reason, note },
  };
}

export {
  readIntent, planInvestigation, assertReadOnly, factsFrom, indexFacts,
  checkCitations, isSecretField, isFact, isInference, isUnknown, isHypothesis,
  renderDiagnosis, investigationGoal, buildTimeline, causalFactIdsOf,
  CAUSAL_SURFACES, diagnosticSurfaceWasRead, unsupportedBlame, failureIsRelevant, symptomStems,
  checkStepBudget, truncatedReads, BUDGET_EXHAUSTED,
  proposeHypotheses, adjudicate, classify, conclusionFrom, checkSymptom,
  recommendFrom, approvalContext, remediationGoal, observationsFrom, gapsFrom,
  symptomFactIdsOf,
};
export * from './schemas.js';
