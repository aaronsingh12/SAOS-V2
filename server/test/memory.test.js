/**
 * Regression proof for Part A — persistence, compaction, the knowledge ledger
 * and recall. Entirely offline: a scratch SQLite file, no instance, no LLM.
 *
 *   node --test server/test/
 *
 * The bug at the root of all of this: chat history lived in a module-level Map,
 * so navigating away lost the transcript and restarting the server lost every
 * conversation that had ever happened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate, getDb } from '../src/memory/db.js';

/* ------------------------------------------------------------------ *
 * A scratch database, built through the REAL migrations.
 *
 * Every module below reads its handle from db.js, so pointing that at a
 * throwaway file is enough to keep the whole suite off the project database.
 * ------------------------------------------------------------------ */

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-mem-'));
const scratchFile = path.join(scratchDir, 'test.db');

_setDbForTests(migrate(new DatabaseSync(scratchFile)));

const {
  createSession, getSession, listSessions, renameSession, deleteSession,
  appendMessage, loadHistory, loadMessages, recordToolEvent, loadToolEvents,
  deriveTitle, replaceSpanWithDigest, loadDigests,
} = await import('../src/memory/sessions.js');

const { estimateTokens, compactIfNeeded, buildDigestNote, DEFAULT_HISTORY_BUDGET } =
  await import('../src/memory/compaction.js');

const { recordFact, listFacts, factBlock, seedLedger, rememberFromChat, recordVerificationFailure, recordCalculatedFields } =
  await import('../src/memory/facts.js');

const { chunkText, indexMessage, cosine } = await import('../src/memory/recall.js');

test.after(() => {
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/* ================================================================== *
 * A-1 — persistence
 * ================================================================== */

test('A-1: a session survives being written and read back, in order', () => {
  const id = 'sess-order';
  createSession({ id });
  appendMessage(id, { role: 'user', text: 'build me a flow' });
  appendMessage(id, { role: 'assistant', text: 'on it', toolCalls: [{ id: 't1', name: 'get_table_schema', input: { table: 'incident' } }] });
  appendMessage(id, { role: 'tool', results: [{ id: 't1', name: 'get_table_schema', output: '{"fields":[]}', isError: false }] });
  appendMessage(id, { role: 'assistant', text: 'done' });

  const history = loadHistory(id);
  assert.equal(history.length, 4);
  assert.deepEqual(history.map((h) => h.role), ['user', 'assistant', 'tool', 'assistant']);
  // The neutral format must survive the round trip byte for byte, or the
  // provider adapters get something they have never seen.
  assert.equal(history[1].toolCalls[0].input.table, 'incident');
  assert.equal(history[2].results[0].output, '{"fields":[]}');
});

test('A-1: the acceptance case — a sys_id from two turns ago is still there', () => {
  const id = 'sess-sysid';
  createSession({ id });
  appendMessage(id, { role: 'user', text: 'create the vendor flow' });
  appendMessage(id, { role: 'tool', results: [{ id: 'x', name: 'create_flow_live', output: '{"sys_id":"39acb67eac164650a6b15f5e724cae76"}', isError: false }] });
  appendMessage(id, { role: 'user', text: 'now verify it' });
  appendMessage(id, { role: 'user', text: 'what was that sys_id?' });

  // A fresh read, as a restarted server would do — nothing cached in process.
  const rehydrated = loadHistory(id);
  const found = JSON.stringify(rehydrated).includes('39acb67eac164650a6b15f5e724cae76');
  assert.ok(found, 'the sys_id from two turns ago must survive a cold read');
});

test('A-1: the title comes from the first user message and survives a rename', () => {
  const id = 'sess-title';
  createSession({ id });
  assert.equal(getSession(id).title, null);
  appendMessage(id, { role: 'user', text: 'When an incident is put on hold awaiting a vendor, create a problem and link it back' });
  const auto = getSession(id).title;
  assert.ok(auto.startsWith('When an incident is put on hold'));
  assert.ok(auto.length <= 61, 'titles are truncated for the rail');

  renameSession(id, 'Vendor hold');
  appendMessage(id, { role: 'user', text: 'another message' });
  assert.equal(getSession(id).title, 'Vendor hold', 'a later message must not clobber a manual rename');
});

test('A-1: deriveTitle collapses whitespace and ellipsises', () => {
  assert.equal(deriveTitle('  hello   world  '), 'hello world');
  assert.equal(deriveTitle(''), 'New chat');
  assert.ok(deriveTitle('x'.repeat(200)).endsWith('…'));
});

test('A-1: sessions list newest-first with their counts', () => {
  const rows = listSessions();
  assert.ok(rows.length >= 3);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].updated >= rows[i].updated, 'the rail is ordered newest first');
  }
  const withMsgs = rows.find((r) => r.id === 'sess-order');
  assert.equal(withMsgs.message_count, 4);
});

