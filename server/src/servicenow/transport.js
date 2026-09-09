import { table, SnowError } from './client.js';
import { getTableHierarchy } from './schema.js';
import { workspaceForScope } from './workspaces.js';
import { runServerScript, utcStamp } from './execution-harness.js';
import { getDb } from '../memory/db.js';
import { currentActor, harvestSysIds } from '../memory/audit.js';
import { log } from '../logging.js';

/**
 * Session update-set capture.
 *
 * The mechanism is the SWEEP, and the alternative was measured rather than
 * argued about (§33). Pointing the API user's `sys_update_set` preference at a
 * named set does work — but it is a per-USER setting and every NowHelpAssist
 * session shares one API user, so two interleaved sessions put 8 of 16 changes
 * in each other's set with no error anywhere. A per-session current set cannot
 * be built on it at any timing, so it is not used at all: rows are re-parented
 * after the fact, where the row's own identity decides where it goes.
 *
 * Four platform behaviours the sweep is built around, all measured:
 *
 *   1. `sys_update_xml.name` is `<table>_<sys_id of the changed record>`. That
 *      is an EXACT locator, so a tool that reports what it touched can be swept
 *      without guessing from a timestamp.
 *
 *   2. A row may only move between sets of the SAME scope. Business rule
 *      `Handle updates moving between sets` aborts anything else with a 403
 *      (trap #72). So the sweep groups by the ROW's `application` and needs one
 *      set per scope — this is enforcement, not tidiness.
 *
 *   3. REST cannot create a scoped update set: `application` is accepted and
 *      silently demoted to `global` (trap #69). Scoped sets are minted through
 *      the execution harness, where a server-side insert keeps the scope.
 *
 *   4. Only ONE row per record exists per SET, rewritten in place — but sweeping
 *      a row out and then editing the record again produces a SECOND row with
 *      the same name in the Default set. Moving that one in leaves two rows
 *      sharing a name in one set, and the platform does not dedupe. Since a
 *      payload is a complete `<record_update>` snapshot rather than a diff,
 *      collapsing to the newest is lossless — and not collapsing would make
 *      both the count and the export wrong.
 *
 * What is NOT captured, ever: task data. An incident is not configuration and
 * has no `sys_update_xml` row to sweep. That is reported explicitly rather than
 * left to look like a capture failure.
 */

/** Sets NowHelpAssist creates are named so they are identifiable on the instance. */
const SET_PREFIX = 'NHA';
const SET_SEP = ' · ';

/**
 * How far before a tool call the sweep looks. `sys_created_on` has one-second
 * granularity, so a window that starts exactly at the call can miss a row
 * written in the same second the clock ticked over. Widened deliberately: the
 * cost of overlap is re-examining a row already in one of our sets, which the
 * exclusion below makes free, while the cost of missing one is a change that
 * silently never got captured.
 */
const SWEEP_BACKDATE_MS = 15_000;

const raw = (cell) => (cell && typeof cell === 'object' ? cell.value : cell);
const now = () => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Capture state — ON by default
 * ------------------------------------------------------------------ */

export function isCaptureOn(sessionId) {
  if (!sessionId) return false;
  const row = getDb().prepare('SELECT enabled FROM capture_state WHERE session = ?').get(sessionId);
  return row ? row.enabled === 1 : true; // absence means default, and the default is ON
}

export function setCapture(sessionId, enabled) {
  getDb().prepare(
    `INSERT INTO capture_state (session, enabled, updated) VALUES (?, ?, ?)
     ON CONFLICT(session) DO UPDATE SET enabled = excluded.enabled, updated = excluded.updated`
  ).run(sessionId, enabled ? 1 : 0, now());
  return { session: sessionId, enabled: Boolean(enabled) };
}

/* ------------------------------------------------------------------ *
 * Configuration vs data
 * ------------------------------------------------------------------ */

const classifyCache = new Map();

/**
 * Is a write to this table CONFIGURATION (tracked in update sets) or DATA?
 *
 * Answered from the live hierarchy rather than a list, because a hardcoded
 * platform list goes stale silently (trap #28). `sys_metadata` anywhere in the
 * super_class chain is what makes a record configuration — measured:
 * `sc_category`, `sys_script` and `sc_cat_item` all extend it; `incident`
 * extends `task` and does not.
 */
