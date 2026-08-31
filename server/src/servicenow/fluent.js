import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings } from '../config/store.js';
import { sdkAuthEnv, boundInstance, parseSdkInstanceEcho, instanceKeyFrom } from './instance-binding.js';
import { chatOnce } from '../agent/providers/index.js';
import { codegenDecoding } from '../agent/decoding.js';
import {
  findArtifactNames,
  pinArtifactNames,
  groundLiterals,
  checkPromisedLiterals,
  lintTriggerStrategy,
  RetryLedger,
} from './codegen-guards.js';
import {
  buildCatalog,
  catalogPromptBlock,
  lintArtifactType,
  lintSubflowReuse,
  parseSubflowContract,
  parseArtifactContracts,
  buildDependencyGraph,
  callersOf,
} from './subflows.js';
import { executeSubflow } from './execution-harness.js';
import { getSchema, referenceLookup } from './schema.js';
import { queryFieldRoots } from './conditions.js';
import { assertTaskSla, findSla, SLA_TOLERANCE_DEFAULT_SEC } from './sla.js';
import { factBlock } from '../memory/facts.js';
import { flows } from './flows.js';
import { table } from './client.js';

const pexec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');
const WORKSPACE = path.join(SERVER_ROOT, 'fluent-workspace');
const FLOWS_DIR = path.join(WORKSPACE, 'src/fluent/flows');
const STAGED_DIR = path.join(WORKSPACE, 'staged');
const STATE_FILE = path.join(SERVER_ROOT, 'data/fluent-state.json');
const CHEATSHEET = path.join(REPO_ROOT, 'docs/fluent-flow-cheatsheet.md');

const MAX_ATTEMPTS = 3;
// Raised from 3 to 4 for the Test 1 Step 1 resume (docs/fluent-research.md §20).
// A budget is only worth raising because A5 guarantees each attempt asks a
// DIFFERENT question; four identical re-asks would just cost four times as much.
const MAX_VERIFY_ATTEMPTS = 4;
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const QUICK_TIMEOUT_MS = 2 * 60 * 1000;
/** The binding probe is one authenticated round trip; the CLI start-up dominates it. */
const PROBE_TIMEOUT_MS = 120_000;

/**
 * Live Flow Designer authoring via the ServiceNow SDK (Fluent).
 *
 * Pipeline: plain-language spec → LLM-generated Fluent TypeScript → OFFLINE
 * `now-sdk build` (compile rejection never touches the instance) → serialized
 * `now-sdk install` → read-back through flows.detail().
 *
 * Hygiene invariants — these are load-bearing, because `now-sdk install`
 * deploys the ENTIRE application every time (there is no per-file deploy):
 *   (a) only build-validated sources may sit in src/fluent when install runs;
 *   (b) a generation candidate that never compiles is deleted before the error
 *       is returned, and the workspace is rebuilt to resync keys.ts. src/ is
 *       snapshotted before each request and diffed after a failure, so this is
 *       an assertion the pipeline reports on, not an intention;
 *   (c) every build/install runs through one serialized queue — concurrent runs
 *       would race on the shared dist/ output and on keys.ts;
 *   (d) one source file per artifact family, named by a deterministic slug, so
 *       regenerating a spec overwrites the same file and Now.ID keeps sys_ids
 *       stable instead of creating duplicates. Within a request every retry
 *       writes one fingerprint-named candidate, so a model that renames the
 *       flow mid-retry cannot strand a second file;
 *   (e) element identity is a PROJECT-WIDE namespace. A Now.ID key already
 *       declared anywhere in src/ is a live record owned by that flow, so every
 *       candidate is validated against every other source before it is built.
 *
 * The CLI is only ever invoked with fixed literal arguments — no user input is
 * ever passed to it — and it is spawned as `node <sdk entry>` rather than
 * through a shell, so there is no command-injection surface. Anything that
 * needs user-supplied values (read-back by name) goes through the REST client.
 */

/* ------------------------------------------------------------------ *
 * SDK process plumbing
 * ------------------------------------------------------------------ */

let sdkEntryCache;

/**
 * Resolve the SDK's JS entry point. On Windows the `now-sdk` binary is a .cmd
 * shim, which Node refuses to execFile (EINVAL) and which would otherwise force
 * `shell: true`. Running the entry with the current Node binary avoids both.
 */
function resolveSdkEntry() {
  if (sdkEntryCache !== undefined) return sdkEntryCache;
  const rel = 'node_modules/@servicenow/sdk/bin/index.js';
  const candidates = [
    process.env.SN_SDK_ENTRY,
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', rel),
    '/usr/local/lib/' + rel,
    '/usr/lib/' + rel,
    path.join(WORKSPACE, rel),
    path.join(REPO_ROOT, rel),
  ].filter(Boolean);
  sdkEntryCache = candidates.find((c) => fs.existsSync(c)) || null;
  return sdkEntryCache;
}

