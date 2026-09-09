/**
 * PHASE 14 — WHO IS ALLOWED TO SAY "ROOT CAUSE".
 *
 * Not the model. This module.
 *
 * §24 requires that the label on a cause be decided by a deterministic minimum
 * evidence rule which the model cannot override. That is what is implemented
 * here, and the implementation is deliberately arithmetic: it counts citations
 * that survived checking, counts contradictions, counts admitted gaps, and
 * looks the answer up. There is no parameter through which a persuasive
 * sentence can raise a support level.
 *
 * THE COUPLING THAT MAKES IT WORK. Support is counted from
 * `evidence_for` — and by the time a hypothesis reaches this module those ids
 * have been through `checkCitations`, so any id the model invented has already
 * been stripped. A fabricated citation therefore does not merely fail to help;
 * it actively LOWERS the support level, because the hypothesis now cites fewer
 * real facts than it claimed to. Inventing evidence makes the conclusion
 * weaker, which is the incentive this phase needs.
 *
 * WHY CONTRADICTION OUTRANKS SUPPORT. A hypothesis with evidence on both sides
 * can never be a root cause here, however much support it has. "The assignment
 * workflow failed" with five supporting observations and one execution record
 * showing the workflow completed is not a strong finding — it is an unresolved
 * one, and reporting it as established is precisely the failure mode a
 * diagnostic tool must not have.
 */
import {
  OUTCOMES, CAUSE_LABELS, SUPPORT_LEVEL, HYPOTHESIS_STATUS,
  CONFIDENCE, CLAIM_TYPES, STOP_REASONS,
} from './schemas.js';

/**
 * The minimum evidence rule, stated once as numbers.
 *
 * `STRONG_MIN_FOR` is 2 rather than 1 on purpose. A single observation is
 * usually the SYMPTOM restated — "assigned_to is empty" supporting "the
 * incident is unassigned" is one fact wearing two hats — and a rule that let
 * that establish a root cause would establish one for every request.
 */
export const EVIDENCE_RULE = Object.freeze({
  STRONG_MIN_FOR: 2,
  STRONG_MAX_AGAINST: 0,
  STRONG_MAX_MISSING: 0,
  MODERATE_MIN_FOR: 1,
  MODERATE_MAX_AGAINST: 0,
  MODERATE_MAX_MISSING: 1,
});

/**
 * How strongly is this ONE hypothesis supported?
 *
 * Counts only. `status` and `confidence` as written by whoever proposed the
 * hypothesis are ignored here — they are the claim, not the evidence, and this
 * function exists to check the claim against the evidence.
 */
