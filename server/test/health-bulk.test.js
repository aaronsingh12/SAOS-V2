import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BULK_MAX, BULK_ITEM_STATUS, SKIPPED_STATUSES, hasFieldFix, normaliseSelection, normaliseApprovals,
  classifyProposal, classifyOutcome, proposalNote, summarise,
} from '../src/health/bulk.js';
import { FIX_FIELD } from '../src/health/proposal.js';

/*
 * Bulk Fix — the pure half.
 *
 * Nothing here touches a database, a socket or a model. These are the
 * decisions that are the same for every finding type: what a selection is,
 * what an item's status may be, and how a batch is summarised without rounding
 * a partial result up to "done".
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const fp = (n) => n.toString(16).padStart(64, '0');

/* ── Selection ─────────────────────────────────────────────────────────── */

test('a selection is deduplicated on (run, fingerprint) and normalised', () => {
  const r = normaliseSelection([
    { runId: 'r1', fingerprint: fp(1) },
    { runId: 'r1', fingerprint: fp(1).toUpperCase() },   // same finding, different case
    { runId: 'r2', fingerprint: fp(1) },                 // same fingerprint, another run — a different row
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => i.key), [`r1:${fp(1)}`, `r2:${fp(1)}`]);
});

test('an empty or malformed selection is refused, not trimmed', () => {
  assert.equal(normaliseSelection([]).ok, false);
  assert.equal(normaliseSelection(null).reason, 'empty');
  assert.equal(normaliseSelection([{ runId: 'r1', fingerprint: 'not-a-hash' }]).reason, 'malformed');
  assert.equal(normaliseSelection([{ fingerprint: fp(1) }]).reason, 'malformed');
});

test('a selection over the cap is refused whole — a silently shortened batch would report "done" for findings nobody touched', () => {
  const many = Array.from({ length: BULK_MAX + 1 }, (_, i) => ({ runId: 'r', fingerprint: fp(i + 1) }));
  const r = normaliseSelection(many);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too_many');
  assert.match(r.note, new RegExp(`${BULK_MAX}`));
  assert.equal(normaliseSelection(many.slice(0, BULK_MAX)).ok, true);
});

test('approvals need the fingerprint the reviewer SAW — "approve whatever is stored now" is refused', () => {
  assert.equal(normaliseApprovals([{ proposalId: 'p1' }]).reason, 'malformed');
  assert.equal(normaliseApprovals([{ proposalId: 'p1', fingerprint: fp(9) }]).ok, true);
  /* The same proposal twice is one proposal: a duplicate in the body cannot
     become a duplicate write. */
  const r = normaliseApprovals([{ proposalId: 'p1', fingerprint: fp(9) }, { proposalId: 'p1', fingerprint: fp(9) }]);
  assert.equal(r.items.length, 1);
});

/* ── Fixability is the proposal registry, nothing else ─────────────────── */

test('hasFieldFix is FIX_FIELD — a rule added there participates in bulk without touching bulk.js', () => {
  for (const rule of Object.keys(FIX_FIELD)) assert.equal(hasFieldFix(rule), true, rule);
  assert.equal(hasFieldFix('ITSM-INC-STALE'), false);
  assert.equal(hasFieldFix('MID-NONE'), false);
  assert.equal(hasFieldFix(undefined), false);
  const src = read('health/bulk.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/'(CMDB|ITSM|CRED|REL|CSDM|INT|EVENT|SEC|OUTAGE)-[A-Z-]+'/.test(src),
    'bulk.js names a rule id — bulk must be generic over the registry, never over a rule');
});

/* ── Classification from the proposal's own facts ──────────────────────── */

