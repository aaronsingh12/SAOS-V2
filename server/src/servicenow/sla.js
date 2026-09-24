import { table } from './client.js';
import { getSchema, referenceLookup } from './schema.js';
import { validateEncodedQuery, unknownFieldMessage, derivePayloadFor, stripEndMarker, sameQuery } from './conditions.js';
import { jsLiteral, runServerScript } from './execution-harness.js';

/**
 * SLA definitions (B-1) and SLA-aware verification (B-2).
 *
 * An SLA definition is `contract_sla`: a table, a set of start/stop/pause
 * conditions as encoded queries, a duration, and optionally a schedule. When a
 * record matches the start condition the platform attaches a `task_sla` row
 * carrying the running clock — `start_time`, `planned_end_time`, `stage`,
 * `has_breached`.
 *
 * Everything in this file was measured against dev442675 before it was
 * written, because four separate behaviours here produce a confidently wrong
 * result rather than an error:
 *
 *   1. `duration` is a glide_duration stored as an OFFSET FROM 1970-01-01,
 *      with whole days carried in the DATE half: 4h is "1970-01-01 04:00:00"
 *      and 2 days is "1970-01-03 00:00:00". Reading it as a clock time gives
 *      the right answer for under a day and a silently wrong one past it.
 *
 *   2. A `schedule` is IGNORED unless `schedule_source` is 'sla_definition'.
 *      Measured: two definitions, same 8-5 weekdays schedule, same 4h
 *      duration, same incident — the one left at 'no_schedule' elapsed exactly
 *      4.00h wall-clock with an empty task_sla.schedule, the other landed at
 *      7.84h. Setting the reference without the source is a schedule that does
 *      nothing, and nothing says so.
 *
 *   3. `task_sla` times are stored in UTC, and the Table API's display_value
 *      is rendered in the session timezone. On this instance those differ by
 *      seven hours, so a breach clock checked against the display value fails
 *      a perfectly correct SLA. Trap #UTC from the ledger, applied: every
 *      calculation here reads the `value` half and parses it as UTC.
 *
 *   4. A task_sla row existing on the record proves NOTHING about which SLA
 *      attached. Measured: one P1 incident attached THREE rows — ours plus the
 *      out-of-box "Priority 1 response (15 minutes)" and "Priority 1
 *      resolution (1 hour)". An assertion that only counts rows passes without
 *      the definition under test existing at all.
 */

const SLA_TABLE = 'contract_sla';
const TASK_SLA_TABLE = 'task_sla';
const SCHEDULE_TABLE = 'cmn_schedule';
const SCHEDULE_SPAN_TABLE = 'cmn_schedule_span';
const HOLIDAY_TABLE = 'cmn_schedule_blackout';
const SPAN_FIELDS = 'sys_id,schedule,name,type,start_date_time,end_date_time,repeat_type,repeat_count,repeat_until,days_of_week,all_day,show_as,monthly_type,yearly_type,override_start_date';
const TIMING_TASK_SLA_FIELDS = [
  'sys_id', 'task', 'sla', 'stage', 'start_time', 'original_breach_time', 'planned_end_time',
  'business_duration', 'business_elapsed_time', 'business_time_left', 'business_percentage',
  'percentage', 'pause_duration', 'schedule', 'timezone',
].join(',');

/* ------------------------------------------------------------------ *
 * Duration codec — behaviour 1 above
 * ------------------------------------------------------------------ */

const EPOCH_DAY = Date.UTC(1970, 0, 1);
const SECONDS_PER_DAY = 86400;

/** "1970-01-03 04:30:00" → 189000 seconds. Null for anything unparseable. */
export function durationToSeconds(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const days = Math.round((Date.UTC(y, mo - 1, d) - EPOCH_DAY) / (SECONDS_PER_DAY * 1000));
  if (days < 0) return null;
  return days * SECONDS_PER_DAY + h * 3600 + mi * 60 + s;
}

