import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { fakeInstance, platformMeta } from './helpers/itsm-fake-instance.js';
import { estateContext, ESTATE, NOW } from './helpers/itsm-estate.js';

/**
 * ITSM PHASE 4 — decision alignment and the declarative rule layer.
 *
 * What this file proves, decision by decision:
 *   §3/§4  parameters.json: every rule declared, defaults only where the
 *          workbook states them, precedence, UNCONFIGURED never runs
 *   §4     rule-config: $param / $window / $clause / selectors / offend
 *   §5     the object pipeline stops at the first unmet step, never PASSes
 *   §8     the ITSM engine key moves on parameters / configuration / engine
 *          version, and moves ONLY the ITSM module key
 *   §9     schedules: daily / weekly / weekdays / timezone / window
 *          boundaries / unsupported recurrence / floating schedule
 *   the runner: gates, variants, error capture, dependency order
 */

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const catalogue = JSON.parse(fs.readFileSync(path.join(SRC, 'health/rules/itsm/catalogue.json'), 'utf8'));
const parametersJson = JSON.parse(fs.readFileSync(path.join(SRC, 'health/rules/itsm/parameters.json'), 'utf8'));

const { ITSM_PARAMETERS, ParameterRegistry, loadParameterDeclarations, PARAMETER_STATUS } = await import('../src/health/itsm/parameters.js');
const RC = await import('../src/health/itsm/rule-config.js');
const RULES = await import('../src/health/itsm/rules/index.js');
const { itsmEngineKey, explainKeyChange } = await import('../src/health/itsm/engine-key.js');
const { engineKeys } = await import('../src/health/incremental.js');
const SCH = await import('../src/health/itsm/schedules.js');
const { runITSMRules, evaluateConfiguredRule, planRules } = await import('../src/health/itsm/runner.js');
const { createEvaluationContext } = await import('../src/health/itsm/context.js');
const { getITSMRule } = await import('../src/health/itsm/catalogue.js');
const { PLACEHOLDERS, isVerified, VERIFIED_OBJECTS } = await import('../src/health/itsm/engines/configuration.js');

/* ════════════════════════ DECISION 3 / 4 — parameter declarations ════════════════════════ */

test('PARAMETERS (DECISION 4): every one of the 139 rules is declared; every declaration belongs to a catalogue rule; the workbook sentence is carried verbatim', () => {
  const ids = catalogue.rules.map((r) => r.id);
  assert.deepEqual(Object.keys(parametersJson.declarations).sort(), [...ids].sort());
  for (const r of catalogue.rules) {
    const d = parametersJson.declarations[r.id];
    assert.equal(d.workbook_text, r.threshold_parameter.replace(/\s+/g, ' ').trim(), `${r.id}: workbook_text is not the workbook's sentence`);
    assert.ok(ITSM_PARAMETERS.isDeclared(r.id), `${r.id} not loaded into the registry`);
  }
  assert.equal(ITSM_PARAMETERS.snapshot().declared_rules, 139);
});

test('PARAMETERS (DECISION 3): a default exists ONLY where the workbook states the number; UNDEFINED declarations carry no value; every stated default is in the workbook sentence', () => {
  let defined = 0; let undef = 0;
  for (const [id, d] of Object.entries(parametersJson.declarations)) {
    for (const p of d.parameters) {
      if (p.status === 'DEFINED') {
        defined += 1;
        assert.notEqual(p.default, null, `${id}.${p.key} DEFINED without a value`);
        /* The number must appear in the workbook's own sentence (0.5% / 0.1% / 2x / 12 months / 0.9 …). */
        const n = String(p.default);
        assert.ok(d.workbook_text.includes(n), `${id}.${p.key}: default ${n} is not in "${d.workbook_text}" — an invented default`);
      } else {
        undef += 1;
        assert.equal(p.status, 'UNDEFINED');
        assert.equal(p.default, null, `${id}.${p.key} UNDEFINED but has a value`);
      }
    }
  }
  assert.ok(defined > 50 && undef > 30, `${defined} defined / ${undef} undefined`);
  /* No silent 30/60/90 or 70/80 where the workbook says only "configurable". */
  for (const id of ['ITSM-022', 'ITSM-023', 'ITSM-025', 'ITSM-027', 'ITSM-040', 'ITSM-054', 'ITSM-059', 'ITSM-073', 'ITSM-086', 'ITSM-104', 'ITSM-105', 'ITSM-110', 'ITSM-126', 'ITSM-131', 'ITSM-133', 'ITSM-135']) {
    const r = ITSM_PARAMETERS.resolve(id);
    assert.equal(r.status, PARAMETER_STATUS.UNCONFIGURED, `${id} should be UNCONFIGURED`);
    assert.equal(r.reason, 'undefined_default');
  }
});

