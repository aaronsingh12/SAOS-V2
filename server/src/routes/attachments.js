import express from 'express';
import { getSettings } from '../config/store.js';
import { log } from '../logging.js';
import { ingestAttachment, LIMITS } from '../attachments/index.js';
import { deleteAttachment, getAttachment, listAttachments, publicView } from '../attachments/store.js';

/*
 * /api/attachments — files the user attaches to a chat.
 *
 * Upload is the raw file as the request body (the name travels in the query
 * string), which keeps the server free of a multipart parser. The response is
 * the extraction summary — never the text: the text reaches the model through
 * the chat route, budgeted, not through the browser.
 *
 * Reading only. Nothing here touches ServiceNow.
 */
export const attachmentsRouter = express.Router();

const raw = express.raw({ type: () => true, limit: LIMITS.MAX_BYTES + 1024 });

attachmentsRouter.post('/', raw, async (req, res, next) => {
  try {
    const session = String(req.query.sessionId || '');
    const name = String(req.query.name || 'file');
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = await ingestAttachment({
      session, instance: getSettings().connection?.instanceUrl || null,
      name, mime: req.get('content-type') || null, buffer,
    });
    log.info('attach', `${name} → ${r.kind}/${r.method} · ${r.chunks.length} part(s) · ~${r.tokens} tokens · ${r.cached ? 'cached' : `${r.ms}ms`}`);
    res.status(201).json(publicView(r));
  } catch (e) {
    if (e.type === 'entity.too.large') { e.status = 413; e.message = `The file is larger than ${LIMITS.MAX_BYTES / 1048576} MB.`; }
    next(e);
  }
});

attachmentsRouter.get('/', (req, res) => {
  res.json(listAttachments(String(req.query.sessionId || '')).map(publicView));
});

attachmentsRouter.get('/:id', (req, res, next) => {
  try {
    const r = getAttachment(String(req.query.sessionId || ''), req.params.id);
    if (!r) return next(Object.assign(new Error('No such attachment in this chat.'), { status: 404 }));
    res.json(publicView(r));
  } catch (e) { next(e); }
});

attachmentsRouter.delete('/:id', (req, res, next) => {
  try {
    res.json({ ok: deleteAttachment(String(req.query.sessionId || ''), req.params.id) });
  } catch (e) { next(e); }
});
