/**
 * PHASE 10 — THE FREEZE: adjudications that must not drift.
 *
 *   node --test server/test/
 *
 * Four decisions were taken during the release audit. Each was a judgement
 * call, each could reasonably be revisited later, and each would be easy to
 * reverse by accident. This file records the decision AND the evidence it
 * rested on, so reversing one means reading why it was made.
 *
 *   §8  the eleven unclaimed mutating tools stay unclaimed
 *   §9  the redaction boundary, including the shapes not previously tested
 *   §11 safety semantics are provider-neutral
 *   §12 prompts.js is frozen
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p10f-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const P = await import('../src/agent/plan/index.js');
const R = await import('../src/agent/recovery/index.js');
const { toolMap } = await import('../src/agent/tools.js');
const { CAPABILITIES } = await import('../src/agent/capability-discovery.js');
const { redact, findSecrets, REDACTED } = await import('../src/agent/evidence/redact.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const claimedTools = () => {
  const out = new Set();
  for (const spec of Object.values(CAPABILITIES)) for (const t of spec.tools ?? []) out.add(t);
  return out;
};
const unclaimedMutating = () => {
  const claimed = claimedTools();
  return [...toolMap.values()].filter((t) => t.mutating && !claimed.has(t.name)).map((t) => t.name).sort();
};

/* ================================================================== *
 * §8. THE ELEVEN UNCLAIMED MUTATING TOOLS
 * ================================================================== */

/*
 * THE ADJUDICATION: all eleven stay unclaimed, and the evidence is that
 * claiming them would make the system LESS conservative, not more.
 *
 * Two facts decide it.
 *
 *   THE PLANNER CANNOT NAME THEM. The prompt lists, per capability, the tools
 *   that capability declares. A tool no capability claims is never printed, so
 *   the model has never seen it. Adding one to the taxonomy would put it in
 *   front of the model — the opposite of restraint.
 *
 *   RECOVERY ALREADY REFUSES THEM. Nine of the eleven declare no
 *   `describeWrite`, so `classifyIdempotency` returns UNKNOWN, and UNKNOWN is
 *   never auto-retryable. They are already at the most restrictive setting the
 *   engine has.
 *
 * Per tool, against §8's six questions:
 *
 *   create_incident          capability record_create; mechanism rest;
 *                            elevation none; verification read_back;
 *                            idempotency NON_IDEMPOTENT (it is a create).
 *                            EVIDENCE IS SUFFICIENT — and claiming it would
 *                            only expose it to the planner for no safety gain,
 *                            since `create_record` already covers creates.
 *
 *   create_record_producer   catalog authoring, but the verification story is
 *                            the catalog module's own and is not read_back.
 *                            INSUFFICIENT.
 *   delete_live_flow         removes Fluent source, reinstalls, confirms. The
 *                            mechanism is SDK and the operation is a multi-step
 *                            build; no single descriptor describes it.
 *                            INSUFFICIENT.
 *   update_catalog_variable  updates one variable in place; no describeWrite,
 *                            so no diffable descriptor. INSUFFICIENT.
 *
 *   dba_set_field_value      Tier 1  — verifies internally, not via read_back
 *   dba_delete_record        Tier 2  — previews, then deletes
 *   dba_create_record        column-checked before the write
 *   dba_modify_field         SDK source edit + reinstall
 *   dba_drop_field           gated, asymmetric with add
 *   dba_augment_table        SDK table-augments pattern
 *                            All six verify through the DBA module's own
 *                            read-back rather than the generic pipeline, and
 *                            their mechanism is a build, not a REST call.
 *                            INSUFFICIENT for the generic taxonomy.
 *
 *   dba_execute_irreversible Tier 3. Requires a snapshot id, a typed
 *                            confirmation and an acknowledged impact — four
 *                            things no plan can supply and no tool can set.
 *                            MUST NEVER BE PLANNABLE.
 *
 * None of this is inferred from a tool's name; each rests on the tool's own
 * declared shape, checked below.
 */

