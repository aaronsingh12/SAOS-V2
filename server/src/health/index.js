import { TABLES, resolveTables } from './tables.js';
import { extractEstate } from './extract.js';
import { EstateRules, RULE_VERSION, AGENTS, isComplete } from './rules.js';
import { explainFindings } from './explain.js';
import { digest } from './digest.js';
import { summariseScopes } from './scopes.js';

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

export const MANIFEST_VERSION = '3.0.0';

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
  staleDays = DEFAULT_STALE_DAYS,
  explain = true,
  limit,
  onProgress = null,
  client,
  signal = null,
  now = new Date(),
} = {}) {
  const startedAt = Date.now();
  const requested = resolveTables(tables);
  const emit = async (stage, percent, detail = {}) => {
    await onProgress?.({ stage, percent, ...detail });
  };

  await emit('extracting', 5);
  const { estate, coverage, cutoff } = await extractEstate(requested, {
    limit,
    client,
    signal,
    onProgress: async ({ table: t, index, total }) => {
      await emit('extracting', 5 + Math.round((index * 55) / Math.max(1, total)), { table: t });
    },
  });

  const fetchedRows = Object.values(estate).reduce((n, rows) => n + rows.length, 0);

  /* Checked between phases, not inside them. Analysis is pure and fast; the
     expensive, interruptible part is extraction, and that checks per table. */
  if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });

  await emit('analysing', 70);
  const rules = new EstateRules(estate, coverage, staleDays, now);
  const all = rules.analyze();
  const detected = all.length;
  const findings = all.slice(0, MAX_FINDINGS);

  let llm = { status: 'disabled', tokens_used: 0 };
  if (explain && findings.length) {
    await emit('explaining', 88);
    llm = await explainFindings(findings);
  }

  /*
   * Every count and score below is taken from `all` — the full detected set —
   * never from the stored slice. A cap may drop rows from storage; it must not
   * change what the page says was found.
   */
  const score = qualityScore(estate, coverage, all);
  const scopes = summariseScopes(coverage, all);

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

  const manifest = {
    version: MANIFEST_VERSION,
    rule_pack_version: RULE_VERSION,
    cutoff,
    coverage,
    skipped_checks: rules.skipped,
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
      score_definition: 'Percent of extracted CIs without a triggered CMDB rule. A Health Assist score, not ServiceNow CMDB Health.',
      /* The SPECIFIC reason, from the same function the switch uses — the old
         text named both tables whichever one had actually failed. */
      score_withheld_because: score === null ? scopes.cmdb.score_withheld_because : null,
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
    analysis_duration_ms: Date.now() - startedAt,
    consistency: 'A bounded Table REST extraction pinned to one cutoff. The Table API is not a transactionally consistent cross-table snapshot.',
    narrative: `${(estate.cmdb_ci || []).length} visible CIs examined; ${detected} deterministic findings. Review table coverage and the highest-priority evidence before acting.`,
  };

  await emit('done', 100);
  return { status: partial ? 'partial' : 'completed', findings, manifest };
}

export { TABLES, RULE_VERSION, AGENTS };
