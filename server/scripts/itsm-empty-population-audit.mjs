#!/usr/bin/env node
/**
 * ITSM Phase 5 closure — the empty-population audit, all 139 rules.
 *
 *   node scripts/itsm-empty-population-audit.mjs   → src/health/rules/itsm/phase5-empty-population-audit.{json,md}
 *
 * Offline, deterministic, no instance. For every catalogue rule:
 *   - its detection shape (engine + the configuration's mode / measure / comparator)
 *   - the populated estate fixture: status, verdict, the population it declared
 *   - the SAME fixture with incident, problem, change_request, task_sla,
 *     kb_knowledge, m2m_kb_task, sys_user_delegate and sysapproval_approver
 *     emptied: status, verdict, and why nothing was established
 *   - for a rule UNCONFIGURED on the fixture: the empty run again with a
 *     PLACEHOLDER value for each missing parameter (audit only — never a default,
 *     never stored, never used by a scan), so its engine path is exercised too
 *   - the reading: how the rule treats an empty population, and why
 * Throws if any evaluated rule passes over nothing judged, or declares no population.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'src/health/rules/itsm');

const { getAllITSMRules } = await import('../src/health/itsm/catalogue.js');
const { runITSMRules } = await import('../src/health/itsm/runner.js');
const { ITSM_RULE_CONFIGS } = await import('../src/health/itsm/rules/index.js');
const { ITSM_PARAMETERS } = await import('../src/health/itsm/parameters.js');
const { undeterminedOf } = await import('../src/health/itsm/engines/result.js');
const { estateContext } = await import('../test/helpers/itsm-estate.js');

const EMPTIED = ['incident', 'problem', 'change_request', 'task_sla', 'kb_knowledge', 'm2m_kb_task', 'sys_user_delegate', 'sysapproval_approver'];
const EMPTY = Object.fromEntries(EMPTIED.map((t) => [t, []]));

const placeholder = (def) => ({ number: 1, percent: 50, duration: 30, string: 'placeholder', list: ['placeholder'], boolean: true }[def?.type] ?? 1);

async function runOn(overrides, runtimeParameters = {}) {
  const ctx = estateContext(overrides, { runtimeParameters });
  return runITSMRules(ctx);
}

const populated = await runOn({});
const empty = await runOn(EMPTY);

/* placeholders for every parameter the fixture leaves UNCONFIGURED */
const runtime = {};
for (const r of getAllITSMRules()) {
  const res = ITSM_PARAMETERS.resolve(r.id);
  for (const [k, p] of Object.entries(res.parameters || {})) if (p.status !== 'RESOLVED') (runtime[r.id] ||= {})[k] = placeholder(p.definition);
}
const placeheld = await runOn(EMPTY, runtime);

const shapeOf = (id) => {
  const e = ITSM_RULE_CONFIGS.get(id);
  if (!e) return null;
  const c = e.config;
  const bits = [
    c.measure, c.numerator_query !== undefined ? 'count ratio' : null, c.trend ? 'trend' : null,
    c.operation, c.mode, c.expect ? `expect ${c.expect}` : null, c.check ? `check ${c.check}` : null,
    c.source ? `source ${c.source}` : null, c.question ? `question ${c.question}` : null,
    c.compare?.name ? `compare ${c.compare.name}` : null, c.combine?.name ? `combine ${c.combine.name}` : null,
    c.predicates ? 'predicates' : null, c.variants?.length ? `${c.variants.length} variants` : null,
  ].filter(Boolean);
  return bits.join(', ');
};

const brief = (x) => (x ? {
  status: x.status, verdict: x.verdict ?? null, findings: x.findings.length,
  population: x.population ? { total: x.population.total, judged: x.population.judged, unit: x.population.unit, basis: x.population.basis, ...(x.population.determinate_when_empty ? { determinate_when_empty: x.population.determinate_when_empty } : {}) } : null,
  undetermined: x.status === 'evaluated' && !x.findings.length ? (undeterminedOf(x)?.kind ?? null) : null,
  partial: x.scope?.partial ? x.scope.kind : null,
  blocker: x.blocker?.kind ?? null,
} : null);

