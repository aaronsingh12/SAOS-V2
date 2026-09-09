import { toolMap } from '../tools.js';
import { SEMANTIC_TYPES } from '../../servicenow/semantic/tables.js';

/**
 * PHASE 12 — STEP-TO-STEP DATAFLOW.
 *
 * THE PROBLEM. `depends_on` says step 2 runs after step 1. It does not say step
 * 2 USES something step 1 produced. So a model asked to "update INC0010001"
 * plans the right two steps and then has nowhere to put the idea "the sys_id
 * from the read" — and invents somewhere. Measured against
 * gpt-oss:120b-cloud, it invented three different syntaxes in three runs:
 *
 *     "${step_1.output.sys_id}"
 *     "${read_incident.sys_id}"
 *     "<from step_1>"
 *
 * None of them is a mechanism. Each is a string that would reach the tool
 * verbatim.
 *
 * A REFERENCE IS DATA, NOT CODE. The representation is a one-key object:
 *
 *     { "$ref": "step_1.result.sys_id" }
 *
 * There is no expression language here and there will not be one. Nothing in
 * this file evaluates, interpolates, or executes anything: it parses a fixed
 * grammar, checks a graph, and looks up a value in an object. A reference that
 * does not parse is refused; a reference to something that does not exist is
 * refused; a value that cannot be found at runtime STOPS the step. There is no
 * branch anywhere that substitutes null, an empty string, "the current record",
 * or a guess.
 *
 * WHY THE PRODUCER MUST DECLARE ITS OUTPUTS. Letting step 2 reach into whatever
 * step 1 happened to return would make the plan's meaning depend on an
 * instance's response shape — and `query_records` returns raw ServiceNow rows
 * where every field is a `{ display_value, value }` cell, so `.sys_id` is an
 * object, not an id. A declared output says both WHAT may be referenced and HOW
 * to read it, so the same plan means the same thing on every instance.
 *
 * WHAT THIS MODULE IS NOT. It is not an execution path. It hands resolved
 * arguments to the existing executor and nothing else; it imports no ServiceNow
 * client, no provider, no approval mechanism, no recovery, and no database.
 */

/* ------------------------------------------------------------------ *
 * The grammar
 * ------------------------------------------------------------------ */

/** The single key that marks a value as a reference rather than a literal. */
export const REF_KEY = '$ref';

/**
 * `<stepId>.result.<output>` and nothing else.
 *
 * `result` is spelled out rather than implied so a reference reads as a
 * sentence: the OUTPUT of a STEP. The step id is the plan's own id — models
 * name steps `read_incident` as often as `step_1`, and requiring a `step_`
 * prefix would reject the more readable of the two for no safety gain. What
 * matters is that the id exists in this plan, which the graph check enforces.
 *
 * Deliberately no brackets, no quotes, no wildcards, no nesting, no traversal.
 * Every rejected example in the specification fails this expression.
 */
const REF_GRAMMAR = /^([A-Za-z][A-Za-z0-9_]*)\.result\.([A-Za-z][A-Za-z0-9_]*)$/;

/**
 * Strings that are TRYING to be a reference without being one.
 *
 * A plan carrying `"${step_1.sys_id}"` has expressed an intent the system must
 * not silently treat as a literal — it would reach the tool as that text.
 * Refusing it names the mistake instead of executing it. This is a rejection
 * rule, never a repair: nothing here rewrites the value into a reference.
 *
 * ── SESSION 2b — SHARPENED, AND WHY THAT IS NOT A WEAKENING ────────────────
 *
 * This was `/\$\{|\{\{|^<\s*from\b|\breferenc|\.result\.|\.output\.|^step_\d+\./i`
 * and it ran against EVERY string in `inputs` and `target`, at any depth. Two
 * of those alternatives matched as substrings of ordinary prose:
 *
 *   \breferenc   fires on "reference", "references", "referenced"
 *   \.result\.   fires anywhere inside a sentence
 *
 * `create_flow_live` takes a free-text `description` of an automation. A
 * request that says "look up the group the incident references" or "add a
 * reference field" therefore produced `malformed_reference` and the whole plan
 * was refused — for prose that was never trying to be a reference at all. That
 * class was measured in the six real-model planner samples.
 *
 * The rule is now SHAPE-based rather than word-based: a string is an attempted
 * reference when it carries an interpolation marker, is a "<from …>"
 * placeholder, or IS (whole-string) a dotted path of the reference form. Every
 * shape the specification names is still caught, including the two pinned by
 * the suite (`${step_1.output.sys_id}`, `<from step_1>`) and the
 * `step_2.inputs.blueprint` form the model actually produced. What is no
 * longer caught is a sentence that happens to contain the word "reference",
 * which was never a reference and whose refusal was a false one.
 */
