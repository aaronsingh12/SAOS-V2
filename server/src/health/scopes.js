import { isComplete, AGENTS } from './rules.js';
import { REMEDIATION } from './remediation.js';
import { scoreItsmQuality } from './itsm-quality.js';
import { moduleContract, scoreOverall, SCORABLE_MODULES, DEFAULT_WEIGHTS } from './overall-health.js';
import crypto from 'node:crypto';

/**
 * Scopes — CMDB, ITOM, ITSM and Platform, and what "score" honestly means for each.
 *
 * PURE. Coverage and findings in, summaries out: no socket, no database, no
 * model. The same function runs at the end of a check and against a stored run,
 * which is what lets an older run be re-read under the new switch without being
 * re-extracted.
 *
 * ═══ WHY THE SCORES ARE NOT ALL THE SAME KIND ═══
 *
 * A single formula applied to every scope would produce four numbers that look
 * comparable and are not.
 *
 *   CMDB  — the SAOS CMDB Quality score, in two layers (see cmdb-quality.js):
 *           a TRUST GATE that says whether the number may be believed at all,
 *           and a COMPOSITE of ten weighted dimensions over the dimensions
 *           actually measured. It is not a pass rate: the first version was the
 *           share of CIs no rule objected to, where one Low finding failed a
 *           whole record — which is how an estate scored 0.3%.
 *   ITSM  — ITSM QUALITY (itsm-quality.js, 21 Sep 2026): the same two-part
 *           shape as CMDB. A record in the open-or-recent incident, change and
 *           problem slice starts at 100 and loses the weight of each distinct
 *           charge on it, floored at 0; that mean is blended 60/40 with the
 *           share of estate-level catalogue rules that pass. It replaced a
 *           record pass rate in which one Moderate finding failed a whole
 *           record — the shape that scored an estate 0.7.
 *   ITOM  — a CHECK score. ITOM's important findings are about ABSENCE — no MID
 *           server, Discovery never ran — and name no records at all. "No MID
 *           server" cannot be a percentage of rows, so ITOM is scored as the
 *           share of applicable capability checks that pass.
 *   Platform — NO score. 42,000 role assignments and fourteen integrations have
 *           no shared denominator; any percentage would be decided by whichever
 *           table happened to be largest, which is a fact about table sizes and
 *           not about health. It says so rather than printing one.
 *
 * ═══ THE RULE EVERY SCORE OBEYS ═══
 *
 * A score only ever describes what was read. A table whose rows were not all
 * read is EXCLUDED from its scope's denominator and named in `basis`; if nothing
 * usable is left, the score is withheld with the specific reason. A check whose
 * table could not be read is `not_applicable`, never a pass — "we could not see
 * the MID server table" must not score as "the MID servers are fine".
 */

const CMDB_DOMAINS = ['CMDB', 'CMDB_GOVERNANCE', 'RELATIONSHIP', 'FRESHNESS', 'LIFECYCLE', 'ATTESTATION', 'OWNERSHIP', 'CSDM'];
const ITOM_DOMAINS = ['DISCOVERY', 'CREDENTIALS', 'MID_SERVER', 'SERVICE_MAPPING', 'EVENT_MANAGEMENT', 'AVAILABILITY'];
/* `ITSM` is the domain of the 139-rule catalogue's findings (ITSM Phase 5); the
   other three are the eleven hard-coded rules'. All four ROUTE to the ITSM scope. */
const ITSM_DOMAINS = ['INCIDENT', 'CHANGE', 'PROBLEM', 'ITSM'];
/*
 * THE LEGACY ITSM DOMAINS — the eleven hard-coded rules'. Until 21 Sep 2026
 * these three domains were the whole ITSM score (a record pass rate); under
 * ITSM Quality (itsm-quality.js) their findings charge records beside the
 * catalogue's, and the constant remains as the name of that family.
 */
export const ITSM_SCORED_DOMAINS = Object.freeze(['INCIDENT', 'CHANGE', 'PROBLEM']);
const PLATFORM_DOMAINS = ['CUSTOMIZATION', 'INTEGRATION', 'PERFORMANCE', 'UPGRADE', 'SECURITY'];

