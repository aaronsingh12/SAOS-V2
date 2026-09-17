import { modifiersFor, lineageOf, dqActive, cisForRule, DQ_INACTIVE_INSTALL_STATUS } from './cmdb-signals.js';
import { parseDate } from './time.js';

/**
 * GROUP 13 — SCALE AND PLATFORM IMPACT. CMDB-124 to CMDB-130.
 *
 * ═══ A PLATFORM INDICATOR, NEVER IN THE COMPOSITE ═══
 *
 * Every rule here sits on the `platform` track with no dimension, so none of it
 * moves the CMDB quality score. That routing was settled when the groups were
 * first laid out and it is worth restating: this group does not measure whether
 * the DATA is right, it measures whether the CMDB has grown into a shape the
 * PLATFORM struggles with. Those are different questions with different owners —
 * a perfectly accurate CMDB can still be the reason a list view times out — and
 * folding one into the other would let a platform problem disguise itself as a
 * data problem, or the reverse.
 *
 * ═══ THESE RULES ARE THE MOST LIKELY TO BE SUPERLINEAR THEMSELVES ═══
 *
 * A rule about scale that scans everything to find out is the joke telling
 * itself. Each rule here is written against a COUNT or an AGGREGATE wherever
 * one will do, and where a per-record walk is unavoidable it is bounded and
 * single-pass. `ctx.measures.scale_timings` records the wall time of each rule
 * so a regression shows up as a number rather than as a slow scan somebody
 * eventually notices.
 *
 * ═══ WHAT THIS INSTANCE KEEPS (verified on dev424910, Sep 2026) ═══
 *
 *   syslog_transaction   292,530 rows — by far the largest table in play, which
 *                        is why CMDB-126 never reads it per record.
 *   sys_audit            43,337 rows; sys_audit_delete 729.
 *   sys_history_line     97; sys_history_set 35.
 *   sys_table_rotation   40 rotation rules.
 *   sys_db_index         DOES NOT EXIST on this version, and `sys_index` is
 *                        refused to admin ("may not read sys_index"). CMDB-127
 *                        therefore cannot see indexes at all and says so —
 *                        reporting "no index" from a table we are forbidden to
 *                        read would be reporting our own access as a defect.
 *   No archive rule covers sys_audit or any sys_history table.
 *
 * TRENDS ABSTAIN UNTIL THEY HAVE A BASELINE. CMDB-125 needs 2 snapshots and
 * CMDB-128 needs 3, per the catalogue. They record their snapshot and say how
 * many they have — "no growth observed" and "no growth" are different findings.
 *
 * PURE — no network, no database.
 */

export const SCALE_RULES = Object.freeze([
  'CMDB-124', 'CMDB-125', 'CMDB-126', 'CMDB-127', 'CMDB-128', 'CMDB-129', 'CMDB-130',
]);

/** Declared tracks — checked against the catalogue every run by `trackMisroutes`. */
export const SCALE_TRACKS = Object.freeze(Object.fromEntries(SCALE_RULES.map((id) => [id, { scored: false }])));

