import { getSchema, getTableHierarchy, getDisplayField, referenceLookup } from '../schema.js';
import { listFacts } from '../../memory/facts.js';
import { fact, unknown, ambiguous, reconcile, STATUS } from './provenance.js';

/**
 * PHASE 3 — TABLE, FIELD AND REFERENCE SEMANTICS.
 *
 * Read-only, and structurally so: this module imports `schema.js` and the fact
 * ledger's read function, and nothing else. It never sees `client.js`, so it
 * has no `table.create`, no `table.update` and no `table.remove` to call even
 * by mistake — the absence of the capability is the guarantee, not a rule
 * somebody has to remember. test/semantic-layer.test.js asserts it on the
 * import graph.
 *
 * WHAT IT ADDS OVER `getSchema`. `getSchema` answers "what rows are in the
 * dictionary". That is the raw material, not the meaning. This answers the
 * questions an agent actually has before it writes anything:
 *
 *   - what KIND of field is this, in a vocabulary that distinguishes a choice
 *     from a reference from a journal, because writing to each is different;
 *   - what does this reference POINT AT, so a value can be resolved rather
 *     than invented;
 *   - is this field DERIVED, so that "set priority to 1" is recognised as a
 *     request to set impact and urgency rather than as an ordinary write;
 *   - and where every one of those answers came from.
 *
 * NOTHING HERE GUESSES. A table that cannot be read is `unknown`, a reference
 * with no target is `unknown`, and a lookup that matches three groups is
 * `ambiguous` with the three candidates attached. None of those is ever
 * silently resolved to a first result — that is the SNADA invariant this layer
 * would be the easiest place to break.
 */

/**
 * The semantic field-type vocabulary.
 *
 * Keyed by ServiceNow's `internal_type`, which is what the dictionary actually
 * stores. The mapping is deliberately conservative: an internal type this list
 * does not recognise becomes `unknown` and keeps its raw type alongside, rather
 * than being bucketed into the nearest familiar kind. A field silently
 * classified as `string` when it is something else is exactly how a write goes
 * wrong quietly.
 */
export const SEMANTIC_TYPES = Object.freeze({
  string: 'string',
  translated_text: 'string',
  translated_field: 'string',
  conditions: 'string',
  char: 'string',
  wide_text: 'string',
  html: 'string',
  translated_html: 'string',
  url: 'string',
  email: 'string',
  phone_number: 'string',
  ip_addr: 'string',
  password: 'string',
  password2: 'string',
  script: 'script',
  script_plain: 'script',
  script_server: 'script',
  condition_string: 'string',

  integer: 'integer',
  decimal: 'decimal',
  float: 'decimal',
  longint: 'integer',
  percent_complete: 'decimal',
  order_index: 'integer',

  boolean: 'boolean',

  glide_date: 'date',
  glide_date_time: 'datetime',
  due_date: 'datetime',
  glide_time: 'time',
  glide_duration: 'duration',
  timer: 'duration',
  glide_utc_time: 'time',

  reference: 'reference',
  document_id: 'reference',
  glide_list: 'list',
  list: 'list',
  glide_var: 'variables',

  journal: 'journal',
  journal_input: 'journal',
  journal_list: 'journal',

  currency: 'currency',
  price: 'currency',

  choice: 'choice',
  sys_class_name: 'choice',
  table_name: 'table_name',
  field_name: 'field_name',
  domain_id: 'reference',
  domain_path: 'string',
  user_image: 'image',
  image: 'image',
  GUID: 'string',
});

/**
 * A field with a live choice list is a CHOICE, whatever its storage type says.
 *
 * `state`, `impact`, `urgency` and `priority` are all stored as integers and
 * are all choices, and treating them as free integers is how a write lands a
 * value the form would never offer. The dictionary answers "how is it stored";
 * the presence of `sys_choice` rows answers "what may it hold", and the second
 * is the question a writer has.
 */
function semanticType(field) {
  const base = SEMANTIC_TYPES[field.type] ?? null;
  if (field.choices && field.choices.length) return 'choice';
  return base;
}

/* ------------------------------------------------------------------ *
 * Derived fields
 * ------------------------------------------------------------------ */

/**
 * Fields the platform COMPUTES, which therefore cannot be written directly.
 *
 * SOURCED FROM THE LEDGER, not from this file's opinion. `priority` is here
 * because `priority-is-calculated` was measured — twice, live, at the cost of
 * two spent approvals — and the entry names that key so the claim can be traced
 * to its evidence. The dictionary does NOT express this: `priority` is not
 * marked read-only, which is the whole reason the trap exists (see the ledger's
 * `dictionary-readonly-does-not-predict-rest-writes`).
 *
 * That is why this is not a contradiction of live schema and is not resolved
 * against it. The dictionary answers "is this column writable"; the ledger
 * answers "does a REST write to it survive". Both are reported, separately, and
 * neither is allowed to overwrite the other — see `reconcile`'s note.
 *
 * The tables are the ones the ledger fact itself names.
 */
