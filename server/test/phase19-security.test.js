/**
 * PHASE 19 — ISOLATION, SECRETS, AND THE ARCHITECTURE BOUNDARY.
 *
 * Three of §80's release blockers live here and each fails silently in
 * production if it is not tested:
 *
 *   §80.1  instance A's knowledge appearing on instance B
 *   §80.6  a credential surviving ingestion
 *   §80.9  knowledge causing an approval bypass
 *
 * None of the three announces itself. A cross-instance fact reads exactly like
 * a local one; a leaked credential reads like documentation; and a bypass looks
 * like a helpful answer. So each is asserted structurally — against the import
 * graph and against the source text — as well as behaviourally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import * as K from '../src/agent/knowledge/index.js';
import { redact } from '../src/agent/evidence/redact.js';

const A = 'dev424910.service-now.com';
const B = 'dev999999.service-now.com';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOMAIN = path.join(HERE, '..', 'src', 'agent', 'knowledge');
const files = () => fs.readdirSync(DOMAIN).filter((f) => f.endsWith('.js'));
const read = (f) => fs.readFileSync(path.join(DOMAIN, f), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const factOn = (instance, key, value) => ({
  instance, kind: 'trap', key, value, provenance: `measured on ${instance}`, ts: '2026-01-01T00:00:00Z',
});

const storesWith = ({ facts = [], observations = [], hits = [] }) => ({
  facts: async () => facts,
  observations: async () => observations,
  documents: async () => ({ mode: 'semantic', hits }),
});

/* ================================================================== *
 * §9 / §56 / §80.1 — instance isolation
 * ================================================================== */

test('S1 — §56: querying instance A returns A\'s fact and the global doc, never B\'s fact', async () => {
  const r = await K.retrieve({
    query: 'priority behaviour trap',
    stores: storesWith({
      facts: [
        factOn(A, 'a-trap', 'priority behaviour trap measured here on A.'),
        factOn(B, 'b-trap', 'priority behaviour trap measured on B.'),
        factOn('*', 'universal-trap', 'priority behaviour trap that holds on every instance.'),
      ],
      hits: [{
        document: 'd', seq: 0, text: 'priority behaviour trap documentation', source: 'servicenow-docs',
        product: 'ITSM', topic: 'incident', version: 'Tokyo', version_rank: 1,
        document_type: 'documentation', url: 'https://docs.servicenow.com/x', updated_at: '2024-01-01',
        title: 'Priority', score: 5,
      }],
    }),
    scope: { instance: A },
  });

  const titles = r.items.map((x) => x.title);
  assert.ok(titles.includes('a-trap'), 'the local fact was dropped');
  assert.ok(titles.includes('universal-trap'), 'a universal fact must reach every instance');
  assert.ok(titles.includes('Priority'), 'global documentation must reach every instance');
  assert.equal(titles.includes('b-trap'), false, 'CROSS-INSTANCE LEAK: another PDI\'s fact was returned');

  /* §73 — the exclusion is recorded, with its reason. A leak is invisible when
   * it happens and obvious in a log of what the filter refused. */
  assert.equal(r.isolated_out.length, 1);
  assert.match(r.isolated_out[0].reason, /learned on dev999999/);
});

test('S2 — the isolation check is a whitelist: anything it cannot parse is refused', () => {
  /*
   * A scope check that silently fails to match fails OPEN unless it is written
   * not to. There are exactly two admitting branches and no third.
   */
  const cases = [
    { scope: { level: K.SCOPES.INSTANCE, instance: null }, admitted: false },
    { scope: { level: K.SCOPES.INSTANCE, instance: '' }, admitted: false },
    { scope: { level: K.SCOPES.INSTANCE, instance: B }, admitted: false },
    { scope: { level: K.SCOPES.INSTANCE, instance: A }, admitted: true },
    { scope: { level: K.SCOPES.GLOBAL, instance: null }, admitted: true },
    { scope: { level: 'SOMETHING_NEW', instance: 'not-a-url' }, admitted: false },
  ];
  for (const c of cases) {
    const v = K.admits({ id: 'x', scope: c.scope }, { instance: A });
    assert.equal(v.admitted, c.admitted, `${JSON.stringify(c.scope)} → ${v.admitted}: ${v.reason}`);
    assert.ok(v.reason, 'both admission and refusal must carry a reason');
  }
});

