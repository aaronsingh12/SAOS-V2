import { CAPABILITIES } from '../context-capabilities.js';

/**
 * SKILLS — THE MANIFEST, AND WHAT IT IS NOT ALLOWED TO CONTAIN.
 *
 * §29 asks for a minimal manifest and adds one prohibition that decides the
 * whole design: "Do not allow arbitrary executable code in manifests." §31 adds
 * the rest of it — a skill may never reach ServiceNow credentials, raw HTTP,
 * the SDK, the database, the approval implementation or the verification
 * implementation.
 *
 * So a manifest is DATA, and every field below is either a string, a number or
 * a list of strings drawn from a vocabulary that already exists elsewhere in
 * this codebase. There is no field a function could be written into, no `script`,
 * no `hook`, no `handler`, no path to a module — and `validate` refuses any key
 * it does not recognise, so adding one is a validation failure rather than a
 * quiet extension point.
 *
 * ═══ THE CONSEQUENCE, STATED PLAINLY ═══
 *
 * A skill cannot DO anything. It names capabilities the platform already has,
 * tools the registry already exposes, rules the prompt layer already carries and
 * knowledge the retrieval layer already indexes. Enabling one changes which of
 * those the planner may see; it cannot add a new one, and §72's "a skill cannot
 * silently introduce a new execution path" is therefore structural rather than
 * a rule someone has to keep.
 *
 * ═══ TRUST (§70) ═══
 *
 * Trust is assigned by the REGISTRY, never by the manifest. A manifest that
 * declared itself `built_in` would be claiming an authority it cannot have, so
 * `trust` is refused as an input key and stamped on the way in.
 */

/** §70 — where a skill came from, and therefore how far it is trusted. */
export const SKILL_TRUST = Object.freeze({
  BUILT_IN: 'built_in',       // ships with NowForge; maps to existing domains
  VERIFIED: 'verified',       // reviewed and signed off by an operator
  USER: 'user_installed',     // installed locally, validated, not reviewed
  UNVERIFIED: 'unverified',   // failed or skipped validation — never elevated
});

export const SKILL_TRUSTS = Object.freeze(Object.values(SKILL_TRUST));

/** §69 — what the Add Skill list may say about a skill it is showing. */
export const SKILL_STATE = Object.freeze({
  ENABLED: 'enabled',
  DISABLED: 'disabled',
  UNSUPPORTED: 'unsupported',   // its capabilities are not available here
  BLOCKED: 'blocked',           // an identity conflict; §37 refuses to choose
});

export const SKILL_STATES = Object.freeze(Object.values(SKILL_STATE));

/**
 * The complete key list. Anything else is a validation error.
 *
 * Closed on purpose (§29). An open manifest is how "just one small hook" turns
 * into an execution path nobody reviewed.
 */
export const MANIFEST_KEYS = Object.freeze([
  'id', 'name', 'version', 'description',
  'capabilities', 'tools', 'rules', 'knowledge', 'permissions',
]);

/** §36 — identity is `id@version`, and both halves are constrained. */
const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Keys that would make a manifest executable, or would let it claim authority
 * it has not got. Refused BY NAME, with a message that says why, so a manifest
 * carrying one fails loudly instead of having it silently ignored.
 */
const FORBIDDEN_KEYS = Object.freeze({
  script: 'a skill may not carry code (§29)',
  code: 'a skill may not carry code (§29)',
  handler: 'a skill may not carry code (§29)',
  hook: 'a skill may not carry code (§29)',
  exec: 'a skill may not carry code (§29)',
  execute: 'a skill may not carry code (§29)',
  eval: 'a skill may not carry code (§29)',
  require: 'a skill may not load modules (§31)',
  import: 'a skill may not load modules (§31)',
  module: 'a skill may not load modules (§31)',
  url: 'a skill may not fetch anything (§33)',
  endpoint: 'a skill may not reach the network (§31)',
  credentials: 'a skill may never carry credentials (§31, §79.9)',
  connection: 'a skill may never carry a connection (§31, §79.9)',
  instance: 'a skill may not name an instance (§31)',
  trust: 'trust is assigned by the registry, never claimed by a manifest (§70)',
  elevate: 'a skill may not request elevation (§79.11)',
  impersonate: 'a skill may not request impersonation (§79.12)',
});

export const SKILL_ID = (id, version) => `${id}@${version}`;

const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());

