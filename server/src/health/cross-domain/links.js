import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/*
 * The Phase 5 result vocabulary (health/itsm/engines/result.js), mirrored by
 * value: health/itsm is reached only through the health facade (index.js), which
 * injects `undeterminedOf` — the one population reading — into evaluateLinks.
 */
const STATUS = Object.freeze({ EVALUATED: 'evaluated', UNAVAILABLE: 'unavailable' });
const UNDETERMINED = Object.freeze({ EMPTY_POPULATION: 'empty_population', INPUT_INCONCLUSIVE: 'input_inconclusive' });

/**
 * PHASE 6 — CROSS-DOMAIN LINKS.
 *
 * The rule catalogues already state links between domains ("ITSM-130 Joins
 * CMDB-058; prioritises relationship remediation by incident volume"). A link
 * here is one of those statements made executable, and nothing more:
 *
 *   DATA, NOT CODE   `links.json` declares the source and target rules, the
 *                    join entity and the effect, with the specification it
 *                    quotes. Nothing is inferred at runtime; no LLM decides.
 *   ONE SCAN         a link joins results produced by the SAME run. A module
 *                    reused from an earlier run is a different instance state,
 *                    so the link is UNAVAILABLE rather than mixed.
 *   REPORT ONLY      `effect: report` — the workbook gives a link no threshold,
 *                    so it never changes either rule's verdict, severity,
 *                    priority or any score (Phase 5 decisions 5 and 7). Its
 *                    verdict is always null.
 *   STATES KEPT      an input that did not evaluate makes the link UNAVAILABLE
 *                    with an `input` blocker naming the rule and its state; an
 *                    input that evaluated but established nothing makes it
 *                    evaluated-with-`undetermined` — never a quiet empty report.
 *   POPULATION       every evaluated link declares what it judged (the Phase 5
 *                    contract); nothing to judge is `empty_population`.
 *   CONFIDENCE       min(inputs) — DECISION 7, never an average.
 *   IDENTITY         sha256(link | id | entity | sorted joined entity ids).
 *   EVIDENCE         per joined entity: the source records that reference it
 *                    and the target finding's fingerprint — the stored findings
 *                    carry their own evidence rows.
 */

export const LINKS_VERSION = '1.0.0';
export const LINK_EFFECTS = Object.freeze(['report']);

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class LinkError extends Error {
  constructor(message) { super(message); this.name = 'LinkError'; }
}

/** How a link reads one side's result. Named in the registry; nothing else is accepted. */
const SOURCE_ADAPTERS = Object.freeze({
  /* A relationship-graph rule's per-CI judgements (engines/relationship-graph.js answers_by_ci). */
  graph_answers_by_ci: (res) => (Array.isArray(res?.answers_by_ci)
    ? res.answers_by_ci.map((a) => ({ entity: a.ci, records: a.records, record_ids: a.record_ids || [], offending: Boolean(a.offending), degree: a.degree ?? null }))
    : null),
});
const TARGET_ADAPTERS = Object.freeze({
  /* A rule's findings, by the entities they target: one per-record finding per entity, class patterns kept apart. */
  findings_by_target: (findings) => {
    const byEntity = new Map();
    const patterns = [];
    for (const f of findings) {
      if (f.pattern) { patterns.push(f); continue; }
      for (const id of f.target_ids || []) if (typeof id === 'string' && id) byEntity.set(id, f);
    }
    return { byEntity, patterns, estateWide: findings.filter((f) => !(f.target_ids || []).length).length };
  },
});

