import { modifiersFor, lineageOf, dqActive, DQ_INACTIVE_INSTALL_STATUS } from './cmdb-signals.js';
import { parseDate } from './rules.js';

/**
 * GROUP 5 — IDENTIFICATION AND RECONCILIATION (D4, D5). CMDB-044 to CMDB-055.
 *
 * D4 asks whether the Identification and Reconciliation Engine can tell two CIs
 * apart; D5 asks whether, once it has, the right source wins the argument about
 * each attribute. They are the causes of Group 4: a name-only identifier or a
 * bypassed IRE is why duplicates exist at all.
 *
 * WHAT THIS INSTANCE ACTUALLY KEEPS (verified on dev424910, 19 Sep 2026):
 *
 *   cmdb_identifier / cmdb_identifier_entry   409 / 471 rows — real data
 *   cmdb_metadata_hosting / _containment      88 / 145 rows — which classes are
 *                                             dependent BY DESIGN (CMDB-047's guard)
 *   sys_object_source                         exists, 0 rows — per-CI source
 *                                             attribution, the only trace of IRE
 *   cmdb_datasource_precedence                exists, 0 rows
 *   cmdb_datasource_last_update               exists, 0 rows — per-source last write
 *   cmdb_datasource_staleness                 exists, 0 rows — per-source thresholds
 *   cmdb_ire_output_aggregate_stats           exists, 0 rows — per-run IRE counters
 *   cmdb_reconciliation_definition            0 rows
 *   `cmdb_ire_error` DOES NOT EXIST under that name on this version.
 *
 * ═══ THE INFERENCE THIS GROUP RESTS ON, SAID OUT LOUD ═══
 *
 * ServiceNow keeps no per-CI "processed by IRE" flag. CMDB-046 and CMDB-050
 * infer a bypass from the ABSENCE of a `sys_object_source` row for a CI. That is
 * sound only while the instance writes those rows at all — so when the table is
 * empty for every CI, the rules SKIP rather than report a 100% bypass rate. "We
 * cannot see the machinery" and "the machinery is not running" are different
 * facts, and the second is far too expensive to guess at.
 *
 * PURE — no network, no database.
 */

export const IDENTIFICATION_RULES = Object.freeze([
  'CMDB-044', 'CMDB-045', 'CMDB-046', 'CMDB-047', 'CMDB-048', 'CMDB-049',
  'CMDB-050', 'CMDB-051', 'CMDB-052', 'CMDB-053', 'CMDB-054', 'CMDB-055',
]);

export const IDENTIFICATION_DEFAULTS = Object.freeze({
  /* Data-quality dimensions: the lifecycle dimension owns retired CIs. */
  dqInactiveInstallStatus: DQ_INACTIVE_INSTALL_STATUS,
  /*
   * Attribute strength (CMDB-044, CMDB-054). An IDENTITY attribute is one a
   * device carries with it; a DESCRIPTIVE one is a label somebody typed. The
   * classification is configuration because it is a judgement — the catalogue
   * says so, and CMDB-054's confidence is 90% for that reason.
   */
  identityAttributes: Object.freeze(['serial_number', 'ip_address', 'mac_address', 'fqdn', 'correlation_id',
    'asset_tag', 'object_id', 'uuid', 'bios_uuid', 'host_name', 'dns_domain', 'model_id']),
  /*
   * STRUCTURAL attributes — where a thing LIVES rather than what it is called.
   * A WAR file has no serial; "this host + this install directory" is its
   * identity, and the OOB Tomcat identifier is right to use it. Counted as
   * identity for CMDB-044 and CMDB-054. Measured on dev424910, these are the
   * criteria the shipped identifiers actually use: sys_class_name 140, name 139,
   * host 97, object_id 83, ip_address 83, host_name 76, port 58, container 31,
   * install_directory 24. Raised for confirmation on 19 Sep.
   */
  structuralAttributes: Object.freeze(['host', 'container', 'install_directory', 'directory', 'config_file', 'path',
    'port', 'tcp_port', 'url', 'sid', 'instance', 'instance_name', 'instance_number', 'server_name', 'farm',
    'cluster_id', 'queue', 'cim_object_path', 'zone', 'partition']),
  descriptiveAttributes: Object.freeze(['name', 'display_name', 'short_description', 'label', 'comments', 'location', 'company', 'manufacturer']),
  ireBypassThresholdPct: 20,        // CMDB-046 — catalogue default
  ireBypassEscalatePct: 40,         // above this the finding escalates
  creationWindowDays: 90,           // the window CMDB-046/050 measure over
  deadSourceDays: 30,               // CMDB-049 — catalogue default, per-source overrides honoured
  ireErrorPerCreatePct: 5,          // CMDB-053 — errors as a share of creates in the window
  minTrendRuns: 3,                  // CMDB-053 — a trend needs runs to be a trend
});

