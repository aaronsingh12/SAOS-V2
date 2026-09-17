import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

/*
 * PHASE 2 — the ITSM architecture map classifies every catalogued rule, once,
 * with a recognised archetype, engine and compatibility verdict, and keeps the
 * slot system intact (slot n ↔ ITSM-nnn ↔ catalogue rules[n-1]).
 *
 * Nothing here runs a rule. The map is data derived from the catalogue; these
 * tests hold it to the catalogue, hold the two markdown documents to the map,
 * and pin the Phase 2 boundary: no module under src/ reads any of it.
 */

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const DIR = path.join(SRC, 'health', 'rules', 'itsm');

const catalogue = JSON.parse(fs.readFileSync(path.join(DIR, 'catalogue.json'), 'utf8'));
const map = JSON.parse(fs.readFileSync(path.join(DIR, 'architecture-map.json'), 'utf8'));
const engineDoc = fs.readFileSync(path.join(DIR, 'engine-requirements.md'), 'utf8');
const depDoc = fs.readFileSync(path.join(DIR, 'dependency-map.md'), 'utf8');

const EXPECTED_COUNT = 139;
const EXPECTED_IDS = Array.from({ length: EXPECTED_COUNT }, (_, i) => `ITSM-${String(i + 1).padStart(3, '0')}`);
const V = map.vocabularies;
const TASK_TABLES = ['incident', 'change_request', 'problem'];
/* Tables the workbook names (or that a named field belongs to unambiguously). Anything else must be a candidate. */
const WORKBOOK_TABLES = new Set([
  ...TASK_TABLES, 'cmdb_ci', 'cmdb_rel_ci', 'cmdb_ci_service', 'service_offering', 'task_sla', 'contract_sla',
  'cmn_schedule', 'sys_choice', 'sys_user', 'sys_user_grmember', 'sys_audit', 'sys_attachment', 'kb_knowledge',
]);

const ENTRY_KEYS = [
  'slot', 'rule_id', 'excel_row', 'group', 'base_severity', 'rule', 'archetype', 'semantic_class', 'evaluation_level',
  'tables', 'candidate_tables', 'tables_undefined', 'fields', 'configuration_objects', 'data_requirements',
  'query_strategy', 'api', 'time_window', 'threshold_default', 'existing_engine_support', 'support_reason',
  'recommended_engine', 'also_requires', 'dependencies', 'result', 'volume', 'volume_reason', 'scale_risk',
  'complexity', 'implementation_notes',
];

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/* ════════════════════════ coverage, identity, slots ════════════════════════ */

test('139 / 139 rules are classified, once each, and the map says so', () => {
  assert.equal(map.entries.length, EXPECTED_COUNT);
  assert.equal(map.rule_count, EXPECTED_COUNT);
  assert.equal(map.catalogue_version, catalogue.catalogue_version, 'the map was built from a different catalogue version');
  assert.equal(map.workbook_sha256, catalogue.source.workbook_sha256, 'the map was built from a different workbook');
  const ids = map.entries.map((e) => e.rule_id);
  assert.deepEqual(ids, EXPECTED_IDS, 'ids are not ITSM-001 … ITSM-139 in order');
  assert.equal(new Set(ids).size, EXPECTED_COUNT, 'a rule is mapped twice');
});

test('no orphan catalogue rule and no rule outside the catalogue', () => {
  const catIds = catalogue.rules.map((r) => r.id);
  const mapIds = map.entries.map((e) => e.rule_id);
  assert.deepEqual(catIds.filter((id) => !mapIds.includes(id)), [], 'catalogue rules without an architecture entry');
  assert.deepEqual(mapIds.filter((id) => !catIds.includes(id)), [], 'architecture entries for rules not in the catalogue');
});