test('A-1: tool events are a separate audit trail, including rejected approvals', () => {
  const id = 'sess-audit';
  createSession({ id });
  recordToolEvent(id, { kind: 'tool_call', name: 'create_record', payload: { table: 'incident' }, resultStatus: 'ok', mutating: true, approval: 'approved' });
  recordToolEvent(id, { kind: 'tool_call', name: 'delete_record', payload: { sys_id: 'abc' }, resultStatus: 'rejected', mutating: true, approval: 'rejected' });
  recordToolEvent(id, { kind: 'tool_call', name: 'query_records', payload: {}, resultStatus: 'ok', mutating: false });

  const events = loadToolEvents(id);
  assert.equal(events.length, 3);
  assert.equal(events[0].approval, 'approved');
  assert.equal(events[1].result_status, 'rejected');
  assert.equal(events[1].mutating, true);
  assert.equal(events[2].mutating, false);
  assert.deepEqual(events[0].payload, { table: 'incident' });
});

/*
 * CHANGED, deliberately: this asserted `loadToolEvents(id).length === 0`.
 *
 * That encoded a bug. `tool_events` is the audit trail of what the agent DID to
 * a live instance — its own schema comment says so — and it cascaded from
 * `sessions`, so deleting a chat destroyed the evidence. Nothing exercised it
 * while sessions were deleted one at a time; adding a "delete all chats" button
 * would have made it a one-click audit wipe.
 *
 * Migration 14 removed the foreign key. A tool event whose session is gone is
 * exactly right: the record outlives the conversation that produced it.
 */
test('A-1: deleting a session takes its transcript — but NOT its audit trail', () => {
  const id = 'sess-doomed';
  createSession({ id });
  appendMessage(id, { role: 'user', text: 'hello' });
  recordToolEvent(id, { kind: 'tool_call', name: 'x', resultStatus: 'ok', mutating: false });
  assert.equal(deleteSession(id).deleted, true);
  assert.equal(getSession(id), null);
  assert.equal(loadHistory(id).length, 0, 'the transcript goes');
  assert.equal(loadToolEvents(id).length, 1, 'the audit trail stays');
});

test('A-1: a corrupt message row does not sink the whole session', () => {
  const id = 'sess-corrupt';
  createSession({ id });
  appendMessage(id, { role: 'user', text: 'good one' });
  getDb().prepare('INSERT INTO messages (session, seq, role, json, ts) VALUES (?, ?, ?, ?, ?)')
    .run(id, 99, 'user', '{not json', new Date().toISOString());
  appendMessage(id, { role: 'user', text: 'also good' });
  const history = loadHistory(id);
  assert.equal(history.length, 2, 'the readable messages still load');
});

/* ================================================================== *
 * A-3 — compaction
 * ================================================================== */

test('A-3: the estimator counts text, tool inputs and tool outputs', () => {
  assert.equal(estimateTokens([]), 0);
  const small = estimateTokens([{ role: 'user', text: 'x'.repeat(350) }]);
  assert.ok(small >= 100 && small <= 110, `unexpected estimate ${small}`);
  // A tool result is the usual reason a session blows its budget.
  const withTool = estimateTokens([{ role: 'tool', results: [{ name: 'q', output: 'y'.repeat(3500) }] }]);
  assert.ok(withTool >= 1000, `tool output must be counted, got ${withTool}`);
});

