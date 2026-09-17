import { engine as recordPredicate } from './engines/record-predicate.js';
import { engine as aggregate } from './engines/aggregate.js';
import { engine as configuration } from './engines/configuration.js';
import { engine as referenceIntegrity } from './engines/reference-integrity.js';
import { engine as linkage } from './engines/linkage.js';
import { engine as relationshipGraph } from './engines/relationship-graph.js';
import { engine as auditHistory } from './engines/audit-history.js';
import { engine as textAnalysis } from './engines/text-analysis.js';
import { engine as temporalCorrelation } from './engines/temporal-correlation.js';
import { engine as composite } from './engines/composite.js';
import { getAllITSMRules, getITSMRule } from './catalogue.js';
import { adaptRule } from './adapter.js';
import { STATUS, notConfigured } from './engines/result.js';

/**
 * ITSM PHASE 3 — the engine registry.
 *
 * Ten engines, one per Phase 2 archetype, keyed by the map's engine key so a
 * rule's `architecture.engine` names its engine directly. Every engine
 * exposes the same contract:
 *
 *   key, name, version
 *   canEvaluate(rule)     the rule's architecture names this engine (primary or supporting)
 *   prepare(ctx)          build-once structures into ctx.shared (graph, resolver, indexes)
 *   evaluate(rule, ctx)   → { rule_id, engine, status, findings, kpis, skipped, coverage, measures, parameters, capability }
 *
 * `evaluate` on a rule with no `config` answers `not_configured` — the Phase 3
 * state of all 139 rules. `evaluateRule` below is the single entry point a
 * later phase calls; `configurationStatus()` is the audit of what is wired.
 */

export const ITSM_ENGINE_REGISTRY = Object.freeze({
  [recordPredicate.key]: recordPredicate,
  [aggregate.key]: aggregate,
  [configuration.key]: configuration,
  [referenceIntegrity.key]: referenceIntegrity,
  [linkage.key]: linkage,
  [relationshipGraph.key]: relationshipGraph,
  [auditHistory.key]: auditHistory,
  [textAnalysis.key]: textAnalysis,
  [temporalCorrelation.key]: temporalCorrelation,
  [composite.key]: composite,
});

export const ENGINE_KEYS = Object.freeze(Object.keys(ITSM_ENGINE_REGISTRY));
export const REGISTRY_VERSION = '1.0.0';

const REQUIRED_CONTRACT = Object.freeze(['key', 'name', 'version', 'canEvaluate', 'prepare', 'evaluate']);

export class RegistryError extends Error {
  constructor(message) { super(message); this.name = 'RegistryError'; }
}

/** Does every registered engine satisfy the contract? Thrown at import time would hide the reason; asserted by a test instead. */
export function validateRegistry(registry = ITSM_ENGINE_REGISTRY) {
  for (const [key, e] of Object.entries(registry)) {
    for (const k of REQUIRED_CONTRACT) if (!(k in e)) throw new RegistryError(`engine ${key} lacks ${k}`);
    if (e.key !== key) throw new RegistryError(`engine registered as ${key} calls itself ${e.key}`);
    for (const fn of ['canEvaluate', 'prepare', 'evaluate']) if (typeof e[fn] !== 'function') throw new RegistryError(`engine ${key}.${fn} is not a function`);
  }
  return true;
}

export function getEngine(key) {
  const e = ITSM_ENGINE_REGISTRY[key];
  if (!e) throw new RegistryError(`no engine "${key}" (${ENGINE_KEYS.join(', ')})`);
  return e;
}

/** The engine a rule's architecture names as primary. */
export function engineFor(rule) {
  return getEngine(rule.architecture.engine);
}

/**
 * Evaluate one catalogue rule through its engine. `config` is the Phase 4
 * engine configuration; without it the answer is `not_configured` and no
 * instance read happens — which is every rule, today.
 */
export async function evaluateRule(idOrRule, ctx, { config = null } = {}) {
  const adapted = typeof idOrRule === 'string' ? adaptRule(getITSMRule(idOrRule)) : idOrRule;
  const engine = engineFor(adapted);
  if (!engine.canEvaluate(adapted)) throw new RegistryError(`${engine.key} cannot evaluate ${adapted.id}`);
  const rule = config ? { ...adapted, config } : adapted;
  if (!rule.config) return notConfigured(rule, engine.key);
  await engine.prepare(ctx);
  return engine.evaluate(rule, ctx);
}

/**
 * What is wired: for every catalogue rule, its engine and whether a
 * configuration exists (`configs` is the Phase 4 map, empty today).
 */
export function configurationStatus(configs = {}) {
  const rules = getAllITSMRules().map((r) => ({
    rule_id: r.id, slot: r.slot, engine: r.architecture.engine,
    configured: Boolean(configs[r.id]), status: configs[r.id] ? 'configured' : STATUS.NOT_CONFIGURED,
  }));
  const byEngine = {};
  for (const r of rules) {
    byEngine[r.engine] ||= { total: 0, configured: 0 };
    byEngine[r.engine].total += 1;
    if (r.configured) byEngine[r.engine].configured += 1;
  }
  return { registry_version: REGISTRY_VERSION, engines: ENGINE_KEYS.length, rules: rules.length, configured: rules.filter((r) => r.configured).length, by_engine: byEngine, entries: rules };
}
