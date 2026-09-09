/**
 * PHASE 19 — RETRIEVAL, RANKING AND THE SHAPE OF A KNOWLEDGE ITEM.
 *
 * §53's five suites are folded into three by subject rather than by section
 * number: this one is the pipeline (§8, §11, §26, §31, §32, §58, §62), the
 * authority suite is the truth hierarchy (§54, §55, §59, §60, §71), and the
 * security suite is isolation and secrets (§56, §57, §61) plus the architecture
 * boundary. §53 permits the names to differ; what it does not permit is a
 * requirement with no test, and the three together carry all of them.
 *
 * NOTHING HERE TOUCHES A DATABASE OR AN INSTANCE. Every store is a function
 * returning literals, which is the whole point of the domain taking its stores
 * as parameters — the retrieval logic is testable without any of the three real
 * stores existing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as K from '../src/agent/knowledge/index.js';

const INST = 'dev424910.service-now.com';
const OTHER = 'dev999999.service-now.com';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const fact = (over = {}) => ({
  instance: INST,
  kind: 'trap',
  key: 'priority-is-calculated',
  value: 'priority is derived from impact + urgency on this instance.',
  provenance: 'measured on dev424910',
  confidence: 0.95,
  ts: '2026-09-04T00:00:00Z',
  ...over,
});

const observation = (over = {}) => ({
  id: 1,
  category: 'sdk-limitation',
  subject: 'GlideDateTimeColumn',
  observation: 'The installed SDK rejects generated GlideDateTimeColumn for datetime fields.',
  evidence_kind: 'compile-output',
  evidence: 'error TS2554: expected 1 argument',
  instance: INST,
  observed_at: '2026-08-01T00:00:00Z',
  confirmed_at: '2026-08-02T00:00:00Z',
  confirmations: 2,
  ...over,
});

const chunk = (over = {}) => ({
  document: 'doc-1',
  seq: 0,
  text: 'Priority is a task attribute derived from impact and urgency.',
  source: 'servicenow-docs',
  product: 'ITSM',
  topic: 'incident',
  version: 'Tokyo',
  version_rank: 3,
  document_type: 'documentation',
  url: 'https://docs.servicenow.com/priority',
  updated_at: '2024-01-01',
  title: 'Task priority',
  score: 6,
  ...over,
});

const stores = ({ facts = [], observations = [], hits = [], mode = 'semantic', fail = null } = {}) => ({
  facts: async () => { if (fail === 'facts') throw new Error('database is locked'); return facts; },
  observations: async () => { if (fail === 'observations') throw new Error('database is locked'); return observations; },
  documents: async () => {
    if (fail === 'documents') throw new Error('the embedding model went away');
    return { mode, hits };
  },
});

/* ================================================================== *
 * §4 — the item shape
 * ================================================================== */

test('R1 — every store produces a well-formed knowledge item', () => {
  const items = [
    K.fromFact(fact()),
    K.fromObservation(observation()),
    K.fromDocumentChunk(chunk()),
  ];
  for (const item of items) {
    assert.ok(K.isKnowledgeItem(item), `${item?.id} is not a well-formed knowledge item`);
    assert.ok(item.scope, 'an item with no scope cannot be isolated');
    assert.ok(item.provenance.source, 'an item with no source cannot be cited');
  }
});

test('R2 — a documentation chunk is GLOBAL and an instance fact is not', () => {
  /*
   * The load-bearing distinction for §9. The corpus has no instance column
   * because it describes ServiceNow rather than a ServiceNow instance, and that
   * is exactly why it may reach every instance and why nothing else may.
   */
  assert.equal(K.fromDocumentChunk(chunk()).scope.level, K.SCOPES.GLOBAL);
  assert.equal(K.fromDocumentChunk(chunk()).scope.instance, null);
  assert.equal(K.fromFact(fact()).scope.instance, INST);
  assert.equal(K.fromFact(fact({ instance: '*' })).scope.level, K.SCOPES.GLOBAL);
});

