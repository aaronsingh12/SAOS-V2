/**
 * NOWFORGE EXPERIENCE — THE THINGS THAT MUST BE IMPOSSIBLE.
 *
 *   node --test server/test/
 *
 * §79 lists twenty release blockers. Most of them reduce to three sentences,
 * and each is asserted structurally — against the import graph and the source
 * text — as well as behaviourally, because a boundary that holds only when the
 * code is called correctly is not a boundary:
 *
 *   the Experience layer READS; it owns no execution, approval or verification
 *   the client can only ask for things on §75's list
 *   nothing on screen exists that the backend did not produce
 *
 * §62 is why the UI half is checked this way rather than by rendering: a DOM
 * harness would test React, and the failures this class of code actually has
 * are contract failures — a status word the panel does not recognise, a frame
 * nobody mapped, a field that is not there. Driving the real modules and
 * reading the real component source catches exactly those.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { _setDbForTests, migrate } from '../src/memory/db.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nowforge-xsafe-'));
_setDbForTests(migrate(new DatabaseSync(path.join(scratch, 'test.db'))));

const { _setSettingsForTests } = await import('../src/config/store.js');
_setSettingsForTests({
  connection: { instanceUrl: 'https://dev424910.service-now.com', authType: 'basic', username: 'admin', password: 'x' },
  llm: { provider: 'ollama', model: '', baseUrl: '' },
  agent: { autoApprove: false, holdMutationsOnQuestion: true },
  skills: { installed: [], disabled: [] },
});

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const CLIENT = path.resolve(HERE, '..', '..', 'client', 'src');

const read = (p) => fs.readFileSync(p, 'utf8');
/** Comments describe boundaries; only CODE can cross one. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const jsIn = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.js'));

const ACTIVITY_DIR = path.join(SRC, 'agent', 'activity');
const SKILLS_DIR = path.join(SRC, 'agent', 'skills');

const A = await import('../src/agent/activity/index.js');
const S = await import('../src/agent/skills/index.js');
const { TOOLS } = await import('../src/agent/tools.js');

/* ================================================================== *
 * §73/§74 — the Experience layer owns nothing operational
 * ================================================================== */

test('E1 — §73: nothing in activity/ or skills/ can execute, approve or verify', () => {
  /*
   * The guarantee is the ABSENCE of the capability, not its non-use. These are
   * the modules that own the real thing, and importing any of them would give
   * a read model a path to the thing it is supposed to be reading.
   */
  const FORBIDDEN = [
    'servicenow/client', 'servicenow/fluent', 'servicenow/transport',
    'agent/orchestrator', './orchestrator', '../orchestrator',
    'agent/plan/executor', 'plan/executor', 'mutation-pipeline',
    'agent/recovery', '../recovery',
  ];
  for (const dir of [ACTIVITY_DIR, SKILLS_DIR]) {
    for (const f of jsIn(dir)) {
      const src = strip(read(path.join(dir, f)));
      for (const bad of FORBIDDEN) {
        assert.ok(!src.includes(bad), `${path.basename(dir)}/${f} imports ${bad}`);
      }
    }
  }
});

test('E2 — the read model performs NO writes: no INSERT, UPDATE or DELETE anywhere', () => {
  for (const f of jsIn(ACTIVITY_DIR)) {
    const src = strip(read(path.join(ACTIVITY_DIR, f)));
    for (const verb of ['INSERT ', 'UPDATE ', 'DELETE ']) {
      assert.ok(!src.includes(verb), `activity/${f} contains SQL ${verb.trim()}`);
    }
    /* And it does not reach for the transition functions either. */
    for (const fn of ['completeTask(', 'failTask(', 'cancelTask(', 'startTask(', 'setPlanState(', 'setStepState(']) {
      assert.ok(!src.includes(fn), `activity/${f} calls ${fn}`);
    }
  }
});

