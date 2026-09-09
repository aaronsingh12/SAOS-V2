/**
 * PHASE 14 — THE DEFINITION OF DONE, real model against a real PDI.
 *
 *   node scripts/phase14-dod.mjs
 *
 * §39's strongest required scenario, run once, end to end, with nothing
 * hand-authored:
 *
 *     "Why is INC00…… not assigned?"
 *
 *       generate an investigation -> execute reads -> collect evidence
 *       -> identify the assigned_to state -> separate fact from inference
 *       -> produce a diagnosis -> recommend -> MUTATE NOTHING
 *
 * and then, as a SEPARATE request, the remediation:
 *
 *       approval -> mutation -> read-back -> VERIFIED
 *
 * The §46 answer is printed at the end, because the milestone is a product
 * capability rather than a passing pipeline, and the only way to judge that is
 * to read what a person would actually be shown.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p14dod-')), 'd.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const P = await import('../src/agent/plan/index.js');
const D = await import('../src/agent/doctor/index.js');
const { recordDiagnosis } = await import('../src/agent/plan/store.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { getDb } = await import('../src/memory/db.js');
const { getSettings } = await import('../src/config/store.js');
const { table } = await import('../src/servicenow/client.js');
const { toolMap } = await import('../src/agent/tools.js');
const { chatOnce } = await import('../src/agent/providers/index.js');
const { codegenDecoding } = await import('../src/agent/decoding.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { recoverStep } = await import('../src/agent/recovery/index.js');
const { renderDiagnosis } = await import('../src/agent/doctor/render.js');

const results = [];
const ok = (id, label, cond, detail) => {
  results.push({ id, ok: Boolean(cond) });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${id.padEnd(4)} ${label}`);
  if (detail) console.log(`        ${detail}`);
};

const created = [];
let n = 0;
function newTask(goal) {
  const sid = `p14dod-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

const planApi = {
  save: P.savePlan, load: P.loadPlan, setState: P.setPlanState,
  review: P.buildReview, violations: P.mutatingSteps,
};

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log();

let diagnosis = null;
let evidence = null;

try {
  /* ---- one disposable, genuinely unassigned incident ---- */
  const c = await toolMap.get('create_record').execute(
    { table: 'incident', data: { short_description: 'NOWFORGE P14 DOD — safe to delete' } },
    { sessionId: 'p14-dod', turnSeq: 0 },
  );
  const sysId = c?.sys_id?.value ?? c?.sys_id;
  const number = c?.number?.value ?? c?.number;
  created.push({ sys_id: sysId, number });
  console.log(`seeded   : ${number} (${sysId})`);

  const before = await table.get('incident', sysId, 'all');

  /* ============================================================== *
   * PART 1 — DIAGNOSE. Nothing may change.
   * ============================================================== */
  const ask = `Why is ${number} not assigned?`;
  console.log(`goal     : ${ask}`);
  console.log();

  const { taskId, sessionId } = newTask(ask);
  diagnosis = await D.diagnose({
    request: ask, taskId, sessionId,
    generate: P.generatePlan,
    chat: chatOnce,
    run: (opts) => P.executePlan({ ...opts, recoverStep }),
    plan: planApi, record: recordDiagnosis, decoding: codegenDecoding(),
  });

  const plan = P.loadPlan(taskId);
  const steps = plan?.steps ?? [];

  ok('1', 'The MODEL generated an executable investigation',
    steps.length > 0 && !diagnosis.stopped,
    `${steps.length} step(s): ${steps.map((s) => s.tool).join(' -> ')}`);

  ok('2', 'Every step of it is READ-ONLY',
    P.mutatingSteps(plan).length === 0,
    `${P.mutatingSteps(plan).length} mutating step(s)`);

  ok('3', 'The reads executed against the live instance',
    steps.filter((s) => s.state === 'completed').length > 0,
    `${steps.filter((s) => s.state === 'completed').length}/${steps.length} completed`);

  const assignedFact = diagnosis.facts.find((f) => f.field === 'assigned_to');
  ok('4', 'It identified the assigned_to state as a provenanced FACT',
    Boolean(assignedFact) && assignedFact.source.step && assignedFact.source.tool,
    assignedFact ? `"${assignedFact.statement}" [${assignedFact.source.tool} @ ${assignedFact.source.step}]`
      : `no assigned_to fact among ${diagnosis.facts.length}`);

  ok('5', 'Fact and inference are distinguishable, and every inference cites real facts',
    diagnosis.facts.every((f) => f.type === 'FACT')
      && diagnosis.inferences.every((i) => i.type === 'INFERENCE')
      && diagnosis.inferences.every((i) => i.supporting_facts.every(
        (id) => diagnosis.facts.some((f) => f.id === id))),
    `${diagnosis.facts.length} facts, ${diagnosis.inferences.length} inferences, `
    + `${diagnosis.invented_citations.length} invented citation(s)`);

  ok('6', 'It produced a diagnosis whose label the evidence rule chose',
    Boolean(diagnosis.conclusion) && Boolean(diagnosis.cause_label)
      && (diagnosis.conclusion.root_cause === (diagnosis.outcome === D.OUTCOMES.ROOT_CAUSE_ESTABLISHED)),
    `${diagnosis.outcome} / ${diagnosis.cause_label}`);

  ok('7', 'It produced a recommendation, and no recommendation acted by itself',
    diagnosis.recommendations.length > 0
      && diagnosis.recommendations.every((r) => !r.mutation || r.requires_approval),
    diagnosis.recommendations.map((r) => `${r.mutation ? 'MUTATION' : 'read'}: ${r.statement}`).join(' | ').slice(0, 150));

  const after = await table.get('incident', sysId, 'all');
  ok('8', 'DIAGNOSIS MUTATED NOTHING',
    (before?.sys_updated_on?.value ?? null) === (after?.sys_updated_on?.value ?? null),
    `sys_updated_on before=${before?.sys_updated_on?.value} after=${after?.sys_updated_on?.value}`);

  evidence = buildEvidence(taskId);
  ok('9', 'The evidence carries the diagnosis, durably',
    Boolean(evidence?.diagnosis?.facts?.length) && evidence.diagnosis.outcome === diagnosis.outcome,
    `evidence.diagnosis: ${evidence?.diagnosis?.facts?.length} facts, ${evidence?.diagnosis?.hypotheses?.length} hypotheses`);

  /* ============================================================== *
   * PART 2 — REMEDIATE, as a separate, approved request.
   * ============================================================== */
  console.log();
  const abel = await toolMap.get('lookup_reference').execute(
    { table: 'sys_user', search: 'Abel Tuter' }, { sessionId: 'p14-dod', turnSeq: 0 });
  const ABEL = abel?.resolved?.sys_id ?? null;

  const rec = {
    statement: 'Assign the incident to Abel Tuter.',
    mutation: true, requires_approval: true,
    reason: ['The incident has no individual assignee.'],
  };
  const goal = D.remediationGoal(rec, { subject: { type: 'incident', identifier: number }, conclusion: diagnosis.conclusion });
  console.log(`remediation goal: ${goal.slice(0, 120)}…`);

  const generated = await P.generatePlan({ goal });
  ok('10', 'The recommendation became a plan the validator accepts', generated.ok,
    generated.ok ? '' : `${generated.reason}: ${(generated.fatal ?? []).map((p) => p.code).join(', ')}`);

  if (generated.ok) {
    const t2 = newTask(goal);
    const saved = P.savePlan(t2.taskId, generated.plan);
    P.setPlanState(t2.taskId, 'ready');
    P.setPlanState(t2.taskId, 'awaiting_approval');
    P.approvePlan(t2.taskId, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });

    const cards = [];
    const res = await P.executePlan({
      taskId: t2.taskId, sessionId: t2.sessionId, turnSeq: 1,
      emit: (e) => {
        if (e.type !== 'approval_required') return;
        cards.push(e);
        setImmediate(() => resolveApproval(t2.sessionId, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      },
    });

    ok('11', 'A human approval gated the mutation',
      cards.length > 0,
      `${cards.length} approval card(s); provenance ${cards[0]?.approvalId ? 'user_click' : 'none'}`);

    const ev2 = buildEvidence(t2.taskId);
    ok('12', 'It executed, read back, and is VERIFIED by evidence rather than by a return code',
      res.ok && ev2.final.status === 'VERIFIED' && ev2.changes[0]?.verification_status === 'applied',
      `final=${ev2.final.status} verify=${ev2.changes[0]?.verification_status} — ${ev2.final.reason}`);

    const live = await table.get('incident', sysId, 'all');
    ok('13', 'An INDEPENDENT read confirms the instance holds the change',
      live?.assigned_to?.value === ABEL,
      `assigned_to = ${JSON.stringify(live?.assigned_to)}`);
  }
} catch (err) {
  console.log();
  console.log(`ABORTED: ${err.message}`);
  console.log(err.stack);
} finally {
  console.log();
  const failed = [];
  for (const rec of created) {
    if (!rec.sys_id) continue;
    try { await table.remove('incident', rec.sys_id); console.log(`cleaned up: incident/${rec.sys_id} (${rec.number})`); }
    catch (err) { failed.push(`incident/${rec.sys_id} — ${err.message}`); }
  }
  if (failed.length) {
    console.log();
    console.log('CLEANUP FAILED — still on the instance:');
    for (const f of failed) console.log(`  ${f}`);
  }
}

/* ---- §46: what a person is actually shown ---- */
if (diagnosis) {
  console.log();
  console.log('='.repeat(72));
  console.log('THE ANSWER A PERSON SEES');
  console.log('='.repeat(72));
  console.log(renderDiagnosis(diagnosis));
}

console.log();
const pass = results.filter((r) => r.ok).length;
console.log(`REAL MODEL + REAL PDI — pass ${pass}  fail ${results.length - pass}  of ${results.length}`);
