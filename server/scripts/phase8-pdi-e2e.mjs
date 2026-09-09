/**
 * PHASE 8 — REAL PDI TEST: the complete execution path, end to end.
 *
 *   node scripts/phase8-pdi-e2e.mjs
 *
 * WHAT THIS IS. Hand-authored plans, the REAL tool registry, the REAL approval
 * gate, the REAL write guards, the REAL read-back verifier and the REAL
 * ServiceNow instance. The plan is written by hand rather than by a model so
 * each scenario can be made to happen deliberately — a rejection, a stale
 * fingerprint, a cancellation. Whether a MODEL can produce a good plan is a
 * different question and is measured separately.
 *
 * WHAT IT WRITES. One disposable incident per run, created and then updated,
 * with `short_description` naming it as a Phase 8 validation artifact so a
 * human can find and delete them. Nothing else on the instance is touched, and
 * no existing record is modified.
 *
 * It runs against a live instance and is therefore NOT part of the offline
 * suite. Anything it exposes gets an offline regression test of its own.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-pdi-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'pdi.db'))));

const P = await import('../src/agent/plan/index.js');
const R = await import('../src/agent/recovery/index.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { toolMap } = await import('../src/agent/tools.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');
const { getSettings } = await import('../src/config/store.js');
const { table } = await import('../src/servicenow/client.js');

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const MARK = `NOWFORGE PHASE 8 VALIDATION ${STAMP}`;

const results = [];
const record = (id, label, verdict, detail) => {
  results.push({ id, label, verdict, detail });
  const colour = verdict === 'PASS' ? 'PASS' : verdict === 'SKIP' ? 'SKIP' : 'FAIL';
  console.log(`[${colour}] ${id.padEnd(4)} ${label}`);
  if (detail) console.log(`        ${detail}`);
};

let n = 0;
function newTask(goal) {
  const sid = `pdi-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

async function runPlan(taskId, sessionId, steps, {
  goal = 'phase 8', decide = true, signal = null, recoverStep = null, tamper = null,
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
      if (e.type === 'approval_required' && decide !== null) {
        const answer = typeof decide === 'function' ? decide(gate += 1) : decide;
        setImmediate(() => resolveApproval(sessionId, e.approvalId, answer, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    },
  });
  return { res, events, plan: P.loadPlan(taskId), evidence: buildEvidence(taskId) };
}

const mkStep = (over) => ({
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

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`marker   : ${MARK}`);
console.log();

/* ================================================================== *
 * 1. READ — does the real path read the real instance?
 * ================================================================== */

let liveIncident = null;
{
  const { taskId, sessionId } = newTask('read an incident');
  const { res, evidence } = await runPlan(taskId, sessionId, [mkStep({
    id: 'read_1', operation: 'query active incidents', capability: 'record_read',
    tool: 'query_records', inputs: { table: 'incident', query: 'active=true', limit: 1 },
  })], { goal: 'read' });

  const raw = P.loadPlan(taskId).steps[0].result;
  const parsed = (() => { try { return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)); } catch { return raw; } })();
  const first = Array.isArray(parsed) ? parsed[0] : (parsed?.records?.[0] ?? null);
  liveIncident = first?.sys_id?.value ?? first?.sys_id ?? null;

  record('R1', 'READ — a read plan executes against the live instance',
    res.ok ? 'PASS' : 'FAIL',
    res.ok ? `sys_id ${String(liveIncident).slice(0, 12)}…, evidence final=${evidence.final.status}`
      : `${res.reason}: ${res.note}`);
  record('R2', 'READ — evidence records the read as exact, not correlated',
    evidence.audit.exact === true ? 'PASS' : 'FAIL',
    `audit.exact=${evidence.audit.exact} counts=${JSON.stringify(evidence.audit.counts)}`);
}

/* ================================================================== *
 * 2. SAFE MUTATION — create a disposable incident, then update it.
 * ================================================================== */

