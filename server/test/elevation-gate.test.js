import test from 'node:test';
import assert from 'node:assert/strict';

import { validateScriptSyntax, wrapWithSentinel, mintSentinel, LIVENESS } from '../src/servicenow/script-liveness.js';
import {
  classifyRequiredRole,
  UNVERIFIED_FOLLOWUPS,
  gatedTables,
} from '../src/servicenow/required-role-classifier.js';
import {
  GATE_MARKER,
  buildEligibilitySource,
  assessEligibilityVerdict,
  eligibilityPrecheck,
  preDecision,
} from '../src/servicenow/elevation-gate.js';

/**
 * WI-2 — the deterministic, non-LLM security gate. Everything here is offline:
 * the classifier is pure, the eligibility verdict logic is pure, and the one
 * instance read (buildEligibilitySource) is asserted at the source level. The
 * EXECUTED positive/negative prechecks against the PDI are in
 * docs/role-elevation-wi2-result.md.
 */

const RUNNER = '6816f79cc0a8016401c5a33be04be441';
const ROLE = 'security_admin';

const mkRun = (eligibility, liveness = LIVENESS.CONFIRMED) => async () => ({
  liveness, sentinel: 's', detail: null, payload: { sentinel: 's', eligibility },
});

/* ------------------------------------------------------------------ *
 * INVARIANT — no LLM anywhere in classify or eligibility
 * ------------------------------------------------------------------ */

test('INVARIANT — no LLM in the classify or eligibility path', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const f of ['required-role-classifier.js', 'elevation-gate.js']) {
    const src = await readFile(new URL(`../src/servicenow/${f}`, import.meta.url), 'utf8');
    assert.ok(!/providers\//.test(src), `${f} must not import a model provider`);
    assert.ok(!/chatOnce|callModel|completion\(/.test(src), `${f} must not call an LLM`);
  }
  // The classifier is not just LLM-free — it is import-free, so it can make NO
  // call of any kind (no instance, no model). That is the strongest "pure" claim.
  const cls = await readFile(new URL('../src/servicenow/required-role-classifier.js', import.meta.url), 'utf8');
  assert.ok(!/^import\s/m.test(cls), 'the classifier must have zero imports — a pure data lookup');
});

test('the classifier is deterministic — same input, same output, no side effects', () => {
  const a = classifyRequiredRole({ table: 'sys_security_acl', operation: 'create' });
  const b = classifyRequiredRole({ table: 'sys_security_acl', operation: 'create' });
  assert.deepEqual(a, b);
  assert.throws(() => classifyRequiredRole({ table: 'not a table', operation: 'create' }), /matching \[a-z0-9_\]/);
});

/* ------------------------------------------------------------------ *
 * INVARIANT — delete is gated (WI-1 finding)
 * ------------------------------------------------------------------ */

test('INVARIANT — sys_security_acl delete classifies as requiring security_admin', () => {
  // WI-1 proved an un-elevated delete silently no-ops. Omitting delete would let
  // a revert run un-elevated and silently do nothing.
  for (const op of ['create', 'update', 'delete']) {
    const c = classifyRequiredRole({ table: 'sys_security_acl', operation: op });
    assert.equal(c.gated, true, `${op} must be gated`);
    assert.equal(c.required_role, 'security_admin');
    assert.equal(c.tier, 'EXECUTED');
  }
  assert.ok(gatedTables().includes('sys_security_acl'));
});

test('an ungated operation returns none, with no role invented', () => {
  const c = classifyRequiredRole({ table: 'incident', operation: 'update' });
  assert.equal(c.gated, false);
  assert.equal(c.required_role, null);
  assert.equal(c.tier, 'none');
});

/* ------------------------------------------------------------------ *
 * STOP RULE — [A-hss] stays inert until enumerated
 * ------------------------------------------------------------------ */

test('[A-hss] — sys_properties writes are NOT classified as gated on a guessed list', () => {
  // The stop rule: never classify property writes as gated until the HSS set is
  // measured. The follow-up is recorded, but inert.
  assert.equal(classifyRequiredRole({ table: 'sys_properties', operation: 'update' }).gated, false);
  const hss = UNVERIFIED_FOLLOWUPS.find((f) => f.table === 'sys_properties');
  assert.ok(hss, 'the follow-up must be recorded');
  assert.equal(hss.inert, true);
  assert.equal(hss.tier, 'UNVERIFIED');
  assert.match(hss.needs, /enumerate/i);
});

/* ------------------------------------------------------------------ *
 * INVARIANT — assignment read is server-side; REST-0-rows != not-assigned
 * ------------------------------------------------------------------ */

test('INVARIANT — the assignment read is server-side, and REST-0-rows is never "not assigned"', () => {
  const src = buildEligibilitySource({ userSysId: RUNNER, roleName: ROLE });
  // The read is a server-side GlideRecord on sys_user_has_role, not a REST call.
  assert.match(src, /new GlideRecord\('sys_user_has_role'\)/, 'assignment must be read server-side');
  assert.match(src, /new GlideRecord\('sys_user_role'\)/, 'the role record is read server-side (invisible over REST — H6)');
  assert.match(src, /H6/, 'the source names the H6 guard it depends on');
  // The verdict logic derives "assigned" only from the server-side payload; there
  // is no path that concludes "not assigned" from a REST 0-rows result.
  const assignedServerSide = assessEligibilityVerdict(
    { role_found: true, assigned: true, elevated_privilege: true, assignment_transport: 'server-side sys_user_has_role; NOT a REST read of the role record (Gate 0 H6)' },
    ROLE,
  );
  assert.equal(assignedServerSide.eligible, true,
    'a runner the server-side read shows assigned is eligible — even though a REST read of this role record returns 0 rows');
  assert.match(assignedServerSide.assignment_transport ?? '', /NOT a REST read/);
});

