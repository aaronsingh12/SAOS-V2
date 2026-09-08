/**
 * PHASE 14 — DECIDING WHAT TO LOOK AT, AND PROVING IT ONLY LOOKS.
 *
 * This module turns "what is wrong with INC0010038?" into a plan in the
 * EXISTING plan representation, and then refuses that plan if any step would
 * write. It is not a second planner: it calls `generatePlan`, which calls the
 * one model seam and the one validator, and its whole contribution is the goal
 * text and the `readOnly` flag.
 *
 * WHY THE GOAL IS REWRITTEN AT ALL. `generatePlan` plans a TASK. "Why is this
 * incident not assigned?" is not a task — it is a question, and a planner given
 * a question tends to answer it by fixing it. The investigation goal states the
 * work as reads, which is the only thing a diagnose-mode plan is allowed to
 * contain anyway. The `readOnly` gate is what makes it true; this only makes it
 * likely, which is the correct division: the prompt influences, the platform
 * decides.
 *
 * WHAT THIS MODULE MAY NOT DO. It performs no I/O, opens no database, and
 * calls no tool. `generate` and `validate` arrive as injected functions so the
 * whole thing is testable against a fake planner, and so that there is
 * visibly no second path to the instance.
 */
import { MODES, STOP_REASONS } from './schemas.js';

/**
 * The subject of an investigation, as far as anything can be sure of it.
 *
 * `identifier` is what the user typed. It is NOT resolved here — resolving a
 * record is a read, reads happen in the plan, and a module that resolved
 * identities on the side would be the second ServiceNow path this phase is
 * forbidden to build.
 */
export function subjectOf({ type = 'incident', identifier = null } = {}) {
  return { type, identifier: identifier ? String(identifier).trim() : null };
}

/**
 * The fields a Phase 14 investigation of an incident is about.
 *
 * §27 scopes this phase to incidents and names these. They are listed here so
 * the investigation goal can be specific about what to read — a planner told
 * "investigate the incident" reads one record and stops, and a diagnosis built
 * on one record cannot distinguish "the group is wrong" from "there is no
 * group".
 */
export const INCIDENT_FIELDS = Object.freeze([
  'number', 'short_description', 'state', 'priority', 'impact', 'urgency',
  'assignment_group', 'assigned_to', 'caller_id', 'cmdb_ci',
  'opened_at', 'sys_created_on', 'sys_updated_on', 'active',
]);

/**
 * Turn a question into an investigation goal.
 *
 * Deliberately imperative and deliberately read-shaped. The symptom is carried
 * verbatim so the plan is about the thing that was actually asked, and the
 * closing sentence states the constraint the validator will enforce — a model
 * that is told the rule it will be judged by writes fewer plans that get
 * refused, which was the measured lesson of Phase 13.
 */
export function investigationGoal({ subject, symptom }) {
  const who = subject?.identifier
    ? `${subject.type} ${subject.identifier}`
    : `the ${subject?.type ?? 'record'}`;
  const complaint = symptom?.statement ? ` The reported problem is: ${symptom.statement}.` : '';
  return (
    `Investigate ${who} by READING it and the records it refers to.${complaint} `
    + `Read the ${subject?.type ?? 'record'} itself FIRST, fetching its fields, then follow its `
    + 'references — assignment_group, assigned_to, caller_id and cmdb_ci — reading each referenced '
    + 'record that exists. '
    /*
     * THE REFERENCE FORM, SHOWN RATHER THAN DESCRIBED.
     *
     * Measured over repeated planning attempts, the two ways this goal failed
     * were a NESTED reference (`step_1.result.caller.sys_id`, which is the
     * shape the specification's own examples use and which Phase 12's grammar
     * refuses) and a record NUMBER written into a sys_id slot. Both are cases
     * of the model not knowing the exact form, which Phase 13 established is
     * fixed by showing it rather than by describing it.
     */
    + 'Carry each sys_id forward with a reference of exactly this form: '
    + '{ "$ref": "step_1.result.caller_id" } — one step id, then ".result.", then ONE output name. '
    + 'Nested paths like "step_1.result.caller.sys_id" are not valid and will be refused. '
    + 'Never write a record number where a sys_id belongs; read the record first and reference '
    + 'the sys_id it produced. '
    /*
     * PHASE 15 — the causal surfaces, and the ORDER to reach for them (§17).
     *
     * Stated as a progression rather than a list because a planner given six
     * equal options reads all six every time, which §17 exists to prevent. The
     * SLA hop is spelled out because it is not guessable: measured on this
     * instance, an incident has no flow executions of its own and its
     * automation is attached to its task_sla rows.
     */
    + 'To explain WHY the record is in this state, and only as far as the question needs: '
    + 'get_record_audit shows which fields changed, from what, to what and by whom; '
    + 'get_record_journal shows what people wrote; '
    + 'get_record_slas shows the live SLA clocks; '
    + 'find_flow_executions shows what automation ran on a record — note that an incident '
    + 'usually has none of its own, and its automation is attached to its task_sla rows, so '
    + 'pass { "$ref": "<sla step>.result.sla_sys_id" } with table "task_sla" to find it; '
    + 'get_flow_execution reads one execution, including its error. '
    + `Use at most ${BUDGET.MAX_INVESTIGATION_STEPS} steps in total, and read only what the `
    + 'question needs — an investigation that reads everything is not more thorough. '
    + 'Every step must be a READ. Do not update, create or delete anything: this is a diagnosis, '
    + 'and a plan containing any mutating step will be refused.'
  );
}

