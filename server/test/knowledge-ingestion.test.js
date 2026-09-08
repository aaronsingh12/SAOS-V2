import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';
import { _setSettingsForTests } from '../src/config/store.js';

/*
 * K2 — the ingestion pipeline, made operational for a CONTROLLED set of
 * official ServiceNow documents.
 *
 * This file covers the eight cases the brief names, end to end:
 *
 *   valid ingestion · invalid/missing metadata · duplicate documents ·
 *   version-aware retrieval · provenance preservation ·
 *   documentation cannot authorise · empty corpus · conflict -> stop_and_ask
 *
 * Entirely offline: a scratch SQLite file through the real migrations, a
 * temporary corpus directory per test, `embed: false` throughout so the suite
 * never depends on an embedding daemon, and retrieval assertions on the
 * deterministic keyword path.
 *
 * EVERY URL BELOW IS SYNTHETIC. They are shaped to exercise the host rule and
 * are not claims that those pages exist — no real ServiceNow documentation
 * path, product name or release name is asserted anywhere in this suite. The
 * release names are deliberately fictional, which is the point of test 'the
 * release order is operator-supplied' below.
 */

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-ing-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { ingestCorpus } = await import('../src/knowledge/ingest.js');
const {
  searchKnowledge, keywordSearchKnowledge, knowledgeStats, getDocument, previewDocument,
} = await import('../src/knowledge/store.js');
const { classifySourceUrl, sourcePolicy, OFFICIAL_DOMAIN, EXCLUDED_HOSTS } =
  await import('../src/knowledge/sources.js');
const { resolveConflict, canAuthorize } = await import('../src/knowledge/precedence.js');

const ORDER = ['Alpha', 'Bravo', 'Charlie'];

const settings = (rag = {}) => _setSettingsForTests({
  rag: { enabled: true, releaseOrder: ORDER, maxContextChunks: 6, allowedHosts: [], ...rag },
});

const { getDb } = await import('../src/memory/db.js');

/*
 * Each test states its WHOLE corpus. "How many documents are indexed" is the
 * thing half these assertions turn on, and inheriting it from whichever test
 * ran before would make them pass or fail on file ordering.
 */
const clear = () => getDb().exec('DELETE FROM kb_documents');

test.beforeEach(() => { settings(); });
test.afterEach(() => { _setSettingsForTests(null); });

const doc = (over = {}) => ({
  source: 'servicenow-docs',
  product: 'Platform',
  topic: 'flow-designer',
  version: 'Bravo',
  document_type: 'documentation',
  url: 'https://www.servicenow.com/docs/synthetic/flow-triggers',
  updated_at: '2026-01-15T00:00:00.000Z',
  title: 'Flow triggers',
  text: 'A flow trigger fires when its condition matches a record on the trigger table.',
  ...over,
});

