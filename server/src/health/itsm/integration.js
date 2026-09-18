import { getAllITSMRules, getITSMRule } from './catalogue.js';
import { ITSM_RULE_CONFIGS } from './rules/index.js';
import { PLACEHOLDERS, isVerified } from './engines/configuration.js';
import { ITSM_PARAMETERS, PARAMETER_STATUS, ParameterRegistry, loadParameterDeclarations } from './parameters.js';
import { STATUS, undeterminedOf } from './engines/result.js';
import { FAILED_READ_STATUSES } from '../extract.js';
import { fromSnowTime } from './run-context.js';

/**
 * ITSM PHASE 5 — the runner's results, as the Health Checker receives them.
 *
 * `runITSMRules` answers per rule in the Phase 4 vocabulary. The Health Checker
 * stores findings in one table, lists skipped checks, and summarises scopes. This
 * module is the ONE translation between the two, and it is written so that
 * nothing the runner established is lost or softened on the way:
 *
 *   findings      plain copies of the frozen Phase 4 findings (the scan assigns
 *                 priority, impact and ai_summary in place), each carrying the
 *                 trace finding → rule → catalogue group → engine → verdict
 *   rules         exactly one row per catalogue slot (139), with BOTH status
 *                 layers — the design-time classification and the run-time
 *                 status / verdict — never mapped onto pass / fail / skipped
 *   skipped       one skipped-check row per rule that did not evaluate, in the
 *                 shape the page already renders (rule / table / reason are
 *                 strings) with the ITSM state kept beside it
 *   aggregation   counts only — informational and deterministic, never a score
 *   degraded      reads that FAILED (not reads the instance cannot serve), so a
 *                 result built on them is never reused
 *
 * Pure: no instance, no database, no clock.
 */

export const CLASSIFICATION = Object.freeze({
  EXECUTABLE: 'EXECUTABLE',        // runs with the parameters this scan resolved
  UNCONFIGURED: 'UNCONFIGURED',    // a referenced parameter has no value, or a declared specification gap
  UNAVAILABLE: 'UNAVAILABLE',      // needs an object / dependency neither the workbook nor DECISIONS.md defines
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED', // no rule configuration (none should exist after Phase 4)
});