const ATTEMPTED_REF = new RegExp([
  '\\$\\{',                                                   // ${...}
  '\\{\\{',                                                   // {{...}}
  '^<\\s*from\\b',                                            // <from step_1>
  '^step_\\d+\\.',                                            // bare step_1.anything
  // A whole string that is only a dotted path in the reference SHAPE. Anchored,
  // so it cannot fire inside a sentence.
  '^[A-Za-z][A-Za-z0-9_]*\\.(?:result|results|output|outputs|inputs)\\.[A-Za-z][A-Za-z0-9_]*$',
].join('|'), 'i');

/** Everything that can go wrong, named. Each one fails the plan closed. */
export const DATAFLOW_CODES = Object.freeze({
  MALFORMED: 'malformed_reference',
  UNKNOWN_STEP: 'reference_unknown_step',
  SELF: 'self_reference',
  UNKNOWN_OUTPUT: 'reference_unknown_output',
  NO_DEPENDENCY: 'reference_without_dependency',
  CIRCULAR: 'circular_dataflow',
  FORWARD: 'forward_reference',
  TYPE_MISMATCH: 'reference_type_mismatch',
  NO_OUTPUTS: 'producer_declares_no_outputs',
});

/** Runtime failures. Distinct from validation, and every one of them stops. */
export const RESOLUTION_CODES = Object.freeze({
  MISSING_OUTPUT: 'missing_step_output',
  PRODUCER_FAILED: 'producer_failed',
  PRODUCER_CANCELLED: 'producer_cancelled',
  PRODUCER_UNVERIFIED: 'producer_unverified',
  NULL_REQUIRED: 'null_required_output',
});

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

/**
 * The type vocabulary, reused rather than reinvented.
 *
 * `SEMANTIC_TYPES` already maps every ServiceNow `internal_type` onto a small
 * set — string, integer, boolean, reference, date, datetime and the rest — and
 * the semantic layer speaks it. One word is missing: ServiceNow has no
 * `internal_type` for identity, because a sys_id is a column property rather
 * than a field type, so `sys_id` is added here as an eighteenth member of the
 * SAME vocabulary. That is an extension, not a second taxonomy.
 */
export const SYS_ID = 'sys_id';
export const DATAFLOW_TYPES = Object.freeze([
  ...new Set([SYS_ID, ...Object.values(SEMANTIC_TYPES)]),
]);

/**
 * What a consumer SLOT expects.
 *
 * Only the slots whose type is a property of the plan contract itself, not of
 * any particular tool: a `sys_id` slot takes an identity, a `table` slot takes
 * a table name. A slot not named here has no declared expectation, and an
 * undeclared expectation is not an excuse to invent one — the type check simply
 * does not apply, and the other checks still do.
 */
export const SLOT_TYPES = Object.freeze({
  sys_id: SYS_ID,
  table: 'table_name',
});

