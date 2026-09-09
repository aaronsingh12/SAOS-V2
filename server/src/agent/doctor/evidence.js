/**
 * PHASE 14 — TURNING WHAT WAS READ INTO WHAT MAY BE SAID.
 *
 * This module is the boundary the whole phase rests on. Everything upstream of
 * it is a real tool result stored in `agent_task_steps.result_json`; everything
 * downstream may only cite what this module produced. The model never crosses
 * it — it is handed facts and can reference them by id, and an id it invents
 * matches nothing.
 *
 * WHY FACTS ARE GENERATED, NOT SELECTED. It would be simpler to ask the model
 * which observations matter and mint facts from its answer. That would put the
 * model on the authoring side of the fact boundary, which is exactly the
 * failure this phase is built to prevent: a "fact" would then be a sentence
 * something plausible-sounding chose to write. So facts are produced
 * MECHANICALLY from the result — every readable field becomes one, whether or
 * not anybody finds it interesting — and the model's only power is to cite
 * them. Selection happens later, in the narrative, and selection cannot invent.
 *
 * NO I/O HERE. The durable rows are read by the caller and passed in. This
 * module opens no database, calls no tool and reaches no instance, which is
 * what makes it testable against fixtures that are literally recorded
 * ServiceNow payloads.
 */
import { CLAIM_TYPES, isFact, isProvenance } from './schemas.js';
import { SECRET_KEYS } from '../evidence/redact.js';

/**
 * ServiceNow returns a field as `{ display_value, value }` when asked for both.
 * The stored identity is `value`; `display_value` is what a person reads.
 * Both are kept — a diagnosis that can only say `62826bf0…` is not an
 * explanation, and one that can only say "Abel Tuter" cannot be verified.
 */
function cell(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) {
    return { value: raw.value, display: raw.display_value ?? null };
  }
  if (raw === null || raw === undefined) return { value: null, display: null };
  if (typeof raw === 'object') return null;            // nested structure, not a field
  return { value: raw, display: null };
}

/**
 * Is this field one whose VALUE must never be written down?
 *
 * FOUND BY A TEST, and it is a hole the existing redactor cannot close on its
 * own. `redact` works on KEYS: it replaces `{ password: 'hunter2' }` with
 * `{ password: '[redacted]' }`. But a fact's statement is prose —
 *
 *     "sys_user X has password = hunter2."
 *
 * — and a key-based redactor scanning that object sees `statement`, which is
 * not a secret key, and passes the sentence through intact. The secret escapes
 * inside a string that was built by this module.
 *
 * The fix belongs HERE rather than in the redactor, because the right answer is
 * not to mask the sentence afterwards but never to compose it. A password is
 * not diagnostic evidence; no conclusion about why an incident is unassigned
 * needs one. So a secret-bearing field produces no fact and no observation at
 * all, and there is nothing downstream to leak.
 *
 * THE VOCABULARY IS THE EXISTING ONE. `SECRET_KEYS` is imported from the
 * redactor rather than restated, so a key added there is covered here too and
 * §52's "do not create a Doctor-specific redactor" holds — this is not a second
 * redactor, it is the same list used to decline to write.
 */
const SECRET = new Set(SECRET_KEYS.map((k) => k.toLowerCase()));
function isSecretField(field) {
  const f = String(field ?? '').toLowerCase();
  if (SECRET.has(f)) return true;
  // `sys_user.user_password`, `x_app_api_token` — a secret key appearing as a
  // component of a longer column name is still a secret column.
  return SECRET_KEYS.some((k) => f.includes(k.toLowerCase()));
}

/** Is this result a single record, a list of them, or something else? */
function shapeOf(result) {
  if (Array.isArray(result)) return 'list';
  if (result && typeof result === 'object') return 'record';
  return 'other';
}

/**
 * A stable, collision-free id for one observation.
 *
 * Deterministic on purpose: the same investigation replayed from the same
 * durable rows produces the same fact ids, so a stored diagnosis still
 * resolves its own citations weeks later. A counter would not survive that.
 */
