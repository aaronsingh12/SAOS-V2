/**
 * PHASE 14 — WHAT TO DO NEXT, KEPT SEPARATE FROM WHAT IS TRUE.
 *
 * §19 requires recommendations to be separate from the diagnosis, and the
 * separation is not cosmetic. A diagnosis is a claim about the instance and is
 * judged by evidence. A recommendation is a proposed ACTION and is judged by
 * consequence. Merging them produces the failure where a system that is 60%
 * sure what is wrong is 100% ready to change something.
 *
 * THE RULE THAT MATTERS. A recommendation that mutates is never carried out
 * here. It becomes a GOAL for the existing planner, which produces a plan, which
 * is canonicalised, fingerprinted, reviewed and approved exactly as in Phases
 * 11-13. This module contains no call to `executeTool`, no ServiceNow client,
 * and no approval logic — it writes a sentence for the planner to plan.
 *
 * A DIAGNOSIS THAT ESTABLISHED NOTHING RECOMMENDS INVESTIGATION, NOT ACTION.
 * That is the entire point of `recommendFrom`: the outcome decides whether a
 * mutation may even be proposed, so an unsupported story cannot become a
 * change to a real record.
 */
import { OUTCOMES, SUPPORT_LEVEL, isRecommendation } from './schemas.js';

/**
 * Outcomes from which proposing a MUTATION is defensible.
 *
 * Deliberately short. NO_PROBLEM_FOUND is on it because the honest action when
 * nothing is wrong is to change nothing — a recommendation is still produced,
 * it just does not mutate. INSUFFICIENT_EVIDENCE and INVESTIGATION_BLOCKED are
 * absent because a change proposed on evidence that does not exist is a guess
 * wearing a workflow.
 */
export const MUTATION_ALLOWED_FROM = Object.freeze([
  OUTCOMES.ROOT_CAUSE_ESTABLISHED,
  OUTCOMES.LIKELY_CAUSE_IDENTIFIED,
]);

/**
 * Build the recommendation set for a finished diagnosis.
 *
 * `proposed` are candidate remediations the caller believes are available —
 * they are FILTERED here, never invented here. A caller that proposes a
 * mutation off an unsupported diagnosis gets it downgraded to an investigative
 * recommendation with the reason stated, rather than dropped silently.
 */
export function recommendFrom({ outcome, conclusion, unknowns = [], proposed = [] } = {}) {
  const out = [];
  const mutationOk = MUTATION_ALLOWED_FROM.includes(outcome);

  for (const p of proposed) {
    const statement = typeof p?.statement === 'string' ? p.statement.trim() : '';
    if (!statement) continue;

    if (p.mutation && !mutationOk) {
      /*
       * The proposal survives, stripped of its power to act. Deleting it would
       * hide from the reader that a change WAS considered and why it was not
       * offered — which is exactly the reasoning a person needs in order to
       * disagree.
       */
      out.push({
        statement: `Do not change the record yet. ${statement}`,
        reason: [
          `The diagnosis ended as ${outcome}.`,
          'A change proposed on evidence this thin would be a guess applied to a real record.',
        ],
        risk: 'low',
        mutation: false,
        requires_approval: false,
        withheld: { statement, because: outcome },
      });
      continue;
    }

    out.push({
      statement,
      reason: Array.isArray(p.reason) ? p.reason : [p.reason].filter(Boolean),
      risk: p.risk ?? (p.mutation ? 'medium' : 'low'),
      mutation: Boolean(p.mutation),
      /* A mutation ALWAYS requires approval. Not a default — an invariant. */
      requires_approval: Boolean(p.mutation),
    });
  }

  /*
   * Every run ends with something a person can do. A diagnosis that names no
   * next step reads as a dead end even when it has told the reader a great
   * deal.
   */
  if (!out.length) {
    out.push(nextStepFor({ outcome, conclusion, unknowns }));
  }

  return out.filter(isRecommendation);
}

/** The default, non-mutating next step implied by how the run ended. */
function nextStepFor({ outcome, conclusion, unknowns = [] }) {
  const gaps = unknowns.slice(0, 2).map((u) => u.statement);
  switch (outcome) {
    case OUTCOMES.NO_PROBLEM_FOUND:
      return {
        statement: 'No change is needed. The reported condition is not present on the record.',
        reason: [conclusion?.statement ?? 'The instance was read and does not show the reported problem.'],
        risk: 'low', mutation: false, requires_approval: false,
      };
    case OUTCOMES.INVESTIGATION_BLOCKED:
      return {
        statement: 'Re-run the investigation once the reads that failed can complete.',
        reason: ['The investigation did not gather enough of the instance to say anything.'],
        risk: 'low', mutation: false, requires_approval: false,
      };
    case OUTCOMES.MULTIPLE_PLAUSIBLE_CAUSES:
      return {
        statement: 'Gather the evidence that would separate the remaining explanations before changing anything.',
        reason: ['More than one explanation is still supported by what was read.', ...gaps],
        risk: 'low', mutation: false, requires_approval: false,
      };
    default:
      return {
        statement: gaps.length
          ? `Inspect what could not be established here before changing the record: ${gaps.join('; ')}.`
          : 'Gather more evidence before changing the record.',
        reason: [conclusion?.statement ?? 'The cause was not established from the available evidence.', ...gaps],
        risk: 'low', mutation: false, requires_approval: false,
      };
  }
}

/**
 * Turn an approved-in-principle remediation into a GOAL for the existing planner.
 *
 * This is the whole of the Doctor's remediation path: a sentence. Everything
 * after it — capability discovery, tool choice, `$ref` resolution,
 * canonicalisation, fingerprinting, the approval card, `executeTool`, read-back
 * — is the pipeline Phases 4-13 already built and proved. There is no
 * `doctorExecutor`, and the reason there is none is that nothing here needs one.
 *
 * The diagnosis travels with the goal as CONTEXT for the approval card (§21),
 * not as an instruction: the planner is told what is wrong and what to do, and
 * the validator judges the resulting plan the same way it judges every other.
 */
export function remediationGoal(recommendation, { subject, conclusion } = {}) {
  if (!recommendation?.mutation) {
    throw new Error('remediationGoal is only for a recommendation that mutates');
  }
  const who = subject?.identifier ? `${subject.type} ${subject.identifier}` : 'the record';
  const because = conclusion?.statement ? ` Diagnosis: ${conclusion.statement}` : '';
  return `${recommendation.statement} The subject is ${who}.${because}`;
}

/**
 * The diagnostic context an approval card carries (§21).
 *
 * Pure projection — it reads the finished diagnosis and reshapes it. It adds no
 * claim, and in particular it cannot upgrade a cause label: `label` comes from
 * the outcome, which came from the evidence rule.
 */
export function approvalContext({ subject, symptom, conclusion, outcome, label, facts = [], unknowns = [] } = {}) {
  return {
    problem: symptom?.statement ?? null,
    subject: subject ? `${subject.type} ${subject.identifier ?? ''}`.trim() : null,
    diagnosis: conclusion?.statement ?? null,
    outcome,
    label,
    support_level: conclusion?.support_level ?? SUPPORT_LEVEL.INSUFFICIENT,
    /*
     * The evidence a reader needs to disagree with the diagnosis, not all of
     * it. A card carrying ninety field observations is a card nobody reads,
     * and an unread card is an unmade decision.
     */
    evidence: (conclusion?.supporting_evidence ?? [])
      .map((id) => facts.find((f) => f.id === id))
      .filter(Boolean)
      .map((f) => ({ id: f.id, statement: f.statement, source: f.source })),
    unknowns: unknowns.map((u) => u.statement),
  };
}