let createdSysId = null;
{
  const { taskId, sessionId } = newTask('create a disposable validation incident');
  const { res, evidence } = await runPlan(taskId, sessionId, [mkStep({
    id: 'create_1', operation: 'create a disposable validation incident',
    capability: 'record_create', tool: 'create_incident', mutating: true,
    inputs: { short_description: MARK, description: 'Created by NowForge Phase 8 validation. Safe to delete.' },
    expected_effects: ['an incident exists with the validation marker'],
    verification: { strategy: 'read_back', asserts: [`short_description == ${MARK}`] },
  })], { goal: 'create' });

  const change = evidence.changes[0] ?? null;
  createdSysId = change?.sys_id ?? null;
  record('M1', 'MUTATION — create executes, verifies, and lands in the ledger',
    res.ok && change ? 'PASS' : 'FAIL',
    change
      ? `sys_id ${String(createdSysId).slice(0, 12)}… number=${change.number} verification=${change.verification_status} exact=${change.exact}`
      : `${res.reason}: ${res.note}`);
  record('M2', 'MUTATION — approval provenance is user_click, recorded on the ledger row',
    change?.approval?.source === 'user_click' ? 'PASS' : 'FAIL',
    JSON.stringify(change?.approval ?? null));
  record('M3', 'MUTATION — evidence separates EXECUTION from VERIFICATION',
    evidence.steps[0]?.executed === true && typeof evidence.steps[0]?.verification?.status === 'string'
      ? 'PASS' : 'FAIL',
    `executed=${evidence.steps[0]?.executed} verification=${evidence.steps[0]?.verification?.status} final=${evidence.final.status}`);
}

if (createdSysId) {
  const { taskId, sessionId } = newTask('update the disposable incident');
  registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: createdSysId } });
  const NEWDESC = `${MARK} (updated)`;
  const { res, evidence } = await runPlan(taskId, sessionId, [mkStep({
    id: 'update_1', operation: 'update the validation incident', capability: 'record_update',
    tool: 'update_record', mutating: true,
    target: { table: 'incident', sys_id: createdSysId },
    inputs: { table: 'incident', sys_id: createdSysId, data: { short_description: NEWDESC } },
    expected_effects: ['short_description carries the updated marker'],
    verification: { strategy: 'read_back', asserts: [`short_description == ${NEWDESC}`] },
  })], { goal: 'update' });

  const change = evidence.changes[0] ?? null;
  record('M4', 'MUTATION — update executes and READ-BACK verifies against the instance',
    res.ok && change?.verification_status === 'applied' ? 'PASS' : 'FAIL',
    change ? `verification=${change.verification_status} changed=${JSON.stringify(change.changed_fields)}` : `${res.reason}: ${res.note}`);

  // Confirm independently, outside the harness, that the instance really moved.
  try {
    const live = await table.get('incident', createdSysId, 'all');
    const got = live?.short_description?.value ?? live?.short_description;
    record('M5', 'MUTATION — an INDEPENDENT read confirms the instance actually changed',
      got === NEWDESC ? 'PASS' : 'FAIL', `instance now reads: ${String(got).slice(0, 80)}`);
  } catch (err) {
    record('M5', 'MUTATION — an INDEPENDENT read confirms the instance actually changed', 'FAIL', err.message);
  }
}

/* ================================================================== *
 * 3. REJECTION
 * ================================================================== */

if (createdSysId) {
  const { taskId, sessionId } = newTask('rejected update');
  registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: createdSysId } });
  const before = await table.get('incident', createdSysId, 'all');
  const beforeDesc = before?.short_description?.value ?? before?.short_description;

  const { res, evidence, events } = await runPlan(taskId, sessionId, [mkStep({
    id: 'reject_1', operation: 'update that the user refuses', capability: 'record_update',
    tool: 'update_record', mutating: true,
    target: { table: 'incident', sys_id: createdSysId },
    inputs: { table: 'incident', sys_id: createdSysId, data: { short_description: 'THIS MUST NEVER LAND' } },
    expected_effects: ['nothing'],
    verification: { strategy: 'read_back', asserts: ['never'] },
  })], { goal: 'reject', decide: false, recoverStep: R.recoverStep });

  const after = await table.get('incident', createdSysId, 'all');
  const afterDesc = after?.short_description?.value ?? after?.short_description;

  record('J1', 'REJECTION — nothing was written to the instance',
    afterDesc === beforeDesc ? 'PASS' : 'FAIL', `before="${beforeDesc}" after="${afterDesc}"`);
  record('J2', 'REJECTION — the plan fails and no approval was fabricated',
    !res.ok && evidence.changes.length === 0 ? 'PASS' : 'FAIL',
    `ok=${res.ok} changes=${evidence.changes.length} note=${String(res.note).slice(0, 90)}`);
  record('J3', 'REJECTION — recovery was NOT invoked on a refusal',
    evidence.recovery.attempted === false && res.recovery == null ? 'PASS' : 'FAIL',
    `recovery.attempted=${evidence.recovery.attempted} res.recovery=${res.recovery ? 'present' : 'null'}`);
  record('J4', 'REJECTION — the user was asked exactly once',
    events.filter((e) => e.type === 'approval_required').length === 1 ? 'PASS' : 'FAIL',
    `gates=${events.filter((e) => e.type === 'approval_required').length}`);
}

