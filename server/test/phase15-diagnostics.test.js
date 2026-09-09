/**
 * PHASE 15 — THE EVIDENCE SURFACES: normalisation, scoping, budget, timeline.
 *
 * §31's first half. Every fixture below is the shape a REAL instance returned —
 * the flow error text, the audit rows, the two-SLA swap — recorded while
 * building the phase against dev424910, so a test passing here means the
 * normaliser handles what the platform actually sends rather than what would be
 * convenient.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const clientMod = await import('../src/servicenow/client.js');

/* A fake instance that records every query, so scoping can be asserted. */
const asked = [];
const RESPONSES = new Map();
const realQuery = clientMod.table.query;
clientMod.table.query = async (t, opts = {}) => {
  asked.push({ table: t, query: opts.query ?? '', limit: opts.limit });
  const key = `${t}`;
  if (RESPONSES.has(key)) return RESPONSES.get(key);
  return realQuery(t, opts);
};

const D = await import('../src/servicenow/diagnostics.js');
const T = await import('../src/agent/doctor/timeline.js');
const E = await import('../src/agent/doctor/evidence.js');
const I = await import('../src/agent/doctor/investigation.js');

const cell = (v, display) => ({ value: v, display_value: display ?? String(v ?? '') });
const INC = 'a'.repeat(32);
const SLA = 'b'.repeat(32);
const CTX = 'c'.repeat(32);

const reset = () => { asked.length = 0; RESPONSES.clear(); };

/* ================================================================== *
 * §7 — EXECUTION STATE CLASSIFICATION
 * ================================================================== */

test('§7 every state this instance can emit maps to a definite bucket', () => {
  /* The ten values read from sys_choice on the live instance. */
  const measured = ['PRESUMED_INTERRUPTED', 'CANCELLED', 'PAUSED', 'WAITING', 'IN_PROGRESS',
    'PAUSED_IN_DEBUG', 'COMPLETE', 'QUEUED', 'ERROR', 'CONTINUE_SYNC'];
  for (const s of measured) {
    assert.notEqual(D.classifyExecutionState(s), D.EXECUTION_UNKNOWN,
      `${s} is a state this instance emits and must not classify as unknown`);
  }
  assert.equal(D.classifyExecutionState('COMPLETE'), 'EXECUTION_COMPLETE');
  assert.equal(D.classifyExecutionState('ERROR'), 'EXECUTION_ERROR');
  assert.equal(D.classifyExecutionState('WAITING'), 'EXECUTION_WAITING');
  assert.equal(D.classifyExecutionState('QUEUED'), 'EXECUTION_WAITING');
  assert.equal(D.classifyExecutionState('PAUSED'), 'EXECUTION_PAUSED');
  assert.equal(D.classifyExecutionState('CANCELLED'), 'EXECUTION_CANCELLED');
});

test('§7 a state this build does not know becomes UNKNOWN, never a guess', () => {
  assert.equal(D.classifyExecutionState('SOME_FUTURE_STATE'), D.EXECUTION_UNKNOWN);
  assert.equal(D.classifyExecutionState(''), D.EXECUTION_UNKNOWN);
  assert.equal(D.classifyExecutionState(null), D.EXECUTION_UNKNOWN);
});

test('§12 SLA stages map from the instance vocabulary', () => {
  for (const s of ['completed', 'achieved', 'breached', 'cancelled', 'in_progress', 'paused']) {
    assert.notEqual(D.classifySlaStage(s), D.SLA_UNKNOWN, `${s} is a real stage`);
  }
  assert.equal(D.classifySlaStage('breached'), 'SLA_BREACHED');
  assert.equal(D.classifySlaStage('in_progress'), 'SLA_RUNNING');
  assert.equal(D.classifySlaStage('nonsense'), D.SLA_UNKNOWN);
});

/* ================================================================== *
 * §6 — FLOW EXECUTION NORMALISATION
 * ================================================================== */

