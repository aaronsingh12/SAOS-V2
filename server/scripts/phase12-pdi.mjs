/**
 * PHASE 12 — REAL PDI TEST: dataflow, end to end, against the live instance.
 *
 *   node scripts/phase12-pdi.mjs
 *
 * The scenario §18 requires, and the Definition of Done's canonical proof:
 *
 *     read a real incident -> its sys_id via a DECLARED output
 *       -> that value as step 2's target -> modify a safe field
 *       -> read back -> verify -> evidence shows declared AND resolved
 *
 * Plus the negative: a reference to an output the producer does not declare
 * must be refused before anything is written.
 *
 * The field modified is `short_description` on an incident this script created
 * itself. Nothing pre-existing is touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'p12-pdi-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'pdi.db'))));

const P = await import('../src/agent/plan/index.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { getSettings } = await import('../src/config/store.js');
const { table } = await import('../src/servicenow/client.js');
const { toolMap } = await import('../src/agent/tools.js');

const MARK = `NOWFORGE PHASE 12 ${new Date().toISOString()}`;
const results = [];
const ok = (id, label, cond, detail) => {
  results.push({ id, ok: Boolean(cond) });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${id.padEnd(4)} ${label}`);
  if (detail) console.log(`        ${detail}`);
};

let n = 0;
function newTask(goal) {
  const sid = `p12pdi-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const discover = (name) => ({
  capability: name, status: 'known', available: true, mechanism: 'rest',
  mutating: name !== 'record_read', verification: name === 'record_read' ? 'none' : 'read_back',
  requiresVerification: name !== 'record_read', requiresApproval: name !== 'record_read',
  requiresElevation: false, elevationRole: null, scope: null, reason: null, note: null,
});

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`marker   : ${MARK}`);
console.log();

/* ---- seed a disposable incident to act on ---- */
let sysId = null;
try {
  const created = await toolMap.get('create_incident').execute(
    { short_description: MARK, description: 'NowForge Phase 12 dataflow check. Safe to delete.' },
    { sessionId: 'p12-seed', turnSeq: 0 },
  );
  sysId = created?.sys_id?.value ?? created?.sys_id ?? null;
} catch (err) {
  console.log(`  (could not create the disposable incident: ${err.message})`);
}
if (!sysId) {
  console.log('REAL PDI TEST — could not seed; aborting');
  process.exit(1);
}
console.log(`seeded   : incident ${sysId}`);
console.log();

const NEW = `${MARK} (updated via dataflow)`;

