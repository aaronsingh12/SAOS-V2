/**
 * PHASE 16 — REAL PDI VALIDATION of NowLint.
 *
 *   node scripts/phase16-pdi.mjs
 *
 * §48-§53 against dev424910. Every flow linted here is a real, pre-existing,
 * published flow, and nothing is modified — §48 says not to touch important
 * flows, and a linter has no business writing to the thing it is inspecting.
 *
 * ON §50 (a flow with a nonexistent field). Flow authoring is UNAVAILABLE on
 * this machine — capability discovery reports `flow_authoring` unavailable with
 * `mechanism_unknown`, because the ServiceNow SDK is not installed and
 * authenticated here — so a disposable flow containing a deliberate defect
 * cannot be created. §50 is explicit about what to do then: record the
 * behaviour and test the rule against a captured live-valid artifact
 * representation, and do not fake successful ServiceNow behaviour. That is what
 * PDI-2 does, using the exact artifact shape read back from this instance, with
 * the field names checked against this instance's real dictionary.
 *
 * No records are created, so there is nothing to clean up. The final sweep
 * proves it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p16pdi-')), 'p.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const A = await import('../src/servicenow/flow-artifact.js');
const L = await import('../src/agent/lint/index.js');
const { getSchema } = await import('../src/servicenow/schema.js');
const { table } = await import('../src/servicenow/client.js');
const { derivationOf } = await import('../src/servicenow/semantic/tables.js');
const { discoverAll } = await import('../src/agent/capability-discovery.js');
const { getSettings } = await import('../src/config/store.js');
const { flows } = await import('../src/servicenow/flows.js');

const results = [];
const ok = (id, label, cond, detail) => {
  results.push({ id, ok: Boolean(cond) });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${id.padEnd(7)} ${label}`);
  if (detail) console.log(`           ${detail}`);
};
const note = (id, label, detail) => {
  results.push({ id, ok: true, informational: true });
  console.log(`[NOTE] ${id.padEnd(7)} ${label}`);
  if (detail) console.log(`           ${detail}`);
};

const discovered = discoverAll({});
const newContext = () => L.makeContext({ getSchema, table, derivationOf, discovered });

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log();

const perf = { lints: 0, ms: 0, schema: 0, records: 0, executions: 0 };
const timed = async (fn) => {
  const t = Date.now();
  const out = await fn();
  perf.lints += 1;
  perf.ms += Date.now() - t;
  return out;
};

try {
  /* ============================================================== *
   * §6 — identification must never guess
   * ============================================================== */
  const ambiguous = await A.findFlow({ name: 'Change' });
  ok('P16-0', 'An ambiguous flow name STOPS instead of choosing one',
    !ambiguous.ok && ambiguous.reason === 'ambiguous' && ambiguous.candidates.length > 1,
    ambiguous.ok ? `it picked "${ambiguous.name}"` : `${ambiguous.candidates.length} candidates offered back`);

  const missing = await A.findFlow({ name: 'A Flow That Does Not Exist Anywhere' });
  ok('P16-0b', 'A name that matches nothing is reported, not invented',
    !missing.ok && missing.reason === 'not_found',
    missing.note);

  /* ============================================================== *
   * §49 / PDI-1 — a real, working flow
   * ============================================================== */
  const candidates = await flows.list({ activeOnly: true, type: 'flow' });
  let subject = null;
  for (const f of candidates) {
    const id = f.sys_id?.value ?? f.sys_id;
    const acts = await table.query('sys_hub_action_instance_v2', {
      query: `flow=${id}`, fields: 'sys_id', limit: 1, display: 'false',
    }).catch(() => []);
    if (acts.length) { subject = { id, name: f.name?.value ?? f.name }; break; }
  }
  if (!subject) throw new Error('no active flow on this instance has readable components');

  console.log(`subject  : ${subject.name}`);
  console.log();

  const artifact = await A.readFlowArtifact(subject.id);
  ok('P16-1a', 'The LIVE artifact is read, not reconstructed',
    artifact.flow.sys_id === subject.id && artifact.actions.length > 0,
    `${artifact.triggers.length} trigger(s), ${artifact.actions.length} action(s), `
    + `${artifact.actions.reduce((n, a) => n + a.inputs.length, 0)} decoded input(s)`);

  ok('P16-1b', 'Action inputs decode out of the gzip blob, with their declarations',
    artifact.actions.some((a) => a.inputs.some((i) => i.type)),
    artifact.actions.flatMap((a) => a.inputs.map((i) => `${i.name}:${i.type}${i.mandatory ? '*' : ''}`))
      .slice(0, 6).join(', '));

  const ctx1 = newContext();
  const clean = await timed(() => L.lintFlow(artifact, ctx1));
  perf.schema += ctx1.reads.schema; perf.records += ctx1.reads.records; perf.executions += ctx1.reads.executions;

  const falseAlarms = clean.findings.filter(
    (f) => ['CRITICAL', 'HIGH'].includes(f.severity) && f.kind === 'DEFECT');
  ok('P16-1', 'A real published flow produces no false CRITICAL/HIGH defect',
    falseAlarms.length === 0,
    falseAlarms.length
      ? falseAlarms.map((f) => `${f.rule_id} ${f.title}`).join(' | ')
      : `${clean.rules_run.length}/12 rules ran; findings: `
        + (clean.findings.map((f) => `${f.rule_id}(${f.severity}/${f.kind})`).join(', ') || 'none'));

  ok('P16-1c', 'Every rule ran, and any that could not is named',
    clean.rules_run.length === L.RULE_IDS.length,
    `${clean.rules_run.length}/${L.RULE_IDS.length} rules, ${clean.unknown_checks.length} unavailable check(s)`);

  /* ============================================================== *
   * §50 / PDI-2 — a nonexistent field
   * ============================================================== */
  const authoring = discovered.capabilities.flow_authoring;
  note('P16-2', 'PDI capability: flow authoring is unavailable on this machine',
    `flow_authoring available=${authoring?.available} reason=${authoring?.reason ?? 'n/a'}. `
    + 'A disposable flow with a deliberate defect cannot be created here, so §50\'s fallback is used: '
    + 'the rule is exercised against the artifact shape captured from this instance, with field names '
    + 'checked against this instance\'s live dictionary. No flow was created or modified.');

  /* The captured shape: a real Update Record action, with one field changed. */
  const captured = {
    ...artifact,
    flow: { ...artifact.flow, sys_id: 'captured-shape', name: `${artifact.flow.name} (captured shape)` },
    triggers: [],
    actions: [{
      sys_id: 'captured', order: 1, type_name: 'Update Record', inputs_readable: true,
      inputs: [
        { name: 'table_name', label: 'Table', type: 'table_name', mandatory: true, read_only: false,
          reference: null, depends_on: null, supplied: 'incident', display: 'Incident',
          is_pill: false, empty: false, declared: true, children: [] },
        { name: 'values', label: 'Fields', type: 'template_value', mandatory: true, read_only: false,
          reference: null, depends_on: null,
          supplied: 'short_description=ok^nowlint_field_that_does_not_exist=x^priority=1',
          display: null, is_pill: false, empty: false, declared: true, children: [] },
      ],
    }],
  };
  const ctx2 = newContext();
  const onCaptured = await timed(() => L.lintFlow(captured, ctx2));
  perf.schema += ctx2.reads.schema; perf.records += ctx2.reads.records;

  const f001 = onCaptured.findings.find((f) => f.rule_id === 'FLOW001');
  ok('P16-2a', 'FLOW001 CONFIRMS a nonexistent field against the LIVE dictionary',
    Boolean(f001) && f001.status === 'CONFIRMED' && f001.severity === 'CRITICAL'
      && f001.evidence.some((e) => e.source === 'live_schema'),
    f001 ? `${f001.title} — evidence: ${f001.evidence.map((e) => e.source).join(', ')}` : 'not detected');

  ok('P16-2b', 'And it does NOT flag the real fields beside it',
    !onCaptured.findings.some((f) => f.rule_id === 'FLOW001' && /short_description/.test(f.title)),
    'short_description exists on incident and was left alone');

  /* ============================================================== *
   * §51 / PDI-3 — a non-writable field, on real instance semantics
   * ============================================================== */
  const f002 = onCaptured.findings.find((f) => f.rule_id === 'FLOW002')
    ?? onCaptured.findings.find((f) => f.merged?.some((m) => m.rule_id === 'FLOW002'));
  ok('P16-3', 'FLOW002 reports `priority` using the instance semantic evidence',
    Boolean(f002) && f002.evidence.some((e) => e.source === 'semantic_fact' || e.source === 'live_schema'),
    f002 ? `${f002.rule_id} ${f002.title} (${f002.status}) — ${f002.recommendation?.statement}` : 'not detected');

  ok('P16-3b', 'It is LIKELY rather than CONFIRMED, because the authority is semantic',
    !f002 || f002.status === 'LIKELY' || f002.merged?.some((m) => m.rule_id === 'FLOW002'),
    f002 ? `status=${f002.status}` : 'n/a');

  /* ============================================================== *
   * §52 / PDI-4 — execution correlation, with Phase 15 relevance discipline
   * ============================================================== */
  const errored = await table.query('sys_flow_context', {
    query: 'state=ERROR^ORDERBYDESCsys_created_on', fields: 'flow,name,error_message', limit: 1, display: 'false',
  }).catch(() => []);

  if (errored.length && errored[0].flow) {
    const failingFlowId = errored[0].flow;
    const ctx4 = newContext();
    const history = await ctx4.executionsOf(failingFlowId);
    perf.executions += ctx4.reads.executions;
    ok('P16-4', 'A real flow execution history is correlated to the flow that ran it',
      Array.isArray(history) && history.some((h) => h.state === 'EXECUTION_ERROR'),
      Array.isArray(history)
        ? `${history.length} execution(s), ${history.filter((h) => h.state === 'EXECUTION_ERROR').length} in ERROR: `
          + JSON.stringify(history.find((h) => h.error)?.error ?? null)
        : 'history unreadable');

    /*
     * §52's harder half, and the Phase 15 discipline it points at: an execution
     * error is evidence about THIS flow, and FLOW008 says so — a RISK backed by
     * execution evidence. It does not become a claim about any particular
     * field, step or symptom, because nothing establishes that link.
     */
    const withHistory = { ...captured, flow: { ...captured.flow, sys_id: failingFlowId } };
    const ctx4b = newContext();
    const linted = await timed(() => L.lintFlow(withHistory, ctx4b));
    const f008 = linted.findings.find((f) => f.rule_id === 'FLOW008');
    ok('P16-4b', 'The failure becomes a RISK about the flow, not a cause for a field',
      Boolean(f008) && f008.kind === 'RISK'
        && !f008.evidence.some((e) => e.source === 'live_schema'),
      f008 ? `${f008.title} — evidence sources: ${[...new Set(f008.evidence.map((e) => e.source))].join(', ')}`
        : 'FLOW008 did not fire');
  } else {
    note('P16-4', 'No errored flow execution exists on this instance right now',
      'Execution correlation could not be exercised against live history this run.');
  }

  /* ============================================================== *
   * §53 / PDI-5 — a check the instance cannot answer
   * ============================================================== */
  const unknowable = {
    ...artifact,
    flow: { ...artifact.flow, sys_id: 'unknowable' },
    triggers: [],
    actions: [{
      sys_id: 'u1', order: 1, type_name: 'Update Record', inputs_readable: true,
      inputs: [
        { name: 'table_name', label: 'Table', type: 'table_name', mandatory: true, read_only: false,
          reference: null, depends_on: null, supplied: 'nowlint_no_such_table_exists', display: null,
          is_pill: false, empty: false, declared: true, children: [] },
        { name: 'values', label: 'Fields', type: 'template_value', mandatory: true, read_only: false,
          reference: null, depends_on: null, supplied: 'anything=x', display: null,
          is_pill: false, empty: false, declared: true, children: [] },
      ],
    }],
  };
  const ctx5 = newContext();
  const unknownRun = await timed(() => L.lintFlow(unknowable, ctx5));
  const unknownForField = unknownRun.unknown_checks.filter((u) => u.rule_id === 'FLOW001');
  ok('P16-5', 'A check the instance cannot answer is UNKNOWN, not PASS and not a failure',
    unknownForField.length > 0
      && !unknownRun.findings.some((f) => f.rule_id === 'FLOW001'),
    unknownForField.length
      ? unknownForField[0].reason
      : `no UNKNOWN was recorded; findings were ${unknownRun.findings.map((f) => f.rule_id).join(', ')}`);

  ok('P16-5b', 'And that run is NOT reported as clean',
    unknownRun.summary.clean === false,
    `clean=${unknownRun.summary.clean}, unknown=${unknownRun.summary.unknown}`);

  /* ============================================================== *
   * §28 — stable identity across runs
   * ============================================================== */
  const ctxA = newContext();
  const ctxB = newContext();
  const runA = await L.lintFlow(captured, ctxA);
  const runB = await L.lintFlow(captured, ctxB);
  ok('P16-6', 'Linting the same artifact twice produces identical finding ids',
    JSON.stringify(runA.findings.map((f) => f.id)) === JSON.stringify(runB.findings.map((f) => f.id))
      && runA.findings.length > 0,
    `${runA.findings.length} finding(s): ${runA.findings.map((f) => f.id.slice(0, 8)).join(', ')}`);

  /* ============================================================== *
   * §60 — redaction of flow evidence
   * ============================================================== */
  const { redact } = await import('../src/agent/evidence/redact.js');
  const cleaned = JSON.stringify(redact(runA));
  ok('P16-7', 'Lint output passes through the existing redactor intact',
    cleaned.includes('FLOW001') && !/password=[^[]/.test(cleaned),
    'the finding survives redaction and carries no bare credential');
} catch (err) {
  console.log();
  console.log(`ABORTED: ${err.message}`);
  console.log(err.stack);
}

/* Nothing was created; prove it. */
console.log();
try {
  const left = await table.query('sys_hub_flow', {
    query: 'nameSTARTSWITHNOWLINT^ORnameSTARTSWITHNOWFORGE', fields: 'sys_id,name', limit: 20, display: 'false',
  });
  console.log(`PDI leftovers (flows this phase could have created): ${left.length}`);
  for (const f of left) console.log(`   ${f.name} ${f.sys_id}`);
} catch (err) {
  console.log(`leftover check failed: ${err.message}`);
}

console.log();
console.log('§58 measured:');
console.log(`  lint runs            ${perf.lints}`);
console.log(`  average latency      ${perf.lints ? (perf.ms / perf.lints / 1000).toFixed(1) : '0'}s`);
console.log(`  schema reads         ${perf.schema}`);
console.log(`  record reads         ${perf.records}`);
console.log(`  execution reads      ${perf.executions}`);

console.log();
const pass = results.filter((r) => r.ok).length;
const info = results.filter((r) => r.informational).length;
console.log(`REAL PDI — pass ${pass}  fail ${results.length - pass}  of ${results.length}`
  + `${info ? ` (${info} informational)` : ''}`);
