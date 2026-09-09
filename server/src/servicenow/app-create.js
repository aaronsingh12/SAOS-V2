import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { table, SnowError } from './client.js';
import { assertTiersAgree, readAppIdentity, buildWorkspace, installWorkspace } from './fluent.js';
import { refreshWorkspaces } from './workspaces.js';
import { log } from '../logging.js';

/**
 * WI-5 — creating a REAL custom application.
 *
 * THE DEFECT. `create_record` on `sys_scope` produced a record with
 * `sys_class_name: "sys_scope"`, an empty `scope`, and no version — a husk.
 * Studio does not list it and nothing can be developed inside it. The model had
 * correctly refused one turn earlier and then complied anyway with invented
 * field values, which is why the boundary is enforced in `tools.js` rather than
 * asked for in a prompt.
 *
 * The constructive half is here. `now-sdk init` DOES create a real application:
 * it scaffolds a workspace and `install` writes a `sys_app` record — the same
 * path that produced this project's own application. The build output even names it
 * (`dist/app/scope/sys_app_<scopeId>.xml`), which is the difference between an
 * application and a husk in one filename.
 *
 * Scope naming is the part that has to be right FIRST, because a bad prefix is
 * only a warning and then the app "may not install correctly" (§3):
 *
 *   - must start with the instance's vendor prefix, read live from
 *     `glide.appcreator.company.code` — never hardcoded;
 *   - 18 characters maximum, TOTAL. With a 10-character `x_<vendor>_` prefix
 *     that leaves 8 — and the vendor prefix is issued by the instance, so the
 *     budget is computed from the live one, never from a remembered value.
 *
 * So validation happens before anything is scaffolded, and it is pure and
 * offline-testable: getting told "two characters too long" costs a second,
 * while finding out after an install costs a broken application.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');

export const MAX_SCOPE_LENGTH = 18;
const INIT_TIMEOUT_MS = 4 * 60 * 1000;
/* An install ships the whole application; it is minutes, not seconds. */
const ESTABLISH_TIMEOUT_MS = 15 * 60 * 1000;

/** The vendor prefix this instance mints scopes under. Read, never assumed. */
export async function vendorPrefix() {
  const rows = await table.query('sys_properties', {
    query: 'name=glide.appcreator.company.code', fields: 'value', limit: 1, display: 'false',
  });
  const code = rows[0]?.value?.trim();
  if (!code) {
    throw new SnowError(
      'This instance does not publish glide.appcreator.company.code, so the vendor prefix a new scope must '
      + 'start with cannot be determined. Create the application in Studio instead, where the platform supplies it.',
      422,
    );
  }
  return `x_${code}_`;
}

/** kebab/space/camel → the short lowercase token that goes after the prefix. */
export function scopeSuffixFrom(appName, budget) {
  const slug = String(appName || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) return '';
  if (slug.length <= budget) return slug;

  // Too long. Truncating is the worst option and the last one: "Fleet
  // Management" becoming "fleet_ma" is a name nobody would have chosen. Try,
  // in order, the things a person would actually pick.
  const words = slug.split('_').filter(Boolean);
  if (words[0] && words[0].length <= budget) return words[0];              // "fleet"
  const initials = words.map((w) => w[0]).join('');
  if (words.length > 1 && initials.length <= budget) return initials;      // "fm"
  const squeezed = slug.replace(/[aeiou]/g, '');
  if (squeezed.length && squeezed.length <= budget) return squeezed;       // "flt_mngmnt"
  return slug.slice(0, budget).replace(/_+$/, '');
}

/** A legal scope name for this instance, derived from the application name. */
export function suggestScopeName(appName, prefix) {
  const budget = MAX_SCOPE_LENGTH - prefix.length;
  const suffix = scopeSuffixFrom(appName, budget);
  return suffix ? `${prefix}${suffix}` : '';
}

/**
 * Check a scope name against the two rules that produce a broken app rather
 * than an error. Pure: no instance, no filesystem.
 */
export function validateScopeName(scopeName, prefix) {
  const errors = [];
  const name = String(scopeName || '').trim();
  const budget = MAX_SCOPE_LENGTH - prefix.length;

  if (!name) errors.push('a scope name is required');
  if (name && !name.startsWith(prefix)) {
    errors.push(
      `the scope name must start with this instance's vendor prefix "${prefix}" — a mismatched prefix is only a `
      + 'WARNING at install time, and the application then may not install correctly',
    );
  }
  if (name.length > MAX_SCOPE_LENGTH) {
    errors.push(
      `the scope name is ${name.length} characters; the platform maximum is ${MAX_SCOPE_LENGTH}. `
      + `With the "${prefix}" prefix that leaves ${budget} characters for the name itself`,
    );
  }
  if (name && !/^[a-z0-9_]+$/.test(name)) errors.push('a scope name may contain only lowercase letters, digits and underscores');

  return { ok: errors.length === 0, errors, scopeName: name, prefix, budget };
}

