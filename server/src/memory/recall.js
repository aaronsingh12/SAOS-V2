import { getDb } from './db.js';
import { getSettings } from '../config/store.js';
import { currentInstance } from './facts.js';

/**
 * A-5 — semantic recall, free and local.
 *
 * Embeddings come from a local Ollama embedding model through the SAME baseUrl
 * the chat provider uses, so there is one thing to configure and one thing to
 * swap. Vectors are float32 blobs in SQLite and cosine similarity is brute
 * force in JS — at a few thousand chunks that is microseconds, and it keeps the
 * whole feature dependency-free.
 *
 * Graceful degradation is the load-bearing part. If the embedding model is not
 * pulled, recall falls back to SQLite FTS5 keyword search and SAYS SO, with the
 * exact `ollama pull` command. It does NOT quietly return worse results and let
 * the user believe they are semantic — that is the silent-fallback failure this
 * project keeps designing against.
 *
 * Endpoint note, verified rather than assumed: Ollama exposes BOTH
 * `POST /api/embed` (native, `{model, input}`, accepts an array) and
 * `POST /v1/embeddings` (OpenAI-compatible). Both exist on 0.32.14 here. The
 * native one is used because it takes a batch directly. When the model is
 * missing they fail differently — `{"error": "..."}` vs
 * `{"error": {"message": "..."}}` — which is why the probe reads both shapes.
 */

const DEFAULT_EMBED_MODEL = 'nomic-embed-text';

function embedBase() {
  const { llm } = getSettings();
  const base = (llm.baseUrl || 'http://localhost:11434/v1').replace(/\/$/, '');
  // The native embed endpoint sits next to /v1, not inside it.
  return base.replace(/\/v1$/, '');
}

export function embedModelName() {
  return getSettings().llm.embedModel || DEFAULT_EMBED_MODEL;
}

export function pullCommand() {
  return `ollama pull ${embedModelName()}`;
}

/* ------------------------------------------------------------------ *
 * Embedding backend
 * ------------------------------------------------------------------ */

let availability = { checked: 0, value: null };
const AVAILABILITY_TTL_MS = 60_000;

/**
 * Is the embedding model actually pulled? Cached briefly — this is on the read
 * path of every search and a cold Ollama call costs a round trip.
 */
export async function embeddingsAvailable({ force = false } = {}) {
  if (!force && availability.value && Date.now() - availability.checked < AVAILABILITY_TTL_MS) {
    return availability.value;
  }
  const model = embedModelName();
  let value;
  try {
    const vecs = await embed(['probe']);
    value = { ok: true, model, dim: vecs[0]?.length ?? 0, reason: null, command: null };
  } catch (err) {
    value = {
      ok: false,
      model,
      dim: 0,
      reason: err.message,
      command: pullCommand(),
    };
  }
  availability = { checked: Date.now(), value };
  return value;
}

/** Batch-embed. Throws with a usable message when the model is not pulled. */
export async function embed(inputs) {
  const model = embedModelName();
  const url = `${embedBase()}/api/embed`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: inputs }),
    });
  } catch (err) {
    throw new Error(`Cannot reach Ollama at ${embedBase()} — ${err.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    // Both error shapes: native is a string, the /v1 shim wraps it in an object.
    const raw = typeof data?.error === 'string' ? data.error : data?.error?.message;
    throw new Error(raw || `Embedding request failed (${res.status})`);
  }
  const vecs = data?.embeddings || (data?.embedding ? [data.embedding] : null);
  if (!Array.isArray(vecs) || !vecs.length) throw new Error('Embedding response contained no vectors.');
  return vecs;
}

/*
 * float32 <-> BLOB. Exported because the knowledge store (K1) keeps its own
 * vectors in its own table and must encode them IDENTICALLY — two encoders for
 * one format is how a dimension mismatch becomes a silently meaningless cosine
 * score rather than an error.
 */
export const toBlob = (vec) => {
  const f = new Float32Array(vec);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
};

export const fromBlob = (blob) => {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  // Copy rather than aliasing: the source may not be 4-byte aligned.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
};

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ------------------------------------------------------------------ *
 * Indexing
 * ------------------------------------------------------------------ */

/** Long turns are split so one rambling message cannot dominate a search. */
export function chunkText(text, size = 1200) {
  const flat = String(text || '').trim();
  if (flat.length <= size) return flat ? [flat] : [];
  const out = [];
  const paras = flat.split(/\n{2,}/);
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > size) { out.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Store a message for recall. FTS is populated immediately by trigger, so
 * keyword search works with no embedding model at all; vectors are filled in
 * lazily by `backfillEmbeddings` so a slow or missing embed call can never
 * block or fail a chat turn.
 */
export function indexMessage(sessionId, seq, role, text) {
  const body = String(text || '').trim();
  if (!body) return 0;
  const db = getDb();
  const inst = currentInstance();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO chunks (kind, session, ref, instance, text, ts)
     VALUES ('message', ?, ?, ?, ?, ?)`
  );
  const parts = chunkText(`${role}: ${body}`);
  parts.forEach((part, i) => {
    stmt.run(sessionId, `${seq}.${i}`, inst, part, new Date().toISOString());
  });
  return parts.length;
}

