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
  runTurn, resolveApproval, APPROVAL_SOURCES, assertContinuationsAccountFor, CONTINUATION_REASONS,
  detectUnexplainedMutation, ambiguousWrites, MAX_UNEXPLAINED_BOUNCES,
  proseHead, PROSE_HEAD_CHARS, stallIntent,
} = await import('../src/agent/orchestrator.js');
const { loadHistory, loadToolEvents, createSession, replaceSpanWithDigest } = await import('../src/memory/sessions.js');
const {
  checkWriteTarget, provenanceFor, resolveDisplayId, targetsNamedByUser, extractRecords,
  registerFromToolResult, parseLeadingJson,
} = await import('../src/memory/provenance.js');
const { attachVerification } = await import('../src/agent/mutation-pipeline.js');
const { recordFact } = await import('../src/memory/facts.js');
const { getDb } = await import('../src/memory/db.js');
const { toolMap } = await import('../src/agent/tools.js');

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
        /*
         * Exactly what POST /api/agent/approve does: the card's token, and
         * `user_click` as the source.
         *
         * Both matter. Without the token every test here would be a
         * token-mismatch test (WI-3); without the source, WI-4's executor
         * refuses the mutation as unattributable — which is correct behaviour
         * and made an APPROVED call fail silently, since the failure lands in
         * the tool result rather than in the assertions most of these tests
         * make.
         */
        const r = resolveApproval(sessionId, e.approvalId, approved, APPROVAL_SOURCES.USER_CLICK, e.nonce);
        if (!r?.ok) throw new Error(`the gate refused approval ${e.approvalId}: ${r?.reason}`);
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
 * FOLLOW-UP WI-1 — provenance: the hard block, and ambiguity read off the
 * registry rather than off prose
 *
 * M3's guard survives; its DERIVATION does not. Candidates no longer come from
 * scanning recent prose for identifiers — they come from the read that
 * produced them, which is the only place the table, the row count and the
 * number-to-sys_id pairing exist at once.
 * ------------------------------------------------------------------ */

const CHILD = '3324289783b6cf50b939cc65eeaad335';   // INC0010055
const PARENT = '5b242c5783b6cf50b939cc65eeaad31e';  // INC0010054
const NEVER_SEEN = 'bfdd8816bfdd8816bfdd8816bfdd8816';

/** A read whose result set the test controls, registered through the registry. */
function localRead(rows) {
  toolMap.set('test_local_read', { name: 'test_local_read', mutating: false, execute: async () => rows });
}
function localWrite() {
  toolMap.set('test_local_write', {
    name: 'test_local_write', mutating: true, execute: async () => ({ ok: true }),
    describeWrite: ({ table, sys_id, data }) => ({ table, operation: 'update', requested: data || {}, sys_id }),
  });
}
const dropLocals = () => { toolMap.delete('test_local_read'); toolMap.delete('test_local_write'); };

/** One prior turn whose READ put two incidents into this session's registry. */
async function readTwoCandidates(sid) {
  localRead([{ sys_id: CHILD, number: 'INC0010055' }, { sys_id: PARENT, number: 'INC0010054' }]);
  scriptProvider(
    { toolCalls: [call('test_local_read', { table: 'incident' })] },
    { text: 'Two incidents match: INC0010054 and INC0010055.' },
  );
  await runTurn(sid, 'show me the NOWFORGE incidents', () => {});
}

/* ---------------------------- the hard block ---------------------------- */

