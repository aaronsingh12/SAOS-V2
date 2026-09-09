/**
 * PHASE 14 — THE DIAGNOSTIC VOCABULARY, and the shapes that carry it.
 *
 * This file is DATA and pure predicates. No I/O, no model, no ServiceNow, no
 * database. Everything the Doctor is allowed to say about an instance has a
 * type from this file, and every type has a rule that decides whether a
 * candidate really is one.
 *
 * WHY A SEPARATE VOCABULARY AT ALL. A diagnostic system fails in a way an
 * execution system does not: it fails by being CONFIDENT. Phases 0-13 built
 * gates around doing things — approval, fingerprints, read-back — and none of
 * them apply to a sentence. A model that says
 *
 *     "The assignment workflow failed."
 *
 * has performed no action, mutated nothing, tripped no guard, and produced the
 * single most damaging output this product can emit: a plausible claim the
 * instance never supported. So the guard has to live in the type system.
 *
 * THE ONE RULE EVERYTHING ELSE SERVES. A FACT can only come from a tool result.
 * Not from the model, not from an inference, not from a conclusion, and not
 * from another fact's restatement. `isFact` enforces provenance structurally,
 * so "the model said it" cannot produce a value that passes.
 *
 * Everything the model contributes is at most an INFERENCE, must cite facts by
 * id, and those ids are checked against facts that actually exist.
 */

/* ------------------------------------------------------------------ *
 * Claim types
 * ------------------------------------------------------------------ */

/**
 * What kind of statement this is. Deliberately four, deliberately closed.
 *
 *   FACT        observed in a tool result, with provenance naming where.
 *   INFERENCE   reasoning from facts. Cites them. Never becomes a fact.
 *   CONCLUSION  what the facts and qualified inferences support, together.
 *   UNKNOWN     a first-class output. Something that was looked for and not
 *               found, or could not be looked for at all.
 *
 * UNKNOWN is the type that makes the others honest. Without somewhere to put
 * "no evidence was found connecting this incident to a failed workflow", that
 * absence has nowhere to go except silence — and silence reads as absence of a
 * problem rather than absence of evidence.
 */
export const CLAIM_TYPES = Object.freeze({
  FACT: 'FACT',
  INFERENCE: 'INFERENCE',
  CONCLUSION: 'CONCLUSION',
  UNKNOWN: 'UNKNOWN',
});

export const CLAIM_TYPE_LIST = Object.freeze(Object.values(CLAIM_TYPES));

/* ------------------------------------------------------------------ *
 * Confidence
 * ------------------------------------------------------------------ */

/**
 * How strong the EVIDENCE is. Not how sure the model feels.
 *
 * Three coarse values on purpose. A number — `confidence: 0.97` — reads as a
 * measurement, and nothing here measures anything: it would be a model's
 * impression wearing the costume of a statistic. Three buckets cannot be
 * mistaken for a calibrated probability.
 */
export const CONFIDENCE = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' });
export const CONFIDENCE_LIST = Object.freeze(Object.values(CONFIDENCE));

/* ------------------------------------------------------------------ *
 * Hypotheses
 * ------------------------------------------------------------------ */

/**
 * Where a hypothesis stands once the evidence has been counted.
 *
 * `rejected` is as important as `supported`, and it is the one a model left to
 * itself will never produce. A hypothesis with evidence AGAINST it is the
 * mechanism by which "the workflow failed" gets killed rather than repeated.
 */
export const HYPOTHESIS_STATUS = Object.freeze({
  SUPPORTED: 'supported',
  PLAUSIBLE: 'plausible',
  REJECTED: 'rejected',
  UNKNOWN: 'unknown',
});
export const HYPOTHESIS_STATUS_LIST = Object.freeze(Object.values(HYPOTHESIS_STATUS));

/** How well the evidence supports a conclusion that claims a cause. */
export const SUPPORT_LEVEL = Object.freeze({
  STRONG: 'strong',
  MODERATE: 'moderate',
  WEAK: 'weak',
  INSUFFICIENT: 'insufficient',
});
export const SUPPORT_LEVEL_LIST = Object.freeze(Object.values(SUPPORT_LEVEL));

/* ------------------------------------------------------------------ *
 * Outcomes
 * ------------------------------------------------------------------ */

