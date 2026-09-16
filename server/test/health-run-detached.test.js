import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-hrd-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'h.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const { healthRouter } = await import('../src/routes/health.js');
const { openRun, getRun, INTERRUPTED_NOTE } = await import('../src/health/store.js');

/*
 * Health Assist — a check belongs to the server, not to the page watching it.
 *
 * THE TWO FAILURES THIS FILE EXISTS FOR, both reported from real use:
 *
 *   1. Starting a check and going to another page lost it. Coming back showed
 *      "Check again", and pressing it answered "A health check is already
 *      running against this instance" — with nothing on screen to watch.
 *   2. Closing the project mid-check, and even restarting the PC, still
 *      answered "already running", because the row stayed at `running` and
 *      only a thirty-minute timeout cleared it.
 *
 * The real router and the real extraction run here; only the INSTANCE is faked,
 * slowly, so a check is still going while the test leaves and comes back.
 */

let delayMs = 0;
let instanceCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname === '127.0.0.1') return realFetch(url, init);     // the test talking to our own server
  instanceCalls += 1;
  if (delayMs) await new Promise((r) => { setTimeout(r, delayMs); });
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.pathname.startsWith('/api/now/stats/')) return json({ result: { stats: { count: '0' } } });
  return json({ result: [] });
};

const app = express();
app.use(express.json());
app.use('/api/health', healthRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const BASE = `http://127.0.0.1:${server.address().port}/api/health`;
test.after(() => { globalThis.fetch = realFetch; server.close(); });

/** Read SSE frames until `until(frame)` is true or the stream ends. */
async function readFrames(res, until = () => false) {
  const frames = [];
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
        const frame = JSON.parse(line.slice(6));
        frames.push(frame);
        if (until(frame)) { await reader.cancel().catch(() => {}); return frames; }
      }
    }
  }
  return frames;
}

const get = async (p) => (await realFetch(`${BASE}${p}`)).json();
const post = (p, body = {}) => realFetch(`${BASE}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function waitFor(fn, { timeoutMs = 20000, stepMs = 50 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => { setTimeout(r, stepMs); });
  }
}

const TERMINAL = new Set(['done', 'error', 'cancelled']);

test('THE REBOOT BUG — a row left at "running" by a server that stopped does not block a new check', async () => {
  const stale = openRun();                    // what a server closed mid-check leaves behind: recent, and owned by nobody
  const active = await get('/runs/active');
  assert.equal(active.run, null, 'a check nothing is running still reads as running');
  assert.equal(getRun(stale).status, 'failed');
  assert.equal(getRun(stale).error, INTERRUPTED_NOTE, 'the interrupted run does not say what happened to it');

  const res = await post('/runs', { explain: false });
  assert.equal(res.status, 200, 'a new check was refused — the stale lock is still there');
  const frames = await readFrames(res, (f) => TERMINAL.has(f.type));
  assert.equal(frames.at(-1).type, 'done');
});

test('LEAVING THE PAGE — closing the stream stops watching, not the check; it is found and watched again', async () => {
  delayMs = 40;
  try {
    const controller = new AbortController();
    const res = await realFetch(`${BASE}/runs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ explain: false }), signal: controller.signal,
    });
    const first = await readFrames(res, (f) => f.type === 'run_started');
    const runId = first.at(-1).runId;
    assert.ok(runId);
    controller.abort();                        // the page navigated away
    const callsAtLeave = instanceCalls;

    const active = await waitFor(async () => (await get('/runs/active')).run);
    assert.equal(active.id, runId, 'the check was not still running after the page left');

    const second = await post('/runs', { explain: false });
    assert.equal(second.status, 409, 'a second check started beside the first');
    const refusal = await second.json();
    assert.equal(refusal.runId, runId, 'the refusal does not say which check to watch instead');

    await waitFor(() => instanceCalls > callsAtLeave + 2);   // it kept reading the instance with nobody watching

    const again = await realFetch(`${BASE}/runs/${runId}/stream`);
    const watched = await readFrames(again, (f) => TERMINAL.has(f.type));
    assert.equal(watched[0].type, 'run_started');
    assert.equal(watched[0].reattached, true);
    assert.equal(watched.at(-1).type, 'done', 'watching again did not reach the end of the check');
    assert.equal(watched.filter((f) => TERMINAL.has(f.type)).length, 1, 'more than one terminal frame');
    assert.ok(['completed', 'partial'].includes(getRun(runId).status), `the check ended as ${getRun(runId).status}, not as a finished run`);
    assert.equal((await get('/runs/active')).run, null);
  } finally { delayMs = 0; }
});

