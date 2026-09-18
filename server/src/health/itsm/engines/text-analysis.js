import { REDACTED, recordFinding } from '../findings.js';
import { declareRequirement } from '../data-access.js';
import { fromSnowTime } from '../run-context.js';
import { result, preflight, STATUS, notePopulation } from './result.js';

/**
 * ENGINE 9 — Text Analysis.
 *
 * Normalisation, tokenisation, frequency of normalised values, pattern
 * matching with checksum validators, a text-read budget, and redaction-safe
 * evidence — the parts that are mechanical.
 *
 * THE SIMILARITY METRIC IS DECIDED (DECISIONS.md §1): TF-IDF cosine over
 * normalised text, fitted on the rule's own population. `createTfidfProvider`
 * implements it behind the `SimilarityProvider` seam; the workbook thresholds
 * (0.9, 0.85, 0.8) are applied by the caller and never chosen here.
 *
 * Pattern SETS (which regexes mean "PAN", "Aadhaar", "account number") are
 * rule configuration, not engine code; the engine supplies the matcher and the
 * two standard checksums the workbook alludes to (Luhn for card numbers,
 * Verhoeff for Aadhaar) as validators a pattern may name.
 */

export const ENGINE_KEY = 'text_analysis';
export const ENGINE_VERSION = '1.2.0';

export class TextAnalysisError extends Error {
  constructor(message) { super(message); this.name = 'TextAnalysisError'; }
}

/* ── normalisation and tokens ───────────────────────────────────────────── */

/**
 * Lower-case, collapse whitespace, strip punctuation, and replace runs of
 * digits with a placeholder so "INC0010037 rebooted 3 times" and
 * "INC0010052 rebooted 5 times" normalise to the same template — which is what
 * "template pasting" detection needs.
 */
