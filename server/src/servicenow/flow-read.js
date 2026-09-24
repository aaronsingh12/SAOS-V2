import zlib from 'node:zlib';

/**
 * JOB 1.1 — reading flows for the agent: a paged list and a readable detail.
 *
 * READ-ONLY. Every function here takes a `client` shaped like `table` in
 * ./client.js ({ query, get, count }) and only ever calls those three.
 *
 * WHY THE OLD TOOLS FAILED (read off the code; see the job report for what
 * was and was not confirmed live):
 *   - Both returned `display='all'` rows, where every cell is a
 *     {value, display_value} envelope. The orchestrator cuts every tool result
 *     at 8,000 characters, so list_flows showed the agent the first handful of
 *     100 flows (alphabetically) and get_flow was cut mid-JSON.
 *   - get_flow read the action rows without `values`, `ui_id` or
 *     `parent_ui_id`, so it could show neither an action's configuration nor
 *     which If / For Each it sits inside.
 *   - Each part table was capped at 100 rows with no signal that it was cut.
 *   - get_flow took only a sys_id; list_flows could not filter by type or scope.
 *
 * TABLES (the *_v2 family; field names as used by scripts/flow-readback.mjs):
 *   sys_hub_flow                    header — `type` is 'flow' | 'subflow'
 *   sys_hub_trigger_instance_v2     trigger; config gzipped in `trigger_inputs`
 *   sys_hub_action_instance_v2      action steps; config in `values`
 *   sys_hub_flow_logic_instance_v2  If / Else / For Each ...; config in `values`
 *   sys_hub_sub_flow_instance_v2    subflow calls; config in `subflow_inputs`
 *   sys_hub_flow_input / _output / _variable   contract + variables, keyed by `model`
 * Steps nest through `parent_ui_id` → the container's `ui_id`.
 */

export const LIST_DEFAULT_LIMIT = 20;
export const LIST_MAX_LIMIT = 50;
/** Leaves headroom under the orchestrator's 8,000-character result cap. */
export const RESULT_BUDGET = 7000;
const PART_PAGE = 200;
const PART_MAX = 1000;

const SYS_ID_RE = /^[0-9a-f]{32}$/i;

/* display='all' wraps every field as {value, display_value}; plain reads do not. */
export const val = (r, f) => {
  const v = r?.[f];
  return v && typeof v === 'object' ? v.value : v;
};
export const disp = (r, f) => {
  const v = r?.[f];
  if (v && typeof v === 'object') return v.display_value || v.value;
  return v;
};
const str = (v) => (v == null ? '' : String(v));
const bool = (v) => str(v) === 'true';

/** A caret ends an encoded-query clause; a user-typed name must not open a new one. */
const clean = (s) => str(s).replace(/\^/g, '').trim();

/* ------------------------------------------------------------------ *
 * Decoding the step-configuration blobs
 * ------------------------------------------------------------------ */

/**
 * Three encodings are in use on the same kind of column: gzipped JSON in
 * base64, base64 JSON, and plain JSON (measured in flow-readback.mjs).
 * Returns the parsed JSON, or null when the blob is empty or unreadable.
 */
export function parseBlob(encoded) {
  if (!encoded) return null;
  const s = String(encoded);
  const attempts = [
    () => zlib.gunzipSync(Buffer.from(s, 'base64')).toString('utf8'),
    () => Buffer.from(s, 'base64').toString('utf8'),
    () => s,
  ];
  for (const attempt of attempts) {
    try {
      const text = attempt().trim();
      if (text.startsWith('{') || text.startsWith('[')) return JSON.parse(text);
    } catch { /* try the next encoding */ }
  }
  return null;
}

/**
 * Name → readable value. The label is preferred. MEASURED on dev366630:
 *   - a scripted parameter has `scriptActive: true`, an empty value, and its
 *     code under `script.<name>.script`
 *   - a reference is often stored as a bare sys_id with no displayValue, but
 *     `parameter.reference` names its table — collected in `refs` so the
 *     caller can look the label up
 *   - `__snc_*` parameters are platform plumbing, not configuration
 */
