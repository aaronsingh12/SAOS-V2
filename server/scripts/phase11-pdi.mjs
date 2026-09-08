/**
 * PHASE 11 — REAL PDI TEST: the canonical contract, end to end.
 *
 *   node scripts/phase11-pdi.mjs
 *
 * The focused lifecycle §9 asks for, twice: once for a read, once for a real
 * gated mutation. At every stage the question is the same — are the arguments
 * that were fingerprinted and approved the arguments that ran, and does the
 * evidence show those same arguments afterwards?
 *
 * The plans are written the way the MODEL writes them, with the table in
 * `target`, because that is the shape this whole phase exists to make work.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-pdi-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'pdi.db'))));

const P = await import('../src/agent/plan/index.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { registerFromToolResult } = await import('../src/memory/provenance.js');
const { getSettings } = await import('../src/config/store.js');
const { table } = await import('../src/servicenow/client.js');
const { toolMap } = await import('../src/agent/tools.js');

const MARK = `NOWFORGE PHASE 11 ${new Date().toISOString()}`;
const results = [];
const ok = (id, label, cond, detail) => {
  results.push({ id, ok: Boolean(cond) });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${id.padEnd(4)} ${label}`);
  if (detail) console.log(`        ${detail}`);
};

let n = 0;
function newTask(goal) {
  const sid = `p11pdi-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const readOnlyDiscover = (name) => ({
  capability: name, status: 'known', available: true, mechanism: 'rest', mutating: false,
  verification: 'none', requiresVerification: false, requiresApproval: false,
  requiresElevation: false, elevationRole: null, scope: null, reason: null, note: null,
});

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log();

/* ---------- 1. A LEGITIMATE READ, written the way the model writes it ---------- */
{
  const { taskId, sessionId } = newTask('read incidents');
  // THE SHAPE THAT USED TO BE BROKEN: table in `target`, not in `inputs`.
  const proposed = {
    id: 'step_1', operation: 'query active incidents', capability: 'record_read',
    tool: 'query_records', mechanism: 'rest', scope: null, mutating: false,
    target: { table: 'incident' },
    inputs: { query: 'active=true', limit: 3 },
    depends_on: [], expected_effects: [], verification: null,
  };

  const v = P.validatePlan({ goal: 'read', steps: [proposed] }, { discover: readOnlyDiscover });
  ok('R1', 'VALIDATE — the model-shaped read plan is accepted', v.valid,
    v.valid ? '' : v.fatal.map((p) => p.code).join(', '));

  const canonical = P.canonicalExecutionArgs(proposed).args;
  ok('R2', 'CANONICAL — the target reaches the arguments', canonical.table === 'incident',
    `args = ${JSON.stringify(canonical)}`);

  const saved = P.savePlan(taskId, { goal: 'read', steps: [proposed] });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  ok('R3', 'FINGERPRINT — the stored plan is canonical and bound',
    P.isCanonical(P.loadPlan(taskId)) && P.checkApprovalBinding(taskId).ok,
    `fingerprint ${saved.fingerprint.slice(0, 12)}…`);

  const res = await P.executePlan({ taskId, sessionId, turnSeq: 1, emit: () => {} });
  const plan = P.loadPlan(taskId);
  ok('R4', 'EXECUTE — the read ran against the live instance', res.ok,
    res.ok ? '' : `${res.reason}: ${res.note}`);

  const ev = buildEvidence(taskId);
  ok('R5', 'EVIDENCE — reports the same arguments that were approved',
    JSON.stringify(ev.steps[0].inputs) === JSON.stringify(canonical),
    `evidence inputs = ${JSON.stringify(ev.steps[0].inputs)}`);
  ok('R6', 'ROUND TRIP — stored inputs equal the canonical arguments',
    JSON.stringify(plan.steps[0].inputs) === JSON.stringify(canonical));
}

/* ---------- 2. A LEGITIMATE GATED MUTATION ---------- */
{
  let sysId = null;
  try {
    const created = await toolMap.get('create_incident').execute(
      { short_description: MARK, description: 'NowForge Phase 11 canonical-contract check. Safe to delete.' },
      { sessionId: 'p11-seed', turnSeq: 0 },
    );
    sysId = created?.sys_id?.value ?? created?.sys_id ?? null;
  } catch (err) {
    console.log(`  (could not create the disposable incident: ${err.message})`);
  }

  if (sysId) {
    const { taskId, sessionId } = newTask('update the incident');
    registerFromToolResult({ sessionId, seq: 0, table: 'incident', result: { sys_id: sysId } });
    const NEW = `${MARK} (updated)`;
    const proposed = {
      id: 'step_1', operation: 'update the validation incident', capability: 'record_update',
      tool: 'update_record', mechanism: 'rest', scope: null, mutating: true,
      target: { table: 'incident', sys_id: sysId },      // the model's shape
      inputs: { data: { short_description: NEW } },       // table and sys_id absent here
      depends_on: [], expected_effects: ['short_description carries the marker'],
      verification: { strategy: 'read_back', asserts: [`short_description == ${NEW}`] },
    };

    const canonical = P.canonicalExecutionArgs(proposed).args;
    ok('M1', 'CANONICAL — a mutating step gets both table and sys_id',
      canonical.table === 'incident' && canonical.sys_id === sysId,
      `args = ${JSON.stringify(canonical).slice(0, 120)}`);

    const saved = P.savePlan(taskId, { goal: 'update', steps: [proposed] });
    P.setPlanState(taskId, 'ready');
    P.setPlanState(taskId, 'awaiting_approval');
    P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });

    let card = null;
    const res = await P.executePlan({
      taskId, sessionId, turnSeq: 1,
      emit: (e) => {
        if (e.type === 'approval_required') {
          card = e;
          setImmediate(() => resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce));
        }
      },
    });

    ok('M2', 'APPROVAL — the card showed the canonical arguments',
      Boolean(card) && JSON.stringify(card.input) === JSON.stringify(canonical),
      `card input = ${JSON.stringify(card?.input).slice(0, 120)}`);
    ok('M3', 'EXECUTE + VERIFY — the write landed and read back', res.ok,
      res.ok ? '' : `${res.reason}: ${res.note}`);

    const ev = buildEvidence(taskId);
    const change = ev.changes[0] ?? null;
    ok('M4', 'EVIDENCE — the change names the approved target',
      Boolean(change) && change.table === 'incident' && change.sys_id === sysId
        && change.verification_status === 'applied',
      change
        ? `${change.table}/${String(change.sys_id).slice(0, 10)}… verify=${change.verification_status} `
          + `provenance=${change.approval?.source} final=${ev.final.status}`
        : 'no change recorded');

    try {
      const live = await table.get('incident', sysId, 'all');
      const got = live?.short_description?.value ?? live?.short_description;
      ok('M5', 'INDEPENDENT — the instance really holds the approved value', got === NEW,
        `instance reads: ${String(got).slice(-42)}`);
    } catch (err) {
      ok('M5', 'INDEPENDENT — the instance really holds the approved value', false, err.message);
    }

    console.log();
    console.log(`disposable artifact: incident ${sysId}`);
    console.log(`  find it with: short_descriptionSTARTSWITH${MARK.slice(0, 26)}`);
  }
}

console.log();
const pass = results.filter((r) => r.ok).length;
console.log(`REAL PDI TEST — pass ${pass}  fail ${results.length - pass}  of ${results.length}`);
