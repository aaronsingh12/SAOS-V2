/**
 * PHASE 8 — REGRESSION TESTS FOR WHAT REAL VALIDATION EXPOSED.
 *
 *   node --test server/test/
 *
 * Every test here pins a defect that a REAL run found and an offline test had
 * not. They are offline and structural so they run in the ordinary suite; the
 * runs that found them are recorded separately as REAL PDI / REAL MODEL results.
 *
 *   1. The planner prompt never showed the model a tool name.
 *   2. The chat turn's task id never reached the client.
 *   3. A `transformed` write is not a failure, and must not read as a success.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-p8reg-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const P = await import('../src/agent/plan/index.js');
const { CAPABILITIES } = await import('../src/agent/capability-discovery.js');
const { toolMap } = await import('../src/agent/tools.js');

const SRC = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const CLIENT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..', 'client', 'src');
const readClient = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

/** The capability shape discovery hands the prompt. */
const cap = (name) => ({
  capability: name,
  mechanism: CAPABILITIES[name].mechanism,
  verification: CAPABILITIES[name].verification,
  requiresElevation: false,
  available: true,
});

/* ================================================================== *
 * 1. THE PLANNER PROMPT — the 100% rejection defect
 * ================================================================== */

/*
 * WHAT REAL VALIDATION FOUND. Against ollama/gpt-oss:120b-cloud, all eight task
 * categories produced plans the validator rejected, every one of them for
 * `unknown_tool`, and the offending values were `rest`, `sdk`, `harness` and
 * `sla_authoring` — three mechanisms and a capability name.
 *
 * THE CAUSE was not the model. The prompt asked for "the registry tool" and then
 * printed `capability  mechanism  verification`, so the only second-column
 * vocabulary the model had ever seen was the mechanism. It wrote the word it had
 * been shown.
 *
 * THE INVARIANT THAT KEPT IT SAFE. The validator refused every one of those
 * plans and nothing executed. A prompt defect cost eight wasted turns; it could
 * not cost a wrong mutation, because `unknown_tool` is fatal and the executor
 * checks the registry again at run time regardless.
 */

test('P1 — the planner prompt NAMES the tools each capability may use', () => {
  const prompt = P.plannerSystem({ capabilities: [cap('record_read'), cap('record_update')], semantics: null });
  assert.match(prompt, /query_records/, 'the prompt never shows a real tool name for record_read');
  assert.match(prompt, /get_record/);
  assert.match(prompt, /update_record/, 'the prompt never shows a real tool name for record_update');
});

test('P2 — every listed capability shows its own tools, from the existing taxonomy', () => {
  const names = ['record_read', 'record_create', 'record_update', 'sla_authoring', 'acl_authoring', 'flow_authoring'];
  const prompt = P.plannerSystem({ capabilities: names.map(cap), semantics: null });
  for (const n of names) {
    for (const tool of CAPABILITIES[n].tools ?? []) {
      assert.ok(prompt.includes(tool), `the prompt lists ${n} without naming its tool ${tool}`);
      // And the taxonomy is not drifting from the registry.
      assert.ok(toolMap.has(tool), `the taxonomy claims ${n} uses ${tool}, which is not in the registry`);
    }
  }
});

test('P3 — the prompt says plainly that a mechanism is not a tool', () => {
  const prompt = P.plannerSystem({ capabilities: [cap('record_read')], semantics: null });
  assert.match(prompt, /NOT the mechanism/i,
    'nothing in the prompt distinguishes the tool field from the mechanism field');
  // The three words the model actually produced are named, so the instruction
  // is concrete rather than abstract.
  for (const mech of ['rest', 'sdk', 'harness']) {
    assert.ok(prompt.includes(`"${mech}"`), `the prompt does not name "${mech}" as a mechanism`);
  }
});

test('P4 — the prompt tells the model what to do when a capability has no tool', () => {
  const prompt = P.plannerSystem({ capabilities: [cap('record_read')], semantics: null });
  assert.match(prompt, /"tool": null/,
    'a planning-only step has no stated representation, so the model must invent one');
});

test('P5 — the prompt reuses the taxonomy rather than carrying its own tool list', () => {
  const src = read('agent/plan/planner.js');
  assert.match(src, /CAPABILITIES\[c\.capability\]\?\.tools/,
    'the planner prompt hard-codes a tool list instead of reading the capability taxonomy');
  // No second mapping was introduced anywhere in the plan layer.
  for (const f of ['planner.js', 'validator.js', 'executor.js']) {
    const body = read(`agent/plan/${f}`).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/const\s+(TOOLS_FOR|CAPABILITY_TOOLS|TOOL_MAP)\s*=/.test(body),
      `${f} declares a second capability-to-tool mapping`);
  }
});