/** A throwaway corpus directory containing the given {name: document} files. */
function corpus(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-corp-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

const ingest = (dir, opts = {}) => ingestCorpus({ dir, embed: false, ...opts });

/* ══ 1. VALID INGESTION ═══════════════════════════════════════════════════ */

test('a valid official document is ingested, chunked and retrievable', async () => {
  clear();
  const dir = corpus({ 'flow.json': doc() });
  const res = await ingest(dir);

  assert.equal(res.ok, true);
  assert.equal(res.created, 1);
  assert.equal(res.rejected.length, 0);
  assert.equal(res.collisions.length, 0);
  assert.equal(res.admitted[0].sourceRule, `official-domain:${OFFICIAL_DOMAIN}`);

  const stored = getDocument(res.admitted[0].id);
  assert.ok(stored.chunks.length >= 1, 'a stored document must have chunks or it is unsearchable');
  assert.ok(keywordSearchKnowledge('flow trigger condition').length >= 1);
});

test('both corpus formats work, and .md frontmatter carries the same metadata', async () => {
  clear();
  const dir = corpus({
    'a.json': doc({ url: 'https://www.servicenow.com/docs/synthetic/a' }),
    'b.md':
      '---\nsource: servicenow-developer\nproduct: Platform\ntopic: glide-api\nversion: Charlie\n'
      + 'document_type: api-reference\nurl: https://developer.servicenow.com/synthetic/b\n'
      + 'updated_at: 2026-02-01\ntitle: A scoped API\n---\nThe API body.',
  });
  const res = await ingest(dir);
  assert.equal(res.created, 2);
  assert.equal(res.rejected.length, 0);
  // A different official subdomain is admitted by the same rule — the host
  // check is the vendor DOMAIN, not an enumeration of its subdomains.
  const md = res.admitted.find((a) => a.file === 'b.md');
  assert.equal(md.sourceRule, `official-domain:${OFFICIAL_DOMAIN}`);
});

test('re-running ingestion is idempotent — nothing is duplicated or re-chunked', async () => {
  clear();
  const dir = corpus({ 'flow.json': doc() });
  const first = await ingest(dir);
  const second = await ingest(dir);

  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(knowledgeStats().documents, 1);
});

test('a dry run validates everything and writes NOTHING', async () => {
  clear();
  const dir = corpus({ 'good.json': doc(), 'bad.json': { source: 'x', text: 'no metadata' } });
  const res = await ingest(dir, { dryRun: true });

  assert.equal(res.dryRun, true);
  assert.equal(res.created, 1, 'it must report what it WOULD create');
  assert.equal(res.rejected.length, 1);
  assert.equal(knowledgeStats().documents, 0, 'a dry run must not touch the corpus');

  // And the real run then agrees with the dry run, which is the whole point of
  // sharing one decision path.
  const real = await ingest(dir);
  assert.equal(real.created, res.created);
  assert.equal(real.rejected.length, res.rejected.length);
});

/* ══ 2. INVALID / MISSING METADATA ════════════════════════════════════════ */

test('a document missing metadata is refused, and the report names the file AND the field', async () => {
  clear();
  const dir = corpus({
    'good.json': doc(),
    'nometa.json': { source: 'servicenow-docs', text: 'body only' },
  });
  const res = await ingest(dir);

  assert.equal(res.created, 1, 'the good document must still land — partial success is the norm');
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].file, 'nometa.json');
  const errs = res.rejected[0].errors.join(' ');
  for (const field of ['product', 'topic', 'version', 'document_type', 'url', 'updated_at']) {
    assert.ok(errs.includes(field), `the rejection must name the missing "${field}"`);
  }
});

test('a malformed corpus file does not end the run for the others', async () => {
  clear();
  const dir = corpus({ 'a.json': doc(), 'broken.json': '{ not valid json', 'nofm.md': 'no frontmatter' });
  const res = await ingest(dir);
  assert.equal(res.created, 1);
  assert.equal(res.rejected.length, 2);
  assert.match(res.rejected.map((r) => r.errors.join(' ')).join(' '), /not valid JSON/);
});

/* ── official sources only ───────────────────────────────────────────────── */

test('a non-ServiceNow host is refused however plausible the document looks', async () => {
  clear();
  const dir = corpus({
    'blog.json': doc({
      source: 'a-consultancy-blog',
      url: 'https://some-servicenow-blog.example.org/flow-designer-guide',
    }),
  });
  const res = await ingest(dir);
  assert.equal(res.created, 0);
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].errors.join(' '), /not an official ServiceNow source/);
});

test('community content under the vendor domain is refused as user-written', async () => {
  // It sits on servicenow.com, so a bare domain check would admit it. It is
  // not documentation, and rung 3 of the ladder means vendor-published.
  const verdict = classifySourceUrl(`https://${EXCLUDED_HOSTS[0]}/synthetic/thread/123`);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /user-written community content/);
});

test('a lookalike domain cannot impersonate the official one', async () => {
  // The trick an allowlist exists to refuse: a bare `endsWith` would admit both.
  for (const url of [
    'https://notservicenow.com/docs/x',
    'https://www.servicenow.com.attacker.example/docs/x',
  ]) {
    assert.equal(classifySourceUrl(url).ok, false, `${url} must be refused`);
  }
  assert.equal(classifySourceUrl('https://www.servicenow.com/docs/x').ok, true);
});

test('the allowlist widens ONLY through explicit operator configuration', async () => {
  const mirror = 'https://docs-mirror.internal.example/synthetic/page';
  assert.equal(classifySourceUrl(mirror).ok, false, 'refused by default');

  settings({ allowedHosts: ['docs-mirror.internal.example'] });
  const verdict = classifySourceUrl(mirror);
  assert.equal(verdict.ok, true);
  // The two admissions are recorded DIFFERENTLY: an operator override is a
  // weaker claim than the vendor domain, and an audit must be able to tell them
  // apart rather than seeing one undifferentiated "official".
  assert.match(verdict.rule, /^operator-allowed:/);
  assert.ok(sourcePolicy().operatorAllowedHosts.includes('docs-mirror.internal.example'));
});