/** Where a new workspace would go, and whether that is free. */
function workspacePathFor(scopeName) {
  const dir = path.join(SERVER_ROOT, `app-${scopeName}`);
  return { dir, exists: fs.existsSync(dir) };
}

/*
 * SESSION 1 / WI-4 — ONE APPLICATION, ONE DETERMINISTIC SCOPE.
 *
 * WHAT THIS REPLACES. `createApplication` used to derive a per-request scope
 * from whatever name the model passed, `now-sdk init` a fresh workspace
 * directory for it under server/, and stop there ("nothing is on the instance
 * yet"). Measured 2026-09-08: seven empty `server/app-x_*` directories from
 * seven failed attempts, each for a scope that will never hold anything —
 * every artifact NowForge authors lives in the workspace application
 * `x_<vendor>_nwforge`, and a second scope per request is a second place an
 * address can live (the class of defect the binding work removed).
 *
 * THE CONTRACT NOW. The scope is the workspace's, read from the tracked
 * identity file. If that application already exists on the bound instance the
 * call is REFUSED with `app_exists` as a first-class result — nothing written,
 * nothing scaffolded. If it is absent the call establishes it through
 * `establishApplication` (the existing, separately-guarded install path), which
 * is what "REQUIRES_MANUAL_ACTION with consent" means here: the tool is
 * mutating, the approval card names the install, and the read-back decides.
 *
 * The three probes are INPUTS, injectable for the offline suite: who the
 * workspace says it is, whether that scope exists, and the establisher.
 */
let appProbes = null;
export function _setApplicationProbesForTests(p) { appProbes = p && typeof p === 'object' ? p : null; }

async function scopeRowFor(scope) {
  const rows = await table.query('sys_scope', {
    query: `scope=${scope}`, fields: 'sys_id,name,scope,sys_class_name,version', limit: 1, display: 'false',
  });
  return rows[0] ?? null;
}

export async function createApplication({ name = null, description = '' } = {}) {
  const identity = await (appProbes?.identity ?? readAppIdentity)();
  const scope = identity?.scope;
  if (!scope) throw new SnowError('The workspace declares no application scope, so there is nothing to establish.', 500);

  const existing = await (appProbes?.exists ?? scopeRowFor)(scope);
  if (existing) {
    return {
      ok: false,
      refused: true,
      reason: 'app_exists',
      scope,
      sys_id: existing.sys_id ?? null,
      name: existing.name ?? identity.name ?? null,
      requestedName: name ? String(name).trim() : null,
      message:
        `The NowForge application already exists on the bound instance as "${existing.name ?? scope}" (scope ${scope}`
        + `${existing.sys_id ? `, sys_id ${existing.sys_id}` : ''}). Nothing was created: every artifact NowForge authors `
        + 'lives in that application, so build the tables, flows and catalog items inside it rather than a second scope.',
    };
  }

  const established = await (appProbes?.establish ?? establishApplication)({});
  return {
    ...established,
    scope: established?.scope ?? scope,
    requestedName: name ? String(name).trim() : null,
    description,
    note: established?.ok
      ? `${established.note ?? `Application ${scope} established.`} The scope is the workspace's own; the requested name `
        + `${name ? `"${String(name).trim()}" ` : ''}was recorded, not used to mint a second application.`
      : established?.message ?? established?.note ?? 'The application could not be established.',
  };
}

/**
 * WI-3 — ESTABLISH THE APPLICATION THE WORKSPACE ALREADY CLAIMS.
 *
 * ═══ THE GAP THIS CLOSES ═══
 *
 * `createApplication` scaffolds a NEW workspace directory for a NEW scope.
 * `deploy()` installs a workspace whose application ALREADY EXISTS on the
 * instance. Neither covers the state this project was actually in: a workspace
 * with 28 sources, a declared scope and a declared name, and no `sys_app` row
 * on the bound instance to install into.
 *
 * `assertAppBinding` refuses that install, correctly, and its message names the
 * remedy: "Re-establishing this application on the bound instance is a
 * deliberate action — a new scope name and a new app record — not something an
 * install should do as a side effect." This is that deliberate action. It is a
 * separate function with a separate approval, which is precisely what the guard
 * asks for.
 *
 * ═══ WHY THIS DOES NOT WEAKEN THE GUARD ═══
 *
 * The app-existence check is not skipped here; it is INVERTED. The ordinary
 * path refuses unless the scope EXISTS. This path refuses unless it is ABSENT.
 * The two conditions are mutually exclusive, so there is no instance state in
 * which both are permitted — nothing has been made reachable that was not
 * reachable before, and no call can choose the weaker of two checks.
 *
 * Everything else the preflight does still runs, unchanged and first:
 *   - an instance must be bound, with credentials the SDK can use;
 *   - the SDK must ECHO the same host the Table API reads (the two-tier check
 *     that catches a derivation bug);
 *   - the scope name must be legal under THIS instance's live vendor prefix.
 *
 * And the result is read back off the instance rather than parsed out of CLI
 * output, because "the CLI said it installed" is not evidence that a `sys_app`
 * row exists.
 */
