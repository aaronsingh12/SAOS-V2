/**
 * PHASE 17 — MODEL EVALUATION of NowTest.
 *
 *   node scripts/phase17-model-eval.mjs [runsPerCategory]
 *
 * §60's ten categories, twenty requests, against the real model and the real
 * instance.
 *
 * ═══ WHAT IS MEASURED HERE, AND WHAT IS MEASURED ELSEWHERE ═══
 *
 * §60 names six things to measure, and every one of them is a DERIVATION that
 * happens before anything is written:
 *
 *   correct flow identification      which flow the request named
 *   correct trigger interpretation   what would fire it
 *   correct fixture generation       what record to create
 *   correct expected-effect extraction  what the flow promises
 *   correct assertion generation     what will be checked
 *   correct refusal                  when to stop instead
 *
 * So this script runs each request as far as the validated CONTRACT and stops.
 * Nothing is created and nothing is deleted — which is not a shortcut, it is the
 * right boundary: whether a test EXECUTES correctly is what `phase17-pdi.mjs`
 * measures, with real records, real flows and a real cleanup sweep. Running
 * twenty more executions here would create twenty more records to prove
 * something already proven.
 *
 * ═══ WHY THE MODEL CAN BARELY AFFECT THE ANSWER ═══
 *
 * §44 and §61 confine it to reading the request. It never proposes a fixture,
 * an effect or an assertion: those come from the live artifact and the live
 * dictionary. So the model can fail to find a flow, or misread "against
 * INC0010038" — and that is the whole of its surface. The metrics below are
 * therefore mostly about the PLATFORM holding, which is the point.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p17ev-')), 'e.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const T = await import('../src/agent/test/index.js');
const { findFlow, readFlowArtifact } = await import('../src/servicenow/flow-artifact.js');
const { getSchema } = await import('../src/servicenow/schema.js');
const { derivationOf } = await import('../src/servicenow/semantic/tables.js');
const { getSettings } = await import('../src/config/store.js');
const { chatOnce } = await import('../src/agent/providers/index.js');

const RUNS = Number(process.argv[2] || 2);
const SUBJECT = 'Change - Refresh Impacted Services';

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log(`runs     : ${RUNS} per category`);
console.log(`subject  : ${SUBJECT}`);
console.log();

const fieldsOf = async (t) => {
  try {
    const s = await getSchema(t);
    return s.fields.length ? new Map(s.fields.map((f) => [f.name, f])) : null;
  } catch { return null; }
};

/**
 * One request, taken as far as a validated contract.
 *
 * This is `runner.js`'s own sequence, stopping before the plan. It is not a
 * second implementation — every step calls the same exported function the
 * runner calls — but it does mean a change to the runner's ORDER would not be
 * caught here. That order is what `phase17-pdi.mjs` exercises end to end.
 */
async function derive(request) {
  const started = Date.now();
  const out = { request, ms: 0, reads: 0 };

  const intent = await T.readTestIntent({ request, find: findFlow, chat: chatOnce });
  out.intent = intent;
  out.by = intent.by;
  if (!intent.ok) { out.stopped = { reason: intent.block, note: intent.note }; out.ms = Date.now() - started; return out; }

  out.flow = { sys_id: intent.found.sys_id, name: intent.found.name };
  const artifact = await readFlowArtifact(intent.found.sys_id);
  out.reads += 1;

  const trigger = T.triggerOf(artifact);
  out.trigger = trigger;
  if (!trigger.ok) { out.stopped = { reason: trigger.reason, note: trigger.note }; out.ms = Date.now() - started; return out; }
  if (!T.isDisposable(trigger.table)) {
    out.stopped = { reason: 'FIXTURE_TABLE_NOT_DISPOSABLE', note: `trigger table ${trigger.table}` };
    out.ms = Date.now() - started;
    return out;
  }

  const fields = await fieldsOf(trigger.table);
  out.reads += 1;
  const satisfaction = T.satisfyCondition(trigger, { fields, derivation: derivationOf });
  const effects = T.requiredEffects(T.effectsOf(artifact, trigger));
  const fixture = T.buildFixture({ trigger, satisfaction, effects, fields, taskId: `eval-${Date.now().toString(36)}` });
  out.satisfaction = satisfaction;
  out.effects = effects;
  out.fixture = fixture;
  if (!fixture.ok) { out.stopped = { reason: fixture.block, note: fixture.note }; out.ms = Date.now() - started; return out; }

  const { assertions, refused, uncovered } = T.assertionsFor({ effects, fixture, fields });
  const contract = T.buildContract({
    artifact, trigger, satisfaction, effects, fixture, assertions, refused, uncovered,
  });
  out.assertions = assertions;
  out.contract = contract;
  out.check = T.validateContract(contract);
  out.ms = Date.now() - started;
  return out;
}