test('A-3: a session under budget is left completely alone', async () => {
  const id = 'sess-small';
  createSession({ id });
  appendMessage(id, { role: 'user', text: 'hi' });
  const res = await compactIfNeeded(id, { summarize: () => { throw new Error('must not be called'); } });
  assert.equal(res.compacted, false);
  assert.equal(loadHistory(id).length, 1);
});

test('A-3: the acceptance case — a 100-turn session compacts under budget and keeps turn 5', async () => {
  const id = 'sess-100';
  createSession({ id });
  // Turn 5 carries the identifier a later probe will ask for.
  for (let i = 0; i < 100; i++) {
    const text =
      i === 5
        ? 'we deployed Escalate Network P1 Incident, sys_id 39acb67eac164650a6b15f5e724cae76'
        : `turn ${i}: ${'padding '.repeat(60)}`;
    appendMessage(id, { role: 'user', text });
    appendMessage(id, { role: 'tool', results: [{ id: `t${i}`, name: 'query_records', output: JSON.stringify({ n: i, blob: 'z'.repeat(400) }), isError: false }] });
  }

  const before = estimateTokens(loadHistory(id));
  assert.ok(before > DEFAULT_HISTORY_BUDGET, `fixture must exceed the budget, got ${before}`);

  // Stand-in summariser that does what the real prompt demands: preserve every
  // identifier verbatim. That is the property the acceptance test is about.
  const summarize = (transcript) => {
    const ids = [...transcript.matchAll(/\b[0-9a-f]{32}\b/g)].map((m) => m[0]);
    const names = [...transcript.matchAll(/deployed ([A-Z][A-Za-z0-9 ]+), sys_id/g)].map((m) => m[1]);
    // Emits all four headings, because the real digest contract requires them —
    // a stand-in that skips one would be testing a shape nothing produces.
    return [
      'ARTIFACTS BUILT OR CHANGED',
      ...(ids.length ? ids.map((s, i) => `- ${names[i] || 'artifact'} — flow — sys_id ${s} — active`) : ['- none']),
      'RECORDS ONLY LOOKED AT', '- none',
      'DECISIONS', '- none',
      'OPEN THREADS', '- none',
    ].join('\n');
  };

  const res = await compactIfNeeded(id, { summarize });
  assert.equal(res.compacted, true);
  assert.ok(res.tokensAfter < res.tokensBefore, 'compaction must actually shrink the history');
  assert.ok(res.tokensAfter <= DEFAULT_HISTORY_BUDGET, `still over budget after compaction: ${res.tokensAfter}`);

  // The last K turns are still verbatim.
  const kept = loadHistory(id);
  assert.ok(kept.length > 0 && kept.length < 200);

  // And the probe about turn 5 is answerable: its sys_id survives in the digest
  // that is spliced into the system prompt.
  const note = buildDigestNote(id);
  assert.match(note, /39acb67eac164650a6b15f5e724cae76/);
  assert.match(note, /Escalate Network P1 Incident/);
});

test('A-3: a failed summariser discards NOTHING — the loud, non-destructive path', async () => {
  const id = 'sess-failsummary';
  createSession({ id });
  for (let i = 0; i < 40; i++) {
    appendMessage(id, { role: 'user', text: `turn ${i} ` + 'p'.repeat(3000) });
  }
  const countBefore = loadHistory(id).length;
  const res = await compactIfNeeded(id, {
    summarize: async () => { throw new Error('max_tokens budget exhausted before any output was produced'); },
  });
  assert.equal(res.compacted, false);
  assert.match(res.error, /Compaction failed/);
  assert.match(res.error, /no history was discarded/);
  assert.equal(loadHistory(id).length, countBefore, 'a failed compaction must not lose a single turn');
});

