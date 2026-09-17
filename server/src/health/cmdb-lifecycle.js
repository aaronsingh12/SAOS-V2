import { modifiersFor, lineageOf, dqActive, cisForRule, DQ_INACTIVE_INSTALL_STATUS, choiceLabels } from './cmdb-signals.js';
import { parseDate } from './time.js';

/**
 * GROUP 8 — LIFECYCLE AND RETIREMENT (D8). CMDB-080 to CMDB-090.
 *
 * THE DIMENSION THAT RUNS THE OTHER WAY. D1 to D7 are quality dimensions: they
 * judge records somebody is supposed to be maintaining, and a retired CI is
 * excluded from all of them because a decommissioned server nobody rediscovers
 * is doing exactly what it should. D8 is where those CIs are judged — every rule
 * here is a CONTRADICTION rule operating on the full estate, because the
 * question is no longer "is this record good" but "do these two facts about the
 * same thing disagree".
 *
 * Three rules arrived tagged `quality` (CMDB-080, 081, 082) and could therefore
 * never have fired: "Retired CI still holding active relationships" evaluated
 * over a CI set with the retired CIs removed is a rule that cannot match. Fixed
 * in the tracker Sep 2026; the tag is the whole behaviour, which is why it is
 * checked by a test rather than trusted.
 *
 * ═══ WHAT THIS INSTANCE KEEPS (verified on dev424910, Sep 2026) ═══
 *
 *   NOT ONE CI IS RETIRED. install_status is 1 (Installed) on 2,659 CIs, empty
 *   on 117 and 6 (In Stock) on 8. There are no Retired, Stolen or Absent CIs at
 *   all, so six of these eleven rules evaluate against an empty population —
 *   which is a result, not a skip, and is reported as one.
 *
 *   `life_cycle_stage` and `life_cycle_stage_status` are EMPTY on all 2,784 CIs:
 *   the modern lifecycle model is not in use here and `install_status` is the
 *   only lifecycle this estate has.
 *
 *   THE ASSET REGISTER IS THE OTHER OPINION. `alm_asset` holds 2,817 rows, 941
 *   of them linked to a CI through `alm_asset.ci` (951 CIs point back through
 *   `cmdb_ci.asset`). Its states: 1,774 Consumed, 943 In use, 100 In stock.
 *
 *   THE TWO install_status COLUMNS DO NOT SHARE VALUES. Both tables call the
 *   field `install_status`; `7` is Retired on both, but `10` is Consumed on an
 *   asset while Absent is `100` on a CI, and `8` is Missing on an asset and
 *   Stolen on a CI. Mapping them by NUMBER would silently invent contradictions.
 *   Every state test here is made against the LABELS the instance publishes in
 *   `sys_choice`, and falls back to the numeric defaults only when those cannot
 *   be read — which is stated in the finding when it happens.
 *
 *   `cmdb_archive_rule` does not exist; `sys_archive_log` holds 759 rows.
 *   No edge on this instance points at a missing CI (CMDB-083 evaluates clean).
 *
 * ═══ WHAT D8 CONSUMES FROM D7 ═══
 *
 * CMDB-087 reads `measures.retired_still_discovered`, which Group 7 produces. It
 * does NOT recompute it. Two rules deriving the same population from the same
 * columns is how the two slowly disagree, and the one that disagrees quietly is
 * always the one nobody is reading. If the measure is absent — D7 did not run —
 * CMDB-087 skips and says so rather than falling back to its own arithmetic.
 *
 * PURE — no network, no database.
 */

export const LIFECYCLE_RULES = Object.freeze([
  'CMDB-080', 'CMDB-081', 'CMDB-082', 'CMDB-083', 'CMDB-084', 'CMDB-085',
  'CMDB-086', 'CMDB-087', 'CMDB-088', 'CMDB-089', 'CMDB-090',
]);

/**
 * Lifecycle STAGES, as label shapes rather than values.
 *
 * The CI and the asset each have their own choice list, and the values collide
 * without meaning the same thing. Matching the label is what lets one mapping
 * serve both, and lets an estate with custom states be read correctly without
 * anybody editing this file.
 */