function readingOf(id, p, e, h) {
  const ev = (x) => x?.status === 'evaluated';
  const pick = ev(e) ? e : ev(h) ? h : null;
  if (!pick) {
    const b = e?.blocker?.kind ?? h?.blocker?.kind;
    return { category: 'NOT_EVALUABLE_OFFLINE', reading: `does not evaluate on the fixture (${e?.status}${b ? `, ${b}` : ''}) — no verdict at all, so no pass; when it evaluates, its engine declares a population like every other path` };
  }
  const via = pick === h && !ev(e) ? ' (with placeholder parameters)' : '';
  const raw = ITSM_RULE_CONFIGS.get(id)?.config;
  const declared = raw?.partial ? `; Phase 4 declared ${raw.partial.kind}: ${raw.partial.not_covered}` : '';
  if (raw?.compare?.name === 'rules_referencing_fields') {
    return { category: 'DETERMINATE_WHEN_EMPTY', reading: `no active assignment rule references the fields → pass (the workbook threshold "Fires only where routing rules reference the fields"); a rule references one → the records in scope are the population, and here: ${pick.verdict}${undeterminedOf(pick) ? ` (${undeterminedOf(pick).kind})` : ''}${via}` };
  }
  if (pick.findings.length) {
    return pick.population?.judged > 0
      ? { category: 'JUDGED_OVER_WHAT_REMAINS', reading: `fails over a population the emptied tables do not hold (${pick.population.judged} ${pick.population.unit})${via}${declared}` }
      : { category: 'FAIL_OVER_NOTHING', reading: `FAILS with nothing judged${via}` };
  }
  if (pick.population?.determinate_when_empty && pick.population.total === 0) return { category: 'DETERMINATE_WHEN_EMPTY', reading: `${pick.population.determinate_when_empty}${via}` };
  if (pick.verdict === 'pass') return { category: pick.population?.judged > 0 ? 'JUDGED_OVER_WHAT_REMAINS' : 'PASS_OVER_NOTHING', reading: `passes over ${pick.population?.judged ?? '?'} ${pick.population?.unit ?? ''} the emptied tables do not hold${via}` };
  const kind = undeterminedOf(pick)?.kind;
  if (kind) return { category: 'REQUIRES_POPULATION', reading: `empty → inconclusive (${kind}: ${undeterminedOf(pick)?.reason ?? ''})${via}` };
  return { category: 'PARTIAL_SCOPE', reading: `inconclusive by its declared ${pick.scope?.kind ?? 'partial'} scope; population ${pick.population?.judged ?? '?'} ${pick.population?.unit ?? ''}${via}` };
}

const rows = getAllITSMRules().map((r) => {
  const p = populated.results.get(r.id); const e = empty.results.get(r.id); const h = placeheld.results.get(r.id);
  const reading = readingOf(r.id, brief(p), e, h);
  return {
    rule_id: r.id, rule: r.rule, engine: ITSM_RULE_CONFIGS.get(r.id)?.engine ?? null, shape: shapeOf(r.id),
    workbook: { detection_logic: r.detection_logic, threshold: r.threshold_parameter },
    populated: brief(p), empty: brief(e), empty_with_placeholders: runtime[r.id] ? brief(h) : null,
    ...reading,
  };
});

/* the audit's own guards */
const violations = [];
for (const row of rows) {
  for (const [label, x] of [['populated', row.populated], ['empty', row.empty], ['empty_with_placeholders', row.empty_with_placeholders]]) {
    if (!x || x.status !== 'evaluated') continue;
    if (!x.population) violations.push(`${row.rule_id} ${label}: no population declared`);
    if (x.verdict === 'pass' && !(x.population?.judged > 0) && !x.population?.determinate_when_empty) violations.push(`${row.rule_id} ${label}: pass over nothing judged`);
  }
  if (['PASS_OVER_NOTHING', 'FAIL_OVER_NOTHING'].includes(row.category)) violations.push(`${row.rule_id}: ${row.category}`);
}
if (rows.length !== 139) violations.push(`${rows.length} rows, not 139`);
if (violations.length) throw new Error(`empty-population audit failed:\n${violations.join('\n')}`);

