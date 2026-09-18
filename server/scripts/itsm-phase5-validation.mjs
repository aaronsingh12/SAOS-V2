#!/usr/bin/env node
/**
 * ITSM Phase 5 closure — READ-ONLY validation on the configured instance
 * (Dashboard → Connection). Nothing is written to ServiceNow.
 *
 *   node scripts/itsm-phase5-validation.mjs   → src/health/rules/itsm/phase5-instance-validation.json
 *
 *   1. the Phase 4 runner standalone, counted (requests, cache hits / misses)
 *   2. the integrated Health Checker (ITSM module) at the SAME anchor
 *   3. standalone vs integrated, all 139 rules (integration.js reconcileStandalone, live)
 *   4. the eleven legacy rules against their nearest catalogue rules, record for
 *      record — counts and overlaps only
 *   5. repeat scans with reuse, immediately after: each attempt's plan and reasons;
 *      when an attempt re-reads, the next uses its result as the baseline
 *   6. every rule's state, and what the closure changed against the previous file
 *
 * Metadata, counts and rule states only: no record contents, no sys_ids.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'src/health/rules/itsm/phase5-instance-validation.json');

const { runHealthCheck } = await import('../src/health/index.js');
const { table } = await import('../src/servicenow/client.js');
const { boundInstance } = await import('../src/servicenow/instance-binding.js');
const { createEvaluationContext } = await import('../src/health/itsm/context.js');
const { runITSMRules } = await import('../src/health/itsm/runner.js');
const { countingClient, buildParameterRegistry, reconcileStandalone } = await import('../src/health/itsm/integration.js');
const { undeterminedOf } = await import('../src/health/itsm/engines/result.js');
const { itsmParameterOverrides } = await import('../src/health/store.js');

const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
const bound = boundInstance();
const anchor = new Date();
const built = buildParameterRegistry(itsmParameterOverrides());
const out = {
  generated: null, phase: '5 (closure)', read_only: true, instance: new URL(bound.url).host, anchor: anchor.toISOString(),
  stored_parameter_overrides: built.applied.length,
  note: 'Metadata, counts and rule states only — no record contents, no sys_ids. Produced by scripts/itsm-phase5-validation.mjs.',
};
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const tally = (xs, f) => xs.reduce((a, x) => { const k = f(x) ?? 'none'; a[k] = (a[k] || 0) + 1; return a; }, {});

/* 1 — standalone */
log('standalone runner');
const standaloneStartedAt = new Date().toISOString();
let t0 = Date.now();
const counting = countingClient(table);
const ctx = createEvaluationContext({ client: counting.client, now: anchor, parameters: built.registry });
const standalone = await runITSMRules(ctx);
const sResults = [...standalone.results.values()];
out.standalone_runner = {
  ms: Date.now() - t0, summary: standalone.summary, verdicts: standalone.verdicts,
  requests: { total: counting.calls.query + counting.calls.count + counting.calls.aggregate + counting.calls.countBy, query: counting.calls.query, count: counting.calls.count, aggregate: counting.calls.aggregate + counting.calls.countBy },
  cache: ctx.cacheStats(),
  findings: sResults.reduce((n, r) => n + r.findings.length, 0),
  undetermined: tally(sResults.filter((r) => r.status === 'evaluated' && !r.findings.length), (r) => undeterminedOf(r)?.kind ?? 'established'),
  passes_over_nothing_judged: sResults.filter((r) => r.verdict === 'pass' && !(r.population?.judged > 0) && !r.population?.determinate_when_empty).map((r) => r.rule_id),
};
log(`standalone done in ${out.standalone_runner.ms} ms`);

/* 2 — integrated */
log('integrated scan');
t0 = Date.now();
const first = await runHealthCheck({ explain: false, modules: ['itsm'], reuse: false, user: bound.username, now: anchor, itsm: { parameters: built.registry, rejected: built.rejected } });
const m = first.manifest;
const catalogueFindings = first.findings.filter((f) => f.domain === 'ITSM');
out.integrated_scan = {
  status: first.status, wall_ms: Date.now() - t0, phases: m.phases, degraded: m.degraded,
  aggregation: m.itsm.aggregation, performance: m.itsm.performance,
  itsm_stamps: Object.keys(m.itsm_stamps || {}).length,
  scope_itsm: { score: m.scopes.itsm.score, basis: m.scopes.itsm.score_basis, findings: m.scopes.itsm.findings, severity_counts: m.scopes.itsm.severity_counts, domains: m.scopes.itsm.domains },
  findings_total: first.findings.length,
  legacy_by_rule: tally(first.findings.filter((f) => f.domain !== 'ITSM'), (f) => f.rule_id),
  catalogue_by_rule: tally(catalogueFindings, (f) => f.rule_id),
  coverage: Object.fromEntries(['incident', 'change_request', 'problem'].map((t) => [t, { status: m.coverage[t]?.status, records: m.coverage[t]?.records }])),
};
log(`integrated done in ${out.integrated_scan.wall_ms} ms`);

