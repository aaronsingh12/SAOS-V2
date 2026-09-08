/**
 * WI-5 — THE TURN SUMMARY MUST NOT COUNT A MUTATION THAT DID NOT HAPPEN.
 *
 * ═══ THE DEFECT, AS REPORTED ═══
 *
 * `create_flow_live` refused at the binding preflight: the workspace named an
 * application that did not exist on the bound instance, so nothing was built,
 * nothing was installed, and the tool returned
 * `{ ok: false, bindingRefused: true }`.
 *
 * The turn summary said: **"1 mutation ✅ create_flow_live"**.
 *
 * Two independent faults produced that one sentence, and both are fixed at
 * their root rather than in the renderer:
 *
 *   1. `verifyMutation` labelled every descriptor-less tool `self-verified`
 *      WITHOUT LOOKING AT WHAT THE TOOL SAID. A refusal and a success were
 *      indistinguishable to it.
 *   2. `self-verified` shared the ✅ glyph with `applied`, so a tool's unchecked
 *      self-report rendered identically to a harness read-back that had
 *      actually compared the stored record against what was sent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nha-wi5-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { verifyMutation } = await import('../src/agent/mutation-pipeline.js');
const { appendMutation, mutationsForTurn, renderMutationReport } = await import('../src/memory/ledger.js');
const { createSession } = await import('../src/memory/sessions.js');

/** The exact result the failing session's `create_flow_live` returned. */
const REFUSED = {
  ok: false,
  bindingRefused: true,
  message: 'REFUSING TO INSTALL: the application "x_2002152_nwforge" does not exist on the bound instance.',
};

let n = 0;
const session = () => {
  const id = `wi5-${(n += 1)}`;
  createSession({ id });
  return id;
};

/* ================================================================== *
 * The status
 * ================================================================== */

test('W1 — a refused call is NOT self-verified', async () => {
  const v = await verifyMutation({ descriptor: null, result: REFUSED, before: null, toolName: 'create_flow_live' });
  assert.notEqual(v.status, 'self-verified', 'a refusal was labelled as a self-verified write');
  assert.equal(v.status, 'unverified');
  assert.equal(v.verified, false);
  assert.equal(v.notAttempted, true);
  assert.match(v.summary, /binding preflight/);
  assert.match(v.summary, /nothing was attempted/);
});

test('W2 — any ok:false result is not self-verified, refusal or not', async () => {
  const v = await verifyMutation({
    descriptor: null, result: { ok: false, message: 'build failed' }, before: null, toolName: 'create_flow_live',
  });
  assert.equal(v.notAttempted, true);
  assert.match(v.summary, /nothing was written/);
});

test('W3 — a tool that did NOT report failure is still self-verified, and says so', async () => {
  /*
   * The legitimate case is untouched: an SDK-backed tool reads its own work
   * back through its own path. What changed is that the label no longer claims
   * the harness checked it.
   */
  const v = await verifyMutation({
    descriptor: null, result: { ok: true, name: 'Some Flow' }, before: null, toolName: 'create_flow_live',
  });
  assert.equal(v.status, 'self-verified');
  assert.equal(v.verified, null, 'a self-report must not be recorded as verified:true');
  assert.equal(v.notAttempted, undefined);
  assert.match(v.summary, /not checked by the harness/);
});

/* ================================================================== *
 * The count
 * ================================================================== */

test('W4 — REPLAY: the refused call produces ZERO mutations in the summary', async () => {
  const sid = session();
  const v = await verifyMutation({ descriptor: null, result: REFUSED, before: null, toolName: 'create_flow_live' });

  const wrote = appendMutation({
    sessionId: sid, turnSeq: 1, tool: 'create_flow_live',
    descriptor: null, result: REFUSED, verification: v, approval: 'approved', approvedSource: 'user_click',
  });

  assert.equal(wrote, false, 'the ledger recorded a mutation for a call that was refused');
  const entries = mutationsForTurn(sid, 1);
  assert.equal(entries.length, 0, `the turn summary counts ${entries.length} mutation(s) for a refused call`);
  assert.equal(renderMutationReport(entries), '', 'a report was rendered for a turn that changed nothing');
});

test('W5 — a REAL failed write is still recorded, because it reached the instance', async () => {
  /*
   * The guard must not swallow the case it would be most damaging to hide: a
   * write that was attempted, reached the platform, and was silently discarded.
   * That has a descriptor, gets diffed, and is recorded as `no-op`.
   */
  const sid = session();
  const v = {
    verified: false, status: 'no-op', summary: 'the platform discarded this write',
    applied: [], dropped: [{ field: 'assignment_group' }], transformed: [], unverifiable: [], noOpSignal: true,
  };
  const wrote = appendMutation({
    sessionId: sid, turnSeq: 1, tool: 'update_record',
    descriptor: { table: 'incident', sys_id: 'a'.repeat(32), requested: { assignment_group: 'x' } },
    result: { sys_id: 'a'.repeat(32) }, verification: v, approval: 'approved', approvedSource: 'user_click',
  });

  assert.equal(wrote, true, 'a real discarded write was suppressed');
  const entries = mutationsForTurn(sid, 1);
  assert.equal(entries.length, 1);
  assert.match(renderMutationReport(entries), /discarded this write/);
});

/* ================================================================== *
 * The glyph
 * ================================================================== */

test('W6 — a self-report does not wear the verified tick', async () => {
  const sid = session();
  const v = await verifyMutation({
    descriptor: null, result: { ok: true, name: 'Some Flow' }, before: null, toolName: 'create_flow_live',
  });
  appendMutation({
    sessionId: sid, turnSeq: 1, tool: 'create_flow_live',
    descriptor: null, result: { ok: true }, verification: v, approval: 'approved', approvedSource: 'user_click',
  });

  const md = renderMutationReport(mutationsForTurn(sid, 1));
  assert.ok(md.includes('☑️'), 'the self-report glyph is missing');
  assert.ok(!md.includes('✅'), 'a self-report still renders with the verified tick');
  /* And the distinction is written out, not left to the glyph. */
  assert.match(md, /The harness did not read this back independently/);
});

test('W7 — a genuinely verified write keeps its tick, so the distinction means something', async () => {
  const sid = session();
  appendMutation({
    sessionId: sid, turnSeq: 1, tool: 'update_record',
    descriptor: { table: 'incident', sys_id: 'b'.repeat(32), requested: { short_description: 'x' } },
    result: { sys_id: 'b'.repeat(32) },
    verification: {
      verified: true, status: 'applied', summary: 'read back',
      applied: [{ field: 'short_description' }], dropped: [], transformed: [], unverifiable: [], noOpSignal: null,
    },
    approval: 'approved', approvedSource: 'user_click',
  });
  const md = renderMutationReport(mutationsForTurn(sid, 1));
  assert.ok(md.includes('✅'), 'a harness-verified write lost its tick');
});
