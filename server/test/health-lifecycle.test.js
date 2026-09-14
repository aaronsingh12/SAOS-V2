import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-hl-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'h.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false },
});

const {
  setFindingState, getFindingState, clearFindingState, stateMap, summarise,
  FINDING_STATES, QUIET_STATES, STATE_VOCABULARY,
} = await import('../src/health/finding-state.js');
const {
  openRun, completeRun, cancelRun, runInFlight, trend, listFindings, getRun, abandonOrphanedRuns, INTERRUPTED_NOTE,
} = await import('../src/health/store.js');
const { getDb } = await import('../src/memory/db.js');

/*
 * Health Assist — the finding lifecycle, and the production guards around a run.
 *
 * The lifecycle exists because a health checker that re-reports 900 findings
 * every run, with no way to say "we know, and we accepted it", gets ignored —
 * and being ignored is a worse failure than a few false positives. These tests
 * guard the line that keeps that honest: muting changes PRESENTATION and
 * nothing else.
 */

const finding = (over = {}) => ({
  fingerprint: 'fp1', rule_id: 'CMDB-OWNER', agent_id: 'cmdb_agent', domain: 'CMDB',
  table: 'cmdb_ci', severity: 'MEDIUM', priority: 'P3', priority_score: 4, confidence: 1,
  title: 'CI has no owner: web-01', description: 'empty', recommendation: 'ask',
  target_ids: ['a'], evidence: [], impact: null, ...over,
});

/* ── The lifecycle ─────────────────────────────────────────────────────── */

test('a decision state REQUIRES a reason; a triage state does not', () => {
  /*
   * "Muted" with no reason is indistinguishable from a finding nobody
   * explained. The next person needs to be able to tell an accepted risk from
   * an unexplained silence.
   */
  for (const state of ['muted', 'accepted']) {
    const bad = setFindingState(`no-reason-${state}`, { state });
    assert.equal(bad.ok, false, `${state} was accepted with no reason`);
    assert.equal(bad.reason, 'reason_required');
    assert.match(bad.note, /accepted risk from an unexplained silence/);

    const good = setFindingState(`ok-${state}`, { state, reason: 'known and agreed' });
    assert.equal(good.ok, true);
  }
  // Acknowledged is triage, not a decision — no reason needed.
  assert.equal(setFindingState('ack', { state: 'acknowledged' }).ok, true);
});

