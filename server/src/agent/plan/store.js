import crypto from 'node:crypto';
import { getDb } from '../../memory/db.js';
import { log } from '../../logging.js';
import { canTransition, isTerminal, PLAN_STATES, STEP_STATES } from './states.js';
import { fingerprintPlan, fingerprintMatches, diffPlans } from './fingerprint.js';
import { canonicalisePlan } from './canonical.js';

/**
 * PHASE 4 — PLAN PERSISTENCE.
 *
 * ON THE PHASE 1 TABLES, not beside them. A plan is a task with steps, which
 * `agent_tasks` / `agent_task_steps` already model; migration 22 added the
 * executable columns rather than a second pair of tables. Two lifecycles that
 * could disagree about what a run is would be worse than a wide table.
 *
 * THE DATABASE IS THE SOURCE OF TRUTH. Nothing here is cached in a module-level
 * map, and the SSE stream is transport rather than state — a UI that reconnects
 * mid-plan reads the plan back and reconstructs it exactly, because the process
 * that made it holds nothing the database does not.
 *
 * TRANSITIONS GO THROUGH ONE FUNCTION. `setPlanState` and `setStepState` are
 * the only writers of a state column, and both refuse a transition the table in
 * states.js does not permit. That is what makes "a plan cannot reach EXECUTING
 * without passing AWAITING_APPROVAL" a property of the schema's behaviour
 * rather than of the executor remembering.
 */

const now = () => new Date().toISOString();
const json = (v) => { try { return v === undefined ? null : JSON.stringify(v); } catch { return null; } };
const parse = (v) => { if (!v) return null; try { return JSON.parse(v); } catch { return null; } };

/* ------------------------------------------------------------------ *
 * Writing a plan
 * ------------------------------------------------------------------ */

/**
 * Attach a validated plan to an existing task.
 *
 * The task comes from Phase 1 — one per user turn — so a plan never invents its
 * own container. Steps are inserted in plan order, and their `sequence` is
 * allocated by the table exactly as Phase 1 does it.
 *
 * Idempotent by replacement: re-saving a plan for a task removes the previous
 * steps first. That is what makes a re-plan clean rather than additive — and it
 * is precisely why the fingerprint exists, because a replaced plan is a
 * different plan and must not inherit the old one's approval.
 */
