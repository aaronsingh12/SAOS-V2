import { listFacts } from '../../memory/facts.js';

/**
 * PHASE 6 — DETERMINISTIC FAILURE CLASSIFICATION.
 *
 * THE ORDER OF EVIDENCE IS THE WHOLE DESIGN.
 *
 * A failure has many possible descriptions and they are not equally
 * trustworthy. A verification verdict is a measurement; an error string is
 * prose the platform happened to emit. So classification walks a fixed
 * hierarchy and stops at the first thing that can actually establish what went
 * wrong:
 *
 *   1. verification result        a read-back diff — measured, not reported
 *   2. ServiceNow read-back       what the record says now
 *   3. tool result / error        the structured error, incl. diagnoseFailure's kind
 *   4. build result               the SDK's own exit
 *   5. task / plan state          cancelled, stale approval, never approved
 *   6. ledger trap                a measured behaviour that explains the shape
 *   7. textual error              last, and only when nothing above spoke
 *
 * A LANGUAGE MODEL IS NOT IN THIS FILE. It cannot reinterpret a deterministic
 * ServiceNow result into a friendlier category, and it cannot invent a kind:
 * the taxonomy is closed, and anything unrecognised is UNKNOWN, which stops.
 *
 * WHY IT REUSES `diagnoseFailure`'s VERDICT. `servicenow/client.js` already
 * separates a business-rule abort from an API-level ACL from a row ACL from
 * genuinely bad credentials — four causes that all arrive as HTTP 403 and that
 * cost real debugging to tell apart. Re-deriving that here would be a second
 * classifier that could disagree with the one the execution path uses. So its
 * `kind` is consumed and mapped, never recomputed.
 */

/** The closed taxonomy. Nothing outside this list is a failure kind. */
export const FAILURE_KINDS = Object.freeze([
  'TRANSIENT',
  'TIMEOUT',
  'RATE_LIMITED',
  'NETWORK',
  'AUTHENTICATION',
  'AUTHORIZATION',
  'VALIDATION',
  'REFERENCE',
  'SCOPE',
  'BUILD',
  'INSTALL',
  'VERIFICATION',
  'APPROVAL_STALE',
  'CANCELLED',
  'BLOCKED',
  'UNSUPPORTED',
  'UNKNOWN',
]);

const KNOWN = new Set(FAILURE_KINDS);

/** Where a classification was established. Ordered strongest first. */
export const EVIDENCE_SOURCES = Object.freeze([
  'verification',
  'readback',
  'tool_error',
  'build',
  'plan_state',
  'ledger',
  'error_text',
]);

/**
 * `diagnoseFailure`'s vocabulary, mapped onto ours.
 *
 * That function is the existing authority on why a ServiceNow call was refused,
 * and this is the only place the two vocabularies meet. A kind it grows later
 * that is absent here falls through to the status-code rules rather than being
 * guessed at.
 */
const DIAGNOSIS_MAP = Object.freeze({
  // The instance refused the CHANGE, not the caller. Retrying it unchanged
  // reproduces it exactly; the payload or the rule has to change.
  'business-rule': 'VALIDATION',
  'table-acl': 'AUTHORIZATION',
  'row-acl': 'AUTHORIZATION',
  credentials: 'AUTHENTICATION',
  // The instance itself will not say whether the row is absent or hidden, so
  // neither do we: REFERENCE covers "the thing you named cannot be reached".
  'missing-or-hidden': 'REFERENCE',
});

const classification = (kind, source, { confidence, recoverable, automatic, requiresApproval, reason, detail = null }) => {
  if (!KNOWN.has(kind)) throw new Error(`unknown failure kind "${kind}"`);
  return Object.freeze({
    kind,
    source,
    /*
     * EXPLANATORY METADATA, AND NOTHING ELSE.
     *
     * Nothing in this codebase may branch on this number to permit an action.
     * `policy.js` decides from the KIND; confidence exists so a human reading
     * the evidence knows how firmly the kind was established. A threshold on it
     * would be an authorisation mechanism nobody designed.
     */
    confidence,
    recoverable,
    automatic,
    requiresApproval,
    reason,
    detail,
  });
};

/* ------------------------------------------------------------------ *
 * Signal extraction
 * ------------------------------------------------------------------ */

