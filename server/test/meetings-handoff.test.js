/**
 * Handing a meeting to the agent.
 *
 * This replaced a build-plan stage that did its own orchestration beside one
 * that already existed. The properties worth asserting are about what crosses
 * the boundary — because everything after it is the agent's existing approval
 * gate, and everything before it is a transcript nobody should be able to build
 * from without confirming first.
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
import { addFinding, updateFinding } from '../src/meetings/findings.js';
import { fingerprint } from '../src/meetings/understanding.js';
import { meetingBrief, handoffToAgent } from '../src/meetings/handoff.js';
import { listSessions, createSession } from '../src/memory/sessions.js';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-handoff-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));
_setSettingsForTests({ connection: { instanceUrl: 'https://dev12345.service-now.com' } });
_setAudioRootForTests(path.join(scratchDir, 'audio'));

function meetingWith({ title = 'Laptop requests', utterances = [], findings = [] } = {}) {
  const { id } = startMeeting({ title });
  utterances.forEach((text, i) => {
    addSegment(id, { idx: i, track: 'system', start_ms: i * 5000, end_ms: i * 5000 + 4000, audio_path: null, bytes: 0 });
    getDb().prepare("UPDATE meeting_segments SET text = ?, stt_state = 'done' WHERE meeting = ? AND idx = ?")
      .run(text, id, i);
  });
  for (const f of findings) {
    if (f.origin === 'model') {
      getDb().prepare(
        `INSERT INTO meeting_findings (meeting, kind, text, status, origin, pass, fingerprint, created)
         VALUES (?, ?, ?, ?, 'model', 1, ?, datetime('now'))`
      ).run(id, f.kind, f.text, f.status || 'confirmed', fingerprint(f.kind, f.text));
      const fid = getDb().prepare('SELECT id FROM meeting_findings WHERE meeting = ? AND fingerprint = ?')
        .get(id, fingerprint(f.kind, f.text)).id;
      getDb().prepare(
        `INSERT INTO meeting_evidence (finding, seg_idx, quote, verified, reason)
         VALUES (?, ?, ?, ?, ?)`
      ).run(fid, f.seg ?? 0, f.quote || '', f.verified === false ? 0 : 1, f.verified === false ? 'not found' : null);
    } else {
      const added = addFinding(id, { kind: f.kind, text: f.text });
      if (f.status && f.status !== 'confirmed') updateFinding(id, added.id, { status: f.status });
    }
  }
  return id;
}

test('migration 19 adds session provenance', () => {
  const cols = getDb().prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  for (const c of ['source', 'source_ref', 'source_label']) assert.ok(cols.includes(c), `missing ${c}`);
});

test('the brief carries the requirement AND the words it came from', () => {
  const id = meetingWith({
    utterances: ['It should require manager approval before IT fulfils it.'],
    findings: [{
      origin: 'model', kind: 'requirement', text: 'Manager approval is required',
      seg: 0, quote: 'require manager approval',
    }],
  });
  const brief = meetingBrief(id);
  assert.match(brief.text, /Manager approval is required/);
  assert.match(brief.text, /said: "require manager approval"/,
    'the speaker\'s own words travel with the requirement — a paraphrase has already been through two models');
  assert.equal(brief.requirements, 1);
});

test('open questions are handed over as OPEN, with an instruction not to answer them', () => {
  const id = meetingWith({
    findings: [
      { origin: 'human', kind: 'requirement', text: 'Build a laptop request form' },
      { origin: 'human', kind: 'question', text: 'Who approves for contractors?' },
    ],
  });
  const brief = meetingBrief(id);
  assert.match(brief.text, /NOT settled in the meeting/);
  assert.match(brief.text, /Who approves for contractors\?/);
  assert.match(brief.text, /do not answer them for me/i);
  assert.equal(brief.openQuestions, 1);
});

test('the brief tells the agent to ASK rather than invent what the meeting did not say', () => {
  const id = meetingWith({ findings: [{ origin: 'human', kind: 'requirement', text: 'Build it' }] });
  const brief = meetingBrief(id);
  assert.match(brief.text, /ASK me/);
  assert.match(brief.text, /Do not pick a plausible value/i);
});

test('UNCONFIRMED and UNVERIFIED findings never reach the agent', () => {
  const id = meetingWith({
    utterances: ['We need a laptop form.'],
    findings: [
      // proposed, never confirmed by a human
      { origin: 'model', kind: 'requirement', text: 'Something merely proposed', status: 'proposed', seg: 0, quote: 'We need a laptop form' },
      // confirmed, but its citation never checked out
      { origin: 'model', kind: 'requirement', text: 'Something invented', status: 'confirmed', seg: 0, quote: 'nobody said this', verified: false },
      { origin: 'human', kind: 'requirement', text: 'Something I actually confirmed' },
    ],
  });
  const brief = meetingBrief(id);
  assert.ok(!brief.text.includes('Something merely proposed'), 'unconfirmed findings are not agreed outcomes');
  assert.ok(!brief.text.includes('Something invented'),
    'a confirmed finding whose evidence failed must never reach a build');
  assert.match(brief.text, /Something I actually confirmed/);
  assert.equal(brief.requirements, 1);
});

test('a meeting with nothing confirmed cannot be handed over', () => {
  const id = meetingWith({
    utterances: ['We need a laptop form.'],
    findings: [{ origin: 'model', kind: 'requirement', text: 'Only proposed', status: 'proposed', seg: 0, quote: 'We need a laptop form' }],
  });
  assert.throws(() => handoffToAgent(id), /Nothing has been confirmed/);
  assert.equal(listSessions().filter((s) => s.source_ref === id).length, 0, 'no chat is created');
});

test('handoff creates a marked agent session', () => {
  const id = meetingWith({
    title: 'Laptop requests',
    findings: [{ origin: 'human', kind: 'requirement', text: 'Build a laptop request form' }],
  });
  const { session, reused } = handoffToAgent(id);
  assert.equal(reused, false);
  assert.equal(session.source, 'meeting');
  assert.equal(session.source_ref, id);
  assert.equal(session.source_label, 'Laptop requests');
  assert.match(session.title, /Laptop requests/);
});

test('handing the same meeting over twice reuses the chat rather than forking it', () => {
  const id = meetingWith({
    findings: [{ origin: 'human', kind: 'requirement', text: 'Build a laptop request form' }],
  });
  const first = handoffToAgent(id);
  const second = handoffToAgent(id);
  assert.equal(second.reused, true);
  assert.equal(second.session.id, first.session.id,
    'two chats building one meeting is how a catalog item gets created twice');
  assert.equal(listSessions().filter((s) => s.source_ref === id).length, 1);
});

test('the provenance survives on the session list, so the rail can mark it', () => {
  const id = meetingWith({
    title: 'Network outage',
    findings: [{ origin: 'human', kind: 'requirement', text: 'Raise two incidents' }],
  });
  handoffToAgent(id);
  const row = listSessions().find((s) => s.source_ref === id);
  assert.ok(row, 'the chat appears in the rail');
  assert.equal(row.source, 'meeting');
  assert.equal(row.source_label, 'Network outage');
});

test('an ordinary chat has no provenance and is not marked', () => {
  // Made the normal way, exactly as the chat UI makes one.
  const plain = createSession({ title: 'Just a chat' });
  assert.equal(plain.source, null, 'a typed chat carries no origin');
  assert.equal(plain.source_ref, null);

  const row = listSessions().find((x) => x.id === plain.id);
  assert.equal(row.source, null,
    'the rail marks a chat as "meeting" only when it really came from one');
});
