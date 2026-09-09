/**
 * Meeting Intelligence phase 1 — the capture store.
 *
 * Three properties are asserted here rather than trusted, because each one
 * fails SILENTLY in production if it regresses:
 *
 *   1. The timeline is read back in TIME order. Two tracks are written by two
 *      concurrent threads, so insertion order is whichever utterance closed
 *      first — reading that back would put an answer before its question and
 *      nothing would look wrong.
 *   2. Posting the same utterance twice is idempotent. The agent's only safe
 *      recovery from a dropped socket is to post again; without the upsert a
 *      retry either kills the meeting on a constraint error or duplicates the
 *      utterance into every later stage.
 *   3. Deleting audio is VERIFIED against the filesystem. This is the retention
 *      promise, and a delete that reported success while leaving voice
 *      recordings on disk is the one lie this module must not tell.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate, getDb } from '../src/memory/db.js';
import { _setSettingsForTests } from '../src/config/store.js';
import {
  startMeeting, endMeeting, addSegment, listSegments, getMeeting,
  listMeetings, confirmMeeting, discardMeeting, pendingAudio,
} from '../src/meetings/store.js';
import { removeAudioDir, isInsideMeetingDir, audioDirFor, dirBytes, _setAudioRootForTests } from '../src/meetings/audio-store.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-meetings-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));
_setSettingsForTests({ connection: { instanceUrl: 'https://dev12345.service-now.com' } });
// NOT the real server/data/audio. The operation under test is a recursive
// delete, and the first run of this file left seven directories in it.
_setAudioRootForTests(path.join(scratchDir, 'audio'));

/** Write a real WAV-shaped file so byte accounting and deletion are not faked. */
function writeUtterance(dir, idx, bytes = 512) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `utt-${String(idx).padStart(6, '0')}.wav`);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

test('migration 15 creates the meeting tables', () => {
  const names = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('meetings','meeting_segments')")
    .all().map((r) => r.name).sort();
  assert.deepEqual(names, ['meeting_segments', 'meetings']);
});

test('a started meeting stamps the instance that was bound at capture time', () => {
  const m = startMeeting({ title: 'Sync', sourceApp: 'ms-teams.exe', sourcePid: 4242, detectedBy: 'auto' });
  const row = getMeeting(m.id);
  assert.equal(row.status, 'recording');
  assert.equal(row.instance, 'https://dev12345.service-now.com');
  assert.equal(row.source_pid, 4242);
  assert.ok(row.audio_dir, 'the agent must be told where to write');
});

test('segments read back in TIME order, not arrival order', () => {
  const { id, audioDir } = startMeeting({ title: 'Ordering' });
  // Arrival order is deliberately wrong: a short later utterance closes first.
  addSegment(id, { idx: 2, track: 'mic', start_ms: 9000, end_ms: 9500, audio_path: writeUtterance(audioDir, 2) });
  addSegment(id, { idx: 0, track: 'system', start_ms: 1000, end_ms: 7000, audio_path: writeUtterance(audioDir, 0) });
  addSegment(id, { idx: 1, track: 'system', start_ms: 7200, end_ms: 8000, audio_path: writeUtterance(audioDir, 1) });

  const got = listSegments(id).map((s) => s.idx);
  assert.deepEqual(got, [0, 1, 2], 'the timeline must be ordered by start_ms, not by insertion');
});

test('re-posting an utterance is idempotent, not a duplicate', () => {
  const { id, audioDir } = startMeeting({ title: 'Retry' });
  const p = writeUtterance(audioDir, 0);
  addSegment(id, { idx: 0, track: 'mic', start_ms: 0, end_ms: 1000, audio_path: p, bytes: 512 });
  // The agent lost the response and posted again with corrected timings.
  addSegment(id, { idx: 0, track: 'mic', start_ms: 0, end_ms: 1200, audio_path: p, bytes: 512 });

  const segs = listSegments(id);
  assert.equal(segs.length, 1, 'a retry must not duplicate the utterance');
  assert.equal(segs[0].end_ms, 1200, 'the retry is the authoritative version');
});

test('an out-of-range idx or an unknown track is refused, not stored', () => {
  const { id } = startMeeting({ title: 'Validation' });
  assert.throws(() => addSegment(id, { idx: -1, track: 'mic', start_ms: 0, end_ms: 1 }), /idx/);
  assert.throws(() => addSegment(id, { idx: 0, track: 'speaker', start_ms: 0, end_ms: 1 }), /track/);
  assert.throws(() => addSegment(id, { idx: 0, track: 'mic', start_ms: 500, end_ms: 100 }), /end_ms/);
  assert.equal(listSegments(id).length, 0);
});

