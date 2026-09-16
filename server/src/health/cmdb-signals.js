/**
 * CONTEXT SIGNALS — what the Schema tab's severity modifiers need to know about a record.
 *
 * PURE. Reads the extracted estate and the meta reads; decides nothing about a
 * rule. A rule asks `modifiersFor(records)` and gets back which escalators and
 * de-escalators apply AND which could not be evaluated, so a finding never
 * implies a modifier was checked when it was not.
 *
 * ═══ WHAT IS EVALUATED ═══
 *
 *   business_critical_service  CI reachable DOWNWARD (parent → child) from a service
 *                              whose busines_criticality is "1 - most critical", or
 *                              associated to one in svc_ci_assoc.
 *   production                 ONLY when production is EXPLICIT (decision 5, 17 Sep):
 *                              used_for set to Production where that differs from the
 *                              class's OOB default, or an audit row shows it was set —
 *                              or production is INFERRED independently: an IP in a
 *                              configured production range, a configured production
 *                              discovery source, or a parent service that is itself
 *                              explicitly production. The bare default is never
 *                              evidence; an unset used_for is CMDB-016's business.
 *   non_production             used_for explicitly set to a non-production value.
 *   shared_infrastructure      class lineage includes a network-core, load-balancer,
 *                              directory or database class. Configurable.
 *   retiring                   life_cycle_stage_status names a retirement state.
 *   class_defect_rate /        MATERIALITY, per rule and per class (decision 3, 17 Sep):
 *   below_materiality          escalate when a rule affects ≥ 20% of the in-scope class
 *                              AND ≥ 10 CIs; de-escalate when it affects fewer than
 *                              max(5, 1% of the class). Applied after every rule has run,
 *                              by `materialityFor`.
 *   approved_exception         "accepted risk" on the same fingerprint (rules.js).
 *
 *   NOT evaluated yet, and said so on every finding: cross-domain cause, duration
 *   beyond 30 days, silent failure, recurrence after remediation, approval
 *   controls, class not consumed, compensating control.
 */

export const SIGNAL_DEFAULTS = Object.freeze({
  bcDepth: 6,
  bcCriticality: /^1\b/,
  sharedInfrastructure: Object.freeze([
    'cmdb_ci_netgear', 'cmdb_ci_ip_router', 'cmdb_ci_ip_switch', 'cmdb_ci_ip_firewall', 'cmdb_ci_lb',
    'cmdb_ci_directory', 'cmdb_ci_ldap_server', 'cmdb_ci_db_instance',
  ]),
  nonProduction: Object.freeze(['development', 'test', 'qa', 'staging', 'lab', 'training', 'demonstration', 'uat', 'sandbox']),
  retiring: /retir/i,
  /* Independent production evidence. Empty by default — an estate states its own. */
  productionCidrs: Object.freeze([]),
  productionDiscoverySources: Object.freeze([]),
  materiality: Object.freeze({ escalateRatePct: 20, escalateMinCount: 10, floorCount: 5, floorRatePct: 1 }),
});

/**
 * WHICH CIs A DATA-QUALITY RULE JUDGES (decision 7 of 19 Sep).
 *
 * Retired, Stolen and Absent CIs are excluded from completeness, correctness,
 * uniqueness, identification and reconciliation: nobody maintains a retired
 * record, and charging it for a missing serial is noise. They are NOT excluded
 * from the estate — the lifecycle dimension (Group 8, CMDB-085/087) exists to
 * evaluate exactly those statuses, and must see them.
 *
 * The values are the platform's own install_status choices: 7 Retired,
 * 8 Stolen, 100 Absent. An EMPTY status stays in scope, deliberately: a CI with
 * no status is not retired, it is unmaintained, and the rules should say so.
 */
export const DQ_INACTIVE_INSTALL_STATUS = Object.freeze(['7', '8', '100']);

export function isDqActive(ci, statuses = DQ_INACTIVE_INSTALL_STATUS) {
  return !statuses.includes(String(ci?.install_status ?? '').trim());
}

/** The data-quality slice of a CI list, and what it left out. */
export function dqActive(cis, statuses = DQ_INACTIVE_INSTALL_STATUS) {
  const active = [];
  const excluded = [];
  for (const c of cis || []) (isDqActive(c, statuses) ? active : excluded).push(c);
  return { active, excluded };
}

export const NOT_EVALUATED = Object.freeze({
  cross_domain_cause: 'Cross-domain causal clustering is not built yet.',
  duration_over_30_days: 'First-seen history per finding is not tracked yet.',
  silent_failure: 'Not applicable to this rule.',
  recurred: 'Needs remediation history per finding (Group 14).',
  control: 'Not applicable to this rule.',
  not_consumed: 'Task references per class are not read yet.',
  compensating_control: 'No compensating-control register exists yet.',
});

