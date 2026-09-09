/**
 * PHASE 18 — THE VOCABULARY CHANGE INTELLIGENCE IS ALLOWED TO SPEAK.
 *
 * Pure data and predicates. No I/O, no model, no ServiceNow.
 *
 * THREE AXES, KEPT APART, and collapsing any two of them is how a diff becomes
 * an opinion:
 *
 *   KIND        what happened to this element   ADDED / REMOVED / CHANGED / MOVED
 *   CATEGORY    what KIND of thing it is        TRIGGER / BEHAVIORAL / COSMETIC …
 *   RISK        how much it could cost          LOW … CRITICAL
 *
 * A `kind` is arithmetic: two values are equal or they are not. A `category` is
 * a property of the PATH the change sits on, read from the normalised shape. A
 * `risk` is a table lookup from the categories. None of the three is a
 * judgement, and §63.6 makes "risk based only on model opinion" a blocker —
 * which is why the risk table below is a frozen literal rather than a prompt.
 *
 * CERTAINTY IS A FOURTH AXIS AND IT OUTRANKS RISK (§25). Phase 16 learned this
 * the expensive way: a POSSIBLE CRITICAL sorting above a CONFIRMED HIGH puts
 * speculation at the top of every report. The same STATUS vocabulary is reused
 * here rather than redefined, so a change finding and a lint finding sort by
 * the same rule.
 */
import { STATUS, STATUS_RANK, SEVERITY, SEVERITY_RANK } from '../lint/schemas.js';

/* ------------------------------------------------------------------ *
 * §4 — where a state may come from
 * ------------------------------------------------------------------ */

/**
 * The only sources that exist. §4 is explicit: do not invent one.
 *
 * Each is a place this build can READ an artifact from and say where it came
 * from afterwards. A chat description is not here, and neither is anything a
 * model produced, because neither can be read back a second time and shown to
 * be the same.
 */
export const SOURCES = Object.freeze({
  /** The flow as it is on the instance right now. */
  LIVE: 'LIVE',
  /**
   * The copy Flow Designer wrote when the flow was last PUBLISHED.
   *
   * MEASURED on dev424910, and it is the reason this phase has a real baseline
   * at all: `sys_hub_flow_snapshot` holds a full second state — its own action
   * and trigger instances, carrying the snapshot's sys_id — and the `ui_id` of
   * every step survives the copy while the row sys_ids do not. It is
   * ServiceNow's own answer to "the previous version".
   */
  PUBLISHED_SNAPSHOT: 'PUBLISHED_SNAPSHOT',
  /** A normalised artifact this build captured earlier and stored on a task. */
  CAPTURED_ARTIFACT: 'CAPTURED_ARTIFACT',
  /** An update-set payload — the transport representation. */
  TRANSPORT_REPRESENTATION: 'TRANSPORT_REPRESENTATION',
  /** The managed source this project builds from. */
  MANAGED_SOURCE: 'MANAGED_SOURCE',
});

export const SOURCE_LIST = Object.freeze(Object.values(SOURCES));

/** Why there is no comparison. Each is an answer, not an error. */
export const STOPS = Object.freeze({
  ARTIFACT_NOT_IDENTIFIED: 'ARTIFACT_NOT_IDENTIFIED',
  ARTIFACT_AMBIGUOUS: 'ARTIFACT_AMBIGUOUS',
  NO_BASELINE: 'NO_BASELINE',
  BASELINE_UNREADABLE: 'BASELINE_UNREADABLE',
  CURRENT_UNREADABLE: 'CURRENT_UNREADABLE',
  UNSUPPORTED_ARTIFACT: 'UNSUPPORTED_ARTIFACT',
  DEPLOYMENT_NOT_HERE: 'DEPLOYMENT_NOT_HERE',
});

/* ------------------------------------------------------------------ *
 * §9 — what happened
 * ------------------------------------------------------------------ */

export const KINDS = Object.freeze({
  ADDED: 'ADDED',
  REMOVED: 'REMOVED',
  CHANGED: 'CHANGED',
  MOVED: 'MOVED',
  UNCHANGED: 'UNCHANGED',
});

export const KIND_LIST = Object.freeze(Object.values(KINDS));

/** The element a change sits on, for grouping and for §22's rule selection. */
export const ELEMENTS = Object.freeze({
  HEADER: 'header',
  TRIGGER: 'trigger',
  CONDITION: 'condition',
  ACTION: 'action',
  BRANCH: 'branch',
  INPUT: 'input',
  OUTPUT: 'output',
  REFERENCE: 'reference',
  DEPENDENCY: 'dependency',
});

