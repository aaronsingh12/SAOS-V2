import { classifySourceUrl } from './sources.js';
import { log } from '../logging.js';

/**
 * K2b — FETCHING OFFICIAL SERVICENOW DOCUMENTATION, DETERMINISTICALLY.
 *
 * ingest.js says this module would not go on the internet, and gives the
 * reason: docs.servicenow.com is JavaScript-rendered, a naive fetch returns a
 * shell, and the tempting repair — have a model reconstruct the page it
 * half-received — manufactures citations nobody can audit afterwards. That
 * reasoning still stands. THIS FILE DOES NOT REPAIR ANYTHING.
 *
 * What it does instead is render the page the way a browser does and read the
 * text the browser produced. Measured, on the URL the operator supplies:
 *
 *   plain fetch   → 12,623 bytes, "Loading application…", zero article text
 *   rendered      → the article, in the FT-READER-TOPIC-CONTENT shadow root
 *
 * The documentation is a Fluid Topics client: the topic lives inside nested
 * shadow roots, which is why `document.body.innerText` is empty even after the
 * app has loaded. `deepText` below pierces them. Nothing is summarised,
 * paraphrased, completed or inferred — the stored text is exactly the
 * `innerText` the page rendered, and if the render produces nothing the URL is
 * REFUSED rather than filled in from anywhere else.
 *
 * NO NEW DEPENDENCY. It drives an already-installed Chrome over the DevTools
 * protocol using Node's own `fetch` and `WebSocket`. No puppeteer, no
 * playwright, nothing added to package.json.
 *
 * THE HOST IS CHECKED BEFORE THE FETCH, not after. A URL that
 * `classifySourceUrl` refuses is never even requested, so this cannot become a
 * general-purpose crawler by accident.
 */

const READY_SELECTOR = 'FT-READER-TOPIC-CONTENT';

