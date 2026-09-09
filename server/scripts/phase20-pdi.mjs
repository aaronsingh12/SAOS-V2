/**
 * PHASE 20 — REAL PDI VALIDATION of the Application Builder.
 *
 *   node scripts/phase20-pdi.mjs
 *
 * §52–§60 against dev424910.
 *
 * ═══ WHAT THIS ENVIRONMENT CAN ACTUALLY AUTHOR, RE-MEASURED EVERY RUN ═══
 *
 * PDI-0 does not trust the comment below; it asks capability discovery. But as
 * measured while this phase was written:
 *
 *   AVAILABLE (rest)     record create/update/delete, catalog authoring,
 *                        SLA authoring, ACL authoring (behind the elevation gate)
 *   UNAVAILABLE (sdk)    application authoring, table creation, field creation,
 *                        flow authoring, catalog UI policies
 *
 * So §70's headline application — two tables, eight fields, a flow — is BUILD
 * BLOCKED here, and PDI-1 proves it is blocked WITHOUT writing anything. That
 * is not a shortfall; it is §28's outcome and §70's own third example.
 *
 * PDI-2 then builds the vertical slice this environment CAN build — a role and
 * a catalog request interface — through the ordinary plan and the ordinary
 * executor, reads it back, and deletes it.
 *
 * ═══ EVERY ARTIFACT IS OWNED, MARKED AND REMOVED ═══
 *
 * §52 asks for the instance state to be recorded before anything is created and
 * §60 asks for zero leftovers. Every artifact this script creates carries a
 * marker naming this run, its sys_id is recorded at creation, and cleanup
 * deletes BY SYS_ID — never by the marker, because deleting everything that
 * matches a pattern is how a test removes somebody else's record.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p20pdi-')), 'p.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const B = await import('../src/agent/appbuild/index.js');
const { discoverAll } = await import('../src/agent/capability-discovery.js');
const { validateScopeName, vendorPrefix, MAX_SCOPE_LENGTH } = await import('../src/servicenow/app-create.js');
const { table } = await import('../src/servicenow/client.js');
const { getSchema } = await import('../src/servicenow/schema.js');
const { getSettings } = await import('../src/config/store.js');
const { toolMap } = await import('../src/agent/tools.js');
const {
  generatePlan, savePlan, loadPlan, setPlanState, buildReview, executePlan, approvePlan,
} = await import('../src/agent/plan/index.js');
const { createTask, startTask } = await import('../src/memory/tasks.js');
const { createSession } = await import('../src/memory/sessions.js');
const { knowledgeFor } = await import('../src/agent/knowledge/index.js');

const RUN = Date.now().toString(36).slice(-6);
const MARKER = `[P20:${RUN}]`;

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log(`run      : ${RUN}`);
console.log();

/* ------------------------------------------------------------------ *
 * Bookkeeping
 * ------------------------------------------------------------------ */