test('E3 — the skills layer never touches the database or a credential', () => {
  for (const f of jsIn(SKILLS_DIR)) {
    const src = strip(read(path.join(SKILLS_DIR, f)));
    assert.ok(!src.includes('getDb'), `skills/${f} reaches the database`);
    /*
      * READING the connection is the offence, not naming it. `manifest.js`
      * names `connection` in its forbidden-key table precisely so a manifest
      * carrying one is refused — a blunter check would flag the guard itself.
      */
    assert.ok(!/getSettings\(\)\s*\.\s*connection|\.connection\./.test(src),
      `skills/${f} reads the connection block`);
    assert.ok(!/\.(password|apiKey|clientSecret)\b/.test(src), `skills/${f} reads a credential field`);
  }
});

test('E4 — §79.7/§79.10: no skill file imports the tool registry', () => {
  /*
   * The registry imports the ServiceNow client, so importing it here would give
   * the skills layer a transitive path to a live call. `routes/skills.js` is
   * the only file that holds both, and it holds them to INJECT the tool list —
   * which is why `listSkills` takes `{ tools }` rather than reading it.
   */
  for (const f of jsIn(SKILLS_DIR)) {
    const src = strip(read(path.join(SKILLS_DIR, f)));
    assert.ok(!src.includes("tools.js"), `skills/${f} imports the tool registry`);
  }
  assert.match(read(path.join(SRC, 'routes', 'skills.js')), /import \{ TOOLS \} from '\.\.\/agent\/tools\.js'/);
});

test('E5 — §79.2: the singletons are still single', () => {
  /*
   * One executor, one verifier, one evidence builder, one approval gate. The
   * Experience layer added panels, not a second anything.
   */
  const count = (needle) => {
    let n = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js') && strip(read(p)).includes(needle)) n += 1;
      }
    };
    walk(SRC);
    return n;
  };
  assert.equal(count('export async function executePlan'), 1, 'a second executePlan exists');
  assert.equal(count('export async function verifyMutation'), 1, 'a second verifyMutation exists');
  assert.equal(count('export function buildEvidence'), 1, 'a second buildEvidence exists');
  assert.equal(count('export async function executeTool'), 1, 'a second executeTool exists');
});

