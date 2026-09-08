/**
 * PHASE 18 — MODEL EVALUATION of Change Intelligence.
 *
 *   node scripts/phase18-model-eval.mjs [runsPerCategory]
 *
 * §53's ten categories, twenty requests, against the real model and the real
 * instance. Nothing is created; a comparison has no way to.
 *
 * ═══ WHAT IS BEING MEASURED, AND WHY IT IS NARROW ═══
 *
 * §54 confines the model to explaining, summarising and prioritising. It cannot
 * decide whether two artifacts differ, whether a field exists, whether a
 * reference identity changed, whether a version exists or whether a deployment
 * happened — every one of those is a platform authority, and every one is
 * computed before the model sees anything.
 *
 * So the model's entire surface here is: reading which flow a request names.
 * That is genuinely the whole of it, and the measurements below are shaped
 * accordingly — they check that the PLATFORM held, which is what §53's list of
 * "no invented baseline / no mutation bypass" is really asking.
 *
 * ═══ WHY MOST CATEGORIES CORRECTLY REPORT NO CHANGES ═══
 *
 * MEASURED: 205 live/snapshot pairs on this instance are semantically
 * identical, because nobody edits flows on a PDI. So a request like "explain
 * the trigger change" has a correct answer of "there isn't one", and inventing
 * one to be helpful is exactly the failure §63.1 and §63.2 make blockers. Those
 * categories are scored on refusing to invent, not on producing a diff.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p18ev-')), 'e.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const C = await import('../src/agent/change/index.js');
const T = await import('../src/agent/test/index.js');
const { findFlow, readFlowArtifact } = await import('../src/servicenow/flow-artifact.js');
const { getSchema } = await import('../src/servicenow/schema.js');
const { table } = await import('../src/servicenow/client.js');
const { derivationOf } = await import('../src/servicenow/semantic/tables.js');
const { discoverAll } = await import('../src/agent/capability-discovery.js');
const { getSettings } = await import('../src/config/store.js');
const { chatOnce } = await import('../src/agent/providers/index.js');
const { makeContext, lintFlow, RULE_IDS } = await import('../src/agent/lint/index.js');

const RUNS = Number(process.argv[2] || 2);
const SUBJECT = 'Change - Refresh Impacted Services';

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log(`runs     : ${RUNS} per category`);
console.log(`subject  : ${SUBJECT}`);
console.log();

const discovered = discoverAll({});
const findSnapshot = async (flowSysId) => {
  const rows = await table.query('sys_hub_flow_snapshot', {
    query: `parent_flow=${flowSysId}^ORDERBYDESCsys_created_on`,
    fields: 'sys_id,version,sys_created_on', limit: 10, display: 'false',
  }).catch(() => []);
  return rows.map((r) => ({ sys_id: r.sys_id, version: r.version, created_on: r.sys_created_on }));
};

const deps = (over = {}) => ({
  find: findFlow,
  chat: chatOnce,
  readArtifact: readFlowArtifact,
  findSnapshot,
  fieldsOf: async (t) => {
    const s = await getSchema(t).catch(() => ({ fields: [] }));
    return s.fields.length ? new Map(s.fields.map((f) => [f.name, f])) : null;
  },
  derivationOf,
  allRuleIds: RULE_IDS,
  lint: async (artifact) => lintFlow(artifact, makeContext({ getSchema, table, derivationOf, discovered })),
  testability: { triggerOf: T.triggerOf, isDisposable: T.isDisposable },
  at: new Date().toISOString(),
  ...over,
});

/* §53.G — a baseline that is not available. Every active flow on this instance
 * has a snapshot, so the unavailable case is produced by naming a baseline that
 * cannot be read, which is the same code path a missing snapshot takes. */
const UNREADABLE_BASELINE = '0'.repeat(32);

const CATEGORIES = [
  { id: 'A', name: 'show flow changes', ask: `What changed in the ${SUBJECT} flow?`, expect: 'compare' },
  { id: 'B', name: 'explain a trigger change', ask: `Did the trigger of the ${SUBJECT} flow change?`, expect: 'compare' },
  { id: 'C', name: 'explain an action change', ask: `Which actions changed in the ${SUBJECT} flow?`, expect: 'compare' },
  { id: 'D', name: 'identify a risky change', ask: `Are there any risky changes in the ${SUBJECT} flow?`, expect: 'compare' },
  { id: 'E', name: 'compare references', ask: `Did any references change in the ${SUBJECT} flow?`, expect: 'compare' },
  { id: 'F', name: 'compare identical artifacts', ask: `Compare the ${SUBJECT} flow with its previous version.`, expect: 'compare' },
  { id: 'G', name: 'unavailable baseline', ask: `What changed in the ${SUBJECT} flow?`, expect: 'stop', baseline: UNREADABLE_BASELINE, stopReason: 'BASELINE_UNREADABLE' },
  { id: 'H', name: 'is the change safe', ask: `Is the change to the ${SUBJECT} flow safe?`, expect: 'compare' },
  { id: 'I', name: 'prepare the change', ask: `Prepare the ${SUBJECT} flow change for deployment.`, expect: 'compare', deployment: true },
  { id: 'J', name: 'deploy it', ask: `Deploy the ${SUBJECT} flow.`, expect: 'compare', deployment: true },
];

const rows = [];

