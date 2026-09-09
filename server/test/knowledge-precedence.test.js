import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveConflict, canAuthorize, assertNotAuthorizedByKnowledge,
  authorityRank, precedenceBlock, AUTHORITY_ORDER, AUTHORITATIVE_SOURCES,
} from '../src/knowledge/precedence.js';

/*
 * K4 — the conflict ladder.
 *
 * Live PDI state > actual tool/SDK capability > current official documentation
 * > LLM knowledge. Pure functions, no database, no instance.
 *
 * The tests that matter most here are the two REFUSALS: that retrieved
 * documentation can never authorise an action, and that an undecidable conflict
 * produces a question rather than a pick. Those are the properties that make it
 * safe to put official documentation into the system prompt at all.
 */

const claim = (source, says, evidence) => ({ source, says, ...(evidence ? { evidence } : {}) });

/* ── the ordering ─────────────────────────────────────────────────────────── */

test('the ladder is exactly the four sources, in the required order', () => {
  assert.deepEqual([...AUTHORITY_ORDER], ['live_pdi', 'tool_capability', 'documentation', 'model_knowledge']);
  assert.ok(authorityRank('live_pdi') < authorityRank('tool_capability'));
  assert.ok(authorityRank('tool_capability') < authorityRank('documentation'));
  assert.ok(authorityRank('documentation') < authorityRank('model_knowledge'));
});

test('an unrecognised source ranks below everything known rather than throwing', () => {
  assert.ok(authorityRank('a-blog-post') > authorityRank('model_knowledge'));
});

test('live PDI state beats documentation', () => {
  const res = resolveConflict({
    question: 'Does incident have a vendor_hold field?',
    claims: [
      claim('documentation', 'incident.vendor_hold exists in this release'),
      claim('live_pdi', 'incident has no vendor_hold field', 'get_table_schema: 84 fields, none named vendor_hold'),
    ],
  });
  assert.equal(res.verdict, 'resolved');
  assert.equal(res.answer, 'incident has no vendor_hold field');
  assert.equal(res.winner.source, 'live_pdi');
  assert.equal(res.overruled[0].source, 'documentation');
  assert.equal(res.canAuthorize, true);
});

/* ── the spec's own example ───────────────────────────────────────────────── */

test('documented-but-unsupported resolves AGAINST the documentation', () => {
  // "Documentation says feature exists BUT installed SDK does not support it"
  // -> do NOT generate or execute an imaginary implementation.
  const res = resolveConflict({
    question: 'Can the SDK author catalog_ui_policy_action records over REST?',
    claims: [
      claim('documentation', 'the REST Table API supports writing catalog_ui_policy_action'),
      claim('tool_capability', 'catalog_ui_policy_action cannot be written over REST; it must go through the SDK',
        'measured: POST returns 201 and the record does not appear'),
    ],
  });
  assert.equal(res.verdict, 'resolved');
  assert.match(res.answer, /cannot be written over REST/);
  assert.equal(res.winner.source, 'tool_capability');
  assert.equal(res.overruled.length, 1);
  assert.match(res.overruled[0].why, /Overruled by/);
});

/* ── RAG NEVER AUTHORISES ─────────────────────────────────────────────────── */

test('only live state and real capability can authorise; documentation never can', () => {
  assert.deepEqual([...AUTHORITATIVE_SOURCES], ['live_pdi', 'tool_capability']);
  assert.equal(canAuthorize(['live_pdi']), true);
  assert.equal(canAuthorize(['tool_capability']), true);
  assert.equal(canAuthorize(['documentation']), false);
  assert.equal(canAuthorize(['model_knowledge']), false);
  // The dangerous combination: a lot of documentation is still not one reading.
  assert.equal(canAuthorize(['documentation', 'model_knowledge']), false);
});

test('a documentation-only win carries canAuthorize:false and says what is still needed', () => {
  const res = resolveConflict({
    question: 'What does the sys_user_role table store?',
    claims: [claim('documentation', 'it stores role definitions')],
  });
  assert.equal(res.verdict, 'resolved');
  assert.equal(res.canAuthorize, false, 'documentation alone must never authorise');
  assert.match(res.reason, /may not authorise an action/);
  assert.match(res.reason, /read-back|capability check/);
});

