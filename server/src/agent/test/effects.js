/**
 * PHASE 17 — WHAT THIS FLOW PROMISES THAT SOMEBODY COULD CHECK.
 *
 * §10 is blunt about the trap here: "Do not assume every action implies an
 * assertion." A flow's actions are what it MIGHT do. An expected effect is what
 * it must do for the test to be meaningful, and the gap between those two is
 * where a linter-shaped mistake turns into a test that fails correct flows.
 *
 * THREE THINGS SEPARATE AN ACTION FROM AN EFFECT, and each is read off the live
 * artifact rather than assumed:
 *
 *   1. IS IT REACHED UNCONDITIONALLY? An action inside a branch runs only when
 *      the branch is taken, so asserting its result unconditionally fails a
 *      flow doing exactly the right thing. Measured on dev424910: the only
 *      Update Record in "Change - Conflict Detection" sits in the error branch
 *      and writes `message=Flow error…`. A naive reading promises that on every
 *      run; the flow completes cleanly and never writes it.
 *
 *      An action is treated as unconditional ONLY when its `parent_ui_id` is
 *      empty. A non-empty parent means the action sits inside a container, and
 *      `sys_hub_flow_logic_v2` does not exist on this instance so what the
 *      container IS cannot always be read. Conservative in the safe direction:
 *      an effect this build cannot prove is reached is never promised.
 *
 *   2. DOES IT TOUCH THE RECORD THE TEST OWNS? An Update Record whose target is
 *      the trigger record is observable by reading that record back. One whose
 *      target is a looked-up record somewhere else is real and is not
 *      observable by this test, and saying so is the honest answer.
 *
 *   3. IS THE WRITTEN VALUE A LITERAL? `state=3` can be asserted. A data pill
 *      names another step's output, whose value nothing here knows before the
 *      run, so it becomes a `changed` assertion at most — never an equality
 *      against a value this module invented.
 *
 * AN EFFECT THAT CANNOT BE OBSERVED IS STILL RECORDED. §13 forbids silently
 * omitting the difficult ones: an unobservable effect makes the run
 * INCONCLUSIVE rather than disappearing so the rest can report PASS.
 */
import { parseFieldMap } from '../lint/rules.js';
import { EFFECT_KINDS } from './schemas.js';

/* ------------------------------------------------------------------ *
 * Reading the artifact's own vocabulary
 * ------------------------------------------------------------------ */

/**
 * The pill that means "the record this flow was triggered by".
 *
 * MEASURED on dev424910: a record-created trigger names it `{{Created_1.current}}`
 * and the leading token varies with the trigger ("Updated_1", "Trigger"). The
 * shape that is constant is `<something>.current`, so that is what is matched —
 * and nothing looser, because `{{Created_1.current.source_record}}` is a
 * DIFFERENT record and must not be read as the trigger record.
 */
const TRIGGER_RECORD_PILL = /^\{\{[A-Za-z0-9_]+\.current\}\}$/;

/** Journal fields, by the platform's own names. Asserted by containment (§26). */
const JOURNAL_FIELDS = new Set(['work_notes', 'comments', 'additional_comments']);

const ACTIONS = Object.freeze({
  UPDATE_RECORD: 'update record',
  CREATE_RECORD: 'create record',
});

const isPill = (text) => /^\{\{.*\}\}$/.test(String(text ?? '').trim());
const nameOf = (action) => String(action?.type_name ?? '').trim().toLowerCase();
const inputOf = (action, name) => (action?.inputs ?? []).find((i) => i.name === name) ?? null;

/** Unconditional means: this build can PROVE it is reached, not merely fail to
 *  find evidence that it is not. An unreadable container is conditional. */
export function isUnconditional(action) {
  return !action?.parent_ui_id;
}

/* ------------------------------------------------------------------ *
 * §10/§11 — the derivation
 * ------------------------------------------------------------------ */

