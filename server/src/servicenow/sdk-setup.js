import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { table } from './client.js';
import { establishApplication, MAX_SCOPE_LENGTH, vendorPrefix } from './app-create.js';
import { jsLiteral, runServerScript } from './execution-harness.js';
import { boundInstance, sdkAuthEnv } from './instance-binding.js';
import {
  WORKSPACE,
  assertTiersAgree,
  buildWorkspace,
  capability,
  installWorkspace,
  parseInstall,
  readAppIdentity,
  resetSdkEntryCache,
  resolveSdkEntry,
} from './fluent.js';

const pexec = promisify(execFile);
const DEP_TIMEOUT_MS = 10 * 60 * 1000;
const DIAGNOSTIC_PATTERNS = /ERROR|Error:|error TS|Build failed|diagnostic|timed out|Command failed|Unable to|Cannot|refused|denied|not found|failed/i;
const APP_CONFIG = path.join(WORKSPACE, 'now.config.json');
const APP_CONFIG_TEMPLATE = path.join(WORKSPACE, 'now.config.template.json');
const FLUENT_SRC = path.join(WORKSPACE, 'src', 'fluent');

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function sdkPackagePresent() {
  return fs.existsSync(path.join(WORKSPACE, 'node_modules', '@servicenow', 'sdk', 'bin', 'index.js'));
}

