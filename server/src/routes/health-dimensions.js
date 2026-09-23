import { Router } from 'express';
import { log } from '../logging.js';
import { currentActor } from '../memory/audit.js';
import {
  listDimensions, getDimension, createDimension, updateDimension, deleteDimension,
  matchRules, validateRuleList, expandCounts, mappingIndex, dimensionsForRule,
  DimensionError, UNCLASSIFIED_ID, MAPPING_SOURCES, MATCHER_FIELDS,
  rankedCounts,
} from '../health/finding-dimensions.js';
import { suggestDimension, AssistError } from '../health/dimension-assist.js';
import { ruleCatalogue, publicRule, CATALOGUE_SOURCES } from '../health/rule-catalogue.js';
import { moduleRuleSeverityCounts } from '../health/store.js';
import { normaliseScope } from '../health/scopes.js';
/* For its side effect: the scan facade registers the ITSM rules into the rule
   catalogue (rule-catalogue.js). routes/health.js imports it too; importing it
   here keeps this router correct on its own. */
import '../health/index.js';

/**
 * /api/health/dimensions — the dimension taxonomy over health findings.
 *
 * Classification only. Nothing here reads or writes a finding row, a run, a
 * lifecycle state or a proposal: counts are one GROUP BY over the findings in
 * view, and every write touches health_dimensions / health_dimension_rules
 * alone. The fix, bulk-fix, mute/acknowledge/accept and scoring paths are the
 * existing ones in routes/health.js, untouched — a dimension only decides which
 * findings a list shows.
 *
 * The server is authoritative. A rule id, dimension id, mapping source or AI
 * suggestion from the client is validated against the server-side catalogue
 * and tables before anything is stored; built-in and system dimensions are
 * read-only through every route.
 */
export const healthDimensionsRouter = Router();

/** Dimension and assist errors carry their own status; anything else is a 500. */
function fail(res, next, err) {
  if (err instanceof DimensionError || err instanceof AssistError) {
    if (err.status >= 500) log.warn('health', `dimensions: ${err.message}`);
    return res.status(err.status).json({ message: err.message, detail: err.detail ?? null });
  }
  return next(err);
}

/* The same view the findings list shows: scope plus every filter except the
   two dimensions being counted (severity and dimension). */
const viewFilters = (src = {}) => ({
  scope: normaliseScope(src.scope),
  domain: src.domain || undefined,
  priority: src.priority || undefined,
  rule: src.rule || undefined,
  q: src.q || undefined,
});

/**
 * GET /api/health/dimensions — every dimension with its rule count and, over
 * the findings currently in view, its total, its per-severity counts, the rules
 * those findings come from (`rule_counts`) and the areas they sit in
 * (`domains`) — all regroupings of one GROUP BY, so each sums to `findings`.
 */
healthDimensionsRouter.get('/', (req, res, next) => {
  try {
    const index = mappingIndex();
    const { counts, total, severityTotals, observedUnmapped } = expandCounts(moduleRuleSeverityCounts(viewFilters(req.query)), { index });
    const dimensions = listDimensions().map((c) => ({
      ...c,
      findings: counts.get(c.id)?.total ?? 0,
      severity: counts.get(c.id)?.severity ?? {},
      rule_counts: rankedCounts(counts.get(c.id)?.rules, 'rule_id'),
      domains: rankedCounts(counts.get(c.id)?.domains, 'domain'),
    }));
    const sumOfDimensions = dimensions.reduce((s, c) => s + c.findings, 0);
    const unc = dimensions.find((c) => c.id === UNCLASSIFIED_ID);
    res.json({
      dimensions,
      findings_total: total,
      /* Distinct findings in view per severity — each finding counted once. */
      severity_totals: severityTotals,
      dimension_sum: sumOfDimensions,
      /* True whenever a finding is counted under more than one dimension — the
         page says so beside the totals rather than letting them look wrong. */
      multi_label: sumOfDimensions > total,
      unclassified: {
        catalogue_rules: unc?.rule_count ?? 0,
        findings: unc?.findings ?? 0,
        /* Rules that produced findings in view and are in no dimension —
           including any rule the catalogue does not know yet. */
        observed_rules: observedUnmapped,
      },
      mapping_sources: MAPPING_SOURCES,
    });
  } catch (err) { fail(res, next, err); }
});