/** 189000 → "1970-01-03 04:30:00". The inverse, days carried into the date. */
export function secondsToDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / SECONDS_PER_DAY);
  const rest = total % SECONDS_PER_DAY;
  const date = new Date(EPOCH_DAY + days * SECONDS_PER_DAY * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ` +
    `${p(Math.floor(rest / 3600))}:${p(Math.floor((rest % 3600) / 60))}:${p(rest % 60)}`
  );
}

/** "4h", "90m", "2d 4h", "4:00:00" or a plain number of seconds → seconds. */
export function parseDurationInput(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Math.max(0, Math.floor(input));
  const text = String(input).trim();
  const stored = durationToSeconds(text);
  if (stored !== null) return stored;
  if (/^\d+$/.test(text)) return Number(text);
  const clock = text.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (clock) return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  const units = { d: SECONDS_PER_DAY, h: 3600, m: 60, s: 1 };
  let total = 0;
  let matched = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m|s)\b/gi)) {
    total += Number(m[1]) * units[m[2].toLowerCase()];
    matched = true;
  }
  return matched ? Math.round(total) : null;
}

/** Human form for a report: 14400 → "4h". */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!total) return '0s';
  const parts = [];
  const d = Math.floor(total / SECONDS_PER_DAY);
  const h = Math.floor((total % SECONDS_PER_DAY) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.join(' ');
}

export function snowCompactDateTime(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';
  const m = text.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:[ T]?(\d{2}):?(\d{2}):?(\d{2}))?Z?$/);
  if (!m) return text;
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  return `${y}${mo}${d}T${h}${mi}${s}`;
}

export function snowScheduleDateTime(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';
  return snowCompactDateTime(text);
}

/* ------------------------------------------------------------------ *
 * UTC — behaviour 3 above, trap #UTC from the ledger
 * ------------------------------------------------------------------ */

/**
 * Parse a ServiceNow datetime as UTC.
 *
 * This is the whole of trap #UTC in one function. The platform stores
 * `task_sla.start_time` and `planned_end_time` in UTC and hands back a
 * display_value rendered in the session's timezone; on this instance those are
 * 2026-08-18 11:08:41 and 2026-08-18 04:08:41 for the same instant. A breach
 * clock computed from the display half is out by the offset — seven hours here
 * — and reports a correct SLA as broken. So the ONLY input accepted is the raw
 * value, and it is parsed with an explicit Z.
 */
export function parseSnowUtc(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Raw half of a display='all' cell — never the display half, for datetimes. */
const raw = (cell) => (cell && typeof cell === 'object' ? cell.value : cell);
const shown = (cell) => (cell && typeof cell === 'object' ? (cell.display_value ?? cell.value ?? '') : (cell ?? ''));

/* ------------------------------------------------------------------ *
 * Read
 * ------------------------------------------------------------------ */

const DEF_FIELDS = [
  'sys_id', 'name', 'collection', 'type', 'target', 'active', 'duration', 'duration_type',
  'schedule', 'schedule_source', 'timezone', 'timezone_source', 'retroactive', 'retroactive_pause',
  'start_condition', 'stop_condition', 'pause_condition', 'reset_condition', 'cancel_condition',
  'set_start_to', 'when_to_cancel', 'when_to_resume', 'flow', 'sys_updated_on', 'sys_updated_by',
  // Which application owns the definition — shown as a badge, and it decides
  // which update set a change to it could ever travel in (§33).
  'sys_scope',
].join(',');

/** Shape one contract_sla row for the API, with the duration already decoded. */
function shapeDefinition(r) {
  const seconds = durationToSeconds(raw(r.duration));
  const scheduleId = raw(r.schedule) || null;
  const source = raw(r.schedule_source) || 'no_schedule';
  return {
    sys_id: raw(r.sys_id),
    name: shown(r.name),
    collection: raw(r.collection),
    type: raw(r.type),
    target: raw(r.target),
    active: raw(r.active) === 'true',
    retroactive: raw(r.retroactive) === 'true',
    retroactive_pause: raw(r.retroactive_pause) === 'true',
    duration: { raw: raw(r.duration) || null, seconds, human: seconds === null ? null : formatDuration(seconds) },
    duration_type: raw(r.duration_type) ? { sys_id: raw(r.duration_type), name: shown(r.duration_type) } : null,
    schedule: scheduleId ? { sys_id: scheduleId, name: shown(r.schedule) } : null,
    schedule_source: source,
    // Behaviour 2: a reference that the source does not switch on is inert.
    // Surfaced as a field rather than left for the reader to notice.
    schedule_effective: source === 'sla_definition' && Boolean(scheduleId),
    timezone: raw(r.timezone) || null,
    timezone_source: raw(r.timezone_source) || null,
    conditions: {
      start: stripEndMarker(raw(r.start_condition)),
      stop: stripEndMarker(raw(r.stop_condition)),
      pause: stripEndMarker(raw(r.pause_condition)),
      reset: stripEndMarker(raw(r.reset_condition)),
      cancel: stripEndMarker(raw(r.cancel_condition)),
    },
    when_to_cancel: raw(r.when_to_cancel) || null,
    when_to_resume: raw(r.when_to_resume) || null,
    set_start_to: raw(r.set_start_to) || null,
    flow: raw(r.flow) ? { sys_id: raw(r.flow), name: shown(r.flow) } : null,
    updated: { on: raw(r.sys_updated_on), by: raw(r.sys_updated_by) },
    // The owning application, for the scope badge. display='all' gives the
    // scope NAME in display_value and the sys_id in value; the name is the
    // address a reader can act on.
    scope: raw(r.sys_scope) ? { sys_id: raw(r.sys_scope), name: shown(r.sys_scope) } : null,
  };
}

export async function listSlas({ search = '', collection = '', activeOnly = false, limit = 50 } = {}) {
  const clauses = [];
  if (search) clauses.push(`nameLIKE${search}`);
  if (collection) clauses.push(`collection=${collection}`);
  if (activeOnly) clauses.push('active=true');
  clauses.push('ORDERBYname');
  const rows = await table.query(SLA_TABLE, { query: clauses.join('^'), fields: DEF_FIELDS, limit: Math.min(limit, 200) });
  return rows.map(shapeDefinition);
}

export async function getSla(sysId) {
  const r = await table.get(SLA_TABLE, sysId);
  if (!r) throw Object.assign(new Error(`No SLA definition with sys_id ${sysId}.`), { status: 404 });
  return shapeDefinition(r);
}

/** Resolve a definition by exact name, then by sys_id. Ambiguity is loud. */
export async function findSla(nameOrId) {
  const text = String(nameOrId || '').trim();
  if (!text) throw new Error('An SLA name or sys_id is required.');
  if (/^[0-9a-f]{32}$/i.test(text)) return getSla(text);
  const rows = await table.query(SLA_TABLE, { query: `name=${text}`, fields: DEF_FIELDS, limit: 5 });
  if (!rows.length) throw Object.assign(new Error(`No SLA definition named "${text}" on this instance.`), { status: 404 });
  if (rows.length > 1) {
    throw new Error(
      `${rows.length} SLA definitions are named "${text}". Pass a sys_id instead: ` +
      rows.map((r) => raw(r.sys_id)).join(', ')
    );
  }
  return shapeDefinition(rows[0]);
}

/** Choices, schedules and relative-duration types, read live for the UI and the agent. */
export async function slaMeta() {
  const schema = await getSchema(SLA_TABLE);
  const choicesFor = (f) => schema.fields.find((x) => x.name === f)?.choices || [];
  const [schedules, relative] = await Promise.all([
    table.query('cmn_schedule', { query: 'ORDERBYname', fields: 'sys_id,name', limit: 100, display: 'false' }),
    table.query('cmn_relative_duration', { query: 'ORDERBYname', fields: 'sys_id,name', limit: 100, display: 'false' }),
  ]);
  return {
    table: SLA_TABLE,
    type: choicesFor('type'),
    target: choicesFor('target'),
    schedule_source: choicesFor('schedule_source'),
    timezone_source: choicesFor('timezone_source'),
    when_to_cancel: choicesFor('when_to_cancel'),
    when_to_resume: choicesFor('when_to_resume'),
    schedules: schedules.map((s) => ({ sys_id: s.sys_id, name: s.name })),
    durationTypes: relative.map((s) => ({ sys_id: s.sys_id, name: s.name })),
  };
}

/* ------------------------------------------------------------------ *
 * Write
 * ------------------------------------------------------------------ */

const CONDITION_FIELDS = [
  ['start_condition', 'start condition'],
  ['stop_condition', 'stop condition'],
  ['pause_condition', 'pause condition'],
  ['reset_condition', 'reset condition'],
  ['cancel_condition', 'cancel condition'],
];

/**
 * Validate an SLA definition against the live instance BEFORE writing it.
 *
 * Every condition is checked field-by-field against the target table's real
 * dictionary. This is the guard that matters most on this table: an SLA whose
 * start condition names a field that does not exist does not fail — the clause
 * is dropped, the condition widens, and the SLA attaches to every record on
 * the table. Nothing on the platform reports that, and the definition looks
 * correct in the UI.
 */
export async function validateSlaInput(input, { schemaFor = getSchema } = {}) {
  const errors = [];
  const warnings = [];
  const name = String(input?.name || '').trim();
  const collection = String(input?.collection || '').trim();

  if (!name) errors.push('name is required.');
  if (!collection) errors.push('collection (the table the SLA runs on) is required.');

  let tableExists = false;
  if (collection) {
    try { await schemaFor(collection); tableExists = true; }
    catch (err) { errors.push(`Table "${collection}" could not be read on this instance: ${err.message}`); }
  }

  const durationType = String(input?.duration_type || '').trim();
  const seconds = parseDurationInput(input?.duration);
  if (!durationType) {
    if (seconds === null) {
      errors.push('duration is required when no duration_type (relative duration) is set. Use "4h", "90m", "2d 4h", "4:00:00", or a number of seconds.');
    } else if (seconds <= 0) {
      errors.push('duration must be greater than zero.');
    }
  } else if (seconds !== null) {
    warnings.push('Both duration_type and duration are set. A relative duration computes the end itself, so the fixed duration is not used.');
  }

  if (tableExists) {
    for (const [field, label] of CONDITION_FIELDS) {
      const q = input?.[field];
      if (!q) continue;
      const check = await validateEncodedQuery(collection, q, { schemaFor });
      if (!check.checked) {
        warnings.push(`The ${label} could not be checked — ${collection}'s schema was unreadable (${check.readError}). It is being sent unverified.`);
        continue;
      }
      if (check.unknown.length) errors.push(unknownFieldMessage(`The ${label}`, collection, check.unknown));
      if (check.unparsed.length) {
        errors.push(
          `The ${label} contains ${check.unparsed.map((u) => `"${u}"`).join(', ')}, which NowHelpAssist could not parse as a ` +
          `condition. It will not be field-checked, and an unchecked clause is exactly where trap #2 hides. ` +
          `Rewrite it in plain encoded-query form.`
        );
      }
    }
  }
  if (!input?.start_condition) {
    errors.push('start_condition is required — an SLA with no start condition attaches to every record on the table.');
  }

  // Behaviour 2, caught before it ships rather than explained afterwards.
  const scheduleSource = input?.schedule_source || (input?.schedule ? 'sla_definition' : 'no_schedule');
  if (input?.schedule && scheduleSource !== 'sla_definition') {
    warnings.push(
      `A schedule is set but schedule_source is "${scheduleSource}", so the platform IGNORES it and the clock runs ` +
      `24x7. Measured on this instance: same schedule, same 4h duration — 4.00h elapsed at "no_schedule" against ` +
      `7.84h at "sla_definition". Set schedule_source to "sla_definition" if the schedule is meant to apply.`
    );
  }
  return { ok: errors.length === 0, errors, warnings, seconds, scheduleSource };
}

