import test from 'node:test';
import assert from 'node:assert/strict';

import { validateAugmentSpec, generateAugmentSource } from '../src/servicenow/dba-authoring.js';
import { classifyOperation, OPERATION_MATRIX } from '../src/servicenow/dba-impact.js';

/*
 * E1 — the augment contract, offline.
 *
 * An augment is the only way NowHelpAssist is permitted to touch an OOTB table,
 * so what these assert is not "does it emit valid TypeScript" (the offline build
 * answers that for free) but the three properties that make it SAFE:
 *
 *   1. it is additive, and cannot be talked into being anything else;
 *   2. the column carries the authoring scope's prefix, so it cannot collide
 *      with another application's column on a table neither of them owns;
 *   3. it never marks a column mandatory — which on a table with millions of
 *      existing rows would make every one of them fail validation on next save.
 */

const SCOPE = 'x_2002152_nwforge';
const SPEC = {
  baseTable: 'incident',
  fields: [{ name: `${SCOPE}_triage_note`, type: 'string', label: 'Triage Note', maxLength: 400 }],
};
const norm = (over = {}) => validateAugmentSpec({ ...SPEC, ...over }, { scope: SCOPE }).normalized;

/* ── the spec ─────────────────────────────────────────────────────────────── */

test('a well-formed augment validates', () => {
  const v = validateAugmentSpec(SPEC, { scope: SCOPE });
  assert.equal(v.ok, true, v.errors.join('; '));
});

test('a cross-scope column MUST carry the authoring scope prefix', () => {
  const v = validateAugmentSpec({ ...SPEC, fields: [{ name: 'u_triage_note', type: 'string' }] }, { scope: SCOPE });
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /must carry this scope's prefix/);
  assert.match(v.errors[0], /collide/);
});

test('mandatory is forced OFF even when the caller asks for it', () => {
  // The dangerous request, granted in the least dangerous way. A mandatory
  // column on an existing table invalidates every row that predates it.
  const n = norm({ fields: [{ name: `${SCOPE}_x`, type: 'string', mandatory: true }] });
  assert.equal(n.fields[0].mandatory, false);
});

test('unique is forced off too — a unique index on existing data can fail to build', () => {
  const n = norm({ fields: [{ name: `${SCOPE}_x`, type: 'string', unique: true }] });
  assert.equal(n.fields[0].unique, false);
});

test('an augment with no columns is refused — there is no such thing as an empty augment', () => {
  assert.match(validateAugmentSpec({ ...SPEC, fields: [] }, { scope: SCOPE }).errors.join(' '), /at least one column/);
});

test('a duplicate column, a bad type and a targetless reference are each named', () => {
  const dup = validateAugmentSpec({ ...SPEC, fields: [{ name: `${SCOPE}_a`, type: 'string' }, { name: `${SCOPE}_a`, type: 'string' }] }, { scope: SCOPE });
  assert.match(dup.errors.join(' '), /defined twice/);
  assert.match(validateAugmentSpec({ ...SPEC, fields: [{ name: `${SCOPE}_a`, type: 'blob' }] }, { scope: SCOPE }).errors.join(' '), /does not emit/);
  assert.match(validateAugmentSpec({ ...SPEC, fields: [{ name: `${SCOPE}_a`, type: 'reference' }] }, { scope: SCOPE }).errors.join(' '), /must name the table it points at/);
});

/* ── the generated source ─────────────────────────────────────────────────── */

