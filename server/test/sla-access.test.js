/**
 * Regression proof for Track B — SLA definitions, the SLA assertion, and the
 * ACL analyzer. Entirely offline: no instance, no SDK, no LLM.
 *
 *   node --test server/test/
 *
 * Every case below is a behaviour MEASURED on dev442675 while building this
 * (docs/fluent-research.md §22), not a hypothetical. The ones that matter most
 * are the false greens: an SLA assertion that passes because SOME SLA
 * attached, a breach clock checked against a display value seven hours off, an
 * ACL report that renders "no rules" when the truth is "you cannot see them".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  queryFieldRoots,
  parseQuery,
  splitQuery,
  stripEndMarker,
  sameQuery,
  unparsedClauses,
  validateEncodedQuery,
  derivePayloadFor,
  PRIORITY_INPUTS,
} from '../src/servicenow/conditions.js';
import {
  durationToSeconds,
  secondsToDuration,
  parseDurationInput,
  formatDuration,
  parseSnowUtc,
  assertTaskSla,
  validateSlaInput,
  snowScheduleDateTime,
  normalizeScheduleSpanInput,
  verifyScheduleSpanReadback,
  _slaInternals,
} from '../src/servicenow/sla.js';
import {
  aclReport,
  aclDiff,
  belongsToTable,
  splitAclName,
  detectDegenerateRepetition,
  explainAclReport,
  explanationInput,
} from '../src/servicenow/acl.js';
import { validateSlaAssertion, validateVerifySpec } from '../src/servicenow/fluent.js';

/* ------------------------------------------------------------------ *
 * Fixtures — shaped exactly like what this instance returns.
 * ------------------------------------------------------------------ */

const INCIDENT_SCHEMA = {
  table: 'incident',
  hierarchy: ['incident', 'task'],
  fields: [
    'active', 'priority', 'impact', 'urgency', 'state', 'incident_state', 'hold_reason',
    'short_description', 'description', 'number', 'sys_id', 'work_notes', 'comments',
    'caller_id', 'opened_by', 'resolved_by', 'knowledge', 'watch_list', 'close_notes',
  ].map((name) => ({ name, type: 'string', reference: null }))
    .concat([
      { name: 'assignment_group', type: 'reference', reference: 'sys_user_group' },
      { name: 'assigned_to', type: 'reference', reference: 'sys_user' },
    ]),
};

const schemaFor = async (t) => {
  if (t === 'incident') return INCIDENT_SCHEMA;
  if (t === 'contract_sla') return { table: t, hierarchy: [t], fields: [] };
  throw new Error(`no schema fixture for ${t}`);
};

/** A definition as shapeDefinition() produces it: 4h, no schedule. */
const P1_4H = {
  sys_id: '796fadd5837acf10b939cc65eeaad3ea',
  name: 'P1 resolve in 4h',
  collection: 'incident',
  active: true,
  duration: { raw: '1970-01-01 04:00:00', seconds: 14400, human: '4h' },
  schedule: null,
  schedule_source: 'no_schedule',
  schedule_effective: false,
  conditions: { start: 'active=true^priority=1', stop: 'state=6', pause: '', reset: '', cancel: '' },
};

/** The same definition, bound to 8-5 weekdays. */
const P1_4H_SCHEDULED = {
  ...P1_4H,
  schedule: { sys_id: '08fcd0830a0a0b2600079f56b1adb9ae', name: '8-5 weekdays' },
  schedule_source: 'sla_definition',
  schedule_effective: true,
};

/** display='all' cell. */
const cell = (value, display) => ({ value, display_value: display === undefined ? value : display });

/**
 * One task_sla row, verbatim in shape from the live run: start 11:24:19 UTC,
 * planned end 15:24:19 UTC, and a display_value seven hours behind because the
 * session renders America/Los_Angeles.
 */
const taskSlaRow = ({ sla, start = '2026-08-18 11:24:19', end = '2026-08-18 15:24:19', stage = 'in_progress', breached = 'false', schedule = '', name = 'P1 resolve in 4h' }) => ({
  sys_id: cell('417f2119837acf10b939cc65eeaad3d9'),
  task: cell('497f2119837acf10b939cc65eeaad3b2'),
  sla: cell(sla, name),
  stage: cell(stage),
  start_time: cell(start, shiftHours(start, -7)),
  planned_end_time: cell(end, shiftHours(end, -7)),
  has_breached: cell(breached),
  schedule: cell(schedule, schedule ? '8-5 weekdays' : ''),
  timezone: cell('America/Los_Angeles'),
});

