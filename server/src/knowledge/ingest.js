import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings } from '../config/store.js';
import { upsertDocument, planDocument, reindexVersionRanks, backfillKnowledgeEmbeddings } from './store.js';
import { REQUIRED_METADATA, DOCUMENT_TYPES } from './schema.js';
import { sourcePolicy, OFFICIAL_DOMAIN } from './sources.js';
import { log } from '../logging.js';

/**
 * K2 — getting ServiceNow documentation into the corpus.
 *
 * THIS MODULE DOES NOT GO ON THE INTERNET, and that is a design decision rather
 * than a missing feature.
 *
 * The instruction that shaped it is "do not invent documentation or URLs". A
 * crawler is the obvious way to fill a documentation index and also the fastest
 * way to violate that: docs.servicenow.com is JavaScript-rendered and
 * paginated, so a naive fetch returns a shell, and the tempting repair — have
 * the model reconstruct the page it half-received, or synthesise the URL it
 * believes a topic lives at — produces a corpus of plausible citations that
 * nobody can distinguish from real ones after the fact. A wrong citation in
 * this system is worse than a missing one, because the agent will repeat it to
 * a user with the authority of a source.
 *
 * So documents arrive from a directory the operator fills, by whatever means
 * they trust: an official export, a licensed download, a scrape they ran and
 * checked. Every one is validated (knowledge/schema.js) and refused unless it
 * carries all seven metadata fields and a real URL.
 *
 * FILE FORMATS, both dependency-free:
 *
 *   *.json   one document object, or an array of them. Metadata at the top
 *            level, body in `text`.
 *   *.md     a `---` delimited frontmatter of flat `key: value` lines, then the
 *            body. Deliberately NOT YAML — this parser handles flat scalars and
 *            nothing else, and says so rather than pulling in a parser whose
 *            edge cases would be one more thing that can silently mis-read a
 *            source.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS_DIR = path.resolve(__dirname, '../../data/knowledge');

export function corpusDir() {
  const configured = getSettings().rag?.corpusDir;
  return configured ? path.resolve(configured) : DEFAULT_CORPUS_DIR;
}

/**
 * Frontmatter, for the flat scalar case only.
 *
 * Refuses rather than half-understands: a line that is not `key: value` inside
 * the fence is reported, because silently skipping it is how a document ends up
 * indexed with the wrong release.
 */
export function parseFrontmatter(raw) {
  const text = String(raw || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { ok: false, errors: ['no --- frontmatter block at the top of the file'] };

  const meta = {};
  const errors = [];
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      errors.push(`frontmatter line is not "key: value": ${line.trim().slice(0, 80)}`);
      continue;
    }
    // Strip one layer of matching quotes; anything more structured than that is
    // outside what this parser claims to handle.
    meta[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, meta, body: m[2] };
}

/** Every document in one file, or the reasons it could not be read. */
export function readCorpusFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, errors: [`cannot read ${file}: ${err.message}`] };
  }

  if (file.endsWith('.json')) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) {
      return { ok: false, errors: [`${path.basename(file)} is not valid JSON: ${err.message}`] };
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return { ok: true, documents: list };
  }

  if (file.endsWith('.md') || file.endsWith('.markdown')) {
    const fm = parseFrontmatter(raw);
    if (!fm.ok) return { ok: false, errors: fm.errors.map((e) => `${path.basename(file)}: ${e}`) };
    return { ok: true, documents: [{ ...fm.meta, text: fm.body }] };
  }

  return { ok: false, errors: [`${path.basename(file)}: unsupported extension (use .json or .md)`] };
}

/**
 * Every corpus file, in a DETERMINISTIC order.
 *
 * `readdirSync` order is filesystem-dependent, and the order matters here: when
 * two files declare the same document, whichever is read last wins. Left
 * unsorted, "which version of that page is in the corpus" would be answered
 * differently on different machines, and the collision report below would name
 * a different loser each run.
 */
