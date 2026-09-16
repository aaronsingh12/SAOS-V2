import { modifiersFor, lineageOf, truthy, dqActive, DQ_INACTIVE_INSTALL_STATUS } from './cmdb-signals.js';

/**
 * GROUP 2 — COMPLETENESS (D1), plus CMDB-140 (identity attributes, D1) and
 * CMDB-141 (the impact-analysis headline, a D10 KPI).
 *
 * Implemented from tracker v3, against what exists on the platform (verified on
 * dev424910, 16 Sep 2026):
 *
 *   - `used_for` is NOT on cmdb_ci — only on child classes (servers,
 *     applications) — so CMDB-016 reads it per class.
 *   - `business_criticality` is NOT on cmdb_ci either; it exists as
 *     `busines_criticality` on services. CMDB-015 is evaluated there.
 *   - core_company has no `active` field, so CMDB-018's "multi-company" is the
 *     companies actually USED on CIs, not the number of company records.
 *
 * PURE. Everything instance-facing was read by extract.js; `ctx` carries it.
 *
 * ═══ FOUR PLACES THE LITERAL DETECTION LOGIC WOULD FLOOD, AND THE GUARD WINS ═══
 *
 *   CMDB-020  "CIs WHERE location empty" fires on every software package and
 *             service — 1,767 packages on dev424910 — which have no location by
 *             nature. Scoped to physical classes, as the rule's guard intends.
 *   CMDB-022  If no in-scope CI carries a cost centre at all, the organisation
 *             does not allocate at CI level: the rule's own guard says confirm
 *             before raising, so it skips and says why.
 *   CMDB-021  "No audit entry" proves nothing when the table is not audited
 *             (cmdb_ci collection audit=false on dev424910) — it skips.
 *   CMDB-018  Company records are not companies in use; see above.
 */

export const COMPLETENESS_RULES = Object.freeze([
  'CMDB-012', 'CMDB-013', 'CMDB-014', 'CMDB-015', 'CMDB-016', 'CMDB-017', 'CMDB-018',
  'CMDB-019', 'CMDB-020', 'CMDB-021', 'CMDB-022', 'CMDB-140', 'CMDB-141',
]);

/* The catalogue's placeholder set (CMDB-012 lists nine; CMDB-017 names twelve
   including the zero IP and MAC). One set, configurable, used by every rule. */
export const COMPLETENESS_DEFAULTS = Object.freeze({
  placeholders: Object.freeze(['unknown', 'n/a', 'na', 'tbd', 'none', '-', 'null', '0', 'default', 'to be filled by o.e.m.', '0.0.0.0', '00:00:00:00:00:00']),
  placeholderPrefixes: Object.freeze(['to be filled']),
  networkClasses: Object.freeze(['cmdb_ci_netgear', 'cmdb_ci_computer', 'cmdb_ci_appl']),
  physicalClasses: Object.freeze(['cmdb_ci_hardware']),
  financialClasses: Object.freeze(['cmdb_ci_hardware']),
  locationMinDepth: 3,
  defaultChoiceRatio: 80,          // CMDB-021 — confirmed 17 Sep
  descriptiveAttributes: Object.freeze(['name']),
  impactThresholdPct: 90,          // CMDB-141 — confirmed 17 Sep
  dqInactiveInstallStatus: DQ_INACTIVE_INSTALL_STATUS,
});

export function isPlaceholder(value, opt = COMPLETENESS_DEFAULTS) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return false;
  return opt.placeholders.includes(v) || opt.placeholderPrefixes.some((p) => v.startsWith(p));
}
const empty = (v) => v == null || String(v).trim() === '';
const missing = (v, opt) => empty(v) || isPlaceholder(v, opt);

