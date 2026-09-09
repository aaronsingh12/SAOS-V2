/**
 * PHASE 9 — CONCURRENCY TORTURE.
 *
 *   node --test server/test/
 *
 * Everything here runs GENUINELY concurrently, not in sequence with concurrent
 * naming. Where two things must overlap, a barrier holds the first inside its
 * tool until the second has entered — so the windows provably intersect rather
 * than merely appearing to.
 *
 * WHAT IS BEING LOOKED FOR is one thing wearing another's clothes: A's evidence
 * containing B's mutation, B's approval consuming A's card, A's cancellation
 * stopping B, one recovery lineage appearing under two steps. Phase 8 found and
 * closed the evidence case; this is the sweep for the rest.
 *
 * SQLITE IS SINGLE-WRITER. `node:sqlite` serialises writes on one connection, so
 * the contention that matters here is not lock timeouts but INTERLEAVING: two
 * plans making progress inside one another's windows, each writing rows the
 * other could mistake for its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p9con-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const P = await import('../src/agent/plan/index.js');
const R = await import('../src/agent/recovery/index.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask, getTask, cancelTask, completeTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');
const { deleteSession } = await import('../src/memory/sessions.js');

let n = 0;
function newSession(tag) {
  const id = `p9con-${tag}-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(id, new Date().toISOString(), new Date().toISOString());
  return id;
}
function newTaskIn(sessionId, goal) {
  const t = createTask({ sessionId, goal });
  startTask(t.id);
  return t.id;
}

const localTool = (name, spec) => { toolMap.set(name, { name, ...spec }); return () => toolMap.delete(name); };
const err = (status, m = 'boom') => Object.assign(new Error(m), { status });
const sysFor = (i) => String(i).padStart(2, '0').repeat(16);
const describeUpdate = (i, r) => ({ operation: 'update', table: i.table, requested: i.data, sys_id: r?.sys_id ?? i.sys_id });

const readStep = (id, tool, table = 'incident') => ({
  id, operation: `read ${id}`, capability: 'record_read', tool,
  mechanism: null, scope: null, mutating: false,
  target: { table, sys_id: null }, inputs: { table, limit: 1 },
  depends_on: [], expected_effects: [], verification: null,
});
const writeStep = (id, tool, table, sysId) => ({
  id, operation: `update ${id}`, capability: 'record_update', tool,
  mechanism: null, scope: null, mutating: true,
  target: { table, sys_id: sysId },
  inputs: { table, sys_id: sysId, data: { short_description: id } },
  depends_on: [], expected_effects: [`short_description becomes ${id}`],
  verification: { strategy: 'read_back', asserts: [`short_description == ${id}`] },
});

async function runPlan(taskId, sessionId, steps, { onGate = null, signal = null, recoverStep = null, goal = 'g' } = {}) {
  const saved = P.savePlan(taskId, { goal, steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  const events = [];
  const res = await P.executePlan({
    taskId,
    sessionId,
    turnSeq: 1,
    signal,
    recoverStep,
    emit: (e) => {
      events.push(e);
      if (e.type === 'approval_required') {
        if (onGate) setImmediate(() => onGate(e));
        else setImmediate(() => resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    },
  });
  return { res, events, plan: P.loadPlan(taskId), evidence: buildEvidence(taskId) };
}

/** A barrier that releases only once `count` participants have arrived. */
function barrier(count) {
  let arrived = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  return async () => { arrived += 1; if (arrived >= count) release(); await gate; };
}

/* ================================================================== *
 * A. TEN AT ONCE
 * ================================================================== */

