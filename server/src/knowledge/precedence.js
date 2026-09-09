/**
 * K4 — what wins when the sources disagree.
 *
 * Four things can tell SNADA how ServiceNow behaves, and they routinely
 * disagree. The ordering is not a preference, it is a statement about which of
 * them can be WRONG without anything noticing:
 *
 *   1. LIVE PDI STATE          the instance's own answer, read back just now.
 *                              Cannot be stale about itself.
 *   2. TOOL / SDK CAPABILITY   what this build of SNADA and the installed SDK
 *                              can actually do. A feature that exists in the
 *                              platform but not in the installed tool is, from
 *                              here, a feature that does not exist.
 *   3. OFFICIAL DOCUMENTATION  correct about the release it describes, on an
 *                              instance configured the way it assumes. Both of
 *                              those are frequently untrue of a given PDI.
 *   4. LLM KNOWLEDGE           a prior. Unattributable, undated, and the only
 *                              one of the four with no artifact behind it.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. Retrieval was added so the agent could
 * reason better, and the failure mode of adding retrieval is that a confident
 * paragraph of documentation starts functioning as permission. It must not.
 * Documentation and model knowledge INFORM; only the live instance and the
 * tools' real capability can ESTABLISH. `canAuthorize` is that line, and
 * `assertNotAuthorizedByKnowledge` is the throwing form for a call site that
 * must not be able to skip it.
 *
 * And when the ladder cannot decide — no evidenced claim at all, or two
 * equally-authoritative claims that contradict each other — the answer is not
 * a best guess. It is a question for a human.
 */

/** Highest authority first. The index IS the rank. */
export const AUTHORITY_ORDER = Object.freeze([
  'live_pdi',
  'tool_capability',
  'documentation',
  'model_knowledge',
]);

export const SOURCE_LABEL = Object.freeze({
  live_pdi: 'live PDI state',
  tool_capability: 'actual SNADA tool / SDK capability',
  documentation: 'current official documentation',
  model_knowledge: 'LLM knowledge',
});

/**
 * The two rungs that can establish a fact firmly enough to act on it.
 *
 * Both are ARTIFACTS: a record read back off the instance, or a capability
 * probe against the installed SDK. The two below them are TEXT, and text about
 * a system is not the system.
 */
export const AUTHORITATIVE_SOURCES = Object.freeze(['live_pdi', 'tool_capability']);

export function authorityRank(source) {
  const i = AUTHORITY_ORDER.indexOf(source);
  // Unknown sources sort below everything known rather than throwing: a claim
  // from somewhere unrecognised is the LEAST trustworthy thing in the room, not
  // an error condition.
  return i === -1 ? AUTHORITY_ORDER.length : i;
}

/**
 * May an action be authorised on the strength of these sources alone?
 *
 * FALSE for any set that does not contain a live instance read or a real
 * capability answer — which includes every set made only of retrieved
 * documentation. This is the RAG-never-authorises rule as a function.
 */
export function canAuthorize(sources) {
  const list = Array.isArray(sources) ? sources : [sources];
  return list.some((s) => AUTHORITATIVE_SOURCES.includes(s));
}

/**
 * Throwing form, for a call site where "the caller should have checked" is not
 * good enough. The message names what is missing rather than just refusing,
 * because the fix is always the same shape: go and read the instance.
 */
export function assertNotAuthorizedByKnowledge(action, sources) {
  if (canAuthorize(sources)) return true;
  const named = (Array.isArray(sources) ? sources : [sources])
    .map((s) => SOURCE_LABEL[s] || s).join(', ') || 'nothing';
  throw new Error(
    `Refusing to authorise "${action}" on ${named} alone. Retrieved documentation and model knowledge `
    + 'INFORM a plan; they never authorise an action. Establish the state from the instance '
    + '(a read-back) or from a capability check before proceeding.'
  );
}

/**
 * A claim, normalised.
 *
 * `evidence` is what separates a real reading from an assertion that sounds
 * like one. A claim that says "the live instance has this field" with nothing
 * attached is not live state — it is the model's belief about live state
 * wearing live state's authority, and that is the single most dangerous shape
 * in this whole design. It is DEMOTED to model_knowledge and the demotion is
 * reported, rather than being dropped or being taken at face value.
 */
function normalise(claim) {
  const source = claim?.source;
  const needsEvidence = AUTHORITATIVE_SOURCES.includes(source);
  const hasEvidence = typeof claim?.evidence === 'string' && claim.evidence.trim().length > 0;
  if (needsEvidence && !hasEvidence) {
    return {
      ...claim,
      source: 'model_knowledge',
      demotedFrom: source,
      demotionReason:
        `A "${source}" claim arrived with no evidence attached. Without a read-back or a capability `
        + 'result it is an assertion, not a reading, so it is ranked as model knowledge.',
    };
  }
  return { ...claim, demotedFrom: null };
}

const sameAnswer = (a, b) => String(a?.says ?? '').trim().toLowerCase() === String(b?.says ?? '').trim().toLowerCase();

/**
 * Resolve a disagreement between sources.
 *
 * @param {{ question: string, claims: Array<{source, says, evidence?, ref?}> }} input
 * @returns {{
 *   verdict: 'resolved' | 'stop_and_ask',
 *   answer: string|null,
 *   winner: object|null,
 *   overruled: object[],
 *   demoted: object[],
 *   ladder: string[],
 *   reason: string,
 *   ask: string|null,
 *   canAuthorize: boolean
 * }}
 */