/**
 * Pull the classification signals out of a Phase 5 evidence object.
 *
 * Evidence is the source of truth, so classification reads it rather than
 * re-querying. Kept separate from the classifier so the classifier stays pure
 * and a test can drive it with signals directly.
 */
export function signalsFromEvidence(evidence, stepId = null) {
  if (!evidence) return {};
  const step = stepId
    ? evidence.steps.find((s) => s.id === stepId)
    : evidence.steps.find((s) => s.execution_status === 'failed')
      ?? evidence.steps.find((s) => s.verification?.passed === false)
      ?? null;

  const change = step
    ? evidence.changes.find((c) => c.sys_id && step.inputs?.sys_id === c.sys_id) ?? null
    : (evidence.changes[0] ?? null);

  return {
    verification: step?.verification ?? null,
    readback: change ? { after: change.after_state, dropped: change.dropped_fields, transformed: change.transformed_fields } : null,
    toolError: step?.failureReason ? { message: step.failureReason } : null,
    build: evidence.builds.find((b) => b.status !== 'ok') ?? null,
    planState: evidence.task?.planState?.value ?? null,
    taskState: evidence.task?.state?.value ?? null,
    approvalValid: evidence.approval?.valid ?? null,
    approvalReason: evidence.approval?.reason ?? null,
    failureReason: evidence.task?.failureReason ?? step?.failureReason ?? null,
    capability: step ? { name: step.capability, mechanism: step.mechanism } : null,
    step,
  };
}

/* ------------------------------------------------------------------ *
 * The classifier
 * ------------------------------------------------------------------ */

/**
 * Classify one failure, deterministically.
 *
 * Every branch below is ordered by the evidence hierarchy, and the first one
 * that can establish a cause wins. `capability` is the Phase 3 discovery result
 * when one is available; `error` is a structured error carrying `status` and
 * optionally `detail.diagnosis` from `diagnoseFailure`.
 */