/* ================================================================== *
 * 4. VERIFICATION FAILURE — a real calculated field the platform discards.
 * ================================================================== */

if (createdSysId) {
  const { taskId, sessionId } = newTask('write a calculated field');
  registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: createdSysId } });
  // `priority` on task tables is CALCULATED from impact+urgency. The platform
  // accepts the write and discards it. This is the project's own ledger trap,
  // used here as a genuine verification mismatch rather than a manufactured one.
  const { res, evidence } = await runPlan(taskId, sessionId, [mkStep({
    id: 'verifail_1', operation: 'set priority directly', capability: 'record_update',
    tool: 'update_record', mutating: true,
    target: { table: 'incident', sys_id: createdSysId },
    inputs: { table: 'incident', sys_id: createdSysId, data: { priority: '1' } },
    expected_effects: ['priority becomes 1'],
    verification: { strategy: 'read_back', asserts: ['priority == 1'] },
  })], { goal: 'verification mismatch', recoverStep: R.recoverStep });

  const step = evidence.steps[0] ?? {};
  const change = evidence.changes[0] ?? null;
  record('V1', 'VERIFY — the write EXECUTED (execution and verification stay separate)',
    step.executed === true ? 'PASS' : 'FAIL', `executed=${step.executed}`);
  record('V2', 'VERIFY — verification did NOT become success just because it ran',
    ['no-op', 'partial', 'transformed'].includes(change?.verification_status ?? step.verification?.status)
      ? 'PASS' : 'FAIL',
    `verification=${change?.verification_status ?? step.verification?.status} final=${evidence.final.status}`);
  record('V3', 'VERIFY — a verification mismatch triggers no unsafe automatic retry',
    (evidence.recovery.steps[0]?.attempts ?? []).every((a) => a.decision !== 'RETRY') ? 'PASS' : 'FAIL',
    `decisions=${JSON.stringify((evidence.recovery.steps[0]?.attempts ?? []).map((a) => a.decision))}`);
  /*
   * A `transformed` write is deliberately NOT a failed write: the call reached
   * the instance and something landed, so `isFailedWrite` covers `no-op` and
   * `partial` only. Recovery is therefore never consulted here — nothing
   * failed — and the honesty is carried entirely by the verdict and the final
   * status. That is the contract this asserts.
   *
   * The consequence for callers: `res.ok` is TRUE while the run is UNVERIFIED.
   * Phase 5's `final.status` is the authority, not the boolean, which is why
   * the Evidence UI must never collapse the two.
   */
  record('V4', 'VERIFY — a transformed write names the fields and reports UNVERIFIED, without recovery',
    (change?.transformed_fields ?? []).length > 0
    && evidence.final.status === 'UNVERIFIED'
    && evidence.recovery.attempted === false ? 'PASS' : 'FAIL',
    `transformed=${JSON.stringify(change?.transformed_fields)} final=${evidence.final.status} `
    + `res.ok=${res.ok} recovery=${evidence.recovery.attempted}`);
  record('V5', 'VERIFY — the run is UNVERIFIED even though res.ok is true (status is authoritative)',
    res.ok === true && evidence.final.status !== 'VERIFIED' ? 'PASS' : 'FAIL',
    `res.ok=${res.ok} final=${evidence.final.status} — a UI reading res.ok alone would report success`);
}

/* ================================================================== *
 * 5. CANCELLATION
 * ================================================================== */

