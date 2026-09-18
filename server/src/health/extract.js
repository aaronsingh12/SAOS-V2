import { table, SnowError } from '../servicenow/client.js';

/** The instance client extraction reads through — for callers that plan a read before making it. */
export const instanceClient = table;
import { TABLES, sliceWhere } from './tables.js';
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
/* A read that FAILED — not a table the instance lacks or rows an ACL hides, which
   are stable facts. A result built on one is never reused (index.js degraded). */
export const FAILED_READ_STATUSES = Object.freeze(['forbidden', 'unauthorized', 'rate_limited', 'upstream_error', 'invalid_query', 'truncated']);

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
export async function fetchTable(tableName, { cutoff, limit = MAX_PER_TABLE, pageSize = PAGE_SIZE, client = table, stamp: wantStamp = false } = {}) {
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
  const where = sliceWhere(tableName, cutoff);

  /*
   * The reported total comes from the Aggregate API, and a failure to get one
   * is NOT a failure to extract: some tables answer 403 to stats while
   * answering the Table API fine. `null` then means "unknown", and completeness
   * falls back to the short-page test rather than being asserted.
   */
  let reportedTotal = null;
  /*
   * With `stamp`, the count comes from the change-stamp call — the same count
   * plus the newest sys_updated_on, in one request — taken immediately before
   * the walk. See health/incremental.js for why BEFORE is the safe order.
   */
  let changeStamp = null;
  try {
    if (wantStamp && typeof client.changeStamp === 'function') {
      const s = await client.changeStamp(tableName, where);
      reportedTotal = s.count;
      changeStamp = { count: s.count, max_updated: s.maxUpdated ?? null, basis: s.basis ?? 'sys_updated_on', taken_at: new Date().toISOString() };
    } else {
      reportedTotal = await client.count(tableName, where);
    }
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
      stamp: null,
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
    /*
     * A stamp describes a read that walked to its END. That includes a table
     * whose count exceeds what this account may see (row-level ACLs): measured
     * on dev424910, `sys_script` shows 5,729 of 5,796 on every read, so a stamp
     * that required `rows_complete` made Platform unreusable for ever. If the
     * stamp has not moved, the visible rows the rules judged have not either —
     * and a change to a hidden row moves the stamp, which only costs a re-read.
     * A read cut off by the row limit returned early and gets no stamp.
     */
    stamp: walk.exhausted ? changeStamp : null,
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
export async function extractEstate(tableNames, { cutoff, onProgress, limit, client, signal = null, stamps: wantStamps = false } = {}) {
  const estate = {};
  const coverage = {};
  /* Change stamps — each table's row count and newest sys_updated_on, taken
     immediately BEFORE it is read. See health/incremental.js for why before. */
  const stamps = {};
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
    const t0 = Date.now();
    try {
      const { records, coverage: cov, stamp: tableStamp } = await fetchTable(name, { cutoff: stamp, limit, client, stamp: wantStamps });
      estate[name] = records;
      if (tableStamp) stamps[name] = tableStamp;
      /* Timed, so a slow run names the table that made it slow. */
      coverage[name] = { ...cov, ms: Date.now() - t0 };
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
        ms: Date.now() - t0,
      };
      /* A table that cannot be read at all is stamped with HOW it failed. The
         change check fails the same way while nothing changes ("invalid table"
         on a PDI without Event Management), and differently once it does. */
      if (wantStamps) stamps[name] = { error: err?.message || String(err), status: err?.status ?? null, taken_at: new Date().toISOString() };
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

  return { estate, coverage, cutoff: stamp, stamps };
}


/* ══════════════════════════════════════════════════════════════════════════
   CMDB HEALTH GOVERNANCE META — the bounded reads the trust gate needs
   ══════════════════════════════════════════════════════════════════════════

   Group 1 of the SAOS catalogue asks questions no single table answers: which
   classes an inclusion rule REACHES (the class hierarchy), how many CIs its
   filter MATCHES (the Aggregate API), whether a health job's TRIGGER is alive,
   whether a Data Manager policy ever EXECUTED, whether the weights are even
   AUDITED. Each is a small, targeted read — never a table walk — and each
   records its own status, so a rule that needed a read that failed skips with
   that reason instead of firing on a gap.

   Read-only, through the one client, like everything else in this module. */

/**
 * WHAT THE CMDB META READS DEPEND ON, as change-checkable slices.
 *
 * A CMDB result can be reused only if nothing it was computed from changed —
 * and it is computed from these reads as well as from the tables. Each entry
 * names the table and the narrowest slice that covers what `extractCmdbMeta`
 * reads from it. Reads against CI CLASS tables (virtual, used_for, class
 * attributes, inclusion filters) are not listed: a CI is one record across its
 * class hierarchy, so any change to it moves `cmdb_ci`'s own stamp.
 *
 * Kept beside the reads it describes, and pinned by a test that runs the meta
 * extractor against a recording client: a new read against a table not covered
 * here fails that test rather than silently escaping the change check.
 */
export function cmdbMetaSources(estate = {}) {
  const jobIds = (estate.sysauto_script || []).map((j) => j.sys_id).filter(Boolean);
  const classes = [...new Set((estate.cmdb_ci || []).map((c) => c.sys_class_name).filter((c) => c && !c.startsWith('cmdb')))];
  const lookupTables = [...new Set((estate.cmdb_identifier_entry || []).map((e) => e.table)
    .filter((t) => t && !t.startsWith('cmdb_ci') && !TABLES[t]))];
  return [
    { key: 'class_hierarchy', table: 'sys_db_object', query: 'nameSTARTSWITHcmdb' },
    { key: 'dictionary', table: 'sys_dictionary', query: 'nameSTARTSWITHcmdb' },
    ...(classes.length ? [
      { key: 'class_hierarchy_custom', table: 'sys_db_object', query: `nameIN${classes.join(',')}` },
      { key: 'dictionary_custom', table: 'sys_dictionary', query: `nameIN${classes.join(',')}` },
    ] : []),
    { key: 'used_for_defaults', table: 'sys_dictionary', query: 'element=used_for' },
    /* Custom attributes somebody added to a CMDB class (CMDB-119, CMDB-123). A
       targeted read: `u_` elements only, so it stays small on every estate. */
    { key: 'custom_fields', table: 'sys_dictionary', query: 'nameSTARTSWITHcmdb^elementSTARTSWITHu_' },
    { key: 'choices', table: 'sys_choice', query: 'nameSTARTSWITHcmdb^elementINinstall_status,operational_status,discovery_source^ORnameSTARTSWITHalm_^elementINinstall_status,substatus' },
    /* Audit rows are only ever inserted, and carry no sys_updated_on: the count decides. */
    { key: 'audit', table: 'sys_audit', query: 'tablenameSTARTSWITHcmdb' },
    { key: 'health_result', table: 'cmdb_health_result', query: '' },
    ...(jobIds.length ? [{ key: 'job_triggers', table: 'sys_trigger', query: `document_keyIN${jobIds.join(',')}` }] : []),
    { key: 'policy_executions', table: 'cmdb_data_management_policy_execution', query: '' },
    { key: 'change_impact', table: 'task_cmdb_ci_service', query: '' },
    ...lookupTables.map((t) => ({ key: `identity_lookup:${t}`, table: t, query: 'cmdb_ciISNOTEMPTY' })),
  ];
}

const META_CHUNK = 50;
const chunks = (xs, n = META_CHUNK) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export async function extractCmdbMeta(estate, { client = table, signal = null } = {}) {
  const reads = {};
  const meta = { reads };
  const attempt = async (key, fn) => {
    if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
    /* Timed, so a slow run says which read was slow instead of leaving it to be guessed. */
    const t0 = Date.now();
    try {
      await fn();
      reads[key] = { status: 'ok', ms: Date.now() - t0 };
    } catch (err) {
      reads[key] = { status: err instanceof SnowError || err?.status ? classifyFailure(err) : 'upstream_error', error: err?.message || String(err), ms: Date.now() - t0 };
    }
  };

  /* Newest health result and the total — what the dashboard would be showing. */
  await attempt('health_result', async () => {
    const count = await client.count('cmdb_health_result', '');
    const newest = await client.query('cmdb_health_result', {
      query: 'ORDERBYDESCsys_updated_on', fields: 'sys_updated_on', limit: 1, offset: 0, display: 'false',
    });
    meta.healthResult = { count, newest: newest?.[0]?.sys_updated_on ?? null };
  });

  /* The class hierarchy, walked upward from every populated class and every
     class an inclusion rule targets. Bounded by the depth of the CMDB tree. */
  const configs = estate.cmdb_health_config || [];
  const wanted = new Set([
    ...(estate.cmdb_ci || []).map((c) => c.sys_class_name).filter(Boolean),
    ...configs.map((c) => c.applies_to).filter(Boolean),
  ]);
  await attempt('class_hierarchy', async () => {
    const byName = {};
    let frontier = [...wanted];
    for (let depth = 0; frontier.length && depth < 25; depth++) {
      const next = new Set();
      for (const part of chunks(frontier)) {
        const rows = await client.query('sys_db_object', {
          query: `nameIN${part.join(',')}`, fields: 'sys_id,name,super_class.name,sys_created_on', limit: part.length + 5, offset: 0, display: 'false',
        });
        for (const r of rows) {
          const parent = r['super_class.name'] || null;
          byName[r.name] = { sys_id: r.sys_id, super: parent, created: r.sys_created_on || null };
          if (parent && !byName[parent]) next.add(parent);
        }
      }
      frontier = [...next].filter((n) => !byName[n]);
    }
    meta.classes = { byName };
  });

  /* Custom attributes on CMDB classes — the only dictionary rows CMDB-119 and
     CMDB-123 need, read as a narrow slice rather than the whole dictionary. */
  await attempt('custom_fields', async () => {
    meta.customFields = await client.query('sys_dictionary', {
      query: 'nameSTARTSWITHcmdb^elementSTARTSWITHu_^elementISNOTEMPTY',
      fields: 'name,element,internal_type', limit: 5000, offset: 0, display: 'false',
    });
  });

  /* Mandatory dictionary fields on those classes and their ancestors. */
  await attempt('mandatory_fields', async () => {
    const names = Object.keys(meta.classes?.byName || {});
    if (reads.class_hierarchy?.status !== 'ok') throw Object.assign(new Error('the class hierarchy was not read'), { status: 424 });
    const mandatory = {};
    for (const part of chunks(names)) {
      const rows = await client.query('sys_dictionary', {
        query: `nameIN${part.join(',')}^mandatory=true^elementISNOTEMPTY^elementNOT LIKEsys_`,
        fields: 'name,element', limit: 1000, offset: 0, display: 'false',
      });
      for (const r of rows) (mandatory[r.name] ||= []).push(r.element);
    }
    meta.mandatory = mandatory;
  });

  /* How many CIs each inclusion rule's filter matches (CMDB-002). */
  await attempt('config_matches', async () => {
    const out = {};
    for (const c of configs.slice(0, 200)) {
      if (!c.applies_to) { out[c.sys_id] = null; continue; }
      out[c.sys_id] = await client.count(c.applies_to, c.active_record_condition || '');
    }
    meta.configMatches = out;
  });

  /* Triggers for the CMDB Health jobs (CMDB-007). */
  const jobIds = (estate.sysauto_script || []).map((j) => j.sys_id);
  await attempt('job_triggers', async () => {
    const rows = [];
    for (const part of chunks(jobIds)) {
      rows.push(...await client.query('sys_trigger', {
        query: `document_keyIN${part.join(',')}`, fields: 'name,state,next_action,document_key', limit: 500, offset: 0, display: 'false',
      }));
    }
    meta.jobTriggers = rows;
  });

  /* Execution counts for Data Manager policies with an execution job (CMDB-010). */
  const policies = (estate.cmdb_data_management_policy || []).filter((p) => p.policy_execution_job);
  await attempt('policy_executions', async () => {
    const out = {};
    for (const p of policies.slice(0, 200)) {
      out[p.sys_id] = await client.count('cmdb_data_management_policy_execution', `cmdb_policy=${p.sys_id}`);
    }
    meta.policyExecutions = out;
  });

  /* Whether metric weights are audited at all, and if so how many changes (CMDB-011). */
  await attempt('pref_audit', async () => {
    const coll = await client.query('sys_dictionary', {
      query: 'name=cmdb_health_metric_pref^internal_type=collection', fields: 'audit,attributes', limit: 1, offset: 0, display: 'false',
    });
    const audited = coll?.[0] ? (String(coll[0].audit) === 'true' || /(^|,)audit=true/.test(String(coll[0].attributes || ''))) : false;
    const entries = audited
      ? await client.count('sys_audit', 'tablename=cmdb_health_metric_pref^fieldname=weighted_average_contribution')
      : null;
    meta.prefAudit = { audited, entries };
  });

  /* ── GROUP 2 (Completeness), CMDB-140 and CMDB-141 ────────────────────── */

  const byName = meta.classes?.byName || {};
  const lineage = (cls) => {
    const out = [];
    const seen = new Set();
    let at = cls;
    while (at && !seen.has(at)) { seen.add(at); out.push(at); at = byName[at]?.super ?? null; }
    return out;
  };
  const populated = [...new Set((estate.cmdb_ci || []).map((c) => c.sys_class_name).filter(Boolean))];
  const countOf = (cls) => (estate.cmdb_ci || []).filter((c) => c.sys_class_name === cls).length;
  const baseFields = new Set(TABLES.cmdb_ci.fields);
  const hierarchyOk = reads.class_hierarchy?.status === 'ok';
  const needHierarchy = () => {
    if (!hierarchyOk) throw Object.assign(new Error('the class hierarchy was not read'), { status: 424 });
  };
  const activeTruthy = (v) => ['true', '1'].includes(String(v).toLowerCase());
  const splitAttrs = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

  /* Virtual computers — CMDB-012 excludes them. `virtual` lives on cmdb_ci_computer. */
  await attempt('virtual', async () => {
    const total = await client.count('cmdb_ci_computer', 'virtual=true');
    const rows = total
      ? await client.query('cmdb_ci_computer', { query: 'virtual=true', fields: 'sys_id', limit: Math.min(total, 100000), offset: 0, display: 'false' })
      : [];
    if (rows.length < total) throw Object.assign(new Error(`only ${rows.length} of ${total} virtual computers could be read`), { status: 206 });
    meta.virtualIds = rows.map((r) => r.sys_id);
  });

  /* used_for, per class — it exists only on child classes (servers, applications…). */
  await attempt('used_for', async () => {
    needHierarchy();
    const defs = await client.query('sys_dictionary', { query: 'element=used_for', fields: 'name,default_value', limit: 5000, offset: 0, display: 'false' });
    const defining = new Set(defs.map((d) => d.name));
    /* The OOB default is "Production" on most defining tables. A value equal to
       the default is not evidence of production (decision 5 of 17 Sep), so the
       default is kept per table for the signal to compare against. */
    meta.usedForDefaults = Object.fromEntries(defs.map((d) => [d.name, d.default_value ?? '']));
    const classes = populated.filter((c) => lineage(c).some((t) => defining.has(t)));
    const usedFor = {};
    for (const cls of classes) {
      const rows = await client.query(cls, { query: `sys_class_name=${cls}`, fields: 'sys_id,used_for', limit: countOf(cls) + 50, offset: 0, display: 'false' });
      for (const r of rows) usedFor[r.sys_id] = r.used_for ?? '';
    }
    meta.usedFor = usedFor;
    meta.usedForClasses = classes;
    /* An audit row proves someone SET used_for, whatever the table's audit flag says now. */
    const audited = await client.query('sys_audit', { query: 'fieldname=used_for^tablenameSTARTSWITHcmdb_ci', fields: 'documentkey', limit: 100000, offset: 0, display: 'false' });
    meta.usedForSetIds = [...new Set(audited.map((r) => r.documentkey))];
  });

  /* Which tables define each attribute the completeness and identity rules need.
     MEASURED on dev424910: reading lookup tables and attributes for EVERY
     identification entry (471) took 545 s of a 20-minute run. Only rules that
     apply to a populated class's lineage can ever identify a CI read here. */
  const lineages = new Set(populated.flatMap((c) => lineage(c)));
  const relevantIdentifiers = new Set((estate.cmdb_identifier || [])
    .filter((i) => activeTruthy(i.active) && lineages.has(i.applies_to)).map((i) => i.sys_id));
  const entries = (estate.cmdb_identifier_entry || []).filter((e) => activeTruthy(e.active) && relevantIdentifiers.has(e.identifier));
  const recommended = (estate.cmdb_recommended_fields || []).filter((r) => activeTruthy(r.active));
  const wantedAttrs = [...new Set([
    'ram', 'cpu_count', 'cpu_core_count', 'disk_space',            // CMDB-031
    ...entries.flatMap((e) => splitAttrs(e.attributes)),
    ...recommended.map((r) => r.recommended).filter(Boolean),
    ...Object.values(meta.mandatory || {}).flat(),
  ])];
  await attempt('field_tables', async () => {
    needHierarchy();
    const out = {};
    for (const part of chunks(Object.keys(byName))) {
      for (const attrPart of chunks(wantedAttrs, 40)) {
        if (!attrPart.length) continue;
        const rows = await client.query('sys_dictionary', {
          query: `nameIN${part.join(',')}^elementIN${attrPart.join(',')}`, fields: 'name,element', limit: 2000, offset: 0, display: 'false',
        });
        for (const r of rows) (out[r.element] ||= []).push(r.name);
      }
    }
    meta.fieldTables = out;
  });

  /* Child-class attribute values that are not in the cmdb_ci extract, per populated class. */
  await attempt('class_attrs', async () => {
    if (reads.field_tables?.status !== 'ok') throw Object.assign(new Error('field definitions were not read'), { status: 424 });
    const classAttrs = {};
    for (const cls of populated) {
      const line = new Set(lineage(cls));
      const applicable = wantedAttrs.filter((a) => (meta.fieldTables[a] || []).some((t) => line.has(t)) && !baseFields.has(a));
      if (!applicable.length) continue;
      const rows = await client.query(cls, {
        query: `sys_class_name=${cls}`, fields: ['sys_id', ...applicable].join(','), limit: countOf(cls) + 50, offset: 0, display: 'false',
      });
      const values = {};
      const returned = new Set();
      for (const r of rows) {
        values[r.sys_id] = r;
        for (const attr of applicable) if (attr in r) returned.add(attr);
      }
      classAttrs[cls] = { applicable, returned: [...returned], values };
    }
    meta.classAttrs = classAttrs;
  });

  /* Lookup tables an identification entry names (cmdb_serial_number, network adapters). */
  await attempt('identity_lookups', async () => {
    needHierarchy();
    const lookupTables = [...new Set(entries.map((e) => e.table).filter((t) => t && !Object.prototype.hasOwnProperty.call(byName, t)))];
    const lookups = {};
    for (const t of lookupTables) {
      const attrs = [...new Set(entries.filter((e) => e.table === t).flatMap((e) => splitAttrs(e.attributes)))];
      const total = await client.count(t, 'cmdb_ciISNOTEMPTY');
      if (total > 100000) { lookups[t] = { status: 'too_large', total }; continue; }
      const rows = total
        ? await client.query(t, { query: 'cmdb_ciISNOTEMPTY', fields: ['cmdb_ci', ...attrs].join(','), limit: total + 50, offset: 0, display: 'false' })
        : [];
      const byCi = {};
      for (const r of rows) (byCi[r.cmdb_ci] ||= []).push(r);
      lookups[t] = { status: 'ok', total, byCi };
    }
    meta.lookups = lookups;
  });

  /* Choice-field defaults, and whether the CMDB is audited at all (CMDB-021). */
  await attempt('choice_audit', async () => {
    const defaults = await client.query('sys_dictionary', {
      query: 'name=cmdb_ci^elementINinstall_status,operational_status^default_valueISNOTEMPTY', fields: 'element,default_value', limit: 10, offset: 0, display: 'false',
    });
    const coll = await client.query('sys_dictionary', { query: 'name=cmdb_ci^internal_type=collection', fields: 'audit,attributes', limit: 1, offset: 0, display: 'false' });
    const audited = coll?.[0] ? (String(coll[0].audit) === 'true' || /(^|,)audit=true/.test(String(coll[0].attributes || ''))) : false;
    const changed = {};
    if (audited) {
      for (const d of defaults) {
        const rows = await client.query('sys_audit', {
          query: `fieldname=${d.element}^tablenameSTARTSWITHcmdb_ci`, fields: 'documentkey', limit: 100000, offset: 0, display: 'false',
        });
        changed[d.element] = [...new Set(rows.map((r) => r.documentkey))];
      }
    }
    meta.choiceAudit = { audited, defaults: Object.fromEntries(defaults.map((d) => [d.element, d.default_value])), changed };
  });

  /* A change's impacted services — CMDB-141, the headline measure. */
  const changes = (estate.change_request || []).filter((c) => c.cmdb_ci);
  await attempt('change_impact', async () => {
    const withImpact = new Set();
    for (const part of chunks(changes.map((c) => c.sys_id))) {
      const rows = await client.query('task_cmdb_ci_service', { query: `taskIN${part.join(',')}`, fields: 'task', limit: 10000, offset: 0, display: 'false' });
      for (const r of rows) withImpact.add(r.task);
    }
    meta.changeImpact = { withImpact: [...withImpact] };
  });

  /* ── GROUP 3 (Correctness) ──────────────────────────────────────────── */

  /* Choice lists for the choice fields on cmdb_ci, per class lineage (CMDB-029).
     The ASSET tables are read too (CMDB-082 / CMDB-086): the two lifecycle models
     use the same column name and different values — on dev424910 `10` is Consumed
     on an asset and Absent is `100` on a CI — so the mapping between them is made
     from the LABELS the instance itself publishes, never from the numbers. */
  await attempt('choices', async () => {
    needHierarchy();
    const rows = [];
    for (const part of chunks(Object.keys(byName))) {
      rows.push(...await client.query('sys_choice', {
        query: `nameIN${part.join(',')}^elementINinstall_status,operational_status,discovery_source`,
        fields: 'name,element,value,label,inactive', limit: 5000, offset: 0, display: 'false',
      }));
    }
    rows.push(...await client.query('sys_choice', {
      query: 'nameINalm_asset,alm_hardware^elementINinstall_status,substatus',
      fields: 'name,element,value,label,inactive', limit: 2000, offset: 0, display: 'false',
    }));
    meta.choices = rows;
  });

  /* sys_class_name changes (CMDB-026) — only meaningful when the CMDB is audited. */
  await attempt('class_audit', async () => {
    if (!meta.choiceAudit?.audited) { meta.classAudit = { audited: false, rows: [] }; return; }
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    const rows = await client.query('sys_audit', {
      query: `fieldname=sys_class_name^tablenameSTARTSWITHcmdb_ci^sys_created_on>=${since}`,
      fields: 'documentkey,sys_created_on,oldvalue,newvalue', limit: 100000, offset: 0, display: 'false',
    });
    meta.classAudit = { audited: true, since, rows };
  });

  return { cmdb: meta };
}
