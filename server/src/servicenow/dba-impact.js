import { metaQuery } from './dba-metadata.js';
import { getTableHierarchy } from './schema.js';
import { getTable, getField, getReferences, listFields, classify } from './dba-schema.js';
import { getDbaContext, DESTRUCTIVE_POLICY } from './dba-context.js';

/**
 * DBA Layer 2 — the Impact & Safety Engine. Still read-only.
 *
 * There is NO out-of-the-box "what breaks if I change this?" API in
 * ServiceNow. This builds one by scanning the tables that hold dependent
 * artifacts, which means the answer is exactly as good as the registry below
 * and no better — so the registry is declarative, every entry names the column
 * it matched on, and the report always states what it did NOT look at.
 *
 * ── MEASURED on dev428633, 2026-08-31 ────────────────────────────────────────
 *
 * `incident` alone: 8 forms, 44 sections, 20 lists, 39 business rules, 24
 * client scripts, 15 UI policies, 25 UI actions, 40 ACLs, 1 data policy, 72
 * reports, 24 notifications, 1 transform map. An impact report is not a
 * formality on a table like this.
 *
 * TRAP #17, reconfirmed live and load-bearing here: `nameSTARTSWITHincident`
 * matches `incident_task`, `incident_task.state`, `incident_task.close_notes`…
 * A naive prefix match reported 155 ACLs for incident where the true figure is
 * 40. Every table-scoped match in this module is therefore EXACT or
 * exact-plus-dot, never a bare prefix.
 *
 * ACL naming, measured — three distinct shapes that mean different things:
 *   `incident`            the table-level ACL
 *   `incident.*`          every field on the table
 *   `incident.caller_id`  one field
 */

/**
 * The dependency registry.
 *
 * `match` returns an encoded query for a given table name. `severity` is about
 * what breaking it COSTS, not how likely it is: a child table or an inbound
 * reference is structural, a report is cosmetic, and conflating them makes the
 * report useless for deciding.
 */
const TABLE_DEPENDENTS = [
  { key: 'childTables', table: 'sys_db_object', label: 'child tables (extend this one)', severity: 'structural',
    fields: 'name,label,super_class', match: null /* resolved by sys_id, see below */ },
  { key: 'referenceFields', table: 'sys_dictionary', label: 'reference fields pointing at this table', severity: 'structural',
    fields: 'name,element,internal_type,mandatory', match: (t) => `reference=${t}^elementISNOTEMPTY` },
  { key: 'businessRules', table: 'sys_script', label: 'business rules', severity: 'high',
    fields: 'name,active,when,order', match: (t) => `collection=${t}` },
  { key: 'clientScripts', table: 'sys_script_client', label: 'client scripts', severity: 'high',
    fields: 'name,active,type', match: (t) => `table=${t}` },
  { key: 'uiPolicies', table: 'sys_ui_policy', label: 'UI policies', severity: 'high',
    fields: 'short_description,active', match: (t) => `table=${t}` },
  { key: 'dataPolicies', table: 'sys_data_policy2', label: 'data policies', severity: 'high',
    fields: 'short_description,active', match: (t) => `model_table=${t}` },
  { key: 'acls', table: 'sys_security_acl', label: 'access controls', severity: 'high',
    fields: 'name,operation,active,type', match: (t) => `name=${t}^ORnameSTARTSWITH${t}.` },
  { key: 'uiActions', table: 'sys_ui_action', label: 'UI actions', severity: 'medium',
    fields: 'name,active', match: (t) => `table=${t}` },
  { key: 'forms', table: 'sys_ui_form', label: 'forms', severity: 'medium',
    fields: 'name,view', match: (t) => `name=${t}` },
  { key: 'formSections', table: 'sys_ui_section', label: 'form sections', severity: 'medium',
    fields: 'name,view,title', match: (t) => `name=${t}` },
  { key: 'lists', table: 'sys_ui_list', label: 'list layouts', severity: 'medium',
    fields: 'name,view', match: (t) => `name=${t}` },
  { key: 'transformMaps', table: 'sys_transform_map', label: 'import transform maps', severity: 'medium',
    fields: 'name,active,target_table', match: (t) => `target_table=${t}` },
  { key: 'relationships', table: 'sys_relationship', label: 'defined relationships', severity: 'medium',
    fields: 'name,apply_to,query_from', match: (t) => `apply_to=${t}^ORquery_from=${t}` },
  { key: 'notifications', table: 'sysevent_email_action', label: 'email notifications', severity: 'low',
    fields: 'name,active', match: (t) => `collection=${t}` },
  { key: 'reports', table: 'sys_report', label: 'reports', severity: 'low',
    fields: 'title,type', match: (t) => `table=${t}` },
  { key: 'templates', table: 'sys_template', label: 'templates', severity: 'low',
    fields: 'name,active', match: (t) => `table=${t}` },
  { key: 'filters', table: 'sys_filter', label: 'saved filters', severity: 'low',
    fields: 'title,table', match: (t) => `table=${t}` },
];

