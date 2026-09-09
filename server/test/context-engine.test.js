/**
 * PHASE 2 — THE DYNAMIC CONTEXT ENGINE.
 *
 *   node --test server/test/
 *
 * Two things are being asserted here and they pull in opposite directions.
 *
 * The first is that the context actually got smaller, measured against the LIVE
 * registry and the LIVE prompt rather than against a number written down once.
 * Nothing here hard-codes 90 tools or 20,856 tokens: the baseline is computed
 * from the registry as it is today, so the suite keeps meaning what it says as
 * the registry grows.
 *
 * The second, and the one that matters more, is that nothing got weaker. A
 * smaller tool list is not a smaller permission. The approval gate, the write
 * guard, the provenance requirement and the read-back verifier all sit BELOW
 * this layer and are untouched by it — asserted by driving a real turn with a
 * narrowed profile and watching the gate still fire, and by walking the import
 * graph to prove the engine cannot reach any of them.
 *
 * Offline in full: no instance, no model, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-ctx-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'test' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { TOOLS, toolMap } = await import('../src/agent/tools.js');
const { buildSystemPrompt, OPERATING_RULES, ALL_RULE_IDS, renderRules } = await import('../src/agent/prompts.js');
const {
  CAPABILITIES, TOOL_CAPABILITIES, RULE_CAPABILITIES, FACT_CAPABILITIES, GLOBAL,
  expandCapabilities, IMPLIES,
} = await import('../src/agent/context-capabilities.js');
const {
  classifyRequest, selectTools, selectRuleIds, selectFactKeys, retrievalQuery,
} = await import('../src/agent/context-selection.js');
const { buildContextProfile, contextDiagnostics, widenProfile } = await import('../src/agent/context-engine.js');
const { estimateTextTokens } = await import('../src/memory/tokens.js');
const { seedLedger, listFacts, factBlock } = await import('../src/memory/facts.js');
const { _setChatTurnForTests } = await import('../src/agent/providers/index.js');
const { runTurn, resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { loadToolEvents } = await import('../src/memory/sessions.js');

seedLedger();

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const profileFor = (goal) => buildContextProfile({ goal, tools: TOOLS });
const names = (p) => new Set(p.tools.map((t) => t.name));
const schemaTokens = (tools) => estimateTextTokens(JSON.stringify(
  tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
));

/* ------------------------------------------------------------------ *
 * T1 — capability classification
 * ------------------------------------------------------------------ */

test('T1 — every tool in the LIVE registry has a deterministic classification', () => {
  // Both directions. A tool added without a classification would otherwise be
  // silently unreachable from every scoped profile, which is the exact failure
  // this map could produce and the reason it is checked against the registry
  // rather than against itself.
  const missing = TOOLS.filter((t) => !TOOL_CAPABILITIES[t.name]).map((t) => t.name);
  assert.deepEqual(missing, [], 'these tools have no capability classification');

  const registry = new Set(TOOLS.map((t) => t.name));
  const stale = Object.keys(TOOL_CAPABILITIES).filter((n) => !registry.has(n));
  assert.deepEqual(stale, [], 'these classified tools no longer exist in the registry');
});

test('T1b — every classification names capabilities the taxonomy knows', () => {
  const known = new Set(CAPABILITIES);
  for (const [tool, caps] of Object.entries(TOOL_CAPABILITIES)) {
    assert.ok(Array.isArray(caps) && caps.length, `${tool} has no capabilities`);
    for (const c of caps) assert.ok(known.has(c), `${tool} names unknown capability "${c}"`);
  }
  for (const [rule, caps] of Object.entries(RULE_CAPABILITIES)) {
    if (caps === GLOBAL) continue;
    for (const c of caps) assert.ok(known.has(c), `rule ${rule} names unknown capability "${c}"`);
  }
  for (const [key, caps] of Object.entries(FACT_CAPABILITIES)) {
    if (caps === GLOBAL) continue;
    for (const c of caps) assert.ok(known.has(c), `fact ${key} names unknown capability "${c}"`);
  }
});

test('T1c — every rule id in the prompt is addressable, and every mapping names a real rule', () => {
  const ids = new Set(ALL_RULE_IDS);
  const stale = Object.keys(RULE_CAPABILITIES).filter((id) => !ids.has(String(id)));
  assert.deepEqual(stale, [], 'these rule classifications name rules that do not exist');
  // Unmapped is legal (it means global) but is worth surfacing, because a rule
  // added without a decision is a rule nobody decided about.
  const unmapped = ALL_RULE_IDS.filter((id) => RULE_CAPABILITIES[id] === undefined);
  assert.deepEqual(unmapped, [], 'these rules have no explicit global/domain decision');
});

/* ------------------------------------------------------------------ *
 * T2 / T3 — tool filtering, and tools that belong to several capabilities
 * ------------------------------------------------------------------ */

