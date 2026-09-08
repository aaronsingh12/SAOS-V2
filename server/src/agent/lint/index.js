/**
 * PHASE 16 — NOWLINT, ASSEMBLED.
 *
 * The composition layer. Read down it and the only new ideas are: which flow,
 * which rules, and how to answer a rule's question from the instance. Every
 * authority it consults already existed — the dictionary, `sys_choice`, the
 * semantic layer, capability discovery, and Phase 15's execution reader.
 *
 * WHAT IS DELIBERATELY ABSENT (§5, §63):
 *
 *   no lintExecutor      a fix becomes a goal for the existing planner
 *   no lintVerifier      a fix is verified by the existing read-back
 *   no lintApproval      the existing approval card, unchanged
 *   no lint database     the run is stored on the task, as Phase 14 stores a
 *                        diagnosis
 *
 * THE CONTEXT IS THE INTERESTING PART. Every rule asks its questions through
 * `ctx`, and `ctx` is the only thing in this phase that touches the instance.
 * That has two consequences worth stating: a rule cannot accidentally invent an
 * authority, and every answer is CACHED per run, so linting a flow that writes
 * six fields on one table reads that dictionary once rather than six times
 * (§58).
 *
 * A CONTEXT ANSWER OF `null` MEANS "COULD NOT ESTABLISH". Never false, never an
 * empty set standing in for absence. Rules turn that null into an UNKNOWN
 * check, which is how §39 is honoured all the way from a failed HTTP read to
 * the sentence a person reads.
 */
import { RULES, RULE_IDS } from './rules.js';
import { deduplicate, rank, summarise } from './findings.js';
import { emptyResult, STATUS } from './schemas.js';

/**
 * Build the context the rules interrogate.
 *
 * Every collaborator is injected. Not only for testing: it makes the absence of
 * a second ServiceNow path a property of this file's signature rather than a
 * promise in a comment.
 */
export function makeContext({
  getSchema, table, derivationOf, discovered, flowExecutionsFor,
}) {
  const schemaCache = new Map();
  const choiceCache = new Map();
  const tableCache = new Map();
  const existsCache = new Map();
  const matchCache = new Map();
  let executions;
  const reads = { schema: 0, choices: 0, records: 0, executions: 0 };

  return {
    reads,

    /** Columns of a table, as a Map, or null if the dictionary is unreadable. */
    async schemaOf(tableName) {
      if (!tableName) return null;
      if (schemaCache.has(tableName)) return schemaCache.get(tableName);
      let value = null;
      try {
        reads.schema += 1;
        const schema = await getSchema(tableName);
        const fields = schema?.fields ?? [];
        /*
         * AN EMPTY DICTIONARY IS NOT AN EMPTY TABLE.
         *
         * FOUND BY THE PDI TEST, and it was a false positive of the worst kind.
         * `getSchema` on a table that does not exist does not throw — the
         * dictionary query simply matches nothing and it returns zero fields.
         * Every field then looks absent, so FLOW001 reported
         * "incident.anything does not exist" as CONFIRMED, with a live_schema
         * citation, about a table nothing is known about.
         *
         * Every real table has columns. Zero means the dictionary told us
         * nothing, which is an UNKNOWN and not a licence to say every field is
         * missing. §65.1 and §65.6 both turn on exactly this.
         */
        value = fields.length ? new Map(fields.map((f) => [f.name, f])) : null;
      } catch {
        value = null;                                 // unreadable, not empty
      }
      schemaCache.set(tableName, value);
      return value;
    },

    /**
     * A trigger's table arrives as a LABEL ("Change Management Worker"), so it
     * has to be resolved to a name before anything can be checked against it.
     * A label that resolves to nothing returns null rather than being passed
     * through as if it were a table name.
     */
    async resolveTable(label) {
      if (!label) return null;
      if (tableCache.has(label)) return tableCache.get(label);
      let name = null;
      try {
        reads.schema += 1;
        const rows = await table.query('sys_db_object', {
          query: `label=${label}^ORname=${label}`, fields: 'name,label', limit: 2, display: 'false',
        });
        if (rows.length === 1) name = rows[0].name;
        else if (rows.length > 1) name = rows.find((r) => r.name === label)?.name ?? null;
      } catch { name = null; }
      tableCache.set(label, name);
      return name;
    },

    /** Declared choice values for a field, or null when none are declared. */
    async choicesFor(tableName, field) {
      const key = `${tableName}.${field}`;
      if (choiceCache.has(key)) return choiceCache.get(key);
      let value = null;
      try {
        reads.choices += 1;
        const rows = await table.query('sys_choice', {
          query: `name=${tableName}^element=${field}^inactive=false`,
          fields: 'value', limit: 100, display: 'false',
        });
        value = new Set(rows.map((r) => String(r.value)));
      } catch { value = null; }
      choiceCache.set(key, value);
      return value;
    },

    /** How many records in `tableName` carry this display value. Null if unknown. */
    async countMatches(tableName, displayValue) {
      const key = `${tableName}::${displayValue}`;
      if (matchCache.has(key)) return matchCache.get(key);
      let value = null;
      try {
        reads.records += 1;
        const display = await displayFieldOf(tableName, getSchema);
        if (display) {
          const rows = await table.query(tableName, {
            query: `${display}=${displayValue}`, fields: 'sys_id', limit: 10, display: 'false',
          });
          value = rows.length;
        }
      } catch { value = null; }
      matchCache.set(key, value);
      return value;
    },

    /** Does this record exist? True, false, or null when the read failed. */
    async recordExists(tableName, sysId) {
      const key = `${tableName}/${sysId}`;
      if (existsCache.has(key)) return existsCache.get(key);
      let value = null;
      try {
        reads.records += 1;
        const rows = await table.query(tableName, {
          query: `sys_id=${sysId}`, fields: 'sys_id', limit: 1, display: 'false',
        });
        value = rows.length > 0;
      } catch { value = null; }
      existsCache.set(key, value);
      return value;
    },

    /** Semantic derived-field fact, or null. */
    derivationOf(tableName, field) {
      try { return derivationOf(tableName, field, { hierarchy: [tableName] }); } catch { return null; }
    },

    /** Capability discovery, unchanged. */
    capability(name) { return discovered?.capabilities?.[name] ?? null; },

    /**
     * Executions of this FLOW (§26, §32).
     *
     * Phase 15 reads executions by SUBJECT record; a linter wants them by the
     * flow itself, so this queries the same table on `flow`. Returns null when
     * the read fails, so FLOW008 reports an UNKNOWN rather than "never failed".
     */
    async executionsOf(flowSysId) {
      if (executions !== undefined) return executions;
      executions = null;
      try {
        reads.executions += 1;
        const rows = await table.query('sys_flow_context', {
          query: `flow=${flowSysId}^ORDERBYDESCsys_created_on`,
          fields: 'sys_id,name,state,error_message,sys_created_on', limit: 10, display: 'false',
        });
        executions = rows.map((r) => ({
          sys_id: r.sys_id,
          state: classify(r.state),
          error: r.error_message || null,
          flow: { name: r.name },
          at: r.sys_created_on,
        }));
      } catch { executions = null; }
      return executions;
    },

    _flowExecutionsFor: flowExecutionsFor,
  };
}

