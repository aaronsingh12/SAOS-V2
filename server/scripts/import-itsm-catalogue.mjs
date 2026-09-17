/**
 * PHASE 1 — import the ITSM rule catalogue from the SAOS tracker workbook.
 *
 *   node scripts/import-itsm-catalogue.mjs <path-to-SAOS_Health_Rules_Tracker_ITSM.xlsx>
 *
 * Reads the `Schema` and `ITSM` sheets and writes three files beside each other
 * under src/health/rules/itsm/:
 *
 *   catalogue.json      one entry per workbook row, ITSM-001 … ITSM-139, verbatim
 *   traceability.json   Excel row → Rule ID → catalogue index, machine-readable
 *   traceability.md     the same table for a person
 *
 * WHAT THIS IS NOT. It is a transcription, not an interpretation. Every cell is
 * carried across as the string the workbook holds; an empty cell becomes `null`;
 * nothing is parsed into a code, a number or an enum except the one place the
 * Schema sheet itself states a number in prose ("Weight 100." on a severity
 * band), and there the prose is kept beside the number. The existing CMDB
 * catalogue carries derived fields (`kind`, `track`, `lane` as an integer,
 * `systemicKind`); this one deliberately does not, because deriving them is the
 * work of a later phase and doing it silently here would be exactly the
 * reinterpretation Phase 1 forbids.
 *
 * WHY THE FILE LIVES UNDER src/health/rules/itsm/ AND NOT src/health/catalogue/.
 * `health/incremental.js` hashes every `*.json` in `catalogue/` into each
 * module's engine key. Dropping a new file there would move every key and force
 * a full re-read of every module on the next scan — a behaviour change to the
 * running checker for a catalogue no rule reads yet. `rules/itsm/` is outside
 * that hash (the ENGINE_FILES pattern matches `rules.js`, not a directory named
 * `rules`), so the running engine is byte-for-byte unaffected. Moving it into
 * the hash is a Phase 2 decision, made when the engine starts reading it.
 *
 * NO DEPENDENCY. An .xlsx is a zip of XML, and Node has `zlib.inflateRawSync`;
 * the ~60 lines below read the central directory and the two sheets. The same
 * reasoning as the storage layer: a build step must not be the thing that
 * drags a package into a project that has none.
 *
 * The importer REFUSES rather than adapts: a header that is not the twenty
 * columns it expects, a Schema sheet whose field list has moved, an ID out of
 * sequence, a duplicate — each stops the import with the row named. A silently
 * adapted import is how a 140th rule, or a renamed column, gets into the
 * catalogue without anyone deciding it should.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '../src/health/rules/itsm');

const CATALOGUE_VERSION = '1.0.0';
const RULES_SHEET = 'ITSM';
const SCHEMA_SHEET = 'Schema';
const EXPECTED_COUNT = 139;
const ID_PATTERN = /^ITSM-(\d{3})$/;

/*
 * Column letter → catalogue field, in workbook order. The header text is what
 * the workbook MUST carry in that column; the import fails otherwise.
 * `schema: true` marks the sixteen fields the Schema sheet defines. The last
 * four exist in the ITSM sheet only, and are carried as tracking columns.
 */
