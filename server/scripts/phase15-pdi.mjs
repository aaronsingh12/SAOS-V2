/**
 * PHASE 15 — REAL PDI VALIDATION of the diagnostic evidence surfaces.
 *
 *   node scripts/phase15-pdi.mjs
 *
 * §40-§45, against dev424910. Nothing here is mocked and nothing is
 * manufactured: the audit rows come from real edits to a disposable incident,
 * the SLA rows are the ones the platform attached by itself, and the flow
 * executions are the ones it ran.
 *
 * ON §42 (a controlled flow FAILURE). This instance has no flow triggered by
 * `incident`, so an assignment automation cannot be made to fail on demand, and
 * §42 says plainly not to fake one. What it DOES have is real and better than
 * a fake: creating an incident attaches a `task_sla`, which triggers the "SLA
 * notification and escalation flow", which reliably ends in ERROR with the
 * message "Failed to initialize flow context". So the correlation
 * symptom -> record -> SLA -> execution -> ERROR is exercised end to end on
 * genuine rows — and the scenario also checks the thing that matters more, that
 * an error which is NOT relevant to the symptom does not get promoted into an
 * explanation of it.
 *
 * Every record created here is deleted in a finally block.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p15pdi-')), 'p.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const DX = await import('../src/servicenow/diagnostics.js');
const D = await import('../src/agent/doctor/index.js');
const E = await import('../src/agent/doctor/evidence.js');
const { getSettings } = await import('../src/config/store.js');
const { table } = await import('../src/servicenow/client.js');
const { toolMap } = await import('../src/agent/tools.js');

const results = [];
const ok = (id, label, cond, detail) => {
  results.push({ id, ok: Boolean(cond) });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${id.padEnd(6)} ${label}`);
  if (detail) console.log(`          ${detail}`);
};
const note = (id, label, detail) => {
  results.push({ id, ok: true, informational: true });
  console.log(`[NOTE] ${id.padEnd(6)} ${label}`);
  if (detail) console.log(`          ${detail}`);
};

const created = [];
const seed = async (label, fields = {}) => {
  const c = await toolMap.get('create_record').execute(
    { table: 'incident', data: { short_description: `NOWFORGE P15 ${label} — safe to delete`, ...fields } },
    { sessionId: 'p15-pdi', turnSeq: 0 },
  );
  const sysId = c?.sys_id?.value ?? c?.sys_id;
  const number = c?.number?.value ?? c?.number;
  created.push({ sys_id: sysId, number });
  return { sysId, number };
};

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log();

const t0 = process.hrtime.bigint();
const perf = { records: 0, contexts: 0, auditRows: 0, journalRows: 0 };

try {
  /* ============================================================== *
   * §40 — INCIDENT TIMELINE from real data
   * ============================================================== */
  const inc = await seed('timeline');
  console.log(`seeded   : ${inc.number}`);
  await table.update('incident', inc.sysId, { urgency: '1' });
  await wait(1500);
  await table.update('incident', inc.sysId, { work_notes: 'NOWFORGE P15 investigating' });
  await wait(3000);

  const record = await table.get('incident', inc.sysId, 'all');
  const audit = await DX.auditFor({ table: 'incident', sys_id: inc.sysId });
  const journal = await DX.journalFor({ table: 'incident', sys_id: inc.sysId });
  perf.records += 1; perf.auditRows += audit.count; perf.journalRows += journal.count;

  const steps = [
    { id: 'step_1', tool: 'get_record', state: 'completed', inputs: { table: 'incident', sys_id: inc.sysId }, result: record },
    { id: 'step_6', tool: 'get_record_audit', state: 'completed', inputs: { table: 'incident', sys_id: inc.sysId }, result: audit },
    { id: 'step_7', tool: 'get_record_journal', state: 'completed', inputs: { table: 'incident', sys_id: inc.sysId }, result: journal },
  ];
  const facts1 = E.factsFrom(steps);
  const timeline1 = D.buildTimeline(steps, facts1);

  ok('P15-1', 'A real incident timeline is built: creation, changes and notes',
    timeline1.events.some((e) => e.kind === 'record_created')
      && timeline1.events.some((e) => e.kind === 'field_changed'),
    timeline1.events.map((e) => `${String(e.at).slice(11)} ${e.label}`).join(' | ').slice(0, 220));

  ok('P15-1b', 'It is ordered, and every entry references a fact',
    timeline1.events.every((e) => e.fact_id)
      && timeline1.events.filter((e) => e.epoch !== null)
        .every((e, i, a) => i === 0 || a[i - 1].epoch <= e.epoch),
    `${timeline1.timed} timed, ${timeline1.untimed} untimed, span ${JSON.stringify(timeline1.span)}`);

  /* ============================================================== *
   * §43 — AUDIT: field, old, new, when, who
   * ============================================================== */
  const urgency = audit.changes.find((c) => c.field === 'urgency');
  ok('P15-2', 'Audit gives field, old value, new value, actor and time from the real instance',
    Boolean(urgency) && urgency.old_value === '3' && urgency.new_value === '1'
      && Boolean(urgency.changed_by) && Boolean(urgency.changed_at),
    urgency ? `${urgency.field}: "${urgency.old_value}" -> "${urgency.new_value}" by ${urgency.changed_by} at ${urgency.changed_at}`
      : `no urgency change among ${audit.count} audited change(s)`);

  const derived = audit.changes.find((c) => c.field === 'priority');
  ok('P15-2b', 'It also captures a change the PLATFORM made that we never wrote',
    Boolean(derived),
    derived ? `priority: "${derived.old_value}" -> "${derived.new_value}" — computed from impact + urgency, never sent by us`
      : 'no platform-computed change was audited');

  ok('P15-2c', 'The audited-fields-only caveat travels with the result',
    audit.audited_fields_only === true,
    'an empty audit means no AUDITED field changed, not that nothing changed');

  /* ============================================================== *
   * §11 — JOURNAL, as authorship rather than state
   * ============================================================== */
  const noteFact = facts1.find((f) => String(f.field).startsWith('journal_'));
  ok('P15-3', 'A work note is recorded as something a person WROTE',
    Boolean(noteFact) && /wrote in/.test(noteFact.statement) && noteFact.causal === false,
    noteFact ? noteFact.statement.slice(0, 140) : `no journal fact among ${journal.count} entries`);

  /* ============================================================== *
   * §44 — SLA, real rows only
   * ============================================================== */
  const slas = await DX.slasFor({ task_sys_id: inc.sysId });
  ok('P15-4', 'The runtime SLA state is read from the rows the platform attached',
    slas.attached && slas.slas.every((s) => s.stage !== DX.SLA_UNKNOWN),
    slas.attached
      ? slas.slas.map((s) => `${s.definition.name}: ${s.stage} (breached=${s.has_breached})`).join(' | ')
      : 'no SLA attached');

  ok('P15-4b', 'SLA stage is taken from the row, never derived from priority',
    slas.slas.every((s) => 'has_breached' in s && 'stage' in s && 'raw_stage' in s),
    'stage and has_breached are separate columns and stay separate');

  /* ============================================================== *
   * §41 / §42 — FLOW EXECUTION, and a REAL failure
   * ============================================================== */
  const direct = await DX.flowExecutionsFor({ table: 'incident', sys_id: inc.sysId });
  ok('P15-5', 'An incident with no automation of its own reports NO_EXECUTION_FOUND',
    direct.found === false && direct.state === DX.NO_EXECUTION,
    `state=${direct.state} — an absence, explicitly not a failure`);

  let errored = null;
  if (slas.attached) {
    await wait(2000);
    const viaSla = await DX.flowExecutionsFor({ table: 'task_sla', sys_id: slas.slas[0].sys_id });
    perf.contexts += viaSla.count;
    errored = viaSla.executions.find((x) => x.state === 'EXECUTION_ERROR') ?? null;

    ok('P15-6', 'A REAL flow execution is identified: flow, subject, state and timing',
      viaSla.found && viaSla.executions[0].flow.name && viaSla.executions[0].subject.table === 'task_sla'
        && viaSla.executions[0].started_at,
      viaSla.found
        ? `${viaSla.executions[0].flow.name} state=${viaSla.executions[0].state} started=${viaSla.executions[0].started_at}`
        : 'no execution found for the SLA');

    ok('P15-7', 'A REAL flow ERROR is correlated to the record through its SLA',
      Boolean(errored) && Boolean(errored.error),
      errored ? `${errored.flow.name}: ${JSON.stringify(errored.error)}`
        : 'no errored execution — this instance did not produce one this run');
  }

  note('P15-8', 'PDI capability: no flow on this instance is triggered by `incident`',
    'An assignment automation cannot be made to fail on demand here, so §42 is exercised with the '
    + 'real SLA-flow failure above rather than a manufactured one. No sys_flow_context row was created by this script.');

  /* ============================================================== *
   * §42 — THE HARDER HALF: an irrelevant failure must not explain the symptom
   * ============================================================== */
  if (errored) {
    const flowStep = {
      id: 'step_9', tool: 'find_flow_executions', state: 'completed',
      inputs: { table: 'task_sla', sys_id: slas.slas[0].sys_id },
      result: { subject: { table: 'task_sla', sys_id: slas.slas[0].sys_id }, found: true, state: 'EXECUTION_ERROR', count: 1, truncated: false, executions: [errored] },
    };
    const allSteps = [...steps, flowStep];
    const facts = E.factsFrom(allSteps);
    const symptomFactIds = D.symptomFactIdsOf({ field: 'assigned_to' }, facts);
    const causalFactIds = D.causalFactIdsOf(facts);
    const errFact = facts.find((f) => f.field === 'flow_execution_error');

    const hyp = D.adjudicate([{
      id: 'hyp_1',
      statement: 'The assignment automation failed, which is why nobody is assigned.',
      evidence_for: [symptomFactIds[0], errFact?.id].filter(Boolean),
      evidence_against: [], missing_evidence: [],
    }], { symptomFactIds, causalFactIds, facts })[0];

    const verdict = D.classify({
      hypotheses: [hyp], completedReads: allSteps.length,
      symptomConfirmed: true, symptomCheckedDeterministically: true,
    });

    ok('P15-9', 'A real flow ERROR does NOT become a root cause just by being nearby',
      verdict.outcome !== D.OUTCOMES.ROOT_CAUSE_ESTABLISHED
        || errFact?.value?.includes('assign'),
      `the SLA-flow error is real but says ${JSON.stringify(errFact?.value)}; `
      + `verdict = ${verdict.outcome} (${hyp.support_level})`);
  }

  /* ============================================================== *
   * §45 — A QUESTION THIS BUILD CANNOT ANSWER
   * ============================================================== */
  {
    /*
     * Business-rule execution is not exposed by any capability here. The
     * honest answer is that nothing is known, and it must be reachable without
     * inventing a mechanism.
     */
    const facts = E.factsFrom(steps);
    const causalFactIds = D.causalFactIdsOf(facts);
    const hyp = D.adjudicate([{
      id: 'hyp_1', statement: 'A business rule cleared the assignment.',
      evidence_for: [], evidence_against: [], missing_evidence: ['business rule execution history'],
    }], { causalFactIds, facts })[0];
    const verdict = D.classify({
      hypotheses: [hyp], completedReads: steps.length, unknownCount: 1,
      symptomConfirmed: true, symptomCheckedDeterministically: true,
    });
    ok('P15-10', 'A question about an unexposed subsystem ends in insufficient evidence',
      [D.OUTCOMES.INSUFFICIENT_EVIDENCE, D.OUTCOMES.INVESTIGATION_BLOCKED].includes(verdict.outcome),
      `${verdict.outcome} — ${verdict.reason}`);
  }

  /* ============================================================== *
   * §55 — SECRETS IN REAL FREE TEXT
   * ============================================================== */
  {
    const { redact } = await import('../src/agent/evidence/redact.js');
    const withSecret = { error: `connect failed: password=hunter2 for ${inc.number}` };
    const cleaned = JSON.stringify(redact(withSecret));
    ok('P15-11', 'A credential named in an error message is redacted before it reaches evidence',
      !cleaned.includes('hunter2') && cleaned.includes(inc.number),
      cleaned);
  }

  /* ============================================================== *
   * §19 — NO INSTANCE-WIDE QUERIES
   * ============================================================== */
  {
    const asked = [];
    const real = table.query;
    table.query = async (t, opts = {}) => { asked.push({ t, q: opts.query ?? '' }); return real(t, opts); };
    try {
      await DX.flowExecutionsFor({ table: 'incident', sys_id: inc.sysId });
      await DX.auditFor({ table: 'incident', sys_id: inc.sysId });
      await DX.journalFor({ table: 'incident', sys_id: inc.sysId });
      await DX.slasFor({ task_sys_id: inc.sysId });
    } finally { table.query = real; }
    ok('P15-12', 'Every diagnostic query names the subject record',
      asked.length > 0 && asked.every((a) => a.q.includes(inc.sysId)),
      asked.map((a) => `${a.t}: ${a.q.slice(0, 46)}`).join(' | '));
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

console.log();
console.log('§56 measured (no optimisation attempted):');
console.log(`  records read        ${perf.records}`);
console.log(`  flow contexts read  ${perf.contexts}`);
console.log(`  audit rows read     ${perf.auditRows}`);
console.log(`  journal rows read   ${perf.journalRows}`);
console.log(`  total               ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)}s`);

console.log();
const pass = results.filter((r) => r.ok).length;
const informational = results.filter((r) => r.informational).length;
console.log(`REAL PDI — pass ${pass}  fail ${results.length - pass}  of ${results.length}`
  + `${informational ? ` (${informational} informational)` : ''}`);
