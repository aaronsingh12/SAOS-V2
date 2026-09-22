import crypto from 'node:crypto';
import { BAND_WEIGHT, BLEND_BY_KIND } from './cmdb-quality.js';
import { itsmCoverage } from './overall-health.js';

/**
 * ITSM QUALITY — the ITSM score, in the shape the CMDB score already has.
 *
 * PURE. Coverage, findings, the catalogue's rule rows and the record slice in;
 * a score out. No socket, no database, no model.
 *
 * ═══ WHY THE PASS RATE WAS REPLACED (21 Sep 2026) ═══
 *
 * The first ITSM number was `100 × (1 − affected / scanned)`: one finding of
 * any severity failed a whole record. Measured on dev429978: 144 of 145 records
 * carried at least one of eight legacy findings, most of them Moderate "not
 * updated in 30 days", and the estate scored 0.7 — the exact shape the CMDB
 * score abandoned when an estate scored 0.3. The same findings under a capped
 * severity deduction read ≈ 89. A number that moves by two orders of magnitude
 * with the method, not the estate, cannot be compared with anything, and it
 * could never take the 139-rule catalogue: a rate, a configuration object or a
 * dominance share names no record to fail.
 *
 * ═══ THE MODEL: itsm-quality/1 ═══
 *
 *   record_score(r) = max(0, 100 − Σ w(band))   over the DISTINCT charges on record r
 *   record_part     = mean record_score over the population
 *   rule_part       = passes ÷ (passes + fails)  over ESTATE-level catalogue rules
 *   score           = 0.6 × record_part + 0.4 × rule_part   (one part alone when the other is absent)
 *   w: Critical 40 · High 15 · Moderate 5 · Low 1 · (effective) Systemic 100 — the Schema tab's weights,
 *      the same `BAND_WEIGHT` the CMDB model charges.
 *
 * WHAT IS A RECORD. The population is the ITSM work slice the scan extracted
 * — incident, change_request and problem rows that are active or were updated
 * in the window — from the tables read COMPLETELY. A table read in part is
 * excluded and named; nothing read is nothing scored.
 *
 * WHO CHARGES A RECORD. The eleven legacy rules (one finding per record) and
 * every catalogue finding of a record-naming kind (record, historical,
 * relationship) whose table is in the population. A finding that names a
 * record outside the slice — a closed incident older than the window — is
 * counted and disclosed, never charged: it is outside what the denominator
 * describes.
 *
 * WHAT DOES NOT CHARGE. A finding whose BASE severity is Systemic: the Schema
 * defines it as "the governance mechanism itself is broken", and under the
 * CMDB precedent it never deducts from a record. The ITSM catalogue declares
 * no `systemicKind`, so nothing here can tell a blocker from a posture; every
 * one is POSTURE — surfaced with its count beside the score, never inside it
 * and never a gate. Aggregate, configuration and composite findings name
 * rates and objects, not work records: they reach the score through their
 * rule's verdict, in the rule part.
 *
 * ONE DEFECT, ONE CHARGE. A legacy rule and a catalogue rule can describe the
 * same condition on the same record (PHASE5-REPORT §7 measured three such
 * pairs record-for-record). Charges on a record are keyed by DEFECT FAMILY
 * and a record pays only the heaviest of a family — the CMDB `dedupe_key`
 * rule. The findings themselves are untouched: the list still shows both.
 *
 * WHAT IS EXCLUDED, AND SAID. A rule that could not run (unavailable,
 * unconfigured, skipped, error) or that established nothing (inconclusive,
 * a pass over an empty population it does not declare determinate) is out of
 * the rule part's denominator and counted in `rules`. Missing data is never
 * unhealthy, and nothing judged is never health.
 *
 * COMPARABILITY. `scoring.key` hashes the model's constants. A run under a
 * different key is a different series; the trend shows a break, never a line
 * through it. More rules built or configured widen COVERAGE under the same
 * key — like a newly built CMDB rule inside an existing dimension.
 */

export const ITSM_SCORING_MODEL = 'itsm-quality/1';

/** The work-record tables. The population is their extracted slice. */
export const ITSM_TABLES = Object.freeze(['incident', 'change_request', 'problem']);

/** The record-and-rate blend, from the CMDB model's own table: ITSM asks both shapes of question. */
export const ITSM_BLEND = Object.freeze({ ...BLEND_BY_KIND.mixed, kind: 'mixed' });

