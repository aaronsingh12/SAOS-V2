import { modifiersFor, lineageOf, dqActive, cisForRule, DQ_INACTIVE_INSTALL_STATUS, CLASS_TIERS, consequenceOf, CONSEQUENCE_REDUCED_BAND } from './cmdb-signals.js';

/**
 * GROUP 11 — CSDM LINKAGE. CMDB-109 to CMDB-115.
 *
 * ═══ A MIXED GROUP, AND THE MIX IS THE POINT ═══
 *
 * Unlike Group 9, this group is not uniformly posture. Four rules feed the
 * SCORED D10 dimension and three are CSDM-maturity posture that must never
 * charge anything:
 *
 *   D10 (scored)        CMDB-109, CMDB-110, CMDB-113, CMDB-114
 *   csdm-maturity       CMDB-111, CMDB-112, CMDB-115
 *
 * The distinction is not stylistic. CMDB-113 and CMDB-114 are contradictions —
 * two records in the same instance asserting different things — and a
 * contradiction is a defect in the data whoever owns it. CMDB-112 measures how
 * far an estate has climbed the CSDM ladder, which is a programme's progress and
 * not a data defect: charging the composite for it would mark an estate down for
 * a maturity model it may not have adopted.
 *
 * `CSDM_TRACKS` below DECLARES which is which, and `trackMisroutes` checks the
 * catalogue against it on every run — because a posture rule that quietly
 * acquires a dimension would start charging the score, and a D10 rule that
 * quietly loses one would stop, and neither would announce itself.
 *
 * ═══ WHAT THIS INSTANCE KEEPS (verified on dev424910, Sep 2026) ═══
 *
 *   THE CSDM CLASS MODEL IS NOT IN USE. `cmdb_ci_service_business`,
 *   `cmdb_ci_service_auto`, `cmdb_ci_service_discovered`, `service_offering`,
 *   `cmdb_ci_business_app` and `cmdb_ci_business_capability` are ALL EMPTY. All
 *   41 services sit on the base `cmdb_ci_service` class (plus one
 *   `cmdb_ci_service_group`). So the layer a rule needs usually does not exist,
 *   and the rule says which layer is missing rather than reporting zero defects.
 *
 *   `svc_ci_assoc` IS EMPTY. This estate links CIs to services through
 *   `cmdb_rel_ci` alone, which is the catalogue's own documented false positive
 *   for CMDB-114 ("the estate deliberately uses one mechanism"). A symmetric
 *   difference against an empty set would report every relationship edge as a
 *   disagreement — the loudest possible way to be wrong.
 *
 *   `cmdb_ci.used_for` is unpopulated, so CMDB-111 has no environment to
 *   contradict.
 *
 * WHERE A LAYER IS ABSENT, the rules fall back to the base service class and SAY
 * SO in the finding — the same discipline as the principal-class fallback
 * (CMDB-139). A fallback that is not named is an assumption.
 *
 * PURE — no network, no database.
 */

export const CSDM_RULES = Object.freeze([
  'CMDB-109', 'CMDB-110', 'CMDB-111', 'CMDB-112', 'CMDB-113', 'CMDB-114', 'CMDB-115',
]);

/**
 * What each rule in this group is FOR — checked against the catalogue every run.
 * `scored` means it deducts from its dimension; anything else is posture.
 */
export const CSDM_TRACKS = Object.freeze({
  'CMDB-109': { scored: true, dimension: 'D10' },
  'CMDB-110': { scored: true, dimension: 'D10' },
  'CMDB-113': { scored: true, dimension: 'D10' },
  'CMDB-114': { scored: true, dimension: 'D10' },
  'CMDB-111': { scored: false },
  'CMDB-112': { scored: false },
  'CMDB-115': { scored: false },
});

