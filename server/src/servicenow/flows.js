import zlib from 'node:zlib';
import { table } from './client.js';
import { chatOnce } from '../agent/providers/index.js';

/**
 * Flow Designer module.
 *
 * READ side: flows and their parts are ordinary records —
 *   sys_hub_flow      flow / subflow headers (the `type` field distinguishes them)
 *   sys_flow_context  executions
 * plus one *family* of part tables. Current releases write the `_v2` tables;
 * older instances use the unsuffixed names. Both families exist side by side on
 * a modern instance, and the legacy tables are EMPTY for modern flows — so
 * reading the legacy names silently yields zero rows that look like "this flow
 * has no trigger". detail() therefore prefers `_v2`, falls back only when the
 * v2 tables genuinely do not exist, and always reports which family it used via
 * `sourceTables`.
 *
 * WRITE side: authoring is done with the ServiceNow SDK (Fluent) — see
 * ./fluent.js. There is still no supported REST API for inserting sys_hub_*
 * records directly, and this module never attempts it.
 *
 * Authoring tiers:
 *   1. "fluentSdk"       (shipped)  — generate Fluent TypeScript, compile it
 *                                     offline, install it. See fluent.js.
 *   2. "blueprint"       (shipped)  — LLM designs a precise build spec.
 *   3. "classicFallback" (shipped)  — record-triggered blueprints become an
 *                                     inactive Business Rule, for environments
 *                                     where the SDK cannot run.
 */

const PART_FAMILIES = {
  v2: {
    triggers: { table: 'sys_hub_trigger_instance_v2', fields: 'sys_id,trigger_type,name,comment,trigger_inputs' },
    actions: { table: 'sys_hub_action_instance_v2', fields: 'sys_id,order,action_type,comment' },
    /* PHASE 18 adds `ui_id`/`parent_ui_id`. They are the identity a diff matches
     * containers on across two states — the row sys_id differs between a flow and
     * its snapshot, and `order` moves whenever anything is inserted. */
    logic: { table: 'sys_hub_flow_logic_instance_v2', fields: 'sys_id,order,logic_definition,comment,ui_id,parent_ui_id' },
    // A subflow CALL is not an action instance. It has its own table, and
    // omitting it made a flow whose only step is a call read back as
    // "1 trigger, 0 actions, 0 logic" — a flow that does nothing. Measured on
    // the §32 A4 caller, which had exactly that shape.
    subflows: { table: 'sys_hub_sub_flow_instance_v2', fields: 'sys_id,order,comment,subflow,wait_for_completion,subflow_inputs,ui_id,parent_ui_id' },
  },
  legacy: {
    triggers: { table: 'sys_hub_trigger_instance', fields: 'sys_id,trigger_type,table,condition,active,sys_class_name' },
    actions: { table: 'sys_hub_action_instance', fields: 'sys_id,order,active,action_type,comment,sys_updated_on' },
    logic: { table: 'sys_hub_flow_logic', fields: 'sys_id,order,active,logic_definition,sys_updated_on' },
    subflows: { table: 'sys_hub_sub_flow_instance', fields: 'sys_id,order,comment,subflow' },
  },
};

/** display='all' wraps every field as {value, display_value}. */
const raw = (record, field) => {
  const v = record?.[field];
  return v && typeof v === 'object' ? v.value : v;
};

/** A table that does not exist on this instance answers 400 "Invalid table X". */
const isMissingTable = (err) => err?.status === 400 && /invalid table/i.test(err.message || '');

/**
 * Trigger configuration (table, condition, ...) is not stored in columns — it
 * lives in `trigger_inputs` as gzipped, base64-encoded JSON. Decoding it is the
 * only way to show what a trigger actually listens to.
 *
 * A subflow CALL stores its input mapping the same way, in `subflow_inputs`, so
 * one decoder serves both.
 */
