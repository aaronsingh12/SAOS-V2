import zlib from 'node:zlib';
import { table, instanceRequest, SnowError } from './client.js';
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
 *
 * SESSION 1 / WI-4 — the third tier is gone. A record-triggered blueprint used
 * to become an inactive Business Rule "for environments where the SDK cannot
 * run". That substituted a different artifact for the one that was asked for;
 * where the SDK cannot run the honest answer is that flow authoring is
 * unavailable, with the exact next action. A Business Rule is created only
 * when a user asks for one by name, through the ordinary gated write.
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

/* ------------------------------------------------------------------ *
 * SESSION 1 / WI-6 — PUBLISHED IS A THREE-WAY AGREEMENT
 * ------------------------------------------------------------------ */

/**
 * The ways a flow can fail to be published, each named.
 *
 * MEASURED on dev424910, 2026-09-08. Every one of the 33 flows the SDK had
 * installed was `active=false, status=draft, latest_snapshot=''` — and one of
 * them ALSO had a `sys_hub_flow_snapshot` row with `status=published` under
 * that draft header. OOTB published flows (303 of them) agree three ways: the
 * header names a snapshot, that row exists and is published, and the header
 * is active. Two OOTB flows are active with no snapshot at all. So neither
 * `active` alone nor a snapshot row alone is proof; the agreement is.
 */
export const PUBLISH_MISMATCH = Object.freeze({
  NO_SNAPSHOT: 'no_snapshot',
  ACTIVE_WITHOUT_SNAPSHOT: 'active_without_snapshot',
  HEADER_DRAFT_WITH_PUBLISHED_SNAPSHOT: 'header_draft_with_published_snapshot',
  LATEST_SNAPSHOT_MISSING_ROW: 'latest_snapshot_missing_row',
  LATEST_SNAPSHOT_UNREADABLE: 'latest_snapshot_unreadable',
  SNAPSHOT_NOT_PUBLISHED: 'snapshot_not_published',
  INACTIVE_WITH_SNAPSHOT: 'inactive_with_snapshot',
});

/**
 * Decide, from the header and the snapshot rows, whether a flow is published.
 *
 * Pure: cells may be `{ value, display_value }` or plain strings, and the
 * VALUE is read every time — a label is never compared. `published: true`
 * requires all three facts to agree; a disagreement is `false` with the
 * specific one named, so a caller can say WHICH half is missing rather than
 * "not published".
 *
 * `named` is the row the header's `latest_snapshot` points at, fetched by
 * sys_id — MEASURED 2026-09-09 on dev424910: the parent_flow query returns it
 * for most OOTB flows, but on some ("Change - Conflict Detection") the row the
 * header names is not readable over REST at all while an older parent-linked
 * row is. So "the named row could not be read" is `published: null`
 * (UNKNOWN, honestly) and never `false`: a guess in either direction would be
 * the confident wrong answer this whole layer exists to prevent.
 */
