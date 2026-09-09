/**
 * PHASE 3 — CAPABILITY DISCOVERY.
 *
 *   node --test server/test/
 *
 * The question this layer answers is "can THIS instance, from THIS machine, do
 * this through a supported mechanism" — and the failure it exists to prevent is
 * answering it from the tool registry. A tool being present says nothing about
 * whether the SDK is installed, whether its credentials work, or whether an
 * instance is bound at all, and a planner built on "a tool exists" would emit
 * plans that cannot run.
 *
 * So most of these tests are about UNAVAILABILITY: no instance, no CLI, bad
 * credentials, a cold probe, a missing tool, a capability with no mechanism at
 * all. Each has a distinct reason, and none of them is optimistic.
 *
 * Offline in full: settings, the SDK probe and the tool registry are all
 * injected through the seams the production code already takes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-cap-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
});

const C = await import('../src/agent/capability-discovery.js');
const { STATUS } = await import('../src/servicenow/semantic/provenance.js');
const { toolMap, TOOLS } = await import('../src/agent/tools.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const BOUND = {
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
};
const UNBOUND = { connection: { instanceUrl: '', authType: 'basic' } };
const NO_CREDS = { connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: '', password: '' } };

const sdkReady = () => ({
  cli: { present: true, version: '4.10.1' },
  auth: { verified: 'live' },
  workspace: { present: true, scope: 'x_2002152_nwforge' },
  fixes: [],
});
const sdkNoCli = () => ({ cli: { present: false, error: 'ServiceNow SDK not found on this machine.' }, auth: {}, fixes: ['npm i -g @servicenow/sdk'] });
const sdkBadAuth = () => ({ cli: { present: true, version: '4.10.1' }, auth: { verified: 'failed' }, workspace: { present: true }, fixes: ['now-sdk auth'] });
const sdkCold = () => null;

const opts = (over = {}) => ({ settings: BOUND, probe: sdkReady, registry: toolMap, ...over });

/* ------------------------------------------------------------------ *
 * Mechanisms
 * ------------------------------------------------------------------ */

test('REST is available when an instance is bound with complete credentials — and says configured is not proven', () => {
  const r = C.restMechanism({ settings: BOUND });
  assert.equal(r.status, STATUS.KNOWN);
  assert.equal(r.value.mechanism, 'rest');
  assert.equal(r.value.host, 'dev424910.service-now.com');
  // The honesty that matters: this layer makes no calls, so it cannot claim REST
  // has been proven to work.
  assert.match(r.note, /Configuration is not proof/);
});

test('REST is UNAVAILABLE with no instance, and with incomplete credentials — for different reasons', () => {
  const none = C.restMechanism({ settings: UNBOUND });
  assert.equal(none.status, STATUS.UNAVAILABLE);
  assert.match(none.note, /No ServiceNow instance is bound/);

  const partial = C.restMechanism({ settings: NO_CREDS });
  assert.equal(partial.status, STATUS.UNAVAILABLE);
  assert.match(partial.note, /credentials are incomplete/);

  const oauthPartial = C.restMechanism({
    settings: { connection: { instanceUrl: 'https://x.service-now.com', authType: 'oauth', username: 'a', password: 'b' } },
  });
  assert.equal(oauthPartial.status, STATUS.UNAVAILABLE, 'OAuth without a client id/secret was reported available');
});

test('SDK availability comes from the probe, and each failure keeps its own reason', () => {
  const ready = C.sdkMechanism({ probe: sdkReady });
  assert.equal(ready.status, STATUS.KNOWN);
  assert.equal(ready.value.scope, 'x_2002152_nwforge');

  const noCli = C.sdkMechanism({ probe: sdkNoCli });
  assert.equal(noCli.status, STATUS.UNSUPPORTED, 'a missing CLI is unsupported on this machine, not merely unavailable');
  assert.deepEqual(noCli.evidence.fixes, ['npm i -g @servicenow/sdk']);

  const badAuth = C.sdkMechanism({ probe: sdkBadAuth });
  assert.equal(badAuth.status, STATUS.UNAVAILABLE, 'rejected credentials are unavailable, not unsupported');
  assert.match(badAuth.note, /"failed"/);

  const noWorkspace = C.sdkMechanism({
    probe: () => ({ cli: { present: true, version: '4.10.1' }, auth: { verified: 'live' }, workspace: { present: false }, fixes: [] }),
  });
  assert.equal(noWorkspace.status, STATUS.UNAVAILABLE);
  assert.match(noWorkspace.note, /no Fluent workspace/);
});