/**
 * Rules whose DOMAIN would put them in the wrong scope.
 *
 * `PERF-ECC-AGE` was written under Performance, but a stuck ECC queue means a
 * MID server is not collecting work — an ITOM fact, and the fix lives with
 * ITOM. Moving the rule's domain would change what older runs report, so the
 * scope is overridden here instead and nothing stored changes meaning.
 */
export const RULE_SCOPE = Object.freeze({ 'PERF-ECC-AGE': 'itom' });

export const SCOPES = Object.freeze([
  {
    key: 'all',
    label: 'All',
    description: 'Every finding across CMDB, ITOM, ITSM and platform hygiene.',
    domains: null,
    tables: null,
  },
  {
    key: 'cmdb',
    label: 'CMDB',
    description: 'Are the configuration records themselves right — owned, current, related and unique?',
    domains: CMDB_DOMAINS,
    tables: ['cmdb_ci', 'cmdb_rel_ci', 'cmdb_ci_service', 'service_offering', 'cmdb_health_config', 'cmdb_health_metric',
      'cmdb_health_metric_pref', 'cmdb_class_info', 'cmdb_recommended_fields', 'cmdb_data_management_policy',
      'cmdb_policy_scheduled_job', 'sysauto_script', 'cmn_location', 'core_company', 'cmdb_identifier', 'cmdb_identifier_entry',
      'life_cycle_stage_status', 'svc_ci_assoc', 'change_request', 'life_cycle_mapping', 'life_cycle_control',
      'cmdb_reconciliation_definition', 'cmdb_datasource_attribute_value', 'reconcile_duplicate_task', 'duplicate_audit_result',
      'sys_object_source', 'cmdb_datasource_precedence', 'cmdb_datasource_last_update', 'cmdb_datasource_staleness',
      'cmdb_ire_output_aggregate_stats', 'cmdb_metadata_hosting', 'cmdb_metadata_containment', 'cmdb_rel_type',
      'discovery_schedule', 'discovery_device_history', 'discovery_range_item', 'alm_asset',
      'cert_audit', 'cert_audit_result', 'cert_filter', 'cert_follow_on_task', 'sys_archive', 'sys_archive_destroy', 'sys_user_grmember',
      'sys_table_rotation', 'cmdb_data_management_task'],
      /* `sys_audit` is deliberately ABSENT. It is opt-in (see `optIn` in
         tables.js): naming it here would make every CMDB scan read it, which is
         exactly the default the opt-in exists to prevent. A caller enables it by
         passing it in `tables`. */
    scoreKind: 'records',
  },
  {
    key: 'itom',
    label: 'ITOM',
    description: 'Is anything keeping the CMDB true — MID servers, Discovery, credentials, mapping, events?',
    domains: ITOM_DOMAINS,
    tables: ['ecc_agent', 'ecc_agent_capability', 'ecc_agent_issue', 'ecc_queue', 'discovery_status',
      'discovery_device_history', 'discovery_log', 'discovery_credentials', 'svc_ci_assoc',
      'cmdb_ci_service_discovered', 'em_alert', 'cmdb_ci_outage'],
    scoreKind: 'checks',
  },
  {
    key: 'itsm',
    label: 'ITSM',
    description: 'Is the work running on top of the CMDB flowing — assigned, moving, linked and closed?',
    domains: ITSM_DOMAINS,
    tables: ['incident', 'change_request', 'problem'],
    scoreKind: 'records',
  },
  {
    key: 'platform',
    label: 'Platform',
    description: 'Business rules, integrations, scheduled jobs, upgrades and access hygiene.',
    domains: PLATFORM_DOMAINS,
    tables: ['sys_script', 'sys_rest_message', 'sys_trigger', 'sysauto', 'sys_upgrade_history_log', 'sys_user_has_role'],
    scoreKind: 'none',
  },
]);

export const SCOPE_KEYS = Object.freeze(SCOPES.map((s) => s.key));
const byKey = Object.fromEntries(SCOPES.map((s) => [s.key, s]));

