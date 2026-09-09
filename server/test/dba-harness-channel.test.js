import test from 'node:test';
import assert from 'node:assert/strict';

import { wrapScript, readLogChannel } from '../src/servicenow/execution-harness.js';
import { unavailableIndexes } from '../src/servicenow/dba-schema.js';

/*
 * M-1 — the harness "timed out" on a job that had already finished.
 *
 * MEASURED on dev428633: a one-shot probe reported timedOut at 93.7s against a
 * ~2s baseline. Instrumenting the generated script showed the job ran in under
 * five seconds, in scope x_2002152_nwforge, and that the sink write was
 * discarded field by field:
 *
 *   canWrite=true   afterSet name=[null] value=[null]
 *   insert=48997ce573cfc390a40ef7303ab8b747   lastErr=null
 *
 * A scoped script's writes to the global sys_user_preference table are dropped
 * in SILENCE — every signal reports success and the row lands empty. The old
 * harness then blamed the scheduler, and its cleanup queried the same name it
 * could never match, so it reported "no leftovers" while leaking a row per run.
 */

test('the wrapper announces that it started, before running the body', () => {
  const script = wrapScript({ body: '  var x = 1;', sinkName: 'x.sink', token: 'tok123' });
  const startAt = script.indexOf("' NFSTART scope='");
  const bodyAt = script.indexOf('var x = 1;');
  assert.ok(startAt >= 0, 'there must be an executed-at-all marker');
  assert.ok(startAt < bodyAt, 'it must be emitted BEFORE the body, or a throwing body hides it');
});

test('the wrapper PROVES the sink round-tripped instead of trusting insert()', () => {
  const script = wrapScript({ body: '  var x = 1;', sinkName: 'x.sink', token: 'tok123' });
  assert.ok(script.includes('var __sinkId = __sink.insert();'));
  assert.ok(script.includes("__v.get(__sinkId)"), 'the row must be read back');
  assert.ok(script.includes(`String(__v.getValue('name')) === "x.sink"`),
    'the read-back must COMPARE the value, because a dropped write still yields a row');
  assert.ok(script.includes("' NFSINK ' + (__sinkOk ? 'ok' : 'blocked') + ' id=' + __sinkId"),
    'the sink sys_id must be logged, or a blank-named orphan cannot be deleted');
});

test('the fallback channel only fires when the sink did not round-trip', () => {
  const script = wrapScript({ body: '  var x = 1;', sinkName: 'x.sink', token: 'tok123' });
  const guard = script.indexOf('if (!__sinkOk) {');
  const chunk = script.indexOf("' NFRPT '");
  assert.ok(guard >= 0 && chunk > guard,
    'the ordinary path must leave nothing behind; syslog rows cannot be deleted over REST');
});

