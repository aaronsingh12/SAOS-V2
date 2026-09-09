/**
 * PHASE 20 — PROVING IT (§30, §31, §44, §45, §46).
 *
 * §36 is the rule: the model cannot decide an application is complete. Only a
 * live read-back and NowTest can. So every conclusion below comes from a read
 * this module was HANDED — it performs none of its own, because nothing in
 * `appbuild/` reaches the instance.
 *
 * ═══ THE THREE THINGS THAT MUST NOT BE CONFLATED ═══
 *
 *   §45  BUILD failure    the plan did not run to completion
 *        DEPLOYMENT       it ran and the artifact did not land
 *        RUNTIME          it landed and behaves wrongly
 *        VERIFICATION     it landed and nothing could establish either way
 *
 * "APPLICATION_FAILED" is not a state. §68.7 makes reporting a behaviour
 * verified without evidence a release blocker, and the mirror of that — calling
 * an application broken because a read failed — is the same mistake pointed the
 * other way.
 *
 * ═══ §46 IS THE DEFAULT, NOT THE EXCEPTION ═══
 *
 * On an environment that cannot author flows, an application has no runtime to
 * exercise. Existence is provable; behaviour is not. That is PARTIAL, and it is
 * the honest answer rather than a downgrade — a build that reported VERIFIED
 * because everything it could check passed would be claiming the part it never
 * looked at.
 */
import { VERIFY, FAILURE, OUTCOME } from './schemas.js';

/**
 * Did each component actually land?
 *
 * @param created   what the build recorded creating: [{ component, type, sys_id, table }]
 * @param readBack  injected: (entry) => the record, or null. The ONLY evidence.
 *
 * A read that THROWS is UNKNOWN, never absent. §68.6 forbids reporting an
 * application complete without read-back, and a failed read reported as "not
 * created" would be the same lie wearing a different face.
 */
export async function verifyComponents({ created = [], readBack = null }) {
  const results = [];

  for (const entry of created) {
    if (typeof readBack !== 'function') {
      results.push({
        ...entry, verified: false, state: VERIFY.NOT_ATTEMPTED,
        note: 'No read-back was available, so nothing about this component was established.',
      });
      continue;
    }
    try {
      const record = await readBack(entry);
      if (record) {
        results.push({
          ...entry, verified: true, state: VERIFY.VERIFIED,
          evidence: { sys_id: record.sys_id ?? entry.sys_id ?? null, read: true },
          note: null,
        });
      } else {
        results.push({
          ...entry, verified: false, state: VERIFY.FAILED,
          note: 'The build reported creating this and it cannot be read back. It does not exist.',
        });
      }
    } catch (err) {
      results.push({
        ...entry, verified: false, state: VERIFY.NOT_ATTEMPTED,
        note: `This component could not be read back (${err.message}), so whether it exists is not established.`,
      });
    }
  }
  return results;
}

/**
 * The verdict over everything.
 *
 * @param components    what the architecture said should exist
 * @param verified      from `verifyComponents`
 * @param test          the NowTest result, or null when nothing runs
 * @param behaviours    how many acceptance criteria were meant to be exercised
 */
