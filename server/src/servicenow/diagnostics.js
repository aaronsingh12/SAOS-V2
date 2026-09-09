/**
 * PHASE 15 — THE DIAGNOSTIC EVIDENCE SURFACES, NORMALISED.
 *
 * Six read-only surfaces that let the Doctor ask "why did this happen?" instead
 * of only "what is true now": flow executions, audit history, journal entries,
 * runtime SLAs, configuration items and CI relationships.
 *
 * EVERY FIELD HERE WAS MEASURED ON A REAL INSTANCE. §6 forbids inventing Flow
 * Designer semantics, so the shapes below are built from columns confirmed to
 * exist on dev424910 by reading `sys_dictionary`, and the state vocabularies
 * come from `sys_choice` rather than from what the names suggest. Where a
 * column was not found, there is no field for it.
 *
 * NORMALISATION IS THE POINT (§30). A raw `sys_flow_context` row has 38 columns
 * including four lock fields and five JSON blobs; handing that to a diagnosis
 * would be a data dump wearing the word "evidence". What comes back from here
 * is the small set of things a person would actually cite.
 *
 * THIS MODULE MAKES NO CLAIMS. It reports what a table said. "The flow errored"
 * is a fact; "the flow failure caused the symptom" is a conclusion, and
 * conclusions are drawn in `doctor/diagnosis.js` under rules this layer knows
 * nothing about.
 *
 * TRUNCATION IS ALWAYS DECLARED (§18, §60.7). Every reader takes a limit and
 * every result says whether it hit it. A silently short list is indistinguishable
 * from a complete one, and a diagnosis built on "there were no other changes"
 * when there were fifty is worse than no diagnosis.
 */
import { table } from './client.js';

/* ------------------------------------------------------------------ *
 * Limits — platform safety, not model suggestions (§18)
 * ------------------------------------------------------------------ */

export const LIMITS = Object.freeze({
  MAX_RECORDS_PER_QUERY: 25,
  MAX_AUTOMATION_CONTEXTS: 10,
  MAX_AUDIT_ROWS: 50,
  MAX_JOURNAL_ROWS: 30,
  MAX_SLAS: 10,
  MAX_CI_RELATIONSHIPS: 25,
});

/** Clamp a caller's limit to the platform ceiling. Never raises it. */
const capped = (asked, ceiling) => {
  const n = Number.isFinite(Number(asked)) ? Math.floor(Number(asked)) : ceiling;
  return Math.max(1, Math.min(n, ceiling));
};

/** ServiceNow returns `{ display_value, value }`; keep both, prefer the id. */
const cell = (raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) {
    return { value: raw.value ?? null, display: raw.display_value ?? null };
  }
  return { value: raw ?? null, display: null };
};
const val = (raw) => cell(raw).value;
const disp = (raw) => {
  const c = cell(raw);
  return c.display || (c.value === null ? null : String(c.value));
};

/**
 * A page of rows, with truncation stated rather than hidden.
 *
 * One extra row is requested so "there are more" is OBSERVED rather than
 * guessed from a full page — a page that happens to be exactly `limit` long is
 * ambiguous, and this removes the ambiguity for the cost of one row.
 */
async function scoped(tableName, { query, fields, limit }) {
  const rows = await table.query(tableName, {
    query, fields, limit: limit + 1, display: 'all',
  });
  const truncated = rows.length > limit;
  return { rows: truncated ? rows.slice(0, limit) : rows, truncated, limit };
}

/* ------------------------------------------------------------------ *
 * 1. FLOW EXECUTION  (§5.1, §6, §7)
 * ------------------------------------------------------------------ */

/**
 * The instance's own `sys_flow_context.state` vocabulary, read from
 * `sys_choice`, and what each value means for a diagnosis.
 *
 * MEASURED, ten values: PRESUMED_INTERRUPTED, CANCELLED, PAUSED, WAITING,
 * IN_PROGRESS, PAUSED_IN_DEBUG, COMPLETE, QUEUED, ERROR, CONTINUE_SYNC.
 *
 * §7 names seven buckets and the platform has ten states, so two of them do not
 * fit. They are NOT collapsed into UNKNOWN: `IN_PROGRESS` means the execution
 * is running right now, which is a definite answer and a useful one, and
 * calling it "unknown" would be its own small dishonesty. Anything genuinely
 * unrecognised — a state a future release adds — becomes EXECUTION_UNKNOWN and
 * keeps its raw value, so the report can say "the instance said X and this
 * build does not know what X means".
 */
