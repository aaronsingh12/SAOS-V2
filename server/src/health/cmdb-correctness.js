import { isIP } from 'node:net';
import { modifiersFor, lineageOf, dqActive, DQ_INACTIVE_INSTALL_STATUS } from './cmdb-signals.js';
import { isPlaceholder, COMPLETENESS_DEFAULTS } from './cmdb-completeness.js';
import { parseDate } from './rules.js';

/**
 * GROUP 3 — CORRECTNESS AND VALIDITY (D2). CMDB-023 to CMDB-032.
 *
 * Implemented from tracker v3, against what exists (verified on dev424910,
 * 17 Sep 2026):
 *
 *   - The "permitted set" for install_status × operational_status is not a
 *     hardcoded list. The instance's own `life_cycle_mapping` maps each legacy
 *     value onto a lifecycle STAGE (with class-specific rows). A pair is
 *     contradictory when one value maps to a RUNNING stage and the other to a
 *     NOT-RUNNING one — "In Stock" (Inventory) with "Operational", for example.
 *     Two different stages are not enough (decision 3 of 18 Sep): Installed +
 *     Non-Operational maps to Operational + Design on the OOB mapping, and is
 *     the valid "installed but down" state. The exemption falls out of the stage
 *     sets; no pair is hardcoded.
 *   - Reclassification churn (CMDB-026) reads sys_audit, which proves nothing
 *     when the CMDB is not audited — it skips, as CMDB-011 and 021 do.
 *   - Source-attribute contradictions (CMDB-025) need reconciliation definitions
 *     and per-attribute source values; both are empty on a bare PDI.
 *
 * PURE — node:net's isIP is a string parser, not a socket.
 */

export const CORRECTNESS_RULES = Object.freeze([
  'CMDB-023', 'CMDB-024', 'CMDB-025', 'CMDB-026', 'CMDB-027', 'CMDB-028', 'CMDB-029', 'CMDB-030', 'CMDB-031', 'CMDB-032',
]);

export const CORRECTNESS_DEFAULTS = Object.freeze({
  /* CMDB-024: a CI in a LIVE stage depending on one in a DEAD stage, for these relationship types. */
  dependencyTypes: Object.freeze(['Depends on::Used by', 'Runs on::Runs', 'Hosted on::Hosts', 'Uses::Used by', 'Consumes::Consumed by',
    'Virtualized by::Virtualizes', 'Provided By::Provides', 'Cluster of::Cluster']),
  liveStages: Object.freeze(['Operational']),
  deadStages: Object.freeze(['End of Life', 'Missing']),
  /* CMDB-023 needs no stage list at all — see the derivation below (19 Sep). */
  dqInactiveInstallStatus: DQ_INACTIVE_INSTALL_STATUS,
  sourceLagHours: 24,                   // CMDB-025
  churnChanges: 3,                      // CMDB-026: more than this many
  churnWindowDays: 90,
  signatureMinClass: 20,                // CMDB-028
  signatureMargin: 2,
  signatureBestMin: 0.5,
  signatureCurrentMax: 0.25,
  numericRanges: Object.freeze({        // CMDB-031, per attribute: [exclusive-min, max]
    ram: [0, 67_108_864],               // MB, up to 64 TB
    cpu_count: [0, 4096],
    cpu_core_count: [0, 65_536],
    disk_space: [0, 1_000_000],         // GB
  }),
  numericClasses: Object.freeze(['cmdb_ci_computer']),
  nameMinClass: 10,                     // CMDB-032
  nameDominantPct: 60,
});

