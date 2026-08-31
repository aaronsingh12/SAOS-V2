import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { table, SnowError } from './client.js';
import { runSdk } from './fluent.js';
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
  ];
  log.info('sdk', `now-sdk init for ${check.scopeName} in ${dir}`);
  const res = await runSdk(args, INIT_TIMEOUT_MS, dir);

  if (!res.ok) {
    // Leave nothing half-scaffolded behind.
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new SnowError(
      `now-sdk init failed for scope "${check.scopeName}" (exit ${res.code}). The workspace directory was removed.`,
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
