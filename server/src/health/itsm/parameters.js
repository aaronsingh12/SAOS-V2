import crypto from 'node:crypto';
import { getITSMRule, hasITSMRule } from './catalogue.js';
import parametersJson from '../rules/itsm/parameters.json' with { type: 'json' };

/**
 * ITSM PHASE 3 — the threshold / parameter registry.
 *
 *   rule ─► definitions (workbook default, or UNDEFINED)
 *        ─► instance overrides (this ServiceNow instance)
 *        ─► runtime overrides (this run)
 *        ─► resolved parameters ─► engine
 *
 * Every workbook threshold is "configurable, with a default". About forty
 * rules state the default ("Default 70% in one band. Window default 90 days.");
 * roughly thirty say only "configurable" and give none. The registry keeps
 * that distinction as a STATUS rather than papering over it: a parameter whose
 * definition carries no default resolves to UNCONFIGURED unless an override
 * supplies a value, and an engine that receives an UNCONFIGURED parameter must
 * skip the rule with that reason — never run it with a guessed number
 * (DECISION 3).
 *
 * WHAT IS DECLARED: every catalogue rule, from `rules/itsm/parameters.json`
 * (loaded by `loadParameterDeclarations` below) — a typed declaration per workbook threshold, with the default only
 * where the workbook states one, and an explicit "parameterless" declaration
 * for rules that need none ("Any occurrence"). Resolving an undeclared rule
 * answers UNCONFIGURED with reason `undeclared` and the workbook's own
 * threshold sentence, so a missing declaration is visible, never silent.
 *
 * THE FINGERPRINT is the registry's contribution to the ITSM engine key (see
 * engine-key.js): definitions + instance overrides, hashed. A changed default
 * or override moves the key and forces a re-read, exactly as `staleDays`
 * already does in `incremental.engineKeys`. Runtime overrides are per run and
 * are NOT part of the key — a run that overrides a parameter is a one-off and
 * must not become the baseline other runs are compared against; the resolved
 * set is recorded on the run instead.
 */

export const PARAMETER_TYPES = Object.freeze(['number', 'percent', 'duration', 'string', 'list', 'boolean']);
/**
 * DECISION 3 — the EXTERNAL vocabulary is two words: a parameter is RESOLVED
 * (a value exists, from any layer) or UNCONFIGURED (it does not, and the rule
 * cannot execute). WHY it is unconfigured is kept as an internal `reason`,
 * because the two causes are fixed by different people: `undefined_default`
 * (declared; the workbook gives no default; an instance override is needed)
 * and `undeclared` (no declaration has been transcribed yet — a build gap).
 * Neither reason is ever a value, and neither ever lets a rule run.
 */
export const PARAMETER_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  UNCONFIGURED: 'UNCONFIGURED',
});
export const UNCONFIGURED_REASONS = Object.freeze({
  UNDEFINED_DEFAULT: 'undefined_default',   // declared, workbook gives no default, nothing overrides it
  UNDECLARED: 'undeclared',                 // no declaration exists for this rule/key
});
/** Declaration statuses: does the workbook give a default or not. */
export const DECLARATION_STATUS = Object.freeze({ DEFINED: 'DEFINED', UNDEFINED: 'UNDEFINED' });
export const PARAMETER_SOURCES = Object.freeze(['workbook', 'instance', 'runtime']);

export class ParameterError extends Error {
  constructor(message, detail = null) { super(message); this.name = 'ParameterError'; this.detail = detail; }
}

const isDurationUnit = (u) => ['seconds', 'minutes', 'hours', 'days', 'months'].includes(u);

function checkValue(def, value, where) {
  if (value === undefined) return;
  const fail = (why) => { throw new ParameterError(`${def.rule}.${def.key} (${where}): ${why}`, { def, value }); };
  switch (def.type) {
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) fail('not a finite number'); break;
    case 'percent': if (typeof value !== 'number' || value < 0 || value > 100) fail('not a percentage 0–100'); break;
    case 'duration': if (typeof value !== 'number' || value < 0) fail('not a non-negative duration'); break;
    case 'string': if (typeof value !== 'string') fail('not a string'); break;
    case 'list': if (!Array.isArray(value)) fail('not a list'); break;
    case 'boolean': if (typeof value !== 'boolean') fail('not a boolean'); break;
    default: fail(`unknown type ${def.type}`);
  }
}