const factId = (stepId, field, index) =>
  `fact_${stepId}_${field}${index === null || index === undefined ? '' : `_${index}`}`;

/**
 * Render the observation as the sentence a person reads.
 *
 * Kept boring deliberately. This string is the one part of a FACT that looks
 * like prose, and every temptation to make it more explanatory is a temptation
 * to put interpretation inside a fact. `display` is included when ServiceNow
 * gave one, because "assignment_group is 287ebd7d…" is technically true and
 * practically useless.
 */
function statementFor({ table, recordLabel, field, value, display }) {
  const subject = recordLabel ? `${table} ${recordLabel}` : table;
  if (value === null || value === '') return `${subject} has no ${field}.`;
  const shown = display && display !== String(value) ? `${display} (${value})` : String(value);
  return `${subject} has ${field} = ${shown}.`;
}

/**
 * What identifies the record a result came from, for a human.
 *
 * `number` where a task-like record has one, else the sys_id. Never invented:
 * if the result carries neither, the label is null and statements name the
 * table alone rather than pretending to identify a row.
 */
function labelOf(record) {
  const num = cell(record?.number);
  if (num?.value) return String(num.value);
  const sid = cell(record?.sys_id);
  return sid?.value ? String(sid.value) : null;
}

/**
 * Which table did this step read?
 *
 * Taken from the step's own INPUTS — the canonical, approved, fingerprinted
 * arguments — rather than guessed from the result's shape. A result does not
 * say which table it came from, and inferring it from field names is the kind
 * of confident guess this phase exists to refuse.
 */
function tableOf(step) {
  const t = step?.inputs?.table;
  return typeof t === 'string' && t ? t : null;
}

/**
 * Every field of every record this step read, as a FACT.
 *
 * @param {object} step  a durable step row: { id, tool, inputs, result, state }
 * @returns {Array} facts, each carrying provenance back to this step
 */
/**
 * PHASE 15 — FACTS FROM THE DIAGNOSTIC SURFACES.
 *
 * The generic extractor below turns every field of a record into a fact, which
 * is right for a record and wrong for a normalised diagnostic result. A
 * `find_flow_executions` result is an ENVELOPE — `found`, `count`, `state`,
 * `truncated` — wrapping the thing that actually matters, which is the list of
 * executions and, in particular, the error message on the one that failed.
 * Running the generic path over it would produce "record has count = 1" and
 * silently drop "the automation failed with: Failed to initialize flow
 * context", losing precisely the evidence the phase exists to collect.
 *
 * So each surface declares what is worth observing about it. The facts still
 * come only from tool output, still carry provenance, and are still generated
 * mechanically — the model chooses none of this. What changes is that the shape
 * being read is known, so the observation can be the meaningful one.
 *
 * `causal` MARKS EVENT EVIDENCE. A fact is causal when it records something
 * that HAPPENED — a change, an execution, a breach — rather than something that
 * IS. The distinction is load-bearing for §25 and §28: current state cannot
 * explain current state, so only causal facts can raise a hypothesis to a root
 * cause. It is set here, from the surface the fact came from, and never by the
 * analyst.
 */