const stripAnsi = (s) => String(s || '').replace(/\[[0-9;]*m/g, '');

/** Where the SDK's JS entry point lives, for callers that scaffold a NEW workspace. */
export { resolveSdkEntry };

/**
 * Runs the SDK. Never throws on a non-zero exit — the caller inspects `code`.
 *
 * `cwd` defaults to the managed workspace, because every existing caller means
 * that one. `now-sdk init` is the exception: it scaffolds a NEW application
 * directory, so it has to run somewhere else (WI-5).
 */
export async function runSdk(args, timeout = QUICK_TIMEOUT_MS, cwd = WORKSPACE) {
  const entry = resolveSdkEntry();
  if (!entry) {
    return { ok: false, code: -1, stdout: '', stderr: 'ServiceNow SDK not found. Install it with: npm i -g @servicenow/sdk', missing: true };
  }
  /*
   * THE SDK'S INSTANCE BINDING IS DERIVED HERE, PER INVOCATION.
   *
   * It used to come from a standing credential alias, which is a second place
   * an instance address could live — and did, pointing at a retired PDI while
   * the REST tier had moved on. Passing the CI environment derived from the
   * UI config makes the alias irrelevant: MEASURED 2026-08-31, the env vars
   * override the stored alias completely ("Running in CI mode, using instance
   * <url>"), verified with a discriminator table present on one host only.
   *
   * When nothing is bound in the UI, no env is injected and the CLI falls back
   * to whatever it has. That is fine for unauthenticated commands like
   * `--version`; anything that touches an instance goes through
   * assertTiersAgree() first, which fails closed on an unbound app.
   */
  const authEnv = sdkAuthEnv();
  try {
    const { stdout, stderr } = await pexec(process.execPath, [entry, ...args], {
      cwd,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: authEnv ? { ...process.env, ...authEnv } : process.env,
    });
    return { ok: true, code: 0, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
  } catch (err) {
    return {
      ok: false,
      code: err.code ?? -1,
      stdout: stripAnsi(err.stdout),
      stderr: stripAnsi(err.stderr) || err.message,
      timedOut: err.killed === true,
    };
  }
}

/* ------------------------------------------------------------------ *
 * The shared binding preflight — every mutating deploy passes through it
 * ------------------------------------------------------------------ */

/**
 * Ask the SDK which instance it actually used, by reading its own echo.
 *
 * Not the alias list, and not the env we intended to pass: what the CLI SAYS it
 * targeted, on a real authenticated round trip. That is the only observation
 * that catches a derivation or injection bug, which is precisely what this
 * guard exists to be a backstop for now that both tiers derive from one source.
 *
 * Costs one cheap query (~8s of CLI start-up). An install costs minutes, so
 * this is noise on the path that matters.
 */
export async function resolveSdkTarget() {
  const res = await runSdk(['query', 'sys_user', '-q', 'user_name=NOWHELPASSIST_BINDING_PROBE', '-f', 'sys_id', '--limit', '1'], PROBE_TIMEOUT_MS);
  const echoed = parseSdkInstanceEcho(`${res.stdout || ''}
${res.stderr || ''}`);
  return { host: echoed, ok: res.ok, raw: `${res.stdout || ''}${res.stderr || ''}`.slice(0, 400) };
}

/**
 * REFUSE ANY MUTATING DEPLOY WHEN THE TWO TIERS DO NOT NAME THE SAME INSTANCE.
 *
 * With a single UI-owned source that both tiers derive from, this should never
 * fire. That is the point: its job is no longer to catch a human forgetting to
 * repoint an alias, it is to catch a bug in the derivation — an env var that
 * did not reach the child process, a settings read that returned stale data, a
 * CLI version that ignores the CI variables. Any of those silently restores the
 * original failure, where an install succeeds against the wrong instance and
 * every read-back honestly reports nothing.
 *
 * Fails CLOSED: unbound, unknown, or mismatched all refuse.
 */
export async function assertTiersAgree({ probe = true } = {}) {
  const bound = boundInstance();
  if (!bound.configured) {
    throw Object.assign(new Error(
      'No ServiceNow instance is bound. Set the instance URL and credentials in Settings — nothing may be '
      + 'installed until the UI specifies where.'
    ), { status: 409, detail: { restHost: null } });
  }
  if (!sdkAuthEnv()) {
    throw Object.assign(new Error(
      `The bound instance ${bound.host} has no usable credentials for the SDK tier. Basic auth needs a username `
      + 'and password; OAuth needs a client id and secret. The SDK binding is derived from those, so an install '
      + 'cannot be authorised without them.'
    ), { status: 409, detail: { restHost: bound.host } });
  }
  if (!probe) return { ok: true, host: bound.host, probed: false };

  const sdk = await resolveSdkTarget();
  if (!sdk.host) {
    throw Object.assign(new Error(
      `Could not confirm which instance the ServiceNow SDK is targeting, so an install cannot be authorised. `
      + `The CLI named no instance in its output. Expected it to echo "using instance ${bound.url}".`
    ), { status: 409, detail: { restHost: bound.host, sdkHost: null, raw: sdk.raw } });
  }
  if (sdk.host !== bound.host) {
    throw Object.assign(new Error(
      `REFUSING TO INSTALL: the two tiers resolved to DIFFERENT INSTANCES. The Table API reads and verifies `
      + `against "${bound.host}" (the instance set in the UI), but the ServiceNow SDK reported it is targeting `
      + `"${sdk.host}". Both are supposed to derive from the same UI config, so this is a derivation bug, not a `
      + `stale alias — an install would succeed and land the artifacts where the read-back cannot see them.`
    ), { status: 409, detail: { restHost: bound.host, sdkHost: sdk.host, raw: sdk.raw } });
  }
  // The host agreeing is necessary and not sufficient: the APPLICATION the
  // workspace is pinned to must also exist on that host.
  const app = await assertAppBinding();
  return { ok: true, host: bound.host, probed: true, scope: app.scope, scopeId: app.scopeId };
}

/**
 * The APPLICATION is instance-specific too, and `now.config.json` pins it.
 *
 * MEASURED 2026-08-31, and it is why section D could not close. The workspace
 * is pinned to scope `x_2196302_nwforge` with `scopeId`
 * c44f3c6c37c24793be9f8b759c7818e4 — a sys_id, which is only meaningful on the
 * instance that minted it. On the newly bound instance neither exists, so
 * `now-sdk install` answers:
 *
 *   "Unable to install application as application was null"
 *
 * and blanking `scopeId` does not help — the build refuses with
 * `requires property "scopeId"`.
 *
 * Worse, the scope name itself may be UNCREATABLE here: the vendor prefix is
 * issued by the instance, not chosen. `glide.appcreator.company.code` reads
 * 2002152 on the bound instance against the 2196302 baked into the scope name,
 * so an application created here would be `x_2002152_…` and could never carry
 * the pinned name.
 *
 * So this refuses before the install with the actual reason, instead of letting
 * the CLI report a null-pointer-shaped message that names nothing.
 */
export async function assertAppBinding() {
  const bound = boundInstance();
  let cfg;
  try {
    cfg = JSON.parse(await fsp.readFile(path.join(WORKSPACE, 'now.config.json'), 'utf8'));
  } catch (err) {
    throw Object.assign(new Error(`The Fluent workspace has no readable now.config.json (${err.message}), so no application can be installed.`), { status: 409 });
  }

  const rows = await table.query('sys_scope', {
    query: `scope=${cfg.scope}`, fields: 'sys_id,scope,name', display: 'false', limit: 1,
  }).catch(() => []);

  if (!rows.length) {
    let localPrefix = null;
    try {
      const p = await table.query('sys_properties', { query: 'name=glide.appcreator.company.code', fields: 'value', display: 'false', limit: 1 });
      localPrefix = p[0]?.value ?? null;
    } catch { /* the advice is better with it, still correct without */ }
    const pinned = /^x_(\d+)_/.exec(cfg.scope || '')?.[1] ?? null;
    const prefixNote = localPrefix && pinned && localPrefix !== pinned
      ? ` This instance issues vendor prefix "${localPrefix}", but the scope name carries "${pinned}" — vendor `
        + `prefixes are issued by the instance, so this scope name cannot be created here. An application created `
        + `on ${bound.host} would be x_${localPrefix}_<name>.`
      : '';
    throw Object.assign(new Error(
      `REFUSING TO INSTALL: the application "${cfg.scope}" does not exist on the bound instance ${bound.host}. `
      + `The workspace is pinned to it by now.config.json (scopeId ${cfg.scopeId || 'unset'}), and a sys_id is only `
      + `meaningful on the instance that minted it.${prefixNote} `
      + 'Re-establishing this application on the bound instance is a deliberate action — a new scope name and a new '
      + 'app record — not something an install should do as a side effect.'
    ), { status: 409, detail: { scope: cfg.scope, scopeId: cfg.scopeId ?? null, boundHost: bound.host, localVendorPrefix: localPrefix } });
  }

  const onInstance = rows[0].sys_id;
  if (cfg.scopeId && cfg.scopeId !== onInstance) {
    throw Object.assign(new Error(
      `REFUSING TO INSTALL: "${cfg.scope}" exists on ${bound.host} as ${onInstance}, but now.config.json pins `
      + `scopeId ${cfg.scopeId}. That pin was minted on a different instance; installing against a stale app sys_id `
      + 'is how artifacts land in the wrong application.'
    ), { status: 409, detail: { scope: cfg.scope, pinned: cfg.scopeId, onInstance, boundHost: bound.host } });
  }

  return { ok: true, scope: cfg.scope, scopeId: onInstance, host: bound.host };
}

/* ------------------------------------------------------------------ *
 * Invariant (c): one build/install at a time
 * ------------------------------------------------------------------ */

let queueTail = Promise.resolve();
let queueDepth = 0;

function serialize(job) {
  queueDepth += 1;
  const run = queueTail.then(job, job);
  queueTail = run.then(
    () => { queueDepth -= 1; },
    () => { queueDepth -= 1; }
  );
  return run;
}

/* ------------------------------------------------------------------ *
 * Persisted state (last install)
 * ------------------------------------------------------------------ */

function readRawState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeRawState(next) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

/**
 * B5 — install state is namespaced by instance, and a foreign entry is inert.
 *
 * The file used to hold one flat `lastInstall`. After the PDI swap it still
 * carried `rollbackUrl: https://dev442675.../sys_rollback_context.do?sys_id=…`
 * while the app was bound to dev428633 — a live, clickable instruction to roll
 * something back on a retired instance. A rollback URL from instance A must be
 * impossible to fire against instance B, so state is filed under the host and
 * a read for the wrong host returns NOTHING rather than the other host's row.
 *
 * The legacy flat shape is migrated on first read: it is moved under the
 * instance it names, recovered from its own rollback URL, and quarantined if
 * that cannot be determined. It is never silently adopted as the current
 * instance's state.
 */
function migrateLegacyState(raw) {
  if (!raw || raw.byInstance || !raw.lastInstall) return raw;
  const owner = instanceKeyFrom(raw.lastInstall.rollbackUrl || '') || null;
  const { lastInstall, ...rest } = raw;
  const next = { ...rest, byInstance: {} };
  if (owner) {
    next.byInstance[owner] = { lastInstall: { ...lastInstall, instance: owner } };
  } else {
    next.quarantined = [{ reason: 'a legacy flat lastInstall naming no instance', entry: lastInstall }];
  }
  return writeRawState(next);
}

export function readInstanceState(host) {
  const raw = migrateLegacyState(readRawState());
  if (!host) return {};
  return raw.byInstance?.[host] ?? {};
}

function writeInstanceState(host, patch) {
  const raw = migrateLegacyState(readRawState());
  const byInstance = { ...(raw.byInstance || {}) };
  byInstance[host] = { ...(byInstance[host] || {}), ...patch };
  return writeRawState({ ...raw, byInstance });
}

/* ------------------------------------------------------------------ *
 * Source-file helpers — invariant (d)
 * ------------------------------------------------------------------ */

export function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'flow';
}

const sourcePath = (name) => path.join(FLOWS_DIR, `${slugify(name)}.now.ts`);

/**
 * Names/kinds declared in a Fluent source. Convenience only — the instance
 * read-back is the authority for what actually exists.
 */
export function parseArtifacts(source) {
  const out = [];
  const re = /\b(Subflow|Flow)\s*\(/g;
  let m;
  while ((m = re.exec(source))) {
    const window = source.slice(m.index, m.index + 800);
    const name = window.match(/name:\s*['"]([^'"]+)['"]/)?.[1];
    if (name) out.push({ kind: m[1] === 'Subflow' ? 'subflow' : 'flow', name });
  }
  return out;
}

async function listSourceFiles() {
  try {
    const entries = await fsp.readdir(FLOWS_DIR);
    return entries.filter((f) => f.endsWith('.now.ts'));
  } catch { return []; }
}

/* ------------------------------------------------------------------ *
 * Request identity — the real anchor for invariant (d)
 *
 * The filename slug was originally derived from the model-supplied artifact
 * name, which is NOT stable: the same spec produced "Escalate P1 Network
 * Incidents" on one run and "...Incident" on the next, yielding a second file,
 * fresh Now.ID keys, and duplicate records on the instance.
 *
 * Identity therefore comes from the REQUEST, not from what the model decided to
 * call it. Each generated source carries a fingerprint of its spec, so a
 * regeneration finds its own previous file and overwrites it. The previous
 * source is then fed back to the model with an instruction to preserve every
 * name and every Now.ID key — which is what actually keeps sys_ids stable,
 * since keys.ts is keyed on those strings.
 * ------------------------------------------------------------------ */

const SPEC_MARKER = '// nowforge-spec:';

export function specFingerprint(spec) {
  const normalized = String(spec || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

const stampSource = (source, fingerprint) =>
  `${SPEC_MARKER} ${fingerprint}\n${source.replace(new RegExp(`^${SPEC_MARKER}.*\\r?\\n`), '')}`;

/** Existing source generated from this same request, if any. */
async function findSourceByFingerprint(fingerprint) {
  for (const f of await listSourceFiles()) {
    const src = await fsp.readFile(path.join(FLOWS_DIR, f), 'utf8').catch(() => '');
    if (src.includes(`${SPEC_MARKER} ${fingerprint}`)) return { file: f, source: src };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Element identity — guards against the CLASS C duplicate-identity abort
 *
 * `keys.ts` is a FLAT, PROJECT-WIDE map from a Now.ID key to one sys_id. A key
 * is therefore not "an element inside this flow" — it is a live record claimed
 * by whichever flow declared it first. A second flow declaring the same key
 * does not get a fresh record; it collides, and `now-sdk build` aborts with
 *
 *     Record sys_hub_action_instance_v2.<sys_id> is defined 2 times in the project
 *
 * which names a sys_id the model never wrote and cannot map back to its own
 * source. Guard 1 catches the collision BEFORE the SDK runs and hands the model
 * a diagnostic in its own vocabulary — the key, and both definition sites.
 *
 * Uniqueness must come from a NAMESPACE, never from entropy: timestamped or
 * random keys would make every regeneration mint new sys_ids, which is exactly
 * the identity defect in docs/fluent-research.md §6.
 * ------------------------------------------------------------------ */

const ID_RE = /Now\.ID\[\s*['"]([^'"]+)['"]\s*\]/g;
const LITERAL_ID_RE = /\$id\s*:\s*['"]([0-9a-f]{32})['"]/g;

/** Placeholder shape used to neutralise real keys in prompt context (guard 3). */
const PLACEHOLDER_RE = /^__ID_\d+__$/;

/** Every Now.ID key a source declares, with the 1-based line it sits on. */
export function collectElementIds(source) {
  const out = [];
  String(source || '').split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(ID_RE)) out.push({ key: m[1], line: i + 1 });
  });
  return out;
}

/** Short per-flow key prefix suggested in diagnostics, e.g. "Vendor Hold" -> "vh_". */
function suggestPrefix(source) {
  const name = parseArtifacts(source).find((a) => a.kind === 'flow')?.name || '';
  const initials = String(name).split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toLowerCase().slice(0, 4);
  return initials ? `${initials}_` : 'flow_';
}

/**
 * A2's rule, applied to keys: IMPOSE the namespace, do not ask for it.
 *
 * `Now.ID` keys are a project-wide namespace (trap #1), so a candidate reusing
 * `adc_flow` when another source already owns it collides instead of creating.
 * The diagnostic for that was clear, named both definition sites, and even
 * suggested the fix — and a real run ignored it three times in a row, with
 * byte-identical results, burning the whole attempt budget.
 *
 * That is the same shape as A2: identity the platform matches on is too
 * important to leave to a model that is right most of the time. Colliding keys
 * are now renamed mechanically, prefixed with this flow's own slug, before
 * validation runs. What is left for the guard to reject is what a rewrite
 * cannot fix — duplicates WITHIN one candidate, literal sys_ids, placeholders.
 *
 * Only colliding keys move. A key unique to this candidate keeps the name the
 * model chose, because it is readable and it is not wrong.
 */
export function namespaceCollidingIds(candidateSource, others = [], { file = 'candidate.now.ts' } = {}) {
  const taken = new Set();
  for (const other of others) {
    if (!other || other.file === file) continue;
    for (const { key } of collectElementIds(other.source)) taken.add(key);
  }
  if (!taken.size) return { source: candidateSource, renames: [] };

  const prefix = suggestPrefix(candidateSource);
  const renames = [];
  let source = candidateSource;

  for (const key of new Set(collectElementIds(candidateSource).map((k) => k.key))) {
    if (!taken.has(key)) continue;
    // Already prefixed and still colliding: fall back to the file's own slug,
    // which is unique per artifact by construction.
    let next = key.startsWith(prefix) ? `${slugify(file).replace(/-/g, '_')}_${key}` : `${prefix}${key}`;
    let n = 2;
    while (taken.has(next)) next = `${prefix}${key}_${n++}`;
    source = source.split(`Now.ID['${key}']`).join(`Now.ID['${next}']`);
    taken.add(next);
    renames.push({ from: key, to: next });
  }
  return { source, renames };
}

/**
 * Guard 1 — static pre-build validation of one candidate against the project.
 *
 * Rejects, before `now-sdk build` is ever spawned:
 *   - the same Now.ID key declared twice inside the candidate;
 *   - a key already declared by another source file in the project;
 *   - a literal sys_id used as an $id (identity the SDK cannot track);
 *   - a leftover `__ID_n__` placeholder the model failed to resolve.
 *
 * `others` is [{ file, source }] for every OTHER source in the project.
 */
export function validateCandidateIds(candidateSource, others = [], { file = 'candidate.now.ts' } = {}) {
  const errors = [];
  const ids = collectElementIds(candidateSource);

  // Where each key is first declared in the candidate.
  const mine = new Map();
  for (const { key, line } of ids) {
    if (mine.has(key)) {
      errors.push(
        `Duplicate $id: Now.ID['${key}'] is defined 2 times in ${file} ` +
        `(line ${mine.get(key)} and line ${line}). Every element needs its OWN key — ` +
        `give the second one a distinct, descriptive key.`
      );
    } else {
      mine.set(key, line);
    }
  }

  for (const { key, line } of ids) {
    if (PLACEHOLDER_RE.test(key)) {
      errors.push(
        `Unresolved placeholder $id: Now.ID['${key}'] at ${file}:${line}. ` +
        `Placeholders stand for existing records and must be kept exactly as given, ` +
        `or replaced with a freshly minted descriptive key for a NEW element.`
      );
    }
  }

  for (const m of String(candidateSource || '').matchAll(LITERAL_ID_RE)) {
    errors.push(`Literal sys_id used as an $id: '${m[1]}'. Every $id must be Now.ID['snake_case_key'].`);
  }

  // Cross-source collisions — the failure that actually fired.
  for (const other of others) {
    if (!other || other.file === file) continue;
    const seenHere = new Set();
    for (const { key, line } of collectElementIds(other.source)) {
      if (!mine.has(key) || seenHere.has(key)) continue;
      seenHere.add(key);
      errors.push(
        `Duplicate $id across the project: Now.ID['${key}'] is defined 2 times — ` +
        `${file}:${mine.get(key)} and ${other.file}:${line}. ` +
        `Now.ID keys are a PROJECT-WIDE namespace: this key already identifies a live record ` +
        `owned by ${other.file}, so reusing it collides instead of creating a new element. ` +
        `Mint a fresh key unique to this flow (prefix every key with a short slug of this ` +
        `flow's name, e.g. '${suggestPrefix(candidateSource)}${key}').`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    // Shaped like compiler output so the retry prompt feeds it back unchanged.
    diagnostic: errors.length
      ? `ERROR: identity validation failed before build.\n${errors.map((e) => `ERROR: ${e}`).join('\n')}`
      : null,
  };
}

/** Read every source in the project except one, for cross-file validation. */
async function readProjectSources({ except = null } = {}) {
  const out = [];
  for (const f of await listSourceFiles()) {
    if (f === except) continue;
    out.push({ file: f, source: await fsp.readFile(path.join(FLOWS_DIR, f), 'utf8').catch(() => '') });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Guard 3 — context sanitation
 *
 * Any source fed back into the codegen prompt has its Now.ID keys replaced with
 * neutral placeholders. Two things follow:
 *   - the model never SEES a live key, so it cannot copy one into a new flow
 *     (the CLASS C vector);
 *   - identity of the artifact being regenerated is preserved MECHANICALLY, by
 *     substituting the real keys back into the model's output, instead of being
 *     asked for politely in prose. Names are never touched — the verbatim-name
 *     survival mechanism is what keeps the platform matching the same records.
 * ------------------------------------------------------------------ */

/** Replace real Now.ID keys with placeholders, extending a shared map. */
export function sanitizeIds(source, map = new Map()) {
  const byKey = new Map([...map].map(([ph, key]) => [key, ph]));
  const text = String(source || '').replace(ID_RE, (full, key) => {
    if (PLACEHOLDER_RE.test(key)) return full;
    let ph = byKey.get(key);
    if (!ph) {
      ph = `__ID_${map.size + 1}__`;
      map.set(ph, key);
      byKey.set(key, ph);
    }
    return `Now.ID['${ph}']`;
  });
  return { text, map };
}

/** Substitute real keys back for placeholders. Unknown keys are left alone. */
export function restoreIds(source, map) {
  if (!map || !map.size) return source;
  return String(source || '').replace(ID_RE, (full, key) => (map.has(key) ? `Now.ID['${map.get(key)}']` : full));
}

/**
 * Neutralise the syntax examples the cheatsheet ships. Its snippets are real,
 * build-verified sources, so their keys are LIVE keys — copying one reproduces
 * the collision exactly. Prefixing marks them as examples and keeps the
 * cheatsheet readable.
 */
export function sanitizeExampleIds(text) {
  return String(text || '').replace(ID_RE, (full, key) => (key.startsWith('ex_') ? full : `Now.ID['ex_${key}']`));
}

/* ------------------------------------------------------------------ *
 * Guard 2 — retry hygiene
 *
 * Every attempt for one request targets ONE filename derived from the spec
 * fingerprint, never from the model's chosen flow name (a renamed flow used to
 * strand a second file, fresh keys and duplicate records). The candidate is
 * renamed to its slug only once it has actually built.
 * ------------------------------------------------------------------ */

const CANDIDATE_RE = /^candidate-[0-9a-f]{16}\.now\.ts$/;
const candidatePath = (fingerprint) => path.join(FLOWS_DIR, `candidate-${fingerprint}.now.ts`);

/**
 * Sweep src/ of every candidate file. A candidate is by definition not a
 * managed artifact: if one is on disk, a previous request died without
 * cleaning up and invariant (b) is already violated.
 */
async function sweepCandidates() {
  const swept = [];
  for (const f of await fsp.readdir(FLOWS_DIR).catch(() => [])) {
    if (!CANDIDATE_RE.test(f)) continue;
    await fsp.rm(path.join(FLOWS_DIR, f), { force: true });
    swept.push(f);
  }
  return swept;
}

/**
 * Content-addressed snapshot of src/, so cleanup can be PROVEN, not assumed.
 * `dir` is a parameter purely so the regression test can exercise this exact
 * code against a temp directory rather than a copy of it.
 */
export async function snapshotSources(dir = FLOWS_DIR) {
  const snap = new Map();
  for (const f of (await fsp.readdir(dir).catch(() => [])).sort()) {
    const src = await fsp.readFile(path.join(dir, f), 'utf8').catch(() => null);
    if (src !== null) snap.set(f, src);
  }
  return snap;
}

/**
 * Put src/ back exactly as the snapshot found it. This also repairs a latent
 * bug: the terminal-failure cleanup used to `rm` the candidate path, which on a
 * REGENERATION is the deployed artifact's own source — deleting it would have
 * removed a live flow from the instance on the next install.
 */
export async function restoreSources(snap, dir = FLOWS_DIR) {
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (!snap.has(f)) await fsp.rm(path.join(dir, f), { force: true });
  }
  for (const [f, content] of snap) {
    const target = path.join(dir, f);
    const current = await fsp.readFile(target, 'utf8').catch(() => null);
    if (current !== content) await fsp.writeFile(target, content, 'utf8');
  }
}

/** Assertion, not a comment: what still differs from the pre-request state. */
export async function diffAgainstSnapshot(snap, dir = FLOWS_DIR) {
  const now = await snapshotSources(dir);
  const drift = [];
  for (const [f, content] of snap) {
    if (!now.has(f)) drift.push(`missing: ${f}`);
    else if (now.get(f) !== content) drift.push(`modified: ${f}`);
  }
  for (const f of now.keys()) if (!snap.has(f)) drift.push(`left behind: ${f}`);
  return drift;
}

/* ------------------------------------------------------------------ *
 * capability()
 * ------------------------------------------------------------------ */

function parseAuthList(stdout) {
  // Blocks look like:
  //   *[alias]
  //         host = https://...
  //         type = basic
  //         username = admin
  // Every CLI log line is also prefixed "[now-sdk] ...", so a bracket alone is
  // not enough: the bracket must start a line and the block must declare a host.
  const creds = [];
  let cur = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    // An alias header is a bracketed token alone on the line, e.g. "*[snada-pdi]".
    const header = line.match(/^[ \t]*(\*?)\[([^\]\s]+)\][ \t]*$/);
    if (header) {
      if (cur?.host) creds.push(cur);
      cur = { alias: header[2], isDefault: header[1] === '*', host: null, type: null, username: null };
      continue;
    }
    const kv = line.match(/^[ \t]*(host|type|username|default)[ \t]*=[ \t]*(\S+)/);
    if (kv && cur) {
      if (kv[1] === 'default') cur.isDefault = cur.isDefault || /yes/i.test(kv[2]);
      else cur[kv[1]] = kv[2];
    }
  }
  // A block without a host is a log line, not a credential.
  if (cur?.host) creds.push(cur);
  return creds;
}

let capCache = { at: 0, value: null };
const CAP_TTL_MS = 30_000;
let capRefreshing = null;

/**
 * The cached probe, or null — never a wait.
 *
 * `capability()` shells out to `now-sdk` twice and costs ~5s on a cache miss.
 * That is fine on the Flows page, which asks for it deliberately; it is not
 * fine on /api/system/health, which every page polls to answer the far simpler
 * question "is an instance bound". Measured: one expired cache entry turned a
 * 2ms health check into 5.5s, which left the topbar reading "checking…" and
 * the instance gate unable to decide before the pages underneath it had
 * already fired their requests.
 *
 * So health reads this instead: whatever is cached, plus a refresh kicked off
 * in the background for the next caller. A pending probe is reported as
 * pending rather than as `ok: false` — "not measured yet" and "the SDK is
 * broken" are different answers and only one of them prints fix commands.
 */
export function cachedCapability() {
  if (capCache.value && Date.now() - capCache.at < CAP_TTL_MS) return capCache.value;
  if (!capRefreshing) {
    capRefreshing = capability()
      .catch(() => null)
      .finally(() => { capRefreshing = null; });
  }
  return null;
}

/**
 * Capability probe.
 *
 * Cost note: every `now-sdk` invocation pays ~5s of CLI start-up, so a real
 * authenticated round-trip costs ~8s. The default (shallow) probe therefore
 * avoids the instance entirely:
 *   - CLI presence/version : `now-sdk --version`
 *   - stored credentials   : `now-sdk auth --list`  (reads the local credential
 *                            store; proves a credential EXISTS and which host
 *                            it targets — it does NOT prove it still works)
 * `deep: true` additionally runs `now-sdk query sys_user -q user_name=admin
 * -f sys_id --limit 1`, the cheapest genuinely authenticated SDK command, which
 * is what actually proves the credential is valid.
 */
export async function capability({ deep = false, force = false } = {}) {
  if (!deep && !force && capCache.value && Date.now() - capCache.at < CAP_TTL_MS) {
    return capCache.value;
  }

  const fixes = [];
  const entry = resolveSdkEntry();

  // --- CLI ---
  const cli = { present: Boolean(entry), entry, version: null, error: null };
  if (!entry) {
    cli.error = 'ServiceNow SDK not found on this machine.';
    fixes.push({ problem: 'SDK CLI missing', command: 'npm i -g @servicenow/sdk' });
  } else {
    const v = await runSdk(['--version']);
    if (v.ok) cli.version = v.stdout.trim().split('\n').pop().trim();
    else {
      cli.error = (v.stderr || 'now-sdk --version failed').slice(0, 400);
      fixes.push({ problem: 'SDK CLI not runnable', command: 'npm i -g @servicenow/sdk@latest' });
    }
  }

  /* --- auth ---
   *
   * B3 — THE SDK NO LONGER HAS A BINDING OF ITS OWN.
   *
   * This used to read the stored credential alias and report which host it
   * pointed at. That store is exactly the second place an instance address
   * could live, and it drifted: it named a retired PDI for weeks while the REST
   * tier had moved on, and an install landed there, successfully, unnoticed.
   *
   * The alias is gone. Authentication is derived per invocation from the UI
   * config, so what this reports is whether that derivation produces usable
   * credentials — and any remaining stored alias is listed as INERT, because it
   * no longer decides anything and reporting it as the binding would be a lie.
   */
  const settings = getSettings();
  const bound = boundInstance();
  const auth = {
    source: 'derived-from-ui-config',
    credentials: [], alias: null, host: bound.host, username: bound.username,
    verified: 'unknown', matchesNowHelpAssistInstance: null, error: null,
    inertStoredAliases: [],
  };
  if (!bound.configured) {
    auth.error = 'No instance is bound. Set the instance URL and credentials in Settings.';
    fixes.push({ problem: 'No instance bound', command: 'Open Settings and save the instance URL, username and password.' });
  } else if (!sdkAuthEnv()) {
    auth.error = `The bound instance ${bound.host} has no credentials the SDK can use (basic needs a password; OAuth needs a client id and secret).`;
    fixes.push({ problem: 'SDK credentials incomplete', command: 'Open Settings and complete the connection credentials.' });
  } else {
    auth.verified = 'derived';
    // True by construction now — both tiers read one config — and reported so
    // the UI can keep showing agreement rather than silently dropping the field.
    auth.matchesNowHelpAssistInstance = true;
  }
  if (cli.present && !cli.error) {
    const a = await runSdk(['auth', '--list']);
    if (a.ok) {
      auth.inertStoredAliases = parseAuthList(a.stdout).map((c) => ({ ...c, inert: true }));
    }
  }

  if (deep && auth.verified === 'derived') {
    const probe = await runSdk(['query', 'sys_user', '-q', 'user_name=admin', '-f', 'sys_id', '--limit', '1', '-o', 'json']);
    if (probe.ok && /"ok"\s*:\s*true/.test(probe.stdout)) {
      auth.verified = 'live';
    } else {
      auth.verified = 'failed';
      auth.error = (probe.stderr || probe.stdout || 'Authenticated probe failed').slice(0, 400);
      fixes.push({
        problem: 'Stored SDK credential rejected by the instance',
        command: `now-sdk auth --add ${auth.host || nowhelpassistHost} --type basic --alias ${auth.alias}`,
      });
    }
  }

  // --- workspace ---
  const workspace = {
    path: WORKSPACE, exists: fs.existsSync(WORKSPACE),
    scope: null, appName: null, sources: [], staged: [], error: null,
  };
  try {
    const cfg = JSON.parse(await fsp.readFile(path.join(WORKSPACE, 'now.config.json'), 'utf8'));
    workspace.scope = cfg.scope;
    workspace.appName = cfg.name;
  } catch (err) {
    workspace.error = `now.config.json unreadable: ${err.message}`;
    fixes.push({
      problem: 'Fluent workspace missing',
      command: 'now-sdk init --appName "NowForge Flows" --packageName nowforge-flows --scopeName x_2196302_nwforge --template base',
    });
  }
  workspace.sources = await listSourceFiles();
  try { workspace.staged = (await fsp.readdir(STAGED_DIR)).filter((f) => f.endsWith('.now.ts')); } catch { /* optional */ }
  if (!fs.existsSync(path.join(WORKSPACE, 'node_modules'))) {
    workspace.error = (workspace.error ? workspace.error + ' ' : '') + 'Workspace dependencies not installed.';
    fixes.push({ problem: 'Workspace dependencies missing', command: 'npm install --prefix server/fluent-workspace' });
  }

  const cheatsheet = { path: CHEATSHEET, present: fs.existsSync(CHEATSHEET) };
  if (!cheatsheet.present) {
    fixes.push({ problem: 'Codegen cheatsheet missing', command: 'restore docs/fluent-flow-cheatsheet.md' });
  }

  // Only this instance's install history is visible; another host's is not ours to report.
  const state = readInstanceState(boundInstance().host);
  const value = {
    // `auth.alias` used to be the readiness signal. There is no alias any more —
    // the binding is derived from the UI config — so readiness is now "the
    // derivation produced usable credentials and they have not been proven bad".
    ok: Boolean(cli.present && !cli.error && auth.verified === 'derived' && !workspace.error && cheatsheet.present),
    cli,
    auth,
    workspace,
    cheatsheet,
    llm: { provider: settings.llm.provider, model: settings.llm.model || null },
    lastInstall: state.lastInstall || null,
    queueDepth,
    fixes,
    checkedAt: new Date().toISOString(),
  };
  if (!deep) capCache = { at: Date.now(), value };
  return value;
}

/* ------------------------------------------------------------------ *
 * generate()
 * ------------------------------------------------------------------ */

const INTENT_SYSTEM = `You extract structured intent from a ServiceNow automation request. Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "name": "short human-readable name in Title Case, e.g. \"Escalate P1 Network Incidents\" — never snake_case, never an identifier",
  "kind": "flow" | "subflow" | "flow+subflow",
  "trigger_kind": "record_created" | "record_updated" | "record_created_or_updated" | "scheduled" | "none",
  "trigger_table": "servicenow table name, or null for scheduled/subflow",
  "lookups": [ { "table": "sys_user_group|sys_user|sc_category|cmdb_ci|...", "name": "the exact proper noun from the request" } ],
  "promised_effects": [ "each distinct OBSERVABLE change the request promises" ],
  "promised_literals": [ "each exact string the request demands the flow WRITE, copied character for character" ]
}
"lookups" must list every proper noun the request names that has to become a real record reference (groups, people, categories, CIs). Use [] if there are none.
"promised_literals" lists only text the flow must reproduce VERBATIM in a value it writes — a prefix, a work-note wording, an email subject. Copy each one exactly as the request spells it, including spacing and punctuation, and ONLY if the request quotes or dictates the literal text. A choice LABEL the flow matches on ("On Hold"), a table or field name, and a paraphrase of behaviour are NOT promised literals. Use [] when the request dictates no exact text.
"promised_effects" lists only effects that can be OBSERVED on a record afterwards — a field set, a note added, a record created. One entry per distinct effect. Sending an email is NOT observable on a record; looking something up is not an effect. Example: "adds an escalation work note to the incident", "sets assigned_to to the group manager".`;

async function extractIntent(spec, decoding) {
  // Budgets are deliberately generous: reasoning models bill hidden reasoning
  // tokens against max_tokens, so a tight budget yields an empty completion.
  const raw = await chatOnce({ system: INTENT_SYSTEM, user: spec, maxTokens: 3000, decoding });
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    return { name: null, kind: 'flow', trigger_kind: 'record_created', trigger_table: null, lookups: [], promised_literals: [] };
  }
}

/**
 * Proper nouns arrive as the spec phrased them ("the Hardware group"), and the
 * intent extractor keeps or drops the trailing common noun unpredictably — the
 * SAME spec yielded "Hardware" on one run and "Hardware group" on the next, and
 * the second spelling matched nothing. Retry once without the trailing common
 * noun before declaring a miss.
 */
const TRAILING_COMMON_NOUN = /\s+(group|groups|team|teams|queue|department|dept|user|users|table)$/i;

export function stripTrailingCommonNoun(name) {
  return String(name || '').trim().replace(TRAILING_COMMON_NOUN, '').trim();
}

async function resolveReference(tbl, name) {
  const hits = await referenceLookup(tbl, name, 5);
  if (hits.length) return { hits, used: name, corrected: false };
  const trimmed = stripTrailingCommonNoun(name);
  if (trimmed && trimmed.toLowerCase() !== String(name).trim().toLowerCase()) {
    const retry = await referenceLookup(tbl, trimmed, 5);
    if (retry.length) return { hits: retry, used: trimmed, corrected: true };
  }
  return { hits: [], used: name, corrected: false };
}

/**
 * Build the live-context block: real field names from the trigger table and
 * real sys_ids for every proper noun the spec named. The model is told to use
 * these and never to invent an identifier.
 */
async function buildLiveContext(intent) {
  const parts = [];
  const resolved = [];

  // A-4 read path. The traps in the ledger are exactly the ones that produce a
  // flow which compiles, installs, activates 10/10 and does the wrong thing, so
  // they belong in front of the model BEFORE it writes the source rather than
  // in a diagnostic afterwards. Preferences are left out: they are about how to
  // talk to the user, not how to write a flow.
  const ledger = factBlock({ kinds: ['trap', 'mapping', 'decision'] });
  if (ledger) parts.push(ledger);

  if (intent.trigger_table) {
    try {
      const schema = await getSchema(intent.trigger_table);
      const interesting = schema.fields
        .filter((f) => !f.name.startsWith('sys_') || ['sys_id', 'sys_created_on'].includes(f.name))
        .slice(0, 120)
        .map((f) => {
          const ref = f.reference ? ` -> ${f.reference}` : '';
          // Choices MUST carry value=label pairs. Emitting bare values lets the
          // model guess the mapping — which produced `risk=4` (Low) for a spec
          // that asked for High risk, on an instance where High is 2.
          const ch = f.choices?.length
            ? ` choices[${f.choices.slice(0, 12).map((c) => `${c.value}=${c.label}`).join(', ')}]`
            : '';
          return `  ${f.name} (${f.type}${ref})${ch}`;
        });
      parts.push(
        `REAL SCHEMA for "${intent.trigger_table}" (hierarchy: ${schema.hierarchy.join(' -> ')}). Use these exact field names.\n` +
        `For any choice field, use the numeric VALUE from choices[...] — never the label, and never assume a conventional ordering:\n${interesting.join('\n')}`
      );
    } catch (err) {
      parts.push(`Schema for "${intent.trigger_table}" could not be read: ${err.message}. Use only field names you are certain of.`);
    }
  }

  for (const l of intent.lookups || []) {
    if (!l?.table || !l?.name) continue;
    try {
      const attempt = await resolveReference(l.table, l.name);
      const found = attempt.hits;
      const searched = attempt.used;
      // referenceLookup now ranks exact-key > exact-display > starts-with >
      // contains centrally (WI-4), which is where this belongs — this local
      // sort predated it and was the same defect worked around at one call
      // site. Kept because it is stable and idempotent on already-ranked
      // input, and because the model reads this list top-down; if the central
      // ranking ever regresses, this still holds the exact match at the top.
      const wanted = String(searched).trim().toLowerCase();
      const hits = [...found].sort((a, b) => {
        const rank = (h) => (String(h.display).trim().toLowerCase() === wanted ? 0 : 1);
        return rank(a) - rank(b);
      });
      if (hits.length) {
        resolved.push({ table: l.table, search: l.name, resolvedAs: searched, matches: hits });
        // Also surface a few related fields of the best match. Verification
        // assertions frequently name a dot-walked value ("the group's manager"),
        // and without this the model invents a plausible display name — which
        // fails the assertion for a flow that is actually correct.
        const related = [];
        const empties = [];
        try {
          const rec = await table.get(l.table, hits[0].sys_id);
          for (const f of ['name', 'manager', 'email', 'user_name', 'parent', 'assignment_group']) {
            const cell = rec?.[f];
            // Distinguish "absent from this table" from "present but EMPTY".
            // Silently dropping an empty field is what let a verification spec
            // assert a group manager named "John Doe" on a group that has no
            // manager at all: the model was told nothing, so it invented one.
            if (cell === undefined || cell === null) continue;
            const dv = typeof cell === 'object' ? (cell.display_value ?? cell.value) : cell;
            const rv = typeof cell === 'object' ? cell.value : cell;
            if (dv) related.push(`    ${f} = "${dv}"${rv && rv !== dv ? ` (sys_id ${rv})` : ''}`);
            else empties.push(f);
          }
        } catch { /* related fields are a bonus, never required */ }
        if (empties.length) {
          related.push(
            `    EMPTY on this instance (the field exists but has no value): ${empties.join(', ')}. ` +
            `Any effect that depends on one of these produces NOTHING here — never invent a placeholder value for it.`
          );
        }
        parts.push(
          `RESOLVED REFERENCE "${l.name}" on ${l.table}` +
          (attempt.corrected
            ? ` — nothing on this instance is named "${l.name}"; the real record is "${hits[0].display}", so write name=${hits[0].display} and never name=${l.name}`
            : '') +
          `:\n${hits.map((h) => `  sys_id=${h.sys_id} display=${h.display}`).join('\n')}` +
          (related.length ? `\n  fields on "${hits[0].display}" — use these exact display values, do not invent names:\n${related.join('\n')}` : '')
        );
      } else {
        // A lookUpRecord whose query matches nothing does NOT return empty — it
        // ERRORS the whole flow at run time ("No record found in Look Up Record
        // action"). The old guidance said "match by name instead" and handed
        // back the very name that does not exist, so the flow failed on every
        // execution while the build stayed green.
        const sample = await referenceLookup(l.table, '', 8).catch(() => []);
        parts.push(
          `NO MATCH on ${l.table} for "${l.name}" — no record with that name exists on this instance, ` +
          `under that name or any shortening of it. Do NOT write name=${l.name}, and do NOT invent a sys_id: ` +
          `a lookUpRecord whose query matches nothing ERRORS the flow at run time, so that spelling would break ` +
          `every execution.` +
          (sample.length
            ? ` Records that DO exist on ${l.table} include: ${sample.map((h) => `"${h.display}"`).join(', ')}. ` +
              `If one of them is what the request meant, use that exact name.`
            : '') +
          ` If none of them is, leave the lookup out rather than guessing a name.`
        );
      }
    } catch (err) {
      parts.push(`Reference lookup failed for "${l.name}" on ${l.table}: ${err.message}. Match by name in an encoded query instead.`);
    }
  }

  return { text: parts.join('\n\n'), resolved };
}

const HARD_RULES = `HARD RULES — a violation fails the build:
1. Output ONE complete TypeScript source file and NOTHING else. No prose, no markdown fences, no explanation.
2. Every $id must be Now.ID['snake_case_key'], and keys are a PROJECT-WIDE namespace, not a per-file one: one key = one live record, so a key reused from another flow COLLIDES instead of creating a new element. Every key you write must be unique across the WHOLE project and freshly minted for THIS flow: prefix all of them with a short slug of this flow's name (a \"Vendor Hold Problem\" flow uses vhp_trigger, vhp_create_problem, vhp_if_critical). NEVER copy a key from the syntax examples below (they are prefixed ex_ and are already taken), and NEVER write a literal sys_id as an $id. A Now.ID['__ID_n__'] placeholder in a source you are given is an existing record's identity — keep it exactly, never invent a new one.
3. NEVER assign a data pill to a variable. wfa.dataPill(...) goes inline in an action parameter. Capturing an ACTION RESULT in a const is required and correct.
4. TemplateValue, Time, Duration and Now.ID are globals — using them is fine, importing them is an error.
5. Conditions are encoded queries inside template literals: \`\${wfa.dataPill(x, 'string')}=1\`. No JavaScript, no ==, no &&.
6. Template literals interpolate ONLY in ah_subject and log_message. Never in ah_body, SMS message, or inside TemplateValue({...}).
7. lookUpRecord outputs .Record/.Table; lookUpRecords outputs .Records/.Count — capitalised. createRecord/updateRecord output lowercase .record.
8. Per-action value keys differ: values (createRecord/updateRecord), field_values (createTask/updateMultipleRecords), fields (createOrUpdateRecord). lookUpRecord(s) take table + conditions.
9. If the body never reads params, declare the callback () => { — noUnusedParameters is enforced (TS6133). Scheduled flows always use () =>.
9b. For trigger.record.updated / createdOrUpdated you MUST set trigger_strategy explicitly. Omitting it is not neutral: the platform default 'once' fires once EVER for a record and never again, even after it leaves the condition and re-enters. A request phrased "when a record is updated TO <state>" describes a TRANSITION and wants 'unique_changes'; 'every' fires on every save while the condition holds, which duplicates any record the flow creates.
10. Exactly one wfa.trigger(...) for a Flow; a Subflow has none and must be exported as \`export const\`, with assignSubflowOutputs on every reachable path.
11. waitForCompletion belongs in the subflow INPUTS object (3rd arg), not the instance config (2nd arg).
12. Use the resolved sys_ids given below. If a name was not resolved, match by name in an encoded query — never invent an identifier.`;

/**
 * The extra rules a STANDALONE subflow has to satisfy.
 *
 * A subflow is not "a flow without a trigger": it is a callable unit whose
 * inputs and outputs are a published interface. Each rule below is checked
 * mechanically after generation (subflows.js `lintArtifactType`), so it is
 * stated here in the same words the rejection will use.
 */
const SUBFLOW_RULES = `THIS REQUEST IS FOR A SUBFLOW, NOT A FLOW. Additional hard rules:
S1. Emit exactly one \`export const <camelCaseName> = Subflow({ ... }, (params) => { ... })\` and NOTHING else — no Flow(...), no wfa.trigger(...). A subflow runs because another flow calls it; a triggered artifact is stored by the platform as a flow, not a subflow.
S2. The export is mandatory. Without \`export const\` no other flow can import it, so it can never be called.
S3. Declare the INPUTS the request names, in the config's \`inputs\` object, with column types from '@servicenow/sdk/core': StringColumn, IntegerColumn, BooleanColumn, DateTimeColumn, ReferenceColumn. A reference input MUST carry its table: ReferenceColumn({ label: 'Task', referenceTable: 'task', mandatory: true }).
S4. Every declared input MUST be READ in the body via wfa.dataPill(params.inputs.<name>, '<type>'). An input nothing reads is a parameter the caller can pass with no effect.
S5. Declare an OUTPUT for every value the request says the subflow returns, and assign every one of them with wfa.flowLogic.assignSubflowOutputs({ $id: Now.ID['<key>'] }, params.outputs, { <output>: <value>, ... }) on EVERY reachable path. params.outputs is the second argument, always. An output that is never assigned comes back empty and the caller cannot tell that from a legitimately empty value.
S6. If the request promises nothing back, declare no outputs at all rather than declaring one and leaving it unassigned.`;

async function readCheatsheet() {
  try { return await fsp.readFile(CHEATSHEET, 'utf8'); } catch { return ''; }
}

/**
 * Generate one Fluent source file from a plain-language spec.
 * `priorError` carries build diagnostics back into the prompt on a retry.
 */
export async function generate(spec, { intent, context, priorSource, priorError, existingSource, decoding, ledger, artifactType = 'flow', catalog = [] } = {}) {
  // Guard 3: the model never sees a live Now.ID key. Every source fed back into
  // the prompt is neutralised through ONE shared map, so the same record keeps
  // the same placeholder across the deployed source and the retry source, and
  // the real keys are substituted back into the output mechanically.
  const idMap = new Map();
  const existingSan = existingSource ? sanitizeIds(existingSource, idMap).text : null;
  const priorSan = priorSource ? sanitizeIds(priorSource, idMap).text : null;

  const cheatsheet = sanitizeExampleIds(await readCheatsheet());
  const system = [
    'You are a ServiceNow Fluent SDK code generator. You emit ServiceNow Flow Designer flows as TypeScript for @servicenow/sdk v4.',
    HARD_RULES,
    artifactType === 'subflow' ? SUBFLOW_RULES : null,
    '--- SYNTAX REFERENCE (authoritative, build-verified) ---',
    cheatsheet,
  ].filter(Boolean).join('\n\n');

  const userParts = [`AUTOMATION REQUEST:\n${spec}`];
  // The catalog is context, not a suggestion: the prefer-call rule that goes
  // with it is enforced after generation, so a candidate that ignores this is
  // rejected before the build rather than deployed as a duplicate.
  const catalogText = catalogPromptBlock(catalog);
  if (catalogText) userParts.push(`--- ${catalogText}`);
  if (context?.text) userParts.push(`--- LIVE INSTANCE CONTEXT ---\n${context.text}`);
  if (existingSan) {
    // Regeneration of a request already deployed: this must UPDATE the existing
    // records, not create new ones. The platform matches artifacts on their
    // names, so every `name:` must survive verbatim. Identity of the individual
    // elements rides on the __ID_n__ placeholders, which are swapped back for
    // the real keys after generation — keeping one is what updates a record in
    // place instead of creating a duplicate.
    userParts.push(
      `THIS REQUEST WAS ALREADY IMPLEMENTED. Below is the deployed source, with each element's ` +
      `$id replaced by a stable placeholder.\n` +
      `You MUST reuse it as the base and keep EVERY name: value verbatim, and EVERY ` +
      `Now.ID['__ID_n__'] placeholder exactly as it appears on the element it belongs to — ` +
      `they are the stable identity of live records, and changing one creates a duplicate on the ` +
      `instance instead of updating it. Never invent a new __ID_n__ placeholder: an element that ` +
      `is genuinely NEW gets a freshly minted descriptive key instead (see HARD RULE 2). ` +
      `Change only what the request now requires; if nothing changed, return it essentially unchanged.\n` +
      `EXCEPTION — the LIVE INSTANCE CONTEXT above is authoritative and current, and the deployed ` +
      `source is not. Where the two disagree about a VALUE — a group or user name, a field name, a ` +
      `choice value, a sys_id that no longer resolves — the live context wins and you must fix that ` +
      `line. "Keep it verbatim" governs identity (the __ID_n__ placeholders) and the artifact's ` +
      `name: values; it never protects a value the live context has just corrected. A lookUpRecord ` +
      `whose query matches nothing ERRORS the flow on every run, so a stale name left in place is a ` +
      `broken flow, not a preserved one.` +
      `\n\n--- DEPLOYED SOURCE ---\n${existingSan}`
    );
  } else if (intent?.name) {
    userParts.push(`Use this as the artifact name: "${intent.name}"`);
  }
  if (priorSan && priorError) {
    userParts.push(
      `YOUR PREVIOUS ATTEMPT FAILED. Fix it.\n\n--- PREVIOUS SOURCE ---\n${priorSan}\n\n--- DIAGNOSTICS ---\n${priorError}\n\nReturn the COMPLETE corrected file, not a patch.`
    );
  }
  userParts.push('Return only the TypeScript source.');

  // A5: a retry that repeats the previous question cannot produce a different
  // answer. The ledger refuses to send one, loudly, rather than burning an
  // attempt re-asking a question that has already been answered.
  const user = userParts.join('\n\n');
  ledger?.record(user);

  const raw = await chatOnce({ system, user, maxTokens: 12000, decoding });
  return restoreIds(extractSource(raw), idMap);
}

/** Models fence code despite instructions; take the fenced block when present. */
export function extractSource(raw) {
  const text = String(raw || '');
  const fenced = text.match(/```(?:typescript|ts|javascript|js)?\s*\r?\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : text).trim();
}

/* ------------------------------------------------------------------ *
 * validate() + deploy()
 * ------------------------------------------------------------------ */

function extractDiagnostics(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  const lines = text.split('\n').filter((l) => /ERROR|error TS|Build failed|diagnostic/i.test(l));
  return (lines.length ? lines.join('\n') : text).slice(0, 6000).trim();
}

async function build() {
  return serialize(() => runSdk(['build'], BUILD_TIMEOUT_MS));
}

/* ------------------------------------------------------------------ *
 * Shared SDK surface
 *
 * Flows are no longer the only artifact class that has to be written through
 * the toolchain rather than the Table API. Catalog UI policy ACTIONS cannot be
 * written over REST at all on this instance — `sys_ui_policy_action.ui_policy`
 * carries create and write ACLs granting only the role `nobody`, with
 * admin_overrides off, and the Table API DROPS a field the caller may not write
 * instead of refusing the request (fluent-research §23).
 *
 * So catalogPolicy.js drives the same CLI, and it must share this module's job
 * queue: two `now-sdk install` runs at once would each ship a half-built dist/.
 * ------------------------------------------------------------------ */

/** Compile the whole workspace offline. Nothing reaches the instance. */
export async function buildWorkspace() {
  return build();
}

/** Install the workspace. Serialized against every other build/install. */
export async function installWorkspace() {
  return serialize(() => runSdk(['install'], INSTALL_TIMEOUT_MS));
}

export { extractDiagnostics };

/** Where the managed sources live, so a sibling module does not re-derive them. */
export const WORKSPACE_DIRS = {
  workspace: WORKSPACE,
  flows: FLOWS_DIR,
  catalog: path.join(WORKSPACE, 'src/fluent/catalog'),
};

/**
 * Write a candidate into src/ and compile it. Retries with diagnostics fed back
 * to the model — its own identity check first, then the compiler's.
 *
 * Every attempt of one request targets a SINGLE filename derived from the spec
 * fingerprint (guard 2), and each candidate is statically checked for duplicate
 * element identity before the SDK is spawned (guard 1). On terminal failure
 * src/ is restored to its pre-request state and the restoration is ASSERTED,
 * not assumed, so a failed generation provably leaves nothing behind and never
 * reaches the instance — invariants (a), (b) and (d).
 */
export async function generateAndValidate(spec, emit = () => {}, { updates = null, artifactType = null } = {}) {
  const settings = getSettings();
  emit({ type: 'generating' });

  // Guard 2, first half: a candidate on disk means a previous request died
  // without cleaning up. Sweep BEFORE snapshotting, so the snapshot records the
  // clean pre-request state this run is accountable for restoring.
  const swept = await sweepCandidates();
  if (swept.length) {
    emit({ type: 'hygiene_swept', files: swept, note: `Removed ${swept.length} stale candidate file(s) left by an earlier request.` });
  }
  const preRequest = await snapshotSources();

  // Identity of the REQUEST, needed before the first model call: A1 derives its
  // seed from it, so intent extraction is asked for the same sample every time.
  const fingerprint = specFingerprint(spec);

  const intent = await extractIntent(spec, codegenDecoding(fingerprint, 0));
  emit({ type: 'intent', intent });

  // A3: only literals the request itself spells out are enforceable. The intent
  // extractor is the same weak model this guard polices, so its list is
  // intersected with the spec text — it can narrow the guard, never invent it.
  const promisedLiterals = groundLiterals(spec, intent?.promised_literals || []);
  if (promisedLiterals.length) emit({ type: 'promised_literals', literals: promisedLiterals });

  const context = await buildLiveContext(intent);
  if (context.resolved.length) emit({ type: 'resolved', resolved: context.resolved });

  // Invariant (d): identity follows the request, not the model's chosen name.
  //
  // Two ways to land on an existing artifact:
  //   - same request again  → matched by spec fingerprint
  //   - EDITED request      → the caller names the artifact it supersedes via
  //                           `updates`, because a changed spec fingerprints
  //                           differently and would otherwise create a second
  //                           artifact rather than updating the first.
  let existing = null;
  if (updates) {
    const target = sourcePath(updates);
    if (fs.existsSync(target)) {
      existing = { file: path.basename(target), source: await fsp.readFile(target, 'utf8') };
      emit({ type: 'regenerating', file: existing.file, note: `Updating "${updates}" in place.` });
    } else {
      emit({ type: 'update_target_missing', updates, note: `No managed source named "${updates}"; generating a new artifact instead.` });
    }
  }
  if (!existing) {
    existing = await findSourceByFingerprint(fingerprint);
    if (existing) emit({ type: 'regenerating', file: existing.file, note: 'Updating the artifact this request already deployed.' });
  }

  // What KIND of artifact is being built. Three sources, in falling order of
  // authority, and the winner is reported rather than assumed:
  //   existing  — a regeneration cannot change an artifact's kind. The platform
  //               stores flows and subflows in the same table under different
  //               `type` values, so flipping the kind would orphan the record
  //               the Now.ID keys still point at.
  //   explicit  — the panel's selector, or the agent's `artifact_type`.
  //   intent    — the extractor's `kind`, which is the weakest of the three
  //               and is only consulted when nobody said.
  const existingArtifacts = existing ? parseArtifactContracts(existing.source) : [];
  const existingKind = existingArtifacts.length && existingArtifacts.every((a) => a.kind === 'subflow') ? 'subflow' : null;
  const requestedType = artifactType === 'subflow' || artifactType === 'flow' ? artifactType : null;
  const intentType = intent?.kind === 'subflow' ? 'subflow' : 'flow';
  const kind = existingKind || requestedType || intentType;
  emit({
    type: 'artifact_type',
    artifactType: kind,
    decidedBy: existingKind ? 'existing source' : requestedType ? 'the request' : 'intent extraction',
    ...(requestedType && existingKind && requestedType !== existingKind
      ? { note: `"${updates}" is already a ${existingKind}; a regeneration cannot change its kind.` }
      : {}),
  });

  // Step 3: the reuse catalog. Built from every OTHER managed source, so a
  // regeneration is never told to call itself.
  const catalog = buildCatalog(await readProjectSources({ except: existing?.file || null }));
  if (catalog.length) emit({ type: 'subflow_catalog', subflows: catalog.map((c) => ({ name: c.name, file: c.file, inputs: c.inputs.map((i) => i.name) })) });

  // Guard 2, second half: ONE filename for every attempt of this request.
  // Regeneration writes the artifact's own source; a new artifact writes a
  // fingerprint-named candidate and is renamed to its slug only once it builds.
  // The model's chosen flow name never selects the file it is written to.
  const targetFile = existing ? path.join(FLOWS_DIR, existing.file) : candidatePath(fingerprint);

  // A2 — flow identity is pinned ONCE per request, then enforced mechanically.
  //
  // The platform matches artifacts by NAME, so a rename is not cosmetic: it
  // creates a second flow instead of updating the first. Measured across six
  // live runs of one spec, this model produced a different name every time
  // ("...Vendor Issues", "...Vendor Incidents", "...Vendor Incident"), and the
  // HARD RULE asking it not to had no effect. So the name is not requested — it
  // is imposed on the output, and every correction is reported.
  //
  // On a regeneration the pin is the DEPLOYED name (the string the instance is
  // already matching on). On a new request it is the intent name, which is
  // extracted once and therefore stable across this request's attempts.
  const pins = existing
    ? findArtifactNames(existing.source).map(({ kind: k, name }) => ({ kind: k, name }))
    : (intent?.name ? [{ kind, name: intent.name }] : []);
  if (pins.length) emit({ type: 'identity_pinned', pins });

  // A5 — refuses to send a retry that repeats an earlier prompt verbatim.
  const ledger = new RetryLedger('codegen');

  let source = null;
  let lastDiagnostics = null;
  const attempts = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    emit({ type: 'attempt', attempt, of: MAX_ATTEMPTS });

    source = await generate(spec, {
      intent,
      context,
      existingSource: existing?.source,
      priorSource: attempt > 1 ? source : undefined,
      priorError: attempt > 1 ? lastDiagnostics : undefined,
      // A1: same request, same attempt, same sample requested. Whether the
      // backend honours it is measured and reported, never assumed.
      decoding: codegenDecoding(fingerprint, attempt),
      ledger,
      artifactType: kind,
      catalog,
    });
    source = stampSource(source, fingerprint);

    // A2: impose the pinned name before anything else reads it — the filename,
    // the install read-back and the verification spec all key off this string.
    const pinned = pinArtifactNames(source, pins);
    source = pinned.source;
    if (pinned.rewrites.length) {
      emit({ type: 'identity_rewritten', attempt, rewrites: pinned.rewrites });
    }

    const artifacts = parseArtifacts(source);
    // For a subflow request the subflow IS the artifact, so it names the file
    // and the read-back. Taking the flow first would name a subflow-only
    // source after nothing at all.
    const primary = kind === 'subflow'
      ? artifacts.find((a) => a.kind === 'subflow')
      : artifacts.find((a) => a.kind === 'flow');
    const name = primary?.name || artifacts[0]?.name || intent.name || 'Generated Flow';

    // Pre-build static gate. All three checks run TOGETHER and their diagnostics
    // are fed back as one message: rejecting on the first problem only would
    // spend an attempt per defect, and the budget is 3.
    const staticErrors = [];
    const stages = [];

    // A3 — text the request dictates verbatim must survive into the source.
    const litCheck = checkPromisedLiterals(source, promisedLiterals);
    if (!litCheck.ok) {
      staticErrors.push(litCheck.diagnostic);
      stages.push('literals');
      emit({ type: 'literals_rejected', attempt, missing: litCheck.missing });
    }

    // Step 1 — the artifact that was asked for is the artifact that must come
    // back, and a subflow's declared contract must be one the body honours.
    const typeCheck = lintArtifactType(source, kind);
    if (!typeCheck.ok) {
      staticErrors.push(typeCheck.diagnostic);
      stages.push('artifact_type');
      emit({ type: 'artifact_type_rejected', attempt, artifactType: kind, errors: typeCheck.errors });
    }

    // Step 3 — the prefer-call rule. A candidate that re-creates a subflow this
    // project already deploys is rejected with the existing one named, because
    // a duplicate does not collide: it builds cleanly and doubles the number of
    // records that have to be kept in step.
    const reuseCheck = lintSubflowReuse(source, catalog, { file: path.basename(targetFile) });
    if (!reuseCheck.ok) {
      staticErrors.push(reuseCheck.diagnostic);
      stages.push('subflow_reuse');
      emit({ type: 'subflow_reuse_rejected', attempt, errors: reuseCheck.errors });
    }

    // A4 — an updated trigger without an explicit strategy inherits `once`,
    // which fires once EVER per record. Nothing downstream can observe it.
    const trigCheck = lintTriggerStrategy(source, spec);
    if (!trigCheck.ok) {
      staticErrors.push(trigCheck.diagnostic);
      stages.push('trigger_strategy');
      emit({ type: 'trigger_strategy_rejected', attempt, errors: trigCheck.errors, strategy: trigCheck.strategy });
    }

    // Guard 1: identity, BEFORE the SDK runs. The SDK's own abort names a
    // sys_id the model never wrote.
    //
    // Collisions with another source are rewritten rather than reported: the
    // model ignored that diagnostic three times in a row on a real run. What
    // reaches the validator below is only what a rewrite cannot fix.
    const others = await readProjectSources({ except: path.basename(targetFile) });
    const spaced = namespaceCollidingIds(source, others, { file: path.basename(targetFile) });
    if (spaced.renames.length) {
      source = spaced.source;
      emit({ type: 'ids_namespaced', attempt, renames: spaced.renames });
    }
    const idCheck = validateCandidateIds(source, others, { file: path.basename(targetFile) });
    if (!idCheck.ok) {
      staticErrors.push(idCheck.diagnostic);
      stages.push('identity');
      emit({ type: 'identity_rejected', attempt, errors: idCheck.errors });
    }

    if (staticErrors.length) {
      lastDiagnostics = staticErrors.join('\n');
      attempts.push({ attempt, stage: stages.join('+'), diagnostics: lastDiagnostics });
      continue; // never written to src/, never built
    }

    await fsp.mkdir(FLOWS_DIR, { recursive: true });
    await fsp.writeFile(targetFile, source, 'utf8');

    emit({ type: 'building', attempt, file: path.basename(targetFile) });
    const res = await build();

    if (res.ok) {
      emit({ type: 'built', attempt });
      let file = targetFile;
      // A brand-new artifact now earns its readable slug. Renaming is safe only
      // once it has built, and only onto a free name: clobbering another spec's
      // source would delete that artifact from the instance on the next install.
      if (!existing) {
        const finalPath = sourcePath(name);
        if (finalPath !== targetFile) {
          if (fs.existsSync(finalPath)) {
            await restoreSources(preRequest);
            const drift = await diffAgainstSnapshot(preRequest);
            return {
              ok: false,
              stage: 'naming',
              attempts: attempt,
              diagnostics: `A different source already occupies ${path.basename(finalPath)}.`,
              hygiene: { restored: drift.length === 0, drift },
              message:
                `"${name}" collides with the existing source ${path.basename(finalPath)}, which belongs to a ` +
                `different request. Nothing was deployed. Re-run naming this artifact as the one to update, ` +
                `so it is superseded in place instead of duplicated.`,
            };
          }
          await fsp.rename(targetFile, finalPath);
          file = finalPath;
        }
      }
      return {
        ok: true, source, file, name, artifacts, intent, context, attempts: attempt,
        artifactType: kind,
        // The contract is parsed from the source that just compiled, so it is
        // what the install is about to deploy — not a summary of it.
        contract: kind === 'subflow' ? parseSubflowContract(source) : null,
      };
    }

    lastDiagnostics = extractDiagnostics(res);
    attempts.push({ attempt, stage: 'build', diagnostics: lastDiagnostics });
    emit({ type: 'build_failed', attempt, diagnostics: lastDiagnostics });
  }

  // Terminal failure — restore src/ to exactly its pre-request state. This is a
  // restore, not a delete: on a regeneration `targetFile` IS the deployed
  // artifact's source, and removing it would drop a live flow from the instance
  // on the next install.
  await restoreSources(preRequest);
  const drift = await diffAgainstSnapshot(preRequest);
  if (drift.length) {
    emit({ type: 'hygiene_violation', drift, note: 'src/ did not return to its pre-request state.' });
  }
  const cleanup = await build();

  const hint = settings.llm.provider === 'ollama'
    ? 'The configured provider is Ollama. Fluent codegen is demanding; switching to a stronger provider (Anthropic/OpenAI) in Settings is the first lever if generation keeps failing.'
    : null;

  return {
    ok: false,
    attempts: MAX_ATTEMPTS,
    diagnostics: lastDiagnostics,
    history: attempts,
    lastSource: source,
    cleanedUp: cleanup.ok,
    cleanupError: cleanup.ok ? null : extractDiagnostics(cleanup),
    // Invariant (b), asserted rather than asserted-in-a-comment.
    hygiene: { restored: drift.length === 0, drift, sweptOnEntry: swept },
    hint,
    message: drift.length
      ? `Generation failed after ${MAX_ATTEMPTS} attempts, and src/ did NOT return to its pre-request state: ${drift.join('; ')}. Nothing was deployed, but the workspace needs inspection.`
      : `Generation failed after ${MAX_ATTEMPTS} attempts. The candidate was removed, src/ was verified back to its pre-request state, and nothing was deployed.`,
  };
}

function parseInstall(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  return {
    activation: text.match(/Flow activation complete:\s*(\d+\/\d+)\s*succeeded/i)?.[1] || null,
    rollbackUrl: text.match(/(https?:\/\/\S*sys_rollback_context\.do\?sys_id=\w+)/i)?.[1] || null,
    appUrl: text.match(/(https?:\/\/\S*sys_app\.do\?sys_id=\w+)/i)?.[1] || null,
  };
}

/**
 * Install the workspace and read the result back off the instance.
 * `now-sdk install` ships the WHOLE application, so the returned `shipped` list
 * names every artifact the deploy touched — not just the requested one.
 */
export async function deploy(name, emit = () => {}) {
  // `install` ships whatever is in dist/, which is only as fresh as the last
  // build. Deploying without building silently installs a stale package — a
  // restored source file appeared to deploy 3/3 while never reaching the
  // instance at all. Building here makes invariant (a) hold for every caller,
  // not just the ones that remember.
  emit({ type: 'building' });
  const pre = await build();
  if (!pre.ok) {
    return { ok: false, message: 'Build failed; nothing was installed.', diagnostics: extractDiagnostics(pre) };
  }

  /*
   * B7 — the binding preflight, on the flow/SLA/catalog path too.
   *
   * This path was unguarded while the DBA one was, which is backwards: it is
   * the older and busier of the two. It runs after the build (so a spec that
   * was never going to compile is not charged a probe) and before the install
   * (because the install is the thing that becomes untrue).
   */
  emit({ type: 'binding_check' });
  let binding;
  try {
    binding = await assertTiersAgree();
  } catch (err) {
    return { ok: false, message: err.message, bindingRefused: true, detail: err.detail ?? null };
  }
  emit({ type: 'binding_ok', host: binding.host });

  emit({ type: 'deploying' });
  const res = await serialize(() => runSdk(['install'], INSTALL_TIMEOUT_MS));
  const parsed = parseInstall(res);

  /*
   * B5 — install state is filed UNDER the instance it happened on.
   *
   * A rollback URL is an instruction to undo something on a specific host. The
   * flat `lastInstall` this replaced held a dev442675 URL long after the app
   * had been rebound to dev428633, so the one piece of state whose whole
   * purpose is to point at a real thing pointed at the wrong system.
   */
  writeInstanceState(binding.host, {
    lastInstall: {
      at: new Date().toISOString(),
      ok: res.ok,
      activation: parsed.activation,
      rollbackUrl: parsed.rollbackUrl,
      requested: name || null,
      instance: binding.host,
    },
  });

  if (!res.ok) {
    return { ok: false, message: 'now-sdk install failed.', diagnostics: extractDiagnostics(res), ...parsed };
  }

  emit({ type: 'verifying' });
  const settings = getSettings();
  const base = (settings.connection.instanceUrl || '').replace(/\/+$/, '');

  // Everything currently in src/ shipped — be transparent about whole-app semantics.
  const files = await listSourceFiles();
  const shipped = [];
  for (const f of files) {
    const src = await fsp.readFile(path.join(FLOWS_DIR, f), 'utf8').catch(() => '');
    for (const a of parseArtifacts(src)) shipped.push({ ...a, file: f });
  }

  let verified = null;
  if (name) {
    const hits = await flows.findByName(name);
    const row = hits[0];
    if (row) {
      const sysId = row.sys_id?.value ?? row.sys_id;
      const detail = await flows.detail(sysId);
      const type = detail.flow.type?.value ?? detail.flow.type;
      verified = {
        sys_id: sysId,
        name: detail.flow.name?.value ?? detail.flow.name,
        type,
        internal_name: detail.flow.internal_name?.value ?? detail.flow.internal_name ?? null,
        // A subflow's contract is read back off the instance, not inferred from
        // the source that was just installed. The two are reported side by side
        // so a drift is visible instead of assumed away.
        contract: type === 'subflow' ? await flows.contract(sysId).catch(() => null) : null,
        active: (detail.flow.active?.value ?? detail.flow.active) === 'true',
        link: base ? `${base}/nav_to.do?uri=sys_hub_flow.do?sys_id=${sysId}` : null,
        sourceTables: detail.sourceTables,
        triggers: detail.triggers.length,
        actions: detail.actions.length,
        logic: detail.logic.length,
        notes: detail.notes,
      };
    }
  }

  return {
    ok: true,
    ...parsed,
    verified,
    shipped,
    shippedNote: `now-sdk install deploys the whole application: this install shipped ${shipped.length} artifact(s) from ${files.length} source file(s).`,
  };
}

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

/** Full pipeline: spec → validated source → install → read-back. */
export async function createLiveFlow(spec, emit = () => {}, { updates = null, artifactType = null } = {}) {
  const cap = await capability();
  if (!cap.ok) {
    return { ok: false, stage: 'capability', message: 'Live Fluent authoring is not available in this environment.', capability: cap };
  }

  const gen = await generateAndValidate(spec, emit, { updates, artifactType });
  if (!gen.ok) return { ok: false, stage: 'validate', ...gen };

  // Verification spec. A record-triggered flow is proven by firing it; a
  // SUBFLOW is proven by calling it through the execution harness. Only a
  // scheduled flow is left with metadata-only verification, and that is
  // because no supported manual-execute path exists for one (§11).
  let verification = { available: false, reason: null };
  const isSubflow = gen.artifactType === 'subflow';
  const isRecordTriggered = !isSubflow && String(gen.intent?.trigger_kind || '').startsWith('record');
  if (isSubflow || isRecordTriggered) {
    const vr = await generateVerification(
      {
        spec, source: gen.source, context: gen.context, flowName: gen.name,
        promisedEffects: gen.intent?.promised_effects || [],
        artifactType: gen.artifactType,
        contract: gen.contract ? { ...gen.contract, name: gen.name } : null,
      },
      emit
    );
    if (vr.ok) {
      await fsp.writeFile(verifyPath(gen.name), JSON.stringify(vr.spec, null, 2), 'utf8');
      verification = {
        available: true,
        file: path.basename(verifyPath(gen.name)),
        attempts: vr.attempts,
        kind: isSubflow ? 'subflow' : 'flow',
        // A subflow spec proves effects AND returned values, so the count a
        // reader sees has to include both or a spec that checks two outputs
        // reads as one that checks nothing.
        assertions: (vr.spec.assert?.length || 0) + (vr.spec.expectOutputs?.length || 0),
        // Promises this instance cannot show, each confirmed by measurement.
        // Reported so a partial proof never reads as a complete one.
        unverifiable: vr.unverifiable || [],
      };
      emit({
        type: 'verify_spec_ready',
        assertions: verification.assertions,
        attempts: vr.attempts,
        unverifiable: (vr.unverifiable || []).length,
      });
    } else {
      // Loud, not silent: the flow still deploys, but the gap is reported.
      verification = { available: false, reason: `Could not produce a valid verification spec in ${vr.attempts} attempts.`, errors: vr.errors };
      emit({ type: 'verify_spec_failed', errors: vr.errors });
    }
  } else {
    verification = { available: false, reason: `Trigger kind "${gen.intent?.trigger_kind}" is not verified by firing; use schedule-metadata verification.` };
  }

  const dep = await deploy(gen.name, emit);
  if (!dep.ok) return { ok: false, stage: 'deploy', ...dep, source: gen.source, verification };

  // No terminal 'done' here — the caller (route) emits it with the full result,
  // and emitting a bare one first would give consumers two terminal events.
  // Same ordering discipline as removeManaged: dep first, verdict last.
  return {
    ...dep,
    ok: true,
    name: gen.name,
    file: path.basename(gen.file),
    artifacts: gen.artifacts,
    attempts: gen.attempts,
    source: gen.source,
    artifactType: gen.artifactType,
    // Two readings of the same contract: what the source that just compiled
    // declares, and what the instance actually stored. Reported side by side
    // rather than one standing in for the other.
    contract: gen.contract,
    verification,
  };
}

/** Managed artifacts: the source files, plus their live state on the instance. */
export async function listManaged() {
  const files = await listSourceFiles();
  const sources = await readProjectSources();
  // One parse of the whole project answers "what does this call" and "what
  // calls this" for every artifact — asking per artifact would re-read every
  // source once per row.
  const { nodes } = buildDependencyGraph(sources);
  const edges = new Map(nodes.map((n) => [n.name, n]));
  const contracts = new Map();
  for (const { source } of sources) {
    for (const a of parseArtifactContracts(source)) {
      if (a.kind === 'subflow' && a.name) {
        // `description` rides along because it is the only field that says what
        // the subflow DOES. A caller reading input names alone can hold exactly
        // the subflow it needs and not recognise it — measured in §32 A3.
        contracts.set(a.name, { description: a.description, inputs: a.inputs, outputs: a.outputs, exportName: a.exportName });
      }
    }
  }

  const out = [];
  for (const f of files) {
    const src = await fsp.readFile(path.join(FLOWS_DIR, f), 'utf8').catch(() => '');
    for (const a of parseArtifacts(src)) {
      let live = null;
      try {
        const hits = await flows.findByName(a.name);
        const row = hits[0];
        if (row) {
          live = {
            sys_id: row.sys_id?.value ?? row.sys_id,
            active: (row.active?.value ?? row.active) === 'true',
            type: row.type?.value ?? row.type,
            updated: row.sys_updated_on?.value ?? row.sys_updated_on,
          };
        }
      } catch (err) { live = { error: err.message }; }
      const vf = verifyPath(a.name);
      let verification = { available: false };
      if (fs.existsSync(vf)) {
        try {
          const vs = JSON.parse(await fsp.readFile(vf, 'utf8'));
          verification = {
            available: true,
            file: path.basename(vf),
            kind: vs.kind === 'subflow' ? 'subflow' : 'flow',
            // Output checks count: a subflow spec that proves two returned
            // values and touches no record is not a spec with zero assertions.
            assertions: (vs.assert?.length ?? 0) + (vs.expectOutputs?.length ?? 0),
            setupTable: vs.setup?.table,
          };
        } catch { verification = { available: false, error: 'verification spec unreadable' }; }
      }
      const edge = edges.get(a.name) || { calls: [], calledBy: [], unresolved: [] };
      out.push({
        file: f, name: a.name, kind: a.kind, live, verification,
        contract: contracts.get(a.name) || null,
        calls: edge.calls,
        calledBy: edge.calledBy,
        unresolvedCalls: edge.unresolved,
      });
    }
  }
  const staged = await fsp.readdir(STAGED_DIR).catch(() => []);
  return { managed: out, staged: staged.filter((f) => f.endsWith('.now.ts')) };
}

/**
 * Delete a managed artifact. Removing the source is the SDK's own deletion
 * mechanism: the build marks the record `deleted: true` in keys.ts (retaining
 * its sys_id) and the next install removes it from the instance. Now.del() is
 * reserved for out-of-box records the SDK never created.
 */
export async function removeManaged(name, emit = () => {}) {
  const file = sourcePath(name);
  if (!fs.existsSync(file)) {
    // "No managed source file" is true and useless when the artifact IS managed
    // and simply shares a file with another one — a flow+subflow pair lives in
    // one source named after the flow. Say which file holds it instead.
    const holder = (await readProjectSources()).find((s) => parseArtifacts(s.source).some((a) => a.name === name));
    if (holder) {
      const siblings = parseArtifacts(holder.source).filter((a) => a.name !== name).map((a) => `"${a.name}"`);
      return {
        ok: false,
        message:
          `"${name}" is declared in ${holder.file}, together with ${siblings.join(', ') || 'nothing else'}, so it has no ` +
          `source file of its own to remove. Deleting that file would remove every artifact in it. Regenerate ` +
          `${siblings.length ? siblings.join(', ') : 'the file'} without this artifact, or delete the file's own artifact by name.`,
      };
    }
    return { ok: false, message: `No managed source file for "${name}" (expected ${path.basename(file)}).` };
  }
  const src = await fsp.readFile(file, 'utf8');
  const artifacts = parseArtifacts(src);

  // Dependency safety. Removing a source is a pending DELETE: the next install
  // takes the record off the instance. If a live flow still calls it, that flow
  // keeps its wfa.subflow step pointing at a record that no longer exists — the
  // build stays green (the caller's own source is untouched) and every
  // execution fails at that step. So the delete is refused with the callers
  // NAMED, which is the only form of this message anyone can act on.
  const sources = await readProjectSources();
  const blocked = [];
  for (const a of artifacts) {
    const callers = callersOf(a.name, sources).filter((c) => !artifacts.some((x) => x.name === c));
    if (callers.length) blocked.push({ artifact: a.name, callers });
  }
  if (blocked.length) {
    const detail = blocked
      .map((b) => `"${b.artifact}" is still called by ${b.callers.map((c) => `"${c}"`).join(', ')}`)
      .join('; ');
    return {
      ok: false,
      blocked,
      message:
        `Refusing to delete: ${detail}. Deleting it would leave those callers pointing at a record that no ` +
        `longer exists — their own source is unchanged, so the build stays green and every execution fails ` +
        `at the subflow step. Delete or edit the caller first, then remove this.`,
    };
  }

  await fsp.rm(file, { force: true });
  // The verification spec belongs to the source; it must not outlive it.
  await fsp.rm(verifyPath(name), { force: true });
  emit({ type: 'building' });
  const b = await build();
  if (!b.ok) {
    return { ok: false, message: 'Build failed after removing the source; nothing was deployed.', diagnostics: extractDiagnostics(b) };
  }

  const dep = await deploy(null, emit);
  if (!dep.ok) return { ok: false, ...dep };

  // Confirm removal by read-back rather than trusting the install output.
  const stillThere = [];
  for (const a of artifacts) {
    const hits = await flows.findByName(a.name).catch(() => []);
    if (hits.length) stillThere.push(a.name);
  }

  // `dep` carries its own ok:true for the install. It must be spread FIRST so
  // the removal verdict below wins — spreading it last silently reported a
  // successful delete for an artifact that was still on the instance.
  return {
    ...dep,
    ok: stillThere.length === 0,
    removed: artifacts.map((a) => a.name),
    stillPresent: stillThere,
    message: stillThere.length
      ? `Install completed but ${stillThere.join(', ')} is still present on the instance.`
      : `Removed ${artifacts.map((a) => a.name).join(', ')} from the instance.`,
  };
}

/**
 * Optional smoke run: create a record that should match a flow's trigger, wait
 * for an execution context, then delete the record again.
 *
 * This writes real data to the instance, so it is NEVER run automatically as
 * part of a deploy — the UI exposes it as an explicit button and the agent must
 * request it as its own approved tool call.
 */
export async function smokeRun({ table: tableName, values, waitMs = 45_000 }, emit = () => {}) {
  if (!tableName || !values || typeof values !== 'object') {
    return { ok: false, message: 'table and values are required for a smoke run.' };
  }

  emit({ type: 'smoke_creating', table: tableName });
  const created = await table.create(tableName, values);
  const sysId = created.sys_id?.value ?? created.sys_id;
  const label = created.number?.value ?? created.name?.value ?? sysId;

  const deadline = Date.now() + waitMs;
  let executions = [];
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      executions = await table.query('sys_flow_context', {
        query: `source_record=${sysId}`,
        fields: 'sys_id,name,state,sys_created_on',
        limit: 10,
      });
      if (executions.length) break;
      emit({ type: 'smoke_waiting', elapsedMs: waitMs - (deadline - Date.now()) });
    }

    // Give in-flight actions a moment to land before reading the record back.
    if (executions.length) await new Promise((r) => setTimeout(r, 4000));
    const after = await table.get(tableName, sysId);

    emit({ type: 'smoke_cleanup' });
    return {
      ok: executions.length > 0,
      record: { sys_id: sysId, label },
      executions: executions.map((e) => ({
        name: e.name?.display_value ?? e.name,
        state: e.state?.display_value ?? e.state,
        created: e.sys_created_on?.value ?? e.sys_created_on,
      })),
      recordAfter: after,
      message: executions.length
        ? `Flow executed: ${executions.length} execution context(s) for ${label}.`
        : `No execution context appeared within ${Math.round(waitMs / 1000)}s for ${label}. The trigger condition may not match this record.`,
    };
  } finally {
    // The test record is always removed, even if polling threw.
    await table.remove(tableName, sysId).catch(() => {});
  }
}

