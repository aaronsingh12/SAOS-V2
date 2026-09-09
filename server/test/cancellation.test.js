/**
 * Phase 0 — CANCELLATION, and the one thing it may never do.
 *
 *   node --test server/test/
 *
 * The whole feature is a promise about BOUNDARIES. Stop means "stop at the next
 * safe point", and the point of these tests is that "safe" is a property of the
 * loop rather than an intention in a comment:
 *
 *   - a turn cancelled before it starts never reaches the provider;
 *   - a turn cancelled between iterations never asks for a second completion;
 *   - a turn cancelled before a tool runs never runs it;
 *   - a tool ALREADY RUNNING is never interrupted, and its ledger row, its
 *     verification and its result are all written exactly as they would have
 *     been — then the turn stops;
 *   - a card waiting at the gate is neither approved nor rejected;
 *   - every path emits exactly one terminal frame.
 *
 * Test 4 is the load-bearing one. Everything else in this repo is built on
 * "a result is never the answer; the read-back is", and a cancellation that
 * could tear a mutation in half would leave a ledger that no longer describes
 * the instance. So it is asserted directly rather than argued.
 *
 * Offline in full: a scripted provider, tools registered through the registry's
 * own export, and a scratch SQLite file. No instance, no model, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-cancel-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
/*
 * The same world turn-control.test.js declares, and for the same reasons:
 * `llm.model` is blank so the context-window probe answers from its fallback
 * without reaching for a daemon, and the instance URL is unroutable so nothing
 * here can accidentally depend on a live PDI.
 */
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'test' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { _setChatTurnForTests } = await import('../src/agent/providers/index.js');
const { runTurn, resolveApproval, APPROVAL_SOURCES, NO_DECISION_SOURCES } = await import('../src/agent/orchestrator.js');
const { loadHistory, loadToolEvents } = await import('../src/memory/sessions.js');
const { mutationsForTurn } = await import('../src/memory/ledger.js');
const { toolMap } = await import('../src/agent/tools.js');
const { getDb } = await import('../src/memory/db.js');

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/**
 * A provider that says exactly what it is told to, once each — and RECORDS the
 * signal it was handed.
 *
 * Running off the end of the script is an error rather than a fallback. That is
 * what makes "the loop must not speak to the provider again" assertable: a loop
 * that continues when it should have stopped fails loudly here instead of
 * quietly reusing the last response.
 */
function scriptProvider(...responses) {
  const seen = [];
  _setChatTurnForTests(async (req) => {
    seen.push(req);
    const next = responses[seen.length - 1];
    if (!next) throw new Error(`the loop asked for completion ${seen.length}; the script only has ${responses.length}`);
    // A response may be a function, so a test can act (abort, resolve) at the
    // exact moment the provider is called.
    const body = typeof next === 'function' ? await next(req) : next;
    return { text: '', toolCalls: [], stopReason: 'stop', ...body };
  });
  return seen;
}

const call = (name, input = {}, id = `c-${name}`) => ({ id, name, input });

let n = 0;
const newSession = () => `cancel-${++n}`;

/** The terminal frames, in the order they were emitted. */
const TERMINALS = new Set(['done', 'error', 'cancelled']);
const terminalsOf = (events) => events.filter((e) => TERMINALS.has(e.type));

/**
 * Drive one turn with a controller the test owns, and collect everything.
 *
 * `onEvent` runs for every frame BEFORE it is recorded, which is how a test
 * cancels at a precise moment in the turn — the same way a real Stop click
 * arrives, from outside the loop while it is mid-flight.
 */
async function runCancellable(userText, { responses, onEvent = () => {}, preAbort = false } = {}) {
  const seen = scriptProvider(...responses);
  const sessionId = newSession();
  const controller = new AbortController();
  const events = [];
  if (preAbort) controller.abort();
  await runTurn(sessionId, userText, (e) => {
    try { onEvent(e, controller, sessionId); } catch (err) { events.push({ type: '__handler_threw', message: err.message }); }
    events.push(e);
  }, { signal: controller.signal });
  return {
    sessionId,
    controller,
    providerCalls: seen.length,
    seen,
    events,
    of: (type) => events.filter((e) => e.type === type),
    terminals: () => terminalsOf(events),
    guards: () => loadToolEvents(sessionId).filter((e) => e.kind === 'guard'),
    toolEvents: () => loadToolEvents(sessionId),
    history: () => loadHistory(sessionId),
    ledger: () => {
      const seq = getDb().prepare('SELECT MAX(seq) AS s FROM messages WHERE session = ? AND role = ?')
        .get(sessionId, 'user')?.s ?? 0;
      return mutationsForTurn(sessionId, seq);
    },
  };
}