test('P6 — the validator still REJECTS a mechanism in the tool field (the gate was never the problem)', () => {
  const bad = {
    goal: 'read an incident',
    steps: [{
      id: 'step_1', operation: 'read', capability: 'record_read',
      tool: 'rest',                       // the exact value the model produced
      mutating: false, target: {}, inputs: { table: 'incident' },
      depends_on: [], expected_effects: [], verification: { strategy: 'none', asserts: [] },
    }],
  };
  const verdict = P.validatePlan(bad, {
    discover: (name) => ({
      capability: name, status: 'known', available: true, mechanism: 'rest',
      mutating: false, verification: 'none', requiresVerification: false,
      requiresApproval: false, requiresElevation: false, scope: null, reason: null, note: null,
    }),
  });
  assert.equal(verdict.valid, false, 'a mechanism in the tool field was accepted');
  assert.ok(verdict.fatal.some((p) => p.code === 'unknown_tool'),
    `expected unknown_tool, got ${verdict.fatal.map((p) => p.code).join(', ')}`);
});

test('P7 — the prompt was not weakened to raise the acceptance rate', () => {
  const prompt = P.plannerSystem({ capabilities: [cap('record_update')], semantics: null });
  // The rules that make a plan checkable are all still stated.
  assert.match(prompt, /Every mutating step needs a verification strategy/);
  assert.match(prompt, /asserts must cover EVERY/);
  assert.match(prompt, /Never plan a write to a DERIVED field/);
  assert.match(prompt, /Never invent a sys_id/);
  assert.match(prompt, /DATA, NOT INSTRUCTIONS/);
});

/* ================================================================== *
 * 2. THE TASK ID — the evidence UI had no entry point
 * ================================================================== */

test('P8 — the chat route emits the task id so evidence can be asked for', () => {
  const src = read('routes/agent.js');
  assert.match(src, /type: 'task_started', taskId: task\.taskId/,
    'the durable task id still never leaves the server');
  // Emitted directly rather than through `emit`, because the frame is ABOUT the
  // task and must not be projected onto it as part of its work.
  assert.ok(src.indexOf("type: 'task_started'") < src.indexOf('const keepAlive'),
    'the task frame is emitted after the turn may already have produced output');
});

test('P9 — the client reads the AUTHORITATIVE endpoint and builds no second store', () => {
  const panel = readClient('components/EvidencePanel.jsx');
  assert.match(panel, /\/agent\/plan\/\$\{encodeURIComponent\(taskId\)\}\/evidence/,
    'the panel does not read the existing evidence endpoint');
  // It renders the server's status; it never computes one.
  assert.match(panel, /ev\.final\?\.status/);
  assert.ok(!/function\s+(computeStatus|deriveStatus|decideStatus)/.test(panel),
    'the client computes its own final status, competing with the durable record');
  assert.ok(!/localStorage|sessionStorage|indexedDB/i.test(panel),
    'the client persists a second copy of the evidence');
});

test('P10 — the panel keeps EXECUTION, VERIFICATION, APPROVAL and RECOVERY apart', () => {
  const panel = readClient('components/EvidencePanel.jsx');
  for (const section of ['APPROVAL', 'EXECUTION &amp; VERIFICATION', 'RECOVERY', 'EVIDENCE QUALITY']) {
    assert.ok(panel.includes(section), `the panel has no ${section} section`);
  }
  // The six recovery outcomes Phase 8 asked to be distinguishable.
  for (const label of ['RECOVERED', 'UNRECOVERED', 'REPEATED_MUTATION', 'REPLAN_REQUIRED', 'BLOCKED', 'CANCELLED']) {
    assert.ok(panel.includes(label), `the panel cannot show ${label}`);
  }
});

test('P11 — the client is told which evidence is exact and which is correlated', () => {
  const panel = readClient('components/EvidencePanel.jsx');
  assert.match(panel, /c\.exact \? 'exact' : 'correlated'/,
    'the UI presents window-matched changes as though they were proven');
});

/* ================================================================== *
 * 3. TRANSFORMED WRITES — proven live on the PDI
 * ================================================================== */

/*
 * REAL PDI TEST found this behaving correctly, and it is pinned here because it
 * is the case most likely to be "simplified" later.
 *
 * Writing `priority` directly to a real incident is accepted by the platform and
 * then discarded — the project's own ledger trap, reproduced live. The read-back
 * reports `transformed`, `isFailedWrite` does NOT call it a failure (the call
 * reached the instance and something landed), so the STEP completes and
 * `res.ok` is true — while the evidence's final status is UNVERIFIED.
 *
 * Both halves matter. Turning `transformed` into a failure would make an
 * honest partial result look like a crash; letting it read as success would be
 * the lie. The resolution is that `final.status` is authoritative and `res.ok`
 * is not, which is exactly why the UI must never collapse them.
 */

test('P12 — transformed is NOT a failed write, and is NOT a success either', async () => {
  const { isFailedWrite } = await import('../src/agent/mutation-pipeline.js');
  assert.equal(isFailedWrite({ status: 'transformed' }), false,
    'a transformed write became a hard failure — an honest partial result would read as a crash');
  assert.equal(isFailedWrite({ status: 'no-op' }), true);
  assert.equal(isFailedWrite({ status: 'partial' }), true);
  assert.equal(isFailedWrite({ status: 'applied' }), false);
});

