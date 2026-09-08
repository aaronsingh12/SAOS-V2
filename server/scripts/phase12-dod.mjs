/**
 * PHASE 12 — THE DEFINITION OF DONE, end to end, with nothing hand-written.
 *
 *   node scripts/phase12-dod.mjs
 *
 * Everything before this proved the mechanism with plans I wrote. This proves
 * the claim the specification actually makes:
 *
 *     a real MODEL-GENERATED multi-step plan reads a real ServiceNow record,
 *     carries its output into a subsequent mutation, executes through the
 *     existing approval pipeline, verifies, and produces correct evidence.
 *
 * The plan is not authored here. The model is given the goal and whatever it
 * returns is what runs — refusals included.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'p12-dod-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'dod.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const P = await import('../src/agent/plan/index.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { getDb } = await import('../src/memory/db.js');
const { getSettings } = await import('../src/config/store.js');
const { table } = await import('../src/servicenow/client.js');
const { toolMap } = await import('../src/agent/tools.js');

const results = [];
const ok = (id, label, cond, detail) => {
  results.push({ id, ok: Boolean(cond) });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${id.padEnd(4)} ${label}`);
  if (detail) console.log(`        ${detail}`);
};

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log();

/* ---- seed one disposable incident with a findable number ---- */
const MARK = `NOWFORGE PHASE 12 DOD ${new Date().toISOString()}`;
let sysId = null;
let number = null;
try {
  const created = await toolMap.get('create_incident').execute(
    { short_description: MARK, description: 'NowForge Phase 12 DoD proof. Safe to delete.' },
    { sessionId: 'p12-dod-seed', turnSeq: 0 },
  );
  sysId = created?.sys_id?.value ?? created?.sys_id ?? null;
  number = created?.number?.value ?? created?.number ?? null;
} catch (err) {
  console.log(`could not seed: ${err.message}`);
  process.exit(1);
}
console.log(`seeded   : ${number} (${sysId})`);
console.log();

/* ---- THE MODEL PLANS. Nothing below is hand-written. ---- */
const GOAL = `Set the short description of incident ${number} to "PHASE 12 DATAFLOW PROVEN".`;
console.log(`goal     : ${GOAL}`);
const generated = await P.generatePlan({ goal: GOAL });

ok('M1', 'The MODEL produced a plan the validator accepts', generated.ok,
  generated.ok ? '' : `${generated.reason}: ${(generated.fatal ?? []).map((p) => `${p.code}@${p.step}`).join(', ')}`);

if (!generated.ok) {
  console.log();
  console.log('REAL MODEL TEST — the model did not produce an executable plan; nothing further to prove.');
  console.log(`disposable artifact: incident ${sysId}`);
  process.exit(1);
}

const steps = generated.plan.steps;
console.log();
for (const s of steps) {
  console.log(`  ${s.id}  ${s.tool}  depends_on=${JSON.stringify(s.depends_on)}`);
  console.log(`      target: ${JSON.stringify(s.target)}`);
  console.log(`      inputs: ${JSON.stringify(s.inputs).slice(0, 150)}`);
}
console.log();

const refs = steps.flatMap((s) => P.findReferences(s).map((r) => ({ step: s.id, ...r })));
ok('M2', 'It is MULTI-STEP and carries a real reference between the steps',
  steps.length > 1 && refs.length > 0,
  refs.length
    ? refs.map((r) => `${r.step}.${r.path.join('.')} = ${r.raw}`).join(' ; ')
    : 'the model used no references');

/* ---- run it ---- */
const sid = 'p12-dod';
getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
  .run(sid, new Date().toISOString(), new Date().toISOString());
const t = createTask({ sessionId: sid, goal: GOAL });
startTask(t.id);

const saved = P.savePlan(t.id, generated.plan);
P.setPlanState(t.id, 'ready');
P.setPlanState(t.id, 'awaiting_approval');
P.approvePlan(t.id, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });

ok('M3', 'The stored plan keeps the REFERENCE, and the approval binds it',
  P.checkApprovalBinding(t.id).ok
    && JSON.stringify(P.loadPlan(t.id)).includes('$ref'),
  `fingerprint ${saved.fingerprint.slice(0, 12)}…`);

const cards = [];
const res = await P.executePlan({
  taskId: t.id,
  sessionId: sid,
  turnSeq: 1,
  emit: (e) => {
    if (e.type === 'approval_required') {
      cards.push(e);
      setImmediate(() => resolveApproval(sid, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce));
    }
  },
});

const evidence = buildEvidence(t.id);
const producerId = refs[0]?.raw?.split('.')[0] ?? null;
const produced = producerId ? P.stepOutputs(t.id, producerId) : null;

ok('M4', 'The producer captured its DECLARED output from the live instance',
  produced && Object.keys(produced).length > 0,
  `${producerId} produced ${JSON.stringify(produced)}`);

ok('M5', 'The approval card showed the reference beside the value it resolved to',
  cards.some((c) => Array.isArray(c.dataflow) && c.dataflow.length > 0),
  cards.map((c) => JSON.stringify(c.dataflow)).join(' ; ') || 'no card carried a dataflow');

const change = evidence.changes[0] ?? null;
ok('M6', 'The mutation ran against the REFERENCED record, read back, and verified',
  res.ok && change?.sys_id === sysId && change?.verification_status === 'applied',
  change
    ? `${change.table}/${String(change.sys_id).slice(0, 10)}… verify=${change.verification_status} `
      + `provenance=${change.approval?.source} final=${evidence.final.status}`
    : `${res.reason}: ${res.note}`);

const row = evidence.dataflow?.steps?.find((s) => (s.consumed ?? []).length > 0);
const c = row?.consumed?.[0];
ok('M7', 'Evidence distinguishes declared, resolved and consumer',
  Boolean(c) && typeof c.declared === 'string' && c.resolved === sysId,
  c ? `${c.consumer} ← ${c.declared} = ${String(c.resolved).slice(0, 12)}…` : 'no dataflow evidence');

try {
  const live = await table.get('incident', sysId, 'all');
  const got = live?.short_description?.value ?? live?.short_description;
  ok('M8', 'An INDEPENDENT read confirms the instance holds the new value',
    got === 'PHASE 12 DATAFLOW PROVEN', `instance reads: "${got}"`);
} catch (err) {
  ok('M8', 'An INDEPENDENT read confirms the instance holds the new value', false, err.message);
}

console.log();
const pass = results.filter((r) => r.ok).length;
console.log(`REAL MODEL + REAL PDI — pass ${pass}  fail ${results.length - pass}  of ${results.length}`);
console.log();
console.log(`disposable artifact: incident ${sysId} (${number})`);