function decodeInputs(encoded) {
  if (!encoded) return null;
  try {
    const json = zlib.gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    const config = {};
    for (const p of parsed) {
      if (p?.name && p.value !== '' && p.value != null) {
        config[p.name] = p.displayValue || p.value;
      }
    }
    return config;
  } catch {
    // Format changed or the blob is not gzip — surface absence, never a guess.
    return null;
  }
}

/**
 * PHASE 17 — the same blob, keeping the RAW values.
 *
 * `decodeInputs` above prefers `displayValue`, which is right for a human
 * reading what a trigger listens to: "Change Management Worker" is the answer
 * to that question. It is the wrong answer for anything that has to ACT on the
 * trigger — a fixture has to be created on `chg_mgt_worker`, and no amount of
 * label-to-table guessing is as good as the value the platform already stored
 * beside the label.
 *
 * Additive and separate rather than a change to the decoder above: every
 * existing reader of `config` keeps the labels it has always been given, and a
 * caller that needs identities asks for identities.
 */
function decodeInputValues(encoded) {
  if (!encoded) return null;
  try {
    const json = zlib.gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    const values = {};
    for (const p of parsed) {
      if (p?.name && p.value !== '' && p.value != null) values[p.name] = p.value;
    }
    return values;
  } catch {
    return null;
  }
}

async function queryPart({ table: t, fields }, sysId, orderBy) {
  try {
    const rows = await table.query(t, {
      query: `flow=${sysId}`,
      fields,
      ...(orderBy ? { orderBy } : {}),
      limit: 100,
    });
    return { rows, available: true };
  } catch (err) {
    if (isMissingTable(err)) return { rows: [], available: false };
    throw err; // real failures (ACL, network, bad query) must surface
  }
}

async function readFamily(familyName, sysId) {
  const fam = PART_FAMILIES[familyName];
  const [triggers, actions, logic, subflows] = await Promise.all([
    queryPart(fam.triggers, sysId),
    queryPart(fam.actions, sysId, 'order'),
    queryPart(fam.logic, sysId, 'order'),
    queryPart(fam.subflows, sysId, 'order'),
  ]);
  return { familyName, triggers, actions, logic, subflows };
}

