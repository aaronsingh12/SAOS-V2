import crypto from 'node:crypto';
import { classifySourceUrl } from './sources.js';

/**
 * K1 — what a ServiceNow knowledge document must carry before it is allowed
 * into the corpus.
 *
 * THE POINT OF VALIDATING AT ALL. Retrieved documentation ends up in the
 * agent's system prompt, next to the fact ledger and the tool catalogue, and
 * the model has no way to tell a well-sourced paragraph from a badly-sourced
 * one once they are both just text. The metadata IS the difference, so a
 * document that cannot say where it came from, which product and release it
 * describes, or when it was last changed is refused at the door rather than
 * indexed and later cited.
 *
 * Refusal, not repair. Every field here is one a human or an ingestion script
 * knows and this module does not: defaulting `version` to the newest release,
 * or `url` to a plausible docs.servicenow.com path, would manufacture exactly
 * the confident-wrong citation the whole design is trying to avoid.
 */

/** Every field the task requires on every document. None is optional. */
export const REQUIRED_METADATA = Object.freeze([
  'source',        // who published it — 'servicenow-docs', 'servicenow-api', ...
  'product',       // which product family it describes
  'topic',         // flow-designer | acl | sla | glide-api | scoped-app | ...
  'version',       // the release it documents, AS THE SOURCE STATES IT
  'document_type', // see DOCUMENT_TYPES
  'url',           // the source's own address for it
  'updated_at',    // when the SOURCE last changed it
]);

/**
 * Kinds of document, kept as a closed list so a typo becomes an error rather
 * than a category nobody ever filters on again.
 */
export const DOCUMENT_TYPES = Object.freeze([
  'documentation',   // product documentation pages
  'api-reference',   // Glide / REST / scoped API reference
  'release-note',    // release and patch notes
  'developer-guide', // developer-site guides and tutorials
  'kb-article',      // ServiceNow-published KB articles
  'store-listing',   // Store / plugin documentation
]);

/**
 * The value a document uses when the source genuinely does not tie it to a
 * release. Spelled out rather than left blank, because a blank version and an
 * explicitly release-independent one rank differently and must not be confused.
 */
export const UNVERSIONED = 'unversioned';

const isBlank = (v) => typeof v !== 'string' || !v.trim();

/**
 * A stable id for a document, so re-ingesting the same page UPDATES it rather
 * than accumulating near-duplicates that all match the same query.
 *
 * Keyed on source + url: the same page from two different sources is two
 * documents (they may disagree, and the conflict ladder needs to see both),
 * but the same page re-read is one.
 */
export function documentId({ source, url }) {
  return crypto.createHash('sha256').update(`${source}\n${url}`).digest('hex').slice(0, 24);
}

export function contentHash(text) {
  return crypto.createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 24);
}

/**
 * Where a version sits in the operator-supplied release order.
 *
 * `null` is a first-class answer and the common one: it means this release is
 * not in `settings.rag.releaseOrder`, so nothing here knows whether it is newer
 * or older than anything else. Retrieval reads that null and falls back to
 * `updated_at`, and says which signal it used.
 *
 * Matching is case-insensitive and whitespace-tolerant because release names
 * are written by hand ("Washington DC", "washington dc"). It is NOT fuzzy
 * beyond that: "Washington" does not match "Washington DC", because guessing
 * which release someone meant is the thing this must not do.
 */
export function rankVersion(version, releaseOrder = []) {
  if (isBlank(version)) return null;
  const norm = (v) => String(v).trim().toLowerCase().replace(/\s+/g, ' ');
  const target = norm(version);
  if (target === UNVERSIONED) return null;
  const idx = (releaseOrder || []).findIndex((r) => norm(r) === target);
  // Oldest first in the list, so the index IS the rank: higher is newer.
  return idx === -1 ? null : idx;
}

/**
 * Validate one document.
 *
 * @returns {{ ok: boolean, errors: string[], warnings: string[], document?: object }}
 *   `errors` refuse the document. `warnings` let it in but travel with it, so a
 *   thin citation is visibly thin rather than quietly equal to a good one.
 */
export function validateDocument(input, { releaseOrder = [] } = {}) {
  const errors = [];
  const warnings = [];
  const doc = input && typeof input === 'object' ? input : {};

  for (const field of REQUIRED_METADATA) {
    if (isBlank(doc[field])) errors.push(`missing required metadata: ${field}`);
  }

  if (isBlank(doc.text)) errors.push('document has no text to index');

  if (!isBlank(doc.document_type) && !DOCUMENT_TYPES.includes(doc.document_type)) {
    errors.push(
      `document_type "${doc.document_type}" is not one of: ${DOCUMENT_TYPES.join(', ')}`
    );
  }

  /*
   * OFFICIAL SOURCES ONLY, and this is where that is enforced.
   *
   * Refused rather than warned. A document that reaches the corpus becomes a
   * citation the agent repeats to a user with the authority of a source, and
   * `example.com`, a consultancy blog and a vendor documentation page are
   * indistinguishable once they have been chunked. `classifySourceUrl` also
   * catches the placeholder hosts a generated corpus is made of, since none of
   * them are under the vendor domain either.
   */
  let sourceRule = null;
  if (!isBlank(doc.url)) {
    if (!/^https?:\/\//i.test(doc.url)) {
      errors.push(`url must be an absolute http(s) address, got "${doc.url}"`);
    } else {
      const verdict = classifySourceUrl(doc.url);
      if (!verdict.ok) errors.push(`url "${doc.url}" was refused: ${verdict.reason}`);
      else sourceRule = verdict.rule;
    }
  }

  if (!isBlank(doc.updated_at)) {
    if (Number.isNaN(Date.parse(doc.updated_at))) {
      errors.push(`updated_at "${doc.updated_at}" is not a parseable date`);
    } else if (Date.parse(doc.updated_at) > Date.now() + 86_400_000) {
      // A warning, not a refusal: clock skew and timezone-less dates are real,
      // and a future date is suspicious rather than impossible. But it is the
      // signature of a fabricated or templated metadata block, and version
      // preference falls back to this field — so an unnoticed future date can
      // make one document permanently outrank every other release of its page.
      warnings.push(
        `updated_at "${doc.updated_at}" is in the future. Version preference falls back to this field `
        + 'when a release is unranked, so a wrong date here can make this document outrank newer ones.'
      );
    }
  }

  if (errors.length) return { ok: false, errors, warnings };

  const version_rank = rankVersion(doc.version, releaseOrder);
  if (version_rank === null && doc.version !== UNVERSIONED) {
    warnings.push(
      `release "${doc.version}" is not in settings.rag.releaseOrder, so this document cannot be `
      + 'ranked against other releases. Retrieval will fall back to updated_at for it.'
    );
  }

  return {
    ok: true,
    errors,
    warnings,
    document: {
      id: doc.id || documentId({ source: doc.source, url: doc.url }),
      source: doc.source.trim(),
      product: doc.product.trim(),
      topic: doc.topic.trim(),
      version: doc.version.trim(),
      version_rank,
      document_type: doc.document_type.trim(),
      url: doc.url.trim(),
      updated_at: new Date(doc.updated_at).toISOString(),
      title: isBlank(doc.title) ? null : doc.title.trim(),
      text: doc.text,
      content_hash: contentHash(doc.text),
      /*
       * WHICH rule admitted this document — the vendor domain, or an operator
       * override. Reported by ingestion and deliberately NOT a column: the
       * schema is unchanged, and it is derivable from `url` at any time, so
       * storing it would be a second copy of a fact that could then disagree
       * with the first if the allowlist changed underneath it.
       */
      source_rule: sourceRule,
    },
  };
}
