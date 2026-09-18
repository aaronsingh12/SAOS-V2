import { getITSMRule } from './catalogue.js';
import { adaptRule } from './adapter.js';
import { getEngine } from './registry.js';
import { ITSM_RULE_CONFIGS } from './rules/index.js';
import { compileRuleConfig, resolveParameters, referencedParameters, RESERVED_KEYS, RuleConfigError } from './rule-config.js';
import { readConfiguration } from './engines/configuration.js';
import { runOrdered } from './engines/composite.js';
import { result, STATUS, notePopulation, withhold, undeterminedOf } from './engines/result.js';
import { CAPABILITY } from './capability.js';
import { PARAMETER_STATUS } from './parameters.js';
import { declareRequirement } from './data-access.js';

/**
 * ITSM PHASE 4 — the runner: catalogue rules → engines, through their
 * declarative configurations, in dependency order.
 *
 * For every requested rule (plus whatever it consumes):
 *
 *   1. undefined_dependencies  → UNAVAILABLE, naming what is undefined
 *   2. requires_objects        → DECISION 5 pipeline (candidate → discovery →
 *                                schema → capability); anything short of a
 *                                usable object → UNAVAILABLE with the step
 *   3. requires_tables         → the same pipeline for a workbook-named table
 *                                the map did not verify
 *   4. $choice references      → resolved from the instance's sys_choice by
 *                                label (DECISION 5 / 10: no hard-coded values);
 *                                an unmatched label → UNAVAILABLE
 *   5. $window references      → rendered from the run anchor and the rule's
 *                                own duration parameter
 *   6. $param references       → DECISION 4 precedence; any UNCONFIGURED
 *                                parameter → UNCONFIGURED, naming the keys
 *   7. the engine's prepare + evaluate, per variant, merged
 *
 * A thrown error inside an engine is caught and recorded as `error` — one
 * broken rule never takes the run down, and never passes.
 *
 * EVERY non-evaluated result carries a machine-readable `blocker`
 * (`{ kind, ...detail }`, kinds in BLOCKER_KINDS) beside the human reason, and
 * every result carries a `verdict`:
 *
 *   fail          evaluated with at least one finding
 *   pass          evaluated, no finding, and the configuration covers the
 *                 whole detection the workbook states
 *   inconclusive  evaluated, no finding, but the configuration declares a
 *                 `partial` scope whose uncovered half could hide an offender —
 *                 never presented as a pass
 *                 — or (Phase 5 closure) the population it judged was empty,
 *                 nothing in it could be judged, or the judgement was withheld
 *                 (below minimum volume, too little history, an input that
 *                 established nothing): engines/result.js `undeterminedOf`
 *   null          not evaluated (see `blocker`)
 *
 * Nothing in here is keyed on a rule id.
 */

export const BLOCKER_KINDS = Object.freeze([
  'undefined_object',        // requires_objects: the placeholder object is not usable on this instance (pipeline step in detail)
  'undefined_table',         // requires_tables: a workbook-named table is not usable on this instance
  'undefined_dependency',    // undefined_dependencies: something neither the workbook nor DECISIONS.md defines
  'specification_gap',       // specification_gap: the workbook does not say enough to evaluate deterministically
  'unconfigured_parameter',  // a referenced parameter has no value (DECISION 3 / 4)
  'instance_value',          // a $choice label is not on this instance's choice list
  'capability',              // an engine capability probe failed (field, table, audit)
  'read',                    // a read the evaluation depended on failed or was incomplete
  'input',                   // a composite input was not evaluated
  'error',                   // an engine fault
]);

export const VERDICTS = Object.freeze(['pass', 'fail', 'inconclusive']);

export class RunnerError extends Error {
  constructor(message, detail = null) { super(message); this.name = 'RunnerError'; this.detail = detail; }
}