test('THE STANDING DEBT — a write to a sys_id nobody has ever seen is HARD BLOCKED', async () => {
  /*
   * `bfdd8816…` is well-formed, 32 hex characters, and no record has ever had
   * it. Before this the gate rendered it a card; downstream could not catch it
   * either, because the write reaches a sys_id that does not exist, the
   * platform answers, and the read-back verifies whatever it finds.
   */
  const sid = newSession();
  try {
    localWrite();
    scriptProvider(
      { text: 'Setting it now.', toolCalls: [call('test_local_write', { table: 'incident', sys_id: NEVER_SEEN, data: { priority: '4' } })] },
      { text: 'It was blocked.' },
    );
    const events = [];
    await runTurn(sid, 'set the priority to low', (e) => events.push(e));

    assert.equal(events.filter((e) => e.type === 'approval_required').length, 0, 'a confabulated sys_id reached the gate');
    const blocked = events.filter((e) => e.type === 'tool_blocked');
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].reason, 'confabulated-sys-id');
    assert.match(blocked[0].message, /has never appeared in this session/);
    // Recoverable, not just refused: the model is told how to get a real one.
    assert.match(blocked[0].message, /query_records or get_record/);

    const guard = loadToolEvents(sid).find((g) => g.name === 'confabulated_sys_id');
    assert.ok(guard, 'the blocked payload was not recorded anywhere');
    assert.equal(guard.result_status, 'blocked');
    assert.equal(guard.payload.sys_id, NEVER_SEEN);
    assert.deepEqual(guard.payload.input.data, { priority: '4' }, 'the full payload is the only record of what was attempted');
  } finally { dropLocals(); }
});

test('a sys_id the same session READ is not confabulated', async () => {
  const sid = newSession();
  try {
    await readTwoCandidates(sid);
    // Narrowed by the user naming it, so this reaches the gate rather than
    // bouncing — the point here is only that it is not BLOCKED.
    localWrite();
    scriptProvider(
      { text: `Setting ${CHILD} to Low.`, toolCalls: [call('test_local_write', { table: 'incident', sys_id: CHILD, data: { priority: '4' } })] },
      { text: 'Rejected.' },
    );
    const events = [];
    await runTurn(sid, `set ${CHILD} to low`, autoDecide(sid, events, false));
    assert.equal(events.filter((e) => e.type === 'tool_blocked').length, 0, 'a sys_id read this session was blocked');
    assert.equal(events.filter((e) => e.type === 'approval_required').length, 1);
  } finally { dropLocals(); }
});

test('a sys_id the USER typed is a target by definition', async () => {
  const sid = newSession();
  try {
    localWrite();
    scriptProvider(
      { text: 'Setting it now.', toolCalls: [call('test_local_write', { table: 'incident', sys_id: CHILD, data: { priority: '4' } })] },
      { text: 'Rejected.' },
    );
    const events = [];
    // Nothing was ever read — the sys_id enters the registry from the message.
    await runTurn(sid, `set ${CHILD} to priority 4 please`, autoDecide(sid, events, false));
    assert.equal(events.filter((e) => e.type === 'tool_blocked').length, 0);
    assert.equal(events.filter((e) => e.type === 'approval_required').length, 1);
    const rows = provenanceFor(sid).filter((r) => r.sys_id === CHILD);
    assert.equal(rows[0].source, 'user_message');
  } finally { dropLocals(); }
});

/* ---------------------------- the bounce ---------------------------- */

test('M3 — a silent write to ONE OF TWO read records is bounced, not gated', async () => {
  const sid = newSession();
  try {
    await readTwoCandidates(sid);
    localWrite();
    scriptProvider(
      { toolCalls: [call('test_local_write', { table: 'incident', sys_id: CHILD, data: { priority: '4' } })] },
      { text: 'I found INC0010054 and INC0010055. Which one did you mean?' },
    );
    const events = [];
    await runTurn(sid, 'acha ek kaam karo priority ko change karke LOW kardo.', (e) => events.push(e));

    assert.equal(events.filter((e) => e.type === 'approval_required').length, 0, 'an ambiguous write reached the gate');
    assert.equal(events.filter((e) => e.type === 'tool_blocked').length, 0, 'a read sys_id was treated as confabulated');
    const bounced = events.filter((e) => e.type === 'mutation_bounced');
    assert.equal(bounced.length, 1);

    // The bounce names the SIBLINGS from the read, by their display ids.
    const note = loadHistory(sid).findLast((m) => m.role === 'user' && String(m.text).startsWith('SYSTEM:'));
    assert.match(note.text, /INC0010054/);
    assert.match(note.text, /INC0010055/);
    assert.equal(events.filter((e) => e.type === 'awaiting_user').length, 1);
  } finally { dropLocals(); }
});

