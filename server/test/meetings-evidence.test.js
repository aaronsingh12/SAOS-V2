/**
 * Meeting Intelligence phase 4 — the evidence guard.
 *
 * These assertions are the reason the feature can be trusted at all. The only
 * model available here (gpt-oss:120b-cloud) provably ignores `seed`, so every
 * generation is non-reproducible and its characteristic failure is a fluent,
 * confident, INVENTED requirement that reads exactly like a real one. Nothing
 * about the text separates them.
 *
 * A quote does. Each test below is a way the separation could silently break.
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
import { startMeeting, addSegment } from '../src/meetings/store.js';
import { verifyCitation, verifyFinding, normalize, MIN_QUOTE_WORDS } from '../src/meetings/evidence.js';
import { parseFindings, fingerprint, KINDS } from '../src/meetings/understanding.js';
import { listFindings, addFinding, updateFinding, approvedSet } from '../src/meetings/findings.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-evid-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));
_setSettingsForTests({ connection: { instanceUrl: 'https://dev12345.service-now.com' } });
_setAudioRootForTests(path.join(scratchDir, 'audio'));

/** A meeting whose transcript is fixed and known. */
function seedMeeting(utterances) {
  const { id } = startMeeting({ title: 'Evidence' });
  utterances.forEach((u, i) => {
    addSegment(id, {
      idx: i, track: u.track || 'system',
      start_ms: i * 5000, end_ms: i * 5000 + 4000,
      audio_path: null, bytes: 0,
    });
    getDb().prepare(
      "UPDATE meeting_segments SET text = ?, stt_state = ? WHERE meeting = ? AND idx = ?"
    ).run(u.text ?? null, u.state || 'done', id, i);
  });
  return id;
}

const TRANSCRIPT = [
  { text: 'We need a new catalog item for laptop requests.' },
  { text: 'It should require manager approval before IT fulfils it.', track: 'mic' },
  { text: 'Contractors are out of scope for now.' },
];

test('migration 17 creates the findings and evidence tables', () => {
  const names = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('meeting_findings','meeting_evidence')")
    .all().map((r) => r.name).sort();
  assert.deepEqual(names, ['meeting_evidence', 'meeting_findings']);
});

test('a quote that really was said VERIFIES', () => {
  const id = seedMeeting(TRANSCRIPT);
  const v = verifyCitation(id, { segment: 1, quote: 'require manager approval' });
  assert.equal(v.verified, true, v.reason);
  assert.equal(v.start_ms, 5000, 'a verified citation carries the timestamp to jump to');
});

test('an INVENTED quote is refused — the whole point of this file', () => {
  const id = seedMeeting(TRANSCRIPT);
  const v = verifyCitation(id, {
    segment: 1,
    quote: 'the budget must be approved by finance and the CFO',
  });
  assert.equal(v.verified, false);
  assert.match(v.reason, /does not appear in utterance 1/);
});

test('a real quote attributed to the WRONG utterance is refused', () => {
  const id = seedMeeting(TRANSCRIPT);
  // Those words exist in the meeting, but not in utterance 2.
  const v = verifyCitation(id, { segment: 2, quote: 'require manager approval' });
  assert.equal(v.verified, false);
  assert.match(v.reason, /does not appear in utterance 2/);
});

test('a citation to an utterance that does not exist is refused', () => {
  const id = seedMeeting(TRANSCRIPT);
  const v = verifyCitation(id, { segment: 99, quote: 'require manager approval' });
  assert.equal(v.verified, false);
  assert.match(v.reason, /does not exist/);
});

/*
 * The load-bearing half of the rule, and the easiest to miss.
 *
 * Phase 2 keeps Whisper's own hallucinations out of the transcript by marking
 * them `empty` with a reason — but their index still exists. If one could be
 * cited, a fabricated requirement could be "supported" by a sentence the
 * pipeline itself invented one stage earlier, and the chain would look clean.
 */
test('a DISCARDED transcript cannot be cited, even if the quote matches its text', () => {
  const id = seedMeeting([
    { text: 'We need a new catalog item for laptop requests.' },
    { text: "I'm not sure if I'm going to do that anymore.", state: 'empty' },
    { text: null, state: 'failed' },
  ]);
  const hallucinated = verifyCitation(id, { segment: 1, quote: "not sure if I'm going to do that" });
  assert.equal(hallucinated.verified, false);
  assert.match(hallucinated.reason, /no confirmed transcript/);

  const failed = verifyCitation(id, { segment: 2, quote: 'anything at all here' });
  assert.equal(failed.verified, false);
  assert.match(failed.reason, /failed transcription/);
});

