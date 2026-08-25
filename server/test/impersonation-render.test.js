import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';
import { createSession } from '../src/memory/sessions.js';
import { startMode, endMode } from '../src/memory/impersonation-mode.js';
import {
  impersonationChip, classifyDenial, denialSentence, DENIAL, CHIP_TONE,
} from '../src/agent/impersonation-render.js';

/**
 * B6 — renderer honesty.
 *
 * Both halves are about not asserting something untrue at the moment it would
 * be acted on: the chip on an approval card, and the label on a denial.
 *
 * The denial half rests on a Phase 0 measurement that removed the obvious
 * implementation: across ten cross-scope and ACL-denied operations, NOTHING
 * THREW. There are no denial strings on this platform, so there is nothing to
 * match on and no exception to inspect — only the capability booleans, read
 * before the operation that will not fail.
 */

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowhelpassist-b6-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratchDir, 'test.db'))));

const TARGET = { sys_id: '555a640583fe0f10b939cc65eeaad3a2', user_name: 'aagamya.tanwar', display: 'Aagamya Tanwar' };
const ORIGINAL = { sys_id: '6816f79cc0a8016401c5a33be04be441', user_name: 'admin' };

let n = 0;
function impersonatingSession() {
  const id = `b6-${++n}`;
  createSession({ id, title: 'b6' });
  startMode({ sessionId: id, target: TARGET, original: ORIGINAL, task: 'check catalog visibility' });
  return id;
}

/* ------------------------------------------------------------------ *
 * The chip
 * ------------------------------------------------------------------ */

test('no chip when nothing is being impersonated', () => {
  const id = 'b6-plain';
  createSession({ id, title: 'plain' });
  assert.equal(impersonationChip(id, { executesImpersonated: false }), null);
  assert.equal(impersonationChip(id, { executesImpersonated: true }), null);
});

test('an operation that really runs as the target says AS <user> (impersonated)', () => {
  const s = impersonatingSession();
  const chip = impersonationChip(s, { executesImpersonated: true });
  assert.equal(chip.label, 'AS aagamya.tanwar (impersonated)');
  assert.equal(chip.tone, CHIP_TONE.IMPERSONATED);
  assert.equal(chip.executesImpersonated, true);
  assert.match(chip.title, /keeps no record of the real/);
});

test('an operation that does NOT run as the target must never claim it does', () => {
  /*
   * The honesty property. No mutating tool routes its write through the
   * impersonation wrapper today, so this is the state every real approval card
   * is in. A card reading "AS aagamya.tanwar" over a write the instance will
   * stamp `admin` is a false claim about a person, shown at the moment a human
   * is deciding whether to allow it.
   */
  const s = impersonatingSession();
  const chip = impersonationChip(s, { executesImpersonated: false });
  assert.equal(chip.executesImpersonated, false);
  assert.ok(!/^AS /.test(chip.label), 'must not borrow the impersonated wording');
  assert.ok(!chip.label.includes('(impersonated)'));
  assert.match(chip.label, /runs as NowHelpAssist/);
  assert.match(chip.title, /does not go through the impersonation/);
});

test('the two chip states are not scannable as the same thing', () => {
  const s = impersonatingSession();
  const real = impersonationChip(s, { executesImpersonated: true });
  const modeOnly = impersonationChip(s, { executesImpersonated: false });
  assert.notEqual(real.label, modeOnly.label);
  assert.notEqual(real.tone, modeOnly.tone, 'colour must separate them, not just wording');
});

test('the chip carries the target and task so a card can explain itself', () => {
  const s = impersonatingSession();
  const chip = impersonationChip(s, { executesImpersonated: true });
  assert.equal(chip.target.user_name, 'aagamya.tanwar');
  assert.equal(chip.task, 'check catalog visibility');
});

test('the chip disappears the moment mode ends', () => {
  const s = impersonatingSession();
  assert.ok(impersonationChip(s, { executesImpersonated: true }));
  endMode(s);
  assert.equal(impersonationChip(s, { executesImpersonated: true }), null);
});

test('executesImpersonated is not defaulted true by accident', () => {
  const s = impersonatingSession();
  assert.equal(impersonationChip(s).executesImpersonated, false, 'the safe reading must be the default');
});

/* ------------------------------------------------------------------ *
 * Denial labelling — the canRead discriminator
 * ------------------------------------------------------------------ */

/* Measured at Phase 0 P0.12b, from the global harness on a caller_access=2 table. */
const LAYER_1 = { canRead: true, canCreate: false, canWrite: false, canDelete: false };
/* Measured for a role-less impersonated user on incident. */
const LAYER_2 = { canRead: false, canCreate: true, canWrite: false, canDelete: false };
const ALLOWED = { canRead: true, canCreate: true, canWrite: true, canDelete: true };

test('canRead TRUE with the operation refused is a scope/application block', () => {
  const v = classifyDenial({ preflight: LAYER_1, operation: 'update' });
  assert.equal(v.layer, DENIAL.LAYER_1);
  assert.equal(v.allowed, false);
  assert.equal(v.label, 'blocked by application/scope access');
  assert.match(v.detail, /property of the TABLE/);
});