/**
 * Plan the investigation.
 *
 * @param {object} opts
 *   subject, symptom          what is being investigated
 *   generate                  the injected `generatePlan`
 *   signal                    cancellation, unchanged from Phase 0
 *
 * The returned shape mirrors `generatePlan`'s so a caller handles one contract.
 * `readOnly: true` is passed through to the validator, which is where the
 * guarantee actually lives.
 */
export async function planInvestigation({ subject, symptom, generate, signal = null } = {}) {
  if (typeof generate !== 'function') throw new Error('planInvestigation requires an injected generate()');
  const goal = investigationGoal({ subject, symptom });
  /*
   * A causal investigation is a bigger plan than a remediation, so it needs a
   * bigger answer. Measured: at the default budget the model's JSON was being
   * truncated mid-object and arriving as `unparseable` on every attempt.
   */
  const generated = await generate({
    goal, signal, validateOpts: { readOnly: true }, maxTokens: 6000,
  });
  return { ...generated, goal };
}

/**
 * The last gate, immediately before execution.
 *
 * §32 wants the refusal enforced by platform code before a mutation can run,
 * and §55.1 makes a diagnose-mode mutation a release blocker. The validator
 * already refuses such a plan — but `savePlan` does not call the validator, so
 * a plan could in principle reach the executor without having been through it.
 * This closes that door by checking the STORED plan, the one that will actually
 * run, against the same registry predicate.
 *
 * It throws rather than returning a flag. A caller that forgot to check would
 * otherwise proceed, and "the guard returned false and nobody looked" is how
 * guards fail.
 */
export function assertReadOnly(plan, { violations }) {
  const found = violations(plan);
  if (found.length) {
    const err = new Error(
      `refusing to execute a diagnosis containing ${found.length} mutating step(s): `
      + found.map((v) => `${v.step} (${v.tool}: ${v.reason})`).join(', '),
    );
    err.code = STOP_REASONS.MUTATION_IN_DIAGNOSE;
    err.violations = found;
    throw err;
  }
  return true;
}

/**
 * Which mode did this request ask for?
 *
 * Diagnose is the default and the safe one. Remediation is only entered when
 * the caller says so explicitly — never inferred from the model deciding a fix
 * would be helpful, which is precisely the inference §19 forbids.
 */
export function modeOf({ remediate = false } = {}) {
  return remediate ? MODES.REMEDIATE : MODES.DIAGNOSE;
}

/**
 * PHASE 15 — THE INVESTIGATION BUDGET (§18).
 *
 * PLATFORM LIMITS, NOT MODEL SUGGESTIONS. A diagnosis that follows every
 * reference, reads every audit row and walks every CI relationship is not more
 * thorough, it is slower and noisier — and on a busy record it is an
 * instance-wide load nobody asked for. These are ceilings the model cannot
 * raise by asking.
 *
 * THE ROW LIMITS LIVE WITH THE READERS (`servicenow/diagnostics.js`), because
 * that is where a query is issued and where truncation is observed. What lives
 * here is the one budget that is a property of the PLAN rather than of any
 * single read: how many steps an investigation may contain.
 *
 * EXHAUSTION IS REPORTED, NEVER ABSORBED (§60.7). A truncated read does not
 * quietly return a short list; it returns a short list plus the fact that it is
 * short, and the diagnosis carries that forward as a limitation. "There were no
 * other changes" and "I stopped looking after fifty" are different findings and
 * a reader must be able to tell which one they were given.
 */
export const BUDGET = Object.freeze({
  MAX_INVESTIGATION_STEPS: 12,
});

export const BUDGET_EXHAUSTED = 'INVESTIGATION_BUDGET_EXHAUSTED';

/**
 * Is this plan within the step budget?
 *
 * Checked BEFORE execution, so an over-long investigation is refused rather
 * than run and then cut short — a plan halted halfway has done partial work of
 * an unknown shape, while a plan refused has done none.
 */
export function checkStepBudget(plan, { max = BUDGET.MAX_INVESTIGATION_STEPS } = {}) {
  const steps = plan?.steps?.length ?? 0;
  if (steps <= max) return { ok: true, steps, max };
  return {
    ok: false,
    steps,
    max,
    reason: BUDGET_EXHAUSTED,
    note: `The investigation plan has ${steps} steps and the platform limit is ${max}. `
      + 'A diagnosis is a bounded look at one record, not a survey of the instance.',
  };
}

/**
 * Which reads came back incomplete, from the durable step results.
 *
 * Every diagnostic reader returns `truncated` and the `limit` it hit, so this
 * needs no knowledge of the individual shapes — it asks each result whether it
 * was cut short. What it returns becomes UNKNOWNs on the diagnosis, which is
 * how a limit reached becomes a limitation stated.
 */
export function truncatedReads(steps = []) {
  const out = [];
  for (const step of steps) {
    if (step?.state !== 'completed') continue;
    const r = step.result;
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    if (r.truncated) {
      out.push({
        step: step.id,
        tool: step.tool,
        limit: r.limit ?? null,
        reason: BUDGET_EXHAUSTED,
      });
    }
  }
  return out;
}