test('an unknown state is refused with the allowed list', () => {
  const r = setFindingState('x', { state: 'ignored_forever' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.allowed, FINDING_STATES);
});

test('the decision is always attributed to a user click — nothing else may decide', () => {
  /*
   * A model that could mute its own findings would be a model that can hide its
   * own mistakes. The source is fixed in code rather than taken from a caller.
   */
  setFindingState('fp-src', { state: 'acknowledged' });
  assert.equal(getFindingState('fp-src').decidedSource, 'user_click');

  /*
   * Asserted on the SQL rather than by pattern-matching the whole file: the
   * provenance is a literal in the INSERT, so there is no parameter a caller
   * could supply it through.
   */
  const SRC = fs.readFileSync(new URL('../src/health/finding-state.js', import.meta.url), 'utf8');
  assert.match(SRC, /VALUES \(\?,\?,\?,\?,\?,\?,\?, 'user_click', \?, \?\)/,
    'the decision source is no longer a fixed literal in the insert');
  // And `setFindingState` takes no source argument to override it with.
  const signature = /export function setFindingState\(fingerprint, \{([^}]*)\}/.exec(SRC)?.[1] ?? '';
  assert.equal(/source/i.test(signature), false,
    `setFindingState accepts a source parameter: ${signature.trim()}`);
});

test('an expired snooze reads as OPEN again, without a background job', () => {
  /*
   * There is no sweeper in this app. A state that quietly stayed muted past its
   * own end date would be the permanent blind spot `expires_at` exists to
   * prevent, so expiry is computed at read time.
   */
  setFindingState('fp-exp', {
    state: 'muted', reason: 'until the migration lands',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const s = getFindingState('fp-exp');
  assert.equal(s.state, 'open', 'an expired mute is still muting');
  assert.equal(s.storedState, 'muted', 'the original decision was lost rather than expired');
  assert.equal(s.expired, true);

  setFindingState('fp-live', {
    state: 'muted', reason: 'known', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assert.equal(getFindingState('fp-live').state, 'muted');
});

test('first_seen survives a later decision — the history is not rewritten', () => {
  setFindingState('fp-hist', { state: 'acknowledged' });
  const first = getFindingState('fp-hist').firstSeen;
  setFindingState('fp-hist', { state: 'muted', reason: 'accepted for now' });
  assert.equal(getFindingState('fp-hist').firstSeen, first);
  assert.equal(getFindingState('fp-hist').state, 'muted');
});

test('clearing a state returns the finding to plain open', () => {
  setFindingState('fp-clear', { state: 'muted', reason: 'r' });
  assert.equal(clearFindingState('fp-clear').ok, true);
  assert.equal(getFindingState('fp-clear'), null);
});

/* ── Muting is presentation, never deletion ────────────────────────────── */

test('a muted finding is still stored, still counted, and still returned', () => {
  /*
   * THE LINE THIS MODULE MUST NOT CROSS. A health tool that could make findings
   * disappear would be a tool for hiding problems. Muting changes how a finding
   * is PRESENTED and nothing else.
   */
  const runId = openRun();
  completeRun(runId, {
    status: 'completed',
    manifest: { cutoff: '2026-09-11 00:00:00', metrics: {}, severity_counts: { MEDIUM: 2 } },
    findings: [finding({ fingerprint: 'keep' }), finding({ fingerprint: 'quiet', target_ids: ['b'] })],
  });
  setFindingState('quiet', { state: 'muted', reason: 'known, accepted' });

  const { findings, total } = listFindings(runId, { limit: 50 });
  assert.equal(total, 2, 'muting changed the total');
  assert.equal(findings.length, 2, 'a muted finding was withheld from the list');

  const muted = findings.find((f) => f.fingerprint === 'quiet');
  assert.equal(muted.quiet, true);
  assert.equal(muted.lifecycle.state, 'muted');
  assert.equal(muted.lifecycle.reason, 'known, accepted', 'the reason is not readable from the list');

  const open = findings.find((f) => f.fingerprint === 'keep');
  assert.equal(open.quiet, false);
  assert.equal(open.lifecycle.state, 'open', 'an undecided finding has no default shape');
});

test('summarise reports BOTH the quiet count and the outstanding one', () => {
  // "12 outstanding" alone would hide that 400 were muted.
  setFindingState('s1', { state: 'muted', reason: 'r' });
  setFindingState('s2', { state: 'acknowledged' });
  const sum = summarise(['s1', 's2', 's3']);
  assert.equal(sum.total, 3);
  assert.equal(sum.quiet, 1);
  assert.equal(sum.acknowledged, 1);
  assert.equal(sum.outstanding, 2, 'an acknowledged finding was counted as handled');
});

test('the vocabulary is served, and quiet states are a closed set', () => {
  assert.ok(STATE_VOCABULARY.length >= 4);
  for (const v of STATE_VOCABULARY) { assert.ok(v.key); assert.ok(v.label); assert.ok(v.blurb); }
  assert.deepEqual([...QUIET_STATES].sort(), ['accepted', 'muted']);
});

test('state is keyed on the fingerprint, so it cannot suppress a different record set', () => {
  /*
   * A fingerprint is sha256 over rule + table + the sorted sys_ids. Muting
   * "these four CIs have no owner" carries forward across runs and CANNOT
   * silence a fifth CI that goes ownerless next week — that is a different
   * hash and arrives as new.
   */
  setFindingState('four-cis', { state: 'muted', reason: 'accepted' });
  const map = stateMap();
  assert.equal(map.get('four-cis').state, 'muted');
  assert.equal(map.get('five-cis'), undefined, 'a different record set inherited a mute');
});

/* ── Production guards around a run ────────────────────────────────────── */

test('a second concurrent run is refused while the first is in flight', () => {
  /*
   * Two runs extract the same tables twice and leave whichever finished last as
   * "latest", so the page would show one run's coverage beside the other's
   * findings. There is no way to merge two snapshots taken at different
   * cutoffs.
   */
  const a = openRun();
  const busy = runInFlight();
  assert.ok(busy, 'a running check was not detected');
  assert.equal(busy.id, a);

  completeRun(a, { status: 'completed', manifest: { cutoff: 'x', metrics: {} }, findings: [] });
  assert.equal(runInFlight(), null, 'a finished run still reads as in flight');
});

test('an abandoned run does not lock the feature for ever', () => {
  /*
   * A server killed mid-run leaves its row at `running`. Without an age bound,
   * one crash would make health checks permanently unavailable.
   */
  const id = openRun();
  // Age the row past the abandon window.
  getDb().prepare('UPDATE health_runs SET started_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), id);
  assert.equal(runInFlight(), null, 'an abandoned run still blocks new checks');
});

test('with the live set, "running" means THIS PROCESS is executing it — age does not matter', () => {
  /*
   * THE MEASURED FAILURE: a server closed mid-check left the row at `running`,
   * and a restart — even a reboot — still answered "a health check is already
   * running" for thirty minutes, because the row was recent.
   */
  const orphan = openRun();                        // recent, but nobody is running it
  assert.equal(runInFlight({ live: new Set() }), null, 'a row no process owns still blocks new checks');
  assert.equal(runInFlight({ live: new Set([orphan]) })?.id, orphan, 'a run this process owns was not detected');

  const old = openRun();
  getDb().prepare('UPDATE health_runs SET started_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), old);
  getDb().prepare("UPDATE health_runs SET status = 'failed' WHERE id = ?").run(orphan);
  assert.equal(runInFlight({ live: new Set([old]) })?.id, old,
    'a long check this process is still running was treated as abandoned — a second could start beside it');
  completeRun(old, { status: 'completed', manifest: { cutoff: 'x', metrics: {} }, findings: [] });
});

test('orphaned runs are closed as interrupted, live ones are left alone, finished ones untouched', () => {
  abandonOrphanedRuns([]);   // rows earlier tests left at `running` are not this test's subject
  const live = openRun();
  const orphan = openRun();
  const done = openRun();
  completeRun(done, { status: 'completed', manifest: { cutoff: 'x', metrics: {} }, findings: [] });

  const closed = abandonOrphanedRuns([live]);
  assert.equal(closed, 1);
  assert.equal(getRun(orphan).status, 'failed');
  assert.equal(getRun(orphan).error, INTERRUPTED_NOTE);
  assert.match(getRun(orphan).error, /server stopped/i);
  assert.match(getRun(orphan).error, /only reads/);
  assert.equal(getRun(live).status, 'running', 'a run this process is executing was closed');
  assert.equal(getRun(done).status, 'completed', 'a finished run was rewritten');

  assert.equal(abandonOrphanedRuns([]), 1, 'with nothing live, the last running row should close');
  assert.equal(abandonOrphanedRuns([]), 0, 'closing is not idempotent');
});

test('a cancelled run is distinct from a failed one, and says nothing was written', () => {
  const id = openRun();
  cancelRun(id);
  const run = getRun(id);
  assert.equal(run.status, 'cancelled');
  assert.match(run.error, /only reads/);
  assert.notEqual(run.status, 'failed', 'stopping on purpose was reported as a failure');
});

test('the trend keeps withheld scores as null rather than dropping or zeroing them', () => {
  /*
   * A line that silently skipped them would imply continuity across a period
   * where coverage was actually incomplete.
   */
  const withScore = openRun();
  completeRun(withScore, {
    status: 'completed',
    manifest: { cutoff: 'c', metrics: { cmdb_quality_score: 87, visible_cis: 10 }, findings_stored: 3, severity_counts: {} },
    findings: [],
  });
  const withheld = openRun();
  completeRun(withheld, {
    status: 'partial',
    manifest: { cutoff: 'c', metrics: { cmdb_quality_score: null, visible_cis: 10 }, findings_stored: 5, severity_counts: {} },
    findings: [],
  });

  const points = trend({ limit: 10 });
  const a = points.find((p) => p.runId === withScore);
  const b = points.find((p) => p.runId === withheld);
  assert.equal(a.score, 87);
  assert.equal(a.scoreWithheld, false);
  assert.equal(b.score, null, 'a withheld score was zeroed');
  assert.equal(b.scoreWithheld, true);
  // Oldest first, so a chart can render it left to right.
  const times = points.map((p) => p.at);
  assert.deepEqual(times, [...times].sort(), 'the trend is not in chronological order');
});

test('a cancelled or failed run never appears in the trend', () => {
  // A partial snapshot plotted beside complete ones would read as a real drop.
  const dead = openRun();
  cancelRun(dead);
  assert.equal(trend({ limit: 50 }).some((p) => p.runId === dead), false);
});