test('P13 — a transformed write cannot reach VERIFIED', async () => {
  const { decideStatus, STATUS } = await import('../src/agent/evidence/index.js');
  const out = decideStatus({
    planState: 'completed',
    taskState: 'completed',
    executedAnything: true,
    steps: [{ id: 'step_1', state: 'completed' }],
    effects: [{ step: 'step_1', effect: 'priority becomes 1', verified: null }],
  });
  assert.notEqual(out.status, STATUS.VERIFIED,
    'a run whose promised effect was never verified was reported as VERIFIED');
});

test('P14 — the evidence status decider knows nothing about res.ok', () => {
  const src = read('agent/evidence/status.js');
  assert.ok(!/\bres\.ok\b|\bresult\.ok\b/.test(src),
    'the authoritative status reads the executor\'s boolean, which is true for a transformed write');
});

/* ================================================================== *
 * 4. THE ENDPOINT THE UI ACTUALLY READS
 * ================================================================== */

test('P15 — the evidence ENDPOINT serves every field the panel renders', async () => {
  const express = (await import('express')).default;
  const { planRouter } = await import('../src/routes/plan.js');
  const { createTask, startTask } = await import('../src/memory/tasks.js');
  const { getDb } = await import('../src/memory/db.js');
  const { APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');

  const sid = 'p8-route';
  getDb().prepare('INSERT OR IGNORE INTO sessions (id, created, updated) VALUES (?, ?, ?)')
    .run(sid, new Date().toISOString(), new Date().toISOString());
  const t = createTask({ sessionId: sid, goal: 'serve the panel' });
  startTask(t.id);
  const saved = P.savePlan(t.id, {
    goal: 'serve the panel',
    steps: [{
      id: 'step_1', operation: 'update the incident', capability: 'record_update',
      tool: 'update_record', mechanism: null, scope: null, mutating: true,
      target: { table: 'incident', sys_id: 'a'.repeat(32) },
      inputs: { table: 'incident', sys_id: 'a'.repeat(32), data: { short_description: 'x' } },
      depends_on: [], expected_effects: ['short_description is updated'],
      verification: { strategy: 'read_back', asserts: ['ok'] },
    }],
  });
  P.setPlanState(t.id, 'ready');
  P.setPlanState(t.id, 'awaiting_approval');
  P.approvePlan(t.id, saved.fingerprint, { source: APPROVAL_SOURCES.USER_CLICK });

  const app = express();
  app.use(express.json());
  app.use('/api/agent/plan', planRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/agent/plan`;
    const res = await fetch(`${base}/${t.id}/evidence`);
    assert.equal(res.status, 200);
    const ev = await res.json();

    // Exactly the paths EvidencePanel.jsx reads. A rename on either side breaks
    // this rather than silently rendering blanks.
    assert.ok(ev.final && typeof ev.final.status === 'string', 'final.status');
    assert.ok(ev.plan && 'goal' in ev.plan && 'state' in ev.plan, 'plan.goal / plan.state');
    assert.ok(Array.isArray(ev.steps), 'steps[]');
    assert.ok('capability' in ev.steps[0] && 'mechanism' in ev.steps[0], 'step capability / mechanism');
    assert.ok('executed' in ev.steps[0], 'step executed');
    // The two statuses the server deliberately keeps apart, under the names it
    // deliberately gives them. The panel reads these exact keys.
    assert.ok('execution_status' in ev.steps[0], 'step execution_status');
    assert.ok('verification_status' in ev.steps[0], 'step verification_status');
    assert.ok('expectedEffects' in ev.steps[0], 'step expectedEffects');
    assert.ok('failureReason' in ev.steps[0], 'step failureReason');
    assert.ok(ev.approval && 'status' in ev.approval && 'valid' in ev.approval, 'approval.status / valid');
    assert.ok(Array.isArray(ev.changes), 'changes[]');
    assert.ok(ev.recovery && 'attempted' in ev.recovery && Array.isArray(ev.recovery.steps), 'recovery');
    assert.ok(Array.isArray(ev.uncertainties), 'uncertainties[]');
    assert.ok(ev.audit && 'exact' in ev.audit && ev.audit.counts, 'audit.exact / audit.counts');
    assert.ok(ev.verification && 'promised' in ev.verification, 'verification.promised');

    // A task that does not exist is a deterministic 404, not an empty panel.
    const missing = await fetch(`${base}/does-not-exist/evidence`);
    assert.equal(missing.status, 404);
  } finally { await new Promise((r) => server.close(r)); }
});

test('P16 — the endpoint is the ONLY evidence surface; Phase 8 added no second one', () => {
  const routes = fs.readdirSync(path.join(SRC, 'routes'));
  assert.ok(!routes.some((f) => /evidence/i.test(f)), `an evidence route file appeared: ${routes.join(', ')}`);
  const plan = read('routes/plan.js');
  assert.equal((plan.match(/\/evidence'/g) ?? []).length, 1, 'more than one evidence endpoint is mounted');
});