/* ================================================================== *
 * Semantic verification
 *
 * Compiling proves a flow is well-formed; it says nothing about whether the
 * flow does what the request asked for. A flow that fires on Low risk when the
 * spec said High compiles and installs perfectly. So each record-triggered
 * flow gets a verification spec (<slug>.verify.json, ignored by the build)
 * describing how to prove its CLAIMED effects on a real record:
 *
 *     setup   → create a record that satisfies the flow's own trigger condition
 *     wait    → poll sys_flow_context until this execution settles
 *     assert  → check the effects the request promised
 *     cleanup → always, even on failure
 *
 * What this catches: wrong field written, effect never applied, flow never
 * fired, flow errored. What it CANNOT catch: a trigger condition that is wrong
 * in the same direction as the setup payload (both derived from the same
 * misreading), effects on records the assertions don't look at, and anything
 * timing-dependent beyond the wait window.
 * ================================================================== */

const TERMINAL_OK = ['COMPLETE'];
const TERMINAL_BAD = ['ERROR', 'CANCELLED', 'PRESUMED_INTERRUPTED'];
// A flow that hits an approval or a wait legitimately stops here; its effects
// up to that point are still assertable.
const SETTLED_PAUSED = ['WAITING', 'PAUSED'];

const verifyPath = (name) => path.join(FLOWS_DIR, `${slugify(name)}.verify.json`);

