import { modifiersFor, lineageOf, dqActive, cisForRule, DQ_INACTIVE_INSTALL_STATUS, CLASS_TIERS, SCRIPT_ACCOUNT_SEED, scriptAccountsIn } from './cmdb-signals.js';
import { parseDate } from './time.js';

/**
 * GROUP 7 — FRESHNESS AND SOURCE COVERAGE (D7). CMDB-070 to CMDB-079.
 *
 * Not "is the record right" but "is anything still saying so". A CMDB decays
 * silently: nothing in it changes colour when the thing it describes is gone, so
 * the only question that matters here is which process last confirmed each
 * record, and how long ago.
 *
 * ═══ WHAT THIS INSTANCE KEEPS (verified on dev424910, Sep 2026) ═══
 *
 *   discovery_schedule          THE TABLE DOES NOT EXIST — Discovery is not
 *                               installed. That is not a failure to read; it is
 *                               the estate's posture, and CMDB-070 says so
 *                               rather than gating on a product nobody owns.
 *   discovery_device_history    0 rows. discovery_status 0 rows.
 *   discovery_range_item        3 rows, all from 2010: 10.0.0.0/8, 172.16.0.0/12
 *                               and 192.168.0.0/16 — the whole private space,
 *                               under one discovery_range, with no schedule.
 *   cmdb_ci.last_discovered     10 of 2,784 CIs, last seen in 2007.
 *   cmdb_ci.discovery_source    50 CIs, every one "Other Automated", and every
 *                               one of those 50 has an EMPTY first_discovered.
 *                               That is CMDB-073, and it is the only rule in
 *                               this group the estate can answer in full.
 *   sys_object_source           0 rows. cmdb_datasource_last_update 0 rows.
 *                               cmdb_metadata does not exist. So there is NO
 *                               per-CI source attribution and no per-ATTRIBUTE
 *                               last-seen: CMDB-074 and CMDB-076 cannot run, and
 *                               say why instead of reporting a clean 100.
 *   sys_import_set / _row       0 rows, so a CI created by an import cannot be
 *                               told from one typed by hand — which makes
 *                               CMDB-078 an UPPER BOUND and CMDB-079 unmeasurable.
 *
 *   THE BULK TOUCH. 2,659 of 2,784 CIs carry the same sys_updated_on — one
 *   `system` write on 2026-04-30 — and only 124 CIs were updated before 2026.
 *   Record-level freshness therefore reads as almost perfect while nothing has
 *   confirmed a single attribute. That is precisely the illusion CMDB-076 exists
 *   to break, so the numbers are reported in its gap note even though the rule
 *   itself cannot run.
 *
 * ═══ INTENT (decision 5 of Sep 2026) ═══
 *
 * The staleness rules here are QUALITY rules and never charge a retired, stolen
 * or absent CI: a decommissioned server nobody rediscovers is doing exactly what
 * it should. The contradiction rules (CMDB-073, CMDB-076) run over the FULL
 * estate, because a dead CI still claiming a live source is the finding.
 *
 * A dead CI that is still being ACTIVELY DISCOVERED is a contradiction too, and
 * it is measured here — but it is not charged here. CMDB-087 (D8, Group 8) is
 * the rule that owns it, so this group records the population in
 * `measures.retired_still_discovered` and leaves the charge to the dimension
 * that owns lifecycle. Counting it twice would be worse than counting it late.
 *
 * PURE — no network, no database.
 */

export const FRESHNESS_RULES = Object.freeze([
  'CMDB-070', 'CMDB-071', 'CMDB-072', 'CMDB-073', 'CMDB-074',
  'CMDB-075', 'CMDB-076', 'CMDB-077', 'CMDB-078', 'CMDB-079',
  /* The bulk-touch pair, added Sep 2026 — see CMDB-142 below. */
  'CMDB-142', 'CMDB-143',
]);

export const FRESHNESS_DEFAULTS = Object.freeze({
  dqInactiveInstallStatus: DQ_INACTIVE_INSTALL_STATUS,
  /* CMDB-070 — discovered devices as a share of the devices we expected. */
  discoveryCoveragePct: 85,
  /*
   * Which classes a discovery product is expected to find — the denominator's
   * derivation, which the catalogue requires be SHOWN rather than asserted. One
   * setting, shared with D6: see CLASS_TIERS in cmdb-signals.js.
   */
  discoverableClasses: CLASS_TIERS.discoverable,
  /* CMDB-072 — how far past its schedule a CI may drift before it is stale. */
  scheduleTolerance: 2,
  /* CMDB-075 — a record nothing has touched since the day it was typed in. */
  untouchedDays: 180,
  /* CMDB-074 / CMDB-078 / CMDB-079 — the percentage rules' pass bars. */
  singleSourcePct: 60,
  manualOnlyPct: 25,
  importOnlyPct: 25,
  /* CMDB-077 — the window over which "only scripts touched this" is judged. */
  scriptOnlyDays: 180,
  /*
   * CMDB-142 / CMDB-143 — what makes a write a MASS write. One writer, one day,
   * and at least this share of the in-scope CIs. Below it, a busy Tuesday; above
   * it, a job. Measured on dev424910: one `system` write covering 95.5%.
   */
  bulkTouchSharePct: 20,
  bulkTouchCeilingPct: 25,
  /*
   * A SHARE ALONE IS NOT A MASS WRITE. On an estate of ten CIs, 20% is two
   * records — which is a person saving twice, not a job. The absolute floor
   * stops the rule reporting ordinary work as a bulk touch on small estates;
   * at dev424910's scale the share is what binds (557 CIs), not this.
   */
  bulkTouchMinCis: 25,
  /* A dead CI discovered this recently is being actively discovered. */
  activeDiscoveryDays: 30,
  /*
   * WHOSE WRITE IS NOT A PERSON'S — a SEED, resolved against the accounts this
   * estate actually writes with, and reported as the list it resolved to. A
   * hardcoded list cannot see an integration user called `bmc_bridge`, and a
   * reader who cannot see which accounts were counted cannot check a ratio built
   * on them. See SCRIPT_ACCOUNT_SEED in cmdb-signals.js.
   */
  scriptAccountSeed: SCRIPT_ACCOUNT_SEED,
  /*
   * CMDB-073 — a `discovery_source` that CLAIMS an automated source. Everything
   * non-empty makes that claim except the values that say the opposite: `Manual`
   * is an admission, and `Duplicate` is a de-duplication marker rather than a
   * source. Configurable, because the choice list is per estate.
   */
  manualSourceValues: Object.freeze(['Manual', 'Duplicate', 'Duplicate CI']),
});