test('R3 — a capability observation is a ledger fact; an anecdote is historical', () => {
  /*
   * §11's warning, made mechanical: "it worked once" must not outrank
   * documentation for every future case.
   */
  assert.equal(K.fromObservation(observation({ category: 'sdk-limitation' })).provenance.authority, K.AUTHORITY.LEDGER);
  assert.equal(K.fromObservation(observation({ category: 'tooling-defect' })).provenance.authority, K.AUTHORITY.LEDGER);
  assert.equal(K.fromObservation(observation({ category: 'implementation-success' })).provenance.authority, K.AUTHORITY.HISTORICAL);

  assert.ok(K.authorityRank(K.AUTHORITY.LEDGER) < K.authorityRank(K.AUTHORITY.DOCUMENTATION));
  assert.ok(K.authorityRank(K.AUTHORITY.DOCUMENTATION) < K.authorityRank(K.AUTHORITY.HISTORICAL));
});

test('R4 — a live item cannot be built without evidence', () => {
  /* A live fact with no reading behind it is a belief wearing live authority,
   * which is the most dangerous shape in this whole design. */
  assert.throws(
    () => K.fromLiveReading({ id: 'x', statement: 'priority is writable', evidence: null }),
    /no evidence/i,
  );
  const ok = K.fromLiveReading({ id: 'x', statement: 'p', evidence: 'read-back', scope: { instance: INST } });
  assert.equal(ok.provenance.authority, K.AUTHORITY.LIVE);
  assert.equal(K.itemCanAuthorize(ok), true);
});

/* ================================================================== *
 * §8 / §26 — the pipeline
 * ================================================================== */

test('R5 — the pipeline runs every store and reports what it found', async () => {
  const r = await K.retrieve({
    query: 'How does priority behave?',
    stores: stores({ facts: [fact()], observations: [observation()], hits: [chunk()] }),
    scope: { instance: INST, table: 'incident' },
  });
  assert.equal(r.complete, true);
  assert.ok(r.items.length >= 2);
  assert.equal(r.unavailable.length, 0);
  assert.ok(r.timings.total_ms >= 0);
});

test('R6 — §26: the same query over the same corpus ranks identically', async () => {
  const opts = {
    query: 'priority impact urgency',
    stores: stores({ facts: [fact()], observations: [observation()], hits: [chunk(), chunk({ document: 'doc-2', seq: 1, score: 6 })] }),
    scope: { instance: INST },
  };
  const a = await K.retrieve(opts);
  const b = await K.retrieve(opts);
  assert.deepEqual(a.items.map((x) => x.id), b.items.map((x) => x.id));
});