export const flows = {
  /**
   * Lists flows AND subflows. `type` filters to one kind ('flow' | 'subflow');
   * anything else (default) returns both, because live authoring creates
   * subflows and hiding them makes deployed work look missing.
   */
  list: ({ search = '', activeOnly = false, type = 'all' } = {}) => {
    const clauses = [];
    if (type === 'flow' || type === 'subflow') clauses.push(`type=${type}`);
    if (activeOnly) clauses.push('active=true');
    if (search) clauses.push(`nameLIKE${search}`);
    return table.query('sys_hub_flow', {
      query: clauses.join('^'),
      fields: 'sys_id,name,description,active,type,status,sys_scope,sys_updated_on,sys_created_by',
      orderBy: 'name',
      limit: 100,
    });
  },

  /** Exact-name lookup — used to read back what an install actually shipped. */
  findByName: (name, type) => {
    const clauses = [`name=${name}`];
    if (type) clauses.push(`type=${type}`);
    return table.query('sys_hub_flow', {
      query: clauses.join('^'),
      fields: 'sys_id,name,description,active,type,status,sys_scope,sys_updated_on',
      limit: 10,
    });
  },

  /**
   * Reads a flow top-to-bottom. Returns `sourceTables` so callers can see which
   * table family answered, and `notes` for anything the caller would otherwise
   * have to infer from an empty array.
   */
  async detail(sysId) {
    /*
     * PHASE 18 — READ THE BASE CLASS, so a SNAPSHOT resolves as well as a flow.
     *
     * MEASURED on dev424910. Flow Designer keeps a published copy of every flow
     * in `sys_hub_flow_snapshot`, and that copy is a full second state of the
     * artifact: the action and trigger instances carry the SNAPSHOT's sys_id in
     * their `flow` column exactly as they carry the live flow's, so the reads
     * below already work on one without knowing which it has.
     *
     * The only thing that did not work was this line. `sys_hub_flow` holds the
     * live record and nothing else; the snapshot lives in a sibling table, and
     * both extend `sys_hub_flow_base`. Reading the BASE resolves either, and
     * the returned row carries `sys_class_name` so a caller can still tell them
     * apart — which Phase 18 needs, because "the live flow" and "the version
     * that was published" are the two states a diff is between.
     *
     * This widens what can be READ and nothing else. There is no write path
     * here, and a sys_id that is neither still 404s.
     */
    const flow = await table.get('sys_hub_flow_base', sysId);
    if (!flow) throw Object.assign(new Error(`No flow found with sys_id ${sysId}`), { status: 404 });

    let result = await readFamily('v2', sysId);
    const notes = [];

    const v2Available = result.triggers.available || result.actions.available || result.logic.available || result.subflows.available;
    if (!v2Available) {
      // Only legitimate reason to read the legacy tables: v2 isn't on this instance.
      result = await readFamily('legacy', sysId);
      notes.push('This instance has no *_v2 flow tables; read the legacy tables instead.');
    }

    const fam = PART_FAMILIES[result.familyName];
    for (const [part, res] of Object.entries({ triggers: result.triggers, actions: result.actions, logic: result.logic, subflows: result.subflows })) {
      if (!res.available) notes.push(`Table ${fam[part].table} does not exist on this instance; ${part} could not be read.`);
    }
    const isSubflow = raw(flow, 'type') === 'subflow';
    if (result.triggers.available && result.triggers.rows.length === 0) {
      notes.push(
        isSubflow
          ? 'Subflows have no trigger by design — they are invoked by other flows.'
          : 'No trigger instance found for this flow.'
      );
    }

    // Who invokes this, read off the instance. Only meaningful for a subflow,
    // and only asked for one — the two-hop lookup is not free.
    const callers = isSubflow ? await this.callers(sysId).catch(() => []) : [];
    if (isSubflow && !callers.length) {
      notes.push('No deployed flow calls this subflow. Nothing will invoke it until one does.');
    }

    // Attach decoded trigger configuration (table / condition / strategy).
    const triggers = result.triggers.rows.map((t) => {
      const config = decodeInputs(raw(t, 'trigger_inputs'));
      const configValues = decodeInputValues(raw(t, 'trigger_inputs'));
      const { trigger_inputs: _drop, ...rest } = t; // the raw blob is noise for clients
      return { ...rest, config, configValues };
    });

    // Subflow calls, with the input mapping decoded out of the same kind of blob.
    const subflowCalls = result.subflows.rows.map((c) => {
      const inputs = decodeInputs(raw(c, 'subflow_inputs'));
      const { subflow_inputs: _drop, ...rest } = c;
      return { ...rest, inputs };
    });
    if (subflowCalls.length && result.actions.rows.length === 0) {
      notes.push(
        `This flow's ${subflowCalls.length} step(s) are subflow CALLS, not actions — ` +
        `"0 actions" here does not mean the flow is empty.`
      );
    }

    return {
      flow,
      triggers,
      actions: result.actions.rows,
      logic: result.logic.rows,
      subflowCalls,
      callers,
      sourceTables: {
        family: result.familyName,
        triggers: fam.triggers.table,
        actions: fam.actions.table,
        logic: fam.logic.table,
        subflows: fam.subflows.table,
      },
      notes,
    };
  },

  /**
   * The I/O contract of a subflow, as the INSTANCE holds it.
   *
   * Inputs and outputs are var_dictionary-shaped rows keyed by `model` — the
   * flow's sys_id — with `element` carrying the internal name a caller has to
   * use. This is read back beside the contract parsed from the Fluent source
   * so the two can be compared: the source says what the next install will
   * deploy, the instance says what is deployed, and a drift between them is
   * visible rather than inferred.
   */
  async contract(sysId) {
    const read = async (t) => {
      const rows = await table.query(t, {
        query: `model=${sysId}^ORDERBYorder`,
        fields: 'sys_id,element,label,internal_type,reference,mandatory,order',
        limit: 100, display: 'false',
      }).catch((err) => { if (isMissingTable(err)) return []; throw err; });
      return rows.map((r) => ({
        name: r.element,
        label: r.label || null,
        type: r.internal_type || null,
        reference: r.reference || null,
        mandatory: r.mandatory === 'true',
      }));
    };
    const [inputs, outputs] = await Promise.all([read('sys_hub_flow_input'), read('sys_hub_flow_output')]);
    return { inputs, outputs };
  },

  /**
   * `<scope>.<internal_name>` — the only address sn_fd.FlowAPI accepts.
   *
   * Both halves are read off the instance rather than derived. `internal_name`
   * is generated by Flow Designer from the display name and is NOT the slug:
   * "High-Priority Incident Escalation Logic" is stored as
   * `highpriority_incident_escalation_logic`, with the hyphen dropped rather
   * than converted. Guessing it produces a name the runner refuses.
   */
  async qualifiedName(sysId) {
    const flow = await table.get('sys_hub_flow', sysId);
    if (!flow) throw Object.assign(new Error(`No flow found with sys_id ${sysId}`), { status: 404 });
    const internal = raw(flow, 'internal_name');
    if (!internal) throw new Error(`"${raw(flow, 'name')}" has no internal_name on the instance, so it cannot be addressed by sn_fd.FlowAPI.`);
    const scopeId = raw(flow, 'sys_scope');
    const rows = scopeId
      ? await table.query('sys_scope', { query: `sys_id=${scopeId}`, fields: 'scope', limit: 1, display: 'false' })
      : [];
    const scope = rows[0]?.scope || 'global';
    return { qualified: `${scope}.${internal}`, scope, internal_name: internal, name: raw(flow, 'name'), type: raw(flow, 'type') };
  },

  /**
   * Which flows call this subflow, read off the INSTANCE.
   *
   * Two hops, because a call does not reference the subflow directly. It
   * references a published SNAPSHOT (`sys_hub_flow_snapshot`), and the snapshot
   * points back at the artifact through `parent_flow`. Resolving only the first
   * hop yields an id that is on no table anyone would think to look at, which is
   * what made this non-obvious.
   *
   * This complements the source-derived graph in subflows.js rather than
   * replacing it: the source says what the next install will deploy, this says
   * what is deployed — including callers this project does not manage.
   */
  async callers(sysId) {
    const snaps = await table.query('sys_hub_flow_snapshot', {
      query: `parent_flow=${sysId}`, fields: 'sys_id', limit: 100, display: 'false',
    }).catch((err) => { if (isMissingTable(err)) return []; throw err; });
    if (!snaps.length) return [];

    const ids = snaps.map((r) => r.sys_id).join(',');
    const calls = await table.query('sys_hub_sub_flow_instance_v2', {
      query: `subflowIN${ids}`, fields: 'sys_id,flow,comment', limit: 100, display: 'false',
    }).catch((err) => { if (isMissingTable(err)) return []; throw err; });

    const byFlow = new Map();
    for (const c of calls) {
      if (!c.flow || byFlow.has(c.flow)) continue;
      byFlow.set(c.flow, { sys_id: c.flow, name: null });
    }
    if (!byFlow.size) return [];
    const rows = await table.query('sys_hub_flow', {
      query: `sys_idIN${[...byFlow.keys()].join(',')}`, fields: 'sys_id,name,type,active', limit: 100, display: 'false',
    });
    return rows.map((r) => ({ sys_id: r.sys_id, name: r.name, type: r.type, active: r.active === 'true' }));
  },

  executions: (flowSysId) =>
    table.query('sys_flow_context', {
      query: flowSysId ? `flow=${flowSysId}` : '',
      fields: 'sys_id,name,state,flow,sys_created_on,sys_updated_on',
      orderByDesc: 'sys_created_on',
      limit: 25,
    }),

  setActive: (sysId, active) =>
    table.update('sys_hub_flow', sysId, { active: active ? 'true' : 'false' }),
};