const SEVERITY_ORDER = { structural: 0, high: 1, medium: 2, low: 3 };

/**
 * What this engine CANNOT see, stated in every report.
 *
 * A dependency report that lists what it found and stays quiet about its blind
 * spots is the most dangerous shape this tool could take: it reads as
 * exhaustive. Flow Designer is the big one — a flow's trigger table lives in a
 * gzip+base64 blob in `sys_hub_trigger_instance_v2.trigger_inputs` (trap #11),
 * not in a queryable column, so flows are NOT scanned by table.
 */
const BLIND_SPOTS = [
  'Flow Designer flows and actions: a flow\'s trigger table is a gzip+base64 blob in '
  + 'sys_hub_trigger_instance_v2.trigger_inputs (trap #11), not a queryable column, so flows are not matched by table here.',
  'Scripts that reference the table or field dynamically (a name built at runtime, or held in a property) '
  + 'cannot be found by any text search.',
  'Anything in a scoped application whose artifacts this credential cannot read.',
  'Integrations outside the instance — REST consumers, MID scripts, exports — are invisible to every query here.',
];

/**
 * `dba.analyzeImpact` — everything that depends on a table, or on one field.
 *
 * Field mode is a superset of the table's own field-level artifacts, not a
 * subset of the table scan: an ACL named `incident.caller_id`, a form element,
 * a dictionary override and a script that mentions the column by name are all
 * field-specific and none of them appear in a table-level report.
 */
export async function analyzeImpact({ table: tableName, field = null, max = 1000 } = {}) {
  if (!tableName) throw Object.assign(new Error('analyzeImpact needs a table.'), { status: 400 });

  const info = await getTable(tableName);
  if (!info.exists) return { target: { table: tableName, field }, exists: false, note: info.note };

  return field
    ? analyzeFieldImpact(tableName, field, info, max)
    : analyzeTableImpact(tableName, info, max);
}

async function analyzeTableImpact(tableName, info, max) {
  const findings = [];
  const scanned = [];

  // Child tables resolve by the parent's sys_id, not by name.
  const children = await metaQuery('sys_db_object', {
    query: `super_class=${info.sys_id}`, fields: 'name,label', max,
  });
  scanned.push({ source: 'sys_db_object', matchedOn: `super_class=${info.sys_id}` });
  if (children.length) {
    findings.push({
      key: 'childTables', source: 'sys_db_object', label: 'child tables (extend this one)',
      severity: 'structural', count: children.length, truncated: children.truncated === true,
      items: children.slice(0, 25).map((c) => c.name),
      consequence: `${children.length} table(s) extend ${tableName}. Dropping or re-typing a column here changes `
                 + 'every one of them, and dropping the table is not possible while they exist.',
    });
  }

  for (const dep of TABLE_DEPENDENTS) {
    if (!dep.match) continue;
    const query = dep.match(tableName);
    // eslint-disable-next-line no-await-in-loop
    const rows = await metaQuery(dep.table, { query, fields: dep.fields, max }).catch((err) => {
      scanned.push({ source: dep.table, matchedOn: query, error: err.message });
      return null;
    });
    if (rows === null) continue;
    scanned.push({ source: dep.table, matchedOn: query });
    if (!rows.length) continue;
    findings.push({
      key: dep.key, source: dep.table, label: dep.label, severity: dep.severity,
      count: rows.length, truncated: rows.truncated === true,
      items: rows.slice(0, 25).map(describe),
      ...(rows.truncated ? { truncatedNote: `Hit the ${max}-row ceiling — this count is a FLOOR.` } : {}),
    });
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    target: { table: tableName, kind: 'table' },
    exists: true,
    classification: info.classification,
    totalDependents: findings.reduce((n, f) => n + f.count, 0),
    bySeverity: countBy(findings),
    findings,
    scanned,
    blindSpots: BLIND_SPOTS,
    note: 'There is no OOTB API that answers "what breaks?". This report is assembled by scanning the artifact '
        + 'tables listed in `scanned` — it is exactly as complete as that list, and the blind spots are real.',
  };
}