/**
 * MODULES — the scopes a scan can be limited to. `all` is a view, not a module.
 *
 * A scan names the modules it checks; each module then keeps its own latest
 * result and timestamp, so an ITSM-only scan leaves the CMDB result where the
 * last CMDB scan put it.
 */
export const MODULE_KEYS = Object.freeze(SCOPES.filter((s) => s.domains).map((s) => s.key));

/** A requested module list, validated. Nothing, `all` or an empty list means every module. */
export function normaliseModules(input) {
  if (input == null || input === 'all' || (Array.isArray(input) && input.length === 0)) return [...MODULE_KEYS];
  const list = (Array.isArray(input) ? input : [input]).map((m) => String(m).toLowerCase());
  const unknown = list.filter((m) => !MODULE_KEYS.includes(m));
  if (unknown.length) {
    throw Object.assign(new Error(`Unknown scan module: ${unknown.join(', ')}. Choose from ${MODULE_KEYS.join(', ')}.`), { status: 422 });
  }
  return MODULE_KEYS.filter((m) => list.includes(m));
}

/** The tables a set of modules reads — each module's declared list, united. */
export function moduleTables(modules) {
  return [...new Set(normaliseModules(modules).flatMap((m) => byKey[m].tables || []))];
}

/**
 * Which module a RULE belongs to, from its id alone.
 *
 * A skipped check carries only its rule id, and a module-limited scan must drop
 * the skips of modules it did not check — otherwise an ITSM-only scan would
 * report every CMDB rule as "not run". `scopeOf` routes FINDINGS by this same
 * prefix first (and by domain only for an id no prefix claims), so a rule's
 * findings and its skips can never land in different modules — see `scopeOf`
 * for the Group 13 findings that did. Tests hold the two answers equal for every
 * catalogue rule under any domain.
 */
/*
 * The prefixes are DATA, not regular expressions, because the SQL filter
 * (`scopeFilter`) must route stored findings exactly as `scopeOf` routes them in
 * memory, and both are derived from this one table. `exact` names a rule id that
 * is a family label rather than a rule: the eleven legacy ITSM rules log their
 * table skips as rule `ITSM`, which a prefix of `ITSM-` never matched — those
 * skips routed to Platform and were dropped from every ITSM-only scan. The CSDM
 * service rules (`serviceRules`) and the ITOM service-mapping rules
 * (`serviceMappingRules`) log theirs as `CSDM` and `SM` — the same defect, found
 * in the Phase 6 discovery (PHASE6-DISCOVERY.md §6 D2).
 */
export const RULE_PREFIXES = Object.freeze([
  Object.freeze({ key: 'cmdb', prefixes: Object.freeze(['CMDB-', 'REL-', 'CSDM-']), exact: Object.freeze(['CSDM']) }),
  Object.freeze({ key: 'itom', prefixes: Object.freeze(['MID-', 'DISC-', 'CRED-', 'SM-', 'EVENT-', 'OUTAGE-']), exact: Object.freeze(['SM']) }),
  Object.freeze({ key: 'itsm', prefixes: Object.freeze(['ITSM-']), exact: Object.freeze(['ITSM']) }),
]);
const prefixScopeOf = (ruleId) => {
  const id = String(ruleId || '');
  for (const p of RULE_PREFIXES) if (p.exact.includes(id) || p.prefixes.some((x) => id.startsWith(x))) return p.key;
  return null;
};
export function scopeOfRule(ruleId) {
  const override = RULE_SCOPE[ruleId];
  if (override) return override;
  return prefixScopeOf(ruleId) ?? 'platform';
}

