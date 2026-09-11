import { table, SnowError } from '../servicenow/client.js';
import { TABLES } from './tables.js';

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

function coverageOf(tableName, records, pages, reportedTotal, missingFields, status, cutoff) {
  return {
    table: tableName,
    status,
    records: records.length,
    reported_total: reportedTotal,
    pages,
    missing_fields: [...missingFields].sort(),
    cutoff,
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
   * The reported total comes from the Aggregate API, and a failure to get one
   * is NOT a failure to extract: some tables answer 403 to stats while
   * answering the Table API fine. `null` then means "unknown", and completeness
   * falls back to the short-page test rather than being asserted.
   */
  let reportedTotal = null;
  try {
    reportedTotal = await client.count(tableName, `sys_updated_on<=${cutoff}`);
  } catch { /* unknown total; handled below */ }

  const records = [];
  const seen = new Set();
  const missingFields = new Set();
  let offset = 0;
  let pages = 0;

  /*
   * An explicit page budget, and the loop is bounded BY it rather than by
   * reasoning about the exits.
   *
   * Every exit below is reachable in normal operation, so a `for (;;)` would
   * terminate — but "it terminates if you trace it" is exactly the argument
   * that stops being true after someone edits one of the conditions. The budget
   * is the number of pages it would take to reach `limit`, plus one to observe
   * the end; exhausting it means the platform is not advancing the way paging
   * assumes, and the correct answer to that is to REFUSE rather than to return
   * a partial result that looks complete.
   */
  const maxPages = Math.ceil(limit / pageSize) + 1;

  for (; pages <= maxPages; ) {
    const size = Math.min(pageSize, limit - records.length);
    if (size <= 0) {
      return { records, coverage: coverageOf(tableName, records, pages, reportedTotal, missingFields, 'truncated', cutoff) };
    }

    const rows = await client.query(tableName, {
      query: `sys_updated_on<=${cutoff}^ORDERBYsys_id`,
      fields: spec.fields.join(','),
      limit: size,
      offset,
      display: 'false',
    });
    pages += 1;

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
      if (seen.has(sid)) {
        throw Object.assign(
          new Error(`${tableName}: the same sys_id appeared on two pages. Rows are being written while the extract runs, so this snapshot would double-count — retry.`),
          { status: 503 },
        );
      }
      seen.add(sid);
      records.push(row);
    }

    const done = rows.length < size
      || (reportedTotal != null && records.length >= reportedTotal)
      || records.length >= limit;
    if (done) {
      /*
       * `complete` is the strongest claim this module makes and the absence
       * rules key off it, so it is withheld whenever anything was dropped: a
       * field the API did not return, or fewer rows than the platform's own
       * count. Degrading to `limited` costs a few rules; claiming `complete`
       * wrongly costs the user a page of invented findings.
       */
      const short = reportedTotal != null && records.length < reportedTotal;
      const status = missingFields.size || short ? 'limited' : 'complete';
      return { records, coverage: coverageOf(tableName, records, pages, reportedTotal, missingFields, status, cutoff) };
    }
    offset += size;
  }

  throw Object.assign(
    new Error(`${tableName}: the pagination budget of ${maxPages} pages was exhausted without reaching the end. `
      + 'Refusing to return a result this read cannot bound — it would look complete and would not be.'),
    { status: 503 },
  );
}

/**
 * Read every requested table.
 *
 * A non-required table that fails is recorded with its reason and the run
 * continues — a PDI without ITOM should still get a CMDB report. A required
 * table failing ends the run, because every downstream number would be a
 * fraction of an estate nobody could see.
 */
export async function extractEstate(tableNames, { cutoff, onProgress, limit, client } = {}) {
  const estate = {};
  const coverage = {};
  const stamp = cutoff || new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (let i = 0; i < tableNames.length; i++) {
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
