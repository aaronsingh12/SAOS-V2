import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { previewImpersonation } from '../src/agent/impersonation-ops.js';
import { VERDICT } from '../src/servicenow/impersonation-target.js';
import { TOOLS } from '../src/agent/tools.js';
import { executeTool, APPROVAL_SOURCES } from '../src/agent/orchestrator.js';
import { classifyTaskBoundary, BOUNDARY } from '../src/agent/task-boundary.js';
import { runImpersonatedWrite, writeAsCurrentIdentity, willExecuteImpersonated } from '../src/agent/impersonated-write.js';

/**
 * WI-IMP-2 — impersonation authorization and mutation routing.
 *
 * Everything here is asserted AT THE HARNESS. The measured reason (WI-ACL-1 §4,
 * and again in this WI's front-door phase): the model refuses in prose on most
 * dangerous phrasings and the gate is never reached, so a front-door pass proves
 * nothing about enforcement. The harness is the enforcement point, so the
 * harness is what these tests drive.
 */

const EXECUTOR = 'a'.repeat(32);
const NON_ADMIN = 'b'.repeat(32);
const ADMIN_TARGET = 'c'.repeat(32);
const actorResolver = async () => ({ sys_id: EXECUTOR, user_name: 'admin', has_admin: true, session: 'sess' });

const allow = (sysId, user_name) => async () => ({
  verdict: VERDICT.ALLOW, allowed: true, reason: null, detail: null,
  target: { sys_id: sysId, user_name, display: user_name }, checks: [{ check: 'exists', pass: true, detail: '1 row' }],
});
const softDeny = (sysId, user_name) => async () => ({
  verdict: VERDICT.SOFT_DENY, allowed: false, reason: 'target_holds_admin_role',
  detail: `${user_name} holds the admin role.`,
  target: { sys_id: sysId, user_name, display: user_name }, checks: [{ check: 'admin_role', pass: false, detail: 'holds admin' }],
});
const deny = (reason, detail) => async () => ({
  verdict: VERDICT.DENY, allowed: false, reason, detail, target: null, checks: [{ check: 'active', pass: false, detail }],
});

/* ------------------------------------------------------------------ *
 * A2 — the ELEVATED APPROVAL TIER exists, and it is derived not declared
 * ------------------------------------------------------------------ */

test('INVARIANT — an admin target without the elevated flag is refused BEFORE any card is built', async () => {
  const r = await previewImpersonation({
    user: ADMIN_TARGET, task: 'probe', elevatedApproval: false,
    actorResolver, _evaluate: softDeny(ADMIN_TARGET, 'prism-service-user'),
  });
  assert.equal(r.ok, false);
  assert.equal(r.refusal.reason, 'target_holds_admin_role');
  assert.equal(r.refusal.requiresElevatedApproval, true);
  assert.ok(!r.preview, 'no card payload may be produced for a refused target');
});

