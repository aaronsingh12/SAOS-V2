/**
 * SESSION 1 / WI-7 — INTENT CONTINUITY IN THE CONTEXT ENGINE.
 *
 *   node --test server/test/
 *
 * MEASURED 2026-09-08. Turn one: "When an incident is created, run a subflow
 * that adds the work note …" — classified flow_authoring + incident, 35 of 97
 * tools, correct. Turn two, the user's follow-up: "use the Incident table" —
 * classified incident / record_* only, `create_flow_live` scoped out, the model
 * asked for it anyway, got `tool_not_in_context`, and spent an iteration
 * widening to the full registry. The classifier reads one sentence at a time;
 * a conversation does not.
 *
 * THE RULE. Within a session the previous turn's domains persist as a FLOOR
 * for a follow-up: the follow-up's own domains are added to them, never
 * substituted for them, and a follow-up with no domain noun at all ("ok go
 * ahead") inherits the floor instead of falling back to everything. Only the
 * immediately previous turn carries forward, so the union cannot grow without
 * bound, and the budget assertion below holds on the widest case measured.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-s1ctx-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { buildContextProfile, contextDiagnostics } = await import('../src/agent/context-engine.js');
const { TOOLS } = await import('../src/agent/tools.js');
const { SANE_CONTEXT_CAP } = await import('../src/memory/budget.js');

const GOLDEN = "When an incident is created, run a subflow that adds the work note 'Priority checked by onboarding subflow', then add the work note 'Flow completed successfully'";
const FOLLOW_UP = 'use the Incident table';
const NO_NOUN = 'ok go ahead';

const names = (p) => p.tools.map((t) => t.name);

test('turn one classifies the golden request into the flow domain (the baseline)', () => {
  const p = buildContextProfile({ goal: GOLDEN, tools: TOOLS });
  assert.equal(p.fallback, false);
  assert.ok(p.capabilities.includes('flow_authoring'));
  assert.ok(names(p).includes('create_flow_live'));
});

test('the measured exchange: turn two keeps the flow domain when the prior turn is carried as a floor', () => {
  const one = buildContextProfile({ goal: GOLDEN, tools: TOOLS });
  // Without the floor — the defect as measured.
  const bare = buildContextProfile({ goal: FOLLOW_UP, tools: TOOLS });
  assert.equal(bare.fallback, false);
  assert.ok(!names(bare).includes('create_flow_live'), 'the premise of this test is that the bare follow-up drops the flow tool');

  const two = buildContextProfile({ goal: FOLLOW_UP, tools: TOOLS, priorCapabilities: one.capabilities });
  assert.equal(two.fallback, false);
  assert.ok(two.capabilities.includes('flow_authoring'), `flow domain lost: ${two.capabilities.join(', ')}`);
  assert.ok(two.capabilities.includes('incident'), 'the follow-up\'s own domain must still be there');
  assert.ok(names(two).includes('create_flow_live'));
  assert.ok(two.matched.some((m) => m.term === '(prior turn)'), 'the floor must be visible in the diagnostics');
});

test('a follow-up with no domain noun inherits the floor instead of the whole registry', () => {
  const one = buildContextProfile({ goal: GOLDEN, tools: TOOLS });
  const bare = buildContextProfile({ goal: NO_NOUN, tools: TOOLS });
  assert.equal(bare.fallback, true, 'premise: a bare "ok go ahead" is unclassifiable');

  const p = buildContextProfile({ goal: NO_NOUN, tools: TOOLS, priorCapabilities: one.capabilities });
  assert.equal(p.fallback, false);
  assert.deepEqual([...p.capabilities].sort(), [...one.capabilities].sort());
  assert.equal(p.fallbackReason, null);
  assert.ok(names(p).length < TOOLS.length, 'the floor must narrow, not widen');
});

test('the floor is one turn deep: a prior with nothing in it changes nothing', () => {
  const bare = buildContextProfile({ goal: FOLLOW_UP, tools: TOOLS });
  const withEmpty = buildContextProfile({ goal: FOLLOW_UP, tools: TOOLS, priorCapabilities: [] });
  const withNull = buildContextProfile({ goal: FOLLOW_UP, tools: TOOLS, priorCapabilities: null });
  assert.deepEqual(names(withEmpty), names(bare));
  assert.deepEqual(names(withNull), names(bare));
});

test('an unknown prior capability is ignored, not treated as a widening to everything', () => {
  const p = buildContextProfile({ goal: FOLLOW_UP, tools: TOOLS, priorCapabilities: ['not_a_capability'] });
  assert.equal(p.fallback, false);
  assert.ok(!p.capabilities.includes('not_a_capability'));
});

test('budget: the union of the two measured turns stays inside the context ceiling', () => {
  const one = buildContextProfile({ goal: GOLDEN, tools: TOOLS });
  const two = buildContextProfile({ goal: FOLLOW_UP, tools: TOOLS, priorCapabilities: one.capabilities });
  const d = contextDiagnostics(two, { allTools: TOOLS });
  const full = contextDiagnostics(buildContextProfile({ goal: '', tools: TOOLS }), { allTools: TOOLS });
  assert.ok(d.toolSchemaTokens < full.toolSchemaTokens, 'the union must still be narrower than the full registry');
  // The Session 0 measurement: 35 tools ≈ 7.7k schema tokens on a 60k ceiling.
  assert.ok(d.toolSchemaTokens <= Math.round(SANE_CONTEXT_CAP * 0.25), `schema tokens ${d.toolSchemaTokens} exceed a quarter of the ${SANE_CONTEXT_CAP} ceiling`);
});

test('the turn loop hands the previous turn\'s capabilities to the engine', () => {
  const src = fs.readFileSync(new URL('../src/agent/orchestrator.js', import.meta.url), 'utf8');
  assert.match(src, /buildContextProfile\(\{[^)]*priorCapabilities/, 'runTurn must pass priorCapabilities into buildContextProfile');
  assert.match(src, /lastCapabilities/, 'the previous turn\'s capabilities must be kept on the session state');
});