const skipResult = (rule, engineKey, status, reason, extra = {}) => {
  const out = result(rule, engineKey, { parameters: extra.parameters ?? null });
  out.status = status;
  out.skipped.push({ rule: rule.id, table: extra.table ?? null, reason, ...(extra.capability ? { capability: extra.capability } : {}), ...(extra.parameter ? { parameter: extra.parameter } : {}) });
  if (extra.coverage) out.coverage.push(...extra.coverage);
  if (extra.blocker) out.blocker = Object.freeze({ ...extra.blocker, reason });
  return out;
};

/** Derive a blocker for an engine-produced non-evaluated result that did not set one. */
function inferBlocker(res) {
  if (res.status === STATUS.EVALUATED || res.blocker) return res.blocker ?? null;
  const first = res.skipped[0] || {};
  if (res.status === STATUS.ERROR) return { kind: 'error', reason: first.reason };
  if (res.status === STATUS.UNCONFIGURED) return { kind: 'unconfigured_parameter', parameters: first.parameter ? first.parameter.split(',') : [], reason: first.reason };
  if (res.status === STATUS.SKIPPED && /^input /.test(first.reason || '')) return { kind: 'input', reason: first.reason };
  if (first.capability) return { kind: 'capability', state: first.capability, table: first.table ?? null, reason: first.reason };
  return { kind: 'read', table: first.table ?? null, reason: first.reason };
}

/**
 * The verdict, from the status, the findings and the declared scope. A rule
 * whose configuration covers only part of the workbook's detection
 * (`partial.kind === 'detection_gap'`) can FAIL (an offender was found) but
 * never PASS — "no finding" over half a detection is inconclusive.
 */
function verdictOf(res, partial) {
  if (res.status !== STATUS.EVALUATED) return null;
  if (res.findings.length) return 'fail';
  if (partial?.kind === 'detection_gap') return 'inconclusive';
  if ((res.variants || []).some((v) => v.status !== STATUS.EVALUATED)) return 'inconclusive';
  /* EMPTY POPULATION (Phase 5 closure): "no offender" over nothing judged is not health. */
  if (undeterminedOf(res)) return 'inconclusive';
  return 'pass';
}

/** What a user asking "why was this flagged / not flagged?" needs, in one object. */
function explain(res, rule) {
  const params = res.parameters?.parameters ? Object.fromEntries(Object.entries(res.parameters.parameters).map(([k, v]) => [k, { value: v.value, unit: v.unit, source: v.source, status: v.status }])) : {};
  return Object.freeze({
    rule_id: rule.id, slot: rule.slot, title: rule.title, engine: res.engine, status: res.status, verdict: res.verdict ?? null,
    blocker: res.blocker ?? null, scope: res.scope ?? null,
    parameters_used: params, findings: res.findings.length, kpis: res.kpis.map((k) => ({ numerator: k.numerator, denominator: k.denominator, pass_pct: k.pass_pct, basis: k.basis, complete: k.complete ?? null, variant: k.variant ?? null })),
    reasons: res.skipped.map((x) => x.reason), confidence: res.findings.length ? Math.min(...res.findings.map((f) => f.confidence ?? 1)) : null,
    population: res.population ? { ...res.population } : null,
    population_empty: res.undetermined?.kind === 'empty_population',
    undetermined: res.undetermined ? { ...res.undetermined } : null,
  });
}

/* ── reference rendering that needs the instance or the run ─────────────── */

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

async function walkAsync(node, fn) {
  const r = await fn(node);
  if (r !== undefined) return r;
  if (Array.isArray(node)) return Promise.all(node.map((x) => walkAsync(x, fn)));
  if (isObj(node)) { const out = {}; for (const [k, v] of Object.entries(node)) out[k] = await walkAsync(v, fn); return out; }
  return node;
}