test('R7 — ties break on the id, never on arrival order', () => {
  /* A sort whose ties resolve by insertion order is deterministic by accident,
   * and the accident ends the first time a store returns rows differently. */
  const mk = (id) => ({ id, score: { final: 0.5 } });
  assert.deepEqual(K.rank([mk('b'), mk('a'), mk('c')]).map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(K.rank([mk('c'), mk('b'), mk('a')]).map((x) => x.id), ['a', 'b', 'c']);
});

test('R8 — §11: authority outranks relevance, and by design it cannot be outrun', () => {
  /*
   * §11's closing sentence is "never let old highly relevant documentation
   * override current live facts". That is only true if the authority gap
   * between two rungs exceeds the entire relevance range, which is a property
   * of the weights and is asserted here rather than hoped for.
   */
  const liveItem = K.fromLiveReading({ id: 'l', statement: 'derived', evidence: 'read', scope: { instance: INST } });
  const doc = K.fromDocumentChunk(chunk({ text: 'priority impact urgency derived task attribute', score: 10 }));

  const liveScore = K.scoreItem(liveItem, { terms: [] });           // zero relevance
  const docScore = K.scoreItem(doc, { terms: ['priority', 'impact', 'urgency'] }); // perfect relevance

  assert.ok(
    liveScore.final > docScore.final,
    `a perfectly relevant doc (${docScore.final.toFixed(3)}) outranked an irrelevant live fact (${liveScore.final.toFixed(3)})`,
  );
  assert.equal(Object.isFrozen(K.WEIGHTS), true, 'the ranking weights must be a frozen literal, not a view');
});

test('R9 — §32: near-identical items from the same authority collapse, and the count survives', () => {
  const text = 'Priority is derived from impact and urgency on this instance.';
  const items = [
    { id: 'a', content: text, provenance: { authority: K.AUTHORITY.DOCUMENTATION }, score: { final: 0.9 } },
    { id: 'b', content: `${text} `, provenance: { authority: K.AUTHORITY.DOCUMENTATION }, score: { final: 0.8 } },
    { id: 'c', content: text, provenance: { authority: K.AUTHORITY.DOCUMENTATION }, score: { final: 0.7 } },
  ];
  const out = K.deduplicate(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a', 'the highest-ranked survivor must win');
  assert.equal(out[0].duplicates, 2, 'the number of agreeing sources is information and must survive');
});

test('R10 — the same text from DIFFERENT authorities is never collapsed', () => {
  /*
   * "Documentation says X" and "the live instance says X" is a corroboration
   * worth seeing. Collapsing them would destroy exactly the distinction §21
   * exists to preserve.
   */
  const text = 'Priority is derived from impact and urgency.';
  const out = K.deduplicate([
    { id: 'live', content: text, provenance: { authority: K.AUTHORITY.LIVE }, score: { final: 0.9 } },
    { id: 'doc', content: text, provenance: { authority: K.AUTHORITY.DOCUMENTATION }, score: { final: 0.5 } },
  ]);
  assert.equal(out.length, 2);
});

/* ================================================================== *
 * §31 / §62 — budget
 * ================================================================== */

test('R11 — §62: a corpus larger than the budget is bounded, and says it was clipped', async () => {
  const many = Array.from({ length: 60 }, (_, i) => chunk({
    document: `doc-${i}`,
    seq: i,
    text: `priority ${'x'.repeat(3000)}`,
    score: 5,
  }));
  const r = await K.retrieve({ query: 'priority', stores: stores({ hits: many }), scope: { instance: INST } });

  assert.ok(r.items.length <= K.LIMITS.MAX_RESULTS, `${r.items.length} items exceeded the ${K.LIMITS.MAX_RESULTS} budget`);
  for (const item of r.items) {
    assert.ok(item.content.length <= K.LIMITS.MAX_CHARS_PER_ITEM + 1, 'an item exceeded the per-item budget');
    assert.equal(item.clipped, true);
    assert.ok(item.full_length > item.content.length, 'a clipped item must say how much was dropped');
  }
});

test('R12 — the unsearched stores are held to a relevance floor', async () => {
  /*
   * The fact ledger has no query engine — it returns everything scoped to the
   * instance. Without a floor every question retrieves the whole ledger, and
   * authority alone would let twenty unrelated traps crowd out the
   * documentation that actually answers the question.
   */
  const unrelated = Array.from({ length: 12 }, (_, i) => fact({
    key: `unrelated-trap-${i}`,
    value: 'Update sets do not capture data rows, only configuration records.',
  }));
  const r = await K.retrieve({
    query: 'priority impact urgency',
    stores: stores({ facts: [fact(), ...unrelated], hits: [chunk()] }),
    scope: { instance: INST },
  });
  const keys = r.items.map((x) => x.title);
  assert.ok(keys.includes('priority-is-calculated'), 'the on-subject fact was dropped');
  assert.ok(!keys.some((k) => String(k).startsWith('unrelated-trap')), 'an off-subject fact reached the answer');
  assert.ok(r.off_subject >= 12, 'the off-subject count must be reported');
});

/* ================================================================== *
 * §28 / §47 / §58 — degradation and failure
 * ================================================================== */

test('R13 — §58: with embeddings unavailable, FTS results still come back — and say so', async () => {
  const r = await K.retrieve({
    query: 'priority',
    stores: stores({ hits: [chunk()], mode: 'keyword' }),
    scope: { instance: INST },
  });
  assert.equal(r.items.length, 1, 'the keyword fallback returned nothing');
  assert.equal(r.degraded, true);
  assert.equal(r.mode, 'keyword');
});

test('R14 — §80.8: a store that FAILED is never reported as a store that found nothing', async () => {
  const r = await K.retrieve({
    query: 'priority',
    stores: stores({ fail: 'documents', facts: [fact()] }),
    scope: { instance: INST },
  });
  assert.equal(r.complete, false, 'a failed store must make the retrieval incomplete');
  assert.equal(r.unavailable.length, 1);
  assert.equal(r.unavailable[0].store, 'documents');
  assert.match(r.unavailable[0].reason, /embedding model/);

  /* And the other stores still ran — one failure is not a total outage. */
  assert.ok(r.items.length >= 1);
});

test('R15 — when every store fails the verdict is UNAVAILABLE, not NO_KNOWLEDGE', async () => {
  const all = {
    facts: async () => { throw new Error('locked'); },
    observations: async () => { throw new Error('locked'); },
    documents: async () => { throw new Error('locked'); },
  };
  const r = await K.answerQuestion({ question: 'What is the standard process?', stores: all, scope: { instance: INST } });
  assert.equal(r.verdict, K.VERDICTS.RETRIEVAL_UNAVAILABLE);
  assert.match(K.renderAnswer(r), /NOT the\s+same as finding nothing/i);
});

test('R16 — §43: finding nothing is stated, never implied by an empty section', async () => {
  const r = await K.answerQuestion({
    question: 'What does our runbook say about vending machines?',
    stores: stores({}),
    scope: { instance: INST },
  });
  assert.equal(r.verdict, K.VERDICTS.NO_KNOWLEDGE);
  assert.match(K.renderAnswer(r), /No relevant instance-specific knowledge was found/);
});

/* ================================================================== *
 * §18 / §19 — classification
 * ================================================================== */

test('R17 — §18: execution-sensitive questions are LIVE_TRUTH_REQUIRED', () => {
  const live = [
    'Can I write this field?',
    'Can I delete this record?',
    'Is this capability available?',
    'Which user should I assign?',
    'What is the table name?',
    'What is this artifact\'s current state?',
    'Is incident.priority read-only?',
    'What type is incident.priority?',
  ];
  for (const q of live) {
    const c = K.classifyQuestion(q);
    assert.equal(c.classification, K.QUESTION.LIVE_TRUTH_REQUIRED, `"${q}" was not classified as needing live truth`);
    assert.ok(c.why.length, 'a classification must be able to say why');
  }
});

test('R18 — §19: process, history and documentation questions are answerable from knowledge', () => {
  const contextual = [
    'What is the standard process?',
    'What did we do last time?',
    'What does our runbook recommend?',
    'What does ServiceNow documentation say about flows?',
    'What do we know about this ServiceNow instance?',
  ];
  for (const q of contextual) {
    assert.equal(K.classifyQuestion(q).classification, K.QUESTION.CONTEXT_OK, `"${q}" was misclassified`);
  }
});

test('R19 — a question that is both is treated as needing live truth', () => {
  /*
   * It fails towards the instance on purpose. The cost of a needless live read
   * is a read; the cost of the other mistake is an answer about someone else's
   * instance stated as fact about yours.
   */
  const c = K.classifyQuestion('What is the standard process for checking whether incident.priority is writable?');
  assert.equal(c.classification, K.QUESTION.LIVE_TRUTH_REQUIRED);
  assert.ok(c.also_matched.includes('process'), 'the contextual match should still be reported');
});

test('R20 — subjects are extracted for the caller to read, not read here', () => {
  const subjects = K.subjectsOf('Can I write incident.priority on sys_user?');
  assert.deepEqual(subjects[0], { kind: 'field', table: 'incident', field: 'priority', raw: 'incident.priority' });
  assert.ok(subjects.some((s) => s.kind === 'table' && s.table === 'sys_user'));
});

/* ================================================================== *
 * §21 — the answer model
 * ================================================================== */

test('R21 — live facts and retrieved knowledge are never merged into one list', async () => {
  const liveEvidence = async () => ([K.fromLiveReading({
    id: 'incident.priority', title: 'incident.priority',
    statement: 'incident.priority is derived from impact and urgency.',
    evidence: 'derivationOf', scope: { instance: INST, table: 'incident' }, tool: 'get_table_schema',
  })]);
  const r = await K.answerQuestion({
    question: 'What type is incident.priority?',
    stores: stores({ facts: [fact()], hits: [chunk()] }),
    scope: { instance: INST, table: 'incident' },
    liveEvidence,
  });

  assert.equal(r.live_facts.length, 1);
  assert.ok(r.knowledge.length >= 1);
  const liveIds = new Set(r.live_facts.map((x) => x.id));
  for (const k of r.knowledge) {
    assert.ok(!liveIds.has(k.id), 'a live fact appeared in the knowledge list');
    assert.notEqual(k.provenance.authority, K.AUTHORITY.LIVE, 'a retrieved item carries live authority');
  }
});

test('R22 — §20: every citation is copied from an item, and carries whether it authorises', async () => {
  const r = await K.answerQuestion({
    question: 'What does documentation say about priority?',
    stores: stores({ facts: [fact()], hits: [chunk()] }),
    scope: { instance: INST },
  });
  assert.ok(r.sources.length >= 1);
  for (const c of r.sources) {
    const item = r.knowledge.find((k) => k.id === c.id);
    assert.ok(item, `citation ${c.id} does not correspond to any retrieved item`);
    assert.equal(c.source, item.provenance.source);
    assert.equal(c.ref, item.provenance.ref);
    assert.equal(typeof c.authorises, 'boolean');
  }
  /* A documentation citation can never authorise. */
  const doc = r.sources.find((c) => c.authority === K.AUTHORITY.DOCUMENTATION);
  assert.equal(doc.authorises, false);
});

test('R23 — §74: a cancelled question keeps what it gathered and concludes nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  const r = await K.answerQuestion({
    question: 'What is the standard process?',
    stores: stores({ facts: [fact()] }),
    scope: { instance: INST },
    signal: controller.signal,
  });
  assert.equal(r.verdict, K.VERDICTS.CANCELLED);
  assert.equal(r.conflicts.length, 0);
  assert.match(K.renderAnswer(r), /Cancelled/);
});


