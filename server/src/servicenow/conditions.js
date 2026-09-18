/**
 * Encoded-query handling, shared by every subsystem that has to trust one.
 *
 * This exists because of trap #2, which is the most expensive behaviour on the
 * platform: an encoded query naming a field that does not exist is silently
 * DROPPED rather than rejected. `^fooISNOTEMPTY` and `^fooISEMPTY` then both
 * match the same record. Any layer that builds or accepts a condition — flow
 * verification locators (fluent.js), SLA start/stop/pause conditions (sla.js) —
 * needs the same two things: the field names a query actually constrains on,
 * and a check of those names against the live dictionary.
 *
 * It used to live inside fluent.js, private to flow verification. Track B needs
 * it for SLA definitions, where a start condition on a misspelled field yields
 * an SLA that attaches to EVERY record instead of erroring — so it moved here
 * rather than being copied, and fluent.js re-exports it for its existing
 * callers.
 */

/* ------------------------------------------------------------------ *
 * Grammar
 *
 * Operator alternation is ordered LONGEST-FIRST and the field name is matched
 * as strictly lowercase. Both matter, and the second one was a real defect in
 * the original: with a case-insensitive field class, `incident_stateNOTIN7,8`
 * backtracked into field `incident_stateNOT` + operator `IN`, so the check ran
 * against a field name that cannot exist and quietly passed. The space form
 * (`incident_stateNOT IN7,8`) is what this instance actually stores in its own
 * ACL and SLA conditions, and the original pattern did not match it at all —
 * dropping the field from the check entirely, which is the same false green
 * one level up.
 * ------------------------------------------------------------------ */

const OPERATORS = [
  'ISNOTEMPTY', 'ISEMPTY', 'ANYTHING', 'EMPTYSTRING',
  'STARTSWITH', 'ENDSWITH', 'INSTANCEOF', 'BETWEEN',
  /*
   * The change operators, longest first so `stateCHANGESTO3` is not read as
   * CHANGES with the value `TO3` — a different condition wearing the same
   * characters (src/agent/test/trigger.js makes the same point). Without them
   * a flow trigger condition of `stateCHANGES` reads as an unparsed clause,
   * which is reported as a fault in a condition that is perfectly valid.
   */
  'VALCHANGES', 'CHANGESFROM', 'CHANGESTO', 'CHANGES',
  'NOT ?LIKE', 'NOT ?IN', 'NSAMEAS', 'SAMEAS', 'DYNAMIC',
  'LIKE', 'IN',
  '!=', '>=', '<=', '=', '>', '<',
];

// Field, then operator, then everything up to the end of the clause.
const CLAUSE_RE = new RegExp(
  `^([a-z][a-z0-9_]*)((?:\\.[a-z0-9_]+)*)\\s*(${OPERATORS.join('|')})([\\s\\S]*)$`
);

/**
 * Clause joiners. The `(?!DERBY)` is load-bearing: `^ORDERBYnumber` starts with
 * the OR joiner as far as a naive split is concerned, which chews the clause
 * down to "DERBYnumber" and turns an ordinary sort into an unparseable clause.
 */
const JOIN_RE = /\^(OR(?!DERBY)|NQ)?/g;

/**
 * Split an encoded query into clauses, keeping the joiner that PRECEDED each.
 * `^EQ` is the condition builder's end-of-query marker, not a clause, and the
 * platform appends it to anything saved through the UI — so a condition read
 * back off the instance and one typed into NowHelpAssist differ by that suffix and
 * must still compare equal.
 */
export function splitQuery(query) {
  const text = String(query ?? '');
  if (!text.trim()) return [];
  const out = [];
  let last = 0;
  let join = 'AND';
  JOIN_RE.lastIndex = 0;
  for (let m = JOIN_RE.exec(text); m; m = JOIN_RE.exec(text)) {
    out.push({ raw: text.slice(last, m.index), join });
    join = m[1] === 'OR' ? 'OR' : m[1] === 'NQ' ? 'NQ' : 'AND';
    last = m.index + m[0].length;
  }
  out.push({ raw: text.slice(last), join });
  return out.filter((c) => c.raw.trim() !== '');
}

/** Drop the trailing `^EQ` marker the condition builder appends. */
export function stripEndMarker(query) {
  return String(query ?? '').replace(/\^EQ\s*$/i, '');
}

/** True when two encoded queries mean the same thing modulo the `^EQ` marker. */
export function sameQuery(a, b) {
  return stripEndMarker(a).trim() === stripEndMarker(b).trim();
}

/**
 * Parse an encoded query into clauses: { field, dotWalk, op, value, join }.
 * Ordering and grouping are preserved; clauses that are not conditions
 * (ORDERBY, EQ, anything unparseable) come back with `field: null` so a caller
 * can see that it did not understand them rather than silently ignoring them.
 */
