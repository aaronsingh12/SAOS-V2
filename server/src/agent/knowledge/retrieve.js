/**
 * PHASE 19 — THE RETRIEVAL PIPELINE (§8).
 *
 *   USER QUERY → NORMALIZE → SCOPE FILTER → LEXICAL → SEMANTIC → AUTHORITY
 *   → RANK → DEDUPE → PACK
 *
 * Every store is INJECTED. Nothing under `agent/knowledge/` imports a database,
 * a client or a provider, so this pipeline cannot reach anything on its own —
 * which is §77's boundary made structural rather than promised.
 *
 * ═══ DETERMINISM (§26) ═══
 *
 * Same query, same corpus, same filters → same ranked set, byte for byte. Two
 * things make that true and both are easy to lose:
 *
 *   the SCORE is arithmetic over four numbers, none of which comes from a model
 *   the TIEBREAK is the item id, so equal scores never depend on arrival order
 *
 * A sort whose ties resolve by insertion order is deterministic only by
 * accident, and the accident ends the first time a store returns rows in a
 * different order.
 *
 * ═══ WHAT THE MODEL MAY AND MAY NOT DO (§16, §26, §29) ═══
 *
 * It may phrase the query. It may not decide what exists, what ranks where, or
 * what is trustworthy: normalisation is a string transform, the filters are
 * built from the session's own binding, and the weights below are a frozen
 * literal. §29's "do not allow the LLM to arbitrarily reshuffle source trust"
 * is satisfied by there being no seam through which it could.
 *
 * ═══ FAILURE IS NOT ABSENCE (§75, §80.8) ═══
 *
 * A store that throws is recorded as UNAVAILABLE and the result says so. It is
 * never folded into "nothing was found", because those two produce opposite
 * actions from a reader and only one of them is safe to act on.
 */
import {
  AUTHORITY, AUTHORITY_ORDER, LIMITS, FRESHNESS, authorityRank, isVerified,
} from './schemas.js';
import { isolate, scopeRank, scopeAffinity, normalizeInstance, describeScope } from './scope.js';
import { fromFact, fromObservation, fromDocumentChunk } from './items.js';

/* ------------------------------------------------------------------ *
 * Query normalisation
 * ------------------------------------------------------------------ */

/** Words that match everything and therefore discriminate nothing. */
const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'what', 'why',
  'how', 'when', 'where', 'which', 'who', 'can', 'i', 'we', 'my', 'our', 'this',
  'that', 'it', 'to', 'of', 'in', 'on', 'for', 'with', 'and', 'or', 'be', 'have',
  'has', 'about', 'from', 'at', 'as', 'by', 'me', 'you', 'please', 'tell',
]);

/**
 * The query, canonically.
 *
 * A pure string transform, so §26 holds and so the same question typed twice
 * retrieves the same thing. The `terms` are what the store adapters match on;
 * the `text` is what the corpus search receives, since FTS and embeddings both
 * do better with the sentence than with a bag of words.
 */
export function normalizeQuery(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const terms = [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9_.\-\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  )];
  return { text, terms, empty: terms.length === 0 };
}

/** Does this item's text answer to any of the query's terms? */
function lexicalScore(item, terms) {
  if (!terms.length) return 0;
  const hay = `${item.title ?? ''} ${item.content ?? ''} ${item.provenance?.ref ?? ''}`.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits += 1;
  return hits / terms.length;
}

/* ------------------------------------------------------------------ *
 * §11 / §29 — the ranking
 * ------------------------------------------------------------------ */

/**
 * The weights. A frozen literal, so a ranking is a lookup and not a view.
 *
 * AUTHORITY DOMINATES ON PURPOSE and by a wide margin. §11's closing sentence —
 * "never let old highly relevant documentation override current live facts" —
 * is only true if relevance cannot outrun authority, and the only way to
 * guarantee that is to make the authority gap between two rungs larger than the
 * whole relevance range. It is: one rung is worth 0.40, and relevance in total
 * is worth 0.25.
 */
export const WEIGHTS = Object.freeze({
  authority: 0.40,
  scope: 0.20,
  relevance: 0.25,
  freshness: 0.15,
});

const AUTHORITY_SPAN = 6;
const SCOPE_SPAN = 5;

const FRESHNESS_SCORE = Object.freeze({
  [FRESHNESS.FRESH]: 1,
  [FRESHNESS.UNKNOWN]: 0.5,
  /* Below UNKNOWN, not zero: §12 is explicit that a stale document is not
   * automatically useless, and a stale item that is the only thing on the
   * subject should still be shown — clearly labelled — rather than vanish. */
  [FRESHNESS.STALE]: 0.25,
});