export function classifyFailure(signals = {}) {
  const {
    verification = null, readback = null, toolError = null, build = null,
    planState = null, taskState = null, approvalValid = null, approvalReason = null,
    capability = null, error = null, cancelled = false, failureReason = null,
  } = signals;

  /* ---- 0. CANCELLED outranks everything. It is not a failure at all. ---- */
  if (cancelled || planState === 'cancelled' || taskState === 'cancelled') {
    return classification('CANCELLED', 'plan_state', {
      confidence: 1, recoverable: false, automatic: false, requiresApproval: false,
      reason: 'the run was cancelled; a cancellation is a decision, not a fault to recover from',
    });
  }

  /* ---- 1. STALE APPROVAL. Checked early: it forbids execution outright. ---- */
  if (approvalValid === false && approvalReason === 'approval_stale') {
    return classification('APPROVAL_STALE', 'plan_state', {
      confidence: 1, recoverable: true, automatic: false, requiresApproval: true,
      reason: 'the plan changed after it was approved, so the approval no longer describes what would run',
    });
  }

  /* ---- 2. UNSUPPORTED. Phase 3 says this instance cannot do it at all. ---- */
  if (capability && capability.available === false
      && (capability.status === 'unsupported' || capability.reason === 'no_supported_execution_mechanism')) {
    return classification('UNSUPPORTED', 'plan_state', {
      confidence: 1, recoverable: false, automatic: false, requiresApproval: false,
      reason: `${capability.name ?? 'this capability'} is not supported here, and no mechanism is substituted for it`,
      detail: { capability: capability.name, reason: capability.reason },
    });
  }

  /*
   * ---- 3. VERIFICATION. THE MEASUREMENT OUTRANKS THE ERROR TEXT. ----
   *
   * A write that returned cleanly and did not land is a VERIFICATION failure,
   * not an UNKNOWN one and not a TRANSIENT one. This is the branch that stops a
   * silent drop from being retried as if the network had hiccuped.
   */
  if (verification) {
    const status = verification.status ?? null;
    if (status === 'no-op' || status === 'partial' || verification.passed === false) {
      const fields = (verification.failed_assertions ?? []).map((a) => a.name);
      return classification('VERIFICATION', 'verification', {
        confidence: 1, recoverable: true, automatic: false, requiresApproval: true,
        reason: status === 'no-op'
          ? 'the platform accepted the call and discarded the write; the record did not change'
          : `the write landed only in part${fields.length ? ` — ${fields.join(', ')} did not` : ''}`,
        detail: { status, fields, summary: verification.summary ?? null },
      });
    }
  }

  /*
   * ---- 4. READ-BACK. What the record actually says now. ----
   *
   * Reached when there is no verdict but there IS a read-back showing dropped
   * or transformed fields — the same failure, established one rung lower.
   */
  if (readback && ((readback.dropped ?? []).length || (readback.transformed ?? []).length)) {
    return classification('VERIFICATION', 'readback', {
      confidence: 0.9, recoverable: true, automatic: false, requiresApproval: true,
      reason: 'the record read back differs from what was requested',
      detail: { dropped: readback.dropped ?? [], transformed: readback.transformed ?? [] },
    });
  }

  /* ---- 5. THE STRUCTURED ERROR, via the existing diagnosis. ---- */
  const diagnosis = error?.detail?.diagnosis ?? error?.diagnosis ?? null;
  if (diagnosis?.kind && DIAGNOSIS_MAP[diagnosis.kind]) {
    const kind = DIAGNOSIS_MAP[diagnosis.kind];
    const stops = kind === 'AUTHORIZATION' || kind === 'AUTHENTICATION';
    return classification(kind, 'tool_error', {
      confidence: 1,
      recoverable: !stops,
      automatic: false,
      requiresApproval: !stops,
      reason: diagnosis.message ?? `the instance refused the call (${diagnosis.kind})`,
      detail: { diagnosis: diagnosis.kind, rule: diagnosis.rule ?? null, table: diagnosis.table ?? null },
    });
  }

  /* ---- 6. HTTP status, where no diagnosis was attached. ---- */
  const status = error?.status ?? null;
  if (status) {
    if (status === 401) {
      return classification('AUTHENTICATION', 'tool_error', {
        confidence: 1, recoverable: false, automatic: false, requiresApproval: false,
        reason: 'the instance rejected the credentials; this needs a person, not a retry',
      });
    }
    if (status === 403) {
      return classification('AUTHORIZATION', 'tool_error', {
        confidence: 0.9, recoverable: false, automatic: false, requiresApproval: false,
        reason: 'the instance refused the operation on permission grounds; retrying it changes nothing',
      });
    }
    if (status === 408) {
      return classification('TIMEOUT', 'tool_error', {
        confidence: 1, recoverable: true, automatic: false, requiresApproval: false,
        reason: 'the request timed out; whether it took effect is not known from the response',
      });
    }
    if (status === 429) {
      return classification('RATE_LIMITED', 'tool_error', {
        confidence: 1, recoverable: true, automatic: true, requiresApproval: false,
        reason: 'the instance asked for less traffic',
      });
    }
    if (status === 400 || status === 422) {
      return classification('VALIDATION', 'tool_error', {
        confidence: 0.9, recoverable: true, automatic: false, requiresApproval: true,
        reason: 'the instance rejected the request as malformed or invalid; the payload has to change',
      });
    }
    if (status === 404) {
      return classification('REFERENCE', 'tool_error', {
        confidence: 0.8, recoverable: true, automatic: false, requiresApproval: true,
        reason: 'the record or table named could not be reached; the reference has to be re-resolved',
      });
    }
    if (status >= 500 && status < 600) {
      return classification('TRANSIENT', 'tool_error', {
        confidence: 0.9, recoverable: true, automatic: true, requiresApproval: false,
        reason: `the instance returned ${status}; this is an upstream fault rather than a bad request`,
      });
    }
  }

  /* ---- 7. BUILD and INSTALL, from the SDK's own outcome. ---- */
  if (build && build.status !== 'ok') {
    const install = /install|deploy/i.test(String(build.kind ?? '')) || /install/i.test(String(build.summary ?? ''));
    return classification(install ? 'INSTALL' : 'BUILD', 'build', {
      confidence: 1, recoverable: true, automatic: false, requiresApproval: true,
      reason: install
        ? 'the install did not complete; whether anything reached the instance must be read back before anything else'
        : 'the source did not compile; the candidate has to be regenerated',
      detail: { run: build.id, diagnostics: (build.diagnostics ?? []).length },
    });
  }

  /* ---- 8. Plan-level blocks. ---- */
  if (approvalValid === false) {
    return classification('BLOCKED', 'plan_state', {
      confidence: 1, recoverable: true, automatic: false, requiresApproval: true,
      reason: 'the plan is not approved, so nothing may execute',
    });
  }

  /*
   * ---- 9. THE LEDGER. It can EXPLAIN a shape; it can never authorise. ----
   *
   * A measured trap that matches the failure raises confidence and names the
   * evidence, but it does not make anything automatic — Phase 3 puts the ledger
   * below live state precisely because it is a measurement from then, not a
   * read from now.
   */
  const text = String(failureReason ?? toolError?.message ?? error?.message ?? '');
  const trap = text ? matchingTrap(text) : null;
  if (trap) {
    return classification(trap.kind, 'ledger', {
      confidence: 0.7, recoverable: true, automatic: false, requiresApproval: true,
      reason: `this matches a measured trap in the ledger: ${trap.key}`,
      detail: { factKey: trap.key, provenance: trap.provenance },
    });
  }

  /* ---- 10. Textual, last. ---- */
  if (text) {
    if (/timed out|timeout|ETIMEDOUT/i.test(text)) {
      return classification('TIMEOUT', 'error_text', {
        confidence: 0.6, recoverable: true, automatic: false, requiresApproval: false,
        reason: 'the text reports a timeout; whether the operation took effect is unknown from here',
      });
    }
    if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|unreachable|fetch failed/i.test(text)) {
      return classification('NETWORK', 'error_text', {
        confidence: 0.7, recoverable: true, automatic: true, requiresApproval: false,
        reason: 'the instance could not be reached',
      });
    }
    if (/not in the registry|no alternative was substituted/i.test(text)) {
      return classification('UNSUPPORTED', 'error_text', {
        confidence: 0.8, recoverable: false, automatic: false, requiresApproval: false,
        reason: 'the operation names a tool this build does not have',
      });
    }
    if (/rejected|will not be retried/i.test(text)) {
      return classification('BLOCKED', 'plan_state', {
        confidence: 0.9, recoverable: false, automatic: false, requiresApproval: false,
        reason: 'a human refused this; a refusal is never converted into a retry',
      });
    }
    if (/scope/i.test(text) && /refus|mismatch|cannot/i.test(text)) {
      return classification('SCOPE', 'error_text', {
        confidence: 0.6, recoverable: true, automatic: false, requiresApproval: true,
        reason: 'the operation was refused on scope grounds',
      });
    }
  }

  /*
   * ---- 11. UNKNOWN, AND IT STOPS. ----
   *
   * The honest terminal answer. An unrecognised failure is not a licence to try
   * something; it is the case where a person has to look. Every field says so.
   */
  return classification('UNKNOWN', 'error_text', {
    confidence: 0,
    recoverable: false,
    automatic: false,
    requiresApproval: false,
    reason: 'nothing in the evidence establishes what went wrong, so no recovery can be shown to be safe',
    detail: { text: text || null },
  });
}

