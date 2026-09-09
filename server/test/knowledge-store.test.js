import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';
import { _setSettingsForTests } from '../src/config/store.js';

/*
 * K1/K2 — the documentation corpus: what it refuses, what it stores, and how
 * version preference actually behaves.
 *
 * Entirely offline. A scratch SQLite file through the REAL migrations, and
 * every retrieval assertion goes through the KEYWORD path, which is
 * deterministic and needs no embedding model pulled on whatever machine runs
 * the suite. (The semantic path shares the same ranking and version code; what
 * differs is only where the scores come from.)
 */

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-kb-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const {
  upsertDocument, keywordSearchKnowledge, applyVersionPreference,
  knowledgeStats, getDocument, deleteDocument, reindexVersionRanks, searchKnowledge,
} = await import('../src/knowledge/store.js');
const { validateDocument, rankVersion, documentId, DOCUMENT_TYPES, UNVERSIONED } =
  await import('../src/knowledge/schema.js');
const { parseFrontmatter, readCorpusFile, ingestCorpus } = await import('../src/knowledge/ingest.js');

/*
 * A fictional release order. It is the OPERATOR-supplied list, and using
 * invented names here is deliberate: it proves the ranking is driven entirely
 * by configuration rather than by any hardcoded belief about ServiceNow's real
 * release history, which this repo has no verified source for.
 */
const ORDER = ['Alpha', 'Bravo', 'Charlie'];
const withOrder = (releaseOrder = ORDER) => _setSettingsForTests({ rag: { releaseOrder, enabled: true } });

const doc = (over = {}) => ({
  source: 'servicenow-docs',
  product: 'ITSM',
  topic: 'flow-designer',
  version: 'Bravo',
  document_type: 'documentation',
  url: 'https://www.servicenow.com/docs/example-page',
  updated_at: '2026-01-15T00:00:00.000Z',
  title: 'Creating a flow',
  text: 'A flow runs when its trigger condition matches a record on the trigger table.',
  ...over,
});

test.beforeEach(() => { withOrder(); });
test.afterEach(() => { _setSettingsForTests(null); });

/* ── metadata is required, not defaulted ──────────────────────────────────── */

test('every required metadata field is enforced, and named when missing', () => {
  const { ok, errors } = validateDocument({ text: 'hello' }, { releaseOrder: ORDER });
  assert.equal(ok, false);
  for (const field of ['source', 'product', 'topic', 'version', 'document_type', 'url', 'updated_at']) {
    assert.ok(errors.some((e) => e.includes(field)), `the refusal must name the missing "${field}"`);
  }
});

test('a document with no text is refused', () => {
  const { ok, errors } = validateDocument(doc({ text: '' }), { releaseOrder: ORDER });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /no text to index/);
});

test('an unknown document_type is refused, naming the allowed list', () => {
  const { ok, errors } = validateDocument(doc({ document_type: 'blog-post' }), { releaseOrder: ORDER });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /blog-post/);
  for (const t of DOCUMENT_TYPES) assert.ok(errors.join(' ').includes(t));
});

test('a placeholder URL is REFUSED, not warned about', () => {
  // The failure this exists for: an invented citation the agent will later
  // repeat to a user with the authority of a source. Placeholder hosts are now
  // caught by the official-source rule rather than by a list of their names —
  // none of them is published under the vendor domain either, which is a
  // stronger check than enumerating the placeholders people happen to use.
  for (const url of ['https://example.com/docs/flow', 'https://placeholder/x', 'http://localhost/docs']) {
    const { ok, errors } = validateDocument(doc({ url }), { releaseOrder: ORDER });
    assert.equal(ok, false, `${url} must be refused`);
    assert.match(errors.join(' '), /not an official ServiceNow source|not a parseable URL/);
  }
});

test('a relative URL is refused', () => {
  const { ok } = validateDocument(doc({ url: '/docs/bundle/flow-designer' }), { releaseOrder: ORDER });
  assert.equal(ok, false);
});

test('an unparseable updated_at is refused rather than coerced to now', () => {
  const { ok, errors } = validateDocument(doc({ updated_at: 'recently' }), { releaseOrder: ORDER });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /not a parseable date/);
});

/* ── version ranking is configuration, never inference ────────────────────── */

test('rank comes from the operator-supplied order, oldest first', () => {
  assert.equal(rankVersion('Alpha', ORDER), 0);
  assert.equal(rankVersion('Charlie', ORDER), 2);
});

test('rank matching tolerates case and spacing, and nothing more', () => {
  assert.equal(rankVersion('  bravo ', ORDER), 1);
  // Deliberately NOT fuzzy: guessing which release someone meant is the thing
  // this must not do.
  assert.equal(rankVersion('Brav', ORDER), null);
});