test('T2 — a flow task does not carry the SLA, catalog or ACL mutation surface', () => {
  const p = profileFor('Create a flow: when a P1 incident is created, notify the assignment group manager');
  assert.equal(p.fallback, false);
  assert.ok(p.capabilities.includes('flow_authoring'), 'the flow request was not recognised as flow work');

  const has = names(p);
  // Present: the tools the task needs.
  for (const t of ['create_flow_live', 'design_flow_blueprint', 'verify_flow_live', 'flow_authoring_capability']) {
    assert.ok(has.has(t), `a flow task must expose ${t}`);
  }
  // Absent: other domains' authoring surfaces.
  for (const t of ['create_sla', 'verify_sla_live', 'create_acl', 'delete_acl', 'create_ui_policy',
    'add_catalog_variable', 'dba_drop_field', 'impersonation_start']) {
    assert.ok(!has.has(t), `a flow task must not carry ${t}`);
  }
  assert.ok(p.tools.length < TOOLS.length, 'nothing was excluded');
});

test('T2b — each domain keeps its own surface and drops the others', () => {
  const cases = [
    { goal: 'Create an SLA for P1 incidents with a 4 hour target', keep: ['create_sla', 'sla_meta', 'verify_sla_live'], drop: ['create_acl', 'create_flow_live', 'dba_drop_field'] },
    { goal: 'Show me the ACLs on the incident table and explain who can write', keep: ['acl_report', 'explain_acls', 'acl_diff'], drop: ['create_sla', 'create_flow_live', 'add_catalog_variable'] },
    { goal: 'Create a "Laptop Request" catalog item with 6 variables', keep: ['create_catalog_item', 'add_catalog_variable', 'create_ui_policy'], drop: ['create_sla', 'create_acl', 'create_flow_live'] },
    { goal: 'Impersonate Beth Anglin and check what she can see', keep: ['impersonation_start', 'impersonation_status'], drop: ['create_sla', 'create_acl', 'create_flow_live', 'dba_add_field'] },
    { goal: 'Add a field called warranty_expiry to the incident table', keep: ['dba_add_field', 'dba_column_route', 'dba_preflight', 'dba_analyze_impact'], drop: ['create_sla', 'create_acl', 'create_flow_live'] },
  ];
  for (const c of cases) {
    const p = profileFor(c.goal);
    assert.equal(p.fallback, false, `"${c.goal}" fell back`);
    const has = names(p);
    for (const t of c.keep) assert.ok(has.has(t), `"${c.goal}" must expose ${t}`);
    for (const t of c.drop) assert.ok(!has.has(t), `"${c.goal}" must not carry ${t}`);
  }
});

test('T3 — a tool belonging to several capabilities is reachable from each of them', () => {
  // Every multi-capability tool must be reachable from each capability it
  // claims — otherwise a classification is decorative.
  const shared = Object.entries(TOOL_CAPABILITIES).filter(([, caps]) => caps.length > 1);
  assert.ok(shared.length >= 8, `only ${shared.length} tools are shared — the taxonomy is not doing any work`);
  for (const [name, caps] of shared) {
    for (const cap of caps) {
      const picked = selectTools(TOOLS, expandCapabilities([cap])).map((t) => t.name);
      assert.ok(picked.includes(name), `${name} claims ${cap} but is unreachable from it`);
    }
  }
  // A concrete case, so the property is legible: dba_preflight serves the DBA
  // surface, impact analysis and schema authoring, and is reachable from all three.
  assert.deepEqual(TOOL_CAPABILITIES.dba_preflight, ['dba', 'impact_analysis', 'schema_authoring']);
  // And a capability that selects tools only through an implication still
  // reaches them — dependency_analysis owns no tool of its own but implies dba.
  const dep = selectTools(TOOLS, expandCapabilities(['dependency_analysis'])).map((t) => t.name);
  assert.ok(dep.includes('dba_get_references'), 'dependency_analysis cannot reach the tools that perform it');
  // And the core surface is in EVERY profile, because the operating rules
  // require it: rule 1 needs lookup_reference, rules 2 and 17 need
  // get_table_schema. A profile without them would contradict its own prompt.
  for (const cap of CAPABILITIES) {
    const picked = new Set(selectTools(TOOLS, expandCapabilities([cap])).map((t) => t.name));
    for (const t of ['get_table_schema', 'lookup_reference', 'query_records', 'get_record']) {
      assert.ok(picked.has(t), `${cap} lost the core tool ${t}`);
    }
  }
});

/* ------------------------------------------------------------------ *
 * T4 / T5 — rules
 * ------------------------------------------------------------------ */

