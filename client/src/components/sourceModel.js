/**
 * WHAT INFORMED THIS TURN, GROUPED — the client-side normaliser behind the
 * Sources panel.
 *
 * THE SERVER CONTRACT IS UNCHANGED. `GET /agent/plan/:taskId/evidence` returns
 * exactly what it always returned; this file is the only thing that knows how
 * that projection maps onto the three headings a reader actually wants. Nothing
 * here fetches, and nothing here invents: every item below is built from a
 * field the projection really carries, and a category with nothing in it comes
 * back empty rather than filled with a plausible-looking placeholder.
 *
 * WHY A NORMALISER AT ALL. The evidence projection is organised around *what
 * the agent did to the instance* — steps, changes, builds, tool events. The
 * Sources panel asks a different question: *what did this turn read?* The two
 * are related but not the same shape, so the mapping lives in one small file
 * that can be corrected in one place, rather than being spread through JSX.
 */

/**
 * The projection wraps some scalars as `{ value, source }` — see `item()` in
 * `server/src/agent/evidence/builder.js`, which produces `task.state` and
 * `task.planState` that way so a reader can tell which table a value came from.
 *
 * Rendering that wrapper straight into JSX is what threw
 * "Objects are not valid as a React child (found: object with keys
 * {value, source})": `ev.plan` is null for every plan-less turn, so
 * `ev.plan?.state ?? ev.task?.state` fell through to the wrapped object.
 * Everything that reaches JSX goes through here first.
 */
export function unwrap(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)
      && 'value' in v && 'source' in v) return v.value;
  return v;
}

/** Text for JSX. Anything that is still an object after unwrapping is refused
 *  rather than stringified into "[object Object]". */
export function asText(v) {
  const u = unwrap(v);
  if (u === null || u === undefined || u === '') return null;
  if (typeof u === 'string') return u;
  if (typeof u === 'number' || typeof u === 'boolean') return String(u);
  return null;
}

const DATE_FMT = { year: 'numeric', month: 'long', day: 'numeric' };
export function prettyDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, DATE_FMT);
}

