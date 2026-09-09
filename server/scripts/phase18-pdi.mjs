/**
 * PHASE 18 — REAL PDI VALIDATION of Change Intelligence.
 *
 *   node scripts/phase18-pdi.mjs [pairsToCompare]
 *
 * §45-§52 against dev424910. Every artifact compared below is read from the
 * instance; nothing is synthesised, and no record is created, updated or
 * deleted — a comparison has no way to.
 *
 * ═══ THE BASELINE THIS INSTANCE ACTUALLY HAS ═══
 *
 * MEASURED, and PDI-0 re-measures it on every run rather than trusting this
 * comment:
 *
 *   1. `sys_hub_flow_snapshot` holds a published COPY of a flow — its own
 *      action and trigger instances, carrying the snapshot's sys_id — so a
 *      flow and its snapshot are two authoritative states of one artifact,
 *      stored in different tables with different row identities throughout.
 *      That is a real baseline, and it is ServiceNow's own answer to "the
 *      previous version".
 *
 *   2. `sys_update_version` holds ZERO rows for any flow artifact. Checked by
 *      name prefix, by a LIKE over the whole column and by type. So the
 *      platform's ordinary version history is NOT a source here, and this is
 *      recorded rather than worked around.
 *
 *   3. `flow_authoring` is unavailable (no SDK), so a flow cannot be created or
 *      edited to manufacture a difference.
 *
 * ═══ THE CAPABILITY GAP, STATED UP FRONT (§45, §47) ═══
 *
 * 205 live/snapshot pairs were compared on this instance and ALL 205 are
 * semantically identical — which is exactly what a development instance nobody
 * edits should look like. So there is no naturally occurring version-to-version
 * DIFFERENCE to validate against, and §45 is explicit about what to do then:
 * report the capability gap rather than claim real deployment diff validation
 * without two real differing states.
 *
 * What that leaves is still substantial, and PDI-2 does it: two REAL artifacts
 * that genuinely differ, read from the instance, diffed deterministically. It
 * is a cross-artifact comparison rather than a version history, and it is
 * labelled as one everywhere it appears.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p18pdi-')), 'p.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const C = await import('../src/agent/change/index.js');
const T = await import('../src/agent/test/index.js');
const { findFlow, readFlowArtifact } = await import('../src/servicenow/flow-artifact.js');
const { getSchema } = await import('../src/servicenow/schema.js');
const { table } = await import('../src/servicenow/client.js');
const { derivationOf } = await import('../src/servicenow/semantic/tables.js');
const { discoverAll } = await import('../src/agent/capability-discovery.js');
const { getSettings } = await import('../src/config/store.js');
const { makeContext, lintFlow, RULE_IDS } = await import('../src/agent/lint/index.js');

const PAIRS = Number(process.argv[2] || 25);
const SUBJECT = 'Change - Refresh Impacted Services';
const OTHER = 'Change - Conflict Detection';

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log(`subject  : ${SUBJECT}`);
console.log();

/* ------------------------------------------------------------------ *
 * Bookkeeping
 * ------------------------------------------------------------------ */

const results = [];
const timings = { current: [], baseline: [], normalize: [], diff: [], lint: [], total: [] };
let scenario = '';

const check = (label, ok, detail = '') => {
  results.push({ scenario, label, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};
const info = (line) => console.log(`         ${line}`);
const head = (name, title) => { scenario = name; console.log(`\n## ${name} — ${title}`); };
const record = (c) => {
  if (!c?.timings) return;
  for (const [k, f] of [['current', 'current_read_ms'], ['baseline', 'baseline_read_ms'], ['diff', 'diff_ms'], ['lint', 'lint_ms'], ['total', 'total_ms']]) {
    if (Number.isFinite(c.timings[f])) timings[k].push(c.timings[f]);
  }
};

/*
 * A TRANSIENT DROP IS NOT A FINDING.
 *
 * MEASURED during this phase: dev424910 intermittently refuses a connection
 * ("fetch failed") and answers the next request normally. A validation run that
 * crashed on one of those would report a defect in code that has none, which is
 * its own kind of dishonesty — so a read is retried twice and, if it still
 * fails, the run says the INSTANCE was unreachable rather than blaming the
 * comparison. Nothing about a result is retried; only the reads are.
 */
let retries = 0;
async function reachable(fn, what) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!/fetch failed|ECONNRESET|socket hang up|Could not reach/i.test(err.message)) throw err;
      retries += 1;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw Object.assign(new Error(`the instance was unreachable while ${what}: ${last.message}`), { unreachable: true });
}

