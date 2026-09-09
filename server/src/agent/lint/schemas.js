/**
 * PHASE 16 — THE LINT VOCABULARY, and the shapes that carry it.
 *
 * Pure data and predicates. No I/O, no model, no ServiceNow.
 *
 * THE ONE DISTINCTION THE WHOLE PHASE RESTS ON. A linter fails in two opposite
 * directions and they are not symmetrical:
 *
 *   a FALSE POSITIVE costs a person an afternoon proving nothing is wrong;
 *   a FALSE CONFIDENCE costs them a deployment.
 *
 * So a finding carries two independent axes, and §24 is explicit that they must
 * never be collapsed:
 *
 *   SEVERITY  how much it would hurt if true      (impact)
 *   STATUS    how well the evidence supports it   (certainty)
 *
 * A CRITICAL/POSSIBLE finding is a serious thing we are unsure of. A
 * LOW/CONFIRMED finding is a trivial thing we are certain of. Rendering either
 * as a single "priority" number would erase the difference, which is why there
 * is no such number anywhere in this file.
 */

/* ------------------------------------------------------------------ *
 * Status — how good is the evidence? (§1)
 * ------------------------------------------------------------------ */

/**
 * CONFIRMED  the instance proves it. A dictionary read said the field is not
 *            there; nothing about that is a judgement call.
 * LIKELY     strong evidence, one step short of proof — usually because the
 *            authority is a semantic fact rather than a direct lookup.
 * POSSIBLE   a real pattern worth a person's attention, not established.
 * UNKNOWN    the check could not be performed. A first-class result, and §39's
 *            whole point: a check that could not run must never render as a
 *            check that passed.
 */
export const STATUS = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  LIKELY: 'LIKELY',
  POSSIBLE: 'POSSIBLE',
  UNKNOWN: 'UNKNOWN',
});
export const STATUS_LIST = Object.freeze(Object.values(STATUS));

/* ------------------------------------------------------------------ *
 * Severity — how much would it hurt? (§24)
 * ------------------------------------------------------------------ */

export const SEVERITY = Object.freeze({
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  INFO: 'INFO',
});
export const SEVERITY_LIST = Object.freeze(Object.values(SEVERITY));

/** Ordering, for ranking only. Never mixed with status. */
export const SEVERITY_RANK = Object.freeze({
  CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0,
});
export const STATUS_RANK = Object.freeze({
  CONFIRMED: 3, LIKELY: 2, POSSIBLE: 1, UNKNOWN: 0,
});

/** Evidence strength, three words. Never a number (§23). */
export const CONFIDENCE = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' });
export const CONFIDENCE_LIST = Object.freeze(Object.values(CONFIDENCE));

/**
 * §18/§19 — what KIND of thing a finding is.
 *
 * A destructive action is not a bug and a missing error branch is not
 * necessarily one either. Saying so in the finding's own type stops a linter
 * presenting an opinion as a defect, which is the fastest way for people to
 * stop reading it.
 */
export const KIND = Object.freeze({
  DEFECT: 'DEFECT',
  RISK: 'RISK',
  BEST_PRACTICE: 'BEST_PRACTICE',
  PLATFORM_LIMITATION: 'PLATFORM_LIMITATION',
});
export const KIND_LIST = Object.freeze(Object.values(KIND));

/**
 * Where a piece of evidence came from (§25, §47).
 *
 * The order is the project's truth hierarchy: a live read outranks a semantic
 * fact, which outranks execution history. §26 makes that explicit — execution
 * evidence may STRENGTHEN a finding but must never overrule the artifact or the
 * schema.
 */
export const EVIDENCE_SOURCE = Object.freeze({
  LIVE_SCHEMA: 'live_schema',
  LIVE_FLOW: 'live_flow',
  LIVE_CHOICES: 'live_choices',
  LIVE_RECORD: 'live_record',
  SEMANTIC: 'semantic_fact',
  CAPABILITY: 'capability_discovery',
  EXECUTION: 'execution',
});
export const EVIDENCE_SOURCE_LIST = Object.freeze(Object.values(EVIDENCE_SOURCE));

/** Sources that may, on their own, establish CONFIRMED. */
export const AUTHORITATIVE = Object.freeze([
  EVIDENCE_SOURCE.LIVE_SCHEMA,
  EVIDENCE_SOURCE.LIVE_FLOW,
  EVIDENCE_SOURCE.LIVE_CHOICES,
  EVIDENCE_SOURCE.LIVE_RECORD,
  EVIDENCE_SOURCE.CAPABILITY,
]);

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

/** Is this a usable piece of evidence? It must say where it came from. */
export function isEvidence(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  if (!EVIDENCE_SOURCE_LIST.includes(e.source)) return false;
  return isText(e.detail) || isText(e.field) || isText(e.table) || isText(e.step);
}

/**
 * Is this a well-formed finding?
 *
 * `evidence` must be a non-empty array. §25 says no evidence, no finding, and
 * the shape enforces it: a finding without evidence is not a weak finding, it
 * is not a finding.
 */
export function isFinding(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
  if (!isText(f.rule_id) || !isText(f.title) || !isText(f.description)) return false;
  if (!SEVERITY_LIST.includes(f.severity)) return false;
  if (!STATUS_LIST.includes(f.status)) return false;
  if (!KIND_LIST.includes(f.kind)) return false;
  if (!CONFIDENCE_LIST.includes(f.confidence)) return false;
  if (typeof f.autofixable !== 'boolean') return false;
  if (!Array.isArray(f.evidence) || f.evidence.length === 0) return false;
  return f.evidence.every(isEvidence);
}

/**
 * An UNKNOWN check — a rule that could not run (§39).
 *
 * It must say WHY, because "I could not check this" is only useful with the
 * reason attached: a missing capability is a different problem from an
 * undecodable artifact, and they lead a reader to different next steps.
 */
export function isUnknownCheck(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return false;
  return isText(u.rule_id) && isText(u.reason);
}

/** The empty lint result. Same shape whatever happened. */
export function emptyResult({ flow = null, request = null } = {}) {
  return {
    flow,
    request,
    findings: [],
    unknown_checks: [],
    rules_run: [],
    summary: {
      confirmed: 0, likely: 0, possible: 0, unknown: 0, total: 0, clean: false,
    },
    gaps: [],
    stopped: null,
  };
}
