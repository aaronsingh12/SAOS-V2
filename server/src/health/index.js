import { TABLES, resolveTables, specHash } from './tables.js';
import { extractEstate, extractCmdbMeta, cmdbMetaSources, instanceClient, FAILED_READ_STATUSES } from './extract.js';
import { planScan, engineKeys, stampSources, stampingClient } from './incremental.js';
import { CONFIG_ONLY_RULES } from './cmdb-identification.js';
import { EstateRules, RULE_VERSION, AGENTS, isComplete, IMPLEMENTED_CATALOGUE_RULES } from './rules.js';
import { scoreCmdbQuality, CMDB_CATALOGUE } from './cmdb-quality.js';
import { cmdbInScope } from './cmdb-gate.js';
import { explainFindings } from './explain.js';
import { digest } from './digest.js';
import { summariseScopes, normaliseModules, moduleTables, MODULE_KEYS } from './scopes.js';
import { DQ_INACTIVE_INSTALL_STATUS, intentMisTags } from './cmdb-signals.js';
import { trackMisroutes } from './cmdb-csdm.js';
import { CONSUMPTION_TRACKS } from './cmdb-consumption.js';
import { SCALE_TRACKS } from './cmdb-scale.js';
import { DRIFT_TRACKS, cmdbScoreTrend } from './cmdb-drift.js';
import { createEvaluationContext } from './itsm/context.js';
import { runITSMRules } from './itsm/runner.js';
import { normalizeITSMRun, countingClient, itsmPerformance } from './itsm/integration.js';
import { ITSM_PARAMETERS } from './itsm/parameters.js';
import { ITSM_RULE_CONFIGS } from './itsm/rules/index.js';
import { hasITSMRule } from './itsm/catalogue.js';
import { adaptRule } from './itsm/adapter.js';
import { collectMeasures, historyForScan, historyFromRuns } from './itsm/measure-history.js';
import { undeterminedOf } from './itsm/engines/result.js';
import { registerItsmCatalogue } from './remediation.js';
import { evaluateLinks } from './cross-domain/links.js';

/* The remediation layer's ITSM catalogue guidance — registered here, the one facade over health/itsm. */
registerItsmCatalogue((ruleId) => (hasITSMRule(ruleId) ? adaptRule(ruleId) : null));

/**
 * Health Assist — the run.
 *
 * extract → deterministic rules → synthesis → manifest, with an optional
 * plain-language pass over the findings that is never allowed to become the
 * findings themselves.
 *
 * The manifest is the point of this module. A health check that returns a list
 * of problems and nothing else cannot be audited: you cannot tell a clean
 * estate from an extraction that read three rows, and you cannot tell a rule
 * that found nothing from a rule that never ran. So every run carries its
 * coverage, its skipped rules with reasons, its rule-pack version, its input
 * hash and its cutoff — and the score is withheld entirely unless the two
 * tables it is computed from were read completely.
 */

export const MANIFEST_VERSION = '5.0.0';

/*
 * How many findings a run STORES.
 *
 * This was 1,000, and the counts on the page were taken from what was stored.
 * Measured on techsnitchpvtltddemo2: 12,194 findings were detected, 1,000 were
 * stored, and the page said "1000 things found", "989 Moderate" and "0 Low" —
 * every one of those numbers was wrong. The cap is now a memory guard for
 * pathological instances rather than an everyday limit, and the counts come
 * from the full detected set whatever it is.
 */
export const MAX_FINDINGS = 25_000;
const DEFAULT_STALE_DAYS = 90;

export { digest };

/**
 * The CMDB quality score, or null.
 *
 * Percent of extracted CIs with no CMDB rule against them. It is withheld
 * unless BOTH cmdb_ci and cmdb_rel_ci came back complete, because a partial
 * relationship read inflates CMDB-UNRELATED and would push the score down for
 * a reason that is about our access, not their data. A number that is
 * sometimes about the estate and sometimes about the reader is worse than no
 * number, so the UI gets `null` and prints why.
 */
