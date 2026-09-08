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

/**
 * Scaffold a real custom application through the SDK.
 *
 * Deliberately stops after `init`. `install` ships a whole application to the
 * instance and is a separate, separately-approved step (trap #8) — and a tool
 * that scaffolded AND installed in one call would make "create an app" a much
 * larger action than it reads as. What comes back names the exact next command.
 */
export async function createApplication({ name, scopeName = null, description = '' } = {}) {
  if (!name || !String(name).trim()) throw new SnowError('An application name is required.', 400);

  const prefix = await vendorPrefix();
  const proposed = scopeName || suggestScopeName(name, prefix);
  const check = validateScopeName(proposed, prefix);
  if (!check.ok) {
    throw new SnowError(
      `The scope name "${proposed}" cannot be used on this instance:\n- ${check.errors.join('\n- ')}\n\n`
      + `A name derived from "${name}" that would work: ${suggestScopeName(name, prefix) || `${prefix}<up to ${check.budget} chars>`}`,
      422,
      { errors: check.errors, prefix, budget: check.budget },
    );
  }

  // Already on the instance? Creating a second app at the same scope is not
  // possible, and finding out from the SDK is slower and less clear.
  const existing = await table.query('sys_scope', {
    query: `scope=${check.scopeName}`, fields: 'sys_id,name,scope,sys_class_name', limit: 1, display: 'false',
  });
  if (existing.length) {
    throw new SnowError(
      `Scope "${check.scopeName}" already exists on this instance as "${existing[0].name}" `
      + `(${existing[0].sys_class_name}, sys_id ${existing[0].sys_id}). Pick a different scope name.`,
      409,
    );
  }

  const { dir, exists } = workspacePathFor(check.scopeName);
  if (exists) throw new SnowError(`A workspace directory already exists at ${dir}. Remove it or choose another scope name.`, 409);

  await fsp.mkdir(dir, { recursive: true });
  const args = [
    'init',
    '--appName', String(name).trim(),
    '--packageName', check.scopeName.replace(/_/g, '-'),
    '--scopeName', check.scopeName,
    /*
     * `--template` IS NOT OPTIONAL FOR US, AND OMITTING IT IS WHY THIS HUNG.
     *
     * MEASURED against SDK 4.10.1 on 2026-09-07. `now-sdk init` with every
     * other flag supplied still stops and renders an interactive template
     * picker ("Select a template: > now-sdk boilerplate ..."). There is no
     * default. Under `execFile` the child's stdin is a pipe nobody writes to,
     * so the picker waits, the 4-minute timeout kills the process, and the
     * caller sees `exit -1` — a killed process, with no clue that a prompt was
     * the reason.
     *
     * With stdin at /dev/null the same command instead prints
     * "ERROR: User force closed the prompt with 0 null", which is the same
     * defect wearing a readable message.
     *
     * `base` is the boilerplate template — "an empty NowSDK application with
     * only the necessary boilerplate" — which is what a Fluent app scaffolded
     * by this tool should be. Anything else would ship React or Vue starters
     * into a workspace that only ever holds `.now.ts` sources.
     */
    '--template', 'base',
  ];
  log.info('sdk', `now-sdk init for ${check.scopeName} in ${dir}`);
  const res = await runSdk(args, INIT_TIMEOUT_MS, dir);

  if (!res.ok) {
    // Leave nothing half-scaffolded behind.
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    /*
     * A KILLED PROCESS AND A REJECTED COMMAND ARE DIFFERENT FAILURES.
     *
     * `runSdk` reports `code: -1` for both a signal kill and an unset exit
     * code, so "exit -1" alone sent the last investigation looking for an
     * argument-parsing bug that did not exist. `timedOut` is the fact that
     * separates them, and it is now said out loud.
     */
    const why = res.timedOut
      ? `it did not finish within ${Math.round(INIT_TIMEOUT_MS / 1000)}s and was killed. The CLI prompts `
        + 'interactively when a required choice is missing, and a prompt with no terminal waits forever'
      : `it exited with code ${res.code}`;
    throw new SnowError(
      `now-sdk init failed for scope "${check.scopeName}": ${why}. The workspace directory was removed.`,
      502, (res.stderr || res.stdout || '').slice(0, 1200),
    );
  }

  refreshWorkspaces();
  const config = await fsp.readFile(path.join(dir, 'now.config.json'), 'utf8').then(JSON.parse).catch(() => null);

  return {
    ok: true,
    scaffolded: true,
    installed: false,
    name: String(name).trim(),
    scope: check.scopeName,
    prefix,
    workspace: dir,
    config,
    description,
    // Said plainly, because "created" would be the same overclaim this whole
    // work item exists to stop: nothing is on the instance yet.
    note:
      `The application workspace was scaffolded at ${dir} with scope "${check.scopeName}". `
      + 'Nothing exists on the instance yet — a scoped application is created there by INSTALLING it, which ships '
      + 'the whole application and is a separate approved step. It will appear in Studio once installed.',
    nextStep: `cd ${dir} && now-sdk install`,
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
