import crypto from 'node:crypto';
import { getDb } from '../memory/db.js';
import { boundInstance } from '../servicenow/instance-binding.js';
import { stateMap, QUIET_STATES } from './finding-state.js';
import { scopeFilter, summariseScopes, overallScope, itomScoringOf, SCOPE_KEYS, MODULE_KEYS, SCOPES, moduleTables, scopeOfRule } from './scopes.js';
import { TABLES } from './tables.js';
import { cmdbHistoryFromRuns, cmdbSnapshotEligibility } from './cmdb-history.js';
import { dimensionClause } from './finding-dimensions.js';

/**
 * Durable health runs.
 *
 * Every read is scoped to the CURRENTLY BOUND instance. That is not a filter
 * for tidiness: findings carry sys_ids, and a sys_id is instance-local, so a
 * run from one PDI rendered while another is connected would name records that
 * do not exist and invite someone to go fix them. Switching instances hides the
 * old runs rather than reinterpreting them.
 */

const nowIso = () => new Date().toISOString();

/** The catalogue fields stored beside a finding. */
function scoringOf(f) {
  return {
    base_severity: f.base_severity,
    dimension: f.dimension ?? null,
    gate: Boolean(f.gate),
    escalated_to_systemic: Boolean(f.escalated_to_systemic),
    posture: Boolean(f.posture),
    pattern: Boolean(f.pattern),
    deduction_severity: f.deduction_severity ?? null,
    dedupe_key: f.dedupe_key ?? null,
    deduction_multiplier: f.deduction_multiplier ?? null,
    pattern_fingerprint: f.pattern_fingerprint ?? null,
    lane: f.lane ?? null,
    catalogue_group: f.catalogue_group ?? null,
    modifiers: f.modifiers ?? null,
    false_positive_guard: f.false_positive_guard ?? null,
    materiality: f.materiality ?? null,
    /* ITSM Phase 5 — the catalogue finding's shape and its trace to rule, engine
       and verdict. health_findings has no columns for them and drops unknown
       fields, so they travel in this nullable JSON column (no migration). */
    ...(f.kind ? { kind: f.kind } : {}),
    ...(f.detail ? { detail: f.detail } : {}),
    ...(f.itsm ? { itsm: f.itsm } : {}),
  };
}

function scoringFields(stored) {
  if (!stored) return { catalogued: false };
  return { catalogued: true, ...stored };
}

/**
 * Is a check already running against this instance?
 *
 * Two concurrent runs would extract the same tables twice, write two manifests
 * and leave whichever finished last as "latest" — so the page would show one
 * run's coverage beside the other's findings. Refusing the second is the only
 * honest option, because there is no way to merge two snapshots taken at
 * different cutoffs.
 *
 * WHAT "RUNNING" MEANS. A row at `running` is only a claim; the run is real
 * only while this server process is executing it. Pass `live` — the route's
 * set of runs this process owns — and that is the whole test: a row the process
 * does not own is not in flight, however recent it is.
 *
 * Without `live`, a run older than the timeout is treated as abandoned. That
 * fallback was the ONLY protection once, and it was not enough: a server closed
 * mid-run left its row at `running`, and every restart inside the next thirty
 * minutes — including a reboot — answered "a health check is already running"
 * about a check nothing was running. Measured by a user who restarted the PC
 * and still could not start one.
 */
const ABANDON_AFTER_MS = 30 * 60 * 1000;

export function runInFlight({ live = null } = {}) {
  const bound = boundInstance();
  if (live) {
    /* Every running row, not just the newest: a stale row started after a
       genuinely live one must not hide it. */
    const rows = getDb().prepare(`
      SELECT * FROM health_runs
       WHERE instance_key = ? AND status = 'running'
       ORDER BY started_at DESC
    `).all(bound.key || 'unbound');
    const owned = rows.find((r) => live.has(r.id));
    return owned ? hydrateRun(owned) : null;
  }
  const row = getDb().prepare(`
    SELECT * FROM health_runs
     WHERE instance_key = ? AND status = 'running'
     ORDER BY started_at DESC LIMIT 1
  `).get(bound.key || 'unbound');
  if (!row) return null;
  const age = Date.now() - new Date(row.started_at).getTime();
  if (Number.isFinite(age) && age > ABANDON_AFTER_MS) return null;
  return hydrateRun(row);
}

export const INTERRUPTED_NOTE = 'The server stopped while this check was running, so it never finished. '
  + 'Nothing was written to the instance — a health check only reads. Run it again.';

/**
 * Close out every `running` row this process is not executing.
 *
 * Across ALL instances, because the process that owned them is gone no matter
 * which instance they were against. Recorded as `failed` with a note saying
 * what happened rather than deleted: a check that was interrupted is still a
 * fact about the history, and a page that silently lost it would look like
 * nobody tried. Returns how many rows it closed.
 */
export function abandonOrphanedRuns(liveIds = []) {
  const keep = [...liveIds];
  const placeholders = keep.map(() => '?').join(',');
  const result = getDb().prepare(`
    UPDATE health_runs SET status = 'failed', completed_at = ?, error = ?
     WHERE status = 'running'${keep.length ? ` AND id NOT IN (${placeholders})` : ''}
  `).run(nowIso(), INTERRUPTED_NOTE, ...keep);
  return Number(result?.changes ?? 0);
}

