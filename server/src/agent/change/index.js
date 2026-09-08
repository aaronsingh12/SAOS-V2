/**
 * PHASE 18 — CHANGE INTELLIGENCE, ASSEMBLED.
 *
 * The composition layer, and almost nothing else. Read down `compareFlow` and
 * the only new ideas are: which artifact, which two states, and what the
 * difference means. Everything with teeth is CALLED:
 *
 *   reading a flow        `readFlowArtifact` (Phase 16), injected
 *   the dictionary        the same authority NowLint's context wraps, injected
 *   the semantic ledger   `derivationOf`, injected
 *   linting               `lintFlow` (Phase 16), injected
 *   testability           `triggerOf` / `isDisposable` (Phase 17), injected
 *   deployment            a GOAL for the existing planner, and nothing more
 *   evidence              the existing task record
 *
 * §58's boundary list is enforced by the import graph rather than promised:
 * nothing under `agent/change/` imports the ServiceNow client, the database, a
 * provider, the executor, the verifier or the approval gate. The only
 * cross-directory imports are three reused pieces of earlier phases — the lint
 * vocabulary and its destructive-action pattern, the lint intent resolver, and
 * the encoded-query parser Phase 17 wrote — each of which exists so that this
 * phase and that one cannot disagree about the same question.
 *
 * ═══ WHAT THIS DOMAIN CANNOT DO ═══
 *
 * It cannot write. There is no create, no update, no delete and no executor
 * anywhere in it, so §32's "analysis is read-only" and §59's "never directly
 * deploy" are not policies this code follows — they are things it has no
 * capacity for. The strongest form of a rule is one you could not break.
 */
import crypto from 'node:crypto';
import { SOURCES, STOPS, RISK, emptyComparison } from './schemas.js';
import { readChangeIntent, deploymentHandoff, MODES } from './intent.js';
import { readState, findBaseline, captureBaseline, restoreBaseline, baselineIsIntact } from './baseline.js';
import { diffFlows, dependencyDelta, summarise } from './diff.js';
import { assess, rank, overallRisk } from './significance.js';
import { schemaImpact, dependencyImpact, lintScope, testRecommendation, executionContext } from './impact.js';
import { renderComparison } from './render.js';

const now = () => Date.now();

/**
 * Compare a flow with an earlier state of itself.
 *
 * Every collaborator is injected; see the module comment for why that is a
 * structural claim rather than a testing convenience.
 */