/**
 * The score, and every part of it.
 *
 * The parts are returned alongside the total because §73 wants the ranking
 * auditable and a bare number is not: "why is this third" has to be answerable
 * from the record, months later, without re-running anything.
 */
export function scoreItem(item, { terms = [], table = null, application = null, artifact = null } = {}) {
  const authority = 1 - (authorityRank(item.provenance?.authority) / AUTHORITY_SPAN);
  const scope = 1 - (scopeRank(item) / SCOPE_SPAN);
  const affinity = scopeAffinity(item, { table, application, artifact });
  /* A store's own score, where it has one, is blended with the term overlap —
   * FTS's bm25 and an embedding distance both know things a substring check
   * cannot, and the substring check knows when a rare identifier matched. */
  const lexical = lexicalScore(item, terms);
  /*
   * THE STORE'S SCORE IS NOT ON ONE SCALE, and treating it as though it were
   * silently destroyed document ranking.
   *
   * MEASURED on the real corpus. Semantic search returns a COSINE in [0,1];
   * keyword search returns a negated bm25 roughly in [0,20]. Dividing both by
   * ten crushed every semantic hit to about 0.05, so a document that answered
   * the question exactly ranked below every trap in the ledger and was cut by
   * the result budget. The conflict scenario then found no conflict — not
   * because the ladder failed, but because the contradicting page never
   * reached it.
   */
  const retrieval = typeof item.retrieval_score === 'number'
    ? Math.max(0, Math.min(1, item.retrieval_mode === 'keyword'
      ? item.retrieval_score / 10
      : item.retrieval_score))
    : null;
  const relevance = retrieval === null ? lexical : (lexical + retrieval) / 2;
  const freshness = FRESHNESS_SCORE[item.freshness?.state] ?? 0.5;

  const parts = {
    authority,
    scope: (scope + affinity) / 2,
    relevance,
    freshness,
  };
  const final = (WEIGHTS.authority * parts.authority)
    + (WEIGHTS.scope * parts.scope)
    + (WEIGHTS.relevance * parts.relevance)
    + (WEIGHTS.freshness * parts.freshness);

  return { ...parts, lexical, retrieval, affinity, final };
}

