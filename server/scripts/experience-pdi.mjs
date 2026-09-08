/**
 * NOWFORGE EXPERIENCE — REAL PDI VALIDATION.
 *
 *   node scripts/experience-pdi.mjs
 *
 * §63 asks the primary validation to verify one chain end to end:
 *
 *   real task -> real plan -> real tool event -> real approval
 *             -> real mutation -> real verification -> UI/backend consistency
 *
 * ═══ WHAT "UI/BACKEND EVENT CONSISTENCY" MEANS HERE ═══
 *
 * The Experience layer's whole claim is that the workspace shows what the
 * backend actually did. So the last link is checked in both directions, and
 * both directions matter:
 *
 *   NOTHING INVENTED  every activity row traces to a durable row — a task, a
 *                     step, or a `tool_events` entry. A row with no source is
 *                     §79.1/§79.2, fabricated execution or completion.
 *
 *   NOTHING LOST      every tool this task ran appears in the timeline. A
 *                     projection that quietly dropped work would be honest
 *                     about what it showed and useless as an account of the run.
 *
 * ═══ EVERY ARTIFACT IS OWNED, MARKED AND REMOVED ═══
 *
 * The one record this creates carries the marker `pdi-cleanup.mjs` sweeps, its
 * sys_id is recorded at creation, and cleanup deletes BY SYS_ID — never by the
 * marker, because deleting everything matching a pattern is how a test removes
 * somebody else's record.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xpdi-')), 'x.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const A = await import('../src/agent/activity/index.js');
const S = await import('../src/agent/skills/index.js');
const { table } = await import('../src/servicenow/client.js');
const { getSettings } = await import('../src/config/store.js');
const { TOOLS, toolMap } = await import('../src/agent/tools.js');
const {
  generatePlan, savePlan, loadPlan, setPlanState, buildReview, executePlan, approvePlan,
} = await import('../src/agent/plan/index.js');
const { createTask, startTask, completeTask, createStep, startStep, completeStep, stepsForTask } =
  await import('../src/memory/tasks.js');
const { createSession, recordToolEvent } = await import('../src/memory/sessions.js');
const { beginTurn } = await import('../src/agent/task-tracker.js');
const { getDb } = await import('../src/memory/db.js');

const RUN = Date.now().toString(36).slice(-6);
/* The prefix `pdi-cleanup.mjs` sweeps, so a crashed run is still recoverable. */
const MARKER = `NOWFORGE experience ${RUN}`;

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log(`run      : ${RUN}`);
console.log();

/* ------------------------------------------------------------------ *
 * Bookkeeping
 * ------------------------------------------------------------------ */

const results = [];
let scenario = '';
const check = (label, ok, detail = '') => {
  results.push({ scenario, label, ok });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};
const info = (line) => console.log(`         ${line}`);
const head = (name, title) => { scenario = name; console.log(`\n## ${name} — ${title}`); };

/** Everything this run created, so cleanup deletes exactly that. */
const owned = [];
/*
 * A sys_id arrives as a string OR as ServiceNow's `{ value, display }` pair,
 * depending on which layer produced the result. Normalising here rather than at
 * the call site is not tidiness: an unnormalised object reached `owned`, the
 * cleanup loop threw on `.slice`, and a real incident was left on the instance
 * because the script died between the mutation and its own cleanup.
 */
const idOf = (v) => {
  if (typeof v === 'string' && v) return v;
  if (v && typeof v.value === 'string' && v.value) return v.value;
  return null;
};
const claim = (t, sysId, what) => {
  const id = idOf(sysId);
  if (id) owned.push({ table: t, sys_id: id, what });
  else if (sysId) console.log(`  [WARN] ${what} returned an unrecognised sys_id shape — it cannot be cleaned up: ${JSON.stringify(sysId).slice(0, 120)}`);
};

const timings = {};
const timed = async (key, fn) => {
  const t0 = Date.now();
  const out = await fn();
  timings[key] = Date.now() - t0;
  return out;
};

