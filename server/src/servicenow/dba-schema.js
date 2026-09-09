import { metaQuery, cached } from './dba-metadata.js';
import { getTableHierarchy, getDisplayField } from './schema.js';
import { runServerScript } from './execution-harness.js';

/**
 * DBA Layer 1 — Schema Intelligence. Read-only, in full.
 *
 * This layer answers "what IS this schema" so Layer 2 can answer "what breaks
 * if I change it". Nothing here writes, and nothing here is allowed to guess:
 * a question this layer cannot answer from the instance must come back as an
 * explicit unknown, because every later layer's safety decision is built on
 * these answers.
 *
 * It sits on top of `schema.js` rather than beside it. `schema.js` already
 * walks `super_class` and merges the dictionary across the chain for the agent's
 * read path, and duplicating that would give NHA two schema readers that can
 * disagree. What this module adds is the DBA-specific half: origin tables,
 * overrides, inbound references, classification, relationships, indexes, and
 * the derived schema map.
 *
 * ── MEASURED on dev428633, 2026-08-31 ────────────────────────────────────────
 *
 *  - `sys_dictionary.reference` stores the TABLE NAME as its value, not a
 *    sys_id (`{value: "sys_user", display_value: "User"}`). So inbound
 *    references are `sys_dictionary` where `reference=<name>` — a cheap query,
 *    where a sys_id would have needed a lookup first.
 *
 *  - `sys_db_object.super_class` stores a SYS_ID (the parent's sys_db_object
 *    row), so walking DOWN needs the parent's sys_id while walking UP can
 *    dot-walk `super_class.name`. `task` has 47 direct children.
 *
 *  - `use_reference_qualifier` takes exactly three values instance-wide:
 *    `simple`, `dynamic`, `advanced`. It is `simple` on a great many fields
 *    that have NO qualifier at all, so the kind is only meaningful when a
 *    qualifier is actually present — reporting "simple qualifier" for a field
 *    whose `reference_qual` is empty would be a fact-shaped nothing.
 *
 *  - `sys_dictionary_override` carries both a value and a `<field>_override`
 *    boolean per attribute. `mandatory: "false"` on an override row is INERT
 *    unless `mandatory_override` is true. Reading the value alone reports
 *    overrides that are not overriding anything.
 *
 *  - `incident` has zero `sys_update_version` rows and zero
 *    `sys_metadata_customization` rows for its `sys_db_object` record — it is
 *    baseline, which is exactly what a correct classifier must say about it.
 */

const REFERENCE_TYPES = new Set(['reference', 'glide_list', 'document_id', 'domain_id']);

/** Fields the Table API returns for a dictionary entry, in one place so a typo fails loudly once. */
const DICT_FIELDS = [
  'name', 'element', 'column_label', 'internal_type', 'reference', 'reference_qual',
  'use_reference_qualifier', 'dynamic_ref_qual', 'reference_qual_condition',
  'max_length', 'mandatory', 'read_only', 'default_value', 'display', 'choice',
  'unique', 'active', 'virtual', 'attributes', 'sys_scope', 'sys_package', 'sys_id', 'sys_update_name',
].join(',');

const TABLE_FIELDS = 'sys_id,name,label,super_class,super_class.name,is_extendable,sys_scope,sys_package,sys_update_name,sys_class_name,extension_model,user_role,create_access,read_access,update_access,delete_access';

/* ── the table itself ─────────────────────────────────────────────────────── */

/**
 * Cached, because a schema-map walk revisits the same tables repeatedly and a
 * dictionary scan is the expensive call in this module. Read-only paths only —
 * `dba-metadata.cached` bypasses the cache for anything declaring `forWrite`.
 */
async function tableRow(name) {
  return cached(`dba:table-row:${name}`, async () => {
    const rows = await metaQuery('sys_db_object', { query: `name=${name}`, fields: TABLE_FIELDS, max: 1 });
    return rows[0] || null;
  });
}

/**
 * `dba.getTable` — the sys_db_object record, its extends chain, scope and
 * numbering, with a classification verdict attached.
 */
export async function getTable(name) {
  const row = await tableRow(name);
  if (!row) {
    return {
      table: name,
      exists: false,
      note: `No sys_db_object row named "${name}" exists on this instance. It is not a table here — do not `
          + 'assume it is present under a different label, and do not proceed as though it might be.',
    };
  }
  const chain = await getTableHierarchy(name);
  const [children, numbering, classification] = await Promise.all([
    metaQuery('sys_db_object', { query: `super_class=${row.sys_id}`, fields: 'name,label', max: 2000 }),
    // `maximum_digits`, not `maximum` — the column list was measured. Writing
    // the plausible name cost a loud 502 from assertFieldsHonoured rather than
    // a silently absent key, which is the guard doing its job on its author.
    metaQuery('sys_number', { query: `category=${name}`, fields: 'category,prefix,number,maximum_digits', max: 5 }),
    classify(name),
  ]);
  return {
    table: name,
    exists: true,
    sys_id: row.sys_id,
    label: row.label,
    extends: row['super_class.name'] || null,
    extendsChain: chain,
    isExtendable: row.is_extendable === 'true',
    extensionModel: row.extension_model || null,
    directChildren: children.map((c) => c.name),
    directChildCount: children.length,
    scope: row.sys_scope,
    package: row.sys_package,
    accessControlledBy: row.user_role || null,
    autoNumber: numbering[0]
      ? { prefix: numbering[0].prefix, next: numbering[0].number, maximumDigits: numbering[0].maximum_digits }
      : null,
    classification,
  };
}