/**
 * A measured trap whose subject matches this failure.
 *
 * Keyed rather than scored: the ledger's own `key` names the behaviour, and a
 * match is a substring of the failure text against terms the key already
 * carries. It raises confidence and names the evidence; it never changes what
 * is permitted.
 */
const TRAP_SHAPES = Object.freeze([
  { match: /silently (dropped|discarded|accepted)|unchanged after|no-op/i, key: 'rest-silently-drops-field-writes', kind: 'VERIFICATION' },
  { match: /unknown field|field that does not exist/i, key: 'unknown-field-writes-accepted', kind: 'VALIDATION' },
  { match: /sys_scope|husk/i, key: 'sys-scope-insert-is-a-husk', kind: 'UNSUPPORTED' },
  { match: /catalog_ui_policy_action/i, key: 'ui-policy-action-not-writable-over-rest', kind: 'UNSUPPORTED' },
  { match: /priority/i, key: 'priority-is-calculated', kind: 'VALIDATION' },
]);

export function matchingTrap(text) {
  const shape = TRAP_SHAPES.find((t) => t.match.test(text));
  if (!shape) return null;
  const fact = listFacts().find((f) => f.key === shape.key) ?? null;
  return { key: shape.key, kind: shape.kind, provenance: fact?.provenance ?? null, confidence: fact?.confidence ?? null };
}