/**
 * How a diagnostic run ended.
 *
 * Every one of these is a SUCCESSFUL run of the Doctor. "I could not establish
 * the cause" is a finding — it tells a person the evidence is not there and
 * stops them acting on a story. Treating it as a failure is precisely the
 * pressure that produces invented causes.
 *
 * ON THE SPECIFICATION'S TWO LISTS. §25 names six outcomes; §24 and §31
 * additionally require POSSIBLE_CAUSE for the weak-evidence case. Both are
 * carried here: §25's six are all present and distinct, and POSSIBLE_CAUSE
 * sits between LIKELY_CAUSE_IDENTIFIED and INSUFFICIENT_EVIDENCE, which is the
 * gap §31's ladder needs it to fill.
 */
export const OUTCOMES = Object.freeze({
  ROOT_CAUSE_ESTABLISHED: 'ROOT_CAUSE_ESTABLISHED',
  LIKELY_CAUSE_IDENTIFIED: 'LIKELY_CAUSE_IDENTIFIED',
  POSSIBLE_CAUSE: 'POSSIBLE_CAUSE',
  MULTIPLE_PLAUSIBLE_CAUSES: 'MULTIPLE_PLAUSIBLE_CAUSES',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  NO_PROBLEM_FOUND: 'NO_PROBLEM_FOUND',
  INVESTIGATION_BLOCKED: 'INVESTIGATION_BLOCKED',
});
export const OUTCOME_LIST = Object.freeze(Object.values(OUTCOMES));

/**
 * The label a run may put in front of a cause, derived from the outcome.
 *
 * §24 requires that the model cannot choose this word. It is a lookup from the
 * outcome, and the outcome is computed from counted evidence — so "ROOT CAUSE"
 * is reachable only through the arithmetic, never through prose.
 */
export const CAUSE_LABELS = Object.freeze({
  [OUTCOMES.ROOT_CAUSE_ESTABLISHED]: 'ROOT CAUSE',
  [OUTCOMES.LIKELY_CAUSE_IDENTIFIED]: 'LIKELY CAUSE',
  [OUTCOMES.POSSIBLE_CAUSE]: 'POSSIBLE CAUSE',
  [OUTCOMES.MULTIPLE_PLAUSIBLE_CAUSES]: 'ROOT CAUSE NOT ESTABLISHED',
  [OUTCOMES.INSUFFICIENT_EVIDENCE]: 'ROOT CAUSE NOT ESTABLISHED',
  [OUTCOMES.NO_PROBLEM_FOUND]: 'NO PROBLEM FOUND',
  [OUTCOMES.INVESTIGATION_BLOCKED]: 'ROOT CAUSE NOT ESTABLISHED',
});

/** Modes. Diagnose is read-only; remediate goes through the existing pipeline. */
export const MODES = Object.freeze({ DIAGNOSE: 'diagnose', REMEDIATE: 'remediate' });
export const MODE_LIST = Object.freeze(Object.values(MODES));

/**
 * Why an investigation stopped early. §26's stop conditions, named.
 *
 * Each is a reason a person can act on, which is the difference between
 * stopping and merely failing.
 */
export const STOP_REASONS = Object.freeze({
  AMBIGUOUS_IDENTITY: 'ambiguous_identity',
  MISSING_CAPABILITY: 'missing_capability',
  CONFLICTING_EVIDENCE: 'conflicting_evidence',
  INSUFFICIENT_EVIDENCE: 'insufficient_evidence',
  MUTATION_IN_DIAGNOSE: 'mutation_requested_during_diagnosis',
  UNSUPPORTED_CAUSALITY: 'unsupported_causality',
  READ_FAILED: 'investigation_read_failed',
  CANCELLED: 'cancelled',
});
export const STOP_REASON_LIST = Object.freeze(Object.values(STOP_REASONS));

/* ------------------------------------------------------------------ *
 * Shape predicates
 * ------------------------------------------------------------------ */

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.every(isNonEmptyString);

/**
 * Does this provenance actually point at something that was read?
 *
 * A tool name alone is not provenance — `{ tool: 'get_record' }` says a read
 * happened somewhere and proves nothing about where. The step id is what ties
 * the claim to a row in the durable execution record, which is what makes it
 * auditable after the conversation is gone.
 */
export function isProvenance(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (!isNonEmptyString(p.step)) return false;
  if (!isNonEmptyString(p.tool)) return false;
  return true;
}

/**
 * Is this a FACT?
 *
 * THE LOAD-BEARING PREDICATE OF THE PHASE. Provenance is required and is
 * checked structurally, so the only way to construct something that passes is
 * to have read it off a tool result. A sentence the model produced has no step
 * and no tool, and there is no argument it can make that supplies them.
 *
 * `field` and `value` are required too. A "fact" with a statement but no
 * field/value pair is prose about a record rather than an observation of it,
 * and prose is exactly what must not be allowed to become a fact.
 */