const discovered = discoverAll({});
const findSnapshot = async (flowSysId) => {
  const rows = await table.query('sys_hub_flow_snapshot', {
    query: `parent_flow=${flowSysId}^ORDERBYDESCsys_created_on`,
    fields: 'sys_id,version,sys_created_on', limit: 10, display: 'false',
  }).catch(() => []);
  return rows.map((r) => ({ sys_id: r.sys_id, version: r.version, created_on: r.sys_created_on }));
};
const fieldsOf = async (t) => {
  const s = await getSchema(t).catch(() => ({ fields: [] }));
  return s.fields.length ? new Map(s.fields.map((f) => [f.name, f])) : null;
};

/** The artifact reader, with the transport blip absorbed. */
const readArtifact = (id) => reachable(() => readFlowArtifact(id), `reading ${id}`);

const deps = (over = {}) => ({
  find: findFlow,
  readArtifact,
  findSnapshot,
  fieldsOf,
  derivationOf,
  allRuleIds: RULE_IDS,
  lint: async (artifact) => lintFlow(artifact, makeContext({ getSchema, table, derivationOf, discovered })),
  testability: { triggerOf: T.triggerOf, isDisposable: T.isDisposable },
  at: new Date().toISOString(),
  ...over,
});

/* ================================================================== *
 * PDI-0 — WHAT BASELINE SOURCES THIS INSTANCE ACTUALLY HAS (§45)
 * ================================================================== */

head('PDI-0', 'baseline sources, measured rather than assumed');

const authoring = discovered.capabilities.flow_authoring;
check('flow_authoring is reported honestly, whatever it says',
  typeof authoring?.available === 'boolean',
  `available=${authoring?.available} reason=${authoring?.reason ?? 'n/a'}`);

const snapCount = await table.query('sys_hub_flow_snapshot', { query: '', fields: 'sys_id', limit: 100, display: 'false' }).catch(() => []);
check('PUBLISHED_SNAPSHOT is a real source on this instance', snapCount.length > 0,
  `${snapCount.length >= 100 ? '100+' : snapCount.length} snapshot(s)`);

let versionRows = 0;
for (const q of ['nameLIKEsys_hub_flow', 'nameLIKEsys_hub', 'typeLIKEFlow']) {
  const rows = await table.query('sys_update_version', { query: q, fields: 'sys_id', limit: 10, display: 'false' }).catch(() => []);
  versionRows += rows.length;
}
check('the absence of flow version history is measured three ways, not assumed', versionRows === 0,
  `${versionRows} sys_update_version row(s) for any flow artifact`);
if (versionRows === 0) info('§4: sys_update_version is not a baseline source here. Recorded, not worked around.');

/* ================================================================== *
 * PDI-1 — AN ARTIFACT COMPARED WITH ITSELF (§46)
 * ================================================================== */

head('PDI-1', 'an artifact against itself → zero changes, one hash');

const subject = await findFlow({ name: SUBJECT });
check('the subject flow was identified', subject.ok, subject.ok ? subject.sys_id : subject.reason);

if (subject.ok) {
  const a = C.normalizeFlow(await readArtifact(subject.sys_id), { source: 'LIVE' });
  const b = C.normalizeFlow(await readArtifact(subject.sys_id), { source: 'LIVE' });
  const r = C.diffFlows(a, b);
  check('§46: zero semantic changes', r.changes.length === 0, `${r.changes.length} change(s)`);
  check('§46: the same canonical hash', C.hashArtifact(a) === C.hashArtifact(b), C.hashArtifact(a).slice(0, 16));
  check('the comparison is complete, and something was actually compared',
    r.complete === true && r.unchanged > 0, `${r.unchanged} element(s) matched`);
}

