import test from 'node:test';
import assert from 'node:assert/strict';

import { validateScriptSyntax, wrapWithSentinel, mintSentinel, LIVENESS } from '../src/servicenow/script-liveness.js';
import { buildElevationBody } from '../src/servicenow/role-elevation.js';
import {
  SHIM_MARKER,
  PROBE_ACL_NAME,
  mintCorrelationId,
  buildBoundedAclOpSource,
  buildShimBody,
  buildProbeAclPayload,
  parseShimVerdict,
  assessShim,
  runElevationShim,
} from '../src/servicenow/elevation-shim.js';

/**
 * WI-1 — everything provable about the elevation shim without an instance.
 *
 * The EXECUTED proof (an elevated GlideRecordSecure write landing and reading
 * back via NHA's real trigger path, the verdict returned by nonce) is recorded
 * in docs/role-elevation-wi1-result.md. What this file guards is that the
 * generated shim can never silently regress into the shapes Gate 0 measured as
 * dangerous: a plain-GlideRecord write on the gated path, trusting insert()/
 * canCreate() over read-back, a REST runner check that always false-negatives,
 * or a session left elevated. Each invariant names its test here.
 */

const RUNNER = '6816f79cc0a8016401c5a33be04be441';
const CID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ROLE = 'security_admin';

function shimBody(overrides = {}) {
  const marker = overrides.marker ?? 'wi1_m';
  const payload = overrides.payload ?? buildProbeAclPayload({ marker });
  return buildShimBody({
    role: overrides.role ?? ROLE,
    runnerUserSysId: overrides.runnerUserSysId ?? RUNNER,
    payload,
    marker,
    correlationId: overrides.correlationId ?? CID,
    target: overrides.target ?? { table: 'sys_security_acl', operation: 'create' },
  });
}

function assertDispatchable(body, label) {
  const wrapped = wrapWithSentinel({ body, sentinel: mintSentinel(), marker: SHIM_MARKER });
  const v = validateScriptSyntax(wrapped);
  assert.equal(v.ok, true, `${label} must validate: ${JSON.stringify(v.errors)}`);
}

/* ---- dispatchability: the body survives the pre-dispatch nets ---- */

test('the shim body, the bounded op, and the probe payload are all dispatchable', () => {
  assertDispatchable(shimBody(), 'shim body');
  assertDispatchable(buildBoundedAclOpSource({ payload: buildProbeAclPayload({ marker: 'm' }), marker: 'm' }), 'bounded op');
});

/* ---- INVARIANT 1: GlideRecordSecure-only on the gated write ---- */

