import { getSettings, saveSkills } from '../../config/store.js';
import { log } from '../../logging.js';
import { BUILT_IN } from './builtin.js';
import { validateManifest, SKILL_TRUST, SKILL_STATE, SKILL_ID } from './manifest.js';
import { permissionsFor } from './permissions.js';

/**
 * SKILLS — THE REGISTRY.
 *
 * WHAT IT OWNS: which skills exist, which are on, what each one's identity is,
 * and what enabling one would actually permit. That is the complete list.
 *
 * WHAT IT DOES NOT OWN, and cannot: execution, approval, verification,
 * elevation, impersonation, the ServiceNow client, the database schema. There
 * is no import of any of them in this directory, and
 * `test/experience-safety.test.js` asserts that on the import graph rather than
 * trusting this paragraph — which is the same discipline `memory/tasks.js` and
 * `agent/evidence/` already follow.
 *
 * ═══ THE THREE RULES THAT DECIDE THE SHAPE ═══
 *
 * §37 — TWO SKILLS CLAIMING ONE IDENTIFIER IS A BLOCK, NEVER A CHOICE. Not
 * "last one wins", not "highest version wins": both are marked BLOCKED and
 * neither is offered to planning. Silently choosing is how a user ends up with
 * a skill they did not install shadowing the one they did.
 *
 * §36 — IDENTITY IS `id@version`. Installing 1.1.0 beside 1.0.0 does not
 * replace it; the two are different skills with different identities, and the
 * ID-level conflict rule above then applies. §36's "do not silently replace one
 * skill version with another" is therefore not a check that can be forgotten —
 * there is no code path that replaces.
 *
 * §35 — DISABLING IS NOT DELETING. The durable state is a list of DISABLED
 * identities; the definition stays exactly where it was. A built-in cannot be
 * deleted at all, only switched off.
 */

/**
 * §79.13 — THE MANIFEST'S PROSE MAY NOT DISAGREE WITH THE COMPUTATION.
 *
 * "Skill permission display disagrees with actual capability" is a release
 * blocker, and prose and a tool list cannot be compared word for word. What CAN
 * be compared is the claim they both make about whether this skill widens what
 * the agent may WRITE — and that is the claim that matters, because it is the
 * one a person is really answering when they approve a skill (§43).
 *
 * Both directions are refused. Understating is the dangerous one: a manifest
 * saying it changes nothing while its capabilities grant `delete_record` would
 * put a false reassurance in front of the person approving it. Overstating is
 * also refused, because a skill that claims a power it has not got teaches the
 * reader to distrust the display, which costs the same thing more slowly.
 *
 * This is what found the defect in our own built-ins: the Doctor declared no
 * change permission while `incident` implied `record_mutation`, and NowLint
 * declared none while `flow_authoring` granted `create_flow_live`. The
 * capability declarations were corrected; the check is what would have caught
 * them, so it stays.
 */
function permissionAgreement(manifest, permissions) {
  const declaresChange = (manifest.permissions?.change ?? []).length > 0;
  const grantsChange = permissions.can_change.length > 0;
  if (declaresChange === grantsChange) return [];
  return [declaresChange
    ? `"${manifest.id}" claims it can change things, but its capabilities `
      + `(${manifest.capabilities.join(', ')}) grant no mutating tool.`
    : `"${manifest.id}" declares no change permission, but its capabilities `
      + `(${manifest.capabilities.join(', ')}) grant ${permissions.can_change.length} mutating tool(s): `
      + `${permissions.can_change.slice(0, 6).join(', ')}. A skill may not understate what it permits.`];
}

/** A skill the registry could not validate is never enabled (§33, §38, §70). */
const toEntry = (manifest, { trust, enabled, state, errors = [], tools = [] }) => {
  /* §32/§43 — COMPUTED from the live registry, never read from the manifest. */
  const permissions = permissionsFor(manifest.capabilities, tools);
  const mismatch = manifest.capabilities.length ? permissionAgreement(manifest, permissions) : [];
  const allErrors = [...errors, ...mismatch];
  return Object.freeze({
    identity: SKILL_ID(manifest.id, manifest.version),
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    manifest,
    trust,
    /* A disagreeing manifest is never enabled, whatever the settings file says. */
    enabled: mismatch.length ? false : Boolean(enabled),
    state: mismatch.length ? SKILL_STATE.BLOCKED : state,
    errors: Object.freeze(allErrors),
    permissions,
  });
};

/**
 * The whole registry, resolved against the live tool registry.
 *
 * `tools` is INJECTED. The tool registry imports the ServiceNow client, and a
 * skills module that imported it could not be tested without an instance —
 * worse, it would give the skills layer a transitive path to a ServiceNow call,
 * which is exactly the boundary §31 draws. The route passes the live array; a
 * test passes a fixture; neither changes what this function decides.
 */