/* ================================================================== *
 * REGRESSIONS — each found by the real PDI run, not by review
 * ================================================================== */

test('R24 — a semantic score is a cosine, not a bm25, and is not divided by ten', () => {
  /*
   * FOUND BY PDI-1. Both stores' scores were normalised by dividing by ten.
   * That is right for FTS (a negated bm25, roughly 0..20) and catastrophic for
   * a cosine (0..1): every semantic hit was crushed to about 0.05, so a
   * document that answered the question exactly ranked below every trap in the
   * ledger and was cut by the result budget. The conflict scenario then found
   * no conflict — not because the ladder failed, but because the contradicting
   * page never reached it.
   */
  const semantic = K.scoreItem(
    { ...K.fromDocumentChunk(chunk({ score: 0.83 })), retrieval_mode: 'semantic' },
    { terms: ['nothing'] },
  );
  const keyword = K.scoreItem(
    { ...K.fromDocumentChunk(chunk({ score: 8.3 })), retrieval_mode: 'keyword' },
    { terms: ['nothing'] },
  );
  assert.ok(Math.abs(semantic.retrieval - 0.83) < 1e-9, `a cosine of 0.83 scored ${semantic.retrieval}`);
  assert.ok(Math.abs(keyword.retrieval - 0.83) < 1e-9, `a bm25 of 8.3 scored ${keyword.retrieval}`);
});