test('a proposal is classified by what it carries, never by its rule', () => {
  assert.equal(classifyProposal({ field: 'active', operation: 'update', changes: [{}], llm: { status: 'preset' } }, 1), BULK_ITEM_STATUS.PROPOSED);
  assert.equal(classifyProposal({ field: null, operation: 'delete', changes: [{}] }, 1), BULK_ITEM_STATUS.PROPOSED);
  assert.equal(classifyProposal({ field: 'owned_by', operation: 'update', changes: [{ proposedValue: '' }], llm: { status: 'unavailable' } }, 0), BULK_ITEM_STATUS.NEEDS_VALUE);
  assert.equal(classifyProposal({ field: null, operation: 'update', changes: [], llm: { status: 'no_field_fix' } }, 0), BULK_ITEM_STATUS.NO_FIELD_FIX);
  assert.equal(classifyProposal({ field: 'active', operation: 'update', changes: [], unreadable: [{ sys_id: 'x' }] }, 0), BULK_ITEM_STATUS.STALE);
  assert.equal(classifyProposal(null, 0), BULK_ITEM_STATUS.PROPOSAL_FAILED);
  for (const s of [BULK_ITEM_STATUS.NO_FIELD_FIX, BULK_ITEM_STATUS.NEEDS_VALUE, BULK_ITEM_STATUS.STALE]) {
    assert.ok(proposalNote(s), `${s} has no note`);
  }
});

test('an outcome uses the proposal store\'s own verdict — a 2xx that stored nothing is not applied', () => {
  assert.equal(classifyOutcome({ ok: true, status: 'applied' }), BULK_ITEM_STATUS.APPLIED);
  assert.equal(classifyOutcome({ ok: true, status: 'partial' }), BULK_ITEM_STATUS.PARTIAL);
  assert.equal(classifyOutcome({ ok: false, status: 'partial' }), BULK_ITEM_STATUS.PARTIAL);
  assert.equal(classifyOutcome({ ok: false, status: 'failed' }), BULK_ITEM_STATUS.FAILED);
  assert.equal(classifyOutcome({ ok: false, reason: 'fingerprint_mismatch' }), BULK_ITEM_STATUS.FAILED);
  assert.equal(classifyOutcome({ ok: false, reason: 'cancelled' }), BULK_ITEM_STATUS.CANCELLED);
  assert.equal(classifyOutcome(null), BULK_ITEM_STATUS.FAILED);
});

/* ── The summary never rounds up ───────────────────────────────────────── */

test('3 applied · 1 needs a value · 1 failed is NOT ok, and every count is in the note', () => {
  const s = summarise([
    { status: 'applied' }, { status: 'applied' }, { status: 'applied' },
    { status: 'needs_value' }, { status: 'failed' },
  ]);
  assert.equal(s.ok, false);
  assert.equal(s.applied, 3);
  assert.equal(s.skipped, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.total, 5);
  assert.match(s.note, /3 applied/);
  assert.match(s.note, /1 failed/);
  assert.match(s.note, /1 skipped/);
});

test('only a batch where EVERY item applied in full is ok', () => {
  assert.equal(summarise([{ status: 'applied' }, { status: 'applied' }]).ok, true);
  assert.equal(summarise([{ status: 'applied' }, { status: 'partial' }]).ok, false);
  assert.equal(summarise([{ status: 'applied' }, { status: 'excluded' }]).ok, false);
  assert.equal(summarise([]).ok, false);
  assert.equal(summarise([{ status: 'applied' }, { status: 'cancelled' }]).failed, 1);
});

test('every skipped status is in the closed vocabulary, and the vocabulary is closed', () => {
  const all = new Set(Object.values(BULK_ITEM_STATUS));
  for (const s of SKIPPED_STATUSES) assert.ok(all.has(s), s);
  assert.equal(Object.isFrozen(BULK_ITEM_STATUS), true);
});

/* ── The module cannot write, bind or resolve ──────────────────────────── */

test('bulk.js can name no executor, no approval primitive and no instance client', () => {
  const src = read('health/bulk.js');
  for (const forbidden of ['executeTool', 'resolveApproval', 'awaitApprovalDecision', 'approvePlan', 'table.', 'servicenow/', 'fetch(']) {
    assert.ok(!src.includes(forbidden), `bulk.js mentions ${forbidden}`);
  }
});
