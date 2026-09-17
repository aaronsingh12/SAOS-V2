import { PARAMETER_STATUS } from './parameters.js';
import { fromSnowTime, UNITS_MS } from './run-context.js';
import { COMPARATORS, COMBINATORS, EXPANDERS, OFFENDERS } from './comparators.js';

/**
 * ITSM PHASE 4 — declarative rule configuration.
 *
 * A catalogue rule is connected to its engine by DATA (`rules/*.json`), never
 * by a function keyed on its id. The engines take a handful of callbacks
 * (`of`, `numerator`, `state_test`, `offend`, `compare`, `combine`); this
 * module compiles small JSON expressions into those callbacks, and resolves
 * every `{ "$param": … }` reference through the parameter registry
 * (DECISIONS.md §4: workbook default → instance override → runtime override).
 *
 * EXPRESSIONS
 *
 *   selector    over one object (an aggregate group, a target row):
 *               { field, op, value } | { all: [...] } | { any: [...] } | { not: … }
 *               ops: equals not_equals in not_in empty not_empty truthy falsy gt gte lt lte
 *
 *   offend      over `{ derived, row, answer }` — the engine's derived value
 *               and the record it belongs to:
 *               { path: 'derived', op: 'gte', value: 2 } with the same
 *               combinators. `path` is dotted ('answer.found').
 *
 *   named       { name, args } → a function from comparators.js
 *               (configuration comparators, composite combinators, temporal
 *               key expanders).
 *
 *   $source     { "$source": "field" } as a selector value compares against the
 *               SOURCE row (linkage state tests: target vs source).
 *
 *   $param      { "$param": "key" } → the resolved value;
 *               { "$param": "key", "as": "window" } → "90 days" (value + unit)
 *               for engines that take a window spec;
 *               { "$param": "key", "as": "clause", "template": "closed_by={}" }
 *               → an encoded-query clause with the value (a list joins with ',').
 *
 * A config that references a parameter which resolves UNCONFIGURED compiles
 * to `{ status: 'unconfigured', missing: [...] }` and the rule does not run.
 * A config that names an object the instance must confirm first
 * (`requires_objects`) is handed to the resolution pipeline by the runner.
 */

export class RuleConfigError extends Error {
  constructor(message, detail = null) { super(message); this.name = 'RuleConfigError'; this.detail = detail; }
}

