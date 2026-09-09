import test from 'node:test';
import assert from 'node:assert/strict';

import { pageAll, reconcileWalk } from '../src/servicenow/dba-metadata.js';

/*
 * C-1 — the paging primitive lost rows and called the result complete.
 *
 * MEASURED on dev428633, sys_dictionary?reference=sys_user, limit 1000:
 *
 *   1000, 1000, 1000, 999, 402, 0
 *
 * The 999 is a SHORT page in the MIDDLE of the result. The loop treated it as
 * end-of-results, returned 3999 of 4401 rows, and reported `truncated: false` —
 * 403 rows lost and the answer asserted complete, in the one primitive every
 * other layer reads through.
 *
 * These are the page shapes themselves, so the bug is reproducible without a
 * 4,400-row table and a live instance. A paging bug that can only be caught by
 * querying the instance is a paging bug that comes back.
 */

const MEASURED_PAGES = [1000, 1000, 1000, 999, 402, 0];

/** A fake table whose pages come back in a given shape, keyed by sys_id. */
function fakeTable(pageSizes) {
  let issued = 0;
  let minted = 0;
  const seen = [];
  return {
    seen,
    get pagesIssued() { return issued; },
    fetchPage({ after, limit }) {
      const n = Math.min(pageSizes[issued] ?? 0, limit);
      issued += 1;
      const rows = [];
      for (let i = 0; i < n; i++) {
        // sys_ids ascend, so the keyset watermark is meaningful.
        const id = String(minted++).padStart(32, '0');
        rows.push({ sys_id: id, element: `e${id}` });
        seen.push(id);
      }
      if (after) assert.ok(rows.every((r) => r.sys_id > after), 'a keyset page must start after the watermark');
      return Promise.resolve(rows);
    },
  };
}

test('C-1: a SHORT page in the middle does not end the walk', async () => {
  const t = fakeTable(MEASURED_PAGES);
  const { rows, exhausted, terminator, pages } = await pageAll({ fetchPage: t.fetchPage, max: 8000 });

  assert.equal(rows.length, 4401, 'the walk must collect every row, not stop at the 999');
  assert.notEqual(rows.length, 3999, 'stopping at the short page is exactly the C-1 regression');
  assert.equal(exhausted, true);
  assert.equal(terminator, 'empty-page', 'only an empty page ends the walk');
  assert.equal(pages, 6);
});

test('C-1: the walk collects DISTINCT rows — keyset does not repeat or skip', async () => {
  const t = fakeTable(MEASURED_PAGES);
  const { rows } = await pageAll({ fetchPage: t.fetchPage, max: 8000 });
  assert.equal(new Set(rows.map((r) => r.sys_id)).size, rows.length);
});

test('the authoritative total ends the walk without a further page', async () => {
  const t = fakeTable([1000, 1000, 1000, 999, 402, 0]);
  const { rows, pages, terminator } = await pageAll({
    fetchPage: t.fetchPage, max: 8000, knownTotal: async () => 4401,
  });
  assert.equal(rows.length, 4401);
  assert.equal(terminator, 'aggregate-total');
  assert.equal(pages, 5, 'reaching the known total spares the empty confirming page');
});

test('the caller ceiling stops the walk and is NOT exhaustion', async () => {
  const t = fakeTable(MEASURED_PAGES);
  const { rows, exhausted, terminator } = await pageAll({ fetchPage: t.fetchPage, max: 1000 });
  assert.equal(rows.length, 1000);
  assert.equal(exhausted, false);
  assert.equal(terminator, 'ceiling');
});

test('a page without a sys_id is refused rather than looped on forever', async () => {
  await assert.rejects(
    () => pageAll({ fetchPage: async () => [{ element: 'no_sys_id' }], max: 10 }),
    /watermark cannot advance/,
  );
});

/* ── reconciliation against the aggregate count ───────────────────────────── */

test('collected == aggregate is complete', () => {
  const r = reconcileWalk({ collected: 4401, expectedTotal: 4401, exhausted: true });
  assert.equal(r.complete, true);
  assert.equal(r.truncated, false);
  assert.equal(r.shortfall, 0);
});

test('the MEASURED 1-row drift is drift, not loss', () => {
  // /api/now/stats counts 4402 for a query the Table API answers with 4401
  // rows, stably, on repeated walks — the two do not apply row-level ACLs
  // identically. One row is drift; it must not flip the answer to incomplete.
  const r = reconcileWalk({ collected: 4401, expectedTotal: 4402, exhausted: true });
  assert.equal(r.complete, true);
  assert.equal(r.materialGap, false);
  assert.equal(r.shortfall, 1);
});

test('the C-1 gap of 403 rows is LOSS and can never read as complete', () => {
  const r = reconcileWalk({ collected: 3999, expectedTotal: 4402, exhausted: true });
  assert.equal(r.complete, false, 'a 403-row gap must never be reported complete');
  assert.equal(r.truncated, true);
  assert.equal(r.materialGap, true);
  assert.equal(r.shortfall, 403);
});

test('a capped walk reports a FLOOR with the correct delta, never a total', () => {
  const r = reconcileWalk({ collected: 1000, expectedTotal: 4402, exhausted: false });
  assert.equal(r.complete, false);
  assert.equal(r.truncated, true);
  assert.equal(r.shortfall, 3402);
});

test('exhaustion alone is not completeness when the totals disagree', () => {
  // The walk ended properly AND the answer is still short — two separate
  // questions, and C-1 was the first being mistaken for the second.
  assert.equal(reconcileWalk({ collected: 10, expectedTotal: 900, exhausted: true }).complete, false);
});

test('with no authoritative total, an empty terminating page is the best answer there is', () => {
  const r = reconcileWalk({ collected: 42, expectedTotal: null, exhausted: true });
  assert.equal(r.complete, true);
  assert.equal(r.shortfall, null);
  assert.equal(r.materialGap, false);
});
