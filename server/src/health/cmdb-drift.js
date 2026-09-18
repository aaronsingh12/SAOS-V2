import { catalogueRule, effectiveBand } from './cmdb-quality.js';
import { CMDB_RULE_PREFIX, MEASURE_COMPARABILITY, TREND_RULE_INPUTS } from './cmdb-history.js';
import { parseDate } from './time.js';

/**
 * GROUP 14 — DRIFT AND REGRESSION. CMDB-131 to CMDB-138. The last CMDB group.
 *
 * ═══ A TREND TRACK: IT NEVER GATES AND NEVER SCORES ═══
 *
 * Every rule here compares THIS run with earlier ones. None of them measures the
 * estate directly, so none of them may move the composite — a score that fell
 * because last month's score was higher would be counting the same defects
 * twice. They do two other jobs instead:
 *
 *   • they report direction — net position, new duplicates, declining edges,
 *     a declining score — as posture a reader can act on; and
 *   • CMDB-132 FEEDS THE `recurred` ESCALATOR. A defect that was fixed and came
 *     back is escalated one band on the finding that recurred, which raises both
 *     its charge in its own dimension and its priority in the work list. This is
 *     the one place history changes what a CURRENT finding costs, and it is
 *     deliberately narrow: the finding must have been seen, verifiably closed,
 *     and seen again, all under the same scoring model.
 *
 * ═══ MOST OF THESE ABSTAIN ON A FRESH ESTATE, AND THAT IS CORRECT ═══
 *
 * A trend needs history, and history needs comparable snapshots. A rule that has
 * one reading says so and records the reading for the next run — it never reports
 * "stable" from a single point, because "no change observed" and "no change" are
 * different findings.
 *
 * ═══ COMPARABILITY IS THE WHOLE GAME ═══
 *
 * Measured on dev424910's own run history: two consecutive CMDB scans read 82.1
 * then 77.0 and held 11,618 then 20,954 findings. Every point and every finding of
 * that difference came from rule changes made the same week; the estate had not
 * moved. Compared naively, CMDB-137 would have reported a declining score and
 * CMDB-131 nine thousand new defects. So every rule here compares only snapshots
 * that share this run's `comparability` key (see `scoringComparability` in
 * rules.js), and when earlier snapshots exist that do NOT, it says how many and
 * why they were set aside. The filtering is not done here: `comparableHistory`
 * (cmdb-history.js) applies it by each measure's raw/derived tag before any rule
 * sees history, so these rules cannot compare across models even by mistake.
 *
 * ═══ A RETURNING-CUSTOMER CAPABILITY, NOT A FIRST-SCAN ONE ═══
 *
 * The honest cost of comparability: every rule change resets the derived
 * baseline. Recurrence and the score trend need two earlier scans under the SAME
 * rule version, so the third scan after the last rule change is the first where
 * the whole layer can evaluate — and it is dark until a rule version is frozen
 * for an engagement. "Scan" means one that READ the CMDB: a scan that finds
 * nothing changed is a verification, reuses the last result and stores no
 * snapshot, while a rule change alters the engine key and forces a full read. Nobody should expect drift detection from a first
 * engagement; `measures.trend_readiness` and every abstention say so.
 *
 * PURE — no network, no database. History arrives on `ctx.history` from
 * `cmdb-history.js`.
 */

export const DRIFT_RULES = Object.freeze([
  'CMDB-131', 'CMDB-132', 'CMDB-133', 'CMDB-134', 'CMDB-135', 'CMDB-136', 'CMDB-137', 'CMDB-138',
]);

/** Declared tracks — checked against the catalogue every run by `trackMisroutes`. */
export const DRIFT_TRACKS = Object.freeze(Object.fromEntries(DRIFT_RULES.map((id) => [id, { scored: false }])));

export const DRIFT_DEFAULTS = Object.freeze({
  /* CMDB-132 — a closure has to be SEEN before a recurrence can be: present, then absent. */
  minRecurrenceSnapshots: 2,
  /* CMDB-133 / CMDB-136 / CMDB-137 — points (including this run) before a direction is a trend. */
  minTrendPoints: 3,
  /* Below these, a movement is noise rather than a trend. */
  scoreNoisePoints: 1,
  bypassNoisePoints: 2,
  relationshipDeclinePct: 5,
  /* CMDB-138 — attestation cycles before adherence can be trended. */
  attestationCycles: 3,
});

const DAY_MS = 86_400_000;
const pct1 = (n) => Number(n.toFixed(1));
const val = (r, f) => String(r?.[f] ?? '').trim();

