import { modifiersFor, lineageOf, dqActive, cisForRule, DQ_INACTIVE_INSTALL_STATUS, CLASS_TIERS, consequenceOf, CONSEQUENCE_REDUCED_BAND } from './cmdb-signals.js';
import { parseDate } from './time.js';

/**
 * GROUP 10 — OWNERSHIP (D9). CMDB-102 to CMDB-108.
 *
 * Back to a SCORED dimension after the posture group — D9 weighs 6 of 100, and
 * the active-status filter returns with it: every rule here is a QUALITY rule,
 * so Retired, Stolen and Absent CIs are outside both the findings and the
 * denominator. Nobody needs to own a decommissioned server.
 *
 * WHAT OWNERSHIP IS FOR. Every other finding in this catalogue ends with
 * somebody having to do something about it, and D9 is the dimension that asks
 * whether that somebody exists. A CI with a perfect record and no owner is a
 * defect waiting to be nobody's job — which is why CMDB-104 blocks remediation
 * of every other finding in its class, and why this dimension is small in weight
 * and large in consequence.
 *
 * ═══ WHAT THIS INSTANCE KEEPS (verified on dev424910, Sep 2026) ═══
 *
 *   2,684 of 2,784 CIs (96.4%) have NO owner, NO managed_by and NO support
 *   group. Ownership is set on 33 CIs (owned_by), 85 (managed_by) and 37
 *   (support_group); `assigned_to` is set on 772, which is an assignment rather
 *   than accountability and is reported as a RECOVERABLE SIGNAL rather than
 *   counted as ownership.
 *
 *   NOT ONE owner or manager resolves to an inactive user, and all 53 groups are
 *   active — so CMDB-102 and CMDB-103 evaluate against an empty population here.
 *   That is a result, not a skip, and it is reported as one.
 *
 *   The class-level data owner CMDB-104 wants is `cmdb_class_info.managed_by_group`.
 *
 * ═══ WHY CMDB-107 COUNTS AGAINST THE WHOLE ESTATE ═══
 *
 * "A single owner holds a disproportionate share" is an accountability
 * concentration risk, so the denominator is every in-scope CI — not the handful
 * that happen to be owned. On an estate where 33 CIs are owned, one person
 * holding 10 of them is 30% of the owned set and 0.4% of the estate, and only
 * the second number is about concentration. The owned-set share is reported in
 * the evidence, because it is what a reader will otherwise compute wrongly.
 *
 * PURE — no network, no database.
 */

export const OWNERSHIP_RULES = Object.freeze([
  'CMDB-102', 'CMDB-103', 'CMDB-104', 'CMDB-105', 'CMDB-106', 'CMDB-107', 'CMDB-108',
]);

export const OWNERSHIP_DEFAULTS = Object.freeze({
  dqInactiveInstallStatus: DQ_INACTIVE_INSTALL_STATUS,
  /*
   * WHAT COUNTS AS OWNING A CI. Per estate: some record accountability on
   * `owned_by`, some on `support_group`, some on a custom field. `assigned_to`
   * is deliberately NOT here — it names who is holding a device, not who
   * answers for its record — but it IS reported as a recoverable signal when a
   * CI has nothing else, because the catalogue asks for any inferable owner.
   */
  ownershipFields: Object.freeze(['owned_by', 'managed_by', 'support_group']),
  inferableFields: Object.freeze(['assigned_to']),
  /* CMDB-107 — a share of the IN-SCOPE ESTATE, not of the owned subset. */
  concentrationPct: 20,
  /* CMDB-106 — report the per-service ratio before raising individual findings. */
  serviceDivergenceMinCis: 3,
  /* CMDB-108 — old enough that unchanged ownership is worth reporting. */
  ownershipAgeDays: 365,
  /* Above this share, the absence is estate-wide and the FIELD SET is the thing
     most likely to be wrong — so the finding says which fields it measured. */
  selfDiscloseAbovePct: 80,
  classTiers: CLASS_TIERS,
});