const DIAGNOSTIC_EXTRACTORS = {
  find_flow_executions: (r, ctx) => {
    const out = [];
    if (!r.found) {
      /*
       * THE MOST IMPORTANT FACT IN THE PHASE (§7, §33). "Nothing ran" has to be
       * an observation with provenance, because the alternative — no fact at
       * all — leaves a silence that reads as "the automation failed".
       */
      out.push(ctx.fact({
        id: 'no_execution', field: 'flow_execution', value: 'NO_EXECUTION_FOUND',
        statement: `No automation execution was found with ${ctx.subject} as its subject. `
          + 'That is an absence of evidence, not evidence of failure.',
        causal: false,
      }));
      return out;
    }
    out.push(ctx.fact({
      id: 'execution_count', field: 'flow_execution_count', value: r.count,
      statement: `${r.count} automation execution(s) ran with ${ctx.subject} as the subject.`,
      causal: true,
    }));
    for (const x of r.executions ?? []) {
      const name = x.flow?.name ?? 'an automation';
      out.push(ctx.fact({
        id: `${x.sys_id}_state`, field: 'flow_execution_state', value: x.state,
        statement: `Automation "${name}" ran on ${ctx.subject} and is in state ${x.state}`
          + `${x.started_at ? ` (started ${x.started_at})` : ''}.`,
        causal: true,
        sysId: x.sys_id,
      }));
      if (x.error) {
        out.push(ctx.fact({
          id: `${x.sys_id}_error`, field: 'flow_execution_error', value: x.error,
          statement: `Automation "${name}" reported the error: ${x.error}`,
          causal: true,
          sysId: x.sys_id,
        }));
      }
    }
    return out;
  },

  get_flow_execution: (r, ctx) => {
    if (!r.found || !r.execution) {
      return [ctx.fact({
        id: 'no_execution', field: 'flow_execution', value: 'NO_EXECUTION_FOUND',
        statement: 'The requested automation execution was not found.',
        causal: false,
      })];
    }
    const x = r.execution;
    const name = x.flow?.name ?? 'an automation';
    const out = [ctx.fact({
      id: `${x.sys_id}_state`, field: 'flow_execution_state', value: x.state,
      statement: `Automation "${name}" is in state ${x.state}.`,
      causal: true, sysId: x.sys_id,
    })];
    if (x.error) {
      out.push(ctx.fact({
        id: `${x.sys_id}_error`, field: 'flow_execution_error', value: x.error,
        statement: `Automation "${name}" reported the error: ${x.error}`,
        causal: true, sysId: x.sys_id,
      }));
    }
    return out;
  },

  get_record_audit: (r, ctx) => {
    const out = [];
    if (!r.count) {
      out.push(ctx.fact({
        id: 'no_audit', field: 'audited_changes', value: 0,
        statement: `No audited field change is recorded for ${ctx.subject}. `
          + 'ServiceNow audits only fields configured for auditing, so this does not mean nothing changed.',
        causal: false,
      }));
      return out;
    }
    for (const c of r.changes ?? []) {
      out.push(ctx.fact({
        id: c.sys_id, field: `changed_${c.field}`, value: c.new_value,
        statement: `${c.field} changed from "${c.old_value ?? ''}" to "${c.new_value ?? ''}" `
          + `at ${c.changed_at} by ${c.changed_by}.`,
        causal: true, sysId: c.sys_id,
      }));
    }
    return out;
  },

  get_record_journal: (r, ctx) => (r.count
    ? (r.entries ?? []).map((e) => ctx.fact({
      id: e.sys_id, field: `journal_${e.element}`, value: e.value,
      /*
       * Phrased as authorship, never as state (§11). "A work note says X" is
       * true; "X" is what somebody believed. The sentence keeps the attribution
       * attached so an inference drawn from it has to carry it too.
       */
      statement: `${e.author} wrote in ${e.element} at ${e.created_at}: "${e.value}"`,
      causal: false, sysId: e.sys_id,
    }))
    : [ctx.fact({
      id: 'no_journal', field: 'journal_entries', value: 0,
      statement: `No journal entry is recorded on ${ctx.subject}.`,
      causal: false,
    })]),

  get_record_slas: (r, ctx) => {
    if (!r.attached) {
      return [ctx.fact({
        id: 'no_sla', field: 'sla', value: 'SLA_NOT_ATTACHED',
        statement: `No SLA is attached to ${ctx.subject}.`,
        causal: false,
      })];
    }
    return (r.slas ?? []).flatMap((s) => {
      const name = s.definition?.name ?? 'an SLA';
      const facts = [ctx.fact({
        id: `${s.sys_id}_stage`, field: 'sla_stage', value: s.stage,
        statement: `SLA "${name}" on ${ctx.subject} is ${s.stage}`
          + `${s.start_time ? ` (started ${s.start_time})` : ''}.`,
        causal: false, sysId: s.sys_id,
      })];
      if (s.has_breached) {
        facts.push(ctx.fact({
          id: `${s.sys_id}_breach`, field: 'sla_breached', value: true,
          statement: `SLA "${name}" on ${ctx.subject} has breached.`,
          causal: true, sysId: s.sys_id,
        }));
      }
      return facts;
    });
  },

  get_ci_relationships: (r, ctx) => [ctx.fact({
    id: 'ci_relationships', field: 'ci_relationship_count', value: r.count,
    statement: `The configuration item has ${r.count} direct relationship(s): `
      + `${r.downstream?.length ?? 0} downstream, ${r.upstream?.length ?? 0} upstream.`,
    causal: false,
  })],
};

