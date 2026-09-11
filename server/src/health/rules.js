import crypto from 'node:crypto';

/**
 * The deterministic rule pack — Health Assist's findings engine.
 *
 * Ported from SAOS `app/agents/domain_analysis.py`, and kept PURE on purpose:
 * this module takes an already-extracted estate and returns findings. It opens
 * no socket, reads no database and calls no model. That is what makes it
 * testable offline against fixtures, and it is the same reason `agent/lint/` is
 * shaped this way — a finding produced by a rule can be argued with; one
 * produced by a model cannot.
 *
 * THE PROPERTY THAT MATTERS MOST is coverage gating. A rule that fires on the
 * ABSENCE of something (no relationships, no service offering) is only sound if
 * the extraction that found nothing was complete. Partial extraction plus an
 * absence rule is how "we could not read the table" becomes "your CMDB is
 * broken". So `rows()` refuses to serve a table whose coverage is not good
 * enough and records WHY in `skipped[]`, and the absence rules additionally
 * demand `complete`. This is the same distinction the ACL module draws with
 * `visibility: full | empty | restricted` — an empty result is never rendered
 * as an answer.
 */

export const RULE_VERSION = '2.0.0';

/** domain key → [DOMAIN, human label]. The closed vocabulary for grouping. */
export const AGENTS = Object.freeze({
  cmdb_agent: ['CMDB', 'CMDB quality'],
  relationship_agent: ['RELATIONSHIP', 'Relationship integrity'],
  csdm_agent: ['CSDM', 'Service model completeness'],
  customization_agent: ['CUSTOMIZATION', 'Business rule review'],
  integration_agent: ['INTEGRATION', 'Integration configuration'],
  performance_agent: ['PERFORMANCE', 'Queue and job health'],
  upgrade_agent: ['UPGRADE', 'Upgrade review'],
  security_agent: ['SECURITY', 'Access hygiene'],
  mid_server_agent: ['MID_SERVER', 'MID server health'],
  event_management_agent: ['EVENT_MANAGEMENT', 'Alert binding'],
});

const SEVERITY_RANK = Object.freeze({ CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 });

/**
 * The severity vocabulary, with the words a person reads.
 *
 * It lives on the server because the UI may not invent vocabulary of its own
 * (ARCHITECTURE §17.7) — "Major" is a label for `HIGH`, and if the page coined
 * it privately the two would drift the first time a rule changed severity.
 *
 * `tone` names a reserved STATUS colour, never a series colour. Severity is a
 * status scale, so every mark that carries one also carries its word and its
 * glyph: identity never rests on hue, which is what makes the two reds at the
 * top of the scale legible to a colourblind reader.
 */
export const SEVERITIES = Object.freeze([
  { key: 'CRITICAL', label: 'Critical', rank: 5, tone: 'critical', glyph: '▲', blurb: 'Fix now — this is actively harmful.' },
  { key: 'HIGH', label: 'Major', rank: 4, tone: 'major', glyph: '▲', blurb: 'Fix soon — real risk to operations.' },
  { key: 'MEDIUM', label: 'Moderate', rank: 3, tone: 'moderate', glyph: '●', blurb: 'Plan it in — data quality and hygiene.' },
  { key: 'LOW', label: 'Low', rank: 2, tone: 'low', glyph: '●', blurb: 'Review when convenient.' },
  { key: 'INFO', label: 'Info', rank: 1, tone: 'info', blurb: 'For awareness only.' },
]);

/** Serial values that are placeholders rather than identities. */
const NON_SERIALS = new Set(['unknown', 'none', 'null', 'n/a', '0', 'to be filled by o.e.m.']);

function truth(value) {
  return ['true', '1', 'yes'].includes(String(value).toLowerCase());
}

/**
 * Parse a ServiceNow timestamp as UTC.
 *
 * The platform stores `sys_updated_on` as `YYYY-MM-DD HH:MM:SS` with no zone and
 * means UTC by it (trap #21 — the display half is session-local). Reading it
 * with the host's zone shifts every staleness calculation by the offset, which
 * on this machine is 5.5 hours, so the `Z` is explicit.
 */
