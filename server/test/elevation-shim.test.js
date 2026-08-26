import test from 'node:test';
import assert from 'node:assert/strict';

import { validateScriptSyntax } from '../src/servicenow/script-liveness.js';
import {
  NONCE_FIELD,
  PROBE_ACL_NAME,
  mintNonce,
  buildProbeAclPayload,
  buildElevatedWriteBody,
  assessOutcomeTier,
} from '../src/servicenow/elevation-shim.js';

/**
 * The elevation shim — everything provable without an instance, after the WI-3
 * sink retrofit. The sink/verdict-binding tests are gone (the sink is gone);
 * every elevation/write/read-back/de-elevate invariant stays. The EXECUTED proof
 * (an elevated GlideRecordSecure write landing and read back by nonce off the
 * TARGET record, no sink) is re-run in docs/role-elevation-wi3-result.md.
 */

const RUNNER = '6816f79cc0a8016401c5a33be04be441';
const NONCE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function body(overrides = {}) {
  const nonce = overrides.nonce ?? NONCE;
  return buildElevatedWriteBody({
    role: overrides.role ?? 'security_admin',
    runnerUserSysId: overrides.runnerUserSysId ?? RUNNER,
    table: overrides.table ?? 'sys_security_acl',
    payload: overrides.payload ?? buildProbeAclPayload({ nonce }),
  });
}

/* ---- dispatchability + the sink is gone ---- */

test('the elevated-write body is dispatchable through the ES3 liveness linter', () => {
  assert.equal(validateScriptSyntax(body()).ok, true);
});

test('SINK REMOVED — the shim writes no sys_user_preference row', async () => {
  assert.ok(!/sys_user_preference/.test(body()), 'the body must not create a sink row');
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/servicenow/elevation-shim.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join('\n');
  assert.ok(!/sys_user_preference/.test(code), 'the shim module must not reference the removed sink');
  assert.ok(!/runConfirmedScript|wrapWithSentinel/.test(code), 'the shim must not route through the sentinel/sink path');
});

/* ---- INVARIANT 1: GlideRecordSecure-only on the gated write ---- */

test('INVARIANT — the gated write is GlideRecordSecure ONLY; a plain GlideRecord insert is banned', async () => {
  const b = body();
  assert.match(b, /new GlideRecordSecure\(TARGET_TABLE\)/, 'the write must go through GlideRecordSecure');
  assert.ok(!/new GlideRecord\([^)]*\)[\s\S]{0,200}\.insert\(\)/.test(b), 'no plain GlideRecord insert on the gated path');
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/servicenow/elevation-shim.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join('\n');
  assert.ok(!/new GlideRecord\([^)]*\)[\s\S]{0,200}\.insert\(\)/.test(code), 'no fallback to a plain GlideRecord insert anywhere in the module');
});

/* ---- INVARIANT 2: assert gs.hasRole before the write ---- */

test('INVARIANT — gs.hasRole is asserted true immediately before the write', () => {
  const b = body();
  const assertAt = b.indexOf('gs.hasRole(ROLE) === true');
  const writeAt = b.indexOf('new GlideRecordSecure(TARGET_TABLE)');
  assert.ok(assertAt > 0 && writeAt > assertAt, 'the write must come AFTER the gs.hasRole assertion');
  assert.ok(!/getUser\(\)\.hasRole/.test(b), 'must assert on gs.hasRole, never gs.getUser().hasRole');
});

/* ---- INVARIANT 3: de-elevate in finally ---- */

test('INVARIANT — de-elevation runs in a finally, on every path', () => {
  const b = body();
  assert.match(b, /\} finally \{[\s\S]*disableElevatedRole\(ROLE\)/, 'disable must sit in the finally');
  const enableAt = b.indexOf('enableElevatedRole(ROLE)');
  const disableAt = b.indexOf('disableElevatedRole(ROLE)');
  assert.ok(enableAt > 0 && disableAt > enableAt);
});

/* ---- runner precondition + reachability, before elevation ---- */

test('the runner precondition is a server-side sys_user_has_role read, gating the enable', () => {
  const b = body();
  assert.match(b, /new GlideRecord\('sys_user_has_role'\)/, 'assignment is read server-side (H6)');
  const precondAt = b.indexOf("new GlideRecord('sys_user_has_role')");
  const enableAt = b.indexOf('enableElevatedRole(ROLE)');
  assert.ok(precondAt > 0 && enableAt > precondAt, 'no enable before the runner precondition');
  assert.match(b, /if \(runnerHasRole && reachable\)/, 'enable only when the runner holds the role AND the manager resolves');
});

test('the reachability guard re-asserts GlideSecurityManager resolves', () => {
  assert.match(body(), /typeof GlideSecurityManager === 'function'.*GlideSecurityManager\.get\(\) !== null/s);
});