test('a path outside the meeting folder is rejected — including a prefix trick', () => {
  const { id } = startMeeting({ title: 'Paths' });
  const dir = audioDirFor(id);
  assert.equal(isInsideMeetingDir(id, path.join(dir, 'utt-000000.wav')), true);
  assert.equal(isInsideMeetingDir(id, path.join(dir, '..', 'other', 'x.wav')), false);
  // `${dir}-evil` startsWith `${dir}` as a string but is a different directory.
  assert.equal(isInsideMeetingDir(id, `${dir}-evil${path.sep}x.wav`), false);
  assert.equal(isInsideMeetingDir(id, dir), false, 'the directory itself is not a file in it');
});

test('confirming a transcript deletes the audio and VERIFIES it is gone', () => {
  const { id, audioDir } = startMeeting({ title: 'Retention' });
  for (let i = 0; i < 3; i++) {
    addSegment(id, { idx: i, track: 'mic', start_ms: i * 1000, end_ms: i * 1000 + 800, audio_path: writeUtterance(audioDir, i), bytes: 512 });
  }
  endMeeting(id);
  assert.ok(dirBytes(audioDir) > 0, 'audio must exist before the test means anything');

  const out = confirmMeeting(id);
  assert.equal(out.deletion.ok, true);
  assert.equal(fs.existsSync(audioDir), false, 'the folder must actually be gone');
  const row = getMeeting(id);
  assert.equal(row.status, 'confirmed');
  assert.ok(row.confirmed, 'the confirmation timestamp is the freeze point');
  assert.ok(row.audio_deleted);
  assert.equal(row.audio_dir, null, 'a non-null audio_dir claims bytes are still on disk');
  assert.equal(row.audio_bytes, 0);
  // The path on each segment is now a claim about a file that does not exist.
  assert.equal(listSegments(id).every((s) => s.audio_path === null), true);
});

test('confirming while still recording is refused', () => {
  const { id } = startMeeting({ title: 'Still going' });
  assert.throws(() => confirmMeeting(id), /still recording/i);
  assert.equal(getMeeting(id).status, 'recording');
});

test('removeAudioDir reports a partial delete instead of claiming success', () => {
  const dir = path.join(scratchDir, 'locked-meeting');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.wav'), Buffer.alloc(64));

  // Simulate the Windows case: rmSync throws, and files survive. Verification
  // must be driven by the filesystem, not by whether the call threw.
  const realRm = fs.rmSync;
  fs.rmSync = () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); };
  try {
    const res = removeAudioDir(dir);
    assert.equal(res.ok, false, 'a delete that left files behind is NOT ok');
    assert.equal(res.remaining.length, 1);
    assert.match(res.reason, /EBUSY/);
  } finally {
    fs.rmSync = realRm;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pendingAudio counts only meetings still holding bytes', () => {
  const before = pendingAudio().count;
  const { id, audioDir } = startMeeting({ title: 'Pending' });
  addSegment(id, { idx: 0, track: 'system', start_ms: 0, end_ms: 900, audio_path: writeUtterance(audioDir, 0, 2048), bytes: 2048 });
  endMeeting(id);
  const during = pendingAudio();
  assert.equal(during.count, before + 1);
  assert.ok(during.bytes >= 2048);

  confirmMeeting(id);
  assert.equal(pendingAudio().count, before, 'a confirmed meeting holds no audio');
});

test('discarding removes the audio and the meeting is listed as discarded', () => {
  const { id, audioDir } = startMeeting({ title: 'Oops' });
  addSegment(id, { idx: 0, track: 'mic', start_ms: 0, end_ms: 500, audio_path: writeUtterance(audioDir, 0), bytes: 512 });
  const out = discardMeeting(id);
  assert.equal(out.deletion.ok, true);
  assert.equal(fs.existsSync(audioDir), false);
  assert.equal(getMeeting(id).status, 'discarded');
});

test('the list carries per-meeting utterance and speech totals', () => {
  const { id, audioDir } = startMeeting({ title: 'Totals' });
  addSegment(id, { idx: 0, track: 'system', start_ms: 0, end_ms: 2000, audio_path: writeUtterance(audioDir, 0) });
  addSegment(id, { idx: 1, track: 'mic', start_ms: 2500, end_ms: 4000, audio_path: writeUtterance(audioDir, 1) });
  endMeeting(id);
  const row = listMeetings().find((m) => m.id === id);
  assert.equal(row.segments, 2);
  assert.equal(row.speech_ms, 3500, 'speech is the sum of utterance lengths, not wall clock');
});