test('a release not in the order is UNRANKED, and the document says so', () => {
  const { ok, document, warnings } = validateDocument(doc({ version: 'Zeta' }), { releaseOrder: ORDER });
  assert.equal(ok, true);
  assert.equal(document.version_rank, null);
  assert.match(warnings.join(' '), /not in settings\.rag\.releaseOrder/);
});

test('an empty release order ranks nothing — no ordering is invented', () => {
  assert.equal(rankVersion('Bravo', []), null);
  assert.equal(rankVersion(UNVERSIONED, ORDER), null);
});

/* ── storage ──────────────────────────────────────────────────────────────── */

test('a document is stored with all seven metadata fields intact', () => {
  const res = upsertDocument(doc({ url: 'https://www.servicenow.com/docs/store-1' }));
  assert.equal(res.ok, true);
  assert.equal(res.status, 'created');
  const stored = getDocument(res.id);
  assert.equal(stored.source, 'servicenow-docs');
  assert.equal(stored.product, 'ITSM');
  assert.equal(stored.topic, 'flow-designer');
  assert.equal(stored.version, 'Bravo');
  assert.equal(stored.document_type, 'documentation');
  assert.equal(stored.url, 'https://www.servicenow.com/docs/store-1');
  assert.equal(stored.updated_at, '2026-01-15T00:00:00.000Z');
  assert.equal(stored.version_rank, 1);
  assert.ok(stored.chunks.length >= 1);
  deleteDocument(res.id);
});

test('the same source+url is ONE document across re-ingestion, not a duplicate', () => {
  const d = doc({ url: 'https://www.servicenow.com/docs/store-2' });
  const first = upsertDocument(d);
  const again = upsertDocument(d);
  assert.equal(first.id, again.id);
  assert.equal(again.status, 'unchanged');
  assert.equal(first.id, documentId({ source: d.source, url: d.url }));
  deleteDocument(first.id);
});

test('unchanged text leaves the chunks alone; changed text re-chunks', () => {
  // Re-chunking cascades the embeddings away, so doing it needlessly silently
  // degrades search until a backfill catches up.
  const d = doc({ url: 'https://www.servicenow.com/docs/store-3' });
  const created = upsertDocument(d);
  assert.equal(upsertDocument({ ...d, title: 'Renamed' }).status, 'unchanged');
  assert.equal(upsertDocument({ ...d, text: 'Completely different body text.' }).status, 'updated');
  assert.equal(getDocument(created.id).chunks[0].text, 'Completely different body text.');
  deleteDocument(created.id);
});

test('changing the release order re-ranks the WHOLE corpus, not just new documents', () => {
  const created = upsertDocument(doc({ url: 'https://www.servicenow.com/docs/rank-1', version: 'Delta' }));
  assert.equal(getDocument(created.id).version_rank, null, 'Delta is not in the order yet');
  withOrder([...ORDER, 'Delta']);
  const res = reindexVersionRanks();
  assert.ok(res.changed >= 1);
  assert.equal(getDocument(created.id).version_rank, 3);
  deleteDocument(created.id);
});

/* ── retrieval ────────────────────────────────────────────────────────────── */

test('keyword retrieval finds a document and carries its provenance back', () => {
  const created = upsertDocument(doc({
    url: 'https://www.servicenow.com/docs/search-1',
    text: 'A subflow is reusable logic that another flow can call with inputs.',
  }));
  const hits = keywordSearchKnowledge('subflow reusable logic');
  const hit = hits.find((h) => h.document === created.id);
  assert.ok(hit, 'the indexed document must be findable');
  assert.equal(hit.url, 'https://www.servicenow.com/docs/search-1');
  assert.equal(hit.version, 'Bravo');
  assert.equal(hit.source, 'servicenow-docs');
  deleteDocument(created.id);
});

test('an empty corpus reports mode "none" and refuses to be read as an absence of documentation', async () => {
  const { getDb } = await import('../src/memory/db.js');
  getDb().exec('DELETE FROM kb_documents');
  const res = await searchKnowledge('anything at all');
  assert.equal(res.mode, 'none');
  assert.equal(res.indexed, 0);
  assert.deepEqual(res.hits, []);
  assert.match(res.note, /EMPTY CORPUS/);
});

/* ── version preference ───────────────────────────────────────────────────── */

const hit = (over) => ({
  document: 'd', source: 's', product: 'p', topic: 't', title: 'Same Page',
  version: 'Alpha', version_rank: 0, url: 'https://www.servicenow.com/docs/a',
  updated_at: '2026-01-01T00:00:00.000Z', score: 1, text: 'x', ...over,
});