function readablePairs(list, section, refs) {
  const out = {};
  for (const p of Array.isArray(list) ? list : []) {
    if (!p?.name || p.name.startsWith('__')) continue;
    const code = p.scriptActive ? p.script?.[p.name]?.script ?? (typeof p.script === 'string' ? p.script : null) : null;
    if (code) { out[p.name] = `[script] ${String(code).trim()}`; continue; }
    const value = p.displayValue || p.value;
    if (value === '' || value == null) continue;
    out[p.name] = typeof value === 'string' ? value : JSON.stringify(value);
    const table = p.parameter?.reference;
    if (refs && table && SYS_ID_RE.test(String(p.value)) && (!p.displayValue || p.displayValue === p.value)) {
      refs.push({ section, key: p.name, table, sys_id: String(p.value) });
    }
  }
  return out;
}

/**
 * The configured values of one step, in readable form.
 * An array is a flat parameter list; an object is the step shape
 * { inputs, outputsToAssign, variables }.
 */
export function decodeValues(encoded) {
  const parsed = parseBlob(encoded);
  if (parsed == null) return { inputs: {}, undecodable: Boolean(encoded) };
  const refs = [];
  const done = (out) => (refs.length ? { ...out, _refs: refs } : out);
  if (Array.isArray(parsed)) return done({ inputs: readablePairs(parsed, 'inputs', refs) });
  const out = { inputs: readablePairs(parsed.inputs, 'inputs', refs) };
  const assigns = readablePairs(parsed.outputsToAssign, 'assigns', refs);
  const variables = readablePairs(parsed.variables, 'sets_variables', refs);
  if (Object.keys(assigns).length) out.assigns = assigns;
  if (Object.keys(variables).length) out.sets_variables = variables;
  return done(out);
}

/**
 * Data pills name their source by the producing step's `ui_id` (a hyphenated
 * sys_id) and the trigger as `<Trigger name>_1` — measured on dev366630, e.g.
 * `{{802cfab8-0081-4e70-89b2-dac52ddc2f75.Record}}`, `{{Created_1.current}}`.
 * Rewritten to the step number the reader sees.
 */
