import { getDb } from './db.js';
import { deleteTasksForInstance, taskSessionsForInstance } from './tasks.js';
import { log } from '../logging.js';

/**
 * LOG OUT MEANS THE INSTANCE'S DATA GOES WITH IT.
 *
 * Every row this app files under a ServiceNow instance is deleted when that
 * instance is logged out of, so the next login starts from nothing and builds
 * new scores and metrics rather than showing the last session's. The operator
 * chose this scope explicitly, audit trail included: logging out is the one
 * action that says "forget this instance".
 *
 * WHAT IS NOT TOUCHED. Rows filed under any OTHER instance, the ServiceNow
 * documentation corpus (`kb_*`, which is about the platform, not an instance),
 * meeting recordings (`meetings` and their segments and findings — audio on
 * disk, not instance data; only the build plans a meeting filed against this
 * instance go), and facts filed as '*' or '(unbound)', which describe no
 * instance.
 *
 * TWO KEY SHAPES. The health tables file by host (`instance_key`, the form
 * `instanceKeyFrom` produces). Everything else files by the connection URL as
 * it was saved — so both schemes are matched, case-insensitively, rather than
 * trusting one spelling of the address.
 *
 * One transaction: a purge that half-lands would leave findings without runs,
 * or a ledger without its chats, which is worse than either state.
 */
export function purgeInstanceData({ url, key } = {}) {
  const host = String(key || '').toLowerCase();
  if (!host) return { ok: false, reason: 'no instance to purge', deleted: {} };
  const urls = [`https://${host}`, `http://${host}`];
  const db = getDb();
  const deleted = {};
  const run = (label, sql, ...params) => {
    deleted[label] = (deleted[label] || 0) + Number(db.prepare(sql).run(...params).changes || 0);
  };
  const URL_MATCH = "lower(rtrim(instance, '/')) IN (?, ?)";

  db.exec('BEGIN');
  try {
    /* Every session this instance owns, including sessions whose chat was
       already deleted but whose audit rows still name this instance. */
    db.exec('DROP TABLE IF EXISTS temp.purge_sessions');
    db.exec('CREATE TEMP TABLE purge_sessions (id TEXT PRIMARY KEY)');
    for (const sql of [
      `SELECT id FROM sessions WHERE ${URL_MATCH}`,
      `SELECT DISTINCT session FROM tool_events WHERE ${URL_MATCH}`,
      `SELECT DISTINCT session FROM mutation_ledger WHERE ${URL_MATCH}`,
    ]) db.prepare(`INSERT OR IGNORE INTO purge_sessions ${sql}`).run(...urls);
    const addSession = db.prepare('INSERT OR IGNORE INTO purge_sessions (id) VALUES (?)');
    for (const id of taskSessionsForInstance(urls)) addSession.run(id);
    const inSessions = 'IN (SELECT id FROM temp.purge_sessions)';

    /* Health: scores, metrics, findings, proposals, scan state, settings. */
    run('health_findings', 'DELETE FROM health_findings WHERE run_id IN (SELECT id FROM health_runs WHERE lower(instance_key) = ?)', host);
    run('health_proposals', 'DELETE FROM health_proposals WHERE lower(instance_key) = ? OR run_id IN (SELECT id FROM health_runs WHERE lower(instance_key) = ?)', host, host);
    run('health_runs', 'DELETE FROM health_runs WHERE lower(instance_key) = ?', host);
    for (const t of ['health_finding_state', 'health_table_scan_state', 'health_module_state', 'health_itsm_parameters']) {
      run(t, `DELETE FROM ${t} WHERE lower(instance_key) = ?`, host);
    }

    /* Chat history and what it indexed. */
    run('embeddings', `DELETE FROM embeddings WHERE chunk IN (SELECT id FROM chunks WHERE ${URL_MATCH} OR session ${inSessions})`, ...urls);
    run('chunks', `DELETE FROM chunks WHERE ${URL_MATCH} OR session ${inSessions}`, ...urls);
    for (const t of ['messages', 'digests', 'capture_state', 'sysid_provenance']) {
      run(t, `DELETE FROM ${t} WHERE session ${inSessions}`);
    }
    run('impersonation_mode', `DELETE FROM impersonation_mode WHERE ${URL_MATCH} OR session ${inSessions}`, ...urls);

    /* The audit trail of what was done to this instance. */
    run('tool_events', `DELETE FROM tool_events WHERE ${URL_MATCH}`, ...urls);
    run('mutation_ledger', `DELETE FROM mutation_ledger WHERE ${URL_MATCH}`, ...urls);
    run('impersonation_audit', `DELETE FROM impersonation_audit WHERE ${URL_MATCH}`, ...urls);
    // The task tables have named writers (memory/tasks.js); the purge goes through one.
    Object.assign(deleted, deleteTasksForInstance(urls));
    run('build_events', `DELETE FROM build_events WHERE run IN (SELECT id FROM build_runs WHERE ${URL_MATCH})`, ...urls);
    run('build_runs', `DELETE FROM build_runs WHERE ${URL_MATCH}`, ...urls);
    run('capture_sets', `DELETE FROM capture_sets WHERE ${URL_MATCH}`, ...urls);

    /* What the agent learned about this instance. */
    run('facts', `DELETE FROM facts WHERE ${URL_MATCH}`, ...urls);
    run('snada_observations', `DELETE FROM snada_observations WHERE ${URL_MATCH}`, ...urls);
    run('meeting_plans', `DELETE FROM meeting_plans WHERE ${URL_MATCH}`, ...urls);

    run('sessions', `DELETE FROM sessions WHERE ${URL_MATCH} OR id ${inSessions}`, ...urls);
    db.exec('DROP TABLE IF EXISTS temp.purge_sessions');
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    log.error('binding', `purge of ${host} failed and was rolled back — nothing was deleted: ${err.message}`, err);
    return { ok: false, instance: host, reason: err.message, deleted: {} };
  }

  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  log.info('binding', `purged ${total} row(s) filed under ${host}${url ? ` (${url})` : ''}`);
  return { ok: true, instance: host, total, deleted };
}