export const DERIVED_FIELDS = Object.freeze({
  priority: {
    inputs: ['impact', 'urgency'],
    tables: ['task', 'incident', 'problem', 'change_request', 'sc_task', 'sc_req_item'],
    factKey: 'priority-is-calculated',
    guidance: 'Set impact and urgency; do not send priority. A direct write is accepted and silently overwritten.',
  },
});

/**
 * Is this field computed on this table, and from what?
 *
 * Returns a `known` fact carrying the inputs, or `unknown` — never a bare
 * false, because "this field is not derived" and "nothing is known about
 * whether it is derived" are different answers and the second one should stop a
 * writer rather than encourage it.
 */
export function derivationOf(tableName, fieldName, { hierarchy = [] } = {}) {
  const rule = DERIVED_FIELDS[fieldName];
  if (!rule) return null;
  const chain = hierarchy.length ? hierarchy : [tableName];
  if (!rule.tables.some((t) => chain.includes(t))) return null;

  const ledgerFact = listFacts().find((f) => f.key === rule.factKey) || null;
  return fact(
    { derived: true, from: rule.inputs, guidance: rule.guidance },
    'ledger',
    {
      note: `${fieldName} is computed from ${rule.inputs.join(' + ')} on ${tableName}. `
        + 'The dictionary does not mark it read-only, so the schema alone will not tell you this.',
      evidence: ledgerFact
        ? { factKey: rule.factKey, provenance: ledgerFact.provenance, confidence: ledgerFact.confidence }
        : { factKey: rule.factKey, missing: true },
    },
  );
}

/* ------------------------------------------------------------------ *
 * Fields and tables
 * ------------------------------------------------------------------ */

/** One field, described semantically, with every answer sourced. */
export function describeField(field, { tableName, hierarchy }) {
  const kind = semanticType(field);
  const out = {
    name: field.name,
    label: field.label,
    rawType: field.type,
    kind: kind
      ? fact(kind, 'live_schema')
      : unknown(`the dictionary type "${field.type}" is not in the semantic vocabulary`, { evidence: { rawType: field.type } }),
    mandatory: fact(field.mandatory, 'live_schema'),
    readOnly: fact(field.readOnly, 'live_schema'),
    maxLength: field.maxLength === null ? null : fact(field.maxLength, 'live_schema'),
    definedOn: fact(field.definedOn, 'live_schema'),
    defaultValue: field.defaultValue === null ? null : fact(field.defaultValue, 'live_schema'),
    reference: null,
    choices: null,
    derived: derivationOf(tableName, field.name, { hierarchy }),
  };

  if (kind === 'reference' || kind === 'list') {
    out.reference = field.reference
      ? fact(field.reference, 'live_schema', { note: `${field.name} points at ${field.reference}` })
      : unknown(
        `${field.name} is a ${field.type} but the dictionary carries no reference target, so what it points at `
        + 'cannot be established. Do not assume a table and do not invent a sys_id.',
        { evidence: { field: field.name, rawType: field.type } },
      );
  }

  if (field.choices && field.choices.length) {
    out.choices = fact(field.choices, 'live_schema', {
      note: `${field.choices.length} active choice(s) read from sys_choice`,
    });
  } else if (kind === 'choice') {
    out.choices = unknown(`${field.name} looks like a choice field but no active sys_choice rows were readable`);
  }

  return out;
}

/**
 * A table, described semantically.
 *
 * Every failure mode is explicit. A table that does not exist is `unknown` and
 * says so; it is never an empty field list, because an empty field list reads
 * as "this table has no fields" and a model will act on that.
 */