/** The contract_sla payload for a validated input. */
function toRecord(input, { seconds, scheduleSource }) {
  const rec = {
    name: String(input.name).trim(),
    collection: String(input.collection).trim(),
    type: input.type || 'SLA',
    active: input.active === false ? 'false' : 'true',
    retroactive: input.retroactive ? 'true' : 'false',
    retroactive_pause: input.retroactive_pause ? 'true' : 'false',
    start_condition: input.start_condition || '',
    stop_condition: input.stop_condition || '',
    pause_condition: input.pause_condition || '',
    schedule_source: scheduleSource,
    schedule: input.schedule || '',
  };
  if (input.target) rec.target = input.target;
  if (input.timezone_source) rec.timezone_source = input.timezone_source;
  if (input.timezone) rec.timezone = input.timezone;
  if (input.when_to_cancel) rec.when_to_cancel = input.when_to_cancel;
  if (input.when_to_resume) rec.when_to_resume = input.when_to_resume;
  if (input.set_start_to) rec.set_start_to = input.set_start_to;
  if (input.duration_type) rec.duration_type = input.duration_type;
  else {
    rec.duration_type = '';
    rec.duration = secondsToDuration(seconds);
  }
  if (input.reset_condition) rec.reset_condition = input.reset_condition;
  if (input.cancel_condition) rec.cancel_condition = input.cancel_condition;
  return rec;
}

/**
 * The read-back, which is the house rule and also trap #3's only defence:
 * writes to a field that does not exist are silently ACCEPTED. Every field we
 * sent is compared against what the instance stored, and a divergence is
 * returned as a named mismatch rather than folded into a success.
 */
function diffAgainstStored(sent, stored) {
  const mismatches = [];
  for (const [field, want] of Object.entries(sent)) {
    if (want === '' || want === undefined) continue;
    const got = raw(stored?.[field]);
    if (got === undefined) {
      mismatches.push({ field, sent: want, stored: null, note: 'the instance did not store this field at all — it is not on contract_sla here' });
      continue;
    }
    const equal = field.endsWith('_condition') ? sameQuery(want, got) : String(got) === String(want);
    if (!equal) mismatches.push({ field, sent: want, stored: got });
  }
  return mismatches;
}

function verifyFixedDuration(input, definition, mismatches) {
  if (input.duration_type) return;
  const wanted = parseDurationInput(input.duration);
  const stored = definition.duration?.seconds;
  if (wanted !== null && stored !== wanted) {
    mismatches.push({
      field: 'duration',
      sent: secondsToDuration(wanted),
      stored: definition.duration?.raw ?? null,
      note:
        `fixed duration read back as ${stored === null ? 'unreadable' : formatDuration(stored)} instead of ${formatDuration(wanted)}; ` +
        'this SLA clock is not safe to verify until the duration stores correctly',
    });
  }
}

export async function createSla(input) {
  const check = await validateSlaInput(input);
  if (!check.ok) {
    throw Object.assign(new Error(`The SLA definition was rejected before anything was written:\n- ${check.errors.join('\n- ')}`), {
      status: 400, detail: { errors: check.errors, warnings: check.warnings },
    });
  }
  const payload = toRecord(input, check);
  const created = await table.create(SLA_TABLE, payload);
  const sysId = raw(created.sys_id);
  const stored = await table.get(SLA_TABLE, sysId);
  const mismatches = diffAgainstStored(payload, stored);
  const definition = shapeDefinition(stored);
  verifyFixedDuration(input, definition, mismatches);
  return {
    ok: mismatches.length === 0,
    status: mismatches.length === 0 ? 'VERIFIED' : 'PARTIAL',
    sys_id: sysId,
    definition,
    warnings: check.warnings,
    mismatches,
    link: await recordLink(SLA_TABLE, sysId),
    message: mismatches.length
      ? `Created ${sysId}, but ${mismatches.length} field(s) did not store what was sent — see mismatches.`
      : `Created SLA definition "${payload.name}" (${sysId}); every field read back as sent.`,
  };
}

export async function updateSla(sysId, patch) {
  const current = await getSla(sysId);
  const merged = {
    name: patch.name ?? current.name,
    collection: patch.collection ?? current.collection,
    type: patch.type ?? current.type,
    target: patch.target ?? current.target,
    active: patch.active ?? current.active,
    retroactive: patch.retroactive ?? current.retroactive,
    retroactive_pause: patch.retroactive_pause ?? current.retroactive_pause,
    duration: patch.duration ?? current.duration.seconds,
    duration_type: patch.duration_type ?? current.duration_type?.sys_id ?? '',
    schedule: patch.schedule ?? current.schedule?.sys_id ?? '',
    schedule_source: patch.schedule_source ?? current.schedule_source,
    timezone: patch.timezone ?? current.timezone ?? '',
    timezone_source: patch.timezone_source ?? current.timezone_source,
    start_condition: patch.start_condition ?? current.conditions.start,
    stop_condition: patch.stop_condition ?? current.conditions.stop,
    pause_condition: patch.pause_condition ?? current.conditions.pause,
    set_start_to: patch.set_start_to ?? current.set_start_to ?? '',
    when_to_cancel: patch.when_to_cancel ?? current.when_to_cancel,
    when_to_resume: patch.when_to_resume ?? current.when_to_resume,
  };
  const check = await validateSlaInput(merged);
  if (!check.ok) {
    throw Object.assign(new Error(`The update was rejected before anything was written:\n- ${check.errors.join('\n- ')}`), {
      status: 400, detail: { errors: check.errors, warnings: check.warnings },
    });
  }
  const payload = toRecord(merged, check);
  await table.update(SLA_TABLE, sysId, payload); 
  const stored = await table.get(SLA_TABLE, sysId);
  const mismatches = diffAgainstStored(payload, stored);
  const definition = shapeDefinition(stored);
  verifyFixedDuration(merged, definition, mismatches);
  return {
    ok: mismatches.length === 0,
    status: mismatches.length === 0 ? 'VERIFIED' : 'PARTIAL',
    sys_id: sysId,
    definition,
    warnings: check.warnings,
    mismatches,
    message: mismatches.length ? `Updated, but ${mismatches.length} field(s) did not store what was sent.` : 'Updated; every field read back as sent.',
  };
}

function scheduleRaw(r) {
  return {
    sys_id: raw(r.sys_id),
    name: shown(r.name),
    time_zone: raw(r.time_zone) || raw(r.timezone) || null,
    type: raw(r.type) || null,
  };
}

function spanRaw(r) {
  return {
    sys_id: raw(r.sys_id),
    schedule: raw(r.schedule),
    name: shown(r.name),
    type: raw(r.type) || null,
    start_date_time: raw(r.start_date_time) || null,
    end_date_time: raw(r.end_date_time) || null,
    repeat_type: raw(r.repeat_type) || '',
    repeat_count: raw(r.repeat_count) || '',
    repeat_until: raw(r.repeat_until) || '',
    days_of_week: raw(r.days_of_week) || '',
    all_day: raw(r.all_day) === 'true',
    show_as: raw(r.show_as) || '',
    monthly_type: raw(r.monthly_type) || '',
    yearly_type: raw(r.yearly_type) || '',
    override_start_date: raw(r.override_start_date) || '',
  };
}