/** Is a produced type acceptable where an expected type is wanted? */
export function typeSatisfies(produced, expected) {
  if (!expected) return true;              // no declared expectation
  if (!produced) return false;             // an undeclared output proves nothing
  if (produced === expected) return true;
  /*
   * A REFERENCE FIELD CARRIES A SYS_ID. `assignment_group` is a reference, and
   * its value IS the identity of the referenced row — so it satisfies a sys_id
   * slot. This is the one widening, and it is a fact about ServiceNow rather
   * than a convenience: nothing else is coerced, and `string` in particular
   * does NOT satisfy `sys_id`, which is the case the specification names.
   */
  if (expected === SYS_ID && produced === 'reference') return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * Parsing and discovery
 * ------------------------------------------------------------------ */

const isRefObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === 1 && typeof v[REF_KEY] === 'string';

/**
 * Parse one reference string.
 *
 * @returns {{ ok: true, stepId, output }|{ ok: false, code, raw }}
 */
export function parseReference(raw) {
  if (typeof raw !== 'string') return { ok: false, code: DATAFLOW_CODES.MALFORMED, raw };
  const m = REF_GRAMMAR.exec(raw.trim());
  if (!m) return { ok: false, code: DATAFLOW_CODES.MALFORMED, raw };
  return { ok: true, stepId: m[1], output: m[2] };
}

/**
 * Every reference in one step, with the path it sits at.
 *
 * Walks `target` and `inputs` only — the two places a plan describes what a
 * step will do. Depth-bounded, because a plan is data from a model and a
 * pathological nesting must degrade rather than exhaust the stack.
 */
export function findReferences(step) {
  const found = [];
  const walk = (value, path, depth) => {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (isRefObject(value)) { found.push({ path, raw: value[REF_KEY] }); return; }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...path, String(i)], depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(value)) walk(v, [...path, k], depth + 1);
  };
  walk(step?.target ?? {}, ['target'], 0);
  walk(step?.inputs ?? {}, ['inputs'], 0);
  return found;
}

/**
 * Strings that were TRYING to be references.
 *
 * Reported so a plan that reached for the mechanism and missed is refused with
 * the reason, rather than executing the text. Only strings are considered —
 * a well-formed `$ref` object is a reference and is handled above.
 */
export function findAttemptedReferences(step) {
  const found = [];
  const walk = (value, path, depth) => {
    if (depth > 8 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (ATTEMPTED_REF.test(value)) found.push({ path, raw: value });
      return;
    }
    if (typeof value !== 'object') return;
    if (isRefObject(value)) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, [...path, String(i)], depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(value)) walk(v, [...path, k], depth + 1);
  };
  walk(step?.target ?? {}, ['target'], 0);
  walk(step?.inputs ?? {}, ['inputs'], 0);
  return found;
}

/** The slot a reference feeds, as a readable path: `target.sys_id`. */
export const pathOf = (path) => path.join('.');

/* ------------------------------------------------------------------ *
 * The producer's output contract
 * ------------------------------------------------------------------ */

/**
 * What a tool declares it produces.
 *
 * `outputs` is an optional map on a tool definition:
 *
 *     outputs: { sys_id: { type: 'sys_id', from: 'sys_id' } }
 *
 * `type` is the vocabulary above; `from` names the field of the tool's own
 * result to read. A tool that declares nothing produces nothing referenceable,
 * which is the safe default — a reference to it fails validation rather than
 * scraping whatever it happened to return.
 */
export function declaredOutputsOf(toolName, { registry = toolMap } = {}) {
  const entry = toolName ? registry.get(toolName) : null;
  const outputs = entry?.outputs;
  if (!outputs || typeof outputs !== 'object') return null;
  return outputs;
}

/**
 * A single ServiceNow cell, unwrapped.
 *
 * The Table API returns `{ display_value, value }` for every field, so a raw
 * `.sys_id` is an object. Unwrapping is why an output must be DECLARED: the
 * shape is a property of the transport, and a plan should not have to know it.
 */
const cellValue = (v) => (
  v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v
);