test('the named export is the BASE TABLE name, which the SDK requires', () => {
  // MEASURED: exporting as `<scope>_augment_incident` fails the build with
  // TS213 "should be exported as a named export with the name 'incident'".
  const src = generateAugmentSource(norm(), { scope: SCOPE, targetScope: 'global' });
  assert.match(src, /export const incident = Table\(/);
});

test('the source augments the base table and never redefines it', () => {
  const src = generateAugmentSource(norm(), { scope: SCOPE, targetScope: 'global' });
  assert.match(src, /augments: "incident"/);
  // `name:` would be a table DEFINITION — the one thing an augment must not be.
  assert.doesNotMatch(src, /^\s*name: "incident"/m);
  assert.doesNotMatch(src, /extends:/);
});

test('a cross-scope privilege is declared for the target scope, per operation', () => {
  const src = generateAugmentSource(norm(), { scope: SCOPE, targetScope: 'global' });
  assert.match(src, /CrossScopePrivilege\(\{/);
  assert.match(src, /targetType: 'sys_db_object'/);
  assert.match(src, /targetName: "incident"/);
  assert.match(src, /targetScope: "global"/);
  for (const op of ['read', 'write']) assert.match(src, new RegExp(`operation: "${op}"`));
});

test('every $id is namespaced by the authoring scope — trap #1 applies here too', () => {
  const src = generateAugmentSource(norm(), { scope: SCOPE, targetScope: 'global' });
  const keys = [...src.matchAll(/Now\.ID\["([^"]+)"\]/g)].map((m) => m[1]);
  assert.ok(keys.length >= 3, 'expected the table id and one id per privilege');
  for (const k of keys) assert.ok(k.startsWith(SCOPE), `${k} is not namespaced by the authoring scope`);
  assert.equal(new Set(keys).size, keys.length);
});

test('the target scope is not assumed to be global', () => {
  const src = generateAugmentSource(norm(), { scope: SCOPE, targetScope: 'sn_other_app' });
  assert.match(src, /targetScope: "sn_other_app"/);
});

/* ── the operation classification ─────────────────────────────────────────── */

test('augment_column is additive, and says undoing it is irreversible', async () => {
  const r = await classifyOperation('augment_column', { withContext: false });
  assert.equal(r.additive, true);
  assert.equal(r.actsOn, 'schema');
  assert.equal(r.undo, 'drop_column');
  assert.equal(r.undoReversible, false);
  assert.match(r.permanence, /no rollback context/);
});

test('augment_column is a DISTINCT operation from add_column, on purpose', () => {
  // add_column on an out-of-scope table must stay blocked by the classifier's
  // "never edit this platform table directly" verdict; the augment is the
  // remedy that verdict recommends, so it must not be blocked by it.
  assert.equal(OPERATION_MATRIX.augment_column.augment, true);
  assert.notEqual(OPERATION_MATRIX.add_column.augment, true);
  assert.equal(OPERATION_MATRIX.add_column.acts_on, 'schema');
});

test('no additive operation is ever marked irreversible, and none is destructive', () => {
  for (const [op, spec] of Object.entries(OPERATION_MATRIX)) {
    if (!spec.additive) continue;
    assert.equal(spec.reversible, true, `${op} is additive but marked irreversible`);
    assert.ok(spec.undo, `${op} must name the operation that undoes it`);
    assert.equal(spec.undoReversible, false, `${op}'s undo is a drop and must be flagged irreversible`);
  }
});

/* ── a red install is only a claim, too ───────────────────────────────────── */

test('a deployment timeout is surfaced as the CAUSE, not as "Command failed"', async () => {
  // MEASURED. The install that created this column exited 1 and reported only
  //   "Command failed: …node.exe …index.js install"
  // while the line that explained it sat in stdout:
  //   "[now-sdk] ERROR: The deployment request timed out waiting for a response."
  // Naming the command instead of the reason is trap #51 in our own code — and
  // here it hid the fact that the deployment had actually SUCCEEDED.
  const { extractDiagnostics } = await import('../src/servicenow/fluent.js');
  const d = extractDiagnostics({
    stdout: '[now-sdk] Attempting to log into instance https://x.service-now.com as admin.\n'
          + '[now-sdk] ERROR: The deployment request timed out waiting for a response.\n',
    stderr: 'Command failed: node.exe index.js install',
  });
  assert.match(d, /timed out waiting for a response/);
});

test('an ordinary build failure still reports its compiler diagnostic', async () => {
  const { extractDiagnostics } = await import('../src/servicenow/fluent.js');
  const d = extractDiagnostics({
    stdout: "[now-sdk] ERROR: src/x.now.ts:7:51 - error TS213: Table definition should be exported as a named export\n",
    stderr: '',
  });
  assert.match(d, /TS213/);
});