export function supportLevelOf(h, { symptomFactIds = [], causalFactIds = [], diagnosticSurfaceRead = false } = {}) {
  const evidenceFor = Array.isArray(h?.evidence_for) ? h.evidence_for : [];
  const forCount = evidenceFor.length;
  const againstCount = Array.isArray(h?.evidence_against) ? h.evidence_against.length : 0;
  const missingCount = Array.isArray(h?.missing_evidence) ? h.missing_evidence.length : 0;

  if (forCount === 0) return SUPPORT_LEVEL.INSUFFICIENT;

  /*
   * AN EXPLANATION WHOSE ONLY EVIDENCE IS THE SYMPTOM EXPLAINS NOTHING.
   *
   * This is the rule that separates the specification's good example from its
   * bad one, and it was added because counting citations alone did not.
   * Measured, with a real fact set and a deliberately overreaching analysis:
   *
   *   hypothesis     "The assignment workflow failed."
   *   evidence_for   [assigned_to is empty]      <- the symptom, restated
   *   result         LIKELY CAUSE
   *
   * One real citation, nothing contradicting it, no admitted gaps — the
   * arithmetic was satisfied and the conclusion was still wrong. "assigned_to
   * is empty" is the thing being explained; offering it as the evidence FOR an
   * explanation is circular, and no amount of counting detects that.
   *
   * So a causal hypothesis has to bring something the symptom did not already
   * say. If everything it cites is the symptom, it is capped at WEAK — it
   * remains on the record as a POSSIBLE cause, which is what it is, and can
   * never be reported as established or likely.
   *
   * The symptom's own fact ids are known deterministically: `checkSymptom`
   * already identifies the field, and the facts carry their field.
   */
  const beyondSymptom = evidenceFor.filter((id) => !symptomFactIds.includes(id));
  if (symptomFactIds.length && beyondSymptom.length === 0) return SUPPORT_LEVEL.WEAK;

  // Contested. Some evidence points the other way, so nothing here is settled.
  if (againstCount > 0) return SUPPORT_LEVEL.WEAK;

  /*
   * PHASE 15 — A STATE CANNOT EXPLAIN A STATE (§8, §25, §28).
   *
   * Phase 14 stopped a hypothesis resting ONLY on the symptom. That was
   * necessary and not sufficient: "assigned_to is empty" plus "priority is 3"
   * is two independent facts, satisfies the count, and still explains nothing,
   * because both are descriptions of how the record looks right now. An
   * explanation of how it came to look that way needs something that HAPPENED.
   *
   * `causal` is set in `evidence.js` from the SURFACE a fact came from, not
   * from its wording: a field read off a record is state, while an audited
   * change, an automation execution and an SLA breach are events. So the rule
   * is mechanical — to be STRONG, a hypothesis must cite at least one event.
   *
   * This is also what stops the inference §8 forbids. "The symptom is true and
   * a flow exists" cannot reach a root cause, because a flow merely EXISTING
   * contributes an execution fact but the hypothesis still has to survive
   * contradiction and gaps; and "no execution was found" is deliberately not
   * causal, so absence of evidence can never become evidence of failure.
   *
   * When no causal evidence was gathered at all, the rule cannot discriminate
   * and is not applied — otherwise every Phase 14-shaped investigation, which
   * collected no event evidence by construction, would silently lose a rung.
   */
  if (causalFactIds.length || diagnosticSurfaceRead) {
    /*
     * `diagnosticSurfaceRead` is why this is not simply `causalFactIds.length`.
     * An investigation that READ the automation surface and found nothing has
     * gathered no causal facts — and before this clause the rule switched
     * itself off, so a hypothesis citing only the symptom and an absence came
     * back STRONG. Having looked and found nothing is not the same as never
     * having looked, and only the second one justifies relaxing the rule.
     */
    const citesAnEvent = evidenceFor.some((id) => causalFactIds.includes(id));
    if (!citesAnEvent) return SUPPORT_LEVEL.MODERATE;
  }

  if (forCount >= EVIDENCE_RULE.STRONG_MIN_FOR
      && againstCount <= EVIDENCE_RULE.STRONG_MAX_AGAINST
      && missingCount <= EVIDENCE_RULE.STRONG_MAX_MISSING) {
    return SUPPORT_LEVEL.STRONG;
  }
  if (forCount >= EVIDENCE_RULE.MODERATE_MIN_FOR
      && againstCount <= EVIDENCE_RULE.MODERATE_MAX_AGAINST
      && missingCount <= EVIDENCE_RULE.MODERATE_MAX_MISSING) {
    return SUPPORT_LEVEL.MODERATE;
  }
  return SUPPORT_LEVEL.WEAK;
}

/**
 * The status a hypothesis has EARNED, which may not be the one it claims.
 *
 * `rejected` requires contradiction with no support left standing. It is the
 * outcome a self-assessing model reaches least often and the one a diagnostic
 * system needs most, so it is computed rather than accepted.
 */
export function statusOf(h, opts = {}) {
  const forCount = Array.isArray(h?.evidence_for) ? h.evidence_for.length : 0;
  const againstCount = Array.isArray(h?.evidence_against) ? h.evidence_against.length : 0;

  if (againstCount > 0 && forCount === 0) return HYPOTHESIS_STATUS.REJECTED;
  if (forCount === 0) return HYPOTHESIS_STATUS.UNKNOWN;
  if (againstCount > 0) return HYPOTHESIS_STATUS.PLAUSIBLE;   // contested, not settled
  const level = supportLevelOf(h, opts);
  if (level === SUPPORT_LEVEL.STRONG) return HYPOTHESIS_STATUS.SUPPORTED;
  return HYPOTHESIS_STATUS.PLAUSIBLE;
}

/** Confidence follows support. It describes evidence, never feeling. */
export function confidenceOf(h, opts = {}) {
  switch (supportLevelOf(h, opts)) {
    case SUPPORT_LEVEL.STRONG: return CONFIDENCE.HIGH;
    case SUPPORT_LEVEL.MODERATE: return CONFIDENCE.MEDIUM;
    default: return CONFIDENCE.LOW;
  }
}

