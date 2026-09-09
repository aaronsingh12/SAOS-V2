/**
 * PHASE 8 — REAL MODEL TEST: does the configured model produce plans the
 * existing validator will accept?
 *
 *   node scripts/phase8-model-eval.mjs
 *
 * THE RULE THIS OBEYS. Validation is not weakened to improve the numbers. If the
 * model proposes something the semantic validator rejects, that is recorded as a
 * rejection — not repaired, not retried, not softened. A low acceptance rate is
 * a finding about the model, not a reason to loosen the gate.
 *
 * NO HIDDEN RETRIES. `generatePlan` is called exactly once per prompt. Whatever
 * comes back is measured.
 *
 * Capability discovery runs against the live instance, so an "unavailable"
 * capability here is a real property of this PDI, not a stub.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'p8-model-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'model.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const P = await import('../src/agent/plan/index.js');
const { getSettings } = await import('../src/config/store.js');
const { toolMap } = await import('../src/agent/tools.js');

/** The task categories Phase 8 requires, one prompt each. */
const CASES = [
  ['incident read', 'Show me the three most recent active P1 incidents.'],
  ['incident mutation', 'Set the short description of incident INC0010001 to "printer jam on level 3".'],
  ['schema/table task', 'Add a text field called "vendor_reference" to the incident table.'],
  ['flow task', 'Create a flow that emails the assignment group manager when a P1 incident is opened.'],
  ['SLA task', 'Create an SLA on incident that breaches after 4 hours for priority 1.'],
  ['ACL task', 'Restrict write access to the incident.short_description field to the itil role.'],
  ['catalog task', 'Create a catalog item called "Request a laptop" with a variable for the model.'],
  ['impersonation/elevation task', 'Impersonate the user abel.tuter and check what they can see on the incident table.'],
];

const rows = [];
const DEADLINE_MS = 240000;

for (const [category, goal] of CASES) {
  const t0 = Date.now();
  const row = { category, goal, ms: 0 };
  try {
    const out = await Promise.race([
      P.generatePlan({ goal }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('model deadline exceeded')), DEADLINE_MS)),
    ]);
    row.ms = Date.now() - t0;

    if (!out.ok) {
      // A refusal is a legitimate, and often correct, outcome — the planner
      // refusing to plan against a capability this instance does not have is the
      // system working, not failing.
      row.outcome = 'REFUSED';
      row.reason = out.reason;
      row.note = String(out.note ?? '').slice(0, 140);
      row.steps = out.candidate?.steps?.length ?? 0;
      // WHY it was rejected is the whole point of the measurement. A bare
      // "invalid" tells nobody whether the model is bad or the gate is wrong.
      row.fatal = (out.fatal ?? []).map((p) => `${p.code}${p.step ? `@${p.step}` : ''}`);
      row.problems = (out.problems ?? []).map((p) => `${p.code}${p.step ? `@${p.step}` : ''}`);
      row.fatalDetail = (out.fatal ?? []).slice(0, 3).map((p) => String(p.message ?? p.note ?? '').slice(0, 160));
      row.candidateTools = (out.candidate?.steps ?? []).map((x) => x.tool).filter(Boolean);
      row.candidateCaps = [...new Set((out.candidate?.steps ?? []).map((x) => x.capability).filter(Boolean))];
      row.unknownTools = row.candidateTools.filter((t) => !toolMap.has(t));
    } else {
      const plan = out.plan ?? out;
      const steps = plan.steps ?? [];
      row.steps = steps.length;
      row.outcome = 'PLANNED';
      row.tools = steps.map((s) => s.tool).filter(Boolean);
      row.unknownTools = row.tools.filter((t) => !toolMap.has(t));
      row.stepsWithNoTool = steps.filter((s) => !s.tool).length;
      row.capabilities = [...new Set(steps.map((s) => s.capability).filter(Boolean))];
      row.unverified = steps.filter((s) => s.mutating && !s.verification).length;
      row.validation = out.validation ?? null;
      row.fingerprint = Boolean(out.fingerprint ?? plan.fingerprint);
    }
  } catch (err) {
    row.ms = Date.now() - t0;
    row.outcome = 'ERROR';
    row.reason = err.message.slice(0, 160);
  }
  rows.push(row);
  console.log(`${row.outcome.padEnd(9)} ${category.padEnd(30)} ${String(row.ms).padStart(7)}ms  `
    + (row.outcome === 'PLANNED'
      ? `steps=${row.steps} tools=[${(row.tools ?? []).join(',')}] unknown=[${(row.unknownTools ?? []).join(',')}]`
      : `${row.reason} steps=${row.steps} fatal=[${(row.fatal ?? []).join(',')}] `
        + `caps=[${(row.candidateCaps ?? []).join(',')}] unknownTools=[${(row.unknownTools ?? []).join(',')}]`));
  if (row.fatalDetail?.length) for (const d of row.fatalDetail) console.log(`          · ${d}`);
}

/* ---- the measures Phase 8 asked for ---- */
const total = rows.length;
const planned = rows.filter((r) => r.outcome === 'PLANNED');
const refused = rows.filter((r) => r.outcome === 'REFUSED');
const errored = rows.filter((r) => r.outcome === 'ERROR');
const toolMiss = planned.filter((r) => (r.unknownTools ?? []).length > 0);
const noTool = planned.filter((r) => r.stepsWithNoTool > 0);
const unverifiedWrites = planned.filter((r) => r.unverified > 0);

const pct = (n) => `${((n / total) * 100).toFixed(0)}%`;

console.log();
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log();
console.log(`cases                          ${total}`);
console.log(`valid plan rate                ${planned.length}/${total}  ${pct(planned.length)}`);
console.log(`refused (validator or capability) ${refused.length}/${total}  ${pct(refused.length)}`);
console.log(`errored / no answer            ${errored.length}/${total}  ${pct(errored.length)}`);
console.log(`tool-miss (named a tool that does not exist)  ${toolMiss.length}/${planned.length || 1}`);
console.log(`steps with no tool at all      ${noTool.length}/${planned.length || 1}`);
console.log(`mutating steps with no verification  ${unverifiedWrites.length}/${planned.length || 1}`);
console.log();
console.log('rejection codes, by frequency:');
const freq = new Map();
for (const r of refused) for (const c of (r.fatal ?? [])) {
  const bare = c.split('@')[0];
  freq.set(bare, (freq.get(bare) ?? 0) + 1);
}
for (const [code, count] of [...freq].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(3)}  ${code}`);
console.log();
console.log('per case:');
for (const r of refused) {
  console.log(`  ${r.category.padEnd(30)} ${r.reason} steps=${r.steps} fatal=[${(r.fatal ?? []).join(', ')}]`);
  for (const d of (r.fatalDetail ?? [])) console.log(`      ${d}`);
}
const toolMissRefused = refused.filter((r) => (r.unknownTools ?? []).length);
console.log();
console.log(`tool-miss among REJECTED candidates  ${toolMissRefused.length}/${refused.length || 1}`
  + (toolMissRefused.length ? `  ${JSON.stringify([...new Set(toolMissRefused.flatMap((r) => r.unknownTools))])}` : ''));
if (errored.length) {
  console.log();
  console.log('errors:');
  for (const r of errored) console.log(`  ${r.category.padEnd(30)} ${r.reason}`);
}

fs.writeFileSync(path.join(scratch, 'rows.json'), JSON.stringify(rows, null, 2));
console.log();
console.log('raw:', path.join(scratch, 'rows.json'));