/**
 * Extract the declared outputs from a producer's actual result.
 *
 * Returns only what the tool declared, read only from where the tool said to
 * read it. Nothing is inferred from the result's own shape, and a declared
 * output that is absent comes back as `undefined` rather than as a default —
 * the resolver then refuses, which is the point.
 *
 * A list result (`query_records`) reads from its FIRST row, and only when the
 * output declares `fromFirstRow`. That is stated per output rather than
 * guessed, because "the first of many" is a decision a plan should make
 * explicitly, not a convenience this layer applies silently.
 */
export function extractOutputs(toolName, result, { registry = toolMap } = {}) {
  const declared = declaredOutputsOf(toolName, { registry });
  if (!declared) return null;

  const out = {};
  for (const [name, spec] of Object.entries(declared)) {
    let source = result;
    if (Array.isArray(source)) {
      if (!spec?.fromFirstRow) continue;      // not declared row-wise: not readable
      source = source[0];
    }
    if (!source || typeof source !== 'object') continue;

    /*
     * PHASE 13 — AN OUTPUT CAN BE WITHHELD BY THE PRODUCER'S OWN VERDICT.
     *
     * `withheldWhen: { ambiguous: true }` says: if the result carries that
     * field with that value, this output does not exist. It is how "the lookup
     * was not sure" becomes "there is nothing here to reference" — and a
     * reference to a missing output STOPS the step rather than consuming a
     * guess. Ambiguity has to reach a person, not a mutation.
     *
     * A declarative field/value pair, compared by equality. No expression, no
     * predicate function, nothing a tool author can put code into.
     */
    const withheld = spec?.withheldWhen;
    if (withheld && typeof withheld === 'object') {
      let blocked = false;
      for (const [field, badValue] of Object.entries(withheld)) {
        if (cellValue(source[field]) === badValue) { blocked = true; break; }
      }
      if (blocked) continue;
    }

    /*
     * `path` reads a nested field; `from` reads a top-level one. Both are
     * declared, neither is searched for — a tool says where its output lives
     * and this reads exactly there.
     */
    const path = Array.isArray(spec?.path) ? spec.path : [spec?.from ?? name];
    let raw = source;
    for (const key of path) {
      if (!raw || typeof raw !== 'object') { raw = undefined; break; }
      raw = raw[key];
    }
    if (raw === undefined) continue;
    const value = cellValue(raw);
    if (value === undefined) continue;
    out[name] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Validate every reference in a plan, as a graph.
 *
 * Returns a list of `{ code, step, message, detail }` — the caller turns them
 * into the validator's own problem shape. Deterministic: the same plan always
 * produces the same list, in the same order.
 *
 * NOTHING IS REPAIRED. A missing `depends_on` is reported, never added: the
 * plan must say what the model actually proposed, and quietly wiring a
 * dependency would change the execution order a human is about to approve.
 */
export function validateDataflow(plan, { registry = toolMap } = {}) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const byId = new Map(steps.map((s) => [s?.id, s]));
  const position = new Map(steps.map((s, i) => [s?.id, i]));
  const problems = [];
  const push = (code, step, message, detail) => problems.push({ code, step, message, detail });

  // Every reference, per step, so the graph can be walked afterwards.
  const edges = new Map();          // consumerId -> Set(producerId)

  for (const [index, s] of steps.entries()) {
    if (!s?.id) continue;

    /* ---- a string that was reaching for the mechanism ---- */
    for (const a of findAttemptedReferences(s)) {
      push(DATAFLOW_CODES.MALFORMED, s.id,
        `Step ${s.id} sets ${pathOf(a.path)} to "${a.raw}", which looks like a reference to another `
        + 'step but is not one — it would be sent to the tool as that literal text. A reference is '
        + `an object: { "${REF_KEY}": "<step>.result.<output>" }.`,
        { path: pathOf(a.path), raw: a.raw });
    }

    const refs = findReferences(s);
    if (!refs.length) continue;
    const producers = new Set();

    for (const r of refs) {
      const slot = pathOf(r.path);
      const parsed = parseReference(r.raw);
      if (!parsed.ok) {
        push(DATAFLOW_CODES.MALFORMED, s.id,
          `Step ${s.id} references "${r.raw}" at ${slot}, which is not a valid reference. `
          + 'The only accepted form is "<step>.result.<output>".',
          { path: slot, raw: r.raw });
        continue;
      }

      const { stepId, output } = parsed;

      if (stepId === s.id) {
        push(DATAFLOW_CODES.SELF, s.id,
          `Step ${s.id} references its own output at ${slot}. A step cannot consume what it has not produced yet.`,
          { path: slot, raw: r.raw });
        continue;
      }

      const producer = byId.get(stepId);
      if (!producer) {
        push(DATAFLOW_CODES.UNKNOWN_STEP, s.id,
          `Step ${s.id} references "${stepId}" at ${slot}, and this plan has no step with that id.`,
          { path: slot, raw: r.raw, stepId });
        continue;
      }

      producers.add(stepId);

      /* ---- the producer must declare the output ---- */
      const declared = declaredOutputsOf(producer.tool, { registry });
      if (!declared) {
        push(DATAFLOW_CODES.NO_OUTPUTS, s.id,
          `Step ${s.id} reads "${output}" from ${stepId}, but ${producer.tool ?? 'that step'} declares no `
          + 'outputs, so there is nothing it can be relied on to produce.',
          { path: slot, raw: r.raw, producer: stepId, tool: producer.tool ?? null });
        continue;
      }
      const spec = declared[output];
      if (!spec) {
        push(DATAFLOW_CODES.UNKNOWN_OUTPUT, s.id,
          `Step ${s.id} reads "${output}" from ${stepId}, which ${producer.tool} does not produce. `
          + `It declares: ${Object.keys(declared).join(', ')}.`,
          { path: slot, raw: r.raw, producer: stepId, output, declares: Object.keys(declared) });
        continue;
      }

      /* ---- the dependency must be stated, not inferred ---- */
      const depends = Array.isArray(s.depends_on) ? s.depends_on : [];
      if (!depends.includes(stepId)) {
        push(DATAFLOW_CODES.NO_DEPENDENCY, s.id,
          `Step ${s.id} uses a value from ${stepId} but does not depend on it. A plan that consumes a `
          + 'step\'s output must say so in depends_on — the ordering a human approves has to be the '
          + 'ordering that runs.',
          { path: slot, producer: stepId });
      }

      /* ---- ordering: a producer must come first ---- */
      if ((position.get(stepId) ?? -1) >= index) {
        push(DATAFLOW_CODES.FORWARD, s.id,
          `Step ${s.id} references ${stepId}, which does not come before it.`,
          { path: slot, producer: stepId });
      }

      /* ---- types ---- */
      const expected = r.path.length === 2 ? SLOT_TYPES[r.path[1]] : undefined;
      if (expected && !typeSatisfies(spec.type, expected)) {
        push(DATAFLOW_CODES.TYPE_MISMATCH, s.id,
          `Step ${s.id} puts ${stepId}.result.${output} (${spec.type}) into ${slot}, which needs a `
          + `${expected}. Those are different things and the write would target the wrong record.`,
          { path: slot, produced: spec.type, expected });
      }
    }
    edges.set(s.id, producers);
  }

  /* ---- cycles, over the reference graph ---- */
  const WHITE = 0; const GREY = 1; const BLACK = 2;
  const colour = new Map(steps.map((s) => [s?.id, WHITE]));
  const stack = [];
  const visit = (id) => {
    if (colour.get(id) === BLACK) return;
    if (colour.get(id) === GREY) {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      push(DATAFLOW_CODES.CIRCULAR, id,
        `The references form a cycle: ${cycle.join(' -> ')}. No step in it could ever run first.`,
        { cycle });
      return;
    }
    colour.set(id, GREY);
    stack.push(id);
    for (const p of edges.get(id) ?? []) visit(p);
    stack.pop();
    colour.set(id, BLACK);
  };
  for (const s of steps) if (s?.id) visit(s.id);

  return problems;
}

/** Does this plan use the mechanism at all? */
export function hasReferences(plan) {
  return (plan?.steps ?? []).some((s) => findReferences(s).length > 0);
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/**
 * Replace a step's references with the values its producers actually produced.
 *
 * `outputsByStep` is `{ [stepId]: { [output]: value } }`, read from durable
 * state by the caller — this function performs no I/O and holds no state
 * between calls, which is what keeps two concurrent plans from ever seeing one
 * another's values.
 *
 * @returns {{ ok, args, target, resolutions, problems }}
 *
 * On any failure it returns `ok: false` and the caller STOPS. There is no
 * partial resolution and no default: a reference that cannot be resolved is a
 * step that must not run.
 */
export function resolveReferences(step, outputsByStep = {}) {
  const resolutions = [];
  const problems = [];

  const substitute = (value, path, depth) => {
    if (depth > 8 || value === null || typeof value !== 'object') return value;
    if (isRefObject(value)) {
      const slot = pathOf(path);
      const parsed = parseReference(value[REF_KEY]);
      if (!parsed.ok) {
        problems.push({
          code: DATAFLOW_CODES.MALFORMED, path: slot, raw: value[REF_KEY],
          message: `The reference "${value[REF_KEY]}" at ${slot} is not valid.`,
        });
        return value;
      }
      const produced = outputsByStep[parsed.stepId];
      if (!produced) {
        problems.push({
          code: RESOLUTION_CODES.MISSING_OUTPUT, path: slot, raw: value[REF_KEY],
          message: `${parsed.stepId} has produced no recorded outputs, so ${slot} cannot be resolved. `
            + 'Nothing is substituted for it.',
        });
        return value;
      }
      if (!(parsed.output in produced)) {
        problems.push({
          code: RESOLUTION_CODES.MISSING_OUTPUT, path: slot, raw: value[REF_KEY],
          message: `${parsed.stepId} did not produce "${parsed.output}", so ${slot} cannot be resolved.`,
        });
        return value;
      }
      const resolved = produced[parsed.output];
      if (resolved === null || resolved === undefined || resolved === '') {
        problems.push({
          code: RESOLUTION_CODES.NULL_REQUIRED, path: slot, raw: value[REF_KEY],
          message: `${parsed.stepId}.result.${parsed.output} came back empty. An empty value is not a `
            + 'target, and nothing is substituted for it.',
        });
        return value;
      }
      resolutions.push({
        path: slot, declared: value[REF_KEY], producer: parsed.stepId, output: parsed.output, resolved,
      });
      return resolved;
    }
    if (Array.isArray(value)) return value.map((v, i) => substitute(v, [...path, String(i)], depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, [...path, k], depth + 1);
    return out;
  };

  const target = substitute(step?.target ?? {}, ['target'], 0);
  const args = substitute(step?.inputs ?? {}, ['inputs'], 0);
  return { ok: problems.length === 0, args, target, resolutions, problems };
}

/**
 * Is a producer's state one a consumer may read from?
 *
 * A failed, cancelled or skipped producer produced nothing a consumer can rely
 * on, and an unverified one produced something nobody proved. Each is a
 * separate refusal so the reason survives into the evidence.
 */
export function producerIsUsable(producerStep) {
  const state = producerStep?.state ?? null;
  if (state === 'completed') return { ok: true };
  if (state === 'cancelled') {
    return { ok: false, code: RESOLUTION_CODES.PRODUCER_CANCELLED, state };
  }
  if (state === 'failed' || state === 'skipped') {
    return { ok: false, code: RESOLUTION_CODES.PRODUCER_FAILED, state };
  }
  return { ok: false, code: RESOLUTION_CODES.PRODUCER_UNVERIFIED, state };
}