const empty = (v) => v == null || String(v).trim() === '';
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const splitAttrs = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
const DAY_MS = 86_400_000;

export function cmdbIdentificationRules(ctx, options = {}) {
  const opt = { ...IDENTIFICATION_DEFAULTS, ...options };
  const now = ctx.now;
  const meta = ctx.meta?.cmdb || {};
  const signals = ctx.signals;
  const skip = (rule, table, reason) => ctx.skipped.push({ rule, table, reason });
  const hierarchyOk = meta.reads?.class_hierarchy?.status === 'ok';
  const line = (cls) => lineageOf(meta, cls || 'cmdb_ci');
  const { active: cis } = dqActive(ctx.estate.cmdb_ci || [], opt.dqInactiveInstallStatus);
  const byId = new Map(cis.map((c) => [c.sys_id, c]));
  const fact = (table, field, value, reason) => ({
    source: 'ServiceNow Table/Aggregate REST API', sn_table: table, sn_sys_id: null,
    field_name: field, field_value: String(value), reason, collected_at: now.toISOString(),
  });
  /** A finding about CONFIGURATION: it names config records, so it charges no CI. */
  const configFinding = (rule, table, records, fields, description, extra = {}) => {
    const f = ctx.addCatalogued(rule, table, records, fields, description, { agent: 'cmdb_governance_agent', ...extra });
    /*
     * A configuration defect names config records, so it deducts from no CI.
     * Charging every CI a bad identifier governs would zero whole classes for
     * one misconfigured row — the damage those CIs actually carry is what the
     * duplicate and completeness rules charge them for. Raised as a decision
     * point on 19 Sep; this is the conservative default.
     */
    f.unscored_reason = `names ${table} records, not CIs — the defect is configuration, and the CIs it puts at risk are charged by the rules that catch the damage`;
    return f;
  };
  const perRecord = (rule, records, fields, description, extra = {}) => {
    const m = modifiersFor(records, signals);
    return ctx.addCatalogued(rule, 'cmdb_ci', records, fields, description, {
      agent: 'cmdb_agent', escalators: m.escalators, deEscalators: m.deEscalators, notEvaluated: m.notEvaluated, ...extra,
    });
  };

  /* ════════ D4 — identification ════════ */

  const identifiersOk = ctx.complete('cmdb_identifier', ['name', 'applies_to', 'active', 'independent'])
    && ctx.complete('cmdb_identifier_entry', ['identifier', 'attributes', 'order', 'active']);
  const identifiers = (ctx.estate.cmdb_identifier || []).filter((i) => truthy(i.active));
  const entries = (ctx.estate.cmdb_identifier_entry || []).filter((e) => truthy(e.active));
  const entriesOf = (id) => entries.filter((e) => e.identifier === id.sys_id).sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const isIdentity = (a) => opt.identityAttributes.includes(a) || opt.structuralAttributes.includes(a);
  const isDescriptive = (a) => opt.descriptiveAttributes.includes(a);
  const ciCountIn = (cls) => cis.filter((c) => (hierarchyOk ? line(c.sys_class_name).includes(cls) : c.sys_class_name === cls)).length;
  /*
   * IS THE RULE IN FORCE? An identification rule for a class this instance has
   * never populated governs nothing and creates no duplicate today. Measured on
   * dev424910: 96 of 409 active identifiers match by name alone, but only TWO of
   * those govern any CI; 252 are dependent-only, and only five do. Reporting the
   * other 341 as Systemic and Critical findings would bury the seven that matter
   * under the shipped catalogue. They are counted instead, and become findings
   * the day somebody populates the class.
   */
  const inForceCount = new Map();
  const inForce = (id) => {
    if (!inForceCount.has(id.applies_to)) inForceCount.set(id.applies_to, ciCountIn(id.applies_to));
    return inForceCount.get(id.applies_to) > 0;
  };
  const dormant = { 'CMDB-044': 0, 'CMDB-047': 0, 'CMDB-054': 0 };

  if (!identifiersOk) {
    for (const r of ['CMDB-044', 'CMDB-045', 'CMDB-047', 'CMDB-054']) {
      skip(r, 'cmdb_identifier', 'The identification rules and their entries were not read completely, so the configuration cannot be judged');
    }
  } else {
    /* ── CMDB-044 — identification by name alone ──────────────────────────── */
    for (const id of identifiers) {
      const attrs = [...new Set(entriesOf(id).flatMap((e) => splitAttrs(e.attributes)))];
      if (!attrs.length) continue;
      if (attrs.some(isIdentity)) continue;
      if (!attrs.some(isDescriptive)) continue;          // unknown attributes: not judged
      if (!inForce(id)) { dormant['CMDB-044'] += 1; continue; }
      configFinding('CMDB-044', 'cmdb_identifier', [id], ['name', 'applies_to', 'independent'],
        `Identification rule "${id.name}" matches ${id.applies_to} on ${attrs.join(', ')} alone — no serial, address or external key among them. Two devices with the same name are one CI to IRE, and one device renamed is a new CI. ${ciCountIn(id.applies_to).toLocaleString('en-US')} CI(s) are governed by it.`,
        { evidence: [fact('cmdb_identifier_entry', 'attributes', attrs.join(', '), 'every criterion this rule matches on')],
          guard: { evaluated: false, note: 'Not machine-checkable: some logical CI types genuinely have no stronger attribute. Confirm no identity attribute is available on this class before accepting the finding.' } });
    }

    /* ── CMDB-045 — a class nothing identifies ────────────────────────────── */
    const principals = new Set((ctx.estate.cmdb_class_info || []).filter((r) => truthy(r.principal_class)).map((r) => r.class));
    const populated = [...new Set(cis.map((c) => c.sys_class_name).filter(Boolean))];
    const scope = principals.size ? populated.filter((c) => principals.has(c)) : populated;
    const fallbackNote = principals.size ? '' : ' Evaluated over every populated class, because no principal classes are designated (CMDB-139).';
    if (!hierarchyOk) {
      skip('CMDB-045', 'sys_db_object', 'The class hierarchy could not be read, so an identifier inherited from a parent class cannot be resolved — reporting uncovered classes without it would be false at scale');
    } else {
      const covers = (cls) => identifiers.some((i) => line(cls).includes(i.applies_to) && entriesOf(i).length);
      const uncovered = scope.filter((cls) => !covers(cls));
      for (const cls of uncovered) {
        configFinding('CMDB-045', 'cmdb_class_info', [], ['class'],
          `${cls} has no identification rule, its own or inherited — IRE cannot recognise a CI of this class it has seen before, so every import creates another one. ${ciCountIn(cls).toLocaleString('en-US')} CI(s) are in it.${fallbackNote}`,
          { evidence: [fact('cmdb_identifier', 'applies_to chain', line(cls).join(' → '), 'the lineage searched for an applicable rule')],
            guard: { evaluated: true, note: 'Inheritance resolved through the class hierarchy: a rule on any ancestor counts as coverage.' } });
      }
      if (!uncovered.length && scope.length) skip('CMDB-045', 'cmdb_identifier', `Every one of the ${scope.length} class(es) in scope resolves to an identification rule, its own or an ancestor's`);
    }

    /* ── CMDB-047 — no independent criterion ──────────────────────────────── */
    const dependentByDesign = new Set([
      ...(ctx.estate.cmdb_metadata_hosting || []).map((r) => r.child_type),
      ...(ctx.estate.cmdb_metadata_containment || []).map((r) => r.ci_type),
    ].filter(Boolean));
    const metadataOk = ctx.complete('cmdb_metadata_hosting', ['child_type']) && ctx.complete('cmdb_metadata_containment', ['ci_type']);
    for (const id of identifiers) {
      if (truthy(id.independent)) continue;
      if (!entriesOf(id).length) continue;
      const dependent = hierarchyOk ? line(id.applies_to).some((t) => dependentByDesign.has(t)) : dependentByDesign.has(id.applies_to);
      if (metadataOk && dependent) continue;
      if (!inForce(id)) { dormant['CMDB-047'] += 1; continue; }
      configFinding('CMDB-047', 'cmdb_identifier', [id], ['name', 'applies_to', 'independent'],
        `Identification rule "${id.name}" for ${id.applies_to} has no independent criterion: every match depends on a related CI being identified first. If the parent is missing or wrong, this CI cannot be identified at all and a duplicate is created instead.`,
        { evidence: [fact('cmdb_identifier', 'independent', 'false', 'the rule identifies only in the context of another CI')],
          guard: { evaluated: metadataOk, note: metadataOk
            ? 'Classes that are dependent BY DESIGN — hosted or contained per cmdb_metadata_hosting / cmdb_metadata_containment — are excluded.'
            : 'The hosting and containment metadata could not be read, so genuinely dependent classes (a disk inside a server) could not be excluded. Treat with that in mind.' } });
    }

    /* ── CMDB-054 — weak criteria evaluated before strong ones ────────────── */
    for (const id of identifiers) {
      const ordered = entriesOf(id);
      if (ordered.length < 2) continue;
      if (!inForce(id)) { dormant['CMDB-054'] += 1; continue; }
      const strength = ordered.map((e) => {
        const attrs = splitAttrs(e.attributes);
        return { entry: e, attrs, identity: attrs.some(isIdentity), descriptive: attrs.every(isDescriptive) && attrs.length > 0 };
      });
      const firstIdentity = strength.findIndex((x) => x.identity);
      const weakBefore = strength.slice(0, firstIdentity < 0 ? 0 : firstIdentity).filter((x) => x.descriptive);
      if (!weakBefore.length) continue;
      configFinding('CMDB-054', 'cmdb_identifier', [id], ['name', 'applies_to'],
        `Identification rule "${id.name}" evaluates ${weakBefore.map((x) => x.attrs.join('+')).join(', ')} (order ${weakBefore.map((x) => x.entry.order).join(', ')}) before ${strength[firstIdentity].attrs.join('+')} (order ${strength[firstIdentity].entry.order}). A weak criterion that matches first wins, and the strong one is never consulted — which merges two different CIs rather than splitting one.`,
        { confidence: 0.9,
          evidence: [fact('cmdb_identifier_entry', 'order', ordered.map((e) => `${e.order}:${e.attributes}`).join(' | '), 'entry order as IRE evaluates it')],
          guard: { evaluated: false, note: 'Attribute strength is a classification held in configuration, not a fact read from the instance. A class where the descriptive criterion is genuinely reliable is a false positive here.' } });
    }
  }

  if (identifiersOk) {
    for (const [rule, n] of Object.entries(dormant)) {
      if (n) {
        skip(rule, 'cmdb_identifier', `${n} identification rule(s) with this defect govern a class holding no CI on this instance — shipped configuration that is not in force, so it creates no duplicate today. Counted, not reported: it becomes a finding the day that class is populated.`);
      }
    }
    ctx.measures.identification_rules = {
      active: identifiers.length,
      in_force: identifiers.filter((id) => entriesOf(id).length && inForce(id)).length,
      dormant_with_defects: Object.values(dormant).reduce((a, b) => a + b, 0),
      basis: 'active cmdb_identifier rows with at least one entry; "in force" means the class it applies to holds at least one CI',
    };
  }

  /* ── CMDB-046 / CMDB-050 — CI creates that bypassed IRE ───────────────── */
  const sourceRowsOk = ctx.complete('sys_object_source', ['target_sys_id', 'name', 'target_table']);
  const sourceRows = ctx.estate.sys_object_source || [];
  const attributed = new Set(sourceRows.map((r) => r.target_sys_id).filter(Boolean));
  const since = new Date(now.getTime() - opt.creationWindowDays * DAY_MS);
  const created = cis.filter((c) => {
    const d = parseDate(c.sys_created_on);
    return d && d >= since;
  });
  const bypassReadable = sourceRowsOk && attributed.size > 0;
  if (!ctx.complete('cmdb_ci', ['sys_created_on'])) {
    for (const r of ['CMDB-046', 'CMDB-050']) skip(r, 'cmdb_ci', 'cmdb_ci did not return sys_created_on, so the creation window cannot be measured');
  } else if (!sourceRowsOk) {
    for (const r of ['CMDB-046', 'CMDB-050']) skip(r, 'sys_object_source', 'The per-CI source attribution table was not read completely, so an IRE bypass cannot be told from a gap in our own reading');
  } else if (!bypassReadable) {
    for (const r of ['CMDB-046', 'CMDB-050']) {
      skip(r, 'sys_object_source', `sys_object_source holds no rows at all on this instance, so no CI can be attributed to a source. "Every create bypassed IRE" and "this instance does not record source attribution" look identical here, and the second is the likelier — ${created.length.toLocaleString('en-US')} CI(s) created in the last ${opt.creationWindowDays} days were left unjudged rather than reported as a 100% bypass rate.`);
    }
  } else if (!created.length) {
    for (const r of ['CMDB-046', 'CMDB-050']) skip(r, 'cmdb_ci', `No CI was created in the last ${opt.creationWindowDays} days, so there is no denominator for the bypass rate`);
  } else {
    const bypassed = created.filter((c) => !attributed.has(c.sys_id));
    const pct = (100 * bypassed.length) / created.length;
    const bySource = {};
    for (const c of bypassed) {
      const key = c.discovery_source || c.sys_created_by || '(no source recorded)';
      bySource[key] = (bySource[key] || 0) + 1;
    }
    const ranked = Object.entries(bySource).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} (${n})`).join(', ');
    ctx.kpis.push({
      rule_id: 'CMDB-046',
      pass_pct: 100 - pct,
      numerator: created.length - bypassed.length,
      denominator: created.length,
      basis: `CI creates in the last ${opt.creationWindowDays} days with a sys_object_source row attributing them to a source`,
      alerts: `Bypass inferred from the ABSENCE of source attribution, not observed: ServiceNow records no per-CI "processed by IRE" flag.`,
    });
    if (pct > opt.ireBypassThresholdPct) {
      const escalators = pct > opt.ireBypassEscalatePct ? ['rule_threshold'] : [];
      ctx.addCatalogued('CMDB-046', 'cmdb_ci', [], ['sys_created_on', 'discovery_source'],
        `${bypassed.length.toLocaleString('en-US')} of ${created.length.toLocaleString('en-US')} CI creates in the last ${opt.creationWindowDays} days (${pct.toFixed(1)}%) carry no source attribution, which means they did not go through IRE — above the ${opt.ireBypassThresholdPct}% threshold${pct > opt.ireBypassEscalatePct ? `, and above the ${opt.ireBypassEscalatePct}% escalation point` : ''}. Ranked by what created them: ${ranked}. Every one of those creates skipped the matching that prevents duplicates.`,
        { agent: 'cmdb_governance_agent', escalators,
          evidence: [fact('sys_object_source', 'attributed creates', `${created.length - bypassed.length} of ${created.length}`, 'CIs with a source row')],
          guard: { evaluated: false, note: 'A documented bulk migration with IRE deliberately bypassed looks exactly like this. Check for a migration plan covering the window before acting.' } });
    }
    for (const c of bypassed) {
      perRecord('CMDB-050', [c], ['name', 'sys_class_name', 'sys_created_on', 'discovery_source'],
        `${c.sys_class_name} "${c.name || c.sys_id}" was created on ${c.sys_created_on} with no source attribution, so it did not pass through IRE — nothing checked whether the CI already existed under another record.`,
        { guard: { evaluated: false, note: 'Logical CIs that IRE does not govern are legitimate direct creates; confirm the class is IRE-governed before merging.' } });
    }
  }

  /* ── CMDB-053 — IRE error volume and trend ────────────────────────────── */
  if (!ctx.complete('cmdb_ire_output_aggregate_stats', ['errors', 'run_id'])) {
    skip('CMDB-053', 'cmdb_ire_output_aggregate_stats', 'The per-run IRE counters were not read completely (this version keeps no cmdb_ire_error table at all), so error volume cannot be counted');
  } else {
    const runs = (ctx.estate.cmdb_ire_output_aggregate_stats || []).filter((r) => parseDate(r.sys_created_on || r.sys_updated_on));
    const recent = runs.filter((r) => parseDate(r.sys_created_on || r.sys_updated_on) >= since);
    const errors = recent.reduce((n, r) => n + (Number(r.errors) || 0), 0);
    if (!runs.length) {
      skip('CMDB-053', 'cmdb_ire_output_aggregate_stats', 'No IRE run has recorded statistics on this instance, so there is no error volume to trend');
    } else if (recent.length < opt.minTrendRuns) {
      skip('CMDB-053', 'cmdb_ire_output_aggregate_stats', `Only ${recent.length} IRE run(s) in the last ${opt.creationWindowDays} days; a trend needs at least ${opt.minTrendRuns}`);
    } else if (errors > 0 && created.length && (100 * errors) / created.length > opt.ireErrorPerCreatePct) {
      const byCode = {};
      for (const r of recent) for (const code of splitAttrs(r.distinct_error_codes)) byCode[code] = (byCode[code] || 0) + 1;
      ctx.addCatalogued('CMDB-053', 'cmdb_ire_output_aggregate_stats', [], ['errors', 'run_id'],
        `IRE reported ${errors.toLocaleString('en-US')} error(s) across ${recent.length} run(s) in the last ${opt.creationWindowDays} days — ${((100 * errors) / created.length).toFixed(1)}% of the ${created.length.toLocaleString('en-US')} CI creates in the same window, above the ${opt.ireErrorPerCreatePct}% threshold. Error codes: ${Object.keys(byCode).join(', ') || 'not recorded per run'}. Every error is a payload IRE could not place, which becomes either a missing CI or a duplicate one.`,
        { agent: 'cmdb_governance_agent',
          evidence: [fact('cmdb_ire_output_aggregate_stats', 'errors in window', errors, `${recent.length} runs`)],
          guard: { evaluated: false, note: 'A one-time bulk load produces a spike that is not a trend. Compare against the window before treating it as ongoing.' } });
    }
  }

  /* ════════ D5 — reconciliation ════════ */

  const defsOk = ctx.complete('cmdb_reconciliation_definition', ['applies_to', 'attributes', 'discovery_source', 'priority', 'active']);
  const defs = (ctx.estate.cmdb_reconciliation_definition || []).filter((d) => truthy(d.active));
  const precedenceOk = ctx.complete('cmdb_datasource_precedence', ['discovery_source', 'applies_to', 'active', 'order']);
  const precedence = (ctx.estate.cmdb_datasource_precedence || []).filter((p) => truthy(p.active));
  const writesOk = ctx.complete('cmdb_datasource_attribute_value', ['ci', 'class', 'attribute', 'discovery_source']);
  const writes = ctx.estate.cmdb_datasource_attribute_value || [];

  /* Registered sources: the platform's own discovery_source choice list, plus
     anything a precedence row names, plus what CIs actually carry. */
  const registered = new Set([
    ...(meta.choices || []).filter((c) => c.element === 'discovery_source' && !truthy(c.inactive)).map((c) => c.value),
    ...precedence.map((p) => p.discovery_source),
    ...cis.map((c) => c.discovery_source),
  ].filter(Boolean));

  /* ── CMDB-048 — two sources claiming the same attribute at the same priority ── */
  if (!defsOk) {
    skip('CMDB-048', 'cmdb_reconciliation_definition', 'The reconciliation definitions were not read completely');
  } else if (!defs.length) {
    skip('CMDB-048', 'cmdb_reconciliation_definition', 'No active reconciliation definition exists on this instance, so no two sources can collide over an attribute — precedence is decided by nothing at all, which CMDB-055 reports');
  } else {
    const claims = new Map();                 // class|attribute|priority -> rows
    for (const d of defs) {
      for (const attr of splitAttrs(d.attributes)) {
        const key = `${d.applies_to}|${attr}|${d.priority ?? ''}`;
        if (!claims.has(key)) claims.set(key, []);
        claims.get(key).push(d);
      }
    }
    for (const [key, rows] of claims) {
      const sources = [...new Set(rows.map((r) => r.discovery_source).filter(Boolean))];
      if (sources.length < 2) continue;
      const [cls, attr, priority] = key.split('|');
      configFinding('CMDB-048', 'cmdb_reconciliation_definition', rows, ['name', 'applies_to', 'attributes', 'discovery_source', 'priority'],
        `${sources.join(' and ')} both claim ${attr} on ${cls} at priority ${priority || '(none set)'}. With no tie-break, whichever writes last wins, so the value flips between sources and every consumer sees whichever it happened to read.`,
        { evidence: [fact('cmdb_reconciliation_definition', 'competing sources', sources.join(', '), `attribute ${attr} on ${cls}`)],
          guard: { evaluated: false, note: 'Equal precedence with a documented tie-break elsewhere (a business rule, a transform) is deliberate. Check for one before changing the priorities.' } });
    }
  }

  /* ── CMDB-052 — reconciliation rules for a source nobody registered ───── */
  if (!defsOk) {
    skip('CMDB-052', 'cmdb_reconciliation_definition', 'The reconciliation definitions were not read completely');
  } else if (!defs.length) {
    skip('CMDB-052', 'cmdb_reconciliation_definition', 'No active reconciliation definition exists, so none can name an unregistered source');
  } else if (!registered.size) {
    skip('CMDB-052', 'sys_choice', 'No discovery source is registered anywhere on this instance, so "unregistered" cannot be established');
  } else {
    const unknown = new Map();
    for (const d of defs) {
      const src = String(d.discovery_source || '').trim();
      if (!src || registered.has(src)) continue;
      if (!unknown.has(src)) unknown.set(src, []);
      unknown.get(src).push(d);
    }
    for (const [src, rows] of unknown) {
      configFinding('CMDB-052', 'cmdb_reconciliation_definition', rows, ['name', 'applies_to', 'attributes', 'discovery_source'],
        `${rows.length} reconciliation rule(s) give precedence to "${src}", which is not a registered discovery source on this instance. The rules never match, so the precedence they describe is not in force — the attributes they cover are decided by whoever writes last.`,
        { evidence: [fact('sys_choice', 'registered sources', [...registered].slice(0, 12).join(', '), 'the sources this instance knows')],
          guard: { evaluated: true, note: 'Compared against the discovery_source choice list, the precedence rows and the sources CIs actually carry. A spelling difference is the same defect, framed differently.' } });
    }
  }

  /* ── CMDB-049 — a source that stopped reporting but still holds precedence ── */
  const lastUpdateOk = ctx.complete('cmdb_datasource_last_update', ['discovery_source', 'updated_on']);
  const staleness = (ctx.estate.cmdb_datasource_staleness || []).filter((r) => truthy(r.active));
  if (!precedenceOk && !defsOk) {
    skip('CMDB-049', 'cmdb_datasource_precedence', 'Neither the precedence rows nor the reconciliation definitions were read completely, so "still trusted" cannot be established');
  } else if (!precedence.length && !defs.length) {
    skip('CMDB-049', 'cmdb_datasource_precedence', 'No source holds active precedence on this instance, so none can be trusted after it went quiet');
  } else if (!lastUpdateOk) {
    skip('CMDB-049', 'cmdb_datasource_last_update', 'The per-source last-write table was not read completely, so a source\'s silence cannot be measured');
  } else {
    const lastSeen = new Map();
    for (const r of ctx.estate.cmdb_datasource_last_update || []) {
      const d = parseDate(r.updated_on || r.sys_updated_on);
      if (!d || !r.discovery_source) continue;
      if (!lastSeen.has(r.discovery_source) || lastSeen.get(r.discovery_source) < d) lastSeen.set(r.discovery_source, d);
    }
    const trusted = [...new Set([...precedence.map((p) => p.discovery_source), ...defs.map((d) => d.discovery_source)].filter(Boolean))];
    for (const src of trusted) {
      const own = staleness.find((r) => r.discovery_source === src);
      const days = own && Number(own.duration) ? Number(own.duration) : opt.deadSourceDays;
      const seen = lastSeen.get(src);
      if (!seen) {
        skip('CMDB-049', 'cmdb_datasource_last_update', `"${src}" holds precedence but has never written an attribute value this instance recorded — no last-seen date to measure, so it is reported by CMDB-052 as a registration question rather than a staleness one`);
        continue;
      }
      const age = Math.floor((now - seen) / DAY_MS);
      if (age <= days) continue;
      const blocked = defs.filter((d) => d.discovery_source === src).flatMap((d) => splitAttrs(d.attributes));
      configFinding('CMDB-049', 'cmdb_datasource_precedence', precedence.filter((p) => p.discovery_source === src), ['discovery_source', 'applies_to', 'order'],
        `"${src}" last wrote data ${age} days ago (threshold ${days}${own ? ', its own configured staleness window' : ''}) and still holds precedence for ${blocked.length ? [...new Set(blocked)].join(', ') : 'the attributes its rules cover'}. ServiceNow keeps trusting a source that is no longer reporting, so those attributes are frozen at whatever it last said and no live source may correct them.`,
        { evidence: [fact('cmdb_datasource_last_update', 'last write', seen.toISOString().slice(0, 19).replace('T', ' '), `${age} days ago`)],
          guard: { evaluated: Boolean(own), note: own
            ? 'Measured against this source\'s own configured staleness window.'
            : `Measured against the default ${opt.deadSourceDays}-day window. A source that legitimately reports annually needs its own window set in cmdb_datasource_staleness.` } });
    }
  }

  /* ── CMDB-051 / CMDB-055 — who writes what, and who is allowed to ─────── */
  if (!writesOk) {
    for (const r of ['CMDB-051', 'CMDB-055']) skip(r, 'cmdb_datasource_attribute_value', 'The per-source attribute values were not read completely, so what each source writes cannot be compared with what it may write');
  } else if (!writes.length) {
    for (const r of ['CMDB-051', 'CMDB-055']) skip(r, 'cmdb_datasource_attribute_value', 'This instance records no per-source attribute values, so no write can be attributed to a source — the reconciliation rules cannot be checked against actual behaviour');
  } else {
    const holder = new Map();                 // class|attribute -> sources with precedence
    for (const d of defs) for (const attr of splitAttrs(d.attributes)) {
      const key = `${d.applies_to}|${attr}`;
      if (!holder.has(key)) holder.set(key, new Set());
      holder.get(key).add(d.discovery_source);
    }
    const without = new Map();                // source|class|attribute -> count (CMDB-051)
    const unclaimed = new Map();              // class|attribute -> {sources, count} (CMDB-055)
    for (const w of writes) {
      const key = `${w.class}|${w.attribute}`;
      const holders = holder.get(key);
      if (!holders || !holders.size) {
        if (!unclaimed.has(key)) unclaimed.set(key, { sources: new Set(), count: 0 });
        const u = unclaimed.get(key);
        u.sources.add(w.discovery_source);
        u.count += 1;
        continue;
      }
      if (holders.has(w.discovery_source)) continue;
      const k = `${w.discovery_source}|${key}`;
      without.set(k, (without.get(k) || 0) + 1);
    }
    for (const [k, count] of without) {
      const [src, cls, attr] = k.split('|');
      const owner = [...(holder.get(`${cls}|${attr}`) || [])].join(', ');
      configFinding('CMDB-051', 'cmdb_datasource_attribute_value', [], ['discovery_source', 'class', 'attribute'],
        `"${src}" has written ${attr} on ${cls} ${count.toLocaleString('en-US')} time(s) without holding precedence for it — ${owner || 'another source'} does. Either the write is overwriting the trusted source, or the precedence configuration no longer describes what the estate actually does.`,
        { confidence: 0.95,
          evidence: [fact('cmdb_datasource_attribute_value', 'writes', count, `${src} on ${cls}.${attr}`)],
          guard: { evaluated: false, note: 'A source registered recently may simply not have its precedence configured yet. Check the registration date before treating this as a violation.' } });
    }
    for (const [key, u] of unclaimed) {
      const [cls, attr] = key.split('|');
      configFinding('CMDB-055', 'cmdb_reconciliation_definition', [], ['applies_to', 'attributes'],
        `${attr} on ${cls} is written by ${[...u.sources].filter(Boolean).join(', ') || 'a source'} (${u.count.toLocaleString('en-US')} write(s)) and no reconciliation rule claims precedence for it. Nothing decides who wins, so the value is whatever was written last.`,
        { evidence: [fact('cmdb_datasource_attribute_value', 'writes with no precedence', u.count, `${cls}.${attr}`)],
          guard: { evaluated: false, note: 'Attributes only ever set by hand do not need precedence; this matters where two automated sources write the same field.' } });
    }
  }
}