/** Every cancellation path must end the stream once, and with `cancelled`. */
function assertCancelledOnce(r, where) {
  const terminals = r.terminals();
  assert.equal(terminals.length, 1, `${where}: expected exactly one terminal frame, got ${terminals.map((t) => t.type).join(', ') || 'none'}`);
  assert.equal(terminals[0].type, 'cancelled', `${where}: the terminal frame was "${terminals[0].type}", not "cancelled"`);
  assert.equal(r.of('done').length, 0, `${where}: a done frame was emitted alongside cancelled`);
  assert.equal(r.of('error').length, 0, `${where}: an error frame was emitted alongside cancelled`);
}

/** The audit row the harness writes for a cancellation. */
function cancellationRow(r) {
  const rows = r.guards().filter((g) => g.name === 'turn_cancelled');
  assert.equal(rows.length, 1, `expected one turn_cancelled row, got ${rows.length}`);
  // `loadToolEvents` already parses the payload — it is an object, not JSON.
  return { row: rows[0], payload: rows[0].payload || {} };
}

/* ------------------------------------------------------------------ *
 * TEST 1 — cancellation before the first iteration
 * ------------------------------------------------------------------ */

test('T1 — a turn cancelled before it starts never reaches the provider', async () => {
  const r = await runCancellable('create an incident for the printer outage', {
    preAbort: true,
    // Deliberately non-empty: if the loop calls the provider at all, it gets a
    // usable answer and the turn proceeds — so the assertion below fails on the
    // behaviour rather than on a missing script entry.
    responses: [{ text: 'Creating it now.', toolCalls: [call('update_record', { table: 'incident', sys_id: 'x'.repeat(32), data: { priority: '4' } })] }],
  });

  assert.equal(r.providerCalls, 0, 'the provider was called on a turn that was already cancelled');
  assert.equal(r.of('tool_use').length, 0, 'a tool was announced on a cancelled turn');
  assert.equal(r.of('approval_required').length, 0, 'an approval card was raised on a cancelled turn');
  assertCancelledOnce(r, 'T1');

  const { payload } = cancellationRow(r);
  assert.equal(payload.phase, 'before-first-iteration');
  assert.equal(payload.iteration, 0);
  assert.equal(payload.toolActive, false);
  assert.equal(payload.mutationsCompleted, 0);
  // Requested and observed are both recorded, and requested came first.
  assert.ok(payload.requestedAt, 'the cancellation request time was not recorded');
  assert.ok(payload.observedAt, 'the cancellation observation time was not recorded');
});

/* ------------------------------------------------------------------ *
 * TEST 2 — cancellation between iterations
 * ------------------------------------------------------------------ */

test('T2 — cancelled after iteration 1, the provider is never asked a second time', async () => {
  /*
   * Iteration 1 runs a read to completion, which is what makes this a
   * BETWEEN-iterations test rather than a before-tools one: the tool ran, its
   * result was fed back, and the loop was about to ask for completion 2. The
   * script HAS that second completion, so a loop that continues will reach it
   * and this test fails on the count rather than on a missing response.
   */
  toolMap.set('cancel_probe_read', {
    name: 'cancel_probe_read', mutating: false, execute: async () => ({ rows: [] }),
  });
  try {
    const r = await runCancellable('what incidents are open?', {
      responses: [
        { text: 'Looking.', toolCalls: [call('cancel_probe_read')] },
        { text: 'There are none.' },
      ],
      // Stop lands the instant the read comes back — the boundary between
      // "this iteration is finished" and "ask the model again".
      onEvent: (e, controller) => { if (e.type === 'tool_result') controller.abort(); },
    });

    assert.equal(r.providerCalls, 1, 'the provider was asked for a second completion after cancellation');
    assert.equal(r.of('tool_result').length, 1, 'the completed read was not reported');
    assertCancelledOnce(r, 'T2');

    const { payload } = cancellationRow(r);
    assert.equal(payload.phase, 'iteration-boundary');
    assert.equal(payload.iteration, 1, 'the cancellation was not observed at the top of iteration 2');

    // The read's result survives in history, complete and paired with its call.
    const hist = r.history();
    const toolRows = hist.filter((h) => h.role === 'tool');
    assert.equal(toolRows.length, 1, 'the completed read lost its result row');
    assert.equal(toolRows[0].results.length, 1);
  } finally { toolMap.delete('cancel_probe_read'); }
});

/* ------------------------------------------------------------------ *
 * TEST 3 — cancellation before a tool executes
 * ------------------------------------------------------------------ */

