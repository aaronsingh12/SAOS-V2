/**
 * WI-8 — a completion that both asks the user something and calls mutating
 * tools. In the transcript the harness executed the calls, so the user was
 * asked to decide something already decided for them.
 *
 * The mirror of the A6 stall guard: A6 catches asking and doing NOTHING, this
 * catches asking and doing everything anyway.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectQuestionWithMutation,
  detectClarifyingQuestion,
  detectStalledTurn,
  isAskingTheUser,
  CLARIFICATION_MARKERS,
} from '../src/agent/orchestrator.js';

const MUTATORS = new Set(['create_record', 'update_record', 'create_incident']);
const isMutating = (n) => MUTATORS.has(n);
const calls = (...names) => names.map((name, i) => ({ id: `c${i}`, name }));

test('a question plus a mutation holds the mutation', () => {
  const r = detectQuestionWithMutation({
    assistantText: 'I can set this up. Would you like me to use the Network group or Service Desk?',
    toolCalls: calls('create_incident'), isMutating,
  });
  assert.ok(r, 'the mutation was not held');
  assert.deepEqual(r.held, ['create_incident']);
  assert.match(r.asked, /Would you like me to/i);
});

test('every phrasing that means "I am asking you" is caught', () => {
  for (const text of [
    'Shall I create it now?',
    'Do you want me to proceed with the Network group?',
    'Should I use the existing category?',
    'Which one of these did you mean?',
    'Please confirm the assignment group before I continue.',
    'Let me know which group to use.',
  ]) {
    assert.ok(detectQuestionWithMutation({ assistantText: text, toolCalls: calls('create_record'), isMutating }), `missed: ${text}`);
  }
});

test('a question with only READS proceeds — gathering context while asking is right', () => {
  assert.equal(detectQuestionWithMutation({
    assistantText: 'Which group did you mean?',
    toolCalls: calls('query_records', 'lookup_reference'), isMutating,
  }), null);
});

test('a mutation with no question proceeds', () => {
  assert.equal(detectQuestionWithMutation({
    assistantText: 'Creating the incident now.',
    toolCalls: calls('create_incident'), isMutating,
  }), null);
});

test('only the mutating calls are held, and they are named', () => {
  const r = detectQuestionWithMutation({
    assistantText: 'Shall I proceed?',
    toolCalls: calls('query_records', 'create_record', 'update_record'), isMutating,
  });
  assert.deepEqual(r.held, ['create_record', 'update_record']);
});

test('the flag turns it off completely', () => {
  assert.equal(detectQuestionWithMutation({
    assistantText: 'Shall I create it?', toolCalls: calls('create_record'), isMutating, enabled: false,
  }), null);
});

test('empty or missing text is not a question', () => {
  for (const t of ['', '   ', null, undefined]) {
    assert.equal(detectQuestionWithMutation({ assistantText: t, toolCalls: calls('create_record'), isMutating }), null);
  }
});

test('prose that merely contains "confirm" as a noun is not treated as a question', () => {
  // "a confirmation email" must not hold a write. The pattern requires the
  // verb form aimed at the user.
  assert.equal(detectQuestionWithMutation({
    assistantText: 'The flow sends a confirmation email to the requester.',
    toolCalls: calls('create_record'), isMutating,
  }), null);
});

/* ------------------------------------------------------------------ *
 * WI-3 — the classifier: prose only, and a question mark counts
 * ------------------------------------------------------------------ */

test('a question mark on the last prose line is enough — no marker needed', () => {
  const r = detectQuestionWithMutation({
    assistantText: 'There are two records here.\nWhat priority did you have in mind for the child?',
    toolCalls: calls('update_record'), isMutating,
  });
  assert.ok(r, 'a plain question with no marker phrase did not hold the write');
  assert.equal(r.via, 'question-mark');
});

test('a "?" inside a fenced code block is code, not a question', () => {
  // The false-positive that would make this guard withhold writes on exactly
  // the turns doing the most work.
  const text = 'Storing this condition:\n\n```js\nconst p = rec.priority?.value ?? "4";\n```\n\nApplying it now.';
  assert.equal(detectQuestionWithMutation({ assistantText: text, toolCalls: calls('update_record'), isMutating }), null);
  assert.equal(isAskingTheUser(text), null);
});

test('an unterminated fence still swallows its contents', () => {
  // A completion cut off mid-block is the shape that reaches here in practice.
  const text = 'Here is the script:\n\n```js\nif (x?.y) {\n';
  assert.equal(isAskingTheUser(text), null);
});