const RUN_STATUSES = Object.freeze(Object.values(STATUS));
const SEVERITY_BANDS = Object.freeze(['SYSTEMIC', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Every parameter key a configuration can need: `{ $param }` and `{ $window: { param } }`, variants included. */
export function parameterKeysOf(node, acc = new Set()) {
  if (Array.isArray(node)) { for (const x of node) parameterKeysOf(x, acc); return acc; }
  if (!isObj(node)) return acc;
  if (typeof node.$param === 'string') acc.add(node.$param);
  if (isObj(node.$window) && typeof node.$window.param === 'string') acc.add(node.$window.param);
  for (const v of Object.values(node)) parameterKeysOf(v, acc);
  return acc;
}

/**
 * The design-time classification of one rule UNDER THIS SCAN'S PARAMETERS —
 * the Phase 4 matrix's logic, except that an instance or runtime override that
 * supplies an UNDEFINED parameter makes the rule EXECUTABLE (DECISION 4).
 */
export function classifyRule(id, { configs = ITSM_RULE_CONFIGS, parameters = ITSM_PARAMETERS, runtime = {} } = {}) {
  const entry = configs.get(id);
  if (!entry) {
    return { classification: CLASSIFICATION.NOT_IMPLEMENTED, implemented: false, executable: false, configured: false, unresolved_parameters: [], undefined_objects: [] };
  }
  const c = entry.config;
  const undefinedObjects = (c.requires_objects || []).filter((o) => PLACEHOLDERS[o] && !isVerified(o));
  if (undefinedObjects.length || c.undefined_dependencies?.length) {
    return { classification: CLASSIFICATION.UNAVAILABLE, implemented: true, executable: false, configured: false, unresolved_parameters: [], undefined_objects: undefinedObjects, undefined_dependencies: [...(c.undefined_dependencies || [])] };
  }
  const resolved = parameters.resolve(id, { runtime: runtime[id] || {} });
  const unresolved = [...parameterKeysOf(c)].filter((k) => resolved.parameters?.[k]?.status !== PARAMETER_STATUS.RESOLVED).sort();
  if (c.specification_gap || unresolved.length) {
    return { classification: CLASSIFICATION.UNCONFIGURED, implemented: true, executable: true, configured: false, unresolved_parameters: unresolved, specification_gap: Boolean(c.specification_gap), undefined_objects: [] };
  }
  return { classification: CLASSIFICATION.EXECUTABLE, implemented: true, executable: true, configured: true, unresolved_parameters: [], undefined_objects: [] };
}

/*
 * EVIDENCE OF AN EMPTY POPULATION — an independent cross-check.
 *
 * Found integrating Phase 5 (17 Sep 2026): with no incidents, problems or changes
 * the Phase 4 runner answered `pass` for 55 rules — an aggregate over 0 / 0, a
 * predicate over zero records. The PHASE 5 CLOSURE fixed it where the verdict is
 * decided: every engine declares the population it judged, and the runner answers
 * `inconclusive` over an empty one (engines/result.js `undeterminedOf`).
 *
 * This reading is deliberately NOT that contract: it looks only at what the
 * result carries anyway — every kpi over a zero denominator, or, with no kpi,
 * every population read returning zero rows. A pass it flags is a pass the
 * contract missed, so `aggregation.passes_over_empty_population` must stay empty;
 * the tests and the instance validation hold it there.
 */
export function emptyPopulationEvidence(res) {
  if (res.status !== STATUS.EVALUATED || (res.findings || []).length) return false;
  const kpis = res.kpis || [];
  if (kpis.length) return kpis.every((k) => k.denominator === 0);
  const reads = (res.coverage || []).filter((c) => ['rows', 'ids', 'aggregate'].includes(c?.strategy));
  return reads.length > 0 && reads.every((c) => c.totalKnown === 0);
}

const minConfidence = (findings) => (findings.length ? Math.min(...findings.map((f) => (typeof f.confidence === 'number' ? f.confidence : 1))) : null);

/** A blocker made JSON-safe and bounded — every field the runner set, nothing invented. */
const plainBlocker = (b) => (b ? JSON.parse(JSON.stringify(b)) : null);

/** The human sentence for a result, always a string (the page renders it as text). */
function reasonOf(res) {
  if (res.status === STATUS.EVALUATED) return null;
  const r = res.blocker?.reason ?? res.skipped?.[0]?.reason ?? `status ${res.status}`;
  return String(r);
}

const FAILED_READ = new Set(FAILED_READ_STATUSES);
const PROBE_FAILURE = /the probe failed \(([a-z_]+)\)/;

/** Reads this rule depended on that failed, and probes that could not answer — distinct, in order. */
export function transientFailures(res) {
  const out = [];
  for (const c of res.coverage || []) if (c && FAILED_READ.has(c.status)) out.push(`${c.table}: ${c.status}`);
  const text = [res.blocker?.reason, ...(res.skipped || []).map((x) => x?.reason)].filter(Boolean).join(' | ');
  const probe = PROBE_FAILURE.exec(text);
  if (probe) out.push(`a capability probe failed (${probe[1]})`);
  return [...new Set(out)];
}

/** The table a non-evaluated rule was stopped at, as a string or null. */
function tableOf(res) {
  const b = res.blocker || {};
  const t = b.table ?? b.candidate_table ?? res.skipped?.[0]?.table ?? null;
  return typeof t === 'string' ? t : null;
}

/**
 * Normalise one runner result into the Health Checker's shapes.
 * `classification` is `classifyRule`'s answer for the same rule.
 */
function normalizeOne(id, res, classification, timing) {
  const rule = getITSMRule(id);
  const row = {
    rule_id: id,
    slot: rule.slot,
    title: rule.rule,
    group: rule.group,
    engine: res.engine,
    base_severity: rule.base_severity,
    classification: classification.classification,
    implemented: classification.implemented,
    executable: classification.executable,
    configured: classification.configured,
    status: RUN_STATUSES.includes(res.status) ? res.status : String(res.status),
    verdict: res.verdict ?? null,
    evaluated: res.status === STATUS.EVALUATED,
    empty_population_evidence: emptyPopulationEvidence(res),
    /* The population the verdict rests on, and — when it established nothing — why, in words and as a kind. */
    population: res.population ? JSON.parse(JSON.stringify(res.population)) : null,
    population_empty: undeterminedOf(res)?.kind === 'empty_population',
    undetermined: (() => { const u = undeterminedOf(res); return u && !(res.findings || []).length ? { kind: u.kind, reason: u.reason, health: 'not established', verdict: res.verdict ?? null } : null; })(),
    blocker: plainBlocker(res.blocker),
    scope: res.scope ? { ...res.scope } : { partial: false },
    confidence: minConfidence(res.findings || []),
    findings: (res.findings || []).length,
    kpis: (res.kpis || []).map((k) => ({ numerator: k.numerator ?? null, denominator: k.denominator ?? null, pass_pct: k.pass_pct ?? null, basis: k.basis ?? null, complete: k.complete ?? null, variant: k.variant ?? null })),
    parameters: res.explanation?.parameters_used ?? {},
    unresolved_parameters: classification.unresolved_parameters,
    dependencies: [...(res.dependencies ?? [])],
    variants: (res.variants || []).map((v) => ({ ...v })),
    evidence_missing: [...(res.evidence_missing || [])],
    reason: reasonOf(res),
    error: res.error ? { name: res.error.name, message: res.error.message } : null,
    ms: timing ?? null,
  };
  return row;
}

/**
 * The run, normalised.
 *
 * @param {object} run       what `runITSMRules` returned
 * @param {object} opts      `{ configs, parameters, runtime }` — the same the run used
 * @returns {{ findings, rules, skipped, aggregation, degraded }}
 */
export function normalizeITSMRun(run, { configs = ITSM_RULE_CONFIGS, parameters = ITSM_PARAMETERS, runtime = {}, readCoverage = [] } = {}) {
  const catalogue = getAllITSMRules().map((r) => r.id).sort();
  const rules = [];
  const findings = [];
  const skipped = [];
  const degraded = [];
  const seen = new Map();

  for (const id of catalogue) {
    const classification = classifyRule(id, { configs, parameters, runtime });
    const res = run.results.get(id);
    if (!res) {
      /* A slot the run did not produce is reported as such, never dropped. */
      rules.push({
        rule_id: id, slot: getITSMRule(id).slot, title: getITSMRule(id).rule, group: getITSMRule(id).group, engine: configs.get(id)?.engine ?? null,
        base_severity: getITSMRule(id).base_severity, classification: classification.classification, implemented: classification.implemented,
        executable: classification.executable, configured: classification.configured, status: 'not_run', verdict: null, evaluated: false, empty_population_evidence: false,
        blocker: { kind: 'not_run', reason: 'the runner produced no result for this slot' }, scope: { partial: false }, confidence: null, findings: 0,
        kpis: [], parameters: {}, unresolved_parameters: classification.unresolved_parameters, dependencies: [], variants: [], evidence_missing: [],
        reason: 'the runner produced no result for this slot', error: null, ms: null,
      });
      skipped.push({ rule: id, table: null, reason: 'the runner produced no result for this slot', status: 'not_run', blocker_kind: 'not_run', source: 'itsm_catalogue' });
      continue;
    }
    const row = normalizeOne(id, res, classification, run.timing?.[id]);
    const deps = configs.get(id)?.config?.inputs ?? getITSMRule(id).architecture?.dependencies?.consumes_output_of ?? [];
    row.dependencies = deps.map((d) => {
      const r = run.results.get(d);
      return { rule_id: d, status: r?.status ?? 'not_run', verdict: r?.verdict ?? null, confidence: r ? minConfidence(r.findings || []) : null };
    });
    rules.push(row);

    if (!row.evaluated) {
      skipped.push({ rule: id, table: tableOf(res), reason: row.reason, status: row.status, blocker_kind: row.blocker?.kind ?? null, source: 'itsm_catalogue' });
    } else {
      /* A variant that could not run inside an evaluated rule is still something that did not run. */
      for (const sk of res.skipped || []) {
        if (!sk?.reason) continue;
        skipped.push({ rule: id, table: typeof sk.table === 'string' ? sk.table : null, reason: String(sk.reason), status: 'evaluated', variant: sk.variant ?? null, blocker_kind: null, ...(sk.undetermined ? { undetermined: sk.undetermined } : {}), source: 'itsm_catalogue' });
      }
    }

    /*
     * DEGRADED means a read this rule depended on FAILED, exactly as it means for
     * a CMDB table: a failure status on the rule's own coverage, or a capability
     * probe that could not get an answer. It does NOT mean "not evaluated": an
     * object the workbook leaves undefined (UNKNOWN by design), an empty choice
     * list or a field the release lacks are stable facts, and a result built on
     * them is as reusable as any other. (The first version counted every UNKNOWN
     * and every read-kind blocker, and would never have let ITSM be reused.)
     */
    for (const why of transientFailures(res)) degraded.push(`${id}: ${why}`);

    for (const f of res.findings || []) {
      if (seen.has(f.fingerprint)) {
        /*
         * TWO VARIANTS, ONE FINGERPRINT. A record fingerprint is rule | table |
         * records (findings.js), so two variants of one rule that flag the same
         * record collide — measured on the estate fixture: ITSM-065 flags one
         * incident once for an empty assigned_to and once for an empty
         * assignment_group. Storage and the finding lifecycle key on the
         * fingerprint, so it stays ONE finding; nothing of the second is dropped:
         * its detail is kept beside the first and its evidence rows are merged.
         */
        const kept = seen.get(f.fingerprint);
        /* how many runner findings this stored finding stands for — a merge always leaves this trace, even when the two were identical */
        kept.itsm.occurrences += 1;
        if (f.variant && !kept.itsm.variants.includes(f.variant)) kept.itsm.variants.push(f.variant);
        if (f.detail && JSON.stringify(f.detail) !== JSON.stringify(kept.detail)) {
          (kept.itsm.merged_details ||= []).push(f.detail);
        }
        const have = new Set(kept.evidence.map((e) => JSON.stringify(e)));
        for (const e of f.evidence || []) if (!have.has(JSON.stringify(e))) kept.evidence.push(e);
        continue;
      }
      const copy = {
        ...f,
        target_ids: [...(f.target_ids || [])],
        evidence: [...(f.evidence || [])],
        affected_ci_ids: [...(f.affected_ci_ids || [])],
        affected_service_ids: [...(f.affected_service_ids || [])],
        catalogue_group: row.group,
        itsm: {
          rule_id: id,
          slot: row.slot,
          engine: row.engine,
          group: row.group,
          classification: row.classification,
          verdict: row.verdict,
          scope: row.scope,
          parameters_used: row.parameters,
          variants: f.variant ? [f.variant] : [],
          occurrences: 1,
        },
      };
      seen.set(f.fingerprint, copy);
      findings.push(copy);
    }
  }

  /*
   * EVERY READ THE RUN MADE, not only the ones a result summarised. Measured on
   * the estate fixture: a refused bounded cmdb_rel_ci read reaches ITSM-130 only
   * as a graph coverage of `limited` (the engine summarises its per-node reads),
   * so the rule is correctly UNAVAILABLE but its result no longer says a read
   * FAILED. The per-run read cache still holds the real status.
   */
  for (const c of readCoverage) {
    if (c && FAILED_READ.has(c.status)) degraded.push(`${c.table}${c.query ? ` (${String(c.query).slice(0, 80)})` : ''}: ${c.status}`);
  }
  return { findings, rules, skipped, degraded: [...new Set(degraded)], aggregation: aggregateITSMRules(rules, findings) };
}

/** A pass over an EMPTY population the workbook declares determinate (the one exception to "nothing judged is not health"). */
const determinateEmpty = (r) => Boolean(r.population?.determinate_when_empty) && r.population.total === 0;

const tally = (xs, key, vocabulary = []) => {
  const out = Object.fromEntries(vocabulary.map((v) => [v, 0]));
  for (const x of xs) { const k = key(x); out[k] = (out[k] || 0) + 1; }
  return out;
};

/* ══ STANDALONE vs INTEGRATED (Phase 5 closure) ═══════════════════════════ */

/** The fields of a result the two paths must agree on, in one comparable shape. */
const paramsShape = (p) => Object.fromEntries(Object.entries(p || {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { value: v?.value ?? null, source: v?.source ?? null, status: v?.status ?? null }]));
const popShape = (p) => (p ? { total: p.total ?? null, judged: p.judged ?? null } : null);
const evidenceSet = (fs) => [...new Set(fs.flatMap((f) => (f.evidence || []).map((e) => JSON.stringify(e))))].sort();
const fingerprintsCollide = (res) => new Set(res.findings.map((f) => f.fingerprint)).size < res.findings.length;

/** Fields a live instance can move between two runs minutes apart — the only ones `population_moved` may explain. */
const DATA_FIELDS = new Set(['verdict', 'finding_count', 'stored_findings', 'confidence', 'fingerprints', 'evidence', 'population', 'undetermined']);

/**
 * Which evidence FIELDS differ between two finding sets, row for row (table |
 * record | field) — field names only, never values — and whether rows were
 * added or removed rather than changed.
 */
function evidenceFieldDiff(a, b) {
  const index = (fs) => {
    const m = new Map();
    for (const f of fs) for (const e of f.evidence || []) {
      const k = `${e.sn_table}|${e.sn_sys_id}|${e.field_name}`;
      if (!m.has(k)) m.set(k, new Set());
      m.get(k).add(JSON.stringify(e));
    }
    return m;
  };
  const A = index(a); const B = index(b);
  const fields = new Set(); let rows_added_or_removed = 0;
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const x = A.get(k); const y = B.get(k);
    if (!x || !y) { rows_added_or_removed += 1; continue; }
    if (JSON.stringify([...x].sort()) !== JSON.stringify([...y].sort())) fields.add(k.split('|').slice(2).join('|'));
  }
  return { fields_changed: [...fields].sort(), rows_added_or_removed };
}

/**
 * Compare the runner run on its own with what the Health Checker produced for
 * the same rules: presence, status, verdict, blocker, finding count, stored
 * findings, fingerprints, evidence rows, confidence, population, why nothing
 * was established, parameters used, and every dependency's status and verdict.
 *
 * A difference is EXPLAINED only by a named mechanism, with its evidence:
 *   fingerprint_merge   two findings of one rule share a fingerprint (variants
 *                       flagging the same record); integration stores ONE with
 *                       the other's detail and evidence merged — the stored
 *                       count is lower, and nothing else moves
 *   population_moved    (`live: true` only) the rule's own population total
 *                       differs between the two runs, so the instance changed
 *                       between them; it explains data-derived fields only
 *   records_updated     (`live: true` only) a table the rule read has records
 *                       updated AFTER the standalone run started and no later
 *                       than the stamp was taken (`changes`: change stamps
 *                       taken after both runs; a future-dated value is not
 *                       evidence) — an update that moves no count, e.g. an
 *                       evidence field such as sys_updated_on; data-derived
 *                       fields only
 * Anything else is UNEXPECTED.
 *
 * Returns `{ summary: { compared, catalogue, matching, different, explained, unexpected, line }, rows }`.
 */
export function reconcileStandalone(standalone, { rules, findings = [], configs = ITSM_RULE_CONFIGS, live = false, changes = [], standaloneStartedAt = null } = {}) {
  const byRule = new Map();
  for (const f of findings) {
    const id = f.itsm?.rule_id;
    if (!id) continue;
    if (!byRule.has(id)) byRule.set(id, []);
    byRule.get(id).push(f);
  }
  const catalogue = getAllITSMRules().map((r) => r.id);
  const seen = new Set();
  const rows = [];
  for (const row of rules) {
    seen.add(row.rule_id);
    const s = standalone.results.get(row.rule_id);
    const stored = byRule.get(row.rule_id) || [];
    const differences = [];
    const cmp = (field, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) differences.push({ field, standalone: a, integrated: b }); };
    if (!s) {
      differences.push({ field: 'presence', standalone: null, integrated: row.status });
    } else {
      const u = !s.findings.length ? undeterminedOf(s) : null;
      cmp('status', s.status, row.status);
      cmp('verdict', s.verdict ?? null, row.verdict ?? null);
      cmp('blocker', s.blocker?.kind ?? null, row.blocker?.kind ?? null);
      cmp('finding_count', s.findings.length, row.findings);
      cmp('stored_findings', s.findings.length, stored.length);
      cmp('fingerprints', [...new Set(s.findings.map((f) => f.fingerprint))].sort(), [...new Set(stored.map((f) => f.fingerprint))].sort());
      cmp('evidence', evidenceSet(s.findings), evidenceSet(stored));
      const ev = differences.find((d) => d.field === 'evidence');
      if (ev) Object.assign(ev, evidenceFieldDiff(s.findings, stored));
      cmp('confidence', minConfidence(s.findings), row.confidence ?? null);
      cmp('population', popShape(s.population), popShape(row.population));
      cmp('undetermined', u?.kind ?? null, row.undetermined?.kind ?? null);
      cmp('parameters', paramsShape(s.explanation?.parameters_used), paramsShape(row.parameters));
      const deps = configs.get(row.rule_id)?.config?.inputs ?? getITSMRule(row.rule_id).architecture?.dependencies?.consumes_output_of ?? [];
      cmp('dependencies', deps.map((d) => [d, standalone.results.get(d)?.status ?? 'not_run', standalone.results.get(d)?.verdict ?? null]), (row.dependencies || []).map((d) => [d.rule_id, d.status, d.verdict ?? null]));
    }
    const explained = [];
    let open = [...differences];
    const count = open.find((d) => d.field === 'stored_findings');
    if (s && count && fingerprintsCollide(s) && count.integrated === new Set(s.findings.map((f) => f.fingerprint)).size) {
      explained.push({
        mechanism: 'fingerprint_merge', fields: ['stored_findings'],
        evidence: `${s.findings.length} findings share ${count.integrated} fingerprint(s); stored once with the other variant's detail and evidence merged`,
        fingerprints: stored.filter((f) => (f.itsm?.occurrences ?? 1) > 1).map((f) => ({ fingerprint: f.fingerprint, occurrences: f.itsm.occurrences, merged_details: f.itsm.merged_details?.length ?? 0 })),
      });
      open = open.filter((d) => d !== count);
    }
    if (live && s && open.length && (s.population?.total ?? null) !== (row.population?.total ?? null) && open.every((d) => DATA_FIELDS.has(d.field))) {
      explained.push({ mechanism: 'population_moved', fields: open.map((d) => d.field), evidence: `population total ${s.population?.total ?? 'n/a'} (standalone) vs ${row.population?.total ?? 'n/a'} (integrated): the instance changed between the runs` });
      open = [];
    }
    if (live && s && open.length && standaloneStartedAt && open.every((d) => DATA_FIELDS.has(d.field))) {
      const start = new Date(standaloneStartedAt).getTime();
      const read = new Set((s.coverage || []).map((c) => c?.table).filter(Boolean));
      const updated = changes.filter((c) => {
        const at = fromSnowTime(c.max_updated)?.getTime();
        const taken = new Date(c.taken_at).getTime();
        return read.has(c.table) && Number.isFinite(at) && at > start && at <= taken;
      });
      if (updated.length) {
        explained.push({ mechanism: 'records_updated', fields: open.map((d) => d.field), evidence: `${updated.map((c) => `${c.table} records updated at ${c.max_updated}`).join('; ')} — after the standalone run started (${new Date(start).toISOString()}), before the stamp (${updated[0].taken_at})`, tables: updated.map((c) => c.table) });
        open = [];
      }
    }
    rows.push({ rule_id: row.rule_id, matching: differences.length === 0, differences, explained, unexpected: open });
  }
  for (const id of catalogue) {
    if (seen.has(id)) continue;
    const missing = { field: 'presence', standalone: standalone.results.get(id)?.status ?? null, integrated: null };
    rows.push({ rule_id: id, matching: false, differences: [missing], explained: [], unexpected: [missing] });
  }
  rows.sort((a, b) => a.rule_id.localeCompare(b.rule_id));
  const summary = {
    compared: rows.filter((r) => !r.differences.some((d) => d.field === 'presence')).length,
    catalogue: catalogue.length,
    matching: rows.filter((r) => r.matching).length,
    different: rows.filter((r) => !r.matching).length,
    explained: rows.filter((r) => !r.matching && !r.unexpected.length).length,
    unexpected: rows.filter((r) => r.unexpected.length).length,
  };
  summary.line = `${summary.compared} / ${summary.catalogue} compared, Matching ${summary.matching}, Different ${summary.different}, Explained ${summary.explained}, Unexpected ${summary.unexpected}`;
  return { summary, rows };
}