const VERIFY_SYSTEM = `You write a VERIFICATION SPEC that proves a ServiceNow flow actually does what a request asked for.

You are given the automation request, the compiled Fluent source of the flow, and live schema context. Respond with ONLY a JSON object — no prose, no markdown fences:

{
  "setup":   { "table": "<table the flow triggers on>",
               "payload": { "<field>": "<value>", ... },
               // ONLY for a record-UPDATED trigger. Omit entirely otherwise.
               "update":  { "<field>": "<value>", ... } },
  "wait":    { "flowName": "<exact flow name>", "timeoutSec": 90 },
  "assert":  [ { "table": "<table to read>",
                 "locate": { "bySetupRecord": true } | { "byQuery": "<encoded query>" },
                 "field": "<field name>",
                 "expect": { "value": "<raw value>" } | { "display": "<display value>" },
                 "note": "<what promise of the request this proves>" },

               // SLA assertion — use ONLY when the request promises an SLA clock.
               { "type": "sla",
                 "sla": "<exact contract_sla name, or its sys_id>",
                 "locate": { "bySetupRecord": true },
                 "expect": { "attached": true, "stage": "in_progress", "breached": false,
                             "plannedEndToleranceSec": 120 },
                 "note": "<the promise this proves>" } ],
  "cleanup": [ { "table": "<table>", "locate": { "bySetupRecord": true } | { "byQuery": "<encoded query>" } } ],

  // ONLY for a promised effect that CANNOT be observed on this instance. Omit when there are none.
  "unverifiable": [ { "effect": "<the promised effect, quoted exactly from PROMISED EFFECTS>",
                      "kind": "field_absent" | "source_empty",
                      "table": "<table>", "field": "<field>",
                      "sys_id": "<record the empty value would come from — required for source_empty>",
                      "note": "<why this instance cannot show the effect>" } ],

  // ONLY for flows that pause (Ask For Approval, Wait For Condition). Omit otherwise.
  "resume":            { "table": "sysapproval_approver",
                         "locate": { "byQuery": "document_id={{setup.sys_id}}" },
                         "patch": { "state": "approved" },
                         "waitSec": 90,
                         "note": "approve the request so the flow continues" },
  "assertAfterResume": [ { ...same shape as an assert... } ]
}

RULES:
1. setup.payload MUST satisfy the flow's own trigger condition — read the condition out of the source and mirror it exactly, using real sys_ids and real numeric choice VALUES from the live context.
2. Every assertion must test an effect the REQUEST PROMISED (a field the flow writes, a record the flow creates, a note the flow adds).
3. FORBIDDEN: asserting a field that setup.payload itself sets. That is trivially true and proves nothing about the flow. If the request promises "set assigned_to when empty", then setup.payload must NOT set assigned_to, and the assertion checks assigned_to afterwards.
3b. COVER EVERY PROMISE: produce one assertion for EACH observable effect listed under PROMISED EFFECTS below. If three effects are promised, the spec needs three assertions. Asserting fewer than the request promises is incomplete and will be rejected.
3c. UNVERIFIABLE PROMISES — the ONE exception to 3b, and it is checked. A request can promise something this instance has no way to show: the field it would be written to does not exist here, or the value it would be copied from is EMPTY on the record it comes from. Do not fake such an effect, and do not silently drop it either. List it under "unverifiable" with the effect quoted, kind "field_absent" (name the table and the missing field) or "source_empty" (name the table, the field, and the sys_id of the record it would be read from), and a short note. Each excuse is CHECKED against the live instance: if the field turns out to exist, or the value turns out to be non-empty, the excuse is rejected and you must assert the effect instead. Excusing an effect you simply found hard to assert will therefore fail. Use this only when the LIVE INSTANCE CONTEXT or the evidence below shows the effect is impossible here.
4. Use "display" for reference fields and choice fields (a person's name, a group's name); use "value" for raw strings, numbers and journal text.
5. For journal fields (work_notes, comments) assert the distinctive text the flow writes — a substring match is applied.
6. In byQuery you may use the token {{setup.sys_id}}, which is replaced with the created record's sys_id. Use it to find records the flow created (e.g. "parent={{setup.sys_id}}").
6b. {{setup.sys_id}} is the ONLY token, and it works ONLY inside locate.byQuery. NEVER put {{...}} in expect.value or expect.display — nothing substitutes it there, it is compared literally, and it fails a flow that is working. If an expected value is not knowable when you write the spec (a generated number like PRB0012345, a sys_id), do not guess it: move the proof into the LOCATOR. Locate with a query that can only match when the effect happened, then assert a field whose value you DO know. A locator that matches nothing is reported as a failed assertion, so the locator carries the proof.
6d. EXPECTED VALUES ARE LITERAL. Comparison is exact for ordinary fields and containment for journal fields; there are no wildcards and no phrases. Never write "*", "%", "not empty", "any ...", or "<something>" as an expected value. If part of the text is generated (a PRB/INC number, a sys_id, a timestamp), assert only the FIXED text around it — for a work note reading "Problem PRB0012345 created", assert " created". To prove a field is merely set, put ISNOTEMPTY in the locator and assert a field whose value you know.
6c. Never assert a field that is not in the REAL SCHEMA below, and never assume a value for a field the live context reports as EMPTY on this instance — an effect that depends on an empty field produces nothing here, so asserting a made-up value fails a correct flow.
7. cleanup MUST include the setup record ({ "bySetupRecord": true }) plus every record the flow creates.
8. Keep setup.payload minimal: only what the trigger condition requires, plus a short_description so the record is identifiable.
9. DERIVED FIELDS — critical. On task tables (incident, problem, change_request, sc_task) "priority" is CALCULATED from "impact" and "urgency". Writing priority directly is silently overwritten on insert: {"priority":"1"} lands as 4 - Low. To create a P1 record set {"impact":"1","urgency":"1"} and do NOT set priority at all. The same applies to any field the platform computes — set the inputs, not the result.
10. setup.payload must make the trigger condition TRUE after the platform's own rules run, not merely look like it. If the trigger tests a calculated field, drive it through the fields it is calculated from.
10b. RECORD-UPDATED TRIGGERS. Read the trigger out of the source. If it is trigger.record.updated (not .created / .createdOrUpdated), an insert can NEVER fire it — the flow only runs on a transition. Split setup in two:
    - "payload" creates the record OUTSIDE the trigger condition (do not satisfy the condition here);
    - "update" is the patch that moves it INTO the trigger condition, and that is what fires the flow.
    Rule 9 still applies to BOTH halves: to reach Critical priority put {"impact":"1","urgency":"1"} in the half that needs it and never write "priority" directly.
    Rule 3 also applies to both: a field written by "update" cannot be asserted on the setup record.
    Use "update" ONLY for an updated trigger. For a created trigger, omit it — a created flow fires on the insert and an extra update proves nothing.
11b. SLA ASSERTIONS. If the request promises that a record gets an SLA — a response or resolution clock, a breach time — assert it with { "type": "sla" } rather than by reading fields. It resolves the named contract_sla, finds the task_sla row that references THAT DEFINITION on the setup record, and checks the breach clock. Two rules:
    - Name the definition exactly. Asserting "a task_sla exists" proves nothing: this instance attaches its own out-of-box SLAs to the same record, and one P1 incident was measured attaching THREE rows. The assertion is "this definition attached", never "an SLA attached".
    - State expect.plannedEndToleranceSec yourself. The clock starts when the platform attaches the row, not when the runner posted the record, so the two differ by however long the insert took. 120 is a sensible value; a tolerance nobody can see in the spec is a number nobody can review.
    Do NOT hand-assert planned_end_time with a field assertion. Those times are stored in UTC and rendered to the session timezone, and a literal comparison against either half fails a correct SLA.

11. PAUSING FLOWS. If the source contains askForApproval (or any wait), the flow STOPS there and everything after it has not run yet. Split the assertions:
    - "assert" holds only what is true while paused. For an approval this MUST prove WHO the approval was raised for, not merely that one exists: assert the "approver" field of the sysapproval_approver row (locate by "document_id={{setup.sys_id}}") against the approver's display name from the live context. Asserting only state="requested" is too weak — an approval routed to the wrong person would pass it.
    - "resume" describes the state change that unblocks it: patch the sysapproval_approver row to {"state":"approved"}.
    - "assertAfterResume" holds the effects that follow approval (the work note, the field update).
    Putting a post-approval effect in "assert" is wrong — it has not happened yet and the run will fail a correct flow.`;