export function parseQuery(query) {
  return splitQuery(query).map(({ raw, join }) => {
    const clause = raw.trim();
    if (/^(EQ|NQ)$/i.test(clause)) return { raw: clause, join, field: null, kind: 'marker' };
    if (/^ORDERBY/i.test(clause)) return { raw: clause, join, field: null, kind: 'order' };
    const m = clause.match(CLAUSE_RE);
    if (!m) return { raw: clause, join, field: null, kind: 'unparsed' };
    return {
      raw: clause,
      join,
      kind: 'condition',
      field: m[1],
      dotWalk: m[2] ? m[2].slice(1) : null,
      op: m[3].replace(/\s+/g, ' ').toUpperCase(),
      value: m[4] ?? '',
    };
  });
}

/**
 * Root field names an encoded query constrains on. A dot-walk contributes only
 * its root, because that is the only part the table's own dictionary can
 * confirm — `assignment_group.name` is checked as `assignment_group`.
 */
export function queryFieldRoots(query) {
  const text = String(query ?? '').replace(/\{\{[^}]*\}\}/g, 'x');
  const roots = new Set();
  for (const c of parseQuery(text)) {
    if (c.kind === 'condition') roots.add(c.field);
  }
  return [...roots];
}

/**
 * Clauses this query could not parse. Reported rather than dropped: an
 * unparsed clause is a field NOT being checked, which is the same blind spot
 * trap #2 opens, one level up.
 */
export function unparsedClauses(query) {
  return parseQuery(query).filter((c) => c.kind === 'unparsed').map((c) => c.raw);
}

/* ------------------------------------------------------------------ *
 * Validation against the live dictionary
 * ------------------------------------------------------------------ */

/**
 * Check every field an encoded query constrains on against a table's real
 * schema. `schemaFor` is injected so this is testable offline and so callers
 * can hand in a cached schema.
 *
 * A schema that cannot be READ is reported as `checked: false` — never as a
 * pass. The distinction matters: "every field exists" and "we could not look"
 * are different answers, and collapsing them is how a guard starts certifying
 * the absence of bugs.
 */
export async function validateEncodedQuery(tableName, query, { schemaFor } = {}) {
  const roots = queryFieldRoots(query);
  const unparsed = unparsedClauses(query);
  if (!schemaFor) throw new Error('validateEncodedQuery needs a schemaFor reader.');
  let fields = null;
  let readError = null;
  try {
    fields = new Set((await schemaFor(tableName)).fields.map((f) => f.name));
  } catch (err) {
    readError = err.message;
  }
  if (!fields) {
    return { ok: false, checked: false, table: tableName, roots, unknown: [], unparsed, readError };
  }
  const unknown = roots.filter((r) => !fields.has(r));
  return { ok: unknown.length === 0 && unparsed.length === 0, checked: true, table: tableName, roots, unknown, unparsed, readError: null };
}

/** The message a rejected condition should carry — it names the cost, not just the fault. */
export function unknownFieldMessage(label, tableName, unknown) {
  return (
    `${label} constrains on ${unknown.map((u) => `"${u}"`).join(', ')}, which ` +
    `${unknown.length === 1 ? 'does' : 'do'} not exist on ${tableName}. ServiceNow does not reject a ` +
    `condition naming an unknown field — it silently DROPS the clause, so this condition is wider than ` +
    `it reads. An SLA start condition loses its filter and attaches to every record on the table; a ` +
    `verification locator matches whether or not the effect happened. Use a field from the real schema.`
  );
}

/* ------------------------------------------------------------------ *
 * Turning a condition into a record that satisfies it
 *
 * Used by SLA verification: to prove an SLA definition works, something has to
 * create a record its start condition actually matches. Deriving that payload
 * from the stored condition is deterministic work, so it is done here in code
 * rather than asked of a model — the whole failure class in §14/§20 was a model
 * being asked to restate something the instance could simply be read for.
 * ------------------------------------------------------------------ */

/**
 * Priority is CALCULATED from impact and urgency (trap #5): writing it lands as
 * 4 - Low. These are the impact/urgency pairs that produce each priority on the
 * OOB matrix. Nothing downstream trusts this table — the runner reads the
 * created record back and fails loudly if the platform computed something else,
 * so a customised matrix produces a named mismatch rather than a wrong test.
 */
export const PRIORITY_INPUTS = {
  1: { impact: '1', urgency: '1' },
  2: { impact: '1', urgency: '2' },
  3: { impact: '2', urgency: '2' },
  4: { impact: '3', urgency: '2' },
  5: { impact: '3', urgency: '3' },
};

/** Fields the platform computes on task tables: set the inputs, never the result. */
export const CALCULATED_TASK_FIELDS = new Set(['priority']);