function shiftHours(stamp, hours) {
  const ms = Date.parse(`${stamp.replace(' ', 'T')}Z`) + hours * 3600_000;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/* ================================================================== *
 * conditions.js — the shared encoded-query parser
 * ================================================================== */

test('the parser survives the operator forms this instance actually stores', () => {
  // Both were mis-parsed before the extraction: the space form matched nothing
  // at all, and the no-space form backtracked into a field name that cannot
  // exist. Either way the field went unchecked, which is trap #2 one level up.
  assert.deepEqual(queryFieldRoots('incident_stateNOT IN7,8^EQ'), ['incident_state']);
  assert.deepEqual(queryFieldRoots('incident_stateNOTIN7,8'), ['incident_state']);
  const [clause] = parseQuery('incident_stateNOT IN7,8');
  assert.equal(clause.field, 'incident_state');
  assert.equal(clause.op, 'NOT IN');
  assert.equal(clause.value, '7,8');
});

test('ORDERBY is not eaten by the OR joiner', () => {
  // `^ORDERBYnumber` starts with the OR joiner as far as a naive split cares.
  assert.deepEqual(queryFieldRoots('assignment_group.name=Hardware^ORDERBYnumber'), ['assignment_group']);
  assert.deepEqual(unparsedClauses('assignment_group.name=Hardware^ORDERBYnumber'), []);
  assert.deepEqual(unparsedClauses('a=1^ORDERBYDESCnumber'), []);
});

test('the ^EQ end marker is not a clause, and does not make two equal queries differ', () => {
  assert.equal(stripEndMarker('active=true^priority=1^EQ'), 'active=true^priority=1');
  assert.ok(sameQuery('active=true^priority=1^EQ', 'active=true^priority=1'));
  assert.ok(!sameQuery('active=true^priority=1', 'active=true^priority=2'));
  assert.equal(splitQuery('a=1^NQb=2').length, 2);
  assert.equal(splitQuery('a=1^NQb=2')[1].join, 'NQ');
});

test('a condition on a field that does not exist is rejected, not reported clean', async () => {
  const bad = await validateEncodedQuery('incident', 'active=true^prioritee=1', { schemaFor });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unknown, ['prioritee']);
  const good = await validateEncodedQuery('incident', 'active=true^priority=1', { schemaFor });
  assert.equal(good.ok, true);
});

test('an unreadable schema is "not checked", never "checked and fine"', async () => {
  const out = await validateEncodedQuery('nope', 'a=1', { schemaFor });
  assert.equal(out.checked, false);
  assert.equal(out.ok, false);
  assert.match(out.readError, /no schema fixture/);
});

/* ------------------------------------------------------------------ *
 * Deriving a record that satisfies a condition
 * ------------------------------------------------------------------ */

test('priority=1 is derived through impact and urgency, and priority is never written (trap #5)', async () => {
  const out = await derivePayloadFor('incident', 'active=true^priority=1^EQ', { schemaFor });
  assert.deepEqual(out.unsatisfiable, []);
  assert.equal(out.payload.impact, '1');
  assert.equal(out.payload.urgency, '1');
  assert.ok(!('priority' in out.payload), 'priority must never appear in the payload — the platform overwrites it as 4 - Low');
  assert.match(out.notes.join(' '), /CALCULATED/);
  assert.deepEqual(PRIORITY_INPUTS[1], { impact: '1', urgency: '1' });
});

test('an ISNOTEMPTY reference is resolved against the instance, never invented', async () => {
  const out = await derivePayloadFor('incident', 'assignment_groupISNOTEMPTY', {
    schemaFor,
    resolveRef: async (t) => ({ sys_id: 'b'.repeat(32), display: 'Hardware' }),
  });
  assert.equal(out.payload.assignment_group, 'b'.repeat(32));

  const none = await derivePayloadFor('incident', 'assignment_groupISNOTEMPTY', {
    schemaFor,
    resolveRef: async () => null,
  });
  assert.equal(none.unsatisfiable.length, 1);
  assert.match(none.unsatisfiable[0].reason, /no record exists in sys_user_group/);
});

test('a clause with no single satisfying value is named, not guessed at', async () => {
  const out = await derivePayloadFor('incident', 'active=true^zzz_nope=1^stateLIKEx^caller_id=javascript:gs.getUserID()', { schemaFor });
  const reasons = out.unsatisfiable.map((u) => u.reason).join(' | ');
  assert.equal(out.unsatisfiable.length, 3);
  assert.match(reasons, /does not exist on incident/);
  assert.match(reasons, /operator LIKE/);
  assert.match(reasons, /javascript: expression/);
  // The satisfiable half is still derived — the caller decides what to do.
  assert.equal(out.payload.active, 'true');
});

/* ================================================================== *
 * sla.js — the duration codec
 * ================================================================== */

test('duration is an offset from 1970-01-01, with days in the DATE half', () => {
  assert.equal(durationToSeconds('1970-01-01 04:00:00'), 14400);
  assert.equal(durationToSeconds('1970-01-01 00:15:00'), 900);
  // "Priority 4 resolution (2 day)" is stored exactly like this on the instance.
  assert.equal(durationToSeconds('1970-01-03 00:00:00'), 172800);
  assert.equal(durationToSeconds('1970-01-03 04:30:00'), 189000);
  // Reading it as a clock time is the failure this guards: 2 days would read as 0.
  assert.notEqual(durationToSeconds('1970-01-03 00:00:00'), 0);
  assert.equal(durationToSeconds('nonsense'), null);
  assert.equal(durationToSeconds(''), null);
});

test('the codec round-trips', () => {
  for (const s of [0, 900, 14400, 86400, 172800, 189000, 604800]) {
    assert.equal(durationToSeconds(secondsToDuration(s)), s, `round trip failed for ${s}s`);
  }
  assert.equal(secondsToDuration(14400), '1970-01-01 04:00:00');
  assert.equal(secondsToDuration(172800), '1970-01-03 00:00:00');
});

test('durations are accepted in the forms a person types', () => {
  assert.equal(parseDurationInput('4h'), 14400);
  assert.equal(parseDurationInput('90m'), 5400);
  assert.equal(parseDurationInput('2d 4h'), 187200);
  assert.equal(parseDurationInput('4:00:00'), 14400);
  assert.equal(parseDurationInput('1970-01-01 08:00:00'), 28800);
  assert.equal(parseDurationInput('14400'), 14400);
  assert.equal(parseDurationInput(14400), 14400);
  assert.equal(parseDurationInput('sometime next week'), null);
  assert.equal(parseDurationInput(''), null);
  assert.equal(formatDuration(189000), '2d 4h 30m');
});

