import { table, SnowError } from '../servicenow/client.js';
import { TABLES } from './tables.js';
import { pageAll } from '../servicenow/dba-metadata.js';

/**
 * Extraction — rows off the instance, plus an honest account of what was missed.
 *
 * This goes through `servicenow/client.js` like every other read in this app.
 * SAOS shipped its own HTTP client with its own credentials, retry policy and
 * OAuth cache; reusing it here would have created a SECOND path that talks to
 * the instance, which ARCHITECTURE §16.2 exists to prevent. One funnel means
 * one place where auth, error normalisation and the scope read-back live.
 *
 * What is kept from SAOS is the part that has nothing to do with transport:
 * COVERAGE. Every table comes back with a descriptor saying how completely it
 * was read, and the rule pack refuses to run absence rules on anything less
 * than `complete`. Without that, an ACL that hides half the relationship table
 * turns into a page full of "orphaned CI" findings.
 */

/** Coverage statuses that mean rows are usable. Anything else is a reason, not a count. */
export const USABLE = Object.freeze(['complete', 'limited', 'truncated']);

const PAGE_SIZE = 500;
const MAX_PER_TABLE = 100_000;

/**
 * Map a transport failure onto a coverage status.
 *
 * These are the words the UI renders, so they have to distinguish "you may not
 * read this" from "this does not exist here" from "it broke". A PDI without
 * ITOM has no `ecc_agent` table at all, and reporting that as a permission
 * problem would send someone to fix ACLs that are already correct.
 */
export function classifyFailure(err) {
  const status = err?.status ?? err?.response?.status ?? null;
  const message = String(err?.message || '');

  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'unavailable';
  if (status === 429) return 'rate_limited';
  if (status === 400) {
    /*
     * A table that is not on this instance answers 400, not 404.
     *
     * Measured on dev424910: `em_alert` on a PDI without Event Management comes
     * back `400 Invalid table em_alert`. Classifying that as `invalid_query`
     * reads as "Health Assist sent something malformed" and sends a reader to
     * debug a query that is fine — when the real answer is "this instance does
     * not have that table". Those are the two states this module exists to keep
     * apart, so the platform's own wording decides.
     */
    if (/invalid table/i.test(message)) return 'unavailable';
    return 'invalid_query';
  }
  return 'upstream_error';
}

/** A failure that should stop the whole run rather than degrade it. */
export function isFatal(code, spec) {
  return Boolean(spec?.required) || ['unauthorized', 'not_configured'].includes(code);
}

/**
 * A coverage descriptor.
 *
 * `rows_complete` and `status` answer DIFFERENT questions, and conflating them
 * was a real defect. Measured on techsnitchpvtltddemo2: `cmdb_ci` read 3,412 of
 * 3,412 rows, but `business_criticality` does not exist on that instance, so the
 * table was `limited` — and the CMDB score, which needs every CI ROW and has no
 * use for that field, was withheld. Any instance missing any one field in a
 * spec would have lost its score for ever.
 *
 *   rows_complete — every row the platform counts was read
 *   missing_fields — which requested fields the API did not return
 *   status        — `complete` only when both hold; `limited` otherwise
 *
 * A rule that needs the whole row SET keys off `rows_complete`. A rule that
 * needs a particular FIELD checks `missing_fields` as well. `status` stays the
 * strictest summary for display.
 */
function coverageOf(tableName, records, pages, reportedTotal, missingFields, status, cutoff, extra = {}) {
  return {
    table: tableName,
    status,
    rows_complete: extra.rowsComplete ?? status === 'complete',
    completeness_basis: extra.basis ?? null,
    records: records.length,
    reported_total: reportedTotal,
    pages,
    missing_fields: [...missingFields].sort(),
    cutoff,
    filter: extra.filterLabel ?? null,
    scope: 'Records visible to the connected account; ACL and domain restrictions may hide records',
  };
}

/**
 * Read one table completely, or say why not.
 *
 * The cutoff pins the read to a single instant so two tables fetched a minute
 * apart still describe the same estate. The Table API is not a transactionally
 * consistent snapshot across tables and the manifest says so — the cutoff
 * narrows the window rather than closing it.
 */