async function analyzeFieldImpact(tableName, element, info, max) {
  const field = await getField(tableName, element);
  if (!field.exists) return { target: { table: tableName, field: element }, exists: false, note: field.note };

  const chain = await getTableHierarchy(tableName);
  const findings = [];
  const scanned = [];

  const scan = async (key, source, label, severity, query, fields, consequence = null) => {
    const rows = await metaQuery(source, { query, fields, max }).catch((err) => {
      scanned.push({ source, matchedOn: query, error: err.message });
      return null;
    });
    if (rows === null) return;
    scanned.push({ source, matchedOn: query });
    if (!rows.length) return;
    findings.push({
      key, source, label, severity, count: rows.length, truncated: rows.truncated === true,
      items: rows.slice(0, 25).map(describe),
      ...(consequence ? { consequence } : {}),
    });
  };

  // Field-level ACLs: `incident.caller_id` and the wildcard `incident.*`, which
  // also governs this column. Exact names only — trap #17.
  await scan('fieldAcls', 'sys_security_acl', 'access controls naming this field', 'high',
    `name=${tableName}.${element}^ORname=${tableName}.*`, 'name,operation,active,type',
    'An ACL named for this field stops governing anything if the field is renamed or dropped, which silently '
    + 'widens or narrows access rather than erroring.');

  await scan('dictionaryOverrides', 'sys_dictionary_override', 'dictionary overrides on child tables', 'structural',
    `element=${element}^base_tableIN${chain.join(',')}`, 'name,base_table,element,mandatory_override,read_only_override,default_value_override');

  await scan('choices', 'sys_choice', 'choice values', 'medium',
    `nameIN${chain.join(',')}^element=${element}`, 'name,element,label,value,inactive');

  await scan('labels', 'sys_documentation', 'field labels/translations', 'low',
    `nameIN${chain.join(',')}^element=${element}`, 'name,element,label,language');

  await scan('formElements', 'sys_ui_element', 'form sections placing this field', 'medium',
    `element=${element}`, 'sys_ui_section,element,position',
    'A form element pointing at a dropped field leaves a blank slot on the form rather than an error.');

  // Text matches. Deliberately labelled as heuristic — a column name can appear
  // in a comment, in an unrelated string, or on a dot-walked table.
  await scan('scriptMentions', 'sys_script', 'business rules whose script text mentions this column', 'high',
    `collection=${tableName}^scriptLIKE${element}`, 'name,active,when');
  await scan('clientScriptMentions', 'sys_script_client', 'client scripts mentioning this column', 'high',
    `table=${tableName}^scriptLIKE${element}`, 'name,active,type');
  await scan('uiPolicyFieldActions', 'sys_ui_policy_action', 'UI policy actions targeting this field', 'high',
    `field=${element}`, 'field,visible,mandatory,disabled');

  // If the field is itself a reference, what it points at matters for the
  // integrity story, not the breakage story — carried, not counted.
  const refs = field.effective.reference
    ? { pointsAt: field.effective.reference, note: 'Dropping this field removes the link to that table; it does not affect the target table itself.' }
    : null;

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    target: { table: tableName, field: element, kind: 'field' },
    exists: true,
    field: {
      type: field.effective.type,
      originTable: field.originTable,
      inherited: field.effective.inherited,
      mandatory: field.effective.mandatory,
      reference: field.effective.reference,
    },
    inheritedWarning: field.effective.inherited
      ? `${element} is NOT defined on ${tableName} — it comes from ${field.originTable}. Changing it there changes `
        + `it for every table that extends ${field.originTable}, not just ${tableName}. Use a dictionary override `
        + 'if the intent was to change it for this table only.'
      : null,
    classification: info.classification,
    totalDependents: findings.reduce((n, f) => n + f.count, 0),
    bySeverity: countBy(findings),
    findings,
    referenceTarget: refs,
    scanned,
    blindSpots: [
      ...BLIND_SPOTS,
      'Text matches on a column name are HEURISTIC: the name may appear in a comment, in an unrelated string, or '
      + 'as a dot-walked field on another table. Read the hits; do not count them as proof.',
    ],
  };
}