test('THE ONE THAT COST A LIVE ROUND — the user named the record, so no bounce', async () => {
  /*
   * Live round 4, turn 3. "the child one — INC0010055" and a bare write. The
   * user had chosen; demanding an essay abandoned the turn and gave them
   * nothing. The registry resolves INC0010055 to its sys_id through the read
   * that produced both, which is the aliasing fix made structural.
   */
  const sid = newSession();
  try {
    await readTwoCandidates(sid);
    localWrite();
    scriptProvider(
      { toolCalls: [call('test_local_write', { table: 'incident', sys_id: CHILD, data: { priority: '4' } })] },
      { text: 'Rejected.' },
    );
    const events = [];
    await runTurn(sid, 'the child one — INC0010055', autoDecide(sid, events, false));
    assert.equal(events.filter((e) => e.type === 'mutation_bounced').length, 0,
      'the user chose the record and was still made to wait');
    assert.equal(events.filter((e) => e.type === 'approval_required').length, 1);
  } finally { dropLocals(); }
});

test('a UNIQUE read narrows it, and the narrowing is permanent', async () => {
  // Monotone on purpose: a later broad query cannot un-choose what a unique
  // read already settled.
  const sid = newSession();
  try {
    await readTwoCandidates(sid);
    localRead([{ sys_id: CHILD, number: 'INC0010055' }]);
    scriptProvider(
      { toolCalls: [call('test_local_read', { table: 'incident' })] },
      { text: 'One match.' },
    );
    await runTurn(sid, 'show me the child', () => {});

    assert.equal(checkWriteTarget({ sessionId: sid, sysId: CHILD, userText: 'set it to low' }).verdict, 'ok');
    // Its sibling was never narrowed.
    assert.equal(checkWriteTarget({ sessionId: sid, sysId: PARENT, userText: 'set it to low' }).verdict, 'ambiguous');
  } finally { dropLocals(); }
});

/* ---------------------------- compaction ---------------------------- */

test('the registry SURVIVES compaction — a pre-fold sys_id still writes', async () => {
  /*
   * The property the digest could not have provided. Compaction deletes from
   * `messages` and `chunks`; the registry is written beside `tool_events` and
   * is untouched, so a sys_id read twenty turns ago is still a legal target
   * after the turns that read it are gone.
   */
  const sid = newSession();
  try {
    await readTwoCandidates(sid);
    const before = provenanceFor(sid).length;
    assert.ok(before >= 2);

    // Fold everything: the messages that carried these identifiers are gone.
    const seqs = loadHistory(sid).length;
    replaceSpanWithDigest(sid, 0, seqs - 1, 'ARTIFACTS BUILT OR CHANGED\n- none\n\nRECORDS ONLY LOOKED AT\n- 2 incidents\n\nDECISIONS\n- none\n\nOPEN THREADS\n- none');
    assert.equal(loadHistory(sid).length, 0, 'the fold did not actually remove the messages');
    assert.equal(provenanceFor(sid).length, before, 'compaction reached the provenance index');

    // (a) a pre-compaction sys_id still passes.
    assert.equal(checkWriteTarget({ sessionId: sid, sysId: CHILD, userText: 'set INC0010055' }).verdict, 'ok');
    // (b) one that was never seen is still blocked.
    assert.equal(checkWriteTarget({ sessionId: sid, sysId: NEVER_SEEN, userText: '' }).verdict, 'confabulated');
  } finally { dropLocals(); }
});

/* ---------------------------- the registry itself ---------------------------- */

