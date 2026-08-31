import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getSettings } from '../config/store.js';
import { runServerScript } from './execution-harness.js';
import { metaQuery, cached, cacheClear } from './dba-metadata.js';
import { log } from '../logging.js';

/**
 * DBA cross-cutting service — Connection / Scope / Security context (runbook §3.0).
 *
 * Every DBA tool receives this. Its only job is to decide WHAT NHA IS ALLOWED
 * TO PROMISE about reversibility on the instance that is actually connected,
 * because the rollback matrix (§1.5) is conditional on facts that differ per
 * instance and that this project's house rule says must be measured, never
 * assumed.
 *
 * ── THE FOUR MEASUREMENTS, dev428633, 2026-08-31 ─────────────────────────────
 *
 * 1. DB ENGINE = mysql. And the way that is obtained matters, because the
 *    obvious route does not work:
 *
 *      gs.getProperty('glide.db.rdbms')  -> "mysql"     (server-side script)
 *      sys_properties name=glide.db.rdbms -> NO ROW      (Table API)
 *
 *    The property answers `gs.getProperty` but has no `sys_properties` record,
 *    so a REST search for it finds only the unrelated `auxdb.db.rdbms`. Reading
 *    the auxiliary DB's engine and reporting it as the instance's would be
 *    right by luck here and wrong on any instance where they differ. Engine
 *    detection therefore costs one server-side script execution (~2s) and is
 *    cached hard.
 *
 *    Why the engine is load-bearing: §1.5 makes recovery capability a function
 *    of it — MySQL/MariaDB = rollback + delete recovery, Oracle = rollback
 *    only, SQL Server = neither. If the engine cannot be determined this
 *    service returns `null` and every promise downgrades to "unknown", which is
 *    the honest answer. It NEVER defaults to mysql.
 *
 * 2. RECOVERY PLUGINS — and this instance is the interesting case:
 *
 *      com.glide.delete_recovery              Delete Recovery          ACTIVE
 *      com.glide.delete_recovery.partial_undelete                      ACTIVE
 *      com.snc.undelete                       Restore Deleted Records  INACTIVE
 *
 *    §1.5 says record-delete recovery needs BOTH. So the honest verdict here is
 *    neither "recoverable" nor "not recoverable": deletes ARE being captured
 *    (sys_delete_recovery holds rows in state `finished` / "Ready for
 *    Recovery", created as recently as 2026-08-30), but the plugin that
 *    provides the restore path is not installed. Reporting a flat 7-day
 *    recovery window on this instance would be exactly the confidently-wrong
 *    claim the house rules exist to prevent, so the verdict is three-state.
 *
 * 3. ROLLBACK RETENTION IS PER-CATEGORY, not the single 10 days §1.5 implies.
 *    Read live off sys_properties:
 *      glide.rollback.expiration_days_scripts_bg    10   background scripts
 *      glide.rollback.expiration_days_app_install   15
 *      glide.rollback.expiration_days_plugin        15
 *      glide.rollback.expiration_days_redact         3
 *      glide.rollback.expiration_days_inst_preview   1
 *    There is NO delete-recovery retention property on this instance, so the
 *    7-day figure stays labelled as documentation, not measurement.
 *
 * 4. `security_admin` DOES NOT EXIST as a sys_user_role row here — a query for
 *    name=security_admin returns zero rows, while `admin` is held directly.
 *    Elevation is therefore not a role grant to check for; this repo already
 *    established (docs/role-elevation-gate*.md) that the write capability is
 *    reached another way. This service reports what it measured and refuses to
 *    infer an elevation capability from a role that is not there.
 */

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** §1.5, keyed by what `glide.db.rdbms` actually returns. */
const ENGINE_RECOVERY = {
  mysql: { rollbackContexts: true, deleteRecovery: true, label: 'MySQL/MariaDB' },
  mariadb: { rollbackContexts: true, deleteRecovery: true, label: 'MySQL/MariaDB' },
  oracle: { rollbackContexts: true, deleteRecovery: false, label: 'Oracle' },
  sqlserver: { rollbackContexts: false, deleteRecovery: false, label: 'SQL Server' },
  mssql: { rollbackContexts: false, deleteRecovery: false, label: 'SQL Server' },
};