test('A-3: an empty digest is refused rather than silently swallowing the span', async () => {
  const id = 'sess-emptydigest';
  createSession({ id });
  for (let i = 0; i < 40; i++) appendMessage(id, { role: 'user', text: `turn ${i} ` + 'q'.repeat(3000) });
  const before = loadHistory(id).length;
  const res = await compactIfNeeded(id, { summarize: async () => '   ' });
  assert.equal(res.compacted, false);
  assert.match(res.error, /empty digest/);
  assert.equal(loadHistory(id).length, before);
});

test('A-3: compaction rewrites messages but NEVER the tool-event audit trail', async () => {
  const id = 'sess-audit-survives';
  createSession({ id });
  for (let i = 0; i < 40; i++) {
    appendMessage(id, { role: 'user', text: `turn ${i} ` + 'r'.repeat(3000) });
    recordToolEvent(id, { kind: 'tool_call', name: 'create_record', resultStatus: 'ok', mutating: true, approval: 'approved' });
  }
  const eventsBefore = loadToolEvents(id).length;
  const res = await compactIfNeeded(id, {
    summarize: async () => 'ARTIFACTS BUILT OR CHANGED\n- none\nRECORDS ONLY LOOKED AT\n- none\nDECISIONS\n- none\nOPEN THREADS\n- none',
  });
  assert.equal(res.compacted, true);
  assert.equal(loadToolEvents(id).length, eventsBefore, 'what was DONE to the instance is not summarisable');
});

test('A-3: over budget but too short to fold says so instead of doing nothing quietly', async () => {
  const id = 'sess-fat-recent';
  createSession({ id });
  // Three enormous turns: over budget, but nothing old enough to compact.
  for (let i = 0; i < 3; i++) appendMessage(id, { role: 'tool', results: [{ name: 'q', output: 'z'.repeat(60000) }] });
  const res = await compactIfNeeded(id, { summarize: () => { throw new Error('must not be called'); } });
  assert.equal(res.compacted, false);
  assert.match(res.warning, /nothing old enough to fold/);
});

test('A-3: digests splice in as system-side context, not as a forged turn', () => {
  const id = 'sess-digestnote';
  createSession({ id });
  replaceSpanWithDigest(id, 0, 5, 'ARTIFACTS AND IDENTIFIERS\n- Flow X — sys_id abc123');
  const note = buildDigestNote(id);
  assert.match(note, /EARLIER IN THIS SESSION/);
  assert.match(note, /abc123/);
  assert.equal(loadDigests(id).length, 1);
});

/* ================================================================== *
 * A-4 — the knowledge ledger
 * ================================================================== */

test('A-4: seeding is idempotent and re-confirms rather than duplicating', () => {
  const first = seedLedger({ instance: 'https://test.service-now.com' });
  const countAfterFirst = listFacts({ instance: 'https://test.service-now.com' }).length;
  seedLedger({ instance: 'https://test.service-now.com' });
  assert.equal(listFacts({ instance: 'https://test.service-now.com' }).length, countAfterFirst);
  assert.ok(first.seeded >= 14);
});

test('A-4: the seeded ledger carries the trap that drives the acceptance case', () => {
  seedLedger({ instance: 'https://test.service-now.com' });
  const block = factBlock({ instance: 'https://test.service-now.com' });
  // priority-is-calculated, in the words the model has to act on.
  assert.match(block, /priority.{0,40}CALCULATED/i);
  assert.match(block, /impact/);
  assert.match(block, /urgency/);
  assert.match(block, /4 - Low/);
  // And the rest of §16.
  for (const key of ['trigger-strategy-default-once', 'keys-ts-is-project-global', 'encoded-query-silent-drop', 'lookuprecord-miss-errors-flow']) {
    assert.ok(block.includes(key), `missing seeded trap: ${key}`);
  }
});

test('A-4: an instance-measured fact does NOT leak to a different instance', () => {
  recordFact({ instance: 'https://alpha.service-now.com', kind: 'mapping', key: 'only-here', value: 'alpha has widget_id' });
  const onBeta = listFacts({ instance: 'https://beta.service-now.com' }).map((f) => f.key);
  assert.ok(!onBeta.includes('only-here'), 'a fact measured on one PDI must never be asserted about another');
  // Universal traps DO cross over, because they are SDK/platform properties.
  assert.ok(onBeta.includes('priority-is-calculated'));
});

