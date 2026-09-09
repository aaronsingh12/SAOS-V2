/**
 * PHASE 19 — THE TRUTH HIERARCHY, AND WHAT HAPPENS WHEN IT IS TESTED.
 *
 * §2 states the whole phase in one line: retrieved knowledge may provide
 * context and must never silently override higher-authority live truth. Six of
 * the fourteen release blockers in §80 are restatements of it.
 *
 * This suite is adversarial about that rule rather than confirmatory. Every
 * test below sets up the situation in which the wrong answer is the CONVENIENT
 * one — documentation that is confident, recent, perfectly relevant, and wrong
 * — and asserts that it loses anyway.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as K from '../src/agent/knowledge/index.js';
import { canAuthorize, AUTHORITATIVE_SOURCES } from '../src/knowledge/precedence.js';

const INST = 'dev424910.service-now.com';

const liveFact = (statement, over = {}) => K.fromLiveReading({
  id: over.id ?? 'incident.priority',
  title: over.title ?? 'incident.priority',
  statement,
  evidence: over.evidence ?? 'derivationOf(incident, priority) -> { from: [impact, urgency] }',
  scope: { instance: INST, table: 'incident', ...over.scope },
  at: '2026-09-07T00:00:00Z',
  tool: over.tool ?? 'get_table_schema',
});

/**
 * A raw corpus hit, as `searchKnowledge` returns one.
 *
 * The stores hand back HITS and the pipeline converts them. Passing an
 * already-converted item into a store makes `fromDocumentChunk` receive
 * something with `content` instead of `text`, which it correctly refuses — so
 * the two helpers are kept apart rather than one doing double duty.
 */
const docHit = (text, over = {}) => ({
  document: over.document ?? 'doc-1',
  seq: 0,
  text,
  source: 'servicenow-docs',
  product: 'ITSM',
  topic: 'incident',
  version: 'Tokyo',
  version_rank: 9,
  document_type: 'documentation',
  url: over.url ?? 'https://docs.servicenow.com/priority',
  updated_at: over.updated_at ?? '2026-09-01',
  title: over.title ?? 'Incident priority',
  score: 10,
  ...over,
});

/** The same hit, converted — for the functions that take items directly. */
const docSaying = (text, over = {}) => K.fromDocumentChunk(docHit(text, over));

const storesWith = ({ facts = [], observations = [], hits = [] }) => ({
  facts: async () => facts,
  observations: async () => observations,
  documents: async () => ({ mode: 'semantic', hits }),
});

/* ================================================================== *
 * §54 — the ordering itself
 * ================================================================== */

test('A1 — §54: live > documentation, verified trap > model knowledge, instance fact > global doc', () => {
  assert.ok(K.authorityRank(K.AUTHORITY.LIVE) < K.authorityRank(K.AUTHORITY.DOCUMENTATION));
  assert.ok(K.authorityRank(K.AUTHORITY.LEDGER) < K.authorityRank(K.AUTHORITY.MODEL));
  assert.ok(K.authorityRank(K.AUTHORITY.LEDGER) < K.authorityRank(K.AUTHORITY.DOCUMENTATION));
  assert.ok(K.authorityRank(K.AUTHORITY.DOCUMENTATION) < K.authorityRank(K.AUTHORITY.HISTORICAL));
  assert.ok(K.authorityRank(K.AUTHORITY.HISTORICAL) < K.authorityRank(K.AUTHORITY.MODEL));
});

test('A2 — the six-rung ranking ladder maps onto the four-rung authorising one', () => {
  /*
   * Two ladders exist because ranking and authorising are different questions.
   * They must never disagree about the ONE thing they share: what may authorise
   * an action. `canAuthorize` in precedence.js remains the only decider, and
   * this asserts the mapping feeds it correctly.
   */
  const live = liveFact('derived');
  const verifiedLedger = K.fromObservation({
    id: 1, category: 'sdk-limitation', subject: 'x', observation: 'y',
    evidence_kind: 'compile-output', evidence: 'stderr', instance: INST,
    observed_at: '2026-01-01', confirmed_at: '2026-01-02', confirmations: 1,
  });
  const doc = docSaying('anything');

  assert.equal(K.authorisingSourceOf(live), 'live_pdi');
  assert.equal(K.authorisingSourceOf(verifiedLedger), 'tool_capability');
  assert.equal(K.authorisingSourceOf(doc), 'documentation');

  assert.equal(canAuthorize([K.authorisingSourceOf(live)]), true);
  assert.equal(canAuthorize([K.authorisingSourceOf(verifiedLedger)]), true);
  assert.equal(canAuthorize([K.authorisingSourceOf(doc)]), false);

  for (const s of AUTHORITATIVE_SOURCES) {
    assert.ok(['live_pdi', 'tool_capability'].includes(s), 'the authorising set changed without this mapping being revisited');
  }
});