test('a COLD probe is UNKNOWN, not unavailable, and never available', () => {
  /*
   * The distinction a planner depends on. The SDK probe costs ~8 seconds of CLI
   * start-up, so discovery reads the cached answer and never blocks. A cold
   * cache means nobody has looked — which is neither "it works" nor "it is
   * broken", and reporting either would be a fabrication.
   */
  const cold = C.sdkMechanism({ probe: sdkCold });
  assert.equal(cold.status, STATUS.UNKNOWN);
  assert.equal(cold.value, null);
  assert.match(cold.note, /has not completed yet/);

  const cap = C.discoverCapability('flow_authoring', opts({ probe: sdkCold }));
  assert.equal(cap.available, false, 'an unknown mechanism was treated as available');
  assert.equal(cap.reason, 'mechanism_unknown');
  assert.equal(cap.status, STATUS.UNKNOWN);
});

test('readiness uses the SDK module\'s own AUTH_READY ladder, not an equality', () => {
  // A `=== 'derived'` test once reported authoring unavailable precisely when
  // the credentials had just been PROVEN, because the deep probe upgrades
  // 'derived' to 'live'. Both evidenced states must be ready.
  for (const verified of ['derived', 'live']) {
    const m = C.sdkMechanism({ probe: () => ({ cli: { present: true }, auth: { verified }, workspace: { present: true } }) });
    assert.equal(m.status, STATUS.KNOWN, `auth state "${verified}" should be ready`);
  }
  for (const verified of ['unknown', 'failed']) {
    const m = C.sdkMechanism({ probe: () => ({ cli: { present: true }, auth: { verified }, workspace: { present: true } }) });
    assert.notEqual(m.status, STATUS.KNOWN, `auth state "${verified}" must not be ready`);
  }
});

test('the harness rides on REST, and is unavailable when REST is', () => {
  const ok = C.harnessMechanism({ settings: BOUND });
  assert.equal(ok.status, STATUS.KNOWN);
  assert.equal(ok.value.via, 'sysauto_script');
  // It cannot prove the right to insert the job, and says so rather than implying it.
  assert.match(ok.note, /only a write proves/);

  const gone = C.harnessMechanism({ settings: UNBOUND });
  assert.equal(gone.status, STATUS.UNAVAILABLE);
  assert.match(gone.note, /runs through the Table API/);
});

/* ------------------------------------------------------------------ *
 * Capability discovery
 * ------------------------------------------------------------------ */

test('TOOL EXISTENCE IS NOT CAPABILITY AVAILABILITY', () => {
  /*
   * The central claim of this file. `create_flow_live` is in the registry on
   * every machine; flow authoring works only where the SDK is installed,
   * authenticated and has a workspace.
   */
  assert.ok(toolMap.has('create_flow_live'), 'the fixture assumes this tool exists');

  const withSdk = C.discoverCapability('flow_authoring', opts({ probe: sdkReady }));
  assert.equal(withSdk.available, true);
  assert.equal(withSdk.mechanism, 'sdk');
  assert.equal(withSdk.scope, 'x_2002152_nwforge');

  const withoutSdk = C.discoverCapability('flow_authoring', opts({ probe: sdkNoCli }));
  assert.equal(withoutSdk.available, false, 'the tool exists, so the capability was reported available');
  assert.equal(withoutSdk.reason, 'mechanism_unavailable');
  assert.equal(withoutSdk.status, STATUS.UNSUPPORTED);
});