test('one record named twice is ONE record — aliasing is structural now', async () => {
  const sid = newSession();
  try {
    await readTwoCandidates(sid);
    // The number resolves to the sys_id through the read that produced both.
    assert.equal(resolveDisplayId(sid, 'INC0010055'), CHILD);
    assert.deepEqual(targetsNamedByUser(sid, 'the child one — INC0010055'), [CHILD]);
    // Number AND sys_id in one sentence is still one target, not two.
    assert.deepEqual(targetsNamedByUser(sid, `INC0010055 (sys_id ${CHILD})`), [CHILD]);
  } finally { dropLocals(); }
});

test('each source type registers, and says which door it came through', async () => {
  const sid = newSession();
  try {
    await readTwoCandidates(sid);
    const rows = provenanceFor(sid);
    const read = rows.find((r) => r.sys_id === CHILD);
    assert.equal(read.source, 'tool_result');
    assert.equal(read.table_name, 'incident');
    assert.equal(read.display_id, 'INC0010055');
    assert.equal(read.row_count, 2, 'the row count of the RESULT SET is what makes ambiguity checkable');
    assert.ok(read.event_seq >= 0, 'the row does not point back at the read that produced it');
  } finally { dropLocals(); }
});

test('extractRecords walks the shapes the tools actually return', () => {
  // An array of rows, the {display_value,value} pair form, and a nested
  // composite builder result — the three shapes a miss here would come from.
  assert.deepEqual(extractRecords([{ sys_id: CHILD, number: 'INC0010055' }]).map((r) => r.sys_id), [CHILD]);
  assert.deepEqual(
    extractRecords({ sys_id: { display_value: CHILD, value: CHILD }, number: { display_value: 'INC0010055', value: 'INC0010055' } }),
    [{ sys_id: CHILD, display_id: 'INC0010055' }],
  );
  assert.deepEqual(
    extractRecords({ item: { sys_id: PARENT, name: 'Laptop Request' }, variables: [{ sys_id: CHILD, name: 'model' }] }).map((r) => r.sys_id).sort(),
    [CHILD, PARENT].sort(),
  );
  // Not sys_ids, and not records.
  assert.deepEqual(extractRecords({ fields: [{ name: 'priority', type: 'integer' }] }), []);
  assert.deepEqual(extractRecords({ sys_id: 'not-a-sys-id' }), []);
  assert.deepEqual(extractRecords(null), []);
});

test('a non-sys_id target is none of this guard\'s business', () => {
  // Tools that address records some other way must pass straight through.
  assert.equal(checkWriteTarget({ sessionId: 'anything', sysId: 'global' }).verdict, 'ok');
  assert.equal(checkWriteTarget({ sessionId: 'anything', sysId: '' }).verdict, 'ok');
  assert.equal(checkWriteTarget({ sessionId: 'anything', sysId: null }).verdict, 'ok');
});

test('a sys_id stated in the KNOWLEDGE LEDGER is established, not confabulated', () => {
  /*
   * The ledger is instance-scoped and this index is session-scoped, so facts
   * are consulted on demand rather than copied into every session. A fact this
   * project measured and wrote down is not a confabulation, and blocking a
   * write to it would be the guard wrong in the expensive direction.
   */
  const sid = newSession();
  createSession({ id: sid });
  recordFact({
    kind: 'mapping', key: 'wi1-test-known-record',
    value: `The canonical test record is sys_id ${NEVER_SEEN} on incident.`,
    provenance: 'a test', confidence: 0.9,
  });
  try {
    const v = checkWriteTarget({ sessionId: sid, sysId: NEVER_SEEN, userText: '' });
    assert.equal(v.verdict, 'ok');
    assert.equal(v.reason, 'narrowed-by-ledger_fact');
    // Recorded on the way past, so the answer is stored rather than re-derived.
    assert.equal(provenanceFor(sid).find((r) => r.sys_id === NEVER_SEEN).source, 'ledger_fact');
  } finally {
    getDb().prepare("DELETE FROM facts WHERE key = 'wi1-test-known-record'").run();
  }
});

