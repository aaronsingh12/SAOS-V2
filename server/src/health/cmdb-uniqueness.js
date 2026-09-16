import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { modifiersFor, lineageOf, inCidr, dqActive, DQ_INACTIVE_INSTALL_STATUS } from './cmdb-signals.js';
import { isPlaceholder, COMPLETENESS_DEFAULTS } from './cmdb-completeness.js';
import { validFqdn, validSerial } from './cmdb-correctness.js';
import { parseDate } from './rules.js';

/**
 * GROUP 4 — UNIQUENESS (D3). CMDB-033 to CMDB-043.
 *
 * Implemented from tracker v3, against what exists (verified on dev424910,
 * 18 Sep 2026):
 *
 *   - A DUPLICATE SET is CIs sharing one exact identity value (serial, IP, MAC,
 *     FQDN or correlation_id). Sets that share a member are one IDENTITY CLUSTER
 *     — the thing a person merges. Every finding about a cluster carries the
 *     cluster as its `dedupe_key`, so a record caught by serial AND address AND
 *     the asymmetric rule pays one charge: the heaviest.
 *   - CMDB-033 (asymmetric) weighs 5× a symmetric duplicate and REPLACES its
 *     charge through that same key, rather than adding to it.
 *   - CMDB-039 reports per discovery-source pair and deducts nothing: its
 *     records are already charged by the rule that found the set.
 *   - Frequency guards: a serial on more than 10 CIs is a bad default, not
 *     duplicates; a name on more than 5 is generic. Both are reported as skips.
 *   - CMDB-038 is POSTURE (18 Sep): it needs three snapshots of duplicate-set
 *     membership, which each run records in `measures.duplicate_sets`.
 *   - CMDB-043 is context: a number, never a finding.
 *   - De-duplication tasks live in `reconcile_duplicate_task`; the CIs in each
 *     are in `duplicate_audit_result` (follow_on_task → task). Both are empty
 *     on a bare PDI, so CMDB-042/043 are evaluated but cannot fire there.
 *
 * PURE — node:net's isIP is a string parser, not a socket.
 */

export const UNIQUENESS_RULES = Object.freeze([
  'CMDB-033', 'CMDB-034', 'CMDB-035', 'CMDB-036', 'CMDB-037', 'CMDB-038', 'CMDB-039', 'CMDB-040', 'CMDB-041', 'CMDB-042', 'CMDB-043',
]);

export const UNIQUENESS_DEFAULTS = Object.freeze({
  /*
   * A retired CI sharing a serial with its replacement is history, not a
   * duplicate. Decision 7 of 19 Sep: the data-quality dimensions exclude
   * Retired (7), Stolen (8) and Absent (100); the lifecycle dimension keeps
   * them. An EMPTY install_status stays in scope — it is not retired, it is
   * unmaintained, and CMDB-085/087 will judge the statuses themselves.
   */
  inactiveInstallStatus: DQ_INACTIVE_INSTALL_STATUS,
  serialMaxFrequency: 10,               // CMDB-035: above this, a bad default value
  nameMaxFrequency: 5,                  // CMDB-034/040: above this, a generic name
  genericNames: Object.freeze(['localhost']),
  excludedCidrs: Object.freeze(['127.0.0.0/8', '169.254.0.0/16', '0.0.0.0/32']),
  vipCidrs: Object.freeze([]),          // an estate states its own VIP ranges
  /* Classes that legitimately share an identity with other CIs: a cluster and
     its members, a load balancer and its pool, a VM object and its guest. A set
     that mixes one of these with another class is modelling, not duplication. */
  sharedIdentityClasses: Object.freeze(['cmdb_ci_cluster', 'cmdb_ci_cluster_node', 'cmdb_ci_cluster_vip', 'cmdb_ci_lb',
    'cmdb_ci_lb_service', 'cmdb_ci_vm_instance', 'cmdb_ci_vmware_instance', 'cmdb_ci_nat']),
  /*
   * CMDB-034 (decision 6 of 19 Sep): an ALLOWLIST of class pairs that may share
   * a name by design — nothing else is suppressed. A printer and a software
   * package called "Canon i960" are reported, because an event or an incident
   * resolving that name by text can bind to either; the branch is reported as
   * context and lowers confidence, it no longer silences the finding.
   */
  permittedClassPairs: Object.freeze([]), // e.g. 'cmdb_ci_appl|cmdb_ci_service', sorted, '|'-joined
  sameBranchConfidence: 0.9,
  crossBranchConfidence: 0.75,
  /*
   * CMDB-037 (decision 5 of 19 Sep): sources REGISTERED as independent key
   * spaces. A correlation_id collision between two of these is two systems
   * numbering their own records, not a duplicate. Anything else is reported —
   * a cross-source collision is often the IRE merge failure this group hunts —
   * at reduced confidence, for review.
   */
  independentKeySpaces: Object.freeze([]),
  crossSourceConfidence: 0.7,
  fuzzyThreshold: 0.85,                 // CMDB-041
  dedupTaskAgeDays: 90,                 // CMDB-042
  trendMinSnapshots: 3,                 // CMDB-038
  trendNoisePerWeek: 0.5,
  identityConfidence: Object.freeze({ correlation_id: 0.98, serial_number: 0.97, mac_address: 0.95, fqdn: 0.93, ip_address: 0.88 }),
});