function normalizedBool(v) {
  return v === true || String(v).toLowerCase() === 'true' || String(v) === '1' ? 'true' : 'false';
}

function normalizeDaysOfWeek(v, repeatType) {
  const text = String(v ?? '').trim();
  if (String(repeatType || '').toLowerCase() === 'weekdays') return '1';
  if (!text) return '';
  if (/^\d+$/.test(text)) return text;
  const words = text.split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const weekdayNames = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
  if (String(repeatType || '').toLowerCase() === 'weekdays' && weekdayNames.every((d) => words.includes(d))) return '1';
  const map = { monday: '1', tuesday: '2', wednesday: '3', thursday: '4', friday: '5', saturday: '6', sunday: '7' };
  return words.map((w) => map[w]).filter(Boolean).join('');
}

function normalizeRepeatType(repeatType, daysOfWeek) {
  const text = String(repeatType || '').toLowerCase();
  const days = String(daysOfWeek || '').toLowerCase();
  if (text === 'weekly' && ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].every((d) => days.includes(d))) return 'weekdays';
  return repeatType || '';
}

export function normalizeScheduleSpanInput({
  schedule, calendar, name = '', start, end, start_date_time, end_date_time, repeat_type = 'weekdays', days_of_week = '1',
  repeat_count = '1', repeat_until = '00000000', all_day = false, show_as = 'busy',
  monthly_type = 'dom', yearly_type = 'doy', override_start_date = '00000000',
} = {}) {
  const scheduleId = schedule ?? calendar;
  const from = start ?? start_date_time;
  const to = end ?? end_date_time;
  const normalizedRepeatType = normalizeRepeatType(repeat_type, days_of_week);
  if (!scheduleId) throw Object.assign(new Error('schedule sys_id is required.'), { status: 400 });
  if (!from || !to) throw Object.assign(new Error('start/end or start_date_time/end_date_time are required for a schedule span.'), { status: 400 });
  const payload = {
    schedule: scheduleId,
    name: name || 'NowHelpAssist schedule span',
    start_date_time: snowScheduleDateTime(from),
    end_date_time: snowScheduleDateTime(to),
    repeat_type: normalizedRepeatType,
    repeat_count: String(repeat_count || '1'),
    days_of_week: normalizeDaysOfWeek(days_of_week, normalizedRepeatType),
    all_day: normalizedBool(all_day),
    show_as: show_as || 'busy',
    monthly_type,
    yearly_type,
    override_start_date,
    repeat_until: repeat_until || '00000000',
  };
  return payload;
}

const SPAN_VERIFY_FIELDS = ['schedule', 'start_date_time', 'end_date_time', 'repeat_type', 'days_of_week', 'repeat_count', 'all_day', 'show_as'];

export function verifyScheduleSpanReadback(payload, stored) {
  const span = spanRaw(stored || {});
  const mismatches = [];
  if (!span.sys_id) mismatches.push({ field: 'sys_id', sent: '(created record sys_id)', stored: null, note: 'the created span could not be read back by sys_id' });
  for (const field of SPAN_VERIFY_FIELDS) {
    if (payload[field] === undefined || payload[field] === '') continue;
    const got = field === 'all_day' ? normalizedBool(span[field]) : String(span[field] ?? '');
    const want = field === 'all_day' ? normalizedBool(payload[field]) : String(payload[field]);
    if (got !== want) mismatches.push({ field, sent: want, stored: got });
  }
  return { ok: mismatches.length === 0, span, mismatches };
}

export async function readSchedule(sysId) {
  const schedule = scheduleRaw(await table.get(SCHEDULE_TABLE, sysId));
  const spans = await table.query(SCHEDULE_SPAN_TABLE, {
    query: `schedule=${sysId}^ORDERBYstart_date_time`,
    fields: SPAN_FIELDS,
    limit: 100,
  });
  const holidays = await table.query(HOLIDAY_TABLE, {
    query: `parent=${sysId}^ORDERBYname`,
    fields: 'sys_id,parent,name,time_zone,type',
    limit: 100,
  }).catch(() => []);
  return { ...schedule, spans: spans.map(spanRaw), holidays: holidays.map(scheduleRaw) };
}

const TOP_LEVEL_SPAN_KEYS = new Set([
  'start', 'end', 'start_date_time', 'end_date_time', 'repeat_type', 'days_of_week',
  'repeat_count', 'repeat_until', 'all_day', 'show_as', 'monthly_type', 'yearly_type', 'override_start_date',
]);

function scheduleSpansFromInput(input) {
  if (Array.isArray(input.spans) && input.spans.length) return input.spans;
  if ([...TOP_LEVEL_SPAN_KEYS].some((k) => input[k] !== undefined)) {
    return [Object.fromEntries([...TOP_LEVEL_SPAN_KEYS, 'name', 'schedule', 'calendar'].filter((k) => input[k] !== undefined).map((k) => [k, input[k]]))];
  }
  return [];
}

export async function createSchedule(input = {}) {
  const { name, time_zone, holidays = [], sys_id: existingSysId, schedule, calendar } = input;
  const spans = scheduleSpansFromInput(input);
  const supplied = existingSysId || schedule || calendar;
  if (!supplied && !String(name || '').trim()) throw Object.assign(new Error('schedule name is required.'), { status: 400 });
  let created = null;
  let sysId = supplied || null;
  if (!sysId) {
    try {
      created = await table.create(SCHEDULE_TABLE, { name: String(name).trim() });
      sysId = raw(created?.sys_id);
    } catch (err) {
      return { ok: false, status: 'FAILED', message: err.message, error: err.message };
    }
  }
  const parent = sysId ? scheduleRaw(await table.get(SCHEDULE_TABLE, sysId)) : null;
  if (!parent?.sys_id) {
    return { ok: false, status: 'FAILED', sys_id: sysId || null, message: 'Schedule parent could not be read back.' };
  }
  const timezonePersisted = !time_zone || parent.time_zone === time_zone;
  const timezoneWarning = timezonePersisted ? null : {
    field: 'time_zone',
    sent: time_zone,
    stored: parent.time_zone,
    note: 'The instance did not persist cmn_schedule.time_zone for this schedule; no calendar fallback records were created.',
  };
  const spanResults = [];
  const holidayResults = [];
  for (const sp of spans || []) spanResults.push(await createScheduleSpan({ ...sp, schedule: sysId }).catch((err) => ({ ok: false, status: 'FAILED', error: err.message, attempted: { ...sp, schedule: sysId } })));
  for (const h of holidays || []) holidayResults.push(await createHolidaySchedule({ ...h, parent: sysId, time_zone: h.time_zone || time_zone }).catch((err) => ({ ok: false, status: 'FAILED', error: err.message, attempted: { ...h, parent: sysId } })));
  const readback = await readSchedule(sysId);
  const persistedSpans = spanResults.filter((r) => r.ok && r.span?.sys_id);
  const failedSpans = spanResults.filter((r) => !r.ok);
  const failedHolidays = holidayResults.filter((r) => !r.ok);
  const requestedSpans = (spans || []).length;
  const status = failedSpans.length || failedHolidays.length || persistedSpans.length !== requestedSpans || timezoneWarning ? 'PARTIAL' : 'VERIFIED';
  return {
    ok: status === 'VERIFIED',
    status,
    sys_id: sysId,
    created_parent: Boolean(created),
    schedule: readback,
    parent,
    warnings: [timezoneWarning].filter(Boolean),
    spans_created: persistedSpans,
    span_failures: failedSpans,
    holidays_created: holidayResults,
    holiday_failures: failedHolidays,
    orphan_schedule: requestedSpans > 0 && persistedSpans.length === 0,
    cleanup_candidates: [
      '07967f4d83a3c79037f1fcb6feaad32e',
      '7bc6b38d83a3c79037f1fcb6feaad304',
      '3ef67b8d83a3c79037f1fcb6feaad39e',
    ],
    message: status === 'VERIFIED'
      ? `Created schedule "${readback.name}" and read back ${persistedSpans.length} persisted span(s).`
      : `Created schedule "${readback.name}", but only ${persistedSpans.length}/${requestedSpans} requested span(s) persisted.`,
  };
}

