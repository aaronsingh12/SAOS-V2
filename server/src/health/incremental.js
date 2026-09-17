import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES, sliceWhere, specHash } from './tables.js';
import { MODULE_KEYS, moduleTables, normaliseModules, scopeOfRule } from './scopes.js';

/**
 * INCREMENTAL SCANNING — skip a module whose inputs have not changed.
 *
 * ═══ WHY NOT "FETCH ONLY sys_updated_on > last scan" ═══
 *
 * The rules judge whole tables: duplicates, class sizes, relationship walks,
 * the average over every CI. No local copy of the records is kept (a decision
 * of 15 Sep 2026), so a read of only the changed rows would have nothing to
 * compare them against and would report a fraction of the estate as all of it.
 *
 * So the unit of reuse is the MODULE. Before reading, every table a module's
 * last result was computed from is asked one question through the Aggregate
 * API — its row count and its newest `sys_updated_on`:
 *
 *   an insert or an update  moves the newest timestamp
 *   a delete                moves the count
 *   neither moved           nothing in that slice changed
 *
 * A module whose every input is unchanged keeps its last result, marked as
 * verified now; any change re-reads that module in full.
 *
 * ═══ THE STAMP IS TAKEN BEFORE THE READ, AND BELONGS TO THE RESULT ═══
 *
 * A table's stamp is taken immediately before its rows are read (in the same
 * call that counts them). Anything that changes after the stamp moves it, so
 * it is caught next time even if the read happened to include it — a false
 * "changed" costs a re-read; a false "unchanged" would cost a wrong answer, and
 * this order cannot produce one.
 *
 * Stamps are compared against the run that PRODUCED the module's current result,
 * never against "the last time anything read this table". An ITSM-only scan
 * re-reads `cmdb_ci` too; if that moved a shared per-table timestamp, the next
 * CMDB check would compare against it and reuse a CMDB result computed from
 * older rows.
 *
 * ═══ DELETIONS ═══
 *
 * Tables the instance keeps a deletion log for (audited dictionary collections,
 * and `glide.ui.audit_deleted_tables`) are checked in `sys_audit_delete` as
 * well, so a change can say how many records were deleted. Every other table —
 * `cmdb_ci` among them on a default instance — is covered by the count, which
 * is why the count is compared for every table regardless.
 *
 * ═══ WHAT CANNOT BE SEEN, AND THE BACKSTOPS ═══
 *
 *   - Time alone changes some answers (a CI crosses 90 days untouched, a task
 *     ages past its threshold) with no row changing. A result older than
 *     `maxReuseHours` is re-read whatever the stamps say.
 *   - A change of rules, catalogue, settings or accepted risks changes answers
 *     over unchanged rows: each module's ENGINE KEY must match.
 *   - A different connected account sees different rows: it must match.
 *   - A field added to a table's read: the table's spec hash must match.
 */

export const INCREMENTAL_DEFAULTS = Object.freeze({
  maxReuseHours: 24,
  probeConcurrency: 4,
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* The source that decides what a finding is. Anything else (remediation,
   proposals, storage) can change without making a stored result wrong. */
const ENGINE_FILES = /^(rules|scopes|tables|extract|index|incremental|cmdb-[a-z-]+)\.js$/;
let engineSource = null;

function engineSourceHash() {
  if (engineSource) return engineSource;
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(HERE).filter((x) => ENGINE_FILES.test(x)).sort()) {
    h.update(f).update(fs.readFileSync(path.join(HERE, f)));
  }
  const cat = path.join(HERE, 'catalogue');
  if (fs.existsSync(cat)) {
    for (const f of fs.readdirSync(cat).filter((x) => x.endsWith('.json')).sort()) {
      h.update(f).update(fs.readFileSync(path.join(cat, f)));
    }
  }
  engineSource = h.digest('hex').slice(0, 16);
  return engineSource;
}

/**
 * Per module: what, besides the rows, decides its findings. Accepted risks are
 * split by module, so accepting an ITSM finding does not invalidate CMDB.
 */
export function engineKeys({ staleDays = null, acceptedRules = [] } = {}) {
  const source = engineSourceHash();
  const out = {};
  for (const m of MODULE_KEYS) {
    const accepted = acceptedRules.filter((a) => scopeOfRule(a.ruleId) === m).map((a) => a.fingerprint).sort();
    out[m] = crypto.createHash('sha256')
      .update(JSON.stringify({ source, staleDays, accepted }))
      .digest('hex').slice(0, 16);
  }
  return out;
}

/** `YYYY-MM-DD HH:MM:SS`, UTC — the way the instance writes sys_created_on. */
const snowTime = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 19);

/** Run `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

/**
 * Which of these tables keep a deletion log on this instance — read from the
 * instance each time, never assumed. Null when that could not be read.
 */