test('assertNotAuthorizedByKnowledge throws on documentation and passes on a read-back', () => {
  assert.throws(
    () => assertNotAuthorizedByKnowledge('drop a column', ['documentation']),
    /Refusing to authorise "drop a column"/,
  );
  assert.throws(
    () => assertNotAuthorizedByKnowledge('create a field', ['documentation', 'model_knowledge']),
    /never authorise an action/,
  );
  assert.equal(assertNotAuthorizedByKnowledge('create a field', ['live_pdi']), true);
});

/* ── an assertion is not a reading ────────────────────────────────────────── */

test('a live_pdi claim with NO evidence is demoted to model knowledge', () => {
  // The most dangerous shape in the design: the model's belief about live state
  // wearing live state's authority.
  const res = resolveConflict({
    question: 'Is the field there?',
    claims: [
      claim('live_pdi', 'the field is there'),                         // no evidence
      claim('documentation', 'the field was removed in this release'),
    ],
  });
  assert.equal(res.demoted.length, 1);
  assert.equal(res.demoted[0].demotedFrom, 'live_pdi');
  assert.match(res.demoted[0].demotionReason, /no evidence/);
  // Demoted below documentation, so documentation now wins — and still cannot
  // authorise anything.
  assert.equal(res.winner.source, 'documentation');
  assert.equal(res.canAuthorize, false);
});

test('a tool_capability claim with evidence keeps its rank', () => {
  const res = resolveConflict({
    question: 'q',
    claims: [claim('tool_capability', 'not supported', 'compiler: unknown option "x"')],
  });
  assert.equal(res.demoted.length, 0);
  assert.equal(res.winner.source, 'tool_capability');
  assert.equal(res.canAuthorize, true);
});

/* ── when it cannot decide, it ASKS ───────────────────────────────────────── */

test('two contradictory claims at the SAME rung stop and ask', () => {
  const res = resolveConflict({
    question: 'Which release introduced this behaviour?',
    claims: [
      claim('documentation', 'it was introduced in Alpha'),
      claim('documentation', 'it was introduced in Charlie'),
    ],
  });
  assert.equal(res.verdict, 'stop_and_ask');
  assert.equal(res.winner, null, 'no winner may be invented to break a same-rung tie');
  assert.match(res.reason, /cannot break a tie within one rung/);
  assert.match(res.ask, /introduced in Alpha/);
  assert.match(res.ask, /introduced in Charlie/);
  assert.match(res.ask, /I will not pick one/);
});

test('two AGREEING claims at the same rung resolve rather than asking', () => {
  const res = resolveConflict({
    question: 'q',
    claims: [claim('documentation', 'the same answer'), claim('documentation', 'The Same Answer')],
  });
  assert.equal(res.verdict, 'resolved');
});

test('no claims at all stops and asks rather than answering from nothing', () => {
  const res = resolveConflict({ question: 'Does this table exist?', claims: [] });
  assert.equal(res.verdict, 'stop_and_ask');
  assert.match(res.ask, /Does this table exist\?/);
  assert.equal(res.canAuthorize, false);
});

/* ── the prompt text and the code cannot drift ────────────────────────────── */

test('the prompt block states the same ladder the code enforces', () => {
  // A prompt that promises an ordering the code does not apply is worse than
  // no prompt, so the rendered block is checked against AUTHORITY_ORDER itself
  // rather than against a copy of it written out here.
  const block = precedenceBlock();
  const LABEL = {
    live_pdi: 'live PDI state',
    tool_capability: 'tool / SDK capability',
    documentation: 'official documentation',
    model_knowledge: 'LLM knowledge',
  };
  const positions = AUTHORITY_ORDER.map((s) => {
    const at = block.indexOf(LABEL[s]);
    assert.ok(at >= 0, `the block must name ${LABEL[s]}`);
    return at;
  });
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i - 1] < positions[i],
      `${LABEL[AUTHORITY_ORDER[i - 1]]} must be listed above ${LABEL[AUTHORITY_ORDER[i]]}`);
  }
  assert.match(block, /NEVER authorise/i);
  assert.match(block, /stop and ask the human/i);
});