const empty = (v) => v == null || String(v).trim() === '';
const MAC = /^(?:[0-9A-Fa-f]{2}([:-]))(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}$|^[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}$/;
const LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;
export function validFqdn(v) {
  const s = String(v).trim().replace(/\.$/, '');
  if (s.length > 253 || !s.includes('.')) return false;
  return s.split('.').every((l) => LABEL.test(l));
}
export function validSerial(v) {
  return /^[A-Za-z0-9][A-Za-z0-9 \-_./:#]*$/.test(String(v).trim()) && String(v).trim().length >= 3;
}
/** A name's shape: letter runs → A, digit runs → 9, spaces → _. */
export function nameShape(name) {
  return String(name).trim().replace(/[A-Za-z]+/g, 'A').replace(/[0-9]+/g, '9').replace(/\s+/g, '_');
}

export function cmdbCorrectnessRules(ctx, options = {}) {
  const opt = { ...CORRECTNESS_DEFAULTS, ...options };
  const placeholders = { ...COMPLETENESS_DEFAULTS };
  const now = ctx.now;
  const meta = ctx.meta?.cmdb || {};
  const signals = ctx.signals;
  const skip = (rule, table, reason) => ctx.skipped.push({ rule, table, reason });
  const readOk = (key) => meta.reads?.[key]?.status === 'ok';
  const readWhy = (key) => meta.reads?.[key]?.error || 'not read';
  const { active: cis, excluded: inactiveCis } = dqActive(ctx.estate.cmdb_ci || [], opt.dqInactiveInstallStatus);
  /*
   * EVERY CI, including the retired ones. The data-quality slice decides which
   * records are JUDGED; a rule like CMDB-024 ("a live CI depends on a dead one")
   * has to be able to look the dead one up — it is the object of the check, not
   * the record being charged.
   */
  const byId = new Map((ctx.estate.cmdb_ci || []).map((c) => [c.sys_id, c]));
  const line = (cls) => lineageOf(meta, cls || 'cmdb_ci');
  const hierarchyOk = readOk('class_hierarchy');
  const fact = (table, field, value, reason) => ({
    source: 'ServiceNow Table/Aggregate REST API', sn_table: table, sn_sys_id: null,
    field_name: field, field_value: String(value), reason, collected_at: now.toISOString(),
  });
  const perRecord = (rule, records, fields, description, extra = {}) => {
    const m = modifiersFor(records, signals);
    ctx.addCatalogued(rule, 'cmdb_ci', records, fields, description, {
      agent: 'cmdb_agent', escalators: m.escalators, deEscalators: m.deEscalators, notEvaluated: m.notEvaluated, ...extra,
    });
  };
  const needCis = (rule, fields) => {
    if (ctx.complete('cmdb_ci', fields)) return true;
    const lacking = fields.filter((f) => (ctx.coverage.cmdb_ci?.missing_fields || []).includes(f));
    skip(rule, 'cmdb_ci', lacking.length ? `cmdb_ci did not return ${lacking.join(', ')}` : 'cmdb_ci was not read completely');
    return false;
  };
  const needHierarchy = (rule) => {
    if (hierarchyOk) return true;
    skip(rule, 'sys_db_object', `The class hierarchy could not be read: ${readWhy('class_hierarchy')}`);
    return false;
  };

  /* ── The instance's lifecycle mapping: legacy value → stage, nearest class first ── */
  const mappingOk = ctx.complete('life_cycle_mapping', ['table', 'legacy_field_name', 'legacy_field_value', 'life_cycle_control'])
    && ctx.complete('life_cycle_control', ['life_cycle_stage']);
  const controls = new Map((ctx.estate.life_cycle_control || []).map((c) => [c.sys_id, c]));
  const mappings = (ctx.estate.life_cycle_mapping || []).filter((m) => String(m.active) === 'true' && empty(m.legacy_subfield_name));
  const stageOf = (cls, field, value) => {
    if (empty(value)) return null;
    for (const t of line(cls)) {
      const row = mappings.find((m) => m.table === t && m.legacy_field_name === field && String(m.legacy_field_value) === String(value));
      if (row) return controls.get(row.life_cycle_control)?.life_cycle_stage || null;
    }
    return null;
  };

  /**
   * WHICH STAGES THE TWO STATUS FIELDS CAN BOTH REACH, per class (19 Sep).
   *
   * No stage list is written down anywhere. The instance's own
   * `life_cycle_mapping` says which stage each legacy value of each field means;
   * a stage BOTH fields can reach is a claim both fields are able to make, and
   * two such claims that disagree are a contradiction. A stage only one field
   * can reach is that field saying something the other cannot contradict.
   *
   * Measured on dev424910 for cmdb_ci: install_status reaches Operational,
   * Purchase, Deploy, Inventory, End of Life, Missing; operational_status reaches
   * Operational, Design, Inventory, End of Life. SHARED = Operational, Inventory,
   * End of Life. So:
   *   In Stock (Inventory) + Operational          → both shared, different → contradiction
   *   Installed (Operational) + Non-Operational (Design) → Design is operational-only:
   *                                                 "installed but down", not a contradiction
   *   Retired (End of Life) + Operational         → both shared → contradiction
   * Defective, End of Operation and To Be Determined exist as lifecycle controls
   * on that instance but NO legacy value maps to them, so they are stages the
   * instance genuinely does not map and can never take part.
   */
  const stagesReachable = (cls, field) => {
    for (const t of line(cls)) {
      const rows = mappings.filter((m) => m.table === t && m.legacy_field_name === field);
      if (rows.length) return new Set(rows.map((m) => controls.get(m.life_cycle_control)?.life_cycle_stage).filter(Boolean));
    }
    return new Set();
  };
  const sharedCache = new Map();
  const sharedStages = (cls) => {
    if (!sharedCache.has(cls)) {
      const a = stagesReachable(cls, 'install_status');
      const b = stagesReachable(cls, 'operational_status');
      sharedCache.set(cls, new Set([...a].filter((x) => b.has(x))));
    }
    return sharedCache.get(cls);
  };

  /* ── CMDB-023 — install_status and operational_status contradict each other ── */
  if (!mappingOk) {
    skip('CMDB-023', 'life_cycle_mapping', "The instance's lifecycle mapping was not read completely, so there is no permitted set to compare against — none is hardcoded");
  } else if (needCis('CMDB-023', ['install_status', 'operational_status', 'sys_class_name']) && needHierarchy('CMDB-023')) {
    let unmapped = 0;
    let oneSided = 0;
    let noShared = 0;
    for (const c of cis) {
      if (empty(c.install_status) || empty(c.operational_status)) continue;
      const a = stageOf(c.sys_class_name, 'install_status', c.install_status);
      const b = stageOf(c.sys_class_name, 'operational_status', c.operational_status);
      if (!a || !b) { unmapped += 1; continue; }
      if (a === b) continue;
      const shared = sharedStages(c.sys_class_name);
      if (shared.size < 2) { noShared += 1; continue; }
      if (!shared.has(a) || !shared.has(b)) { oneSided += 1; continue; }
      perRecord('CMDB-023', [c], ['install_status', 'operational_status', 'sys_class_name', 'name'],
        `${c.sys_class_name} "${c.name || c.sys_id}" has install_status ${c.install_status} (lifecycle stage "${a}") and operational_status ${c.operational_status} (stage "${b}"). Both fields can express either stage on this instance, so the two are contradicting each other and consumers reading one field get the opposite answer from the other.`,
        { guard: { evaluated: true, note: `Derived from the instance's own life_cycle_mapping: the stages BOTH status fields can reach for ${c.sys_class_name} are ${[...shared].join(', ')}. A stage only one field can reach (an installed CI reported Non-Operational) is that field alone speaking, and is not a contradiction. A value the mapping does not cover is left unflagged.` } });
    }
    if (unmapped) skip('CMDB-023', 'life_cycle_mapping', `${unmapped} CI(s) hold a status value the lifecycle mapping does not cover — left unflagged rather than guessed`);
    if (oneSided) skip('CMDB-023', 'life_cycle_mapping', `${oneSided} CI(s) hold two stages only one status field can reach (for example installed but Non-Operational) — one field speaking alone, not a contradiction`);
    if (noShared) skip('CMDB-023', 'life_cycle_mapping', `${noShared} CI(s) belong to a class whose mapping gives the two status fields fewer than two stages in common, so the instance defines no permitted set to compare against`);
  }

  if (inactiveCis.length) {
    skip('CMDB-023', 'cmdb_ci', `${inactiveCis.length} retired, stolen or absent CI(s) are outside the data-quality dimensions and were not judged for correctness — the lifecycle dimension (CMDB-085/087) evaluates those statuses`);
  }

  /* ── CMDB-024 — a live CI depending on a dead one ─────────────────────── */
  if (!mappingOk) {
    skip('CMDB-024', 'life_cycle_mapping', "The instance's lifecycle mapping was not read completely");
  } else if (!ctx.complete('cmdb_rel_ci', ['parent', 'child', 'type.name'])) {
    skip('CMDB-024', 'cmdb_rel_ci', 'Relationships (with their type) were not read completely');
  } else if (needCis('CMDB-024', ['install_status', 'sys_class_name']) && needHierarchy('CMDB-024')) {
    const changeOpen = new Set((ctx.complete('change_request', ['cmdb_ci']) ? ctx.estate.change_request || [] : [])
      .filter((ch) => String(ch.active) === 'true').map((ch) => ch.cmdb_ci).filter(Boolean));
    for (const r of ctx.estate.cmdb_rel_ci || []) {
      if (!opt.dependencyTypes.includes(r['type.name'])) continue;
      const p = byId.get(r.parent);
      const ch = byId.get(r.child);
      if (!p || !ch) continue;
      const ps = stageOf(p.sys_class_name, 'install_status', p.install_status);
      const cs = stageOf(ch.sys_class_name, 'install_status', ch.install_status);
      if (!(opt.liveStages.includes(ps) && opt.deadStages.includes(cs))) continue;
      /* FALSE POSITIVE GUARD: a planned migration — an open change on either CI. */
      if (changeOpen.has(p.sys_id) || changeOpen.has(ch.sys_id)) continue;
      perRecord('CMDB-024', [p, ch], ['install_status', 'sys_class_name', 'name'],
        `"${p.name || p.sys_id}" (${ps}) ${r['type.name'].split('::')[0].toLowerCase()} "${ch.name || ch.sys_id}" (${cs}). Impact analysis will traverse an edge that cannot physically exist. Which CI is wrong is a judgement.`,
        {
          confidence: 0.9,
          evidence: [fact('cmdb_rel_ci', 'edge', `${r.parent} → ${r.child} (${r['type.name']})`, 'the contradictory relationship')],
          guard: { evaluated: ctx.complete('change_request', ['cmdb_ci']), note: 'Edges where either CI has an open change (a planned migration) are excluded; only the change\'s own CI is checked, not its affected-CIs list.' },
        });
    }
  }

  /* ── CMDB-025 — attribute contradicted by its authoritative source ────── */
  if (!ctx.complete('cmdb_reconciliation_definition', ['discovery_source', 'attributes', 'applies_to'])
    || !ctx.complete('cmdb_datasource_attribute_value', ['ci', 'attribute', 'value', 'discovery_source', 'updated_on'])) {
    skip('CMDB-025', 'cmdb_datasource_attribute_value', 'Reconciliation definitions or per-attribute source values were not read completely');
  } else if (!(ctx.estate.cmdb_datasource_attribute_value || []).length || !(ctx.estate.cmdb_reconciliation_definition || []).length) {
    skip('CMDB-025', 'cmdb_datasource_attribute_value', 'No reconciliation definitions or source attribute values exist, so no attribute has an authoritative source to contradict — needs Discovery or Service Graph Connectors writing through IRE');
  } else if (needHierarchy('CMDB-025')) {
    const defs = (ctx.estate.cmdb_reconciliation_definition || []).filter((d) => String(d.active) === 'true');
    const authority = (cls, attr) => {
      const matching = defs.filter((d) => line(cls).includes(d.applies_to) && String(d.attributes || '').split(',').map((x) => x.trim()).includes(attr));
      return matching.sort((a, b) => Number(a.priority || 999) - Number(b.priority || 999))[0]?.discovery_source ?? null;
    };
    const lagMs = opt.sourceLagHours * 3_600_000;
    for (const v of ctx.estate.cmdb_datasource_attribute_value || []) {
      const c = byId.get(v.ci);
      if (!c || !(v.attribute in c)) continue;
      const src = authority(c.sys_class_name, v.attribute);
      if (!src || src !== v.discovery_source) continue;
      const seen = parseDate(v.updated_on);
      if (seen && now.getTime() - seen.getTime() < lagMs) continue;
      if (String(c[v.attribute] ?? '') === String(v.value ?? '')) continue;
      perRecord('CMDB-025', [c], [v.attribute, 'sys_class_name', 'name'],
        `${v.attribute} on "${c.name || c.sys_id}" is "${c[v.attribute]}" but its authoritative source ${src} last reported "${v.value}" (${v.updated_on}).`,
        { evidence: [fact('cmdb_datasource_attribute_value', `${v.attribute} from ${src}`, v.value, `reported ${v.updated_on}`)],
          guard: { evaluated: false, note: 'Documented manual overrides are not read yet.' } });
    }
  }

  /* ── CMDB-026 — reclassification churn ────────────────────────────────── */
  if (!readOk('class_audit')) {
    skip('CMDB-026', 'sys_audit', `Class-change history could not be read: ${readWhy('class_audit')}`);
  } else if (!meta.classAudit?.audited) {
    skip('CMDB-026', 'sys_audit', 'cmdb_ci is not audited on this instance, so an absence of sys_class_name changes proves nothing — the rule cannot be evaluated');
  } else {
    const byCi = new Map();
    for (const row of meta.classAudit.rows || []) {
      if (!byCi.has(row.documentkey)) byCi.set(row.documentkey, []);
      byCi.get(row.documentkey).push(row);
    }
    for (const [id, rows] of byCi) {
      if (rows.length <= opt.churnChanges) continue;
      const times = rows.map((r) => parseDate(r.sys_created_on)?.getTime()).filter(Boolean).sort((a, b) => a - b);
      /* FALSE POSITIVE GUARD: a one-time reclassification project clusters in one day. */
      if (times.length && times[times.length - 1] - times[0] < 86_400_000) continue;
      const c = byId.get(id);
      if (!c) continue;
      perRecord('CMDB-026', [c], ['sys_class_name', 'name'],
        `"${c.name || id}" changed class ${rows.length} times in ${opt.churnWindowDays} days (${rows.map((r) => `${r.oldvalue}→${r.newvalue}`).join(', ')}). Each switch can drop class-specific attributes and relationships.`,
        { guard: { evaluated: true, note: 'Changes clustered within a single day (a one-time project) are excluded.' } });
    }
  }

  /* ── Attribute signature: which class a CI's identity attributes look like (027, 028) ── */
  const populated = (c, f) => !empty(c[f]) && !isPlaceholder(c[f], placeholders);
  const hasSignature = (c) => ['serial_number', 'ip_address', 'mac_address'].filter((f) => populated(c, f)).length >= 2;
  const classRate = new Map();
  for (const c of cis) {
    const k = classRate.get(c.sys_class_name) || { n: 0, sig: 0 };
    k.n += 1; if (hasSignature(c)) k.sig += 1;
    classRate.set(c.sys_class_name, k);
  }
  const profiles = [...classRate.entries()].filter(([, k]) => k.n >= opt.signatureMinClass).map(([cls, k]) => [cls, k.sig / k.n]);
  const bestHome = (c) => {
    const current = classRate.get(c.sys_class_name);
    const curRate = current ? current.sig / current.n : 0;
    const cur = line(c.sys_class_name);
    const others = profiles.filter(([cls]) => cls !== c.sys_class_name && !cur.includes(cls) && !line(cls).includes(c.sys_class_name))
      .sort((a, b) => b[1] - a[1]);
    return others.length ? { cls: others[0][0], rate: others[0][1], curRate } : null;
  };

  /* ── CMDB-027 — CI on the base cmdb_ci class ──────────────────────────── */
  if (needCis('CMDB-027', ['sys_class_name'])) {
    for (const c of cis.filter((x) => x.sys_class_name === 'cmdb_ci')) {
      const home = hasSignature(c) ? bestHome(c) : null;
      const attrs = ['serial_number', 'ip_address', 'mac_address', 'fqdn'].filter((f) => populated(c, f));
      perRecord('CMDB-027', [c], ['sys_class_name', 'name', ...attrs],
        `"${c.name || c.sys_id}" sits on the base cmdb_ci class, so no class-scoped identification, relationship or attribute rule applies to it. `
        + (home ? `Its attributes look like ${home.cls} (${(home.rate * 100).toFixed(0)}% of that class share them).` : `Populated identity attributes: ${attrs.join(', ') || 'none'}, so no better class can be inferred.`),
        { guard: { evaluated: false, note: 'Deliberate use of the base class for a non-standard entity cannot be told apart — question it with the owner.' } });
    }
  }

  /* ── CMDB-028 — CI in the wrong class for its attributes ──────────────── */
  if (needCis('CMDB-028', ['serial_number', 'ip_address', 'mac_address', 'sys_class_name']) && needHierarchy('CMDB-028')) {
    for (const c of cis.filter((x) => x.sys_class_name !== 'cmdb_ci' && hasSignature(x))) {
      const home = bestHome(c);
      if (!home) continue;
      const margin = home.rate / Math.max(home.curRate, 0.01);
      if (home.curRate < opt.signatureCurrentMax && home.rate >= opt.signatureBestMin && margin >= opt.signatureMargin) {
        perRecord('CMDB-028', [c], ['serial_number', 'ip_address', 'mac_address', 'sys_class_name', 'name'],
          `"${c.name || c.sys_id}" carries a hardware identity signature (serial / IP / MAC) that ${(home.curRate * 100).toFixed(0)}% of ${c.sys_class_name} has and ${(home.rate * 100).toFixed(0)}% of ${home.cls} has — a margin of ${margin.toFixed(1)}×.`,
          { confidence: Number(Math.min(1, home.rate - home.curRate).toFixed(2)),
            guard: { evaluated: true, note: `Requires a ${opt.signatureMargin}× margin and classes of at least ${opt.signatureMinClass} CIs; a genuinely hybrid entity may still match.` } });
      }
    }
  }

  /* ── CMDB-029 — value outside the permitted choice list ───────────────── */
  if (!readOk('choices')) {
    skip('CMDB-029', 'sys_choice', `Choice lists could not be read: ${readWhy('choices')}`);
  } else if (needCis('CMDB-029', ['install_status', 'operational_status', 'discovery_source', 'sys_class_name']) && needHierarchy('CMDB-029')) {
    const byTableElement = new Map();
    for (const ch of meta.choices || []) {
      const key = `${ch.name}|${ch.element}`;
      if (!byTableElement.has(key)) byTableElement.set(key, { active: new Set(), inactive: new Set() });
      byTableElement.get(key)[String(ch.inactive) === 'true' ? 'inactive' : 'active'].add(String(ch.value));
    }
    /* Inheritance: the nearest table in the lineage that defines choices for the element. */
    const listFor = (cls, element) => {
      for (const t of line(cls)) if (byTableElement.has(`${t}|${element}`)) return byTableElement.get(`${t}|${element}`);
      return null;
    };
    for (const c of cis) {
      const bad = [];
      for (const element of ['install_status', 'operational_status', 'discovery_source']) {
        if (empty(c[element])) continue;
        const list = listFor(c.sys_class_name, element);
        if (!list || list.active.has(String(c[element]))) continue;
        if (list.inactive.has(String(c[element]))) continue;       // guard: a retired choice held legitimately
        bad.push(`${element}="${c[element]}"`);
      }
      if (!bad.length) continue;
      perRecord('CMDB-029', [c], ['install_status', 'operational_status', 'discovery_source', 'sys_class_name', 'name'],
        `"${c.name || c.sys_id}" holds ${bad.join(', ')} — not in the active choice list for ${c.sys_class_name} (inherited lists included). Reporting and any logic that switches on the value misfire.`,
        { guard: { evaluated: true, note: 'Values that exist as INACTIVE choices (recently retired) are excluded.' } });
    }
  }

  /* ── CMDB-030 — format validation ─────────────────────────────────────── *
   * A CONSERVATIVE SUBSET, confirmed 18 Sep: serials are checked for impossible
   * characters and length only. It under-detects — "ABC" passes for a vendor
   * whose serials are 10 digits — until a manufacturer pattern library is built
   * from the estate's own dominant serial formats. Said on every run. */
  if (needCis('CMDB-030', ['ip_address', 'mac_address', 'fqdn', 'serial_number'])) {
    skip('CMDB-030', 'cmdb_ci', 'Partial: serial numbers are checked for impossible characters and length only. This under-detects malformed serials — no manufacturer pattern library exists yet (to be built from the estate\'s own dominant serial formats).');
    for (const c of cis) {
      const bad = [];
      const check = (f, ok) => { if (!empty(c[f]) && !isPlaceholder(c[f], placeholders) && !ok(c[f])) bad.push(f); };
      check('ip_address', (v) => isIP(String(v).trim()) !== 0);
      check('mac_address', (v) => MAC.test(String(v).trim()));
      check('fqdn', validFqdn);
      check('serial_number', validSerial);
      if (!bad.length) continue;
      perRecord('CMDB-030', [c], [...bad, 'sys_class_name', 'name'],
        `"${c.name || c.sys_id}" has malformed ${bad.map((f) => `${f} "${c[f]}"`).join(', ')}. The field reads as populated and cannot be used for matching or identification.`,
        { confidence: bad.includes('serial_number') ? 0.8 : 0.95,
          guard: { evaluated: false, note: 'IP, MAC and FQDN use standard formats. Serials are only checked for impossible characters and length — a per-manufacturer pattern library is not built, because the manufacturer is not read.' } });
    }
  }

  /* ── CMDB-031 — impossible numeric values ─────────────────────────────── */
  if (!readOk('class_attrs') || !readOk('virtual')) {
    skip('CMDB-031', 'cmdb_ci_computer', `Numeric attributes could not be read: ${readWhy(!readOk('class_attrs') ? 'class_attrs' : 'virtual')}`);
  } else if (needHierarchy('CMDB-031')) {
    const virtual = new Set(meta.virtualIds || []);
    for (const c of cis.filter((x) => line(x.sys_class_name).some((t) => opt.numericClasses.includes(t)) && !virtual.has(x.sys_id))) {
      const values = meta.classAttrs?.[c.sys_class_name]?.values?.[c.sys_id] || {};
      const bad = Object.entries(opt.numericRanges)
        .filter(([f]) => f in values && !empty(values[f]))
        .filter(([f, [min, max]]) => { const n = Number(values[f]); return !Number.isFinite(n) || n <= min || n > max; })
        .map(([f, [, max]]) => `${f}=${values[f]} (plausible: above 0, at most ${max.toLocaleString()})`);
      if (!bad.length) continue;
      perRecord('CMDB-031', [c], ['sys_class_name', 'name'],
        `"${c.name || c.sys_id}" holds impossible values: ${bad.join('; ')}. A failed discovery parse or a bad transform wrote confidently wrong data.`,
        { guard: { evaluated: true, note: 'Scoped to physical computers; virtual machines are excluded. An empty value is a completeness question, not this rule.' } });
    }
  }

  /* ── CMDB-032 — name not conforming to the estate's own convention ───── */
  if (needCis('CMDB-032', ['name', 'sys_class_name'])) {
    const byClass = new Map();
    for (const c of cis.filter((x) => !empty(x.name))) {
      if (!byClass.has(c.sys_class_name)) byClass.set(c.sys_class_name, []);
      byClass.get(c.sys_class_name).push(c);
    }
    let suppressed = 0;
    for (const [cls, members] of byClass) {
      if (members.length < opt.nameMinClass) continue;
      const counts = new Map();
      for (const c of members) counts.set(nameShape(c.name), (counts.get(nameShape(c.name)) || 0) + 1);
      const [shape, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const pct = (100 * n) / members.length;
      /* FALSE POSITIVE GUARD: several legitimate conventions — no single pattern reaches the threshold. */
      if (pct < opt.nameDominantPct) { suppressed += 1; continue; }
      for (const c of members.filter((x) => nameShape(x.name) !== shape)) {
        perRecord('CMDB-032', [c], ['name', 'sys_class_name'],
          `"${c.name}" (shape ${nameShape(c.name)}) does not follow ${cls}'s dominant naming shape ${shape}, which ${pct.toFixed(0)}% of the class uses.`,
          { confidence: 0.7, guard: { evaluated: true, note: `Only raised where one shape covers at least ${opt.nameDominantPct}% of a class of ${opt.nameMinClass}+ CIs.` } });
      }
    }
    if (suppressed) skip('CMDB-032', 'cmdb_ci', `${suppressed} class(es) have no single naming convention covering ${opt.nameDominantPct}% — suppressed as the guard requires`);
  }
}
