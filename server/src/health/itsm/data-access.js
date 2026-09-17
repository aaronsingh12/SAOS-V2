import { table as instanceClient, SnowError } from '../../servicenow/client.js';
import { pageAll } from '../../servicenow/dba-metadata.js';
import { classifyFailure } from '../extract.js';

/**
 * ITSM PHASE 3 — declared data requirements, and reads that account for themselves.
 *
 * The existing extractor (`health/extract.js`) reads whole allow-listed tables
 * into memory with a fixed field list per table. That is right for the CMDB
 * rules, which judge every CI against every other, and wrong for most of the
 * ITSM catalogue: a rule about empty backout plans does not need the backout
 * plan TEXT of 100,000 changes, it needs the sys_ids of the ones where it is
 * empty — an encoded query and a field list of one.
 *
 * So an engine DECLARES what it needs — table, fields, query, strategy, how
 * complete the read has to be — and the read comes back with the same coverage
 * vocabulary `extract.js` uses (`complete | limited | truncated | forbidden …`)
 * plus the fields a caller needs to decide whether a finding built on it can be
 * trusted: `isComplete`, `rowsFetched`, `totalKnown`, `query`, `pageCount`,
 * `truncated`, `missingFields`.
 *
 * Strategies:
 *   rows       every matching row, the declared fields, keyset-paged
 *   ids        sys_id only (plus `keep` fields) — the ISEMPTY pattern: push the
 *              predicate into the query and never retrieve the text
 *   aggregate  the Aggregate API: counts / avg / sum per group, no rows at all
 *   exists     does at least one row match? one count, no rows
 *
 * Reads go through `servicenow/client.js` like every other read in this app;
 * the client is injectable so the suite runs without an instance.
 */

export const STRATEGIES = Object.freeze(['rows', 'ids', 'aggregate', 'exists']);
export const COMPLETENESS = Object.freeze(['complete', 'usable']);
export const USABLE_STATUSES = Object.freeze(['complete', 'limited', 'truncated']);

export const DEFAULT_PAGE_SIZE = 500;
export const DEFAULT_MAX_ROWS = 100_000;

export class DataRequirementError extends Error {
  constructor(message, detail = null) { super(message); this.name = 'DataRequirementError'; this.detail = detail; }
}

const IDENTITY_FIELDS = ['sys_id'];

/**
 * Validate and freeze a requirement. Fields are always de-duplicated and
 * `sys_id` is always present (identity — a row without one cannot be addressed).
 */
export function declareRequirement({
  table, fields = [], query = '', strategy = 'rows', pageSize = DEFAULT_PAGE_SIZE, maxRows = DEFAULT_MAX_ROWS,
  completeness = 'usable', keep = [], groupBy = [], avg = [], sum = [], min = [], max = [], sensitive = [], label = null,
} = {}) {
  if (!table || typeof table !== 'string') throw new DataRequirementError('a requirement needs a table');
  if (!STRATEGIES.includes(strategy)) throw new DataRequirementError(`strategy "${strategy}" is not one of ${STRATEGIES.join(', ')}`);
  if (!COMPLETENESS.includes(completeness)) throw new DataRequirementError(`completeness "${completeness}" is not one of ${COMPLETENESS.join(', ')}`);
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new DataRequirementError('pageSize must be a positive integer');
  if (!Number.isInteger(maxRows) || maxRows < 1) throw new DataRequirementError('maxRows must be a positive integer');
  const list = (xs) => [...new Set((Array.isArray(xs) ? xs : [xs]).filter(Boolean))];
  const declared = strategy === 'ids' ? [...IDENTITY_FIELDS, ...list(keep)] : [...IDENTITY_FIELDS, ...list(fields)];
  return Object.freeze({
    table, strategy, query: String(query || ''), pageSize, maxRows, completeness, label,
    fields: Object.freeze(declared),
    groupBy: Object.freeze(list(groupBy)), avg: Object.freeze(list(avg)), sum: Object.freeze(list(sum)),
    min: Object.freeze(list(min)), max: Object.freeze(list(max)),
    /* Fields whose VALUES must never leave the server in evidence (free text that may hold identifiers). */
    sensitive: Object.freeze(list(sensitive)),
  });
}

/** The coverage descriptor every read returns. */
export function coverageOf(req, {
  status, rowsFetched = 0, totalKnown = null, pageCount = 0, truncated = false, missingFields = [], error = null, ms = 0, basis = null,
} = {}) {
  const rowsComplete = status === 'complete' || (status === 'limited' && totalKnown != null && rowsFetched >= totalKnown && !truncated);
  return Object.freeze({
    table: req.table,
    strategy: req.strategy,
    query: req.query,
    fields: req.fields,
    status,
    isComplete: status === 'complete',
    rowsComplete,
    rowsFetched,
    totalKnown,
    pageCount,
    truncated,
    missingFields: Object.freeze([...missingFields].sort()),
    completeness_basis: basis,
    error,
    ms,
  });
}

export const isUsable = (coverage) => USABLE_STATUSES.includes(coverage?.status);

/**
 * Is this read complete enough for a rule that needs `fields`? The same two
 * halves `health/rules.js isComplete()` asks: every row, and only the fields
 * the rule reads.
 */
export function isCompleteFor(coverage, fields = []) {
  if (!coverage || !coverage.rowsComplete) return false;
  const missing = new Set(coverage.missingFields || []);
  return fields.every((f) => !missing.has(f));
}

const failureStatus = (err) => (err instanceof SnowError || err?.status ? classifyFailure(err) : 'upstream_error');

/**
 * Read rows (or ids). Keyset-paged, bounded, and honest about what it got.
 */