export function listSkills({ tools = [] } = {}) {
  const cfg = getSettings().skills ?? { installed: [], disabled: [] };
  const disabled = new Set(cfg.disabled ?? []);
  const knownTools = new Set(tools.map((t) => t.name));
  const entries = [];

  /* ---- the built-ins: code, always present, always trusted (§39, §70) ---- */
  for (const raw of BUILT_IN) {
    const { ok, errors, manifest } = validateManifest(raw, { knownTools });
    if (!ok) {
      /*
       * A built-in that fails its own validator is a defect in this repository,
       * not a user problem — so it is loud, and it is NOT offered. Shipping a
       * skill the platform cannot validate would make §38's "do not activate a
       * skill that fails required platform safety tests" a rule with an
       * exception carved out for us.
       */
      log.error('skills', `BUILT-IN skill "${raw.id}" failed validation: ${errors.join('; ')}`);
      entries.push(toEntry(
        { ...raw, capabilities: [], tools: [], rules: [], knowledge: [], permissions: { read: [], change: [], note: null } },
        { trust: SKILL_TRUST.UNVERIFIED, enabled: false, state: SKILL_STATE.BLOCKED, errors, tools },
      ));
      continue;
    }
    entries.push(toEntry(manifest, {
      trust: SKILL_TRUST.BUILT_IN,
      /* Built-ins are ON unless explicitly switched off (§35). */
      enabled: !disabled.has(SKILL_ID(manifest.id, manifest.version)),
      state: disabled.has(SKILL_ID(manifest.id, manifest.version)) ? SKILL_STATE.DISABLED : SKILL_STATE.ENABLED,
      tools,
    }));
  }

  /* ---- user-installed manifests, re-validated on every read ---- */
  for (const raw of cfg.installed ?? []) {
    const { ok, errors, manifest } = validateManifest(raw, { knownTools });
    if (!ok) {
      /*
       * RE-VALIDATED, not trusted because it validated once. A tool can be
       * removed from the registry between installs, and a skill naming it would
       * then display a permission the platform cannot honour — §79.13. So a
       * stored manifest that no longer validates is shown, marked, and NOT
       * enabled, rather than quietly disappearing.
       */
      entries.push(toEntry(
        {
          id: typeof raw?.id === 'string' ? raw.id : 'unknown',
          name: typeof raw?.name === 'string' ? raw.name : 'Unreadable skill',
          version: typeof raw?.version === 'string' ? raw.version : '0.0.0',
          description: 'This skill no longer validates against the platform.',
          capabilities: [], tools: [], rules: [], knowledge: [],
          permissions: { read: [], change: [], note: null },
        },
        { trust: SKILL_TRUST.UNVERIFIED, enabled: false, state: SKILL_STATE.BLOCKED, errors, tools },
      ));
      continue;
    }
    const identity = SKILL_ID(manifest.id, manifest.version);
    entries.push(toEntry(manifest, {
      trust: SKILL_TRUST.USER,
      /*
       * An installed skill is ON unless disabled — installation IS the consent,
       * and it already required the permission review (§43). What installation
       * does NOT do is grant anything beyond the manifest: `permissions` above
       * is computed from the capability taxonomy either way (§34).
       */
      enabled: !disabled.has(identity),
      state: disabled.has(identity) ? SKILL_STATE.DISABLED : SKILL_STATE.ENABLED,
      tools,
    }));
  }

  return applyConflicts(entries);
}

/**
 * §37 — two skills claiming one identifier BLOCK each other.
 *
 * Grouped by `id`, not by identity: 1.0.0 and 1.1.0 of the same skill are the
 * ambiguity this rule is about. Both are marked BLOCKED and neither is enabled,
 * and the error names the other version so the person can resolve it explicitly
 * — which is what "require explicit version resolution" means in practice.
 *
 * A built-in and a user skill sharing an id conflict too. Letting the built-in
 * win would be a silent choice, and letting the user skill win would let a
 * manifest shadow shipped behaviour under a trusted name.
 */
function applyConflicts(entries) {
  const byId = new Map();
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  const out = [];
  for (const [id, group] of byId) {
    if (group.length === 1) { out.push(group[0]); continue; }
    const versions = group.map((g) => g.version).join(', ');
    log.warn('skills', `skill id "${id}" is claimed by ${group.length} manifests (${versions}) — all are blocked`);
    for (const e of group) {
      out.push(Object.freeze({
        ...e,
        enabled: false,
        state: SKILL_STATE.BLOCKED,
        errors: Object.freeze([
          ...e.errors,
          `"${id}" is claimed by ${group.length} skills (versions ${versions}). `
          + 'Nothing is chosen automatically — remove one, or resolve the version explicitly.',
        ]),
      }));
    }
  }
  return out;
}

/** The enabled ones, which is what planning is allowed to see (§40, §41). */
export function enabledSkills({ tools = [] } = {}) {
  return listSkills({ tools }).filter((s) => s.enabled && s.state === SKILL_STATE.ENABLED);
}

