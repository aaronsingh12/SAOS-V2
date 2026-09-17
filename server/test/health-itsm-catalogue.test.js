import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

/*
 * PHASE 1 — the ITSM rule catalogue is a faithful transcription of the tracker.
 *
 * Nothing here runs a rule. The catalogue is data, imported from
 * SAOS_Health_Rules_Tracker_ITSM.xlsx by scripts/import-itsm-catalogue.mjs,
 * and these tests hold the import to the workbook: exactly 139 rules,
 * ITSM-001 … ITSM-139 each once, every Schema-defined field present and
 * non-empty, every entry the same shape, and every row traceable back to the
 * Excel row it came from. They fail if a rule is lost, doubled, renumbered,
 * or hand-edited into a different shape.
 *
 * The last test pins the Phase 1 boundary itself: no module under health/
 * reads the catalogue yet. Phase 2 wires it in and deletes that test on
 * purpose — until then, an import that appears is a change nobody decided.
 */

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const DIR = path.join(SRC, 'health', 'rules', 'itsm');

const catalogue = JSON.parse(fs.readFileSync(path.join(DIR, 'catalogue.json'), 'utf8'));
const traceability = JSON.parse(fs.readFileSync(path.join(DIR, 'traceability.json'), 'utf8'));
const traceabilityMd = fs.readFileSync(path.join(DIR, 'traceability.md'), 'utf8');

const EXPECTED_COUNT = 139;
const EXPECTED_IDS = Array.from({ length: EXPECTED_COUNT }, (_, i) => `ITSM-${String(i + 1).padStart(3, '0')}`);

/* The sixteen fields the workbook's Schema sheet defines, in its order. */
const SCHEMA_FIELDS = [
  'id', 'group', 'rule', 'base_severity', 'what_it_means', 'why_it_matters',
  'source_tables_fields', 'detection_logic', 'threshold_parameter', 'confidence_basis',
  'evidence_to_show', 'false_positive_guard', 'remediation_lane', 'cross_domain_link',
  'implementation_status', 'validation_status',
];
/* Columns on the ITSM sheet with no Schema definition. Carried, allowed empty. */
const TRACKING_FIELDS = ['implementation_notes', 'validation_notes', 'owner', 'remarks'];
/* Every entry's key set, in the order the importer writes it (workbook column order, plus excel_row). */
const ENTRY_SHAPE = [
  'id', 'excel_row', 'group', 'rule', 'base_severity', 'what_it_means', 'why_it_matters',
  'source_tables_fields', 'detection_logic', 'threshold_parameter', 'confidence_basis',
  'evidence_to_show', 'false_positive_guard', 'remediation_lane', 'cross_domain_link',
  'implementation_status', 'implementation_notes', 'validation_status', 'validation_notes',
  'owner', 'remarks',
];

/* Allowed values, verbatim from the Schema sheet's fill rules. */
const SEVERITY_BANDS = ['Systemic', 'Critical', 'High', 'Moderate', 'Low'];
const IMPLEMENTATION_STATUSES = ['Not Started', 'In Progress', 'Built', 'Deferred'];
const VALIDATION_STATUSES = ['Not Tested', 'Tested on PDI', 'Tested on Customer', 'Failed'];

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/* ════════════════════════ count and identity ════════════════════════ */

test('the catalogue holds exactly 139 rules, and says so', () => {
  assert.equal(catalogue.rules.length, EXPECTED_COUNT);
  assert.equal(catalogue.rule_count, EXPECTED_COUNT, 'rule_count disagrees with the rules array');
  assert.equal(catalogue.domain, 'ITSM');
  assert.equal(catalogue.source.workbook, 'SAOS_Health_Rules_Tracker_ITSM.xlsx');
  assert.equal(catalogue.source.rules_sheet, 'ITSM');
  assert.match(catalogue.source.workbook_sha256, /^[0-9a-f]{64}$/, 'the workbook hash is not recorded');
});

