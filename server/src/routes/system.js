import { Router } from 'express';
import { getSettings, saveSettings, publicSettings, clearConnection } from '../config/store.js';
import { testConnection, resetAuthCache } from '../servicenow/client.js';
import { getSchema, referenceLookup, tableLookup, clearSchemaCaches, getTableHierarchy } from '../servicenow/schema.js';
import { capability, cachedCapability } from '../servicenow/fluent.js';
import { bindingStatus, invalidateBindingStatus } from '../servicenow/binding-status.js';

export const systemRouter = Router();

/**
 * The one source of truth for "is an instance bound" (D-3), which means every
 * page polls it — so it must be fast, and it is: it reads settings and the
 * CACHED capability probe, never the probe itself. Shelling out to `now-sdk`
 * here made this endpoint take 5.5s on a cold cache while eight pages waited
 * on it to decide whether to render. `/api/flows/live/capability` is still the
 * place to ask the SDK a real question.
 */
systemRouter.get('/health', (_req, res) => {
  const s = getSettings();
  const cap = cachedCapability();
  const liveAuthoring = cap
    ? {
      ok: cap.ok,
      cliVersion: cap.cli.version,
      authAlias: cap.auth.alias,
      authVerified: cap.auth.verified,
      scope: cap.workspace.scope,
      managedSources: cap.workspace.sources.length,
      lastInstall: cap.lastInstall,
      fixes: cap.fixes,
    }
    // Not "ok: false" — that would print fix commands for a probe that simply
    // has not run yet.
    : { pending: true };
  res.json({
    ok: true,
    connected: Boolean(s.connection.instanceUrl && s.connection.username),
    instanceUrl: s.connection.instanceUrl || null,
    llmProvider: s.llm.provider,
    liveAuthoring,
  });
});

/**
 * The header readout: bound instance, active scope, and a truthful status.
 *
 * Separate from /health on purpose. /health answers in ~2ms because every page
 * gates on it; this one reads the instance to compare sources against it, so it
 * is polled more slowly and cached briefly rather than being made part of the
 * hot path every route already waits on.
 */
systemRouter.get('/binding', async (req, res) => {
  try {
    res.json(await bindingStatus({ refresh: req.query.refresh === '1' }));
  } catch (err) {
    // Never 500 the header into blankness — an unreadable status is itself a
    // status, and saying so beats a pill that silently disappears.
    res.json({
      instance: { host: null, url: null, connected: false },
      scope: { scope: null, name: null, sys_id: null },
      binding: { ok: false, reason: err.message },
      sync: { state: 'unknown', detail: err.message, tables: [] },
      deploying: false,
      status: { state: 'unknown', label: 'status unavailable', tone: 'warn' },
      checkedAt: new Date().toISOString(),
    });
  }
});

systemRouter.get('/settings', (_req, res) => res.json(publicSettings()));

systemRouter.post('/settings', (req, res) => {
  const { connection, llm, agent } = req.body || {};
  // Don't wipe stored secrets when the client sends blanks for untouched fields.
  if (connection) {
    if (connection.password === '') delete connection.password;
    if (connection.clientSecret === '') delete connection.clientSecret;
  }
  if (llm && llm.apiKey === '') delete llm.apiKey;
  saveSettings({ connection, llm, agent });
  if (connection) { resetAuthCache(); clearSchemaCaches(); }
  // A new binding must not be described by the old one's cached verdict.
  invalidateBindingStatus();
  res.json(publicSettings());
});

/** Unbind the instance: clears the stored credentials and every cached derivative. */
systemRouter.post('/connection/disconnect', (_req, res) => {
  clearConnection();
  resetAuthCache();
  clearSchemaCaches();
  res.json({ ok: true, ...publicSettings() });
});

systemRouter.post('/connection/test', async (_req, res, next) => {
  try { res.json(await testConnection()); } catch (err) { next(err); }
});

systemRouter.get('/schema/:table', async (req, res, next) => {
  try { res.json(await getSchema(req.params.table)); } catch (err) { next(err); }
});

systemRouter.get('/hierarchy/:table', async (req, res, next) => {
  try { res.json({ hierarchy: await getTableHierarchy(req.params.table) }); } catch (err) { next(err); }
});

systemRouter.get('/reference/:table', async (req, res, next) => {
  try {
    res.json(await referenceLookup(req.params.table, req.query.q || '', Number(req.query.limit) || 15));
  } catch (err) { next(err); }
});

systemRouter.get('/tables', async (req, res, next) => {
  try { res.json(await tableLookup(req.query.q || '')); } catch (err) { next(err); }
});