/** `table` and its ancestors (`sys_db_object.super_class`), bounded, for choice-list lookups on inherited fields. */
async function tableChain(ctx, table) {
  const chain = [table];
  for (let i = 0; i < 6; i++) {
    const r = await ctx.reads.read(declareRequirement({ table: 'sys_db_object', fields: ['name', 'super_class.name'], query: `name=${chain[chain.length - 1]}`, strategy: 'rows', maxRows: 2 }));
    const parent = r.rows[0]?.['super_class.name'];
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
  }
  return chain;
}

/**
 * `{ "$choice": { table, element, label } }` → the instance's value for that
 * label, from the table that defines the field (walking super classes).
 * Reads each choice list once per run.
 */
async function resolveChoices(config, ctx) {
  const problems = []; const coverage = [];
  const out = await walkAsync(config, async (node) => {
    if (!isObj(node) || !isObj(node.$choice)) return undefined;
    const { table, element, label } = node.$choice;
    if (!table || !element || !label) throw new RuleConfigError(`$choice needs table, element and label (${JSON.stringify(node.$choice)})`);
    /* A field inherited from task / cmdb_ci keeps its choice list under the DEFINING table: walk the super-class chain until one answers. */
    const chain = await ctx.shared.getOrBuild(`table_chain:${table}`, () => tableChain(ctx, table));
    let cfg = null; let owner = null;
    for (const t of chain) {
      const c = await ctx.shared.getOrBuild(`choices:${t}:${element}`, () => readConfiguration(ctx, 'sys_choice', { table: t, element, includeInactive: false }));
      if (c.coverage) coverage.push(c.coverage);
      if (c.status !== 'ok') { cfg = c; break; }
      if (c.rows.length) { cfg = c; owner = t; break; }
      cfg = c;
    }
    if (cfg.status !== 'ok') { problems.push(`choice list ${table}.${element} could not be read (${cfg.reason ?? cfg.status})`); return null; }
    if (!owner) { problems.push(`${table}.${element}: no choice list on this instance (looked at ${chain.join(' → ')})`); return null; }
    const hit = cfg.rows.filter((c) => String(c.label ?? '').trim().toLowerCase() === String(label).trim().toLowerCase());
    if (hit.length !== 1) { problems.push(`${owner}.${element}: ${hit.length === 0 ? 'no' : hit.length} choice(s) labelled "${label}" — the value cannot be taken from this instance`); return null; }
    return String(hit[0].value);
  });
  return { config: out, problems, coverage };
}

/**
 * `{ "$window": { param | spec, field, edge } }` → an encoded-query clause on
 * the run anchor: `older_than` → `field<start`, `within` → `field>=start`.
 */
function resolveWindows(config, ctx, params) {
  const missing = [];
  const walk = (node) => {
    if (isObj(node) && isObj(node.$now)) {
      const { field, op } = node.$now;
      if (!field || !['<', '<=', '>', '>='].includes(op)) throw new RuleConfigError(`$now needs a field and an op (< <= > >=)`);
      return `${field}${op}${ctx.run.now_snow ?? ctx.run.window('1 seconds').end_snow}`;
    }
    if (isObj(node) && isObj(node.$window)) {
      const w = node.$window;
      let spec = w.spec ?? null;
      if (w.param) {
        const p = params.parameters?.[w.param];
        if (!p) { missing.push(`${w.param} (not declared)`); return null; }
        if (p.status !== PARAMETER_STATUS.RESOLVED) { missing.push(w.param); return null; }
        spec = `${p.value} ${p.unit}`;
      }
      if (!spec || !w.field) throw new RuleConfigError(`$window needs a field and a param or spec (${JSON.stringify(w)})`);
      const win = ctx.run.window(spec);
      if (w.edge === 'older_than') return `${w.field}<${win.start_snow}`;
      if (w.edge === 'within') return `${w.field}>=${win.start_snow}`;
      throw new RuleConfigError(`$window edge must be older_than or within (${w.edge})`);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (isObj(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  return { config: walk(config), missing: [...new Set(missing)] };
}

/** A $clause node — { template: 'close_code={}', value } — becomes the clause once its value (a $choice, a $param) is concrete. */
function renderClauses(node) {
  if (Array.isArray(node)) return node.map(renderClauses);
  if (!isObj(node)) return node;
  if (isObj(node.$clause)) {
    const { template, value } = node.$clause;
    if (typeof template !== 'string' || !template.includes('{}')) throw new RuleConfigError('$clause needs a template containing {}');
    if (value === null || value === undefined) return null;
    return template.replace('{}', Array.isArray(value) ? value.join(',') : String(value));
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, renderClauses(v)]));
}

const CLAUSE_KEYS = new Set(['scope', 'query', 'numerator_query', 'denominator_query']);
/** A query written as a list of clauses (strings, rendered $window clauses) becomes one encoded query. */
function joinClauses(node) {
  if (Array.isArray(node)) return node.map(joinClauses);
  if (!isObj(node)) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = CLAUSE_KEYS.has(k) && Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).join('^') : joinClauses(v);
  }
  return out;
}

