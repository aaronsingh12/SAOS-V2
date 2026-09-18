import { parseDate } from './time.js';

/**
 * GROUP 1 — HEALTH CONFIGURATION META. The trust gate.
 *
 * CMDB-001 to CMDB-011 and CMDB-139 from the SAOS catalogue (tracker v3),
 * implemented against the tables that actually exist — verified on dev424910,
 * 15 Sep 2026:
 *
 *   cmdb_health_inclusion_rule does NOT exist. Inclusion rules live in
 *   cmdb_health_config (applies_to, active_record_condition, metric), which has
 *   no `active` field — every row is a rule. Weights are in
 *   cmdb_health_metric_pref. Configured required/recommended attributes are in
 *   cmdb_recommended_fields. Principal classes are cmdb_class_info.principal_class.
 *
 * PURE: `ctx` carries the extracted estate, coverage and the bounded meta reads
 * `extract.js` made. Nothing here touches the network.
 *
 * ═══ THE DISCIPLINE ═══
 *
 * A rule that could not be evaluated SKIPS, with the reason, and never fires.
 * "We could not read the health configuration" and "there is no health
 * configuration" are opposite conclusions. Where a rule's False Positive Guard
 * cannot be checked by machine, the finding says so instead of pretending the
 * guard passed.
 */

export const GATE_RULES = Object.freeze([
  'CMDB-001', 'CMDB-002', 'CMDB-003', 'CMDB-004', 'CMDB-005', 'CMDB-006',
  'CMDB-007', 'CMDB-008', 'CMDB-009', 'CMDB-010', 'CMDB-011', 'CMDB-139',
]);

export const GATE_DEFAULTS = Object.freeze({
  coverageFloorPct: 60,       // CMDB-003
  coverageEscalatePct: 40,    // CMDB-003: escalate below
  staleUpdatedPct: 10,        // CMDB-009
  jobTolerance: 1.5,          // CMDB-007: × the job's own interval
  healthJobName: 'CMDB Health',
});

const DAY_S = 86_400;
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());

/** Seconds between runs of a scheduled script, or null when it has no fixed interval. */
export function jobInterval(job) {
  const t = String(job.run_type || '').toLowerCase();
  if (t === 'daily') return DAY_S;
  if (t === 'weekly') return 7 * DAY_S;
  if (t === 'monthly') return 31 * DAY_S;
  if (t === 'periodically') {
    const p = parseDate(job.run_period);
    const s = p ? Math.round(p.getTime() / 1000) : 0;
    return s > 0 ? s : null;
  }
  return null;
}

function fact(table, field, value, reason, now) {
  return {
    source: 'ServiceNow Table/Aggregate REST API', sn_table: table, sn_sys_id: null,
    field_name: field, field_value: String(value), reason, collected_at: now.toISOString(),
  };
}