const tally = (f) => rows.reduce((acc, r) => { const k = f(r) ?? 'none'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
const summary = {
  rules: rows.length,
  emptied_tables: EMPTIED,
  by_category: tally((r) => r.category),
  empty_estate: { status: tally((r) => r.empty.status), verdict: tally((r) => r.empty.verdict), undetermined: tally((r) => r.empty.undetermined) },
  placeholder_run: { rules: Object.keys(runtime).length, status: tally((r) => r.empty_with_placeholders?.status), verdict: tally((r) => r.empty_with_placeholders?.verdict) },
  passes_over_nothing: 0,
};

fs.writeFileSync(path.join(OUT, 'phase5-empty-population-audit.json'), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), summary, rows }, null, 2) + '\n');

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const cell = (x) => (x ? `${x.status}${x.verdict ? ` · ${x.verdict}` : ''}${x.population ? ` · ${x.population.judged ?? '?'}/${x.population.total ?? '?'}` : ''}${x.undetermined ? ` · ${x.undetermined}` : ''}${x.partial ? ` · partial (${x.partial})` : ''}` : '—');
const md = [];
md.push('# ITSM Phase 5 closure — empty-population audit (139 rules)', '',
  `Generated by \`scripts/itsm-empty-population-audit.mjs\` on the offline estate fixture. Regenerate rather than edit. The script throws if any evaluated rule passes over nothing judged or declares no population.`, '',
  '**How it was run.** Three runs of all 139 rules: the populated estate; the same estate with ' + EMPTIED.map((t) => `\`${t}\``).join(', ') + ' emptied; and the emptied estate again with a PLACEHOLDER value for every parameter the workbook leaves undefined (audit only — never a default, never stored, never used by a scan), so UNCONFIGURED rules exercise their engine path too. Cells read `status · verdict · judged/total · why nothing was established`.', '',
  '## Summary', '',
  `By reading: ${Object.entries(summary.by_category).map(([k, v]) => `${k} ${v}`).join(' · ')}`, '',
  `Empty estate — status: ${Object.entries(summary.empty_estate.status).map(([k, v]) => `${k} ${v}`).join(' · ')}; verdicts: ${Object.entries(summary.empty_estate.verdict).map(([k, v]) => `${k} ${v}`).join(' · ')}; nothing established because: ${Object.entries(summary.empty_estate.undetermined).filter(([k]) => k !== 'none').map(([k, v]) => `${k} ${v}`).join(' · ')}`, '',
  `Placeholder run (${summary.placeholder_run.rules} rules with a missing parameter) — status: ${Object.entries(summary.placeholder_run.status).filter(([k]) => k !== 'none').map(([k, v]) => `${k} ${v}`).join(' · ')}; verdicts: ${Object.entries(summary.placeholder_run.verdict).filter(([k]) => k !== 'none').map(([k, v]) => `${k} ${v}`).join(' · ')}`, '',
  '## Readings', '',
  '| Reading | Meaning |', '|---|---|',
  '| REQUIRES_POPULATION | "No offender" needs something judged. Empty → `inconclusive`, with the reason. |',
  '| DETERMINATE_WHEN_EMPTY | The workbook itself makes an empty configuration population the answer (only ITSM-029: "fires only where routing rules reference the fields"). Records in scope are still required once a rule references a field. |',
  '| JUDGED_OVER_WHAT_REMAINS | The rule\'s population is not in the emptied tables (configuration, schedules, notifications …); its verdict is over what is there. |',
  '| PARTIAL_SCOPE | Already inconclusive without a finding because its configuration declares a partial detection (Phase 4). |',
  '| NOT_EVALUABLE_OFFLINE | UNAVAILABLE or UNCONFIGURED on the fixture even with placeholders — no verdict, so no pass. |', '',
  '## Rules', '',
  '| Rule | Engine · shape | Populated | Empty | Empty + placeholders | Reading |', '|---|---|---|---|---|---|');
for (const r of rows) md.push(`| ${r.rule_id} — ${esc(r.rule)} | ${r.engine} · ${esc(r.shape)} | ${cell(r.populated)} | ${cell(r.empty)} | ${cell(r.empty_with_placeholders)} | **${r.category}** — ${esc(r.reading)} |`);
fs.writeFileSync(path.join(OUT, 'phase5-empty-population-audit.md'), md.join('\n') + '\n');
console.log(JSON.stringify(summary, null, 2));