test('A3 — §13: an UNVERIFIED ledger entry does not receive elevated trust', () => {
  /*
   * "Only verified knowledge may receive elevated trust." A fact row with no
   * provenance is a row somebody inserted, and it must not be able to authorise
   * anything just because it lives in the ledger table.
   */
  const verified = K.fromFact({
    instance: INST, kind: 'trap', key: 'k', value: 'v',
    provenance: 'measured on dev424910', ts: '2026-01-01',
  });
  const bare = K.fromFact({ instance: INST, kind: 'trap', key: 'k', value: 'v', provenance: null, ts: '2026-01-01' });

  assert.equal(K.isVerified(verified), true);
  assert.equal(K.itemCanAuthorize(verified), true);

  assert.equal(K.isVerified(bare), false);
  assert.equal(K.itemCanAuthorize(bare), false, 'an unverified ledger row was allowed to authorise');
  assert.equal(K.authorisingSourceOf(bare), 'documentation');
});

/* ================================================================== *
 * §55 / §64 / §71 — the conflict
 * ================================================================== */

test('A4 — §55/§71: live says derived, documentation says writable — live wins and the conflict is surfaced', async () => {
  const r = await K.answerQuestion({
    question: 'Can I write incident.priority?',
    stores: storesWith({ hits: [docHit('The priority field is writable and may be set directly on the incident form.')] }),
    scope: { instance: INST, table: 'incident' },
    liveEvidence: async () => ([liveFact('incident.priority is derived from impact and urgency on this instance.')]),
  });

  assert.equal(r.verdict, K.VERDICTS.ANSWERED_WITH_CONFLICT);
  assert.equal(r.conflicts.length, 1);

  const c = r.conflicts[0];
  assert.equal(c.conflict, true);
  assert.equal(c.authority_winner, 'live_pdi', 'documentation was allowed to win');
  assert.match(c.higher_authority.says, /derived/);
  assert.equal(c.lower_authority.length, 1);
  assert.match(c.lower_authority[0].says, /writable/);

  /* §24 — do not hide the conflict. */
  const md = K.renderAnswer(r);
  assert.match(md, /Conflict/);
  assert.match(md, /Overruled/);
  assert.match(md, /differs from the retrieved knowledge/);
});

test('A5 — §35: winning a conflict authorises nothing', () => {
  const c = K.adjudicate({
    question: 'Can I write incident.priority?',
    live: [liveFact('incident.priority is derived and read-only in practice.')],
    knowledge: [docSaying('priority is writable')],
    subjects: [{ kind: 'field', table: 'incident', field: 'priority' }],
  })[0];
  assert.equal(c.authorises, false, 'a resolved conflict must not read as permission');
});

test('A6 — §12: the item the instance contradicted becomes STALE; an unrelated one does not', async () => {
  const r = await K.answerQuestion({
    question: 'Can I write incident.priority?',
    stores: storesWith({
      hits: [
        docHit('The priority field is writable and may be set directly.', { document: 'd1', title: 'Incident priority' }),
        docHit('Flow Designer triggers fire when a record matches the condition.', { document: 'd2', title: 'Flow triggers', url: 'https://docs.servicenow.com/flow' }),
      ],
    }),
    scope: { instance: INST, table: 'incident' },
    liveEvidence: async () => ([liveFact('incident.priority is derived from impact and urgency.')]),
  });

  const contradicted = r.knowledge.find((k) => k.title === 'Incident priority');
  const unrelated = r.knowledge.find((k) => k.title === 'Flow triggers');
  assert.equal(contradicted.freshness.state, K.FRESHNESS.STALE, 'a contradicted document was not marked stale');
  assert.match(contradicted.freshness.stale_because, /live instance contradicts/);
  /* Freshness is EVIDENCE-based (§12): an equally old page nothing contradicted
   * stays UNKNOWN rather than being aged out by the calendar. */
  assert.equal(unrelated.freshness.state, K.FRESHNESS.UNKNOWN);
});

test('A7 — a conflict is not manufactured between items about different things', () => {
  const c = K.adjudicate({
    question: 'Can I write incident.priority?',
    live: [liveFact('incident.priority is derived from impact and urgency.')],
    knowledge: [docSaying('The urgency field is writable on the incident form.', { title: 'Incident urgency' })],
    subjects: [{ kind: 'field', table: 'incident', field: 'priority' }],
  });
  /*
   * A report full of invented disagreements is worse than one that misses a
   * real one: the real one is still visible in the sources, and the invented
   * ones train a reader to skip the section.
   */
  assert.equal(c.length, 0, 'a conflict was manufactured between priority and urgency');
});

