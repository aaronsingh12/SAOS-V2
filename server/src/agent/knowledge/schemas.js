/**
 * PHASE 19 — THE VOCABULARY OF INSTANCE KNOWLEDGE.
 *
 * Pure data and predicates. No I/O, no model, no ServiceNow, no database.
 *
 * ═══ WHY THIS PHASE ADDS A DOMAIN AND NOT A STORE ═══
 *
 * §6, §7 and §44 all say the same thing: inspect what exists first, reuse it,
 * do not build a second vector store. The inspection found three stores that
 * between them already hold everything §3 asks for, and none of them knows
 * about the others:
 *
 *   memory/facts.js            the instance trap ledger. Scoped per instance
 *                              with `*` for universal, exactly as §9 requires.
 *   knowledge/observations.js  verified observations, each gated on a named
 *                              EVIDENCE KIND and an artifact — §13's
 *                              "only verified knowledge may receive elevated
 *                              trust", already enforced at the write.
 *   knowledge/store.js         the global documentation corpus: FTS5, optional
 *                              embeddings, release-aware version ranking.
 *
 * So the gap is not storage. It is that a question asked of the agent reaches
 * ONE of those three, ranked by its own local rules, with no common notion of
 * authority or scope — and no way to say "the live instance disagrees with this
 * page". This directory is the retrieval and adjudication layer over all three.
 * It stores nothing (§78: no migration, DB stays 23).
 *
 * ═══ TWO LADDERS, AND WHY THERE ARE TWO ═══
 *
 * `knowledge/precedence.js` already has an authority ladder with four rungs,
 * and it answers exactly one question: MAY THIS AUTHORISE AN ACTION. That
 * question has a binary answer and four rungs is the right resolution for it.
 *
 * §5 asks for six, because RANKING is a different question from AUTHORISING: a
 * runbook and a five-year-old doc page are both non-authorising and it matters
 * a great deal which one you read first. So this file defines the six-rung
 * ranking ladder AND an explicit map down to the four-rung authorising one —
 * and `canAuthorize` in precedence.js remains the only thing that decides
 * whether anything may be acted on. The map is tested, so the two cannot drift.
 */
import { AUTHORITY_ORDER as AUTHORISING_LADDER, AUTHORITATIVE_SOURCES } from '../../knowledge/precedence.js';

/* ------------------------------------------------------------------ *
 * §3 — the kinds of thing that can be known
 * ------------------------------------------------------------------ */

export const KINDS = Object.freeze({
  DOCUMENTATION: 'DOCUMENTATION',
  RUNBOOK: 'RUNBOOK',
  INSTANCE_FACT: 'INSTANCE_FACT',
  TRAP: 'TRAP',
  HISTORICAL_NOTE: 'HISTORICAL_NOTE',
  ARCHITECTURE_NOTE: 'ARCHITECTURE_NOTE',
  MODEL_CONTEXT: 'MODEL_CONTEXT',
});

export const KIND_LIST = Object.freeze(Object.values(KINDS));

/* ------------------------------------------------------------------ *
 * §5 — the ranking ladder, highest authority first
 * ------------------------------------------------------------------ */

export const AUTHORITY = Object.freeze({
  LIVE: 'live',
  MANAGED_SOURCE: 'managed_source',
  LEDGER: 'ledger',
  DOCUMENTATION: 'documentation',
  HISTORICAL: 'historical',
  MODEL: 'model',
});

/** The index IS the rank. Lower is stronger. */
export const AUTHORITY_ORDER = Object.freeze([
  AUTHORITY.LIVE,
  AUTHORITY.MANAGED_SOURCE,
  AUTHORITY.LEDGER,
  AUTHORITY.DOCUMENTATION,
  AUTHORITY.HISTORICAL,
  AUTHORITY.MODEL,
]);

export const AUTHORITY_LABEL = Object.freeze({
  [AUTHORITY.LIVE]: 'live instance state',
  [AUTHORITY.MANAGED_SOURCE]: 'the managed source this project builds from',
  [AUTHORITY.LEDGER]: 'a verified instance fact',
  [AUTHORITY.DOCUMENTATION]: 'documentation',
  [AUTHORITY.HISTORICAL]: 'a historical note',
  [AUTHORITY.MODEL]: 'model knowledge',
});

export function authorityRank(authority) {
  const i = AUTHORITY_ORDER.indexOf(authority);
  /* An authority nothing recognises sorts BELOW everything known rather than
   * throwing. A claim from somewhere unrecognised is the least trustworthy
   * thing in the room, not an error condition. */
  return i === -1 ? AUTHORITY_ORDER.length : i;
}

/**
 * The map down to the four-rung AUTHORISING ladder.
 *
 * §13 is what makes this interesting: "only verified knowledge may receive
 * elevated trust". A ledger entry is not automatically authoritative — it is
 * authoritative when it carries a verification, which is precisely what
 * `observations.js` already refuses to store an entry without. So the mapping
 * for LEDGER depends on the ITEM, not only on its rung, and that is why this is
 * a function rather than a table.
 *
 * Everything below LEDGER maps to a non-authorising rung, without exception and
 * without a flag that could change it. §2 and §80.2 are the same rule stated
 * twice, and this is where it is true.
 */