const BLUEPRINT_SYSTEM = `You are a senior ServiceNow Flow Designer architect. Given a plain-language automation request, design a precise flow blueprint.

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "name": "short flow name",
  "description": "one paragraph",
  "trigger": {
    "type": "record_created" | "record_updated" | "record_created_or_updated" | "scheduled" | "service_catalog",
    "table": "servicenow_table_name or null",
    "condition_encoded_query": "ServiceNow encoded query or empty string",
    "condition_plain": "human readable condition",
    "schedule": "cron-like description or null"
  },
  "inputs": [{ "name": "...", "type": "...", "purpose": "..." }],
  "steps": [
    {
      "order": 1,
      "kind": "action" | "if" | "else" | "foreach" | "end",
      "summary": "what this step does",
      "flow_designer_action": "the exact Flow Designer action to pick (e.g. 'Look Up Records', 'Update Record', 'Send Email', 'Ask For Approval')",
      "config": { "key": "value pairs the builder should enter" }
    }
  ],
  "reference_fields_used": [{ "field": "...", "table": "...", "referenced_table": "..." }],
  "test_plan": ["step by step verification"],
  "notes": "risks, ACLs, or release caveats"
}
Use real ServiceNow table names and real encoded query syntax. Be specific enough that a junior admin can build it without guessing.`;