/** `dba.getHierarchy` — up via super_class, down via children, to a stated depth. */
export async function getHierarchy(name, { depth = 2 } = {}) {
  const row = await tableRow(name);
  if (!row) return { table: name, exists: false };
  const up = await getTableHierarchy(name);

  let truncated = false;
  const descend = async (parentSysId, level) => {
    if (level > depth) { truncated = true; return []; }
    const kids = await metaQuery('sys_db_object', {
      query: `super_class=${parentSysId}`, fields: 'sys_id,name,label', max: 2000,
    });
    return Promise.all(kids.map(async (k) => ({
      table: k.name,
      label: k.label,
      children: await descend(k.sys_id, level + 1),
    })));
  };

  return {
    table: name,
    exists: true,
    // Index 0 is the table itself; the last entry is the root of the chain.
    extendsChain: up,
    parent: up[1] || null,
    root: up[up.length - 1],
    children: await descend(row.sys_id, 1),
    depthRequested: depth,
    ...(truncated ? { depthTruncated: true, note: `The tree is cut at depth ${depth}; deeper children exist and are NOT listed.` } : {}),
  };
}

/* ── fields ───────────────────────────────────────────────────────────────── */

/*
 * Pure, and exported, so the offline suite can assert them — the same reason
 * client.js exports diagnoseFailure. What matters about these three is WHICH
 * verdict they reach from a given row, and that is exactly what a live-only
 * test cannot pin down.
 */
export function shapeField(r, chain) {
  const hasQualifier = Boolean(r.reference_qual || r.dynamic_ref_qual || r.reference_qual_condition);
  return {
    element: r.element,
    label: r.column_label || r.element,
    type: r.internal_type,
    reference: r.reference || null,
    // Only reported when a qualifier actually exists — `use_reference_qualifier`
    // reads "simple" on a great many fields that have none, and echoing that
    // would be a fact-shaped nothing.
    qualifier: hasQualifier
      ? {
        kind: r.use_reference_qualifier || 'simple',
        simple: r.reference_qual || null,
        condition: r.reference_qual_condition || null,
        dynamic: r.dynamic_ref_qual || null,
      }
      : null,
    maxLength: r.max_length ? Number(r.max_length) : null,
    mandatory: r.mandatory === 'true',
    readOnly: r.read_only === 'true',
    display: r.display === 'true',
    unique: r.unique === 'true',
    active: r.active !== 'false',
    virtual: r.virtual === 'true',
    defaultValue: r.default_value || null,
    // The table whose sys_dictionary row defines this column. For an inherited
    // field this is an ancestor, and it is the answer to "where does this field
    // actually come from?".
    definedOn: r.name,
    inherited: r.name !== chain[0],
    sys_id: r.sys_id,
  };
}

/**
 * Every dictionary row across the inheritance chain, most-derived winning.
 *
 * A field redefined on a child table shadows the ancestor's row; both are kept
 * so `getField` can report the shadowing rather than hiding it.
 */
async function chainDictionary(name) {
  return cached(`dba:chain-dict:${name}`, async () => {
    const chain = await getTableHierarchy(name);
    const rows = await metaQuery('sys_dictionary', {
      query: `nameIN${chain.join(',')}^elementISNOTEMPTY`,
      fields: DICT_FIELDS,
      max: 5000,
    });
    return { chain, rows, truncated: rows.truncated === true };
  });
}

/** `dba.listFields` */
export async function listFields(name, { includeInherited = true } = {}) {
  const row = await tableRow(name);
  if (!row) return { table: name, exists: false };
  const { chain, rows, truncated } = await chainDictionary(name);

  const byElement = new Map();
  for (const r of rows) {
    const rank = chain.indexOf(r.name);
    const cur = byElement.get(r.element);
    if (!cur || rank < cur.rank) byElement.set(r.element, { rank, row: r });
  }

  let fields = [...byElement.values()]
    .sort((a, b) => a.row.element.localeCompare(b.row.element))
    .map((e) => shapeField(e.row, chain));
  if (!includeInherited) fields = fields.filter((f) => !f.inherited);

  return {
    table: name,
    exists: true,
    extendsChain: chain,
    includeInherited,
    fieldCount: fields.length,
    truncated,
    ...(truncated ? { truncatedNote: 'The dictionary scan hit its row ceiling; this field list is INCOMPLETE. Do not conclude a field is absent from it.' } : {}),
    fields,
  };
}

