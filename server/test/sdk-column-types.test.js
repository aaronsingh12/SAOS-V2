import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COLUMN_TYPES, columnFactoryFor, generateTableSource, normalizeTableSpec,
  tableSpecConstraints, validateTableSpec,
} from '../src/servicenow/dba-authoring.js';

/*
 * A1 — THE BUG THIS FILE EXISTS TO HAVE CAUGHT.
 *
 * Every `datetime` column was emitted as `GlideDateTimeColumn({ … })`.
 * `@servicenow/sdk/core` does not export that name. It does not appear anywhere
 * in the installed sdk-core package. So a date-typed column could never be
 * authored: `now-sdk build` failed on a factory that was never imported because
 * it does not exist, and the diagnostic pointed at generated source the caller
 * had never written. `date` was then written off as "not supported", which was
 * false — `DateColumn` is a documented export. It was unbuilt, not unsupported.
 *
 * The check is offline and costs nothing: read the SDK's own typings, collect
 * every `export declare function <Name>Column`, and assert that every factory
 * this layer emits is in that set. A name the SDK does not export now fails in
 * milliseconds instead of after a multi-minute install.
 */

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_DB_TYPES = path.join(
  SERVER_ROOT, 'fluent-workspace', 'node_modules', '@servicenow', 'sdk-core', 'dist', 'db',
);

/** Every `*Column` factory the installed SDK actually exports. */
function sdkColumnFactories() {
  const names = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.d.ts')) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/export declare function ([A-Za-z0-9_]+Column)\b/g)) {
        names.add(m[1]);
      }
    }
  };
  walk(SDK_DB_TYPES);
  return names;
}

test('the SDK typings are present — a check that cannot see proves nothing', () => {
  // Deliberately loud rather than skipped. This test's whole value is that it
  // reads the REAL export surface; silently passing when it cannot find the SDK
  // would be the H-1 mistake (a guard reporting clean because it is blind).
  assert.ok(fs.existsSync(SDK_DB_TYPES),
    `the installed SDK typings are not at ${SDK_DB_TYPES} — run npm install in server/fluent-workspace. `
    + 'This check is worthless without them.');
  const factories = sdkColumnFactories();
  assert.ok(factories.size > 20,
    `only ${factories.size} column factories found in the SDK typings — the scan is not reading the tree`);
});

test('every emitted column factory is a REAL @servicenow/sdk/core export', () => {
  const real = sdkColumnFactories();
  const bogus = [];
  for (const type of COLUMN_TYPES) {
    const factory = columnFactoryFor(type);
    if (!real.has(factory)) bogus.push(`${type} -> ${factory}`);
  }
  assert.deepEqual(bogus, [],
    'a column type maps to a factory the SDK does not export. This is exactly the GlideDateTimeColumn bug: the '
    + 'build fails on a name that was never importable, and the diagnostic points at generated source nobody wrote.');
});

test('GlideDateTimeColumn is gone, and datetime maps to the real DateTimeColumn', () => {
  const real = sdkColumnFactories();
  assert.equal(real.has('GlideDateTimeColumn'), false, 'the SDK does not export this — the premise of the old bug');
  assert.equal(real.has('DateTimeColumn'), true);
  assert.equal(columnFactoryFor('datetime'), 'DateTimeColumn');
});

test('date is supported and emits a real DateColumn', () => {
  assert.ok(COLUMN_TYPES.includes('date'), '"date not supported" was false — it was unbuilt');
  assert.equal(columnFactoryFor('date'), 'DateColumn');
  assert.equal(sdkColumnFactories().has('DateColumn'), true);
});

test('a generated table with a date column imports DateColumn and emits it', () => {
  const { normalized } = validateTableSpec({
    name: 'x_2002152_nwforge_emp_assets',
    label: 'Employee Assets',
    fields: [
      { name: 'employee_name', type: 'string', label: 'Employee Name' },
      { name: 'assigned_date', type: 'date', label: 'Assigned Date' },
    ],
  }, { scope: 'x_2002152_nwforge' });
  const src = generateTableSource(normalized);
  assert.match(src, /import \{[^}]*\bDateColumn\b[^}]*\} from '@servicenow\/sdk\/core'/);
  assert.match(src, /assigned_date: DateColumn\(\{ label: "Assigned Date" \}\)/);
  assert.ok(!src.includes('GlideDateTimeColumn'));
});

/* ── A2: every violation at once ──────────────────────────────────────────── */

