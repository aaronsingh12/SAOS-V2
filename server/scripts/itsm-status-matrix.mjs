#!/usr/bin/env node
/**
 * Generate the ITSM Phase 4 status matrix (139 rows) from what is actually
 * on disk: the rule configurations, the parameter declarations, the test
 * files, one run against the offline estate fixture, and — when present —
 * the last read-only run against the real instance (instance-validation.json).
 *
 *   node scripts/itsm-status-matrix.mjs            → writes rules/itsm/status-matrix.{json,md}
 *
 * Status (closure vocabulary):
 *   UNAVAILABLE    needs an object / dependency that is UNDEFINED (a placeholder object with no
 *                  reader, or an undefined dependency) — UNAVAILABLE on any instance until resolved
 *   UNCONFIGURED   executable, but a referenced workbook threshold has no default (DECISION 3), or the
 *                  workbook leaves the detection itself undefined (a declared specification gap)
 *   TESTED         executable with workbook defaults and asserted end-to-end in the rule tests
 *   IMPLEMENTED    executable with workbook defaults, not yet asserted (none should remain)
 *   ERROR          a runtime defect on the estate fixture (none should remain)
 * Columns beyond the status: executable, configuration required, dependency (the gate), tested,
 * evidence (what a finding carries), blocking reason, scope (full / partial kind), and the
 * outcome on the estate fixture and on the validation instance.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'src/health/rules/itsm');

const { ITSM_RULE_CONFIGS } = await import('../src/health/itsm/rules/index.js');
const { ITSM_PARAMETERS } = await import('../src/health/itsm/parameters.js');
const { getAllITSMRules } = await import('../src/health/itsm/catalogue.js');
const { referencedParameters } = await import('../src/health/itsm/rule-config.js');
const { PLACEHOLDERS, isVerified } = await import('../src/health/itsm/engines/configuration.js');
const { estateContext } = await import('../test/helpers/itsm-estate.js');
const { runITSMRules } = await import('../src/health/itsm/runner.js');

const tests = ['health-itsm-rules.test.js', 'health-itsm-closure.test.js', 'health-itsm-phase4.test.js'].map((f) => fs.readFileSync(path.join(ROOT, 'test', f), 'utf8')).join('\n');
const run = await runITSMRules(estateContext());
const instancePath = path.join(OUT, 'instance-validation.json');
const instance = fs.existsSync(instancePath) ? JSON.parse(fs.readFileSync(instancePath, 'utf8')) : null;

const EVIDENCE = {
  record_predicate: 'record list with the evidence fields per record; ratio kpi',
  aggregate: 'the measure, observed vs threshold, population, distribution / per-group breach',
  reference_integrity: 'source records per case (missing / inactive / invalid state); kpi over evaluated records',
  linkage: 'source records lacking / having the link; offending share',
  configuration: 'the configuration object, offending entries, observed vs expected',
  relationship_graph: 'source record, CI, path / degree; offending share',
  temporal_correlation: 'correlated records with the window and pairs; blackout intervals hit',
  audit_history: 'records with their transitions / counts; the instance state order',
  text_analysis: 'records (values redacted for identifier scans), similarity scores, clusters, frequencies',
  composite: 'the inputs\' results side by side; confidence = min',
};

const rows = [];
for (const r of getAllITSMRules()) {
  const entry = ITSM_RULE_CONFIGS.get(r.id);
  const c = entry?.config ?? null;
  const params = ITSM_PARAMETERS.definitionsFor(r.id);
  const referenced = c ? referencedParameters(c) : [];
  const undefinedReferenced = referenced.filter((k) => params.find((d) => d.key === k)?.status === 'UNDEFINED');
  const placeholderObjects = (c?.requires_objects || []).filter((o) => PLACEHOLDERS[o] && !isVerified(o));
  const verifiedObjects = (c?.requires_objects || []).filter((o) => isVerified(o));
  const blockedByObject = placeholderObjects.length > 0 || (c?.undefined_dependencies?.length > 0);
  const specGap = Boolean(c?.specification_gap);
  const tested = new RegExp(`'${r.id}'`).test(tests);
  const res = run.results.get(r.id);
  let status;
  if (!c) status = 'NOT_STARTED';
  else if (res?.status === 'error') status = 'ERROR';
  else if (blockedByObject) status = 'UNAVAILABLE';
  else if (specGap || undefinedReferenced.length) status = 'UNCONFIGURED';
  else status = tested ? 'TESTED' : 'IMPLEMENTED';
  const dependency = [
    ...placeholderObjects.map((o) => `object:${o} (${PLACEHOLDERS[o].candidate ?? 'no candidate'})`),
    ...verifiedObjects.map((o) => `verified:${o}`),
    ...(c?.requires_tables || []).map((t) => `table:${t.table}`),
    ...(c?.variants || []).flatMap((v) => (v.requires_tables || []).map((t) => `table:${t.table}`)),
    ...(c?.inputs || []).map((i) => `input:${i}`),
    ...(c?.undefined_dependencies?.length ? ['UNDEFINED dependency'] : []),
  ];
  const blocking = status === 'UNAVAILABLE'
    ? (c.undefined_dependencies?.length ? c.undefined_dependencies.join('; ') : `object(s) ${placeholderObjects.join(', ')} not defined by the workbook or DECISIONS.md — candidate table ${placeholderObjects.map((o) => PLACEHOLDERS[o].candidate ?? 'none').join(', ')}; the runner walks the DECISION 5 pipeline and answers UNAVAILABLE`)
    : status === 'UNCONFIGURED'
      ? (specGap ? `specification gap: ${c.specification_gap.missing}` : `parameter(s) ${undefinedReferenced.join(', ')} have no workbook default (DECISION 3); an instance override makes the rule run`)
      : null;
  const inst = instance?.run?.rules?.[r.id] ?? null;
  rows.push({
    slot: r.slot,
    rule_id: r.id,
    rule: r.rule,
    engine: entry?.engine ?? r.architecture.engine,
    engine_override: entry && entry.engine !== r.architecture.engine ? r.architecture.engine : null,
    status,
    executable: ['TESTED', 'IMPLEMENTED', 'UNCONFIGURED'].includes(status),
    config_required: specGap ? 'decision (specification gap)' : undefinedReferenced.length ? undefinedReferenced.join(', ') : 'none',
    dependency,
    tested,
    evidence: status === 'UNAVAILABLE' ? 'none — the blocker and pipeline step are the evidence' : EVIDENCE[entry?.engine ?? r.architecture.engine],
    blocking_reason: blocking,
    scope: c?.partial ? { partial: true, kind: c.partial.kind, not_covered: c.partial.not_covered } : { partial: false },
    parameters: params.map((d) => `${d.key}${d.status === 'DEFINED' ? `=${d.default}${d.unit ? ' ' + d.unit : ''}` : ' (UNDEFINED)'}`),
    referenced_parameters: referenced,
    unconfigured_parameters: undefinedReferenced,
    variants: (c?.variants ?? []).map((v) => v.variant ?? v.label ?? null),
    estate_run: res ? { status: res.status, verdict: res.verdict ?? null, findings: res.findings.length, blocker: res.blocker?.kind ?? null, reason: res.status === 'evaluated' ? null : res.skipped[0]?.reason ?? null } : null,
    instance_run: inst ? { instance: instance.instance, status: inst.status, verdict: inst.verdict, findings: inst.findings, blocker: inst.blocker?.kind ?? null, reason: inst.reason, ms: inst.ms } : null,
    notes: c?.notes ?? null,
    workbook_threshold: r.threshold_parameter.replace(/\s+/g, ' ').trim(),
  });
}

const count = (f) => rows.filter(f).length;
const summary = {
  rules: rows.length,
  by_status: Object.fromEntries(['TESTED', 'IMPLEMENTED', 'UNCONFIGURED', 'UNAVAILABLE', 'ERROR', 'IN_PROGRESS', 'NOT_STARTED'].map((s) => [s, count((x) => x.status === s)])),
  executable: count((x) => x.executable),
  with_test_coverage: count((x) => x.tested),
  partial_scope: { detection_gap: count((x) => x.scope.kind === 'detection_gap'), false_positive_risk: count((x) => x.scope.kind === 'false_positive_risk'), evidence_gap: count((x) => x.scope.kind === 'evidence_gap') },
  estate_run: { ...run.summary, verdicts: run.verdicts },
  instance_run: instance ? { instance: instance.instance, generated: instance.generated, ...instance.run.summary, verdicts: instance.run.verdicts, elapsed_ms: instance.run.elapsed_ms, requests: instance.run.requests.query + instance.run.requests.count + instance.run.requests.aggregate } : null,
  by_engine: Object.fromEntries([...new Set(rows.map((x) => x.engine))].sort().map((e) => [e, { rules: count((x) => x.engine === e), tested: count((x) => x.engine === e && x.status === 'TESTED'), implemented: count((x) => x.engine === e && x.status === 'IMPLEMENTED'), unconfigured: count((x) => x.engine === e && x.status === 'UNCONFIGURED'), unavailable: count((x) => x.engine === e && x.status === 'UNAVAILABLE') }])),
  parameters: { declared: ITSM_PARAMETERS.snapshot().declared, defined: [...ITSM_PARAMETERS.definitions.values()].filter((d) => d.status === 'DEFINED').length, undefined: [...ITSM_PARAMETERS.definitions.values()].filter((d) => d.status === 'UNDEFINED').length, parameterless_rules: rows.filter((x) => !x.parameters.length).length },
  undefined_objects: Object.entries(rows.reduce((m, x) => { for (const d of x.dependency) if (d.startsWith('object:')) (m[d.slice(7).split(' ')[0]] ||= []).push(x.rule_id); return m; }, {})),
  verified_objects: Object.entries(rows.reduce((m, x) => { for (const d of x.dependency) if (d.startsWith('verified:') || d.startsWith('table:')) (m[d.split(':')[1]] ||= []).push(x.rule_id); return m; }, {})),
};

fs.writeFileSync(path.join(OUT, 'status-matrix.json'), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), phase: '4 (closure)', summary, rows }, null, 2) + '\n');

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const md = [];
md.push('# ITSM Health Checker — Phase 4 status matrix (closure)', '', `Generated ${new Date().toISOString().slice(0, 10)} by \`scripts/itsm-status-matrix.mjs\` from the rule configurations, parameter declarations, tests, one run against the offline estate fixture and the last read-only run against ${instance ? `\`${instance.instance}\`` : 'no instance'}. Regenerate rather than edit.`, '');
md.push('## Summary', '', '| Status | Rules |', '|---|---:|');
for (const [s, n] of Object.entries(summary.by_status)) md.push(`| ${s} | ${n} |`);
md.push(`| **TESTED + UNCONFIGURED + UNAVAILABLE + ERROR** | **${summary.by_status.TESTED + summary.by_status.UNCONFIGURED + summary.by_status.UNAVAILABLE + summary.by_status.ERROR}** |`, `| Executable (TESTED + IMPLEMENTED + UNCONFIGURED) | ${summary.executable} |`, `| With test coverage | ${summary.with_test_coverage} |`, `| Partial scope — detection gap / false-positive risk / evidence gap | ${summary.partial_scope.detection_gap} / ${summary.partial_scope.false_positive_risk} / ${summary.partial_scope.evidence_gap} |`, '');
md.push('Estate-fixture run: ' + Object.entries(run.summary).map(([k, v]) => `${k} ${v}`).join(', ') + '; verdicts ' + Object.entries(run.verdicts).map(([k, v]) => `${k} ${v}`).join(', ') + '.');
if (summary.instance_run) md.push('', `Instance run (\`${summary.instance_run.instance}\`, ${summary.instance_run.generated.slice(0, 10)}): ` + ['evaluated', 'unavailable', 'unconfigured', 'skipped', 'error'].filter((k) => summary.instance_run[k]).map((k) => `${k} ${summary.instance_run[k]}`).join(', ') + '; verdicts ' + Object.entries(summary.instance_run.verdicts).map(([k, v]) => `${k} ${v}`).join(', ') + `; ${summary.instance_run.requests} requests in ${(summary.instance_run.elapsed_ms / 1000).toFixed(0)} s.`);
md.push('', '| Engine | Rules | Tested | Implemented | Unconfigured | Unavailable |', '|---|---:|---:|---:|---:|---:|');
for (const [e, n] of Object.entries(summary.by_engine)) md.push(`| ${e} | ${n.rules} | ${n.tested} | ${n.implemented} | ${n.unconfigured} | ${n.unavailable} |`);
md.push('', '**Status meanings.** UNAVAILABLE: needs an object or dependency that neither the workbook nor DECISIONS.md defines; the runner walks the DECISION 5 pipeline (candidate → discovery → schema → capability) and answers UNAVAILABLE with the step reached — never PASS. UNCONFIGURED: executable, but a referenced threshold has no workbook default (DECISION 3), or the detection itself is a declared specification gap; an instance override (or an explicit decision) makes it run. TESTED: executable with workbook defaults and asserted end-to-end. **Scope.** A rule declared `partial` with a *detection gap* can FAIL but never PASS (its no-finding verdict is `inconclusive`); *false-positive risk* and *evidence gap* do not affect the verdict.', '');
md.push('## Rules', '', '| Slot | Rule | Engine | Status | Executable | Config required | Dependency | Tested | Evidence | Blocking reason | Scope | Estate | Instance |', '|---:|---|---|---|:---:|---|---|:---:|---|---|---|---|---|');
for (const x of rows) {
  const er = x.estate_run ? `${x.estate_run.status}${x.estate_run.verdict ? ` (${x.estate_run.verdict}, ${x.estate_run.findings})` : x.estate_run.blocker ? ` [${x.estate_run.blocker}]` : ''}` : '';
  const ir = x.instance_run ? `${x.instance_run.status}${x.instance_run.verdict ? ` (${x.instance_run.verdict}, ${x.instance_run.findings})` : x.instance_run.blocker ? ` [${x.instance_run.blocker}]` : ''}` : '';
  md.push(`| ${x.slot} | ${x.rule_id} — ${esc(x.rule)} | ${x.engine}${x.engine_override ? ` (map: ${x.engine_override})` : ''} | ${x.status} | ${x.executable ? '✓' : ''} | ${esc(x.config_required)} | ${esc(x.dependency.join(', ')) || '—'} | ${x.tested ? '✓' : ''} | ${esc(x.evidence)} | ${esc(x.blocking_reason) || '—'} | ${x.scope.partial ? `partial: ${x.scope.kind} — ${esc(x.scope.not_covered)}` : 'full'} | ${er} | ${ir} |`);
}
md.push('', '## UNDEFINED objects (DECISION 5) and the rules waiting on them', '');
for (const [o, ids] of summary.undefined_objects) md.push(`- \`${o}\` (candidate ${PLACEHOLDERS[o]?.candidate ?? 'none'}): ${ids.join(', ')}`);
md.push('', '## Objects verified by the pipeline at run time (present on the validation instance)', '');
for (const [o, ids] of summary.verified_objects) md.push(`- \`${o}\`: ${ids.join(', ')}`);
fs.writeFileSync(path.join(OUT, 'status-matrix.md'), md.join('\n') + '\n');
console.log(JSON.stringify(summary, null, 2));