/** Minimal CDP client over one page target. No dependency. */
async function connect(port) {
  const base = `http://127.0.0.1:${port}`;
  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    try {
      const list = await (await fetch(`${base}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* browser still coming up */ }
    if (!target) await new Promise((r) => setTimeout(r, 500));
  }
  if (!target) throw new Error(`no Chrome DevTools page target on port ${port}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('could not attach to Chrome')), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = seq += 1;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r?.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
    }
    return r?.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

/*
 * Read the rendered topic out of the shadow roots.
 *
 * Kept as a source string because it is evaluated in the page, not here. The
 * `@import` line is the topic stylesheet, which `textContent` picks up from the
 * shadow root's own <style>; it is stripped because it is markup, not prose.
 */
const EXTRACT = `(() => {
  function find(root, depth) {
    if (!root || depth > 12) return null;
    if (root.querySelectorAll) {
      for (const el of root.querySelectorAll('*')) {
        if (el.tagName === '${READY_SELECTOR}' && el.shadowRoot) return el.shadowRoot;
        if (el.shadowRoot) { const hit = find(el.shadowRoot, depth + 1); if (hit) return hit; }
      }
    }
    return null;
  }
  const topic = find(document, 0);
  if (!topic) return { ready: false };
  const host = topic.host;
  const raw = (host.innerText || topic.textContent || '');
  const text = raw
    .replace(/@import\\s+"[^"]*";?/g, '')
    .replace(/\\u00a0/g, ' ')
    .replace(/[ \\t]+/g, ' ')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
  const h1 = topic.querySelector('h1');
  return {
    ready: text.length > 400,
    title: (h1 && h1.textContent.trim()) || '',
    text,
    docTitle: document.title || '',
  };
})()`;

/** "Release version: Australia" → "Australia". */
function parseRelease(text, docTitle) {
  const m = /Release version:\s*([^\n]+?)\s*(?:Updated|\n|$)/i.exec(text);
  if (m) return m[1].trim();
  // The tab title carries it too: "Configure an ACL • Australia Platform security • Docs | ServiceNow"
  const t = /•\s*([A-Za-z][A-Za-z0-9 ]*?)\s+[A-Za-z]/.exec(String(docTitle || ''));
  return t ? t[1].trim() : null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * "Updated June 23, 2026" → "2026-06-23". Returns null rather than guessing.
 *
 * Assembled from the matched parts rather than via `new Date(...).toISOString()`,
 * which was measured turning June 23 into 2026-06-22: the string parses as local
 * midnight and toISOString converts to UTC, so every date west-shifts by a day
 * on any machine east of Greenwich. The page's own date is a metadata field a
 * reader may rely on; it must survive parsing exactly.
 */
function parseUpdated(text) {
  const m = /Updated\s+([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const day = Number(m[2]);
  if (day < 1 || day > 31) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The first path segment under /docs/r/ or /bundle/, as the topic. */
function parseTopic(url) {
  const m = /\/docs\/(?:r|bundle)\/([^/]+)/.exec(url);
  if (!m) return null;
  return m[1].replace(/^[a-z]+-/, '').replace(/-/g, ' ').trim() || null;
}

/**
 * Fetch one official documentation URL and return a corpus document.
 *
 * @returns {{ok:true, document:object}|{ok:false, url:string, reason:string}}
 */
export async function fetchDoc(cdp, url, { waitMs = 45000, documentType = 'documentation', product = 'Now Platform' } = {}) {
  // The host rule first. A refused URL is never requested.
  const cls = classifySourceUrl(url);
  if (!cls.ok) return { ok: false, url, reason: cls.reason };

  await cdp.send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 4000));
  // The consent banner overlays the reader until it is answered.
  await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button,a')]
    .find(x => /accept and proceed|accept all cookies/i.test(x.textContent || ''));
    if (b) b.click(); return true; })()`).catch(() => {});

  const deadline = Date.now() + waitMs;
  let out = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    // eslint-disable-next-line no-await-in-loop
    const r = await cdp.evaluate(EXTRACT);
    if (r?.ready) { out = r; break; }
  }
  if (!out) {
    return {
      ok: false,
      url,
      reason: 'the page did not render a topic within the timeout. Nothing is stored — the corpus '
        + 'never receives a partially-rendered page, and no text is reconstructed to fill the gap.',
    };
  }

  const version = parseRelease(out.text, out.docTitle);
  const updatedAt = parseUpdated(out.text);
  const title = out.title || String(out.docTitle || '').split('•')[0].trim();

  // Every required field must come from the page. Missing ones are reported,
  // never defaulted into something plausible.
  const missing = [];
  if (!title) missing.push('title');
  if (!version) missing.push('version (no "Release version:" on the page)');
  if (!updatedAt) missing.push('updated_at (no "Updated <date>" on the page)');
  if (missing.length) return { ok: false, url, reason: `page rendered but is missing: ${missing.join(', ')}` };

  log.info('knowledge', `fetched ${title} (${version}, updated ${updatedAt}) — ${out.text.length} chars`);
  return {
    ok: true,
    document: {
      source: 'servicenow-docs',
      product,
      topic: parseTopic(url) || 'platform',
      version,
      document_type: documentType,
      url,
      updated_at: updatedAt,
      title,
      text: out.text,
    },
  };
}

/** Fetch many, in order, over one browser session. */
export async function fetchDocs(urls, { port = 9222, ...opts } = {}) {
  const cdp = await connect(port);
  const documents = [];
  const refused = [];
  try {
    for (const url of urls) {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetchDoc(cdp, url, opts);
      if (r.ok) documents.push(r.document);
      else { refused.push({ url: r.url, reason: r.reason }); log.warn('knowledge', `refused ${r.url}: ${r.reason}`); }
    }
  } finally {
    cdp.close();
  }
  return { documents, refused };
}

export const _internals = { parseRelease, parseUpdated, parseTopic };