export const SCALE_DEFAULTS = Object.freeze({
  dqInactiveInstallStatus: DQ_INACTIVE_INSTALL_STATUS,
  /*
   * CMDB-124 — expected edges per CI, PER TIER. Per-estate settings, both of them.
   *
   * The first version combined every tier into one estate-wide expectation,
   * weighted by CI COUNT — and on dev424910 the 1,767 software packages, at the
   * `other` default of one edge each, set 0.92 edges/CI almost single-handed.
   * The finding was measuring the parameter, not the estate. So:
   *
   *   (a) software and logical classes are seeded to ZERO expected edges — a
   *       software package is an inventory row, not a node in a dependency map;
   *   (b) each tier is judged against ITS OWN expectation, and the estate verdict
   *       weights tiers by EXPECTED EDGE MASS (CIs × expected edges), so a
   *       high-count, zero-expectation tier carries no weight at all rather than
   *       dragging the whole estate's bar down to its own floor;
   *   (c) the tier that dominates the verdict is named when the rule fires, so
   *       the reader can see which parameter the finding rests on.
   *
   * ENDPOINTS EXPECT ZERO TOO (decided 17 Sep 2026). With (a)–(c) in place the
   * endpoint tier at 0.5 per laptop became 421.5 of the 795.5 expected edges on
   * dev424910, and the verdict flipped on that one number: 0.277 "far below"
   * with it, 0.575 inside the band without it. Almost no estate maps a laptop's
   * relationships, and one that does not was never expected to — so the default
   * is 0, and every tier set to 0 is NAMED in the result with the edges it
   * carries anyway, so an estate that does model them can raise it and re-run.
   *
   * This is the principle ARCHITECTURE §16.8 names: a class's expected data is
   * a function of what that class is for, and absence is a defect only where
   * presence was warranted. D6 orphan scoping and D9 ownership scoping are the
   * same idea applied to records.
   */
  edgesPerCiByTier: Object.freeze({ hub: 6, host: 3, application: 3, infrastructure: 2, endpoint: 0, software: 0, other: 1 }),
  scaleTierClasses: Object.freeze({
    hub: Object.freeze(['cmdb_ci_netgear', 'cmdb_ci_ip_switch', 'cmdb_ci_ip_router', 'cmdb_ci_lb', 'cmdb_ci_cluster']),
    host: Object.freeze(['cmdb_ci_server', 'cmdb_ci_virtualization_server']),
    application: Object.freeze(['cmdb_ci_appl', 'cmdb_ci_db_instance', 'cmdb_ci_web_server']),
    infrastructure: Object.freeze(['cmdb_ci_ups', 'cmdb_ci_rack', 'cmdb_ci_zone', 'cmdb_ci_storage_device']),
    endpoint: Object.freeze(['cmdb_ci_pc_hardware', 'cmdb_ci_printer', 'cmdb_ci_phone', 'cmdb_ci_computer']),
    software: Object.freeze(['cmdb_ci_spkg', 'cmdb_ci_software_instance', 'cmdb_ci_licence', 'cmdb_ci_license', 'cmdb_ci_config_file', 'cmdb_ci_config_file_tracked']),
  }),
  ratioTolerance: 0.5,
  minCisForRatio: 50,
  /* CMDB-125 / CMDB-128 — snapshots before a trend means anything. */
  minGrowthSnapshots: 2,
  minTrendSnapshots: 3,
  /* CMDB-126 — a transaction above this is slow. */
  slowTransactionMs: 2000,
  slowPercentile: 95,
  /* CMDB-127 — a class this large wants an index behind its queries. */
  largeClassRows: 10_000,
  /* CMDB-130 — the history and audit tables a CMDB fills up. */
  historyTables: Object.freeze(['sys_audit', 'sys_history_line', 'sys_history_set', 'sys_audit_delete']),
});

const pct1 = (n) => Number(n.toFixed(1));
const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
const val = (r, f) => String(r?.[f] ?? '').trim();

