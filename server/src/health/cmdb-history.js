/**
 * CMDB HISTORY — the snapshots every trend rule compares against.
 *
 * PURE: it takes stored runs (manifest plus, optionally, each run's findings) and
 * returns the history a scan hands to the rules. `store.cmdbMeasureHistory`
 * reads the database and calls this; tests call it directly — which is the
 * point, because the version it replaces was untested and silently dropped most
 * of what the trend rules needed.
 *
 * ═══ THE BUG THIS REPLACED (Sep 2026) ═══
 *
 * The old reader returned exactly two trend measures, `duplicate_sets` and
 * `relationship_counts`. CMDB-096 reads `class_growth` and CMDB-125/128/129 read
 * `scale_snapshot`, and neither was ever returned — so in production those rules
 * could NEVER leave their "needs N snapshots" abstention. Their fixture tests
 * passed because fixtures inject history directly, skipping the reader. Every
 * trend measure is now declared once, in `TREND_MEASURE_KEYS`, and the test
 * suite exercises this function rather than a hand-built history.
 *
 * ═══ WHICH RUNS ARE SNAPSHOTS OF THE CMDB ═══
 *
 * A trend compares like with like, and the run table is full of things that are
 * not a CMDB snapshot. Measured on dev424910's own history:
 *
 *   an ITSM-only scan       carries zero CMDB findings. Compared naively, every
 *                           CMDB defect would read as RESOLVED.
 *   a verification run      reads nothing and stores no findings at all.
 *   a degraded CMDB read    stores the findings of the tables it could read, so
 *                           everything on the others would read as resolved.
 *   a truncated run         stored only part of what it found.
 *
 * Each is excluded, and the exclusions are returned with their reasons so a
 * trend that has too few snapshots can say why.
 *
 * ═══ COMPARABLE IS NOT THE SAME AS ELIGIBLE ═══
 *
 * An eligible snapshot is a genuine picture of the CMDB. Whether two pictures can
 * be COMPARED is a separate question — the rules decide it with each snapshot's
 * `comparability` key (see `scoringComparability` in rules.js). Measured on the
 * same history: the two most recent CMDB runs read 82.1 then 77.0, and 11,618
 * then 20,954 findings, and both differences were caused entirely by rule
 * changes that week. Nothing in the estate had moved.
 */

/*
 * ═══ COMPARABILITY IS A PROPERTY OF THE MEASURE (decided 17 Sep 2026) ═══
 *
 * Whether an earlier reading may be compared with this one depends on WHAT was
 * measured, never on which rule is asking:
 *
 *   raw      a count the platform itself holds — rows per class, edges, creation
 *            dates. No rule, threshold or setting of ours decides it, so a rule
 *            change cannot move it: it is compared across rule versions.
 *   derived  a result our rules, thresholds or per-estate settings produced —
 *            duplicate-set membership, stale-CI lists, bulk-touch groups,
 *            attestation outcomes, findings and scores. A rule change moves it,
 *            so it is compared ONLY with readings under the same comparability key.
 *
 * The first build left the decision to each rule, and two rules reading the SAME
 * measure disagreed: CMDB-134 required the key for duplicate-set membership and
 * CMDB-038 did not. The tag now lives here, `comparableHistory` enforces it, and
 * EstateRules passes every assignment of `history` through it — so no rule can
 * see a derived reading from another model, and none can opt out. A measure with
 * no tag never reaches a rule at all, and a test fails if a rule reads one. The
 * same shape as MODIFIER_FAMILY: the property belongs to the thing, not the caller.
 *
 * WHEN UNSURE, A MEASURE IS DERIVED. A wrong `derived` costs a baseline; a wrong
 * `raw` reports a rule change as a change in the estate.
 */
