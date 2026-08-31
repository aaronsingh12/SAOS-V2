import { table } from './client.js';
import { log } from '../logging.js';
import { registerInstanceScopedCache } from './instance-binding.js';

/**
 * DBA Layer 0 — the metadata client.
 *
 * A typed, paging, cached wrapper over the Table API for the `sys_*` tables
 * that ARE the ServiceNow schema. Everything in Layers 1-4 reads through here
 * so that the ways this surface lies get answered once, in one place, rather
 * than at forty call sites.
 *
 * WHAT WAS MEASURED on dev428633 (2026-08-31), not assumed:
 *
 *   1. `sysparm_fields` drops unknown names silently — trap #4. Asking for a
 *      column that does not exist returns 200 with that key simply absent, so
 *      `row.reference_qual === undefined` reads identically to "this field has
 *      no qualifier". Every query here compares the returned key set against
 *      the requested one and fails LOUDLY on a gap.
 *
 *   2. Several metadata tables are NOT reachable over REST at all, even as
 *      admin, and each fails in a different shape:
 *        sys_index     403 "Failed API level ACL Validation"  -> server-side only
 *        sys_plugins   403 "Failed API level ACL Validation"  -> use v_plugin
 *        sys_package   403 (so reading the PARENT to reach sys_plugins fails too)
 *        sys_index_ii  400 "Invalid table"                    -> absent here
 *        v_db_index    200 with ZERO rows, unfiltered         -> inert, not a source
 *      REACH records this per table so a caller gets "this needs the server-side
 *      path" instead of an auth error it will misread as bad credentials.
 *
 *   3. The Table API returns exactly `sysparm_limit` rows with no indication
 *      there were more. A schema tool that stops at the first page and reports
 *      its findings as complete is this project's whole failure mode: a
 *      confidently wrong answer rather than an error. `metaQuery` pages to a
 *      stated ceiling and marks the result `truncated` when it hits it.
 *
 *   4. A SHORT PAGE IS NOT THE END OF THE RESULT SET. Measured: the same query
 *      returns 1000, 1000, 1000, 999, 402, 0 — the 999 sits in the middle.
 *      Treating it as a terminator lost 403 rows and called the answer
 *      complete. `metaQuery` now pages by keyset and reconciles against the
 *      aggregate count; see its own comment for the measurement.
 */

/** Where a metadata table can actually be read from, measured rather than guessed. */
export const REACH = {
  sys_index: {
    rest: false,
    via: 'server-script',
    note: 'sys_index returns 403 "Failed API level ACL Validation" over REST even for admin. It IS readable '
        + 'from a server-side script (measured: 18 columns, keyed by logical_table_name, with col_name_string '
        + 'holding the indexed column and unique_index the uniqueness flag).',
  },
  sys_index_ii: {
    rest: false,
    via: 'absent',
    note: 'sys_index_ii does not exist on this instance — the Table API answers 400 "Invalid table". Index '
        + 'columns live on sys_index itself (col_name_string / index_col_name), so do not look for a second table.',
  },
  v_db_index: {
    rest: true,
    via: 'inert',
    note: 'v_db_index is readable and returns ZERO rows both unfiltered and for table=incident. It is not a '
        + 'usable index source; sys_index through a server script is.',
  },
  sys_plugins: {
    rest: false,
    via: 'v_plugin',
    note: 'sys_plugins is 403 over REST. v_plugin carries the same activation state (id, name, active, version) '
        + 'and IS readable.',
  },
  sys_package: {
    rest: false,
    via: 'server-script',
    note: 'sys_package is 403 over REST, so reading the parent table to reach sys_plugins rows does not work either.',
  },
};

export class DbaMetadataError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = 'DbaMetadataError';
    this.status = 502;
    this.detail = detail;
  }
}

/**
 * Refuse a read the instance cannot serve over REST, and say what does serve it.
 *
 * Without this the caller gets the client's 403 diagnosis — accurate, but it
 * names a permission problem for something no credential on this instance can
 * fix. "Bad password" is the wrong lesson (trap #51, committed in our own code).
 */
export function assertRestReachable(t) {
  const r = REACH[t];
  if (!r || r.rest) return;
  throw new DbaMetadataError(
    `${t} cannot be read over the Table API on this instance. ${r.note}`,
    { table: t, via: r.via },
  );
}

