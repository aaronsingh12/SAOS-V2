import { getDb } from '../memory/db.js';
import { getSettings } from '../config/store.js';
import {
  embed, cosine, chunkText, toBlob, fromBlob,
  embedModelName, embeddingsAvailable, pullCommand, toFtsQuery,
} from '../memory/recall.js';
import { validateDocument, rankVersion, UNVERSIONED } from './schema.js';
import { redact } from '../memory/redact.js';

/**
 * K1 — the ServiceNow documentation corpus: storage, and version-aware
 * retrieval over it.
 *
 * REUSED WHOLESALE from recall (A-5): the embedding call, the cosine, the
 * chunker, the float32 encoding, the FTS query builder. Nothing about
 * retrieving documentation differs mechanically from retrieving conversation,
 * and a second copy of any of those would be a second thing to keep correct.
 *
 * What IS different, and why this is not just another `kind` in `chunks`:
 *
 *   1. PROVENANCE. Every row here carries seven metadata fields, and the
 *      conflict ladder (knowledge/precedence.js) is built on being able to say
 *      "this came from documentation" as distinct from "this we measured".
 *      Merged into one table those become indistinguishable.
 *   2. VERSION. A document describes a release. A chat message does not.
 *   3. AUTHORITY. Documentation is the THIRD rung of the ladder — below live
 *      instance state and below what the tools can actually do. Keeping it in
 *      its own store is what makes that ordering enforceable rather than
 *      aspirational.
 *
 * Same degradation contract as recall: with no embedding model pulled, search
 * falls back to FTS5 keyword matching and SAYS SO, with the pull command. It
 * never returns keyword hits dressed as semantic ones.
 */

const now = () => new Date().toISOString();

function releaseOrder() {
  const order = getSettings().rag?.releaseOrder;
  return Array.isArray(order) ? order : [];
}

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

/**
 * Validate a document and work out what writing it WOULD do, without writing.
 *
 * Shared by `upsertDocument` and by ingestion's dry run, deliberately: a
 * preview computed by a second code path is a preview that can disagree with
 * the write it is previewing, which is worse than having no preview at all.
 *
 * @returns {{ ok, errors?, warnings?, document?, status?, existing? }}
 */
export function planDocument(input) {
  /*
   * PHASE 19 (§51) — SECRETS ARE REMOVED BEFORE A DOCUMENT BECOMES A DOCUMENT.
   *
   * AUDITED GAP, not a hypothetical: ingestion performed no redaction at all.
   * A corpus file containing `password=hunter2` — an operator pasting a failing
   * integration's own log into a runbook is the ordinary way this happens — was
   * stored verbatim, indexed into FTS, embedded, and then retrieved into the
   * model's context. §80.6 makes that a release blocker.
   *
   * IT BELONGS HERE AND NOT IN `ingestCorpus`. This function is the single
   * choke point every document passes through: the corpus walker calls it, and
   * so does any direct `upsertDocument` caller. Redacting in the walker would
   * leave the direct path open, which is the same mistake as guarding a tool
   * instead of the gate.
   *
   * IT RUNS BEFORE VALIDATION, so the content hash is taken over the REDACTED
   * text. Hashing the original would make every re-ingest look like a change
   * and re-embed the whole corpus each time.
   *
   * The scrubber is `evidence/redact.js`, unchanged and un-copied — §51 says
   * use the existing infrastructure, and a second implementation is a second
   * thing that can fall behind the key list.
   */
  const scrubbed = typeof input?.text === 'string'
    ? { ...input, text: redact(input.text) }
    : input;
  const redactedSecrets = scrubbed !== input && scrubbed.text !== input.text;

  const { ok, errors, warnings, document } = validateDocument(scrubbed, { releaseOrder: releaseOrder() });
  if (!ok) return { ok: false, errors, warnings };
  if (redactedSecrets) {
    warnings.push(
      'This document contained something shaped like a credential (a value assigned to a name such as '
      + 'password, token or api_key). It was redacted before storage, so the corpus and every answer '
      + 'built from it hold [redacted] rather than the value.',
    );
  }

  const existing = getDb()
    .prepare('SELECT content_hash FROM kb_documents WHERE id = ?')
    .get(document.id);
  const textChanged = !existing || existing.content_hash !== document.content_hash;

  return {
    ok: true,
    warnings,
    document,
    existing: existing || null,
    textChanged,
    status: !existing ? 'created' : (textChanged ? 'updated' : 'unchanged'),
  };
}

