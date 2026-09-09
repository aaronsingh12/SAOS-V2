import { table } from './client.js';
import { registerInstanceScopedCache } from './instance-binding.js';

/**
 * Reference/table handling core.
 *
 * ServiceNow tables inherit (incident extends task extends...), and dictionary
 * entries for inherited fields live on the parent table. To describe a table
 * "top to bottom" we walk sys_db_object.super_class, then merge sys_dictionary
 * rows across the whole chain, preferring the most-derived override.
 */

const hierarchyCache = new Map();
const schemaCache = new Map();
const displayFieldCache = new Map();
const existsCache = new Map();

export function clearSchemaCaches() {
  hierarchyCache.clear();
  schemaCache.clear();
  displayFieldCache.clear();
  existsCache.clear();
}

/*
 * SESSION 1 / WI-4 — DOES THIS TABLE EXIST ON THE BOUND INSTANCE?
 *
 * The Table API answers 400 "Invalid table" to a write against a name that is
 * not a table, so the platform would have refused `create_record` on
 * `sys_flow` eventually — after a human had approved it. The question is asked
 * here instead, before the card: one `sys_db_object` read, cached per name for
 * the life of the binding (the switch handler clears it with the rest).
 *
 * `_setTableExistsForTests` replaces the INPUT (the answer) so the record
 * tools and the planner can be exercised offline; it cannot make a refusal
 * disappear for a table the override says is absent.
 */
let tableExistsOverride = null;
export function _setTableExistsForTests(fn) { tableExistsOverride = typeof fn === 'function' ? fn : null; }

export async function tableExists(t) {
  const name = String(t ?? '').trim();
  if (!name) return false;
  if (tableExistsOverride) return Boolean(await tableExistsOverride(name));
  if (schemaCache.has(name) || hierarchyCache.has(name)) return true;
  if (existsCache.has(name)) return existsCache.get(name);
  const rows = await table.query('sys_db_object', { query: `name=${name}`, fields: 'name', limit: 1, display: 'false' });
  const found = rows.length > 0;
  existsCache.set(name, found);
  return found;
}

/*
 * B5 — a schema cache is about ONE instance.
 *
 * Consulted after a switch it answers with fields that are all real and none of
 * which describe the instance the user is looking at. Registered so the switch
 * handler empties it without this module having to know a switch happened.
 */
registerInstanceScopedCache('schema-cache', clearSchemaCaches);

export async function getTableHierarchy(t) {
  if (hierarchyCache.has(t)) return hierarchyCache.get(t);
  const chain = [t];
  let current = t;
  for (let i = 0; i < 10; i++) {
    const rows = await table.query('sys_db_object', {
      query: `name=${current}`,
      fields: 'name,super_class.name',   // dot-walk to get the parent's table name, not its label
      display: 'false',
      limit: 1,
    });
    const parent = rows[0]?.['super_class.name'];
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
    current = parent;
  }
  hierarchyCache.set(t, chain);
  return chain;
}