/* ================================================================== *
 * §60 — live enrichment
 * ================================================================== */

test('A8 — §60: with contradictory documentation, the answer is the live one', async () => {
  const r = await K.answerQuestion({
    question: 'What type is incident.priority?',
    stores: storesWith({ hits: [docHit('priority is a writable integer field set directly by the user.')] }),
    scope: { instance: INST, table: 'incident' },
    liveEvidence: async () => ([liveFact('incident.priority is derived from impact and urgency on this instance.')]),
  });

  const md = K.renderAnswer(r);
  /* The live section appears before the documentation section, and the closing
   * line says which is authoritative. */
  assert.ok(md.indexOf('### Live evidence') < md.indexOf('### Documentation'));
  assert.match(md, /The live instance is the authoritative source for the current behaviour\./);
  /* And the documentation is still SHOWN — §2 permits it to say what it says. */
  assert.match(md, /writable integer field/);
});

test('A9 — §68: a live-truth question with no live reading is INSUFFICIENT_EVIDENCE, not a doc answer', async () => {
  /*
   * The tempting failure is to answer from documentation with a caveat
   * attached. A reader takes the answer and leaves the caveat, which is why
   * §68 asks for a refusal rather than a hedge.
   */
  const r = await K.answerQuestion({
    question: 'Is incident.priority writable?',
    stores: storesWith({ hits: [docHit('priority is writable and may be set directly.')] }),
    scope: { instance: INST, table: 'incident' },
    liveEvidence: null,
  });

  assert.equal(r.verdict, K.VERDICTS.INSUFFICIENT_EVIDENCE);
  assert.equal(r.live_facts.length, 0);
  assert.ok(r.unknowns.some((u) => u.reason === 'live_truth_required'));

  const md = K.renderAnswer(r);
  assert.match(md, /Insufficient evidence/);
  /* The documentation is still offered as context, clearly labelled. */
  assert.match(md, /### Documentation/);
  assert.match(md, /Read the instance before acting/);
});

/* ================================================================== *
 * §22 / §23 / §59 / §72 — promotion
 * ================================================================== */

test('A10 — §59/§22: a model-shaped statement cannot become an instance fact', () => {
  const r = K.proposeKnowledge({
    statement: 'this field is read-only',
    live: [],
    knowledge: [docSaying('the field is read-only')],
    instance: INST,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_live_evidence');
  assert.equal(r.candidate, null);
  assert.match(r.note, /retrieved text alone/);
});

test('A11 — §23/§72: a corroborated statement produces a CANDIDATE, and stores nothing', () => {
  const r = K.proposeKnowledge({
    statement: 'priority is derived from impact and urgency on this instance.',
    live: [liveFact('incident.priority is derived from impact and urgency.')],
    knowledge: [docSaying('priority is a derived task attribute.')],
    instance: INST,
  });

  assert.equal(r.ok, true);
  assert.ok(r.candidate);
  /* Shaped for the observation store, which independently requires an evidence
   * kind AND the artifact — so the refusal does not depend on this being right. */
  assert.ok(r.candidate.evidenceKind);
  assert.ok(r.candidate.evidence);
  assert.equal(r.candidate.instance, INST);
  assert.match(r.note, /CANDIDATE/);

  /* Nothing was written: the function has no store to write to. */
  const source = readFile('../src/agent/knowledge/index.js');
  assert.equal(/recordFact|recordObservation\s*\(/.test(stripComments(source)), false,
    'the knowledge domain can write to a store');
});

/* ================================================================== *
 * §11 — ordering under pressure
 * ================================================================== */

test('A12 — a recent, perfectly relevant document still ranks below a live fact', async () => {
  const r = await K.answerQuestion({
    question: 'priority impact urgency incident derived writable',
    stores: storesWith({ hits: [docHit('priority impact urgency incident derived writable', { updated_at: '2026-09-06' })] }),
    scope: { instance: INST, table: 'incident' },
    liveEvidence: async () => ([liveFact('priority is derived.')]),
  });

  const all = [...r.live_facts, ...r.knowledge];
  const md = K.renderAnswer(r);
  assert.ok(md.indexOf('### Live evidence') < md.indexOf('### Documentation'));
  assert.equal(all[0].provenance.authority, K.AUTHORITY.LIVE);
});

/* ------------------------------------------------------------------ */

import fs from 'node:fs';
function readFile(rel) {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