/** Ledger facts are searchable too — "what did we decide about X" spans both. */
export function indexFact(fact) {
  if (!fact?.id) return 0;
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO chunks (kind, session, ref, instance, text, ts)
       VALUES ('fact', NULL, ?, ?, ?, ?)`
    )
    .run(String(fact.id), fact.instance, `[${fact.kind}] ${fact.key}: ${fact.value}`, new Date().toISOString());
  return 1;
}

/**
 * Embed whatever is not embedded yet. Called opportunistically; a failure here
 * is reported, never thrown into a chat turn — the FTS path still works.
 */
export async function backfillEmbeddings({ limit = 128 } = {}) {
  const db = getDb();
  const model = embedModelName();
  const pending = db
    .prepare(
      `SELECT c.id, c.text FROM chunks c
        LEFT JOIN embeddings e ON e.chunk = c.id AND e.model = ?
       WHERE e.chunk IS NULL
       LIMIT ?`
    )
    .all(model, limit);
  if (!pending.length) return { embedded: 0, pending: 0, ok: true };

  try {
    const vecs = await embed(pending.map((p) => p.text));
    const stmt = db.prepare('INSERT OR REPLACE INTO embeddings (chunk, model, dim, vec) VALUES (?, ?, ?, ?)');
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
      .prepare(`SELECT COUNT(*) AS n FROM chunks c LEFT JOIN embeddings e ON e.chunk = c.id AND e.model = ? WHERE e.chunk IS NULL`)
      .get(model).n;
    return { embedded: pending.length, pending: left, ok: true };
  } catch (err) {
    return { embedded: 0, pending: pending.length, ok: false, error: err.message, command: pullCommand() };
  }
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

/**
 * Words that carry no retrieval signal. A natural-language question is mostly
 * these — "what did we decide about vendor-hold incidents?" is 5 stopwords and
 * 3 real terms — and leaving them in lets a session match on "we" and "about".
 * Measured: with them included, the wrong session won the acceptance query.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing', 'done',
  'have', 'has', 'had', 'having', 'will', 'would', 'shall', 'should', 'can', 'could', 'may',
  'might', 'must', 'i', 'we', 'you', 'he', 'she', 'it', 'they', 'me', 'us', 'him', 'her', 'them',
  'my', 'our', 'your', 'his', 'its', 'their', 'what', 'which', 'who', 'whom', 'whose', 'when',
  'where', 'why', 'how', 'about', 'for', 'with', 'from', 'into', 'onto', 'to', 'of', 'in', 'on',
  'at', 'by', 'as', 'so', 'up', 'out', 'over', 'under', 'again', 'there', 'here', 'all', 'any',
  'some', 'no', 'not', 'only', 'own', 'same', 'too', 'very', 'just', 'now', 'also', 'please',
  'tell', 'show', 'give', 'get', 'make', 'let',
]);

/** FTS5 MATCH syntax is not free text — quote every term so a query cannot throw. */
export function toFtsQuery(q) {
  const all = String(q || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length > 1);
  // Keep the content words; fall back to the raw terms if the question was
  // nothing BUT stopwords, so a query still does something rather than nothing.
  const content = all.filter((t) => !STOPWORDS.has(t));
  const terms = content.length ? content : all;
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"`).join(' OR ');
}