/*
 * The fix for "the conversation goes nil".
 *
 * A sentence spoken over wind, breath or a third person talking fails
 * Whisper's confidence checks. Discarding it made half of all captured
 * utterances render as blank rows, indistinguishable from nobody speaking.
 * It is now KEPT and marked `low` — visible to a human, and still barred from
 * anchoring a requirement, because that is what kept fabrications out.
 */
test('a LOW-confidence transcript is readable but can never be cited', () => {
  const id = seedMeeting([
    { text: 'We need a new catalog item for laptop requests.' },
    { text: 'and it should go to the hardware team', state: 'low' },
  ]);
  const row = getDb().prepare('SELECT text, stt_state FROM meeting_segments WHERE meeting = ? AND idx = 1').get(id);
  assert.equal(row.text, 'and it should go to the hardware team',
    'the text survives — a blank row reads as silence, which is the bug');
  assert.equal(row.stt_state, 'low');

  const v = verifyCitation(id, { segment: 1, quote: 'go to the hardware team' });
  assert.equal(v.verified, false, 'unclear audio must never anchor a requirement');
  assert.match(v.reason, /no confirmed transcript/);
});

test('punctuation, case and curly quotes do not break a correct citation', () => {
  const id = seedMeeting([{ text: "It should require manager approval — before IT fulfils it." }]);
  const v = verifyCitation(id, { segment: 0, quote: 'REQUIRE manager approval, before IT fulfils it' });
  assert.equal(v.verified, true, v.reason);
  assert.equal(normalize('A — b,  C!'), 'a b c');
  assert.equal(normalize('sign-off'), normalize('sign off'), 'Whisper hyphenates compounds inconsistently');
});

test('a quote too short to prove anything is refused', () => {
  const id = seedMeeting(TRANSCRIPT);
  const v = verifyCitation(id, { segment: 0, quote: 'we need' });
  assert.equal(v.verified, false);
  assert.match(v.reason, new RegExp(`${MIN_QUOTE_WORDS} words`));
});

test('a finding with no evidence at all is not verified', () => {
  const id = seedMeeting(TRANSCRIPT);
  const v = verifyFinding(id, { kind: 'requirement', text: 'Something nobody said', evidence: [] });
  assert.equal(v.verified, false);
  assert.equal(v.verifiedCount, 0);
});

test('one good citation among bad ones is enough to back a finding', () => {
  const id = seedMeeting(TRANSCRIPT);
  const v = verifyFinding(id, {
    kind: 'requirement',
    text: 'Manager approval is required',
    evidence: [
      { segment: 0, quote: 'a completely invented sentence here' },
      { segment: 1, quote: 'require manager approval' },
    ],
  });
  assert.equal(v.verified, true);
  assert.equal(v.verifiedCount, 1);
  assert.equal(v.evidence[0].verified, false, 'the bad citation is kept, with its reason');
  assert.ok(v.evidence[0].reason);
});

/* ------------------------------------------------------------------ *
 * Parsing what a non-deterministic model actually returns
 * ------------------------------------------------------------------ */

test('findings parse out of bare JSON, fenced JSON, and JSON with a preamble', () => {
  const payload = '{"findings":[{"kind":"requirement","text":"Manager approval","evidence":[{"segment":1,"quote":"require manager approval"}]}]}';
  for (const raw of [
    payload,
    '```json\n' + payload + '\n```',
    'Here is the JSON you asked for:\n' + payload,
    '```\n' + payload + '\n```',
  ]) {
    const out = parseFindings(raw);
    assert.equal(out.length, 1, `failed on: ${raw.slice(0, 30)}`);
    assert.equal(out[0].kind, 'requirement');
    assert.equal(out[0].evidence[0].segment, 1);
  }
});

test('an unparseable or empty completion is an ERROR, never a silent empty result', () => {
  assert.throws(() => parseFindings(''), /returned nothing/);
  assert.throws(() => parseFindings('I could not do that.'), /valid JSON|findings/);
  assert.throws(() => parseFindings('{"other":[]}'), /no "findings" array/);
});

test('a finding with an unknown kind is dropped rather than stored', () => {
  const out = parseFindings('{"findings":[{"kind":"epic","text":"x","evidence":[]},{"kind":"decision","text":"y","evidence":[]}]}');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'decision');
  assert.ok(KINDS.includes(out[0].kind));
});

/* ------------------------------------------------------------------ *
 * The human's half, and the contract phase 5 reads
 * ------------------------------------------------------------------ */