export const MEASURE_COMPARABILITY = Object.freeze({
  relationship_counts: 'raw',      // cmdb_rel_ci rows, by type and by end class
  class_growth: 'raw',             // cmdb_ci rows per class, and those created in the last 365 days
  scale_snapshot: 'raw',           // cmdb_ci rows per class, and cmdb_rel_ci rows
  duplicate_sets: 'derived',       // membership decided by identity guards and normalisation
  record_freshness: 'derived',     // bulk-touch groups, script accounts, migration exemptions
  attestation_outcomes: 'derived', // failed / certified by per-estate result patterns and window
  staleness_snapshot: 'derived',   // stale by the run's staleness threshold
  snapshots: 'derived',            // stored findings, KPIs, dimension scores and the composite
});

/** The per-run measures a snapshot carries (everything tagged except the snapshots themselves). */
export const TREND_MEASURE_KEYS = Object.freeze(Object.keys(MEASURE_COMPARABILITY).filter((k) => k !== 'snapshots'));

/**
 * Which history each trend-reading rule depends on — so what a rule change resets
 * is DERIVED from the tags rather than listed by hand. A test holds every entry to
 * a tagged measure.
 */
export const TREND_RULE_INPUTS = Object.freeze({
  'CMDB-038': 'duplicate_sets',
  'CMDB-056': 'relationship_counts',
  'CMDB-096': 'class_growth',
  'CMDB-125': 'scale_snapshot',
  'CMDB-128': 'scale_snapshot',
  'CMDB-129': 'scale_snapshot',
  'CMDB-131': 'snapshots',
  'CMDB-132': 'snapshots',
  'CMDB-133': 'snapshots',
  'CMDB-134': 'snapshots',
  'CMDB-135': 'staleness_snapshot',
  'CMDB-136': 'relationship_counts',
  'CMDB-137': 'snapshots',
});

/** The rule key a stored reading was measured under. */
const keyOf = (entry) => entry?.comparability_key ?? entry?.comparability?.key ?? null;
const LAYERED = Symbol('comparable history');

/**
 * THE COMPARISON LAYER. Returns the history a rule is allowed to see under `key`:
 * raw measures whole, derived measures only where measured under the same key,
 * untagged fields not at all. What was set aside is reported in `set_aside` —
 * counts, and the newest set-aside reading's date and score — for DISCLOSURE,
 * so a rule can say what it refused to compare without being able to compare it.
 */
export function comparableHistory(history, key) {
  const src = history || {};
  if (src[LAYERED] !== undefined && src[LAYERED] === (key ?? null)) return src;
  const out = { excluded: Array.isArray(src.excluded) ? src.excluded : [], set_aside: {} };
  for (const [measure, kind] of Object.entries(MEASURE_COMPARABILITY)) {
    const entries = Array.isArray(src[measure]) ? src[measure] : [];
    if (kind === 'raw') { out[measure] = entries; continue; }
    const kept = key ? entries.filter((e) => keyOf(e) === key) : [];
    out[measure] = kept;
    const aside = entries.filter((e) => !kept.includes(e));
    if (!aside.length) continue;
    const unkeyed = aside.filter((e) => !keyOf(e)).length;
    const newest = aside[aside.length - 1];
    const scored = [...aside].reverse().find((e) => Number.isFinite(e?.composite));
    out.set_aside[measure] = {
      count: aside.length, unkeyed, other_model: aside.length - unkeyed,
      newest: { at: newest?.at ?? null, keyed: Boolean(keyOf(newest)) },
      newest_scored: scored ? { at: scored.at ?? null, keyed: Boolean(keyOf(scored)), composite: scored.composite } : null,
    };
  }
  out.untagged = Object.keys(src).filter((k) => !(k in MEASURE_COMPARABILITY) && !['excluded', 'set_aside', 'untagged'].includes(k));
  Object.defineProperty(out, LAYERED, { value: key ?? null, enumerable: false });
  return out;
}

/** The rule-id prefixes the CMDB module owns — mirrors RULE_PREFIX_SCOPE in scopes.js (a test holds them together). */
export const CMDB_RULE_PREFIX = /^(CMDB|REL|CSDM)-/;