const empty = (v) => v == null || String(v).trim() === '';
const DAY_MS = 86_400_000;
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * The frequency shape of the repeated values in one estate — printed whenever a
 * frequency guard fires, so the threshold can be argued with rather than
 * trusted. "2:119, 3:47, 4:18, 15:1" reads as: 119 values on two CIs, one value
 * on fifteen.
 */
function histogram(groups) {
  const sizes = {};
  for (const members of groups.values()) if (members.length > 1) sizes[members.length] = (sizes[members.length] || 0) + 1;
  const entries = Object.entries(sizes).sort((a, b) => Number(a[0]) - Number(b[0]));
  return entries.length ? entries.map(([size, n]) => `${size}:${n}`).join(', ') : 'no repeated values';
}

const ATTRIBUTE_RULE = Object.freeze({ serial_number: 'CMDB-035', ip_address: 'CMDB-036', mac_address: 'CMDB-036', fqdn: 'CMDB-036', correlation_id: 'CMDB-037' });

/** Levenshtein ratio: 1 − distance ÷ longer length. */
export function similarity(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 1;
  if (!s.length || !t.length) return 0;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[t.length] / Math.max(s.length, t.length);
}

/** SRV01 / SRV02 — names that differ only in their digits are a sequence, not a near-duplicate. */
export const digitsOnlyDifference = (a, b) => a !== b && a.replace(/\d+/g, '#') === b.replace(/\d+/g, '#');

/** Case, whitespace and domain suffix — the normalisation CMDB-034 and 040 name. */
export function normaliseName(name) {
  const s = String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return validFqdn(s) ? s.split('.')[0] : s;
}

