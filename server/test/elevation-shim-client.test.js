import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveElevationOp,
  isGatedDescriptor,
  planElevation,
  buildElevationApprovalPayload,
  buildTaggedCreatePayload,
  executeGatedWrite,
  runGatedWrite,
} from '../src/servicenow/elevation-shim-client.js';
import { NONCE_FIELD } from '../src/servicenow/elevation-shim.js';
import { TOOLS } from '../src/agent/tools.js';

/**
 * WI-3 — the gated pipeline that makes the shim reachable from the agent, and
 * the invariants that keep it the ONLY route to elevation. Everything here is
 * offline: preDecision and the shim dispatch are injected. The EXECUTED live
 * paths are in docs/role-elevation-wi3-result.md.
 */

const RUNNER = '6816f79cc0a8016401c5a33be04be441';
const ACL_CREATE = { table: 'sys_security_acl', operation: 'insert', requested: { name: 'x_nha_wi3_probe', active: 'false' }, sys_id: null };

/* mock preDecision keyed by decision */
const mkPre = (over = {}) => async ({ table, operation }) => ({
  op: { table, operation }, gated: true, required_role: 'security_admin',
  eligible: over.eligible ?? true, reason: over.reason ?? null,
  decision: over.decision ?? 'elevate',
  precheck: over.precheck ?? { eligible: over.eligible ?? true, branch: 'eligible', runner_assigned: true, role_is_elevated_privilege: true },
});
const ungatedPre = async ({ table, operation }) => ({ op: { table, operation }, gated: false, required_role: null, eligible: true, reason: null, decision: 'no_elevation_needed', precheck: null });

/* a dispatch spy: records whether the shim was called, returns a chosen outcome */
function dispatchSpy(outcome) {
  const calls = [];
  const fn = async (args) => { calls.push(args); return { dispatched: true, job: 'j', nonce: args.nonce, outcome, actual: outcome.landed ? { sys_id: 'a'.repeat(32) } : null }; };
  fn.calls = calls;
  return fn;
}

/* ------------------------------------------------------------------ *
 * INVARIANT — (table, op) derived mechanically, not LLM-massaged
 * ------------------------------------------------------------------ */

test('INVARIANT — the op is derived mechanically from the descriptor (insert -> create)', () => {
  assert.deepEqual(deriveElevationOp(ACL_CREATE), { table: 'sys_security_acl', operation: 'create' });
  assert.deepEqual(deriveElevationOp({ table: 'sys_security_acl', operation: 'delete' }), { table: 'sys_security_acl', operation: 'delete' });
  assert.equal(deriveElevationOp({ table: 'bad table', operation: 'insert' }), null);
  assert.equal(deriveElevationOp(null), null);
  // Deterministic: same descriptor, same op, no side effects.
  assert.deepEqual(deriveElevationOp(ACL_CREATE), deriveElevationOp(ACL_CREATE));
  assert.equal(isGatedDescriptor(ACL_CREATE), true);
  assert.equal(isGatedDescriptor({ table: 'incident', operation: 'update' }), false);
});

test('INVARIANT — no LLM in the client path', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/servicenow/elevation-shim-client.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join('\n');
  assert.ok(!/providers\/|chatOnce/.test(code), 'the client must not touch a model provider');
});

/* ------------------------------------------------------------------ *
 * INVARIANT — no model-exposed elevate verb
 * ------------------------------------------------------------------ */

test('INVARIANT — there is NO model-callable elevate/shim tool', () => {
  for (const t of TOOLS) {
    assert.ok(!/elev|shim/i.test(t.name), `tool ${t.name} must not expose elevation to the model`);
  }
  const names = TOOLS.map((t) => t.name);
  assert.ok(!names.includes('run_elevation_shim') && !names.includes('elevate'));
});

/* ------------------------------------------------------------------ *
 * INVARIANT — fail-closed on eligibility-read error for gated ops
 * ------------------------------------------------------------------ */

test('INVARIANT — a gated op whose eligibility read THROWS is fail-closed (blocked_read_failed)', async () => {
  const plan = await planElevation({
    descriptor: ACL_CREATE, runnerUserSysId: RUNNER,
    _preDecision: async () => { throw new Error('instance unreachable'); },
  });
  assert.equal(plan.gated, true);
  assert.equal(plan.decision, 'blocked_read_failed');
  assert.match(plan.reason, /eligibility_read_failed/);
  // And runGatedWrite refuses without ever asking for approval or dispatching.
  const spy = dispatchSpy({ tier: 'EXECUTED', landed: true });
  let approvalAsked = false;
  const r = await runGatedWrite({
    descriptor: ACL_CREATE, runnerUserSysId: RUNNER,
    requestApproval: async () => { approvalAsked = true; return { approved: true }; },
    _preDecision: async () => { throw new Error('instance unreachable'); },
    _dispatch: spy,
  });
  assert.equal(r.refused, true);
  assert.equal(r.wrote, false);
  assert.equal(approvalAsked, false, 'fail-closed must not even ask for approval');
  assert.equal(spy.calls.length, 0, 'the shim must never be dispatched');
});