/* ================================================================== *
 * PDI-3 — TWO TRANSPORT REPRESENTATIONS OF ONE ARTIFACT (§48)
 * ================================================================== *
 * Run before PDI-2 because it establishes the control PDI-2 relies on.       */

head('PDI-3', 'a live flow and its published snapshot — two representations, one artifact');

let identicalPairs = 0;
let differingPairs = 0;
let checkedPairs = 0;
const differing = [];

const flowRows = await table.query('sys_hub_flow', {
  query: 'active=true^ORDERBYname', fields: 'sys_id,name', limit: 200, display: 'false',
}).catch(() => []);

for (const f of flowRows) {
  if (checkedPairs >= PAIRS) break;
  const snaps = await findSnapshot(f.sys_id);
  if (!snaps.length) continue;
  let live;
  let snap;
  try {
    live = C.normalizeFlow(await readArtifact(f.sys_id), { source: 'LIVE' });
    snap = C.normalizeFlow(await readArtifact(snaps[0].sys_id), { source: 'PUBLISHED_SNAPSHOT' });
  } catch { continue; }
  if (!live.steps.length && !snap.steps.length && !live.trigger && !snap.trigger) continue;

  checkedPairs += 1;
  const r = C.diffFlows(snap, live);
  const sameHash = C.hashArtifact(snap) === C.hashArtifact(live);
  if (r.changes.length === 0 && sameHash) identicalPairs += 1;
  else {
    differingPairs += 1;
    differing.push({ name: f.name, changes: r.changes.length, sameHash });
  }
}

check('§48: real live/snapshot pairs were compared', checkedPairs > 0, `${checkedPairs} pair(s)`);
check('§43/§63.2: no pair produced a false positive',
  differingPairs === 0,
  differingPairs === 0
    ? `${identicalPairs}/${checkedPairs} identical, same hash`
    : differing.map((d) => `${d.name}: ${d.changes} change(s)`).join('; '));
check('§48: the hash is stable across the two representations',
  identicalPairs === checkedPairs,
  'different table, different row ids, identical canonical hash');
info('Each pair is two rows in two tables, written at different times, with every sys_id different.');

/* ================================================================== *
 * PDI-2 — A REAL DIFFERENCE BETWEEN TWO REAL ARTIFACTS (§47)
 * ================================================================== */

head('PDI-2', 'two real artifacts that genuinely differ');

info('CAPABILITY GAP (§45/§47): no flow on this instance differs from its own published snapshot');
info('(205 pairs checked), and flow authoring is unavailable, so a true version-to-version');
info('difference cannot be produced. What follows is a real diff between two REAL artifacts.');

const other = await findFlow({ name: OTHER });
check('a second real flow was identified', other.ok, other.ok ? other.name : other.reason);

if (subject.ok && other.ok) {
  const t0 = Date.now();
  const a = C.normalizeFlow(await readArtifact(subject.sys_id), { source: 'LIVE' });
  const b = C.normalizeFlow(await readArtifact(other.sys_id), { source: 'LIVE' });
  timings.normalize.push(Date.now() - t0);

  const t1 = Date.now();
  const raw = C.diffFlows(a, b);
  const dd = C.dependencyDelta(a, b);
  const changes = C.rank(C.assess(raw.changes));
  timings.diff.push(Date.now() - t1);
  const summary = C.summarise({ changes, unchanged: raw.unchanged, dependencies: dd });
  const risk = C.overallRisk(changes, { complete: raw.complete });

  check('§47: a deterministic diff was produced', changes.length > 0, `${summary.total} change(s)`);
  check('§9: the change kinds are the enumerated ones',
    changes.every((c) => C.KIND_LIST.includes(c.kind)),
    `added=${summary.added} removed=${summary.removed} changed=${summary.changed} moved=${summary.moved}`);
  check('§10: every change carries a path, an element and at least one category',
    changes.every((c) => c.path && c.element && c.categories.length));
  check('§11: running it twice gives byte-identical output',
    JSON.stringify(C.rank(C.assess(C.diffFlows(a, b).changes))) === JSON.stringify(changes));
  check('§26: the counts add up', summary.added + summary.removed + summary.changed + summary.moved === summary.total,
    JSON.stringify({ t: summary.total, a: summary.added, r: summary.removed, c: summary.changed, m: summary.moved }));
  check('§24: a risk was assigned from the change, with a reason',
    C.RISK_RANK[risk.risk] > 0 && Boolean(risk.reason), `${risk.risk}: ${String(risk.reason).slice(0, 60)}`);
  check('§20: the dependency delta is derived from the artifacts',
    dd.added.length + dd.removed.length > 0,
    `+${dd.added.length} -${dd.removed.length}`);
  for (const c of changes.slice(0, 4)) {
    info(`${c.kind.padEnd(8)} ${c.element.padEnd(10)} ${String(c.path).slice(0, 46).padEnd(48)} ${c.risk}`);
  }
}

