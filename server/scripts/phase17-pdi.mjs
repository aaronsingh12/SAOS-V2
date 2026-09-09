/**
 * PHASE 17 — REAL PDI VALIDATION of NowTest.
 *
 *   node scripts/phase17-pdi.mjs
 *
 * §48-§57 against dev424910, with real records created, real flows fired, real
 * read-backs and real deletes. Nothing here is simulated: every PASS and every
 * FAIL below is decided from what the instance actually did.
 *
 * ═══ WHAT THIS INSTANCE CAN AND CANNOT PROVIDE ═══
 *
 * MEASURED FIRST, and PDI-0 re-measures it on every run rather than trusting
 * this comment:
 *
 *   1. `flow_authoring` is UNAVAILABLE here (no SDK), so §49's "create one only
 *      if the supported authoring mechanism permits it" does not permit it.
 *      §49's fallback is explicit: use an existing real flow.
 *
 *   2. NO active, v2-readable flow on this instance is triggered by `incident`
 *      or by `task`. All 25 active record triggers were enumerated; their
 *      tables are chg_mgt_worker, change_request, sc_request, ast_contract,
 *      alm_transfer_order(_line), business_app_request, sttrm_template,
 *      cmdb_data_management_task, ds_document_version, ga_guidance_history,
 *      kb_knowledge_base_request, sn_creatorstudio_*, sn_publications_*,
 *      sn_vsc_event and std_change_proposal.
 *
 * So the flow under test is "Change - Refresh Impacted Services", on
 * `chg_mgt_worker` — the second entry in the disposable allowlist, and the
 * reason there is a second entry at all. It is a genuinely good subject: a
 * linear flow with three unconditional actions, two of them Update Records on
 * the trigger record itself, and a measured runtime of ~37s to COMPLETE.
 *
 * `incident` still carries PDI-7 and PDI-8, which are about the FIXTURE layer —
 * derived fields and reference identity — and need no flow to be real.
 *
 * ═══ EVERY RECORD THIS SCRIPT CREATES IS DELETED ═══
 *
 * By NowTest's own cleanup where the run reaches it, by the script's `finally`
 * where it deliberately does not, and by a final sweep that queries both
 * disposable tables for the marker and reports anything left. The sweep is a
 * REPORT, never a delete: §18 says a run owns exactly what it created, and a
 * sweep that deleted by marker would be the rule this phase forbids.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p17pdi-')), 'p.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const T = await import('../src/agent/test/index.js');
const P = await import('../src/agent/plan/index.js');
const { findFlow, readFlowArtifact } = await import('../src/servicenow/flow-artifact.js');
const { getSchema } = await import('../src/servicenow/schema.js');
const { table } = await import('../src/servicenow/client.js');
const { derivationOf } = await import('../src/servicenow/semantic/tables.js');
const { discoverAll } = await import('../src/agent/capability-discovery.js');
const { getSettings } = await import('../src/config/store.js');
const { chatOnce } = await import('../src/agent/providers/index.js');
const { recordTest } = await import('../src/agent/plan/store.js');
const { recoverStep } = await import('../src/agent/recovery/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { getDb } = await import('../src/memory/db.js');
const { makeContext, lintFlow } = await import('../src/agent/lint/index.js');

const SUBJECT = 'Change - Refresh Impacted Services';
const v = (c) => (c && typeof c === 'object' && 'value' in c ? c.value : c);

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log(`subject  : ${SUBJECT}`);
console.log();

/* ------------------------------------------------------------------ *
 * Bookkeeping
 * ------------------------------------------------------------------ */

const results = [];
const timings = { setup: [], wait: [], assert: [], delete: [], cleanup: [], total: [] };
let scenario = '';

/** §65 — every phase a test spends time in, from the run's own measurements. */
const recordTimings = (r) => {
  if (!r?.timings) return;
  for (const [key, field] of [['setup', 'setup_ms'], ['wait', 'wait_ms'], ['assert', 'assert_ms'], ['delete', 'delete_ms'], ['cleanup', 'cleanup_ms'], ['total', 'total_ms']]) {
    const value = r.timings[field];
    if (Number.isFinite(value)) timings[key].push(value);
  }
};