/* ── the field gate ─────────────────────────────────────────────────────── */

const QUERY_FIELD = /^(?:OR|NQ)?([a-z0-9_]+(?:\.[a-z0-9_]+)*)(?:=|!=|IN|NOT IN|ISEMPTY|ISNOTEMPTY|ISEMPTYSTRING|<=|>=|<|>|LIKE|NOT LIKE|STARTSWITH|ENDSWITH|ANYTHING|SAMEAS|NSAMEAS|BETWEEN|DYNAMIC|ON|NOTON|RELATIVE|GT_FIELD|LT_FIELD|EQ_FIELD|NE_FIELD)/;
const baseField = (f) => String(f).split('.')[0];

/** Field names an encoded query reads (base field of any dotted path); ORDERBY clauses are not fields. */
export function queryFields(query) {
  const out = new Set();
  for (const clause of String(query || '').split('^')) {
    if (!clause || clause.startsWith('ORDERBY')) continue;
    const m = QUERY_FIELD.exec(clause);
    if (m) out.add(baseField(m[1]));
  }
  return [...out];
}

const FIELD_KEYS = ['field', 'field2', 'ci_field', 'key_field', 'time_field', 'start_field', 'end_field', 'text_field', 'block_field', 'require_no_link', 'length_field'];
const QUERY_KEYS = ['scope', 'query', 'numerator_query', 'denominator_query', 'population_query'];

/**
 * Every (table → fields) a rendered configuration reads, split into the fields
 * the DETECTION depends on and the fields only shown as evidence. A query on
 * a field the instance lacks silently matches every row on the platform, so
 * a detection field that is missing is UNAVAILABLE (capability); a missing
 * evidence field is merely recorded.
 */
export function collectFieldRequirements(config) {
  const need = new Map();
  const add = (table, fields, kind) => {
    if (!table || typeof table !== 'string') return;
    if (!need.has(table)) need.set(table, { required: new Set(), evidence: new Set() });
    for (const f of fields) if (typeof f === 'string' && f && !f.startsWith('$')) need.get(table)[kind].add(baseField(f));
  };
  const walk = (node, table, side = false) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x, table, side); return; }
    const t = typeof node.table === 'string' ? node.table : table;
    for (const k of FIELD_KEYS) if (typeof node[k] === 'string') add(t, [node[k]], 'required');
    for (const k of QUERY_KEYS) if (typeof node[k] === 'string') add(t, queryFields(node[k]), 'required');
    /* a side's `fields` (left/right/from/to) are carried for evidence; a root `fields` list (text operations) is what is analysed */
    if (Array.isArray(node.fields)) add(t, node.fields, side ? 'evidence' : 'required');
    if (Array.isArray(node.evidence_fields)) add(t, node.evidence_fields, 'evidence');
    if (Array.isArray(node.predicates)) for (const pr of node.predicates) add(t, [pr.field, pr.field2].filter(Boolean), 'required');
    if (typeof node.target === 'string') add(node.target, [node.state_field, node.active_field].filter(Boolean), 'required');
    if (node.link?.kind === 'reference' && typeof node.link.field === 'string') add(node.link.direction === 'inbound' ? node.to?.table : node.from?.table, [node.link.field], 'required');
    if (node.link?.kind === 'm2m' && node.link.m2m) add(node.link.m2m.table, [node.link.m2m.from_field, node.link.m2m.to_field].filter(Boolean), 'required');
    for (const [k, v] of Object.entries(node)) {
      if (['left', 'right', 'from', 'to'].includes(k) && v && typeof v === 'object') walk(v, v.table ?? t, true);
      else if (typeof v === 'object' && !['link', 'args', 'compare', 'combine', 'expand_keys', 'patterns'].includes(k)) walk(v, t, side);
    }
  };
  walk(config, null);
  return need;
}