/** Validate a registry: every field a link needs, adapters that exist, a known effect, unique ids. */
export function validateLinks(registry) {
  if (!registry || !Array.isArray(registry.links)) throw new LinkError('the link registry has no links[]');
  const ids = new Set();
  for (const l of registry.links) {
    const where = l?.id ?? '(no id)';
    for (const k of ['id', 'title', 'effect', 'source', 'target', 'join', 'specification']) if (l?.[k] == null) throw new LinkError(`${where}: ${k} is required`);
    if (ids.has(l.id)) throw new LinkError(`${l.id}: duplicate link id`);
    ids.add(l.id);
    if (!LINK_EFFECTS.includes(l.effect)) throw new LinkError(`${l.id}: effect "${l.effect}" is not one of ${LINK_EFFECTS.join(', ')} — a verdict-bearing link needs a specified threshold`);
    for (const side of ['source', 'target']) for (const k of ['domain', 'module', 'rule', 'answers']) if (!l[side][k]) throw new LinkError(`${l.id}: ${side}.${k} is required`);
    if (!SOURCE_ADAPTERS[l.source.answers]) throw new LinkError(`${l.id}: source adapter "${l.source.answers}" does not exist`);
    if (!TARGET_ADAPTERS[l.target.answers]) throw new LinkError(`${l.id}: target adapter "${l.target.answers}" does not exist`);
    if (!l.join.entity) throw new LinkError(`${l.id}: join.entity is required`);
    if (!Array.isArray(l.specification) || !l.specification.length) throw new LinkError(`${l.id}: a link must quote the specification it executes`);
  }
  return registry;
}

let cached = null;
/** The registry on disk, validated once. */
export function loadLinks() {
  if (!cached) cached = Object.freeze(validateLinks(JSON.parse(fs.readFileSync(path.join(HERE, 'links.json'), 'utf8'))));
  return cached;
}

const fingerprintOf = (link, ids) => crypto.createHash('sha256').update(`link|${link.id}|${link.join.entity}|${[...ids].sort().join('|')}`).digest('hex');

const unavailable = (link, base, blocker) => ({ ...base, status: STATUS.UNAVAILABLE, verdict: null, blocker: { kind: 'input', ...blocker }, population: null, undetermined: null, confidence: null, fingerprint: null, summary: null, rows: [], rows_truncated: 0 });

/**
 * Evaluate every registered link over ONE scan's results.
 *
 * @param {object} p
 * @param {string[]} p.readModules   the modules this scan actually read
 * @param {Map} p.itsmResults        the ITSM runner's results (id → result), when ITSM was read
 * @param {object[]} p.findings      every finding this scan detected (all modules)
 * @param {object[]} p.skipped       every skipped check this scan recorded
 * @param {Function} p.undeterminedOf the Phase 5 population reading (injected by the facade)
 * @returns {{ version, links: object[] }}
 */
