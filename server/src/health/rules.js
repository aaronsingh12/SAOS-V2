import crypto from 'node:crypto';
import { parseDate } from './time.js';
import { catalogueRule, effectiveBand, POPULATION_MODIFIERS, GATING_KINDS, BAND_WEIGHT, CMDB_CATALOGUE, CMDB_DIMENSIONS, DIMENSION_KIND, BLEND_BY_KIND } from './cmdb-quality.js';
import { cmdbGateRules, GATE_RULES, cmdbInScope } from './cmdb-gate.js';
import { cmdbCorrectnessRules, CORRECTNESS_RULES } from './cmdb-correctness.js';
import { cmdbCompletenessRules, COMPLETENESS_RULES } from './cmdb-completeness.js';
import { cmdbUniquenessRules, UNIQUENESS_RULES } from './cmdb-uniqueness.js';
import { cmdbIdentificationRules, IDENTIFICATION_RULES } from './cmdb-identification.js';
import { cmdbRelationshipRules, RELATIONSHIP_RULES, SUBSUMED_BY_GROUP_6 } from './cmdb-relationships.js';
import { cmdbFreshnessRules, FRESHNESS_RULES } from './cmdb-freshness.js';
import { cmdbLifecycleRules, LIFECYCLE_RULES } from './cmdb-lifecycle.js';
import { cmdbGovernanceRules, GOVERNANCE_RULES } from './cmdb-governance.js';
import { cmdbOwnershipRules, OWNERSHIP_RULES } from './cmdb-ownership.js';
import { cmdbCsdmRules, CSDM_RULES } from './cmdb-csdm.js';
import { cmdbConsumptionRules, CONSUMPTION_RULES } from './cmdb-consumption.js';
import { cmdbScaleRules, SCALE_RULES } from './cmdb-scale.js';
import { cmdbRecurrencePass, cmdbDriftRules, DRIFT_RULES } from './cmdb-drift.js';
import { comparableHistory } from './cmdb-history.js';
import { buildSignals, materialityFor } from './cmdb-signals.js';
import { TABLES } from './tables.js';
import { scopeOf, scopeOfRule, MODULE_KEYS, moduleTables } from './scopes.js';

/**
 * The deterministic rule pack — Health Assist's findings engine.
 *
 * Ported from SAOS `app/agents/domain_analysis.py`, and kept PURE on purpose:
 * this module takes an already-extracted estate and returns findings. It opens
 * no socket, reads no database and calls no model. That is what makes it
 * testable offline against fixtures, and it is the same reason `agent/lint/` is
 * shaped this way — a finding produced by a rule can be argued with; one
 * produced by a model cannot.
 *
 * THE PROPERTY THAT MATTERS MOST is coverage gating. A rule that fires on the
 * ABSENCE of something (no relationships, no service offering) is only sound if
 * the extraction that found nothing was complete. Partial extraction plus an
 * absence rule is how "we could not read the table" becomes "your CMDB is
 * broken". So `rows()` refuses to serve a table whose coverage is not good
 * enough and records WHY in `skipped[]`, and the absence rules additionally
 * demand `complete`. This is the same distinction the ACL module draws with
 * `visibility: full | empty | restricted` — an empty result is never rendered
 * as an answer.
 */

/*
 * 3.0.0 (Sep 2026): the full CMDB catalogue (Groups 1–14), consequence scoping,
 * and per-dimension-type blends. The composite no longer means what 2.0.0's did,
 * so scores from before and after must not be trended against each other.
 *
 * BUMP THIS WHEN A RULE'S DETECTION LOGIC CHANGES. `scoringComparability` hashes
 * the catalogue, the implemented rule set and the blends, but it cannot see a
 * change inside a rule's code — this version is how that change is declared.
 *
 * 3.0.1 (Sep 2026): the first bump under that discipline, from the Group 14
 * live run. A CMDB-only scan now STORES the Group 13 findings it used to drop
 * (findings route by rule prefix, not domain), and CMDB-131 counts a finding as
 * created only when its rule produced findings on the earlier run. No run keyed
 * under 3.0.0 had been persisted, so nothing comparable is set aside by it.
 *
 * 3.0.2 (17 Sep 2026, CMDB checkpoint): CMDB-124's endpoint tier expects no
 * edges by default; CMDB-038 can no longer trend duplicate sets measured under
 * another model (comparability is now a property of the measure); CMDB-128 says
 * a flat estate is flat. Again no run keyed under 3.0.1 had been persisted.
 */
export const RULE_VERSION = '3.0.2';

/** domain key → [DOMAIN, human label]. The closed vocabulary for grouping. */
export const AGENTS = Object.freeze({
  cmdb_agent: ['CMDB', 'CMDB quality'],
  cmdb_governance_agent: ['CMDB_GOVERNANCE', 'CMDB health governance'],
  relationship_agent: ['RELATIONSHIP', 'Relationship integrity'],
  /* D7 asks a question neither CMDB nor DISCOVERY owns: not "is the record
     right" and not "is Discovery healthy", but "is ANYTHING still confirming
     this record, and how long ago". An estate with no Discovery at all still
     has an answer, and it is usually the finding. */
  freshness_agent: ['FRESHNESS', 'Freshness and source coverage'],
  /* D8 runs the other way round: it judges the records every other dimension
     excludes, and the question is never "is this good" but "do these two facts
     about the same thing disagree". */
  lifecycle_agent: ['LIFECYCLE', 'Lifecycle and retirement'],
  /* Group 9 asks who ANSWERS for the data, which is not the same question as
     whether the data is right — so it is posture beside the score, never in it. */
  attestation_agent: ['ATTESTATION', 'Data Manager and attestation'],
  /* D9 asks whether the somebody every other finding needs actually exists. */
  ownership_agent: ['OWNERSHIP', 'Ownership and accountability'],
  csdm_agent: ['CSDM', 'Service model completeness'],
  customization_agent: ['CUSTOMIZATION', 'Business rule review'],
  integration_agent: ['INTEGRATION', 'Integration configuration'],
  performance_agent: ['PERFORMANCE', 'Queue and job health'],
  upgrade_agent: ['UPGRADE', 'Upgrade review'],
  security_agent: ['SECURITY', 'Access hygiene'],
  mid_server_agent: ['MID_SERVER', 'MID server health'],
  event_management_agent: ['EVENT_MANAGEMENT', 'Alert binding'],
  /* ── ITOM ─────────────────────────────────────────────────────────────
   * Discovery, Service Mapping, credentials and availability. Separate
   * domains rather than folded into CMDB, because the question they answer
   * is different: CMDB rules ask "is this record right?", these ask "is the
   * machinery that MAINTAINS the records running at all?" A perfect CMDB
   * that no Discovery is refreshing is a snapshot going stale. */
  discovery_agent: ['DISCOVERY', 'Discovery health'],
  credential_agent: ['CREDENTIALS', 'Discovery credentials'],
  service_mapping_agent: ['SERVICE_MAPPING', 'Service mapping coverage'],
  availability_agent: ['AVAILABILITY', 'Outages and availability'],
  /* ── ITSM ─────────────────────────────────────────────────────────────
   * The work that runs ON the CMDB: is it assigned, moving, linked to the
   * CIs it affects, and closed when it is done? */
  incident_agent: ['INCIDENT', 'Incident hygiene'],
  change_agent: ['CHANGE', 'Change hygiene'],
  problem_agent: ['PROBLEM', 'Problem hygiene'],
});

const SEVERITY_RANK = Object.freeze({ SYSTEMIC: 6, CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 });

/**
 * The catalogue rules this build evaluates. Everything else in the SAOS
 * catalogue is not built yet, and a dimension with no built rule is reported as
 * NOT MEASURED — never as a clean 100.
 */
/**
 * WHEN CAN TWO SNAPSHOTS BE COMPARED?
 *
 * A trend is only as honest as the claim that both ends were measured the same
 * way. Measured on dev424910: consecutive CMDB runs read 82.1 then 77.0, and
 * 11,618 then 20,954 findings — every point of that caused by rule changes the
 * same week. A trend rule comparing them would have announced a decline and
 * nine thousand new defects in an estate that had not changed.
 *
 * The key hashes everything that decides what a finding or a score MEANS: the
 * rule-pack version, which catalogue rules are implemented, each rule's scoring
 * attributes (band, dimension, track, kind, systemic kind, intent), the dimension
 * weights, and the per-type blends. Two runs with different keys are different
 * measurements, and the trend rules decline to trend them.
 */
export function scoringComparability({
  ruleVersion = RULE_VERSION, blends = BLEND_BY_KIND, kinds = DIMENSION_KIND, implemented = IMPLEMENTED_CATALOGUE_RULES,
} = {}) {
  const scoring = Object.values(CMDB_CATALOGUE)
    .map((r) => [r.id, r.base, r.dimension, r.track, r.kind, r.systemicKind ?? null, r.intent])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const payload = {
    rule_version: ruleVersion,
    implemented: [...implemented].sort(),
    scoring,
    weights: CMDB_DIMENSIONS.map((d) => [d.key, d.weight]),
    kinds,
    blends,
  };
  return {
    key: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16),
    rule_version: ruleVersion,
  };
}

