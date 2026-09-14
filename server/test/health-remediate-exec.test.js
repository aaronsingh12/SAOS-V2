import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-hrx-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'h.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const { _setTableExistsForTests } = await import('../src/servicenow/schema.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { approvePlan, loadPlan } = await import('../src/agent/plan/index.js');
const { checkWriteTarget, provenanceFor } = await import('../src/memory/provenance.js');
const { createSession } = await import('../src/memory/sessions.js');
const { prepareRemediation, runRemediation, observeTargets } = await import('../src/health/remediate.js');
const { proposalFingerprint } = await import('../src/health/proposal.js');

/*
 * Health Assist — Approve and apply, end to end, against a faked instance.
 *
 * THE FAILURE THIS FILE EXISTS FOR, reported from techsnitchpvtltddemo2:
 * pressing Approve and apply in the remediation drawer came back
 *
 *   BLOCKED: sys_id 5f9b83bfc0a8010e005a2b3212c9dc07 has never appeared in
 *   this session. It was not submitted to the approval gate and nothing was
 *   changed.
 *
 * with "✗ not applied · read-back read_back" and "Validation failed — 0 of 1",
 * while the same change through Discuss in Agent landed. The provenance guard
 * was right: Health Assist's reads happen outside any session, so the
 * remediation session had seen nothing. The fix is that remediation reads its
 * targets in its own session first — not an exemption from the guard.
 *
 * Only `fetch` is faked. The plan pipeline, the provenance guard, the approval
 * gate, the mutation pipeline's read-back and the proposal store are all real.
 */

const INC = '5f9b83bfc0a8010e005a2b3212c9dc07';
const GRP = '8a4dde73c6112278017a6a4baf547aa7';
const GONE = '0123456789abcdef0123456789abcdef';

let records;
let writes;
let dropWrites = false;
const reset = () => {
  records = new Map([
    [`incident/${INC}`, {
      sys_id: INC, number: 'INC0010001', assignment_group: '', sys_mod_count: '3', sys_updated_on: '2026-09-01 10:00:00',
    }],
    [`sys_user_group/${GRP}`, { sys_id: GRP, name: 'Network' }],
  ]);
  writes = [];
  dropWrites = false;
};
reset();

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method || 'GET';
  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const m = u.pathname.match(/^\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/);
  if (!m || !m[2]) return json(200, { result: [] });
  const rec = records.get(`${m[1]}/${m[2]}`);
  if (!rec) return json(404, { error: { message: 'No Record found', detail: 'Record doesn\'t exist or ACL restricts the record retrieval' } });
  if (method === 'PATCH' || method === 'PUT') {
    const body = JSON.parse(init.body || '{}');
    writes.push({ table: m[1], sys_id: m[2], body });
    if (!dropWrites) {
      Object.assign(rec, body, { sys_mod_count: String(Number(rec.sys_mod_count || 0) + 1), sys_updated_on: '2026-09-14 12:00:00' });
    }
  }
  const all = u.searchParams.get('sysparm_display_value') === 'all';
  const shaped = all
    ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, { value: v, display_value: v }]))
    : rec;
  return json(200, { result: shaped });
};
_setTableExistsForTests(async () => true);
test.after(() => { globalThis.fetch = realFetch; _setTableExistsForTests(null); });

/** The same seam the route passes: a read through the one client. */
const { readRecord } = await import('../src/health/instance-read.js');

const proposalFor = (over = {}) => ({
  ruleId: 'ITSM-INC-UNASSIGNED',
  title: 'Open incidents with no assignment group',
  table: 'incident',
  field: 'assignment_group',
  operation: 'update',
  changes: [{
    id: 'c1', table: 'incident', sys_id: INC, label: 'INC0010001',
    field: 'assignment_group', fieldKind: 'reference', references: 'sys_user_group',
    currentValue: '', currentDisplay: '', proposedValue: GRP, proposedDisplay: 'Network',
    status: 'ready', ...over,
  }],
});

let n = 0;
const newProposalId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

/**
 * Drive the route's sequence exactly: prepare → bind (approvePlan, user_click)
 * → run. `answer` plays the human at the per-record card, through the one
 * resolver, as POST /api/agent/approve does.
 */