test('slot n ↔ ITSM-nnn ↔ catalogue rules[n-1] ↔ Excel row n+1, for every n', () => {
  map.entries.forEach((e, i) => {
    const c = catalogue.rules[i];
    assert.equal(e.slot, i + 1, `${e.rule_id}: slot ${e.slot} at index ${i}`);
    assert.equal(e.rule_id, `ITSM-${String(e.slot).padStart(3, '0')}`, `slot ${e.slot} maps to ${e.rule_id}`);
    assert.equal(e.rule_id, c.id);
    assert.equal(e.excel_row, c.excel_row, `${e.rule_id}: excel_row differs from the catalogue`);
    assert.equal(e.excel_row, e.slot + 1);
    /* Copied fields stay verbatim — the map may not restate the workbook. */
    assert.equal(e.group, c.group);
    assert.equal(e.base_severity, c.base_severity);
    assert.equal(e.rule, c.rule);
    assert.equal(e.threshold_default, c.threshold_parameter, `${e.rule_id}: threshold_default is not the workbook's Threshold / Parameter verbatim`);
  });
  const slots = map.entries.map((e) => e.slot);
  assert.equal(new Set(slots).size, EXPECTED_COUNT, 'a slot is used twice');
});

/* ════════════════════════ shape and vocabularies ════════════════════════ */

test('every entry has the same keys in the same order', () => {
  for (const e of map.entries) assert.deepEqual(Object.keys(e), ENTRY_KEYS, `${e.rule_id} has a different shape`);
});

test('every rule has a recognised archetype, and its engine is the one that archetype maps to', () => {
  const archetypes = Object.keys(V.archetypes);
  const engines = Object.keys(V.engines);
  for (const e of map.entries) {
    assert.ok(archetypes.includes(e.archetype), `${e.rule_id}: archetype "${e.archetype}" is not in the vocabulary`);
    assert.ok(engines.includes(e.recommended_engine), `${e.rule_id}: engine "${e.recommended_engine}" is not in the vocabulary`);
    assert.equal(e.recommended_engine, V.archetype_to_engine[e.archetype], `${e.rule_id}: engine does not follow from the archetype`);
    assert.ok(V.query_strategies.includes(e.query_strategy), `${e.rule_id}: query_strategy "${e.query_strategy}"`);
    for (const a of e.also_requires) {
      assert.ok(engines.includes(a), `${e.rule_id}: also_requires "${a}" is not an engine`);
      assert.notEqual(a, e.recommended_engine, `${e.rule_id}: also_requires repeats the primary engine`);
    }
    assert.equal(new Set(e.also_requires).size, e.also_requires.length, `${e.rule_id}: also_requires has a duplicate`);
  }
});

test('every rule has a compatibility verdict of FULL, PARTIAL or NONE with a stated reason', () => {
  for (const e of map.entries) {
    assert.ok(V.existing_engine_support.includes(e.existing_engine_support), `${e.rule_id}: "${e.existing_engine_support}"`);
    assert.ok(nonEmpty(e.support_reason), `${e.rule_id}: no support_reason`);
  }
});

test('FULL means what the map\'s own convention says: a single-table record predicate needing nothing else', () => {
  for (const e of map.entries.filter((x) => x.existing_engine_support === 'FULL')) {
    assert.equal(e.archetype, 'record_predicate', `${e.rule_id} is FULL but not a record predicate`);
    assert.ok(e.tables.length >= 1 && e.tables.every((t) => TASK_TABLES.includes(t)), `${e.rule_id} is FULL but reads ${e.tables.join(', ')}`);
    assert.equal(e.tables_undefined, false, `${e.rule_id} is FULL with an undefined table`);
    const d = e.data_requirements;
    assert.ok(!d.requires_history && !d.requires_configuration && !d.requires_relationships && !d.requires_cross_domain_data && !d.requires_text_analysis,
      `${e.rule_id} is FULL but requires history/configuration/relationships/cross-domain/text`);
  }
});

test('volumes, result types, finding levels, complexity, semantics and evaluation levels use the closed vocabularies', () => {
  for (const e of map.entries) {
    assert.ok(V.volumes.includes(e.volume), `${e.rule_id}: volume "${e.volume}"`);
    assert.ok(nonEmpty(e.volume_reason), `${e.rule_id}: no volume_reason`);
    assert.ok(V.result_types.includes(e.result.type), `${e.rule_id}: result.type "${e.result.type}"`);
    assert.ok(V.finding_levels.includes(e.result.finding_level), `${e.rule_id}: finding_level "${e.result.finding_level}"`);
    assert.ok(V.complexity.includes(e.complexity), `${e.rule_id}: complexity "${e.complexity}"`);
    assert.ok(V.semantic_classes.includes(e.semantic_class), `${e.rule_id}: semantic_class "${e.semantic_class}"`);
    assert.ok(V.evaluation_levels.includes(e.evaluation_level), `${e.rule_id}: evaluation_level "${e.evaluation_level}"`);
    assert.equal(typeof e.scale_risk, 'boolean');
    assert.equal(typeof e.tables_undefined, 'boolean');
    for (const k of ['requires_history', 'requires_configuration', 'requires_relationships', 'requires_cross_domain_data', 'requires_text_analysis']) {
      assert.equal(typeof e.data_requirements[k], 'boolean', `${e.rule_id}: ${k}`);
    }
    assert.ok(e.api.every((a) => ['table_api', 'aggregate_api', 'metadata_api'].includes(a)), `${e.rule_id}: api ${e.api}`);
  }
});