test('A-4: re-observing a fact raises confidence; a changed value replaces it', () => {
  const a = recordFact({ instance: 'https://conf.example', kind: 'mapping', key: 'k', value: 'v1', confidence: 0.6 });
  const b = recordFact({ instance: 'https://conf.example', kind: 'mapping', key: 'k', value: 'v1', confidence: 0.6 });
  assert.ok(b.confidence > a.confidence, 'a fact re-observed is a fact confirmed');
  assert.equal(b.reconfirmed, true);
  const c = recordFact({ instance: 'https://conf.example', kind: 'mapping', key: 'k', value: 'v2', provenance: 'new read' });
  assert.equal(c.value, 'v2');
  assert.equal(c.provenance, 'new read');
});

test('A-4: an unknown fact kind is refused', () => {
  assert.throws(() => recordFact({ kind: 'vibes', key: 'k', value: 'v' }), /Unknown fact kind/);
});

test('A-4: write path — a FAILED verification becomes a durable instance fact', () => {
  const recorded = recordVerificationFailure('verify_flow_live', {
    flow: 'Create Problem for On Hold Vendor Incidents',
    assertions: [
      { pass: true, table: 'problem', field: 'short_description' },
      { pass: false, table: 'incident', field: 'problem_id', want: 'PRB0040006', got: '', note: 'incident links back to the problem' },
    ],
  });
  assert.equal(recorded.length, 1, 'only the failure is worth remembering');
  assert.match(recorded[0].key, /verify-failed:incident\.problem_id/);
  assert.match(recorded[0].value, /PRB0040006/);
  assert.match(recorded[0].provenance, /verify_flow_live/);
});

test('A-4: a clean verification records nothing', () => {
  assert.equal(recordVerificationFailure('verify_flow_live', { assertions: [{ pass: true, table: 'x', field: 'y' }] }), null);
  assert.equal(recordVerificationFailure('query_records', { assertions: [{ pass: false }] }), null);
});

test('A-4: write path — schema discovery records calculated fields', () => {
  const out = recordCalculatedFields('incident', {
    fields: [
      { name: 'short_description', type: 'string' },
      { name: 'priority', type: 'integer', calculated: true },
      { name: 'sys_created_on', type: 'glide_date_time', readOnly: true },
    ],
  });
  assert.equal(out.length, 1);
  assert.match(out[0].value, /priority/);
  assert.match(out[0].value, /sys_created_on/);
  assert.match(out[0].value, /accepted and then discarded/);
});

test('A-4: the chat "remember:" affordance stores a preference, and only on that prefix', () => {
  const f = rememberFromChat('remember: prefer subflows over duplicated logic');
  assert.equal(f.kind, 'preference');
  assert.match(f.value, /prefer subflows/);
  assert.equal(rememberFromChat('please remember to do this'), null, 'only the leading form counts');
  assert.equal(rememberFromChat('remember:   '), null);
});

/* ================================================================== *
 * A-5 — recall
 * ================================================================== */

test('A-5: chunking splits long turns but leaves short ones whole', () => {
  assert.deepEqual(chunkText('short'), ['short']);
  assert.deepEqual(chunkText(''), []);
  const parts = chunkText('para '.repeat(1000), 500);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 500));
});

test('A-5: cosine behaves, including the degenerate cases', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(cosine([1, 1], [1, 0]) > 0.7);
  assert.equal(cosine([0, 0], [1, 0]), 0, 'a zero vector must not divide by zero');
  assert.equal(cosine([1, 0], [1, 0, 0]), 0, 'a dimension mismatch scores 0, never a partial match');
});