export async function fetchTable(tableName, { cutoff, limit = MAX_PER_TABLE, pageSize = PAGE_SIZE, client = table } = {}) {
  const spec = TABLES[tableName];
  if (!spec) {
    throw Object.assign(new Error(`${tableName} is not in the Health Assist allow-list`), { status: 422 });
  }

  /*
   * A spec may narrow the slice — ITSM tables read active records plus recent
   * ones rather than every incident since the instance was built. The SAME
   * condition goes into the count, or `records < reported_total` would be true
   * on every run and the table would never be complete.
   */
  const narrowing = typeof spec.filter === 'function' ? spec.filter(cutoff) : (spec.filter || '');
  const where = `sys_updated_on<=${cutoff}${narrowing ? `^${narrowing}` : ''}`;

  /*
   * The reported total comes from the Aggregate API, and a failure to get one
   * is NOT a failure to extract: some tables answer 403 to stats while
   * answering the Table API fine. `null` then means "unknown", and completeness
   * falls back to the short-page test rather than being asserted.
   */
  let reportedTotal = null;
  try {
    reportedTotal = await client.count(tableName, where);
  } catch { /* unknown total; handled below */ }

  const records = [];
  const seen = new Set();
  const missingFields = new Set();

  /*
   * A KEYSET WALK, not offset paging — the same walk the DBA module uses.
   *
   * Two failures, both measured on techsnitchpvtltddemo2, pushed it here:
   *
   *  1. A short page is not the end. ServiceNow drops ACL-hidden rows from
   *     INSIDE a page, so `sys_script` stopped at 998 of 14,059 when the pager
   *     read "fewer than 500" as "no more". The DBA module had already hit the
   *     same thing as its finding C-1; only an EMPTY page ends this walk.
   *  2. Offsets move under concurrent writes. Paging on by offset exposed that
   *     `sys_script` (14,059 → 14,250 in two days) and `sysauto` are written
   *     while they are read: one insert ahead of the current offset shifts every
   *     later row, the same sys_id lands on two pages, and the whole table was
   *     thrown away. Paging by `sys_id > watermark` cannot shift — each page
   *     starts after the last row actually seen, whatever changed elsewhere.
   *
   * The walk is bounded by `limit` rows. A table it cannot finish is reported
   * as `truncated`, never as complete.
   */
  const walk = await pageAll({
    pageSize,
    max: limit,
    knownTotal: async () => reportedTotal,
    fetchPage: async ({ after, limit: size }) => {
      const rows = await client.query(tableName, {
        query: `${where}${after ? `^sys_id>${after}` : ''}^ORDERBYsys_id`,
        fields: spec.fields.join(','),
        limit: size,
        offset: 0,
        display: 'false',
      });
      for (const row of rows) {
        /*
         * `sysparm_fields` DROPS names the table does not have, with no error
         * (trap #4). So the difference between what was asked for and what came
         * back is recorded per table — a rule needing a field that was never
         * returned is then skipped loudly instead of reading undefined.
         */
        for (const field of spec.fields) if (!(field in row)) missingFields.add(field);

        const sid = row.sys_id;
        if (typeof sid !== 'string' || !sid) {
          throw Object.assign(
            new Error(`${tableName}: a row came back with no sys_id. A field ACL is hiding identity, so nothing from this table can be addressed.`),
            { status: 502 },
          );
        }
        /*
         * Under a keyset walk a repeat is not concurrency any more — every page
         * starts strictly after the last sys_id seen. A repeat means the
         * instance ignored the `sys_id >` condition, and the walk would page the
         * same rows until its limit. That is refused rather than stored.
         */
        if (seen.has(sid)) {
          throw Object.assign(
            new Error(`${tableName}: the same sys_id appeared on two pages even though each page starts after the last row read, so the instance is not honouring the paging condition and this read cannot be bounded.`),
            { status: 502 },
          );
        }
        seen.add(sid);
      }
      return rows;
    },
  });
  records.push(...walk.rows);

  if (walk.terminator === 'ceiling' && !walk.exhausted) {
    return {
      records,
      coverage: coverageOf(tableName, records, walk.pages, reportedTotal, missingFields, 'truncated', cutoff,
        { rowsComplete: false, basis: 'limit', filterLabel: spec.filterLabel }),
    };
  }

  /*
   * `complete` is the strongest claim this module makes, so it needs both
   * halves: every counted row, and every requested field. The row half is
   * published separately as `rows_complete`, because the scores and the
   * absence rules need only that half.
   */
  const rowsComplete = reportedTotal != null ? records.length >= reportedTotal : walk.exhausted;
  const status = rowsComplete && !missingFields.size ? 'complete' : 'limited';
  return {
    records,
    coverage: coverageOf(tableName, records, walk.pages, reportedTotal, missingFields, status, cutoff, {
      rowsComplete,
      basis: reportedTotal != null ? 'reported_total' : 'empty_page',
      filterLabel: spec.filterLabel,
    }),
  };
}


/**
 * Read every requested table.
 *
 * A non-required table that fails is recorded with its reason and the run
 * continues — a PDI without ITOM should still get a CMDB report. A required
 * table failing ends the run, because every downstream number would be a
 * fraction of an estate nobody could see.
 */
export async function extractEstate(tableNames, { cutoff, onProgress, limit, client, signal = null } = {}) {
  const estate = {};
  const coverage = {};
  const stamp = cutoff || new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (let i = 0; i < tableNames.length; i++) {
    /*
     * Cancellation is observed BETWEEN tables, never mid-table.
     *
     * A table half-read would be recorded with whatever coverage it happened to
     * reach, which is a snapshot nobody asked for. Stopping on a clean boundary
     * means the partial estate is still an honest description of the tables it
     * did finish.
     */
    if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });

    const name = tableNames[i];
    const spec = TABLES[name];
    await onProgress?.({ table: name, index: i, total: tableNames.length });
    try {
      const { records, coverage: cov } = await fetchTable(name, { cutoff: stamp, limit, client });
      estate[name] = records;
      coverage[name] = cov;
    } catch (err) {
      const code = err instanceof SnowError || err?.status ? classifyFailure(err) : 'upstream_error';
      coverage[name] = {
        table: name,
        status: code,
        rows_complete: false,
        records: null,
        reported_total: null,
        pages: 0,
        missing_fields: [],
        cutoff: stamp,
        error: err?.message || String(err),
      };
      if (isFatal(code, spec)) throw err;
    }
  }

  /* Tables nobody asked for are reported as such. "Not requested" and "zero
     rows" look identical in a results table and mean opposite things. */
  for (const name of Object.keys(TABLES)) {
    if (!(name in coverage)) {
      coverage[name] = { table: name, status: 'not_requested', records: null, reported_total: null, pages: 0, missing_fields: [], cutoff: stamp };
    }
  }

  return { estate, coverage, cutoff: stamp };
}