test('SLA 8h duration readback is 28800 seconds, not zero', () => {
  assert.equal(parseDurationInput('8h'), 28800);
  assert.equal(secondsToDuration(28800), '1970-01-01 08:00:00');
  assert.equal(durationToSeconds('1970-01-01 08:00:00'), 28800);
});

test('fixed SLA payload sets duration and retroactive start field explicitly', () => {
  const payload = _slaInternals.toRecord({
    name: 'Incident Resolution SLA - Moderate',
    collection: 'incident',
    duration: '8h',
    schedule: 's'.repeat(32),
    start_condition: 'active=true^priority=3',
    stop_condition: 'state=6^ORstate=7',
    pause_condition: 'state=3',
    retroactive: true,
    retroactive_pause: true,
    set_start_to: 'opened_at',
    type: 'SLA',
  }, { seconds: 28800, scheduleSource: 'sla_definition' });
  assert.equal(payload.duration, '1970-01-01 08:00:00');
  assert.equal(payload.duration_type, '');
  assert.equal(payload.set_start_to, 'opened_at');
  assert.equal(payload.retroactive, 'true');
  assert.equal(payload.retroactive_pause, 'true');
});

test('schedule span input normalizes to real cmn_schedule_span fields only', () => {
  const payload = normalizeScheduleSpanInput({
    schedule: 's'.repeat(32),
    name: 'V3 Mon-Fri 9-6',
    start: '2026-09-21 09:00:00',
    end: '2026-09-21 18:00:00',
    repeat_type: 'weekdays',
    days_of_week: '12345',
    all_day: false,
  });
  assert.deepEqual(payload, {
    schedule: 's'.repeat(32),
    name: 'V3 Mon-Fri 9-6',
    start_date_time: '20260921T090000',
    end_date_time: '20260921T180000',
    repeat_type: 'weekdays',
    repeat_count: '1',
    days_of_week: '1',
    all_day: 'false',
    show_as: 'busy',
    monthly_type: 'dom',
    yearly_type: 'doy',
    override_start_date: '00000000',
    repeat_until: '00000000',
  });
  assert.ok(!('spans' in payload), 'spans must never be sent as a cmn_schedule field');
  assert.equal(snowScheduleDateTime('20260921T090000'), '20260921T090000');
});

test('schedule span input accepts ServiceNow field-name aliases from tool calls', () => {
  const payload = normalizeScheduleSpanInput({
    schedule: 's'.repeat(32),
    start_date_time: '20280907T090000',
    end_date_time: '20280907T180000',
    repeat_type: 'weekdays',
  });
  assert.equal(payload.start_date_time, '20280907T090000');
  assert.equal(payload.end_date_time, '20280907T180000');
});

test('schedule span input accepts the old calendar alias and human weekday list', () => {
  const payload = normalizeScheduleSpanInput({
    all_day: false,
    days_of_week: 'Monday,Tuesday,Wednesday,Thursday,Friday',
    end: '20240101T180000',
    name: 'Weekday Business Hours',
    repeat_count: '1',
    repeat_type: 'weekly',
    calendar: '7076774d83a3c79037f1fcb6feaad314',
    show_as: 'busy',
    start: '20240101T090000',
  });
  assert.equal(payload.schedule, '7076774d83a3c79037f1fcb6feaad314');
  assert.equal(payload.repeat_type, 'weekdays');
  assert.equal(payload.days_of_week, '1');
  assert.equal(payload.start_date_time, '20240101T090000');
  assert.equal(payload.end_date_time, '20240101T180000');
});

test('create schedule lifts top-level span fields instead of sending spans to cmn_schedule', () => {
  const spans = _slaInternals.scheduleSpansFromInput({
    name: 'Weekday Business Hours',
    calendar: '7076774d83a3c79037f1fcb6feaad314',
    start: '20080707T090000',
    end: '20080707T180000',
    repeat_type: 'weekdays',
  });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].calendar, '7076774d83a3c79037f1fcb6feaad314');
  assert.equal(spans[0].start, '20080707T090000');
  assert.ok(!('spans' in spans[0]));
});