export const IMPLEMENTED_CATALOGUE_RULES = Object.freeze(new Set([...GATE_RULES, ...COMPLETENESS_RULES, ...CORRECTNESS_RULES, ...UNIQUENESS_RULES, ...IDENTIFICATION_RULES, ...RELATIONSHIP_RULES, ...FRESHNESS_RULES, ...LIFECYCLE_RULES, ...GOVERNANCE_RULES, ...OWNERSHIP_RULES, ...CSDM_RULES, ...CONSUMPTION_RULES, ...SCALE_RULES, ...DRIFT_RULES]));

/**
 * The severity vocabulary, with the words a person reads.
 *
 * It lives on the server because the UI may not invent vocabulary of its own
 * (ARCHITECTURE §17.7) — "Major" is a label for `HIGH`, and if the page coined
 * it privately the two would drift the first time a rule changed severity.
 *
 * `tone` names a reserved STATUS colour, never a series colour. Severity is a
 * status scale, so every mark that carries one also carries its word and its
 * glyph: identity never rests on hue, which is what makes the two reds at the
 * top of the scale legible to a colourblind reader.
 */
export const SEVERITIES = Object.freeze([
  /* SYSTEMIC is not a findings section. A BASE-Systemic finding is a trust-gate
     blocker shown above the score; a finding ESCALATED to Systemic zeroes its
     record but does not gate. `gate: true` tells the page to render it that way. */
  { key: 'SYSTEMIC', label: 'Systemic', rank: 6, weight: 100, tone: 'systemic', glyph: '◆', gate: true, blurb: 'The governance mechanism that should prevent defects is itself broken. One finding explains thousands.' },
  { key: 'CRITICAL', label: 'Critical', rank: 5, weight: 40, tone: 'critical', glyph: '▲', blurb: 'Causes operational blindness, silently corrupts data, or makes a dependent capability return a wrong answer.' },
  /* Key stays HIGH so stored runs keep their meaning; the word is the Schema's. */
  { key: 'HIGH', label: 'High', rank: 4, weight: 15, tone: 'major', glyph: '▲', blurb: 'Materially degrades trust or blocks a capability. The system does not lie, it cannot help.' },
  /* Key stays MEDIUM for the same reason; the Schema calls it Moderate. */
  { key: 'MEDIUM', label: 'Moderate', rank: 3, weight: 5, tone: 'moderate', glyph: '●', blurb: 'Real defect, contained blast radius, bulk-fixable, no immediate operational consequence.' },
  { key: 'LOW', label: 'Low', rank: 2, weight: 1, tone: 'low', glyph: '●', blurb: 'Hygiene and completeness. Matters in aggregate, not individually.' },
  { key: 'INFO', label: 'Info', rank: 1, weight: 0, tone: 'info', blurb: 'For awareness only.' },
]);

/** Serial values that are placeholders rather than identities. */
const NON_SERIALS = new Set(['unknown', 'none', 'null', 'n/a', '0', 'to be filled by o.e.m.']);

function truth(value) {
  return ['true', '1', 'yes'].includes(String(value).toLowerCase());
}

/* `parseDate` now lives in the leaf module `time.js` — see the note there for
   the import cycle it was closing. Re-exported so nothing else has to move. */
export { parseDate } from './time.js';

const DAY_MS = 86_400_000;

/**
 * Was this table read completely enough for a rule that needs `fields`?
 *
 * THE ONE PLACE THIS QUESTION IS ANSWERED. It used to be `status === 'complete'`
 * repeated at every gate, which asked for BOTH every row and every requested
 * field. Measured on techsnitchpvtltddemo2: `cmdb_ci` read 3,412 of 3,412 rows
 * but `business_criticality` is not a column there, so every absence rule and
 * the CMDB score refused to run over a field none of them used.
 *
 * Two halves, asked separately:
 *   - the ROW set must be complete (`rows_complete`, or a legacy `complete`
 *     status from a run recorded before the field existed);
 *   - only the fields THIS rule reads must be present. A rule that keys off
 *     `agent` really cannot run when `agent` was dropped — on the same instance
 *     `ecc_agent_capability.agent` was hidden, and treating that as "no MID has
 *     a capability" would have been an invented finding.
 */
export function isComplete(coverage, tableName, fields = []) {
  const c = coverage?.[tableName];
  if (!c) return false;
  const rowsOk = c.rows_complete === true || (c.rows_complete === undefined && c.status === 'complete');
  if (!rowsOk) return false;
  const missing = new Set(c.missing_fields || []);
  return fields.every((f) => !missing.has(f));
}

export class EstateRules {
  /**
   * @param {Record<string, object[]>} estate   table → extracted rows
   * @param {Record<string, object>}   coverage table → coverage descriptor
   * @param {number} staleDays                  age at which a CI is a review signal
   */
  constructor(estate, coverage, staleDays = 90, now = new Date(), { meta = {}, gateOptions = {}, acceptedFingerprints = [], history = {} } = {}) {
    this.estate = estate || {};
    this.coverage = coverage || {};
    this.staleDays = staleDays;
    this.findings = [];
    this.skipped = [];
    this.now = now;
    /* Bounded non-table reads (class hierarchy, filter counts, job triggers)
       made by extract.js. The rule pack stays pure: it only reads this. */
    this.meta = meta || {};
    this.gateOptions = gateOptions;
    this.gate = null;
    /* Percentage rules measure; they do not deduct per record. */
    this.kpis = [];
    this.signals = null;
    /* "Accepted risk" lifecycle decisions — the approved-exception de-escalator. */
    this.accepted = new Set(acceptedFingerprints);
    /* Measures recorded on every run (duplicate-set membership, open de-dup
       tasks) and the same measures from earlier runs — the trend rules' input. */
    this.measures = {};
    /* What makes this run's findings and scores comparable with an earlier run's. */
    this.comparability = scoringComparability();
    this.history = history || {};
  }

  /*
   * HISTORY PASSES THROUGH THE COMPARISON LAYER, ALWAYS. Every assignment — the
   * constructor's, or a caller's later `rules.history = …` — is stored as given
   * and read back through `comparableHistory` under THIS engine's key, so a
   * derived reading from another scoring model never reaches a rule, whichever
   * rule asks and however the history arrived. See MEASURE_COMPARABILITY.
   */
  get history() {
    const key = this.comparability?.key ?? null;
    if (!this._history || this._historyKey !== key) {
      this._history = comparableHistory(this._historySource, key);
      this._historyKey = key;
    }
    return this._history;
  }

  set history(value) {
    this._historySource = value || {};
    this._history = null;
  }

  /**
   * Record a finding for a SAOS catalogue rule.
   *
   * The catalogue decides the base band, the dimension and whether the rule is a
   * trust-gate rule; the caller supplies only the context modifiers it could
   * evaluate. The effective band is computed, never passed in, so a rule cannot
   * quietly assert its own severity.
   */
  addCatalogued(ruleId, tableName, records, fields, description, {
    title = null, evidence = [], escalators = [], deEscalators = [], notEvaluated = [],
    guard = null, confidence = 1.0, recommendation, agent = 'cmdb_governance_agent',
  } = {}) {
    const rule = catalogueRule(ruleId);
    if (!rule) throw new Error(`${ruleId} is not in the SAOS catalogue`);
    this.add(agent, ruleId, tableName, records, fields, title || rule.title, description, {
      severity: rule.base,
      confidence,
      recommendation: recommendation || rule.remediationLane || undefined,
    });
    const f = this.findings[this.findings.length - 1];
    /* The approved exception is known only once the fingerprint exists. It is a
       de-escalator on the SAME fingerprint, so accepting a finding can never
       change which finding it is. */
    if (this.accepted.has(f.fingerprint) && !deEscalators.includes('approved_exception')) {
      deEscalators = [...deEscalators, 'approved_exception'];
    }
    const severity = effectiveBand(rule.base, { escalators, deEscalators });
    f.severity = severity;
    f.evidence.push(...evidence);
    Object.assign(f, {
      base_severity: rule.base,
      /* What the record is CHARGED. Only the CI's own context moves it; the
         materiality pass may later move `severity` but never this. */
      deduction_severity: severity,
      dimension: rule.dimension,
      /* Systemic gates only when it invalidates what the composite means (16 Sep 2026). */
      gate: rule.base === 'SYSTEMIC' && GATING_KINDS.has(rule.systemicKind),
      posture: rule.base === 'SYSTEMIC' && !GATING_KINDS.has(rule.systemicKind),
      escalated_to_systemic: rule.base !== 'SYSTEMIC' && severity === 'SYSTEMIC',
      lane: rule.lane,
      catalogue_group: rule.group,
      modifiers: { escalators, de_escalators: deEscalators, not_evaluated: notEvaluated },
      false_positive_guard: { text: rule.falsePositiveGuard, evaluated: Boolean(guard?.evaluated), note: guard?.note || null },
    });
    return f;
  }

  /** See `isComplete` — the one place the completeness question is answered. */
  complete(tableName, fields = []) {
    return isComplete(this.coverage, tableName, fields);
  }