/**
 * Trap #4, enforced.
 *
 * `sysparm_fields=element,reference_qual,does_not_exist` returns 200 and simply
 * omits the third key. A dependency scan built on that reports "no dependents"
 * for a column it never actually read. So every requested field must appear on
 * at least one returned row, or this throws naming exactly which did not.
 *
 * "On at least one row" rather than "on every row" is deliberate: the Table API
 * omits a key on rows where that column is empty, so requiring it everywhere
 * would fail on healthy data.
 */
export function assertFieldsHonoured(t, requested, rows) {
  if (!requested || !rows?.length) return rows;
  const asked = String(requested).split(',').map((s) => s.trim()).filter(Boolean);
  if (!asked.length) return rows;
  const seen = new Set();
  for (const row of rows) for (const k of Object.keys(row)) seen.add(k);
  const missing = asked.filter((f) => !seen.has(f));
  if (!missing.length) return rows;
  throw new DbaMetadataError(
    `Queried ${t} for [${asked.join(', ')}] and the instance returned no key for [${missing.join(', ')}] on any `
    + `of ${rows.length} rows. sysparm_fields drops unknown column names WITHOUT an error (trap #4), so treat `
    + 'these as columns that do not exist on this table rather than as empty values — and do not conclude '
    + 'anything from their absence.',
    { table: t, asked, missing, rowsInspected: rows.length },
  );
}

/** Page size, and the hard ceiling on one logical read. */
const PAGE = 1000;
const DEFAULT_MAX = 5000;

/**
 * How far the aggregate total and the paged rows may disagree before it is loss.
 *
 * MEASURED on dev428633: `sys_dictionary` `reference=sys_user` reports 4402 from
 * /api/now/stats and yields 4401 distinct rows from the Table API, stably, on
 * repeated walks — offset-paged and keyset-paged alike. The aggregate and the
 * row reader do not apply row-level ACLs identically, and rows are also
 * genuinely created while a walk is in flight. A gap of one or two rows is
 * that; the 403-row gap of finding C-1 is data loss wearing the same shape, and
 * must never be reported as complete.
 */
const COUNT_DRIFT_TOLERANCE = 2;

/** `display` other than 'false' returns { value, display_value } per field. */
const sysIdOf = (row) => {
  const v = row?.sys_id;
  return v && typeof v === 'object' ? v.value : v;
};

/**
 * The keyset walk itself, with the transport injected.
 *
 * Split out from `metaQuery` so the C-1 failure — a short page mid-result — is
 * reproducible in a unit test against the exact measured page shape
 * (1000, 1000, 1000, 999, 402, 0) without an instance. A paging bug that can
 * only be caught by querying a 4,400-row table live is a paging bug that comes
 * back.
 *
 * `fetchPage({ after, limit })` returns one page of rows. `knownTotal()`
 * answers the authoritative count, or null when there isn't one.
 */
export async function pageAll({ fetchPage, knownTotal = async () => null, max = DEFAULT_MAX, pageSize = PAGE, onFirstPage = null }) {
  const rows = [];
  let watermark = null;
  let pages = 0;
  let exhausted = false;
  let terminator = 'ceiling';

  for (;;) {
    const limit = Math.min(pageSize, max - rows.length);
    if (limit <= 0) break;                                   // the caller's ceiling
    // eslint-disable-next-line no-await-in-loop
    const page = await fetchPage({ after: watermark, limit, pages });
    pages += 1;
    if (onFirstPage && pages === 1) onFirstPage(page);
    // ONLY an empty page ends the walk. A short page does not — that was C-1.
    if (!page.length) { exhausted = true; terminator = 'empty-page'; break; }
    rows.push(...page);

    const next = sysIdOf(page[page.length - 1]);
    if (!next) {
      throw new DbaMetadataError(
        'A page came back without a sys_id, so the keyset watermark cannot advance and the walk would loop on the '
        + 'same page forever. Refusing to return a result this read cannot bound.',
        { rowsSoFar: rows.length },
      );
    }
    watermark = next;

    // eslint-disable-next-line no-await-in-loop
    const total = await knownTotal();
    if (total != null && rows.length >= total) { exhausted = true; terminator = 'aggregate-total'; break; }
  }

  return { rows, pages, exhausted, terminator };
}

