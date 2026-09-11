import crypto from 'node:crypto';
import { getDb } from '../memory/db.js';
import { boundInstance } from '../servicenow/instance-binding.js';

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
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return runId;
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
export function listFindings(runId, { domain, severity, priority, rule, fingerprint, limit = 100, offset = 0, withEvidence = false } = {}) {
  const where = ['run_id = ?'];
  const args = [runId];
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