export function conclude({ components = [], verified = [], test = null, behaviours = 0, folded = [] }) {
  const existsVerified = verified.filter((v) => v.state === VERIFY.VERIFIED).length;
  const existsFailed = verified.filter((v) => v.state === VERIFY.FAILED).length;
  const existsUnknown = verified.filter((v) => v.state === VERIFY.NOT_ATTEMPTED).length;

  /*
   * A component in the architecture that was never created and never verified.
   *
   * A FOLDED COMPONENT IS ACCOUNTED FOR BY ITS PARENT. Found by the PDI: a
   * catalog variable is created by the `create_catalog_item` call that creates
   * its item, so it never has a step and never has a read-back of its own — and
   * counting it as missing turned a complete, fully verified build into a
   * PARTIAL_BUILD. It is covered, not absent, and the difference matters
   * because §30 reserves PARTIAL_BUILD for an instance holding half an
   * application.
   */
  const accounted = new Set([
    ...verified.map((v) => v.component),
    ...folded.filter((f) => f.built_by).map((f) => f.component),
  ]);
  const missing = components.filter((c) => !accounted.has(c.id ?? c.component));

  const componentState = existsFailed || missing.length
    ? VERIFY.FAILED
    : existsUnknown
      ? VERIFY.PARTIAL
      : (existsVerified ? VERIFY.VERIFIED : VERIFY.NOT_ATTEMPTED);

  /*
   * §34/§36 — behaviour is a separate question with a separate answer. An
   * application whose components all exist and whose behaviour nothing
   * exercised is NOT verified; it is partially verified, and the part that is
   * missing is the part a user actually cares about.
   */
  let behaviourState = VERIFY.NOT_ATTEMPTED;
  let behaviourNote = behaviours
    ? 'No runtime test ran, so none of the stated behaviours was established.'
    : 'The requirements stated no observable behaviour to exercise.';

  if (test) {
    if (test.status === 'PASS') {
      behaviourState = VERIFY.VERIFIED;
      behaviourNote = 'NowTest exercised the flow and every required assertion passed against read-back.';
    } else if (test.status === 'FAIL') {
      behaviourState = VERIFY.FAILED;
      behaviourNote = 'NowTest ran and an expected effect did not occur.';
    } else {
      behaviourState = VERIFY.PARTIAL;
      behaviourNote = `NowTest returned ${test.status}, so the behaviour is not established either way.`;
    }
  }

  const outcome = decide({ componentState, behaviourState, existsFailed, missing: missing.length });

  return {
    outcome,
    components: {
      state: componentState,
      verified: existsVerified,
      failed: existsFailed,
      unknown: existsUnknown,
      missing: missing.map((c) => c.id ?? c.component),
    },
    behaviour: { state: behaviourState, note: behaviourNote, test: test?.status ?? null },
    /* §46 — stated explicitly rather than left to be inferred from the mix. */
    partial: outcome === OUTCOME.APPLICATION_PARTIALLY_VERIFIED || outcome === OUTCOME.PARTIAL_BUILD,
    unknown_components: verified.filter((v) => v.state === VERIFY.NOT_ATTEMPTED).map((v) => v.component),
    failure: outcome === OUTCOME.PARTIAL_BUILD ? FAILURE.VERIFICATION_FAILURE : null,
  };
}

function decide({ componentState, behaviourState, existsFailed, missing }) {
  if (existsFailed || missing) return OUTCOME.PARTIAL_BUILD;
  if (componentState === VERIFY.FAILED) return OUTCOME.PARTIAL_BUILD;
  if (componentState === VERIFY.VERIFIED && behaviourState === VERIFY.VERIFIED) {
    return OUTCOME.APPLICATION_VERIFIED;
  }
  if (componentState === VERIFY.VERIFIED) return OUTCOME.APPLICATION_PARTIALLY_VERIFIED;
  return OUTCOME.PARTIAL_BUILD;
}

/* ------------------------------------------------------------------ *
 * §30 / §31 — partial state and rollback
 * ------------------------------------------------------------------ */

/**
 * What exists after a build that did not finish.
 *
 * §30 asks for the exact created list and §31 forbids claiming a rollback that
 * did not happen. Both are the same discipline: report what IS, never what was
 * intended.
 */
export function partialState({ created = [], planned = [], failedAt = null }) {
  const done = new Set(created.map((c) => c.component));
  return {
    state: OUTCOME.PARTIAL_BUILD,
    failed_at: failedAt,
    created: created.map((c) => ({ component: c.component, type: c.type, sys_id: c.sys_id ?? null, table: c.table ?? null })),
    not_created: planned.filter((p) => !done.has(p.id)).map((p) => p.id),
    /* Never true unless something actually deleted something. */
    rolled_back: false,
    note: `${created.length} component(s) were created before the build stopped and they still exist. `
      + 'Nothing was rolled back — this build does not delete artifacts it did not prove it owns.',
  };
}

/**
 * May this build delete what it created? (§31)
 *
 * Four conditions, ALL required. The interesting one is ownership: a component
 * is owned only when this run watched it being created and recorded its sys_id.
 * "It matches the name we would have used" is not ownership, and deleting on
 * that basis is how a build removes somebody else's artifact.
 */
export function rollbackEligibility({ entry, capabilities = {}, policyAllows = false }) {
  const reasons = [];
  if (!entry?.created_by_this_build) reasons.push('this build did not create it');
  if (!entry?.sys_id) reasons.push('its sys_id was never recorded, so the exact record is not identified');
  const deletable = capabilities.record_delete?.available === true;
  if (!deletable) reasons.push('record deletion is not available on this instance');
  if (!policyAllows) reasons.push('policy does not permit automatic deletion here');

  return {
    eligible: reasons.length === 0,
    reasons,
    note: reasons.length
      ? `This artifact will NOT be deleted automatically: ${reasons.join('; ')}. A person should remove it.`
      : 'This build created this record, recorded its sys_id, and deletion is both available and permitted.',
  };
}