const SUBFLOW_VERIFY_SYSTEM = `You write a VERIFICATION SPEC that proves a ServiceNow SUBFLOW actually does what a request asked for.

A subflow has NO trigger. It is proven by CALLING it with real inputs and then reading what it changed. Respond with ONLY a JSON object — no prose, no markdown fences:

{
  "kind": "subflow",
  "subflow": "<exact subflow name>",

  // OPTIONAL scenery: a record the subflow acts on. Omit only if the subflow needs no record at all.
  "setup":   { "table": "<table>", "payload": { "<field>": "<value>", ... } },

  // The CALL. One key per input the subflow declares; the value may be a literal
  // or the token {{setup.sys_id}}, which is replaced with the setup record's sys_id.
  "inputs":  { "<declaredInputName>": "<value or {{setup.sys_id}}>" },

  "wait":    { "timeoutSec": 120 },

  // Effects on records, read back after the execution settles.
  "assert":  [ { "table": "<table>",
                 "locate": { "bySetupRecord": true } | { "byQuery": "<encoded query>" },
                 "field": "<field name>",
                 "expect": { "value": "<raw value>" } | { "display": "<display value>" },
                 "note": "<the promise this proves>" } ],

  // Values the subflow RETURNS. Only names it declares as outputs.
  "expectOutputs": [ { "name": "<declared output>", "expect": { "value": "<raw value>" }, "note": "<the promise this proves>" } ],

  "cleanup": [ { "table": "<table>", "locate": { "bySetupRecord": true } | { "byQuery": "<encoded query>" } } ],

  // ONLY for a promised effect this instance CANNOT show. Omit when there are none.
  "unverifiable": [ { "effect": "<the promised effect, quoted exactly from PROMISED EFFECTS>",
                      "kind": "field_absent" | "source_empty",
                      "table": "<table>", "field": "<field>",
                      "sys_id": "<record the empty value would come from — required for source_empty>",
                      "note": "<why this instance cannot show it>" } ]
}

RULES:
0. UNVERIFIABLE PROMISES. A request can promise something this instance has no way to show: the field it would be written to does not exist here, or the value it would be read from is EMPTY on the record it comes from (a group with no manager, for example). Do not fake such an effect and do not silently drop it — list it under "unverifiable". Every excuse is CHECKED against the live instance: if the field turns out to exist, or the value turns out to be non-empty, the excuse is rejected and you must check the effect instead.
1. inputs is a CONTRACT, not prose. Use exactly the input names listed under SUBFLOW CONTRACT below — every mandatory one, and nothing that is not on the list. An undeclared input is dropped by the runner, so the call would prove something other than what you wrote.
2. A reference input takes a sys_id. To pass the setup record, write "{{setup.sys_id}}".
3. Every assertion must test an effect the REQUEST PROMISED. FORBIDDEN: asserting a field that setup.payload itself sets — that is true regardless of what the subflow does.
4. COVER EVERY PROMISE: one assertion or expectOutputs entry per observable effect listed under PROMISED EFFECTS.
5. expectOutputs reads the raw stored value, so booleans are "true"/"false" and an empty string is "". Only name outputs the contract declares.
6. Use "display" for reference and choice fields; "value" for raw strings, numbers and journal text. For journal fields (work_notes, comments) assert the distinctive text — a substring match is applied.
7. {{setup.sys_id}} is the ONLY token, and it works in inputs values and in locate.byQuery. NEVER in an expect value: nothing substitutes it there and it fails a correct subflow. If an expected value is generated (a number, a sys_id), move the proof into the LOCATOR and assert a field whose value you know.
8. EXPECTED VALUES ARE LITERAL. No "*", no "%", no "not empty", no "<something>". To prove a field is merely set, put ISNOTEMPTY in the locator and assert a field you know.
9. Never assert a field that is not in the REAL SCHEMA below, and never assume a value for a field the live context reports as EMPTY on this instance.
10. DERIVED FIELDS: on task tables "priority" is CALCULATED from "impact" and "urgency". To create a P1 record set {"impact":"1","urgency":"1"} and never write priority directly.
11. cleanup MUST include the setup record ({ "bySetupRecord": true }) plus every record the subflow creates.
12. Keep setup.payload minimal: what the subflow needs to do its job, plus a short_description so the record is identifiable.`;