/**
 * Every effect this flow promises, in artifact order.
 *
 * @param artifact  from `readFlowArtifact`
 * @param trigger   from `triggerOf`
 *
 * Returns a flat list. Later analysis needs to know that two actions wrote the
 * same field, so nothing is collapsed here.
 */
export function effectsOf(artifact, trigger) {
  const out = [];
  const ordered = [...(artifact?.actions ?? [])].sort(
    (a, b) => Number(a.order ?? 0) - Number(b.order ?? 0),
  );

  for (const action of ordered) {
    const where = { action: action.sys_id, order: action.order, type: action.type_name };
    if (!action.inputs_readable) {
      out.push({
        ...where, kind: EFFECT_KINDS.UNOBSERVABLE, conditional: !isUnconditional(action),
        statement: `${action.type_name ?? 'An action'} has inputs that could not be decoded, so what it does is not known.`,
        reason: 'inputs_unreadable',
      });
      continue;
    }
    const conditional = !isUnconditional(action);
    const kind = nameOf(action);

    if (kind === ACTIONS.UPDATE_RECORD) {
      out.push(...updateEffects(action, trigger, where, conditional));
      continue;
    }
    if (kind === ACTIONS.CREATE_RECORD) {
      out.push(createEffect(action, trigger, where, conditional));
      continue;
    }

    /*
     * Everything else. A "Send Email", an "Ask For Approval", a scoped custom
     * action — each does something real, and this build cannot say what a
     * record would look like afterwards without inventing ServiceNow semantics,
     * which §9 forbids. Recorded as unobservable, with the action's own name,
     * so a reader sees the part of the flow the test does not cover.
     */
    out.push({
      ...where, kind: EFFECT_KINDS.UNOBSERVABLE, conditional,
      statement: `${action.type_name ?? 'An action'} runs, and this build cannot observe its result from a record read.`,
      reason: 'action_not_observable',
    });
  }
  return out;
}

/** The field writes one Update Record makes, one effect per field. */
function updateEffects(action, trigger, where, conditional) {
  const target = inputOf(action, 'record');
  const tableInput = inputOf(action, 'table_name');
  const values = inputOf(action, 'values');
  const targetTable = tableInput?.supplied || null;

  const onTriggerRecord = Boolean(target?.supplied)
    && TRIGGER_RECORD_PILL.test(target.supplied.trim())
    && (!targetTable || targetTable === trigger.table);

  if (!onTriggerRecord) {
    return [{
      ...where, kind: EFFECT_KINDS.UNOBSERVABLE, conditional,
      statement: `Update Record writes to ${targetTable ? `a ${targetTable} record` : 'a record'} that is not the one the test creates`
        + `${target?.supplied ? ` (${target.supplied})` : ''}, so its result cannot be read back from the fixture.`,
      reason: 'target_not_the_fixture',
    }];
  }
  if (!values || values.empty) {
    return [{
      ...where, kind: EFFECT_KINDS.UNOBSERVABLE, conditional,
      statement: 'Update Record names no field values, so nothing it does can be checked.',
      reason: 'no_values',
    }];
  }

  const pairs = parseFieldMap(values.supplied);
  if (!pairs.length) {
    return [{
      ...where, kind: EFFECT_KINDS.UNOBSERVABLE, conditional,
      statement: 'Update Record carries a value map that could not be parsed into fields.',
      reason: 'values_unparsed',
    }];
  }

  return pairs.map(({ field, value }) => {
    const literal = !isPill(value);
    if (JOURNAL_FIELDS.has(field)) {
      return {
        ...where, kind: EFFECT_KINDS.JOURNAL, conditional,
        table: trigger.table, field,
        expected: literal ? value : null,
        literal,
        statement: literal
          ? `A ${field.replace(/_/g, ' ')} entry containing "${truncate(value)}" is written on the ${trigger.table}.`
          : `A ${field.replace(/_/g, ' ')} entry is written on the ${trigger.table}.`,
      };
    }
    return {
      ...where, kind: EFFECT_KINDS.FIELD, conditional,
      table: trigger.table, field,
      expected: literal ? value : null,
      literal,
      statement: literal
        ? `${trigger.table}.${field} becomes "${value}".`
        : `${trigger.table}.${field} is set from ${value}.`,
    };
  });
}