test('PARAMETERS (DECISION 4): precedence workbook → instance → runtime on the real registry; an override on an UNDEFINED parameter makes the rule executable; the loader refuses a bad document', () => {
  const reg = loadParameterDeclarations(new ParameterRegistry({ version: 'test' }), parametersJson);
  const before = reg.resolve('ITSM-001').parameters.dominance_share;
  assert.deepEqual([before.value, before.source], [70, 'workbook']);
  reg.setInstanceOverride('ITSM-001', 'dominance_share', 65);
  assert.deepEqual([reg.resolve('ITSM-001').parameters.dominance_share.value, reg.resolve('ITSM-001').parameters.dominance_share.source], [65, 'instance']);
  assert.equal(reg.resolve('ITSM-001', { runtime: { dominance_share: 50 } }).parameters.dominance_share.value, 50);
  assert.equal(reg.resolve('ITSM-023').status, PARAMETER_STATUS.UNCONFIGURED);
  reg.setInstanceOverride('ITSM-023', 'volume_share', 10);
  assert.equal(reg.resolve('ITSM-023').status, PARAMETER_STATUS.RESOLVED);
  assert.throws(() => reg.setInstanceOverride('ITSM-023', 'made_up', 1), /not declared/);
  assert.throws(() => loadParameterDeclarations(new ParameterRegistry(), { declarations: { 'ITSM-999': { parameters: [] } } }), /not a catalogue rule/);
  assert.throws(() => loadParameterDeclarations(new ParameterRegistry(), { declarations: { 'ITSM-001': { parameters: [{ key: 'x', type: 'number', status: 'DEFINED', default: null }] }, } }), /DEFINED with no default/);
  assert.throws(() => loadParameterDeclarations(new ParameterRegistry(), { declarations: { 'ITSM-001': { parameters: [{ key: 'x', type: 'number', status: 'UNDEFINED', default: 5 }] }, } }), /UNDEFINED but a default/);
});

/* ════════════════════════ rule-config compiler ════════════════════════ */

test('RULE CONFIG: selectors and offend expressions compile from data; combinators; type checks', () => {
  const sel = RC.compileSelector({ all: [{ field: 'priority', op: 'in', value: ['1', '2'] }, { not: { field: 'state', op: 'empty' } }] });
  assert.equal(sel({ priority: '1', state: '6' }), true);
  assert.equal(sel({ priority: '3', state: '6' }), false);
  assert.equal(sel({ priority: '1', state: '' }), false);
  const off = RC.compileOffend({ any: [{ path: 'derived', op: 'is_null' }, { path: 'derived', op: 'gte', value: 2 }] });
  assert.equal(off(null, {}), true);
  assert.equal(off(2, {}), true);
  assert.equal(off(1, {}), false);
  const rowAware = RC.compileOffend({ all: [{ path: 'answer.found', op: 'equals', value: true }, { path: 'row.business_service', op: 'empty' }] });
  assert.equal(rowAware({ found: true }, { business_service: '' }), true);
  assert.equal(rowAware({ found: true }, { business_service: 'svc' }), false);
  assert.throws(() => RC.compileSelector({ field: 'x', op: 'nope' }), /not one of/);
  assert.throws(() => RC.compileSelector({ field: 'x', op: 'gt', value: 'ten' }), /numeric/);
  assert.throws(() => RC.compileNamed({ name: 'no_such' }, {}, 'compare'), /not one of/);
});