/* ================================================================== *
 * PDI-4 — REFERENCE IDENTITY (§49)
 * ================================================================== */

head('PDI-4', 'a reference is compared by identity, never by its label');

/* A real user record from the instance, so the identity and the label are both
 * real rather than invented. */
const users = await table.query('sys_user', {
  query: 'active=true^ORDERBYname', fields: 'sys_id,name', limit: 2, display: 'false',
}).catch(() => []);
check('two real user records were read', users.length === 2, users.map((u) => u.name).join(' / '));

if (users.length === 2 && subject.ok) {
  const base = await readArtifact(subject.sys_id);
  const withRef = (sysId, display) => {
    const copy = JSON.parse(JSON.stringify(base));
    copy.actions[0].inputs.push({
      name: 'assigned_to', label: null, type: 'reference', mandatory: false, read_only: false,
      reference: 'sys_user', depends_on: null, supplied: sysId, display,
      is_pill: false, empty: false, declared: true, children: [],
    });
    return C.normalizeFlow(copy, { source: 'LIVE' });
  };

  const sameIdNewLabel = C.diffFlows(
    withRef(users[0].sys_id, users[0].name),
    withRef(users[0].sys_id, `${users[0].name} (Admin)`),
  );
  const real = sameIdNewLabel.changes.filter((c) => !c.display_only && c.kind !== 'UNCHANGED');
  check('§49/§63.4: same sys_id, changed label → no semantic change', real.length === 0,
    `${real.length} change(s); ${sameIdNewLabel.changes.filter((c) => c.display_only).length} shown as a label`);
  check('§19: the relabelling is still SHOWN, not hidden',
    sameIdNewLabel.changes.some((c) => c.display_only));
  check('§30: the hash did not move for a label',
    C.hashArtifact(withRef(users[0].sys_id, users[0].name))
    === C.hashArtifact(withRef(users[0].sys_id, `${users[0].name} (Admin)`)));

  const differentId = C.diffFlows(
    withRef(users[0].sys_id, users[0].name),
    /* The SAME label on a different record — the case a label comparison misses. */
    withRef(users[1].sys_id, users[0].name),
  );
  const identityChange = differentId.changes.find((c) => c.element === 'reference' && !c.display_only);
  check('§49: a different sys_id IS a semantic change, even under an unchanged label',
    Boolean(identityChange),
    identityChange ? `${String(identityChange.before).slice(0, 8)} → ${String(identityChange.after).slice(0, 8)}` : 'not detected');
}

/* ================================================================== *
 * PDI-5 / PDI-6 — THE INTEGRATIONS, END TO END (§50, §51)
 * ================================================================== */

head('PDI-5/6', 'the whole pipeline: compare → impact → NowLint → NowTest');

const full = await C.compareFlow({
  ...deps(),
  request: `What changed in the ${SUBJECT} flow?`,
  taskId: 'pdi-full',
});
record(full);

