/**
 * PHASE 3 — the semantic layer's public surface.
 *
 * READ-ONLY BY CONSTRUCTION. Nothing reachable from here writes to ServiceNow,
 * elevates a role, requests an approval or touches a task. That is not a
 * convention: the modules below import `schema.js` (reads), the fact ledger's
 * read function, and the precedence ladder — and nothing else. There is no
 * `table.create` in scope to call by mistake, and the import-boundary tests in
 * test/semantic-layer.test.js assert it rather than trusting this paragraph.
 *
 * WHERE IT SITS. Above the ServiceNow read layer, below the future planner:
 *
 *     Phase 2 context engine  ->  SEMANTIC LAYER  ->  capability discovery
 *                                                          ->  Phase 4 planner
 *
 * It answers "what does this ServiceNow thing mean, and how sure are we" — and
 * it answers "unknown" when that is the truth, which is the only reason the
 * other answers can be relied on.
 */
export {
  SOURCES, STATUS, LADDER, LADDER_RUNG,
  fact, unknown, ambiguous, unsupported, unavailable,
  reconcile, sourceRank, factCanAuthorize,
} from './provenance.js';

export {
  SEMANTIC_TYPES,
  describeTable, describeTableField, describeField,
  derivationOf, resolveReference,
} from './tables.js';

export {
  ARTIFACTS, ARTIFACT_KINDS,
  artifactForTable, describeArtifact,
} from './artifacts.js';