export function parseDate(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  const spaced = raw.replace(' ', 'T');
  const withZone = /(Z|[+-]\d{2}:?\d{2})$/.test(spaced) ? spaced : `${spaced}Z`;
  const dt = new Date(withZone);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

const DAY_MS = 86_400_000;

export class EstateRules {
  /**
   * @param {Record<string, object[]>} estate   table → extracted rows
   * @param {Record<string, object>}   coverage table → coverage descriptor
   * @param {number} staleDays                  age at which a CI is a review signal
   */
  constructor(estate, coverage, staleDays = 90, now = new Date()) {
    this.estate = estate || {};
    this.coverage = coverage || {};
    this.staleDays = staleDays;
    this.findings = [];
    this.skipped = [];
    this.now = now;
  }

  /**
   * Rows of a table that are safe to reason about.
   *
   * Refuses — and records why — when the table was not extracted well enough,
   * and drops individual records missing a field the rule needs, reporting the
   * count. A rule silently running on 3 of 900 rows is the failure this
   * prevents.
   */
  rows(tableName, fields = [], { complete = false, rule = '' } = {}) {
    const c = this.coverage[tableName] || {};
    if (!['complete', 'limited', 'truncated'].includes(c.status)) {
      this.skipped.push({ rule, table: tableName, reason: c.status || 'not_requested' });
      return [];
    }
    if (complete && c.status !== 'complete') {
      this.skipped.push({ rule, table: tableName, reason: 'Complete visible-table coverage required' });
      return [];
    }
    const all = this.estate[tableName] || [];
    const eligible = all.filter((r) => fields.every((k) => k in r));
    if (eligible.length !== all.length) {
      this.skipped.push({
        rule,
        table: tableName,
        reason: 'Fields omitted by API/ACL',
        excluded_records: all.length - eligible.length,
      });
    }
    return eligible;
  }

  /** Record a finding, with one evidence row per (record, field) actually present. */
  add(agent, rule, tableName, records, fields, title, description, {
    severity = 'MEDIUM',
    confidence = 1.0,
    recommendation = 'Review the evidence with the responsible owner before making changes.',
  } = {}) {
    const evidence = [];
    for (const r of records) {
      for (const field of fields) {
        if (field in r) {
          evidence.push({
            source: 'ServiceNow Table REST API',
            sn_table: tableName,
            sn_sys_id: r.sys_id,
            field_name: field,
            field_value: String(r[field]),
            reason: description,
            collected_at: this.now.toISOString(),
          });
        }
      }
    }
    const identity = `${rule}|${tableName}|${records.map((r) => r.sys_id).sort().join('|')}`;
    this.findings.push({
      fingerprint: crypto.createHash('sha256').update(identity).digest('hex'),
      agent_id: agent,
      rule_id: rule,
      domain: AGENTS[agent][0],
      table: tableName,
      target_ids: records.map((r) => r.sys_id),
      title,
      description,
      severity,
      confidence,
      affected_ci_ids: tableName === 'cmdb_ci' ? records.map((r) => r.sys_id) : [],
      affected_service_ids: [],
      evidence,
      recommendation,
    });
  }

  analyze() {
    this.cmdbRules();
    this.relationshipRules();
    this.serviceRules();
    this.platformRules();
    this.synthesize();
    return this.findings;
  }

  /* ── CMDB quality ─────────────────────────────────────────────────────── */
  cmdbRules() {
    const cis = this.rows('cmdb_ci');
    for (const c of cis) {
      const name = c.name || c.sys_id;
      if ('owned_by' in c && !c.owned_by) {
        this.add('cmdb_agent', 'CMDB-OWNER', 'cmdb_ci', [c], ['owned_by', 'name'],
          `CI has no owner: ${name}`,
          'The owned_by field is empty in the extracted record.',
          { recommendation: 'Ask the service owner to confirm ownership; do not infer an assignee automatically.' });
      }
      const updated = parseDate(c.sys_updated_on);
      if (updated) {
        const days = Math.floor((this.now - updated) / DAY_MS);
        if (days > this.staleDays) {
          this.add('cmdb_agent', 'CMDB-STALE', 'cmdb_ci', [c], ['sys_updated_on', 'last_discovered'],
            `CI record unchanged for ${days} days: ${name}`,
            `No record update in more than ${this.staleDays} days. This is a review signal, not proof of retirement.`,
            {
              confidence: 0.8,
              recommendation: 'Compare fresh Discovery evidence and lifecycle policy before retaining or retiring the CI.',
            });
        }
      }
    }

    /*
     * Duplicate identity by normalised serial within a class. Placeholder
     * serials are excluded — "Unknown" on 400 CIs is one data-entry habit, not
     * 400 duplicates.
     */
    const identifiers = new Map();
    for (const c of this.rows('cmdb_ci', ['serial_number', 'sys_class_name'], { rule: 'CMDB-DUPLICATE' })) {
      const serial = String(c.serial_number).trim().toLowerCase();
      if (serial && !NON_SERIALS.has(serial)) {
        const key = `${serial} ${c.sys_class_name}`;
        if (!identifiers.has(key)) identifiers.set(key, []);
        identifiers.get(key).push(c);
      }
    }
    for (const records of identifiers.values()) {
      if (records.length > 1) {
        this.add('cmdb_agent', 'CMDB-DUPLICATE', 'cmdb_ci', records, ['serial_number', 'name', 'sys_class_name'],
          `${records.length} CIs share a serial number`,
          'Same normalized serial and CI class; identity merge requires corroborating evidence.',
          {
            severity: 'HIGH',
            confidence: 0.8,
            recommendation: 'Compare stable identifiers, Discovery sources and relationships; a human must select any survivor.',
          });
      }
    }
  }

  /* ── Relationship integrity ───────────────────────────────────────────── */
  relationshipRules() {
    const relations = this.rows('cmdb_rel_ci', ['parent', 'child', 'type'], { rule: 'REL-SELF' });
    const related = new Set();
    const edgeGroups = new Map();
    for (const r of relations) {
      related.add(r.parent);
      related.add(r.child);
      const key = `${r.parent} ${r.child} ${r.type}`;
      if (!edgeGroups.has(key)) edgeGroups.set(key, []);
      edgeGroups.get(key).push(r);
      if (r.parent && r.parent === r.child) {
        this.add('relationship_agent', 'REL-SELF', 'cmdb_rel_ci', [r], ['parent', 'child', 'type'],
          'CI relationship references itself',
          'The parent and child reference the same CI.', { severity: 'HIGH' });
      }
    }
    for (const records of edgeGroups.values()) {
      if (records.length > 1) {
        this.add('relationship_agent', 'REL-DUPLICATE', 'cmdb_rel_ci', records, ['parent', 'child', 'type'],
          'Duplicate relationship edges',
          'Multiple records have the same parent, child and relationship type.');
      }
    }

    /*
     * ABSENCE RULE — only sound on complete coverage.
     *
     * "No edge references this CI" is a claim about everything that was NOT
     * found, so a partial relationship extract would turn unread rows into
     * orphaned CIs. When coverage falls short the rule does not run and says so.
     */
    if (this.coverage.cmdb_rel_ci?.status === 'complete') {
      for (const c of this.rows('cmdb_ci')) {
        if (!related.has(c.sys_id)) {
          this.add('cmdb_agent', 'CMDB-UNRELATED', 'cmdb_ci', [c], ['name', 'sys_class_name'],
            `No visible relationships: ${c.name || c.sys_id}`,
            'No edge references this CI in the complete integration-account-visible relationship extract. Hidden ACL/domain records are outside scope.',
            { severity: 'LOW', confidence: 0.75 });
        }
      }
    } else {
      this.skipped.push({
        rule: 'CMDB-UNRELATED',
        table: 'cmdb_rel_ci',
        reason: 'Relationship coverage incomplete',
      });
    }
  }

  /* ── Service model (CSDM) ─────────────────────────────────────────────── */
  serviceRules() {
    const services = this.rows('cmdb_ci_service', [], { rule: 'CSDM' });
    const offeringsComplete = this.coverage.service_offering?.status === 'complete';
    const parents = new Set(
      this.rows('service_offering', ['parent'], { rule: 'CSDM-OFFERING' }).map((o) => o.parent),
    );
    for (const s of services) {
      const name = s.name || s.sys_id;
      if ('owned_by' in s && !s.owned_by) {
        this.add('csdm_agent', 'CSDM-OWNER', 'cmdb_ci_service', [s], ['owned_by', 'name'],
          `Service has no owner: ${name}`,
          'Service ownership is empty; assignment requires a business decision.');
      }
      if ('life_cycle_stage' in s && !s.life_cycle_stage) {
        this.add('csdm_agent', 'CSDM-LIFECYCLE', 'cmdb_ci_service', [s], ['life_cycle_stage', 'life_cycle_stage_status'],
          `Service lifecycle stage is empty: ${name}`,
          "No lifecycle stage is recorded; validate the instance's CSDM policy before assigning it.");
      }
      if (offeringsComplete && s.sys_class_name === 'cmdb_ci_service' && !parents.has(s.sys_id)) {
        this.add('csdm_agent', 'CSDM-OFFERING', 'cmdb_ci_service', [s], ['name', 'sys_class_name'],
          `No visible service offering: ${name}`,
          'No offering references this business service in the complete visible offering extract.',
          { confidence: 0.85 });
      }
    }
    if (!offeringsComplete) {
      this.skipped.push({
        rule: 'CSDM-OFFERING',
        table: 'service_offering',
        reason: 'Offering coverage incomplete',
      });
    }
  }

  /* ── Platform hygiene: customisation, integration, perf, upgrade, security ── */
  platformRules() {
    for (const r of this.rows('sys_script', ['active', 'script', 'when'], { rule: 'CUSTOM-BEFORE-UPDATE' })) {
      if (truth(r.active) && r.when === 'before' && /\bcurrent\s*\.\s*update\s*\(/.test(r.script || '')) {
        this.add('customization_agent', 'CUSTOM-BEFORE-UPDATE', 'sys_script', [r], ['name', 'collection', 'when', 'script'],
          `Review current.update() in before rule: ${r.name || r.sys_id}`,
          'Static pattern matched current.update() in an active before business rule. Comments or unreachable branches can be false positives; review the code.',
          {
            severity: 'HIGH',
            confidence: 0.85,
            recommendation: 'Review recursion risk and redundant updates in sub-production; package any tested change through your release process.',
          });
      }
    }
    for (const r of this.rows('sys_rest_message', ['rest_endpoint'], { rule: 'INT-HTTP' })) {
      if (String(r.rest_endpoint).toLowerCase().startsWith('http://')) {
        this.add('integration_agent', 'INT-HTTP', 'sys_rest_message', [r], ['name', 'rest_endpoint'],
          `Integration uses HTTP: ${r.name || r.sys_id}`,
          'The configured endpoint starts with unencrypted HTTP; runtime overrides are not evaluated.',
          {
            severity: 'HIGH',
            confidence: 1.0,
            recommendation: 'Confirm endpoint TLS support and test an HTTPS configuration in sub-production.',
          });
      }
    }
    for (const r of this.rows('sys_trigger', ['state'], { rule: 'PERF-JOB-ERROR' })) {
      if (String(r.state) === '3') {
        this.add('performance_agent', 'PERF-JOB-ERROR', 'sys_trigger', [r], ['name', 'state'],
          `Scheduled job is in error state: ${r.name || r.sys_id}`,
          'sys_trigger state equals 3 (error). Inspect scheduler logs before restarting.');
      }
    }
    for (const r of this.rows('ecc_queue', ['state', 'sys_created_on'], { rule: 'PERF-ECC-AGE' })) {
      const created = parseDate(r.sys_created_on);
      if (r.state === 'ready' && created && (this.now - created) / 1000 > 3600) {
        this.add('performance_agent', 'PERF-ECC-AGE', 'ecc_queue', [r], ['state', 'sys_created_on', 'agent'],
          'ECC item has waited over one hour',
          'A ready ECC record is older than one hour; inspect MID connectivity and queue consumers.');
      }
    }
    for (const r of this.rows('sys_upgrade_history_log', ['disposition'], { rule: 'UPGRADE-SKIPPED' })) {
      if (String(r.disposition).toLowerCase() === 'skipped') {
        this.add('upgrade_agent', 'UPGRADE-SKIPPED', 'sys_upgrade_history_log', [r], ['name', 'disposition', 'resolution_status'],
          `Skipped upgrade record needs review: ${r.name || r.sys_id}`,
          'Upgrade disposition is skipped. Check resolution status; a deliberate preserved customization may be acceptable.',
          { confidence: 0.85 });
      }
    }
    for (const r of this.rows('sys_user_has_role', ['user.active', 'user', 'role'], { rule: 'SEC-INACTIVE-ROLE' })) {
      if (['false', '0'].includes(String(r['user.active']).toLowerCase())) {
        this.add('security_agent', 'SEC-INACTIVE-ROLE', 'sys_user_has_role', [r], ['user', 'user.active', 'role', 'role.name'],
          'Inactive user still holds a role',
          'The referenced user is inactive and a role assignment remains.',
          {
            severity: r['role.name'] === 'admin' ? 'HIGH' : 'MEDIUM',
            recommendation: 'Review retention and reactivation policy; remove privileges only through the approved identity process.',
          });
      }
    }
    for (const r of this.rows('ecc_agent', ['status'], { rule: 'MID-DOWN' })) {
      if (String(r.status).toLowerCase() === 'down') {
        this.add('mid_server_agent', 'MID-DOWN', 'ecc_agent', [r], ['name', 'status', 'last_refreshed'],
          `MID server is down: ${r.name || r.sys_id}`,
          'ServiceNow reports this MID server as Down.', { severity: 'HIGH' });
      }
    }
    for (const r of this.rows('em_alert', ['cmdb_ci', 'state'], { rule: 'EVENT-UNBOUND' })) {
      if (!r.cmdb_ci && ['open', 'reopen'].includes(String(r.state).toLowerCase())) {
        this.add('event_management_agent', 'EVENT-UNBOUND', 'em_alert', [r], ['number', 'cmdb_ci', 'state'],
          `Open alert has no CI binding: ${r.number || r.sys_id}`,
          'An open or reopened alert has an empty cmdb_ci reference.');
      }
    }
  }

  /**
   * Blast radius and priority.
   *
   * Walks the undirected relationship graph out to depth 3 from each finding's
   * targets. The number it produces is REACHABILITY, and the finding says so in
   * `impact.interpretation` — topology for review, not proven outage
   * propagation. Calling it "impact" without that sentence is how a graph
   * statistic becomes a business claim nobody verified.
   */
  synthesize() {
    const graph = new Map();
    const link = (a, b) => {
      if (!graph.has(a)) graph.set(a, new Set());
      graph.get(a).add(b);
    };
    const ciIds = new Set((this.estate.cmdb_ci || []).map((c) => c.sys_id));
    const serviceIds = new Set((this.estate.cmdb_ci_service || []).map((s) => s.sys_id));
    const relById = new Map((this.estate.cmdb_rel_ci || []).map((r) => [r.sys_id, r]));
    for (const r of relById.values()) {
      if (r.parent && r.child) { link(r.parent, r.child); link(r.child, r.parent); }
    }

    for (const f of this.findings) {
      const seeds = new Set(f.target_ids.filter((id) => ciIds.has(id) || serviceIds.has(id)));
      if (f.table === 'cmdb_rel_ci') {
        for (const sid of f.target_ids) {
          const rel = relById.get(sid);
          if (rel?.parent) seeds.add(rel.parent);
          if (rel?.child) seeds.add(rel.child);
        }
      }
      const visited = new Set(seeds);
      let frontier = [...seeds];
      for (let depth = 0; depth < 3 && frontier.length; depth++) {
        const next = [];
        for (const node of frontier) {
          for (const neighbour of graph.get(node) || []) {
            if (!visited.has(neighbour)) { visited.add(neighbour); next.push(neighbour); }
          }
        }
        frontier = next;
      }

      f.affected_ci_ids = [...visited].filter((id) => ciIds.has(id)).sort();
      f.affected_service_ids = [...visited].filter((id) => serviceIds.has(id)).sort();
      f.impact = {
        reachable_nodes: visited.size,
        max_depth: 3,
        direction: 'undirected',
        interpretation: 'Topology reachability for review, not proven outage propagation',
      };

      const severity = SEVERITY_RANK[f.severity];
      const business = 1 + Math.min(f.affected_service_ids.length, 4);
      const dependency = 1 + Math.min(visited.size, 20) / 20;
      f.priority_score = Number((severity * business * dependency * f.confidence).toFixed(3));
      f.priority_factors = {
        severity,
        business_impact_proxy: business,
        dependency_criticality_proxy: dependency,
        confidence: f.confidence,
        remediation_value: 1,
        effort: 1,
        note: 'Value/effort default to 1 pending human assessment',
      };
      f.priority = f.priority_score >= 20 ? 'P1' : f.priority_score >= 8 ? 'P2' : 'P3';
    }

    this.findings.sort((a, b) => (b.priority_score - a.priority_score)
      || a.fingerprint.localeCompare(b.fingerprint));
  }
}