export async function createScheduleSpan(input = {}) {
  const payload = normalizeScheduleSpanInput(input);
  let created;
  try {
    created = await table.create(SCHEDULE_SPAN_TABLE, payload);
  } catch (err) {
    return { ok: false, status: 'FAILED', attempted: payload, error: err.message, serviceNowError: err.detail ?? null };
  }
  const sysId = raw(created?.sys_id);
  const stored = sysId ? await table.get(SCHEDULE_SPAN_TABLE, sysId) : null;
  const verification = verifyScheduleSpanReadback(payload, stored);
  return {
    ok: verification.ok,
    status: verification.ok ? 'VERIFIED' : 'PARTIAL',
    sys_id: verification.span.sys_id || sysId || null,
    span: verification.span,
    attempted: payload,
    mismatches: verification.mismatches,
  };
}

export async function validateScheduleRuntime({ schedule, sys_id: sysId } = {}) {
  const scheduleId = schedule || sysId;
  if (!scheduleId) throw Object.assign(new Error('schedule sys_id is required.'), { status: 400 });
  const script = `
var report = { ok: false, status: 'FAILED', schedule: ${jsLiteral(scheduleId)} };
try {
  function gdt(s) { var x = new GlideDateTime(); x.setValue(s); return x; }
  var sched = new GlideSchedule(${jsLiteral(scheduleId)});
  var checks = [
    ['monday_0900', '2008-07-07 09:00:00', true],
    ['monday_1200', '2008-07-07 12:00:00', true],
    ['monday_1759', '2008-07-07 17:59:00', true],
    ['monday_1800', '2008-07-07 18:00:00', false],
    ['saturday_1200', '2008-07-12 12:00:00', false]
  ];
  report.contains = [];
  for (var i = 0; i < checks.length; i++) {
    var actual = sched.isInSchedule(gdt(checks[i][1]));
    report.contains.push({ name: checks[i][0], at: checks[i][1], expected: checks[i][2], actual: actual, ok: actual === checks[i][2] });
  }
  function add8(start) {
    var end = sched.add(gdt(start), new GlideDuration(8 * 60 * 60 * 1000));
    return String(end.getValue());
  }
  report.add = [
    { start: '2008-07-07 09:00:00', expected: '2008-07-07 17:00:00', actual: add8('2008-07-07 09:00:00') },
    { start: '2008-07-07 14:00:00', expected: '2008-07-08 13:00:00', actual: add8('2008-07-07 14:00:00') },
    { start: '2008-07-07 18:30:00', expected: '2008-07-08 17:00:00', actual: add8('2008-07-07 18:30:00') }
  ];
  for (var j = 0; j < report.add.length; j++) report.add[j].ok = report.add[j].actual === report.add[j].expected;
  report.ok = report.contains.every(function(c) { return c.ok; }) && report.add.every(function(c) { return c.ok; });
  report.status = report.ok ? 'VERIFIED' : 'PARTIAL';
} catch (e) {
  report.ok = false;
  report.status = 'FAILED';
  report.error = String(e && e.message || e);
}
`;
  const r = await runServerScript({ body: script, label: 'sla schedule runtime validation', timeoutMs: 120_000 });
  if (r.status === 'EXECUTION_PATH_BLOCKED') {
    return { ok: false, status: 'PARTIAL', reason: 'EXECUTION_PATH_BLOCKED', message: r.message, harness: { status: r.status, started: r.started, cleanup: r.cleanup } };
  }
  return { ok: r.report?.status === 'VERIFIED', status: r.report?.status || 'FAILED', report: r.report, harness: { status: r.status, started: r.started, cleanup: r.cleanup } };
}

export async function createHolidaySchedule({ parent, name, start, end, time_zone = 'UTC' } = {}) {
  if (!parent) throw Object.assign(new Error('parent schedule sys_id is required.'), { status: 400 });
  if (!String(name || '').trim()) throw Object.assign(new Error('holiday name is required.'), { status: 400 });
  if (!start || !end) throw Object.assign(new Error('start and end are required for a holiday.'), { status: 400 });
  const holiday = await table.create(HOLIDAY_TABLE, { name: String(name).trim(), parent, time_zone, type: 'blackout' });
  const holidayId = raw(holiday.sys_id);
  const span = await createScheduleSpan({
    schedule: holidayId,
    name,
    start,
    end,
    repeat_type: '',
    repeat_count: '1',
    days_of_week: '',
    all_day: true,
    show_as: 'busy',
  });
  const readback = await table.get(HOLIDAY_TABLE, holidayId);
  const child = scheduleRaw(readback);
  const childParent = raw(readback.parent);
  const childType = raw(readback.type) || child.type;
  const holidaySpans = await table.query(SCHEDULE_SPAN_TABLE, {
    query: `schedule=${holidayId}`,
    fields: SPAN_FIELDS,
    limit: 20,
  });
  const verifiedSpan = holidaySpans.map(spanRaw).find((s) => s.sys_id === span.sys_id) || null;
  const ok = childParent === parent && childType === 'blackout' && Boolean(verifiedSpan?.sys_id) && span.ok;
  return {
    ok,
    status: ok ? 'VERIFIED' : 'PARTIAL',
    sys_id: holidayId,
    holiday: child,
    parent_verified: childParent === parent,
    type_verified: childType === 'blackout',
    spans: holidaySpans.map(spanRaw),
    span,
    message: ok
      ? `Created holiday/blackout schedule "${shown(readback.name)}" under parent ${parent} and read back its persisted span.`
      : `Holiday/blackout schedule "${shown(readback.name)}" did not fully verify; see parent/type/span evidence.`,
  };
}