export function cmdbUniquenessRules(ctx, options = {}) {
  const opt = { ...UNIQUENESS_DEFAULTS, ...options };
  const placeholders = { ...COMPLETENESS_DEFAULTS };
  const now = ctx.now;
  const meta = ctx.meta?.cmdb || {};
  const signals = ctx.signals;
  const skip = (rule, table, reason) => ctx.skipped.push({ rule, table, reason });
  const hierarchyOk = meta.reads?.class_hierarchy?.status === 'ok';
  const line = (cls) => lineageOf(meta, cls || 'cmdb_ci');
  const { active: cis, excluded: inactiveCis } = dqActive(ctx.estate.cmdb_ci || [], opt.inactiveInstallStatus);
  const byId = new Map(cis.map((c) => [c.sys_id, c]));
  const add = (rule, records, fields, description, extra = {}, tail = {}) => {
    const m = modifiersFor(records, signals);
    const f = ctx.addCatalogued(rule, 'cmdb_ci', records, fields, description, {
      agent: 'cmdb_agent', escalators: m.escalators, deEscalators: m.deEscalators, notEvaluated: m.notEvaluated, ...extra,
    });
    Object.assign(f, tail);
    return f;
  };
  const label = (c) => `${c.sys_class_name} "${c.name || c.sys_id}"`;
  /* sys_id -> identity-cluster dedupe key, filled by identityRules and read by nameRules. */
  const clusterOf = new Map();
  ctx.measures ||= {};
  if (inactiveCis.length) {
    skip('CMDB-035', 'cmdb_ci', `${inactiveCis.length} retired, stolen or absent CI(s) are outside the data-quality dimensions and were not judged for uniqueness — the lifecycle dimension (CMDB-085/087) evaluates those statuses`);
  }
  /* A status nobody set is not a retired CI. Counted, so the gap is visible until
     a lifecycle rule owns it (decision point raised 19 Sep). */
  ctx.measures.cis_without_install_status = {
    count: (ctx.estate.cmdb_ci || []).filter((c) => String(c.install_status ?? '').trim() === '').length,
    basis: 'cmdb_ci WHERE install_status is empty — kept in the data-quality scope, flagged here because no built rule owns it yet',
  };

  if (!ctx.complete('cmdb_ci', ['sys_class_name', 'install_status'])) {
    for (const id of UNIQUENESS_RULES.filter((r) => !['CMDB-042', 'CMDB-043'].includes(r))) {
      skip(id, 'cmdb_ci', 'cmdb_ci (with class and install status) was not read completely — an unread CI could be the other half of any duplicate');
    }
  } else {
    identityRules();
    nameRules();
  }
  taskRules();

  /* ════════ identity sets: CMDB-035, 036, 037 → clusters → 033, 039, 041, 038 ════════ */
  function identityRules() {
    const sharedClass = (c) => hierarchyOk && line(c.sys_class_name).some((t) => opt.sharedIdentityClasses.includes(t));
    const addressExcluded = (ip) => [...opt.excludedCidrs, ...opt.vipCidrs].some((cidr) => inCidr(ip, cidr))
      || /^(::1?|fe[89ab][0-9a-f]:.*)$/i.test(ip);
    const NORMALISE = {
      serial_number: (v) => (validSerial(v) ? String(v).trim().toUpperCase() : null),
      ip_address: (v) => { const s = String(v).trim(); return isIP(s) && !addressExcluded(s) ? s.toLowerCase() : null; },
      mac_address: (v) => { const s = String(v).replace(/[:.-]/g, '').toLowerCase(); return /^[0-9a-f]{12}$/.test(s) && !/^(0{12}|f{12})$/.test(s) ? s : null; },
      fqdn: (v) => { const s = String(v).trim().toLowerCase().replace(/\.$/, ''); return validFqdn(s) && !s.startsWith('localhost.') ? s : null; },
      correlation_id: (v) => String(v).trim(),
    };
    const valueOf = (c, attr) => (empty(c[attr]) || isPlaceholder(c[attr], placeholders) ? null : NORMALISE[attr](c[attr]));

    const sets = [];                                       // { attr, value, members }
    const evaluated = [];
    for (const attr of Object.keys(NORMALISE)) {
      const rule = ATTRIBUTE_RULE[attr];
      if (!ctx.complete('cmdb_ci', [attr])) {
        skip(rule, 'cmdb_ci', `cmdb_ci did not return ${attr} — duplicates on it are not evaluated`);
        continue;
      }
      evaluated.push(attr);
      const groups = new Map();
      for (const c of cis) {
        const v = valueOf(c, attr);
        if (v == null) continue;
        if (!groups.has(v)) groups.set(v, []);
        groups.get(v).push(c);
      }
      const tooFrequent = [];
      let modelled = 0;
      let keySpaces = 0;
      for (const [value, members] of groups) {
        if (members.length < 2) continue;
        if (attr === 'serial_number' && members.length > opt.serialMaxFrequency) { tooFrequent.push([value, members.length]); continue; }
        const classes = new Set(members.map((c) => c.sys_class_name));
        if (classes.size > 1 && members.some(sharedClass)) { modelled += 1; continue; }
        if (attr === 'ip_address' && members.some(sharedClass)) { modelled += 1; continue; }
        let sources = null;
        if (attr === 'correlation_id') {
          sources = [...new Set(members.map((c) => String(c.discovery_source || '').trim()).filter(Boolean))];
          /* Skipped ONLY when every source involved is registered as its own key
             space. Otherwise it is reported, at reduced confidence. */
          if (sources.length > 1 && sources.every((x) => opt.independentKeySpaces.includes(x))) { keySpaces += 1; continue; }
        }
        sets.push({ attr, value, members, sources });
      }
      if (tooFrequent.length) {
        const top = [...tooFrequent].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([v, n]) => `"${v}" x${n}`).join(', ');
        const cisHit = tooFrequent.reduce((n, [, c]) => n + c, 0);
        skip(rule, 'cmdb_ci', `${tooFrequent.length} serial value(s) on more than ${opt.serialMaxFrequency} active CIs (${cisHit} CIs) treated as a bad default value, not duplicates: ${top}. `
          + `Distribution of repeated serials in this estate: ${histogram(groups)}. Review them as a data-load defect, and re-set the threshold if this estate's shape says otherwise.`);
      }
      if (modelled) skip(rule, 'cmdb_ci', `${modelled} ${attr} set(s) involve a cluster, load-balancer, NAT or VM-object class — legitimate shared identity, not flagged`);
      if (keySpaces) skip(rule, 'cmdb_ci', `${keySpaces} correlation_id set(s) whose members all come from sources registered as independent key spaces — not flagged`);
    }

    /* ── clusters: union every set that shares a member ── */
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (const s of sets) for (const c of s.members) if (!parent.has(c.sys_id)) parent.set(c.sys_id, c.sys_id);
    for (const s of sets) for (const c of s.members.slice(1)) parent.set(find(c.sys_id), find(s.members[0].sys_id));
    const clusters = new Map();                            // root -> { ids:Set, sets:[] }
    for (const s of sets) {
      const root = find(s.members[0].sys_id);
      if (!clusters.has(root)) clusters.set(root, { ids: new Set(), sets: [] });
      const k = clusters.get(root);
      for (const c of s.members) k.ids.add(c.sys_id);
      k.sets.push(s);
    }
    for (const k of clusters.values()) {
      k.key = `dup:${hash([...k.ids].sort().join('|'))}`;
      for (const id of k.ids) clusterOf.set(id, k.key);
    }
    const confidenceOf = (attrs) => Math.max(...attrs.map((a) => opt.identityConfidence[a] ?? 0.85));

    /* ── CMDB-035 / 036 / 037 — one finding per exact set ── */
    for (const s of sets) {
      const rule = ATTRIBUTE_RULE[s.attr];
      const k = clusters.get(find(s.members[0].sys_id));
      const crossSource = s.attr === 'correlation_id' && (s.sources || []).length > 1;
      add(rule, s.members, [s.attr, 'sys_class_name', 'name', 'discovery_source'],
        `${s.members.length} active CIs share ${s.attr} "${s.members[0][s.attr]}": ${s.members.map(label).join(', ')}. Identification matches either one, so updates split between records and every consumer sees half the truth.`
        + (crossSource ? ` The members come from different sources (${s.sources.join(', ')}), which is usually an IRE merge that did not happen — register those sources as independent key spaces if they genuinely number their own records.` : ''),
        { confidence: crossSource ? opt.crossSourceConfidence : opt.identityConfidence[s.attr], guard: { evaluated: true, note: s.attr === 'serial_number'
          ? `Placeholders and serials on more than ${opt.serialMaxFrequency} CIs (bad defaults) are excluded.`
          : s.attr === 'correlation_id' ? 'Only sets whose sources are ALL registered as independent key spaces are excluded; a cross-source collision is reported at reduced confidence.'
            : 'Loopback, link-local, 0.0.0.0, configured VIP ranges and cluster / load-balancer / NAT / VM-object classes are excluded.' } },
        { dedupe_key: k.key, duplicate_set: { attribute: s.attr, value: String(s.members[0][s.attr]), cluster: k.key } });
    }

    /* ── CMDB-033 — asymmetric: some members related, some not ── */
    const relOk = ctx.complete('cmdb_rel_ci', ['parent', 'child']);
    const edges = new Map();
    if (!relOk) {
      skip('CMDB-033', 'cmdb_rel_ci', 'Relationships were not read completely, so "has no relationships" cannot be told from "not read"');
    } else {
      for (const r of ctx.estate.cmdb_rel_ci || []) {
        for (const id of [r.parent, r.child]) if (id) edges.set(id, (edges.get(id) || 0) + 1);
      }
      for (const k of clusters.values()) {
        const members = [...k.ids].map((id) => byId.get(id));
        const related = members.filter((c) => edges.get(c.sys_id));
        const bare = members.filter((c) => !edges.get(c.sys_id));
        if (!related.length || !bare.length) continue;
        const attrs = [...new Set(k.sets.map((s) => s.attr))];
        /*
         * The 5x lands on the BARE twin — the record with nothing pointing at
         * it, which is the defect. The related twin is the victim: it carries
         * the relationships, the impact analysis and the history, and it is
         * charged as an ordinary duplicate (confirmed 19 Sep).
         */
        const multiplierByRecord = Object.fromEntries(bare.map((c) => [c.sys_id, 5]));
        add('CMDB-033', members, [...attrs, 'sys_class_name', 'name'],
          `Duplicate set matched on ${attrs.join(', ')}: ${related.map((c) => `${label(c)} (${edges.get(c.sys_id)} relationship(s))`).join(', ')} versus ${bare.map((c) => `${label(c)} (none)`).join(', ')}. Impact analysis follows the related record while updates may land on the bare one — the map and the data disagree silently. The bare record is charged 5x as the defect; the related one is charged as an ordinary duplicate.`,
          { confidence: confidenceOf(attrs), guard: { evaluated: true, note: 'Sets mixing a cluster, load-balancer, NAT or VM-object class with its members were excluded before this rule ran.' } },
          { dedupe_key: k.key, deduction_multiplier_by_record: multiplierByRecord, duplicate_set: { attribute: attrs.join(','), cluster: k.key, bare: bare.map((c) => c.sys_id) } });
      }
    }

    /* ── CMDB-039 — reported per discovery-source pair, no deduction ── */
    const pairs = new Map();                               // "a ⇄ b" -> { ids:Set, clusters:number }
    for (const k of clusters.values()) {
      const sources = [...new Set([...k.ids].map((id) => String(byId.get(id).discovery_source || '').trim()).filter(Boolean))].sort();
      for (let i = 0; i < sources.length; i++) {
        for (let j = i + 1; j < sources.length; j++) {
          const key = `${sources[i]} ⇄ ${sources[j]}`;
          if (!pairs.has(key)) pairs.set(key, { ids: new Set(), clusters: 0, sources: [sources[i], sources[j]] });
          const p = pairs.get(key);
          p.clusters += 1;
          for (const id of k.ids) if ([sources[i], sources[j]].includes(String(byId.get(id).discovery_source || '').trim())) p.ids.add(id);
        }
      }
    }
    const ranked = [...pairs.entries()].sort((a, b) => b[1].clusters - a[1].clusters);
    ranked.forEach(([key, p], i) => {
      add('CMDB-039', [...p.ids].map((id) => byId.get(id)), ['discovery_source', 'sys_class_name', 'name'],
        `Rank ${i + 1} of ${ranked.length}: ${p.clusters} duplicate set(s) where ${key} each created a record for the same CI. The two sources are not reconciling against each other — fix the identification or precedence rule for this pair, not the records.`,
        { guard: { evaluated: true, note: 'CIs with an empty discovery_source are not attributed to a source.' } },
        { unscored_reason: 'reported per discovery-source pair — its records are charged by the duplicate rule that found each set', source_pair: p.sources });
    });

    /* ── CMDB-041 — fuzzy name AND an exact identity match, per pair ── */
    for (const k of clusters.values()) {
      const members = [...k.ids].map((id) => byId.get(id));
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = members[i];
          const b = members[j];
          const na = normaliseName(a.name);
          const nb = normaliseName(b.name);
          if (!na || !nb || na === nb || digitsOnlyDifference(na, nb)) continue;
          const sim = similarity(na, nb);
          if (sim < opt.fuzzyThreshold) continue;
          const shared = k.sets.filter((s) => s.members.includes(a) && s.members.includes(b)).map((s) => s.attr);
          if (!shared.length) continue;
          const identity = confidenceOf(shared);
          add('CMDB-041', [a, b], [...shared, 'name', 'sys_class_name'],
            `${label(a)} and ${label(b)}: names ${Math.round(sim * 100)}% similar and ${shared.join(', ')} identical. Likely one CI recorded twice under a variant name.`,
            { confidence: Number((identity * sim).toFixed(3)), evidence: [{
              source: 'Health Assist name comparison', sn_table: 'cmdb_ci', sn_sys_id: a.sys_id, field_name: 'name_similarity',
              field_value: `${sim.toFixed(3)} × identity ${identity}`, reason: `Levenshtein ratio on normalised names; identity match on ${shared.join(', ')}`, collected_at: now.toISOString(),
            }], guard: { evaluated: true, note: 'Never fires on name similarity alone; names that differ only in digits (SRV01 / SRV02) are excluded.' } },
            { dedupe_key: k.key });
        }
      }
    }

    /* ── CMDB-038 — posture: duplicate sets rising across snapshots ── */
    const snapshot = { at: now.toISOString(), count: clusters.size, keys: [...clusters.values()].map((k) => k.key).sort() };
    const complete = evaluated.length === Object.keys(NORMALISE).length;
    ctx.measures.duplicate_sets = { ...snapshot, attributes: evaluated, complete };
    const history = (ctx.history?.duplicate_sets || []).filter((h) => h?.complete && Array.isArray(h.keys) && parseDate(h.at));
    const series = [...history, snapshot].sort((a, b) => parseDate(a.at) - parseDate(b.at));
    if (!complete) {
      skip('CMDB-038', 'cmdb_ci', 'Not every identity attribute was read this run, so its duplicate-set count is not comparable across snapshots');
    } else if (series.length < opt.trendMinSnapshots) {
      skip('CMDB-038', 'health_runs', `Needs ${opt.trendMinSnapshots} snapshots of duplicate-set membership; ${series.length} exist (this run recorded one). Evaluates automatically once there are enough.`);
    } else {
      const t0 = parseDate(series[0].at).getTime();
      const xs = series.map((s) => (parseDate(s.at).getTime() - t0) / (7 * DAY_MS));
      const ys = series.map((s) => s.count);
      const mx = xs.reduce((n, x) => n + x, 0) / xs.length;
      const my = ys.reduce((n, y) => n + y, 0) / ys.length;
      const den = xs.reduce((n, x) => n + (x - mx) ** 2, 0);
      const slope = den ? xs.reduce((n, x, i) => n + (x - mx) * (ys[i] - my), 0) / den : 0;
      const fresh = series.slice(1).map((s, i) => s.keys.filter((key) => !series[i].keys.includes(key)).length);
      const sustained = fresh.every((n) => n > 0);
      const weeks = xs[xs.length - 1];
      if (slope > opt.trendNoisePerWeek && sustained) {
        add('CMDB-038', [], [], `Duplicate sets rose from ${ys[0]} to ${ys[ys.length - 1]} over ${weeks.toFixed(1)} week(s) across ${series.length} snapshots (+${slope.toFixed(2)} per week), with new sets appearing in every interval (${fresh.join(', ')}). Duplicates are being created faster than they are resolved — the identification controls are losing.`,
          { guard: { evaluated: true, note: `Window ${series[0].at} → ${snapshot.at}. A one-time burst is excluded: new sets must appear in every interval, not one.` } });
      }
    }
  }

  /* ════════ names: CMDB-034 across classes, CMDB-040 within a class ════════ */
  function nameRules() {
    if (!ctx.complete('cmdb_ci', ['name'])) {
      skip('CMDB-034', 'cmdb_ci', 'cmdb_ci did not return name');
      skip('CMDB-040', 'cmdb_ci', 'cmdb_ci did not return name');
      return;
    }
    const groups = new Map();
    for (const c of cis) {
      const n = normaliseName(c.name);
      if (!n || isPlaceholder(n, placeholders) || opt.genericNames.includes(n)) continue;
      if (!groups.has(n)) groups.set(n, []);
      groups.get(n).push(c);
    }
    const related = new Set();
    const relOk = ctx.complete('cmdb_rel_ci', ['parent', 'child']);
    if (relOk) for (const r of ctx.estate.cmdb_rel_ci || []) related.add(`${r.parent}|${r.child}`).add(`${r.child}|${r.parent}`);
    /* The class directly under cmdb_ci. Measured on dev424910: cmdb_ci itself
       extends `cmdb`, so "second from the root" is cmdb_ci for every class. */
    const branch = (cls) => { const l = line(cls); const at = l.indexOf('cmdb_ci'); return at > 0 ? l[at - 1] : l[0]; };
    const keyOf = (members) => {
      const keys = new Set(members.map((c) => clusterOf.get(c.sys_id)));
      return keys.size === 1 && !keys.has(undefined) ? [...keys][0] : null;
    };

    let generic = 0;                                     // CMDB-040: names on > N CIs of ONE class
    let genericCis = 0;
    let genericAcross = 0;                               // CMDB-034: names on > N CIs across classes
    let crossBranch = 0;                                 // reported, with lower confidence
    let crossGuarded = 0;
    /* The hierarchy is used for CONTEXT now, not for suppression: without it the
       rule still runs, and every pair is reported at the lower confidence. */
    if (!hierarchyOk) skip('CMDB-034', 'sys_db_object', 'The class hierarchy could not be read, so same-branch and cross-branch pairs cannot be told apart — every pair is reported at cross-branch confidence');
    for (const [n, members] of groups) {
      if (members.length < 2) continue;

      /* CMDB-040 — within class. Generic is counted within the class: three
         laptops and three software packages sharing a name are two small sets. */
      const byClass = new Map();
      for (const c of members) {
        if (!byClass.has(c.sys_class_name)) byClass.set(c.sys_class_name, []);
        byClass.get(c.sys_class_name).push(c);
      }
      for (const [cls, same] of byClass) {
        if (same.length < 2) continue;
        if (same.length > opt.nameMaxFrequency) { generic += 1; genericCis += same.length; continue; }
        const key = keyOf(same);
        add('CMDB-040', same, ['name', 'sys_class_name', 'serial_number', 'ip_address'],
          `${same.length} active ${cls} CIs are named "${same[0].name}" (normalised "${n}"). Anyone — or any integration — resolving the CI by name picks one arbitrarily.`,
          { confidence: 0.9, guard: { evaluated: true, note: `Case, whitespace and domain suffix normalised; names on more than ${opt.nameMaxFrequency} CIs and generic names (${opt.genericNames.join(', ')}) are excluded.` } },
          key ? { dedupe_key: key } : {});
      }

      /* CMDB-034 — across classes */
      if (byClass.size < 2) continue;
      if (members.length > opt.nameMaxFrequency) { genericAcross += 1; continue; }
      const involved = new Set();
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = members[i];
          const b = members[j];
          if (a.sys_class_name === b.sys_class_name) continue;
          const pair = [a.sys_class_name, b.sys_class_name].sort().join('|');
          if (opt.permittedClassPairs.includes(pair) || related.has(`${a.sys_id}|${b.sys_id}`)) { crossGuarded += 1; continue; }
          if (hierarchyOk && branch(a.sys_class_name) !== branch(b.sys_class_name)) crossBranch += 1;
          involved.add(a).add(b);
        }
      }
      if (involved.size < 2) continue;
      const list = [...involved];
      const key = keyOf(list);
      const branches = hierarchyOk ? [...new Set(list.map((c) => branch(c.sys_class_name)))] : [];
      const sameBranch = branches.length === 1;
      add('CMDB-034', list, ['name', 'sys_class_name'],
        `"${list[0].name}" exists as ${list.map((c) => c.sys_class_name).join(', ')}. One CI recorded in more than one class splits its relationships, tickets and health between them`
        + (sameBranch || !branches.length ? '.' : `, and anything that resolves this name by text — an event, an alert, an import — can bind to either. The classes sit in unrelated branches (${branches.join(', ')}), so this may be a naming coincidence: add the pair to the permitted list if it is.`),
        { confidence: sameBranch || !branches.length ? opt.sameBranchConfidence : opt.crossBranchConfidence,
          guard: { evaluated: true, note: `Excluded: permitted class pairs (${opt.permittedClassPairs.length} configured) and CIs directly related to each other (parent-child modelling)${relOk ? '' : ' — relationships were not read, so this part was not checked'}. Classes in unrelated branches are REPORTED at lower confidence, not suppressed.` } },
        key ? { dedupe_key: key } : {});
    }
    if (generic) {
      skip('CMDB-040', 'cmdb_ci', `${generic} name(s) on more than ${opt.nameMaxFrequency} active CIs of one class (${genericCis} CIs) treated as generic — a model or template name, not a duplicate. Distribution of repeated names: ${histogram(groups)}.`);
    }
    if (genericAcross) skip('CMDB-034', 'cmdb_ci', `${genericAcross} name(s) on more than ${opt.nameMaxFrequency} active CIs across classes treated as generic`);
    if (crossGuarded) skip('CMDB-034', 'cmdb_ci', `${crossGuarded} same-name class pair(s) excluded as a permitted pair or as directly related CIs`);
    if (crossBranch) skip('CMDB-034', 'cmdb_ci', `${crossBranch} same-name pair(s) sit in unrelated branches of cmdb_ci — reported at ${opt.crossBranchConfidence} confidence rather than suppressed (decision 6 of 19 Sep)`);
  }

  /* ════════ de-duplication tasks: CMDB-042 (aged), CMDB-043 (count) ════════ */
  function taskRules() {
    const fields = ['number', 'active', 'opened_at', 'sys_created_on'];
    if (!ctx.complete('reconcile_duplicate_task', fields)) {
      const why = 'reconcile_duplicate_task was not read completely';
      skip('CMDB-042', 'reconcile_duplicate_task', why);
      skip('CMDB-043', 'reconcile_duplicate_task', why);
      return;
    }
    const open = (ctx.estate.reconcile_duplicate_task || []).filter((t) => String(t.active) === 'true');
    ctx.measures.open_dedup_tasks = { count: open.length, basis: 'reconcile_duplicate_task WHERE active=true' };

    const auditOk = ctx.complete('duplicate_audit_result', ['follow_on_task', 'duplicate_ci']);
    const cisOf = new Map();
    if (auditOk) {
      for (const r of ctx.estate.duplicate_audit_result || []) {
        if (!r.follow_on_task || !byId.has(r.duplicate_ci)) continue;
        if (!cisOf.has(r.follow_on_task)) cisOf.set(r.follow_on_task, new Set());
        cisOf.get(r.follow_on_task).add(r.duplicate_ci);
      }
    }
    for (const t of open) {
      const opened = parseDate(t.opened_at) || parseDate(t.sys_created_on);
      if (!opened) continue;
      const days = Math.floor((now - opened) / DAY_MS);
      if (days <= opt.dedupTaskAgeDays) continue;
      const members = [...(cisOf.get(t.sys_id) || [])].map((id) => byId.get(id));
      const text = `De-duplication task ${t.number || t.sys_id} has been open ${days} days (threshold ${opt.dedupTaskAgeDays})${t.duplicate_count ? ` covering ${t.duplicate_count} duplicate CI(s)` : ''}. The duplicate is known and nobody is resolving it.`;
      const guard = { evaluated: false, note: 'Whether the task is deliberately parked (pending a migration) is not recorded on the task, so it cannot be checked.' };
      if (members.length) {
        const f = add('CMDB-042', members, ['name', 'sys_class_name'], text, { guard });
        f.evidence.push({ source: 'ServiceNow Table REST API', sn_table: 'reconcile_duplicate_task', sn_sys_id: t.sys_id, field_name: 'opened_at', field_value: String(t.opened_at || t.sys_created_on), reason: `${days} days open`, collected_at: now.toISOString() });
      } else {
        const m = { escalators: [], deEscalators: [], notEvaluated: [] };
        const f = ctx.addCatalogued('CMDB-042', 'reconcile_duplicate_task', [t], ['number', 'opened_at', 'duplicate_count'], text, {
          agent: 'cmdb_agent', ...m, guard,
        });
        f.unscored_reason = auditOk
          ? 'the task names no in-scope CI in duplicate_audit_result, so there is no record to deduct from'
          : 'duplicate_audit_result was not read, so the task\'s CIs are unknown and there is no record to deduct from';
      }
    }
  }
}
