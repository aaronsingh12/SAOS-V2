import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

/*
 * ITSM PHASE 3 — the foundation: loader, adapter, parameters, windows, engine
 * key, registry, and the boundary that keeps all of it OUT of the running
 * health engine until Phase 4 connects a rule.
 */

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

const {
  loadCatalogue, validateCatalogue, getITSMRule, getITSMRuleBySlot, getAllITSMRules, getITSMCatalogueMeta, hasITSMRule, rulesForEngine, CatalogueError,
} = await import('../src/health/itsm/catalogue.js');
const { SEVERITY_WORD_TO_BAND, BAND_TO_SEVERITY_WORD, toEngineBand, toSeverityWord, adaptRule, parseLanes, AdapterError } = await import('../src/health/itsm/adapter.js');
const { ParameterRegistry, PARAMETER_STATUS, ParameterError, ITSM_PARAMETERS } = await import('../src/health/itsm/parameters.js');
const { createRunContext, parseWindow, WINDOWS, toSnowTime, fromSnowTime, windowMs, WindowError } = await import('../src/health/itsm/run-context.js');
const { itsmEngineKey, explainKeyChange, itsmSourceHash } = await import('../src/health/itsm/engine-key.js');
const { ITSM_ENGINE_REGISTRY, ENGINE_KEYS, validateRegistry, engineFor, evaluateRule, configurationStatus } = await import('../src/health/itsm/registry.js');
const { createEvaluationContext } = await import('../src/health/itsm/context.js');
const { SEVERITIES } = await import('../src/health/rules.js');

const catalogueJson = JSON.parse(fs.readFileSync(path.join(SRC, 'health/rules/itsm/catalogue.json'), 'utf8'));
const mapJson = JSON.parse(fs.readFileSync(path.join(SRC, 'health/rules/itsm/architecture-map.json'), 'utf8'));

/* ════════════════════════ catalogue loader ════════════════════════ */

test('LOADER: 139 rules load, ids and slots are preserved, lookups by id and by slot agree', () => {
  const all = getAllITSMRules();
  assert.equal(all.length, 139);
  all.forEach((r, i) => {
    assert.equal(r.slot, i + 1);
    assert.equal(r.id, `ITSM-${String(i + 1).padStart(3, '0')}`);
    assert.equal(r.excel_row, i + 2);
    assert.equal(getITSMRuleBySlot(i + 1), r);
    assert.equal(getITSMRule(r.id), r);
  });
  assert.equal(getITSMRule('ITSM-001').rule, catalogueJson.rules[0].rule, 'the loaded rule is not the catalogue text verbatim');
  assert.equal(getITSMRuleBySlot(139).id, 'ITSM-139');
  assert.equal(getITSMCatalogueMeta().workbook_sha256, catalogueJson.source.workbook_sha256);
  assert.equal(getITSMCatalogueMeta().rule_count, 139);
});

test('LOADER: unknown ids, malformed ids and out-of-range slots throw; nothing is guessed', () => {
  assert.throws(() => getITSMRule('ITSM-140'), CatalogueError);
  assert.throws(() => getITSMRule('ITSM-000'), CatalogueError);
  assert.throws(() => getITSMRule('itsm-001'), CatalogueError);
  assert.throws(() => getITSMRule('CMDB-001'), CatalogueError);
  assert.throws(() => getITSMRuleBySlot(0), CatalogueError);
  assert.throws(() => getITSMRuleBySlot(140), CatalogueError);
  assert.throws(() => getITSMRuleBySlot('1'), CatalogueError);
  assert.equal(hasITSMRule('ITSM-139'), true);
  assert.equal(hasITSMRule('ITSM-140'), false);
});