test('E1 — exactly eleven mutating tools are unclaimed, and they are these eleven', () => {
  assert.deepEqual(unclaimedMutating(), [
    'create_incident',
    'create_record_producer',
    'dba_augment_table',
    'dba_create_record',
    'dba_delete_record',
    'dba_drop_field',
    'dba_execute_irreversible',
    'dba_modify_field',
    'dba_set_field_value',
    'delete_live_flow',
    'update_catalog_variable',
  ], 'the unclaimed set changed — re-run the §8 adjudication before accepting it');
});

test('E2 — none of them is ever shown to the planner', () => {
  /*
   * THE FIRST HALF OF THE ADJUDICATION. The prompt prints each capability's own
   * declared tools; a tool no capability claims appears nowhere in it.
   */
  const caps = Object.keys(CAPABILITIES).map((n) => ({
    capability: n,
    mechanism: CAPABILITIES[n].mechanism,
    verification: CAPABILITIES[n].verification,
    requiresElevation: Boolean(CAPABILITIES[n].requiresElevation),
  }));
  const prompt = P.plannerSystem({ capabilities: caps, semantics: null });
  for (const name of unclaimedMutating()) {
    assert.ok(!prompt.includes(name), `${name} is now shown to the planner`);
  }
});

test('E3 — every unclaimed tool classifies as UNKNOWN, and UNKNOWN never retries', () => {
  // THE SECOND HALF. They are already at the engine's most restrictive setting.
  for (const name of unclaimedMutating()) {
    const v = R.classifyIdempotency({ tool: name });
    assert.equal(v.idempotency, 'UNKNOWN', `${name} classifies as ${v.idempotency}`);
    assert.equal(R.isAutoRetryable(v.idempotency), false, `${name} became auto-retryable`);
  }
});

test('E4 — the reason each is unclaimed is a property of the TOOL, not its name', () => {
  // Nine of the eleven declare no `describeWrite`, which is what makes them
  // undiffable by the generic verifier and UNKNOWN to the recovery engine.
  const noDescriptor = unclaimedMutating().filter((n) => typeof toolMap.get(n).describeWrite !== 'function');
  assert.equal(noDescriptor.length, 9,
    `${noDescriptor.length} unclaimed tools lack describeWrite, not 9: ${noDescriptor.join(', ')}`);
  // The two that DO declare one are the two the adjudication called "sufficient
  // evidence, no safety gain from claiming".
  const withDescriptor = unclaimedMutating().filter((n) => typeof toolMap.get(n).describeWrite === 'function');
  assert.deepEqual(withDescriptor, ['create_incident', 'create_record_producer']);
});

test('E5 — the Tier 3 irreversible tool demands four things no plan can supply', () => {
  const t = toolMap.get('dba_execute_irreversible');
  assert.deepEqual(t.inputSchema.required.sort(),
    ['impact_acknowledged', 'operation', 'snapshot_id', 'table', 'typed_confirmation']);
  // And the Phase 10 required-inputs rule means a plan that omits any of them
  // is refused before a human is ever asked.
  const v = P.validatePlan({
    goal: 'drop the column',
    steps: [{
      id: 'step_1', operation: 'drop it', capability: 'field_create',
      tool: 'dba_execute_irreversible', mutating: true,
      target: { table: 'incident', sys_id: null },
      inputs: { operation: 'drop_column', table: 'incident' },   // three requirements missing
      depends_on: [], expected_effects: ['the column is gone'],
      verification: { strategy: 'read_back', asserts: ['the column is gone'] },
    }],
  }, {
    discover: (n) => ({
      capability: n, status: 'known', available: true, mechanism: 'sdk', mutating: true,
      verification: 'read_back', requiresVerification: true, requiresApproval: true,
      requiresElevation: false, elevationRole: null, scope: null, reason: null, note: null,
    }),
  });
  assert.equal(v.valid, false, 'a Tier 3 irreversible operation was plannable without its confirmations');
  assert.ok(v.fatal.some((p) => p.code === 'missing_required_inputs'));
});

/* ================================================================== *
 * §9. THE REDACTION BOUNDARY — including the shapes not previously tested
 * ================================================================== */