/** `dba.getField` — one column, with its true origin and any child overrides. */
export async function getField(name, element) {
  const { chain, rows } = await chainDictionary(name);
  const matches = rows.filter((r) => r.element === element);
  if (!matches.length) {
    return {
      table: name, element, exists: false,
      extendsChain: chain,
      note: `"${element}" is not defined on ${name} or on any table it extends (${chain.join(' -> ')}). `
          + 'The chain was read in full, so treat the field as absent rather than as possibly-unlisted.',
    };
  }
  matches.sort((a, b) => chain.indexOf(a.name) - chain.indexOf(b.name));
  const effective = matches[0];

  // The ORIGIN is the highest ancestor that defines it — the last entry once
  // sorted most-derived-first, which is the answer to "where does this field
  // actually come from?".
  const origin = matches[matches.length - 1];

  const overrides = await metaQuery('sys_dictionary_override', {
    query: `element=${element}^base_tableIN${chain.join(',')}`,
    fields: 'name,base_table,element,mandatory,mandatory_override,read_only,read_only_override,default_value,default_value_override,reference_qual,reference_qual_override,attributes,attributes_override,calculation,calculation_override,display_override,dependent,dependent_override',
    max: 500,
  });

  return {
    table: name,
    element,
    exists: true,
    extendsChain: chain,
    effective: shapeField(effective, chain),
    originTable: origin.name,
    definedOn: matches.map((m) => m.name),
    shadowed: matches.length > 1
      ? `Defined on ${matches.length} tables in the chain (${matches.map((m) => m.name).join(', ')}). The most-derived definition wins.`
      : null,
    overrides: overrides.map(shapeOverride).filter((o) => o.overriddenAttributes.length),
    inertOverrideRows: overrides.length - overrides.map(shapeOverride).filter((o) => o.overriddenAttributes.length).length,
  };
}

/**
 * An override row is only overriding what its `<attr>_override` flag says.
 *
 * MEASURED: rows carry `mandatory: "false"` / `read_only: "false"` with every
 * `_override` flag false — a real record that changes nothing. Reporting its
 * values as overrides would invent configuration that is not in effect.
 */
export function shapeOverride(o) {
  const ATTRS = ['mandatory', 'read_only', 'default_value', 'reference_qual', 'attributes', 'calculation', 'dependent'];
  const overridden = ATTRS.filter((a) => o[`${a}_override`] === 'true');
  return {
    childTable: o.name,
    baseTable: o.base_table,
    element: o.element,
    overriddenAttributes: overridden,
    values: Object.fromEntries(overridden.map((a) => [a, o[a]])),
    ...(o.display_override === 'true' ? { displayOverridden: true } : {}),
  };
}

/* ── references and relationships ─────────────────────────────────────────── */

/** `dba.getReferences` — what this table points at, and what points at it. */
export async function getReferences(name) {
  const row = await tableRow(name);
  if (!row) return { table: name, exists: false };
  const { chain, rows } = await chainDictionary(name);

  const outbound = rows
    .filter((r) => REFERENCE_TYPES.has(r.internal_type) && r.reference)
    .map((r) => ({ element: r.element, type: r.internal_type, to: r.reference, definedOn: r.name, inherited: r.name !== name }))
    .sort((a, b) => a.element.localeCompare(b.element));

  // Inbound is instance-wide and can be large — `reference` holds the table
  // NAME, so this is one query rather than a lookup plus a query.
  const inboundRows = await metaQuery('sys_dictionary', {
    query: `reference=${name}^elementISNOTEMPTY`,
    fields: 'name,element,internal_type,reference,mandatory,reference_cascade_rule',
    max: 5000,
  });

  return {
    table: name,
    exists: true,
    extendsChain: chain,
    outbound,
    outboundCount: outbound.length,
    inbound: inboundRows.map((r) => ({
      table: r.name,
      element: r.element,
      type: r.internal_type,
      mandatory: r.mandatory === 'true',
      cascadeRule: r.reference_cascade_rule || null,
    })),
    inboundCount: inboundRows.length,
    inboundTruncated: inboundRows.truncated === true,
    /*
     * C-1: this number was reported as a total off a paging loop that stopped
     * at a short page — 3999 of 4401, asserted complete. The count is now
     * reconciled against /api/now/stats inside metaQuery, and the reconciliation
     * is surfaced HERE rather than left in the primitive, because this is the
     * layer whose output a caller quotes.
     */
    inboundComplete: inboundRows.complete === true,
    inboundExpectedTotal: inboundRows.expectedTotal ?? null,
    ...(inboundRows.incompleteReason ? { inboundIncompleteReason: inboundRows.incompleteReason } : {}),
    ...(inboundRows.countDriftNote ? { inboundCountDrift: inboundRows.countDrift, inboundCountDriftNote: inboundRows.countDriftNote } : {}),
    ...(inboundRows.truncated
      ? { inboundNote: 'The inbound scan did not complete — the count is a FLOOR. Do not report it as the total number of references.' }
      : {}),
    note: 'Inbound references are the implicit relationships: a reference field IS the relationship, with no '
        + 'sys_relationship record involved. Explicit relationships come from dba_get_relationships.',
  };
}

