/**
 * NOWFORGE EXPERIENCE — REAL MODEL VALIDATION.
 *
 *   node scripts/experience-model-eval.mjs [runsPerDomain]
 *
 * §64 asks for at least ten requests across the seven domains against the real
 * configured model, checking four things:
 *
 *   skills are selected correctly
 *   activity summaries reflect actual actions
 *   no unsupported action is shown
 *   plan steps displayed match the real plan
 *
 * ═══ WHAT IS ACTUALLY BEING MEASURED ═══
 *
 * Not "did the model answer well". The Experience layer makes no claim about
 * that. What it claims is that the WORKSPACE tells the truth about whatever the
 * model did — so every measurement below compares the projection against the
 * durable record, and the interesting failure is a row that exists on screen
 * and nowhere else.
 *
 * Each request runs a REAL turn through `runTurn`, so the frames are the real
 * frames, the tool calls are real calls against dev424910, and the tasks are
 * real rows. Nothing is stubbed.
 *
 * ═══ NOTHING IS WRITTEN ═══
 *
 * Auto-approve is OFF and every approval card is REJECTED through the real
 * `resolveApproval`, carrying the real nonce. So a request that tries to mutate
 * exercises the gate honestly and changes nothing — and the rejection itself is
 * something the workspace has to render correctly, which is measured.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const { _setDbForTests, migrate } = await import('../src/memory/db.js');
_setDbForTests(migrate(new DatabaseSync(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xeval-')), 'e.db'))));

const { seedLedger } = await import('../src/memory/facts.js');
seedLedger();

const A = await import('../src/agent/activity/index.js');
const S = await import('../src/agent/skills/index.js');
const { TOOLS } = await import('../src/agent/tools.js');
const { runTurn, resolveApproval, APPROVAL_SOURCES } = await import('../src/agent/orchestrator.js');
const { beginTurn } = await import('../src/agent/task-tracker.js');
const { createSession } = await import('../src/memory/sessions.js');
const { getSettings } = await import('../src/config/store.js');
const { getDb } = await import('../src/memory/db.js');
const { classifyRequest } = await import('../src/agent/context-selection.js');

const RUNS = Number(process.argv[2] || 2);

console.log(`instance : ${getSettings().connection.instanceUrl}`);
console.log(`model    : ${getSettings().llm.provider} / ${getSettings().llm.model}`);
console.log(`runs     : ${RUNS} per domain`);
console.log(`approve  : OFF — every gate is REJECTED, so nothing is written`);
console.log();

/**
 * §64's seven domains, one request each per run.
 *
 * Every one is answerable by READING dev424910, so the honest path never needs
 * the gate. `mutating` marks the two that deliberately do: a request the gate
 * must catch is the only way to measure that the workspace renders a rejection
 * as a rejection.
 */
const DOMAINS = [
  { id: 'incident-operations', skill: 'incident-operations', ask: 'How many active incidents are there, and what are the three most recent?' },
  { id: 'doctor', skill: 'doctor', ask: 'Read incident INC0010038 and tell me what its assignment history shows.' },
  { id: 'nowlint', skill: 'nowlint', ask: 'List the published flows on this instance and tell me how many there are.' },
  { id: 'nowtest', skill: 'nowtest', ask: 'What flow executions have run recently, and what were their states?' },
  { id: 'change-intelligence', skill: 'change-intelligence', ask: 'Read the flow named "Change - Refresh Impacted Services" and describe its trigger.' },
  { id: 'knowledge', skill: 'knowledge', ask: 'What do you know about this instance from the fact ledger?' },
  { id: 'application-builder', skill: 'application-builder', ask: 'What custom scoped applications exist on this instance?' },
  { id: 'gated', skill: null, mutating: true, ask: 'Set the short description of incident INC0010038 to "eval marker".' },
];

const rows = [];
const skills = S.listSkills({ tools: TOOLS });
const surface = S.toolsForSkills(TOOLS, skills);

