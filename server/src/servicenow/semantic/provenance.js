import { AUTHORITY_ORDER, canAuthorize as ladderCanAuthorize } from '../../knowledge/precedence.js';

/**
 * PHASE 3 — WHERE A SEMANTIC FACT CAME FROM, AND WHAT THAT ENTITLES IT TO.
 *
 * THE ONE RULE THIS FILE EXISTS FOR. SNADA must never turn uncertainty into a
 * fabricated ServiceNow fact. Every value the semantic layer produces is
 * wrapped with the source that produced it and a status that says how much is
 * actually known — so "we could not find out" and "we found out it is X" can
 * never render the same way, and an inference can never be mistaken for a read.
 *
 * THIS REFINES THE EXISTING LADDER; IT DOES NOT REPLACE IT.
 *
 * knowledge/precedence.js already owns the authorisation question with four
 * rungs — live_pdi > tool_capability > documentation > model_knowledge — and
 * `canAuthorize()` is the single function that answers "may an action be taken
 * on the strength of these sources". That contract is asserted by
 * test/knowledge-precedence.test.js and is NOT changed here.
 *
 * What Phase 3 needs is finer grain WITHIN those rungs: "the dictionary says
 * so" and "I read the record back just now" are both live_pdi, but they are not
 * the same evidence, and a semantic layer that cannot tell them apart cannot
 * explain itself. So the seven sources below are a refinement, and each one
 * MAPS onto a ladder rung. The mapping is the load-bearing part: authorisation
 * is still decided by the four-rung ladder, through the same function, so this
 * file can add vocabulary without adding authority.
 */

/**
 * The seven sources, strongest first. The index IS the rank.
 *
 *  1 live_state      a record read back off the instance just now. Cannot be
 *                    stale about itself.
 *  2 live_schema     the dictionary, read through servicenow/schema.js. True of
 *                    the instance's SHAPE rather than of any one record.
 *  3 managed_source  the Fluent source this project owns and has build-verified.
 *                    Authoritative about what WE deploy, not about the instance.
 *  4 ledger          memory/facts.js — measured, dated, and carrying its
 *                    provenance, but a measurement from THEN rather than a read
 *                    from now.
 *  5 documentation   the indexed vendor corpus. Correct about the release it
 *                    describes, on an instance configured the way it assumes.
 *  6 model_knowledge a prior. Undated and unattributable.
 *  7 llm_inference   a conclusion drawn during this turn. The weakest thing
 *                    there is, and the only one with no artifact at all.
 */
export const SOURCES = Object.freeze([
  'live_state',
  'live_schema',
  'managed_source',
  'ledger',
  'documentation',
  'model_knowledge',
  'llm_inference',
]);

const SOURCE_SET = new Set(SOURCES);

/**
 * Each source's rung on the EXISTING four-rung ladder.
 *
 * Two mappings deserve their reasons written down, because both are places
 * where a more flattering choice would have quietly widened what may authorise
 * a mutation:
 *
 *   `ledger` -> documentation. A ledger fact is MEASURED, which makes it much
 *   better evidence than a documentation page — and it is still not a live
 *   read. The instance can have changed since; the fact carries a date for
 *   exactly that reason. Mapping it to live_pdi would let a stored measurement
 *   authorise a mutation, which is the failure the whole read-back discipline
 *   exists to prevent. It informs. It does not authorise.
 *
 *   `llm_inference` -> model_knowledge. The ladder has no rung below its last
 *   one, and inference belongs no higher than the priors it was drawn from.
 */
export const LADDER_RUNG = Object.freeze({
  live_state: 'live_pdi',
  live_schema: 'live_pdi',
  managed_source: 'tool_capability',
  ledger: 'documentation',
  documentation: 'documentation',
  model_knowledge: 'model_knowledge',
  llm_inference: 'model_knowledge',
});

/** Strongest first: a lower number wins. Unknown sources sort below everything. */
export function sourceRank(source) {
  const i = SOURCES.indexOf(source);
  return i === -1 ? SOURCES.length : i;
}

/**
 * The explicit result states. Part 7's vocabulary, and the whole point of it is
 * that a caller can tell these apart without reading prose.
 *
 *  known        the answer is established by an evidenced source
 *  unknown      nobody could establish it — NOT a licence to guess
 *  unsupported  the platform or this build genuinely cannot do it
 *  unavailable  it could be done, but not on this instance / in this state
 *  ambiguous    several answers matched and none is preferable
 */
export const STATUS = Object.freeze({
  KNOWN: 'known',
  UNKNOWN: 'unknown',
  UNSUPPORTED: 'unsupported',
  UNAVAILABLE: 'unavailable',
  AMBIGUOUS: 'ambiguous',
});