test('RULE CONFIG (DECISION 4): $param references resolve through the registry; an UNCONFIGURED reference stops compilation; window / fraction / clause renderings', () => {
  const reg = new ParameterRegistry();
  reg.define({ rule: 'ITSM-016', key: 'threshold', type: 'percent', default: 40 });
  reg.define({ rule: 'ITSM-016', key: 'window', type: 'duration', unit: 'days', default: 90 });
  reg.define({ rule: 'ITSM-016', key: 'nothing', type: 'list', default: null });
  const params = reg.resolve('ITSM-016');
  const raw = { threshold: { op: 'gt', value: { $param: 'threshold' } }, window: { $param: 'window', as: 'window' }, frac: { $param: 'threshold', as: 'fraction' }, clause: { $param: 'threshold', as: 'clause', template: 'x>{}' } };
  const { config, missing } = RC.resolveParameters(raw, params);
  assert.deepEqual(missing, []);
  assert.deepEqual(config, { threshold: { op: 'gt', value: 40 }, window: '90 days', frac: 0.4, clause: 'x>40' });
  assert.deepEqual(RC.referencedParameters(raw), ['threshold', 'window']);
  const bad = RC.resolveParameters({ a: { $param: 'nothing' }, b: { $param: 'undeclared_key' } }, params);
  assert.deepEqual(bad.missing, ['nothing', 'undeclared_key (not declared)']);
  assert.equal(RC.compileRuleConfig('aggregate', { threshold: { op: 'gt', value: { $param: 'nothing' } } }, params).status, 'unconfigured');
  const ok = RC.compileRuleConfig('aggregate', { of: { field: 'p', op: 'equals', value: '1' }, threshold: { op: 'gt', value: { $param: 'threshold' } } }, params);
  assert.equal(ok.status, 'ok');
  assert.equal(typeof ok.config.of, 'function');
  assert.deepEqual(ok.config.required_parameters, ['threshold']);
});

/* ════════════════════════ rule files ════════════════════════ */

test('RULE FILES: all 139 rules configured exactly once, by an engine the map allows; every $param declared; every requires_objects a placeholder; no function-valued keys; the loader refuses each violation', () => {
  assert.equal(RULES.ITSM_RULE_CONFIGS.size, 139);
  assert.deepEqual(RULES.unconfiguredRuleIds(), []);
  for (const [id, e] of RULES.ITSM_RULE_CONFIGS) {
    assert.ok(RULES.engineAllowedFor(getITSMRule(id), e.engine), `${id}: ${e.engine}`);
    for (const o of e.config.requires_objects || []) assert.ok(PLACEHOLDERS[o] || isVerified(o), `${id}: ${o}`);
  }
  const overrides = [...RULES.ITSM_RULE_CONFIGS.values()].filter((e) => e.config.engine && e.config.engine !== getITSMRule(e.id).architecture.engine).map((e) => e.id);
  assert.deepEqual(overrides.sort(), ['ITSM-005', 'ITSM-080', 'ITSM-108', 'ITSM-134'], 'engine overrides are the ones the map allows through also_requires / consumes_output_of');
  const file = (engine, rules) => ({ engine, rules });
  assert.throws(() => RULES.loadRuleConfigs([file('aggregate', { 'ITSM-999': {} })]), /not a catalogue rule/);
  assert.throws(() => RULES.loadRuleConfigs([file('aggregate', { 'ITSM-001': {} }), file('linkage', { 'ITSM-001': {} })]), /configured twice/);
  assert.throws(() => RULES.loadRuleConfigs([file('linkage', { 'ITSM-001': {} })]), /neither its primary/);
  assert.throws(() => RULES.loadRuleConfigs([file('aggregate', { 'ITSM-001': { threshold: { $param: 'made_up' } } })]), /not declared for it/);
  assert.throws(() => RULES.loadRuleConfigs([file('aggregate', { 'ITSM-001': { requires_objects: ['unicorn'] } })]), /neither a placeholder nor a verified object/);
  assert.throws(() => RULES.loadRuleConfigs([file('aggregate', { 'ITSM-001': { engine: 'linkage' } })]), /neither its primary|sits in/);
  assert.match(RULES.ruleConfigFingerprint(), /^[0-9a-f]{16}$/);
});