/* ------------------------------------------------------------------ *
 * §12 — what kind of thing changed
 * ------------------------------------------------------------------ */

/**
 * A change carries every category that applies, not one.
 *
 * "The assignment target changed" is BEHAVIORAL and DATA at once, and §12 says
 * so explicitly. Forcing a single label would mean choosing which half of that
 * to hide.
 */
export const CATEGORIES = Object.freeze({
  COSMETIC: 'COSMETIC',
  STRUCTURAL: 'STRUCTURAL',
  BEHAVIORAL: 'BEHAVIORAL',
  SECURITY: 'SECURITY',
  DATA: 'DATA',
  DEPENDENCY: 'DEPENDENCY',
  TRIGGER: 'TRIGGER',
});

export const CATEGORY_LIST = Object.freeze(Object.values(CATEGORIES));

/* ------------------------------------------------------------------ *
 * §24 — how much it could cost
 * ------------------------------------------------------------------ */

export const RISK = Object.freeze({
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  UNKNOWN: 'UNKNOWN',
});

export const RISK_RANK = Object.freeze({
  [RISK.CRITICAL]: 5, [RISK.HIGH]: 4, [RISK.MEDIUM]: 3, [RISK.LOW]: 2, [RISK.UNKNOWN]: 1,
});

/**
 * Category → risk. A frozen table, so a risk is a lookup rather than a view.
 *
 * §24 warns against inventing universal ServiceNow risk values, and this does
 * not claim to be one: it says how much a change of this KIND could cost, on
 * the evidence this build actually has. Each row is a sentence somebody could
 * argue with, which is the point of writing them down:
 *
 *   TRIGGER      changes WHEN the flow runs, so every downstream effect moves
 *                with it. The most consequential thing a flow edit can do.
 *   SECURITY     changes who or what the flow acts as.
 *   DEPENDENCY   makes the flow rely on something it did not rely on before,
 *                which is a new way for it to break.
 *   BEHAVIORAL   changes what it does when it runs.
 *   DATA         changes which record or field it touches.
 *   STRUCTURAL   changes the shape without, on this evidence, changing the
 *                behaviour — a reorder inside a branch, say.
 *   COSMETIC     a description. Real, and not a risk.
 *
 * A change with no category this table knows is UNKNOWN, never LOW: "nothing
 * here recognises it" and "it is harmless" are different answers.
 */
export const CATEGORY_RISK = Object.freeze({
  [CATEGORIES.TRIGGER]: RISK.HIGH,
  [CATEGORIES.SECURITY]: RISK.CRITICAL,
  [CATEGORIES.DEPENDENCY]: RISK.MEDIUM,
  [CATEGORIES.BEHAVIORAL]: RISK.MEDIUM,
  [CATEGORIES.DATA]: RISK.MEDIUM,
  [CATEGORIES.STRUCTURAL]: RISK.LOW,
  [CATEGORIES.COSMETIC]: RISK.LOW,
});

/* ------------------------------------------------------------------ *
 * The shapes
 * ------------------------------------------------------------------ */

/** §10 — one difference, as structured data. Never prose. */
export function isChange(c) {
  return Boolean(
    c && typeof c === 'object'
    && KIND_LIST.includes(c.kind)
    && typeof c.path === 'string' && c.path.length
    && typeof c.element === 'string'
    && Array.isArray(c.categories) && c.categories.length
    && c.categories.every((x) => CATEGORY_LIST.includes(x))
    && STATUS_LIST_HAS(c.status)
    && Array.isArray(c.evidence),
  );
}

const STATUS_LIST_HAS = (s) => Object.values(STATUS).includes(s);

/**
 * The shape every comparison returns, including the ones that stopped.
 *
 * `complete: false` is the §40/§41 state and it is a first-class field rather
 * than an absence, because "I could not read the action inputs" has to survive
 * all the way to the sentence a person reads.
 */
export function emptyComparison() {
  return {
    artifact: null,
    baseline: null,
    current: null,
    changes: [],
    summary: null,
    impact: [],
    dependencies: { added: [], removed: [] },
    risk: RISK.UNKNOWN,
    complete: false,
    unreadable: [],
    lint: null,
    test: null,
    deployment: null,
    fingerprint: null,
    stopped: null,
    timings: {},
  };
}

export { STATUS, STATUS_RANK, SEVERITY, SEVERITY_RANK };