const PLUGIN_DELETE_RECOVERY = 'com.glide.delete_recovery';
const PLUGIN_UNDELETE = 'com.snc.undelete';

/** Engine detection is a scheduled-job round trip, so it is cached for the process lifetime by default. */
const ENGINE_TTL_MS = 60 * 60_000;
const CONTEXT_TTL_MS = 5 * 60_000;

/**
 * The engine, from the one source that actually answers.
 *
 * Returns `{ value, source }` or `{ value: null, source, error }` — never a
 * guess. The caller decides what to do with an unknown; this does not decide
 * for it by substituting a default.
 */
export async function detectDbEngine({ refresh = false } = {}) {
  return cached('dba:engine', async () => {
    const body = [
      "report.rdbms = String(gs.getProperty('glide.db.rdbms', ''));",
      "report.dbName = String(gs.getProperty('glide.db.name', ''));",
    ].join('\n');
    try {
      const run = await runServerScript({ body, label: 'dba db-engine detection', timeoutMs: 60_000 });
      const raw = String(run?.report?.rdbms || '').trim().toLowerCase();
      if (!run?.report?.ok || !raw) {
        return {
          value: null,
          source: "gs.getProperty('glide.db.rdbms') via the execution harness",
          error: run?.timedOut
            ? 'the detection job did not report back before the timeout'
            : (run?.report?.error || 'the property came back empty'),
        };
      }
      return {
        value: raw,
        dbName: String(run.report.dbName || '') || null,
        source: "gs.getProperty('glide.db.rdbms') via the execution harness",
      };
    } catch (err) {
      // Loud, and specifically NOT a fallback to a default engine.
      log.warn('dba', `DB engine detection failed: ${err.message}`);
      return { value: null, source: "gs.getProperty('glide.db.rdbms') via the execution harness", error: err.message };
    }
  }, { ttlMs: ENGINE_TTL_MS, refresh });
}