/**
 * GET /api/health/dimensions/rules — the unified rule catalogue, each rule with
 * the dimensions it currently resolves to. Generic definitions only.
 */
healthDimensionsRouter.get('/rules', (req, res, next) => {
  try {
    const index = mappingIndex();
    res.json({
      sources: CATALOGUE_SOURCES,
      matcher_fields: MATCHER_FIELDS,
      rules: ruleCatalogue().map((r) => ({ ...publicRule(r), dimensions: dimensionsForRule(r.ruleId, index) })),
    });
  } catch (err) { fail(res, next, err); }
});

/** POST /api/health/dimensions/match — `{ matcher }` → the catalogue rules it selects. Saves nothing. */
healthDimensionsRouter.post('/match', (req, res, next) => {
  try {
    const rules = matchRules(req.body?.matcher ?? {});
    res.json({ count: rules.length, rules });
  } catch (err) { fail(res, next, err); }
});

/**
 * POST /api/health/dimensions/preview — `{ rules, scope?, domain?, … }`.
 *
 * What a dimension holding exactly these rules would show over the findings in
 * view, before anything is saved: per-rule and per-severity counts. Unknown
 * rule ids are refused, never counted as zero.
 */
healthDimensionsRouter.post('/preview', (req, res, next) => {
  try {
    const rules = validateRuleList(req.body?.rules).map((r) => r.ruleId);
    const rows = moduleRuleSeverityCounts({ ...viewFilters(req.body || {}), rules });
    const perRule = new Map(rules.map((id) => [id, 0]));
    const severity = {};
    let findings = 0;
    for (const r of rows) {
      perRule.set(r.rule_id, (perRule.get(r.rule_id) || 0) + r.n);
      severity[r.severity] = (severity[r.severity] || 0) + r.n;
      findings += r.n;
    }
    res.json({
      rule_count: rules.length,
      findings,
      severity,
      rules: rules.map((id) => ({ ruleId: id, findings: perRule.get(id) || 0 })),
    });
  } catch (err) { fail(res, next, err); }
});

/**
 * POST /api/health/dimensions/suggest — `{ name, description }`.
 *
 * AI assistance: a suggested name, description and rules, validated strictly
 * against the catalogue. SAVES NOTHING — the person reviews and saves through
 * POST / or PATCH /:id. A failure here never affects Health: dimensions can
 * always be built by hand.
 */
healthDimensionsRouter.post('/suggest', async (req, res, next) => {
  try {
    res.json(await suggestDimension({ name: req.body?.name, description: req.body?.description }));
  } catch (err) { fail(res, next, err); }
});

healthDimensionsRouter.get('/:id', (req, res, next) => {
  try {
    const dimension = getDimension(req.params.id);
    if (!dimension) return res.status(404).json({ message: `No such dimension "${req.params.id}".` });
    return res.json({ dimension });
  } catch (err) { return fail(res, next, err); }
});

/** POST /api/health/dimensions — create a CUSTOM dimension: `{ name, description, rules }`. */
healthDimensionsRouter.post('/', (req, res, next) => {
  try {
    const dimension = createDimension(req.body || {}, { actor: currentActor().actor });
    log.info('health', `dimension created: "${dimension.name}" (${dimension.rule_count} rules)`);
    res.status(201).json({ dimension });
  } catch (err) { fail(res, next, err); }
});

/** PATCH /api/health/dimensions/:id — edit a CUSTOM dimension's name, description or rules. */
healthDimensionsRouter.patch('/:id', (req, res, next) => {
  try {
    const dimension = updateDimension(req.params.id, req.body || {});
    log.info('health', `dimension updated: "${dimension.name}" (${dimension.rule_count} rules)`);
    res.json({ dimension });
  } catch (err) { fail(res, next, err); }
});

/**
 * DELETE /api/health/dimensions/:id — a CUSTOM dimension and its mappings only.
 * No finding, run, rule, lifecycle state or proposal is touched.
 */
healthDimensionsRouter.delete('/:id', (req, res, next) => {
  try {
    const out = deleteDimension(req.params.id);
    log.info('health', `dimension deleted: "${out.name}"`);
    res.json(out);
  } catch (err) { fail(res, next, err); }
});