/* ══ 3. DUPLICATE DOCUMENTS ═══════════════════════════════════════════════ */

test('the same source+url in two files is a COLLISION, reported rather than silently overwritten', async () => {
  clear();
  const shared = 'https://www.servicenow.com/docs/synthetic/same-page';
  const dir = corpus({
    'a-first.json': doc({ url: shared, text: 'The first copy of the body.' }),
    'b-second.json': doc({ url: shared, text: 'A DIFFERENT body at the same url.' }),
  });
  const res = await ingest(dir);

  assert.equal(res.collisions.length, 1);
  assert.deepEqual(res.collisions[0].documents, ['a-first.json', 'b-second.json']);
  assert.match(res.collisions[0].error, /overwrites/);
  // One document, not two — and the run said which entry won rather than
  // leaving it to filesystem ordering.
  assert.equal(knowledgeStats().documents, 1);
});

test('the same body under two DIFFERENT urls is kept, and reported as a content duplicate', async () => {
  clear();
  const body = 'Identical body text published at two different addresses.';
  const dir = corpus({
    'x.json': doc({ url: 'https://www.servicenow.com/docs/synthetic/x', text: body }),
    'y.json': doc({ url: 'https://www.servicenow.com/docs/synthetic/y', text: body }),
  });
  const res = await ingest(dir);

  assert.equal(res.created, 2, 'two real pages, kept — this is not an error');
  assert.equal(res.collisions.length, 0);
  assert.equal(res.contentDuplicates.length, 1);
  // Worth reporting because both will match the same query and consume two of
  // the few slots the prompt has for retrieved documentation.
  assert.deepEqual(res.contentDuplicates[0].documents, ['x.json', 'y.json']);
});

test('re-ingesting a CHANGED document updates it in place rather than adding one', async () => {
  clear();
  const url = 'https://www.servicenow.com/docs/synthetic/evolving';
  const first = await ingest(corpus({ 'v1.json': doc({ url, text: 'The original body.' }) }));
  const second = await ingest(corpus({ 'v2.json': doc({ url, text: 'The revised body.' }) }));

  assert.equal(second.updated, 1);
  assert.equal(knowledgeStats().documents, 1);
  assert.equal(getDocument(first.admitted[0].id).chunks[0].text, 'The revised body.');
});

/* ══ 4. VERSION-AWARE RETRIEVAL ═══════════════════════════════════════════ */

test('two releases of one page: the newer is retrieved, the older reported superseded', async () => {
  clear();
  const shared = { product: 'Platform', topic: 'acl', title: 'ACL evaluation' };
  const text = 'Access is evaluated by matching every applicable rule for the operation.';
  await ingest(corpus({
    'old.json': doc({ ...shared, version: 'Alpha', text,
      url: 'https://www.servicenow.com/docs/synthetic/acl-alpha', updated_at: '2025-01-01' }),
    'new.json': doc({ ...shared, version: 'Charlie', text,
      url: 'https://www.servicenow.com/docs/synthetic/acl-charlie', updated_at: '2026-01-01' }),
  }));

  const res = await searchKnowledge('how is access evaluated for an operation');
  assert.equal(res.hits.length, 1, 'one page, one hit — the older release is not a second result');
  assert.equal(res.hits[0].version, 'Charlie');
  assert.equal(res.superseded[0].version, 'Alpha');
  assert.equal(res.versionSignals[0].signal, 'release-order');
});

test('the release order is OPERATOR-SUPPLIED — nothing is inferred from the names', async () => {
  clear();
  const shared = { product: 'Platform', topic: 'sla', title: 'SLA schedules' };
  const text = 'A definition ignores its schedule unless the schedule source names the definition.';
  await ingest(corpus({
    'p.json': doc({ ...shared, version: 'Zeta', text,
      url: 'https://www.servicenow.com/docs/synthetic/sla-zeta', updated_at: '2026-05-01' }),
    'q.json': doc({ ...shared, version: 'Omega', text,
      url: 'https://www.servicenow.com/docs/synthetic/sla-omega', updated_at: '2024-05-01' }),
  }));

  // Neither release is in ORDER, so no release ordering is claimed and the
  // fallback is the SOURCE's own updated_at — stated, not silent.
  const res = await searchKnowledge('why is the sla schedule ignored');
  assert.equal(res.versionSignals[0].signal, 'updated-at');
  assert.match(res.versionSignals[0].caveat, /not every release in this group is listed/i);
  assert.equal(res.hits[0].version, 'Zeta', 'the more recently updated document wins the fallback');
  assert.ok(res.unrankedDocuments >= 2);
});

