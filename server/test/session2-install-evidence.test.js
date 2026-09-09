/**
 * SESSION 2 / W0 PREP — THE THREE THINGS THAT MUST BE TRUE BEFORE WE INSTALL.
 *
 *   node --test server/test/
 *
 * The W0 investigation produced three findings that each make an instance write
 * unsafe or undiagnosable until they are closed. All three are closed here,
 * with the failing test written first.
 *
 * ── 1. AN INSTALL'S OWN OUTPUT IS EVIDENCE, AND WE THREW IT AWAY ────────────
 *
 * `deploy()` kept `res.stdout`/`res.stderr` only on the FAILURE path. On
 * success it kept a single regex capture, `activation`, and discarded the rest.
 * That is backwards, and it is why "activation: null" on dev428633
 * (2026-09-02) is permanently undecidable: the line was never printed, and we
 * cannot tell which of four silent paths swallowed it.
 *
 * Read from the SDK 4.10.1 source (sdk-api/dist/flow-activation.js,
 * orchestrator.js), activation can be silent in four distinct ways:
 *   - the endpoint 404s          -> logger.debug('Flow activation endpoint not found...')
 *   - there are no flows to send -> logger.debug('No flows to activate')
 *   - the project has no records -> the task never runs
 *   - the task THROWS            -> orchestrator.js:555-562 catches every
 *                                   post-install task error and logs it at
 *                                   DEBUG, so `now-sdk install` still exits 0
 * The last one is the dangerous one: a clean install with zero flows activated.
 * So `activation: null` may NEVER be read as "activation was skipped, no
 * harm" — and the parse now says which of the four it was, or that it does not
 * know.
 *
 * ── 2. setActive WAS A LOADED GUN LEFT ON THE TABLE ─────────────────────────
 *
 * Session 1 removed the route that flipped `sys_hub_flow.active` over REST and
 * the policy now refuses that write everywhere. The FUNCTION survived with no
 * callers. It is the obvious shortcut for "activate this flow" and it produces
 * exactly the state this session exists to stop reporting as success: active
 * with no snapshot, which `publishedVerdict` correctly calls
 * ACTIVE_WITHOUT_SNAPSHOT.
 *
 * ── 3. A TEST-CREATED SNAPSHOT IS NOT A FAILED PUBLISH ──────────────────────
 *
 * Proven on dev424910 from `syslog_transaction`: the only action ever taken
 * against "Demo Critical Incident Auto-Assign" was
 * POST /api/now/processflow/flow/<sys_id>/test. No activate transaction exists
 * anywhere on the instance. So a draft header beside a published snapshot row
 * is the ORDINARY state after somebody presses Test — and our note asserted a
 * cause ("the publish did not complete on the header") that the evidence
 * contradicts. The state description stays; the invented cause goes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-s2ev-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://offline.invalid', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
});

const { parseInstall, ACTIVATION } = await import('../src/servicenow/fluent.js');
const { flows, publishedVerdict, PUBLISH_MISMATCH } = await import('../src/servicenow/flows.js');

const SRC = new URL('../src/', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, SRC), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/* ------------------------------------------------------------------ *
 * 1. The install parse
 * ------------------------------------------------------------------ */

test('the activation outcome vocabulary is closed and covers every silent path the SDK has', () => {
  assert.deepEqual(Object.keys(ACTIVATION).sort(), ['ABSENT', 'FAILED', 'PARTIAL', 'SUCCEEDED']);
  // The reasons an ABSENT activation can carry. Each is a distinct SDK code
  // path; "unknown" is the honest fifth when none of the four strings appears.
  assert.deepEqual([...ACTIVATION.ABSENT.reasons].sort(),
    ['endpoint_not_found', 'no_flows_to_activate', 'task_threw', 'unknown']);
});

test('a clean activation is SUCCEEDED and keeps the counts', () => {
  const p = parseInstall({ stdout: 'Building...\nFlow activation complete: 2/2 succeeded\nDone.', stderr: '' });
  assert.equal(p.activation, '2/2');
  assert.equal(p.activationOutcome, 'succeeded');
  assert.equal(p.activationReason, null);
  assert.deepEqual(p.activationCounts, { succeeded: 2, total: 2, failed: 0 });
});

test('a partial activation is PARTIAL and is never reported as success', () => {
  const p = parseInstall({ stdout: 'Flow activation complete: 1/3 succeeded, 2 failed', stderr: '' });
  assert.equal(p.activationOutcome, 'partial');
  assert.deepEqual(p.activationCounts, { succeeded: 1, total: 3, failed: 2 });
  assert.notEqual(p.activationOutcome, 'succeeded');
});