export const EXECUTION_STATES = Object.freeze({
  COMPLETE: 'EXECUTION_COMPLETE',
  ERROR: 'EXECUTION_ERROR',
  WAITING: 'EXECUTION_WAITING',
  QUEUED: 'EXECUTION_WAITING',
  PAUSED: 'EXECUTION_PAUSED',
  PAUSED_IN_DEBUG: 'EXECUTION_PAUSED',
  CANCELLED: 'EXECUTION_CANCELLED',
  IN_PROGRESS: 'EXECUTION_RUNNING',
  CONTINUE_SYNC: 'EXECUTION_RUNNING',
  PRESUMED_INTERRUPTED: 'EXECUTION_INTERRUPTED',
});

/** The answer when the question "did anything run?" is asked and nothing did. */
export const NO_EXECUTION = 'NO_EXECUTION_FOUND';
export const EXECUTION_UNKNOWN = 'EXECUTION_UNKNOWN';

export const classifyExecutionState = (raw) => {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return EXECUTION_UNKNOWN;
  return EXECUTION_STATES[s] ?? EXECUTION_UNKNOWN;
};

const FLOW_FIELDS = 'sys_id,name,state,error_message,error_state,execution_id,flow,'
  + 'source_table,source_record,sys_created_on,sys_updated_on,run_time,is_test_run';

/** One `sys_flow_context` row as the §6 shape. Nothing beyond what was read. */
function normalizeExecution(row) {
  return {
    sys_id: val(row.sys_id),
    execution_id: val(row.execution_id) || null,
    flow: { sys_id: val(row.flow) || null, name: disp(row.name) },
    subject: { table: val(row.source_table) || null, sys_id: val(row.source_record) || null },
    /* Both the classified bucket and what the instance literally said. A
     * reader who disagrees with the mapping can see the original. */
    state: classifyExecutionState(val(row.state)),
    raw_state: val(row.state) || null,
    started_at: val(row.sys_created_on) || null,
    /* `sys_updated_on` is when the row last changed, which for a finished
     * context is when it finished. It is reported under a name that says so
     * rather than as `ended_at`, which would claim more than the column does. */
    last_updated_at: val(row.sys_updated_on) || null,
    run_time_ms: val(row.run_time) === null ? null : Number(val(row.run_time)),
    error: val(row.error_message) || null,
    error_state: val(row.error_state) || null,
    is_test_run: val(row.is_test_run) === 'true' || val(row.is_test_run) === true,
  };
}

/**
 * Executions whose SUBJECT is this record (§19 — scoped, never instance-wide).
 *
 * Returns `found: false` with `state: NO_EXECUTION_FOUND` when there are none,
 * because §7 and §33 turn on that distinction: "no execution evidence was
 * found" is not "the automation failed", and the two must not render alike.
 */
export async function flowExecutionsFor({ table: subjectTable, sys_id: sysId, limit } = {}) {
  if (!subjectTable || !sysId) throw new Error('flowExecutionsFor requires a table and a sys_id');
  const cap = capped(limit, LIMITS.MAX_AUTOMATION_CONTEXTS);
  const { rows, truncated } = await scoped('sys_flow_context', {
    query: `source_table=${subjectTable}^source_record=${sysId}^ORDERBYDESCsys_created_on`,
    fields: FLOW_FIELDS,
    limit: cap,
  });
  const executions = rows.map(normalizeExecution);
  return {
    subject: { table: subjectTable, sys_id: sysId },
    found: executions.length > 0,
    state: executions.length ? executions[0].state : NO_EXECUTION,
    count: executions.length,
    executions,
    truncated,
    limit: cap,
  };
}

/* ------------------------------------------------------------------ *
 * PHASE 17 — WAITING FOR AN EXECUTION TO SETTLE (§19, §20)
 * ------------------------------------------------------------------ */

/**
 * Which classified states are FINISHED, and which are merely not finished yet.
 *
 * Derived from the classification above rather than from a second list of raw
 * state names, so a platform state this build does not recognise cannot be
 * silently treated as terminal. `EXECUTION_UNKNOWN` is deliberately NOT
 * terminal: a state nothing here understands is a reason to keep looking and
 * then to report what was seen, never a reason to declare the flow finished.
 */
export const TERMINAL_EXECUTION = Object.freeze([
  EXECUTION_STATES.COMPLETE, EXECUTION_STATES.ERROR,
  EXECUTION_STATES.CANCELLED, EXECUTION_STATES.PRESUMED_INTERRUPTED,
]);

export const isTerminalExecution = (state) => TERMINAL_EXECUTION.includes(state);

