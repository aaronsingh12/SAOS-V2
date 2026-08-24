/**
 * F12 — the iteration budget, said out loud, and said EPHEMERALLY.
 *
 *   node --test server/test/
 *
 * THE DEFECT. The agent loop stops after a fixed number of LLM calls, and the
 * model can see neither the cap, nor how many calls it has spent, nor how many
 * remain. Every instruction of the form "wrap up cleanly as you approach the
 * cap" was therefore unexecutable — it asked the model to act on a quantity it
 * has no access to.
 *
 * Live 2026-08-24 is the bill for that. A phase turn died on iteration 15 of
 * 15 with sys_ids resolved but never saved and no report of what had been
 * done. `remember_fact` spends an iteration like any other tool call, so the
 * turn that is diligent about persisting what it learned hits the cap SOONER.
 *
 * Two halves, and the second is the one with teeth:
 *
 *   1. the notice appears in the outbound system prompt exactly when three or
 *      fewer calls remain, and says something the model can act on;
 *   2. it is EPHEMERAL — it never touches a history row, and it never reaches
 *      the digest builder. A stale "only 1 call remains", folded into a
 *      summary, is a lie told to every later turn in the session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-iter-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { buildSystemPrompt, iterationBudgetNotice, ITERATION_NOTICE_AT } =
  await import('../src/agent/prompts.js');
const { toOpenAiMessages } = await import('../src/agent/providers/openaiCompat.js');
const { createSession, appendMessage, loadHistory } = await import('../src/memory/sessions.js');
const { compactIfNeeded, buildDigestNote } = await import('../src/memory/compaction.js');

const MARKER = 'ITERATION BUDGET';

/** The loop's own arithmetic: remaining = MAX_ITERATIONS - i. */
const remainingAt = (cap, i) => cap - i;

/* ------------------------------------------------------------------ *
 * 1. It appears when it should, and says something actionable
 * ------------------------------------------------------------------ */

test('the notice is absent until the last three calls', () => {
  for (let remaining = 30; remaining > ITERATION_NOTICE_AT; remaining--) {
    assert.equal(iterationBudgetNotice(remaining), '',
      `${remaining} calls left is not a wind-down — a notice there truncates turns that were going to finish`);
  }
  for (let remaining = ITERATION_NOTICE_AT; remaining >= 1; remaining--) {
    assert.ok(iterationBudgetNotice(remaining).startsWith(MARKER), `${remaining} calls left must warn`);
  }
});

test('the notice quotes the number that is left, and what to do with it', () => {
  const n = iterationBudgetNotice(3);
  // The count is the whole point: "you are near the cap" is no more actionable
  // than the instruction it replaces.
  assert.match(n, /only 3 LLM call\(s\) remain in this turn/);
  // The three actions, in the order they have to happen: stop, save, report.
  assert.match(n, /Stop starting new work/);
  assert.match(n, /Save any unsaved sys_ids as facts now/);
  assert.match(n, /DONE \/ REMAINING report/);
  assert.match(n, /end the turn/);
  assert.match(iterationBudgetNotice(1), /only 1 LLM call\(s\) remain/);
});

test('a 30-call turn is warned at 27, not before and not too late', () => {
  // The two numbers from F14, tied together: with a cap of 30 the first warned
  // iteration is i=27, and there are three calls left to act on it.
  const cap = 30;
  const warned = [];
  for (let i = 0; i < cap; i++) {
    if (iterationBudgetNotice(remainingAt(cap, i))) warned.push(i);
  }
  assert.deepEqual(warned, [27, 28, 29]);
  assert.match(iterationBudgetNotice(remainingAt(cap, 27)), /only 3 LLM call\(s\)/);
});

/* ------------------------------------------------------------------ *
 * 2. It goes out in the system prompt, and NOWHERE else
 * ------------------------------------------------------------------ */

test('the notice reaches the outbound system message and no other message', () => {
  const history = [
    { role: 'user', text: 'build the remaining variables' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'query_records', input: { table: 'item_option_new' } }] },
    { role: 'tool', results: [{ id: 'c1', name: 'query_records', output: '[]' }] },
  ];
  const quiet = buildSystemPrompt({ digestNote: '', mutationDigest: '' });
  const warned = buildSystemPrompt({ digestNote: '', mutationDigest: '', iterationNotice: iterationBudgetNotice(2) });

  const a = toOpenAiMessages(quiet, history).messages;
  const b = toOpenAiMessages(warned, history).messages;

  assert.ok(!a[0].content.includes(MARKER), 'a turn with room left must not be told to wrap up');
  assert.ok(b[0].content.includes(MARKER), 'the notice never reached the request');
  assert.equal(a[0].role, 'system');

  // THE invariant: every message that is not the system prompt is byte-identical
  // with and without the notice. If the notice ever leaks into history, this is
  // where it shows up.
  assert.equal(a.length, b.length);
  for (let i = 1; i < a.length; i++) {
    assert.equal(JSON.stringify(b[i]), JSON.stringify(a[i]), `message ${i} changed because of an ephemeral block`);
  }
});

test('the notice is appended last, after the mutation ledger', () => {
  // It is an instruction about what to do NEXT. Buried above a long ledger
  // dump it is the block most likely to be skimmed past.
  const s = buildSystemPrompt({
    mutationDigest: 'MUTATIONS THIS TURN\n- created incident INC0012345',
    iterationNotice: iterationBudgetNotice(1),
  });
  assert.ok(s.indexOf(MARKER) > s.indexOf('MUTATIONS THIS TURN'), 'the wind-down must be the nearest thing to the completion');
});

test('an ephemeral block is not a stored block — history and digests never see it', async () => {
  const id = 'iter-ephemeral';
  createSession({ id });
  for (let i = 0; i < 30; i++) appendMessage(id, { role: 'user', text: `turn ${i} ` + 'z'.repeat(2000) });

  // Whatever the model was told about its remaining budget, the rows written
  // for the turn are the conversation — not the harness's arithmetic about it.
  for (const m of loadHistory(id)) {
    assert.ok(!JSON.stringify(m).includes(MARKER), 'an iteration notice was persisted to history');
  }

  const res = await compactIfNeeded(id, {
    budget: 2_000,
    summarize: async (input) => {
      // The compactor's own input is the other half: a notice folded into a
      // summary would outlive the turn it was true for and mislead every later
      // one.
      assert.ok(!JSON.stringify(input).includes(MARKER), 'the digest builder was shown an ephemeral block');
      return 'ARTIFACTS BUILT OR CHANGED\n- none\nRECORDS ONLY LOOKED AT\n- none\nDECISIONS\n- none\nOPEN THREADS\n- none';
    },
  });
  assert.equal(res.compacted, true, 'the fixture must actually compact for this to prove anything');
  assert.ok(!buildDigestNote(id).includes(MARKER), 'the notice survived into the digest');
});