test('S3 — an unbound session admits global knowledge and nothing else', () => {
  assert.equal(K.admits({ scope: { level: K.SCOPES.INSTANCE, instance: A } }, { instance: null }).admitted, false);
  assert.equal(K.admits({ scope: { level: K.SCOPES.GLOBAL, instance: null } }, { instance: null }).admitted, true);
});

test('S4 — instance identity survives protocol, trailing slash and case', () => {
  /* Two stores with two spellings is how a scope check starts matching by luck. */
  for (const spelling of [`https://${A}`, `https://${A}/`, A.toUpperCase(), `HTTPS://${A}///`]) {
    assert.equal(
      K.admits({ scope: { level: K.SCOPES.INSTANCE, instance: spelling } }, { instance: A }).admitted,
      true,
      `${spelling} was not recognised as ${A}`,
    );
  }
  assert.equal(K.normalizeInstance(`https://${A}/`), A);
});

test('S5 — §57: a trap scoped to one instance is not presented as universally true', async () => {
  const r = await K.answerQuestion({
    question: 'Is there a known trap with the datetime column generator?',
    stores: storesWith({
      facts: [factOn(A, 'datetime-column-generator-defect', 'The datetime column generator is rejected by this SDK.')],
    }),
    scope: { instance: A },
  });

  const item = r.knowledge.find((k) => k.title === 'datetime-column-generator-defect');
  assert.ok(item, 'the trap was not retrieved for its own instance');
  assert.equal(item.scope.level, K.SCOPES.INSTANCE);
  assert.equal(item.scope.instance, A);

  /* The rendered answer says which instance it was learned on, so a reader
   * cannot take it for a universal rule. */
  assert.match(K.renderAnswer(r), new RegExp(`scope: ${A.replace(/\./g, '\\.')}`));

  /* And on another instance it is not returned at all. */
  const elsewhere = await K.answerQuestion({
    question: 'Is there a known trap with the datetime column generator?',
    stores: storesWith({ facts: [factOn(A, 'datetime-column-generator-defect', 'x')] }),
    scope: { instance: B },
  });
  assert.equal(elsewhere.knowledge.length, 0, 'an instance-scoped trap leaked to another instance');
});

/* ================================================================== *
 * §51 / §61 / §80.6 — secrets
 * ================================================================== */

test('S6 — §61: ingestion redacts credentials before a document is stored', async () => {
  /*
   * AUDITED GAP. Ingestion performed no redaction at all before this phase: a
   * corpus file holding a failing integration's own log — the ordinary way a
   * credential reaches a runbook — was stored verbatim, indexed into FTS,
   * embedded, and then retrieved into the model's context.
   *
   * The check runs against the REAL store on a throwaway database, because the
   * property being asserted is about the write path rather than about a helper.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p19sec-'));
  const { _setDbForTests, migrate } = await import('../src/memory/db.js');
  _setDbForTests(migrate(new DatabaseSync(path.join(dir, 'k.db'))));
  const { upsertDocument, getDocument, keywordSearchKnowledge } = await import('../src/knowledge/store.js');

  const secrets = 'To authenticate: password=hunter2 and token: abc123def456 with '
    + 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload and api_key = sk-live-9999.';

  const wrote = upsertDocument({
    source: 'servicenow-docs',
    product: 'ITSM',
    topic: 'integration',
    version: 'Tokyo',
    document_type: 'documentation',
    url: 'https://docs.servicenow.com/integration-auth',
    updated_at: '2026-01-01',
    title: 'Integration authentication',
    text: secrets,
  });
  assert.equal(wrote.ok, true, `the document was refused: ${JSON.stringify(wrote.errors)}`);
  assert.ok(
    (wrote.warnings ?? []).some((w) => /credential/i.test(w)),
    'redaction happened silently; the operator must be told their corpus held a credential',
  );

  const stored = getDocument(wrote.id);
  const body = JSON.stringify(stored);
  for (const leaked of ['hunter2', 'abc123def456', 'eyJhbGciOiJIUzI1NiJ9', 'sk-live-9999']) {
    assert.equal(body.includes(leaked), false, `${leaked} survived ingestion`);
  }
  assert.match(body, /\[redacted\]/);

  /* And it is not merely absent from the document row — it is absent from what
   * retrieval returns, which is what actually reaches a prompt. */
  const hits = keywordSearchKnowledge('authenticate', { limit: 5 });
  assert.equal(JSON.stringify(hits).includes('hunter2'), false, 'a credential reached retrieval');
});