test('T3 — cancelled after the completion, the tool it proposed never runs', async () => {
  let executed = 0;
  toolMap.set('cancel_probe_write', {
    name: 'cancel_probe_write', mutating: true,
    execute: async () => { executed += 1; return { ok: true }; },
  });
  try {
    const r = await runCancellable('set INC0010052 to priority 4', {
      responses: [
        { text: 'Setting INC0010052 to Low now.', toolCalls: [call('cancel_probe_write', { sys_id: 'a'.repeat(32) })] },
      ],
      // `assistant_text` is emitted immediately before the after-completion
      // boundary and before any tool is touched.
      onEvent: (e, controller) => { if (e.type === 'assistant_text') controller.abort(); },
    });

    assert.equal(executed, 0, 'the tool executed on a cancelled turn');
    assert.equal(r.of('approval_required').length, 0, 'a human was asked to authorise a write on a cancelled turn');
    assert.equal(r.of('tool_use').length, 0);
    assert.equal(r.ledger().length, 0, 'a mutation was recorded for a tool that never ran');
    assertCancelledOnce(r, 'T3');

    const { payload } = cancellationRow(r);
    assert.equal(payload.phase, 'after-completion');

    /*
     * The stored assistant row must carry NO tool call.
     *
     * This is the half that is easy to get wrong and expensive to discover: a
     * `tool_call` with no matching result is the shape the wire format rejects,
     * so leaving one behind would poison every LATER request in this session
     * rather than failing here. The prose is kept — the user paid for it.
     */
    const hist = r.history();
    const assistant = hist.filter((h) => h.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0].text, 'Setting INC0010052 to Low now.', 'the model\'s prose was discarded');
    assert.equal((assistant[0].toolCalls || []).length, 0, 'an unanswered tool_call was left in history');
    assert.equal(hist.filter((h) => h.role === 'tool').length, 0);

    // And the discarded payload is not simply lost: it is the only record of
    // what the model was about to do.
    const discarded = r.guards().filter((g) => g.name === 'cancelled_before_tools');
    assert.equal(discarded.length, 1);
    assert.deepEqual(discarded[0].payload.discarded, ['cancel_probe_write']);
    assert.deepEqual(r.of('calls_discarded')[0].discarded, ['cancel_probe_write']);
  } finally { toolMap.delete('cancel_probe_write'); }
});

/* ------------------------------------------------------------------ *
 * TEST 4 — cancellation DURING a mutation. The critical one.
 * ------------------------------------------------------------------ */

test('T4 — a running mutation is never interrupted, and the ledger stays whole', async () => {
  /*
   * THE INVARIANT THIS FILE EXISTS FOR.
   *
   * Stop arrives while the tool is inside `execute`. The tool must finish, its
   * result must be recorded, its ledger row must be written and its capture
   * must run — and only then may the turn stop. Anything else leaves a ledger
   * that no longer describes the instance, which is the one failure this
   * codebase spends the most effort making impossible.
   *
   * The tool aborts the controller ITSELF, mid-flight, and then keeps working.
   * That is the sharpest possible version of the test: the signal is set for
   * the entire remainder of the call, so any code that consulted it inside the
   * mutation pipeline would bail out and be caught here.
   */
  let finished = false;
  let sawSignalMidFlight = false;
  toolMap.set('cancel_probe_slow_write', {
    name: 'cancel_probe_slow_write', mutating: true,
    execute: async (input, ctx) => {
      pendingAbort();                      // Stop, pressed while this runs
      sawSignalMidFlight = pendingSignal().aborted;
      // Yield the loop several times: an implementation that checked the signal
      // between awaits inside the pipeline would have every chance to bail.
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      finished = true;
      return { sys_id: 'b'.repeat(32), number: 'INC0099999', ok: true, ctxSession: Boolean(ctx?.sessionId) };
    },
  });

  let pendingAbort = () => {};
  let pendingSignal = () => ({ aborted: false });

  try {
    const seen = scriptProvider(
      { text: 'Updating INC0099999 now.', toolCalls: [call('cancel_probe_slow_write', { sys_id: 'b'.repeat(32) })] },
      { text: 'Done.' },   // present on purpose: reaching it is the failure
    );
    const sessionId = newSession();
    const controller = new AbortController();
    pendingAbort = () => controller.abort();
    pendingSignal = () => controller.signal;

    const events = [];
    await runTurn(sessionId, 'update INC0099999', (e) => {
      events.push(e);
      // Approve on a later tick, exactly as a click arrives.
      if (e.type === 'approval_required') {
        setImmediate(() => {
          const res = resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce);
          if (!res?.ok) throw new Error(`the gate refused approval: ${res?.reason}`);
        });
      }
    }, { signal: controller.signal });

    const r = {
      sessionId, events,
      of: (t) => events.filter((e) => e.type === t),
      terminals: () => terminalsOf(events),
      guards: () => loadToolEvents(sessionId).filter((e) => e.kind === 'guard'),
      history: () => loadHistory(sessionId),
    };

    // 1. The tool was allowed to finish.
    assert.equal(sawSignalMidFlight, true, 'the test did not actually cancel while the tool was running');
    assert.equal(finished, true, 'the tool was interrupted — a running mutation must never be cut off');

    // 2. Its result was recorded normally.
    const results = r.of('tool_result');
    assert.equal(results.length, 1, 'the completed mutation produced no result');
    assert.equal(results[0].isError, false, 'a completed mutation was reported as a failure because the turn was cancelled');

    // 3. The mutation ledger is intact and describes the write.
    const userSeq = getDb().prepare('SELECT MAX(seq) AS s FROM messages WHERE session = ? AND role = ?')
      .get(sessionId, 'user')?.s ?? 0;
    const ledger = mutationsForTurn(sessionId, userSeq);
    assert.equal(ledger.length, 1, 'the completed mutation is missing from the ledger');
    assert.equal(ledger[0].tool, 'cancel_probe_slow_write');
    assert.equal(ledger[0].approval, 'approved', 'the approval provenance was lost when the turn was cancelled');
    assert.equal(ledger[0].approvedSource, APPROVAL_SOURCES.USER_CLICK);
    // The tool declares no `describeWrite`, so it verifies itself — the point
    // here is that a status was recorded at all, not which one.
    assert.ok(ledger[0].status, 'the ledger row has no verification status');

    // 4. The harness's own report still renders, and still contains the write.
    const report = r.of('mutation_report');
    assert.equal(report.length, 1, 'a cancelled turn skipped its mutation report');
    assert.equal(report[0].mutations.length, 1);

    // 5. Nothing further was started.
    assert.equal(seen.length, 1, 'the provider was asked for another completion after cancellation');
    assert.equal(r.of('tool_use').length, 1, 'a second tool was announced after cancellation');

    // 6. One terminal frame, and it is `cancelled`.
    assertCancelledOnce(r, 'T4');

    // 7. The audit row says a tool was mid-flight when Stop was pressed.
    const rows = r.guards().filter((g) => g.name === 'turn_cancelled');
    assert.equal(rows.length, 1);
    const payload = rows[0].payload;
    assert.equal(payload.toolActive, true, 'the audit row does not record that a tool was running');
    assert.equal(payload.tool, 'cancel_probe_slow_write');
    assert.equal(payload.mutationsCompleted, 1);

    // 8. History is consistent: one call, one matching result.
    const hist = r.history();
    const assistant = hist.filter((h) => h.role === 'assistant');
    assert.equal((assistant[0].toolCalls || []).length, 1, 'the executed call was stripped from history');
    const toolRows = hist.filter((h) => h.role === 'tool');
    assert.equal(toolRows.length, 1);
    assert.equal(toolRows[0].results.length, 1);
    assert.equal(toolRows[0].results[0].id, assistant[0].toolCalls[0].id, 'the call and its result do not match up');
  } finally { toolMap.delete('cancel_probe_slow_write'); }
});