/** Which scope a finding belongs to. A rule override outranks its domain. */
export function scopeOf(finding) {
  const override = RULE_SCOPE[finding?.rule_id];
  if (override) return override;
  /*
   * A RULE'S FINDINGS AND ITS SKIPS MUST LAND IN THE SAME MODULE.
   *
   * Skips carry only a rule id and are routed by its prefix (`scopeOfRule`);
   * findings used to be routed by DOMAIN alone. Measured on dev424910, Sep 2026:
   * the Group 13 scale rules (CMDB-124…130) report through `performance_agent`,
   * whose domain belongs to Platform, so on every CMDB-only scan their FINDINGS
   * were filtered out while their skips stayed — CMDB-124 was out of band and
   * showed neither a finding nor a skip. The rules only run when CMDB is
   * scanned, so they could only ever appear on a scan of CMDB and Platform
   * together. Its fixture tests called the pack directly and never passed
   * through this filter. The prefix now decides first; the domain decides only
   * for a rule id no module prefix claims.
   */
  const byPrefix = prefixScopeOf(finding?.rule_id);
  if (byPrefix) return byPrefix;
  const domain = finding?.domain;
  for (const s of SCOPES) if (s.domains?.includes(domain)) return s.key;
  /* A domain no scope claims belongs to Platform rather than vanishing: a
     finding the switch cannot show is a finding nobody reads. */
  return 'platform';
}

export function inScope(finding, key) {
  return !key || key === 'all' || scopeOf(finding) === key;
}

/** Accept only a known scope; anything else is `all`, never an empty view. */
export function normaliseScope(key) {
  return SCOPE_KEYS.includes(key) ? key : 'all';
}

/**
 * The SQL shape of a scope, for filtering stored findings.
 *
 * It is `scopeOf` written in SQL, in the same order: a rule override, then the
 * rule-id prefix, then the domain, then Platform for a domain no scope claims.
 * The first version filtered by domain alone, while `scopeOf` had learned to
 * route by prefix first — so the CMDB-124…130 findings (domain PERFORMANCE) were
 * counted in the CMDB summary and missing from the CMDB list, and the ITSM
 * catalogue's findings (domain ITSM) would have been missing from every list.
 * The parity test now covers prefixed rules under a foreign domain.
 */
export function scopeFilter(key) {
  const scope = byKey[normaliseScope(key)];
  if (!scope?.domains) return null;
  const args = [];
  const marks = (xs) => { args.push(...xs); return xs.map(() => '?').join(','); };
  const matches = (p) => {
    const parts = p.prefixes.map((x) => { args.push(x.length, x); return 'substr(rule_id, 1, ?) = ?'; });
    if (p.exact.length) parts.push(`rule_id IN (${marks(p.exact)})`);
    return `(${parts.join(' OR ')})`;
  };
  const overrides = Object.entries(RULE_SCOPE);
  const into = overrides.filter(([, k]) => k === scope.key).map(([r]) => r);
  const own = RULE_PREFIXES.find((p) => p.key === scope.key);

  const branches = [];
  if (into.length) branches.push(`rule_id IN (${marks(into)})`);
  const routed = [];
  if (overrides.length) routed.push(`rule_id NOT IN (${marks(overrides.map(([r]) => r))})`);
  const byPrefix = own ? matches(own) : null;
  const noPrefix = `NOT (${RULE_PREFIXES.map(matches).join(' OR ')})`;
  const byDomain = scope.key === 'platform'
    /* scopeOf's fallback: any domain the other scopes do not claim is Platform's. */
    ? `domain NOT IN (${marks(SCOPES.filter((x) => x.domains && x.key !== 'platform').flatMap((x) => x.domains))})`
    : `domain IN (${marks(scope.domains)})`;
  routed.push(byPrefix ? `(${byPrefix} OR (${noPrefix} AND ${byDomain}))` : `(${noPrefix} AND ${byDomain})`);
  branches.push(`(${routed.join(' AND ')})`);
  return { clause: `(${branches.join(' OR ')})`, args };
}

/**
 * WHAT IS PULLING A RECORD SCORE DOWN.
 *
 * Added after a live run returned a CMDB score of 0.3% — correct, and useless on
 * its own. The breakdown was: 3,233 of 3,412 CIs with no owner, 3,211 with no
 * relationships, 2,956 unchanged for 90 days. Re-weighting the score to soften
 * that would have been flattering a number that is true; saying WHICH rules
 * account for it, by how many distinct records, is what makes it actionable —
 * fixing ownership is plainly the largest single lever.
 *
 * Counted as DISTINCT records per rule, so a CI with the same rule twice is one,
 * and shares are of the scanned set — they overlap and are not meant to sum.
 */
