import { modifiersFor, lineageOf, dqActive, cisForRule, intentOf, DQ_INACTIVE_INSTALL_STATUS, CLASS_TIERS, isEndpoint as isEndpointCi } from './cmdb-signals.js';
import { parseDate } from './time.js';

/**
 * GROUP 6 — RELATIONSHIPS (D6). CMDB-056 to CMDB-069.
 *
 * The map, not the records. A CMDB whose records are perfect and whose edges are
 * missing cannot answer the only question anybody asks it — "what breaks if this
 * goes down?" — so this group is the heaviest dimension in the model (16 of 100).
 *
 * WHAT THIS INSTANCE KEEPS (verified on dev424910, 16 Sep 2026):
 *
 *   cmdb_rel_ci        220 edges, 15 types. Columns: parent, child, type,
 *                      sys_created_by, sys_updated_on. There is NO source or
 *                      last-confirmed column, which is why CMDB-063 and CMDB-066
 *                      cannot run here and say so.
 *   cmdb_rel_type      40 types, with parent_descriptor / child_descriptor only —
 *                      NO permitted class scope, so CMDB-064's scope comes from
 *                      the hosting and containment metadata, and types absent
 *                      from it are reported as unscoped rather than judged.
 *   cmdb_metadata_hosting / _containment   88 / 145 rows of (parent class, child
 *                      class, type) — the instance's own direction rules, which
 *                      is what CMDB-065 compares against.
 *   135 of 2,784 CIs have any edge at all.
 *
 * ═══ INTENT (decision 5 of 16 Sep 2026) ═══
 *
 * The completeness rules here (CMDB-057/058/059/060/066/067/068/069) are QUALITY
 * rules: a retired CI with no relationships is not a defect. The contradiction
 * rules (CMDB-056/061/062/063/064/065) run over the FULL estate — an edge into a
 * dead CI is exactly what CMDB-061 exists to find. Each rule takes its set from
 * `cisForRule`, and the tag lives in the catalogue.
 *
 * PURE — no network, no database.
 */

export const RELATIONSHIP_RULES = Object.freeze([
  'CMDB-056', 'CMDB-057', 'CMDB-058', 'CMDB-059', 'CMDB-060', 'CMDB-061', 'CMDB-062',
  'CMDB-063', 'CMDB-064', 'CMDB-065', 'CMDB-066', 'CMDB-067', 'CMDB-068', 'CMDB-069',
]);

/**
 * The older hand-written rules this group replaces, and what replaces them.
 * Named here rather than in rules.js so the rule pack carries no catalogue ids
 * of its own — the remediation coverage test reads those literals.
 */
export const SUBSUMED_BY_GROUP_6 = Object.freeze({
  'REL-SELF': 'CMDB-062',
  'REL-DUPLICATE': 'CMDB-069',
  'CMDB-UNRELATED': 'CMDB-058',
});

export const RELATIONSHIP_DEFAULTS = Object.freeze({
  dqInactiveInstallStatus: DQ_INACTIVE_INSTALL_STATUS,
  /* CMDB-056 — a drop this big in this many days is a collapse, not attrition. */
  collapseDropPct: 15,
  collapseWindowDays: 30,
  minSnapshots: 2,
  /* CMDB-057 — traverse this far down from a service, and expect this much reach. */
  traversalDepth: 8,
  reachThresholdPct: 60,
  /*
   * A SERVICE MAP TOO SMALL TO BE A MAP (decision 2 of Sep 2026). CMDB-057 gates,
   * and a gate that fires because an estate has three demo services is reporting
   * the absence of CSDM as a reachability failure. Below this floor the finding
   * is raised as POSTURE — visible, non-gating, non-scoring — and no reachability
   * KPI is published, because a ratio against three services is not a measurement.
   */
  minServiceMapSize: 5,
  /*
   * ═══ WHICH CLASSES ARE EXPECTED TO CARRY WHAT ═══
   *
   * One setting, shared with D7 and defined once in `cmdb-signals.js` — see
   * CLASS_TIERS there for what each tier means and why endpoints are decided by
   * exclusion. Every list is a set of subtree ROOTS expanded through the class
   * hierarchy, and every one of them is a per-estate override, not a constant.
   *
   * KNOWN COVERAGE BOUNDARY — hypervisors modelled outside the server subtree,
   * storage arrays and network gear DO carry things: VMs, LUNs, VLANs, ports.
   * They carry them through relationship types `hostingTypes` does not name, so
   * CMDB-059 under-detects there rather than guessing at a hosting expectation
   * nobody declared. Widen `hostClasses` and `hostingTypes` together for an
   * estate that models them.
   */
  hostClasses: CLASS_TIERS.host,
  /*
   * Leaf devices: the end of the graph by design, charged at
   * `endpointOrphanBand` by CMDB-058 rather than the full orphan band. A UPS is
   * NOT one of them — a rack full of servers depends on it — so it sits in the
   * infrastructure tier and carries the full charge.
   */
  endpointClasses: CLASS_TIERS.endpoint,
  endpointFallbackClasses: CLASS_TIERS.endpointFallback,
  infrastructureClasses: CLASS_TIERS.infrastructure,
  /* What an orphaned leaf device costs. It is still reported, in full. */
  endpointOrphanBand: 'LOW',
  applicationClasses: CLASS_TIERS.application,
  hostingTypes: Object.freeze(['Runs on::Runs', 'Hosted on::Hosts', 'Virtualized by::Virtualizes', 'Instantiates::Instantiated by']),
  /* CMDB-066 — edges a source is supposed to confirm. Empty: this estate names none. */
  discoveryMaintainedTypes: Object.freeze([]),
  edgeStaleDays: 30,
  /*
   * CMDB-067 — the benchmark is the estate's own, not an imposed standard, which
   * makes `depthPassPct` a FLAGGED DEFAULT: 60% is this build's choice and not a
   * catalogue threshold (decision 5 of Sep 2026). It is stated in the KPI basis
   * so nobody reads it as a standard.
   *
   * THE BENCHMARK IS RELATIVE BY CONSTRUCTION — it is a percentile of the same
   * services it judges — so it only carries information when those services
   * actually differ. `minBenchmarkServices` and a required spread stop it
   * comparing an estate against itself and reporting the result as a finding.
   */
  depthBenchmarkPercentile: 75,
  depthPassPct: 60,
  minBenchmarkServices: 5,
  minBenchmarkSpread: 1,
  /* CMDB-068 — outliers against the class distribution. */
  outlierSigma: 3,
  minClassPopulation: 30,
  /*
   * A class where almost nothing is related has no distribution to be an outlier
   * in. Measured on dev424910: cmdb_ci_computer averages 0.0 edges with a
   * standard deviation of 0.1, so the six CIs that ARE modelled came back as
   * anomalies — exactly backwards. Below this share the class is unmodelled,
   * which CMDB-057 and CMDB-058 already say.
   */
  minRelatedShare: 0.1,
  hubClasses: CLASS_TIERS.hub,
});