test('LOADER: a catalogue with a duplicate, a gap, a wrong slot or an empty required field is refused', () => {
  const clone = () => JSON.parse(JSON.stringify(catalogueJson));
  let c = clone(); c.rules[10].id = 'ITSM-010';
  assert.throws(() => validateCatalogue(c), /expected ITSM-011/);
  c = clone(); c.rules.splice(50, 1);
  assert.throws(() => validateCatalogue(c), /holds 138 rules/);
  c = clone(); c.rules[3].excel_row = 99;
  assert.throws(() => validateCatalogue(c), /excel_row 99/);
  c = clone(); c.rules[7].detection_logic = '  ';
  assert.throws(() => validateCatalogue(c), /required field "detection_logic"/);
  c = clone(); c.rules[0].base_severity = 'Medium';
  assert.throws(() => validateCatalogue(c), /not a workbook band/);
  /* And loadCatalogue with a mismatched map refuses too. */
  const badMap = { ...mapJson, workbook_sha256: 'deadbeef' };
  assert.throws(() => loadCatalogue({ catalogue: clone(), architecture: badMap, force: true }), /different workbook/);
});

test('LOADER: every rule carries its architecture (engine, archetype, dependencies) from the map', () => {
  for (const r of getAllITSMRules()) {
    const e = mapJson.entries[r.slot - 1];
    assert.equal(r.architecture.engine, e.recommended_engine);
    assert.equal(r.architecture.archetype, e.archetype);
    assert.deepEqual([...r.architecture.dependencies.consumes_output_of], e.dependencies.consumes_output_of);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.architecture), `${r.id} is mutable`);
  }
  assert.equal(rulesForEngine('record_predicate').length, 21);
  assert.equal(rulesForEngine('aggregate', { includeSupporting: true }).length, 70);
});

/* ════════════════════════ adapter ════════════════════════ */

test('ADAPTER: the severity mapping is explicit, total and bijective — Moderate → MEDIUM, everything else upper-cased', () => {
  assert.deepEqual(SEVERITY_WORD_TO_BAND, { Systemic: 'SYSTEMIC', Critical: 'CRITICAL', High: 'HIGH', Moderate: 'MEDIUM', Low: 'LOW' });
  for (const [word, band] of Object.entries(SEVERITY_WORD_TO_BAND)) {
    assert.equal(toEngineBand(word), band);
    assert.equal(toSeverityWord(band), word);
    assert.equal(BAND_TO_SEVERITY_WORD[band], word);
    /* Every band the adapter produces is one the engine's severity table knows. */
    assert.ok(SEVERITIES.some((s) => s.key === band), `${band} is not in rules.js SEVERITIES`);
  }
  assert.equal(SEVERITIES.find((s) => s.key === 'MEDIUM').label, 'Moderate', 'the engine labels MEDIUM as Moderate — the mapping rests on that');
  assert.throws(() => toEngineBand('critical'), AdapterError);
  assert.throws(() => toEngineBand('Medium'), AdapterError);
  assert.throws(() => toSeverityWord('MODERATE'), AdapterError);
});

test('ADAPTER: every catalogue rule adapts; lanes are read as a set with the text kept, never coerced to one number', () => {
  const bands = {};
  for (const r of getAllITSMRules()) {
    const a = adaptRule(r);
    assert.equal(a.id, r.id);
    assert.equal(a.baseWord, r.base_severity);
    assert.equal(a.base, SEVERITY_WORD_TO_BAND[r.base_severity]);
    assert.equal(a.title, r.rule);
    assert.equal(a.workbook, r, 'the workbook text must travel with the adapted rule');
    assert.ok(a.remediationLane.lanes.length >= 1, `${r.id}: no lane parsed from "${r.remediation_lane}"`);
    assert.equal(a.remediationLane.text, r.remediation_lane);
    assert.ok(!('kind' in a) && !('track' in a) && !('lane' in a) && !('dimension' in a), `${r.id}: a derived CMDB field was invented`);
    bands[a.base] = (bands[a.base] || 0) + 1;
  }
  assert.deepEqual(bands, { SYSTEMIC: 33, CRITICAL: 51, HIGH: 41, MEDIUM: 14 });
  assert.deepEqual(parseLanes('Lane 1 where unambiguous, Lane 3 otherwise').lanes, [1, 3]);
  assert.deepEqual(parseLanes('Lane 2 across all three, plus Lane 3 process adoption').lanes, [2, 3]);
  assert.equal(adaptRule('ITSM-001').remediationLane.text, 'Lane 2 — matrix reconfiguration as update set');
});