/**
 * Validate one manifest against the LIVE platform (§33).
 *
 * `knownTools` is injected rather than imported so this module stays free of
 * the tool registry — the registry imports ServiceNow clients, and a validator
 * that dragged those in could not run in a test without an instance. The caller
 * supplies the real set; `registry.js` passes the live one.
 *
 * Returns `{ ok, errors, manifest }`. `manifest` is a NORMALISED copy — frozen,
 * with every list de-duplicated and sorted — so two manifests that differ only
 * in the order they listed their capabilities have the same identity and the
 * same rendering.
 */
export function validateManifest(input, { knownTools = new Set(), knownCapabilities = CAPABILITIES } = {}) {
  const errors = [];
  const push = (m) => errors.push(m);

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['a skill manifest must be an object'], manifest: null };
  }

  for (const [key, why] of Object.entries(FORBIDDEN_KEYS)) {
    if (Object.prototype.hasOwnProperty.call(input, key)) push(`"${key}" is not allowed: ${why}`);
  }
  for (const key of Object.keys(input)) {
    if (!MANIFEST_KEYS.includes(key) && !Object.prototype.hasOwnProperty.call(FORBIDDEN_KEYS, key)) {
      push(`unknown manifest key "${key}"`);
    }
  }

  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!ID_RE.test(id)) push('id must be kebab-case, e.g. "cmdb-investigator"');

  const version = typeof input.version === 'string' ? input.version.trim() : '';
  if (!VERSION_RE.test(version)) push('version must be semver, e.g. "1.0.0"');

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) push('name is required');
  if (name.length > 60) push('name must be 60 characters or fewer');

  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!description) push('description is required');
  if (description.length > 400) push('description must be 400 characters or fewer');

  const capabilities = input.capabilities ?? [];
  if (!isStringList(capabilities)) push('capabilities must be a list of strings');
  else {
    if (!capabilities.length) push('a skill must declare at least one capability');
    for (const c of capabilities) {
      if (!knownCapabilities.includes(c)) {
        push(`unknown capability "${c}" — capabilities come from the platform taxonomy, not from the manifest`);
      }
    }
  }

  /*
   * §33 — capability validation. A tool a skill names must EXIST. A manifest
   * that lists a tool the registry has never had is not a skill for a future
   * platform, it is a skill whose permissions display would be a lie (§79.13).
   */
  const tools = input.tools ?? [];
  if (!isStringList(tools)) push('tools must be a list of strings');
  else {
    for (const t of tools) {
      if (knownTools.size && !knownTools.has(t)) push(`unknown tool "${t}" — it is not in the live registry`);
    }
  }

  const rules = input.rules ?? [];
  if (!isStringList(rules)) push('rules must be a list of strings');
  else if (rules.some((r) => r.length > 500)) push('each rule must be 500 characters or fewer');

  const knowledge = input.knowledge ?? [];
  if (!isStringList(knowledge)) push('knowledge must be a list of strings');

  /*
   * §32/§43 — permissions are DECLARATIVE and INFORMATIONAL here. What a skill
   * may actually do is derived from the capability taxonomy and the registry's
   * own `mutating` flag (see permissions.js), never from this object — which is
   * exactly why the manifest cannot grant itself anything by writing it down.
   */
  const permissions = input.permissions ?? {};
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
    push('permissions must be an object');
  } else {
    for (const key of Object.keys(permissions)) {
      if (!['read', 'change', 'note'].includes(key)) push(`unknown permission key "${key}"`);
    }
    if (permissions.read !== undefined && !isStringList(permissions.read)) push('permissions.read must be a list of strings');
    if (permissions.change !== undefined && !isStringList(permissions.change)) push('permissions.change must be a list of strings');
    /*
     * `null` is allowed as well as absent, and that is not laxness — it is what
     * this function's OWN normalised output writes for "no note". Refusing it
     * meant a manifest could not survive a round trip through its own
     * validator, and since the registry re-validates every stored manifest on
     * every read, an installed skill would have turned itself BLOCKED the
     * moment it was read back.
     */
    if (permissions.note !== undefined && permissions.note !== null && typeof permissions.note !== 'string') {
      push('permissions.note must be a string');
    }
  }

  if (errors.length) return { ok: false, errors, manifest: null };

  const uniqSorted = (l) => Object.freeze([...new Set(l)].sort());
  return {
    ok: true,
    errors: [],
    manifest: Object.freeze({
      id,
      name,
      version,
      description,
      capabilities: uniqSorted(capabilities),
      tools: uniqSorted(tools),
      rules: Object.freeze([...rules]),
      knowledge: uniqSorted(knowledge),
      permissions: Object.freeze({
        read: uniqSorted(permissions.read ?? []),
        change: uniqSorted(permissions.change ?? []),
        note: permissions.note ?? null,
      }),
    }),
  };
}