/** `dba.resolveReference` — where one reference field points, and how it is filtered. */
export async function resolveReference(name, element) {
  const field = await getField(name, element);
  if (!field.exists) return field;
  const f = field.effective;
  if (!REFERENCE_TYPES.has(f.type)) {
    return {
      table: name, element, isReference: false, type: f.type,
      note: `${name}.${element} is a ${f.type}, not a reference field, so it points at nothing.`,
    };
  }
  const target = f.reference;
  const [displayField, targetRow] = await Promise.all([getDisplayField(target), tableRow(target)]);
  return {
    table: name,
    element,
    isReference: true,
    type: f.type,
    referencedTable: target,
    referencedTableExists: Boolean(targetRow),
    referencedTableLabel: targetRow?.label ?? null,
    displayField,
    qualifier: f.qualifier,
    qualifierKind: f.qualifier?.kind ?? 'none',
    qualifierNote: f.qualifier
      ? null
      : 'No reference qualifier is set on this field. `use_reference_qualifier` reads "simple" on many fields '
        + 'that have no qualifier at all, so "simple" alone does not mean one is in effect.',
  };
}

/** `dba.getRelationships` — explicit (sys_relationship) plus the implicit ones. */
export async function getRelationships(name) {
  const chain = await getTableHierarchy(name);
  /*
   * The columns are `apply_to` and `query_from` — NOT `applies_to` /
   * `queries_from`, which is what this was first written against and what the
   * plural reading of the label suggests. That mistake does not fail: an
   * encoded query on an unknown field is silently DROPPED (trap #2), so
   * `applies_toIN...^ORqueries_fromIN...` degrades to no condition at all and
   * returns every relationship on the instance as though they all applied to
   * this table. Measured column list, so the names are right and
   * assertFieldsHonoured would catch it if they ever stop being.
   */
  const explicit = await metaQuery('sys_relationship', {
    query: `apply_toIN${chain.join(',')}^ORquery_fromIN${chain.join(',')}`,
    fields: 'sys_id,name,apply_to,query_from,query_with,sys_scope',
    max: 500,
  }).catch(() => []);
  const refs = await getReferences(name);
  return {
    table: name,
    explicit: explicit.map((r) => ({
      name: r.name,
      appliesTo: r.apply_to,
      queriesFrom: r.query_from,
      scope: r.sys_scope,
      scripted: Boolean(r.query_with),
    })),
    explicitCount: explicit.length,
    implicit: {
      outbound: refs.outbound ?? [],
      inbound: refs.inbound ?? [],
      note: 'A reference field IS the relationship. sys_relationship exists only for related lists that no '
          + 'reference field can express.',
    },
  };
}

/* ── dot-walking ──────────────────────────────────────────────────────────── */

/**
 * `dba.dotWalk` — validate a path hop by hop and say exactly where it breaks.
 *
 * A dot-walk that fails silently is trap #2's cousin: an encoded query with a
 * bad dot-walk drops the condition and matches everything.
 */
export async function dotWalk(startTable, path) {
  const parts = String(path || '').split('.').map((s) => s.trim()).filter(Boolean);
  const hops = [];
  let current = startTable;

  for (let i = 0; i < parts.length; i++) {
    const element = parts[i];
    // eslint-disable-next-line no-await-in-loop
    const field = await getField(current, element);
    if (!field.exists) {
      return {
        startTable, path, valid: false, hops,
        failedAt: { position: i + 1, table: current, element },
        reason: `"${element}" does not exist on ${current}. The chain (${(field.extendsChain || []).join(' -> ')}) `
              + 'was read in full, so this is an absent field, not an unlisted one.',
      };
    }
    const f = field.effective;
    const last = i === parts.length - 1;
    hops.push({ position: i + 1, table: current, element, type: f.type, reference: f.reference || null });

    if (!last) {
      if (!REFERENCE_TYPES.has(f.type)) {
        return {
          startTable, path, valid: false, hops,
          failedAt: { position: i + 1, table: current, element },
          reason: `${current}.${element} is a ${f.type}, not a reference, so the path cannot continue through it. `
                + `Dot-walking stops at a non-reference field.`,
        };
      }
      current = f.reference;
    } else {
      return {
        startTable, path, valid: true, hops,
        resolvesTo: { table: current, element, type: f.type, reference: f.reference || null },
        // eslint-disable-next-line no-await-in-loop
        displayField: REFERENCE_TYPES.has(f.type) ? await getDisplayField(f.reference) : null,
      };
    }
  }
  return { startTable, path, valid: false, hops, reason: 'Empty path — nothing to walk.' };
}

/* ── classification ───────────────────────────────────────────────────────── */

const CUSTOM_PREFIX = /^(u_|x_)/;