/** Is this stored run a genuine snapshot of the CMDB? `{ ok, why }`. */
export function cmdbSnapshotEligibility(run) {
  const m = run?.manifest;
  if (!m) return { ok: false, why: 'no manifest was stored' };
  if (!['completed', 'partial'].includes(run.status)) return { ok: false, why: `run ${run.status || 'unfinished'}` };
  if (m.kind === 'verification') return { ok: false, why: 'a verification run reads nothing and stores no findings' };
  const modules = Array.isArray(run.modules) ? run.modules : (Array.isArray(m.modules) ? m.modules : null);
  if (modules && !modules.includes('cmdb')) return { ok: false, why: `scanned ${modules.join(', ') || 'no module'}, not CMDB — its absence of CMDB findings would read as everything resolved` };
  if (!m.cmdb_quality) return { ok: false, why: 'no CMDB quality result was recorded' };
  if (m.degraded?.cmdb?.length) return { ok: false, why: `the CMDB read was degraded (${m.degraded.cmdb.slice(0, 3).join('; ')}), so defects on the unread tables would read as resolved` };
  return { ok: true, why: null };
}

const atOf = (run) => run.started_at || run.at || run.manifest?.started_at || null;

/**
 * Build the history a scan hands to the rules.
 *
 * @param {Array<{id, started_at, status, modules?, manifest, findings?}>} runs  any order
 * @returns {object} every trend measure (oldest first), plus `snapshots` and `excluded`
 */
export function cmdbHistoryFromRuns(runs = []) {
  const excluded = [];
  const eligible = [];
  for (const run of runs) {
    const verdict = cmdbSnapshotEligibility(run);
    if (verdict.ok) eligible.push(run);
    else excluded.push({ run_id: run?.id ?? null, at: atOf(run || {}), why: verdict.why });
  }
  eligible.sort((a, b) => String(atOf(a)).localeCompare(String(atOf(b))));

  const out = { excluded };
  for (const key of TREND_MEASURE_KEYS) {
    /* Every reading is stamped with the key it was measured under, so the
       comparison layer can decide by the measure's tag. */
    out[key] = eligible
      .map((run) => [run, run.manifest.cmdb_quality?.measures?.[key]])
      .filter(([, v]) => {
        if (!v || typeof v !== 'object') return false;
        if (key === 'duplicate_sets') return Array.isArray(v.keys);
        if (key === 'relationship_counts') return Number.isFinite(v.total);
        return true;
      })
      .map(([run, v]) => ({ ...v, comparability_key: run.manifest.comparability?.key ?? null }));
  }

  out.snapshots = eligible.map((run) => {
    const m = run.manifest;
    const q = m.cmdb_quality;
    const truncated = Boolean(m.findings_truncated);
    const findings = Array.isArray(run.findings) && !truncated
      ? run.findings.filter((f) => CMDB_RULE_PREFIX.test(String(f.rule_id || ''))).map((f) => [f.fingerprint, f.rule_id, f.domain])
      : null;
    return {
      run_id: run.id ?? null,
      at: atOf(run),
      comparability: m.comparability ?? null,
      composite: q.composite?.score ?? null,
      measured_weight: q.composite?.measured_weight ?? null,
      dimensions: Object.fromEntries((q.dimensions || []).map((d) => [d.key, d.score ?? null])),
      kpis: Object.fromEntries((q.dimensions || []).flatMap((d) => (d.kpis || []).map((k) => [k.rule_id, k.pass_pct]))),
      duplicate_keys: Array.isArray(q.measures?.duplicate_sets?.keys) ? q.measures.duplicate_sets.keys : null,
      findings,
      findings_unavailable_because: findings ? null : (truncated ? 'the run stored only part of what it found' : 'its findings were not loaded'),
    };
  });
  return out;
}
