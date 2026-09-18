import { modifiersFor, lineageOf, dqActive, cisForRule, DQ_INACTIVE_INSTALL_STATUS, CLASS_TIERS, consequenceOf, CONSEQUENCE_REDUCED_BAND } from './cmdb-signals.js';
import { parseDate } from './time.js';

/**
 * GROUP 12 — CONSUMPTION AND TRUST (D10). CMDB-116 to CMDB-123.
 *
 * THE DIMENSION THAT ASKS WHETHER ANYBODY USES IT. Every other dimension judges
 * the records; D10 judges whether the rest of ServiceNow reaches for them. A
 * CMDB nobody consults is not a data-quality problem — it is the whole problem,
 * expressed as silence.
 *
 * ═══ D10 IS SHARED, AND THIS GROUP COMPLETES IT ═══
 *
 * Four rules already contribute to D10 from Group 11 (CMDB-109, 110, 113, 114 —
 * records) and CMDB-141 contributes the gating impact-analysis KPI. Group 12
 * ADDS to that set; it does not replace it. The dimension blends its record mean
 * with its KPI mean, so:
 *
 *   records  CMDB-121 joins CMDB-109/110/113/114
 *   KPIs     CMDB-117, CMDB-118, CMDB-123 join CMDB-141
 *
 * No rule here re-derives what another already charged. CMDB-121 asks whether a
 * CI is REFERENCED BY WORK; CMDB-115 (posture) asks whether it is in the service
 * model; CMDB-105 asks whether anybody owns it. The same CI can fail all three,
 * and each is a different question about it — but none of them counts another's
 * defect a second time.
 *
 * ═══ TRACKS, WHICH ARE NOT UNIFORM HERE EITHER ═══
 *
 *   scored D10      CMDB-117, CMDB-118, CMDB-121, CMDB-123 (and CMDB-141)
 *   context only    CMDB-116, CMDB-119, CMDB-120, CMDB-122 — shown, never scored
 *
 * CMDB-116 is the trust score itself, and it is `derived`: it is computed FROM
 * the composite, so letting it charge the composite would be a number marking
 * its own homework. It is displayed with its three variants and deducts nothing.
 * `CONSUMPTION_TRACKS` declares all of this and `trackMisroutes` checks it every
 * run, the same guard Group 11 introduced.
 *
 * ═══ WHAT THIS INSTANCE KEEPS (verified on dev424910, Sep 2026) ═══
 *
 *   86 incidents, 26 naming a CI and ONE naming a business service. 77 changes
 *   and 18 problems name a CI. `task_cmdb_ci_service` is EMPTY, which is why
 *   CMDB-141 measures 0%.
 *
 *   THE ITSM TABLES ARE NOT READ BY A CMDB-ONLY SCAN. CMDB-117, 118 and 121 all
 *   depend on them, and say so rather than reporting a clean result — the same
 *   discipline as CMDB-084.
 *
 *   No custom class extends cmdb_ci (the five `u_cmdb_qb_result_*` tables are
 *   Query Builder output, not CI classes), and no custom `u_` attribute exists
 *   on any CMDB class, so CMDB-119, CMDB-120 and CMDB-123 evaluate clean.
 *
 * PURE — no network, no database.
 */

export const CONSUMPTION_RULES = Object.freeze([
  'CMDB-116', 'CMDB-117', 'CMDB-118', 'CMDB-119', 'CMDB-120', 'CMDB-121', 'CMDB-122', 'CMDB-123',
]);

/** Declared tracks, checked against the catalogue every run. */
export const CONSUMPTION_TRACKS = Object.freeze({
  'CMDB-117': { scored: true, dimension: 'D10' },
  'CMDB-118': { scored: true, dimension: 'D10' },
  'CMDB-121': { scored: true, dimension: 'D10' },
  'CMDB-123': { scored: true, dimension: 'D10' },
  'CMDB-141': { scored: true, dimension: 'D10' },
  'CMDB-116': { scored: false },
  'CMDB-119': { scored: false },
  'CMDB-120': { scored: false },
  'CMDB-122': { scored: false },
});