export const STAGE_PATTERNS = Object.freeze({
  /*
   * THE DEAD SET IS A PER-ESTATE SETTING, like CLASS_TIERS — override it with
   * `deadStatePatterns`. `consumed` is the arguable member: it is a normal end
   * state for consumables, and including it is what makes CMDB-082 fire on a
   * "Consumed" asset whose CI is still Installed.
   *
   * COUPLING, MADE VISIBLE: this set drives which pairs CMDB-082 calls a
   * decommission contradiction and which CMDB-086 calls a stage mismatch, so
   * changing it moves findings between the two rules and changes the
   * contradiction count. Both rules name the set they used in their evidence.
   */
  dead: Object.freeze([/retir/i, /dispos/i, /decommission/i, /consumed/i, /missing/i, /stolen/i, /absent/i, /scrapp/i, /sold/i]),
  live: Object.freeze([/^installed/i, /in use/i, /operational/i, /deployed/i, /^live/i]),
  transitional: Object.freeze([/in stock/i, /on order/i, /in transit/i, /^build/i, /pending/i, /reserved/i]),
  maintenance: Object.freeze([/maintenance/i, /repair/i]),
});

export const LIFECYCLE_DEFAULTS = Object.freeze({
  dqInactiveInstallStatus: DQ_INACTIVE_INSTALL_STATUS,
  /* CMDB-088 — how long a CI may sit stale with nothing done about it. */
  retirementBacklogDays: 180,
  /* CMDB-089 — old enough that never having changed state is itself the finding. */
  lifecycleAgeDays: 365,
  /* CMDB-090 — never assumed. A retention period comes from policy or not at all. */
  retentionDays: null,
  /* Above this bulk-touch share, staleness is unverifiable and CMDB-088 refuses. */
  freshnessUnverifiablePct: 25,
  /* The task tables whose open records make a retired CI a contradiction. */
  taskTables: Object.freeze(['incident', 'change_request', 'problem']),
  /* Override to change what counts as a dead lifecycle state on this estate. */
  deadStatePatterns: STAGE_PATTERNS.dead,
});

const DAY_MS = 86_400_000;
const pct1 = (n) => Number(n.toFixed(1));
const val = (r, f) => String(r?.[f] ?? '').trim();

/** Which lifecycle stage a label describes, or null when nothing matches. */
export function stageOfLabel(label, deadPatterns = STAGE_PATTERNS.dead) {
  const text = String(label || '').trim();
  if (!text) return null;
  if (deadPatterns.some((re) => re.test(text))) return 'dead';
  for (const [stage, patterns] of Object.entries(STAGE_PATTERNS)) {
    if (stage === 'dead') continue;
    if (patterns.some((re) => re.test(text))) return stage;
  }
  return null;
}