/* ═══ Shared: which earlier snapshots can this run be compared with ═══════ */

/* Said by every abstention that is waiting for comparable scans. */
const RETURNING = ' Drift detection is a returning-customer capability, not a first-scan one: it compares scans that read the CMDB under the same rule version, so it starts on the third such scan and restarts whenever the rules change.';

function comparison(ctx) {
  if (ctx._driftComparison) return ctx._driftComparison;
  /* Already only the snapshots under this run's key — the layer set the rest aside. */
  const comparable = ctx.history?.snapshots || [];
  const aside = ctx.history?.set_aside?.snapshots || null;
  const key = ctx.comparability?.key ?? null;
  /* Said once, identically, by every rule that set history aside. */
  const setAside = aside
    ? ` ${aside.count} earlier CMDB snapshot(s) exist but were set aside: ${aside.unkeyed ? `${aside.unkeyed} predate the comparability key, ` : ''}${aside.other_model ? `${aside.other_model} were measured with a different rule set, catalogue or blend, ` : ''}and trending across that boundary would report rule changes as changes in the estate.`
    : '';
  ctx._driftComparison = { comparable, aside, setAside, key };
  return ctx._driftComparison;
}

const cmdbFindings = (ctx) => ctx.findings.filter((f) => CMDB_RULE_PREFIX.test(String(f.rule_id || '')));

const factOf = (now) => (table, field, value, reason) => ({
  source: 'Health Assist run history', sn_table: table, sn_sys_id: null,
  field_name: field, field_value: String(value), reason, collected_at: now.toISOString(),
});

/* ═══ CMDB-132, part one — the recurrence pass, BEFORE materiality ════════ */

/**
 * Mark current findings that recurred after a verified closure, and escalate
 * them. Runs before `applyMateriality`, which recomputes every record finding's
 * charge from its modifiers — so the escalator is in place when that happens.
 *
 * A CLOSURE IS ONLY VERIFIED when the finding's own rule was producing findings
 * in the snapshot where the finding was absent. If the rule produced nothing at
 * all in that run, the absence may mean it did not run, and a recurrence built
 * on an unverified closure would escalate a defect that was never fixed.
 */
export function cmdbRecurrencePass(ctx, options = {}) {
  const opt = { ...DRIFT_DEFAULTS, ...options };
  const { comparable } = comparison(ctx);
  const withFindings = comparable.filter((s) => Array.isArray(s.findings));
  const evaluable = withFindings.length >= opt.minRecurrenceSnapshots;
  const state = { evaluable, snapshots: withFindings.length, recurring: [] };
  ctx._driftRecurrence = state;
  if (!evaluable) return state;

  const presence = withFindings.map((s) => new Set(s.findings.map((x) => x[0])));
  const rulesActive = withFindings.map((s) => new Set(s.findings.map((x) => x[1])));
  const fact = factOf(ctx.now);
  for (const f of cmdbFindings(ctx)) {
    if (!f.modifiers) continue;
    const m = f.modifiers;
    /* Evaluated now, whichever way it comes out. */
    m.not_evaluated = (m.not_evaluated || []).filter((k) => k !== 'recurred');
    let firstSeen = -1;
    let closedAt = -1;
    for (let i = 0; i < presence.length; i += 1) {
      if (presence[i].has(f.fingerprint)) {
        if (firstSeen < 0) firstSeen = i;
      } else if (firstSeen >= 0 && rulesActive[i].has(f.rule_id)) {
        closedAt = i;
      }
    }
    if (firstSeen < 0 || closedAt <= firstSeen) continue;
    if (!m.escalators.includes('recurred')) m.escalators = [...m.escalators, 'recurred'];
    const rule = catalogueRule(f.rule_id);
    if (rule) {
      const band = effectiveBand(rule.base, { escalators: m.escalators, deEscalators: m.de_escalators || [] });
      f.severity = band;
      f.deduction_severity = band;
      f.escalated_to_systemic = rule.base !== 'SYSTEMIC' && band === 'SYSTEMIC';
    }
    f.recurrence = { first_seen: withFindings[firstSeen].at, closed_at: withFindings[closedAt].at };
    f.evidence = [...(f.evidence || []), fact('health_findings', 'recurred', `first seen ${String(withFindings[firstSeen].at).slice(0, 10)}, gone ${String(withFindings[closedAt].at).slice(0, 10)}, back now`, 'the same rule and the same object, after a verified closure — escalated one band')];
    state.recurring.push({ fingerprint: f.fingerprint, rule_id: f.rule_id, title: f.title, ...f.recurrence });
  }
  return state;
}