export function qualityScore(estate, coverage, findings) {
  const ciCount = (estate.cmdb_ci || []).length;
  /* Every CI ROW and every relationship ROW. A missing optional column such as
     `business_criticality` does not change which CIs exist, so it no longer
     withholds the score. */
  const ciComplete = isComplete(coverage, 'cmdb_ci');
  const relComplete = isComplete(coverage, 'cmdb_rel_ci', ['parent', 'child']);
  if (!ciCount || !ciComplete || !relComplete) return null;
  const affected = new Set();
  for (const f of findings) {
    if (f.domain === 'CMDB') for (const id of f.target_ids) affected.add(id);
  }
  return Number((100 * (1 - affected.size / ciCount)).toFixed(1));
}

/**
 * Group findings that share a rule.
 *
 * Explicitly NOT root-cause analysis. Findings sharing a rule share a PATTERN;
 * whether they share a cause is a question this system has no evidence for, and
 * the note travels with the cluster so a reader cannot mistake the one for the
 * other.
 */
export function clusterByRule(findings) {
  const groups = new Map();
  for (const f of findings) {
    if (!groups.has(f.rule_id)) groups.set(f.rule_id, []);
    groups.get(f.rule_id).push(f.fingerprint);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([rule, ids]) => ({
      rule_id: rule,
      finding_fingerprints: ids,
      title: `Shared rule pattern: ${rule}`,
      type: 'symptom_cluster',
      note: 'Correlation by deterministic rule; a common causal mechanism has not been proven.',
    }));
}

/**
 * Run a health check.
 *
 * `onProgress` receives coarse stages so the UI can stream them. It is optional
 * and awaited — a slow consumer slows the run rather than dropping frames,
 * which keeps the stream an accurate account of what happened.
 */