const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const DAY_MS = 86_400_000;
const pct1 = (n) => Number(n.toFixed(1));

export function cmdbRelationshipRules(ctx, options = {}) {
  const opt = { ...RELATIONSHIP_DEFAULTS, ...options };
  const now = ctx.now;
  const meta = ctx.meta?.cmdb || {};
  const signals = ctx.signals;
  const skip = (rule, table, reason) => ctx.skipped.push({ rule, table, reason });
  const hierarchyOk = meta.reads?.class_hierarchy?.status === 'ok';
  const line = (cls) => lineageOf(meta, cls || 'cmdb_ci');
  const inClasses = (c, classes) => (hierarchyOk ? line(c.sys_class_name).some((t) => classes.includes(t)) : classes.includes(c.sys_class_name));
  /*
   * A leaf device — the shared definition, so D6 and D9 cannot drift apart. See
   * CONSEQUENCE SCOPING in cmdb-signals.js for why the charge moves and the
   * report does not.
   */
  const isEndpoint = (c) => isEndpointCi(c, inClasses, {
    infrastructure: opt.infrastructureClasses, endpoint: opt.endpointClasses,
    endpointFallback: opt.endpointFallbackClasses, host: opt.hostClasses,
  });
  const allCis = ctx.estate.cmdb_ci || [];
  const { active: activeCis, excluded: inactiveCis } = dqActive(allCis, opt.dqInactiveInstallStatus);
  const cisFor = (rule) => cisForRule(rule, { all: allCis, active: activeCis });
  const byId = new Map(allCis.map((c) => [c.sys_id, c]));
  const label = (c) => `${c.sys_class_name} "${c.name || c.sys_id}"`;
  const fact = (table, field, value, reason) => ({
    source: 'ServiceNow Table/Aggregate REST API', sn_table: table, sn_sys_id: null,
    field_name: field, field_value: String(value), reason, collected_at: now.toISOString(),
  });
  const perRecord = (rule, records, fields, description, extra = {}) => {
    const m = modifiersFor(records, signals);
    return ctx.addCatalogued(rule, 'cmdb_ci', records, fields, description, {
      agent: 'relationship_agent', escalators: m.escalators, deEscalators: m.deEscalators, notEvaluated: m.notEvaluated, ...extra,
    });
  };
  ctx.measures ||= {};

  const relOk = ctx.complete('cmdb_rel_ci', ['parent', 'child', 'type.name']);
  if (!relOk) {
    for (const r of RELATIONSHIP_RULES) {
      skip(r, 'cmdb_rel_ci', 'Relationships (with their type) were not read completely — an absence rule over a partial edge set reports our own access, not the estate');
    }
    return;
  }
  const edges = (ctx.estate.cmdb_rel_ci || []).filter((r) => r.parent && r.child);
  const typeName = (r) => r['type.name'] || r.type || '';
  const out = new Map();                                  // parent -> edges
  const inn = new Map();                                  // child -> edges
  const degree = new Map();
  for (const e of edges) {
    if (!out.has(e.parent)) out.set(e.parent, []);
    if (!inn.has(e.child)) inn.set(e.child, []);
    out.get(e.parent).push(e);
    inn.get(e.child).push(e);
    degree.set(e.parent, (degree.get(e.parent) || 0) + 1);
    degree.set(e.child, (degree.get(e.child) || 0) + 1);
  }
  const edgeCount = (id) => degree.get(id) || 0;

  /* ── CMDB-069 — the same edge recorded twice ──────────────────────────── */
  const triples = new Map();
  for (const e of edges) {
    const key = `${e.parent}|${e.child}|${e.type || typeName(e)}`;
    if (!triples.has(key)) triples.set(key, []);
    triples.get(key).push(e);
  }
  for (const [, group] of triples) {
    if (group.length < 2) continue;
    const parent = byId.get(group[0].parent);
    const child = byId.get(group[0].child);
    if (!parent || !child) continue;
    if (!cisFor('CMDB-069').includes(parent) && !cisFor('CMDB-069').includes(child)) continue;
    perRecord('CMDB-069', [parent, child].filter(Boolean), ['name', 'sys_class_name'],
      `${group.length} identical "${typeName(group[0])}" edges join ${label(parent)} and ${label(child)}. Impact analysis counts the path once per edge, so anything that walks the graph double-counts this dependency.`,
      { confidence: 1.0,
        evidence: group.slice(0, 5).map((e) => fact('cmdb_rel_ci', 'sys_id', e.sys_id, `duplicate ${typeName(e)} edge`)),
        guard: { evaluated: true, note: 'An exact triple match of parent, child and type; nothing material can make that legitimate.' } });
  }

  /* ── CMDB-061 — an edge into a CI that is gone ────────────────────────── */
  const deadStatus = new Set(opt.dqInactiveInstallStatus);
  const isDead = (c) => c && deadStatus.has(String(c.install_status ?? '').trim());
  let deadBoth = 0;
  for (const e of edges) {
    const parent = byId.get(e.parent);
    const child = byId.get(e.child);
    if (!parent || !child) continue;
    const deadEnds = [parent, child].filter(isDead);
    if (!deadEnds.length) continue;
    const liveEnds = [parent, child].filter((c) => !isDead(c));
    if (!liveEnds.length) { deadBoth += 1; continue; }
    perRecord('CMDB-061', liveEnds, ['name', 'sys_class_name', 'install_status'],
      `${liveEnds.map(label).join(', ')} still depends on ${deadEnds.map((c) => `${label(c)} (install_status ${c.install_status})`).join(', ')} through a "${typeName(e)}" edge. Impact analysis walks into a CI nobody maintains, so the blast radius it reports includes something that is not there.`,
      { confidence: 1.0,
        evidence: [fact('cmdb_rel_ci', 'type', typeName(e), `edge ${e.sys_id}`)],
        guard: { evaluated: false, note: 'An edge deliberately kept for historical impact analysis looks the same. Rare, and worth confirming before deleting the edge.' } });
  }
  if (deadBoth) skip('CMDB-061', 'cmdb_rel_ci', `${deadBoth} edge(s) join two retired or absent CIs — no live record to charge, and nothing live reads them; reported by the lifecycle dimension instead`);

  /* ── CMDB-062 — cycles, per relationship type ─────────────────────────── */
  const types = new Map((ctx.estate.cmdb_rel_type || []).map((t) => [t.sys_id, t]));
  const symmetric = new Set([...types.values()].filter((t) => t.parent_descriptor && t.parent_descriptor === t.child_descriptor).map((t) => t.sys_id));
  const symmetricNames = new Set([...types.values()].filter((t) => symmetric.has(t.sys_id)).map((t) => t.name));
  /*
   * A SELF-LOOP NEEDS NO TYPE TABLE. "A depends on A" is a cycle of length one
   * whatever the type means, so it is reported even when cmdb_rel_type cannot be
   * read; only multi-node cycles need the symmetric types excluded first.
   */
  for (const e of edges.filter((x) => x.parent === x.child)) {
    const c = byId.get(e.parent);
    if (!c) continue;
    perRecord('CMDB-062', [c], ['name', 'sys_class_name'],
      `${label(c)} is joined to itself by a "${typeName(e)}" edge. Every traversal that reaches it walks the loop, so impact analysis either repeats it or stops there.`,
      { confidence: 1.0,
        evidence: [fact('cmdb_rel_ci', 'parent = child', e.parent, `edge ${e.sys_id}`)],
        guard: { evaluated: true, note: 'A CI related to itself is a cycle of length one; no relationship type makes that meaningful.' } });
  }

  const typeOk = ctx.complete('cmdb_rel_type', ['name', 'parent_descriptor', 'child_descriptor']);
  if (!typeOk) skip('CMDB-062', 'cmdb_rel_type', 'The relationship types were not read completely, so symmetric (peer-to-peer) types cannot be excluded — self-loops are still reported, longer cycles are not, because every peer pair would read as one');
  else {
    const byType = new Map();
    for (const e of edges) {
      const key = e.type || typeName(e);
      if (symmetric.has(key) || symmetricNames.has(typeName(e))) continue;
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push(e);
    }
    const reported = new Set();
    for (const [key, group] of byType) {
      const adj = new Map();
      for (const e of group) {
        if (e.parent === e.child) continue;               // already reported above
        if (!adj.has(e.parent)) adj.set(e.parent, []);
        adj.get(e.parent).push(e.child);
      }
      const state = new Map();                            // 0 unvisited, 1 on stack, 2 done
      const stack = [];
      const walk = (node) => {
        state.set(node, 1);
        stack.push(node);
        for (const next of adj.get(node) || []) {
          if (state.get(next) === 1) {
            const cycle = stack.slice(stack.indexOf(next)).concat(next);
            const fingerprint = [...cycle].sort().join('|');
            if (!reported.has(fingerprint)) {
              reported.add(fingerprint);
              const members = cycle.map((id) => byId.get(id)).filter(Boolean);
              if (members.length) {
                perRecord('CMDB-062', [...new Set(members)], ['name', 'sys_class_name'],
                  `A "${typeName(group[0])}" chain runs in a circle: ${cycle.map((id) => byId.get(id) ? label(byId.get(id)) : id).join(' → ')}. Impact analysis either loops or stops early, and neither answer is the blast radius.`,
                  { confidence: 1.0,
                    evidence: [fact('cmdb_rel_ci', 'cycle', cycle.length - 1, `${typeName(group[0])} chain`)],
                    guard: { evaluated: true, note: `Symmetric relationship types are excluded before the search (${[...symmetricNames].join(', ') || 'none on this instance'}); a peer-to-peer pair is not a cycle.` } });
              }
            }
          } else if (!state.get(next)) walk(next);
        }
        stack.pop();
        state.set(node, 2);
      };
      for (const node of adj.keys()) if (!state.get(node)) walk(node);
    }
  }

  /* ── CMDB-064 / CMDB-065 — the instance's own direction rules ─────────── */
  /*
   * BOTH METADATA TABLES ARE DECLARED SCOPE (decision 4 of Sep 2026). Hosting
   * alone left 179 edges with no configured scope; containment declares another
   * 145 class pairs, in a different shape:
   *
   *   cmdb_metadata_hosting      parent_type, child_type, rel_type — a pair.
   *   cmdb_metadata_containment  ci_type is the CHILD, and `parent_id` points at
   *                              ANOTHER ROW of the same table whose `ci_type` is
   *                              the parent. A row with no parent_id is a class
   *                              node, not a pair.
   *
   * `is_reverse` swaps the two ends. It is set on 31 of 88 hosting rows and 14 of
   * 145 containment rows on dev424910, and ignoring it inverted the permitted
   * direction for a third of the hosting metadata — which is exactly the mistake
   * CMDB-065 exists to report. Verified against the type descriptors: the
   * reversed row (storage_pool, computer, "Contains::Contained by") means a
   * computer contains a storage pool, not the other way about.
   */
  const metadataOk = ctx.complete('cmdb_metadata_hosting', ['parent_type', 'child_type', 'rel_type']);
  const containmentOk = ctx.complete('cmdb_metadata_containment', ['ci_type', 'parent_id', 'rel_type']);
  const permitted = new Map();                            // rel_type -> [{parent, child, via}]
  const declare = (relType, parent, child, via) => {
    if (!relType || !parent || !child) return;
    if (!permitted.has(relType)) permitted.set(relType, []);
    permitted.get(relType).push({ parent, child, via });
  };
  for (const r of ctx.estate.cmdb_metadata_hosting || []) {
    const rev = truthy(r.is_reverse);
    declare(r.rel_type, rev ? r.child_type : r.parent_type, rev ? r.parent_type : r.child_type, 'cmdb_metadata_hosting');
  }
  const containmentRows = ctx.estate.cmdb_metadata_containment || [];
  const containmentById = new Map(containmentRows.map((r) => [r.sys_id, r]));
  for (const r of containmentRows) {
    const parentRow = r.parent_id ? containmentById.get(r.parent_id) : null;
    if (!parentRow?.ci_type) continue;                    // a class node, not a pair
    const rev = truthy(r.is_reverse);
    declare(r.rel_type, rev ? r.ci_type : parentRow.ci_type, rev ? parentRow.ci_type : r.ci_type, 'cmdb_metadata_containment');
  }
  if ((!metadataOk && !containmentOk) || !permitted.size) {
    for (const r of ['CMDB-064', 'CMDB-065']) {
      skip(r, 'cmdb_metadata_hosting', 'Neither the hosting nor the containment metadata could be read, and cmdb_rel_type carries no permitted class scope on this version — so which class pairs a type allows is not configured anywhere, and judging edges against a scope nobody defined would be inventing one');
    }
  } else {
    let unscoped = 0;
    let noOpinion = 0;
    const fits = (pairs, parentCls, childCls) => pairs.some((p) => (hierarchyOk ? line(parentCls).includes(p.parent) && line(childCls).includes(p.child) : p.parent === parentCls && p.child === childCls));
    /*
     * DOES THE METADATA HAVE AN OPINION ABOUT THESE CLASSES?
     *
     * The metadata is a list of pairs somebody configured, not an exhaustive
     * catalogue of what is allowed. Measured on dev424910: judging every unlisted
     * pair as invalid flagged 19 service-to-service "Contains" edges, where the
     * metadata simply says nothing about services. So an edge is only judged when
     * the metadata mentions one of its classes for that type; anything else is
     * counted as unscoped, like a type with no scope at all. Absence of a
     * declaration is never a prohibition.
     */
    const mentions = (pairs, cls) => pairs.some((p) => (hierarchyOk
      ? line(cls).includes(p.parent) || line(cls).includes(p.child)
      : p.parent === cls || p.child === cls));
    for (const e of edges) {
      const pairs = permitted.get(e.type);
      if (!pairs) { unscoped += 1; continue; }
      const parent = byId.get(e.parent);
      const child = byId.get(e.child);
      if (!parent || !child) continue;
      if (fits(pairs, parent.sys_class_name, child.sys_class_name)) continue;
      if (!mentions(pairs, parent.sys_class_name) && !mentions(pairs, child.sys_class_name)) { noOpinion += 1; continue; }
      const reversed = fits(pairs, child.sys_class_name, parent.sys_class_name);
      if (reversed) {
        perRecord('CMDB-065', [parent, child], ['name', 'sys_class_name'],
          `The "${typeName(e)}" edge runs ${label(parent)} → ${label(child)}, and this instance's own hosting metadata says that type runs the other way for these classes. Every traversal follows it upside down: impact flows away from the thing that would actually be affected.`,
          { confidence: 0.88,
            evidence: [fact(pairs[0].via, 'permitted direction', pairs.map((p) => `${p.parent} → ${p.child}`).join(', '), `edge ${e.sys_id}`)],
            guard: { evaluated: true, note: 'Only edges whose type has a configured class scope are judged; the direction expectation is the instance\'s own metadata, not an imposed one.' } });
      } else {
        perRecord('CMDB-064', [parent, child], ['name', 'sys_class_name'],
          `A "${typeName(e)}" edge joins ${label(parent)} to ${label(child)}, a class pair this instance's hosting metadata does not permit for that type. Either the edge is wrong or the metadata is, and every consumer of the map is reading one of them.`,
          { confidence: 0.95,
            evidence: [fact(pairs[0].via, 'permitted pairs', pairs.slice(0, 4).map((p) => `${p.parent} → ${p.child}`).join(', '), `edge ${e.sys_id}`)],
            guard: { evaluated: true, note: 'Types with no configured class scope are counted as unscoped rather than judged — an estate that uses generic types deliberately is not wrong.' } });
      }
    }
    if (unscoped) skip('CMDB-064', 'cmdb_rel_type', `${unscoped} edge(s) use a type with no configured class scope on this instance (cmdb_rel_type carries descriptors only), so there is no permitted set to judge them against`);
    if (noOpinion) skip('CMDB-064', 'cmdb_metadata_hosting', `${noOpinion} edge(s) join classes neither the hosting nor the containment metadata says anything about for their type — the metadata is a list somebody configured, not an exhaustive catalogue, so silence about a class pair is not a prohibition`);
  }

  /* ── CMDB-063 / CMDB-066 — what this version does not record ──────────── */
  const edgeSourceOk = ctx.complete('sys_object_source', ['target_table', 'target_sys_id'])
    && (ctx.estate.sys_object_source || []).some((r) => r.target_table === 'cmdb_rel_ci');
  if (!edgeSourceOk) {
    /*
     * PERMANENTLY NOT MEASURED HERE, AND NOT APPROXIMATED (decision 6 of Sep
     * 2026). `sys_created_by` on an edge names whoever's session wrote the row —
     * an import, a business rule, a discovery service account, a person clicking
     * Save — which is not the edge's ORIGIN. Approximating one from the other
     * would be confidently wrong at scale, so it is never a finding basis; at
     * most it is a low-confidence annotation on evidence somebody reads. These
     * two rules need an instance where a source attributes its own edges.
     */
    skip('CMDB-063', 'cmdb_rel_ci', 'No source is attributed to any relationship on this instance (cmdb_rel_ci has no source column, and sys_object_source holds no relationship rows), so a manual edge cannot be told from a discovered one, and "contradicted by discovery" has nothing to compare against. Not approximated from sys_created_by: the row\'s creator is not the edge\'s origin');
    skip('CMDB-066', 'cmdb_rel_ci', 'Relationships carry no last-confirmed timestamp and no source attribution here, so an unconfirmed edge cannot be told from one nothing was ever supposed to confirm. Needs an instance where discovery attributes and re-confirms its own edges');
  } else if (!opt.discoveryMaintainedTypes.length) {
    skip('CMDB-066', 'cmdb_rel_ci', 'No relationship type is configured as discovery-maintained, so no edge has a freshness expectation to miss');
  } else {
    const cutoff = now.getTime() - opt.edgeStaleDays * DAY_MS;
    for (const e of edges) {
      if (!opt.discoveryMaintainedTypes.includes(typeName(e))) continue;
      const seen = parseDate(e.sys_updated_on);
      if (!seen || seen.getTime() >= cutoff) continue;
      const parent = byId.get(e.parent);
      const child = byId.get(e.child);
      if (!parent || !child) continue;
      perRecord('CMDB-066', [parent, child], ['name', 'sys_class_name'],
        `The "${typeName(e)}" edge between ${label(parent)} and ${label(child)} was last touched ${Math.floor((now - seen) / DAY_MS)} days ago, past the ${opt.edgeStaleDays}-day window for a type a source is supposed to confirm. Nothing has said it is still true.`,
        { confidence: 1.0,
          evidence: [fact('cmdb_rel_ci', 'sys_updated_on', e.sys_updated_on, 'last touched')],
          guard: { evaluated: true, note: 'Scoped to the types configured as discovery-maintained; a manual logical dependency nothing confirms is not judged here.' } });
    }
  }

  /* ── CMDB-058 — a CI with no edge at all ──────────────────────────────── */
  const principals = new Set((ctx.estate.cmdb_class_info || []).filter((r) => truthy(r.principal_class)).map((r) => r.class));
  const scopeCis = cisFor('CMDB-058');
  const populated = [...new Set(scopeCis.map((c) => c.sys_class_name).filter(Boolean))];
  const principalScope = principals.size ? populated.filter((c) => principals.has(c)) : populated;
  const fallbackNote = principals.size ? '' : ' Evaluated over every populated class, because no principal classes are designated (CMDB-139).';
  /*
   * MODELLED CLASSES ONLY. A class where not one CI has an edge is not a
   * thousand orphans — it is a class nobody has modelled, which is one fact, not
   * a thousand. Measured on dev424910: cmdb_ci_spkg holds 1,767 CIs and zero
   * edges. Those classes get ONE finding that charges nothing; the CIs of a
   * class that IS modelled are charged individually.
   */
  const relatedInClass = new Map();
  for (const c of scopeCis) {
    const k = c.sys_class_name;
    if (!relatedInClass.has(k)) relatedInClass.set(k, { total: 0, related: 0 });
    const s = relatedInClass.get(k);
    s.total += 1;
    if (edgeCount(c.sys_id)) s.related += 1;
  }
  const unmodelled = [];
  for (const cls of principalScope) {
    const stats = relatedInClass.get(cls);
    if (!stats) continue;
    if (!stats.related) { unmodelled.push({ cls, cis: stats.total }); continue; }
    for (const c of scopeCis) {
      if (c.sys_class_name !== cls || edgeCount(c.sys_id)) continue;
      /*
       * CHARGE WHERE THE GAP HAS A CONSEQUENCE FOR THIS CLASS (decision 3 of Sep
       * 2026). Every orphan is still REPORTED and still charged — a class-wide
       * pattern never silences the records under it, or the worst-modelled
       * estate would score best. But an unrelated database is invisible to
       * impact analysis in a way an unrelated laptop is not, so the leaf devices
       * are charged at LOW instead of the full orphan band. Same move as
       * CMDB-059's host list, applied to the charge rather than the scope.
       */
      const endpoint = isEndpoint(c);
      const f = perRecord('CMDB-058', [c], ['name', 'sys_class_name'],
        endpoint
          ? `${label(c)} has no relationship at all. It is a leaf device, so nothing is expected to run on it — but nothing records what it depends on either, so it appears in no impact analysis and no service names it.${fallbackNote}`
          : `${label(c)} has no relationship at all — nothing above it, nothing below it. It cannot appear in any impact analysis, and nothing that breaks will ever name it.${fallbackNote}`,
        { confidence: 1.0,
          evidence: [fact('cmdb_rel_ci', 'edges', 0, `${stats.related} of ${stats.total} ${cls} CIs are related, so the class IS modelled`)],
          guard: { evaluated: true, note: `Only classes something models are judged per CI: ${stats.related} of ${stats.total} CIs in ${cls} have edges. A class where nothing is related is reported once, as an unmodelled class.` } });
      /*
       * Declared as a CAP, not written into `deduction_severity` — the
       * materiality pass recomputes that from the catalogue and would overwrite
       * anything set here. `applyMateriality` honours the cap, downgrade-only,
       * and ignores it for a record its own context escalated to Systemic.
       */
      if (endpoint) {
        f.deduction_band_override = opt.endpointOrphanBand;
        if (f.deduction_severity !== 'SYSTEMIC') f.deduction_severity = opt.endpointOrphanBand;
        f.deduction_note = `Charged at ${opt.endpointOrphanBand} rather than ${f.base_severity}: a leaf device with no relationships is a smaller hole in the map than an unrelated server, application or service. Reported in full either way.`;
      }
    }
  }
  if (unmodelled.length) {
    const ranked = unmodelled.sort((a, b) => b.cis - a.cis);
    const f = ctx.addCatalogued('CMDB-058', 'cmdb_ci', [], ['sys_class_name'],
      `${ranked.length} class(es) have no relationships at all — not one CI in them is connected to anything: ${ranked.slice(0, 5).map((x) => `${x.cls} (${x.cis.toLocaleString('en-US')} CIs)`).join(', ')}${ranked.length > 5 ? `, and ${ranked.length - 5} more` : ''}. That is a class nobody has modelled rather than ${ranked.reduce((n, x) => n + x.cis, 0).toLocaleString('en-US')} individual orphans, and it is reported once.`,
      { agent: 'relationship_agent',
        evidence: ranked.slice(0, 20).map((x) => fact('cmdb_ci', x.cls, `${x.cis} CI(s), 0 edges`, 'class with no relationships at all')),
        guard: { evaluated: true, note: 'Software packages, licences and other catalogue-like classes legitimately have no topology. Scope the rule by class if that is the case here.' } });
    f.unscored_reason = 'names classes, not records — charging every CI of an unmodelled class would score the absence of a model as thousands of separate defects';
    f.grouped_classes = ranked.map((x) => ({ cls: x.cls, cis: x.cis }));
  }

  /* ── CMDB-059 / CMDB-060 — hosts with nothing on them, apps with no host ── */
  const hostingTypeNames = new Set(opt.hostingTypes);
  const runsOn = edges.filter((e) => hostingTypeNames.has(typeName(e)));
  for (const c of cisFor('CMDB-059')) {
    if (!inClasses(c, opt.hostClasses)) continue;
    if (runsOn.some((e) => e.child === c.sys_id)) continue;
    perRecord('CMDB-059', [c], ['name', 'sys_class_name', 'last_discovered'],
      `${label(c)} is a host class with nothing recorded as running on it — no ${[...hostingTypeNames].join(' / ')} edge names it as the host. Every application it actually runs is invisible to impact analysis.`,
      { confidence: 1.0,
        evidence: [fact('cmdb_rel_ci', 'hosting edges', 0, 'as the host end')],
        guard: { evaluated: false, note: 'A genuinely idle or spare host looks identical. Check last_discovered and any software inventory before treating it as a gap.' } });
  }
  for (const c of cisFor('CMDB-060')) {
    if (!inClasses(c, opt.applicationClasses)) continue;
    if (runsOn.some((e) => e.parent === c.sys_id)) continue;
    perRecord('CMDB-060', [c], ['name', 'sys_class_name'],
      `${label(c)} is an application with no host recorded — no ${[...hostingTypeNames].join(' / ')} edge puts it anywhere. Nothing connects it to the infrastructure that carries it, so an outage on that infrastructure will never name it.`,
      { confidence: 1.0,
        evidence: [fact('cmdb_rel_ci', 'hosting edges', 0, 'as the hosted end')],
        guard: { evaluated: false, note: 'SaaS and externally hosted applications have no internal host by design. Flag them, or exclude the class.' } });
  }

  /* ── CMDB-057 / CMDB-067 — what a service can actually see ────────────── */
  const services = (ctx.estate.cmdb_ci_service || []).filter((s) => !isDead(s));
  const assoc = ctx.complete('svc_ci_assoc', ['service', 'ci']) ? (ctx.estate.svc_ci_assoc || []) : [];
  const serviceOk = ctx.complete('cmdb_ci_service', ['name']);
  if (!serviceOk) {
    for (const r of ['CMDB-057', 'CMDB-067']) skip(r, 'cmdb_ci_service', 'The services were not read completely, so a traversal from them would describe our access rather than the model');
  } else if (!services.length) {
    for (const r of ['CMDB-057', 'CMDB-067']) skip(r, 'cmdb_ci_service', 'This instance has no service CIs to traverse from — CSDM coverage (Group 11), not a relationship defect');
  } else if (services.length < opt.minServiceMapSize) {
    /*
     * TOO FEW SERVICES TO BE A MAP (decision 2 of Sep 2026). CMDB-057 is a
     * gating measured_kpi, and a reachability ratio against three services
     * measures the absence of a service model, not reachability. The fact is
     * still raised — as CSDM posture, which is visible but neither gates nor
     * scores — and the KPI is withheld rather than published against a
     * denominator that cannot carry it.
     */
    const f = ctx.addCatalogued('CMDB-057', 'cmdb_ci_service', [], ['name'],
      `This instance has ${services.length} live service CI(s), below the ${opt.minServiceMapSize} needed for a reachability measurement to mean anything. There is no service model here to be reachable from, so the gap is the model itself (CSDM, Group 11) and not the relationships — reported as posture, so it neither gates the score nor deducts from it.`,
      { agent: 'relationship_agent',
        evidence: [fact('cmdb_ci_service', 'live services', services.length, `below the floor of ${opt.minServiceMapSize}`)],
        guard: { evaluated: true, note: 'A reachability percentage against a handful of services would swing wildly on one edge; it is withheld rather than published.' } });
    f.systemic_kind_override = 'posture';
    f.systemic_kind_override_reason = `Only ${services.length} live service CI(s) exist, so there is no service map to measure reachability against — the absence of a service model is CSDM posture, not a measured reachability failure, and it must not gate the composite.`;
    skip('CMDB-057', 'cmdb_ci', `Reachability was not published as a KPI: ${services.length} live service CI(s) is below the ${opt.minServiceMapSize}-service floor, and a ratio against that denominator would describe the service model rather than the graph`);
    skip('CMDB-067', 'cmdb_ci_service', `Depth was not benchmarked: ${services.length} live service CI(s) is below the ${opt.minServiceMapSize}-service floor, so the estate cannot supply its own benchmark`);
  } else {
    /* One breadth-first walk per service, down the graph, to the depth limit. */
    const reach = new Map();                              // service -> { reached:Set, depth:number }
    for (const svc of services) {
      const seen = new Set([svc.sys_id]);
      let frontier = [svc.sys_id, ...assoc.filter((a) => a.service === svc.sys_id).map((a) => a.ci)].filter(Boolean);
      for (const id of frontier) seen.add(id);
      let depth = 0;
      while (frontier.length && depth < opt.traversalDepth) {
        const next = [];
        for (const id of frontier) {
          for (const e of out.get(id) || []) if (!seen.has(e.child)) { seen.add(e.child); next.push(e.child); }
        }
        if (!next.length) break;
        frontier = next;
        depth += 1;
      }
      seen.delete(svc.sys_id);
      reach.set(svc.sys_id, { reached: seen, depth });
    }
    const reachable = new Set();
    for (const { reached } of reach.values()) for (const id of reached) reachable.add(id);

    const denominatorCis = cisFor('CMDB-057').filter((c) => (principals.size ? principals.has(c.sys_class_name) : true));
    const hit = denominatorCis.filter((c) => reachable.has(c.sys_id)).length;
    const passPct = denominatorCis.length ? (100 * hit) / denominatorCis.length : null;
    if (passPct == null) {
      skip('CMDB-057', 'cmdb_ci', 'There are no in-scope CIs to reach, so there is no reachability to measure');
    } else {
      ctx.kpis.push({
        rule_id: 'CMDB-057',
        pass_pct: passPct,
        numerator: hit,
        denominator: denominatorCis.length,
        basis: `CIs reachable from any of the ${services.length} service CIs within ${opt.traversalDepth} hops${principals.size ? '' : ' (every populated class — no principal classes are designated)'}`,
        alerts: `Traversal follows parent → child edges and svc_ci_assoc, to a depth limit of ${opt.traversalDepth}.`,
      });
      if (passPct < opt.reachThresholdPct) {
        ctx.addCatalogued('CMDB-057', 'cmdb_ci', [], ['sys_class_name'],
          `${hit.toLocaleString('en-US')} of ${denominatorCis.length.toLocaleString('en-US')} in-scope CIs (${pct1(passPct)}%) can be reached from any service within ${opt.traversalDepth} hops, below the ${opt.reachThresholdPct}% threshold. Everything outside that set is invisible to service impact: an outage on it names no service, and a change against it shows no blast radius.${fallbackNote}`,
          { agent: 'relationship_agent',
            evidence: [fact('cmdb_rel_ci', 'reachable', `${hit} of ${denominatorCis.length}`, `from ${services.length} services, depth ${opt.traversalDepth}`)],
            guard: { evaluated: false, note: 'An estate that deliberately models only its critical services will look like this. Confirm the intended scope before treating the rest as a gap.' } });
      }
    }

    /* CMDB-067 — depth against the estate's own best-modelled services. */
    const depths = [...reach.values()].map((x) => x.depth).sort((a, b) => a - b);
    const modelled = depths.filter((d) => d > 0);
    const spread = modelled.length ? modelled[modelled.length - 1] - modelled[0] : 0;
    if (!modelled.length) {
      skip('CMDB-067', 'cmdb_rel_ci', 'No service reaches anything at all, so the estate provides no depth benchmark to compare against — that is CMDB-057\'s finding, not a depth one');
    } else if (modelled.length < opt.minBenchmarkServices || spread < opt.minBenchmarkSpread) {
      /*
       * IS THE BENCHMARK CIRCULAR? (decision 5 of Sep 2026.) It is a percentile
       * of the very services it judges, so it is relative by construction. That
       * is fair when the services differ — the estate has shown the depth is
       * achievable — and empty when they do not: if every modelled service
       * reaches the same depth, the percentile IS that depth, every service
       * passes by definition, and the rule has measured nothing.
       */
      skip('CMDB-067', 'cmdb_ci_service', `The depth benchmark would be circular: ${modelled.length} service(s) reach anything at all and their depths span ${spread} tier(s), so the ${opt.depthBenchmarkPercentile}th percentile is whatever those services already do. A standard derived from the population it judges needs the population to disagree (at least ${opt.minBenchmarkServices} services spanning ${opt.minBenchmarkSpread} tier(s)) before it carries information.`);
    } else {
      const benchmark = modelled[Math.min(modelled.length - 1, Math.floor((opt.depthBenchmarkPercentile / 100) * modelled.length))];
      const reaching = [...reach.entries()].filter(([, x]) => x.depth >= benchmark);
      const atDepth = reaching.length;
      const passDepthPct = (100 * atDepth) / reach.size;
      ctx.kpis.push({
        rule_id: 'CMDB-067',
        pass_pct: passDepthPct,
        numerator: atDepth,
        denominator: reach.size,
        basis: `services that REACH THE EXPECTED DEPTH — ${benchmark} tier(s), the estate's own ${opt.depthBenchmarkPercentile}th percentile across the ${modelled.length} services that reach anything, which span ${spread} tier(s)`,
        alerts: `The benchmark is this estate's own, not an imposed standard. The ${opt.depthPassPct}% pass bar is a CONFIGURABLE DEFAULT of this build and not a catalogue threshold.`,
      });
      if (passDepthPct < opt.depthPassPct) {
        const shallow = [...reach.entries()].filter(([, x]) => x.depth < benchmark)
          .map(([id, x]) => `${byId.get(id)?.name || id} (${x.depth})`).slice(0, 5);
        ctx.addCatalogued('CMDB-067', 'cmdb_ci_service', [], ['name'],
          `${atDepth} of ${reach.size} services reach ${benchmark} tier(s) deep — the depth this estate's own best-modelled services achieve — so ${pct1(100 - passDepthPct)}% of services stop short. Shallowest first: ${shallow.join(', ')}. A service that stops at one tier shows its application and not the infrastructure under it.`,
          { agent: 'relationship_agent',
            evidence: [
              fact('cmdb_rel_ci', 'expected depth', benchmark, `${opt.depthBenchmarkPercentile}th percentile of the ${modelled.length} services that reach anything, spanning ${spread} tier(s)`),
              fact('cmdb_ci_service', 'reaches expected depth', `${atDepth} of ${reach.size}`, `a service "reaches expected depth" when its traversal goes ${benchmark} or more tiers deep`),
              fact('cmdb_ci_service', 'pass bar', `${opt.depthPassPct}%`, 'a configurable default of this build, not a catalogue threshold'),
            ],
            guard: { evaluated: false, note: 'A service with a genuinely shallow architecture is not under-modelled. The benchmark is this estate\'s own, which makes it arguable rather than absolute.' } });
      }
    }
  }

  /* ── CMDB-068 — an edge count far outside its class's distribution ────── */
  const byClass = new Map();
  for (const c of cisFor('CMDB-068')) {
    if (!byClass.has(c.sys_class_name)) byClass.set(c.sys_class_name, []);
    byClass.get(c.sys_class_name).push(c);
  }
  let smallClasses = 0;
  let unmodelledClasses = 0;
  for (const [cls, members] of byClass) {
    if (members.length < opt.minClassPopulation) { smallClasses += 1; continue; }
    if (hierarchyOk && line(cls).some((t) => opt.hubClasses.includes(t))) continue;
    const related = members.filter((c) => edgeCount(c.sys_id)).length;
    if (related / members.length < opt.minRelatedShare) { unmodelledClasses += 1; continue; }
    const counts = members.map((c) => edgeCount(c.sys_id));
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const sd = Math.sqrt(counts.reduce((n, x) => n + (x - mean) ** 2, 0) / counts.length);
    if (!sd) continue;
    for (const c of members) {
      const n = edgeCount(c.sys_id);
      if (Math.abs(n - mean) <= opt.outlierSigma * sd) continue;
      perRecord('CMDB-068', [c], ['name', 'sys_class_name'],
        `${label(c)} has ${n} relationship(s); its class averages ${mean.toFixed(1)} (standard deviation ${sd.toFixed(1)}), so it sits more than ${opt.outlierSigma} deviations out. Either it is modelled differently from everything like it, or it is a hub nobody has declared.`,
        { confidence: 0.8,
          evidence: [fact('cmdb_rel_ci', 'class distribution', `mean ${mean.toFixed(1)}, sd ${sd.toFixed(1)}, n ${members.length}`, `${cls} edge counts`)],
          guard: { evaluated: true, note: `Hub classes are excluded (${opt.hubClasses.join(', ')}); a class smaller than ${opt.minClassPopulation} CIs has no distribution worth testing.` } });
    }
  }
  if (smallClasses) skip('CMDB-068', 'cmdb_ci', `${smallClasses} class(es) hold fewer than ${opt.minClassPopulation} CIs, which is too few for a distribution — an outlier test on six records reports noise`);
  if (unmodelledClasses) skip('CMDB-068', 'cmdb_ci', `${unmodelledClasses} class(es) have fewer than ${Math.round(opt.minRelatedShare * 100)}% of their CIs related to anything, so there is no distribution to be an outlier in — the few that ARE modelled would come back as the anomalies. CMDB-057 and CMDB-058 report that class instead.`);

  /* ── CMDB-056 — a collapse in the edge count, across snapshots ────────── */
  const snapshot = { at: now.toISOString(), total: edges.length };
  /*
   * ONE PASS. The previous version filtered every edge once per type, which is
   * types × edges — harmless at 220 edges and not at two million. Per-class
   * counts are recorded too, because CMDB-136 trends relationships by class.
   */
  const byType = {};
  const byEdgeClass = {};
  for (const e of edges) {
    const t = typeName(e);
    byType[t] = (byType[t] || 0) + 1;
    for (const end of new Set([e.parent, e.child])) {
      const cls = byId.get(end)?.sys_class_name;
      if (cls) byEdgeClass[cls] = (byEdgeClass[cls] || 0) + 1;
    }
  }
  ctx.measures.relationship_counts = { ...snapshot, by_type: byType, by_class: byEdgeClass };
  const history = (ctx.history?.relationship_counts || []).filter((h) => h && parseDate(h.at) && Number.isFinite(h.total));
  const series = [...history, snapshot].sort((a, b) => parseDate(a.at) - parseDate(b.at));
  const inWindow = series.filter((s) => (now - parseDate(s.at)) <= opt.collapseWindowDays * DAY_MS);
  if (series.length < opt.minSnapshots) {
    skip('CMDB-056', 'health_runs', `Needs ${opt.minSnapshots} snapshots of the relationship count; ${series.length} exist (this run recorded one). Evaluates automatically once there are enough.`);
  } else {
    const first = inWindow[0] ?? series[0];
    const drop = first.total ? (100 * (first.total - snapshot.total)) / first.total : 0;
    if (drop > opt.collapseDropPct) {
      ctx.addCatalogued('CMDB-056', 'cmdb_rel_ci', [], ['parent', 'child'],
        `The relationship count fell from ${first.total.toLocaleString('en-US')} to ${snapshot.total.toLocaleString('en-US')} (${pct1(drop)}%) since ${first.at.slice(0, 10)}, past the ${opt.collapseDropPct}% collapse threshold for a ${opt.collapseWindowDays}-day window. Edges are disappearing faster than an estate loses devices, and every one of them was a path impact analysis used to walk.`,
        { agent: 'relationship_agent',
          evidence: [fact('cmdb_rel_ci', 'edge count', `${first.total} → ${snapshot.total}`, `${series.length} snapshots`)],
          guard: { evaluated: false, note: 'A planned decommission of a device population looks exactly like this. Cross-check the change records in the window before treating it as a collapse.' } });
    }
  }

  if (inactiveCis.length) {
    skip('CMDB-058', 'cmdb_ci', `${inactiveCis.length} retired, stolen or absent CI(s) are outside this dimension's QUALITY rules — a retired CI with no relationships is not a defect. The contradiction rules here (CMDB-061, 062, 064, 065) did judge them.`);
  }
}