/* ================================================================== *
 * PDI-0 — the instance, and the workspace's own preconditions
 * ================================================================== */

head('PDI-0', 'the bound instance and the skill registry (§61, §63)');

const me = await table.query('sys_user', { query: 'user_nameISNOTEMPTY', fields: 'sys_id,user_name', limit: 1, display: 'false' })
  .catch(() => []);
check('the instance answers a real read', me.length === 1, me[0]?.user_name ?? 'no rows');

const skills = S.listSkills({ tools: TOOLS });
check('§39: the seven built-in skills resolve against the LIVE tool registry',
  skills.length === 7 && skills.every((s) => s.state === 'enabled'),
  skills.map((s) => `${s.id}(${s.permissions.can_read.length}r/${s.permissions.can_change.length}w)`).join(' '));
check('§79.13: every built-in\'s declared change permission matches what it grants',
  skills.every((s) => (s.manifest.permissions.change.length > 0) === (s.permissions.can_change.length > 0)));

const surface = S.toolsForSkills(TOOLS, skills);
check('§41: with nothing disabled the planner\'s tool surface is UNCHANGED',
  surface.restricted === false && surface.tools.length === TOOLS.length,
  `${surface.tools.length}/${TOOLS.length}`);

/* ================================================================== *
 * PDI-1 — a real turn, a real tool event, a real timeline
 * ================================================================== */

head('PDI-1', 'a real task with a real read, projected (§63)');

const session = createSession({ id: `xp-${RUN}` });

/*
 * The task is opened through `beginTurn` — the SAME entry point the chat route
 * uses — so the skill snapshot, the step and the lifecycle are the real ones
 * rather than rows this script assembled to look like them.
 */
const tracker = beginTurn({
  sessionId: session.id,
  goal: 'read one incident',
  skills: S.skillSnapshot(skills),
});
check('§44: the task recorded the skill set it opened under',
  (A.activityForTask(tracker.taskId)?.skills ?? []).length === 7,
  `${A.activityForTask(tracker.taskId)?.skills?.length ?? 0} skill(s)`);

/* A REAL read against the PDI, recorded exactly as the orchestrator records one. */
const incidents = await timed('read', () => table.query('incident', {
  query: 'active=true', fields: 'sys_id,number,short_description', limit: 3, display: 'false',
}).catch(() => []));
recordToolEvent(session.id, {
  kind: 'tool_call',
  name: 'query_records',
  payload: { table: 'incident', query: 'active=true' },
  result: JSON.stringify({ rows: incidents.length }),
  resultStatus: 'ok',
  mutating: false,
  taskId: tracker.taskId,
});
info(`read ${incidents.length} incident(s)`);

tracker.observe({ type: 'done' });

const turn = A.activityForTask(tracker.taskId);
check('the task projected at all', Boolean(turn));
check('§8: the tool this task really ran is in its timeline',
  turn.events.some((e) => e.title === 'query_records' && e.type === 'tool'));
check('§8: the row is EXACT — matched by task id, not by a time window',
  turn.events.find((e) => e.title === 'query_records')?.metadata?.exact === true);
check('§12: the derived status is the real terminal state',
  turn.status === 'COMPLETED', turn.status);
check('§27: no verification event exists, because nothing verified anything',
  turn.events.filter((e) => e.type === 'verification').length === 0);

/* ================================================================== *
 * PDI-2 — a real plan, a real approval, a real mutation, a real read-back
 * ================================================================== */

/*
 * ═══ EVERYTHING BELOW RUNS INSIDE A TRY WHOSE CLEANUP IS UNCONDITIONAL ═══
 *
 * Learned the hard way on this script's first real run: the mutation landed,
 * the bookkeeping threw on the next line, and the process exited with a real
 * incident on the instance. Cleanup written at the bottom of a linear script is
 * cleanup that runs only when nothing goes wrong — which is the case that does
 * not need it.
 */