const STATUS_SET = new Set(Object.values(STATUS));

/**
 * `verified` means: an ARTIFACT backs this — a read-back, a dictionary row, a
 * build output, a recorded measurement. It is a property of the SOURCE, never
 * of how confident anything felt, so it is derived rather than passed in.
 *
 * Documentation is deliberately NOT verified. It is a true statement about a
 * release, which is a different claim from a true statement about this
 * instance, and conflating the two is how a docs page starts reading as proof.
 */
const VERIFIED_SOURCES = new Set(['live_state', 'live_schema', 'managed_source', 'ledger']);

/**
 * Wrap a value with where it came from.
 *
 * Refuses an unknown source or status rather than storing one: a provenance
 * vocabulary that accepts anything is a provenance vocabulary that means
 * nothing, and this is the one place that could let an unlabelled value
 * through.
 */
export function fact(value, source, { status = STATUS.KNOWN, note = null, evidence = null } = {}) {
  if (!SOURCE_SET.has(source)) {
    throw new Error(`unknown semantic source "${source}" — it must be one of ${SOURCES.join(', ')}`);
  }
  if (!STATUS_SET.has(status)) {
    throw new Error(`unknown semantic status "${status}"`);
  }
  return Object.freeze({
    value,
    status,
    source,
    rung: LADDER_RUNG[source],
    verified: status === STATUS.KNOWN && VERIFIED_SOURCES.has(source),
    canAuthorize: status === STATUS.KNOWN && ladderCanAuthorize([LADDER_RUNG[source]]),
    note,
    evidence,
  });
}

/** Nothing is known. The honest empty answer, and never a default value. */
export function unknown(note, { source = 'live_schema', evidence = null } = {}) {
  return fact(null, source, { status: STATUS.UNKNOWN, note, evidence });
}

/** Several answers matched. Carries the candidates so a caller can ask. */
export function ambiguous(candidates, note, { source = 'live_state' } = {}) {
  return fact(null, source, { status: STATUS.AMBIGUOUS, note, evidence: { candidates } });
}

export function unsupported(note, { source = 'managed_source', evidence = null } = {}) {
  return fact(null, source, { status: STATUS.UNSUPPORTED, note, evidence });
}

export function unavailable(note, { source = 'live_state', evidence = null } = {}) {
  return fact(null, source, { status: STATUS.UNAVAILABLE, note, evidence });
}

/**
 * Pick the winner among claims about THE SAME QUESTION, and say when they
 * disagreed.
 *
 * THE DISTINCTION THAT MAKES THIS SAFE. Two claims conflict only when they
 * answer the same question differently. "The dictionary marks priority
 * writable" and "a REST write to priority is silently overwritten" are NOT in
 * conflict — they are answers to two different questions, and the ledger fact
 * exists precisely because the dictionary flag does not predict REST behaviour
 * (trap `dictionary-readonly-does-not-predict-rest-writes`). Merging them would
 * lose the more important half.
 *
 * So callers must only pass claims about one question. Where they do, the
 * stronger source wins, and a disagreement is REPORTED rather than smoothed:
 * live schema beating a stale ledger fact is a thing a human should know about,
 * because it usually means the ledger needs updating.
 */
export function reconcile(claims, { question = null } = {}) {
  const usable = (claims || []).filter((c) => c && c.status === STATUS.KNOWN);
  if (!usable.length) {
    const first = (claims || [])[0];
    return {
      winner: first || unknown(question ? `nothing established ${question}` : 'nothing established'),
      conflicts: [],
      considered: (claims || []).length,
    };
  }
  const sorted = [...usable].sort((a, b) => sourceRank(a.source) - sourceRank(b.source));
  const winner = sorted[0];
  const conflicts = sorted.slice(1)
    .filter((c) => JSON.stringify(c.value) !== JSON.stringify(winner.value))
    .map((c) => ({
      source: c.source,
      value: c.value,
      note: `${c.source} says ${JSON.stringify(c.value)}; ${winner.source} is stronger and says `
        + `${JSON.stringify(winner.value)}`,
    }));
  return { winner, conflicts, considered: (claims || []).length };
}

/**
 * The ladder, for a caller that wants to check authority without importing two
 * modules. Delegates: there is one implementation of this question and it lives
 * in knowledge/precedence.js.
 */
export function factCanAuthorize(f) {
  return Boolean(f && f.status === STATUS.KNOWN && ladderCanAuthorize([LADDER_RUNG[f.source]]));
}

/** Exposed so a test can assert the refinement really does map onto the ladder. */
export const LADDER = AUTHORITY_ORDER;