export async function repairSla({ task_sys_id: taskSysId = '', sla_sys_id: slaSysId = '', dry_run: dryRun = false } = {}) {
  if (!taskSysId && !slaSysId) return { ok: false, status: 'FAILED', reason: 'task_sys_id or sla_sys_id is required.' };
  const script = `
var report = {};
try {
  var taskId = ${jsLiteral(taskSysId)};
  var slaId = ${jsLiteral(slaSysId)};
  var dryRun = ${dryRun ? 'true' : 'false'};
  function rows() {
    var out = [];
    var gr = new GlideRecord('task_sla');
    if (taskId) gr.addQuery('task', taskId);
    if (slaId) gr.addQuery('sla', slaId);
    gr.query();
    while (gr.next()) {
      out.push({
        sys_id: String(gr.getUniqueValue()),
        task: String(gr.getValue('task') || ''),
        sla: String(gr.getValue('sla') || ''),
        stage: String(gr.getValue('stage') || ''),
        start_time: String(gr.getValue('start_time') || ''),
        planned_end_time: String(gr.getValue('planned_end_time') || ''),
        business_time_left: String(gr.getValue('business_time_left') || ''),
        percentage: String(gr.getValue('percentage') || '')
      });
    }
    return out;
  }
  report.before = rows();
  report.before_count = report.before.length;
  if (typeof SLARepair === 'undefined') {
    report.ok = false;
    report.status = 'NATIVE_API_UNAVAILABLE';
    report.reason = 'Documented native SLARepair API is not visible to this user on this instance.';
  } else {
    var repair = new SLARepair();
    if (typeof repair.setValidateOnly === 'function') repair.setValidateOnly(dryRun);
    if (taskId) repair.repairBySysId(taskId, 'task');
    else repair.repairBySysId(slaId, 'task_sla');
    report.native_api = 'SLARepair.repairBySysId';
    report.ran = true;
    report.dry_run = dryRun;
    report.after = rows();
    report.after_count = report.after.length;
    report.recreated = [];
    for (var i = 0; i < report.after.length; i++) {
      var seen = false;
      for (var j = 0; j < report.before.length; j++) if (report.before[j].sys_id === report.after[i].sys_id) seen = true;
      if (!seen) report.recreated.push(report.after[i].sys_id);
    }
    report.ok = true;
    report.status = 'SUCCESS';
  }
} catch (e) {
  report.ok = false;
  report.status = 'FAILED';
  report.error = String(e && e.message || e);
}
`;
  const r = await runServerScript({ body: script, label: 'sla repair verification', timeoutMs: 120_000 });
  if (r.status === 'EXECUTION_PATH_BLOCKED') {
    return {
      ok: false,
      status: 'FAILED',
      reason: 'EXECUTION_PATH_BLOCKED',
      message: r.message,
      harness: { ok: r.ok, status: r.status, timedOut: r.timedOut, started: r.started, cleanup: r.cleanup },
    };
  }
  const status = r.report?.status || (r.report?.ok ? 'SUCCESS' : 'FAILED');
  return {
    ok: status === 'SUCCESS',
    status,
    report: r.report,
    harness: { ok: r.ok, status: r.status, timedOut: r.timedOut, started: r.started, cleanup: r.cleanup },
  };
}

function timingCell(row, field) {
  return { raw: raw(row?.[field]) ?? null, display: shown(row?.[field]) || null };
}

function secondsBetween(start, end) {
  const a = parseSnowUtc(start);
  const b = parseSnowUtc(end);
  return a === null || b === null ? null : Math.round((b - a) / 1000);
}

export async function slaTimingDiagnostics({ task_sys_id: taskSysId, sla_sys_id: slaSysId } = {}) {
  if (!taskSysId || !slaSysId) throw Object.assign(new Error('task_sys_id and sla_sys_id are required.'), { status: 400 });
  const [definition, rows] = await Promise.all([
    getSla(slaSysId),
    table.query(TASK_SLA_TABLE, { query: `task=${taskSysId}^sla=${slaSysId}`, fields: TIMING_TASK_SLA_FIELDS, limit: 5 }),
  ]);
  const taskSla = rows[0] || null;
  const schedule = definition.schedule?.sys_id ? await readSchedule(definition.schedule.sys_id).catch((err) => ({ error: err.message })) : null;
  const stored = taskSla ? {
    task_sla: raw(taskSla.sys_id),
    stage: timingCell(taskSla, 'stage'),
    timezone: timingCell(taskSla, 'timezone'),
    start_time: timingCell(taskSla, 'start_time'),
    original_breach_time: timingCell(taskSla, 'original_breach_time'),
    planned_end_time: timingCell(taskSla, 'planned_end_time'),
    business_duration: timingCell(taskSla, 'business_duration'),
    business_elapsed_time: timingCell(taskSla, 'business_elapsed_time'),
    business_time_left: timingCell(taskSla, 'business_time_left'),
    business_percentage: timingCell(taskSla, 'business_percentage'),
    percentage: timingCell(taskSla, 'percentage'),
    pause_duration: timingCell(taskSla, 'pause_duration'),
    schedule: timingCell(taskSla, 'schedule'),
  } : null;
  const expected24x7 = taskSla && definition.duration?.seconds != null
    ? {
      basis: 'calculated_24x7_only',
      expected_elapsed_seconds: definition.duration.seconds,
      observed_elapsed_seconds: secondsBetween(raw(taskSla.start_time), raw(taskSla.planned_end_time)),
      note: 'This is only the unscheduled baseline. It is not used to declare schedule discrepancies normal.',
    }
    : null;
  return {
    ok: Boolean(taskSla),
    definition: {
      sys_id: definition.sys_id,
      name: definition.name,
      duration: definition.duration,
      schedule: definition.schedule,
      schedule_source: definition.schedule_source,
      timezone_source: definition.timezone_source,
      timezone: definition.timezone,
    },
    schedule,
    stored,
    calculated: { expected24x7 },
    assumptions: [
      'Schedule arithmetic is owned by ServiceNow; this diagnostic does not reimplement recurring schedule calculation.',
      'A discrepancy is reported as unexplained unless proven by readback or an official/native calculation.',
    ],
    confirmed_behavior: [
      rows.length === 1 ? 'Exactly one task_sla row matches this task and SLA definition.' : `${rows.length} task_sla rows match this task and SLA definition.`,
      definition.schedule_effective ? 'The SLA definition has an effective schedule reference.' : 'The SLA definition is not schedule-bound.',
    ],
  };
}

export const _slaInternals = { scheduleSpansFromInput, toRecord };

/** Delete, then read back to confirm absence. A delete that reports success without that is a claim. */
export async function deleteSla(sysId) {
  await table.remove(SLA_TABLE, sysId);
  const left = await table.query(SLA_TABLE, { query: `sys_id=${sysId}`, fields: 'sys_id', limit: 1, display: 'false' });
  return {
    ok: left.length === 0,
    sys_id: sysId,
    message: left.length === 0 ? 'Deleted; read-back returns 0 rows.' : 'DELETE returned success but the record is still readable.',
  };
}

async function recordLink(t, sysId) {
  const { getSettings } = await import('../config/store.js');
  const base = (getSettings().connection.instanceUrl || '').replace(/\/+$/, '');
  return base ? `${base}/nav_to.do?uri=${t}.do%3Fsys_id%3D${sysId}` : null;
}

/* ------------------------------------------------------------------ *
 * The SLA assertion — B-2
 *
 * Shape, as it appears in a verification spec:
 *
 *   { "type": "sla",
 *     "sla": "P1 resolve in 4h",                  // name or sys_id
 *     "locate": { "bySetupRecord": true },        // the task the SLA attaches to
 *     "expect": { "attached": true,
 *                 "stage": "in_progress",
 *                 "breached": false,
 *                 "plannedEndToleranceSec": 120 },
 *     "note": "the promise this proves" }
 *
 * The tolerance is REQUIRED to be stated in the assertion rather than defaulted
 * silently: the clock starts when the platform attaches the row, not when the
 * runner posted the record, so the two differ by however long the insert took.
 * A tolerance that lives in the runner is a number nobody reviewing the spec
 * can see.
 * ------------------------------------------------------------------ */

export const SLA_TOLERANCE_DEFAULT_SEC = 120;

/** Fields read off a task_sla row. */
const TASK_SLA_FIELDS = 'sys_id,task,sla,stage,start_time,planned_end_time,end_time,has_breached,schedule,timezone,percentage';

/**
 * Assert that a task_sla for `definition` attached to `taskSysId` and that its
 * planned end is start + duration.
 *
 * `readTaskSlas` is injected so the offline suite can drive every branch,
 * including the ones that need a schedule-bound SLA or a rival definition
 * attached to the same record.
 */