test('persisted span readback must have a real sys_id and matching fields', () => {
  const payload = normalizeScheduleSpanInput({
    schedule: 's'.repeat(32), start: '2026-09-21 09:00:00', end: '2026-09-21 18:00:00',
  });
  const ok = verifyScheduleSpanReadback(payload, {
    sys_id: cell('p'.repeat(32)),
    schedule: cell(payload.schedule),
    start_date_time: cell(payload.start_date_time),
    end_date_time: cell(payload.end_date_time),
    repeat_type: cell(payload.repeat_type),
    repeat_count: cell(payload.repeat_count),
    days_of_week: cell(payload.days_of_week),
    all_day: cell(payload.all_day),
    show_as: cell(payload.show_as),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.span.sys_id, 'p'.repeat(32));

  const bad = verifyScheduleSpanReadback(payload, {
    sys_id: cell('p'.repeat(32)),
    schedule: cell(payload.schedule),
    start_date_time: cell(payload.start_date_time),
    end_date_time: cell('2026-09-21 17:00:00'),
    repeat_type: cell(payload.repeat_type),
    repeat_count: cell(payload.repeat_count),
    days_of_week: cell(payload.days_of_week),
    all_day: cell(payload.all_day),
    show_as: cell(payload.show_as),
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.mismatches.map((m) => m.field), ['end_date_time']);
});

test('a synthetic span object with no sys_id is rejected by readback verification', () => {
  const payload = normalizeScheduleSpanInput({
    schedule: 's'.repeat(32), start: '2026-09-21 09:00:00', end: '2026-09-21 18:00:00',
  });
  const out = verifyScheduleSpanReadback(payload, {
    schedule: cell(payload.schedule),
    start_date_time: cell(payload.start_date_time),
    end_date_time: cell(payload.end_date_time),
    repeat_type: cell(payload.repeat_type),
    repeat_count: cell(payload.repeat_count),
    days_of_week: cell(payload.days_of_week),
    all_day: cell(payload.all_day),
    show_as: cell(payload.show_as),
  });
  assert.equal(out.ok, false);
  assert.match(out.mismatches[0].note, /could not be read back/);
});

/* ------------------------------------------------------------------ *
 * Trap #UTC
 * ------------------------------------------------------------------ */

test('ServiceNow datetimes are parsed as UTC, so the display value cannot leak in', () => {
  const utc = parseSnowUtc('2026-08-18 11:24:19');
  assert.equal(new Date(utc).toISOString(), '2026-08-18T11:24:19.000Z');
  // The display half of the same instant on this instance, seven hours behind.
  const display = parseSnowUtc('2026-08-18 04:24:19');
  assert.equal((utc - display) / 3600_000, 7);
  assert.equal(parseSnowUtc('not a date'), null);
  assert.equal(parseSnowUtc(''), null);
});

/* ------------------------------------------------------------------ *
 * The SLA assertion — the false greens
 * ------------------------------------------------------------------ */

const reader = (rows) => async () => rows;

test('a task_sla attached to the RIGHT definition, with a clean breach clock, passes', async () => {
  const out = await assertTaskSla({
    definition: P1_4H,
    taskSysId: '497f2119837acf10b939cc65eeaad3b2',
    expect: { attached: true, stage: 'in_progress', breached: false, plannedEndToleranceSec: 120 },
    readTaskSlas: reader([taskSlaRow({ sla: P1_4H.sys_id })]),
  });
  assert.equal(out.pass, true);
  assert.equal(out.attached, 1);
  assert.equal(out.clock.mode, '24x7');
  assert.equal(out.clock.driftSec, 0);
  assert.equal(out.clock.observedSec, 14400);
});

test('THE false green: other SLAs attached and ours did not — this must FAIL', async () => {
  // Measured live: one P1 incident attached three task_sla rows, ours plus the
  // out-of-box "Priority 1 response (15 minutes)" and "Priority 1 resolution
  // (1 hour)". An assertion that counts rows on the record passes here with
  // the definition under test deleted.
  const out = await assertTaskSla({
    definition: P1_4H,
    taskSysId: '497f2119837acf10b939cc65eeaad3b2',
    expect: { attached: true, plannedEndToleranceSec: 120 },
    readTaskSlas: reader([
      taskSlaRow({ sla: '35420982d732220035ae23c7ce610393', name: 'Priority 1 resolution (1 hour)', end: '2026-08-18 12:24:19' }),
      taskSlaRow({ sla: '2ca94b74c3143200b6dcdfdc64d3ae93', name: 'Priority 1 response (15 minutes)', end: '2026-08-18 11:39:19' }),
    ]),
  });
  assert.equal(out.pass, false);
  assert.equal(out.attached, 0);
  assert.equal(out.others.length, 2);
  // The failure has to name the rivals, or the diagnosis is "nothing happened"
  // when the truth is "the start condition did not match".
  assert.match(out.reason, /2 other SLA\(s\) DID attach/);
  assert.match(out.reason, /Priority 1 resolution \(1 hour\)/);
});

test('the breach clock is computed from the UTC value, never the display value', async () => {
  // If the runner read display_value (04:24:19) and added 4h it would expect
  // 08:24:19 and see 15:24:19 — a seven-hour "drift" on a correct SLA.
  const out = await assertTaskSla({
    definition: P1_4H,
    taskSysId: 'x',
    expect: { attached: true, plannedEndToleranceSec: 120 },
    readTaskSlas: reader([taskSlaRow({ sla: P1_4H.sys_id })]),
  });
  assert.equal(out.pass, true);
  assert.equal(out.task_sla.planned_end_time_utc, '2026-08-18 15:24:19');
  assert.equal(out.task_sla.planned_end_time_display, '2026-08-18 08:24:19');
  assert.notEqual(out.task_sla.planned_end_time_utc, out.task_sla.planned_end_time_display);
});

test('a wrong breach clock fails, and says by how much', async () => {
  const out = await assertTaskSla({
    definition: P1_4H,
    taskSysId: 'x',
    expect: { attached: true, plannedEndToleranceSec: 120 },
    readTaskSlas: reader([taskSlaRow({ sla: P1_4H.sys_id, end: '2026-08-18 12:24:19' })]), // 1h, not 4h
  });
  assert.equal(out.pass, false);
  assert.equal(out.clock.observedSec, 3600);
  assert.equal(out.clock.driftSec, 10800);
  assert.match(out.reason, /expected 4h/);
});

test('the tolerance is honoured — a few seconds of insert latency is not a failure', async () => {
  const late = await assertTaskSla({
    definition: P1_4H, taskSysId: 'x',
    expect: { attached: true, plannedEndToleranceSec: 120 },
    readTaskSlas: reader([taskSlaRow({ sla: P1_4H.sys_id, end: '2026-08-18 15:25:19' })]), // +60s
  });
  assert.equal(late.pass, true);
  const tooLate = await assertTaskSla({
    definition: P1_4H, taskSysId: 'x',
    expect: { attached: true, plannedEndToleranceSec: 30 },
    readTaskSlas: reader([taskSlaRow({ sla: P1_4H.sys_id, end: '2026-08-18 15:25:19' })]),
  });
  assert.equal(tooLate.pass, false);
});

test('a schedule-bound SLA is bounded, not recomputed — asserting 24x7 would fail a correct one', async () => {
  // Measured: 4h against 8-5 weekdays landed 7.84h of wall-clock later. An
  // exact check would report that correct SLA as broken by nearly four hours.
  const out = await assertTaskSla({
    definition: P1_4H_SCHEDULED,
    taskSysId: 'x',
    expect: { attached: true, plannedEndToleranceSec: 120 },
    readTaskSlas: reader([taskSlaRow({
      sla: P1_4H.sys_id, end: '2026-08-18 19:00:00', schedule: '08fcd0830a0a0b2600079f56b1adb9ae',
    })]),
  });
  assert.equal(out.pass, true);
  assert.equal(out.clock.mode, 'scheduled');
  assert.match(out.clock.note, /does not recompute/);
  assert.ok(out.checks.some((c) => c.ok && /schedule/.test(c.what)));
});

test('a schedule-bound SLA whose clock is SHORTER than the duration fails — a schedule can only push it out', async () => {
  const out = await assertTaskSla({
    definition: P1_4H_SCHEDULED,
    taskSysId: 'x',
    expect: { attached: true, plannedEndToleranceSec: 120 },
    readTaskSlas: reader([taskSlaRow({
      sla: P1_4H.sys_id, end: '2026-08-18 13:24:19', schedule: '08fcd0830a0a0b2600079f56b1adb9ae',
    })]),
  });
  assert.equal(out.pass, false);
  assert.match(out.reason, /never shorten/);
});

test('a definition claiming a schedule whose task_sla has none is caught', async () => {
  const out = await assertTaskSla({
    definition: P1_4H_SCHEDULED,
    taskSysId: 'x',
    expect: { attached: true, plannedEndToleranceSec: 120 },
    readTaskSlas: reader([taskSlaRow({ sla: P1_4H.sys_id, end: '2026-08-19 00:00:00', schedule: '' })]),
  });
  assert.equal(out.pass, false);
  assert.match(out.reason, /carries no schedule/);
});

/* ------------------------------------------------------------------ *
 * Spec validation for { "type": "sla" } assertions
 * ------------------------------------------------------------------ */

test('an SLA assertion that does not name its definition is rejected', () => {
  const errs = validateSlaAssertion({ type: 'sla', locate: { bySetupRecord: true }, expect: { plannedEndToleranceSec: 120 } });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /passes even with the definition under test deleted/);
});

test('an SLA assertion with no stated tolerance is rejected', () => {
  const errs = validateSlaAssertion({ type: 'sla', sla: 'P1 resolve in 4h', locate: { bySetupRecord: true }, expect: {} });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /plannedEndToleranceSec is required/);
  // ...but "assert it did NOT attach" needs no clock, so no tolerance is asked for.
  assert.deepEqual(
    validateSlaAssertion({ type: 'sla', sla: 'x', locate: { bySetupRecord: true }, expect: { attached: false } }),
    []
  );
});