/**
 * `dba.classify` — core / OOTB-customized / custom-in-scope / custom-global,
 * plus a safe-to-modify verdict that destructive operations gate on.
 *
 * Three independent signals, because each one alone is wrong somewhere:
 *   - the NAME prefix (`u_`, `x_scope_`) says who created it, but a customized
 *     OOTB table has no prefix and is very much modified;
 *   - `sys_metadata_customization` is the clean overview but only exists from
 *     Washington DC onward and covers what the platform chose to track;
 *   - `sys_update_version` survives deletion of the update record, which
 *     `sys_update_xml` does not.
 */
/**
 * The half of `classify` that a `sys_db_object` row already answers.
 *
 * Split out for the Tables browser, which classifies hundreds of rows at once.
 * The full `classify` costs TWO extra queries per table (customization records
 * and update versions); running it across a list would be a thousand round
 * trips to render one page.
 *
 * What the row alone settles: a custom NAME prefix and the scope. What it
 * cannot settle is whether a platform table has been CUSTOMIZED — so this
 * returns `customized: null` and `customizationChecked: false`, and a
 * platform-named table is reported as `ootb` rather than `core-ootb`.
 *
 * That distinction is the point. `core-ootb` is a claim that the customization
 * check ran and found nothing; `ootb` is "platform-named, not yet checked".
 * Collapsing them would let a list badge assert a check it never performed —
 * the same false-clean the index reader refuses a zero for.
 */
export function classifyFromRow(row) {
  if (!row?.name) return null;
  const named = CUSTOM_PREFIX.test(row.name);
  const global = row.sys_scope === 'global';
  return {
    table: row.name,
    category: named ? (global ? 'custom-global' : 'custom-in-scope') : 'ootb',
    scope: row.sys_scope ?? null,
    customPrefix: named,
    customized: null,
    customizationChecked: false,
    note: named
      ? null
      : 'Platform-named. Whether it has been CUSTOMIZED was not checked here — open the table to run the full '
        + 'classification, which distinguishes core-ootb from ootb-customized.',
  };
}

export async function classify(name) {
  const row = await tableRow(name);
  if (!row) return { table: name, exists: false };

  const [customizations, versions] = await Promise.all([
    metaQuery('sys_metadata_customization', { query: `sys_metadata=${row.sys_id}`, fields: 'sys_id,author_type', max: 50 }).catch(() => []),
    metaQuery('sys_update_version', { query: `name=${row.sys_update_name}`, fields: 'name,state,source,sys_recorded_at', max: 50 }).catch(() => []),
  ]);

  const named = CUSTOM_PREFIX.test(name);
  const global = row.sys_scope === 'global';
  const customized = customizations.length > 0 || versions.length > 0;

  let category;
  if (named) category = global ? 'custom-global' : 'custom-in-scope';
  else if (customized) category = 'ootb-customized';
  else category = 'core-ootb';

  const evidence = [
    `name prefix: ${named ? `custom (${name.startsWith('u_') ? 'u_' : 'x_'})` : 'no custom prefix — platform-named'}`,
    `sys_scope: ${row.sys_scope}`,
    `sys_metadata_customization rows: ${customizations.length}`,
    `sys_update_version rows for ${row.sys_update_name}: ${versions.length}`,
  ];

  const safeToModify = category === 'custom-in-scope' || category === 'custom-global'
    ? { verdict: 'yes', reason: 'This is a custom table. Changes to it affect only what was built on it.' }
    : {
      verdict: 'not-directly',
      reason: `${name} is a platform table${customized ? ' that has already been customized' : ''}. Never edit an `
            + 'out-of-scope object directly: add to it through the table-augments pattern plus a cross-scope '
            + 'privilege, so the base object is untouched and the change is captured as SDK source.',
    };

  return {
    table: name,
    exists: true,
    category,
    scope: row.sys_scope,
    package: row.sys_package,
    customized,
    // The list badge reports `customizationChecked: false`; this path ran it.
    customizationChecked: true,
    customizationAuthors: [...new Set(customizations.map((c) => c.author_type).filter(Boolean))],
    evidence,
    safeToModify,
  };
}

/* ── identifiers ──────────────────────────────────────────────────────────── */

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const NUMBERED_RE = /^([A-Za-z]{2,10})(\d{4,})$/;

/** Every prefix on the instance, cached — 149 rows, and they are not guessable. */
async function numberPrefixes({ refresh = false } = {}) {
  return cached('dba:number-prefixes', async () => {
    const rows = await metaQuery('sys_number', { query: 'prefixISNOTEMPTY', fields: 'category,prefix', max: 2000 });
    const byPrefix = new Map();
    for (const r of rows) {
      const p = String(r.prefix || '').toUpperCase();
      if (!p) continue;
      if (!byPrefix.has(p)) byPrefix.set(p, []);
      byPrefix.get(p).push(r.category);
    }
    return byPrefix;
  }, { ttlMs: 30 * 60_000, refresh });
}

