/**
 * PHASE 20 — CAN THIS ENVIRONMENT ACTUALLY BUILD IT? (§12, §28, §29)
 *
 * ═══ THE RULE THAT SHAPES EVERYTHING ═══
 *
 * §29: "validate ALL components/capabilities before writing ANY component."
 *
 * That is not a preference. Building an application is not one mutation, it is
 * ten or forty, and the failure mode §29 describes — creating six artifacts and
 * then discovering at step seven that the SDK is unavailable — leaves a real
 * instance holding half an application that nobody designed and no rollback can
 * honestly undo. §68.3 makes mutating before validating the complete
 * architecture a release blocker, and this file is where that is enforced:
 * `gate` returns EXECUTABLE only when every component is executable.
 *
 * There is deliberately no "build what you can" mode. A partial application is
 * not a smaller application; it is a broken one.
 *
 * ═══ WHERE A STATUS COMES FROM ═══
 *
 * `capability-discovery`, and nothing else. Not the plan, not the model, not a
 * cached answer, not the shape of the component. §68.10 makes a model inventing
 * a capability a release blocker, and the defence is that the model has no path
 * into this file — `discovered` is passed in by the caller and read.
 */
import { COMPONENT_CAPABILITY, COMPONENT_TOOL, STATUS, statusFor, isExecutable } from './schemas.js';

/**
 * Resolve every component against discovery.
 *
 * @param discovered  the object `discoverAll` produced
 * @param registry    the tool registry, so a component whose tool this build
 *                    does not have is caught here rather than at plan time
 */
export function resolveCapabilities({ components, discovered, registry = null }) {
  return components.map((component) => {
    const capability = COMPONENT_CAPABILITY[component.type] ?? null;
    const discoveredCap = capability ? discovered?.capabilities?.[capability] ?? null : null;
    const verdict = statusFor(discoveredCap);
    const tool = COMPONENT_TOOL[component.type] ?? null;

    /*
     * A capability can be available while the TOOL that performs it is absent
     * from this build. That is a real state — `catalog_ui_policy_authoring`
     * names `create_ui_policy`, and a build without it cannot act on the
     * capability however available discovery says it is.
     */
    const toolMissing = Boolean(tool) && registry && !registry.has(tool);
    if (toolMissing) {
      return {
        component: component.id,
        type: component.type,
        capability,
        mechanism: discoveredCap?.mechanism ?? null,
        tool,
        status: STATUS.UNSUPPORTED,
        executable: false,
        why: `${capability} resolves to the tool "${tool}", which is not in this build's registry.`,
      };
    }

    return {
      component: component.id,
      type: component.type,
      capability,
      mechanism: discoveredCap?.mechanism ?? null,
      tool,
      status: verdict.status,
      executable: isExecutable(verdict.status),
      requiresElevation: Boolean(discoveredCap?.requiresElevation),
      elevationRole: discoveredCap?.elevationRole ?? null,
      why: verdict.why,
    };
  });
}

/**
 * §29 — the all-or-nothing gate.
 *
 * @returns {{ executable, blocked, resolutions, summary, note }}
 *
 * `executable: true` means EVERY component can be built. Anything else means
 * nothing is built, and `blocked` names exactly which components and why —
 * §28's "report ARCHITECTURE READY / BUILD BLOCKED with exact unsupported
 * components".
 */
export function gate({ components, discovered, registry = null, collisions = [] }) {
  const resolutions = resolveCapabilities({ components, discovered, registry });
  const blocked = resolutions.filter((r) => !r.executable);

  /*
   * A collision is not a capability problem and blocks the build just as hard.
   * §18 says stop on collision, and folding it in here means there is ONE place
   * that decides whether a build may proceed rather than two that could
   * disagree.
   */
  const collisionBlocks = collisions.map((c) => ({
    component: c.component,
    type: 'collision',
    capability: null,
    status: STATUS.REQUIRES_MANUAL_ACTION,
    executable: false,
    why: c.why,
    differences: c.differences,
  }));

  const allBlocked = [...blocked, ...collisionBlocks];
  const summary = summarise(resolutions);

  return {
    executable: allBlocked.length === 0 && resolutions.length > 0,
    resolutions,
    blocked: allBlocked,
    summary,
    note: allBlocked.length
      ? `${allBlocked.length} of ${resolutions.length} component(s) cannot be built in this environment, so `
        + 'NOTHING is built. Creating the rest would leave a partial application that nobody designed.'
      : resolutions.length
        ? 'Every component resolves to a capability this environment has.'
        : 'There are no components to build.',
  };
}

/** The §69 capability tally. */
export function summarise(resolutions) {
  const out = {
    total: resolutions.length,
    [STATUS.SUPPORTED]: 0,
    [STATUS.REQUIRES_ELEVATION]: 0,
    [STATUS.REQUIRES_SDK]: 0,
    [STATUS.REQUIRES_SOURCE_CONTROL]: 0,
    [STATUS.REQUIRES_MANUAL_ACTION]: 0,
    [STATUS.UNSUPPORTED]: 0,
  };
  for (const r of resolutions) out[r.status] = (out[r.status] ?? 0) + 1;
  out.executable = resolutions.filter((r) => r.executable).length;
  out.blocked = resolutions.length - out.executable;
  return out;
}

/**
 * What a person needs to do about each blocked component (§3, §28).
 *
 * A blocked build should tell somebody what would unblock it. Each answer is
 * derived from the STATUS rather than written per component, so a new component
 * type gets the right advice without anybody remembering to add it.
 */
export function remediationFor(blocked) {
  const byStatus = new Map();
  for (const b of blocked) {
    if (!byStatus.has(b.status)) byStatus.set(b.status, []);
    byStatus.get(b.status).push(b.component);
  }
  const out = [];
  for (const [status, list] of byStatus) {
    out.push({
      status,
      components: list.sort(),
      what_would_unblock_it: UNBLOCK[status] ?? 'This build has no route to that capability.',
    });
  }
  return out.sort((a, b) => a.status.localeCompare(b.status));
}

const UNBLOCK = Object.freeze({
  [STATUS.REQUIRES_SDK]:
    'Install and authenticate the ServiceNow SDK on this machine, then re-run capability discovery. '
    + 'Until then these artifacts are authored in Studio by hand.',
  [STATUS.REQUIRES_SOURCE_CONTROL]:
    'Connect the application to source control; these artifacts travel through it rather than through the API.',
  [STATUS.REQUIRES_MANUAL_ACTION]:
    'A person has to resolve this — usually because something already exists and only a human can say '
    + 'whether it is the same thing.',
  [STATUS.REQUIRES_ELEVATION]:
    'This runs elevated. The existing elevation gate will ask; this builder never elevates itself.',
  [STATUS.UNSUPPORTED]:
    'There is no mechanism for this in this build. It cannot be created from here at all.',
});