export async function classifyTable(tableName) {
  if (!tableName) return { table: tableName, configuration: false, reason: 'no table named' };
  if (classifyCache.has(tableName)) return classifyCache.get(tableName);
  let verdict;
  try {
    const chain = await getTableHierarchy(tableName);
    const configuration = chain.includes('sys_metadata');
    verdict = {
      table: tableName,
      configuration,
      chain,
      reason: configuration
        ? `${tableName} extends sys_metadata — configuration, tracked in update sets`
        : `${tableName} does not extend sys_metadata — data, not configuration`,
    };
  } catch (err) {
    // Unknown is NOT "data". Saying "not captured — data" about a table we
    // could not classify would be a confident wrong answer about the one thing
    // this feature exists to be trusted on.
    verdict = { table: tableName, configuration: null, reason: `could not classify ${tableName}: ${err.message}` };
  }
  classifyCache.set(tableName, verdict);
  return verdict;
}

/* ------------------------------------------------------------------ *
 * The per-session, per-scope sets
 * ------------------------------------------------------------------ */

/** Truncated so a long chat title cannot produce an unusable set name. */
function setName(sessionTitle, scopeLabel) {
  const title = String(sessionTitle || 'session').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${SET_PREFIX}${SET_SEP}${title}${SET_SEP}${scopeLabel}`;
}

/** Every set NowHelpAssist has created, for the exclusion below and for the UI. */
function ownedSetIds() {
  return getDb().prepare('SELECT DISTINCT set_sys_id FROM capture_sets').all().map((r) => r.set_sys_id);
}

export function sessionSets(sessionId, instance) {
  return getDb()
    .prepare('SELECT * FROM capture_sets WHERE session = ? AND instance = ? ORDER BY created')
    .all(sessionId, instance);
}

/**
 * Resolve a scope reference to a stable label for the set name.
 * `global` is a literal sys_id and needs no lookup (§33).
 */
async function scopeLabelFor(scopeId) {
  if (!scopeId || scopeId === 'global') return 'global';
  const rows = await table.query('sys_scope', { query: `sys_id=${scopeId}`, fields: 'scope,name', limit: 1, display: 'false' });
  return raw(rows[0]?.scope) || raw(rows[0]?.name) || scopeId;
}

/**
 * Create the update set for one scope, lazily.
 *
 * Global goes over REST. Anything else goes through the harness, because REST
 * would accept `application` and silently hand back a global set — which would
 * then refuse every row the sweep tried to put in it, at the 403 in trap #72.
 * The read-back is what makes that failure impossible to miss.
 */
async function createSetForScope(scopeId, name, parentSetId) {
  if (scopeId === 'global') {
    const created = await table.create('sys_update_set', {
      name,
      application: 'global',
      state: 'in progress',
      description: 'Created by NowHelpAssist session capture. Configuration only — no task data.',
      ...(parentSetId ? { parent: parentSetId } : {}),
    }, 'false');
    return created.sys_id;
  }

  const res = await runServerScript({
    body: [
      'var us = new GlideRecord("sys_update_set");',
      'us.initialize();',
      `us.name = ${JSON.stringify(name)};`,
      `us.application = ${JSON.stringify(scopeId)};`,
      'us.state = "in progress";',
      'us.description = "Created by NowHelpAssist session capture. Configuration only — no task data.";',
      parentSetId ? `us.parent = ${JSON.stringify(parentSetId)};` : '',
      'report.setId = us.insert();',
    ].filter(Boolean).join('\n'),
    label: 'capture-set',
  });
  const setId = res?.report?.setId;
  if (!setId) {
    throw new SnowError(
      `Could not create a scoped update set for ${scopeId}: the harness job reported ${res?.report?.error || 'no set id'}. `
      + 'REST cannot create one (it silently returns a global set), so this path has no fallback.',
      502, JSON.stringify(res?.report || null)
    );
  }

  /*
   * READ IT BACK. A sys_id IS NOT A WRITE.
   *
   * This block's own comment used to end "the read-back is what makes that
   * failure impossible to miss" — and there was no read-back. `if (!setId)` is
   * not one: M-1 measured a scoped script inserting into a GLOBAL table where
   * `insert()` returned a real sys_id, `getLastErrorMessage()` was null, and
   * every field had been discarded. `sys_update_set` is global and its
   * Application Access is create=true / update=FALSE — the same shape as the
   * `sys_user_preference` row that came back blank.
   *
   * So the fields are compared over a DIFFERENT transport (the REST Table API
   * from Node) rather than trusted from the execution that wrote them. A set
   * whose `application` was silently demoted to global would otherwise refuse
   * every row the sweep later tried to put in it, at the 403 in trap #72 —
   * failing far from the cause.
   */
  const [back] = await table.query('sys_update_set', {
    query: `sys_id=${setId}`, fields: 'sys_id,name,application,state,parent', limit: 1, display: 'false',
  }).catch(() => []);
  if (!back) {
    throw new SnowError(
      `The harness reported creating update set ${setId} for ${scopeId}, and reading it back over the Table API `
      + 'found no such record. The write did not land; nothing was captured.',
      502, JSON.stringify({ scopeId, setId })
    );
  }
  const wanted = { name, application: scopeId, ...(parentSetId ? { parent: parentSetId } : {}) };
  const dropped = Object.entries(wanted)
    .filter(([f, v]) => String(raw(back[f]) ?? '') !== String(v))
    .map(([f, v]) => `${f}: asked ${JSON.stringify(v)}, stored ${JSON.stringify(raw(back[f]) ?? '')}`);
  if (dropped.length) {
    throw new SnowError(
      `Update set ${setId} was created for ${scopeId} but the instance did not store what was asked: `
      + `${dropped.join('; ')}. A scoped script writing to the global sys_update_set table has its field writes `
      + 'silently discarded (M-1), so this set is unusable and capture must not proceed with it.',
      502, JSON.stringify({ scopeId, setId, dropped })
    );
  }
  return setId;
}

/**
 * The set this session uses for this scope — created on first use.
 *
 * Every set is read back and its `application` compared with what was asked
 * for. A set that came back global when a scope was requested is refused here
 * rather than at the 403 the first row would hit, because the diagnosis is
 * clear at this point and opaque at that one.
 */
export async function ensureSetForScope({ sessionId, sessionTitle, scopeId }) {
  const db = getDb();
  const { instance } = currentActor();
  const key = scopeId || 'global';
  const existing = db.prepare(
    'SELECT * FROM capture_sets WHERE session = ? AND instance = ? AND scope_id = ?'
  ).get(sessionId, instance, key);

  if (existing) {
    // The row is local; the set is on an instance somebody may have deleted it
    // from. Confirm before handing back a sys_id that no longer resolves.
    const live = await table.query('sys_update_set', { query: `sys_id=${existing.set_sys_id}`, fields: 'sys_id,name,application', limit: 1, display: 'false' });
    if (live.length) return existing;
    log.warn('transport', `capture set ${existing.set_sys_id} is gone from ${instance}; recreating`);
    db.prepare('DELETE FROM capture_sets WHERE id = ?').run(existing.id);
  }

  const scopeName = await scopeLabelFor(key);
  const name = setName(sessionTitle, scopeName);

  // A second scope in one session gets a batch parent, and the first set is
  // adopted into it. Cross-scope parenting is allowed — measured: a scoped
  // child keeps its own application under a global parent.
  const siblings = sessionSets(sessionId, instance);
  let parentSetId = siblings[0]?.parent_set || null;
  if (!parentSetId && siblings.length >= 1) {
    parentSetId = await table.create('sys_update_set', {
      name: `${SET_PREFIX}${SET_SEP}${String(sessionTitle || 'session').slice(0, 60)}`,
      application: 'global',
      state: 'in progress',
      description: 'Batch parent for a NowHelpAssist session that touched more than one scope.',
    }, 'false').then((r) => r.sys_id);
    for (const s of siblings) {
      await table.update('sys_update_set', s.set_sys_id, { parent: parentSetId }, 'false').catch((err) =>
        log.warn('transport', `could not adopt ${s.set_sys_id} into batch parent: ${err.message}`));
      db.prepare('UPDATE capture_sets SET parent_set = ? WHERE id = ?').run(parentSetId, s.id);
    }
  }

  const setSysId = await createSetForScope(key, name, parentSetId);

  const back = await table.get('sys_update_set', setSysId, 'false');
  if (raw(back.application) !== key) {
    throw new SnowError(
      `Created an update set for scope "${scopeName}" but the instance stored it against `
      + `"${raw(back.application)}". Rows from that scope cannot be moved into it (trap #72).`,
      502
    );
  }

  db.prepare(
    `INSERT INTO capture_sets (session, instance, scope_id, scope_name, set_sys_id, set_name, parent_set, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, instance, key, scopeName, setSysId, name, parentSetId, now());

  log.info('transport', `capture set "${name}" (${setSysId}) for scope ${scopeName}`);
  return db.prepare('SELECT * FROM capture_sets WHERE session = ? AND instance = ? AND scope_id = ?')
    .get(sessionId, instance, key);
}

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

/** `<table>_<sys_id>` — the exact name the platform gives an update row. */
export const updateRowName = (tableName, sysId) => `${tableName}_${sysId}`;

/** The record a row describes, recovered from its name. */
export const targetSysIdOf = (rowName) => (/([0-9a-f]{32})$/i.exec(String(rowName || ''))?.[1] || null);

/* ------------------------------------------------------------------ *
 * Collision guard — two captured sessions must never claim each other's rows
 * ------------------------------------------------------------------ */

/**
 * Sessions with a sweep window currently open.
 *
 * The exclusion in `findCandidateRows` stops a session claiming a row ANOTHER
 * session already swept. It does nothing about the live case: two captured
 * sessions running at once, both sweeping, both seeing a row that is still
 * sitting unclaimed in Default. Whichever sweeps first takes it — and E1
 * measured what that costs when sessions share one identity (8/16 wrong).
 *
 * So a row inside more than one open window is CONTESTED, and is never
 * assigned on timing. It is resolved by provenance — did this session's own
 * tool events actually report touching that record — and if provenance cannot
 * settle it, the row is left where it is and reported unassigned. Left behind
 * in Default is recoverable; silently filed under the wrong session is not.
 */
const openWindows = new Map(); // sessionId -> { since, sinceIso }

export function openCaptureWindow(sessionId, since) {
  if (!sessionId || !since) return;
  openWindows.set(sessionId, { since, sinceIso: new Date().toISOString() });
}

export function closeCaptureWindow(sessionId) { openWindows.delete(sessionId); }

/** Exported for the offline suite, which needs to simulate two live sessions. */
export function _openWindows() { return new Map(openWindows); }
export function _resetWindows() { openWindows.clear(); }

/**
 * The record sys_ids a session's own audit trail says it touched.
 *
 * This is the provenance the guard arbitrates on: not what the sweep found on
 * the instance, but what THIS session's tool calls actually returned. A tool
 * result is the only place a created record's sys_id exists (the reason the
 * audit stores results at all), which makes it the one honest tiebreak.
 */
export function sessionTouchedIds(sessionId, sinceIso) {
  const rows = getDb().prepare(
    `SELECT payload, result FROM tool_events
      WHERE session = ? AND mutating = 1 AND ts >= ?`
  ).all(sessionId, sinceIso || '');
  const ids = new Set();
  for (const r of rows) for (const id of harvestSysIds(r.payload, r.result)) ids.add(id.toLowerCase());
  return ids;
}

/**
 * Decide who a candidate row belongs to.
 *
 * Returns 'mine' | 'theirs' | 'unassigned'. Only 'mine' is ever moved.
 */
export function resolveContention({ rowName, sessionId, rowCreatedOn, windows = openWindows, touched = sessionTouchedIds }) {
  const rivals = [...windows.entries()].filter(([id, w]) =>
    id !== sessionId && rowCreatedOn && String(rowCreatedOn) >= String(w.since));
  if (!rivals.length) return { verdict: 'mine', contestedWith: [] };

  const target = targetSysIdOf(rowName);
  const mineIds = touched(sessionId, windows.get(sessionId)?.sinceIso);
  const mine = Boolean(target) && mineIds.has(target.toLowerCase());
  const claimedByRival = rivals.filter(([id, w]) => Boolean(target) && touched(id, w.sinceIso).has(target.toLowerCase()));

  const contestedWith = rivals.map(([id]) => id);
  if (mine && !claimedByRival.length) return { verdict: 'mine', contestedWith };
  if (!mine && claimedByRival.length) return { verdict: 'theirs', contestedWith, owner: claimedByRival[0][0] };
  // Neither reported it, or BOTH did. Splitting on timing is the failure this
  // guard exists to prevent, so nothing moves and it is surfaced for review.
  return {
    verdict: 'unassigned',
    contestedWith,
    reason: mine
      ? 'more than one open session reports touching this record'
      : 'no open session reports touching this record, and more than one window covers it',
  };
}

/** A stamp the Table API will compare against `sys_created_on`, which is UTC. */
export const sweepMark = (ms = Date.now()) => utcStamp(ms - SWEEP_BACKDATE_MS);

/**
 * Find the update rows a piece of work produced.
 *
 * Three locators, deliberately overlapping:
 *
 *   - `targets` — exact `<table>_<sys_id>` names, when the caller knows both.
 *   - `sysIds` — the record ids a tool touched, WITHOUT needing to know their
 *     tables. `nameENDSWITH<sys_id>` matches the same rows, which means the
 *     hook can harvest ids out of any tool's result and locate their updates
 *     without a per-tool table map that would go stale silently (trap #28).
 *   - the time window — catches COLLATERAL rows nothing named: a catalog item's
 *     variables, a flow's snapshots, the cross-scope privileges an install
 *     generates. Measured: one catalog item plus one variable is two rows, and
 *     only one of them carries the item's sys_id.
 *
 * Rows already sitting in a NowHelpAssist set are excluded, which makes the
 * sweep idempotent and stops one session claiming another's rows.
 */
export async function findCandidateRows({ since, targets = [], sysIds = [] }) {
  const { actor } = currentActor();
  const owned = ownedSetIds();
  const seen = new Map();

  const collect = (rows) => { for (const r of rows) if (!owned.includes(raw(r.update_set))) seen.set(raw(r.sys_id), r); };
  const FIELDS = 'sys_id,name,type,target_name,action,update_set,application,payload_hash,sys_created_on,sys_updated_on,sys_created_by';

  if (since) {
    // CREATED **or** UPDATED. A created-only window misses an entire SDK
    // install, and misses it silently.
    //
    // Measured after `now-sdk install` (§35): 24 artifacts changed, 24 update
    // rows rewritten IN PLACE — `sys_updated_on` moved on 24/24 and
    // `sys_created_on` moved on 0/24, because a row already existed for each
    // one. A sweep asking only for `sys_created_on>=since` found 0 rows and
    // would have reported "nothing captured" for the whole install.
    //
    // `sys_created_by` is deliberately NOT applied to the updated half: the row
    // was created by whoever first changed that artifact, which for an install
    // over an existing app is a previous session or a previous day.
    const createdClause = [`sys_created_on>=${since}`, ...(actor ? [`sys_created_by=${actor}`] : [])].join('^');
    collect(await table.query('sys_update_xml', {
      query: `${createdClause}^ORDERBYsys_created_on`,
      fields: FIELDS, limit: 500, display: 'false',
    }));
    collect(await table.query('sys_update_xml', {
      query: `sys_updated_on>=${since}^ORDERBYsys_updated_on`,
      fields: FIELDS, limit: 500, display: 'false',
    }));
  }

  // Exact names, in one query. Also catches a row that was created BEFORE the
  // window because the record already existed and the tool only edited it.
  const names = [...new Set(targets.filter(Boolean))];
  if (names.length) {
    collect(await table.query('sys_update_xml', {
      query: `nameIN${names.join(',')}`,
      fields: FIELDS, limit: 500, display: 'false',
    }));
  }

  // Ids without tables. Chunked, because an encoded query is a URL and a turn
  // that touched many records would otherwise build one too long to send.
  const ids = [...new Set(sysIds.filter((v) => /^[0-9a-f]{32}$/i.test(String(v || ''))))];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    collect(await table.query('sys_update_xml', {
      query: chunk.map((id) => `nameENDSWITH${id}`).join('^OR'),
      fields: FIELDS, limit: 500, display: 'false',
    }));
  }
  return [...seen.values()];
}

/**
 * Collapse rows that share a name inside one set, keeping the newest.
 *
 * Safe because a payload is a complete snapshot, not a diff (§33) — the older
 * row describes an earlier state of the same record and the newer one fully
 * supersedes it. Returns what it removed so the audit can say so rather than
 * quietly shrinking a count.
 */
async function collapseDuplicates(setSysId) {
  const rows = await table.query('sys_update_xml', {
    query: `update_set=${setSysId}^ORDERBYsys_updated_on`,
    fields: 'sys_id,name,target_name,sys_updated_on,payload_hash', limit: 1000, display: 'false',
  });
  const newest = new Map();
  for (const r of rows) newest.set(raw(r.name), r); // ordered ascending, so last wins
  const superseded = rows.filter((r) => newest.get(raw(r.name)).sys_id !== raw(r.sys_id));
  const removed = [];
  for (const r of superseded) {
    try {
      await table.remove('sys_update_xml', raw(r.sys_id));
      removed.push({ sys_id: raw(r.sys_id), name: raw(r.name), target: raw(r.target_name) });
    } catch (err) {
      log.warn('transport', `could not remove superseded row ${raw(r.name)}: ${err.message}`);
    }
  }
  return removed;
}

/**
 * Move everything this work produced into the session's sets, one per scope.
 *
 * Never throws for a row it could not move: a capture failure must not fail the
 * tool call that already succeeded against the instance. Every failure is
 * returned, named, and lands in the audit.
 */
export async function sweep({ sessionId, sessionTitle, since, targets = [], sysIds = [], label = null }) {
  const started = Date.now();
  const candidates = await findCandidateRows({ since, targets, sysIds });
  const result = {
    label,
    scanned: candidates.length,
    moved: [],
    sets: [],
    collapsed: [],
    failures: [],
    /** Rows another open session might own. Never moved, always reported. */
    unassigned: [],
    elapsedMs: 0,
  };
  if (!candidates.length) { result.elapsedMs = Date.now() - started; return result; }

  // Arbitrate BEFORE grouping. A row inside another open session's window is
  // never taken on timing — see resolveContention.
  const mine = [];
  for (const r of candidates) {
    const verdict = resolveContention({
      rowName: raw(r.name), sessionId, rowCreatedOn: raw(r.sys_created_on),
    });
    if (verdict.verdict === 'mine') { mine.push(r); continue; }
    result.unassigned.push({
      row: raw(r.sys_id), name: raw(r.name), target: raw(r.target_name),
      verdict: verdict.verdict, contestedWith: verdict.contestedWith,
      owner: verdict.owner || null,
      reason: verdict.reason || `another open session (${verdict.owner}) reports touching this record`,
    });
  }
  if (result.unassigned.length) {
    log.warn('transport', `sweep${label ? ` (${label})` : ''}: ${result.unassigned.length} row(s) left unassigned — more than one capture window covers them`);
  }
  if (!mine.length) { result.elapsedMs = Date.now() - started; return result; }

  // Group by the ROW's application — never by the session's, and never by the
  // tool's. That is the only key the platform's move rule accepts (trap #72).
  const byScope = new Map();
  for (const r of mine) {
    const app = raw(r.application) || 'global';
    if (!byScope.has(app)) byScope.set(app, []);
    byScope.get(app).push(r);
  }

  for (const [scopeId, rows] of byScope) {
    let set;
    try {
      set = await ensureSetForScope({ sessionId, sessionTitle, scopeId });
    } catch (err) {
      result.failures.push({ scope: scopeId, rows: rows.length, stage: 'create-set', message: err.message });
      continue;
    }
    result.sets.push({ scope: set.scope_name, scopeId, setSysId: set.set_sys_id, setName: set.set_name, parentSet: set.parent_set });

    for (const r of rows) {
      try {
        await table.update('sys_update_xml', raw(r.sys_id), { update_set: set.set_sys_id }, 'false');
        const back = await table.get('sys_update_xml', raw(r.sys_id), 'false');
        if (raw(back.update_set) !== set.set_sys_id) {
          // The move rule reverts rather than erroring in some paths, so a
          // silent no-op is a real outcome and is reported as a failure.
          result.failures.push({
            row: raw(r.sys_id), name: raw(r.name), target: raw(r.target_name), stage: 'move',
            message: `the row did not move — it is still in ${raw(back.update_set)}`,
          });
          continue;
        }
        result.moved.push({
          row: raw(r.sys_id), name: raw(r.name), type: raw(r.type), target: raw(r.target_name),
          action: raw(r.action), scope: set.scope_name, setSysId: set.set_sys_id,
        });
      } catch (err) {
        result.failures.push({ row: raw(r.sys_id), name: raw(r.name), target: raw(r.target_name), stage: 'move', message: err.message });
      }
    }

    try { result.collapsed.push(...(await collapseDuplicates(set.set_sys_id))); }
    catch (err) { log.warn('transport', `collapse failed for ${set.set_sys_id}: ${err.message}`); }
  }

  result.elapsedMs = Date.now() - started;
  if (result.moved.length || result.failures.length || result.unassigned.length) {
    log.info('transport', `sweep${label ? ` (${label})` : ''}: ${result.moved.length} captured, ${result.failures.length} failed, ${result.collapsed.length} superseded, ${result.unassigned.length} unassigned`);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Reading back what was captured
 * ------------------------------------------------------------------ */

/** Every set NowHelpAssist created on the bound instance, with live counts. */
export async function listCapturedSets({ sessionId = null } = {}) {
  const { instance } = currentActor();
  const db = getDb();
  const local = sessionId
    ? db.prepare('SELECT * FROM capture_sets WHERE instance = ? AND session = ? ORDER BY created DESC').all(instance, sessionId)
    : db.prepare('SELECT * FROM capture_sets WHERE instance = ? ORDER BY created DESC').all(instance);
  if (!local.length) return { sets: [], instance };

  const ids = local.map((r) => r.set_sys_id);
  const live = await table.query('sys_update_set', {
    query: `sys_idIN${ids.join(',')}`,
    fields: 'sys_id,name,state,application,parent,sys_created_on,sys_updated_on',
    limit: Math.max(ids.length, 50), display: 'false',
  });
  const liveById = new Map(live.map((r) => [raw(r.sys_id), r]));

  const counts = new Map();
  for (const id of ids) {
    try { counts.set(id, await table.count('sys_update_xml', `update_set=${id}`)); }
    catch { counts.set(id, null); }
  }

  const titles = new Map(
    db.prepare('SELECT id, title FROM sessions').all().map((s) => [s.id, s.title])
  );

  return {
    instance,
    sets: local.map((r) => ({
      session: r.session,
      sessionTitle: titles.get(r.session) || null,
      scope: r.scope_name,
      scopeId: r.scope_id,
      setSysId: r.set_sys_id,
      setName: r.set_name,
      parentSet: r.parent_set,
      created: r.created,
      // A set that was deleted on the instance is reported as missing, not
      // rendered as an empty one — an empty set and a deleted set are
      // different facts and the page must not blur them.
      present: liveById.has(r.set_sys_id),
      state: raw(liveById.get(r.set_sys_id)?.state) || null,
      updateCount: counts.get(r.set_sys_id),
    })),
  };
}

/** The contents of one set: what would travel if it were exported. */
export async function setContents(setSysId) {
  const set = await table.query('sys_update_set', {
    query: `sys_id=${setSysId}`,
    fields: 'sys_id,name,state,application,parent,description,sys_created_by,sys_created_on,sys_updated_on',
    limit: 1, display: 'false',
  });
  if (!set.length) throw new SnowError(`Update set ${setSysId} does not exist on this instance.`, 404);

  const rows = await table.query('sys_update_xml', {
    query: `update_set=${setSysId}^ORDERBYtype^ORDERBYtarget_name`,
    fields: 'sys_id,name,type,target_name,action,application,payload_hash,sys_created_on,sys_updated_on,update_guid',
    limit: 1000, display: 'false',
  });

  const scopeIds = [...new Set(rows.map((r) => raw(r.application)).filter(Boolean))];
  const scopeNames = {};
  for (const id of scopeIds) scopeNames[id] = await scopeLabelFor(id);

  return {
    set: {
      sys_id: raw(set[0].sys_id),
      name: raw(set[0].name),
      state: raw(set[0].state),
      application: raw(set[0].application),
      applicationLabel: await scopeLabelFor(raw(set[0].application)),
      parent: raw(set[0].parent) || null,
      description: raw(set[0].description) || '',
      createdBy: raw(set[0].sys_created_by),
      createdOn: raw(set[0].sys_created_on),
    },
    updates: rows.map((r) => ({
      sys_id: raw(r.sys_id),
      name: raw(r.name),
      type: raw(r.type),
      target: raw(r.target_name),
      action: raw(r.action),
      scope: scopeNames[raw(r.application)] || raw(r.application),
      payloadHash: raw(r.payload_hash),
      updatedOn: raw(r.sys_updated_on),
    })),
    count: rows.length,
    /**
     * Rows sharing a name would each be applied on import, and would make the
     * count read higher than the number of artifacts. The sweep collapses
     * these, so a non-empty list here means something wrote to the set outside
     * NowHelpAssist — worth surfacing rather than hiding.
     */
    duplicateNames: Object.entries(
      rows.reduce((acc, r) => { acc[raw(r.name)] = (acc[raw(r.name)] || 0) + 1; return acc; }, {})
    ).filter(([, n]) => n > 1).map(([name, n]) => ({ name, count: n })),
  };
}

export { workspaceForScope };
