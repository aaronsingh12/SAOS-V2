/**
 * Text shaping for attachments: normalise, chunk, rank. Pure — no I/O.
 *
 * Everything here exists to spend fewer tokens WITHOUT losing what the model
 * needs. Three moves do most of the work:
 *   1. normalise: collapse runs of spaces and blank lines, strip trailing
 *      whitespace. Extracted PDF text is full of both.
 *   2. de-furniture: a line that repeats on most pages of a PDF (a running
 *      header, a footer, "Page 3 of 40", a confidentiality notice) carries no
 *      information after its first appearance; it is kept once.
 *   3. rank: a large document is not sent whole. Chunks are scored against the
 *      user's own question (BM25) and the best are sent, with a way for the
 *      model to ask for more (read_attachment).
 */

import { estimateTextTokens } from '../memory/tokens.js';

export { estimateTextTokens };

export function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Drop lines that repeat across most pages (running headers and footers).
 * `pages` is an array of page texts. A line is furniture when it appears on at
 * least half the pages (and at least 3). Page-number lines ("Page 4 of 20",
 * "- 4 -", a bare number) are furniture whatever their count.
 */
export function stripPageFurniture(pages) {
  const PAGE_NO = /^(page\s*)?[-–—]?\s*\d+\s*([-–—]|(of|\/)\s*\d+)?\s*$/i;
  if (pages.length < 3) return pages.map((p) => p.split('\n').filter((l) => !PAGE_NO.test(l.trim())).join('\n'));
  /*
   * A line is compared EXACTLY, except a line that names a page ("Report —
   * Page 3"), whose numbers are folded so every page's copy matches. Folding
   * every line's digits was wrong: two table rows or body lines differing only
   * by a number ("Total 12" / "Total 15") would read as one repeated line and
   * be deleted as furniture.
   */
  // Only a line ENDING in a page reference is a running header/footer; prose
  // that merely mentions a page ("see page 12 for details") is content.
  const keyOf = (line) => (/\b(page|pg\.?)\s*\d+(\s*(of|\/)\s*\d+)?\s*$/i.test(line) ? line.replace(/\d+/g, '#') : line);
  const seen = new Map();
  for (const p of pages) {
    for (const line of new Set(p.split('\n').map((l) => keyOf(l.trim())).filter(Boolean))) {
      seen.set(line, (seen.get(line) || 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length / 2));
  const furniture = new Set([...seen].filter(([k, n]) => n >= threshold && k.length <= 120).map(([k]) => k));
  return pages.map((p) => p.split('\n')
    .filter((l) => {
      const t = l.trim();
      if (!t) return true;
      if (PAGE_NO.test(t)) return false;
      return !furniture.has(keyOf(t));
    })
    .join('\n'));
}

/**
 * Split into chunks of roughly `size` characters on paragraph boundaries.
 * Each chunk remembers its page (when the source has pages) so a quoted
 * passage can be located. A paragraph longer than the chunk is split on
 * sentence boundaries, then hard-cut as a last resort.
 */
export function chunkText(sections, size = 900) {
  const chunks = [];
  for (const { text, page = null } of sections) {
    const paras = normalizeText(text).split(/\n{2,}/);
    let buf = '';
    const flush = () => {
      if (buf.trim()) chunks.push({ i: chunks.length, page, text: buf.trim() });
      buf = '';
    };
    for (let p of paras) {
      while (p.length > size) {
        const cut = Math.max(p.lastIndexOf('. ', size), p.lastIndexOf('\n', size), Math.floor(size * 0.6));
        if (buf) flush();
        buf = p.slice(0, cut + 1);
        flush();
        p = p.slice(cut + 1).trim();
      }
      if ((buf + '\n\n' + p).length > size) flush();
      buf = buf ? `${buf}\n\n${p}` : p;
    }
    flush();
  }
  return chunks;
}

const STOP = new Set(('a an and are as at be by can could do does did for from has have how i if in into is it its '
  + 'me my of on or our please should so tell than that the their them then there these this those to was we '
  + 'what when where which who why will with would you your about above all any also attached attachment '
  + 'file document doc pdf image give show explain summarise summarize read see check').split(' '));

export function terms(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9_][a-z0-9_.-]*[a-z0-9_]|[a-z0-9]/g) || [])
    .filter((t) => !STOP.has(t) && t.length > 1);
}

/**
 * BM25 over the chunks. Returns chunk indices, best first, with scores.
 * An empty query (a question like "summarise this") yields no ranking; the
 * caller then samples the document instead.
 */
export function rankChunks(chunks, query, { k1 = 1.4, b = 0.75 } = {}) {
  const q = [...new Set(terms(query))];
  if (!q.length || !chunks.length) return [];
  const docs = chunks.map((c) => terms(c.text));
  const avg = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  const scored = docs.map((d, i) => {
    const tf = new Map();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avg));
    }
    return { i, score: s };
  });
  return scored.filter((x) => x.score > 0).sort((x, y) => y.score - x.score || x.i - y.i);
}

/**
 * An outline: headings when the text has them (markdown-style, numbered, or
 * short ALL-CAPS lines), otherwise the first line of a spread of chunks.
 * Bounded, because its job is orientation, not content.
 */
export function outlineOf(text, chunks, maxItems = 14) {
  const heads = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || t.length > 90) continue;
    if (/^#{1,4}\s+\S/.test(t) || /^(\d+(\.\d+)*)[.)]?\s+[A-Z]/.test(t) || (/^[A-Z0-9][A-Z0-9 &/:,-]{3,}$/.test(t) && /[A-Z]{3}/.test(t))) {
      heads.push(t.replace(/^#{1,4}\s+/, ''));
      if (heads.length >= maxItems) break;
    }
  }
  if (heads.length >= 3) return heads;
  const step = Math.max(1, Math.floor(chunks.length / maxItems));
  return chunks.filter((_, i) => i % step === 0).slice(0, maxItems)
    .map((c) => c.text.split('\n')[0].slice(0, 90));
}