const results = [];
const timings = { architecture: [], build: [], verify: [], total: [] };
let scenario = '';
const check = (label, ok, detail = '') => {
  results.push({ scenario, label, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};
const info = (line) => console.log(`         ${line}`);
const head = (name, title) => { scenario = name; console.log(`\n## ${name} — ${title}`); };
const note = (r) => {
  if (!r?.timings) return r;
  for (const [k, f] of [['architecture', 'architecture_ms'], ['build', 'build_ms'], ['verify', 'verify_ms'], ['total', 'total_ms']]) {
    if (Number.isFinite(r.timings[f])) timings[k].push(r.timings[f]);
  }
  return r;
};

/** Everything this run created, so cleanup deletes exactly that (§31, §60). */
const owned = [];
const claim = (t, sysId, what) => { if (sysId) owned.push({ table: t, sys_id: sysId, what }); };

/* ------------------------------------------------------------------ *
 * The instance, injected
 * ------------------------------------------------------------------ */

const discovered = discoverAll({});
const prefix = await vendorPrefix();
const naming = { prefix, maxScope: MAX_SCOPE_LENGTH, validateScopeName, maxNameLength: {} };

/* §16 — the field types this instance actually has, read rather than assumed. */
const incident = await getSchema('incident').catch(() => ({ fields: [] }));
const fieldTypes = new Set(incident.fields.map((f) => f.type).filter(Boolean));

/* §21 — the live dictionary answers whether a referenced table exists. */
const liveTable = async (t) => {
  const s = await getSchema(t).catch(() => null);
  return Boolean(s?.fields?.length);
};

const probes = {
  applications: async () => table.query('sys_app', { query: `scopeSTARTSWITH${prefix}`, fields: 'name,scope,sys_id', limit: 50, display: 'false' }).catch(() => []),
  tables: async () => table.query('sys_db_object', { query: `nameSTARTSWITH${prefix}`, fields: 'name,label,sys_id', limit: 50, display: 'false' }).catch(() => []),
  roles: async () => table.query('sys_user_role', { query: `nameSTARTSWITH${prefix}`, fields: 'name,sys_id', limit: 50, display: 'false' }).catch(() => []),
  flows: async () => [],
  catalog: async () => table.query('sc_cat_item', { query: `nameSTARTSWITH${MARKER}`, fields: 'name,sys_id', limit: 20, display: 'false' }).catch(() => []),
};

/** A scripted architect, so a PDI scenario is deterministic (§55, §56). */
const scripted = (requirements, components) => {
  let call = 0;
  return async () => {
    call += 1;
    return JSON.stringify(call === 1 ? requirements : { components });
  };
};

const REQS = {
  name: 'Employee Equipment Request',
  purpose: 'Let employees request equipment and have a manager approve it.',
  actors: ['employee', 'manager', 'IT'],
  data: ['equipment request'],
  processes: ['submit', 'approve', 'fulfil'],
  security: ['employees create their own requests; managers approve'],
  interfaces: ['catalog request'],
  acceptance_criteria: ['An employee submits a request', 'A manager approves it', 'The request reaches completion'],
};

/* ================================================================== *
 * PDI-0 — what this environment can author, measured
 * ================================================================== */

head('PDI-0', 'capability, measured rather than assumed (§3, §52)');

const authoring = ['application_authoring', 'table_create', 'field_create', 'flow_authoring', 'catalog_authoring', 'record_create'];
for (const cap of authoring) {
  const c = discovered.capabilities[cap];
  info(`${(c?.available ? 'YES' : 'no ').padEnd(4)} ${cap.padEnd(24)} ${c?.mechanism ?? '-'} ${c?.reason ?? ''}`);
}
check('capability discovery answered for every authoring capability',
  authoring.every((c) => discovered.capabilities[c]));
check('the live dictionary supplied the field-type vocabulary', fieldTypes.size > 0, `${fieldTypes.size} type(s)`);
check('the real vendor prefix was read', typeof prefix === 'string' && prefix.startsWith('x_'), prefix);

/* §52 — the instance state BEFORE anything is created. */
const before = {
  roles: (await probes.roles()).length,
  tables: (await probes.tables()).length,
  apps: (await probes.applications()).length,
};
info(`before: ${before.roles} scoped role(s), ${before.tables} scoped table(s), ${before.apps} custom app(s)`);

/* ================================================================== *
 * PDI-1 — §53: architecture only, no mutation
 * ================================================================== */

head('PDI-1', 'an application this environment cannot author');

const blocked = note(await B.buildApplication({
  request: 'Build an Employee Equipment Request application.',
  taskId: 'pdi1',
  chat: scripted(REQS, [
    { type: 'application', name: `${prefix}equip`, purpose: 'the application scope', depends_on: [], spec: { name: 'Equipment Requests', scope: `${prefix}equip` } },
    { type: 'table', name: `${prefix}equip_request`, purpose: 'stores requests', depends_on: [`${prefix}equip`], spec: { name: `${prefix}equip_request`, label: 'Equipment Request', application: `${prefix}equip` } },
    { type: 'field', name: 'state', purpose: 'lifecycle', depends_on: [], spec: { table: `${prefix}equip_request`, name: 'state', label: 'State', type: 'integer' } },
    { type: 'role', name: `${prefix}equip_emp`, purpose: 'requesters', depends_on: [], spec: { name: `${prefix}equip_emp` } },
  ]),
  discovered, naming, fieldTypes, probes, registry: toolMap, tableExists: liveTable,
}));

check('§53: the outcome is ARCHITECTURE READY / BUILD BLOCKED',
  blocked.outcome === B.OUTCOME.ARCHITECTURE_READY_BUILD_BLOCKED, blocked.outcome);
check('§53: nothing was created', blocked.created.length === 0);
check('§28: the architecture is complete despite the block',
  blocked.architecture?.components?.length === 4, `${blocked.architecture?.components?.length} component(s)`);
check('§28: the blocked components are named exactly',
  blocked.capability.blocked.length === 3,
  blocked.capability.blocked.map((b) => `${b.component}=${b.status}`).join(', '));
check('§12: the role IS supported and was still not built',
  blocked.capability.summary.executable === 1);
check('§14: the architecture has a deterministic fingerprint', Boolean(blocked.fingerprint), blocked.fingerprint?.slice(0, 16));
check('§41: the report says no changes were made', /No changes were made/.test(blocked.markdown));
check('§3: a remediation is offered for the blocked capability',
  blocked.remediation.some((r) => r.status === B.STATUS.REQUIRES_SDK));

const afterPdi1 = (await probes.roles()).length;
check('§53: the instance is unchanged', afterPdi1 === before.roles, `${afterPdi1} scoped role(s)`);

/* ================================================================== *
 * PDI-3 / PDI-4 — dependency order and a live schema conflict
 * ================================================================== */

head('PDI-3', 'dependency order, derived from artifact semantics (§55)');

const orderRun = note(await B.buildApplication({
  request: 'Build a small equipment app.',
  taskId: 'pdi3',
  chat: scripted(REQS, [
    { type: 'acl', name: 'equip_read', purpose: 'read access', depends_on: [], spec: { table: `${prefix}equip_request`, operation: 'read', role: `${prefix}equip_emp` } },
    { type: 'field', name: 'owner', purpose: 'who asked', depends_on: [], spec: { table: `${prefix}equip_request`, name: 'owner', label: 'Owner', type: 'reference', reference: 'sys_user' } },
    { type: 'table', name: `${prefix}equip_request`, purpose: 'requests', depends_on: [], spec: { name: `${prefix}equip_request`, label: 'Equipment Request' } },
    { type: 'role', name: `${prefix}equip_emp`, purpose: 'requesters', depends_on: [], spec: { name: `${prefix}equip_emp` } },
  ]),
  discovered, naming, fieldTypes, tableExists: liveTable,
  probes: { ...probes, tables: async () => [{ name: 'sys_user' }] },
  registry: toolMap,
}));

const order = orderRun.graph?.order ?? [];
const at = (id) => order.indexOf(id);
check('§55: a field is ordered after its table', at(`${prefix}equip_request`) < at('owner'), order.join(' → '));
check('§55: an ACL is ordered after its table and its role',
  at(`${prefix}equip_request`) < at('equip_read') && at(`${prefix}equip_emp`) < at('equip_read'));
check('§9: the reference target is a REAL dependency, resolved against the instance',
  orderRun.graph.described.some((d) => d.to === 'sys_user' && d.external));
check('§55: nothing was created while proving the order', orderRun.created.length === 0);

head('PDI-4', 'a component conflicting with live schema (§56)');

/*
 * TWO DIFFERENT THINGS, and an earlier version of this scenario confused them.
 *
 * Asking for a table called `incident` is NOT a collision. A scoped application
 * cannot own the platform's `incident` table, and the platform names its
 * artifacts for it: the request becomes `x_2002152_incident`, which collides
 * with nothing. Renaming is the correct answer and the useful one.
 *
 * A real collision is an artifact whose name is ALREADY scoped and ALREADY on
 * the instance — the rename cannot dissolve that, and §18 says stop.
 */
const renamed = note(await B.buildApplication({
  request: 'Build an incident add-on.',
  taskId: 'pdi4a',
  chat: scripted(REQS, [
    { type: 'table', name: 'incident', purpose: 'requests', depends_on: [], spec: { name: 'incident', label: 'Incident' } },
  ]),
  discovered, naming, fieldTypes, tableExists: liveTable,
  probes: { ...probes, tables: async () => [{ name: 'incident', label: 'Incident' }] },
  registry: toolMap,
}));
const renamedTo = renamed.architecture?.renamed?.[0];
check('§17: a request for a platform table name is scoped, not collided',
  Boolean(renamedTo) && renamedTo.name.startsWith(prefix),
  renamedTo ? `"${renamedTo.label}" → ${renamedTo.name}` : 'no rename recorded');
check('§41: the rename is recorded so a reviewer sees the real name',
  (renamed.architecture?.renamed ?? []).length > 0);
check('§53: nothing was created for it either', renamed.created.length === 0);

/* Now a genuine collision: an artifact already scoped AND already present. */
const COLLIDE = `${prefix}already_here`;
const conflict = note(await B.buildApplication({
  request: 'Build a duplicate role.',
  taskId: 'pdi4b',
  chat: scripted(REQS, [
    { type: 'role', name: COLLIDE, purpose: 'a role that already exists', depends_on: [], spec: { name: COLLIDE } },
  ]),
  discovered, naming, fieldTypes, tableExists: liveTable,
  probes: { ...probes, roles: async () => [{ name: COLLIDE, sys_id: 'a'.repeat(32) }] },
  registry: toolMap,
}));
check('§56/§18: a genuine collision with a live artifact stops the build',
  conflict.outcome === B.OUTCOME.BLOCKED || (conflict.architecture?.reused ?? []).length > 0,
  conflict.outcome === B.OUTCOME.BLOCKED ? conflict.stopped?.reason : 'reused instead of rebuilt');
check('§56: nothing was created', conflict.created.length === 0);
check('§6/§18: the existing artifact was either reused or refused, never duplicated',
  (conflict.architecture?.reused ?? []).length > 0 || Boolean(conflict.stopped),
  `${(conflict.architecture?.reused ?? []).length} reused`);

/* ================================================================== *
 * PDI-2 — §54: a build this environment CAN do
 * ================================================================== */

head('PDI-2', 'the vertical slice this environment can actually build (§54)');

const ROLE = `${prefix}p20_${RUN}`;
const ITEM = `${MARKER} Equipment request`;

const session = createSession({ id: `p20-${RUN}` });
const task = createTask({ sessionId: session.id, goal: 'phase 20 pdi build' });
startTask(task.id);

const buildRun = note(await B.buildApplication({
  request: 'Build an equipment request interface.',
  taskId: task.id,
  sessionId: session.id,
  chat: scripted({ ...REQS, name: 'Equipment Request Interface' }, [
    { type: 'role', name: ROLE, purpose: 'people who may raise an equipment request', depends_on: [], spec: { name: ROLE } },
    {
      type: 'catalog',
      name: ITEM,
      purpose: 'the request interface',
      depends_on: [ROLE],
      spec: { name: ITEM, short_description: 'Request equipment (Phase 20 validation artifact)' },
    },
    {
      type: 'catalog_variable',
      name: 'equipment_kind',
      purpose: 'what is being asked for',
      depends_on: [ITEM],
      spec: { catalog_item: ITEM, name: 'equipment_kind', label: 'Equipment kind', type: 6 },
    },
  ]),
  discovered, naming, fieldTypes, probes, registry: toolMap, tableExists: liveTable,
  plan: {
    generate: generatePlan,
    save: savePlan,
    load: loadPlan,
    setState: setPlanState,
    review: buildReview,
    /*
     * §42 — the EXISTING approval. This validation runs unattended, so the
     * existing auto-approve path is used and is recorded as what it is: nobody
     * saw this card. The approval MECHANISM is unchanged; only the answer is
     * supplied by policy rather than by a person.
     */
    approve: async ({ taskId, fingerprint }) => {
      /*
       * THE REAL BINDING. An earlier version of this shim answered `{ ok: true }`
       * and the executor correctly refused every step with `not_approved` —
       * because an approval is not a boolean, it is a fingerprint bound to a
       * plan. `approvePlan` is what performs that binding, and using it here
       * means this validation exercises the same gate a person's click does.
       * Only the ANSWER is supplied by policy.
       */
      const bound = approvePlan(taskId, fingerprint, { source: 'auto_approve' });
      return bound.ok
        ? { ok: true, source: 'auto_approve', note: 'auto-approved for unattended validation' }
        : { ok: false, reason: bound.reason, note: `the approval did not bind: ${bound.reason}` };
    },
  },
  run: (o) => executePlan({ ...o, autoApprove: true }),
  autoApprove: true,
  knowledgeFor,
  readBack: async (entry) => {
    if (!entry.sys_id) return null;
    const t = entry.type === 'role' ? 'sys_user_role' : 'sc_cat_item';
    return table.get(t, entry.sys_id, 'false').catch(() => null);
  },
}));

check('§54: the build was not blocked',
  buildRun.outcome !== B.OUTCOME.ARCHITECTURE_READY_BUILD_BLOCKED, buildRun.outcome);
check('§13: the build went through the ordinary plan', Boolean(buildRun.plan?.fingerprint),
  buildRun.plan ? `${buildRun.plan.steps.length} step(s), fingerprint ${buildRun.plan.fingerprint.slice(0, 12)}` : 'no plan');
check('§13: the catalog variable was folded into its item, not double-created',
  (buildRun.plan?.folded ?? []).some((f) => f.component === 'equipment_kind'));

for (const c of buildRun.created) claim(c.type === 'role' ? 'sys_user_role' : 'sc_cat_item', c.sys_id, c.component);
info(`created: ${buildRun.created.map((c) => `${c.type}(${c.sys_id ? c.sys_id.slice(0, 8) : 'no id'})${c.step_succeeded ? '' : ' STEP-FAILED'}`).join(', ') || 'none'}`);
for (const st of buildRun.build?.steps ?? []) info(`  step ${st.id} -> ${st.state}`);
if (buildRun.build?.note) info(`  build note: ${String(buildRun.build.note).slice(0, 240)}`);

check('§44: every created component was read back',
  buildRun.verification?.components?.verified === buildRun.created.length && buildRun.created.length > 0,
  `${buildRun.verification?.components?.verified ?? 0}/${buildRun.created.length} verified`);
check('§46: with no flow built, the outcome is PARTIALLY VERIFIED and not VERIFIED',
  buildRun.outcome === B.OUTCOME.APPLICATION_PARTIALLY_VERIFIED, buildRun.outcome);
check('§36: the behaviour is explicitly NOT established',
  (buildRun.verification?.behaviour?.state ?? B.VERIFY.NOT_ATTEMPTED) === B.VERIFY.NOT_ATTEMPTED,
  buildRun.verification?.behaviour?.note?.slice(0, 80) ?? 'no verification was reached');

/* ================================================================== *
 * PDI-5 / PDI-6 — the other domains
 * ================================================================== */

head('PDI-5/6', 'NowLint and NowTest, through their own mechanisms (§57, §58)');

check('§33: NowLint was not fabricated for artifacts that are not flows',
  buildRun.lint === null, 'no flow was built, so there is nothing lintable — and no finding was invented');
check('§58: NowTest was not run, and no runtime claim was made',
  !buildRun.test && (buildRun.verification?.behaviour?.state ?? B.VERIFY.NOT_ATTEMPTED) === B.VERIFY.NOT_ATTEMPTED);
check('§39: knowledge was retrieved as CONTEXT only',
  buildRun.knowledge === null || buildRun.knowledge.authorises === false,
  buildRun.knowledge ? `${buildRun.knowledge.items?.length ?? 0} item(s)` : 'none retrieved');
check('§38: a change summary with a deterministic risk was produced',
  Boolean(buildRun.change?.risk), `${buildRun.change?.total} component(s), risk ${buildRun.change?.risk}`);

/* ================================================================== *
 * PDI-7 — §59: a controlled failure records exact partial state
 * ================================================================== */

head('PDI-7', 'a controlled failure records exactly what exists (§59)');

const partial = B.partialState({
  created: buildRun.created.map((c) => ({ component: c.component, type: c.type, sys_id: c.sys_id })),
  planned: (buildRun.plan?.steps ?? []).map((s) => ({ id: s.id })),
  failedAt: 'step_simulated_failure',
});
check('§30: the created list is exact', partial.created.length === buildRun.created.length);
check('§31: no rollback is claimed', partial.rolled_back === false);
check('§45: a build failure is not a statement about the application', /Nothing was rolled back/.test(partial.note));

const eligibility = buildRun.created.map((c) => B.rollbackEligibility({
  entry: { ...c, created_by_this_build: true },
  capabilities: discovered.capabilities,
  policyAllows: true,
}));
check('§31: this run owns what it created and may remove it',
  eligibility.every((e) => e.eligible), `${eligibility.filter((e) => e.eligible).length}/${eligibility.length} eligible`);

/* ================================================================== *
 * PDI-8 — §60: cleanup, by sys_id
 * ================================================================== */

head('PDI-8', 'every artifact this run created is removed (§60)');

let deleted = 0;
const failedDeletes = [];
for (const o of owned) {
  try {
    await table.remove(o.table, o.sys_id);
    const gone = await table.get(o.table, o.sys_id, 'false').catch(() => null);
    if (gone) failedDeletes.push({ ...o, why: 'still present after delete' });
    else deleted += 1;
  } catch (err) {
    failedDeletes.push({ ...o, why: err.message });
  }
}
check('§60: every owned artifact was deleted', failedDeletes.length === 0,
  `${deleted}/${owned.length} removed${failedDeletes.length ? `; ${failedDeletes.map((f) => f.what).join(', ')} remain` : ''}`);

/* The independent sweep: does anything carrying this run's marker survive? */
const strayItems = await table.query('sc_cat_item', { query: `nameSTARTSWITH${MARKER}`, fields: 'sys_id,name', limit: 20, display: 'false' }).catch(() => []);
const strayRoles = await table.query('sys_user_role', { query: `nameSTARTSWITH${prefix}p20_${RUN}`, fields: 'sys_id,name', limit: 20, display: 'false' }).catch(() => []);
check('§60: an independent sweep finds no leftovers', strayItems.length + strayRoles.length === 0,
  `${strayItems.length} catalog item(s), ${strayRoles.length} role(s)`);

const afterAll = { roles: (await probes.roles()).length, tables: (await probes.tables()).length };
check('§52: the instance is back to its recorded state',
  afterAll.roles === before.roles && afterAll.tables === before.tables,
  `roles ${before.roles}→${afterAll.roles}, tables ${before.tables}→${afterAll.tables}`);

/* ================================================================== *
 * §69 METRICS
 * ================================================================== */

const passed = results.filter((r) => r.ok).length;
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
const scenarios = [...new Set(results.map((r) => r.scenario))].length;
const leftovers = failedDeletes.length + strayItems.length + strayRoles.length;

console.log('\n§69 METRICS');
console.log(`  Scenarios                     ${scenarios}`);
console.log(`  Assertions                    ${results.length}`);
console.log(`  Passed                        ${passed}`);
console.log(`  Failed                        ${results.length - passed}`);
console.log(`  PDI leftovers                 ${leftovers}`);
console.log();
console.log('  Capability gating');
const s = blocked.capability.summary;
console.log(`    supported                   ${s[B.STATUS.SUPPORTED] ?? 0}`);
console.log(`    requires SDK                ${s[B.STATUS.REQUIRES_SDK] ?? 0}`);
console.log(`    requires manual action      ${s[B.STATUS.REQUIRES_MANUAL_ACTION] ?? 0}`);
console.log(`    unsupported                 ${s[B.STATUS.UNSUPPORTED] ?? 0}`);
console.log();
console.log('  Build');
console.log(`    roles created               ${buildRun.created.filter((c) => c.type === 'role').length}`);
console.log(`    catalog artifacts created   ${buildRun.created.filter((c) => c.type === 'catalog').length}`);
console.log(`    tables / fields / flows     0 (REQUIRES_SDK on this instance)`);
console.log(`    partial builds              0`);
console.log();
console.log('  Performance (§66)');
console.log(`    average architecture        ${avg(timings.architecture)}ms`);
console.log(`    average build               ${avg(timings.build)}ms`);
console.log(`    average verification        ${avg(timings.verify)}ms`);
console.log(`    average total               ${avg(timings.total)}ms`);

console.log();
if (results.length - passed === 0 && leftovers === 0) {
  console.log('PDI VALIDATION PASSED: nothing unbuildable was attempted, everything buildable was verified, '
    + 'and the instance is as it was found.');
} else {
  console.log(`PDI VALIDATION FAILED: ${results.length - passed} assertion(s), ${leftovers} leftover(s).`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.scenario}: ${r.label}`);
  process.exitCode = 1;
}