test('R1 — cookies are redacted by key', () => {
  // Not previously covered. A Set-Cookie header carries a session token.
  /*
   * The realistic HEADER keys. A cookie's own name — `JSESSIONID` — is not a
   * key in any object this system builds; it appears inside a `cookie` header's
   * value, which the entry below covers. Asserting on the cookie name would be
   * asserting against a shape that never occurs.
   */
  for (const key of ['cookie', 'Cookie', 'set-cookie', 'Set-Cookie', 'session_token', 'cookies']) {
    const out = redact({ [key]: 'glide_session=abc123; JSESSIONID=def456; path=/; HttpOnly' });
    const v = out[key];
    assert.equal(v, REDACTED, `the key "${key}" did not protect its value: ${JSON.stringify(v)}`);
  }
  // Nested and in an array, like a captured header bag.
  const bag = redact({ response: { headers: [{ 'set-cookie': 'JSESSIONID=def456' }] } });
  assert.ok(!JSON.stringify(bag).includes('def456'), 'a cookie survived inside a nested header bag');
});

test('R2 — every shape §9 names is covered, in one sweep', () => {
  const SECRET = 'PLANTED-SECRET-0123456789';
  const shared = { name: 'authorization', expected: `Basic ${SECRET}`, actual: `Basic ${SECRET}` };
  const cyclic = { label: 'root', api_key: SECRET };
  cyclic.self = cyclic;

  const planted = {
    // Authorization headers, basic and bearer
    headers: { Authorization: `Basic ${SECRET}`, 'X-Auth': `Bearer ${SECRET}` },
    // password fields
    password: SECRET,
    passwd: SECRET,
    // API keys
    api_key: SECRET,
    apiKey: SECRET,
    clientSecret: SECRET,
    // nested objects
    deep: { deeper: { deepest: { access_token: SECRET } } },
    // arrays
    list: [{ refresh_token: SECRET }, { private_key: SECRET }],
    // shared references
    assertions: [shared],
    failed_assertions: [shared],
    // cyclic structures
    cyclic,
    // and free-text carrying a serialised header
    note: `the call failed with Authorization: Basic ${SECRET}`,
  };

  const out = redact(planted);
  const blob = JSON.stringify(out);
  assert.ok(!blob.includes(SECRET), `a planted secret survived: ${blob.slice(0, 300)}`);
  assert.deepEqual(findSecrets(out), [], JSON.stringify(findSecrets(out)));

  // The shared reference is intact in BOTH places — not '[circular]'.
  assert.equal(out.assertions[0].name, 'authorization');
  assert.equal(out.failed_assertions[0].name, 'authorization');
  // The true cycle is caught.
  assert.equal(out.cyclic.self, '[circular]');
  assert.equal(out.cyclic.label, 'root');
});

test('R3 — the documented boundary holds in BOTH directions', () => {
  const SYS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  // NOT redacted — legitimate ServiceNow identifiers survive.
  assert.equal(redact({ sys_id: SYS }).sys_id, SYS);
  assert.equal(redact(`the record is ${SYS}`), `the record is ${SYS}`);
  assert.equal(redact({ number: 'INC0010001' }).number, 'INC0010001');
  assert.equal(redact({ correlation_id: SYS }).correlation_id, SYS);
  assert.equal(redact({ sys_updated_by: 'admin' }).sys_updated_by, 'admin');

  // KNOWN AND ACCEPTED LIMIT, restated so it cannot be forgotten: a secret in
  // free prose, under no recognisable key and in no auth-header shape, is not
  // detected. Broadening the value rule to catch it would match every sys_id
  // above, and an evidence layer that redacts sys_ids cannot do its job.
  const prose = redact('the operator said the password is hunter2 and left');
  assert.ok(prose.includes('hunter2'),
    'value-sniffing was broadened — check it does not now corrupt sys_ids');
});

/* ================================================================== *
 * §11. PROVIDER NEUTRALITY OF THE SAFETY SEMANTICS
 * ================================================================== */