export async function runHealthCheck({
  tables,
  /* Which modules to check — CMDB, ITOM, ITSM, Platform. Nothing means all. */
  modules,
  /* Skip a module whose inputs have not changed since its last result. */
  reuse = true,
  /* Per module, what its current result was computed from (store.moduleBaselines). */
  baselines = {},
  /* Per table, the incremental settings (store.tableSettings). */
  tableSettings = {},
  /* The connected account — a different one may see different rows. */
  user = null,
  staleDays = DEFAULT_STALE_DAYS,
  explain = true,
  limit,
  onProgress = null,
  client,
  signal = null,
  now = new Date(),
  /* Fingerprints a person marked "accepted risk" — the approved-exception
     de-escalator. Passed in, because the rule pack never reads the database. */
  acceptedFingerprints = [],
  /* The same decisions with their rule ids, so each module's engine key sees only its own. */
  acceptedRules = [],
  /* Earlier runs' measures (duplicate-set membership) for the trend rules. */
  measureHistory = {},
  /*
   * The ITSM catalogue's inputs for this scan (ITSM Phase 5): `parameters` is the
   * registry — declarations plus this instance's overrides — and `runtime` the
   * per-run overrides (`{ 'ITSM-nnn': { key: value } }`), recorded on the run and
   * never part of the engine key. `configs` is injectable for the suite only.
   */
  itsm: itsmOptions = {},
} = {}) {
  /* `itsmOptions.measureHistory` — earlier scans' ITSM readings (itsm/measure-history.js historyFromRuns). */
  const startedAt = Date.now();
  const phases = {};
  const emit = async (stage, percent, detail = {}) => {
    await onProgress?.({ stage, percent, ...detail });
  };
  /* An explicit table list is the older API: every module, read in full. */
  const explicitTables = Array.isArray(tables) && tables.length > 0;
  const wanted = explicitTables ? [...MODULE_KEYS] : normaliseModules(modules);
  const keys = engineKeys({ staleDays, acceptedRules, itsmParameters: itsmOptions.parameters });
  const accepted = acceptedFingerprints.length ? acceptedFingerprints : acceptedRules.map((a) => a.fingerprint);
  const reader = client || instanceClient;

  /*
   * THE CHANGE CHECK. One stamp per input of every module that could keep its
   * result; the modules whose inputs moved are read, the rest are verified.
   */
  let plan = null;
  if (!explicitTables) {
    await emit('checking for changes', 2);
    plan = await planScan({ modules: wanted, client: reader, baselines, tableSettings, engineKeys: keys, user, reuse, now, signal });
    phases.change_check_ms = plan.probe_ms;
  }
  const readModules = plan ? plan.read : wanted;
  const verifiedModules = plan ? plan.reuse : [];

  if (!readModules.length) {
    /* Nothing changed anywhere that was asked about. No rows are read and no
       findings are produced: each module keeps the result it already has. */
    const manifest = {
      version: MANIFEST_VERSION,
      rule_pack_version: RULE_VERSION,
      kind: 'verification',
      modules: [],
      requested_modules: wanted,
      verified_modules: verifiedModules,
      plan,
      engine_keys: keys,
      connection_user: user,
      cutoff: null,
      coverage: {},
      skipped_checks: [],
      findings_detected: 0,
      findings_stored: 0,
      findings_truncated: false,
      metrics: { visible_cis: 0, visible_relationships: 0, fetched_rows: 0, cmdb_quality_score: null },
      phases: { ...phases, total_ms: Date.now() - startedAt },
      narrative: `No changes since the last result for ${verifiedModules.join(', ')} — those results stand, verified now.`,
    };
    await emit('done', 100);
    return { status: 'completed', findings: [], manifest };
  }

  /* Read what the modules declare, plus anything their rules read last time. */
  const priorInputs = readModules.flatMap((m) => baselines[m]?.dependencies || []).filter((t) => TABLES[t]);
  const requested = explicitTables
    ? resolveTables(tables)
    : resolveTables([...new Set([...moduleTables(readModules), ...priorInputs])]);

  await emit('extracting', 5);
  let t0 = Date.now();
  const { estate, coverage, cutoff, stamps } = await extractEstate(requested, {
    limit,
    client,
    signal,
    stamps: true,
    onProgress: async ({ table: t, index, total }) => {
      await emit('extracting', 5 + Math.round((index * 55) / Math.max(1, total)), { table: t });
    },
  });
  phases.extract_ms = Date.now() - t0;

  const fetchedRows = Object.values(estate).reduce((n, rows) => n + rows.length, 0);

  /* Checked between phases, not inside them. Analysis is pure and fast; the
     expensive, interruptible part is extraction, and that checks per table. */
  if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });

  /*
   * The trust gate's bounded meta reads — class hierarchy, filter counts, job
   * triggers, execution counts. Only when CMDB is being read; each read carries
   * its own status, so a failure skips the rules that needed it. Their sources
   * are stamped FIRST, for the same reason tables are.
   */
  const readsCmdb = readModules.includes('cmdb') && requested.includes('cmdb_ci');
  let meta = {};
  let metaStamps = null;
  if (readsCmdb) {
    await emit('reading governance', 64);
    t0 = Date.now();
    metaStamps = await stampSources(reader, cmdbMetaSources(estate), { now });
    meta = await extractCmdbMeta(estate, { client, signal });
    phases.meta_ms = Date.now() - t0;
  }

  /*
   * ITSM PHASE 5 — THE 139-RULE CATALOGUE, when ITSM is read. Every slot is run
   * through the Phase 4 runner as it stands: its capability pipeline, field gate,
   * parameters and composite ordering decide each rule's state, and nothing here
   * overrides them. Its results are normalised (health/itsm/integration.js) and
   * handed to analyze(); the eleven hard-coded ITSM rules keep running beside it
   * and keep producing the ITSM score.
   */
  let itsm = null;
  if (readModules.includes('itsm')) {
    await emit('checking ITSM rules', 66);
    t0 = Date.now();
    const parameters = itsmOptions.parameters ?? ITSM_PARAMETERS;
    const runtime = itsmOptions.runtime ?? {};
    const configs = itsmOptions.configs ?? ITSM_RULE_CONFIGS;
    const counting = countingClient(reader);
    const stamping = stampingClient(counting.client, { now });
    /* Trend rules compare only with earlier readings of THIS instance under the SAME comparability key. */
    const history = historyForScan(itsmOptions.measureHistory, { configs, parameters, runtime, now });
    const ctx = createEvaluationContext({ client: stamping.client, now, signal, parameters, runtimeParameters: runtime, measureHistory: history.measureHistory });
    const run = await runITSMRules(ctx, { configs });
    const readCoverage = await ctx.reads.coverage();
    const normalized = normalizeITSMRun(run, { configs, parameters, runtime, readCoverage });
    const performance = itsmPerformance({ run, rules: normalized.rules, calls: counting.calls, readCoverage, readRequirements: ctx.reads.size(), probeCache: ctx.probes.cacheSize(), cacheStats: ctx.cacheStats() });
    itsm = { run, ctx, normalized, parameters, runtime, stamps: await stamping.stamps(), performance, history, measures: collectMeasures(run, { configs, parameters, runtime, timezone: ctx.run.timezone }) };
    phases.itsm_ms = Date.now() - t0;
    if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
  }

  await emit('analysing', 70);
  t0 = Date.now();
  const rules = new EstateRules(estate, coverage, staleDays, now, { meta, acceptedFingerprints: accepted, history: measureHistory });
  const all = rules.analyze({ modules: readModules, external: itsm ? { itsm: itsm.normalized } : {} });
  /*
   * PHASE 6 — CROSS-DOMAIN LINKS, over THIS scan's results only (cross-domain/links.js).
   * Report-only: nothing here changes a finding, a verdict, a priority or a score.
   */
  const links = evaluateLinks({ readModules, itsmResults: itsm?.run.results ?? null, findings: all, skipped: rules.skipped, undeterminedOf });
  phases.analyse_ms = Date.now() - t0;
  /* Per rule pack, with the tables each read — see `stage` in rules.analyze. */
  phases.analyse_stages = rules.timings?.stages ?? [];
  /* `let`: CMDB-137 can add one finding after scoring, and the slice is retaken then. */
  let detected = all.length;
  let findings = all.slice(0, MAX_FINDINGS);

  let llm = { status: 'disabled', tokens_used: 0 };
  if (explain && findings.length) {
    await emit('explaining', 88);
    t0 = Date.now();
    llm = await explainFindings(findings);
    phases.explain_ms = Date.now() - t0;
  }

  /*
   * Every count and score below is taken from `all` — the full detected set —
   * never from the stored slice. A cap may drop rows from storage; it must not
   * change what the page says was found.
   */
  /*
   * CMDB QUALITY — the two-layer model (trust gate + record scores within
   * D1–D10). It replaces the pass rate as the CMDB number; `qualityScore` is
   * kept only so an older stored run is not reinterpreted. A scan that did not
   * check CMDB has no CMDB number at all, rather than one computed over the CIs
   * it happened to read for another module.
   */
  /*
   * THE DATA-QUALITY DIMENSIONS SCORE A NARROWER SET (decision 7 of 16 Sep 2026).
   *
   * Completeness, correctness, uniqueness, identification and reconciliation
   * judge records somebody is supposed to maintain, so retired, stolen and
   * absent CIs are out of their denominator as well as out of their findings.
   * The lifecycle dimension (D8) keeps every one of them — evaluating those
   * statuses is what it is for.
   */
  const scope = readsCmdb ? cmdbInScope(rules) : { ids: [], basis: '' };
  const inactive = new Set((estate.cmdb_ci || [])
    .filter((c) => DQ_INACTIVE_INSTALL_STATUS.includes(String(c.install_status ?? '').trim()))
    .map((c) => c.sys_id));
  const dqIds = [...scope.ids].filter((id) => !inactive.has(id));
  const dimensionScope = inactive.size
    ? { D1: dqIds, D2: dqIds, D3: dqIds, D4: dqIds, D5: dqIds }
    : {};
  t0 = Date.now();
  const cmdbQuality = readsCmdb
    ? scoreCmdbQuality({
      findings: all, kpis: rules.kpis, inScope: scope, implemented: IMPLEMENTED_CATALOGUE_RULES,
      measures: rules.measures, dimensionScope, skippedRules: rules.skipped, configRules: CONFIG_ONLY_RULES,
    })
    : null;
  /*
   * CMDB-137 needs the composite it trends, so it is evaluated only now. Its
   * finding joins the same list and is counted on the trend track; it never
   * feeds back into the score it describes.
   */
  phases.score_ms = Date.now() - t0;
  if (cmdbQuality) {
    const trend = cmdbScoreTrend(rules, cmdbQuality);
    if (trend) {
      cmdbQuality.tracks.trend = (cmdbQuality.tracks.trend || 0) + 1;
      detected = all.length;
      findings = all.slice(0, MAX_FINDINGS);
    }
  }
  const score = cmdbQuality ? cmdbQuality.composite.score : (readModules.includes('cmdb') ? qualityScore(estate, coverage, all) : null);
  const allScopes = summariseScopes(coverage, all, { cmdbQuality });
  /* Only the modules this scan checked carry a summary; the others keep theirs in their own runs. */
  const scopes = Object.fromEntries(Object.entries(allScopes).filter(([k]) => k === 'all' || readModules.includes(k)));

  /*
   * `partial` is the run-level honesty flag, and it is deliberately eager: any
   * table that is not complete-or-deliberately-absent, any skipped rule, any
   * truncation, or an explanation pass that could not run all make the whole
   * run partial. A run is only `completed` when there is nothing to caveat.
   */
  const partial = Object.values(coverage).some((c) => !['complete', 'not_requested'].includes(c.status))
    || rules.skipped.length > 0
    || detected > findings.length
    || llm.status === 'unavailable';

  /*
   * WHICH RESULTS ARE SAFE TO KEEP.
   *
   * A scan whose reads failed still produces findings — fewer of them, because
   * the rules that needed those reads skipped. Measured on dev424910: a second
   * full scan an hour after the first came back with 68 fewer findings and a
   * CMDB score eight points higher, because the instance had slowed to the point
   * of failing governance reads. Keeping that as a module's result for a day
   * would report an improvement nobody made, so a degraded result is recorded as
   * such and is never reused: the next scan reads it again.
   *
   * `unavailable` and `limited` are NOT degradation — a table absent on this
   * instance, or rows an ACL hides, are stable facts the findings already state.
   */
  const FAILED_READ = new Set(FAILED_READ_STATUSES);
  const degraded = {};
  for (const m of readModules) {
    const why = (rules.dependencies?.[m] || [])
      .filter((t) => FAILED_READ.has(coverage[t]?.status))
      .map((t) => `${t}: ${coverage[t].status}`);
    if (m === 'cmdb') {
      for (const [k, r] of Object.entries(meta.cmdb?.reads || {})) if (r.status !== 'ok') why.push(`governance read ${k}: ${r.status}`);
    }
    /* A catalogue read that FAILED (not one the instance cannot serve) is as
       transient as a failed table read, so that ITSM result is not reused. */
    if (m === 'itsm' && itsm) why.push(...itsm.normalized.degraded.map((d) => `catalogue ${d}`));
    if (why.length) degraded[m] = why;
  }

  const manifest = {
    version: MANIFEST_VERSION,
    rule_pack_version: RULE_VERSION,
    /* Whether a later run can trend against this one — see `scoringComparability`. */
    comparability: { ...rules.comparability, engine: keys.cmdb ?? null },
    kind: 'scan',
    /* What this run produced results for, and what it was asked about. */
    modules: readModules,
    requested_modules: wanted,
    verified_modules: verifiedModules,
    plan,
    /* Modules whose result was computed with reads that failed: shown, and never reused. */
    degraded,
    /* What each module's result was computed from — the next change check's baseline. */
    engine_keys: Object.fromEntries(readModules.map((m) => [m, keys[m]])),
    connection_user: user,
    dependencies: rules.dependencies,
    stamps,
    spec_hashes: Object.fromEntries(Object.keys(stamps).map((t) => [t, specHash(t)])),
    meta_stamps: metaStamps,
    /* Every table the ITSM catalogue read, stamped before its first read — the ITSM module's reuse baseline. */
    itsm_stamps: itsm ? itsm.stamps : null,
    cutoff,
    coverage,
    skipped_checks: rules.skipped,
    /*
     * CATALOGUE INVARIANTS, checked every run rather than only in CI. A rule
     * whose subject is a dead-status population but which is tagged `quality`
     * cannot fire — the tag strips the very CIs it exists to find. Three shipped
     * that way and were caught by reading them; this is so the next one is not.
     */
    catalogue_warnings: [...intentMisTags(CMDB_CATALOGUE), ...trackMisroutes(CMDB_CATALOGUE), ...trackMisroutes(CMDB_CATALOGUE, CONSUMPTION_TRACKS), ...trackMisroutes(CMDB_CATALOGUE, SCALE_TRACKS), ...trackMisroutes(CMDB_CATALOGUE, DRIFT_TRACKS)],
    cmdb_quality: cmdbQuality,
    /*
     * ITSM PHASE 5 — every catalogue slot, with BOTH status layers (design-time
     * classification and this run's status / verdict), its blocker, scope,
     * confidence, observed values and parameters; the informational aggregation;
     * and what the run resolved with. Counts only — no score is derived from it.
     */
    itsm: itsm ? {
      integration_version: '5.0.0',
      catalogue_rules: itsm.normalized.rules.length,
      anchor: itsm.ctx.run.now_snow,
      windows: itsm.ctx.run.windowsUsed(),
      run: {
        elapsed_ms: itsm.run.elapsed_ms, summary: itsm.run.summary, verdicts: itsm.run.verdicts,
        cached_reads: itsm.run.cached_reads, probe_cache: itsm.ctx.probes.cacheSize(),
      },
      parameters: { ...itsm.parameters.snapshot(), runtime: itsm.runtime, rejected_overrides: itsmOptions.rejected ?? [] },
      aggregation: itsm.normalized.aggregation,
      performance: itsm.performance,
      rules: itsm.normalized.rules,
      /* This scan's readings (the next scans' history) and what this scan compared with. */
      measures: itsm.measures,
      measure_history: { used: itsm.history.used, set_aside: itsm.history.set_aside, excluded_runs: itsm.history.excluded_runs },
    } : null,
    links,
    meta_reads: meta.cmdb?.reads ?? null,
    findings_detected: detected,
    findings_stored: findings.length,
    findings_truncated: detected > findings.length,
    root_cause_clusters: clusterByRule(findings),
    input_hash: digest(estate),
    metrics: {
      visible_cis: (estate.cmdb_ci || []).length,
      visible_relationships: (estate.cmdb_rel_ci || []).length,
      fetched_rows: fetchedRows,
      cmdb_quality_score: score,
      score_definition: cmdbQuality
        ? cmdbQuality.composite.definition
        : 'Percent of extracted CIs without a triggered CMDB rule. A Health Assist score, not ServiceNow CMDB Health.',
      /* The SPECIFIC reason, from the same function the switch uses — the old
         text named both tables whichever one had actually failed. */
      score_withheld_because: score === null ? (scopes.cmdb?.score_withheld_because ?? 'CMDB was not part of this scan.') : null,
    },
    domains: Object.entries(AGENTS).map(([agent, [domain, label]]) => ({
      agent_id: agent,
      domain,
      label,
      version: RULE_VERSION,
      findings: all.filter((f) => f.agent_id === agent).length,
    })),
    severity_counts: all.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1;
      return acc;
    }, {}),
    priority_counts: all.reduce((acc, f) => {
      acc[f.priority] = (acc[f.priority] || 0) + 1;
      return acc;
    }, {}),
    /* Per-scope summaries: the switch reads these, so every scope's numbers are
       computed once, over everything detected, and stored with the run. */
    scopes,
    llm,
    phases: { ...phases, total_ms: Date.now() - startedAt },
    analysis_duration_ms: Date.now() - startedAt,
    consistency: 'A bounded Table REST extraction pinned to one cutoff. The Table API is not a transactionally consistent cross-table snapshot.',
    narrative: `${(estate.cmdb_ci || []).length} visible CIs examined; ${detected} deterministic findings. Review table coverage and the highest-priority evidence before acting.`,
  };

  await emit('done', 100);
  return { status: partial ? 'partial' : 'completed', findings, manifest };
}

export { TABLES, RULE_VERSION, AGENTS };
/* The ITSM catalogue's configuration surface, for the routes — the health module's
   one facade over health/itsm (the routes never import the engine directly). */
export { buildParameterRegistry, describeParameters, validateRuntimeParameters } from './itsm/integration.js';
/* ITSM measure history: the routes read the stored runs, the facade shapes them (itsm/measure-history.js). */
export const itsmMeasureHistoryFrom = historyFromRuns;