/* ------------------------------------------------------------------ *
 * FOLLOW-UP WI-2 — stall telemetry, deferred to data
 *
 * A6 still nudges what its patterns recognise. This records what it does NOT,
 * so a decision about a successor can be made from a rate rather than from a
 * guess — the guess is what produced A6's nudge, which asserted "You already
 * have what you need" at a model that did not.
 * ------------------------------------------------------------------ */

test('DECLARATIVE INTENT — the turn ends, and the harness records that it did', async () => {
  /*
   * The class this event exists for: the model announces work, calls nothing,
   * and the stream closes looking exactly like success. A6's ASKS_TO_PROCEED
   * does not match it — "I will now create" has an adverb where the pattern
   * wants a verb — so nothing else in the loop sees this turn at all.
   *
   * The BEHAVIOUR is the recorded decision: the turn ends. No nudge is
   * rebuilt this sprint.
   */
  const r = await run(
    'create an incident for the badge reader outage',
    { text: 'I will now create the incident for the badge reader outage and assign it to Service Desk.' },
  );

  assert.equal(r.providerCalls, 1, 'the turn was continued rather than ended');
  assert.equal(r.of('nudged').length, 0, 'a nudge was rebuilt — this sprint measures instead');
  assert.equal(r.of('approval_required').length, 0);
  assert.equal(r.of('done').length, 1);

  const ev = r.of('stalled_turn_ended');
  assert.equal(ev.length, 1, 'the quiet turn end was not recorded');
  assert.match(ev[0].head, /^I will now create the incident/);
  assert.equal(ev[0].intent, 'declarative', 'the class this event exists for was not labelled as such');
  assert.equal(ev[0].nudgedEarlier, false);

  const guard = r.guards().find((g) => g.name === 'stalled_turn_ended');
  assert.ok(guard, 'nothing durable was written — a rate cannot be read off the SSE stream');
  // The status IS the label, so `SELECT result_status, COUNT(*) … GROUP BY 1`
  // answers the question this sprint deferred, without parsing any payloads.
  assert.equal(guard.result_status, 'declarative');
  assert.equal(guard.payload.head, ev[0].head);
  assert.equal(guard.payload.intent, 'declarative');
});

test('a turn that ASKED is not a stall — it is waiting, and says so already', async () => {
  const r = await run(
    'set the priority to low',
    { text: 'Which of the two incidents did you mean?' },
  );
  assert.equal(r.of('stalled_turn_ended').length, 0, 'a question was counted as a stall');
  assert.equal(r.of('awaiting_user').length, 1, 'the existing signal stopped firing');
});

test('a turn that CHANGED something is not a stall, however it signs off', async () => {
  /*
   * Without this the event fires on every successful turn in the session and
   * the rate it exists to measure is unreadable.
   *
   * A local mutating tool, registered through the registry's own export, so the
   * approved path runs end to end without reaching an instance. The real tools
   * all call ServiceNow; the property under test is the loop's, not theirs.
   */
  toolMap.set('test_local_write', {
    name: 'test_local_write', mutating: true, execute: async () => ({ ok: true }),
  });
  try {
    const seen = scriptProvider(
      { text: 'Setting it now.', toolCalls: [call('test_local_write', {})] },
      { text: 'Done — the record is updated.' },
    );
    const events = [];
    const sid = newSession();
    await runTurn(sid, 'update the record', autoDecide(sid, events, true));
    assert.equal(events.filter((e) => e.type === 'stalled_turn_ended').length, 0,
      'a turn that mutated was counted as a stall');
    assert.equal(seen.length, 2);
  } finally {
    toolMap.delete('test_local_write');
  }
});

test('a REJECTED write leaves the turn changed-nothing, and the sign-off is recorded', async () => {
  /*
   * Deliberately the opposite assertion to the one above, and both are right:
   * the gate refused, so the turn changed nothing, and prose claiming otherwise
   * is exactly the population this event exists to size.
   */
  const seen = scriptProvider(
    { text: 'Setting INC0010055 to Low.', toolCalls: [call('update_record', { table: 'incident', sys_id: 'abc', data: { priority: '4' } })] },
    { text: 'Done — INC0010055 is updated.' },
  );
  const events = [];
  const sid = newSession();
  await runTurn(sid, 'set INC0010055 to low', autoDecide(sid, events, false));
  const ev = events.filter((e) => e.type === 'stalled_turn_ended');
  assert.equal(ev.length, 1);
  assert.equal(seen.length, 2);
});

