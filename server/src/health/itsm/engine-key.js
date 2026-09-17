import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getITSMCatalogueMeta } from './catalogue.js';
import { ITSM_PARAMETERS } from './parameters.js';
import { ITSM_RULE_CONFIGS, ruleConfigFingerprint, dependencyEdges } from './rules/index.js';
import { ITSM_ENGINE_REGISTRY, REGISTRY_VERSION } from './registry.js';

/**
 * ITSM PHASE 3 — the ITSM engine key, and how it joins the incremental check.
 *
 * `health/incremental.js engineKeys()` hashes, per module, the engine SOURCE
 * (`health/*.js` matching ENGINE_FILES, plus `health/catalogue/*.json`) with
 * `staleDays` and that module's accepted risks. A module's stored result is
 * reused only while its key is unchanged. That is how a rule edit or a changed
 * setting cannot silently reuse a stale result.
 *
 * None of the code under `health/itsm/` is inside that hash: `ENGINE_FILES`
 * matches only files directly under `health/`, and the ITSM catalogue lives
 * under `health/rules/itsm/`, not `health/catalogue/`.
 *
 * DECISION 8 — this key covers every result-affecting ITSM input, and
 * `incremental.engineKeys` folds it into the ITSM module's key ONLY:
 *
 *   - rule definitions: the catalogue version and workbook hash, the
 *     architecture map version
 *   - rule parameters: the registry fingerprint (declarations + instance
 *     overrides; runtime overrides are per run and excluded by design)
 *   - engine implementation: the registry version, every engine's version,
 *     and the source of every module under health/itsm/
 *   - relevant configuration: the fingerprint of every rule configuration
 *     (rules/*.json) — a changed predicate or threshold reference is a
 *     changed rule
 *   - applicable dependency state: the dependency edges the runner honours
 *
 * Any of these moving invalidates the stored ITSM result and nothing else's:
 * CMDB, ITOM and Platform keep their invalidation exactly as it was.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Every engine and foundation module under health/itsm/, hashed by name and content. */
export function itsmSourceHash(dir = HERE) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js') || e.name.endsWith('.json')) h.update(path.relative(dir, full)).update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}

/**
 * The key. Every input is named in the returned `inputs` so a changed key can
 * be explained ("the parameter registry changed"), which is what the plan's
 * `reasons[]` will say.
 */
export function itsmEngineKey({ parameters = ITSM_PARAMETERS, configs = ITSM_RULE_CONFIGS, engineVersion = REGISTRY_VERSION, sourceHash = itsmSourceHash() } = {}) {
  const meta = getITSMCatalogueMeta();
  const inputs = {
    catalogue_version: meta.catalogue_version,
    workbook_sha256: meta.workbook_sha256,
    map_version: meta.map_version,
    parameters: parameters.fingerprint(),
    engine_version: engineVersion,
    engine_versions: Object.fromEntries(Object.entries(ITSM_ENGINE_REGISTRY).map(([k, e]) => [k, e.version])),
    configuration: ruleConfigFingerprint(configs),
    dependencies: crypto.createHash('sha256').update(JSON.stringify(dependencyEdges(configs))).digest('hex').slice(0, 16),
    source: sourceHash,
  };
  const key = crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 16);
  return Object.freeze({ key, inputs: Object.freeze(inputs) });
}

/** Which inputs differ between two keys — the human-readable reason a result was not reused. */
export function explainKeyChange(before, after) {
  if (!before) return ['no earlier ITSM engine key'];
  return Object.keys(after.inputs).filter((k) => JSON.stringify(before.inputs?.[k]) !== JSON.stringify(after.inputs[k])).map((k) => `${k} changed`);
}
