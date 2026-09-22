import { Router } from 'express';
import { listApplications, getApplication, scopeLabels, workspaceRegistry } from '../servicenow/applications.js';
import { refreshWorkspaces } from '../servicenow/workspaces.js';

export const applicationsRouter = Router();

/* Named routes first, so they are not read as an application id. */

/** GET /api/applications/workspaces — the SDK workspace registry, from disk. */
applicationsRouter.get('/workspaces', async (_req, res, next) => {
  try {
    refreshWorkspaces();
    res.json(await workspaceRegistry());
  } catch (err) { next(err); }
});

/**
 * POST /api/applications/scope-labels { ids: [...] }
 * A batch so an artifact list can badge 50 rows with one read instead of 50.
 * POST rather than GET because a list of sys_ids is a body, not a query string.
 */
applicationsRouter.post('/scope-labels', async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    res.json({ labels: await scopeLabels(ids) });
  } catch (err) { next(err); }
});

/** GET /api/applications?search=&kind=custom|store|scope&managed=true */
applicationsRouter.get('/', async (req, res, next) => {
  try {
    res.json(await listApplications({
      search: req.query.search || '',
      kind: req.query.kind || '',
      managedOnly: req.query.managed === 'true',
      // Unset = the whole instance (paged, capped at 10000); the result says whether it is complete.
      limit: Number(req.query.limit) || undefined,
    }));
  } catch (err) { next(err); }
});

/** GET /api/applications/:idOrScope */
applicationsRouter.get('/:idOrScope', async (req, res, next) => {
  try { res.json(await getApplication(req.params.idOrScope)); } catch (err) { next(err); }
});