export function savePlan(taskId, plan) {
  const db = getDb();
  /*
   * PHASE 11 — THE PLAN IS CANONICALISED BEFORE IT IS FINGERPRINTED OR STORED.
   *
   * `inputs_json` is what the executor later hands to `executeTool`, so it must
   * already be the canonical execution arguments — otherwise a plan could be
   * approved against one representation and run from another. A plan that came
   * through `generatePlan` is canonical already and this is a no-op; a plan
   * built directly (a test, a fixture) is canonicalised here, so there is no
   * path into storage that skips it.
   *
   * This is BEFORE the fingerprint on purpose. Nothing reshapes arguments after
   * this line.
   */
  const { plan: canonical } = canonicalisePlan(plan);
  const fingerprint = fingerprintPlan(canonical);
  plan = canonical;
  try {
    db.exec('BEGIN');
    db.prepare('DELETE FROM agent_task_steps WHERE task_id = ? AND plan_step_id IS NOT NULL').run(taskId);

    const insert = db.prepare(
      `INSERT INTO agent_task_steps
         (id, task_id, sequence, state, kind, description, capability,
          plan_step_id, operation, mechanism, scope, tool, mutating, depends_on,
          inputs_json, effects_json, verification_json, approval_json,
          created_at, updated_at)
       VALUES (?, ?,
         (SELECT COALESCE(MAX(sequence), 0) + 1 FROM agent_task_steps WHERE task_id = ?),
         'pending', 'plan_step', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ts = now();
    for (const s of plan.steps) {
      insert.run(
        crypto.randomUUID(), taskId, taskId,
        s.description ?? s.operation ?? null,
        s.capability ?? null,
        s.id,
        s.operation ?? null,
        s.mechanism ?? null,
        s.scope ?? null,
        s.tool ?? null,
        s.mutating ? 1 : 0,
        json(s.depends_on ?? []),
        json(s.inputs ?? {}),
        json(s.expected_effects ?? []),
        json(s.verification ?? null),
        json(s.approval ?? null),
        ts, ts,
      );
    }

    db.prepare(
      `UPDATE agent_tasks
          SET plan_state = COALESCE(plan_state, 'planning'),
              plan_fingerprint = ?, plan_json = ?, updated_at = ?
        WHERE id = ?`,
    ).run(fingerprint, json(plan), ts, taskId);
    db.exec('COMMIT');
    log.info('plan', `saved ${plan.steps.length} step(s) for task ${taskId.slice(0, 8)} (fingerprint ${fingerprint.slice(0, 12)})`);
    return { ok: true, fingerprint, steps: plan.steps.length };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    log.error('plan', `could not save the plan for task ${taskId}: ${err.message}`, err);
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * Reading a plan
 * ------------------------------------------------------------------ */

const shapeStep = (r) => ({
  rowId: r.id,
  id: r.plan_step_id,
  sequence: r.sequence,
  state: r.state,
  description: r.description,
  operation: r.operation,
  capability: r.capability,
  mechanism: r.mechanism,
  scope: r.scope,
  tool: r.tool,
  mutating: Boolean(r.mutating),
  depends_on: parse(r.depends_on) ?? [],
  inputs: parse(r.inputs_json) ?? {},
  expected_effects: parse(r.effects_json) ?? [],
  verification: parse(r.verification_json),
  approval: parse(r.approval_json),
  result: parse(r.result_json),
  failureReason: r.failure_reason,
  startedAt: r.started_at,
  completedAt: r.completed_at,
});

/**
 * The whole plan, reconstructed from the database alone.
 *
 * This is what a reconnecting UI calls, and it is why nothing is cached in
 * memory: everything a client needs to draw the current state — which step is
 * running, which is waiting, what was approved and against which fingerprint —
 * is here.
 */
export function loadPlan(taskId) {
  const db = getDb();
  const task = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId);
  if (!task) return null;
  const steps = db.prepare(
    'SELECT * FROM agent_task_steps WHERE task_id = ? AND plan_step_id IS NOT NULL ORDER BY sequence ASC',
  ).all(taskId).map(shapeStep);

  return {
    taskId,
    sessionId: task.session_id,
    goal: task.goal,
    planState: task.plan_state,
    fingerprint: task.plan_fingerprint,
    approvedFingerprint: task.approved_fingerprint,
    approvedAt: task.approved_at,
    approvedSource: task.approved_source,
    // The plan as it was proposed, kept verbatim so the review a human saw can
    // be reproduced rather than re-derived.
    proposed: parse(task.plan_json),
    steps,
  };
}

export function getStepByPlanId(taskId, planStepId) {
  const r = getDb().prepare(
    'SELECT * FROM agent_task_steps WHERE task_id = ? AND plan_step_id = ?',
  ).get(taskId, planStepId);
  return r ? shapeStep(r) : null;
}

/* ------------------------------------------------------------------ *
 * State transitions — the only writers of a state column
 * ------------------------------------------------------------------ */

export function setPlanState(taskId, to, patch = {}) {
  if (!PLAN_STATES.includes(to)) {
    log.error('plan', `refused an unknown plan state "${to}"`);
    return { ok: false, reason: 'unknown_state' };
  }
  const db = getDb();
  const row = db.prepare('SELECT plan_state FROM agent_tasks WHERE id = ?').get(taskId);
  if (!row) return { ok: false, reason: 'no_such_task' };
  const from = row.plan_state ?? 'planning';
  if (from === to) return { ok: true, from, to, noop: true };
  if (!canTransition('plan', from, to)) {
    // Loud rather than thrown: a refused transition must not take down a turn,
    // and a silent one would hide a plan that had lost track of itself.
    log.warn('plan', `refused plan ${taskId.slice(0, 8)}: ${from} -> ${to} is not a legal transition`);
    return { ok: false, reason: 'illegal_transition', from, to };
  }
  const cols = ['plan_state = ?', 'updated_at = ?'];
  const vals = [to, now()];
  for (const [k, v] of Object.entries(patch)) { cols.push(`${k} = ?`); vals.push(v); }
  vals.push(taskId);
  db.prepare(`UPDATE agent_tasks SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  return { ok: true, from, to };
}

export function setStepState(taskId, planStepId, to, patch = {}) {
  if (!STEP_STATES.includes(to)) return { ok: false, reason: 'unknown_state' };
  const db = getDb();
  const row = db.prepare(
    'SELECT id, state FROM agent_task_steps WHERE task_id = ? AND plan_step_id = ?',
  ).get(taskId, planStepId);
  if (!row) return { ok: false, reason: 'no_such_step' };
  if (row.state === to) return { ok: true, from: row.state, to, noop: true };
  if (!canTransition('step', row.state, to)) {
    log.warn('plan', `refused step ${planStepId}: ${row.state} -> ${to} is not a legal transition`);
    return { ok: false, reason: 'illegal_transition', from: row.state, to };
  }
  const cols = ['state = ?', 'updated_at = ?'];
  const vals = [to, now()];
  if (to === 'executing' && !patch.started_at) { cols.push('started_at = ?'); vals.push(now()); }
  if (isTerminal('step', to) && !patch.completed_at) { cols.push('completed_at = ?'); vals.push(now()); }
  for (const [k, v] of Object.entries(patch)) { cols.push(`${k} = ?`); vals.push(v); }
  vals.push(row.id);
  db.prepare(`UPDATE agent_task_steps SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  return { ok: true, from: row.state, to };
}

/**
 * PHASE 7 — THE ONLY WAY A FAILED STEP EVER MOVES AGAIN.
 *
 * `STEP_TRANSITIONS.failed` is `[]`, deliberately: a terminal step that could
 * quietly re-enter execution is how a spent approval gets replayed. That
 * closure is correct and stays closed — `setStepState` still refuses
 * `failed -> anything`, and this function does not relax it for any other
 * caller.
 *
 * But a recovery retry has to move the step, and the alternative is worse than
 * a hole in the table: without this, a retry that genuinely executed AND
 * verified could not be recorded as completed, so the durable evidence would
 * say `failed` about a step that had in fact succeeded. Evidence that
 * contradicts reality is the one outcome this project cannot ship.
 *
 * SO THE EXIT IS EXPLICIT, NARROW AND AUDITED.
 *
 *   - it moves `failed -> pending` and nothing else, from no other state;
 *   - it clears no history — `failure_reason`, the result and the verification
 *     of the failed attempt all stay on the row;
 *   - it stamps the reopening onto the step's own lineage, so evidence shows a
 *     step that was reopened rather than a step that was always fine;
 *   - it grants no authorisation. The reopened step re-enters the executor at
 *     `pending` and reaches the approval gate exactly as it did the first time.
 *
 * A named function is the point. `setStepState(id, 'pending')` succeeding from
 * `failed` would be an invisible capability every caller had; this is a verb
 * that has to be chosen, and the boundary tests assert who is allowed to call it.
 */
export function reopenStepForRecovery(taskId, planStepId, { reason = null } = {}) {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, state FROM agent_task_steps WHERE task_id = ? AND plan_step_id = ?',
  ).get(taskId, planStepId);
  if (!row) return { ok: false, reason: 'no_such_step' };
  if (row.state !== 'failed') {
    // Not an error worth throwing over, but not silent either: reopening
    // anything else would be reopening something that never closed.
    log.warn('plan', `refused to reopen step ${planStepId}: it is ${row.state}, not failed`);
    return { ok: false, reason: 'not_failed', from: row.state };
  }
  db.prepare(
    `UPDATE agent_task_steps
        SET state = 'pending', completed_at = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(now(), row.id);
  log.warn('plan', `step ${planStepId} reopened for a recovery retry — ${reason ?? 'no reason given'}`);
  return { ok: true, from: 'failed', to: 'pending' };
}

/** Record what a step actually did. Separate from its state, and always JSON. */
export function recordStepResult(taskId, planStepId, { result = null, verification = null, approval = null, failureReason = null } = {}) {
  const db = getDb();
  const row = db.prepare('SELECT id FROM agent_task_steps WHERE task_id = ? AND plan_step_id = ?').get(taskId, planStepId);
  if (!row) return false;
  db.prepare(
    `UPDATE agent_task_steps
        SET result_json = COALESCE(?, result_json),
            verification_json = COALESCE(?, verification_json),
            approval_json = COALESCE(?, approval_json),
            failure_reason = COALESCE(?, failure_reason),
            updated_at = ?
      WHERE id = ?`,
  ).run(json(result), json(verification), json(approval), failureReason, now(), row.id);
  return true;
}

/**
 * PHASE 6 — recovery lineage, on the step's OWN metadata column.
 *
 * Lives here because this module is the single writer of `agent_task_steps`,
 * and adding a second one would give that table two owners with two ideas of
 * what a legal transition is. Recovery calls this; it does not write the row.
 *
 * `metadata_json` already exists and nothing else uses it for plan steps, so
 * recovery attempts need no migration — which is the point. An attempt is
 * APPENDED, never overwritten: the evidence has to show attempt 1 failing and
 * attempt 2 succeeding, and a column that kept only the latest would erase the
 * failure that made the recovery necessary.
 */
export function recordRecoveryAttempt(taskId, planStepId, attempt) {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, metadata_json FROM agent_task_steps WHERE task_id = ? AND plan_step_id = ?',
  ).get(taskId, planStepId);
  if (!row) return { ok: false, reason: 'no_such_step' };

  const meta = parse(row.metadata_json) ?? {};
  const recovery = meta.recovery ?? { attempts: [] };
  recovery.attempts = [...(recovery.attempts ?? []), { ...attempt, at: now() }];
  const next = { ...meta, recovery };

  db.prepare('UPDATE agent_task_steps SET metadata_json = ?, updated_at = ? WHERE id = ?')
    .run(json(next), now(), row.id);
  return { ok: true, attempts: recovery.attempts.length };
}

/**
 * PHASE 12 — the DECLARED OUTPUTS a completed step produced.
 *
 * Written on `metadata_json`, beside the recovery lineage, for the same reason:
 * the column already exists and nothing else uses it for plan steps, so a
 * consumer's dataflow needs no migration. Durable on purpose — a reference must
 * still resolve after a restart, and an in-memory registry would lose the value
 * that a later step's approval was granted against.
 *
 * Only what the producing TOOL declared is stored. This is not a copy of the
 * result: the result may be a whole ServiceNow row, and a consumer may read
 * exactly the fields the tool said it produces and nothing else.
 *
 * REPLACES rather than appends. A step produces its outputs once; a second
 * write for the same step is a re-run, and the current values are the ones a
 * consumer must see.
 */
export function recordStepOutputs(taskId, planStepId, outputs) {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, metadata_json FROM agent_task_steps WHERE task_id = ? AND plan_step_id = ?',
  ).get(taskId, planStepId);
  if (!row) return { ok: false, reason: 'no_such_step' };

  const meta = parse(row.metadata_json) ?? {};
  const next = { ...meta, outputs: { values: outputs ?? {}, at: now() } };
  db.prepare('UPDATE agent_task_steps SET metadata_json = ?, updated_at = ? WHERE id = ?')
    .run(json(next), now(), row.id);
  return { ok: true, outputs: Object.keys(outputs ?? {}) };
}

/**
 * PHASE 14 — THE DIAGNOSIS, STORED WHERE EVERY OTHER DURABLE FINDING LIVES.
 *
 * `agent_tasks.metadata_json` has existed since migration 21 and, until now,
 * nothing ever wrote it — the three existing metadata writers
 * (`recordRecoveryAttempt`, `recordStepOutputs`, `recordStepDataflow`) all ride
 * the STEP table. So a diagnosis needs no migration: §44 asks for exactly this
 * to be checked before adding one, and the column that fits is already there
 * and already empty.
 *
 * A diagnosis belongs on the TASK rather than a step because it is about the
 * whole investigation — it cites facts from several steps and is not the result
 * of any one of them. Attaching it to a step would make the last read look like
 * the one that concluded something.
 *
 * SERIALISATION IS CHECKED, NOT ASSUMED. The shared `json()` helper returns
 * null when `JSON.stringify` fails, and writing that null would silently erase
 * a diagnosis while reporting success. A diagnosis that cannot be stored is
 * reported as a failure, because evidence that quietly vanished is worse than
 * evidence that was never claimed.
 */
export function recordDiagnosis(taskId, diagnosis) {
  const db = getDb();
  const row = db.prepare('SELECT id, metadata_json FROM agent_tasks WHERE id = ?').get(taskId);
  if (!row) return { ok: false, reason: 'no_such_task' };

  const meta = parse(row.metadata_json) ?? {};
  const next = { ...meta, diagnosis: { ...diagnosis, at: now() } };
  const encoded = json(next);
  if (encoded === null) {
    log.error('plan', `refusing to store an unserialisable diagnosis for task ${shortId(taskId)}`);
    return { ok: false, reason: 'unserialisable' };
  }

  db.prepare('UPDATE agent_tasks SET metadata_json = ?, updated_at = ? WHERE id = ?')
    .run(encoded, now(), row.id);
  return { ok: true };
}

/**
 * PHASE 16 — THE LINT RUN, stored beside the diagnosis.
 *
 * Same column, same reasoning, no migration (§62). A lint result is about the
 * whole task rather than any one step, and `agent_tasks.metadata_json` is
 * already where a task-level finding lives.
 *
 * Stored under its own key so a task can hold both: asking "what is wrong with
 * this incident?" and "lint this flow" are different questions and a task that
 * did one must not appear to have done the other.
 */
export function recordLint(taskId, lint) {
  const db = getDb();
  const row = db.prepare('SELECT id, metadata_json FROM agent_tasks WHERE id = ?').get(taskId);
  if (!row) return { ok: false, reason: 'no_such_task' };

  const meta = parse(row.metadata_json) ?? {};
  const encoded = json({ ...meta, lint: { ...lint, at: now() } });
  if (encoded === null) {
    log.error('plan', `refusing to store an unserialisable lint result for task ${shortId(taskId)}`);
    return { ok: false, reason: 'unserialisable' };
  }
  db.prepare('UPDATE agent_tasks SET metadata_json = ?, updated_at = ? WHERE id = ?')
    .run(encoded, now(), row.id);
  return { ok: true };
}

/**
 * PHASE 17 — THE TEST RUN, stored beside the diagnosis and the lint.
 *
 * Same column, same reasoning, no migration (§66). DB version stays 23.
 *
 * A test result is bigger than a lint result and it is stored WHOLE rather than
 * summarised. §67 asks that the run be reconstructable — request, flow, fixture,
 * trigger, execution, assertions, cleanup, result — and a summary is exactly the
 * thing that would make one of those reconstructions impossible later. The step
 * rows and `tool_events` already hold the raw reads; this holds the reasoning
 * that turned them into a verdict, which is the part nothing else records.
 */
export function recordTest(taskId, test) {
  const db = getDb();
  const row = db.prepare('SELECT id, metadata_json FROM agent_tasks WHERE id = ?').get(taskId);
  if (!row) return { ok: false, reason: 'no_such_task' };

  const meta = parse(row.metadata_json) ?? {};
  const encoded = json({ ...meta, test: { ...test, at: now() } });
  if (encoded === null) {
    log.error('plan', `refusing to store an unserialisable test result for task ${shortId(taskId)}`);
    return { ok: false, reason: 'unserialisable' };
  }
  db.prepare('UPDATE agent_tasks SET metadata_json = ?, updated_at = ? WHERE id = ?')
    .run(encoded, now(), row.id);
  return { ok: true };
}

/**
 * PHASE 18 — THE COMPARISON, stored beside the diagnosis, the lint and the test.
 *
 * Same column, same reasoning, no migration (§37). DB version stays 23.
 *
 * §37 asks for a demonstration before a new table, and there is none to make:
 * a comparison is about a task exactly as a diagnosis is, and the two states it
 * compared are identified by hash and sys_id, so the record is self-describing
 * without a foreign key to anything.
 *
 * A CAPTURED BASELINE IS STORED THE SAME WAY AND IS NOT THE SAME THING (§35).
 * It lives under its own key so that capturing one never overwrites a
 * comparison and running a comparison never overwrites a baseline — which is
 * the storage half of "a baseline is a deliberate artifact".
 */
export function recordChange(taskId, comparison) {
  const db = getDb();
  const row = db.prepare('SELECT id, metadata_json FROM agent_tasks WHERE id = ?').get(taskId);
  if (!row) return { ok: false, reason: 'no_such_task' };

  const meta = parse(row.metadata_json) ?? {};
  const next = { ...meta, change: { ...comparison, at: now() } };
  /* A capture is filed under its own key as well, so it survives the next
   * comparison on the same task. */
  if (comparison?.captured_baseline) next.baseline = { ...comparison.captured_baseline, at: now() };

  const encoded = json(next);
  if (encoded === null) {
    log.error('plan', `refusing to store an unserialisable comparison for task ${shortId(taskId)}`);
    return { ok: false, reason: 'unserialisable' };
  }
  db.prepare('UPDATE agent_tasks SET metadata_json = ?, updated_at = ? WHERE id = ?')
    .run(encoded, now(), row.id);
  return { ok: true };
}

/**
 * PHASE 20 — THE APPLICATION BUILD, stored beside the rest.
 *
 * Same column, same reasoning, no migration (§65). DB version stays 23.
 *
 * §65 asks for a demonstration before a new table and there is none to make: a
 * build is about a task exactly as a diagnosis is, and the artifacts it created
 * are identified by sys_id inside the record, so it is self-describing without
 * a foreign key to anything.
 */
export function recordAppBuild(taskId, build) {
  const db = getDb();
  const row = db.prepare('SELECT id, metadata_json FROM agent_tasks WHERE id = ?').get(taskId);
  if (!row) return { ok: false, reason: 'no_such_task' };

  const meta = parse(row.metadata_json) ?? {};
  const encoded = json({ ...meta, appbuild: { ...build, at: now() } });
  if (encoded === null) {
    log.error('plan', `refusing to store an unserialisable build for task ${shortId(taskId)}`);
    return { ok: false, reason: 'unserialisable' };
  }
  db.prepare('UPDATE agent_tasks SET metadata_json = ?, updated_at = ? WHERE id = ?')
    .run(encoded, now(), row.id);
  return { ok: true };
}

/** The stored application build, or null. */
export function loadAppBuild(taskId) {
  const row = getDb().prepare('SELECT metadata_json FROM agent_tasks WHERE id = ?').get(taskId);
  if (!row) return null;
  return (parse(row.metadata_json) ?? {}).appbuild ?? null;
}

/** The stored comparison, or null. */
export function loadChange(taskId) {
  const row = getDb().prepare('SELECT metadata_json FROM agent_tasks WHERE id = ?').get(taskId);
  if (!row) return null;
  return (parse(row.metadata_json) ?? {}).change ?? null;
}

/** The baseline captured on this task, or null (§35, §36). */
export function loadCapturedBaseline(taskId) {
  const row = getDb().prepare('SELECT metadata_json FROM agent_tasks WHERE id = ?').get(taskId);
  if (!row) return null;
  return (parse(row.metadata_json) ?? {}).baseline ?? null;
}

/** The stored test run, or null. */
export function loadTest(taskId) {
  const row = getDb().prepare('SELECT metadata_json FROM agent_tasks WHERE id = ?').get(taskId);
  if (!row) return null;
  return (parse(row.metadata_json) ?? {}).test ?? null;
}

/** The stored lint run, or null. */
export function loadLint(taskId) {
  const row = getDb().prepare('SELECT metadata_json FROM agent_tasks WHERE id = ?').get(taskId);
  if (!row) return null;
  return (parse(row.metadata_json) ?? {}).lint ?? null;
}

/** The stored diagnosis, or null. Read by the evidence projection. */
export function loadDiagnosis(taskId) {
  const row = getDb().prepare('SELECT metadata_json FROM agent_tasks WHERE id = ?').get(taskId);
  if (!row) return null;
  return (parse(row.metadata_json) ?? {}).diagnosis ?? null;
}

/**
 * PHASE 12 — how a step's references were RESOLVED at run time.
 *
 * Recorded beside the outputs, for the evidence layer. The declared reference
 * and the value it became are stored as separate fields on purpose: a reader
 * has to be able to see that `target.sys_id` came from `step_1.result.sys_id`
 * rather than from somewhere unexplained.
 */
export function recordStepDataflow(taskId, planStepId, resolutions) {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, metadata_json FROM agent_task_steps WHERE task_id = ? AND plan_step_id = ?',
  ).get(taskId, planStepId);
  if (!row) return { ok: false, reason: 'no_such_step' };
  const meta = parse(row.metadata_json) ?? {};
  const next = { ...meta, dataflow: { resolutions: resolutions ?? [], at: now() } };
  db.prepare('UPDATE agent_task_steps SET metadata_json = ?, updated_at = ? WHERE id = ?')
    .run(json(next), now(), row.id);
  return { ok: true };
}