test('an inline code span carrying a "?" is code too', () => {
  assert.equal(isAskingTheUser('The guard reads `priority?.value` and moves on.'), null);
});

test('"should include" is not "should I"', () => {
  // Word boundaries, not substrings: markers are matched as phrases.
  assert.equal(isAskingTheUser('The payload should include impact and urgency.'), null);
});

test('the marker list is one exported const, and every entry is live', () => {
  assert.ok(CLARIFICATION_MARKERS.length >= 4);
  for (const m of ['let me know', 'which one', 'please confirm', 'should i']) {
    assert.ok(CLARIFICATION_MARKERS.includes(m), `the named baseline marker "${m}" is missing`);
  }
  // Every marker in the list must actually classify, or it is decoration.
  for (const m of CLARIFICATION_MARKERS) {
    const sample = m.replace(/\(\?:([^)]*)\)/g, (_, alts) => alts.split('|')[0]);
    assert.ok(isAskingTheUser(`Before I go on, ${sample} something.`), `marker never fires: ${m}`);
  }
});

test('the withheld payloads ride along, because nothing else keeps them', () => {
  const r = detectQuestionWithMutation({
    assistantText: 'Which one did you mean?',
    toolCalls: [
      { id: 'a', name: 'query_records', input: { table: 'incident' } },
      { id: 'b', name: 'update_record', input: { table: 'incident', sys_id: 'x', data: { priority: '4' } } },
    ],
    isMutating,
  });
  assert.deepEqual(r.held, ['update_record']);
  assert.deepEqual(r.discarded, [{ id: 'b', name: 'update_record', input: { table: 'incident', sys_id: 'x', data: { priority: '4' } } }]);
  assert.deepEqual(r.allowed.map((c) => c.name), ['query_records'], 'the reads were not kept');
});

/* ------------------------------------------------------------------ *
 * WI-2 — the A6 fence
 * ------------------------------------------------------------------ */

test('the fence catches a question only the user can answer', () => {
  for (const [text, reason] of [
    ['Which of the two incidents did you mean?', 'asks-for-a-fact'],
    ['Did you mean the parent or the child? Let me know.', 'asks-for-a-fact'],
    ['What value should I use for urgency?', 'asks-for-a-fact'],
    ['Who should this be assigned to?', 'asks-for-a-fact'],
    // No interrogative word at all — the two candidate targets are the signal.
    ['I found INC0010052 and INC0010053. Let me know and I will set the priority.', 'multiple-candidate-targets'],
  ]) {
    const r = detectClarifyingQuestion({ assistantText: text });
    assert.ok(r, `the fence missed: ${text}`);
    assert.equal(r.reason, reason, text);
  }
});

test('the fence does NOT catch a request for permission — A6 must still fire', () => {
  // Both measured stall texts A6 exists for. Fencing it must not delete it.
  for (const text of [
    'I have the variable sys_ids and the choice value. Shall I create this UI Policy now?',
    "If you're happy with this design, I'll create the flow on the instance. Let me know!",
    'Would you like me to proceed?',
  ]) {
    assert.equal(detectClarifyingQuestion({ assistantText: text }), null, `over-fenced: ${text}`);
  }
});

test('naming ONE record is not ambiguity', () => {
  // A turn that quotes the record it is about to change is doing the right
  // thing. Two candidates is the signal; one is just precision.
  assert.equal(detectClarifyingQuestion({
    assistantText: 'I will set INC0010053 to priority 4. Shall I proceed?',
  }), null);
});

test('sys_ids count as candidate targets too', () => {
  const r = detectClarifyingQuestion({
    assistantText: 'Two matches: 49b1d0538336cf50b939cc65eeaad3b7 and 8f1c40538336cf50b939cc65eeaad3c2. Let me know.',
  });
  assert.equal(r?.reason, 'multiple-candidate-targets');
});

test('the fence is checked BEFORE A6, so the ambiguous turn is never nudged', () => {
  // The incident's exact pair: ASKS_TO_PROCEED matches "let me know" and
  // IS_DIRECTIVE matches "change" — before the fence this nudged.
  assert.equal(detectStalledTurn({
    assistantText: 'I found INC0010052 (parent) and INC0010053 (child). Let me know and I will set the priority.',
    userText: 'acha ek kaam karo pripity ko change karke LOW kardo.',
    mutatingCallCount: 0,
  }), null, 'A6 still fires on the turn that caused the incident');

  // And the stall it exists for still reaches it.
  assert.ok(detectStalledTurn({
    assistantText: 'Shall I create this UI Policy now?',
    userText: 'make the justification field mandatory when duration is Permanent',
    mutatingCallCount: 0,
  }));
});