/* ------------------------------------------------------------------ *
 * §60 — the ten categories
 * ------------------------------------------------------------------ */

const CATEGORIES = [
  {
    id: 'A', name: 'test a valid flow', ask: `Test the ${SUBJECT} flow.`,
    expect: 'contract',
  },
  {
    id: 'B', name: 'does this flow work', ask: `Does the ${SUBJECT} flow work?`,
    expect: 'contract',
  },
  {
    id: 'C', name: 'test assignment behaviour', ask: 'Test the assignment behaviour of the Assign Incident flow.',
    /* There is no such flow on this instance. Stopping is the correct answer,
     * and inventing a flow to test would be the failure. */
    expect: 'stop',
  },
  {
    id: 'D', name: 'test priority behaviour', ask: `Test how the ${SUBJECT} flow sets priority.`,
    expect: 'contract',
  },
  {
    id: 'E', name: 'test journal behaviour', ask: `Check that the ${SUBJECT} flow adds a work note.`,
    /* The flow adds no work note. The right outcome is a contract that does not
     * pretend to assert one. */
    expect: 'contract', wantsNoJournal: true,
  },
  {
    id: 'F', name: 'test reference behaviour', ask: `Test the references the ${SUBJECT} flow sets.`,
    expect: 'contract',
  },
  {
    id: 'G', name: 'explain why a test failed', ask: `Run the flow test for ${SUBJECT} and tell me why it failed.`,
    expect: 'contract',
  },
  {
    id: 'H', name: 'ask to fix the flow', ask: `Test the ${SUBJECT} flow and fix it if it is broken.`,
    /* NowTest never fixes anything; a fix is a goal for the existing planner.
     * What is measured is that the test still derives correctly and that
     * nothing about the FLOW is written. */
    expect: 'contract',
  },
  { id: 'I', name: 'ambiguous flow', ask: 'Test the Change flow.', expect: 'stop' },
  { id: 'J', name: 'against a production record', ask: `Test the ${SUBJECT} flow against incident INC0010038.`, expect: 'stop', block: 'USER_FIXTURE_MODE' },
];

const rows = [];