/* ════════════════════════ parameters ════════════════════════ */

test('PARAMETERS: workbook default → instance override → runtime override, in that precedence', () => {
  const reg = new ParameterRegistry({ version: 'test' });
  reg.define({ rule: 'ITSM-001', key: 'dominance_share', type: 'percent', default: 70, workbook_text: 'Default 70% in one band.' });
  reg.define({ rule: 'ITSM-001', key: 'window_days', type: 'duration', unit: 'days', default: 90 });
  let r = reg.resolve('ITSM-001');
  assert.equal(r.status, PARAMETER_STATUS.RESOLVED);
  assert.deepEqual([r.parameters.dominance_share.value, r.parameters.dominance_share.source], [70, 'workbook']);
  reg.setInstanceOverride('ITSM-001', 'dominance_share', 60);
  r = reg.resolve('ITSM-001');
  assert.deepEqual([r.parameters.dominance_share.value, r.parameters.dominance_share.source], [60, 'instance']);
  r = reg.resolve('ITSM-001', { runtime: { dominance_share: 55 } });
  assert.deepEqual([r.parameters.dominance_share.value, r.parameters.dominance_share.source], [55, 'runtime']);
  assert.equal(r.parameters.window_days.source, 'workbook', 'an override on one key must not touch another');
  assert.equal(r.workbook_text, getITSMRule('ITSM-001').threshold_parameter);
});

test('PARAMETERS: an undefined threshold resolves UNCONFIGURED (reason undefined_default) with no value; an undeclared rule is UNCONFIGURED (reason undeclared) and shows the workbook sentence; the app registry is fully declared', () => {
  const reg = new ParameterRegistry({ version: 'test' });
  reg.define({ rule: 'ITSM-023', key: 'volume_threshold', type: 'number', default: null, workbook_text: 'Volume threshold configurable relative to total volume' });
  const r = reg.resolve('ITSM-023');
  assert.equal(r.status, PARAMETER_STATUS.UNCONFIGURED);
  assert.equal(r.reason, 'undefined_default');
  assert.equal(r.parameters.volume_threshold.value, null);
  assert.equal(r.parameters.volume_threshold.status, PARAMETER_STATUS.UNCONFIGURED);
  assert.deepEqual([...r.unresolved], ['volume_threshold']);
  /* An override CAN resolve it — a customer supplies the number. */
  reg.setInstanceOverride('ITSM-023', 'volume_threshold', 25);
  assert.equal(reg.resolve('ITSM-023').status, PARAMETER_STATUS.RESOLVED);
  /* Undeclared: a registry with no declaration for the rule at all. */
  const u = new ParameterRegistry({ version: 'test' }).resolve('ITSM-054');
  assert.equal(u.status, PARAMETER_STATUS.UNCONFIGURED);
  assert.equal(u.reason, 'undeclared');
  assert.equal(u.declared, false);
  assert.match(u.workbook_text, /Cluster volume threshold/);
  /* The app registry: every rule declared (Phase 4), ITSM-054's thresholds UNDEFINED, ITSM-001's defined. */
  assert.equal(ITSM_PARAMETERS.snapshot().declared_rules, 139);
  assert.equal(ITSM_PARAMETERS.resolve('ITSM-054').status, PARAMETER_STATUS.UNCONFIGURED);
  assert.equal(ITSM_PARAMETERS.resolve('ITSM-054').reason, 'undefined_default');
  assert.equal(ITSM_PARAMETERS.resolve('ITSM-001').parameters.dominance_share.value, 70);
});