export function cmdbLifecycleRules(ctx, options = {}) {
  const opt = { ...LIFECYCLE_DEFAULTS, ...options };
  const now = ctx.now;
  const meta = ctx.meta?.cmdb || {};
  const signals = ctx.signals;
  const skip = (rule, table, reason) => ctx.skipped.push({ rule, table, reason });
  const hierarchyOk = meta.reads?.class_hierarchy?.status === 'ok';
  const line = (cls) => lineageOf(meta, cls || 'cmdb_ci');
  const allCis = ctx.estate.cmdb_ci || [];
  const { excluded: inactiveCis } = dqActive(allCis, opt.dqInactiveInstallStatus);
  const cisFor = (rule) => cisForRule(rule, { all: allCis, active: allCis });
  const byId = new Map(allCis.map((c) => [c.sys_id, c]));
  const label = (c) => `${c.sys_class_name} "${c.name || c.sys_id}"`;
  const days = (d) => (d ? Math.floor((now - d) / DAY_MS) : null);
  const fact = (table, field, value, reason) => ({
    source: 'ServiceNow Table/Aggregate REST API', sn_table: table, sn_sys_id: null,
    field_name: field, field_value: String(value), reason, collected_at: now.toISOString(),
  });
  const perRecord = (rule, records, fields, description, extra = {}) => {
    const m = modifiersFor(records, signals);
    return ctx.addCatalogued(rule, 'cmdb_ci', records, fields, description, {
      agent: 'lifecycle_agent', escalators: m.escalators, deEscalators: m.deEscalators, notEvaluated: m.notEvaluated, ...extra,
    });
  };
  ctx.measures ||= {};

  const ciOk = ctx.complete('cmdb_ci', ['install_status', 'sys_class_name']);
  if (!ciOk) {
    for (const r of LIFECYCLE_RULES) skip(r, 'cmdb_ci', 'The CIs were not read completely — a lifecycle rule over a partial estate reports our own access rather than the estate\'s retirement discipline');
    return;
  }

  /* ═══ The two state vocabularies, read from the instance ════════════════ */
  /*
   * A NUMBER MEANS NOTHING WITHOUT ITS LABEL. `install_status` exists on both
   * cmdb_ci and alm_asset with different choice lists — 10 is Consumed on an
   * asset and Absent is 100 on a CI — so every stage test below resolves the
   * label first. Where the choices cannot be read, the numeric defaults stand in
   * and the finding says which basis it used, because one of them is a fact
   * about this instance and the other is an assumption about ServiceNow.
   */
  const choices = meta.choices || [];
  const deadSetNote = opt.deadStatePatterns.map((re) => String(re).replace(/^\/|\/i?$/g, '')).join(', ');
  const stageIndex = (tableMatch, element) => {
    const map = new Map();
    for (const ch of choices) {
      if (!tableMatch(val(ch, 'name')) || val(ch, 'element') !== element) continue;
      const stage = stageOfLabel(ch.label, opt.deadStatePatterns);
      if (stage) map.set(val(ch, 'value'), stage);
    }
    return map;
  };
  const ciStages = stageIndex((n) => n.startsWith('cmdb'), 'install_status');
  const assetStages = stageIndex((n) => n.startsWith('alm_'), 'install_status');
  const labelsRead = ciStages.size > 0;
  const deadDefaults = new Set(opt.dqInactiveInstallStatus);
  const ciStage = (c) => (labelsRead
    ? ciStages.get(val(c, 'install_status')) ?? null
    : (deadDefaults.has(val(c, 'install_status')) ? 'dead' : (val(c, 'install_status') ? 'live' : null)));
  const basisNote = labelsRead
    ? `Lifecycle states are read from this instance's own sys_choice labels (${ciStages.size} CI state(s) classified${assetStages.size ? `, ${assetStages.size} asset state(s)` : ''}).`
    : `The choice labels could not be read, so the platform's default values stand in (${opt.dqInactiveInstallStatus.join(', ')} = dead). An estate with custom states may be misread — this is an assumption, not a measurement.`;
  if (!labelsRead) {
    skip('CMDB-082', 'sys_choice', 'The install_status choice labels could not be read, so the CI and asset state vocabularies cannot be mapped to each other — and they do NOT share values, so mapping by number would invent contradictions');
  }

  const deadCis = allCis.filter((c) => ciStage(c) === 'dead');
  ctx.measures.lifecycle_states = {
    cis: allCis.length,
    dead: deadCis.length,
    basis: labelsRead ? 'sys_choice labels' : 'numeric defaults',
    by_state: [...allCis.reduce((m, c) => m.set(val(c, 'install_status') || '(empty)', (m.get(val(c, 'install_status') || '(empty)') || 0) + 1), new Map())]
      .sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ value: v, cis: n, stage: v === '(empty)' ? null : ciStage({ install_status: v }) })),
  };
  /*
   * AN EMPTY POPULATION IS A RESULT, NOT A SKIP. Six rules here judge retired
   * CIs, and this estate has none. Saying "no retired CI holds an active
   * relationship" is true and useful; saying "skipped" would imply the check
   * could not be made. The distinction is recorded once, here.
   */
  const noDead = deadCis.length === 0;
  const noDeadNote = `No CI on this instance is in a dead lifecycle state (${allCis.length.toLocaleString('en-US')} CIs: ${ctx.measures.lifecycle_states.by_state.slice(0, 4).map((s) => `${s.cis.toLocaleString('en-US')} at "${s.value}"`).join(', ')}). ${basisNote}`;

  /* ── CMDB-080 — retired, and still wired into the graph ───────────────── */
  const relOk = ctx.complete('cmdb_rel_ci', ['parent', 'child']);
  const edges = relOk ? (ctx.estate.cmdb_rel_ci || []).filter((e) => e.parent && e.child) : [];
  if (!relOk) {
    for (const r of ['CMDB-080', 'CMDB-083']) skip(r, 'cmdb_rel_ci', 'The relationships were not read completely, so an absence test over them would report our own access');
  } else {
    for (const c of deadCis) {
      const held = edges.filter((e) => e.parent === c.sys_id || e.child === c.sys_id);
      if (!held.length) continue;
      const liveEnds = held.map((e) => byId.get(e.parent === c.sys_id ? e.child : e.parent)).filter((x) => x && ciStage(x) !== 'dead');
      perRecord('CMDB-080', [c], ['name', 'sys_class_name', 'install_status'],
        `${label(c)} is retired and still holds ${held.length} relationship(s)${liveEnds.length ? `, ${liveEnds.length} of them to CIs that are still live` : ''}. Impact analysis keeps walking through a CI nobody maintains, so every blast radius that crosses it includes something that is not there.`,
        { confidence: 1.0,
          evidence: [
            fact('cmdb_ci', 'install_status', val(c, 'install_status'), 'dead lifecycle state'),
            fact('cmdb_rel_ci', 'edges held', held.length, liveEnds.length ? `${liveEnds.length} to live CIs` : 'all to dead CIs'),
          ],
          guard: { evaluated: false, note: 'A retirement in progress with a decommission change still open looks the same. Check for an open change before deleting the edges.' } });
    }
    if (noDead) skip('CMDB-080', 'cmdb_ci', `${noDeadNote} The rule ran over every CI and found none to judge — no retired CI is holding relationships here.`);

    /* ── CMDB-083 — an edge to a CI that no longer exists ───────────────── */
    const dangling = edges.filter((e) => !byId.has(e.parent) || !byId.has(e.child));
    const grouped = new Map();
    for (const e of dangling) {
      const missing = !byId.has(e.parent) ? e.parent : e.child;
      const survivor = byId.get(!byId.has(e.parent) ? e.child : e.parent);
      if (!survivor) continue;                            // both ends gone: nothing to charge
      if (!grouped.has(survivor.sys_id)) grouped.set(survivor.sys_id, { survivor, missing: [] });
      grouped.get(survivor.sys_id).missing.push(missing);
    }
    for (const { survivor, missing } of grouped.values()) {
      perRecord('CMDB-083', [survivor], ['name', 'sys_class_name'],
        `${label(survivor)} holds ${missing.length} relationship(s) pointing at a CI that no longer exists. A traversal that reaches one of them stops there without saying why, so impact analysis silently returns a smaller answer than the truth.`,
        { confidence: 1.0,
          evidence: missing.slice(0, 5).map((id) => fact('cmdb_rel_ci', 'missing endpoint', id, 'no cmdb_ci row with this sys_id')),
          guard: { evaluated: true, note: 'The referenced record exists or it does not; the catalogue names no false positive for this.' } });
    }
    const bothGone = dangling.length - [...grouped.values()].reduce((n, g) => n + g.missing.length, 0);
    if (bothGone > 0) skip('CMDB-083', 'cmdb_rel_ci', `${bothGone} edge(s) have BOTH endpoints missing — there is no surviving CI to charge, and nothing live reads them`);
    if (!dangling.length) skip('CMDB-083', 'cmdb_rel_ci', `All ${edges.length.toLocaleString('en-US')} relationship(s) point at CIs that exist — evaluated, with nothing to report`);
  }

  /* ── CMDB-081 — retired, and still on a service map ───────────────────── */
  const assocOk = ctx.complete('svc_ci_assoc', ['service', 'ci']);
  if (!assocOk) {
    skip('CMDB-081', 'svc_ci_assoc', 'The service-to-CI associations were not read completely, so a retired CI\'s presence on a map cannot be established');
  } else {
    const assoc = ctx.estate.svc_ci_assoc || [];
    const services = new Map((ctx.estate.cmdb_ci_service || []).map((s) => [s.sys_id, s]));
    for (const c of deadCis) {
      const on = assoc.filter((a) => a.ci === c.sys_id);
      if (!on.length) continue;
      const named = on.map((a) => services.get(a.service)?.name || a.service).slice(0, 5);
      perRecord('CMDB-081', [c], ['name', 'sys_class_name', 'install_status'],
        `${label(c)} is retired and still associated with ${on.length} service(s): ${named.join(', ')}. The service map presents it as part of the service, so anyone reading that map is being told a decommissioned thing is still carrying load.`,
        { confidence: 1.0,
          evidence: on.slice(0, 5).map((a) => fact('svc_ci_assoc', 'service', services.get(a.service)?.name || a.service, `association ${a.sys_id}`)),
          guard: { evaluated: false, note: 'A map not refreshed since a legitimate recent retirement looks the same. Check the retirement date against the map\'s last refresh.' } });
    }
    if (noDead) skip('CMDB-081', 'cmdb_ci', `${noDeadNote} No retired CI is on a service map here.`);
  }

  /* ── CMDB-082 / CMDB-086 — the asset register's opinion ────────────────── */
  const assetOk = ctx.complete('alm_asset', ['ci', 'install_status']);
  const assets = assetOk ? (ctx.estate.alm_asset || []) : [];
  const linked = assets.filter((a) => a.ci && byId.has(a.ci));
  if (!assetOk) {
    for (const r of ['CMDB-082', 'CMDB-086']) skip(r, 'alm_asset', 'The asset register was not read, so there is no second opinion to contradict the CMDB with');
  } else if (!linked.length) {
    for (const r of ['CMDB-082', 'CMDB-086']) {
      skip(r, 'alm_asset', `${assets.length.toLocaleString('en-US')} asset(s) were read and none is linked to a CI that was also read, so no pair exists to compare. An estate that keeps assets and CIs separate cannot be checked for agreement between them — that absence is CMDB-101's finding, not a lifecycle contradiction.`);
    }
  } else if (labelsRead) {
    let agree = 0;
    let unmapped = 0;
    for (const a of linked) {
      const c = byId.get(a.ci);
      const aStage = assetStages.get(val(a, 'install_status')) ?? null;
      const cStage = ciStage(c);
      if (!aStage || !cStage) { unmapped += 1; continue; }
      if (aStage === cStage) { agree += 1; continue; }
      const contradiction = (aStage === 'dead' && cStage !== 'dead') || (cStage === 'dead' && aStage !== 'dead');
      const aLabel = choices.find((ch) => val(ch, 'name').startsWith('alm_') && val(ch, 'element') === 'install_status' && val(ch, 'value') === val(a, 'install_status'))?.label || val(a, 'install_status');
      const cLabel = choices.find((ch) => val(ch, 'name').startsWith('cmdb') && val(ch, 'element') === 'install_status' && val(ch, 'value') === val(c, 'install_status'))?.label || val(c, 'install_status');
      if (contradiction) {
        perRecord('CMDB-082', [c], ['name', 'sys_class_name', 'install_status'],
          `The asset register says ${label(c)} is "${aLabel}" and the CMDB says it is "${cLabel}" — one of them has it ${aStage === 'dead' ? 'gone and the other still running' : 'running and the other gone'}. Finance and operations are working from different facts about the same physical thing, and only one of them can be right.`,
          { confidence: 0.95,
            evidence: [
              fact('alm_asset', 'install_status', aLabel, `asset ${val(a, 'display_name') || a.sys_id}`),
              fact('cmdb_ci', 'install_status', cLabel, 'the CI'),
              fact('sys_choice', 'mapping basis', 'label', 'the two tables do not share values, so states are mapped by label, never by number'),
              fact('sys_choice', 'dead states', deadSetNote, 'the configurable set that decides which mismatches are contradictions (CMDB-082) and which are stage mismatches (CMDB-086)'),
            ],
            guard: { evaluated: false, note: `Legitimate lag during a decommission workflow looks identical. Check for an open decommission task before acting. ${basisNote}` } });
      } else {
        perRecord('CMDB-086', [c], ['name', 'sys_class_name', 'install_status'],
          `${label(c)} is "${cLabel}" in the CMDB and "${aLabel}" in the asset register — different lifecycle stages (${cStage} against ${aStage}) rather than opposite ends of it. Whichever process reads the wrong one will act on a machine in a state it is not in.`,
          { confidence: 0.95,
            evidence: [
              fact('alm_asset', 'install_status', aLabel, `stage ${aStage}`),
              fact('cmdb_ci', 'install_status', cLabel, `stage ${cStage}`),
              fact('sys_choice', 'dead states', deadSetNote, 'neither state is in this set, which is why this is a stage mismatch and not a decommission contradiction'),
            ],
            guard: { evaluated: false, note: `Transitional lag between the two records is normal for a short window. ${basisNote}` } });
      }
    }
    ctx.measures.asset_agreement = { linked: linked.length, agree, unmapped, assets: assets.length };
    if (unmapped) skip('CMDB-082', 'sys_choice', `${unmapped} linked pair(s) carry a state on one side or the other that maps to no lifecycle stage, so the two could not be compared — an unmapped state is not a contradiction`);
    if (agree === linked.length) skip('CMDB-082', 'alm_asset', `All ${linked.length.toLocaleString('en-US')} linked asset-CI pair(s) agree on lifecycle stage — evaluated, with nothing to report`);
  }

  /* ── CMDB-084 — retired, and still carrying open work ─────────────────── */
  const taskTables = opt.taskTables.filter((t) => ctx.complete(t, ['cmdb_ci']));
  if (!taskTables.length) {
    skip('CMDB-084', 'incident', `None of the task tables (${opt.taskTables.join(', ')}) was read in this scan, so open work against a retired CI cannot be seen. A CMDB-only scan does not read ITSM — run a full scan, or include the ITSM module, for this rule.`);
  } else {
    const openTasks = new Map();                          // ci -> [{table, number}]
    for (const t of taskTables) {
      for (const row of ctx.estate[t] || []) {
        const ci = row.cmdb_ci;
        if (!ci || String(row.active ?? 'true') === 'false') continue;
        if (!openTasks.has(ci)) openTasks.set(ci, []);
        openTasks.get(ci).push({ table: t, number: row.number, opened: row.opened_at || row.sys_created_on });
      }
    }
    for (const c of deadCis) {
      const tasks = openTasks.get(c.sys_id) || [];
      if (!tasks.length) continue;
      perRecord('CMDB-084', [c], ['name', 'sys_class_name', 'install_status'],
        `${label(c)} is retired and still has ${tasks.length} open task(s) against it: ${tasks.slice(0, 4).map((t) => `${t.number || t.table}`).join(', ')}. Either the decommission never finished or the CI was retired underneath live work — both leave somebody holding a ticket for a machine the CMDB says is gone.`,
        { confidence: 1.0,
          evidence: tasks.slice(0, 5).map((t) => fact(t.table, 'number', t.number || '(unnumbered)', `open task against a retired CI, opened ${String(t.opened || '').slice(0, 10)}`)),
          guard: { evaluated: false, note: 'Tasks deliberately open to complete the decommission itself are the expected exception — check the task\'s purpose before chasing it.' } });
    }
    if (noDead) skip('CMDB-084', 'cmdb_ci', `${noDeadNote} No retired CI carries open work here.`);
  }

  /* ── CMDB-085 — retired, and still inside the scored population ───────── */
  const truthy = (v) => ['true', '1', 'yes'].includes(String(v).toLowerCase());
  const principals = new Set((ctx.estate.cmdb_class_info || []).filter((r) => truthy(r.principal_class)).map((r) => r.class));
  const inPrincipal = (c) => (principals.size
    ? (hierarchyOk ? line(c.sys_class_name).some((t) => principals.has(t)) : principals.has(c.sys_class_name))
    : true);
  const fallbackNote = principals.size ? '' : ' Evaluated over every populated class, because no principal classes are designated (CMDB-139).';
  const scoredDead = deadCis.filter(inPrincipal);
  if (scoredDead.length) {
    const byClass = [...scoredDead.reduce((m, c) => m.set(c.sys_class_name, (m.get(c.sys_class_name) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
    const f = ctx.addCatalogued('CMDB-085', 'cmdb_ci', scoredDead, ['sys_class_name', 'install_status'],
      `${scoredDead.length.toLocaleString('en-US')} retired CI(s) sit inside the classes the health score is calculated over: ${byClass.slice(0, 4).map(([cls, n]) => `${cls} (${n})`).join(', ')}. They are being scored as though somebody were maintaining them, which drags every quality percentage down by an amount that has nothing to do with quality.${fallbackNote}`,
      { agent: 'lifecycle_agent',
        evidence: byClass.slice(0, 20).map(([cls, n]) => fact('cmdb_ci', cls, `${n} retired CI(s)`, 'inside the scored population')),
        guard: { evaluated: false, note: 'Deliberate inclusion to track the retirement backlog is a legitimate choice — report the score both ways before changing the inclusion rule.' } });
    f.grouped_classes = byClass.map(([cls, n]) => ({ cls, cis: n }));
  } else if (noDead) {
    skip('CMDB-085', 'cmdb_ci', `${noDeadNote} No retired CI is inside the scored population here.`);
  }

  /* ── CMDB-087 — absent or stolen, and still reporting for duty ────────── */
  /*
   * PRODUCER → CONSUMER, and never both. Group 7 already walks last_discovered
   * to find dead CIs that discovery is still finding, and publishes the
   * population as `measures.retired_still_discovered`. Recomputing it here would
   * put the same question in two places, where the answers drift apart quietly.
   */
  const stillDiscovered = ctx.measures.retired_still_discovered;
  const operational = (c) => ['1', 'operational'].includes(val(c, 'operational_status').toLowerCase());
  const contradicted = deadCis.filter(operational);
  for (const c of contradicted) {
    const discovered = (stillDiscovered?.cis || []).find((x) => x.sys_id === c.sys_id);
    perRecord('CMDB-087', [c], ['name', 'sys_class_name', 'install_status', 'operational_status'],
      `${label(c)} is "${val(c, 'install_status')}" (a dead install state) and operational at the same time${discovered ? `, and discovery last found it ${discovered.last_discovered}` : ''}. The record contradicts itself: something that is gone cannot be running, and whichever half is wrong, a process somewhere is acting on it.`,
      { confidence: 1.0,
        evidence: [
          fact('cmdb_ci', 'install_status', val(c, 'install_status'), 'dead'),
          fact('cmdb_ci', 'operational_status', val(c, 'operational_status'), 'operational'),
          ...(discovered ? [fact('cmdb_ci', 'last_discovered', discovered.last_discovered, 'still being discovered — from measures.retired_still_discovered (D7)')] : []),
        ],
        guard: { evaluated: false, note: 'A status set in error is far more common than an actual loss. Verify before escalating a "Stolen" CI to security.' } });
  }
  if (!stillDiscovered) {
    skip('CMDB-087', 'cmdb_ci', 'The still-being-discovered population is produced by D7 (measures.retired_still_discovered) and was not available on this run, so the discovery half of this rule was not evaluated. It is deliberately NOT recomputed here: two rules deriving the same population from the same columns is how the two quietly disagree.');
  } else if (stillDiscovered.count) {
    skip('CMDB-087', 'cmdb_ci', `${stillDiscovered.count} dead CI(s) are still being discovered within ${stillDiscovered.within_days} days, taken from D7's measures.retired_still_discovered rather than recomputed here`);
  }
  if (noDead) skip('CMDB-087', 'cmdb_ci', `${noDeadNote} No CI is both dead and operational here.`);

  /* ── CMDB-088 — nothing stale was ever retired ─────────────────────────── */
  /*
   * THIS RULE RESTS ON STALENESS, AND STALENESS CAN BE FAKED. A bulk write moves
   * every sys_updated_on at once, so on an estate where that has happened there
   * is no stale population to find and a clean result here would mean nothing.
   * D7 measures exactly that, so this rule reads it rather than guessing.
   */
  const freshness = ctx.measures.record_freshness;
  const bulkPct = freshness?.bulk_touch_pct ?? 0;
  if (bulkPct > opt.freshnessUnverifiablePct) {
    skip('CMDB-088', 'cmdb_ci', `Staleness cannot be measured on this estate: ${bulkPct}% of CIs were last written by a mass touch (D7 / CMDB-143), so sys_updated_on reports a job's schedule rather than whether anybody has looked at the CI. A retirement backlog derived from that would be an artefact of the job, so the rule declines rather than reporting a clean result.`);
  } else {
    const cutoff = opt.retirementBacklogDays;
    const stale = cisFor('CMDB-088').filter((c) => {
      const age = days(parseDate(c.sys_updated_on));
      return age != null && age > cutoff && ciStage(c) !== 'dead';
    });
    for (const c of stale) {
      perRecord('CMDB-088', [c], ['name', 'sys_class_name', 'sys_updated_on', 'install_status'],
        `${label(c)} has had no update of any kind for ${days(parseDate(c.sys_updated_on))} days and is still in a live state. Nothing has confirmed it and nothing has retired it: it sits in the scored population as though it were maintained, and the longer that lasts the less the score means.`,
        { confidence: 1.0,
          evidence: [fact('cmdb_ci', 'sys_updated_on', val(c, 'sys_updated_on'), `${days(parseDate(c.sys_updated_on))} days ago`)],
          guard: { evaluated: false, note: 'Retirement deliberately deferred pending a project is a decision, not a backlog. A documented deferral belongs on the accepted-risk list.' } });
    }
    if (!stale.length) skip('CMDB-088', 'cmdb_ci', `No live CI has been untouched for more than ${cutoff} days — evaluated, with nothing to report`);
  }

  /* ── CMDB-089 — a lifecycle that has never moved, or never started ────── */
  /*
   * TWO EVIDENCE PATHS, ONE FINDING.
   *
   *  1. NEVER SET. `install_status` is empty: the lifecycle was never even
   *     started, which the record proves on its own with no audit needed. This
   *     is the SINGLE HOME for the 117 empty-status CIs on dev424910 — D1
   *     deliberately does not charge them (CMDB-021 is a class ratio, never a
   *     per-record charge), so they are counted here exactly once.
   *  2. NEVER MOVED. A state is set and `sys_audit` shows no lifecycle field
   *     ever changing. This needs the audit log, which is opt-in (see CMDB-077),
   *     so where it is absent the rule says which half it could evaluate.
   */
  const auditRows = ctx.estate.sys_audit || [];
  const lifecycleFields = new Set(['install_status', 'operational_status', 'life_cycle_stage', 'life_cycle_stage_status']);
  const everMoved = new Set();
  for (const a of auditRows) {
    if (lifecycleFields.has(val(a, 'fieldname')) && a.documentkey) everMoved.add(a.documentkey);
  }
  const neverSet = cisFor('CMDB-089').filter((c) => !val(c, 'install_status'));
  const oldEnough = (c) => {
    const age = days(parseDate(c.sys_created_on));
    return age != null && age > opt.lifecycleAgeDays;
  };
  for (const c of neverSet.filter(oldEnough)) {
    perRecord('CMDB-089', [c], ['name', 'sys_class_name', 'install_status', 'sys_created_on'],
      `${label(c)} has no install_status at all and was created ${days(parseDate(c.sys_created_on))} days ago. Its lifecycle was never started, let alone moved: it is neither live nor retired, so every rule that asks "is this CI in use" has to guess, and every report that counts by state leaves it out.`,
      { confidence: 1.0,
        evidence: [
          fact('cmdb_ci', 'install_status', '(empty)', 'never set'),
          fact('cmdb_ci', 'sys_created_on', val(c, 'sys_created_on'), `${days(parseDate(c.sys_created_on))} days ago`),
        ],
        guard: { evaluated: true, note: 'An empty state is not a state: there is no long-lived-infrastructure case for a CI that was never given one. This is the only rule that charges these CIs — the completeness dimension deliberately leaves them to D8.' } });
  }
  if (!auditRows.length) {
    skip('CMDB-089', 'sys_audit', `The audit log is not read (it is opt-in — pass 'sys_audit' in the scan's table list to enable it, at the cost of scan reuse; see CMDB-077), so "a state was set and never changed" could not be evaluated. The half that needs no audit DID run: ${neverSet.length.toLocaleString('en-US')} CI(s) carry no install_status at all, ${neverSet.filter(oldEnough).length.toLocaleString('en-US')} of them older than ${opt.lifecycleAgeDays} days, and those are charged here.`);
  } else {
    const stuck = cisFor('CMDB-089').filter((c) => val(c, 'install_status') && oldEnough(c) && !everMoved.has(c.sys_id));
    const byClass = [...stuck.reduce((m, c) => m.set(c.sys_class_name, (m.get(c.sys_class_name) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]);
    if (stuck.length) {
      const f = ctx.addCatalogued('CMDB-089', 'cmdb_ci', [], ['sys_class_name', 'install_status'],
        `${stuck.length.toLocaleString('en-US')} CI(s) older than ${opt.lifecycleAgeDays} days have never had a lifecycle field change once: ${byClass.slice(0, 4).map(([cls, n]) => `${cls} (${n})`).join(', ')}. Nothing has been retired, nothing has been moved into maintenance — the estate is recorded as though it were built once and never changed, which is not how hardware behaves.`,
        { agent: 'lifecycle_agent',
          evidence: byClass.slice(0, 20).map(([cls, n]) => fact('sys_audit', cls, `${n} CI(s) with no lifecycle audit entry`, `older than ${opt.lifecycleAgeDays} days`)),
          guard: { evaluated: true, note: 'Long-lived infrastructure legitimately sits in one state for years. Reported as a class pattern rather than per record, per the catalogue.' } });
      /*
       * A PATTERN, NOT A CHARGE. The catalogue is explicit: "Report as a
       * pattern, not per record." A class that has never moved a lifecycle field
       * is one fact about governance, not N defective records — and charging an
       * arbitrary slice of the class would be worse than either.
       */
      f.unscored_reason = 'names classes, not records — the catalogue reports a never-moved lifecycle as a class pattern, and charging a sample of it would be arbitrary';
      f.grouped_classes = byClass.map(([cls, n]) => ({ cls, cis: n }));
    }
  }

  /* ── CMDB-090 — retired, and never cleared away ───────────────────────── */
  if (!opt.retentionDays) {
    skip('CMDB-090', 'cmdb_ci', 'No retention period is configured for retired CIs on this instance, and one is never assumed — a retention breach cannot be measured against a policy that does not exist. The absence of the policy is CMDB-101\'s finding (Group 9), not this rule\'s.');
  } else {
    const overdue = deadCis.filter((c) => {
      const age = days(parseDate(c.sys_updated_on));
      return age != null && age > opt.retentionDays;
    });
    for (const c of overdue) {
      perRecord('CMDB-090', [c], ['name', 'sys_class_name', 'install_status'],
        `${label(c)} has been retired for more than the ${opt.retentionDays}-day retention period and is still in the CMDB. Retired records that are never cleared are what turns a CMDB into an archive nobody trusts, and they carry personal and contractual data past the point anybody agreed to keep it.`,
        { confidence: 1.0,
          evidence: [fact('cmdb_ci', 'sys_updated_on', val(c, 'sys_updated_on'), `${days(parseDate(c.sys_updated_on))} days, retention ${opt.retentionDays}`)],
          guard: { evaluated: true, note: 'Measured against the configured retention period, not an assumed one.' } });
    }
    if (noDead) skip('CMDB-090', 'cmdb_ci', `${noDeadNote} There is no retired CI to have outlived a retention period.`);
  }

  if (inactiveCis.length !== deadCis.length) {
    skip('CMDB-080', 'cmdb_ci', `The dead-state set here (${deadCis.length}) differs from the data-quality exclusion set (${inactiveCis.length}): D1–D7 exclude CIs by the platform's default status values, while D8 classifies them from this instance's own choice labels. Where the two disagree, this dimension's reading is the instance's.`);
  }
}