export function normalise(text, { numbersAs = '#', keepNumbers = false } = {}) {
  let s = String(text ?? '').toLowerCase();
  if (!keepNumbers) s = s.replace(/\d+/g, numbersAs);
  s = s.replace(/[^\p{L}\p{N}#\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

export function tokenise(text, { minLength = 2, keepNumbers = false } = {}) {
  return normalise(text, { keepNumbers }).split(' ').filter((t) => t.length >= minLength);
}

/** Frequency of normalised values across rows: `[{ value, count, sys_ids }]`, largest first, at or above `minVolume`. */
export function frequency(rows, field, { minVolume = 2, normaliser = normalise } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const v = normaliser(r[field]);
    if (!v) continue;
    if (!groups.has(v)) groups.set(v, { value: v, count: 0, sys_ids: [] });
    const g = groups.get(v);
    g.count += 1;
    g.sys_ids.push(r.sys_id);
  }
  return [...groups.values()].filter((g) => g.count >= minVolume).sort((a, b) => b.count - a.count);
}

/* ── checksums and pattern matching ─────────────────────────────────────── */

/** Luhn (ISO/IEC 7812) — payment card numbers. */
export function luhn(digits) {
  const s = String(digits).replace(/\D/g, '');
  if (s.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    let d = Number(s[s.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Verhoeff — the checksum Aadhaar numbers carry. */
const V_D = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]];
const V_P = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]];
export function verhoeff(digits) {
  const s = String(digits).replace(/\D/g, '');
  if (!s.length) return false;
  let c = 0;
  const rev = [...s].reverse();
  for (let i = 0; i < rev.length; i++) c = V_D[c][V_P[i % 8][Number(rev[i])]];
  return c === 0;
}

export const CHECKSUMS = Object.freeze({ luhn, verhoeff });

/**
 * A pattern set: `[{ name, regex, checksum?: 'luhn'|'verhoeff' }]`. Matching
 * returns COUNTS AND LOCATIONS — never the matched text — with checksum-
 * validated and pattern-only hits reported separately, as ITSM-028 requires.
 */
export function matchPatterns(text, patterns) {
  const s = String(text ?? '');
  const out = [];
  for (const p of patterns) {
    if (!(p.regex instanceof RegExp)) throw new TextAnalysisError(`pattern "${p.name}" needs a RegExp`);
    if (p.checksum && !CHECKSUMS[p.checksum]) throw new TextAnalysisError(`pattern "${p.name}": unknown checksum "${p.checksum}"`);
    const re = new RegExp(p.regex.source, p.regex.flags.includes('g') ? p.regex.flags : `${p.regex.flags}g`);
    let validated = 0; let patternOnly = 0;
    for (const m of s.matchAll(re)) {
      if (p.checksum) { if (CHECKSUMS[p.checksum](m[0])) validated += 1; else patternOnly += 1; } else patternOnly += 1;
    }
    if (validated || patternOnly) out.push({ name: p.name, validated, pattern_only: patternOnly, checksum: p.checksum ?? null });
  }
  return out;
}

/** Scan rows × fields, returning per-location counts and never a value. */
export function scanRows(rows, fields, patterns) {
  const hits = [];
  for (const r of rows) {
    for (const f of fields) {
      if (!(f in r)) continue;
      const m = matchPatterns(r[f], patterns);
      if (m.length) hits.push({ sys_id: r.sys_id, field: f, matches: m, field_value: REDACTED });
    }
  }
  return hits;
}

/* ── similarity: DECISION 1 — TF-IDF cosine ─────────────────────────────── */

/**
 * A SimilarityProvider is `{ name, resolved: boolean, similarity(a, b) → 0…1 }`.
 * `UNRESOLVED_SIMILARITY` remains the safe default for a caller that has not
 * fitted a provider; the approved metric is `createTfidfProvider` below.
 */
export const UNRESOLVED_SIMILARITY = Object.freeze({
  name: 'UNRESOLVED',
  resolved: false,
  similarity() {
    throw new TextAnalysisError('UNRESOLVED: no similarity provider was fitted. DECISIONS.md §1 fixes the metric as TF-IDF cosine — fit createTfidfProvider() over the population before comparing.');
  },
});

export const TFIDF_COSINE = 'tfidf_cosine';

/** Tokens for TF-IDF: the normaliser keeps numbers off by default (identifier noise), then splits. */
const tfidfTokens = (text, opts) => tokenise(text, { minLength: 1, ...opts });

/**
 * DECISION 1 — TF-IDF cosine similarity on normalised text.
 *
 *   normalise (case, whitespace, punctuation, numbers → #) → tokenise
 *   → TF-IDF vectors over a fitted corpus → cosine.
 *
 * The corpus is the population the rule is about (every close_notes /
 * short_description in scope), so IDF reflects THIS estate's vocabulary. IDF
 * is smoothed — idf(t) = ln((N + 1) / (df(t) + 1)) + 1 — so a term unseen in
 * the corpus still counts rather than vanishing. TF is raw term frequency.
 * Thresholds are the workbook's and are applied by the caller; this module
 * never chooses one.
 */
export function createTfidfProvider(documents, { keepNumbers = false } = {}) {
  const N = documents.length;
  const df = new Map();
  for (const d of documents) {
    for (const t of new Set(tfidfTokens(d, { keepNumbers }))) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
  const vector = (text) => {
    const tf = new Map();
    for (const t of tfidfTokens(text, { keepNumbers })) tf.set(t, (tf.get(t) || 0) + 1);
    const v = new Map();
    let norm = 0;
    for (const [t, n] of tf) { const w = n * idf(t); v.set(t, w); norm += w * w; }
    return { v, norm: Math.sqrt(norm) };
  };
  const cosine = (a, b) => {
    if (!a.norm || !b.norm) return 0;
    let dot = 0;
    for (const [t, w] of a.v) { const w2 = b.v.get(t); if (w2) dot += w * w2; }
    return Number(Math.min(1, dot / (a.norm * b.norm)).toFixed(6));
  };
  return Object.freeze({
    name: TFIDF_COSINE,
    resolved: true,
    corpus_size: N,
    vocabulary: df.size,
    keepNumbers,
    vector,
    similarity: (a, b) => cosine(vector(a), vector(b)),
    /** Pre-vectorised comparison for clustering loops. */
    similarityOfVectors: cosine,
  });
}

export function validateProvider(p) {
  if (!p || typeof p.similarity !== 'function' || typeof p.name !== 'string') throw new TextAnalysisError('a SimilarityProvider needs a name and similarity(a, b)');
  if (!p.resolved) throw new TextAnalysisError(`similarity provider "${p.name}" is not resolved`);
  return p;
}

/** Pairwise similarity for one record's two fields (ITSM-021 / 070 shape). */
export function similar(a, b, provider, threshold) {
  const p = validateProvider(provider);
  if (!Number.isFinite(threshold)) throw new TextAnalysisError('similar() needs the rule threshold — none is invented here');
  const score = p.similarity(String(a ?? ''), String(b ?? ''));
  return { score, similar: score >= threshold, provider: p.name, threshold };
}

/**
 * Blocked clustering: within each block (a category, a caller) items are
 * greedily grouped with the first cluster whose representative is at least
 * `threshold` similar. O(n·k) per block instead of O(n²) over the table.
 */
export function clusterBy(items, { text, block = () => '', provider, threshold, minSize = 2 }) {
  const p = validateProvider(provider);
  const blocks = new Map();
  for (const it of items) {
    const b = block(it);
    if (!blocks.has(b)) blocks.set(b, []);
    blocks.get(b).push(it);
  }
  if (!Number.isFinite(threshold)) throw new TextAnalysisError('clusterBy() needs the rule threshold — none is invented here');
  const clusters = [];
  const vec = p.vector ? (t) => p.vector(t) : null;
  const sim = vec ? (a, b) => p.similarityOfVectors(a, b) : (a, b) => p.similarity(a, b);
  for (const [b, list] of blocks) {
    const local = [];
    for (const it of list) {
      const raw = String(text(it) ?? '');
      if (!normalise(raw)) continue;
      const t = vec ? vec(raw) : raw;
      const home = local.find((c) => sim(c.representative_vec, t) >= threshold);
      if (home) home.members.push(it); else local.push({ block: b, representative: it, representative_text: raw, representative_vec: t, members: [it] });
    }
    clusters.push(...local.filter((c) => c.members.length >= minSize));
  }
  return clusters.sort((a, b2) => b2.members.length - a.members.length).map((c) => ({ block: c.block, representative: c.representative, size: c.members.length, members: c.members, provider: p.name, threshold }));
}

/* ── the read budget ────────────────────────────────────────────────────── */

/**
 * Text is the heaviest data the ITSM check would pull. A budget bounds it and
 * makes the bound VISIBLE: `take()` admits rows until the character budget is
 * spent and reports `sampled: true` with the counts, so a finding built on a
 * partial read says so instead of looking complete.
 */
export function createTextBudget({ maxChars = 20_000_000 } = {}) {
  let used = 0; let admitted = 0; let refused = 0;
  return Object.freeze({
    take(rows, fields) {
      const kept = [];
      for (const r of rows) {
        const size = fields.reduce((n, f) => n + String(r[f] ?? '').length, 0);
        if (used + size > maxChars) { refused += 1; continue; }
        used += size; admitted += 1; kept.push(r);
      }
      return { rows: kept, sampled: refused > 0, admitted, refused, chars: used, max_chars: maxChars };
    },
    usage: () => ({ chars: used, admitted, refused, max_chars: maxChars }),
  });
}

/* ── engine contract ─────────────────────────────────────────────────────── */

/**
 * `rule.config` — one of four operations over one table's text:
 *
 *   similarity    { table, scope, fields: [a, b], threshold, min_length?, length_field?, evidence_fields[] }
 *                 per record, TF-IDF cosine between two of its fields (fitted on the
 *                 population's texts); offends at or above `threshold` — or, with
 *                 `min_length`, when `length_field` (default b) is shorter than it.
 *   cluster       { table, scope, text_field, block_field?, threshold, min_size, top_n?, require_no_link?, rank_by?, evidence_fields[] }
 *                 blocked greedy clustering; a cluster offends when it has `min_size`
 *                 members and (with `require_no_link`) none of them links.
 *                 `rank_by: 'resolution_effort'` orders by Σ(resolved_at − sys_created_on).
 *   frequency     { table, scope, field, volume_share, evidence_fields[] }
 *                 identical normalised values reaching `volume_share` % of the slice.
 *   pattern_scan  { table, scope, fields[], patterns: [{ name, regex, flags?, checksum? }] }
 *                 identifier patterns; evidence is COUNT and LOCATION only.
 *
 * Every read goes through the run's text budget (`ctx.shared 'text_budget'`);
 * a sampled read is recorded on the result and every kpi built on it says
 * `complete: false`.
 */

const usable = (cov) => ['complete', 'limited', 'truncated'].includes(cov?.status);

const budgetFor = (ctx, maxChars) => ctx.shared.getOrBuild('text_budget', () => createTextBudget({ maxChars }));

async function readText(ctx, c, fields) {
  const req = declareRequirement({ table: c.table, fields: [...new Set([...fields, ...(c.evidence_fields || [])])], query: c.scope || '', strategy: 'rows', sensitive: c.sensitive || [], maxRows: c.max_rows });
  const { rows, coverage } = await ctx.reads.read(req);
  if (!usable(coverage)) return { rows: [], coverage, unavailable: `${c.table} could not be read (${coverage.status})` };
  const budget = await budgetFor(ctx, c.max_chars ?? 20_000_000);
  const taken = budget.take(rows, fields);
  return { rows: taken.rows, coverage, sampled: taken.sampled, admitted: taken.admitted, refused: taken.refused };
}

function finding(rule, c, ctx, records, fields, titleSuffix = '') {
  return recordFinding({
    rule, table: c.table, records, fields, title: `${c.title || rule.title}${titleSuffix}`, description: c.description || rule.whatItMeans,
    severity: c.severity || rule.base, confidence: c.confidence ?? 1.0, recommendation: c.recommendation ?? null, collected_at: ctx.run.run_started_at, sensitive: c.sensitive || [],
  });
}

/** The text population: rows in scope (those refused by the character budget included), and how many were judged. */
const textPopulation = (c, read, judged) => ({ total: read.rows.length + (read.refused || 0), judged, unit: `${c.table} records`, basis: `${c.table}${c.scope ? ` where ${c.scope}` : ''}` });

const compiledPatterns = (patterns) => patterns.map((q) => ({ ...q, regex: q.regex instanceof RegExp ? q.regex : new RegExp(q.regex, q.flags ?? '') }));

export const engine = Object.freeze({
  key: ENGINE_KEY,
  name: 'Text Analysis Engine',
  version: ENGINE_VERSION,
  canEvaluate: (rule) => rule?.architecture?.engine === ENGINE_KEY || rule?.architecture?.also_requires?.includes(ENGINE_KEY),
  prepare: async () => undefined,
  async evaluate(rule, ctx) {
    const c = rule.config;
    const textFields = c ? (c.operation === 'similarity' ? c.fields : c.operation === 'cluster' ? [c.text_field] : c.operation === 'frequency' ? [c.field] : c.operation === 'pattern_scan' ? c.fields : []) : [];
    const gate = await preflight(rule, ENGINE_KEY, ctx, {
      requiredCapabilities: c ? [() => ctx.probes.fieldsExist(c.table, textFields)] : [],
      requiredParameters: c?.required_parameters || [],
    });
    if (gate) return gate;
    const out = result(rule, ENGINE_KEY, { parameters: ctx.parametersFor(rule.id) });
    const need = (k) => { if (c[k] === undefined || c[k] === null) throw new TextAnalysisError(`${rule.id}: ${c.operation} needs ${k}`); return c[k]; };

    if (c.operation === 'similarity') {
      const [a, b] = need('fields');
      const threshold = need('threshold');
      const read = await readText(ctx, c, [a, b]);
      out.coverage.push(read.coverage);
      if (read.unavailable) { out.status = STATUS.UNAVAILABLE; out.skipped.push({ rule: rule.id, table: c.table, reason: read.unavailable }); return out; }
      const rows = read.rows.filter((r) => a in r && b in r);
      const provider = createTfidfProvider(rows.flatMap((r) => [r[a], r[b]]), { keepNumbers: c.keep_numbers ?? false });
      const offenders = []; let unevaluable = read.rows.length - rows.length;
      for (const r of rows) {
        const lengthField = c.length_field ?? b;
        const short = c.min_length != null && String(r[lengthField] ?? '').trim().length < c.min_length;
        if (!normalise(r[a]) || !normalise(r[b])) { if (short) offenders.push(r); else unevaluable += 1; continue; }
        const sim = similar(r[a], r[b], provider, threshold);
        if (sim.similar || short) offenders.push({ ...r, similarity: sim.score });
      }
      if (unevaluable) out.skipped.push({ rule: rule.id, table: c.table, reason: 'rows with a hidden or empty text field could not be compared', excluded_records: unevaluable });
      if (offenders.length) out.findings.push(finding(rule, c, ctx, offenders, [...(c.evidence_fields || []), 'similarity']));
      const evaluated = rows.length;
      /* EMPTY POPULATION (Phase 5 closure): judged = rows whose text could be compared (or offended on length). */
      notePopulation(out, textPopulation(c, read, read.rows.length - unevaluable));
      out.kpis.push({ rule_id: rule.id, numerator: evaluated - offenders.length, denominator: evaluated, pass_pct: evaluated ? Number((100 * (1 - offenders.length / evaluated)).toFixed(1)) : null, basis: `${provider.name} ${a} vs ${b} ≥ ${threshold}${c.min_length != null ? ` or ${c.length_field ?? b} < ${c.min_length}` : ''}`, complete: !read.sampled });
      out.text = { provider: provider.name, corpus_size: provider.corpus_size, vocabulary: provider.vocabulary, sampled: read.sampled, admitted: read.admitted, refused: read.refused };
      return out;
    }

    if (c.operation === 'cluster') {
      const field = need('text_field');
      const threshold = need('threshold');
      const minSize = need('min_size');
      const extra = [c.block_field, c.require_no_link, ...(c.rank_by === 'resolution_effort' ? ['resolved_at', 'sys_created_on'] : [])].filter(Boolean);
      const read = await readText(ctx, c, [field]);
      out.coverage.push(read.coverage);
      if (read.unavailable) { out.status = STATUS.UNAVAILABLE; out.skipped.push({ rule: rule.id, table: c.table, reason: read.unavailable }); return out; }
      if (extra.length) {
        /* the non-text columns the clustering blocks / links / ranks on, on the same read */
        const more = await ctx.reads.read(declareRequirement({ table: c.table, fields: [...new Set([...extra, ...(c.evidence_fields || [])])], query: c.scope || '', strategy: 'rows' }));
        out.coverage.push(more.coverage);
        if (!usable(more.coverage)) { out.status = STATUS.UNAVAILABLE; out.skipped.push({ rule: rule.id, table: c.table, reason: `${c.table} could not be read (${more.coverage.status})` }); return out; }
        const by = new Map(more.rows.map((r) => [r.sys_id, r]));
        for (const r of read.rows) Object.assign(r, by.get(r.sys_id) || {});
      }
      const provider = createTfidfProvider(read.rows.map((r) => r[field]), { keepNumbers: c.keep_numbers ?? false });
      let clusters = clusterBy(read.rows, { text: (r) => r[field], block: c.block_field ? (r) => String(r[c.block_field] ?? '') : () => '', provider, threshold, minSize });
      if (c.require_no_link) clusters = clusters.filter((cl) => !cl.members.some((m) => m[c.require_no_link] != null && String(m[c.require_no_link]).trim() !== ''));
      if (c.rank_by === 'resolution_effort') {
        const effort = (cl) => cl.members.reduce((sum, m) => { const a = fromSnowTime(m.sys_created_on); const b = fromSnowTime(m.resolved_at); return sum + (a && b ? Math.max(0, b - a) : 0); }, 0);
        clusters = clusters.map((cl) => ({ ...cl, effort_ms: effort(cl) })).sort((x, y) => y.effort_ms - x.effort_ms);
      }
      if (c.top_n != null) clusters = clusters.slice(0, c.top_n);
      out.clusters = clusters;
      notePopulation(out, textPopulation(c, read, read.rows.length));
      for (const cl of clusters) out.findings.push(finding(rule, c, ctx, cl.members, c.evidence_fields || [], ` — cluster of ${cl.size}${cl.block ? ` (${c.block_field}=${cl.block})` : ''}`));
      out.kpis.push({ rule_id: rule.id, numerator: clusters.reduce((n, cl) => n + cl.size, 0), denominator: read.rows.length, pass_pct: null, basis: `${clusters.length} cluster(s) at ${provider.name} ≥ ${threshold}, size ≥ ${minSize}`, complete: !read.sampled });
      out.text = { provider: provider.name, corpus_size: provider.corpus_size, vocabulary: provider.vocabulary, sampled: read.sampled, admitted: read.admitted, refused: read.refused };
      return out;
    }

    if (c.operation === 'frequency') {
      const field = need('field');
      const share = need('volume_share');
      const read = await readText(ctx, c, [field]);
      out.coverage.push(read.coverage);
      if (read.unavailable) { out.status = STATUS.UNAVAILABLE; out.skipped.push({ rule: rule.id, table: c.table, reason: read.unavailable }); return out; }
      const total = read.rows.length;
      const freq = frequency(read.rows, field, { minVolume: c.min_volume ?? 2 });
      const byId = new Map(read.rows.map((r) => [r.sys_id, r]));
      const hits = freq.map((f) => ({ ...f, share: total ? Number((100 * f.count / total).toFixed(1)) : null })).filter((f) => f.share != null && f.share >= share);
      notePopulation(out, textPopulation(c, read, total));
      out.frequency = hits.map((f) => ({ value: f.value.slice(0, 120), count: f.count, share: f.share }));
      for (const f of hits) out.findings.push(finding(rule, c, ctx, f.sys_ids.map((id) => byId.get(id)), c.evidence_fields || [], ` — ${f.count} identical (${f.share}%)`));
      out.kpis.push({ rule_id: rule.id, numerator: total - hits.reduce((n, f) => n + f.count, 0), denominator: total, pass_pct: total ? Number((100 * (1 - hits.reduce((n, f) => n + f.count, 0) / total)).toFixed(1)) : null, basis: `identical ${field} values at ≥ ${share}% of ${total}`, complete: !read.sampled });
      out.text = { sampled: read.sampled, admitted: read.admitted, refused: read.refused };
      return out;
    }

    if (c.operation === 'pattern_scan') {
      const fields = need('fields');
      const patterns = compiledPatterns(need('patterns'));
      const read = await readText(ctx, { ...c, sensitive: fields }, fields);
      out.coverage.push(read.coverage);
      if (read.unavailable) { out.status = STATUS.UNAVAILABLE; out.skipped.push({ rule: rule.id, table: c.table, reason: read.unavailable }); return out; }
      /* A checksummed pattern counts only matches whose checksum holds — the workbook's own false-positive guard. */
      const counted = (m) => (m.checksum ? m.validated : m.pattern_only);
      const hits = scanRows(read.rows, fields, patterns).map((h) => ({ ...h, matches: h.matches.filter((m) => counted(m) > 0) })).filter((h) => h.matches.length);
      const byId = new Map(read.rows.map((r) => [r.sys_id, r]));
      const perPattern = {};
      for (const h of hits) for (const m of h.matches) perPattern[m.name] = (perPattern[m.name] || 0) + counted(m);
      notePopulation(out, textPopulation(c, read, read.rows.length));
      out.pattern_hits = { records: new Set(hits.map((h) => h.sys_id)).size, by_pattern: perPattern, by_field: Object.fromEntries(fields.map((f) => [f, hits.filter((h) => h.field === f).length])) };
      if (hits.length) {
        const records = [...new Set(hits.map((h) => h.sys_id))].map((id) => ({ sys_id: id, ...Object.fromEntries((c.evidence_fields || []).map((f) => [f, byId.get(id)?.[f]])), matched: hits.filter((h) => h.sys_id === id).map((h) => `${h.field}: ${h.matches.map((m) => m.name).join(', ')}`).join('; ') }));
        out.findings.push(finding(rule, { ...c, sensitive: fields }, ctx, records, [...(c.evidence_fields || []), 'matched']));
      }
      out.kpis.push({ rule_id: rule.id, numerator: read.rows.length - out.pattern_hits.records, denominator: read.rows.length, pass_pct: read.rows.length ? Number((100 * (1 - out.pattern_hits.records / read.rows.length)).toFixed(1)) : null, basis: `${patterns.map((q) => q.name).join(', ')} over ${fields.join(', ')}`, complete: !read.sampled });
      out.text = { sampled: read.sampled, admitted: read.admitted, refused: read.refused };
      return out;
    }

    throw new TextAnalysisError(`${rule.id}: unknown text operation "${c.operation}"`);
  },
});