  /**
   * Rows of a table that are safe to reason about.
   *
   * Refuses — and records why — when the table was not extracted well enough,
   * and drops individual records missing a field the rule needs, reporting the
   * count. A rule silently running on 3 of 900 rows is the failure this
   * prevents.
   */
  rows(tableName, fields = [], { complete = false, rule = '' } = {}) {
    const c = this.coverage[tableName] || {};
    if (!['complete', 'limited', 'truncated'].includes(c.status)) {
      this.skipped.push({ rule, table: tableName, reason: c.status || 'not_requested' });
      return [];
    }
    if (complete && !this.complete(tableName, fields)) {
      this.skipped.push({ rule, table: tableName, reason: 'Complete visible-table coverage required' });
      return [];
    }
    const all = this.estate[tableName] || [];
    const eligible = all.filter((r) => fields.every((k) => k in r));
    if (eligible.length !== all.length) {
      this.skipped.push({
        rule,
        table: tableName,
        reason: 'Fields omitted by API/ACL',
        excluded_records: all.length - eligible.length,
      });
    }
    return eligible;
  }

  /** Record a finding, with one evidence row per (record, field) actually present. */
  add(agent, rule, tableName, records, fields, title, description, {
    severity = 'MEDIUM',
    confidence = 1.0,
    recommendation = 'Review the evidence with the responsible owner before making changes.',
  } = {}) {
    /*
     * A finding with NO target records is ESTATE-WIDE, not harmless.
     *
     * "There is no MID server" and "Discovery has never run" name no rows
     * because the rows are what is missing. The priority formula multiplies
     * severity by a business proxy derived from affected services, so without
     * this an estate-wide HIGH scored 4 — the bottom of P3, beneath a single
     * CI with a blank owner. That is exactly backwards: nothing being there
     * affects everything downstream of it.
     */
    const estateWide = records.length === 0;
    const evidence = [];
    for (const r of records) {
      for (const field of fields) {
        if (field in r) {
          evidence.push({
            source: 'ServiceNow Table REST API',
            sn_table: tableName,
            sn_sys_id: r.sys_id,
            field_name: field,
            field_value: String(r[field]),
            reason: description,
            collected_at: this.now.toISOString(),
          });
        }
      }
    }
    const identity = `${rule}|${tableName}|${records.map((r) => r.sys_id).sort().join('|')}`;
    this.findings.push({
      fingerprint: crypto.createHash('sha256').update(identity).digest('hex'),
      agent_id: agent,
      rule_id: rule,
      domain: AGENTS[agent][0],
      table: tableName,
      target_ids: records.map((r) => r.sys_id),
      title,
      description,
      severity,
      confidence,
      estate_wide: estateWide,
      affected_ci_ids: tableName === 'cmdb_ci' ? records.map((r) => r.sys_id) : [],
      affected_service_ids: [],
      evidence,
      recommendation,
    });
  }

  /**
   * Run the rule families for the modules asked for — every module by default.
   *
   * A family runs when ANY module it can report for is wanted: the platform
   * family also raises three ITOM rules (MID-DOWN, EVENT-UNBOUND, PERF-ECC-AGE),
   * so it runs for either. What leaves is filtered by module afterwards —
   * findings by their scope, skipped checks by their rule — so a module-limited
   * scan never reports on a module it did not check.
   *
   * WHAT EACH MODULE READ. The estate and the coverage are watched while a
   * family runs, and every table it touched is recorded against that family's
   * modules as `this.dependencies`. A module's result is reusable only while
   * those tables are unchanged, and the list comes from what the rules actually
   * read rather than from a list somebody has to keep in step with them.
   */
  analyze({ modules = null } = {}) {
    const want = new Set(modules && modules.length ? modules : MODULE_KEYS);
    const raw = { estate: this.estate, coverage: this.coverage };
    const touched = {};
    let current = [];
    /*
     * A family that reports for more than one module charges each table to the
     * module that declares it. Measured: the platform family reads `sys_script`
     * for Platform and `ecc_queue` for ITOM, and charging both to both made ITOM
     * re-read whenever a business rule changed. A table no module in the family
     * declares is charged to all of them — never to none.
     */
    /*
     * WHERE THE ANALYSIS SPENDS ITS TIME (CMDB checkpoint, 17 Sep 2026). Each rule
     * pack is timed, and the tables it reads are recorded beside the time, so a
     * slow scan can be traced from a table read to the rules that asked for it.
     * "Read" means read through `estate` or `coverage` inside that pack: a pack
     * that reuses rows an earlier pack prepared (the signals) does not list them.
     */
    const stages = [];
    let stageTables = null;
    const note = (prop) => {
      if (typeof prop !== 'string' || !TABLES[prop]) return;
      stageTables?.add(prop);
      const owners = current.length > 1 ? current.filter((m) => moduleTables([m]).includes(prop)) : current;
      for (const m of (owners.length ? owners : current)) (touched[m] ||= new Set()).add(prop);
    };
    const stage = (name, fn) => {
      const outer = stageTables;
      const tables = new Set();
      stageTables = tables;
      const before = { findings: this.findings.length, skipped: this.skipped.length };
      const t0 = performance.now();
      try {
        return fn();
      } finally {
        stages.push({
          stage: name, ms: Number((performance.now() - t0).toFixed(1)), tables: [...tables].sort(),
          findings_added: this.findings.length - before.findings, skips_added: this.skipped.length - before.skipped,
        });
        stageTables = outer;
      }
    };
    this.estate = new Proxy(raw.estate, { get: (t, p) => { note(p); return t[p]; } });
    this.coverage = new Proxy(raw.coverage, { get: (t, p) => { note(p); return t[p]; } });
    const family = (mods, fn) => {
      const run = mods.filter((m) => want.has(m));
      if (!run.length) return;
      current = run;
      try { fn(); } finally { current = []; }
    };
    try {
      family(['cmdb'], () => {
        stage('cmdb: signals', () => { this.signals = buildSignals(this); });
        stage('cmdb: gate (Group 1)', () => { this.gate = cmdbGateRules(this, this.gateOptions); });
        stage('cmdb: completeness D1 (Group 2)', () => cmdbCompletenessRules(this));
        stage('cmdb: correctness D2 (Group 3)', () => cmdbCorrectnessRules(this));
        stage('cmdb: uniqueness D3 (Group 4)', () => cmdbUniquenessRules(this));
        stage('cmdb: identification D4/D5 (Group 5)', () => cmdbIdentificationRules(this));
        stage('cmdb: relationships D6 (Group 6)', () => cmdbRelationshipRules(this));
        stage('cmdb: freshness D7 (Group 7)', () => cmdbFreshnessRules(this));
        /* D8 consumes measures D7 produces (retired_still_discovered,
           record_freshness), so it runs after it — never beside it. */
        stage('cmdb: lifecycle D8 (Group 8)', () => cmdbLifecycleRules(this));
        stage('cmdb: governance (Group 9)', () => cmdbGovernanceRules(this));
        /* CMDB-104 ranks ownerless classes by the findings already raised in
           them, so ownership runs last of the CMDB packs. */
        stage('cmdb: CSDM (Group 11)', () => cmdbCsdmRules(this));
        stage('cmdb: consumption D10 (Group 12)', () => cmdbConsumptionRules(this));
        stage('cmdb: scale (Group 13)', () => cmdbScaleRules(this));
        stage('cmdb: ownership D9 (Group 10)', () => cmdbOwnershipRules(this));
        /* Group 14, part one: a finding that recurred after a verified closure is
           escalated HERE, because materiality recomputes every charge from its
           modifiers next and must see the escalator. */
        stage('cmdb: recurrence pass (Group 14)', () => cmdbRecurrencePass(this));
        stage('cmdb: materiality', () => this.applyMateriality());
        stage('cmdb: legacy CMDB rules', () => this.cmdbRules());
        stage('cmdb: legacy relationship rules', () => this.relationshipRules());
        stage('cmdb: legacy service rules', () => this.serviceRules());
        /* Group 14, part two: the trend rules compare the COMPLETE set of this
           run's CMDB findings — patterns and hand-written rules included — with
           earlier comparable snapshots, so they run last. CMDB-137 needs the
           composite and runs after scoring, in index.js. */
        stage('cmdb: drift (Group 14)', () => cmdbDriftRules(this));
      });
      family(['platform', 'itom'], () => stage('platform + itom rules', () => this.platformRules()));
      family(['itom'], () => stage('itom rules', () => this.itomRules()));
      family(['itsm'], () => stage('itsm rules', () => this.itsmRules()));
      this.findings = this.findings.filter((f) => want.has(scopeOf(f)));
      this.skipped = this.skipped.filter((x) => want.has(scopeOfRule(x.rule)));
      /* Impact is traced through the CI graph, and only CMDB findings name CIs,
         so what synthesis reads is a CMDB dependency and nobody else's. */
      current = want.has('cmdb') ? ['cmdb'] : [];
      try { stage('synthesis', () => this.synthesize()); } finally { current = []; }
    } finally {
      this.estate = raw.estate;
      this.coverage = raw.coverage;
      this.timings = { stages };
    }
    this.dependencies = Object.fromEntries([...want].map((m) => [m, [...(touched[m] || [])].sort()]));
    return this.findings;
  }