test('A-5: the keyword fallback finds the right session, with no embeddings involved', async () => {
  // Calls the degraded path DIRECTLY rather than going through search(), which
  // would branch on whether an embedding model happens to be pulled on this
  // machine. A test that changes meaning when someone runs `ollama pull` is not
  // testing the fallback — it is testing the environment.
  const { keywordSearch } = await import('../src/memory/recall.js');
  const vendor = 'sess-recall-vendor';
  const laptop = 'sess-recall-laptop';
  createSession({ id: vendor });
  createSession({ id: laptop });

  const v = 'For vendor-hold incidents we decided to create a Problem and prefix it with "Vendor issue: "';
  const l = 'Build a laptop request catalog item with six variables';
  indexMessage(vendor, appendMessage(vendor, { role: 'user', text: v }), 'user', v);
  indexMessage(laptop, appendMessage(laptop, { role: 'user', text: l }), 'user', l);

  const hits = keywordSearch('what did we decide about vendor-hold incidents');
  assert.ok(hits.length > 0, 'the fallback must still find something');
  assert.equal(hits[0].session, vendor, 'and it must find the RIGHT session');
});

test('A-5: search always states its mode, and a degraded one carries the fix', async () => {
  const { search } = await import('../src/memory/recall.js');
  const res = await search('vendor-hold incidents');
  // Either mode is legitimate; silently passing keyword hits off as semantic
  // ones is not. Whichever ran, it must say which.
  assert.ok(['semantic', 'keyword'].includes(res.mode));
  if (res.mode === 'keyword') {
    assert.equal(res.degraded, true);
    assert.match(res.command, /ollama pull/);
  } else {
    assert.equal(res.degraded, false);
    assert.ok(res.model, 'a semantic result must name the model that produced it');
  }
  assert.ok(Array.isArray(res.hits));
});

test('A-5: an unparseable query degrades to no hits rather than throwing', async () => {
  const { search } = await import('../src/memory/recall.js');
  const res = await search('!!! ??? ***');
  assert.ok(Array.isArray(res.hits));
});

test('A-5: the FTS index tracks deletes, so a removed session stops being findable', async () => {
  const { search } = await import('../src/memory/recall.js');
  const id = 'sess-recall-gone';
  createSession({ id });
  const seq = appendMessage(id, { role: 'user', text: 'zzyzx is a distinctive token nobody else uses' });
  indexMessage(id, seq, 'user', 'zzyzx is a distinctive token nobody else uses');
  assert.ok((await search('zzyzx')).hits.length > 0);

  deleteSession(id);
  const after = await search('zzyzx');
  assert.equal(after.hits.filter((h) => h.session === id).length, 0, 'a deleted session must leave no searchable residue');
});

test('A-5: the acceptance query ranks the RIGHT session first, not last', async () => {
  // This is the bug the live acceptance run caught, pinned so it cannot return.
  //
  // SQLite's bm25() returns a NEGATIVE score where a better match is MORE
  // negative. The first implementation normalised with `1 / (1 + Math.abs(s))`,
  // which inverted the ordering — the best match came out with the lowest
  // score and searchSessions, sorting descending, returned the worst first.
  // The acceptance query put the correct session dead LAST out of five.
  const { searchSessions } = await import('../src/memory/recall.js');

  const topics = [
    ['acc-vendor', 'When an incident goes On Hold awaiting a vendor we create a Problem and prefix it with "Vendor issue: ", and we do not link it back'],
    ['acc-laptop', 'We built the Laptop Request catalog item with six variables and decided the manager approval variable is mandatory'],
    ['acc-digest', 'The Daily P1 Digest is a scheduled flow at 07:00 IST stored as 01:30 UTC and cannot be verified by firing it'],
  ];
  for (const [id, text] of topics) {
    createSession({ id });
    const seq = appendMessage(id, { role: 'user', text });
    indexMessage(id, seq, 'user', text);
  }

  const res = await searchSessions('what did we decide about vendor-hold incidents?');
  assert.ok(res.sessions.length > 0, 'the query must find something');

  // Scoped to this test's own three sessions. Other tests in this file seed
  // conversations that legitimately match the same query — asserting on the
  // global winner would make this test depend on their contents.
  const mine = res.sessions.filter((s) => s.id.startsWith('acc-'));
  assert.ok(mine.length >= 2, 'the query must reach more than one of them, or ranking proves nothing');
  assert.equal(mine[0].id, 'acc-vendor', `wrong session ranked first: ${mine[0].id}`);

  // And the ordering must be monotonically decreasing, higher-is-better. This
  // is the assertion the inverted normalisation actually broke.
  for (let i = 1; i < res.sessions.length; i++) {
    assert.ok(res.sessions[i - 1].score >= res.sessions[i].score, 'scores must be sorted best-first');
  }
});