test('a plain ANSWER is in the population, labelled as an answer', async () => {
  /*
   * The event fires on every quiet turn end, because a rate needs a
   * denominator — but "Beth Anglin." is a complete answer, and a reader
   * counting stalls must not count it as one. The label carries that; nothing
   * is gated on it.
   */
  const r = await run('who is INC0010052 assigned to?', { text: 'Beth Anglin.' });
  const ev = r.of('stalled_turn_ended');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].intent, 'informational');
  assert.equal(r.guards().find((g) => g.name === 'stalled_turn_ended').result_status, 'informational');
});

test('the intent label is a description, never a decision', () => {
  assert.equal(stallIntent('I will now create the incident.'), 'declarative');
  assert.equal(stallIntent("I'll go ahead and add the variable."), 'declarative');
  assert.equal(stallIntent('Let me create the UI policy.'), 'declarative');
  assert.equal(stallIntent("I'm going to update the record."), 'declarative');
  assert.equal(stallIntent('Beth Anglin.'), 'informational');
  assert.equal(stallIntent('The priority was recomputed to 1 - Critical.'), 'informational');
  assert.equal(stallIntent('There is no such field on this table.'), 'informational');
  // Code is not prose here either.
  assert.equal(stallIntent('```js\n// I will create it\n```\nNo such field.'), 'informational');
});

test('a stall that SURVIVED the nudge is recorded, and says it was nudged', async () => {
  // A6 fires, the model still does nothing. That is the most interesting row
  // in the whole population: the nudge was spent and bought nothing.
  const r = await run(
    'create the UI policy',
    { text: 'I have the sys_ids and the choice value. Shall I create this UI Policy now?' },
    { text: 'I will create the UI Policy on the instance shortly.' },
  );
  assert.equal(r.of('nudged').length, 1);
  const ev = r.of('stalled_turn_ended');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].nudgedEarlier, true, 'the row cannot say whether the nudge was already spent');
});

test('the head is bounded and collapsed — telemetry is not a second transcript', () => {
  assert.equal(proseHead('a\n\n   b   c'), 'a b c');
  const long = 'x'.repeat(400);
  assert.equal(proseHead(long).length, PROSE_HEAD_CHARS + 1, 'the ellipsis is the only thing past the bound');
  assert.ok(proseHead(long).endsWith('…'));
  // Fenced code is not prose here either, by the same rule as the classifier.
  assert.equal(proseHead('```js\nconst x = 1;\n```\nDone.'), 'Done.');
  assert.equal(proseHead(''), '');
});

test.after(() => {
  _setChatTurnForTests(null);
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* windows may hold the file */ }
});