const clip = (s, n = 160) => {
  const t = asText(s);
  if (!t) return null;
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The first http(s) URL in an arbitrary value, or null. Used to find document
 *  links inside step inputs and results without assuming a field name. */
function findUrl(value, depth = 0) {
  if (depth > 3 || value == null) return null;
  if (typeof value === 'string') {
    const m = value.match(/https?:\/\/[^\s"'<>)\]]+/);
    return m ? m[0] : null;
  }
  if (Array.isArray(value)) {
    for (const v of value) { const u = findUrl(v, depth + 1); if (u) return u; }
    return null;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) { const u = findUrl(v, depth + 1); if (u) return u; }
    return null;
  }
  return null;
}

export function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

/**
 * ONE DOCUMENT, ONE CARD. A retrieval returns CHUNKS, and six chunks of one
 * page are one source. The key is the strongest stable identity available:
 * the store's document id, else the canonical URL (scheme, host and path —
 * a fragment or a tracking query does not make a second document), else the
 * title. Exported so the provenance tests can hold the panel to it.
 */
export function docKey(h) {
  const doc = asText(h?.document);
  if (doc) return `doc:${doc}`;
  const url = asText(h?.url);
  if (url) {
    try { const u = new URL(url); return `url:${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`; }
    catch { return `url:${url.trim().toLowerCase()}`; }
  }
  const title = asText(h?.title) ?? asText(h?.topic);
  return title ? `title:${title.trim().toLowerCase()}` : null;
}

/* The read-only tools whose whole job is to consult a store. Naming them is a
   judgement about this app's own tool list, so it lives here in the open rather
   than being inferred from a substring match that would catch `create_record`
   the first time someone adds `record_search`. */
const MEMORY_TOOLS = new Set(['recall_memory']);

const TOOL_LABEL = {
  recall_memory: 'Recalled memory',
};

/* A build artifact's kind, as a short type tag — the same role the screenshot's
   "DOCX" chip plays. Unknown kinds keep their own name rather than a guess. */
function fileType(kind) {
  const k = asText(kind);
  if (!k) return 'FILE';
  return k.replace(/[_-]+/g, ' ').toUpperCase().slice(0, 14);
}

/**
 * Build the three categories from one evidence projection.
 *
 * Returns `[{ key, label, items }]` in a fixed order, always all three, so the
 * panel can render an honest "nothing here" for the empty ones.
 */
export function toSources(ev) {
  const chat = [];
  const docs = [];
  const files = [];
  if (!ev) return categories(chat, docs, files);

  const toolEvents = Array.isArray(ev.audit?.toolEvents) ? ev.audit.toolEvents : [];
  const steps = Array.isArray(ev.steps) ? ev.steps : [];
  const builds = Array.isArray(ev.builds) ? ev.builds : [];

  /* ── Chat Memory ──────────────────────────────────────────────────────
     The conversation this task belongs to is itself the first source: the
     request is the user's own words, and `request.source` says whether they
     were read from the task row or recovered from the transcript. */
  const askedFor = asText(ev.request?.text);
  if (askedFor) {
    const fromTranscript = asText(ev.request?.source) === 'transcript';
    chat.push({
      id: 'request',
      type: fromTranscript ? 'Past chat' : 'This conversation',
      title: clip(askedFor, 90),
      date: prettyDate(ev.task?.createdAt),
      snippet: clip(ev.request?.note ?? askedFor, 150),
      detail: askedFor,
      meta: ev.task?.session?.exists === false
        ? 'the conversation has since been deleted'
        : null,
    });
  }

  for (const e of toolEvents) {
    const name = asText(e.name);
    if (!name || !MEMORY_TOOLS.has(name)) continue;
    chat.push({
      id: `tool-${e.seq}`,
      type: TOOL_LABEL[name] ?? 'Recalled memory',
      title: name,
      date: prettyDate(e.at),
      snippet: `${asText(e.status) ?? 'ran'} · read from the recall store`,
      detail: null,
      meta: e.exact === false ? 'matched by time window, not by task id' : null,
    });
  }

  /* ── Online Docs ──────────────────────────────────────────────────────
     THE DOCUMENTS, not the searches.

     A tool event only records that a search RAN. The corpus can be empty — the
     search tool answers `indexed: 0, hits: []` and says so itself — and listing
     "ServiceNow docs" for that would tell a reader a document informed the
     answer when none did. So the item comes from the server's `retrieval`
     block, which the projection attaches ONLY when documents came back; a
     search that found nothing contributes nothing here.

     A ServiceNow answer the model produced from its own training is not a
     retrieval and has no row, so it correctly never appears. */
  /* CURRENT TURN ONLY. `ev` is one task's evidence and its tool events are
     the rows that name this task (or, for rows written before tasks were
     named, fall inside its window) — so every hit here was retrieved for
     THIS response. Nothing is read from earlier turns, and a corpus document
     that was not retrieved has no row to be read from. */
  const seenDoc = new Set();
  for (const e of toolEvents) {
    const hits = Array.isArray(e.retrieval?.hits) ? e.retrieval.hits : [];
    for (const h of hits) {
      const url = asText(h.url);
      const key = docKey(h);
      if (!key || seenDoc.has(key)) continue;
      seenDoc.add(key);
      docs.push({
        id: `doc-${e.seq}-${seenDoc.size}`,
        // The publisher as the source stated it; the host only when it did not.
        type: asText(h.source) ?? (url ? hostOf(url) : null) ?? 'Documentation',
        title: clip(h.title ?? h.topic ?? url, 90),
        date: prettyDate(h.updatedAt),
        snippet: clip(h.snippet, 150),
        detail: asText(h.snippet),
        url: url ?? undefined,
        meta: [asText(h.version), asText(h.documentType)].filter(Boolean).join(' · ') || null,
      });
    }
  }

  const seenUrl = new Set();
  for (const s of steps) {
    const url = findUrl(s.inputs) ?? findUrl(s.result);
    if (!url || seenUrl.has(url)) continue;
    seenUrl.add(url);
    docs.push({
      id: `url-${s.id ?? seenUrl.size}`,
      type: hostOf(url) ?? 'Link',
      title: url.replace(/^https?:\/\//, '').slice(0, 80),
      date: prettyDate(s.completedAt ?? s.startedAt),
      snippet: clip(s.operation ?? s.tool, 150),
      detail: null,
      url,
      meta: null,
    });
  }

  /* ── Files ────────────────────────────────────────────────────────────
     Build runs are the only file-backed artifacts this projection carries:
     each one is source this project wrote and, if it deployed, installed. */
  for (const b of builds) {
    files.push({
      id: `build-${b.id}`,
      type: fileType(b.kind),
      title: clip(b.label ?? b.id, 90),
      date: prettyDate(b.finished ?? b.started),
      snippet: clip(b.summary, 150),
      detail: asText(b.summary),
      meta: b.deployed ? 'installed on the instance' : asText(b.status),
    });
  }

  return categories(chat, docs, files);
}

function categories(chat, docs, files) {
  return [
    { key: 'memory', label: 'Chat Memory', items: chat },
    { key: 'docs', label: 'Online Docs', items: docs },
    { key: 'files', label: 'Files', items: files },
  ];
}
