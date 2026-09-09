/**
 * WI-6 — the renderer cannot put a success glyph on a failure.
 *
 * The defect (E6), rendered literally in the transcript:
 *
 *     ✅ Update set "AGAMYA_Scope" … was not updated
 *
 * plus a duplicated "not captured / not captured" line, and approval cards
 * appearing after the result blocks so the gate looked post-hoc.
 *
 * `writeOutcome.js` is plain JS rather than JSX for exactly this reason — Node
 * cannot import a .jsx file, and the rule that a glyph and its words come from
 * one object is worth asserting rather than eyeballing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { writeOutcome, captureReason, approvalProvenance } from '../../client/src/components/writeOutcome.js';
import { APPROVAL_RESOLVED, APPROVAL_SOURCES, executeTool } from '../src/agent/orchestrator.js';

const NOOP = {
  status: 'no-op', summary: 'no-op: the platform discarded this write — application unchanged',
  dropped: [{ field: 'application', requested: '73cd8416', actual: 'global' }], transformed: [], unverifiable: [],
};
const PARTIAL = {
  status: 'partial', summary: 'partial: the platform dropped 1 field (application)',
  dropped: [{ field: 'application', requested: '73cd8416', actual: 'global' }], transformed: [], unverifiable: [],
};
const TRANSFORMED = {
  status: 'transformed', summary: 'stored, but 1 field differs',
  dropped: [], transformed: [{ field: 'state', requested: 'On Hold', actual: '3', reason: 'a choice label was resolved to its stored value' }], unverifiable: [],
};
const APPLIED = { status: 'applied', summary: 'all 2 requested fields stored as sent', dropped: [], transformed: [], unverifiable: [] };

/* ------------------------------------------------------------------ *
 * The glyph
 * ------------------------------------------------------------------ */

test('E6 — a discarded write renders as a failure, never as a success', () => {
  const v = writeOutcome({ status: 'done', mutating: true, verification: NOOP });
  assert.equal(v.tone, 'bad');
  assert.equal(v.label, 'no-op');
  assert.equal(v.badgeClass, 'red');
  assert.equal(v.dotStyle.background, 'var(--red)');
  assert.match(v.detail, /The platform discarded this write/);
  assert.match(v.detail, /application unchanged/);
});

test('E6 — the tool "succeeded" at the transport layer and STILL renders as a failure', () => {
  // This is the exact shape that produced the ✅-on-a-negation: no exception,
  // status "done", and a write that did not happen.
  const v = writeOutcome({ status: 'done', mutating: true, verification: NOOP });
  assert.notEqual(v.tone, 'ok', 'a 2xx no-op rendered as success');
});

test('no status can pair a success tone with a failure sentence', () => {
  // The invariant, asserted across every status rather than for one case: if a
  // card says something did not happen, its tone is never "ok".
  for (const verification of [NOOP, PARTIAL, TRANSFORMED, APPLIED]) {
    const v = writeOutcome({ status: 'done', mutating: true, verification });
    const saysNotDone = /discarded|dropped|differ|not verifiable/i.test(v.detail || '');
    if (saysNotDone) assert.notEqual(v.tone, 'ok', `"${v.detail}" rendered with an ok tone`);
    if (v.tone === 'ok') assert.equal(v.detail, null, 'a success card carried a caveat it did not style');
  }
});

test('a partial is amber and says what survived', () => {
  const v = writeOutcome({ status: 'done', mutating: true, verification: PARTIAL });
  assert.equal(v.tone, 'warn');
  assert.equal(v.badgeClass, 'amber');
  assert.equal(v.dotStyle.background, 'var(--amber)');
  assert.match(v.detail, /The other fields were stored/);
});

test('a transformed write is amber and gives the reason', () => {
  const v = writeOutcome({ status: 'done', mutating: true, verification: TRANSFORMED });
  assert.equal(v.tone, 'warn');
  assert.match(v.detail, /a choice label was resolved to its stored value/);
});

