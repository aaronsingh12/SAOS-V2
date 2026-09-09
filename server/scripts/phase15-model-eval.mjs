/**
 * PHASE 15 — MODEL EVALUATION of causal diagnosis.
 *
 *   node scripts/phase15-model-eval.mjs [runsPerCategory]
 *
 * §46's ten categories against the real model and the real instance. Nothing is
 * hand-planned; each is a sentence somebody could type, and whatever comes back
 * is measured.
 *
 * §47's release targets, and the distinction that matters most:
 *
 *   unsupported CAUSAL claims   a root cause the evidence rule did not produce,
 *                               or a blame the cited evidence does not carry
 *   unsupported FACT claims     a citation naming a fact that does not exist,
 *                               still present in the OUTPUT
 *
 * Both must be zero. What the model ATTEMPTS is counted separately and is not a
 * blocker — attempts are caught, and an attempt that was caught is the system
 * working rather than failing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p15ev-')), 'e.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const P = await import('../src/agent/plan/index.js');
const D = await import('../src/agent/doctor/index.js');
const { recordDiagnosis } = await import('../src/agent/plan/store.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { getDb } = await import('../src/memory/db.js');
const { getSettings } = await import('../src/config/store.js');
const { table } = await import('../src/servicenow/client.js');
const { toolMap } = await import('../src/agent/tools.js');
const { chatOnce } = await import('../src/agent/providers/index.js');
const { codegenDecoding } = await import('../src/agent/decoding.js');
const { recoverStep } = await import('../src/agent/recovery/index.js');

const RUNS = Number(process.argv[2] || 2);
const created = [];
let n = 0;

const planApi = {
  save: P.savePlan, load: P.loadPlan, setState: P.setPlanState,
  review: P.buildReview, violations: P.mutatingSteps,
};

function newTask(goal) {
  const sid = `p15ev-${++n}`;
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal });
  startTask(t.id);
  return { taskId: t.id, sessionId: sid };
}

async function runDoctor(request) {
  const started = process.hrtime.bigint();
  const { taskId, sessionId } = newTask(request);
  const diagnosis = await D.diagnose({
    request, taskId, sessionId,
    generate: P.generatePlan, chat: chatOnce,
    run: (opts) => P.executePlan({ ...opts, recoverStep }),
    plan: planApi, record: recordDiagnosis, decoding: codegenDecoding(),
  });
  return { diagnosis, taskId, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

const seed = async (label, fields = {}) => {
  const c = await toolMap.get('create_record').execute(
    { table: 'incident', data: { short_description: `NOWFORGE P15 EVAL ${label} — safe to delete`, ...fields } },
    { sessionId: 'p15-eval', turnSeq: 0 },
  );
  const sysId = c?.sys_id?.value ?? c?.sys_id;
  const number = c?.number?.value ?? c?.number;
  created.push({ sys_id: sysId, number });
  return { sysId, number };
};

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log(`runs     : ${RUNS} per category`);
console.log();

const rows = [];

try {
  const abel = await toolMap.get('lookup_reference').execute(
    { table: 'sys_user', search: 'Abel Tuter' }, { sessionId: 'p15-eval', turnSeq: 0 });
  const ABEL = abel?.resolved?.sys_id ?? null;

  const unassigned = await seed('unassigned');
  const healthy = await seed('healthy', { assigned_to: ABEL });
  /* Give the platform a moment to attach SLAs and run their flow. */
  await new Promise((r) => { setTimeout(r, 4000); });
  await table.update('incident', unassigned.sysId, { urgency: '1', work_notes: 'NOWFORGE P15 eval note' });
  await new Promise((r) => { setTimeout(r, 3000); });

  const CATEGORIES = [
    { id: 'A', name: 'why is it unassigned', ask: `Why is ${unassigned.number} not assigned?` },
    { id: 'B', name: 'why is it stuck', ask: `Why is ${unassigned.number} stuck?` },
    { id: 'C', name: 'why did automation fail', ask: `Did any automation fail for ${unassigned.number}?`,
      mustNotEstablishUnless: /assign/i },
    { id: 'D', name: 'why did a field change', ask: `Why did the priority on ${unassigned.number} change?` },
    { id: 'E', name: 'why is the SLA breached', ask: `Is the SLA on ${unassigned.number} breached, and why?` },
    { id: 'F', name: 'what changed', ask: `What changed on ${unassigned.number}?` },
    { id: 'G', name: 'is workflow responsible', ask: `Is a workflow responsible for the state of ${unassigned.number}?`,
      mustNotEstablishUnless: /assign/i },
    { id: 'H', name: 'what caused the current state', ask: `What caused the current state of ${unassigned.number}?` },
    { id: 'I', name: 'healthy incident', ask: `Why is ${healthy.number} not assigned?` },
    { id: 'J', name: 'insufficient evidence', ask: `Which business rule modified ${unassigned.number}?` },
  ];

  for (const cat of CATEGORIES) {
    for (let run = 1; run <= RUNS; run += 1) {
      const label = `${cat.id}${RUNS > 1 ? `.${run}` : ''}`;
      const before = await table.get('incident', unassigned.sysId, 'all');

      let diagnosis; let taskId; let ms;
      try {
        ({ diagnosis, taskId, ms } = await runDoctor(cat.ask));
      } catch (err) {
        rows.push({ ...cat, label, ok: false, why: `threw: ${err.message}` });
        console.log(`[FAIL] ${label} ${cat.name.padEnd(28)} threw: ${err.message}`);
        continue;
      }

      const plan = P.loadPlan(taskId);
      const steps = plan?.steps ?? [];
      const completed = steps.filter((s) => s.state === 'completed').length;
      const executable = steps.length > 0 && !diagnosis.stopped;
      const refs = steps.flatMap((s) => P.findReferences(s));
      const usedDiagnostic = steps.some((s) => D.CAUSAL_SURFACES.includes(s.tool));

      /* ---- §47 measurements, all mechanical ---- */
      const inventedAttempted = diagnosis.invented_citations?.length ?? 0;
      const inventedSurviving = (diagnosis.inferences ?? []).flatMap((i) => i.supporting_facts)
        .filter((id) => !(diagnosis.facts ?? []).some((f) => f.id === id)).length;
      const badProvenance = (diagnosis.facts ?? []).filter(
        (f) => !f.source?.step || !f.source?.tool || !steps.some((s) => s.id === f.source.step)).length;

      /* A causal claim the evidence rule did not produce. */
      const unearnedRootCause = diagnosis.conclusion?.root_cause === true
        && diagnosis.outcome !== D.OUTCOMES.ROOT_CAUSE_ESTABLISHED ? 1 : 0;
      const blamedWithoutEvidence = (diagnosis.hypotheses ?? [])
        .filter((h) => h.support_level === 'strong' && (h.unsupported_blame?.length ?? 0) > 0).length;
      const establishedText = diagnosis.outcome === D.OUTCOMES.ROOT_CAUSE_ESTABLISHED
        ? String(diagnosis.conclusion?.statement ?? '') : '';
      const overreach = cat.mustNotEstablishUnless && establishedText
        && !cat.mustNotEstablishUnless.test(establishedText) ? 1 : 0;
      const unsupportedCausal = unearnedRootCause + blamedWithoutEvidence + overreach;

      /* Timeline correctness: ordered, and every entry anchored to a fact. */
      const events = diagnosis.timeline?.events ?? [];
      const timed = events.filter((e) => e.epoch !== null);
      const timelineOrdered = timed.every((e, i) => i === 0 || timed[i - 1].epoch <= e.epoch);
      const timelineAnchored = events.every((e) => e.fact_id);
      const timelineOk = timelineOrdered && timelineAnchored;

      const after = await table.get('incident', unassigned.sysId, 'all');
      const mutated = (before?.sys_updated_on?.value ?? null) === (after?.sys_updated_on?.value ?? null) ? 0 : 1;

      const ok = executable && unsupportedCausal === 0 && inventedSurviving === 0
        && badProvenance === 0 && mutated === 0 && timelineOk;

      rows.push({
        ...cat, label, ok, executable, completed, refs: refs.length, usedDiagnostic,
        inventedAttempted, inventedSurviving, badProvenance, unsupportedCausal, mutated,
        timelineOk, events: events.length, facts: diagnosis.facts?.length ?? 0,
        causal: (diagnosis.facts ?? []).filter((f) => f.causal).length,
        outcome: diagnosis.outcome, ms,
      });

      const why = ok
        ? `${diagnosis.outcome} · ${completed}/${steps.length} reads · ${diagnosis.facts.length} facts `
          + `(${(diagnosis.facts ?? []).filter((f) => f.causal).length} causal) · ${events.length} events`
        : (!executable
          ? `no investigation — ${diagnosis.stopped?.reason ?? '?'}`
          : `causal=${unsupportedCausal} invented=${inventedSurviving} prov=${badProvenance} mut=${mutated} timeline=${timelineOk}`);
      console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} ${cat.name.padEnd(28)} ${why}`);
    }
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

const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
const pass = rows.filter((r) => r.ok).length;

console.log();
console.log('per category:');
for (const id of [...new Set(rows.map((r) => r.id))]) {
  const rs = rows.filter((r) => r.id === id);
  console.log(`  ${id} ${rs[0].name.padEnd(28)} ${rs.filter((r) => r.ok).length}/${rs.length}  `
    + `${rs.map((r) => r.outcome ?? '—').join(', ')}`);
}

console.log();
console.log('§46 / §47 METRICS');
console.log(`  Requests                        ${rows.length}`);
console.log(`  Executable investigations       ${rows.filter((r) => r.executable).length}`);
console.log(`  Used a causal evidence surface  ${rows.filter((r) => r.usedDiagnostic).length}`);
console.log(`  Correct                         ${pass}`);
console.log(`  Incorrect                       ${rows.length - pass}`);
console.log(`  Dataflow references             ${sum('refs')}`);
console.log(`  Timeline correct                ${rows.filter((r) => r.timelineOk).length}/${rows.length}`);
console.log(`  Avg reads completed             ${(sum('completed') / Math.max(rows.length, 1)).toFixed(1)}`);
console.log(`  Avg latency                     ${(sum('ms') / Math.max(rows.length, 1) / 1000).toFixed(1)}s`);
console.log();
console.log('  MODEL BEHAVIOUR (caught, not prevented)');
console.log(`    invented citations ATTEMPTED  ${sum('inventedAttempted')}`);
console.log();
console.log('  §47 RELEASE TARGETS (all must be 0)');
console.log(`    unsupported FACT claims       ${sum('inventedSurviving')}`);
console.log(`    facts without provenance      ${sum('badProvenance')}`);
console.log(`    unsupported CAUSAL claims     ${sum('unsupportedCausal')}`);
console.log(`    mutation bypasses             ${sum('mutated')}`);

const blockers = sum('inventedSurviving') + sum('badProvenance') + sum('unsupportedCausal') + sum('mutated');
console.log();
/*
 * A run that measured nothing has not met anything. Printing "targets met" on
 * zero requests would be the most misleading line in the whole report.
 */
if (!rows.length) {
  console.log('NOT MEASURED: no request completed, so no release target was exercised.');
} else {
  console.log(blockers === 0
    ? 'RELEASE TARGETS MET: no unsupported fact or causal claim, no mutation bypass.'
    : `RELEASE TARGETS FAILED: ${blockers} violation(s) above.`);
}