export function publishedVerdict({ header, snapshots = [], named = null, namedUnreadable = false } = {}) {
  const h = header ?? {};
  const active = String(raw(h, 'active') ?? '') === 'true';
  const latest = String(raw(h, 'latest_snapshot') ?? '').trim();
  const norm = (s) => ({
    sys_id: String(raw(s, 'sys_id') ?? ''),
    status: String(raw(s, 'status') ?? ''),
    active: String(raw(s, 'active') ?? '') === 'true',
  });
  const rows = (Array.isArray(snapshots) ? snapshots : []).map(norm);
  const published = rows.filter((r) => r.status === 'published');
  const pointed = named ? norm(named) : (latest ? rows.find((r) => r.sys_id === latest) ?? null : null);

  const verdict = (mismatch, note, value = false) => ({
    published: value, mismatch, snapshot: pointed?.sys_id ?? published[0]?.sys_id ?? null, active, latest_snapshot: latest || null, note,
  });

  if (!latest) {
    if (published.length) {
      /*
       * SESSION 2 — THIS NOTE USED TO ASSERT A CAUSE THE EVIDENCE CONTRADICTS.
       *
       * It said "the publish did not complete on the header". Measured on
       * dev424910 2026-09-09 from syslog_transaction: the ONLY action ever
       * taken against the flow in this shape was
       * POST /api/now/processflow/flow/<sys_id>/test, and no activate
       * transaction exists anywhere on the instance. Pressing Test in Flow
       * Designer publishes a snapshot to run against and never touches the
       * header, so this shape is the ORDINARY result of testing a draft.
       *
       * The state is reported; the cause is not guessed at.
       */
      return verdict(PUBLISH_MISMATCH.HEADER_DRAFT_WITH_PUBLISHED_SNAPSHOT,
        `the header is ${active ? 'active' : 'a draft'} with no latest_snapshot, yet ${published.length} published snapshot row(s) exist. `
        + 'Two things produce this: somebody pressed Test in Flow Designer (which publishes a snapshot to run against '
        + 'and leaves the header alone), or a publish set the snapshot and never reached the header. This read cannot '
        + 'tell them apart — syslog_transaction can, by whether a /test or an /activate call was made.');
    }
    if (active) return verdict(PUBLISH_MISMATCH.ACTIVE_WITHOUT_SNAPSHOT, 'the header is active but names no snapshot and none exists; active alone is not published');
    return verdict(PUBLISH_MISMATCH.NO_SNAPSHOT, 'the header is a draft and no snapshot row exists');
  }
  if (!pointed) {
    if (namedUnreadable) {
      return verdict(PUBLISH_MISMATCH.LATEST_SNAPSHOT_UNREADABLE,
        `the header names snapshot ${latest}, which this connection cannot read — published state is UNKNOWN, not false`, null);
    }
    return verdict(PUBLISH_MISMATCH.LATEST_SNAPSHOT_MISSING_ROW, `the header names snapshot ${latest}, and no such row exists`);
  }
  if (pointed.status !== 'published') return verdict(PUBLISH_MISMATCH.SNAPSHOT_NOT_PUBLISHED, `the header names snapshot ${latest}, whose status is "${pointed.status}"`);
  if (!active) return verdict(PUBLISH_MISMATCH.INACTIVE_WITH_SNAPSHOT, `snapshot ${latest} is published but the header is inactive`);
  return { published: true, mismatch: null, snapshot: latest, active: true, latest_snapshot: latest, note: 'header, snapshot row and active flag agree' };
}

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

  /**
   * SESSION 1 / WI-6 — the live three-way read behind `publishedVerdict`.
   *
   * Two reads, both off the instance: the header's own `active`, `status` and
   * `latest_snapshot`, and every snapshot row whose `parent_flow` is this flow.
   * Returns the verdict plus the raw header cells, so a caller can hand the
   * header to the read-back verifier rather than a summary of it.
   */
  async publishedProof(sysId) {
    const header = await table.get('sys_hub_flow', sysId, 'false');
    if (!header) throw Object.assign(new Error(`No flow found with sys_id ${sysId}`), { status: 404 });
    const snapshots = await table.query('sys_hub_flow_snapshot', {
      query: `parent_flow=${sysId}`, fields: 'sys_id,status,active,sys_created_on', limit: 50, display: 'false',
    }).catch((err) => { if (isMissingTable(err)) return []; throw err; });
    /* The row the header actually names, by sys_id. Unreadable is a distinct
     * answer from absent — see publishedVerdict. */
    const latest = String(raw(header, 'latest_snapshot') ?? '').trim();
    let named = null;
    let namedUnreadable = false;
    if (latest) {
      try { named = await table.get('sys_hub_flow_snapshot', latest, 'false'); } catch { namedUnreadable = true; }
      if (named === undefined || named === null) named = null;
    }
    const verdict = publishedVerdict({ header, snapshots, named, namedUnreadable: namedUnreadable && !named });
    return { ...verdict, header, snapshotRows: snapshots.length, namedRowReadable: latest ? Boolean(named) : null };
  },

  executions: (flowSysId) =>
    table.query('sys_flow_context', {
      query: flowSysId ? `flow=${flowSysId}` : '',
      fields: 'sys_id,name,state,flow,sys_created_on,sys_updated_on',
      orderByDesc: 'sys_created_on',
      limit: 25,
    }),

  /*
   * SESSION 2 — `setActive` IS GONE, AND ITS ABSENCE IS THE POINT.
   *
   * It was `table.update('sys_hub_flow', sysId, { active })` — a raw REST write
   * to a Flow Designer header — and it had no callers left once Session 1
   * removed the route that used it. Leaving it was leaving the obvious
   * shortcut for "activate this flow" lying where the next person would find
   * it, and it does not activate anything: it sets `active` without a
   * published snapshot, which is the state `publishedVerdict` names
   * ACTIVE_WITHOUT_SNAPSHOT and refuses to call published. The policy already
   * refuses that write everywhere else; this closes the last door to it.
   *
   * Activation goes through `activateFlows()`, which asks the platform's own
   * activation processor and proves the result with the three-way read-back.
   */
};

/* ------------------------------------------------------------------ *
 * SESSION 2 / W1a — ACTIVATION, THROUGH THE PLATFORM'S OWN PROCESSOR
 * ------------------------------------------------------------------ */

/** Where the platform publishes flows. Read off SDK 4.10.1, not invented. */
export const ACTIVATE_FLOWS_PATH = '/api/now/wfa_fluent/activate_flows';