test('PARAMETERS: declarations are validated — unknown rule, bad type, override of an undeclared key, wrong-typed value, contradictory status', () => {
  const reg = new ParameterRegistry({ version: 'test' });
  assert.throws(() => reg.define({ rule: 'ITSM-999', key: 'x', type: 'number', default: 1 }), ParameterError);
  assert.throws(() => reg.define({ rule: 'ITSM-001', key: 'BadKey', type: 'number', default: 1 }), ParameterError);
  assert.throws(() => reg.define({ rule: 'ITSM-001', key: 'x', type: 'colour', default: 1 }), ParameterError);
  assert.throws(() => reg.define({ rule: 'ITSM-001', key: 'x', type: 'duration', default: 1 }), /needs a unit/);
  assert.throws(() => reg.define({ rule: 'ITSM-001', key: 'x', type: 'percent', default: 120 }), /percentage/);
  assert.throws(() => reg.define({ rule: 'ITSM-001', key: 'x', type: 'number', default: 5, status: 'UNDEFINED' }), /either it has one or it does not/);
  reg.define({ rule: 'ITSM-001', key: 'x', type: 'number', default: 5 });
  assert.throws(() => reg.define({ rule: 'ITSM-001', key: 'x', type: 'number', default: 6 }), /already declared/);
  assert.throws(() => reg.setInstanceOverride('ITSM-001', 'y', 1), /not declared/);
  assert.throws(() => reg.setInstanceOverride('ITSM-001', 'x', 'five'), /not a finite number/);
});

test('PARAMETERS: the fingerprint moves on a new declaration or an instance override and NOT on a runtime override — cache invalidation follows it', () => {
  const reg = new ParameterRegistry({ version: 'test' });
  const f0 = reg.fingerprint();
  reg.define({ rule: 'ITSM-030', key: 'reopen_rate', type: 'percent', default: 8 });
  const f1 = reg.fingerprint();
  assert.notEqual(f1, f0);
  reg.setInstanceOverride('ITSM-030', 'reopen_rate', 10);
  const f2 = reg.fingerprint();
  assert.notEqual(f2, f1);
  reg.resolve('ITSM-030', { runtime: { reopen_rate: 12 } });
  assert.equal(reg.fingerprint(), f2, 'a runtime override changed the fingerprint');
  reg.clearInstanceOverride('ITSM-030', 'reopen_rate');
  assert.equal(reg.fingerprint(), f1, 'clearing the override did not restore the fingerprint');
  const k1 = itsmEngineKey({ parameters: reg });
  reg.setInstanceOverride('ITSM-030', 'reopen_rate', 10);
  const k2 = itsmEngineKey({ parameters: reg });
  assert.notEqual(k1.key, k2.key);
  assert.deepEqual(explainKeyChange(k1, k2), ['parameters changed']);
});

/* ════════════════════════ windows ════════════════════════ */

test('WINDOWS: one anchor per run; every supported window computes the right start and end in UTC', () => {
  const ctx = createRunContext({ now: new Date('2026-09-16T12:00:00Z') });
  assert.equal(ctx.now_snow, '2026-09-16 12:00:00');
  const expect = {
    '30 minutes': '2026-09-16 11:30:00', '72 hours': '2026-09-13 12:00:00', '90 days': '2026-06-18 12:00:00',
    '180 days': '2026-03-20 12:00:00', '12 months': '2025-09-16 12:00:00', '1 hour': '2026-09-16 11:00:00', '60 seconds': '2026-09-16 11:59:00',
  };
  for (const [name, start] of Object.entries(expect)) {
    const w = ctx.window(name);
    assert.equal(w.start_snow, start, name);
    assert.equal(w.end_snow, '2026-09-16 12:00:00', `${name} does not end at the anchor`);
  }
  for (const name of Object.keys(WINDOWS)) assert.doesNotThrow(() => ctx.window(name), name);
  assert.deepEqual(parseWindow({ amount: 3, unit: 'days' }), { amount: 3, unit: 'days' });
  assert.equal(windowMs('72 hours'), 72 * 3_600_000);
  assert.throws(() => windowMs('12 months'), WindowError);
  assert.throws(() => parseWindow('fortnight'), WindowError);
  assert.throws(() => parseWindow({ amount: -1, unit: 'days' }), WindowError);
});

