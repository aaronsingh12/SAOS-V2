import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';
import { _setSettingsForTests } from '../src/config/store.js';

/*
 * K5 — the store of what SNADA has VERIFIED for itself.
 *
 * The whole value of this store is that everything in it was measured. So the
 * tests that matter are the refusals: an observation with no evidence, or with
 * a category or evidence kind outside the closed lists, must not get a row.
 * One unmeasured row and the store is no longer distinguishable from a log of
 * model output, which is the thing it exists to be different from.
 */

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-obs-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const {
  recordObservation, listObservations, capabilityClaimsFor, deleteObservation,
  observationStats, OBSERVATION_CATEGORIES, EVIDENCE_KINDS, UNIVERSAL,
} = await import('../src/knowledge/observations.js');
const { resolveConflict } = await import('../src/knowledge/precedence.js');

const INSTANCE_A = 'https://dev00001.service-now.com';
const INSTANCE_B = 'https://dev00002.service-now.com';
const bindTo = (instanceUrl) => _setSettingsForTests({ connection: { instanceUrl } });

const valid = (over = {}) => ({
  category: 'sdk-limitation',
  subject: 'catalog_ui_policy_action',
  observation: 'This table cannot be written over the REST Table API.',
  evidenceKind: 'read-back',
  evidence: 'POST returned 201 with a sys_id; a follow-up GET on that sys_id returned 0 records.',
  ...over,
});

test.beforeEach(() => { bindTo(INSTANCE_A); });
test.afterEach(() => { _setSettingsForTests(null); });

/* ── the verification gate ────────────────────────────────────────────────── */