const DAY_MS = 86_400_000;
const pct1 = (n) => Number(n.toFixed(1));
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const val = (r, f) => String(r?.[f] ?? '').trim();

/* ── IP arithmetic for CMDB-071 — ranges, not string matching ───────────── */

/** Dotted-quad to a number. Null for anything that is not IPv4. */
export function ipToInt(ip) {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const b = Number(p);
    if (b > 255) return null;
    n = n * 256 + b;
  }
  return n;
}

/** The [first, last] addresses a discovery_range_item covers, or null. */
export function rangeBounds(row) {
  const start = ipToInt(row?.start_ip_address);
  const end = ipToInt(row?.end_ip_address);
  if (start != null && end != null && end >= start) return [start, end];
  const net = ipToInt(row?.network_ip);
  const mask = Number(row?.netmask);
  if (net == null || !Number.isFinite(mask) || mask < 0 || mask > 32) return null;
  const size = 2 ** (32 - mask);
  const base = Math.floor(net / size) * size;
  return [base, base + size - 1];
}

/** The /24 an address sits in, as a label and bounds. The stated derivation. */
export function subnetOf(ip) {
  const n = ipToInt(ip);
  if (n == null) return null;
  const base = Math.floor(n / 256) * 256;
  const o = [base >>> 24 & 255, base >>> 16 & 255, base >>> 8 & 255, 0];
  return { key: `${o[0]}.${o[1]}.${o[2]}.0/24`, start: base, end: base + 255 };
}