test('S7 — §51: redaction is by NAME, so innocent prose and identifiers survive', () => {
  /* Over-redaction is its own failure: a corpus that redacts every hex string
   * loses the sys_ids that make a document useful. */
  assert.equal(redact('the password policy name is Standard'), 'the password policy name is Standard');
  assert.equal(
    redact('a sys_id 62826bf03710200044e0bfc8bcbe5d0d survives'),
    'a sys_id 62826bf03710200044e0bfc8bcbe5d0d survives',
  );
  assert.match(redact('password=hunter2'), /password=\[redacted\]/);
});

test('S8 — a knowledge answer built from a redacted corpus carries no credential', async () => {
  const r = await K.answerQuestion({
    question: 'How do we authenticate the integration?',
    stores: storesWith({
      hits: [{
        document: 'd', seq: 0,
        /* As it would be AFTER ingestion — the store never holds the original. */
        text: redact('Authenticate with password=hunter2 and token: abc123def456.'),
        source: 'servicenow-docs', product: 'ITSM', topic: 'integration', version: 'Tokyo',
        version_rank: 1, document_type: 'documentation',
        url: 'https://docs.servicenow.com/auth', updated_at: '2026-01-01', title: 'Auth', score: 5,
      }],
    }),
    scope: { instance: A },
  });
  const everything = JSON.stringify(r) + K.renderAnswer(r);
  for (const leaked of ['hunter2', 'abc123def456']) {
    assert.equal(everything.includes(leaked), false, `${leaked} reached the answer`);
  }
});

/* ================================================================== *
 * §35 / §77 / §80.9 / §80.10 / §80.11 — the architecture boundary
 * ================================================================== */

test('S9 — §77: the knowledge domain imports no client, no database and no provider', () => {
  const external = new Set();
  for (const f of files()) {
    for (const m of read(f).matchAll(/from\s+'([^']+)'/g)) {
      if (!m[1].startsWith('./')) external.add(m[1]);
    }
  }
  /*
   * Five reused pieces and nothing else. Each exists so that this phase and an
   * earlier one cannot disagree about the same question: the authority ladder,
   * the trap ledger, the observation store, the corpus search, and the redactor.
   */
  /*
   * The exact list, asserted. An earlier version of this compared the set to
   * ITSELF through a tangle of filters — tautologically true, and therefore no
   * guard at all. §77's boundary is the claim this whole directory rests on, so
   * it is asserted as an equality: a new external import fails here and has to
   * be argued for.
   *
   * Four reused pieces. Each exists so this phase and an earlier one cannot
   * disagree about the same question: the authority ladder, the trap ledger,
   * the observation store, and the corpus search.
   */
  assert.deepEqual([...external].sort(), [
    '../../knowledge/observations.js',
    '../../knowledge/precedence.js',
    '../../knowledge/store.js',
    '../../memory/facts.js',
  ]);

  for (const banned of ['servicenow/client.js', 'agent/orchestrator.js', 'plan/executor.js', 'providers/']) {
    assert.equal([...external].some((e) => e.includes(banned)), false, `the domain imports ${banned}`);
  }
  /* `memory/db.js` in particular: the domain holds no state and must not be
   * able to acquire any (§78 — no new table, no migration). */
  assert.equal([...external].some((e) => e.includes('memory/db.js')), false);
});