const UUID_PILL = /\{\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./gi;
const TRIGGER_PILL = /\{\{[A-Z][A-Za-z ]*_\d+\./g;
export function humanizePills(text, stepByUi) {
  return String(text)
    .replace(UUID_PILL, (m, ui) => (stepByUi.has(ui) ? `{{step ${stepByUi.get(ui)}.` : m))
    .replace(TRIGGER_PILL, '{{Trigger.');
}

/**
 * `order` is not always a number: a step inside a parallel branch stores
 * `13➛14` (measured on dev424910). Sorted by (outer, inner).
 */
export function parseOrder(value) {
  const raw = str(value).trim();
  if (!raw) return { order: null, sub: null, raw: null };
  const parts = raw.split(/[➛➔→>]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) return { order: Number(parts[0]), sub: Number(parts[1]), raw };
  const n = Number(raw);
  return { order: Number.isFinite(n) ? n : null, sub: null, raw };
}
const byOrder = (a, b) => (a._o.order ?? 1e9) - (b._o.order ?? 1e9) || (a._o.sub ?? -1) - (b._o.sub ?? -1);

/* ------------------------------------------------------------------ *
 * Step tree
 * ------------------------------------------------------------------ */

/**
 * Actions, flow logic and subflow calls are three tables. Merged, sorted by
 * `order`, and nested by `parent_ui_id`. A parent that is not among the rows
 * (or no ui_id at all) leaves the step at the top level rather than losing it.
 */
export function buildStepTree({ actions = [], logic = [], subflowCalls = [] }) {
  const nodes = [
    ...actions.map((r) => ({
      kind: 'action',
      name: disp(r, 'action_type') || '(unknown action)',
      ...decodeValues(val(r, 'values')),
      row: r,
    })),
    ...logic.map((r) => ({
      kind: 'flow_logic',
      name: disp(r, 'logic_definition') || '(unknown flow logic)',
      ...decodeValues(val(r, 'values')),
      row: r,
    })),
    ...subflowCalls.map((r) => ({
      kind: 'subflow',
      name: disp(r, 'subflow') || '(unknown subflow)',
      subflow_ref: val(r, 'subflow') || null,
      wait_for_completion: bool(val(r, 'wait_for_completion')),
      ...decodeValues(val(r, 'subflow_inputs')),
      row: r,
    })),
  ].map(({ row, ...n }) => {
    const node = {
      ...n,
      order: str(val(row, 'order')) || null,
      sys_id: val(row, 'sys_id'),
      _o: parseOrder(val(row, 'order')),
      _ui: str(val(row, 'ui_id')) || null,
      _parent: str(val(row, 'parent_ui_id')) || null,
      children: [],
    };
    const comment = str(val(row, 'comment')).trim();
    if (comment) node.comment = comment;
    const text = str(val(row, 'display_text')).trim();
    if (text) node.display_text = text;
    return node;
  });

  const byUi = new Map(nodes.filter((n) => n._ui).map((n) => [n._ui, n]));
  const roots = [];
  for (const n of nodes) {
    const parent = n._parent && n._parent !== n._ui ? byUi.get(n._parent) : null;
    (parent ? parent.children : roots).push(n);
  }

  const stepByUi = new Map();
  const finish = (list, prefix, depth) => list.sort(byOrder).map((n, i) => {
    const step = prefix ? `${prefix}.${i + 1}` : String(i + 1);
    const { _o, _ui, _parent, children, ...rest } = n;
    if (_ui) stepByUi.set(_ui, `${step} (${n.name})`);
    const out = { step, depth, ...rest };
    if (!Object.keys(out.inputs ?? {}).length) delete out.inputs;
    if (children.length) out.children = finish(children, step, depth + 1);
    return out;
  });
  const tree = finish(roots, '', 0);
  for (const s of flattenSteps(tree)) {
    for (const key of ['inputs', 'assigns', 'sets_variables']) {
      if (!s[key]) continue;
      for (const [k, v] of Object.entries(s[key])) s[key][k] = humanizePills(v, stepByUi);
    }
  }
  return tree;
}

/** Depth-first, in run order. */
export function flattenSteps(tree) {
  const out = [];
  const walk = (list) => { for (const n of list) { out.push(n); if (n.children) walk(n.children); } };
  walk(tree);
  return out;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

const isMissingTable = (err) => err?.status === 400 && /invalid table/i.test(err.message || '');
const isForbidden = (err) => err?.status === 401 || err?.status === 403;

/** Every row of a part table for one flow, paged, capped at PART_MAX. */
async function readPart(client, t, query, fields, orderBy) {
  const rows = [];
  try {
    for (let offset = 0; offset < PART_MAX; offset += PART_PAGE) {
      // eslint-disable-next-line no-await-in-loop
      const page = await client.query(t, { query, fields, limit: PART_PAGE, offset, display: 'all', ...(orderBy ? { orderBy } : {}) });
      rows.push(...page);
      if (page.length < PART_PAGE) return { rows, status: 'ok' };
    }
    return { rows, status: 'truncated' };
  } catch (err) {
    if (isMissingTable(err)) return { rows: [], status: 'missing' };
    if (isForbidden(err)) return { rows: [], status: 'forbidden', message: err.message };
    throw err;
  }
}

function compactHeader(r) {
  return {
    sys_id: val(r, 'sys_id'),
    name: val(r, 'name'),
    internal_name: val(r, 'internal_name') || null,
    type: val(r, 'type') || null,
    scope: val(r, 'sys_scope.scope') || null,
    scope_name: disp(r, 'sys_scope') || null,
    active: bool(val(r, 'active')),
    status: val(r, 'status') || null,
    updated: val(r, 'sys_updated_on') || null,
    updated_by: val(r, 'sys_updated_by') || null,
  };
}

const HEADER_FIELDS = 'sys_id,name,internal_name,type,sys_scope,sys_scope.scope,active,status,sys_updated_on,sys_updated_by';

function friendlyFailure(err, what) {
  if (isForbidden(err)) {
    return { ok: false, reason: 'permission', message: `The connected user is not allowed to read ${what}. ${err.message}` };
  }
  throw err;
}

/**
 * flows.list — flows and subflows, paged.
 * Filters: type ('flow' | 'subflow' | 'all'), scope (namespace like
 * x_2196302_nwforge, 'global', or a sys_scope sys_id), active (true/false),
 * name_contains.
 */
export async function listFlows(client, { type = 'all', scope = null, active = null, name_contains = null, limit = LIST_DEFAULT_LIMIT, offset = 0 } = {}, { budget = RESULT_BUDGET } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const start = Math.max(Number(offset) || 0, 0);

  const clauses = [];
  if (type === 'flow' || type === 'subflow') clauses.push(`type=${type}`);
  const sc = clean(scope);
  if (sc) clauses.push(SYS_ID_RE.test(sc) ? `sys_scope=${sc}` : sc === 'global' ? 'sys_scope=global' : `sys_scope.scope=${sc}`);
  if (active === true || active === 'true') clauses.push('active=true');
  if (active === false || active === 'false') clauses.push('active=false');
  const nc = clean(name_contains);
  if (nc) clauses.push(`nameLIKE${nc}`);
  const query = clauses.join('^');

  let rows;
  try {
    rows = await client.query('sys_hub_flow', { query, fields: HEADER_FIELDS, orderBy: 'name', limit: pageSize + 1, offset: start, display: 'all' });
  } catch (err) { return friendlyFailure(err, 'flows (sys_hub_flow)'); }

  const total = client.count ? await client.count('sys_hub_flow', query).catch(() => null) : null;
  const all = rows.map(compactHeader);
  /* MEASURED on dev366630: ~350 characters per row, so 50 rows came to
   * 17,999 — past the 8,000-character result cap. Trim the page to what fits
   * and move next_offset back, rather than let the orchestrator cut it. */
  const page = (n) => {
    const hasMore = all.length > n;
    return {
      ok: true,
      filters: { type, scope: sc || null, active: active ?? null, name_contains: nc || null },
      total,
      offset: start,
      count: Math.min(n, all.length),
      has_more: hasMore,
      next_offset: hasMore ? start + n : null,
      items: all.slice(0, n),
    };
  };
  let n = Math.min(pageSize, all.length);
  while (n > 1 && size(page(n)) > budget) n -= 1;
  return page(n);
}

/**
 * Find one flow by sys_id or name. Name tries exact name, then internal_name,
 * then "contains"; more than one hit is returned as choices, never guessed.
 */
export async function resolveFlow(client, { sys_id: sysId = null, name = null } = {}) {
  const id = clean(sysId) || (SYS_ID_RE.test(clean(name)) ? clean(name) : '');
  if (id) {
    try {
      const rows = await client.query('sys_hub_flow', { query: `sys_id=${id}`, fields: HEADER_FIELDS, limit: 1, display: 'all' });
      if (rows[0]) return { ok: true, header: rows[0] };
    } catch (err) { return friendlyFailure(err, 'flows (sys_hub_flow)'); }
    return { ok: false, reason: 'not_found', message: `No flow or subflow has sys_id ${id}. Use list_flows to find the right one.` };
  }

  const n = clean(name);
  if (!n) return { ok: false, reason: 'no_identifier', message: 'Give the flow\'s name or sys_id.' };

  const find = (query, limit) => client.query('sys_hub_flow', { query, fields: HEADER_FIELDS, orderBy: 'name', limit, display: 'all' });
  try {
    for (const q of [`name=${n}`, `internal_name=${n}`, `nameLIKE${n}`]) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await find(q, 11);
      if (rows.length === 1) return { ok: true, header: rows[0] };
      if (rows.length > 1) {
        return {
          ok: false,
          reason: 'ambiguous',
          message: `${rows.length > 10 ? 'More than 10' : rows.length} flows match "${n}". Say which one you mean (by name or sys_id).`,
          choices: rows.slice(0, 10).map(compactHeader).map(({ sys_id, name: nm, type, scope, active }) => ({ sys_id, name: nm, type, scope, active })),
        };
      }
    }
  } catch (err) { return friendlyFailure(err, 'flows (sys_hub_flow)'); }
  return { ok: false, reason: 'not_found', message: `There is no flow or subflow called "${n}" on this instance. Use list_flows to see what exists.` };
}

function readableTrigger(r) {
  const parsed = parseBlob(val(r, 'trigger_inputs'));
  const config = Array.isArray(parsed) ? readablePairs(parsed) : readablePairs(parsed?.inputs);
  const t = {
    type: disp(r, 'trigger_type') || null,
    definition: disp(r, 'trigger_definition') || null,
  };
  if (config.table) t.table = config.table;
  if (config.condition) t.condition = config.condition;
  const rest = Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'table' && k !== 'condition'));
  if (Object.keys(rest).length) t.config = rest;
  const text = str(val(r, 'display_text')).trim();
  if (text) t.display_text = text;
  return t;
}

const LABEL_FIELDS = ['name', 'number', 'title', 'label', 'user_name', 'short_description'];

/**
 * Bare sys_ids in step values → "<label> [<sys_id>]", one query per referenced
 * table. Best effort: a table that cannot be read leaves the sys_id as it is.
 */
async function resolveReferences(client, steps) {
  const wanted = new Map();
  for (const s of steps) for (const r of s._refs ?? []) {
    if (!wanted.has(r.table)) wanted.set(r.table, new Set());
    wanted.get(r.table).add(r.sys_id);
  }
  const labels = new Map();
  const readTables = new Set();
  await Promise.all([...wanted].slice(0, 15).map(async ([t, ids]) => {
    try {
      const rows = await client.query(t, { query: `sys_idIN${[...ids].slice(0, 100).join(',')}`, fields: `sys_id,${LABEL_FIELDS.join(',')}`, limit: 100, display: 'false' });
      if (ids.size <= 100) readTables.add(t);
      for (const row of rows) {
        const label = LABEL_FIELDS.map((f) => row[f]).find((v) => v && String(v).trim());
        labels.set(`${t}:${row.sys_id}`, label ? String(label) : null);
      }
    } catch { /* unreadable table: keep the sys_id */ }
  }));
  /* MEASURED on dev366630: "Incident Closed Notification" points at a
   * notification that does not exist. A dangling reference is worth saying. */
  const dangling = [];
  for (const s of steps) {
    for (const r of s._refs ?? []) {
      if (s[r.section]?.[r.key] !== r.sys_id) continue;
      const k = `${r.table}:${r.sys_id}`;
      if (labels.get(k)) s[r.section][r.key] = `${labels.get(k)} [${r.sys_id}]`;
      else if (!labels.has(k) && readTables.has(r.table)) {
        s[r.section][r.key] = `${r.sys_id} [NOT FOUND in ${r.table}]`;
        dangling.push(`step ${s.step} ${r.key}`);
      }
    }
    delete s._refs;
  }
  return dangling;
}

/**
 * A subflow call's `subflow` column points at a published SNAPSHOT, not at the
 * subflow (measured on dev366630: sys_class_name = sys_hub_flow_snapshot).
 * `parent_flow` on the snapshot is the subflow the user knows. Quoting the
 * snapshot's id as "the subflow's sys_id" sent the agent to the wrong record.
 */
async function resolveSubflowTargets(client, steps) {
  const calls = steps.filter((s) => s.kind === 'subflow' && s.subflow_ref);
  if (!calls.length) return;
  let parents = new Map();
  try {
    const rows = await client.query('sys_hub_flow_snapshot', {
      query: `sys_idIN${[...new Set(calls.map((s) => s.subflow_ref))].join(',')}`, fields: 'sys_id,parent_flow', limit: 100, display: 'false',
    });
    parents = new Map(rows.map((r) => [val(r, 'sys_id'), val(r, 'parent_flow')]));
  } catch { /* unreadable: fall back to the stored id */ }
  for (const s of calls) {
    const parent = parents.get(s.subflow_ref);
    s.subflow_sys_id = parent || s.subflow_ref;
    if (parent) s.subflow_snapshot = s.subflow_ref;
    delete s.subflow_ref;
  }
}

const contractRow = (r) => ({
  name: val(r, 'element'),
  label: val(r, 'label') || null,
  type: val(r, 'internal_type') || null,
  ...(val(r, 'reference') ? { reference: val(r, 'reference') } : {}),
  mandatory: bool(val(r, 'mandatory')),
});

/**
 * flows.detail — one flow or subflow, readable, in run order.
 * Returns { ok, summary, flow, trigger, inputs, outputs, variables, steps, ... }
 * or { ok: false, reason, message, choices? }.
 */
export async function describeFlow(client, ref = {}, { budget = RESULT_BUDGET, stepsFrom = 1 } = {}) {
  const found = await resolveFlow(client, ref);
  if (!found.ok) return found;
  const flow = compactHeader(found.header);
  const id = flow.sys_id;
  const byFlow = `flow=${id}`;
  const byModel = `model=${id}`;

  let parts;
  try {
    parts = await Promise.all([
      readPart(client, 'sys_hub_trigger_instance_v2', byFlow, 'sys_id,trigger_type,trigger_definition,trigger_inputs,display_text'),
      readPart(client, 'sys_hub_action_instance_v2', byFlow, 'sys_id,order,action_type,comment,values,ui_id,parent_ui_id,display_text', 'order'),
      readPart(client, 'sys_hub_flow_logic_instance_v2', byFlow, 'sys_id,order,logic_definition,comment,values,ui_id,parent_ui_id,display_text', 'order'),
      readPart(client, 'sys_hub_sub_flow_instance_v2', byFlow, 'sys_id,order,comment,subflow,wait_for_completion,subflow_inputs,ui_id,parent_ui_id,display_text', 'order'),
      readPart(client, 'sys_hub_flow_input', byModel, 'sys_id,element,label,internal_type,reference,mandatory,order', 'order'),
      readPart(client, 'sys_hub_flow_output', byModel, 'sys_id,element,label,internal_type,reference,mandatory,order', 'order'),
      readPart(client, 'sys_hub_flow_variable', byModel, 'sys_id,element,label,internal_type,reference,mandatory,order', 'order'),
    ]);
  } catch (err) { return friendlyFailure(err, `the parts of "${flow.name}"`); }

  const [triggers, actions, logic, subflowCalls, inputs, outputs, variables] = parts;
  const names = ['triggers', 'actions', 'flow logic', 'subflow calls', 'inputs', 'outputs', 'variables'];
  const tables = ['sys_hub_trigger_instance_v2', 'sys_hub_action_instance_v2', 'sys_hub_flow_logic_instance_v2', 'sys_hub_sub_flow_instance_v2', 'sys_hub_flow_input', 'sys_hub_flow_output', 'sys_hub_flow_variable'];
  const notes = [];
  parts.forEach((p, i) => {
    if (p.status === 'missing') notes.push(`${tables[i]} does not exist on this instance; ${names[i]} could not be read.`);
    if (p.status === 'forbidden') notes.push(`Not allowed to read ${tables[i]}; ${names[i]} are missing from this answer.`);
    if (p.status === 'truncated') notes.push(`${names[i]}: only the first ${PART_MAX} rows were read.`);
  });

  const tree = buildStepTree({ actions: actions.rows, logic: logic.rows, subflowCalls: subflowCalls.rows });
  const flat = flattenSteps(tree);
  const dangling = await resolveReferences(client, flat);
  await resolveSubflowTargets(client, flat);
  const trigger = triggers.rows.map(readableTrigger);
  if (flow.type === 'subflow' && !trigger.length) notes.push('Subflows have no trigger; other flows call them.');
  if (flow.type !== 'subflow' && triggers.status === 'ok' && !trigger.length) notes.push('This flow has no trigger.');
  if (flat.some((s) => s.undecodable)) notes.push('Some step configuration could not be decoded; those steps show no inputs.');
  if (dangling.length) notes.push(`Broken reference(s) — the record no longer exists: ${dangling.join(', ')}.`);

  /* MEASURED on dev366630: a record-triggered FLOW has sys_hub_flow_input rows
   * too (current, table_name, changed_fields). They are the record the trigger
   * hands the flow, not inputs anyone declared — only subflows declare inputs. */
  const isSubflow = flow.type === 'subflow';
  const result = {
    ok: true,
    summary: '',
    flow,
    trigger: trigger.length === 1 ? trigger[0] : trigger,
    ...(isSubflow ? {} : { trigger_data: inputs.rows.map(contractRow) }),
    inputs: isSubflow ? inputs.rows.map(contractRow) : [],
    outputs: outputs.rows.map(contractRow),
    variables: variables.rows.map(contractRow),
    step_count: flat.length,
    steps: tree,
    notes,
  };
  return fitToBudget(result, { budget, stepsFrom });
}

/* ------------------------------------------------------------------ *
 * Summary + size budget
 * ------------------------------------------------------------------ */

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function summarize(r, { maxStepLines = 60 } = {}) {
  const f = r.flow;
  const lines = [
    `${f.name} — ${f.type ?? 'flow'}, ${f.active ? 'active' : 'inactive'}${f.status ? `, ${f.status}` : ''}, scope ${f.scope ?? f.scope_name ?? 'unknown'}.`,
  ];
  const trig = Array.isArray(r.trigger) ? r.trigger : [r.trigger];
  for (const t of trig.filter(Boolean)) {
    lines.push(`Trigger: ${t.definition ?? t.type ?? 'unknown'}${t.table ? ` on ${t.table}` : ''}${t.condition ? ` when ${clip(t.condition, 160)}` : ''}.`);
  }
  const io = (label, list = []) => list.length && lines.push(`${label}: ${list.map((x) => (typeof x === 'string' ? x : `${x.name} (${x.type}${x.mandatory ? ', mandatory' : ''})`)).join(', ')}.`);
  io('Inputs', r.inputs);
  io('Outputs', r.outputs);
  io('Variables', r.variables);
  lines.push(`${r.step_count} step(s):`);
  const flat = flattenSteps(r._fullSteps ?? r.steps);
  for (const s of flat.slice(0, maxStepLines)) {
    const tag = s.kind === 'subflow' ? 'Call subflow: ' : '';
    lines.push(`${'  '.repeat(s.depth)}${s.step}. ${tag}${s.name}${s.display_text ? ` — ${clip(s.display_text, 80)}` : ''}`);
  }
  if (flat.length > maxStepLines) lines.push(`  … ${flat.length - maxStepLines} more step(s)`);
  return lines.join('\n');
}

const size = (o) => JSON.stringify(o, null, 1).length;

function mapSteps(tree, fn) {
  return tree.map((s) => {
    const n = fn({ ...s });
    if (s.children) n.children = mapSteps(s.children, fn);
    return n;
  });
}

const clipValues = (n) => (s) => {
  for (const key of ['inputs', 'assigns', 'sets_variables']) {
    if (s[key]) s[key] = Object.fromEntries(Object.entries(s[key]).map(([k, v]) => [k, clip(String(v), n)]));
  }
  return s;
};

/** Keep only steps whose flat position is within [from, to]; containers of kept steps stay. */
function sliceSteps(tree, from, to) {
  let i = 0;
  const walk = (list) => list.flatMap((s) => {
    i += 1;
    const pos = i;
    const kids = s.children ? walk(s.children) : [];
    const keep = pos >= from && pos <= to;
    if (!keep && !kids.length) return [];
    const n = keep ? { ...s } : { step: s.step, depth: s.depth, kind: s.kind, name: s.name, omitted: true };
    if (kids.length) n.children = kids; else delete n.children;
    return [n];
  });
  return walk(tree);
}

const compactContract = (list) => list.map((x) => `${x.name}: ${x.type}${x.reference ? `→${x.reference}` : ''}${x.mandatory ? ' (mandatory)' : ''}`);

/**
 * The orchestrator truncates tool output at 8,000 characters — mid-JSON.
 * One rule instead: if the whole flow fits, return it. Otherwise `summary`
 * carries the whole outline, and `steps` carries as many COMPLETE steps
 * (inputs included) as fit, starting at `stepsFrom`; `next_steps_from` says
 * where the next call continues.
 */
export function fitToBudget(result, { budget = RESULT_BUDGET, stepsFrom = 1 } = {}) {
  const full = mapSteps(result.steps, clipValues(300));
  const total = result.step_count;
  const from = Math.min(Math.max(Number(stepsFrom) || 1, 1), Math.max(total, 1));

  const whole = { ...result, steps: full, summary: summarize({ ...result, _fullSteps: full }) };
  if (from === 1 && size(whole) <= budget) return whole;

  /* Paged. The contract lists shrink to one line each; the outline shrinks
   * until it leaves room for at least one complete step. */
  const base = { ...result };
  for (const k of ['trigger_data', 'inputs', 'outputs', 'variables']) if (base[k]) base[k] = compactContract(base[k]);
  const short = mapSteps(result.steps, clipValues(150));
  const page = (to, lines) => {
    const p = { ...base, steps: sliceSteps(short, from, to), notes: [...result.notes] };
    p.summary = summarize({ ...p, _fullSteps: full }, { maxStepLines: lines });
    p.notes.push(`Steps ${from}–${to} of ${total} have full detail here (long values shortened); the summary outlines all of them.`
      + (to < total ? ` Call get_flow again with steps_from=${to + 1} for the next steps.` : ''));
    p.next_steps_from = to < total ? to + 1 : null;
    return p;
  };

  for (const lines of [60, 30, 15, 5]) {
    if (size(page(from, lines)) > budget) continue;
    /* Largest `to` that fits: sizes grow with `to`, so binary search. */
    let lo = from;
    let hi = total;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(page(mid, lines)) <= budget) lo = mid; else hi = mid - 1;
    }
    return page(lo, lines);
  }
  /* One step is bigger than the budget on its own: show it with short values. */
  const one = page(from, 5);
  one.steps = mapSteps(one.steps, clipValues(80));
  return one;
}
