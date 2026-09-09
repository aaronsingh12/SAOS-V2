/**
 * PHASE 18 — WHAT WAS ASKED, AND WHETHER THIS DOMAIN MAY DO IT.
 *
 * WHICH FLOW is answered by reusing Phase 16's resolver, unchanged. The same
 * argument holds as it did in Phase 17: an ambiguous name must stop rather than
 * be guessed at, `resolveFlowForRequest` already does exactly that with the
 * instance as the arbiter, and a second identifier would be a second thing to
 * be wrong.
 *
 * WHICH MODE is the interesting half, and it has one answer this file exists to
 * make unavoidable: **Change Intelligence does not deploy.** §32 and §59 both
 * say so and §63.9 makes bypassing the existing path a release blocker. So a
 * request to deploy is recognised HERE, at the entrance, and converted into a
 * GOAL for the existing planner — the same move NowLint makes with "fix it".
 *
 * That is not a refusal dressed up as helpfulness. The analysis still runs and
 * still produces the change plan §33 asks for; what does not happen is this
 * domain touching the instance. The deployment travels plan → review → approval
 * → executor → read-back, and the only thing Change Intelligence contributes to
 * it is a sentence saying what should be deployed and why.
 */
import { resolveFlowForRequest } from '../lint/intent.js';
import { STOPS } from './schemas.js';

/** A request that wants the change applied, not explained. */
const WANTS_DEPLOY = /\b(deploy|ship|release|promote|publish|roll\s*out|apply)\b/i;

/**
 * A request that wants the current state remembered as a baseline (§35).
 *
 * NARROWED AFTER REVIEW. This used to admit "snapshot" as a capture verb, which
 * made "show me the snapshot version of this flow" — a COMPARISON request, and
 * a natural way to phrase one given that the baseline IS a snapshot — skip the
 * diff entirely and write a baseline instead. The verbs are now the ones that
 * unambiguously ask for something to be kept, and "snapshot" is treated as the
 * noun it is on this platform.
 */
const WANTS_CAPTURE = /\b(save|capture|remember|pin|bookmark)\b[^.?!]{0,24}\b(baseline|current|version|state|snapshot)\b/i;

/** An explicit "before" the user named. */
const SYS_ID = /\b([0-9a-f]{32})\b/i;

export const MODES = Object.freeze({
  ANALYZE: 'ANALYZE',
  CAPTURE_BASELINE: 'CAPTURE_BASELINE',
  PREPARE_DEPLOYMENT: 'PREPARE_DEPLOYMENT',
});

export function readMode(request) {
  const text = String(request ?? '');
  if (WANTS_CAPTURE.test(text)) return MODES.CAPTURE_BASELINE;
  if (WANTS_DEPLOY.test(text)) return MODES.PREPARE_DEPLOYMENT;
  return MODES.ANALYZE;
}

/**
 * Read a change request.
 *
 * @returns {{ ok, mode, found, flow_name, by, baseline_sys_id, stop, note }}
 *
 * A second sys_id in the request is read as an explicit baseline. The FIRST is
 * not: it may be the flow itself, and `resolveFlowForRequest` is what decides
 * that. Guessing which of two identities is which is exactly the sort of
 * cleverness that makes a diff compare the wrong pair.
 */
export async function readChangeIntent({ request, find, chat = null, signal = null, sys_id: sysId = null, baseline_sys_id: baselineSysId = null } = {}) {
  const mode = readMode(request);

  const found = sysId
    ? await find({ sys_id: sysId })
    : (await resolveFlowForRequest({ request, find, chat, signal })).found;

  const explicitBaseline = baselineSysId ?? secondSysId(request, found?.sys_id ?? null);

  if (!found.ok) {
    return {
      ok: false, mode, found, flow_name: null, by: 'deterministic',
      baseline_sys_id: explicitBaseline,
      stop: found.reason === 'ambiguous' ? STOPS.ARTIFACT_AMBIGUOUS : STOPS.ARTIFACT_NOT_IDENTIFIED,
      note: found.note,
    };
  }

  return {
    ok: true,
    mode,
    found,
    flow_name: found.name,
    by: found.by ?? 'deterministic',
    baseline_sys_id: explicitBaseline,
    stop: null,
    note: null,
  };
}

