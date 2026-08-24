/**
 * WI-2 / WI-3 — turn control: what ends a turn, and what may write inside one.
 *
 *   node --test server/test/
 *
 * THE DEFECT (docs/incidents/2026-08-24-ask-act.md). The agent rendered a
 * clarifying question — which of two incidents did you mean, INC0010052 or
 * INC0010053 — and then, with no user message in between, an approval card for
 * an update to one of them, which executed.
 *
 * WI-1 proved the mechanism from SQLite: the turn's first completion carried
 * prose and ZERO tool calls, the A6 stall guard matched "let me know", appended
 * its nudge as a user message and re-invoked the provider, and the second
 * completion emitted the write. Two completions, ten seconds apart, separated
 * by a message the harness wrote.
 *
 * So these tests are about the LOOP, not about a regex. They drive `runTurn`
 * against a scripted provider and assert the two things the incident turned on:
 * how many times the provider is asked to speak, and whether anything reached
 * the gate. Every one of them is offline — no instance, no model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-turn-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
/*
 * The whole world, stated. `llm.model` is blank on purpose: the context-window
 * probe returns its fallback without reaching for a daemon, so this file cannot
 * pass or fail on whether Ollama happens to be running.
 */
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'test' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { _setChatTurnForTests } = await import('../src/agent/providers/index.js');
const {
  runTurn, resolveApproval, assertContinuationsAccountFor, CONTINUATION_REASONS,
  detectUnexplainedMutation, ambiguousTarget, MAX_UNEXPLAINED_BOUNCES,
} = await import('../src/agent/orchestrator.js');
const { loadHistory, loadToolEvents } = await import('../src/memory/sessions.js');

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/**
 * A provider that says exactly what it is told to, once each.
 *
 * Asking for a completion the script does not have is an ERROR, not a fallback.
 * That is the assertion this whole file rests on: a loop that re-invokes the
 * provider when it should have stopped runs off the end of the script and says
 * so, rather than quietly borrowing the last response.
 */
function scriptProvider(...responses) {
  const seen = [];
  _setChatTurnForTests(async ({ history }) => {
    seen.push({ history: history.map((h) => ({ role: h.role, text: h.text || '', calls: (h.toolCalls || []).map((c) => c.name) })) });
    const next = responses[seen.length - 1];
    if (!next) throw new Error(`the loop asked for completion ${seen.length}; the script only has ${responses.length}`);
    return { text: '', toolCalls: [], stopReason: 'stop', ...next };
  });
  return seen;
}

const call = (name, input = {}, id = `c-${name}`) => ({ id, name, input });

let n = 0;
const newSession = () => `turn-control-${++n}`;

async function run(userText, ...responses) {
  const seen = scriptProvider(...responses);
  const sessionId = newSession();
  const events = [];
  await runTurn(sessionId, userText, (e) => events.push(e));
  return {
    sessionId,
    providerCalls: seen.length,
    seen,
    events,
    of: (type) => events.filter((e) => e.type === type),
    guards: () => loadToolEvents(sessionId).filter((e) => e.kind === 'guard'),
    toolEvents: () => loadToolEvents(sessionId),
    history: () => loadHistory(sessionId),
  };
}

/**
 * Answer the gate the way a click does — on a LATER tick.
 *
 * `approval_required` is emitted before `awaitApproval` registers its resolver,
 * so resolving inside the emit finds nothing and the turn waits out the full
 * five-minute timeout. That is the real ordering, not a test artefact: a click
 * always arrives on a later tick too.
 */
function autoDecide(sessionId, events, approved) {
  return (e) => {
    events.push(e);
    if (e.type === 'approval_required') {
      setImmediate(() => {
        const ok = resolveApproval(sessionId, e.approvalId, approved);
        if (!ok) throw new Error(`the gate never registered approval ${e.approvalId}`);
      });
    }
  };
}

/* ------------------------------------------------------------------ *
 * WI-2 — a response with no tool calls ends the turn
 * ------------------------------------------------------------------ */

test('a plain answer ends the turn after ONE provider call', async () => {
  const r = await run('who is INC0010052 assigned to?', { text: 'It is assigned to Beth Anglin.' });
  assert.equal(r.providerCalls, 1, 'the loop spoke to the provider more than once for a plain answer');
  assert.equal(r.of('done').length, 1);
  assert.equal(r.of('approval_required').length, 0);
  assert.equal(r.of('nudged').length, 0);
});