/* ------------------------------------------------------------------ *
 * INVARIANT — ineligible => refuse before approval, no shim
 * ------------------------------------------------------------------ */

test('INVARIANT — an ineligible plan refuses before approval; the shim is never called', async () => {
  const spy = dispatchSpy({ tier: 'EXECUTED', landed: true });
  let approvalAsked = false;
  const r = await runGatedWrite({
    descriptor: ACL_CREATE, runnerUserSysId: RUNNER,
    requestApproval: async () => { approvalAsked = true; return { approved: true }; },
    _preDecision: mkPre({ decision: 'refuse', eligible: false, reason: 'runner is not assigned security_admin' }),
    _dispatch: spy,
  });
  assert.equal(r.decision, 'refuse');
  assert.equal(r.refused, true);
  assert.equal(r.wrote, false);
  assert.equal(approvalAsked, false);
  assert.equal(spy.calls.length, 0);
});

/* ------------------------------------------------------------------ *
 * INVARIANT — approval before any elevation/write; deny => nothing
 * ------------------------------------------------------------------ */

test('INVARIANT — deny at the gate => nothing elevated, nothing written', async () => {
  const spy = dispatchSpy({ tier: 'EXECUTED', landed: true });
  const r = await runGatedWrite({
    descriptor: ACL_CREATE, runnerUserSysId: RUNNER,
    requestApproval: async () => ({ approved: false, source: 'user_click' }),
    _preDecision: mkPre(), _dispatch: spy,
  });
  assert.equal(r.decision, 'denied');
  assert.equal(r.approved, false);
  assert.equal(r.wrote, false);
  assert.equal(r.elevated, false);
  assert.equal(spy.calls.length, 0, 'the shim must never run on a deny');
});

test('INVARIANT — the shim is dispatched only AFTER approval returns approved', async () => {
  const order = [];
  const spy = async (args) => { order.push('dispatch'); return { dispatched: true, job: 'j', nonce: args.nonce, outcome: { tier: 'EXECUTED', landed: true, sys_id: 'a'.repeat(32) }, actual: { sys_id: 'a'.repeat(32) } }; };
  const r = await runGatedWrite({
    descriptor: ACL_CREATE, runnerUserSysId: RUNNER,
    requestApproval: async (p) => { order.push('approval'); assert.equal(p.will_elevate, true); assert.equal(p.required_role, 'security_admin'); return { approved: true, source: 'user_click', at: 't' }; },
    _preDecision: mkPre(), _dispatch: spy,
  });
  assert.deepEqual(order, ['approval', 'dispatch'], 'approval must precede dispatch');
  assert.equal(r.wrote, true);
  assert.equal(r.elevated, true);
  assert.equal(r.ingestionTier, 'elevated-path');
});

/* ------------------------------------------------------------------ *
 * INVARIANT — truth = target read-back; COERCED/FAILED honest
 * ------------------------------------------------------------------ */

test('INVARIANT — the tier comes from the target read-back (EXECUTED/COERCED/FAILED)', async () => {
  const executed = await runGatedWrite({ descriptor: ACL_CREATE, runnerUserSysId: RUNNER, requestApproval: async () => ({ approved: true, source: 'user_click' }), _preDecision: mkPre(), _dispatch: dispatchSpy({ tier: 'EXECUTED', landed: true, sys_id: 'a'.repeat(32) }) });
  assert.equal(executed.outcome.tier, 'EXECUTED');

  const failed = await runGatedWrite({ descriptor: ACL_CREATE, runnerUserSysId: RUNNER, requestApproval: async () => ({ approved: true, source: 'user_click' }), _preDecision: mkPre(), _dispatch: dispatchSpy({ tier: 'FAILED', landed: false }) });
  assert.equal(failed.outcome.tier, 'FAILED');
  assert.equal(failed.wrote, false, 'absence is never painted as a write');

  const coerced = await runGatedWrite({ descriptor: ACL_CREATE, runnerUserSysId: RUNNER, requestApproval: async () => ({ approved: true, source: 'user_click' }), _preDecision: mkPre(), _dispatch: dispatchSpy({ tier: 'COERCED', landed: true, mismatches: [{ field: 'active', requested: 'false', actual: 'true' }] }) });
  assert.equal(coerced.outcome.tier, 'COERCED');
});

/* ------------------------------------------------------------------ *
 * INVARIANT — no un-elevated revert on a failure path
 * ------------------------------------------------------------------ */

