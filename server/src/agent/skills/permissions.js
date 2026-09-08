import { TOOL_CAPABILITIES, expandCapabilities } from '../context-capabilities.js';

/**
 * SKILLS — WHAT A SKILL CAN ACTUALLY DO, DERIVED RATHER THAN DECLARED.
 *
 * §79.13 makes it a release blocker for the permission display to disagree with
 * the actual capability. There is exactly one way to guarantee that and it is
 * not careful bookkeeping: the display has to be COMPUTED from the same data
 * the platform enforces with.
 *
 * So nothing here reads `manifest.permissions`. The inputs are:
 *
 *   the skill's declared capabilities        validated against the taxonomy
 *   `TOOL_CAPABILITIES`                      the live capability -> tool map
 *   the registry's own `mutating` flag       the same bit the approval gate reads
 *
 * A skill whose capabilities expose no mutating tool CANNOT be shown as able to
 * change anything, because there is no tool it could change anything with — and
 * if someone adds one to the taxonomy later, this display changes with it on
 * the next call rather than going quietly stale.
 *
 * ═══ THE FOUR THINGS NO SKILL MAY EVER DO ═══
 *
 * §79.10 to §79.12 forbid a skill mutating ServiceNow directly, self-elevating
 * or impersonating, and §31 forbids it reaching credentials, raw HTTP, the SDK,
 * the database, the approval implementation or the verification implementation.
 *
 * None of those is enforced HERE, and that is the point worth being clear
 * about. They are enforced by the architecture: a manifest cannot carry code
 * (manifest.js), a skill never reaches `executeTool` (only the orchestrator
 * does), elevation runs through the existing gate, and impersonation through
 * the existing mode. This function only REPORTS those boundaries so a person
 * approving a skill can see them — and it reports them as constants, because
 * they are the same for every skill and a per-skill answer would imply some
 * skill could differ.
 */

/** §32/§43 — true of every skill, always, and not derived from any manifest. */
export const NEVER = Object.freeze([
  'elevate its own privileges',
  'impersonate a user',
  'reach ServiceNow credentials',
  'call ServiceNow directly',
  'approve its own changes',
  'decide that a change was verified',
]);

/**
 * A capability that grants a mutating tool is a "change" capability. Computed,
 * not listed — so a taxonomy edit cannot leave this behind.
 */
function mutatingCapabilities(tools) {
  const out = new Set();
  for (const t of tools) {
    if (!t?.mutating) continue;
    for (const c of TOOL_CAPABILITIES[t.name] ?? []) out.add(c);
  }
  return out;
}

/**
 * The permissions a set of capabilities actually confers, against a live registry.
 *
 * `tools` is the LIVE registry array, injected. The capability closure runs
 * first (`expandCapabilities`), because that is what the context engine does
 * before selecting tools — a display computed from the unexpanded list would
 * under-report, and under-reporting a mutation capability is the direction that
 * matters.
 */
export function permissionsFor(capabilities = [], tools = []) {
  const caps = new Set(expandCapabilities(capabilities));
  const granted = tools.filter((t) => {
    const tc = TOOL_CAPABILITIES[t.name];
    /*
     * An UNCLASSIFIED tool is global in `selectTools`, so it is granted here
     * too. Reporting it as not-granted would make the display disagree with the
     * enforcement in the safe-looking direction, which is still a disagreement.
     */
    if (!tc) return true;
    return tc.some((c) => caps.has(c));
  });

  const reads = granted.filter((t) => !t.mutating).map((t) => t.name).sort();
  const changes = granted.filter((t) => t.mutating).map((t) => t.name).sort();
  const changeCaps = [...mutatingCapabilities(granted)].filter((c) => caps.has(c)).sort();

  return Object.freeze({
    capabilities: Object.freeze([...caps].sort()),
    /* §32 — the two lists a person needs before enabling a skill. */
    can_read: Object.freeze(reads),
    can_change: Object.freeze(changes),
    change_capabilities: Object.freeze(changeCaps),
    /* §43 — does enabling this skill widen what the agent may WRITE? */
    mutating: changes.length > 0,
    never: NEVER,
    tool_count: granted.length,
  });
}

/**
 * §41 — the tools left after DISABLING skills. Subtraction, never selection.
 *
 * ═══ THE DEFECT THIS SHAPE EXISTS TO PREVENT, WHICH WAS MEASURED ═══
 *
 * The first version of this function selected: a tool was offered when some
 * ENABLED skill covered it. With all seven built-ins on — the default, and a
 * state in which the user has disabled nothing — it removed eleven tools:
 * the whole SLA surface, the update-set reader and every impersonation verb.
 * Nothing claims those capabilities, because no built-in skill is about them,
 * so "no skill covers it" silently meant "it does not exist" and the platform
 * quietly lost capability nobody had switched off. `context-engine.test.js`
 * caught it: `create_sla` came back as a skill refusal instead of the
 * not-in-context widening the model is supposed to receive.
 *
 * So the rule is the one §41 actually writes down — "if a user disables Doctor,
 * the planner must not use DOCTOR-ONLY capabilities". Only-ness is the whole
 * idea, and it makes the operation a subtraction:
 *
 *   removed  = capabilities(disabled skills) - capabilities(enabled skills)
 *   dropped  = tools whose EVERY capability is in `removed`
 *
 * Two properties follow, and both matter. Disabling nothing removes nothing, so
 * the default state is byte-for-byte the behaviour that existed before this
 * layer. And a capability no skill claims is never in `removed`, so the Skills
 * system can only take away what it was given — it cannot become a second,
 * accidental policy engine over the whole registry.
 *
 * `core` is never removed, even if every skill is disabled. The operating rules
 * require it — rule 1 needs `lookup_reference`, rules 2 and 17 need
 * `get_table_schema` — so a turn without it would contradict its own prompt.
 */
export function toolsForSkills(tools, skills = []) {
  const enabled = skills.filter((s) => s?.enabled);
  const disabled = skills.filter((s) => s && !s.enabled);
  if (!disabled.length) return { tools, restricted: false, removed: [], capabilities: [] };

  const kept = new Set(expandCapabilities(enabled.flatMap((s) => s.manifest?.capabilities ?? [])));
  const gone = new Set(expandCapabilities(disabled.flatMap((s) => s.manifest?.capabilities ?? [])));
  for (const c of kept) gone.delete(c);
  gone.delete('core');
  if (!gone.size) return { tools, restricted: false, removed: [], capabilities: [...kept].sort() };

  const allowed = tools.filter((t) => {
    const tc = TOOL_CAPABILITIES[t.name];
    /* Unclassified is global in `selectTools`; it is global here too. */
    if (!tc || !tc.length) return true;
    /* Dropped only when EVERY capability it has was removed. */
    return !tc.every((c) => gone.has(c));
  });

  /*
   * A selection that kept nothing is not a selection — the same rule
   * `buildContextProfile` applies for the same reason. Falling back is the
   * honest failure: it is reported, and the alternative is a turn that cannot
   * run at all because a capability map went stale.
   */
  if (!allowed.length) return { tools, restricted: false, removed: [], capabilities: [...kept].sort() };

  return {
    tools: allowed,
    restricted: allowed.length < tools.length,
    removed: [...gone].sort(),
    capabilities: [...kept].sort(),
  };
}