/**
 * Ask the instance to publish specific flows.
 *
 * ═══ WHY THIS EXISTS, AND WHY IT IS NOT A RAW WRITE ═══
 *
 * A flow is published when its header names a snapshot, that snapshot row is
 * `published`, and the header is `active` — three facts that agree. Only the
 * platform can produce that state: it compiles the definition into a snapshot
 * and points the header at it. Setting `active` over the Table API produces a
 * header that claims to be on and has nothing to run, which is why that write
 * is refused everywhere in this build and why `flows.setActive` was deleted.
 *
 * So this calls the same processor SDK 4.10.1 calls after an install
 * (sdk-api/dist/flow-activation.js). It is a REST call, and it is not a raw
 * write: the endpoint is the platform's own publish operation, and what lands
 * is decided by the platform.
 *
 * ═══ EVERY DETAIL BELOW IS READ FROM THE SDK, NOT GUESSED ═══
 *
 *   the path                `api/now/wfa_fluent/activate_flows`
 *   the scope               `sysparm_transaction_scope=<sys_scope sys_id>`
 *   the body                `{ flows: [{sys_id, active: '', state: ''}], actions: [] }`
 *                           — the two empty strings are literal; the server
 *                           interprets them, and no other value has been tested
 *   422                     a NORMAL response meaning every flow failed. The
 *                           status is not the verdict; `result.summary` is
 *   "does not represent any resource"
 *                           the endpoint is absent on this instance. The SDK
 *                           logs that at DEBUG and returns silently, which is
 *                           how an install can publish nothing and say nothing.
 *                           HERE IT IS A LOUD FAILURE.
 *
 * ═══ WHAT IT WILL NOT DO ═══
 *
 * It sends ONLY the sys_ids it is given. The SDK's own post-install task sends
 * every non-deleted key in the project (all 33 flows in this workspace today,
 * 31 of them experiments, several record-triggered on `incident`), so
 * activating through an install is an all-or-nothing act on the whole
 * application. This is scoped by construction.
 *
 * It decides nothing about success — it reports what the platform said. The
 * caller proves publication by reading the three-way proof back.
 */
export async function activateFlows({ flowSysIds = [], actionSysIds = [], scopeId } = {}) {
  const flows_ = [...new Set(flowSysIds.filter(Boolean))];
  if (!flows_.length) throw new SnowError('activateFlows was given no flow to activate.', 400);
  if (!scopeId) throw new SnowError('activateFlows needs the scope sys_id the flows live in; the platform scopes the transaction by it.', 400);

  const res = await instanceRequest(ACTIVATE_FLOWS_PATH, {
    method: 'POST',
    params: { sysparm_transaction_scope: scopeId },
    body: {
      flows: flows_.map((sys_id) => ({ sys_id, active: '', state: '' })),
      actions: actionSysIds.map((sys_id) => ({ sys_id, active: '', state: '' })),
    },
  });

  const message = res.json?.result?.error?.message ?? res.json?.error?.message ?? res.json?.message ?? res.statusText ?? '';

  /*
   * The endpoint is missing. SDK 4.10.1 swallows this at DEBUG and returns, so
   * an install "succeeds" having published nothing. Refusing loudly is the
   * whole reason this function exists rather than a second `now-sdk install`.
   */
  if (String(message).includes('does not represent any resource')) {
    throw new SnowError(
      `This instance has no flow-activation endpoint (${ACTIVATE_FLOWS_PATH} does not resolve). Flows cannot be published `
      + 'from here: the ServiceNow IDE / Fluent support that provides that scripted REST resource is not installed. '
      + 'Nothing was activated. The SDK hides this failure at debug level; it is reported here because an install that '
      + 'publishes nothing and says nothing is the exact failure this step exists to stop.',
      501, { path: ACTIVATE_FLOWS_PATH, status: res.status, message },
    );
  }
  /* 422 is a real answer; anything else that is not ok is a transport failure. */
  if (!res.ok && res.status !== 422) {
    throw new SnowError(
      `Flow activation was refused by ${res.host} (HTTP ${res.status}): ${message || res.text.slice(0, 300)}`,
      res.status, { path: ACTIVATE_FLOWS_PATH, body: res.text.slice(0, 800) },
    );
  }

  const result = res.json?.result ?? {};
  const summary = result.summary ?? null;
  const results = Array.isArray(result.results) ? result.results : [];
  return {
    /* What the PLATFORM said. Not a verdict — the read-back is the verdict. */
    reported: summary
      ? { total: Number(summary.total ?? 0), succeeded: Number(summary.succeeded ?? 0), failed: Number(summary.failed ?? 0) }
      : null,
    perFlow: results.map((r) => ({
      sys_id: r.sys_id ?? r.sysId ?? null,
      status: r.status ?? null,
      message: r.message ?? r.error ?? null,
    })),
    httpStatus: res.status,
    requested: flows_,
    scopeId,
    /* Bounded, so an unrecognised shape is still inspectable rather than lost. */
    raw: res.text.slice(0, 4000),
  };
}

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

