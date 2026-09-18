import { fromSnowTime as fromTaskTime, toSnowTime } from './run-context.js';

/**
 * Schedule spans carry `start_date_time` / `end_date_time` as
 * `YYYYMMDDTHHMMSS` (wall-clock in the schedule's zone) or
 * `YYYYMMDDTHHMMSSZ` (a UTC instant) — verified on dev442675 on 2026-09-17
 * (36 spans, both forms present) — not the `YYYY-MM-DD HH:MM:SS` of task
 * timestamps. Both forms and the task form are accepted; anything else is
 * unparseable and the span is `invalid`.
 * Returns `{ wall: Date-as-UTC-fields, utc: boolean }` or null.
 */
export function parseSpanTime(value) {
  if (value == null || value === '') return null;
  const v = String(value).trim();
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (m) return { wall: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])), utc: m[7] === 'Z' };
  const d = fromTaskTime(v);
  return d ? { wall: d, utc: false } : null;
}
const fromSnowTime = (v) => parseSpanTime(v)?.wall ?? null;

/**
 * DECISION 9 — recurring schedules are EXPANDED into concrete intervals inside
 * the analysis window, respecting the schedule's timezone, the window and the
 * recurrence definition. An unexpanded recurring span is never read as "no
 * blackout"; a span this module cannot expand reliably makes the whole
 * schedule `unavailable`.
 *
 * WHAT IS EXPANDED. `cmn_schedule_span` rows carry `start_date_time` /
 * `end_date_time` as wall-clock times in the SCHEDULE's `time_zone`, plus a
 * recurrence: `repeat_type` ('' = once, `daily`, `weekly`, `weekdays`),
 * `repeat_count` (every N), `repeat_until` (last date), `days_of_week` (for
 * weekly) and `all_day`. Those four repeat types are expanded; `monthly`,
 * `yearly` and anything else are NOT — the platform's month/year semantics
 * (last weekday, day-of-month overflow) are not reproduced here, and a wrong
 * expansion is worse than none.
 *
 * DAY CONVENTION, VERIFIED ON AN INSTANCE (dev442675, 2026-09-17): `days_of_week`
 * is a string of digits with 1 = Monday … 7 = Sunday. Evidence: the platform's
 * own "Weekends / Saturday & Sunday" span (a Saturday-to-Monday-morning span)
 * carries days_of_week "6"; "Blackout Wednesdays (GMT)" and "Wednesdays"
 * (starting on a Wednesday) carry "3". `dayCodeBase` stays configurable for an
 * instance that proves otherwise.
 *
 * A schedule with no `time_zone` is a "floating" schedule on the platform —
 * shown in each viewer's zone. There is no single correct UTC for it, so it
 * is `unavailable` rather than assumed UTC.
 */

export const SUPPORTED_REPEAT_TYPES = Object.freeze(['', 'none', 'daily', 'weekly', 'weekdays']);
export const DAY_MS = 86_400_000;

export class ScheduleError extends Error {
  constructor(message) { super(message); this.name = 'ScheduleError'; }
}

