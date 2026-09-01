import path from 'node:path';
import fsp from 'node:fs/promises';
import { table } from './client.js';
import { getSettings } from '../config/store.js';
import { assertTiersAgree, assertAppBinding, readAppIdentity, deployQueueDepth } from './fluent.js';
import { listSources, columnsInSchema } from './dba-source.js';
import { log } from '../logging.js';

/**
 * What the header says, and why it is computed rather than displayed.
 *
 * The topbar already showed the bound host. Two facts a user needs beside it
 * were missing, and both are the kind that go quietly wrong:
 *
 *   - WHICH SCOPE is active. Every artifact this product authors is prefixed
 *     with it, and it decides which update set a change can move into. It is
 *     read live from the workspace identity and resolved against the instance,
 *     never hardcoded — the whole dev442675 incident was a value that was true
 *     on one instance and quietly wrong on the next.
 *   - WHETHER SOURCE AND INSTANCE AGREE. SDK-managed schema is authored as
 *     Fluent source, and the instance is that source's output. A column on the
 *     instance that no source declares is removed by the next install; a column
 *     in source that never shipped is a change the user thinks they made. Both
 *     have bitten this project. Neither is visible anywhere until now.
 *
 * ── THE HONESTY RULE ─────────────────────────────────────────────────────────
 *
 * `unknown` is a first-class answer. If the instance cannot be read, this
 * reports `unknown` and says why — it does NOT report `in-sync`, because
 * "nothing disagreed" and "nothing was compared" are opposite facts that look
 * identical unless something states which it is. That is the same rule
 * describeInstanceState() exists for on the client, and the same one
 * listIndexes refuses a false zero for.
 */

/** Fields the platform adds to every table; not part of what a source declares. */
const SYSTEM_COLUMNS = new Set([
  'sys_id', 'sys_created_by', 'sys_created_on', 'sys_updated_by', 'sys_updated_on',
  'sys_mod_count', 'sys_tags', 'sys_domain', 'sys_domain_path', 'sys_class_name',
  'sys_package', 'sys_scope', 'sys_update_name', 'sys_policy', 'sys_replace_on_upgrade',
  'sys_name', 'sys_customer_update',
]);