/**
 * STAGE 5D — what the run did, counted. Deterministic (sorted ids, fixed
 * vocabularies with zeros) and informational: nothing here is a score.
 */
export function aggregateITSMRules(rules, findings) {
  const ids = rules.map((r) => r.rule_id);
  const catalogue = getAllITSMRules().map((r) => r.id).sort();
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort();
  const missing = catalogue.filter((id) => !ids.includes(id));
  const blocked = {};
  for (const r of rules) {
    if (r.evaluated) continue;
    const k = r.blocker?.kind ?? 'unknown';
    (blocked[k] ||= []).push(r.rule_id);
  }
  for (const k of Object.keys(blocked)) blocked[k].sort();
  const undetermined = {};
  for (const r of rules) if (r.undetermined) (undetermined[r.undetermined.kind] ||= []).push(r.rule_id);
  for (const k of Object.keys(undetermined)) undetermined[k].sort();
  return {
    rules: rules.length,
    reconciliation: { catalogue: catalogue.length, rows: rules.length, complete: !duplicates.length && !missing.length && rules.length === catalogue.length, duplicates, missing },
    by_classification: tally(rules, (r) => r.classification, Object.values(CLASSIFICATION)),
    by_status: tally(rules, (r) => r.status, RUN_STATUSES),
    by_verdict: tally(rules.filter((r) => r.evaluated), (r) => r.verdict ?? 'none', ['pass', 'fail', 'inconclusive']),
    executable: rules.filter((r) => r.executable).length,
    configured: rules.filter((r) => r.configured).length,
    evaluated: rules.filter((r) => r.evaluated).length,
    findings: findings.length,
    findings_by_severity: tally(findings, (f) => f.severity, SEVERITY_BANDS),
    rules_with_findings: rules.filter((r) => r.findings > 0).map((r) => r.rule_id).sort(),
    blocked_by_kind: Object.fromEntries(Object.entries(blocked).sort(([a], [b]) => a.localeCompare(b))),
    unconfigured_parameters: rules.filter((r) => r.status === STATUS.UNCONFIGURED && r.blocker?.kind === 'unconfigured_parameter')
      .map((r) => ({ rule_id: r.rule_id, keys: [...(r.blocker.parameters || [])], workbook_text: r.blocker.workbook_text ?? null })),
    specification_gaps: rules.filter((r) => r.blocker?.kind === 'specification_gap').map((r) => r.rule_id),
    errors: rules.filter((r) => r.status === STATUS.ERROR).map((r) => ({ rule_id: r.rule_id, reason: r.reason })),
    /* Evaluated, no finding, nothing established — by why (engines/result.js UNDETERMINED). */
    undetermined_by_kind: Object.fromEntries(Object.entries(undetermined).sort(([a], [b]) => a.localeCompare(b))),
    population_empty: rules.filter((r) => r.population_empty).map((r) => r.rule_id).sort(),
    /*
     * The cross-check: passes whose own kpis / reads, or declared population, show
     * nothing judged. Must be empty. A pass the workbook itself makes determinate
     * over an empty configuration population (engines/result.js
     * `determinate_when_empty`) is not "missed" — it is listed on its own line so
     * it is seen, never folded into a clean-looking total.
     */
    passes_over_empty_population: rules.filter((r) => r.verdict === 'pass' && !determinateEmpty(r) && (r.empty_population_evidence || (r.population && !r.population.judged))).map((r) => r.rule_id),
    passes_determinate_when_empty: rules.filter((r) => r.verdict === 'pass' && determinateEmpty(r)).map((r) => ({ rule_id: r.rule_id, reading: r.population.determinate_when_empty })),
  };
}