const DAY_MS = 86_400_000;
const pct1 = (n) => Number(n.toFixed(1));
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const val = (r, f) => String(r?.[f] ?? '').trim();

export function cmdbOwnershipRules(ctx, options = {}) {
  const opt = { ...OWNERSHIP_DEFAULTS, ...options };
  const now = ctx.now;
  const meta = ctx.meta?.cmdb || {};
  const signals = ctx.signals;
  const skip = (rule, table, reason) => ctx.skipped.push({ rule, table, reason });
  const hierarchyOk = meta.reads?.class_hierarchy?.status === 'ok';
  const line = (cls) => lineageOf(meta, cls || 'cmdb_ci');
  const inClasses = (c, classes) => (hierarchyOk ? line(c.sys_class_name).some((t) => (classes || []).includes(t)) : (classes || []).includes(c.sys_class_name));
  const allCis = ctx.estate.cmdb_ci || [];
  const { active: activeCis, excluded: inactiveCis } = dqActive(allCis, opt.dqInactiveInstallStatus);
  const cisFor = (rule) => cisForRule(rule, { all: allCis, active: activeCis });
  const label = (c) => `${c.sys_class_name} "${c.name || c.sys_id}"`;
  const days = (d) => (d ? Math.floor((now - d) / DAY_MS) : null);
  const fact = (table, field, value, reason) => ({
    source: 'ServiceNow Table/Aggregate REST API', sn_table: table, sn_sys_id: null,
    field_name: field, field_value: String(value), reason, collected_at: now.toISOString(),
  });
  const perRecord = (rule, records, fields, description, extra = {}) => {
    const m = modifiersFor(records, signals);
    return ctx.addCatalogued(rule, 'cmdb_ci', records, fields, description, {
      agent: 'ownership_agent', escalators: m.escalators, deEscalators: m.deEscalators, notEvaluated: m.notEvaluated, ...extra,
    });
  };
  ctx.measures ||= {};

  const ciOk = ctx.complete('cmdb_ci', ['sys_class_name']);
  if (!ciOk) {
    for (const r of OWNERSHIP_RULES) skip(r, 'cmdb_ci', 'The CIs were not read completely — an ownership rule over a partial estate reports our own access rather than who is accountable');
    return;
  }

  /* ═══ Group membership, resolved live ═══════════════════════════════════ */
  /*
   * THE CATALOGUE IS EXPLICIT: membership is resolved at evaluation time, not
   * taken from the group record. A group row that exists and is marked active
   * says nothing about whether anybody is in it — which is exactly the failure
   * CMDB-102 exists to find.
   */
  const membershipRead = ctx.complete('sys_user_grmember', ['group', 'user']);
  const groupMembers = new Map();                         // group -> { total, active }
  for (const m of ctx.estate.sys_user_grmember || []) {
    if (!m.group) continue;
    const cur = groupMembers.get(m.group) || { total: 0, active: 0 };
    cur.total += 1;
    if (truthy(m['user.active'])) cur.active += 1;
    groupMembers.set(m.group, cur);
  }

  const ownershipOf = (c) => opt.ownershipFields.filter((f) => val(c, f));
  const scope = cisFor('CMDB-105');
  const owned = scope.filter((c) => ownershipOf(c).length);
  ctx.measures.ownership_coverage = {
    in_scope: scope.length,
    with_any_owner: owned.length,
    by_field: Object.fromEntries(opt.ownershipFields.map((f) => [f, scope.filter((c) => val(c, f)).length])),
    inferable_only: scope.filter((c) => !ownershipOf(c).length && opt.inferableFields.some((f) => val(c, f))).length,
    fields: [...opt.ownershipFields],
  };

  /* ── CMDB-102 — the group exists, and nobody is in it ──────────────────── */
  if (!membershipRead) {
    skip('CMDB-102', 'sys_user_grmember', 'Group membership was not read completely, so a support group cannot be resolved to its active members — and a group record that merely exists proves nothing, which is the failure this rule exists to find');
  } else {
    const byGroup = new Map();
    for (const c of cisFor('CMDB-102')) {
      const g = val(c, 'support_group');
      if (!g) continue;
      if (!byGroup.has(g)) byGroup.set(g, { name: val(c, 'support_group.name') || g, cis: [] });
      byGroup.get(g).cis.push(c);
    }
    let emptyGroups = 0;
    for (const [id, g] of byGroup) {
      const members = groupMembers.get(id);
      if (members && members.active > 0) continue;
      emptyGroups += 1;
      perRecord('CMDB-102', g.cis, ['name', 'sys_class_name', 'support_group'],
        `The support group "${g.name}" carries ${g.cis.length.toLocaleString('en-US')} CI(s) and has ${members ? `${members.total} member(s), none of them active` : 'no members at all'}. Every incident routed by these CIs goes to a queue nobody reads, and the ownership field on each of them reads as filled in.`,
        { confidence: 1.0,
          evidence: [
            fact('sys_user_grmember', 'active members', members ? members.active : 0, `resolved at evaluation time, not from the group record${members ? ` (${members.total} total)` : ''}`),
            fact('cmdb_ci', 'CIs assigned', g.cis.length, `support_group = ${g.name}`),
          ],
          guard: { evaluated: false, note: 'A group deliberately emptied during a transition, with a documented interim owner elsewhere, looks the same from here.' } });
    }
    if (!byGroup.size) {
      skip('CMDB-102', 'cmdb_ci', `No in-scope CI carries a support group at all (${ctx.measures.ownership_coverage.by_field.support_group ?? 0} of ${scope.length.toLocaleString('en-US')}), so there is no group to resolve. That absence is CMDB-105's finding, not this one.`);
    } else if (!emptyGroups) {
      skip('CMDB-102', 'sys_user_grmember', `All ${byGroup.size} support group(s) in use have at least one active member — evaluated, with nothing to report`);
    }
  }

  /* ── CMDB-103 — the owner left ─────────────────────────────────────────── */
  /*
   * Every ownership field IN USE on the class is evaluated, per the catalogue
   * threshold — a CI whose `owned_by` is fine and whose `managed_by` left is
   * still a CI whose accountability is half gone.
   */
  const userFields = ['owned_by', 'managed_by', ...opt.inferableFields];
  let inactiveOwners = 0;
  let unresolved = 0;
  for (const c of cisFor('CMDB-103')) {
    const gone = [];
    for (const f of userFields) {
      if (!val(c, f)) continue;
      const active = c[`${f}.active`];
      if (active === undefined) { unresolved += 1; continue; }
      if (!truthy(active)) gone.push({ field: f, who: val(c, `${f}.name`) || val(c, f) });
    }
    if (!gone.length) continue;
    inactiveOwners += 1;
    perRecord('CMDB-103', [c], ['name', 'sys_class_name', ...gone.map((g) => g.field)],
      `${label(c)} names ${gone.map((g) => `${g.who} on ${g.field}`).join(' and ')}, and that user is no longer active. The field is filled in, so every report counts this CI as owned, and every escalation reaches nobody.`,
      { confidence: 1.0,
        evidence: gone.map((g) => fact('cmdb_ci', g.field, g.who, 'sys_user.active = false')),
        guard: { evaluated: false, note: 'A user deactivated inside a grace period with a documented successor is the expected exception — check the leaver process before reassigning in bulk.' } });
  }
  if (unresolved) skip('CMDB-103', 'sys_user', `${unresolved} ownership reference(s) could not be resolved to a user state, so they were not judged — an unresolvable reference is not an inactive one`);
  if (!inactiveOwners) {
    skip('CMDB-103', 'cmdb_ci', `No owner, manager or assignee on this estate resolves to an inactive user — evaluated over every in-scope CI, with nothing to report`);
  }

  /* ── CMDB-104 — nobody owns the CLASS ──────────────────────────────────── */
  const classInfo = ctx.estate.cmdb_class_info || [];
  const classOwner = new Map(classInfo.map((r) => [val(r, 'class'), val(r, 'managed_by_group') && (val(r, 'managed_by_group.name') || val(r, 'managed_by_group'))]));
  const principals = new Set(classInfo.filter((r) => truthy(r.principal_class)).map((r) => r.class));
  const populated = [...new Set(scope.map((c) => c.sys_class_name).filter(Boolean))];
  const classScope = principals.size ? populated.filter((c) => principals.has(c)) : populated;
  const fallbackNote = principals.size ? '' : ' Evaluated over every populated class, because no principal classes are designated (CMDB-139).';
  if (!ctx.complete('cmdb_class_info', ['class'])) {
    skip('CMDB-104', 'cmdb_class_info', 'The class metadata was not read, so class-level ownership cannot be established');
  } else if (!classScope.length) {
    skip('CMDB-104', 'cmdb_ci', 'No populated class is in scope, so there is no class-level ownership to check');
  } else {
    const ownerless = classScope.filter((cls) => !classOwner.get(cls));
    if (ownerless.length) {
      /* Ranked by defect volume, as the catalogue asks — the class where the
         absence of an owner is costing the most. */
      const defectsByClass = new Map();
      for (const f of ctx.findings) {
        for (const id of f.target_ids || []) {
          const c = allCis.find((x) => x.sys_id === id);
          if (!c) continue;
          defectsByClass.set(c.sys_class_name, (defectsByClass.get(c.sys_class_name) || 0) + 1);
        }
      }
      const ranked = ownerless.map((cls) => ({
        cls,
        cis: scope.filter((c) => c.sys_class_name === cls).length,
        defects: defectsByClass.get(cls) || 0,
      })).sort((a, b) => b.defects - a.defects || b.cis - a.cis);
      const f = ctx.addCatalogued('CMDB-104', 'cmdb_ci', [], ['sys_class_name'],
        `${ownerless.length} of ${classScope.length} class(es) have no data owner at the class level: ${ranked.slice(0, 4).map((x) => `${x.cls} (${x.cis.toLocaleString('en-US')} CIs, ${x.defects.toLocaleString('en-US')} findings)`).join(', ')}. Nobody is accountable for the quality of these classes, so every other finding in them has no one to send it to — which is why this is posture rather than a deduction: it does not make the data worse, it makes the data unfixable.${fallbackNote}`,
        { agent: 'ownership_agent',
          evidence: ranked.slice(0, 20).map((x) => fact('cmdb_class_info', x.cls, 'no managed_by_group', `${x.cis} CI(s), ${x.defects} finding(s) with nobody to own them`)),
          guard: { evaluated: false, note: 'Ownership held in an external RACI with documented evidence is invisible here. Confirm before treating it as absent.' } });
      f.grouped_classes = ranked.map((x) => ({ cls: x.cls, cis: x.cis, defects: x.defects }));
    } else {
      skip('CMDB-104', 'cmdb_class_info', `Every one of the ${classScope.length} class(es) in scope has a class-level data owner — evaluated, with nothing to report`);
    }
  }

  /* ── CMDB-105 — nobody at all ──────────────────────────────────────────── */
  /*
   * CONSEQUENCE SCOPING, BOTH HALVES (see cmdb-signals.js).
   *
   * 1. Every ownerless CI is reported and charged — nothing is suppressed. The
   *    BAND is scoped by what the absence would strand: full on infrastructure,
   *    hosts, applications, services and anything supporting a Business Critical
   *    service; reduced on leaf devices and explicitly non-production CIs.
   * 2. The estate-wide share is raised ONCE as a zero-point pattern, so that
   *    "96.4% of this estate has no owner" is a headline and not something a
   *    reader has to reconstruct by counting rows.
   *
   * Doing only the first hides the headline; doing only the second is the raw
   * count again, where 2,684 laptops outweigh every database.
   */
  const ownerless = scope.filter((c) => !ownershipOf(c).length);
  const consequence = new Map();
  for (const c of ownerless) {
    const verdict = consequenceOf(c, { signals, inClasses, tiers: opt.classTiers });
    consequence.set(c.sys_id, verdict);
    const inferable = opt.inferableFields.filter((f) => val(c, f));
    const f = perRecord('CMDB-105', [c], ['name', 'sys_class_name', ...opt.ownershipFields],
      `${label(c)} has no ${opt.ownershipFields.join(', no ')} — no accountability reference of any kind.${inferable.length ? ` It does carry ${inferable.map((x) => `${x} = ${val(c, `${x}.name`) || val(c, x)}`).join(', ')}, which is a place to start rather than an owner: an assignee holds the device, not the record.` : ''} Every finding raised against it has nobody to send it to.`,
      { confidence: 1.0,
        evidence: [
          ...opt.ownershipFields.map((x) => fact('cmdb_ci', x, '(empty)', 'ownership field in use on this estate')),
          ...inferable.map((x) => fact('cmdb_ci', x, val(c, `${x}.name`) || val(c, x), 'a recoverable signal, not an owner')),
          fact('cmdb_ci', 'consequence', verdict.level, verdict.why),
        ],
        guard: { evaluated: false, note: 'Classes where ownership is genuinely held at the service level rather than the CI level belong in the exclusion list — confirm the estate\'s convention before bulk-assigning.' } });
    if (verdict.level === 'reduced') {
      f.deduction_band_override = CONSEQUENCE_REDUCED_BAND;
      if (f.deduction_severity !== 'SYSTEMIC') f.deduction_severity = CONSEQUENCE_REDUCED_BAND;
      f.deduction_note = `Charged at ${CONSEQUENCE_REDUCED_BAND} rather than ${f.base_severity}: ${verdict.why}. Reported in full either way — the charge is scoped by consequence, never suppressed.`;
    }
  }
  const ownerlessPct = scope.length ? (100 * ownerless.length) / scope.length : 0;
  ctx.measures.ownership_coverage.consequence = {
    full: [...consequence.values()].filter((v) => v.level === 'full').length,
    reduced: [...consequence.values()].filter((v) => v.level === 'reduced').length,
  };
  if (ownerless.length) {
    /*
     * THE HEADLINE. One finding, zero points, naming the share — because the
     * per-record charges are deliberately uneven and a reader must not have to
     * infer the estate-wide picture from them.
     */
    const byClass = [...ownerless.reduce((m, c) => m.set(c.sys_class_name, (m.get(c.sys_class_name) || 0) + 1), new Map())]
      .sort((a, b) => b[1] - a[1]);
    const disclose = ownerlessPct >= opt.selfDiscloseAbovePct;
    const head = ctx.addCatalogued('CMDB-105', 'cmdb_ci', [], ['sys_class_name'],
      `${ownerless.length.toLocaleString('en-US')} of ${scope.length.toLocaleString('en-US')} in-scope CIs (${pct1(ownerlessPct)}%) have no accountability reference of any kind. Worst: ${byClass.slice(0, 4).map(([cls, n]) => `${cls} (${n.toLocaleString('en-US')})`).join(', ')}. ${ctx.measures.ownership_coverage.consequence.full.toLocaleString('en-US')} of them are infrastructure, hosts, applications, services or CIs supporting a Business Critical service and carry the full charge; ${ctx.measures.ownership_coverage.consequence.reduced.toLocaleString('en-US')} are leaf or non-production CIs charged at ${CONSEQUENCE_REDUCED_BAND}. This finding itself deducts nothing — it is here so the scale is not something you have to count rows to see.${disclose ? ` \n\nAT THIS SHARE THE PARAMETER IS THE THING MOST LIKELY TO BE WRONG. Ownership was measured on ${opt.ownershipFields.join(', ')}. If accountability is held on another field on this estate — a custom owner, a CMDB owner group, a business-application reference — name that field and re-run before acting on this number.` : ''}`,
      { agent: 'ownership_agent',
        evidence: [
          fact('cmdb_ci', 'fields measured', opt.ownershipFields.join(', '), 'the per-estate ownership field set — override it if accountability lives elsewhere'),
          fact('cmdb_ci', 'unowned share', `${ownerless.length} of ${scope.length}`, `${pct1(ownerlessPct)}% of the in-scope estate`),
          fact('cmdb_ci', 'inferable only', ctx.measures.ownership_coverage.inferable_only, `carry ${opt.inferableFields.join('/')} but no owner — a place to start`),
          ...byClass.slice(0, 15).map(([cls, n]) => fact('cmdb_ci', cls, `${n} unowned`, 'by class')),
        ],
        guard: { evaluated: false, note: 'A near-universal absence is usually one decision, not thousands of oversights — and occasionally it is the wrong field being measured. Both are worth checking before a bulk assignment.' } });
    head.unscored_reason = 'the estate-wide headline — the records it counts are charged individually, scoped by consequence, so charging it again would double-count';
    head.grouped_classes = byClass.map(([cls, n]) => ({ cls, cis: n }));
  } else {
    skip('CMDB-105', 'cmdb_ci', `Every in-scope CI carries at least one of ${opt.ownershipFields.join(', ')} — evaluated, with nothing to report`);
  }

  /* ── CMDB-106 — the CI and its service disagree about who owns it ──────── */
  const svcOk = ctx.complete('cmdb_ci_service', ['name']) && ctx.complete('svc_ci_assoc', ['service', 'ci']);
  if (!svcOk) {
    skip('CMDB-106', 'svc_ci_assoc', 'The services and their CI associations were not read completely, so a CI\'s ownership cannot be compared with its service\'s');
  } else {
    const services = new Map((ctx.estate.cmdb_ci_service || []).map((s) => [s.sys_id, s]));
    const byService = new Map();
    for (const a of ctx.estate.svc_ci_assoc || []) {
      if (!a.service || !a.ci) continue;
      if (!byService.has(a.service)) byService.set(a.service, []);
      byService.get(a.service).push(a.ci);
    }
    const scopeIds = new Set(cisFor('CMDB-106').map((c) => c.sys_id));
    const byId = new Map(allCis.map((c) => [c.sys_id, c]));
    let compared = 0;
    for (const [svcId, ciIds] of byService) {
      const svc = services.get(svcId);
      if (!svc) continue;
      const svcOwner = val(svc, 'owned_by');
      const svcGroup = val(svc, 'support_group');
      if (!svcOwner && !svcGroup) continue;               // the service has no opinion
      const members = ciIds.map((id) => byId.get(id)).filter((c) => c && scopeIds.has(c.sys_id));
      if (members.length < opt.serviceDivergenceMinCis) continue;
      const divergent = members.filter((c) => {
        const owner = val(c, 'owned_by');
        const group = val(c, 'support_group');
        if (!owner && !group) return false;               // no ownership is CMDB-105's finding
        return (owner && svcOwner && owner !== svcOwner) || (group && svcGroup && group !== svcGroup);
      });
      compared += 1;
      if (!divergent.length) continue;
      /* The catalogue asks for the RATIO per service before individual findings. */
      const share = (100 * divergent.length) / members.length;
      perRecord('CMDB-106', divergent, ['name', 'sys_class_name', 'owned_by', 'support_group'],
        `${divergent.length} of ${members.length} CI(s) supporting "${val(svc, 'name')}" (${pct1(share)}%) are owned by somebody other than the service: the service names ${val(svc, 'owned_by.name') || svcOwner || val(svc, 'support_group.name') || svcGroup}, these do not. When the service breaks, the escalation path and the people who can actually change these CIs are different lists.`,
        { confidence: 0.8,
          evidence: [
            fact('cmdb_ci_service', 'service owner', val(svc, 'owned_by.name') || svcOwner || val(svc, 'support_group.name') || svcGroup, val(svc, 'name')),
            fact('cmdb_ci', 'divergent CIs', `${divergent.length} of ${members.length}`, `${pct1(share)}% of the service's CIs`),
          ],
          guard: { evaluated: false, note: 'Legitimate separation between infrastructure ownership and service ownership is common and deliberate. Confirm the estate\'s convention — divergence is a signal, not proof, which is why this is 80% confidence.' } });
    }
    if (!compared) {
      /* Name the cause, not the threshold: the reason nothing could be compared
         is almost always that ownership itself is absent (CMDB-105), and a reason
         that only cites a parameter sends the reader to tune the parameter. */
      const ownedShare = scope.length ? pct1((100 * owned.length) / scope.length) : 0;
      skip('CMDB-106', 'cmdb_ci_service', `Nothing could be compared: no service both carries ownership of its own AND has at least ${opt.serviceDivergenceMinCis} in-scope CI(s) that carry any. That is a CONSEQUENCE of ownership being absent rather than a threshold being strict — only ${ownedShare}% of in-scope CIs have any owner at all (CMDB-105), so there is nothing for a service's ownership to diverge FROM. Fix the absence first; this rule becomes measurable on its own.`);
    }
  }

  /* ── CMDB-107 — one person holding too much of it ──────────────────────── */
  const holders = new Map();                              // key -> { field, name, cis }
  for (const c of cisFor('CMDB-107')) {
    for (const f of opt.ownershipFields) {
      const v = val(c, f);
      if (!v) continue;
      const key = `${f}|${v}`;
      if (!holders.has(key)) holders.set(key, { field: f, name: val(c, `${f}.name`) || v, cis: 0 });
      holders.get(key).cis += 1;
    }
  }
  const ranked = [...holders.values()].sort((a, b) => b.cis - a.cis);
  const scopeN = cisFor('CMDB-107').length;
  const ownedN = owned.length;
  ctx.measures.ownership_distribution = {
    in_scope: scopeN, owned: ownedN,
    top: ranked.slice(0, 10).map((h) => ({ field: h.field, name: h.name, cis: h.cis, estate_pct: pct1((100 * h.cis) / (scopeN || 1)) })),
  };
  /* The distribution is reported regardless, per the catalogue. */
  const concentrated = ranked.filter((h) => (100 * h.cis) / (scopeN || 1) > opt.concentrationPct);
  for (const h of concentrated) {
    perRecord('CMDB-107', [], ['sys_class_name'],
      `${h.name} holds ${h.cis.toLocaleString('en-US')} CI(s) on ${h.field} — ${pct1((100 * h.cis) / scopeN)}% of the in-scope estate, past the ${opt.concentrationPct}% threshold. One person's absence would leave that share of the CMDB with nobody who can answer for it.`,
      { confidence: 1.0,
        evidence: [
          fact('cmdb_ci', h.field, `${h.cis} of ${scopeN}`, `${pct1((100 * h.cis) / scopeN)}% of the in-scope estate — the threshold basis`),
          fact('cmdb_ci', 'share of owned CIs', `${pct1((100 * h.cis) / (ownedN || 1))}%`, 'context: the share of CIs that have any owner at all'),
        ],
        guard: { evaluated: false, note: 'A genuinely centralised infrastructure team is the expected exception. The judgement that concentration is wrong is advisory; the distribution is the fact.' } });
  }
  if (!concentrated.length) {
    const top = ranked[0];
    skip('CMDB-107', 'cmdb_ci', top
      ? `No owner holds more than ${opt.concentrationPct}% of the ${scopeN.toLocaleString('en-US')} in-scope CIs — the largest is ${top.name} with ${top.cis.toLocaleString('en-US')} (${pct1((100 * top.cis) / scopeN)}%). Measured against the WHOLE estate rather than the owned subset, where that same holder is ${pct1((100 * top.cis) / (ownedN || 1))}%: concentration is about how much of the estate one absence would strand, and on an estate where ${pct1(100 - (100 * ownedN) / (scopeN || 1))}% is unowned the finding is absence, not concentration.`
      : 'No in-scope CI carries any ownership at all, so there is no distribution to concentrate');
  }

  /* ── CMDB-108 — ownership that has never moved ─────────────────────────── */
  /*
   * Needs the audit log, which is opt-in (see CMDB-077): reading it by default
   * would destroy scan reuse. Without it, "ownership has never changed" cannot
   * be told from "we did not look at the history", and the catalogue's own basis
   * is "100% on audit absence" — so the rule abstains rather than inferring.
   */
  const auditRows = ctx.estate.sys_audit || [];
  const ownershipAudited = new Set();
  for (const a of auditRows) {
    if ([...opt.ownershipFields, ...opt.inferableFields].includes(val(a, 'fieldname')) && a.documentkey) ownershipAudited.add(a.documentkey);
  }
  const oldEnough = (c) => {
    const age = days(parseDate(c.sys_created_on));
    return age != null && age > opt.ownershipAgeDays;
  };
  if (!auditRows.length) {
    skip('CMDB-108', 'sys_audit', `NOT MEASURED — the audit log is not read (it is opt-in; pass 'sys_audit' in the scan's table list, at the cost of scan reuse — see CMDB-077), so "ownership has never changed" cannot be told from "we did not look at the history". The catalogue's basis for this rule is audit absence, and inferring it from anything else would be a guess with a percentage attached.`);
  } else {
    const stuck = cisFor('CMDB-108').filter((c) => ownershipOf(c).length && oldEnough(c) && !ownershipAudited.has(c.sys_id));
    if (stuck.length) {
      const byClass = [...stuck.reduce((m, c) => m.set(c.sys_class_name, (m.get(c.sys_class_name) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
      const f = ctx.addCatalogued('CMDB-108', 'cmdb_ci', [], ['sys_class_name', 'owned_by'],
        `${stuck.length.toLocaleString('en-US')} owned CI(s) older than ${opt.ownershipAgeDays} days have never had an ownership field change: ${byClass.slice(0, 4).map(([cls, n]) => `${cls} (${n})`).join(', ')}. People move teams and leave; ownership that has never followed them is a record of who was there once.`,
        { agent: 'ownership_agent',
          evidence: byClass.slice(0, 20).map(([cls, n]) => fact('sys_audit', cls, `${n} CI(s) with no ownership audit entry`, `older than ${opt.ownershipAgeDays} days`)),
          guard: { evaluated: true, note: 'Stable ownership is legitimate and common, which is why the catalogue asks for this as a pattern rather than a per-record charge.' } });
      f.unscored_reason = 'names classes, not records — the catalogue reports unchanged ownership as a ratio per class, and charging a sample of it would be arbitrary';
      f.grouped_classes = byClass.map(([cls, n]) => ({ cls, cis: n }));
    } else {
      skip('CMDB-108', 'sys_audit', `No owned CI older than ${opt.ownershipAgeDays} days is without an ownership change in the audit history — evaluated, with nothing to report`);
    }
  }

  if (inactiveCis.length) {
    skip('CMDB-105', 'cmdb_ci', `${inactiveCis.length} retired, stolen or absent CI(s) are outside this dimension — nobody needs to own a decommissioned server, so they are excluded from the findings AND from the denominator. D8 judges those CIs.`);
  }
}