test('N1 — no safety-critical module names a provider', () => {
  /*
   * The nine layers whose behaviour must not change with the provider. Phase 9
   * asserted this for the plan directory; this widens it to every module that
   * can decide whether something is authorised, verified or recovered.
   */
  const CRITICAL = [
    'agent/plan/executor.js', 'agent/plan/validator.js', 'agent/plan/fingerprint.js',
    'agent/plan/store.js', 'agent/plan/states.js',
    'agent/recovery/decision.js', 'agent/recovery/policy.js', 'agent/recovery/executor.js',
    'agent/recovery/idempotency.js', 'agent/recovery/classification.js', 'agent/recovery/reconcile.js',
    'agent/evidence/builder.js', 'agent/evidence/status.js', 'agent/evidence/redact.js',
    'agent/evidence/read-model.js',
    'agent/mutation-pipeline.js', 'agent/write-guard.js', 'memory/provenance.js',
    'memory/ledger.js', 'agent/capability-discovery.js',
  ];
  for (const f of CRITICAL) {
    const b = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const vendor of ['anthropic', 'openai', 'ollama', 'openrouter', 'opencode', 'gpt-', 'claude-', 'gemini']) {
      assert.ok(!new RegExp(vendor, 'i').test(b), `${f} names the provider "${vendor}"`);
    }
  }
});