  /**
   * MATERIALITY — decision 3 of 17 Sep, split by decision 1 of 16 Sep 2026.
   *
   * Per rule, per class, over the in-scope CIs: a rule affecting at least 20% of
   * a class AND at least 10 CIs is a pattern, not an exception; one affecting
   * fewer than max(5, 1% of the class) is below the materiality floor.
   *
   * Both are properties of the CLASS, not of a CI, so neither changes what a
   * record is charged:
   *   - a pattern surfaces as ONE finding for the class, one band above the
   *     rule's base (a Critical rule's pattern is Systemic). Each affected record
   *     keeps its own finding and its own deduction.
   *   - below the floor lowers where a record finding is REPORTED, never its
   *     deduction — the same asymmetry in reverse, so the score cannot be moved
   *     by class size alone.
   * Only record rules in a scored dimension, never a gate rule.
   */
  applyMateriality() {
    const scope = new Set(cmdbInScope(this).ids);
    const ciById = new Map((this.estate.cmdb_ci || []).filter((c) => scope.has(c.sys_id)).map((c) => [c.sys_id, c]));
    const eligible = this.findings.filter((f) => {
      const r = catalogueRule(f.rule_id);
      return r && r.kind === 'record' && r.track === 'dimension' && r.base !== 'SYSTEMIC' && !f.pattern && !f.unscored_reason && (f.target_ids || []).length && f.modifiers;
    });
    const verdicts = materialityFor(eligible, ciById);
    const patterns = new Map();                    // rule|class -> { rule, cls, ids:Set, classSize, agent }
    for (const f of eligible) {
      const m = f.modifiers;
      m.not_evaluated = (m.not_evaluated || []).filter((k) => !POPULATION_MODIFIERS.includes(k));
      m.escalators = m.escalators.filter((k) => !POPULATION_MODIFIERS.includes(k));
      m.de_escalators = m.de_escalators.filter((k) => !POPULATION_MODIFIERS.includes(k));
      const rule = catalogueRule(f.rule_id);
      const own = effectiveBand(rule.base, { escalators: m.escalators, deEscalators: m.de_escalators });
      /*
       * A RULE MAY DECLARE A SMALLER CHARGE FOR A RECORD IT STILL REPORTS.
       *
       * CMDB-058 charges an orphaned laptop at LOW and an orphaned database at
       * CRITICAL: both are holes in the map, and only one of them matters to
       * impact analysis (decision 3 of Sep 2026). The declaration belongs here,
       * where the charge is computed, because this pass recomputes it — a rule
       * setting `deduction_severity` itself would simply be overwritten.
       *
       * DOWNGRADE ONLY, and never past an escalation: a band heavier than the
       * rule's own is ignored, and a record its own context escalated to
       * Systemic still zeroes, whatever the rule would have preferred.
       */
      const capped = f.deduction_band_override;
      const useCap = capped && own !== 'SYSTEMIC' && BAND_WEIGHT[capped] < BAND_WEIGHT[own];
      f.deduction_severity = useCap ? capped : own;
      f.escalated_to_systemic = own === 'SYSTEMIC';
      const v = verdicts.get(f.fingerprint);
      if (!v) {
        m.not_evaluated.push('class_defect_rate', 'below_materiality');
        f.severity = own;
        continue;
      }
      f.materiality = { class: v.cls, affected: v.affected, class_size: v.classSize };
      if (v.deEscalate) m.de_escalators.push('below_materiality');
      f.severity = effectiveBand(rule.base, { escalators: m.escalators, deEscalators: m.de_escalators });
      if (v.escalate) {
        const key = `${f.rule_id}|${v.cls}`;
        if (!patterns.has(key)) patterns.set(key, { rule, cls: v.cls, ids: new Set(), classSize: v.classSize, agent: f.agent_id, table: f.table });
        for (const id of f.target_ids) if (ciById.get(id)?.sys_class_name === v.cls) patterns.get(key).ids.add(id);
      }
    }
    for (const [key, p] of patterns) {
      const fingerprint = crypto.createHash('sha256').update(`pattern|${key}`).digest('hex');
      const de = this.accepted.has(fingerprint) ? ['approved_exception'] : [];
      const severity = effectiveBand(p.rule.base, { escalators: ['class_defect_rate'], deEscalators: de });
      const ids = [...p.ids];
      const pct = p.classSize ? ((100 * ids.length) / p.classSize).toFixed(1) : '0';
      for (const f of eligible) if (`${f.rule_id}|${f.materiality?.class}` === key) f.pattern_fingerprint = fingerprint;
      this.findings.push({
        fingerprint,
        agent_id: p.agent,
        rule_id: p.rule.id,
        domain: AGENTS[p.agent][0],
        table: p.table,
        target_ids: ids,
        title: `${p.rule.title} — class-wide pattern in ${p.cls}`,
        description: `${ids.length} of ${p.classSize} in-scope ${p.cls} CIs (${pct}%) fail ${p.rule.id}. At this rate it is a pattern in how the class is populated, not a set of exceptions: fix the source, not the records. Each record keeps its own finding and its own ${p.rule.base} deduction; this finding changes no score.`,
        severity,
        confidence: 1.0,
        estate_wide: false,
        affected_ci_ids: p.table === 'cmdb_ci' ? ids : [],
        affected_service_ids: [],
        evidence: [{
          source: 'Health Assist materiality pass',
          sn_table: p.table,
          sn_sys_id: ids[0] || null,
          field_name: 'sys_class_name',
          field_value: p.cls,
          reason: `${ids.length} affected of ${p.classSize} in class (threshold: ≥20% and ≥10 CIs)`,
          collected_at: this.now.toISOString(),
        }],
        recommendation: p.rule.remediationLane || undefined,
        pattern: true,
        base_severity: p.rule.base,
        deduction_severity: null,
        dimension: p.rule.dimension,
        gate: false,
        posture: false,
        escalated_to_systemic: false,
        lane: p.rule.lane,
        catalogue_group: p.rule.group,
        modifiers: { escalators: ['class_defect_rate'], de_escalators: de, not_evaluated: [] },
        materiality: { class: p.cls, affected: ids.length, class_size: p.classSize },
        false_positive_guard: { text: p.rule.falsePositiveGuard, evaluated: true, note: 'Population rule: the rate is computed over in-scope CIs of the class only.' },
      });
    }
  }

  /**
   * ABSENCE, AS A FIRST-CLASS FINDING.
   *
   * The ITOM rules lean on this far harder than the CMDB ones do. "There are no
   * Discovery runs" and "there is no MID server" are the most important things
   * this module can say about an ITOM estate, and both are claims about what
   * was NOT found — so both are only sound on complete coverage, and both go
   * through here rather than being written out by hand each time.
   *
   * `whenEmpty` fires only when the table was read completely AND came back
   * with nothing. A table that could not be read produces a skip with its
   * reason, never a finding: "we could not see Discovery" and "Discovery has
   * never run" are opposite conclusions.
   */
  whenEmpty(tableName, rule, make) {
    const c = this.coverage[tableName] || {};
    /* Emptiness is a property of the ROW set; a dropped field cannot make an
       empty table non-empty, so no fields are required here. */
    if (!this.complete(tableName)) {
      this.skipped.push({
        rule, table: tableName,
        reason: c.status === 'not_requested' ? 'not_requested' : `Complete coverage required; got ${c.status || 'nothing'}`,
      });
      return false;
    }
    if ((this.estate[tableName] || []).length > 0) return false;
    make();
    return true;
  }

  /* ── CMDB quality ─────────────────────────────────────────────────────── */
  cmdbRules() {
    const cis = this.rows('cmdb_ci');
    for (const c of cis) {
      const name = c.name || c.sys_id;
      if ('owned_by' in c && !c.owned_by) {
        this.add('cmdb_agent', 'CMDB-OWNER', 'cmdb_ci', [c], ['owned_by', 'name'],
          `CI has no owner: ${name}`,
          'The owned_by field is empty in the extracted record.',
          { recommendation: 'Ask the service owner to confirm ownership; do not infer an assignee automatically.' });
      }
      const updated = parseDate(c.sys_updated_on);
      if (updated) {
        const days = Math.floor((this.now - updated) / DAY_MS);
        if (days > this.staleDays) {
          this.add('cmdb_agent', 'CMDB-STALE', 'cmdb_ci', [c], ['sys_updated_on', 'last_discovered'],
            `CI record unchanged for ${days} days: ${name}`,
            `No record update in more than ${this.staleDays} days. This is a review signal, not proof of retirement.`,
            {
              confidence: 0.8,
              recommendation: 'Compare fresh Discovery evidence and lifecycle policy before retaining or retiring the CI.',
            });
        }
      }
    }

    /*
     * Duplicate identity by normalised serial within a class. Placeholder
     * serials are excluded — "Unknown" on 400 CIs is one data-entry habit, not
     * 400 duplicates.
     */
    const identifiers = new Map();
    for (const c of this.rows('cmdb_ci', ['serial_number', 'sys_class_name'], { rule: 'CMDB-DUPLICATE' })) {
      const serial = String(c.serial_number).trim().toLowerCase();
      if (serial && !NON_SERIALS.has(serial)) {
        const key = `${serial} ${c.sys_class_name}`;
        if (!identifiers.has(key)) identifiers.set(key, []);
        identifiers.get(key).push(c);
      }
    }
    for (const records of identifiers.values()) {
      if (records.length > 1) {
        this.add('cmdb_agent', 'CMDB-DUPLICATE', 'cmdb_ci', records, ['serial_number', 'name', 'sys_class_name'],
          `${records.length} CIs share a serial number`,
          'Same normalized serial and CI class; identity merge requires corroborating evidence.',
          {
            severity: 'HIGH',
            confidence: 0.8,
            recommendation: 'Compare stable identifiers, Discovery sources and relationships; a human must select any survivor.',
          });
      }
    }
  }