let threw = null;
try {

head('PDI-2', 'plan -> approval -> mutation -> verification, all real (§63)');

const DESC = `${MARKER} — created by experience-pdi`;
const planTask = createTask({ sessionId: session.id, goal: `${MARKER} lifecycle` });
startTask(planTask.id);

const proposal = {
  goal: `${MARKER} lifecycle`,
  steps: [
    {
      id: 'step_1',
      operation: 'create the validation incident',
      capability: 'record_create',
      tool: 'create_record',
      mechanism: 'rest',
      scope: null,
      mutating: true,
      target: { table: 'incident' },
      inputs: { table: 'incident', data: { short_description: DESC, description: 'Disposable. Deleted by this script.' } },
      depends_on: [],
      expected_effects: [`an incident exists whose short_description is "${DESC}"`],
      verification: { strategy: 'read_back', asserts: [`short_description == ${DESC}`] },
    },
  ],
};

const generated = await timed('plan', () => generatePlan({
  taskId: planTask.id,
  sessionId: session.id,
  goal: proposal.goal,
  registry: toolMap,
  propose: async () => proposal,
}));
check('§63: a real plan was generated and validated',
  generated.ok === true, generated.ok ? `${generated.plan.steps.length} step(s)` : generated.reason);

let fingerprint = null;
if (generated.ok) {
  const saved = savePlan(planTask.id, generated.plan, { discovered: generated.discovered });
  fingerprint = saved.fingerprint ?? null;
  check('§63: the plan is durable and fingerprinted', Boolean(fingerprint), fingerprint?.slice(0, 12));
  /*
   * `planning -> ready -> awaiting_approval`, and the intermediate step is not
   * ceremony. `awaiting_approval -> executing` is the ONLY edge into EXECUTING
   * in the plan state machine, and `planning -> awaiting_approval` is not an
   * edge at all — so a plan that skipped `ready` could never be approved, and
   * its first step would be refused `not_approved` by the executor. Which is
   * exactly what happened when this script tried.
   */
  setPlanState(planTask.id, 'ready');
  setPlanState(planTask.id, 'awaiting_approval');

  /*
   * THE REAL APPROVAL. `approvePlan` binds the decision to the plan's
   * fingerprint — an approval is not a boolean — so this exercises the same
   * gate a person's click does. Only the ANSWER is supplied by policy, and it
   * is recorded as `auto_approve`: nobody saw this card, and the audit trail
   * says so rather than claiming a human decided.
   */
  const bound = approvePlan(planTask.id, fingerprint, { source: 'auto_approve' });
  check('§22/§79.6: the approval BOUND to the plan fingerprint', bound.ok === true, bound.reason ?? 'bound');

  const run = await timed('execute', () => executePlan({
    taskId: planTask.id,
    sessionId: session.id,
    registry: toolMap,
    autoApprove: true,
    emit: () => {},
  }));
  info(`plan run: ${run?.state ?? 'unknown'}`);

  const steps = stepsForTask(planTask.id).filter((s) => s.plan_step_id);
  for (const st of steps) info(`  ${st.plan_step_id} -> ${st.state}`);

  /* Own whatever landed, whether or not the step reported success. */
  for (const st of steps) {
    let result = null;
    try { result = JSON.parse(st.result_json ?? 'null'); } catch { result = null; }
    const sysId = result?.sys_id ?? result?.record?.sys_id ?? null;
    claim('incident', sysId, st.plan_step_id);
  }
  info(`owned: ${owned.map((o) => `${o.table}/${o.sys_id.slice(0, 8)}`).join(', ') || 'nothing'}`);

  check('§63: a real mutation landed on the instance', owned.length === 1, `${owned.length} record(s)`);

  const done = steps.filter((s) => s.state === 'completed').length;
  check('§63: the step reached a terminal state', steps.every((s) => ['completed', 'failed', 'skipped'].includes(s.state)),
    `${done}/${steps.length} completed`);

  /* §63 — real verification: the executor's own read-back verdict. */
  const verdicts = steps.map((s) => {
    try { return JSON.parse(s.verification_json ?? 'null'); } catch { return null; }
  }).filter(Boolean);
  check('§63: a verification verdict was RECORDED by the pipeline', verdicts.length > 0,
    verdicts.map((v) => v.status ?? v.verdict).join(', ') || 'none');

  completeTask(planTask.id);
}

/* ================================================================== *
 * PDI-3 — UI/backend event consistency, both directions
 * ================================================================== */

head('PDI-3', 'every row has a source, and every source has a row (§8, §63)');

const proj = await timed('project', async () => A.activityForTask(planTask.id));
check('the plan task projected', Boolean(proj), `${proj?.events?.length ?? 0} event(s)`);

if (proj) {
  const db = getDb();
  const stepIds = new Set(stepsForTask(planTask.id).map((s) => s.plan_step_id ?? s.id));
  const toolSeqs = new Set(
    db.prepare('SELECT seq FROM tool_events WHERE task_id = ?').all(planTask.id).map((r) => String(r.seq)),
  );

  /* NOTHING INVENTED — every row traces to a durable row. */
  const orphans = [];
  for (const e of proj.events) {
    const [kind, , key] = e.id.split(':');
    if (kind === 'task') continue;                                  // the task row itself
    if (kind === 'tool') { if (!toolSeqs.has(key)) orphans.push(e.id); continue; }
    if (!stepIds.has(key)) orphans.push(e.id);
  }
  check('§79.1/§79.2: no activity row was invented', orphans.length === 0, orphans.join(', ') || 'all rows trace to a durable row');

  /* NOTHING LOST — every tool event this task recorded is in the timeline. */
  const shown = new Set(proj.events.filter((e) => e.type === 'tool').map((e) => e.id.split(':')[2]));
  const missing = [...toolSeqs].filter((s) => !shown.has(s));
  check('§8: no tool event was dropped from the timeline', missing.length === 0, missing.join(', ') || `${toolSeqs.size} shown`);

  /* And the status matches the real task row, not a guess. */
  const row = db.prepare('SELECT state, plan_state FROM agent_tasks WHERE id = ?').get(planTask.id);
  check('§12: the derived status agrees with the durable task row',
    (row.state === 'completed') === (proj.status === 'COMPLETED'),
    `state=${row.state} plan_state=${row.plan_state} status=${proj.status}`);
}

/* ================================================================== *
 * PDI-4 — reconnect and refresh
 * ================================================================== */

head('PDI-4', 'reconnect and refresh produce the same timeline (§10, §11, §58)');

const first = A.activityForTask(planTask.id);
const second = A.activityForTask(planTask.id);
check('§58: two reads produce identical timelines',
  JSON.stringify(first.events.map((e) => e.id)) === JSON.stringify(second.events.map((e) => e.id)),
  `${first.events.length} event(s)`);
check('§11: merging two full reads still yields one timeline',
  A.dedupe([...first.events, ...second.events]).length === first.events.length);

const tail = A.activityForTask(planTask.id, { since: Math.floor(first.cursor / 2) });
check('§10: `since` returns only what came after the cursor',
  tail.events.length > 0 && tail.events.length < first.events.length
    && tail.events.every((e) => e.seq > Math.floor(first.cursor / 2)),
  `${tail.events.length} of ${first.events.length}`);
check('§10: asking from the end returns nothing, and that is not an error',
  A.activityForTask(planTask.id, { since: first.cursor }).events.length === 0);

/* §51 — and the history lists both tasks for this chat. */
const history = A.taskHistory(session.id);
check('§51: history lists this session\'s tasks, newest first',
  history.length === 2 && history[0].task_id === planTask.id,
  history.map((h) => `${h.status}`).join(', '));

/* ================================================================== *
 * PDI-5 — secrets
 * ================================================================== */

head('PDI-5', 'no credential reaches the workspace (§59, §79.18)');

const { connection } = getSettings();
const blob = JSON.stringify([A.activityForTask(planTask.id), A.activityForTask(tracker.taskId), A.taskHistory(session.id)]);
check('§59: the bound password does not appear anywhere in the projection',
  !connection.password || !blob.includes(connection.password));
check('§59: no Authorization header, cookie or token appears',
  !/authorization|set-cookie|bearer /i.test(blob));

/* And a deliberately planted secret is redacted rather than dropped. */
recordToolEvent(session.id, {
  kind: 'tool_call',
  name: 'create_record',
  payload: { table: 'sys_user', fields: { user_name: 'x', user_password: `secret-${RUN}` } },
  resultStatus: 'ok',
  mutating: true,
  taskId: planTask.id,
});
const withSecret = JSON.stringify(A.activityForTask(planTask.id));
check('§59: a planted credential is redacted at the boundary',
  !withSecret.includes(`secret-${RUN}`) && /redacted/.test(withSecret));

/* ================================================================== *
 * PDI-6 — a disabled skill really is unavailable
 * ================================================================== */

head('PDI-6', 'a disabled skill is removed from the planner\'s surface (§41, §79.8)');

const off = skills.map((s) => (s.id === 'incident-operations' ? { ...s, enabled: false } : s));
const narrowed = S.toolsForSkills(TOOLS, off);
const kept = new Set(narrowed.tools.map((t) => t.name));
check('§41: a tool the disabled skill EXCLUSIVELY granted is gone',
  !kept.has('create_incident'), `${narrowed.tools.length}/${TOOLS.length} tools, removed ${narrowed.removed.join(', ')}`);
check('§41: a tool it SHARED with an enabled skill survives', kept.has('get_record_audit'));
check('§41: core survives', kept.has('get_table_schema') && kept.has('lookup_reference'));
check('§40: a capability no skill claims is untouched', kept.has('create_sla'));

} catch (err) {
  threw = err;
  console.log(`
  [FAIL] the run threw before finishing: ${err.message}`);
}

