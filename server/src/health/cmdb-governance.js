import { modifiersFor, cisForRule, choiceLabels } from './cmdb-signals.js';
import { parseDate } from './time.js';

/**
 * GROUP 9 — DATA MANAGER AND ATTESTATION (D9 track: POSTURE). CMDB-091 to CMDB-101.
 *
 * NOT A SCORED DIMENSION. Every rule here is on the `governance` track with no
 * dimension, so none of them deducts from the D1–D10 composite — they gate
 * (`config_absence` / `measured_kpi`) or they surface as governance posture. The
 * reason is worth stating: attestation measures whether anybody is ANSWERING for
 * the data, which is a different question from whether the data is right. An
 * estate can attest diligently to wrong records, or hold perfect records nobody
 * has ever signed for. Folding the two together would let good governance
 * disguise bad data, which is the one thing a trust score must never do.
 *
 * CMDB-091 is Systemic with `systemic_kind: posture` — Systemic and non-gating,
 * because "governance coverage is below half" invalidates nobody's arithmetic.
 *
 * ═══ WHAT THIS INSTANCE ACTUALLY RUNS (verified on dev424910, Sep 2026) ═══
 *
 * TWO MECHANISMS, AND THIS ESTATE USES THE OLDER ONE.
 *
 *   The modern Data Manager is `cmdb_data_management_*` — NOT
 *   `cmdb_data_manager_*`, which is not a table on any version here. It holds
 *   3 policies, and `cmdb_data_management_task` and
 *   `cmdb_data_management_policy_execution` are both EMPTY: configured, never
 *   run. That is CMDB-092 exactly.
 *
 *   Attestation is the LEGACY Certification module. `dcf_*` is not installed,
 *   but `cert_audit` holds 10 audit definitions, `cert_filter` 9 filters,
 *   `cert_audit_result` 613 results — 561 Failed against 52 Certified — and
 *   `cert_follow_on_task` 544 open tasks, 97 of them past 60 days.
 *
 * So the rules read BOTH, because an estate may run either, both or neither, and
 * "no attestation is configured" and "the attestation product is not installed"
 * are different findings that a single missing table would collapse into one.
 *
 *   There is no `cmdb_archive_rule` on this version. Archive and destroy rules
 *   live on `sys_archive` (28 rules) and `sys_archive_destroy` (19) and name
 *   their table — and the one for `cmdb_ci` is INACTIVE, with no destroy rule at
 *   all. That is CMDB-101's finding, and it is what CMDB-090 in D8 defers to.
 *
 * ═══ INTENT ═══
 *
 * CMDB-091, CMDB-092 and CMDB-101 are contradiction rules — the last of those
 * because it measures retired CI age against a retention period, and a `quality`
 * tag would strip every CI it judges. That mis-tag was caught by the intent
 * invariant in `cmdb-signals.js` rather than by a test, which is what the
 * invariant is for.
 *
 * PURE — no network, no database.
 */

export const GOVERNANCE_RULES = Object.freeze([
  'CMDB-091', 'CMDB-092', 'CMDB-093', 'CMDB-094', 'CMDB-095',
  'CMDB-096', 'CMDB-097', 'CMDB-098', 'CMDB-099', 'CMDB-100', 'CMDB-101',
]);

export const GOVERNANCE_DEFAULTS = Object.freeze({
  /* CMDB-091 — below this share of classes under governance, posture fires. */
  governanceCoveragePct: 50,
  /* CMDB-096 — a class in the top decile by growth needs an archival rule. */
  growthDecile: 0.1,
  minGrowthCis: 25,
  /* Snapshots before an ABSENCE of growth means anything. See CMDB-096 below. */
  minGrowthSnapshots: 2,
  /* CMDB-099 — a certification task older than this is ageing. */
  certTaskAgeDays: 60,
  /* CMDB-095 — how far back a failed attestation still counts. */
  attestationWindowDays: 365,
  /*
   * THE RESULT VOCABULARY IS PER ESTATE. `Failed` and `Certified` are the
   * defaults this instance uses, but an estate whose attesters answer
   * "Rejected" or "Non-compliant" would be counted as neither — and CMDB-095 is
   * the one finding that must never under-count, because it is not a SAOS
   * inference at all: it is the customer's own attester saying the record is
   * wrong. Override both per estate.
   */
  failedResultPattern: /fail|reject|non.?complian|discrepan|breach/i,
  certifiedResultPattern: /certif|pass|complian|approv|accept/i,
});