export async function compareFlow({
  request,
  taskId = null,
  /* identification */
  find,
  chat = null,
  sys_id: sysId = null,
  baseline_sys_id: baselineSysId = null,
  /* the artifact */
  readArtifact,
  findSnapshot = null,
  capturedBaseline = null,
  /* the authorities impact analysis consults */
  fieldsOf = null,
  derivationOf = null,
  /* Phase 16, injected whole */
  lint = null,
  allRuleIds = [],
  /* Phase 17, injected as two predicates */
  testability = null,
  /* execution history, optional (§28) */
  executionsFor = null,
  /* durable persistence, injected so this module never touches a database */
  record = null,
  at = null,
  signal = null,
  emit = () => {},
} = {}) {
  const started = now();
  const timings = {};
  const base = emptyComparison();

  try {
    /* ---- 1. which artifact, and what was asked (§1, §8) ---- */
    const intent = await readChangeIntent({
      request, find, chat, signal, sys_id: sysId, baseline_sys_id: baselineSysId,
    });
    if (!intent.ok) {
      return stopped(base, intent.stop, intent.note, { candidates: intent.found?.candidates ?? [] });
    }
    const flow = { sys_id: intent.found.sys_id, name: intent.found.name };
    emit({ type: 'change_artifact_identified', taskId, flow, mode: intent.mode });

    /* ---- 2. the CURRENT state (§3) ---- */
    const t0 = now();
    const current = await readState({ sysId: flow.sys_id, source: SOURCES.LIVE, readArtifact, at });
    timings.current_read_ms = now() - t0;
    if (!current.ok) {
      return stopped({ ...base, artifact: { type: 'flow', ...flow } }, STOPS.CURRENT_UNREADABLE, current.note);
    }

    /*
     * §35 — capturing a baseline is a separate, deliberate operation, and it
     * happens INSTEAD of a comparison rather than as a side effect of one.
     * Nothing anywhere in this file replaces a stored baseline automatically.
     */
    if (intent.mode === MODES.CAPTURE_BASELINE) {
      if (!at) throw new Error('Capturing a baseline requires the time it was captured.');
      const captured = captureBaseline(current, { at, by: taskId, note: 'captured on request' });
      const result = {
        ...base,
        artifact: { type: 'flow', ...flow },
        current: projectState(current),
        captured_baseline: captured,
        complete: current.complete,
        unreadable: current.gaps,
        summary: null,
        risk: RISK.LOW,
        timings: { ...timings, total_ms: now() - started },
      };
      if (typeof record === 'function') record(taskId, result);
      emit({ type: 'change_baseline_captured', taskId, hash: captured.hash });
      return result;
    }

    /* ---- 3. the BASELINE (§3, §4) ---- */
    const t1 = now();
    const found = await findBaseline({
      flowSysId: flow.sys_id,
      explicitSysId: intent.baseline_sys_id,
      findSnapshot,
      captured: capturedBaseline ? async (id) => restoreOf(await capturedBaseline(id)) : null,
      readArtifact,
    });
    timings.baseline_read_ms = now() - t1;
    if (!found.ok) {
      return stopped({
        ...base,
        artifact: { type: 'flow', ...flow },
        current: projectState(current),
      }, found.reason, found.note);
    }
    const baseline = found.state;

    /* A restored baseline that no longer hashes to what it did is not evidence
     * about the past, and saying so is better than comparing against it. */
    if (baseline.stored_hash) {
      const intact = baselineIsIntact(baseline);
      if (!intact.ok) {
        return stopped({
          ...base, artifact: { type: 'flow', ...flow }, current: projectState(current),
        }, STOPS.BASELINE_UNREADABLE, intact.note);
      }
    }

    emit({
      type: 'change_states_read',
      taskId,
      baseline: { source: baseline.source, hash: baseline.hash },
      current: { source: current.source, hash: current.hash },
    });

    /* ---- 4/5. normalise and diff (§6, §11) ---- */
    const t2 = now();
    const raw = diffFlows(baseline.normalized, current.normalized);
    const deps = dependencyDelta(baseline.normalized, current.normalized);
    const changes = rank(assess(raw.changes));
    timings.diff_ms = now() - t2;

    const summary = summarise({ changes, unchanged: raw.unchanged, dependencies: deps });

    /* ---- 6. impact (§20, §21) ---- */
    const t3 = now();
    const impact = [
      ...dependencyImpact(deps),
      ...(fieldsOf || derivationOf
        ? await schemaImpact({ changes, current: current.normalized, ctx: { fieldsOf, derivationOf } })
        : []),
    ];
    timings.impact_ms = now() - t3;

    /* ---- 7. risk (§24, §25) ---- */
    const risk = overallRisk(changes, { complete: raw.complete });

    /* ---- 8. NowLint on the CURRENT artifact (§22) ---- */
    const t4 = now();
    const scope = lintScope(changes);
    let lintResult = null;
    if (typeof lint === 'function') {
      try {
        const out = await lint(current.raw);
        const evaluated = out?.rules_run ?? [];
        lintResult = {
          ...out,
          scope: {
            ...scope,
            /* §22's caveat, made concrete: exactly which rules ran and which of
             * the ones this change made relevant did not. A "lint clean" that
             * omitted a relevant rule is the thing §22 forbids, and this is
             * where it becomes visible rather than assumed. */
            evaluated,
            not_evaluated: (allRuleIds ?? []).filter((id) => !evaluated.includes(id)),
            relevant_not_evaluated: scope.relevant.filter((id) => !evaluated.includes(id)),
          },
        };
      } catch (err) {
        lintResult = { error: err.message, findings: [], scope };
      }
    }
    timings.lint_ms = now() - t4;

    /* ---- 9. NowTest, recommended and never run (§23) ---- */
    const test = testability
      ? testRecommendation({ changes, current: current.normalized, testability })
      : { recommended: false, reason: 'Runtime testing was not available to this run.' };

    /* ---- 10. execution history, only where provenance permits (§28) ---- */
    let execution = null;
    if (typeof executionsFor === 'function') {
      const rows = await executionsFor(flow.sys_id).catch(() => []);
      execution = executionContext({ executions: rows, baselineCapturedAt: baseline.captured_at ?? null });
    }

    const comparison = {
      ...base,
      artifact: { type: 'flow', ...flow },
      baseline: projectState(baseline, found.chosen, found.alternatives),
      current: projectState(current),
      changes,
      summary,
      impact,
      dependencies: deps,
      risk: risk.risk,
      risk_reason: risk.reason,
      risk_driver: risk.driver ?? null,
      risk_unknown_changes: risk.unknown_changes,
      complete: raw.complete,
      unreadable: raw.unreadable,
      lint: lintResult,
      test,
      execution,
      /* §31 — identity of the comparison itself. */
      fingerprint: diffFingerprint({ baseline: baseline.hash, current: current.hash, type: 'flow' }),
      stopped: null,
      timings: { ...timings, total_ms: now() - started },
    };
    comparison.deployment = deploymentHandoff(comparison);

    if (typeof record === 'function') record(taskId, comparison);
    /*
     * NOT `change_complete`. That frame is TERMINAL and belongs to the route,
     * which emits exactly one of it or `plan_failed` — the invariant every
     * stream in this build holds. A domain that emitted it too would put two
     * terminal frames on one stream, and a client would be right to be
     * confused about which carried the answer. This one says the comparison is
     * decided; the route says the stream is over.
     *
     * The same mistake was made and fixed in Phase 17. Making it twice is why
     * it is written down here rather than only there.
     */
    emit({ type: 'change_decided', taskId, changes: summary.total, risk: comparison.risk });
    return comparison;
  } catch (err) {
    const result = stopped(base, 'error', `The comparison could not be completed: ${err.message}`);
    result.timings = { ...timings, total_ms: now() - started };
    if (typeof record === 'function') record(taskId, result);
    return result;
  }
}