/** `name:` for a table a source DEFINES; `augments:` attaches to someone else's. */
function tableNameIn(text) {
  const defines = /\bname:\s*["']([a-z0-9_]+)["']/i.exec(text);
  if (defines) return { name: defines[1], kind: 'defines' };
  const augments = /\baugments:\s*["']([a-z0-9_]+)["']/i.exec(text);
  if (augments) return { name: augments[1], kind: 'augments' };
  return null;
}

/**
 * Compare what the managed sources declare against what the instance holds.
 *
 * Pure enough to test: `read` is injected, so the verdict logic can be asserted
 * without an instance. Only columns the source DECLARES are compared — a table
 * legitimately carries platform columns this application never authored, and
 * flagging those would make the indicator cry wolf until it was ignored.
 */
export async function compareSourcesToInstance(sources, read) {
  const tables = [];
  for (const { file, text } of sources) {
    const found = tableNameIn(text);
    if (!found) continue;
    const declared = columnsInSchema(text).filter((c) => !SYSTEM_COLUMNS.has(c));
    // eslint-disable-next-line no-await-in-loop
    const live = await read(found.name).catch((err) => ({ __error: err.message }));

    if (live && live.__error) {
      tables.push({
        table: found.name, kind: found.kind, file: path.basename(file),
        state: 'unknown', reason: live.__error, declared: declared.length,
      });
      continue;
    }
    const onInstance = new Set((live || []).map((r) => r.element));
    const missing = declared.filter((c) => !onInstance.has(c));

    tables.push({
      table: found.name,
      kind: found.kind,
      file: path.basename(file),
      state: missing.length ? 'out-of-sync' : 'in-sync',
      declared: declared.length,
      ...(missing.length ? { missingOnInstance: missing } : {}),
    });
  }
  return tables;
}

/**
 * Roll per-table verdicts into one. Order matters and is deliberate:
 * a single unknown does not get to hide a known divergence, and a divergence
 * is never softened into "mostly fine".
 */
export function rollUpSync(tables) {
  if (!tables.length) return { state: 'in-sync', detail: 'No SDK-managed sources to compare.' };
  const bad = tables.filter((t) => t.state === 'out-of-sync');
  if (bad.length) {
    return {
      state: 'out-of-sync',
      detail: `${bad.length} managed table(s) declare columns the instance does not have: `
        + bad.map((t) => `${t.table} (${(t.missingOnInstance || []).join(', ')})`).join('; ')
        + '. The next install would ship them.',
    };
  }
  const unknown = tables.filter((t) => t.state === 'unknown');
  if (unknown.length) {
    return {
      state: 'unknown',
      detail: `${unknown.length} managed table(s) could not be read back: `
        + unknown.map((t) => `${t.table} (${t.reason})`).join('; ')
        + '. Nothing was compared, so this is NOT a clean bill of health.',
    };
  }
  return { state: 'in-sync', detail: `${tables.length} managed table(s) match the instance.` };
}

const TTL_MS = 15_000;
let cache = { at: 0, key: null, value: null };

/**
 * The whole header readout, in one call.
 *
 * Cached briefly because the header polls it and the comparison costs one read
 * per managed table. The cache key includes the bound host and scope, so
 * switching either in the UI re-derives immediately instead of serving the
 * previous instance's answer — the binding is a single source of truth and a
 * stale badge would quietly contradict it.
 */
export async function bindingStatus({ refresh = false } = {}) {
  const { connection } = getSettings();
  const url = connection?.instanceUrl || null;
  const host = url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
  const connected = Boolean(url && connection?.username);

  // Read live, never assumed — and it is the cache key, so a scope switch in
  // the UI cannot be served a previous scope's verdict.
  let identity = null;
  try { identity = await readAppIdentity(); } catch { identity = null; }
  const scopeName = identity?.scope ?? null;

  const key = `${host}::${scopeName}`;
  if (!refresh && cache.key === key && Date.now() - cache.at < TTL_MS) return cache.value;

  const deploying = deployQueueDepth() > 0;

  if (!connected) {
    const value = {
      instance: { host, url, connected: false },
      scope: { scope: scopeName, name: null, sys_id: null },
      binding: { ok: false, reason: 'No ServiceNow instance is bound.' },
      sync: { state: 'unknown', detail: 'Nothing can be compared until an instance is bound.' },
      deploying,
      status: { state: 'unbound', label: 'no instance' },
      checkedAt: new Date().toISOString(),
    };
    cache = { at: Date.now(), key, value };
    return value;
  }

  // Both guards, run for real. This is the same pair an install must pass, so
  // the pill means the same thing the deploy path means by it.
  const [tiers, app] = await Promise.all([
    assertTiersAgree({ probe: false }).then(
      (r) => ({ ok: true, host: r?.host ?? host }),
      (err) => ({ ok: false, reason: err.message, status: err.status ?? null }),
    ),
    assertAppBinding().then(
      (r) => ({ ok: true, scope: r?.scope ?? scopeName, sys_id: r?.sys_id ?? null, name: r?.name ?? null }),
      (err) => ({ ok: false, reason: err.message, status: err.status ?? null }),
    ),
  ]);

  let scopeRow = null;
  if (scopeName) {
    scopeRow = (await table.query('sys_scope', {
      query: `scope=${scopeName}`, fields: 'sys_id,scope,name', limit: 1, display: 'false',
    }).catch(() => []))[0] ?? null;
  }

  let sync = { state: 'unknown', detail: 'The comparison did not run.' };
  let tables = [];
  try {
    const files = await listSources();
    const sources = await Promise.all(files.map(async (file) => ({ file, text: await fsp.readFile(file, 'utf8') })));
    tables = await compareSourcesToInstance(sources, async (name) => table.query('sys_dictionary', {
      query: `name=${name}^elementISNOTEMPTY`, fields: 'element', limit: 500, display: 'false',
    }));
    sync = rollUpSync(tables);
  } catch (err) {
    log.warn('binding', `source/instance comparison failed: ${err.message}`);
    sync = { state: 'unknown', detail: `The comparison could not run: ${err.message}` };
  }

  const bindingOk = tiers.ok && app.ok;
  const value = {
    instance: { host, url, connected: true },
    scope: {
      scope: scopeName,
      name: scopeRow?.name ?? app.name ?? null,
      sys_id: scopeRow?.sys_id ?? app.sys_id ?? null,
    },
    binding: {
      ok: bindingOk,
      tiers,
      app,
      ...(bindingOk ? {} : { reason: [tiers.reason, app.reason].filter(Boolean).join(' | ') }),
    },
    sync: { ...sync, tables },
    deploying,
    status: headerStatus({ connected: true, bindingOk, sync, deploying }),
    checkedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), key, value };
  return value;
}

/**
 * The single word the pill shows — decided here, in one place, so the colour
 * and the tooltip cannot disagree about what is true.
 *
 * `deploying` outranks everything: mid-install, source and instance are
 * legitimately in flux and reporting "out of sync" would be alarming and wrong.
 */
export function headerStatus({ connected, bindingOk, sync, deploying }) {
  if (!connected) return { state: 'unbound', label: 'no instance', tone: 'idle' };
  if (deploying) return { state: 'deploying', label: 'deploying', tone: 'busy' };
  if (!bindingOk) return { state: 'binding-failed', label: 'binding failed', tone: 'bad' };
  if (sync.state === 'out-of-sync') return { state: 'out-of-sync', label: 'out of sync', tone: 'warn' };
  if (sync.state === 'unknown') return { state: 'unknown', label: 'sync unknown', tone: 'warn' };
  return { state: 'ok', label: 'in sync', tone: 'ok' };
}

/** The header polls; a save should not have to wait for the TTL. */
export function invalidateBindingStatus() { cache = { at: 0, key: null, value: null }; }