export function cmdbFreshnessRules(ctx, options = {}) {
  const opt = { ...FRESHNESS_DEFAULTS, ...options };
  const now = ctx.now;
  const meta = ctx.meta?.cmdb || {};
  const signals = ctx.signals;
  const skip = (rule, table, reason) => ctx.skipped.push({ rule, table, reason });
  const hierarchyOk = meta.reads?.class_hierarchy?.status === 'ok';
  const line = (cls) => lineageOf(meta, cls || 'cmdb_ci');
  const inClasses = (c, classes) => (hierarchyOk ? line(c.sys_class_name).some((t) => classes.includes(t)) : classes.includes(c.sys_class_name));
  const allCis = ctx.estate.cmdb_ci || [];
  const { active: activeCis, excluded: inactiveCis } = dqActive(allCis, opt.dqInactiveInstallStatus);
  const cisFor = (rule) => cisForRule(rule, { all: allCis, active: activeCis });
  const label = (c) => `${c.sys_class_name} "${c.name || c.sys_id}"`;
  const fact = (table, field, value, reason) => ({
    source: 'ServiceNow Table/Aggregate REST API', sn_table: table, sn_sys_id: null,
    field_name: field, field_value: String(value), reason, collected_at: now.toISOString(),
  });
  const perRecord = (rule, records, fields, description, extra = {}) => {
    const m = modifiersFor(records, signals);
    return ctx.addCatalogued(rule, 'cmdb_ci', records, fields, description, {
      agent: 'freshness_agent', escalators: m.escalators, deEscalators: m.deEscalators, notEvaluated: m.notEvaluated, ...extra,
    });
  };
  ctx.measures ||= {};

  const ciOk = ctx.complete('cmdb_ci', ['sys_class_name', 'sys_created_on']);
  if (!ciOk) {
    for (const r of FRESHNESS_RULES) skip(r, 'cmdb_ci', 'The CIs were not read completely — a freshness rule over a partial estate reports our own access rather than the estate\'s decay');
    return;
  }
  const days = (d) => (d ? Math.floor((now - d) / DAY_MS) : null);
  const age = (r, field) => days(parseDate(r?.[field]));
  /*
   * Seeded from the estate: every account that has written a CI here is matched
   * against the seed once, and the resolved list is what the rules report.
   */
  const writers = new Set();
  const addWriter = (u) => { const w = String(u || '').trim().toLowerCase(); if (w) writers.add(w); };
  for (const c of allCis) {
    addWriter(c.sys_created_by);
    addWriter(c.sys_updated_by);
  }
  /*
   * The audit log names writers the CI record does not: a script that changed a
   * field and was then overwritten by a person leaves no trace on `sys_updated_by`
   * but is all over `sys_audit`. Where the log is read, it is part of the seed.
   */
  for (const a of ctx.estate.sys_audit || []) addWriter(a.user);
  const scriptAccounts = new Set(scriptAccountsIn(writers, opt.scriptAccountSeed));
  const isScriptAccount = (u) => scriptAccounts.has(String(u || '').trim().toLowerCase());

  /* ═══ Is there a discovery capability here at all? ══════════════════════ */
  /*
   * THE DIFFERENCE BETWEEN BROKEN AND ABSENT. Every rule below that measures
   * discovery needs this answered first, because "discovery is behind" and
   * "there is no discovery" produce the same empty columns and mean opposite
   * things. A table the instance does not have answers `unavailable`, which is
   * not a failed read — it is the estate telling us the product is not installed.
   */
  const scheduleStatus = ctx.coverage?.discovery_schedule?.status ?? 'not_requested';
  const schedules = (ctx.estate.discovery_schedule || []).filter((s) => truthy(s.active));
  const deviceHistory = ctx.estate.discovery_device_history || [];
  const everDiscovered = allCis.filter((c) => parseDate(c.last_discovered));
  const discoveryInstalled = scheduleStatus !== 'unavailable';
  const discoveryOperating = discoveryInstalled && (schedules.length > 0 || deviceHistory.length > 0);
  /* PRODUCER → CONSUMER: CMDB-135 (Group 14) reads this rather than re-deriving it. */
  ctx.measures.discovery_capability = {
    installed: discoveryInstalled,
    operating: discoveryOperating,
    schedules: schedules.length,
    device_history: deviceHistory.length,
    ever_discovered: everDiscovered.length,
  };
  const capabilityNote = discoveryInstalled
    ? `${schedules.length} active discovery schedule(s), ${deviceHistory.length} device-history row(s), ${everDiscovered.length} CI(s) ever discovered`
    : 'the discovery_schedule table does not exist on this instance, so the Discovery product is not installed';

  /* ── CMDB-070 — discovered against expected ───────────────────────────── */
  const discoverable = cisFor('CMDB-070').filter((c) => inClasses(c, opt.discoverableClasses));
  if (!discoveryOperating) {
    /*
     * POSTURE, NOT A GATE (decision 2 of Sep 2026 applied to D7). CMDB-070 is a
     * gating measured_kpi. An estate with no Discovery would fail it for ever,
     * and the composite would be permanently untrustworthy on the strength of a
     * product decision rather than a measurement. The fact is raised in full —
     * it is Systemic and it is visible — but it neither gates nor scores.
     */
    const f = ctx.addCatalogued('CMDB-070', 'cmdb_ci', [], ['sys_class_name'],
      `Nothing on this instance is discovering anything: ${capabilityNote}. ${discoverable.length.toLocaleString('en-US')} CI(s) sit in classes a discovery product would find, and every one of them is maintained by hand or by an integration with no independent confirmation. This is reported as posture rather than as a coverage failure — an estate that has chosen not to run Discovery has not failed a measurement, it has made a decision, and the decision is what is shown here.`,
      { agent: 'freshness_agent',
        evidence: [
          fact('discovery_schedule', 'status', scheduleStatus, discoveryInstalled ? 'the table exists' : 'the table does not exist on this instance'),
          fact('discovery_device_history', 'rows', deviceHistory.length, 'discovery run evidence'),
          fact('cmdb_ci', 'ever discovered', `${everDiscovered.length} of ${allCis.length}`, 'CIs carrying any last_discovered'),
        ],
        guard: { evaluated: true, note: 'An estate discovered by a third-party tool that writes straight into the CMDB looks identical from here. The tell is source attribution, which this instance also does not keep — see CMDB-074.' } });
    f.systemic_kind_override = 'posture';
    f.systemic_kind_override_reason = `Discovery is not operating on this instance (${capabilityNote}), so there is no coverage ratio to measure. The absence of the capability is posture; gating the composite on it would assert a product requirement as a measurement.`;
    skip('CMDB-070', 'discovery_schedule', `No discovery coverage ratio was published: ${capabilityNote}. A ratio needs a discovery process to have run.`);
  } else {
    const found = discoverable.filter((c) => parseDate(c.last_discovered)).length;
    const passPct = discoverable.length ? (100 * found) / discoverable.length : null;
    if (passPct == null) {
      skip('CMDB-070', 'cmdb_ci', 'No CI sits in a class discovery would be expected to find, so there is no expected count to measure against');
    } else {
      ctx.kpis.push({
        rule_id: 'CMDB-070',
        pass_pct: passPct,
        numerator: found,
        denominator: discoverable.length,
        basis: `CIs carrying a last_discovered, over the EXPECTED COUNT derived as: live CIs whose class descends from ${opt.discoverableClasses.join(', ')} (${discoverable.length.toLocaleString('en-US')} of ${allCis.length.toLocaleString('en-US')} CIs). The derivation is the class tree, not an inventory of physical devices — an estate with devices that reach no CI at all would score better than it should.`,
        alerts: `${schedules.length} active schedule(s), ${deviceHistory.length} device-history row(s).`,
      });
      if (passPct < opt.discoveryCoveragePct) {
        ctx.addCatalogued('CMDB-070', 'cmdb_ci', [], ['sys_class_name'],
          `${found.toLocaleString('en-US')} of ${discoverable.length.toLocaleString('en-US')} discoverable CIs (${pct1(passPct)}%) have ever been discovered, below the ${opt.discoveryCoveragePct}% threshold. The rest are asserted rather than confirmed: nothing outside the CMDB has ever agreed that they exist.`,
          { agent: 'freshness_agent',
            evidence: [fact('cmdb_ci', 'ever discovered', `${found} of ${discoverable.length}`, `classes: ${opt.discoverableClasses.join(', ')}`)],
            guard: { evaluated: false, note: 'Ranges deliberately excluded from discovery (DMZ, third-party managed) look the same. Maintain the exclusion list and re-run.' } });
      }
    }
  }

  /* ── CMDB-071 — subnets the CIs use that no discovery range covers ────── */
  const rangeRows = (ctx.estate.discovery_range_item || []).filter((r) => truthy(r.active) || val(r, 'active') === '');
  const ranges = rangeRows.map((r) => ({ row: r, bounds: rangeBounds(r) })).filter((x) => x.bounds);
  if (!discoveryInstalled) {
    skip('CMDB-071', 'discovery_schedule', 'Discovery is not installed on this instance, so a subnet with no discovery range is not a gap — nothing was ever going to scan it. The ranges that do exist (discovery_range_item) are configuration left behind, not a scanning plan.');
  } else if (!ranges.length) {
    skip('CMDB-071', 'discovery_range_item', 'No usable discovery range is configured, so "uncovered" cannot be told from "discovery is not used for this estate" — every subnet would report as a gap, which describes the configuration rather than the network');
  } else {
    const covered = (subnet) => ranges.some((r) => subnet.start >= r.bounds[0] && subnet.end <= r.bounds[1]);
    const subnets = new Map();
    for (const c of cisFor('CMDB-071')) {
      const s = subnetOf(c.ip_address);
      if (!s) continue;
      if (!subnets.has(s.key)) subnets.set(s.key, { ...s, cis: [] });
      subnets.get(s.key).cis.push(c);
    }
    const gaps = [...subnets.values()].filter((s) => !covered(s));
    for (const gap of gaps) {
      perRecord('CMDB-071', gap.cis.slice(0, 25), ['name', 'sys_class_name', 'ip_address'],
        `${gap.cis.length} CI(s) hold addresses in ${gap.key}, and no active discovery range covers it. Everything on that subnet is invisible to discovery: what is already in the CMDB will drift unchecked, and anything new there will never arrive.`,
        { confidence: 1.0,
          evidence: [
            fact('cmdb_ci', 'subnet', gap.key, `derived as the /24 around ${gap.cis.length} CI address(es)`),
            fact('discovery_range_item', 'nearest ranges', ranges.slice(0, 4).map((r) => val(r.row, 'summary') || `${r.bounds[0]}-${r.bounds[1]}`).join(', '), 'configured coverage'),
          ],
          guard: { evaluated: false, note: 'A subnet deliberately out of scope (DMZ, third-party managed, lab) is indistinguishable from an oversight. Keep a documented exclusion list.' } });
    }
    if (!subnets.size) skip('CMDB-071', 'cmdb_ci', 'No CI carries an IPv4 address, so there are no subnets to derive and nothing to compare against the discovery ranges');
  }

  /* ── CMDB-072 — discovered, but not lately ────────────────────────────── */
  /*
   * The interval belongs to the schedule that covers the CI. There is no default
   * interval here and there will not be one: "2x the schedule" is arithmetic,
   * while "2x whatever we assume" is an opinion with a number in front of it.
   */
  const intervalDays = (s) => {
    /*
     * `run_period` is a GlideDuration — a timestamp measured FROM 1970-01-01, so
     * "1970-01-02 00:00:00" means one day, not a date in 1970. Read as a date it
     * would come back as 56 years, which is why this parses the offset itself
     * rather than handing the string to a date parser.
     */
    const raw = String(s?.run_period ?? '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw);
    if (m) {
      const d = (Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - Date.UTC(1970, 0, 1)) / DAY_MS;
      if (d > 0) return d;
    }
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs > 0) return secs / 86400;
    /* A schedule that states a cadence instead of a period. */
    return ({ daily: 1, weekly: 7, monthly: 30 })[String(s?.run_type ?? '').trim().toLowerCase()] ?? null;
  };
  const usableSchedules = schedules.map((s) => ({ s, days: intervalDays(s) })).filter((x) => x.days);
  if (!discoveryOperating) {
    skip('CMDB-072', 'discovery_schedule', `No discovery schedule exists to be behind: ${capabilityNote}. ${everDiscovered.length} CI(s) carry a last_discovered at all${everDiscovered.length ? ` (the newest is ${days(parseDate(everDiscovered.map((c) => c.last_discovered).sort().reverse()[0]))} days old)` : ''}, and without an interval there is no expectation for them to miss — an invented tolerance would be this build's opinion, not the estate's schedule.`);
  } else if (!usableSchedules.length) {
    skip('CMDB-072', 'discovery_schedule', `${schedules.length} active schedule(s) exist but none states a usable interval, so "beyond the interval" has no interval to be beyond`);
  } else {
    const shortest = Math.min(...usableSchedules.map((x) => x.days));
    const toleranceDays = shortest * opt.scheduleTolerance;
    for (const c of cisFor('CMDB-072')) {
      const seen = parseDate(c.last_discovered);
      if (!seen) continue;                                  // never discovered is CMDB-070/073
      const old = days(seen);
      if (old <= toleranceDays) continue;
      perRecord('CMDB-072', [c], ['name', 'sys_class_name', 'last_discovered'],
        `${label(c)} was last discovered ${old} days ago, past the ${toleranceDays}-day tolerance (${opt.scheduleTolerance}x the shortest active schedule interval of ${shortest} days). Discovery is running and this CI is not answering it, so every attribute on it is as old as the last successful scan.`,
        { confidence: 1.0,
          evidence: [
            fact('cmdb_ci', 'last_discovered', c.last_discovered, `${old} days ago`),
            fact('discovery_schedule', 'shortest interval', `${shortest} days`, `tolerance ${opt.scheduleTolerance}x`),
          ],
          guard: { evaluated: false, note: 'A CI from another source carrying a discovery_source in error looks the same — CMDB-073 reports that separately. The interval is the shortest active schedule, not necessarily the one that covers this CI.' } });
    }
  }

  /*
   * RETIRED AND STILL BEING DISCOVERED — measured here, charged in D8.
   * A dead CI that discovery keeps finding is a contradiction (decision 5 of
   * Sep 2026 says to look at it rather than filter it away), but CMDB-087 in
   * Group 8 is the rule that owns "Absent or Stolen but still operational".
   * Recording the population keeps it from being lost without charging it twice.
   */
  const stillDiscovered = inactiveCis.filter((c) => {
    const seen = parseDate(c.last_discovered);
    return seen && days(seen) <= opt.activeDiscoveryDays;
  });
  ctx.measures.retired_still_discovered = {
    count: stillDiscovered.length,
    within_days: opt.activeDiscoveryDays,
    charged_by: 'CMDB-087 (D8, lifecycle) — measured here so D7 does not charge it twice',
    cis: stillDiscovered.slice(0, 50).map((c) => ({ sys_id: c.sys_id, name: c.name, cls: c.sys_class_name, install_status: c.install_status, last_discovered: c.last_discovered })),
  };

  /* ── CMDB-073 — claims a source that never saw it ─────────────────────── */
  const claimsSource = (c) => {
    const src = val(c, 'discovery_source');
    return Boolean(src) && !opt.manualSourceValues.some((m) => m.toLowerCase() === src.toLowerCase());
  };
  const historyByCi = new Set(deviceHistory.map((h) => h.cmdb_ci).filter(Boolean));
  let hadHistory = 0;
  for (const c of cisFor('CMDB-073')) {
    if (!claimsSource(c)) continue;
    if (parseDate(c.first_discovered) || parseDate(c.last_discovered)) continue;
    if (historyByCi.has(c.sys_id)) { hadHistory += 1; continue; }
    perRecord('CMDB-073', [c], ['name', 'sys_class_name', 'discovery_source', 'first_discovered'],
      `${label(c)} carries discovery_source "${val(c, 'discovery_source')}" but has never been discovered: first_discovered and last_discovered are both empty. The record claims a provenance it does not have, and reconciliation gives precedence on the strength of that claim — so a source that has never seen this CI can outrank one that has.`,
      { confidence: 1.0,
        evidence: [
          fact('cmdb_ci', 'discovery_source', val(c, 'discovery_source'), 'the claimed source'),
          fact('cmdb_ci', 'first_discovered', '(empty)', 'never discovered'),
          fact('sys_audit', 'created by', val(c, 'sys_created_by') || '(unknown)', 'the process that actually created the record'),
        ],
        guard: {
          evaluated: deviceHistory.length > 0,
          note: deviceHistory.length > 0
            ? `Checked against ${deviceHistory.length} device-history row(s); this CI appears in none of them.`
            : 'Discovery history holds NO rows at all on this instance, so it corroborates nothing either way — retention has not purged this evidence, it never existed. The contradiction rests on the record\'s own two fields, which is why the confidence stays at 100%.',
        } });
  }
  if (hadHistory) skip('CMDB-073', 'discovery_device_history', `${hadHistory} CI(s) claim a source and have no first_discovered, but DO appear in the discovery device history — the timestamps were lost, not the discovery, and that is a different defect`);

  /* ── CMDB-074 — how many CIs rest on a single source ──────────────────── */
  /*
   * Source attribution lives in sys_object_source (per CI, per feed) or in the
   * datasource last-update metadata. Both are empty here, and `discovery_source`
   * is ONE field: it can hold one value, so counting it would find that every CI
   * has exactly one source and report the estate as 100% single-sourced. That
   * number would be a property of the schema, not of the estate.
   */
  const attribution = (ctx.estate.sys_object_source || []).filter((r) => r.target_table === 'cmdb_ci' || String(r.target_table || '').startsWith('cmdb_ci'));
  const lastUpdate = ctx.estate.cmdb_datasource_last_update || [];
  if (!attribution.length && !lastUpdate.length) {
    skip('CMDB-074', 'sys_object_source', 'No per-CI source attribution exists on this instance (sys_object_source and cmdb_datasource_last_update are both empty), so the number of sources reporting each CI is unknowable. Counting the single discovery_source field instead would report 100% single-sourced on every estate — a fact about the column, not about the data.');
  } else {
    const sources = new Map();                              // ci -> Set(source)
    for (const r of attribution) {
      const id = r.target_sys_id;
      if (!id) continue;
      if (!sources.has(id)) sources.set(id, new Set());
      sources.get(id).add(val(r, 'source_feed') || val(r, 'name') || 'unnamed');
    }
    for (const r of lastUpdate) {
      const id = r.record;
      if (!id) continue;
      if (!sources.has(id)) sources.set(id, new Set());
      sources.get(id).add(val(r, 'discovery_source') || 'unnamed');
    }
    const scope = cisFor('CMDB-074');
    const known = scope.filter((c) => sources.has(c.sys_id));
    const single = known.filter((c) => sources.get(c.sys_id).size === 1).length;
    if (!known.length) {
      skip('CMDB-074', 'sys_object_source', 'Source attribution exists but names no CI in scope, so there is nothing to count sources for');
    } else {
      const singlePct = (100 * single) / known.length;
      ctx.kpis.push({
        rule_id: 'CMDB-074',
        pass_pct: 100 - singlePct,
        numerator: known.length - single,
        denominator: known.length,
        basis: `CIs confirmed by MORE THAN ONE source — the passing half. ${pct1(singlePct)}% rest on a single source, against a ${opt.singleSourcePct}% ceiling. Measured over the ${known.length.toLocaleString('en-US')} of ${scope.length.toLocaleString('en-US')} in-scope CIs that carry any attribution at all.`,
        alerts: known.length < scope.length ? `${scope.length - known.length} CI(s) carry no attribution and are outside the denominator.` : undefined,
      });
      if (singlePct > opt.singleSourcePct) {
        ctx.addCatalogued('CMDB-074', 'cmdb_ci', [], ['sys_class_name'],
          `${single.toLocaleString('en-US')} of ${known.length.toLocaleString('en-US')} attributed CIs (${pct1(singlePct)}%) are confirmed by exactly one source, past the ${opt.singleSourcePct}% ceiling. Nothing corroborates them: when that one source stops reporting, the CMDB keeps showing what it last said, indefinitely and silently.`,
          { agent: 'freshness_agent',
            evidence: [fact('sys_object_source', 'single-source CIs', `${single} of ${known.length}`, 'distinct feeds per CI')],
            guard: { evaluated: false, note: 'Classes where one source is legitimately definitive (a cloud API for its own resources) are not at risk in the same way. Scope by class if that is the case here.' } });
      }
    }
  }

  /* ── CMDB-075 — never touched since the day it was created ────────────── */
  const untouched = [];
  for (const c of cisFor('CMDB-075')) {
    const created = parseDate(c.sys_created_on);
    const updated = parseDate(c.sys_updated_on);
    if (!created) continue;
    const mods = Number(c.sys_mod_count);
    const neverUpdated = Number.isFinite(mods) ? mods === 0 : (updated && Math.abs(updated - created) < 60_000);
    if (!neverUpdated) continue;
    const old = days(created);
    if (old == null || old <= opt.untouchedDays) continue;
    untouched.push(c);
    perRecord('CMDB-075', [c], ['name', 'sys_class_name', 'sys_created_on'],
      `${label(c)} has not been touched since it was created ${old} days ago — no discovery, no integration, no human edit, no field changed once. Whatever was typed that day is what the CMDB still believes, and nothing since has agreed with it.`,
      { confidence: 1.0,
        evidence: [
          fact('cmdb_ci', 'sys_created_on', c.sys_created_on, `${old} days ago, by ${val(c, 'sys_created_by') || 'unknown'}`),
          fact('cmdb_ci', 'sys_mod_count', Number.isFinite(mods) ? mods : '(unknown)', 'updates since creation'),
        ],
        guard: { evaluated: false, note: 'A genuinely static reference CI — a location, a rack, a licence record — is supposed to look like this. Retire it or bring it under a source; either way the CMDB should not be the only thing asserting it.' } });
  }
  /* ── CMDB-142 / CMDB-143 — a mass write is not freshness ──────────────── */
  /*
   * THE POPULATION CMDB-075 CAN NEVER SEE.
   *
   * A single bulk write moves `sys_updated_on` on every record it touches, and
   * hides all of them from every age-based rule for ever — the timestamp never
   * gets older than the job. CMDB-075 asks "has anything touched this record";
   * this asks the harder question underneath it: "did the touch MEAN anything".
   *
   * The charge is the inverse of a stale charge. These records are not stale —
   * they are UNVERIFIABLE, and the rule exists so that the estate cannot buy a
   * clean freshness score with a scheduled job. Measured on dev424910: 2,659 of
   * 2,784 CIs (95.5%) share one `system` write on one day.
   *
   * A REAL MIGRATION IS EXEMPT, where that can be checked. A bulk reclassification
   * changes attributes and leaves audit rows to prove it; a no-op touch does not.
   * `sys_audit` is opt-in (it would destroy scan reuse — see CMDB-077), so where
   * it has not been read the test is declared UNVERIFIED and the confidence drops
   * rather than the finding being withheld or asserted.
   */
  const auditRowsEarly = ctx.estate.sys_audit || [];
  const deltaByCiDay = new Map();
  for (const a of auditRowsEarly) {
    const day = val(a, 'sys_created_on').slice(0, 10);
    const id = a.documentkey;
    if (!day || !id) continue;
    const k = `${id}|${day}`;
    if (!deltaByCiDay.has(k)) deltaByCiDay.set(k, new Set());
    deltaByCiDay.get(k).add(val(a, 'fieldname'));
  }
  const bulkScope = cisFor('CMDB-142');
  const groups = new Map();                               // `day|writer` -> CIs
  for (const c of bulkScope) {
    const day = val(c, 'sys_updated_on').slice(0, 10);
    if (!day) continue;
    const who = val(c, 'sys_updated_by').toLowerCase() || '(unknown)';
    const k = `${day}|${who}`;
    if (!groups.has(k)) groups.set(k, { day, who, cis: [] });
    groups.get(k).cis.push(c);
  }
  const minGroup = Math.max(opt.bulkTouchMinCis, Math.ceil((bulkScope.length * opt.bulkTouchSharePct) / 100));
  const candidates = bulkScope.length
    ? [...groups.values()].filter((g) => g.cis.length >= minGroup).sort((a, b) => b.cis.length - a.cis.length)
    : [];
  const auditRead = auditRowsEarly.length > 0;
  const migrations = [];
  const bulkTouched = new Set();
  for (const g of candidates) {
    const withDeltas = g.cis.filter((c) => (deltaByCiDay.get(`${c.sys_id}|${g.day}`)?.size || 0) > 0).length;
    if (auditRead && withDeltas >= g.cis.length / 2) {
      migrations.push({ ...g, withDeltas });
      continue;                                           // a real migration: it changed things
    }
    const share = (100 * g.cis.length) / bulkScope.length;
    for (const c of g.cis) {
      bulkTouched.add(c.sys_id);
      perRecord('CMDB-142', [c], ['name', 'sys_class_name', 'sys_updated_on', 'sys_updated_by'],
        `${label(c)} was last written on ${g.day} by ${g.who}, in the same write as ${(g.cis.length - 1).toLocaleString('en-US')} other CI(s) — ${pct1(share)}% of the estate on one day, from one writer. The record looks maintained and nothing has confirmed it: its freshness is not old, it is unverifiable, and every age-based measure on it is reporting that job's schedule rather than this CI.`,
        { confidence: auditRead ? 1.0 : 0.8,
          evidence: [
            fact('cmdb_ci', 'sys_updated_on', val(c, 'sys_updated_on'), `shared with ${g.cis.length - 1} other CI(s)`),
            fact('cmdb_ci', 'sys_updated_by', g.who, `wrote ${g.cis.length} CI(s) on ${g.day}`),
            fact('sys_audit', 'attribute deltas', auditRead ? `${withDeltas} of ${g.cis.length} CIs changed a field` : 'not checked', auditRead ? 'checked against the audit log' : 'sys_audit is opt-in and was not read'),
          ],
          guard: {
            evaluated: auditRead,
            note: auditRead
              ? `Checked: only ${withDeltas} of ${g.cis.length} CIs in this write changed any field, so it was not a migration.`
              : 'A genuine bulk migration changes attributes and would be exempt — but sys_audit is opt-in and was not read, so that test could NOT be run here. The clustering itself is certain; the no-op half is unverified, which is why the confidence is 0.8 rather than 1.0.',
          } });
    }
  }
  const bulkPct = bulkScope.length ? (100 * bulkTouched.size) / bulkScope.length : 0;
  const busiest = candidates[0] ? [candidates[0].day, candidates[0].cis.length] : null;
  ctx.measures.record_freshness = {
    cis: allCis.length,
    untouched_since_creation: untouched.length,
    busiest_update_day: busiest ? { day: busiest[0], cis: busiest[1], writer: candidates[0].who, share_pct: pct1((100 * busiest[1]) / (bulkScope.length || 1)) } : null,
    bulk_touched: bulkTouched.size,
    bulk_touch_pct: pct1(bulkPct),
    bulk_groups: candidates.map((g) => ({ day: g.day, writer: g.who, cis: g.cis.length })),
    migrations_exempted: migrations.map((g) => ({ day: g.day, writer: g.who, cis: g.cis.length, with_deltas: g.withDeltas })),
    attribute_deltas_checkable: auditRead,
    script_last_writer: allCis.filter((c) => isScriptAccount(c.sys_updated_by)).length,
    script_accounts: [...scriptAccounts],
  };
  for (const g of migrations) {
    skip('CMDB-142', 'sys_audit', `A write covering ${g.cis.length.toLocaleString('en-US')} CI(s) on ${g.day} by ${g.who} DID change attributes (${g.withDeltas.toLocaleString('en-US')} of them left audit rows), so it was a migration and not a no-op touch — exempt`);
  }
  if (!bulkScope.length) {
    for (const r of ['CMDB-142', 'CMDB-143']) skip(r, 'cmdb_ci', 'No in-scope CI to group by write');
  } else {
    ctx.kpis.push({
      rule_id: 'CMDB-143',
      pass_pct: 100 - bulkPct,
      numerator: bulkScope.length - bulkTouched.size,
      denominator: bulkScope.length,
      basis: `CIs whose most recent write is NOT part of a mass touch — the passing half. A mass touch is one writer, on one day, covering at least ${opt.bulkTouchSharePct}% of in-scope CIs (${minGroup.toLocaleString('en-US')} here). ${pct1(bulkPct)}% of CIs sit in one, against a ${opt.bulkTouchCeilingPct}% ceiling.`,
      alerts: auditRead
        ? `${migrations.length} write(s) were exempted as genuine migrations because their CIs changed attributes.`
        : 'Attribute deltas could not be checked: sys_audit is opt-in and was not read, so a genuine migration cannot be told from a no-op touch here.',
    });
    if (bulkPct > opt.bulkTouchCeilingPct) {
      ctx.addCatalogued('CMDB-143', 'cmdb_ci', [], ['sys_updated_on'],
        `${bulkTouched.size.toLocaleString('en-US')} of ${bulkScope.length.toLocaleString('en-US')} CIs (${pct1(bulkPct)}%) were last written by a mass touch rather than by anything that confirmed them, past the ${opt.bulkTouchCeilingPct}% ceiling. ${candidates.length === 1 ? 'One write' : `${candidates.length} writes`} account for it: ${candidates.slice(0, 3).map((g) => `${g.day} by ${g.who} (${g.cis.length.toLocaleString('en-US')} CIs)`).join(', ')}. These timestamps carry no change information: a write that altered nothing tells you when a job ran, not whether the record is still true. Every state inference downstream of them — is this CI stale, is it maintained, should it be retired — is drawn from a signal that is not there, so this gates as a TRUST precondition rather than counting as a quality score.`,
        { agent: 'freshness_agent',
          evidence: candidates.slice(0, 5).map((g) => fact('cmdb_ci', `${g.day} · ${g.who}`, `${g.cis.length} CIs`, 'one writer, one day')),
          guard: { evaluated: auditRead, note: auditRead ? 'Migrations with real attribute deltas were excluded before this ratio was taken.' : 'sys_audit is opt-in and was not read, so a migration cannot be told from a no-op touch. Enable it for this estate to make the distinction.' } });
    }
  }
  if (bulkTouched.size) {
    skip('CMDB-075', 'cmdb_ci', `${bulkTouched.size.toLocaleString('en-US')} CI(s) are hidden from this rule by a mass write: their sys_updated_on moved without anything confirming them, so they can never look untouched again. CMDB-142 charges them instead, which is why they are not counted here as well.`);
  }

  /* ── CMDB-076 — freshness per ATTRIBUTE, which record dates overstate ─── */
  if (!lastUpdate.length) {
    skip('CMDB-076', 'cmdb_datasource_last_update', `Attribute-level last-seen metadata is not maintained on this instance (cmdb_datasource_last_update is empty and cmdb_metadata does not exist), so the age of each source's last report per attribute cannot be measured — reported as a gap, per the rule's own guard. It matters here more than usual: ${busiest ? `${busiest[1].toLocaleString('en-US')} of ${bulkScope.length.toLocaleString('en-US')} CIs (${pct1(bulkPct)}%) were last written by a mass touch, the largest on ${busiest[0]}` : 'record dates are spread'}, and ${ctx.measures.record_freshness.script_last_writer.toLocaleString('en-US')} CI(s) were last written by a script account, so record-level freshness reads as almost perfect while no individual attribute has been confirmed by anything.`);
  } else {
    const byAttr = new Map();
    for (const r of lastUpdate) {
      const key = `${val(r, 'class') || 'cmdb_ci'}.${val(r, 'attribute')}`;
      const seen = parseDate(r.updated_on);
      if (!val(r, 'attribute') || !seen) continue;
      if (!byAttr.has(key) || seen > byAttr.get(key).seen) byAttr.set(key, { seen, row: r });
    }
    const stale = [...byAttr.entries()].filter(([, v]) => days(v.seen) > opt.untouchedDays);
    const passPct = byAttr.size ? (100 * (byAttr.size - stale.length)) / byAttr.size : null;
    if (passPct == null) {
      skip('CMDB-076', 'cmdb_datasource_last_update', 'The attribute metadata holds no usable attribute-and-timestamp pair, so there is no per-attribute age to report');
    } else {
      ctx.kpis.push({
        rule_id: 'CMDB-076',
        pass_pct: passPct,
        numerator: byAttr.size - stale.length,
        denominator: byAttr.size,
        basis: `class attributes whose most recent source report is inside ${opt.untouchedDays} days, measured per attribute rather than per record`,
        alerts: `Contrast with record-level freshness: ${busiest ? `${pct1(bulkPct)}% of CIs were last written by a mass touch` : 'record dates are spread'}.`,
      });
      if (stale.length) {
        ctx.addCatalogued('CMDB-076', 'cmdb_ci', [], ['sys_class_name'],
          `${stale.length} of ${byAttr.size} tracked attributes have not been reported by any source for more than ${opt.untouchedDays} days — worst first: ${stale.sort((a, b) => b[1].seen - a[1].seen).slice(0, 5).map(([k, v]) => `${k} (${days(v.seen)}d)`).join(', ')}. The records holding them look fresh, because something else on the record moved.`,
          { agent: 'freshness_agent',
            evidence: stale.slice(0, 5).map(([k, v]) => fact('cmdb_datasource_last_update', k, v.row.updated_on, `${days(v.seen)} days since any source reported it`)),
            guard: { evaluated: true, note: 'Attributes nothing is supposed to report (free-text notes, manual classifications) will always look stale here. Scope to the attributes a source owns.' } });
      }
    }
  }

  /* ── CMDB-077 — only scripts have touched it ──────────────────────────── */
  /*
   * NOT APPROXIMATED FROM `sys_updated_by` (decision 6 of Sep 2026, applied
   * again). The CI keeps only its LAST updater, and this rule asks whether EVERY
   * update in the window was a script — two different questions with the same
   * column. On dev424910 the gap is not academic: 2,661 CIs were last written by
   * `system`, and firing on that would charge the estate for one bulk job.
   *
   * The real source is sys_audit. It is deliberately NOT read: it is an
   * append-only log that changes on every run, so including it would make the
   * CMDB module report "changed" on every incremental check and destroy the
   * reuse the scan planner exists for. That is a trade this build does not make
   * silently — it is a decision for the estate, stated here.
   */
  const auditRows = ctx.estate.sys_audit || [];
  if (!auditRows.length) {
    skip('CMDB-077', 'sys_audit', `The update history is not read, so "every update in the window was a script" cannot be told from "the last one was" — cmdb_ci keeps only sys_updated_by. ${ctx.measures.record_freshness.script_last_writer.toLocaleString('en-US')} of ${allCis.length.toLocaleString('en-US')} CI(s) were LAST written by a script account, which is the observation, not the finding. Measuring the rule as written needs sys_audit, an append-only log that changes on every run and would stop the CMDB module ever reusing a scan; that trade is the estate's to make, not this build's — pass 'sys_audit' in the scan's table list to make it.`);
  } else {
    const byCi = new Map();
    for (const a of auditRows) {
      const id = a.documentkey;
      if (!id) continue;
      if (!byCi.has(id)) byCi.set(id, []);
      byCi.get(id).push(a);
    }
    const cutoff = now.getTime() - opt.scriptOnlyDays * DAY_MS;
    for (const c of cisFor('CMDB-077')) {
      const history = (byCi.get(c.sys_id) || []).filter((a) => { const d = parseDate(a.sys_created_on); return d && d.getTime() >= cutoff; });
      if (!history.length) continue;
      if (!history.every((a) => isScriptAccount(a.user))) continue;
      if (parseDate(c.last_discovered)) continue;           // discovery HAS confirmed it
      const writers = [...new Set(history.map((a) => a.user))];
      perRecord('CMDB-077', [c], ['name', 'sys_class_name', 'sys_updated_by'],
        `Every one of the ${history.length} recorded changes to ${label(c)} in the last ${opt.scriptOnlyDays} days came from a script or integration account (${writers.join(', ')}), and no discovery has ever confirmed it. An integration keeping a record warm is not the same as something checking whether it is true — the CI looks maintained and is only being rewritten.`,
        { confidence: 0.9,
          evidence: [
            fact('sys_audit', 'writers', writers.join(', '), `${history.length} changes in ${opt.scriptOnlyDays} days`),
            fact('cmdb_ci', 'last_discovered', val(c, 'last_discovered') || '(empty)', 'discovery confirmation'),
          ],
          guard: { evaluated: false, note: `Integration-managed classes (cloud resources, SaaS) are supposed to look like this. The accounts counted as scripts were resolved from this estate's own writers: ${[...scriptAccounts].join(', ') || 'none'} — correct the seed per estate before acting.` } });
    }
  }

  /* ── CMDB-078 / CMDB-079 — provenance of the creation itself ──────────── */
  /*
   * These two share one problem. A CI created by an import and a CI typed in by
   * hand look identical once the import set rows are gone — and they are gone
   * here (sys_import_set and sys_import_set_row are both empty, as they are on
   * any instance with a retention policy). So the manual share is reported as an
   * UPPER BOUND and says so, and the import share is not reported at all rather
   * than reported as zero. Zero would be a lie about a purge.
   */
  const createScope = cisFor('CMDB-078');
  const importAttributed = attribution.filter((r) => /import|transform/i.test(val(r, 'source_feed') || val(r, 'name'))).length;
  const manualCreated = createScope.filter((c) => !isScriptAccount(c.sys_created_by) && !claimsSource(c) && !parseDate(c.first_discovered));
  if (!createScope.length) {
    for (const r of ['CMDB-078', 'CMDB-079']) skip(r, 'cmdb_ci', 'No in-scope CI to attribute a creation to');
  } else {
    const manualPct = (100 * manualCreated.length) / createScope.length;
    ctx.kpis.push({
      rule_id: 'CMDB-078',
      pass_pct: 100 - manualPct,
      numerator: createScope.length - manualCreated.length,
      denominator: createScope.length,
      basis: `CIs with provenance beyond a manual create — the passing half. A CI counts as manual-only when its sys_created_by is not one of the ${scriptAccounts.size} script account(s) resolved from this estate's own writers (${[...scriptAccounts].join(', ') || 'none'}), it carries no automated discovery_source, and it has never been discovered. ${pct1(manualPct)}% qualify, against a ${opt.manualOnlyPct}% ceiling.`,
      alerts: `UPPER BOUND: import-set evidence is ${ctx.estate.sys_import_set_row ? 'absent' : 'not read'} on this instance, so a CI created by an import whose rows have been purged is counted here as manual. ${importAttributed} CI(s) carry import attribution in sys_object_source.`,
    });
    if (manualPct > opt.manualOnlyPct) {
      ctx.addCatalogued('CMDB-078', 'cmdb_ci', [], ['sys_class_name'],
        `${manualCreated.length.toLocaleString('en-US')} of ${createScope.length.toLocaleString('en-US')} CIs (${pct1(manualPct)}%) have no provenance beyond someone creating them, past the ${opt.manualOnlyPct}% ceiling. Nothing has confirmed them since: they are as accurate as the day they were typed, and they age without anything saying so. This is an upper bound — purged import sets are counted here as manual.`,
        { agent: 'freshness_agent',
          evidence: [
            fact('cmdb_ci', 'manual-only', `${manualCreated.length} of ${createScope.length}`, 'no script creator, no automated source, never discovered'),
            fact('cmdb_ci', 'top creators', [...manualCreated.reduce((m, c) => m.set(val(c, 'sys_created_by') || 'unknown', (m.get(val(c, 'sys_created_by') || 'unknown') || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([u, n]) => `${u} (${n})`).join(', '), 'who created them'),
          ],
          guard: { evaluated: false, note: `Classes where manual entry is the only possible source (business services, contracts, locations) belong in the exclusion list rather than in this ratio. The ${scriptAccounts.size} account(s) counted as scripts on this estate, resolved from its own writers: ${[...scriptAccounts].join(', ') || 'none'}. Correct the list before acting on the ratio.` } });
    }
    if (!importAttributed) {
      skip('CMDB-079', 'sys_import_set_row', 'No CI on this instance can be attributed to an import: the import set tables are empty (they are purged on a schedule on every instance) and no source attribution names an import feed. Reporting 0% import-sourced would state as a measurement what is actually a retention policy — and it is the same missing evidence that makes CMDB-078 an upper bound rather than a count.');
    } else {
      const importOnly = createScope.filter((c) => attribution.some((r) => r.target_sys_id === c.sys_id && /import|transform/i.test(val(r, 'source_feed') || val(r, 'name')))
        && !parseDate(c.first_discovered));
      const importPct = (100 * importOnly.length) / createScope.length;
      ctx.kpis.push({
        rule_id: 'CMDB-079',
        pass_pct: 100 - importPct,
        numerator: createScope.length - importOnly.length,
        denominator: createScope.length,
        basis: `CIs with provenance beyond an import — the passing half. ${pct1(importPct)}% were created by an import and never confirmed by any other source, against a ${opt.importOnlyPct}% ceiling.`,
      });
      if (importPct > opt.importOnlyPct) {
        ctx.addCatalogued('CMDB-079', 'cmdb_ci', [], ['sys_class_name'],
          `${importOnly.length.toLocaleString('en-US')} of ${createScope.length.toLocaleString('en-US')} CIs (${pct1(importPct)}%) came from an import set and nothing has confirmed them since, past the ${opt.importOnlyPct}% ceiling. An import is a snapshot of someone else's spreadsheet: it was true when it ran, and the CMDB has been asserting it ever since.`,
          { agent: 'freshness_agent',
            evidence: [fact('sys_object_source', 'import-sourced', `${importOnly.length} of ${createScope.length}`, 'created by an import feed, never discovered')],
            guard: { evaluated: false, note: 'An import that still runs from an authoritative external system is a maintained source, not a stale one. Check whether the feed is live before treating these as unconfirmed.' } });
      }
    }
  }

  if (inactiveCis.length) {
    skip('CMDB-075', 'cmdb_ci', `${inactiveCis.length} retired, stolen or absent CI(s) are outside this dimension's QUALITY rules — a decommissioned CI nobody rediscovers is doing what it should. The contradiction rules here (CMDB-073, CMDB-076) did judge them, and ${stillDiscovered.length} dead CI(s) that discovery is STILL finding are recorded in measures.retired_still_discovered for CMDB-087 in D8.`);
  }
}
