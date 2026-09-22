import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-hbx-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'h.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  /* No reachable model: a proposal that needs one degrades to a skeleton with
     blank values (needs_value). A PRESET rule needs no model and is READY. */
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const { _setTableExistsForTests } = await import('../src/servicenow/schema.js');
const { resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { healthRouter } = await import('../src/routes/health.js');
const { openRun, completeRun } = await import('../src/health/store.js');
const { getProposal, proposalsForFinding } = await import('../src/health/proposal-store.js');
const { proposalFingerprint } = await import('../src/health/proposal.js');
const { BULK_MAX } = await import('../src/health/bulk.js');

/*
 * Bulk Fix, end to end, through the REAL router against a faked instance.
 *
 * What is real: the router, the proposal builder, the proposal store, the plan
 * pipeline, the provenance re-read, the approval binding, the executor's
 * per-record card, the mutation pipeline's read-back and the audit run. Only
 * `fetch` to the instance is faked — and the model is simply unreachable,
 * which is a state the single flow already handles.
 *
 * The property under test is the one the feature is sold on: a batch is the
 * single flow, once per finding — every card still raised, every fingerprint
 * still checked, every result still per record — and a batch of mixed
 * outcomes is reported as exactly that.
 */

const CRED1 = 'c1'.padEnd(32, '0');
const CRED2 = 'c2'.padEnd(32, '0');
const CRED3 = 'c3'.padEnd(32, '0');
const INC = '5f9b83bfc0a8010e005a2b3212c9dc07';
const GRP = '8a4dde73c6112278017a6a4baf547aa7';
const GONE = '0123456789abcdef0123456789abcdef';

let records;
let writes;
const reset = () => {
  records = new Map([
    [`discovery_credentials/${CRED1}`, { sys_id: CRED1, name: 'cred one', active: 'false', sys_mod_count: '1', sys_updated_on: '2026-09-01 10:00:00' }],
    [`discovery_credentials/${CRED2}`, { sys_id: CRED2, name: 'cred two', active: 'false', sys_mod_count: '1', sys_updated_on: '2026-09-01 10:00:00' }],
    [`discovery_credentials/${CRED3}`, { sys_id: CRED3, name: 'cred three', active: 'false', sys_mod_count: '1', sys_updated_on: '2026-09-01 10:00:00' }],
    [`incident/${INC}`, { sys_id: INC, number: 'INC0010001', assignment_group: '', sys_mod_count: '3', sys_updated_on: '2026-09-01 10:00:00' }],
    [`sys_user_group/${GRP}`, { sys_id: GRP, name: 'Network' }],
  ]);
  writes = [];
};
reset();

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return realFetch(url, init);     // the test talking to our own server
  const method = init.method || 'GET';
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const m = u.pathname.match(/^\/api\/now\/table\/([^/]+)(?:\/([^/]+))?$/);
  if (!m || !m[2]) return json(200, { result: [] });
  const rec = records.get(`${m[1]}/${m[2]}`);
  if (!rec) return json(404, { error: { message: 'No Record found', detail: 'Record doesn\'t exist or ACL restricts the record retrieval' } });
  if (method === 'PATCH' || method === 'PUT') {
    const body = JSON.parse(init.body || '{}');
    writes.push({ table: m[1], sys_id: m[2], body });
    Object.assign(rec, body, { sys_mod_count: String(Number(rec.sys_mod_count || 0) + 1), sys_updated_on: '2026-09-22 12:00:00' });
  }
  const all = u.searchParams.get('sysparm_display_value') === 'all';
  const shaped = all ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, { value: v, display_value: v }])) : rec;
  return json(200, { result: shaped });
};
_setTableExistsForTests(async () => true);