/**
 * Decide whether a finished walk may call itself complete.
 *
 * Pure, and separate from the walk, because "did the loop end properly" and
 * "does the answer agree with the instance's own count" are two questions and
 * C-1 was the first being mistaken for the second.
 */
export function reconcileWalk({ collected, expectedTotal, exhausted }) {
  const shortfall = expectedTotal == null ? null : expectedTotal - collected;
  const materialGap = shortfall != null && Math.abs(shortfall) > COUNT_DRIFT_TOLERANCE;
  return { complete: exhausted && !materialGap, truncated: !(exhausted && !materialGap), shortfall, materialGap };
}

/**
 * Page a metadata query to exhaustion, or to `max` — and say which happened.
 *
 * ── WHY THIS IS KEYSET PAGING AND NOT `sysparm_offset` (finding C-1) ─────────
 *
 * The first version of this loop stopped when a page came back SHORTER than the
 * limit it asked for, on the reasoning that the Table API gives no other
 * end-of-results signal. MEASURED on dev428633, that reasoning is wrong:
 *
 *   sys_dictionary?reference=sys_user, sysparm_limit=1000
 *     offset    0 -> 1000      offset 3000 ->  999   <-- SHORT, and NOT the end
 *     offset 1000 -> 1000      offset 4000 ->  402
 *     offset 2000 -> 1000      offset 5000 ->    0   <-- the actual end
 *
 * Stopping at the 999 returned 3999 rows and reported `truncated: false` —
 * 403 rows lost and the answer asserted complete, which is this module's own
 * contract ("a floor is never reported as a total") violated in the primitive
 * every other layer reads through.
 *
 * Three things changed, and each is load-bearing:
 *
 *   1. ONLY AN EMPTY PAGE ENDS THE WALK. A short page is not a terminator on
 *      this API. The one other legitimate stop is reaching the authoritative
 *      total below, which is a positive signal rather than an inference.
 *
 *   2. KEYSET, NOT OFFSET. Ordering by `sys_id` ascending and carrying a
 *      `sys_id>{last seen}` watermark is ServiceNow's documented shape for
 *      walking a large result: offset paging without a stable indexed sort has
 *      no defined row order between requests, so rows can repeat or be skipped,
 *      and every page re-scans the ones before it. Keyset is correct AND
 *      cheaper, and it makes "empty page" the natural terminator rather than a
 *      guess. (Measured: the same walk keyset-paged yields 4401 rows, 4401 of
 *      them distinct — no duplicates, no overlap.)
 *
 *   3. RECONCILED AGAINST AN AUTHORITATIVE TOTAL. /api/now/stats answers a real
 *      count for the same query, so the walk no longer has to trust itself. The
 *      count is issued CONCURRENTLY with the first page, so reconciliation
 *      costs a request but not a round trip. `complete` is true only when the
 *      rows collected and that total agree within COUNT_DRIFT_TOLERANCE.
 *
 * The returned array carries `truncated` (unchanged meaning: this is a floor)
 * and now also `complete`, `expectedTotal` and `shortfall`. A caller that
 * reports a count without checking them is reporting a floor as a total.
 */