test('an SLA assertion must not hand-assert a datetime field', () => {
  const errs = validateSlaAssertion({
    type: 'sla', sla: 'P1 resolve in 4h', field: 'planned_end_time',
    locate: { bySetupRecord: true }, expect: { plannedEndToleranceSec: 120 },
  });
  assert.match(errs.join(' '), /stored in UTC and rendered to the session timezone/);
});

test('a verification spec carrying a valid SLA assertion passes the whole validator', () => {
  const spec = {
    setup: { table: 'incident', payload: { impact: '1', urgency: '1', short_description: 'x' } },
    wait: { flowName: 'Whatever' },
    assert: [{
      type: 'sla', sla: 'P1 resolve in 4h', locate: { bySetupRecord: true },
      expect: { attached: true, stage: 'in_progress', plannedEndToleranceSec: 120 },
      note: 'the P1 resolution clock starts',
    }],
    cleanup: [{ locate: { bySetupRecord: true } }],
  };
  const out = validateVerifySpec(spec);
  assert.deepEqual(out.errors, []);
  assert.equal(out.ok, true);
});

test('an invalid SLA assertion fails the whole validator, so the spec cannot run', () => {
  const spec = {
    setup: { table: 'incident', payload: { impact: '1' } },
    wait: { flowName: 'Whatever' },
    assert: [{ type: 'sla', locate: { bySetupRecord: true }, expect: {} }],
    cleanup: [{ locate: { bySetupRecord: true } }],
  };
  const out = validateVerifySpec(spec);
  assert.equal(out.ok, false);
  assert.equal(out.errors.length, 2); // no definition named, no tolerance stated
});

/* ------------------------------------------------------------------ *
 * validateSlaInput — refusing before anything is written
 * ------------------------------------------------------------------ */

test('an SLA whose start condition names an unknown field is refused BEFORE the write', async () => {
  const out = await validateSlaInput({
    name: 'Bad', collection: 'incident', duration: '4h', start_condition: 'active=true^prioritee=1',
  }, { schemaFor });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /attaches to every record on the table/);
});

test('an SLA with no start condition is refused for the same reason', async () => {
  const out = await validateSlaInput({ name: 'Bad', collection: 'incident', duration: '4h' }, { schemaFor });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /attaches to every record on the table/);
});

