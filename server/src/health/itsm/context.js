import { table as instanceClient } from '../../servicenow/client.js';
import { createRunContext } from './run-context.js';
import { createReadCache } from './data-access.js';
import { createProbes } from './capability.js';
import { ITSM_PARAMETERS } from './parameters.js';

/**
 * ITSM PHASE 3 — the evaluation context every engine receives.
 *
 * One object, built once per run, carrying the things a rule must NOT create
 * for itself: the run's single time anchor, the instance client, the per-run
 * read cache (so two rules declaring the same read cost one request), the
 * capability probes (cached), the parameter registry, and a scratch space
 * for engine-built structures that other engines reuse (the relationship
 * graph, the CI×time index, resolved group memberships, rule results).
 *
 * `client` is injectable for the offline suite; the default is the one funnel
 * every read in this app goes through.
 */
export function createEvaluationContext({
  client = instanceClient, now = new Date(), timezone = 'UTC', runId = null,
  parameters = ITSM_PARAMETERS, signal = null, runtimeParameters = {}, measureHistory = {},
} = {}) {
  const run = createRunContext({ now, timezone, runId });
  const reads = createReadCache({ client, signal });
  const probes = createProbes({ client });
  const shared = new Map();
  const results = new Map();     // rule id → evaluation result (the composite engine's cache)
  return Object.freeze({
    run,
    client,
    signal,
    reads,
    probes,
    parameters,
    runtimeParameters,
    /** Earlier runs' measures, keyed as the engines record them — the trend rules' only memory. */
    measureHistory,
    /** Resolve a rule's parameters through the registry with this run's overrides. */
    parametersFor: (ruleId) => parameters.resolve(ruleId, { runtime: runtimeParameters[ruleId] || {} }),
    /** Build-once structures shared between engines, keyed by name. */
    shared: {
      get: (key) => shared.get(key),
      has: (key) => shared.has(key),
      async getOrBuild(key, build) {
        if (!shared.has(key)) shared.set(key, await build());
        return shared.get(key);
      },
      keys: () => [...shared.keys()],
    },
    results,
    cancelled: () => Boolean(signal?.aborted),
  });
}
