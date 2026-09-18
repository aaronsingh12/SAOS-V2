/**
 * FLOW READ-BACK — what the instance actually stored, table by table.
 *
 * `flows.detail()` answers "what does this flow look like" for a UI. This
 * answers a different and harder question: does the LIVE Flow Designer record
 * represent the design that was requested — every trigger parameter, every
 * action input, every data pill, the order, the nesting, the subflow call's
 * input mapping and its wait flag.
 *
 * It exists because a build that compiles and an install that exits 0 prove
 * nothing about any of that. Every value below is read from the platform's own
 * tables, decoded from the platform's own blob format, and printed with the
 * table and column it came from, so a claim in a report can be traced to a row.
 *
 * READ-ONLY. It queries; it never writes.
 *
 *   node scripts/flow-readback.mjs "Flow Name" ["Another Flow"...]
 *   node scripts/flow-readback.mjs --json "Flow Name"
 */
import zlib from 'node:zlib';
import { table } from '../src/servicenow/client.js';
import { flows } from '../src/servicenow/flows.js';

const raw = (r, f) => {
  const v = r?.[f];
  return v && typeof v === 'object' ? v.value : v;
};
const disp = (r, f) => {
  const v = r?.[f];
  return v && typeof v === 'object' ? (v.display_value ?? v.value) : v;
};

/**
 * The platform stores every parameter map — trigger inputs, action values,
 * logic values, subflow call inputs — as gzipped JSON in base64. Same decoder
 * for all four, keeping BOTH halves: `value` is the identity that was stored
 * and `displayValue` is the label, and conflating them is how a check passes
 * against a label while the stored value is wrong.
 */
function pairs(list) {
  const out = {};
  for (const p of Array.isArray(list) ? list : []) {
    if (!p?.name) continue;
    out[p.name] = p.displayValue && p.displayValue !== p.value
      ? { value: p.value, display: p.displayValue }
      : p.value;
  }
  return out;
}

export function decodeBlob(encoded) {
  if (!encoded) return null;
  const text = (() => {
    /* Three encodings are in use on the same kind of column: gzipped JSON in
     * base64 (trigger inputs, action values), base64 JSON, and plain JSON.
     * Trying one and reporting "undecodable" would hide real content — it did,
     * on `outputs_assigned`. */
    try { return zlib.gunzipSync(Buffer.from(String(encoded), 'base64')).toString('utf8'); } catch { /* not gzip */ }
    try {
      const b = Buffer.from(String(encoded), 'base64').toString('utf8');
      if (b.trim().startsWith('{') || b.trim().startsWith('[')) return b;
    } catch { /* not base64 */ }
    const t = String(encoded).trim();
    return t.startsWith('{') || t.startsWith('[') ? t : null;
  })();
  if (text === null) return { _undecodable: 'not gzip, base64 or JSON', _bytes: String(encoded).length };
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) { return { _undecodable: err.message, _text: text.slice(0, 200) }; }

  if (Array.isArray(parsed)) return pairs(parsed);
  /* The step-parameter shape: inputs, the outputs it assigns, and flow
   * variables it sets, in one object. Flattened so a caller compares values,
   * not envelopes — `_assigns` and `_variables` keep their own namespace. */
  if (parsed && typeof parsed === 'object') {
    const out = pairs(parsed.inputs);
    const assigns = pairs(parsed.outputsToAssign);
    const vars = pairs(parsed.variables);
    if (Object.keys(assigns).length) out._assigns = assigns;
    if (Object.keys(vars).length) out._variables = vars;
    if (!Object.keys(out).length) return { _empty: true };
    return out;
  }
  return { _shape: typeof parsed, _raw: parsed };
}

/**
 * `order`, which is not always a number.
 *
 * MEASURED on dev424910, 2026-09-17: a step inside a PARALLEL BRANCH stores its
 * order as a composite string - `13➛14` - where 13 is the branch
 * container's order in the flow and 14 is the step's position inside that
 * branch. `Number()` on it is NaN, which is how a sort quietly loses those
 * steps and a read-back reports a flow whose parallel work has no position.
 *
 * Nothing documents this. It is reported as both halves so a caller can sort
 * by (outer, inner) and still show the platform's own string.
 */
export function parseOrder(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { order: null, sub: null, raw: null, composite: false };
  const parts = raw.split(/[➛➔→>]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    return { order: Number(parts[0]), sub: Number(parts[1]), raw, composite: true };
  }
  const n = Number(raw);
  return { order: Number.isFinite(n) ? n : null, sub: null, raw, composite: false };
}