/*
 * 3 — reconciliation. The two runs read a LIVE instance minutes apart, so a change
 * stamp is taken (read-only stats: count and newest sys_updated_on) for every table
 * the standalone run read, after both runs; a table updated since the standalone
 * run started is the evidence the `records_updated` explanation needs.
 * Values that could carry record contents are reduced to counts / field names.
 */
const readTables = [...new Set(sResults.flatMap((r) => (r.coverage || []).map((c) => c?.table)).filter((t) => typeof t === 'string'))].sort();
const changes = [];
for (const t of readTables) {
  try {
    const st = await table.changeStamp(t, '');
    changes.push({ table: t, count: st.count, max_updated: st.maxUpdated, basis: st.basis, taken_at: new Date().toISOString() });
  } catch (err) { changes.push({ table: t, error: String(err?.status ?? err?.message ?? err).slice(0, 80), taken_at: new Date().toISOString() }); }
}
out.live_changes = { standalone_started_at: standaloneStartedAt, stamped_tables: readTables.length, updated_since_standalone_start: changes.filter((c) => c.max_updated && new Date(`${String(c.max_updated).replace(' ', 'T')}Z`).getTime() > new Date(standaloneStartedAt).getTime() && new Date(`${String(c.max_updated).replace(' ', 'T')}Z`).getTime() <= new Date(c.taken_at).getTime()) };
const rec = reconcileStandalone(standalone, { rules: m.itsm.rules, findings: catalogueFindings, live: true, changes, standaloneStartedAt });
const safe = (d) => (['evidence', 'fingerprints'].includes(d.field) ? { field: d.field, standalone: (d.standalone || []).length, integrated: (d.integrated || []).length, ...(d.fields_changed ? { fields_changed: d.fields_changed, rows_added_or_removed: d.rows_added_or_removed } : {}) } : d);
out.reconciliation = {
  summary: rec.summary,
  rows: rec.rows.filter((r) => !r.matching).map((r) => ({ rule_id: r.rule_id, differences: r.differences.map(safe), explained: r.explained.map((e) => ({ mechanism: e.mechanism, fields: e.fields, evidence: e.evidence, ...(e.tables ? { tables: e.tables } : {}), merged: (e.fingerprints || []).map((f) => ({ occurrences: f.occurrences, merged_details: f.merged_details })) })), unexpected: r.unexpected.map(safe) })),
};
log(rec.summary.line);

/* 4 — the eleven legacy rules, record for record */
const LEGACY = [
  ['ITSM-INC-UNASSIGNED', ['ITSM-042', 'ITSM-018']], ['ITSM-INC-P1-AGED', ['ITSM-037']], ['ITSM-INC-STALE', []], ['ITSM-INC-NO-CI', ['ITSM-016']],
  ['ITSM-INC-REOPENED', ['ITSM-030']], ['ITSM-CHG-STALE', []], ['ITSM-CHG-NO-CI', ['ITSM-094']], ['ITSM-CHG-OVERDUE', ['ITSM-111']],
  ['ITSM-CHG-FAILED', ['ITSM-113', 'ITSM-114']], ['ITSM-PRB-UNASSIGNED', ['ITSM-065']], ['ITSM-PRB-STALE', ['ITSM-061', 'ITSM-056']],
];
const legacyFindings = first.findings.filter((f) => f.domain !== 'ITSM');
const idsOf = (fs) => new Set(fs.flatMap((f) => f.target_ids || []));
out.legacy_comparison = LEGACY.map(([legacy, mapped]) => {
  const L = idsOf(legacyFindings.filter((f) => f.rule_id === legacy));
  return {
    legacy, legacy_findings: legacyFindings.filter((f) => f.rule_id === legacy).length, legacy_records: L.size,
    catalogue: mapped.map((id) => {
      const row = m.itsm.rules.find((x) => x.rule_id === id);
      const fs2 = catalogueFindings.filter((f) => f.rule_id === id);
      const C = idsOf(fs2);
      const both = [...C].filter((x) => L.has(x)).length;
      return {
        rule_id: id, status: row.status, verdict: row.verdict, classification: row.classification, findings: row.findings,
        kinds: [...new Set(fs2.map((f) => f.kind))], record_level: fs2.some((f) => (f.target_ids || []).length),
        catalogue_records: C.size, overlap: both, legacy_only: L.size - both, catalogue_only: C.size - both,
        population: row.population ? { total: row.population.total, judged: row.population.judged, unit: row.population.unit } : null,
        kpis: row.kpis.map((k) => ({ numerator: k.numerator, denominator: k.denominator, pass_pct: k.pass_pct, variant: k.variant })),
        blocker: row.blocker?.kind ?? null,
      };
    }),
  };
});