test('ITSM-001 through ITSM-139 are each present exactly once, in order, and nothing else is', () => {
  const ids = catalogue.rules.map((r) => r.id);
  assert.deepEqual(ids, EXPECTED_IDS);
  assert.equal(new Set(ids).size, EXPECTED_COUNT, 'a rule id is duplicated');
  const missing = EXPECTED_IDS.filter((id) => !ids.includes(id));
  const unexpected = ids.filter((id) => !EXPECTED_IDS.includes(id));
  assert.deepEqual(missing, [], 'rule ids are missing');
  assert.deepEqual(unexpected, [], 'rule ids exist that are not in the workbook range');
  for (const id of ids) assert.match(id, /^ITSM-\d{3}$/);
  assert.deepEqual(catalogue.id_range, { first: 'ITSM-001', last: 'ITSM-139' });
});

/* ════════════════════════ shape and required fields ════════════════════════ */

test('every entry has exactly the same keys, in the same order', () => {
  for (const r of catalogue.rules) {
    assert.deepEqual(Object.keys(r), ENTRY_SHAPE, `${r.id} has a different shape`);
  }
});

test('every Schema-defined field is present and non-empty on every rule', () => {
  for (const r of catalogue.rules) {
    for (const f of SCHEMA_FIELDS) {
      assert.ok(nonEmpty(r[f]), `${r.id}: required field "${f}" is empty or not a string`);
    }
  }
});

test('tracking columns the Schema does not define are carried as string-or-null, never invented', () => {
  for (const r of catalogue.rules) {
    for (const f of TRACKING_FIELDS) {
      assert.ok(r[f] === null || typeof r[f] === 'string', `${r.id}: "${f}" is neither null nor a string`);
    }
  }
});

test('the catalogue schema block names the sixteen fields, marks them required, and maps all twenty columns', () => {
  assert.deepEqual(catalogue.schema.fields.map((f) => f.field), SCHEMA_FIELDS);
  assert.ok(catalogue.schema.fields.every((f) => f.required === true && nonEmpty(f.header) && nonEmpty(f.purpose) && nonEmpty(f.fill_rule)));
  const columns = catalogue.schema.columns;
  assert.equal(columns.length, 20);
  assert.deepEqual(columns.map((c) => c.column), 'ABCDEFGHIJKLMNOPQRST'.split(''));
  assert.deepEqual(columns.filter((c) => c.schema_defined).map((c) => c.field), SCHEMA_FIELDS);
  assert.deepEqual(columns.filter((c) => !c.schema_defined).map((c) => c.field), TRACKING_FIELDS);
  /* The entry shape is the column order plus excel_row after id. */
  assert.deepEqual(ENTRY_SHAPE, ['id', 'excel_row', ...columns.map((c) => c.field).filter((f) => f !== 'id')]);
});

/* ════════════════════════ vocabularies the Schema sheet states ════════════════════════ */

test('base severity, implementation status and validation status use only the Schema sheet\'s words', () => {
  for (const r of catalogue.rules) {
    assert.ok(SEVERITY_BANDS.includes(r.base_severity), `${r.id}: base_severity "${r.base_severity}" is not a Schema band`);
    assert.ok(IMPLEMENTATION_STATUSES.includes(r.implementation_status), `${r.id}: implementation_status "${r.implementation_status}"`);
    assert.ok(VALIDATION_STATUSES.includes(r.validation_status), `${r.id}: validation_status "${r.validation_status}"`);
  }
  assert.deepEqual(catalogue.schema.severity_bands.map((b) => b.band), SEVERITY_BANDS);
  assert.deepEqual(catalogue.schema.severity_bands.map((b) => b.weight), [100, 40, 15, 5, 1]);
  for (const b of catalogue.schema.severity_bands) {
    assert.match(b.description, new RegExp(`Weight ${b.weight}\\.`), `${b.band}: the weight number is not the one the prose states`);
  }
});

test('every remediation lane names at least one of the three lanes; lanes are kept as the workbook wrote them', () => {
  /* The Schema defines Lane 1/2/3; the workbook writes combinations and
     qualifications in free text. Those are preserved verbatim, not coerced. */
  for (const r of catalogue.rules) {
    assert.match(r.remediation_lane, /\bLane [123]\b/, `${r.id}: remediation_lane "${r.remediation_lane}" names no lane`);
  }
});

