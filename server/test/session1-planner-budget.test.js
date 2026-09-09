/**
 * SESSION 1 / WI-5 — THE PLANNER'S OUTPUT BUDGET.
 *
 *   node --test server/test/
 *
 * MEASURED 2026-09-08, three of three warm samples of the golden flow request
 * against gpt-oss:120b-cloud: the planner prompt was 2.3k tokens and the model
 * needed 6.4–9.3k characters of REASONING (billed as completion) before or
 * while writing a 2.9k-character plan. `generatePlan` asked for 2,048
 * completion tokens; every sample came back `finish=length`, truncated
 * mid-object, and was reported as `unparseable` — a silence about the real
 * cause. The prompt was never the problem; the room to answer was.
 *
 * Two rules:
 *   the default completion budget is sized from those samples, with headroom
 *   a truncated completion is `plan_truncated`, loud, never `unparseable`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-s1plan-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { _setChatTurnForTests } = await import('../src/agent/providers/index.js');
const { generatePlan, PLAN_MAX_TOKENS } = await import('../src/agent/plan/planner.js');

test.after(() => _setChatTurnForTests(null));

test('the default completion budget leaves room for a reasoning model to answer', async () => {
  let seen = null;
  _setChatTurnForTests(async (req) => { seen = req; return { text: '{"goal":"g","steps":[]}', toolCalls: [], stopReason: 'stop' }; });
  await generatePlan({ goal: 'read the incident schema' });
  assert.ok(seen, 'the planner did not call the model');
  // 9.3k reasoning chars + 2.9k plan chars ≈ 3.5k tokens at 3.5 chars/token;
  // 8,192 gives that a 2× margin and is what the samples were sized against.
  assert.ok(seen.maxTokens >= 8192, `maxTokens ${seen.maxTokens} is below the measured need`);
  assert.equal(seen.maxTokens, PLAN_MAX_TOKENS);
});

test('a completion cut off by the budget is reported as plan_truncated, loudly, never as unparseable', async () => {
  _setChatTurnForTests(async () => ({
    text: '{\n  "goal": "Create a flow",\n  "steps": [\n    {\n      "id": "step_1",\n      "operation": "author subflow',
    toolCalls: [], stopReason: 'length',
  }));
  const r = await generatePlan({ goal: 'the golden request' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'plan_truncated', `got ${r.reason}: ${r.note}`);
  assert.match(r.note, /finish=length|completion budget|truncated/i);
  assert.match(r.note, /\d+/, 'the note must state the budget that was exhausted');
  assert.ok(r.raw, 'the truncated text is kept for the evidence');
});

test('a well-formed answer that stops on its own is unaffected', async () => {
  _setChatTurnForTests(async () => ({ text: 'nonsense without json', toolCalls: [], stopReason: 'stop' }));
  const r = await generatePlan({ goal: 'x' });
  assert.equal(r.reason, 'unparseable');
});

test('the plan route relies on the sized default rather than passing a smaller budget', () => {
  const src = fs.readFileSync(new URL('../src/routes/plan.js', import.meta.url), 'utf8');
  const m = src.match(/generatePlan\(\{ goal: message[^}]*\}\)/);
  assert.ok(m, 'the plan route no longer calls generatePlan({ goal: message ... })');
  assert.doesNotMatch(m[0], /maxTokens:\s*(20\d\d|10\d\d|\d{1,3})\b/, 'the route caps the planner below the sized default');
});