/** Dry-run form: what ingestion would do to this document, and why. */
export function previewDocument(input) {
  const plan = planDocument(input);
  if (!plan.ok) return { ok: false, errors: plan.errors, warnings: plan.warnings };
  return {
    ok: true,
    id: plan.document.id,
    status: plan.status,
    sourceRule: plan.document.source_rule,
    warnings: plan.warnings,
  };
}

/**
 * Insert or update one document, re-chunking it when the text changed.
 *
 * An UNCHANGED document is left completely alone — chunks and their embeddings
 * both. Re-chunking it would delete the chunk rows, cascade the embeddings
 * away and force every one of them to be recomputed, which turns "re-run
 * ingestion" from a cheap idempotent operation into an expensive one that
 * silently degrades search until the backfill catches up.
 *
 * Metadata is refreshed either way: a document whose text is identical but
 * whose `updated_at` or release moved is a real change, and it is the change
 * that version-aware retrieval reads.
 *
 * ATOMIC. The document row, the chunk deletion and the chunk inserts are one
 * transaction, because the intermediate state is a real hazard rather than a
 * theoretical one: between the DELETE and the INSERTs a document exists with
 * ZERO chunks, and a document with zero chunks is invisible to every search
 * while still being counted by `knowledgeStats`. A crash there would leave a
 * corpus that reports 400 documents and can only retrieve 399, with nothing
 * anywhere saying which one went quiet.
 *
 * @returns {{ ok, id?, status?, chunks?, sourceRule?, warnings?, errors? }}
 */
export function upsertDocument(input) {
  const plan = planDocument(input);
  if (!plan.ok) return { ok: false, errors: plan.errors, warnings: plan.warnings };
  const { document, warnings, textChanged, status } = plan;

  const db = getDb();
  db.exec('BEGIN');
  try {
    const chunks = writeDocument(db, document, textChanged);
    db.exec('COMMIT');
    return { ok: true, id: document.id, status, chunks, sourceRule: document.source_rule, warnings };
  } catch (err) {
    db.exec('ROLLBACK');
    // Reported, not thrown: one unwritable document must not take down an
    // ingestion run over the other 399.
    return {
      ok: false,
      errors: [`could not store document: ${err.message}`],
      warnings,
    };
  }
}

/** The write itself. Assumes it is already inside a transaction. */
function writeDocument(db, document, textChanged) {
  db.prepare(
    `INSERT INTO kb_documents
       (id, source, product, topic, version, version_rank, document_type, url, updated_at, title, ingested_at, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source=excluded.source, product=excluded.product, topic=excluded.topic,
       version=excluded.version, version_rank=excluded.version_rank,
       document_type=excluded.document_type, url=excluded.url,
       updated_at=excluded.updated_at, title=excluded.title,
       ingested_at=excluded.ingested_at, content_hash=excluded.content_hash`
  ).run(
    document.id, document.source, document.product, document.topic,
    document.version, document.version_rank, document.document_type,
    document.url, document.updated_at, document.title, now(), document.content_hash,
  );

  if (!textChanged) {
    return db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE document = ?').get(document.id).n;
  }

  db.prepare('DELETE FROM kb_chunks WHERE document = ?').run(document.id);
  const stmt = db.prepare('INSERT INTO kb_chunks (document, seq, text) VALUES (?, ?, ?)');
  const parts = chunkText(document.text);
  parts.forEach((part, i) => stmt.run(document.id, i, part));
  /*
   * A document that chunks to nothing would be stored, counted and permanently
   * unretrievable. `validateDocument` already refuses blank text, so reaching
   * here means the chunker disagreed with the validator — which is a bug, and
   * the transaction is the right place to find out about it.
   */
  if (!parts.length) throw new Error('document produced no chunks and would be silently unsearchable');
  return parts.length;
}