test('THE REGRESSION — a clarifying question ends the turn, and nothing reaches the gate', async () => {
  /*
   * The incident, reconstructed. The user's message is verbatim; "change" in it
   * is what IS_DIRECTIVE matched, and "let me know" in the reply is what
   * ASKS_TO_PROCEED matched. Before the fence, this pair nudged and the second
   * completion below executed. The script HAS that second completion, so if the
   * loop continues it will run it and this test will fail on the gate rather
   * than on a missing response.
   */
  const r = await run(
    'acha ek kaam karo pripity ko change karke LOW kardo.',
    {
      text: 'I found two open incidents for this caller: INC0010052 (the parent) and INC0010053 (the child). '
        + 'Let me know and I will set the priority.',
    },
    { toolCalls: [call('update_record', { table: 'incident', sys_id: '49b1d0538336cf50b939cc65eeaad3b7', data: { priority: '4' } })] },
  );

  assert.equal(r.providerCalls, 1, 'the loop re-invoked the provider after a text-only question — this is the defect');
  assert.equal(r.of('approval_required').length, 0, 'an approval card was created for a question the user had not answered');
  assert.equal(r.of('nudged').length, 0, 'A6 fired on a clarifying question');
  assert.equal(r.of('done').length, 1);

  // The harness records the decision it made NOT to continue. `a6_stalled_turn`
  // is the row that made the original incident diagnosable after compaction had
  // folded the messages away; this is its counterpart.
  const guards = r.guards();
  assert.equal(guards.filter((g) => g.name === 'a6_stalled_turn').length, 0);
  const ended = guards.find((g) => g.name === 'turn_ended_on_question');
  assert.ok(ended, 'the turn ended on a question and left no record of it');
  assert.equal(ended.result_status, 'awaiting-user');
  assert.equal(ended.payload.reason, 'multiple-candidate-targets');
  assert.match(ended.payload.quote, /INC0010052/);
  assert.match(ended.payload.quote, /INC0010053/);
  assert.equal(r.of('awaiting_user').length, 1, 'the user was not told the turn is waiting on them');
});

test('a question that asks for a value ends the turn, by the other signal', async () => {
  const r = await run(
    'set the priority to low',
    { text: 'Which incident did you mean?' },
    { toolCalls: [call('update_record', { table: 'incident', sys_id: 'x', data: { priority: '4' } })] },
  );
  assert.equal(r.providerCalls, 1);
  assert.equal(r.of('approval_required').length, 0);
  assert.equal(r.guards().find((g) => g.name === 'turn_ended_on_question').payload.reason, 'asks-for-a-fact');
});

test('A6 still nudges a genuine stall — the ONE sanctioned continuation', async () => {
  /*
   * The failure A6 was written for, measured twice in three runs of the C-4
   * acceptance: everything resolved, nothing built, "shall I create it?".
   * Fencing A6 must not delete it — this is the test that says so.
   */
  const r = await run(
    'make the justification field mandatory when duration is Permanent',
    { text: 'I have the variable sys_ids and the choice value. Shall I create this UI Policy now?' },
    { text: 'Done — I will call the tool.' },
  );
  assert.equal(r.providerCalls, 2, 'A6 stopped nudging; the stalled-turn defect is back');
  assert.equal(r.of('nudged').length, 1);
  assert.ok(r.guards().some((g) => g.name === 'a6_stalled_turn'));
  assert.equal(r.of('awaiting_user').length, 0);
  // The nudge is a real history row, and it now says what to do when the
  // missing thing can only come from the user.
  const nudge = r.history().find((m) => m.role === 'user' && String(m.text).startsWith('SYSTEM:'));
  assert.ok(nudge, 'the nudge never reached the model');
  assert.match(nudge.text, /can only come from the\s+USER/);
  assert.match(nudge.text, /Never pick one and write to it/);
});

test('the continuation ledger is what permits another provider call', () => {
  // Iteration 0 needs no permission — it is the turn opening.
  assert.doesNotThrow(() => assertContinuationsAccountFor(0, []));
  assert.doesNotThrow(() => assertContinuationsAccountFor(1, [CONTINUATION_REASONS.TOOL_RESULTS]));
  assert.doesNotThrow(() => assertContinuationsAccountFor(2, [CONTINUATION_REASONS.A6_STALL_NUDGE, CONTINUATION_REASONS.TOOL_RESULTS]));

  // A `continue` added later without recording why it is legal.
  assert.throws(() => assertContinuationsAccountFor(1, []), /A response with no tool calls ends the turn/);
  assert.throws(() => assertContinuationsAccountFor(3, [CONTINUATION_REASONS.TOOL_RESULTS]), /only 1 sanctioned continuation/);
  // A reason nobody sanctioned.
  assert.throws(() => assertContinuationsAccountFor(1, ['because_it_felt_right']), /unrecognised turn continuation/);
});