test('scale risk is only claimed on HIGH or VERY_HIGH volume; VERY_HIGH always carries it', () => {
  for (const e of map.entries) {
    if (e.scale_risk) assert.ok(['HIGH', 'VERY_HIGH'].includes(e.volume), `${e.rule_id}: scale_risk on ${e.volume} volume`);
    if (e.volume === 'VERY_HIGH') assert.ok(e.scale_risk, `${e.rule_id}: VERY_HIGH without scale_risk`);
  }
});

/* ════════════════════════ data sources ════════════════════════ */

test('`tables` names only workbook-named tables; inferred platform tables are candidates, and never both', () => {
  for (const e of map.entries) {
    for (const t of e.tables) assert.ok(WORKBOOK_TABLES.has(t), `${e.rule_id}: "${t}" in tables is not a workbook-named table — it belongs in candidate_tables`);
    for (const t of e.candidate_tables) assert.ok(!e.tables.includes(t), `${e.rule_id}: "${t}" is both a table and a candidate`);
    assert.equal(new Set(e.tables).size, e.tables.length, `${e.rule_id}: duplicate table`);
  }
});

test('flags agree with the classification: relationships ⇒ cmdb_rel_ci; text ⇒ text engine somewhere; history ⇒ audit engine somewhere', () => {
  for (const e of map.entries) {
    const engines = [e.recommended_engine, ...e.also_requires];
    if (e.data_requirements.requires_relationships) assert.ok(e.tables.includes('cmdb_rel_ci'), `${e.rule_id}: requires_relationships without cmdb_rel_ci`);
    if (e.data_requirements.requires_text_analysis) assert.ok(engines.includes('text_analysis'), `${e.rule_id}: requires_text_analysis but no text engine`);
    if (e.archetype === 'text_analysis') assert.ok(e.data_requirements.requires_text_analysis, `${e.rule_id}: text archetype without the flag`);
    if (e.archetype === 'audit_history') assert.ok(e.data_requirements.requires_history, `${e.rule_id}: audit archetype without requires_history`);
    if (e.archetype === 'configuration_inspection') assert.ok(e.data_requirements.requires_configuration, `${e.rule_id}: configuration archetype without the flag`);
    if (e.archetype === 'relationship_graph') assert.ok(e.data_requirements.requires_relationships, `${e.rule_id}: graph archetype without the flag`);
  }
});

/* ════════════════════════ dependencies ════════════════════════ */

test('every dependency names an existing, different rule; the consumes graph is acyclic', () => {
  const ids = new Set(map.entries.map((e) => e.rule_id));
  const consumes = new Map();
  for (const e of map.entries) {
    for (const k of ['consumes_output_of', 'interpret_with', 'related']) {
      for (const r of e.dependencies[k]) {
        assert.ok(ids.has(r), `${e.rule_id}: ${k} names ${r}, which does not exist`);
        assert.notEqual(r, e.rule_id, `${e.rule_id}: ${k} names itself`);
      }
    }
    consumes.set(e.rule_id, e.dependencies.consumes_output_of);
  }
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    assert.notEqual(state.get(id), 'active', `consumes_output_of cycle: ${[...trail, id].join(' → ')}`);
    state.set(id, 'active');
    for (const d of consumes.get(id)) visit(d, [...trail, id]);
    state.set(id, 'done');
  };
  for (const id of ids) visit(id, []);
});