test('E6 — §79.4: there is still exactly ONE cancellation path', () => {
  /*
   * Cancellation is the client aborting its own fetch; the server sees the
   * disconnect and stops at the next safe boundary. There is deliberately no
   * cancel ENDPOINT — a second route would need a registry of in-flight turns,
   * which is the global state Phase 0 refused to introduce.
   *
   * So the blocker is a new route, and this is what would catch one.
   */
  const routes = path.join(SRC, 'routes');
  for (const f of fs.readdirSync(routes).filter((x) => x.endsWith('.js'))) {
    const src = strip(read(path.join(routes, f)));
    assert.ok(!/\.(post|delete|patch)\(['"][^'"]*cancel/i.test(src), `routes/${f} adds a cancellation endpoint`);
  }
  /* And the client still stops by aborting, not by calling one. */
  const chat = read(path.join(CLIENT, 'pages', 'AgentChat.jsx'));
  assert.match(chat, /turnAbort\.current\.abort\(\)/, 'the Stop button no longer aborts the fetch');
});

/* ================================================================== *
 * §75/§79.5 — what the client may ask for
 * ================================================================== */

test('E7 — §79.5: no client file can execute a tool', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.jsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(CLIENT);
  for (const f of files) {
    const src = strip(read(f));
    assert.ok(!/\/agent\/(execute|tool|run)\b/.test(src), `${path.relative(CLIENT, f)} posts to a tool endpoint`);
    assert.ok(!/executeTool|executePlan\(/.test(src), `${path.relative(CLIENT, f)} names an executor`);
  }
});

test('E8 — §79.6: the approval UI posts to the EXISTING approval endpoint and nowhere else', () => {
  const chat = strip(read(path.join(CLIENT, 'pages', 'AgentChat.jsx')));
  const approvals = [...chat.matchAll(/api\.post\('([^']*approve[^']*)'/g)].map((m) => m[1]);
  assert.ok(approvals.length > 0, 'the approval card no longer posts anywhere');
  for (const p of approvals) {
    assert.equal(p, '/agent/approve', `the approval card posts to ${p}`);
  }
  /* And the new panels post nothing at all. */
  for (const f of ['ActivityPanel.jsx', 'PlanPanel.jsx', 'TaskHistory.jsx']) {
    const src = strip(read(path.join(CLIENT, 'components', f)));
    assert.ok(!/api\.(post|patch|del)\(/.test(src), `${f} performs a write`);
  }
});

test('E9 — the Skills panel only enables, disables, installs and removes', () => {
  const src = strip(read(path.join(CLIENT, 'components', 'SkillsPanel.jsx')));
  const calls = [...src.matchAll(/api\.(post|patch|del)\('([^']+)'|api\.(post|patch|del)\(`([^`]+)`/g)]
    .map((m) => m[2] ?? m[4]);
  for (const c of calls) {
    assert.ok(c.startsWith('/skills'), `SkillsPanel calls ${c}, which is outside the skill registry`);
  }
});

/* ================================================================== *
 * §79.1/§79.2/§79.3 — no fake anything
 * ================================================================== */

test('E10 — the client\'s frame map and the server\'s agree exactly', () => {
  /*
   * The client maps frames locally so the timeline can render while streaming.
   * A second copy is a liability, so it is GUARDED: every frame the server has
   * an opinion about must appear here too, with the same decision about whether
   * it is activity. A frame added to the orchestrator without a decision on
   * both sides fails this.
   */
  const clientSrc = read(path.join(CLIENT, 'components', 'activity.js'));
  const clientMap = clientSrc.slice(clientSrc.indexOf('export const FRAME_MAP'));
  for (const type of A.KNOWN_FRAMES) {
    assert.ok(
      new RegExp(`(^|[\\s{,])${type}:`, 'm').test(clientMap),
      `the client has no entry for the frame "${type}"`,
    );
  }
  /* Both agree on which of them are activity. */
  for (const type of A.ACTIVITY_FRAMES) {
    assert.ok(
      new RegExp(`${type}:\\s*(\\(|\\w+\\s*=>)`, 'm').test(clientMap),
      `the client declares "${type}" non-activity while the server maps it`,
    );
  }
});

test('E11 — the client status vocabulary is EXACTLY the server\'s', () => {
  const src = read(path.join(CLIENT, 'components', 'activity.js'));
  for (const s of A.AGENT_STATUSES) {
    assert.ok(src.includes(`${s}:`), `the client cannot render the status ${s}`);
  }
  /* And it invents none of its own. */
  const block = src.slice(src.indexOf('export const AGENT_STATUS'), src.indexOf('export const STATUS_PRECEDENCE'));
  for (const m of block.matchAll(/^\s{2}([A-Z_]+):/gm)) {
    assert.ok(A.AGENT_STATUSES.includes(m[1]), `the client invented the status ${m[1]}`);
  }
});

test('E12 — the client\'s precedence is the server\'s, in the same order', () => {
  const src = read(path.join(CLIENT, 'components', 'activity.js'));
  const start = src.indexOf('export const STATUS_PRECEDENCE');
  const end = src.indexOf('export const STATUS_LABEL');
  assert.ok(start > -1 && end > start, 'the client precedence list moved or vanished');
  const block = src.slice(start, end);
  const order = [...block.matchAll(/AGENT_STATUS\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(order.slice(0, A.STATUS_PRECEDENCE.length), A.STATUS_PRECEDENCE,
    'the two halves would disagree about what the agent is doing');
});

test('E13 — §79.3: no panel has success-shaped vocabulary of its own', () => {
  /*
   * The rule Phase 9 established for the Evidence panel, applied to the new
   * ones: the words "verified", "succeeded" and "complete" may only ever be the
   * SERVER's, interpolated from its own fields — never a literal the component
   * decided to render.
   */
  for (const f of ['ActivityPanel.jsx', 'PlanPanel.jsx', 'TaskHistory.jsx']) {
    const src = strip(read(path.join(CLIENT, 'components', f)));
    const literals = [...src.matchAll(/>([^<>{}]*\b(verified|succeeded|success)\b[^<>{}]*)</gi)].map((m) => m[1]);
    assert.deepEqual(literals, [], `${f} renders its own success wording: ${literals.join(' | ')}`);
  }
});

test('E14 — §66: no panel runs a timer, an interval, or an animation of its own', () => {
  for (const f of ['ActivityPanel.jsx', 'PlanPanel.jsx', 'SkillsPanel.jsx', 'TaskHistory.jsx']) {
    const src = strip(read(path.join(CLIENT, 'components', f)));
    assert.ok(!/setInterval|setTimeout/.test(src), `${f} advances state on a timer`);
  }
});

test('E15 — §52: reopening a task cannot re-execute anything', () => {
  /*
   * The history component's only network verb is GET, and the route it calls is
   * a projection. The property is kept by there being nothing else it could do.
   */
  const src = strip(read(path.join(CLIENT, 'components', 'TaskHistory.jsx')));
  assert.ok(!/api\.(post|patch|del)/.test(src), 'TaskHistory can write');
  assert.ok(!/sse\(/.test(src), 'TaskHistory opens a stream');
});

/* ================================================================== *
 * §59/§79.18 — secrets
 * ================================================================== */

test('E16 — the client never redacts, because the server already did', () => {
  /*
   * A second redactor is a second thing to fall behind the key list. The
   * activity projection redacts at the boundary; the panels render what
   * arrives.
   */
  for (const f of ['ActivityPanel.jsx', 'PlanPanel.jsx', 'SkillsPanel.jsx', 'TaskHistory.jsx', 'activity.js']) {
    const src = strip(read(path.join(CLIENT, 'components', f)));
    assert.ok(!/SECRET_KEYS|findSecrets|function redact/.test(src), `${f} implements its own redaction`);
  }
  assert.match(read(path.join(ACTIVITY_DIR, 'project.js')), /from '\.\.\/\.\.\/memory\/redact\.js'/);
});

test('E17 — §59: every metadata object leaving the projection passes through redact', () => {
  const src = strip(read(path.join(ACTIVITY_DIR, 'project.js')));
  const metas = [...src.matchAll(/metadata:\s*([a-zA-Z_$]*\()/g)].map((m) => m[1]);
  assert.ok(metas.length > 0, 'the projection stopped carrying metadata');
  for (const m of metas) {
    assert.equal(m, 'redact(', `a metadata object is emitted through "${m}" rather than redact()`);
  }
});

/* ================================================================== *
 * §77 — the database
 * ================================================================== */

test('E18 — §77: no new tables, and the schema is still at 25', () => {
  const db = new DatabaseSync(path.join(scratch, 'ver.db'));
  migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 25);

  /* And the skill registry is configuration, not a table. */
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(!names.some((n) => /skill|activity/i.test(n)), `a table was added: ${names.join(', ')}`);
  db.close();
});

test('E19 — the skill registry lives in the existing configuration store', () => {
  const store = strip(read(path.join(SRC, 'config', 'store.js')));
  assert.match(store, /skills:\s*\{/, 'the config store has no skills section');
  assert.match(store, /export function saveSkills/, 'there is no skills writer');
  /*
   * And that writer cannot reach the credential block: it copies the current
   * settings and replaces one key, so there is no path from a skills route to
   * `connection`.
   */
  const fn = store.slice(store.indexOf('export function saveSkills'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!body.includes('connection'), 'saveSkills can write the connection block');
  assert.ok(!body.includes('announceBinding'), 'saveSkills re-announces the instance binding');
});

/* ================================================================== *
 * §40/§41 — behavioural, not just structural
 * ================================================================== */

test('E20 — §79.8: a disabled skill is removed from the surface the planner is GIVEN', () => {
  const all = S.listSkills({ tools: TOOLS });
  const off = all.map((s) => (s.id === 'incident-operations' ? { ...s, enabled: false } : s));
  const surface = S.toolsForSkills(TOOLS, off);
  assert.ok(!surface.tools.some((t) => t.name === 'create_incident'));
  /* The orchestrator builds its profile from THIS array, not from the registry. */
  const orch = strip(read(path.join(SRC, 'agent', 'orchestrator.js')));
  assert.match(orch, /buildContextProfile\(\{ goal: userText, tools: surface\.tools/);
  assert.ok(!/widenProfile\(profile, \{ tools: TOOLS/.test(orch),
    'widening goes back to the full registry, which would undo the skill boundary');
  assert.match(orch, /widenProfile\(profile, \{ tools: surface\.tools/);
});

test('E21 — and refused at DISPATCH, before the widening branch that would re-admit it', () => {
  const orch = read(path.join(SRC, 'agent', 'orchestrator.js'));
  const gate = orch.indexOf("reason: 'skill_disabled'");
  const widen = orch.indexOf('const wasExcluded');
  assert.ok(gate > -1, 'there is no dispatch-time skill gate');
  assert.ok(widen > -1);
  assert.ok(gate < widen,
    'the skill gate runs AFTER the widening branch, so a disabled tool would be admitted one iteration later');
  /* And the message must read as a refusal, not as a narrowing. */
  const msg = orch.slice(gate - 1200, gate);
  assert.match(msg, /This IS a refusal/);
  assert.match(msg, /do not substitute a different tool/);
});

test('E22 — §45: the task records its skill set at OPEN, from the task not the registry', () => {
  const tracker = strip(read(path.join(SRC, 'agent', 'task-tracker.js')));
  assert.match(tracker, /metadata\.skills = skills/);
  /* The projection reads it back from the task's own row. */
  const proj = strip(read(path.join(ACTIVITY_DIR, 'project.js')));
  assert.match(proj, /metadata_json/);
  assert.ok(!proj.includes('listSkills') && !proj.includes('enabledSkills'),
    'the projection consults the live registry, so a later toggle would rewrite finished runs');
});

/* ================================================================== *
 * §3 — no private chain of thought
 * ================================================================== */

test('E23 — §3: nothing renders model reasoning, and no frame carries any', () => {
  const BANNED = [/let me think/i, /step by step/i, /chain[- ]of[- ]thought/i, /reasoning:/i, /deliberat/i];
  for (const f of ['ActivityPanel.jsx', 'PlanPanel.jsx', 'activity.js']) {
    const src = read(path.join(CLIENT, 'components', f));
    /* The comments may discuss the rule; the rendered strings may not. */
    const code = strip(src);
    for (const re of BANNED) {
      assert.ok(!re.test(code), `${f} contains reasoning-shaped text matching ${re}`);
    }
  }
  /* And every activity title the server can produce is operational. */
  for (const type of A.ACTIVITY_FRAMES) {
    const row = A.fromFrame({ type }, { taskId: 't' });
    for (const re of BANNED) assert.ok(!re.test(row.title), `${type} produces the title "${row.title}"`);
  }
});

/* ================================================================== *
 * The API contract the panels depend on
 * ================================================================== */

test('E24 — the activity route is READ-ONLY and 404s an unknown task', async () => {
  const plan = strip(read(path.join(SRC, 'routes', 'plan.js')));
  const idx = plan.indexOf("planRouter.get('/:taskId/activity'");
  assert.ok(idx > -1, 'the activity route is gone');
  const handler = plan.slice(idx, idx + 700);
  assert.match(handler, /status: 404/);
  assert.ok(!/executePlan|approvePlan|savePlan|setPlanState/.test(handler), 'the activity route can mutate');

  const { activityForTask } = A;
  assert.equal(activityForTask('nope'), null);
});

test('E25 — every field the panels read exists on a REAL projection', async () => {
  /*
   * The Phase 9 contract test's own method: drive the real server, then check
   * the shape against what the component actually reads. A field-name mismatch
   * — `state` versus `execution_status` — is the failure this class of UI
   * really has, and no amount of rendering would catch it if the fixture were
   * written from the same wrong assumption.
   */
  const { createTask, startTask, completeTask, createStep, startStep, completeStep } =
    await import('../src/memory/tasks.js');
  const { createSession, recordToolEvent } = await import('../src/memory/sessions.js');

  createSession({ id: 'sess-contract' });
  const task = createTask({ sessionId: 'sess-contract', goal: 'assign INC0010038' });
  startTask(task.id);
  const step = createStep({ taskId: task.id, kind: 'turn', description: 'One agent turn' });
  startStep(step.id);
  recordToolEvent('sess-contract', {
    kind: 'tool_call', name: 'update_record', payload: { table: 'incident' },
    resultStatus: 'ok', mutating: true, approval: 'approved', approvedSource: 'user_click', taskId: task.id,
  });
  completeStep(step.id);
  completeTask(task.id);

  const a = A.activityForTask(task.id);

  /* What AgentChat reads off the projection when it opens a task. */
  for (const f of ['events', 'progress', 'status', 'cursor', 'skills', 'task_id']) {
    assert.ok(f in a, `the projection has no "${f}", which openTask() reads`);
  }
  /* What ActivityPanel reads off each row. */
  for (const e of a.events) {
    for (const f of ['id', 'seq', 'type', 'status', 'title', 'summary', 'timestamp']) {
      assert.ok(f in e, `an activity event has no "${f}"`);
    }
  }
  /* What PlanPanel reads off progress, and what TaskHistory reads off a row. */
  for (const f of ['total', 'completed', 'running', 'queued', 'failed', 'awaiting_approval']) {
    assert.ok(f in a.progress, `progress has no "${f}"`);
  }
  const [row] = A.taskHistory('sess-contract');
  for (const f of ['task_id', 'goal', 'state', 'status', 'created_at', 'progress', 'skills']) {
    assert.ok(f in row, `a history row has no "${f}"`);
  }

  /* And every status the projection can emit is one the client can render. */
  const clientSrc = read(path.join(CLIENT, 'components', 'activity.js'));
  for (const e of a.events) {
    assert.ok(clientSrc.includes(`${e.status}:`), `the client cannot render the row status "${e.status}"`);
  }
  assert.ok(clientSrc.includes(`${a.status}:`), `the client cannot render the task status "${a.status}"`);
});

test('E26 — §8: every audit row the TURN writes names its task', () => {
  /*
   * THE DEFECT THIS PINS, which the real-model evaluation found.
   *
   * Migration 23 added `tool_events.task_id` so evidence could stop guessing,
   * but only the plan executor ever wrote it. Every row the ordinary turn loop
   * produced was NULL, so both the evidence layer and the activity projection
   * matched by session-plus-time-window — deterministic, but not a key. Two
   * turns overlapping in one session each claimed the other's tool calls, and
   * the workspace could therefore show a tool this task never ran.
   *
   * Asserted on the SOURCE rather than behaviourally, because the failure mode
   * is a NEW call site added without the stamp — which no existing behavioural
   * test would exercise. Every `recordToolEvent(sessionId, {` inside the turn
   * loop must name the task on the very next line.
   */
  const src = read(path.join(SRC, 'agent', 'orchestrator.js'));
  const lines = src.split(/\r?\n/);
  const turnAt = lines.findIndex((l) => l.startsWith('export async function runTurn('));
  const gateAt = lines.findIndex((l) => l.startsWith('async function handleGatedElevation('));
  const proseAt = lines.findIndex((l) => l.startsWith('export function proseOnly('));
  assert.ok(turnAt > 0 && gateAt > 0 && proseAt > gateAt, 'the orchestrator was restructured; this guard needs updating');

  /*
   * EVERY site, not only the turn loop's. The one call outside it —
   * `resolveApproval`, which runs on the approve request — reaches the turn's
   * id through the shared live state, so there is no longer any audit row in
   * this file that cannot name its task.
   */
  const unstamped = [];
  lines.forEach((line, i) => {
    if (line.trim() !== 'recordToolEvent(sessionId, {') return;
    const next5 = lines.slice(i + 1, i + 14).map((l) => l.trim());
    if (!next5.some((l) => l === 'taskId,' || l.startsWith('taskId:'))) unstamped.push(i + 1);
  });
  assert.deepEqual(unstamped, [],
    `these recordToolEvent calls do not name their task (line numbers): ${unstamped.join(', ')}`);

  /* And the route supplies it. */
  const route = strip(read(path.join(SRC, 'routes', 'agent.js')));
  assert.match(route, /runTurn\(sessionId, message, emit, \{[\s\S]*?taskId: task\.taskId/);
});

test('E27 — runTurn takes the task id as an OPAQUE string, not as a dependency', () => {
  /*
   * The layering §73 protects: the task layer watches the turn's output, the
   * turn does not reach back into the task layer. Passing a correlation id is
   * the same arrangement `sessionId` already has — so the check is that the
   * orchestrator still imports nothing from the task modules.
   */
  const src = strip(read(path.join(SRC, 'agent', 'orchestrator.js')));
  assert.ok(!src.includes("memory/tasks.js"), 'the orchestrator imports the task store');
  assert.ok(!src.includes('task-tracker'), 'the orchestrator imports the task tracker');
  for (const fn of ['createTask(', 'completeTask(', 'failTask(', 'startTask(']) {
    assert.ok(!src.includes(fn), `the orchestrator calls ${fn}`);
  }
  assert.match(src, /runTurn\(sessionId, userText, emit, \{ retry = false, signal = null, taskId = null \}/);
});

test('E28 — §68: a chat turn is distinguishable from a plan, so no plan panel appears for one', async () => {
  /*
   * THE DEFECT THIS PINS. Phase 1's shape is "one turn, one task, one step", so
   * EVERY task carries a step — and a plan panel filtered on step-ness alone
   * rendered "Plan: 1 step · One agent turn" above every ordinary message. §68
   * says the panels are contextual and the conversation stays primary; a panel
   * that appears every single time is neither.
   *
   * The distinguishing field is `plan_step_id`, which the plan store sets and
   * the turn tracker leaves null. This asserts the projection really carries
   * that difference, and that the client filters on it — because the panel is
   * only correct if BOTH are true.
   */
  const { createTask, startTask, completeTask, createStep, startStep, completeStep } =
    await import('../src/memory/tasks.js');
  const { createSession } = await import('../src/memory/sessions.js');
  const { getDb } = await import('../src/memory/db.js');

  createSession({ id: 'sess-shape' });
  const task = createTask({ sessionId: 'sess-shape', goal: 'an ordinary turn' });
  startTask(task.id);
  const turnStep = createStep({ taskId: task.id, kind: 'turn', description: 'One agent turn, executed by runTurn()' });
  startStep(turnStep.id);
  completeStep(turnStep.id);
  completeTask(task.id);

  const turn = A.activityForTask(task.id);
  const steps = turn.events.filter((e) => e.type === 'step');
  assert.equal(steps.length, 1, 'a turn should project exactly one step');
  assert.equal(steps[0].metadata.plan_step_id, null,
    'a turn step carries a plan_step_id, so the client cannot tell a turn from a plan');

  /* A PLAN step does carry one. */
  const planTask = createTask({ sessionId: 'sess-shape', goal: 'a plan' });
  startTask(planTask.id);
  const planStep = createStep({ taskId: planTask.id, kind: 'plan_step', description: 'Create the record' });
  getDb().prepare('UPDATE agent_task_steps SET plan_step_id = ? WHERE id = ?').run('step_1', planStep.id);
  completeTask(planTask.id);

  const planned = A.activityForTask(planTask.id).events.filter((e) => e.type === 'step');
  assert.equal(planned[0].metadata.plan_step_id, 'step_1');

  /* And the client filters on exactly that field. */
  const chat = strip(read(path.join(CLIENT, 'pages', 'AgentChat.jsx')));
  assert.match(chat, /r\.metadata\.plan_step_id/,
    'AgentChat no longer distinguishes plan steps from turn steps');
});