test('§6 a real flow context normalises to the declared shape', async () => {
  reset();
  RESPONSES.set('sys_flow_context', [{
    sys_id: cell(CTX), name: cell('SLA notification and escalation flow'),
    state: cell('ERROR'), error_message: cell('Failed to initialize flow context'),
    error_state: cell(''), execution_id: cell('ebxVuuyD73LiMkO48V3vFC4aw9pqlPYl'),
    flow: cell('0335e63573333300e289235f04f6a70f'),
    source_table: cell('task_sla'), source_record: cell(SLA),
    sys_created_on: cell('2026-09-04 08:33:34'), sys_updated_on: cell('2026-09-04 08:33:35'),
    run_time: cell('284'), is_test_run: cell('false'),
  }]);
  const r = await D.flowExecutionsFor({ table: 'task_sla', sys_id: SLA });
  assert.equal(r.found, true);
  assert.equal(r.state, 'EXECUTION_ERROR');
  const x = r.executions[0];
  assert.equal(x.state, 'EXECUTION_ERROR');
  assert.equal(x.raw_state, 'ERROR', 'the instance word is kept beside the bucket');
  assert.equal(x.error, 'Failed to initialize flow context');
  assert.deepEqual(x.subject, { table: 'task_sla', sys_id: SLA });
  assert.equal(x.flow.name, 'SLA notification and escalation flow');
  assert.equal(x.run_time_ms, 284);
  // Nothing invented: there is no `ended_at`, because no column proves one.
  assert.ok(!('ended_at' in x), 'the shape must not claim more than the columns do');
});

test('§7/§33 no executions is NO_EXECUTION_FOUND, not a failure', async () => {
  reset();
  RESPONSES.set('sys_flow_context', []);
  const r = await D.flowExecutionsFor({ table: 'incident', sys_id: INC });
  assert.equal(r.found, false);
  assert.equal(r.state, D.NO_EXECUTION);
  assert.equal(r.count, 0);
  assert.notEqual(r.state, 'EXECUTION_ERROR');
});

/* ================================================================== *
 * §19 — QUERY SCOPING
 * ================================================================== */

test('§19 every diagnostic read is scoped to the subject record', async () => {
  reset();
  RESPONSES.set('sys_flow_context', []);
  RESPONSES.set('sys_audit', []);
  RESPONSES.set('sys_journal_field', []);
  RESPONSES.set('task_sla', []);
  RESPONSES.set('cmdb_rel_ci', []);

  await D.flowExecutionsFor({ table: 'incident', sys_id: INC });
  await D.auditFor({ table: 'incident', sys_id: INC });
  await D.journalFor({ table: 'incident', sys_id: INC });
  await D.slasFor({ task_sys_id: INC });
  await D.ciRelationshipsFor({ sys_id: INC });

  assert.ok(asked.length >= 5);
  for (const a of asked) {
    assert.ok(a.query && a.query.length > 0,
      `${a.table} was queried with no scope at all — that is an instance-wide read`);
    assert.ok(a.query.includes(INC),
      `${a.table} was queried without naming the subject: "${a.query}"`);
  }
  // The exact relationships the PDI schema supports.
  assert.ok(asked.some((a) => a.table === 'sys_flow_context' && /source_record=/.test(a.query)));
  assert.ok(asked.some((a) => a.table === 'sys_audit' && /documentkey=/.test(a.query)));
  assert.ok(asked.some((a) => a.table === 'sys_journal_field' && /element_id=/.test(a.query)));
  assert.ok(asked.some((a) => a.table === 'task_sla' && /task=/.test(a.query)));
});

test('§19 a diagnostic read refuses to run without a subject', async () => {
  await assert.rejects(() => D.flowExecutionsFor({ table: 'incident' }), /requires a table and a sys_id/);
  await assert.rejects(() => D.auditFor({ sys_id: INC }), /requires a table and a sys_id/);
  await assert.rejects(() => D.slasFor({}), /requires a task sys_id/);
});

/* ================================================================== *
 * §18 — BUDGET
 * ================================================================== */

test('§18 a caller cannot raise a platform ceiling', async () => {
  reset();
  RESPONSES.set('sys_audit', []);
  await D.auditFor({ table: 'incident', sys_id: INC, limit: 5000 });
  const a = asked.find((x) => x.table === 'sys_audit');
  // One extra row is fetched so truncation is observed rather than guessed.
  assert.equal(a.limit, D.LIMITS.MAX_AUDIT_ROWS + 1,
    'the platform ceiling must clamp whatever was asked for');
});