function describe(r) {
  return r.name || r.title || r.short_description || r.label || r.element || r.sys_id || '(unnamed)';
}

function countBy(findings) {
  const out = {};
  for (const f of findings) out[f.severity] = (out[f.severity] || 0) + f.count;
  return out;
}

/* ── operation classification, straight from the §1.5 matrix ──────────────── */

/**
 * Every operation NHA can be asked to perform, with its reversibility.
 *
 * `reversible: false` here means NO ROLLBACK CONTEXT IS CREATED — not "hard to
 * undo", not "undo carefully". The distinction is the whole point of the table:
 * a user who is told a drop is reversible will authorise it.
 */
const OPERATIONS = {
  record_delete: {
    acts_on: 'data',
    reversible: true, mechanism: 'Delete Recovery', engineDependent: true,
    note: 'A record deleted through GlideRecord.delete()/deleteMultiple() is captured for recovery — SUBJECT TO the '
        + 'engine and the recovery plugins. Read the live verdict; do not quote the window from this table.',
  },
  background_script: {
    acts_on: 'platform',
    reversible: true, mechanism: 'Rollback Context', engineDependent: true, retentionCategory: 'scripts_bg',
    note: 'Recoverable ONLY if "Record for Rollback" was set when the script ran. Without it there is no context.',
  },
  plugin_activation: { acts_on: 'platform', reversible: true, mechanism: 'Rollback Context', engineDependent: true, retentionCategory: 'plugin' },
  patch_upgrade: { acts_on: 'platform', reversible: true, mechanism: 'Rollback Context', engineDependent: true, retentionCategory: 'app_install' },
  drop_index: {
    acts_on: 'schema',
    reversible: true, mechanism: 'recreate the index', engineDependent: false,
    note: 'Index drops are explicitly recoverable — the index can simply be recreated. This is the one DDL-shaped '
        + 'operation in this table that is not destructive to data.',
  },

  drop_table: { acts_on: 'schema', reversible: false, reason: 'No rollback context is created for a table drop. The table and every row in it are gone.' },
  drop_column: { acts_on: 'schema', reversible: false, reason: 'No rollback context is created for a column drop. The column and all of its data are gone.' },
  truncate_table: { acts_on: 'schema', reversible: false, reason: 'A truncate creates no rollback context and no delete-recovery records. Every row is gone.' },
  rename_table: { acts_on: 'schema', reversible: false, reason: 'A rename creates no rollback context, and every artifact referring to the old name silently stops matching.' },
  rename_column: { acts_on: 'schema', reversible: false, reason: 'A rename creates no rollback context. Queries, scripts and ACLs naming the old column stop matching WITHOUT erroring.' },
  change_column_type: { acts_on: 'schema', reversible: false, reason: 'A type change creates no rollback context, and data that does not fit the new type is lost in the conversion.' },
  decrease_column_width: { acts_on: 'schema', reversible: false, reason: 'Narrowing a column creates no rollback context and truncates every value that no longer fits.' },
  reparent_column: { acts_on: 'schema', reversible: false, reason: 'Re-parenting or promoting a column creates no rollback context.' },
};