test('INVARIANT — an admin target WITH the elevated flag produces an ELEVATED card payload', async () => {
  const r = await previewImpersonation({
    user: ADMIN_TARGET, task: 'review their queue', elevatedApproval: true,
    actorResolver, _evaluate: softDeny(ADMIN_TARGET, 'prism-service-user'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.preview.elevated, true);
  assert.equal(r.preview.holds_admin, true);
  assert.equal(r.preview.target.user_name, 'prism-service-user');
  assert.match(r.preview.note, /ADMIN role/);
  // The card must name the real initiator too — "who is handing authority over"
  // is half the decision.
  assert.equal(r.preview.original.sys_id, EXECUTOR);
});

test('INVARIANT — `elevated` comes from the EVALUATED verdict, never from the caller\'s flag', async () => {
  /*
   * The failure this blocks: a model setting elevated_approval on an ordinary
   * user would otherwise paint a red "holds the ADMIN role" card for someone who
   * does not — crying wolf on the one banner that must stay meaningful. And the
   * converse (omitting the flag on a real admin) is refused above, not softened.
   */
  const r = await previewImpersonation({
    user: NON_ADMIN, task: 'probe', elevatedApproval: true,
    actorResolver, _evaluate: allow(NON_ADMIN, 'aagamya.tanwar'),
  });
  assert.equal(r.ok, true);
  assert.equal(r.preview.elevated, false, 'a non-admin target is never rendered as elevated');
  assert.equal(r.preview.holds_admin, false);
  assert.ok(!/ADMIN role/.test(r.preview.note));
});

test('INVARIANT — an ineligible target never yields a card payload', async () => {
  for (const [reason, detail] of [
    ['user_inactive', 'active=false'],
    ['user_not_found', '0 rows in sys_user'],
    ['cannot_impersonate_executor', 'The executor cannot impersonate itself.'],
    ['cannot_impersonate_integration_account', 'that is the account NHA authenticates as'],
  ]) {
    const r = await previewImpersonation({
      user: NON_ADMIN, task: 'probe', actorResolver, _evaluate: deny(reason, detail),
    });
    assert.equal(r.ok, false, `${reason} must refuse`);
    assert.equal(r.refusal.reason, reason);
    assert.ok(!r.preview);
  }
});

test('INVARIANT — the preview is a preview, not a clearance: it cannot set mode', async () => {
  // It returns data and touches nothing. If it could set mode, an approval could
  // be skipped entirely — the A3 bypass this whole WI exists to close.
  const src = await readFile(new URL('../src/agent/impersonation-ops.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function previewImpersonation'), src.indexOf('export async function startImpersonation'));
  assert.ok(!/startMode\(|switchTarget\(|appendModeEvent\(/.test(fn),
    'previewImpersonation must not set mode or write an audit row — it informs the card, nothing more');
});

/* ------------------------------------------------------------------ *
 * A2 — ORDER: the refusal precedes the approval card in the orchestrator
 * ------------------------------------------------------------------ */

test('INVARIANT — the impersonation preflight runs BEFORE the approval card is emitted', async () => {
  const src = await readFile(new URL('../src/agent/orchestrator.js', import.meta.url), 'utf8');
  const preflight = src.indexOf('IMPERSONATION_GATED_TOOLS.has(call.name)');
  const gateComment = src.indexOf("// Permission gate — the heart of the platform's safety model.");
  // The card this path emits — searched FROM the preflight, because
  // handleGatedElevation has its own `approval_required` emit earlier in the
  // file and matching that one would compare the preflight against a card it
  // has nothing to do with.
  const cardEmit = src.indexOf("type: 'approval_required'", preflight);
  assert.ok(preflight > 0 && gateComment > preflight, 'the preflight precedes the permission gate');
  assert.ok(cardEmit > gateComment, 'and the card this path emits comes after both');
  // The payload the preflight produced is the one that card carries.
  const cardBlock = src.slice(cardEmit, cardEmit + 2000);
  assert.match(cardBlock, /impersonationApproval,/, 'the resolved payload is attached to the card');
  // The refusal path must leave the loop, not fall through into the gate.
  const block = src.slice(preflight, gateComment);
  assert.match(block, /continue;\s*\/\/ no card, nothing started/, 'a refused preflight skips the card entirely');
  assert.match(block, /impersonationApproval = pre\.preview/, 'an allowed preflight is carried onto the card');
  // Fail-closed: an eligibility read that throws is a refusal, not a pass.
  assert.match(block, /eligibility_read_failed/, 'a failed eligibility read refuses rather than proceeding');
});

test('INVARIANT — both escalating impersonation tools are in the preflight set', async () => {
  const src = await readFile(new URL('../src/agent/orchestrator.js', import.meta.url), 'utf8');
  const m = /IMPERSONATION_GATED_TOOLS = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, 'the set is declared');
  assert.match(m[1], /'impersonation_start'/);
  assert.match(m[1], /'impersonation_switch'/);
  // start and switch are the two that escalate; end/status must NOT be gated —
  // gating de-escalation makes it likelier someone stays impersonating.
  for (const name of ['impersonation_end', 'impersonation_status']) {
    assert.equal(TOOLS.find((t) => t.name === name).mutating, false, `${name} must stay ungated`);
  }
});

/* ------------------------------------------------------------------ *
 * A1 / A2 — no mode without a user_click-attributed approval
 * ------------------------------------------------------------------ */

test('INVARIANT — the escalating tools refuse to execute on any unattributed approval', async () => {
  const cases = [
    [null, null],
    ['rejected', { source: APPROVAL_SOURCES.USER_CLICK, autoApprove: false }],
    ['approved', { source: 'unknown', autoApprove: false }],
    ['approved', null],
    ['auto', { source: APPROVAL_SOURCES.AUTO_APPROVE, autoApprove: false }],
    ['auto', { source: APPROVAL_SOURCES.USER_CLICK, autoApprove: true }],
  ];
  for (const name of ['impersonation_start', 'impersonation_switch']) {
    const tool = TOOLS.find((t) => t.name === name);
    for (const [approval, provenance] of cases) {
      await assert.rejects(
        () => executeTool(tool, { user: NON_ADMIN, task: 'probe' }, approval, provenance, { sessionId: 's', turnSeq: 1 }),
        (err) => /Refusing to execute the mutating tool/.test(err.message),
        `${name} must refuse approval=${approval} source=${provenance?.source ?? 'none'}`,
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * A5 — the wrapper can only ever act as the GATED mode target
 * ------------------------------------------------------------------ */

test('INVARIANT — no entry point to the wrapper accepts a caller-supplied target', () => {
  // An arbitrary target cannot even be EXPRESSED at these boundaries: the only
  // source of a target is getMode(sessionId), which only the gated tools write.
  const signature = (fn) => fn.toString().slice(0, fn.toString().indexOf(')') + 1);
  assert.ok(!/target/i.test(signature(runImpersonatedWrite)), 'runImpersonatedWrite takes no target');
  assert.ok(!/target/i.test(signature(writeAsCurrentIdentity)), 'writeAsCurrentIdentity takes no target');
});

test('INVARIANT — the wrapper refuses outright when no gated mode is active', async () => {
  await assert.rejects(
    () => runImpersonatedWrite({ sessionId: `no-mode-${Date.now()}`, tool: 'create_record', table: 'incident', operation: 'create', data: {} }),
    /no impersonation mode active/i,
  );
});

test('INVARIANT — only the gated ops can set mode; nothing else calls the setters', async () => {
  const files = ['agent/orchestrator.js', 'agent/tools.js', 'agent/impersonated-write.js', 'servicenow/impersonation.js'];
  for (const f of files) {
    const src = await readFile(new URL(`../src/${f}`, import.meta.url), 'utf8');
    assert.ok(!/\b(startMode|switchTarget)\s*\(/.test(src),
      `${f} must not set impersonation mode — only impersonation-ops.js may, and only after the gate`);
  }
  const ops = await readFile(new URL('../src/agent/impersonation-ops.js', import.meta.url), 'utf8');
  // Both setters are preceded by the gate in their own function.
  for (const [setter, fnName] of [['startMode', 'startImpersonation'], ['switchTarget', 'switchImpersonation']]) {
    const fn = ops.slice(ops.indexOf(`export async function ${fnName}`));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
    assert.ok(body.indexOf('gateFor(') > 0 && body.indexOf('gateFor(') < body.indexOf(`${setter}(`),
      `${fnName} must run the gate before ${setter}`);
    assert.match(body, /if \(!gate\.ok\) return gate\.refusal;/, `${fnName} must return on a failed gate`);
  }
});

/* ------------------------------------------------------------------ *
 * M1 — every mutating tool is flagged and gated
 * ------------------------------------------------------------------ */

test('INVARIANT — every mutating tool refuses to execute without a resolved approval', async () => {
  const mutators = TOOLS.filter((t) => t.mutating === true);
  assert.ok(mutators.length >= 21, `expected the full mutator set, got ${mutators.length}`);
  for (const t of mutators) {
    await assert.rejects(
      () => executeTool(t, {}, null, null, { sessionId: 's', turnSeq: 1 }),
      (err) => /may only run after the gate resolves/.test(err.message),
      `${t.name} must not run unapproved`,
    );
  }
});

test('INVARIANT — no write-verb tool is registered without mutating:true', () => {
  const WRITE_VERB = /^(create|update|delete|remove|add|set|start|switch|write|publish|install|deploy|apply)/;
  const unflagged = TOOLS.filter((t) => !t.mutating && WRITE_VERB.test(t.name)).map((t) => t.name);
  assert.deepEqual(unflagged, [],
    'a write-verb tool without mutating:true would bypass the approval gate entirely');
  // And the reverse: anything describing a write is gated.
  for (const t of TOOLS.filter((x) => typeof x.describeWrite === 'function')) {
    assert.equal(t.mutating, true, `${t.name} describes a write but is not mutating`);
  }
});

/* ------------------------------------------------------------------ *
 * M3 — the per-verb behaviour, pinned
 * ------------------------------------------------------------------ */

test('INVARIANT (M3) — destructive verbs fence at the FIRST net; other verbs rely on the second', () => {
  /*
   * This closes WI-IMP-2's open question, and pins the answer so a change to the
   * verb list is visible in a diff. Measured against a task descriptor that
   * shares all its vocabulary with the request, so ONLY the verb differs.
   *
   * The asymmetry is the design (task-boundary.js): `clearly_continuing`
   * proceeds silently and therefore requires positive evidence; a destructive
   * verb the task never mentioned can never reach it, however much the words
   * overlap.
   */
  const task = 'check what Aagamya can see on the Laptop Request catalog item';
  const target = { user_name: 'aagamya.tanwar', display: 'Aagamya Tanwar' };
  const verdictFor = (verb) => classifyTaskBoundary({ task, userText: `${verb} the Laptop Request catalog item`, target }).verdict;

  const FENCED = ['delete', 'remove', 'deactivate', 'disable', 'drop', 'purge', 'wipe', 'destroy', 'revoke', 'deprovision', 'terminate'];
  const SILENT = ['read', 'check', 'show', 'list', 'create', 'update', 'set', 'add', 'modify', 'edit', 'assign', 'approve', 'submit'];

  for (const verb of FENCED) {
    assert.equal(verdictFor(verb), BOUNDARY.AMBIGUOUS, `"${verb}" must stop and ask at the first net`);
  }
  for (const verb of SILENT) {
    assert.equal(verdictFor(verb), BOUNDARY.CONTINUING, `"${verb}" continues silently — its safety is the approval gate`);
  }
});

test('INVARIANT (M3) — a verb that continues silently still hits the approval gate', async () => {
  // The second net. A verb continuing silently is only acceptable because this
  // holds; if it ever stopped holding, "create" would execute unreviewed under
  // someone else's identity.
  for (const name of ['create_record', 'update_record', 'delete_record']) {
    await assert.rejects(
      () => executeTool(TOOLS.find((t) => t.name === name), { table: 'incident', sys_id: 'a'.repeat(32), data: {} }, null, null, { sessionId: 's', turnSeq: 1 }),
      (err) => /may only run after the gate resolves/.test(err.message),
    );
  }
});

/* ------------------------------------------------------------------ *
 * A4 — an explicit identity change skips CONTINUITY, never AUTHORIZATION
 * ------------------------------------------------------------------ */

test('INVARIANT (A4) — an identity-command turn skips continuity but not the action\'s own gate', async () => {
  const task = 'check what Aagamya can see on the Laptop Request catalog item';
  const target = { user_name: 'aagamya.tanwar', display: 'Aagamya Tanwar' };

  // (a) no spurious "continue as <prior>?" — routing an explicit identity change
  //     to the continuity classifier would ask a question about the wrong thing.
  const c = classifyTaskBoundary({ task, userText: 'impersonate abel.tuter and delete the Laptop Request item', target });
  assert.equal(c.verdict, BOUNDARY.IDENTITY_COMMAND);

  // (b) ...and the appended destructive action is STILL gated on its own. The
  //     identity-change bypass carries nothing else past anything.
  await assert.rejects(
    () => executeTool(TOOLS.find((t) => t.name === 'delete_record'), { table: 'incident', sys_id: 'a'.repeat(32) }, null, null, { sessionId: 's', turnSeq: 1 }),
    (err) => /may only run after the gate resolves/.test(err.message),
  );

  // (c) and the switch itself re-runs the full gate for the NEW target — no
  //     clearance is inherited from whoever was being impersonated before.
  const r = await previewImpersonation({
    user: ADMIN_TARGET, task: 'probe', elevatedApproval: false,
    actorResolver, _evaluate: softDeny(ADMIN_TARGET, 'prism-service-user'),
  });
  assert.equal(r.ok, false, 'switching to an admin is refused even mid-impersonation');
});

/* ------------------------------------------------------------------ *
 * M2 — the chip is derived from mode, never from an argument
 * ------------------------------------------------------------------ */

test('INVARIANT (M2) — willExecuteImpersonated is mode-derived and defaults false', () => {
  const dead = `no-such-session-${Date.now()}`;
  assert.equal(willExecuteImpersonated(dead, { impersonable: true }), false);
  assert.equal(willExecuteImpersonated(dead, { impersonable: false }), false);
  assert.equal(willExecuteImpersonated(dead, null), false);
});