test('§18/§60.7 truncation is declared, never silent', async () => {
  reset();
  const rows = Array.from({ length: D.LIMITS.MAX_AUDIT_ROWS + 1 }, (_, i) => ({
    sys_id: cell(`s${i}`), documentkey: cell(INC), tablename: cell('incident'),
    fieldname: cell('state'), oldvalue: cell('1'), newvalue: cell('2'),
    user: cell('admin'), sys_created_on: cell('2026-09-04 08:00:00'),
  }));
  RESPONSES.set('sys_audit', rows);
  const r = await D.auditFor({ table: 'incident', sys_id: INC });
  assert.equal(r.truncated, true, 'a full page must be reported as incomplete');
  assert.equal(r.count, D.LIMITS.MAX_AUDIT_ROWS);
  assert.equal(r.limit, D.LIMITS.MAX_AUDIT_ROWS);
});

test('§18 truncation becomes a FACT, so a diagnosis cannot ignore it', () => {
  const facts = E.factsFrom([{
    id: 'step_6', tool: 'get_record_audit', state: 'completed', inputs: { table: 'incident', sys_id: INC },
    result: {
      subject: { table: 'incident', sys_id: INC }, count: 1, truncated: true, limit: 50,
      changes: [{ sys_id: 'c1', field: 'state', old_value: '1', new_value: '2', changed_by: 'admin', changed_at: '2026-09-04 08:00:00' }],
    },
  }]);
  const t = facts.find((f) => f.field === 'evidence_truncated');
  assert.ok(t, 'truncation must be observable in the evidence');
  assert.match(t.statement, /incomplete/);
});

test('§18 the step budget refuses an over-long investigation before it runs', () => {
  const plan = { steps: Array.from({ length: I.BUDGET.MAX_INVESTIGATION_STEPS + 1 }, (_, i) => ({ id: `s${i}` })) };
  const v = I.checkStepBudget(plan);
  assert.equal(v.ok, false);
  assert.equal(v.reason, I.BUDGET_EXHAUSTED);
  assert.ok(I.checkStepBudget({ steps: [{ id: 's1' }] }).ok);
});

test('§18 truncated reads are discoverable from the durable steps', () => {
  const found = I.truncatedReads([
    { id: 'step_6', tool: 'get_record_audit', state: 'completed', result: { truncated: true, limit: 50 } },
    { id: 'step_7', tool: 'get_record_journal', state: 'completed', result: { truncated: false } },
    { id: 'step_8', tool: 'get_task_slas', state: 'failed', result: { truncated: true } },
  ]);
  assert.equal(found.length, 1, 'only completed, truncated reads count');
  assert.equal(found[0].step, 'step_6');
  assert.equal(found[0].reason, I.BUDGET_EXHAUSTED);
});

/* ================================================================== *
 * §9/§11/§12 — AUDIT, JOURNAL, SLA NORMALISATION
 * ================================================================== */

test('§9 audit normalises to field / old / new / who / when', async () => {
  reset();
  RESPONSES.set('sys_audit', [{
    sys_id: cell('c1'), documentkey: cell(INC), tablename: cell('incident'),
    fieldname: cell('urgency'), oldvalue: cell('3'), newvalue: cell('1'),
    user: cell('admin'), sys_created_on: cell('2026-09-04 08:40:36'),
  }]);
  const r = await D.auditFor({ table: 'incident', sys_id: INC });
  assert.deepEqual(r.changes[0], {
    sys_id: 'c1', table: 'incident', record_sys_id: INC, field: 'urgency',
    old_value: '3', new_value: '1', changed_by: 'admin', changed_at: '2026-09-04 08:40:36',
  });
  assert.equal(r.audited_fields_only, true,
    'an empty audit means no AUDITED field changed, and the caveat must travel with the result');
});

test('§11 a journal entry is attributed authorship, never turned into state', async () => {
  reset();
  RESPONSES.set('sys_journal_field', [{
    sys_id: cell('j1'), element: cell('work_notes'), element_id: cell(INC),
    value: cell('Waiting for the network team'), sys_created_by: cell('admin'),
    sys_created_on: cell('2026-09-04 08:40:35'),
  }]);
  const r = await D.journalFor({ table: 'incident', sys_id: INC });
  const e = r.entries[0];
  assert.equal(e.element, 'work_notes');
  assert.equal(e.value, 'Waiting for the network team');
  // There is nowhere in the shape to put a resolved field, which is the point.
  assert.ok(!('assignment_group' in e) && !('field' in e));

  const facts = E.factsFrom([{
    id: 'step_7', tool: 'get_record_journal', state: 'completed', inputs: { table: 'incident', sys_id: INC },
    result: r,
  }]);
  const f = facts.find((x) => x.field === 'journal_work_notes');
  assert.match(f.statement, /admin wrote in work_notes/,
    'the fact must state who wrote it, not assert what it says');
  assert.equal(f.causal, false, 'what somebody typed is not an event that changed the record');
});