/** `dba.resolveIdentifier` — INC0012345 / a sys_id / a unique value -> {table, sys_id, display}. */
export async function resolveIdentifier(value, { table: hint = null } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return { input: value, resolved: false, reason: 'Empty identifier.' };

  if (SYS_ID_RE.test(raw)) {
    if (!hint) {
      return {
        input: raw, resolved: false, kind: 'sys_id',
        reason: 'This is a well-formed sys_id, but a sys_id does not carry its table. There is no instance-wide '
              + 'index from sys_id to table, so pass the table you expect it on and it will be confirmed there.',
      };
    }
    const rows = await metaQuery(hint, { query: `sys_id=${raw}`, fields: 'sys_id', max: 1 });
    if (!rows.length) return { input: raw, resolved: false, kind: 'sys_id', table: hint, reason: `No record with that sys_id exists on ${hint}.` };
    const display = await getDisplayField(hint);
    const full = await metaQuery(hint, { query: `sys_id=${raw}`, fields: `sys_id,${display}`, max: 1 });
    return { input: raw, resolved: true, kind: 'sys_id', table: hint, sys_id: raw, display: full[0]?.[display] ?? null };
  }

  const m = NUMBERED_RE.exec(raw);
  if (m) {
    const prefix = m[1].toUpperCase();
    const prefixes = await numberPrefixes();
    const candidates = hint ? [hint] : (prefixes.get(prefix) || []);
    if (!candidates.length) {
      return {
        input: raw, resolved: false, kind: 'number', prefix,
        reason: `No sys_number row on this instance uses the prefix "${prefix}", so nothing here produces `
              + `identifiers of that shape. ${prefixes.size} prefixes are defined.`,
      };
    }
    for (const t of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await metaQuery(t, { query: `number=${raw}`, fields: 'sys_id,number', max: 2 }).catch(() => []);
      if (rows.length === 1) return { input: raw, resolved: true, kind: 'number', prefix, table: t, sys_id: rows[0].sys_id, display: rows[0].number };
      if (rows.length > 1) {
        return {
          input: raw, resolved: false, kind: 'number', prefix, table: t,
          reason: `${rows.length} records on ${t} carry the number ${raw}. Confirm which one before using it.`,
        };
      }
    }
    return {
      input: raw, resolved: false, kind: 'number', prefix, candidateTables: candidates,
      reason: `The prefix "${prefix}" maps to ${candidates.join(', ')}, but no record with number ${raw} exists there.`,
    };
  }

  if (!hint) {
    return {
      input: raw, resolved: false, kind: 'unknown',
      reason: 'This is neither a sys_id nor a prefixed number. Name the table to search and it will be resolved '
            + 'against that table\'s display and key fields.',
    };
  }
  const display = await getDisplayField(hint);
  const rows = await metaQuery(hint, { query: `${display}=${raw}`, fields: `sys_id,${display}`, max: 5 });
  if (rows.length === 1) return { input: raw, resolved: true, kind: 'display-value', table: hint, sys_id: rows[0].sys_id, display: rows[0][display] };
  return {
    input: raw, resolved: false, kind: 'display-value', table: hint, matches: rows.length,
    reason: rows.length
      ? `${rows.length} records on ${hint} have ${display} = "${raw}". Confirm which one.`
      : `No record on ${hint} has ${display} = "${raw}".`,
  };
}

/* ── choices and indexes ──────────────────────────────────────────────────── */

/** `dba.listChoices` */
export async function listChoices(name, element) {
  const chain = await getTableHierarchy(name);
  const rows = await metaQuery('sys_choice', {
    query: `nameIN${chain.join(',')}^element=${element}^language=en^ORDERBYsequence`,
    fields: 'name,element,label,value,sequence,inactive,dependent_value,hint',
    max: 2000,
  });
  // Most-derived table's set wins, exactly as the platform resolves it.
  const definedOn = chain.find((t) => rows.some((r) => r.name === t)) || null;
  const active = rows.filter((r) => r.name === definedOn);
  return {
    table: name,
    element,
    definedOn,
    extendsChain: chain,
    count: active.length,
    choices: active.map((r) => ({
      value: r.value,
      label: r.label,
      sequence: r.sequence ? Number(r.sequence) : null,
      inactive: r.inactive === 'true',
      dependentValue: r.dependent_value || null,
      hint: r.hint || null,
    })),
    ...(definedOn && definedOn !== name
      ? { note: `The choice list is defined on ${definedOn}, which ${name} inherits from.` }
      : {}),
    ...(rows.length === 0
      ? { note: `No sys_choice rows exist for ${name}.${element} anywhere in the chain. If the field is a choice `
              + 'type, its values may come from a choice TABLE (dictionary choice_table/choice_field) rather than sys_choice.' }
      : {}),
  };
}