test('an observation with NO evidence is refused', () => {
  const res = recordObservation(valid({ evidence: '' }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /evidence is required/);
  assert.match(res.errors.join(' '), /LLM output with a database row/);
});

test('naming an evidence kind without producing evidence is still refused', () => {
  // The shape an unverified claim takes once someone knows a field is checked.
  const res = recordObservation(valid({ evidence: '   ' }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /evidence is required/);
});

test('an evidence KIND outside the closed list is refused, and the list is named', () => {
  const res = recordObservation(valid({ evidenceKind: 'the model concluded it' }));
  assert.equal(res.ok, false);
  const msg = res.errors.join(' ');
  assert.match(msg, /evidence_kind must be one of/);
  for (const k of EVIDENCE_KINDS) assert.ok(msg.includes(k));
  // "the model reasoned to it" is precisely what this store filters, so it can
  // never become an accepted kind of proof.
  assert.ok(!EVIDENCE_KINDS.includes('reasoning'));
  assert.ok(!EVIDENCE_KINDS.includes('inference'));
});

test('an unknown category is refused rather than silently created', () => {
  const res = recordObservation(valid({ category: 'hunch' }));
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /category must be one of/);
});

test('subject and observation are both required', () => {
  assert.equal(recordObservation(valid({ subject: '' })).ok, false);
  assert.equal(recordObservation(valid({ observation: '' })).ok, false);
});

test('the five categories the spec asks for are all present', () => {
  for (const c of ['sdk-limitation', 'implementation-success', 'implementation-failure',
    'version-behaviour', 'tooling-defect']) {
    assert.ok(OBSERVATION_CATEGORIES.includes(c), `${c} must be a recordable category`);
  }
});

/* ── storing and confirming ───────────────────────────────────────────────── */

test('a verified observation is stored with its artifact intact', () => {
  const res = recordObservation(valid({ subject: 'store-1' }));
  assert.equal(res.ok, true);
  assert.equal(res.status, 'recorded');
  assert.equal(res.confirmations, 1);

  const [row] = listObservations({ subject: 'store-1' });
  assert.equal(row.evidence_kind, 'read-back');
  assert.match(row.evidence, /returned 0 records/);
  assert.equal(row.instance, INSTANCE_A);
  deleteObservation(res.id);
});

test('re-observing the same thing CONFIRMS it rather than duplicating it', () => {
  const first = recordObservation(valid({ subject: 'confirm-1' }));
  const second = recordObservation(valid({ subject: 'confirm-1', evidence: 'observed again on a second table' }));
  assert.equal(second.id, first.id);
  assert.equal(second.status, 'confirmed');
  assert.equal(second.confirmations, 2);
  assert.equal(listObservations({ subject: 'confirm-1' }).length, 1);
  deleteObservation(first.id);
});

/* ── scope: a measurement on one PDI is not a fact about another ──────────── */

test('an observation measured on one instance does NOT leak to another', () => {
  // The same rule the fact ledger learned the hard way: replayed confidently on
  // a second PDI, a single-instance measurement is a confidently wrong answer.
  bindTo(INSTANCE_A);
  const a = recordObservation(valid({ subject: 'scope-1', observation: 'Measured on instance A only.' }));
  assert.equal(listObservations({ subject: 'scope-1' }).length, 1);

  bindTo(INSTANCE_B);
  assert.equal(listObservations({ subject: 'scope-1' }).length, 0,
    'instance B must not see what was measured on instance A');

  bindTo(INSTANCE_A);
  deleteObservation(a.id);
});

test('a UNIVERSAL observation is visible from every instance', () => {
  bindTo(INSTANCE_A);
  const u = recordObservation(valid({
    subject: 'scope-2', instance: UNIVERSAL,
    observation: 'A property of the SDK, not of any one instance.',
  }));
  bindTo(INSTANCE_B);
  assert.equal(listObservations({ subject: 'scope-2' }).length, 1);
  deleteObservation(u.id);
});

/* ── feeding the conflict ladder ──────────────────────────────────────────── */

test('a recorded SDK limitation becomes a tool_capability claim that OVERRULES documentation', () => {
  // The end-to-end of the spec's conflict example, driven by stored data rather
  // than by a rule written into a prompt.
  const rec = recordObservation(valid({
    subject: 'sys_update_set.application',
    observation: 'application cannot be set over REST; the platform forces the session scope.',
    evidenceKind: 'read-back',
    evidence: 'PUT accepted; GET shows the original scope unchanged.',
    instance: UNIVERSAL,
  }));

  const claims = capabilityClaimsFor('sys_update_set.application');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].source, 'tool_capability');
  assert.match(claims[0].ref, /observation #/);
  assert.ok(claims[0].evidence, 'the claim must carry its evidence, or the ladder will demote it');

  const res = resolveConflict({
    question: 'Can sys_update_set.application be set over REST?',
    claims: [
      { source: 'documentation', says: 'the field is writable through the Table API' },
      ...claims,
    ],
  });
  assert.equal(res.verdict, 'resolved');
  assert.equal(res.winner.source, 'tool_capability');
  assert.equal(res.demoted.length, 0, 'a stored observation carries evidence and must not be demoted');
  deleteObservation(rec.id);
});

test('an implementation-success is NOT promoted to a capability claim', () => {
  // "It worked once" is a record of one build, not a general statement about
  // what the tools can do — promoting it would let it outrank documentation
  // for every future case.
  const rec = recordObservation(valid({
    category: 'implementation-success',
    subject: 'promotion-1',
    observation: 'A flow built this way installed cleanly.',
    evidenceKind: 'tool-result',
    evidence: 'create_flow_live returned sys_id 0123.',
  }));
  assert.deepEqual(capabilityClaimsFor('promotion-1'), []);
  assert.equal(listObservations({ subject: 'promotion-1' }).length, 1, 'it is still stored, just not promoted');
  deleteObservation(rec.id);
});

test('stats count what is actually stored', () => {
  const before = observationStats().total;
  const rec = recordObservation(valid({ subject: 'stats-1' }));
  assert.equal(observationStats().total, before + 1);
  deleteObservation(rec.id);
  assert.equal(observationStats().total, before);
});
