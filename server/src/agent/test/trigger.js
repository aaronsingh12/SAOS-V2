/**
 * PHASE 17 — WHAT WOULD ACTUALLY FIRE THIS FLOW.
 *
 * §9 says the live artifact is authoritative and §10 says the test contract is
 * derived from it. This module is that derivation for the TRIGGER half: it
 * reads the trigger a flow really has and works out what record would satisfy
 * it — or says, precisely, why it cannot.
 *
 * IT REFUSES FAR MORE THAN IT ACCEPTS, and that is the design. An encoded query
 * is a small language and most of it cannot be inverted: "priority != 1" is
 * satisfied by nine values and choosing one is a guess; "state IN 1,2,3" is
 * satisfied by three and choosing one is a guess; a dot-walked term names a
 * related record this slice does not create. Every one of those becomes
 * TRIGGER_UNSUPPORTED with the term quoted, because a fixture that only
 * probably fires the flow produces a test result that only probably means
 * something — and §70.8 makes presenting that as an answer a release blocker.
 *
 * THE ONE PLACE IT REASONS RATHER THAN READS is a derived field (§15). A
 * trigger condition of `priority=1` cannot be satisfied by writing `priority`,
 * because the platform overwrites it — that is the oldest fact in this
 * project's ledger. So the condition is driven from the fields the semantic
 * layer says it is computed from, and the CANDIDATE assignment is checked
 * against the instance by read-back before the test proceeds. Nothing here
 * claims to know ServiceNow's priority matrix; it proposes an input and lets
 * the platform answer.
 */
import { EFFECT_KINDS } from './schemas.js';

/* ------------------------------------------------------------------ *
 * The encoded query, parsed only as far as it can be inverted
 * ------------------------------------------------------------------ */

/**
 * The operators this module recognises.
 *
 * The list is unordered as far as matching is concerned — the loop below picks
 * the earliest occurrence in the term and, among equals, the longest — but it
 * is written longest-first within each family so a reader can see that
 * `ISNOTEMPTY` and `ISEMPTY`, or `CHANGESTO` and `CHANGES`, are both here and
 * are not the same operator.
 */
const OPERATORS = Object.freeze([
  'ISNOTEMPTY', 'ISEMPTY', 'ANYTHING',
  'STARTSWITH', 'ENDSWITH', 'DOESNOTCONTAIN', 'NOTLIKE', 'LIKE',
  'NOTIN', 'IN',
  'VALCHANGES', 'CHANGESFROM', 'CHANGESTO', 'CHANGES',
  'GREATERTHANOREQUALS', 'LESSTHANOREQUALS',
  'BETWEEN', 'SAMEAS', 'NSAMEAS',
  '!=', '>=', '<=', '=', '>', '<',
]);

/** A term whose operator takes no right-hand side. */
const NULLARY = new Set(['ISEMPTY', 'ISNOTEMPTY', 'ANYTHING', 'VALCHANGES', 'CHANGES']);

/** Only these can be turned into a value to write. Everything else stops. */
const SATISFIABLE = new Set(['=', 'ISEMPTY']);

const FIELD_RE = /^[a-z][a-z0-9_]*$/i;

/**
 * Split an encoded query into terms, keeping what could not be understood.
 *
 * `^EQ` is the platform's end-of-query marker and carries no condition; an
 * empty query and a query of `^EQ` both mean "every record of this table", and
 * both are returned as zero terms rather than as an error.
 *
 * A DISJUNCTION STOPS THE WHOLE QUERY. `^OR` and `^NQ` mean the flow fires for
 * either of two record shapes, and building one of them is choosing which half
 * of the flow to test without saying so.
 */