/**
 * A Create Record, and the narrow case in which it is observable.
 *
 * §27 wants a created record asserted. From outside the flow the only way to
 * FIND that record deterministically is a field on it pointing back at the
 * fixture — otherwise "did the flow create it" and "was it already there"
 * cannot be told apart, and a record_count assertion would be measuring the
 * instance's history rather than this run.
 */
function createEffect(action, trigger, where, conditional) {
  const tableInput = inputOf(action, 'table_name') ?? inputOf(action, 'table');
  const values = inputOf(action, 'values') ?? inputOf(action, 'fields');
  const table = tableInput?.supplied || null;
  const pairs = values && !values.empty ? parseFieldMap(values.supplied) : [];
  const back = pairs.find((p) => TRIGGER_RECORD_PILL.test(String(p.value ?? '').trim()));

  if (!table || !back) {
    return {
      ...where, kind: EFFECT_KINDS.UNOBSERVABLE, conditional,
      statement: table
        ? `Create Record creates a ${table}, and nothing on it points back at the test's own record, `
          + 'so the created record cannot be told apart from one that was already there.'
        : 'Create Record names no table, so nothing about what it creates can be checked.',
      reason: back ? 'create_table_unknown' : 'created_record_not_linked',
    };
  }
  return {
    ...where, kind: EFFECT_KINDS.CREATED_RECORD, conditional,
    table, link_field: back.field, expected_count: 1, literal: true,
    statement: `Exactly one ${table} is created with ${back.field} pointing at the ${trigger.table} the test created.`,
  };
}

/* ------------------------------------------------------------------ *
 * From effects to what the test will actually claim
 * ------------------------------------------------------------------ */

/**
 * Collapse the promised effects into the ones a test can require.
 *
 * TWO REDUCTIONS, both of which change what the test asserts, so both are
 * recorded on the result rather than done quietly:
 *
 *   CONDITIONAL EFFECTS ARE NOT REQUIRED. They are carried as `conditional` so
 *   a reader sees them, and they never produce an assertion.
 *
 *   THE LAST UNCONDITIONAL WRITE TO A FIELD WINS. A flow that sets `state=2`
 *   and then `state=3` ends with 3, and asserting 2 would fail a flow that ran
 *   correctly to the end. The earlier write is kept as `superseded` so the
 *   report can show the sequence.
 */
export function requiredEffects(effects) {
  const unconditional = effects.filter((e) => !e.conditional);
  const conditional = effects.filter((e) => e.conditional);

  const lastByField = new Map();
  const superseded = [];
  const others = [];

  for (const e of unconditional) {
    if (e.kind === EFFECT_KINDS.FIELD) {
      const key = `${e.table}.${e.field}`;
      const prior = lastByField.get(key);
      if (prior) superseded.push({ ...prior, superseded_by: e.action });
      lastByField.set(key, e);
      continue;
    }
    others.push(e);
  }

  const required = [...lastByField.values(), ...others.filter((e) => e.kind !== EFFECT_KINDS.UNOBSERVABLE)];
  const unobservable = others.filter((e) => e.kind === EFFECT_KINDS.UNOBSERVABLE);

  return {
    required: required.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0)),
    conditional,
    superseded,
    unobservable,
    all: effects,
  };
}

function truncate(text, at = 60) {
  const s = String(text ?? '');
  return s.length > at ? `${s.slice(0, at)}…` : s;
}

export const _internals = { TRIGGER_RECORD_PILL, JOURNAL_FIELDS, ACTIONS };
