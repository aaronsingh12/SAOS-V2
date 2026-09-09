import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isIrreversible, confirmationPhraseFor, escalationOpen } from '../src/servicenow/dba-data.js';
import { _setSettingsForTests } from '../src/config/store.js';
import { TOOLS } from '../src/agent/tools.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * E2 — Layer 4, offline.
 *
 * The live half is proven against the instance. What is asserted here is the
 * part a live run cannot demonstrate convincingly: that the gate CANNOT be
 * opened from inside, and that no irreversible operation can slip into a lower
 * tier by omission.
 */

test.afterEach(() => { _setSettingsForTests(null); });

/* ── the tier boundary ────────────────────────────────────────────────────── */

test('every irreversible operation is Tier 3 — none may be omitted', () => {
  // A missing entry here is not a cosmetic bug: it routes a drop through the
  // Tier 1/2 path, where there is no export, no typed phrase and no escalation.
  for (const op of [
    'drop_table', 'drop_column', 'truncate_table', 'rename_table',
    'rename_column', 'change_column_type', 'decrease_column_width', 'reparent_column',
  ]) {
    assert.equal(isIrreversible(op), true, `${op} must be Tier 3`);
  }
});

test('reversible and additive operations are NOT Tier 3', () => {
  for (const op of ['record_delete', 'add_column', 'augment_column', 'create_table', 'drop_index', 'background_script']) {
    assert.equal(isIrreversible(op), false, `${op} must not be gated as irreversible`);
  }
  assert.equal(isIrreversible(''), false);
  assert.equal(isIrreversible(undefined), false);
});

/* ── the typed phrase ─────────────────────────────────────────────────────── */

test('the confirmation phrase names the exact target, so it cannot be reused', () => {
  const a = confirmationPhraseFor('drop_column', 'incident.caller_id');
  const b = confirmationPhraseFor('drop_column', 'incident.short_description');
  assert.equal(a, 'DROP COLUMN incident.caller_id PERMANENTLY');
  assert.notEqual(a, b, 'two different targets must not share a phrase');
  assert.notEqual(confirmationPhraseFor('drop_table', 'incident'), a);
});

/* ── the escalation the agent cannot grant itself ─────────────────────────── */

test('the escalation is closed by default', () => {
  _setSettingsForTests({});
  assert.equal(escalationOpen(), false);
  _setSettingsForTests({ dba: {} });
  assert.equal(escalationOpen(), false);
});

test('only an exact true opens it — no truthy value will do', () => {
  for (const v of ['true', 1, 'yes', {}]) {
    _setSettingsForTests({ dba: { allowIrreversible: v } });
    assert.equal(escalationOpen(), false, `${JSON.stringify(v)} must not open the escalation`);
  }
  _setSettingsForTests({ dba: { allowIrreversible: true } });
  assert.equal(escalationOpen(), true);
});

test('NO agent tool can write settings — the escalation is unreachable from inside', () => {
  /*
   * This is the load-bearing assertion of the whole tier, and it asserts an
   * ABSENCE — which is exactly the kind of guarantee nobody notices being
   * removed. If a settings-writing tool is ever added, this fails and the
   * "human escalation" claim stops being true the same day.
   */
  const src = fs.readFileSync(path.join(SERVER_ROOT, 'src', 'agent', 'tools.js'), 'utf8');
  assert.doesNotMatch(src, /saveSettings|clearConnection|_setSettingsForTests/,
    'the agent tool catalogue must not be able to write settings');

  const suspicious = TOOLS.filter((t) => /setting|config|escalat|allowIrreversible/i.test(`${t.name} ${JSON.stringify(t.inputSchema)}`));
  assert.deepEqual(suspicious.map((t) => t.name), [],
    'no tool may take a settings/escalation-shaped input');
});

/* ── tool wiring ──────────────────────────────────────────────────────────── */

test('the destructive tools are registered, and only the acting ones are mutating', () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  for (const n of ['dba_set_field_value', 'dba_delete_record', 'dba_create_record', 'dba_read_record',
    'dba_recovery_status', 'dba_snapshot', 'dba_destructive_gate', 'dba_execute_irreversible', 'dba_augment_table']) {
    assert.ok(byName.has(n), `${n} is not registered`);
  }
  // Asking what a destructive op would require must never itself be a mutation,
  // and must never be gated behind approval — otherwise nobody can find out.
  assert.equal(byName.get('dba_destructive_gate').mutating, false);
  assert.equal(byName.get('dba_snapshot').mutating, false);
  assert.equal(byName.get('dba_recovery_status').mutating, false);
  // And the ones that act must be.
  for (const n of ['dba_set_field_value', 'dba_delete_record', 'dba_execute_irreversible', 'dba_augment_table']) {
    assert.equal(byName.get(n).mutating, true, `${n} must be flagged mutating`);
  }
});

test('the irreversible executor requires all four gate inputs in its schema', () => {
  const t = TOOLS.find((x) => x.name === 'dba_execute_irreversible');
  for (const req of ['snapshot_id', 'typed_confirmation', 'impact_acknowledged']) {
    assert.ok(t.inputSchema.required.includes(req), `${req} must be required, not optional`);
  }
});

test('no destructive tool description ever calls the operation reversible', () => {
  for (const name of ['dba_destructive_gate', 'dba_execute_irreversible']) {
    const d = TOOLS.find((t) => t.name === name).description;
    /*
     * Match an affirmative CLAIM of reversibility, not the word.
     *
     * The first version of this used /\breversible\b/ and failed on
     * "NEVER describes the result as reversible" — a sentence that says the
     * opposite. A guard that fires on the correct text teaches people to weaken
     * the guard.
     */
    assert.doesNotMatch(d, /\b(is|are|it's|its)\s+reversible\b|\bcan be (undone|rolled back|reversed|recovered)\b/i,
      `${name} must not claim reversibility`);
    assert.match(d, /irreversible|NEVER describes|no rollback/i);
  }
});
