import crypto from 'node:crypto';
import { getITSMRule, hasITSMRule, getAllITSMRules } from '../catalogue.js';
import { ENGINE_KEYS } from '../registry.js';
import { ITSM_PARAMETERS } from '../parameters.js';
import { validateRuleConfig, referencedParameters, RESERVED_KEYS } from '../rule-config.js';
import { PLACEHOLDERS, isVerified } from '../engines/configuration.js';
import recordPredicate from './record-predicate.json' with { type: 'json' };
import aggregate from './aggregate.json' with { type: 'json' };
import referenceIntegrity from './reference-integrity.json' with { type: 'json' };
import linkage from './linkage.json' with { type: 'json' };
import configuration from './configuration.json' with { type: 'json' };
import relationshipGraph from './relationship-graph.json' with { type: 'json' };
import temporalCorrelation from './temporal-correlation.json' with { type: 'json' };
import auditHistory from './audit-history.json' with { type: 'json' };
import textAnalysis from './text-analysis.json' with { type: 'json' };
import composite from './composite.json' with { type: 'json' };

/**
 * ITSM PHASE 4 — the rule configurations, one JSON file per engine.
 *
 * A file is `{ engine, rules: { "ITSM-nnn": config } }`. A rule appears in
 * exactly one file — the file of the engine that evaluates it, which is the
 * architecture map's primary engine unless the config says `engine:` and
 * that engine is one the map lists under `also_requires` (or, for a
 * composite, the rule consumes other rules' output). Every reference to a
 * parameter must be a declared parameter of that rule; every object in
 * `requires_objects` must be a known placeholder. All of this is checked once
 * at load, so a misconfigured rule fails the suite, never a run.
 *
 * What a config MAY say, besides its engine's own keys:
 *   engine                   the evaluating engine (see above)
 *   requires_objects         placeholder objects the runner resolves through the
 *                            DECISION 5 pipeline before anything is read
 *   requires_tables          tables named by the workbook but not verified by
 *                            the map — discovered, schema-checked, then read
 *   undefined_dependencies   what the rule needs that neither the workbook nor
 *                            DECISIONS.md defines — the rule is UNAVAILABLE
 *   variants                 a list of partial configs, each merged over the
 *                            base and evaluated in turn (the workbook's "report
 *                            the two cases separately")
 *   notes / scope_note       prose for the status matrix, never read by an engine
 */

const FILES = Object.freeze([recordPredicate, aggregate, referenceIntegrity, linkage, configuration, relationshipGraph, temporalCorrelation, auditHistory, textAnalysis, composite]);

export class RuleFileError extends Error {
  constructor(message, detail = null) { super(message); this.name = 'RuleFileError'; this.detail = detail; }
}

/** May `engineKey` evaluate `rule`? Primary, supporting, or composite-over-inputs. */
export function engineAllowedFor(rule, engineKey) {
  const a = rule.architecture;
  if (a.engine === engineKey) return true;
  if ((a.also_requires || []).includes(engineKey)) return true;
  if (engineKey === 'composite' && (a.dependencies?.consumes_output_of || []).length) return true;
  return false;
}

/** Validate every file and build `id → { engine, config, file_engine }`. Pure over `files`, so the suite can feed a doctored set. */
export function loadRuleConfigs(files = FILES, { parameters = ITSM_PARAMETERS } = {}) {
  const out = new Map();
  for (const file of files) {
    if (!file || !ENGINE_KEYS.includes(file.engine)) throw new RuleFileError(`rule file names no registered engine (${file?.engine})`);
    for (const [id, raw] of Object.entries(file.rules || {})) {
      if (!hasITSMRule(id)) throw new RuleFileError(`${file.engine}.json: ${id} is not a catalogue rule`);
      if (out.has(id)) throw new RuleFileError(`${id} is configured twice (${out.get(id).file_engine} and ${file.engine})`);
      validateRuleConfig(id, raw, { engineKeys: ENGINE_KEYS });
      const rule = getITSMRule(id);
      const engine = raw.engine ?? file.engine;
      if (engine !== file.engine && raw.engine === undefined) throw new RuleFileError(`${id}: in ${file.engine}.json but evaluated by ${engine}`);
      if (!engineAllowedFor(rule, engine)) throw new RuleFileError(`${id}: engine ${engine} is neither its primary (${rule.architecture.engine}) nor in also_requires (${(rule.architecture.also_requires || []).join(', ') || 'none'})`);
      if (raw.engine !== undefined && raw.engine !== file.engine) throw new RuleFileError(`${id}: says engine ${raw.engine} but sits in ${file.engine}.json`);
      const declared = new Set(parameters.definitionsFor(id).map((d) => d.key));
      for (const k of referencedParameters(raw)) if (!declared.has(k)) throw new RuleFileError(`${id}: references parameter "${k}", which is not declared for it (declared: ${[...declared].join(', ') || 'none'})`);
      for (const o of raw.requires_objects || []) if (!PLACEHOLDERS[o] && !isVerified(o)) throw new RuleFileError(`${id}: requires_objects names "${o}", which is neither a placeholder nor a verified object`);
      for (const v of raw.variants || []) validateRuleConfig(`${id} variant`, { ...raw, ...v, variants: undefined }, { engineKeys: ENGINE_KEYS });
      out.set(id, Object.freeze({ id, engine, file_engine: file.engine, config: raw }));
    }
  }
  return out;
}

export const ITSM_RULE_CONFIGS = loadRuleConfigs();

export const ruleConfigFor = (id) => ITSM_RULE_CONFIGS.get(id) ?? null;
export const configuredRuleIds = () => [...ITSM_RULE_CONFIGS.keys()].sort();
export const unconfiguredRuleIds = () => getAllITSMRules().map((r) => r.id).filter((id) => !ITSM_RULE_CONFIGS.has(id));

/** The configuration set's identity for the engine key: every rule's config, canonical JSON, hashed. */
export function ruleConfigFingerprint(configs = ITSM_RULE_CONFIGS) {
  const entries = [...configs.keys()].sort().map((id) => [id, configs.get(id).engine, configs.get(id).config]);
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

/** The dependency edges the runner will honour: config `inputs` first, else the map's consumes_output_of. */
export function dependencyEdges(configs = ITSM_RULE_CONFIGS) {
  const edges = {};
  for (const [id, entry] of configs) {
    const deps = entry.config.inputs ?? getITSMRule(id).architecture.dependencies?.consumes_output_of ?? [];
    if (deps.length) edges[id] = [...deps].sort();
  }
  return edges;
}

export const CONFIG_RESERVED_KEYS = RESERVED_KEYS;