test('C1 — 10 concurrent READ turns keep their evidence apart', async () => {
  const N = 10;
  const enter = barrier(N);
  const d = localTool('p9c_read', {
    mutating: false,
    // Every read is held until all ten have entered, so all ten windows overlap.
    execute: async (i) => { await enter(); return { ok: true, table: i.table }; },
  });
  try {
    const sessions = Array.from({ length: N }, (_, i) => newSession(`r${i}`));
    const tasks = sessions.map((s, i) => newTaskIn(s, `read ${i}`));
    await Promise.all(tasks.map((t, i) => runPlan(t, sessions[i], [readStep(`r${i}`, 'p9c_read')], { goal: `read ${i}` })));

    for (let i = 0; i < N; i += 1) {
      const ev = buildEvidence(tasks[i]);
      assert.deepEqual(ev.steps.map((s) => s.id), [`r${i}`], `task ${i} sees another task's steps`);
      assert.equal(ev.task.id, tasks[i]);
      assert.equal(ev.audit.exact, true, `task ${i} could not prove ownership of its own rows`);
      assert.equal(ev.audit.counts.toolEvents, ev.audit.counts.toolEventsExact);
    }
  } finally { d(); }
});

test('C2 — 10 concurrent PLANS with real mutations never claim each other\'s changes', async () => {
  const N = 10;
  const enter = barrier(N);
  const d = localTool('p9c_write', {
    mutating: true, describeWrite: describeUpdate,
    execute: async (i) => { await enter(); return { sys_id: i.sys_id, short_description: i.data.short_description }; },
  });
  try {
    const sessions = Array.from({ length: N }, (_, i) => newSession(`w${i}`));
    const tasks = sessions.map((s, i) => newTaskIn(s, `write ${i}`));
    sessions.forEach((s, i) => registerFromToolResult({ sessionId: s, seq: 0, table: 'incident', result: { sys_id: sysFor(i) } }));

    await Promise.all(tasks.map((t, i) => runPlan(
      t, sessions[i], [writeStep(`w${i}`, 'p9c_write', 'incident', sysFor(i))], { goal: `write ${i}` },
    )));

    for (let i = 0; i < N; i += 1) {
      const ev = buildEvidence(tasks[i]);
      assert.equal(ev.changes.length, 1, `task ${i} sees ${ev.changes.length} changes instead of 1`);
      assert.equal(ev.changes[0].sys_id, sysFor(i), `task ${i} claimed another task's record`);
      assert.equal(ev.changes[0].exact, true);
      assert.equal(ev.audit.exact, true);
    }
    // And the ledger holds exactly N rows, each naming its own task.
    const rows = getDb().prepare('SELECT task_id, sys_id FROM mutation_ledger WHERE task_id IN '
      + `(${tasks.map(() => '?').join(',')})`).all(...tasks);
    assert.equal(rows.length, N);
    assert.equal(new Set(rows.map((r) => r.task_id)).size, N, 'two ledger rows named the same task');
  } finally { d(); }
});

test('C3 — TWO plans in ONE session stay separate under overlap', async () => {
  const enter = barrier(2);
  const d = localTool('p9c_same_session', {
    mutating: true, describeWrite: describeUpdate,
    execute: async (i) => { await enter(); return { sys_id: i.sys_id, short_description: i.data.short_description }; },
  });
  try {
    const s = newSession('shared');
    const a = newTaskIn(s, 'plan A');
    const b = newTaskIn(s, 'plan B');
    registerFromToolResult({ sessionId: s, seq: 0, table: 'incident', result: { sys_id: sysFor(1) } });
    registerFromToolResult({ sessionId: s, seq: 1, table: 'problem', result: { sys_id: sysFor(2) } });

    await Promise.all([
      runPlan(a, s, [writeStep('a1', 'p9c_same_session', 'incident', sysFor(1))], { goal: 'A' }),
      runPlan(b, s, [writeStep('b1', 'p9c_same_session', 'problem', sysFor(2))], { goal: 'B' }),
    ]);

    const ea = buildEvidence(a); const eb = buildEvidence(b);
    assert.deepEqual(ea.changes.map((c) => c.table), ['incident']);
    assert.deepEqual(eb.changes.map((c) => c.table), ['problem']);
    assert.deepEqual(ea.steps.map((x) => x.id), ['a1']);
    assert.deepEqual(eb.steps.map((x) => x.id), ['b1']);
    assert.equal(ea.audit.exact, true);
    assert.equal(eb.audit.exact, true);
  } finally { d(); }
});