/**
 * Re-derive every hypothesis's standing from its evidence.
 *
 * Returns NEW objects. The proposed status and confidence are preserved under
 * `claimed`, because the gap between what was claimed and what the evidence
 * supports is itself a measurement — §38's unsupported-claim rate is counted
 * from exactly this difference.
 */
export function adjudicate(hypotheses = [], opts = {}) {
  const facts = opts.facts ?? [];
  /* Computed once here so every hypothesis is judged against the same answer
   * to "did this investigation look at the event surfaces". */
  const options = {
    ...opts,
    diagnosticSurfaceRead: opts.diagnosticSurfaceRead ?? diagnosticSurfaceWasRead(facts),
  };
  return hypotheses.map((h) => {
    /*
     * PHASE 15 — A CLAIM MUST CITE THE KIND OF EVIDENCE IT DEPENDS ON (§8).
     *
     * "The assignment workflow failed", supported by "assigned_to is empty", is
     * the exact inference §8 forbids: the symptom plus the mere idea of a flow.
     * A hypothesis that names automation, a change or an SLA as the culprit and
     * cites no fact from that surface is capped at WEAK, and what it failed to
     * bring is recorded so the report can say which claim outran its evidence.
     */
    const blame = unsupportedBlame(h, facts, opts);

    /*
     * A CAP ONLY EVER DOWNGRADES. Written first as a straight substitution, it
     * promoted a hypothesis with NO evidence at all from `unknown` to
     * `plausible` — the blame check is a ceiling on how strong a claim may be,
     * not a verdict on how strong it is, and applying it as one made an
     * unevidenced claim look better than it was. Caught by a Phase 14 test.
     */
    const computedStatus = statusOf(h, options);
    const computedSupport = supportLevelOf(h, options);
    const capRank = (level) => ({ insufficient: 0, weak: 1, moderate: 2, strong: 3 }[level] ?? 0);
    const support = blame.length && capRank(computedSupport) > capRank(SUPPORT_LEVEL.WEAK)
      ? SUPPORT_LEVEL.WEAK
      : computedSupport;
    const status = blame.length && computedStatus === HYPOTHESIS_STATUS.SUPPORTED
      ? HYPOTHESIS_STATUS.PLAUSIBLE
      : computedStatus;
    const confidence = blame.length ? CONFIDENCE.LOW : confidenceOf(h, options);
    /*
     * What the ANALYST claimed, not the placeholder `sanitiseAnalysis` wrote.
     * It parks the model's own confidence in `claimed_confidence` precisely so
     * this comparison is possible — reading `h.confidence` here would compare
     * the placeholder against itself and measure nothing.
     */
    const claimed = {
      status: h.claimed_status ?? null,
      confidence: h.claimed_confidence ?? null,
    };
    const overstated = (claimed.status === HYPOTHESIS_STATUS.SUPPORTED && status !== HYPOTHESIS_STATUS.SUPPORTED)
      || (claimed.confidence === CONFIDENCE.HIGH && confidence !== CONFIDENCE.HIGH)
      || (claimed.confidence === CONFIDENCE.MEDIUM && confidence === CONFIDENCE.LOW);
    return {
      ...h,
      status,
      confidence,
      support_level: support,
      claimed,
      overstated: Boolean(overstated) || blame.length > 0,
      unsupported_blame: blame,
    };
  });
}

/**
 * The outcome of the whole run.
 *
 * @param {object} input
 *   hypotheses      already adjudicated
 *   blocked         true when the investigation could not be carried out
 *   stopReason      a STOP_REASONS value when it stopped early
 *   completedReads  how many investigation steps actually produced a result
 *   symptomConfirmed  true | false | null — see below
 *
 * `symptomConfirmed` is a THREE-valued answer and the distinction matters.
 * `false` means the instance was read and the reported problem is not there,
 * which is NO_PROBLEM_FOUND — a real and useful finding. `null` means nobody
 * could check, which is not the same thing and must never collapse into it.
 */
