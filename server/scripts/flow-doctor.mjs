/**
 * FLOW DOCTOR — is this machine able to author flows into ServiceNow?
 *
 * Run it BEFORE you need it to work. Every check names the exact command that
 * fixes it, so someone who has never seen this repository can get from a fresh
 * clone to a working install without asking anyone.
 *
 * READ-ONLY. It checks; it never installs, writes or publishes.
 *
 *   node scripts/flow-doctor.mjs           # check everything
 *   node scripts/flow-doctor.mjs --quick   # skip the live instance probe
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
const REPO = path.resolve(SERVER, '..');
const WORKSPACE = path.join(SERVER, 'fluent-workspace');

const quick = process.argv.includes('--quick');
const results = [];

const record = (name, ok, detail, fix = null) => {
  results.push({ name, ok, detail, fix });
  const mark = ok === true ? 'PASS' : ok === null ? 'WARN' : 'FAIL';
  console.log(`${mark}  ${name}`);
  if (detail) console.log(`      ${detail}`);
  if (!ok && fix) console.log(`      FIX: ${fix}`);
};

/* ---- 1. Node ---- */
{
  const major = Number(process.versions.node.split('.')[0]);
  record('Node.js 20 or newer', major >= 20, `found v${process.versions.node}`,
    'install Node 20+ from https://nodejs.org (the SDK and this server both need it)');
}

/* ---- 2. The SDK CLI, installed globally ---- */
{
  let version = null;
  let err = null;
  try {
    /*
     * Resolved the way the server itself resolves it, then run through `node`.
     * Not `shell: true` (Node deprecates it, DEP0190) and not the `.cmd` shim
     * directly (Node blocks spawning .cmd without a shell since CVE-2024-27980)
     * - either one reports a perfectly good SDK as broken.
     */
    const { resolveSdkEntry } = await import('../src/servicenow/fluent.js');
    const entry = resolveSdkEntry();
    if (!entry) throw new Error('now-sdk is not installed where this server looks for it');
    const { stdout } = await pexec(process.execPath, [entry, '--version'], { timeout: 60000 });
    version = String(stdout).trim().split('\n').pop();
  } catch (e) { err = e.message.split('\n')[0]; }
  record('ServiceNow SDK CLI on PATH', Boolean(version), version ? `now-sdk ${version}` : `not runnable: ${err}`,
    'npm install -g @servicenow/sdk    (then reopen the terminal so PATH updates)');
}

/* ---- 3. Workspace dependencies ---- */
{
  const core = path.join(WORKSPACE, 'node_modules/@servicenow/sdk-core');
  const present = fs.existsSync(core);
  record('Fluent workspace dependencies installed', present,
    present ? `@servicenow/sdk-core present in ${path.relative(REPO, WORKSPACE)}/node_modules` : 'node_modules is missing or incomplete',
    `npm install --prefix ${path.relative(REPO, WORKSPACE).replace(/\\/g, '/')}`);
}

/* ---- 4. Instance type definitions (what makes `incident` a known table) ---- */
{
  const types = path.join(WORKSPACE, '@types/servicenow');
  const present = fs.existsSync(types);
  record('Instance type definitions generated', present,
    present ? '@types/servicenow present' : 'the generated table types are missing; the build cannot type-check table names',
    'cd server/fluent-workspace && now-sdk dependencies');
}

/* ---- 5. The tracked workspace identity ---- */
{
  const template = path.join(WORKSPACE, 'now.config.template.json');
  let scope = null;
  try { scope = JSON.parse(fs.readFileSync(template, 'utf8')).scope; } catch { /* reported below */ }
  record('Workspace identity (now.config.template.json)', Boolean(scope),
    scope ? `scope ${scope}` : 'missing or unreadable — the workspace does not know which application it installs into',
    'restore server/fluent-workspace/now.config.template.json from git');
}

/* ---- 6. The codegen cheatsheet ---- */
{
  const sheet = path.join(REPO, 'docs/fluent-flow-cheatsheet.md');
  record('Codegen cheatsheet present', fs.existsSync(sheet), path.relative(REPO, sheet),
    'restore docs/fluent-flow-cheatsheet.md from git — codegen quality depends on it');
}

/* ---- 7. The SDK's own action/trigger catalogue ---- */
{
  const { sdkCatalogue } = await import('../src/servicenow/sdk-catalogue.js');
  const cat = sdkCatalogue({ refresh: true });
  record('SDK action/trigger catalogue readable', cat.available,
    cat.available ? `${cat.counts.actions} actions, ${cat.counts.triggers} triggers` : cat.reason,
    `npm install --prefix ${path.relative(REPO, WORKSPACE).replace(/\\/g, '/')}`);
}

/* ---- 8. Instance binding + credentials (never printed) ---- */
let capability = null;
if (!quick) {
  try {
    const { capability: cap } = await import('../src/servicenow/fluent.js');
    capability = await cap();

    record('ServiceNow instance bound', Boolean(capability.auth?.host),
      capability.auth?.host ? `${capability.auth.host} as ${capability.auth.username ?? '(unknown user)'}` : 'no instance configured',
      'open the app, go to Settings, and set the instance URL, username and password');

    record('SDK and app tiers agree on the instance', capability.auth?.matchesNowHelpAssistInstance !== false,
      capability.auth?.error ?? 'both tiers resolve the same host',
      'set the instance once in Settings — the SDK binding is derived from it per invocation');

    record('Application scope resolves on the instance', Boolean(capability.workspace?.scope),
      capability.workspace?.scope ? `${capability.workspace.scope} ("${capability.workspace.appName}")` : (capability.workspace?.error ?? 'unknown'),
      'install the application once, or correct the scope in now.config.template.json');

    record('Overall capability', capability.ok === true,
      capability.ok ? 'the flow pipeline reports ready' : `not ready: ${(capability.fixes ?? []).map((f) => f.problem).join('; ') || 'see above'}`,
      (capability.fixes ?? []).map((f) => f.command).join('  |  ') || null);
  } catch (e) {
    record('ServiceNow instance reachable', false, e.message.split('\n')[0],
      'check the instance URL and credentials in Settings, and that the PDI is awake (log into it in a browser)');
  }
} else {
  console.log('SKIP  live instance checks (--quick)');
}

/* ---- 9. The LLM the codegen uses ---- */
{
  try {
    const { providerInfo } = await import('../src/agent/providers/index.js');
    const info = providerInfo();
    record('LLM provider configured', Boolean(info.model), `${info.provider} / ${info.model}`,
      'set a provider and model in Settings');
    if (info.provider === 'ollama') {
      console.log('      NOTE: Ollama is the free path and is the weakest at Fluent codegen.');
      console.log('            If generation keeps failing, switch to Anthropic or OpenAI in Settings.');
    }
  } catch (e) {
    record('LLM provider configured', false, e.message.split('\n')[0], 'set a provider and model in Settings');
  }
}

/* ---- verdict ---- */
const failed = results.filter((r) => r.ok === false);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log('\nRun these, in order:\n');
  for (const f of failed) if (f.fix) console.log(`  # ${f.name}\n  ${f.fix}\n`);
  process.exitCode = 1;
} else {
  console.log('Ready to author flows.');
}