const app = express();
app.use(express.json());
app.use('/api/health', healthRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const BASE = `http://127.0.0.1:${server.address().port}/api/health`;
test.after(() => { globalThis.fetch = realFetch; _setTableExistsForTests(null); server.close(); });

/* ── A run with findings of several kinds ──────────────────────────────── */

const fpOf = (rule, table, ids) => crypto.createHash('sha256').update(`${rule}|${table}|${[...ids].sort().join(',')}`).digest('hex');
const finding = (rule, table, ids, over = {}) => ({
  fingerprint: fpOf(rule, table, ids), rule_id: rule, agent_id: 'itom', domain: 'credentials', table,
  severity: 'major', priority: 'P2', priority_score: 50, confidence: 0.9,
  title: `${rule} on ${ids.length} record(s)`, description: 'test', target_ids: ids, evidence: [], ...over,
});
const F_CRED1 = finding('CRED-INACTIVE', 'discovery_credentials', [CRED1]);          // preset → ready, same type as…
const F_CRED2 = finding('CRED-INACTIVE', 'discovery_credentials', [CRED2]);          // …this one
const F_CRED3 = finding('CRED-INACTIVE', 'discovery_credentials', [CRED3]);          // for the mixed batch
const F_INC = finding('ITSM-INC-UNASSIGNED', 'incident', [INC], { agent_id: 'itsm', domain: 'incident' });   // needs a model → needs_value
const F_NOFIX = finding('ITSM-INC-STALE', 'incident', [INC], { agent_id: 'itsm', domain: 'incident' });        // no FIX_FIELD entry
const F_GONE = finding('CRED-INACTIVE', 'discovery_credentials', [GONE]);            // its only record is gone
const runId = openRun();
completeRun(runId, {
  status: 'completed',
  manifest: { modules: ['itom', 'itsm'], coverage: {}, metrics: {}, severity_counts: {} },
  findings: [F_CRED1, F_CRED2, F_CRED3, F_INC, F_NOFIX, F_GONE],
});

/* ── Talking to the server ─────────────────────────────────────────────── */

const get = async (p) => (await realFetch(`${BASE}${p}`)).json();
const post = (p, body = {}, signal = null) => realFetch(`${BASE}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
});
const patch = async (p, body) => (await realFetch(`${BASE}${p}`, {
  method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

/**
 * Read a stream to its terminal frame, answering each executor card as it
 * arrives — through `resolveApproval`, the one resolver, exactly as
 * POST /api/agent/approve does. `answer(frame)` plays the human: true, false,
 * or `null` to leave the card unanswered.
 */
async function drive(res, { answer = () => true, onFrame = () => {} } = {}) {
  assert.equal(res.status, 200, `stream refused: ${res.status}`);
  const frames = [];
  const sessions = new Map();   // item → sessionId
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const f = JSON.parse(line.slice(6));
        frames.push(f);
        onFrame(f);
        if (f.type === 'execution_started') sessions.set(f.item ?? '_', f.sessionId);
        if (f.type === 'approval_required') {
          const a = answer(f);
          if (a !== null) {
            const r = resolveApproval(sessions.get(f.item ?? '_'), f.approvalId, a, APPROVAL_SOURCES.USER_CLICK, f.nonce);
            frames.push({ type: '_answered', item: f.item, ok: r.ok });
          }
        }
      }
    }
  }
  return frames;
}

const terminal = (frames) => frames.find((f) => ['done', 'error', 'cancelled'].includes(f.type));

/* ══════════════════════════════════════════════════════════════════════════
   PROPOSALS — one per finding, each its own row, classified from its facts
   ══════════════════════════════════════════════════════════════════════════ */

let proposed;
test('PROPOSALS — six findings of four kinds each get their own proposal and their own status', async () => {
  reset();
  const items = [F_CRED1, F_CRED2, F_CRED3, F_INC, F_NOFIX, F_GONE].map((f) => ({ runId, fingerprint: f.fingerprint }));
  const stale = { runId, fingerprint: 'f'.repeat(64) };     // never in this run
  const frames = await drive(await post('/bulk/proposals', { items: [...items, stale] }));
  const done = terminal(frames);
  assert.equal(done?.type, 'done', 'no terminal frame');
  assert.equal(done.items.length, 7);
  const by = Object.fromEntries(done.items.map((it) => [it.fingerprint, it]));
  assert.equal(by[F_CRED1.fingerprint].status, 'proposed');
  assert.equal(by[F_CRED2.fingerprint].status, 'proposed');
  assert.equal(by[F_CRED3.fingerprint].status, 'proposed');
  assert.equal(by[F_INC.fingerprint].status, 'needs_value', 'no model → blank value → needs a human, not a guess');
  assert.equal(by[F_NOFIX.fingerprint].status, 'no_field_fix');
  assert.equal(by[F_GONE.fingerprint].status, 'stale');
  assert.equal(by[stale.fingerprint].status, 'stale');
  /* Every proposed item carries a stored proposal and the fingerprint the
     reviewer will approve — the same hash the single drawer approves with. */
  for (const it of done.items.filter((x) => x.proposalId)) {
    const row = getProposal(it.proposalId);
    assert.ok(row, 'the proposal row was not stored');
    assert.equal(row.status, 'draft');
    assert.equal(it.proposalFingerprint, proposalFingerprint(row.proposal));
  }
  assert.ok(frames.some((f) => f.type === 'item_proposed'), 'no per-item progress frame');
  assert.equal(writes.length, 0, 'generating proposals wrote to the instance');
  proposed = by;
});

test('PROPOSALS — the selection cap is the server\'s, and a batch over it is refused whole', async () => {
  const items = Array.from({ length: BULK_MAX + 1 }, (_, i) => ({ runId, fingerprint: i.toString(16).padStart(64, '0') }));
  const res = await post('/bulk/proposals', { items });
  assert.equal(res.status, 413);
  assert.equal((await get('/meta')).bulk.max, BULK_MAX);
});

/* ══════════════════════════════════════════════════════════════════════════
   APPROVE — the single flow, once per proposal
   ══════════════════════════════════════════════════════════════════════════ */

test('APPROVE — two findings of the same type and one of another apply, each behind its own card, each read back', async () => {
  reset();
  /* The reviewer supplies the value the model could not — the same PATCH the
     single drawer uses — and approves the fingerprint of THAT version. */
  const inc = proposed[F_INC.fingerprint];
  const edited = await patch(`/proposals/${inc.proposalId}`, {
    proposal: { changes: inc.proposal.proposal.changes.map((c) => ({ ...c, proposedValue: GRP })) },
  });
  assert.notEqual(edited.fingerprint, inc.proposalFingerprint, 'editing did not move the fingerprint');

  const items = [
    { proposalId: proposed[F_CRED1.fingerprint].proposalId, fingerprint: proposed[F_CRED1.fingerprint].proposalFingerprint },
    { proposalId: proposed[F_CRED2.fingerprint].proposalId, fingerprint: proposed[F_CRED2.fingerprint].proposalFingerprint },
    { proposalId: inc.proposalId, fingerprint: edited.fingerprint },
  ];
  const frames = await drive(await post('/bulk/approve', { items }));
  const done = terminal(frames);
  assert.equal(done?.type, 'done', `no terminal frame: ${JSON.stringify(frames.at(-1))}`);

  assert.equal(frames.filter((f) => f.type === 'approval_required').length, 3, 'one card per record was not raised');
  assert.ok(frames.filter((f) => f.type === '_answered').every((f) => f.ok), 'a card could not be answered through the resolver');
  /* Every inner frame names its item, so a page can route a card to the right session. */
  for (const f of frames.filter((x) => ['approval_required', 'execution_started', 'step_started'].includes(x.type))) {
    assert.ok(f.item, `${f.type} frame carries no item`);
  }

  assert.deepEqual(writes.map((w) => [w.table, w.sys_id, w.body]), [
    ['discovery_credentials', CRED1, { active: 'true' }],
    ['discovery_credentials', CRED2, { active: 'true' }],
    ['incident', INC, { assignment_group: GRP }],
  ], 'the writes are not exactly the three approved changes, in order');

  assert.deepEqual(done.items.map((it) => it.status), ['applied', 'applied', 'applied']);
  assert.equal(done.summary.ok, true);
  assert.equal(done.summary.applied, 3);
  for (const it of done.items) {
    assert.equal(it.result.validation.ok, true, 'a read-back did not confirm the value');
    assert.equal(getProposal(it.proposalId).status, 'applied');
    assert.ok(getProposal(it.proposalId).taskId, 'no task was recorded — the audit trail is missing');
  }
});

test('APPROVE — a mixed batch reports every outcome separately and never rounds up', async () => {
  reset();
  const cred3 = proposed[F_CRED3.fingerprint];
  const nofix = proposed[F_NOFIX.fingerprint];
  const already = proposed[F_CRED1.fingerprint];           // applied in the previous test
  const items = [
    { proposalId: cred3.proposalId, fingerprint: cred3.proposalFingerprint },             // card will be REJECTED
    { proposalId: nofix.proposalId, fingerprint: nofix.proposalFingerprint },             // nothing executable
    { proposalId: already.proposalId, fingerprint: already.proposalFingerprint },         // already decided
    { proposalId: crypto.randomUUID(), fingerprint: 'a'.repeat(64) },                     // no such proposal
  ];
  const frames = await drive(await post('/bulk/approve', { items }), { answer: () => false });
  const done = terminal(frames);
  assert.equal(done?.type, 'done');
  assert.deepEqual(done.items.map((it) => it.status), ['failed', 'no_field_fix', 'already_decided', 'stale']);
  assert.match(done.items[0].note, /rejected/i, 'the rejected card\'s reason did not reach the item');
  assert.equal(writes.length, 0, 'a rejected card, a no-fix or a decided proposal still wrote');
  assert.equal(done.summary.ok, false);
  assert.equal(done.summary.failed, 1);
  assert.equal(done.summary.skipped, 3);
  assert.match(done.summary.note, /1 failed/);
  assert.match(done.summary.note, /3 skipped/);
  /* The already-applied proposal was not touched: still applied, same task. */
  assert.equal(getProposal(already.proposalId).status, 'applied');
});

test('APPROVE — a fingerprint for a version the reviewer did not see runs nothing for that item, and the rest go on', async () => {
  reset();
  /* A fresh proposal for the rejected finding — a rejection is not a route back. */
  const fresh = terminal(await drive(await post('/bulk/proposals', { items: [{ runId, fingerprint: F_CRED3.fingerprint }] })));
  const cred3 = fresh.items[0];
  assert.equal(cred3.status, 'proposed');
  /* And the incident again, now that it is applied: a new proposal reads the
     live value, so the finding is "already fixed" — flagged, not hidden. */
  const again = terminal(await drive(await post('/bulk/proposals', { items: [{ runId, fingerprint: F_INC.fingerprint }] }))).items[0];
  assert.ok(again.priorProposal, 'a finding with an applied proposal in this run was not flagged');
  assert.equal(again.priorProposal.status, 'applied');

  const items = [
    { proposalId: cred3.proposalId, fingerprint: 'b'.repeat(64) },                 // stale hash
    { proposalId: cred3.proposalId, fingerprint: cred3.proposalFingerprint },      // duplicate id → deduped, not re-run
  ];
  const frames = await drive(await post('/bulk/approve', { items }));
  const done = terminal(frames);
  assert.equal(done.items.length, 1, 'a duplicated proposal id became two attempts');
  assert.equal(done.items[0].status, 'failed');
  assert.match(done.items[0].note, /changed after it was shown/);
  assert.equal(writes.length, 0);
  /* The proposal itself is untouched by a refused approval: still approvable. */
  assert.equal(getProposal(cred3.proposalId).status, 'draft');

  /* …and approving the version that was actually seen still works. */
  const ok = terminal(await drive(await post('/bulk/approve', { items: [{ proposalId: cred3.proposalId, fingerprint: cred3.proposalFingerprint }] })));
  assert.equal(ok.items[0].status, 'applied');
  assert.equal(writes.length, 1);
});

test('APPROVE — stopping a batch cancels the waiting card and leaves later items NOT STARTED', async () => {
  reset();
  records.get(`discovery_credentials/${CRED1}`).active = 'false';
  records.get(`discovery_credentials/${CRED2}`).active = 'false';
  const fresh = terminal(await drive(await post('/bulk/proposals', {
    items: [{ runId, fingerprint: F_CRED1.fingerprint }, { runId, fingerprint: F_CRED2.fingerprint }],
  })));
  const [a, b] = fresh.items;
  assert.equal(a.status, 'proposed');
  assert.equal(b.status, 'proposed');

  const controller = new AbortController();
  const res = await post('/bulk/approve', {
    items: [{ proposalId: a.proposalId, fingerprint: a.proposalFingerprint }, { proposalId: b.proposalId, fingerprint: b.proposalFingerprint }],
  }, controller.signal);
  /* Leave the first card unanswered and walk away, as closing the drawer does. */
  await assert.rejects(drive(res, {
    answer: () => null,
    onFrame: (f) => { if (f.type === 'approval_required') setTimeout(() => controller.abort(), 20); },
  }));

  /* The server settles: first item failed at its card (never authorised),
     second never reached. Nothing written. */
  const until = Date.now() + 5000;
  while (getProposal(a.proposalId).status === 'draft' && Date.now() < until) await new Promise((r) => { setTimeout(r, 25); });
  assert.notEqual(getProposal(a.proposalId).status, 'applied');
  assert.equal(getProposal(b.proposalId).status, 'draft', 'the second item ran after the reviewer left');
  assert.equal(writes.length, 0, 'a write went out after the batch was stopped');
});

/* ══════════════════════════════════════════════════════════════════════════
   THE SINGLE FLOW IS UNCHANGED
   ══════════════════════════════════════════════════════════════════════════ */

test('SINGLE — Approve and apply on one proposal still works exactly as before, through the same sequence', async () => {
  reset();
  records.get(`discovery_credentials/${CRED2}`).active = 'false';
  const made = await (await post(`/runs/${runId}/findings/${F_CRED2.fingerprint}/proposal`)).json();
  assert.equal(made.state, 'Proposed changes — not yet applied');
  const frames = await drive(await post(`/proposals/${made.proposal.id}/approve`, { fingerprint: made.fingerprint }));
  const done = terminal(frames);
  assert.equal(done?.type, 'done', done?.message);
  assert.equal(done.proposal.status, 'applied');
  assert.equal(frames.filter((f) => f.type === 'approval_required').length, 1);
  assert.ok(!frames.some((f) => f.type !== '_answered' && 'item' in f), 'the single route tags frames with an item — the bulk shape leaked');
  assert.deepEqual(writes, [{ table: 'discovery_credentials', sys_id: CRED2, body: { active: 'true' } }]);
  assert.equal(proposalsForFinding(runId, F_CRED2.fingerprint)[0].status, 'applied');
});

test('SINGLE — a settled proposal is refused with 409 by the single route, as before', async () => {
  const p = proposalsForFinding(runId, F_CRED2.fingerprint)[0];
  const res = await post(`/proposals/${p.id}/approve`, { fingerprint: p.proposalFingerprint });
  assert.equal(res.status, 409);
});

/* ══════════════════════════════════════════════════════════════════════════
   THE ROUTER'S SHAPE — what the inventory and the page rely on
   ══════════════════════════════════════════════════════════════════════════ */

test('the list rows say whether a finding is auto-fixable, from the same registry the proposal reads', async () => {
  const { findings } = await get(`/runs/${runId}/findings?limit=50`);
  const by = Object.fromEntries(findings.map((f) => [f.fingerprint, f]));
  assert.equal(by[F_CRED1.fingerprint].fixable, true);
  assert.equal(by[F_INC.fingerprint].fixable, true);
  assert.equal(by[F_NOFIX.fingerprint].fixable, false);
});

test('both writing routes go through ONE sequence — bulk is not a second path to a mutation', () => {
  const src = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../src/routes/health.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal((src.match(/\bapprovePlan\s*\(/g) || []).length, 1, 'approvePlan is bound in more than one place');
  assert.equal((src.match(/\bprepareRemediation\s*\(/g) || []).length, 1);
  assert.equal((src.match(/\brunRemediation\s*\(/g) || []).length, 1);
  assert.equal((src.match(/await applyProposal\s*\(/g) || []).length, 2, 'the two writing routes do not both use applyProposal');
  const bulk = src.slice(src.indexOf("healthRouter.post('/bulk/approve'"));
  assert.match(bulk, /res\.on\('close'/, 'the bulk route does not cancel when its page goes away');
  assert.ok(!/liveHealthRuns/.test(bulk), 'the bulk route reaches the read-only run registry');
  assert.ok(!/autoApprove/.test(src), 'a route threads auto-approve through');
});