/* 5 — repeat scans with reuse */
const baselineOf = (res, at, id) => ({ itsm: {
  runId: id, status: res.status, checkedAt: at.toISOString(), engineKey: res.manifest.engine_keys.itsm, user: bound.username,
  dependencies: res.manifest.dependencies.itsm, degraded: res.manifest.degraded.itsm ?? null, stamps: res.manifest.stamps, specHashes: res.manifest.spec_hashes, metaStamps: res.manifest.itsm_stamps,
} });
out.reuse = [];
let baseline = baselineOf(first, anchor, 'closure-1');
for (let attempt = 1; attempt <= 3; attempt += 1) {
  log(`repeat scan ${attempt}`);
  const at = new Date();
  t0 = Date.now();
  const again = await runHealthCheck({ explain: false, modules: ['itsm'], reuse: true, baselines: baseline, user: bound.username, now: at, itsm: { parameters: built.registry, rejected: built.rejected } });
  const plan = again.manifest.plan?.modules?.itsm ?? null;
  out.reuse.push({
    attempt, started: at.toISOString(), wall_ms: Date.now() - t0, kind: again.manifest.kind, verified_modules: again.manifest.verified_modules, read_modules: again.manifest.modules,
    reasons: plan?.reasons ?? [], change_check_ms: again.manifest.phases?.change_check_ms ?? null,
    catalogue_reran: Boolean(again.manifest.itsm), itsm_ms: again.manifest.phases?.itsm_ms ?? null,
  });
  log(`repeat ${attempt}: ${again.manifest.kind} ${(plan?.reasons || []).join(' | ')}`);
  if (again.manifest.verified_modules?.includes('itsm')) break;
  baseline = baselineOf(again, at, `closure-${attempt + 1}`);
}

/* 6 — every rule, and what the closure changed against the previous validation */
out.rules = m.itsm.rules.map((r) => ({
  id: r.rule_id, engine: r.engine, classification: r.classification, status: r.status, verdict: r.verdict, findings: r.findings, confidence: r.confidence,
  blocker: r.blocker?.kind ?? null, step: r.blocker?.step ?? null,
  population: r.population ? { total: r.population.total, judged: r.population.judged, unit: r.population.unit, ...(r.population.determinate_when_empty ? { determinate_when_empty: r.population.determinate_when_empty } : {}) } : null,
  undetermined: r.undetermined?.kind ?? null, empty: r.population_empty, ms: r.ms, reason: r.reason?.slice(0, 160) ?? null,
}));
if (previous?.rules) {
  const before = new Map(previous.rules.map((r) => [r.id, r]));
  out.closure_changes = {
    previous_anchor: previous.anchor,
    rows: out.rules.filter((r) => { const b = before.get(r.id); return b && (b.status !== r.status || b.verdict !== r.verdict || b.findings !== r.findings); })
      .map((r) => ({ id: r.id, before: { status: before.get(r.id).status, verdict: before.get(r.id).verdict, findings: before.get(r.id).findings }, after: { status: r.status, verdict: r.verdict, findings: r.findings, undetermined: r.undetermined, population: r.population } })),
    previous_standalone: previous.standalone_runner ? { ms: previous.standalone_runner.ms, requests: previous.standalone_runner.requests, summary: previous.standalone_runner.summary, verdicts: previous.standalone_runner.verdicts } : null,
  };
}
out.generated = new Date().toISOString();
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
log(`written ${path.relative(process.cwd(), OUT)}`);