/** The bounds a caller may not exceed. Measured: a real flow on this instance
 *  reached COMPLETE in ~37s and ERROR in ~11s, so the default ceiling is set
 *  well above both rather than at the edge of what was observed (§65). */
export const WAIT_LIMITS = Object.freeze({
  DEFAULT_TIMEOUT_MS: 90_000,
  MAX_TIMEOUT_MS: 300_000,
  DEFAULT_POLL_MS: 3000,
  MIN_POLL_MS: 1000,
});

const sleep = (msec) => new Promise((r) => setTimeout(r, msec));

/**
 * Wait, with a bound, for an execution on this record to reach a finished state.
 *
 * THIS IS A READ THAT TAKES TIME, and nothing more. It creates nothing, changes
 * nothing and decides nothing: it polls the same `sys_flow_context` surface
 * `flowExecutionsFor` reads, and hands back what it saw plus how long it looked.
 *
 * WHY IT EXISTS RATHER THAN A LOOP IN THE CALLER. A caller that polls is a
 * caller reaching the instance outside the tool registry, which is exactly the
 * second execution path this project refuses to grow. Polling is the smallest
 * shared primitive that removes the need for one (§7), so it lives beside the
 * read it repeats and is exposed as an ordinary read-only tool.
 *
 * THREE OUTCOMES, KEPT APART, because collapsing any two of them is how a test
 * turns a non-answer into a verdict (§20, §22, §70.7, §70.8):
 *
 *   found: false           nothing ran, or nothing has been recorded yet
 *   settled: true          it finished, and `state` says how
 *   timed_out: true        it was still going when the clock ran out
 *
 * A timeout is never reported as either success or failure here. The caller is
 * told the last state observed and the elapsed time, and decides.
 */
export async function waitForFlowExecution({
  table: subjectTable, sys_id: sysId, flow_sys_id: flowSysId = null,
  timeout_ms: timeoutMs, poll_ms: pollMs, limit,
  /*
   * The three seams that make a POLLING function testable without a network,
   * a clock or a wait. `readExecutions` defaults to the real read directly
   * above, so the shipped behaviour is the same function reading the same
   * table — nothing is stubbed in production, and "did the bound hold" is
   * answerable in a unit test instead of only on an instance.
   */
  sleepFor = sleep, now = () => Date.now(), readExecutions = flowExecutionsFor,
} = {}) {
  if (!subjectTable || !sysId) throw new Error('waitForFlowExecution requires a table and a sys_id');
  const budget = Math.max(0, Math.min(
    Number.isFinite(Number(timeoutMs)) ? Math.floor(Number(timeoutMs)) : WAIT_LIMITS.DEFAULT_TIMEOUT_MS,
    WAIT_LIMITS.MAX_TIMEOUT_MS,
  ));
  const interval = Math.max(
    WAIT_LIMITS.MIN_POLL_MS,
    Number.isFinite(Number(pollMs)) ? Math.floor(Number(pollMs)) : WAIT_LIMITS.DEFAULT_POLL_MS,
  );

  const started = now();
  let polls = 0;
  let last = null;
  let others = 0;

  /*
   * BOUNDED BY CONSTRUCTION, not by a break inside an endless loop.
   *
   * The count is arithmetic on the budget and the interval, both already
   * clamped above, so the maximum number of reads this can perform is decided
   * before the first one — which is the property the audit guard (phase10 E3)
   * exists to keep. The `break` conditions below are the EARLY exits; this is
   * the ceiling, and it cannot be argued with.
   *
   * At least one iteration always runs, so a zero budget still performs exactly
   * one read: "I did not look" and "I looked and saw nothing" are different
   * answers and must not render the same.
   */
  const maxPolls = Math.max(1, Math.ceil(budget / interval) + 1);
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    polls += 1;
    const seen = await readExecutions({ table: subjectTable, sys_id: sysId, limit });
    /* When the caller named a flow, only that flow's executions answer the
     * question. Other automation on the same record is real and is reported,
     * but it is not evidence about THIS flow. */
    const mine = flowSysId
      ? seen.executions.filter((e) => e.flow?.sys_id === flowSysId)
      : seen.executions;
    last = { ...seen, executions: mine, found: mine.length > 0, count: mine.length,
      state: mine.length ? mine[0].state : NO_EXECUTION };
    others = seen.count - mine.length;

    const settled = last.found && mine.every((e) => isTerminalExecution(e.state));
    const elapsed = now() - started;
    if (settled) {
      return {
        ...last, waited_ms: elapsed, polls, settled: true, timed_out: false,
        filtered_to_flow: flowSysId, other_executions: others,
      };
    }
    if (elapsed + interval > budget) break;
    await sleepFor(interval);
  }

  /* The clock ran out, or the poll ceiling did. Either way this is a TIMEOUT
   * and never a verdict about the flow. */
  return {
    ...last, waited_ms: now() - started, polls, settled: false, timed_out: true,
    timeout_ms: budget,
    filtered_to_flow: flowSysId, other_executions: others,
  };
}