export async function getSchema(t) {
  if (schemaCache.has(t)) return schemaCache.get(t);
  const chain = await getTableHierarchy(t);
  const inClause = chain.join(',');

  const dictRows = await table.query('sys_dictionary', {
    query: `nameIN${inClause}^elementISNOTEMPTY^ORDERBYelement`,
    fields: 'element,column_label,internal_type,reference.name,max_length,mandatory,read_only,default_value,name',
    display: 'false',
    limit: 800,
  });

  // Most-derived definition wins (chain index 0 = the table itself).
  const byElement = new Map();
  for (const r of dictRows) {
    const rank = chain.indexOf(r.name);
    const existing = byElement.get(r.element);
    if (!existing || rank < existing._rank) {
      byElement.set(r.element, {
        name: r.element,
        label: r.column_label || r.element,
        type: r.internal_type,
        reference: r['reference.name'] || null,
        maxLength: r.max_length ? Number(r.max_length) : null,
        mandatory: r.mandatory === 'true',
        readOnly: r.read_only === 'true',
        defaultValue: r.default_value || null,
        definedOn: r.name,
        _rank: rank,
      });
    }
  }

  // Choice lists (state, priority, ...). Most-derived table's set wins per element.
  let choiceRows = [];
  try {
    choiceRows = await table.query('sys_choice', {
      query: `nameIN${inClause}^inactive=false^language=en^ORDERBYsequence`,
      fields: 'name,element,label,value,sequence',
      display: 'false',
      limit: 1000,
    });
  } catch { /* non-fatal */ }
  const choicesByElement = new Map();
  for (const c of choiceRows) {
    const rank = chain.indexOf(c.name);
    const cur = choicesByElement.get(c.element);
    if (!cur || rank < cur.rank) {
      if (!cur || cur.rank !== rank) choicesByElement.set(c.element, { rank, table: c.name, items: [] });
    }
    const slot = choicesByElement.get(c.element);
    if (slot.table === c.name) slot.items.push({ label: c.label, value: c.value });
  }

  const fields = [...byElement.values()]
    .map(({ _rank, ...f }) => ({ ...f, choices: choicesByElement.get(f.name)?.items ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const schema = { table: t, hierarchy: chain, fields };
  schemaCache.set(t, schema);
  return schema;
}

/** The field ServiceNow marks display=true for a table (walking the hierarchy), with sane fallbacks. */
export async function getDisplayField(t) {
  if (displayFieldCache.has(t)) return displayFieldCache.get(t);
  const chain = await getTableHierarchy(t);
  let element = null;
  try {
    const rows = await table.query('sys_dictionary', {
      query: `nameIN${chain.join(',')}^display=true^elementISNOTEMPTY`,
      fields: 'element,name',
      display: 'false',
      limit: 10,
    });
    for (const c of chain) {
      const hit = rows.find((r) => r.name === c);
      if (hit) { element = hit.element; break; }
    }
  } catch { /* fall through */ }
  if (!element) {
    const schema = await getSchema(t);
    for (const cand of ['number', 'name', 'title', 'short_description', 'u_name']) {
      if (schema.fields.some((f) => f.name === cand)) { element = cand; break; }
    }
  }
  element = element || 'sys_id';
  displayFieldCache.set(t, element);
  return element;
}

/** Typeahead lookup for any reference field: returns [{ sys_id, display }]. */
/**
 * WI-4 — key fields worth an EXACT match, per table.
 *
 * The display field is what a human reads; the key field is what they typed.
 * For `sys_user` those are different columns and the difference is the whole
 * defect: the display field is `name`, so "admin" contains-matched
 * "Certification Admin", "CMDB Admin", "Credential Admin"… and the real admin —
 * `user_name = admin`, displayed as "System Administrator" — never surfaced,
 * because `user_name` was not searched at all.
 *
 * Extendable by design: an entry here is a table whose key differs from its
 * display, not an exhaustive list. Anything absent falls back to the display
 * field plus `name`, which is the old behaviour with ranking added.
 */
const KEY_FIELDS = {
  sys_user: ['user_name', 'name', 'email'],
  sys_scope: ['scope', 'name'],
  sys_app: ['scope', 'name'],
  sys_user_group: ['name'],
  sys_db_object: ['name', 'label'],
  cmdb_ci: ['name'],
  sc_category: ['title'],
  sys_choice: ['value', 'label'],
};

/**
 * Tables where a sys_id can be a literal word rather than 32 hex.
 *
 * `sys_scope`'s Global row has `sys_id = "global"` — measured, and it is why
 * `lookup_reference("global", "sys_scope")` returned "Enhanced Global Search UI"
 * while the record actually wanted was sitting at a sys_id equal to the search
 * term itself.
 */
const LITERAL_ID_TABLES = new Set(['sys_scope', 'sys_app', 'sys_package']);

const isSysId = (v) => /^[0-9a-f]{32}$/i.test(String(v || ''));

/** exact key > exact display > starts-with > contains. Lower sorts first. */
const RANK = { id: 0, exact: 1, 'exact-display': 2, 'starts-with': 3, contains: 4 };

async function keyFieldsFor(t) {
  const df = await getDisplayField(t);
  const configured = KEY_FIELDS[t];

  // A curated entry names columns that were chosen for this table on purpose.
  if (configured) return { df, keys: [...new Set([...configured, df])] };

  /*
   * PHASE 13 — A FIELD THAT DOES NOT EXIST MATCHES EVERYTHING.
   *
   * Measured on the live instance. `incident` has no KEY_FIELDS entry, so this
   * fallback asked for `name` — a column `incident` does not have. ServiceNow
   * did not reject the query: an unknown field in an encoded query is SILENTLY
   * DROPPED, and what remains matches every row. So
   *
   *     referenceLookup('incident', 'INC0010001')
   *
   * returned six records — five unrelated incidents ranked `exact` because
   * `name=INC0010001` matched all of them, ahead of the one true
   * `exact-display` hit — and resolved to INC0000009.
   *
   * The ambiguity verdict caught it, so nothing was written to the wrong
   * incident. But resolving an incident by its number is the most ordinary
   * thing anyone will ask for, and it could not work at all.
   *
   * Only the SPECULATIVE half of the fallback is checked. `name` is a guess
   * that most tables happen to satisfy; the display field is not, because
   * `getDisplayField` read it off this table's own dictionary. If the schema
   * cannot be read, the guess is dropped rather than sent — an unverified
   * column is exactly what caused the defect.
   */
  if (!df) return { df, keys: [] };
  let hasName = false;
  try {
    const schema = await getSchema(t);
    hasName = schema.fields.some((f) => f.name === 'name');
  } catch { /* unreadable schema: do not speculate */ }

  return { df, keys: hasName ? [...new Set([df, 'name'])] : [df] };
}

/**
 * Resolve a reference by search term, ranked so an exact key match wins.
 *
 * Every result carries `matchType`, and the set carries `ambiguous` when the
 * top hit is not exact — which the agent is required to confirm before using in
 * a mutation payload. Read-only use may proceed: the cost of a wrong lookup in
 * a report is a wrong sentence; in a write it is the wrong record, silently.
 */
export async function referenceLookup(t, q = '', limit = 15) {
  const { df, keys } = await keyFieldsFor(t);
  const term = String(q || '').trim();

  if (!term) {
    const rows = await table.query(t, { query: `ORDERBY${df}`, fields: `sys_id,${[...new Set([df, ...keys])].join(',')}`, display: 'false', limit });
    return decorate(rows.map((r) => ({ sys_id: r.sys_id, display: r[df] || r.sys_id, matchType: 'browse', row: r })), df, keys, term);
  }

  const fields = `sys_id,${[...new Set([df, ...keys])].join(',')}`;
  const seen = new Map();
  const add = (rows, why) => {
    for (const r of rows || []) if (!seen.has(r.sys_id)) seen.set(r.sys_id, { sys_id: r.sys_id, display: r[df] || r.sys_id, matchType: why, row: r });
  };

  /*
   * A direct get FIRST, when the term could be an id.
   *
   * Covers both the 32-hex case and the literal one — `sys_scope`'s Global row
   * has `sys_id = "global"`, so the search term IS the id.
   */
  if (isSysId(term) || LITERAL_ID_TABLES.has(t)) {
    try {
      const direct = await table.query(t, { query: `sys_id=${term}`, fields, display: 'false', limit: 1 });
      add(direct, 'id');
    } catch { /* not an id on this table; the ranked search still runs */ }
  }

  // Exact on every key field, in configured order, then the loose search.
  for (const k of keys) {
    try { add(await table.query(t, { query: `${k}=${term}`, fields, display: 'false', limit: 5 }), k === df ? 'exact-display' : 'exact'); }
    catch { /* a key field that does not exist on this table is skipped */ }
  }
  try { add(await table.query(t, { query: `${df}STARTSWITH${term}^ORDERBY${df}`, fields, display: 'false', limit }), 'starts-with'); } catch { /* noop */ }
  try { add(await table.query(t, { query: `${df}LIKE${term}^ORDERBY${df}`, fields, display: 'false', limit }), 'contains'); } catch { /* noop */ }

  const ranked = [...seen.values()].sort((a, b) => {
    const d = (RANK[a.matchType] ?? 9) - (RANK[b.matchType] ?? 9);
    return d !== 0 ? d : String(a.display).localeCompare(String(b.display));   // stable secondary sort
  }).slice(0, limit);

  return decorate(ranked, df, keys, term);
}

/**
 * Attach the key value that matched and the ambiguity flag.
 *
 * `ambiguous` is about the TOP result only: if the best thing found was a
 * contains-match, the caller resolved a name, not a record.
 */
function decorate(results, df, keys, term) {
  const out = results.map(({ row, ...r }) => {
    const keyField = keys.find((k) => row?.[k] !== undefined && row[k] !== '' && row[k] !== null);
    return {
      ...r,
      ...(keyField && keyField !== df ? { key: keyField, keyValue: row[keyField] } : {}),
    };
  });
  const top = out[0];
  /*
   * Ambiguity is about whether a RECORD was resolved, not about which column
   * matched. An exact hit on the display field is still exact when that field
   * is the table's key — `sys_user_group.name` is both, and calling "Network"
   * ambiguous would make the agent confirm something it got exactly right.
   *
   * What IS ambiguous: no exact hit at all, or two records tying at the same
   * exact rank — where the term matched, but matched more than one thing.
   */
  const EXACTISH = new Set(['id', 'exact', 'exact-display']);
  const exactHits = out.filter((r) => EXACTISH.has(r.matchType));
  const ambiguous = Boolean(term) && (exactHits.length !== 1 || !EXACTISH.has(top?.matchType));
  // Carried as properties on the array so existing callers that iterate it are
  // untouched, while a caller that cares can read the verdict.
  return Object.assign(out, {
    ambiguous,
    resolved: top ? { sys_id: top.sys_id, display: top.display, matchType: top.matchType } : null,
    ...(ambiguous && out.length
      ? { confirmBefore: 'Do not use this in a mutation payload without confirming it with the user — no single exact match was found.' }
      : {}),
  });
}

/** Table picker (for record producers, list collectors, flow triggers): searches sys_db_object by label or name. */
export async function tableLookup(q = '', limit = 15) {
  const query = q
    ? `labelLIKE${q}^ORnameLIKE${q}^ORDERBYlabel`
    : 'ORDERBYlabel';
  const rows = await table.query('sys_db_object', { query, fields: 'name,label', display: 'false', limit });
  return rows.map((r) => ({ name: r.name, label: r.label || r.name }));
}

/**
 * D-7 — the compact schema, and why the full one cannot be what the agent reads.
 *
 * MEASURED against dev442675: `incident` inherits from `task` and carries 91
 * fields. Serialised in full that is 29,152 characters — about 8,330 estimated
 * tokens. The agent's entire history budget at the time was 5,452, so ONE
 * schema read was 153% of everything the conversation was allowed to remember.
 *
 * The orchestrator's 8,000-character result cap hid this rather than fixing it,
 * and hid it in the worst possible way: fields are sorted alphabetically, so
 * the cut landed after `company` and the agent saw 26 of 91 fields. It never
 * saw `description`, `priority`, `state`, `urgency` or `assignment_group` —
 * and, because `u_` fields sort last, it could never observe that a custom
 * field was ABSENT. It was being asked to check for fields it was structurally
 * incapable of seeing.
 *
 * So the diet is not a size optimisation, it is a correctness fix. Compact mode
 * keeps what the agent reasons with — every field name, its type, what it
 * references, whether it is mandatory — and drops what it almost never needs at
 * read time: labels, max lengths, defaults, and the choice VALUES, which are
 * counted instead of listed. Choices come back on request, per field, because
 * a task mentions two or three of them and pays for ninety-eight.
 */
function compactField(f) {
  const bits = [`${f.name}: ${f.type || 'unknown'}`];
  if (f.reference) bits.push(`-> ${f.reference}`);
  if (f.mandatory) bits.push('*mandatory');
  if (f.readOnly) bits.push('ro');
  if (f.choices?.length) bits.push(`+${f.choices.length} choices`);
  return bits.join(' ');
}

/**
 * `expand` names the fields whose choice VALUES are wanted in full. Anything
 * not named is counted only. Unknown names are reported rather than ignored —
 * asking to expand a field that does not exist is exactly the signal the agent
 * needs, and silently returning nothing reads as "this field has no choices".
 */
export function toCompactSchema(schema, { expand = [] } = {}) {
  const wanted = new Set((expand || []).map((s) => String(s).trim()).filter(Boolean));
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  const expanded = {};
  const unknown = [];
  for (const name of wanted) {
    const f = byName.get(name);
    if (!f) { unknown.push(name); continue; }
    expanded[name] = f.choices?.length
      ? f.choices.map((c) => `${c.value} = ${c.label}`)
      : '(no choice list on this field)';
  }

  const out = {
    table: schema.table,
    hierarchy: schema.hierarchy,
    fieldCount: schema.fields.length,
    legend: 'name: type [-> referenced table] [*mandatory] [ro = read-only] [+N choices]',
    // Every field name, always. This list is what makes "that field does not
    // exist on this table" a conclusion the agent can actually reach.
    fields: schema.fields.map(compactField),
  };
  if (Object.keys(expanded).length) out.choices = expanded;
  if (unknown.length) {
    out.expandNotFound = unknown;
    out.expandNote =
      `These field names do not exist on ${schema.table}: ${unknown.join(', ')}. ` +
      'The fields list above is complete, so treat them as absent rather than assuming they were omitted.';
  }
  if (!Object.keys(expanded).length) {
    out.note = 'Choice values are counted, not listed. To see them, call get_table_schema again with expand: ["state","priority"] naming only the fields you need.';
  }
  return out;
}