/** §26 — ties break on the id, never on arrival order. */
export function rank(items) {
  return [...items].sort((a, b) => (b.score.final - a.score.final) || a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------------ *
 * §32 — deduplication
 * ------------------------------------------------------------------ */

const shingle = (text) => String(text ?? '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ')
  .trim().split(' ').filter(Boolean);

/** Jaccard over word sets — cheap, symmetric, and deterministic. */
function similarity(a, b) {
  const A = new Set(shingle(a));
  const B = new Set(shingle(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export const NEAR_DUPLICATE = 0.82;

/**
 * The cosine below which a semantic hit is not about the question (§43).
 *
 * Measured on this embedding model against a real corpus: on-subject hits
 * scored 0.74 and 0.83, off-subject hits 0.33 to 0.48. See the note at the
 * filter that uses it for why a threshold is needed at all.
 */
export const SEMANTIC_FLOOR = 0.60;

/**
 * Collapse items that say the same thing.
 *
 * The HIGHEST-RANKED survivor wins, and the ones it absorbed are recorded on
 * it. §32's complaint is about the same fact appearing six times because six
 * chunks matched; keeping the count means a reader can still see that six
 * sources agreed, which is information, without paying for it six times.
 *
 * ONE EXCEPTION, AND IT MATTERS. Two items from DIFFERENT authorities are never
 * merged even when their text is identical. "Documentation says X" and "the
 * live instance says X" is a corroboration worth seeing, and collapsing them
 * would destroy exactly the distinction §21 exists to preserve.
 */
export function deduplicate(ranked) {
  const kept = [];
  for (const item of ranked) {
    const twin = kept.find((k) => k.provenance?.authority === item.provenance?.authority
      && similarity(k.content, item.content) >= NEAR_DUPLICATE);
    if (twin) {
      twin.duplicates = (twin.duplicates ?? 0) + 1;
      twin.duplicate_ids = [...(twin.duplicate_ids ?? []), item.id];
      continue;
    }
    kept.push({ ...item });
  }
  return kept;
}

/* ------------------------------------------------------------------ *
 * §31 — packing
 * ------------------------------------------------------------------ */

/** Clip an item's text to the per-item budget, saying that it was clipped. */
export function pack(items, { maxResults = LIMITS.MAX_RESULTS, maxChars = LIMITS.MAX_CHARS_PER_ITEM } = {}) {
  /*
   * ONE STORE MAY NOT TAKE EVERY SLOT.
   *
   * MEASURED, and it is the second half of the same defect as the score scale.
   * A ledger entry outranks a documentation chunk on authority by design, and
   * with forty-five facts in the ledger that design filled all eight slots with
   * traps and dropped the one page that answered the question.
   *
   * That is the wrong reading of §11. Authority decides which source WINS a
   * disagreement; it was never meant to decide which sources a reader gets to
   * see. So the best-ranked item of each authority present is seated first, in
   * authority order, and the remaining slots are filled by rank. A reader
   * always sees the live fact AND the trap AND the documentation, which is
   * precisely what §21 and §33 ask the answer to distinguish between.
   *
   * Deterministic: both passes walk an already-ranked list.
   */
  const seated = [];
  const seen = new Set();
  for (const authority of AUTHORITY_ORDER) {
    if (seated.length >= maxResults) break;
    const best = items.find((i) => i.provenance?.authority === authority && !seen.has(i.id));
    if (best) { seated.push(best); seen.add(best.id); }
  }
  for (const item of items) {
    if (seated.length >= maxResults) break;
    if (seen.has(item.id)) continue;
    seated.push(item);
    seen.add(item.id);
  }
  /* Restore rank order: seating decides WHO is included, never in what order. */
  const chosen = items.filter((i) => seen.has(i.id));

  return chosen.slice(0, maxResults).map((item) => {
    const text = String(item.content ?? '').replace(/\s+/g, ' ').trim();
    const clipped = text.length > maxChars;
    return {
      ...item,
      content: clipped ? `${text.slice(0, maxChars)}…` : text,
      clipped,
      full_length: text.length,
    };
  });
}

/* ------------------------------------------------------------------ *
 * The pipeline
 * ------------------------------------------------------------------ */

/**
 * Retrieve across every store, isolated, ranked and packed.
 *
 * @param query    the user's words
 * @param stores   { facts, observations, documents } — each optional, each a
 *                 function this module calls and does not construct
 * @param scope    { instance, application, table, artifact }
 *
 * A store that is absent is simply not consulted. A store that THROWS is
 * recorded in `unavailable` — the distinction §75 and §80.8 turn on.
 */
export async function retrieve({
  query,
  stores = {},
  scope = {},
  limits = {},
  signal = null,
} = {}) {
  const started = Date.now();
  const timings = {};
  const normalized = normalizeQuery(query);
  const instance = normalizeInstance(scope.instance);
  const unavailable = [];
  const raw = [];

  const t0 = Date.now();
  timings.normalize_ms = t0 - started;

  /* ---- the three stores, each guarded ---- */
  const fetchLimit = limits.perStore ?? LIMITS.PER_STORE_FETCH;

  if (typeof stores.facts === 'function') {
    const t = Date.now();
    try {
      const rows = await stores.facts({ instance, terms: normalized.terms, limit: fetchLimit });
      for (const r of rows ?? []) { const item = fromFact(r); if (item) raw.push(item); }
    } catch (err) {
      unavailable.push({ store: 'facts', reason: err.message });
    }
    timings.facts_ms = Date.now() - t;
  }

  if (typeof stores.observations === 'function') {
    const t = Date.now();
    try {
      const rows = await stores.observations({ instance, terms: normalized.terms, limit: fetchLimit });
      for (const r of rows ?? []) { const item = fromObservation(r); if (item) raw.push(item); }
    } catch (err) {
      unavailable.push({ store: 'observations', reason: err.message });
    }
    timings.observations_ms = Date.now() - t;
  }

  let mode = null;
  if (typeof stores.documents === 'function') {
    const t = Date.now();
    try {
      const result = await stores.documents({ query: normalized.text, limit: fetchLimit, signal });
      mode = result?.mode ?? null;
      for (const h of result?.hits ?? []) {
        const item = fromDocumentChunk(h);
        /* The score's SCALE depends on which search ran, so the mode travels
         * with the item rather than being re-derived at ranking time. */
        if (item) raw.push({ ...item, retrieval_mode: mode });
      }
    } catch (err) {
      unavailable.push({ store: 'documents', reason: err.message });
    }
    timings.documents_ms = Date.now() - t;
  }

  /* ---- §9: isolation, before anything is ranked or shown ---- */
  const tIso = Date.now();
  const { kept, dropped } = isolate(raw, { instance });
  timings.isolate_ms = Date.now() - tIso;

  /* ---- rank, dedupe, pack ---- */
  const tRank = Date.now();
  const scored = kept.map((item) => ({
    ...item,
    score: scoreItem(item, {
      terms: normalized.terms,
      table: scope.table ?? null,
      application: scope.application ?? null,
      artifact: scope.artifact ?? null,
    }),
  }));
  /*
   * A RELEVANCE FLOOR, and only for the stores that cannot search.
   *
   * The documentation corpus is queried — FTS or embeddings already decided
   * that a chunk is about this question, and its score reflects how well. The
   * fact ledger and the observation store are not: they hand back everything
   * scoped to this instance, because neither has a query engine.
   *
   * Without a floor, every question retrieves the whole ledger. Authority alone
   * puts a ledger entry at 0.27 before relevance is considered, so twenty
   * unrelated traps would crowd out the documentation that actually answers the
   * question — and a reader would see a confident, authoritative, irrelevant
   * answer. So an unsearched item that shares no term with the question is
   * dropped as off-subject.
   *
   * NOT applied to documents: a semantic hit that shares no literal term with
   * the query is exactly what semantic retrieval is FOR, and a term floor would
   * discard the best thing it does.
   */
  const searched = (item) => item.provenance?.store === 'documents';
  /*
   * ONE MATCHED TERM IS NOT ENOUGH ON A LONG QUESTION.
   *
   * MEASURED. "What is our standard process for provisioning orbital telemetry
   * uplinks?" retrieved eight traps, because "process" appears in a great many
   * of them and one hit out of six cleared a floor of "greater than zero". The
   * run then reported ANSWERED with eight citations for a subject nothing in
   * the build knows anything about — §43's failure, dressed as a result.
   *
   * A longer question carries more ways to match by accident, so a longer
   * question demands more agreement: two matched terms once there are three to
   * choose from. Documents are exempt, as before — a semantic hit that shares
   * no literal term with the query is what semantic retrieval is FOR.
   */
  const minHits = normalized.terms.length >= 3 ? 2 : 1;
  const hitCount = (item) => Math.round(item.score.lexical * normalized.terms.length);
  /*
   * A NEAREST NEIGHBOUR IS NOT NECESSARILY A NEIGHBOUR.
   *
   * MEASURED, and it is why §43 needs this at all. A cosine search returns the
   * closest vectors it has REGARDLESS of how far away they are, so with two
   * documents in the corpus every question retrieved both — including "what
   * colour is the moon on Tuesdays". The run then reported ANSWERED, with
   * citations, for a subject nothing in the build knows anything about.
   *
   * The separation is clean enough to cut. On this embedding model, against
   * this corpus:
   *
   *   on-subject     0.83, 0.74
   *   off-subject    0.48, 0.48, 0.47, 0.40, 0.33
   *
   * The off-subject cluster sits at the model's baseline similarity for
   * ordinary English. 0.60 is above every off-subject score measured and below
   * every on-subject one, with margin on both sides.
   *
   * A keyword hit needs no floor of its own: FTS only returns rows that matched
   * a term, so the term test below already covers it.
   */
  const semanticallyClose = (item) => item.retrieval_mode !== 'keyword'
    && typeof item.retrieval_score === 'number'
    && item.retrieval_score >= SEMANTIC_FLOOR;
  const onSubject = scored.filter((item) => (searched(item)
    ? (semanticallyClose(item) || hitCount(item) >= 1)
    : hitCount(item) >= minHits));
  const offSubject = scored.length - onSubject.length;

  const ordered = rank(onSubject);
  const deduped = deduplicate(ordered);
  const packed = pack(deduped, {
    maxResults: limits.maxResults ?? LIMITS.MAX_RESULTS,
    maxChars: limits.maxChars ?? LIMITS.MAX_CHARS_PER_ITEM,
  });
  timings.rank_ms = Date.now() - tRank;
  timings.total_ms = Date.now() - started;

  return {
    query: normalized,
    scope: describeScope({ instance, ...scope }),
    items: packed,
    considered: raw.length,
    admitted: kept.length,
    off_subject: offSubject,
    isolated_out: dropped,
    /*
     * §28/§47 — which search actually ran. A keyword-only run found what a
     * substring match can find and nothing else, and a reader who does not know
     * that will read a thin result as a thin corpus.
     */
    mode,
    degraded: mode === 'keyword',
    unavailable,
    /* §80.8 — a store that failed is not a store that found nothing. */
    complete: unavailable.length === 0,
    timings,
  };
}

export const _internals = { STOP, lexicalScore, similarity, FRESHNESS_SCORE, AUTHORITY };