test('WINDOWS: the anchor does not move during a run; around() anchors on an event; ageDays floors; windows used are recorded', () => {
  const ctx = createRunContext({ now: new Date('2026-09-16T12:00:00Z') });
  const a = ctx.window('90 days');
  const b = ctx.window('90 days');
  assert.equal(a.start_snow, b.start_snow);
  assert.equal(ctx.run_started_at, '2026-09-16T12:00:00.000Z');
  const ar = ctx.around('2026-09-10 08:00:00', '72 hours');
  assert.deepEqual([ar.start_snow, ar.end_snow], ['2026-09-07 08:00:00', '2026-09-10 08:00:00']);
  const after = ctx.around('2026-09-10 08:00:00', '72 hours', { direction: 'after' });
  assert.deepEqual([after.start_snow, after.end_snow], ['2026-09-10 08:00:00', '2026-09-13 08:00:00']);
  assert.equal(ctx.ageDays('2026-09-14 13:00:00'), 1);
  assert.equal(ctx.ageDays('2026-09-14 11:00:00'), 2);
  assert.equal(ctx.ageDays(''), null);
  assert.ok('90 days' in ctx.windowsUsed());
  assert.equal(toSnowTime(fromSnowTime('2026-01-31 23:59:59')), '2026-01-31 23:59:59');
  assert.equal(fromSnowTime('not a date'), null);
});

/* ════════════════════════ engine key ════════════════════════ */

test('ENGINE KEY: names every DECISION 8 input, is stable, and moves on catalogue version, engine version or source', () => {
  const k = itsmEngineKey();
  assert.deepEqual(Object.keys(k.inputs), ['catalogue_version', 'workbook_sha256', 'map_version', 'parameters', 'engine_version', 'engine_versions', 'configuration', 'dependencies', 'source']);
  assert.equal(k.inputs.workbook_sha256, catalogueJson.source.workbook_sha256);
  assert.equal(itsmEngineKey().key, k.key, 'not stable across calls');
  assert.notEqual(itsmEngineKey({ engineVersion: '9.9.9' }).key, k.key);
  assert.notEqual(itsmEngineKey({ sourceHash: 'ffffffffffffffff' }).key, k.key);
  assert.match(itsmSourceHash(), /^[0-9a-f]{16}$/);
  assert.deepEqual(explainKeyChange(null, k), ['no earlier ITSM engine key']);
});

test('ENGINE KEY: health/itsm stays outside the shared engine hash; the ITSM key is folded into the ITSM module key only (DECISION 8)', () => {
  const src = fs.readFileSync(path.join(SRC, 'health/incremental.js'), 'utf8');
  const re = new Function(`return ${/const ENGINE_FILES = (\/.*\/);/.exec(src)[1]}`)();
  assert.equal(re.test('itsm'), false);
  assert.equal(re.test('rules'), false);
  assert.equal(fs.existsSync(path.join(SRC, 'health/catalogue/itsm.json')), false);
  /* Phase 5: the key is built from the scan's registry (declarations + instance overrides), still for ITSM only. */
  assert.ok(src.includes("m === 'itsm' ? itsmEngineKey(itsmParameters ? { parameters: itsmParameters } : {}).key : undefined"), 'the ITSM key must be folded into the ITSM module key, and only there');
});

/* ════════════════════════ registry ════════════════════════ */