test('§12 SLA state comes from the row, never from priority', async () => {
  reset();
  RESPONSES.set('task_sla', [{
    sys_id: cell(SLA), task: cell(INC), sla: cell('sla1', 'Priority 3 resolution (1 day)'),
    stage: cell('breached'), has_breached: cell('true'), active: cell('true'),
    start_time: cell('2026-09-04 08:00:00'), end_time: cell(''), planned_end_time: cell('2026-09-05 08:00:00'),
    percentage: cell('100'), business_percentage: cell('100'), time_left: cell(''), pause_time: cell(''),
  }]);
  const r = await D.slasFor({ task_sys_id: INC });
  assert.equal(r.attached, true);
  assert.equal(r.slas[0].stage, 'SLA_BREACHED');
  assert.equal(r.slas[0].has_breached, true);
  assert.equal(r.slas[0].definition.name, 'Priority 3 resolution (1 day)');
  // stage and has_breached are separate columns and stay separate.
  assert.ok('stage' in r.slas[0] && 'has_breached' in r.slas[0]);
});

test('§12 no SLA attached is its own answer', async () => {
  reset();
  RESPONSES.set('task_sla', []);
  const r = await D.slasFor({ task_sys_id: INC });
  assert.equal(r.attached, false);
  assert.equal(r.state, D.SLA_NOT_ATTACHED);
});

/* ================================================================== *
 * §10/§24 — TIMELINE
 * ================================================================== */

const timelineSteps = () => [
  {
    id: 'step_1', tool: 'get_record', state: 'completed', inputs: { table: 'incident' },
    result: { sys_id: cell(INC), number: cell('INC0010086'), sys_created_on: cell('2026-09-04 08:59:40') },
  },
  {
    id: 'step_6', tool: 'get_record_audit', state: 'completed', inputs: { table: 'incident' },
    result: {
      changes: [
        { sys_id: 'c1', field: 'urgency', old_value: '3', new_value: '1', changed_by: 'admin', changed_at: '2026-09-04 08:59:51' },
        { sys_id: 'c2', field: 'priority', old_value: '4', new_value: '3', changed_by: 'admin', changed_at: '2026-09-04 08:59:51' },
      ],
    },
  },
  {
    id: 'step_9', tool: 'find_flow_executions', state: 'completed', inputs: { table: 'task_sla' },
    result: {
      executions: [{
        sys_id: CTX, flow: { name: 'SLA notification and escalation flow' },
        state: 'EXECUTION_ERROR', error: 'Failed to initialize flow context',
        started_at: '2026-09-04 08:59:55', last_updated_at: '2026-09-04 08:59:56',
      }],
    },
  },
];

test('§10 the timeline orders real events oldest first', () => {
  const t = T.buildTimeline(timelineSteps(), []);
  const times = t.events.map((e) => e.at);
  assert.deepEqual([...times].sort(), times, 'the timeline is not in order');
  assert.equal(t.events[0].kind, T.EVENT_KINDS.RECORD_CREATED);
  assert.equal(t.events[t.events.length - 1].label, 'SLA notification and escalation flow reached EXECUTION_ERROR');
});

test('§10 events in the same second are grouped, not invented into an order', () => {
  const t = T.buildTimeline(timelineSteps(), []);
  assert.equal(t.simultaneous.length, 1);
  assert.deepEqual(t.simultaneous[0].labels.sort(), ['priority changed', 'urgency changed']);
});

test('§24 the timeline expresses ORDER and has no way to express cause', () => {
  const t = T.buildTimeline(timelineSteps(), []);
  const first = t.events[0];
  const last = t.events[t.events.length - 1];
  assert.equal(T.relate(first, last), 'before');
  assert.equal(T.relate(last, first), 'after');
  assert.equal(T.relate(first, first), 'same_instant');

  // No exported function returns a causal claim, and no event carries one.
  assert.deepEqual(Object.keys(T).filter((k) => /caus/i.test(k)), []);
  for (const e of t.events) {
    assert.ok(!('caused' in e) && !('because' in e), 'a timeline event must not carry causation');
  }
});

