/**
 * PHASE 17 — THE TEST CONTRACT: WHAT WILL BE DONE, AND WHAT IT WILL PROVE.
 *
 * §29 asks for the test as structured data, and §30 asks that a change to it
 * after approval invalidate the approval. Both are satisfied the same way: the
 * contract is the input to the PLAN, the plan is fingerprinted by the existing
 * `fingerprintPlan`, and there is no second fingerprint system. Anything that
 * changes the fixture changes a step's inputs, which changes the fingerprint,
 * which the executor re-checks before every step.
 *
 * VALIDATION HAPPENS BEFORE ANY MUTATION (§45). Every refusal below costs
 * nothing: no record has been created, nothing has been approved, and the
 * answer to "why did this not run" is a sentence rather than a leftover record.
 *
 * §46 IS THE SUBTLE ONE. An expected effect has to be observable, has to come
 * from somewhere other than the fixture itself, and has to have an assertion.
 * The first two are checked here and refuse the contract. The THIRD is checked
 * here and does NOT refuse it — an effect with no assertion is a limit of this
 * build, and the honest response is to run the test and report INCONCLUSIVE
 * rather than to refuse to look at the flow at all. Which of the two happens is
 * decided by `coverage` below and carried on the contract, so the arithmetic in
 * `result.js` cannot forget about it.
 */
import { BLOCKS, EFFECT_KINDS } from './schemas.js';

/**
 * Assemble the §29 contract.
 *
 * Everything in it was produced by a module that read the instance. This
 * function composes; it derives nothing of its own.
 */
export function buildContract({
  artifact, trigger, satisfaction, effects, fixture, assertions, refused = [], uncovered = [],
  timeout_ms: timeoutMs = null, lint = null,
}) {
  return {
    artifact: {
      type: 'flow',
      sys_id: artifact?.flow?.sys_id ?? null,
      name: artifact?.flow?.name ?? null,
      active: artifact?.flow?.active ?? null,
      scope: artifact?.flow?.scope ?? null,
      updated_on: artifact?.flow?.updated_on ?? null,
    },
    trigger: {
      kind: trigger.kind,
      table: trigger.table,
      table_label: trigger.table_label,
      condition: trigger.condition,
      strategy: trigger.strategy,
      terms: (satisfaction.terms ?? []).map((t) => ({ field: t.field, operator: t.op, value: t.value })),
      derived: satisfaction.derived ?? [],
      omitted: satisfaction.omitted ?? [],
      unsupported: satisfaction.unsupported ?? [],
    },
    fixture: {
      table: fixture?.table ?? trigger.table,
      data: fixture?.data ?? {},
      marker: fixture?.marker ?? null,
      marker_field: fixture?.marker_field ?? null,
      disposable_because: fixture?.why_disposable ?? null,
    },
    expected_effects: (effects.required ?? []).map(projectEffect),
    conditional_effects: (effects.conditional ?? []).map(projectEffect),
    superseded_effects: (effects.superseded ?? []).map(projectEffect),
    unobservable_effects: (effects.unobservable ?? []).map(projectEffect),
    assertions: assertions.map((a) => ({
      id: a.id, type: a.type, description: a.description,
      table: a.table, field: a.field, expected: a.expected, from_effect: a.from_effect,
    })),
    refused_assertions: refused,
    uncovered_effects: uncovered.map(projectEffect),
    cleanup: {
      strategy: 'delete_created_records',
      table: fixture?.table ?? trigger.table,
      note: 'Only the records this run watched being created are deleted, by sys_id.',
    },
    timeout_ms: timeoutMs,
    /* §41 — what the linter says, carried for the reader. It never gates. */
    lint: lint ?? null,
  };
}

const projectEffect = (e) => ({
  kind: e.kind,
  statement: e.statement,
  action: e.action ?? null,
  order: e.order ?? null,
  action_type: e.type ?? null,
  table: e.table ?? null,
  field: e.field ?? null,
  expected: e.expected ?? null,
  conditional: Boolean(e.conditional),
  reason: e.reason ?? null,
});

/* ------------------------------------------------------------------ *
 * §45 / §46 — validation before anything runs
 * ------------------------------------------------------------------ */

/**
 * Is this contract executable, and does it prove what it claims?
 *
 * Returns `{ ok, block, problems, coverage }`. `ok: false` means nothing runs.
 * `coverage.complete: false` means it runs and cannot reach PASS.
 */