export function resolveConflict({ question, claims } = {}) {
  const ladder = AUTHORITY_ORDER.map((s, i) => `${i + 1}. ${SOURCE_LABEL[s]}`);
  const list = (Array.isArray(claims) ? claims : []).filter((c) => c && c.source && c.says !== undefined);

  const base = {
    question: question || null,
    ladder,
    demoted: [],
    overruled: [],
    winner: null,
    answer: null,
    canAuthorize: false,
  };

  if (!list.length) {
    return {
      ...base,
      verdict: 'stop_and_ask',
      reason: 'No claims were supplied, so there is nothing to rank.',
      ask: `Nothing is known about: ${question || '(unstated question)'}. `
        + 'Read the instance, check the tool capability, or tell me which behaviour to assume.',
    };
  }

  const normalised = list.map(normalise);
  const demoted = normalised.filter((c) => c.demotedFrom);

  const ranked = normalised
    .map((c) => ({ ...c, rank: authorityRank(c.source) }))
    .sort((a, b) => a.rank - b.rank);

  const top = ranked[0].rank;
  const contenders = ranked.filter((c) => c.rank === top);
  const rest = ranked.filter((c) => c.rank !== top);

  // Two claims of EQUAL authority that disagree. The ladder has nothing left to
  // break the tie with, and inventing one (recency, verbosity, whichever was
  // listed first) would be exactly the guess this module exists to refuse.
  const disagreeing = contenders.filter((c) => !sameAnswer(c, contenders[0]));
  if (disagreeing.length) {
    return {
      ...base,
      demoted,
      verdict: 'stop_and_ask',
      reason:
        `${contenders.length} claims share the highest authority present (${SOURCE_LABEL[contenders[0].source]}) `
        + 'and they contradict each other. The precedence ladder cannot break a tie within one rung.',
      ask:
        `${question || 'This'} has two conflicting answers at the same level of authority:\n`
        + contenders.map((c) => `  - ${c.says}${c.ref ? ` (${c.ref})` : ''}`).join('\n')
        + '\nI will not pick one. Which is correct?',
      contenders: contenders.map((c) => ({ source: c.source, says: c.says, ref: c.ref ?? null })),
    };
  }

  const winner = contenders[0];
  const overruled = rest
    .filter((c) => !sameAnswer(c, winner))
    .map((c) => ({
      source: c.source,
      says: c.says,
      ref: c.ref ?? null,
      why: `Overruled by ${SOURCE_LABEL[winner.source]}, which outranks ${SOURCE_LABEL[c.source]}.`,
    }));

  /*
   * The spec's own example, and the reason `canAuthorize` is reported here
   * rather than left to the caller.
   *
   * "Documentation says the feature exists, the installed SDK does not support
   *  it" resolves cleanly — tool capability outranks documentation, so the
   * answer is that the feature is unavailable HERE. What must not follow is a
   * generated implementation of the documented feature. So a verdict whose
   * winner is documentation or model knowledge carries canAuthorize:false, and
   * the caller cannot act on it without either failing `canAuthorize` or
   * ignoring a field it was handed.
   */
  const authorised = canAuthorize([winner.source]);

  return {
    ...base,
    demoted,
    verdict: 'resolved',
    answer: winner.says,
    winner: { source: winner.source, says: winner.says, ref: winner.ref ?? null, evidence: winner.evidence ?? null },
    overruled,
    canAuthorize: authorised,
    reason: authorised
      ? `${SOURCE_LABEL[winner.source]} is the highest-authority evidenced claim available, so it decides.`
      : `${SOURCE_LABEL[winner.source]} is the highest-authority claim available, but it is not an `
        + 'artifact from the instance or the tools. It may inform the plan; it may not authorise an action. '
        + 'Establish the state with a read-back or a capability check before acting on it.',
  };
}

/**
 * The ladder as prose, for the system prompt.
 *
 * Kept next to the implementation so the sentence the model is given and the
 * rule the code enforces cannot drift apart — a prompt that promises an
 * ordering the code does not apply is worse than no prompt at all.
 */
export function precedenceBlock() {
  return [
    'SOURCE PRECEDENCE — when the sources disagree, NEVER guess. This order is enforced in code:',
    ...AUTHORITY_ORDER.map((s, i) => `  ${i + 1}. ${SOURCE_LABEL[s]}`),
    '',
    'A lower source never overrides a higher one. Two things follow, and both are absolute:',
    '  - Retrieved documentation and your own prior knowledge INFORM your reasoning. They NEVER authorise',
    '    an action. Before you act, establish the state from the instance (a read-back) or from a real',
    '    capability check. "The documentation says so" is not a basis for a mutation.',
    '  - If the documentation describes something the installed SDK or the available tools cannot do, then',
    '    here it cannot be done. Say so, name the gap, and STOP. Do not generate or execute an',
    '    implementation of a capability you have not verified exists.',
    '',
    'If you cannot establish the correct behaviour — nothing evidenced, or two equally authoritative',
    'answers that contradict — stop and ask the human. An unanswered question is a better outcome than',
    'a confident wrong one.',
  ].join('\n');
}
