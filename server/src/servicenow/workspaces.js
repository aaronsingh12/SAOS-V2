import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The SDK workspace registry.
 *
 * There has only ever been one workspace — `server/fluent-workspace`, scope
 * `x_2002152_nwforge` — and `fluent.js` reaches it through a module-level
 * constant. That is correct for authoring, where every managed source belongs
 * to the one application we install. It is not enough for two questions this
 * phase asks:
 *
 *   1. "which of the 743 scopes on this instance do WE manage?" — the
 *      Applications page needs an answer that is derived, not hardcoded, or it
 *      becomes another stale platform list (trap #28);
 *   2. "which scoped update set does this row belong in?" — the capture sweep
 *      keys on the ROW's application (§33 / trap #72), so it needs to look a
 *      scope up rather than assume the only one it knows.
 *
 * So the mapping scope → workspace becomes DATA that is discovered by scanning
 * for `now.config.json`, rather than a constant that happens to be right while
 * the count is one. Adding a second scoped application is then a directory,
 * not an edit here.
 *
 * Deliberately NOT done: this module does not create workspaces, install, or
 * spawn the SDK. It answers "what is on disk, and what scope does it claim".
 * `fluent.js` remains the only thing that runs `now-sdk`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');

/**
 * Where workspaces may live. A list, so the second entry is a one-line change
 * and the scan below never needs to grow a special case.
 */
const SEARCH_ROOTS = [SERVER_ROOT];

/** A workspace is any directory holding a now.config.json. */
const CONFIG_NAME = 'now.config.json';

/**
 * Discovery is cached for the process, because the Applications page and every
 * capture sweep both call it and neither should stat the disk per request. The
 * cache is invalidated by `refreshWorkspaces()`, which the routes call on any
 * operation that could add one.
 */
let cache = null;

/**
 * Read one candidate directory. A workspace whose config is unreadable is
 * REPORTED, not skipped: silently dropping it would show "not managed by
 * NowHelpAssist" against an application we do in fact manage, which is a worse
 * answer than an error.
 */
async function readWorkspace(dir) {
  const configPath = path.join(dir, CONFIG_NAME);
  const entry = {
    id: path.basename(dir),
    dir,
    configPath,
    scope: null,
    scopeId: null,
    name: null,
    sourceCount: null,
    installable: false,
    error: null,
  };
  try {
    const cfg = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    entry.scope = cfg.scope || null;
    /*
     * The scope NAME is the workspace's identity; the scope SYS_ID is not.
     *
     * `now.config.json` no longer carries a scopeId — a sys_id is instance-local
     * and pinning one in tracked config is what left this workspace addressed to
     * a retired PDI. The id is resolved live per instance at deploy time
     * (fluent.js resolveScopeId) and cached under that instance's key, so it is
     * deliberately NOT read here: a registry that is asked "which workspace owns
     * this sys_id" without naming an instance is asking an unanswerable question.
     */
    entry.scopeId = null;
    entry.name = cfg.name || null;
    if (!entry.scope) entry.error = `${CONFIG_NAME} has no "scope"`;
  } catch (err) {
    entry.error = `${CONFIG_NAME} unreadable: ${err.message}`;
    return entry;
  }

  // Sources are what actually ships (invariant a). Counting them is how the
  // UI can say "managed, 13 sources" rather than just "managed".
  const fluentDir = path.join(dir, 'src/fluent');
  try {
    let n = 0;
    const walk = async (d) => {
      for (const ent of await fsp.readdir(d, { withFileTypes: true })) {
        if (ent.isDirectory()) await walk(path.join(d, ent.name));
        else if (ent.name.endsWith('.now.ts')) n++;
      }
    };
    if (fs.existsSync(fluentDir)) await walk(fluentDir);
    entry.sourceCount = n;
  } catch (err) {
    entry.error = entry.error || `sources unreadable: ${err.message}`;
  }

  entry.installable = Boolean(entry.scope) && fs.existsSync(path.join(dir, 'node_modules'));
  return entry;
}

/** Every workspace on disk, in discovery order. */
export async function listWorkspaces() {
  if (cache) return cache;
  const found = [];
  for (const root of SEARCH_ROOTS) {
    let entries;
    try { entries = await fsp.readdir(root, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name === 'node_modules') continue;
      const dir = path.join(root, ent.name);
      if (fs.existsSync(path.join(dir, CONFIG_NAME))) found.push(await readWorkspace(dir));
    }
  }
  cache = found;
  return cache;
}

export function refreshWorkspaces() { cache = null; }

/**
 * Look a scope up. Accepts either form, because the two identifiers are not
 * interchangeable on the instance and callers hold different ones: an update
 * row carries `application` as a sys_id (or the literal string `global`),
 * while `now.config.json` and every artifact path speak the scope NAME.
 */
export async function workspaceForScope(scopeName) {
  if (!scopeName) return null;
  const key = String(scopeName);
  const all = await listWorkspaces();
  // Name only. Addressing by sys_id used to work because the id was pinned in
  // config; it is now instance-local, and resolving one without knowing which
  // instance is meant would answer confidently for the wrong host.
  return all.find((w) => w.scope === key) || null;
}

/** The scope names we manage — the set the Applications page flags against. */
export async function managedScopeNames() {
  return (await listWorkspaces()).filter((w) => w.scope).map((w) => w.scope);
}