/** One execution by sys_id, normalised the same way. */
export async function flowExecution({ sys_id: sysId } = {}) {
  if (!sysId) throw new Error('flowExecution requires a sys_id');
  const rows = await table.query('sys_flow_context', {
    query: `sys_id=${sysId}`, fields: FLOW_FIELDS, limit: 1, display: 'all',
  });
  if (!rows.length) return { found: false, state: NO_EXECUTION, execution: null };
  const execution = normalizeExecution(rows[0]);
  return { found: true, state: execution.state, execution };
}

/* ------------------------------------------------------------------ *
 * 2. AUDIT  (§9)
 * ------------------------------------------------------------------ */

/**
 * Field-level change history for one record.
 *
 * MEASURED: `sys_audit` carries documentkey / tablename / fieldname / oldvalue
 * / newvalue / user / sys_created_on — exactly the six things §9 asks for, and
 * scoped by `documentkey` as §19 requires.
 *
 * A CAVEAT THAT BELONGS IN THE EVIDENCE, not in a footnote: ServiceNow only
 * audits fields configured to be audited. An empty result therefore means "no
 * audited field changed", NOT "nothing changed" — so `audited_fields_only` is
 * returned on every result and the Doctor states it as a limitation rather than
 * concluding from silence.
 */
export async function auditFor({ table: subjectTable, sys_id: sysId, limit } = {}) {
  if (!subjectTable || !sysId) throw new Error('auditFor requires a table and a sys_id');
  const cap = capped(limit, LIMITS.MAX_AUDIT_ROWS);
  const { rows, truncated } = await scoped('sys_audit', {
    query: `documentkey=${sysId}^tablename=${subjectTable}^ORDERBYDESCsys_created_on`,
    fields: 'sys_id,documentkey,tablename,fieldname,oldvalue,newvalue,user,sys_created_on',
    limit: cap,
  });
  return {
    subject: { table: subjectTable, sys_id: sysId },
    count: rows.length,
    changes: rows.map((r) => ({
      sys_id: val(r.sys_id),
      table: val(r.tablename),
      record_sys_id: val(r.documentkey),
      field: val(r.fieldname),
      old_value: val(r.oldvalue),
      new_value: val(r.newvalue),
      changed_by: disp(r.user),
      changed_at: val(r.sys_created_on),
    })),
    truncated,
    limit: cap,
    audited_fields_only: true,
  };
}

/* ------------------------------------------------------------------ *
 * 3. JOURNAL  (§11)
 * ------------------------------------------------------------------ */

/**
 * Work notes, comments and other journal entries for one record.
 *
 * MEASURED: `sys_journal_field` carries element / element_id / value /
 * sys_created_by / sys_created_on. Scoped by `element_id`.
 *
 * §11 is emphatic that journal text is an OBSERVATION and never system state.
 * The shape enforces the distinction as far as a shape can: an entry has an
 * `element` (which journal field it is) and a `value` (what somebody typed),
 * and there is nowhere to put a field name or a resolved reference. A note
 * saying "waiting for the network team" cannot become an assignment_group here,
 * because there is no assignment_group in this object.
 */
export async function journalFor({ table: subjectTable, sys_id: sysId, limit } = {}) {
  if (!sysId) throw new Error('journalFor requires a sys_id');
  const cap = capped(limit, LIMITS.MAX_JOURNAL_ROWS);
  const { rows, truncated } = await scoped('sys_journal_field', {
    query: `element_id=${sysId}^ORDERBYDESCsys_created_on`,
    fields: 'sys_id,element,element_id,name,value,sys_created_by,sys_created_on',
    limit: cap,
  });
  return {
    subject: { table: subjectTable ?? null, sys_id: sysId },
    count: rows.length,
    entries: rows.map((r) => ({
      sys_id: val(r.sys_id),
      element: val(r.element),
      value: val(r.value),
      author: val(r.sys_created_by),
      created_at: val(r.sys_created_on),
    })),
    truncated,
    limit: cap,
  };
}

/* ------------------------------------------------------------------ *
 * 4. SLA  (§12)
 * ------------------------------------------------------------------ */