const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());

export function lineageOf(meta, name) {
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

function ipToInt(ip) {
  const m = String(ip || '').trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}
export function inCidr(ip, cidr) {
  const [base, bits] = String(cidr).split('/');
  const a = ipToInt(ip);
  const b = ipToInt(base);
  const n = Number(bits);
  if (a == null || b == null || !(n >= 0 && n <= 32)) return false;
  const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export function buildSignals(ctx, options = {}) {
  const opt = { ...SIGNAL_DEFAULTS, ...options };
  const meta = ctx.meta?.cmdb || {};
  const hierarchyOk = meta.reads?.class_hierarchy?.status === 'ok';
  const lineage = (cls) => lineageOf(meta, cls);

  const relOk = ctx.complete('cmdb_rel_ci', ['parent', 'child']);
  const down = new Map();
  if (relOk) {
    for (const r of ctx.estate.cmdb_rel_ci || []) {
      if (!r.parent || !r.child) continue;
      if (!down.has(r.parent)) down.set(r.parent, []);
      down.get(r.parent).push(r.child);
    }
  }
  const downFrom = (seeds) => {
    const out = new Set();
    for (const seed of seeds) {
      let frontier = [seed];
      const seen = new Set(frontier);
      for (let depth = 0; depth < opt.bcDepth && frontier.length; depth++) {
        const next = [];
        for (const id of frontier) {
          for (const child of down.get(id) || []) {
            if (seen.has(child)) continue;
            seen.add(child);
            out.add(child);
            next.push(child);
          }
        }
        frontier = next;
      }
    }
    return out;
  };
  const assoc = ctx.complete('svc_ci_assoc', ['service', 'ci']) ? (ctx.estate.svc_ci_assoc || []) : [];
  const services = ctx.estate.cmdb_ci_service || [];
  const servicesOk = ctx.complete('cmdb_ci_service', ['busines_criticality']);

  /* Business Critical service support. */
  let bcSupported = null;
  let bcServices = [];
  let bcWhyNot = null;
  if (!servicesOk) bcWhyNot = 'cmdb_ci_service.busines_criticality was not read completely';
  else if (!relOk) bcWhyNot = 'cmdb_rel_ci was not read completely';
  else {
    bcServices = services.filter((s) => opt.bcCriticality.test(String(s.busines_criticality || '')));
    bcSupported = downFrom(bcServices.map((s) => s.sys_id));
    for (const a of assoc) if (bcServices.some((s) => s.sys_id === a.service) && a.ci) bcSupported.add(a.ci);
  }

  /* Service-bound CIs — should resolve to a service (CMDB-141's denominator). */
  let serviceBound = null;
  if (servicesOk && relOk) {
    serviceBound = downFrom(services.map((s) => s.sys_id));
    for (const a of assoc) if (a.ci) serviceBound.add(a.ci);
    for (const s of services) if (String(s.busines_criticality || '').trim()) serviceBound.add(s.sys_id);
  }

  /* Production — explicit or independently inferred, never the bare default. */
  const usedForOk = meta.reads?.used_for?.status === 'ok';
  const usedFor = usedForOk ? (meta.usedFor || {}) : null;
  const setIds = new Set(meta.usedForSetIds || []);
  const defaultFor = (cls) => {
    for (const t of lineage(cls)) if (meta.usedForDefaults && t in meta.usedForDefaults) return meta.usedForDefaults[t];
    return null;
  };
  const explicitProduction = (id, cls, value) => {
    if (String(value ?? '').trim().toLowerCase() !== 'production') return false;
    const def = defaultFor(cls);
    return setIds.has(id) || (def != null && String(def).trim().toLowerCase() !== 'production');
  };
  const prodServices = usedForOk && servicesOk
    ? services.filter((s) => explicitProduction(s.sys_id, s.sys_class_name || 'cmdb_ci_service', s.used_for)).map((s) => s.sys_id)
    : [];
  const prodServiceSupported = relOk ? downFrom(prodServices) : new Set();

  const retiringIds = ctx.complete('life_cycle_stage_status', ['name'])
    ? new Set((ctx.estate.life_cycle_stage_status || []).filter((s) => opt.retiring.test(String(s.name || ''))).map((s) => s.sys_id))
    : null;

  return {
    options: opt,
    hierarchyOk,
    bcSupported,
    bcServices: bcServices.map((s) => ({ sys_id: s.sys_id, name: s.name })),
    bcWhyNot,
    serviceBound,
    usedFor,
    retiringIds,
    lineage,
    /** 'explicit' | 'inferred' | null — why this record counts as production, if it does. */
    productionOf(r) {
      if (usedFor && r.sys_id in usedFor && explicitProduction(r.sys_id, r.sys_class_name, usedFor[r.sys_id])) return 'explicit';
      if (opt.productionCidrs.some((c) => inCidr(r.ip_address, c))) return 'inferred';
      if (opt.productionDiscoverySources.includes(r.discovery_source)) return 'inferred';
      if (prodServiceSupported.has(r.sys_id)) return 'inferred';
      return null;
    },
  };
}

/**
 * The modifiers for a finding over `records` (cmdb_ci rows).
 * Escalate when ANY record meets an escalator; de-escalate only when ALL do.
 */
export function modifiersFor(records, signals) {
  const escalators = [];
  const deEscalators = [];
  const notEvaluated = new Set(Object.keys(NOT_EVALUATED));
  const s = signals;
  if (!s || !records.length) return { escalators, deEscalators, notEvaluated: [...notEvaluated] };

  if (s.bcSupported) {
    if (records.some((r) => s.bcSupported.has(r.sys_id))) escalators.push('business_critical_service');
  } else notEvaluated.add('business_critical_service');

  if (records.some((r) => s.productionOf(r))) escalators.push('production');
  else {
    /* "Not production" is only a finding about a record whose environment could be
       read. With no used_for on the class and no configured independent evidence,
       production was not evaluated — and the finding says so. */
    const readable = s.usedFor && records.some((r) => r.sys_id in s.usedFor);
    const inferable = s.options.productionCidrs.length || s.options.productionDiscoverySources.length;
    if (!readable && !inferable) notEvaluated.add('production');
  }

  if (s.usedFor) {
    const values = records.map((r) => s.usedFor[r.sys_id]);
    if (values.every((v) => v !== undefined && s.options.nonProduction.includes(String(v).toLowerCase()))) deEscalators.push('non_production');
  }

  if (s.hierarchyOk) {
    if (records.some((r) => s.lineage(r.sys_class_name || 'cmdb_ci').some((c) => s.options.sharedInfrastructure.includes(c)))) {
      escalators.push('shared_infrastructure');
    }
  } else notEvaluated.add('shared_infrastructure');

  if (s.retiringIds && records.every((r) => 'life_cycle_stage_status' in r)) {
    if (records.every((r) => s.retiringIds.has(r.life_cycle_stage_status))) deEscalators.push('retiring');
  } else notEvaluated.add('retiring');

  /* Materiality is decided after every rule has run (materialityFor). */
  notEvaluated.add('class_defect_rate');
  notEvaluated.add('below_materiality');
  return { escalators, deEscalators, notEvaluated: [...notEvaluated] };
}

/**
 * MATERIALITY, per rule and per class.
 *
 * @param {object[]} findings   record findings of one scored dimension track
 * @param {Map<string,object>} ciById  in-scope CIs by sys_id
 * @returns {Map<string, {escalate: boolean, deEscalate: boolean, affected: number, classSize: number, cls: string}>} by fingerprint
 */
export function materialityFor(findings, ciById, options = SIGNAL_DEFAULTS.materiality) {
  const classSize = new Map();
  for (const c of ciById.values()) classSize.set(c.sys_class_name, (classSize.get(c.sys_class_name) || 0) + 1);
  const affected = new Map();                       // rule|class -> Set(ci)
  const classOf = (f) => {
    const counts = new Map();
    for (const id of f.target_ids || []) {
      const c = ciById.get(id);
      if (c) counts.set(c.sys_class_name, (counts.get(c.sys_class_name) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const cls = new Map();
  for (const f of findings) {
    const k = classOf(f);
    cls.set(f.fingerprint, k);
    if (!k) continue;
    const key = `${f.rule_id}|${k}`;
    if (!affected.has(key)) affected.set(key, new Set());
    for (const id of f.target_ids || []) if (ciById.get(id)?.sys_class_name === k) affected.get(key).add(id);
  }
  const out = new Map();
  for (const f of findings) {
    const k = cls.get(f.fingerprint);
    if (!k) continue;
    const n = affected.get(`${f.rule_id}|${k}`).size;
    const size = classSize.get(k) || 0;
    const rate = size ? (100 * n) / size : 0;
    out.set(f.fingerprint, {
      cls: k, affected: n, classSize: size,
      escalate: n >= options.escalateMinCount && rate >= options.escalateRatePct,
      deEscalate: n < Math.max(options.floorCount, (options.floorRatePct / 100) * size),
    });
  }
  return out;
}

export { truthy };