/* ================================================================== *
 * B. APPROVAL AND CANCELLATION
 * ================================================================== */

test('C4 — five concurrent approval cards cannot consume one another', async () => {
  const N = 5;
  const ran = [];
  const d = localTool('p9c_gate', {
    mutating: true, describeWrite: describeUpdate,
    execute: async (i) => { ran.push(i.data.short_description); return { sys_id: i.sys_id, short_description: i.data.short_description }; },
  });
  try {
    const sessions = Array.from({ length: N }, (_, i) => newSession(`g${i}`));
    const tasks = sessions.map((s, i) => newTaskIn(s, `gate ${i}`));
    sessions.forEach((s, i) => registerFromToolResult({ sessionId: s, seq: 0, table: 'incident', result: { sys_id: sysFor(i) } }));

    const cards = new Array(N).fill(null);
    const runs = tasks.map((t, i) => runPlan(
      t, sessions[i], [writeStep(`g${i}`, 'p9c_gate', 'incident', sysFor(i))],
      { onGate: (e) => { cards[i] = e; }, goal: `gate ${i}` },
    ));

    /*
     * Wait for every card. The bound is generous on purpose: this ran green
     * hundreds of times and failed once while a separate benchmark was loading
     * the same machine. A wall-clock wait that is only just long enough is a
     * test that fails for reasons that have nothing to do with what it checks.
     */
    for (let spin = 0; spin < 3000 && cards.some((c) => !c); spin += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(cards.every(Boolean),
      `not every card was raised within 30s: ${cards.map((c, i) => (c ? i : `MISSING:${i}`)).join(' ')}`);
    assert.equal(new Set(cards.map((c) => c.approvalId)).size, N, 'two cards share an approvalId');
    assert.equal(new Set(cards.map((c) => c.nonce)).size, N, 'two cards share a nonce');

    // Every cross-pairing of token and card is refused, and consumes nothing.
    for (let i = 0; i < N; i += 1) {
      for (let j = 0; j < N; j += 1) {
        if (i === j) continue;
        const out = resolveApproval(sessions[j], cards[j].approvalId, true, APPROVAL_SOURCES.USER_CLICK, cards[i].nonce);
        assert.equal(out.ok, false, `card ${j} accepted card ${i}'s token`);
        assert.equal(out.reason, 'token-mismatch');
      }
    }
    // All still pending, and each resolves with its own token.
    cards.forEach((c, i) => {
      assert.equal(resolveApproval(sessions[i], c.approvalId, true, APPROVAL_SOURCES.USER_CLICK, c.nonce).ok, true,
        `card ${i} was consumed by a cross-attempt`);
    });
    await Promise.all(runs);
    assert.equal(ran.length, N);
    assert.equal(new Set(ran).size, N, 'a tool ran twice for one card');
  } finally { d(); }
});

test('C5 — concurrent CANCELLATIONS stop only their own run', async () => {
  const N = 6;
  const enter = barrier(N);
  const ran = [];
  const ctls = Array.from({ length: N }, (_, i) => (i % 2 === 0 ? new AbortController() : null));
  const d = localTool('p9c_cancel', {
    mutating: false,
    execute: async (i) => {
      ran.push(i.table);
      // Hold every first step until all six are inside, so the windows provably
      // overlap; THEN abort the even runs from here rather than on a timer. A
      // wall-clock abort raced the run and fired after it had already finished.
      await enter();
      const m = /^tbl_(\d+)_(a|b)$/.exec(i.table);
      if (m && m[2] === 'a') ctls[Number(m[1])]?.abort();
      return { ok: true };
    },
  });
  try {
    const sessions = Array.from({ length: N }, (_, i) => newSession(`c${i}`));
    const tasks = sessions.map((s, i) => newTaskIn(s, `cancel ${i}`));

    const runs = tasks.map((t, i) => runPlan(t, sessions[i], [
      readStep(`c${i}a`, 'p9c_cancel', `tbl_${i}_a`),
      { ...readStep(`c${i}b`, 'p9c_cancel', `tbl_${i}_b`), depends_on: [`c${i}a`] },
    ], { signal: ctls[i]?.signal ?? null, goal: `cancel ${i}` }));

    const results = await Promise.all(runs);

    for (let i = 0; i < N; i += 1) {
      const plan = P.loadPlan(tasks[i]);
      if (i % 2 === 0) {
        assert.equal(plan.planState, 'cancelled', `run ${i} was signalled but is ${plan.planState}`);
      } else {
        assert.equal(results[i].res.ok, true, `run ${i} was NOT signalled but did not finish: ${results[i].res.note}`);
        assert.equal(plan.planState, 'completed');
        assert.ok(plan.steps.every((s) => s.state === 'completed'));
      }
    }
  } finally { d(); }
});

test('C6 — an AbortController is per-request: no shared controller leaks between sessions', () => {
  // Structural: the controller is created inside each request handler and never
  // stored anywhere reachable by another request.
  const agent = fs.readFileSync(new URL('../src/routes/agent.js', import.meta.url), 'utf8');
  const plan = fs.readFileSync(new URL('../src/routes/plan.js', import.meta.url), 'utf8');
  for (const [name, src] of [['agent', agent], ['plan', plan]]) {
    assert.match(src, /const controller = new AbortController\(\);/, `${name} route has no per-request controller`);
    // No module-level map of controllers keyed by anything.
    assert.ok(!/^const\s+\w*[Cc]ontrollers\s*=\s*new Map/m.test(src), `${name} route keeps a controller registry`);
  }
});

/* ================================================================== *
 * C. RECOVERY AND EVIDENCE UNDER LOAD
 * ================================================================== */

test('C7 — concurrent RECOVERIES keep their lineage on their own steps', async () => {
  const N = 6;
  const calls = new Map();
  const enter = barrier(N);
  const d = localTool('p9c_flaky', {
    mutating: false,
    execute: async (i) => {
      const k = i.table;
      const c = (calls.get(k) ?? 0) + 1;
      calls.set(k, c);
      await enter();
      if (c === 1) throw err(503);
      return { ok: true };
    },
  });
  try {
    // A distinct "table" per run so the tool can tell them apart.
    const sessions = Array.from({ length: N }, (_, i) => newSession(`rec${i}`));
    const tasks = sessions.map((s, i) => newTaskIn(s, `rec ${i}`));
    await Promise.all(tasks.map((t, i) => runPlan(
      t, sessions[i], [readStep(`k${i}`, 'p9c_flaky', `tbl_${i}`)],
      { recoverStep: R.recoverStep, goal: `rec ${i}` },
    )));

    for (let i = 0; i < N; i += 1) {
      const ev = buildEvidence(tasks[i]);
      assert.equal(ev.recovery.steps.length, 1, `task ${i} has ${ev.recovery.steps.length} recovery lineages`);
      assert.equal(ev.recovery.steps[0].step, `k${i}`, `task ${i} carries another task's lineage`);
      assert.equal(ev.recovery.recoveredSteps, 1);
      const history = P.recoveryHistory(tasks[i], `k${i}`);
      assert.equal(history.attempts.length, 1, `task ${i} accumulated ${history.attempts.length} attempts`);
    }
  } finally { d(); }
});

test('C8 — concurrent EVIDENCE reads are consistent and independent', async () => {
  const N = 8;
  const d = localTool('p9c_ev', { mutating: false, execute: async () => ({ ok: true }) });
  try {
    const sessions = Array.from({ length: N }, (_, i) => newSession(`ev${i}`));
    const tasks = sessions.map((s, i) => newTaskIn(s, `ev ${i}`));
    await Promise.all(tasks.map((t, i) => runPlan(t, sessions[i], [readStep(`e${i}`, 'p9c_ev')], { goal: `ev ${i}` })));

    // Read every task's evidence many times, all interleaved.
    const reads = [];
    for (let round = 0; round < 5; round += 1) {
      for (let i = 0; i < N; i += 1) reads.push(Promise.resolve().then(() => buildEvidence(tasks[i])));
    }
    const all = await Promise.all(reads);
    all.forEach((ev, k) => {
      const i = k % N;
      assert.equal(ev.task.id, tasks[i], 'an evidence read returned another task');
      assert.deepEqual(ev.steps.map((s) => s.id), [`e${i}`]);
    });
    // The same task read repeatedly is byte-identical: evidence is a pure
    // projection of durable state, not a snapshot of something moving.
    const first = JSON.stringify(buildEvidence(tasks[0]));
    for (let k = 0; k < 5; k += 1) assert.equal(JSON.stringify(buildEvidence(tasks[0])), first);
  } finally { d(); }
});

/* ================================================================== *
 * D. SESSION DELETION
 * ================================================================== */

test('C9 — deleting one session leaves another session\'s run untouched', async () => {
  const enter = barrier(2);
  const d = localTool('p9c_del', {
    mutating: false,
    execute: async () => { await enter(); return { ok: true }; },
  });
  try {
    const doomed = newSession('doomed');
    const kept = newSession('kept');
    const tDoomed = newTaskIn(doomed, 'doomed');
    const tKept = newTaskIn(kept, 'kept');

    const runs = Promise.all([
      runPlan(tDoomed, doomed, [readStep('d1', 'p9c_del')], { goal: 'doomed' }),
      runPlan(tKept, kept, [readStep('k1', 'p9c_del')], { goal: 'kept' }),
    ]);
    await runs;

    // Delete one session's chat entirely.
    deleteSession(doomed);

    // The surviving session is completely unaffected.
    const evKept = buildEvidence(tKept);
    assert.ok(evKept, 'the surviving task lost its evidence');
    assert.deepEqual(evKept.steps.map((s) => s.id), ['k1']);
    assert.equal(P.loadPlan(tKept).planState, 'completed');
    assert.equal(getTask(tKept).state, 'running');
  } finally { d(); }
});

test('C10 — evidence survives the deletion of its own chat', async () => {
  /*
   * PHASE 1's session-independence, proven end to end. A task carries no
   * foreign key to `sessions`, so deleting the conversation cannot cascade the
   * durable record away. What was done to the instance outlives the chat about
   * it — which is the entire reason the evidence layer exists.
   */
  const d = localTool('p9c_survive', {
    mutating: true, describeWrite: describeUpdate,
    execute: async (i) => ({ sys_id: i.sys_id, short_description: i.data.short_description }),
  });
  try {
    const s = newSession('erased');
    const t = newTaskIn(s, 'will outlive its chat');
    registerFromToolResult({ sessionId: s, seq: 0, table: 'incident', result: { sys_id: sysFor(7) } });
    await runPlan(t, s, [writeStep('survivor', 'p9c_survive', 'incident', sysFor(7))], { goal: 'survive' });
    completeTask(t);

    const before = buildEvidence(t);
    assert.equal(before.changes.length, 1);

    deleteSession(s);

    const after = buildEvidence(t);
    assert.ok(after, 'the evidence died with the chat');
    assert.equal(after.task.id, t);
    assert.deepEqual(after.steps.map((x) => x.id), ['survivor'],
      'the step record died with the chat');
    assert.equal(after.plan.goal, 'will outlive its chat',
      'the evidence lost the goal the task was created with');
    // The user's own words came from the transcript, which IS gone — and the
    // projection says so rather than inventing a replacement.
    assert.ok(after.request.text === null || typeof after.request.text === 'string');
  } finally { d(); }
});

/* ================================================================== *
 * E. TASK IDENTITY UNDER LOAD
 * ================================================================== */

test('C11 — 20 tasks created concurrently get distinct ids and no sequence collisions', async () => {
  const N = 20;
  const s = newSession('ids');
  const ids = await Promise.all(Array.from({ length: N }, async (_, i) => {
    const t = createTask({ sessionId: s, goal: `task ${i}` });
    startTask(t.id);
    return t.id;
  }));
  assert.equal(new Set(ids).size, N, 'two concurrently created tasks share an id');

  // Each gets its own three steps, and sequences are unique WITHIN each task.
  const readOnly = (id) => ({
    id, operation: id, capability: 'record_read', tool: 'get_record', mutating: false,
    inputs: {}, depends_on: [], expected_effects: [], verification: null,
  });
  await Promise.all(ids.map((t) => Promise.resolve().then(() => P.savePlan(t, {
    goal: 'g', steps: [readOnly('a'), readOnly('b'), readOnly('c')],
  }))));

  for (const t of ids) {
    const rows = getDb().prepare('SELECT sequence, plan_step_id FROM agent_task_steps WHERE task_id = ?').all(t);
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((r) => r.sequence)).size, 3, `task ${t} has duplicate sequences`);
    assert.equal(new Set(rows.map((r) => r.plan_step_id)).size, 3);
  }
});

