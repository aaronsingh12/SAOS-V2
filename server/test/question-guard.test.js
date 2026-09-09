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
  isPermissionOnly,
  offersAChoice,
  needsAFactFromTheUser,
  candidateTargets,
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

test('every phrasing that asks the user to CHOOSE holds the write', () => {
  for (const text of [
    'Should I use the existing category?',
    'Which one of these did you mean?',
    'Please confirm the assignment group before I continue.',
    'Let me know which group to use.',
    // A choice dressed as an offer. No card can collect this answer.
    'Do you want me to use the Network group or Service Desk?',
  ]) {
    assert.ok(detectQuestionWithMutation({ assistantText: text, toolCalls: calls('create_record'), isMutating }), `missed: ${text}`);
  }
});

test('a question the GATE answers does not hold the write', () => {
  /*
   * MEASURED live 2026-08-24. The model wrote "I will update INC0010055 and set
   * its priority to Low. Please confirm you'd like me to apply this change." and
   * called the tool. Withholding that is a livelock: the user gets "withheld
   * pending your answer" plus a question whose only answer is "yes, go ahead" —
   * which is exactly what the approval card in front of them collects.
   */
  for (const text of [
    "I will set INC0010055 to Low. Please confirm you'd like me to apply this change.",
    'Shall I create it now?',
    'Do you want me to proceed with the Network group?',
    'Setting it to Low — okay to proceed?',
  ]) {
    assert.equal(detectQuestionWithMutation({ assistantText: text, toolCalls: calls('create_record'), isMutating }), null,
      `held a question the gate answers: ${text}`);
    assert.ok(isPermissionOnly(text), `not recognised as permission-only: ${text}`);
  }
});