async function approveAndApply(proposal, { answer = true } = {}) {
  const proposalId = newProposalId();
  const frames = [];
  let sessionId = null;
  const emit = (e) => {
    frames.push(e);
    if (e.type === 'execution_started') sessionId = e.sessionId;
    if (e.type === 'approval_required' && answer !== null) {
      setImmediate(() => {
        frames.push({ type: '_answered', ok: resolveApproval(sessionId, e.approvalId, answer, APPROVAL_SOURCES.USER_CLICK, e.nonce).ok });
      });
    }
  };
  const prep = await prepareRemediation({
    proposalId, proposal, runId: 'run-1', presentedFingerprint: proposalFingerprint(proposal), emit, readRecord,
  });
  if (!prep.ok) return { prep, frames };
  const bound = approvePlan(prep.taskId, prep.planFingerprint, { source: 'user_click' });
  assert.equal(bound.ok, true, `the plan could not be bound: ${bound.reason}`);
  const run = await runRemediation({
    proposalId, proposal, taskId: prep.taskId, sessionId: prep.sessionId, changes: prep.changes, emit, readRecord,
  });
  return { prep, run, frames, sessionId: prep.sessionId };
}

test('THE REPORTED BUG — before the fix, the guard had nothing to go on in a fresh remediation session', () => {
  const sessionId = 'health-never-read';
  createSession({ id: sessionId });
  assert.equal(checkWriteTarget({ sessionId, sysId: INC }).verdict, 'confabulated',
    'a fresh session already knows this sys_id, so this test no longer reproduces the failure');
});

test('observeTargets registers the target AND the referenced record through the ordinary producer', async () => {
  reset();
  const sessionId = 'health-observe';
  createSession({ id: sessionId });
  const seen = await observeTargets({ sessionId, changes: proposalFor().changes, readRecord });
  assert.equal(seen.ok, true, seen.note);
  assert.equal(seen.observed, 2);
  assert.equal(checkWriteTarget({ sessionId, sysId: INC }).verdict, 'ok');
  assert.equal(checkWriteTarget({ sessionId, sysId: GRP }).verdict, 'ok');
  assert.ok(provenanceFor(sessionId).every((r) => r.source === 'tool_result'),
    'provenance was registered by something other than the tool-result producer');
});

test('observeTargets refuses — loudly, naming the record — when a target cannot be read', async () => {
  reset();
  const sessionId = 'health-observe-gone';
  createSession({ id: sessionId });
  const seen = await observeTargets({ sessionId, changes: proposalFor({ sys_id: GONE }).changes, readRecord });
  assert.equal(seen.ok, false);
  assert.equal(seen.reason, 'target_unreadable');
  assert.match(seen.note, new RegExp(GONE));
  assert.match(seen.note, /nothing was applied/i);
  assert.notEqual(checkWriteTarget({ sessionId, sysId: GONE }).verdict, 'ok',
    'a record that could not be read was registered as seen');
});

test('observeTargets refuses without a reader rather than skipping the observation', async () => {
  const seen = await observeTargets({ sessionId: 'health-no-reader', changes: proposalFor().changes });
  assert.equal(seen.ok, false);
  assert.equal(seen.reason, 'no_reader');
});

test('APPROVE AND APPLY — the write lands, is read back, and validates, with a card answered per record', async () => {
  reset();
  const { prep, run, frames } = await approveAndApply(proposalFor());
  assert.equal(prep.ok, true, prep.note);
  assert.ok(!frames.some((f) => f.type === 'step_failed' && /BLOCKED/.test(f.note || '')),
    'the step was still blocked as a confabulated sys_id');
  assert.equal(frames.filter((f) => f.type === 'approval_required').length, 1,
    'the executor did not ask its per-record gate');
  assert.ok(frames.some((f) => f.type === '_answered' && f.ok), 'the card could not be answered through the resolver');

  assert.equal(writes.length, 1, 'the write was not sent exactly once');
  assert.deepEqual(writes[0].body, { assignment_group: GRP });
  assert.equal(run.ok, true, run.note);
  assert.equal(run.status, 'applied');
  assert.equal(run.results[0].ok, true);
  assert.notEqual(run.results[0].verdict, 'read_back',
    'the verdict is the plan\'s declared strategy again, not the read-back result');
  assert.equal(run.validation.ok, true);
  assert.equal(run.validation.cleared, 1);
});