export async function fetchRows(req, { client = instanceClient, signal = null } = {}) {
  if (!['rows', 'ids'].includes(req.strategy)) throw new DataRequirementError(`fetchRows cannot serve strategy "${req.strategy}"`);
  const t0 = Date.now();
  let totalKnown = null;
  try { totalKnown = await client.count(req.table, req.query); } catch { /* unknown total; the empty-page test decides */ }

  const missingFields = new Set();
  const seen = new Set();
  let walk;
  try {
    walk = await pageAll({
      pageSize: req.pageSize,
      max: req.maxRows,
      knownTotal: async () => totalKnown,
      fetchPage: async ({ after, limit }) => {
        if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
        const rows = await client.query(req.table, {
          query: `${req.query}${req.query ? '^' : ''}${after ? `sys_id>${after}^` : ''}ORDERBYsys_id`,
          fields: req.fields.join(','),
          limit,
          offset: 0,
          display: 'false',
        });
        for (const row of rows) {
          for (const f of req.fields) if (!(f in row)) missingFields.add(f);
          const sid = row.sys_id;
          if (typeof sid !== 'string' || !sid) throw Object.assign(new Error(`${req.table}: a row came back with no sys_id`), { status: 502 });
          if (seen.has(sid)) throw Object.assign(new Error(`${req.table}: sys_id ${sid} appeared on two pages; the paging condition is not honoured`), { status: 502 });
          seen.add(sid);
        }
        return rows;
      },
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return {
      rows: [],
      coverage: coverageOf(req, { status: failureStatus(err), totalKnown, error: err?.message || String(err), ms: Date.now() - t0 }),
    };
  }

  const rows = walk.rows;
  if (walk.terminator === 'ceiling' && !walk.exhausted) {
    return {
      rows,
      coverage: coverageOf(req, {
        status: 'truncated', rowsFetched: rows.length, totalKnown, pageCount: walk.pages, truncated: true,
        missingFields, basis: 'limit', ms: Date.now() - t0,
      }),
    };
  }
  const rowsComplete = totalKnown != null ? rows.length >= totalKnown : walk.exhausted;
  const status = rowsComplete && !missingFields.size ? 'complete' : 'limited';
  return {
    rows,
    coverage: coverageOf(req, {
      status, rowsFetched: rows.length, totalKnown, pageCount: walk.pages, truncated: false,
      missingFields, basis: totalKnown != null ? 'reported_total' : 'empty_page', ms: Date.now() - t0,
    }),
  };
}

/**
 * Aggregate. One request, no rows. `groups` is the client's normalised shape:
 * `[{ group: {field: value}, count, avg, sum, min, max }]`.
 */
export async function fetchAggregate(req, { client = instanceClient } = {}) {
  if (req.strategy !== 'aggregate') throw new DataRequirementError(`fetchAggregate cannot serve strategy "${req.strategy}"`);
  if (typeof client.aggregate !== 'function') {
    return { groups: [], coverage: coverageOf(req, { status: 'upstream_error', error: 'the client has no aggregate()' }) };
  }
  const t0 = Date.now();
  try {
    const groups = await client.aggregate(req.table, { query: req.query, groupBy: req.groupBy, avg: req.avg, sum: req.sum, min: req.min, max: req.max });
    const rowsFetched = groups.reduce((n, g) => n + (g.count || 0), 0);
    return {
      groups,
      coverage: coverageOf(req, { status: 'complete', rowsFetched, totalKnown: rowsFetched, pageCount: 1, basis: 'aggregate', ms: Date.now() - t0 }),
    };
  } catch (err) {
    return { groups: [], coverage: coverageOf(req, { status: failureStatus(err), error: err?.message || String(err), ms: Date.now() - t0 }) };
  }
}

/** Does anything match? `{ exists: true|false|null, count, coverage }` — null when the read failed. */
export async function fetchExists(req, { client = instanceClient } = {}) {
  const t0 = Date.now();
  try {
    const count = await client.count(req.table, req.query);
    return { exists: count > 0, count, coverage: coverageOf(req, { status: 'complete', rowsFetched: 0, totalKnown: count, pageCount: 1, basis: 'count', ms: Date.now() - t0 }) };
  } catch (err) {
    return { exists: null, count: null, coverage: coverageOf(req, { status: failureStatus(err), error: err?.message || String(err), ms: Date.now() - t0 }) };
  }
}

/** Dispatch on strategy. */
export async function fetchRequirement(req, opts = {}) {
  switch (req.strategy) {
    case 'rows': case 'ids': return fetchRows(req, opts);
    case 'aggregate': return fetchAggregate(req, opts);
    case 'exists': return fetchExists(req, opts);
    default: throw new DataRequirementError(`unknown strategy ${req.strategy}`);
  }
}

/**
 * A per-run read cache: the same requirement (table + query + fields +
 * strategy) is read ONCE however many rules declare it. Engines share fetched
 * data through this rather than re-querying.
 */
export function createReadCache({ client = instanceClient, signal = null } = {}) {
  const cache = new Map();
  const requests = [];   // every distinct requirement, in order — the audit trail of what a run read
  const keyOf = (req) => JSON.stringify([req.table, req.strategy, req.query, req.fields, req.groupBy, req.avg, req.sum, req.min, req.max, req.maxRows]);
  return {
    async read(req) {
      const key = keyOf(req);
      if (!cache.has(key)) { requests.push(req); cache.set(key, fetchRequirement(req, { client, signal })); }
      return cache.get(key);
    },
    size: () => cache.size,
    /** The distinct requirements this run declared — what a test proves was (or was not) read. */
    entries: () => requests.map((req) => ({ req })),
    coverage: async () => {
      const out = [];
      for (const p of cache.values()) out.push((await p).coverage);
      return out;
    },
  };
}
