/**
 * SKILLS — the public surface, and the boundary (§31, §73).
 *
 * Everything below is configuration, validation and selection. There is no
 * ServiceNow client, no database write, no approval, no verification and no
 * executor anywhere in this directory, and the import graph is asserted rather
 * than described: `test/experience-safety.test.js` fails if a file here ever
 * imports one.
 */

export {
  SKILL_TRUST, SKILL_TRUSTS, SKILL_STATE, SKILL_STATES,
  MANIFEST_KEYS, SKILL_ID, validateManifest,
} from './manifest.js';

export { BUILT_IN, BUILT_IN_IDS } from './builtin.js';
export { NEVER, permissionsFor, toolsForSkills } from './permissions.js';
export {
  listSkills, enabledSkills, getSkill, installSkill, setSkillEnabled, uninstallSkill,
} from './registry.js';
export { skillsForProfile, skillContextBlock, activeSkillSummary } from './context.js';

/**
 * §44/§45 — THE SKILL SET A TASK RAN UNDER, RECORDED WHEN IT OPENED.
 *
 * The rule §45 states is that disabling a skill while a task is running must
 * not mutate the active approved plan; the running task continues under its
 * already-established execution contract, and future planning uses the new set.
 *
 * That is only enforceable if the task's set is a SNAPSHOT rather than a live
 * lookup. So this is what `beginTurn` records into `agent_tasks.metadata_json`
 * — an existing column, no migration — and what the activity projection reads
 * back. A task's answer to "which skills was this run under" therefore comes
 * from the task, and the registry cannot rewrite history by being edited.
 *
 * It is also what stops §79.14. The task row carries its own set, so one
 * session's skill state is never read as another's: there is no shared
 * in-memory map keyed by session, no module-level cache, and nothing here to
 * leak across.
 */
export function skillSnapshot(skills = []) {
  return skills
    .filter((s) => s?.enabled)
    .map((s) => ({ identity: s.identity, id: s.id, version: s.version, name: s.name }))
    .sort((a, b) => a.identity.localeCompare(b.identity));
}