/* ═══ The trend rules, AFTER every other CMDB rule has run ════════════════ */

export function cmdbDriftRules(ctx, options = {}) {
  const opt = { ...DRIFT_DEFAULTS, ...options };
  const now = ctx.now;
  const skip = (rule, table, reason) => ctx.skipped.push({ rule, table, reason });
  const fact = factOf(now);
  const drift = (rule, table, description, extra = {}) => ctx.addCatalogued(rule, table, [], ['sys_class_name'], description, {
    agent: 'cmdb_governance_agent', confidence: 1.0, ...extra,
  });
  ctx.measures ||= {};
  const { comparable, setAside, key } = comparison(ctx);

  /* ── THE TREND LAYER'S READINESS — a returning-customer capability, said out loud ── */
  {
    const needed = Math.max(opt.minRecurrenceSnapshots, opt.minTrendPoints - 1);
    const have = comparable.length;
    const rulesOn = (kind) => Object.entries(TREND_RULE_INPUTS).filter(([, m]) => MEASURE_COMPARABILITY[m] === kind).map(([id]) => id);
    const resets = rulesOn('derived');
    const survives = rulesOn('raw');
    const state = have >= needed ? 'live' : have > 0 ? 'partial' : 'dark';
    ctx.measures.trend_readiness = {
      state,
      comparable_earlier_scans: have,
      earlier_scans_needed: needed,
      rule_version: ctx.comparability?.rule_version ?? null,
      comparability_key: key,
      resets_on_rule_change: [...resets, 'recurred escalator'],
      survives_rule_change: survives,
      statement: `Drift detection is a RETURNING-CUSTOMER capability, not a first-scan one. ${resets.join(', ')} and the \`recurred\` escalator compare scans taken under the same rule version, so they need ${needed} earlier scans that READ the CMDB after the last rule change — the ${needed + 1}${needed + 1 === 3 ? 'rd' : 'th'} such scan under one version is the first where all of them can evaluate — and any rule change starts the count again. A scan that finds the CMDB unchanged reuses its last result and adds no reading, so a quiet estate stays dark longer (there is also nothing to trend). Do not expect drift detection in a first engagement; freeze the rule version for the engagement to get it. Raw platform counts (${survives.join(', ')}) keep their baseline across rule changes. This scan: ${have} comparable earlier scan(s) under rule version ${ctx.comparability?.rule_version ?? 'unknown'} — ${state === 'live' ? 'the layer is live' : state === 'partial' ? 'the layer is partly evaluable' : 'the layer is dark'}.`,
    };
  }

  /* ── CMDB-131 — are defects being created faster than they are resolved ── */
  {
    const prev = [...comparable].reverse().find((s) => Array.isArray(s.findings));
    if (!prev) {
      skip('CMDB-131', 'health_runs', `NOT MEASURED — net position needs one earlier comparable CMDB snapshot with its findings stored, and there is none.${setAside} This run's findings are recorded, so the next comparable run has a baseline.${RETURNING}`);
    } else {
      const current = cmdbFindings(ctx);
      const curByFp = new Map(current.map((f) => [f.fingerprint, f]));
      const prevFps = new Set(prev.findings.map((x) => x[0]));
      const gone = prev.findings.filter(([fp]) => !curByFp.has(fp));
      const rulesNow = new Set(current.map((f) => f.rule_id));
      const rulesBefore = new Set(prev.findings.map((x) => x[1]));
      /*
       * RESOLVED MEANS THE RULE LOOKED AND DID NOT FIND IT. A finding whose rule
       * produced nothing at all this run may have vanished because the rule did
       * not run, and counting that as a fix would flatter the net position.
       */
      const resolved = gone.filter(([, rule]) => rulesNow.has(rule));
      const unverified = gone.length - resolved.length;
      /*
       * CREATED MEANS THE RULE LOOKED BEFORE AND DID NOT FIND IT — the same test,
       * the other way round. A rule that produced nothing on the earlier run may
       * not have been measuring: below a volume floor (CMDB-117/118), a table
       * unread, or its findings dropped by module routing (CMDB-124…130 before the
       * Sep 2026 routing fix). Counting all of its findings as new defects would
       * charge the estate for a gap in OUR earlier measurement. The cost is the
       * mirror of the resolved guard: a rule's genuinely first defect is reported
       * as newly measured rather than created, and both counts are published.
       */
      const fresh = current.filter((f) => !prevFps.has(f.fingerprint));
      const created = fresh.filter((f) => rulesBefore.has(f.rule_id));
      const newlyMeasured = fresh.length - created.length;
      const byDomain = {};
      for (const f of created) (byDomain[f.domain || 'UNKNOWN'] ||= { created: 0, resolved: 0 }).created += 1;
      for (const [, , domain] of resolved) (byDomain[domain || 'UNKNOWN'] ||= { created: 0, resolved: 0 }).resolved += 1;
      const net = resolved.length - created.length;
      const days = Math.max(1, Math.round((now - parseDate(prev.at)) / DAY_MS));
      ctx.measures.net_position = { since: prev.at, days, created: created.length, resolved: resolved.length, unverified, newly_measured: newlyMeasured, net, by_domain: byDomain };
      if (net < 0) {
        drift('CMDB-131', 'health_findings',
          `Defects are being created faster than they are resolved: ${created.length.toLocaleString('en-US')} new against ${resolved.length.toLocaleString('en-US')} resolved in ${days} day(s) since ${String(prev.at).slice(0, 10)}, a net position of ${net.toLocaleString('en-US')}. By domain: ${Object.entries(byDomain).sort((a, b) => (a[1].resolved - a[1].created) - (b[1].resolved - b[1].created)).slice(0, 4).map(([d, v]) => `${d} ${v.resolved - v.created >= 0 ? '+' : ''}${v.resolved - v.created}`).join(', ')}.${unverified ? ` A further ${unverified.toLocaleString('en-US')} earlier finding(s) are gone but NOT counted as resolved, because their rule produced nothing this run and may not have run.` : ''}${newlyMeasured ? ` A further ${newlyMeasured.toLocaleString('en-US')} current finding(s) are NOT counted as created, because their rule produced nothing on the earlier run and may not have been measuring then.` : ''} Compared under the same scoring model only.`,
          { evidence: [
            fact('health_findings', 'created', created.length, `since ${String(prev.at).slice(0, 10)}`),
            fact('health_findings', 'resolved (verified)', resolved.length, 'gone, and their rule still ran'),
            fact('health_findings', 'gone but unverified', unverified, 'their rule produced nothing this run'),
            fact('health_findings', 'newly measured, not counted as created', newlyMeasured, 'their rule produced nothing on the earlier run'),
          ],
          guard: { evaluated: true, note: 'Compared only against a snapshot with the same comparability key, so a rule-pack change is never read as the estate getting worse.' } });
      } else {
        skip('CMDB-131', 'health_findings', `Net position is ${net >= 0 ? '+' : ''}${net.toLocaleString('en-US')} since ${String(prev.at).slice(0, 10)} (${resolved.length.toLocaleString('en-US')} resolved, ${created.length.toLocaleString('en-US')} created${newlyMeasured ? `; ${newlyMeasured.toLocaleString('en-US')} newly measured, not counted` : ''}) — evaluated, not negative`);
      }
    }
  }

  /* ── CMDB-132 — what came back (the escalation happened before materiality) ── */
  {
    const state = ctx._driftRecurrence || { evaluable: false, snapshots: 0, recurring: [] };
    if (!state.evaluable) {
      skip('CMDB-132', 'health_runs', `NOT MEASURED — a recurrence needs a finding to be seen, then verifiably gone, then back: at least ${opt.minRecurrenceSnapshots} earlier comparable snapshots with stored findings, and there are ${state.snapshots}.${setAside} Until then the \`recurred\` escalator stays not-evaluated on every finding, and says so.${RETURNING}`);
    } else if (!state.recurring.length) {
      skip('CMDB-132', 'health_findings', `No current finding recurred after a verified closure across ${state.snapshots} comparable snapshot(s) — evaluated, with nothing to report`);
    } else {
      const byRule = [...state.recurring.reduce((m, r) => m.set(r.rule_id, (m.get(r.rule_id) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
      const f = drift('CMDB-132', 'health_findings',
        `${state.recurring.length.toLocaleString('en-US')} finding(s) were fixed and came back — the same rule on the same object, seen, verifiably gone, and seen again: ${byRule.slice(0, 5).map(([r, n]) => `${r} (${n})`).join(', ')}. Each has been escalated one band where it stands, because a defect that returns after remediation means the cause was never removed.`,
        { evidence: state.recurring.slice(0, 15).map((r) => fact('health_findings', r.rule_id, r.title, `seen ${String(r.first_seen).slice(0, 10)}, gone ${String(r.closed_at).slice(0, 10)}, back now`)),
          guard: { evaluated: false, note: 'An object that legitimately changed again for a valid reason recurs in exactly the same way. Check what changed before treating it as a failed fix.' } });
      f.recurrences = state.recurring;
    }
  }

  /* ── CMDB-133 — the IRE bypass rate, trended ────────────────────────────── */
  {
    const nowKpi = ctx.kpis.find((k) => k.rule_id === 'CMDB-046');
    if (!nowKpi) {
      skip('CMDB-133', 'health_runs', 'CMDB-046 produced no bypass ratio on this run, so there is nothing to trend — the rule it trends cannot measure this estate yet (it needs per-CI source attribution), and a trend of a measurement that does not exist is not a trend.');
    } else {
      const series = [...comparable.map((s) => ({ at: s.at, v: s.kpis?.['CMDB-046'] })).filter((p) => Number.isFinite(p.v)), { at: now.toISOString(), v: nowKpi.pass_pct }];
      if (series.length < opt.minTrendPoints) {
        skip('CMDB-133', 'health_runs', `NOT MEASURED — a rising bypass rate needs ${opt.minTrendPoints} comparable readings and there are ${series.length}.${setAside}${RETURNING}`);
      } else {
        const last = series.slice(-opt.minTrendPoints);
        const falling = last.every((p, i) => i === 0 || p.v < last[i - 1].v) && last[0].v - last[last.length - 1].v >= opt.bypassNoisePoints;
        if (falling) {
          drift('CMDB-133', 'health_runs',
            `The share of CI creates going through IRE has fallen for ${last.length} consecutive comparable runs — ${last.map((p) => `${pct1(p.v)}%`).join(' → ')} — so the bypass rate is rising above noise. Every bypass is a CI created without identification, which is tomorrow's duplicate.`,
            { evidence: last.map((p) => fact('health_runs', 'CMDB-046 pass rate', `${pct1(p.v)}%`, String(p.at).slice(0, 10))),
              guard: { evaluated: false, note: 'A one-time migration can inflate a single period. The rule requires a sustained run of declines above noise, not one bad month.' } });
        } else {
          skip('CMDB-133', 'health_runs', `The IRE bypass rate is not rising across the last ${last.length} comparable readings — evaluated, with nothing to report`);
        }
      }
    }
  }

  /* ── CMDB-134 — duplicate sets that were not there last time ────────────── */
  {
    const cur = ctx.measures.duplicate_sets;
    if (!cur || !Array.isArray(cur.keys)) {
      skip('CMDB-134', 'cmdb_ci', 'The uniqueness rules produced no duplicate-set measure on this run, so there is nothing to compare');
    } else if (!cur.complete) {
      skip('CMDB-134', 'cmdb_ci', 'Not every identity attribute was read this run, so its duplicate sets are not comparable with an earlier run\'s — a set could look new only because an attribute was missing');
    } else {
      const prev = [...comparable].reverse().find((s) => Array.isArray(s.duplicate_keys));
      if (!prev) {
        skip('CMDB-134', 'health_runs', `NOT MEASURED — new duplicates need an earlier comparable snapshot of duplicate-set membership, and there is none.${setAside} This run's ${cur.keys.length.toLocaleString('en-US')} set(s) are recorded as the baseline.${RETURNING}`);
      } else {
        const before = new Set(prev.duplicate_keys);
        const fresh = cur.keys.filter((k) => !before.has(k));
        const gone = prev.duplicate_keys.filter((k) => !cur.keys.includes(k)).length;
        ctx.measures.duplicate_inflow = { since: prev.at, new_sets: fresh.length, resolved_sets: gone };
        if (fresh.length) {
          drift('CMDB-134', 'cmdb_ci',
            `${fresh.length.toLocaleString('en-US')} duplicate set(s) exist now that did not exist on ${String(prev.at).slice(0, 10)}${gone ? `, while ${gone.toLocaleString('en-US')} were resolved` : ''}. Duplicates are still being created, which means whatever lets a second record in — a bypass, a missing identifier, a manual create — is still open.`,
            { evidence: [fact('health_runs', 'new duplicate sets', fresh.length, `since ${String(prev.at).slice(0, 10)}`), fact('health_runs', 'resolved', gone, 'no longer present')],
              guard: { evaluated: true, note: 'Compared only with a snapshot under the same scoring model, so a changed identity threshold cannot manufacture new sets.' } });
        } else {
          skip('CMDB-134', 'cmdb_ci', `No duplicate set appeared since ${String(prev.at).slice(0, 10)} — evaluated, with nothing to report`);
        }
      }
    }
  }

  /* ── CMDB-135 — CIs newly crossing the staleness threshold ──────────────── */
  {
    const threshold = ctx.staleDays || 90;
    const cis = ctx.estate.cmdb_ci || [];
    const cutoff = now.getTime() - threshold * DAY_MS;
    const staleIds = cis.filter((c) => { const d = parseDate(c.last_discovered); return d && d.getTime() < cutoff; }).map((c) => c.sys_id).sort();
    ctx.measures.staleness_snapshot = { at: now.toISOString(), threshold_days: threshold, count: staleIds.length, stale_ids: staleIds.slice(0, 20000), truncated: staleIds.length > 20000 };
    const capability = ctx.measures.discovery_capability;
    if (capability && !capability.operating) {
      skip('CMDB-135', 'discovery_schedule', `NOT MEASURED — Discovery is not operating on this instance (${capability.installed ? 'installed, with no schedule and no run history' : 'not installed'}), so last_discovered is not moving: ${capability.ever_discovered.toLocaleString('en-US')} CI(s) carry one at all. A CI cannot newly go stale on a clock nobody is winding. D7 (CMDB-070) reports the absence itself.`);
    } else {
      const prev = [...(ctx.history?.staleness_snapshot || [])].reverse().find((s) => s.threshold_days === threshold && Array.isArray(s.stale_ids) && !s.truncated);
      if (!prev) {
        skip('CMDB-135', 'cmdb_ci', `NOT MEASURED — newly stale CIs need an earlier staleness snapshot at the same ${threshold}-day threshold, and there is none. This run's ${staleIds.length.toLocaleString('en-US')} stale CI(s) are recorded as the baseline.${RETURNING}`);
      } else {
        const before = new Set(prev.stale_ids);
        const newly = staleIds.filter((id) => !before.has(id));
        const weeks = Math.max(1 / 7, (now - parseDate(prev.at)) / (7 * DAY_MS));
        const perWeek = newly.length / weeks;
        if (newly.length) {
          const byId = new Map(cis.map((c) => [c.sys_id, c]));
          const byClass = [...newly.reduce((m, id) => m.set(byId.get(id)?.sys_class_name || 'unknown', (m.get(byId.get(id)?.sys_class_name || 'unknown') || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
          drift('CMDB-135', 'cmdb_ci',
            `${newly.length.toLocaleString('en-US')} CI(s) crossed the ${threshold}-day staleness threshold since ${String(prev.at).slice(0, 10)} — about ${perWeek.toFixed(1)} a week. Worst: ${byClass.slice(0, 4).map(([cls, n]) => `${cls} (${n})`).join(', ')}. This is the earliest visible sign of a discovery failure: the CIs are still there, and nothing has confirmed them since.`,
            { evidence: byClass.slice(0, 10).map(([cls, n]) => fact('cmdb_ci', cls, `${n} newly stale`, `last_discovered older than ${threshold} days`)),
              guard: { evaluated: false, note: 'A changed schedule interval shifts the threshold and produces the same jump. The rule only compares snapshots taken at the same threshold.' } });
        } else {
          skip('CMDB-135', 'cmdb_ci', `No CI newly crossed the ${threshold}-day threshold since ${String(prev.at).slice(0, 10)} — evaluated, with nothing to report`);
        }
      }
    }
  }

  /* ── CMDB-136 — relationships declining, class by class ─────────────────── */
  {
    const cur = ctx.measures.relationship_counts;
    const series = [...(ctx.history?.relationship_counts || []).filter((h) => h && h.by_class && parseDate(h.at)), cur].filter((h) => h?.by_class);
    if (!cur?.by_class) {
      skip('CMDB-136', 'cmdb_rel_ci', 'The relationship rules produced no per-class count on this run, so there is nothing to trend');
    } else if (series.length < opt.minTrendPoints) {
      skip('CMDB-136', 'cmdb_rel_ci', `NOT MEASURED — a declining trend per class needs ${opt.minTrendPoints} snapshots with per-class counts and there are ${series.length}. Snapshots recorded before per-class counts existed cannot contribute. CMDB-056 watches for a sudden collapse in the meantime.`);
    } else {
      const last = series.slice(-opt.minTrendPoints);
      const classes = new Set(last.flatMap((s) => Object.keys(s.by_class)));
      const declining = [];
      for (const cls of classes) {
        const vals = last.map((s) => s.by_class[cls] || 0);
        const strictly = vals.every((v, i) => i === 0 || v < vals[i - 1]);
        const dropPct = vals[0] ? (100 * (vals[0] - vals[vals.length - 1])) / vals[0] : 0;
        if (strictly && dropPct >= opt.relationshipDeclinePct) declining.push({ cls, vals, dropPct });
      }
      if (declining.length) {
        declining.sort((a, b) => b.dropPct - a.dropPct);
        drift('CMDB-136', 'cmdb_rel_ci',
          `Relationships are declining steadily in ${declining.length} class(es) across ${last.length} snapshots: ${declining.slice(0, 4).map((d) => `${d.cls} ${d.vals.join(' → ')} (−${pct1(d.dropPct)}%)`).join(', ')}. This is the slow version of a collapse — no single run looks alarming, and the map is thinning anyway.`,
          { evidence: declining.slice(0, 10).map((d) => fact('cmdb_rel_ci', d.cls, d.vals.join(' → '), `down ${pct1(d.dropPct)}%`)),
            guard: { evaluated: false, note: 'A planned decommissioning programme thins the map in exactly this way. Check for one before treating it as decay.' } });
      } else {
        skip('CMDB-136', 'cmdb_rel_ci', `No class shows a sustained decline in relationships across ${last.length} snapshots — evaluated, with nothing to report`);
      }
    }
  }

  /* ── CMDB-138 — attestation adherence, cycle by cycle ───────────────────── */
  {
    if (!ctx.complete('cmdb_data_management_task', ['sys_id'])) {
      skip('CMDB-138', 'cmdb_data_management_task', 'The Data Manager attestation tasks were not read, so adherence per cycle cannot be computed');
    } else {
      const tasks = ctx.estate.cmdb_data_management_task || [];
      if (!tasks.length) {
        skip('CMDB-138', 'cmdb_data_management_task', 'NOT MEASURED — no Data Manager attestation task has ever been issued on this instance, so adherence has no denominator. The legacy Certification audits that DO run here are automated desired-state checks with no human completion step, so their results are not attestation adherence either; CMDB-095 reports what those audits found.');
      } else {
        const cycles = new Map();
        for (const t of tasks) {
          const opened = parseDate(t.opened_at) || parseDate(t.sys_created_on);
          if (!opened) continue;
          const cycle = opened.toISOString().slice(0, 7);
          const c = cycles.get(cycle) || { issued: 0, adhered: 0 };
          c.issued += 1;
          const closed = parseDate(t.closed_at);
          const due = parseDate(t.due_date);
          if (closed && (!due || closed <= due)) c.adhered += 1;
          cycles.set(cycle, c);
        }
        const ordered = [...cycles.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        if (ordered.length < opt.attestationCycles) {
          skip('CMDB-138', 'cmdb_data_management_task', `NOT MEASURED — adherence needs ${opt.attestationCycles} attestation cycles and the tasks span ${ordered.length}`);
        } else {
          const last = ordered.slice(-opt.attestationCycles).map(([cycle, c]) => ({ cycle, rate: (100 * c.adhered) / c.issued, ...c }));
          ctx.measures.attestation_adherence = last;
          const falling = last.every((p, i) => i === 0 || p.rate < last[i - 1].rate);
          if (falling) {
            drift('CMDB-138', 'cmdb_data_management_task',
              `Attestation adherence has fallen for ${last.length} consecutive cycles: ${last.map((p) => `${p.cycle} ${pct1(p.rate)}%`).join(' → ')}. Fewer tasks are being answered on time each cycle — the governance is still configured and is quietly being ignored.`,
              { evidence: last.map((p) => fact('cmdb_data_management_task', p.cycle, `${p.adhered} of ${p.issued} on time`, `${pct1(p.rate)}%`)),
                guard: { evaluated: false, note: 'A cycle whose scope changed — more classes, a new policy — is not comparable with the one before it.' } });
          } else {
            skip('CMDB-138', 'cmdb_data_management_task', `Attestation adherence is not falling across the last ${last.length} cycles — evaluated, with nothing to report`);
          }
        }
      }
    }
  }
}

/* ═══ CMDB-137 — the score trend, AFTER the score exists ══════════════════ */

/**
 * The current composite does not exist until the scoring engine has run, so this
 * rule is evaluated after it, from `index.js`. It adds its finding to the same
 * findings list and never feeds back into the score it is describing.
 */
export function cmdbScoreTrend(ctx, quality, options = {}) {
  const opt = { ...DRIFT_DEFAULTS, ...options };
  const now = ctx.now;
  const skip = (reason) => ctx.skipped.push({ rule: 'CMDB-137', table: 'health_runs', reason });
  const fact = factOf(now);
  const { comparable, aside, setAside } = comparison(ctx);
  const current = quality?.composite?.score;
  if (current == null) {
    skip('NOT MEASURED — this run produced no composite, so there is no score to trend');
    return null;
  }
  const series = [
    ...comparable.filter((s) => Number.isFinite(s.composite)).map((s) => ({ at: s.at, score: s.composite, dims: s.dimensions || {} })),
    { at: now.toISOString(), score: current, dims: Object.fromEntries((quality.dimensions || []).map((d) => [d.key, d.score ?? null])) },
  ];
  const lastOther = aside?.newest_scored ?? null;
  /*
   * THE NAIVE COMPARISON, NAMED. When the previous run was measured differently,
   * a reader looking at the two numbers will draw the conclusion this rule
   * refuses to draw — so the rule says what that comparison would have claimed,
   * and why it is not a finding.
   */
  /*
   * Measured on dev424910: the most recent earlier run was UNKEYED and read the
   * same 77 as this one, and the first wording announced "that difference is a
   * change in how the estate is measured" about a difference of zero. An
   * unkeyed run is an UNKNOWN model, not a different one, and equal numbers are
   * not evidence of stability across models.
   */
  let naive = '';
  if (lastOther) {
    const when = String(lastOther.at).slice(0, 10);
    const model = lastOther.keyed ? 'under a different scoring model' : 'before the comparability key existed, so whether it was measured the same way cannot be confirmed';
    naive = lastOther.composite === current
      ? ` The most recent earlier CMDB run also read ${current} (${when}), ${model} — matching numbers across models are a coincidence, not evidence that nothing changed.`
      : ` The most recent earlier CMDB run read ${lastOther.composite} (${when}) against ${current} now, ${model} — so the gap between them cannot be read as the estate moving.`;
  }
  quality.measures ||= {};
  quality.measures.score_trend = { points: series.map((p) => ({ at: p.at, score: p.score })), comparable: series.length };
  if (series.length < opt.minTrendPoints) {
    skip(`NOT MEASURED — a score trend needs ${opt.minTrendPoints} comparable readings and there are ${series.length}.${setAside}${naive}${RETURNING}`);
    return null;
  }
  const last = series.slice(-opt.minTrendPoints);
  const falling = last.every((p, i) => i === 0 || p.score < last[i - 1].score) && last[0].score - last[last.length - 1].score >= opt.scoreNoisePoints;
  if (!falling) {
    skip(`The composite is not declining across the last ${last.length} comparable readings (${last.map((p) => p.score).join(' → ')}) — evaluated, with nothing to report`);
    return null;
  }
  /* Attribute the change to the dimensions that moved, by their weight. */
  const weights = Object.fromEntries((quality.dimensions || []).map((d) => [d.key, d.weight]));
  const first = last[0];
  const lastPt = last[last.length - 1];
  const moves = Object.keys(weights)
    .map((k) => ({ key: k, from: first.dims[k], to: lastPt.dims[k] }))
    .filter((d) => Number.isFinite(d.from) && Number.isFinite(d.to) && d.from !== d.to)
    .map((d) => ({ ...d, contribution: (weights[d.key] * (d.to - d.from)) / (quality.composite.measured_weight || 100) }))
    .sort((a, b) => a.contribution - b.contribution);
  return ctx.addCatalogued('CMDB-137', 'health_runs', [], ['sys_class_name'],
    `The CMDB composite has declined across ${last.length} consecutive comparable runs: ${last.map((p) => p.score).join(' → ')}. Most of the fall is in ${moves.slice(0, 3).map((d) => `${d.key} (${d.from} → ${d.to}, ${d.contribution.toFixed(1)} points)`).join(', ') || 'no single dimension'}. Every reading was taken under the same scoring model, so this is the estate moving and not the measurement.`,
    { agent: 'cmdb_governance_agent', confidence: 1.0,
      evidence: [
        ...last.map((p) => fact('health_runs', 'composite', p.score, String(p.at).slice(0, 10))),
        ...moves.slice(0, 5).map((d) => fact('health_runs', d.key, `${d.from} → ${d.to}`, `${d.contribution.toFixed(1)} composite points`)),
      ],
      guard: { evaluated: true, note: 'Only readings with the same comparability key are trended — a rule-pack, catalogue or blend change is never read as a declining estate.' } });
}