export function cmdbScaleRules(ctx, options = {}) {
  const opt = { ...SCALE_DEFAULTS, ...options };
  const now = ctx.now;
  const meta = ctx.meta?.cmdb || {};
  const signals = ctx.signals;
  const skip = (rule, table, reason) => ctx.skipped.push({ rule, table, reason });
  const hierarchyOk = meta.reads?.class_hierarchy?.status === 'ok';
  const line = (cls) => lineageOf(meta, cls || 'cmdb_ci');
  const allCis = ctx.estate.cmdb_ci || [];
  const { active: activeCis } = dqActive(allCis, opt.dqInactiveInstallStatus);
  const cisFor = (rule) => cisForRule(rule, { all: allCis, active: activeCis });
  const fact = (table, field, value, reason) => ({
    source: 'ServiceNow Table/Aggregate REST API', sn_table: table, sn_sys_id: null,
    field_name: field, field_value: String(value), reason, collected_at: now.toISOString(),
  });
  const scale = (rule, table, records, fields, description, extra = {}) => {
    const m = modifiersFor(records, signals);
    return ctx.addCatalogued(rule, table, records, fields, description, {
      agent: 'performance_agent', escalators: m.escalators, deEscalators: m.deEscalators, notEvaluated: m.notEvaluated, ...extra,
    });
  };
  ctx.measures ||= {};

  /*
   * PER-RULE TIMING. A rule about scale that is itself superlinear is the joke
   * telling itself, so each one is timed and the numbers are published.
   */
  const timings = {};
  const timed = (rule, fn) => {
    const t0 = Date.now();
    try { return fn(); } finally { timings[rule] = Date.now() - t0; }
  };

  const ciOk = ctx.complete('cmdb_ci', ['sys_class_name']);
  if (!ciOk) {
    for (const r of SCALE_RULES) skip(r, 'cmdb_ci', 'The CIs were not read completely — a scale rule over a partial estate measures our own access rather than the estate\'s size');
    return;
  }

  /* ONE PASS over the CIs, shared by every rule below. */
  const byClass = new Map();
  for (const c of allCis) byClass.set(c.sys_class_name, (byClass.get(c.sys_class_name) || 0) + 1);
  const tierKeys = Object.keys(opt.scaleTierClasses);
  const tiers = Object.fromEntries([...tierKeys, 'other'].map((t) => [t, 0]));
  const tierOfClass = new Map();
  for (const [cls, n] of byClass) {
    const lineage = hierarchyOk ? line(cls) : [cls];
    const tier = tierKeys.find((t) => opt.scaleTierClasses[t].some((root) => lineage.includes(root))) || 'other';
    tierOfClass.set(cls, tier);
    tiers[tier] += n;
  }

  /* ── CMDB-124 — edges per CI, judged PER TIER and weighted by expected mass ── */
  timed('CMDB-124', () => {
    const relOk = ctx.complete('cmdb_rel_ci', ['parent', 'child']);
    if (!relOk) {
      skip('CMDB-124', 'cmdb_rel_ci', 'The relationships were not read completely, so the ratio would be of our access rather than of the estate');
      return;
    }
    const rels = ctx.estate.cmdb_rel_ci || [];
    const cis = allCis.length;
    if (cis < opt.minCisForRatio) {
      skip('CMDB-124', 'cmdb_ci', `${cis} CI(s) is too few for a ratio to mean anything (floor ${opt.minCisForRatio}) — one edge moves it too far`);
      return;
    }
    /*
     * Each edge is shared by its two ends, so half of it is attributed to each
     * end's tier. The tiers' attributed edges therefore sum to the edges whose
     * ends are in the estate, and a tier's "edges per CI" means the same thing
     * the estate-wide figure always meant.
     */
    const classOf = new Map(allCis.map((c) => [c.sys_id, c.sys_class_name]));
    const actual = Object.fromEntries(Object.keys(tiers).map((t) => [t, 0]));
    for (const e of rels) {
      for (const end of [e.parent, e.child]) {
        const cls = classOf.get(end);
        if (!cls) continue;
        actual[tierOfClass.get(cls) || 'other'] += 0.5;
      }
    }
    const rows = Object.keys(tiers).filter((t) => tiers[t] > 0).map((t) => {
      const perCi = opt.edgesPerCiByTier[t] ?? opt.edgesPerCiByTier.other;
      const expectedEdges = tiers[t] * perCi;
      const ratio = expectedEdges > 0 ? actual[t] / expectedEdges : null;
      return {
        tier: t, cis: tiers[t], expected_per_ci: perCi, expected_edges: expectedEdges,
        actual_edges: actual[t], ratio,
        in_band: ratio == null ? null : ratio >= 1 - opt.ratioTolerance && ratio <= 1 + opt.ratioTolerance,
      };
    });
    const judged = rows.filter((r) => r.expected_edges > 0);
    const massTotal = judged.reduce((n, r) => n + r.expected_edges, 0);
    if (!massTotal) {
      skip('CMDB-124', 'cmdb_ci', 'Every populated tier on this estate is configured to expect zero edges, so there is no expectation to compare the relationship count against');
      return;
    }
    /* The estate ratio, weighted by the edges each tier is expected to carry. */
    const estateRatio = judged.reduce((n, r) => n + r.expected_edges * r.ratio, 0) / massTotal;
    const inBand = estateRatio >= 1 - opt.ratioTolerance && estateRatio <= 1 + opt.ratioTolerance;
    /* The tier the verdict rests on: the largest share of the weighted deviation. */
    const dominant = [...judged].sort((a, b) => (b.expected_edges * Math.abs(1 - b.ratio)) - (a.expected_edges * Math.abs(1 - a.ratio)))[0];
    const ignored = rows.filter((r) => r.expected_edges === 0);
    ctx.measures.scale_ratio = {
      cis, edges: rels.length, estate_ratio: Number(estateRatio.toFixed(3)),
      band: [1 - opt.ratioTolerance, 1 + opt.ratioTolerance],
      dominant_tier: dominant.tier,
      tiers: rows.map((r) => ({ ...r, ratio: r.ratio == null ? null : Number(r.ratio.toFixed(3)), actual_edges: Number(r.actual_edges.toFixed(1)) })),
    };
    const describe = (r) => `${r.tier}: ${r.cis.toLocaleString('en-US')} CIs expecting ${r.expected_per_ci}/CI = ${r.expected_edges.toLocaleString('en-US')} edges, carrying ${r.actual_edges.toFixed(1)} (${(100 * r.ratio).toFixed(0)}%)`;
    /* Self-disclosure: a tier left out of the verdict is named, with its setting
       and whatever it carries anyway, so "not judged" is never read as "fine". */
    const ignoredNote = ignored.length
      ? ` NOT JUDGED: ${ignored.map((r) => `${r.cis.toLocaleString('en-US')} ${r.tier} CI(s)${r.actual_edges ? ` (carrying ${r.actual_edges.toFixed(1)} edge(s) anyway)` : ''}`).join(', ')} — ${ignored.map((r) => `edgesPerCiByTier.${r.tier}`).join(' and ')} set to 0 expected edges, because an estate is not charged for relationships it was never expected to model. Raise the setting and re-run if you model them.`
      : '';
    if (inBand) {
      skip('CMDB-124', 'cmdb_rel_ci', `The estate carries ${(100 * estateRatio).toFixed(0)}% of the relationships its tiers predict, weighted by what each tier is expected to carry — inside the ${Math.round(100 * (1 - opt.ratioTolerance))}–${Math.round(100 * (1 + opt.ratioTolerance))}% band. Evaluated, with nothing to report.${ignoredNote}`);
      return;
    }
    const below = estateRatio < 1 - opt.ratioTolerance;
    const outOfBand = judged.filter((r) => !r.in_band);
    scale('CMDB-124', 'cmdb_rel_ci', [], ['parent'],
      `This estate carries ${(100 * estateRatio).toFixed(0)}% of the relationships its own class mix predicts — ${below ? 'FAR BELOW' : 'far above'} the ${Math.round(100 * (1 - opt.ratioTolerance))}–${Math.round(100 * (1 + opt.ratioTolerance))}% band. ${below ? 'A graph this sparse cannot answer an impact question, whatever the records say.' : 'A graph this dense makes every traversal expensive, and the platform pays for it on every impact calculation.'}\n\nTHE VERDICT RESTS MOSTLY ON THE ${dominant.tier.toUpperCase()} TIER — ${describe(dominant)}. That tier's expectation (edgesPerCiByTier.${dominant.tier} = ${dominant.expected_per_ci}) is a per-estate setting; if it does not fit this estate, change it before acting on this finding.${ignoredNote}\n\nPer tier, weighted by expected edges: ${judged.map(describe).join('; ')}.`,
      { confidence: 0.85,
        evidence: [
          fact('cmdb_rel_ci', 'estate ratio', `${(100 * estateRatio).toFixed(0)}%`, `weighted by expected edge mass across ${judged.length} tier(s)`),
          fact('cmdb_ci', 'dominant tier', dominant.tier, describe(dominant)),
          ...outOfBand.slice(0, 6).map((r) => fact('cmdb_ci', `${r.tier} tier`, `${(100 * r.ratio).toFixed(0)}% of expected`, describe(r))),
          ...ignored.map((r) => fact('cmdb_ci', `${r.tier} tier`, 'not judged', `edgesPerCiByTier.${r.tier} = 0; ${r.cis} CI(s) carrying ${r.actual_edges.toFixed(1)} edge(s)`)),
        ],
        guard: { evaluated: true, note: 'Each tier is judged against its own expectation and weighted by the edges it is expected to carry, so a large population of classes that expect no relationships (software packages) cannot set the bar for the estate.' } });
  });

  /* ── CMDB-125 / CMDB-128 / CMDB-129 — growth, which needs snapshots ────── */
  timed('CMDB-129', () => {
    /* The measure the two trend rules read, recorded every run. */
    const snapshot = { at: now.toISOString(), cis: allCis.length, edges: (ctx.estate.cmdb_rel_ci || []).length, classes: [...byClass.entries()].map(([cls, n]) => ({ cls, cis: n })) };
    ctx.measures.scale_snapshot = snapshot;
    const history = (ctx.history?.scale_snapshot || []).filter((h) => h && parseDate(h.at));
    const ranked = [...byClass.entries()].sort((a, b) => b[1] - a[1]);
    const prev = history.length ? history[history.length - 1] : null;
    const growth = prev
      ? ranked.map(([cls, n]) => ({ cls, cis: n, was: (prev.classes || []).find((c) => c.cls === cls)?.cis ?? null }))
        .map((x) => ({ ...x, delta: x.was == null ? null : x.cis - x.was }))
      : ranked.map(([cls, n]) => ({ cls, cis: n, was: null, delta: null }));
    ctx.measures.class_sizes = growth.slice(0, 50);
    scale('CMDB-129', 'cmdb_ci', [], ['sys_class_name'],
      `${allCis.length.toLocaleString('en-US')} CIs across ${byClass.size} class(es), largest first: ${ranked.slice(0, 5).map(([cls, n]) => `${cls} (${n.toLocaleString('en-US')})`).join(', ')}.${prev ? ` Against the previous snapshot of ${prev.at.slice(0, 10)}: ${growth.filter((g) => g.delta).slice(0, 4).map((g) => `${g.cls} ${g.delta > 0 ? '+' : ''}${g.delta}`).join(', ') || 'no class changed size'}.` : ' This is the first snapshot, so there is no growth to report yet — the next run compares against it.'} A measure, not a threshold: this deducts nothing and exists so the shape of the estate is visible.`,
      { confidence: 1.0,
        evidence: ranked.slice(0, 20).map(([cls, n]) => fact('cmdb_ci', cls, n, prev ? `was ${(prev.classes || []).find((c) => c.cls === cls)?.cis ?? 'absent'}` : 'first snapshot')),
        guard: { evaluated: true, note: 'The catalogue names no false positive — this is a measure.' } });
  });

  timed('CMDB-125', () => {
    const history = (ctx.history?.scale_snapshot || []).filter((h) => h && parseDate(h.at));
    const snapshots = history.length + 1;
    const deviceHistory = (ctx.estate.discovery_device_history || []).length;
    if (snapshots < opt.minGrowthSnapshots) {
      skip('CMDB-125', 'cmdb_ci', `NOT MEASURED — growth needs ${opt.minGrowthSnapshots} snapshots and this run holds ${snapshots}. A class that is growing without discovery behind it is a trend, and one reading cannot show a trend: "no growth observed" and "no growth" are different findings, so this abstains rather than reporting the estate as stable.`);
      return;
    }
    const prev = history[history.length - 1];
    const grown = [...byClass.entries()]
      .map(([cls, n]) => ({ cls, cis: n, was: (prev.classes || []).find((c) => c.cls === cls)?.cis ?? 0 }))
      .filter((x) => x.cis > x.was);
    if (!grown.length) {
      skip('CMDB-125', 'cmdb_ci', `No class grew between ${prev.at.slice(0, 10)} and now — evaluated, with nothing to report`);
      return;
    }
    if (deviceHistory === 0) {
      scale('CMDB-125', 'cmdb_ci', [], ['sys_class_name'],
        `${grown.length} class(es) grew since ${prev.at.slice(0, 10)} — ${grown.slice(0, 4).map((g) => `${g.cls} +${g.cis - g.was}`).join(', ')} — and NO discovery activity is recorded on this instance at all (discovery_device_history is empty). Something is creating CIs and it is not discovery: an import, an integration or a person, none of which will correct the record when the thing changes.`,
        { confidence: 0.9,
          evidence: grown.slice(0, 10).map((g) => fact('cmdb_ci', g.cls, `+${g.cis - g.was}`, `${g.was} → ${g.cis} since ${prev.at.slice(0, 10)}`)),
          guard: { evaluated: false, note: 'A legitimate non-discovery source for that class — a cloud API, a CMDB feed — produces exactly this pattern. Name the source before treating it as unmanaged growth.' } });
    } else {
      skip('CMDB-125', 'discovery_device_history', `${grown.length} class(es) grew, and ${deviceHistory.toLocaleString('en-US')} discovery run(s) are recorded — the growth has discovery behind it, which is what this rule wanted to see`);
    }
  });

  timed('CMDB-128', () => {
    const history = (ctx.history?.scale_snapshot || []).filter((h) => h && parseDate(h.at));
    const series = [...history, ctx.measures.scale_snapshot].filter(Boolean);
    if (series.length < opt.minTrendSnapshots) {
      skip('CMDB-128', 'cmdb_rel_ci', `NOT MEASURED — a relationship growth RATE needs ${opt.minTrendSnapshots} snapshots to be a trend rather than a difference, and this run holds ${series.length}. It abstains rather than reporting a rate from two points.`);
      return;
    }
    const first = series[0];
    const last = series[series.length - 1];
    const days = Math.max(1, (parseDate(last.at) - parseDate(first.at)) / 86_400_000);
    const edgeRate = (last.edges - first.edges) / days;
    const ciRate = (last.cis - first.cis) / days;
    ctx.measures.growth_rates = { days: Math.round(days), edges_per_day: Number(edgeRate.toFixed(2)), cis_per_day: Number(ciRate.toFixed(2)), snapshots: series.length };
    scale('CMDB-128', 'cmdb_rel_ci', [], ['parent'],
      /* Found by the stable-estate replay: an unchanged estate was told its
         relationships were "growing at 0.0 rows/day". Flat is said as flat. */
      !edgeRate && !ciRate
        ? `Relationships and CIs are flat across ${series.length} snapshots over ${Math.round(days)} days: ${last.edges.toLocaleString('en-US')} relationships and ${last.cis.toLocaleString('en-US')} CIs, unchanged. A measure, not a finding against the estate.`
        : `Relationships are ${edgeRate < 0 ? 'shrinking' : 'growing'} at ${Math.abs(edgeRate).toFixed(1)} rows/day over ${Math.round(days)} days and ${series.length} snapshots, against ${ciRate.toFixed(1)} CIs/day. ${edgeRate > 0 && ciRate <= 0 ? 'Edges are being added to an estate that is not growing, which is either a mapping rollout or a loop.' : 'Reported alongside CI growth, because an edge count means nothing without the CI count beside it.'}`,
      { confidence: 1.0,
        evidence: [
          fact('cmdb_rel_ci', 'edges/day', edgeRate.toFixed(2), `${first.edges} → ${last.edges} over ${Math.round(days)} days`),
          fact('cmdb_ci', 'CIs/day', ciRate.toFixed(2), `${first.cis} → ${last.cis}`),
        ],
        guard: { evaluated: false, note: 'An active service-mapping rollout legitimately adds edges fast. Check whether one is running.' } });
  });

  /* ── CMDB-126 — slow transactions against CI tables ────────────────────── */
  timed('CMDB-126', () => {
    const txRead = ctx.complete('syslog_transaction', ['url', 'response_time']);
    if (!txRead) {
      skip('CMDB-126', 'syslog_transaction', 'Transaction logs were not read on this scan, so slow queries cannot be attributed to CI tables. The table is very large (292,530 rows on dev424910) and is deliberately not read by default — a rule about scale must not become the scale problem.');
      return;
    }
    const rows = (ctx.estate.syslog_transaction || []).filter((t) => val(t, 'table').startsWith('cmdb'));
    if (!rows.length) {
      skip('CMDB-126', 'syslog_transaction', 'No transaction in the log names a CMDB table, so none is attributable to a CI query — evaluated, with nothing to report');
      return;
    }
    const slow = rows.filter((t) => Number(t.response_time) > opt.slowTransactionMs);
    if (!slow.length) {
      skip('CMDB-126', 'syslog_transaction', `None of the ${rows.length.toLocaleString('en-US')} CMDB transaction(s) exceeded ${opt.slowTransactionMs}ms — evaluated, with nothing to report`);
      return;
    }
    const byTable = new Map();
    for (const t of slow) {
      const k = val(t, 'table');
      const cur = byTable.get(k) || { n: 0, total: 0, worst: 0 };
      cur.n += 1;
      cur.total += Number(t.response_time) || 0;
      cur.worst = Math.max(cur.worst, Number(t.response_time) || 0);
      byTable.set(k, cur);
    }
    const ranked = [...byTable.entries()].sort((a, b) => b[1].total - a[1].total);
    scale('CMDB-126', 'cmdb_ci', [], ['sys_class_name'],
      `${slow.length.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')} transactions against CMDB tables took more than ${opt.slowTransactionMs}ms, ranked by total time: ${ranked.slice(0, 4).map(([t, v]) => `${t} (${v.n}, worst ${Math.round(v.worst)}ms)`).join(', ')}. The CMDB is costing the platform time on every one of them.`,
      { confidence: 1.0,
        evidence: ranked.slice(0, 10).map(([t, v]) => fact('syslog_transaction', t, `${v.n} slow, ${Math.round(v.total)}ms total`, `worst ${Math.round(v.worst)}ms`)),
        guard: { evaluated: false, note: 'A one-off bulk operation during a migration window produces the same profile. Check the timestamps before treating it as a standing cost.' } });
  });

  /* ── CMDB-127 — a large class with nothing behind its queries ──────────── */
  timed('CMDB-127', () => {
    /*
     * INDEXES ARE NOT READABLE HERE. `sys_db_index` does not exist on this
     * version and `sys_index` is refused to admin outright. Reporting "no index"
     * from a table we are forbidden to read would be reporting our own access
     * as an estate defect — the exact failure this module exists to prevent.
     */
    const indexRead = ctx.complete('sys_db_index', ['table']) || ctx.complete('sys_index', ['table']);
    const large = [...byClass.entries()].filter(([, n]) => n >= opt.largeClassRows).sort((a, b) => b[1] - a[1]);
    if (!indexRead) {
      skip('CMDB-127', 'sys_db_index', `Index definitions cannot be read on this instance — sys_db_index does not exist on this version and sys_index is refused to the connected account. ${large.length ? `${large.length} class(es) hold ${opt.largeClassRows.toLocaleString('en-US')}+ CIs and would be worth checking` : `No class holds ${opt.largeClassRows.toLocaleString('en-US')}+ CIs on this estate`}, but reporting "no supporting index" from a table we are forbidden to read would be reporting our own access as a defect.`);
      return;
    }
    if (!large.length) {
      skip('CMDB-127', 'cmdb_ci', `No class holds ${opt.largeClassRows.toLocaleString('en-US')} or more CIs — evaluated, with nothing to report`);
      return;
    }
    const indexed = new Set((ctx.estate.sys_db_index || ctx.estate.sys_index || []).map((i) => val(i, 'table')));
    const unindexed = large.filter(([cls]) => !indexed.has(cls));
    if (!unindexed.length) {
      skip('CMDB-127', 'sys_db_index', `All ${large.length} large class(es) have at least one index — evaluated, with nothing to report`);
      return;
    }
    scale('CMDB-127', 'cmdb_ci', [], ['sys_class_name'],
      `${unindexed.length} class(es) hold ${opt.largeClassRows.toLocaleString('en-US')} or more CIs with no index recorded against them: ${unindexed.slice(0, 4).map(([cls, n]) => `${cls} (${n.toLocaleString('en-US')})`).join(', ')}. Every filtered list, every related-list load and every rule that scopes by class scans the whole table.`,
      { confidence: 0.85,
        evidence: unindexed.slice(0, 10).map(([cls, n]) => fact('cmdb_ci', cls, `${n} rows, no index`, `at or above ${opt.largeClassRows}`)),
        guard: { evaluated: false, note: 'An index deliberately omitted for write-cost reasons is a decision, not an oversight.' } });
  });

  /* ── CMDB-130 — history tables nobody clears ───────────────────────────── */
  timed('CMDB-130', () => {
    const archiveRead = ctx.complete('sys_archive', ['table', 'active']);
    const rotationRead = ctx.complete('sys_table_rotation', ['name']);
    if (!archiveRead && !rotationRead) {
      skip('CMDB-130', 'sys_archive', 'Neither the archive rules nor the rotation configuration was read, so an absent retention policy cannot be told from one we failed to read');
      return;
    }
    const archives = (ctx.estate.sys_archive || []).filter((r) => truthy(r.active));
    const destroys = (ctx.estate.sys_archive_destroy || []).filter((r) => truthy(r.active));
    const rotations = ctx.estate.sys_table_rotation || [];
    const covered = new Set([
      ...archives.map((r) => val(r, 'table')),
      ...destroys.map((r) => val(r, 'table')),
      ...rotations.map((r) => val(r, 'name')),
    ]);
    const uncovered = opt.historyTables.filter((t) => !covered.has(t));
    if (!uncovered.length) {
      skip('CMDB-130', 'sys_archive', `Every CMDB history table (${opt.historyTables.join(', ')}) is covered by a rotation or archival rule — evaluated, with nothing to report`);
      return;
    }
    const sizes = Object.fromEntries(opt.historyTables.map((t) => [t, (ctx.estate[t] || []).length || null]));
    scale('CMDB-130', 'cmdb_ci', [], ['sys_class_name'],
      `${uncovered.length} CMDB history table(s) have no rotation or archival configured: ${uncovered.join(', ')}. These tables only ever grow — every CI edit writes to them — so the cost is paid for ever and shows up as a slow instance long before anybody connects it to the CMDB.`,
      { confidence: 1.0,
        evidence: [
          ...uncovered.map((t) => fact(t, 'rotation/archival', 'none', sizes[t] != null ? `${sizes[t].toLocaleString('en-US')} row(s) read` : 'size not read on this scan')),
          fact('sys_archive', 'active rules', archives.length + destroys.length, `plus ${rotations.length} rotation rule(s)`),
        ],
        guard: { evaluated: false, note: 'Rotation handled at the instance level, outside these tables, would not appear here.' } });
  });

  ctx.measures.scale_timings = { ...timings, total_ms: Object.values(timings).reduce((a, b) => a + b, 0) };
}