/* ══ CONFIGURATION (Stage 5F) ═══════════════════════════════════════════════ */

/**
 * The registry a scan resolves with: the Phase 4 declarations plus THIS
 * instance's stored overrides. Built fresh per scan — the application-wide
 * `ITSM_PARAMETERS` is never mutated — and handed to both the evaluation
 * context and `itsmEngineKey()`, so an override change invalidates the ITSM
 * result (DECISIONS.md §4, §8). An override the declarations refuse (an
 * undeclared key, a wrong type) is NOT applied and is reported, never guessed at.
 */
export function buildParameterRegistry(overrides = []) {
  const registry = loadParameterDeclarations(new ParameterRegistry({ version: ITSM_PARAMETERS.version }));
  const applied = [];
  const rejected = [];
  for (const o of overrides) {
    try {
      registry.setInstanceOverride(o.rule_id, o.key, o.value);
      applied.push({ rule_id: o.rule_id, key: o.key, value: o.value });
    } catch (err) {
      rejected.push({ rule_id: o.rule_id, key: o.key, value: o.value, reason: err.message });
    }
  }
  return { registry, applied, rejected };
}

/**
 * Validate runtime overrides (`{ 'ITSM-nnn': { key: value } }`) before a scan
 * uses them: every rule must exist and every value must resolve against its
 * declaration. Returns the list of problems (empty when valid).
 */