test('S10 — §35/§80.9: nothing in the domain can approve, execute or mutate', () => {
  const banned = [
    'executeTool', 'executePlan', 'approvePlan', 'awaitApprovalDecision', 'resolveApproval',
    'autoApprove', 'table.create', 'table.update', 'table.remove', 'recordFact(',
  ];
  for (const f of files()) {
    const src = stripComments(read(f));
    for (const b of banned) {
      assert.equal(src.includes(b), false, `${f} names ${b}`);
    }
  }
});

test('S11 — §80.9: no retrieval result can set autoApprove, anywhere in the build', () => {
  /*
   * Asserted against the whole source tree rather than this directory: the
   * blocker is not "the knowledge domain sets autoApprove", it is "knowledge
   * causes an approval bypass", and that could be written anywhere.
   */
  const root = path.join(HERE, '..', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = stripComments(fs.readFileSync(p, 'utf8'));
      /* An assignment of autoApprove from anything knowledge-shaped. */
      if (/autoApprove\s*[:=]\s*(?!false\b)[^,;)\n]*\b(knowledge|retriev|document|corpus|rag|hit|chunk)/i.test(src)) {
        offenders.push(path.relative(root, p));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], 'a retrieval result influences the approval gate');
});

test('S12 — §72: the domain has no path to write authoritative knowledge', () => {
  /*
   * `proposeKnowledge` returns a candidate shaped for the observation store and
   * writes nothing. The store itself is what refuses an entry with no evidence,
   * so the refusal does not depend on this domain being correct.
   */
  const src = stripComments(read('index.js'));
  assert.equal(/recordObservation\s*\(/.test(src), false, 'the domain calls the observation writer');
  assert.equal(/\bINSERT\b|\bUPDATE\b|getDb\(/.test(src), false, 'the domain writes to the database');
});

test('S13 — §50: the corpus search is called with the caller\'s own scope and nothing widened', async () => {
  /* Whatever a caller is entitled to see is what it asked for; the domain never
   * broadens a query to reach more than the caller scoped it to. */
  let sawLimit = null;
  await K.retrieve({
    query: 'anything at all',
    stores: {
      documents: async ({ limit }) => { sawLimit = limit; return { mode: 'semantic', hits: [] }; },
    },
    scope: { instance: A },
    limits: { perStore: 3 },
  });
  assert.equal(sawLimit, 3, 'the domain overrode the caller\'s limit');
});

test('S14 — every detector in this file fires on a violation', () => {
  /* A guard that cannot fail is not a guard. */
  assert.equal(
    K.admits({ scope: { level: K.SCOPES.INSTANCE, instance: B } }, { instance: A }).admitted,
    false,
    'the isolation detector does not reject a foreign instance',
  );
  assert.match(redact('token=leakme123'), /\[redacted\]/, 'the redaction detector does not fire');
  assert.equal(
    /autoApprove\s*[:=]\s*(?!false\b)[^,;)\n]*\b(knowledge|retriev)/i.test('autoApprove = knowledgeSaysSo'),
    true,
    'the approval-bypass detector does not fire on a real violation',
  );
  assert.equal(
    /autoApprove\s*[:=]\s*(?!false\b)[^,;)\n]*\b(knowledge|retriev)/i.test('autoApprove: Boolean(agent.autoApprove)'),
    false,
    'the approval-bypass detector false-positives on the legitimate setting',
  );
});