test('a rule that consumes another rule\'s output is a composite or reference-integrity union, never a plain predicate', () => {
  for (const e of map.entries.filter((x) => x.dependencies.consumes_output_of.length)) {
    assert.ok(['composite', 'reference_integrity', 'aggregate_distribution'].includes(e.archetype), `${e.rule_id} consumes ${e.dependencies.consumes_output_of} but is a ${e.archetype}`);
  }
});

/* ════════════════════════ the documents are held to the map ════════════════════════ */

function rulesListedUnder(doc, engineKey, label) {
  const heading = new RegExp(`^## \\d+\\. .+ \\(\`${engineKey}\`\\)$`, 'm');
  const start = doc.search(heading);
  assert.ok(start >= 0, `engine-requirements.md has no section for ${engineKey}`);
  const section = doc.slice(start, doc.indexOf('\n## ', start + 1) > 0 ? doc.indexOf('\n## ', start + 1) : undefined);
  const m = new RegExp(`\\*\\*${label} \\((\\d+)\\):\\*\\* *([^\\n]*)`).exec(section);
  assert.ok(m, `${engineKey}: no "${label} (N):" line`);
  const ids = m[2].trim() === '—' ? [] : m[2].split(',').map((s) => s.trim()).filter(Boolean);
  assert.equal(Number(m[1]), ids.length, `${engineKey}: "${label} (${m[1]})" but ${ids.length} listed`);
  return ids;
}

test('engine-requirements.md lists, per engine, exactly the rules the map assigns as primary and as supporting', () => {
  for (const eng of Object.keys(V.engines)) {
    const primary = map.entries.filter((e) => e.recommended_engine === eng).map((e) => e.rule_id);
    const supporting = map.entries.filter((e) => e.also_requires.includes(eng)).map((e) => e.rule_id);
    assert.deepEqual(rulesListedUnder(engineDoc, eng, 'Primary rules'), primary, `${eng}: primary list differs from the map`);
    assert.deepEqual(rulesListedUnder(engineDoc, eng, 'Supporting'), supporting, `${eng}: supporting list differs from the map`);
  }
});

test('dependency-map.md mentions every rule, every consumes edge and every interpret-with source', () => {
  for (const e of map.entries) {
    const short = e.rule_id.slice(5);
    assert.ok(depDoc.includes(e.rule_id) || new RegExp(`\\b${short}\\b`).test(depDoc), `${e.rule_id} is absent from dependency-map.md`);
  }
  const consumesSection = depDoc.slice(depDoc.indexOf('### 3a.'), depDoc.indexOf('### 3b.'));
  for (const e of map.entries) {
    for (const d of e.dependencies.consumes_output_of) {
      assert.ok(consumesSection.includes(e.rule_id) && consumesSection.includes(d), `consumes edge ${d} → ${e.rule_id} is not in section 3a`);
    }
  }
  const interpretSection = depDoc.slice(depDoc.indexOf('### 3b.'), depDoc.indexOf('### 3c.'));
  for (const e of map.entries) {
    if (e.dependencies.interpret_with.length) {
      assert.ok(interpretSection.includes(e.rule_id), `${e.rule_id} has interpret_with edges but no row in section 3b`);
      for (const d of e.dependencies.interpret_with) assert.ok(interpretSection.includes(d), `${e.rule_id} → ${d} missing from section 3b`);
    }
  }
});

test('the Phase 2 boundary: the catalogue and every rule are still the ones Phase 1 imported', () => {
  assert.equal(catalogue.rules.length, EXPECTED_COUNT);
  assert.deepEqual(catalogue.rules.map((r) => r.id), EXPECTED_IDS);
});

test('PHASE 3 BOUNDARY: the architecture map is read by the loader only; the two documents by nothing', () => {
  /* Phase 2 asserted no reader at all; Phase 3's loader is the one sanctioned reader of the map. */
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      /* Import statements only — comments elsewhere legitimately name these files. */
      else if (ent.name.endsWith('.js') && /from\s+'[^']*(architecture-map|engine-requirements|dependency-map)[^']*'/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(SRC, full).replace(/\\/g, '/'));
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, ['health/itsm/catalogue.js'], 'only the loader may read the architecture map, and nothing reads the documents');
  const loader = fs.readFileSync(path.join(SRC, 'health/itsm/catalogue.js'), 'utf8');
  assert.equal(/engine-requirements|dependency-map/.test(loader), false, 'the loader must not read the markdown documents');
});
