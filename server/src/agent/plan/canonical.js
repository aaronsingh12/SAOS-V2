import { toolMap } from '../tools.js';

/**
 * PHASE 11 — CANONICAL EXECUTION ARGUMENTS.
 *
 * THE DEFECT THIS CLOSES, found by the Phase 10 release audit. A plan step has
 * two places to put the same fact:
 *
 *   target   { table, sys_id }   "when it acts on a record"
 *   inputs   "the arguments the tool needs"
 *
 * The executor passes only `inputs`. So a step the model wrote as
 *
 *   target: { table: 'incident' }
 *   inputs: { query: 'active=true', limit: 3 }
 *
 * validated, executed, reported `ok: true` — and called `query_records` with no
 * table at all. Two other places had already noticed the ambiguity and worked
 * around it privately: `review.js` reads `target?.sys_id ?? inputs?.sys_id`,
 * and the semantic validator reads `target.table || inputs?.table`. Three
 * readings of one fact, none of them the executor's.
 *
 * THIS MODULE IS THE ONE DEFINITION. It produces the exact object handed to
 * `executeTool`, and it runs BEFORE the fingerprint — so what a human approves
 * is what runs.
 *
 * IT IS SCHEMA-DRIVEN, NOT POSITIONAL, and that distinction is the whole
 * design. Flattening `target` into the arguments would be wrong for most of the
 * registry: 42 of 90 tools declare no top-level `table` or `sys_id` at all, and
 * `create_sla` has a property literally called `target` that means the SLA's
 * completion target — nothing to do with a record. A key is lifted only when
 * the tool's OWN `inputSchema` declares a property of that name.
 *
 * WHAT IT WILL NOT DO
 *
 *   It reads no live ServiceNow state and calls no model.
 *   It invents no defaults and infers nothing from prose.
 *   It never silently chooses between two different values — a conflict is a
 *   validation failure, because picking one would mean deciding which of two
 *   things the human meant, and this layer cannot know.
 *   It is pure: the same step always produces the same arguments.
 */

/**
 * The keys `target` may carry that can also be tool arguments.
 *
 * Deliberately short and closed. `target` is documented as
 * `{ table, sys_id }`; anything else in it is descriptive metadata for the
 * review card and is never lifted, because this module has no basis for
 * deciding what an unrecognised target key would mean to a tool.
 */
export const LIFTABLE_TARGET_KEYS = Object.freeze(['table', 'sys_id']);

/** Codes this module can raise. The validator turns them into problems. */
export const CANONICAL_CODES = Object.freeze({
  CONFLICT: 'target_input_conflict',
});

const isEmpty = (v) => v === undefined || v === null || v === '';

/**
 * Are these two values the SAME value?
 *
 * PHASE 12 — this was `===`, and that was wrong the moment a value could be an
 * object. A plan that writes the same reference in both places —
 * `target.sys_id` and `inputs.sys_id` each holding `{ "$ref": "step_1.result.sys_id" }`
 * — is saying one thing twice, not two conflicting things. Reference equality
 * called it a conflict and refused the plan, which is how the model's own
 * correct output came back rejected.
 *
 * A structural comparison over a canonical serialisation: key order cannot make
 * two identical references look different, and nothing is coerced, so `"1"` and
 * `1` remain the disagreement they are.
 */
const sameValue = (a, b) => {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
};

/**
 * The canonical execution arguments for one step.
 *
 * @returns {{ args: object, lifted: string[], conflicts: Array<{key,target,input}> }}
 *
 * `args` is what `executeTool` receives. `lifted` names the keys taken from
 * `target`, and `conflicts` names the keys where the two locations disagree —
 * the caller decides what a conflict means, so that this stays a pure
 * description rather than a policy.
 */
export function canonicalExecutionArgs(step, { registry = toolMap } = {}) {
  const inputs = (step?.inputs && typeof step.inputs === 'object' && !Array.isArray(step.inputs))
    ? step.inputs
    : {};
  const target = (step?.target && typeof step.target === 'object' && !Array.isArray(step.target))
    ? step.target
    : {};

  /*
   * A step with no tool executes nothing — it is a decision or a wait — so
   * there are no execution arguments to canonicalise. Its inputs are carried
   * through unchanged rather than reshaped against a schema that does not
   * exist.
   */
  const entry = step?.tool ? registry.get(step.tool) : null;
  if (!entry) return { args: { ...inputs }, lifted: [], conflicts: [] };

  const declared = entry.inputSchema?.properties ?? null;
  const args = { ...inputs };
  const lifted = [];
  const conflicts = [];

  for (const key of LIFTABLE_TARGET_KEYS) {
    const fromTarget = target[key];
    if (isEmpty(fromTarget)) continue;

    /*
     * THE SCHEMA DECIDES. A tool that does not declare this property would be
     * handed a field it never asked for — `create_incident` takes no `table`,
     * and giving it one is inventing an argument. The target keeps the value
     * for the review card; the tool does not see it.
     */
    if (!declared || !(key in declared)) continue;

    const fromInput = args[key];
    if (isEmpty(fromInput)) {
      args[key] = fromTarget;
      lifted.push(key);
      continue;
    }
    // Both present and identical: canonicalisation is deterministic, and the
    // duplicate is simply redundant rather than ambiguous. Compared
    // STRUCTURALLY, so two spellings of the same reference object agree.
    if (sameValue(fromInput, fromTarget)) continue;

    /*
     * Both present and DIFFERENT. There is no correct answer here: preferring
     * `inputs` because the executor reads it, or `target` because it is more
     * specific, would each be this module deciding which of two things a person
     * meant. It reports the disagreement and the plan is refused.
     */
    conflicts.push({ key, target: fromTarget, input: fromInput });
  }

  return { args, lifted, conflicts };
}

/**
 * Canonicalise a whole plan.
 *
 * Returns a NEW plan whose every step's `inputs` are its canonical execution
 * arguments, plus the conflicts found. `target` is left on the step untouched:
 * it is what the review card and the evidence show a human, and removing it
 * would take that away to solve a problem it is not causing.
 *
 * IDEMPOTENT. Canonicalising an already-canonical plan changes nothing, which
 * is what lets it run at more than one point in the pipeline without any of
 * them being a second, competing normalisation.
 */
export function canonicalisePlan(plan, { registry = toolMap } = {}) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const conflicts = [];
  const canonical = steps.map((s) => {
    const { args, conflicts: c } = canonicalExecutionArgs(s, { registry });
    for (const one of c) conflicts.push({ step: s.id, ...one });
    return { ...s, inputs: args };
  });
  return { plan: { ...plan, steps: canonical }, conflicts };
}

/**
 * Is this plan already canonical?
 *
 * Used by the executor's boundary test to prove that nothing re-normalises
 * after approval: if the stored plan is already canonical, then whatever the
 * executor passes along is exactly what was fingerprinted.
 */
export function isCanonical(plan, { registry = toolMap } = {}) {
  const { plan: c } = canonicalisePlan(plan, { registry });
  const before = (plan?.steps ?? []).map((s) => JSON.stringify(s.inputs ?? {}));
  const after = c.steps.map((s) => JSON.stringify(s.inputs ?? {}));
  return before.length === after.length && before.every((v, i) => v === after[i]);
}