test('R25 — one authority cannot take every slot in the budget', async () => {
  /*
   * FOUND BY PDI-1, and it is the second half of the same defect. A ledger
   * entry outranks a documentation chunk on authority by design, and with
   * forty-five facts in the ledger that design filled all eight slots with
   * traps and dropped the one page that answered the question.
   *
   * Authority decides which source WINS a disagreement. It was never meant to
   * decide which sources a reader gets to SEE.
   */
  const manyFacts = Array.from({ length: 20 }, (_, i) => fact({
    key: `write-trap-${i}`,
    value: 'A write to this can be accepted and silently dropped.',
  }));
  const r = await K.retrieve({
    query: 'write dropped silently accepted',
    stores: stores({ facts: manyFacts, hits: [chunk({ text: 'a write is accepted and dropped silently', score: 0.9 })] }),
    scope: { instance: INST },
  });

  const authorities = new Set(r.items.map((x) => x.provenance.authority));
  assert.ok(authorities.has(K.AUTHORITY.DOCUMENTATION), 'the documentation was crowded out by the ledger');
  assert.ok(authorities.has(K.AUTHORITY.LEDGER));
  assert.ok(r.items.length <= K.LIMITS.MAX_RESULTS);
});

test('R26 — §43: a nearest neighbour that is not a neighbour is not an answer', async () => {
  /*
   * FOUND BY PDI-5. A cosine search returns the closest vectors it has
   * REGARDLESS of how far away they are, so with two documents in the corpus
   * every question retrieved both — including one about the colour of the moon.
   * The run reported ANSWERED, with citations, for a subject nothing in the
   * build knows anything about.
   *
   * The floor is measured rather than guessed: on this model, on-subject hits
   * scored 0.74 and 0.83, off-subject 0.33 to 0.48.
   */
  const far = await K.retrieve({
    query: 'What colour is the moon on Tuesdays?',
    stores: stores({ hits: [chunk({ text: 'priority is derived from impact and urgency', score: 0.40 })] }),
    scope: { instance: INST },
  });
  assert.equal(far.items.length, 0, 'an unrelated document was returned as relevant');

  const near = await K.retrieve({
    query: 'What colour is the moon on Tuesdays?',
    stores: stores({ hits: [chunk({ text: 'the moon appears grey on every day of the week', score: 0.78 })] }),
    scope: { instance: INST },
  });
  assert.equal(near.items.length, 1, 'a genuinely close semantic hit was dropped');
  assert.ok(K.SEMANTIC_FLOOR > 0.48 && K.SEMANTIC_FLOOR < 0.74, 'the floor no longer separates the measured clusters');
});

test('R27 — a long question demands more than one matched word from an unsearched store', async () => {
  /*
   * FOUND BY PDI-5 as well. "What is our standard process for provisioning
   * orbital telemetry uplinks?" retrieved eight traps, because "process"
   * appears in a great many of them and one hit out of six cleared a floor of
   * "greater than zero".
   */
  const r = await K.retrieve({
    query: 'What is our standard process for provisioning orbital telemetry uplinks?',
    stores: stores({
      facts: [
        fact({ key: 'generic', value: 'This describes a standard approach to something else entirely.' }),
        fact({ key: 'relevant', value: 'Our standard process for provisioning is documented here.' }),
      ],
    }),
    scope: { instance: INST },
  });
  const titles = r.items.map((x) => x.title);
  assert.ok(!titles.includes('generic'), 'a fact matching one ubiquitous word was returned');
  assert.ok(titles.includes('relevant'), 'a fact matching several query terms was dropped');
});
