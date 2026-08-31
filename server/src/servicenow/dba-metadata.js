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
 * Page a metadata query to exhaustion, or to `max` — and say which happened.
 *
 * The returned array carries `truncated`. A caller that reports a count without
 * checking it is reporting a floor as a total.
 */
export async function metaQuery(t, { query = '', fields, max = DEFAULT_MAX, display = 'false', orderBy } = {}) {
  assertRestReachable(t);
  const out = [];
  for (let offset = 0; offset < max; offset += PAGE) {
    const limit = Math.min(PAGE, max - offset);
    // eslint-disable-next-line no-await-in-loop
    const page = await table.query(t, { query, fields, limit, offset, display, orderBy });
    if (offset === 0) assertFieldsHonoured(t, fields, page);
    out.push(...page);
    // A short page is the end of the result set — the only reliable signal the
    // Table API gives, since it reports no total.
    if (page.length < limit) return Object.assign(out, { truncated: false });
  }
  // `truncated` is always reported, because asking for N and getting N genuinely
  // does not prove there were only N. The LOG line is reserved for a scan that
  // hit the ceiling unintentionally — a deliberate `max: 1` lookup is not news,
  // and warning on it trains the reader to ignore the warning that matters.
  if (max >= PAGE) {
    log.warn('dba', `${t} query hit the ${max}-row ceiling and is TRUNCATED — the result is a floor, not a total`);
  }
  return Object.assign(out, { truncated: true });
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