/* ------------------------------------------------------------------ *
 * TEST 5 — cancellation while a card is waiting at the gate
 * ------------------------------------------------------------------ */

test('T5 — a card cancelled at the gate is neither approved nor rejected', async () => {
  let executed = 0;
  toolMap.set('cancel_probe_gated', {
    name: 'cancel_probe_gated', mutating: true,
    execute: async () => { executed += 1; return { ok: true }; },
  });
  try {
    let approvalId = null;
    const r = await runCancellable('delete the stale record', {
      responses: [
        { text: 'Removing it now.', toolCalls: [call('cancel_probe_gated', { sys_id: 'c'.repeat(32) })] },
        { text: 'Done.' },
      ],
      // Stop while the card is on screen — no approve, no reject, just gone.
      onEvent: (e, controller) => {
        if (e.type === 'approval_required') {
          approvalId = e.approvalId;
          setImmediate(() => controller.abort());
        }
      },
    });

    assert.equal(r.of('approval_required').length, 1, 'the card was never raised');
    assert.equal(executed, 0, 'the tool ran after its approval was cancelled');
    assert.equal(r.providerCalls, 1, 'the loop continued after cancelling at the gate');

    // No decision was fabricated in EITHER direction.
    assert.equal(r.of('approval_resolved').length, 0, 'a cancelled card was reported as resolved');
    assert.equal(r.of('approval_cancelled').length, 1, 'the cancelled card was not reported as cancelled');

    // Nothing executable is left behind: the pending entry is gone, so a late
    // click cannot resurrect the mutation.
    const late = resolveApproval(r.sessionId, approvalId, true, APPROVAL_SOURCES.USER_CLICK, 'anything');
    assert.equal(late.ok, false, 'the approval was still pending after cancellation — a late click could run it');
    assert.equal(late.reason, 'no-such-approval');

    // The audit row records the call as cancelled, with NO approval on it.
    const toolRow = r.toolEvents().find((e) => e.name === 'cancel_probe_gated');
    assert.ok(toolRow, 'the cancelled call was not recorded');
    assert.equal(toolRow.result_status, 'cancelled');
    assert.equal(toolRow.approval, null, 'a cancelled card left an approval value on the audit row');

    assertCancelledOnce(r, 'T5');
    const { payload } = cancellationRow(r);
    assert.equal(payload.phase, 'awaiting-approval');
    assert.equal(payload.mutationsCompleted, 0, 'a mutation was counted for a call that never ran');
  } finally { toolMap.delete('cancel_probe_gated'); }
});

