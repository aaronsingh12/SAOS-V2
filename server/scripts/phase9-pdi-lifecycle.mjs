/**
 * PHASE 9 — REAL PDI TEST: the complete lifecycle, all sixteen scenarios.
 *
 *   node scripts/phase9-pdi-lifecycle.mjs
 *
 * Real instance, real tools, real approval gate, real write guards, real
 * read-back verifier, real recovery engine, real evidence projection. The plans
 * are hand-authored so each scenario can be made to happen deliberately —
 * whether a MODEL can produce a good plan is measured separately, by
 * phase9-model-eval.mjs.
 *
 * WHAT IT WRITES. One disposable incident per run, created then updated, its
 * `short_description` naming it as a Phase 9 validation artifact so a human can
 * find and delete them. No pre-existing record is modified.
 *
 * TWO SCENARIOS NEED A DIFFERENT KIND OF PROOF. Restart and chat-deletion
 * cannot be shown by running a plan: they are about what survives when the
 * process or the conversation goes away. Both are done against a real database
 * file that is closed and reopened, with a real PDI mutation inside it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-pdi-'));
const DB_FILE = path.join(scratch, 'pdi.db');
_setDbForTests(migrate(new DatabaseSync(DB_FILE)));

const P = await import('../src/agent/plan/index.js');
const R = await import('../src/agent/recovery/index.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask, completeTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');
const { getSettings } = await import('../src/config/store.js');
const { table } = await import('../src/servicenow/client.js');
const { deleteSession } = await import('../src/memory/sessions.js');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const MARK = `NOWFORGE PHASE 9 VALIDATION ${STAMP}`;

const results = [];
const record = (id, label, verdict, detail) => {
  results.push({ id, label, verdict, detail });
  console.log(`[${verdict}] ${id.padEnd(5)} ${label}`);
  if (detail) console.log(`        ${detail}`);
};
const ok = (id, label, cond, detail) => record(id, label, cond ? 'PASS' : 'FAIL', detail);

let n = 0;
function newTask(goal) {
  const sid = `p9pdi-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const mk = (over) => ({
  id: over.id ?? 'step_1',
  operation: over.operation,
  capability: over.capability,
  tool: over.tool,
  mechanism: over.mechanism ?? 'rest',
  scope: null,
  mutating: over.mutating ?? false,
  target: over.target ?? null,
  inputs: over.inputs,
  depends_on: over.depends_on ?? [],
  expected_effects: over.expected_effects ?? [],
  verification: over.verification ?? null,
});

async function runPlan(taskId, sessionId, steps, {
  goal = 'phase 9', decide = true, signal = null, recoverStep = null, tamper = null, onGate = null,
} = {}) {
  const saved = P.savePlan(taskId, { goal, steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  if (tamper) tamper(taskId);
  const events = [];
  let gate = 0;
  const res = await P.executePlan({
    taskId,
    sessionId,
    turnSeq: 1,
    signal,
    recoverStep,
    emit: (e) => {
      events.push(e);
      if (e.type === 'approval_required') {
        if (onGate) { setImmediate(() => onGate(e, ++gate)); return; }
        if (decide !== null) {
          const answer = typeof decide === 'function' ? decide(++gate) : decide;
          setImmediate(() => resolveApproval(sessionId, e.approvalId, answer, APPROVAL_SOURCES.USER_CLICK, e.nonce));
        }
      }
    },
  });
  return { res, events, plan: P.loadPlan(taskId), evidence: buildEvidence(taskId) };
}

const readOf = async (sysId) => {
  try { return await table.get('incident', sysId, 'all'); } catch { return null; }
};
const descOf = (rec) => rec?.short_description?.value ?? rec?.short_description ?? null;

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`marker   : ${MARK}`);
console.log(`database : ${DB_FILE}`);
console.log();

/* ── 1. READ-ONLY INCIDENT LOOKUP ───────────────────────────────── */
{
  const { taskId, sessionId } = newTask('read incidents');
  const { res, evidence } = await runPlan(taskId, sessionId, [mk({
    operation: 'query active incidents', capability: 'record_read', tool: 'query_records',
    inputs: { table: 'incident', query: 'active=true', limit: 3 },
  })], { goal: 'read' });
  ok('L1', 'READ — a read plan runs against the live instance', res.ok,
    `final=${evidence.final.status} exact=${evidence.audit.exact}`);
}