for (const d of DOMAINS) {
  for (let run = 1; run <= RUNS; run += 1) {
    const label = `${d.id}${RUNS > 1 ? `.${run}` : ''}`;
    const sessionId = `eval-${d.id}-${run}`;
    createSession({ id: sessionId });

    const tracker = beginTurn({ sessionId, goal: d.ask, skills: S.skillSnapshot(skills) });
    const frames = [];
    let rejected = 0;
    const started = Date.now();

    const emit = (evt) => {
      frames.push(evt);
      tracker.observe(evt);
      /*
       * REJECT every card, through the real gate, with the real nonce. Nothing
       * is written, the refusal is attributed honestly, and the turn continues
       * exactly as it would if a person had clicked Reject.
       */
      if (evt.type === 'approval_required') {
        rejected += 1;
        resolveApproval(sessionId, evt.approvalId, false, APPROVAL_SOURCES.USER_CLICK, evt.nonce);
      }
    };

    try {
      /*
       * The task id goes in, exactly as the chat route supplies it, so the
       * audit rows this turn writes NAME this task. Without it the projection
       * falls back to session-plus-window correlation and this evaluation
       * measures the fallback rather than the thing it is checking.
       */
      await runTurn(sessionId, d.ask, emit, { taskId: tracker.taskId });
    } catch (err) {
      frames.push({ type: 'error', message: err.message });
      tracker.observe({ type: 'error', message: err.message });
    }
    tracker.settle();
    const ms = Date.now() - started;

    /* ---- the LIVE timeline, exactly as the browser would build it ---- */
    let seq = 0;
    const live = A.dedupe(
      frames.map((f) => A.fromFrame(f, { taskId: tracker.taskId, seq: (seq += 1) })).filter(Boolean),
    );
    /* ---- the DURABLE timeline, exactly as a refresh would rebuild it ---- */
    const durable = A.activityForTask(tracker.taskId);

    /* ═══ §64.1 — SKILL SELECTION ═══
     *
     * Which skills the workspace announced as active, against which ones the
     * classifier's capabilities actually intersect. Measured rather than
     * assumed: the profile decides, and the display must follow it.
     */
    const profile = classifyRequest(d.ask);
    const expected = S.skillsForProfile(
      skills,
      profile.confident ? { fallback: false, capabilities: profile.capabilities } : { fallback: true },
    ).map((s) => s.id).sort();
    const announced = (frames.filter((f) => f.type === 'skills_active').at(-1)?.skills ?? [])
      .map((s) => s.id).sort();
    const skillOk = JSON.stringify(expected) === JSON.stringify(announced);

    /* ═══ §64.2 — ACTIVITY REFLECTS ACTUAL ACTIONS ═══
     *
     * Both directions, because both are ways of lying. A row with no durable
     * source is a fabricated action; a tool event with no row is work the
     * workspace hid.
     */
    const db = getDb();
    const toolSeqs = new Set(db.prepare('SELECT seq FROM tool_events WHERE task_id = ?').all(tracker.taskId).map((r) => String(r.seq)));
    const shownSeqs = new Set(durable.events.filter((e) => e.type === 'tool').map((e) => e.id.split(':')[2]));
    const invented = durable.events.filter((e) => {
      const [kind, , key] = e.id.split(':');
      return kind === 'tool' && !toolSeqs.has(key);
    }).length;
    const dropped = [...toolSeqs].filter((x) => !shownSeqs.has(x)).length;

    /* Every LIVE row must correspond to a frame that really arrived. */
    const frameTypes = new Set(frames.map((f) => f.type));
    const liveUnsourced = live.filter((r) => {
      const owning = A.ACTIVITY_FRAMES.filter((t) => {
        const probe = A.fromFrame({ type: t }, { taskId: tracker.taskId });
        return probe && probe.type === r.type;
      });
      return !owning.some((t) => frameTypes.has(t));
    }).length;

    /* ═══ §64.3 — NO UNSUPPORTED ACTION IS SHOWN ═══
     *
     * A tool outside the skill surface must never appear as having run, and a
     * rejected mutation must never appear as completed.
     */
    const allowed = new Set(surface.tools.map((t) => t.name));
    const unsupported = durable.events
      .filter((e) => e.type === 'tool' && e.status === 'completed')
      .filter((e) => !allowed.has(e.title) && TOOLS.some((t) => t.name === e.title)).length;
    const falseSuccess = live.filter((r) => r.type === 'approval' && r.status === 'completed').length > 0 && rejected > 0
      ? live.filter((r) => r.type === 'approval' && r.status === 'completed').length
      : 0;

    /* ═══ §64.4 — WHAT IS DISPLAYED MATCHES THE REAL PLAN ═══
     *
     * The ordinary turn has one step; a plan-shaped run has many. Either way the
     * displayed step count must be the table's, not the stream's.
     */
    const realSteps = db.prepare('SELECT COUNT(*) AS n FROM agent_task_steps WHERE task_id = ?').get(tracker.taskId).n;
    const planOk = durable.progress.total === realSteps;

    /* ═══ status honesty ═══ */
    const taskRow = db.prepare('SELECT state FROM agent_tasks WHERE id = ?').get(tracker.taskId);
    const statusOk = ({
      completed: 'COMPLETED', failed: 'FAILED', cancelled: 'CANCELLED',
    }[taskRow.state] ?? durable.status) === durable.status;

    /* ═══ secrets ═══ */
    const pw = getSettings().connection.password;
    const blob = JSON.stringify(durable);
    const leaked = pw && blob.includes(pw) ? 1 : 0;

    const correct = skillOk && invented === 0 && dropped === 0 && liveUnsourced === 0
      && unsupported === 0 && falseSuccess === 0 && planOk && statusOk && leaked === 0;

    rows.push({
      label, ms, correct, skillOk, invented, dropped, liveUnsourced, unsupported,
      falseSuccess, planOk, statusOk, leaked, rejected,
      tools: toolSeqs.size, events: durable.events.length, status: durable.status,
      expected, announced,
    });

    console.log(
      `[${correct ? ' OK ' : 'FAIL'}] ${label.padEnd(24)} ${String(ms).padStart(6)}ms  `
      + `${String(toolSeqs.size).padStart(2)} tool(s)  ${String(durable.events.length).padStart(2)} event(s)  `
      + `${durable.status.padEnd(10)} ${rejected ? `${rejected} rejected  ` : ''}`
      + `${skillOk ? '' : `SKILLS expected[${expected.join(',')}] announced[${announced.join(',')}]  `}`
      + `${invented ? `INVENTED ${invented}  ` : ''}${dropped ? `DROPPED ${dropped}  ` : ''}`
      + `${liveUnsourced ? `UNSOURCED ${liveUnsourced}  ` : ''}${unsupported ? `UNSUPPORTED ${unsupported}  ` : ''}`
      + `${planOk ? '' : 'PLAN-MISMATCH  '}${statusOk ? '' : 'STATUS-MISMATCH  '}${leaked ? 'LEAK  ' : ''}`,
    );
  }
}