export async function designFlowBlueprint(description) {
  const raw = await chatOnce({
    system: BLUEPRINT_SYSTEM,
    user: description,
    maxTokens: 3000,
  });
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try {
    return { blueprint: JSON.parse(cleaned) };
  } catch {
    return { blueprint: null, raw: cleaned, error: 'Model did not return valid JSON. Raw output included.' };
  }
}

const RULE_SYSTEM = `You convert a ServiceNow flow blueprint into an equivalent server-side Business Rule when the trigger is record-based. Respond with ONLY JSON:
{
  "name": "...",
  "when": "after" | "before" | "async",
  "action_insert": true|false,
  "action_update": true|false,
  "condition_encoded_query": "...",
  "script": "ES5 GlideRecord script using (function executeRule(current, previous) { ... })(current, previous); Use gs.info for logging. No modern JS syntax."
}
The script must faithfully implement the blueprint steps that are implementable server-side; note skipped steps in comments.`;

export async function blueprintToBusinessRule(blueprint) {
  const t = blueprint?.trigger || {};
  if (!t.table || !String(t.type || '').startsWith('record')) {
    return { error: 'Classic fallback only applies to record-triggered blueprints (created/updated on a table).' };
  }
  const raw = await chatOnce({
    system: RULE_SYSTEM,
    user: JSON.stringify(blueprint),
    maxTokens: 3000,
  });
  const cleaned = raw.replace(/```json|```/g, '').trim();
  let spec;
  try { spec = JSON.parse(cleaned); } catch {
    return { error: 'Model did not return valid JSON for the business rule.', raw: cleaned };
  }
  const record = await table.create('sys_script', {
    name: spec.name || `NowHelpAssist: ${blueprint.name}`,
    collection: t.table,
    when: spec.when || 'after',
    action_insert: spec.action_insert ? 'true' : 'false',
    action_update: spec.action_update ? 'true' : 'false',
    filter_condition: spec.condition_encoded_query || t.condition_encoded_query || '',
    script: spec.script || '// empty',
    description: `Generated by NowHelpAssist from flow blueprint "${blueprint.name}". Review before activating.`,
    active: 'false', // always created inactive — review first
  });
  return { rule: record, spec };
}