test('RULE FILES: no rule is connected by a function keyed on its id — the config layer is data, and the runner / compiler / comparators name no ITSM-nnn', () => {
  for (const f of ['runner.js', 'rule-config.js', 'comparators.js', 'rules/index.js']) {
    const src = fs.readFileSync(path.join(SRC, 'health/itsm', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(/ITSM-\d{3}/.test(src), false, `${f} names a rule id in code`);
  }
});

/* ════════════════════════ DECISION 8 — engine key ════════════════════════ */

test('ENGINE KEY (DECISION 8): a parameter override, a configuration change or an engine version moves the ITSM key — and only the ITSM module key in incremental.engineKeys', () => {
  const base = itsmEngineKey();
  const reg = loadParameterDeclarations(new ParameterRegistry({ version: parametersJson.version }), parametersJson);
  assert.equal(itsmEngineKey({ parameters: reg }).key, base.key, 'an equal registry gives an equal key');
  reg.setInstanceOverride('ITSM-001', 'dominance_share', 60);
  const afterParam = itsmEngineKey({ parameters: reg });
  assert.notEqual(afterParam.key, base.key);
  assert.deepEqual(explainKeyChange(base, afterParam), ['parameters changed']);
  const configs = new Map(RULES.ITSM_RULE_CONFIGS);
  configs.set('ITSM-020', { ...configs.get('ITSM-020'), config: { ...configs.get('ITSM-020').config, scope: 'active=true' } });
  const afterConfig = itsmEngineKey({ configs });
  assert.deepEqual(explainKeyChange(base, afterConfig), ['configuration changed']);
  assert.deepEqual(explainKeyChange(base, itsmEngineKey({ engineVersion: '9.9.9' })), ['engine_version changed']);
  /* Runtime overrides are per run and NOT part of the key. */
  assert.equal(itsmEngineKey({ parameters: loadParameterDeclarations(new ParameterRegistry({ version: parametersJson.version }), parametersJson) }).key, base.key);
  /* Only the ITSM module's incremental key carries it. */
  const keys = engineKeys({ staleDays: 90 });
  assert.equal(keys.cmdb, keys.itom);
  assert.equal(keys.cmdb, keys.platform);
  assert.notEqual(keys.itsm, keys.cmdb, 'the ITSM module key must differ from the others by exactly the ITSM engine key');
});

/* ════════════════════════ DECISION 5 — object pipeline ════════════════════════ */

test('OBJECT PIPELINE (DECISION 5): candidate → discovery → schema → capability, stopping at the first unmet step; a verified object with no reader is still UNAVAILABLE, never PASS', async () => {
  const meta = platformMeta({ tables: { chg_model: { fields: ['name', 'type', 'active'] }, cab_meeting: { fields: ['start'] } } });
  const ctx = createEvaluationContext({ client: fakeInstance({ ...meta, chg_model: [], cab_meeting: [] }, { absent: ['sysrule_assignment'] }), now: NOW });
  const entry = (id) => RULES.ITSM_RULE_CONFIGS.get(id);
  const noCandidate = await evaluateConfiguredRule(entry('ITSM-045'), ctx);            // major_incident: candidate null
  assert.equal(noCandidate.status, 'unavailable');
  assert.match(noCandidate.skipped[0].reason, /stopped at: candidate/);
  const notOnInstance = await evaluateConfiguredRule(entry('ITSM-029'), ctx);          // sysrule_assignment absent (a VERIFIED reader's table)
  assert.equal(notOnInstance.status, 'unavailable');
  assert.match(notOnInstance.skipped[0].reason, /stopped at: table_discovery/);
  assert.equal(notOnInstance.blocker.step, 'table_discovery');
  const evaluatorGap = await evaluateConfiguredRule(entry('ITSM-004'), ctx);            // the object is verified elsewhere; the EVALUATOR is what is undefined
  assert.equal(evaluatorGap.blocker.kind, 'undefined_dependency');
  const schemaShort = await evaluateConfiguredRule(entry('ITSM-082'), ctx);            // cab_meeting exists, lacks end/state
  assert.equal(schemaShort.status, 'unavailable');
  assert.match(schemaShort.skipped[0].reason, /stopped at: schema_verification/);
  const verified = await evaluateConfiguredRule(entry('ITSM-087'), ctx);               // chg_model fully verified — but no reader (what a change model REQUIRES per state is UNDEFINED)
  assert.equal(verified.status, 'unavailable');
  assert.match(verified.skipped[0].reason, /verified as usable, but no established reader/);
  assert.deepEqual([verified.blocker.kind, verified.blocker.step], ['undefined_object', 'reader']);
  assert.equal(verified.findings.length, 0);
  const forbidden = createEvaluationContext({ client: fakeInstance({ ...meta, chg_model: [] }, { forbidden: ['chg_model'] }), now: NOW });
  const noRead = await evaluateConfiguredRule(entry('ITSM-087'), forbidden);
  assert.match(noRead.skipped[0].reason, /stopped at: capability_confirmation/);
  assert.equal(noRead.blocker.step, 'capability_confirmation');
  /* A VERIFIED reader runs the same pipeline at read time: absent table → unavailable with the step, never an empty read. */
  assert.deepEqual(Object.keys(VERIFIED_OBJECTS).sort(), ['assignment_rule', 'cab', 'notification', 'priority_matrix']);
  const noMatrix = await evaluateConfiguredRule(entry('ITSM-005'), createEvaluationContext({ client: fakeInstance({ ...meta }, { absent: ['dl_u_priority'] }), now: NOW }));
  assert.equal(noMatrix.status, 'unavailable');
  assert.equal(noMatrix.blocker.kind, 'undefined_object');
  assert.match(noMatrix.skipped[0].reason, /table_discovery/);
});

/* ════════════════════════ DECISION 9 — schedules ════════════════════════ */

test('SCHEDULES (DECISION 9): once, daily, weekly and weekdays expand to concrete UTC intervals in the schedule\'s zone, clipped to the window; monthly / yearly / floating are unavailable, never "no blackout"', () => {
  const window = { start: new Date('2026-03-01T00:00:00Z'), end: new Date('2026-03-31T23:59:59Z') };
  const once = SCH.expandSpan({ sys_id: 's', start_date_time: '2026-03-10 22:00:00', end_date_time: '2026-03-11 02:00:00', repeat_type: '' }, { window, timeZone: 'Europe/London' });
  assert.equal(once.status, 'ok');
  assert.deepEqual([once.intervals[0].start_snow, once.intervals[0].end_snow], ['2026-03-10 22:00:00', '2026-03-11 02:00:00'], 'GMT in March before the DST switch');
  const dst = SCH.expandSpan({ start_date_time: '2026-03-30 22:00:00', end_date_time: '2026-03-31 02:00:00', repeat_type: '' }, { window, timeZone: 'Europe/London' });
  assert.deepEqual([dst.intervals[0].start_snow, dst.intervals[0].end_snow], ['2026-03-30 21:00:00', '2026-03-31 01:00:00'], 'BST after the switch: local 22:00 is 21:00 UTC');
  const daily = SCH.expandSpan({ start_date_time: '2026-01-01 01:00:00', end_date_time: '2026-01-01 03:00:00', repeat_type: 'daily' }, { window, timeZone: 'UTC' });
  assert.equal(daily.status, 'ok');
  assert.equal(daily.intervals.length, 31, 'one occurrence per day of March, none from January / February');
  assert.equal(daily.intervals[0].start_snow, '2026-03-01 01:00:00');
  assert.equal(daily.intervals.at(-1).start_snow, '2026-03-31 01:00:00');
  const every3 = SCH.expandSpan({ start_date_time: '2026-03-01 01:00:00', end_date_time: '2026-03-01 03:00:00', repeat_type: 'daily', repeat_count: '3' }, { window, timeZone: 'UTC' });
  assert.deepEqual(every3.intervals.slice(0, 3).map((i) => i.start_snow), ['2026-03-01 01:00:00', '2026-03-04 01:00:00', '2026-03-07 01:00:00']);
  const weekly = SCH.expandSpan({ start_date_time: '2026-03-02 09:00:00', end_date_time: '2026-03-02 10:00:00', repeat_type: 'weekly', days_of_week: '15' }, { window, timeZone: 'UTC' });
  assert.deepEqual(weekly.intervals.map((i) => i.occurrence.dow), weekly.intervals.map(() => 1).map((_, i) => (i % 2 === 0 ? 1 : 5)), 'Mondays and Fridays, 1 = Monday convention');
  assert.equal(weekly.intervals.length, 9, 'Mon 2,9,16,23,30 + Fri 6,13,20,27');
  const weekdays = SCH.expandSpan({ start_date_time: '2026-03-02 09:00:00', end_date_time: '2026-03-02 10:00:00', repeat_type: 'weekdays' }, { window, timeZone: 'UTC' });
  assert.equal(weekdays.intervals.length, 22);
  assert.ok(weekdays.intervals.every((i) => i.occurrence.dow <= 5));
  /* Window boundary: a span ending exactly at the window start is inside; one starting after the end is out. */
  const touching = SCH.expandSpan({ start_date_time: '2026-02-28 22:00:00', end_date_time: '2026-03-01 00:00:00', repeat_type: '' }, { window, timeZone: 'UTC' });
  assert.equal(touching.intervals.length, 1);
  const outside = SCH.expandSpan({ start_date_time: '2026-04-01 00:00:01', end_date_time: '2026-04-01 02:00:00', repeat_type: '' }, { window, timeZone: 'UTC' });
  assert.equal(outside.intervals.length, 0);
  const until = SCH.expandSpan({ start_date_time: '2026-03-01 01:00:00', end_date_time: '2026-03-01 03:00:00', repeat_type: 'daily', repeat_until: '2026-03-05' }, { window, timeZone: 'UTC' });
  assert.equal(until.intervals.length, 5);
  /* Not expanded: monthly / yearly / bad zone / floating. */
  assert.equal(SCH.expandSpan({ start_date_time: '2026-03-01 01:00:00', end_date_time: '2026-03-01 03:00:00', repeat_type: 'monthly' }, { window, timeZone: 'UTC' }).status, 'unsupported');
  assert.equal(SCH.expandSpan({ start_date_time: '2026-03-01 01:00:00', end_date_time: '2026-03-01 03:00:00', repeat_type: 'yearly' }, { window, timeZone: 'UTC' }).status, 'unsupported');
  assert.equal(SCH.expandSpan({ start_date_time: '2026-03-01 01:00:00', end_date_time: '2026-03-01 03:00:00', repeat_type: '' }, { window, timeZone: 'Mars/Olympus' }).status, 'unsupported');
  assert.equal(SCH.expandSpan({ start_date_time: '', end_date_time: '', repeat_type: '' }, { window, timeZone: 'UTC' }).status, 'invalid');
  const floating = SCH.expandSchedule({ sys_id: 'f', name: 'floating', time_zone: '', spans: [{ start_date_time: '2026-03-01 01:00:00', end_date_time: '2026-03-01 03:00:00', repeat_type: '' }] }, { window });
  assert.equal(floating.status, 'unavailable');
  const mixed = SCH.expandSchedule({ sys_id: 'm', name: 'mixed', time_zone: 'UTC', spans: [{ start_date_time: '2026-03-01 01:00:00', end_date_time: '2026-03-01 03:00:00', repeat_type: '' }, { start_date_time: '2026-03-01 01:00:00', end_date_time: '2026-03-01 03:00:00', repeat_type: 'monthly' }] }, { window });
  assert.equal(mixed.status, 'unavailable', 'one unexpandable span makes the whole schedule unavailable');
  assert.deepEqual(mixed.intervals, []);
});

/* ════════════════════════ the runner ════════════════════════ */

test('RUNNER: dependency order, transitive inputs, variants merged, an engine fault is `error` (never a pass), and results land in ctx.results for composites', async () => {
  const plan = planRules(['ITSM-125']);
  assert.deepEqual(plan.map((r) => r.id), ['ITSM-123', 'ITSM-125']);
  const ctx = estateContext();
  const run = await runITSMRules(ctx, { ruleIds: ['ITSM-125', 'ITSM-037', 'ITSM-134'] });
  assert.ok(run.order.indexOf('ITSM-123') < run.order.indexOf('ITSM-125'));
  assert.ok(run.order.indexOf('ITSM-018') < run.order.indexOf('ITSM-134'));
  const v = run.results.get('ITSM-037');
  assert.equal(v.status, 'evaluated');
  assert.deepEqual(v.variants.map((x) => [x.variant, x.status]), [['P1', 'evaluated'], ['P2', 'evaluated'], ['P3', 'evaluated'], ['P4', 'unconfigured'], ['P5', 'unconfigured']], 'P4/P5 ages are UNDEFINED in the workbook');
  assert.ok(v.skipped.some((s) => /p4_age is UNCONFIGURED/.test(s.reason)));
  assert.equal(ctx.results.get('ITSM-123').status, 'evaluated');
  /* A throwing engine → error, caught per rule. */
  const broken = { id: 'ITSM-020', engine: 'record_predicate', config: { table: 'incident', predicates: [{ field: 'close_notes', op: 'length_lt', value: -1 }] } };
  const err = await evaluateConfiguredRule(broken, estateContext());
  assert.equal(err.status, 'error');
  assert.equal(err.findings.length, 0);
  assert.match(err.skipped[0].reason, /engine error/);
});

test('RUNNER: all 139 rules run against the estate with no engine error; every non-evaluated rule names its reason; nothing is a silent pass', async () => {
  const ctx = estateContext();
  const run = await runITSMRules(ctx);
  assert.equal(run.results.size, 139);
  assert.equal(run.summary.error ?? 0, 0, JSON.stringify([...run.results.values()].filter((r) => r.status === 'error').map((r) => [r.rule_id, r.skipped[0]?.reason])));
  for (const r of run.results.values()) {
    if (r.status !== 'evaluated') { assert.ok(r.skipped.length > 0 && r.skipped[0].reason, `${r.rule_id} ${r.status} without a reason`); assert.equal(r.findings.length, 0); }
  }
  assert.ok(run.summary.evaluated >= 60, `only ${run.summary.evaluated} evaluated`);
  assert.ok(run.summary.unconfigured >= 20 && run.summary.unavailable >= 35, JSON.stringify(run.summary));
  /* every result carries the closure fields: a blocker when not evaluated, a verdict when evaluated, an explanation always */
  for (const r of run.results.values()) {
    if (r.status === 'evaluated') { assert.ok(['pass', 'fail', 'inconclusive'].includes(r.verdict), `${r.rule_id} verdict ${r.verdict}`); assert.equal(r.blocker, null); }
    else { assert.ok(r.blocker && r.blocker.kind, `${r.rule_id} has no blocker`); assert.equal(r.verdict, null); }
    if (r.explanation) assert.equal(r.explanation.rule_id, r.rule_id);
  }
  assert.ok(run.verdicts.inconclusive >= 1, 'partial-scope rules with no finding are inconclusive, not pass');
  assert.ok(run.elapsed_ms < 5000, `${run.elapsed_ms} ms`);
});

test('RUNNER: $choice values come from the instance (an unmatched label is UNAVAILABLE); a rule whose only gap is a parameter becomes evaluable through a runtime override without touching the registry', async () => {
  const noRetired = estateContext({ sys_choice: ESTATE.sys_choice.filter((c) => c.sys_id !== 'ch-ci-retired') });
  const r = await evaluateConfiguredRule(RULES.ITSM_RULE_CONFIGS.get('ITSM-019'), noRetired);
  assert.equal(r.status, 'unavailable');
  assert.match(r.skipped[0].reason, /no choice\(s\) labelled "Retired"/);
  const withOverride = estateContext({}, { runtimeParameters: { 'ITSM-023': { volume_share: 40 } } });
  const f = await evaluateConfiguredRule(RULES.ITSM_RULE_CONFIGS.get('ITSM-023'), withOverride);
  assert.equal(f.status, 'evaluated');
  assert.equal(f.parameters.parameters.volume_share.source, 'runtime');
  assert.equal(ITSM_PARAMETERS.resolve('ITSM-023').status, PARAMETER_STATUS.UNCONFIGURED, 'the app registry was not mutated');
});
