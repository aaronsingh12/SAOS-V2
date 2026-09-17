/**
 * TIME, as ServiceNow stores it. A leaf module: it imports nothing.
 *
 * `parseDate` used to live in `rules.js`, which every rule pack also imports for
 * its engine — so ten packs each closed an import cycle back to it. ESM tolerates
 * that only while `rules.js` is the module somebody imports FIRST; import a rule
 * pack directly and the cycle resolves the other way, leaving `rules.js` reading
 * a rule-list export that has not been initialised yet. Measured Sep 2026, as a
 * `ReferenceError: Cannot access 'CONSUMPTION_RULES' before initialization`.
 *
 * A pure function with no dependencies belongs in a file with no dependencies.
 */

/**
 * Parse a ServiceNow timestamp as UTC.
 *
 * The platform stores `sys_updated_on` as `YYYY-MM-DD HH:MM:SS` with no zone and
 * means UTC by it (trap #21 — the display half is session-local). Reading it
 * with the host's zone shifts every staleness calculation by the offset, which
 * on this machine is 5.5 hours, so the `Z` is explicit.
 */
export function parseDate(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  const spaced = raw.replace(' ', 'T');
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(spaced) ? spaced : `${spaced}Z`;
  const dt = new Date(withZone);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export const DAY_MS = 86_400_000;
