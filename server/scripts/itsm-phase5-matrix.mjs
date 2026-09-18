#!/usr/bin/env node
/**
 * ITSM Phase 5 — the 139-row status matrix after integration (closure).
 *
 *   node scripts/itsm-phase5-matrix.mjs    → src/health/rules/itsm/phase5-status-matrix.{json,md}
 *
 * Built from what is on disk, nothing re-decided:
 *   - the Phase 4 closure matrix (status-matrix.json) — its status, configuration,
 *     dependency and evidence columns are KEPT per row
 *   - the integrated normalisation (health/itsm/integration.js) of one run on the
 *     offline estate fixture: classification, the ladder, verdict, confidence,
 *     blocker, population
 *   - the last read-only integrated run on the configured instance
 *     (phase5-instance-validation.json, scripts/itsm-phase5-validation.mjs), when present
 * Reconciles 139 / 139: every catalogue id exactly once.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'src/health/rules/itsm');

const { getAllITSMRules } = await import('../src/health/itsm/catalogue.js');
const { runITSMRules } = await import('../src/health/itsm/runner.js');
const { normalizeITSMRun } = await import('../src/health/itsm/integration.js');
const { estateContext } = await import('../test/helpers/itsm-estate.js');

const phase4 = JSON.parse(fs.readFileSync(path.join(OUT, 'status-matrix.json'), 'utf8'));
const instPath = path.join(OUT, 'phase5-instance-validation.json');
const instance = fs.existsSync(instPath) ? JSON.parse(fs.readFileSync(instPath, 'utf8')) : null;

const ctx = estateContext();
const estate = normalizeITSMRun(await runITSMRules(ctx), { readCoverage: await ctx.reads.coverage() });

const catalogue = getAllITSMRules();
const p4 = new Map(phase4.rows.map((r) => [r.rule_id, r]));
const est = new Map(estate.rules.map((r) => [r.rule_id, r]));
const inst = new Map((instance?.rules || []).map((r) => [r.id, r]));

const rows = catalogue.map((c) => {
  const a = p4.get(c.id); const e = est.get(c.id); const i = inst.get(c.id);
  return {
    slot: c.slot,
    rule_id: c.id,
    rule: c.rule,
    base_severity: c.base_severity,
    engine: e?.engine ?? a?.engine ?? null,
    phase4_status: a?.status ?? null,
    classification: e?.classification ?? null,
    executable: e?.executable ?? null,
    configured: e?.configured ?? null,
    configuration: a?.config_required ?? null,
    unresolved_parameters: e?.unresolved_parameters ?? [],
    dependency: a?.dependency ?? [],
    scope: e?.scope ?? a?.scope ?? null,
    evidence: a?.evidence ?? null,
    estate: e ? {
      status: e.status, verdict: e.verdict, findings: e.findings, confidence: e.confidence, blocker: e.blocker?.kind ?? null,
      population: e.population ? { total: e.population.total, judged: e.population.judged, unit: e.population.unit, ...(e.population.determinate_when_empty ? { determinate_when_empty: e.population.determinate_when_empty } : {}) } : null,
      undetermined: e.undetermined?.kind ?? null,
    } : null,
    instance: i ? {
      instance: instance.instance, status: i.status, verdict: i.verdict, findings: i.findings, confidence: i.confidence, blocker: i.blocker, step: i.step,
      population: i.population ?? null, undetermined: i.undetermined ?? null, ms: i.ms, reason: i.reason,
    } : null,
  };
});

const ids = rows.map((r) => r.rule_id);
const reconciliation = {
  catalogue: catalogue.length,
  rows: rows.length,
  duplicates: [...new Set(ids.filter((x, k) => ids.indexOf(x) !== k))],
  missing: catalogue.map((c) => c.id).filter((x) => !ids.includes(x)),
};
reconciliation.complete = reconciliation.rows === 139 && !reconciliation.duplicates.length && !reconciliation.missing.length;
if (!reconciliation.complete) throw new Error(`matrix does not reconcile: ${JSON.stringify(reconciliation)}`);

const tally = (f) => rows.reduce((acc, r) => { const k = f(r) ?? 'none'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
const determinate = (x) => Boolean(x?.population?.determinate_when_empty) && x.population.total === 0;
const nothingJudged = (x) => x?.verdict === 'pass' && x.population && !(x.population.judged > 0) && !determinate(x);
const summary = {
  reconciliation,
  phase4_status: tally((r) => r.phase4_status),
  classification: tally((r) => r.classification),
  ladder: { catalogue: rows.length, implemented: rows.filter((r) => r.classification !== 'NOT_IMPLEMENTED').length, executable: rows.filter((r) => r.executable).length, configured: rows.filter((r) => r.configured).length, estate_evaluated: rows.filter((r) => r.estate?.status === 'evaluated').length, instance_evaluated: rows.filter((r) => r.instance?.status === 'evaluated').length },
  estate: { status: tally((r) => r.estate?.status), verdict: tally((r) => r.estate?.verdict), undetermined: tally((r) => r.estate?.undetermined), passes_over_nothing_judged: rows.filter((r) => nothingJudged(r.estate)).map((r) => r.rule_id), passes_determinate_when_empty: rows.filter((r) => r.estate?.verdict === 'pass' && determinate(r.estate)).map((r) => r.rule_id) },
  instance: instance ? {
    instance: instance.instance, anchor: instance.anchor, status: tally((r) => r.instance?.status), verdict: tally((r) => r.instance?.verdict), undetermined: tally((r) => r.instance?.undetermined),
    findings: rows.reduce((n, r) => n + (r.instance?.findings || 0), 0),
    passes_over_nothing_judged: rows.filter((r) => nothingJudged(r.instance)).map((r) => r.rule_id),
    passes_determinate_when_empty: rows.filter((r) => r.instance?.verdict === 'pass' && determinate(r.instance)).map((r) => r.rule_id),
  } : null,
};

fs.writeFileSync(path.join(OUT, 'phase5-status-matrix.json'), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), phase: '5 (closure)', summary, rows }, null, 2) + '\n');

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const pop = (x) => (x?.population ? `${x.population.judged ?? '?'}/${x.population.total ?? '?'}` : '');
const result = (x) => (x
  ? `${x.status}${x.verdict ? ` · ${x.verdict}` : ''}${x.population ? ` · judged ${pop(x)}` : ''}${determinate(x) ? ' · determinate when empty (workbook gate)' : ''}${x.undetermined ? ` · ${x.undetermined}` : ''}${!x.verdict && x.blocker ? ` · [${x.blocker}${x.step ? `@${x.step}` : ''}]` : ''}`
  : '—');
const md = [];
md.push('# ITSM Health Checker — Phase 5 status matrix (closure)', '',
  `Generated by \`scripts/itsm-phase5-matrix.mjs\` from the Phase 4 closure matrix (configuration, dependency and evidence columns kept per row), the integrated normalisation of one offline estate-fixture run, and the last read-only integrated run on ${instance ? `\`${instance.instance}\` (anchor ${instance.anchor})` : 'no instance'}. Regenerate rather than edit.`, '');
md.push('## Reconciliation', '', `${reconciliation.rows} rows for ${reconciliation.catalogue} catalogue rules — duplicates: ${reconciliation.duplicates.length}, missing: ${reconciliation.missing.length}.`, '');
md.push('## The ladder', '', '| Catalogue | Implemented | Executable | Configured | Evaluated (estate) | Evaluated (instance) |', '|---:|---:|---:|---:|---:|---:|',
  `| ${summary.ladder.catalogue} | ${summary.ladder.implemented} | ${summary.ladder.executable} | ${summary.ladder.configured} | ${summary.ladder.estate_evaluated} | ${summary.ladder.instance_evaluated} |`, '',
  'A rule in the catalogue is not necessarily executable; an executable rule is not necessarily configured; a configured rule is not necessarily evaluable on a given instance; an evaluated rule has not necessarily established anything (population). Each column is a separate fact.', '');
const line = (o) => Object.entries(o).filter(([k]) => k !== 'none').map(([k, v]) => `${k} ${v}`).join(' · ') || 'none';
md.push('## Summary', '', `Phase 4 status: ${line(summary.phase4_status)}`, '', `Classification (this build's parameters): ${line(summary.classification)}`, '',
  `Estate fixture — status: ${line(summary.estate.status)}; verdicts: ${line(summary.estate.verdict)}; nothing established because: ${line(summary.estate.undetermined)}; passes over nothing judged: ${summary.estate.passes_over_nothing_judged.join(', ') || 'none'}; passes the workbook makes determinate over an empty configuration population: ${summary.estate.passes_determinate_when_empty.join(', ') || 'none'}`, '');
if (summary.instance) md.push(`Instance \`${summary.instance.instance}\` — status: ${line(summary.instance.status)}; verdicts: ${line(summary.instance.verdict)}; nothing established because: ${line(summary.instance.undetermined)}; ${summary.instance.findings} findings; passes over nothing judged: ${summary.instance.passes_over_nothing_judged.join(', ') || 'none'}; passes the workbook makes determinate over an empty configuration population: ${summary.instance.passes_determinate_when_empty.join(', ') || 'none'}.`, '');
md.push('Cells read `status · verdict · judged/total · why nothing was established`. **Configuration** is the unresolved parameter keys for this build, else the Phase 4 configuration requirement. **Evidence** is the Phase 4 evidence column. **Blocker** is the instance blocker kind (and step) for a rule that did not evaluate there.', '');
md.push('## Rules', '', '| Rule ID | Engine | Execution status (estate) | Verdict (estate) | Executable | Configuration | Dependency | Finding count (estate / instance) | Confidence (instance) | Evidence | Blocker (instance) | Instance result |', '|---|---|---|---|:---:|---|---|---:|---:|---|---|---|');
for (const r of rows) {
  const i = r.instance;
  md.push(`| ${r.rule_id} — ${esc(r.rule)} | ${r.engine} | ${r.estate?.status ?? '—'}${r.estate?.population ? ` (judged ${pop(r.estate)})` : ''} | ${r.estate?.verdict ?? '—'}${r.estate?.undetermined ? ` (${r.estate.undetermined})` : ''} | ${r.executable ? '✓' : ''} | ${esc(r.unresolved_parameters.length ? `UNCONFIGURED: ${r.unresolved_parameters.join(', ')}` : r.configuration) || '—'} | ${esc(r.dependency.join(', ')) || '—'} | ${r.estate?.findings ?? '—'} / ${i?.findings ?? '—'} | ${i?.confidence ?? ''} | ${esc(r.evidence) || '—'} | ${i && !i.verdict && i.blocker ? `${i.blocker}${i.step ? `@${i.step}` : ''}` : '—'} | ${esc(result(i))} |`);
}
fs.writeFileSync(path.join(OUT, 'phase5-status-matrix.md'), md.join('\n') + '\n');
console.log(JSON.stringify(summary, null, 2));