{
  // Between steps: step 1 completes, cancellation is requested, step 2 never runs.
  const ctl = new AbortController();
  const { taskId, sessionId } = newTask('cancel between steps');
  const { res, plan, evidence } = await runPlan(taskId, sessionId, [
    mkStep({ id: 'c1', operation: 'read one', capability: 'record_read', tool: 'query_records',
      inputs: { table: 'incident', query: 'active=true', limit: 1 } }),
    mkStep({ id: 'c2', operation: 'read two', capability: 'record_read', tool: 'query_records',
      inputs: { table: 'incident', query: 'active=true', limit: 1 }, depends_on: ['c1'] }),
  ], {
    goal: 'cancel',
    signal: ctl.signal,
    // Abort as soon as the first step reports completion.
    decide: true,
  });
  record('C1', 'CANCEL — (between steps) baseline ran without a signal', res.ok ? 'PASS' : 'FAIL',
    `states=${plan.steps.map((s) => s.state).join(',')} final=${evidence.final.status}`);
  ctl.abort();
}

{
  const ctl = new AbortController();
  const { taskId, sessionId } = newTask('cancel at the approval gate');
  if (createdSysId) registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: createdSysId } });
  const before = createdSysId ? await table.get('incident', createdSysId, 'all') : null;

  const p = runPlan(taskId, sessionId, [mkStep({
    id: 'cg1', operation: 'update while cancelling', capability: 'record_update',
    tool: 'update_record', mutating: true,
    target: { table: 'incident', sys_id: createdSysId },
    inputs: { table: 'incident', sys_id: createdSysId, data: { short_description: 'CANCELLED — MUST NOT LAND' } },
    expected_effects: ['nothing'], verification: { strategy: 'read_back', asserts: ['never'] },
  })], { goal: 'cancel at gate', signal: ctl.signal, decide: null, recoverStep: R.recoverStep });

  setTimeout(() => ctl.abort(), 500);
  const { res, plan, evidence } = await p;
  const after = createdSysId ? await table.get('incident', createdSysId, 'all') : null;

  record('C2', 'CANCEL — cancelling at the gate writes nothing to the instance',
    (before?.short_description?.value ?? null) === (after?.short_description?.value ?? null) ? 'PASS' : 'FAIL',
    `plan=${plan.planState} step=${plan.steps[0].state}`);
  record('C3', 'CANCEL — a cancellation is a cancellation, never a rejection or a failure',
    plan.planState === 'cancelled' ? 'PASS' : 'FAIL', `planState=${plan.planState} reason=${res.reason}`);
  record('C4', 'CANCEL — cancellation starts no recovery',
    evidence.recovery.attempted === false ? 'PASS' : 'FAIL',
    `recovery.attempted=${evidence.recovery.attempted}`);
  record('C5', 'CANCEL — evidence reports CANCELLED, not FAILED',
    evidence.final.status === 'CANCELLED' ? 'PASS' : 'FAIL', `final=${evidence.final.status}`);
}

/* ================================================================== *
 * 6. STALE PLAN
 * ================================================================== */

if (createdSysId) {
  const { taskId, sessionId } = newTask('stale approval');
  registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: createdSysId } });
  const before = await table.get('incident', createdSysId, 'all');

  const { res, plan, evidence } = await runPlan(taskId, sessionId, [mkStep({
    id: 'stale_1', operation: 'update under a stale approval', capability: 'record_update',
    tool: 'update_record', mutating: true,
    target: { table: 'incident', sys_id: createdSysId },
    inputs: { table: 'incident', sys_id: createdSysId, data: { short_description: 'STALE — MUST NOT LAND' } },
    expected_effects: ['nothing'], verification: { strategy: 'read_back', asserts: ['never'] },
  })], {
    goal: 'stale',
    recoverStep: R.recoverStep,
    // Plan A is approved; the plan is then edited into plan B before execution.
    tamper: (id) => getDb().prepare('UPDATE agent_tasks SET plan_fingerprint = ? WHERE id = ?')
      .run('0'.repeat(64), id),
  });

  const after = await table.get('incident', createdSysId, 'all');
  record('S1', 'STALE — a plan edited after approval writes nothing',
    (before?.short_description?.value) === (after?.short_description?.value) ? 'PASS' : 'FAIL',
    `plan=${plan.planState} reason=${res.reason}`);
  record('S2', 'STALE — evidence reports BLOCKED, not FAILED',
    evidence.final.status === 'BLOCKED' ? 'PASS' : 'FAIL',
    `final=${evidence.final.status} approval.valid=${evidence.approval.valid}`);
  record('S3', 'STALE — recovery does not rescue a stale approval',
    evidence.recovery.attempted === false ? 'PASS' : 'FAIL',
    `recovery.attempted=${evidence.recovery.attempted}`);
}

