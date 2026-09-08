/**
 * PHASE 17 — THE ASSERTIONS, AND THE ARITHMETIC THAT DECIDES THEM.
 *
 * §44 is the rule this file exists to make structural: the model cannot decide
 * PASS. Nothing below reads a model output, a tool's own report of its success,
 * or anything except a value that came back from the instance. An assertion is
 * a comparison between a value derived from the flow's own artifact and a value
 * read off a record afterwards, and every one of them names the read it used
 * (§43) so a person can repeat it by hand.
 *
 * §12 IS ENFORCED HERE AND IT IS NOT ADVISORY. An assertion on a field the
 * fixture itself wrote is REFUSED at construction, not marked and kept: it
 * would pass whatever the flow did, and a passing assertion that proves nothing
 * is worse than no assertion, because it is counted. §70.4 makes it a release
 * blocker, and the refusal is what makes it impossible rather than discouraged.
 *
 * THREE OUTCOMES, NOT TWO. An assertion whose evidence never arrived is
 * UNAVAILABLE — not a failure. "The flow did not do it" and "nobody could tell
 * whether it did it" are different findings; the first is a defect in the flow
 * and the second is a limit of the test, and §13 turns the second into
 * INCONCLUSIVE rather than letting the rest of the run report a clean pass.
 */
import { ASSERTIONS, ASSERTION_STATES, EFFECT_KINDS } from './schemas.js';

const SYS_ID_RE = /^[0-9a-f]{32}$/i;

/** ServiceNow cells are `{display_value, value}` under display=all. */
export function cellValue(cell) {
  if (cell && typeof cell === 'object' && !Array.isArray(cell) && 'value' in cell) return cell.value ?? null;
  return cell === undefined ? null : cell;
}
export function cellDisplay(cell) {
  if (cell && typeof cell === 'object' && !Array.isArray(cell) && 'display_value' in cell) {
    return cell.display_value ?? null;
  }
  return null;
}
const text = (v) => (v === null || v === undefined ? '' : String(v));

/* ------------------------------------------------------------------ *
 * §12 — what may never be asserted
 * ------------------------------------------------------------------ */

/**
 * Would this assertion be true regardless of what the flow did?
 *
 * The test wrote `field: value` into the fixture. Asserting that same field on
 * that same record afterwards proves the platform stored what was sent, which
 * is a fact about the Table API and not about the flow.
 *
 * A field the fixture wrote can still carry a `changed` assertion — "it is no
 * longer what we set it to" IS evidence about the flow — so the refusal is
 * scoped to the comparisons that would be trivially true.
 */
export function selfWritten(field, fixtureData) {
  return Object.hasOwn(fixtureData ?? {}, field);
}

const TRIVIAL_ON_SELF_WRITTEN = new Set([
  ASSERTIONS.EQUALS, ASSERTIONS.EXISTS, ASSERTIONS.CONTAINS, ASSERTIONS.REFERENCE_IDENTITY,
]);

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

let counter = 0;
const nextId = (seed) => `assert_${seed}`;

/**
 * Turn the required effects into assertions.
 *
 * @param effects     from `requiredEffects`
 * @param fixture     from `buildFixture` (its `data` is the anti-trivial input)
 * @param fields      Map<name, dictionaryField>, or null — decides whether a
 *                    field is a reference, which decides how it is compared
 *
 * Returns `{ assertions, refused, uncovered }`. `uncovered` is every required
 * effect that produced no assertion, which is what makes §13 checkable rather
 * than hoped for.
 */