export const SELECTOR_OPS = Object.freeze(['equals', 'not_equals', 'in', 'not_in', 'empty', 'not_empty', 'truthy', 'falsy', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null', 'matches', 'interval_lt', 'interval_gt']);

const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function test(op, actual, expected) {
  switch (op) {
    case 'equals': return String(actual ?? '') === String(expected);
    case 'not_equals': return String(actual ?? '') !== String(expected);
    case 'in': return expected.map(String).includes(String(actual ?? ''));
    case 'not_in': return !expected.map(String).includes(String(actual ?? ''));
    case 'empty': return isEmpty(actual);
    case 'not_empty': return !isEmpty(actual);
    case 'truthy': return truthy(actual);
    case 'falsy': return !truthy(actual);
    case 'is_null': return actual === null || actual === undefined;
    case 'not_null': return actual !== null && actual !== undefined;
    case 'gt': { const a = num(actual); return a !== null && a > expected; }
    case 'gte': { const a = num(actual); return a !== null && a >= expected; }
    case 'lt': { const a = num(actual); return a !== null && a < expected; }
    case 'lte': { const a = num(actual); return a !== null && a <= expected; }
    case 'matches': return new RegExp(expected, 'i').test(String(actual ?? ''));
    default: throw new RuleConfigError(`unknown op ${op}`);
  }
}

const getPath = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Compile a selector expression into `(object) => boolean`. `key` names the property accessor ('field' or 'path'). */
export function compileExpression(expr, { key = 'field' } = {}) {
  if (typeof expr === 'function') return expr;
  if (!expr || typeof expr !== 'object') throw new RuleConfigError(`an expression must be an object, got ${JSON.stringify(expr)}`);
  if (Array.isArray(expr.all)) { const fs = expr.all.map((e) => compileExpression(e, { key })); return (o) => fs.every((f) => f(o)); }
  if (Array.isArray(expr.any)) { const fs = expr.any.map((e) => compileExpression(e, { key })); return (o) => fs.some((f) => f(o)); }
  if (expr.not) { const f = compileExpression(expr.not, { key }); return (o) => !f(o); }
  if (expr.always === true) return () => true;
  if (!SELECTOR_OPS.includes(expr.op)) throw new RuleConfigError(`op "${expr.op}" is not one of ${SELECTOR_OPS.join(', ')}`);
  const accessor = expr[key] ?? expr.field ?? expr.path;
  if (!accessor) throw new RuleConfigError(`expression ${JSON.stringify(expr)} names no ${key}`);
  if (['in', 'not_in'].includes(expr.op) && !Array.isArray(expr.value)) throw new RuleConfigError(`${expr.op} needs a list value`);
  if (['gt', 'gte', 'lt', 'lte'].includes(expr.op) && !Number.isFinite(expr.value)) throw new RuleConfigError(`${expr.op} needs a numeric value (got ${JSON.stringify(expr.value)})`);
  if (['equals', 'not_equals', 'matches'].includes(expr.op) && expr.value === undefined) throw new RuleConfigError(`${expr.op} needs a value`);
  if (['interval_lt', 'interval_gt'].includes(expr.op)) {
    /* field2 − field, in unit, against value; unparseable or missing times never satisfy the test */
    if (!expr.field2 || !Number.isFinite(expr.value) || !(expr.unit in UNITS_MS)) throw new RuleConfigError(`${expr.op} needs field2, a numeric value and a unit`);
    const limit = expr.value * UNITS_MS[expr.unit];
    return (o) => { const a = fromSnowTime(o?.[accessor]); const b = fromSnowTime(o?.[expr.field2]); if (!a || !b) return false; const d = b - a; return expr.op === 'interval_lt' ? d < limit : d > limit; };
  }
  if (expr.value && typeof expr.value === 'object' && !Array.isArray(expr.value) && typeof expr.value.$source === 'string') {
    /* compare against a field of the SOURCE row (linkage state tests receive (target, source)) */
    const srcField = expr.value.$source;
    return (o, src) => test(expr.op, key === 'path' ? getPath(o, accessor) : o?.[accessor], src?.[srcField]);
  }
  return (o) => test(expr.op, key === 'path' ? getPath(o, accessor) : o?.[accessor], expr.value);
}

/** A selector over a flat object (aggregate group / row). */
export const compileSelector = (expr) => compileExpression(expr, { key: 'field' });

/**
 * An offend test the engines call as `offend(derived, row)` (audit, graph:
 * `offend(answer, row)`). Compiled over `{ derived, answer, row }` so a path
 * can name any of the three.
 */
export function compileOffend(expr) {
  if (typeof expr === 'function') return expr;
  if (expr && typeof expr === 'object' && expr.name) return OFFENDERS[expr.name] ? OFFENDERS[expr.name](expr.args || {}) : (() => { throw new RuleConfigError(`unknown offender "${expr.name}"`); })();
  const f = compileExpression(expr, { key: 'path' });
  return (derived, row) => f({ derived, answer: derived, row });
}

/** A named function from the shared library, with its args. */
export function compileNamed(expr, library, what) {
  if (typeof expr === 'function') return expr;
  if (!expr || typeof expr !== 'object' || !expr.name) throw new RuleConfigError(`${what} must be { name, args }`);
  const make = library[expr.name];
  if (!make) throw new RuleConfigError(`${what} "${expr.name}" is not one of ${Object.keys(library).join(', ')}`);
  return make(expr.args || {});
}

/* ── parameter references ───────────────────────────────────────────────── */

const isRef = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.$param === 'string';

/** Every `$param` key a config references, in order of appearance. */
export function referencedParameters(node, acc = []) {
  if (isRef(node)) { if (!acc.includes(node.$param)) acc.push(node.$param); return acc; }
  if (Array.isArray(node)) { for (const x of node) referencedParameters(x, acc); return acc; }
  if (node && typeof node === 'object') { for (const x of Object.values(node)) referencedParameters(x, acc); }
  return acc;
}

/** Render one resolved parameter in the form a reference asks for. */
function renderParam(ref, param) {
  const { value, unit } = param;
  switch (ref.as) {
    case undefined: return value;
    case 'window': {
      if (!unit) throw new RuleConfigError(`$param ${ref.$param} as window needs a duration parameter (no unit)`);
      return `${value} ${unit}`;
    }
    case 'unit': return unit;
    case 'fraction': return value / 100;
    case 'string': return String(value);
    case 'clause': {
      if (typeof ref.template !== 'string' || !ref.template.includes('{}')) throw new RuleConfigError(` ${ref.$param} as clause needs a template containing {}`);
      return ref.template.replace('{}', Array.isArray(value) ? value.join(',') : String(value));
    }
    default: throw new RuleConfigError(`$param ${ref.$param}: unknown rendering "${ref.as}"`);
  }
}

/**
 * Substitute every `$param` reference with the resolved value. Returns
 * `{ config, missing }`; `missing` lists references whose parameter is not
 * RESOLVED — the config is then unusable and the caller reports UNCONFIGURED.
 */
export function resolveParameters(config, resolved) {
  const missing = [];
  const walk = (node) => {
    if (isRef(node)) {
      const p = resolved?.parameters?.[node.$param];
      if (!p) { missing.push(`${node.$param} (not declared)`); return undefined; }
      if (p.status !== PARAMETER_STATUS.RESOLVED) { missing.push(node.$param); return undefined; }
      return renderParam(node, p);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  const out = walk(config);
  return { config: out, missing: [...new Set(missing)] };
}

/* ── compilation per engine ─────────────────────────────────────────────── */

/** Which config keys hold which kind of expression, per engine. */
const CALLBACKS = Object.freeze({
  aggregate: { of: 'selector', numerator: 'selector', denominator: 'selector' },
  linkage: { state_test: 'selector' },
  relationship_graph: { offend: 'offend' },
  audit_history: { offend: 'offend' },
  configuration: { compare: 'comparator' },
  composite: { combine: 'combinator' },
  temporal_correlation: { expand_keys: 'expander' },
  record_predicate: {},
  reference_integrity: {},
  text_analysis: {},
});

export const RESERVED_KEYS = Object.freeze(['engine', 'requires_objects', 'notes', 'status_note']);
export const PARTIAL_KINDS = Object.freeze(['detection_gap', 'false_positive_risk', 'evidence_gap']);

/**
 * Validate the raw shape of one rule config (before parameters are known).
 * Cheap and pure, so the config test can sweep every file.
 */
export function validateRuleConfig(ruleId, raw, { engineKeys }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RuleConfigError(`${ruleId}: config must be an object`);
  if (raw.engine !== undefined && !engineKeys.includes(raw.engine)) throw new RuleConfigError(`${ruleId}: engine "${raw.engine}" is not registered`);
  if (raw.requires_objects !== undefined && !Array.isArray(raw.requires_objects)) throw new RuleConfigError(`${ruleId}: requires_objects must be a list`);
  for (const t of raw.requires_tables || []) if (!t || typeof t.table !== 'string' || !Array.isArray(t.fields) || !t.fields.length) throw new RuleConfigError(`${ruleId}: requires_tables entries are { table, fields[] }`);
  for (const v of raw.variants || []) for (const t of v.requires_tables || []) if (!t || typeof t.table !== 'string' || !Array.isArray(t.fields) || !t.fields.length) throw new RuleConfigError(`${ruleId}: variant requires_tables entries are { table, fields[] }`);
  for (const k of Object.keys(raw)) if (/^[A-Z]/.test(k)) throw new RuleConfigError(`${ruleId}: key "${k}" is not snake_case`);
  if (raw.partial !== undefined) {
    if (!raw.partial || !PARTIAL_KINDS.includes(raw.partial.kind) || typeof raw.partial.not_covered !== 'string' || !raw.partial.not_covered) throw new RuleConfigError(`${ruleId}: partial must be { kind: ${PARTIAL_KINDS.join(' | ')}, not_covered }`);
  }
  if (raw.specification_gap !== undefined && (typeof raw.specification_gap?.missing !== 'string' || !raw.specification_gap.missing)) throw new RuleConfigError(`${ruleId}: specification_gap must name what is missing`);
  if (raw.scope_note !== undefined) throw new RuleConfigError(`${ruleId}: scope_note is retired — declare partial { kind, not_covered } or notes`);
  const fnKeys = ['of', 'numerator', 'denominator', 'state_test', 'offend', 'compare', 'combine'];
  for (const k of fnKeys) if (typeof raw[k] === 'function') throw new RuleConfigError(`${ruleId}: "${k}" must be data, not a function`);
  return true;
}

/**
 * Compile one rule's raw config for its engine with the resolved parameters.
 * Returns `{ status: 'ok', config }` or `{ status: 'unconfigured', missing }`.
 */
export function compileRuleConfig(engineKey, raw, resolvedParameters) {
  const { config, missing } = resolveParameters(raw, resolvedParameters);
  if (missing.length) return { status: 'unconfigured', missing, config: null };
  const kinds = CALLBACKS[engineKey] || {};
  const out = { ...config };
  for (const [k, kind] of Object.entries(kinds)) {
    if (out[k] === undefined) continue;
    if (kind === 'selector') out[k] = compileSelector(out[k]);
    else if (kind === 'offend') out[k] = compileOffend(out[k]);
    else if (kind === 'comparator') out[k] = compileNamed(out[k], COMPARATORS, 'compare');
    else if (kind === 'combinator') out[k] = compileNamed(out[k], COMBINATORS, 'combine');
    else if (kind === 'expander') out[k] = typeof out[k] === 'function' ? out[k] : compileNamed(out[k], EXPANDERS, 'expand_keys');
  }
  out.required_parameters = referencedParameters(raw);
  return { status: 'ok', config: out, missing: [] };
}