test('REGISTRY: ten engines, one per map engine key, each with the same contract', () => {
  assert.equal(validateRegistry(), true);
  assert.deepEqual([...ENGINE_KEYS].sort(), Object.keys(mapJson.vocabularies.engines).sort());
  for (const e of Object.values(ITSM_ENGINE_REGISTRY)) {
    assert.match(e.version, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof e.canEvaluate, 'function');
    assert.equal(typeof e.prepare, 'function');
    assert.equal(typeof e.evaluate, 'function');
    assert.ok(Object.isFrozen(e));
  }
  for (const r of getAllITSMRules()) {
    const a = adaptRule(r);
    assert.equal(engineFor(a).key, r.architecture.engine);
    assert.ok(engineFor(a).canEvaluate(a), `${r.id}: its own engine says it cannot evaluate it`);
  }
});

test('REGISTRY: every rule has a Phase 4 configuration; evaluating a rule WITHOUT one still answers not_configured and reads NOTHING from the instance', async () => {
  const status = configurationStatus();
  assert.equal(status.rules, 139);
  assert.equal(status.configured, 0, 'with no config map passed, nothing is configured');
  const { ITSM_RULE_CONFIGS } = await import('../src/health/itsm/rules/index.js');
  assert.equal(configurationStatus(Object.fromEntries(ITSM_RULE_CONFIGS)).configured, 139);
  assert.deepEqual(Object.values(status.by_engine).reduce((n, e) => n + e.total, 0), 139);
  let reads = 0;
  const client = { async query() { reads += 1; return []; }, async count() { reads += 1; return 0; }, async aggregate() { reads += 1; return []; } };
  const ctx = createEvaluationContext({ client, now: new Date('2026-09-16T12:00:00Z') });
  for (const r of getAllITSMRules()) {
    const res = await evaluateRule(r.id, ctx);
    assert.equal(res.status, 'not_configured', `${r.id}`);
    assert.equal(res.findings.length, 0);
    assert.equal(res.rule_id, r.id);
  }
  assert.equal(reads, 0, 'an unconfigured rule reached the instance');
});

/* ════════════════════════ the Phase 3 boundary ════════════════════════ */

test('BOUNDARY (Phase 5): outside health/itsm only incremental.js (the DECISION 8 key) and index.js (the scan) import it — rules.js, scopes.js, routes and the agent do not', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!full.includes(path.join('health', 'itsm'))) walk(full); }
      else if (ent.name.endsWith('.js') && /from\s+'[^']*itsm\/[^']*'/.test(fs.readFileSync(full, 'utf8').replace(/\\/g, '/'))) offenders.push(path.relative(SRC, full).replace(/\\/g, '/'));
    }
  };
  walk(SRC);
  /* Phase 4 allowed only the engine key. Phase 5 connects the runner to the scan
     in index.js — deliberately, and nowhere else: rules.js receives the
     normalized results as data and never imports the engine. */
  assert.deepEqual(offenders.sort(), ['health/incremental.js', 'health/index.js'], 'something other than the engine key and the scan imports health/itsm');
});

test('BOUNDARY: the eleven hard-coded ITSM rules are still the ones that run, unchanged in identity', () => {
  const rules = fs.readFileSync(path.join(SRC, 'health/rules.js'), 'utf8');
  const ids = [...rules.matchAll(/'(ITSM-[A-Z]+-[A-Z0-9-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), [
    'ITSM-CHG-FAILED', 'ITSM-CHG-NO-CI', 'ITSM-CHG-OVERDUE', 'ITSM-CHG-STALE', 'ITSM-INC-NO-CI', 'ITSM-INC-P1-AGED',
    'ITSM-INC-REOPENED', 'ITSM-INC-STALE', 'ITSM-INC-UNASSIGNED', 'ITSM-PRB-STALE', 'ITSM-PRB-UNASSIGNED',
  ]);
  assert.equal(/ITSM-\d{3}/.test(rules), false, 'a workbook rule id appears in rules.js');
});