test('a newer page on a DIFFERENT topic never suppresses a relevant older one', async () => {
  clear();
  await ingest(corpus({
    'acl.json': doc({ topic: 'acl', title: 'ACL rules', version: 'Alpha',
      url: 'https://www.servicenow.com/docs/synthetic/topic-acl',
      text: 'Elevation is required before an access control rule can be written.' }),
    'flow.json': doc({ topic: 'flow-designer', title: 'Flows', version: 'Charlie',
      url: 'https://www.servicenow.com/docs/synthetic/topic-flow',
      text: 'Elevation is not required to activate a flow.' }),
  }));

  const res = await searchKnowledge('when is elevation required');
  assert.equal(res.hits.length, 2, 'different pages are not versions of each other');
  assert.equal(res.superseded.length, 0);
});

/* ══ 5. PROVENANCE PRESERVATION ═══════════════════════════════════════════ */

test('every retrieved CHUNK carries the full provenance of its document', async () => {
  clear();
  // Long enough to chunk into several pieces, so this tests the chunk->document
  // join rather than a one-chunk document that happens to look right.
  const body = Array.from({ length: 8 },
    (_, i) => `Paragraph ${i} about update set capture and what an update set records.`).join('\n\n');
  await ingest(corpus({
    'prov.json': doc({
      source: 'servicenow-docs', product: 'Platform', topic: 'update-sets',
      version: 'Charlie', document_type: 'release-note',
      url: 'https://www.servicenow.com/docs/synthetic/provenance-page',
      updated_at: '2026-03-04T00:00:00.000Z', title: 'Update set capture',
      text: body,
    }),
  }));

  const hits = keywordSearchKnowledge('update set capture records', { limit: 20 });
  assert.ok(hits.length >= 1);
  for (const h of hits) {
    // All six provenance facets the brief names, on every chunk.
    assert.equal(h.source, 'servicenow-docs');
    assert.equal(h.url, 'https://www.servicenow.com/docs/synthetic/provenance-page');
    assert.equal(h.product, 'Platform');
    assert.equal(h.topic, 'update-sets');
    assert.equal(h.version, 'Charlie');
    assert.equal(h.document_type, 'release-note');
    assert.equal(h.updated_at, '2026-03-04T00:00:00.000Z');
  }
});

test('provenance survives an UPDATE — a re-ingested document does not lose its metadata', async () => {
  clear();
  const url = 'https://www.servicenow.com/docs/synthetic/prov-update';
  await ingest(corpus({ 'v1.json': doc({ url, text: 'Original text about subflow inputs.' }) }));
  await ingest(corpus({
    'v2.json': doc({ url, version: 'Charlie', updated_at: '2026-07-07T00:00:00.000Z',
      text: 'Revised text about subflow inputs.' }),
  }));

  const [h] = keywordSearchKnowledge('subflow inputs');
  assert.equal(h.version, 'Charlie', 'the moved release must be what retrieval now reports');
  assert.equal(h.updated_at, '2026-07-07T00:00:00.000Z');
  assert.equal(h.url, url);
});

test('a document is never stored without the provenance that makes it citable', () => {
  // The url is what the agent cites. A document that lost it during ingestion
  // would be indistinguishable from one the model invented.
  const preview = previewDocument(doc({ url: '' }));
  assert.equal(preview.ok, false);
  assert.match(preview.errors.join(' '), /url/);
});

/* ══ 6. DOCUMENTATION CANNOT AUTHORISE ════════════════════════════════════ */

test('an ingested document does not become permission, however official', async () => {
  clear();
  await ingest(corpus({
    'auth.json': doc({
      url: 'https://www.servicenow.com/docs/synthetic/authorise',
      text: 'Administrators can drop a column from a custom table.',
    }),
  }));
  const res = await searchKnowledge('can a column be dropped from a custom table');

  // It retrieves — and retrieving is all it does.
  assert.ok(res.indexed >= 1);
  assert.equal(canAuthorize(['documentation']), false);

  const verdict = resolveConflict({
    question: 'May SNADA drop this column?',
    claims: [{ source: 'documentation', says: 'administrators can drop a column', ref: res.hits[0]?.url }],
  });
  assert.equal(verdict.verdict, 'resolved');
  assert.equal(verdict.canAuthorize, false, 'a retrieved document must never authorise an action');
  assert.match(verdict.reason, /may not authorise an action/);
});