/* ================================================================== *
 * Cleanup — §60: zero leftovers, whatever happened above
 * ================================================================== */

head('CLEANUP', 'every record this run created is removed, by sys_id');
if (threw) check('the run completed without throwing', false, threw.message);

let deleted = 0;
let failed = 0;
for (const o of owned) {
  try {
    await table.remove(o.table, o.sys_id);
    deleted += 1;
    info(`deleted ${o.table}/${o.sys_id} (${o.what})`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] could not delete ${o.table}/${o.sys_id} — ${err.message}`);
  }
}
check('every owned record was deleted', failed === 0, `${deleted} deleted, ${failed} failed`);

/* Independently verified: ask the instance, do not trust the delete's return. */
const leftovers = await table.query('incident', {
  query: `short_descriptionSTARTSWITH${MARKER}`, fields: 'sys_id,number', limit: 50, display: 'false',
}).catch(() => []);
check('§60: zero leftovers on the instance', leftovers.length === 0,
  leftovers.length ? leftovers.map((r) => r.number).join(', ') : 'verified by re-reading the instance');

/* ================================================================== *
 * Report
 * ================================================================== */

const passed = results.filter((r) => r.ok).length;
const scenarios = new Set(results.map((r) => r.scenario)).size;

console.log('\n────────────────────────────────────────────────────────');
console.log(`scenarios : ${scenarios}`);
console.log(`assertions: ${results.length}`);
console.log(`passed    : ${passed}`);
console.log(`failed    : ${results.length - passed}`);
console.log(`leftovers : ${leftovers.length}`);
console.log(`timings   : ${Object.entries(timings).map(([k, v]) => `${k} ${v}ms`).join(', ')}`);

if (passed !== results.length) {
  console.log('\nFAILED:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.scenario}: ${r.label}`);
  process.exit(1);
}
console.log('\nPDI VALIDATION PASSED: the workspace shows what the backend did, nothing more, and the instance is as it was found.');