test('§24 chronology can only RULE OUT, never rule in', () => {
  // The one safe use: something that happened after cannot have caused before.
  assert.equal(T.happenedAfter('2026-09-04 08:59:56', '2026-09-04 08:59:40'), true);
  assert.equal(T.happenedAfter('2026-09-04 08:59:40', '2026-09-04 08:59:56'), false);
  assert.equal(T.happenedAfter(null, '2026-09-04 08:59:56'), null, 'unknown time is unknown, not false');
});

test('an untimed observation is placed last and counted, never sorted to 1970', () => {
  const steps = [...timelineSteps(), {
    id: 'step_7', tool: 'get_record_journal', state: 'completed', inputs: { table: 'incident' },
    result: { entries: [{ sys_id: 'j1', element: 'work_notes', value: 'x', author: 'admin', created_at: null }] },
  }];
  const t = T.buildTimeline(steps, []);
  assert.equal(t.untimed, 1);
  assert.equal(t.events[t.events.length - 1].epoch, null);
});

test('a step that did not complete contributes no events', () => {
  const steps = timelineSteps().map((s) => ({ ...s, state: 'skipped' }));
  assert.equal(T.buildTimeline(steps, []).events.length, 0);
});

/* ================================================================== *
 * §23 — PROVENANCE
 * ================================================================== */

test('§23 every diagnostic fact carries tool, step, table and record', () => {
  const facts = E.factsFrom([{
    id: 'step_9', tool: 'find_flow_executions', state: 'completed',
    inputs: { table: 'task_sla', sys_id: SLA },
    result: {
      subject: { table: 'task_sla', sys_id: SLA }, found: true, state: 'EXECUTION_ERROR',
      count: 1, truncated: false,
      executions: [{ sys_id: CTX, flow: { name: 'f' }, state: 'EXECUTION_ERROR', error: 'boom', started_at: 'x' }],
    },
  }]);
  assert.ok(facts.length > 0);
  for (const f of facts) {
    assert.equal(f.source.step, 'step_9');
    assert.equal(f.source.tool, 'find_flow_executions');
    assert.equal(f.source.table, 'task_sla');
    assert.ok(f.source.sys_id, 'a fact must name the record it came from');
    assert.ok(E.isFact(f));
  }
});

test('§23 every timeline event references a fact id', () => {
  const t = T.buildTimeline(timelineSteps(), []);
  for (const e of t.events) {
    assert.ok(e.fact_id, `a timeline event with no fact reference: ${e.label}`);
    assert.ok(e.source?.step && e.source?.tool);
  }
});

/* ================================================================== *
 * §55 — SECRETS IN FREE TEXT
 * ================================================================== */

test('§55 a credential named in a flow error is redacted', async () => {
  const { redact } = await import('../src/agent/evidence/redact.js');
  const cases = [
    ['auth failed: password=hunter2 while connecting', 'hunter2'],
    ['rejected, api_key: sk-live-abc123456 invalid', 'sk-live-abc123456'],
    ['connect failed (client_secret="abc 123") retrying', 'abc 123'],
    ['Authorization: Basic YWRtaW46aHVudGVy', 'YWRtaW46aHVudGVy'],
  ];
  for (const [text, secret] of cases) {
    const cleaned = JSON.stringify(redact({ error: text }));
    assert.ok(!cleaned.includes(secret), `a secret survived redaction: ${cleaned}`);
  }
});

test('§55 redaction does not mangle the evidence it exists to protect', async () => {
  const { redact } = await import('../src/agent/evidence/redact.js');
  for (const safe of [
    'Failed to initialize flow context',
    `incident ${INC} has assignment_group Network`,
    'the password policy name is Standard',
    'urgency changed from "3" to "1"',
  ]) {
    assert.equal(redact({ e: safe }).e, safe, `redaction damaged innocent text: ${safe}`);
  }
});

test('§55 the Doctor still defines no redactor of its own', () => {
  const dir = new URL('../src/agent/doctor/', import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    assert.ok(!/function\s+redact\b|SECRET_KEYS\s*=/.test(src), `${f} defines its own redaction`);
  }
  const diag = fs.readFileSync(new URL('../src/servicenow/diagnostics.js', import.meta.url), 'utf8');
  assert.ok(!/function\s+redact\b|SECRET_KEYS\s*=/.test(diag), 'diagnostics.js defines its own redaction');
});