test('a schedule set without schedule_source is a WARNING, not a silent no-op', async () => {
  const out = await validateSlaInput({
    name: 'Fine', collection: 'incident', duration: '4h', start_condition: 'priority=1',
    schedule: '08fcd0830a0a0b2600079f56b1adb9ae', schedule_source: 'no_schedule',
  }, { schemaFor });
  assert.equal(out.ok, true);
  assert.match(out.warnings.join(' '), /IGNORES it and the clock runs\s+24x7/);
  assert.match(out.warnings.join(' '), /4\.00h.*7\.84h/s);
});

test('a valid definition validates cleanly, and the duration is decoded', async () => {
  const out = await validateSlaInput({
    name: 'P1 resolve in 4h', collection: 'incident', duration: '4h',
    start_condition: 'active=true^priority=1', stop_condition: 'state=6',
  }, { schemaFor });
  assert.equal(out.ok, true);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.seconds, 14400);
});

test('a duration that is neither a relative type nor parseable is refused', async () => {
  const out = await validateSlaInput({
    name: 'x', collection: 'incident', duration: 'soon', start_condition: 'priority=1',
  }, { schemaFor });
  assert.equal(out.ok, false);
  assert.match(out.errors.join(' '), /duration is required/);
});

/* ================================================================== *
 * acl.js
 * ================================================================== */

const aclRow = ({ id, name, op, opDisplay, type = 'record', active = 'true', admin = 'true', cond = '', script = '', desc = '' }) => ({
  sys_id: cell(id),
  name: cell(name),
  operation: cell(op, opDisplay ?? op),
  type: cell(type),
  active: cell(active),
  admin_overrides: cell(admin),
  advanced: cell(script ? 'true' : 'false'),
  condition: cell(cond),
  script: cell(script),
  description: cell(desc),
  decision_type: cell('allow'),
  security_attribute: cell(''),
  sys_updated_on: cell('2024-01-01 00:00:00'),
});

const INCIDENT_ACLS = [
  aclRow({ id: 'a1', name: 'incident', op: 'read' }),
  aclRow({ id: 'a2', name: 'incident', op: 'write', cond: 'incident_stateNOT IN7,8' }),
  // The measured shape: an extended operation whose sys_id is 32-hex, and only
  // the display value names it.
  aclRow({ id: 'a3', name: 'incident', op: '0997ab83733303005978e4b9cdf6a7b9', opDisplay: 'report_view' }),
  aclRow({ id: 'a4', name: 'incident', op: 'read', script: 'answer = new ApproverUtils().canApproversRead();' }),
  aclRow({ id: 'a5', name: 'incident.short_description', op: 'write' }),
  aclRow({ id: 'a6', name: 'incident.*', op: 'write', active: 'false' }),
  // Trap #2 on an ACL condition: the clause drops, so the rule is BROADER.
  aclRow({ id: 'a7', name: 'incident', op: 'delete', cond: 'incident_statee=7' }),
];
const TASK_ACLS = [aclRow({ id: 'b1', name: 'task', op: 'read' })];

const ROLE_ROWS = [
  { sys_security_acl: cell('a1'), sys_user_role: cell('r-itil', 'itil') },
  { sys_security_acl: cell('a2'), sys_user_role: cell('r-snw', 'sn_incident_write') },
  { sys_security_acl: cell('a3'), sys_user_role: cell('r-admin', 'admin') },
  { sys_security_acl: cell('a5'), sys_user_role: cell('r-itil', 'itil') },
  { sys_security_acl: cell('a7'), sys_user_role: cell('r-admin', 'admin') },
];

const fixtureOptions = {
  schemaFor,
  hierarchyFor: async () => ['incident', 'task'],
  readAcls: async (t) => (t === 'incident' ? INCIDENT_ACLS : t === 'task' ? TASK_ACLS : []),
  readRoles: async (chunk) => ROLE_ROWS.filter((r) => chunk.includes(r.sys_security_acl.value)),
  // Without this the report reaches for sys_security_operation on the live
  // instance and passes on the catch — a test that only looks offline.
  referenceNames: async (t) => (t === 'sys_security_operation'
    ? new Map([['0997ab83733303005978e4b9cdf6a7b9', 'report_view']])
    : new Map()),
};

test('name filtering keeps a different table out of the report', () => {
  assert.ok(belongsToTable('incident', 'incident'));
  assert.ok(belongsToTable('incident.state', 'incident'));
  assert.ok(belongsToTable('incident.*', 'incident'));
  // The measured contamination: 43 incident_task ACLs match STARTSWITH incident.
  assert.ok(!belongsToTable('incident_task', 'incident'));
  assert.ok(!belongsToTable('incident_task.work_notes', 'incident'));
  assert.deepEqual(splitAclName('incident.short_description'), { table: 'incident', field: 'short_description', scope: 'field' });
  assert.deepEqual(splitAclName('incident'), { table: 'incident', field: null, scope: 'record' });
});

test('the report groups record and field ACLs and walks the inheritance chain', async () => {
  const rep = await aclReport('incident', fixtureOptions);
  assert.equal(rep.visibility, 'full');
  assert.equal(rep.complete, true);
  assert.deepEqual(rep.hierarchy, ['incident', 'task']);
  assert.equal(rep.counts.total, 8);
  assert.equal(rep.counts.record, 6);   // 5 on incident + 1 inherited from task
  assert.equal(rep.counts.field, 2);
  assert.equal(rep.counts.inactive, 1);
  assert.equal(rep.counts.scriptGuarded, 1);
  const inherited = rep.recordAcls.find((a) => a.sys_id === 'b1');
  assert.equal(inherited.inherited, true);
  assert.equal(inherited.definedOn, 'task');
});