/* ------------------------------------------------------------------ *
 * §31 — the identity of a comparison
 * ------------------------------------------------------------------ */

/**
 * A deterministic name for "this diff".
 *
 * §31 says what it is made of and, more usefully, what it is NOT: no user
 * wording, no model, no timestamp. Two people asking the same question in
 * different words about the same two states get the same fingerprint, which is
 * what makes it usable as an identity for an approval to bind to (§33, §34).
 */
export function diffFingerprint({ baseline, current, type = 'flow' }) {
  return crypto.createHash('sha256')
    .update(`${type}\n${baseline ?? ''}\n${current ?? ''}`)
    .digest('hex');
}

/* ------------------------------------------------------------------ *
 * Projections
 * ------------------------------------------------------------------ */

const projectState = (state, chosen = null, alternatives = null) => (state ? {
  source: state.source,
  sys_id: state.sys_id,
  hash: state.hash,
  version: state.version,
  complete: state.complete,
  gaps: state.gaps,
  captured_at: state.captured_at ?? null,
  chosen_because: chosen,
  alternatives: alternatives ?? null,
} : null);

function stopped(partial, reason, note, extra = {}) {
  return {
    ...partial,
    stopped: { reason, note, ...extra },
    risk: RISK.UNKNOWN,
    complete: false,
    deployment: {
      available: false,
      note: 'No comparison was produced, so there is nothing to prepare for deployment.',
      goal: null,
    },
  };
}

const restoreOf = (rec) => (rec ? restoreBaseline(rec) : null);

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

export { renderComparison };
export { readChangeIntent, deploymentHandoff, deploymentGoal, readMode, MODES } from './intent.js';
export {
  readState, findBaseline, captureBaseline, restoreBaseline, baselineIsIntact,
} from './baseline.js';
export {
  normalizeFlow, hashArtifact, canonicalString, versionIdOf,
} from './normalize.js';
export { diffFlows, dependencyDelta, summarise } from './diff.js';
export { assess, rank, riskOf, overallRisk } from './significance.js';
export {
  schemaImpact, dependencyImpact, lintScope, testRecommendation, executionContext,
} from './impact.js';
export {
  SOURCES, SOURCE_LIST, STOPS, KINDS, KIND_LIST, ELEMENTS, CATEGORIES, CATEGORY_LIST,
  RISK, RISK_RANK, CATEGORY_RISK, STATUS, SEVERITY, emptyComparison, isChange,
} from './schemas.js';