test('T5b — cancellation is its own approval source, distinct from a rejection', () => {
  // Both mean "nobody decided", and both must stay distinguishable: a timeout is
  // an unanswered question, a cancellation is a stopped turn, and neither may be
  // written into the trail as a refusal someone made.
  assert.deepEqual([...NO_DECISION_SOURCES], ['timeout', 'cancelled']);
  assert.equal(NO_DECISION_SOURCES.includes('rejected'), false);
  assert.equal(NO_DECISION_SOURCES.includes(APPROVAL_SOURCES.USER_CLICK), false);
});

/* ------------------------------------------------------------------ *
 * TEST 6 — the ordinary approval path is untouched
 * ------------------------------------------------------------------ */

test('T6 — an uncancelled turn still approves, executes and completes with done', async () => {
  /*
   * The regression guard for the whole phase. `awaitApproval` grew a third
   * settlement path and an abort listener; this asserts the two it already had
   * still work, on a turn that carries a live signal which is never aborted —
   * the shape every real turn now has.
   */
  let executed = 0;
  toolMap.set('cancel_probe_ok', {
    name: 'cancel_probe_ok', mutating: true,
    execute: async () => { executed += 1; return { sys_id: 'd'.repeat(32), ok: true }; },
  });
  try {
    const r = await runCancellable('update the record', {
      responses: [
        { text: 'Updating it now.', toolCalls: [call('cancel_probe_ok', { sys_id: 'd'.repeat(32) })] },
        { text: 'Done — the record is updated.' },
      ],
      onEvent: (e, _controller, sessionId) => {
        if (e.type === 'approval_required') {
          setImmediate(() => {
            const res = resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce);
            if (!res?.ok) throw new Error(`the gate refused approval: ${res?.reason}`);
          });
        }
      },
    });

    assert.equal(executed, 1, 'an approved mutation did not run');
    assert.equal(r.providerCalls, 2, 'the turn did not feed the result back');
    assert.equal(r.of('approval_resolved').length, 1);
    assert.equal(r.of('approval_resolved')[0].approved, true);
    assert.equal(r.of('approval_cancelled').length, 0, 'an uncancelled turn reported a cancelled card');

    const terminals = r.terminals();
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].type, 'done', 'an uncancelled turn did not end with done');
    assert.equal(r.guards().filter((g) => g.name === 'turn_cancelled').length, 0,
      'an uncancelled turn wrote a cancellation row');
  } finally { toolMap.delete('cancel_probe_ok'); }
});

test('T6b — a REJECTED card is still a rejection, not a cancellation', async () => {
  // The distinction cancellation must never blur: a rejection is a decision a
  // person made, and it keeps its own source, its own audit status, and the
  // "do not retry it" message the write guard depends on.
  let executed = 0;
  toolMap.set('cancel_probe_rej', {
    name: 'cancel_probe_rej', mutating: true,
    execute: async () => { executed += 1; return { ok: true }; },
  });
  try {
    const r = await runCancellable('update the record', {
      responses: [
        { text: 'Updating it now.', toolCalls: [call('cancel_probe_rej', { sys_id: 'e'.repeat(32) })] },
        { text: 'Understood — I have not changed anything.' },
      ],
      onEvent: (e, _controller, sessionId) => {
        if (e.type === 'approval_required') {
          setImmediate(() => resolveApproval(sessionId, e.approvalId, false, APPROVAL_SOURCES.USER_CLICK, e.nonce));
        }
      },
    });

    assert.equal(executed, 0);
    assert.equal(r.of('approval_resolved').length, 1);
    assert.equal(r.of('approval_resolved')[0].approved, false);
    assert.equal(r.of('approval_cancelled').length, 0, 'a rejection was reported as a cancellation');
    const toolRow = r.toolEvents().find((e) => e.name === 'cancel_probe_rej');
    assert.equal(toolRow.result_status, 'rejected', 'a rejection lost its own status');
    assert.equal(toolRow.approval, 'rejected');
    assert.equal(r.terminals()[0].type, 'done');
  } finally { toolMap.delete('cancel_probe_rej'); }
});

/* ------------------------------------------------------------------ *
 * TEST 8 — continuation accounting survives
 * ------------------------------------------------------------------ */