test('T3b — a cross-cutting capability never selects another domain\'s tools', () => {
  /*
   * THE LEAK THIS PHASE GOT WRONG TWICE, made into an assertion.
   *
   * `record_mutation`, `verification`, `build` and `deployment` describe what a
   * tool does rather than where it lives. Tagged onto a domain tool they become
   * selectors, and every request that IMPLIES them drags that domain in:
   * `create_sla` appeared on an incident update (via record_mutation),
   * `verify_sla_live` on a flow task (flow_authoring implies verification), and
   * `create_flow_live` on a column change (schema_authoring implies build).
   *
   * The rule is now that only a domain selects its own tools. This fails if
   * someone tags a domain tool with a cross-cutting capability again.
   */
  const CROSS = ['record_mutation', 'verification', 'build', 'deployment',
    'schema_read', 'reference_analysis', 'dependency_analysis'];
  const GENERIC = new Set(['create_record', 'update_record', 'delete_record',
    'get_table_schema', 'lookup_table', 'lookup_reference', 'query_records', 'get_record']);
  const DOMAINS = ['incident', 'catalog', 'flow_authoring', 'sla', 'acl', 'application',
    'update_set', 'impersonation', 'dba', 'schema_authoring'];

  for (const [name, caps] of Object.entries(TOOL_CAPABILITIES)) {
    if (GENERIC.has(name) || caps.includes('core')) continue;
    const domains = caps.filter((c) => DOMAINS.includes(c));
    const cross = caps.filter((c) => CROSS.includes(c));
    if (!domains.length) continue;
    assert.deepEqual(cross, [],
      `${name} belongs to ${domains.join('/')} but is ALSO tagged ${cross.join('/')} — `
      + 'a cross-cutting tag on a domain tool leaks that domain into every request that implies it');
  }

  // And the consequence, checked end to end: no domain's authoring surface
  // appears in another domain's profile.
  const acl = new Set(selectTools(TOOLS, expandCapabilities(['acl'])).map((t) => t.name));
  for (const t of ['create_sla', 'create_flow_live', 'create_catalog_item', 'dba_add_field', 'impersonation_start']) {
    assert.ok(!acl.has(t), `an ACL profile carries ${t}`);
  }
});

test('T4 — the global safety rules survive every capability', () => {
  /*
   * The list is derived from RULE_CAPABILITIES rather than retyped, so it
   * cannot drift out of step with the classification. What is asserted is the
   * invariant: whatever is marked global is present in EVERY profile, including
   * the narrowest one this taxonomy can produce.
   */
  const globals = ALL_RULE_IDS.filter((id) => RULE_CAPABILITIES[id] === GLOBAL);
  assert.ok(globals.length >= 15, `only ${globals.length} rules are global — safety rules must not be scoped away`);

  for (const cap of CAPABILITIES) {
    const kept = new Set(selectRuleIds(ALL_RULE_IDS, expandCapabilities([cap])));
    for (const id of globals) assert.ok(kept.has(id), `capability ${cap} dropped global rule ${id}`);
  }

  // And the specific ones whose absence would be a safety regression rather
  // than a smaller prompt. Each is named with the failure it prevents.
  const mustBeGlobal = {
    1: 'never invent sys_ids',
    2: 'read the schema before writing',
    3: 'the approval gate is the confirmation',
    '3b': 'never combine a question with a tool call',
    4: 'confirm destructive actions first',
    8: 'report the sys_id back',
    17: 'a missing field means STOP AND ASK',
    18: 'an ambiguous reference may not enter a mutation',
    19: 'read the verification block before reporting',
    20: 'a dropped write means the platform overrode you',
    23: 'configuration versus data',
    24: 'never silently drop business-rule-blocked fields',
    26: 'documentation informs, never authorises',
    27: 'the precedence ladder',
  };
  for (const [id, why] of Object.entries(mustBeGlobal)) {
    assert.equal(RULE_CAPABILITIES[id], GLOBAL, `rule ${id} (${why}) must be global`);
  }
});

test('T5 — domain rules appear for their domain and nowhere else', () => {
  const rulesFor = (goal) => new Set(selectRuleIds(ALL_RULE_IDS, profileFor(goal).capabilities));

  const flow = rulesFor('Create a flow that notifies the manager on a P1 incident');
  assert.ok(flow.has('6') && flow.has('7'), 'flow rules missing from a flow task');
  assert.ok(!flow.has('13'), 'the SLA rule leaked into a flow task');
  assert.ok(!flow.has('15'), 'an ACL rule leaked into a flow task');

  const sla = rulesFor('Create an SLA for P1 incidents with a 4 hour target');
  assert.ok(sla.has('13'), 'the SLA rule is missing from an SLA task');
  assert.ok(!sla.has('15b'), 'an ACL rule leaked into an SLA task');

  const acl = rulesFor('Show me the ACLs on incident and explain who can write');
  for (const id of ['15', '15b', '15c', '15d', '15e']) {
    assert.ok(acl.has(id), `ACL rule ${id} missing from an ACL task`);
  }
  assert.ok(!acl.has('13'), 'the SLA rule leaked into an ACL task');

  const cat = rulesFor('Create a Laptop Request catalog item with variables');
  assert.ok(cat.has('5') && cat.has('14'), 'catalog rules missing from a catalog task');

  const dba = rulesFor('Add a field called warranty_expiry to the incident table');
  assert.ok(dba.has('25'), 'the column-routing rule is missing from a schema task');
});

/* ------------------------------------------------------------------ *
 * T6 — facts and traps, and the measured failure this replaces
 * ------------------------------------------------------------------ */

