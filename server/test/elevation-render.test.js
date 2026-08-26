import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { elevationOutcome } from '../../client/src/components/elevationOutcome.js';

/**
 * WI-4 — the elevation renderer is honest. Its visual state is a PURE function
 * of WI-3's honest result object, so it is proven here at the unit level with a
 * fixture per state — including a hostile fixture (non-EXECUTED tier carrying a
 * truthy sys_id and a 200) that MUST render non-green. The M3/renderer class is
 * "green from a soft signal instead of proven effect"; these tests are the wall.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const agentChat = fs.readFileSync(path.resolve(here, '../../client/src/pages/AgentChat.jsx'), 'utf8');
const outcomeSrc = fs.readFileSync(path.resolve(here, '../../client/src/components/elevationOutcome.js'), 'utf8');

/* ------------------------------------------------------------------ *
 * INVARIANT — green ⟺ tier === EXECUTED, and nothing else
 * ------------------------------------------------------------------ */

test('INVARIANT — EXECUTED is green; every other tier/state is NOT green', () => {
  const executed = elevationOutcome({
    tier: 'EXECUTED', required_role: 'security_admin', elevation_occurred: true,
    target: { table: 'sys_security_acl', sys_id: 'a'.repeat(32) },
    compared_fields: ['name', 'active'],
    compared_detail: [{ field: 'name', requested: 'x', actual: 'x' }, { field: 'active', requested: 'false', actual: 'false' }],
  });
  assert.equal(executed.green, true);
  assert.equal(executed.tone, 'ok');
  assert.equal(executed.confirmedFields.length, 2);

  for (const e of [
    { tier: 'COERCED', mismatches: [{ field: 'active', requested: 'false', actual: 'true' }] },
    { tier: 'FAILED' },
    { state: 'REFUSED', required_role: 'security_admin' },
    { state: 'FAIL_CLOSED', required_role: 'security_admin' },
    { state: 'DENIED', required_role: 'security_admin' },
  ]) {
    assert.equal(elevationOutcome(e).green, false, `${e.tier || e.state} must not be green`);
  }
});

test('INVARIANT (hostile) — a non-EXECUTED tier carrying a truthy sys_id and a 200 renders NON-GREEN', () => {
  // The M3 trap made concrete: everything a naive renderer would read as success
  // is present — a real sys_id, an OK status — but the tier is FAILED.
  const hostile = elevationOutcome({
    tier: 'FAILED',
    target: { table: 'sys_security_acl', sys_id: 'deadbeefdeadbeefdeadbeefdeadbeef' },
    http_status: 200, isError: false, approved: true, elevation_occurred: true,
  });
  assert.equal(hostile.green, false, 'a sys_id + 200 must never produce green — only tier === EXECUTED does');
  assert.equal(hostile.tone, 'bad');

  // Same trap on COERCED: landed with a sys_id, but a field differs.
  const coercedHostile = elevationOutcome({ tier: 'COERCED', target: { sys_id: 'a'.repeat(32) }, mismatches: [{ field: 'active', requested: 'false', actual: 'true' }] });
  assert.equal(coercedHostile.green, false);
});

test('INVARIANT (source) — green: true appears exactly once in the outcome, inside the EXECUTED branch', () => {
  const greens = outcomeSrc.match(/green:\s*true/g) || [];
  assert.equal(greens.length, 1, 'green must be settable from exactly one place');
  assert.match(outcomeSrc, /tier === 'EXECUTED'[\s\S]{0,400}green:\s*true/, 'the one green:true must be in the EXECUTED branch');
  // The decision never consults a status/sys_id/approval soft signal.
  const decisionRegion = outcomeSrc;
  assert.ok(!/green:\s*(http|status|sys_id|isError|approved)/.test(decisionRegion));
});

/* ------------------------------------------------------------------ *
 * INVARIANT — COERCED is loud and shows the diff
 * ------------------------------------------------------------------ */

test('INVARIANT — COERCED is loud (amber), shows the per-field diff, and is never collapsed into success', () => {
  const o = elevationOutcome({
    tier: 'COERCED', required_role: 'security_admin', target: { table: 'sys_security_acl', sys_id: 'a'.repeat(32) },
    mismatches: [{ field: 'active', requested: 'false', actual: 'true' }],
    coerced: [{ field: 'description', requested: 'mine', actual: 'platform text' }],
  });
  assert.equal(o.green, false);
  assert.equal(o.tone, 'warn');
  assert.equal(o.badgeClass, 'amber');
  assert.equal(o.showDiff, true);
  const fields = o.diffs.map((d) => d.field);
  assert.ok(fields.includes('active') && fields.includes('description'), 'every diverging field is shown');
  assert.ok(o.confirmedFields.length === 0, 'COERCED must not present a confirmed-field list');
});

/* ------------------------------------------------------------------ *
 * INVARIANT — FAILED is honest, reason-free when unknown
 * ------------------------------------------------------------------ */