export async function deletionLoggedTables(client, tables) {
  if (typeof client?.query !== 'function' || !tables.length) return null;
  try {
    const audited = await client.query('sys_dictionary', {
      query: `internal_type=collection^audit=true^nameIN${tables.join(',')}`, fields: 'name', limit: tables.length + 5, offset: 0, display: 'false',
    });
    const prop = await client.query('sys_properties', {
      query: 'name=glide.ui.audit_deleted_tables', fields: 'value', limit: 1, offset: 0, display: 'false',
    });
    const listed = String(prop?.[0]?.value || '').split(',').map((x) => x.trim()).filter(Boolean);
    return new Set([...audited.map((r) => r.name), ...listed].filter((t) => tables.includes(t)));
  } catch {
    return null;
  }
}

/** One stamp now, over the slice the table is read with — or the reason there is none. */
async function stampNow(client, tableName, query, now) {
  try {
    const s = await client.changeStamp(tableName, query ?? sliceWhere(tableName, snowTime(now)));
    return { count: s.count, max_updated: s.maxUpdated ?? null, basis: s.basis ?? 'sys_updated_on' };
  } catch (err) {
    return { error: err?.message || String(err), status: err?.status ?? null };
  }
}

function compareStamps(before, after) {
  if (after.error) {
    /* A source that was unavailable then and is unavailable now has not changed. */
    if (before?.error && before.status != null && before.status === after.status) return null;
    return `could not be checked (${after.error})`;
  }
  if (!before || before.error) return 'had no stamp from the last read';
  if ((before.basis || 'sys_updated_on') !== (after.basis || 'sys_updated_on')) return `is now stamped by ${after.basis} instead of ${before.basis || 'sys_updated_on'}`;
  if (after.count !== before.count) return `row count moved from ${before.count.toLocaleString('en-US')} to ${after.count.toLocaleString('en-US')}`;
  if ((after.max_updated || null) !== (before.max_updated || null)) {
    return after.basis === 'sys_created_on'
      ? `records added since the last read (newest ${after.max_updated})`
      : `records updated since the last read (newest change ${after.max_updated})`;
  }
  return null;
}

/**
 * Take stamps for a list of sources — used for the CMDB meta reads, whose
 * slices are not tables in the allow-list.
 */
export async function stampSources(client, sources, { now = new Date(), concurrency = INCREMENTAL_DEFAULTS.probeConcurrency } = {}) {
  if (typeof client?.changeStamp !== 'function') return null;
  const out = {};
  const results = await pool(sources, concurrency, (s) => stampNow(client, s.table, s.query, now));
  sources.forEach((s, i) => {
    out[s.key] = { table: s.table, query: s.query, ...results[i], taken_at: now.toISOString() };
  });
  return out;
}

/**
 * THE PLAN — for each module asked for, reuse its last result or read it.
 *
 * @param {object}   args
 * @param {string[]} args.modules        modules the scan covers
 * @param {object}   args.client         the instance client (read-only calls)
 * @param {object}   args.baselines      module -> { runId, checkedAt, status, engineKey, user, dependencies, stamps, specHashes, metaStamps }
 * @param {object}   args.tableSettings  table -> { enabled }
 * @param {object}   args.engineKeys     module -> key (see engineKeys)
 * @param {string}   args.user           connected account
 * @param {boolean}  args.reuse          false re-reads everything
 */