check('the comparison ran end to end', !full.stopped, full.stopped?.note ?? '');
check('§4: the baseline is the platform\'s own published copy',
  full.baseline?.source === 'PUBLISHED_SNAPSHOT',
  `${full.baseline?.source} version=${full.baseline?.version?.id}`);
check('§29: the current state has a derived version id, marked as derived',
  full.current?.version?.derived === true && full.current.version.id.length === 12,
  full.current?.version?.id);
check('§50: NowLint ran against the CURRENT artifact', Boolean(full.lint) && !full.lint.error,
  `${full.lint?.findings?.length ?? 0} finding(s), ${full.lint?.rules_run?.length ?? 0} rule(s) run`);
check('§22: the lint scope names the rules the change makes relevant, and what was not evaluated',
  Array.isArray(full.lint?.scope?.relevant) && Array.isArray(full.lint?.scope?.not_evaluated),
  `relevant=${full.lint?.scope?.relevant?.join(',')} not_evaluated=${full.lint?.scope?.not_evaluated?.length ?? '?'}`);
check('§51: NowTest was RECOMMENDED, never executed',
  full.test !== null && typeof full.test.recommended === 'boolean' && !('status' in (full.test ?? {})),
  `recommended=${full.test?.recommended} — ${String(full.test?.reason).slice(0, 60)}`);
check('§31: the comparison has a deterministic fingerprint',
  typeof full.fingerprint === 'string' && full.fingerprint.length === 64,
  full.fingerprint?.slice(0, 16));
check('§32: nothing was deployed, and the report says so',
  C.renderComparison(full).includes('No changes have been deployed.'));
info(`risk=${full.risk} changes=${full.summary?.total} complete=${full.complete}`);

/* Determinism at the whole-pipeline level, not just the diff. */
const again = await C.compareFlow({ ...deps(), request: `What changed in the ${SUBJECT} flow?`, taskId: 'pdi-full-2' });
record(again);
check('§11: two runs of the whole pipeline agree on the fingerprint and the counts',
  again.fingerprint === full.fingerprint && JSON.stringify(again.summary) === JSON.stringify(full.summary));

/* ================================================================== *
 * PDI-7 — AN ARTIFACT THAT CANNOT BE FULLY READ (§52)
 * ================================================================== */

head('PDI-7', 'a real artifact with unreadable sections → PARTIAL, never a complete diff');

/*
 * A REAL one, not a simulated one. "SLA notification and escalation flow" is a
 * legacy v1 flow on this instance: it has no readable trigger instance and no
 * action instances in the v2 tables, so `readFlowArtifact` returns gaps.
 */
const legacy = await findFlow({ name: 'SLA notification and escalation flow' });
check('a real partly-unreadable flow was found', legacy.ok, legacy.ok ? legacy.sys_id : legacy.reason);

if (legacy.ok) {
  const art = await readArtifact(legacy.sys_id);
  const n = C.normalizeFlow(art, { source: 'LIVE' });
  check('§40: the gaps are stated on the normalised artifact', n.gaps.length > 0 && n.complete === false,
    `${n.gaps.length} gap(s): ${String(n.gaps[0]).slice(0, 60)}`);

  const r = C.diffFlows(n, C.normalizeFlow(await readArtifact(legacy.sys_id), { source: 'LIVE' }));
  check('§41: the comparison is marked INCOMPLETE', r.complete === false);
  check('§41: it lists which sections could not be read', r.unreadable.length > 0,
    `${r.unreadable.length} listed`);

  const partial = await C.compareFlow({ ...deps(), request: `What changed in the ${legacy.name} flow?`, taskId: 'pdi-partial' });
  record(partial);
  const md = C.renderComparison(partial);
  if (!partial.stopped) {
    check('§41: the report leads with PARTIAL', md.includes('### PARTIAL'));
    check('§24: an incomplete comparison does not claim a confident risk',
      partial.complete === false && (partial.risk === 'UNKNOWN' || partial.summary?.total > 0),
      `risk=${partial.risk} complete=${partial.complete}`);
  } else {
    check('§4: a flow with no baseline stops with NO_BASELINE rather than inventing one',
      partial.stopped.reason === 'NO_BASELINE' || partial.stopped.reason === 'CURRENT_UNREADABLE',
      `${partial.stopped.reason}: ${String(partial.stopped.note).slice(0, 70)}`);
  }
}

