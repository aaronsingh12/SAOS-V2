/**
 * PHASE 19 — INSTANCE KNOWLEDGE, ASSEMBLED.
 *
 * The composition layer. Read down `ask` and the only new ideas are: what kind
 * of question this is, which stores to consult, and what to do when they
 * disagree. Everything else is CALLED:
 *
 *   the trap ledger        `memory/facts.js`, instance-scoped since A-3
 *   verified observations  `knowledge/observations.js`, evidence-gated at write
 *   the doc corpus         `knowledge/store.js`, FTS5 + optional embeddings
 *   the authority ladder   `knowledge/precedence.js`, unchanged
 *   redaction              `agent/evidence/redact.js`, unchanged
 *
 * §7, §44 and §78 all say the same thing in different words: no second store,
 * no second vector database, no migration. There is none — this directory
 * holds no state at all, and the database version is untouched at 23.
 *
 * ═══ WHAT THIS DOMAIN CANNOT DO (§35, §77) ═══
 *
 * It cannot write to ServiceNow, approve anything, or promote a retrieved
 * sentence into a fact. Those are not policies it follows; there is no import
 * anywhere under `agent/knowledge/` through which any of them could happen.
 * `bindStores` below is the only place the real stores are named, and every one
 * of the three is a READ.
 *
 * §72's other half — the model cannot create authoritative knowledge — is
 * enforced where it already was: `recordObservation` refuses an entry without a
 * named evidence kind AND an artifact, and `recordFact` is not reachable from
 * here at all. `proposeKnowledge` below produces a CANDIDATE that a human or an
 * evidenced tool call must act on; it writes nothing.
 */
import { listFacts, currentInstance } from '../../memory/facts.js';
import { listObservations } from '../../knowledge/observations.js';
import { searchKnowledge } from '../../knowledge/store.js';
import { LIMITS, VERDICTS, KINDS, AUTHORITY, QUESTION, FRESHNESS } from './schemas.js';
import { answerQuestion } from './answer.js';
import { renderAnswer, knowledgePanel } from './render.js';

/**
 * The three real stores, as the injectable shape `retrieve` expects.
 *
 * Each is wrapped rather than passed raw, for one reason each:
 *
 *   facts         `listFacts` already returns this instance's rows PLUS the
 *                 universal ones, which is the scoping §9 wants — so the wrap
 *                 exists only to pass the instance through explicitly rather
 *                 than letting it default silently.
 *   observations  same, and the limit is bounded here so a store that grows
 *                 does not quietly start dominating retrieval.
 *   documents     the corpus search, which does its own ranking and its own
 *                 degradation reporting. Its `mode` is carried out so a caller
 *                 can tell a keyword run from a semantic one (§28, §47).
 */
export function bindStores({ instance = null, limit = LIMITS.PER_STORE_FETCH } = {}) {
  const scope = instance || currentInstance();
  return {
    facts: async () => listFacts({ instance: scope }),
    observations: async () => listObservations({ instance: scope, limit }),
    documents: async ({ query, limit: n }) => searchKnowledge(query, { limit: n ?? limit }),
  };
}

/**
 * Ask a question of everything this build knows.
 *
 * @param liveEvidence  injected. The ONLY way live truth enters this domain.
 * @returns the §21 answer, plus the markdown a person reads.
 */
export async function ask({
  question,
  instance = null,
  table = null,
  application = null,
  artifact = null,
  stores = null,
  liveEvidence = null,
  limits = {},
  signal = null,
  record = null,
  taskId = null,
  emit = () => {},
} = {}) {
  const scope = { instance: instance || currentInstance(), table, application, artifact };
  const result = await answerQuestion({
    question,
    stores: stores ?? bindStores({ instance: scope.instance }),
    scope,
    liveEvidence,
    limits,
    signal,
    emit,
  });

  const rendered = { ...result, markdown: renderAnswer(result) };
  if (typeof record === 'function') record(taskId, rendered);
  emit({ type: 'knowledge_answered', taskId, verdict: result.verdict, sources: result.sources.length });
  return rendered;
}

/* ------------------------------------------------------------------ *
 * §23 / §72 — promotion is proposed, never performed
 * ------------------------------------------------------------------ */

/**
 * Propose that something become a verified instance fact.
 *
 * §23 permits promotion when documentation says X and live evidence verifies X.
 * §72 forbids the model creating authoritative knowledge. Both hold here
 * because this returns a CANDIDATE and writes nothing: the caller must take it
 * to `recordObservation`, which independently refuses anything without a named
 * evidence kind and an artifact.
 *
 * IT REFUSES TO PROPOSE WITHOUT THE LIVE HALF. A candidate built from
 * documentation alone is documentation with a promotion request attached, and
 * the whole point of §22 is that retrieval must not become fact.
 */
