/**
 * K2b — INGESTING OFFICIAL SERVICENOW DOCUMENTATION.
 *
 *   node --test server/test/knowledge-fetch-docs.test.js
 *
 * The fetcher is the one part of this system that reaches the internet, so what
 * is tested here is mostly what it REFUSES. Rendering a live page needs a
 * browser and a network and belongs in the end-to-end run; the parsing and the
 * host rule are pure and are tested directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nha-fetchdocs-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({ rag: { enabled: true, corpusDir: scratch, allowedHosts: [] } });

const { _internals, fetchDoc } = await import('../src/knowledge/fetch-docs.js');
const { classifySourceUrl } = await import('../src/knowledge/sources.js');

/* ------------------------------------------------------------------ *
 * The host rule — enforced BEFORE anything is requested.
 * ------------------------------------------------------------------ */

test('K2b — a non-official host is refused without being fetched', async () => {
  /*
   * The CDP handle is deliberately a throwing stub: if the fetcher ever
   * requested the page before checking the host, this test would explode rather
   * than pass. That is the point — the check has to come first, or this module
   * becomes a general-purpose crawler the first time someone passes a blog.
   */
  const exploding = {
    send: () => { throw new Error('the fetcher navigated to an unofficial host'); },
    evaluate: () => { throw new Error('the fetcher evaluated against an unofficial host'); },
  };
  for (const url of [
    'https://example.com/acl.html',
    'https://servicenow-tips.blogspot.com/acl.html',
    'https://community.servicenow.com/community?id=acl',
  ]) {
    const r = await fetchDoc(exploding, url);
    assert.equal(r.ok, false, `${url} was not refused`);
    assert.ok(r.reason, 'a refusal carries no reason');
  }
});

test('K2b — the official domain is accepted by the same rule the corpus uses', () => {
  const ok = classifySourceUrl('https://www.servicenow.com/docs/r/platform-security/access-control/t_CreateAnACLRule.html');
  assert.equal(ok.ok, true);
  assert.match(ok.rule, /official-domain/);
  // Community content is under the official domain and is still refused.
  assert.equal(classifySourceUrl('https://community.servicenow.com/x').ok, false);
});

/* ------------------------------------------------------------------ *
 * Metadata parsing — from the page's own words, never inferred.
 * ------------------------------------------------------------------ */

test('K2b — the release is read from the page, not guessed', () => {
  const { parseRelease } = _internals;
  assert.equal(parseRelease('Configure an ACL Release version: Australia Updated June 23, 2026', ''), 'Australia');
  // No release anywhere => null, so the document is refused rather than dated.
  assert.equal(parseRelease('some page with no release line', ''), null);
});

test('K2b — the updated date survives parsing exactly, in any timezone', () => {
  const { parseUpdated } = _internals;
  /*
   * REGRESSION. `new Date('June 23, 2026').toISOString()` yields 2026-06-22 on
   * any machine east of Greenwich — measured on this one, at +05:30. The page's
   * own date is metadata a reader may rely on, so it is assembled from the
   * matched parts instead.
   */
  assert.equal(parseUpdated('Updated June 23, 2026'), '2026-06-23');
  assert.equal(parseUpdated('Updated March 12, 2026 1 minute to read'), '2026-03-12');
  assert.equal(parseUpdated('Updated January 1, 2026'), '2026-01-01');
  assert.equal(parseUpdated('no updated line'), null);
  assert.equal(parseUpdated('Updated Smarch 4, 2026'), null, 'an unreal month was accepted');
});

test('K2b — the topic comes from the URL path', () => {
  const { parseTopic } = _internals;
  assert.equal(
    parseTopic('https://www.servicenow.com/docs/r/platform-security/access-control/t_CreateAnACLRule.html'),
    'security',
  );
  assert.equal(parseTopic('https://www.servicenow.com/nothing/here'), null);
});

/* ------------------------------------------------------------------ *
 * A page that does not render is refused, never filled in.
 * ------------------------------------------------------------------ */

test('K2b — an unrendered page is refused and nothing is stored', async () => {
  const neverReady = {
    send: async () => ({}),
    evaluate: async () => ({ ready: false }),
  };
  const r = await fetchDoc(
    neverReady,
    'https://www.servicenow.com/docs/r/platform-security/access-control/t_CreateAnACLRule.html',
    { waitMs: 1200 },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /did not render/i);
  // It refuses; it does not offer a reconstruction, and says so.
  assert.match(r.reason, /no text is reconstructed/i);
  assert.equal(r.document, undefined, 'a refused page produced a document');
});

test('K2b — a page rendered without its release or date is refused, not defaulted', async () => {
  const thin = {
    send: async () => ({}),
    evaluate: async () => ({
      ready: true, title: 'Configure an ACL', docTitle: 'Configure an ACL', text: 'body text '.repeat(60),
    }),
  };
  const r = await fetchDoc(thin, 'https://www.servicenow.com/docs/r/platform-security/access-control/t_CreateAnACLRule.html', { waitMs: 500 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /version/);
  assert.match(r.reason, /updated_at/);
});

test('K2b — a fully rendered page becomes a corpus document with the seven fields', async () => {
  const { REQUIRED_METADATA } = await import('../src/knowledge/schema.js');
  const good = {
    send: async () => ({}),
    evaluate: async () => ({
      ready: true,
      title: 'Configure an ACL',
      docTitle: 'Configure an ACL • Australia Platform security • Docs | ServiceNow',
      text: 'Configure an ACL Release version: Australia Updated June 23, 2026 4 minutes to read '
        + 'Configure custom access control lists (ACLs) to secure access to new objects. '.repeat(8),
    }),
  };
  const url = 'https://www.servicenow.com/docs/r/platform-security/access-control/t_CreateAnACLRule.html';
  const r = await fetchDoc(good, url, { waitMs: 500 });
  assert.equal(r.ok, true, r.reason);
  for (const f of REQUIRED_METADATA) {
    assert.ok(r.document[f], `the fetched document is missing ${f}`);
  }
  assert.equal(r.document.url, url, 'the stored url is not the one that was fetched');
  assert.equal(r.document.source, 'servicenow-docs');
  assert.equal(r.document.version, 'Australia');
  assert.equal(r.document.updated_at, '2026-06-23');
  // The text is the page's, verbatim — nothing appended, nothing summarised.
  assert.ok(r.document.text.includes('Configure custom access control lists'));
});