/* ── 2 & 3. APPROVAL-GATED, VERIFIED MUTATION ───────────────────── */
let SYS = null;
{
  const { taskId, sessionId } = newTask('create a disposable validation incident');
  let gates = 0;
  const { res, evidence } = await runPlan(taskId, sessionId, [mk({
    operation: 'create a disposable validation incident',
    capability: 'record_create', tool: 'create_incident', mutating: true,
    inputs: { short_description: MARK, description: 'NowForge Phase 9 validation. Safe to delete.' },
    expected_effects: ['an incident exists with the validation marker'],
    verification: { strategy: 'read_back', asserts: [`short_description == ${MARK}`] },
  })], { goal: 'create', onGate: (e) => { gates += 1; resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce); } });

  const change = evidence.changes[0] ?? null;
  SYS = change?.sys_id ?? null;
  ok('L2', 'APPROVAL — the mutation stopped at the gate exactly once', gates === 1, `gates=${gates}`);
  ok('L3', 'MUTATION — created, read back, verified, and recorded exactly',
    Boolean(res.ok && change && change.verification_status === 'applied' && change.exact),
    change ? `sys_id=${String(SYS).slice(0, 12)}… number=${change.number} verify=${change.verification_status} `
      + `provenance=${change.approval?.source} exact=${change.exact} final=${evidence.final.status}`
      : `${res.reason}: ${res.note}`);
}

/* ── 4. TRANSFORMED / DERIVED FIELD ─────────────────────────────── */
if (SYS) {
  const { taskId, sessionId } = newTask('write a derived field');
  registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: SYS } });
  const { res, evidence } = await runPlan(taskId, sessionId, [mk({
    operation: 'set priority directly', capability: 'record_update', tool: 'update_record', mutating: true,
    target: { table: 'incident', sys_id: SYS },
    inputs: { table: 'incident', sys_id: SYS, data: { priority: '1' } },
    expected_effects: ['priority becomes 1'],
    verification: { strategy: 'read_back', asserts: ['priority == 1'] },
  })], { goal: 'derived', recoverStep: R.recoverStep });

  const c = evidence.changes[0] ?? {};
  ok('L4', 'DERIVED — the platform rewrote it, and the evidence says so rather than claiming success',
    c.verification_status === 'transformed' && evidence.final.status !== 'VERIFIED'
      && (c.transformed_fields ?? []).length > 0 && evidence.recovery.attempted === false,
    `verify=${c.verification_status} transformed=${JSON.stringify(c.transformed_fields)} `
    + `final=${evidence.final.status} res.ok=${res.ok} recovery=${evidence.recovery.attempted}`);
}

/* ── 5. REJECTED MUTATION ───────────────────────────────────────── */
if (SYS) {
  const { taskId, sessionId } = newTask('rejected update');
  registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: SYS } });
  const before = descOf(await readOf(SYS));
  const { res, evidence, events } = await runPlan(taskId, sessionId, [mk({
    operation: 'an update the user refuses', capability: 'record_update', tool: 'update_record', mutating: true,
    target: { table: 'incident', sys_id: SYS },
    inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'MUST NEVER LAND' } },
    expected_effects: ['nothing'], verification: { strategy: 'read_back', asserts: ['never'] },
  })], { goal: 'reject', decide: false, recoverStep: R.recoverStep });
  const after = descOf(await readOf(SYS));

  ok('L5', 'REJECTION — nothing written, no recovery, asked exactly once',
    before === after && !res.ok && evidence.changes.length === 0
      && evidence.recovery.attempted === false && res.recovery == null
      && events.filter((e) => e.type === 'approval_required').length === 1,
    `instance unchanged=${before === after} changes=${evidence.changes.length} `
    + `recovery=${evidence.recovery.attempted} gates=${events.filter((e) => e.type === 'approval_required').length}`);
}