/**
 * `dba.listIndexes` — and the honest answer here is "partial", always.
 *
 * This tool looked like the easiest in Layer 1 and is the only one that cannot
 * be completed. MEASURED, every candidate source, server-side where REST was
 * refused:
 *
 *   sys_index          403 over REST; readable server-side — and holds
 *                      THIRTY-THREE ROWS INSTANCE-WIDE, none for `incident`,
 *                      none for `task`, none for `sys_user`. The rows it does
 *                      hold are plugin-shipped CMDB definitions. It is a
 *                      metadata table of index DEFINITION RECORDS (it extends
 *                      sys_metadata), not a catalogue of physical indexes.
 *   sys_index_ii       400 Invalid table — does not exist here.
 *   v_db_index         0 rows, over REST and server-side, filtered and not.
 *   v_index_creator    0 rows server-side.
 *   GlideTableDescriptor('incident').getIndexes()   undefined — no such method.
 *
 * So there is NO reachable source on this instance that enumerates the physical
 * indexes of a table. Every table has at least a primary key, so returning
 * `count: 0` as though it were an answer would be a confidently wrong result of
 * exactly the kind this project exists to prevent — and the caller would have
 * no way to tell it apart from a real empty.
 *
 * This therefore never claims completeness. It returns the definition records
 * that do exist and states plainly that zero means "no index DEFINITION
 * RECORD", not "no index".
 */
/**
 * The unavailable path, in the SAME SHAPE as the success path.
 *
 * ── M-2 ──────────────────────────────────────────────────────────────────────
 *
 * This used to return only { table, available, reason, note }, so a caller
 * following the documented contract — "`complete` is false, always" — read
 * `idx.complete` as `undefined` on this branch. `undefined` is falsy, so
 * `if (idx.complete === false)` silently stopped being true exactly when the
 * answer was least trustworthy. An honest "unavailable" is a KNOWN state and
 * must not be spelled with undefined fields.
 *
 * `indexes` is null and not `[]` on purpose: an empty array here would be the
 * false zero that boundary B-1 exists to prevent, and a caller that iterates it
 * would report a table as unindexed on the strength of a timeout.
 *
 * Pure, so the shape contract is testable without an instance or a harness.
 */
export function unavailableIndexes(name, chain, run) {
  // M-1 — "the harness never answered" and "sys_index answered nothing" are
  // different failures with different next steps, so they are not flattened
  // into one undifferentiated unavailable.
  const harnessFailed = run?.timedOut === true;
  return {
    table: name,
    available: false,
    complete: false,
    failure: harnessFailed ? 'harness-unavailable' : 'script-error',
    scannedTables: chain,
    definitionRecordCount: null,
    indexes: null,
    reason: harnessFailed
      ? `The index read did not report back before the timeout (${run?.cause ?? 'timeout'}).`
      : (run?.report?.error || 'The index read did not complete.'),
    ...(harnessFailed
      ? {
        harness: {
          available: false,
          cause: run?.cause ?? 'timeout',
          started: run?.started === true,
          job: run?.job ?? null,
          detail: run?.message ?? null,
        },
        harnessNote: 'The server-side execution harness did not deliver a result, so this is a HARNESS failure, not '
          + 'a finding about this table. Nothing was learned about its indexes either way.',
      }
      : {}),
    source: 'sys_index via a server-side script — not reached on this call',
    completeness:
      'UNAVAILABLE. Even on the success path this tool is never complete (sys_index holds index DEFINITION RECORDS, '
      + 'not the physical indexes the platform maintains), and on this path it read nothing at all.',
    zeroMeans:
      `Nothing was read, so there is no count to interpret. This is NOT "${name} has no indexes" and NOT "no index `
      + 'definition record exists" — it is an unknown. To see the real indexes, use the platform UI: System '
      + 'Definition > Database Indexes. Do not report this table as unindexed.',
    note: 'sys_index cannot be read over REST on this instance (403, API-level ACL) and sys_index_ii does not '
        + 'exist, so there is no fallback path — this is an unknown, not an empty index list.',
  };
}