/** Catalogue finding kinds that name work records and therefore charge them. */
export const RECORD_KINDS = Object.freeze(new Set(['record', 'historical', 'relationship']));

/** Catalogue engines whose verdict is about the process or its configuration, not a record: the rule part. */
export const ESTATE_ENGINES = Object.freeze(new Set(['aggregate', 'configuration', 'composite']));

/**
 * DEFECT FAMILIES — one underlying condition that more than one rule reports.
 *
 * Only pairs the Phase 5 closure measured as the same records, or one
 * contained in the other (PHASE5-REPORT.md §7): a stuck problem, an aged P1,
 * an incident nobody is assigned to. A record charged by two rules of one
 * family pays the heavier once. Pairs the report marked "No" or "different
 * signal" (CHG-OVERDUE ⟷ ITSM-111, CHG-NO-CI ⟷ ITSM-094) are NOT families.
 */
export const DEFECT_FAMILIES = Object.freeze({
  'ITSM-INC-P1-AGED': 'incident_backlog_ageing',
  'ITSM-037': 'incident_backlog_ageing',
  'ITSM-PRB-STALE': 'problem_not_progressing',
  'ITSM-056': 'problem_not_progressing',
  'ITSM-061': 'problem_not_progressing',
  'ITSM-INC-UNASSIGNED': 'incident_unassigned',
  'ITSM-042': 'incident_unassigned',
});

/** The eleven legacy rules: one finding per record, severity asserted in rules.js. */
export const LEGACY_ITSM_RULES = Object.freeze([
  'ITSM-INC-UNASSIGNED', 'ITSM-INC-P1-AGED', 'ITSM-INC-STALE', 'ITSM-INC-NO-CI', 'ITSM-INC-REOPENED',
  'ITSM-CHG-STALE', 'ITSM-CHG-NO-CI', 'ITSM-CHG-OVERDUE', 'ITSM-CHG-FAILED',
  'ITSM-PRB-UNASSIGNED', 'ITSM-PRB-STALE',
]);

const pct1 = (n) => Number(n.toFixed(1));

/** What makes two ITSM scores comparable: the model and every constant it charges with. */
export function itsmScoringComparability() {
  const payload = {
    model: ITSM_SCORING_MODEL,
    weights: BAND_WEIGHT,
    blend: ITSM_BLEND,
    record_kinds: [...RECORD_KINDS].sort(),
    estate_engines: [...ESTATE_ENGINES].sort(),
    families: DEFECT_FAMILIES,
    legacy: LEGACY_ITSM_RULES,
    tables: ITSM_TABLES,
  };
  return {
    model: ITSM_SCORING_MODEL,
    key: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16),
  };
}

const baseBand = (f) => f.base_severity ?? f.severity ?? null;
const isSystemic = (f) => baseBand(f) === 'SYSTEMIC';
const isLegacy = (f) => LEGACY_ITSM_RULES.includes(f.rule_id);
/** Does this finding charge the records it names? Legacy rules always; catalogue findings by kind. */
const charges = (f) => (isLegacy(f) || !f.kind) ? true : RECORD_KINDS.has(f.kind);
const weightOf = (f) => {
  const band = f.deduction_severity ?? f.severity ?? baseBand(f);
  return BAND_WEIGHT[band] ?? BAND_WEIGHT.MEDIUM;
};

/** A pass counts only when something was judged, or the workbook says an empty population is a determinate pass. */
const vacuous = (row) => row.verdict === 'pass' && Boolean(row.population_empty) && !row.population?.determinate_when_empty;

/**
 * Score ITSM.
 *
 * @param {object}   args
 * @param {object}   args.coverage       table → coverage descriptor (the scan's)
 * @param {object[]} args.findings       every finding IN THE ITSM SCOPE — legacy and catalogue
 * @param {object[]} [args.rules]        the catalogue's normalised rule rows (manifest.itsm.rules), when ITSM ran
 * @param {object}   [args.population]   table → Set(sys_id) of the extracted slice. Absent for a run recorded
 *                                       before this model: every charged record is then assumed in-slice, which
 *                                       holds for the legacy rules by construction.
 * @param {(table: string) => boolean} args.isComplete  the one completeness answer (rules.js)
 * @param {(ruleId: string) => string|null} [args.headline]  a rule's remediation headline, for the drivers
 */