/**
 * Recompute every document's rank after the operator changes the release order.
 *
 * Without this, `settings.rag.releaseOrder` would only affect documents ingested
 * AFTER it was set, so version-aware retrieval would silently apply to part of
 * the corpus — which is worse than not applying at all, because the part it
 * skips is invisible.
 */
export function reindexVersionRanks() {
  const db = getDb();
  const order = releaseOrder();
  const rows = db.prepare('SELECT id, version, version_rank FROM kb_documents').all();
  const stmt = db.prepare('UPDATE kb_documents SET version_rank = ? WHERE id = ?');
  let changed = 0;
  let ranked = 0;
  for (const r of rows) {
    const rank = rankVersion(r.version, order);
    if (rank !== null) ranked += 1;
    if (rank !== r.version_rank) { stmt.run(rank, r.id); changed += 1; }
  }
  return { documents: rows.length, ranked, unranked: rows.length - ranked, changed };
}

/** Embed whatever is not embedded yet. Reported on failure, never thrown. */
export async function backfillKnowledgeEmbeddings({ limit = 128 } = {}) {
  const db = getDb();
  const model = embedModelName();
  const pending = db
    .prepare(
      `SELECT c.id, c.text FROM kb_chunks c
        LEFT JOIN kb_embeddings e ON e.chunk = c.id AND e.model = ?
       WHERE e.chunk IS NULL
       LIMIT ?`
    )
    .all(model, limit);
  if (!pending.length) return { embedded: 0, pending: 0, ok: true };

  try {
    const vecs = await embed(pending.map((p) => p.text));
    const stmt = db.prepare('INSERT OR REPLACE INTO kb_embeddings (chunk, model, dim, vec) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      pending.forEach((p, i) => {
        const v = vecs[i];
        if (!v) return;
        stmt.run(p.id, model, v.length, toBlob(v));
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const left = db
      .prepare(
        `SELECT COUNT(*) AS n FROM kb_chunks c
          LEFT JOIN kb_embeddings e ON e.chunk = c.id AND e.model = ?
         WHERE e.chunk IS NULL`
      )
      .get(model).n;
    return { embedded: pending.length, pending: left, ok: true };
  } catch (err) {
    return { embedded: 0, pending: pending.length, ok: false, error: err.message, command: pullCommand() };
  }
}

export function deleteDocument(id) {
  return getDb().prepare('DELETE FROM kb_documents WHERE id = ?').run(id).changes;
}

/** Corpus shape, for the route and for the "is anything indexed at all" check. */
export function knowledgeStats() {
  const db = getDb();
  const docs = db.prepare('SELECT COUNT(*) AS n FROM kb_documents').get().n;
  const chunks = db.prepare('SELECT COUNT(*) AS n FROM kb_chunks').get().n;
  const embedded = db
    .prepare('SELECT COUNT(*) AS n FROM kb_embeddings WHERE model = ?')
    .get(embedModelName()).n;
  const unranked = db.prepare('SELECT COUNT(*) AS n FROM kb_documents WHERE version_rank IS NULL').get().n;
  const bySource = db.prepare('SELECT source, COUNT(*) AS n FROM kb_documents GROUP BY source ORDER BY n DESC').all();
  const byTopic = db.prepare('SELECT topic, COUNT(*) AS n FROM kb_documents GROUP BY topic ORDER BY n DESC').all();
  return { documents: docs, chunks, embedded, unranked, bySource, byTopic, releaseOrder: releaseOrder() };
}

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

const FILTERABLE = ['source', 'product', 'topic', 'document_type', 'version'];

function filterClause(filters = {}) {
  const where = [];
  const args = [];
  for (const f of FILTERABLE) {
    if (filters[f]) { where.push(`d.${f} = ?`); args.push(filters[f]); }
  }
  return { where, args };
}

/**
 * The degraded path, exported so it can be tested without an embedding model
 * being pulled on whatever machine runs the suite.
 */
export function keywordSearchKnowledge(query, { limit = 12, filters = {} } = {}) {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const { where, args } = filterClause(filters);
  const filterSql = where.length ? `AND ${where.join(' AND ')}` : '';
  const sql = `
    SELECT c.id AS chunk, c.document, c.seq, c.text,
           d.source, d.product, d.topic, d.version, d.version_rank,
           d.document_type, d.url, d.updated_at, d.title,
           bm25(kb_chunks_fts) AS score
      FROM kb_chunks_fts
      JOIN kb_chunks c ON c.id = kb_chunks_fts.rowid
      JOIN kb_documents d ON d.id = c.document
     WHERE kb_chunks_fts MATCH ?
       ${filterSql}
     ORDER BY score
     LIMIT ?`;
  try {
    // bm25() is negative and MORE negative is better; negating it is the whole
    // conversion to higher-is-better. (recall.js carries the scar tissue on
    // why Math.abs here silently inverts the ranking.)
    return getDb().prepare(sql).all(fts, ...args, limit).map((r) => ({ ...r, score: -r.score }));
  } catch {
    return [];
  }
}

async function semanticSearchKnowledge(query, { limit, filters }) {
  const db = getDb();
  const model = embedModelName();
  const [qvec] = await embed([query]);
  const { where, args } = filterClause(filters);
  const filterSql = where.length ? `AND ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT c.id AS chunk, c.document, c.seq, c.text,
              d.source, d.product, d.topic, d.version, d.version_rank,
              d.document_type, d.url, d.updated_at, d.title,
              e.vec, e.dim
         FROM kb_embeddings e
         JOIN kb_chunks c ON c.id = e.chunk
         JOIN kb_documents d ON d.id = c.document
        WHERE e.model = ? ${filterSql}`
    )
    .all(model, ...args);

  const scored = [];
  for (const r of rows) {
    // A dimension mismatch means the embedding model changed under us.
    // Comparing across models yields a number that looks exactly like a score.
    if (r.dim !== qvec.length) continue;
    const { vec, dim, ...rest } = r;
    scored.push({ ...rest, score: cosine(qvec, fromBlob(vec)) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * VERSION-AWARE RETRIEVAL, and the honest account of what it can actually do.
 *
 * "Prefer newer documentation" is only meaningful between two documents that
 * are ABOUT THE SAME THING. A Xanadu ACL page does not supersede a Vancouver
 * Flow Designer page, and a ranking that let it would quietly bury relevant
 * material behind irrelevant newer material.
 *
 * So the preference is applied within a FAMILY — same source, product, topic
 * and title — where two hits genuinely are two releases of one page. Within a
 * family the newest wins and the older ones are dropped, with the losers named
 * in `superseded` so nothing disappears silently.
 *
 * Which signal decided is reported per family, because there are two and they
 * are not equally good:
 *
 *   'release-order' — every document's release is in settings.rag.releaseOrder.
 *                     This is the real answer.
 *   'updated-at'    — at least one release is unranked, so recency of the
 *                     SOURCE's own last-modified date stood in. Weaker: a page
 *                     for an old release can be edited yesterday.
 *
 * Relevance scores are NOT adjusted by version. A bm25 score and a cosine score
 * are on different scales, and a "newness boost" tuned against one of them
 * would be a magic number that silently misbehaves on the other.
 */
export function applyVersionPreference(hits, { releaseOrder: order = [] } = {}) {
  const families = new Map();
  for (const h of hits) {
    const family = `${h.source}|${h.product}|${h.topic}|${h.title || h.document}`;
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(h);
  }

  const kept = [];
  const superseded = [];
  const signals = [];

  for (const [family, group] of families) {
    // Several chunks of the SAME document are not a version conflict and must
    // not be deduplicated — only distinct documents in one family are.
    const byDoc = new Map();
    for (const h of group) if (!byDoc.has(h.document)) byDoc.set(h.document, h);
    if (byDoc.size < 2) { kept.push(...group); continue; }

    const docs = [...byDoc.values()];
    const allRanked = docs.every((d) => d.version_rank !== null && d.version_rank !== undefined);
    const signal = allRanked ? 'release-order' : 'updated-at';
    const winner = docs.slice().sort((a, b) => (
      allRanked
        ? b.version_rank - a.version_rank
        : Date.parse(b.updated_at) - Date.parse(a.updated_at)
    ))[0];

    signals.push({
      family,
      signal,
      chose: { document: winner.document, version: winner.version, url: winner.url },
      over: docs.filter((d) => d.document !== winner.document).map((d) => ({ version: d.version, url: d.url })),
      // The caveat travels WITH the decision, rather than being general advice
      // in a doc nobody reads at the moment it matters.
      caveat: allRanked
        ? null
        : 'Not every release in this group is listed in settings.rag.releaseOrder'
          + `${order.length ? '' : ' (which is empty)'}, so the newest was decided by the source's `
          + 'updated_at rather than by release order.',
    });

    for (const h of group) {
      if (h.document === winner.document) kept.push(h);
      else superseded.push(h);
    }
  }

  kept.sort((a, b) => b.score - a.score);
  return { hits: kept, superseded, signals };
}

/**
 * Retrieve ServiceNow knowledge.
 *
 * Always reports `mode` ('semantic' | 'keyword' | 'none') and, when keyword,
 * WHY — same contract as recall.search, for the same reason: a caller that
 * presents keyword hits as semantic ones is lying by omission.
 *
 * Also always reports `indexed`. An empty corpus returning zero hits and a
 * well-stocked corpus returning zero hits mean completely different things,
 * and only one of them means "the documentation does not cover this".
 */
export async function searchKnowledge(query, { limit = 8, filters = {}, preferNewer = true } = {}) {
  const stats = knowledgeStats();
  const base = { query, indexed: stats.documents, releaseOrder: stats.releaseOrder };

  if (!stats.documents) {
    return {
      ...base,
      mode: 'none',
      degraded: false,
      hits: [],
      superseded: [],
      versionSignals: [],
      unrankedDocuments: 0,
      note: 'No ServiceNow documentation is indexed. This is an EMPTY CORPUS, not an absence of '
        + 'documentation — nothing may be concluded from these zero results.',
    };
  }

  // Over-fetch: version preference removes rows AFTER ranking, so a limit
  // applied before it would return fewer than asked for.
  const fetchLimit = preferNewer ? Math.max(limit * 3, limit + 8) : limit;

  const avail = await embeddingsAvailable();
  let raw;
  let mode;
  let degraded = null;
  if (avail.ok) {
    await backfillKnowledgeEmbeddings();
    try {
      raw = await semanticSearchKnowledge(query, { limit: fetchLimit, filters });
      mode = 'semantic';
    } catch (err) {
      // The model vanished between the probe and the query.
      raw = keywordSearchKnowledge(query, { limit: fetchLimit, filters });
      mode = 'keyword';
      degraded = { reason: err.message, command: pullCommand() };
    }
  } else {
    raw = keywordSearchKnowledge(query, { limit: fetchLimit, filters });
    mode = 'keyword';
    degraded = { reason: avail.reason, command: avail.command };
  }

  const applied = preferNewer
    ? applyVersionPreference(raw, { releaseOrder: stats.releaseOrder })
    : { hits: raw, superseded: [], signals: [] };

  return {
    ...base,
    mode,
    model: mode === 'semantic' ? avail.model : undefined,
    degraded: degraded ? true : false,
    ...(degraded || {}),
    hits: applied.hits.slice(0, limit),
    superseded: applied.superseded.map((h) => ({ document: h.document, version: h.version, url: h.url })),
    versionSignals: applied.signals,
    unrankedDocuments: stats.unranked,
  };
}

/** Everything about one document, for a citation the user asked to see. */
export function getDocument(id) {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(id);
  if (!doc) return null;
  const chunks = db.prepare('SELECT seq, text FROM kb_chunks WHERE document = ? ORDER BY seq').all(id);
  return { ...doc, chunks };
}

export { UNVERSIONED };