/**
 * `task_sla.stage`, read from `sys_choice`: completed, achieved, breached,
 * cancelled, in_progress, paused.
 *
 * §12's vocabulary is close but not identical, so this maps the instance's
 * words to it. `achieved` and `completed` are both finished states and are
 * reported distinctly, because a breach that was later achieved is a different
 * story from one that simply ended.
 */
export const SLA_STAGES = Object.freeze({
  in_progress: 'SLA_RUNNING',
  paused: 'SLA_PAUSED',
  completed: 'SLA_COMPLETED',
  achieved: 'SLA_ACHIEVED',
  breached: 'SLA_BREACHED',
  cancelled: 'SLA_CANCELLED',
});
export const SLA_NOT_ATTACHED = 'SLA_NOT_ATTACHED';
export const SLA_UNKNOWN = 'SLA_UNKNOWN';

export const classifySlaStage = (raw) => {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return SLA_UNKNOWN;
  return SLA_STAGES[s] ?? SLA_UNKNOWN;
};

/**
 * The runtime SLAs attached to one task.
 *
 * NOTE the distinction §12 insists on and this preserves: `has_breached` is a
 * COLUMN on the row, and `stage` is a separate column. They are reported
 * separately rather than derived from each other, and neither is inferred from
 * the incident's priority — which §12 forbids and which would be the easy,
 * wrong shortcut.
 */
export async function slasFor({ task_sys_id: taskSysId, limit } = {}) {
  if (!taskSysId) throw new Error('slasFor requires a task sys_id');
  const cap = capped(limit, LIMITS.MAX_SLAS);
  const { rows, truncated } = await scoped('task_sla', {
    query: `task=${taskSysId}^ORDERBYDESCsys_created_on`,
    fields: 'sys_id,task,sla,stage,has_breached,active,start_time,end_time,'
      + 'planned_end_time,percentage,business_percentage,time_left,pause_time',
    limit: cap,
  });
  const slas = rows.map((r) => ({
    sys_id: val(r.sys_id),
    definition: { sys_id: val(r.sla), name: disp(r.sla) },
    task_sys_id: val(r.task),
    stage: classifySlaStage(val(r.stage)),
    raw_stage: val(r.stage),
    has_breached: val(r.has_breached) === 'true' || val(r.has_breached) === true,
    active: val(r.active) === 'true' || val(r.active) === true,
    start_time: val(r.start_time) || null,
    end_time: val(r.end_time) || null,
    planned_end_time: val(r.planned_end_time) || null,
    percentage: val(r.percentage) === null ? null : Number(val(r.percentage)),
    time_left: val(r.time_left) || null,
  }));
  return {
    task_sys_id: taskSysId,
    attached: slas.length > 0,
    state: slas.length ? slas[0].stage : SLA_NOT_ATTACHED,
    count: slas.length,
    slas,
    truncated,
    limit: cap,
  };
}

/* ------------------------------------------------------------------ *
 * 5. CONFIGURATION ITEM RELATIONSHIPS  (§15)
 * ------------------------------------------------------------------ */

/**
 * Direct relationships of one CI, both directions, one hop.
 *
 * ONE HOP ON PURPOSE. §15 asks for a bounded investigation and explicitly says
 * not to build a CMDB graph engine; a traversal that follows relationships
 * recursively is how a diagnosis turns into a crawl of the estate. The parent
 * and child directions are reported separately because "this depends on that"
 * and "that depends on this" are different facts.
 */
export async function ciRelationshipsFor({ sys_id: sysId, limit } = {}) {
  if (!sysId) throw new Error('ciRelationshipsFor requires a sys_id');
  const cap = capped(limit, LIMITS.MAX_CI_RELATIONSHIPS);
  const fields = 'sys_id,parent,child,type';
  const [out, inc] = await Promise.all([
    scoped('cmdb_rel_ci', { query: `parent=${sysId}`, fields, limit: cap }),
    scoped('cmdb_rel_ci', { query: `child=${sysId}`, fields, limit: cap }),
  ]);
  const shape = (r, direction) => ({
    sys_id: val(r.sys_id),
    direction,
    parent: { sys_id: val(r.parent), name: disp(r.parent) },
    child: { sys_id: val(r.child), name: disp(r.child) },
    type: disp(r.type),
  });
  return {
    ci_sys_id: sysId,
    count: out.rows.length + inc.rows.length,
    downstream: out.rows.map((r) => shape(r, 'downstream')),
    upstream: inc.rows.map((r) => shape(r, 'upstream')),
    truncated: out.truncated || inc.truncated,
    limit: cap,
  };
}