export class ParameterRegistry {
  constructor({ version = '1.0.0', ruleExists = hasITSMRule, workbookTextFor = (id) => getITSMRule(id).threshold_parameter } = {}) {
    this.version = version;
    this.definitions = new Map();      // `${rule}.${key}` → definition
    this.declaredRules = new Set();    // rules whose declaration exists, even with no parameters ("Any occurrence")
    this.instance = new Map();         // `${rule}.${key}` → value
    this.ruleExists = ruleExists;
    this.workbookTextFor = workbookTextFor;
    this._fingerprint = null;
  }

  /**
   * Declare one parameter. `default: null` with `status: 'UNDEFINED'` is the
   * honest declaration for "configurable, no default"; a declaration with a
   * default must say where it came from (`workbook_text`).
   */
  define({ rule, key, type, unit = null, default: dflt = null, status = null, description = null, workbook_text = null }) {
    if (!this.ruleExists(rule)) throw new ParameterError(`${rule} is not a catalogue rule`);
    if (!/^[a-z][a-z0-9_]*$/.test(String(key))) throw new ParameterError(`parameter key "${key}" must be snake_case`);
    if (!PARAMETER_TYPES.includes(type)) throw new ParameterError(`${rule}.${key}: type "${type}" is not one of ${PARAMETER_TYPES.join(', ')}`);
    if (type === 'duration' && !isDurationUnit(unit)) throw new ParameterError(`${rule}.${key}: a duration needs a unit (seconds/minutes/hours/days/months)`);
    const id = `${rule}.${key}`;
    if (this.definitions.has(id)) throw new ParameterError(`${id} is already declared`);
    const resolvedStatus = status ?? (dflt === null ? DECLARATION_STATUS.UNDEFINED : DECLARATION_STATUS.DEFINED);
    if (resolvedStatus === DECLARATION_STATUS.DEFINED && dflt === null) throw new ParameterError(`${id}: DEFINED with no default`);
    if (resolvedStatus === DECLARATION_STATUS.UNDEFINED && dflt !== null) throw new ParameterError(`${id}: UNDEFINED but a default was given — either it has one or it does not`);
    const def = Object.freeze({ rule, key, type, unit, default: dflt, status: resolvedStatus, description, workbook_text });
    checkValue(def, dflt === null ? undefined : dflt, 'default');
    this.definitions.set(id, def);
    this.declaredRules.add(rule);
    this._fingerprint = null;
    return def;
  }

  /**
   * Declare a rule that needs NO parameters ("Any occurrence", "Active
   * membership resolved live"). Distinct from never having looked: a rule
   * declared parameterless resolves RESOLVED with an empty set.
   */
  declareParameterless(rule, { workbook_text = null } = {}) {
    if (!this.ruleExists(rule)) throw new ParameterError(`${rule} is not a catalogue rule`);
    this.declaredRules.add(rule);
    this._fingerprint = null;
    return Object.freeze({ rule, parameterless: true, workbook_text });
  }

  isDeclared(rule) { return this.declaredRules.has(rule); }

  /** Declarations for one rule, in declaration order. */
  definitionsFor(rule) {
    return [...this.definitions.values()].filter((d) => d.rule === rule);
  }

  /** An instance-level override: this ServiceNow instance's chosen value. Part of the engine key. */
  setInstanceOverride(rule, key, value) {
    const id = `${rule}.${key}`;
    const def = this.definitions.get(id);
    if (!def) throw new ParameterError(`${id} is not declared; an override cannot invent a parameter`);
    checkValue(def, value, 'instance override');
    this.instance.set(id, value);
    this._fingerprint = null;
  }

  clearInstanceOverride(rule, key) {
    this.instance.delete(`${rule}.${key}`);
    this._fingerprint = null;
  }