test('an operation whose sys_id is 32-hex is named from the display value, not printed raw', async () => {
  const rep = await aclReport('incident', fixtureOptions);
  const extended = rep.recordAcls.find((a) => a.sys_id === 'a3');
  assert.equal(extended.operation, 'report_view');
  assert.equal(extended.operationResolved, true);
  assert.ok(rep.operations.includes('report_view'));
  // ...and the core ops, whose sys_id IS the word, come through unchanged.
  assert.ok(rep.operations.includes('read'));
  assert.ok(rep.operations.includes('write'));
});

test('an ACL with no role rows reads as "no role required", never as unknown', async () => {
  const rep = await aclReport('incident', fixtureOptions);
  const noRole = rep.recordAcls.find((a) => a.sys_id === 'a4');
  assert.deepEqual(noRole.roles, []);
  assert.equal(noRole.noRoleRequired, true);
  assert.equal(noRole.rolesUnknown, false);
  assert.ok(rep.matrix.read['(no role required)']);
});

test('an ACL condition on a field that does not exist is flagged — the rule is BROADER than it reads', async () => {
  const rep = await aclReport('incident', fixtureOptions);
  assert.equal(rep.counts.conditionsOnUnknownFields, 1);
  const broad = rep.recordAcls.find((a) => a.sys_id === 'a7');
  assert.deepEqual(broad.conditionCheck.unknown, ['incident_statee']);
  // And a real condition is not flagged.
  assert.equal(rep.recordAcls.find((a) => a.sys_id === 'a2').conditionCheck.ok, true);
});

test('script-guarded rows are flagged, and the script itself is not claimed to be understood', async () => {
  const rep = await aclReport('incident', fixtureOptions);
  const guarded = rep.recordAcls.find((a) => a.hasScript);
  assert.equal(guarded.sys_id, 'a4');
  assert.ok(guarded.scriptLength > 0);
  assert.equal('script' in guarded, false, 'the script body is never shipped as if it had been evaluated');
});

/* ------------------------------------------------------------------ *
 * Read-restricted — the acceptance case
 * ------------------------------------------------------------------ */

test('a REFUSED read renders as visibility:error with an explanation, never as an empty report', async () => {
  const rep = await aclReport('incident', {
    ...fixtureOptions,
    readAcls: async () => { throw Object.assign(new Error('dev442675 rejected the credentials (403)'), { status: 403 }); },
  });
  assert.equal(rep.visibility, 'error');
  assert.equal(rep.complete, false);
  assert.equal(rep.counts.total, 0);
  assert.equal(rep.failures.length, 2); // one per table in the chain
  assert.match(rep.notes.join(' '), /This report is INCOMPLETE/);
  assert.match(rep.notes.join(' '), /themselves ACL-protected/);
});

test('an EMPTY read is separated from a restricted one, and neither says "no ACLs"', async () => {
  // sys_security_acl readable, but nothing for this table: a real absence.
  const empty = await aclReport('some_table', {
    ...fixtureOptions,
    hierarchyFor: async () => ['some_table'],
    readAcls: async () => [],
    probeAnyAcl: async () => true,
  });
  assert.equal(empty.visibility, 'empty');
  assert.equal(empty.complete, true);
  assert.match(empty.notes.join(' '), /real absence rather than a permission problem/);

  // Nothing visible anywhere: a visibility result wearing an absence's clothes.
  const blind = await aclReport('some_table', {
    ...fixtureOptions,
    hierarchyFor: async () => ['some_table'],
    readAcls: async () => [],
    probeAnyAcl: async () => false,
  });
  assert.equal(blind.visibility, 'restricted');
  assert.equal(blind.complete, false);
  assert.match(blind.notes.join(' '), /Do not read this as "some_table has no ACLs"/);
});

test('roles that could not be read are "unknown", not "unrestricted"', async () => {
  const rep = await aclReport('incident', {
    ...fixtureOptions,
    readRoles: async () => { throw new Error('sys_security_acl_role is not readable'); },
  });
  const any = rep.recordAcls[0];
  assert.equal(any.roles, null);
  assert.equal(any.rolesUnknown, true);
  assert.equal(any.noRoleRequired, false, 'an unreadable role list must never read as "open to everyone"');
  assert.match(rep.notes.join(' '), /rather than as unrestricted/);
});

/* ------------------------------------------------------------------ *
 * Diff
 * ------------------------------------------------------------------ */

test('the two-role diff shows real differences, per operation and per field', async () => {
  const report = await aclReport('incident', fixtureOptions);
  const diff = await aclDiff('incident', 'itil', 'sn_incident_write', { report });
  assert.deepEqual(diff.roles, ['itil', 'sn_incident_write']);
  assert.deepEqual(diff.summary.onlyA, ['read']);
  assert.deepEqual(diff.summary.onlyB, ['write']);
  assert.equal(diff.summary.fieldDifferences, 1);
  assert.equal(diff.fields[0].field, 'short_description');
});

test('the diff refuses to be read as an access simulation', async () => {
  const report = await aclReport('incident', fixtureOptions);
  const diff = await aclDiff('incident', 'itil', 'admin', { report });
  assert.match(diff.caveat, /not an evaluation of access/);
  // admin_overrides is why "admin names few rows" is not "admin has less access".
  assert.ok(diff.adminOverrides > 0);
  assert.match(diff.roleNotes.join(' '), /SKIPPED for admin/);
});

