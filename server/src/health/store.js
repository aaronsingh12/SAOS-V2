import crypto from 'node:crypto';
import { getDb } from '../memory/db.js';
import { boundInstance } from '../servicenow/instance-binding.js';
import { stateMap, QUIET_STATES } from './finding-state.js';
import { scopeFilter, summariseScopes, SCOPE_KEYS } from './scopes.js';

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
    db.prepare(`
      UPDATE health_runs
         SET status = ?, completed_at = ?, cutoff = ?, manifest_json = ?, error = NULL
       WHERE id = ?
    `).run(status, nowIso(), manifest?.cutoff ?? null, JSON.stringify(manifest ?? {}), runId);

    db.prepare('DELETE FROM health_findings WHERE run_id = ?').run(runId);
    const insert = db.prepare(`
      INSERT INTO health_findings
        (run_id, fingerprint, rule_id, agent_id, domain, source_table, severity, priority,
         priority_score, confidence, title, description, recommendation, ai_summary,
         target_ids, evidence_json, impact_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const f of findings ?? []) {
      insert.run(
        runId, f.fingerprint, f.rule_id, f.agent_id, f.domain, f.table,
        f.severity, f.priority, f.priority_score, f.confidence,
        f.title, f.description ?? null, f.recommendation ?? null, f.ai_summary ?? null,
        JSON.stringify(f.target_ids ?? []),
        JSON.stringify(f.evidence ?? []),
        JSON.stringify(f.impact ?? null),
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
 * Storing every finding instead of the first 1,000 (see MAX_FINDINGS) means a
 * large instance writes ~12,000 rows per check, and the database grew without
 * bound on a schedule of daily runs. The manifest — coverage, counts, every
 * scope's score — is small and is what the trend reads, so it stays; the
 * per-finding rows of older runs are what goes.
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
    SELECT id, started_at, status, manifest_json FROM health_runs
     WHERE instance_key = ? AND status IN ('completed','partial')
     ORDER BY started_at DESC LIMIT ?
  `).all(bound.key || 'unbound', limit);

  return rows.map((r) => {
    let m = null;
    try { m = r.manifest_json ? JSON.parse(r.manifest_json) : null; } catch { m = null; }
    /* Per-scope scores where the run recorded them. An older run has only the
       CMDB score, so the other scopes read as `null` — a gap in their line —
       rather than being back-filled with a number nobody measured. */
    const scopes = {};
    for (const k of SCOPE_KEYS) {
      scopes[k] = m?.scopes?.[k]?.score ?? (k === 'cmdb' ? (m?.metrics?.cmdb_quality_score ?? null) : null);
    }
    return {
      runId: r.id,
      at: r.started_at,
      status: r.status,
      score: m?.metrics?.cmdb_quality_score ?? null,
      scoreWithheld: m?.metrics?.cmdb_quality_score == null,
      scopes,
      findings: m?.findings_detected ?? m?.findings_stored ?? null,
      severity: m?.severity_counts ?? {},
      visibleCis: m?.metrics?.visible_cis ?? null,
    };
  }).reverse();
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
  return {
    id: row.id,
    instance: row.instance_url,
    status: row.status,
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

/** The most recent run that actually produced a manifest. */
export function latestRun() {
  const bound = boundInstance();
  return hydrateRun(getDb().prepare(`
    SELECT * FROM health_runs
     WHERE instance_key = ? AND status IN ('completed', 'partial')
     ORDER BY started_at DESC LIMIT 1
  `).get(bound.key || 'unbound'));
}

/**
 * Findings for a run, newest-priority first.
 *
 * `evidence` is returned only when a single finding is asked for. A list of 900
 * findings each carrying its evidence rows is megabytes of JSON the list view
 * never renders.
 */
export function listFindings(runId, { scope, domain, severity, priority, rule, fingerprint, limit = 100, offset = 0, withEvidence = false } = {}) {
  const where = ['run_id = ?'];
  const args = [runId];
  const sf = scopeFilter(scope);
  if (sf) { where.push(sf.clause); args.push(...sf.args); }
  if (domain) { where.push('domain = ?'); args.push(domain); }
  if (severity) { where.push('severity = ?'); args.push(severity); }
  if (priority) { where.push('priority = ?'); args.push(priority); }
  if (rule) { where.push('rule_id = ?'); args.push(rule); }
  if (fingerprint) { where.push('fingerprint = ?'); args.push(fingerprint); }

  const rows = getDb().prepare(`
    SELECT * FROM health_findings WHERE ${where.join(' AND ')}
     ORDER BY priority_score DESC, fingerprint ASC LIMIT ? OFFSET ?
  `).all(...args, limit, offset);

  const total = getDb().prepare(
    `SELECT COUNT(*) AS n FROM health_findings WHERE ${where.join(' AND ')}`,
  ).get(...args).n;

  const parse = (raw, fallback) => {
    try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  };

  /* Lifecycle state is joined in memory rather than in SQL: it lives in a
     different table keyed by instance+fingerprint, and a LEFT JOIN here would
     make every findings query depend on that table existing. */
  const states = stateMap();

  return {
    total,
    limit,
    offset,
    findings: rows.map((r) => ({
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
      /* `open` when nobody has said otherwise — never absent, so the UI has
         one shape to render rather than two. */
      lifecycle: states.get(r.fingerprint) || { state: 'open', reason: null },
      quiet: QUIET_STATES.includes(states.get(r.fingerprint)?.state),
      ...(withEvidence ? { evidence: parse(r.evidence_json, []) } : {}),
    })),
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