export async function metaQuery(t, { query = '', fields, max = DEFAULT_MAX, display = 'false', orderBy } = {}) {
  assertRestReachable(t);
  if (orderBy) {
    // Not "ignored": a caller who asked for an order and silently did not get
    // one would read the first N rows of the wrong sort as an answer.
    throw new DbaMetadataError(
      `metaQuery cannot honour orderBy=${orderBy}: it pages by keyset on sys_id ascending, and a second sort key `
      + 'would break the watermark that makes the walk exhaustive. Sort the returned rows, or page by hand.',
      { table: t, orderBy },
    );
  }
  if (!(max >= 1)) {
    throw new DbaMetadataError(`metaQuery was asked for max=${max} rows, which cannot be a result.`, { table: t, max });
  }

  /*
   * The watermark is read off `sys_id`, so every page must carry it — including
   * when the caller asked for a narrower projection. It is added to the request
   * and stripped from the rows afterwards, so a caller that did not ask for
   * sys_id does not silently start receiving it.
   */
  const asked = fields ? String(fields).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const sysIdBorrowed = Boolean(asked?.length) && !asked.includes('sys_id');
  const pageFields = sysIdBorrowed ? [...asked, 'sys_id'].join(',') : fields;

  /*
   * A `max: 1` read is an existence probe: one row means "hit the ceiling, this
   * is a floor" and zero rows means "no match", both already honest without an
   * aggregate. Everything larger is a read whose COUNT may be reported, so it
   * pays for the reconciliation.
   */
  const totalPromise = max > 1
    ? table.count(t, query).then((n) => (Number.isFinite(n) ? n : null), () => null)
    : Promise.resolve(null);

  const { rows: out, pages, exhausted, terminator } = await pageAll({
    max,
    fetchPage: ({ after, limit }) => table.query(t, {
      query: after ? `${query ? `${query}^` : ''}sys_id>${after}` : query,
      fields: pageFields,
      limit,
      offset: 0,
      display,
      orderBy: 'sys_id',
    }),
    knownTotal: () => totalPromise,
    onFirstPage: (firstPage) => assertFieldsHonoured(t, fields, firstPage),
  });

  if (sysIdBorrowed) for (const row of out) delete row.sys_id;

  const expectedTotal = await totalPromise;
  const { complete, shortfall, materialGap } = reconcileWalk({ collected: out.length, expectedTotal, exhausted });

  // The LOG line is reserved for a scan that hit the ceiling unintentionally —
  // a deliberate `max: 1` lookup is not news, and warning on it trains the
  // reader to ignore the warning that matters.
  if (!exhausted && max >= PAGE) {
    log.warn('dba', `${t} query hit the ${max}-row ceiling and is TRUNCATED — the result is a floor, not a total`);
  }
  if (materialGap) {
    log.warn('dba', `${t} query collected ${out.length} rows but /api/now/stats counts ${expectedTotal} for the same `
      + `query — a gap of ${shortfall}. Reported INCOMPLETE; do not quote ${out.length} as a total.`);
  }

  return Object.assign(out, {
    // Unchanged meaning, so every existing caller keeps working: true == floor.
    truncated: !complete,
    complete,
    pages,
    terminator: exhausted ? terminator : 'ceiling',
    expectedTotal,
    reconciled: expectedTotal != null,
    ...(shortfall ? { shortfall } : {}),
    ...(materialGap
      ? {
        incompleteReason: `Collected ${out.length} rows; the aggregate count for the same query is ${expectedTotal}. `
          + `A gap of ${shortfall} row(s) is larger than the ${COUNT_DRIFT_TOLERANCE}-row live-drift tolerance, so `
          + 'this is a FLOOR, not a total.',
      }
      : {}),
    ...(shortfall && !materialGap
      ? {
        countDrift: shortfall,
        countDriftNote: `The aggregate count and the paged rows differ by ${shortfall}, within the `
          + `${COUNT_DRIFT_TOLERANCE}-row tolerance. Measured cause on this instance: /api/now/stats and the Table `
          + 'API do not apply row-level ACLs identically. The rows are complete.',
      }
      : {}),
    ...(expectedTotal == null
      ? {
        totalUnavailable: 'No aggregate count could be read for this query, so the walk was reconciled against '
          + 'nothing but its own empty terminating page.',
      }
      : {}),
  });
}

/**
 * A TTL cache that a write path cannot accidentally read.
 *
 * Guardrail §6: "Cache never drives a write; writes re-read live metadata
 * first." Enforced structurally — `forWrite` bypasses the cache and refreshes
 * it — rather than by asking every write to remember a flag it could forget.
 */
const DEFAULT_TTL_MS = 5 * 60_000;
const store = new Map();

export function cacheClear(prefix = null) {
  if (!prefix) { store.clear(); return; }
  for (const k of [...store.keys()]) if (k.startsWith(prefix)) store.delete(k);
}

export function cacheStats() {
  const now = Date.now();
  return { entries: store.size, live: [...store.values()].filter((e) => e.expiresAt > now).length };
}

export async function cached(key, producer, { ttlMs = DEFAULT_TTL_MS, forWrite = false, refresh = false } = {}) {
  if (!forWrite && !refresh) {
    const hit = store.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }
  const value = await producer();
  store.set(key, { value, expiresAt: Date.now() + ttlMs, freshAt: Date.now() });
  return value;
}

// B5 — the DBA metadata cache is per instance; the switch handler empties it.
registerInstanceScopedCache('dba-metadata-cache', () => cacheClear());