test('coming back AFTER it finished still learns how it finished — one terminal frame', async () => {
  const res = await post('/runs', { explain: false });
  const frames = await readFrames(res, (f) => TERMINAL.has(f.type));
  const runId = frames[0].runId;
  const later = await readFrames(await realFetch(`${BASE}/runs/${runId}/stream`));
  assert.deepEqual(later.map((f) => f.type), ['done']);
});

test('STOP is an explicit request: it cancels the check, and the watcher sees "cancelled", not a failure', async () => {
  delayMs = 60;
  try {
    /* A full re-read: an earlier test already scanned this fake instance, and an
       unchanged instance is now verified in moments — too fast to stop. */
    const res = await post('/runs', { explain: false, reuse: false });
    const reading = readFrames(res, (f) => TERMINAL.has(f.type));
    const { run } = await waitFor(async () => { const r = await get('/runs/active'); return r.run ? r : null; });
    const stop = await (await post(`/runs/${run.id}/cancel`)).json();
    assert.equal(stop.ok, true);
    const frames = await reading;
    assert.equal(frames.at(-1).type, 'cancelled');
    assert.equal(getRun(run.id).status, 'cancelled');

    const late = await post(`/runs/${run.id}/cancel`);
    assert.equal(late.status, 409, 'cancelling a finished check claimed to succeed');
  } finally { delayMs = 0; }
});

/* ── Module scans (15 Sep 2026) ─────────────────────────────────────────── */

test('MODULES — an unknown module is refused before a run exists; a module scan becomes only that module\'s result', async () => {
  const before = (await get('/runs')).runs.length;
  const bad = await post('/runs', { modules: ['hr'], explain: false });
  assert.equal(bad.status, 422);
  assert.match((await bad.json()).message, /Unknown scan module: hr/);
  assert.equal((await get('/runs')).runs.length, before, 'a refused scan left a run row behind');

  const res = await post('/runs', { modules: ['itsm'], reuse: false, explain: false });
  const frames = await readFrames(res, (f) => TERMINAL.has(f.type));
  assert.equal(frames.at(-1).type, 'done');
  const runId = frames[0].runId;
  const { modules, view } = await get('/modules');
  assert.equal(modules.itsm.runId, runId);
  assert.notEqual(modules.cmdb.runId, runId, 'an ITSM scan became the CMDB result');
  assert.ok(modules.cmdb.checkedAt, 'CMDB lost its own result and time');
  assert.equal(view.composed, true);
  assert.ok(view.manifest.scopes.itsm && view.manifest.scopes.cmdb, 'the All view is missing a module');
  const list = await get('/modules/findings?scope=all&limit=5');
  assert.ok(Array.isArray(list.findings));
});

test('SCAN STATE — the configuration table lists every allow-listed table; a toggle must be a boolean on a known table', async () => {
  const { TABLES } = await import('../src/health/tables.js');
  const state = await get('/scan-state');
  assert.equal(state.tables.length, Object.keys(TABLES).length);
  assert.equal(state.defaults.maxReuseHours, 24);
  const patch = (t, body) => realFetch(`${BASE}/scan-state/${t}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await patch('sys_trigger', { enabled: 'no' })).status, 422);
  assert.equal((await patch('sys_user', { enabled: false })).status, 422, 'a table outside the allow-list was configured');
  assert.equal((await patch('sys_trigger', { enabled: false })).status, 200);
  assert.equal((await get('/scan-state')).tables.find((t) => t.table === 'sys_trigger').enabled, false);
});