async function fieldGate(rule, engineKey, ctx, config) {
  const need = collectFieldRequirements(config);
  const evidenceMissing = [];
  for (const [table, { required, evidence }] of need) {
    if (required.size) {
      const v = await ctx.probes.fieldsExist(table, [...required].sort());
      if (v.state !== CAPABILITY.AVAILABLE) {
        return { gate: skipResult(rule, engineKey, STATUS.UNAVAILABLE, `capability ${v.state}: ${v.reason}`, { table, capability: v.state, parameters: ctx.parametersFor(rule.id), blocker: { kind: 'capability', table, fields: v.missing ?? [...required], state: v.state } }) };
      }
    }
    const ev = [...evidence].filter((f) => !required.has(f));
    if (ev.length) {
      const v = await ctx.probes.fieldsExist(table, ev.sort());
      if (v.state !== CAPABILITY.AVAILABLE) evidenceMissing.push(...(v.missing ?? ev).map((f) => `${table}.${f}`));
    }
  }
  return { gate: null, evidenceMissing };
}

/* ── the DECISION 5 gates ───────────────────────────────────────────────── */

async function objectGate(rule, engineKey, ctx, names, expectedFields = {}) {
  for (const name of names) {
    const cfg = await readConfiguration(ctx, name, { expected_fields: expectedFields[name] });
    if (cfg.status === 'ok') continue;
    const stepName = cfg.status === 'unsupported' ? 'reader' : cfg.resolution_step;
    const step = stepName ? ` [stopped at: ${stepName}]` : '';
    return skipResult(rule, engineKey, STATUS.UNAVAILABLE, `object "${name}" is not usable on this instance${step}: ${cfg.reason}`, { table: cfg.candidate_table ?? null, capability: cfg.candidate_state ?? CAPABILITY.UNAVAILABLE, parameters: ctx.parametersFor(rule.id), blocker: { kind: 'undefined_object', object: name, candidate_table: cfg.candidate_table ?? null, step: cfg.status === 'unsupported' ? 'reader' : (cfg.resolution_step ?? null), state: cfg.candidate_state ?? null } });
  }
  return null;
}

async function tableGate(rule, engineKey, ctx, tables) {
  for (const t of tables) {
    const { table, fields } = t;
    if (!table || !fields?.length) throw new RuleConfigError('requires_tables entries are { table, fields[] } — the fields are what the schema is verified against');
    const probe = await ctx.probes.configurationObject(table, { table, fields });
    if (probe.state === CAPABILITY.AVAILABLE) continue;
    return skipResult(rule, engineKey, STATUS.UNAVAILABLE, `table "${table}" is not usable on this instance${probe.step ? ` [stopped at: ${probe.step}]` : ''}: ${probe.reason}`, { table, capability: probe.state, parameters: ctx.parametersFor(rule.id), blocker: { kind: 'undefined_table', table, step: probe.step ?? null, state: probe.state } });
  }
  return null;
}

/* ── one rule ───────────────────────────────────────────────────────────── */