export function evaluateLinks({ registry = loadLinks(), readModules = [], itsmResults = null, findings = [], skipped = [], undeterminedOf } = {}) {
  if (typeof undeterminedOf !== 'function') throw new LinkError('evaluateLinks needs undeterminedOf (health/itsm/engines/result.js), injected by the health facade');
  const out = [];
  for (const link of registry.links) {
    const base = {
      id: link.id, title: link.title, relationship: link.relationship ?? null, effect: link.effect,
      join: { ...link.join },
      source: { domain: link.source.domain, rule: link.source.rule, status: null, verdict: null },
      target: { domain: link.target.domain, rule: link.target.rule, status: null, findings: 0 },
      specification: link.specification.map((s) => ({ ...s })),
    };

    /* ── the source side: its module read in THIS scan, its rule evaluated, its answers present ── */
    if (!readModules.includes(link.source.module)) {
      out.push(unavailable(link, { ...base, source: { ...base.source, status: 'not_read' } }, { rule: link.source.rule, state: 'not_read', reason: `${link.source.domain} was not read in this scan — a link joins the results of one scan only` }));
      continue;
    }
    const src = itsmResults?.get?.(link.source.rule) ?? null;
    if (!src) {
      out.push(unavailable(link, { ...base, source: { ...base.source, status: 'not_run' } }, { rule: link.source.rule, state: 'not_run', reason: `${link.source.rule} produced no result in this scan` }));
      continue;
    }
    base.source = { ...base.source, status: src.status, verdict: src.verdict ?? null };
    if (src.status !== STATUS.EVALUATED) {
      out.push(unavailable(link, base, { rule: link.source.rule, state: src.status, reason: `${link.source.rule} was ${src.status}${src.blocker?.reason ? `: ${src.blocker.reason}` : ''}` }));
      continue;
    }
    const answers = SOURCE_ADAPTERS[link.source.answers](src);
    if (!answers) {
      out.push(unavailable(link, base, { rule: link.source.rule, state: 'no_answers', reason: `${link.source.rule} evaluated but its result carries no per-entity answers to join on` }));
      continue;
    }

    /* ── the target side: its module read in THIS scan, its rule not skipped ── */
    if (!readModules.includes(link.target.module)) {
      out.push(unavailable(link, { ...base, target: { ...base.target, status: 'not_read' } }, { rule: link.target.rule, state: 'not_read', reason: `${link.target.domain} was not read in this scan — a link joins the results of one scan only` }));
      continue;
    }
    const targetSkips = skipped.filter((s) => s?.rule === link.target.rule);
    const targetFindings = findings.filter((f) => f?.rule_id === link.target.rule);
    if (targetSkips.length && !targetFindings.length) {
      out.push(unavailable(link, { ...base, target: { ...base.target, status: 'skipped' } }, { rule: link.target.rule, state: 'skipped', reason: `${link.target.rule} did not run: ${targetSkips.map((s) => s.reason).join('; ')}` }));
      continue;
    }
    const target = TARGET_ADAPTERS[link.target.answers](targetFindings);
    base.target = { ...base.target, status: 'evaluated', findings: targetFindings.length };

    /* ── the join ── */
    const offending = answers.filter((a) => a.offending && typeof a.entity === 'string' && a.entity);
    const joined = offending.filter((a) => target.byEntity.has(a.entity));
    const sourceOnly = offending.filter((a) => !target.byEntity.has(a.entity));
    const sourceEntities = new Set(answers.map((a) => a.entity));
    const targetOnly = [...target.byEntity.keys()].filter((id) => !sourceEntities.has(id)).length;
    const rows = joined
      .map((a) => {
        const f = target.byEntity.get(a.entity);
        return {
          entity: a.entity, records: a.records, record_ids: a.record_ids.slice(0, 10), degree: a.degree,
          target_finding: f.fingerprint ?? null, target_severity: f.severity ?? null, target_title: f.title ?? null,
        };
      })
      .sort((x, y) => y.records - x.records || x.entity.localeCompare(y.entity));
    const max = link.max_rows ?? 200;

    const row = {
      ...base,
      status: STATUS.EVALUATED,
      verdict: null,
      blocker: null,
      population: {
        total: offending.length,
        judged: offending.length,
        unit: link.source.unit || 'entities',
        basis: `${link.source.rule} judged ${answers.length} ${link.join.entity} referenced by its records; ${offending.length} offend, each checked against ${link.target.rule}`,
      },
      undetermined: null,
      confidence: null,
      fingerprint: joined.length ? fingerprintOf(link, joined.map((a) => a.entity)) : null,
      summary: {
        joined: joined.length,
        source_only: sourceOnly.length,
        target_only: targetOnly,
        records_on_joined: joined.reduce((n, a) => n + a.records, 0),
        target_patterns: target.patterns.length,
        target_estate_wide: target.estateWide,
      },
      rows: rows.slice(0, max),
      rows_truncated: Math.max(0, rows.length - max),
      source_only_sample: sourceOnly.slice(0, 10).map((a) => ({ entity: a.entity, records: a.records, degree: a.degree })),
    };

    /* Confidence: the weakest input (DECISION 7). A side with no finding contributes its own certainty of 1. */
    const conf = [...(src.findings || []), ...joined.map((a) => target.byEntity.get(a.entity))]
      .map((f) => (typeof f?.confidence === 'number' ? f.confidence : 1));
    row.confidence = conf.length ? Number(Math.min(...conf).toFixed(3)) : null;

    /* Nothing established: the source judged nothing, or there was nothing to join. */
    const srcUndetermined = undeterminedOf(src);
    if (srcUndetermined && !(src.findings || []).length) {
      row.undetermined = { kind: UNDETERMINED.INPUT_INCONCLUSIVE, reason: `${link.source.rule}: ${srcUndetermined.reason}` };
    } else if (!offending.length) {
      row.undetermined = { kind: UNDETERMINED.EMPTY_POPULATION, reason: `no ${link.join.entity} judged by ${link.source.rule} offends, so there is nothing to join` };
    }
    out.push(row);
  }
  return { version: LINKS_VERSION, links: out };
}