test('the Schema sheet transcription is complete: two modifiers and two worked examples', () => {
  assert.deepEqual(catalogue.schema.severity_modifiers.map((m) => m.modifier), ['Escalate one band (cap Systemic)', 'De-escalate one band']);
  assert.ok(catalogue.schema.severity_modifiers.every((m) => nonEmpty(m.conditions)));
  assert.equal(catalogue.schema.worked_examples.length, 2);
  assert.match(catalogue.schema.worked_examples[0].text, /^CMDB-105/);
  assert.match(catalogue.schema.worked_examples[1].text, /^ITOM-017/);
});

test('groups_observed is exactly the distinct Group values the rules carry', () => {
  const seen = [...new Set(catalogue.rules.map((r) => r.group))];
  assert.deepEqual(catalogue.groups_observed, seen);
});

/* ════════════════════════ traceability ════════════════════════ */

test('every rule traces to one Excel row: contiguous from row 2, unique, and index = row − 2', () => {
  const rows = catalogue.rules.map((r) => r.excel_row);
  assert.equal(new Set(rows).size, EXPECTED_COUNT, 'an excel_row is shared by two rules');
  catalogue.rules.forEach((r, i) => {
    assert.equal(r.excel_row, i + 2, `${r.id}: excel_row ${r.excel_row} is not row ${i + 2}`);
  });
  assert.equal(catalogue.source.header_row, 1);
  assert.equal(catalogue.source.first_data_row, 2);
  assert.equal(catalogue.source.last_data_row, EXPECTED_COUNT + 1);
});

test('the traceability report agrees with the catalogue row for row', () => {
  assert.equal(traceability.entries.length, EXPECTED_COUNT);
  assert.equal(traceability.source.workbook_sha256, catalogue.source.workbook_sha256);
  traceability.entries.forEach((e, i) => {
    const r = catalogue.rules[i];
    assert.equal(e.rule_id, r.id);
    assert.equal(e.excel_row, r.excel_row);
    assert.equal(e.catalogue_index, i);
    assert.equal(e.sheet, 'ITSM');
    assert.equal(e.status, 'Imported');
    assert.ok(traceabilityMd.includes(`| ${r.id} | ${r.excel_row} | rules[${i}] | Imported |`), `${r.id} is not in traceability.md`);
  });
});

/* ════════════════════════ the Phase 1 boundary ════════════════════════ */

test('BOUNDARY: the catalogue and map are read by health/itsm/catalogue.js, the parameter declarations by health/itsm/parameters.js, and by nothing else', () => {
  /*
   * Phase 1 asserted that nothing under src/ read the catalogue. Phase 3 built
   * the loader, which is the one sanctioned reader; everything else (the health
   * engine, routes, agent) must still reach the catalogue only through it, and
   * `health-itsm-foundation.test.js` asserts that none of them import
   * health/itsm at all. The phase that connects rules to execution widens
   * this deliberately.
   */
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      /* Import statements only — comments elsewhere legitimately NAME the catalogue path. */
      else if (e.name.endsWith('.js') && /from\s+'[^']*rules\/itsm\/[^']*\.json'/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(SRC, full).replace(/\\/g, '/'));
    }
  };
  walk(SRC);
  assert.deepEqual(offenders.sort(), ['health/itsm/catalogue.js', 'health/itsm/parameters.js'], 'only the loaders may read rules/itsm/*.json');
});

test('PHASE 1: the catalogue lives outside the engine hash, so adding it moved no module\'s engine key', () => {
  /* health/incremental.js hashes health/*.js matching ENGINE_FILES and every
     json under health/catalogue/. rules/itsm/ is neither. */
  const health = path.join(SRC, 'health');
  assert.ok(!fs.existsSync(path.join(health, 'catalogue', 'itsm.json')), 'the ITSM catalogue is inside the hashed catalogue/ directory');
  const src = fs.readFileSync(path.join(health, 'incremental.js'), 'utf8');
  const pattern = /const ENGINE_FILES = (\/.*\/);/.exec(src);
  assert.ok(pattern, 'ENGINE_FILES not found in incremental.js');
  const re = new Function(`return ${pattern[1]}`)();
  assert.equal(re.test('rules'), false, 'the rules/ directory name matches ENGINE_FILES');
  assert.equal(re.test('rules.js'), true);
});