const bodyOf = (raw) => Object.fromEntries(Object.entries(raw).filter(([k]) => !RESERVED_KEYS.includes(k) && !['requires_tables', 'undefined_dependencies', 'specification_gap', 'partial', 'variants', 'scope_note', 'expected_fields'].includes(k)));
const hasBody = (raw) => Object.keys(bodyOf(raw)).length > 0;

function mergeVariants(rule, engineKey, results, labels) {
  if (results.length === 1) return results[0];
  const out = result(rule, engineKey, { parameters: results[0].parameters });
  const statuses = results.map((r) => r.status);
  out.variants = results.map((r, i) => ({ variant: labels[i], status: r.status, findings: r.findings.length, ...(r.status === STATUS.EVALUATED ? { population: r.population ?? null, undetermined: undeterminedOf(r) } : {}) }));
  for (const [i, r] of results.entries()) {
    out.findings.push(...r.findings);
    out.kpis.push(...r.kpis.map((k) => ({ ...k, variant: labels[i] })));
    out.skipped.push(...r.skipped.map((s) => ({ ...s, variant: labels[i] })));
    out.coverage.push(...r.coverage);
    Object.assign(out.measures, Object.fromEntries(Object.entries(r.measures || {}).map(([k, v]) => [`${k}[${labels[i]}]`, v])));
    if (r.capability) out.capability = r.capability;
  }
  /*
   * The rule's population is its variants' together; a variant that established
   * nothing leaves the whole rule undetermined (a pass needs every variant to
   * have judged something, as it needs every variant to have run).
   */
  const ev = results.map((r, i) => [r, labels[i]]).filter(([r]) => r.status === STATUS.EVALUATED);
  if (ev.length) {
    const pops = ev.map(([r]) => r.population);
    const known = (k) => (pops.every((p) => p && p[k] != null) ? pops.reduce((n, p) => n + p[k], 0) : null);
    const determinate = pops.every((p) => p?.determinate_when_empty) ? pops[0].determinate_when_empty : null;
    notePopulation(out, { total: known('total'), judged: known('judged'), unit: `${pops[0]?.unit ?? 'records'} (summed over variants)`, basis: ev.map(([r, l]) => `${l}: ${r.population?.judged ?? '?'} of ${r.population?.total ?? '?'}`).join('; '), determinate_when_empty: determinate });
    const withheldBy = ev.map(([r, l]) => [undeterminedOf(r), l]).find(([u]) => u);
    if (withheldBy) withhold(out, withheldBy[0].kind, `variant ${withheldBy[1]}: ${withheldBy[0].reason}`);
  }
  /* When no variant evaluated, the first variant's blocker is the rule's. */
  if (!statuses.includes(STATUS.EVALUATED)) out.blocker = results.find((r) => r.blocker)?.blocker ?? null;
  /* Evaluated if any variant evaluated; otherwise the worst non-evaluated status, so an all-blocked rule is not "evaluated". */
  out.status = statuses.includes(STATUS.EVALUATED) ? STATUS.EVALUATED : statuses.includes(STATUS.ERROR) ? STATUS.ERROR : statuses.includes(STATUS.UNAVAILABLE) ? STATUS.UNAVAILABLE : statuses.includes(STATUS.UNCONFIGURED) ? STATUS.UNCONFIGURED : statuses[0];
  return out;
}

/**
 * Evaluate one configured rule. `entry` is `{ id, engine, config }` from the
 * rule files; `runtime` is this run's parameter overrides for the rule.
 */