/* ── 6. FAILED MUTATION → ELIGIBLE AUTOMATIC RECOVERY ───────────── */
{
  // A READ against the live instance whose FIRST attempt is failed at the
  // transport. Read-only is the one class that may retry unattended; attempt 2
  // is a real call to the real instance.
  const real = toolMap.get('query_records');
  let attempts = 0;
  toolMap.set('p9_flaky_read', {
    name: 'p9_flaky_read', mutating: false,
    execute: async (input, ctx) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('Service Unavailable'), { status: 503 });
      return real.execute(input, ctx);
    },
  });
  try {
    const { taskId, sessionId } = newTask('transient read failure');
    const { res, evidence } = await runPlan(taskId, sessionId, [mk({
      operation: 'read with one transient failure', capability: 'record_read', tool: 'p9_flaky_read',
      inputs: { table: 'incident', query: 'active=true', limit: 1 },
    })], { goal: 'recover', recoverStep: R.recoverStep });
    ok('L6', 'RECOVERY — a transient read retried once and the second attempt hit the instance',
      res.ok && attempts === 2 && evidence.recovery.recoveredSteps === 1,
      `attempts=${attempts} recovered=${evidence.recovery.recoveredSteps} `
      + `repeated_flagged=${evidence.uncertainties.some((u) => u.kind === 'repeated_mutation')}`);
  } finally { toolMap.delete('p9_flaky_read'); }
}

/* ── 7. RECOVERY THAT CORRECTLY REFUSES ─────────────────────────── */
{
  let attempts = 0;
  toolMap.set('p9_flaky_create', {
    name: 'p9_flaky_create', mutating: true,
    describeWrite: (i, r) => ({ operation: 'create', table: 'incident', requested: i, sys_id: r?.sys_id ?? null }),
    execute: async () => { attempts += 1; throw Object.assign(new Error('Service Unavailable'), { status: 503 }); },
  });
  try {
    const { taskId, sessionId } = newTask('transient create failure');
    const { res } = await runPlan(taskId, sessionId, [mk({
      operation: 'create with a transient failure', capability: 'record_create',
      tool: 'p9_flaky_create', mutating: true,
      inputs: { short_description: `${MARK} MUST NOT BE DUPLICATED` },
      expected_effects: ['an incident exists'],
      verification: { strategy: 'read_back', asserts: ['never'] },
    })], { goal: 'refuse', recoverStep: R.recoverStep });
    ok('L7', 'RECOVERY — a NON_IDEMPOTENT create is never repeated, however transient the fault',
      attempts === 1 && res.recovery?.decision?.idempotency === 'NON_IDEMPOTENT',
      `attempts=${attempts} decision=${res.recovery?.decision?.decision} idem=${res.recovery?.decision?.idempotency}`);
  } finally { toolMap.delete('p9_flaky_create'); }
}

/* ── 8. STALE PLAN FINGERPRINT ──────────────────────────────────── */
if (SYS) {
  const { taskId, sessionId } = newTask('stale approval');
  registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: SYS } });
  const before = descOf(await readOf(SYS));
  const { res, evidence } = await runPlan(taskId, sessionId, [mk({
    operation: 'update under a stale approval', capability: 'record_update', tool: 'update_record', mutating: true,
    target: { table: 'incident', sys_id: SYS },
    inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'STALE MUST NOT LAND' } },
    expected_effects: ['nothing'], verification: { strategy: 'read_back', asserts: ['never'] },
  })], {
    goal: 'stale', recoverStep: R.recoverStep,
    tamper: (id) => getDb().prepare('UPDATE agent_tasks SET plan_fingerprint = ? WHERE id = ?').run('0'.repeat(64), id),
  });
  const after = descOf(await readOf(SYS));
  ok('L8', 'STALE — a plan edited after approval writes nothing and reads as BLOCKED',
    before === after && !res.ok && evidence.final.status === 'BLOCKED' && evidence.recovery.attempted === false,
    `unchanged=${before === after} reason=${res.reason} final=${evidence.final.status}`);
}

/* ── 9. CANCELLATION BEFORE EXECUTION ───────────────────────────── */
{
  const ctl = new AbortController();
  ctl.abort();   // already cancelled before the plan starts
  const { taskId, sessionId } = newTask('cancel before execution');
  const { res, plan, evidence } = await runPlan(taskId, sessionId, [mk({
    operation: 'a read that never starts', capability: 'record_read', tool: 'query_records',
    inputs: { table: 'incident', limit: 1 },
  })], { goal: 'cancel early', signal: ctl.signal });
  ok('L9', 'CANCEL — cancelled before execution: nothing ran, and it reads as CANCELLED',
    !res.ok && plan.planState === 'cancelled' && evidence.final.status === 'CANCELLED',
    `plan=${plan.planState} final=${evidence.final.status} reason=${res.reason}`);
}