  /**
   * Resolve every parameter of a rule through the three layers.
   *
   * Returns `{ rule, parameters: { key → { value, source, status, definition } },
   * unresolved: [keys], declared: bool, workbook_text }`. An UNDEFINED
   * parameter has `value: null`; the caller decides what that means (an
   * engine skips; a UI shows the gap).
   */
  resolve(rule, { runtime = {} } = {}) {
    if (!this.ruleExists(rule)) throw new ParameterError(`${rule} is not a catalogue rule`);
    const defs = this.definitionsFor(rule);
    const workbookText = this.workbookTextFor(rule);
    if (!defs.length && !this.declaredRules.has(rule)) {
      /* No declaration at all — a build gap, and externally the same answer as any other missing value. */
      return Object.freeze({ rule, declared: false, parameters: Object.freeze({}), unresolved: Object.freeze([]), status: PARAMETER_STATUS.UNCONFIGURED, reason: UNCONFIGURED_REASONS.UNDECLARED, workbook_text: workbookText });
    }
    const parameters = {};
    const unresolved = [];
    for (const def of defs) {
      const id = `${def.rule}.${def.key}`;
      let value; let source;
      if (runtime[def.key] !== undefined) {
        checkValue(def, runtime[def.key], 'runtime override');
        value = runtime[def.key]; source = 'runtime';
      } else if (this.instance.has(id)) {
        value = this.instance.get(id); source = 'instance';
      } else if (def.default !== null) {
        value = def.default; source = 'workbook';
      } else {
        value = null; source = null; unresolved.push(def.key);
      }
      parameters[def.key] = Object.freeze({
        value, source, unit: def.unit, type: def.type,
        status: value === null ? PARAMETER_STATUS.UNCONFIGURED : PARAMETER_STATUS.RESOLVED,
        reason: value === null ? UNCONFIGURED_REASONS.UNDEFINED_DEFAULT : null,
        definition: def,
      });
    }
    return Object.freeze({
      rule, declared: true, parameters: Object.freeze(parameters), unresolved: Object.freeze(unresolved),
      status: unresolved.length ? PARAMETER_STATUS.UNCONFIGURED : PARAMETER_STATUS.RESOLVED,
      reason: unresolved.length ? UNCONFIGURED_REASONS.UNDEFINED_DEFAULT : null,
      workbook_text: workbookText,
    });
  }

  /**
   * The registry's identity for the engine key: version, every declaration and
   * every instance override, in a canonical order. Cached until anything
   * changes.
   */
  fingerprint() {
    if (this._fingerprint) return this._fingerprint;
    const defs = [...this.definitions.keys()].sort().map((id) => {
      const d = this.definitions.get(id);
      return [id, d.type, d.unit, d.default, d.status];
    });
    const overrides = [...this.instance.keys()].sort().map((id) => [id, this.instance.get(id)]);
    const parameterless = [...this.declaredRules].filter((r) => !this.definitionsFor(r).length).sort();
    this._fingerprint = crypto.createHash('sha256')
      .update(JSON.stringify({ version: this.version, defs, overrides, parameterless }))
      .digest('hex').slice(0, 16);
    return this._fingerprint;
  }

  /** Everything, for the run manifest: what this run resolved with. */
  snapshot() {
    return {
      version: this.version,
      fingerprint: this.fingerprint(),
      declared: this.definitions.size,
      declared_rules: this.declaredRules.size,
      overrides: Object.fromEntries([...this.instance.entries()]),
    };
  }
}

/**
 * Load `rules/itsm/parameters.json` into a registry: every rule's typed
 * declarations, or its explicit parameterless declaration. Pure over the
 * document, so the suite can load a doctored one; it refuses a document that
 * names a rule the catalogue does not have, gives a DEFINED parameter no
 * default, or gives an UNDEFINED one a value.
 */
export function loadParameterDeclarations(registry, doc = parametersJson) {
  if (!doc || typeof doc !== 'object' || !doc.declarations) throw new ParameterError('parameters.json has no declarations');
  for (const [rule, d] of Object.entries(doc.declarations)) {
    if (!Array.isArray(d.parameters)) throw new ParameterError(`${rule}: parameters must be a list`);
    if (!d.parameters.length) { registry.declareParameterless(rule, { workbook_text: d.workbook_text ?? null }); continue; }
    for (const q of d.parameters) {
      registry.define({ rule, key: q.key, type: q.type, unit: q.unit ?? null, default: q.default ?? null, status: q.status ?? null, description: q.description ?? null, workbook_text: d.workbook_text ?? null });
    }
  }
  return registry;
}

/**
 * The application's ITSM registry, loaded from the Phase 4 declarations.
 * Tests build their own instances rather than mutating this one.
 */
export const ITSM_PARAMETERS = loadParameterDeclarations(new ParameterRegistry({ version: parametersJson.version ?? '1.0.0' }));