test('a fully applied write is the only thing that renders clean', () => {
  const v = writeOutcome({ status: 'done', mutating: true, verification: APPLIED });
  assert.equal(v.tone, 'ok');
  assert.equal(v.label, 'done');
  assert.equal(v.detail, null);
});

test('only the three locked tokens are ever used — no new colours', () => {
  const seen = new Set();
  for (const verification of [NOOP, PARTIAL, TRANSFORMED, APPLIED, { status: 'unverified', unverifiable: [{ field: 'comments' }] }]) {
    const v = writeOutcome({ status: 'done', mutating: true, verification });
    if (v.dotStyle?.background) seen.add(v.dotStyle.background);
    if (v.badgeClass) seen.add(v.badgeClass);
  }
  for (const token of seen) {
    assert.ok(['var(--red)', 'var(--amber)', 'red', 'amber'].includes(token), `unexpected token ${token}`);
  }
});

test('a read-only tool is unaffected — it has no verification and never did', () => {
  assert.equal(writeOutcome({ status: 'done' }).tone, 'ok');
  assert.equal(writeOutcome({ status: 'running' }).tone, 'pending');
  assert.equal(writeOutcome({ status: 'error' }).tone, 'bad');
  assert.equal(writeOutcome({}).detail, null);
});

test('a tool that errored before reaching the instance still renders as an error', () => {
  const v = writeOutcome({ status: 'error', mutating: true, verification: null });
  assert.equal(v.tone, 'bad');
  assert.equal(v.label, 'error');
});

/* ------------------------------------------------------------------ *
 * The duplicated capture line
 * ------------------------------------------------------------------ */

test('E6 — the capture message no longer repeats the badge', () => {
  // Rendered as: [not captured] {reason}. The message used to begin with the
  // same two words, giving "not captured / not captured — data, not …".
  const m = { message: 'not captured — data, not configuration (incident does not extend sys_metadata)' };
  const reason = captureReason(m);
  assert.doesNotMatch(reason, /^not captured/i);
  assert.match(reason, /^data, not configuration/);
  assert.match(reason, /does not extend sys_metadata/, 'the reason itself must survive');
});

test('a captured message is trimmed the same way', () => {
  assert.match(captureReason({ message: 'captured 2 updates into NHA · x · global' }), /^2 updates into/);
});

test('a message that does not start with the verdict is left alone', () => {
  const msg = 'capture failed after create_record: boom';
  assert.equal(captureReason({ message: msg }), msg);
});

test('an empty capture message does not become empty chrome', () => {
  assert.equal(captureReason({ message: '' }), '');
  assert.equal(captureReason({}), '');
});

/* ------------------------------------------------------------------ *
 * The gate audit
 * ------------------------------------------------------------------ */

const CLICKED = { source: APPROVAL_SOURCES.USER_CLICK, autoApprove: false };
const AUTO = { source: APPROVAL_SOURCES.AUTO_APPROVE, autoApprove: true };

test('a mutating tool cannot execute without a resolved approval', async () => {
  let ran = false;
  const tool = { name: 'update_record', mutating: true, execute: async () => { ran = true; return {}; } };
  for (const approval of [null, undefined, 'rejected', 'pending', '']) {
    await assert.rejects(
      () => executeTool(tool, {}, approval, CLICKED),
      (err) => {
        assert.match(err.message, /Refusing to execute the mutating tool/);
        assert.equal(err.detail.reason, 'unapproved-mutation');
        return true;
      },
      `approval=${approval} was allowed through`,
    );
  }
  assert.equal(ran, false, 'the tool body ran despite an unresolved approval');
});

test('approved and auto are the only values that let a mutation run', async () => {
  assert.deepEqual([...APPROVAL_RESOLVED].sort(), ['approved', 'auto']);
  const tool = { name: 'update_record', mutating: true, execute: async () => 'ok' };
  assert.equal(await executeTool(tool, {}, 'approved', CLICKED), 'ok');
  assert.equal(await executeTool(tool, {}, 'auto', AUTO), 'ok');
});

test('a read-only tool needs no approval', async () => {
  const tool = { name: 'query_records', mutating: false, execute: async () => 'rows' };
  assert.equal(await executeTool(tool, {}, null), 'rows');
});