/* ------------------------------------------------------------------ *
 * INVARIANT — assigned != elevated (Check A never reads gs.hasRole)
 * ------------------------------------------------------------------ */

test('INVARIANT — eligibility uses the assignment read, NEVER gs.hasRole', () => {
  const src = buildEligibilitySource({ userSysId: RUNNER, roleName: ROLE });
  assert.ok(!/gs\.hasRole/.test(src), 'Check A must not read gs.hasRole — that is runtime session state, not eligibility');
  // "assigned" and "elevated-privilege" are distinct axes with distinct branches.
  const assignedButNotElevatable = assessEligibilityVerdict({ role_found: true, assigned: true, elevated_privilege: false }, ROLE);
  assert.equal(assignedButNotElevatable.branch, 'not_elevated_privilege');
  assert.equal(assignedButNotElevatable.runner_assigned, true);
  assert.equal(assignedButNotElevatable.role_is_elevated_privilege, false);

  const elevatableButNotAssigned = assessEligibilityVerdict({ role_found: true, assigned: false, elevated_privilege: true }, ROLE);
  assert.equal(elevatableButNotAssigned.branch, 'not_assigned');
});

test('the eligibility verdict names the FIRST failing condition, and fail-closed on no read', () => {
  assert.match(assessEligibilityVerdict({ role_found: false }, ROLE).reason, /not found server-side/);
  assert.match(assessEligibilityVerdict({ role_found: true, assigned: false, elevated_privilege: true }, ROLE).reason, /not assigned/);
  assert.match(assessEligibilityVerdict({ role_found: true, assigned: true, elevated_privilege: false }, ROLE).reason, /not an elevated-privilege role/);
  const noRead = assessEligibilityVerdict(null, ROLE);
  assert.equal(noRead.eligible, false);
  assert.equal(noRead.branch, 'no_read');
  assert.match(noRead.reason, /fail-closed/);
});

test('the eligibility source is dispatchable through the pre-dispatch nets', () => {
  const src = buildEligibilitySource({ userSysId: RUNNER, roleName: ROLE });
  const wrapped = wrapWithSentinel({ body: src, sentinel: mintSentinel(), marker: GATE_MARKER });
  assert.equal(validateScriptSyntax(wrapped).ok, true);
});

/* ------------------------------------------------------------------ *
 * INVARIANT — not-eligible => hard stop, structured, no shim, no fallback
 * ------------------------------------------------------------------ */

test('INVARIANT — an ineligible verdict produces a structured REFUSAL, not a downgraded path', async () => {
  const refuse = await preDecision({
    table: 'sys_security_acl', operation: 'delete', runnerUserSysId: RUNNER,
    _run: mkRun({ role_found: true, assigned: false, elevated_privilege: true }),
  });
  assert.equal(refuse.decision, 'refuse');
  assert.equal(refuse.eligible, false);
  assert.equal(refuse.gated, true);
  assert.equal(refuse.required_role, 'security_admin');
  assert.match(refuse.reason, /not assigned/);
});

test('WI-2 imports no shim and no LLM — it decides, it does not act', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/servicenow/elevation-gate.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join('\n');
  assert.ok(!/elevation-shim/.test(code), 'the gate must not import the shim — invocation is WI-3');
  assert.ok(!/providers\/|chatOnce/.test(code), 'the gate must not touch a model client');
});

test('the pre-decision is one structured object across all four outcomes', async () => {
  // ungated: no elevation needed, and the eligibility read is never even attempted.
  const none = await preDecision({
    table: 'incident', operation: 'update', runnerUserSysId: RUNNER,
    _run: async () => { throw new Error('ungated ops must not read the instance'); },
  });
  assert.equal(none.decision, 'no_elevation_needed');
  assert.equal(none.gated, false);
  assert.equal(none.precheck, null);

  // gated + eligible: elevate.
  const elevate = await preDecision({
    table: 'sys_security_acl', operation: 'create', runnerUserSysId: RUNNER,
    _run: mkRun({ role_found: true, assigned: true, elevated_privilege: true }),
  });
  assert.equal(elevate.decision, 'elevate');
  assert.equal(elevate.eligible, true);

  // gated + read failed: fail-closed, but distinct from a definitive refusal.
  const blocked = await preDecision({
    table: 'sys_security_acl', operation: 'update', runnerUserSysId: RUNNER,
    _run: mkRun(null, LIVENESS.FAILED_SILENT_NONEXECUTION),
  });
  assert.equal(blocked.decision, 'blocked_read_failed');
  assert.equal(blocked.eligible, false);

  // Every outcome carries the same top-level shape WI-3 consumes.
  for (const d of [none, elevate, blocked]) {
    for (const k of ['op', 'gated', 'required_role', 'eligible', 'reason', 'decision', 'classification']) {
      assert.ok(k in d, `pre-decision must always carry ${k}`);
    }
  }
});

test('eligibilityPrecheck surfaces the server-side raw alongside the verdict', async () => {
  const r = await eligibilityPrecheck({
    runnerUserSysId: RUNNER, requiredRole: ROLE,
    _run: mkRun({ role_found: true, assigned: true, elevated_privilege: true, via_direct: true, assignment_transport: 'server-side sys_user_has_role' }),
  });
  assert.equal(r.eligible, true);
  assert.equal(r.confirmed, true);
  assert.equal(r.runner_assigned, true);
  assert.equal(r.role_is_elevated_privilege, true);
  assert.ok(r.raw, 'the raw server-side read is surfaced for provenance');
  // Input validation is loud.
  await assert.rejects(() => eligibilityPrecheck({ runnerUserSysId: 'nope', requiredRole: ROLE, _run: mkRun({}) }), /32-character hex/);
});