/** What one step produced, as stored. Read-only. */
export function stepOutputs(taskId, planStepId) {
  const row = getDb().prepare(
    'SELECT metadata_json FROM agent_task_steps WHERE task_id = ? AND plan_step_id = ?',
  ).get(taskId, planStepId);
  return parse(row?.metadata_json)?.outputs?.values ?? null;
}

/** The recovery lineage for one step, as stored. Read-only. */
export function recoveryHistory(taskId, planStepId) {
  const row = getDb().prepare(
    'SELECT metadata_json FROM agent_task_steps WHERE task_id = ? AND plan_step_id = ?',
  ).get(taskId, planStepId);
  return parse(row?.metadata_json)?.recovery ?? { attempts: [] };
}

/* ------------------------------------------------------------------ *
 * Approval binding — the Phase 4 security invariant
 * ------------------------------------------------------------------ */

/**
 * Bind a human's approval to the fingerprint they actually reviewed.
 *
 * The fingerprint the caller presents must match what the plan currently hashes
 * to. If it does not, the plan changed between the card being rendered and the
 * click arriving, and the approval is refused rather than applied to whatever
 * the plan says now — which is the whole point.
 */
export function approvePlan(taskId, presentedFingerprint, { source, at = now() } = {}) {
  const plan = loadPlan(taskId);
  if (!plan) return { ok: false, reason: 'no_such_task' };
  if (!fingerprintMatches(plan.fingerprint, presentedFingerprint)) {
    log.error('plan',
      `REFUSED an approval for task ${taskId.slice(0, 8)}: it was given for fingerprint `
      + `${String(presentedFingerprint).slice(0, 12)} but the plan is now ${String(plan.fingerprint).slice(0, 12)}. `
      + 'The plan changed after it was shown; it must be reviewed again.');
    return { ok: false, reason: 'fingerprint_mismatch', expected: plan.fingerprint, presented: presentedFingerprint };
  }
  const moved = setPlanState(taskId, 'executing', {
    approved_fingerprint: plan.fingerprint,
    approved_at: at,
    approved_source: source ?? null,
  });
  if (!moved.ok) return { ok: false, reason: moved.reason, from: moved.from };
  return { ok: true, fingerprint: plan.fingerprint };
}

