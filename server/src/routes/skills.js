import { Router } from 'express';
import { TOOLS } from '../agent/tools.js';
import {
  listSkills, getSkill, installSkill, setSkillEnabled, uninstallSkill, NEVER,
} from '../agent/skills/index.js';

/**
 * EXPERIENCE §28–§46 — THE SKILL REGISTRY, OVER HTTP.
 *
 * FIVE VERBS, AND WHAT IS DELIBERATELY ABSENT. There is no route here that runs
 * a skill, executes a tool, approves anything or reaches ServiceNow — because a
 * skill is not a thing that runs (§29, §31). §75 lists what a client action may
 * be, and every one of these is on that list: enable a skill, disable a skill,
 * install one, remove one, look at one.
 *
 * THE LIVE REGISTRY IS INJECTED, not imported by the skills layer. This route
 * is the only file that holds both `TOOLS` and the registry at once, which is
 * what keeps `agent/skills/` free of any transitive path to a ServiceNow call —
 * the boundary §31 draws, asserted on the import graph by the safety suite.
 *
 * NOTHING IS FETCHED. §33 forbids downloading and executing arbitrary remote
 * skill code; a manifest arrives as JSON in a request body from the operator's
 * own browser, is validated against the live taxonomy and the live tool
 * registry, and is stored as data. There is no URL field to point anywhere.
 */
export const skillsRouter = Router();

const withTools = () => ({ tools: TOOLS });

/**
 * GET /api/skills
 *
 * §69 — everything installed, with its state and its COMPUTED permissions. A
 * skill listed here is not thereby safe to run: `state` says whether it is
 * enabled, disabled or blocked, and a blocked one cannot be turned on.
 */
skillsRouter.get('/', (_req, res) => {
  const skills = listSkills(withTools());
  res.json({
    skills,
    /* §32/§43 — the same for every skill, and stated once rather than per row. */
    never: NEVER,
    counts: {
      total: skills.length,
      enabled: skills.filter((s) => s.enabled).length,
      disabled: skills.filter((s) => !s.enabled && s.state === 'disabled').length,
      blocked: skills.filter((s) => s.state === 'blocked').length,
      built_in: skills.filter((s) => s.trust === 'built_in').length,
      installed: skills.filter((s) => s.trust !== 'built_in').length,
    },
  });
});

/** GET /api/skills/:identity — one skill, by `id@version`. */
skillsRouter.get('/:identity', (req, res, next) => {
  const skill = getSkill(req.params.identity, withTools());
  if (!skill) return next(Object.assign(new Error('No such skill.'), { status: 404 }));
  return res.json({ skill, never: NEVER });
});

/**
 * POST /api/skills  { manifest }
 *
 * §33/§34 — install. Validation is the gate and it runs against the live
 * platform, so a manifest naming a capability the taxonomy does not have or a
 * tool the registry does not expose is refused with the reason, not stored and
 * marked broken later.
 *
 * A refusal is a 400 carrying every error at once. Returning the first one
 * would make fixing a manifest a guessing game played one round-trip at a time.
 */
skillsRouter.post('/', (req, res, next) => {
  const manifest = req.body?.manifest ?? req.body;
  const result = installSkill(manifest, withTools());
  if (!result.ok) {
    return next(Object.assign(new Error(result.errors.join(' ')), {
      status: 400, detail: { errors: result.errors },
    }));
  }
  return res.status(201).json({ skill: result.skill });
});

/**
 * PATCH /api/skills/:identity  { enabled }
 *
 * §35 — on or off. The definition is untouched either way, and a skill that is
 * blocked (a conflict, a failed validation, a permission display that disagrees
 * with the computation) cannot be enabled from here or anywhere else.
 *
 * §45 — this does NOT reach into a running task. A task records the skill set
 * it opened under in its own metadata; changing the registry changes what the
 * NEXT task will see, and nothing about one already in flight.
 */
skillsRouter.patch('/:identity', (req, res, next) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return next(Object.assign(new Error('enabled must be true or false.'), { status: 400 }));
  }
  const result = setSkillEnabled(req.params.identity, enabled, withTools());
  if (!result.ok) {
    return next(Object.assign(new Error(result.errors.join(' ')), {
      status: result.skill ? 409 : 404, detail: { errors: result.errors },
    }));
  }
  return res.json({ skill: result.skill });
});

/** DELETE /api/skills/:identity — remove a user-installed skill. Built-ins refuse. */
skillsRouter.delete('/:identity', (req, res, next) => {
  const result = uninstallSkill(req.params.identity, withTools());
  if (!result.ok) {
    return next(Object.assign(new Error(result.errors.join(' ')), { status: 400, detail: { errors: result.errors } }));
  }
  return res.json({ ok: true });
});