test('canRead FALSE is the user ACL', () => {
  const v = classifyDenial({ preflight: LAYER_2, operation: 'update' });
  assert.equal(v.layer, DENIAL.LAYER_2);
  assert.equal(v.allowed, false);
  assert.match(v.detail, /their ACLs/);
});

test('a scope block never names the user — that would assert a fact it has no evidence for', () => {
  const s = denialSentence({ preflight: LAYER_1, operation: 'update', target: TARGET });
  assert.equal(s.layer, DENIAL.LAYER_1);
  assert.match(s.sentence, /Blocked by application\/scope access/);
  assert.match(s.sentence, /not by aagamya\.tanwar's permissions/);
  assert.ok(!/aagamya\.tanwar lacks/.test(s.sentence), 'must not read as a claim about the person');
});

test('a user-ACL block DOES name the user, because that is what it is about', () => {
  const s = denialSentence({ preflight: LAYER_2, operation: 'update', target: TARGET });
  assert.equal(s.layer, DENIAL.LAYER_2);
  assert.equal(s.sentence, 'aagamya.tanwar lacks permission for this.');
});

test('the operation decides which flag is consulted — the same pre-flight can allow one and refuse another', () => {
  assert.equal(classifyDenial({ preflight: ALLOWED, operation: 'delete' }).layer, DENIAL.ALLOWED);
  assert.equal(classifyDenial({ preflight: { ...ALLOWED, canDelete: false }, operation: 'delete' }).layer, DENIAL.LAYER_1);
  assert.equal(classifyDenial({ preflight: { ...ALLOWED, canDelete: false }, operation: 'update' }).layer, DENIAL.ALLOWED);
});

test('read-denied but write-allowed is PERMITTED, not a denial — measured live on incident', () => {
  /*
   * The live pre-flight for a role-less user on `incident`: canRead false,
   * canCreate TRUE. Phase 0 watched that insert genuinely succeed. Labelling it
   * "the user lacks permission" would put a denial on an operation that was
   * about to work — which is what an earlier version of this classifier did,
   * because it consulted canRead before the operation's own flag.
   */
  const v = classifyDenial({ preflight: LAYER_2, operation: 'create' });
  assert.equal(v.layer, DENIAL.ALLOWED);
  assert.equal(v.allowed, true);
  assert.equal(v.writeOnly, true);
  // The consequence is named rather than hidden: it lands, and they cannot see it.
  assert.match(v.detail, /cannot READ this table/);
  assert.match(v.detail, /Read it back as NowHelpAssist/);

  // And it produces no accusation about the person.
  const s = denialSentence({ preflight: LAYER_2, operation: 'create', target: TARGET });
  assert.equal(s.sentence, null);
});

test('everything permitted is not a denial and produces no sentence', () => {
  const s = denialSentence({ preflight: ALLOWED, operation: 'update', target: TARGET });
  assert.equal(s.layer, DENIAL.ALLOWED);
  assert.equal(s.allowed, true);
  assert.equal(s.sentence, null);
});

test('a missing pre-flight is UNKNOWN, never "fine"', () => {
  for (const p of [null, undefined, 'nope']) {
    const v = classifyDenial({ preflight: p });
    assert.equal(v.layer, DENIAL.UNKNOWN);
    assert.equal(v.allowed, null, 'absence of evidence must not render as permission');
    assert.match(v.detail, /Nothing throws on denial/);
  }
});

test('the platform booleans arrive as strings, and both spellings are honoured', () => {
  // GlideRecord returns 'true'/'false' through String(); the wrapper carries
  // whatever it got. Reading 'false' as truthy would invert every verdict.
  const asStrings = { canRead: 'true', canCreate: 'false', canWrite: 'false', canDelete: 'false' };
  assert.equal(classifyDenial({ preflight: asStrings, operation: 'update' }).layer, DENIAL.LAYER_1);
  const denied = { canRead: 'false', canCreate: 'false', canWrite: 'false', canDelete: 'false' };
  assert.equal(classifyDenial({ preflight: denied, operation: 'update' }).layer, DENIAL.LAYER_2);
});

test('no denial is ever labelled from an exception — there are none to read', () => {
  // Phase 0 measured that no denial throws, so an exception is never evidence
  // of one. Handing the classifier a plausible-looking exception must change
  // nothing: the capability booleans are the only input it is allowed to read.
  const base = classifyDenial({ preflight: LAYER_1, operation: 'update' });
  for (const noise of ['SecurityException', 'java.lang.SecurityException: not authorized', null]) {
    const v = classifyDenial({ preflight: LAYER_1, operation: 'update', exception: noise, error: noise });
    assert.deepEqual(v, base, 'an exception must not be able to move the verdict');
  }
  // And an exception with a PERMISSIVE pre-flight must not manufacture a denial.
  const allowed = classifyDenial({ preflight: ALLOWED, operation: 'update', exception: 'SecurityException' });
  assert.equal(allowed.layer, DENIAL.ALLOWED);
});