test('validation returns EVERY violation, not the first', () => {
  // A tool that rejects one rule at a time turns one table into N failed
  // attempts, and the model spends a turn on each.
  const { errors } = validateTableSpec({
    name: 'Bad Name',
    fields: [
      { name: '1bad', type: 'string' },
      { name: 'dup', type: 'string' },
      { name: 'dup', type: 'string' },
      { name: 'nope', type: 'nonsense' },
      { name: 'r', type: 'reference' },
    ],
    display: 'not_a_column',
  }, { scope: 'x_2002152_nwforge' });
  assert.ok(errors.length >= 6, `expected every violation at once, got ${errors.length}: ${errors.join(' | ')}`);
  assert.ok(errors.some((e) => /prefix/.test(e)));
  assert.ok(errors.some((e) => /defined twice/.test(e)));
  assert.ok(errors.some((e) => /must name the table it points at/.test(e)));
  assert.ok(errors.some((e) => /not one of the columns/.test(e)));
});

/* ── A3: safe corrections, applied and REPORTED ───────────────────────────── */

test('a missing scope prefix is applied, and reported', () => {
  const { spec, corrections } = normalizeTableSpec(
    { name: 'emp_assets', fields: [] }, { scope: 'x_2002152_nwforge' },
  );
  assert.equal(spec.name, 'x_2002152_nwforge_emp_assets');
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].from, 'emp_assets');
  assert.equal(corrections[0].to, 'x_2002152_nwforge_emp_assets');
  assert.match(corrections[0].why, /must start with/);
});

test('an over-long name is fitted to the cap, and reported', () => {
  const { spec, corrections } = normalizeTableSpec(
    { name: 'employee_assets_register_master', fields: [] }, { scope: 'x_2002152_nwforge' },
  );
  assert.ok(spec.name.length <= 30, `${spec.name} is ${spec.name.length} characters`);
  assert.ok(spec.name.startsWith('x_2002152_nwforge_'));
  assert.match(spec.name, /[a-z0-9]$/, 'a trimmed name must not end in an underscore');
  assert.ok(corrections.some((c) => /capped at 30/.test(c.why)));
});

test('unambiguous type synonyms are coerced, and reported', () => {
  const { spec, corrections } = normalizeTableSpec({
    name: 'x_2002152_nwforge_t',
    fields: [
      { name: 'a', type: 'date_time' },
      { name: 'b', type: 'bool' },
      { name: 'c', type: 'int' },
      { name: 'd', type: 'glide_date' },
    ],
  }, { scope: 'x_2002152_nwforge' });
  assert.deepEqual(spec.fields.map((f) => f.type), ['datetime', 'boolean', 'integer', 'date']);
  assert.equal(corrections.length, 4);
  for (const c of corrections) assert.match(c.why, /unambiguous synonym/);
});

test('an AMBIGUOUS type is never guessed at', () => {
  // "text" could be a short string or a multi-line field. Guessing would author
  // the wrong column and call it a correction.
  const { spec, corrections } = normalizeTableSpec(
    { name: 'x_2002152_nwforge_t', fields: [{ name: 'a', type: 'text' }] }, { scope: 'x_2002152_nwforge' },
  );
  assert.equal(spec.fields[0].type, 'text');
  assert.deepEqual(corrections, []);
  const { errors } = validateTableSpec(spec, { scope: 'x_2002152_nwforge' });
  assert.ok(errors.some((e) => /does not emit/.test(e)), 'it must be refused with the supported list, not guessed');
});

test('normalizing a spec that is already correct changes nothing', () => {
  const spec = {
    name: 'x_2002152_nwforge_emp_assets',
    fields: [{ name: 'a', type: 'string' }, { name: 'b', type: 'date' }],
  };
  const { corrections } = normalizeTableSpec(spec, { scope: 'x_2002152_nwforge' });
  assert.deepEqual(corrections, []);
});

/* ── A4 / A6: constraints up front, and standalone by default ─────────────── */

test('the constraints a spec is judged by are published as data', () => {
  const c = tableSpecConstraints('x_2002152_nwforge');
  assert.equal(c.namePrefix, 'x_2002152_nwforge_');
  assert.equal(c.maxNameLength, 30);
  assert.equal(c.charactersLeftForName, 12);
  assert.deepEqual(c.columnTypes, COLUMN_TYPES);
  assert.ok(c.columnTypes.includes('date'));
});

test('A6 — a table is STANDALONE unless the spec asks otherwise', () => {
  const plain = validateTableSpec({
    name: 'x_2002152_nwforge_emp_assets', fields: [{ name: 'a', type: 'string' }],
  }, { scope: 'x_2002152_nwforge' });
  assert.equal(plain.normalized.extends, null, 'extends must never default to task or anything else');
  assert.ok(!generateTableSource(plain.normalized).includes('extends:'));

  const asked = validateTableSpec({
    name: 'x_2002152_nwforge_emp_assets', extends: 'task', fields: [{ name: 'a', type: 'string' }],
  }, { scope: 'x_2002152_nwforge' });
  assert.equal(asked.normalized.extends, 'task', 'opt-in extension must still work when it is asked for');
  assert.match(generateTableSource(asked.normalized), /extends: "task"/);
});