test('within one family the newer release wins, and the older is reported as superseded', () => {
  const res = applyVersionPreference([
    hit({ document: 'old', version: 'Alpha', version_rank: 0, score: 9 }),
    hit({ document: 'new', version: 'Charlie', version_rank: 2, score: 1 }),
  ], { releaseOrder: ORDER });

  assert.deepEqual(res.hits.map((h) => h.document), ['new']);
  assert.equal(res.superseded.length, 1);
  assert.equal(res.superseded[0].version, 'Alpha');
  assert.equal(res.signals[0].signal, 'release-order');
  assert.equal(res.signals[0].caveat, null);
  // Note the older document had the HIGHER relevance score and still lost.
  // That is the point of "prefer newer documentation".
});

test('an unranked release falls back to updated_at, and SAYS it fell back', () => {
  const res = applyVersionPreference([
    hit({ document: 'a', version: 'Zeta', version_rank: null, updated_at: '2026-06-01T00:00:00.000Z' }),
    hit({ document: 'b', version: 'Alpha', version_rank: 0, updated_at: '2025-01-01T00:00:00.000Z' }),
  ], { releaseOrder: ORDER });

  assert.deepEqual(res.hits.map((h) => h.document), ['a']);
  assert.equal(res.signals[0].signal, 'updated-at');
  assert.match(res.signals[0].caveat, /not every release in this group is listed/i);
});

test('documents about DIFFERENT things are never deduplicated by version', () => {
  // The failure this prevents: a newer page on an unrelated topic burying a
  // relevant older one.
  const res = applyVersionPreference([
    hit({ document: 'acl', topic: 'acl', title: 'ACL rules', version: 'Alpha', version_rank: 0 }),
    hit({ document: 'flow', topic: 'flow-designer', title: 'Flows', version: 'Charlie', version_rank: 2 }),
  ], { releaseOrder: ORDER });
  assert.equal(res.hits.length, 2);
  assert.equal(res.superseded.length, 0);
});

test('several chunks of ONE document are not a version conflict', () => {
  const res = applyVersionPreference([
    hit({ document: 'same', seq: 0, score: 3 }),
    hit({ document: 'same', seq: 1, score: 2 }),
  ], { releaseOrder: ORDER });
  assert.equal(res.hits.length, 2, 'both chunks of the same document must survive');
  assert.equal(res.superseded.length, 0);
});

/* ── ingestion ────────────────────────────────────────────────────────────── */

test('frontmatter parses flat key/value pairs and refuses anything else', () => {
  const good = parseFrontmatter('---\nsource: servicenow-docs\ntopic: acl\n---\nbody here');
  assert.equal(good.ok, true);
  assert.equal(good.meta.source, 'servicenow-docs');
  assert.equal(good.body.trim(), 'body here');

  const bad = parseFrontmatter('---\n- a list item\n---\nbody');
  assert.equal(bad.ok, false, 'a shape this parser does not handle must be refused, not half-read');

  assert.equal(parseFrontmatter('no frontmatter here').ok, false);
});

test('ingestion indexes the good documents and NAMES the field each bad one lacks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-corpus-'));
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(doc({
    url: 'https://www.servicenow.com/docs/ingest-good',
    text: 'An ACL grants access when every one of its checks passes.',
  })));
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ source: 'x', text: 'no metadata' }));
  fs.writeFileSync(path.join(dir, 'good.md'),
    '---\nsource: servicenow-api\nproduct: Platform\ntopic: glide-api\nversion: Charlie\n'
    + 'document_type: api-reference\nurl: https://www.servicenow.com/docs/ingest-md\n'
    + 'updated_at: 2026-02-01\ntitle: GlideRecord\n---\nGlideRecord queries a table.');

  // embed:false — this suite must not depend on an embedding daemon being up.
  const res = await ingestCorpus({ dir, embed: false });
  assert.equal(res.ok, true);
  assert.equal(res.created, 2);
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].file, 'bad.json');
  assert.match(res.rejected[0].errors.join(' '), /product/);
  assert.match(res.rejected[0].errors.join(' '), /url/);

  const stats = knowledgeStats();
  assert.ok(stats.documents >= 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing corpus directory is reported with what a document must carry', async () => {
  const res = await ingestCorpus({ dir: path.join(scratchDir, 'nope'), embed: false });
  assert.equal(res.ok, false);
  assert.match(res.error, /No corpus directory/);
  assert.match(res.error, /Nothing is fetched from the web/);
});

test('an unsupported file extension is refused rather than skipped silently', () => {
  const p = path.join(scratchDir, 'x.txt');
  fs.writeFileSync(p, 'hello');
  const res = readCorpusFile(p);
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /unsupported extension/);
});