export function isFact(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
  if (f.type !== CLAIM_TYPES.FACT) return false;
  if (!isNonEmptyString(f.id)) return false;
  if (!isNonEmptyString(f.statement)) return false;
  if (!isNonEmptyString(f.field)) return false;
  if (!('value' in f)) return false;
  return isProvenance(f.source);
}

/**
 * Is this a well-formed INFERENCE?
 *
 * It must cite at least one fact. An inference citing nothing is an assertion,
 * and an assertion with no evidence behind it is the thing this phase exists to
 * refuse. Whether the cited ids EXIST is checked elsewhere, against the real
 * fact set — this predicate only knows shape.
 */
export function isInference(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
  if (h.type !== CLAIM_TYPES.INFERENCE) return false;
  if (!isNonEmptyString(h.id)) return false;
  if (!isNonEmptyString(h.statement)) return false;
  if (!CONFIDENCE_LIST.includes(h.confidence)) return false;
  return isStringArray(h.supporting_facts) && h.supporting_facts.length > 0;
}

/** Is this a well-formed UNKNOWN? It must say WHY it is unknown. */
export function isUnknown(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return false;
  if (u.type !== CLAIM_TYPES.UNKNOWN) return false;
  if (!isNonEmptyString(u.statement)) return false;
  return isNonEmptyString(u.reason);
}

/**
 * Is this a well-formed hypothesis?
 *
 * `evidence_against` and `missing_evidence` are required ARRAYS even when
 * empty. Requiring the field forces the question to have been asked: a
 * hypothesis whose author never considered what would refute it is the
 * definition of confirmation bias, and an absent key hides that where an empty
 * array admits it.
 */
export function isHypothesis(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
  if (!isNonEmptyString(h.id)) return false;
  if (!isNonEmptyString(h.statement)) return false;
  if (!HYPOTHESIS_STATUS_LIST.includes(h.status)) return false;
  if (!CONFIDENCE_LIST.includes(h.confidence)) return false;
  if (!Array.isArray(h.evidence_for)) return false;
  if (!Array.isArray(h.evidence_against)) return false;
  if (!Array.isArray(h.missing_evidence)) return false;
  return true;
}

/** Is this a well-formed conclusion? */
export function isConclusion(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  if (c.type !== CLAIM_TYPES.CONCLUSION) return false;
  if (!isNonEmptyString(c.statement)) return false;
  if (!Array.isArray(c.supporting_evidence)) return false;
  if (c.root_cause !== undefined && typeof c.root_cause !== 'boolean') return false;
  if (c.support_level !== undefined && !SUPPORT_LEVEL_LIST.includes(c.support_level)) return false;
  return true;
}

/**
 * Is this a well-formed recommendation?
 *
 * `mutation` and `requires_approval` are required booleans, and a mutation that
 * does not require approval is refused outright rather than corrected. §19 says
 * a recommendation must never silently become an action; the shape makes the
 * silent version unrepresentable.
 */
export function isRecommendation(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  if (!isNonEmptyString(r.statement)) return false;
  if (typeof r.mutation !== 'boolean') return false;
  if (typeof r.requires_approval !== 'boolean') return false;
  if (r.mutation && !r.requires_approval) return false;
  return Array.isArray(r.reason) || isNonEmptyString(r.reason);
}

/**
 * The empty diagnostic result — the §6 shape, with nothing claimed.
 *
 * A run that collapses at the first read still returns this, so every consumer
 * sees the same keys and no reader has to distinguish "no facts" from "the
 * facts key is missing".
 */
export function emptyDiagnosis({ subject = null, symptom = null, mode = MODES.DIAGNOSE } = {}) {
  return {
    mode,
    subject,
    symptom,
    investigation: { steps: [] },
    facts: [],
    /* PHASE 15 — always present, so no reader distinguishes "no events" from
     * "this build does not produce timelines". */
    timeline: { events: [], timed: 0, untimed: 0, simultaneous: [], span: null },
    hypotheses: [],
    inferences: [],
    conclusion: null,
    recommendations: [],
    unknowns: [],
    outcome: OUTCOMES.INSUFFICIENT_EVIDENCE,
    cause_label: CAUSE_LABELS[OUTCOMES.INSUFFICIENT_EVIDENCE],
    stopped: null,
  };
}