export function cmdbCompletenessRules(ctx, options = {}) {
  const opt = { ...COMPLETENESS_DEFAULTS, ...options };
  const now = ctx.now;
  const meta = ctx.meta?.cmdb || {};
  const signals = ctx.signals;
  const skip = (rule, table, reason) => ctx.skipped.push({ rule, table, reason });
  const readOk = (key) => meta.reads?.[key]?.status === 'ok';
  const readWhy = (key) => meta.reads?.[key]?.error || 'not read';
  /* Decision 7 of 19 Sep: completeness judges the records somebody is supposed to
     be maintaining. Retired, stolen and absent CIs belong to the lifecycle
     dimension, which exists to evaluate exactly those statuses. */
  const { active: cis, excluded: inactiveCis } = dqActive(ctx.estate.cmdb_ci || [], opt.dqInactiveInstallStatus || DQ_INACTIVE_INSTALL_STATUS);
  if (inactiveCis.length) {
    skip('CMDB-012', 'cmdb_ci', `${inactiveCis.length} retired, stolen or absent CI(s) are outside the data-quality dimensions and were not judged for completeness — the lifecycle dimension (CMDB-085/087) evaluates those statuses`);
  }
  const line = (c) => lineageOf(meta, c.sys_class_name || 'cmdb_ci');
  const inClasses = (c, set) => line(c).some((t) => set.includes(t));
  const hierarchyOk = readOk('class_hierarchy');
  const fact = (table, field, value, reason) => ({
    source: 'ServiceNow Table/Aggregate REST API', sn_table: table, sn_sys_id: null,
    field_name: field, field_value: String(value), reason, collected_at: now.toISOString(),
  });

  /** One finding per CI, with the modifiers its own context earns. */
  const perRecord = (rule, c, fields, description, extra = {}) => {
    const m = modifiersFor([c], signals);
    ctx.addCatalogued(rule, 'cmdb_ci', [c], fields, description, {
      agent: 'cmdb_agent', escalators: m.escalators, deEscalators: m.deEscalators, notEvaluated: m.notEvaluated, ...extra,
    });
  };
  const needCis = (rule, fields) => {
    if (!ctx.complete('cmdb_ci', fields)) {
      const cov = ctx.coverage.cmdb_ci || {};
      const lacking = fields.filter((f) => (cov.missing_fields || []).includes(f));
      skip(rule, 'cmdb_ci', lacking.length ? `cmdb_ci did not return ${lacking.join(', ')} — not a field this instance exposes on cmdb_ci` : 'cmdb_ci was not read completely');
      return false;
    }
    return true;
  };
  const needHierarchy = (rule) => {
    if (!hierarchyOk) { skip(rule, 'sys_db_object', `The class hierarchy could not be read: ${readWhy('class_hierarchy')}`); return false; }
    return true;
  };

  /* ── CMDB-012 — serial number missing on hardware ─────────────────────── */
  if (needCis('CMDB-012', ['serial_number', 'sys_class_name']) && needHierarchy('CMDB-012')) {
    if (!readOk('virtual')) {
      skip('CMDB-012', 'cmdb_ci_computer', `Virtual machines could not be told apart: ${readWhy('virtual')}`);
    } else {
      const virtual = new Set(meta.virtualIds || []);
      const serialRule = (c) => {
        const ids = (ctx.estate.cmdb_identifier || []).filter((i) => truthy(i.active) && line(c).includes(i.applies_to));
        const idset = new Set(ids.map((i) => i.sys_id));
        return (ctx.estate.cmdb_identifier_entry || []).some((e) => idset.has(e.identifier) && /(^|,)\s*serial_number\s*(,|$)/.test(String(e.attributes)))
          ? ids.map((i) => i.name).join(', ') : null;
      };
      for (const c of cis.filter((x) => inClasses(x, opt.physicalClasses) && !virtual.has(x.sys_id))) {
        if (!missing(c.serial_number, opt)) continue;
        const placeholder = !empty(c.serial_number);
        const consumer = serialRule(c);
        perRecord('CMDB-012', c, ['serial_number', 'sys_class_name', 'name'],
          `${placeholder ? `Serial number "${c.serial_number}" is a placeholder` : 'Serial number is empty'} on ${c.sys_class_name} "${c.name || c.sys_id}".`
          + (consumer ? ` The identification rule "${consumer}" consumes serial_number, so IRE cannot recognise this device by it.` : ''),
          {
            confidence: placeholder ? 0.95 : 1.0,
            guard: { evaluated: true, note: 'Scoped to physical hardware classes; virtual computers (cmdb_ci_computer.virtual=true) are excluded.' },
          });
      }
    }
  }

  /* ── CMDB-013 — FQDN, IP and MAC all missing on network-addressable classes ─ */
  if (needCis('CMDB-013', ['fqdn', 'ip_address', 'mac_address', 'sys_class_name']) && needHierarchy('CMDB-013')) {
    const emAvailable = ['complete', 'limited', 'truncated'].includes(ctx.coverage.em_alert?.status);
    for (const c of cis.filter((x) => inClasses(x, opt.networkClasses))) {
      if (!(missing(c.fqdn, opt) && missing(c.ip_address, opt) && missing(c.mac_address, opt))) continue;
      perRecord('CMDB-013', c, ['fqdn', 'ip_address', 'mac_address', 'sys_class_name', 'name'],
        `${c.sys_class_name} "${c.name || c.sys_id}" has no FQDN, IP address or MAC address, so alerts cannot bind to it and discovery cannot reconcile it.`
        + (emAvailable ? '' : ' Alert-binding evidence is unavailable: Event Management is not active on this instance.'),
        { guard: { evaluated: true, note: `Class scope is limited to ${opt.networkClasses.join(', ')} and their subclasses.` } });
    }
  }

  /* ── Required and recommended attributes (CMDB-014, 017, 019) ─────────── */
  const principals = new Set((ctx.estate.cmdb_class_info || []).filter((r) => truthy(r.principal_class)).map((r) => r.class));
  const populated = [...new Set(cis.map((c) => c.sys_class_name).filter(Boolean))];
  const principalSet = principals.size ? populated.filter((c) => principals.has(c)) : populated;
  const fallbackNote = principals.size ? '' : ' Evaluated over every populated class, because no principal classes are designated (CMDB-139).';
  const recommended = (ctx.estate.cmdb_recommended_fields || []).filter((r) => truthy(r.active));
  const requiredFor = (cls, kind) => {
    const l = lineageOf(meta, cls);
    const attrs = kind === 'mandatory'
      ? l.flatMap((t) => meta.mandatory?.[t] || [])
      : recommended.filter((r) => l.includes(r.table)).map((r) => r.recommended);
    return [...new Set(attrs.filter(Boolean))];
  };
  const identityAttrs = new Set((ctx.estate.cmdb_identifier_entry || []).flatMap((e) => String(e.attributes || '').split(',').map((x) => x.trim())).filter(Boolean));
  const valueOf = (c, attr) => (attr in c ? c[attr] : meta.classAttrs?.[c.sys_class_name]?.values?.[c.sys_id]?.[attr]);
  const returnedFor = (c, attr) => attr in c || (meta.classAttrs?.[c.sys_class_name]?.returned || []).includes(attr);

  const attributeRule = (rule, kind, severityNote) => {
    if (!needCis(rule, ['sys_class_name']) || !needHierarchy(rule)) return;
    if (kind === 'mandatory' && !readOk('mandatory_fields')) return skip(rule, 'sys_dictionary', `Mandatory flags could not be read: ${readWhy('mandatory_fields')}`);
    if (kind === 'recommended' && !ctx.complete('cmdb_recommended_fields', ['table', 'recommended', 'active'])) return skip(rule, 'cmdb_recommended_fields', 'cmdb_recommended_fields was not read completely');
    const classes = principalSet.filter((cls) => requiredFor(cls, kind).length);
    if (!classes.length) {
      return skip(rule, kind === 'mandatory' ? 'sys_dictionary' : 'cmdb_recommended_fields',
        `No ${kind === 'mandatory' ? 'mandatory' : 'recommended'} attribute is defined on any ${principals.size ? 'principal' : 'populated'} class (see CMDB-006), so there is nothing to be missing.`);
    }
    if (!readOk('class_attrs')) return skip(rule, 'cmdb_ci', `Class attribute values could not be read: ${readWhy('class_attrs')}`);
    for (const cls of classes) {
      const attrs = requiredFor(cls, kind);
      for (const c of cis.filter((x) => x.sys_class_name === cls)) {
        const known = attrs.filter((a) => returnedFor(c, a));
        const gaps = known.filter((a) => missing(valueOf(c, a), opt));
        if (!gaps.length) continue;
        const weight = (a) => (identityAttrs.has(a) ? 3 : 1);
        const total = known.reduce((n, a) => n + weight(a), 0);
        const populatedW = known.filter((a) => !gaps.includes(a)).reduce((n, a) => n + weight(a), 0);
        perRecord(rule, c, ['sys_class_name', 'name'],
          `${cls} "${c.name || c.sys_id}" is missing ${severityNote}: ${gaps.join(', ')}.${fallbackNote}`,
          { confidence: total ? Number((populatedW / total).toFixed(2)) : 1, evidence: gaps.map((a) => fact(cls, a, valueOf(c, a) ?? '(empty)', `${kind} attribute`)) });
      }
    }
  };
  attributeRule('CMDB-014', 'mandatory', 'mandatory attribute(s)');
  attributeRule('CMDB-019', 'recommended', 'recommended attribute(s)');

  /* CMDB-017 — placeholders in any required attribute (mandatory or recommended). */
  if (needCis('CMDB-017', ['sys_class_name']) && needHierarchy('CMDB-017')) {
    const classes = principalSet.filter((cls) => requiredFor(cls, 'mandatory').length + requiredFor(cls, 'recommended').length);
    if (!classes.length) {
      skip('CMDB-017', 'cmdb_recommended_fields', 'No required attribute is defined on any class (see CMDB-006), so a placeholder cannot be told from a legitimately unused field.');
    } else if (!readOk('class_attrs')) {
      skip('CMDB-017', 'cmdb_ci', `Class attribute values could not be read: ${readWhy('class_attrs')}`);
    } else {
      for (const cls of classes) {
        const attrs = [...new Set([...requiredFor(cls, 'mandatory'), ...requiredFor(cls, 'recommended')])];
        for (const c of cis.filter((x) => x.sys_class_name === cls)) {
          const hits = attrs.filter((a) => returnedFor(c, a) && isPlaceholder(valueOf(c, a), opt));
          if (!hits.length) continue;
          perRecord('CMDB-017', c, ['sys_class_name', 'name'],
            `${cls} "${c.name || c.sys_id}" holds placeholder values in required attributes: ${hits.map((a) => `${a}="${valueOf(c, a)}"`).join(', ')}. They read as populated to every completeness metric.${fallbackNote}`,
            { confidence: 0.95, evidence: hits.map((a) => fact(cls, a, valueOf(c, a), 'placeholder value')) });
        }
      }
    }
  }

  /* ── CMDB-015 — business criticality missing on services that feed impact ─ */
  if (!ctx.complete('cmdb_ci_service', ['busines_criticality'])) {
    skip('CMDB-015', 'cmdb_ci_service', 'cmdb_ci_service.busines_criticality was not read completely (on this version business criticality exists on services, not on cmdb_ci)');
  } else if (!ctx.complete('cmdb_rel_ci', ['parent', 'child'])) {
    skip('CMDB-015', 'cmdb_rel_ci', 'Relationships were not read completely, so which services feed impact analysis is unknown');
  } else {
    const linked = new Set();
    for (const r of ctx.estate.cmdb_rel_ci || []) { linked.add(r.parent); linked.add(r.child); }
    for (const a of ctx.complete('svc_ci_assoc') ? ctx.estate.svc_ci_assoc || [] : []) linked.add(a.service);
    for (const svc of (ctx.estate.cmdb_ci_service || []).filter((x) => empty(x.busines_criticality) && linked.has(x.sys_id))) {
      const m = modifiersFor([svc], signals);
      ctx.addCatalogued('CMDB-015', 'cmdb_ci_service', [svc], ['busines_criticality', 'name'],
        `Service "${svc.name || svc.sys_id}" takes part in the dependency map but has no business criticality, so impact analysis can find it but cannot rank it.`,
        { agent: 'cmdb_agent', escalators: m.escalators, deEscalators: m.deEscalators, notEvaluated: m.notEvaluated,
          guard: { evaluated: false, note: 'Non-production services where criticality is intentionally unset are not yet told apart.' } });
    }
  }

  /* ── CMDB-016 — used_for empty where the class defines it ─────────────── */
  if (!readOk('used_for')) {
    skip('CMDB-016', 'cmdb_ci', `used_for could not be read per class: ${readWhy('used_for')}`);
  } else {
    const byId = new Map(cis.map((c) => [c.sys_id, c]));
    for (const [id, value] of Object.entries(meta.usedFor || {})) {
      if (!empty(value)) continue;
      const c = byId.get(id);
      if (!c) continue;
      perRecord('CMDB-016', c, ['sys_class_name', 'name'],
        `${c.sys_class_name} "${c.name || id}" defines used_for but it is empty, so production and non-production are indistinguishable for change risk, SLA and impact.`,
        { guard: { evaluated: true, note: `Only classes that define used_for are evaluated (${(meta.usedForClasses || []).length} populated classes).` } });
    }
  }

  /* ── CMDB-018 — company empty where more than one company is in use ────── */
  if (needCis('CMDB-018', ['company'])) {
    const used = new Map();
    for (const c of cis) if (!empty(c.company)) used.set(c.company, (used.get(c.company) || 0) + 1);
    if (used.size < 2) {
      skip('CMDB-018', 'cmdb_ci', `Only ${used.size} company is used on CIs, so this is not a multi-company estate. (core_company has no active field; company records are not companies in use.)`);
    } else {
      const names = new Map((ctx.estate.core_company || []).map((co) => [co.sys_id, co.name]));
      const unused = (ctx.estate.core_company || []).filter((co) => !used.has(co.sys_id)).length;
      for (const c of cis.filter((x) => empty(x.company))) {
        perRecord('CMDB-018', c, ['company', 'sys_class_name', 'name'],
          `${c.sys_class_name} "${c.name || c.sys_id}" has no company on an estate where ${used.size} companies own CIs.`,
          { guard: { evaluated: true, note: `Multi-company is judged by companies in use on CIs (${used.size}), not by the ${names.size} company records (${unused} own no CI).` } });
      }
    }
  }

  /* ── CMDB-020 — location empty, or a catch-all above the minimum depth ─── */
  if (needCis('CMDB-020', ['location', 'sys_class_name']) && needHierarchy('CMDB-020')) {
    const locComplete = ctx.complete('cmn_location', ['parent']);
    const parent = new Map((ctx.estate.cmn_location || []).map((l) => [l.sys_id, l.parent || null]));
    const nameOf = new Map((ctx.estate.cmn_location || []).map((l) => [l.sys_id, l.name]));
    const depth = (id) => { let d = 0; let at = id; const seen = new Set(); while (at && !seen.has(at) && parent.has(at)) { seen.add(at); d += 1; at = parent.get(at); } return d; };
    for (const c of cis.filter((x) => inClasses(x, opt.physicalClasses))) {
      if (empty(c.location)) {
        perRecord('CMDB-020', c, ['location', 'sys_class_name', 'name'], `${c.sys_class_name} "${c.name || c.sys_id}" has no location.`,
          { guard: { evaluated: true, note: 'Scoped to physical classes: software, services and cloud resources have no physical location by nature.' } });
      } else if (locComplete && depth(c.location) < opt.locationMinDepth) {
        perRecord('CMDB-020', c, ['location', 'sys_class_name', 'name'],
          `${c.sys_class_name} "${c.name || c.sys_id}" points at "${nameOf.get(c.location) || c.location}", depth ${depth(c.location)} — a catch-all above the minimum depth of ${opt.locationMinDepth}.`,
          { confidence: 0.85, guard: { evaluated: true, note: 'Depth is a proxy for specificity; scoped to physical classes.' } });
      }
    }
    if (!locComplete) skip('CMDB-020', 'cmn_location', 'cmn_location was not read completely, so only empty locations were evaluated — catch-all detection was not');
  }

  /* ── CMDB-021 — choice fields at an unchanged default (a KPI, never per record) ─ */
  if (!readOk('choice_audit')) {
    skip('CMDB-021', 'sys_audit', `Choice defaults and audit history could not be read: ${readWhy('choice_audit')}`);
  } else if (!meta.choiceAudit.audited) {
    skip('CMDB-021', 'sys_audit', 'cmdb_ci is not audited on this instance (collection audit=false), so "no audit entry for the field" proves nothing — the rule cannot be evaluated');
  } else if (needCis('CMDB-021', ['install_status', 'operational_status', 'sys_class_name'])) {
    const fields = Object.entries(meta.choiceAudit.defaults || {});
    let atDefault = 0;
    let checked = 0;
    const byClass = new Map();
    for (const [field, def] of fields) {
      const changed = new Set(meta.choiceAudit.changed?.[field] || []);
      for (const c of cis) {
        checked += 1;
        const hit = String(c[field]) === String(def) && !changed.has(c.sys_id);
        if (hit) atDefault += 1;
        const k = byClass.get(c.sys_class_name) || { hit: 0, n: 0 };
        k.n += 1; if (hit) k.hit += 1;
        byClass.set(c.sys_class_name, k);
      }
    }
    if (checked) {
      const passPct = 100 * (1 - atDefault / checked);
      ctx.kpis.push({ rule_id: 'CMDB-021', pass_pct: passPct, numerator: checked - atDefault, denominator: checked, basis: `${fields.map(([f]) => f).join(', ')} not at an unchanged default` });
      const heavy = [...byClass.entries()].map(([cls, k]) => [cls, (100 * k.hit) / k.n, k.n]).filter(([, r, n]) => n >= 5 && r >= opt.defaultChoiceRatio);
      if (heavy.length) {
        ctx.addCatalogued('CMDB-021', 'cmdb_ci', [], ['install_status', 'operational_status'],
          `${heavy.length} class(es) have at least ${opt.defaultChoiceRatio}% of CIs at a never-changed default choice value — a sign the fields were never considered.`,
          { agent: 'cmdb_agent', confidence: 0.7,
            evidence: heavy.slice(0, 25).map(([cls, r, n]) => fact('cmdb_ci', `${cls} at unchanged default`, `${r.toFixed(0)}% of ${n}`, 'class-level ratio')),
            guard: { evaluated: false, note: 'The default may be correct for most CIs in a class. Shown as a ratio, never per record.' } });
      }
    }
  }

  /* ── CMDB-022 — cost centre missing on financially relevant classes ───── */
  if (needCis('CMDB-022', ['cost_center', 'sys_class_name']) && needHierarchy('CMDB-022')) {
    const scope = cis.filter((x) => inClasses(x, opt.financialClasses));
    if (scope.length && !scope.some((c) => !empty(c.cost_center))) {
      skip('CMDB-022', 'cmdb_ci', `None of the ${scope.length} CIs in scope carries a cost centre, so the organisation may not allocate cost at CI level — the rule's guard says confirm before raising.`);
    } else {
      for (const c of scope.filter((x) => empty(x.cost_center))) {
        perRecord('CMDB-022', c, ['cost_center', 'sys_class_name', 'name'], `${c.sys_class_name} "${c.name || c.sys_id}" has no cost centre.`,
          { guard: { evaluated: true, note: 'Raised only because other CIs in scope do carry cost centres.' } });
      }
    }
  }

  /* ── CMDB-140 — no strong identification entry can match this CI ─────── */
  if (!ctx.complete('cmdb_identifier', ['applies_to', 'active']) || !ctx.complete('cmdb_identifier_entry', ['identifier', 'table', 'attributes', 'active'])) {
    skip('CMDB-140', 'cmdb_identifier', 'Identification rules were not read completely');
  } else if (needCis('CMDB-140', ['sys_class_name']) && needHierarchy('CMDB-140')) {
    if (!readOk('field_tables') || !readOk('class_attrs') || !readOk('identity_lookups')) {
      skip('CMDB-140', 'cmdb_identifier_entry', `Identity attribute values could not be read: ${readWhy(!readOk('field_tables') ? 'field_tables' : !readOk('class_attrs') ? 'class_attrs' : 'identity_lookups')}`);
    } else {
      const identifiers = (ctx.estate.cmdb_identifier || []).filter((i) => truthy(i.active));
      const entries = (ctx.estate.cmdb_identifier_entry || []).filter((e) => truthy(e.active));
      const split = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
      const definedOn = (attr, l) => (meta.fieldTables?.[attr] || []).some((t) => l.includes(t));
      for (const c of cis) {
        const l = line(c);
        const ident = l.map((cls) => identifiers.find((i) => i.applies_to === cls)).find(Boolean);
        if (!ident) continue;
        const strong = entries.filter((e) => e.identifier === ident.sys_id && split(e.attributes).some((a) => !opt.descriptiveAttributes.includes(a)));
        if (!strong.length) continue;
        let unknown = false;
        const why = [];
        const satisfiable = strong.some((e) => {
          const attrs = split(e.attributes);
          const allowNull = truthy(e.allow_null_attribute);
          if (l.includes(e.table)) {
            const inapplicable = attrs.filter((a) => !definedOn(a, l));
            if (inapplicable.length) { why.push(`${attrs.join('+')}: not a field of this class`); return false; }
            const hidden = attrs.filter((a) => !returnedFor(c, a));
            if (hidden.length) { unknown = true; return false; }
            const gaps = attrs.filter((a) => missing(valueOf(c, a), opt));
            if (gaps.length && !allowNull) { why.push(`${attrs.join('+')}: ${gaps.join(', ')} empty`); return false; }
            return true;
          }
          const lookup = meta.lookups?.[e.table];
          if (!lookup || lookup.status !== 'ok') { unknown = true; return false; }
          const rows = lookup.byCi?.[c.sys_id] || [];
          const ok = rows.some((r) => attrs.every((a) => allowNull || !missing(r[a], opt)));
          if (!ok) why.push(`${e.table} (${attrs.join('+')}): no matching row`);
          return ok;
        });
        if (satisfiable || unknown) continue;
        perRecord('CMDB-140', c, ['sys_class_name', 'name'],
          `${c.sys_class_name} "${c.name || c.sys_id}" cannot satisfy any strong entry of its identification rule "${ident.name}", so IRE can recognise it only by name — or not at all. ${why.join('; ')}.`,
          { guard: { evaluated: true, note: 'Lookup-table entries (serial numbers, network adapters) were checked for a referencing row before flagging; a CI with an unreadable attribute is left unflagged.' } });
      }
    }
  }

  /* ── CMDB-141 — impact analysis returning no affected services (KPI + gate) ─ */
  if (!ctx.complete('change_request', ['cmdb_ci'])) {
    skip('CMDB-141', 'change_request', 'Changes were not read completely, so the impact-analysis rate cannot be computed');
  } else if (!readOk('change_impact')) {
    skip('CMDB-141', 'task_cmdb_ci_service', `Impacted services could not be read: ${readWhy('change_impact')}`);
  } else {
    /* Decision 2 of 17 Sep: only changes whose CI SHOULD resolve to a service count —
       associated in svc_ci_assoc, reachable downward from a service, or a service
       with business criticality set. A standalone CI is not held against the rate. */
    const named = (ctx.estate.change_request || []).filter((c) => !empty(c.cmdb_ci));
    const bound = signals?.serviceBound;
    const changes = bound ? named.filter((c) => bound.has(c.cmdb_ci)) : [];
    const excluded = named.length - changes.length;
    const withImpact = new Set(meta.changeImpact?.withImpact || []);
    const alertsHalf = ['complete', 'limited', 'truncated'].includes(ctx.coverage.em_alert?.status)
      ? 'Event Management is present, but the alert half is not built until its impacted-service table is confirmed on an ITOM-activated instance.'
      : 'Alert half not evaluated: Event Management is not active on this instance.';
    if (!bound) {
      skip('CMDB-141', 'cmdb_rel_ci', 'Services and relationships were not read completely, so which changes should resolve to a service is unknown — no denominator is guessed');
    } else if (!changes.length) {
      skip('CMDB-141', 'change_request', `None of the ${named.length} changes naming a CI names one that should resolve to a service, so there is no denominator. ${alertsHalf}`);
    } else {
      const hit = changes.filter((c) => withImpact.has(c.sys_id));
      const passPct = (100 * hit.length) / changes.length;
      ctx.kpis.push({
        rule_id: 'CMDB-141', pass_pct: passPct, numerator: hit.length, denominator: changes.length,
        basis: `service-bound changes whose impacted-services calculation is non-empty (${excluded} change(s) naming a standalone CI not counted)`,
        alerts: alertsHalf,
      });
      if (passPct < opt.impactThresholdPct) {
        const miss = changes.filter((c) => !withImpact.has(c.sys_id));
        ctx.addCatalogued('CMDB-141', 'change_request', miss, ['number', 'cmdb_ci'],
          `Impact analysis returns affected services for ${hit.length} of ${changes.length} changes whose CI should resolve to a service (${passPct.toFixed(1)}%), below the ${opt.impactThresholdPct}% threshold; ${excluded} change(s) naming a standalone CI were not counted. ${alertsHalf}`,
          { agent: 'cmdb_agent',
            evidence: [fact('task_cmdb_ci_service', 'changes with impacted services', `${hit.length} of ${changes.length}`, 'numerator / denominator')],
            guard: { evaluated: false, note: 'An empty impacted-services list cannot distinguish "calculated and found nothing" from "never calculated" — confirm the calculation runs for changes.' } });
      }
    }
  }
}