export async function assertTaskSla({
  definition,
  taskSysId,
  expect = {},
  readTaskSlas = (query) => table.query(TASK_SLA_TABLE, { query, fields: TASK_SLA_FIELDS, limit: 20 }),
} = {}) {
  const toleranceSec = Number(expect.plannedEndToleranceSec ?? SLA_TOLERANCE_DEFAULT_SEC);
  const base = {
    type: 'sla',
    sla: { sys_id: definition.sys_id, name: definition.name },
    task: taskSysId,
    toleranceSec,
  };

  // Behaviour 4: filter by the definition, not by the task. Every row on the
  // record is fetched too, purely so a failure can say what DID attach —
  // "nothing attached" and "three rivals attached and ours did not" are very
  // different diagnoses and the second one is the common case here.
  const all = await readTaskSlas(`task=${taskSysId}`);
  const mine = all.filter((r) => raw(r.sla) === definition.sys_id);
  const others = all.filter((r) => raw(r.sla) !== definition.sys_id)
    .map((r) => ({ sys_id: raw(r.sla), name: shown(r.sla) }));

  if (expect.attached === false) {
    return {
      ...base,
      pass: mine.length === 0,
      attached: mine.length,
      others,
      reason: mine.length === 0
        ? 'No task_sla for this definition attached, as expected.'
        : `Expected no attachment, but ${mine.length} task_sla row(s) for "${definition.name}" are on the record.`,
    };
  }

  if (!mine.length) {
    return {
      ...base,
      pass: false,
      attached: 0,
      others,
      reason:
        `No task_sla referencing "${definition.name}" (${definition.sys_id}) attached to ${taskSysId}. ` +
        (others.length
          ? `${others.length} other SLA(s) DID attach — ${others.map((o) => `"${o.name}"`).join(', ')} — so the record ` +
            `reached the SLA engine and this definition's start condition did not match it.`
          : 'No SLA at all attached to the record.'),
    };
  }

  const row = mine[0];
  const startMs = parseSnowUtc(raw(row.start_time));
  const endMs = parseSnowUtc(raw(row.planned_end_time));
  const stage = raw(row.stage);
  const breached = raw(row.has_breached) === 'true';
  const rowSchedule = raw(row.schedule) || null;
  const durationSec = definition.duration?.seconds ?? null;

  const checks = [];
  const fail = (what) => checks.push({ ok: false, what });
  const pass = (what) => checks.push({ ok: true, what });

  if (mine.length > 1) fail(`${mine.length} task_sla rows reference this one definition; expected exactly 1.`);
  else pass('exactly one task_sla references this definition');

  if (startMs === null || endMs === null) {
    fail(`start_time ("${raw(row.start_time)}") or planned_end_time ("${raw(row.planned_end_time)}") is not a readable datetime.`);
  }

  if (expect.stage && stage !== expect.stage) fail(`stage is "${stage}", expected "${expect.stage}".`);
  else if (expect.stage) pass(`stage is "${stage}"`);

  if (expect.breached !== undefined && breached !== Boolean(expect.breached)) {
    fail(`has_breached is ${breached}, expected ${Boolean(expect.breached)}.`);
  } else if (expect.breached !== undefined) pass(`has_breached is ${breached}`);

  /*
   * The breach clock.
   *
   * Two modes, and which one ran is reported rather than inferred:
   *
   *   24x7 — the schedule is not in play, so planned_end is start + duration
   *          exactly and the check is an equality within the stated tolerance.
   *
   *   scheduled — the end is the schedule's arithmetic over working windows.
   *          Recomputing that here would mean reimplementing the platform's
   *          schedule engine, and asserting a 24x7 expectation against it FAILS
   *          A CORRECT SLA: measured, 4h against 8-5 weekdays landed 7.84h of
   *          wall-clock later. So the exact check is skipped and said to be
   *          skipped, and what remains is asserted properly — the clock runs
   *          forward, it cannot be shorter than the duration, and the schedule
   *          the platform used is the one the definition names.
   */
  let clock = null;
  if (startMs !== null && endMs !== null && durationSec !== null) {
    const elapsedSec = Math.round((endMs - startMs) / 1000);
    const scheduled = definition.schedule_effective;
    if (!scheduled) {
      const driftSec = Math.abs(elapsedSec - durationSec);
      clock = {
        mode: '24x7',
        startUtc: raw(row.start_time),
        plannedEndUtc: raw(row.planned_end_time),
        expectedSec: durationSec,
        observedSec: elapsedSec,
        driftSec,
        toleranceSec,
      };
      if (driftSec <= toleranceSec) {
        pass(`planned_end is start + ${formatDuration(durationSec)} within ${toleranceSec}s (drift ${driftSec}s)`);
      } else {
        fail(
          `planned_end_time is ${formatDuration(elapsedSec)} after start_time, expected ${formatDuration(durationSec)} ` +
          `± ${toleranceSec}s (drift ${driftSec}s). Both times read as UTC: ${raw(row.start_time)} → ${raw(row.planned_end_time)}.`
        );
      }
      if (rowSchedule) {
        fail(`the definition is not schedule-bound, but the task_sla carries schedule ${rowSchedule} — the clock is not 24x7 after all.`);
      }
    } else {
      clock = {
        mode: 'scheduled',
        schedule: definition.schedule?.name || definition.schedule?.sys_id,
        startUtc: raw(row.start_time),
        plannedEndUtc: raw(row.planned_end_time),
        durationSec,
        observedSec: elapsedSec,
        note:
          'Schedule-bound: planned_end is the schedule engine\'s arithmetic over working windows, not start + duration. ' +
          'NowHelpAssist does not recompute it — asserting a 24x7 expectation here fails a correct SLA (measured: 4h against ' +
          '8-5 weekdays landed 7.84h of wall-clock later). Bounds are asserted instead.',
      };
      if (elapsedSec > 0) pass('planned_end is after start');
      else fail(`planned_end_time is not after start_time (${elapsedSec}s).`);
      if (elapsedSec >= durationSec) pass(`elapsed wall-clock (${formatDuration(elapsedSec)}) is at least the ${formatDuration(durationSec)} target, as a schedule can only push it out`);
      else fail(`planned_end is only ${formatDuration(elapsedSec)} after start, which is LESS than the ${formatDuration(durationSec)} target — a schedule can never shorten the clock.`);
      if (rowSchedule && definition.schedule?.sys_id && rowSchedule !== definition.schedule.sys_id) {
        fail(`the task_sla is running against schedule ${rowSchedule}, not the definition's ${definition.schedule.sys_id}.`);
      } else if (rowSchedule) pass(`the task_sla runs against the definition's own schedule ("${definition.schedule?.name}")`);
      else fail('the definition is schedule-bound but the task_sla carries no schedule — the clock is running 24x7.');
    }
  } else if (durationSec === null) {
    checks.push({ ok: true, what: 'no fixed duration on the definition (relative duration type) — the breach clock is not checked here', skipped: true });
  }

  const failures = checks.filter((c) => !c.ok);
  return {
    ...base,
    pass: failures.length === 0,
    attached: mine.length,
    others,
    task_sla: {
      sys_id: raw(row.sys_id),
      stage,
      has_breached: breached,
      start_time_utc: raw(row.start_time),
      planned_end_time_utc: raw(row.planned_end_time),
      // Kept only so a reader can SEE the offset that trap #UTC is about; no
      // calculation in this file touches it.
      planned_end_time_display: shown(row.planned_end_time),
      schedule: rowSchedule,
      timezone: raw(row.timezone) || null,
    },
    clock,
    checks,
    reason: failures.length ? failures.map((f) => f.what).join(' ') : `task_sla attached to the right definition with a sane breach clock (${checks.filter((c) => c.ok).length} checks passed).`,
  };
}