/**
 * Facts from one diagnostic surface, or null if this tool is not one.
 *
 * Truncation becomes a fact of its own wherever it happened, because §60.7
 * makes silent truncation a release blocker and a limitation nobody can see is
 * a limitation nobody accounts for.
 */
function diagnosticFactsFor(step) {
  const extract = DIAGNOSTIC_EXTRACTORS[step.tool];
  if (!extract) return null;
  const result = step.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];

  const table = tableOf(step) ?? result?.subject?.table ?? null;
  const subjectId = result?.subject?.sys_id ?? result?.task_sys_id ?? result?.ci_sys_id
    ?? step.inputs?.sys_id ?? step.inputs?.task_sys_id ?? null;
  const subject = table && subjectId
    ? `${table} ${String(subjectId).slice(0, 12)}`
    : (table ?? 'the record');

  const ctx = {
    subject,
    fact: ({ id, field, value, statement, causal, sysId = null }) => ({
      id: `fact_${step.id}_${id}`,
      type: CLAIM_TYPES.FACT,
      statement,
      field,
      value,
      display: null,
      causal: Boolean(causal),
      /*
       * WHICH RECORD THIS IS ABOUT, which is not always the row it came FROM.
       * A flow-execution fact is provenanced to the `sys_flow_context` row —
       * that is where it was read — but what it is ABOUT is the execution's
       * subject. §8 relevance needs the second: "did this failure act on the
       * record that has the symptom?" cannot be answered from provenance alone.
       */
      about: subjectId,
      source: {
        step: step.id,
        tool: step.tool,
        table,
        sys_id: sysId ?? subjectId,
      },
    }),
  };

  const facts = extract(result, ctx).filter(Boolean);

  if (result.truncated) {
    facts.push(ctx.fact({
      id: 'truncated', field: 'evidence_truncated', value: result.limit ?? true,
      statement: `This read hit its platform limit of ${result.limit} row(s), so the evidence `
        + 'from it is incomplete. Anything absent from it may exist and simply not have been read.',
      causal: false,
    }));
  }

  return facts;
}

export function factsFromStep(step) {
  if (!step || !step.id || !step.tool) return [];
  if (step.state && step.state !== 'completed') return [];   // an unfinished read observed nothing

  /* A normalised diagnostic surface declares its own observations. */
  const diagnostic = diagnosticFactsFor(step);
  if (diagnostic) return diagnostic;

  const table = tableOf(step);
  const shape = shapeOf(step.result);
  if (shape === 'other') return [];

  /*
   * A LIST RESULT IS NOT A RECORD, and flattening one into facts about "the
   * incident" would silently promote the first row to the answer — the same
   * defect Phase 13 found in `lookup_reference`'s browse mode. Facts from a
   * list are addressed by row index, so a citation has to say WHICH row, and a
   * single-row list is the only case where that index is unambiguous.
   */
  const records = shape === 'list' ? step.result : [step.result];
  const indexed = shape === 'list' && records.length !== 1;

  const facts = [];
  records.forEach((record, row) => {
    if (!record || typeof record !== 'object') return;
    const recordLabel = labelOf(record);
    const sysId = cell(record.sys_id)?.value ?? null;

    for (const [field, raw] of Object.entries(record)) {
      if (isSecretField(field)) continue;             // never composed, so never leaked
      const c = cell(raw);
      if (c === null) continue;                       // nested/structural, not an observation
      const id = factId(step.id, field, indexed ? row : null);
      facts.push({
        id,
        type: CLAIM_TYPES.FACT,
        /* A field read off a record is STATE. Only the diagnostic surfaces
         * above observe events, and only events can explain a state. */
        causal: false,
        statement: statementFor({ table: table ?? 'record', recordLabel, field, value: c.value, display: c.display }),
        field,
        value: c.value,
        display: c.display,
        source: {
          step: step.id,
          tool: step.tool,
          table,
          sys_id: sysId,
          ...(indexed ? { row } : {}),
        },
      });
    }
  });

  return facts;
}