test('permission phrasing does not launder a question that needs a fact', () => {
  // All three conditions have to hold. Each of these carries a permission
  // phrase AND something no card can answer.
  for (const text of [
    'Shall I proceed with INC0010054 or INC0010055?',
    'Shall I proceed — and which urgency should I use?',
  ]) {
    assert.equal(isPermissionOnly(text), false, `laundered: ${text}`);
    assert.ok(detectQuestionWithMutation({ assistantText: text, toolCalls: calls('update_record'), isMutating }));
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
    assistantText: 'Which of these did you mean?',
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

test('one record named twice is ONE candidate, not two', () => {
  /*
   * MEASURED live 2026-08-24, as a false positive in this guard. The model
   * wrote "I will update **INC0010055** (sys_id 3324289783b6cf50b939cc65eeaad335)
   * and set its priority to Low" — one record, named precisely — and counting
   * identifiers instead of records fenced A6 off a turn doing exactly what the
   * system prompt asks for.
   */
  const one = 'I will update INC0010055 (sys_id 3324289783b6cf50b939cc65eeaad335) and set its priority to Low.';
  assert.deepEqual(candidateTargets(one), ['INC0010055']);
  assert.equal(detectClarifyingQuestion({ assistantText: one + ' Please confirm.' }), null);

  // Two records, each named twice, is still two.
  const two = 'INC0010054 (5b242c5783b6cf50b939cc65eeaad31e) and INC0010055 (3324289783b6cf50b939cc65eeaad335). Let me know.';
  assert.equal(candidateTargets(two).length, 2);
  assert.equal(detectClarifyingQuestion({ assistantText: two })?.reason, 'multiple-candidate-targets');

  // Sys_ids alone still count when no numbers are quoted.
  assert.equal(candidateTargets('49b1d0538336cf50b939cc65eeaad3b7 and 8f1c40538336cf50b939cc65eeaad3c2').length, 2);
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

/* ------------------------------------------------------------------ *
 * FOLLOW-UP WI-4 — the disjunctive-permission boundary
 *
 * A permission phrasing wrapped around a CHOICE. The gate can collect a yes;
 * it cannot collect "which group". Fact-seeking therefore takes precedence
 * inside the permission branch.
 * ------------------------------------------------------------------ */

test('THE PIN — "Should I update INC0010052 or INC0010053?" is withheld', () => {
  // The named fixture. Green before the disjunction rule too, via the
  // two-candidate condition — pinned here so it stays green whichever of the
  // two conditions is doing the work.
  const r = detectQuestionWithMutation({
    assistantText: 'Should I update INC0010052 or INC0010053?',
    toolCalls: calls('update_record'), isMutating,
  });
  assert.ok(r, 'a disjunction between two records reached the gate');
  assert.deepEqual(r.held, ['update_record']);
  assert.equal(isPermissionOnly('Should I update INC0010052 or INC0010053?'), false);
});

test('a disjunction with NO record numbers is withheld too — this was the red one', () => {
  /*
   * The gap the pin above does not cover, because the two-candidate condition
   * cannot see it: a choice between values rather than between records.
   * "Shall I proceed" is in the permission list, so before the disjunction rule
   * every one of these went to the gate carrying a decision the model had made
   * for the user.
   */
  for (const text of [
    'Shall I proceed with the Network group or Service Desk?',
    'Should I apply this to the parent or the child?',
    'Okay to proceed, or would you rather I used Service Desk?',
  ]) {
    assert.equal(isPermissionOnly(text), false, `laundered a choice: ${text}`);
    assert.ok(detectQuestionWithMutation({ assistantText: text, toolCalls: calls('update_record'), isMutating }),
      `reached the gate: ${text}`);
  }
});

test('permission with no choice in it still goes to the gate', () => {
  // The other half of the boundary. Over-holding here is the livelock the
  // permission branch exists to prevent.
  for (const text of [
    'Shall I proceed with the Network group?',
    'Shall I create it now?',
    "I will set INC0010055 to Low. Please confirm you'd like me to apply this change.",
    'Setting it to Low — okay to proceed?',
  ]) {
    assert.ok(isPermissionOnly(text), `over-held: ${text}`);
    assert.equal(detectQuestionWithMutation({ assistantText: text, toolCalls: calls('update_record'), isMutating }), null);
  }
});

test('the disjunction is read off the LAST prose line, not the paragraph', () => {
  // A model describing the world is not offering a choice, and holding writes
  // on that would be noise on exactly the turns doing the most work.
  assert.equal(offersAChoice('Impact will be 1 or 2 depending on category.\nApplying it now.'), null);
  assert.ok(offersAChoice('Applying it now.\nShall I use Network or Service Desk?'));
  // Fenced code is not prose here either.
  assert.equal(offersAChoice('```js\nconst x = a || b;\n```\nDone.'), null);
});

test('the A6 fence uses the SAME definition — a choice is never nudged', () => {
  /*
   * One definition, two guards. Before this they were separately derived: the
   * permission branch and the fence could have disagreed about what a choice
   * is, and the fence disagreeing is how 2026-08-24 happened.
   */
  const text = 'Shall I proceed with the Network group or Service Desk?';
  const c = detectClarifyingQuestion({ assistantText: text });
  assert.ok(c, 'A6 would have nudged a turn that asked the user to choose');
  assert.equal(c.reason, 'asks-for-a-fact');
  assert.equal(c.via, 'disjunction');
  assert.equal(detectStalledTurn({ assistantText: text, userText: 'update the group', mutatingCallCount: 0 }), null);

  // And a genuine stall still reaches A6 — the fence must not swallow it.
  assert.ok(detectStalledTurn({
    assistantText: 'Shall I create this UI Policy now?',
    userText: 'make the justification field mandatory',
    mutatingCallCount: 0,
  }));
});

test('needsAFactFromTheUser says which signal fired', () => {
  assert.equal(needsAFactFromTheUser('Which incident did you mean?').via, 'marker');
  assert.equal(needsAFactFromTheUser('Shall I use Network or Service Desk?').via, 'disjunction');
  assert.equal(needsAFactFromTheUser('Shall I proceed?'), null);
});
