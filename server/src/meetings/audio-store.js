import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../logging.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where a meeting's utterance WAVs live.
 *
 * Under `server/data/`, which is already gitignored — so a recorded meeting can
 * never reach git by accident. That is not a nicety: this folder holds other
 * people's voices, and the one irreversible mistake available here is
 * committing it.
 */
const DEFAULT_AUDIO_ROOT = path.resolve(__dirname, '../../data/audio');

/*
 * Test seam, mirroring `_setDbForTests` in memory/db.js and
 * `_setSettingsForTests` in config/store.js.
 *
 * Written after the first run of meetings-store.test.js left seven directories
 * in the developer's REAL `server/data/audio/`. The suite is offline and
 * creates and deletes meetings freely, so pointing it at the live audio root
 * means a test run walks around inside the folder that holds actual recordings
 * — and the one operation under test is a recursive delete. A scratch root is
 * not tidiness here; it is the difference between a test suite and a hazard.
 */
let audioRoot = DEFAULT_AUDIO_ROOT;

export function _setAudioRootForTests(dir) {
  audioRoot = dir || DEFAULT_AUDIO_ROOT;
  return audioRoot;
}

function root() { return audioRoot; }

/** The active audio root. A function, not a const, because of the seam above. */
export function currentAudioRoot() { return root(); }

/**
 * The SERVER owns the layout, not the capture agent.
 *
 * The agent is told where to write in the response to `POST /api/meetings`, and
 * writes only there. If the agent chose its own paths, moving this directory
 * would mean shipping a new agent binary, and a stale agent would keep writing
 * somewhere the retention sweep never looks — audio that nothing knows about is
 * exactly the failure this project cannot afford.
 */
export function audioDirFor(meetingId) {
  return path.join(root(), meetingId);
}

export function ensureAudioDir(meetingId) {
  const dir = audioDirFor(meetingId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A path is only acceptable if it is INSIDE this meeting's own folder.
 *
 * The agent posts the path it wrote, and this route hands that path to
 * `res.sendFile` and later to a recursive delete. Both are worth being
 * paranoid about: a `..` in a posted path would let a delete escape the audio
 * root. `path.relative` is the check rather than a `startsWith` on strings,
 * because `data/audio/m1-evil` starts with `data/audio/m1`.
 */
export function isInsideMeetingDir(meetingId, candidate) {
  if (!candidate) return false;
  const dir = audioDirFor(meetingId);
  const rel = path.relative(dir, path.resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Total bytes on disk for one meeting. 0 when the folder is already gone. */
export function dirBytes(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirBytes(p);
      else total += fs.statSync(p).size;
    } catch { /* vanished mid-walk; it contributes nothing */ }
  }
  return total;
}

/**
 * REMOVE A MEETING'S AUDIO, AND PROVE IT IS GONE.
 *
 * This is the retention promise, and it is the one operation in the module that
 * must never report success on faith. Two reasons, both measured properties of
 * Windows rather than hypotheticals:
 *
 *   1. A file another process holds open cannot be deleted. If the user has
 *      just played an utterance back, the browser may still hold that handle,
 *      and `rm -rf` fails on that one file while removing its siblings.
 *   2. `fs.rmSync(..., { force: true })` swallows exactly that error. A delete
 *      that "succeeded" while leaving voice recordings on disk is the worst
 *      outcome available here, because the UI would then say the audio was
 *      removed and nobody would ever look again.
 *
 * So the removal is followed by a re-read of the directory, and what is
 * reported is what the filesystem says afterwards — not what the call returned.
 * A partial delete is a LOUD failure with the surviving paths named, and the
 * caller keeps `audio_dir` set so the meeting still counts as holding bytes.
 */
export function removeAudioDir(dir) {
  if (!dir) return { ok: true, bytesFreed: 0, remaining: [], reason: 'no-directory' };
  const before = dirBytes(dir);
  let removeError = null;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    removeError = err;
  }

  // The verification. `existsSync` is the whole point of this function.
  if (!fs.existsSync(dir)) {
    log.info('meetings', `audio removed and verified gone: ${dir} (${before} bytes)`);
    return { ok: true, bytesFreed: before, remaining: [], reason: null };
  }

  const remaining = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else remaining.push(p);
    }
  };
  walk(dir);

  const after = dirBytes(dir);
  log.error('meetings',
    `audio deletion INCOMPLETE for ${dir} — ${remaining.length} file(s), ${after} bytes still on disk`
    + (removeError ? ` (${removeError.message})` : '')
    + '. On Windows this is almost always a file still open in a media player or a browser tab. '
    + 'The meeting is deliberately left marked as holding audio so it is not silently forgotten.');

  return {
    ok: false,
    bytesFreed: Math.max(0, before - after),
    remaining,
    reason: removeError ? removeError.message : 'files-still-present',
  };
}

/** Every meeting folder currently on disk — including any the DB lost track of. */
export function orphanScan(knownIds) {
  const known = new Set(knownIds);
  let entries = [];
  try { entries = fs.readdirSync(root(), { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !known.has(e.name))
    .map((e) => ({ id: e.name, dir: path.join(root(), e.name), bytes: dirBytes(path.join(root(), e.name)) }));
}