test('each of the four silent paths is named rather than collapsed into null', () => {
  const cases = [
    ['Flow activation endpoint not found. Make sure you have the latest ServiceNow IDE installed on your instance.', 'endpoint_not_found'],
    ['No flows to activate', 'no_flows_to_activate'],
    ['Post-install task "flow-activation" failed: Failed to activate flows: boom', 'task_threw'],
    ['Installed successfully.', 'unknown'],
  ];
  for (const [text, reason] of cases) {
    const p = parseInstall({ stdout: text, stderr: '' });
    assert.equal(p.activationOutcome, 'absent', text);
    assert.equal(p.activationReason, reason, text);
    assert.equal(p.activation, null, 'the legacy field stays null so existing readers are unchanged');
  }
});

test('the raw SDK output is KEPT, bounded, on success as well as failure', () => {
  const src = strip(read('servicenow/fluent.js'));
  const at = src.indexOf('export async function deploy(');
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf('\nexport ', at + 10));
  // Kept on BOTH returns: the failure return and the success return.
  assert.match(body, /const sdkOutput = sdkOutputOf\(res\)/, 'deploy() must capture the SDK output');
  assert.equal((body.match(/\bsdkOutput,/g) ?? []).length, 2,
    'the SDK output must be on the failure return AND the success return');
  // And the capture itself is bounded — the property lives in the helper.
  const helper = src.slice(src.indexOf('function sdkOutputOf('));
  assert.match(helper.slice(0, 600), /SDK_OUTPUT_KEEP/, 'the kept output must be bounded, not unbounded');
  assert.match(src, /const SDK_OUTPUT_KEEP = \d+/);
  // And the install runs at debug level, or the four silent paths stay silent.
  assert.match(body, /'install',\s*'-d'|\['install', '-d'\]/, 'the install must run with -d so the DEBUG activation lines are emitted');
});

test('runSdk pins the log level instead of inheriting the server\'s', () => {
  const src = strip(read('servicenow/fluent.js'));
  const at = src.indexOf('export async function runSdk(');
  const body = src.slice(at, src.indexOf('\n}', src.indexOf('return {', at)));
  assert.match(body, /LOG_LEVEL/, 'runSdk forwards process.env verbatim, so the server LOG_LEVEL leaks into the SDK');
});

/* ------------------------------------------------------------------ *
 * 2. setActive
 * ------------------------------------------------------------------ */

test('there is no REST path that flips sys_hub_flow.active', () => {
  assert.equal(flows.setActive, undefined, 'flows.setActive still exists — it is the shortcut that produces active-without-snapshot');
  const src = strip(read('servicenow/flows.js'));
  assert.doesNotMatch(src, /table\.update\('sys_hub_flow'/, 'a direct REST update of a flow header survives in flows.js');
  // And nothing anywhere else reaches for it.
  const routes = strip(read('routes/flows.js'));
  assert.doesNotMatch(routes, /setActive/);
});

/* ------------------------------------------------------------------ *
 * 3. The published verdict tells the truth about a Test-created snapshot
 * ------------------------------------------------------------------ */

test('a draft header beside a published snapshot states BOTH causes and asserts neither', () => {
  const v = publishedVerdict({
    header: { sys_id: 'f', active: 'false', status: 'draft', latest_snapshot: '' },
    snapshots: [{ sys_id: 's', parent_flow: 'f', status: 'published', active: 'true' }],
  });
  assert.equal(v.published, false);
  assert.equal(v.mismatch, PUBLISH_MISMATCH.HEADER_DRAFT_WITH_PUBLISHED_SNAPSHOT);
  // Measured on dev424910: pressing Test creates exactly this shape. Asserting
  // "the publish did not complete" as the cause is a claim the evidence
  // contradicts, so the note must name both possibilities.
  assert.match(v.note, /Test/i, 'the note must offer the Test-button explanation');
  assert.doesNotMatch(v.note, /the publish did not complete/i, 'the note must not assert a cause it cannot see');
});

test('the other mismatches are unchanged', () => {
  assert.equal(publishedVerdict({ header: { active: 'false', status: 'draft', latest_snapshot: '' }, snapshots: [] }).mismatch,
    PUBLISH_MISMATCH.NO_SNAPSHOT);
  assert.equal(publishedVerdict({
    header: { active: 'true', status: 'published', latest_snapshot: 's' },
    snapshots: [{ sys_id: 's', status: 'published', active: 'true' }],
  }).published, true);
});