export async function evaluateConfiguredRule(entry, ctx) {
  const rule = adaptRule(getITSMRule(entry.id));
  const engineKey = entry.engine;
  const engine = getEngine(engineKey);
  const raw = entry.config;
  const params = ctx.parametersFor(rule.id);
  try {
    if (raw.undefined_dependencies?.length) {
      return finish(skipResult(rule, engineKey, STATUS.UNAVAILABLE, `UNDEFINED: ${raw.undefined_dependencies.join('; ')} — not in the workbook and not in DECISIONS.md; reported for explicit resolution`, { parameters: params, blocker: { kind: 'undefined_dependency', dependencies: raw.undefined_dependencies } }));
    }
    if (raw.specification_gap) {
      /* The workbook does not say enough to evaluate deterministically; no statistic or threshold is chosen for it. */
      return finish(skipResult(rule, engineKey, STATUS.UNCONFIGURED, `SPECIFICATION GAP: ${raw.specification_gap.missing} — reported for explicit resolution; nothing is assumed in its place`, { parameters: params, blocker: { kind: 'specification_gap', ...raw.specification_gap } }));
    }
    if (raw.requires_objects?.length) {
      const gate = await objectGate(rule, engineKey, ctx, raw.requires_objects, raw.expected_fields || {});
      if (gate) return finish(gate);
    }
    if (raw.requires_tables?.length) {
      const gate = await tableGate(rule, engineKey, ctx, raw.requires_tables);
      if (gate) return finish(gate);
    }
    if (!hasBody(raw)) {
      return finish(skipResult(rule, engineKey, STATUS.UNAVAILABLE, 'the objects this rule needs were confirmed, but no reader exists for them yet — the rule has no executable body', { parameters: params, blocker: { kind: 'undefined_object', objects: raw.requires_objects || [], step: 'reader' } }));
    }
    const variants = raw.variants?.length ? raw.variants : [null];
    const labels = variants.map((v, i) => v?.variant ?? v?.label ?? `variant ${i + 1}`);
    const results = [];
    for (const v of variants) {
      const merged = v ? { ...bodyOf(raw), ...Object.fromEntries(Object.entries(v).filter(([k]) => !['variant', 'label', 'requires_tables'].includes(k))) } : bodyOf(raw);
      if (v?.requires_tables?.length) {
        /* a variant may need its own table (blackout vs maintenance schedule classes) — the same pipeline, per variant */
        const gate = await tableGate(rule, engineKey, ctx, v.requires_tables);
        if (gate) { results.push(gate); continue; }
      }
      /* DECISION 4 first: an UNCONFIGURED parameter stops the variant before any instance read. */
      const resolved = resolveParameters(merged, params);
      const windows = resolved.missing.length ? { missing: resolved.missing } : resolveWindows(resolved.config, ctx, params);
      const missing = [...new Set([...resolved.missing, ...(windows.missing || [])])];
      if (missing.length) {
        results.push(skipResult(rule, engineKey, STATUS.UNCONFIGURED, `parameter ${missing.join(', ')} is UNCONFIGURED — the workbook gives no default and no instance override is set (workbook: "${params.workbook_text}")`, { parameter: missing.join(','), parameters: params, blocker: { kind: 'unconfigured_parameter', parameters: missing, workbook_text: params.workbook_text } }));
        continue;
      }
      const choices = await resolveChoices(windows.config, ctx);
      if (choices.problems.length) { results.push(skipResult(rule, engineKey, STATUS.UNAVAILABLE, choices.problems.join('; '), { table: 'sys_choice', capability: CAPABILITY.UNAVAILABLE, parameters: params, coverage: choices.coverage, blocker: { kind: 'instance_value', problems: choices.problems } })); continue; }
      const compiled = compileRuleConfig(engineKey, joinClauses(renderClauses(choices.config)), params);
      compiled.config.required_parameters = referencedParameters(merged);
      /* Every field the detection reads must exist on this instance — on every table it is read from. */
      const fields = await fieldGate(rule, engineKey, ctx, compiled.config);
      if (fields.gate) { results.push(fields.gate); continue; }
      await engine.prepare(ctx);
      const res = await engine.evaluate({ ...rule, config: compiled.config }, ctx);
      if (fields.evidenceMissing.length) res.evidence_missing = fields.evidenceMissing;
      results.push(res);
    }
    return finish(mergeVariants(rule, engineKey, results, labels));
  } catch (err) {
    const out = skipResult(rule, engineKey, STATUS.ERROR, `engine error: ${err.message}`, { parameters: params, blocker: { kind: 'error', name: err.name } });
    out.error = { name: err.name, message: err.message };
    return finish(out);
  }

  /* Every result leaves with a blocker (when not evaluated), a verdict, its declared scope and an explanation. */
  function finish(res) {
    res.blocker = inferBlocker(res);
    res.scope = raw.partial ? Object.freeze({ partial: true, kind: raw.partial.kind, not_covered: raw.partial.not_covered }) : Object.freeze({ partial: false });
    res.verdict = verdictOf(res, raw.partial);
    if (res.status === STATUS.EVALUATED && !res.findings.length) {
      /* An evaluated rule that established nothing says so, machine-readably, beside the verdict it got. */
      const u = undeterminedOf(res);
      if (u) {
        res.undetermined = Object.freeze({ ...u });
        res.skipped.push({ rule: rule.id, table: null, reason: `${u.reason} — health could not be established, so the verdict is ${res.verdict}, not pass`, undetermined: u.kind });
      }
    }
    res.explanation = explain(res, rule);
    return res;
  }
}