/**
 * The degraded path, exported so it can be tested deterministically. Whether
 * `search()` reaches it depends on whether an embedding model happens to be
 * pulled on this machine, which is not something a test should depend on.
 */
export function keywordSearch(query, { limit = 8, sessionId = null } = {}) {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const db = getDb();
  const sql = `
    SELECT c.id, c.kind, c.session, c.ref, c.text, c.ts, bm25(chunks_fts) AS score
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
     WHERE chunks_fts MATCH ?
       ${sessionId ? 'AND c.session = ?' : ''}
     ORDER BY score
     LIMIT ?`;
  const args = sessionId ? [fts, sessionId, limit] : [fts, limit];
  try {
    // SQLite's bm25() returns a NEGATIVE number, and a better match is MORE
    // negative. Negating it is the whole conversion to higher-is-better.
    //
    // The first version used `1 / (1 + Math.abs(score))`, which inverted the
    // ranking: the best match (most negative) came out with the LOWEST score,
    // so searchSessions — which sorts descending — returned the worst matches
    // first. The acceptance query put the right session dead last. `Math.abs`
    // on a value whose sign carries the meaning is how that happened.
    return db.prepare(sql).all(...args).map((r) => ({ ...r, score: -r.score }));
  } catch {
    return [];
  }
}

async function semanticSearch(query, { limit, sessionId }) {
  const db = getDb();
  const model = embedModelName();
  const [qvec] = await embed([query]);
  const rows = db
    .prepare(
      `SELECT c.id, c.kind, c.session, c.ref, c.text, c.ts, e.vec, e.dim
         FROM embeddings e JOIN chunks c ON c.id = e.chunk
        WHERE e.model = ? ${sessionId ? 'AND c.session = ?' : ''}`
    )
    .all(...(sessionId ? [model, sessionId] : [model]));

  const scored = [];
  for (const r of rows) {
    // A dimension mismatch means the embedding model changed under us. Skipping
    // is right: comparing across models yields a meaningless number that would
    // look exactly like a real score.
    if (r.dim !== qvec.length) continue;
    scored.push({ ...r, vec: undefined, score: cosine(qvec, fromBlob(r.vec)) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Recall across messages and ledger facts.
 *
 * Always reports which MODE produced the results. A caller that shows keyword
 * hits as if they were semantic is lying by omission, and the UI banner depends
 * on this field.
 */
export async function search(query, { limit = 8, sessionId = null } = {}) {
  const avail = await embeddingsAvailable();
  if (avail.ok) {
    // Embed anything new before searching, so a message from ten seconds ago is
    // findable rather than mysteriously absent.
    await backfillEmbeddings();
    try {
      const hits = await semanticSearch(query, { limit, sessionId });
      return { mode: 'semantic', model: avail.model, degraded: false, hits };
    } catch (err) {
      // The model vanished between the probe and the query.
      return {
        mode: 'keyword',
        degraded: true,
        reason: err.message,
        command: pullCommand(),
        hits: keywordSearch(query, { limit, sessionId }),
      };
    }
  }
  return {
    mode: 'keyword',
    degraded: true,
    reason: avail.reason,
    command: avail.command,
    hits: keywordSearch(query, { limit, sessionId }),
  };
}

/** Sessions matching a query, for the rail's search box. */
export async function searchSessions(query, { limit = 20 } = {}) {
  const res = await search(query, { limit: limit * 4 });
  const db = getDb();
  const bySession = new Map();
  for (const h of res.hits) {
    if (!h.session) continue;
    const cur = bySession.get(h.session);
    if (!cur || h.score > cur.score) bySession.set(h.session, { score: h.score, snippet: h.text.slice(0, 240) });
  }
  const out = [];
  for (const [id, { score, snippet }] of bySession) {
    const row = db.prepare('SELECT id, title, created, updated FROM sessions WHERE id = ?').get(id);
    if (row) out.push({ ...row, score, snippet });
  }
  out.sort((a, b) => b.score - a.score);
  return { ...res, hits: undefined, sessions: out.slice(0, limit) };
}