export function classify({
  hypotheses = [],
  blocked = false,
  stopReason = null,
  completedReads = 0,
  symptomConfirmed = null,
  unknownCount = 0,
  /* True only when the symptom's field came from the intent parser. */
  symptomCheckedDeterministically = false,
} = {}) {
  /* 1. Could the investigation happen at all? Nothing else is answerable first. */
  if (blocked || completedReads === 0) {
    return decided(OUTCOMES.INVESTIGATION_BLOCKED,
      stopReason ? `the investigation stopped: ${stopReason}` : 'no investigation step produced a result');
  }
  if (stopReason === STOP_REASONS.MISSING_CAPABILITY || stopReason === STOP_REASONS.READ_FAILED) {
    return decided(OUTCOMES.INVESTIGATION_BLOCKED, `the investigation stopped: ${stopReason}`);
  }

  /*
   * 2. Is the reported problem actually there?
   *
   * Checked BEFORE causes, because looking for the cause of something that is
   * not happening is how a diagnostic system invents one.
   */
  /*
   * "THERE IS NOTHING WRONG" IS A CONCLUSION WITH CONSEQUENCES.
   *
   * It ends the investigation and tells a person to stop looking, so it is
   * reachable only when the condition being checked was derived DETERMINISTICALLY
   * from the user's own sentence — never from the analyst's reading of it.
   *
   * Measured on the PDI: for "…should be assigned to Zzz Nonexistent Person.
   * Why is it not?" the intent table matched no field, the analyst supplied
   * `assigned_to` with `expect: "present"`, and a genuinely unassigned incident
   * came back as NO PROBLEM FOUND. The check itself was performed correctly on
   * real facts; what was wrong was that a model got to choose the question.
   *
   * When the check came from the analyst, a negative answer is demoted to "not
   * established" rather than promoted to "nothing is wrong" — the run still
   * reports what it observed, and simply does not close the case.
   */
  if (symptomConfirmed === false && symptomCheckedDeterministically) {
    return decided(OUTCOMES.NO_PROBLEM_FOUND,
      'the reported condition was checked against the instance and is not present');
  }

  /*
   * A CAUSE FOR A CONDITION NOBODY OBSERVED IS SPECULATION.
   *
   * MEASURED. Asked "why is INC0010061 not assigned?" about an incident that
   * WAS assigned, the model planned a read that narrowed `fields` and never
   * fetched `assigned_to`. No fact addressed the field, so `checkSymptom`
   * correctly answered null — and the run then went on to rank explanations for
   * the unassignment and reported a LIKELY CAUSE. Every individual step was
   * right; the composition was not. It explained something it had not
   * established was happening, on a record where it was not.
   *
   * So when the request named a condition deterministically and the
   * investigation never read the field that would confirm it, no explanation
   * may rise above POSSIBLE. The reads that did happen are still reported, and
   * the reason is stated plainly rather than hidden in a confidence score.
   */
  const symptomUncheckable = symptomCheckedDeterministically && symptomConfirmed === null;

  const live = hypotheses.filter((h) => h.status !== HYPOTHESIS_STATUS.REJECTED);
  const strong = live.filter((h) => h.support_level === SUPPORT_LEVEL.STRONG);
  const moderate = live.filter((h) => h.support_level === SUPPORT_LEVEL.MODERATE);
  const weak = live.filter((h) => h.support_level === SUPPORT_LEVEL.WEAK);
  const contested = live.filter((h) => (h.evidence_against ?? []).length > 0);

  /* 3. Competing explanations outrank any single one, even a strong one. */
  if (strong.length > 1 || (strong.length === 1 && moderate.length >= 1)) {
    return decided(OUTCOMES.MULTIPLE_PLAUSIBLE_CAUSES,
      `${strong.length + moderate.length} explanations remain supported by the evidence`);
  }
  if (strong.length === 0 && moderate.length > 1) {
    return decided(OUTCOMES.MULTIPLE_PLAUSIBLE_CAUSES,
      `${moderate.length} explanations are equally supported`);
  }

  /* 4. One explanation, and the evidence rule decides what it may be called. */
  if (symptomUncheckable && (strong.length || moderate.length || weak.length)) {
    return decided(OUTCOMES.POSSIBLE_CAUSE,
      'the reported condition was never read, so no explanation for it can be more than possible');
  }
  if (strong.length === 1) {
    /*
     * AN ADMITTED UNKNOWN FORBIDS AN ESTABLISHED ROOT CAUSE.
     *
     * A run that recorded "no workflow execution could be read" has named
     * exactly the evidence that might overturn its own conclusion. Calling the
     * conclusion ESTABLISHED while that hole is on the record is the overreach
     * §55.3 makes a release blocker — and it is the shape of the
     * specification's own worked example, which lists MISSING EVIDENCE and
     * therefore concludes that the cause is not established.
     *
     * The finding is not discarded, only labelled honestly: it becomes the
     * LIKELY cause, which is what a well-supported explanation with a known
     * gap actually is.
     */
    if (unknownCount > 0) {
      return decided(OUTCOMES.LIKELY_CAUSE_IDENTIFIED,
        `one explanation is well supported, but ${unknownCount} relevant `
        + `${unknownCount === 1 ? 'question was' : 'questions were'} not answerable from this instance`);
    }
    return decided(OUTCOMES.ROOT_CAUSE_ESTABLISHED,
      `one explanation is supported by ${strong[0].evidence_for.length} observations, `
      + 'contradicted by none, with no admitted gaps');
  }
  if (moderate.length === 1) {
    return decided(OUTCOMES.LIKELY_CAUSE_IDENTIFIED,
      'one explanation is supported but the evidence does not close every gap');
  }
  if (weak.length >= 1) {
    return decided(OUTCOMES.POSSIBLE_CAUSE,
      contested.length
        ? 'the leading explanation is contradicted by at least one observation'
        : 'the leading explanation rests on thin evidence');
  }

  /* 5. Nothing survived. That is an answer, and a good one. */
  return decided(OUTCOMES.INSUFFICIENT_EVIDENCE,
    hypotheses.length
      ? 'no proposed explanation is supported by the evidence collected'
      : 'no explanation could be formed from the evidence collected');
}

