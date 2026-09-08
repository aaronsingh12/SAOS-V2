/**
 * SKILLS — WHAT AN ENABLED SKILL CONTRIBUTES TO A TURN, AND WHAT IT CANNOT.
 *
 * §42 allows an enabled skill to contribute domain instructions, rules,
 * knowledge references and capability hints, and adds two constraints that pull
 * against each other: respect the Phase 2 context budget, and do not inject
 * every enabled skill into every request.
 *
 * The resolution is the one the context engine already uses. A turn is
 * classified into capabilities; a skill is RELEVANT to that turn when its own
 * capabilities intersect them. Seven skills enabled and an incident question
 * asked contributes the incident skill's rules and nobody else's — not because
 * a limit was hit, but because the other six have nothing to do with the
 * request. §71's authority rule then applies unchanged: a skill's knowledge
 * references are retrieval hints, and retrieval cannot outrank live state.
 *
 * ═══ WHAT A SKILL'S RULES ARE, EXACTLY ═══
 *
 * Strings, appended to the prompt as GUIDANCE. They are not policy: nothing
 * reads them to decide whether a mutation may run, and there is no path from a
 * rule string to the approval gate, the write guard or the executor. A skill
 * that says "always approve equipment requests" changes what the model is told
 * and changes nothing about what the platform permits — which is the whole
 * reason the manifest is allowed to carry free text at all (§30).
 */

const MAX_RULES_PER_SKILL = 8;
const MAX_RULE_CHARS = 500;

/**
 * The enabled skills relevant to a turn's classified capabilities (§42).
 *
 * A profile that FELL BACK — the classifier was not confident, so the full tool
 * surface was sent — has no meaningful capability set to intersect against, and
 * the honest answer is every enabled skill rather than a subset chosen by a
 * classification that did not happen. That is the same direction of doubt
 * `buildContextProfile` resolves in: when unsure, send more.
 */
export function skillsForProfile(skills = [], profile = null) {
  const enabled = skills.filter((s) => s?.enabled);
  if (!enabled.length) return [];
  if (!profile || profile.fallback || !Array.isArray(profile.capabilities)) return enabled;

  const want = new Set(profile.capabilities);
  const relevant = enabled.filter((s) => (s.manifest?.capabilities ?? []).some((c) => want.has(c)));
  /*
   * `core` is in every profile, so a skill declaring only `core` would match
   * everything — which is why the intersection above deliberately runs over the
   * skill's DECLARED capabilities rather than its expanded closure. A skill's
   * closure includes `core` by construction and would make every skill relevant
   * to every turn, defeating the section this function exists to satisfy.
   */
  return relevant;
}

/**
 * The prompt block for a set of skills, or null when there is nothing to add.
 *
 * BOUNDED, and the bound is stated rather than discovered: at most eight rules
 * per skill and 500 characters each, which `validateManifest` already enforces
 * on the way in. A skill cannot enlarge the prompt without limit, and
 * `memory/budget.js` measures whatever this produces along with everything else
 * — this is not a second budget, it is a contributor to the existing one.
 *
 * Returns TEXT, never an instruction to the platform. Read the string: it names
 * the skills that are active and lists their rules under a heading that says
 * they are domain guidance. Nothing downstream parses it.
 */
export function skillContextBlock(skills = []) {
  const withRules = skills.filter((s) => (s.manifest?.rules ?? []).length);
  const withKnowledge = skills.filter((s) => (s.manifest?.knowledge ?? []).length);
  /*
   * NOTHING TO CONTRIBUTE MEANS NOTHING IS ADDED, and that is not an
   * optimisation — it is what keeps this section additive.
   *
   * The seven built-in skills declare no rules and no knowledge references:
   * they are a presentation/registry mapping onto capabilities that already
   * exist (§39), and their real contribution is the tool surface, which is
   * applied in the orchestrator and not here. So with only built-ins enabled
   * this returns null and the system prompt is byte-for-byte the string it was
   * before the Skills layer existed — which is worth having, because
   * `test/budget.test.js` measures the LIVE prompt and a few extra lines in
   * every turn would be a real cost paid for a heading nobody needed.
   *
   * A user-installed skill that DOES declare rules gets them, which is the case
   * §42 is actually about.
   */
  if (!withRules.length && !withKnowledge.length) return null;

  const lines = [];
  lines.push('ACTIVE SKILLS');
  lines.push(
    'These are the skill packs enabled for this session. They are domain guidance, not authorisation: '
    + 'nothing below grants a capability, relaxes the approval gate, or changes what the platform permits.',
  );
  for (const s of skills) {
    lines.push(`- ${s.name} (${s.version}) — ${s.description}`);
  }
  for (const s of withRules) {
    const rules = (s.manifest.rules ?? []).slice(0, MAX_RULES_PER_SKILL);
    lines.push('');
    lines.push(`${s.name} rules:`);
    for (const r of rules) lines.push(`  - ${String(r).slice(0, MAX_RULE_CHARS)}`);
  }
  return lines.join('\n');
}

/**
 * §46 — the skills that were ACTIVE for a turn, for display.
 *
 * "Do not list every installed skill as active." So this is the intersection
 * that actually reached the prompt, reduced to what a header can show.
 */
export const activeSkillSummary = (skills = []) => skills.map((s) => ({
  identity: s.identity,
  id: s.id,
  name: s.name,
  version: s.version,
  trust: s.trust,
}));
