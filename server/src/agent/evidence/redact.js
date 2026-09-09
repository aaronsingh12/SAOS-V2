/**
 * The redactor, re-exported.
 *
 * The implementation moved to `memory/redact.js` in Phase 19 so that knowledge
 * ingestion — which sits below this layer — could use it without importing
 * upward. See that file for the full reasoning. This path is kept because it is
 * the one the evidence layer, the Doctor and Change Intelligence already import,
 * and moving a shared utility should not require touching its callers.
 */
export {
  SECRET_KEYS, REDACTED, redact, findSecrets,
} from '../../memory/redact.js';