  /* ── Relationship integrity ───────────────────────────────────────────── */
  relationshipRules() {
    /*
     * SUBSUMED BY THE CATALOGUE (Group 6, 16 Sep 2026). These three said, in older
     * words, what CMDB-062, CMDB-069 and CMDB-058 now say with the catalogue's
     * severity, dimension and guards behind them. Running both would report every
     * orphan and every duplicate edge twice — once scored, once not.
     */
    if (RELATIONSHIP_RULES.every((r) => IMPLEMENTED_CATALOGUE_RULES.has(r))) {
      for (const [rule, by] of Object.entries(SUBSUMED_BY_GROUP_6)) {
        this.skipped.push({ rule, table: 'cmdb_rel_ci', reason: `Subsumed by ${by}, which scores in D6 and carries the catalogue's guards` });
      }
      return;
    }
    const relations = this.rows('cmdb_rel_ci', ['parent', 'child', 'type'], { rule: 'REL-SELF' });
    const related = new Set();
    const edgeGroups = new Map();
    for (const r of relations) {
      related.add(r.parent);
      related.add(r.child);
      const key = `${r.parent} ${r.child} ${r.type}`;
      if (!edgeGroups.has(key)) edgeGroups.set(key, []);
      edgeGroups.get(key).push(r);
      if (r.parent && r.parent === r.child) {
        this.add('relationship_agent', 'REL-SELF', 'cmdb_rel_ci', [r], ['parent', 'child', 'type'],
          'CI relationship references itself',
          'The parent and child reference the same CI.', { severity: 'HIGH' });
      }
    }
    for (const records of edgeGroups.values()) {
      if (records.length > 1) {
        this.add('relationship_agent', 'REL-DUPLICATE', 'cmdb_rel_ci', records, ['parent', 'child', 'type'],
          'Duplicate relationship edges',
          'Multiple records have the same parent, child and relationship type.');
      }
    }

    /*
     * ABSENCE RULE — only sound on complete coverage.
     *
     * "No edge references this CI" is a claim about everything that was NOT
     * found, so a partial relationship extract would turn unread rows into
     * orphaned CIs. When coverage falls short the rule does not run and says so.
     */
    if (this.complete('cmdb_rel_ci', ['parent', 'child'])) {
      for (const c of this.rows('cmdb_ci')) {
        if (!related.has(c.sys_id)) {
          this.add('cmdb_agent', 'CMDB-UNRELATED', 'cmdb_ci', [c], ['name', 'sys_class_name'],
            `No visible relationships: ${c.name || c.sys_id}`,
            'No edge references this CI in the complete integration-account-visible relationship extract. Hidden ACL/domain records are outside scope.',
            { severity: 'LOW', confidence: 0.75 });
        }
      }
    } else {
      this.skipped.push({
        rule: 'CMDB-UNRELATED',
        table: 'cmdb_rel_ci',
        reason: 'Relationship coverage incomplete',
      });
    }
  }

  /* ── Service model (CSDM) ─────────────────────────────────────────────── */
  serviceRules() {
    const services = this.rows('cmdb_ci_service', [], { rule: 'CSDM' });
    const offeringsComplete = this.complete('service_offering', ['parent']);
    const parents = new Set(
      this.rows('service_offering', ['parent'], { rule: 'CSDM-OFFERING' }).map((o) => o.parent),
    );
    for (const s of services) {
      const name = s.name || s.sys_id;
      if ('owned_by' in s && !s.owned_by) {
        this.add('csdm_agent', 'CSDM-OWNER', 'cmdb_ci_service', [s], ['owned_by', 'name'],
          `Service has no owner: ${name}`,
          'Service ownership is empty; assignment requires a business decision.');
      }
      if ('life_cycle_stage' in s && !s.life_cycle_stage) {
        this.add('csdm_agent', 'CSDM-LIFECYCLE', 'cmdb_ci_service', [s], ['life_cycle_stage', 'life_cycle_stage_status'],
          `Service lifecycle stage is empty: ${name}`,
          "No lifecycle stage is recorded; validate the instance's CSDM policy before assigning it.");
      }
      if (offeringsComplete && s.sys_class_name === 'cmdb_ci_service' && !parents.has(s.sys_id)) {
        this.add('csdm_agent', 'CSDM-OFFERING', 'cmdb_ci_service', [s], ['name', 'sys_class_name'],
          `No visible service offering: ${name}`,
          'No offering references this business service in the complete visible offering extract.',
          { confidence: 0.85 });
      }
    }
    if (!offeringsComplete) {
      this.skipped.push({
        rule: 'CSDM-OFFERING',
        table: 'service_offering',
        reason: 'Offering coverage incomplete',
      });
    }
  }