export const CSDM_DEFAULTS = Object.freeze({
  dqInactiveInstallStatus: DQ_INACTIVE_INSTALL_STATUS,
  /* The CSDM layers, by class. Empty on an estate that has not adopted them. */
  businessServiceClasses: Object.freeze(['cmdb_ci_service_business']),
  applicationServiceClasses: Object.freeze(['cmdb_ci_service_auto', 'cmdb_ci_service_discovered']),
  capabilityClasses: Object.freeze(['cmdb_ci_business_capability']),
  /* The base class every service sits on when the model is not in use. */
  baseServiceClasses: Object.freeze(['cmdb_ci_service']),
  /*
   * COUPLED TO D6 (recorded Sep 2026). This is the same traversal depth
   * CMDB-057 and CMDB-067 use in `cmdb-relationships.js`, and it must move with
   * them: a CSDM reach measured at a different depth from the relationship reach
   * would have the two dimensions disagreeing about the same graph.
   */
  traversalDepth: 8,
  /*
   * How many CIs a CSDM layer needs before it counts as IN USE. One is enough —
   * the question is existence, not maturity — but it is a setting because an
   * estate mid-migration may have a handful of placeholder rows.
   */
  minLayerCis: 1,
  /* CMDB-112 — the share of principal CIs a capability should reach. */
  capabilityReachPct: 40,
  classTiers: CLASS_TIERS,
});

const pct1 = (n) => Number(n.toFixed(1));
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const val = (r, f) => String(r?.[f] ?? '').trim();

/**
 * Rules whose declared track disagrees with the catalogue.
 *
 * A posture rule that quietly acquires a dimension starts charging the score; a
 * D10 rule that quietly loses one stops. Neither announces itself, and a mixed
 * group is exactly where that happens — so the declaration is checked rather
 * than trusted.
 */
export function trackMisroutes(catalogue, expectations = CSDM_TRACKS) {
  const bad = [];
  for (const [id, want] of Object.entries(expectations)) {
    const rule = catalogue?.[id];
    if (!rule) { bad.push({ rule_id: id, why: `${id} is declared in CSDM_TRACKS but is not in the catalogue` }); continue; }
    const scored = rule.track === 'dimension' && Boolean(rule.dimension);
    if (want.scored && !scored) {
      bad.push({ rule_id: id, title: rule.title, why: `${id} is declared as a SCORED ${want.dimension} rule but the catalogue routes it to "${rule.track}"${rule.dimension ? '' : ' with no dimension'} — it would stop charging the score without saying so` });
    } else if (!want.scored && scored) {
      bad.push({ rule_id: id, title: rule.title, why: `${id} is declared as POSTURE but the catalogue scores it in ${rule.dimension} — it would start charging the composite for a maturity measure` });
    } else if (want.scored && want.dimension && rule.dimension !== want.dimension) {
      bad.push({ rule_id: id, title: rule.title, why: `${id} is declared as ${want.dimension} but the catalogue scores it in ${rule.dimension}` });
    }
  }
  return bad;
}