test('N2 — the safety layers reach a model through the neutral gateway, or not at all', () => {
  const reachesModel = [];
  for (const f of ['agent/plan/executor.js', 'agent/plan/validator.js', 'agent/plan/fingerprint.js',
    'agent/recovery/decision.js', 'agent/recovery/executor.js', 'agent/recovery/policy.js',
    'agent/evidence/builder.js', 'agent/evidence/status.js', 'agent/mutation-pipeline.js',
    'agent/write-guard.js', 'memory/ledger.js']) {
    const src = read(f);
    if (/from\s+['"][^'"]*providers/.test(src)) reachesModel.push(f);
  }
  assert.deepEqual(reachesModel, [],
    `a safety layer imports the provider stack: ${reachesModel.join(', ')}`);
  /*
   * Only the planner does, and only through the neutral gateway. Since
   * Session 1 / WI-5 it imports `chatTurn` rather than `chatOnce`: the same
   * seam one layer down (chatOnce is a wrapper over it), for the one field
   * chatOnce discards — `stopReason` — which is how a completion cut off by
   * the budget is reported as plan_truncated instead of "not valid JSON".
   * The property this guards is unchanged: no adapter is named here.
   */
  const planner = read('agent/plan/planner.js');
  assert.match(planner, /import \{ (chatOnce|chatTurn) \} from '\.\.\/providers\/index\.js'/);
  assert.ok(!/providers\/(anthropic|openaiCompat)/.test(planner),
    'the planner imports a specific adapter');
});

test('N3 — the provider contract is one shape, and every adapter honours it', () => {
  // A single declared contract means a new adapter cannot change what the
  // safety layers above it receive.
  const contract = read('agent/providers/contract.js');
  assert.ok(contract.length > 0, 'the provider contract is gone');
  const index = read('agent/providers/index.js');
  assert.match(index, /export (async )?function chatOnce/, 'the neutral entry point is gone');
  // The adapters are selected by configuration, never by a caller.
  assert.ok(!/executeTool|resolveApproval|verifyMutation|appendMutation/.test(index),
    'the provider layer reaches a control primitive');
});

test('N4 — cancellation, fingerprint and budget are computed without a model', () => {
  // Each of these must be reproducible offline, on any machine, under any
  // provider — so none of them may consult one.
  for (const f of ['agent/plan/fingerprint.js', 'agent/plan/states.js']) {
    const b = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/chatOnce|callProvider|runTurn|fetch\(/.test(b), `${f} consults a model or the network`);
  }
  /*
   * BUDGET IS NEUTRAL RATHER THAN NETWORK-FREE, and the distinction is the
   * point. Knowing how much history fits requires the model's context window,
   * which only the provider can report — so it asks the CONFIGURED endpoint. It
   * names no vendor (N1 asserts that) and falls back to a constant when the
   * lookup fails, so budgeting never depends on the call succeeding. Demanding
   * it never touch the network would mean hard-coding a size per model, which
   * is the LESS neutral option.
   */
  const budget = read('memory/budget.js');
  assert.match(budget, /FALLBACK_CONTEXT/, 'the context lookup has no deterministic fallback');
  assert.ok(!/chatOnce|callProvider|runTurn/.test(budget.replace(/\/\*[\s\S]*?\*\//g, '')),
    'budget.js runs a model turn');

  // And the fingerprint is stable across processes: the same plan, twice.
  const plan = {
    goal: 'g',
    steps: [{
      id: 's1', operation: 'update', capability: 'record_update', tool: 'update_record',
      mechanism: 'rest', scope: null, mutating: true,
      target: { table: 'incident', sys_id: 'a'.repeat(32) },
      inputs: { table: 'incident', sys_id: 'a'.repeat(32), data: { short_description: 'x' } },
      depends_on: [], expected_effects: ['x'], verification: { strategy: 'read_back', asserts: ['ok'] },
    }],
  };
  assert.equal(P.fingerprintPlan(plan), P.fingerprintPlan(JSON.parse(JSON.stringify(plan))));
});

/* ================================================================== *
 * §12. THE PROMPT FREEZE
 * ================================================================== */

test('F1 — prompts.js is frozen: the sentinel and the operating rules are intact', () => {
  const src = read('agent/prompts.js');
  /*
   * THE FREEZE, asserted three ways.
   *
   * The content hash is the real guard. The counts below are the sentinel two
   * earlier phases carried after an incident destroyed uncommitted work in this
   * file, and they are kept because they NAME what changed when the hash moves.
   *
   * If this fails, do not update the hash. Find out what edited the file.
   */
  const sha = crypto.createHash('sha256').update(src).digest('hex').slice(0, 32);
  /*
   * SESSION 1 / WI-4 (2026-09-08) — the hash moved ONCE, deliberately, and this
   * is the record of why. Tier C of the preamble offered "Business Rule
   * fallback (create_record on sys_script) — ONLY when flow_authoring_capability
   * reports ok:false". That substituted an artifact nobody asked for, and it
   * was the only prompt text inviting a REST write around the SDK. It now says
   * flow authoring is unavailable, quotes fixes[] as the exact next action, and
   * that nothing is substituted. The 33 numbered operating rules are untouched
   * (the count below still holds). Previous value: 99585f7ee9a9f43011ba867c80765cdb.
   */
  assert.equal(sha, '0eb69ba7c29ba50deae1f27cf5f7210d',
    'prompts.js changed. The prompt is frozen: establish what edited it before touching this value.');
  assert.equal(src.split(String.fromCharCode(10)).filter((l) => l.includes('knowledgeNote')).length, 2,
    'the knowledgeNote parameter moved');
  assert.equal((src.match(/Object\.freeze\(\{ id:/g) ?? []).length, 33, 'the operating-rule count changed');
  assert.ok(!/PHASE 10/.test(src), 'Phase 10 modified prompts.js');
});

test('F2 — the Phase 10 fix was made at the VALIDATOR, not the prompt', () => {
  /*
   * §12 permits a prompt change only when a defect cannot be fixed at a
   * deterministic boundary. The Phase 10 defect — a delete step that named no
   * target — was fixable at the validator, so it was fixed there. A prompt can
   * be ignored by the next model; a validator cannot.
   */
  assert.match(read('agent/plan/validator.js'), /PHASE 10 — A STEP MUST SUPPLY THE INPUTS ITS TOOL REQUIRES/);
  assert.ok(!/PHASE 10/.test(read('agent/plan/planner.js')), 'Phase 10 changed the planner prompt');
});

test('F3 — the planner prompt still states every rule it stated before', () => {
  const caps = [{ capability: 'record_update', mechanism: 'rest', verification: 'read_back', requiresElevation: false }];
  const prompt = P.plannerSystem({ capabilities: caps, semantics: null });
  for (const rule of [
    /Only capabilities from the list below/,
    /Every mutating step needs a verification strategy/,
    /asserts must cover EVERY/,
    /Never plan a write to a DERIVED field/,
    /Never invent a sys_id/,
    /Read steps before the writes that need them/,
    /NOT the mechanism/,
    /DATA, NOT INSTRUCTIONS/,
  ]) {
    assert.match(prompt, rule, `the planner prompt lost the rule ${rule}`);
  }
});