/** Ask the model for a verification spec for a freshly generated flow or subflow. */
async function generateVerifySpec({ spec, source, context, flowName, promisedEffects, priorErrors, evidence, decoding, ledger, artifactType = 'flow', contract = null }) {
  const isSubflow = artifactType === 'subflow';
  const parts = [
    `AUTOMATION REQUEST (the promises to verify):\n${spec}`,
    `${isSubflow ? 'SUBFLOW' : 'FLOW'} NAME: ${flowName}`,
    `COMPILED FLUENT SOURCE:\n${source}`,
  ];
  if (isSubflow && contract) {
    const fmt = (list) => (list?.length
      ? list.map((f) => `  ${f.name}: ${f.type}${f.reference ? ` (reference to ${f.reference})` : ''}${f.mandatory ? ' — MANDATORY' : ''}`).join('\n')
      : '  (none)');
    parts.push(
      `SUBFLOW CONTRACT — these names are exact, and the spec is rejected if it invents one or omits a mandatory input:\n` +
      `inputs:\n${fmt(contract.inputs)}\noutputs:\n${fmt(contract.outputs)}`
    );
  }
  if (promisedEffects?.length) {
    parts.push(`PROMISED EFFECTS — one assertion each, ${promisedEffects.length} in total:\n${promisedEffects.map((e, i) => `  ${i + 1}. ${e}`).join('\n')}`);
  }
  if (context?.text) parts.push(`--- LIVE INSTANCE CONTEXT ---\n${context.text}`);
  if (priorErrors?.length) {
    parts.push(`YOUR PREVIOUS VERIFICATION SPEC WAS REJECTED:\n${priorErrors.map((e) => `- ${e}`).join('\n')}\n\nReturn a corrected COMPLETE spec.`);
  }
  // A5: every retry carries strictly more MEASURED evidence than the last —
  // the actual field inventory of the tables the rejected spec named. Without
  // it, "that field does not exist" is an assertion the model is free to
  // disbelieve, and it did: three attempts running, it re-sent the same
  // impossible locator (docs/fluent-research.md §14).
  if (evidence?.length) {
    parts.push(`--- MEASURED INSTANCE EVIDENCE (read off the live schema, authoritative) ---\n${evidence.join('\n\n')}`);
  }
  parts.push('Return only the JSON object.');

  const user = parts.join('\n\n');
  ledger?.record(user);

  const raw = await chatOnce({ system: isSubflow ? SUBFLOW_VERIFY_SYSTEM : VERIFY_SYSTEM, user, maxTokens: 6000, decoding });
  const cleaned = String(raw || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    return null;
  }
}

/**
 * An SLA assertion's shape.
 *
 * Two of these rules exist because of measurements, not tidiness:
 *
 *   `sla` is mandatory because a task_sla row on the record proves nothing
 *   about which SLA produced it — one P1 incident on this instance attached
 *   three rows, ours and two out-of-box ones. An assertion that omits the
 *   definition passes with the definition under test deleted.
 *
 *   the tolerance must be STATED because the clock starts when the platform
 *   attaches the row, not when the runner posted the record. A tolerance
 *   defaulted inside the runner is a number that never appears in the artifact
 *   a human reviews.
 */
export function validateSlaAssertion(a, at = 'assert[0]') {
  const errors = [];
  if (!a?.sla || typeof a.sla !== 'string' || !a.sla.trim()) {
    errors.push(
      `${at}.sla is required — name the contract_sla definition exactly (or give its sys_id). ` +
      `Asserting that "a task_sla attached" proves nothing: this instance attaches its own out-of-box ` +
      `SLAs to the same record, so such an assertion passes even with the definition under test deleted.`
    );
  }
  if (!a?.locate?.bySetupRecord && !a?.locate?.byQuery) {
    errors.push(`${at}.locate needs bySetupRecord or byQuery — the task the SLA is expected to attach to.`);
  }
  if (a?.field) {
    errors.push(
      `${at} is an SLA assertion and must not carry a "field". SLA times are stored in UTC and rendered to ` +
      `the session timezone, so a literal field comparison against planned_end_time fails a correct SLA. ` +
      `The clock is checked by the assertion itself.`
    );
  }
  const tol = a?.expect?.plannedEndToleranceSec;
  if (a?.expect?.attached !== false) {
    if (tol === undefined) {
      errors.push(
        `${at}.expect.plannedEndToleranceSec is required. The SLA clock starts when the platform attaches the ` +
        `row, not when the setup record was posted, so the two differ by the insert's own latency. State the ` +
        `tolerance in the spec (${SLA_TOLERANCE_DEFAULT_SEC} is a sensible value) rather than leaving a ` +
        `reviewer to guess what slack the runner allows.`
      );
    } else if (!Number.isFinite(Number(tol)) || Number(tol) < 0) {
      errors.push(`${at}.expect.plannedEndToleranceSec must be a non-negative number of seconds, not "${tol}".`);
    }
  }
  return errors;
}

/**
 * Structural + anti-triviality validation. The anti-triviality rule is enforced
 * HERE rather than trusted to the prompt: an assertion that reads a field the
 * setup payload already wrote would pass no matter what the flow does.
 */
export function validateVerifySpec(v, { promisedEffects = [], verifiedExcuses = 0, contract = null } = {}) {
  const errors = [];
  if (!v || typeof v !== 'object') return { ok: false, errors: ['Not a JSON object.'] };

  // A subflow has no trigger, so "create a record that satisfies it" is not a
  // shape it can take. Its spec is validated against its own rules — including
  // the one a flow spec cannot have: the inputs are a DECLARED contract, so a
  // missing or invented input is a mechanical error, not a judgement call.
  if (v.kind === 'subflow') return validateSubflowVerifySpec(v, { promisedEffects, contract, verifiedExcuses });

  // A promise this instance cannot store may be excused from coverage, but only
  // with a reason that has been CHECKED against the live instance.
  //
  // `verifiedExcuses` is the count checkUnverifiableClaims actually confirmed,
  // and it defaults to 0 so an unchecked caller subtracts nothing. Counting the
  // CLAIMED excuses here instead was a real bug, measured in §20: a spec listed
  // two excuses, only one held up, and the coverage requirement dropped by two
  // anyway — letting a promise disappear on the strength of a claim about the
  // wrong table.
  const shape = validateUnverifiableShape(v.unverifiable);
  errors.push(...shape.errors);
  const excused = Math.max(0, Number(verifiedExcuses) || 0);

  const setupTable = v.setup?.table;
  const payload = v.setup?.payload;
  if (!setupTable) errors.push('setup.table is required.');
  if (!payload || typeof payload !== 'object' || !Object.keys(payload).length) {
    errors.push('setup.payload must be a non-empty object.');
  }
  // Optional second setup step: the transition that fires a record-UPDATED
  // trigger. Fields it writes count as setup-written for the anti-trivial rule.
  const update = v.setup?.update;
  if (update !== undefined) {
    if (!update || typeof update !== 'object' || Array.isArray(update) || !Object.keys(update).length) {
      errors.push('setup.update, when present, must be a non-empty object of field/value pairs.');
    }
  }
  const setupWrites = { ...(payload && typeof payload === 'object' ? payload : {}), ...(update && typeof update === 'object' ? update : {}) };
  if (!v.wait?.flowName) errors.push('wait.flowName is required.');

  const afterResume = Array.isArray(v.assertAfterResume) ? v.assertAfterResume : [];
  if (v.resume) {
    if (!v.resume.table) errors.push('resume.table is required.');
    if (!v.resume.locate?.bySetupRecord && !v.resume.locate?.byQuery) errors.push('resume.locate needs bySetupRecord or byQuery.');
    if (!v.resume.patch || typeof v.resume.patch !== 'object' || !Object.keys(v.resume.patch).length) {
      errors.push('resume.patch must be a non-empty object of field/value pairs.');
    }
    if (!afterResume.length) errors.push('A resume step needs at least one assertAfterResume entry — otherwise resuming proves nothing.');
  }

  if (!Array.isArray(v.assert) || v.assert.length === 0) {
    errors.push('assert must contain at least one assertion.');
  } else {
    // Every promised effect needs its own assertion, or the run proves only
    // part of what the request asked for while reporting a clean pass.
    // Post-resume assertions count toward coverage.
    //
    // Promises this instance CANNOT store are subtracted, but only when they
    // were formally excused with a checkable reason. Without that subtraction
    // this rule and the field-existence check are mutually unsatisfiable —
    // measured live in §20, where the model correctly dropped two impossible
    // promises and was rejected for it on every remaining attempt.
    const totalAssertions = v.assert.length + afterResume.length;
    const required = promisedEffects.length - excused;
    if (promisedEffects.length > 1 && totalAssertions < required) {
      errors.push(
        `The request promises ${promisedEffects.length} observable effects` +
        (excused ? ` (${excused} excused as unverifiable, CONFIRMED against this instance, leaving ${required})` : '') +
        ` but only ${totalAssertions} assertion(s) were written. ` +
        `Add one assertion per promised effect: ${promisedEffects.map((e, i) => `(${i + 1}) ${e}`).join('; ')}. ` +
        `If one of them genuinely CANNOT be observed on this instance — the field does not exist, or the ` +
        `value it would be copied from is empty here — do not fake it and do not silently drop it: list it ` +
        `under "unverifiable" with a reason that can be checked.`
      );
    }
    v.assert.forEach((a, i) => {
      const at = `assert[${i}]`;

      // An SLA assertion reads a clock, not a field, so it has its own shape.
      // Validated here rather than trusted to the prompt for the same reason
      // every other rule in this function is: the failure it prevents (an
      // assertion that passes because SOME SLA attached) reports green.
      if (a?.type === 'sla') {
        errors.push(...validateSlaAssertion(a, at));
        return;
      }

      if (!a?.field) errors.push(`${at}.field is required.`);
      if (!a?.table) errors.push(`${at}.table is required.`);
      if (!a?.locate?.bySetupRecord && !a?.locate?.byQuery) {
        errors.push(`${at}.locate needs bySetupRecord or byQuery.`);
      }
      const hasExpect = a?.expect && (a.expect.value !== undefined || a.expect.display !== undefined);
      if (!hasExpect) errors.push(`${at}.expect needs a value or display.`);

      // {{setup.sys_id}} is the ONLY token the runner substitutes, and only
      // inside locate.byQuery. A token anywhere in an expected VALUE is
      // compared literally and fails a flow that is behaving correctly — a
      // false alarm, which is worse than no assertion at all.
      for (const half of ['value', 'display']) {
        const raw = a?.expect?.[half];
        if (typeof raw !== 'string') continue;
        const bad = raw.match(/\{\{[^}]*\}\}/g);
        if (!bad) continue;
        errors.push(
          `${at}.expect.${half} contains ${bad.join(', ')}, which the runner does not substitute — ` +
          `it would be compared literally and FAIL a correct flow. The only supported token is ` +
          `{{setup.sys_id}}, and only inside locate.byQuery. To prove a field references a record ` +
          `the flow created, put the proof in the LOCATOR instead: locate the record with a query ` +
          `that only matches when the link exists (e.g. ` +
          `"sys_id={{setup.sys_id}}^<ref_field>.short_description=<the value the flow wrote>") and ` +
          `assert a field whose value you already know. If the locator matches, the link exists.`
        );
      }

      // The comparison is literal — exact for ordinary fields, containment for
      // journal fields. Anything that only READS like a value (a wildcard, the
      // words "not empty", an <angle-bracket> stand-in) is compared character
      // for character and fails a flow that did exactly the right thing.
      for (const half of ['value', 'display']) {
        const raw = a?.expect?.[half];
        if (typeof raw !== 'string' || raw.includes('{{')) continue;
        const wildcard = raw.includes('*') || raw.includes('%');
        const prose = /^\s*(not\s+empty|non-?empty|any.*|some.*|<.+>|\.\.\.)\s*$/i.test(raw);
        if (!wildcard && !prose) continue;
        errors.push(
          `${at}.expect.${half} is "${raw}", which is not a literal value. The runner compares ` +
          `${'exactly for ordinary fields and by containment for journal fields'} — it does not ` +
          `interpret wildcards or phrases, so this fails a flow that behaved correctly. ` +
          (wildcard
            ? `Drop the generated part and assert only the fixed text around it: for a work note ` +
              `reading "Problem PRB0012345 created", assert the literal " created" or "Problem ", ` +
              `never "Problem PRB* created".`
            : `To prove a field is merely SET, put that in the locator instead ` +
              `("sys_id={{setup.sys_id}}^<field>ISNOTEMPTY") and assert a field whose value you know; ` +
              `a locator that matches nothing is reported as a failure.`)
        );
      }

      // The anti-trivial rule — setup.update writes count too, or a spec could
      // smuggle the effect it claims to prove into the transition step.
      if (a?.locate?.bySetupRecord && a?.table === setupTable && a.field in setupWrites) {
        const via = update && a.field in update ? 'setup.update' : 'setup.payload';
        errors.push(
          `${at} asserts "${a.field}" on the setup record, but ${via} already sets "${a.field}" ` +
          `to "${setupWrites[a.field]}". That assertion is true regardless of what the flow does. ` +
          `Either remove "${a.field}" from ${via} (if the flow is supposed to set it) or assert a different effect.`
        );
      }
    });
  }

  if (!Array.isArray(v.cleanup) || !v.cleanup.some((c) => c?.locate?.bySetupRecord)) {
    errors.push('cleanup must include the setup record ({ "locate": { "bySetupRecord": true } }).');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * A subflow verification spec.
 *
 * The flow shape does not fit: there is no trigger to satisfy, so `setup` is
 * scenery rather than the thing that fires the artifact, and the artifact is
 * fired by an explicit CALL with explicit inputs.
 *
 * That call is what makes this validator stricter than the flow one. A flow's
 * trigger condition has to be read out of source and mirrored, which is a
 * judgement the model can get subtly wrong in the same direction twice. A
 * subflow's inputs are a DECLARED contract, read off the source and the
 * instance, so "you passed an input this subflow does not declare" and "you
 * left out a mandatory one" are arithmetic.
 */
export function validateSubflowVerifySpec(v, { promisedEffects = [], contract = null, verifiedExcuses = 0 } = {}) {
  const errors = [];
  if (!v.subflow || typeof v.subflow !== 'string') {
    errors.push('subflow is required — the exact name of the subflow this spec proves.');
  }

  // The same escape hatch the flow path has, for the same measured reason
  // (§20, CLASS D): a promise this instance cannot show — the field is absent,
  // or the value it would be copied from is EMPTY here — must be excusable, or
  // the coverage rule and the field-existence check become mutually
  // unsatisfiable and a correct subflow can never be verified. Only excuses
  // CONFIRMED against the instance count, which is why the number comes from
  // the caller rather than from the spec's own claim.
  errors.push(...validateUnverifiableShape(v.unverifiable).errors);
  const excused = Math.max(0, Number(verifiedExcuses) || 0);

  const setup = v.setup;
  if (setup !== undefined && setup !== null) {
    if (!setup.table) errors.push('setup.table is required when a setup record is used.');
    if (!setup.payload || typeof setup.payload !== 'object' || !Object.keys(setup.payload).length) {
      errors.push('setup.payload must be a non-empty object when setup is present.');
    }
  }
  const setupWrites = setup?.payload && typeof setup.payload === 'object' ? setup.payload : {};

  if (!v.inputs || typeof v.inputs !== 'object' || Array.isArray(v.inputs)) {
    errors.push('inputs must be an object of the values to call the subflow with (use {} only if it declares no inputs).');
  } else if (contract) {
    const declared = new Map((contract.inputs || []).map((i) => [i.name, i]));
    for (const key of Object.keys(v.inputs)) {
      if (declared.has(key)) continue;
      errors.push(
        `inputs."${key}" is not an input of "${contract.name}". Its declared inputs are ` +
        `${[...declared.keys()].map((k) => `"${k}"`).join(', ') || '(none)'}. ` +
        'An undeclared input is dropped by the runner, so the call would prove something other than what is written here.'
      );
    }
    for (const [key, def] of declared) {
      if (!def.mandatory || key in v.inputs) continue;
      errors.push(`inputs."${key}" is mandatory on "${contract.name}" and is missing, so the call cannot run.`);
    }
  }

  // Token discipline, identical to the flow path: {{setup.sys_id}} is the only
  // substitution, and here it is also allowed in an INPUT value because that is
  // how the setup record is handed to the subflow.
  for (const [key, val] of Object.entries(v.inputs || {})) {
    if (typeof val !== 'string') continue;
    for (const token of val.match(/\{\{[^}]*\}\}/g) || []) {
      if (token === '{{setup.sys_id}}') {
        if (!setup) errors.push(`inputs."${key}" uses {{setup.sys_id}} but the spec has no setup record to substitute.`);
        continue;
      }
      errors.push(`inputs."${key}" contains ${token}, which the runner does not substitute. The only token is {{setup.sys_id}}.`);
    }
  }

  const asserts = Array.isArray(v.assert) ? v.assert : [];
  const outs = Array.isArray(v.expectOutputs) ? v.expectOutputs : [];
  if (v.expectOutputs !== undefined && !Array.isArray(v.expectOutputs)) {
    errors.push('expectOutputs, when present, must be an array of { name, expect } entries.');
  }
  if (!asserts.length && !outs.length) {
    errors.push(
      'A subflow spec needs at least one assertion or one expected output. Running a subflow and checking ' +
      'nothing proves only that it did not crash.'
    );
  }
  const required = promisedEffects.length - excused;
  if (promisedEffects.length > 1 && asserts.length + outs.length < required) {
    errors.push(
      `The request promises ${promisedEffects.length} observable effects` +
      (excused ? ` (${excused} excused as unverifiable, CONFIRMED against this instance, leaving ${required})` : '') +
      ` but only ${asserts.length + outs.length} check(s) were written. ` +
      `One per promised effect: ${promisedEffects.map((e, i) => `(${i + 1}) ${e}`).join('; ')}. ` +
      `If one genuinely CANNOT be observed here — the field does not exist, or the value it would be copied ` +
      `from is empty on this instance — list it under "unverifiable" with a reason that can be checked, ` +
      `rather than faking it or dropping it.`
    );
  }

  asserts.forEach((a, i) => {
    const at = `assert[${i}]`;
    if (a?.type === 'sla') { errors.push(...validateSlaAssertion(a, at)); return; }
    if (!a?.field) errors.push(`${at}.field is required.`);
    if (!a?.table) errors.push(`${at}.table is required.`);
    if (!a?.locate?.bySetupRecord && !a?.locate?.byQuery) errors.push(`${at}.locate needs bySetupRecord or byQuery.`);
    if (a?.locate?.bySetupRecord && !setup) errors.push(`${at}.locate.bySetupRecord needs a setup record, and this spec has none.`);
    const hasExpect = a?.expect && (a.expect.value !== undefined || a.expect.display !== undefined);
    if (!hasExpect) errors.push(`${at}.expect needs a value or display.`);
    for (const half of ['value', 'display']) {
      const rawValue = a?.expect?.[half];
      if (typeof rawValue !== 'string') continue;
      const token = rawValue.match(/\{\{[^}]*\}\}/g);
      if (token) {
        errors.push(
          `${at}.expect.${half} contains ${token.join(', ')}, which the runner does not substitute — it is ` +
          'compared literally and FAILS a correct subflow. Put the proof in locate.byQuery instead.'
        );
      }
      if (/[*%]/.test(rawValue) || /^\s*(not\s+empty|non-?empty|any.*|<.+>)\s*$/i.test(rawValue)) {
        errors.push(
          `${at}.expect.${half} is "${rawValue}", which is not a literal value. Comparison is exact for ` +
          'ordinary fields and containment for journal fields; wildcards and phrases fail a correct subflow.'
        );
      }
    }
    // The anti-trivial rule, unchanged in spirit: an assertion on a field the
    // setup payload already wrote is true whatever the subflow does.
    if (a?.locate?.bySetupRecord && a?.table === setup?.table && a.field in setupWrites) {
      errors.push(
        `${at} asserts "${a.field}" on the setup record, but setup.payload already sets it to ` +
        `"${setupWrites[a.field]}". That assertion is true regardless of what the subflow does.`
      );
    }
  });

  outs.forEach((o, i) => {
    const at = `expectOutputs[${i}]`;
    if (!o?.name) { errors.push(`${at}.name is required.`); return; }
    if (!o?.expect || o.expect.value === undefined) {
      errors.push(`${at}.expect.value is required — outputs are read back as raw values, not display values.`);
    }
    if (contract) {
      const declared = (contract.outputs || []).map((x) => x.name);
      if (!declared.includes(o.name)) {
        errors.push(
          `${at}.name "${o.name}" is not an output of "${contract.name}". Its declared outputs are ` +
          `${declared.map((d) => `"${d}"`).join(', ') || '(none)'}. An undeclared output reads back as absent, ` +
          'so this check would fail a correct subflow.'
        );
      }
    }
  });

  if (setup && (!Array.isArray(v.cleanup) || !v.cleanup.some((c) => c?.locate?.bySetupRecord))) {
    errors.push('cleanup must include the setup record ({ "locate": { "bySetupRecord": true } }).');
  }
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ *
 * Field existence — the false-GREEN guard
 *
 * ServiceNow silently DROPS a condition naming a field that does not exist,
 * instead of erroring. Measured on this instance, against one incident:
 *
 *   sys_id=<id>^problemISNOTEMPTY          → MATCHES
 *   sys_id=<id>^problemISEMPTY             → MATCHES   (both! `problem` is not a field)
 *   sys_id=<id>^zzz_totally_madeupISNOTEMPTY → MATCHES
 *   sys_id=<id>^work_notesISNOTEMPTY       → no match  (a real field constrains)
 *
 * So "put the proof in the locator" is only a proof when every field in the
 * locator EXISTS. A spec asserting a promise through a misspelled or absent
 * field passes vacuously and reports green for an effect that never happened —
 * strictly worse than no assertion, because it silences the gap.
 * ------------------------------------------------------------------ */