export function parseEncodedQuery(raw) {
  const text = String(raw ?? '').trim();
  const out = { terms: [], unsupported: [], disjunction: false };
  if (!text || text === '^EQ') return out;

  if (/\^OR/i.test(text) || /\^NQ/i.test(text)) {
    out.disjunction = true;
    out.unsupported.push({
      term: text,
      reason: 'The condition is a disjunction (^OR / ^NQ). It describes more than one kind of record, '
        + 'and building one of them would silently choose which half of the flow gets tested.',
    });
    return out;
  }

  for (const piece of text.split('^')) {
    const chunk = piece.trim();
    if (!chunk || chunk.toUpperCase() === 'EQ') continue;

    /*
     * EARLIEST OPERATOR WINS, AND AT THE SAME POSITION THE LONGEST DOES.
     *
     * Both halves are needed. Without "earliest", a value that happens to
     * contain an operator word — `short_description=Server IN Rack` — is split
     * on the `IN` two thirds of the way through and the whole term is thrown
     * away as unparseable. Without "longest at the same position",
     * `stateCHANGESTO3` parses as CHANGES with a value of `TO3`, which is a
     * different condition wearing the same characters.
     */
    let op = null;
    let opAt = Infinity;
    for (const candidate of OPERATORS) {
      const at = chunk.indexOf(candidate);
      if (at <= 0) continue;
      if (at < opAt || (at === opAt && candidate.length > op.length)) { op = candidate; opAt = at; }
    }
    if (!op) {
      out.unsupported.push({ term: chunk, reason: 'No operator in this term could be recognised.' });
      continue;
    }
    const field = chunk.slice(0, opAt).trim();
    const value = chunk.slice(opAt + op.length);

    if (!FIELD_RE.test(field)) {
      out.unsupported.push({
        term: chunk,
        reason: field.includes('.')
          ? `"${field}" dot-walks to a related record. Satisfying it would mean creating records this test does not own.`
          : `"${field}" is not a plain field name.`,
      });
      continue;
    }
    out.terms.push({
      field,
      op,
      value: NULLARY.has(op) ? null : value,
      raw: chunk,
      satisfiable: SATISFIABLE.has(op),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Which trigger, and can this slice fire it
 * ------------------------------------------------------------------ */

/** Trigger kinds an INSERT can fire. Measured, and it is not a matter of taste:
 *  a `record_update` trigger fires on a transition, so a freshly created record
 *  never satisfies one however well its fields match. */
export const FIREABLE_BY_INSERT = Object.freeze(['record_create', 'record_create_or_update']);

/**
 * The single record trigger this flow has, or the reason there is nothing to test.
 *
 * A flow with two triggers is refused rather than having one picked: which one
 * the test fired would decide what the result meant, and nothing here can make
 * that choice on a user's behalf.
 */
export function triggerOf(artifact) {
  const triggers = artifact?.triggers ?? [];
  if (!triggers.length) {
    return { ok: false, reason: 'no_trigger', note: 'This flow has no readable trigger, so there is nothing a fixture could fire.' };
  }
  if (triggers.length > 1) {
    return {
      ok: false,
      reason: 'multiple_triggers',
      note: `This flow has ${triggers.length} triggers. Which one a test fired would decide what its result meant, `
        + 'so no fixture is built for it.',
    };
  }
  const t = triggers[0];
  if (!FIREABLE_BY_INSERT.includes(String(t.type))) {
    return {
      ok: false,
      reason: 'trigger_kind_unsupported',
      note: `This flow's trigger is "${t.type}". This slice fires a flow by CREATING a record, and `
        + `${t.type === 'record_update'
          ? 'an update trigger fires on a transition — an insert can never satisfy it'
          : 'that trigger is not fired by creating a record'}.`,
      kind: t.type,
    };
  }
  if (!t.table) {
    return {
      ok: false,
      reason: 'trigger_table_unreadable',
      note: `The trigger's table could not be read from the artifact${t.table_label ? ` (the label says "${t.table_label}")` : ''}. `
        + 'A fixture cannot be created on a table whose identity is not known.',
    };
  }
  return {
    ok: true,
    kind: String(t.type),
    table: t.table,
    table_label: t.table_label ?? null,
    condition: t.condition_query ?? null,
    condition_display: t.condition ?? null,
    strategy: t.strategy ?? null,
    sys_id: t.sys_id ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * §14/§15 — turning the condition into fields to write
 * ------------------------------------------------------------------ */

/**
 * The fields a fixture must carry to satisfy this trigger.
 *
 * @param trigger    from `triggerOf`
 * @param fields     Map<name, dictionaryField> for the trigger table, or null
 *                   when the dictionary could not be read
 * @param derivation `derivationOf`, injected
 *
 * Returns `{ ok, data, derived, omitted, unsupported }`. `derived` records
 * every field whose value was driven from upstream inputs rather than written,
 * so the caller can check the platform actually produced it (§56).
 *
 * A FIELD THE DICTIONARY DOES NOT HAVE STOPS THE FIXTURE. Writing it would be
 * accepted and dropped, and the test would then measure a record that never
 * matched the trigger while reporting whatever the flow did or did not do.
 */
export function satisfyCondition(trigger, { fields = null, derivation = () => null } = {}) {
  const parsed = parseEncodedQuery(trigger?.condition);
  const out = {
    ok: true,
    data: {},
    derived: [],
    omitted: [],
    unsupported: [...parsed.unsupported],
    terms: parsed.terms,
  };

  for (const term of parsed.terms) {
    if (!term.satisfiable) {
      out.unsupported.push({
        term: term.raw,
        reason: `The operator "${term.op}" cannot be inverted into a single value to write. `
          + 'More than one record would satisfy it, and picking one would be a guess.',
      });
      continue;
    }

    if (fields && !fields.has(term.field)) {
      out.unsupported.push({
        term: term.raw,
        reason: `"${term.field}" is not a field on ${trigger.table} according to the live dictionary. `
          + 'A write to it would be accepted and silently dropped, so the fixture could not satisfy the trigger.',
      });
      continue;
    }

    if (term.op === 'ISEMPTY') {
      /* Satisfied by leaving the field out. `sys_idISEMPTY` is the common case:
       * it is how Flow Designer spells "on insert", and a new record satisfies
       * it by existing. */
      out.omitted.push({ field: term.field, reason: `the condition requires ${term.field} to be empty` });
      continue;
    }

    const derived = derivation(trigger.table, term.field, { hierarchy: [trigger.table] });
    if (derived) {
      /*
       * §15 AND §70.5. The platform computes this field, so writing it is
       * accepted and overwritten — the plan validator refuses such a write
       * outright, and it is right to.
       *
       * The upstream assignment below is a CANDIDATE, not a claim. This build
       * knows which fields the value is computed FROM (the ledger says so) and
       * does not know the matrix that combines them, so it proposes the
       * assignment where each input carries the target value and lets the
       * instance answer. `verifyTriggerSatisfied` reads the created record back
       * and stops the test if the platform produced something else.
       */
      const inputs = derived.value?.from ?? [];
      const usable = inputs.filter((f) => !fields || fields.has(f));
      if (!inputs.length || usable.length !== inputs.length) {
        out.unsupported.push({
          term: term.raw,
          reason: `${term.field} is computed from ${inputs.join(' + ') || 'inputs this build cannot name'}, `
            + 'and those inputs are not all present on this table, so the condition cannot be driven upstream.',
        });
        continue;
      }
      for (const input of usable) out.data[input] = term.value;
      out.derived.push({
        field: term.field,
        expect: term.value,
        from: usable,
        note: derived.note ?? null,
        candidate: Object.fromEntries(usable.map((f) => [f, term.value])),
      });
      continue;
    }

    out.data[term.field] = term.value;
  }

  out.ok = out.unsupported.length === 0;
  return out;
}

/**
 * Did the record the platform actually stored satisfy the trigger? (§45, §56)
 *
 * Called AFTER the fixture exists, against the read-back — never against what
 * was requested. A derived field is the whole reason this exists: the fixture
 * asks for `impact=1, urgency=1` and only the instance can say whether that
 * produced `priority=1`. If it did not, the flow was never going to fire and
 * the run reports TRIGGER_NOT_SATISFIED rather than "the flow did nothing".
 */
export function verifyTriggerSatisfied({ trigger, satisfaction, record, readField }) {
  const checks = [];
  const read = typeof readField === 'function' ? readField : (r, f) => r?.[f] ?? null;

  for (const term of satisfaction.terms ?? []) {
    if (term.op === 'ISEMPTY') {
      const actual = read(record, term.field);
      checks.push({
        field: term.field, operator: term.op, expected: '(empty)',
        actual: actual === null || actual === undefined ? '' : String(actual),
        satisfied: actual === null || actual === undefined || String(actual) === '',
      });
      continue;
    }
    if (term.op !== '=') continue;
    const actual = read(record, term.field);
    const actualText = actual === null || actual === undefined ? '' : String(actual);
    checks.push({
      field: term.field,
      operator: term.op,
      expected: String(term.value ?? ''),
      actual: actualText,
      satisfied: actualText === String(term.value ?? ''),
      derived: (satisfaction.derived ?? []).some((d) => d.field === term.field),
    });
  }

  const failed = checks.filter((c) => !c.satisfied);
  return {
    satisfied: failed.length === 0,
    checks,
    failed,
    note: failed.length
      ? `The record was created, but ${failed.map((c) => `${c.field} is "${c.actual}" where the trigger needs "${c.expected}"`).join('; ')}. `
        + `The trigger condition "${trigger.condition}" is therefore not met, so this flow was never going to run for it.`
      : null,
  };
}

/**
 * The trigger contract, as the §29 JSON carries it.
 *
 * Deliberately a projection and not a second source of truth: everything in it
 * was read from the artifact or derived by the two functions above.
 */
export function triggerContract(trigger, satisfaction) {
  return {
    kind: trigger.kind,
    table: trigger.table,
    table_label: trigger.table_label,
    condition: trigger.condition,
    strategy: trigger.strategy,
    terms: (satisfaction.terms ?? []).map((t) => ({ field: t.field, operator: t.op, value: t.value })),
    derived_terms: satisfaction.derived ?? [],
    omitted_terms: satisfaction.omitted ?? [],
    unsupported_terms: satisfaction.unsupported ?? [],
  };
}

export const EFFECTS = EFFECT_KINDS;