export function validateContract(contract) {
  const problems = [];
  let block = null;

  /* ---- the trigger ---- */
  if (!contract.trigger?.table) {
    problems.push({ code: 'no_trigger_table', message: 'The contract names no table to create a fixture on.' });
    block = block ?? BLOCKS.TRIGGER_UNREADABLE;
  }
  if ((contract.trigger?.unsupported ?? []).length) {
    for (const u of contract.trigger.unsupported) {
      problems.push({ code: 'trigger_term_unsupported', message: `${u.term}: ${u.reason}` });
    }
    block = block ?? BLOCKS.TRIGGER_UNSUPPORTED;
  }

  /* ---- the fixture ---- */
  const data = contract.fixture?.data ?? {};
  if (!Object.keys(data).length) {
    problems.push({ code: 'empty_fixture', message: 'The fixture would write no fields at all, so nothing identifies it as test data.' });
    block = block ?? BLOCKS.FIXTURE_UNSATISFIABLE;
  }
  if (!contract.fixture?.marker || !contract.fixture?.marker_field) {
    problems.push({ code: 'no_marker', message: 'The fixture carries no test marker, so a leftover record could not be attributed to this run.' });
    block = block ?? BLOCKS.NO_MARKER_FIELD;
  } else if (!String(data[contract.fixture.marker_field] ?? '').includes(contract.fixture.marker)) {
    problems.push({
      code: 'marker_not_written',
      message: `The marker ${contract.fixture.marker} is not in the fixture's ${contract.fixture.marker_field}.`,
    });
    block = block ?? BLOCKS.NO_MARKER_FIELD;
  }

  /* ---- §46: every expected effect must be observable and not fixture-only ---- */
  for (const e of contract.expected_effects ?? []) {
    if (e.kind === EFFECT_KINDS.UNOBSERVABLE) {
      problems.push({
        code: 'unobservable_effect_required',
        message: `An effect that cannot be observed reached the required list: ${e.statement}`,
      });
      block = block ?? BLOCKS.CONTRACT_INVALID;
    }
    if (e.conditional) {
      problems.push({
        code: 'conditional_effect_required',
        message: `A conditional effect reached the required list: ${e.statement}`,
      });
      block = block ?? BLOCKS.CONTRACT_INVALID;
    }
    if (e.field && Object.hasOwn(data, e.field) && e.kind === EFFECT_KINDS.FIELD) {
      /*
       * The fixture writes the very field this effect promises. That is not
       * automatically wrong — the flow may overwrite it, and `changed` still
       * proves something — but an EQUALS on it would not, and
       * `assertionsFor` has already refused that. Recorded so the reader knows
       * the equality was dropped and why.
       */
      problems.push({
        code: 'effect_field_written_by_fixture',
        message: `${e.field} is written by the fixture, so only a change to it is evidence about the flow.`,
        fatal: false,
      });
    }
  }

  /* ---- cleanup must exist ---- */
  if (!contract.cleanup?.strategy) {
    problems.push({ code: 'no_cleanup', message: 'The contract names no cleanup strategy.' });
    block = block ?? BLOCKS.CONTRACT_INVALID;
  }

  /* ---- §13/§46: coverage ---- */
  const coverage = coverageOf(contract);
  if (!coverage.any) {
    problems.push({
      code: 'nothing_assertable',
      message: coverage.note,
    });
    block = block ?? BLOCKS.NO_OBSERVABLE_EFFECT;
  }

  const fatal = problems.filter((p) => p.fatal !== false);
  return { ok: fatal.length === 0, block: fatal.length ? block : null, problems, coverage };
}

/**
 * How much of what the flow promises this test will actually check.
 *
 * `complete` is what separates a run that MAY reach PASS from one that cannot,
 * and getting its definition right took a real PDI run to notice.
 *
 * §13 says an effect that cannot be asserted makes the result INCONCLUSIVE
 * rather than PASS, and the first reading of that counted UNOBSERVABLE ACTIONS
 * against completeness. MEASURED CONSEQUENCE on dev424910: a flow whose two
 * promised field writes both happened, whose execution completed, and whose
 * every assertion passed came back INCONCLUSIVE — because its middle action is
 * a scoped custom action whose result no record read can see.
 *
 * That reading makes PASS unreachable in practice. Almost every real flow
 * contains one action of that kind — a Send Email, an Ask For Approval, a
 * scoped action — and a test system that can never say PASS is exactly as
 * useless as one that always does.
 *
 * So the two are separated, because they are different facts:
 *
 *   UNCOVERED   a promised, observable effect this build failed to assert.
 *               That is §13's case and it bars PASS.
 *   UNOBSERVABLE an action whose result cannot be read from the record at all.
 *               That is a stated limit of the test, not a gap in its coverage.
 *
 * §13's actual words are "do not SILENTLY omit difficult assertions", and the
 * silence is what is forbidden. So an unobservable action is never dropped: it
 * is carried here, named in the report's "Not covered by this test" section on
 * every run including a passing one, and named again in the PASS sentence
 * itself. A reader is told exactly what the PASS covers.
 */
export function coverageOf(contract) {
  const required = contract.expected_effects ?? [];
  const asserted = new Set((contract.assertions ?? []).map((a) => a.from_effect).filter(Boolean));
  const covered = required.filter((e) => asserted.has(e.action));
  const uncovered = required.filter((e) => !asserted.has(e.action));
  const unobservable = contract.unobservable_effects ?? [];

  const note = required.length
    ? `${covered.length} of ${required.length} promised effect(s) are checked.`
    : 'This flow promises no effect that can be observed by reading the record it was triggered by. '
      + (unobservable.length
        ? `What it does do — ${unobservable.slice(0, 3).map((e) => e.action_type ?? e.statement).join(', ')}${unobservable.length > 3 ? ', …' : ''} — `
          + 'cannot be checked from outside the flow by this build.'
        : '');

  return {
    any: covered.length > 0,
    complete: required.length > 0 && uncovered.length === 0,
    required: required.length,
    covered: covered.length,
    uncovered: uncovered.map((e) => e.statement),
    unobservable: unobservable.map((e) => e.statement),
    note,
  };
}