export const CONSUMPTION_DEFAULTS = Object.freeze({
  dqInactiveInstallStatus: DQ_INACTIVE_INSTALL_STATUS,
  /*
   * CMDB-117 / CMDB-118 — how much of the work names what it is about.
   *
   * THE WINDOW IS A PER-ESTATE PARAMETER, and it decides the answer. Measured on
   * dev424910: 26 incidents name a CI across all time and NONE of the 19 raised
   * in the last 90 days does. Both numbers are true; only one of them is about
   * the window somebody chose.
   *
   * THE FLOOR IS WHY THE RULE ABSTAINS. A 60% threshold against 19 records
   * swings 5 points per incident, so it is measuring the denominator rather than
   * the practice. Below the floor the rule says it cannot compute a reliable
   * ratio, and publishes no KPI — an unreliable number in a scored dimension is
   * worse than an absent one.
   */
  incidentServicePct: 60,
  incidentCiPct: 50,
  consumptionWindowDays: 90,
  minConsumptionVolume: 30,
  /* CMDB-121 — a CI no ticket has mentioned in this long is not being consumed. */
  taskWindowDays: 365,
  taskTables: Object.freeze(['incident', 'change_request', 'problem']),
  /* CMDB-120 — depth from cmdb_ci at which a class tree is too deep to reason about. */
  maxClassDepth: 6,
  /* CMDB-122 — a class this small is a modelling decision, not a population. */
  sparseClassMax: 5,
  /* CMDB-123 — a custom attribute below this population rate is dead weight. */
  customFieldPopulatedPct: 5,
  /* CMDB-119 — how much attribute overlap makes a custom class a duplicate. */
  classOverlapPct: 70,
  classTiers: CLASS_TIERS,
});

const DAY_MS = 86_400_000;
const pct1 = (n) => Number(n.toFixed(1));
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const val = (r, f) => String(r?.[f] ?? '').trim();