test('T6 — THE REGRESSION THE LEDGER COMMENT NAMES: a schema request keeps the field-write traps', () => {
  /*
   * memory/facts.js records a MEASURED failure of lexical fact selection:
   *
   *   "Add a field called warranty_expiry to the incident table" ranked two ACL
   *   traps top and surfaced none of the three field-write traps that request
   *   is actually about.
   *
   * The conclusion drawn there was that the ledger ships whole "until a
   * selector can be shown to keep the relevant fact". This is that
   * demonstration, on the same prompt, and it passes because relevance is a
   * declared property of a fact's KEY rather than a similarity score — an ACL
   * trap cannot be ranked into a schema request when nothing is ranking.
   */
  const p = profileFor('Add a field called warranty_expiry to the incident table');
  const kept = new Set(p.factKeys);

  for (const key of ['unknown-field-writes-accepted', 'rest-silently-drops-field-writes',
    'dictionary-readonly-does-not-predict-rest-writes']) {
    assert.ok(kept.has(key), `the field-write trap "${key}" was dropped from a schema request`);
  }
  for (const key of ['acl-operation-sysids-inconsistent', 'acl-name-prefix-matches-siblings',
    'admin-overrides-inverts-a-role-diff', 'acl-read-only-never-authored']) {
    assert.ok(!kept.has(key), `the ACL trap "${key}" leaked into a schema request`);
  }
});

test('T6b — unrelated traps are excluded and relevant ones remain, per domain', () => {
  const keysFor = (goal) => new Set(profileFor(goal).factKeys);

  const sla = keysFor('Create an SLA for P1 incidents with a 4 hour target');
  assert.ok(sla.has('sla-schedule-inert-without-source'), 'the load-bearing SLA trap was dropped');
  assert.ok(sla.has('task-sla-row-proves-nothing'));
  assert.ok(!sla.has('ui-policy-action-not-writable-over-rest'), 'a catalog trap leaked into an SLA task');
  assert.ok(!sla.has('impersonated-denials-are-silent'), 'an impersonation trap leaked into an SLA task');

  const flow = keysFor('Create a flow that fires when an incident is updated');
  assert.ok(flow.has('trigger-strategy-default-once'), 'the trigger_strategy trap was dropped from a flow task');
  assert.ok(flow.has('keys-ts-is-project-global'));
  assert.ok(!flow.has('acl-name-prefix-matches-siblings'));

  const imp = keysFor('Impersonate Beth Anglin and see what she can read');
  assert.ok(imp.has('plain-gliderecord-ignores-impersonation'));
  assert.ok(imp.has('impersonated-denials-are-silent'));
  assert.ok(!imp.has('contract-sla-duration-carries-days'));
});

test('T6c — the always-relevant traps survive every capability, and unclassified facts are global', () => {
  const alwaysOn = ['priority-is-calculated', 'rest-silently-drops-field-writes',
    'unknown-field-writes-accepted', 'encoded-query-silent-drop', 'lookup-contains-shadows-exact'];
  const all = listFacts().map((f) => f.key);
  for (const cap of CAPABILITIES) {
    const kept = new Set(selectFactKeys(all, expandCapabilities([cap])));
    for (const k of alwaysOn) assert.ok(kept.has(k), `capability ${cap} dropped the global trap ${k}`);
  }
  // A fact nobody classified — which is every fact a user stores at runtime
  // through remember_fact — is always sent.
  const kept = new Set(selectFactKeys([...all, 'a-fact-nobody-classified'], expandCapabilities(['acl'])));
  assert.ok(kept.has('a-fact-nobody-classified'), 'an unclassified fact was dropped');
});

test('T6d — the fact block honours the key filter and still reports truncation honestly', () => {
  const p = profileFor('Create an SLA for P1 incidents');
  const scoped = factBlock({ keys: p.factKeys });
  const whole = factBlock();
  assert.ok(scoped.length < whole.length, 'the scoped fact block is not smaller');
  assert.match(scoped, /sla-schedule-inert-without-source/);
  assert.doesNotMatch(scoped, /acl-name-prefix-matches-siblings/);
  // No filter => the previous behaviour, unchanged.
  assert.match(whole, /acl-name-prefix-matches-siblings/);
});

/* ------------------------------------------------------------------ *
 * T7 — knowledge retrieval is task-aware
 * ------------------------------------------------------------------ */

test('T7 — the retrieval query carries the capability, and stays bounded and deterministic', () => {
  const p = profileFor('Create a flow that notifies the manager');
  assert.ok(p.query.includes('Create a flow that notifies the manager'), 'the query lost the user\'s own words');
  assert.match(p.query, /flow authoring/, 'the query does not carry the capability');

  // Deterministic: same goal, same query, every time.
  assert.equal(profileFor('Create a flow that notifies the manager').query, p.query);

  // Bounded: a very long goal is clipped rather than sent whole.
  const long = 'create a flow ' + 'x'.repeat(5000);
  assert.ok(buildContextProfile({ goal: long, tools: TOOLS }).query.length < 600);

  // A fallback query is the goal alone — no invented terms.
  const fb = profileFor('hello there, can you help me');
  assert.equal(fb.fallback, true);
  assert.equal(fb.query, 'hello there, can you help me');
});

/* ------------------------------------------------------------------ *
 * T8 — the fallback
 * ------------------------------------------------------------------ */

test('T8 — an unrecognised request falls back to the whole surface, and says why', () => {
  for (const goal of ['hello there, can you help me with something', 'what do you think about that', 'ok']) {
    const p = buildContextProfile({ goal, tools: TOOLS });
    assert.equal(p.fallback, true, `"${goal}" was classified rather than falling back`);
    assert.equal(p.capabilities, null, 'a fallback invented a capability');
    assert.equal(p.tools.length, TOOLS.length, 'a fallback did not expose every tool');
    assert.equal(p.ruleIds, null, 'a fallback scoped the rules');
    assert.equal(p.factKeys, null, 'a fallback scoped the ledger');
    assert.ok(['no_signal', 'request_too_short'].includes(p.fallbackReason), `unexpected reason ${p.fallbackReason}`);
  }
});