test('a measured tool limitation still overrules the freshest documentation', async () => {
  const verdict = resolveConflict({
    question: 'Is this operation available here?',
    claims: [
      { source: 'documentation', says: 'the operation is supported', ref: 'https://www.servicenow.com/docs/synthetic/x' },
      { source: 'tool_capability', says: 'the installed SDK does not expose this operation',
        evidence: 'compiler: unknown option' },
    ],
  });
  assert.equal(verdict.winner.source, 'tool_capability');
  assert.match(verdict.overruled[0].why, /Overruled by/);
});

/* ══ 7. EMPTY CORPUS ══════════════════════════════════════════════════════ */

test('an empty corpus returns mode "none" and forbids any conclusion', async () => {
  clear();
  const res = await searchKnowledge('anything at all');
  assert.equal(res.mode, 'none');
  assert.equal(res.indexed, 0);
  assert.deepEqual(res.hits, []);
  assert.match(res.note, /EMPTY CORPUS/);
  // Zero hits from an empty corpus and zero hits from a full one mean
  // completely different things, and only one is "the docs do not cover this".
});

test('a corpus directory that does not exist reports how to build one', async () => {
  const res = await ingest(path.join(scratchDir, 'absent'));
  assert.equal(res.ok, false);
  assert.match(res.error, /No corpus directory/);
  assert.match(res.error, new RegExp(OFFICIAL_DOMAIN));
  assert.match(res.error, /Nothing is fetched from the web/);
});

test('a corpus where every document is refused indexes nothing and says so', async () => {
  clear();
  const dir = corpus({ 'a.json': doc({ url: 'https://blog.example.org/a' }) });
  const res = await ingest(dir);
  assert.equal(res.created, 0);
  assert.equal(res.rejected.length, 1);
  assert.equal(knowledgeStats().documents, 0);
  assert.equal((await searchKnowledge('anything')).mode, 'none');
});

/* ══ 8. CONFLICTING KNOWLEDGE -> stop_and_ask ═════════════════════════════ */

test('two ingested documents that contradict each other produce stop_and_ask', async () => {
  clear();
  // Both official, both current, different products — a real corpus shape, not
  // a contrived one. Nothing in the ladder can rank one above the other.
  await ingest(corpus({
    'one.json': doc({ product: 'ITSM', title: 'Retention', topic: 'retention',
      url: 'https://www.servicenow.com/docs/synthetic/retention-itsm',
      text: 'Records are retained for thirty days.' }),
    'two.json': doc({ product: 'ITOM', title: 'Retention', topic: 'retention',
      url: 'https://www.servicenow.com/docs/synthetic/retention-itom',
      text: 'Records are retained for ninety days.' }),
  }));
  const res = await searchKnowledge('how long are records retained');
  assert.ok(res.hits.length >= 2, 'both documents must survive retrieval to be seen as a conflict');

  const verdict = resolveConflict({
    question: 'How long are records retained?',
    claims: res.hits.slice(0, 2).map((h) => ({
      source: 'documentation',
      says: h.text.includes('thirty') ? 'thirty days' : 'ninety days',
      ref: h.url,
    })),
  });

  assert.equal(verdict.verdict, 'stop_and_ask');
  assert.equal(verdict.winner, null, 'no tie-break may be invented between equals');
  assert.match(verdict.ask, /thirty days/);
  assert.match(verdict.ask, /ninety days/);
  assert.equal(verdict.canAuthorize, false);
});

test('an unevidenced claim about live state cannot outrank an ingested document', async () => {
  // The shape that would otherwise let the model overrule documentation by
  // asserting something about the instance it never actually read.
  const verdict = resolveConflict({
    question: 'Does the field exist here?',
    claims: [
      { source: 'live_pdi', says: 'the field exists' },
      { source: 'documentation', says: 'the field was removed', ref: 'https://www.servicenow.com/docs/synthetic/f' },
    ],
  });
  assert.equal(verdict.demoted[0].demotedFrom, 'live_pdi');
  assert.equal(verdict.winner.source, 'documentation');
  assert.equal(verdict.canAuthorize, false, 'and the winner still cannot authorise anything');
});