export function scoreItsmQuality({ coverage = {}, findings = [], rules = null, population = null, isComplete, headline = null }) {
  const usable = ITSM_TABLES.filter((t) => isComplete(t));
  const excluded = ITSM_TABLES.filter((t) => coverage?.[t] && !isComplete(t));
  const scoring = itsmScoringComparability();

  /* ── The population ─────────────────────────────────────────────────── */
  const byTable = {};
  let N = 0;
  for (const t of usable) {
    const n = population?.[t] ? population[t].size : (coverage[t]?.records || 0);
    byTable[t] = n;
    N += n;
  }
  const slice = usable.map((t) => coverage[t]?.filter).find(Boolean) || null;
  const inPopulation = (table, id) => (population?.[table] ? population[table].has(id) : true);
  /* Without the slice, a catalogue finding cannot be placed inside or outside
     the denominator — it may name a closed record older than the window — so
     it does not charge; a legacy finding (no `kind`) read the slice itself.
     Counted, said. */
  const bounded = Boolean(population);

  /* ── Layer 1: Systemic posture — surfaced, never charged, never a gate ── */
  const systemicByRule = new Map();
  for (const f of findings) {
    if (!isSystemic(f)) continue;
    const g = systemicByRule.get(f.rule_id) || { rule_id: f.rule_id, title: f.title, kind: f.kind ?? 'record', findings: 0, records: 0 };
    g.findings += 1;
    g.records += (f.target_ids || []).length;
    systemicByRule.set(f.rule_id, g);
  }
  const systemic = { findings: [...systemicByRule.values()].reduce((n, g) => n + g.findings, 0), rules: [...systemicByRule.values()] };

  /* ── Layer 2a: record charges ───────────────────────────────────────── */
  const byRecord = new Map();          // `${table}:${id}` → Map(familyOrRule → weight)
  const perRule = new Map();           // rule_id → { severity, title, ids: Set }
  let outside = 0;
  let notCharged = 0;                  // findings in the scope that charge nothing (non-record kinds, Systemic, unusable tables)
  let unbounded = 0;                   // catalogue record findings that could not be placed against an unknown slice
  for (const f of findings) {
    if (isSystemic(f) || !charges(f) || !usable.includes(f.table) || !(f.target_ids || []).length) { notCharged += 1; continue; }
    if (!bounded && f.kind) { unbounded += 1; continue; }   // a catalogue finding carries its kind; a legacy one never does
    const w = weightOf(f);
    const key = DEFECT_FAMILIES[f.rule_id] || f.rule_id;
    const stat = perRule.get(f.rule_id) || { rule_id: f.rule_id, severity: f.severity, title: f.title, ids: new Set() };
    for (const id of f.target_ids) {
      if (!inPopulation(f.table, id)) { outside += 1; continue; }
      const rk = `${f.table}:${id}`;
      if (!byRecord.has(rk)) byRecord.set(rk, new Map());
      const c = byRecord.get(rk);
      c.set(key, Math.max(c.get(key) || 0, w));
      stat.ids.add(rk);
    }
    if (stat.ids.size) perRule.set(f.rule_id, stat);
  }
  let lost = 0;
  let merged = 0;
  let chargesTotal = 0;
  for (const c of byRecord.values()) {
    let sum = 0;
    for (const w of c.values()) sum += w;
    chargesTotal += c.size;
    lost += Math.min(100, sum);
  }
  /* How many rule charges the family dedupe folded: a record charged by two rules of one family counts one. */
  for (const stat of perRule.values()) merged += stat.ids.size;
  merged -= chargesTotal;
  const hasRecord = N > 0;
  const recordPart = hasRecord ? 100 - lost / N : null;

  /* ── Layer 2b: the rule part — estate-level catalogue verdicts ─────── */
  const rows = Array.isArray(rules) ? rules : [];
  const counts = { catalogue: rows.length, evaluated: 0, determinate: 0, pass: 0, fail: 0, inconclusive: 0, unconfigured: 0, unavailable: 0, skipped: 0, error: 0, not_run: 0, systemic_excluded: 0, vacuous_pass: 0, record_rules: 0 };
  let passes = 0;
  let fails = 0;
  for (const row of rows) {
    const status = row.status;
    if (status === 'evaluated') counts.evaluated += 1;
    else if (status in counts) counts[status] += 1;
    else counts.not_run += 1;
    if (status !== 'evaluated') continue;
    if (row.verdict === 'inconclusive' || !['pass', 'fail'].includes(row.verdict)) { counts.inconclusive += 1; continue; }
    counts.determinate += 1;
    if (row.verdict === 'pass') counts.pass += 1; else counts.fail += 1;
    if (row.base_severity === 'Systemic' || row.base_severity === 'SYSTEMIC') { counts.systemic_excluded += 1; continue; }
    if (!ESTATE_ENGINES.has(row.engine)) { counts.record_rules += 1; continue; }   // its records carry its verdict
    if (vacuous(row)) { counts.vacuous_pass += 1; continue; }
    if (row.verdict === 'pass') passes += 1; else fails += 1;
  }
  const ruleN = passes + fails;
  const hasRule = ruleN > 0;
  const rulePart = hasRule ? (100 * passes) / ruleN : null;

  /* ── The blend ──────────────────────────────────────────────────────── */
  const score = hasRecord && hasRule
    ? ITSM_BLEND.record * recordPart + ITSM_BLEND.kpi * rulePart
    : (hasRecord ? recordPart : (hasRule ? rulePart : null));

  const fmt = (n) => Number(n).toLocaleString('en-US');
  const charged = byRecord.size;
  const drivers = [...perRule.values()]
    .map((s) => ({
      rule_id: s.rule_id,
      label: headline?.(s.rule_id) ?? s.title ?? s.rule_id,
      severity: s.severity,
      records: s.ids.size,
      share: N ? pct1((100 * s.ids.size) / N) : null,
    }))
    .filter((d) => d.records > 0)
    .sort((a, b) => b.records - a.records || a.rule_id.localeCompare(b.rule_id))
    .slice(0, 8);

  let withheld = null;
  if (score == null) {
    withheld = !usable.length
      ? (excluded.length
        ? `None of ${ITSM_TABLES.join(', ')} were read completely, so there is no record set to score.`
        : 'No incident, change or problem records were read on this run.')
      : 'The ITSM slice was empty — nothing open or recent to score — and no estate-level catalogue rule established a verdict.';
  }

  const parts = [];
  if (hasRecord) parts.push(`${fmt(N - charged)} of ${fmt(N)} records carry no charge, mean record score ${pct1(recordPart)}${slice ? ` (${slice})` : ''}${unbounded ? `; ${unbounded} catalogue finding${unbounded === 1 ? '' : 's'} not charged — this run did not keep its record slice` : ''}`);
  if (hasRule) parts.push(`${passes} of ${ruleN} estate-level rules pass`);
  const basis = score == null ? null
    : `${parts.join('; ')}${hasRecord && hasRule ? ` — blended ${Math.round(ITSM_BLEND.record * 100)}/${Math.round(ITSM_BLEND.kpi * 100)}` : (hasRecord ? ' — record part alone; no estate-level rule established a verdict' : ' — rule part alone; the record slice was empty')}${excluded.length ? `; ${excluded.join(', ')} excluded — not read completely` : ''}`;

  return {
    score: score == null ? null : pct1(score),
    basis,
    definition: 'A record starts at 100 and loses the weight of each distinct charge on it (Critical 40 · High 15 · Moderate 5 · Low 1), floored at 0; the record part is the mean over the open-or-recent incident, change and problem slice. The rule part is the share of estate-level catalogue rules (rates, configuration, composites) that pass. Blended 60/40. Systemic findings are posture beside the score, never in it.',
    withheld,
    drivers,
    quality: {
      model: ITSM_SCORING_MODEL,
      scoring,
      record_part: recordPart == null ? null : pct1(recordPart),
      rule_part: rulePart == null ? null : pct1(rulePart),
      blend: hasRecord && hasRule ? ITSM_BLEND : null,
      weights: BAND_WEIGHT,
      population: { records: N, by_table: byTable, basis: slice, tables: { usable, excluded } },
      records: { charged, clean: N - charged, charges: chargesTotal, merged_by_family: merged, outside_population: outside, findings_not_charging: notCharged, unbounded_catalogue: unbounded },
      rules: { ...counts, rule_part_pass: passes, rule_part_fail: fails },
      /* Coverage under the estate's one definition (overall-health.js): rules with a
         verdict over those plus rules this instance could have let run. Never in the score. */
      coverage: itsmCoverage(rows),
      systemic,
      families: DEFECT_FAMILIES,
    },
  };
}