/** Reuse the diagnostics vocabulary rather than inventing a second one. */
function classify(raw) {
  const s = String(raw ?? '').toUpperCase();
  if (s === 'ERROR') return 'EXECUTION_ERROR';
  if (s === 'COMPLETE') return 'EXECUTION_COMPLETE';
  if (s === 'CANCELLED') return 'EXECUTION_CANCELLED';
  if (s === 'WAITING' || s === 'QUEUED') return 'EXECUTION_WAITING';
  if (s === 'PAUSED' || s === 'PAUSED_IN_DEBUG') return 'EXECUTION_PAUSED';
  if (s === 'IN_PROGRESS' || s === 'CONTINUE_SYNC') return 'EXECUTION_RUNNING';
  return 'EXECUTION_UNKNOWN';
}

const displayCache = new Map();
async function displayFieldOf(tableName, getSchema) {
  if (displayCache.has(tableName)) return displayCache.get(tableName);
  let field = null;
  try {
    const schema = await getSchema(tableName);
    field = schema.fields.find((f) => f.name === 'name')?.name
      ?? schema.fields.find((f) => f.name === 'number')?.name
      ?? null;
  } catch { field = null; }
  displayCache.set(tableName, field);
  return field;
}

/**
 * Lint one flow.
 *
 * @param {object} artifact  the normalised live flow
 * @param {object} ctx       the instance-answering context
 *
 * Every rule runs, and a rule that throws becomes an UNKNOWN check rather than
 * taking the run down — one broken rule must not cost a person every other
 * finding, and silently dropping it would be worse still.
 */
export async function lintFlow(artifact, ctx, { rules = RULES } = {}) {
  const findings = [];
  const unknown = [];
  const ran = [];

  for (const rule of rules) {
    try {
      const out = await rule.analyze(artifact, ctx);
      findings.push(...(out?.findings ?? []));
      unknown.push(...(out?.unknown ?? []));
      ran.push(rule.id);
    } catch (err) {
      unknown.push({
        rule_id: rule.id,
        reason: `The rule could not be evaluated: ${err.message}`,
        affected: { flow: artifact.flow?.name ?? null },
      });
    }
  }

  /*
   * The artifact's own gaps become UNKNOWN checks too. A trigger whose config
   * would not decode is a check nobody could run, and it belongs beside the
   * others rather than in a footnote on the artifact.
   */
  for (const gap of artifact.gaps ?? []) {
    unknown.push({ rule_id: 'ARTIFACT', reason: gap, affected: { flow: artifact.flow?.name ?? null } });
  }

  const deduped = rank(deduplicate(findings));
  return {
    ...emptyResult(),
    flow: artifact.flow,
    findings: deduped,
    unknown_checks: unknown,
    rules_run: ran,
    summary: summarise(deduped, unknown, ran),
    gaps: artifact.gaps ?? [],
    reads: ctx.reads,
  };
}

export { RULES, RULE_IDS, STATUS };
export * from './schemas.js';
export { fingerprint, deduplicate, rank, summarise, makeFinding } from './findings.js';
export { parseFieldMap, DESTRUCTIVE } from './rules.js';
export { renderLint } from './render.js';