/* ---- INVARIANT 5: never delete sys_update_xml ---- */

test('INVARIANT — the shim never deletes sys_update_xml; provenance recorded, not swept', async () => {
  assert.ok(!/sys_update_xml/.test(body()));
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/servicenow/elevation-shim.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join('\n');
  assert.ok(!/sys_update_xml/.test(code), 'only the acceptance test reverts provenance; the shim leaves it alone');
});

/* ---- no hardcoded role ---- */

test('the shim module names no role literally — security_admin is handed in', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/servicenow/elevation-shim.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join('\n');
  assert.ok(!/['"]security_admin['"]/.test(code), 'elevation-shim.js must not hardcode a role name in code');
});

/* ---- the probe payload ---- */

test('the probe ACL is inactive, on a nonexistent table, tagged with the nonce', () => {
  const p = buildProbeAclPayload({ nonce: NONCE });
  assert.equal(p.name, PROBE_ACL_NAME);
  assert.equal(p.active, 'false', 'the probe must be inactive');
  assert.match(p[NONCE_FIELD], new RegExp(NONCE), 'the nonce rides the read-back field');
  assert.throws(() => buildProbeAclPayload({ nonce: 'short' }), /32-char hex nonce/);
});

/* ---- INVARIANT: truth = target read-back; tiers ---- */

test('INVARIANT — the outcome tier comes from the target read-back, never a self-report', () => {
  // FAILED on absence — never green.
  const gone = assessOutcomeTier({ requested: { name: 'x' }, actual: null });
  assert.equal(gone.tier, 'FAILED');
  assert.equal(gone.landed, false);

  // EXECUTED when landed + every requested field matches.
  const ok = assessOutcomeTier({ requested: { name: 'x_nha_wi3_probe', active: 'false' }, actual: { sys_id: '0123456789abcdef0123456789abcdef', name: 'x_nha_wi3_probe', active: 'false' } });
  assert.equal(ok.tier, 'EXECUTED');
  assert.equal(ok.sys_id, '0123456789abcdef0123456789abcdef');

  // COERCED when a requested field differs.
  const drift = assessOutcomeTier({ requested: { name: 'x', active: 'false' }, actual: { sys_id: 'a'.repeat(32), name: 'x', active: 'true' } });
  assert.equal(drift.tier, 'COERCED');
  assert.equal(drift.mismatches[0].field, 'active');

  // A platform-owned rewrite is COERCED, not a dropped write.
  const owned = assessOutcomeTier({
    requested: { name: 'x', description: 'mine' },
    actual: { sys_id: 'a'.repeat(32), name: 'x', description: 'the platform rewrote this' },
    platformOwned: ['description'],
  });
  assert.equal(owned.tier, 'COERCED');
  assert.equal(owned.coerced[0].field, 'description');
  assert.equal(owned.mismatches.length, 0);
});

test('reference cells shaped { value } compare on value', () => {
  const r = assessOutcomeTier({ requested: { operation: 'read' }, actual: { sys_id: 'a'.repeat(32), operation: { value: 'read', display_value: 'Read' } } });
  assert.equal(r.tier, 'EXECUTED');
});

/* ---- WI-4: projection-superset guard (backend half) ---- */

test('INVARIANT — EXECUTED is unreachable when an asserted field is OUTSIDE the read-back projection', () => {
  // The write landed and nothing seen differs, but `active` was never projected,
  // so it cannot be confirmed. The tier must NOT be EXECUTED.
  const r = assessOutcomeTier({
    requested: { name: 'x', active: 'false' },
    actual: { sys_id: 'a'.repeat(32), name: 'x' },     // active not fetched
    comparedFields: ['sys_id', 'name'],                 // projection ⊄ asserted
  });
  assert.notEqual(r.tier, 'EXECUTED');
  assert.equal(r.tier, 'COERCED');
  assert.deepEqual(r.unverified, ['active']);
  assert.match(r.detail, /outside the read-back projection/);
  // Confirmed scope is exactly the compared scope — `active` is not in it.
  assert.deepEqual(r.compared_fields, ['name']);
});

test('the compared scope carries per-field requested/actual, and equals the verified scope', () => {
  const r = assessOutcomeTier({
    requested: { name: 'x', active: 'false' },
    actual: { sys_id: 'a'.repeat(32), name: 'x', active: 'false' },
    comparedFields: ['sys_id', 'name', 'active'],
  });
  assert.equal(r.tier, 'EXECUTED');
  assert.deepEqual(r.compared_fields, ['name', 'active']);
  assert.deepEqual(r.compared_detail, [
    { field: 'name', requested: 'x', actual: 'x' },
    { field: 'active', requested: 'false', actual: 'false' },
  ]);
  assert.deepEqual(r.unverified, []);
});