export function assertionsFor({ effects, fixture, fields = null }) {
  const assertions = [];
  const refused = [];
  const uncovered = [];
  const fixtureData = fixture?.data ?? {};
  let seed = 0;

  for (const effect of effects.required ?? []) {
    const before = assertions.length;

    if (effect.kind === EFFECT_KINDS.FIELD) {
      const dict = fields?.get(effect.field) ?? null;
      const isReference = Boolean(dict?.reference);

      /*
       * "It is not what the test left it as" — the assertion §12's own example
       * asks for. It needs a BEFORE value, which is the record as the platform
       * stored it at insert, not the payload the test sent.
       */
      assertions.push(make(++seed, {
        type: ASSERTIONS.CHANGED,
        table: effect.table,
        field: effect.field,
        description: `${effect.table}.${effect.field} changed from what it was when the record was created`,
        from_effect: effect.action,
      }));

      if (effect.literal) {
        if (selfWritten(effect.field, fixtureData)) {
          refused.push({
            effect: effect.action, field: effect.field, type: ASSERTIONS.EQUALS,
            reason: `The fixture itself writes ${effect.field}="${fixtureData[effect.field]}", so asserting its value `
              + 'would be true however the flow behaved.',
          });
        } else if (isReference) {
          assertions.push(make(++seed, {
            type: ASSERTIONS.REFERENCE_IDENTITY,
            table: effect.table,
            field: effect.field,
            expected: effect.expected,
            reference_table: dict.reference,
            description: `${effect.table}.${effect.field} references ${effect.expected}`,
            from_effect: effect.action,
          }));
        } else {
          assertions.push(make(++seed, {
            type: ASSERTIONS.EQUALS,
            table: effect.table,
            field: effect.field,
            expected: effect.expected,
            description: `${effect.table}.${effect.field} is "${effect.expected}"`,
            from_effect: effect.action,
          }));
        }
      } else {
        assertions.push(make(++seed, {
          type: ASSERTIONS.EXISTS,
          table: effect.table,
          field: effect.field,
          description: `${effect.table}.${effect.field} is populated`,
          from_effect: effect.action,
        }));
      }
    } else if (effect.kind === EFFECT_KINDS.JOURNAL) {
      assertions.push(make(++seed, {
        type: ASSERTIONS.JOURNAL_ADDED,
        table: effect.table,
        field: effect.field,
        expected: effect.literal ? effect.expected : null,
        description: effect.literal
          ? `a ${effect.field.replace(/_/g, ' ')} entry containing "${effect.expected}" was added`
          : `a ${effect.field.replace(/_/g, ' ')} entry was added`,
        from_effect: effect.action,
      }));
    } else if (effect.kind === EFFECT_KINDS.CREATED_RECORD) {
      assertions.push(make(++seed, {
        type: ASSERTIONS.RECORD_COUNT,
        table: effect.table,
        field: effect.link_field,
        expected: effect.expected_count ?? 1,
        description: `exactly ${effect.expected_count ?? 1} ${effect.table} record(s) point at the test record via ${effect.link_field}`,
        from_effect: effect.action,
      }));
    }

    if (assertions.length === before) uncovered.push(effect);
  }

  /* An assertion that would be trivially true is dropped here too, in case a
   * future effect kind reaches a comparison the branch above did not screen. */
  const kept = [];
  for (const a of assertions) {
    if (TRIVIAL_ON_SELF_WRITTEN.has(a.type) && a.field && selfWritten(a.field, fixtureData)) {
      refused.push({
        effect: a.from_effect, field: a.field, type: a.type,
        reason: `The fixture writes ${a.field}, so this comparison would hold however the flow behaved.`,
      });
      continue;
    }
    kept.push(a);
  }

  return { assertions: kept, refused, uncovered };
}

function make(seed, spec) {
  counter += 1;
  return {
    id: nextId(seed),
    type: spec.type,
    description: spec.description,
    table: spec.table ?? null,
    field: spec.field ?? null,
    expected: spec.expected ?? null,
    expected_display: null,
    reference_table: spec.reference_table ?? null,
    from_effect: spec.from_effect ?? null,
    status: null,
    actual: null,
    actual_display: null,
    note: null,
    /* §43 — filled in by the evaluator with the read that answered it. */
    source: null,
  };
}

/* ------------------------------------------------------------------ *
 * Evaluation — the only place a PASS is decided
 * ------------------------------------------------------------------ */

/**
 * Evaluate every assertion against the evidence collected.
 *
 * @param assertions  from `assertionsFor`
 * @param evidence    {
 *                      created   the record as the insert returned it (BEFORE)
 *                      after     the read-back (AFTER), with its source
 *                      journal   the journal read, with its source
 *                      counts    Map<assertionId, { rows, source }>
 *                    }
 *
 * Each entry of `evidence` is `{ value, source }` or absent. Absent means the
 * read did not happen or did not complete, and every assertion depending on it
 * becomes UNAVAILABLE — never FAIL, because a read that never ran is not
 * evidence that the flow misbehaved.
 */
export function evaluate(assertions, evidence = {}) {
  return assertions.map((a) => {
    try {
      return { ...a, ...decide(a, evidence) };
    } catch (err) {
      return {
        ...a,
        status: ASSERTION_STATES.UNAVAILABLE,
        note: `This assertion could not be evaluated: ${err.message}`,
        source: null,
      };
    }
  });
}

function unavailable(note, source = null) {
  return { status: ASSERTION_STATES.UNAVAILABLE, note, source };
}