function drivers(findings, { domains, tables = null, scanned }) {
  const byRule = new Map();
  for (const f of findings) {
    if (!domains.includes(f.domain)) continue;
    if (tables && !tables.includes(f.table)) continue;
    if (!byRule.has(f.rule_id)) byRule.set(f.rule_id, { severity: f.severity, ids: new Set() });
    for (const id of f.target_ids || []) byRule.get(f.rule_id).ids.add(`${f.table}:${id}`);
  }
  return [...byRule.entries()]
    .map(([rule, v]) => ({
      rule_id: rule,
      label: REMEDIATION[rule]?.headline ?? rule,
      severity: v.severity,
      records: v.ids.size,
      share: scanned ? pct((100 * v.ids.size) / scanned) : null,
    }))
    .filter((d) => d.records > 0)
    .sort((a, b) => b.records - a.records)
    .slice(0, 8);
}

const countBy = (xs, f) => xs.reduce((acc, x) => { const k = f(x); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
const pct = (n) => Number(n.toFixed(1));
const fmt = (n) => Number(n).toLocaleString('en-US');

/* ── Record scores ─────────────────────────────────────────────────────────── */

/**
 * CMDB under the SAOS CMDB Quality model: the composite over measured
 * dimensions. Provisional while a trust-gate blocker is live; withheld, with
 * the reason, while no dimension is measured.
 */
function cmdbQualityScore(q, coverage, findings, comparability = null) {
  const legacyDrivers = cmdbScore(coverage, findings).drivers ?? null;
  const c = q.composite;
  const measured = q.dimensions.filter((d) => d.measured);
  return {
    score: c.score,
    scoring: { model: 'cmdb-quality/1', key: comparability?.key ?? null },
    basis: c.score == null ? null
      : `${measured.length} of ${q.dimensions.length} dimensions measured (${c.measured_weight} of 100 weight) over ${q.in_scope.records.toLocaleString()} in-scope CIs — ${q.in_scope.basis}`,
    definition: c.definition,
    withheld: c.score == null
      ? `${c.not_measured_because} ${q.rules.built} of ${q.rules.catalogued} catalogue rules are built. The trust gate sits outside the 100, so a gate result alone is not a score.`
      : null,
    drivers: legacyDrivers,
  };
}

/** CMDB: the pass-rate definition, kept for runs recorded before CMDB Quality. */
function cmdbScore(coverage, findings) {
  const ci = coverage?.cmdb_ci;
  if (!ci || ci.records == null) {
    return { score: null, withheld: 'cmdb_ci was not read on this run.' };
  }
  if (!isComplete(coverage, 'cmdb_ci')) {
    return {
      score: null,
      withheld: `Only ${fmt(ci.records)}${ci.reported_total != null ? ` of ${fmt(ci.reported_total)}` : ''} CIs were read, so a percentage would describe the part we could see rather than the estate.`,
    };
  }
  if (!isComplete(coverage, 'cmdb_rel_ci', ['parent', 'child'])) {
    return {
      score: null,
      withheld: 'The relationship table was not read completely, which inflates "CI has no relationships" and would score our access rather than the estate.',
    };
  }
  if (!ci.records) return { score: null, withheld: 'There are no CIs to score.' };

  const affected = new Set();
  for (const f of findings) if (f.domain === 'CMDB') for (const id of f.target_ids || []) affected.add(id);
  return {
    score: pct(100 * (1 - affected.size / ci.records)),
    basis: `${fmt(ci.records - affected.size)} of ${fmt(ci.records)} CIs have no CMDB finding`,
    definition: 'Share of configuration items no CMDB quality rule objected to.',
    drivers: drivers(findings, { domains: ['CMDB'], tables: ['cmdb_ci'], scanned: ci.records }),
  };
}

/**
 * ITSM under ITSM Quality (itsm-quality.js). `itsm` carries the catalogue's
 * rule rows and the extracted record slice when the scan read ITSM; a stored
 * run recorded before the model has neither, and scores its legacy findings
 * alone under the same arithmetic.
 */
function itsmScore(coverage, findings, itsm = null) {
  const q = scoreItsmQuality({
    coverage,
    findings,
    rules: itsm?.rules ?? null,
    population: itsm?.population ?? null,
    isComplete: (t) => isComplete(coverage, t),
    headline: (rule) => REMEDIATION[rule]?.headline ?? null,
  });
  return { score: q.score, basis: q.basis, definition: q.definition, withheld: q.withheld, drivers: q.drivers, quality: q.quality };
}

/* ── The ITOM checks ───────────────────────────────────────────────────────── */

/**
 * Each check names the tables that must be READABLE for it to count, and the
 * rules whose presence FAILS it. `needsRows` marks checks that only make sense
 * when something exists — you cannot judge MID health with no MIDs, and that
 * case is already a failed `mid_present` rather than a second failure.
 */
const ITOM_CHECKS = Object.freeze([
  { key: 'mid_present', label: 'A MID server exists', table: 'ecc_agent', fails: ['MID-NONE'] },
  { key: 'mid_healthy', label: 'MID servers are up, validated and issue-free', table: 'ecc_agent', needsRows: true,
    fails: ['MID-DOWN', 'MID-NOT-VALIDATED', 'MID-ISSUE', 'MID-NO-CAPABILITY'] },
  { key: 'discovery_ran', label: 'Discovery has run', table: 'discovery_status', fails: ['DISC-NEVER-RAN'] },
  { key: 'discovery_clean', label: 'Discovery runs complete cleanly and recently', table: 'discovery_status', needsRows: true,
    fails: ['DISC-FAILED', 'DISC-STALE', 'DISC-DEVICE-ISSUE', 'DISC-LOG-ERROR'] },
  { key: 'credentials', label: 'Usable Discovery credentials exist', table: 'discovery_credentials',
    fails: ['CRED-NONE', 'CRED-ALL-INACTIVE'] },
  { key: 'service_mapping', label: 'Discovered services are mapped to CIs', table: 'cmdb_ci_service_discovered', needsRows: true,
    fails: ['SM-NOT-IN-USE', 'SM-UNMAPPED'] },
  /*
   * `needsRows` on these three is a correction measured live: with ZERO alerts,
   * "open alerts are bound to CIs" read as a pass and raised the ITOM score. A
   * statement about every member of an empty set is vacuously true, and a
   * vacuous truth is not evidence of health — so an empty table makes the check
   * not applicable instead.
   */
  { key: 'ecc_flowing', label: 'The ECC queue is draining', table: 'ecc_queue', needsRows: true, fails: ['PERF-ECC-AGE'] },
  { key: 'events_bound', label: 'Open alerts are bound to CIs', table: 'em_alert', needsRows: true, fails: ['EVENT-UNBOUND'] },
  { key: 'outages_closed', label: 'Outages are closed when they end', table: 'cmdb_ci_outage', needsRows: true, fails: ['OUTAGE-OPEN'] },
]);

function itomChecks(coverage, findings) {
  const rules = new Set(findings.map((f) => f.rule_id));
  return ITOM_CHECKS.map((c) => {
    const cov = coverage?.[c.table];
    /* `gap` names the kind of inapplicability for the coverage definition
       (overall-health.js): only a failed read is a gap the instance can close. */
    if (!cov || cov.status === 'not_requested') {
      return { key: c.key, label: c.label, result: 'not_applicable', gap: 'not_requested', reason: `${c.table} was not requested` };
    }
    if (!isComplete(coverage, c.table)) {
      return {
        key: c.key, label: c.label, result: 'not_applicable',
        gap: cov.status === 'unavailable' ? 'unavailable' : 'read_failed',
        reason: cov.status === 'unavailable'
          ? `${c.table} is not on this instance`
          : `${c.table} could not be read completely (${cov.status})`,
      };
    }
    if (c.needsRows && !(cov.records > 0)) {
      return { key: c.key, label: c.label, result: 'not_applicable', gap: 'empty', reason: `nothing in ${c.table} to check` };
    }
    const failing = c.fails.filter((r) => rules.has(r));
    return failing.length
      ? { key: c.key, label: c.label, result: 'fail', failedBy: failing }
      : { key: c.key, label: c.label, result: 'pass' };
  });
}

/** What makes two ITOM scores comparable: the check definitions themselves. */
const ITOM_SCORING = Object.freeze({
  model: 'itom-checks/1',
  key: crypto.createHash('sha256').update(JSON.stringify(ITOM_CHECKS.map((c) => [c.key, c.table, Boolean(c.needsRows), c.fails]))).digest('hex').slice(0, 16),
});

/**
 * The model identity of a STORED ITOM summary. A run recorded before the
 * summary carried `scoring` still stored its checks; when they are exactly the
 * checks this build defines, it is this model — the trend may join it.
 */
export function itomScoringOf(summary) {
  if (summary?.scoring?.key) return summary.scoring.key;
  const stored = (summary?.checks || []).map((c) => c.key).join('|');
  return stored && stored === ITOM_CHECKS.map((c) => c.key).join('|') ? ITOM_SCORING.key : null;
}

function itomScore(coverage, findings) {
  const checks = itomChecks(coverage, findings);
  const applicable = checks.filter((c) => c.result !== 'not_applicable');
  const passed = applicable.filter((c) => c.result === 'pass').length;
  if (!applicable.length) {
    return {
      score: null, checks, scoring: ITOM_SCORING,
      withheld: 'None of the ITOM checks could be evaluated — every table they need was unreadable or absent on this instance.',
    };
  }
  return {
    score: pct((100 * passed) / applicable.length),
    checks,
    scoring: ITOM_SCORING,
    basis: `${passed} of ${applicable.length} applicable checks pass`
      + (checks.length > applicable.length ? `; ${checks.length - applicable.length} not applicable here` : ''),
    definition: 'Share of applicable ITOM capability checks that pass. A check whose table could not be read is not counted either way.',
  };
}

/* ── The summary ───────────────────────────────────────────────────────────── */

/**
 * One summary per scope.
 *
 * `findings` must be EVERY finding the run detected, not a stored or displayed
 * page of them. Measured: counting the stored 1,000 of 12,194 put "989
 * Moderate" and "0 Low" on the page, and both numbers were wrong. When only a
 * truncated set exists — an older run — `truncated` withholds the scores rather
 * than computing them from a fraction.
 */
/**
 * @param {object} [opts.comparability]  the run's CMDB comparability ({ key }) — the CMDB score's model identity
 * @param {object} [opts.overall]        { modules: [...] } — the modules THIS run scanned. When every scorable
 *                                       module is among them the All scope carries the overall (overall-health.js);
 *                                       a module-limited scan carries none, so the trend never joins a partial
 *                                       scan's number to a full one.
 */
export function summariseScopes(coverage, findings, { truncated = false, cmdbQuality = null, itsm = null, comparability = null, overall = null } = {}) {
  const out = {};
  for (const scope of SCOPES) {
    const own = findings.filter((f) => inScope(f, scope.key));
    const domains = Object.entries(AGENTS)
      /* A scope lists its own domains, plus any domain a rule OVERRIDE carried
         into it — `PERF-ECC-AGE` shows under ITOM as Performance, and only its
         findings are counted there. */
      .filter(([, [domain]]) => !scope.domains || scope.domains.includes(domain)
        || own.some((f) => f.domain === domain))
      .map(([agent, [domain, label]]) => ({
        agent_id: agent, domain, label,
        findings: own.filter((f) => f.domain === domain).length,
      }));

    let scored = { score: null, withheld: null };
    if (scope.key === 'cmdb' && cmdbQuality) scored = cmdbQualityScore(cmdbQuality, coverage, findings, comparability);
    else if (scope.scoreKind === 'records') scored = scope.key === 'cmdb' ? cmdbScore(coverage, findings) : itsmScore(coverage, own, itsm);
    else if (scope.scoreKind === 'checks') scored = itomScore(coverage, findings);
    else if (scope.scoreKind === 'none') {
      scored = {
        score: null,
        withheld: 'Platform hygiene has no single meaningful denominator — tens of thousands of role assignments and a handful of integrations are not comparable, so any percentage would be decided by whichever table is largest.',
      };
    }

    if (truncated && scored.score != null) {
      scored = {
        ...scored,
        score: null,
        /* The model's parts were computed from the same fraction: withheld with the number. */
        quality: null,
        withheld: 'This run stored only part of its findings, so a score computed from them would be wrong. Run a new check.',
      };
    }

    out[scope.key] = {
      key: scope.key,
      label: scope.label,
      description: scope.description,
      score_kind: scope.scoreKind ?? null,
      score: scored.score ?? null,
      score_basis: scored.basis ?? null,
      score_definition: scored.definition ?? null,
      score_withheld_because: scored.score == null ? (scored.withheld ?? null) : null,
      checks: scored.checks ?? null,
      /* Present even when the score is withheld for truncation: which rules
         dominate is still true of the findings that were detected. */
      score_drivers: scored.drivers ?? null,
      findings: own.length,
      severity_counts: countBy(own, (f) => f.severity),
      /* The trust gate belongs to CMDB, and is shown on All too: a blocker on
         the CMDB base is a caveat on everything that reads the CMDB. */
      gate: ['cmdb', 'all'].includes(scope.key) && cmdbQuality ? cmdbQuality.gate : null,
      cmdb_quality: scope.key === 'cmdb' ? cmdbQuality : null,
      /* The ITSM model's parts, coverage and posture — the CMDB precedent, for ITSM. */
      itsm_quality: scope.key === 'itsm' ? (scored.quality ?? null) : null,
      /* What makes this score comparable with another run's. Only a scope whose
         model declares one carries it; the trend breaks its line across a change. */
      scoring: scored.scoring ?? scored.quality?.scoring ?? null,
      domains,
      tables: scope.tables,
    };
  }
  /*
   * THE MODULE CONTRACT, on every area (overall-health.js): assessment state,
   * coverage under the one definition, and the Systemic counts — derived from
   * the summary above, stored beside it so the page and the overall read the
   * same thing. Nothing here changes a score.
   */
  for (const m of MODULE_KEYS) {
    const c = moduleContract(m, out[m], { coverage });
    out[m].assessment = c.assessment;
    out[m].coverage_share = c.coverage;
    out[m].coverage_detail = c.coverage_detail ?? null;
    out[m].systemic = c.systemic;
  }
  /* The overall, only for a scan that covered every scorable area. */
  const scanned = overall?.modules ?? null;
  if (scanned && SCORABLE_MODULES.every((m) => scanned.includes(m))) {
    Object.assign(out.all, overallScope(Object.fromEntries(MODULE_KEYS.map((m) => [m, scanned.includes(m) ? out[m] : null])), coverage));
  }
  return out;
}

/**
 * The All scope's overall (overall-health.js), from the areas' summaries.
 * `summaries[m]` is null for an area with no result. Shared by a full scan's
 * manifest and by the composed view, so both compute the same thing.
 */
export function overallScope(summaries, coverage = {}, weights = DEFAULT_WEIGHTS) {
  const modules = Object.fromEntries(MODULE_KEYS.map((m) => [m, moduleContract(m, summaries[m] ?? null, { coverage })]));
  const o = scoreOverall({ modules, weights });
  return {
    score: o.score,
    score_exact: o.score_exact,
    score_kind: o.score_kind,
    score_basis: o.score_basis,
    score_definition: o.score_definition,
    score_withheld_because: o.score_withheld_because,
    status: o.status,
    health_band: o.health_band,
    attribution: o.attribution,
    coverage_share: o.coverage,
    systemic: o.systemic,
    module_breakdown: o.module_breakdown,
    scoring: o.scoring,
  };
}

/** The vocabulary the UI renders — served, never coined in the browser. */
export function scopeVocabulary() {
  return SCOPES.map(({ key, label, description, domains, tables, scoreKind }) => ({
    key, label, description, domains, tables, scoreKind: scoreKind ?? null,
  }));
}