/**
 * Build a payload that should satisfy `query` on `tableName`.
 *
 * Returns { payload, notes, unsatisfiable }. `unsatisfiable` is the loud half:
 * every clause that could not be turned into a value, with the reason. A caller
 * must refuse to run when it is non-empty — a setup record that satisfies only
 * part of a condition tests nothing, and reports a clean failure for a
 * definition that is actually correct.
 *
 * `resolveRef(table, hint)` resolves a reference field to a real sys_id; it is
 * injected so this is testable offline.
 */
export async function derivePayloadFor(tableName, query, { schemaFor, resolveRef } = {}) {
  const schema = await schemaFor(tableName);
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  const payload = {};
  const notes = [];
  const unsatisfiable = [];

  for (const c of parseQuery(query)) {
    if (c.kind === 'marker' || c.kind === 'order') continue;
    if (c.kind !== 'condition') {
      unsatisfiable.push({ clause: c.raw, reason: 'could not be parsed as a condition' });
      continue;
    }
    if (c.join === 'OR' || c.join === 'NQ') {
      // An OR arm is optional by construction: satisfying the first arm is
      // enough, and guessing which one the author meant is exactly the kind of
      // silent decision this project keeps having to dig back out.
      notes.push(`Ignored the ${c.join} arm "${c.raw}" — satisfying the AND clauses is sufficient.`);
      continue;
    }
    const field = byName.get(c.field);
    if (!field) {
      unsatisfiable.push({
        clause: c.raw,
        reason: `"${c.field}" does not exist on ${tableName}, so the platform drops this clause (trap #2) and the condition is wider than it reads`,
      });
      continue;
    }
    if (c.dotWalk) {
      unsatisfiable.push({ clause: c.raw, reason: `dot-walked conditions (${c.field}.${c.dotWalk}) are not derivable — the value lives on another record` });
      continue;
    }
    if (/^javascript:/i.test(c.value.trim())) {
      unsatisfiable.push({ clause: c.raw, reason: 'the value is a javascript: expression evaluated by the platform at query time' });
      continue;
    }

    switch (c.op) {
      case '=': {
        if (CALCULATED_TASK_FIELDS.has(c.field)) {
          const inputs = PRIORITY_INPUTS[String(c.value).trim()];
          if (!inputs) {
            unsatisfiable.push({ clause: c.raw, reason: `priority ${c.value} has no impact/urgency pair on the standard matrix` });
            break;
          }
          Object.assign(payload, inputs);
          notes.push(
            `${c.field}=${c.value} is CALCULATED (trap #5) — set impact=${inputs.impact}, urgency=${inputs.urgency} ` +
            `instead and never write ${c.field}; the created record is read back to confirm the platform agreed.`
          );
          break;
        }
        if (field.reference && !/^[0-9a-f]{32}$/i.test(String(c.value).trim())) {
          unsatisfiable.push({ clause: c.raw, reason: `${c.field} references ${field.reference} but the condition names "${c.value}", not a sys_id` });
          break;
        }
        payload[c.field] = String(c.value);
        break;
      }
      case 'STARTSWITH':
        payload[c.field] = String(c.value);
        break;
      case 'ISNOTEMPTY': {
        if (field.reference) {
          if (!resolveRef) { unsatisfiable.push({ clause: c.raw, reason: 'no reference resolver available' }); break; }
          const hit = await resolveRef(field.reference, '');
          if (!hit?.sys_id) {
            unsatisfiable.push({ clause: c.raw, reason: `${c.field} must be non-empty, but no record exists in ${field.reference} to point it at` });
            break;
          }
          payload[c.field] = hit.sys_id;
          notes.push(`${c.field}ISNOTEMPTY satisfied with ${field.reference} "${hit.display}" (${hit.sys_id}), resolved live.`);
          break;
        }
        payload[c.field] = 'NowHelpAssist SLA verification';
        break;
      }
      case 'ISEMPTY':
        // Absent from the payload is empty; recording it as an explicit note
        // keeps the derivation auditable.
        notes.push(`${c.field}ISEMPTY satisfied by leaving ${c.field} out of the payload.`);
        break;
      case 'IN': {
        const first = String(c.value).split(',')[0]?.trim();
        if (!first) { unsatisfiable.push({ clause: c.raw, reason: 'empty IN list' }); break; }
        if (CALCULATED_TASK_FIELDS.has(c.field)) {
          const inputs = PRIORITY_INPUTS[first];
          if (!inputs) { unsatisfiable.push({ clause: c.raw, reason: `priority ${first} has no impact/urgency pair` }); break; }
          Object.assign(payload, inputs);
          notes.push(`${c.field}IN${c.value} satisfied through impact=${inputs.impact}, urgency=${inputs.urgency} (trap #5).`);
          break;
        }
        payload[c.field] = first;
        notes.push(`${c.field}IN${c.value} satisfied with the first member, "${first}".`);
        break;
      }
      default:
        unsatisfiable.push({
          clause: c.raw,
          reason: `operator ${c.op} has no single value that satisfies it — a record derived from it would be a guess`,
        });
    }
  }

  return { payload, notes, unsatisfiable };
}