function decide(a, evidence) {
  if (a.type === ASSERTIONS.RECORD_COUNT) {
    const entry = evidence.counts?.get?.(a.id) ?? evidence.counts?.[a.id] ?? null;
    if (!entry) return unavailable('The query that would count the created records did not complete.');
    const rows = Array.isArray(entry.value) ? entry.value : entry.value?.rows ?? [];
    const actual = rows.length;
    return {
      status: actual === Number(a.expected) ? ASSERTION_STATES.PASS : ASSERTION_STATES.FAIL,
      actual: String(actual),
      actual_display: null,
      source: entry.source ?? null,
      note: actual === Number(a.expected)
        ? null
        : `${actual} record(s) matched where ${a.expected} was expected.`,
    };
  }

  if (a.type === ASSERTIONS.JOURNAL_ADDED) {
    const entry = evidence.journal ?? null;
    if (!entry) return unavailable('The journal was not read, so no claim is made about work notes or comments.');
    /* `journalFor` calls the field `element`; a raw row calls it `field`. Both
     * are accepted so this comparison does not depend on which read produced
     * the evidence. */
    const entries = (entry.value?.entries ?? entry.value ?? []).filter((e) => {
      const el = e.element ?? e.field ?? null;
      return !a.field || !el || el === a.field;
    });
    if (!entries.length) {
      return {
        status: ASSERTION_STATES.FAIL,
        actual: '(no entries)',
        source: entry.source ?? null,
        note: `No ${a.field ?? 'journal'} entry exists on the record.`,
      };
    }
    if (!a.expected) {
      return { status: ASSERTION_STATES.PASS, actual: `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`, source: entry.source ?? null, note: null };
    }
    /* §26 — containment, never equality, and never a timestamp comparison. */
    const hit = entries.find((e) => text(e.value ?? e.text).includes(String(a.expected)));
    return {
      status: hit ? ASSERTION_STATES.PASS : ASSERTION_STATES.FAIL,
      actual: hit ? text(hit.value ?? hit.text).slice(0, 200) : entries.map((e) => text(e.value ?? e.text).slice(0, 80)).join(' | '),
      actual_display: hit?.author ?? null,
      source: entry.source ?? null,
      note: hit ? null : `No ${a.field ?? 'journal'} entry contains "${a.expected}".`,
    };
  }

  /* Everything else reads one field off the after-record. */
  const after = evidence.after ?? null;
  if (!after) return unavailable('The record was not read back, so nothing is known about its state after the flow ran.');
  const record = after.value ?? null;
  if (!record) {
    return {
      status: ASSERTION_STATES.UNAVAILABLE,
      note: 'The record could not be read back after the flow ran.',
      source: after.source ?? null,
    };
  }

  const cell = record[a.field];
  const actual = cellValue(cell);
  const display = cellDisplay(cell);
  const base = { actual: text(actual), actual_display: display, source: after.source ?? null };

  switch (a.type) {
    case ASSERTIONS.EQUALS:
      return { ...base, status: text(actual) === text(a.expected) ? ASSERTION_STATES.PASS : ASSERTION_STATES.FAIL,
        note: text(actual) === text(a.expected) ? null : `expected "${a.expected}", read "${text(actual)}"` };

    case ASSERTIONS.NOT_EQUALS:
      return { ...base, status: text(actual) !== text(a.expected) ? ASSERTION_STATES.PASS : ASSERTION_STATES.FAIL,
        note: text(actual) !== text(a.expected) ? null : `the value is still "${text(actual)}"` };

    case ASSERTIONS.EXISTS:
      return { ...base, status: text(actual).trim() !== '' ? ASSERTION_STATES.PASS : ASSERTION_STATES.FAIL,
        note: text(actual).trim() !== '' ? null : 'the field is empty' };

    case ASSERTIONS.NOT_EXISTS:
      return { ...base, status: text(actual).trim() === '' ? ASSERTION_STATES.PASS : ASSERTION_STATES.FAIL,
        note: text(actual).trim() === '' ? null : `the field holds "${text(actual)}"` };

    case ASSERTIONS.CONTAINS:
      return { ...base, status: text(actual).includes(String(a.expected)) ? ASSERTION_STATES.PASS : ASSERTION_STATES.FAIL,
        note: text(actual).includes(String(a.expected)) ? null : `"${a.expected}" does not appear in "${text(actual)}"` };

    case ASSERTIONS.CHANGED: {
      const createdEntry = evidence.created ?? null;
      if (!createdEntry?.value) {
        return unavailable('The record as first created was not captured, so "changed" cannot be established.', after.source ?? null);
      }
      const beforeValue = cellValue(createdEntry.value[a.field]);
      const changed = text(beforeValue) !== text(actual);
      return {
        ...base,
        status: changed ? ASSERTION_STATES.PASS : ASSERTION_STATES.FAIL,
        note: changed
          ? `"${text(beforeValue) || '(empty)'}" → "${text(actual) || '(empty)'}"`
          : `still "${text(actual) || '(empty)'}", unchanged since the record was created`,
        source: after.source ?? null,
        before: text(beforeValue),
      };
    }

    /*
     * §25 — a reference is compared by IDENTITY, with the display value shown
     * beside it for a reader. Comparing display values would pass for a
     * different record that happens to share a name, which is the exact defect
     * Phase 13 measured when a display name was written into a reference field.
     */
    case ASSERTIONS.REFERENCE_IDENTITY: {
      const expected = String(a.expected ?? '');
      if (!SYS_ID_RE.test(expected)) {
        return {
          ...base,
          status: ASSERTION_STATES.UNAVAILABLE,
          note: `The flow supplies "${expected}" for the reference field ${a.field}, which is not a sys_id. `
            + 'A reference can only be checked by identity, and there is no identity here to check against.',
        };
      }
      const same = text(actual).toLowerCase() === expected.toLowerCase();
      return {
        ...base,
        status: same ? ASSERTION_STATES.PASS : ASSERTION_STATES.FAIL,
        note: same
          ? `sys_id ${expected}${display ? ` (${display})` : ''}`
          : `expected sys_id ${expected}, read ${text(actual) || '(empty)'}${display ? ` (${display})` : ''}`,
      };
    }

    default:
      return unavailable(`"${a.type}" is not an assertion type this build evaluates.`, after.source ?? null);
  }
}