/* ------------------------------------------------------------------ *
 * WI-4 — an approval nobody can be attributed is not an approval
 * ------------------------------------------------------------------ */

test('"approved" without a user_click source does NOT execute', async () => {
  // The 2026-08-24 question the database could not answer, turned into a rule:
  // `approval = "approved"` on its own is a string any code path can produce.
  let ran = false;
  const tool = { name: 'update_record', mutating: true, execute: async () => { ran = true; return 'ok'; } };
  for (const source of [null, undefined, 'unknown', 'auto_approve', 'timeout']) {
    await assert.rejects(
      () => executeTool(tool, {}, 'approved', { source, autoApprove: false }),
      (err) => {
        assert.equal(err.detail.reason, 'unattributed-approval');
        assert.match(err.message, /rather than user_click/);
        return true;
      },
      `source=${source} was allowed to stand in for a click`,
    );
  }
  assert.equal(ran, false);
});

test('"auto" cannot run while auto-approve is OFF', async () => {
  // No server-side path may approve a mutation the user did not. If one ever
  // reaches here with autoApprove false, it dies here rather than writing.
  let ran = false;
  const tool = { name: 'update_record', mutating: true, execute: async () => { ran = true; return 'ok'; } };
  await assert.rejects(
    () => executeTool(tool, {}, 'auto', { source: APPROVAL_SOURCES.AUTO_APPROVE, autoApprove: false }),
    (err) => {
      assert.equal(err.detail.reason, 'auto-without-auto-approve');
      assert.match(err.message, /auto-approve is OFF/);
      return true;
    },
  );
  assert.equal(ran, false);
});

test('"auto" with a source that is not auto_approve does not execute either', async () => {
  const tool = { name: 'update_record', mutating: true, execute: async () => 'ok' };
  await assert.rejects(
    () => executeTool(tool, {}, 'auto', { source: APPROVAL_SOURCES.USER_CLICK, autoApprove: true }),
    (err) => { assert.equal(err.detail.reason, 'unattributed-approval'); return true; },
  );
});

test('provenance is missing entirely — still refused', async () => {
  // The shape every pre-WI-4 caller has. It must not be the permissive one.
  const tool = { name: 'update_record', mutating: true, execute: async () => 'ok' };
  await assert.rejects(() => executeTool(tool, {}, 'approved'), /rather than user_click/);
  await assert.rejects(() => executeTool(tool, {}, 'auto'), /auto-approve is OFF/);
});

test('the three sources are the whole vocabulary', () => {
  assert.deepEqual(Object.values(APPROVAL_SOURCES).sort(), ['auto_approve', 'unknown', 'user_click']);
});

/* ------------------------------------------------------------------ *
 * WI-4 — the card says who decided, and never infers it
 * ------------------------------------------------------------------ */

test('the approval card names the person, the robot, or neither', () => {
  assert.match(approvalProvenance({ decided: true, source: 'user_click', at: '2026-08-24T09:48:40.000Z' }), /^You approved · /);
  assert.equal(approvalProvenance({ decided: true, source: 'auto_approve' }), 'Auto-approved — no human saw the gate');
  // The honest rendering of a row written before provenance existed.
  assert.match(approvalProvenance({ decided: true, source: 'unknown' }), /source was never recorded \(unknown\)/);
  assert.match(approvalProvenance({ decided: true }), /source was never recorded \(unknown\)/);
});

test('a rejection says whether a person made it', () => {
  assert.match(approvalProvenance({ decided: false, source: 'user_click' }), /^You rejected/);
  // A timeout is a refusal nobody made, and must never read as one someone did.
  assert.match(approvalProvenance({ decided: false, source: 'timeout' }), /^Expired — nobody answered/);
  assert.match(approvalProvenance({ decided: false, source: 'unknown' }), /^Rejected \(unknown\)/);
});

test('a bad timestamp is shown, not swallowed', () => {
  assert.match(approvalProvenance({ decided: true, source: 'user_click', at: 'not-a-date' }), /not-a-date/);
});