export async function establishApplication({ emit = () => {} } = {}) {
  const identity = await readAppIdentity();
  const scope = identity.scope;
  const appName = identity.name ?? null;

  /* The host-agreement half of the preflight, in full. `probe: true` runs the
   * real authenticated round trip; only the app-existence clause is replaced. */
  emit({ type: 'binding_check' });
  const bound = await assertTiersAgree({ probe: true, expectMissingApp: true });
  emit({ type: 'binding_ok', host: bound.host });

  /* The name has to be legal HERE. A prefix minted by another instance can
   * never be registered on this one, and finding that out from the CLI is
   * slower and less clear than saying so now. */
  const prefix = await vendorPrefix();
  const check = validateScopeName(scope, prefix);
  if (!check.ok) {
    throw new SnowError(
      `The workspace claims scope "${scope}", which cannot be created on ${bound.host}:\n- ${check.errors.join('\n- ')}`,
      422, { errors: check.errors, prefix, scope },
    );
  }

  /* THE INVERSION. If it already exists there is nothing to establish, and the
   * ordinary install path is the one that applies. */
  const existing = await table.query('sys_scope', {
    query: `scope=${scope}`, fields: 'sys_id,name,scope,sys_class_name', limit: 1, display: 'false',
  });
  if (existing.length) {
    throw new SnowError(
      `"${scope}" already exists on ${bound.host} as "${existing[0].name}" (${existing[0].sys_id}). `
      + 'There is nothing to establish — install the workspace in the ordinary way.',
      409, { scope, existing: existing[0] },
    );
  }

  /* `install` ships dist/, which is only as fresh as the last build. */
  emit({ type: 'building' });
  const pre = await buildWorkspace();
  if (!pre.ok) {
    return { ok: false, stage: 'build', message: 'Build failed; nothing was installed and no application was created.' };
  }

  /*
   * `installWorkspace`, NOT a bare `runSdk(['install'])`.
   *
   * MEASURED on the first attempt: a direct install fails with
   * `now.config.json - error: requires property "scopeId"`. The SDK insists on
   * a scope sys_id, and the committed config deliberately does not carry one —
   * a sys_id is instance-local, and pinning one in a tracked file is the
   * "fourth pin" this project removed as a class.
   *
   * `withMaterializedConfig` is the mechanism that resolves that tension: it
   * writes the config WITH a scopeId for the duration of the call and restores
   * the committed shape in a `finally`. For a first install `resolveScopeId`
   * mints one (`minted-for-first-install`) and caches it per instance, so the
   * establish and every later install agree on the same id.
   *
   * Going through the shared wrapper also keeps this on the one serialized
   * queue — invariant (c) — rather than racing `dist/` with a concurrent build.
   */
  emit({ type: 'deploying' });
  const res = await installWorkspace({ timeoutMs: ESTABLISH_TIMEOUT_MS, emit });
  const output = `${res.stdout || ''}
${res.stderr || ''}`;

  /*
   * READ BACK. The CLI's own account of an install is not evidence that the
   * application exists — that is the whole discipline of this codebase, and it
   * applies most sharply to the call that is supposed to have created it.
   */
  const [scopeRow] = await table.query('sys_scope', {
    query: `scope=${scope}`, fields: 'sys_id,name,scope,sys_class_name,version', limit: 1, display: 'false',
  }).catch(() => []);
  const [appRow] = await table.query('sys_app', {
    query: `scope=${scope}`, fields: 'sys_id,name,scope,version', limit: 1, display: 'false',
  }).catch(() => []);

  if (!scopeRow) {
    return {
      ok: false,
      stage: 'install',
      message: `The install ran (exit ${res.code}) but no sys_scope row for "${scope}" exists on ${bound.host}. `
        + 'The application was NOT created.',
      detail: output.slice(0, 1500),
    };
  }

  return {
    ok: true,
    established: true,
    scope,
    requestedName: appName,
    /* What the INSTANCE says it is called, which is the only name that counts. */
    name: appRow?.name ?? scopeRow.name ?? null,
    scopeId: scopeRow.sys_id,
    appId: appRow?.sys_id ?? null,
    isApplication: Boolean(appRow),
    host: bound.host,
    installExit: res.code,
    note: appRow
      ? `Application "${appRow.name}" now exists on ${bound.host} at scope ${scope}.`
      : `A sys_scope row for ${scope} exists, but no sys_app record was found — the scope is registered and the `
        + 'application record is not. Artifacts may not appear in Studio.',
  };
}

/** Manual instructions, for when the SDK route is unavailable. */
export function studioSteps(prefix = 'x_<vendor>_') {
  return [
    'All → Studio → Create Application',
    'Give it a name and a scope. The scope must start with this instance\'s vendor prefix '
      + `("${prefix}") and be at most ${MAX_SCOPE_LENGTH} characters in total.`,
    'Studio creates a sys_app record — that is what makes it a real application rather than a bare sys_scope row.',
    'Once it exists, artifacts can be developed inside it.',
  ];
}