test('REST capabilities follow the binding', () => {
  const bound = C.discoverCapability('record_update', opts());
  assert.equal(bound.available, true);
  assert.equal(bound.mechanism, 'rest');
  assert.equal(bound.requiresApproval, true, 'a mutation must still declare that it passes the gate');
  assert.equal(bound.requiresVerification, true);
  assert.equal(bound.verification, 'read_back');

  const unbound = C.discoverCapability('record_update', opts({ settings: UNBOUND }));
  assert.equal(unbound.available, false);
  assert.equal(unbound.reason, 'mechanism_unavailable');

  // A read is available and needs neither approval nor verification.
  const read = C.discoverCapability('record_read', opts());
  assert.equal(read.available, true);
  assert.equal(read.requiresApproval, false);
  assert.equal(read.requiresVerification, false);
});

test('a capability whose tool has been removed is UNAVAILABLE, whatever the mechanism can do', () => {
  const registry = new Map(toolMap);
  registry.delete('create_sla');
  const gone = C.discoverCapability('sla_authoring', opts({ registry }));
  assert.equal(gone.available, false);
  assert.equal(gone.reason, 'no_tool');
  assert.match(gone.note, /create_sla/);

  // And with the tool present it is available again — so the check is the tool,
  // not an incidental failure.
  assert.equal(C.discoverCapability('sla_authoring', opts()).available, true);
});

test('a capability with NO supported mechanism is unsupported, and nothing is improvised', () => {
  /*
   * The rule: never fall back to arbitrary HTTP, a shell command or a
   * background script to make a capability appear available.
   */
  const imp = C.discoverCapability('transport_import', opts());
  assert.equal(imp.available, false);
  assert.equal(imp.status, STATUS.UNSUPPORTED);
  assert.equal(imp.mechanism, null);
  assert.match(imp.note, /No update-set import mechanism exists/);

  const script = C.discoverCapability('script_execution', opts());
  assert.equal(script.available, false);
  assert.equal(script.status, STATUS.UNSUPPORTED);
  assert.equal(script.mechanism, null);
  assert.match(script.note, /No general-purpose script-execution capability/);
});

test('an unmodelled capability is UNKNOWN and never assumed available', () => {
  const made_up = C.discoverCapability('teleport_records', opts());
  assert.equal(made_up.available, false);
  assert.equal(made_up.status, STATUS.UNKNOWN);
  assert.equal(made_up.reason, 'unknown_capability');
  assert.match(made_up.note, /never assumed available/);
});