/** `dba.classifyOperation` */
export async function classifyOperation(op, { withContext = true } = {}) {
  const spec = OPERATIONS[op];
  if (!spec) {
    return {
      operation: op, known: false,
      knownOperations: Object.keys(OPERATIONS),
      verdict: 'unknown',
      guidance: 'This operation is not in the rollback matrix. Treat it as IRREVERSIBLE until it is classified — '
              + 'the safe default for an unclassified schema change is that nothing will bring it back.',
    };
  }

  const irreversible = spec.reversible === false;
  const base = {
    operation: op,
    known: true,
    actsOn: spec.acts_on,
    reversible: spec.reversible,
    ...(irreversible
      ? { reason: spec.reason, requiredConfirmations: DESTRUCTIVE_POLICY.irreversibleDdl.requires }
      : { mechanism: spec.mechanism, ...(spec.note ? { note: spec.note } : {}) }),
    requiredRole: 'admin (schema changes); ACL authoring additionally needs elevation — see dba_context',
    scopeConstraint: 'Out-of-scope and OOTB objects are never edited directly: use the table-augments pattern plus '
                   + 'a cross-scope privilege, authored through the SDK.',
  };

  if (!withContext || !spec.engineDependent) {
    if (irreversible) {
      base.statement = `${op} CANNOT be undone. No rollback context is created, on any database engine. `
                     + 'Do not describe it as reversible under any circumstances.';
    }
    return base;
  }

  // Engine-dependent operations must quote the LIVE verdict, not the matrix.
  const ctx = await getDbaContext({ probeEngine: true }).catch(() => null);
  if (!ctx) {
    return { ...base, reversible: 'unknown', statement: 'The instance context could not be read, so reversibility cannot be confirmed. Treat as irreversible.' };
  }
  const retention = spec.retentionCategory ? ctx.rollbackRetentionDays?.[spec.retentionCategory] ?? null : null;

  /*
   * THE MATRIX IS THE DEFAULT; THE INSTANCE IS THE ANSWER.
   *
   * `record_delete` is `reversible: true` in §1.5 and that is what the static
   * table says. On this instance the live verdict is `partial` — Delete
   * Recovery captures the row, and nothing installed can restore it. Leaving
   * `reversible: true` on the object while only the prose said otherwise would
   * hand any consumer reading the flag alone exactly the wrong answer, which is
   * the two-state rounding the three-state verdict exists to prevent.
   *
   * So for engine-dependent operations the flag is overwritten with what the
   * instance actually supports.
   */
  const fromVerdict = { full: true, partial: 'partial', none: false, unknown: 'unknown' };
  const liveReversible = op === 'record_delete'
    ? fromVerdict[ctx.recovery.state] ?? 'unknown'
    : (ctx.recovery.rollbackContexts === true ? true : (ctx.recovery.rollbackContexts === false ? false : 'unknown'));

  return {
    ...base,
    reversible: liveReversible,
    reversiblePerMatrix: spec.reversible,
    ...(liveReversible !== spec.reversible
      ? { matrixDivergence: `The rollback matrix says ${spec.reversible}, but this instance supports `
                          + `"${liveReversible}". The instance wins — quote the live verdict, never the matrix.` }
      : {}),
    dbEngine: ctx.dbEngine.value,
    liveRecoveryVerdict: ctx.recovery,
    ...(retention !== null
      ? { retentionDays: retention, retentionSource: `glide.rollback.expiration_days_${spec.retentionCategory}, read live` }
      : {}),
    statement: op === 'record_delete'
      ? ctx.recovery.headline
      : (liveReversible === true
        ? `Recoverable via ${spec.mechanism}${retention !== null ? ` for ${retention} days` : ''}, on engine ${ctx.dbEngine.value ?? 'unknown'}.`
        : `NOT recoverable via ${spec.mechanism} on engine ${ctx.dbEngine.value ?? 'unknown'}.`),
  };
}

/* ── integrity ────────────────────────────────────────────────────────────── */

/**
 * `dba.checkIntegrity` — read-only diagnostics, each one a real query.
 *
 * Bounded on purpose: this samples rather than scanning a production-sized
 * table to exhaustion, and says so. A diagnostic that takes four minutes gets
 * turned off, and a diagnostic that silently sampled is worse than none.
 */