export function validateRuntimeParameters(runtime, registry = ITSM_PARAMETERS) {
  if (runtime == null) return [];
  if (!isObj(runtime)) return ['itsmParameters must be an object of { "ITSM-nnn": { key: value } }'];
  const problems = [];
  for (const [rule, values] of Object.entries(runtime)) {
    if (!isObj(values)) { problems.push(`${rule}: overrides must be an object of { key: value }`); continue; }
    try {
      const declared = new Set(registry.definitionsFor(rule).map((d) => d.key));
      for (const k of Object.keys(values)) if (!declared.has(k)) problems.push(`${rule}.${k} is not a declared parameter`);
      registry.resolve(rule, { runtime: values });
    } catch (err) {
      problems.push(err.message);
    }
  }
  return problems;
}

/**
 * Every declared parameter with how it resolves under `registry`, and whether
 * it is what keeps its rule UNCONFIGURED — what a configuration screen (or an
 * API caller) needs to fill the gaps. Nothing is suggested for an UNDEFINED value.
 */
export function describeParameters(registry = ITSM_PARAMETERS, { configs = ITSM_RULE_CONFIGS } = {}) {
  const out = [];
  for (const id of getAllITSMRules().map((r) => r.id).sort()) {
    const referenced = configs.get(id) ? parameterKeysOf(configs.get(id).config) : new Set();
    const resolved = registry.resolve(id);
    for (const def of registry.definitionsFor(id)) {
      const r = resolved.parameters[def.key];
      out.push({
        rule_id: id,
        key: def.key,
        type: def.type,
        unit: def.unit,
        declaration: def.status,           // DEFINED (the workbook gives a default) | UNDEFINED
        workbook_default: def.default,
        value: r.value,
        source: r.source,                  // workbook | instance | null (runtime overrides are per run)
        status: r.status,                  // RESOLVED | UNCONFIGURED
        referenced_by_rule: referenced.has(def.key),
        blocks_rule: r.status === PARAMETER_STATUS.UNCONFIGURED && referenced.has(def.key),
        workbook_text: def.workbook_text,
      });
    }
  }
  return out;
}