export function getSkill(identity, { tools = [] } = {}) {
  return listSkills({ tools }).find((s) => s.identity === identity) ?? null;
}

/**
 * §33/§34 — install a user manifest.
 *
 * VALIDATION FIRST, and it is the only gate: manifest validation, capability
 * validation and permission validation all happen inside `validateManifest`
 * against the live taxonomy and the live tool registry. §33's fourth
 * requirement — test validation — is the platform suite, which is why a skill
 * cannot introduce a code path for a test to have to cover (§72).
 *
 * NOTHING IS DOWNLOADED. There is no URL, no fetch and no module load anywhere
 * in this directory; a manifest arrives as JSON in a request body, from the
 * operator's own browser. §33's "do not download and execute arbitrary remote
 * skill code" is met by there being no code and no download.
 */
export function installSkill(raw, { tools = [] } = {}) {
  const knownTools = new Set(tools.map((t) => t.name));
  const { ok, errors, manifest } = validateManifest(raw, { knownTools });
  if (!ok) return { ok: false, errors, skill: null };

  /*
   * §43 — the permission review is part of installation, not something the
   * registry discovers afterwards. Refusing here means the person is told what
   * is wrong while they can still fix it, rather than finding a BLOCKED skill
   * in the list with no idea why it did not turn on.
   */
  const mismatch = permissionAgreement(manifest, permissionsFor(manifest.capabilities, tools));
  if (mismatch.length) return { ok: false, errors: mismatch, skill: null };

  const existing = listSkills({ tools });
  const clash = existing.find((s) => s.id === manifest.id);
  if (clash) {
    /*
     * REFUSED AT THE DOOR rather than installed-then-blocked. Both outcomes are
     * safe — `applyConflicts` would block the pair — but a refusal tells the
     * person what happened at the moment they can still do something about it,
     * where a silent install would take away a skill that was working.
     */
    return {
      ok: false,
      skill: null,
      errors: [
        `"${manifest.id}" is already installed at version ${clash.version}`
        + `${clash.trust === SKILL_TRUST.BUILT_IN ? ' as a built-in skill' : ''}. `
        + 'Two skills may not claim one identifier — remove the existing one first.',
      ],
    };
  }

  const cfg = getSettings().skills ?? { installed: [], disabled: [] };
  saveSkills({ installed: [...(cfg.installed ?? []), manifest], disabled: cfg.disabled ?? [] });
  log.info('skills', `installed ${SKILL_ID(manifest.id, manifest.version)} (${manifest.capabilities.join(', ')})`);
  return { ok: true, errors: [], skill: getSkill(SKILL_ID(manifest.id, manifest.version), { tools }) };
}

/**
 * §35 — turn a skill on or off. The definition is never touched.
 *
 * A BLOCKED skill cannot be enabled. That covers both the conflict case and the
 * failed-validation case, and it is the difference between §69's "Available"
 * and "safe to run": listing a skill is not a claim that it may be activated.
 */
export function setSkillEnabled(identity, enabled, { tools = [] } = {}) {
  const skill = getSkill(identity, { tools });
  if (!skill) return { ok: false, errors: [`No such skill: ${identity}`], skill: null };
  if (enabled && skill.state === SKILL_STATE.BLOCKED) {
    return { ok: false, errors: skill.errors.length ? [...skill.errors] : ['This skill is blocked and cannot be enabled.'], skill };
  }

  const cfg = getSettings().skills ?? { installed: [], disabled: [] };
  const disabled = new Set(cfg.disabled ?? []);
  if (enabled) disabled.delete(identity); else disabled.add(identity);
  saveSkills({ installed: cfg.installed ?? [], disabled: [...disabled] });
  log.info('skills', `${identity} ${enabled ? 'enabled' : 'disabled'}`);
  return { ok: true, errors: [], skill: getSkill(identity, { tools }) };
}

/**
 * Remove a USER-INSTALLED skill. A built-in cannot be removed, only disabled.
 *
 * §35 forbids deleting a definition "merely to disable it" — this is the other
 * case, an explicit uninstall, and it is refused for built-ins because their
 * definition is code and removing it from a settings file would not remove it.
 */
export function uninstallSkill(identity, { tools = [] } = {}) {
  const skill = getSkill(identity, { tools });
  if (!skill) return { ok: false, errors: [`No such skill: ${identity}`] };
  if (skill.trust === SKILL_TRUST.BUILT_IN) {
    return { ok: false, errors: ['A built-in skill cannot be removed. Disable it instead.'] };
  }
  const cfg = getSettings().skills ?? { installed: [], disabled: [] };
  saveSkills({
    installed: (cfg.installed ?? []).filter((m) => SKILL_ID(m.id, m.version) !== identity),
    disabled: (cfg.disabled ?? []).filter((d) => d !== identity),
  });
  log.info('skills', `uninstalled ${identity}`);
  return { ok: true, errors: [] };
}