export function proposeKnowledge({ statement, live = [], knowledge = [], instance = null } = {}) {
  if (!statement) throw new Error('a knowledge candidate needs a statement');

  const corroborating = live.filter((f) => f?.provenance?.authority === AUTHORITY.LIVE
    && f?.freshness?.verification_source);
  if (!corroborating.length) {
    return {
      ok: false,
      reason: 'no_live_evidence',
      note: 'Nothing may be promoted into instance knowledge on retrieved text alone. A candidate needs a '
        + 'live reading behind it, and none was supplied.',
      candidate: null,
    };
  }

  return {
    ok: true,
    /* Shaped for `recordObservation`, which is the thing that will refuse it if
     * this is wrong. Nothing here is stored. */
    candidate: {
      category: 'version-behaviour',
      subject: corroborating[0].scope?.table ?? corroborating[0].title ?? 'instance',
      observation: String(statement),
      evidenceKind: corroborating[0].freshness.verification_source.tool ? 'tool-result' : 'instance-query',
      evidence: JSON.stringify(corroborating[0].freshness.verification_source),
      instance: instance || currentInstance(),
    },
    corroborated_by: corroborating.map((f) => f.id),
    supported_by: knowledge.map((k) => k.id),
    note: 'This is a CANDIDATE. It becomes knowledge only when recorded through the observation store, '
      + 'which independently requires a named evidence kind and the artifact itself.',
  };
}

/* ------------------------------------------------------------------ *
 * §36 / §37 / §38 / §39 / §40 — the integration surface
 * ------------------------------------------------------------------ */

/**
 * Knowledge relevant to something another domain is already doing.
 *
 * ONE FUNCTION FOR ALL FOUR INTEGRATIONS, deliberately. Doctor, NowLint,
 * NowTest and Change Intelligence want the same thing — "what do we know about
 * this subject" — and four bespoke entry points would be four places for the
 * authority labelling to drift.
 *
 * IT RETURNS CONTEXT AND NOTHING ELSE. There is no verdict, no recommendation
 * and no `authorises` that could be true: §36 permits knowledge to influence
 * which mechanism an agent prefers and forbids it bypassing capability
 * discovery, §38 permits it to explain a lint finding and forbids it replacing
 * the semantic rule, §39 permits it to guide a fixture and requires the fixture
 * be validated live. All three are the same rule, and it holds here because
 * what comes back is a list of labelled sentences.
 */
export async function knowledgeFor({
  subject, instance = null, table = null, artifact = null, stores = null, limits = {}, signal = null,
} = {}) {
  const scope = { instance: instance || currentInstance(), table, artifact };
  const result = await answerQuestion({
    question: String(subject ?? ''),
    stores: stores ?? bindStores({ instance: scope.instance }),
    scope,
    /* No live evidence: an integration already holds its own, and re-reading it
     * here would give one subject two authorities that could disagree. */
    liveEvidence: null,
    limits: { maxResults: limits.maxResults ?? 5, ...limits },
    signal,
  });

  return {
    subject,
    items: result.knowledge,
    sources: result.sources,
    scope: result.scope,
    degraded: result.retrieval?.degraded ?? false,
    complete: result.retrieval?.complete ?? true,
    isolated_out: result.retrieval?.isolated_out ?? [],
    /* Stated on the envelope so a caller cannot read a returned list as
     * permission to do anything (§35, §36). */
    authorises: false,
    note: 'Context only. Nothing here establishes what the instance does now, and nothing here lowers an '
      + 'approval bar or substitutes for a capability check.',
    panel: knowledgePanel(result),
  };
}

export { renderAnswer, knowledgePanel } from './render.js';
export { answerQuestion, adjudicate, citationOf, contradicts } from './answer.js';
export { classifyQuestion, subjectsOf } from './classify.js';
export {
  retrieve, normalizeQuery, scoreItem, rank, deduplicate, pack,
  WEIGHTS, NEAR_DUPLICATE, SEMANTIC_FLOOR,
} from './retrieve.js';
export {
  admits, isolate, normalizeInstance, scopeLevelOf, scopeRank, scopeAffinity, describeScope, isGlobalScope,
} from './scope.js';
export {
  fromFact, fromObservation, fromDocumentChunk, fromLiveReading, tableHintFrom,
} from './items.js';
export {
  KINDS, KIND_LIST, AUTHORITY, AUTHORITY_ORDER, AUTHORITY_LABEL, authorityRank,
  authorisingSourceOf, itemCanAuthorize, isVerified, SCOPES, SCOPE_ORDER, UNIVERSAL,
  FRESHNESS, QUESTION, LIMITS, VERDICTS, isKnowledgeItem, emptyAnswer,
} from './schemas.js';