/* ══ PERFORMANCE (Stage 5G) — measured, never assumed ═══════════════════════ */

/**
 * A client that counts every request the catalogue makes, by kind and table.
 * It changes nothing about the request; it exists so a scan can say where its
 * ITSM time went (Phase 4 measured 426 requests in 158 s on its validation
 * instance, 73 of them row reads of a 105-row change_request).
 */
export function countingClient(client) {
  const calls = { query: 0, count: 0, aggregate: 0, countBy: 0, changeStamp: 0, by_table: {} };
  const wrapped = { ...client };
  for (const name of ['query', 'count', 'aggregate', 'countBy', 'changeStamp']) {
    if (typeof client?.[name] !== 'function') continue;
    wrapped[name] = (t, ...args) => {
      calls[name] += 1;
      const row = (calls.by_table[t] ||= { query: 0, count: 0, aggregate: 0, countBy: 0, changeStamp: 0 });
      row[name] += 1;
      return client[name](t, ...args);
    };
  }
  return { client: wrapped, calls };
}

/** The ITSM part of a scan, measured: requests, caches, rows read per table, time per engine and the slowest rules. */
export function itsmPerformance({ run, rules, calls, readCoverage = [], readRequirements = 0, probeCache = null, cacheStats = null }) {
  const byEngine = {};
  for (const r of rules) {
    const e = (byEngine[r.engine ?? 'none'] ||= { rules: 0, ms: 0, evaluated: 0, findings: 0 });
    e.rules += 1; e.ms += r.ms || 0; if (r.evaluated) e.evaluated += 1; e.findings += r.findings;
  }
  const rowsByTable = {};
  for (const c of readCoverage) {
    if (!c || !['rows', 'ids'].includes(c.strategy)) continue;
    const t = (rowsByTable[c.table] ||= { reads: 0, rows_fetched: 0, largest_total: 0 });
    t.reads += 1; t.rows_fetched += c.rowsFetched || 0; t.largest_total = Math.max(t.largest_total, c.totalKnown || 0);
  }
  const requests = calls ? calls.query + calls.count + calls.aggregate + calls.countBy : null;
  return {
    elapsed_ms: run.elapsed_ms,
    requests: calls ? { total: requests, query: calls.query, count: calls.count, aggregate: calls.aggregate + calls.countBy, stamp: calls.changeStamp } : null,
    requests_by_table: calls ? Object.fromEntries(Object.entries(calls.by_table).sort(([a], [b]) => a.localeCompare(b))) : null,
    read_cache: { distinct_requirements: readRequirements, cached_reads: run.cached_reads ?? null },
    probe_cache: probeCache,
    /* hits = asked again and served without a request; misses = distinct questions that went to the instance */
    cache: cacheStats,
    rows_by_table: Object.fromEntries(Object.entries(rowsByTable).sort(([, a], [, b]) => b.rows_fetched - a.rows_fetched)),
    by_engine: Object.fromEntries(Object.entries(byEngine).sort(([, a], [, b]) => b.ms - a.ms)),
    slowest_rules: [...rules].filter((r) => r.ms != null).sort((a, b) => b.ms - a.ms).slice(0, 10).map((r) => ({ rule_id: r.rule_id, engine: r.engine, ms: r.ms, status: r.status })),
  };
}