function decided(outcome, reason) {
  return { outcome, label: CAUSE_LABELS[outcome], reason };
}

/**
 * Build the conclusion object for a run.
 *
 * `root_cause` is true only for ROOT_CAUSE_ESTABLISHED — the flag and the label
 * come from the same lookup, so a conclusion cannot be flagged as a root cause
 * while being labelled something weaker.
 */
export function conclusionFrom({ outcome, label, reason }, { statement = null, supporting = [] } = {}) {
  const rootCause = outcome === OUTCOMES.ROOT_CAUSE_ESTABLISHED;
  const supportByOutcome = {
    [OUTCOMES.ROOT_CAUSE_ESTABLISHED]: SUPPORT_LEVEL.STRONG,
    [OUTCOMES.LIKELY_CAUSE_IDENTIFIED]: SUPPORT_LEVEL.MODERATE,
    [OUTCOMES.POSSIBLE_CAUSE]: SUPPORT_LEVEL.WEAK,
    [OUTCOMES.MULTIPLE_PLAUSIBLE_CAUSES]: SUPPORT_LEVEL.WEAK,
    [OUTCOMES.INSUFFICIENT_EVIDENCE]: SUPPORT_LEVEL.INSUFFICIENT,
    [OUTCOMES.NO_PROBLEM_FOUND]: SUPPORT_LEVEL.STRONG,
    [OUTCOMES.INVESTIGATION_BLOCKED]: SUPPORT_LEVEL.INSUFFICIENT,
  };
  return {
    type: CLAIM_TYPES.CONCLUSION,
    statement: statement ?? reason,
    supporting_evidence: [...supporting],
    status: rootCause || outcome === OUTCOMES.NO_PROBLEM_FOUND ? 'supported' : 'qualified',
    root_cause: rootCause,
    support_level: supportByOutcome[outcome] ?? SUPPORT_LEVEL.INSUFFICIENT,
    label,
  };
}

/**
 * Evaluate a symptom against the facts, deterministically.
 *
 * The model may say WHICH field a complaint is about — "not assigned" is about
 * `assigned_to` — but it does not get to say whether the field is in that
 * state. That is read off the facts, which came off the instance.
 *
 * Returns true (the reported condition holds), false (it does not), or null
 * (no fact addresses that field, so nobody knows).
 */
export function checkSymptom(check, facts = []) {
  const field = check?.field ?? null;
  const expect = check?.expect ?? 'empty';
  if (!field) return null;
  const hit = facts.find((f) => f.field === field);
  if (!hit) return null;
  const isEmpty = hit.value === null || hit.value === undefined || hit.value === '';
  if (expect === 'empty') return isEmpty;
  if (expect === 'present') return !isEmpty;
  return hit.value === expect ? true : false;
}