export async function describeTable(tableName, { schemaFor = getSchema, hierarchyFor = getTableHierarchy, displayFieldFor = getDisplayField } = {}) {
  const name = String(tableName || '').trim();
  if (!/^[a-z0-9_]+$/i.test(name)) {
    return {
      table: name,
      status: STATUS.UNKNOWN,
      exists: unknown(`"${tableName}" is not a legal table name, so nothing about it can be established`),
      fields: [],
    };
  }

  let schema;
  try {
    schema = await schemaFor(name);
  } catch (err) {
    return {
      table: name,
      status: STATUS.UNKNOWN,
      exists: unknown(`the schema for ${name} could not be read (${err.message}), so nothing about it is known`,
        { evidence: { error: err.message } }),
      fields: [],
    };
  }

  if (!schema || !schema.fields?.length) {
    return {
      table: name,
      status: STATUS.UNKNOWN,
      exists: unknown(
        `no dictionary rows were returned for ${name}. That may mean the table does not exist or that it is not `
        + 'readable on this connection — the two are different, and neither is "it has no fields".',
      ),
      fields: [],
    };
  }

  let hierarchy = schema.hierarchy || [name];
  try { hierarchy = await hierarchyFor(name); } catch { /* the schema's own chain stands */ }

  let display = null;
  try { display = fact(await displayFieldFor(name), 'live_schema'); }
  catch (err) { display = unknown(`the display field for ${name} could not be read (${err.message})`); }

  const fields = schema.fields.map((f) => describeField(f, { tableName: name, hierarchy }));

  return {
    table: name,
    status: STATUS.KNOWN,
    exists: fact(true, 'live_schema', { note: `${schema.fields.length} field(s) merged across ${hierarchy.length} table(s)` }),
    hierarchy: fact(hierarchy, 'live_schema'),
    extends: hierarchy.length > 1 ? fact(hierarchy[1], 'live_schema') : null,
    displayField: display,
    fields,
    references: fields.filter((f) => f.reference && f.reference.status === STATUS.KNOWN)
      .map((f) => ({ field: f.name, table: f.reference.value, source: f.reference.source })),
    derivedFields: fields.filter((f) => f.derived).map((f) => ({ field: f.name, from: f.derived.value.from })),
  };
}

/** One field of one table, or an honest absence. */
export async function describeTableField(tableName, fieldName, opts = {}) {
  const t = await describeTable(tableName, opts);
  if (t.status !== STATUS.KNOWN) return { table: tableName, field: fieldName, status: t.status, exists: t.exists };
  const found = t.fields.find((f) => f.name === fieldName);
  if (!found) {
    return {
      table: tableName,
      field: fieldName,
      status: STATUS.UNKNOWN,
      // The field list IS complete — that is what makes absence a conclusion
      // rather than a gap, and it is the basis of operating rule 17.
      exists: fact(false, 'live_schema', {
        note: `${tableName} has no field "${fieldName}". The merged dictionary list is complete across the `
          + `hierarchy, so this is an absence rather than a failed read. Do not create it and do not substitute `
          + 'a similar one.',
      }),
    };
  }
  return { table: tableName, field: fieldName, status: STATUS.KNOWN, exists: fact(true, 'live_schema'), ...found };
}

/* ------------------------------------------------------------------ *
 * References
 * ------------------------------------------------------------------ */

/**
 * Resolve a human string against a reference target.
 *
 * THE INVARIANT: never pick the first result because it is convenient.
 *
 * `referenceLookup` already ranks and reports `matchType`, and the ledger
 * carries what it cost to learn that — searching sys_user for "admin" returned
 * "Certification Admin" while the user whose user_name IS admin never surfaced,
 * and two incidents were created against the wrong caller. So anything that is
 * not an exact or id match comes back `ambiguous` WITH its candidates, and the
 * caller has to put them to a human.
 */
export async function resolveReference(referenceTable, query, { lookup = referenceLookup, limit = 10 } = {}) {
  const target = String(referenceTable || '').trim();
  if (!target) {
    return unknown('no reference table was given, so nothing can be resolved. Do not invent a sys_id.');
  }

  let rows;
  try {
    rows = await lookup(target, String(query ?? ''), limit);
  } catch (err) {
    return unknown(`${target} could not be searched (${err.message}), so "${query}" is unresolved`,
      { source: 'live_state', evidence: { table: target, error: err.message } });
  }

  const list = Array.isArray(rows) ? rows : (rows?.records ?? []);
  if (!list.length) {
    return unknown(`nothing in ${target} matches "${query}". A miss is not a licence to invent one.`,
      { source: 'live_state', evidence: { table: target, query } });
  }

  const top = list[0];
  const matchType = top.matchType ?? top.match_type ?? null;
  const exact = matchType === 'exact' || matchType === 'id';

  if (!exact || list.length > 1) {
    /*
     * More than one row, or a top hit that was GUESSED from a partial string.
     * Both are ambiguous, and the second is the dangerous one — it looks like
     * an answer. The candidates travel with the verdict so the caller can name
     * them rather than describing the problem in the abstract.
     */
    if (!exact) {
      return ambiguous(
        list.slice(0, limit),
        `"${query}" did not match ${target} exactly (matchType: ${matchType ?? 'unranked'}). `
        + 'It may be used for a read, but it must be shown to the user before it enters a mutation payload.',
      );
    }
    // An exact top hit beside other partial matches is still resolved, but the
    // rivals are carried so a caller can show its work.
    return fact(top, 'live_state', {
      note: `exact match in ${target}, with ${list.length - 1} weaker candidate(s) also matching`,
      evidence: { candidates: list.slice(1, limit) },
    });
  }

  return fact(top, 'live_state', { note: `exact match in ${target}` });
}