test('A-5: stopwords are dropped, so a question matches on its content words', async () => {
  const { toFtsQuery } = await import('../src/memory/recall.js');
  const q = toFtsQuery('what did we decide about vendor-hold incidents?');
  assert.ok(!/"we"|"what"|"did"|"about"/.test(q), `stopwords survived: ${q}`);
  assert.match(q, /"vendor"/);
  assert.match(q, /"hold"/);
  assert.match(q, /"incidents"/);
});

test('A-5: a question made only of stopwords still produces a query rather than nothing', async () => {
  const { toFtsQuery } = await import('../src/memory/recall.js');
  const q = toFtsQuery('what did we do');
  assert.ok(q && q.includes('"what"'), 'falls back to the raw terms rather than returning null');
});

test('A-3: a digest cut off mid-generation is refused, not silently accepted', async () => {
  // Measured live: gpt-oss enumerated 100+ query-result record numbers, hit its
  // token cap, and dropped the one flow sys_id that mattered — while reporting
  // success. A truncated digest is well-formed text that simply stops, so the
  // only way to catch it is to require every heading.
  const id = 'sess-truncated-digest';
  createSession({ id });
  for (let i = 0; i < 40; i++) appendMessage(id, { role: 'user', text: `turn ${i} ` + 't'.repeat(3000) });
  const before = loadHistory(id).length;

  const res = await compactIfNeeded(id, {
    summarize: async () => 'ARTIFACTS BUILT OR CHANGED\n- Flow X — flow — sys_id abc — active\nRECORDS ONLY LOOKED AT\n- 12 incid',
  });
  assert.equal(res.compacted, false);
  assert.match(res.error, /incomplete digest/);
  assert.match(res.error, /DECISIONS/);
  assert.match(res.error, /No history was discarded/);
  assert.equal(loadHistory(id).length, before);
});

test('A-3: list-shaped tool results are collapsed before the model ever sees them', async () => {
  // The fix that actually solved the live failure. Asking the model not to copy
  // 700 record numbers is weaker than not showing them to it.
  const id = 'sess-noisy-results';
  createSession({ id });
  const rows = Array.from({ length: 12 }, (_, k) => ({ number: `INC00${10000 + k}`, short_description: 'padding' }));
  for (let i = 0; i < 40; i++) {
    appendMessage(id, { role: 'user', text: `turn ${i}` });
    appendMessage(id, { role: 'tool', results: [{ id: `t${i}`, name: 'query_records', output: JSON.stringify(rows), isError: false }] });
  }
  appendMessage(id, {
    role: 'tool',
    results: [{ id: 'keep', name: 'create_flow_live', isError: false,
      output: JSON.stringify({ verified: { sys_id: '39acb67eac164650a6b15f5e724cae76' } }) }],
  });
  for (let i = 0; i < 40; i++) appendMessage(id, { role: 'user', text: `pad ${i} ` + 'z'.repeat(2000) });

  let seen = '';
  await compactIfNeeded(id, {
    summarize: async (transcript) => {
      seen = transcript;
      return 'ARTIFACTS BUILT OR CHANGED\n- none\nRECORDS ONLY LOOKED AT\n- none\nDECISIONS\n- none\nOPEN THREADS\n- none';
    },
  });

  assert.ok(seen.includes('rows returned'), 'query results must reach the model as a count');
  const numbers = (seen.match(/INC00\d+/g) || []).length;
  assert.ok(numbers <= 40, `too many raw record numbers survived into the prompt: ${numbers}`);
  // The identifier that matters is NOT collapsed away — it is not a list.
  assert.ok(seen.includes('39acb67eac164650a6b15f5e724cae76'), 'a created artifact sys_id must survive into the prompt');
});
