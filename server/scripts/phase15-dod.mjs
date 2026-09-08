/**
 * PHASE 15 — THE DEFINITION OF DONE, real model against a real PDI.
 *
 *   node scripts/phase15-dod.mjs
 *
 * §48's strongest scenario, run once, end to end:
 *
 *     "Why wasn't INC……… assigned?"
 *
 *       incident -> assignment state -> audit/history -> automation execution
 *       -> timeline -> diagnosis
 *
 * §48 says both endings are valid depending on what the instance actually
 * holds: ROOT_CAUSE_ESTABLISHED if the evidence proves an automation failure,
 * INSUFFICIENT_EVIDENCE if it does not. What this script checks is not which
 * one came back, but that whichever came back is the one the evidence supports.
 *
 * The §62 answer is printed at the end, because the milestone is a product
 * capability and the only way to judge one is to read what a person is shown.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p15dod-')), 'd.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const P = await import('../src/agent/plan/index.js');
const D = await import('../src/agent/doctor/index.js');
const { recordDiagnosis, loadDiagnosis } = await import('../src/agent/plan/store.js');
const { buildEvidence } = await import('../src/agent/evidence/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { getDb } = await import('../src/memory/db.js');
const { getSettings } = await import('../src/config/store.js');
const { table } = await import('../src/servicenow/client.js');
const { toolMap } = await import('../src/agent/tools.js');
const { chatOnce } = await import('../src/agent/providers/index.js');
const { codegenDecoding } = await import('../src/agent/decoding.js');
const { recoverStep } = await import('../src/agent/recovery/index.js');
const { renderDiagnosis } = await import('../src/agent/doctor/render.js');

const results = [];
const ok = (id, label, cond, detail) => {
  results.push({ id, ok: Boolean(cond) });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${id.padEnd(4)} ${label}`);
  if (detail) console.log(`        ${detail}`);
};

const created = [];
let diagnosis = null;

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log();

const t0 = process.hrtime.bigint();

try {
  /* One disposable incident, edited so there is a real history to find. */
  const c = await toolMap.get('create_record').execute(
    { table: 'incident', data: { short_description: 'NOWFORGE P15 DOD — safe to delete' } },
    { sessionId: 'p15-dod', turnSeq: 0 },
  );
  const sysId = c?.sys_id?.value ?? c?.sys_id;
  const number = c?.number?.value ?? c?.number;
  created.push({ sys_id: sysId, number });
  console.log(`seeded   : ${number}`);

  await table.update('incident', sysId, { urgency: '1' });
  await new Promise((r) => { setTimeout(r, 2000); });
  await table.update('incident', sysId, { work_notes: 'NOWFORGE P15 escalating for review' });
  await new Promise((r) => { setTimeout(r, 4000); });

  const before = await table.get('incident', sysId, 'all');
  const ask = `Why wasn't ${number} assigned?`;
  console.log(`goal     : ${ask}`);
  console.log();

  const sid = 'p15-dod';
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal: ask });
  startTask(t.id);

  diagnosis = await D.diagnose({
    request: ask, taskId: t.id, sessionId: sid,
    generate: P.generatePlan, chat: chatOnce,
    run: (opts) => P.executePlan({ ...opts, recoverStep }),
    plan: {
      save: P.savePlan, load: P.loadPlan, setState: P.setPlanState,
      review: P.buildReview, violations: P.mutatingSteps,
    },
    record: recordDiagnosis, decoding: codegenDecoding(),
  });

  const plan = P.loadPlan(t.id);
  const steps = plan?.steps ?? [];
  const completed = steps.filter((s) => s.state === 'completed');

  ok('1', 'The MODEL generated an executable, read-only investigation',
    steps.length > 0 && !diagnosis.stopped && P.mutatingSteps(plan).length === 0,
    `${steps.length} step(s), ${P.mutatingSteps(plan).length} mutating: ${steps.map((s) => s.tool).join(' -> ').slice(0, 150)}`);

  ok('2', 'It reached the CAUSAL surfaces, not just the record',
    completed.some((s) => D.CAUSAL_SURFACES.includes(s.tool)),
    `completed: ${completed.map((s) => s.tool).join(', ')}`);

  ok('3', 'It read the assignment state and the history behind it',
    diagnosis.facts.some((f) => f.field === 'assigned_to')
      && diagnosis.facts.some((f) => String(f.field).startsWith('changed_')),
    `${diagnosis.facts.length} facts, ${diagnosis.facts.filter((f) => f.causal).length} of them events`);

  ok('4', 'It found the automation evidence, whatever that evidence says',
    diagnosis.facts.some((f) => String(f.field).startsWith('flow_execution')),
    diagnosis.facts.filter((f) => String(f.field).startsWith('flow_execution'))
      .map((f) => `${f.field}=${JSON.stringify(String(f.value).slice(0, 44))}`).join(' | ') || 'none');

  const events = diagnosis.timeline?.events ?? [];
  const timed = events.filter((e) => e.epoch !== null);
  ok('5', 'It built an ordered timeline in which every entry cites a fact',
    events.length > 0 && events.every((e) => e.fact_id)
      && timed.every((e, i) => i === 0 || timed[i - 1].epoch <= e.epoch),
    `${events.length} events, ${JSON.stringify(diagnosis.timeline?.span)}`);

  /* §48's central check: the verdict must match the evidence, either way. */
  const relevantFailure = diagnosis.facts.some(
    (f) => f.field === 'flow_execution_error' && /assign/i.test(String(f.value)));
  const claimedRootCause = diagnosis.outcome === D.OUTCOMES.ROOT_CAUSE_ESTABLISHED;
  ok('6', 'The verdict matches what the evidence actually supports',
    !claimedRootCause || relevantFailure,
    claimedRootCause
      ? 'a root cause was established, and a relevant automation failure was present'
      : `${diagnosis.outcome} — no automation failure relevant to assignment was found, so no root cause was claimed`);

  ok('7', 'Fact and inference stay distinguishable, with nothing invented',
    diagnosis.facts.every((f) => f.type === 'FACT' && f.source?.step && f.source?.tool)
      && diagnosis.inferences.every((i) => i.supporting_facts.every(
        (id) => diagnosis.facts.some((f) => f.id === id))),
    `${diagnosis.invented_citations.length} invented citation(s), `
    + `${diagnosis.hypotheses.filter((h) => (h.unsupported_blame?.length ?? 0) > 0).length} unevidenced blame(s) caught`);

  ok('8', 'What could not be established is stated rather than filled in',
    diagnosis.unknowns.length > 0,
    diagnosis.unknowns.slice(0, 2).map((u) => u.statement.slice(0, 80)).join(' | '));

  const after = await table.get('incident', sysId, 'all');
  ok('9', 'THE INVESTIGATION MUTATED NOTHING',
    (before?.sys_updated_on?.value ?? null) === (after?.sys_updated_on?.value ?? null),
    `sys_updated_on before=${before?.sys_updated_on?.value} after=${after?.sys_updated_on?.value}`);

  const evidence = buildEvidence(t.id);
  ok('10', 'The whole chain is durable and reconstructable from the database alone',
    Boolean(evidence?.diagnosis?.timeline?.events?.length)
      && evidence.diagnosis.facts.length === diagnosis.facts.length
      && Boolean(loadDiagnosis(t.id)),
    `evidence.diagnosis: ${evidence?.diagnosis?.facts?.length} facts, `
    + `${evidence?.diagnosis?.timeline?.events?.length} timeline events, `
    + `${evidence?.diagnosis?.hypotheses?.length} hypotheses`);

  ok('11', 'No secret reached the evidence',
    !/password=|api_key=|Bearer [A-Za-z0-9]/.test(JSON.stringify(evidence.diagnosis)),
    'checked the whole diagnosis section');
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

if (diagnosis) {
  console.log();
  console.log('='.repeat(72));
  console.log('THE ANSWER A PERSON SEES');
  console.log('='.repeat(72));
  console.log(renderDiagnosis(diagnosis));
}

console.log();
console.log(`total: ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)}s`);
const pass = results.filter((r) => r.ok).length;
console.log(`REAL MODEL + REAL PDI — pass ${pass}  fail ${results.length - pass}  of ${results.length}`);
