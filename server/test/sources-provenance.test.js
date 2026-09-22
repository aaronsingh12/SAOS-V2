import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saos-sources-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));
const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev000000.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { getDb } = await import('../src/memory/db.js');
const { currentActor } = await import('../src/memory/audit.js');

const CLIENT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');
/* sourceModel.js is plain JavaScript with no React import, so the panel's
   normaliser is exercised directly rather than pattern-matched. */
const { toSources, docKey } = await import(url.pathToFileURL(path.join(CLIENT, 'components', 'sourceModel.js')).href);

/*
 * SOURCES — actual retrieval provenance, for the current turn only.
 *
 * The Online Docs list is built from the retrieval rows that NAME the task
 * of the assistant response on screen. A document that exists in the corpus
 * but was not retrieved for that response has no row and cannot appear; a
 * document retrieved for an earlier turn belongs to that turn's task; chunks
 * of one document are one source.
 */

let n = 0;
function session() {
  const sid = `src-${++n}`;
  const now = new Date().toISOString();
  /* A session belongs to the bound instance; a task refuses a session of another. */
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated, instance) VALUES (?, ?, ?, ?)').run(sid, now, now, currentActor().instance ?? null);
  return sid;
}
function turn(sessionId, goal) {
  const t = createTask({ sessionId, goal });
  startTask(t.id);
  return t.id;
}
let seq = 0;
/** What the orchestrator writes for an automatic retrieval that found something. */
function retrieval(sessionId, taskId, query, hits) {
  getDb().prepare(
    `INSERT INTO tool_events
       (session, seq, kind, name, payload, result, result_status, mutating, approval,
        approved_source, approved_at, instance, actor, ts, task_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(sessionId, ++seq, 'tool_call', 'knowledge_retrieval', JSON.stringify({ query, automatic: true }),
    JSON.stringify({ query, indexed: 3, mode: 'semantic', degraded: false, hits }), 'ok', 0, null, null, null, null, null, new Date().toISOString(), taskId);
}
const hit = (document, title, urlStr, chunk = 1, extra = {}) => ({
  chunk, document, seq: chunk, text: 'chunk body', source: 'servicenow-docs', product: 'Now Platform',
  topic: title.toLowerCase(), version: 'Yokohama', version_rank: 5, document_type: 'documentation',
  url: urlStr, updated_at: '2026-06-01', title, score: 0.7, ...extra,
});
const CATALOG = hit('doc-cat', 'Create a catalog item', 'https://www.servicenow.com/docs/r/catalog/t_CreateACatalogItem.html');
const VARIABLES = hit('doc-var', 'Catalog variables', 'https://www.servicenow.com/docs/r/catalog/c_CatalogVariables.html');
const FLOW = hit('doc-flow', 'Flow Designer', 'https://www.servicenow.com/docs/r/flow-designer/c_FlowDesigner.html');
const ACL = hit('doc-acl', 'Configure an ACL', 'https://www.servicenow.com/docs/r/platform-security/access-control/t_CreateAnACLRule.html');

const onlineDocs = (taskId) => toSources(buildEvidence(taskId)).find((c) => c.key === 'docs').items;
const titles = (items) => items.map((i) => i.title).sort();

test('a turn shows exactly the documents its retrieval returned — not the corpus, not a default list', () => {
  const sid = session();
  const t = turn(sid, 'Create a Service Catalog item for a new laptop request.');
  retrieval(sid, t, 'catalog item laptop request', [CATALOG, VARIABLES]);
  const docs = onlineDocs(t);
  assert.deepEqual(titles(docs), ['Catalog variables', 'Create a catalog item']);
  assert.ok(docs.every((d) => d.url?.startsWith('https://www.servicenow.com/docs/')), 'a card links somewhere other than the retrieved document');
  assert.equal(docs.some((d) => /ACL/.test(d.title)), false, 'a document that was never retrieved for this turn appeared');
});

test('consecutive turns in one chat do not leak: each response carries only its own retrieval', () => {
  const sid = session();
  const t1 = turn(sid, 'Create a catalog item');
  retrieval(sid, t1, 'catalog item', [CATALOG, VARIABLES]);
  const t2 = turn(sid, 'Create an approval flow for this catalog item');
  retrieval(sid, t2, 'approval flow catalog item', [FLOW]);
  const t3 = turn(sid, 'Who can read incidents?');
  retrieval(sid, t3, 'read incidents access', [ACL]);
  assert.deepEqual(titles(onlineDocs(t1)), ['Catalog variables', 'Create a catalog item']);
  assert.deepEqual(titles(onlineDocs(t2)), ['Flow Designer'], 'turn 2 accumulated turn 1\'s documents');
  assert.deepEqual(titles(onlineDocs(t3)), ['Configure an ACL']);
});

test('a turn whose retrieval found nothing has no Online Docs — no generic fallback', () => {
  const sid = session();
  const t = turn(sid, 'Say hello');
  /* The orchestrator writes NO row for an empty retrieval; a tool search that ran and found nothing is recorded with hits: [] */
  getDb().prepare(
    `INSERT INTO tool_events (session, seq, kind, name, payload, result, result_status, mutating, approval, approved_source, approved_at, instance, actor, ts, task_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(sid, ++seq, 'tool_call', 'search_servicenow_docs', JSON.stringify({ query: 'q' }), JSON.stringify({ query: 'q', indexed: 2, hits: [] }), 'ok', 0, null, null, null, null, null, new Date().toISOString(), t);
  assert.deepEqual(onlineDocs(t), []);
});

test('the same document retrieved several times in one turn — six chunks, two rows — is one source', () => {
  const sid = session();
  const t = turn(sid, 'Create a record producer');
  retrieval(sid, t, 'record producer', [1, 2, 3, 4].map((c) => hit('doc-acl', 'Configure an ACL', ACL.url, c)));
  retrieval(sid, t, 'record producer (model search)', [hit('doc-acl', 'Configure an ACL', `${ACL.url}#section-2`, 5), hit('doc-acl', 'Configure an ACL', ACL.url, 6)]);
  const docs = onlineDocs(t);
  assert.equal(docs.length, 1, `${docs.length} cards for one document`);
  assert.equal(docs[0].title, 'Configure an ACL');
});

test('dedupe keys: document id first, then the canonical URL (fragment and trailing slash ignored), then the title', () => {
  assert.equal(docKey({ document: 'd1', url: 'https://x/a', title: 'A' }), 'doc:d1');
  assert.equal(docKey({ url: 'https://X.example/docs/a/#frag' }), docKey({ url: 'https://x.example/docs/a' }));
  assert.equal(docKey({ title: 'Flow Designer ' }), 'title:flow designer');
  assert.equal(docKey({}), null);
  /* Two different documents on one host are two sources. */
  assert.notEqual(docKey({ url: CATALOG.url }), docKey({ url: VARIABLES.url }));
});

test('another chat\'s retrieval never reaches this chat: evidence is per task, and a task belongs to one session', () => {
  const a = session();
  const ta = turn(a, 'Catalog work');
  retrieval(a, ta, 'catalog', [CATALOG]);
  const b = session();
  const tb = turn(b, 'ACL work');
  retrieval(b, tb, 'acl', [ACL]);
  assert.deepEqual(titles(onlineDocs(ta)), ['Create a catalog item']);
  assert.deepEqual(titles(onlineDocs(tb)), ['Configure an ACL']);
});

test('a retrieval row written under another task is excluded even when it falls inside this task\'s window', () => {
  const sid = session();
  const t1 = turn(sid, 'first');
  const t2 = turn(sid, 'second');           // both open, overlapping windows
  retrieval(sid, t1, 'first', [FLOW]);
  retrieval(sid, t2, 'second', [ACL]);
  assert.deepEqual(titles(onlineDocs(t1)), ['Flow Designer']);
  assert.deepEqual(titles(onlineDocs(t2)), ['Configure an ACL']);
});

test('the panel empties before it reloads, and Online Docs says plainly when nothing was used', () => {
  const PANEL = fs.readFileSync(path.join(CLIENT, 'components', 'SourcesPanel.jsx'), 'utf8');
  assert.match(PANEL, /useEffect\(\(\) => \{ setEv\(null\); setErr\(null\); load\(\); \}, \[load\]\)/, 'the previous turn\'s evidence stays on screen while the next loads');
  assert.match(PANEL, /No online sources were used for this response\./);
  assert.doesNotMatch(PANEL, /DEFAULT_DOCS|FALLBACK_DOCS|defaultSources/, 'a default document list is back');
  const MODEL = fs.readFileSync(path.join(CLIENT, 'components', 'sourceModel.js'), 'utf8');
  assert.doesNotMatch(MODEL, /includes\('catalog'\)|includes\('flow'\)|includes\('acl'\)/i, 'Online Docs are being guessed from keywords');
});