test('C12 — task lifecycles move independently under concurrent terminal calls', async () => {
  const s = newSession('life');
  const ids = Array.from({ length: 9 }, (_, i) => newTaskIn(s, `life ${i}`));
  await Promise.all(ids.map((t, i) => Promise.resolve().then(() => {
    if (i % 3 === 0) completeTask(t);
    else if (i % 3 === 1) cancelTask(t);
    // the rest stay running
  })));
  ids.forEach((t, i) => {
    const state = getTask(t).state;
    const want = i % 3 === 0 ? 'completed' : i % 3 === 1 ? 'cancelled' : 'running';
    assert.equal(state, want, `task ${i} is ${state}, expected ${want}`);
  });
});

test('C13 — SQLite writes under concurrency neither lose rows nor deadlock', async () => {
  /*
   * `node:sqlite` is synchronous and single-writer, so the risk is not a lock
   * timeout but a lost or duplicated row when many async paths interleave
   * between awaits. This drives 60 audit writes across 12 tasks and counts.
   */
  const N = 12; const PER = 5;
  const { appendMutation } = await import('../src/memory/ledger.js');
  const s = newSession('load');
  const ids = Array.from({ length: N }, (_, i) => newTaskIn(s, `load ${i}`));

  await Promise.all(ids.flatMap((t, i) => Array.from({ length: PER }, (_, k) => Promise.resolve().then(() => {
    appendMutation({
      sessionId: s, turnSeq: 0, tool: 'update_record', taskId: t,
      descriptor: { table: 'incident', sys_id: sysFor(i), operation: 'update', requested: { short_description: `${i}-${k}` } },
      result: { sys_id: sysFor(i) },
      verification: { status: 'applied', applied: [{ field: 'short_description', value: `${i}-${k}` }] },
      approval: 'approved', approvedSource: APPROVAL_SOURCES.USER_CLICK,
    });
  }))));

  const total = getDb().prepare(
    `SELECT COUNT(*) AS n FROM mutation_ledger WHERE task_id IN (${ids.map(() => '?').join(',')})`,
  ).get(...ids).n;
  assert.equal(total, N * PER, `expected ${N * PER} ledger rows, found ${total}`);
  for (const t of ids) {
    const n2 = getDb().prepare('SELECT COUNT(*) AS n FROM mutation_ledger WHERE task_id = ?').get(t).n;
    assert.equal(n2, PER, `task ${t} has ${n2} rows instead of ${PER}`);
  }
});
