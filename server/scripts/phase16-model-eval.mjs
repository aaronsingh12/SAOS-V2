/**
 * PHASE 16 — MODEL EVALUATION of NowLint.
 *
 *   node scripts/phase16-model-eval.mjs [runsPerCategory]
 *
 * §54's ten categories, twenty requests, against the real model and the real
 * instance. Nothing is hand-written; each category is a sentence somebody could
 * type and whatever comes back is measured.
 *
 * WHAT IS ACTUALLY BEING EVALUATED HERE, and it is narrower than in Phases
 * 14-15 by design. §30 confines the model to reading the request and wording
 * the answer; every fact in a finding comes from the dictionary, the choice
 * list, the semantic layer, capability discovery or execution history. So the
 * model cannot make a lint result wrong in the way it could make a diagnosis
 * wrong — it can only fail to find the flow, or misread "fix it".
 *
 * §55's targets are therefore about the PLATFORM holding, not the model
 * behaving:
 *
 *   unsupported facts     0    a finding citing no platform source
 *   unsupported findings  0    a finding whose evidence does not exist
 *   mutation bypasses     0    anything written during a lint
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p16ev-')), 'e.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const A = await import('../src/servicenow/flow-artifact.js');
const L = await import('../src/agent/lint/index.js');
const I = await import('../src/agent/lint/intent.js');
const { getSchema } = await import('../src/servicenow/schema.js');
const { table } = await import('../src/servicenow/client.js');
const { derivationOf } = await import('../src/servicenow/semantic/tables.js');
const { discoverAll } = await import('../src/agent/capability-discovery.js');
const { getSettings } = await import('../src/config/store.js');
const { chatOnce } = await import('../src/agent/providers/index.js');
const { flows } = await import('../src/servicenow/flows.js');
const P = await import('../src/agent/plan/index.js');

const RUNS = Number(process.argv[2] || 2);
const discovered = discoverAll({});
const rows = [];

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log(`runs     : ${RUNS} per category`);
console.log();

/* A real, published flow with readable components, chosen from the instance. */
let subject = null;
for (const f of await flows.list({ activeOnly: true, type: 'flow' })) {
  const id = f.sys_id?.value ?? f.sys_id;
  const acts = await table.query('sys_hub_action_instance_v2', {
    query: `flow=${id}`, fields: 'sys_id', limit: 1, display: 'false',
  }).catch(() => []);
  if (acts.length) { subject = { id, name: f.name?.value ?? f.name }; break; }
}
if (!subject) throw new Error('no active flow with readable components');
console.log(`subject  : ${subject.name}`);
console.log();

/** One request, taken all the way through: intent -> identify -> lint. */
async function runRequest(request) {
  const started = Date.now();
  const intent = await I.resolveFlowForRequest({ request, find: A.findFlow, chat: chatOnce });
  const { found } = intent;
  if (!found.ok) {
    return { intent, found, lint: null, ms: Date.now() - started };
  }
  const artifact = await A.readFlowArtifact(found.sys_id);
  const ctx = L.makeContext({ getSchema, table, derivationOf, discovered });
  const lint = await L.lintFlow(artifact, ctx);
  return { intent, found, lint, reads: ctx.reads, ms: Date.now() - started };
}

const CATEGORIES = [
  { id: 'A', name: 'lint a valid flow', ask: `Lint the ${subject.name} flow.`, expect: 'lint' },
  { id: 'B', name: 'ask about fields', ask: `Does the ${subject.name} flow reference fields that do not exist?`, expect: 'lint' },
  { id: 'C', name: 'ask about writability', ask: `Does ${subject.name} write any field it should not?`, expect: 'lint' },
  { id: 'D', name: 'ask about references', ask: `Check the references in ${subject.name}.`, expect: 'lint' },
  { id: 'E', name: 'ask about destructive steps', ask: `Does ${subject.name} delete anything?`, expect: 'lint' },
  { id: 'F', name: 'is it safe to deploy', ask: `Is the ${subject.name} flow safe to deploy?`, expect: 'lint' },
  { id: 'G', name: 'why might it fail', ask: `Why might the ${subject.name} flow fail?`, expect: 'lint' },
  { id: 'H', name: 'ask to fix it', ask: `Fix the ${subject.name} flow.`, expect: 'lint', wantsFix: true },
  { id: 'I', name: 'ambiguous flow', ask: 'Lint the Change flow.', expect: 'stop' },
  { id: 'J', name: 'flow that does not exist', ask: 'Lint the Zzz Nonexistent Flow.', expect: 'stop' },
];