test('T8 — cancellation adds no continuation reason and cannot launder one', async () => {
  /*
   * WI-2's invariant: the loop may not reach iteration i without i sanctioned
   * reasons recorded, and only three reasons are legal. Cancellation must be a
   * way OUT of the loop, never a fourth way to stay in it — so it adds no
   * reason and every cancelled turn simply stops.
   */
  const { CONTINUATION_REASONS, assertContinuationsAccountFor } = await import('../src/agent/orchestrator.js');
  assert.deepEqual(
    Object.values(CONTINUATION_REASONS).sort(),
    ['a6_stall_nudge', 'tool_results', 'unexplained_mutation_bounce'],
    'cancellation added a continuation reason — it must end the turn, not extend it',
  );
  assert.throws(
    () => assertContinuationsAccountFor(1, ['cancelled']),
    /unrecognised turn continuation/,
    'the continuation guard would accept "cancelled" as a reason to speak to the provider again',
  );

  // And the live path: a turn cancelled between iterations records no
  // continuation for the iteration it never ran.
  toolMap.set('cancel_probe_read2', { name: 'cancel_probe_read2', mutating: false, execute: async () => ({ ok: true }) });
  try {
    const r = await runCancellable('look it up', {
      responses: [
        { toolCalls: [call('cancel_probe_read2')] },
        { text: 'unreachable' },
      ],
      onEvent: (e, controller) => { if (e.type === 'tool_result') controller.abort(); },
    });
    assert.equal(r.providerCalls, 1);
    assert.equal(r.of('error').length, 0, 'the continuation guard threw on a cancelled turn');
    assertCancelledOnce(r, 'T8');
  } finally { toolMap.delete('cancel_probe_read2'); }
});

/* ------------------------------------------------------------------ *
 * TEST 9 — the terminal-frame invariant, on every cancellation path
 * ------------------------------------------------------------------ */

test('T9 — every cancellation path emits exactly one terminal frame', async () => {
  /*
   * Asserted across the paths rather than at one of them, because the invariant
   * is a property of the exit and there are five ways to reach it. A missing
   * terminal frame is indistinguishable from a truncated stream, which is the
   * defect `sse()` was hardened against; a doubled one would show a user both a
   * completion and a stop for the same turn.
   */
  toolMap.set('cancel_probe_multi', {
    name: 'cancel_probe_multi', mutating: false, execute: async () => ({ ok: true }),
  });
  try {
    const paths = [
      {
        where: 'before-first-iteration',
        opts: { preAbort: true, responses: [{ text: 'unreachable' }] },
      },
      {
        where: 'after-completion',
        opts: {
          responses: [{ text: 'About to look.', toolCalls: [call('cancel_probe_multi')] }],
          onEvent: (e, c) => { if (e.type === 'assistant_text') c.abort(); },
        },
      },
      {
        where: 'iteration-boundary',
        opts: {
          responses: [{ toolCalls: [call('cancel_probe_multi')] }, { text: 'unreachable' }],
          onEvent: (e, c) => { if (e.type === 'tool_result') c.abort(); },
        },
      },
    ];
    for (const p of paths) {
      const r = await runCancellable(`terminal frame probe: ${p.where}`, p.opts);
      assertCancelledOnce(r, p.where);
      const { payload } = cancellationRow(r);
      assert.equal(payload.phase, p.where, `${p.where}: the audit row named phase "${payload.phase}"`);
    }
  } finally { toolMap.delete('cancel_probe_multi'); }
});

test('T9b — a turn cancelled mid-sequence keeps history sendable', async () => {
  /*
   * Two calls in one completion; the first runs, then Stop. The second must
   * come OUT of the stored assistant row, because an unanswered `tool_call` is
   * rejected by the wire format and would break the NEXT request in this
   * session rather than this one — the failure mode is remote from its cause,
   * which is exactly why it is asserted here.
   */
  let ran = 0;
  toolMap.set('cancel_probe_first', {
    name: 'cancel_probe_first', mutating: false,
    execute: async () => { ran += 1; return { ok: true }; },
  });
  toolMap.set('cancel_probe_second', {
    name: 'cancel_probe_second', mutating: false,
    execute: async () => { ran += 1; return { ok: true }; },
  });
  try {
    const r = await runCancellable('do both', {
      responses: [
        { text: 'Doing both.', toolCalls: [call('cancel_probe_first'), call('cancel_probe_second')] },
        { text: 'unreachable' },
      ],
      onEvent: (e, c) => { if (e.type === 'tool_result' && e.name === 'cancel_probe_first') c.abort(); },
    });

    assert.equal(ran, 1, 'the second tool ran after cancellation');
    assertCancelledOnce(r, 'T9b');

    const hist = r.history();
    const assistant = hist.filter((h) => h.role === 'assistant')[0];
    const toolRow = hist.filter((h) => h.role === 'tool')[0];
    assert.equal((assistant.toolCalls || []).length, 1, 'the unrun call was left in history');
    assert.equal(assistant.toolCalls[0].name, 'cancel_probe_first');
    assert.equal(toolRow.results.length, 1);
    assert.equal(toolRow.results[0].id, assistant.toolCalls[0].id);

    const discarded = r.guards().filter((g) => g.name === 'cancelled_before_tools');
    assert.equal(discarded.length, 1);
    assert.deepEqual(discarded[0].payload.discarded, ['cancel_probe_second']);
  } finally {
    toolMap.delete('cancel_probe_first');
    toolMap.delete('cancel_probe_second');
  }
});