test('INVARIANT 1 — the gated write is GlideRecordSecure ONLY; a plain GlideRecord insert on sys_security_acl is banned', () => {
  const body = shimBody();
  // The gated mutation exists and is secure.
  assert.match(body, /new GlideRecordSecure\('sys_security_acl'\)/, 'the write must go through GlideRecordSecure');
  // Gate 0 B1a: a plain GlideRecord insert into this table persists un-elevated,
  // which would make elevation decorative. It must never appear on the gated path.
  assert.ok(
    !/new GlideRecord\('sys_security_acl'\)[\s\S]{0,400}\.insert\(\)/.test(body),
    'sys_security_acl must only ever be INSERTED through GlideRecordSecure — the M3/renderer-dishonesty class',
  );
  // The module source itself carries the same guarantee, comments aside.
  return import('node:fs/promises').then(async ({ readFile }) => {
    const src = await readFile(new URL('../src/servicenow/elevation-shim.js', import.meta.url), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join('\n');
    assert.ok(
      !/new GlideRecord\('sys_security_acl'\)[\s\S]{0,400}\.insert\(\)/.test(code),
      'no fallback to a plain GlideRecord insert anywhere in the module',
    );
  });
});

/* ---- INVARIANT 2: truth-assert on gs.hasRole immediately before the write ---- */

test('INVARIANT 2 — elevation is asserted on gs.hasRole, and the assert precedes the gated write', () => {
  const body = shimBody();
  // The proven lifecycle is embedded verbatim, so its gs.hasRole assert is present.
  assert.ok(body.includes('ELEVATION_ASSERT_FAILED'), 'the elevation assert must be present');
  const assertAt = body.indexOf('ELEVATION_ASSERT_FAILED');
  const writeAt = body.indexOf('w.insert()');
  assert.ok(assertAt > 0 && writeAt > assertAt, 'the write must come AFTER the gs.hasRole assertion');
  // And it asserts the true seam (gs.hasRole), never gs.getUser().hasRole (Gate 0 A3).
  assert.ok(!/getUser\(\)\.hasRole/.test(body), 'must not assert on gs.getUser().hasRole, which never flips');
});

test('the embedded lifecycle is the PROVEN buildElevationBody, unaltered', () => {
  // [A-trigger]: the shim reproduces Gate 0 elevation because it runs Gate 0 source.
  const marker = 'wi1_m';
  const op = buildBoundedAclOpSource({ payload: buildProbeAclPayload({ marker }), marker });
  const core = buildElevationBody({ role: ROLE, opSource: op });
  assert.ok(shimBody({ marker }).includes(core), 'the shim must embed buildElevationBody(...) verbatim');
});

/* ---- INVARIANT 3: success = read-back only ---- */

test('INVARIANT 3 — candidate_sys_id is a 32-hex insert() return AT MOST; success is read-back', () => {
  // A candidate that never reads back is not a pass.
  const candidateOnly = parseShimVerdict({
    shim: {
      correlation_id: CID, runner_has_security_admin: true, reachability_ok: true, elevation_confirmed: true,
      gr_secure_used: true, candidate_sys_id: '0123456789abcdef0123456789abcdef', insert_return: '0123456789abcdef0123456789abcdef',
      readback_confirmed: false, de_elevated: true, error: null,
    },
  });
  const a = assessShim(candidateOnly);
  assert.equal(a.passed, false);
  assert.match(a.reason, /candidate is not a write/);

  // The "null" string a denied secure insert returns is never a candidate.
  const denied = parseShimVerdict({
    shim: {
      correlation_id: CID, runner_has_security_admin: true, reachability_ok: true, elevation_confirmed: true,
      gr_secure_used: true, candidate_sys_id: 'null', insert_return: 'null', readback_confirmed: false, de_elevated: true,
    },
  });
  assert.equal(denied.candidate_sys_id, null, '"null" must not be coerced into a sys_id');
  assert.match(assessShim(denied).reason, /not a persisted row/);
});

test('the bounded op captures canCreate and insert() but the verdict never rests on them', () => {
  const body = shimBody();
  assert.match(body, /out\.shim\.can_create = probe\.canCreate\(\)/, 'canCreate is captured');
  assert.match(body, /out\.shim\.insert_return = written/, 'insert() return is captured');
  // Success in the body is set only inside the read-back branch.
  assert.match(body, /if \(rb\.get\(out\.shim\.candidate_sys_id\)\) \{\s*out\.shim\.readback_confirmed = true;/,
    'readback_confirmed is set only when the row re-reads by sys_id');
});

/* ---- INVARIANT 4: de-elevate in finally, restore-verified ---- */

test('INVARIANT 4 — de-elevation is confirmed via gs.hasRole, and assessShim requires it', () => {
  const body = shimBody();
  // The embedded lifecycle de-elevates in a finally and reads gs.hasRole back.
  assert.match(body, /disableElevatedRole\(ROLE\)/);
  assert.match(body, /deelevated_ok = \(out\.elevation\.after\.has_role === false\)/);
  // A run that never confirmed de-elevation does not pass.
  const stuck = parseShimVerdict({
    shim: {
      correlation_id: CID, runner_has_security_admin: true, reachability_ok: true, elevation_confirmed: true,
      gr_secure_used: true, candidate_sys_id: '0123456789abcdef0123456789abcdef', readback_confirmed: true, de_elevated: false,
    },
  });
  assert.match(assessShim(stuck).reason, /not confirmed de-elevated/);
});

/* ---- INVARIANT 5: the production path never deletes sys_update_xml ---- */

test('INVARIANT 5 — the shim never deletes sys_update_xml; provenance is recorded, not swept', async () => {
  const body = shimBody();
  assert.ok(!/sys_update_xml/.test(body), 'the shim body must not touch sys_update_xml');
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/servicenow/elevation-shim.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join('\n');
  assert.ok(!/sys_update_xml/.test(code), 'only the WI-1 acceptance test reverts its own probe; the shim leaves provenance alone');
});

/* ---- the runner precondition (a) ---- */

test('the runner precondition is a SERVER-SIDE sys_user_has_role read, not a REST one', () => {
  // Gate 0 A4b: the security_admin role record is invisible over REST (0 rows).
  const body = shimBody();
  assert.match(body, /new GlideRecord\('sys_user_has_role'\)/, 'the role-hold check must be a server-side GlideRecord');
  assert.match(body, /new GlideRecord\('sys_user_role'\)/, 'the role sys_id is resolved server-side by name');
  // The elevation lifecycle is gated on the precondition passing.
  const precondAt = body.indexOf("new GlideRecord('sys_user_has_role')");
  const gateAt = body.indexOf('if (__shimProceed) {');
  const enableAt = body.indexOf('enableElevatedRole(ROLE)');
  assert.ok(precondAt > 0 && gateAt > precondAt && enableAt > gateAt, 'no enableElevatedRole before the precondition gate');
});

test('a runner without the role fails loud, performs no write, and carries the spec error string', async () => {
  // The Node runner surfaces the verdict; a missing role is elevation_confirmed:false, error set.
  const missing = {
    correlation_id: CID, runner_user: RUNNER, runner_has_security_admin: false,
    reachability_ok: false, elevation_confirmed: false, gr_secure_used: false,
    candidate_sys_id: null, insert_return: null, readback_confirmed: false, de_elevated: false,
    error: 'runner lacks security_admin',
  };
  const run = async () => ({ liveness: LIVENESS.CONFIRMED, sentinel: 's', payload: { sentinel: 's', shim: missing }, detail: null });
  const r = await runElevationShim({ role: ROLE, runnerUserSysId: RUNNER, correlationId: CID, _run: run });
  assert.equal(r.assessment.passed, false);
  assert.equal(r.assessment.reason, 'runner lacks security_admin');
  assert.equal(r.verdict.candidate_sys_id, null, 'no write may be reported when the precondition failed');
});

/* ---- the reachability guard (b) ---- */

test('the reachability guard re-asserts Gate 0 A2 and gates elevation on it', () => {
  const body = shimBody();
  assert.match(body, /typeof GlideSecurityManager/, 'reachability must probe GlideSecurityManager');
  assert.match(body, /GlideSecurityManager\.get\(\)/);
  const reachAt = body.indexOf('reachability_ok = (__sm !== null)');
  const gateAt = body.indexOf('if (__shimProceed) {');
  assert.ok(reachAt > 0 && gateAt > reachAt, 'reachability is decided before the elevation gate');
});

/* ---- the result-capture contract (d) [A-result] ---- */

test('the verdict is bound to this run by an embedded correlation_id nonce, checked on read-back', async () => {
  const base = {
    runner_user: RUNNER, runner_has_security_admin: true, reachability_ok: true, elevation_confirmed: true,
    gr_secure_used: true, candidate_sys_id: '0123456789abcdef0123456789abcdef', insert_return: '0123456789abcdef0123456789abcdef',
    readback_confirmed: true, before: { existing_by_marker: 0 }, after: {}, coerced: false, de_elevated: true, error: null,
  };
  const mk = (shim) => async () => ({ liveness: LIVENESS.CONFIRMED, sentinel: 's', payload: { sentinel: 's', shim }, detail: null });

  // Nonce echoed → bound, and the whole chain passes.
  const ok = await runElevationShim({ role: ROLE, runnerUserSysId: RUNNER, correlationId: CID, _run: mk({ ...base, correlation_id: CID }) });
  assert.equal(ok.bound, true);
  assert.equal(ok.assessment.passed, true);
  assert.equal(ok.resultCapture.table, 'sys_user_preference', 'the durable result record is named explicitly');

  // Nonce NOT echoed → bound:false. The WI-1 stop rule: a foreign/stale payload
  // is not this run's verdict, and must never be reported as success.
  const foreign = await runElevationShim({ role: ROLE, runnerUserSysId: RUNNER, correlationId: CID, _run: mk({ ...base, correlation_id: 'ffffffffffffffffffffffffffffffff' }) });
  assert.equal(foreign.bound, false);
});

test('parseShimVerdict reads PER FIELD off one parsed payload — never re-parses a string', async () => {
  // Guards against reintroducing the fix/sysid-provenance whole-string JSON.parse.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/servicenow/elevation-shim.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join('\n');
  assert.ok(!/JSON\.parse/.test(code), 'the shim client must not JSON.parse — it reads fields off the harness-parsed payload');
  assert.equal(parseShimVerdict({}), null);
  assert.equal(parseShimVerdict(null), null);
  const v = parseShimVerdict({ shim: { correlation_id: CID, candidate_sys_id: 'not-hex', insert_return: 'null' } });
  assert.equal(v.candidate_sys_id, null, 'a non-hex candidate is normalised to null');
});

/* ---- input validation: configurable runner, fail-loud [A-runner] ---- */

test('the runner sys_id is required and validated; a bad one is refused loudly', () => {
  assert.throws(() => buildShimBody({ role: ROLE, runnerUserSysId: 'nope', payload: buildProbeAclPayload({ marker: 'm' }), marker: 'm', correlationId: CID }),
    /32-character hex sys_id/);
  assert.throws(() => buildShimBody({ role: ROLE, runnerUserSysId: RUNNER, payload: buildProbeAclPayload({ marker: 'm' }), marker: 'm', correlationId: 'short' }),
    /32-char hex nonce/);
  assert.throws(() => buildProbeAclPayload({ marker: '' }), /marker is required/);
  assert.throws(() => buildBoundedAclOpSource({ payload: {}, marker: '' }), /run marker is required/);
});

test('the probe ACL is inactive, role-less, on a nonexistent table, and marked for cleanup', () => {
  const p = buildProbeAclPayload({ marker: 'wi1_unique' });
  assert.equal(p.name, PROBE_ACL_NAME);
  assert.equal(p.active, 'false', 'the probe must be inactive — an active ACL on a real table is a security change');
  assert.match(p.description, /wi1_unique/, 'the marker rides the description for by-marker cleanup');
});

/* ---- INVARIANT 6 (house rule): no role name is hardcoded ---- */

test('the shim module names no role literally — security_admin is discovered and handed in', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/servicenow/elevation-shim.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join('\n');
  assert.ok(!/['"]security_admin['"]/.test(code), 'elevation-shim.js must not hardcode a role name in code');
});

/* ---- the shim stays non-callable in WI-1 ---- */

test('the shim is NOT registered as a model-callable tool in WI-1', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/agent/tools.js', import.meta.url), 'utf8');
  assert.ok(!/elevation-shim|runElevationShim|elevation_shim/.test(src),
    'WI-1 forbids wiring the shim to an agent tool — that is WI-3, behind an approval gate');
});

/* ---- the whole chain, assessed link by link ---- */

test('assessShim names the FIRST failing seam, never a bare boolean', () => {
  const full = {
    correlation_id: CID, runner_has_security_admin: true, reachability_ok: true, elevation_confirmed: true,
    gr_secure_used: true, candidate_sys_id: '0123456789abcdef0123456789abcdef', readback_confirmed: true, de_elevated: true, error: null,
  };
  assert.deepEqual(assessShim(parseShimVerdict({ shim: full })), { passed: true, reason: null });
  assert.match(assessShim(parseShimVerdict({ shim: { ...full, reachability_ok: false } })).reason, /GlideSecurityManager/);
  assert.match(assessShim(parseShimVerdict({ shim: { ...full, elevation_confirmed: false } })).reason, /gs\.hasRole did not flip/);
  assert.match(assessShim(parseShimVerdict({ shim: { ...full, gr_secure_used: false } })).reason, /GlideRecordSecure/);
  assert.equal(assessShim(null).passed, false);
});