function walk(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(json|md|markdown)$/i.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Ingest a directory.
 *
 * Partial success is the normal outcome and is reported as such: a corpus of
 * 400 files with 3 bad ones should index 397 and NAME the 3, not fail wholesale
 * and not quietly drop them. Every rejection carries the document's file and
 * the specific field that was missing, because "some documents were skipped" is
 * an unactionable report.
 *
 * `dryRun` performs every validation, collision check and warning and writes
 * NOTHING. It is how a controlled corpus gets checked before it lands rather
 * than after, and it shares its whole decision path with the real run
 * (`planDocument`), so a clean dry run means a clean run.
 *
 * @returns {{ ok, dir, dryRun, files, created, updated, unchanged, admitted,
 *             rejected, collisions, contentDuplicates, warnings,
 *             versionRanking, embeddings, sourcePolicy }}
 */
export async function ingestCorpus({ dir = null, embed = true, dryRun = false } = {}) {
  const root = dir ? path.resolve(dir) : corpusDir();
  if (!fs.existsSync(root)) {
    return {
      ok: false,
      dir: root,
      files: 0,
      created: 0, updated: 0, unchanged: 0,
      rejected: [],
      warnings: [],
      collisions: [],
      contentDuplicates: [],
      admitted: [],
      error:
        `No corpus directory at ${root}. Create it and add documents (.json or .md with frontmatter), `
        + `each carrying: ${REQUIRED_METADATA.join(', ')}. Documents must be published under `
        + `${OFFICIAL_DOMAIN} — this corpus indexes official ServiceNow documentation only. Nothing is `
        + 'fetched from the web; documents are supplied by you, so that every citation the agent makes '
        + 'has a real source behind it.',
      sourcePolicy: sourcePolicy(),
    };
  }

  const files = walk(root);
  const rejected = [];
  const warnings = [];
  const admitted = [];
  /*
   * TWO KINDS OF DUPLICATE, which are different problems and must not be
   * reported as one.
   *
   *   collisions — two entries in THIS run resolve to the same document id
   *     (same source + url). One of them is about to overwrite the other and
   *     the corpus will silently hold whichever sorted last. That is an error
   *     in the corpus the operator needs to fix, so it is named.
   *
   *   contentDuplicates — the same body text under two DIFFERENT urls. Usually
   *     legitimate (one page mirrored, or genuinely duplicated by the vendor
   *     across products), so it is reported and kept rather than refused. Worth
   *     knowing, because both copies will match the same query and eat two of
   *     the six slots the prompt has for retrieved documentation.
   */
  const seenIds = new Map();
  const seenHashes = new Map();
  const collisions = [];
  const contentDuplicates = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const file of files) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    let read;
    try {
      read = readCorpusFile(file);
    } catch (err) {
      // A file that cannot even be read must not end the run for the rest.
      rejected.push({ file: rel, errors: [`unreadable: ${err.message}`] });
      continue;
    }
    if (!read.ok) {
      rejected.push({ file: rel, errors: read.errors });
      continue;
    }

    read.documents.forEach((doc, i) => {
      const where = read.documents.length > 1 ? `${rel}[${i}]` : rel;

      // Validate and decide FIRST, so a dry run and a real run agree on every
      // rejection, every warning and every collision — the only difference
      // between them is whether the write happens.
      const plan = planDocument(doc);
      if (!plan.ok) { rejected.push({ file: where, errors: plan.errors }); return; }

      const { id, content_hash: hash, url } = plan.document;
      const clash = seenIds.get(id);
      if (clash) {
        collisions.push({
          id,
          documents: [clash, where],
          url,
          error:
            'two corpus entries declare the same source and url, so they are the same document. '
            + `"${where}" overwrites "${clash}". Give them distinct urls, or delete one.`,
        });
      }
      seenIds.set(id, where);

      const sameText = seenHashes.get(hash);
      if (sameText && sameText.id !== id) {
        contentDuplicates.push({ documents: [sameText.file, where], urls: [sameText.url, url] });
      } else if (!sameText) {
        seenHashes.set(hash, { file: where, id, url });
      }

      for (const w of plan.warnings || []) warnings.push({ file: where, warning: w });

      if (dryRun) {
        admitted.push({ file: where, id, status: plan.status, url, sourceRule: plan.document.source_rule });
        if (plan.status === 'created') created += 1;
        else if (plan.status === 'updated') updated += 1;
        else unchanged += 1;
        return;
      }

      const res = upsertDocument(doc);
      // Only a storage failure can land here — validation already passed above.
      if (!res.ok) { rejected.push({ file: where, errors: res.errors }); return; }
      admitted.push({ file: where, id: res.id, status: res.status, url, sourceRule: res.sourceRule });
      if (res.status === 'created') created += 1;
      else if (res.status === 'updated') updated += 1;
      else unchanged += 1;
    });
  }

  // Ranks are recomputed over the WHOLE corpus, not just what was just read:
  // the release order may have changed since the rest of it was ingested, and a
  // half-ranked corpus ranks silently and wrongly. Skipped on a dry run, which
  // writes nothing at all.
  const ranks = dryRun ? null : reindexVersionRanks();

  let embeddings = null;
  if (embed && !dryRun) {
    // Failure here is REPORTED, never thrown. Keyword search still works
    // against everything just indexed; pretending ingestion failed because the
    // embedding model is not pulled would be its own wrong answer.
    embeddings = await backfillKnowledgeEmbeddings({ limit: 512 });
  }

  log.info('knowledge',
    `${dryRun ? 'DRY RUN over' : 'ingested'} ${root}: ${created} created, ${updated} updated, ` +
    `${unchanged} unchanged, ${rejected.length} rejected, ${collisions.length} collision(s)` +
    (ranks ? `; ${ranks.ranked}/${ranks.documents} documents ranked by release order` : ''));

  // A collision means the corpus contradicts itself about what a document is,
  // and the run silently kept whichever entry sorted last. Loud enough to be
  // seen without reading the JSON.
  for (const c of collisions) log.warn('knowledge', c.error);

  return {
    ok: true,
    dir: root,
    dryRun,
    files: files.length,
    created, updated, unchanged,
    admitted,
    rejected,
    collisions,
    contentDuplicates,
    warnings,
    versionRanking: ranks,
    embeddings,
    documentTypes: DOCUMENT_TYPES,
    // What the corpus was measured against, in the same report — so an
    // ingestion log answers "why was that refused?" on its own.
    sourcePolicy: sourcePolicy(),
  };
}

export { DEFAULT_CORPUS_DIR };