test('T8b — the fallback is OBSERVABLE, and a fallback prompt equals the pre-Phase-2 prompt', () => {
  const p = buildContextProfile({ goal: 'hello there, can you help me', tools: TOOLS });
  const diag = contextDiagnostics(p, { allTools: TOOLS });
  assert.equal(diag.type, 'context_profile');
  assert.equal(diag.fallback, true);
  assert.equal(diag.fallbackReason, 'no_signal');
  assert.equal(diag.selectedToolCount, TOOLS.length);
  assert.equal(diag.excludedToolCount, 0);
  assert.equal(diag.ruleCount, diag.totalRuleCount);

  // The compatibility contract: a fallback is byte-identical to no profile.
  assert.equal(buildSystemPrompt({ profile: p }), buildSystemPrompt({}));
});

test('T8c — an unknown explicit capability is refused, never approximated', () => {
  // The planner seam. A capability the taxonomy does not know must widen, not
  // snap to the nearest name — guessing here would be a planner's mistake
  // silently becoming a context decision.
  const v = classifyRequest('Create a flow', { explicitCapability: 'flow_authorng' });
  assert.equal(v.confident, false);
  assert.equal(v.reason, 'unknown_capability');
  assert.equal(v.capabilities, null);

  // A known one is honoured and the classifier is not consulted at all: the
  // goal below says "ACL" and the result is flow work, because the caller said so.
  const ok = classifyRequest('show me the ACLs', { explicitCapability: 'flow_authoring' });
  assert.equal(ok.confident, true);
  assert.equal(ok.reason, 'explicit_capability');
  assert.ok(ok.capabilities.includes('flow_authoring'));
  assert.ok(!ok.capabilities.includes('acl'));
});

/* ------------------------------------------------------------------ *
 * T9 / T10 — the safety properties, driven through a real turn
 * ------------------------------------------------------------------ */

function scriptProvider(...responses) {
  const seen = [];
  _setChatTurnForTests(async (req) => {
    seen.push(req);
    const next = responses[seen.length - 1];
    if (!next) throw new Error(`the loop asked for completion ${seen.length}; the script only has ${responses.length}`);
    return { text: '', toolCalls: [], stopReason: 'stop', ...(typeof next === 'function' ? await next(req) : next) };
  });
  return seen;
}
const call = (name, input = {}, id = `c-${name}`) => ({ id, name, input });
let n = 0;
const newSession = () => `ctx-${++n}`;

test('T9 — calling a tool the profile did not expose fails SAFELY, and widens', async () => {
  /*
   * The property: a tool that is not exposed is not forbidden, and the model is
   * told so in those words. The failure this guards against is the model
   * reading "unavailable" as "denied" and reaching for a generic write to
   * achieve the same effect — which would route a scoped-out mutation through
   * create_record and defeat the point of scoping.
   */
  const seen = scriptProvider(
    // A flow request, so create_sla is scoped out; the model asks for it anyway.
    { text: 'Setting up the SLA.', toolCalls: [call('create_sla', { name: 'x' })] },
    { text: 'Understood.' },
  );
  const sid = newSession();
  const events = [];
  await runTurn(sid, 'Create a flow that notifies the manager on a P1 incident', (e) => events.push(e));

  const miss = events.filter((e) => e.type === 'tool_not_in_context');
  assert.equal(miss.length, 1, 'the unavailable tool was not reported');
  assert.equal(miss[0].name, 'create_sla');

  // The message must not read as a refusal, and must forbid substitution.
  const result = seen[1].history.flatMap((h) => h.results || []).find((r) => r.name === 'create_sla');
  assert.ok(result, 'the model was not told what happened');
  assert.match(result.output, /NOT a refusal/);
  assert.match(result.output, /not forbidden/);
  assert.match(result.output, /Do NOT substitute/);

  // No mutation reached the gate.
  assert.equal(events.filter((e) => e.type === 'approval_required').length, 0);

  // And the context widened, so the next iteration could call it.
  const widened = events.filter((e) => e.type === 'context_profile');
  assert.ok(widened.length >= 2, 'the context did not re-emit after widening');
  assert.equal(widened[widened.length - 1].fallback, true, 'the widened profile is not the full surface');
  assert.equal(widened[widened.length - 1].selectedToolCount, TOOLS.length);

  // The miss is durable, not just streamed.
  const guard = loadToolEvents(sid).filter((e) => e.kind === 'guard' && e.name === 'tool_not_in_context');
  assert.equal(guard.length, 1);
  assert.equal(guard[0].result_status, 'not-exposed');
});

