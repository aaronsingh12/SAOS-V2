import { isComplete, AGENTS } from './rules.js';
import { REMEDIATION } from './remediation.js';

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
 *   CMDB  — a RECORD score: the share of CIs no CMDB rule objected to. Records
 *           are the unit of CMDB health, so a percentage of them is meaningful.
 *   ITSM  — the same kind, over the open-or-recent incident, change and problem
 *           slice that was actually read.
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

const CMDB_DOMAINS = ['CMDB', 'CMDB_GOVERNANCE', 'RELATIONSHIP', 'CSDM'];
const ITOM_DOMAINS = ['DISCOVERY', 'CREDENTIALS', 'MID_SERVER', 'SERVICE_MAPPING', 'EVENT_MANAGEMENT', 'AVAILABILITY'];
const ITSM_DOMAINS = ['INCIDENT', 'CHANGE', 'PROBLEM'];
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
      'cmdb_ire_output_aggregate_stats', 'cmdb_metadata_hosting', 'cmdb_metadata_containment'],
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
 * A finding carries its domain, so `scopeOf` answers for findings. A skipped
 * check carries only its rule id, and a module-limited scan must drop the skips
 * of modules it did not check — otherwise an ITSM-only scan would report every
 * CMDB rule as "not run". The prefixes mirror the domains each family emits;
 * a test holds the two answers equal for every rule the pack can produce.
 */
const RULE_PREFIX_SCOPE = Object.freeze([
  [/^(CMDB|REL|CSDM)-/, 'cmdb'],
  [/^(MID|DISC|CRED|SM|EVENT|OUTAGE)-/, 'itom'],
  [/^ITSM-/, 'itsm'],
]);
export function scopeOfRule(ruleId) {
  const override = RULE_SCOPE[ruleId];
  if (override) return override;
  for (const [re, key] of RULE_PREFIX_SCOPE) if (re.test(String(ruleId || ''))) return key;
  return 'platform';
}

/** Which scope a finding belongs to. A rule override outranks its domain. */
export function scopeOf(finding) {
  const override = RULE_SCOPE[finding?.rule_id];
  if (override) return override;
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
 * Built from the same definitions `scopeOf` uses, so the list the page loads
 * and the counts beside it cannot disagree about which scope a rule is in.
 */
export function scopeFilter(key) {
  const scope = byKey[normaliseScope(key)];
  if (!scope?.domains) return null;
  const into = Object.entries(RULE_SCOPE).filter(([, k]) => k === scope.key).map(([r]) => r);
  const awayFrom = Object.entries(RULE_SCOPE).filter(([, k]) => k !== scope.key).map(([r]) => r);
  const marks = (xs) => xs.map(() => '?').join(',');
  let clause = `(domain IN (${marks(scope.domains)})`;
  const args = [...scope.domains];
  if (awayFrom.length) { clause += ` AND rule_id NOT IN (${marks(awayFrom)})`; args.push(...awayFrom); }
  clause += ')';
  if (into.length) { clause = `(${clause} OR rule_id IN (${marks(into)}))`; args.push(...into); }
  return { clause, args };
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
function cmdbQualityScore(q, coverage, findings) {
  const legacyDrivers = cmdbScore(coverage, findings).drivers ?? null;
  const c = q.composite;
  const measured = q.dimensions.filter((d) => d.measured);
  return {
    score: c.score,
    basis: c.score == null ? null
      : `${measured.length} of ${q.dimensions.length} dimensions measured (${c.measured_weight} of 100 weight) over ${q.in_scope.records.toLocaleString()} in-scope CIs — ${q.in_scope.basis}`,
    definition: c.definition,
    withheld: c.score == null
      ? `${c.not_measured_because} ${q.rules.built} of ${q.rules.catalogued} catalogue rules are built; the ones built so far are the trust gate, which sits outside the 100.`
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

/** ITSM: over whichever of the three tables were read completely. */
function itsmScore(coverage, findings) {
  const tables = ['incident', 'change_request', 'problem'];
  const usable = tables.filter((t) => isComplete(coverage, t));
  const excluded = tables.filter((t) => coverage?.[t] && !isComplete(coverage, t));
  if (!usable.length) {
    return {
      score: null,
      withheld: excluded.length
        ? `None of ${tables.join(', ')} were read completely, so there is no record set to score.`
        : 'No incident, change or problem records were read on this run.',
    };
  }
  const scanned = usable.reduce((n, t) => n + (coverage[t].records || 0), 0);
  if (!scanned) return { score: null, withheld: 'The ITSM slice was empty — nothing open or recent to score.' };

  const affected = new Set();
  for (const f of findings) {
    if (ITSM_DOMAINS.includes(f.domain) && usable.includes(f.table)) {
      for (const id of f.target_ids || []) affected.add(`${f.table}:${id}`);
    }
  }
  const slice = coverage[usable[0]]?.filter;
  return {
    score: pct(100 * (1 - affected.size / scanned)),
    basis: `${fmt(scanned - affected.size)} of ${fmt(scanned)} records have no ITSM finding`
      + (slice ? ` (${slice})` : '')
      + (excluded.length ? `; ${excluded.join(', ')} excluded — not read completely` : ''),
    definition: 'Share of open or recent incidents, changes and problems no ITSM rule objected to.',
    drivers: drivers(findings, { domains: ITSM_DOMAINS, tables: usable, scanned }),
  };
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
    if (!cov || cov.status === 'not_requested') {
      return { key: c.key, label: c.label, result: 'not_applicable', reason: `${c.table} was not requested` };
    }
    if (!isComplete(coverage, c.table)) {
      return {
        key: c.key, label: c.label, result: 'not_applicable',
        reason: cov.status === 'unavailable'
          ? `${c.table} is not on this instance`
          : `${c.table} could not be read completely (${cov.status})`,
      };
    }
    if (c.needsRows && !(cov.records > 0)) {
      return { key: c.key, label: c.label, result: 'not_applicable', reason: `nothing in ${c.table} to check` };
    }
    const failing = c.fails.filter((r) => rules.has(r));
    return failing.length
      ? { key: c.key, label: c.label, result: 'fail', failedBy: failing }
      : { key: c.key, label: c.label, result: 'pass' };
  });
}

function itomScore(coverage, findings) {
  const checks = itomChecks(coverage, findings);
  const applicable = checks.filter((c) => c.result !== 'not_applicable');
  const passed = applicable.filter((c) => c.result === 'pass').length;
  if (!applicable.length) {
    return {
      score: null, checks,
      withheld: 'None of the ITOM checks could be evaluated — every table they need was unreadable or absent on this instance.',
    };
  }
  return {
    score: pct((100 * passed) / applicable.length),
    checks,
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
export function summariseScopes(coverage, findings, { truncated = false, cmdbQuality = null } = {}) {
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
    if (scope.key === 'cmdb' && cmdbQuality) scored = cmdbQualityScore(cmdbQuality, coverage, findings);
    else if (scope.scoreKind === 'records') scored = scope.key === 'cmdb' ? cmdbScore(coverage, findings) : itsmScore(coverage, findings);
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
      domains,
      tables: scope.tables,
    };
  }
  return out;
}

/** The vocabulary the UI renders — served, never coined in the browser. */
export function scopeVocabulary() {
  return SCOPES.map(({ key, label, description, domains, tables, scoreKind }) => ({
    key, label, description, domains, tables, scoreKind: scoreKind ?? null,
  }));
}