/** Populated CMDB classes from the cmdb_ci extract: name → CI count. */
function populatedClasses(ctx) {
  const counts = new Map();
  for (const c of ctx.estate.cmdb_ci || []) {
    const k = c.sys_class_name || 'cmdb_ci';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

/** A class and its ancestors, nearest first, from the hierarchy meta read. */
function lineage(meta, name) {
  const out = [];
  const seen = new Set();
  let at = name;
  while (at && !seen.has(at)) {
    seen.add(at);
    out.push(at);
    at = meta?.classes?.byName?.[at]?.super ?? null;
  }
  return out;
}

export function cmdbGateRules(ctx, options = {}) {
  const opt = { ...GATE_DEFAULTS, ...options };
  const now = ctx.now;
  const meta = ctx.meta?.cmdb || {};
  const skip = (rule, table, reason) => ctx.skipped.push({ rule, table, reason });
  const readOk = (key) => meta.reads?.[key]?.status === 'ok';

  const configComplete = ctx.complete('cmdb_health_config');
  const configs = ctx.estate.cmdb_health_config || [];
  const classes = populatedClasses(ctx);
  const ciComplete = ctx.complete('cmdb_ci', ['sys_class_name']);
  const classInfoComplete = ctx.complete('cmdb_class_info', ['class', 'principal_class']);
  const principals = new Set((ctx.estate.cmdb_class_info || []).filter((r) => truthy(r.principal_class)).map((r) => r.class));
  const hierarchyOk = readOk('class_hierarchy');

  /* Classes each inclusion rule reaches: every populated class whose lineage includes applies_to. */
  const reach = (config) => [...classes.keys()].filter((c) => lineage(meta, c).includes(config.applies_to));

  /* ── CMDB-139 — no principal classes designated ───────────────────────── */
  let principalFallback = false;
  if (!classInfoComplete) {
    skip('CMDB-139', 'cmdb_class_info', 'cmdb_class_info was not read completely, so the absence of principal classes cannot be asserted');
  } else if (principals.size === 0) {
    principalFallback = true;
    /* Decision 5 of 16 Sep: base stays Critical, escalating to Systemic when the
       fallback population holds classes whose CIs support a Business Critical
       service. Escalated, not gating — it counted, it is not a governance break. */
    const sig = ctx.signals;
    const bcClasses = sig?.bcSupported
      ? [...new Set((ctx.estate.cmdb_ci || []).filter((c) => sig.bcSupported.has(c.sys_id)).map((c) => c.sys_class_name))]
      : null;
    ctx.addCatalogued('CMDB-139', 'cmdb_class_info', [], ['class', 'principal_class'],
      `cmdb_class_info holds ${(ctx.estate.cmdb_class_info || []).length} classes and none is marked principal_class=true. `
      + `Every principal-scoped rule falls back to the ${classes.size} populated CMDB classes.`,
      {
        evidence: [
          fact('cmdb_class_info', 'rows', (ctx.estate.cmdb_class_info || []).length, 'complete read', now),
          fact('cmdb_class_info', 'principal_class=true', 0, 'no principal classes designated', now),
          ...[...classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
            .map(([c, n]) => fact('cmdb_ci', `CIs in ${c}`, n, 'populated class used as the fallback population', now)),
          ...(bcClasses?.length ? [fact('cmdb_ci_service', 'classes supporting a Business Critical service', bcClasses.join(', '), 'why this is escalated', now)] : []),
        ],
        escalators: bcClasses?.length ? ['business_critical_service'] : [],
        notEvaluated: bcClasses ? [] : ['business_critical_service'],
        guard: { evaluated: true, note: 'The read of cmdb_class_info was complete and principal_class was returned, so ACL-hidden rows and a missing field are ruled out.' },
      });
  }
  const principalSet = principals.size ? principals : new Set(classes.keys());
  const principalBasis = principals.size
    ? `${principals.size} designated principal classes`
    : `fallback: all ${classes.size} populated classes, because no principal classes are designated (CMDB-139)`;

  /* ── CMDB-001 — no inclusion rule at all (gate) ───────────────────────── */
  let noInclusion = false;
  if (!configComplete) {
    skip('CMDB-001', 'cmdb_health_config', 'cmdb_health_config was not read completely, so "no inclusion rule" cannot be asserted');
  } else if (configs.length === 0) {
    noInclusion = true;
    const results = meta.healthResult || {};
    ctx.addCatalogued('CMDB-001', 'cmdb_health_config', [], ['applies_to', 'active_record_condition'],
      'cmdb_health_config is empty: no inclusion rule tells CMDB Health which CIs to evaluate. '
      + `cmdb_health_result holds ${results.count ?? 'an unknown number of'} results`
      + `${results.newest ? `, newest ${results.newest}` : ''}. Any CMDB Health score is computed over an unsound base.`,
      {
        evidence: [
          fact('cmdb_health_config', 'rows', 0, 'complete read — no inclusion rules', now),
          fact('cmdb_health_result', 'rows', results.count ?? 'unknown', 'health results the dashboard would show', now),
          ...(results.newest ? [fact('cmdb_health_result', 'newest sys_updated_on', results.newest, 'age of the newest health result', now)] : []),
        ],
        guard: { evaluated: false, note: 'Not machine-checkable: confirm no third-party health tool has deliberately replaced CMDB Health before treating this as Systemic.' },
      });
  }

  const needsConfigs = (rule) => {
    if (!configComplete) { skip(rule, 'cmdb_health_config', 'cmdb_health_config was not read completely'); return false; }
    if (!configs.length) { skip(rule, 'cmdb_health_config', 'No inclusion rules exist to evaluate (see CMDB-001)'); return false; }
    return true;
  };
  const needsHierarchy = (rule) => {
    if (!hierarchyOk) { skip(rule, 'sys_db_object', `The class hierarchy could not be read: ${meta.reads?.class_hierarchy?.error || 'not read'}`); return false; }
    if (!ciComplete) { skip(rule, 'cmdb_ci', 'cmdb_ci was not read completely, so the populated class set is partial'); return false; }
    return true;
  };

  /* ── CMDB-002 — inclusion rule filter matches zero CIs (gate) ─────────── */
  if (needsConfigs('CMDB-002')) {
    if (!readOk('config_matches')) {
      skip('CMDB-002', 'cmdb_health_config', `Filter counts could not be read: ${meta.reads?.config_matches?.error || 'not read'}`);
    } else {
      const empty = configs.filter((c) => meta.configMatches?.[c.sys_id] === 0).filter((c) => {
        /* FALSE POSITIVE GUARD: a rule written ahead of a class that will be
           populated later. Suppressed when the class has no CIs at all and was
           created after the rule. */
        const cls = meta.classes?.byName?.[c.applies_to];
        const classEmpty = ![...classes.keys()].some((k) => lineage(meta, k).includes(c.applies_to));
        const created = parseDate(cls?.created);
        const ruleCreated = parseDate(c.sys_created_on);
        return !(classEmpty && created && ruleCreated && created > ruleCreated);
      });
      if (empty.length) {
        ctx.addCatalogued('CMDB-002', 'cmdb_health_config', empty, ['applies_to', 'active_record_condition', 'metric'],
          `${empty.length} inclusion rule(s) look configured but their filter matches zero CIs, so those classes are silently unmeasured.`,
          { guard: { evaluated: true, note: 'Rules written ahead of a class created later are excluded.' } });
      }
    }
  }

  /* ── CMDB-003 — class coverage below floor (gate) ─────────────────────── */
  let coveredClasses = null;
  if (noInclusion) {
    skip('CMDB-003', 'cmdb_health_config', 'Subsumed by CMDB-001: with no inclusion rule coverage is 0%, and the gate already says so');
  } else if (needsConfigs('CMDB-003') && needsHierarchy('CMDB-003')) {
    coveredClasses = new Set(configs.flatMap(reach));
    const total = [...classes.values()].reduce((a, b) => a + b, 0);
    const covered = [...classes.entries()].filter(([c]) => coveredClasses.has(c)).reduce((a, [, n]) => a + n, 0);
    const ratio = total ? (100 * covered) / total : 100;
    if (ratio < opt.coverageFloorPct) {
      const excluded = [...classes.entries()].filter(([c]) => !coveredClasses.has(c)).sort((a, b) => b[1] - a[1]);
      ctx.addCatalogued('CMDB-003', 'cmdb_health_config', [], ['applies_to'],
        `Inclusion rules reach ${covered.toLocaleString()} of ${total.toLocaleString()} CIs (${ratio.toFixed(1)}%), below the ${opt.coverageFloorPct}% floor.`,
        {
          escalators: ratio < opt.coverageEscalatePct ? ['rule_threshold'] : [],
          evidence: excluded.slice(0, 25).map(([c, n]) => fact('cmdb_ci', `excluded class ${c}`, n, principals.has(c) ? 'principal class' : 'not principal', now)),
          guard: { evaluated: false, note: 'Deliberately excluded classes (test, sandbox, archive) need a registered exception; none is read yet.' },
        });
    }
  }

  /* ── CMDB-004 — inclusion rule with no principal-class predicate ──────── */
  if (needsConfigs('CMDB-004') && needsHierarchy('CMDB-004')) {
    if (!principals.size) {
      skip('CMDB-004', 'cmdb_class_info', 'No principal classes are designated (CMDB-139), so "missing a principal-class filter" has nothing to compare against');
    } else {
      const flat = configs.filter((c) => {
        const set = reach(c);
        const mixed = set.some((k) => principals.has(k)) && set.some((k) => !principals.has(k));
        return mixed && !/principal|sys_class_name/i.test(String(c.active_record_condition || ''));
      });
      if (flat.length) {
        ctx.addCatalogued('CMDB-004', 'cmdb_health_config', flat, ['applies_to', 'active_record_condition'],
          `${flat.length} inclusion rule(s) span principal and non-principal classes with no principal-class predicate, so every class is weighted the same.`,
          { guard: { evaluated: false, note: 'Confirm with the CMDB owner that equal weighting is not deliberate policy.' } });
      }
    }
  }

  /* ── CMDB-005 — populated classes no inclusion rule reaches ───────────── */
  if (noInclusion) {
    skip('CMDB-005', 'cmdb_health_config', 'Subsumed by CMDB-001: with no inclusion rule every populated class is excluded');
  } else if (needsConfigs('CMDB-005') && needsHierarchy('CMDB-005')) {
    const covered = coveredClasses || new Set(configs.flatMap(reach));
    const excluded = [...classes.entries()].filter(([c]) => !covered.has(c)).sort((a, b) => b[1] - a[1]);
    if (excluded.length) {
      const principalExcluded = excluded.some(([c]) => principals.has(c));
      ctx.addCatalogued('CMDB-005', 'cmdb_health_config', [], ['applies_to'],
        `${excluded.length} populated class(es) holding ${excluded.reduce((a, [, n]) => a + n, 0).toLocaleString()} CIs are reached by no inclusion rule, so they never drag the score down.`,
        {
          escalators: principalExcluded ? ['rule_threshold'] : [],
          notEvaluated: principalExcluded ? [] : ['business_critical_service'],
          evidence: excluded.slice(0, 25).map(([c, n]) => fact('cmdb_ci', `excluded class ${c}`, n, principals.has(c) ? 'principal class' : 'not principal', now)),
          guard: { evaluated: false, note: 'Archive/staging-only and retiring classes are not yet recognised.' },
        });
    }
  }

  /* ── CMDB-006 — no required/recommended attributes defined ─────────────── */
  if (!ctx.complete('cmdb_recommended_fields', ['table', 'recommended', 'active'])) {
    skip('CMDB-006', 'cmdb_recommended_fields', 'cmdb_recommended_fields was not read completely');
  } else if (!readOk('mandatory_fields')) {
    skip('CMDB-006', 'sys_dictionary', `Mandatory dictionary flags could not be read: ${meta.reads?.mandatory_fields?.error || 'not read'}`);
  } else if (needsHierarchy('CMDB-006') && (principals.size || classInfoComplete)) {
    const recommended = new Map();
    for (const r of ctx.estate.cmdb_recommended_fields || []) {
      if (!truthy(r.active)) continue;
      recommended.set(r.table, (recommended.get(r.table) || 0) + 1);
    }
    const bare = [...principalSet].filter((cls) => {
      const line = lineage(meta, cls);
      const rec = line.reduce((n, c) => n + (recommended.get(c) || 0), 0);
      const mand = line.reduce((n, c) => n + (meta.mandatory?.[c]?.length || 0), 0);
      return rec + mand === 0;
    });
    if (bare.length) {
      ctx.addCatalogued('CMDB-006', 'cmdb_recommended_fields', [], ['table', 'recommended'],
        `${bare.length} of ${principalSet.size} classes (${principalBasis}) have no configured required or recommended attribute and no mandatory dictionary field, so completeness has nothing to measure.`,
        {
          evidence: bare.sort((a, b) => (classes.get(b) || 0) - (classes.get(a) || 0)).slice(0, 25)
            .map((c) => fact('cmdb_recommended_fields', `configured attributes for ${c}`, 0, `${classes.get(c) || 0} CIs; no mandatory dictionary field on the class or its ancestors`, now)),
          guard: { evaluated: false, note: 'A class that genuinely needs no required attribute is rare and must be confirmed by its owner.' },
        });
    }
  }

  /* ── CMDB-007 — health job inactive, failing or overdue ───────────────── */
  const jobs = ctx.estate.sysauto_script || [];
  if (!ctx.complete('sysauto_script', ['name', 'active', 'run_type'])) {
    skip('CMDB-007', 'sysauto_script', 'The CMDB Health jobs were not read completely');
  } else if (!jobs.length) {
    skip('CMDB-007', 'sysauto_script', `No scheduled job named like "${opt.healthJobName}" was found; the job names this rule looks for are configurable`);
  } else {
    const nowMs = now.getTime();
    const triggers = meta.jobTriggers || [];
    const problems = [];
    const evidence = [];
    const intervals = [];
    for (const j of jobs) {
      if (!truthy(j.active)) {
        problems.push(j);
        evidence.push(fact('sysauto_script', `${j.name} · active`, j.active, 'job inactive', now));
        continue;
      }
      const every = jobInterval(j);
      if (every) intervals.push(every);
      const trig = triggers.find((t) => t.document_key === j.sys_id);
      if (readOk('job_triggers') && !trig) {
        problems.push(j);
        evidence.push(fact('sys_trigger', `${j.name}`, 'no trigger', 'active but not scheduled', now));
      } else if (trig && String(trig.state) === '3') {
        problems.push(j);
        evidence.push(fact('sys_trigger', `${j.name} · state`, trig.state, 'job in error state', now));
      } else if (trig && every) {
        const next = parseDate(trig.next_action);
        if (next && nowMs - next.getTime() > opt.jobTolerance * every * 1000) {
          problems.push(j);
          evidence.push(fact('sys_trigger', `${j.name} · next_action`, trig.next_action, `overdue beyond ${opt.jobTolerance}× its interval`, now));
        }
      }
    }
    const results = meta.healthResult || {};
    const newest = parseDate(results.newest);
    const shortest = intervals.length ? Math.min(...intervals) : null;
    const staleResults = readOk('health_result') && shortest && (!newest || nowMs - newest.getTime() > opt.jobTolerance * shortest * 1000);
    if (staleResults) {
      evidence.push(fact('cmdb_health_result', 'newest sys_updated_on', results.newest || 'none', `no result within ${opt.jobTolerance}× the shortest job interval`, now));
    }
    if (problems.length || staleResults) {
      const inactive = problems.filter((j) => !truthy(j.active)).length;
      ctx.addCatalogued('CMDB-007', 'sysauto_script', problems, ['name', 'active', 'run_type'],
        `${problems.length} of ${jobs.length} CMDB Health job(s) are not running as scheduled`
        + `${inactive ? ` (${inactive} inactive)` : ''}; cmdb_health_result holds ${results.count ?? 'an unknown number of'} results`
        + `${results.newest ? `, newest ${results.newest}` : ''}. The dashboard shows historical numbers as if current.`,
        {
          evidence: [...evidence, fact('cmdb_health_result', 'rows', results.count ?? 'unknown', 'results computed by these jobs', now)],
          guard: { evaluated: false, note: 'Not machine-checkable: confirm the jobs were not paused deliberately for an upgrade or migration window.' },
        });
    }
  }

  /* ── CMDB-008 — overlapping inclusion rules with different config ─────── */
  if (needsConfigs('CMDB-008') && needsHierarchy('CMDB-008')) {
    const conflicts = [];
    for (let i = 0; i < configs.length; i++) {
      for (let k = i + 1; k < configs.length; k++) {
        const a = configs[i];
        const b = configs[k];
        if (a.metric !== b.metric) continue;
        const sa = new Set(reach(a));
        const overlap = reach(b).filter((c) => sa.has(c));
        if (overlap.length && String(a.active_record_condition || '') !== String(b.active_record_condition || '')) conflicts.push([a, b, overlap]);
      }
    }
    if (conflicts.length) {
      const rows = [...new Map(conflicts.flatMap(([a, b]) => [[a.sys_id, a], [b.sys_id, b]])).values()];
      ctx.addCatalogued('CMDB-008', 'cmdb_health_config', rows, ['applies_to', 'active_record_condition', 'metric'],
        `${conflicts.length} pair(s) of inclusion rules for the same metric cover overlapping classes with different conditions, so the same CI can score two ways.`,
        {
          evidence: conflicts.slice(0, 25).map(([a, b, ov]) => fact('cmdb_health_config', `${a.applies_to} ↔ ${b.applies_to}`, ov.join(', '), 'overlapping classes, differing condition', now)),
          guard: { evaluated: false, note: 'Deliberate layering (a broad rule plus a stricter subset) needs documented intent.' },
        });
    }
  }

  /* ── CMDB-009 — results stale against CI update activity ──────────────── */
  const results = meta.healthResult || {};
  if (!readOk('health_result')) {
    skip('CMDB-009', 'cmdb_health_result', `Health results could not be read: ${meta.reads?.health_result?.error || 'not read'}`);
  } else if (!results.count) {
    skip('CMDB-009', 'cmdb_health_result', 'No health results exist to be stale (see CMDB-007)');
  } else if (!ctx.complete('cmdb_ci', ['sys_updated_on'])) {
    skip('CMDB-009', 'cmdb_ci', 'cmdb_ci was not read completely');
  } else {
    const newest = parseDate(results.newest);
    const cis = ctx.estate.cmdb_ci || [];
    const after = newest ? cis.filter((c) => (parseDate(c.sys_updated_on)?.getTime() || 0) > newest.getTime()) : [];
    const ratio = cis.length ? (100 * after.length) / cis.length : 0;
    if (newest && ratio > opt.staleUpdatedPct) {
      ctx.addCatalogued('CMDB-009', 'cmdb_health_result', [], ['sys_updated_on'],
        `${after.length.toLocaleString()} of ${cis.length.toLocaleString()} CIs (${ratio.toFixed(1)}%) changed after the newest health result (${results.newest}), above the ${opt.staleUpdatedPct}% threshold.`,
        {
          evidence: [fact('cmdb_health_result', 'newest sys_updated_on', results.newest, 'last computation', now),
            fact('cmdb_ci', 'updated since', after.length, 'CIs changed after it', now)],
          guard: { evaluated: false, note: 'A bulk script that touched sys_updated_on without meaningful change is not yet told apart.' },
        });
    }
  }

  /* ── CMDB-010 — Data Manager policies scheduled but never executed ────── */
  if (!ctx.complete('cmdb_data_management_policy', ['name', 'policy_execution_job'])) {
    skip('CMDB-010', 'cmdb_data_management_policy', 'Data Manager policies were not read completely');
  } else if (!ctx.complete('cmdb_policy_scheduled_job', ['active'])) {
    skip('CMDB-010', 'cmdb_policy_scheduled_job', 'Policy execution jobs were not read completely');
  } else {
    const jobsById = new Map((ctx.estate.cmdb_policy_scheduled_job || []).map((j) => [j.sys_id, j]));
    const scheduled = (ctx.estate.cmdb_data_management_policy || []).filter((p) => truthy(jobsById.get(p.policy_execution_job)?.active));
    if (scheduled.length && !readOk('policy_executions')) {
      skip('CMDB-010', 'cmdb_data_management_policy_execution', `Execution history could not be read: ${meta.reads?.policy_executions?.error || 'not read'}`);
    } else {
      const never = scheduled.filter((p) => {
        if ((meta.policyExecutions?.[p.sys_id] ?? 0) > 0) return false;
        /* FALSE POSITIVE GUARD: created within the current cycle, not yet due. */
        const every = jobInterval(jobsById.get(p.policy_execution_job)) || 0;
        const created = parseDate(p.sys_created_on);
        return !(created && every && now.getTime() - created.getTime() < every * 1000);
      });
      if (never.length) {
        ctx.addCatalogued('CMDB-010', 'cmdb_data_management_policy', never, ['name', 'policy_execution_job'],
          `${never.length} Data Manager polic(ies) have an active execution job and no execution record. Governance exists on paper only.`,
          { guard: { evaluated: true, note: 'Policies created within their current cycle are excluded.' } });
      }
    }
  }

  /* ── CMDB-011 — weights never reviewed ─────────────────────────────────── */
  if (!ctx.complete('cmdb_health_metric_pref', ['weighted_average_contribution'])) {
    skip('CMDB-011', 'cmdb_health_metric_pref', 'Metric weights were not read completely');
  } else if (!readOk('pref_audit')) {
    skip('CMDB-011', 'sys_audit', `Whether weights are audited could not be read: ${meta.reads?.pref_audit?.error || 'not read'}`);
  } else if (!meta.prefAudit?.audited) {
    skip('CMDB-011', 'sys_audit', 'cmdb_health_metric_pref is not audited on this instance, so "no audit entry since creation" proves nothing — the rule cannot be evaluated');
  } else if ((meta.prefAudit.entries ?? 0) === 0) {
    ctx.addCatalogued('CMDB-011', 'cmdb_health_metric_pref', [], ['weighted_average_contribution'],
      'No change to any CMDB Health metric weight has ever been audited, so the weights are the shipped defaults rather than an organisational judgement.',
      {
        evidence: (ctx.estate.cmdb_health_metric_pref || []).slice(0, 25).map((p) => fact('cmdb_health_metric_pref', `metric ${p.metric}`, p.weighted_average_contribution, 'current weight', now)),
        guard: { evaluated: false, note: 'Ask before raising: defaults may have been reviewed and accepted.' },
      });
  }

  return { principalFallback, principalBasis };
}

/**
 * The records each dimension is scored over: CIs in classes an inclusion rule
 * reaches. With no inclusion rule, every CI read — and the basis says so, while
 * CMDB-001 has already marked the score provisional.
 */
export function cmdbInScope(ctx) {
  const cis = ctx.estate.cmdb_ci || [];
  const configs = ctx.estate.cmdb_health_config || [];
  const meta = ctx.meta?.cmdb || {};
  if (!configs.length || meta.reads?.class_hierarchy?.status !== 'ok') {
    return {
      ids: cis.map((c) => c.sys_id),
      basis: configs.length
        ? `all ${cis.length.toLocaleString()} CIs read — the class hierarchy could not be read to apply the inclusion rules`
        : `all ${cis.length.toLocaleString()} CIs read — no inclusion rule exists to narrow the scope (CMDB-001)`,
    };
  }
  const applies = new Set(configs.map((c) => c.applies_to));
  const ids = cis.filter((c) => lineage(meta, c.sys_class_name || 'cmdb_ci').some((k) => applies.has(k))).map((c) => c.sys_id);
  return { ids, basis: `${ids.length.toLocaleString()} of ${cis.length.toLocaleString()} CIs reached by ${configs.length} inclusion rule(s)` };
}