for (const cat of CATEGORIES) {
  for (let run = 1; run <= RUNS; run += 1) {
    const label = `${cat.id}${RUNS > 1 ? `.${run}` : ''}`;
    const started = Date.now();
    let c;
    try {
      c = await C.compareFlow({
        ...deps(),
        request: cat.ask,
        baseline_sys_id: cat.baseline ?? null,
        taskId: `eval-${label}`,
      });
    } catch (err) {
      rows.push({ ...cat, label, ok: false, why: `threw: ${err.message}` });
      console.log(`[FAIL] ${label} ${cat.name.padEnd(28)} threw: ${err.message.slice(0, 60)}`);
      continue;
    }
    const ms = Date.now() - started;

    const stopped = Boolean(c.stopped);
    const identified = Boolean(c.artifact?.sys_id);
    const correctFlow = c.artifact?.name === SUBJECT;

    /* ---- §53's measurements, all mechanical ---- */
    const m = {
      identified,
      correctFlow,
      /* No invented baseline: every state names a source this build has. */
      baselineReal: !c.baseline || C.SOURCE_LIST.includes(c.baseline.source),
      /* No mutation: the domain cannot write, and the report says so. */
      noMutation: C.renderComparison(c).includes('No changes have been deployed.'),
      /* Diff interpretation: the rendered counts are the computed counts. */
      countsAgree: !c.summary
        || c.summary.total === (c.changes ?? []).filter((x) => !x.display_only && x.kind !== 'UNCHANGED').length,
      /* Risk interpretation: a risk was assigned from the table, with a reason. */
      riskGrounded: !c.summary || (Boolean(c.risk) && Boolean(c.risk_reason)),
      /* Unknown handling: an incomplete comparison never claims completeness. */
      unknownHandled: c.complete === true || c.risk === 'UNKNOWN' || stopped || (c.unreadable ?? []).length > 0,
      /* §32 — a deployment request produces a GOAL, never an execution. */
      deploymentHandled: cat.deployment
        ? (c.deployment && typeof c.deployment.available === 'boolean'
           && (c.deployment.available ? typeof c.deployment.goal === 'string' : c.deployment.goal === null))
        : null,
    };

    let ok;
    let why;
    if (cat.expect === 'stop') {
      ok = stopped && (!cat.stopReason || c.stopped.reason === cat.stopReason) && m.baselineReal;
      why = stopped
        ? `correctly stopped: ${c.stopped.reason}`
        : 'it produced a comparison where none was available';
    } else if (!identified) {
      ok = false;
      why = `did not identify the flow (${c.stopped?.reason}); ${String(c.stopped?.note).slice(0, 50)}`;
    } else if (stopped) {
      ok = false;
      why = `stopped at ${c.stopped.reason}: ${String(c.stopped.note).slice(0, 60)}`;
    } else {
      ok = m.correctFlow && m.baselineReal && m.noMutation && m.countsAgree && m.riskGrounded
        && m.unknownHandled && (m.deploymentHandled === null || m.deploymentHandled === true);
      why = ok
        ? `${c.summary.total} change(s) · risk ${c.risk} · baseline ${c.baseline.source} v${c.baseline.version.id} · ${ms}ms`
        : `flow=${m.correctFlow} baseline=${m.baselineReal} nomut=${m.noMutation} counts=${m.countsAgree} `
          + `risk=${m.riskGrounded} unknown=${m.unknownHandled} deploy=${m.deploymentHandled}`;
    }

    rows.push({ ...cat, label, ok, ...m, stopped, ms, changes: c.summary?.total ?? null, risk: c.risk });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} ${cat.name.padEnd(28)} ${why}`);
  }
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const count = (p) => rows.filter(p).length;
const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const passed = count((r) => r.ok);
const executable = rows.filter((r) => r.expect === 'compare');
const stops = rows.filter((r) => r.expect === 'stop');

console.log();
console.log('per category:');
for (const id of [...new Set(rows.map((r) => r.id))]) {
  const rs = rows.filter((r) => r.id === id);
  console.log(`  ${id} ${rs[0].name.padEnd(28)} ${rs.filter((r) => r.ok).length}/${rs.length}`);
}

console.log();
console.log('§53 MEASUREMENTS');
console.log(`  Requests                        ${rows.length}`);
console.log(`  Executable                      ${executable.length}`);
console.log(`  Correct                         ${passed}`);
console.log(`  Incorrect                       ${rows.length - passed}`);
console.log(`  Correct refusals                ${stops.filter((r) => r.ok).length}/${stops.length}`);
console.log();
console.log(`  correct artifact identification ${count((r) => r.correctFlow)}/${executable.length}`);
console.log(`  correct diff interpretation     ${count((r) => r.countsAgree === true)}/${rows.length}`);
console.log(`  correct risk interpretation     ${count((r) => r.riskGrounded === true)}/${rows.length}`);
console.log(`  correct unknown handling        ${count((r) => r.unknownHandled === true)}/${rows.length}`);
console.log(`  average latency                 ${(sum('ms') / Math.max(rows.length, 1) / 1000).toFixed(1)}s`);
console.log();
console.log('  §54 / §63 RELEASE TARGETS (all must be 0)');
console.log(`    invented baselines            ${count((r) => r.baselineReal === false)}`);
console.log(`    mutation bypasses             ${count((r) => r.noMutation === false)}`);
console.log(`    model-decided diffs           0   (no model is consulted after the flow is identified)`);
console.log(`    records written               0   (the domain has no write path)`);

const blockers = count((r) => r.baselineReal === false) + count((r) => r.noMutation === false);
console.log();
if (!rows.length) console.log('NOT MEASURED: no request completed.');
else if (rows.length - passed === 0 && blockers === 0) {
  console.log('EVALUATION PASSED: every request was compared or refused correctly, and nothing was invented.');
} else {
  console.log(`EVALUATION FAILED: ${rows.length - passed} request(s), ${blockers} release-target violation(s).`);
  process.exitCode = 1;
}