test('the hard block\'s SURFACE is exactly the tools that take a caller-supplied target', () => {
  /*
   * The guard reads `describeWrite(input, null).sys_id` — the pre-gate call,
   * with no result yet. So a tool whose target comes from its RESULT is
   * structurally exempt: a create has no target to confabulate.
   *
   * This enumerates the surface rather than asserting a list, so adding a tool
   * that takes a sys_id from its input shows up here as a new name. That is
   * the moment to think about whether a hard block is right for it — not the
   * first time a live write is refused.
   */
  const exposed = [...toolMap.values()]
    .filter((t) => t.mutating && typeof t.describeWrite === 'function')
    .filter((t) => {
      let d = null;
      try { d = t.describeWrite({}, null); } catch { return false; }
      // Called with an EMPTY input, so anything that yields a sys_id here is
      // reading it from somewhere other than the caller — none do today.
      return Boolean(d?.sys_id);
    })
    .map((t) => t.name);
  assert.deepEqual(exposed, [], 'a tool produces a sys_id from nothing');

  const fromInput = [...toolMap.values()]
    .filter((t) => t.mutating && typeof t.describeWrite === 'function')
    .filter((t) => {
      let d = null;
      try { d = t.describeWrite({ table: 'incident', sys_id: 'a'.repeat(32), data: {} }, null); } catch { return false; }
      return Boolean(d?.sys_id);
    })
    .map((t) => t.name)
    .sort();
  /*
   * WI-ACL-1 added `update_acl` and `delete_acl`, and the question this test
   * exists to force was asked: IS a hard block right for them? Yes, and more
   * clearly than for the generic pair.
   *
   * Both take an ACL sys_id the caller supplies, and the confabulation failure
   * here is not "nothing happens". A well-formed 32-hex string the model invented
   * either names no ACL — in which case the write is refused, harmlessly — or it
   * names a DIFFERENT, REAL ACL, and the update rewrites the access rules of
   * whatever rule it happened to hit, or the delete removes it. An ACL sys_id
   * must come from an acl_report read, which is exactly what the provenance
   * check enforces.
   */
  assert.deepEqual(fromInput, ['delete_acl', 'delete_record', 'update_acl', 'update_record'],
    'the set of tools inside the confabulation hard block changed — is a hard block right for the new one?');
});

/* ------------------------------------------------------------------ *
 * WI-1 — the false-block bug found by auditing the hard block before
 * shipping it. Severity-1 and entirely ordinary: create a record, then
 * change it.
 * ------------------------------------------------------------------ */

test('THE FALSE BLOCK — a result with the harness\'s own blocks appended still indexes', () => {
  /*
   * `tool_events.result` is not one JSON document. attachVerification appends
   * {"verification":…}, capture appends {"capture":…}, WI-5 appends
   * {"planTimeWarning":…}. JSON.parse on the whole string throws at the second
   * one, so EVERY MUTATION RESULT was silently dropped from the index — and a
   * created record's sys_id exists in that string and nowhere else.
   */
  const sid = newSession();
  createSession({ id: sid });
  const raw = {
    sys_id: { display_value: CHILD, value: CHILD },
    number: { display_value: 'INC0010055', value: 'INC0010055' },
  };
  const verification = {
    verified: true, status: 'applied', summary: 'stored as sent',
    applied: [{ field: 'short_description' }], dropped: [], transformed: [], unverifiable: [],
  };
  const stored = attachVerification(JSON.stringify(raw, null, 1), verification)
    + `\n${JSON.stringify({ capture: { captured: false, message: 'data, not configuration' } }, null, 1)}`;
  // If this ever stops throwing, the harness stopped appending its own blocks
  // and this whole guard can be simplified.
  assert.throws(() => JSON.parse(stored));

  assert.equal(registerFromToolResult({ sessionId: sid, seq: 0, table: 'incident', result: stored }), 1);
  const row = provenanceFor(sid)[0];
  assert.equal(row.sys_id, CHILD);
  assert.equal(row.display_id, 'INC0010055', 'structure was lost — the number did not survive');
  assert.equal(row.table_name, 'incident');
  assert.equal(row.row_count, 1);
});

test('CREATE THEN CHANGE IT — the ordinary chain is not blocked', async () => {
  // The user-visible failure: "create an incident" then "now assign it".
  const sid = newSession();
  try {
    toolMap.set('test_local_create', {
      name: 'test_local_create', mutating: true,
      execute: async () => ({ sys_id: CHILD, number: 'INC0010055' }),
      // A create takes its sys_id from the RESULT, so the guard cannot fire on
      // it — which is exactly why the create is the only producer here.
      describeWrite: (_input, result) => ({ table: 'incident', operation: 'insert', requested: {}, sys_id: result?.sys_id }),
    });
    localWrite();
    scriptProvider(
      { text: 'Creating it.', toolCalls: [call('test_local_create', { table: 'incident', data: { short_description: 'x' } })] },
      { text: 'Created INC0010055.' },
    );
    await runTurn(sid, 'create an incident for the scanner outage', autoDecide(sid, [], true));
    assert.ok(provenanceFor(sid).some((r) => r.sys_id === CHILD), 'the created sys_id was never indexed');

    scriptProvider(
      { text: 'Assigning it.', toolCalls: [call('test_local_write', { table: 'incident', sys_id: CHILD, data: { assignment_group: 'net' } })] },
      { text: 'Rejected.' },
    );
    const events = [];
    await runTurn(sid, 'now assign it to the network team', autoDecide(sid, events, false));
    assert.equal(events.filter((e) => e.type === 'tool_blocked').length, 0,
      'the follow-up write to a record this session CREATED was hard blocked');
    assert.equal(events.filter((e) => e.type === 'approval_required').length, 1);
  } finally { toolMap.delete('test_local_create'); dropLocals(); }
});