test('ELEVATION IS DESCRIBED, from the deterministic classifier — and never performed', () => {
  const acl = C.discoverCapability('acl_authoring', opts());
  assert.equal(acl.available, true);
  assert.equal(acl.requiresElevation, true);
  assert.equal(acl.elevationRole, 'security_admin');
  assert.ok(acl.elevationProvenance, 'the elevation requirement carries no provenance');

  // A capability that needs no elevation says so rather than leaving it unset.
  const rec = C.discoverCapability('record_update', opts());
  assert.equal(rec.requiresElevation, false);
  assert.equal(rec.elevationRole, null);

  // Nothing in this module can elevate. It reads the classifier and stops.
  const src = read('agent/capability-discovery.js');
  for (const bad of [/\brunGatedWrite\s*\(/, /\bexecuteGatedWrite\s*\(/, /elevation-shim/, /\belevate\s*\(/]) {
    assert.doesNotMatch(src, bad, 'capability discovery can reach elevation — Phase 3 must only describe it');
  }
});

test('every mutating capability declares a verification path, or is not safely executable', () => {
  const all = C.discoverAll(opts());
  for (const [name, cap] of Object.entries(all.capabilities)) {
    if (!cap.available || !cap.mutating) continue;
    const safe = C.isSafelyExecutable(cap);
    if (cap.verification === 'none') {
      assert.equal(safe.ok, false, `${name} mutates with no verification but was called safely executable`);
      assert.equal(safe.reason, 'no_verification_path');
    } else {
      assert.equal(safe.ok, true, `${name} has verification "${cap.verification}" but was not safely executable`);
    }
  }
  // A read is trivially safe; an unavailable capability never is.
  assert.equal(C.isSafelyExecutable(all.capabilities.record_read).ok, true);
  assert.equal(C.isSafelyExecutable(C.discoverCapability('flow_authoring', opts({ probe: sdkNoCli }))).ok, false);
});

test('SCOPE — a scoped SDK capability reports the scope it authors into', () => {
  const flow = C.discoverCapability('flow_authoring', opts());
  assert.equal(flow.scope, 'x_2002152_nwforge', 'a scoped capability did not report its scope');

  // A REST capability is not scoped: REST writes are a global-tier writer, and
  // claiming a scope for one would be the husk trap wearing a different hat.
  assert.equal(C.discoverCapability('record_update', opts()).scope, null);

  // The scope comes from the PROBE, never from a constant here.
  const other = C.discoverCapability('flow_authoring', opts({
    probe: () => ({ ...sdkReady(), workspace: { present: true, scope: 'x_9999999_other' } }),
  }));
  assert.equal(other.scope, 'x_9999999_other');
  assert.doesNotMatch(read('agent/capability-discovery.js'), /x_2002152|x_2196302/,
    'a scope name is hardcoded in capability discovery');
});

test('the catalog UI-policy half does not inherit catalog authoring\'s mechanism', () => {
  // Measured: catalog_ui_policy_action accepts a POST and silently discards the
  // fields that attach it, so the actions go through the SDK. A capability
  // layer that lumped them together would report REST authoring available for
  // something REST cannot do at all.
  const item = C.discoverCapability('catalog_authoring', opts());
  assert.equal(item.mechanism, 'rest');
  assert.equal(item.available, true);

  const policy = C.discoverCapability('catalog_ui_policy_authoring', opts());
  assert.equal(policy.mechanism, 'sdk');
  assert.match(policy.note, /cannot be written over REST/);

  // And without the SDK, one stays available and the other does not.
  assert.equal(C.discoverCapability('catalog_authoring', opts({ probe: sdkNoCli })).available, true);
  assert.equal(C.discoverCapability('catalog_ui_policy_authoring', opts({ probe: sdkNoCli })).available, false);
});

test('discoverAll reports one pass over every modelled capability', () => {
  const all = C.discoverAll(opts());
  assert.deepEqual(Object.keys(all.capabilities).sort(), [...C.CAPABILITY_NAMES].sort());
  assert.equal(all.available.length + all.unavailable.length, C.CAPABILITY_NAMES.length);
  assert.ok(all.available.includes('record_read'));
  assert.ok(all.unavailable.includes('script_execution'));
  assert.ok(all.unavailable.includes('transport_import'));
  assert.ok(all.discoveredAt);

  // With nothing bound, nothing that needs a mechanism is available.
  const dark = C.discoverAll(opts({ settings: UNBOUND, probe: sdkNoCli }));
  assert.equal(dark.available.length, 0, 'capabilities were available with no instance and no SDK');
});

test('every declared capability names a mechanism this project actually has', () => {
  for (const [name, spec] of Object.entries(C.CAPABILITIES)) {
    if (spec.unsupported) {
      assert.equal(spec.mechanism, null, `${name} is unsupported but names a mechanism`);
      continue;
    }
    assert.ok(C.MECHANISMS.includes(spec.mechanism), `${name} names mechanism "${spec.mechanism}"`);
    assert.ok(C.VERIFICATION.includes(spec.verification), `${name} names verification "${spec.verification}"`);
    for (const t of spec.tools || []) {
      // A capability may not point at a tool that does not exist — that would
      // be a fabricated capability with a plausible-looking implementation.
      assert.ok(toolMap.has(t), `${name} names tool "${t}", which is not in the registry`);
    }
  }
  assert.deepEqual([...C.MECHANISMS], ['rest', 'sdk', 'harness'], 'a fourth mechanism appeared');
});

test('the required capability taxonomy is covered', () => {
  for (const required of [
    'record_read', 'record_create', 'record_update', 'record_delete',
    'table_create', 'field_create',
    'flow_read', 'flow_authoring', 'flow_publish', 'flow_execute', 'flow_verify',
    'catalog_read', 'catalog_authoring', 'sla_read', 'sla_authoring',
    'acl_read', 'acl_authoring', 'application_read', 'application_authoring',
    'transport_export', 'transport_import', 'impersonation', 'role_elevation',
    'sdk_build', 'sdk_install', 'harness_execution',
    'read_back_verification', 'semantic_verification',
  ]) {
    assert.ok(C.CAPABILITIES[required], `the taxonomy is missing ${required}`);
  }
});

/* ------------------------------------------------------------------ *
 * Determinism, isolation, and the Phase 2 seam
 * ------------------------------------------------------------------ */

test('DETERMINISM — no model is consulted, and repeated discovery agrees', () => {
  const src = read('agent/capability-discovery.js');
  for (const bad of [/\bchatTurn\s*\(/, /\bchatOnce\s*\(/, /providers\//, /\bbuildSystemPrompt\s*\(/]) {
    assert.doesNotMatch(src, bad, 'capability discovery reaches a model — it must be deterministic');
  }
  const a = C.discoverAll(opts());
  const b = C.discoverAll(opts());
  delete a.discoveredAt; delete b.discoveredAt;
  assert.deepEqual(a, b);
});

test('ISOLATION — capability discovery describes; it cannot execute, approve or mutate', () => {
  const IMPORT = /^[ \t]*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm;
  const src = read('agent/capability-discovery.js');
  const FORBIDDEN = [
    /servicenow\/client\.js/, /execution-harness/, /elevation-shim/, /role-elevation\.js/,
    /agent\/orchestrator\.js/, /agent\/write-guard\.js/, /agent\/mutation-pipeline\.js/,
    /memory\/ledger\.js/, /memory\/provenance\.js/, /memory\/tasks\.js/, /task-tracker/,
    /memory\/compaction\.js/, /agent\/providers\//, /servicenow\/transport\.js/,
  ];
  for (const m of src.matchAll(IMPORT)) {
    for (const bad of FORBIDDEN) {
      assert.ok(!bad.test(m[1]), `capability-discovery imports ${m[1]} — it must not reach that layer`);
    }
  }
  for (const bad of [/\btable\.(create|update|remove|del)\s*\(/, /\brunServerScript\s*\(/,
    /\binstallWorkspace\s*\(/, /\bdeploy\s*\(/, /\bcreateLiveFlow\s*\(/,
    /\bexecuteTool\s*\(/, /\bresolveApproval\s*\(/, /\bsaveSettings\s*\(/]) {
    assert.doesNotMatch(src, bad, `capability-discovery calls ${bad} — Phase 3 executes nothing`);
  }
  // It reads the SDK probe only. `capability`/`cachedCapability` are the
  // read-only half of fluent.js; the executors must not be imported by name.
  assert.match(src, /import \{ cachedCapability, AUTH_READY \} from '\.\.\/servicenow\/fluent\.js'/,
    'the SDK import should be exactly the read-only names');
});

test('PHASE 2 SEAM — buildContextProfile({ capability }) is intact and unchanged', async () => {
  // Phase 4 will drive context selection from a known capability. Phase 3 must
  // leave that seam exactly as Phase 2 built it.
  const { buildContextProfile } = await import('../src/agent/context-engine.js');
  const p = buildContextProfile({ goal: 'show me the ACLs', tools: TOOLS, capability: 'flow_authoring' });
  assert.equal(p.fallback, false);
  assert.ok(p.capabilities.includes('flow_authoring'));
  assert.ok(!p.capabilities.includes('acl'), 'the explicit capability did not win over the prose');

  // And Phase 3 did not reach into the context engine.
  assert.doesNotMatch(read('agent/capability-discovery.js'), /context-engine|context-selection/,
    'capability discovery couples itself to the Phase 2 engine');
});

test('the capability vocabulary and the Phase 2 taxonomy are deliberately separate', () => {
  /*
   * They answer different questions and must not be conflated. Phase 2's
   * `flow_authoring` means "show the model its flow tools"; Phase 3's means
   * "this instance can author a flow through the SDK". Sharing a name is
   * useful; sharing a definition would let a context decision start implying
   * an execution guarantee.
   */
  const src = read('agent/capability-discovery.js');
  assert.doesNotMatch(src, /from '\.\/context-capabilities\.js'/,
    'capability discovery imports the Phase 2 taxonomy — the two vocabularies must stay independent');
});