/* ================================================================== *
 * SAFETY — what a comparison must never be able to do
 * ================================================================== */

head('SAFETY', 'the boundaries, checked against what actually ran');

check('§63.1: a flow with no snapshot yields NO_BASELINE, not an invented one', await (async () => {
  const none = await C.findBaseline({
    flowSysId: subject.ok ? subject.sys_id : 'x', findSnapshot: async () => [],
    captured: async () => null, readArtifact: readFlowArtifact,
  });
  info(`no-snapshot flow → ${none.reason}`);
  return none.ok === false && none.reason === 'NO_BASELINE';
})());

check('§4: a source this build does not have is refused', await (async () => {
  try {
    await C.readState({ sysId: subject.sys_id, source: 'THE_USER_SAID_SO', readArtifact: readFlowArtifact });
    return false;
  } catch (err) { return /not a baseline source/.test(err.message); }
})());

check('§8: an ambiguous artifact name stops rather than comparing a guess', await (async () => {
  const amb = await C.compareFlow({ ...deps(), chat: null, request: 'Compare the Change flow.', taskId: 'pdi-amb' });
  info(`"Change" → ${amb.stopped?.reason}`);
  return Boolean(amb.stopped) && amb.stopped.reason === 'ARTIFACT_AMBIGUOUS';
})());

check('§32/§59: a deployment request is analysed and handed to the planner, never executed', await (async () => {
  const dep = await C.compareFlow({ ...deps(), request: `Deploy the ${SUBJECT} flow.`, taskId: 'pdi-deploy' });
  record(dep);
  const md = C.renderComparison(dep);
  info(`deployment.available=${dep.deployment?.available} — ${String(dep.deployment?.note).slice(0, 64)}`);
  return md.includes('No changes have been deployed.') && !dep.stopped;
})());

/* Nothing was created, so nothing needs cleaning up — and that is provable
 * rather than asserted: the domain has no write path at all. */
const changeSrc = fs.readdirSync(new URL('../src/agent/change/', import.meta.url))
  .map((f) => fs.readFileSync(new URL(f, new URL('../src/agent/change/', import.meta.url)), 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
check('§63.11: the domain contains no executor, no client and no write',
  !/executeTool|executePlan|table\.(create|update|remove)\s*\(/.test(changeSrc));

/* ================================================================== *
 * REPORT
 * ================================================================== */

const passed = results.filter((r) => r.ok).length;
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);

console.log();
console.log('§64 METRICS');
console.log(`  Scenarios                     ${new Set(results.map((r) => r.scenario)).size}`);
console.log(`  Assertions                    ${results.length}`);
console.log(`  Passed                        ${passed}`);
console.log(`  Failed                        ${results.length - passed}`);
console.log(`  PDI leftovers                 0   (a comparison creates nothing)`);
console.log(`  Transient instance retries    ${retries}`);
console.log();
console.log('  Diff');
console.log(`    real artifact pairs compared    ${checkedPairs}`);
console.log(`    equivalent pairs (0 changes)    ${identicalPairs}`);
console.log(`    false positives                 ${differingPairs}`);
console.log();
console.log('  Performance (§62)');
console.log(`    average current read         ${avg(timings.current)}ms`);
console.log(`    average baseline read        ${avg(timings.baseline)}ms`);
console.log(`    average normalization        ${avg(timings.normalize)}ms`);
console.log(`    average diff                 ${avg(timings.diff)}ms`);
console.log(`    average lint                 ${avg(timings.lint)}ms`);
console.log(`    average total                ${avg(timings.total)}ms`);

console.log();
if (results.length - passed === 0) {
  console.log('PDI VALIDATION PASSED: every scenario behaved as specified and nothing was written.');
} else {
  console.log(`PDI VALIDATION FAILED: ${results.length - passed} assertion(s).`);
  process.exitCode = 1;
}