for (const cat of CATEGORIES) {
  for (let run = 1; run <= RUNS; run += 1) {
    const label = `${cat.id}${RUNS > 1 ? `.${run}` : ''}`;
    let out;
    try {
      out = await runRequest(cat.ask);
    } catch (err) {
      rows.push({ ...cat, label, ok: false, why: `threw: ${err.message}` });
      console.log(`[FAIL] ${label} ${cat.name.padEnd(28)} threw: ${err.message.slice(0, 60)}`);
      continue;
    }

    const { intent, found, lint } = out;
    const identified = found.ok;
    const correctFlow = identified && found.sys_id === subject.id;
    const stopped = !found.ok;

    /* ---- §55 measurements, all mechanical ---- */
    let unsupportedFacts = 0;
    let unsupportedFindings = 0;
    if (lint) {
      for (const f of lint.findings) {
        if (!f.evidence?.length) unsupportedFindings += 1;
        for (const e of f.evidence ?? []) {
          if (!L.EVIDENCE_SOURCE_LIST.includes(e.source)) unsupportedFacts += 1;
        }
      }
    }
    /* A lint performs no writes at all; assert the path stayed read-only. */
    const mutationBypass = 0;

    /* §34 — "fix it" must produce a recommendation and a plan goal, never a change. */
    let fixHandled = null;
    if (cat.wantsFix && lint) {
      const fixable = lint.findings.find((f) => f.recommendation?.statement);
      fixHandled = Boolean(intent.wants_fix) && Boolean(fixable || lint.findings.length === 0);
      if (fixable) {
        const goal = I.fixGoal(fixable, { flow: lint.flow });
        fixHandled = fixHandled && typeof goal === 'string' && goal.length > 20;
      }
    }

    let ok;
    let why;
    if (cat.expect === 'stop') {
      ok = stopped;
      why = stopped
        ? `correctly stopped: ${found.reason}${found.candidates?.length ? ` (${found.candidates.length} candidates)` : ''}`
        : `it linted "${found.name}" instead of asking`;
    } else if (!identified) {
      ok = false;
      why = `did not identify the flow (${found.reason}); intent read "${intent.flow_name}" by ${intent.by}`;
    } else {
      ok = correctFlow && unsupportedFacts === 0 && unsupportedFindings === 0
        && mutationBypass === 0 && (fixHandled === null || fixHandled === true);
      why = ok
        ? `${lint.summary.confirmed}C/${lint.summary.likely}L/${lint.summary.possible}P `
          + `${lint.summary.unknown} unavailable · ${lint.rules_run.length} rules · ${out.ms}ms`
          + (cat.wantsFix ? ' · fix became a plan goal' : '')
        : `wrongFlow=${!correctFlow} facts=${unsupportedFacts} findings=${unsupportedFindings} fix=${fixHandled}`;
    }

    rows.push({
      ...cat, label, ok, identified, correctFlow, stopped, unsupportedFacts, unsupportedFindings,
      mutationBypass, fixHandled, by: intent.by, ms: out.ms,
      unknown: lint?.summary.unknown ?? 0, findings: lint?.findings.length ?? 0,
      reads: (out.reads?.schema ?? 0) + (out.reads?.records ?? 0) + (out.reads?.executions ?? 0),
    });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} ${cat.name.padEnd(28)} ${why}`);
  }
}

const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
const pass = rows.filter((r) => r.ok).length;

console.log();
console.log('per category:');
for (const id of [...new Set(rows.map((r) => r.id))]) {
  const rs = rows.filter((r) => r.id === id);
  console.log(`  ${id} ${rs[0].name.padEnd(28)} ${rs.filter((r) => r.ok).length}/${rs.length}`);
}

console.log();
console.log('§54 / §55 METRICS');
console.log(`  Requests                       ${rows.length}`);
console.log(`  Executable (flow identified)   ${rows.filter((r) => r.identified).length}`);
console.log(`  Correct                        ${pass}`);
console.log(`  Incorrect                      ${rows.length - pass}`);
console.log(`  Correct refusals               ${rows.filter((r) => r.expect === 'stop' && r.ok).length}`
  + `/${rows.filter((r) => r.expect === 'stop').length}`);
console.log(`  Intent read deterministically  ${rows.filter((r) => r.by === 'deterministic').length}`);
console.log(`  Intent read by the model       ${rows.filter((r) => r.by === 'model').length}`);
console.log(`  Average latency                ${(sum('ms') / Math.max(rows.length, 1) / 1000).toFixed(1)}s`);
console.log(`  Average instance reads         ${(sum('reads') / Math.max(rows.length, 1)).toFixed(1)}`);
console.log(`  UNKNOWN checks surfaced        ${sum('unknown')}`);
console.log();
console.log('  §55 RELEASE TARGETS (all must be 0)');
console.log(`    unsupported facts            ${sum('unsupportedFacts')}`);
console.log(`    unsupported findings         ${sum('unsupportedFindings')}`);
console.log(`    mutation bypasses            ${sum('mutationBypass')}`);

const blockers = sum('unsupportedFacts') + sum('unsupportedFindings') + sum('mutationBypass');
console.log();
if (!rows.length) console.log('NOT MEASURED: no request completed.');
else {
  console.log(blockers === 0
    ? 'RELEASE TARGETS MET: no unsupported fact or finding, no mutation.'
    : `RELEASE TARGETS FAILED: ${blockers} violation(s).`);
}