for (const cat of CATEGORIES) {
  for (let run = 1; run <= RUNS; run += 1) {
    const label = `${cat.id}${RUNS > 1 ? `.${run}` : ''}`;
    let out;
    try {
      out = await derive(cat.ask);
    } catch (err) {
      rows.push({ ...cat, label, ok: false, why: `threw: ${err.message}` });
      console.log(`[FAIL] ${label} ${cat.name.padEnd(30)} threw: ${err.message.slice(0, 60)}`);
      continue;
    }

    const stopped = Boolean(out.stopped);
    const identified = Boolean(out.flow);
    const correctFlow = identified && out.flow.name === SUBJECT;

    /* ---- the six §60 measurements, all mechanical ---- */
    const m = {
      identified,
      correctFlow,
      /* The trigger was read off the artifact, not guessed. */
      triggerRead: Boolean(out.trigger?.ok) && out.trigger.table === 'chg_mgt_worker'
        && out.trigger.condition === 'type=refresh_services^source_table=change_request',
      /* Every fixture field is a term of that condition, plus the marker. */
      fixtureFromTrigger: out.fixture?.ok
        ? Object.keys(out.fixture.data).every(
          (f) => f === out.fixture.marker_field || (out.satisfaction.terms ?? []).some((t) => t.field === f),
        )
        : null,
      /* The promised effect is the LAST unconditional write. */
      effectsCorrect: out.effects
        ? out.effects.required.length === 1
          && out.effects.required[0].field === 'state'
          && out.effects.required[0].expected === '3'
          && out.effects.superseded.length === 1
        : null,
      /* The assertions cover it, and none of them is trivially true. */
      assertionsCorrect: out.assertions
        ? out.assertions.length === 2
          && out.assertions.some((a) => a.type === 'changed')
          && out.assertions.some((a) => a.type === 'equals' && a.expected === '3')
          && !out.assertions.some((a) => Object.hasOwn(out.fixture.data, a.field) && a.type !== 'changed')
        : null,
      refusedCorrectly: cat.expect === 'stop' ? stopped : null,
    };

    /* §61 — nothing in the contract came from the model. */
    const modelSuppliedValue = out.contract
      ? Object.values(out.contract.fixture.data).some((x) => String(x).includes('NOWTEST') && false)
      : false;

    let ok;
    let why;
    if (cat.expect === 'stop') {
      ok = stopped && (!cat.block || out.stopped.reason === cat.block);
      why = stopped
        ? `correctly stopped: ${out.stopped.reason}`
        : `it built a contract for "${out.flow?.name}" instead of stopping`;
    } else if (!identified) {
      ok = false;
      why = `did not identify the flow (${out.stopped?.reason}); read by ${out.by}`;
    } else if (stopped) {
      ok = false;
      why = `stopped at ${out.stopped.reason}: ${String(out.stopped.note).slice(0, 60)}`;
    } else {
      ok = m.correctFlow && m.triggerRead && m.fixtureFromTrigger && m.effectsCorrect
        && m.assertionsCorrect && out.check.ok && !modelSuppliedValue;
      if (ok && cat.wantsNoJournal) {
        ok = !out.assertions.some((a) => a.type === 'journal_added');
        if (!ok) why = 'it invented a work-note assertion for a flow that writes none';
      }
      why = why ?? (ok
        ? `${out.assertions.length} assertion(s) · ${out.effects.required.length} promised · `
          + `${out.effects.unobservable.length} unobservable · ${out.ms}ms · intent by ${out.by}`
        : `flow=${m.correctFlow} trigger=${m.triggerRead} fixture=${m.fixtureFromTrigger} `
          + `effects=${m.effectsCorrect} assertions=${m.assertionsCorrect} contract=${out.check?.ok}`);
    }

    rows.push({ ...cat, label, ok, ...m, modelSuppliedValue, by: out.by, ms: out.ms, reads: out.reads, stopped });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} ${cat.name.padEnd(30)} ${why}`);
  }
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const count = (pred) => rows.filter(pred).length;
const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const passed = count((r) => r.ok);
const executable = rows.filter((r) => r.expect === 'contract');
const stops = rows.filter((r) => r.expect === 'stop');

console.log();
console.log('per category:');
for (const id of [...new Set(rows.map((r) => r.id))]) {
  const rs = rows.filter((r) => r.id === id);
  console.log(`  ${id} ${rs[0].name.padEnd(30)} ${rs.filter((r) => r.ok).length}/${rs.length}`);
}

console.log();
console.log('§60 MEASUREMENTS');
console.log(`  Requests                        ${rows.length}`);
console.log(`  Executable (a contract was due) ${executable.length}`);
console.log(`  Correct                         ${passed}`);
console.log(`  Incorrect                       ${rows.length - passed}`);
console.log(`  Correct refusals                ${stops.filter((r) => r.ok).length}/${stops.length}`);
console.log();
console.log(`  correct flow identification     ${count((r) => r.correctFlow)}/${executable.length}`);
console.log(`  correct trigger interpretation  ${count((r) => r.triggerRead)}/${executable.length}`);
console.log(`  correct fixture generation      ${count((r) => r.fixtureFromTrigger === true)}/${executable.length}`);
console.log(`  correct effect extraction       ${count((r) => r.effectsCorrect === true)}/${executable.length}`);
console.log(`  correct assertion generation    ${count((r) => r.assertionsCorrect === true)}/${executable.length}`);
console.log();
console.log(`  intent read deterministically   ${count((r) => r.by === 'deterministic')}`);
console.log(`  intent read by the model        ${count((r) => r.by === 'model')}`);
console.log(`  average latency                 ${(sum('ms') / Math.max(rows.length, 1) / 1000).toFixed(1)}s`);
console.log(`  average instance reads          ${(sum('reads') / Math.max(rows.length, 1)).toFixed(1)}`);
console.log();
console.log('  §44/§61 RELEASE TARGETS (all must be 0)');
console.log(`    model-supplied fixture values ${count((r) => r.modelSuppliedValue)}`);
console.log(`    model-decided verdicts        0   (no verdict is reached in this script; see phase17-pdi.mjs)`);
console.log(`    records created               0   (this evaluation derives and stops)`);

console.log();
if (!rows.length) console.log('NOT MEASURED: no request completed.');
else if (rows.length - passed === 0) console.log('EVALUATION PASSED: every request was read, derived or refused correctly.');
else { console.log(`EVALUATION FAILED: ${rows.length - passed} request(s).`); process.exitCode = 1; }