/* ── 10. CANCELLATION DURING A MUTATION ─────────────────────────── */
if (SYS) {
  /*
   * PHASE 0'S INVARIANT, tested against the real instance: a mutation already
   * inside its span MUST finish. The signal is aborted from inside the tool,
   * after the write has been issued — the write must complete, be verified and
   * be recorded, and only THEN may the run stop.
   */
  const realUpdate = toolMap.get('update_record');
  const ctl = new AbortController();
  let finished = false;
  const DURING = `${MARK} (cancelled mid-write)`;
  toolMap.set('p9_cancel_midwrite', {
    name: 'p9_cancel_midwrite', mutating: true,
    describeWrite: realUpdate.describeWrite,
    execute: async (input, ctx) => {
      ctl.abort();                       // cancellation arrives mid-flight
      const out = await realUpdate.execute(input, ctx);
      finished = true;
      return out;
    },
  });
  try {
    const { taskId, sessionId } = newTask('cancel during a mutation');
    registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: SYS } });
    const { evidence } = await runPlan(taskId, sessionId, [mk({
      operation: 'update while cancelling', capability: 'record_update',
      tool: 'p9_cancel_midwrite', mutating: true,
      target: { table: 'incident', sys_id: SYS },
      inputs: { table: 'incident', sys_id: SYS, data: { short_description: DURING } },
      expected_effects: ['short_description carries the mid-write marker'],
      verification: { strategy: 'read_back', asserts: [`short_description == ${DURING}`] },
    })], { goal: 'cancel mid-write', signal: ctl.signal, recoverStep: R.recoverStep });

    const live = descOf(await readOf(SYS));
    ok('L10', 'CANCEL — a mutation already in flight FINISHED, was verified, and was recorded',
      finished && live === DURING && evidence.changes.length === 1
        && evidence.changes[0].verification_status === 'applied',
      `tool completed=${finished} instance="${String(live).slice(-28)}" `
      + `changes=${evidence.changes.length} verify=${evidence.changes[0]?.verification_status}`);
    ok('L11', 'CANCEL — recovery did NOT start after the cancellation',
      evidence.recovery.attempted === false, `recovery=${evidence.recovery.attempted}`);
  } finally { toolMap.delete('p9_cancel_midwrite'); }
}

/* ── 11. CANCELLATION DURING APPROVAL ───────────────────────────── */
if (SYS) {
  const ctl = new AbortController();
  const { taskId, sessionId } = newTask('cancel at the gate');
  registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: SYS } });
  const before = descOf(await readOf(SYS));
  const p = runPlan(taskId, sessionId, [mk({
    operation: 'update while the user is deciding', capability: 'record_update',
    tool: 'update_record', mutating: true,
    target: { table: 'incident', sys_id: SYS },
    inputs: { table: 'incident', sys_id: SYS, data: { short_description: 'GATE-CANCEL MUST NOT LAND' } },
    expected_effects: ['nothing'], verification: { strategy: 'read_back', asserts: ['never'] },
  })], { goal: 'cancel at gate', signal: ctl.signal, decide: null, recoverStep: R.recoverStep });
  setTimeout(() => ctl.abort(), 400);
  const { plan, evidence, events } = await p;
  const after = descOf(await readOf(SYS));
  const resolved = events.find((e) => e.type === 'approval_resolved');
  ok('L12', 'CANCEL — cancelling at the gate writes nothing and never fabricates an approval',
    before === after && plan.planState === 'cancelled' && plan.steps[0].state === 'cancelled'
      && evidence.final.status === 'CANCELLED'
      && (!resolved || (resolved.approved === false && resolved.source === 'cancelled')),
    `unchanged=${before === after} plan=${plan.planState} step=${plan.steps[0].state} `
    + `resolved=${resolved ? `${resolved.approved}/${resolved.source}` : 'none'}`);
}