test('a record the human skips at the card is not written, says why, and is not "validated"', async () => {
  reset();
  const { run } = await approveAndApply(proposalFor(), { answer: false });
  assert.equal(writes.length, 0, 'a rejected card still wrote');
  assert.equal(run.results[0].ok, false);
  assert.match(String(run.results[0].note), /rejected/i, 'the reason never reached the result row');
  assert.equal(run.validation.skipped, true);
  assert.notEqual(run.status, 'applied');
});

test('a write the instance silently drops comes back not-applied with the read-back verdict, never success', async () => {
  reset();
  dropWrites = true;
  const { run } = await approveAndApply(proposalFor());
  assert.equal(writes.length, 1);
  assert.equal(run.results[0].ok, false, 'a dropped write was reported as applied');
  assert.ok(run.results[0].note, 'a failed write carries no reason');
  assert.notEqual(run.status, 'applied');
});

test('a target deleted since the proposal stops BEFORE a plan exists — nothing is sent', async () => {
  reset();
  const { prep, run, frames } = await approveAndApply(proposalFor({ sys_id: GONE }));
  assert.equal(prep.ok, false);
  assert.equal(prep.reason, 'target_unreadable');
  assert.equal(run, undefined);
  assert.equal(writes.length, 0);
  assert.ok(!frames.some((f) => f.type === 'plan_created'), 'a plan was built for a record that could not be read');
  assert.equal(loadPlan(prep.taskId)?.steps?.length ?? 0, 0);
});

/* ── The drawer: the client half of the same failure ─────────────────────── */

const CLIENT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../client/src');
const readClient = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('no Health Assist stream handler signals failure by throwing — sse() swallows handler exceptions', () => {
  const API = readClient('api.js');
  assert.match(API, /try \{ onEvent\(evt\); \}\s*catch/, 'sse() no longer catches handler throws; this guard is moot');
  for (const rel of ['components/RemediationDrawer.jsx', 'pages/HealthAssist.jsx']) {
    const src = stripComments(readClient(rel));
    assert.ok(!/evt\.type === 'error'\)[^\n;]*throw /.test(src) && !/evt\.type === 'error'\) \{[^}]*throw /.test(src),
      `${rel} throws inside an sse handler on an error frame — the throw is swallowed and success is reported`);
  }
});

test('the drawer renders the executor\'s per-record card and answers it through the one resolver', () => {
  const src = stripComments(readClient('components/RemediationDrawer.jsx'));
  assert.match(src, /evt\.type === 'approval_required'/, 'the drawer ignores the executor\'s approval card');
  assert.match(src, /evt\.type === 'approval_resolved'/);
  assert.match(src, /api\.post\('\/agent\/approve'/, 'the card is not answered through POST /api/agent/approve');
  assert.match(src, /nonce: gate\.nonce/, 'the answer does not carry the card\'s nonce');
  assert.match(src, /evt\.sessionId/, 'the drawer does not take the session from the stream');
  assert.match(src, /validation\.skipped/, 'a skipped validation would render as "Validation failed — 0 of 0"');
  assert.match(src, /signal: controller\.signal/, 'closing the drawer cannot stop a waiting gate');
});

test('the frames the drawer reads are frames the server emits', () => {
  const R = fs.readFileSync(path.resolve(CLIENT, '../../server/src/health/remediate.js'), 'utf8');
  for (const type of ['targets_observing', 'plan_created', 'execution_started', 'execution_complete']) {
    assert.match(R, new RegExp(`type: '${type}'`), `remediate.js no longer emits ${type}`);
  }
  assert.match(R, /type: 'execution_started', taskId, sessionId/);
  const ROUTE = fs.readFileSync(path.resolve(CLIENT, '../../server/src/routes/health.js'), 'utf8');
  const prep = ROUTE.slice(ROUTE.indexOf('prepareRemediation({'), ROUTE.indexOf('let result = prep;'));
  assert.match(stripComments(prep), /readRecord,/, 'the route does not hand prepareRemediation a reader');
});