/**
 * Which facts ARE the symptom.
 *
 * Used to stop a hypothesis citing the thing it is supposed to explain. Derived
 * from the facts rather than from anything the model said: the symptom field is
 * matched against `fact.field`, so the ids come from the same mechanical
 * extraction as every other fact.
 */
export function symptomFactIdsOf(check, facts = []) {
  const field = check?.field ?? null;
  if (!field) return [];
  return facts.filter((f) => f.field === field).map((f) => f.id);
}

/**
 * PHASE 15 — which facts record something that HAPPENED.
 *
 * Read straight off the fact's own `causal` marker, which `evidence.js` set
 * from the diagnostic surface it came from. Kept as a function rather than
 * inlined so the definition of "causal evidence" has exactly one home, and so a
 * test can assert what it returns for a given fact set.
 */
export function causalFactIdsOf(facts = []) {
  return facts.filter((f) => f && f.causal === true).map((f) => f.id);
}

/**
 * PHASE 15 — is this hypothesis about something the investigation actually saw?
 *
 * §8 permits a strong causal conclusion only when the automation evidence is
 * RELEVANT to the symptom, and forbids `symptom + flow exists = flow caused
 * symptom`. Relevance cannot be judged from prose without asking a model, which
 * would put the model back in charge of the thing this phase takes away from
 * it. So the deterministic test is narrower and honest: a hypothesis that
 * BLAMES automation must cite an automation fact, and one that blames a change
 * must cite a change.
 *
 * It returns the unmet requirement rather than a boolean, so the diagnosis can
 * tell a reader exactly which claim outran its evidence.
 */
const BLAME_PATTERNS = Object.freeze([
  { re: /\b(flow|workflow|automation|business rule|script)\b/i, needs: 'flow_execution', label: 'automation' },
  { re: /\b(changed|change|edited|overwrote|overwritten|reassign)\b/i, needs: 'changed_', label: 'a recorded change' },
  { re: /\bsla\b/i, needs: 'sla_', label: 'SLA' },
]);

/**
 * Does the statement assert that something FAILED, as opposed to merely
 * happening?
 *
 * The distinction matters because the two need different evidence. "The
 * assignment flow ran" is supported by any execution fact; "the assignment
 * flow FAILED" is supported only by a failed one, and nothing else will do.
 */
const CLAIMS_FAILURE = /\b(fail(ed|ure|s)?|error(ed)?|crash(ed)?|broke|broken|did not (complete|run|finish|succeed)|never (ran|completed|finished)|could not)\b/i;

/** A cited fact that actually evidences an automation FAILURE. */
const isFailureEvidence = (f) => {
  const field = String(f?.field ?? '');
  if (field === 'flow_execution_error') return true;
  if (field === 'flow_execution_state') return String(f?.value ?? '') === 'EXECUTION_ERROR';
  return false;
};

/**
 * PHASE 15 — RELEVANCE: is the failure about the thing that is wrong? (§8)
 *
 * FOUND ON THE REAL INSTANCE, and it is the failure this phase most needed to
 * catch. Creating an incident attaches an SLA, which triggers the "SLA
 * notification and escalation flow", which reliably ends in ERROR with
 * "Failed to initialize flow context". That is a genuine, provenanced,
 * causal-class failure sitting a hop away from every incident on the box.
 *
 * Offered as evidence for "the assignment automation failed, which is why
 * nobody is assigned", it satisfied every rule written up to that point — real
 * citation, real event, real failure, no contradiction — and the verdict came
 * back ROOT CAUSE ESTABLISHED. The system had found the nearest error and
 * blamed it. §8 forbids exactly this and §60.5 makes it a release blocker.
 *
 * RELEVANCE CANNOT BE JUDGED FROM PROSE without asking a model, which would
 * hand the decision back to the thing this phase takes it away from. So the
 * test is narrow and structural, and it passes on either of two grounds:
 *
 *   1. The execution ran ON the record that has the symptom. A flow acting on
 *      this very incident is about this incident.
 *   2. The flow's name or its error text mentions the symptom's own subject.
 *      "Assign Incident", failing with "the assignment group could not be
 *      resolved", is about assignment; "SLA notification and escalation",
 *      failing to initialise, is not.
 *
 * The stem comes from the SYMPTOM FIELD, which the intent parser derived from
 * the user's own words — not from anything a model wrote.
 *
 * WHAT THIS DOES NOT DO. It cannot confirm relevance, only refuse the clearly
 * irrelevant. A flow genuinely responsible but named nothing like its effect
 * will be capped at LIKELY rather than ROOT CAUSE. That is the correct
 * direction to be wrong in: the cost is a weaker true claim, and the
 * alternative is a confident false one.
 */