test('INVARIANT — FAILED never fabricates a reason; with no detail the reason is null', () => {
  const noReason = elevationOutcome({ tier: 'FAILED', target: { table: 'sys_security_acl', sys_id: null } });
  assert.equal(noReason.green, false);
  assert.equal(noReason.tone, 'bad');
  assert.equal(noReason.reason, null, 'no invented cause when none is known');
  assert.match(noReason.headline, /did not land/);

  const withReason = elevationOutcome({ tier: 'FAILED', detail: 'the target record is not present' });
  assert.equal(withReason.reason, 'the target record is not present');
});

/* ------------------------------------------------------------------ *
 * INVARIANT — confirmed scope = compared scope (frontend half)
 * ------------------------------------------------------------------ */

test('INVARIANT — the renderer confirms ONLY the compared fields, never one it did not verify', () => {
  // compared_detail names name+active; the renderer must confirm exactly those.
  const o = elevationOutcome({
    tier: 'EXECUTED', required_role: 'security_admin', target: { sys_id: 'a'.repeat(32) },
    compared_fields: ['name', 'active'],
    compared_detail: [{ field: 'name', requested: 'x', actual: 'x' }, { field: 'active', requested: 'false', actual: 'false' }],
  });
  assert.deepEqual(o.confirmedFields.map((f) => f.field), ['name', 'active']);

  // A COERCED whose unverified field was outside the projection shows it as
  // unverified in the diff, and NEVER as a confirmed field.
  const u = elevationOutcome({ tier: 'COERCED', unverified: ['admin_overrides'], compared_detail: [{ field: 'name', requested: 'x', actual: 'x' }] });
  assert.equal(u.confirmedFields.length, 0);
  assert.ok(u.diffs.some((d) => d.field === 'admin_overrides'), 'the unverified field is surfaced, not hidden');
});

/* ------------------------------------------------------------------ *
 * INVARIANT — each pre-write state renders distinctly and truthfully
 * ------------------------------------------------------------------ */

test('INVARIANT — REFUSED / FAIL_CLOSED / DENIED are distinct, and none is success or generic error', () => {
  const refused = elevationOutcome({ state: 'REFUSED', required_role: 'security_admin', reason: 'not assigned' });
  const failClosed = elevationOutcome({ state: 'FAIL_CLOSED', required_role: 'security_admin' });
  const denied = elevationOutcome({ state: 'DENIED', required_role: 'security_admin' });

  // All non-green, all distinct labels/tones.
  for (const o of [refused, failClosed, denied]) assert.equal(o.green, false);
  const labels = new Set([refused.label, failClosed.label, denied.label]);
  assert.equal(labels.size, 3, 'the three pre-write states must read differently');

  assert.match(refused.headline, /not eligible|needs security_admin/i);
  assert.match(refused.headline, /[Nn]othing was elevated/);
  assert.match(failClosed.headline, /could not be verified|fail-closed/i);
  assert.match(denied.headline, /declined/i);
  assert.equal(denied.tone, 'neutral', 'a user decline is not an error');
});

/* ------------------------------------------------------------------ *
 * Regression guards — the two prior renderer fixes must not recur
 * ------------------------------------------------------------------ */

test('WIRING — AgentChat renders the elevation bubble solely from elevationOutcome', () => {
  assert.match(agentChat, /import \{ elevationOutcome \}/, 'AgentChat imports the pure outcome function');
  assert.match(agentChat, /const o = elevationOutcome\(m\.elevation\)/, 'the bubble derives its state from elevationOutcome');
  // Green glyph (`dot on`) is gated on o.green only.
  assert.match(agentChat, /dot \$\{o\.green \? 'on' : ''\}/, 'the green dot is reachable only from o.green');
  // The M3 guard: the elevation bubble must not derive its glyph from isError/status.
  const elevStart = agentChat.indexOf("m.kind === 'elevation'");
  const bubbleRaw = agentChat.slice(elevStart, agentChat.indexOf("m.kind === 'tool'", elevStart));
  const bubble = bubbleRaw.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/m\.status|isError/.test(bubble), 'the elevation bubble must not read status/isError for its glyph');
});

test('NO BLANK BUBBLE — the elevation bubble renders its headline as content, and events push it', () => {
  const elevStart = agentChat.indexOf("m.kind === 'elevation'");
  const bubble = agentChat.slice(elevStart, agentChat.indexOf("m.kind === 'tool'", elevStart));
  assert.match(bubble, /\{o\.headline\}/, 'the bubble must render its headline (no blank bubble / prop-mismatch class)');
  // Both event paths route an elevation object to a kind:'elevation' message.
  assert.match(agentChat, /if \(evt\.elevation\)[\s\S]{0,120}kind: 'elevation'/, 'tool_result/tool_blocked push an elevation bubble');
});