const COLUMNS = Object.freeze([
  { column: 'A', header: 'Rule ID', field: 'id', schema: true },
  { column: 'B', header: 'Group', field: 'group', schema: true },
  { column: 'C', header: 'Rule (Exact Wording)', field: 'rule', schema: true },
  { column: 'D', header: 'Base Severity', field: 'base_severity', schema: true },
  { column: 'E', header: 'What It Means', field: 'what_it_means', schema: true },
  { column: 'F', header: 'Why It Matters', field: 'why_it_matters', schema: true },
  { column: 'G', header: 'Source Tables / Fields', field: 'source_tables_fields', schema: true },
  { column: 'H', header: 'Detection Logic', field: 'detection_logic', schema: true },
  { column: 'I', header: 'Threshold / Parameter', field: 'threshold_parameter', schema: true },
  { column: 'J', header: 'Confidence Basis', field: 'confidence_basis', schema: true },
  { column: 'K', header: 'Evidence to Show', field: 'evidence_to_show', schema: true },
  { column: 'L', header: 'False Positive Guard', field: 'false_positive_guard', schema: true },
  { column: 'M', header: 'Remediation Lane', field: 'remediation_lane', schema: true },
  { column: 'N', header: 'Cross-Domain Link', field: 'cross_domain_link', schema: true },
  { column: 'O', header: 'Implementation Status', field: 'implementation_status', schema: true },
  { column: 'P', header: 'Implementation Notes', field: 'implementation_notes', schema: false },
  { column: 'Q', header: 'Validation Status', field: 'validation_status', schema: true },
  { column: 'R', header: 'Validation Notes', field: 'validation_notes', schema: false },
  { column: 'S', header: 'Owner', field: 'owner', schema: false },
  { column: 'T', header: 'Remarks', field: 'remarks', schema: false },
]);

/* ── a minimal zip reader ───────────────────────────────────────────────── */

function zipEntries(buf) {
  // End of central directory: scan back for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    entries.set(name, () => (method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? raw : (() => { throw new Error(`unsupported zip method ${method} for ${name}`); })()).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ── SpreadsheetML ──────────────────────────────────────────────────────── */

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

const textRuns = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join('');

function sharedStrings(entries) {
  const xml = entries.get('xl/sharedStrings.xml')?.() ?? '';
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));
}