/* ── the run ────────────────────────────────────────────────────────────── */

/** A rule's inputs — none for a rule that is UNAVAILABLE by declaration (its inputs need not run for it). */
const depsOf = (id, entry) => (entry.config.undefined_dependencies?.length ? [] : (entry.config.inputs ?? getITSMRule(id).architecture.dependencies?.consumes_output_of ?? []));

/** The requested rules plus everything they consume, as runOrdered wants them. */
export function planRules(ruleIds, configs = ITSM_RULE_CONFIGS) {
  const wanted = new Set();
  const visit = (id) => {
    if (wanted.has(id)) return;
    const entry = configs.get(id);
    if (!entry) throw new RunnerError(`${id} has no rule configuration`);
    wanted.add(id);
    const deps = depsOf(id, entry, configs);
    for (const d of deps) if (configs.has(d)) visit(d);
  };
  for (const id of ruleIds) visit(id);
  return [...wanted].sort().map((id) => {
    const entry = configs.get(id);
    const deps = depsOf(id, entry, configs);
    return { id, dependsOn: deps.filter((d) => configs.has(d)), entry, missingInputs: deps.filter((d) => !configs.has(d)) };
  });
}

/**
 * Run configured rules through their engines in dependency order.
 * Returns `{ order, results: Map(id → result), summary, timing }`.
 */
export async function runITSMRules(ctx, { ruleIds = null, configs = ITSM_RULE_CONFIGS } = {}) {
  const ids = ruleIds ?? [...configs.keys()];
  const rules = planRules(ids, configs);
  const timing = {};
  const started = Date.now();
  const run = await runOrdered(rules, ctx, async (r) => {
    const t0 = Date.now();
    let res;
    if (r.missingInputs.length) res = skipResult(adaptRule(getITSMRule(r.id)), r.entry.engine, STATUS.NOT_CONFIGURED, `input ${r.missingInputs.join(', ')} has no rule configuration`, { blocker: { kind: 'input', missing: r.missingInputs } });
    else res = await evaluateConfiguredRule(r.entry, ctx);
    timing[r.id] = Date.now() - t0;
    return res;
  });
  const summary = {}; const verdicts = {};
  for (const res of run.results.values()) {
    summary[res.status] = (summary[res.status] || 0) + 1;
    /* A composite blocked by runOrdered (input not evaluated) never went through finish(); give it the same shape. */
    if (res.blocker === undefined) { res.blocker = inferBlocker(res); res.verdict = null; }
    verdicts[res.verdict ?? 'none'] = (verdicts[res.verdict ?? 'none'] || 0) + 1;
  }
  return { order: run.order, results: run.results, cache: run.cache, summary, verdicts, timing, elapsed_ms: Date.now() - started, cached_reads: ctx.reads.size?.() ?? null };
}