test('a human-added finding needs no citation and is confirmed on arrival', () => {
  const id = seedMeeting(TRANSCRIPT);
  const f = addFinding(id, { kind: 'requirement', text: 'Contractors need a separate approval path' });
  assert.equal(f.origin, 'human');
  assert.equal(f.status, 'confirmed');
  assert.equal(approvedSet(id).requirements.length, 1,
    'the person was in the room; the transcript is not their evidence');
});

test('the same finding cannot be added twice', () => {
  const id = seedMeeting(TRANSCRIPT);
  addFinding(id, { kind: 'requirement', text: 'Manager approval required' });
  assert.throws(() => addFinding(id, { kind: 'requirement', text: '  manager approval REQUIRED  ' }), /already recorded/);
});

test('editing a finding keeps the model original beside the correction', () => {
  const id = seedMeeting(TRANSCRIPT);
  getDb().prepare(
    `INSERT INTO meeting_findings (meeting, kind, text, status, origin, pass, fingerprint, created)
     VALUES (?, 'requirement', 'Manger aproval', 'proposed', 'model', 1, ?, datetime('now'))`
  ).run(id, fingerprint('requirement', 'Manger aproval'));
  const fid = getDb().prepare('SELECT id FROM meeting_findings WHERE meeting = ?').get(id).id;

  const out = updateFinding(id, fid, { text: 'Manager approval is required', status: 'confirmed' });
  assert.equal(out.text, 'Manger aproval', 'what the model claimed is still recorded');
  assert.equal(out.edited_text, 'Manager approval is required');
  assert.equal(out.status, 'confirmed');
  assert.notEqual(out.fingerprint, fingerprint('requirement', 'Manger aproval'),
    'an edited finding must not be re-proposed by a later pass under its old identity');
});

test('the approved set excludes UNVERIFIED model findings even when confirmed', () => {
  const id = seedMeeting(TRANSCRIPT);
  const db = getDb();
  // A model finding a human ticked, but whose citation never checked out.
  db.prepare(
    `INSERT INTO meeting_findings (meeting, kind, text, status, origin, pass, fingerprint, created)
     VALUES (?, 'requirement', 'Invented requirement', 'confirmed', 'model', 1, ?, datetime('now'))`
  ).run(id, fingerprint('requirement', 'Invented requirement'));
  const fid = db.prepare('SELECT id FROM meeting_findings WHERE meeting = ?').get(id).id;
  db.prepare(
    `INSERT INTO meeting_evidence (finding, seg_idx, quote, verified, reason)
     VALUES (?, 0, 'words nobody said', 0, 'that quote does not appear in utterance 0')`
  ).run(fid);

  const set = approvedSet(id);
  assert.equal(set.requirements.length, 0,
    'a confirmed finding whose evidence failed must never reach the build stage');
  assert.equal(set.counts.unverified, 1, 'but it is counted, so the number is visible');
});

test('rejected findings never reach the approved set; open questions survive', () => {
  const id = seedMeeting(TRANSCRIPT);
  const q = addFinding(id, { kind: 'question', text: 'Who signs off for contractors?' });
  const r = addFinding(id, { kind: 'requirement', text: 'Something wrong' });
  updateFinding(id, r.id, { status: 'rejected' });

  const set = approvedSet(id);
  assert.equal(set.requirements.length, 0);
  assert.equal(set.openQuestions.length, 1);
  assert.equal(set.openQuestions[0].id, q.id);
  assert.equal(set.counts.rejected, 1);
});

test('listFindings returns each finding with its evidence attached', () => {
  const id = seedMeeting(TRANSCRIPT);
  const db = getDb();
  db.prepare(
    `INSERT INTO meeting_findings (meeting, kind, text, status, origin, pass, fingerprint, created)
     VALUES (?, 'requirement', 'Manager approval', 'proposed', 'model', 1, ?, datetime('now'))`
  ).run(id, fingerprint('requirement', 'Manager approval'));
  const fid = db.prepare('SELECT id FROM meeting_findings WHERE meeting = ?').get(id).id;
  db.prepare(
    `INSERT INTO meeting_evidence (finding, seg_idx, quote, verified, reason, start_ms, end_ms)
     VALUES (?, 1, 'require manager approval', 1, NULL, 5000, 9000)`
  ).run(fid);

  const [f] = listFindings(id);
  assert.equal(f.evidence.length, 1);
  assert.equal(f.verified, true);
  assert.equal(f.evidence[0].start_ms, 5000);
});