export function authorisingSourceOf(item) {
  switch (item?.provenance?.authority) {
    case AUTHORITY.LIVE:
      return 'live_pdi';
    case AUTHORITY.LEDGER:
      /* Verified → rung 2, the rung `capabilityClaimsFor` already uses for a
       * measured SDK limitation. Unverified → it is a note, and notes inform. */
      return isVerified(item) ? 'tool_capability' : 'documentation';
    case AUTHORITY.MANAGED_SOURCE:
    case AUTHORITY.DOCUMENTATION:
    case AUTHORITY.HISTORICAL:
      return 'documentation';
    default:
      return 'model_knowledge';
  }
}

/** §13 — a verification is a timestamp AND a named source. Neither alone. */
export function isVerified(item) {
  const f = item?.freshness;
  return Boolean(f?.verified_at) && Boolean(f?.verification_source);
}

/** Could this item, on its own, authorise an action? Delegates the decision. */
export function itemCanAuthorize(item) {
  return AUTHORITATIVE_SOURCES.includes(authorisingSourceOf(item));
}

/* ------------------------------------------------------------------ *
 * §10 — scope
 * ------------------------------------------------------------------ */

export const SCOPES = Object.freeze({
  GLOBAL: 'GLOBAL',
  INSTANCE: 'INSTANCE',
  APPLICATION: 'APPLICATION',
  TABLE: 'TABLE',
  ARTIFACT: 'ARTIFACT',
});

/** Narrower is more specific, and more specific outranks broader (§11). */
export const SCOPE_ORDER = Object.freeze([
  SCOPES.ARTIFACT, SCOPES.TABLE, SCOPES.APPLICATION, SCOPES.INSTANCE, SCOPES.GLOBAL,
]);

/** The universal marker both existing stores already use. */
export const UNIVERSAL = '*';

/* ------------------------------------------------------------------ *
 * §12 — freshness
 * ------------------------------------------------------------------ */

/**
 * FRESH, STALE and UNKNOWN — and UNKNOWN is the default, not FRESH.
 *
 * §12 is careful about this and it is worth restating: a document from five
 * years ago is not automatically useless, and one from yesterday is not
 * automatically right. So freshness here is EVIDENCE-BASED — it is a statement
 * about whether anything has re-checked the claim, never about the calendar
 * alone. An item nobody has verified is UNKNOWN, which is honest, and it is
 * what most of a documentation corpus will always be.
 */
export const FRESHNESS = Object.freeze({
  FRESH: 'fresh',
  STALE: 'stale',
  UNKNOWN: 'unknown',
});

/* ------------------------------------------------------------------ *
 * §18 / §19 — what kind of question this is
 * ------------------------------------------------------------------ */

export const QUESTION = Object.freeze({
  /* §18 — retrieval cannot answer it. The instance must be read. */
  LIVE_TRUTH_REQUIRED: 'LIVE_TRUTH_REQUIRED',
  /* §19 — knowledge may answer it, with its sources visible. */
  CONTEXT_OK: 'CONTEXT_OK',
});

/* ------------------------------------------------------------------ *
 * §31 — limits
 * ------------------------------------------------------------------ */

export const LIMITS = Object.freeze({
  MAX_RESULTS: 8,
  MAX_CHUNKS: 12,
  MAX_CHARS_PER_ITEM: 700,
  /* What a caller gets per store before ranking. Deliberately larger than
   * MAX_RESULTS: ranking across stores can only choose from what it was given,
   * and a store starved at the fetch cannot be rescued by the ranker. */
  PER_STORE_FETCH: 20,
});

/* ------------------------------------------------------------------ *
 * §4 — the item, and §21 — the answer
 * ------------------------------------------------------------------ */

/**
 * Is this a well-formed knowledge item?
 *
 * §4 says not every kind carries every scope field, so scope members are
 * optional — but `scope` itself is not, and neither is provenance's authority.
 * An item that cannot say where it came from cannot be ranked, cited or
 * isolated, which is three of this phase's four release blockers at once.
 */
export function isKnowledgeItem(x) {
  return Boolean(
    x && typeof x === 'object'
    && typeof x.id === 'string' && x.id.length
    && KIND_LIST.includes(x.kind)
    && typeof x.content === 'string' && x.content.length
    && x.scope && typeof x.scope === 'object'
    && x.provenance && AUTHORITY_ORDER.includes(x.provenance.authority)
    && typeof x.provenance.source === 'string' && x.provenance.source.length,
  );
}

/**
 * The shape every answer returns, including the ones that could not answer.
 *
 * §21 keeps the classes apart deliberately: `live_facts` and `knowledge` are
 * not merged into `sources`, because §80.4 makes presenting retrieved text as
 * live fact a release blocker and the cheapest way to cause that is to put both
 * in one list and hope the renderer remembers which was which.
 */
export function emptyAnswer() {
  return {
    question: null,
    classification: null,
    answer: null,
    verdict: null,
    live_facts: [],
    knowledge: [],
    sources: [],
    inferences: [],
    unknowns: [],
    conflicts: [],
    scope: null,
    retrieval: null,
    stopped: null,
    timings: {},
  };
}

export const VERDICTS = Object.freeze({
  ANSWERED: 'ANSWERED',
  ANSWERED_WITH_CONFLICT: 'ANSWERED_WITH_CONFLICT',
  INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
  NO_KNOWLEDGE: 'NO_KNOWLEDGE',
  RETRIEVAL_UNAVAILABLE: 'RETRIEVAL_UNAVAILABLE',
  CANCELLED: 'CANCELLED',
});

export { AUTHORISING_LADDER, AUTHORITATIVE_SOURCES };