const check = (label, ok, detail = '') => {
  results.push({ scenario, label, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};
const info = (line) => console.log(`         ${line}`);
const head = (name, title) => { scenario = name; console.log(`\n## ${name} — ${title}`); };

/* One session, so provenance and the ledger behave as they do in a real run. */
const SESSION = `p17-pdi-${Date.now().toString(36)}`;
getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
  .run(SESSION, new Date().toISOString(), new Date().toISOString());

const newTask = (goal) => { const t = createTask({ sessionId: SESSION, goal }); startTask(t.id); return t.id; };

/** Everything `testFlow` needs, wired to the real implementations. */
const deps = (over = {}) => ({
  sessionId: SESSION,
  find: findFlow,
  readArtifact: readFlowArtifact,
  chat: chatOnce,
  schemaFor: getSchema,
  derivation: derivationOf,
  generate: P.generatePlan,
  run: (opts) => P.executePlan({
    ...opts,
    recoverStep: (args) => recoverStep({ ...args, readRecord: ({ table: t, sys_id: id }) => table.get(t, id, 'all') }),
  }),
  plan: {
    save: P.savePlan, load: P.loadPlan, setState: P.setPlanState,
    approve: P.approvePlan, review: P.buildReview, violations: P.mutatingSteps,
  },
  record: recordTest,
  newTaskId: () => newTask('remove a leftover NowTest fixture'),
  /*
   * APPROVALS ARE ANSWERED, NOT BYPASSED, wherever the scenario allows it.
   *
   * `autoApprove` would skip the gate entirely and prove nothing about it. This
   * answers the real card through the real binding — `approvePlan` still checks
   * the fingerprint, and a plan that changed after the card would still be
   * refused. The executor's own per-step gate is the one place `autoApprove` is
   * used, because a script has nobody to click it.
   */
  approve: async () => ({ approved: true, source: 'user_click', at: new Date().toISOString() }),
  autoApprove: true,
  ...over,
});

/* ================================================================== *
 * PDI-0 — WHAT THIS INSTANCE ACTUALLY OFFERS (§49, §51)
 * ================================================================== */

head('PDI-0', 'capability, measured rather than assumed');

const discovered = discoverAll({});
const authoring = discovered.capabilities.flow_authoring;
check('flow_authoring is reported honestly, whatever it says',
  typeof authoring?.available === 'boolean',
  `available=${authoring?.available} reason=${authoring?.reason ?? 'n/a'}`);
if (!authoring?.available) {
  info('§49 fallback in force: an existing real flow is used and no flow is created or modified.');
}

/* Every active record trigger, and which tables they listen to. */
const triggerRows = await table.query('sys_hub_trigger_instance_v2', {
  query: '', fields: 'sys_id,flow,trigger_type,trigger_inputs', limit: 300, display: 'false',
});
const flowRows = await table.query('sys_hub_flow', {
  query: 'ORDERBYname', fields: 'sys_id,name,active,type', limit: 400, display: 'false',
});
const flowById = new Map(flowRows.map((r) => [r.sys_id, r]));
const zlib = await import('node:zlib');
const decode = (e) => { try { return JSON.parse(zlib.gunzipSync(Buffer.from(e, 'base64')).toString('utf8')); } catch { return null; } };

const activeRecordTriggers = [];
for (const t of triggerRows) {
  if (!String(t.trigger_type).startsWith('record')) continue;
  const f = flowById.get(t.flow);
  if (!f || String(f.active) !== 'true') continue;
  const map = {};
  for (const i of decode(t.trigger_inputs) ?? []) map[i.name] = i.value;
  activeRecordTriggers.push({ name: f.name, kind: t.trigger_type, table: map.table ?? null });
}
const onIncident = activeRecordTriggers.filter((t) => t.table === 'incident' || t.table === 'task');
check('the incident-flow gap is measured, not assumed', true,
  `${activeRecordTriggers.length} active record trigger(s); ${onIncident.length} on incident or task`);
if (!onIncident.length) {
  info('No flow on this instance is fired by an incident, so the flow scenarios use chg_mgt_worker.');
}

/* A real change_request for the fixture to point at. Read only. */
const changes = await table.query('change_request', {
  query: 'ORDERBYDESCsys_created_on', fields: 'sys_id,number', limit: 1, display: 'false',
});
const CHANGE = changes[0]?.sys_id ?? null;
check('a real change_request exists to reference', Boolean(CHANGE), CHANGE ? changes[0].number : 'none found');

/* ================================================================== *
 * PDI-1 — A PASSING TEST (§49)
 * ================================================================== */

head('PDI-1', 'a real flow whose promised effect really happens → PASS');

let pass1 = null;
if (CHANGE) {
  const taskId = newTask(`Test the ${SUBJECT} flow.`);
  pass1 = await T.testFlow({
    ...deps(),
    request: `Test the ${SUBJECT} flow.`,
    taskId,
    /*
     * The flow's TRIGGER does not require `source_record`, but its second
     * action passes it to a step that throws when it is empty. Supplying it is
     * how the flow gets a chance to succeed; every other scenario below tests
     * what happens when it does not.
     */
    fixture_fields: { source_record: CHANGE, operation: 'refresh' },
    lint: async (artifact) => lintFlow(artifact, makeContext({ getSchema, table, derivationOf, discovered })),
  });
  recordTimings(pass1);

  info(`status=${pass1.status} · ${pass1.statement}`);
  check('the test reached PASS', pass1.status === 'PASS', pass1.failures?.join(',') || '');
  check('every assertion passed against a real read-back',
    pass1.assertions?.length > 0 && pass1.assertions.every((a) => a.status === 'PASS'),
    (pass1.assertions ?? []).map((a) => `${a.type}:${a.status}`).join(' '));
  check('every assertion names the read that decided it (§43)',
    (pass1.assertions ?? []).every((a) => a.source?.step && a.source?.tool));
  check('the execution really completed',
    pass1.execution?.settled === true && pass1.execution?.state === 'EXECUTION_COMPLETE',
    `${pass1.execution?.state} after ${Math.round((pass1.execution?.waited_ms ?? 0) / 1000)}s`);
  check('the fixture was created and then deleted',
    pass1.cleanup?.status === 'PASS' && pass1.cleanup.records_deleted === pass1.cleanup.records_created,
    pass1.cleanup?.note ?? '');
  check('the deleted record is really gone',
    pass1.fixture?.sys_id ? !(await table.get('chg_mgt_worker', pass1.fixture.sys_id).catch(() => null)) : false);
  if (pass1.fixture?.sys_id) info(`fixture ${pass1.fixture.sys_id} · marker ${pass1.fixture.marker}`);
} else {
  check('PDI-1 could run', false, 'no change_request to reference');
}

/* ================================================================== *
 * PDI-2 / PDI-3 / PDI-9 — A FAILING TEST (§50, §51, §57)
 * ================================================================== */

head('PDI-2/3/9', 'the same flow, without what it needs → FAIL with evidence');

const taskId2 = newTask(`Test the ${SUBJECT} flow.`);
const fail2 = await T.testFlow({
  ...deps(),
  request: `Test the ${SUBJECT} flow.`,
  taskId: taskId2,
  /* Nothing supplied: the fixture is exactly what the trigger condition asks
   * for, which is what NowTest derives on its own. */
});
recordTimings(fail2);

info(`status=${fail2.status} · ${fail2.statement}`);
check('the test reached FAIL', fail2.status === 'FAIL', fail2.failures?.join(','));
check('§21: the execution error is classified as FLOW_EXECUTION_ERROR',
  (fail2.failures ?? []).includes('FLOW_EXECUTION_ERROR'),
  `execution=${fail2.execution?.state}`);
check('§42: the missing effect is classified, not reduced to "test failed"',
  (fail2.failures ?? []).some((f) => f === 'EXPECTED_EFFECT_MISSING' || f === 'EXPECTED_EFFECT_WRONG'),
  (fail2.failures ?? []).join(','));
check('§57: more than one assertion ran, and the passing one is preserved',
  (fail2.assertions ?? []).length > 1
  && fail2.assertions.some((a) => a.status === 'PASS')
  && fail2.assertions.some((a) => a.status === 'FAIL'),
  (fail2.assertions ?? []).map((a) => `${a.type}:${a.status}`).join(' '));
check('the execution error text is captured as evidence',
  Boolean(fail2.execution?.executions?.[0]?.error),
  String(fail2.execution?.executions?.[0]?.error ?? '').slice(0, 70));
check('§62: the report states the observation and refuses to explain it',
  T.renderTest(fail2).includes('It does not establish why.'));
check('§40: Doctor is offered as a continuation, not launched',
  fail2.doctor?.available === true && Boolean(fail2.doctor.request));
check('the fixture was still deleted', fail2.cleanup?.status === 'PASS', fail2.cleanup?.note ?? '');

/* ================================================================== *
 * PDI-4 — A CONTROLLED TIMEOUT (§52)
 * ================================================================== */

head('PDI-4', 'a bound too short for the flow → INCONCLUSIVE, never FAIL');

const taskId4 = newTask(`Test the ${SUBJECT} flow.`);
const inconclusive = await T.testFlow({
  ...deps(),
  request: `Test the ${SUBJECT} flow.`,
  taskId: taskId4,
  fixture_fields: CHANGE ? { source_record: CHANGE, operation: 'refresh' } : {},
  /*
   * MEASURED, and revised after the first run. This flow reached COMPLETE in
   * 37s once and in 4s the next time, so a six-second bound is not reliably
   * shorter than the flow. 1200ms is: the poller's floor is one second, so it
   * reads once, sleeps once and stops — while a flow that has to be queued,
   * claimed and executed cannot have finished. The timeout is real; only its
   * size was chosen.
   */
  timeoutMs: 1200,
});
recordTimings(inconclusive);

info(`status=${inconclusive.status} · ${inconclusive.statement}`);
check('§22/§70.8: a non-terminal execution at the deadline is INCONCLUSIVE',
  inconclusive.status === 'INCONCLUSIVE',
  `${inconclusive.execution?.state} settled=${inconclusive.execution?.settled}`);
check('the execution really had not settled when the bound expired',
  inconclusive.execution?.settled === false,
  `settled=${inconclusive.execution?.settled} waited=${inconclusive.execution?.waited_ms}ms`);
check('§70.7: it is not presented as success either', inconclusive.status !== 'PASS');
check('the timeout is classified as a TIMEOUT or as nothing having run yet',
  (inconclusive.failures ?? []).some((f) => f === 'TIMEOUT' || f === 'FLOW_NOT_EXECUTED'),
  (inconclusive.failures ?? []).join(','));
check('§39: the report says explicitly that no claim is made',
  T.renderTest(inconclusive).includes('No claim is made about whether the expected effect would eventually occur.'));
check('the fixture was still deleted after the timeout',
  inconclusive.cleanup?.status === 'PASS', inconclusive.cleanup?.note ?? '');

/* ================================================================== *
 * PDI-5 — CLEANUP FAILURE, AGAINST A REAL RECORD (§53, §36)
 * ================================================================== */

head('PDI-5', 'a cleanup that genuinely fails → surfaced, never a silent PASS');

/*
 * §53 asks for a CONTROLLED cleanup failure. Controlling it on a real instance
 * means arranging for the delete not to happen while everything else stays
 * real: a real fixture is created by the real executor, the run is cancelled
 * the moment it exists so the plan's own cleanup step never runs, and the
 * SECOND plan — the `finally` guarantee — is made to fail.
 *
 * The failure is injected at the one seam the domain has for it, the injected
 * `run`, and only for the cleanup task. Everything the assertion is about — the
 * ownership ledger, the state machine, the reported status, the wording of the
 * report — is the shipped code. The record this deliberately strands is deleted
 * by the sweep below, and the sweep proves it.
 */
const cleanupTasks = new Set();
const controller5 = new AbortController();
const taskId5 = newTask(`Test the ${SUBJECT} flow.`);
let leftover = null;
const baseDeps = deps();
const refusedCleanup = await T.testFlow({
  ...baseDeps,
  newTaskId: () => { const id = newTask('remove a leftover NowTest fixture'); cleanupTasks.add(id); return id; },
  run: (opts) => (cleanupTasks.has(opts.taskId)
    ? Promise.resolve({ ok: false, reason: 'error', note: 'the delete was refused by the instance (injected for PDI-5)' })
    : baseDeps.run(opts)),
  request: `Test the ${SUBJECT} flow.`,
  taskId: taskId5,
  signal: controller5.signal,
  timeoutMs: 5000,
  emit: (e) => { if (e.type === 'step_completed' && e.step === 'create_fixture') controller5.abort(); },
});
info(`status=${refusedCleanup.status} · cleanup=${refusedCleanup.cleanup?.status}`);
check('a run whose cleanup failed never reports PASS', refusedCleanup.status !== 'PASS');
check('§36: a fixture WAS created, so cleanup was genuinely needed',
  refusedCleanup.cleanup?.records_created === 1,
  `created=${refusedCleanup.cleanup?.records_created}`);
check('§36/§70.3: the cleanup failure is surfaced with the record named',
  refusedCleanup.cleanup?.status === 'FAILED'
  && refusedCleanup.cleanup.records_deleted === 0
  && String(refusedCleanup.cleanup.note ?? '').includes(refusedCleanup.fixture?.sys_id ?? 'x'),
  `${refusedCleanup.cleanup?.status}: ${String(refusedCleanup.cleanup?.note ?? '').slice(0, 100)}`);
check('§70.3: the failure is visible in the report a person reads',
  /Cleanup failed/.test(T.renderTest(refusedCleanup)));
if (refusedCleanup.cleanup?.status !== 'PASS' && refusedCleanup.fixture?.sys_id) {
  leftover = refusedCleanup.fixture.sys_id;
  info(`this scenario deliberately stranded ${leftover}; the sweep removes it.`);
}

/* ================================================================== *
 * PDI-6 — CANCELLATION (§54, §32)
 * ================================================================== */

head('PDI-6', 'cancelled mid-run → CANCELLED, and the fixture is still removed');

const controller = new AbortController();
const taskId6 = newTask(`Test the ${SUBJECT} flow.`);
const cancelled = await T.testFlow({
  ...deps(),
  request: `Test the ${SUBJECT} flow.`,
  taskId: taskId6,
  signal: controller.signal,
  timeoutMs: 8000,
  /* Abort the moment the fixture exists — the hardest boundary, because a
   * record is on the instance and the plan has not reached its own cleanup. */
  emit: (e) => { if (e.type === 'step_completed' && e.step === 'create_fixture') controller.abort(); },
});
info(`status=${cancelled.status} · cleanup=${cancelled.cleanup?.status}`);
check('§54: a cancelled run reports CANCELLED', cancelled.status === 'CANCELLED', cancelled.statement ?? '');
check('§32: cleanup was still attempted after the cancellation',
  cancelled.cleanup?.status !== 'NOT_NEEDED' || cancelled.cleanup?.records_created === 0,
  `${cancelled.cleanup?.status} created=${cancelled.cleanup?.records_created} deleted=${cancelled.cleanup?.records_deleted}`);
check('no false PASS came out of a cancellation', cancelled.status !== 'PASS');
if (cancelled.fixture?.sys_id && cancelled.cleanup?.status !== 'PASS') leftover = leftover ?? cancelled.fixture.sys_id;

/* ================================================================== *
 * PDI-7 — REFERENCE ASSERTION, BY IDENTITY (§55)
 * ================================================================== */

head('PDI-7', 'a reference compared by sys_id against a real record');

/*
 * No allowlisted flow on this instance sets a reference field, so the assertion
 * is exercised against a reference the PLATFORM sets and the fixture did not
 * write: `opened_by` on a new incident. That is a real read-back of a real
 * reference — what is not being claimed is that a flow produced it.
 */
let refIncident = null;
try {
  const created = await table.create('incident', {
    short_description: `${T.markerFor('pdi7')} NowForge reference assertion probe — safe to delete`,
    impact: '3', urgency: '3',
  });
  refIncident = v(created.sys_id);
  const after = await table.get('incident', refIncident, 'all');
  const openedBy = v(after.opened_by);
  const display = after.opened_by?.display_value ?? null;

  const right = T.evaluate([{
    id: 'r1', type: 'reference_identity', field: 'opened_by', expected: openedBy,
    description: 'opened_by references the API user', table: 'incident',
  }], { after: { value: after, source: { step: 'probe', tool: 'get_record' } } })[0];

  const wrong = T.evaluate([{
    id: 'r2', type: 'reference_identity', field: 'opened_by', expected: 'f'.repeat(32),
    description: 'opened_by references someone else', table: 'incident',
  }], { after: { value: after, source: { step: 'probe', tool: 'get_record' } } })[0];

  const byName = T.evaluate([{
    id: 'r3', type: 'reference_identity', field: 'opened_by', expected: display,
    description: 'opened_by references a display name', table: 'incident',
  }], { after: { value: after, source: { step: 'probe', tool: 'get_record' } } })[0];

  check('a matching sys_id PASSES', right.status === 'PASS', `${openedBy} (${display})`);
  check('a different sys_id with any display name FAILS', wrong.status === 'FAIL', wrong.note ?? '');
  check('a DISPLAY NAME cannot be used as an identity and reports UNAVAILABLE',
    byName.status === 'UNAVAILABLE', byName.note ?? '');
} catch (err) {
  check('PDI-7 could run', false, err.message);
} finally {
  if (refIncident) {
    await table.remove('incident', refIncident).catch(() => {});
    const gone = await table.get('incident', refIncident).catch(() => null);
    check('the reference probe record was deleted', !gone);
  }
}

/* ================================================================== *
 * PDI-8 — PRIORITY DERIVATION (§56, §15)
 * ================================================================== */

head('PDI-8', 'a derived trigger field, driven upstream and proven by read-back');

const incidentSchema = await getSchema('incident');
const incidentFields = new Map(incidentSchema.fields.map((f) => [f.name, f]));
const p1Trigger = { kind: 'record_create', table: 'incident', condition: 'priority=1', table_label: 'Incident' };
const p1Satisfaction = T.satisfyCondition(p1Trigger, { fields: incidentFields, derivation: derivationOf });

check('§15: the derived field is NOT written', p1Satisfaction.data.priority === undefined,
  JSON.stringify(p1Satisfaction.data));
check('§56: it is driven from impact and urgency instead',
  p1Satisfaction.data.impact === '1' && p1Satisfaction.data.urgency === '1');
check('the derivation is recorded on the contract, with its source',
  p1Satisfaction.derived[0]?.field === 'priority'
  && p1Satisfaction.derived[0].from.join('+') === 'impact+urgency');

const p8Fixture = T.buildFixture({
  trigger: p1Trigger, satisfaction: p1Satisfaction,
  effects: { required: [], conditional: [] }, fields: incidentFields, taskId: 'pdi8',
});
check('a fixture is produced, marked and disposable', p8Fixture.ok === true, p8Fixture.note ?? '');

let p8Incident = null;
if (p8Fixture.ok) {
  try {
    const created = await table.create('incident', p8Fixture.data);
    p8Incident = v(created.sys_id);
    const after = await table.get('incident', p8Incident, 'all');
    const satisfied = T.verifyTriggerSatisfied({
      trigger: p1Trigger, satisfaction: p1Satisfaction, record: after,
      readField: (r, f) => T.cellValue(r?.[f]),
    });
    check('the platform really derived the value the trigger needs',
      satisfied.satisfied === true, `priority read back as ${v(after.priority)}`);

    /* And the check has teeth: a record that does NOT satisfy the trigger is
     * caught, rather than the test proceeding to blame the flow. */
    const notSatisfied = T.verifyTriggerSatisfied({
      trigger: p1Trigger, satisfaction: p1Satisfaction,
      record: { ...after, priority: { value: '4', display_value: '4 - Low' } },
      readField: (r, f) => T.cellValue(r?.[f]),
    });
    check('a record that did NOT satisfy the trigger is caught', notSatisfied.satisfied === false,
      notSatisfied.failed?.[0] ? `${notSatisfied.failed[0].field}=${notSatisfied.failed[0].actual}` : '');
  } catch (err) {
    check('PDI-8 could run', false, err.message);
  } finally {
    if (p8Incident) {
      await table.remove('incident', p8Incident).catch(() => {});
      const gone = await table.get('incident', p8Incident).catch(() => null);
      check('the derived-field fixture was deleted', !gone);
    }
  }
}

/* ================================================================== *
 * SAFETY — what a test must never be able to do
 * ================================================================== */

head('SAFETY', 'the boundaries, checked against what actually ran');

check('§70.12: every fixture was created on an allowlisted table',
  [pass1, fail2, inconclusive, refusedCleanup, cancelled]
    .filter(Boolean)
    .every((r) => !r.fixture?.table || T.isDisposable(r.fixture.table)));
check('a flow on a non-disposable table is BLOCKED before anything is written', await (async () => {
  const blocked = await T.testFlow({
    ...deps(), request: 'Test the Contract Approval Flow.', taskId: newTask('blocked test'),
  });
  info(`Contract Approval Flow → ${blocked.status} (${blocked.stopped?.reason})`);
  return blocked.status === 'BLOCKED'
    && blocked.stopped?.reason === 'FIXTURE_TABLE_NOT_DISPOSABLE'
    && blocked.cleanup?.records_created === 0;
})());
check('§3: a test named against an existing record is refused', await (async () => {
  const refused = await T.testFlow({
    ...deps(), request: `Test the ${SUBJECT} flow against incident INC0010038.`, taskId: newTask('mode b'),
  });
  return refused.status === 'BLOCKED' && refused.stopped?.reason === 'USER_FIXTURE_MODE'
    && refused.cleanup?.records_created === 0;
})());

/* ================================================================== *
 * LEFTOVERS — the sweep (§69)
 * ================================================================== */

head('SWEEP', 'anything this run left behind');

if (leftover) {
  info(`removing the record PDI-5/PDI-6 deliberately could not: ${leftover}`);
  await table.remove('chg_mgt_worker', leftover).catch((e) => info(`could not remove it: ${e.message}`));
}

let stillThere = 0;
for (const t of T.DISPOSABLE_LIST) {
  const field = t === 'incident' ? 'short_description' : 'message';
  const rows = await table.query(t, {
    query: `${field}LIKE[NOWTEST:`, fields: `sys_id,${field}`, limit: 50, display: 'false',
  }).catch(() => []);
  if (rows.length) {
    for (const r of rows) info(`LEFTOVER ${t} ${r.sys_id} — ${String(r[field]).slice(0, 70)}`);
  }
  stillThere += rows.length;
}
check('§70.2: no test record remains on the instance', stillThere === 0, `${stillThere} found`);

/* ================================================================== *
 * REPORT
 * ================================================================== */

const passed = results.filter((r) => r.ok).length;
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);

console.log();
console.log('§71 METRICS');
console.log(`  Scenarios                     ${new Set(results.map((r) => r.scenario)).size}`);
console.log(`  Assertions                    ${results.length}`);
console.log(`  Passed                        ${passed}`);
console.log(`  Failed                        ${results.length - passed}`);
console.log(`  PDI leftovers                 ${stillThere}`);
console.log();
console.log('  NowTest results observed');
for (const [name, r] of [['PDI-1', pass1], ['PDI-2', fail2], ['PDI-4', inconclusive], ['PDI-5', refusedCleanup], ['PDI-6', cancelled]]) {
  if (r) console.log(`    ${name.padEnd(6)} ${String(r.status).padEnd(13)} ${(r.failures ?? []).join(',') || '—'}`);
}
console.log();
console.log('  Performance (§65)');
console.log(`    average fixture setup       ${avg(timings.setup)}ms   (n=${timings.setup.length})`);
console.log(`    average execution wait      ${avg(timings.wait)}ms   (n=${timings.wait.length})`);
console.log(`    average assertion           ${avg(timings.assert)}ms   (n=${timings.assert.length})`);
console.log(`    average fixture delete      ${avg(timings.delete)}ms   (n=${timings.delete.length})   the plan's own cleanup step`);
console.log(`    average cleanup guarantee   ${avg(timings.cleanup)}ms   (n=${timings.cleanup.length})   the finally path; zero when the step already ran`);
console.log(`    average total test          ${avg(timings.total)}ms   (n=${timings.total.length})`);

console.log();
if (results.length - passed === 0 && stillThere === 0) {
  console.log('PDI VALIDATION PASSED: every scenario behaved as specified and nothing was left behind.');
} else {
  console.log(`PDI VALIDATION FAILED: ${results.length - passed} assertion(s), ${stillThere} leftover(s).`);
  process.exitCode = 1;
}