test('T10 — a narrowed profile does not narrow the approval gate', async () => {
  /*
   * The central claim of this phase, asserted rather than argued: context
   * selection changes what the model SEES and nothing about what the platform
   * ALLOWS. A mutation from a scoped profile still stops at the amber gate,
   * still needs an attributable approval, and still records the same audit row.
   */
  let executed = 0;
  toolMap.set('ctx_probe_write', {
    name: 'ctx_probe_write', mutating: true,
    execute: async () => { executed += 1; return { sys_id: 'a'.repeat(32), ok: true }; },
  });
  try {
    scriptProvider(
      { text: 'Updating the flow record now.', toolCalls: [call('ctx_probe_write', {})] },
      { text: 'Done.' },
    );
    const sid = newSession();
    const events = [];
    await runTurn(sid, 'Create a flow that notifies the manager', (e) => {
      events.push(e);
      if (e.type === 'approval_required') {
        setImmediate(() => resolveApproval(sid, e.approvalId, true, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    });

    // The profile WAS narrowed for this turn.
    const diag = events.find((e) => e.type === 'context_profile');
    assert.equal(diag.fallback, false);
    assert.ok(diag.selectedToolCount < diag.totalToolCount);

    // And the gate fired anyway, with full provenance.
    const asked = events.filter((e) => e.type === 'approval_required');
    assert.equal(asked.length, 1, 'a scoped profile skipped the approval gate');
    const resolved = events.filter((e) => e.type === 'approval_resolved');
    assert.equal(resolved[0].source, APPROVAL_SOURCES.USER_CLICK);
    assert.equal(executed, 1);

    const row = loadToolEvents(sid).find((e) => e.name === 'ctx_probe_write');
    assert.equal(row.approval, 'approved');
    assert.equal(row.approved_source, APPROVAL_SOURCES.USER_CLICK);
  } finally { toolMap.delete('ctx_probe_write'); }
});

test('T10b — a REJECTED mutation is still rejected under a scoped profile', async () => {
  let executed = 0;
  toolMap.set('ctx_probe_rej', {
    name: 'ctx_probe_rej', mutating: true,
    execute: async () => { executed += 1; return { ok: true }; },
  });
  try {
    scriptProvider(
      { text: 'Updating now.', toolCalls: [call('ctx_probe_rej', {})] },
      { text: 'I changed nothing.' },
    );
    const sid = newSession();
    await runTurn(sid, 'Create an SLA for P1 incidents', (e) => {
      if (e.type === 'approval_required') {
        setImmediate(() => resolveApproval(sid, e.approvalId, false, APPROVAL_SOURCES.USER_CLICK, e.nonce));
      }
    });
    assert.equal(executed, 0, 'a scoped profile let a rejected mutation run');
    const row = loadToolEvents(sid).find((e) => e.name === 'ctx_probe_rej');
    assert.equal(row.result_status, 'rejected');
  } finally { toolMap.delete('ctx_probe_rej'); }
});

/* ------------------------------------------------------------------ *
 * T15 / T18 — neutrality and the dependency direction
 * ------------------------------------------------------------------ */

test('T15 — context selection is provider-neutral', () => {
  const VENDORS = /\b(anthropic|openai|ollama|openrouter|opencode|claude|gpt-4|gpt-oss|llama)\b/i;
  const codeLines = (f) => read(f).split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => !/^(\/\/|\*|\/\*)/.test(line));

  // The two logic files may not name a vendor at all.
  for (const f of ['agent/context-engine.js', 'agent/context-selection.js']) {
    const offending = codeLines(f).filter(({ line }) => VENDORS.test(line));
    assert.deepEqual(offending.map((o) => `${o.n}: ${o.line}`), [],
      `${f} names a vendor — context selection must be provider-neutral`);
  }

  /*
   * The capability map is DATA, and one of the ledger keys it classifies is
   * `ollama-ignores-seed` — a measured fact about decoding, whose name is not
   * this file's choice. So the rule there is narrower and more exact: a vendor
   * name may appear only inside a quoted ledger key, never as an identifier,
   * a property access or a comparison.
   */
  const caps = codeLines('agent/context-capabilities.js').filter(({ line }) => VENDORS.test(line));
  for (const { line, n } of caps) {
    assert.match(line, /^'[a-z0-9-]*(?:ollama|openai|anthropic|claude)[a-z0-9-]*':/i,
      `context-capabilities.js:${n} names a vendor outside a quoted ledger key: ${line}`);
  }

  // And nothing in any of the three may read which provider is configured.
  for (const f of ['agent/context-engine.js', 'agent/context-selection.js', 'agent/context-capabilities.js']) {
    assert.doesNotMatch(read(f), /llm\.provider|providerInfo\s*\(|getSettings\s*\(/,
      `${f} reads the configured provider — selection must not vary by vendor`);
  }
});

test('T18 — the context engine cannot reach execution, policy or the task layer', () => {
  /*
   * The required direction:
   *
   *   agent/context-*  ->  knowledge / registry metadata
   *
   * and never downward into the machinery that decides whether a write happens.
   * This is the security property of the phase: an assembly layer that could
   * import the approval executor or the elevation shim could, in a later edit,
   * start deciding with them.
   */
  const IMPORT = /^[ \t]*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm;
  const importsOf = (rel) => [...read(rel).matchAll(IMPORT)].map((m) => m[1]);

  const FORBIDDEN = [
    /servicenow\//,                 // the whole execution layer
    /agent\/orchestrator\.js/,      // the approval executor and the turn gates
    /agent\/write-guard\.js/,
    /agent\/mutation-pipeline\.js/,
    /agent\/impersonat/,
    /memory\/provenance\.js/,
    /memory\/ledger\.js/,
    /memory\/tasks\.js/,            // Phase 1: the engine must not write task state
    /agent\/task-tracker\.js/,
  ];
  for (const f of ['agent/context-engine.js', 'agent/context-selection.js', 'agent/context-capabilities.js']) {
    for (const spec of importsOf(f)) {
      for (const bad of FORBIDDEN) {
        assert.ok(!bad.test(spec), `${f} imports ${spec} — the context engine must not reach that layer`);
      }
    }
  }

  /*
   * Nor may it CALL any of them, which is what would catch a dynamic import.
   * Matched as call sites rather than as bare words: these files legitimately
   * discuss the approval gate and the mutation ledger in prose, and explaining
   * what a layer must not touch is how the next reader learns it must not.
   */
  const CALLS = [
    /\bsaveSettings\s*\(/, /\bexecuteTool\s*\(/, /\bresolveApproval\s*\(/,
    /\brunGatedWrite\s*\(/, /\bappendMutation\s*\(/, /\brecordToolEvent\s*\(/,
    /\btable\.(get|query|create|update|remove|del)\s*\(/,   // the ServiceNow REST client
    /\brunServerScript\s*\(/, /\binstallWorkspace\s*\(/,
  ];
  for (const f of ['agent/context-engine.js', 'agent/context-selection.js', 'agent/context-capabilities.js']) {
    const src = read(f);
    for (const bad of CALLS) {
      assert.doesNotMatch(src, bad, `${f} calls ${bad} — the context engine assembles, it never executes`);
    }
  }
});

test('T18b — nothing below the assembly layer imports the context engine', () => {
  const IMPORT = /^[ \t]*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm;
  for (const dir of ['servicenow', 'memory', 'knowledge']) {
    for (const file of fs.readdirSync(path.join(SRC, dir))) {
      if (!file.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(SRC, dir, file), 'utf8');
      for (const m of src.matchAll(IMPORT)) {
        assert.doesNotMatch(m[1], /context-engine\.js|context-selection\.js|context-capabilities\.js/,
          `${dir}/${file} imports the context engine — the dependency arrow must point down`);
      }
    }
  }
});

/* ------------------------------------------------------------------ *
 * T16 — the budget, measured against the LIVE registry
 * ------------------------------------------------------------------ */

test('T16 — THE CRITICAL REGRESSION GUARD: a scoped profile costs measurably less', () => {
  /*
   * The baseline is MEASURED from the registry as it stands, never written
   * down: hard-coding "90 tools" or "20,856 tokens" would make this test pass
   * forever after someone reverted the engine to sending everything.
   *
   * The test fails if selection stops selecting.
   */
  const baselineTools = TOOLS.length;
  const baselineSchema = schemaTokens(TOOLS);
  const baselineSystem = estimateTextTokens(buildSystemPrompt({}));
  const baselineFixed = baselineSchema + baselineSystem;

  const representative = [
    'Create a flow: when a P1 incident is created, notify the assignment group manager',
    'Create an SLA for P1 incidents with a 4 hour target',
    'Show me the ACLs on the incident table',
    'Create a Laptop Request catalog item with 6 variables',
    'Impersonate Beth Anglin and check what she can see',
  ];

  for (const goal of representative) {
    const p = profileFor(goal);
    assert.equal(p.fallback, false, `"${goal}" fell back — the representative set must classify`);

    assert.ok(p.tools.length < baselineTools,
      `"${goal}" selected ${p.tools.length} of ${baselineTools} tools — nothing was excluded`);

    const sch = schemaTokens(p.tools);
    assert.ok(sch < baselineSchema,
      `"${goal}" tool schemas cost ${sch} against a baseline of ${baselineSchema}`);

    const fixed = sch + estimateTextTokens(buildSystemPrompt({ profile: p }));
    assert.ok(fixed < baselineFixed,
      `"${goal}" fixed cost ${fixed} against a baseline of ${baselineFixed}`);
    // A real reduction, not a rounding one. 15% is well under what is measured
    // today (25-66%) and is a floor that a genuine regression would break.
    assert.ok(fixed < baselineFixed * 0.85,
      `"${goal}" saved only ${(100 - (fixed / baselineFixed) * 100).toFixed(1)}% — selection has stopped working`);
  }
});

test('T16b — computeBudget reports the breakdown the optimisation is measured with', async () => {
  const { computeBudget } = await import('../src/memory/budget.js');
  const p = profileFor('Create an SLA for P1 incidents');
  const b = await computeBudget({ system: buildSystemPrompt({ profile: p }), tools: p.tools, maxTokens: 4096 });
  // Additive: `fixed` still means what it meant, and is still the sum.
  assert.equal(b.fixed, b.systemTokens + b.toolSchemaTokens);
  assert.equal(b.toolCount, p.tools.length);
  assert.ok(b.toolSchemaTokens > 0 && b.systemTokens > 0);

  const full = await computeBudget({ system: buildSystemPrompt({}), tools: TOOLS, maxTokens: 4096 });
  assert.ok(b.fixed < full.fixed, 'the scoped budget is not smaller than the full one');
  assert.ok(b.budget > full.budget, 'the saved tokens did not become history allowance');
});

/* ------------------------------------------------------------------ *
 * T19 — prompt correctness and order
 * ------------------------------------------------------------------ */

test('T19 — the assembled prompt keeps its structure, its order and its rule text', () => {
  // The split preserved every rule, verbatim and in FILE order — which is not
  // numeric order (… 23, 25, 24, 17, 26 …) and must not be tidied.
  assert.equal(OPERATING_RULES.length, 33);
  assert.deepEqual(ALL_RULE_IDS.slice(-6), ['25', '24', '17', '26', '27', '28'],
    'the rule order was re-sorted — it is deliberate and unmeasured to change');

  const full = renderRules(null);
  for (const r of OPERATING_RULES) assert.ok(full.includes(r.text), `rule ${r.id} is missing from a full render`);
  // Ascending positions => order preserved.
  let last = -1;
  for (const r of OPERATING_RULES) {
    const at = full.indexOf(r.text);
    assert.ok(at > last, `rule ${r.id} is out of file order`);
    last = at;
  }

  // A filtered render keeps relative order too.
  const some = renderRules(['15e', '1', '13']);
  assert.ok(some.indexOf('1. NEVER invent') < some.indexOf('13. SLAs'), 'filtering reordered the rules');
  assert.ok(some.indexOf('13. SLAs') < some.indexOf('15e.'), 'filtering reordered the rules');

  // Block order in the whole prompt: rules, then the measured ledger, then
  // retrieved documentation, then the digest, then this turn's mutations.
  const p = profileFor('Create an SLA for P1 incidents');
  const sys = buildSystemPrompt({
    profile: p,
    knowledgeNote: 'SERVICENOW KNOWLEDGE (RETRIEVED) — REFERENCE ONLY.',
    digestNote: 'EARLIER IN THIS CONVERSATION',
    mutationDigest: 'MUTATIONS THIS TURN',
    iterationNotice: 'ITERATION BUDGET: only 1 LLM call(s) remain in this turn.',
  });
  const order = ['Operating rules:', 'INSTANCE KNOWLEDGE LEDGER', 'SERVICENOW KNOWLEDGE (RETRIEVED)',
    'EARLIER IN THIS CONVERSATION', 'MUTATIONS THIS TURN', 'ITERATION BUDGET'];
  let prev = -1;
  for (const marker of order) {
    const at = sys.indexOf(marker);
    assert.ok(at > prev, `prompt block "${marker}" is out of order`);
    prev = at;
  }
});

test('T19b — a caller that passes no profile gets exactly the pre-Phase-2 prompt', () => {
  // The compatibility contract. Nothing in the repo was rewritten to pass a
  // profile, and everything that does not still works.
  const sys = buildSystemPrompt({});
  assert.equal(sys, buildSystemPrompt({ profile: null }));
  for (const r of OPERATING_RULES) assert.ok(sys.includes(r.text), `rule ${r.id} missing without a profile`);
  assert.match(sys, /INSTANCE KNOWLEDGE LEDGER/);
});

/* ------------------------------------------------------------------ *
 * T20 — determinism
 * ------------------------------------------------------------------ */

test('T20 — the same request produces the same selection, and a different one may differ', () => {
  const goal = 'Create a flow: when a P1 incident is created, notify the assignment group manager';
  const a = profileFor(goal);
  const b = profileFor(goal);
  assert.deepEqual(a.capabilities, b.capabilities);
  assert.deepEqual(a.tools.map((t) => t.name), b.tools.map((t) => t.name));
  assert.deepEqual(a.ruleIds, b.ruleIds);
  assert.deepEqual(a.factKeys, b.factKeys);
  assert.equal(a.query, b.query);

  // Capability expansion is order-independent, so two orderings of the same
  // request cannot produce two different surfaces.
  assert.deepEqual(expandCapabilities(['sla', 'acl']), expandCapabilities(['acl', 'sla']));

  // And a genuinely different task selects differently — otherwise the engine
  // is deterministic and useless.
  const other = profileFor('Show me the ACLs on the incident table');
  assert.notDeepEqual(a.tools.map((t) => t.name), other.tools.map((t) => t.name));
});

test('T20b — widening is monotonic and reaches the full surface', () => {
  const p = profileFor('Create an SLA for P1 incidents');
  assert.ok(p.tools.length < TOOLS.length);
  const w = widenProfile(p, { tools: TOOLS, reason: 'test' });
  assert.equal(w.tools.length, TOOLS.length);
  assert.equal(w.fallback, true);
  assert.equal(w.ruleIds, null);
  assert.equal(w.factKeys, null);
  // Widening a widened profile is stable.
  assert.equal(widenProfile(w, { tools: TOOLS, reason: 'again' }).tools.length, TOOLS.length);
});

test('the capability closure is sane: every implication names a known capability', () => {
  const known = new Set(CAPABILITIES);
  for (const [cap, implied] of Object.entries(IMPLIES)) {
    assert.ok(known.has(cap), `IMPLIES names unknown capability ${cap}`);
    for (const i of implied) assert.ok(known.has(i), `${cap} implies unknown capability ${i}`);
  }
  // Every profile contains core, always.
  for (const cap of CAPABILITIES) assert.ok(expandCapabilities([cap]).includes('core'));
});
