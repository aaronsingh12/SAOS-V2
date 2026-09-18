/**
 * ITSM PHASE 3 — the run context and window manager.
 *
 * ONE ANCHOR PER RUN. Every temporal rule — "open more than 2 days", "changes
 * in the 72 hours before", "reopen rate over 90 days" — is computed against
 * `run.now`, taken once when the run starts. The existing rule pack already
 * does this (`EstateRules` takes `now` in its constructor); what it lacks is
 * the vocabulary of windows the workbook uses and a single place to turn a
 * window into concrete bounds. A rule that called `new Date()` itself would
 * drift from the others by however long extraction took — minutes on a large
 * instance — and two rules would then describe two different "nows" in one
 * report.
 *
 * TIME IS UTC. ServiceNow stores `sys_created_on` / `sys_updated_on` as UTC
 * without a zone marker (trap #21), and `rules.parseDate` already appends the
 * `Z`. Bounds are produced in the same `YYYY-MM-DD HH:MM:SS` UTC form the
 * platform expects in an encoded query, so a window can be pushed down.
 * `timezone` is recorded on the context for the day-of-week / business-hours
 * rules a later phase may build; nothing here converts to it.
 *
 * WINDOWS ARE DECLARED, NOT INVENTED. `WINDOWS` lists the windows Phase 2 found
 * in the workbook, by name, each with its unit. A rule asks for a window by
 * name or by `{ amount, unit }`; a rule whose window the workbook leaves
 * "configurable" with no default resolves it through the parameter registry
 * and gets UNDEFINED there — this module never supplies a fallback.
 */

export const UNITS_MS = Object.freeze({
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
});

/** The windows the workbook states, as Phase 2 catalogued them. Named for reuse, not as defaults. */
export const WINDOWS = Object.freeze({
  '120 seconds': Object.freeze({ amount: 120, unit: 'seconds' }),
  '60 seconds': Object.freeze({ amount: 60, unit: 'seconds' }),
  '30 minutes': Object.freeze({ amount: 30, unit: 'minutes' }),
  '1 hour': Object.freeze({ amount: 1, unit: 'hours' }),
  '72 hours': Object.freeze({ amount: 72, unit: 'hours' }),
  '1 day': Object.freeze({ amount: 1, unit: 'days' }),
  '2 days': Object.freeze({ amount: 2, unit: 'days' }),
  '5 days': Object.freeze({ amount: 5, unit: 'days' }),
  '15 days': Object.freeze({ amount: 15, unit: 'days' }),
  '30 days': Object.freeze({ amount: 30, unit: 'days' }),
  '60 days': Object.freeze({ amount: 60, unit: 'days' }),
  '90 days': Object.freeze({ amount: 90, unit: 'days' }),
  '180 days': Object.freeze({ amount: 180, unit: 'days' }),
  '12 months': Object.freeze({ amount: 12, unit: 'months' }),
});

export class WindowError extends Error {
  constructor(message) { super(message); this.name = 'WindowError'; }
}

/** `YYYY-MM-DD HH:MM:SS` in UTC — what an encoded query compares against. */
export function toSnowTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new WindowError('not a valid date');
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

/** The inverse, for platform timestamps (no zone → UTC). Returns null for blank/unparseable. */
export function fromSnowTime(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim().replace(' ', 'T');
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `'90 days'`, `{amount, unit}` or a WINDOWS key → a frozen `{amount, unit}`. */
export function parseWindow(spec) {
  if (spec && typeof spec === 'object') {
    const { amount, unit } = spec;
    if (!Number.isFinite(amount) || amount <= 0) throw new WindowError(`window amount ${JSON.stringify(amount)} must be a positive number`);
    if (!(unit in UNITS_MS) && unit !== 'months') throw new WindowError(`window unit "${unit}" is not one of ${[...Object.keys(UNITS_MS), 'months'].join(', ')}`);
    return Object.freeze({ amount, unit });
  }
  const text = String(spec ?? '').trim();
  if (WINDOWS[text]) return WINDOWS[text];
  const m = /^(\d+(?:\.\d+)?)\s*(second|minute|hour|day|month)s?$/i.exec(text);
  if (!m) throw new WindowError(`"${text}" is not a window (use "90 days", "72 hours", "30 minutes", "12 months" or {amount, unit})`);
  return parseWindow({ amount: Number(m[1]), unit: `${m[2].toLowerCase()}s` });
}

/** Shift a date by a window, backwards by default. Months move the calendar month; everything else is exact milliseconds. */
export function shiftDate(date, window, direction = -1) {
  const w = parseWindow(window);
  const d = new Date(date.getTime());
  if (w.unit === 'months') {
    d.setUTCMonth(d.getUTCMonth() + direction * w.amount);
    return d;
  }
  return new Date(d.getTime() + direction * w.amount * UNITS_MS[w.unit]);
}

export function windowMs(window) {
  const w = parseWindow(window);
  if (w.unit === 'months') throw new WindowError('a month window has no fixed millisecond length; use shiftDate against an anchor');
  return w.amount * UNITS_MS[w.unit];
}

/**
 * Create the run context. `now` is injectable so the offline suite (and a
 * replay) can pin it; a real run takes the clock once, here, and nowhere else.
 */
export function createRunContext({ now = new Date(), timezone = 'UTC', runId = null } = {}) {
  const anchor = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(anchor.getTime())) throw new WindowError('run context needs a valid anchor time');
  const windowsUsed = new Map();

  /**
   * A window ending at the anchor: `{ start, end, spec, start_snow, end_snow }`.
   * `direction: 'after'` gives the window that STARTS at the anchor (rare —
   * a rule looking forward from a past event uses `around()`).
   */
  const windowOf = (spec, { direction = 'before', label = null } = {}) => {
    const w = parseWindow(spec);
    const start = direction === 'before' ? shiftDate(anchor, w, -1) : anchor;
    const end = direction === 'before' ? anchor : shiftDate(anchor, w, +1);
    const out = Object.freeze({
      spec: w, direction, start, end,
      start_snow: toSnowTime(start), end_snow: toSnowTime(end),
      label: label ?? `${w.amount} ${w.unit}`,
    });
    windowsUsed.set(out.label, out);
    return out;
  };

  /** A window around an arbitrary event time — for "changes in the 72 h before this incident". */
  const around = (eventTime, spec, { direction = 'before' } = {}) => {
    const t = eventTime instanceof Date ? eventTime : fromSnowTime(eventTime);
    if (!t) throw new WindowError(`"${eventTime}" is not a time`);
    const w = parseWindow(spec);
    const start = direction === 'before' ? shiftDate(t, w, -1) : t;
    const end = direction === 'before' ? t : shiftDate(t, w, +1);
    return Object.freeze({ spec: w, direction, start, end, start_snow: toSnowTime(start), end_snow: toSnowTime(end) });
  };

  /** Whole days between a timestamp and the anchor (floor), or null if unparseable — the staleness idiom. */
  const ageDays = (value) => {
    const t = value instanceof Date ? value : fromSnowTime(value);
    return t ? Math.floor((anchor.getTime() - t.getTime()) / UNITS_MS.days) : null;
  };

  return Object.freeze({
    runId,
    run_started_at: anchor.toISOString(),
    now: anchor,
    now_snow: toSnowTime(anchor),
    timezone,
    window: windowOf,
    around,
    ageDays,
    /** The windows this run actually used — recorded on the manifest so a finding's window is auditable. */
    windowsUsed: () => Object.fromEntries([...windowsUsed.entries()].map(([k, v]) => [k, { start: v.start_snow, end: v.end_snow, spec: v.spec }])),
  });
}