export function openRun({ instanceKey, instanceUrl } = {}) {
  const bound = boundInstance();
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO health_runs (id, instance_key, instance_url, status, started_at)
    VALUES (?, ?, ?, 'running', ?)
  `).run(id, instanceKey || bound.key || 'unbound', instanceUrl || bound.url, nowIso());
  return id;
}

/**
 * Store a finished run.
 *
 * The manifest and the findings land in ONE transaction. A run row saying
 * "completed" beside a half-written findings table would be read as a clean
 * estate, which is the single most expensive way this module could be wrong.
 */
export function completeRun(runId, { status, manifest, findings }) {
  const db = getDb();
  /*
   * Explicit BEGIN/COMMIT, because the storage layer is `node:sqlite`.
   * `DatabaseSync` has no `transaction()` wrapper — that is better-sqlite3's
   * API, and assuming it here cost a live run that had already extracted and
   * analysed the estate before failing at the write. Same shape as the
   * migration runner and `recall.js`.
   */
  db.exec('BEGIN');
  try {
    /* Which modules this run holds results for. A caller that says nothing
       (every run before modules existed) ran a full scan: NULL means all. */
    const modules = Array.isArray(manifest?.modules) ? JSON.stringify(manifest.modules) : null;
    db.prepare(`
      UPDATE health_runs
         SET status = ?, completed_at = ?, cutoff = ?, manifest_json = ?, error = NULL, modules_json = ?
       WHERE id = ?
    `).run(status, nowIso(), manifest?.cutoff ?? null, JSON.stringify(manifest ?? {}), modules, runId);

    db.prepare('DELETE FROM health_findings WHERE run_id = ?').run(runId);
    const insert = db.prepare(`
      INSERT INTO health_findings
        (run_id, fingerprint, rule_id, agent_id, domain, source_table, severity, priority,
         priority_score, confidence, title, description, recommendation, ai_summary,
         target_ids, evidence_json, impact_json, scoring_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const f of findings ?? []) {
      insert.run(
        runId, f.fingerprint, f.rule_id, f.agent_id, f.domain, f.table,
        f.severity, f.priority, f.priority_score, f.confidence,
        f.title, f.description ?? null, f.recommendation ?? null, f.ai_summary ?? null,
        JSON.stringify(f.target_ids ?? []),
        JSON.stringify(f.evidence ?? []),
        JSON.stringify(f.impact ?? null),
        f.base_severity ? JSON.stringify(scoringOf(f)) : null,
      );
    }
    pruneFindings(db, runId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return runId;
}

/**
 * How many runs keep their FINDINGS. Every run keeps its manifest for ever.
 *
 * Storing every finding instead of the first 1,000 means a large instance
 * writes ~12,000 rows per check — ~29,000 on the largest seen — and the
 * database grew without bound on a schedule of daily runs. This, not a cap on
 * one run's rows, is what bounds it (see the note above runHealthCheck in
 * index.js: a run stores everything it counts). The manifest — coverage,
 * counts, every scope's score — is small and is what the trend reads, so it
 * stays; the per-finding rows of older runs are what goes.
 *
 * Nothing that carries a DECISION is touched: lifecycle states are keyed on
 * the fingerprint in their own table, and proposals keep their own copy of what
 * was approved and what ran.
 */
export const KEEP_FINDINGS_FOR_RUNS = 5;

function pruneFindings(db, currentRunId) {
  /*
   * EVERY instance, not just the one that just ran. Measured: after switching
   * to a new instance, the previous PDI kept all eight of its older runs'
   * findings indefinitely, because pruning only ever looked at the instance a
   * check had just completed on — and nobody runs checks on an instance they
   * have switched away from. Each instance still keeps its own newest runs.
   */
  let removed = 0;
  const instances = db.prepare('SELECT DISTINCT instance_key FROM health_runs').all().map((r) => r.instance_key);
  for (const key of instances) {
    const keep = db.prepare(`
      SELECT id FROM health_runs
       WHERE instance_key = ? AND status IN ('completed', 'partial')
       ORDER BY started_at DESC LIMIT ?
    `).all(key, KEEP_FINDINGS_FOR_RUNS).map((r) => r.id);
    if (!keep.includes(currentRunId)) keep.push(currentRunId);
    /* A module's CURRENT result can be many runs old when nothing changed —
       an unchanged CMDB behind ten ITSM-only scans. Its findings are what the
       page shows for that module, so they are never pruned. */
    for (const m of MODULE_KEYS) {
      const current = moduleRunRow(db, key, m);
      if (current && !keep.includes(current.id)) keep.push(current.id);
    }
    const marks = keep.map(() => '?').join(',');
    removed += db.prepare(`
      DELETE FROM health_findings
       WHERE run_id IN (SELECT id FROM health_runs WHERE instance_key = ?)
         AND run_id NOT IN (${marks})
    `).run(key, ...keep).changes;
  }
  return removed;
}

/**
 * A run the user stopped.
 *
 * Distinct from `failed`: nothing went wrong, somebody changed their mind. A
 * cancelled run keeps whatever it had read so the partial coverage is still
 * inspectable, and it is never shown as the latest result.
 */
export function cancelRun(runId) {
  getDb().prepare(`
    UPDATE health_runs SET status = 'cancelled', completed_at = ?,
           error = 'Stopped before it finished. Nothing was written to the instance — a health check only reads.'
     WHERE id = ? AND status = 'running'
  `).run(nowIso(), runId);
}

/**
 * The score and the counts over time.
 *
 * Runs where the score was WITHHELD carry `null` rather than being dropped or
 * zeroed. A trend line that silently skipped them would imply continuity across
 * a gap where coverage was actually incomplete.
 */
export function trend({ limit = 30 } = {}) {
  const bound = boundInstance();
  const rows = getDb().prepare(`
    SELECT id, started_at, status, manifest_json, modules_json FROM health_runs
     WHERE instance_key = ? AND status IN ('completed','partial')
     ORDER BY started_at DESC LIMIT ?
  `).all(bound.key || 'unbound', limit);

  const points = rows.filter((r) => r.modules_json !== '[]').map((r) => {
    let m = null;
    try { m = r.manifest_json ? JSON.parse(r.manifest_json) : null; } catch { m = null; }
    let modules = null;
    try { modules = r.modules_json ? JSON.parse(r.modules_json) : null; } catch { modules = null; }
    /* Per-scope scores where the run recorded them. An older run has only the
       CMDB score, so the other scopes read as `null` — a gap in their line —
       rather than being back-filled with a number nobody measured. */
    const scopes = {};
    const models = {};
    for (const k of SCOPE_KEYS) {
      scopes[k] = m?.scopes?.[k]?.score ?? (k === 'cmdb' ? (m?.metrics?.cmdb_quality_score ?? null) : null);
      /* The scoring model that produced the point. A summary recorded before it
         carried `scoring` is recognised where the identity was stored elsewhere:
         the CMDB model by the run's comparability key, the ITOM model by its
         stored check set. ITSM's pass-rate era stored neither and reads as
         another model — a gap, by design. */
      models[k] = m?.scopes?.[k]?.scoring?.key
        ?? (k === 'cmdb' && m?.scopes?.[k]?.cmdb_quality ? (m?.comparability?.key ?? null) : null)
        ?? (k === 'itom' ? itomScoringOf(m?.scopes?.[k]) : null);
    }
    return {
      runId: r.id,
      at: r.started_at,
      status: r.status,
      /* The modules this point measured. A module's line uses only its own
         points: an ITSM-only scan is not a gap in the CMDB line. */
      modules: modules ?? [...MODULE_KEYS],
      score: m?.metrics?.cmdb_quality_score ?? null,
      scoreWithheld: m?.metrics?.cmdb_quality_score == null,
      scopes,
      models,
      findings: m?.findings_detected ?? m?.findings_stored ?? null,
      severity: m?.severity_counts ?? {},
      visibleCis: m?.metrics?.visible_cis ?? null,
    };
  }).reverse();

  /*
   * A LINE RUNS ONLY WITHIN ONE SCORING MODEL. A scope whose newest point
   * declares a model key keeps only the points made under that key; a point
   * under another model — or under none, the pass rate ITSM used before
   * itsm-quality/1 — reads as a gap. Joining 0.7 to 89 across a model change
   * would draw a recovery that never happened. The older points stay in the
   * store untouched; only the line refuses them.
   */
  for (const k of SCOPE_KEYS) {
    const newest = [...points].reverse().find((p) => p.scopes[k] != null && p.models[k]);
    if (!newest) continue;
    for (const p of points) {
      if (p.scopes[k] != null && p.models[k] !== newest.models[k]) {
        p.scopes[k] = null;
        (p.model_breaks ||= []).push(k);
      }
    }
  }
  return points;
}

/**
 * Earlier runs' CMDB measures, oldest first — the trend rules' input (CMDB-038).
 *
 * Read here and passed in, because the rule pack never touches the database.
 * Only runs that recorded the measure are returned; a run from before Group 4
 * is a gap, never a zero.
 */
/**
 * The CMDB history a scan hands to the trend rules. See `cmdb-history.js`.
 *
 * Over-fetches runs because ITSM-only scans and verifications crowd the table
 * and are not CMDB snapshots, then loads the stored findings of the most recent
 * eligible snapshots — the fingerprints net position (CMDB-131) and recurrence
 * (CMDB-132) compare. Fingerprints are bounded to `fingerprintRuns` snapshots
 * so the read stays proportional to the trend it serves, not to history.
 */
export function cmdbMeasureHistory({ limit = 12, fingerprintRuns = 6 } = {}) {
  const bound = boundInstance();
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, started_at, status, modules_json, manifest_json FROM health_runs
     WHERE instance_key = ? AND status IN ('completed','partial')
     ORDER BY started_at DESC LIMIT ?
  `).all(bound.key || 'unbound', limit * 4);
  const runs = [];
  for (const r of rows) {
    let manifest = null;
    let modules = null;
    try { manifest = r.manifest_json ? JSON.parse(r.manifest_json) : null; } catch { manifest = null; }
    try { modules = r.modules_json ? JSON.parse(r.modules_json) : null; } catch { modules = null; }
    runs.push({ id: r.id, started_at: r.started_at, status: r.status, modules, manifest });
  }
  const eligibleRecent = runs.filter((run) => cmdbSnapshotEligibility(run).ok).slice(0, limit);
  const excluded = runs.filter((run) => !cmdbSnapshotEligibility(run).ok).slice(0, limit);
  const findingsOf = db.prepare('SELECT fingerprint, rule_id, domain FROM health_findings WHERE run_id = ?');
  eligibleRecent.slice(0, fingerprintRuns).forEach((run) => { run.findings = findingsOf.all(run.id); });
  return cmdbHistoryFromRuns([...eligibleRecent, ...excluded]);
}

/**
 * The stored runs an ITSM scan's trend rules may draw readings from — newest
 * first, for the bound instance only. Shaped and filtered by the health facade
 * (`itsmMeasureHistoryFrom`, itsm/measure-history.js): this only reads.
 */
export function itsmHistoryRuns({ limit = 24 } = {}) {
  const bound = boundInstance();
  const rows = getDb().prepare(`
    SELECT id, started_at, status, manifest_json FROM health_runs
     WHERE instance_key = ? AND status IN ('completed','partial')
     ORDER BY started_at DESC LIMIT ?
  `).all(bound.key || 'unbound', limit * 2);
  const runs = [];
  for (const r of rows) {
    let manifest = null;
    try { manifest = r.manifest_json ? JSON.parse(r.manifest_json) : null; } catch { manifest = null; }
    if (!manifest?.itsm) continue;
    runs.push({ id: r.id, started_at: r.started_at, status: r.status, manifest });
    if (runs.length >= limit) break;
  }
  return runs;
}

/**
 * Per-scope summaries for a run — stored ones, or computed for an older run.
 *
 * Runs recorded before the switch existed carry no `scopes` in their manifest.
 * They are re-read rather than hidden: the summary is computed from the stored
 * findings with the same pure function a new run uses. When that run stored
 * only part of its findings, `truncated` makes every score withhold itself —
 * a score computed from 1,000 of 12,194 findings would be confidently wrong.
 */
export function scopesForRun(run) {
  if (!run?.manifest) return null;
  /* Stored summaries are used as-is only when they carry every field the page
     reads. A run summarised before score drivers existed is recomputed from its
     stored findings, so it gains the breakdown without being re-extracted. */
  const stored = run.manifest.scopes;
  if (stored && Object.values(stored).every((x) => x && 'score_drivers' in x)) return stored;
  const rows = getDb().prepare(
    'SELECT rule_id, domain, source_table, severity, target_ids FROM health_findings WHERE run_id = ?',
  ).all(run.id);
  const findings = rows.map((r) => {
    let ids = [];
    try { ids = JSON.parse(r.target_ids || '[]'); } catch { ids = []; }
    return { rule_id: r.rule_id, domain: r.domain, table: r.source_table, severity: r.severity, target_ids: ids };
  });
  const detected = run.manifest.findings_detected;
  const truncated = Boolean(run.manifest.findings_truncated)
    || (detected != null && detected > findings.length);
  return summariseScopes(run.manifest.coverage || {}, findings, { truncated });
}

/** Record a run that did not finish. A failed run stays visible — it is evidence too. */
export function failRun(runId, error) {
  getDb().prepare(`
    UPDATE health_runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?
  `).run(nowIso(), String(error?.message || error).slice(0, 2000), runId);
}

function hydrateRun(row) {
  if (!row) return null;
  let manifest = null;
  try {
    manifest = row.manifest_json ? JSON.parse(row.manifest_json) : null;
  } catch {
    /* A manifest that will not parse is reported as absent rather than crashing
       the page. The findings rows beside it are still readable and still true. */
    manifest = null;
  }
  let modules = null;
  try { modules = row.modules_json ? JSON.parse(row.modules_json) : null; } catch { modules = null; }
  return {
    id: row.id,
    instance: row.instance_url,
    status: row.status,
    modules: modules ?? (['completed', 'partial'].includes(row.status) ? [...MODULE_KEYS] : null),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cutoff: row.cutoff,
    error: row.error,
    manifest,
  };
}

export function listRuns({ limit = 20 } = {}) {
  const bound = boundInstance();
  return getDb().prepare(`
    SELECT * FROM health_runs WHERE instance_key = ? ORDER BY started_at DESC LIMIT ?
  `).all(bound.key || 'unbound', limit).map(hydrateRun);
}

export function getRun(runId) {
  const bound = boundInstance();
  return hydrateRun(getDb().prepare(
    'SELECT * FROM health_runs WHERE id = ? AND instance_key = ?',
  ).get(runId, bound.key || 'unbound'));
}

/** The most recent run that actually produced results. A verification-only run has none. */
export function latestRun() {
  const bound = boundInstance();
  return hydrateRun(getDb().prepare(`
    SELECT * FROM health_runs
     WHERE instance_key = ? AND status IN ('completed', 'partial')
       AND (modules_json IS NULL OR modules_json <> '[]')
     ORDER BY started_at DESC LIMIT 1
  `).get(bound.key || 'unbound'));
}

/* ══════════════════════════════════════════════════════════════════════════
   MODULES — each keeps its own latest result
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The newest finished run that holds results for a module. NULL `modules_json`
 * is a run from before modules existed, which was a full scan.
 */
function moduleRunRow(db, instanceKey, module) {
  return db.prepare(`
    SELECT * FROM health_runs
     WHERE instance_key = ? AND status IN ('completed', 'partial')
       AND (modules_json IS NULL OR modules_json LIKE ?)
     ORDER BY started_at DESC LIMIT 1
  `).get(instanceKey, `%"${module}"%`);
}

export function moduleRun(module) {
  const bound = boundInstance();
  return hydrateRun(moduleRunRow(getDb(), bound.key || 'unbound', module));
}

function moduleStateRows(instanceKey) {
  return Object.fromEntries(getDb().prepare('SELECT * FROM health_module_state WHERE instance_key = ?')
    .all(instanceKey).map((r) => [r.module, r]));
}

/**
 * For each module, what its current result was computed from — the change
 * check's baseline. Everything comes from THAT run's manifest, so a later scan
 * of another module that re-read a shared table cannot move it.
 */
export function moduleBaselines() {
  const out = {};
  for (const m of MODULE_KEYS) {
    const run = moduleRun(m);
    if (!run?.manifest) continue;
    const man = run.manifest;
    out[m] = {
      runId: run.id,
      status: run.status,
      checkedAt: run.startedAt,
      engineKey: man.engine_keys?.[m] ?? null,
      user: man.connection_user ?? null,
      dependencies: man.dependencies?.[m] ?? null,
      degraded: man.degraded?.[m] ?? null,
      stamps: man.stamps ?? null,
      specHashes: man.spec_hashes ?? null,
      /* The stamps a module's own reads were compared against: CMDB's governance
         reads, and — ITSM Phase 5 — every table the ITSM catalogue read. */
      metaStamps: m === 'cmdb' ? (man.meta_stamps ?? null) : m === 'itsm' ? (man.itsm_stamps ?? null) : undefined,
    };
  }
  return out;
}

/* ── ITSM catalogue parameter overrides (ITSM Phase 5, migration 29) ──────── */

/** This instance's stored overrides, as `{ rule_id, key, value, set_by, set_at }`. */
export function itsmParameterOverrides() {
  const bound = boundInstance();
  return getDb().prepare(`
    SELECT rule_id, param_key, value_json, set_by, set_at FROM health_itsm_parameters
     WHERE instance_key = ? ORDER BY rule_id, param_key
  `).all(bound.key || 'unbound').map((r) => ({ rule_id: r.rule_id, key: r.param_key, value: JSON.parse(r.value_json), set_by: r.set_by, set_at: r.set_at }));
}

/** Store one override. The caller validates it against the declaration first. */
export function setItsmParameterOverride({ ruleId, key, value, by = null }) {
  const bound = boundInstance();
  getDb().prepare(`
    INSERT INTO health_itsm_parameters (instance_key, rule_id, param_key, value_json, set_by, set_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT (instance_key, rule_id, param_key) DO UPDATE SET value_json = excluded.value_json, set_by = excluded.set_by, set_at = excluded.set_at
  `).run(bound.key || 'unbound', ruleId, key, JSON.stringify(value), by, nowIso());
}

/** Remove one override; true when there was one. */
export function clearItsmParameterOverride({ ruleId, key }) {
  const bound = boundInstance();
  return getDb().prepare('DELETE FROM health_itsm_parameters WHERE instance_key = ? AND rule_id = ? AND param_key = ?')
    .run(bound.key || 'unbound', ruleId, key).changes > 0;
}

/** Per table: the incremental setting the change check honours. */
export function tableSettings() {
  const bound = boundInstance();
  const rows = getDb().prepare('SELECT table_name, enabled FROM health_table_scan_state WHERE instance_key = ?')
    .all(bound.key || 'unbound');
  return Object.fromEntries(rows.map((r) => [r.table_name, { enabled: Boolean(r.enabled) }]));
}

/**
 * Record what a FINISHED run established — called only after `completeRun`,
 * so a failed or stopped scan leaves every stamp and verification as it was.
 *
 *   tables read completely  → last read, stamp and spec hash
 *   tables change-checked   → last check result
 *   modules verified        → "still true at", against the run that produced them
 *   modules re-read         → their new result is this run; the reasons are kept
 */
export function recordScanOutcome(runId, { manifest } = {}) {
  if (!manifest) return;
  const bound = boundInstance();
  const key = bound.key || 'unbound';
  const at = nowIso();
  const db = getDb();
  db.exec('BEGIN');
  try {
    const upsertRead = db.prepare(`
      INSERT INTO health_table_scan_state
        (instance_key, table_name, spec_hash, last_read_at, last_read_run_id, last_stamp_count, last_stamp_max, last_stamp_error, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(instance_key, table_name) DO UPDATE SET
        spec_hash = excluded.spec_hash, last_read_at = excluded.last_read_at, last_read_run_id = excluded.last_read_run_id,
        last_stamp_count = excluded.last_stamp_count, last_stamp_max = excluded.last_stamp_max,
        last_stamp_error = excluded.last_stamp_error, updated_at = excluded.updated_at
    `);
    for (const [t, st] of Object.entries(manifest.stamps || {})) {
      upsertRead.run(key, t, manifest.spec_hashes?.[t] ?? null, at, runId,
        st?.count ?? null, st?.max_updated ?? null, st?.error ?? null, at);
    }
    const upsertCheck = db.prepare(`
      INSERT INTO health_table_scan_state
        (instance_key, table_name, last_check_at, last_check_changed, last_check_reason, deletion_log, updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(instance_key, table_name) DO UPDATE SET
        last_check_at = excluded.last_check_at, last_check_changed = excluded.last_check_changed,
        last_check_reason = excluded.last_check_reason,
        deletion_log = COALESCE(excluded.deletion_log, health_table_scan_state.deletion_log),
        updated_at = excluded.updated_at
    `);
    for (const [t, c] of Object.entries(manifest.plan?.tables || {})) {
      upsertCheck.run(key, t, at, c.changed ? 1 : 0, c.reason ?? null,
        c.deletion_log == null ? null : (c.deletion_log ? 1 : 0), at);
    }
    const upsertModule = db.prepare(`
      INSERT INTO health_module_state (instance_key, module, source_run_id, verified_at, verified_by_run_id, last_reasons_json, updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(instance_key, module) DO UPDATE SET
        source_run_id = excluded.source_run_id, verified_at = excluded.verified_at,
        verified_by_run_id = excluded.verified_by_run_id, last_reasons_json = excluded.last_reasons_json,
        updated_at = excluded.updated_at
    `);
    for (const m of manifest.verified_modules || []) {
      const p = manifest.plan?.modules?.[m];
      upsertModule.run(key, m, p?.source_run_id ?? null, p?.verified_at ?? at, runId, null, at);
    }
    for (const m of manifest.modules || []) {
      upsertModule.run(key, m, runId, null, null, JSON.stringify(manifest.plan?.modules?.[m]?.reasons ?? null), at);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Turn incremental checking on or off for one table. Off means: always read in full. */
export function setTableIncremental(tableName, enabled) {
  if (!TABLES[tableName]) {
    throw Object.assign(new Error(`${tableName} is not in the Health Assist allow-list`), { status: 422 });
  }
  const bound = boundInstance();
  getDb().prepare(`
    INSERT INTO health_table_scan_state (instance_key, table_name, enabled, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(instance_key, table_name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
  `).run(bound.key || 'unbound', tableName, enabled ? 1 : 0, nowIso());
}

/** The configuration table as the page shows it: every allow-listed table, and its modules. */
export function scanStateTable() {
  const bound = boundInstance();
  const rows = Object.fromEntries(getDb().prepare('SELECT * FROM health_table_scan_state WHERE instance_key = ?')
    .all(bound.key || 'unbound').map((r) => [r.table_name, r]));
  return Object.keys(TABLES).map((t) => {
    const r = rows[t] || {};
    return {
      table: t,
      modules: MODULE_KEYS.filter((m) => moduleTables([m]).includes(t)),
      enabled: r.enabled == null ? true : Boolean(r.enabled),
      last_read_at: r.last_read_at ?? null,
      last_read_run_id: r.last_read_run_id ?? null,
      rows: r.last_stamp_count ?? null,
      newest_change: r.last_stamp_max ?? null,
      unreadable: r.last_stamp_error ?? null,
      deletion_log: r.deletion_log == null ? null : Boolean(r.deletion_log),
      last_check_at: r.last_check_at ?? null,
      last_check_changed: r.last_check_changed == null ? null : Boolean(r.last_check_changed),
      last_check_reason: r.last_check_reason ?? null,
    };
  });
}

/**
 * Each module's current result, with its times.
 *
 *   checkedAt   when the rows behind the result were read
 *   verifiedAt  when a later scan last confirmed nothing it depends on changed
 */
export function moduleResults() {
  const bound = boundInstance();
  const states = moduleStateRows(bound.key || 'unbound');
  const out = {};
  for (const m of MODULE_KEYS) {
    const run = moduleRun(m);
    const st = states[m];
    let reasons = null;
    try { reasons = st?.last_reasons_json ? JSON.parse(st.last_reasons_json) : null; } catch { reasons = null; }
    out[m] = run ? {
      module: m,
      runId: run.id,
      status: run.status,
      degraded: run.manifest?.degraded?.[m] ?? null,
      checkedAt: run.startedAt,
      verifiedAt: st && st.source_run_id === run.id ? st.verified_at : null,
      verifiedByRunId: st && st.source_run_id === run.id ? st.verified_by_run_id : null,
      reasons,
    } : { module: m, runId: null, status: null, checkedAt: null, verifiedAt: null, reasons: null };
  }
  return out;
}

/**
 * THE ALL VIEW — composed from each module's own latest result.
 *
 * Nothing here is recomputed from rows: every module contributes the summary,
 * coverage and skipped checks its own run recorded, and the All numbers are
 * sums of those. A module with no result contributes nothing and is named.
 */
export function composedView() {
  const results = moduleResults();
  const runs = {};
  for (const m of MODULE_KEYS) if (results[m].runId) runs[m] = getRun(results[m].runId);
  const present = MODULE_KEYS.filter((m) => runs[m]?.manifest);
  if (!present.length) return null;

  const scopes = {};
  const coverage = {};
  const coverageAt = {};
  const skipped = [];
  const severity = {};
  const domains = new Map();
  let findings = 0;
  for (const m of present) {
    const run = runs[m];
    const summary = scopesForRun(run)?.[m];
    if (summary) {
      scopes[m] = { ...summary, checked_at: results[m].checkedAt, verified_at: results[m].verifiedAt, run_id: run.id };
      findings += summary.findings || 0;
      for (const [k, n] of Object.entries(summary.severity_counts || {})) severity[k] = (severity[k] || 0) + n;
      for (const d of summary.domains || []) {
        const cur = domains.get(d.domain) || { ...d, findings: 0 };
        cur.findings += d.findings || 0;
        domains.set(d.domain, cur);
      }
    }
    const inputs = new Set([...moduleTables([m]), ...(run.manifest.dependencies?.[m] || [])]);
    for (const [t, c] of Object.entries(run.manifest.coverage || {})) {
      if (!inputs.has(t) || c.status === 'not_requested') continue;
      /* A table two modules read is shown as its most recent read. */
      if (!coverageAt[t] || run.startedAt > coverageAt[t]) { coverage[t] = c; coverageAt[t] = run.startedAt; }
    }
    skipped.push(...(run.manifest.skipped_checks || []).filter((x) => scopeOfRule(x.rule) === m));
  }
  const cmdbRun = runs.cmdb?.manifest ? runs.cmdb : null;
  const allScope = SCOPES.find((x) => x.key === 'all');
  /*
   * THE OVERALL (overall-health.js), over each area's LATEST result — the
   * Full System Scan the page shows. The same function a full scan's manifest
   * uses, so the composed number and a stored run's number agree whenever the
   * module results are the same. An area with no result is absent from the
   * mean and named in the assessment; it is never 0 and never 100.
   */
  const overall = overallScope(Object.fromEntries(MODULE_KEYS.map((m) => [m, scopes[m] ?? null])), coverage);
  scopes.all = {
    key: 'all', label: allScope.label, description: allScope.description,
    checks: null, score_drivers: null,
    findings,
    severity_counts: severity,
    gate: scopes.cmdb?.gate ?? null,
    cmdb_quality: null,
    domains: [...domains.values()],
    tables: null,
    ...overall,
  };
  const newest = present.map((m) => results[m].checkedAt).sort().pop();
  return {
    id: null,
    composed: true,
    status: present.some((m) => runs[m].status === 'partial') ? 'partial' : 'completed',
    startedAt: newest,
    modules: results,
    missing_modules: MODULE_KEYS.filter((m) => !present.includes(m)),
    manifest: {
      kind: 'composed',
      scopes,
      coverage,
      skipped_checks: skipped,
      cmdb_quality: cmdbRun?.manifest?.cmdb_quality ?? null,
      metrics: cmdbRun?.manifest?.metrics ?? {},
      findings_detected: findings,
      findings_stored: findings,
      severity_counts: severity,
      domains: [...domains.values()],
    },
  };
}

/**
 * The findings search, as SQL.
 *
 * Measured: a duplicate-CI set (CMDB-033/034/035/036, SYSTEMIC) ranked #560 of
 * 22,782 in a CMDB view, and the page's search covered only the 200 rows it had
 * loaded — so "Serial number duplicate", the CI's name, its serial and its
 * sys_id all returned nothing, which reads as "not detected". The search
 * therefore runs HERE, over every stored row of the run, not over the page.
 *
 * Every whitespace-separated term must appear somewhere in the finding: the
 * title, description, rule id, domain, table, the target sys_ids, or the
 * evidence (which carries the CI names, serials and addresses a rule quoted).
 * `%` and `_` in a term are literal, so a sys_id or an IP is matched as typed.
 */
const SEARCH_COLUMNS = ['title', 'description', 'rule_id', 'domain', 'source_table', 'target_ids', 'evidence_json'];
function searchClause(q) {
  const terms = String(q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const clauses = [];
  const args = [];
  for (const term of terms) {
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    clauses.push(`(${SEARCH_COLUMNS.map((c) => `LOWER(COALESCE(${c}, '')) LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (let i = 0; i < SEARCH_COLUMNS.length; i++) args.push(like);
  }
  return { clause: clauses.join(' AND '), args };
}

/**
 * Findings across the modules' own runs — each module's findings from its own
 * current result. Every row carries `run_id`, so opening one reads it from the
 * run it belongs to.
 */
/*
 * The WHERE clause of the module findings view — each module's rows from its
 * own current run, plus the page's filters. One builder, so the list, its
 * total and the dimension counts can never disagree about which findings are
 * "in view". `null` when no module has a result.
 *
 * `dimension` narrows by a rule-level classification resolved in SQL
 * (health/finding-dimensions.js): the finding rows are read, never rewritten.
 * `rules` is an explicit rule-id list, used to preview a dimension not yet saved.
 */
function moduleFindingsWhere({ scope = 'all', domain, severity, priority, rule, q, dimension, rules } = {}) {
  /* Resolved first: an unknown dimension is a 404 even before any scan exists,
     never an empty page that reads as "nothing in this dimension". */
  const dim = dimension ? dimensionClause(dimension) : null;
  const results = moduleResults();
  const modules = scope && scope !== 'all' ? [scope] : MODULE_KEYS;
  const pairs = modules.filter((m) => results[m]?.runId).map((m) => ({ runId: results[m].runId, module: m }));
  if (!pairs.length) return null;
  const clauses = [];
  const args = [];
  for (const p of pairs) {
    const sf = scopeFilter(p.module);
    clauses.push(`(run_id = ? AND ${sf.clause})`);
    args.push(p.runId, ...sf.args);
  }
  const where = [`(${clauses.join(' OR ')})`];
  if (domain) { where.push('domain = ?'); args.push(domain); }
  if (severity) { where.push('severity = ?'); args.push(severity); }
  if (priority) { where.push('priority = ?'); args.push(priority); }
  if (rule) { where.push('rule_id = ?'); args.push(rule); }
  if (dim) { where.push(dim.clause); args.push(...dim.args); }
  if (Array.isArray(rules)) {
    if (!rules.length) where.push('0');
    else { where.push(`rule_id IN (${rules.map(() => '?').join(',')})`); args.push(...rules); }
  }
  const search = searchClause(q);
  if (search) { where.push(search.clause); args.push(...search.args); }
  return { where, args };
}

/**
 * Findings in view, counted per (rule, severity, domain) — the input to
 * dimension totals, the dimension × severity matrix, a dimension's top rules
 * and its related modules. One GROUP BY over the same rows
 * the list shows (muted ones included, as every other count on the page does),
 * so dimension counts cost one query however many dimensions exist.
 */
export function moduleRuleSeverityCounts(filters = {}) {
  const w = moduleFindingsWhere(filters);
  if (!w) return [];
  return getDb().prepare(`
    SELECT rule_id, severity, domain, COUNT(*) AS n FROM health_findings
     WHERE ${w.where.join(' AND ')}
     GROUP BY rule_id, severity, domain
  `).all(...w.args);
}

export function listModuleFindings({ scope = 'all', domain, severity, priority, rule, q, dimension, limit = 100, offset = 0 } = {}) {
  const w = moduleFindingsWhere({ scope, domain, severity, priority, rule, q, dimension });
  if (!w) return { total: 0, limit, offset, findings: [] };
  const { where, args } = w;
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM health_findings WHERE ${where.join(' AND ')}
     ORDER BY priority_score DESC, fingerprint ASC LIMIT ? OFFSET ?
  `).all(...args, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM health_findings WHERE ${where.join(' AND ')}`).get(...args).n;
  const states = stateMap();
  /* The same shape a single-run list gives, plus the run each row belongs to. */
  return { total, limit, offset, findings: rows.map((r) => ({ ...shapeFinding(r, states), run_id: r.run_id })) };
}

/**
 * Findings for a run, newest-priority first.
 *
 * `evidence` is returned only when a single finding is asked for. A list of 900
 * findings each carrying its evidence rows is megabytes of JSON the list view
 * never renders.
 */
export function listFindings(runId, { scope, domain, severity, priority, rule, q, dimension, fingerprint, limit = 100, offset = 0, withEvidence = false } = {}) {
  const where = ['run_id = ?'];
  const args = [runId];
  const sf = scopeFilter(scope);
  if (sf) { where.push(sf.clause); args.push(...sf.args); }
  if (domain) { where.push('domain = ?'); args.push(domain); }
  if (severity) { where.push('severity = ?'); args.push(severity); }
  if (priority) { where.push('priority = ?'); args.push(priority); }
  if (rule) { where.push('rule_id = ?'); args.push(rule); }
  if (dimension) { const d = dimensionClause(dimension); where.push(d.clause); args.push(...d.args); }
  if (fingerprint) { where.push('fingerprint = ?'); args.push(fingerprint); }
  const search = searchClause(q);
  if (search) { where.push(search.clause); args.push(...search.args); }

  const rows = getDb().prepare(`
    SELECT * FROM health_findings WHERE ${where.join(' AND ')}
     ORDER BY priority_score DESC, fingerprint ASC LIMIT ? OFFSET ?
  `).all(...args, limit, offset);

  const total = getDb().prepare(
    `SELECT COUNT(*) AS n FROM health_findings WHERE ${where.join(' AND ')}`,
  ).get(...args).n;

  /* Lifecycle state is joined in memory rather than in SQL: it lives in a
     different table keyed by instance+fingerprint, and a LEFT JOIN here would
     make every findings query depend on that table existing. */
  const states = stateMap();

  return {
    total,
    limit,
    offset,
    findings: rows.map((r) => shapeFinding(r, states, withEvidence)),
  };
}

const parseJson = (raw, fallback) => {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};

/** One stored finding row, in the shape every list returns. */
function shapeFinding(r, states, withEvidence = false) {
  const parse = parseJson;
  return {
    fingerprint: r.fingerprint,
    rule_id: r.rule_id,
    agent_id: r.agent_id,
    domain: r.domain,
    table: r.source_table,
    severity: r.severity,
    priority: r.priority,
    priority_score: r.priority_score,
    confidence: r.confidence,
    title: r.title,
    description: r.description,
    recommendation: r.recommendation,
    ai_summary: r.ai_summary,
    target_ids: parse(r.target_ids, []),
    impact: parse(r.impact_json, null),
    /* Present only for SAOS catalogue rules. `gate` is BASE-Systemic;
       `escalated_to_systemic` is a record finding its context pushed there —
       kept apart, because only the first makes the score untrustworthy. */
    ...scoringFields(parse(r.scoring_json, null)),
    /* `open` when nobody has said otherwise — never absent, so the UI has
       one shape to render rather than two. */
    lifecycle: states.get(r.fingerprint) || { state: 'open', reason: null },
    quiet: QUIET_STATES.includes(states.get(r.fingerprint)?.state),
    ...(withEvidence ? { evidence: parse(r.evidence_json, []) } : {}),
  };
}

/** One finding, with its evidence rows — the detail view's source. */
export function getFinding(runId, fingerprint) {
  const { findings } = listFindings(runId, { limit: 1, withEvidence: true, fingerprint });
  return findings[0] ?? null;
}

export function deleteRun(runId) {
  const bound = boundInstance();
  const res = getDb().prepare(
    'DELETE FROM health_runs WHERE id = ? AND instance_key = ?',
  ).run(runId, bound.key || 'unbound');
  return res.changes > 0;
}