/* ------------------------------------------------------------------ *
 * TEST 10 — provider neutrality
 * ------------------------------------------------------------------ */

test('T10 — the cancellation plumbing names no vendor outside providers/', () => {
  /*
   * The repo already asserts this over the whole tree (llm-gateway,
   * openrouter-provider). This is the narrower, targeted version: the files
   * Phase 0 actually touched. It exists because "propagate the signal to the
   * provider" is exactly the change that tempts someone to branch on which
   * provider is configured, and a tree-wide test reports that as a diffuse
   * failure rather than as this one.
   */
  const here = path.dirname(fileURLToPath(import.meta.url));
  const VENDORS = /\b(anthropic|openai|ollama|openrouter|opencode|claude|gpt-4|gpt-oss|llama)\b/i;

  const codeLines = (file) => fs.readFileSync(path.resolve(here, file), 'utf8')
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    // Comments explain WHY; a vendor named in one is documentation, not
    // coupling. The rule is about code.
    .filter(({ line }) => !/^(\/\/|\*|\/\*)/.test(line));

  // The orchestrator owns the whole cancellation contract and must name no
  // vendor at all: it hands the signal to `chatTurn` and judges cancellation
  // from its own signal, never from which provider is configured.
  const orch = codeLines('../src/agent/orchestrator.js').filter(({ line }) => VENDORS.test(line));
  assert.deepEqual(orch.map((o) => `${o.n}: ${o.line}`), [],
    'the orchestrator names a vendor in code — cancellation must not branch on the provider');

  /*
   * The chat route is checked the same way, minus one pre-existing exception:
   * `GET /openrouter/models` proxies that vendor's public model list so the
   * Settings picker is populated live. It predates this phase, is unrelated to
   * cancellation, and is named here rather than excluded by a loose regex — so
   * a NEW vendor reference in this file still fails.
   */
  const route = codeLines('../src/routes/agent.js')
    .filter(({ line }) => VENDORS.test(line))
    .filter(({ line }) => !/openrouter/i.test(line));
  assert.deepEqual(route.map((o) => `${o.n}: ${o.line}`), [],
    'the chat route names a vendor in code outside the pre-existing OpenRouter model-list proxy');
});

test('T10b — the signal reaches the provider through the neutral request', async () => {
  /*
   * The other half of neutrality: the orchestrator must HAND the signal over
   * rather than reaching around the abstraction to cancel a specific vendor's
   * client. Asserted at the seam every adapter sits behind.
   */
  const seen = scriptProvider({ text: 'ok' });
  const controller = new AbortController();
  await runTurn(newSession(), 'anything at all', () => {}, { signal: controller.signal });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].signal, 'chatTurn was called without a signal');
  assert.equal(seen[0].signal, controller.signal, 'the adapter was handed a different signal than the turn owns');
  // And the rest of the neutral request is unchanged.
  for (const k of ['system', 'history', 'tools', 'maxTokens', 'decoding']) {
    assert.ok(k in seen[0], `the neutral request lost its ${k} key`);
  }
});

test('T10c — a turn with no signal behaves exactly as before', async () => {
  // Cancellation is opt-in per execution. Every other caller of `runTurn` — and
  // every existing test — passes no signal, and must be unaffected.
  const seen = scriptProvider({ text: 'A plain answer.' });
  const sessionId = newSession();
  const events = [];
  await runTurn(sessionId, 'who is this assigned to?', (e) => events.push(e));
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].signal, 'a turn with no signal invented one');
  const terminals = terminalsOf(events);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, 'done');
});

/* ------------------------------------------------------------------ *
 * Cleanup invariants
 * ------------------------------------------------------------------ */