/** Sheet name → worksheet part, through workbook.xml and its .rels. */
function sheetParts(entries) {
  const wb = entries.get('xl/workbook.xml')();
  const rels = entries.get('xl/_rels/workbook.xml.rels')();
  const targets = Object.fromEntries([...rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const out = {};
  for (const m of wb.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/g)) {
    out[decodeXml(m[1])] = `xl/${targets[m[2]].replace(/^\/?xl\//, '')}`;
  }
  return out;
}

/** rows: Map<rowNumber, { [columnLetter]: string | null }>. Values are strings, verbatim. */
function readSheet(entries, part, sst) {
  const xml = entries.get(part)();
  const rows = new Map();
  for (const m of xml.matchAll(/<c r="([A-Z]+)(\d+)"(?:[^>]*?\bt="([a-z]+)")?[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, col, rowStr, type, inner] = m;
    let value = null;
    if (inner != null) {
      if (type === 's') { const v = /<v>(\d+)<\/v>/.exec(inner); value = v ? sst[Number(v[1])] : null; }
      else if (type === 'inlineStr') value = textRuns(inner);
      else { const v = /<v>([\s\S]*?)<\/v>/.exec(inner); value = v ? decodeXml(v[1]) : null; }
    }
    if (value === '') value = null;
    const r = Number(rowStr);
    if (!rows.has(r)) rows.set(r, {});
    rows.get(r)[col] = value;
  }
  return rows;
}

/* ── the Schema sheet ───────────────────────────────────────────────────── */

/**
 * Transcribe the Schema sheet: the articulation fields with their purpose and
 * fill rule, the severity bands, the modifiers and the worked examples. Located
 * by their section headings rather than by fixed row numbers, so a blank row
 * added above them does not silently shift what is read.
 */
function readSchema(rows) {
  const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  /*
   * A section runs from the row after its heading to the first blank row. A
   * blank row has no cells at all, so it is ABSENT from the sheet XML rather
   * than present-and-empty: the end of a section is therefore a gap in the row
   * numbers, not a row that reads as empty.
   */
  const rowsAfter = (heading) => {
    const i = ordered.findIndex(([, r]) => r.A === heading);
    if (i < 0) throw new Error(`Schema sheet: heading "${heading}" not found`);
    const out = [];
    let prev = ordered[i][0];
    for (let k = i + 1; k < ordered.length; k++) {
      const [n, r] = ordered[k];
      if (n !== prev + 1) break;
      out.push([n, r]);
      prev = n;
    }
    return out;
  };

  const title = ordered[0]?.[1]?.A ?? null;
  const preamble = ordered.find(([n]) => n === 2)?.[1]?.A ?? null;

  const fieldRows = rowsAfter('Field');
  const fields = fieldRows.map(([n, r]) => ({ excel_row: n, header: r.A, purpose: r.B ?? null, fill_rule: r.C ?? null }));

  const bandRows = rowsAfter('Severity bands');
  const severityBands = bandRows.map(([n, r]) => {
    const w = /Weight\s+(\d+)\./.exec(r.B || '');
    return { excel_row: n, band: r.A, description: r.B ?? null, weight: w ? Number(w[1]) : null };
  });

  const modRows = rowsAfter('Severity modifiers');
  const modifiers = modRows.map(([n, r]) => ({ excel_row: n, modifier: r.A, conditions: r.B ?? null }));

  const exRows = rowsAfter('Worked examples of the modifier logic');
  const workedExamples = exRows.map(([n, r]) => ({ excel_row: n, text: r.A }));

  return { title, preamble, fields, severityBands, modifiers, workedExamples };
}

/* ── main ───────────────────────────────────────────────────────────────── */

function fail(msg) {
  process.stderr.write(`import-itsm-catalogue: ${msg}\n`);
  process.exit(1);
}

const workbookPath = process.argv[2];
if (!workbookPath) fail('usage: node scripts/import-itsm-catalogue.mjs <SAOS_Health_Rules_Tracker_ITSM.xlsx>');
if (!fs.existsSync(workbookPath)) fail(`no such file: ${workbookPath}`);

const bytes = fs.readFileSync(workbookPath);
const entries = zipEntries(bytes);
const sst = sharedStrings(entries);
const parts = sheetParts(entries);
for (const s of [SCHEMA_SHEET, RULES_SHEET]) if (!parts[s]) fail(`the workbook has no sheet named "${s}" (sheets: ${Object.keys(parts).join(', ')})`);

const schemaRows = readSheet(entries, parts[SCHEMA_SHEET], sst);
const schema = readSchema(schemaRows);

/* The Schema sheet's field list must be exactly the schema-marked columns, in order. */
const schemaHeaders = COLUMNS.filter((c) => c.schema).map((c) => c.header);
const sheetHeaders = schema.fields.map((f) => f.header);
if (JSON.stringify(sheetHeaders) !== JSON.stringify(schemaHeaders)) {
  fail(`the Schema sheet's field list differs from the sixteen fields this importer expects.\n  sheet:    ${sheetHeaders.join(' | ')}\n  expected: ${schemaHeaders.join(' | ')}`);
}

const itsmRows = readSheet(entries, parts[RULES_SHEET], sst);
const header = itsmRows.get(1) || {};
for (const c of COLUMNS) {
  if (header[c.column] !== c.header) fail(`ITSM sheet header ${c.column}1 is ${JSON.stringify(header[c.column])}, expected ${JSON.stringify(c.header)}`);
}
const stray = Object.keys(header).filter((col) => !COLUMNS.some((c) => c.column === col));
if (stray.length) fail(`ITSM sheet has header columns this importer does not know: ${stray.join(', ')}`);

const dataRows = [...itsmRows.entries()].filter(([n]) => n !== 1).sort((a, b) => a[0] - b[0]);
if (dataRows.length !== EXPECTED_COUNT) fail(`expected ${EXPECTED_COUNT} rule rows, found ${dataRows.length}`);

const rules = [];
const seen = new Set();
dataRows.forEach(([excelRow, r], i) => {
  const id = r.A;
  const expected = `ITSM-${String(i + 1).padStart(3, '0')}`;
  if (id !== expected) fail(`row ${excelRow}: Rule ID is ${JSON.stringify(id)}, expected ${expected} (IDs must be contiguous and in order)`);
  if (seen.has(id)) fail(`row ${excelRow}: duplicate Rule ID ${id}`);
  seen.add(id);
  const known = new Set(COLUMNS.map((c) => c.column));
  for (const col of Object.keys(r)) if (!known.has(col)) fail(`row ${excelRow}: a value in column ${col}, outside the header`);
  const entry = { id, excel_row: excelRow };
  for (const c of COLUMNS) {
    if (c.field === 'id') continue;
    entry[c.field] = r[c.column] ?? null;
  }
  rules.push(entry);
});

const groups = [...new Set(rules.map((r) => r.group))];

const catalogue = {
  catalogue_version: CATALOGUE_VERSION,
  domain: 'ITSM',
  source: {
    workbook: path.basename(workbookPath),
    workbook_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    rules_sheet: RULES_SHEET,
    schema_sheet: SCHEMA_SHEET,
    header_row: 1,
    first_data_row: dataRows[0][0],
    last_data_row: dataRows[dataRows.length - 1][0],
  },
  generated: new Date().toISOString().slice(0, 10),
  generator: 'server/scripts/import-itsm-catalogue.mjs',
  phase: 'Phase 1 — catalogue only. Not read by the health engine; the eleven hard-coded ITSM rules in health/rules.js are unchanged.',
  rule_count: rules.length,
  id_range: { first: rules[0].id, last: rules[rules.length - 1].id },
  schema: {
    note: 'Transcribed from the Schema sheet. `fields` are the articulation and tracking fields the sheet defines, each with its purpose and fill rule verbatim; `required` marks them all as required, because the sheet says every rule carries them. `columns` maps every ITSM-sheet column to its catalogue field; four columns exist on the ITSM sheet without a Schema definition and are marked schema_defined:false.',
    title: schema.title,
    preamble: schema.preamble,
    fields: schema.fields.map((f) => ({
      field: COLUMNS.find((c) => c.header === f.header).field,
      header: f.header,
      schema_excel_row: f.excel_row,
      purpose: f.purpose,
      fill_rule: f.fill_rule,
      required: true,
    })),
    columns: COLUMNS.map((c) => ({ column: c.column, header: c.header, field: c.field, schema_defined: c.schema })),
    severity_bands: schema.severityBands,
    severity_modifiers: schema.modifiers,
    worked_examples: schema.workedExamples,
  },
  /* The distinct Group values as they appear, in order of first appearance.
     The Schema sheet says a Group "must match a defined scoring dimension"; this
     workbook defines no dimension list, so this is an observation, not one. */
  groups_observed: groups,
  rules,
};

const traceability = {
  source: catalogue.source,
  generated: catalogue.generated,
  catalogue: 'server/src/health/rules/itsm/catalogue.json',
  entries: rules.map((r, i) => ({ rule_id: r.id, sheet: RULES_SHEET, excel_row: r.excel_row, catalogue_index: i, status: 'Imported' })),
};

const md = [
  '# ITSM catalogue — Excel → catalogue traceability',
  '',
  `Workbook: \`${catalogue.source.workbook}\` (sha256 \`${catalogue.source.workbook_sha256}\`), sheet \`${RULES_SHEET}\`, header row 1, data rows ${catalogue.source.first_data_row}–${catalogue.source.last_data_row}.`,
  `Catalogue: \`server/src/health/rules/itsm/catalogue.json\` v${CATALOGUE_VERSION}, generated ${catalogue.generated}. ${rules.length} rules.`,
  '',
  'Generated by `server/scripts/import-itsm-catalogue.mjs`; do not edit by hand.',
  '',
  '| Rule ID | Excel Row | Catalogue Entry | Status |',
  '| --- | ---: | --- | --- |',
  ...rules.map((r, i) => `| ${r.id} | ${r.excel_row} | rules[${i}] | Imported |`),
  '',
].join('\n');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'catalogue.json'), `${JSON.stringify(catalogue, null, 1)}\n`);
fs.writeFileSync(path.join(OUT_DIR, 'traceability.json'), `${JSON.stringify(traceability, null, 1)}\n`);
fs.writeFileSync(path.join(OUT_DIR, 'traceability.md'), md);

process.stdout.write(`imported ${rules.length} rules (${catalogue.id_range.first} … ${catalogue.id_range.last}) from rows ${catalogue.source.first_data_row}–${catalogue.source.last_data_row} of "${RULES_SHEET}" into ${path.relative(process.cwd(), OUT_DIR)}\n`);