/**
 * Facts from a whole investigation.
 *
 * Order follows execution order, so fact ids read in the sequence a person
 * would have gathered them.
 */
export function factsFrom(steps = []) {
  const out = [];
  for (const step of steps) out.push(...factsFromStep(step));
  return out;
}

/**
 * Index facts by id, refusing anything that is not one.
 *
 * THE GATE. Nothing reaches the index without passing `isFact`, which requires
 * structural provenance. A caller that hands in a model-authored object gets an
 * exception rather than a fact set with a lie in it — failing loudly here is
 * cheaper than discovering it in a diagnosis.
 */
export function indexFacts(facts = []) {
  const byId = new Map();
  for (const f of facts) {
    if (!isFact(f)) {
      throw new Error(
        `refusing to index a non-fact: ${JSON.stringify(f)?.slice(0, 200)} — `
        + 'a FACT must carry { id, statement, field, value, source:{ step, tool } }. '
        + 'Model prose has no step and no tool and cannot become a fact.',
      );
    }
    byId.set(f.id, f);
  }
  return byId;
}

/**
 * Keep only the citations that name a fact that exists.
 *
 * Returns the surviving ids and the invented ones separately, because the
 * invented ones are a measurement: §38 makes the unsupported-claim rate the
 * headline metric, and it can only be counted if fabricated citations are
 * recorded rather than quietly dropped.
 */
export function checkCitations(ids = [], byId) {
  const kept = [];
  const invented = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id === 'string' && byId.has(id)) kept.push(id);
    else invented.push(id);
  }
  return { kept, invented };
}

/**
 * The observations a diagnosis is actually about.
 *
 * §16 asks for normalisation rather than raw tool output poured into a prompt.
 * This is that: one row per record read, with its fields already unwrapped, so
 * both the analyzer and the stored evidence see the same normalised view.
 */
export function observationsFrom(steps = []) {
  const out = [];
  for (const step of steps) {
    if (!step?.id || !step.tool) continue;
    if (step.state && step.state !== 'completed') continue;
    const shape = shapeOf(step.result);
    if (shape === 'other') continue;
    const table = tableOf(step);
    const records = shape === 'list' ? step.result : [step.result];
    out.push({
      source: step.id,
      tool: step.tool,
      kind: shape === 'list' ? 'list' : 'record',
      table,
      count: records.length,
      records: records.filter((r) => r && typeof r === 'object').map((record) => {
        const fields = {};
        for (const [field, raw] of Object.entries(record)) {
          if (isSecretField(field)) continue;
          const c = cell(raw);
          if (c === null) continue;
          fields[field] = c.display && c.display !== String(c.value)
            ? { value: c.value, display: c.display }
            : { value: c.value };
        }
        return { record: labelOf(record), sys_id: cell(record.sys_id)?.value ?? null, fields };
      }),
    });
  }
  return out;
}

/**
 * Which planned reads produced nothing, and why.
 *
 * A step that failed or never ran is not silence — it is a hole in the
 * evidence with a name, and §10 requires those to be first-class rather than
 * absent. Producing them here means the diagnosis cannot accidentally treat an
 * unattempted read as a negative finding.
 */
export function gapsFrom(steps = []) {
  const out = [];
  for (const step of steps) {
    if (!step?.id) continue;
    if (step.state === 'completed') continue;
    out.push({
      step: step.id,
      tool: step.tool ?? null,
      state: step.state ?? 'unknown',
      reason: step.failureReason
        ?? (step.state === 'pending' || step.state === 'ready'
          ? 'the investigation ended before this read ran'
          : `the read did not complete (${step.state ?? 'unknown'})`),
    });
  }
  return out;
}

export { isFact, isProvenance, isSecretField };