export function cmdbConsumptionRules(ctx, options = {}) {
  const opt = { ...CONSUMPTION_DEFAULTS, ...options };
  const now = ctx.now;
  const meta = ctx.meta?.cmdb || {};
  const signals = ctx.signals;
  const skip = (rule, table, reason) => ctx.skipped.push({ rule, table, reason });
  const hierarchyOk = meta.reads?.class_hierarchy?.status === 'ok';
  const line = (cls) => lineageOf(meta, cls || 'cmdb_ci');
  const inClasses = (c, classes) => (hierarchyOk ? line(c.sys_class_name).some((t) => (classes || []).includes(t)) : (classes || []).includes(c.sys_class_name));
  const allCis = ctx.estate.cmdb_ci || [];
  const { active: activeCis } = dqActive(allCis, opt.dqInactiveInstallStatus);
  const cisFor = (rule) => cisForRule(rule, { all: allCis, active: activeCis });
  const label = (c) => `${c.sys_class_name} "${c.name || c.sys_id}"`;
  const fact = (table, field, value, reason) => ({
    source: 'ServiceNow Table/Aggregate REST API', sn_table: table, sn_sys_id: null,
    field_name: field, field_value: String(value), reason, collected_at: now.toISOString(),
  });
  const consumption = (rule, table, records, fields, description, extra = {}) => {
    const m = modifiersFor(records, signals);
    return ctx.addCatalogued(rule, table, records, fields, description, {
      agent: 'cmdb_agent', escalators: m.escalators, deEscalators: m.deEscalators, notEvaluated: m.notEvaluated, ...extra,
    });
  };
  ctx.measures ||= {};

  const ciOk = ctx.complete('cmdb_ci', ['sys_class_name']);
  if (!ciOk) {
    for (const r of CONSUMPTION_RULES) skip(r, 'cmdb_ci', 'The CIs were not read completely — a consumption rule over a partial estate reports our own access rather than what the platform uses');
    return;
  }

  /* ═══ The ITSM side, which a CMDB-only scan does not read ═══════════════ */
  const readTaskTables = opt.taskTables.filter((t) => ctx.complete(t, ['sys_id']));
  const itsmNote = `None of ${opt.taskTables.join(', ')} was read in this scan. A CMDB-only scan does not read ITSM — run a full scan, or include the ITSM module, for this rule. Reporting a clean result from tables nobody opened would be the worst possible answer here, because this dimension measures whether the platform uses the CMDB at all.`;

  /* ── CMDB-117 / CMDB-118 — does the work name what it is about ─────────── */
  if (!readTaskTables.includes('incident')) {
    for (const r of ['CMDB-117', 'CMDB-118']) skip(r, 'incident', itsmNote);
  } else {
    const cutoff = now.getTime() - opt.consumptionWindowDays * DAY_MS;
    const incidents = (ctx.estate.incident || []).filter((i) => {
      const d = parseDate(i.sys_created_on) || parseDate(i.opened_at);
      return !d || d.getTime() >= cutoff;
    });
    const everWithCi = (ctx.estate.incident || []).filter((i) => val(i, 'cmdb_ci')).length;
    if (!incidents.length) {
      for (const r of ['CMDB-117', 'CMDB-118']) skip(r, 'incident', `No incident was raised in the last ${opt.consumptionWindowDays} days, so there is no consumption to measure — an estate with no incidents is not one that fails to reference CIs`);
    } else if (incidents.length < opt.minConsumptionVolume) {
      /* ABSTAIN, and say which parameter decided it. */
      for (const r of ['CMDB-117', 'CMDB-118']) {
        skip(r, 'incident', `NOT MEASURED — insufficient volume in the window to compute a reliable ratio: ${incidents.length} incident(s) in the last ${opt.consumptionWindowDays} days, against a floor of ${opt.minConsumptionVolume}. At this volume one incident moves the ratio by ${pct1(100 / incidents.length)} points, so the number would describe the denominator rather than the practice. Both parameters are per-estate: widen consumptionWindowDays or lower minConsumptionVolume to measure a quieter estate. For context, ${everWithCi} incident(s) reference a CI across ALL time.`);
      }
    } else {
      const withService = incidents.filter((i) => val(i, 'business_service')).length;
      const withCi = incidents.filter((i) => val(i, 'cmdb_ci')).length;
      ctx.measures.consumption = {
        window_days: opt.consumptionWindowDays,
        incidents: incidents.length,
        with_business_service: withService,
        with_ci: withCi,
      };
      for (const [rule, hit, threshold, what] of [
        ['CMDB-117', withService, opt.incidentServicePct, 'a Business Service'],
        ['CMDB-118', withCi, opt.incidentCiPct, 'any CI'],
      ]) {
        const passPct = (100 * hit) / incidents.length;
        ctx.kpis.push({
          rule_id: rule,
          pass_pct: passPct,
          numerator: hit,
          denominator: incidents.length,
          basis: `incidents raised in the last ${opt.consumptionWindowDays} days that reference ${what}`,
        });
        if (passPct >= threshold) continue;
        consumption(rule, 'incident', [], ['number'],
          `${hit.toLocaleString('en-US')} of ${incidents.length.toLocaleString('en-US')} incidents (${pct1(passPct)}%) in the last ${opt.consumptionWindowDays} days reference ${what}, below the ${threshold}% threshold. The people doing the work are not reaching for the CMDB when they record it, so nothing downstream — impact, trend, problem correlation — can be computed from what they wrote.\n\nMEASURED OVER a ${opt.consumptionWindowDays}-day window with a ${opt.minConsumptionVolume}-incident floor, both per-estate parameters. ${everWithCi.toLocaleString('en-US')} incident(s) reference a CI across all time — if that is far above what this window shows, the window is what you are reading.`,
          { confidence: 1.0,
            evidence: [
              fact('incident', what === 'any CI' ? 'cmdb_ci' : 'business_service', `${hit} of ${incidents.length}`, `${pct1(passPct)}% over ${opt.consumptionWindowDays} days`),
              fact('incident', 'window and floor', `${opt.consumptionWindowDays} days, minimum ${opt.minConsumptionVolume}`, 'per-estate parameters that decide this ratio'),
              fact('incident', 'CI references across all time', everWithCi, 'context for whether the window is the finding'),
            ],
            guard: { evaluated: false, note: what === 'any CI' ? 'Service-desk categories where a CI reference is not meaningful (HR, facilities) drag this down legitimately — scope by category before acting.' : 'An estate that does not use service-based incident management by design will look like this.' } });
      }
    }
  }

  /* ── CMDB-121 — a CI no work has ever mentioned (scored) ───────────────── */
  if (!readTaskTables.length) {
    skip('CMDB-121', 'incident', itsmNote);
  } else {
    const cutoff = now.getTime() - opt.taskWindowDays * DAY_MS;
    const referenced = new Set();
    for (const t of readTaskTables) {
      for (const row of ctx.estate[t] || []) {
        const d = parseDate(row.sys_created_on) || parseDate(row.opened_at);
        if (d && d.getTime() < cutoff) continue;
        if (row.cmdb_ci) referenced.add(row.cmdb_ci);
      }
    }
    const scope = cisFor('CMDB-121');
    const unused = scope.filter((c) => !referenced.has(c.sys_id));
    /*
     * CONSEQUENCE SCOPING, inherited (see cmdb-signals.js). "Nothing has ever
     * ticketed this CI" is near-universal on most estates, so the charge is
     * carried by the CIs where silence matters — a database nobody has raised a
     * ticket against in a year is a different fact from a laptop nobody has.
     */
    const verdicts = new Map();
    for (const c of unused) {
      const verdict = consequenceOf(c, { signals, inClasses, tiers: opt.classTiers });
      verdicts.set(c.sys_id, verdict);
      const f = consumption('CMDB-121', 'cmdb_ci', [c], ['name', 'sys_class_name'],
        `${label(c)} has not been referenced by any ${readTaskTables.join(', ')} record in ${opt.taskWindowDays} days. Nothing has broken on it, nothing has been changed on it, and nobody has asked about it — so nothing outside the CMDB has confirmed it is still there or still matters.`,
        { confidence: 1.0,
          evidence: [
            fact(readTaskTables[0], 'task references', 0, `across ${readTaskTables.join(', ')} in ${opt.taskWindowDays} days`),
            fact('cmdb_ci', 'consequence', verdict.level, verdict.why),
          ],
          guard: { evaluated: false, note: 'Infrastructure that legitimately never generates tickets — a stable appliance, a spare — looks identical. Absence of work is not absence of value.' } });
      if (verdict.level === 'reduced') {
        f.deduction_band_override = CONSEQUENCE_REDUCED_BAND;
        if (f.deduction_severity !== 'SYSTEMIC') f.deduction_severity = CONSEQUENCE_REDUCED_BAND;
        f.deduction_note = `Charged at ${CONSEQUENCE_REDUCED_BAND} rather than ${f.base_severity}: ${verdict.why}. Reported in full either way.`;
      }
    }
    ctx.measures.consumption_coverage = {
      in_scope: scope.length,
      referenced: scope.length - unused.length,
      unreferenced: unused.length,
      window_days: opt.taskWindowDays,
      tables: [...readTaskTables],
      full_consequence: [...verdicts.values()].filter((v) => v.level === 'full').length,
      reduced_consequence: [...verdicts.values()].filter((v) => v.level === 'reduced').length,
    };
    if (unused.length) {
      const byClass = [...unused.reduce((m, c) => m.set(c.sys_class_name, (m.get(c.sys_class_name) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
      const share = (100 * unused.length) / (scope.length || 1);
      const head = ctx.addCatalogued('CMDB-121', 'cmdb_ci', [], ['sys_class_name'],
        `${unused.length.toLocaleString('en-US')} of ${scope.length.toLocaleString('en-US')} in-scope CIs (${pct1(share)}%) have not been referenced by any work in ${opt.taskWindowDays} days. Worst: ${byClass.slice(0, 4).map(([cls, n]) => `${cls} (${n.toLocaleString('en-US')})`).join(', ')}. ${ctx.measures.consumption_coverage.full_consequence.toLocaleString('en-US')} carry operational consequence; ${ctx.measures.consumption_coverage.reduced_consequence.toLocaleString('en-US')} are leaf or non-production and charged at ${CONSEQUENCE_REDUCED_BAND}. Raised once so the scale is visible without counting rows; it deducts nothing itself.`,
        { agent: 'cmdb_agent',
          evidence: [
            fact('cmdb_ci', 'unreferenced', `${unused.length} of ${scope.length}`, `no task reference in ${opt.taskWindowDays} days`),
            fact('incident', 'tables checked', readTaskTables.join(', '), readTaskTables.length < opt.taskTables.length ? `only ${readTaskTables.length} of ${opt.taskTables.length} task tables were read` : 'all task tables were read'),
            ...byClass.slice(0, 15).map(([cls, n]) => fact('cmdb_ci', cls, `${n} unreferenced`, 'by class')),
          ],
          guard: { evaluated: false, note: 'A young estate, or one whose work is recorded outside ServiceNow, will look like this. Check where the work actually lives before acting.' } });
      head.unscored_reason = 'the estate-wide headline — the records it counts are charged individually, scoped by consequence';
      head.grouped_classes = byClass.map(([cls, n]) => ({ cls, cis: n }));
    } else {
      skip('CMDB-121', 'cmdb_ci', `Every in-scope CI has been referenced by work within ${opt.taskWindowDays} days — evaluated, with nothing to report`);
    }
  }

  /* ═══ The class model itself — context, never scored ════════════════════ */
  const classes = meta.classes?.byName || {};
  const classNames = Object.keys(classes);
  const populated = new Map();
  for (const c of allCis) populated.set(c.sys_class_name, (populated.get(c.sys_class_name) || 0) + 1);

  /* ── CMDB-119 — a custom class that duplicates an out-of-box one ───────── */
  const isCustom = (name) => /^u_/i.test(name);
  const customCiClasses = classNames.filter((n) => isCustom(n) && line(n).includes('cmdb_ci'));
  if (!classNames.length) {
    for (const r of ['CMDB-119', 'CMDB-120']) skip(r, 'sys_db_object', 'The class hierarchy was not read, so the class model cannot be examined');
  } else if (!customCiClasses.length) {
    skip('CMDB-119', 'sys_db_object', `No custom class extends cmdb_ci on this instance — evaluated, with nothing to report. Custom tables that do NOT extend cmdb_ci (Query Builder result tables, for example) are not CI classes and are out of scope.`);
  } else if (!meta.fieldTables && !(meta.customFields || []).length) {
    /*
     * A PARTIAL SIGNATURE WOULD BE WORSE THAN NONE. The overlap percentage is
     * the whole finding, and computing it from a subset of each class's
     * attributes would produce a confident number that is simply wrong. The
     * extract reads custom attributes and the attribute-to-table map; where
     * neither is available the rule declines.
     */
    skip('CMDB-119', 'sys_dictionary', `${customCiClasses.length} custom CI class(es) exist, but no attribute signature could be read for them — and an overlap percentage computed from a partial signature would be confidently wrong rather than unavailable. Needs the dictionary slice this scan did not get.`);
  } else {
    /* Signatures from the attribute-to-table map plus the custom-field slice. */
    const fieldTables = meta.fieldTables || {};
    const customFields = meta.customFields || [];
    const attrsOf = (cls) => {
      const out = new Set();
      for (const [attr, tables] of Object.entries(fieldTables)) if ((tables || []).includes(cls)) out.add(attr);
      for (const d of customFields) if (val(d, 'name') === cls) out.add(val(d, 'element'));
      return out;
    };
    const oob = classNames.filter((n) => !isCustom(n) && line(n).includes('cmdb_ci'));
    let duplicates = 0;
    for (const cls of customCiClasses) {
      const mine = attrsOf(cls);
      if (!mine.size || !(populated.get(cls) > 0)) continue;
      let best = null;
      for (const other of oob) {
        if (!(populated.get(other) > 0)) continue;
        const theirs = attrsOf(other);
        if (!theirs.size) continue;
        const shared = [...mine].filter((a) => theirs.has(a)).length;
        const overlap = (100 * shared) / mine.size;
        if (!best || overlap > best.overlap) best = { other, overlap, shared };
      }
      if (!best || best.overlap < opt.classOverlapPct) continue;
      duplicates += 1;
      consumption('CMDB-119', 'cmdb_ci', [], ['sys_class_name'],
        `The custom class ${cls} (${(populated.get(cls) || 0).toLocaleString('en-US')} CIs) shares ${pct1(best.overlap)}% of its attributes with the out-of-box class ${best.other} (${(populated.get(best.other) || 0).toLocaleString('en-US')} CIs), and both are populated. The same kind of thing is being recorded in two places, so every rule, report and identification rule has to know about both.`,
        { confidence: 0.8,
          evidence: [fact('sys_dictionary', cls, `${best.shared} of ${mine.size} attributes also on ${best.other}`, `${pct1(best.overlap)}% overlap`)],
          guard: { evaluated: false, note: 'A custom class with a genuinely distinct purpose can share most of its attribute signature with an OOB class. Attribute overlap is a signal, not proof — which is why this is context rather than a charge.' } });
    }
    if (!duplicates) {
      skip('CMDB-119', 'sys_dictionary', `${customCiClasses.length} custom CI class(es) were compared against the out-of-box classes and none shares ${opt.classOverlapPct}% or more of its attributes with a populated one — evaluated, with nothing to report`);
    }
  }

  /* ── CMDB-120 — a class tree too deep to reason about ──────────────────── */
  if (classNames.length) {
    const depthOf = (cls) => Math.max(0, line(cls).indexOf('cmdb_ci'));
    const deep = customCiClasses.filter((n) => depthOf(n) > opt.maxClassDepth)
      .map((n) => ({ cls: n, depth: depthOf(n), cis: populated.get(n) || 0 }))
      .sort((a, b) => b.depth - a.depth);
    if (deep.length) {
      consumption('CMDB-120', 'cmdb_ci', [], ['sys_class_name'],
        `${deep.length} custom class(es) extend more than ${opt.maxClassDepth} levels below cmdb_ci: ${deep.slice(0, 4).map((d) => `${d.cls} (${d.depth})`).join(', ')}. Every query against a deep tree walks every level, and every rule that scopes by class has to decide where in the chain it means.`,
        { confidence: 1.0,
          evidence: deep.slice(0, 10).map((d) => fact('sys_db_object', d.cls, `${d.depth} levels`, `${d.cis} CI(s)`)),
          guard: { evaluated: true, note: `Only CUSTOM classes are judged: ServiceNow itself ships hierarchies deeper than ${opt.maxClassDepth}, and marking an estate down for the vendor's own model would be wrong.` } });
    } else {
      skip('CMDB-120', 'sys_db_object', `No custom CI class extends more than ${opt.maxClassDepth} levels below cmdb_ci — evaluated, with nothing to report. Deep OOB hierarchies that ServiceNow itself ships are excluded by design.`);
    }
  }

  /* ── CMDB-122 — a class with almost nothing in it ──────────────────────── */
  const sparse = [...populated.entries()].filter(([, n]) => n >= 1 && n <= opt.sparseClassMax).sort((a, b) => a[1] - b[1]);
  if (sparse.length) {
    consumption('CMDB-122', 'cmdb_ci', [], ['sys_class_name'],
      `${sparse.length} class(es) hold between 1 and ${opt.sparseClassMax} CIs: ${sparse.slice(0, 6).map(([cls, n]) => `${cls} (${n})`).join(', ')}. Each one is a class somebody decided to model and then did not populate — either the population is missing, or the class is. Shown for context: a genuinely rare CI type is not a defect, which is why this deducts nothing.`,
      { confidence: 1.0,
        evidence: sparse.slice(0, 20).map(([cls, n]) => fact('cmdb_ci', cls, `${n} CI(s)`, `at or below the sparse threshold of ${opt.sparseClassMax}`)),
        guard: { evaluated: false, note: 'A mainframe, a single specialised appliance, one load balancer — genuinely rare CI types look exactly like an abandoned class.' } });
  } else {
    skip('CMDB-122', 'cmdb_ci', `No class holds between 1 and ${opt.sparseClassMax} CIs — evaluated, with nothing to report`);
  }

  /* ── CMDB-123 — custom attributes nobody fills in (scored KPI) ─────────── */
  const customRead = meta.reads?.custom_fields?.status === 'ok' || Array.isArray(meta.customFields);
  const customFields = (meta.customFields || []).filter((d) => val(d, 'name').startsWith('cmdb') && !isCustom(val(d, 'name')));
  if (!customRead) {
    skip('CMDB-123', 'sys_dictionary', 'The custom-attribute slice of the dictionary was not read, so custom attributes on out-of-box classes cannot be found — and reporting none would say there are none');
  } else if (!customFields.length) {
    skip('CMDB-123', 'sys_dictionary', 'No custom attribute has been added to any out-of-box CMDB class — evaluated, with nothing to report');
  } else {
    const rate = (field, cls) => {
      const members = allCis.filter((c) => line(c.sys_class_name).includes(cls));
      if (!members.length) return null;
      return (100 * members.filter((c) => val(c, field)).length) / members.length;
    };
    const measured = customFields.map((d) => ({ field: val(d, 'element'), cls: val(d, 'name'), pct: rate(val(d, 'element'), val(d, 'name')) }))
      .filter((x) => x.pct != null);
    if (!measured.length) {
      skip('CMDB-123', 'sys_dictionary', 'Custom attributes exist but none of their classes is populated, so no population rate can be computed');
    } else {
      const dead = measured.filter((x) => x.pct < opt.customFieldPopulatedPct);
      const passPct = (100 * (measured.length - dead.length)) / measured.length;
      ctx.kpis.push({
        rule_id: 'CMDB-123',
        pass_pct: passPct,
        numerator: measured.length - dead.length,
        denominator: measured.length,
        basis: `custom attributes on out-of-box CMDB classes populated on at least ${opt.customFieldPopulatedPct}% of their class's CIs`,
      });
      if (dead.length) {
        consumption('CMDB-123', 'cmdb_ci', [], ['sys_class_name'],
          `${dead.length} of ${measured.length} custom attribute(s) on out-of-box classes are populated on fewer than ${opt.customFieldPopulatedPct}% of their CIs: ${dead.slice(0, 4).map((x) => `${x.cls}.${x.field} (${pct1(x.pct)}%)`).join(', ')}. Somebody extended the model for a purpose that never arrived, and every form, import and integration now carries a field nobody fills in.`,
          { confidence: 1.0,
            evidence: dead.slice(0, 15).map((x) => fact('sys_dictionary', `${x.cls}.${x.field}`, `${pct1(x.pct)}% populated`, `below ${opt.customFieldPopulatedPct}%`)),
            guard: { evaluated: false, note: 'A field added for a programme that has not gone live yet is indistinguishable from an abandoned one.' } });
      }
    }
  }

  /* ── CMDB-116 — the trust score, shown and never scored ────────────────── */
  /*
   * DERIVED, AND THEREFORE CIRCULAR. This rule IS the composite: it is computed
   * from D1–D10, so letting it charge a dimension would let the score mark its
   * own homework, and letting it gate would mean a low score proving itself
   * untrustworthy. It is displayed with its caveats and deducts nothing — the
   * catalogue's `systemic_kind: derived` exists for exactly this.
   */
  const dims = ctx.dimensionScores || null;
  skip('CMDB-116', 'cmdb_ci', `The CMDB Trust Score is DERIVED from the dimension scores it would otherwise charge, so it is shown and never scored: a composite that deducted from itself would mark its own homework, and one that gated would make a low score proof of its own untrustworthiness. The score, its coverage and its gate status are published by the scoring engine${dims ? '' : ''}, with the default-weight caveat the catalogue requires — the weights are SAOS defaults and have not been reviewed by this customer.`);
}