const STEM_STOPWORDS = new Set(['id', 'to', 'by', 'on', 'at', 'group', 'sys']);

export function symptomStems(field) {
  return String(field ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 4 && !STEM_STOPWORDS.has(w))
    .map((w) => w.replace(/(ed|ment|ing|s)$/, ''))
    .filter((w) => w.length >= 4);
}

export function failureIsRelevant(citedFacts, { symptomField = null, subjectSysId = null } = {}) {
  const failures = citedFacts.filter(isFailureEvidence);
  if (!failures.length) return false;

  /* 1. It ran on the record that has the symptom. */
  if (subjectSysId && failures.some(
    (f) => f.about === subjectSysId || f.source?.sys_id === subjectSysId)) return true;

  /* 2. It names what the symptom is about. */
  const stems = symptomStems(symptomField);
  if (!stems.length) return false;
  const text = citedFacts
    .filter((f) => String(f.field ?? '').startsWith('flow_execution'))
    .map((f) => `${f.statement ?? ''} ${f.value ?? ''}`)
    .join(' ')
    .toLowerCase();
  return stems.some((stem) => text.includes(stem));
}

export function unsupportedBlame(hypothesis, facts = [], opts = {}) {
  const statement = String(hypothesis?.statement ?? '');
  const cited = new Set(hypothesis?.evidence_for ?? []);
  const citedFacts = facts.filter((f) => cited.has(f.id));
  const out = [];
  for (const { re, needs, label } of BLAME_PATTERNS) {
    if (!re.test(statement)) continue;
    const has = citedFacts.some((f) => String(f.field ?? '').startsWith(needs)
      || String(f.field ?? '') === needs);
    if (!has) { out.push({ blames: label, missing: needs }); continue; }

    /*
     * IT CITED THE RIGHT SURFACE. DID IT CITE THE RIGHT ANSWER?
     *
     * Two measured escapes, both of which reached ROOT CAUSE before this
     * existed and both of which are the shapes §32 and §33 name:
     *
     *   "the automation failed", citing an execution whose state is
     *   EXECUTION_COMPLETE — evidence that it ran, offered as evidence that it
     *   broke;
     *
     *   "the automation failed", citing the NO_EXECUTION_FOUND observation —
     *   an absence, offered as a failure. §33 is explicit that these are
     *   different findings.
     *
     * So a claim of failure has to cite a failure: an error message, or an
     * execution whose state actually is EXECUTION_ERROR.
     */
    if (label === 'automation' && CLAIMS_FAILURE.test(statement)) {
      if (!citedFacts.some(isFailureEvidence)) {
        out.push({ blames: 'an automation FAILURE', missing: 'flow_execution_error or EXECUTION_ERROR' });
      } else if (!failureIsRelevant(citedFacts, opts)) {
        out.push({
          blames: 'an automation failure that is not about this symptom',
          missing: 'a failure on this record, or one naming what the symptom is about',
        });
      }
    }
  }
  return out;
}

/**
 * PHASE 15 — did this investigation read any surface that records EVENTS?
 *
 * Separate from `causalFactIdsOf` because the two answer different questions.
 * That one asks "what events were found"; this asks "did we look". An
 * investigation that queried the automation surface and got nothing has looked,
 * and its hypotheses must still meet the causal bar — otherwise finding nothing
 * would make claims easier to support than finding something.
 */
export const CAUSAL_SURFACES = Object.freeze([
  'find_flow_executions', 'get_flow_execution', 'get_record_audit', 'get_record_slas',
]);

export function diagnosticSurfaceWasRead(facts = []) {
  return facts.some((f) => CAUSAL_SURFACES.includes(f?.source?.tool));
}