/* ------------------------------------------------------------------ *
 * WI-3 — ask XOR act
 * ------------------------------------------------------------------ */

test('(a) asking + a write: the write is withheld, discarded, and the turn ends', async () => {
  const r = await run(
    'change the priority to low',
    {
      text: 'Please confirm which record you meant.',
      toolCalls: [call('update_record', { table: 'incident', sys_id: '49b1d0538336cf50b939cc65eeaad3b7', data: { priority: '4' } })],
    },
    { text: 'this completion must never be asked for' },
  );

  assert.equal(r.providerCalls, 1, 'the loop fed a withheld turn back to the provider');
  assert.equal(r.of('approval_required').length, 0, 'the withheld write reached the gate anyway');
  assert.equal(r.of('done').length, 1);

  const held = r.of('mutations_held');
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].held, ['update_record']);
  assert.equal(held[0].text, 'Proposed action withheld pending your answer.');

  // The structured event carries the payloads, because nothing else does.
  const guard = r.guards().find((g) => g.name === 'withheld_mutation');
  assert.ok(guard, 'no withheld_mutation event was logged');
  assert.equal(guard.result_status, 'withheld');
  assert.deepEqual(guard.payload.discarded[0].input.data, { priority: '4' });
  assert.equal(guard.payload.discarded[0].name, 'update_record');

  /*
   * Discarded from HISTORY too. A stored assistant row whose tool_calls have no
   * matching tool result is the one shape the wire format rejects outright — it
   * would make every later request in this session fail. "Withheld" has to mean
   * the call left history with it.
   */
  const assistantRows = r.history().filter((m) => m.role === 'assistant');
  assert.equal(assistantRows.length, 1);
  assert.equal((assistantRows[0].toolCalls || []).length, 0, 'the withheld call was left dangling in history');
  assert.match(assistantRows[0].text, /Please confirm/);
  assert.equal(r.history().filter((m) => m.role === 'tool').length, 0, 'an empty tool row was appended');
});