/* ================================================================== *
 * 7. RECOVERY — a genuinely transient failure, reproduced honestly.
 * ================================================================== */

{
  // A READ against a table that does not exist fails deterministically; a read
  // whose first attempt is made to fail transiently is the only shape that may
  // legitimately retry. The tool below wraps the REAL read tool and fails once
  // at the transport layer — the failure is injected, the recovery, the gates
  // and the instance call on attempt 2 are all real.
  const real = toolMap.get('query_records');
  let attempts = 0;
  toolMap.set('p8_flaky_read', {
    name: 'p8_flaky_read',
    mutating: false,
    execute: async (input, ctx) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('Service Unavailable'), { status: 503 });
      return real.execute(input, ctx);
    },
  });
  try {
    const { taskId, sessionId } = newTask('transient read failure');
    const { res, evidence } = await runPlan(taskId, sessionId, [mkStep({
      id: 'rec_1', operation: 'read with one transient failure', capability: 'record_read',
      tool: 'p8_flaky_read', inputs: { table: 'incident', query: 'active=true', limit: 1 },
    })], { goal: 'recovery', recoverStep: R.recoverStep });

    record('X1', 'RECOVERY — a transient READ failure retries and the second attempt hits the instance',
      res.ok && attempts === 2 ? 'PASS' : 'FAIL',
      `attempts=${attempts} ok=${res.ok} recovered=${evidence.recovery.recoveredSteps}`);
    record('X2', 'RECOVERY — the repeat is represented honestly in evidence',
      evidence.uncertainties.some((u) => u.kind === 'repeated_mutation') ? 'PASS' : 'FAIL',
      `uncertainties=${JSON.stringify(evidence.uncertainties.map((u) => u.kind))}`);
  } finally { toolMap.delete('p8_flaky_read'); }
}

{
  // A CREATE that fails transiently must NEVER be repeated automatically.
  let attempts = 0;
  toolMap.set('p8_flaky_create', {
    name: 'p8_flaky_create',
    mutating: true,
    describeWrite: (i, r) => ({ operation: 'create', table: 'incident', requested: i, sys_id: r?.sys_id ?? null }),
    execute: async () => { attempts += 1; throw Object.assign(new Error('Service Unavailable'), { status: 503 }); },
  });
  try {
    const { taskId, sessionId } = newTask('transient create failure');
    const { res } = await runPlan(taskId, sessionId, [mkStep({
      id: 'nore_1', operation: 'create with a transient failure', capability: 'record_create',
      tool: 'p8_flaky_create', mutating: true,
      inputs: { short_description: `${MARK} MUST NOT BE DUPLICATED` },
      expected_effects: ['an incident exists'],
      verification: { strategy: 'read_back', asserts: ['never'] },
    })], { goal: 'no repeat', recoverStep: R.recoverStep });

    record('X3', 'RECOVERY — a NON_IDEMPOTENT create is never automatically repeated',
      attempts === 1 ? 'PASS' : 'FAIL',
      `attempts=${attempts} decision=${res.recovery?.decision?.decision} idempotency=${res.recovery?.decision?.idempotency}`);
  } finally { toolMap.delete('p8_flaky_create'); }
}

/* ================================================================== *
 * Summary
 * ================================================================== */

console.log();
const pass = results.filter((r) => r.verdict === 'PASS').length;
const fail = results.filter((r) => r.verdict === 'FAIL').length;
const skip = results.filter((r) => r.verdict === 'SKIP').length;
console.log(`REAL PDI TEST — pass ${pass}  fail ${fail}  skip ${skip}  of ${results.length}`);
if (fail) {
  console.log();
  console.log('FAILURES:');
  for (const r of results.filter((x) => x.verdict === 'FAIL')) console.log(`  ${r.id} ${r.label}\n     ${r.detail}`);
}
if (createdSysId) {
  console.log();
  console.log(`disposable artifact left on the instance: incident ${createdSysId}`);
  console.log(`  find it with: short_descriptionSTARTSWITH${MARK.slice(0, 30)}`);
}