async function installWorkspaceDependencies(emit = () => {}) {
  if (sdkPackagePresent() && resolveSdkEntry()) {
    return { ok: true, skipped: true, message: 'SDK dependencies are already installed.' };
  }
  emit({ type: 'dependencies_installing', message: 'Installing ServiceNow SDK workspace dependencies.' });
  try {
    const { stdout, stderr } = await pexec(npmCommand(), ['install'], {
      cwd: WORKSPACE,
      timeout: DEP_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    resetSdkEntryCache();
    return { ok: true, skipped: false, stdout: String(stdout || '').slice(-2000), stderr: String(stderr || '').slice(-2000) };
  } catch (err) {
    resetSdkEntryCache();
    return {
      ok: false,
      skipped: false,
      message: err.message,
      stdout: String(err.stdout || '').slice(-2000),
      stderr: String(err.stderr || '').slice(-2000),
    };
  }
}

function companyKeyFromScope(scope) {
  return /^x_(\d+)_/.exec(String(scope || ''))?.[1] || null;
}

function suffixFromScope(scope) {
  return /^x_\d+_(.+)$/.exec(String(scope || '').trim())?.[1] || null;
}

function localScopeForIdentity(identity, prefix) {
  const suffix = suffixFromScope(identity.scope) || String(identity.name || 'nwforge')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const budget = MAX_SCOPE_LENGTH - prefix.length;
  const trimmed = suffix.slice(0, Math.max(0, budget)).replace(/_+$/, '');
  return trimmed ? `${prefix}${trimmed}` : null;
}

async function writeWorkspaceIdentity(identity) {
  const body = `${JSON.stringify({ scope: identity.scope, name: identity.name }, null, 4)}\n`;
  await fsp.writeFile(APP_CONFIG_TEMPLATE, body, 'utf8');
  await fsp.writeFile(APP_CONFIG, body, 'utf8');
}

async function listFiles(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function isManagedSource(file) {
  return /\.(?:ts|json)$/.test(file) && !file.includes(`${path.sep}node_modules${path.sep}`);
}

async function replaceScopeInWorkspaceFiles(fromScope, toScope) {
  const files = (await listFiles(FLUENT_SRC)).filter(isManagedSource);
  let edited = 0;
  let renamed = 0;
  for (const file of files) {
    const text = await fsp.readFile(file, 'utf8');
    const next = text.split(fromScope).join(toScope);
    if (next !== text) {
      await fsp.writeFile(file, next, 'utf8');
      edited += 1;
    }
  }
  for (const file of files.filter((f) => path.basename(f).includes(fromScope))) {
    const target = path.join(path.dirname(file), path.basename(file).split(fromScope).join(toScope));
    if (target !== file && !fs.existsSync(target)) {
      await fsp.rename(file, target);
      renamed += 1;
    }
  }
  return { edited, renamed };
}

async function adoptLocalScope(identity, emit = () => {}) {
  const prefix = await vendorPrefix();
  if (identity.scope?.startsWith(prefix)) return null;
  const localScope = localScopeForIdentity(identity, prefix);
  if (!localScope || localScope.length > MAX_SCOPE_LENGTH) return null;

  const before = await appStatus(localScope);
  emit({
    type: 'application_scope_adopting',
    from: identity.scope,
    to: localScope,
    message: `This instance cannot create ${identity.scope}; switching the workspace to local scope ${localScope}.`,
  });
  const source = await replaceScopeInWorkspaceFiles(identity.scope, localScope);
  const adoptedIdentity = { ...identity, scope: localScope };
  await writeWorkspaceIdentity(adoptedIdentity);
  emit({
    type: 'application_scope_adopted',
    from: identity.scope,
    to: localScope,
    source,
    existed: before.installed,
    message: `Workspace scope is now ${localScope}.`,
  });
  return { identity: adoptedIdentity, app: before, source };
}

function cellValue(cell) {
  return cell && typeof cell === 'object' ? cell.value : cell;
}

function propertyLink(sysId) {
  const base = (boundInstance().url || '').replace(/\/+$/, '');
  return base && sysId ? `${base}/nav_to.do?uri=sys_properties.do?sys_id=${sysId}` : null;
}

function usefulCommandFailure(result, fallback = 'SDK install failed.') {
  const text = `${result?.stdout || ''}\n${result?.stderr || ''}`.replace(/\r/g, '');
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => DIAGNOSTIC_PATTERNS.test(line));
  const commandOnly = lines.filter((line) => !/^Command failed:/i.test(line));
  const picked = commandOnly.length ? commandOnly : lines;
  const message = (picked.length ? picked.join('\n') : text.trim() || fallback).slice(0, 4000);
  return message || fallback;
}

function trustManualAction(companyKey, trust = {}) {
  const keys = [...new Set([...(trust.keys || []), companyKey].filter(Boolean))];
  return {
    requiredRole: 'ServiceNow admin with permission to update sn_appauthor.all_company_keys',
    property: 'sn_appauthor.all_company_keys',
    propertySysId: trust.sys_id || null,
    url: propertyLink(trust.sys_id),
    addValue: companyKey,
    targetValue: keys.join(','),
    reason: trust.error || 'The property is not writable by the connected account.',
  };
}

async function appStatus(scope) {
  if (!scope) return { installed: false, scope: null, sys_id: null, name: null };
  const rows = await table.query('sys_scope', {
    query: `scope=${scope}`,
    fields: 'sys_id,scope,name',
    display: 'false',
    limit: 1,
  }).catch(() => []);
  const row = rows[0];
  return {
    installed: Boolean(row),
    scope,
    sys_id: cellValue(row?.sys_id) || null,
    name: cellValue(row?.name) || null,
  };
}

async function ensureWorkspaceApplication(identity, emit = () => {}) {
  const before = await appStatus(identity.scope);
  if (before.installed) return { ok: true, app: before, changed: false };

  emit({
    type: 'application_missing',
    message: `Creating the workspace application ${identity.scope} on this instance.`,
    scope: identity.scope,
  });
  const established = await establishApplication({ emit }).catch((err) => ({
    ok: false,
    message: err.message,
    detail: err.detail,
  }));
  const after = await appStatus(identity.scope);
  if (after.installed) {
    return { ok: true, app: after, changed: true, established };
  }
  const details = usefulCommandFailure({
    stdout: established?.detail || established?.stdout || '',
    stderr: established?.message || established?.stderr || '',
  }, 'The workspace application could not be created on this instance.');
  const adoptable = /application was null|could not be created|refused|vendor prefix|cannot be created/i.test(details);
  if (adoptable) {
    const adopted = await adoptLocalScope(identity, emit).catch((err) => ({
      error: err.message,
    }));
    if (adopted?.identity?.scope && adopted.identity.scope !== identity.scope) {
      if (adopted.app?.installed) {
        return { ok: true, app: adopted.app, changed: true, established, adopted };
      }
      const retried = await establishApplication({ emit }).catch((err) => ({
        ok: false,
        message: err.message,
        detail: err.detail,
      }));
      const retryAfter = await appStatus(adopted.identity.scope);
      if (retryAfter.installed) {
        return { ok: true, app: retryAfter, changed: true, established: retried, adopted };
      }
      const retryDetails = usefulCommandFailure({
        stdout: retried?.detail || retried?.stdout || '',
        stderr: retried?.message || retried?.stderr || '',
      }, details);
      return {
        ok: false,
        app: retryAfter,
        changed: true,
        established: retried,
        adopted,
        message: retryDetails,
        manualAction: {
          action: 'Create the workspace application once, then rerun Auto setup.',
          scope: adopted.identity.scope,
          name: adopted.identity.name,
          steps: [
            'Open ServiceNow Studio.',
            `Create/select a scoped application named "${adopted.identity.name}" with scope "${adopted.identity.scope}".`,
            'Return to NowForge and run Auto setup again.',
          ],
        },
      };
    }
  }
  return {
    ok: false,
    app: after,
    changed: false,
    established,
    message: /application was null/i.test(details)
      ? `ServiceNow refused to create the SDK application for scope ${identity.scope}. Open the execution tracker from the SDK output, or create the app once in Studio, then run Auto setup again.`
      : details,
    manualAction: {
      action: 'Create the workspace application once, then rerun Auto setup.',
      scope: identity.scope,
      name: identity.name,
      steps: [
        'Open ServiceNow Studio.',
        `Create/select a scoped application named "${identity.name}" with scope "${identity.scope}".`,
        'Return to NowForge and run Auto setup again.',
      ],
    },
  };
}

async function companyKeyStatus(companyKey) {
  if (!companyKey) return { required: null, readable: false, trusted: false, value: null, sys_id: null };
  try {
    const rows = await table.query('sys_properties', {
      query: 'name=sn_appauthor.all_company_keys',
      fields: 'sys_id,name,value',
      display: 'false',
      limit: 1,
    });
    const row = rows[0];
    if (!row) {
      return { required: companyKey, readable: true, trusted: false, missingProperty: true, value: null, sys_id: null };
    }
    const value = String(cellValue(row.value) || '');
    const keys = value.split(',').map((k) => k.trim()).filter(Boolean);
    return {
      required: companyKey,
      readable: true,
      trusted: keys.includes(companyKey),
      value,
      keys,
      sys_id: cellValue(row.sys_id),
    };
  } catch (err) {
    return { required: companyKey, readable: false, trusted: false, value: null, sys_id: null, error: err.message };
  }
}

async function ensureCompanyKey(companyKey, emit = () => {}) {
  const before = await companyKeyStatus(companyKey);
  if (!companyKey || before.trusted) return { ...before, changed: false };
  if (!before.readable || !before.sys_id) return { ...before, changed: false, blocked: true };

  const keys = [...new Set([...(before.keys || []), companyKey])];
  const value = keys.join(',');
  emit({ type: 'trust_updating', companyKey, message: `Adding company key ${companyKey} to SDK trust.` });
  try {
    await table.update('sys_properties', before.sys_id, { value }, 'false');
    const after = await companyKeyStatus(companyKey);
    return { ...after, changed: after.trusted, previousValue: before.value };
  } catch (err) {
    emit({
      type: 'trust_rest_blocked',
      companyKey,
      message: 'Direct property update was refused; trying the server-side setup script.',
    });
    const scripted = await ensureCompanyKeyWithServerScript(companyKey, before, emit).catch((scriptErr) => ({
      ...before,
      changed: false,
      blocked: true,
      scripted: true,
      trusted: false,
      error: scriptErr.message,
    }));
    if (scripted.trusted) return scripted;
    return {
      ...before,
      changed: false,
      blocked: true,
      error: scripted.error ? `${err.message}; server-side setup also failed: ${scripted.error}` : err.message,
      manualAction: trustManualAction(companyKey, { ...before, error: err.message }),
      scripted,
    };
  }
}

async function ensureCompanyKeyWithServerScript(companyKey, before, emit = () => {}) {
  emit({ type: 'trust_script_running', companyKey, message: `Running server-side trust setup for company key ${companyKey}.` });
  const body = [
    `  var requiredKey = ${jsLiteral(companyKey)};`,
    "  var propName = 'sn_appauthor.all_company_keys';",
    "  var gr = new GlideRecord('sys_properties');",
    '  gr.addQuery("name", propName);',
    '  gr.query();',
    "  if (!gr.next()) { throw 'Property not found: ' + propName; }",
    "  var current = String(gr.getValue('value') || '').trim();",
    '  var keys = current ? current.split(",") : [];',
    '  var seen = {};',
    '  var out = [];',
    '  for (var i = 0; i < keys.length; i++) {',
    '    var k = String(keys[i]).trim();',
    '    if (k && !seen[k]) { seen[k] = true; out.push(k); }',
    '  }',
    '  if (!seen[requiredKey]) { out.push(requiredKey); }',
    '  var next = out.join(",");',
    '  report.propertySysId = gr.getUniqueValue();',
    '  report.oldValue = current;',
    '  report.newValue = next;',
    '  report.canWrite = gr.canWrite();',
    '  gr.setWorkflow(false);',
    "  gr.setValue('value', next);",
    '  report.updateSysId = gr.update();',
    '  try { gs.flushProperties(); } catch (flushErr) { report.flushError = String(flushErr); }',
    "  var check = new GlideRecord('sys_properties');",
    '  if (!check.get(report.propertySysId)) { throw "Property disappeared after update"; }',
    "  var stored = String(check.getValue('value') || '');",
    '  report.storedValue = stored;',
    '  report.trusted = stored.split(",").map(function (k) { return String(k).trim(); }).indexOf(requiredKey) !== -1;',
    "  if (!report.trusted) { throw 'Server-side script ran but the property value did not retain ' + requiredKey; }",
  ].join('\n');
  const run = await runServerScript({
    body,
    label: 'trust ServiceNow SDK company key',
    timeoutMs: 120_000,
    emit,
  });
  if (!run.ok || !run.report?.trusted) {
    return {
      ...before,
      changed: false,
      blocked: true,
      scripted: true,
      trusted: false,
      error: run.report?.error || run.message || 'Server-side trust setup did not complete.',
      harness: { ok: run.ok, channel: run.channel, cleanup: run.cleanup, report: run.report },
    };
  }
  const after = await companyKeyStatus(companyKey);
  return {
    ...after,
    changed: after.trusted,
    previousValue: before.value,
    scripted: true,
    harness: { ok: run.ok, channel: run.channel, cleanup: run.cleanup, report: run.report },
  };
}

export async function sdkSetupStatus({ deep = false, force = false } = {}) {
  const identity = await readAppIdentity().catch((err) => ({ error: err.message, scope: null, name: null }));
  const companyKey = companyKeyFromScope(identity.scope);
  const bound = boundInstance();
  const [cap, trust, app] = await Promise.all([
    capability({ deep, force }),
    companyKeyStatus(companyKey),
    appStatus(identity.scope),
  ]);
  return {
    ok: Boolean(bound.configured && cap.ok && trust.trusted && app.installed),
    bound,
    capability: cap,
    identity,
    companyKey,
    trust,
    app,
    checkedAt: new Date().toISOString(),
  };
}

export async function autoSetupSdk({ emit = () => {}, ensureTrust = true } = {}) {
  emit({ type: 'checking', message: 'Checking ServiceNow SDK setup.' });
  const bound = boundInstance();
  if (!bound.configured) {
    return { ok: false, stage: 'connection', message: 'Save the instance URL and credentials first.' };
  }
  if (!sdkAuthEnv()) {
    return { ok: false, stage: 'credentials', message: 'The saved connection is missing credentials the SDK can use.' };
  }

  const deps = await installWorkspaceDependencies(emit);
  if (!deps.ok) return { ok: false, stage: 'dependencies', message: deps.stderr || deps.message, deps };
  emit({ type: 'dependencies_ready', skipped: deps.skipped });

  let identity = await readAppIdentity();
  try {
    const prefix = await vendorPrefix();
    const existing = await appStatus(identity.scope);
    if (!existing.installed && identity.scope && !identity.scope.startsWith(prefix)) {
      const adopted = await adoptLocalScope(identity, emit);
      if (adopted?.identity) identity = adopted.identity;
    }
  } catch (err) {
    emit({ type: 'application_scope_probe_failed', message: err.message });
  }
  const companyKey = companyKeyFromScope(identity.scope);
  let trust = await companyKeyStatus(companyKey);
  if (ensureTrust && !trust.trusted) trust = await ensureCompanyKey(companyKey, emit);
  if (!trust.trusted) {
    const manualAction = trust.manualAction || trustManualAction(companyKey, trust);
    return {
      ok: false,
      stage: 'trust',
      message: trust.error
        ? `Company key ${companyKey} needs an instance admin action. The connected user can read the property but cannot update it on this instance.`
        : `Company key ${companyKey} is not trusted on this instance.`,
      trust: { ...trust, manualAction },
      manualAction,
    };
  }
  emit({ type: 'trust_ready', companyKey });

  emit({ type: 'binding_check', message: 'Confirming the SDK targets the same instance.' });
  try {
    await assertTiersAgree({ expectMissingApp: true });
  } catch (err) {
    return { ok: false, stage: 'binding', message: err.message, detail: err.detail || null };
  }

  const app = await ensureWorkspaceApplication(identity, emit);
  if (!app.ok) {
    return {
      ok: false,
      stage: 'application',
      message: app.message,
      app: app.app,
      application: app,
      manualAction: app.manualAction,
    };
  }
  emit({ type: 'application_ready', scope: app.app?.scope || identity.scope, changed: app.changed });

  emit({ type: 'building', message: 'Building the SDK application.' });
  const built = await buildWorkspace();
  if (!built.ok) {
    return { ok: false, stage: 'build', message: built.stderr || built.stdout || 'SDK build failed.', build: built };
  }

  emit({ type: 'installing', message: 'Installing the SDK application on the connected instance.' });
  const installed = await installWorkspace({ emit });
  const parsed = parseInstall(installed);
  if (!installed.ok) {
    const diagnostics = usefulCommandFailure(installed);
    emit({
      type: 'install_reported_failed',
      message: 'The SDK command reported a failure; checking the instance before deciding.',
      diagnostics,
    });
    const status = await sdkSetupStatus({ deep: true, force: true }).catch((err) => ({ error: err.message }));
    const verifiedAfterFailure = Boolean(status?.app?.installed && status?.trust?.trusted && status?.capability?.auth?.verified !== 'failed');
    if (verifiedAfterFailure) {
      return {
        ok: true,
        stage: 'ready',
        message: 'ServiceNow SDK setup is ready. The CLI reported an install failure, but the instance read-back verified the app.',
        install: {
          ...parsed,
          reportedFailure: diagnostics,
          raw: { code: installed.code ?? null, timedOut: installed.timedOut === true },
        },
        status,
      };
    }
    return {
      ok: false,
      stage: 'install',
      message: diagnostics,
      install: {
        ...parsed,
        diagnostics,
        raw: { code: installed.code ?? null, timedOut: installed.timedOut === true },
      },
      status,
    };
  }

  emit({ type: 'verifying', message: 'Verifying installed application state.' });
  const status = await sdkSetupStatus({ deep: true, force: true });
  const ok = Boolean(status.app.installed && status.trust.trusted && status.capability.auth.verified !== 'failed');
  return {
    ok,
    stage: ok ? 'ready' : 'verify',
    message: ok ? 'ServiceNow SDK setup is ready.' : 'Install finished, but verification did not fully pass.',
    install: parsed,
    status,
  };
}