test('(b) asking + reads only: the reads run, and the question still stands', async () => {
  const r = await run(
    'what do we know about this instance?',
    {
      text: 'Which kind of fact did you want — traps or decisions?',
      toolCalls: [call('list_instance_facts', { kind: 'trap' })],
    },
    { text: 'There are no traps recorded yet.' },
  );

  // A turn that asks a question and gathers context while waiting is doing the
  // right thing: the read runs and its result feeds back.
  assert.equal(r.providerCalls, 2);
  assert.equal(r.of('mutations_held').length, 0);
  const results = r.of('tool_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'list_instance_facts');
  assert.equal(results[0].isError, false);
  assert.ok(r.of('assistant_text').some((e) => /Which kind of fact/.test(e.text)));
});

test('(c) a write with no question takes the normal gate path, untouched', async () => {
  const seen = scriptProvider(
    { text: 'Setting the priority now.', toolCalls: [call('update_record', { table: 'incident', sys_id: 'abc', data: { priority: '4' } })] },
    { text: 'You rejected it, so nothing changed.' },
  );
  const sessionId = newSession();
  const events = [];
  // Rejected rather than approved: it proves the gate ran without letting a
  // write off this machine.
  await runTurn(sessionId, 'set INC0010052 to priority 4', autoDecide(sessionId, events, false));

  assert.equal(seen.length, 2);
  const asked = events.filter((e) => e.type === 'approval_required');
  assert.equal(asked.length, 1, 'the ordinary approval flow stopped asking');
  assert.equal(asked[0].name, 'update_record');
  assert.equal(events.filter((e) => e.type === 'mutations_held').length, 0);
  const resolved = events.filter((e) => e.type === 'approval_resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].approved, false);
});

test('(d) a question mark inside a fenced code block does not withhold anything', async () => {
  const seen = scriptProvider(
    {
      text: 'Here is the condition I will store:\n\n```js\nconst p = rec.priority?.value ?? "4";\n```\n\nApplying it.',
      toolCalls: [call('update_record', { table: 'incident', sys_id: 'abc', data: { priority: '4' } })],
    },
    { text: 'Rejected — nothing changed.' },
  );
  const sessionId = newSession();
  const events = [];
  await runTurn(sessionId, 'set the priority', autoDecide(sessionId, events, false));

  assert.equal(events.filter((e) => e.type === 'mutations_held').length, 0,
    'a `?` inside a fenced block was read as a question to the user');
  assert.equal(events.filter((e) => e.type === 'approval_required').length, 1);
  assert.equal(seen.length, 2);
});

test('the hold can be turned off, and then the write takes the normal path', async () => {
  _setSettingsForTests({
    connection: { instanceUrl: 'https://offline.invalid' },
    llm: { provider: 'ollama', model: '', baseUrl: '' },
    agent: { autoApprove: false, holdMutationsOnQuestion: false },
  });
  try {
    const seen = scriptProvider(
      { text: 'Please confirm which record you meant.', toolCalls: [call('update_record', { table: 'incident', sys_id: 'abc', data: { priority: '4' } })] },
      { text: 'Rejected.' },
    );
    const events = [];
    const sid = newSession();
    await runTurn(sid, 'change the priority', autoDecide(sid, events, false));
    assert.equal(events.filter((e) => e.type === 'mutations_held').length, 0);
    assert.equal(events.filter((e) => e.type === 'approval_required').length, 1);
    assert.equal(seen.length, 2);
  } finally {
    _setSettingsForTests({
      connection: { instanceUrl: 'https://offline.invalid' },
      llm: { provider: 'ollama', model: '', baseUrl: '' },
      agent: { autoApprove: false, holdMutationsOnQuestion: true },
    });
  }
});

/* ------------------------------------------------------------------ *
 * M3 — an unexplained mutation on an AMBIGUOUS target
 *      (measured live on the PDI, 2026-08-24, rounds 1-4)
 * ------------------------------------------------------------------ */

/**
 * Put two candidate records on screen the way turn 1 of the live run did, so
 * the ambiguity the guard keys on is real rather than asserted.
 */
async function withTwoCandidatesOnScreen(sid) {
  scriptProvider({
    text: 'Two incidents match: INC0010054 (5b242c5783b6cf50b939cc65eeaad31e) '
      + 'and INC0010055 (3324289783b6cf50b939cc65eeaad335), both 1 - Critical.',
  });
  await runTurn(sid, 'show me the NOWFORGE-WI2 incidents', () => {});
}

test('M3 — a silent write while TWO candidates are on screen is bounced, not gated', async () => {
  /*
   * The live shape, verbatim: session 79f36d98 message seq 7 was
   * `assistant text=0ch calls=1 [update_record]` on one of two candidate
   * incidents. Neither the ask-XOR-act guard nor the A6 fence could see it —
   * both classify prose, and there was none.
   */
  const sid = newSession();
  await withTwoCandidatesOnScreen(sid);

  const seen = scriptProvider(
    { toolCalls: [call('update_record', { table: 'incident', sys_id: '3324289783b6cf50b939cc65eeaad335', data: { priority: '4' } })] },
    { text: 'I found INC0010054 and INC0010055. Which one did you mean?' },
  );
  const events = [];
  await runTurn(sid, 'acha ek kaam karo priority ko change karke LOW kardo.', (e) => events.push(e));
  const of = (t) => events.filter((e) => e.type === t);

  assert.equal(of('approval_required').length, 0, 'an unexplained write on an ambiguous target reached the gate');
  assert.equal(seen.length, 2, 'the bounce is one call, and only one');
  assert.equal(of('mutation_bounced').length, 1);
  assert.deepEqual(of('mutation_bounced')[0].writes, ['update_record']);

  const guards = loadToolEvents(sid).filter((g) => g.kind === 'guard');
  const bounce = guards.find((g) => g.name === 'unexplained_mutation');
  assert.ok(bounce, 'the bounce left no record');
  assert.equal(bounce.result_status, 'bounced');

  // The bounce names the candidates — the fact the model did not act on.
  const note = loadHistory(sid).findLast((m) => m.role === 'user' && String(m.text).startsWith('SYSTEM:'));
  assert.match(note.text, /was NOT submitted/);
  assert.match(note.text, /INC0010054/);
  assert.match(note.text, /INC0010055/);
  assert.match(note.text, /name the candidates, ask which one, and call NO tool/);

  // And the second completion's question ends the turn, as it should.
  assert.equal(of('awaiting_user').length, 1);
});

test('THE ONE THAT COST A LIVE ROUND — the user named the record, so no bounce', async () => {
  /*
   * Live round 4, turn 3. The user answered "the child one — INC0010055" and the
   * model went straight to the write with no prose. An earlier version of this
   * guard demanded narration anyway: three bounces, turn abandoned, user got
   * nothing — and the model was right not to explain. The user had just chosen.
   *
   * The defect was never silence. It was silence while CHOOSING.
   */
  const sid = newSession();
  await withTwoCandidatesOnScreen(sid);

  const seen = scriptProvider(
    { toolCalls: [call('update_record', { table: 'incident', sys_id: '3324289783b6cf50b939cc65eeaad335', data: { priority: '4' } })] },
    { text: 'Rejected — nothing changed.' },
  );
  const events = [];
  await runTurn(sid, 'the child one — INC0010055', autoDecide(sid, events, false));

  assert.equal(events.filter((e) => e.type === 'mutation_bounced').length, 0,
    'the user chose the record and was still made to wait for an essay');
  assert.equal(events.filter((e) => e.type === 'approval_required').length, 1,
    'the answered turn produced no approval card');
  assert.equal(seen.length, 2);
});

test('nothing on screen to confuse: a bare write goes straight to the gate', async () => {
  // The ordinary case, and by far the common one. No candidates, no bounce.
  const seen = scriptProvider(
    { toolCalls: [call('update_record', { table: 'incident', sys_id: 'abc', data: { priority: '4' } })] },
    { text: 'Rejected.' },
  );
  const events = [];
  const sid = newSession();
  await runTurn(sid, 'set it to low', autoDecide(sid, events, false));
  assert.equal(events.filter((e) => e.type === 'mutation_bounced').length, 0);
  assert.equal(events.filter((e) => e.type === 'approval_required').length, 1);
  assert.equal(seen.length, 2);
});

test('M3 bounces AGAIN while the turn is still silent — measured, round 3', async () => {
  /*
   * Live round 3 is why this is not once-per-turn. The model was bounced at
   * message seq 7, read a schema at seq 9 (still no prose), then submitted a
   * second bare write at seq 11 — which a once-flag sent straight to the gate.
   * The guard's condition is "this turn is choosing silently", and that
   * condition was still true.
   */
  const sid = newSession();
  await withTwoCandidatesOnScreen(sid);

  const write = { toolCalls: [call('update_record', { table: 'incident', sys_id: '3324289783b6cf50b939cc65eeaad335', data: { priority: '4' } })] };
  scriptProvider(write, { toolCalls: [call('list_instance_facts', {})] }, write, { text: 'Which of the two did you mean?' });
  const events = [];
  await runTurn(sid, 'change the priority to low', (e) => events.push(e));

  assert.equal(events.filter((e) => e.type === 'mutation_bounced').length, 2, 'the second bare write was not bounced');
  assert.equal(events.filter((e) => e.type === 'approval_required').length, 0, 'a silent choosing turn still reached the gate');
  assert.deepEqual(events.filter((e) => e.type === 'mutation_bounced').map((e) => e.attempt), [1, 2]);
});

test('M3 is BOUNDED — three refusals end the turn loudly, and say so', async () => {
  // Bounded, or a stubborn model spends the whole iteration budget arguing.
  const sid = newSession();
  await withTwoCandidatesOnScreen(sid);

  const write = { toolCalls: [call('update_record', { table: 'incident', sys_id: '3324289783b6cf50b939cc65eeaad335', data: { priority: '4' } })] };
  const seen = scriptProvider(write, write, write, { text: 'never asked for' });
  const events = [];
  await runTurn(sid, 'change the priority to low', (e) => events.push(e));

  assert.equal(seen.length, MAX_UNEXPLAINED_BOUNCES, 'the turn kept going past the cap');
  assert.equal(events.filter((e) => e.type === 'approval_required').length, 0);
  const last = events.filter((e) => e.type === 'mutation_bounced').at(-1);
  assert.equal(last.abandoned, true);
  assert.equal(last.attempt, MAX_UNEXPLAINED_BOUNCES);
  // The transcript says what happened, in the harness's words. An absence is
  // not a report.
  assert.ok(events.some((e) => e.type === 'assistant_text' && /without ever saying what it was changing/.test(e.text)));
  assert.equal(loadToolEvents(sid).filter((g) => g.result_status === 'abandoned').length, 1);
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
});

test('a write the turn DID explain is untouched', async () => {
  const sid = newSession();
  await withTwoCandidatesOnScreen(sid);
  const seen = scriptProvider(
    { text: 'Setting INC0010055 to priority 4 — it is the child of the pair.', toolCalls: [call('update_record', { table: 'incident', sys_id: 'abc', data: { priority: '4' } })] },
    { text: 'Rejected.' },
  );
  const events = [];
  await runTurn(sid, 'set the child to low', autoDecide(sid, events, false));
  assert.equal(events.filter((e) => e.type === 'mutation_bounced').length, 0, 'an explained write was bounced');
  assert.equal(events.filter((e) => e.type === 'approval_required').length, 1);
  assert.equal(seen.length, 2);
});

test('prose EARLIER in the turn counts — the guard is about the turn, not the completion', async () => {
  // The model narrates, reads, then writes without repeating itself. That is
  // normal and must not cost a round trip.
  const sid = newSession();
  await withTwoCandidatesOnScreen(sid);
  const seen = scriptProvider(
    { text: 'Let me check the facts first, then set the child to Low.', toolCalls: [call('list_instance_facts', {})] },
    { toolCalls: [call('update_record', { table: 'incident', sys_id: 'abc', data: { priority: '4' } })] },
    { text: 'Rejected.' },
  );
  const events = [];
  await runTurn(sid, 'set the child to low', autoDecide(sid, events, false));
  assert.equal(events.filter((e) => e.type === 'mutation_bounced').length, 0);
  assert.equal(events.filter((e) => e.type === 'approval_required').length, 1);
  assert.equal(seen.length, 3);
});

test('a bare READ is not a bounce — only writes choose records', async () => {
  const sid = newSession();
  await withTwoCandidatesOnScreen(sid);
  scriptProvider({ toolCalls: [call('list_instance_facts', {})] }, { text: 'None recorded.' });
  const events = [];
  await runTurn(sid, 'what facts do we have?', (e) => events.push(e));
  assert.equal(events.filter((e) => e.type === 'mutation_bounced').length, 0);
  assert.equal(events.filter((e) => e.type === 'tool_result').length, 1);
});

test('ambiguousTarget: the user naming a record settles it, whatever is on screen', () => {
  const onScreen = [{ role: 'assistant', text: 'INC0010054 and INC0010055 both match.' }];
  assert.equal(ambiguousTarget({ userText: 'set INC0010055 to low', history: onScreen }), null);
  assert.equal(ambiguousTarget({ userText: 'set 3324289783b6cf50b939cc65eeaad335 to low', history: onScreen }), null);
  assert.deepEqual(ambiguousTarget({ userText: 'set it to low', history: onScreen }).candidates,
    ['INC0010054', 'INC0010055']);
  // One candidate is not a choice.
  assert.equal(ambiguousTarget({ userText: 'set it to low', history: [{ role: 'assistant', text: 'INC0010055 matches.' }] }), null);
  assert.equal(ambiguousTarget({ userText: 'set it to low', history: [] }), null);
});

test('ambiguousTarget forgets: a record named long ago is not a live candidate', () => {
  const old = [{ role: 'assistant', text: 'INC0010054 and INC0010055.' }];
  const filler = Array.from({ length: 9 }, (_, i) => ({ role: 'assistant', text: `step ${i}` }));
  assert.ok(ambiguousTarget({ userText: 'set it to low', history: old }));
  assert.equal(ambiguousTarget({ userText: 'set it to low', history: [...old, ...filler] }), null);
});

test('the classifier itself: ambiguity, prose, and writes', () => {
  const isMutating = (n) => n === 'update_record';
  const ambiguity = { candidates: ['INC0010054', 'INC0010055'] };
  const bare = { assistantText: '', toolCalls: [{ id: 'a', name: 'update_record' }], turnHasProse: false, isMutating, ambiguity };
  assert.deepEqual(detectUnexplainedMutation(bare).writes, ['update_record']);
  assert.deepEqual(detectUnexplainedMutation(bare).candidates, ambiguity.candidates);
  // Whitespace is not an explanation — the same rule the rest of the loop uses.
  assert.ok(detectUnexplainedMutation({ ...bare, assistantText: '  \n ' }));
  assert.equal(detectUnexplainedMutation({ ...bare, assistantText: 'Setting it now.' }), null);
  assert.equal(detectUnexplainedMutation({ ...bare, turnHasProse: true }), null);
  assert.equal(detectUnexplainedMutation({ ...bare, toolCalls: [{ id: 'a', name: 'query_records' }] }), null);
  // No ambiguity is the common case, and it never fires.
  assert.equal(detectUnexplainedMutation({ ...bare, ambiguity: null }), null);
});

test.after(() => {
  _setChatTurnForTests(null);
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* windows may hold the file */ }
});