export async function planScan({
  modules, client, baselines = {}, tableSettings = {}, engineKeys: keys = {}, user = null,
  reuse = true, now = new Date(), maxReuseHours = INCREMENTAL_DEFAULTS.maxReuseHours,
  concurrency = INCREMENTAL_DEFAULTS.probeConcurrency, signal = null,
} = {}) {
  const t0 = Date.now();
  /* Stop is honoured between stamps, as extraction honours it between tables. */
  const stopped = () => {
    if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
  };
  const wanted = normaliseModules(modules);
  const plan = { modules: {}, tables: {}, meta: {}, deletions: {}, probe_ms: 0, max_reuse_hours: maxReuseHours };
  const canProbe = typeof client?.changeStamp === 'function';

  /* 1. What rules out reuse before a single stamp is taken. */
  const candidates = [];
  for (const m of wanted) {
    const b = baselines[m];
    const reasons = [];
    if (!reuse) reasons.push('a full re-read was requested');
    else if (!b) reasons.push('this module has no earlier result on this instance');
    else {
      if (!canProbe) reasons.push('the instance client cannot take change stamps');
      if (b.engineKey !== keys[m]) reasons.push('the rules, settings or accepted risks changed since its last result');
      if ((b.user || null) !== (user || null)) reasons.push('a different ServiceNow account is connected, which may see different records');
      const ageH = (now - new Date(b.checkedAt)) / 3_600_000;
      if (!(ageH <= maxReuseHours)) reasons.push(`its last result was read ${Math.round(ageH)} h ago; results older than ${maxReuseHours} h are re-read because time alone changes some findings`);
      if (!b.stamps || !b.dependencies) reasons.push('its last result was recorded before change stamps existed');
      if (b.degraded?.length) reasons.push(`its last result was produced with reads that failed (${b.degraded.slice(0, 3).join('; ')}), so it is read again rather than kept`);
    }
    plan.modules[m] = { action: reasons.length ? 'read' : 'pending', reasons, source_run_id: b?.runId ?? null, checked_at: b?.checkedAt ?? null };
    if (!reasons.length) candidates.push(m);
  }

  /* 2. One stamp per input table of every candidate, taken once even when shared. */
  /*
   * AN OPT-IN TABLE NOBODY READ IS NOT AN INPUT.
   *
   * The dependency tracker records every table a rule TOUCHED, and the rules do
   * touch `ctx.estate.sys_audit` — they have to, to discover it is absent and
   * say so. But `sys_audit` is opt-in: unless a caller named it, it was never
   * read, so it cannot have contributed to the result and cannot invalidate it.
   * Without this, every CMDB scan would find an input with no stamp, conclude it
   * must re-read, and no module would ever be reusable again — the exact
   * optimisation the planner exists for, undone by a table that was deliberately
   * skipped. An opt-in table that HAS a stamp was genuinely read, and is checked
   * like any other.
   */
  const inputsOf = (m) => [...new Set([...(baselines[m].dependencies || []), ...moduleTables([m])])]
    .filter((t) => TABLES[t] && (!TABLES[t].optIn || baselines[m].stamps?.[t]));
  const tables = [...new Set(candidates.flatMap(inputsOf))].sort();
  const logged = tables.length ? await deletionLoggedTables(client, tables) : null;
  stopped();
  const stampsNow = await pool(tables, concurrency, (t) => { stopped(); return stampNow(client, t, null, now); });
  stopped();
  const nowByTable = Object.fromEntries(tables.map((t, i) => [t, stampsNow[i]]));

  for (const m of candidates) {
    const b = baselines[m];
    const changes = [];
    /* Deletions the instance logged since THIS result's stamps — one grouped call. */
    const deletions = {};
    const loggedHere = inputsOf(m).filter((t) => logged?.has(t) && b.stamps?.[t]?.taken_at);
    if (loggedHere.length && typeof client?.countBy === 'function') {
      const since = loggedHere.map((t) => b.stamps[t].taken_at).sort()[0];
      try {
        Object.assign(deletions, await client.countBy('sys_audit_delete', `tablenameIN${loggedHere.join(',')}^sys_created_on>=${snowTime(since)}`, 'tablename'));
      } catch { /* the count still decides */ }
      for (const [t, n] of Object.entries(deletions)) plan.deletions[t] = Math.max(plan.deletions[t] || 0, n);
    }
    for (const t of inputsOf(m)) {
      const before = b.stamps?.[t] ?? null;
      const after = nowByTable[t];
      let why = null;
      if (tableSettings[t]?.enabled === false) why = 'incremental checking is switched off for this table';
      else if (!before) why = 'was not read to the end in the run that produced this result';
      else if (b.specHashes?.[t] && b.specHashes[t] !== specHash(t)) why = 'the fields read from it changed';
      else why = compareStamps(before, after);
      if (!why && (deletions[t] || 0) > 0) why = `${deletions[t]} deletion(s) logged in sys_audit_delete`;
      else if (why && deletions[t] && !/deletion/.test(why)) why += `; ${deletions[t]} deletion(s) logged in sys_audit_delete`;
      plan.tables[t] = {
        changed: Boolean(why) || Boolean(plan.tables[t]?.changed),
        reason: why || plan.tables[t]?.reason || null,
        now: after,
        deletion_log: logged ? logged.has(t) : null,
      };
      if (why) changes.push(`${t}: ${why}`);
    }

    /* The CMDB meta reads — their own slices, compared against their own stamps. */
    if (m === 'cmdb') {
      const metaBefore = b.metaStamps;
      if (!metaBefore) {
        changes.push('its governance reads were recorded before change stamps existed');
      } else {
        const entries = Object.entries(metaBefore);
        const metaNow = await pool(entries, concurrency, ([, s]) => { stopped(); return stampNow(client, s.table, s.query, now); });
        entries.forEach(([key, s], i) => {
          const why = compareStamps(s, metaNow[i]);
          plan.meta[key] = { table: s.table, changed: Boolean(why), reason: why };
          if (why) changes.push(`${s.table} (${key}): ${why}`);
        });
      }
    }

    plan.modules[m] = changes.length
      ? { ...plan.modules[m], action: 'read', reasons: changes }
      : { ...plan.modules[m], action: 'reuse', reasons: [], verified_at: now.toISOString() };
  }

  plan.probe_ms = Date.now() - t0;
  plan.reuse = wanted.filter((m) => plan.modules[m].action === 'reuse');
  plan.read = wanted.filter((m) => plan.modules[m].action === 'read');
  return plan;
}
