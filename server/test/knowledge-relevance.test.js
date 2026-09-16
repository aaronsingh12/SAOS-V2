/**
 * K3b — WHAT COUNTS AS RELEVANT, and what must not be cited.
 *
 *   node --test server/test/knowledge-relevance.test.js
 *
 * Two defects this file exists to keep closed, both found by populating the
 * corpus with real ACL documentation and then asking questions that are not
 * about ACLs:
 *
 *   1. Top-N semantic search has no opinion about distance. On a small corpus
 *      EVERY question retrieves something — "What is the capital of France?"
 *      came back with six ACL documents.
 *
 *   2. The context engine widens the retrieval query with the turn's detected
 *      capabilities, and those carry across turns. Once a conversation has been
 *      about ACLs, an unrelated question inherits "acl" and clears the floor on
 *      the strength of a word the user never said.
 *
 * Both end the same way: the Sources panel citing ServiceNow documentation for
 * a question it has nothing to do with.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nha-relevance-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({ rag: { enabled: true, corpusDir: scratch, allowedHosts: [], minRelevance: 0.45 } });

const { admitByQuestion } = await import('../src/knowledge/context.js');

const ACL_CHUNK = {
  chunk: 1, document: 'd1', seq: 0, text: 'A write ACL evaluates the role list before the script.',
  source: 'servicenow-docs', product: 'Now Platform', topic: 'security', version: 'Australia',
  document_type: 'documentation', updated_at: '2026-06-23', title: 'Configure an ACL',
  url: 'https://www.servicenow.com/docs/r/platform-security/access-control/t_CreateAnACLRule.html',
};
const OTHER_CHUNK = { ...ACL_CHUNK, chunk: 2, title: 'Access Control Lists (ACLs)' };

test('K3b — capability padding cannot manufacture relevance', () => {
  /*
   * The widened query matched; the question did not. Measured on the real
   * corpus: "What is the capital of France?" scored 0.362, and the same
   * question with "acl" appended scored 0.512 — over the floor purely because
   * of a term carried in from an earlier turn about ACLs.
   */
  const wide = [{ ...ACL_CHUNK, score: 0.512 }, { ...OTHER_CHUNK, score: 0.48 }];
  const direct = [];                                   // the question matched nothing
  assert.deepEqual(admitByQuestion(wide, direct), [],
    'an unrelated question cited ServiceNow documentation on the strength of a padded query');
});

test('K3b — the gate keeps what the question itself matched', () => {
  const wide = [{ ...ACL_CHUNK, score: 0.66 }, { ...OTHER_CHUNK, score: 0.52 }];
  const direct = [{ ...ACL_CHUNK, score: 0.64 }];
  const kept = admitByQuestion(wide, direct);
  assert.equal(kept.length, 1, 'the gate discarded a genuinely relevant document');
  assert.equal(kept[0].url, ACL_CHUNK.url, 'the real URL did not survive the gate');
});

test('K3b — the gate is total: missing or empty inputs yield nothing, never everything', () => {
  assert.deepEqual(admitByQuestion(undefined, undefined), []);
  assert.deepEqual(admitByQuestion([{ ...ACL_CHUNK, score: 1 }], undefined), [],
    'a failed question-side search admitted everything');
});

test('K3b — the relevance floor is configuration, and it is applied', () => {
  /*
   * Read through the module's own accessor rather than asserted as a literal,
   * so retuning it for a larger corpus is a settings change and this test
   * follows rather than fights it. What is asserted is that a floor EXISTS and
   * sits between the measured bands: unrelated topped out at 0.381, relevant
   * bottomed out at 0.566.
   */
  const src = fs.readFileSync(new URL('../src/knowledge/store.js', import.meta.url), 'utf8');
  assert.match(src, /minRelevance/, 'the relevance floor is gone');
  assert.match(src, /score >= floor/, 'the floor is declared but not applied');
  const m = /DEFAULT_MIN_RELEVANCE = ([\d.]+)/.exec(src);
  assert.ok(m, 'no default relevance floor');
  const floor = Number(m[1]);
  assert.ok(floor > 0.381 && floor < 0.566,
    `the floor ${floor} is outside the measured gap between unrelated (<=0.381) and relevant (>=0.566)`);
});

test('K3b — retrieval is skipped, not faked, when there is nothing to search', async () => {
  /*
   * An empty corpus must produce an empty block, not a block that says
   * something. Driven through the real retrieveForTurn against the scratch
   * database, which has no documents in it.
   */
  const { retrieveForTurn } = await import('../src/knowledge/context.js');
  const r = await retrieveForTurn('How do I create an ACL on the Incident table?');
  assert.equal(r.retrieval?.hits?.length ?? 0, 0);
  assert.equal(r.block, '', 'an empty corpus produced a context block');
});

test('K3b — a question too short to search is refused rather than guessed at', async () => {
  const { retrieveForTurn } = await import('../src/knowledge/context.js');
  const r = await retrieveForTurn('acl');
  assert.equal(r.retrieval, null);
  assert.equal(r.skipped, 'query-too-short');
  assert.equal(r.block, '');
});