/* ------------------------------------------------------------------ *
 * verifySla — setup → wait → assert → cleanup, for an SLA definition
 * ------------------------------------------------------------------ */

/**
 * Prove an SLA definition works, by making the platform run it.
 *
 * The setup record is DERIVED from the definition's own start condition rather
 * than described by a model: the condition is already a precise machine-
 * readable statement of what has to be true, so re-deriving it through a
 * generation step would only add a way to be wrong.
 *
 * Cleanup runs in a finally and reads back, always.
 */
export async function verifySla(nameOrId, emit = () => {}, { toleranceSec = SLA_TOLERANCE_DEFAULT_SEC, waitSec = 60, marker } = {}) {
  const definition = await findSla(nameOrId);
  emit({ type: 'sla_verify_definition', name: definition.name, sys_id: definition.sys_id, collection: definition.collection });

  if (!definition.active) {
    return { ok: false, available: false, definition, message: `"${definition.name}" is inactive, so the platform will never attach it. Activate it before verifying.` };
  }

  // Trap #2 first: a start condition on an unknown field is not an error, it is
  // a wider condition. Deriving a setup record from it would produce a record
  // that matches for the wrong reason.
  const fieldCheck = await validateEncodedQuery(definition.collection, definition.conditions.start, { schemaFor: getSchema });
  if (!fieldCheck.checked) {
    return { ok: false, available: false, definition, message: `Could not read the schema of ${definition.collection}: ${fieldCheck.readError}` };
  }
  if (!fieldCheck.ok) {
    return {
      ok: false, available: false, definition,
      message: 'The start condition was NOT run, because it cannot mean what it reads.',
      errors: [
        ...(fieldCheck.unknown.length ? [unknownFieldMessage('The start condition', definition.collection, fieldCheck.unknown)] : []),
        ...fieldCheck.unparsed.map((u) => `NowHelpAssist could not parse the clause "${u}", so it cannot confirm the setup record satisfies it.`),
      ],
    };
  }

  const derived = await derivePayloadFor(definition.collection, definition.conditions.start, {
    schemaFor: getSchema,
    resolveRef: async (t) => (await referenceLookup(t, '', 1))[0] || null,
  });
  if (derived.unsatisfiable.length) {
    return {
      ok: false, available: false, definition, derivation: derived,
      message: 'No setup record could be derived from the start condition, so nothing was created.',
      errors: derived.unsatisfiable.map((u) => `"${u.clause}" — ${u.reason}`),
    };
  }

  const schema = await getSchema(definition.collection);
  const payload = { ...derived.payload };
  const tag = marker || `NowHelpAssist SLA check ${definition.name}`;
  if (schema.fields.some((f) => f.name === 'short_description') && !payload.short_description) {
    payload.short_description = tag;
  }
  emit({ type: 'sla_verify_setup', table: definition.collection, payload, notes: derived.notes });

  let sysId = null;
  let label = null;
  try {
    const rec = await table.create(definition.collection, payload);
    sysId = raw(rec.sys_id);
    label = shown(rec.number) || sysId;
    emit({ type: 'sla_verify_setup_done', record: label, sys_id: sysId });

    /*
     * Does the record the platform actually stored satisfy the start condition?
     *
     * Asked of the platform's own query engine rather than answered here, which
     * is what makes the calculated-field rule (trap #5) checkable instead of
     * assumed: derivePayloadFor turns priority=1 into impact=1 + urgency=1, and
     * this is where a customised priority matrix shows up as a named mismatch
     * instead of a mysteriously unattached SLA. Sound only because every field
     * in the condition was just confirmed to exist — otherwise the clause would
     * drop and this check would pass vacuously.
     */
    const match = await table.query(definition.collection, {
      query: `sys_id=${sysId}^${definition.conditions.start}`, fields: 'sys_id', limit: 1, display: 'false',
    });
    const satisfies = match.length === 1;
    const observed = await table.get(definition.collection, sysId);
    const observedFields = Object.fromEntries(
      [...new Set([...Object.keys(payload), 'priority'])]
        .filter((f) => observed?.[f] !== undefined)
        .map((f) => [f, shown(observed[f])])
    );
    emit({ type: 'sla_verify_setup_checked', satisfies, observed: observedFields });
    if (!satisfies) {
      return {
        ok: false, available: true, stage: 'setup', definition, derivation: derived,
        setup: { record: label, sys_id: sysId, payload, observed: observedFields },
        message:
          `The setup record does not satisfy the start condition "${definition.conditions.start}" after the platform's ` +
          `own rules ran, so the SLA was never going to attach and no assertion here would have meant anything. ` +
          `The record stored: ${Object.entries(observedFields).map(([k, v]) => `${k}=${v}`).join(', ')}.`,
      };
    }

    // The engine attaches on insert; polling is for the round trip, not a queue.
    let assertion = null;
    const deadline = Date.now() + Math.min(Math.max(waitSec, 10), 300) * 1000;
    for (let attempt = 1; Date.now() < deadline; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 1 ? 2500 : 3000));
      assertion = await assertTaskSla({
        definition, taskSysId: sysId, expect: { attached: true, stage: 'in_progress', breached: false, plannedEndToleranceSec: toleranceSec },
      });
      emit({ type: 'sla_verify_poll', attached: assertion.attached, pass: assertion.pass });
      if (assertion.attached > 0) break;
    }

    return {
      ok: Boolean(assertion?.pass),
      available: true,
      stage: 'assert',
      definition,
      derivation: derived,
      setup: { record: label, sys_id: sysId, payload, observed: observedFields, satisfiesStartCondition: true },
      assertion,
      message: assertion?.pass
        ? `Verified "${definition.name}" against a real ${definition.collection}: ${assertion.reason}`
        : `"${definition.name}" did not verify: ${assertion?.reason || 'no assertion ran.'}`,
    };
  } finally {
    if (sysId) {
      emit({ type: 'sla_verify_cleanup', sys_id: sysId });
      const cleanup = await cleanupTask(definition.collection, sysId);
      emit({ type: 'sla_verify_cleanup_done', ...cleanup });
    }
  }
}

/**
 * Delete the test record and prove it is gone, including its task_sla rows.
 *
 * Measured on this instance: deleting the task cascades its task_sla rows away.
 * That is read back rather than trusted, and any survivors are deleted
 * explicitly — an orphaned running clock is exactly the kind of debris a
 * verification run must not leave behind.
 */
export async function cleanupTask(tableName, sysId) {
  const before = await table.query(TASK_SLA_TABLE, { query: `task=${sysId}`, fields: 'sys_id', limit: 50, display: 'false' });
  await table.remove(tableName, sysId).catch(() => {});
  let orphans = await table.query(TASK_SLA_TABLE, { query: `task=${sysId}`, fields: 'sys_id', limit: 50, display: 'false' });
  const cascaded = orphans.length === 0;
  for (const o of orphans) await table.remove(TASK_SLA_TABLE, o.sys_id).catch(() => {});
  if (orphans.length) orphans = await table.query(TASK_SLA_TABLE, { query: `task=${sysId}`, fields: 'sys_id', limit: 50, display: 'false' });
  const record = await table.query(tableName, { query: `sys_id=${sysId}`, fields: 'sys_id', limit: 1, display: 'false' });
  return {
    ok: record.length === 0 && orphans.length === 0,
    taskSlasAtStart: before.length,
    cascaded,
    taskSlasLeft: orphans.length,
    recordLeft: record.length,
  };
}