  /* ── Platform hygiene: customisation, integration, perf, upgrade, security ── */
  platformRules() {
    for (const r of this.rows('sys_script', ['active', 'script', 'when'], { rule: 'CUSTOM-BEFORE-UPDATE' })) {
      if (truth(r.active) && r.when === 'before' && /\bcurrent\s*\.\s*update\s*\(/.test(r.script || '')) {
        this.add('customization_agent', 'CUSTOM-BEFORE-UPDATE', 'sys_script', [r], ['name', 'collection', 'when', 'script'],
          `Review current.update() in before rule: ${r.name || r.sys_id}`,
          'Static pattern matched current.update() in an active before business rule. Comments or unreachable branches can be false positives; review the code.',
          {
            severity: 'HIGH',
            confidence: 0.85,
            recommendation: 'Review recursion risk and redundant updates in sub-production; package any tested change through your release process.',
          });
      }
    }
    for (const r of this.rows('sys_rest_message', ['rest_endpoint'], { rule: 'INT-HTTP' })) {
      if (String(r.rest_endpoint).toLowerCase().startsWith('http://')) {
        this.add('integration_agent', 'INT-HTTP', 'sys_rest_message', [r], ['name', 'rest_endpoint'],
          `Integration uses HTTP: ${r.name || r.sys_id}`,
          'The configured endpoint starts with unencrypted HTTP; runtime overrides are not evaluated.',
          {
            severity: 'HIGH',
            confidence: 1.0,
            recommendation: 'Confirm endpoint TLS support and test an HTTPS configuration in sub-production.',
          });
      }
    }
    for (const r of this.rows('sys_trigger', ['state'], { rule: 'PERF-JOB-ERROR' })) {
      if (String(r.state) === '3') {
        this.add('performance_agent', 'PERF-JOB-ERROR', 'sys_trigger', [r], ['name', 'state'],
          `Scheduled job is in error state: ${r.name || r.sys_id}`,
          'sys_trigger state equals 3 (error). Inspect scheduler logs before restarting.');
      }
    }
    for (const r of this.rows('ecc_queue', ['state', 'sys_created_on'], { rule: 'PERF-ECC-AGE' })) {
      const created = parseDate(r.sys_created_on);
      if (r.state === 'ready' && created && (this.now - created) / 1000 > 3600) {
        this.add('performance_agent', 'PERF-ECC-AGE', 'ecc_queue', [r], ['state', 'sys_created_on', 'agent'],
          'ECC item has waited over one hour',
          'A ready ECC record is older than one hour; inspect MID connectivity and queue consumers.');
      }
    }
    for (const r of this.rows('sys_upgrade_history_log', ['disposition'], { rule: 'UPGRADE-SKIPPED' })) {
      if (String(r.disposition).toLowerCase() === 'skipped') {
        this.add('upgrade_agent', 'UPGRADE-SKIPPED', 'sys_upgrade_history_log', [r], ['name', 'disposition', 'resolution_status'],
          `Skipped upgrade record needs review: ${r.name || r.sys_id}`,
          'Upgrade disposition is skipped. Check resolution status; a deliberate preserved customization may be acceptable.',
          { confidence: 0.85 });
      }
    }
    for (const r of this.rows('sys_user_has_role', ['user.active', 'user', 'role'], { rule: 'SEC-INACTIVE-ROLE' })) {
      if (['false', '0'].includes(String(r['user.active']).toLowerCase())) {
        this.add('security_agent', 'SEC-INACTIVE-ROLE', 'sys_user_has_role', [r], ['user', 'user.active', 'role', 'role.name'],
          'Inactive user still holds a role',
          'The referenced user is inactive and a role assignment remains.',
          {
            severity: r['role.name'] === 'admin' ? 'HIGH' : 'MEDIUM',
            recommendation: 'Review retention and reactivation policy; remove privileges only through the approved identity process.',
          });
      }
    }
    for (const r of this.rows('ecc_agent', ['status'], { rule: 'MID-DOWN' })) {
      if (String(r.status).toLowerCase() === 'down') {
        this.add('mid_server_agent', 'MID-DOWN', 'ecc_agent', [r], ['name', 'status', 'last_refreshed'],
          `MID server is down: ${r.name || r.sys_id}`,
          'ServiceNow reports this MID server as Down.', { severity: 'HIGH' });
      }
    }
    for (const r of this.rows('em_alert', ['cmdb_ci', 'state'], { rule: 'EVENT-UNBOUND' })) {
      if (!r.cmdb_ci && ['open', 'reopen'].includes(String(r.state).toLowerCase())) {
        this.add('event_management_agent', 'EVENT-UNBOUND', 'em_alert', [r], ['number', 'cmdb_ci', 'state'],
          `Open alert has no CI binding: ${r.number || r.sys_id}`,
          'An open or reopened alert has an empty cmdb_ci reference.');
      }
    }
  }


  /* ── ITOM: is the machinery that maintains the CMDB actually running? ───── */
  itomRules() {
    this.discoveryRules();
    this.credentialRules();
    this.midRules();
    this.serviceMappingRules();
    this.availabilityRules();
  }

  /**
   * DISCOVERY.
   *
   * The most valuable finding here is the absence of any run at all. A CMDB
   * with no Discovery behind it is a snapshot that started going stale the day
   * somebody imported it — and every CMDB rule above will happily report it as
   * healthy, because the records are well-formed. They are just no longer true.
   */
  discoveryRules() {
    const noRuns = this.whenEmpty('discovery_status', 'DISC-NEVER-RAN', () => {
      this.add('discovery_agent', 'DISC-NEVER-RAN', 'discovery_status', [], [],
        'Discovery has never run on this instance',
        'The Discovery status table was read completely and is empty. No Discovery schedule has ever executed, so nothing in the CMDB is being refreshed automatically.',
        {
          severity: 'HIGH',
          recommendation: 'Confirm whether Discovery is meant to be in use here. If it is, a MID server, credentials and a schedule are all required before it can run — check them in that order.',
        });
    });

    /* Every rule below reads runs. With none, they would each add their own
       skip line saying the same thing; one clear finding is better than six. */
    if (noRuns) return;

    for (const r of this.rows('discovery_status', ['state'], { rule: 'DISC-FAILED' })) {
      const state = String(r.state).toLowerCase();
      if (['error', 'cancelled', 'canceled'].includes(state)) {
        this.add('discovery_agent', 'DISC-FAILED', 'discovery_status', [r],
          ['state', 'status', 'scan_type', 'started', 'agent'],
          `Discovery run ended in ${state}: ${r.scan_type || r.sys_id}`,
          `The run finished with state "${state}". CIs it would have created or refreshed were not, so the CMDB is missing whatever that scan covered.`,
          {
            severity: 'HIGH',
            recommendation: 'Open the run and read its Discovery log before re-running. A run that failed once on credentials or a firewall will fail again the same way.',
          });
      }
    }

    /*
     * A schedule that has not completed recently. Measured against the same
     * staleness window the CMDB rules use, so one setting moves both.
     */
    for (const r of this.rows('discovery_status', ['completed'], { rule: 'DISC-STALE' })) {
      const done = parseDate(r.completed);
      if (!done) continue;
      const days = Math.floor((this.now - done) / DAY_MS);
      if (days > this.staleDays) {
        this.add('discovery_agent', 'DISC-STALE', 'discovery_status', [r],
          ['completed', 'scan_type', 'source'],
          `No Discovery completion for ${days} days: ${r.scan_type || r.sys_id}`,
          `The most recent completion of this run is more than ${this.staleDays} days old. Anything it discovers has been drifting since.`,
          {
            confidence: 0.8,
            recommendation: 'Check whether the schedule is still active and whether its MID server is up. A schedule that stopped silently is the usual cause.',
          });
      }
    }

    /* Devices Discovery reached but could not finish with. `issues` is the
       platform's own count, so this is its assessment rather than ours. */
    for (const r of this.rows('discovery_device_history', ['issues'], { rule: 'DISC-DEVICE-ISSUE' })) {
      const issues = Number(r.issues);
      if (Number.isFinite(issues) && issues > 0) {
        this.add('discovery_agent', 'DISC-DEVICE-ISSUE', 'discovery_device_history', [r],
          ['issues', 'source', 'state', 'scan_status', 'cmdb_ci'],
          `Discovery reported ${issues} issue(s) on ${r.source || r.sys_id}`,
          'The device was reached but the scan recorded issues against it, so the CI it produced may be incomplete.',
          {
            confidence: 0.9,
            recommendation: 'Open the device history record and read the issue list. Credentials and permission gaps are the common causes and are fixed once, for every device that shares them.',
          });
      }
    }

    /* Errors the Discovery log itself recorded. */
    for (const r of this.rows('discovery_log', ['level'], { rule: 'DISC-LOG-ERROR' })) {
      if (String(r.level).toLowerCase() === 'error') {
        this.add('discovery_agent', 'DISC-LOG-ERROR', 'discovery_log', [r],
          ['level', 'message', 'source', 'agent'],
          `Discovery logged an error: ${String(r.message || '').slice(0, 70) || r.sys_id}`,
          'Discovery wrote an error-level log entry. The message is the platform\'s own and is reproduced in the evidence.',
          { confidence: 0.9, severity: 'MEDIUM' });
      }
    }
  }

  /**
   * CREDENTIALS.
   *
   * Discovery without a usable credential reaches a device, fails to
   * authenticate, and records a CI with almost nothing on it. That produces
   * CMDB findings that look like data-quality problems and are actually one
   * credential — which is why this is its own domain rather than a Discovery
   * detail.
   */
  credentialRules() {
    const none = this.whenEmpty('discovery_credentials', 'CRED-NONE', () => {
      this.add('credential_agent', 'CRED-NONE', 'discovery_credentials', [], [],
        'No Discovery credentials are configured',
        'The credentials table was read completely and is empty. Discovery can reach a device but cannot authenticate to it, so it can only ever record what an unauthenticated scan reveals.',
        {
          severity: 'HIGH',
          recommendation: 'Add the credentials Discovery needs for each platform in scope. Credentials are also what most "CI has almost no attributes" findings turn out to be.',
        });
    });
    if (none) return;

    const creds = this.rows('discovery_credentials', ['active'], { rule: 'CRED-INACTIVE' });
    for (const c of creds) {
      if (!truth(c.active)) {
        this.add('credential_agent', 'CRED-INACTIVE', 'discovery_credentials', [c],
          ['name', 'active', 'type', 'applies_to'],
          `Credential is inactive: ${c.name || c.sys_id}`,
          'The credential exists but is switched off, so Discovery will not try it.',
          {
            severity: 'MEDIUM',
            confidence: 0.85,
            recommendation: 'Confirm it is inactive on purpose. A credential disabled during an incident and never re-enabled is a common cause of a Discovery that quietly stopped working.',
          });
      }
    }

    /* Every credential inactive is a different, worse fact than one being off,
       and it is only sound on a complete read. */
    const allOff = creds.length > 0 && creds.every((c) => !truth(c.active));
    if (allOff && this.complete('discovery_credentials', ['active'])) {
      this.add('credential_agent', 'CRED-ALL-INACTIVE', 'discovery_credentials', creds,
        ['name', 'active'],
        `All ${creds.length} Discovery credentials are inactive`,
        'Every credential on the instance is switched off. Discovery cannot authenticate to anything.',
        {
          severity: 'HIGH',
          recommendation: 'This is almost always accidental. Re-enable the credentials that should be live before investigating individual Discovery failures.',
        });
    }
  }

  /**
   * MID SERVERS.
   *
   * Nothing in ITOM works without one. "There is no MID server" outranks every
   * other ITOM finding, because Discovery, Service Mapping, Event Management
   * and most integrations all fail the same way behind it.
   */
  midRules() {
    const none = this.whenEmpty('ecc_agent', 'MID-NONE', () => {
      this.add('mid_server_agent', 'MID-NONE', 'ecc_agent', [], [],
        'No MID server is configured',
        'The MID server table was read completely and is empty. Discovery, Service Mapping, Orchestration and any integration configured to use a MID cannot run at all.',
        {
          severity: 'HIGH',
          recommendation: 'If ITOM is meant to be in use here, install and validate a MID server first — every other ITOM finding is downstream of this one.',
        });
    });
    if (none) return;

    const mids = this.rows('ecc_agent', ['validated'], { rule: 'MID-NOT-VALIDATED' });
    for (const m of mids) {
      /* Up but not validated is the failure mode people miss: the dashboard
         reads green and the MID still refuses to accept work. */
      if (!truth(m.validated) && String(m.status).toLowerCase() !== 'down') {
        this.add('mid_server_agent', 'MID-NOT-VALIDATED', 'ecc_agent', [m],
          ['name', 'status', 'validated', 'last_refreshed'],
          `MID server is up but not validated: ${m.name || m.sys_id}`,
          'The MID reports a status other than Down, but the instance has not validated it. An unvalidated MID does not pick up work, and the status alone reads as healthy.',
          {
            severity: 'HIGH',
            confidence: 0.9,
            recommendation: 'Open the MID server record and run Validate. A MID that will not validate usually has a certificate, user-role or version mismatch.',
          });
      }
    }

    /* A MID with no capabilities cannot be chosen for any work. Only sound when
       the capability table was read completely. */
    if (this.complete('ecc_agent_capability', ['agent'])) {
      const withCap = new Set(
        this.rows('ecc_agent_capability', ['agent'], { rule: 'MID-NO-CAPABILITY' }).map((c) => c.agent),
      );
      for (const m of mids) {
        if (!withCap.has(m.sys_id) && !withCap.has(m.name)) {
          this.add('mid_server_agent', 'MID-NO-CAPABILITY', 'ecc_agent', [m],
            ['name', 'status'],
            `MID server has no capabilities: ${m.name || m.sys_id}`,
            'No capability record references this MID in the complete capability extract, so the instance has nothing it can select this MID to do.',
            {
              confidence: 0.8,
              recommendation: 'Capabilities are normally populated automatically once a MID validates. A MID with none is usually one that has never completed validation.',
            });
        }
      }
    } else {
      this.skipped.push({ rule: 'MID-NO-CAPABILITY', table: 'ecc_agent_capability', reason: 'Complete coverage required' });
    }

    for (const i of this.rows('ecc_agent_issue', ['state'], { rule: 'MID-ISSUE' })) {
      if (!['resolved', 'closed'].includes(String(i.state).toLowerCase())) {
        this.add('mid_server_agent', 'MID-ISSUE', 'ecc_agent_issue', [i],
          ['agent', 'issue', 'state', 'severity'],
          `Open MID server issue: ${String(i.issue || '').slice(0, 60) || i.sys_id}`,
          'The platform raised an issue against this MID server and it has not been resolved.',
          { severity: 'HIGH', confidence: 0.9 });
      }
    }
  }

  /**
   * SERVICE MAPPING.
   *
   * Answers one question: are discovered services actually connected to the CIs
   * that deliver them? A service with no mapping is a name in a list — impact
   * analysis walks nothing from it.
   */
  serviceMappingRules() {
    const discovered = this.rows('cmdb_ci_service_discovered', [], { rule: 'SM' });
    if (!discovered.length) {
      this.skipped.push({ rule: 'SM-UNMAPPED', table: 'cmdb_ci_service_discovered', reason: 'No discovered services to check' });
      return;
    }

    if (!this.complete('svc_ci_assoc', ['service'])) {
      this.skipped.push({ rule: 'SM-UNMAPPED', table: 'svc_ci_assoc', reason: 'Complete coverage required' });
      return;
    }

    const links = this.rows('svc_ci_assoc', ['service'], { rule: 'SM-UNMAPPED' });
    const mapped = new Set(links.map((l) => l.service));

    if (!links.length) {
      this.add('service_mapping_agent', 'SM-NOT-IN-USE', 'svc_ci_assoc', [], [],
        `${discovered.length} discovered service(s) exist, and none is mapped to any CI`,
        'The service-to-CI association table was read completely and is empty, while discovered services do exist. Nothing connects those services to the infrastructure underneath them.',
        {
          severity: 'HIGH',
          recommendation: 'Service Mapping produces these associations. If it is licensed and expected here, check whether any mapping has ever run; if not, the services need their CIs associated another way before impact analysis means anything.',
        });
      return;
    }

    for (const s of discovered) {
      if (!mapped.has(s.sys_id)) {
        this.add('service_mapping_agent', 'SM-UNMAPPED', 'cmdb_ci_service_discovered', [s],
          ['name', 'operational_status', 'service_classification'],
          `Service is not mapped to any CI: ${s.name || s.sys_id}`,
          'No association in the complete service-to-CI extract references this service, so nothing downstream of it is known.',
          {
            confidence: 0.85,
            recommendation: 'Run or repair the mapping for this service. Until it has CIs, impact analysis and change risk report nothing against it.',
          });
      }
    }
  }

  /**
   * AVAILABILITY.
   *
   * An outage record with a start and no end is either a live outage or a
   * record nobody closed. Both are worth surfacing, and the finding says it
   * cannot tell them apart.
   */
  availabilityRules() {
    for (const o of this.rows('cmdb_ci_outage', ['begin'], { rule: 'OUTAGE-OPEN' })) {
      const began = parseDate(o.begin);
      if (!began || o.end) continue;
      const hours = Math.floor((this.now - began) / 3_600_000);
      if (hours < 24) continue;   // a young open outage is probably just ongoing
      this.add('availability_agent', 'OUTAGE-OPEN', 'cmdb_ci_outage', [o],
        ['cmdb_ci', 'type', 'begin', 'details'],
        `Outage open for ${Math.floor(hours / 24)} day(s) with no end recorded`,
        'The outage has a start and no end. Either it is still running, or it ended and the record was never closed — this rule cannot tell which, and availability reporting counts it as ongoing either way.',
        {
          confidence: 0.75,
          severity: 'MEDIUM',
          recommendation: 'Confirm with the service owner whether it is still down. If it is over, set the end time — every availability figure for that CI is wrong until you do.',
        });
    }
  }


  /* ── ITSM: is the work that runs on top of the CMDB flowing? ─────────────── */

  /**
   * THE ITSM RULES.
   *
   * These tables were extracted from the first release and no rule read them,
   * so ITSM produced nothing — not "healthy", NOTHING. That is the gap closed
   * here.
   *
   * Every rule works on OPEN records, or on recent outcomes, and says so:
   * incident, change and problem are read as a slice (active, or updated inside
   * the window), so a finding about a record from three years ago cannot appear
   * — and cannot be counted against a score that claims to describe now.
   *
   * State and priority are read as raw values. `active` is the field every
   * task table agrees on; the numeric state codes differ between incident,
   * change and problem and are instance-configurable (trap #28 — hardcoded
   * platform code lists go stale silently), so no rule keys off a state number.
   */
  itsmRules() {
    this.incidentRules();
    this.changeRules();
    this.problemRules();
  }

  /** Days an OPEN task may go without an update before it is a review signal. */
  static ITSM_STALE_DAYS = 30;

  incidentRules() {
    const open = this.rows('incident', ['active'], { rule: 'ITSM' }).filter((r) => truth(r.active));

    for (const r of open) {
      const label = r.number || r.sys_id;
      const pri = String(r.priority || '');

      /* Unassigned. Only on records that actually carry the field — a hidden
         `assignment_group` is a coverage gap, not an unassigned incident. */
      if ('assignment_group' in r && !r.assignment_group) {
        this.add('incident_agent', 'ITSM-INC-UNASSIGNED', 'incident', [r],
          ['number', 'assignment_group', 'priority', 'short_description'],
          `Open incident has no assignment group: ${label}`,
          'The incident is active and nobody is assigned to work it, so no queue will pick it up.',
          {
            severity: ['1', '2'].includes(pri) ? 'HIGH' : 'MEDIUM',
            recommendation: 'Route it to the group that owns the affected service or CI. If this happens often, the assignment rules are what need fixing, not each incident.',
          });
      }

      /* A P1 that has been open for more than a day. */
      const created = parseDate(r.sys_created_on);
      if (pri === '1' && created && (this.now - created) > DAY_MS) {
        const days = Math.floor((this.now - created) / DAY_MS);
        this.add('incident_agent', 'ITSM-INC-P1-AGED', 'incident', [r],
          ['number', 'priority', 'sys_created_on', 'assignment_group'],
          `Priority 1 incident open for ${days} day(s): ${label}`,
          `A priority 1 incident has been open for ${days} day(s). Either the outage is still running, or the record was not resolved when service came back.`,
          {
            severity: 'HIGH',
            confidence: 0.9,
            recommendation: 'Confirm with the assignment group whether it is still live. If service is restored, resolve it — every P1 metric counts it as ongoing until you do.',
          });
      }

      /* Open and untouched. */
      const updated = parseDate(r.sys_updated_on);
      if (updated) {
        const idle = Math.floor((this.now - updated) / DAY_MS);
        if (idle > EstateRules.ITSM_STALE_DAYS) {
          this.add('incident_agent', 'ITSM-INC-STALE', 'incident', [r],
            ['number', 'sys_updated_on', 'assignment_group', 'assigned_to'],
            `Open incident untouched for ${idle} days: ${label}`,
            `The incident is active and has not been updated in ${idle} days. That is a review signal — it may be waiting on a user, or it may have been forgotten.`,
            {
              confidence: 0.8,
              recommendation: 'Ask the assignee for a status. If it is waiting on the caller, put it on hold with a reason so it stops looking abandoned.',
            });
        }
      }

      /* No CI, so impact analysis cannot connect it to anything. */
      if ('cmdb_ci' in r && !r.cmdb_ci && !r.business_service) {
        this.add('incident_agent', 'ITSM-INC-NO-CI', 'incident', [r],
          ['number', 'cmdb_ci', 'business_service', 'short_description'],
          `Open incident is not linked to any CI or service: ${label}`,
          'Neither a configuration item nor a business service is set, so this incident is invisible to impact analysis, problem trending and CI health.',
          {
            severity: 'LOW',
            confidence: 0.9,
            recommendation: 'Link the affected CI. When many incidents arrive without one, the fix is usually the intake form or the integration that raises them.',
          });
      }
    }

    /* Reopened repeatedly — recent history, so closed ones count too. */
    for (const r of this.rows('incident', ['reopen_count'], { rule: 'ITSM-INC-REOPENED' })) {
      const n = Number(r.reopen_count);
      if (Number.isFinite(n) && n >= 2) {
        this.add('incident_agent', 'ITSM-INC-REOPENED', 'incident', [r],
          ['number', 'reopen_count', 'assignment_group'],
          `Incident reopened ${n} times: ${r.number || r.sys_id}`,
          `The incident was reopened ${n} times, which usually means it was resolved before the underlying cause was fixed.`,
          {
            recommendation: 'Look at why it keeps coming back. Repeated reopens are a strong signal that a problem record is needed.',
          });
      }
    }
  }

  changeRules() {
    const all = this.rows('change_request', ['active'], { rule: 'ITSM' });

    for (const r of all.filter((x) => truth(x.active))) {
      const label = r.number || r.sys_id;
      const updated = parseDate(r.sys_updated_on);
      if (updated) {
        const idle = Math.floor((this.now - updated) / DAY_MS);
        if (idle > EstateRules.ITSM_STALE_DAYS) {
          this.add('change_agent', 'ITSM-CHG-STALE', 'change_request', [r],
            ['number', 'state', 'sys_updated_on', 'assignment_group'],
            `Open change untouched for ${idle} days: ${label}`,
            `The change is active and has not been updated in ${idle} days. An open change that nobody is moving blocks the CAB calendar and hides the real schedule.`,
            {
              confidence: 0.8,
              recommendation: 'Confirm whether it is still planned. Cancel it with a reason if not, rather than leaving it open.',
            });
        }
      }

      if ('cmdb_ci' in r && !r.cmdb_ci) {
        this.add('change_agent', 'ITSM-CHG-NO-CI', 'change_request', [r],
          ['number', 'cmdb_ci', 'short_description'],
          `Open change names no configuration item: ${label}`,
          'The change does not reference a CI, so conflict detection and impact analysis have nothing to check it against.',
          {
            severity: 'MEDIUM',
            confidence: 0.9,
            recommendation: 'Set the CI the change actually touches before it is approved — risk assessment without one is a guess.',
          });
      }

      /* Past its own planned end and still open. */
      const planned = parseDate(r.end_date);
      if (planned && planned < this.now) {
        const over = Math.floor((this.now - planned) / DAY_MS);
        if (over >= 1) {
          this.add('change_agent', 'ITSM-CHG-OVERDUE', 'change_request', [r],
            ['number', 'end_date', 'state'],
            `Change is ${over} day(s) past its planned end and still open: ${label}`,
            'The planned end date has passed and the change is still active. Either implementation overran, or the record was never closed.',
            {
              severity: 'MEDIUM',
              confidence: 0.85,
              recommendation: 'Close it with the real outcome, or reschedule it. An overdue open change makes the change calendar lie.',
            });
        }
      }
    }

    /* Recent failed changes. `close_code` values are the platform's own words. */
    for (const r of this.rows('change_request', ['close_code'], { rule: 'ITSM-CHG-FAILED' })) {
      if (String(r.close_code).toLowerCase() === 'unsuccessful') {
        this.add('change_agent', 'ITSM-CHG-FAILED', 'change_request', [r],
          ['number', 'close_code', 'cmdb_ci'],
          `Change closed as unsuccessful: ${r.number || r.sys_id}`,
          'The change was closed with an unsuccessful outcome inside the review window.',
          {
            severity: 'MEDIUM',
            recommendation: 'Check a post-implementation review exists and that the CI was left in a known state.',
          });
      }
    }
  }

  problemRules() {
    for (const r of this.rows('problem', ['active'], { rule: 'ITSM' }).filter((x) => truth(x.active))) {
      const label = r.number || r.sys_id;

      if ('assignment_group' in r && !r.assignment_group) {
        this.add('problem_agent', 'ITSM-PRB-UNASSIGNED', 'problem', [r],
          ['number', 'assignment_group', 'short_description'],
          `Open problem has no assignment group: ${label}`,
          'The problem is active and nobody owns the investigation, so the root cause is not being worked.',
          {
            severity: 'MEDIUM',
            recommendation: 'Assign it to the group that owns the affected service. An unowned problem is a known cause nobody is fixing.',
          });
      }

      const updated = parseDate(r.sys_updated_on);
      if (updated) {
        const idle = Math.floor((this.now - updated) / DAY_MS);
        if (idle > EstateRules.ITSM_STALE_DAYS) {
          this.add('problem_agent', 'ITSM-PRB-STALE', 'problem', [r],
            ['number', 'sys_updated_on', 'assignment_group'],
            `Open problem untouched for ${idle} days: ${label}`,
            `The problem is active and has not been updated in ${idle} days.`,
            {
              severity: 'LOW',
              confidence: 0.8,
              recommendation: 'Either record a known error and workaround, or close it with the reason. A stalled problem keeps its incidents looking unexplained.',
            });
        }
      }
    }
  }

  /**
   * Blast radius and priority.
   *
   * Walks the undirected relationship graph out to depth 3 from each finding's
   * targets. The number it produces is REACHABILITY, and the finding says so in
   * `impact.interpretation` — topology for review, not proven outage
   * propagation. Calling it "impact" without that sentence is how a graph
   * statistic becomes a business claim nobody verified.
   */
  synthesize() {
    const graph = new Map();
    const link = (a, b) => {
      if (!graph.has(a)) graph.set(a, new Set());
      graph.get(a).add(b);
    };
    const ciIds = new Set((this.estate.cmdb_ci || []).map((c) => c.sys_id));
    const serviceIds = new Set((this.estate.cmdb_ci_service || []).map((s) => s.sys_id));
    const relById = new Map((this.estate.cmdb_rel_ci || []).map((r) => [r.sys_id, r]));
    for (const r of relById.values()) {
      if (r.parent && r.child) { link(r.parent, r.child); link(r.child, r.parent); }
    }

    for (const f of this.findings) {
      const seeds = new Set(f.target_ids.filter((id) => ciIds.has(id) || serviceIds.has(id)));
      if (f.table === 'cmdb_rel_ci') {
        for (const sid of f.target_ids) {
          const rel = relById.get(sid);
          if (rel?.parent) seeds.add(rel.parent);
          if (rel?.child) seeds.add(rel.child);
        }
      }
      const visited = new Set(seeds);
      let frontier = [...seeds];
      for (let depth = 0; depth < 3 && frontier.length; depth++) {
        const next = [];
        for (const node of frontier) {
          for (const neighbour of graph.get(node) || []) {
            if (!visited.has(neighbour)) { visited.add(neighbour); next.push(neighbour); }
          }
        }
        frontier = next;
      }

      f.affected_ci_ids = [...visited].filter((id) => ciIds.has(id)).sort();
      f.affected_service_ids = [...visited].filter((id) => serviceIds.has(id)).sort();
      f.impact = f.estate_wide
        ? {
          reachable_nodes: null,
          max_depth: null,
          direction: 'estate',
          interpretation: 'Estate-wide: this names no individual records because the records are what is missing',
        }
        : {
          reachable_nodes: visited.size,
          max_depth: 3,
          direction: 'undirected',
          interpretation: 'Topology reachability for review, not proven outage propagation',
        };

      const severity = SEVERITY_RANK[f.severity];
      /*
       * An estate-wide finding takes the MAXIMUM business and dependency
       * proxies rather than the minimum. It names no records because the
       * records are what is absent, and "no MID server" is upstream of every
       * other ITOM finding rather than smaller than all of them.
       */
      const business = f.estate_wide ? 5 : 1 + Math.min(f.affected_service_ids.length, 4);
      const dependency = f.estate_wide ? 2 : 1 + Math.min(visited.size, 20) / 20;
      f.priority_score = Number((severity * business * dependency * f.confidence).toFixed(3));
      f.priority_factors = {
        severity,
        business_impact_proxy: business,
        dependency_criticality_proxy: dependency,
        confidence: f.confidence,
        remediation_value: 1,
        effort: 1,
        note: 'Value/effort default to 1 pending human assessment',
      };
      f.priority = f.priority_score >= 20 ? 'P1' : f.priority_score >= 8 ? 'P2' : 'P3';
    }

    this.findings.sort((a, b) => (b.priority_score - a.priority_score)
      || a.fingerprint.localeCompare(b.fingerprint));
  }
}
