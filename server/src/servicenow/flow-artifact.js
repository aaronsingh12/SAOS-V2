/**
 * PHASE 16 — THE LIVE FLOW, NORMALISED.
 *
 * §7 is emphatic that the live artifact is authoritative: a flow must be read
 * off the instance, never reconstructed from model knowledge or from the plan
 * that built it. This module is that read, plus the decoding needed to make it
 * analysable.
 *
 * WHAT A FLOW ACTUALLY LOOKS LIKE, measured on dev424910. `sys_hub_flow` holds
 * a header and nothing you could lint. The parts that matter are elsewhere and
 * both are GZIPPED, BASE64-ENCODED JSON in a single column:
 *
 *   sys_hub_trigger_instance_v2.trigger_inputs   the table and condition
 *   sys_hub_action_instance_v2.values            every action input
 *
 * `flows.js` already decodes the first — that is how "what does this trigger
 * listen to" is answerable at all. The second was not decoded anywhere, and it
 * is where the lintable substance lives: each entry carries the input's name,
 * the value the flow supplies, and a `parameter` block declaring the input's
 * type and whether it is MANDATORY. Without it a flow is an ordered list of
 * action names; with it, a flow is something that can be checked.
 *
 * NOTHING HERE JUDGES. It reads and reshapes. Whether a field exists, whether a
 * value is ambiguous, whether an input is missing — all of that is decided in
 * `agent/lint/rules.js` against the live dictionary, and this module would be
 * the wrong place for it: a normaliser that formed opinions would make every
 * rule depend on the shape of the opinion rather than on the instance.
 *
 * ABSENCE IS REPORTED, NEVER FILLED IN. A blob that will not decode, a table
 * this instance does not have, an action with no inputs — each comes back as a
 * stated gap, because §39 turns on a linter never mistaking "I could not read
 * this" for "there is nothing here".
 */
import zlib from 'node:zlib';
import { table } from './client.js';
import { flows } from './flows.js';

/** ServiceNow returns `{ display_value, value }`; keep both where both matter. */
const val = (raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) return raw.value ?? null;
  return raw ?? null;
};
const disp = (raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'display_value' in raw) {
    return raw.display_value || (raw.value ?? null);
  }
  return raw ?? null;
};

/**
 * Decode one of the gzip+base64 blobs into the array ServiceNow put there.
 *
 * Returns null rather than throwing or guessing. A blob whose format changed
 * under a future release must surface as "this could not be read", which the
 * caller turns into a stated gap — the alternative is a lint run that silently
 * analyses nothing and reports a clean bill of health.
 */