/** Recovery-related plugin state, via v_plugin because sys_plugins is 403 over REST. */
export async function detectRecoveryPlugins() {
  const rows = await metaQuery('v_plugin', {
    query: `id=${PLUGIN_DELETE_RECOVERY}^ORid=${PLUGIN_UNDELETE}^ORidSTARTSWITH${PLUGIN_DELETE_RECOVERY}.`,
    fields: 'id,name,active,version',
    max: 50,
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const isActive = (id) => byId.get(id)?.active === 'active';
  return {
    deleteRecovery: { id: PLUGIN_DELETE_RECOVERY, active: isActive(PLUGIN_DELETE_RECOVERY), name: byId.get(PLUGIN_DELETE_RECOVERY)?.name ?? null },
    restoreDeletedRecords: { id: PLUGIN_UNDELETE, active: isActive(PLUGIN_UNDELETE), name: byId.get(PLUGIN_UNDELETE)?.name ?? null },
    all: rows.map((r) => ({ id: r.id, name: r.name, active: r.active === 'active' })),
  };
}

/** Rollback retention, per category, read live — §1.5's flat "10 days" is only one of these. */
export async function detectRollbackRetention() {
  const rows = await metaQuery('sys_properties', {
    query: 'nameSTARTSWITHglide.rollback.expiration_days',
    fields: 'name,value',
    max: 50,
  });
  const days = {};
  for (const r of rows) {
    const category = r.name.replace('glide.rollback.expiration_days_', '');
    const n = Number(r.value);
    days[category] = Number.isFinite(n) ? n : null;
  }
  return days;
}

/** Who NHA is on this instance, and what it actually holds. */
export async function detectIdentity() {
  const username = getSettings().connection.username || '';
  const users = await metaQuery('sys_user', {
    query: `user_name=${username}`, fields: 'sys_id,user_name,name,active', max: 1,
  });
  const user = users[0] || null;
  if (!user) {
    return { username, user: null, roles: [], hasAdmin: false, securityAdmin: { roleExists: false, held: false } };
  }
  const roleRows = await metaQuery('sys_user_has_role', {
    query: `user=${user.sys_id}`, fields: 'role.name,inherited', max: 1000,
  });
  // A blank role name appears among the inherited rows on this instance; it is
  // dropped rather than reported as a role called "".
  const roles = roleRows
    .map((r) => ({ name: r['role.name'], inherited: r.inherited === 'true' }))
    .filter((r) => r.name);
  const direct = roles.filter((r) => !r.inherited).map((r) => r.name);

  // security_admin: measured absent on this instance. Report the measurement,
  // do not infer availability from its absence in either direction.
  const secRows = await metaQuery('sys_user_role', { query: 'name=security_admin', fields: 'sys_id,name', max: 1 });

  return {
    username,
    user: { sys_id: user.sys_id, user_name: user.user_name, name: user.name, active: user.active === 'true' },
    roleCount: roles.length,
    directRoles: direct,
    hasAdmin: roles.some((r) => r.name === 'admin'),
    securityAdmin: {
      roleExists: secRows.length > 0,
      held: roles.some((r) => r.name === 'security_admin'),
      note: secRows.length
        ? 'The security_admin role exists on this instance.'
        : 'MEASURED: no sys_user_role row named security_admin exists on this instance, so ACL authoring cannot '
          + 'be gated on holding it. See docs/role-elevation-gate*.md for the route this repo established instead.',
    },
  };
}

/**
 * The scope REST writes actually land in, which is NOT the app's scope.
 *
 * The application scope is a property of the Fluent workspace on disk, not of
 * settings.json — the same source fluent.js reads. Read live rather than
 * cached separately, so a re-scaffolded workspace is picked up.
 */
export async function detectScope() {
  let application = null;
  let error = null;
  try {
    const cfg = JSON.parse(await fsp.readFile(path.join(SERVER_ROOT, 'fluent-workspace', 'now.config.json'), 'utf8'));
    application = cfg.scope || null;
  } catch (err) {
    error = `now.config.json unreadable: ${err.message}`;
  }
  return {
    application,
    ...(error ? { error } : {}),
    restWriteTier: 'global',
    note: 'REST is a global-tier writer: sys_scope on an insert is accepted and silently demoted to global '
        + '(trap #69, docs/fluent-research.md §33 E4). Scoped artifacts are born through the SDK tier, so any '
        + 'DBA authoring that must land in a scope goes through the SDK, never through the Table API.',
  };
}

/**
 * The verdict that everything else quotes.
 *
 * Three-state on purpose. `partial` is the state this instance is actually in
 * and the one a two-state flag would have to round to something false.
 */
export function recoveryVerdict({ engine, plugins }) {
  const caps = engine?.value ? ENGINE_RECOVERY[engine.value] : null;

  if (!engine?.value) {
    return {
      state: 'unknown',
      recordDelete: 'unknown',
      headline: 'The database engine could not be determined, so NHA cannot say whether a deleted record is '
              + 'recoverable on this instance. Treat every delete as irreversible until it can.',
      reasons: [engine?.error || 'engine detection did not return a value'],
    };
  }
  if (!caps) {
    return {
      state: 'unknown',
      recordDelete: 'unknown',
      headline: `The database engine reports "${engine.value}", which is not one of the engines the rollback `
              + 'matrix covers. Treat every delete as irreversible until this is confirmed.',
      reasons: [`unrecognised engine "${engine.value}"`],
    };
  }

  const reasons = [`engine ${caps.label} — rollback contexts ${caps.rollbackContexts ? 'supported' : 'NOT supported'}, `
    + `delete recovery ${caps.deleteRecovery ? 'supported' : 'NOT supported'}`];

  if (!caps.deleteRecovery) {
    return {
      state: 'none',
      recordDelete: 'irreversible',
      rollbackContexts: caps.rollbackContexts,
      headline: `On ${caps.label} a deleted record cannot be recovered. Do not offer a recovery window.`,
      reasons,
    };
  }

  const dr = plugins?.deleteRecovery?.active;
  const undel = plugins?.restoreDeletedRecords?.active;
  reasons.push(`plugin ${PLUGIN_DELETE_RECOVERY} ${dr ? 'active' : 'INACTIVE'}`);
  reasons.push(`plugin ${PLUGIN_UNDELETE} ${undel ? 'active' : 'INACTIVE'}`);

  if (dr && undel) {
    return {
      state: 'full',
      recordDelete: 'recoverable',
      rollbackContexts: caps.rollbackContexts,
      windowDays: 7,
      windowSource: 'Australia documentation §1.5 — no retention property for delete recovery exists on this instance, so this figure is documented, not measured',
      headline: 'A record deleted through GlideRecord.delete() is recoverable here: both Delete Recovery and '
              + 'Restore Deleted Records are active.',
      reasons,
    };
  }
  if (dr && !undel) {
    return {
      state: 'partial',
      recordDelete: 'captured-but-not-restorable',
      rollbackContexts: caps.rollbackContexts,
      headline: 'Deletes ARE being captured on this instance (Delete Recovery is active and sys_delete_recovery '
              + 'holds rows ready for recovery), but "Restore Deleted Records" (com.snc.undelete) is INACTIVE, so '
              + 'the restore path is not installed. Do not promise a 7-day recovery window: say the delete is '
              + 'captured, and that restoring it requires activating that plugin first.',
      reasons,
    };
  }
  return {
    state: 'none',
    recordDelete: 'irreversible',
    rollbackContexts: caps.rollbackContexts,
    headline: 'Delete Recovery is not active on this instance, so a deleted record is not recoverable. '
            + 'Treat record deletes as irreversible.',
    reasons,
  };
}

/**
 * The whole context, assembled.
 *
 * `probeEngine: false` skips the scheduled-job round trip for callers that only
 * need identity/scope — the engine then reports `unknown`, and every promise
 * downgrades accordingly rather than being filled in from a previous run.
 */
export async function getDbaContext({ refresh = false, probeEngine = true } = {}) {
  return cached('dba:context', async () => {
    const settings = getSettings();
    const instanceUrl = settings.connection.instanceUrl || null;

    const [engine, plugins, retention, identity, scope] = await Promise.all([
      probeEngine
        ? detectDbEngine({ refresh })
        : Promise.resolve({ value: null, source: 'not probed', error: 'engine detection was skipped by the caller' }),
      detectRecoveryPlugins(),
      detectRollbackRetention(),
      detectIdentity(),
      detectScope(),
    ]);

    const recovery = recoveryVerdict({ engine, plugins });

    return {
      measuredAt: new Date().toISOString(),
      instance: { url: instanceUrl, host: instanceUrl ? new URL(instanceUrl).host : null },
      dbEngine: engine,
      plugins,
      rollbackRetentionDays: retention,
      recovery,
      identity,
      scope,
      policy: DESTRUCTIVE_POLICY,
    };
  }, { ttlMs: CONTEXT_TTL_MS, refresh });
}

/** Runbook §2.4, stated once so every tool quotes the same words. */
export const DESTRUCTIVE_POLICY = {
  reversibleDataDelete: {
    requires: ['preview', 'confirm'],
    statement: 'State the recovery window that the measured context supports — never the documented one when the '
             + 'instance does not support it.',
  },
  irreversibleDdl: {
    operations: ['drop_table', 'drop_column', 'truncate_table', 'rename_table', 'rename_column', 'change_column_type', 'decrease_column_width', 'reparent_column'],
    requires: ['impact-report acknowledged', 'pre-export/snapshot of the object and affected data', 'explicit typed confirmation phrase'],
    statement: 'These create no rollback context on any engine. NHA states plainly that they cannot be undone and '
             + 'hard-blocks them until all three confirmations are present.',
  },
};

export function resetDbaContextCache() {
  cacheClear('dba:');
}