export function cmdbCsdmRules(ctx, options = {}) {
  const opt = { ...CSDM_DEFAULTS, ...options };
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
  const csdm = (rule, table, records, fields, description, extra = {}) => {
    const m = modifiersFor(records, signals);
    return ctx.addCatalogued(rule, table, records, fields, description, {
      agent: 'csdm_agent', escalators: m.escalators, deEscalators: m.deEscalators, notEvaluated: m.notEvaluated, ...extra,
    });
  };
  ctx.measures ||= {};

  const serviceOk = ctx.complete('cmdb_ci_service', ['name']);
  if (!serviceOk) {
    for (const r of CSDM_RULES) skip(r, 'cmdb_ci_service', 'The services were not read completely, so the CSDM model cannot be evaluated — an absence rule over a partial service list reports our own access');
    return;
  }
  const services = (ctx.estate.cmdb_ci_service || []).filter((s) => s.sys_id);
  const byId = new Map(allCis.map((c) => [c.sys_id, c]));

  /* ═══ Which CSDM layers this estate actually uses ═══════════════════════ */
  const inLayer = (s, classes) => (hierarchyOk
    ? line(s.sys_class_name || 'cmdb_ci_service').some((t) => classes.includes(t))
    : classes.includes(s.sys_class_name));
  const layerOf = (classes) => services.filter((s) => inLayer(s, classes));
  const businessServices = layerOf(opt.businessServiceClasses);
  const applicationServices = layerOf(opt.applicationServiceClasses);
  const capabilities = allCis.filter((c) => inClasses(c, opt.capabilityClasses));
  const baseServices = layerOf(opt.baseServiceClasses);
  ctx.measures.csdm_layers = {
    services: services.length,
    business_service: businessServices.length,
    application_service: applicationServices.length,
    business_capability: capabilities.length,
    base_only: businessServices.length === 0 && applicationServices.length === 0,
  };
  /*
   * THE FALLBACK IS NAMED, ALWAYS. When a CSDM layer is empty, a rule about that
   * layer has two honest options: say the layer is absent, or evaluate the base
   * class and declare that it did. It never silently reports zero defects,
   * because "no Business Service is unreachable" and "there are no Business
   * Services" are opposite findings that look identical in a count.
   */
  /*
   * SELF-DISCLOSURE, the CMDB-105 mechanism applied to structural absence.
   *
   * "The layer is absent" is a conclusion drawn against a CONFIGURED class list,
   * and near-total absence is exactly where that parameter is most likely to be
   * the thing that is wrong — an estate with custom CSDM classes would read as
   * having adopted nothing. So every layer-absent verdict names the list it
   * measured against and says what to do about it.
   */
  const disclose = (classes) => ` Measured against ${classes.join(', ')}. If this estate's CSDM model uses custom classes, name them and re-run before acting on this — at near-total absence the class list is the likeliest thing to be wrong.`;
  const fallbackNote = ctx.measures.csdm_layers.base_only
    ? ` The CSDM class model is not in use on this instance — every service sits on the base ${opt.baseServiceClasses.join('/')} class.${disclose([...opt.businessServiceClasses, ...opt.applicationServiceClasses])}`
    : '';

  /* ── CMDB-109 — a service nothing reaches (D10, scored) ────────────────── */
  const relOk = ctx.complete('cmdb_rel_ci', ['parent', 'child']);
  const edges = relOk ? (ctx.estate.cmdb_rel_ci || []).filter((e) => e.parent && e.child) : [];
  const assocRead = ctx.complete('svc_ci_assoc', ['service', 'ci']);
  const assoc = assocRead ? (ctx.estate.svc_ci_assoc || []) : [];
  const inbound = new Map();                              // child -> parents
  const outbound = new Map();                             // parent -> children
  for (const e of edges) {
    if (!inbound.has(e.child)) inbound.set(e.child, []);
    if (!outbound.has(e.parent)) outbound.set(e.parent, []);
    inbound.get(e.child).push(e.parent);
    outbound.get(e.parent).push(e.child);
  }
  const reaches = (startIds, adjacency, depth) => {
    const seen = new Set(startIds);
    let frontier = [...startIds];
    let d = 0;
    while (frontier.length && d < depth) {
      const next = [];
      for (const id of frontier) for (const n of adjacency.get(id) || []) if (!seen.has(n)) { seen.add(n); next.push(n); }
      if (!next.length) break;
      frontier = next;
      d += 1;
    }
    return seen;
  };

  const layerInUse = businessServices.length >= opt.minLayerCis;
  if (!relOk) {
    for (const r of ['CMDB-109', 'CMDB-113', 'CMDB-114']) skip(r, 'cmdb_rel_ci', 'The relationships were not read completely, so traversal would describe our access rather than the model');
  } else if (!services.length) {
    skip('CMDB-109', 'cmdb_ci_service', 'This instance has no service CIs at all, so there is no Business Service to be unreachable — CSDM coverage, not a linkage defect');
  } else if (!layerInUse) {
    /*
     * ONE RULE MUST NOT CONTRADICT THE GROUP'S OWN CONCLUSION (decision of Sep
     * 2026). CMDB-110, 112, 113 and 114 all report, honestly, that the CSDM
     * layer is absent. CMDB-109 used to evaluate the BASE class instead and
     * report reachability defects inside a service model that does not exist —
     * eight "defects" in a thing the same group had just said was not there.
     *
     * It now DEFERS: the base-class services are reported as what they actually
     * are, a STRUCTURAL fact about how services are modelled, and nothing is
     * charged for unreachability within a layer nobody has adopted.
     */
    const f = ctx.addCatalogued('CMDB-109', 'cmdb_ci_service', [], ['name', 'sys_class_name'],
      `${services.length.toLocaleString('en-US')} service(s) on this instance are modelled on the base ${opt.baseServiceClasses.join('/')} class rather than on a CSDM service class — the Business Service layer holds ${businessServices.length}. Reachability was NOT evaluated: reporting services as unreachable inside a service model that does not exist would contradict what the rest of this group found, so this is reported as the structural fact it is. Adopt the CSDM service classes and the reachability question becomes answerable.${disclose(opt.businessServiceClasses)}`,
      { agent: 'csdm_agent',
        evidence: [
          fact('cmdb_ci_service', 'base-class services', services.length, `on ${opt.baseServiceClasses.join('/')}`),
          fact('cmdb_ci_service', 'CSDM Business Services', businessServices.length, `on ${opt.businessServiceClasses.join('/')} — below the floor of ${opt.minLayerCis}`),
        ],
        guard: { evaluated: true, note: 'Deferred to the layer-absent verdict the rest of the group reports; this is a structural finding, not a reachability defect.' } });
    f.unscored_reason = 'structural: the CSDM service layer is not in use, so there is no reachability defect to charge — CMDB-112 reports the adoption gap as maturity';
    skip('CMDB-109', 'cmdb_ci_service', `Reachability was not measured: ${businessServices.length} CI(s) sit on ${opt.businessServiceClasses.join(' or ')}, below the ${opt.minLayerCis}-CI floor for the layer to count as in use. Evaluating the base class instead would report defects inside a model this estate has not adopted.`);
  } else {
    const bsScope = businessServices;
    const unreachable = bsScope.filter((s) => {
      const below = reaches([s.sys_id], outbound, opt.traversalDepth);
      below.delete(s.sys_id);
      const above = (inbound.get(s.sys_id) || []).length;
      const linked = assoc.some((a) => a.service === s.sys_id);
      return below.size === 0 && above === 0 && !linked;
    });
    for (const s of unreachable) {
      csdm('CMDB-109', 'cmdb_ci_service', [s], ['name', 'sys_class_name'],
        `The service "${val(s, 'name')}" cannot be reached from any CI: nothing points at it, it points at nothing, and no association names it — within ${opt.traversalDepth} hops. It exists as a record and as nothing else, so no outage, change or alert on any infrastructure will ever mention it.${fallbackNote}`,
        { confidence: 1.0,
          evidence: [
            fact('cmdb_rel_ci', 'inbound edges', 0, `no CI points at this service within ${opt.traversalDepth} hops`),
            fact('svc_ci_assoc', 'associations', assocRead ? 0 : 'not read', assocRead ? 'no CI is associated to it' : 'the association table was not read'),
          ],
          guard: { evaluated: false, note: 'A service deliberately modelled as a business construct with no infrastructure — a contractual or outsourced service — looks exactly like this.' } });
    }
    if (!unreachable.length) {
      skip('CMDB-109', 'cmdb_ci_service', `All ${bsScope.length} Business Service(s) are reachable from at least one CI — evaluated, with nothing to report.`);
    }
  }

  /* ── CMDB-110 — an Application Service supporting nothing (D10, scored) ── */
  if (!applicationServices.length) {
    skip('CMDB-110', 'cmdb_ci_service', `The Application Service layer is not in use on this instance: no CI sits on ${opt.applicationServiceClasses.join(' or ')}. There is no Application Service to be unsupported, which is a CSDM adoption gap (CMDB-112 reports it as maturity) rather than a linkage defect — and reporting zero defects here would say the opposite.${disclose(opt.applicationServiceClasses)}`);
  } else {
    const unsupported = applicationServices.filter((s) => {
      const children = (outbound.get(s.sys_id) || []).length;
      const linked = assoc.some((a) => a.service === s.sys_id);
      return !children && !linked;
    });
    for (const s of unsupported) {
      csdm('CMDB-110', 'cmdb_ci_service', [s], ['name', 'sys_class_name'],
        `The Application Service "${val(s, 'name')}" has no supporting CIs — no association and no downward edge. Both linkage mechanisms were checked. Nothing it runs on is recorded, so its availability, its change risk and its cost are all unattributable.`,
        { confidence: 1.0,
          evidence: [
            fact('svc_ci_assoc', 'associations', 0, assocRead ? 'checked' : 'the association table was not read'),
            fact('cmdb_rel_ci', 'downward edges', 0, 'checked'),
          ],
          guard: { evaluated: false, note: 'An Application Service for an externally hosted or SaaS application legitimately has no internal supporting CI.' } });
    }
    if (!unsupported.length) skip('CMDB-110', 'cmdb_ci_service', `Every Application Service has at least one supporting CI — evaluated, with nothing to report`);
  }

  /* ── CMDB-113 / CMDB-114 — the two linkage mechanisms (D10, scored) ────── */
  /*
   * BOTH RULES COMPARE svc_ci_assoc WITH cmdb_rel_ci, AND BOTH REFUSE WHEN ONE
   * SIDE IS EMPTY. A symmetric difference against an empty set reports every
   * edge on the instance as a disagreement — which is the catalogue's own
   * documented false positive ("the estate deliberately uses one mechanism"),
   * and the loudest possible way to be wrong.
   */
  if (relOk) {
    if (!assocRead) {
      for (const r of ['CMDB-113', 'CMDB-114']) skip(r, 'svc_ci_assoc', 'The service-to-CI associations were not read, so the two linkage mechanisms cannot be compared');
    } else if (!assoc.length) {
      for (const r of ['CMDB-113', 'CMDB-114']) {
        skip(r, 'svc_ci_assoc', `This estate links CIs to services through cmdb_rel_ci ALONE — svc_ci_assoc holds no rows at all. Comparing the two would report every one of the ${edges.length.toLocaleString('en-US')} relationship edge(s) as a disagreement, which is the catalogue's own documented false positive: an estate that deliberately uses one mechanism. Using one mechanism consistently is a choice, not a defect.`);
      }
    } else {
      /* CMDB-113 — associated, with no path to walk. */
      const orphanLinks = [];
      for (const a of assoc) {
        const svc = services.find((s) => s.sys_id === a.service);
        const ci = byId.get(a.ci);
        if (!svc || !ci) continue;
        const down = reaches([a.service], outbound, opt.traversalDepth);
        const up = reaches([a.ci], outbound, opt.traversalDepth);
        if (down.has(a.ci) || up.has(a.service)) continue;
        orphanLinks.push({ a, svc, ci });
      }
      for (const { svc, ci } of orphanLinks) {
        csdm('CMDB-113', 'cmdb_ci', [ci], ['name', 'sys_class_name'],
          `${label(ci)} is associated to the service "${val(svc, 'name')}" but no relationship path connects them within ${opt.traversalDepth} hops. The association asserts a dependency the graph cannot corroborate: impact analysis walking the graph will not find this CI, and a report reading the association will.`,
          { confidence: 1.0,
            evidence: [
              fact('svc_ci_assoc', 'association', val(svc, 'name'), 'asserts the link'),
              fact('cmdb_rel_ci', 'path', 'none', `no route either way within ${opt.traversalDepth} hops`),
            ],
            guard: { evaluated: false, note: 'Associations created deliberately to represent a logical dependency with no physical path are legitimate — confirm the estate\'s convention.' } });
      }
      if (!orphanLinks.length) skip('CMDB-113', 'svc_ci_assoc', `Every association has a corroborating relationship path — evaluated, with nothing to report`);

      /* CMDB-114 — the symmetric difference, reported in both directions. */
      const assocPairs = new Set(assoc.filter((a) => a.service && a.ci).map((a) => `${a.service}|${a.ci}`));
      const edgePairs = new Set();
      for (const e of edges) {
        if (services.some((s) => s.sys_id === e.parent)) edgePairs.add(`${e.parent}|${e.child}`);
        if (services.some((s) => s.sys_id === e.child)) edgePairs.add(`${e.child}|${e.parent}`);
      }
      const assocOnly = [...assocPairs].filter((k) => !edgePairs.has(k));
      const edgeOnly = [...edgePairs].filter((k) => !assocPairs.has(k));
      if (assocOnly.length || edgeOnly.length) {
        const svcName = (id) => val(services.find((s) => s.sys_id === id) || {}, 'name') || id;
        const cis = [...new Set([...assocOnly, ...edgeOnly].map((k) => k.split('|')[1]))].map((id) => byId.get(id)).filter(Boolean);
        csdm('CMDB-114', 'cmdb_ci', cis.slice(0, 25), ['name', 'sys_class_name'],
          `The two service-linkage mechanisms disagree: ${assocOnly.length.toLocaleString('en-US')} link(s) exist as an association with no matching relationship, and ${edgeOnly.length.toLocaleString('en-US')} exist as a relationship with no matching association. Reported in both directions because they are different defects — one is a claim the graph cannot support, the other is a dependency that anything reading associations cannot see.`,
          { confidence: 1.0,
            evidence: [
              fact('svc_ci_assoc', 'association only', assocOnly.length, assocOnly.slice(0, 3).map((k) => svcName(k.split('|')[0])).join(', ')),
              fact('cmdb_rel_ci', 'relationship only', edgeOnly.length, edgeOnly.slice(0, 3).map((k) => svcName(k.split('|')[0])).join(', ')),
            ],
            guard: { evaluated: true, note: 'Checked that BOTH mechanisms are in use before comparing them — an estate that populates only one is not disagreeing with itself.' } });
      } else {
        skip('CMDB-114', 'svc_ci_assoc', 'The two linkage mechanisms agree exactly — evaluated, with nothing to report');
      }
    }
  }

  /* ── CMDB-111 — non-production CI under a production service (posture) ─── */
  const usedFor = signals?.usedFor || null;
  const nonProdValues = signals?.options?.nonProduction || [];
  if (!usedFor || !Object.keys(usedFor).length) {
    skip('CMDB-111', 'cmdb_ci', 'No CI on this instance carries a used_for value, so there is no environment tag to contradict. An unset environment is CMDB-016\'s finding, not a contradiction — silence is not a claim of non-production.');
  } else {
    const prodServices = new Set(services.filter((s) => signals.productionOf?.(s)).map((s) => s.sys_id));
    const supporting = reaches([...prodServices], outbound, opt.traversalDepth);
    const offenders = cisFor('CMDB-111').filter((c) => {
      const env = usedFor[c.sys_id];
      return env !== undefined && nonProdValues.includes(String(env).toLowerCase()) && supporting.has(c.sys_id);
    });
    for (const c of offenders) {
      csdm('CMDB-111', 'cmdb_ci', [c], ['name', 'sys_class_name', 'used_for'],
        `${label(c)} is tagged ${String(usedFor[c.sys_id])} and supports a production service. Either the tag is wrong and change control is treating a production machine as safe to touch, or the service map is wrong and a production service depends on a test box.`,
        { confidence: 0.9,
          evidence: [
            fact('cmdb_ci', 'used_for', String(usedFor[c.sys_id]), 'explicitly non-production'),
            fact('cmdb_rel_ci', 'supports', 'a production service', `within ${opt.traversalDepth} hops`),
          ],
          guard: { evaluated: false, note: 'Shared infrastructure legitimately serving both, with the tag reflecting its primary use, looks the same.' } });
    }
    if (!offenders.length) skip('CMDB-111', 'cmdb_ci', 'No non-production CI supports a production service — evaluated, with nothing to report');
  }

  /* ── CMDB-112 — how far the model reaches from the top (posture KPI) ───── */
  const principals = new Set((ctx.estate.cmdb_class_info || []).filter((r) => truthy(r.principal_class)).map((r) => r.class));
  const principalCis = cisFor('CMDB-112').filter((c) => (principals.size ? principals.has(c.sys_class_name) : true));
  if (!capabilities.length) {
    skip('CMDB-112', 'cmdb_ci', `The Business Capability layer is not in use on this instance — no CI sits on ${opt.capabilityClasses.join(' or ')} — so there is no top of the model to traverse from. The catalogue's guard applies: report scoped to the layers in use. This estate uses ${ctx.measures.csdm_layers.base_only ? 'the base service class only' : `${businessServices.length} Business Service(s) and ${applicationServices.length} Application Service(s)`}, and CSDM maturity is that fact, not a percentage against a layer nobody has adopted.${disclose(opt.capabilityClasses)}`);
  } else if (!principalCis.length) {
    skip('CMDB-112', 'cmdb_ci', 'There are no principal-class CIs to be reachable, so there is no reach to measure');
  } else {
    /* The capabilities themselves are the starting point, not something they
       reach — the same exclusion CMDB-057 makes for its services. */
    const reached = reaches(capabilities.map((c) => c.sys_id), outbound, opt.traversalDepth);
    for (const c of capabilities) reached.delete(c.sys_id);
    const hit = principalCis.filter((c) => reached.has(c.sys_id)).length;
    const passPct = (100 * hit) / principalCis.length;
    ctx.kpis.push({
      rule_id: 'CMDB-112',
      pass_pct: passPct,
      numerator: hit,
      denominator: principalCis.length,
      basis: `principal CIs reachable by traversal from any of the ${capabilities.length} Business Capability CI(s) within ${opt.traversalDepth} hops${principals.size ? '' : ' — every populated class, no principal classes designated'}`,
      alerts: 'CSDM maturity posture: surfaced beside the score, never inside it. A maturity model an estate has not adopted is not a data defect.',
    });
    if (passPct < opt.capabilityReachPct) {
      csdm('CMDB-112', 'cmdb_ci', [], ['sys_class_name'],
        `${hit.toLocaleString('en-US')} of ${principalCis.length.toLocaleString('en-US')} principal CIs (${pct1(passPct)}%) can be reached from a Business Capability, below the ${opt.capabilityReachPct}% threshold. The model is connected at the bottom and not at the top, so nothing joins what the business says it does to what the infrastructure actually runs.`,
        { agent: 'csdm_agent',
          evidence: [fact('cmdb_rel_ci', 'reachable from a capability', `${hit} of ${principalCis.length}`, `${capabilities.length} capabilities, depth ${opt.traversalDepth}`)],
          guard: { evaluated: true, note: 'Scoped to the layers in use: this fires only where the Business Capability layer exists.' } });
    }
  }

  /* ── CMDB-115 — a CI outside the service model (posture) ───────────────── */
  /*
   * CONSEQUENCE SCOPING (see cmdb-signals.js), inherited rather than re-decided:
   * this is another near-universal defect, so the per-record charge is scoped by
   * what the absence costs and the estate-wide share is raised once as a
   * zero-point headline. It is posture here, so nothing deducts either way —
   * but the SHAPE of the report is the same, because a reader should not have to
   * learn a different reporting convention per dimension.
   */
  const appScope = applicationServices.length ? applicationServices : baseServices;
  if (!appScope.length) {
    skip('CMDB-115', 'cmdb_ci_service', 'This instance has no services at all, so there is nothing for a CI to be associated with');
  } else {
    const serviceIds = new Set(appScope.map((s) => s.sys_id));
    const linkedCis = new Set();
    for (const a of assoc) if (serviceIds.has(a.service)) linkedCis.add(a.ci);
    for (const e of edges) {
      if (serviceIds.has(e.parent)) linkedCis.add(e.child);
      if (serviceIds.has(e.child)) linkedCis.add(e.parent);
    }
    const scope115 = cisFor('CMDB-115').filter((c) => (principals.size ? principals.has(c.sys_class_name) : true) && !serviceIds.has(c.sys_id));
    const unlinked = scope115.filter((c) => !linkedCis.has(c.sys_id));
    const consequence = new Map();
    for (const c of unlinked) {
      const verdict = consequenceOf(c, { signals, inClasses, tiers: opt.classTiers });
      consequence.set(c.sys_id, verdict);
      const f = csdm('CMDB-115', 'cmdb_ci', [c], ['name', 'sys_class_name'],
        `${label(c)} is not associated with any ${applicationServices.length ? 'Application Service' : 'service'} — no association and no service edge. Nothing it supports is recorded, so it appears in no service view and no impact analysis reaches it.${fallbackNote}`,
        { confidence: 1.0,
          evidence: [
            fact('svc_ci_assoc', 'associations', 0, assocRead ? 'checked' : 'the association table was not read'),
            fact('cmdb_rel_ci', 'service edges', 0, 'checked'),
            fact('cmdb_ci', 'consequence', verdict.level, verdict.why),
          ],
          guard: { evaluated: false, note: 'Classes that legitimately sit outside the service model — network edge, facilities, end-user devices — belong in the exclusion list.' } });
      if (verdict.level === 'reduced') {
        f.deduction_band_override = CONSEQUENCE_REDUCED_BAND;
        if (f.deduction_severity !== 'SYSTEMIC') f.deduction_severity = CONSEQUENCE_REDUCED_BAND;
        f.deduction_note = `Scoped to ${CONSEQUENCE_REDUCED_BAND}: ${verdict.why}. Reported in full either way. (This rule is posture, so nothing is charged regardless — the scoping is here so the report reads the same as D6's and D9's.)`;
      }
    }
    ctx.measures.csdm_coverage = {
      in_scope: scope115.length,
      linked: scope115.length - unlinked.length,
      unlinked: unlinked.length,
      full_consequence: [...consequence.values()].filter((v) => v.level === 'full').length,
      reduced_consequence: [...consequence.values()].filter((v) => v.level === 'reduced').length,
    };
    if (unlinked.length) {
      const byClass = [...unlinked.reduce((m, c) => m.set(c.sys_class_name, (m.get(c.sys_class_name) || 0) + 1), new Map())]
        .sort((a, b) => b[1] - a[1]);
      const share = (100 * unlinked.length) / (scope115.length || 1);
      const head = ctx.addCatalogued('CMDB-115', 'cmdb_ci', [], ['sys_class_name'],
        `${unlinked.length.toLocaleString('en-US')} of ${scope115.length.toLocaleString('en-US')} in-scope CIs (${pct1(share)}%) sit outside the service model entirely. Worst: ${byClass.slice(0, 4).map(([cls, n]) => `${cls} (${n.toLocaleString('en-US')})`).join(', ')}. ${ctx.measures.csdm_coverage.full_consequence.toLocaleString('en-US')} of them carry operational consequence; ${ctx.measures.csdm_coverage.reduced_consequence.toLocaleString('en-US')} are leaf or non-production. This is CSDM maturity posture — it deducts nothing — and it is raised once so the scale is visible without counting rows.${fallbackNote}`,
        { agent: 'csdm_agent',
          evidence: byClass.slice(0, 15).map(([cls, n]) => fact('cmdb_ci', cls, `${n} outside the service model`, 'by class')),
          guard: { evaluated: false, note: 'An estate that models only its critical services deliberately will look like this. Confirm the intended scope.' } });
      head.unscored_reason = 'CSDM maturity posture, and the estate-wide headline for records reported individually — it deducts nothing by design';
      head.grouped_classes = byClass.map(([cls, n]) => ({ cls, cis: n }));
    } else {
      skip('CMDB-115', 'cmdb_ci', 'Every in-scope CI is associated with a service — evaluated, with nothing to report');
    }
  }
}