export async function checkIntegrity(tableName, { sample = 500 } = {}) {
  const info = await getTable(tableName);
  if (!info.exists) return { table: tableName, exists: false, note: info.note };

  const fields = await listFields(tableName, { includeInherited: true });
  const mandatory = fields.fields.filter((f) => f.mandatory && !f.virtual);
  const uniques = fields.fields.filter((f) => f.unique);
  const references = fields.fields.filter((f) => f.reference && f.type === 'reference');

  const checks = [];

  for (const f of mandatory.slice(0, 15)) {
    // eslint-disable-next-line no-await-in-loop
    const empty = await metaQuery(tableName, { query: `${f.element}ISEMPTY`, fields: 'sys_id', max: sample }).catch(() => null);
    if (empty === null) continue;
    checks.push({
      check: 'mandatory-empty', field: f.element, violations: empty.length,
      bounded: empty.truncated === true,
      verdict: empty.length ? 'FAIL' : 'pass',
      ...(empty.length
        ? { detail: `${empty.length}${empty.truncated ? '+' : ''} row(s) have no value in the mandatory column ${f.element}. `
                  + 'Mandatory is enforced on the form, not in the database, so historic rows routinely violate it.' }
        : {}),
    });
  }

  for (const f of uniques.slice(0, 10)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await metaQuery(tableName, { query: `${f.element}ISNOTEMPTY`, fields: `sys_id,${f.element}`, max: sample }).catch(() => null);
    if (rows === null) continue;
    const seen = new Map();
    for (const r of rows) {
      const v = r[f.element];
      seen.set(v, (seen.get(v) || 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    checks.push({
      check: 'unique-duplicate', field: f.element, violations: dupes.length,
      bounded: rows.truncated === true,
      verdict: dupes.length ? 'FAIL' : 'pass',
      scannedRows: rows.length,
      ...(dupes.length ? { detail: `${dupes.length} duplicated value(s) in a column flagged unique.`, examples: dupes.slice(0, 5).map(([v, n]) => `${v} x${n}`) } : {}),
    });
  }

  for (const f of references.slice(0, 10)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await metaQuery(tableName, { query: `${f.element}ISNOTEMPTY`, fields: `sys_id,${f.element}`, max: Math.min(sample, 200) }).catch(() => null);
    if (rows === null) continue;
    const ids = [...new Set(rows.map((r) => r[f.element]).filter(Boolean))].slice(0, 100);
    if (!ids.length) { checks.push({ check: 'orphaned-reference', field: f.element, violations: 0, verdict: 'pass', scannedRows: 0 }); continue; }
    // eslint-disable-next-line no-await-in-loop
    const found = await metaQuery(f.reference, { query: `sys_idIN${ids.join(',')}`, fields: 'sys_id', max: 200 }).catch(() => null);
    if (found === null) {
      checks.push({ check: 'orphaned-reference', field: f.element, verdict: 'not-checked', detail: `${f.reference} could not be read, so the targets could not be confirmed.` });
      continue;
    }
    const present = new Set(found.map((r) => r.sys_id));
    const orphans = ids.filter((id) => !present.has(id));
    checks.push({
      check: 'orphaned-reference', field: f.element, target: f.reference,
      violations: orphans.length, verdict: orphans.length ? 'FAIL' : 'pass',
      scannedDistinctValues: ids.length, bounded: rows.truncated === true || ids.length >= 100,
      ...(orphans.length ? { detail: `${orphans.length} value(s) point at a ${f.reference} record that does not exist.`, examples: orphans.slice(0, 5) } : {}),
    });
  }

  const failures = checks.filter((c) => c.verdict === 'FAIL');
  return {
    table: tableName,
    exists: true,
    sampleSize: sample,
    checksRun: checks.length,
    failures: failures.length,
    verdict: failures.length ? 'issues-found' : 'clean-within-sample',
    checks,
    bounded: true,
    note: `Every check is bounded at ${sample} rows (100 distinct values for reference checks). "clean" here means `
        + 'clean WITHIN THE SAMPLE — it is not a proof about the whole table. Raise the sample deliberately if the '
        + 'answer needs to be stronger than that.',
  };
}

/* ── preflight ────────────────────────────────────────────────────────────── */

/**
 * `dba.preflight` — the single gate every write will pass through.
 *
 * Nothing in Layers 3 and 4 exists yet, so nothing calls this to authorise a
 * change. It ships now, with the read-only phases, because building the gate
 * after the things it gates is how a gate ends up optional.
 */
export async function preflight({ operation, table: tableName, field = null, includeIntegrity = false } = {}) {
  const [op, impact, classification] = await Promise.all([
    classifyOperation(operation),
    tableName ? analyzeImpact({ table: tableName, field }).catch((e) => ({ error: e.message })) : Promise.resolve(null),
    tableName ? classify(tableName).catch(() => null) : Promise.resolve(null),
  ]);
  const integrity = includeIntegrity && tableName
    ? await checkIntegrity(tableName).catch((e) => ({ error: e.message }))
    : null;

  const blockers = [];
  const confirmations = [];

  if (!op.known) blockers.push(`"${operation}" is not a classified operation. It is treated as irreversible and refused until it is classified.`);
  /*
   * Anything that is not a plain `true` needs the user's eyes. `partial` and
   * `unknown` are live verdicts, not matrix entries, and treating them as
   * "reversible enough" is how a captured-but-unrestorable delete gets
   * authorised as a routine one.
   */
  if (op.known && op.reversible !== true) {
    blockers.push(op.reason || op.matrixDivergence || op.statement
      || `Reversibility for ${operation} on this instance is "${op.reversible}", not a plain yes.`);
    confirmations.push(...(op.requiredConfirmations
      || (op.reversible === false
        ? DESTRUCTIVE_POLICY.irreversibleDdl.requires
        : DESTRUCTIVE_POLICY.reversibleDataDelete.requires)));
  }
  /*
   * SCHEMA RULES DO NOT APPLY TO DATA OPERATIONS.
   *
   * "incident is a platform table, never edit it directly" is a statement about
   * changing its SCHEMA. Applied to `record_delete` it is a category error, and
   * a load-bearing one: every useful table on a PDI is OOTB, so a preflight
   * that raised it for data would block every record operation NHA will ever be
   * asked to perform — and a gate that always says no gets bypassed.
   *
   * The same reasoning covers structural dependents. Child tables and inbound
   * reference fields matter enormously when the COLUMN is going away; for a
   * single record delete the relevant question is which rows point at that row,
   * which is a per-record check and belongs to Layer 4, not here.
   */
  const isSchemaOp = op.actsOn === 'schema';

  if (isSchemaOp && classification && classification.safeToModify?.verdict === 'not-directly') {
    blockers.push(classification.safeToModify.reason);
  }
  if (isSchemaOp && impact?.bySeverity?.structural) {
    blockers.push(`${impact.bySeverity.structural} structural dependent(s) — child tables or inbound reference fields — depend on this target.`);
  }
  if (isSchemaOp && impact?.findings?.some((f) => f.truncated)) {
    blockers.push('The impact scan was TRUNCATED, so the dependency list is a floor rather than a total. A schema change must not be authorised on a partial impact report.');
  }

  const goNoGo = blockers.length ? 'no-go' : 'go';
  return {
    operation,
    target: { table: tableName, field },
    verdict: goNoGo,
    blockers,
    requiredConfirmations: [...new Set(confirmations)],
    reversibility: op,
    classification,
    impactSummary: impact && !impact.error
      ? { totalDependents: impact.totalDependents, bySeverity: impact.bySeverity, blindSpots: impact.blindSpots?.length ?? 0 }
      : impact,
    integrity,
    statement: goNoGo === 'go'
      ? 'Nothing in this preflight blocks the operation. That is not the same as "safe" — read the impact report.'
      : `BLOCKED: ${blockers.length} condition(s) must be resolved or explicitly acknowledged first.`,
    note: 'No write path calls this yet — Layers 3 and 4 are not built. It ships with the read-only phases so the '
        + 'gate exists before the things it gates.',
  };
}

export const KNOWN_OPERATIONS = Object.keys(OPERATIONS);
export { OPERATIONS as OPERATION_MATRIX };