export async function listIndexes(name, { includeInherited = false } = {}) {
  if (!/^[a-z0-9_]+$/i.test(String(name || ''))) {
    throw Object.assign(new Error(`"${name}" is not a valid table name.`), { status: 400 });
  }
  const chain = includeInherited ? await getTableHierarchy(name) : [name];
  const list = chain.map((t) => `'${t}'`).join(',');
  const body = [
    'report.indexes = [];',
    `var __tables = [${list}];`,
    "var gi = new GlideRecord('sys_index');",
    'if (!gi.isValid()) { report.unavailable = true; } else {',
    "  gi.addQuery('logical_table_name', 'IN', __tables.join(','));",
    "  gi.orderBy('logical_table_name');",
    '  gi.query();',
    '  while (gi.next()) {',
    '    report.indexes.push({',
    "      table: String(gi.getValue('logical_table_name')),",
    "      column: String(gi.getValue('col_name_string')),",
    "      unique: String(gi.getValue('unique_index')) === '1',",
    "      method: String(gi.getValue('access_method')),",
    "      name: String(gi.getValue('sys_update_name'))",
    '    });',
    '  }',
    '}',
  ].join('\n');

  const run = await runServerScript({ body, label: `dba indexes ${name}`, timeoutMs: 60_000 });
  if (!run?.report?.ok) return unavailableIndexes(name, chain, run);
  const indexes = run.report.indexes || [];
  return {
    table: name,
    available: true,
    complete: false,
    failure: null,
    scannedTables: chain,
    definitionRecordCount: indexes.length,
    indexes,
    source: 'sys_index via a server-side script — sys_index is 403 over REST on this instance',
    completeness:
      'PARTIAL, and this is a property of the instance, not of the query. sys_index holds index DEFINITION '
      + 'RECORDS (it extends sys_metadata) — 33 rows instance-wide when measured, none of them for incident, task '
      + 'or sys_user. It is not a catalogue of the physical indexes the platform maintains, and no reachable '
      + 'source on this instance is: v_db_index and v_index_creator return zero rows even server-side, '
      + 'sys_index_ii does not exist, and GlideTableDescriptor has no getIndexes method.',
    zeroMeans:
      indexes.length === 0
        ? `No index DEFINITION RECORD exists for ${name}. That is NOT the same as "${name} has no indexes" — every `
          + 'table has at least a primary key. To see the real indexes, use the platform UI: System Definition > '
          + 'Database Indexes. Do not report this table as unindexed.'
        : null,
    note: 'These are database index definitions. Text (Zing) indexes are a different mechanism and are not listed here.',
  };
}

/* ── the derived schema map ───────────────────────────────────────────────── */

/**
 * `dba.generateSchemaMap` — nodes are tables, edges are extends | reference |
 * relationship. DERIVED, because there is no schema-map API to call.
 */
export async function generateSchemaMap(name, { depth = 1 } = {}) {
  const nodes = new Map();
  const edges = [];
  const seen = new Set();

  const addNode = (t, extra = {}) => {
    if (!nodes.has(t)) nodes.set(t, { table: t, ...extra });
    else Object.assign(nodes.get(t), extra);
  };

  /*
   * Only what an EDGE needs, per node.
   *
   * The first version called getTable + getReferences for every node. Both are
   * right and both are far too expensive here: getReferences runs an
   * instance-wide inbound scan (sys_user alone answers 3,999 rows across four
   * pages) and getTable classifies. At depth 1 `incident` has 24 outbound
   * targets, so that was ~25 instance-wide scans for a graph that needs none of
   * them — it timed out past two minutes.
   *
   * A map edge only ever needs OUTBOUND references, which come from the node's
   * own inheritance chain. Classification is read once, for the root, because
   * that is the node the caller asked about.
   */
  const visit = async (t, level) => {
    if (seen.has(t) || level > depth) return;
    seen.add(t);

    const row = await tableRow(t);
    if (!row) { addNode(t, { exists: false }); return; }
    const isRoot = t === name;
    addNode(t, {
      exists: true, label: row.label, scope: row.sys_scope, isRoot,
      ...(isRoot ? { classification: (await classify(t)).category } : {}),
    });

    if (row['super_class.name']) {
      addNode(row['super_class.name'], {});
      edges.push({ from: t, to: row['super_class.name'], kind: 'extends' });
    }

    const { chain, rows } = await chainDictionary(t);
    const outbound = rows
      .filter((r) => REFERENCE_TYPES.has(r.internal_type) && r.reference)
      .map((r) => ({ element: r.element, to: r.reference, inherited: r.name !== chain[0] }));

    for (const o of outbound) {
      addNode(o.to, {});
      edges.push({ from: t, to: o.to, kind: 'reference', via: o.element, inherited: o.inherited });
    }
    if (level < depth) {
      for (const o of outbound) await visit(o.to, level + 1);
    }

    if (isRoot) {
      const rel = await getRelationships(t);
      for (const r of rel.explicit) {
        if (!r.appliesTo || !r.queriesFrom) continue;
        addNode(r.appliesTo, {});
        addNode(r.queriesFrom, {});
        edges.push({ from: r.queriesFrom, to: r.appliesTo, kind: 'relationship', via: r.name });
      }
    }
  };

  await visit(name, 0);

  // Deduplicate: the same pair can be joined by several reference fields, and
  // each is a real edge, but an identical triple is not.
  const key = (e) => `${e.from}|${e.to}|${e.kind}|${e.via ?? ''}`;
  const unique = [...new Map(edges.map((e) => [key(e), e])).values()];

  return {
    root: name,
    depth,
    nodeCount: nodes.size,
    edgeCount: unique.length,
    nodes: [...nodes.values()],
    edges: unique,
    legend: { extends: 'child -> parent table', reference: 'a reference field on `from` pointing at `to`', relationship: 'an explicit sys_relationship record' },
    note: 'This graph is DERIVED from sys_db_object, sys_dictionary and sys_relationship. ServiceNow exposes no '
        + 'schema-map API, so there is nothing authoritative to compare it against — it is exactly as complete as '
        + 'the depth requested.',
  };
}