/**
 * Root field names a ServiceNow encoded query constrains on.
 *
 * The implementation moved to conditions.js when Track B needed the same check
 * for SLA start/stop conditions — one parser, not two. Re-exported here so
 * every existing caller and the guard suite keep their import.
 */
export { queryFieldRoots };

/**
 * Every field an assertion reads, and every field its locator constrains on,
 * must exist on the table. Async because it reads the live schema.
 */
export async function checkVerifySpecFields(v, { schemaFor = getSchema } = {}) {
  const errors = [];
  const known = new Map();
  const fieldsOf = async (t) => {
    if (!known.has(t)) {
      try { known.set(t, new Set((await schemaFor(t)).fields.map((f) => f.name))); }
      catch { known.set(t, null); }
    }
    return known.get(t);
  };

  const groups = [['assert', v?.assert], ['assertAfterResume', v?.assertAfterResume]];
  for (const [label, list] of groups) {
    if (!Array.isArray(list)) continue;
    for (const [i, a] of list.entries()) {
      // An SLA assertion names a definition, not a field on a table, so the
      // field-existence guard has nothing to check and must not invent a
      // complaint about a missing `table`.
      if (a?.type === 'sla') continue;
      const t = a?.table;
      if (!t) continue;
      const fields = await fieldsOf(t);
      if (!fields) continue; // schema unreadable: never fail a spec on our own outage
      const at = `${label}[${i}]`;
      if (a.field && !fields.has(a.field)) {
        errors.push(`${at}.field "${a.field}" does not exist on ${t}. Assert a field that is in the REAL SCHEMA.`);
      }
      for (const root of queryFieldRoots(a?.locate?.byQuery)) {
        if (fields.has(root)) continue;
        errors.push(
          `${at}.locate.byQuery constrains on "${root}", which does not exist on ${t}. ` +
          `ServiceNow silently DROPS a condition naming an unknown field rather than erroring, so this ` +
          `locator matches whether or not the effect happened and the assertion passes vacuously — ` +
          `a false green. Use a field from the REAL SCHEMA, or, if the effect the request asked for ` +
          `cannot be expressed against any real field on ${t}, leave it unasserted rather than faking it.`
        );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * A5 — turn a field-check rejection into MEASURED evidence.
 *
 * Telling the model "problem does not exist on incident" is a claim it can and
 * did ignore for three attempts running. Handing it the instance's actual
 * reference-field inventory is not a claim — it is the table, and it makes the
 * absence checkable rather than assertable. This is the difference between a
 * retry and a re-ask.
 *
 * `schemaFor` is injectable purely so the offline test can drive it.
 */
export async function buildRejectionEvidence(v, { schemaFor = getSchema } = {}) {
  const parts = [];
  const tables = new Set();
  for (const list of [v?.assert, v?.assertAfterResume]) {
    if (Array.isArray(list)) for (const a of list) if (a?.table) tables.add(a.table);
  }

  for (const t of tables) {
    let schema;
    try { schema = await schemaFor(t); } catch { continue; }
    const known = new Set(schema.fields.map((f) => f.name));

    // Every name this spec used on this table — asserted fields and the fields
    // its locators constrain on, which are equally capable of a false green.
    const named = new Set();
    for (const list of [v?.assert, v?.assertAfterResume]) {
      if (!Array.isArray(list)) continue;
      for (const a of list) {
        if (a?.table !== t) continue;
        if (a.field) named.add(a.field);
        if (a?.type === 'sla') continue;
        for (const root of queryFieldRoots(a?.locate?.byQuery)) named.add(root);
      }
    }
    const missing = [...named].filter((n) => !known.has(n));
    if (!missing.length) continue;

    const refs = schema.fields.filter((f) => f.reference).map((f) => `  ${f.name} -> ${f.reference}`);
    parts.push(
      `FIELD INVENTORY for "${t}", read off this instance's dictionary.\n` +
        `Names your spec used that DO NOT EXIST on ${t}: ${missing.join(', ')}.\n` +
        (refs.length
          ? `Every reference field that DOES exist on ${t}, with the table it points at:\n${refs.join('\n')}\n`
          : `${t} has no reference fields at all.\n`) +
        `If the promise you are trying to prove would have to be stored in one of the missing names, ` +
        `then this instance has NOWHERE to store it and the effect does not happen here. Do not retry it ` +
        `under a different spelling, and do NOT move it into the locator: ServiceNow silently drops a ` +
        `condition naming an unknown field, so that locator matches whether or not the effect occurred ` +
        `and reports a false green — certifying the absence of a bug rather than merely missing it. ` +
        `Drop that assertion and prove the promises this instance CAN store.`
    );
  }
  return parts;
}

/* ------------------------------------------------------------------ *
 * Unsatisfiable promises — the verified escape hatch (CLASS D fix)
 *
 * Two guards used to contradict each other, and no model could satisfy both:
 *
 *   - the field-existence check told the model "`incident.problem` does not
 *     exist here, so DROP that assertion rather than faking it";
 *   - the coverage rule then rejected the result for writing fewer assertions
 *     than the request had promised effects.
 *
 * Measured live (§20): the model obeyed the first, was punished by the second,
 * and both remaining attempts re-sent the identical spec. A5 caught the loop
 * and named it correctly as OUR defect.
 *
 * The fix is not to weaken coverage. A promise may be excused ONLY if the model
 * says which promise, why, and in a form this code can CHECK against the live
 * instance. An unproven excuse is rejected exactly like an unproven assertion —
 * otherwise the hatch becomes a way to quietly assert nothing, which is the
 * false green all over again, wearing different clothes.
 * ------------------------------------------------------------------ */

const UNVERIFIABLE_KINDS = ['field_absent', 'source_empty'];

/** Structural shape of the `unverifiable` block. Pure; no instance access. */
export function validateUnverifiableShape(list) {
  const errors = [];
  if (list === undefined) return { ok: true, errors };
  if (!Array.isArray(list)) return { ok: false, errors: ['unverifiable, when present, must be an array.'] };

  list.forEach((u, i) => {
    const at = `unverifiable[${i}]`;
    if (!u || typeof u !== 'object') { errors.push(`${at} must be an object.`); return; }
    if (!u.effect || typeof u.effect !== 'string') {
      errors.push(`${at}.effect must quote the promised effect being excused, exactly as it appears in PROMISED EFFECTS.`);
    }
    if (!UNVERIFIABLE_KINDS.includes(u.kind)) {
      errors.push(`${at}.kind must be one of ${UNVERIFIABLE_KINDS.join(' | ')} — the two reasons this code can actually check.`);
      return;
    }
    if (!u.table || typeof u.table !== 'string') errors.push(`${at}.table is required so the claim can be checked.`);
    if (!u.field || typeof u.field !== 'string') errors.push(`${at}.field is required so the claim can be checked.`);
    if (u.kind === 'source_empty' && !u.sys_id && !u.query) {
      errors.push(
        `${at} claims a field is EMPTY on this instance, so it must say on WHICH record: give sys_id ` +
        `(preferred — the live context lists resolved sys_ids) or query.`
      );
    }
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Check every excuse against the live instance. An excuse that turns out to be
 * FALSE is the more dangerous direction — it would silently drop a promise the
 * flow was supposed to keep — so a claim that does not hold is rejected with
 * the measurement that refutes it.
 *
 * `schemaFor` and `readRecord` are injectable so the offline test can drive
 * both outcomes without an instance.
 */
export async function checkUnverifiableClaims(v, { schemaFor = getSchema, readRecord = table.get } = {}) {
  const errors = [];
  const verified = [];
  const list = Array.isArray(v?.unverifiable) ? v.unverifiable : [];

  for (const [i, u] of list.entries()) {
    const at = `unverifiable[${i}]`;
    if (!u?.kind || !u?.table || !u?.field) continue; // shape check already reported it

    if (u.kind === 'field_absent') {
      let fields;
      try { fields = new Set((await schemaFor(u.table)).fields.map((f) => f.name)); }
      catch (err) {
        // NOTE the deliberate difference from checkVerifySpecFields, which
        // never fails a spec on our own outage. That rule protects a correct
        // ASSERTION from being blocked. This is the opposite direction: an
        // excuse REMOVES a requirement, so an excuse we could not check must
        // not quietly count. Fail closed, and say why.
        errors.push(`${at} could not be checked: the schema for ${u.table} was unreadable (${err.message}). An unchecked excuse does not count toward coverage.`);
        continue;
      }
      if (fields.has(u.field)) {
        errors.push(
          `${at} excuses "${u.effect}" on the grounds that "${u.field}" does not exist on ${u.table}, ` +
          `but it DOES exist. The promise is verifiable here, so assert it instead of excusing it.`
        );
        continue;
      }
      verified.push({ ...u, confirmedBy: `${u.table} has no field named "${u.field}"` });
      continue;
    }

    // source_empty — the field exists, but the record it must be read from has
    // no value, so the effect produces nothing observable on THIS instance.
    let rec = null;
    let readError = null;
    try { rec = u.sys_id ? await readRecord(u.table, u.sys_id) : null; }
    catch (err) { readError = err.message; }
    if (!rec) {
      // Measured live (§20): the model excused a promise with table "problem"
      // and field "assigned_to" while giving the sys_id of a sys_user_group
      // record. The read fails, and swallowing that would let a claim about
      // the wrong table silently remove a requirement.
      errors.push(
        `${at} claims "${u.field}" is empty on ${u.table}, but ${u.sys_id ? `no ${u.table} record with sys_id ${u.sys_id} could be read` : 'no sys_id was given'}` +
        `${readError ? ` (${readError})` : ''}. Check that "table" is the table the value is READ FROM and that "sys_id" ` +
        `identifies a record on that same table — the live context lists resolved sys_ids with their tables. ` +
        `An excuse that cannot be checked does not count toward coverage.`
      );
      continue;
    }
    const cell = rec[u.field];
    const value = cell && typeof cell === 'object' ? (cell.value ?? cell.display_value) : cell;
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      errors.push(
        `${at} excuses "${u.effect}" on the grounds that ${u.table}.${u.field} is empty, but it reads ` +
        `"${String(value).slice(0, 60)}" on this instance. The promise is verifiable here, so assert it.`
      );
      continue;
    }
    verified.push({ ...u, confirmedBy: `${u.table}.${u.field} is empty on the referenced record` });
  }

  return { ok: errors.length === 0, errors, verified };
}

/** Generate a verification spec, rejecting and regenerating invalid ones. */
async function generateVerification(args, emit = () => {}) {
  let priorErrors = null;
  // A5: evidence only ever grows, so attempt N+1 is asked a strictly
  // better-informed question than attempt N.
  const evidence = [];
  const ledger = new RetryLedger('verification spec');
  const fingerprint = specFingerprint(`verify::${args.flowName}::${args.spec}`);

  for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
    emit({ type: 'verify_spec_attempt', attempt, of: MAX_VERIFY_ATTEMPTS });

    let candidate;
    try {
      candidate = await generateVerifySpec({
        ...args,
        priorErrors,
        evidence,
        decoding: codegenDecoding(fingerprint, attempt),
        ledger,
      });
    } catch (err) {
      // The ledger refused an identical re-ask. That is our defect, not the
      // model's, and it is reported as one rather than silently costing an
      // attempt — house rule: loud failures, never silent fallbacks.
      emit({ type: 'verify_spec_stalled', attempt, message: err.message });
      return { ok: false, errors: [...(priorErrors || []), err.message], attempts: attempt, stalled: true };
    }

    if (!candidate) {
      priorErrors = ['Response was not valid JSON.'];
      emit({ type: 'verify_spec_rejected', attempt, errors: priorErrors });
      continue;
    }
    // Order matters: every excuse is measured against the instance FIRST, and
    // only the ones that hold up are allowed to reduce the coverage
    // requirement. An excuse that does not hold is rejected exactly like an
    // unproven assertion — otherwise the hatch becomes a way to assert nothing
    // and still report a clean pass.
    const excuseCheck = await checkUnverifiableClaims(candidate);
    // A subflow spec carries `kind: "subflow"`, which validateVerifySpec
    // dispatches on. If the model forgets it, the flow validator runs and
    // rejects the spec for missing a trigger it never had — so the
    // discriminator is imposed here rather than asked for.
    if (args.artifactType === 'subflow') candidate.kind = 'subflow';
    const check = validateVerifySpec(candidate, {
      promisedEffects: args.promisedEffects || [],
      verifiedExcuses: excuseCheck.verified.length,
      contract: args.contract || null,
    });
    const fieldCheck = check.ok ? await checkVerifySpecFields(candidate) : { ok: true, errors: [] };
    if (check.ok && fieldCheck.ok && excuseCheck.ok) {
      return { ok: true, spec: candidate, attempts: attempt, unverifiable: excuseCheck.verified };
    }
    priorErrors = [...check.errors, ...fieldCheck.errors, ...excuseCheck.errors];

    let added = 0;
    if (!fieldCheck.ok) {
      for (const block of await buildRejectionEvidence(candidate)) {
        if (evidence.includes(block)) continue;
        evidence.push(block);
        added += 1;
      }
    }
    // Report every reason, not just the structural ones: a spec rejected only
    // by the field check would otherwise stream "rejected" with an empty list.
    emit({ type: 'verify_spec_rejected', attempt, errors: priorErrors, evidenceAdded: added });
  }
  return { ok: false, errors: priorErrors, attempts: MAX_VERIFY_ATTEMPTS };
}

/**
 * Read one field for assertion. Journal fields (work_notes, comments) are not
 * returned by a normal GET — their entries live in sys_journal_field — so they
 * need a different read path entirely.
 */
async function readFieldValue(tableName, sysId, field) {
  let type = null;
  try {
    const schema = await getSchema(tableName);
    type = schema.fields.find((f) => f.name === field)?.type || null;
  } catch { /* fall through to a plain read */ }

  if (type && /journal/.test(type)) {
    const rows = await table.query('sys_journal_field', {
      query: `element_id=${sysId}^element=${field}^ORDERBYDESCsys_created_on`,
      fields: 'value,sys_created_on',
      limit: 20,
    });
    const entries = rows.map((r) => r.value?.value ?? r.value).filter(Boolean);
    return { kind: 'journal', value: entries.join('\n---\n'), display: entries.join('\n---\n'), entries };
  }

  const rec = await table.get(tableName, sysId);
  const raw = rec?.[field];
  return {
    kind: 'field',
    value: raw && typeof raw === 'object' ? raw.value : raw,
    display: raw && typeof raw === 'object' ? (raw.display_value ?? raw.value) : raw,
  };
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

function compare(actual, expect) {
  const wantDisplay = expect.display !== undefined;
  const want = wantDisplay ? expect.display : expect.value;
  const got = wantDisplay ? actual.display : actual.value;
  // Journal and long text are appended to, so containment is the correct test;
  // everything else must match exactly.
  const pass = actual.kind === 'journal'
    ? norm(got).includes(norm(want))
    : norm(got) === norm(want);
  return { pass, want, got, mode: actual.kind === 'journal' ? 'contains' : 'exact' };
}

async function locate(loc, tableName, ctx) {
  if (loc?.bySetupRecord) return ctx.setupSysId;
  if (loc?.byQuery) {
    const query = String(loc.byQuery).replace(/\{\{setup\.sys_id\}\}/g, ctx.setupSysId);
    const rows = await table.query(tableName, { query, fields: 'sys_id', limit: 5 });
    if (!rows.length) return null;
    return rows[0].sys_id?.value ?? rows[0].sys_id;
  }
  return null;
}

/**
 * Run one { "type": "sla" } assertion.
 *
 * The definition is resolved off the instance rather than taken from the spec,
 * so a spec naming an SLA that does not exist fails loudly here instead of
 * quietly asserting nothing. The clock arithmetic — including the UTC parsing
 * that trap #UTC is about — lives in sla.js and is shared with the SLA page's
 * own verification, so there is one implementation of "is this breach clock
 * sane" rather than two that can drift.
 */
async function runSlaAssertion(a, { setupSysId, phase }) {
  const shell = { phase, pass: false, type: 'sla', table: 'task_sla', field: `sla:${a.sla}`, note: a.note };
  let definition;
  try {
    definition = await findSla(a.sla);
  } catch (err) {
    return { assertion: { ...shell, reason: `The SLA definition could not be resolved: ${err.message}` } };
  }
  const taskSysId = await locate(a.locate, definition.collection, { setupSysId });
  if (!taskSysId) {
    return { assertion: { ...shell, reason: 'No record matched the locator, so there is nothing for the SLA to attach to.' } };
  }
  const result = await assertTaskSla({ definition, taskSysId, expect: a.expect || {} });
  return {
    assertion: {
      ...shell,
      pass: result.pass,
      sys_id: taskSysId,
      sla: result.sla,
      attached: result.attached,
      others: result.others,
      task_sla: result.task_sla,
      clock: result.clock,
      checks: result.checks,
      reason: result.reason,
    },
  };
}

/**
 * Run a list of assertions against a settled execution.
 *
 * Hoisted out of `verify()` so the SUBFLOW runner asserts effects with exactly
 * the same code: the journal read path, the containment-vs-exact comparison and
 * the locator semantics are subtle enough that a second implementation would
 * drift, and a drifting assertion runner reports a green nobody earned.
 */
async function runAssertionList(list, phase, { setupSysId }, emit = () => {}) {
  const out = [];
  for (const a of list || []) {
    if (a?.type === 'sla') {
      const outcome = await runSlaAssertion(a, { setupSysId, phase });
      out.push(outcome.assertion);
      emit({ type: 'verify_assert', phase, pass: outcome.assertion.pass, field: `sla:${a.sla}`, reason: outcome.assertion.reason });
      continue;
    }
    const target = await locate(a.locate, a.table, { setupSysId });
    if (!target) {
      out.push({ phase, pass: false, table: a.table, field: a.field, note: a.note, reason: 'No record matched the locator.' });
      emit({ type: 'verify_assert', phase, pass: false, field: a.field, reason: 'no record matched' });
      continue;
    }
    const actual = await readFieldValue(a.table, target, a.field);
    const cmp = compare(actual, a.expect);
    out.push({
      phase, pass: cmp.pass, table: a.table, field: a.field, note: a.note,
      expected: cmp.want, actual: cmp.got, mode: cmp.mode, sys_id: target,
    });
    emit({ type: 'verify_assert', phase, pass: cmp.pass, field: a.field, expected: cmp.want, actual: cmp.got });
  }
  return out;
}

/**
 * Execute a verification spec: setup → wait → assert → cleanup.
 * Cleanup runs in `finally`, so a failed assertion never leaves test data behind.
 * A wait timeout is a FAIL carrying the last observed context state, not a hang.
 */
export async function verify(name, emit = () => {}) {
  const file = verifyPath(name);
  if (!fs.existsSync(file)) {
    return { ok: false, available: false, message: `No verification spec for "${name}" (expected ${path.basename(file)}). Scheduled flows are verified by metadata instead.` };
  }
  const spec = JSON.parse(await fsp.readFile(file, 'utf8'));
  // A triggerless artifact cannot be proven by creating a record. It is called.
  if (spec.kind === 'subflow') return verifySubflow(name, spec, emit);
  const check = validateVerifySpec(spec);
  // A stored spec is checked against the live schema too: a locator naming a
  // field that does not exist passes vacuously, so running it would report a
  // green for an effect nobody proved. Refuse to run rather than mislead.
  const fieldCheck = check.ok ? await checkVerifySpecFields(spec) : { ok: true, errors: [] };
  if (!check.ok || !fieldCheck.ok) {
    return {
      ok: false, available: true,
      message: 'The stored verification spec is invalid — it was NOT run, because it could report a false pass.',
      errors: [...check.errors, ...fieldCheck.errors],
    };
  }

  const timeoutSec = Math.min(Math.max(Number(spec.wait?.timeoutSec) || 90, 15), 300);
  const created = [];
  let setupSysId = null;
  let setupLabel = null;
  let setupTransition = null;
  let execution = null;
  const assertions = [];

  try {
    emit({ type: 'verify_setup', table: spec.setup.table, payload: spec.setup.payload });
    const rec = await table.create(spec.setup.table, spec.setup.payload);
    setupSysId = rec.sys_id?.value ?? rec.sys_id;
    setupLabel = rec.number?.value ?? rec.name?.value ?? setupSysId;
    created.push({ table: spec.setup.table, sys_id: setupSysId });
    emit({ type: 'verify_setup_done', record: setupLabel, sys_id: setupSysId });

    // A record-UPDATED trigger cannot be reached by an insert. `setup.update`
    // is a second step that drives the record INTO the trigger condition, so
    // the flow fires on the transition the request actually described. Creating
    // a record that already satisfies the condition would prove nothing: the
    // flow would never run, and the assertions would fail a correct flow.
    if (spec.setup.update && Object.keys(spec.setup.update).length) {
      // Let the insert's own business rules settle before the transition, so
      // the update is a distinct operation rather than part of the insert.
      await new Promise((r) => setTimeout(r, 2000));
      emit({ type: 'verify_setup_update', patch: spec.setup.update, sys_id: setupSysId });
      await table.update(spec.setup.table, setupSysId, spec.setup.update);
      const afterUpdate = await table.get(spec.setup.table, setupSysId).catch(() => null);
      setupTransition = {
        patch: spec.setup.update,
        // Read back what the platform actually computed — a calculated field
        // like priority lands from impact+urgency, not from what we asked for.
        observed: Object.fromEntries(
          [...Object.keys(spec.setup.update), 'priority'].map((f) => {
            const cell = afterUpdate?.[f];
            const dv = cell && typeof cell === 'object' ? (cell.display_value ?? cell.value) : cell;
            return [f, dv ?? null];
          })
        ),
      };
      emit({ type: 'verify_setup_updated', observed: setupTransition.observed });
    }

    // --- wait ---
    emit({ type: 'verify_waiting', timeoutSec, flowName: spec.wait.flowName });
    const deadline = Date.now() + timeoutSec * 1000;
    let lastState = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const ctxs = await table.query('sys_flow_context', {
        query: `source_record=${setupSysId}`,
        fields: 'sys_id,name,state,sys_created_on',
        limit: 10,
      });
      // Prefer the context belonging to the flow under test.
      const mine = ctxs.find((c) => norm(c.name?.display_value ?? c.name) === norm(spec.wait.flowName)) || ctxs[0];
      if (mine) {
        lastState = mine.state?.value ?? mine.state;
        execution = {
          sys_id: mine.sys_id?.value ?? mine.sys_id,
          name: mine.name?.display_value ?? mine.name,
          state: lastState,
        };
        emit({ type: 'verify_execution', state: lastState, name: execution.name });
        if ([...TERMINAL_OK, ...TERMINAL_BAD, ...SETTLED_PAUSED].includes(lastState)) break;
      }
    }

    if (!execution) {
      return {
        ok: false, available: true, stage: 'wait',
        message: `No sys_flow_context appeared for ${setupLabel} within ${timeoutSec}s. The flow did not fire — its trigger condition probably does not match the setup record.`,
        setup: { record: setupLabel, sys_id: setupSysId, payload: spec.setup.payload, transition: setupTransition },
        assertions: [], execution: null,
      };
    }
    if (TERMINAL_BAD.includes(execution.state)) {
      return {
        ok: false, available: true, stage: 'wait',
        message: `The flow ran but finished in state ${execution.state}.`,
        setup: { record: setupLabel, sys_id: setupSysId, transition: setupTransition }, execution, assertions: [],
      };
    }
    if (![...TERMINAL_OK, ...SETTLED_PAUSED].includes(execution.state)) {
      return {
        ok: false, available: true, stage: 'wait',
        message: `The flow did not settle within ${timeoutSec}s (last state ${execution.state}).`,
        setup: { record: setupLabel, sys_id: setupSysId, transition: setupTransition }, execution, assertions: [],
      };
    }

    // Actions land a moment after the context settles.
    await new Promise((r) => setTimeout(r, 4000));

    // --- assert ---
    const runAssertions = async (list, phase) => {
      assertions.push(...await runAssertionList(list, phase, { setupSysId }, emit));
    };
    await runAssertions(spec.assert, 'paused');

    // --- resume: unblock an approval/wait, then assert what follows ---
    if (spec.resume && Array.isArray(spec.assertAfterResume) && spec.assertAfterResume.length) {
      const rTable = spec.resume.table;
      const rId = await locate(spec.resume.locate, rTable, { setupSysId });
      if (!rId) {
        assertions.push({ phase: 'resume', pass: false, table: rTable, field: '(resume)', note: spec.resume.note, reason: 'No record matched the resume locator — nothing to unblock.' });
        emit({ type: 'verify_resume', pass: false, reason: 'no record matched' });
      } else {
        emit({ type: 'verify_resume', table: rTable, patch: spec.resume.patch, sys_id: rId });
        await table.update(rTable, rId, spec.resume.patch);
        // Not added to `created`: the runner did not create this row, and the
        // spec's own cleanup entry is responsible for removing it.

        // Wait for the flow to move past the pause.
        const rWait = Math.min(Math.max(Number(spec.resume.waitSec) || 90, 15), 300);
        const rDeadline = Date.now() + rWait * 1000;
        while (Date.now() < rDeadline) {
          await new Promise((r) => setTimeout(r, 3000));
          const ctxs = await table.query('sys_flow_context', {
            query: `source_record=${setupSysId}`, fields: 'sys_id,name,state', limit: 10,
          });
          const mine = ctxs.find((c) => norm(c.name?.display_value ?? c.name) === norm(spec.wait.flowName)) || ctxs[0];
          const st = mine?.state?.value ?? mine?.state;
          if (st) {
            execution = { ...execution, state: st };
            emit({ type: 'verify_execution', phase: 'resumed', state: st });
            if ([...TERMINAL_OK, ...TERMINAL_BAD].includes(st)) break;
          }
        }
        await new Promise((r) => setTimeout(r, 4000));
        await runAssertions(spec.assertAfterResume, 'resumed');
      }
    }

    const passed = assertions.filter((x) => x.pass).length;
    return {
      ok: assertions.length > 0 && passed === assertions.length,
      available: true,
      stage: 'assert',
      setup: { record: setupLabel, sys_id: setupSysId, payload: spec.setup.payload, transition: setupTransition },
      execution,
      assertions,
      summary: `${passed}/${assertions.length} assertions passed`,
      message: passed === assertions.length
        ? `Verified: ${passed}/${assertions.length} assertions passed against a real execution.`
        : `${assertions.length - passed} of ${assertions.length} assertions FAILED.`,
    };
  } finally {
    // --- cleanup: always ---
    emit({ type: 'verify_cleanup' });
    for (const c of spec.cleanup || []) {
      try {
        const t = c.table || spec.setup.table;
        if (c.locate?.bySetupRecord) continue; // handled below, after the extras
        const id = await locate(c.locate, t, { setupSysId });
        if (id) await table.remove(t, id).catch(() => {});
      } catch { /* cleanup must never mask the real result */ }
    }
    for (const c of created) {
      await table.remove(c.table, c.sys_id).catch(() => {});
    }
  }
}

/**
 * Prove a deployed SUBFLOW by calling it: setup → invoke → settle → assert →
 * cleanup, with the same finally-block discipline as the flow runner.
 *
 * The invocation goes through execution-harness.js (a one-shot scheduled job
 * driving sn_fd.FlowAPI), which is shared infrastructure — the same path will
 * verify fix scripts and script includes.
 *
 * Everything the runner needs about the subflow is read off the INSTANCE, not
 * guessed: its sys_id by name, its `<scope>.<internal_name>` address, and its
 * declared outputs. A subflow that is not deployed fails here rather than
 * producing a job that calls a name the runner cannot resolve.
 */
export async function verifySubflow(name, spec, emit = () => {}) {
  const hits = await flows.findByName(spec.subflow || name, 'subflow');
  if (!hits.length) {
    return {
      ok: false, available: true, kind: 'subflow', stage: 'resolve',
      message: `"${spec.subflow || name}" is not on the instance as a subflow, so there is nothing to call.`,
    };
  }
  const sysId = hits[0].sys_id?.value ?? hits[0].sys_id;
  let address;
  let contract;
  try {
    [address, contract] = await Promise.all([flows.qualifiedName(sysId), flows.contract(sysId)]);
  } catch (err) {
    return { ok: false, available: true, kind: 'subflow', stage: 'resolve', message: err.message };
  }

  const check = validateVerifySpec(spec, { contract: { ...contract, name: address.name } });
  const fieldCheck = check.ok ? await checkVerifySpecFields(spec) : { ok: true, errors: [] };
  if (!check.ok || !fieldCheck.ok) {
    return {
      ok: false, available: true, kind: 'subflow',
      message: 'The stored verification spec is invalid — it was NOT run, because it could report a false pass.',
      errors: [...check.errors, ...fieldCheck.errors],
    };
  }

  const created = [];
  let setupSysId = null;
  let setupLabel = null;
  let execution = null;
  let outputs = {};
  const assertions = [];

  try {
    if (spec.setup?.table) {
      emit({ type: 'verify_setup', table: spec.setup.table, payload: spec.setup.payload });
      const rec = await table.create(spec.setup.table, spec.setup.payload);
      setupSysId = rec.sys_id?.value ?? rec.sys_id;
      setupLabel = rec.number?.value ?? rec.name?.value ?? setupSysId;
      created.push({ table: spec.setup.table, sys_id: setupSysId });
      emit({ type: 'verify_setup_done', record: setupLabel, sys_id: setupSysId });
    }

    // The token substitution that hands the setup record to the subflow. Done
    // here rather than in the harness: the harness knows nothing about
    // verification specs, and should not learn.
    const inputs = {};
    for (const [key, value] of Object.entries(spec.inputs || {})) {
      inputs[key] = typeof value === 'string' ? value.replace(/\{\{setup\.sys_id\}\}/g, setupSysId ?? '') : value;
    }

    emit({ type: 'verify_invoking', subflow: address.name, qualified: address.qualified, inputs });
    const run = await executeSubflow({
      qualified: address.qualified,
      inputs,
      // The contract is not decoration here: a REFERENCE input has to be handed
      // a positioned GlideRecord, and the harness can only know which inputs
      // those are from the contract the instance holds.
      declaredInputs: contract.inputs || [],
      declaredOutputs: (contract.outputs || []).map((o) => o.name),
      label: address.name,
      settleTimeoutSec: Math.min(Math.max(Number(spec.wait?.timeoutSec) || 120, 15), 300),
      emit,
    });
    execution = run.execution;
    outputs = run.outputs || {};

    if (!run.ok) {
      return {
        ok: false, available: true, kind: 'subflow', stage: run.stage,
        subflow: address, mechanism: run.mechanism, harness: run.cleanup,
        setup: setupSysId ? { record: setupLabel, sys_id: setupSysId, payload: spec.setup.payload } : null,
        execution, outputs, assertions: [],
        message: run.message,
      };
    }

    // Actions land a moment after the context settles — the same gap the
    // record-triggered runner allows for.
    await new Promise((r) => setTimeout(r, 4000));

    assertions.push(...await runAssertionList(spec.assert || [], 'called', { setupSysId }, emit));

    for (const o of spec.expectOutputs || []) {
      const cell = outputs[o.name];
      const got = cell === undefined ? null : String(cell.value ?? '');
      const want = String(o.expect?.value ?? '');
      const pass = cell !== undefined && norm(got) === norm(want);
      assertions.push({
        phase: 'output', pass, type: 'output', field: o.name, note: o.note,
        expected: want, actual: got, mode: 'exact',
        reason: cell === undefined ? `The execution returned no output named "${o.name}".` : undefined,
      });
      emit({ type: 'verify_assert', phase: 'output', pass, field: o.name, expected: want, actual: got });
    }

    const passed = assertions.filter((x) => x.pass).length;
    return {
      ok: assertions.length > 0 && passed === assertions.length,
      available: true, kind: 'subflow', stage: 'assert',
      subflow: address, mechanism: run.mechanism, harness: run.cleanup,
      setup: setupSysId ? { record: setupLabel, sys_id: setupSysId, payload: spec.setup.payload } : null,
      inputs, execution, outputs, assertions,
      summary: `${passed}/${assertions.length} checks passed`,
      message: passed === assertions.length
        ? `Verified: ${passed}/${assertions.length} checks passed against a real subflow execution.`
        : `${assertions.length - passed} of ${assertions.length} checks FAILED.`,
    };
  } finally {
    emit({ type: 'verify_cleanup' });
    for (const c of spec.cleanup || []) {
      try {
        const t = c.table || spec.setup?.table;
        if (!t || c.locate?.bySetupRecord) continue; // the setup record is handled below
        const id = await locate(c.locate, t, { setupSysId });
        if (id) await table.remove(t, id).catch(() => {});
      } catch { /* cleanup must never mask the real result */ }
    }
    for (const c of created) await table.remove(c.table, c.sys_id).catch(() => {});
  }
}

/**
 * Regenerate a verification spec for an ALREADY-DEPLOYED managed flow, without
 * rebuilding or reinstalling anything.
 *
 * This exists because a deploy can legitimately succeed while spec generation
 * fails (docs/fluent-research.md §14: the flow shipped, no spec could be
 * written, and `createLiveFlow` reported the gap honestly). Before this, the
 * only way to retry was to redeploy the flow — which ships the whole
 * application and moves every artifact's `sys_updated_on` for nothing.
 *
 * Reads only: the instance is touched for schema and reference lookups, never
 * written. Running the resulting spec is still a separate, approved step.
 */
export async function regenerateVerification(name, spec, emit = () => {}) {
  const file = sourcePath(name);
  const source = await fsp.readFile(file, 'utf8').catch(() => null);
  if (!source) {
    return { ok: false, message: `No managed source for "${name}". listManaged() shows what is managed here.` };
  }

  // The same context the build path would have had: real schema for the
  // trigger table, real sys_ids for every proper noun the spec names.
  const intent = await extractIntent(spec, codegenDecoding(specFingerprint(spec), 0));
  emit({ type: 'intent', intent });
  const context = await buildLiveContext(intent);
  if (context.resolved.length) emit({ type: 'resolved', resolved: context.resolved });

  const promisedEffects = intent?.promised_effects || [];
  const vr = await generateVerification({ spec, source, context, flowName: name, promisedEffects }, emit);

  if (!vr.ok) {
    emit({ type: 'verify_spec_failed', errors: vr.errors });
    return {
      ok: false,
      attempts: vr.attempts,
      stalled: Boolean(vr.stalled),
      errors: vr.errors,
      promisedEffects,
      message: `No valid verification spec after ${vr.attempts} attempt(s).`,
    };
  }

  const target = verifyPath(name);
  await fsp.writeFile(target, JSON.stringify(vr.spec, null, 2), 'utf8');
  emit({
    type: 'verify_spec_ready',
    assertions: vr.spec.assert.length,
    attempts: vr.attempts,
    unverifiable: (vr.unverifiable || []).length,
  });
  return {
    ok: true,
    file: path.basename(target),
    attempts: vr.attempts,
    assertions: vr.spec.assert.length,
    promisedEffects,
    unverifiable: vr.unverifiable || [],
    spec: vr.spec,
  };
}

/**
 * Scheduled flows cannot be verified by firing them: there is no supported
 * manual-execute path. `now-sdk --help` exposes no run command (only ATF via
 * cicd), and sn_fd.FlowAPI is server-side script only, reachable solely by
 * creating a Scripted REST API or background script — neither is a supported
 * REST path, and both would be a hack. Waiting for wall-clock firing is not
 * verification. So a scheduled flow is verified against its DECODED trigger
 * configuration instead: the schedule exists, with the expected cadence.
 */
export async function verifySchedule(name, expected = {}) {
  const hits = await flows.findByName(name);
  if (!hits.length) return { ok: false, message: `"${name}" is not on the instance.` };
  const sysId = hits[0].sys_id?.value ?? hits[0].sys_id;
  const detail = await flows.detail(sysId);
  const trigger = detail.triggers[0];
  const cfg = trigger?.config || {};
  const triggerType = trigger ? (trigger.trigger_type?.value ?? trigger.trigger_type) : null;

  const checks = [];
  const add = (label, pass, got, want) => checks.push({ label, pass, got, want });

  add('flow is active', (detail.flow.active?.value ?? detail.flow.active) === 'true', detail.flow.active?.value, 'true');
  add('a trigger exists', Boolean(trigger), triggerType, 'present');
  if (expected.triggerType) add('trigger type', triggerType === expected.triggerType, triggerType, expected.triggerType);
  if (expected.cadenceKey) {
    const got = cfg[expected.cadenceKey];
    add(`schedule carries ${expected.cadenceKey}`, got != null && got !== '', got ?? '(absent)', expected.cadenceValue ?? 'present');
    if (expected.cadenceValue != null) {
      add(`${expected.cadenceKey} value`, norm(got) === norm(expected.cadenceValue), got, expected.cadenceValue);
    }
  }

  // Schedule times are stored in UTC: Time({hours:7}, 'Asia/Kolkata') is
  // persisted as 01:30. Comparing against the local wall-clock time the request
  // asked for would fail a perfectly correct flow, so callers pass the local
  // time plus its offset and the check does the conversion.
  let localTime = null;
  if (expected.localTime && expected.utcOffsetMinutes != null && cfg.time) {
    const hhmm = String(cfg.time).match(/(\d{2}):(\d{2})/);
    if (hhmm) {
      const utcMinutes = Number(hhmm[1]) * 60 + Number(hhmm[2]);
      const local = ((utcMinutes + expected.utcOffsetMinutes) % 1440 + 1440) % 1440;
      localTime = `${String(Math.floor(local / 60)).padStart(2, '0')}:${String(local % 60).padStart(2, '0')}`;
      add(`schedule fires at ${expected.localTime} local`, localTime === expected.localTime, `${localTime} local (${hhmm[0]} UTC)`, expected.localTime);
    }
  }

  const passed = checks.filter((c) => c.pass).length;
  return {
    ok: passed === checks.length,
    kind: 'schedule-metadata',
    sys_id: sysId,
    triggerType,
    config: cfg,
    localTime,
    checks,
    summary: `${passed}/${checks.length} metadata checks passed`,
    caveat: 'Metadata only — no supported manual-execute path exists for scheduled flows, so this proves the schedule is configured, not that it fired.',
  };
}

export const fluent = {
  capability, createLiveFlow, generateAndValidate, deploy,
  listManaged, removeManaged, smokeRun, slugify, parseArtifacts,
  verify, verifySubflow, verifySchedule, validateVerifySpec,
  validateSubflowVerifySpec, regenerateVerification, subflowCatalog,
};

/**
 * The reuse catalog, for callers that want to see what codegen will be told.
 * Read-only, and derived from the same sources the pipeline builds it from.
 */
export async function subflowCatalog() {
  return buildCatalog(await readProjectSources());
}
