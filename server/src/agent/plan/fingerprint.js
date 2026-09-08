import crypto from 'node:crypto';

/**
 * PHASE 4 — THE PLAN FINGERPRINT.
 *
 * WHAT IT IS FOR. A human reviews a plan and approves it. Between that approval
 * and the moment a step actually writes to ServiceNow, the plan must not have
 * changed in any way that matters — and "must not" has to be enforced by
 * something, because the alternative is trusting that nothing in a
 * multi-iteration agent loop rewrote a step. The fingerprint is that something:
 * the executor recomputes it before every step and refuses if it no longer
 * matches what was approved.
 *
 * WHAT IT COVERS, AND WHAT IT MUST NOT.
 *
 * It covers the MEANING of the execution: the goal, and for each step in order
 * its operation, capability, mechanism, scope, target, inputs, dependencies and
 * verification strategy. Change any of those and the human approved something
 * else.
 *
 * It deliberately excludes everything incidental — provider name, model name,
 * timestamps, database ids, the random UUIDs the store mints. Including any of
 * those would make the fingerprint change for reasons that are not the plan,
 * and an invariant that fires constantly is an invariant people switch off.
 *
 * DEPENDENCIES ARE NORMALISED TO POSITIONS, not ids. Two plans that differ only
 * in the random names of their steps are the same plan; two plans whose step
 * ORDER differs are not. Hashing the ids directly would get that backwards.
 *
 * THE HASH IS OVER A CANONICAL FORM. Object key order in JavaScript is
 * insertion order, so `{a:1,b:2}` and `{b:2,a:1}` would stringify differently
 * and hash differently while describing the same write. Every object is sorted
 * before it is serialised, so the fingerprint is a property of the plan rather
 * than of how it happened to be built.
 */

/** Recursively sort object keys so the serialisation is canonical. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

/**
 * The fields of a step that change what will happen.
 *
 * Anything absent from this list is, by construction, not part of what a human
 * approved — so adding a field to a step without adding it here silently takes
 * it outside the binding. The list is short on purpose and every entry is
 * something a reviewer would object to being changed underneath them.
 */
export const FINGERPRINTED_STEP_FIELDS = Object.freeze([
  'operation',
  'capability',
  'mechanism',
  'scope',
  'tool',
  'target',
  'inputs',
  'mutating',
  'verification',
  'expected_effects',
]);

/**
 * The canonical form of a plan — what is actually hashed.
 *
 * Exported so a test can assert what is and is not covered, and so a mismatch
 * can be explained to a human in terms of the plan rather than a hex string.
 */
export function canonicalPlan(plan) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  // plan-local id -> ordinal, so dependencies survive renaming but not reordering.
  const position = new Map(steps.map((s, i) => [s.id, i]));

  return canonical({
    goal: String(plan?.goal ?? ''),
    steps: steps.map((s) => {
      const out = {};
      for (const f of FINGERPRINTED_STEP_FIELDS) {
        if (s[f] !== undefined) out[f] = s[f];
      }
      // Positions, sorted: "depends on the second step" is the fact, not
      // "depends on step_a1b2".
      out.depends_on = (s.depends_on || [])
        .map((d) => (position.has(d) ? position.get(d) : `unresolved:${d}`))
        .sort();
      return out;
    }),
  });
}

/** The fingerprint itself. Stable across processes, machines and providers. */
export function fingerprintPlan(plan) {
  const json = JSON.stringify(canonicalPlan(plan));
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 32);
}

/**
 * Did the plan materially change, and if so where?
 *
 * Returns the first differing step so a refusal can name it. "The plan changed"
 * is an unhelpful thing to tell someone who is about to lose their approval;
 * "step 2's inputs changed" is actionable.
 */
export function diffPlans(approved, current) {
  const a = canonicalPlan(approved);
  const b = canonicalPlan(current);
  if (a.goal !== b.goal) return { changed: true, where: 'goal', before: a.goal, after: b.goal };
  if (a.steps.length !== b.steps.length) {
    return { changed: true, where: 'step count', before: a.steps.length, after: b.steps.length };
  }
  for (let i = 0; i < a.steps.length; i++) {
    const sa = JSON.stringify(a.steps[i]);
    const sb = JSON.stringify(b.steps[i]);
    if (sa !== sb) return { changed: true, where: `step ${i + 1}`, before: a.steps[i], after: b.steps[i] };
  }
  return { changed: false };
}

/**
 * Constant-time comparison of two fingerprints.
 *
 * The same discipline the approval nonce already uses: a comparison that
 * returns early on the first wrong byte is a comparison that can be probed one
 * byte at a time. The length check comes first because the primitive throws on
 * unequal lengths.
 */
export function fingerprintMatches(expected, presented) {
  if (typeof expected !== 'string' || typeof presented !== 'string') return false;
  const x = Buffer.from(expected, 'utf8');
  const y = Buffer.from(presented, 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}