/* ── 12/13/14. EVIDENCE AFTER COMPLETION, FAILURE, RECOVERY ─────── */
{
  const rows = getDb().prepare(
    "SELECT id, plan_state FROM agent_tasks WHERE plan_state IS NOT NULL",
  ).all();
  const completed = rows.find((r) => r.plan_state === 'completed');
  const failed = rows.find((r) => r.plan_state === 'failed');
  const recovered = rows.map((r) => buildEvidence(r.id)).find((e) => e?.recovery?.attempted);

  const shapeOk = (ev) => ev && typeof ev.final?.status === 'string'
    && Array.isArray(ev.steps) && Array.isArray(ev.changes)
    && Array.isArray(ev.uncertainties) && typeof ev.audit?.exact === 'boolean'
    && typeof ev.recovery?.attempted === 'boolean';

  ok('L13', 'EVIDENCE — after a COMPLETED plan', completed ? shapeOk(buildEvidence(completed.id)) : false,
    completed ? `final=${buildEvidence(completed.id).final.status}` : 'no completed plan in this run');
  ok('L14', 'EVIDENCE — after a FAILED plan', failed ? shapeOk(buildEvidence(failed.id)) : false,
    failed ? `final=${buildEvidence(failed.id).final.status} `
      + `uncertainties=${JSON.stringify(buildEvidence(failed.id).uncertainties.map((u) => u.kind))}` : 'no failed plan');
  ok('L15', 'EVIDENCE — after a RECOVERY, the lineage is present and honest',
    Boolean(recovered && shapeOk(recovered) && recovered.recovery.steps.length > 0),
    recovered ? `recovered=${recovered.recovery.recoveredSteps} unrecovered=${recovered.recovery.unrecoveredSteps} `
      + `attempts=${JSON.stringify(recovered.recovery.steps[0]?.attempts?.map((a) => `${a.failure}->${a.decision}->${a.outcome}`))}`
      : 'no recovery happened in this run');
}

/* ── 15. RESTART / RECONNECT, THEN EVIDENCE ─────────────────────── */
{
  /*
   * Close the database — every AbortController, pending approval and cached
   * plan dies with it — then reopen the same file and ask for the evidence of a
   * REAL mutation made before the restart.
   */
  const targetId = getDb().prepare(
    "SELECT task_id FROM mutation_ledger WHERE task_id IS NOT NULL ORDER BY id ASC LIMIT 1",
  ).get()?.task_id ?? null;
  const beforeJson = targetId ? JSON.stringify(buildEvidence(targetId)) : null;

  getDb().close();
  const reopened = migrate(new DatabaseSync(DB_FILE));
  _setDbForTests(reopened);

  const afterEv = targetId ? buildEvidence(targetId) : null;
  ok('L16', 'RESTART — evidence for a real mutation is identical after a process restart',
    Boolean(targetId && afterEv && JSON.stringify(afterEv) === beforeJson),
    targetId
      ? `task=${String(targetId).slice(0, 8)}… changes=${afterEv?.changes?.length} `
        + `final=${afterEv?.final?.status} byte-identical=${JSON.stringify(afterEv) === beforeJson}`
      : 'no task-tagged mutation to reload');
}

/* ── 16. CHAT DELETION, THEN EVIDENCE ───────────────────────────── */
{
  const row = getDb().prepare(
    "SELECT task_id, session FROM mutation_ledger WHERE task_id IS NOT NULL ORDER BY id ASC LIMIT 1",
  ).get();
  if (row) {
    const before = buildEvidence(row.task_id);
    deleteSession(row.session);
    const after = buildEvidence(row.task_id);
    ok('L17', 'DELETION — the durable record of a real mutation outlives the chat about it',
      Boolean(after && after.changes.length === before.changes.length
        && after.steps.length === before.steps.length
        && after.changes[0]?.sys_id === before.changes[0]?.sys_id),
      after
        ? `changes ${before.changes.length}->${after.changes.length} steps ${before.steps.length}->${after.steps.length} `
          + `sys_id preserved=${after.changes[0]?.sys_id === before.changes[0]?.sys_id}`
        : 'the evidence died with the chat');
  } else {
    record('L17', 'DELETION — evidence outlives the chat', 'FAIL', 'no task-tagged mutation to test with');
  }
}

/* ── summary ────────────────────────────────────────────────────── */
console.log();
const pass = results.filter((r) => r.verdict === 'PASS').length;
const fail = results.filter((r) => r.verdict === 'FAIL').length;
console.log(`REAL PDI TEST — pass ${pass}  fail ${fail}  of ${results.length}`);
if (fail) {
  console.log();
  console.log('FAILURES:');
  for (const r of results.filter((x) => x.verdict === 'FAIL')) console.log(`  ${r.id} ${r.label}\n     ${r.detail}`);
}
if (SYS) {
  console.log();
  console.log(`disposable artifact left on the instance: incident ${SYS}`);
  console.log(`  find it with: short_descriptionSTARTSWITH${MARK.slice(0, 30)}`);
}