test('the generated script stays ES5 — the platform engine is not modern JS', () => {
  const script = wrapScript({ body: '  var x = 1;', sinkName: 'x.sink', token: 'tok123' });
  assert.ok(!/=>/.test(script), 'no arrow functions');
  assert.ok(!/\blet\b|\bconst\b/.test(script), 'no let/const');
  assert.ok(!/`/.test(script), 'no template literals');
});

/* ── reading the fallback channel back ────────────────────────────────────── */

const TOKEN = 'abc123def456abcd';
const line = (tail) => ({ sys_id: 'x', message: `${TOKEN} ${tail}` });

test('a started job is distinguishable from one that never ran', () => {
  assert.equal(readLogChannel([], TOKEN).started, false);
  const seen = readLogChannel([line('NFSTART scope=x_2002152_nwforge')], TOKEN);
  assert.equal(seen.started, true);
  assert.equal(seen.scope, 'x_2002152_nwforge');
});

test('a blocked sink surrenders the sys_id of the orphan it left', () => {
  const seen = readLogChannel([
    line('NFSTART scope=x_2002152_nwforge'),
    line('NFSINK blocked id=48997ce573cfc390a40ef7303ab8b747'),
  ], TOKEN);
  assert.equal(seen.sinkStatus, 'blocked');
  assert.equal(seen.straySinkId, '48997ce573cfc390a40ef7303ab8b747',
    'without this id the blank-named row is undeletable — that was the leak');
});

test('a healthy sink reports ok and leaves no stray to chase', () => {
  const seen = readLogChannel([line('NFSINK ok id=48997ce573cfc390a40ef7303ab8b747')], TOKEN);
  assert.equal(seen.sinkStatus, 'ok');
  assert.equal(seen.straySinkId, null);
});

test('a chunked report is reassembled in order', () => {
  const payload = JSON.stringify({ ok: true, rdbms: 'mysql', probe: 'x'.repeat(50) });
  const a = payload.slice(0, 20);
  const b = payload.slice(20);
  // Deliberately out of order: syslog ordering is not guaranteed.
  const seen = readLogChannel([line(`NFRPT 2/2 ${b}`), line(`NFRPT 1/2 ${a}`)], TOKEN);
  assert.deepEqual(seen.report, JSON.parse(payload));
  assert.equal(seen.chunks, 2);
});

test('a PARTIAL set of chunks is not decoded — half a report is not a report', () => {
  const seen = readLogChannel([line('NFRPT 1/3 {"ok":')], TOKEN);
  assert.equal(seen.report, null);
  assert.equal(seen.chunks, 1);
  assert.equal(seen.expected, 3, 'but the caller can see how far it got');
});

test('a payload that is not JSON is reported as such, never guessed at', () => {
  const seen = readLogChannel([line('NFRPT 1/1 not json at all')], TOKEN);
  assert.equal(seen.report.ok, false);
  assert.match(seen.report.error, /not JSON/);
});

test('lines for another run are ignored', () => {
  const seen = readLogChannel([{ sys_id: 'x', message: 'ffff111122223333 NFSTART scope=global' }], TOKEN);
  assert.equal(seen.started, false);
});

/* ── M-2: listIndexes returns one shape on every path ─────────────────────── */

const FULL_SHAPE = ['table', 'available', 'complete', 'failure', 'scannedTables',
  'definitionRecordCount', 'indexes', 'reason', 'source', 'completeness', 'zeroMeans', 'note'];

test('M-2: the unavailable path carries complete and zeroMeans, defined', () => {
  // The bug: a caller following the documented contract wrote
  // `if (idx.complete === false)` and got `undefined` — falsy, and therefore
  // silently readable as "complete" — exactly when the answer was worthless.
  const idx = unavailableIndexes('incident', ['incident', 'task'], { timedOut: true, cause: 'return-channel-blocked', started: true });
  for (const key of FULL_SHAPE) {
    assert.notEqual(idx[key], undefined, `${key} must be defined on the unavailable path`);
  }
  assert.equal(idx.complete, false);
  assert.equal(typeof idx.zeroMeans, 'string');
  assert.equal(idx.available, false);
});

test('M-2: the unavailable path never returns a false zero', () => {
  const idx = unavailableIndexes('incident', ['incident'], { timedOut: true });
  assert.equal(idx.definitionRecordCount, null, 'a count of 0 would read as "no indexes"');
  assert.equal(idx.indexes, null, 'an empty array would be iterated and reported as unindexed');
  assert.match(idx.zeroMeans, /NOT "incident has no indexes"/);
});

test('M-1: a harness failure is distinguishable from a genuine unknown', () => {
  const harness = unavailableIndexes('incident', ['incident'], { timedOut: true, cause: 'return-channel-blocked', started: true, message: 'ran, could not report' });
  assert.equal(harness.failure, 'harness-unavailable');
  assert.equal(harness.harness.started, true);
  assert.equal(harness.harness.cause, 'return-channel-blocked');
  assert.match(harness.harnessNote, /HARNESS failure, not/);

  const scriptError = unavailableIndexes('incident', ['incident'], { timedOut: false, report: { ok: false, error: 'sys_index is not valid' } });
  assert.equal(scriptError.failure, 'script-error');
  assert.equal(scriptError.harness, undefined, 'a script error is not a harness outage');
  assert.match(scriptError.reason, /sys_index is not valid/);
});