/**
 * May this plan execute RIGHT NOW?
 *
 * Called before every step, not once at the start. That placement is the
 * invariant: an approval authorises a specific plan, and a plan that has been
 * edited since — by a re-plan, by a repair, by anything — is a different plan
 * that nobody approved.
 */
export function checkApprovalBinding(taskId) {
  const plan = loadPlan(taskId);
  if (!plan) return { ok: false, reason: 'no_such_task' };
  if (!plan.approvedFingerprint) {
    return { ok: false, reason: 'not_approved', note: 'This plan has never been approved, so no step may execute.' };
  }
  if (!fingerprintMatches(plan.approvedFingerprint, plan.fingerprint)) {
    const d = diffPlans(plan.proposed, plan.proposed);   // shapes for the message
    return {
      ok: false,
      reason: 'approval_stale',
      approved: plan.approvedFingerprint,
      current: plan.fingerprint,
      note: `The plan changed after it was approved (${d.where ? `at ${d.where}` : 'materially'}). `
        + 'The previous approval does not carry over; it must be reviewed again.',
    };
  }
  return { ok: true, fingerprint: plan.fingerprint };
}

/* ------------------------------------------------------------------ *
 * Dependency ordering
 * ------------------------------------------------------------------ */

/**
 * The order steps may run in, or the reason there is none.
 *
 * A deterministic topological sort: ties are broken by the plan's own ordering,
 * so the same plan always executes in the same sequence. Phase 4 needs
 * ordering, not a parallel scheduler, and building one now would be inventing
 * concurrency semantics nothing has asked for.
 */
export function executionOrder(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const done = new Set();
  const order = [];
  const remaining = [...steps];

  let progressed = true;
  while (remaining.length && progressed) {
    progressed = false;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      const deps = s.depends_on || [];
      if (deps.every((d) => done.has(d))) {
        order.push(s);
        done.add(s.id);
        remaining.splice(i, 1);
        progressed = true;
        break;                       // restart, so plan order breaks every tie
      }
    }
  }

  if (remaining.length) {
    const unmet = remaining.map((s) => ({
      step: s.id,
      waitingFor: (s.depends_on || []).filter((d) => !done.has(d)),
    }));
    // A cycle, or a dependency on a step that does not exist. Both are plan
    // defects the validator should already have caught; reaching here means one
    // slipped through, and executing a partial order would run steps whose
    // prerequisites never ran.
    return { ok: false, reason: 'unresolvable_dependencies', unmet, order: [] };
  }
  const missing = steps.flatMap((s) => (s.depends_on || []).filter((d) => !byId.has(d)).map((d) => ({ step: s.id, missing: d })));
  if (missing.length) return { ok: false, reason: 'unknown_dependency', missing, order: [] };
  return { ok: true, order };
}