/* ================================================================== *
 * THE POSITIVE CASE
 * ================================================================== */
{
  const { taskId, sessionId } = newTask('read an incident, then update the record it found');

  /*
   * NOTE WHAT IS *NOT* HERE. The plan never names a sys_id for the update. It
   * names a REFERENCE to the read's declared output — so the only way the write
   * can reach a record is if the read actually found one.
   */
  const steps = [
    {
      id: 'step_1', operation: 'find the validation incident', capability: 'record_read',
      tool: 'query_records', mechanism: 'rest', scope: null, mutating: false,
      target: { table: 'incident' },
      inputs: { table: 'incident', query: `sys_id=${sysId}`, limit: 1 },
      depends_on: [], expected_effects: [], verification: null,
    },
    {
      id: 'step_2', operation: 'update the record step_1 found', capability: 'record_update',
      tool: 'update_record', mechanism: 'rest', scope: null, mutating: true,
      target: { table: 'incident', sys_id: { $ref: 'step_1.result.sys_id' } },
      inputs: { table: 'incident', data: { short_description: NEW } },
      depends_on: ['step_1'],
      expected_effects: ['short_description carries the dataflow marker'],
      verification: { strategy: 'read_back', asserts: [`short_description == ${NEW}`] },
    },
  ];

  // 2/3. validate — grammar, graph, dependency and type, all before approval
  const v = P.validatePlan({ goal: 'update via reference', steps }, { discover });
  ok('D1', 'VALIDATE — a plan carrying a $ref is accepted', v.valid,
    v.valid ? '' : v.fatal.map((p) => `${p.code}@${p.step}`).join(', '));

  // 4/5. fingerprint + approve
  const saved = P.savePlan(taskId, { goal: 'update via reference', steps });
  P.setPlanState(taskId, 'ready');
  P.setPlanState(taskId, 'awaiting_approval');
  P.approvePlan(taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });
  ok('D2', 'FINGERPRINT — the reference is bound and the plan is stored',
    P.checkApprovalBinding(taskId).ok
      && JSON.stringify(P.loadPlan(taskId).steps[1].inputs.sys_id) === JSON.stringify({ $ref: 'step_1.result.sys_id' }),
    `fingerprint ${saved.fingerprint.slice(0, 12)}… ; stored sys_id = `
    + `${JSON.stringify(P.loadPlan(taskId).steps[1].inputs.sys_id)}`);

  // 6. execute
  const cards = [];
  const res = await P.executePlan({
    taskId, sessionId, turnSeq: 1,
    emit: (e) => {
      if (e.type === 'approval_required') {
        cards.push(e);
        setImmediate(() => resolveApproval(sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    },
  });

  const produced = P.stepOutputs(taskId, 'step_1');
  ok('D3', 'PRODUCE — the read captured its DECLARED output from a live row',
    produced?.sys_id === sysId,
    `step_1 produced ${JSON.stringify(produced)}`);

  ok('D4', 'APPROVE — the card showed the reference beside the value it resolved to',
    cards.length === 1 && cards[0].dataflow?.[0]?.declared === 'step_1.result.sys_id'
      && cards[0].dataflow?.[0]?.resolved === sysId,
    cards.length ? `card dataflow = ${JSON.stringify(cards[0].dataflow)}` : 'no card was raised');

  // 7. verify
  const evidence = buildEvidence(taskId);
  const change = evidence.changes[0] ?? null;
  ok('D5', 'EXECUTE + VERIFY — the write landed on the referenced record and read back',
    res.ok && change?.sys_id === sysId && change?.verification_status === 'applied',
    change
      ? `${change.table}/${String(change.sys_id).slice(0, 10)}… verify=${change.verification_status} `
        + `provenance=${change.approval?.source} final=${evidence.final.status}`
      : `${res.reason}: ${res.note}`);

  // 8/9. evidence shows declared AND resolved, distinguishably
  const row = evidence.dataflow?.steps?.find((s) => s.step === 'step_2');
  const c = row?.consumed?.[0];
  ok('D6', 'EVIDENCE — declared reference, resolved value and consumer are all distinct',
    Boolean(c) && c.declared === 'step_1.result.sys_id' && c.resolved === sysId
      && /sys_id$/.test(c.consumer) && c.producer === 'step_1',
    c ? `${c.consumer} ← ${c.declared} = ${String(c.resolved).slice(0, 12)}…` : 'no dataflow evidence');

  // An independent read, outside the harness.
  try {
    const live = await table.get('incident', sysId, 'all');
    const got = live?.short_description?.value ?? live?.short_description;
    ok('D7', 'INDEPENDENT — the instance holds the value written to the REFERENCED record',
      got === NEW, `instance reads: ${String(got).slice(-46)}`);
  } catch (err) {
    ok('D7', 'INDEPENDENT — the instance holds the value written to the REFERENCED record', false, err.message);
  }
}

/* ================================================================== *
 * THE NEGATIVE CASE — refused before anything is written
 * ================================================================== */
{
  const before = await table.get('incident', sysId, 'all').catch(() => null);
  const beforeDesc = before?.short_description?.value ?? null;

  const steps = [
    {
      id: 'step_1', operation: 'find it', capability: 'record_read',
      tool: 'query_records', mechanism: 'rest', scope: null, mutating: false,
      target: { table: 'incident' },
      inputs: { table: 'incident', query: `sys_id=${sysId}`, limit: 1 },
      depends_on: [], expected_effects: [], verification: null,
    },
    {
      id: 'step_2', operation: 'update using an output that does not exist',
      capability: 'record_update', tool: 'update_record', mechanism: 'rest', scope: null, mutating: true,
      // `query_records` declares only `sys_id`. `number` is not one of its outputs.
      target: { table: 'incident', sys_id: { $ref: 'step_1.result.number' } },
      inputs: { table: 'incident', data: { short_description: 'MUST NEVER LAND' } },
      depends_on: ['step_1'], expected_effects: ['nothing'],
      verification: { strategy: 'read_back', asserts: ['never'] },
    },
  ];

  const v = P.validatePlan({ goal: 'bad reference', steps }, { discover });
  ok('N1', 'NEGATIVE — a reference to an undeclared output is refused at validation',
    !v.valid && v.fatal.some((p) => p.code === 'reference_unknown_output'),
    v.fatal.map((p) => `${p.code}@${p.step}`).join(', ') || 'the plan was ACCEPTED');

  const after = await table.get('incident', sysId, 'all').catch(() => null);
  const afterDesc = after?.short_description?.value ?? null;
  ok('N2', 'NEGATIVE — nothing was written to the instance',
    beforeDesc === afterDesc,
    `before="${String(beforeDesc).slice(-30)}" after="${String(afterDesc).slice(-30)}"`);
}

console.log();
const pass = results.filter((r) => r.ok).length;
console.log(`REAL PDI TEST — pass ${pass}  fail ${results.length - pass}  of ${results.length}`);
console.log();
console.log(`disposable artifact: incident ${sysId}`);
console.log(`  find it with: short_descriptionSTARTSWITH${MARK.slice(0, 26)}`);