/** The sys_id in the request that is NOT the artifact, if there is one. */
function secondSysId(request, artifactSysId) {
  const all = String(request ?? '').match(new RegExp(SYS_ID.source, 'gi')) ?? [];
  const others = all.map((s) => s.toLowerCase()).filter((s) => s !== String(artifactSysId ?? '').toLowerCase());
  return others.length === 1 ? others[0] : null;
}

/**
 * Turn a deployment request into a GOAL for the existing planner (§32, §59).
 *
 * This is the whole of Change Intelligence's deployment path: a sentence.
 * Everything after it — capability discovery, canonicalisation, the plan
 * fingerprint, review, approval, the executor, read-back, verification — is the
 * pipeline earlier phases already built, and there is deliberately no way to
 * reach it from here except by handing over this string.
 *
 * IT REFUSES TO PRODUCE ONE FOR AN UNKNOWN CHANGE. A goal that says "deploy
 * these changes" without knowing what they are is how a person approves
 * something nobody described.
 */
export function deploymentGoal(comparison) {
  if (!comparison?.summary || comparison.stopped) {
    throw new Error('A deployment goal needs a completed comparison; there is nothing to describe.');
  }
  if (!comparison.complete) {
    throw new Error('A deployment goal needs a complete comparison. Part of this artifact could not be read, '
      + 'so what would be deployed is not fully known.');
  }
  if (!comparison.summary.total) {
    throw new Error('There is nothing to deploy: the two states are semantically identical.');
  }

  const name = comparison.artifact?.name ?? 'the flow';
  const bits = [];
  if (comparison.summary.trigger_changes) bits.push(`${comparison.summary.trigger_changes} trigger change(s)`);
  if (comparison.summary.behavioral_changes) bits.push(`${comparison.summary.behavioral_changes} behavioural change(s)`);
  if (comparison.summary.dependency_changes) bits.push(`${comparison.summary.dependency_changes} dependency change(s)`);

  return `Deploy the ServiceNow flow "${name}" as it currently stands (content ${comparison.current?.version?.id}), `
    + `replacing the version currently published (content ${comparison.baseline?.version?.id}). `
    + `The comparison found ${comparison.summary.total} semantic change(s)${bits.length ? `: ${bits.join(', ')}` : ''}. `
    + `Assessed risk: ${comparison.risk}.`;
}

/**
 * What to tell a person who asked for a deployment.
 *
 * Not a refusal — the analysis ran, and the change plan is real. What this says
 * is where the deployment itself has to happen, and why it is not here.
 */
export function deploymentHandoff(comparison) {
  const blocked = !comparison?.summary?.total || !comparison?.complete || comparison?.stopped;
  return {
    available: !blocked,
    note: blocked
      /*
       * ORDER MATTERS HERE. An INCOMPLETE comparison that found no differences
       * was told "the two states are semantically identical" — a claim it had
       * no basis for, since the sections it could not read might differ in any
       * way at all. Found by review. Completeness is checked first, so the
       * identity claim is only ever made when it is true.
       */
      ? (!comparison?.complete
        ? 'A deployment cannot be prepared from an incomplete comparison: part of this artifact could '
          + 'not be read, so what would be deployed is not fully known.'
        : (comparison?.summary?.total === 0
          ? 'There is nothing to deploy: the two states are semantically identical.'
          : 'A deployment cannot be prepared from this comparison.'))
      : 'Change Intelligence analyses and does not deploy. Preparing this change hands the goal below to the '
        + 'ordinary planner, which builds it, shows you what it will do, waits for your approval, executes it '
        + 'through the same executor everything else uses, and reads the result back.',
    goal: blocked ? null : safeGoal(comparison),
  };
}

const safeGoal = (c) => { try { return deploymentGoal(c); } catch { return null; } };
