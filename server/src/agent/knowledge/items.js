/**
 * PHASE 19 — THREE STORES, ONE SHAPE.
 *
 * Every function here is an ADAPTER. It reads a row one of the existing stores
 * already produces and returns the §4 knowledge item for it. Nothing here
 * queries, writes, embeds or decides — the stores keep their own retrieval, and
 * this file exists only so that a trap, a verified observation and a
 * documentation chunk can be ranked against each other at all.
 *
 * ═══ THE ONE JUDGEMENT EACH ADAPTER MAKES ═══
 *
 * Which AUTHORITY the row carries. It is a judgement about the STORE rather
 * than about the row's contents, which is what keeps it out of the model's
 * reach: a documentation chunk is documentation however confidently it is
 * phrased, and a measured SDK limitation is a verified fact however tersely.
 *
 * The mapping, and why each is where it is:
 *
 *   facts.js trap/mapping   LEDGER. Every seeded entry was MEASURED against a
 *                           live instance — that is the entry condition for the
 *                           ledger — so each carries its provenance string as
 *                           its verification.
 *   facts.js decision/pref  ARCHITECTURE_NOTE at LEDGER authority. A decision
 *                           is a fact about this project, not about ServiceNow.
 *   observations sdk-limit  LEDGER, verified. `capabilityClaimsFor` already
 *   observations tooling    ranks these at `tool_capability`, and this agrees
 *                           with it rather than inventing a second answer.
 *   observations success    HISTORICAL_NOTE. §11's warning made concrete: "it
 *   observations failure    worked once" must not outrank documentation for
 *                           every future case, so it sits below it.
 *   kb_documents            DOCUMENTATION, globally scoped. The corpus has no
 *                           instance column because it is not about an
 *                           instance — which is exactly why §9 lets it through
 *                           for every instance and lets nothing else.
 */
import { KINDS, AUTHORITY, SCOPES, FRESHNESS, UNIVERSAL } from './schemas.js';

/* ------------------------------------------------------------------ *
 * memory/facts.js — the instance trap ledger
 * ------------------------------------------------------------------ */

const FACT_KIND_TO_KNOWLEDGE = Object.freeze({
  trap: KINDS.TRAP,
  mapping: KINDS.INSTANCE_FACT,
  decision: KINDS.ARCHITECTURE_NOTE,
  preference: KINDS.ARCHITECTURE_NOTE,
});

/**
 * One ledger row as a knowledge item.
 *
 * `provenance` on a fact row is a free-text sentence saying how it was
 * established — "measured on dev424910", "read back after a write". It is
 * carried verbatim as the verification source rather than parsed: a sentence a
 * person wrote about how they know something is worth more to the next reader
 * than a category this code guessed from it.
 */