/** Is this an IANA zone Node knows? */
export function validTimeZone(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const partsFormatter = (tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The zone's UTC offset (ms) at an instant. */
export function offsetAt(utcMs, tz) {
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(new Date(utcMs)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Wall-clock time in `tz` → UTC instant. Two-pass: guess with the offset at
 * the naive instant, then correct with the offset at the guess, which settles
 * DST transitions to the platform's own behaviour for all but the skipped hour.
 */
export function zonedToUtc(localSnow, tz) {
  if (!validTimeZone(tz)) throw new ScheduleError(`"${tz}" is not a valid time zone`);
  const naive = fromSnowTime(localSnow);
  if (!naive) throw new ScheduleError(`"${localSnow}" is not a time`);
  const guess = naive.getTime() - offsetAt(naive.getTime(), tz);
  return new Date(naive.getTime() - offsetAt(guess, tz));
}

/** UTC instant → wall-clock `{ y, m, d, h, mi, s, dow }` in `tz` (dow: 1 = Monday … 7 = Sunday). */
export function utcToZoned(utcMs, tz) {
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(new Date(utcMs)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  const jsDow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();   // 0 = Sunday
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second, dow: jsDow === 0 ? 7 : jsDow };
}

const pad = (n) => String(n).padStart(2, '0');
const wall = (y, m, d, h, mi, s) => `${y}-${pad(m)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)}`;

/** Add whole days to a wall-clock date (calendar arithmetic in UTC, which is safe for y/m/d). */
function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() === 0 ? 7 : t.getUTCDay() };
}

/**
 * Expand one span into concrete UTC intervals overlapping the window.
 * Returns `{ status: 'ok', intervals }` or `{ status: 'unsupported' | 'invalid', reason }`.
 */
export function expandSpan(span, { window, timeZone, dayCodeBase = 1, maxIntervals = 5000 } = {}) {
  if (!window?.start || !window?.end) throw new ScheduleError('expandSpan needs a window with start and end');
  if (!validTimeZone(timeZone)) return { status: 'unsupported', reason: `no valid schedule time zone (${timeZone ?? 'none'}) — a floating schedule has no single UTC` };
  const repeat = String(span.repeat_type ?? '').trim().toLowerCase();
  if (!SUPPORTED_REPEAT_TYPES.includes(repeat)) return { status: 'unsupported', reason: `repeat_type "${span.repeat_type}" is not expanded (${SUPPORTED_REPEAT_TYPES.filter(Boolean).join(', ')} only)` };
  const ps = parseSpanTime(span.start_date_time); const pe = parseSpanTime(span.end_date_time);
  if (!ps || !pe) return { status: 'invalid', reason: 'start_date_time / end_date_time missing or unparseable' };
  /* A UTC instant becomes the schedule zone's wall clock, which is what the recurrence is defined on. */
  const toWall = (x) => { if (!x.utc) return x.wall; const z = utcToZoned(x.wall.getTime(), timeZone); return new Date(Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi, z.s)); };
  const s0 = toWall(ps); const e0 = toWall(pe);
  const allDay = ['true', '1', 'yes'].includes(String(span.all_day ?? '').toLowerCase());
  const startWall = { y: s0.getUTCFullYear(), m: s0.getUTCMonth() + 1, d: s0.getUTCDate() };
  const [sh, smi, ss] = allDay ? [0, 0, 0] : [s0.getUTCHours(), s0.getUTCMinutes(), s0.getUTCSeconds()];
  const [eh, emi, es] = allDay ? [23, 59, 59] : [e0.getUTCHours(), e0.getUTCMinutes(), e0.getUTCSeconds()];
  const spanDays = Math.round((Date.UTC(e0.getUTCFullYear(), e0.getUTCMonth(), e0.getUTCDate()) - Date.UTC(s0.getUTCFullYear(), s0.getUTCMonth(), s0.getUTCDate())) / DAY_MS);
  if (spanDays < 0) return { status: 'invalid', reason: 'end_date_time is before start_date_time' };
  const every = Math.max(1, Number(span.repeat_count) || 1);
  const until = span.repeat_until ? fromSnowTime(String(span.repeat_until).length === 10 ? `${span.repeat_until} 23:59:59` : span.repeat_until) : null;
  const winStart = window.start.getTime(); const winEnd = window.end.getTime();
  const daysOfWeek = repeat === 'weekly'
    ? new Set(String(span.days_of_week ?? '').split('').filter((c) => /\d/.test(c)).map((c) => ((Number(c) - dayCodeBase + 7) % 7) + 1))
    : repeat === 'weekdays' ? new Set([1, 2, 3, 4, 5]) : null;
  if (repeat === 'weekly' && !daysOfWeek.size) return { status: 'invalid', reason: 'weekly span has no days_of_week' };

  const intervals = [];
  const emit = (dayWall) => {
    const startUtc = zonedToUtc(wall(dayWall.y, dayWall.m, dayWall.d, sh, smi, ss), timeZone);
    const endWall = addDays(dayWall, spanDays);
    const endUtc = zonedToUtc(wall(endWall.y, endWall.m, endWall.d, eh, emi, es), timeZone);
    if (endUtc.getTime() < winStart || startUtc.getTime() > winEnd) return;
    intervals.push({ id: span.sys_id ?? null, name: span.name ?? null, start: startUtc, end: endUtc, start_snow: toSnowTime(startUtc), end_snow: toSnowTime(endUtc), occurrence: dayWall });
  };

  if (repeat === '' || repeat === 'none') { emit(startWall); return { status: 'ok', intervals, repeat: 'once' }; }

  /* Walk occurrence days from the span start to the window end (or repeat_until). */
  const lastDayUtc = Math.min(winEnd, until ? until.getTime() : Infinity);
  let day = { ...startWall, dow: addDays(startWall, 0).dow };
  let i = 0;
  const firstUtc = zonedToUtc(wall(day.y, day.m, day.d, 0, 0, 0), timeZone).getTime();
  /* Skip ahead in whole periods when the span starts long before the window, so a five-year-old daily span does not walk 1,800 days. */
  if (repeat === 'daily' && firstUtc < winStart - 2 * DAY_MS) {
    const skip = Math.floor((winStart - firstUtc) / (every * DAY_MS)) - 1;
    if (skip > 0) { day = { ...addDays(day, skip * every) }; i = skip * every; }
  }
  for (let guard = 0; guard < 400_000; guard++) {
    const dayUtc = zonedToUtc(wall(day.y, day.m, day.d, 0, 0, 0), timeZone).getTime();
    if (dayUtc > lastDayUtc) break;
    if (repeat === 'daily') { if (i % every === 0) emit(day); }
    else if (repeat === 'weekly') { if (daysOfWeek.has(day.dow) && Math.floor(i / 7) % every === 0) emit(day); }
    else if (repeat === 'weekdays') { if (daysOfWeek.has(day.dow)) emit(day); }
    if (intervals.length > maxIntervals) return { status: 'unsupported', reason: `more than ${maxIntervals} occurrences in the window` };
    day = addDays(day, 1); i += 1;
  }
  return { status: 'ok', intervals, repeat, every };
}

/**
 * Expand every span of a schedule. `unavailable` if ANY span could not be
 * expanded — a schedule half-expanded would silently drop the blackout it
 * could not read.
 */
export function expandSchedule(schedule, { window, dayCodeBase = 1 } = {}) {
  const tz = schedule.time_zone || null;
  const intervals = []; const unexpanded = [];
  for (const sp of schedule.spans || []) {
    const r = expandSpan(sp, { window, timeZone: tz, dayCodeBase });
    if (r.status === 'ok') intervals.push(...r.intervals.map((iv) => ({ ...iv, schedule: schedule.sys_id ?? null, schedule_name: schedule.name ?? null })));
    else unexpanded.push({ span: sp.sys_id ?? null, repeat_type: sp.repeat_type ?? null, reason: r.reason });
  }
  if (!tz && (schedule.spans || []).length) return { status: 'unavailable', reason: 'schedule has no time_zone (floating) — cannot place its spans on the UTC timeline', intervals: [], unexpanded, timezone: null };
  return { status: unexpanded.length ? 'unavailable' : 'ok', reason: unexpanded.length ? `${unexpanded.length} span(s) could not be expanded: ${unexpanded.map((u) => u.reason).join('; ')}` : null, intervals: unexpanded.length ? [] : intervals.sort((a, b) => a.start - b.start), unexpanded, timezone: tz };
}
