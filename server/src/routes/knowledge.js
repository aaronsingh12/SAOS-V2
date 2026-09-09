import express from 'express';
import { searchKnowledge, knowledgeStats, getDocument, deleteDocument, upsertDocument, reindexVersionRanks } from '../knowledge/store.js';
import { ingestCorpus, corpusDir } from '../knowledge/ingest.js';
import { listObservations, observationStats } from '../knowledge/observations.js';
import { REQUIRED_METADATA, DOCUMENT_TYPES } from '../knowledge/schema.js';
import { AUTHORITY_ORDER, SOURCE_LABEL } from '../knowledge/precedence.js';
import { sourcePolicy } from '../knowledge/sources.js';

/**
 * Operator-facing endpoints for the knowledge layer.
 *
 * READ AND CURATE ONLY. Nothing here touches ServiceNow: the whole router
 * writes to the local corpus and reads from it. That is not an oversight to be
 * filled in later — the knowledge layer is deliberately unable to reach the
 * instance, the approval gate, the write guard or the elevation gate, and this
 * router is one of the places that has to stay true.
 *
 * Ingestion is exposed because it is an operator action with a result worth
 * reading — how many documents were refused, and exactly which field each one
 * was missing. Running it blind from a shell and hoping is how a corpus ends up
 * three quarters indexed with nobody aware of it.
 */
export const knowledgeRouter = express.Router();

const fail = (res, err) => res.status(500).json({ error: err.message });

/** What is indexed, and what the layer expects of a document. */
knowledgeRouter.get('/status', (_req, res) => {
  try {
    res.json({
      ...knowledgeStats(),
      corpusDir: corpusDir(),
      requiredMetadata: REQUIRED_METADATA,
      documentTypes: DOCUMENT_TYPES,
      // What a document must be published under to be admitted at all.
      sourcePolicy: sourcePolicy(),
      precedence: AUTHORITY_ORDER.map((s, i) => ({ rank: i + 1, source: s, label: SOURCE_LABEL[s] })),
      observations: observationStats(),
    });
  } catch (err) { fail(res, err); }
});

knowledgeRouter.get('/search', async (req, res) => {
  try {
    const { q, topic, product, document_type: documentType, version, limit } = req.query;
    if (!q) return res.status(400).json({ error: 'q is required' });
    const result = await searchKnowledge(String(q), {
      limit: Math.min(Number(limit) || 8, 25),
      filters: { topic, product, document_type: documentType, version },
    });
    res.json(result);
  } catch (err) { fail(res, err); }
});

knowledgeRouter.get('/document/:id', (req, res) => {
  try {
    const doc = getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'No such document' });
    res.json(doc);
  } catch (err) { fail(res, err); }
});

/**
 * Ingest one document directly, for a caller that already has it in hand.
 *
 * Validation is the same as the corpus path's — the metadata contract does not
 * get easier because the document arrived over HTTP. A rejection comes back as
 * a 400 naming every missing field, rather than as a partially-stored document.
 */
knowledgeRouter.post('/document', (req, res) => {
  try {
    const result = upsertDocument(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) { fail(res, err); }
});

knowledgeRouter.delete('/document/:id', (req, res) => {
  try {
    res.json({ deleted: deleteDocument(req.params.id) });
  } catch (err) { fail(res, err); }
});

/**
 * Re-read the corpus directory. Slow when it embeds; reports what it refused.
 *
 * `dryRun: true` validates the whole corpus and writes nothing — the way to
 * check a controlled set of documents BEFORE it lands rather than after.
 */
knowledgeRouter.post('/ingest', async (req, res) => {
  try {
    const { dir, embed, dryRun } = req.body || {};
    res.json(await ingestCorpus({
      dir: dir || null,
      embed: embed !== false,
      dryRun: dryRun === true,
    }));
  } catch (err) { fail(res, err); }
});

/**
 * Re-rank after the operator edits settings.rag.releaseOrder.
 *
 * Exposed separately because forgetting it is the failure it prevents: a new
 * release order that only applies to documents ingested afterwards ranks half
 * the corpus, silently.
 */
knowledgeRouter.post('/reindex-versions', (_req, res) => {
  try {
    res.json(reindexVersionRanks());
  } catch (err) { fail(res, err); }
});

/** K5 — what SNADA has verified for itself. Read-only over HTTP on purpose. */
knowledgeRouter.get('/observations', (req, res) => {
  try {
    const { subject, category, limit } = req.query;
    res.json({
      observations: listObservations({ subject, category, limit: Math.min(Number(limit) || 50, 200) }),
      stats: observationStats(),
    });
  } catch (err) { fail(res, err); }
});