test('INVARIANT — a FAILED/COERCED outcome triggers NO revert; the client only reports', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/servicenow/elevation-shim-client.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\*|^\s*\/\*|^\s*\/\//.test(l)).join('\n');
  // No delete/remove/deleteRecord anywhere in the client — it never undoes.
  assert.ok(!/\.remove\(|deleteRecord|\.delete\(/.test(code), 'the client must not delete/revert anything');
  // A FAILED outcome returns wrote:false and stops.
  const r = await runGatedWrite({ descriptor: ACL_CREATE, runnerUserSysId: RUNNER, requestApproval: async () => ({ approved: true, source: 'user_click' }), _preDecision: mkPre(), _dispatch: dispatchSpy({ tier: 'FAILED', landed: false }) });
  assert.equal(r.wrote, false);
});

/* ------------------------------------------------------------------ *
 * ungated + update/delete scope
 * ------------------------------------------------------------------ */

test('an ungated op returns gated:false and the caller uses the normal path (no shim)', async () => {
  const spy = dispatchSpy({ tier: 'EXECUTED', landed: true });
  const r = await runGatedWrite({ descriptor: { table: 'incident', operation: 'update', requested: { state: '2' }, sys_id: 'a'.repeat(32) }, runnerUserSysId: RUNNER, requestApproval: async () => ({ approved: true }), _preDecision: ungatedPre, _dispatch: spy });
  assert.equal(r.gated, false);
  assert.equal(spy.calls.length, 0);
});

test('a gated UPDATE/DELETE reaches the gate but the elevated write is fail-closed not-implemented in WI-3', async () => {
  const r = await executeGatedWrite({ descriptor: { table: 'sys_security_acl', operation: 'delete', requested: {}, sys_id: 'a'.repeat(32) }, runnerUserSysId: RUNNER, requiredRole: 'security_admin', nonce: 'a'.repeat(32) });
  assert.equal(r.wrote, false);
  assert.equal(r.not_implemented, true);
  assert.match(r.outcome.detail, /forward create only/);
});

/* ------------------------------------------------------------------ *
 * enrichment + tagging
 * ------------------------------------------------------------------ */

test('the approval payload names the op, target, role, elevation intent and eligibility', () => {
  const plan = { op: { table: 'sys_security_acl', operation: 'create' }, requiredRole: 'security_admin', eligibility: { eligible: true, branch: 'eligible', runner_assigned: true, role_is_elevated_privilege: true } };
  const p = buildElevationApprovalPayload({ plan, descriptor: { table: 'sys_security_acl', sys_id: null } });
  assert.equal(p.kind, 'role_elevation');
  assert.equal(p.high_risk, true);
  assert.equal(p.required_role, 'security_admin');
  assert.equal(p.will_elevate, true);
  assert.equal(p.eligibility.eligible, true);
});

test('the create payload is tagged with the nonce in the read-back field, preserving the request', () => {
  const tagged = buildTaggedCreatePayload({ requested: { name: 'x', description: 'mine' }, nonce: 'a'.repeat(32) });
  assert.equal(tagged.name, 'x');
  assert.match(tagged[NONCE_FIELD], /mine \[nha-elev:a{32}\]/);
});

/* ------------------------------------------------------------------ *
 * Orchestrator wiring — structural guarantees (the model cannot bypass)
 * ------------------------------------------------------------------ */

test('WIRING — the orchestrator routes gated descriptors through the elevation gate before the permission gate', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/agent/orchestrator.js', import.meta.url), 'utf8');
  // The gated interception exists and calls the client's runGatedWrite via handleGatedElevation.
  assert.match(src, /isGatedDescriptor\(guardDescriptor\)/, 'gated descriptors are detected in the loop');
  assert.match(src, /handleGatedElevation\(/, 'gated ops are routed to the elevation handler');
  assert.match(src, /runGatedWrite\(/, 'the handler drives the client pipeline');
  // Ordering: the elevation interception (with its `continue`) must come BEFORE
  // the normal permission gate, so a gated op never reaches the plain executeTool path.
  const gateAt = src.indexOf('isGatedDescriptor(guardDescriptor)');
  const permAt = src.indexOf('Permission gate — the heart');
  assert.ok(gateAt > 0 && permAt > gateAt, 'the elevation gate must precede the normal permission gate');
});

test('WIRING — the shim client is the ONLY importer of the shim executor in the agent path', async () => {
  const { readFile } = await import('node:fs/promises');
  const orch = await readFile(new URL('../src/agent/orchestrator.js', import.meta.url), 'utf8');
  // The orchestrator reaches elevation only through the client, never the raw shim.
  assert.ok(!/from '\.\.\/servicenow\/elevation-shim\.js'/.test(orch), 'the orchestrator must not import the raw shim executor directly');
  assert.match(orch, /from '\.\.\/servicenow\/elevation-shim-client\.js'/, 'the orchestrator reaches elevation only through the client');
});
