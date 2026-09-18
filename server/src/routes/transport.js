import { Router } from 'express';
import { listCapturedSets, setContents, isCaptureOn, setCapture, classifyTable } from '../servicenow/transport.js';
import { exportUpdateSet } from '../servicenow/transport-export.js';
import { assertSessionUsableOnCurrentInstance } from '../memory/sessions.js';

export const transportRouter = Router();

/** GET /api/transport/capture/:session — is capture on for this session? */
transportRouter.get('/capture/:session', (req, res, next) => {
  try {
    assertSessionUsableOnCurrentInstance(req.params.session);
    res.json({ session: req.params.session, enabled: isCaptureOn(req.params.session) });
  }
  catch (err) { next(err); }
});

/** POST /api/transport/capture/:session { enabled } */
transportRouter.post('/capture/:session', (req, res, next) => {
  try {
    assertSessionUsableOnCurrentInstance(req.params.session);
    res.json(setCapture(req.params.session, req.body?.enabled !== false));
  }
  catch (err) { next(err); }
});

/**
 * GET /api/transport/classify/:table
 * Whether a write to this table is configuration or data. Read-only, and the
 * page uses it to explain why an incident never appears in a set.
 */
transportRouter.get('/classify/:table', async (req, res, next) => {
  try { res.json(await classifyTable(req.params.table)); } catch (err) { next(err); }
});

/** GET /api/transport/sets?session= */
transportRouter.get('/sets', async (req, res, next) => {
  try {
    if (req.query.session) assertSessionUsableOnCurrentInstance(req.query.session);
    res.json(await listCapturedSets({ sessionId: req.query.session || null }));
  }
  catch (err) { next(err); }
});

/**
 * GET /api/transport/sets/:sysId/export
 * The XML, as a download. Parity is verified BEFORE the file is offered, and a
 * failed check is a 422 with the differences rather than a file that looks fine
 * — an export nobody checked is exactly the artifact this repo keeps refusing
 * to ship.
 */
transportRouter.get('/sets/:sysId/export', async (req, res, next) => {
  try {
    const result = await exportUpdateSet(req.params.sysId);
    if (!result.parity.ok) {
      return res.status(422).json({
        message: 'The export did not match the update set it was built from, so it was not offered for download.',
        parity: result.parity,
      });
    }
    if (req.query.inspect === 'true') {
      return res.json({ filename: result.filename, bytes: result.xml.length, manifest: result.manifest, parity: result.parity });
    }
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-NHA-Parity', 'verified');
    res.send(result.xml);
  } catch (err) { next(err); }
});

/** GET /api/transport/sets/:sysId — what would travel. */
transportRouter.get('/sets/:sysId', async (req, res, next) => {
  try { res.json(await setContents(req.params.sysId)); } catch (err) { next(err); }
});