const DAY_MS = 86_400_000;
const pct1 = (n) => Number(n.toFixed(1));
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const val = (r, f) => String(r?.[f] ?? '').trim();

export function cmdbGovernanceRules(ctx, options = {}) {
  const opt = { ...GOVERNANCE_DEFAULTS, ...options };
  const now = ctx.now;
  const meta = ctx.meta?.cmdb || {};
  const signals = ctx.signals;
  const skip = (rule, table, reason) => ctx.skipped.push({ rule, table, reason });
  const allCis = ctx.estate.cmdb_ci || [];
  const byId = new Map(allCis.map((c) => [c.sys_id, c]));
  const days = (d) => (d ? Math.floor((now - d) / DAY_MS) : null);
  const fact = (table, field, value, reason) => ({
    source: 'ServiceNow Table/Aggregate REST API', sn_table: table, sn_sys_id: null,
    field_name: field, field_value: String(value), reason, collected_at: now.toISOString(),
  });
  const governance = (rule, table, records, fields, description, extra = {}) => {
    const m = modifiersFor(records, signals);
    return ctx.addCatalogued(rule, table, records, fields, description, {
      agent: 'attestation_agent', escalators: m.escalators, deEscalators: m.deEscalators, notEvaluated: m.notEvaluated, ...extra,
    });
  };
  ctx.measures ||= {};

  /* ═══ Which governance mechanisms exist here at all ═════════════════════ */
  /*
   * "NOT CONFIGURED" AND "NOT INSTALLED" ARE DIFFERENT FINDINGS. A table the
   * instance does not have answers `unavailable`; an empty table it does have
   * means somebody could have configured this and has not. Collapsing the two
   * would tell an estate without the product that it has neglected something it
   * cannot own.
   */
  const status = (t) => ctx.coverage?.[t]?.status ?? 'not_requested';
  const certInstalled = status('cert_audit') !== 'unavailable';
  const dmInstalled = status('cmdb_data_management_policy') !== 'unavailable';
  const certAudits = certInstalled ? (ctx.estate.cert_audit || []) : [];
  const policies = dmInstalled ? (ctx.estate.cmdb_data_management_policy || []) : [];
  const results = ctx.estate.cert_audit_result || [];
  const certTasks = ctx.estate.cert_follow_on_task || [];
  const filters = ctx.estate.cert_filter || [];
  const executions = meta.policyExecutions || meta.policy_executions || {};
  const anyMechanism = certAudits.length > 0 || policies.length > 0;
  const mechanismNote = [
    certInstalled ? `${certAudits.length} certification audit definition(s)` : 'the Certification module is not installed',
    dmInstalled ? `${policies.length} Data Manager policy/policies` : 'the Data Manager tables are not present',
  ].join('; ');
  ctx.measures.governance_mechanisms = {
    certification_installed: certInstalled, certification_audits: certAudits.length,
    data_manager_installed: dmInstalled, data_manager_policies: policies.length,
    attestation_results: results.length, open_certification_tasks: certTasks.filter((t) => truthy(t.active)).length,
  };

  if (!anyMechanism) {
    for (const r of ['CMDB-092', 'CMDB-093', 'CMDB-094', 'CMDB-095', 'CMDB-097', 'CMDB-098']) {
      skip(r, 'cert_audit', `No attestation is configured on this instance (${mechanismNote}), so there is no cycle, attester or result to judge. ${certInstalled || dmInstalled ? 'The capability EXISTS and nothing has been configured in it — CMDB-091 reports that as governance coverage.' : 'The capability is not installed, which is a product decision rather than a governance failure.'}`);
    }
  }

  /* ── CMDB-091 — how much of the estate anybody answers for ─────────────── */
  const principals = new Set((ctx.estate.cmdb_class_info || []).filter((r) => truthy(r.principal_class)).map((r) => r.class));
  const populated = [...new Set(allCis.map((c) => c.sys_class_name).filter(Boolean))];
  const scopeClasses = principals.size ? populated.filter((c) => principals.has(c)) : populated;
  const fallbackNote = principals.size ? '' : ' Evaluated over every populated class, because no principal classes are designated (CMDB-139).';
  /* A class is governed when something names it: an audit filter, or a policy. */
  const governedClasses = new Set();
  const filterById = new Map(filters.map((f) => [f.sys_id, f]));
  for (const a of certAudits) {
    if (!truthy(a.active)) continue;
    const t = val(a, 'table') || val(filterById.get(val(a, 'filter')) || {}, 'table');
    if (t) governedClasses.add(t);
  }
  for (const p of policies) {
    const t = val(p, 'table');
    if (t) governedClasses.add(t);
  }
  if (!scopeClasses.length) {
    skip('CMDB-091', 'cmdb_ci', 'No populated CMDB class is in scope, so there is no governance coverage to measure');
  } else {
    const covered = scopeClasses.filter((c) => governedClasses.has(c)).length;
    const passPct = (100 * covered) / scopeClasses.length;
    ctx.kpis.push({
      rule_id: 'CMDB-091',
      pass_pct: passPct,
      numerator: covered,
      denominator: scopeClasses.length,
      basis: `classes named by an active attestation config or Data Manager policy (${mechanismNote})${principals.size ? '' : ' — every populated class, no principal classes designated'}`,
      alerts: 'Governance posture: surfaced beside the score, never inside it. Attesting diligently to wrong records is not data quality.',
    });
    if (passPct < opt.governanceCoveragePct) {
      governance('CMDB-091', 'cmdb_ci', [], ['sys_class_name'],
        `${covered} of ${scopeClasses.length} classes (${pct1(passPct)}%) are under any active governance — an attestation config or a Data Manager policy that names them — below the ${opt.governanceCoveragePct}% threshold. For the rest, nobody has been asked to answer for the data: no owner, no cycle, no policy. This is posture and does not move the quality score, because attesting to wrong records would not make them right.${fallbackNote}`,
        { confidence: 1.0,
          evidence: [
            fact('cert_audit', 'governed classes', [...governedClasses].slice(0, 10).join(', ') || 'none', mechanismNote),
            fact('cmdb_ci', 'classes in scope', scopeClasses.length, principals.size ? 'principal classes' : 'all populated classes (fallback)'),
          ],
          guard: { evaluated: false, note: 'Governance run outside ServiceNow with documented evidence looks identical from here. The rule can only see what this instance records.' } });
    }
  }

  /* ── CMDB-092 — scheduled, and never once run ──────────────────────────── */
  if (anyMechanism) {
    const neverRun = [];
    for (const a of certAudits) {
      if (!truthy(a.active)) continue;
      const ran = parseDate(a.last_run_date) || results.some((r) => r.audit === a.sys_id);
      if (!ran) neverRun.push({ kind: 'certification audit', name: val(a, 'name'), id: a.sys_id, created: val(a, 'sys_created_on'), sched: val(a, 'next_scheduled_run') || val(a, 'run_type') });
    }
    for (const p of policies) {
      /* `meta.policyExecutions` counts executions per policy id. No entry and no
         execution row both mean the same thing: it has never run. */
      const count = executions[p.sys_id];
      const ran = Number(count) > 0 || (ctx.estate.cmdb_data_management_policy_execution || []).some((e) => e.cmdb_policy === p.sys_id);
      if (!ran) neverRun.push({ kind: 'Data Manager policy', name: val(p, 'name'), id: p.sys_id, created: val(p, 'sys_created_on'), sched: val(p, 'policy_execution_job') || 'no execution job' });
    }
    for (const n of neverRun) {
      const age = days(parseDate(n.created));
      governance('CMDB-092', n.kind === 'certification audit' ? 'cert_audit' : 'cmdb_data_management_policy', [], ['name'],
        `The ${n.kind} "${n.name}" is active and has never executed${age != null ? `, ${age} days after it was created` : ''}. A cycle that never runs is indistinguishable from no cycle at all, except that it appears on a governance report as though the estate were covered.`,
        { confidence: 1.0,
          evidence: [
            fact(n.kind === 'certification audit' ? 'cert_audit' : 'cmdb_data_management_policy', 'schedule', n.sched || '(none)', 'configured'),
            fact('execution history', 'runs', 0, 'no execution record of any kind'),
          ],
          guard: { evaluated: age != null && age > 30, note: age != null && age <= 30 ? 'Configured within the last 30 days: it may simply not be due yet.' : 'Configured long enough ago that a cycle should have run. Check the schedule before assuming it is broken.' } });
    }
    if (!neverRun.length && (certAudits.length || policies.length)) {
      skip('CMDB-092', 'cert_audit', `Every active attestation config and policy here has executed at least once — evaluated, with nothing to report`);
    }
  }

  /* ── CMDB-093 / CMDB-094 — who is supposed to answer ───────────────────── */
  if (anyMechanism) {
    const members = ctx.estate.sys_user_grmember || [];
    const activeInGroup = new Map();
    for (const m of members) {
      if (!m.group) continue;
      const active = truthy(m['user.active']);
      const cur = activeInGroup.get(m.group) || { total: 0, active: 0 };
      cur.total += 1;
      if (active) cur.active += 1;
      activeInGroup.set(m.group, cur);
    }
    const membershipRead = ctx.complete('sys_user_grmember', ['group', 'user']);
    const configs = [
      ...certAudits.filter((a) => truthy(a.active)).map((a) => ({
        table: 'cert_audit', name: val(a, 'name'), id: a.sys_id,
        user: val(a, 'assign_to'), userActive: a['assign_to.active'], userName: val(a, 'assign_to.name'),
        group: val(a, 'assign_to_group'), groupName: val(a, 'assign_to_group.name'),
      })),
      ...policies.map((p) => ({
        table: 'cmdb_data_management_policy', name: val(p, 'name'), id: p.sys_id,
        user: val(p, 'task_management_user') || val(p, 'user') || val(p, 'assignee'),
        userActive: p['task_management_user.active'] ?? p['assignee.active'], userName: '',
        group: val(p, 'task_management_group') || val(p, 'user_group'), groupName: '',
      })),
    ];
    for (const c of configs) {
      if (!c.user && !c.group) {
        governance('CMDB-094', c.table, [], ['name'],
          `"${c.name}" is an active attestation configuration with no attester assigned at all — neither a user nor a group. When it runs it will produce work with nobody to do it, and the records it covers will read as governed while no one has ever been asked about them.`,
          { confidence: 1.0,
            evidence: [fact(c.table, 'attester', '(empty)', 'no user and no group')],
            guard: { evaluated: false, note: 'A configuration still in draft is the expected exception — check whether it is meant to be active.' } });
        continue;
      }
      const inactiveUser = c.user && c.userActive !== undefined && !truthy(c.userActive);
      const groupStats = c.group ? activeInGroup.get(c.group) : null;
      const emptyGroup = c.group && membershipRead && (!groupStats || groupStats.active === 0);
      if (!inactiveUser && !emptyGroup) continue;
      governance('CMDB-093', c.table, [], ['name'],
        `The attester for "${c.name}" cannot answer: ${inactiveUser ? `the assigned user${c.userName ? ` (${c.userName})` : ''} is inactive` : ''}${inactiveUser && emptyGroup ? ', and ' : ''}${emptyGroup ? `the assigned group${c.groupName ? ` (${c.groupName})` : ''} has ${groupStats ? `${groupStats.total} member(s), none of them active` : 'no members at all'}` : ''}. Every attestation it raises goes to nobody, so the cycle completes with no answer and the class is recorded as attested.`,
        { confidence: 1.0,
          evidence: [
            c.user ? fact(c.table, 'assigned user', c.userName || c.user, inactiveUser ? 'inactive' : 'active') : fact(c.table, 'assigned group', c.groupName || c.group, emptyGroup ? 'no active members' : 'has members'),
            fact('sys_user_grmember', 'active members', groupStats ? groupStats.active : 'n/a', membershipRead ? 'resolved at run time, not from the group record' : 'membership not read'),
          ],
          guard: { evaluated: true, note: 'The catalogue names no false positive: the attester resolves to somebody active, or it does not.' } });
    }
    if (!membershipRead && configs.some((c) => c.group)) {
      skip('CMDB-093', 'sys_user_grmember', 'Group membership was not read completely, so a group attester could not be resolved to its active members — an inactive USER attester was still checked');
    }
  }

  /* ── CMDB-095 / CMDB-097 / CMDB-098 — what the cycles came back with ───── */
  if (results.length) {
    const cutoff = now.getTime() - opt.attestationWindowDays * DAY_MS;
    const inWindow = results.filter((r) => {
      const d = parseDate(r.sys_created_on);
      return !d || d.getTime() >= cutoff;
    });
    const failed = inWindow.filter((r) => opt.failedResultPattern.test(val(r, 'state')));
    const certified = inWindow.filter((r) => opt.certifiedResultPattern.test(val(r, 'state')));
    ctx.measures.attestation_outcomes = {
      results: results.length, in_window: inWindow.length, failed: failed.length, certified: certified.length,
      window_days: opt.attestationWindowDays,
    };
    if (failed.length) {
      const byAudit = new Map();
      for (const r of failed) {
        const k = val(r, 'audit') || 'unknown';
        if (!byAudit.has(k)) byAudit.set(k, []);
        byAudit.get(k).push(r);
      }
      const auditById = new Map(certAudits.map((a) => [a.sys_id, a]));
      const auditName = (id) => val(auditById.get(id) || {}, 'name') || id;
      /*
       * WHO SAID SO, AND WHEN — the evidence leads with that. This finding is
       * not an inference the tool drew; it is a person's recorded judgement, and
       * the attester's name is what makes it unarguable in the room.
       */
      const attesterOf = (id) => {
        const a = auditById.get(id);
        if (!a) return 'unknown attester';
        return val(a, 'assign_to.name') || val(a, 'assign_to_group.name') || val(a, 'assign_to') || val(a, 'assign_to_group') || 'no attester assigned';
      };
      const dates = failed.map((r) => val(r, 'sys_created_on')).filter(Boolean).sort();
      const attesters = [...new Set([...byAudit.keys()].map(attesterOf))];
      const cis = [...new Set(failed.map((r) => r.configuration_item).filter((id) => byId.has(id)))].map((id) => byId.get(id));
      const columns = [...new Set(failed.map((r) => val(r, 'column_name')).filter(Boolean))];
      governance('CMDB-095', 'cert_audit_result', cis.slice(0, 25), ['name', 'sys_class_name'],
        `${failed.length.toLocaleString('en-US')} attestation(s) came back FAILED against ${certified.length.toLocaleString('en-US')} certified — ${pct1((100 * failed.length) / (inWindow.length || 1))}% of everything attested in the last ${opt.attestationWindowDays} days. ${[...byAudit.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3).map(([id, rs]) => `"${auditName(id)}" (${rs.length})`).join(', ')}. These are not suspicions: somebody looked at the record and said it was wrong${columns.length ? `, most often on ${columns.slice(0, 4).join(', ')}` : ''}.`,
        { confidence: 1.0,
          evidence: [
            fact('cert_audit', 'attested by', attesters.join(', '), 'the people whose judgement this is — not an inference drawn by this tool'),
            fact('cert_audit_result', 'answered between', dates.length ? `${dates[0].slice(0, 10)} and ${dates[dates.length - 1].slice(0, 10)}` : 'undated', `${failed.length} failed result(s) in a ${opt.attestationWindowDays}-day window`),
            ...[...byAudit.entries()].slice(0, 10).map(([id, rs]) => fact('cert_audit_result', auditName(id), `${rs.length} failed`, `attested by ${attesterOf(id)}`)),
          ],
          guard: { evaluated: true, note: 'The catalogue is explicit that these are confirmed findings — the attester\'s judgement IS the evidence, not a heuristic.' } });
    }
    if (!failed.length && inWindow.length) {
      skip('CMDB-095', 'cert_audit_result', `All ${inWindow.length.toLocaleString('en-US')} attestation result(s) in the window came back certified — evaluated, with nothing to report`);
    }
  } else if (anyMechanism) {
    skip('CMDB-095', 'cert_audit_result', 'No attestation has produced a result on this instance, so there is no outcome to report — CMDB-092 covers a cycle that has never run');
  }

  /* Pending and overdue live on the tasks the cycles raise. */
  if (certTasks.length) {
    const open = certTasks.filter((t) => truthy(t.active));
    const withDue = open.filter((t) => parseDate(t.due_date));
    const overdue = withDue.filter((t) => parseDate(t.due_date) < now);
    ctx.measures.attestation_tasks = {
      total: certTasks.length, open: open.length, with_due_date: withDue.length, overdue: overdue.length,
    };
    if (!withDue.length) {
      skip('CMDB-097', 'cert_follow_on_task', `None of the ${open.length.toLocaleString('en-US')} open attestation task(s) carries a due date, so "past due" has no date to be past. They are counted as pending by CMDB-098 and aged by CMDB-099 instead — an undated task is not an overdue one.`);
    } else if (overdue.length) {
      const ages = overdue.map((t) => days(parseDate(t.due_date))).sort((a, b) => b - a);
      governance('CMDB-097', 'cert_follow_on_task', [], ['number'],
        `${overdue.length.toLocaleString('en-US')} of ${withDue.length.toLocaleString('en-US')} dated attestation task(s) are past their due date, the oldest by ${ages[0]} days (median ${ages[Math.floor(ages.length / 2)]}). The cycle is issuing work faster than anybody is answering it.`,
        { confidence: 1.0,
          evidence: [fact('cert_follow_on_task', 'overdue', `${overdue.length} of ${withDue.length}`, `oldest ${ages[0]} days past due`)],
          guard: { evaluated: false, note: 'A legitimately granted extension is not recorded on the task, so it looks the same as neglect.' } });
    }
    if (open.length) {
      ctx.kpis.push({
        rule_id: 'CMDB-098',
        pass_pct: null,
        numerator: open.length,
        denominator: certTasks.length,
        basis: `attestations issued and awaiting an answer — reported as a MEASURE, not against a threshold (${open.length.toLocaleString('en-US')} of ${certTasks.length.toLocaleString('en-US')} tasks are open)`,
      });
      skip('CMDB-098', 'cert_follow_on_task', `${open.length.toLocaleString('en-US')} attestation task(s) are pending. The catalogue reports this as a measure rather than a threshold, so it is recorded and not charged.`);
    }

    /* ── CMDB-099 — the answers nobody is giving ───────────────────────── */
    const ageing = open.filter((t) => {
      const age = days(parseDate(t.opened_at) || parseDate(t.sys_created_on));
      return age != null && age > opt.certTaskAgeDays;
    });
    if (ageing.length) {
      const unassigned = ageing.filter((t) => !val(t, 'assigned_to') && !val(t, 'assignment_group')).length;
      const affected = [...new Set(ageing.map((t) => t.cmdb_ci).filter((id) => byId.has(id)))].map((id) => byId.get(id));
      governance('CMDB-099', 'cert_follow_on_task', affected.slice(0, 25), ['name', 'sys_class_name'],
        `${ageing.length.toLocaleString('en-US')} data certification task(s) have been open for more than ${opt.certTaskAgeDays} days${unassigned ? `, and ${unassigned.toLocaleString('en-US')} of them are assigned to nobody at all` : ''}. Each one names a CI whose data somebody has already found wrong, so the defect is known, recorded and still there.`,
        { confidence: 1.0,
          evidence: [
            fact('cert_follow_on_task', 'ageing', `${ageing.length} of ${open.length} open`, `older than ${opt.certTaskAgeDays} days`),
            fact('cert_follow_on_task', 'unassigned', unassigned, 'no assignee and no group'),
          ],
          guard: { evaluated: false, note: 'Tasks parked pending a data-source fix are a legitimate reason to age. Check whether the underlying source is the blocker.' } });
    } else if (open.length) {
      skip('CMDB-099', 'cert_follow_on_task', `No open certification task is older than ${opt.certTaskAgeDays} days — evaluated, with nothing to report`);
    }
  } else if (anyMechanism) {
    for (const r of ['CMDB-097', 'CMDB-098', 'CMDB-099']) {
      skip(r, 'cert_follow_on_task', 'Attestation is configured but has raised no tasks, so there is no pending, overdue or ageing work to report');
    }
  }

  /* ── CMDB-100 — the de-duplication backlog, as a measure ───────────────── */
  const dedupTasks = ctx.estate.reconcile_duplicate_task || [];
  if (!ctx.complete('reconcile_duplicate_task', ['active'])) {
    skip('CMDB-100', 'reconcile_duplicate_task', 'The de-duplication tasks were not read completely, so a backlog figure would understate itself');
  } else {
    const open = dedupTasks.filter((t) => truthy(t.active));
    const windowStart = now.getTime() - 90 * DAY_MS;
    const createdRecently = dedupTasks.filter((t) => { const d = parseDate(t.sys_created_on || t.opened_at); return d && d.getTime() >= windowStart; }).length;
    ctx.measures.dedup_backlog = { total: dedupTasks.length, open: open.length, created_90d: createdRecently };
    if (open.length) {
      governance('CMDB-100', 'reconcile_duplicate_task', [], ['number'],
        `${open.length.toLocaleString('en-US')} de-duplication task(s) are open, ${createdRecently.toLocaleString('en-US')} of them raised in the last 90 days out of ${dedupTasks.length.toLocaleString('en-US')} ever created. Reported together because the backlog size alone says nothing: a large backlog that is shrinking is a programme working, and a small one that is growing is one that is not.`,
        { confidence: 1.0,
          evidence: [
            fact('reconcile_duplicate_task', 'open', open.length, 'current backlog'),
            fact('reconcile_duplicate_task', 'created in 90 days', createdRecently, 'arrival rate'),
            fact('reconcile_duplicate_task', 'closed', dedupTasks.length - open.length, 'closure to date'),
          ],
          guard: { evaluated: true, note: 'A measure rather than a threshold — the catalogue asks for all three numbers together.' } });
    } else {
      skip('CMDB-100', 'reconcile_duplicate_task', `No de-duplication task is open${dedupTasks.length ? ` (${dedupTasks.length} have existed)` : ' and none has ever been raised'} — evaluated, with nothing to report. Group 4 reports the duplicates themselves; this rule reports only whether anybody is working them.`);
    }
  }

  /* ── CMDB-096 / CMDB-101 — what happens to data nobody removes ─────────── */
  const archiveRules = ctx.estate.sys_archive || [];
  const destroyRules = ctx.estate.sys_archive_destroy || [];
  const archiveRead = ctx.complete('sys_archive', ['table', 'active']);
  const ruleFor = (cls) => ({
    archive: archiveRules.filter((r) => val(r, 'table') === cls),
    destroy: destroyRules.filter((r) => val(r, 'table') === cls),
  });
  if (!archiveRead) {
    for (const r of ['CMDB-096', 'CMDB-101']) skip(r, 'sys_archive', 'The archive rules were not read, so an absent retention policy cannot be told from one we failed to read');
  } else {
    /* CMDB-096 — growth, measured from creation dates rather than asserted. */
    const yearAgo = now.getTime() - 365 * DAY_MS;
    const growth = new Map();
    for (const c of allCis) {
      const cls = c.sys_class_name;
      if (!cls) continue;
      const g = growth.get(cls) || { total: 0, recent: 0 };
      g.total += 1;
      const created = parseDate(c.sys_created_on);
      if (created && created.getTime() >= yearAgo) g.recent += 1;
      growth.set(cls, g);
    }
    const growing = [...growth.entries()].filter(([, g]) => g.recent >= opt.minGrowthCis)
      .sort((a, b) => b[1].recent - a[1].recent);
    /*
     * GROWTH IS A TREND, AND THIS RULE ABSTAINS RATHER THAN CLEARING.
     *
     * Observed growth is positive evidence and fires immediately — a class that
     * grew is a class that grew. But NO OBSERVED GROWTH IS NOT EVIDENCE OF NO
     * GROWTH: `sys_created_on` can be rewritten by a migration, an estate can be
     * loaded once and never dated, and a single run has no baseline to compare
     * against. Reporting "no archival gap" from that would be the clean-100
     * failure in a new place, so the two outcomes are kept visibly different:
     * growth found → finding; growth not found → ABSTAIN, and say which.
     */
    ctx.measures.class_growth = {
      at: now.toISOString(),
      classes: [...growth.entries()].map(([cls, g]) => ({ cls, total: g.total, recent: g.recent })),
    };
    const history = (ctx.history?.class_growth || []).filter((h) => h && parseDate(h.at));
    const snapshots = history.length + 1;
    if (!growing.length) {
      const newest = [...growth.values()].reduce((n, g) => n + g.recent, 0);
      skip('CMDB-096', 'cmdb_ci', `NOT MEASURED — no growth was OBSERVED, which is not the same as no archival gap. No class gained ${opt.minGrowthCis} or more CIs in the last year (${newest} CI(s) created estate-wide by sys_created_on), and this run holds ${snapshots} of the ${opt.minGrowthSnapshots} snapshots needed to see growth as a trend rather than as a creation date that may itself have been rewritten. The rule abstains: it has not found that these classes are safe, only that it cannot yet tell.`);
    } else {
      const cut = Math.max(1, Math.ceil(growing.length * opt.growthDecile));
      for (const [cls, g] of growing.slice(0, cut)) {
        const rules = ruleFor(cls);
        const active = [...rules.archive, ...rules.destroy].filter((r) => truthy(r.active));
        if (active.length) continue;
        const inactive = [...rules.archive, ...rules.destroy].length;
        governance('CMDB-096', 'cmdb_ci', [], ['sys_class_name'],
          `${cls} grew by ${g.recent.toLocaleString('en-US')} CI(s) in the last year to ${g.total.toLocaleString('en-US')}, putting it in the top ${Math.round(opt.growthDecile * 100)}% by growth, and it has no active archival or deletion rule${inactive ? ` (${inactive} rule(s) exist but are switched off)` : ''}. Nothing that enters this class ever leaves it, so the table grows until it is the reason a query times out.`,
          { confidence: 1.0,
            evidence: [
              fact('cmdb_ci', cls, `${g.recent} new of ${g.total}`, 'growth in the last 365 days'),
              fact('sys_archive', 'rules', inactive ? `${inactive} inactive` : 'none', 'archival configuration for this class'),
            ],
            guard: { evaluated: false, note: 'Retention handled by an external archival process leaves no rule here. Confirm before treating it as a gap.' } });
      }
    }

    /* CMDB-101 — the two cases, reported separately as the catalogue asks. */
    const ciRules = ruleFor('cmdb_ci');
    const anyCiRule = [...ciRules.archive, ...ciRules.destroy];
    const activeCiRule = anyCiRule.filter((r) => truthy(r.active));
    const classesWithPolicy = scopeClasses.filter((cls) => [...ruleFor(cls).archive, ...ruleFor(cls).destroy].some((r) => truthy(r.active)));
    if (!activeCiRule.length) {
      governance('CMDB-101', 'sys_archive', [], ['name'],
        `No active retention policy covers the CMDB: ${anyCiRule.length ? `${anyCiRule.length} archive rule(s) name cmdb_ci and every one of them is switched off` : 'no archive or destroy rule names cmdb_ci at all'}, and ${classesWithPolicy.length} of ${scopeClasses.length} classes in scope have one of their own. Retired records therefore stay for ever: the CMDB becomes an archive nobody trusts, and it holds personal and contractual data past the point anybody agreed to keep it. This is also why CMDB-090 declines to measure a retention breach — there is no period to breach.`,
        { confidence: 1.0,
          evidence: [
            ...anyCiRule.slice(0, 5).map((r) => fact('sys_archive', val(r, 'name'), truthy(r.active) ? 'active' : 'INACTIVE', `rule on ${val(r, 'table')}`)),
            fact('sys_archive', 'classes with an active policy', `${classesWithPolicy.length} of ${scopeClasses.length}`, 'per-class retention'),
          ],
          guard: { evaluated: false, note: 'Retention governed at the instance level, or by an external process, would not appear as a per-class rule. Confirm before treating it as absent.' } });
    } else {
      skip('CMDB-101', 'sys_archive', `${activeCiRule.length} active retention rule(s) cover cmdb_ci, and ${classesWithPolicy.length} of ${scopeClasses.length} in-scope classes have one — adherence is measured by CMDB-090 in D8 against the configured period`);
    }
  }
}