/* ------------------------------------------------------------------ *
 * §28 — what the flow did that nobody asked about
 * ------------------------------------------------------------------ */

/**
 * Housekeeping the platform writes on every update. A change to one of these
 * says the record was touched, which is already known, and nothing else.
 */
const HOUSEKEEPING = new Set([
  'sys_updated_on', 'sys_updated_by', 'sys_mod_count', 'sys_created_on', 'sys_created_by',
  'sys_id', 'sys_class_name', 'sys_domain', 'sys_domain_path', 'sys_tags',
]);

/**
 * Fields that changed on the fixture and were NOT part of the contract.
 *
 * §28 asks that an effect outside the expected contract be reported as a risk
 * rather than a failure, and the distinction matters: a flow that also stamps a
 * `work_start` is behaving normally and is not what the test was asked about.
 * So this REPORTS and never decides — `decideResult` records the classification
 * and leaves the verdict to the assertions.
 *
 * IT COMPARES TWO READ-BACKS AND NOTHING ELSE. `created` is the record as the
 * insert returned it and `after` is the record once the flow had finished, so
 * every difference is something that happened in between. A field the FIXTURE
 * wrote cannot appear here — its value at insert is the value the test chose,
 * so a later change to it is a real change and a field it never wrote that
 * simply holds a default is unchanged.
 *
 * A DERIVED FIELD IS EXCLUDED BY NAME. `priority` moves because `impact` and
 * `urgency` were written, which is the platform doing what the ledger says it
 * does, not the flow doing something unexpected.
 */
export function unexpectedEffects({ created, after, promised = [], derived = [] } = {}) {
  const before = created?.value ?? null;
  const now = after?.value ?? null;
  if (!before || !now) return [];

  const claimed = new Set(promised.filter(Boolean));
  const computed = new Set(derived.filter(Boolean));
  const out = [];

  for (const field of Object.keys(now)) {
    if (HOUSEKEEPING.has(field) || claimed.has(field) || computed.has(field)) continue;
    if (!Object.hasOwn(before, field)) continue;
    const was = cellValue(before[field]);
    const is = cellValue(now[field]);
    if (text(was) === text(is)) continue;
    out.push({
      field,
      from: text(was),
      to: text(is),
      display: cellDisplay(now[field]),
      severity: 'RISK',
      statement: `${field} changed from "${text(was) || '(empty)'}" to "${text(is) || '(empty)'}", `
        + 'which is not one of the effects this flow was tested for.',
      source: after.source ?? null,
    });
  }
  return out;
}

/** A one-line tally, used by the result arithmetic and by the renderer. */
export function tally(assertions) {
  return {
    total: assertions.length,
    passed: assertions.filter((a) => a.status === ASSERTION_STATES.PASS).length,
    failed: assertions.filter((a) => a.status === ASSERTION_STATES.FAIL).length,
    unavailable: assertions.filter((a) => a.status === ASSERTION_STATES.UNAVAILABLE).length,
  };
}