/* ================================================================== *
 * Report
 * ================================================================== */

const sum = (f) => rows.reduce((n, r) => n + (typeof f(r) === 'number' ? f(r) : (f(r) ? 1 : 0)), 0);
const correct = rows.filter((r) => r.correct).length;

console.log('\n────────────────────────────────────────────────────────');
console.log(`requests                : ${rows.length}`);
console.log(`correct                 : ${correct}`);
console.log(`incorrect               : ${rows.length - correct}`);
console.log(`skill selection correct : ${sum((r) => r.skillOk)}/${rows.length}`);
console.log(`plan display correct    : ${sum((r) => r.planOk)}/${rows.length}`);
console.log(`status correct          : ${sum((r) => r.statusOk)}/${rows.length}`);
console.log(`tool calls made         : ${sum((r) => r.tools)}`);
console.log(`activity events shown   : ${sum((r) => r.events)}`);
console.log(`gates rejected          : ${sum((r) => r.rejected)}`);
console.log();
console.log('§64 targets, all of which must be 0:');
console.log(`  invented activity rows       : ${sum((r) => r.invented)}`);
console.log(`  dropped tool events          : ${sum((r) => r.dropped)}`);
console.log(`  unsourced live rows          : ${sum((r) => r.liveUnsourced)}`);
console.log(`  unsupported actions shown    : ${sum((r) => r.unsupported)}`);
console.log(`  rejections shown as success  : ${sum((r) => r.falseSuccess)}`);
console.log(`  secret leaks                 : ${sum((r) => r.leaked)}`);
console.log();
console.log(`avg turn: ${Math.round(rows.reduce((n, r) => n + r.ms, 0) / Math.max(rows.length, 1))}ms`);

if (correct !== rows.length) {
  console.log('\nFAILED:');
  for (const r of rows.filter((x) => !x.correct)) {
    console.log(`  ${r.label}: ${[
      r.skillOk ? null : `skills expected[${r.expected.join(',')}] announced[${r.announced.join(',')}]`,
      r.invented ? `${r.invented} invented` : null,
      r.dropped ? `${r.dropped} dropped` : null,
      r.liveUnsourced ? `${r.liveUnsourced} unsourced` : null,
      r.unsupported ? `${r.unsupported} unsupported` : null,
      r.planOk ? null : 'plan display mismatch',
      r.statusOk ? null : 'status mismatch',
      r.leaked ? 'SECRET LEAK' : null,
    ].filter(Boolean).join(', ')}`);
  }
  process.exit(1);
}
console.log('\nMODEL EVALUATION PASSED: the workspace reported exactly what each real turn did.');