test('a diff needs two roles', async () => {
  const report = await aclReport('incident', fixtureOptions);
  await assert.rejects(() => aclDiff('incident', 'itil', '', { report }), /Two role names are required/);
});

/* ------------------------------------------------------------------ *
 * The explanation, and the degeneracy guard
 * ------------------------------------------------------------------ */

/**
 * Captured from the FIRST live run against gpt-oss:120b-cloud. The model
 * opened correctly and then cycled four role names for the rest of the
 * sentence, at HTTP 200, next to a report that was entirely accurate.
 */
const CAPTURED_LOOP =
  'Roles that appear on record ACLs include sn_incident_read, sn_incident_write, itil, itil_admin, ' +
  'problem_coordinator, ml_admin, ml_report_user, public, admin, approval_admin, catalog, maint, ' +
  'sn_change_read, sn_problem_read, sn_request_read, task_editor, problem_task_analyst, ' +
  'sn_incident_comments_write, sn_incident_admin, sn_problem_read, sn_incident_admin, ' +
  'sn_incident_comments_write, sn_incident_read, sn_incident_write, sn_incident_admin, ' +
  'sn_incident_comments_write, sn_incident_write, sn_incident_read, sn_incident_admin, ' +
  'sn_incident_comments_write, sn_incident_write, sn_incident_read, sn_incident_admin, ' +
  'sn_incident_comments_write, sn_incident_write, sn_incident_read, sn_incident_admin, ' +
  'sn_incident_comments_write, sn_incident_write.';

const HEALTHY =
  'The report shows full visibility of the incident ACL set: 143 rules in total, 27 governing whole ' +
  'records and 116 governing individual fields, spread across incident and its parent task. Three are ' +
  'inactive and 17 are guarded by a script, which means the report can say a script decides the outcome ' +
  'but not what it decides. Ninety-nine set admin_overrides and are skipped for administrators entirely. ' +
  'Thirty-two name no role at all, so for those operations the condition and any script are what gate ' +
  'access rather than role membership. No condition names a field that is absent from its table.';

test('the degeneracy guard catches the failure that was actually measured', () => {
  const out = detectDegenerateRepetition(CAPTURED_LOOP);
  assert.equal(out.ok, false);
  assert.equal(out.kind, 'ngram-loop');
  assert.ok(out.repeats >= 3);
  assert.match(out.fragment, /sn_incident_/);
});

test('the guard does not fire on ordinary prose', () => {
  assert.equal(detectDegenerateRepetition(HEALTHY).ok, true);
  assert.equal(detectDegenerateRepetition('short').ok, true);
});

test('the guard catches a single word stuck on repeat', () => {
  // Padded past the 30-token floor on purpose: below it the guard abstains,
  // because three repeated words in a fragment is not evidence of anything.
  const stuck =
    'The report lists every rule that governs this table and the roles named on each of them, and then ' +
    `access is granted ${'access '.repeat(8)}to the roles listed above and nothing else changes.`;
  assert.equal(detectDegenerateRepetition(stuck).ok, false);
  assert.equal(detectDegenerateRepetition('access access access').ok, true, 'too short to judge is not the same as fine');
});

test('a degenerate explanation is retried ONCE with the fragment quoted as evidence', async () => {
  const prompts = [];
  const out = await explainAclReport(
    { table: 'incident', hierarchy: ['incident'], visibility: 'full', counts: {}, operations: [], roles: [], recordAcls: [], fieldAcls: [], notes: [] },
    {
      generate: async ({ user }) => {
        prompts.push(user);
        return prompts.length === 1 ? CAPTURED_LOOP : HEALTHY;
      },
    }
  );
  assert.equal(out.attempts, 2);
  assert.equal(out.text, HEALTHY);
  assert.match(out.retried, /repeats/);
  // A5's rule: the retry must carry evidence, not re-ask the same question.
  assert.notEqual(prompts[0], prompts[1]);
  assert.match(prompts[1], /YOUR PREVIOUS ANSWER WAS REJECTED/);
  assert.match(prompts[1], /sn_incident_/);
});

test('two degenerate attempts are refused loudly, and the refusal protects the report', async () => {
  await assert.rejects(
    () => explainAclReport(
      { table: 'incident', hierarchy: ['incident'], visibility: 'full', counts: {}, operations: [], roles: [], recordAcls: [], fieldAcls: [], notes: [] },
      { generate: async () => CAPTURED_LOOP }
    ),
    (err) => {
      assert.equal(err.status, 422);
      assert.match(err.message, /generation failure, not a finding/);
      assert.match(err.message, /read off the instance and is unaffected/);
      assert.equal(err.detail.attempts.length, 2);
      return true;
    }
  );
});

test('an empty completion is a named failure, not a blank explanation', async () => {
  await assert.rejects(
    () => explainAclReport({ table: 'incident', hierarchy: [], visibility: 'full', counts: {}, operations: [], roles: [], recordAcls: [], fieldAcls: [], notes: [] },
      { generate: async () => '   ' }),
    /returned an empty explanation/
  );
});

test('the explanation input carries the visibility, so a partial report cannot be summarised as complete', async () => {
  const rep = await aclReport('incident', {
    ...fixtureOptions,
    readAcls: async () => { throw new Error('403'); },
  });
  const input = explanationInput(rep);
  assert.equal(input.visibility, 'error');
  assert.ok(input.notes.length > 0);
});