test('reference fields do not make a unique read look like a choice', () => {
  /*
   * A get_record returns the record plus six reference sys_ids. Folding those
   * into the record count would bounce a write that was never ambiguous, so
   * loose ids are registered separately with their own row_count.
   */
  const sid = newSession();
  createSession({ id: sid });
  registerFromToolResult({
    sessionId: sid, seq: 0, table: 'incident',
    result: JSON.stringify({
      sys_id: CHILD, number: 'INC0010055',
      caller_id: { display_value: 'Abel Tuter', value: PARENT },
      assigned_to: { display_value: 'Beth Anglin', value: 'aaaa1111aaaa1111aaaa1111aaaa1111' },
    }),
  });
  const rec = provenanceFor(sid).find((r) => r.sys_id === CHILD);
  assert.equal(rec.row_count, 1, 'reference sys_ids were counted as sibling records');
  assert.equal(checkWriteTarget({ sessionId: sid, sysId: CHILD, userText: '' }).verdict, 'ok');
  // The references are still known — a write to one is not a confabulation.
  assert.equal(checkWriteTarget({ sessionId: sid, sysId: PARENT, userText: '' }).verdict, 'ok');
});

test('a truncated result still yields its sys_ids, and says structure was lost', () => {
  // RESULT_CHAR_LIMIT cuts long reads and appends a marker, which breaks the
  // parse. Falling back to a text sweep beats refusing a legitimate write.
  const sid = newSession();
  createSession({ id: sid });
  const truncated = `{\n "sys_id": "${CHILD}",\n "number": "INC0010055",\n "desc": "aaaa` + '\n…[truncated]';
  assert.equal(parseLeadingJson(truncated), null, 'the premise changed — a truncated doc now parses');
  assert.equal(registerFromToolResult({ sessionId: sid, seq: 0, table: 'incident', result: truncated }), 1);
  assert.equal(checkWriteTarget({ sessionId: sid, sysId: CHILD, userText: '' }).verdict, 'ok');
});

test('parseLeadingJson takes the FIRST document and ignores the rest', () => {
  assert.deepEqual(parseLeadingJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseLeadingJson('{"a":1}\n{"verification":{"status":"applied"}}'), { a: 1 });
  assert.deepEqual(parseLeadingJson('[{"a":1}]\n{"capture":{}}'), [{ a: 1 }]);
  // Braces and newlines inside a string value must not end the scan early.
  assert.deepEqual(parseLeadingJson('{"a":"}\\n{ not the end"}\n{"b":2}'), { a: '}\n{ not the end' });
  assert.equal(parseLeadingJson('Error: nothing happened'), null);
  assert.equal(parseLeadingJson(''), null);
});

test('a 2-row query is still ambiguous — the fix did not weaken the count', () => {
  const sid = newSession();
  createSession({ id: sid });
  registerFromToolResult({
    sessionId: sid, seq: 0, table: 'incident',
    result: JSON.stringify([{ sys_id: CHILD, number: 'INC0010055' }, { sys_id: PARENT, number: 'INC0010054' }]),
  });
  assert.equal(checkWriteTarget({ sessionId: sid, sysId: CHILD, userText: 'set it to low' }).verdict, 'ambiguous');
});