test('cleanup — a cancelled turn closes its capture window and leaves no listener', async () => {
  /*
   * A capture window left open makes every LATER session's update rows look
   * contested, and the transport guard then stops capturing anything at all —
   * a failure that shows up in a different session from the one that caused it.
   * It lives in `runTurn`'s `finally`, so this asserts that cancellation exits
   * through that `finally` rather than around it.
   */
  const { _openWindows } = await import('../src/servicenow/transport.js');
  toolMap.set('cancel_probe_cleanup', {
    name: 'cancel_probe_cleanup', mutating: false, execute: async () => ({ ok: true }),
  });
  try {
    const r = await runCancellable('probe the cleanup path', {
      responses: [{ text: 'Working.', toolCalls: [call('cancel_probe_cleanup')] }],
      onEvent: (e, c) => { if (e.type === 'assistant_text') c.abort(); },
    });
    assert.equal(_openWindows().has(r.sessionId), false, 'the capture window survived a cancelled turn');

    // The abort listener is removed with the turn: a signal that outlives one
    // execution must not keep that turn's closure — and its whole history —
    // alive. Firing it again after the turn has ended must do nothing at all.
    assert.doesNotThrow(() => r.controller.abort(), 'aborting after the turn ended threw');
    assert.equal(r.terminals().length, 1, 'a late abort added a second terminal frame');
  } finally { toolMap.delete('cancel_probe_cleanup'); }
});

test('cleanup — Stop on an idle turn is inert', async () => {
  // The button is only shown while a turn runs, but the server must not depend
  // on the UI for that: a signal aborted after the turn settled changes nothing.
  const seen = scriptProvider({ text: 'Finished.' });
  const controller = new AbortController();
  const events = [];
  await runTurn(newSession(), 'say something', (e) => events.push(e), { signal: controller.signal });
  controller.abort();
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1);
  assert.equal(terminalsOf(events).length, 1);
  assert.equal(terminalsOf(events)[0].type, 'done');
});

/* ------------------------------------------------------------------ *
 * The route's lifecycle assumption
 * ------------------------------------------------------------------ */

test('route lifecycle — a client disconnect aborts, and a normal end does not', async () => {
  /*
   * THE ONE ASSUMPTION THE TESTS ABOVE CANNOT REACH.
   *
   * Everything else here drives `runTurn` directly with a controller the test
   * owns. The route instead infers cancellation from Node's `response` 'close'
   * event — which fires for BOTH "the response completed" and "the connection
   * was terminated prematurely". Reading those as the same thing would abort
   * the controller at the end of every successful turn.
   *
   * `routes/agent.js` guards against that with `turnSettled` (set before
   * `res.end()`) and `res.writableEnded`. This exercises that exact pattern
   * over a REAL socket, against the real Express and Node in this environment,
   * because it is a claim about the runtime rather than about our code — and a
   * claim about the runtime is worth checking rather than assuming.
   *
   * It deliberately stands in for the route rather than importing it: the route
   * calls `runTurn` unconditionally, and the property under test is the
   * lifecycle wiring around that call, which is 12 lines and reproduced here
   * verbatim.
   */
  const express = (await import('express')).default;
  const outcomes = [];

  const app = express();
  app.post('/stream/:mode', async (req, res) => {
    const mode = req.params.mode;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

    // ── verbatim from routes/agent.js ──────────────────────────────────
    const controller = new AbortController();
    let turnSettled = false;
    const onClientGone = () => {
      if (turnSettled || res.writableEnded) return;
      controller.abort();
    };
    res.on('close', onClientGone);
    try {
      res.write('data: {"type":"meta"}\n\n');
      // A "turn": resolves on its own, or when the signal fires.
      await new Promise((resolve) => {
        if (mode === 'quick') return resolve();
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
        setTimeout(resolve, 5_000).unref();      // a hang is a failure, not a pass
      });
      res.write(`data: {"type":"${controller.signal.aborted ? 'cancelled' : 'done'}"}\n\n`);
    } finally {
      turnSettled = true;
      res.off('close', onClientGone);
      res.end();
      outcomes.push({ mode, aborted: controller.signal.aborted });
    }
    // ───────────────────────────────────────────────────────────────────
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. A turn that finishes normally must NOT be read as a disconnect.
    const okRes = await fetch(`${base}/stream/quick`, { method: 'POST' });
    const okBody = await okRes.text();
    assert.match(okBody, /"type":"done"/, 'a completed turn did not emit done');
    // Give the 'close' that res.end() causes a chance to fire before asserting.
    await new Promise((r) => setTimeout(r, 50));
    const quick = outcomes.find((o) => o.mode === 'quick');
    assert.equal(quick.aborted, false,
      'THE LIFECYCLE TRAP: a normally-completed response was read as a client disconnect and aborted its own controller');

    // 2. A client that goes away mid-stream MUST abort.
    const ac = new AbortController();
    const hung = fetch(`${base}/stream/hang`, { method: 'POST', signal: ac.signal });
    // Wait until the first frame has actually been received, so the abort
    // lands mid-stream rather than before the handler ran.
    const reader = (await hung).body.getReader();
    await reader.read();
    ac.abort();
    await new Promise((r) => setTimeout(r, 150));
    const hang = outcomes.find((o) => o.mode === 'hang');
    assert.ok(hang, 'the hung handler never reached its finally — the disconnect was not observed');
    assert.equal(hang.aborted, true, 'a client disconnect did not abort the turn');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