/** Sort steps by outer order, then by position inside a parallel branch. */
export const byOrder = (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || (a.sub ?? -1) - (b.sub ?? -1);

const nameOf = async (t, sysId, field = 'name') => {
  if (!sysId) return null;
  try {
    const row = await table.get(t, sysId, 'false');
    return row ? (raw(row, field) ?? null) : null;
  } catch { return null; }
};

/** Everything the instance holds about one flow or subflow, by sys_id. */
export async function readBack(sysId) {
  const header = await table.get('sys_hub_flow_base', sysId, 'all');
  if (!header) throw new Error(`No flow or subflow with sys_id ${sysId}`);

  const q = (t, fields, orderBy) => table.query(t, {
    query: `flow=${sysId}`, fields, limit: 200, display: 'all', ...(orderBy ? { orderBy } : {}),
  }).catch(() => []);

  const [triggerRows, actionRows, logicRows, subflowRows, inputRows, outputRows, variableRows] = await Promise.all([
    q('sys_hub_trigger_instance_v2', 'sys_id,trigger_type,trigger_definition,name,comment,trigger_inputs,display_text'),
    q('sys_hub_action_instance_v2', 'sys_id,order,action_type,comment,values,ui_id,parent_ui_id,display_text', 'order'),
    q('sys_hub_flow_logic_instance_v2', 'sys_id,order,logic_definition,comment,values,ui_id,parent_ui_id,display_text,outputs_assigned,connected_to', 'order'),
    q('sys_hub_sub_flow_instance_v2', 'sys_id,order,comment,subflow,wait_for_completion,subflow_inputs,ui_id,parent_ui_id,display_text', 'order'),
    /* A flow's DECLARED contract lives in its own tables, not in the steps. */
    table.query('sys_hub_flow_input', { query: `model=${sysId}`, fields: 'sys_id,element,label,internal_type,reference,mandatory,order', limit: 100, display: 'false', orderBy: 'order' }).catch(() => []),
    table.query('sys_hub_flow_output', { query: `model=${sysId}`, fields: 'sys_id,element,label,internal_type,reference,mandatory,order', limit: 100, display: 'false', orderBy: 'order' }).catch(() => []),
    table.query('sys_hub_flow_variable', { query: `model=${sysId}`, fields: 'sys_id,element,label,internal_type', limit: 100, display: 'false' }).catch(() => []),
  ]);

  const triggers = await Promise.all(triggerRows.map(async (t) => ({
    sys_id: raw(t, 'sys_id'),
    trigger_type: raw(t, 'trigger_type'),
    /* The DEFINITION row is what the platform matched; its name is the real
     * answer to "which trigger is this", not the string in trigger_type. */
    definition: disp(t, 'trigger_definition') ?? await nameOf('sys_hub_trigger_definition', raw(t, 'trigger_definition')),
    display_text: raw(t, 'display_text'),
    inputs: decodeBlob(raw(t, 'trigger_inputs')),
  })));

  const actions = await Promise.all(actionRows.map(async (a) => ({
    ...parseOrder(raw(a, 'order')),
    sys_id: raw(a, 'sys_id'),
    action: disp(a, 'action_type') ?? await nameOf('sys_hub_action_type_base', raw(a, 'action_type')),
    ui_id: raw(a, 'ui_id'),
    parent_ui_id: raw(a, 'parent_ui_id') || null,
    display_text: raw(a, 'display_text'),
    comment: raw(a, 'comment'),
    values: decodeBlob(raw(a, 'values')),
  })));

  const logic = await Promise.all(logicRows.map(async (l) => ({
    ...parseOrder(raw(l, 'order')),
    sys_id: raw(l, 'sys_id'),
    logic: disp(l, 'logic_definition') ?? await nameOf('sys_hub_flow_logic_definition', raw(l, 'logic_definition')),
    ui_id: raw(l, 'ui_id'),
    parent_ui_id: raw(l, 'parent_ui_id') || null,
    display_text: raw(l, 'display_text'),
    values: decodeBlob(raw(l, 'values')),
    outputs_assigned: decodeBlob(raw(l, 'outputs_assigned')),
  })));

  const subflowCalls = subflowRows.map((c) => ({
    ...parseOrder(raw(c, 'order')),
    sys_id: raw(c, 'sys_id'),
    /* The RELATIONSHIP: a real reference to the callee's record. */
    subflow: { sys_id: raw(c, 'subflow'), name: disp(c, 'subflow') },
    wait_for_completion: raw(c, 'wait_for_completion') === 'true',
    ui_id: raw(c, 'ui_id'),
    parent_ui_id: raw(c, 'parent_ui_id') || null,
    display_text: raw(c, 'display_text'),
    inputs: decodeBlob(raw(c, 'subflow_inputs')),
  }));

  const contract = (rows) => rows.map((r) => ({
    name: r.element, label: r.label, type: r.internal_type, reference: r.reference || null,
    mandatory: r.mandatory === 'true', order: Number(r.order),
  }));

  const proof = await flows.publishedProof(sysId).catch((err) => ({ published: null, note: err.message }));

  return {
    header: {
      sys_id: sysId,
      name: raw(header, 'name'),
      internal_name: raw(header, 'internal_name'),
      type: raw(header, 'type'),
      description: raw(header, 'description'),
      active: raw(header, 'active') === 'true',
      status: raw(header, 'status'),
      run_as: raw(header, 'run_as'),
      flow_priority: raw(header, 'flow_priority'),
      run_with_roles: raw(header, 'run_with_roles'),
      scope: disp(header, 'sys_scope'),
      class: raw(header, 'sys_class_name'),
      latest_snapshot: raw(header, 'latest_snapshot') || null,
      master_snapshot: raw(header, 'master_snapshot') || null,
    },
    published: { published: proof.published, mismatch: proof.mismatch ?? null, note: proof.note ?? null },
    triggers,
    actions,
    logic,
    subflowCalls,
    inputs: contract(inputRows),
    outputs: contract(outputRows),
    variables: variableRows.map((v) => ({ name: v.element, type: v.internal_type })),
  };
}

/** Resolve by name inside our scope; refuses ambiguity rather than choosing. */
export async function readBackByName(name, scope = 'x_2002152_nwforge') {
  const rows = await table.query('sys_hub_flow', {
    query: `name=${name}^sys_scope.scope=${scope}`, fields: 'sys_id,name,type', limit: 5, display: 'false',
  });
  if (!rows.length) return { name, missing: true, note: `no flow or subflow named "${name}" in ${scope}` };
  if (rows.length > 1) return { name, ambiguous: rows.map((r) => r.sys_id) };
  return readBack(rows[0].sys_id);
}

const pad = (n, w) => String(n).padEnd(w);
const show = (v) => (v && typeof v === 'object' && 'value' in v ? `${v.value} [${v.display}]` : JSON.stringify(v));

function print(r) {
  if (r.missing) { console.log(`\n### ${r.name}\n  MISSING — ${r.note}`); return; }
  if (r.ambiguous) { console.log(`\n### ${r.name}\n  AMBIGUOUS — ${r.ambiguous.join(', ')}`); return; }
  const h = r.header;
  console.log(`\n### ${h.name}  [${h.type}]  ${h.sys_id}`);
  console.log(`  header      active=${h.active} status=${h.status} run_as=${h.run_as} scope=${h.scope}`);
  console.log(`  published   ${r.published.published}${r.published.mismatch ? ` (${r.published.mismatch})` : ''}`);
  if (h.description) console.log(`  description ${h.description}`);
  for (const t of r.triggers) {
    console.log(`  TRIGGER     ${t.definition ?? t.trigger_type}`);
    for (const [k, v] of Object.entries(t.inputs ?? {})) console.log(`      ${pad(k, 20)} ${show(v)}`);
  }
  for (const i of r.inputs) console.log(`  INPUT       ${pad(i.name, 20)} ${i.type}${i.reference ? `->${i.reference}` : ''}${i.mandatory ? ' MANDATORY' : ''}`);
  for (const o of r.outputs) console.log(`  OUTPUT      ${pad(o.name, 20)} ${o.type}${o.reference ? `->${o.reference}` : ''}`);
  const steps = [
    ...r.actions.map((a) => ({ ...a, kind: 'ACTION', label: a.action })),
    ...r.logic.map((l) => ({ ...l, kind: 'LOGIC', label: l.logic })),
    ...r.subflowCalls.map((s) => ({ ...s, kind: 'SUBFLOW', label: `${s.subflow.name} wait=${s.wait_for_completion}` })),
  ].sort(byOrder);
  for (const s of steps) {
    console.log(`  ${pad(s.raw ?? '-', 6)} ${pad(s.kind, 8)} ${pad(s.label ?? '?', 34)} ui=${s.ui_id ?? '-'} parent=${s.parent_ui_id ?? '-'}`);
    for (const [k, v] of Object.entries(s.values ?? s.inputs ?? {})) console.log(`         ${pad(k, 22)} ${show(v)}`);
    if (s.outputs_assigned) for (const [k, v] of Object.entries(s.outputs_assigned)) console.log(`         assign ${pad(k, 15)} ${show(v)}`);
  }
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const names = args.filter((a) => a !== '--json');
if (names.length) {
  const out = [];
  for (const n of names) {
    // eslint-disable-next-line no-await-in-loop
    const r = await readBackByName(n).catch((e) => ({ name: n, missing: true, note: e.message }));
    out.push(r);
    if (!asJson) print(r);
  }
  if (asJson) console.log(JSON.stringify(out, null, 1));
}