export function fromFact(row) {
  if (!row?.key) return null;
  const universal = row.instance === UNIVERSAL;
  return {
    id: `fact:${row.instance}:${row.kind}:${row.key}`,
    kind: FACT_KIND_TO_KNOWLEDGE[row.kind] ?? KINDS.INSTANCE_FACT,
    title: row.key,
    content: String(row.value ?? ''),
    scope: {
      level: universal ? SCOPES.GLOBAL : SCOPES.INSTANCE,
      instance: universal ? null : row.instance,
      application: null,
      table: tableHintFrom(row.key, row.value),
      artifact: null,
    },
    provenance: {
      source: universal ? 'instance knowledge ledger (universal)' : `instance knowledge ledger (${row.instance})`,
      authority: AUTHORITY.LEDGER,
      ref: `facts/${row.kind}/${row.key}`,
      store: 'facts',
    },
    freshness: {
      /* A ledger entry earns FRESH by carrying the provenance that put it
       * there. Without one it is a row somebody inserted, which is UNKNOWN. */
      state: row.provenance ? FRESHNESS.FRESH : FRESHNESS.UNKNOWN,
      verified_at: row.provenance ? (row.ts ?? null) : null,
      verified_by: null,
      verification_source: row.provenance ? { note: row.provenance } : null,
      confidence: typeof row.confidence === 'number' ? row.confidence : null,
    },
    created_at: row.ts ?? null,
    updated_at: row.ts ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * knowledge/observations.js — verified observations
 * ------------------------------------------------------------------ */

const OBSERVATION_KIND = Object.freeze({
  'sdk-limitation': KINDS.TRAP,
  'tooling-defect': KINDS.TRAP,
  'version-behaviour': KINDS.INSTANCE_FACT,
  'implementation-success': KINDS.HISTORICAL_NOTE,
  'implementation-failure': KINDS.HISTORICAL_NOTE,
});

/** Which observation categories are capability CLAIMS rather than anecdotes. */
const CAPABILITY_CATEGORIES = new Set(['sdk-limitation', 'tooling-defect']);

export function fromObservation(row) {
  if (!row?.observation) return null;
  const universal = row.instance === UNIVERSAL;
  const capability = CAPABILITY_CATEGORIES.has(row.category);
  return {
    id: `observation:${row.id}`,
    kind: OBSERVATION_KIND[row.category] ?? KINDS.HISTORICAL_NOTE,
    title: row.subject,
    content: String(row.observation ?? ''),
    scope: {
      level: universal ? SCOPES.GLOBAL : SCOPES.INSTANCE,
      instance: universal ? null : row.instance,
      application: null,
      table: tableHintFrom(row.subject, row.observation),
      artifact: row.subject ?? null,
    },
    provenance: {
      source: universal
        ? 'verified observation (universal)'
        : `verified observation (${row.instance})`,
      /*
       * A capability measurement is a LEDGER fact; an implementation anecdote
       * is HISTORICAL. Both were verified — the store refuses to hold either
       * without an artifact — but only one of them is a claim about what the
       * platform does, and §11 is explicit that "it worked once" must not
       * outrank documentation.
       */
      authority: capability ? AUTHORITY.LEDGER : AUTHORITY.HISTORICAL,
      ref: `observation/${row.id}`,
      store: 'observations',
      category: row.category,
      confirmations: row.confirmations ?? 1,
    },
    freshness: {
      /* The store will not accept an observation without an evidence kind AND
       * an artifact, so every row here is verified by construction. */
      state: FRESHNESS.FRESH,
      verified_at: row.confirmed_at ?? row.observed_at ?? null,
      verified_by: null,
      verification_source: { tool: row.evidence_kind, evidence: row.evidence ?? null },
      confirmations: row.confirmations ?? 1,
    },
    created_at: row.observed_at ?? null,
    updated_at: row.confirmed_at ?? row.observed_at ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * knowledge/store.js — the documentation corpus
 * ------------------------------------------------------------------ */

/**
 * A developer guide is procedural how-to content, which is what §3 means by a
 * RUNBOOK; everything else in the corpus is reference. The mapping is stated
 * rather than inferred so a reader can disagree with it in one place.
 */
const DOC_TYPE_KIND = Object.freeze({
  'developer-guide': KINDS.RUNBOOK,
  documentation: KINDS.DOCUMENTATION,
  'api-reference': KINDS.DOCUMENTATION,
  'release-note': KINDS.DOCUMENTATION,
  'kb-article': KINDS.DOCUMENTATION,
  'store-listing': KINDS.DOCUMENTATION,
});

/**
 * One retrieved chunk as a knowledge item.
 *
 * SCOPED GLOBAL, ALWAYS, and this is the load-bearing line for §9. The corpus
 * describes ServiceNow, not a ServiceNow instance: there is no instance column
 * on `kb_documents` because there is nothing instance-specific to put in one.
 * That is why documentation reaches every instance and why nothing else does —
 * the isolation rule has no exception to make here, because the data has no
 * instance to leak.
 */
export function fromDocumentChunk(hit) {
  if (!hit?.text) return null;
  return {
    id: `doc:${hit.document}:${hit.seq ?? 0}`,
    kind: DOC_TYPE_KIND[hit.document_type] ?? KINDS.DOCUMENTATION,
    title: hit.title || hit.topic || hit.document,
    content: String(hit.text ?? ''),
    scope: {
      level: SCOPES.GLOBAL,
      instance: null,
      application: null,
      table: null,
      artifact: null,
    },
    provenance: {
      source: hit.source,
      authority: AUTHORITY.DOCUMENTATION,
      ref: hit.url,
      store: 'documents',
      product: hit.product ?? null,
      topic: hit.topic ?? null,
      version: hit.version ?? null,
      version_rank: hit.version_rank ?? null,
      document_type: hit.document_type ?? null,
      document: hit.document,
      chunk: hit.seq ?? 0,
    },
    freshness: {
      /*
       * A documentation page is UNKNOWN unless something re-checked it, and
       * almost nothing ever does. §12 is explicit that age alone does not make
       * a page useless, so nothing here reads `updated_at` and calls it stale;
       * a page is marked STALE only when the live instance has been observed to
       * contradict it, which happens in `answer.js` where the contradiction is.
       */
      state: FRESHNESS.UNKNOWN,
      verified_at: null,
      verified_by: null,
      verification_source: null,
      source_updated_at: hit.updated_at ?? null,
    },
    created_at: hit.updated_at ?? null,
    updated_at: hit.updated_at ?? null,
    /* The store's own relevance score, carried through so ranking does not have
     * to re-derive what FTS or the embedding already measured. */
    retrieval_score: typeof hit.score === 'number' ? hit.score : null,
  };
}

/* ------------------------------------------------------------------ *
 * Live evidence — the top rung, and the only one this file does not read
 * ------------------------------------------------------------------ */

/**
 * A live reading, as a knowledge item.
 *
 * The CALLER produces the reading; this only gives it the shape. That
 * separation is the point: nothing under `agent/knowledge/` may reach the
 * instance, so a live fact exists here only because something that CAN read the
 * instance handed one over, and it arrives with its evidence attached.
 *
 * An attempt to build one without evidence is refused rather than demoted. The
 * demotion path exists in `precedence.js` for claims arriving from a model;
 * here the caller is our own code, and a live fact with no reading behind it is
 * a bug to fix rather than a claim to rank down.
 */
export function fromLiveReading({ id, title, statement, evidence, scope = {}, at = null, tool = null }) {
  if (!statement) throw new Error('a live fact needs a statement');
  if (!evidence) {
    throw new Error(
      `Refusing to build a live knowledge item for "${title ?? id}" with no evidence. A live fact is a `
      + 'reading; without the reading it is a belief about the instance wearing live authority.',
    );
  }
  return {
    id: `live:${id}`,
    kind: KINDS.INSTANCE_FACT,
    title: title ?? id,
    content: String(statement),
    scope: {
      level: scope.table ? SCOPES.TABLE : SCOPES.INSTANCE,
      instance: scope.instance ?? null,
      application: scope.application ?? null,
      table: scope.table ?? null,
      artifact: scope.artifact ?? null,
    },
    provenance: {
      source: tool ? `live read (${tool})` : 'live read',
      authority: AUTHORITY.LIVE,
      ref: tool ?? 'live',
      store: 'live',
    },
    freshness: {
      state: FRESHNESS.FRESH,
      verified_at: at,
      verified_by: tool,
      verification_source: { tool, evidence },
    },
    created_at: at,
    updated_at: at,
  };
}

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

/**
 * A table name mentioned by a fact, if one unambiguously is.
 *
 * Deliberately conservative: it matches the shapes ServiceNow table names
 * actually take and nothing else, so a fact that merely uses the word
 * "incident" in a sentence does not acquire a table scope it never claimed. A
 * wrong table scope is worse than none — it would make the fact outrank a
 * genuinely table-scoped one under §11's ordering.
 */
export function tableHintFrom(...texts) {
  const text = texts.filter(Boolean).join(' ');
  const m = /\b((?:sys_|u_|x_[a-z0-9_]+_|cmdb_|task_|sc_|kb_|alm_|chg_)[a-z0-9_]{2,})\b/i.exec(text);
  if (m) return m[1].toLowerCase();
  const plain = /\b(incident|problem|change_request|sys_user|task)\b/i.exec(text);
  return plain ? plain[1].toLowerCase() : null;
}

export const _internals = {
  FACT_KIND_TO_KNOWLEDGE, OBSERVATION_KIND, DOC_TYPE_KIND, CAPABILITY_CATEGORIES,
};