export function decodeBlob(encoded) {
  if (!encoded) return null;
  try {
    const json = zlib.gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One action input, as the instance describes it.
 *
 * `supplied` is what the flow provides; `declared` is what the action type says
 * it accepts. Keeping them apart is what lets FLOW004 (a mandatory input with
 * nothing in it) and FLOW005 (a value with no matching declaration) be two
 * different findings rather than one vague one.
 *
 * A `{{...}}` value is a DATA PILL — a reference to another step's output — and
 * is marked as such. A pill is not a literal, so a rule that checks literals
 * must not read one as a suspicious string.
 */
function normalizeInput(entry) {
  const p = entry?.parameter ?? null;
  const supplied = entry?.value ?? null;
  const text = supplied === null || supplied === undefined ? '' : String(supplied);
  return {
    name: entry?.name ?? null,
    label: p?.label ?? null,
    type: p?.type ?? null,
    mandatory: p?.mandatory === true,
    read_only: p?.read_only === true || p?.readOnly === true,
    reference: p?.reference || null,
    depends_on: p?.dependent_on || null,
    supplied: text,
    display: entry?.displayValue || null,
    /* A data pill points at another step; it is not a value this flow chose. */
    is_pill: /^\{\{.*\}\}$/.test(text.trim()),
    empty: text.trim() === '',
    declared: Boolean(p),
    children: Array.isArray(entry?.children)
      ? entry.children.map((c) => ({ name: c?.name ?? null, supplied: String(c?.value ?? '') }))
      : [],
  };
}

/**
 * The whole flow, normalised (§8).
 *
 * Only fields the instance actually returned appear. `gaps` carries everything
 * that could not be read, so a caller can tell a rule "you have no evidence for
 * this" instead of letting the rule assume absence means health.
 */
export async function readFlowArtifact(sysId) {
  const detail = await flows.detail(sysId);
  const header = detail.flow ?? {};
  const gaps = [...(detail.notes ?? [])];

  /* ---- trigger: already decoded by flows.js ---- */
  const triggers = (detail.triggers ?? []).map((t) => ({
    sys_id: val(t.sys_id),
    type: val(t.trigger_type),
    name: disp(t.name),
    /* `config.table` arrives as a LABEL ("Change Management Worker"); the
     * caller resolves it, because resolving needs a schema read and this
     * module performs none of its own analysis. */
    config: t.config ?? null,
    table_label: t.config?.table ?? null,
    /*
     * PHASE 17 — the table's IDENTITY, beside its label.
     *
     * The same blob carries both: the label is what a reader wants, the name is
     * what a fixture has to be created on. `flows.js` now decodes the raw
     * values alongside the display ones, so this is a read rather than a
     * resolution — nothing here maps a label onto a table, which is a guess
     * this module has no business making.
     */
    table: t.configValues?.table ?? null,
    condition: t.config?.condition ?? null,
    /* The condition, unresolved. `config.condition` prefers displayValue, which
     * substitutes labels into an encoded query and makes it unusable as one. */
    condition_query: t.configValues?.condition ?? null,
    strategy: t.configValues?.trigger_strategy ?? t.config?.trigger_strategy ?? null,
  }));
  if (!triggers.length) gaps.push('This flow has no readable trigger instance.');
  for (const t of triggers) {
    if (!t.config) gaps.push(`Trigger ${t.name ?? t.sys_id} has configuration that could not be decoded.`);
  }

  /* ---- actions: the values blob is decoded HERE, first time in this build ---- */
  const ACTION_LIMIT = 100;
  const actionRows = await table.query('sys_hub_action_instance_v2', {
    query: `flow=${sysId}^ORDERBYorder`,
    fields: 'sys_id,action_type,action_type_parent,order,comment,values,ui_id,parent_ui_id',
    /* One more than the ceiling, so "there are more" is OBSERVED rather than
     * guessed from a full page — the same trick `diagnostics.js` uses. */
    limit: ACTION_LIMIT + 1,
    display: 'all',
  }).catch(() => []);
  /*
   * PHASE 18 — A TRUNCATED READ IS A GAP, NOT A SHORTER FLOW.
   *
   * FOUND BY REVIEW. The read stopped at a hundred actions and said nothing, so
   * a flow with more than that normalised to its first hundred and compared
   * clean against anything sharing them. §40 is explicit that a partial read
   * must never render as a whole one, and silence is exactly how it did.
   */
  const actionsTruncated = actionRows.length > ACTION_LIMIT;
  if (actionsTruncated) {
    actionRows.length = ACTION_LIMIT;
    gaps.push(`This flow has more than ${ACTION_LIMIT} actions; only the first ${ACTION_LIMIT} were read.`);
  }

  /* Action type NAMES, resolved in one query rather than one per action. */
  const typeIds = [...new Set(actionRows.map((a) => val(a.action_type)).filter(Boolean))];
  const typeNames = new Map();
  if (typeIds.length) {
    const rows = await table.query('sys_hub_action_type_base', {
      query: `sys_idIN${typeIds.join(',')}`, fields: 'sys_id,name', limit: 100, display: 'false',
    }).catch(() => []);
    for (const r of rows) typeNames.set(r.sys_id, r.name);
  }

  const actions = actionRows.map((a) => {
    const decoded = decodeBlob(val(a.values));
    if (val(a.values) && decoded === null) {
      gaps.push(`Action ${val(a.sys_id)} has inputs that could not be decoded.`);
    }
    return {
      sys_id: val(a.sys_id),
      order: val(a.order),
      type_sys_id: val(a.action_type),
      type_name: typeNames.get(val(a.action_type)) ?? disp(a.action_type) ?? null,
      comment: val(a.comment) || null,
      ui_id: val(a.ui_id) || null,
      parent_ui_id: val(a.parent_ui_id) || null,
      inputs: (decoded ?? []).map(normalizeInput),
      inputs_readable: decoded !== null || !val(a.values),
    };
  });

  return {
    flow: {
      sys_id: val(header.sys_id) ?? sysId,
      name: val(header.name),
      description: val(header.description) || null,
      active: val(header.active) === 'true' || val(header.active) === true,
      type: val(header.type),
      status: val(header.status),
      scope: disp(header.sys_scope),
      updated_on: val(header.sys_updated_on),
    },
    triggers,
    actions,
    /*
     * PHASE 18 — normalised here rather than passed through raw.
     *
     * These two were emitted as whatever the Table API returned, cells and all,
     * and nothing consumed them. A comparison does, and a diff over
     * `{display_value, value}` pairs would compare the labels beside the
     * identities — the exact mistake §19 exists to prevent. So they get the same
     * treatment the actions get: identity, order, and the value rather than the
     * label, with the label kept beside it for a reader.
     */
    logic: (detail.logic ?? []).map((l) => ({
      sys_id: val(l.sys_id),
      order: val(l.order),
      /* The definition IS an identity — a sys_id naming If / Else / For Each —
       * and its display value is the word a person recognises. Both are kept,
       * and only the first is ever compared. */
      definition: val(l.logic_definition),
      definition_label: disp(l.logic_definition),
      ui_id: val(l.ui_id) || null,
      parent_ui_id: val(l.parent_ui_id) || null,
      comment: val(l.comment) || null,
    })),
    subflow_calls: (detail.subflowCalls ?? []).map((c) => ({
      sys_id: val(c.sys_id),
      order: val(c.order),
      subflow: val(c.subflow),
      subflow_name: disp(c.subflow),
      wait: val(c.wait_for_completion) === 'true' || val(c.wait_for_completion) === true,
      ui_id: val(c.ui_id) || null,
      parent_ui_id: val(c.parent_ui_id) || null,
      inputs: c.inputs ?? null,
    })),
    callers: detail.callers ?? [],
    source_tables: detail.sourceTables ?? null,
    gaps,
  };
}

/**
 * Find the flow a request names, without ever choosing between candidates (§6).
 *
 * Three ways in, in descending order of certainty: a sys_id, an exact name, or
 * a partial name. The first two identify; the third only narrows, so it returns
 * the candidates and refuses to pick — §6 is explicit that an ambiguous name
 * must stop and ask rather than lint whichever flow sorted first.
 */
export async function findFlow({ sys_id: sysId = null, name = null } = {}) {
  if (sysId) {
    try {
      const row = await table.get('sys_hub_flow', sysId, 'all');
      if (row) {
        return { ok: true, sys_id: val(row.sys_id), name: val(row.name), by: 'sys_id' };
      }
    } catch { /* not a flow sys_id; fall through to the name paths */ }
    return { ok: false, reason: 'not_found', note: `No flow has sys_id ${sysId}.`, candidates: [] };
  }

  if (!name) return { ok: false, reason: 'no_identifier', note: 'Name the flow to lint.', candidates: [] };

  const exact = await flows.findByName(name);
  if (exact.length === 1) {
    return { ok: true, sys_id: val(exact[0].sys_id), name: val(exact[0].name), by: 'exact_name' };
  }
  if (exact.length > 1) {
    return {
      ok: false, reason: 'ambiguous', candidates: exact.map((f) => ({ sys_id: val(f.sys_id), name: val(f.name) })),
      note: `${exact.length} flows are named exactly "${name}". Give the sys_id of the one you mean.`,
    };
  }

  const partial = await flows.list({ search: name });
  if (partial.length === 1) {
    return { ok: true, sys_id: val(partial[0].sys_id), name: val(partial[0].name), by: 'partial_name' };
  }
  if (!partial.length) {
    return { ok: false, reason: 'not_found', note: `No flow matches "${name}".`, candidates: [] };
  }
  return {
    ok: false,
    reason: 'ambiguous',
    candidates: partial.slice(0, 10).map((f) => ({ sys_id: val(f.sys_id), name: val(f.name) })),
    note: `${partial.length} flows match "${name}". Name one exactly, or give its sys_id.`,
  };
}
