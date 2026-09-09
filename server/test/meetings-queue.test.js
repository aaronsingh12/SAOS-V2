/**
 * Meeting Intelligence phase 2 — the live transcription queue.
 *
 * The queue is driven against a STUBBED sidecar, because the properties worth
 * asserting are properties of the queue rather than of Whisper: what it does
 * when it falls behind, what it does when a call fails, and whether the three
 * states that all look like an empty transcript stay distinguishable.
 *
 * That last one is the reason migration 16 exists. "Not transcribed yet",
 * "transcribed and genuinely silent" and "the attempt FAILED" render as the
 * same blank cell if they are not stored separately — and the third is a hole
 * in the transcript that a requirement may have been in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate, getDb } from '../src/memory/db.js';
import { _setSettingsForTests } from '../src/config/store.js';
import { _setAudioRootForTests } from '../src/meetings/audio-store.js';
import { startMeeting, addSegment, listSegments } from '../src/meetings/store.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-sttq-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));
_setSettingsForTests({ connection: { instanceUrl: 'https://dev12345.service-now.com' } });
_setAudioRootForTests(path.join(scratchDir, 'audio'));

/*
 * The sidecar is stubbed at the network boundary. `stt.js` is the seam the
 * whole design rests on, so the test exercises the real module and replaces
 * only `fetch` — a hand-written fake of stt.js would prove the fake works.
 */
const realFetch = globalThis.fetch;
let respond = null;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.endsWith('/health')) {
    return { ok: true, json: async () => ({ ok: true, default_model: 'base.en' }) };
  }
  const body = JSON.parse(opts.body);
  return respond(body);
};
test.after(() => { globalThis.fetch = realFetch; });

const {
  enqueueSegment, sttStatus, requeuePending, onTranscription,
  _resetQueueForTests, _drainForTests, LIVE_MODEL, FALLBACK_MODEL, DOWNGRADE_BACKLOG_MS,
} = await import('../src/meetings/queue.js');

const ok = (text, model) => ({ ok: true, json: async () => ({ text, model: model || 'base.en', duration_s: 1, wall_s: 0.5, rtf: 2 }) });
const fail = (message) => ({ ok: false, json: async () => ({ error: message }) });

function seed(title, utterances) {
  const { id, audioDir } = startMeeting({ title });
  fs.mkdirSync(audioDir, { recursive: true });
  const segs = [];
  utterances.forEach((durMs, i) => {
    const p = path.join(audioDir, `utt-${i}.wav`);
    fs.writeFileSync(p, Buffer.alloc(128));
    segs.push(addSegment(id, {
      idx: i, track: 'system', start_ms: i * durMs, end_ms: (i + 1) * durMs,
      audio_path: p, bytes: 128,
    }));
  });
  return { id, segs };
}

test('a transcribed utterance stores its text and the model that produced it', async () => {
  _resetQueueForTests();
  respond = () => ok('We need a new catalog item.');
  const { id, segs } = seed('Happy path', [2000]);
  enqueueSegment(segs[0]);
  await _drainForTests();

  const row = listSegments(id)[0];
  assert.equal(row.text, 'We need a new catalog item.');
  assert.equal(row.stt_state, 'done');
  assert.equal(row.text_model, 'base.en');
  assert.ok(row.stt_ms >= 0, 'wall time is recorded — it is what the meter is built on');
  assert.equal(row.stt_error, null);
});

test('genuinely silent audio is "empty", NOT "pending" and NOT "failed"', async () => {
  _resetQueueForTests();
  respond = () => ok('');
  const { id, segs } = seed('Silence', [500]);
  enqueueSegment(segs[0]);
  await _drainForTests();

  const row = listSegments(id)[0];
  assert.equal(row.stt_state, 'empty');
  assert.equal(row.text, '');
  assert.equal(row.stt_error, null, 'silence is not an error');
});

test('a failed transcription is recorded as failed, with the reason', async () => {
  _resetQueueForTests();
  respond = () => fail('CUDA out of memory');
  const { id, segs } = seed('Failure', [2000]);
  enqueueSegment(segs[0]);
  await _drainForTests();

  const row = listSegments(id)[0];
  assert.equal(row.stt_state, 'failed');
  assert.match(row.stt_error, /CUDA out of memory/);
  assert.equal(row.text, null, 'a failure must never masquerade as an empty transcript');
  assert.equal(sttStatus().failed, 1);
});

test('a failing call is retried once, then given up on', async () => {
  _resetQueueForTests();
  let calls = 0;
  respond = () => { calls += 1; return calls === 1 ? fail('sidecar starting up') : ok('second time lucky'); };
  const { id, segs } = seed('Retry', [1000]);
  enqueueSegment(segs[0]);
  await _drainForTests();

  const row = listSegments(id)[0];
  assert.equal(calls, 2, 'exactly one retry');
  assert.equal(row.stt_state, 'done');
  assert.equal(row.text, 'second time lucky');
});

test('the model is DOWNGRADED when the backlog passes the threshold, and says so', async () => {
  _resetQueueForTests();
  const seen = [];
  onTranscription((e) => { if (e.type === 'stt_model') seen.push(e); });
  // Hold every call open until released, so a backlog can actually build.
  let release;
  const gate = new Promise((r) => { release = r; });
  respond = async () => { await gate; return ok('text'); };

  // Enough queued audio to cross the threshold several times over.
  const per = 10_000;
  const { segs } = seed('Backlog', Array(Math.ceil(DOWNGRADE_BACKLOG_MS / per) + 3).fill(per));
  for (const s of segs) enqueueSegment(s);

  assert.ok(sttStatus().backlogMs > DOWNGRADE_BACKLOG_MS, 'the backlog must actually exceed the threshold');
  release();
  await _drainForTests();

  assert.ok(seen.length >= 1, 'the downgrade is announced, not silent');
  assert.equal(seen[0].model, FALLBACK_MODEL);
  assert.equal(seen[0].downgraded, true);
  assert.equal(seen[0].liveModel, LIVE_MODEL);
});

test('the meter reports what the machine actually achieved', async () => {
  _resetQueueForTests();
  respond = () => ok('some words');
  const { segs } = seed('Meter', [4000, 4000]);
  for (const s of segs) enqueueSegment(s);
  await _drainForTests();

  const st = sttStatus();
  assert.equal(st.completed, 2);
  assert.equal(st.queued, 0);
  assert.equal(st.backlogMs, 0);
  assert.ok(st.measuredRtf === null || st.measuredRtf > 0, 'RTF is measured from real wall time');
});

test('pending utterances are re-queued after a restart', async () => {
  _resetQueueForTests();
  respond = () => ok('recovered after a restart');
  const { id, segs } = seed('Crash', [1500, 1500]);
  // Nothing was enqueued — this is the state a server restart leaves behind.
  assert.equal(listSegments(id).every((r) => r.stt_state === 'pending'), true);

  const n = requeuePending();
  assert.ok(n >= segs.length, 'every pending utterance is re-queued');
  await _drainForTests();
  assert.equal(listSegments(id).every((r) => r.stt_state === 'done'), true);
});

test('an already-transcribed utterance is not re-queued', async () => {
  _resetQueueForTests();
  respond = () => ok('done once');
  const { id, segs } = seed('Idempotent', [1000]);
  enqueueSegment(segs[0]);
  await _drainForTests();

  const row = listSegments(id)[0];
  assert.equal(enqueueSegment(row), false, 'a completed utterance must not be transcribed twice');
  assert.equal(sttStatus().queued, 0);
});
